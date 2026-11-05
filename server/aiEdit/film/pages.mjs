import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { AiEditError } from "../library.mjs";
import { renameRetrying } from "../rename.mjs";
import { modelFetch } from "../../systemProxy.mjs";
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
  // 引用了共用文件夹（../_shared-…/、../_skills/…/）的页面，window.film 可以由共用引擎定义；真没定义的话渲染时宿主照样报错
  if (!/window\.film\b|\bfilm\s*=/u.test(html) && !/\.\.\/_[\w-][\w.-]*\//u.test(html)) {
    throw new AiEditError("page_not_film", "网页里要定义 window.film = { duration, frame(t) { … } }，或者引用定义了它的共用文件。", 422);
  }
}

/** 在内存中精确修改一段文字：每个原文片段必须唯一，按顺序替换，每步之后 check 一次。 */
function patchText(original, patches, { missing, reread, check = () => {} }) {
  if (typeof original !== 'string' || !Array.isArray(patches) || patches.length < 1 || patches.length > 24) {
    throw new AiEditError('arguments_invalid', missing, 422);
  }
  let text = original;
  for (const [index, patch] of patches.entries()) {
    if (!patch || typeof patch.find !== 'string' || !patch.find.length || typeof patch.replace !== 'string') {
      throw new AiEditError('arguments_invalid', `第 ${index + 1} 处修改需要非空 find 和字符串 replace。`, 422);
    }
    const at = text.indexOf(patch.find);
    if (at < 0 || text.indexOf(patch.find, at + 1) >= 0) {
      throw new AiEditError('page_patch_mismatch', `第 ${index + 1} 处原文未找到或不唯一，请重新 ${reread} 并提供完整的唯一片段。`, 409);
    }
    text = text.slice(0, at) + patch.replace + text.slice(at + patch.find.length);
    check(text);
  }
  return text;
}

/** 在内存中精确修改正式页；每个原文片段必须唯一，避免校准一处时误改其他图层。 */
export function patchPageHtml(original, patches) {
  return patchText(original, patches, { missing: '局部预览需要已有 page_id 和 1–24 处 patches。', reread: 'read_page', check: validateHtml });
}

// 多页共用的文件（AI 写的动画引擎、样式、着色器、场景数据）：放在 pages/_shared-<工程 id>/ 下，页面用 ../_shared-<工程 id>/<路径> 引用。
// 工程包导出和复核缓存本来就认 ../_<名字>/ 这种共用文件夹（studio.mjs 的 SHARED_REF、reviewComposition 的 pageAssetStamps）。
export const MAX_SHARED_BYTES = 400 * 1024;
const MAX_SHARED_ASSET_BYTES = 32 * 1024 * 1024, MAX_SHARED_TOTAL = 128 * 1024 * 1024, MAX_SHARED_FILES = 64;
const SHARED_EXTENSIONS = new Set([".js", ".mjs", ".css", ".json", ".svg", ".txt", ".md", ".glsl", ".vert", ".frag", ".wgsl", ".csv"]);
// 字体和图片：二进制，不走 write_shared_file，用 import_shared_file 放进来；按文件头认，别让一页 404 的 HTML 冒充字体
const head = (bytes, text) => bytes.toString("latin1", 0, text.length) === text;
const sfnt = (bytes) => head(bytes, "OTTO") || head(bytes, "true") || bytes.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]));
const jpeg = (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
const SHARED_ASSETS = {
  ".woff2": (bytes) => head(bytes, "wOF2"), ".woff": (bytes) => head(bytes, "wOFF"), ".ttf": sfnt, ".otf": sfnt,
  ".png": (bytes) => head(bytes, "\x89PNG"), ".jpg": jpeg, ".jpeg": jpeg, ".gif": (bytes) => head(bytes, "GIF8"),
  ".webp": (bytes) => head(bytes, "RIFF") && bytes.toString("latin1", 8, 12) === "WEBP",
};
const FONT_EXTENSIONS = new Set([".woff2", ".woff", ".ttf", ".otf"]);
// 能下字体和图片的地方：页面本来就能引的 CDN（host.mjs 的策略）加 Google 字体的文件站
const SHARED_ASSET_HOSTS = new Set(["cdn.jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com", "esm.sh", "fonts.gstatic.com"]);
const SHARED_ASSET_FETCH_MS = 120_000;
const SHARED_PART = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/u;
/** 产品事实说明：放在共用文件夹，系统提示带上它；页面不引用，改了不重渲。 */
export const FACTS_FILE = "facts.md";

export function sharedFolderOf(projectId) {
  if (typeof projectId !== "string" || !/^[0-9a-f]{32}$/u.test(projectId)) throw new AiEditError("project_not_found", "没有这个工程。", 404);
  return `_shared-${projectId}`;
}

const isSharedAsset = (file) => Object.hasOwn(SHARED_ASSETS, path.extname(file).toLowerCase());

/** 共用文件的相对路径：字母、数字、_ - . 和 /，最多 4 层，只许文本和字体、图片后缀。 */
export function sharedFilePath(file) {
  const parts = typeof file === "string" ? file.split("/") : [];
  if (!parts.length || parts.length > 4 || parts.some((part) => !SHARED_PART.test(part) || part === "." || part === "..")) {
    throw new AiEditError("arguments_invalid", "共用文件的路径只能用字母、数字、_ - . 和 /，最多 4 层，比如 engine.js、scenes/intro.js。", 422);
  }
  if (!SHARED_EXTENSIONS.has(path.extname(file).toLowerCase()) && !isSharedAsset(file)) {
    throw new AiEditError("arguments_invalid", `共用文件只能是文本（${[...SHARED_EXTENSIONS].join(" ")}）或字体、图片（${Object.keys(SHARED_ASSETS).join(" ")}）。`, 422);
  }
  return parts.join("/");
}

/**
 * import_shared_file 的来源，三选一：media_id 素材库里的图片、url 上面几个 CDN 的 https 地址、file 本机的字体文件。回文件字节。
 * 本机路径只收字体：别的文件可能是用户的私人文件，要放进来先传进素材库。
 */
export async function sharedAssetBytes({ media_id, url, file }, { library, signal, fetchImpl = modelFetch } = {}) {
  const given = [media_id, url, file].filter((value) => value !== undefined);
  if (given.length !== 1) throw new AiEditError("arguments_invalid", "media_id、url、file 三选一。", 422);
  const tooLarge = () => new AiEditError("shared_file_too_large", `字体和图片单个最多 ${MAX_SHARED_ASSET_BYTES / 1024 / 1024}MB。`, 422);
  if (media_id !== undefined) {
    const item = library.get(media_id);
    const ready = item?.kind === "image" ? library.readyPath(media_id) : null;
    if (!ready) throw new AiEditError("media_not_found", "素材库里没有这张可用的图片。", 404);
    return readFile(ready);
  }
  if (file !== undefined) {
    if (typeof file !== "string" || !path.isAbsolute(file) || !FONT_EXTENSIONS.has(path.extname(file).toLowerCase())) {
      throw new AiEditError("arguments_invalid", "file 只收本机字体文件的绝对路径（.woff2 .woff .ttf .otf）；图片先放进素材库，用 media_id。", 422);
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) throw new AiEditError("shared_file_not_found", `本机没有这个字体文件：${file}`, 404);
    if (info.size > MAX_SHARED_ASSET_BYTES) throw tooLarge();
    return readFile(file);
  }
  let address;
  try { address = new URL(url); } catch { address = null; }
  if (address?.protocol !== "https:" || !SHARED_ASSET_HOSTS.has(address.hostname)) {
    throw new AiEditError("arguments_invalid", `url 只收这几个站的 https 地址：${[...SHARED_ASSET_HOSTS].join("、")}。`, 422);
  }
  const timeout = AbortSignal.timeout(SHARED_ASSET_FETCH_MS);
  const response = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout }).catch((error) => {
    if (signal?.aborted) throw error;
    throw new AiEditError("shared_download_failed", `下载失败：${error.message}`, 502);
  });
  if (!response.ok) throw new AiEditError("shared_download_failed", `下载失败：${url} 回了 ${response.status}。`, 502);
  if (Number(response.headers.get("content-length")) > MAX_SHARED_ASSET_BYTES) throw tooLarge();
  // ponytail: 没写长度的回应整份读进内存再量；只从这几个 CDN 下，够用
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_SHARED_ASSET_BYTES) throw tooLarge();
  return bytes;
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

  /** 写进共用文件夹：查个数和合计大小，临时文件换名落盘。 */
  const putShared = async (folder, rel, bytes, existing) => {
    const created = !existing.some((item) => item.path === rel);
    if (created && existing.length >= MAX_SHARED_FILES) throw new AiEditError("shared_folder_full", `一个工程最多 ${MAX_SHARED_FILES} 个共用文件。`, 422);
    if (existing.reduce((sum, item) => sum + (item.path === rel ? 0 : item.bytes), 0) + bytes.length > MAX_SHARED_TOTAL) {
      throw new AiEditError("shared_folder_full", `一个工程的共用文件合计最多 ${MAX_SHARED_TOTAL / 1024 / 1024}MB。`, 422);
    }
    const target = path.join(directory, folder, rel);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(`${target}.tmp`, bytes, { mode: 0o600 });
    await renameRetrying(`${target}.tmp`, target);
    return { file: rel, bytes: bytes.length, created };
  };

  const api = {
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

    /**
     * 封面静帧：每个尺寸开一次页面（地址带 ?cover=比例，页面据此去掉宽银幕黑边和字幕、按视口重新构图），定在 time 截一张 JPEG。
     * html 给了就用这份（只为封面写的页面），不进素材库；否则用 pageId 的正式页。shots：[{ aspect, width, height }]。
     */
    still: ({ html = null, pageId = null, time = 0, shots, signal }) => serial(async () => {
      if (!provider) throw new AiEditError("film_unavailable", "这个环境没有能渲染网页的浏览器。", 503);
      if (html !== null) validateHtml(html);
      else await api.read(pageId);
      const id = `_preview-${randomBytes(8).toString("hex")}`, folder = path.join(directory, id);
      const rel = html === null ? `${pageId}/index.html` : `${id}/index.html`;
      try {
        if (html !== null) {
          await mkdir(folder, { recursive: true, mode: 0o700 });
          await writeFile(path.join(folder, "index.html"), html, { mode: 0o600 });
        }
        const images = [];
        for (const { aspect, width, height } of shots) {
          signal?.throwIfAborted();
          const tab = await openTab(provider, `${files.urlFor(getOrigin(), `pages/${rel}`)}?cover=${encodeURIComponent(aspect)}`, { width, height, background: "black" });
          try {
            if (tab.meta.duration > 0 && time >= tab.meta.duration) throw new AiEditError("arguments_invalid", `time 超出页面时长 ${tab.meta.duration} 秒。`, 422);
            await tab.seek(time);
            const problems = [...tab.problems];
            if (tab.meta.width !== width || tab.meta.height !== height) problems.push(`页面把尺寸写死成了 ${tab.meta.width}×${tab.meta.height}，不是 ${width}×${height}：window.film 别写 width、height，按 innerWidth、innerHeight 排版`);
            images.push({ aspect, width: tab.meta.width, height: tab.meta.height, image: await tab.capture({ format: "jpeg", quality: 92 }), problems });
          } finally {
            await tab.close();
          }
        }
        return images;
      } finally {
        if (html !== null) await rm(folder, { recursive: true, force: true });
      }
    }),

    /** 共用文件夹里的文件：不给 file 列出全部（路径和字节数），给了就读出内容。 */
    async readShared(folder, file = null) {
      const base = path.join(directory, folder);
      if (file === null) {
        const files = [];
        const walk = async (dir, prefix) => {
          let entries = [];
          try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
          for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name.endsWith(".tmp")) continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
            else if (entry.isFile()) files.push({ path: rel, bytes: (await stat(path.join(dir, entry.name))).size });
          }
        };
        await walk(base, "");
        return files;
      }
      const rel = sharedFilePath(file);
      if (isSharedAsset(rel)) throw new AiEditError("arguments_invalid", `${rel} 是字体或图片，读不成文字；页面里用 ref 引用它。`, 422);
      try { return await readFile(path.join(base, rel), "utf8"); }
      catch { throw new AiEditError("shared_file_not_found", `共用文件夹里没有 ${rel}。`, 404); }
    },

    /** 写一个共用文件：content 整份写，或 patches 在现有内容上精确替换。回 { file, bytes, created }。 */
    async writeShared(folder, file, { content, patches }) {
      const rel = sharedFilePath(file);
      if (isSharedAsset(rel)) throw new AiEditError("arguments_invalid", `${rel} 是字体或图片，用 import_shared_file 放进来。`, 422);
      if ((content === undefined) === (patches === undefined)) throw new AiEditError("arguments_invalid", "content 和 patches 二选一。", 422);
      const existing = await api.readShared(folder);
      const before = existing.find((item) => item.path === rel);
      const text = patches !== undefined
        ? patchText(before ? await api.readShared(folder, rel) : null, patches, { missing: "局部修改需要已有的共用文件和 1–24 处 patches。", reread: "read_shared_file" })
        : content;
      if (typeof text !== "string") throw new AiEditError("arguments_invalid", "共用文件的内容要是文字。", 422);
      const bytes = Buffer.from(text);
      if (bytes.length > MAX_SHARED_BYTES) throw new AiEditError("shared_file_too_large", `单个共用文件最多 ${MAX_SHARED_BYTES / 1024}KB，拆成几个文件。`, 422);
      return putShared(folder, rel, bytes, existing);
    },

    /** 放一个字体或图片：先按后缀看文件头对不对。回 { file, bytes, created }。 */
    async importShared(folder, file, bytes) {
      const rel = sharedFilePath(file);
      const matches = SHARED_ASSETS[path.extname(rel).toLowerCase()];
      if (!matches) throw new AiEditError("arguments_invalid", `import_shared_file 只收字体和图片（${Object.keys(SHARED_ASSETS).join(" ")}）；文本用 write_shared_file。`, 422);
      if (!matches(bytes)) throw new AiEditError("shared_file_mismatch", `内容不是 ${path.extname(rel)} 文件（可能下到了出错页），换个来源。`, 422);
      if (bytes.length > MAX_SHARED_ASSET_BYTES) throw new AiEditError("shared_file_too_large", `字体和图片单个最多 ${MAX_SHARED_ASSET_BYTES / 1024 / 1024}MB。`, 422);
      return putShared(folder, rel, bytes, await api.readShared(folder));
    },

    /** 引用了这个共用文件夹的网页片段 id（读每页的 index.html 找 ../<folder>/）。 */
    async dependents(folder) {
      const needle = `../${folder}/`, found = [];
      let entries = [];
      try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory() || !isPageId(entry.name)) continue;
        const html = await readFile(path.join(directory, entry.name, "index.html"), "utf8").catch(() => "");
        if (html.includes(needle)) found.push(entry.name);
      }
      return found;
    },

    /** 按现在的 HTML、原时长和透明与否重渲一个网页片段，素材原地换文件，时间线不用动。 */
    async rerender(pageId, { width, height, fps, signal, onProgress } = {}) {
      if (!isPageId(pageId)) throw new AiEditError("page_not_found", "没有这个网页片段。", 404);
      const item = library.list().find((entry) => entry.source?.type === "page" && entry.source.pageId === pageId);
      if (!item) throw new AiEditError("page_not_found", "这个网页片段没有对应的素材。", 404);
      return render({
        rel: `${pageId}/index.html`, name: item.name, width, height, duration: item.durationUs > 0 ? item.durationUs / 1e6 : null,
        transparent: Boolean(item.source.transparent), fps, itemId: item.id, pageId, reference: item.source.reference, onProgress, signal,
      });
    },

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
  return api;
}
