import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { AiEditError } from "../library.mjs";
import { renameRetrying } from "../rename.mjs";
import { openTab } from "./browser.mjs";
import { encodeMp4, writePngMov } from "./encoder.mjs";

// 网页片段（openfilm 的「页面」）：一个 HTML 文件，window.film.frame(t) 画出任意时刻。存在 ai-edit/pages/<page_id>/，
// 渲成视频放进素材库（不透明的 H.264 MP4，带透明的 PNG MOV），所以时间线、剪映草稿、裁剪切分都把它当普通视频；
// 看板上用 iframe 实时画（素材的 source.page 指回 HTML）。

export const MAX_PAGE_BYTES = 400 * 1024;
// ponytail: 按渲染耗时定的上限（1080p 约 0.2 秒一帧，5 分钟 30 帧要渲半小时左右），再长就拆成几段
export const MAX_PAGE_SECONDS = 300;
const PAGE_ID = /^[0-9a-f]{16}$/u;

/**
 * 要渲多少帧、渲出来的素材到底多长。帧数取整后才是素材的真实长度（30 帧时 4.99 秒是 150 帧 = 5 秒、3.34 秒是 100 帧 ≈ 3.333 秒），
 * 按要的时长放上时间线可能比素材长一点，所以 seconds 往下取到毫秒；超过上限的只渲前 MAX_PAGE_SECONDS 秒，cut 为 true。
 */
export function pageFrames(wanted, fps) {
  const count = Math.max(1, Math.round(Math.min(MAX_PAGE_SECONDS, wanted) * fps));
  return { count, seconds: Math.floor((count / fps) * 1000) / 1000, cut: wanted > MAX_PAGE_SECONDS };
}
// 画面每次画得不一样的门槛：缩成小图后平均每个通道差多少（0–1）
const UNSTEADY = 0.02;

// 抽出来的帧里有没有透明的地方（导入的网页不知道是不是叠加用的，看了再定编成什么）
const HAS_ALPHA = `(async (data) => {
  const bitmap = await createImageBitmap(await (await fetch('data:image/png;base64,' + data)).blob(), { resizeWidth: 96, resizeHeight: 96 });
  const c = new OffscreenCanvas(96, 96); const g = c.getContext('2d'); g.drawImage(bitmap, 0, 0);
  const d = g.getImageData(0, 0, 96, 96).data; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true; return false;
})`;

export const isPageId = (value) => typeof value === "string" && PAGE_ID.test(value);

function validateHtml(html) {
  if (typeof html !== "string" || !html.trim()) throw new AiEditError("page_empty", "网页内容是空的。", 422);
  if (Buffer.byteLength(html) > MAX_PAGE_BYTES) throw new AiEditError("page_too_large", "网页太大了（超过 400KB），图片别内嵌，精简一下。", 422);
  if (!/window\.film\b|\bfilm\s*=/u.test(html)) throw new AiEditError("page_not_film", "网页里要定义 window.film = { duration, frame(t) { … } }。", 422);
}

/** 在内存中精确修改正式页；每个原文片段必须唯一，避免校准一处时误改其他图层。 */
export function patchPageHtml(original, patches) {
  if (typeof original !== 'string' || !Array.isArray(patches) || patches.length < 1 || patches.length > 24) {
    throw new AiEditError('arguments_invalid', '局部预览需要已有 page_id 和 1–24 处 patches。', 422);
  }
  let html = original;
  for (const [index, patch] of patches.entries()) {
    if (!patch || typeof patch.find !== 'string' || !patch.find.length || typeof patch.replace !== 'string') {
      throw new AiEditError('arguments_invalid', `第 ${index + 1} 处修改需要非空 find 和字符串 replace。`, 422);
    }
    const at = html.indexOf(patch.find);
    if (at < 0 || html.indexOf(patch.find, at + 1) >= 0) {
      throw new AiEditError('page_patch_mismatch', `第 ${index + 1} 处原文未找到或不唯一，请重新 read_page 并提供完整的唯一片段。`, 409);
    }
    html = html.slice(0, at) + patch.replace + html.slice(at + patch.find.length);
    validateHtml(html);
  }
  return html;
}

const DIFF = `(async (a, b, alpha) => {
  const load = async (data) => createImageBitmap(await (await fetch('data:image/' + (alpha ? 'png' : 'jpeg') + ';base64,' + data)).blob(), { resizeWidth: 96, resizeHeight: 96 });
  const pixels = async (data) => { const c = new OffscreenCanvas(96, 96); const g = c.getContext('2d'); g.drawImage(await load(data), 0, 0); return g.getImageData(0, 0, 96, 96).data; };
  const [x, y] = await Promise.all([pixels(a), pixels(b)]);
  let sum = 0; for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length / 255;
})`;

/**
 * root：ai-edit 根目录；files：serve.mjs 的地址；provider：渲染浏览器；getOrigin()：本机服务自己的地址（渲染浏览器从这里开页面）。
 * 一次只渲一个，别的排队。
 */
export function createPages({ root, library, files, provider, getOrigin }) {
  const directory = path.join(root, "pages");
  let queue = Promise.resolve();
  const serial = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };

  /**
   * 把 rel（pages/ 下的相对路径）渲成素材。itemId 给了就是重渲同一个素材、原地换文件。回 { item, problems, duration }。
   * transparent："auto" 先抽三帧看有没有透明的地方，有就当带透明的（PNG MOV），没有编 H.264。
   */
  const render = ({ rel, name, width, height, duration, fallback = null, transparent, fps = 30, itemId = null, pageId, reference, onProgress, signal }) => serial(async () => {
    if (!provider) throw new AiEditError("film_unavailable", "这个环境没有能渲染网页的浏览器。", 503);
    const origin = getOrigin();
    const url = files.urlFor(origin, `pages/${rel}`);
    const tab = await openTab(provider, url, { width, height, background: transparent ? "transparent" : null }).catch((error) => {
      throw new AiEditError("page_failed", `网页片段打不开：${error.message}`, 422);
    });
    let encoder = null;
    const temp = path.join(library.root, `page-${randomBytes(8).toString("hex")}.part`);
    try {
      const wanted = duration ?? tab.meta.duration ?? fallback ?? 0;
      if (!(wanted > 0)) throw new AiEditError("page_no_duration", "网页片段没有时长：在 window.film 里写 duration，或者调用时给 duration。", 422);
      const { count, seconds, cut } = pageFrames(wanted, fps);
      encoder = await openTab(provider, files.urlFor(origin, "__encoder.html"), { plain: true });
      if (transparent === "auto") {
        transparent = false;
        for (const t of [0, seconds / 2, Math.max(0, (count - 1) / fps)]) {
          await tab.seek(t);
          if (await encoder.evaluate(`${HAS_ALPHA}(${JSON.stringify((await tab.capture({ format: "png" })).toString("base64"))})`)) { transparent = true; break; }
        }
      }
      const format = transparent ? "png" : "jpeg";
      // 抽三帧，正着画完以后倒着再画一遍对比（openfilm look 的做法）：画面跟画的顺序有关就是没按 t 算
      const checks = new Map([0.25, 0.5, 0.75].map((share) => [Math.min(count - 1, Math.floor(share * count)), null]));
      // ponytail: 一个标签页按顺序画。开多个标签页同时画实测更慢（10-23：1080p 网页单页 189ms/帧，四页 273ms/帧，截图都挤在同一个 GPU 回读上）；
      // 真要并行得像 openfilm 那样开多个浏览器
      const frame = async (index) => {
        await tab.seek(index / fps);
        const data = await tab.capture({ format });
        if (checks.has(index)) checks.set(index, data);
        return data;
      };
      const { width: pageWidth, height: pageHeight } = tab.meta;
      const extension = transparent ? ".mov" : ".mp4";
      if (transparent) await writePngMov({ file: temp, width: pageWidth, height: pageHeight, fps, count, frame, onProgress, signal });
      else await encodeMp4({ encoderTab: encoder, file: temp, width: pageWidth, height: pageHeight, fps, count, frame, onProgress, signal });
      const problems = [...tab.problems];
      if (cut) problems.push(`页面要 ${wanted} 秒，网页片段最长 ${MAX_PAGE_SECONDS} 秒，只渲了前 ${MAX_PAGE_SECONDS} 秒：更长的内容拆成几段网页片段接着放`);
      for (const [index, first] of [...checks].reverse()) {
        if (!first) continue;
        await tab.seek(index / fps);
        const again = await tab.capture({ format });
        const diff = await encoder.evaluate(`${DIFF}(${JSON.stringify(first.toString("base64"))}, ${JSON.stringify(again.toString("base64"))}, ${transparent})`);
        if (diff > UNSTEADY) {
          problems.push(`第 ${Math.round((index / fps) * 100) / 100} 秒的画面重画一次就不一样：frame(t) 只能按 t 算（别用 Date.now、setInterval、累加的变量、没给起点的补间）`);
          break;
        }
      }
      const item = await library.adopt(temp, {
        id: itemId, name, extension,
        // renderedAt：看板的 iframe 地址带上它，改写后的网页不吃缓存
        source: { type: "page", page: rel, ...(pageId ? { pageId } : {}), ...(reference ? { reference } : {}), transparent: Boolean(transparent), renderedAt: Date.now() },
      });
      return { item, problems, duration: seconds };
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      if (error instanceof AiEditError || error?.name === "AbortError") throw error;
      throw new AiEditError("page_failed", `网页片段没渲出来：${error.message}`, 422);
    } finally {
      await Promise.allSettled([tab.close(), encoder?.close()]);
    }
  });

  return {
    directory,
    render,

    /** 直接按真实动画时钟截图，不编码、不入素材库，也不覆盖正式页面。 */
    preview: ({ html, pageId = null, times, width, height, crop = [0, 0, 1, 1], transparent = false, signal }) => serial(async () => {
      validateHtml(html);
      if (pageId && !isPageId(pageId)) throw new AiEditError('page_not_found', '没有这个网页片段。', 404);
      if (!Array.isArray(times) || !times.length || times.length > 8 || times.some((t, i) => !Number.isFinite(t) || t < 0 || (i && t <= times[i - 1]))) {
        throw new AiEditError("arguments_invalid", "预览需要 1–8 个严格递增的动画秒数。", 422);
      }
      if (!Array.isArray(crop) || crop.length !== 4 || !crop.every(n => Number.isFinite(n) && n >= 0 && n <= 1) || crop[2] <= 0 || crop[3] <= 0 || crop[0] + crop[2] > 1 || crop[1] + crop[3] > 1) {
        throw new AiEditError("arguments_invalid", "预览裁切范围无效。", 422);
      }
      if (!provider) throw new AiEditError("film_unavailable", "这个环境没有能渲染网页的浏览器。", 503);
      signal?.throwIfAborted();
      const id = `_preview-${randomBytes(8).toString("hex")}`, folder = path.join(directory, pageId ?? id);
      const filename = pageId ? `${id}.html` : 'index.html', file = path.join(folder, filename);
      let tab;
      try {
        if (pageId) await readFile(path.join(folder, 'index.html'));
        else await mkdir(folder, { recursive: true, mode: 0o700 });
        await writeFile(file, html, { mode: 0o600 });
        tab = await openTab(provider, files.urlFor(getOrigin(), `pages/${pageId ?? id}/${filename}`), { width, height, background: transparent ? "transparent" : null });
        const duration = tab.meta.duration;
        if (!(duration > 0) || duration > MAX_PAGE_SECONDS || times.some(t => t >= duration)) throw new AiEditError("arguments_invalid", "预览秒数超出网页动画时长；保留真实动画时钟，不要把页面改成短时长定格。", 422);
        const { default: sharp } = await import("sharp");
        const images = [], pixels = [], diagnostics = [];
        const shot = async () => {
          const input = sharp(await tab.capture({ format: "png" }));
          const { width: w, height: h } = await input.metadata();
          const left = Math.min(w - 1, Math.floor(w * crop[0])), top = Math.min(h - 1, Math.floor(h * crop[1]));
          const frame = input.extract({ left, top, width: Math.max(1, Math.min(w - left, Math.round(w * crop[2]))), height: Math.max(1, Math.min(h - top, Math.round(h * crop[3]))) });
          return { image: `data:image/jpeg;base64,${(await frame.clone().flatten({ background: "black" }).resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer()).toString("base64")}`,
            pixels: await (transparent ? frame.ensureAlpha() : frame.flatten({ background: "black" }).removeAlpha()).resize(96, 96, { fit: "fill" }).raw().toBuffer() };
        };
        for (const time of times) {
          signal?.throwIfAborted();
          await tab.seek(time);
          const frame = await shot();
          images.push(frame.image); pixels.push(frame.pixels);
          let dark = 0;
          const channels = transparent ? 4 : 3;
          for (let i = 0; i < frame.pixels.length; i += channels) if (Math.max(...frame.pixels.subarray(i, i + 3)) < 13) dark++;
          diagnostics.push({ time, nearly_black: dark / (frame.pixels.length / channels) >= .995 });
        }
        // 按相反顺序重画，避免只在正向播放时正确的累加动画进入正式渲染。
        for (let i = times.length - 1; i >= 0; i--) {
          signal?.throwIfAborted();
          await tab.seek(times[i]);
          const again = (await shot()).pixels;
          const delta = again.reduce((sum, n, j) => sum + Math.abs(n - pixels[i][j]), 0) / again.length / 255;
          diagnostics[i].repeat_difference = Math.round(delta * 1e6) / 1e6;
          diagnostics[i].unstable = delta > UNSTEADY;
        }
        signal?.throwIfAborted();
        return { images, duration, diagnostics, problems: [...tab.problems] };
      } finally {
        await tab?.close().catch(() => undefined);
        await rm(pageId ? file : folder, { recursive: !pageId, force: true });
      }
    }),

    /** 素材是不是网页片段：回它的 HTML 相对路径（pages/ 下），不是就是 null。 */
    pageOf(item) {
      return item?.source?.type === "page" && typeof item.source.page === "string" ? item.source.page : null;
    },

    async read(pageId) {
      if (!isPageId(pageId)) throw new AiEditError("page_not_found", "没有这个网页片段。", 404);
      try { return await readFile(path.join(directory, pageId, "index.html"), "utf8"); }
      catch { throw new AiEditError("page_not_found", "没有这个网页片段。", 404); }
    },

    /**
     * AI 写的网页片段：新建（不给 pageId）或改写，存好再渲成素材。同一个页面改透明与否会换成新素材（后缀不同），
     * 回 { item, pageId, problems, duration, replaced }，replaced 是被换掉的旧素材 id。
     */
    async write({ pageId = null, title, html, duration = null, width, height, transparent = false, fps, reference, onProgress, signal }) {
      validateHtml(html);
      const id = pageId ?? randomBytes(8).toString("hex");
      if (!isPageId(id)) throw new AiEditError("page_not_found", "没有这个网页片段，新建时别填 page_id。", 404);
      const folder = path.join(directory, id);
      const existing = pageId ? library.list().find((item) => item.source?.type === "page" && item.source.pageId === id) : null;
      if (pageId && !existing) throw new AiEditError("page_not_found", "没有这个网页片段，新建时别填 page_id。", 404);
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const file = path.join(folder, "index.html");
      const before = pageId ? await readFile(file, "utf8").catch(() => null) : null;
      await writeFile(`${file}.tmp`, html, { mode: 0o600 });
      await renameRetrying(`${file}.tmp`, file);
      const sameKind = existing && Boolean(existing.source.transparent) === Boolean(transparent);
      try {
        const result = await render({
          rel: `${id}/index.html`, name: `${String(title ?? existing?.name ?? "网页片段").slice(0, 60)}`, width, height,
          duration, fallback: existing?.durationUs ? existing.durationUs / 1e6 : null,
          transparent, fps, itemId: sameKind ? existing.id : null, pageId: id, reference: reference ?? existing?.source?.reference, onProgress, signal,
        });
        return { ...result, pageId: id, replaced: existing && !sameKind ? existing.id : null };
      } catch (error) {
        // 改写没渲出来就放回原来的页面，素材和 HTML 对得上
        if (before !== null) await writeFile(file, before, { mode: 0o600 }).catch(() => undefined);
        else if (!pageId) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    },
  };
}
