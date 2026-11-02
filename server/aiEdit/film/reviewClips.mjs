import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AiEditError } from '../library.mjs';
import { renameRetrying } from '../rename.mjs';
import { openTab } from './browser.mjs';
import { encodeMp4 } from './encoder.mjs';
import { assetStamp, pageAssetStamps, reviewComposition, CANDIDATE_FILE } from './reviewComposition.mjs';

export const reviewHash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const validReviewCrop = c => Array.isArray(c) && c.length === 4 && c.every(n => Number.isFinite(n) && n >= 0 && n <= 1)
  && c[2] > 0 && c[3] > 0 && c[0] + c[2] <= 1 && c[1] + c[3] <= 1;

// 只渲染指定区间，保留页面真实时钟和视口；输出为分析副本，不入库、不覆盖正式页。
export function createReviewClips({ root, library, files, provider, getOrigin }) {
  let queue = Promise.resolve();
  const composition = args => reviewComposition({ root, library, ...args });
  const render = async ({ sessionId, html, pageId, project, clipId, mediaFile, sourceDuration, width, height, start, duration, crop = [0, 0, 1, 1], fps = 10, signal, onProgress }) => {
    if (!/^[a-f0-9]{32}$/u.test(sessionId) || (pageId && !/^[a-f0-9]{16}$/u.test(pageId))
      || !Number.isFinite(start) || start < 0 || !Number.isFinite(duration) || duration < .5 || duration > 12
      || !validReviewCrop(crop) || ![5, 10].includes(fps) || !(width > 0 && height > 0)) {
      throw new AiEditError('arguments_invalid', '视频复核需要有效的裁切与 0.5–12 秒区间，采样率为 5 或 10 fps。', 422);
    }
    signal?.throwIfAborted();
    if (!provider) throw new AiEditError('film_unavailable', '没有可用的本地渲染浏览器。', 503);
    if (mediaFile && (!mediaFile.startsWith(path.join(root, 'media') + path.sep) || html !== undefined)) throw new AiEditError('arguments_invalid', '复核素材来源无效。', 422);
    const scene = project ? await composition({ project, pageId, html, clipId, start, duration }) : null;
    if (project && !scene) throw new AiEditError('review_composition_required', '候选没有对应的时间线合成。', 422);
    const assets = mediaFile ? [await assetStamp(mediaFile)] : await pageAssetStamps(root, pageId, html);
    const key = reviewHash({ version: 2, html, pageId, mediaFile, assets, composition: scene?.key, width, height, start, duration, crop, fps });
    const folder = path.join(root, 'renders', `${sessionId}-review`), output = path.join(folder, `${key}.mp4`);
    const rel = `renders/${sessionId}-review/${key}.mp4`;
    const count = Math.ceil(duration * fps);
    const metadata = { file: output, relative: rel, key, start, duration, encodedDuration: count / fps, fps, frames: count,
      ...(scene ? { composition: { key: scene.key, clipId: scene.clipId, start: scene.start } } : {}) };
    try { if ((await stat(output)).size > 0) return { ...metadata, cached: true }; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (mediaFile && start + duration > sourceDuration + 1e-6) throw new AiEditError('arguments_invalid', '视频复核区间超出素材时长。', 422);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `_review-${randomBytes(8).toString('hex')}`;
    const pageFolder = path.join(root, 'pages', pageId ?? temporary);
    await mkdir(pageFolder, { recursive: true, mode: 0o700 });
    const pageFile = path.join(pageFolder, `${temporary}.html`);
    const sceneFolder = path.join(folder, temporary);
    let tab, encoder;
    try {
      const videoUrl = mediaFile ? files.urlFor(getOrigin(), `media/${path.basename(mediaFile)}`) : null;
      const content = html ?? `<!doctype html><style>html,body{margin:0;background:black;overflow:hidden}video{width:100vw;height:100vh;object-fit:fill}</style><video muted playsinline></video><script>
const v=document.querySelector('video');const ready=new Promise((ok,no)=>{v.onloadeddata=ok;v.onerror=()=>no(Error('视频加载失败'))});v.src=${JSON.stringify(videoUrl)};
window.film={duration:${sourceDuration},ready,async frame(t){await ready;if(Math.abs(v.currentTime-t)<.00001&&v.readyState>=2)return;await new Promise((ok,no)=>{const timeout=setTimeout(()=>done(Error('视频定位超时')),15000);const done=e=>{clearTimeout(timeout);v.removeEventListener('seeked',seeked);v.removeEventListener('error',failed);e?no(e):ok()};const seeked=()=>done(),failed=()=>done(Error('视频定位失败'));v.addEventListener('seeked',seeked,{once:true});v.addEventListener('error',failed,{once:true});v.currentTime=t})}};</script>`;
      if (typeof content !== 'string' || Buffer.byteLength(content) > 400 * 1024) throw new AiEditError('arguments_invalid', '候选页面无效。', 422);
      await writeFile(pageFile, content, { mode: 0o600 });
      let url = files.urlFor(getOrigin(), `pages/${pageId ?? temporary}/${temporary}.html`);
      if (scene) {
        await mkdir(path.join(sceneFolder, 'text'), { recursive: true, mode: 0o700 });
        await writeFile(path.join(sceneFolder, 'film.html'), scene.html.replaceAll(CANDIDATE_FILE, `${temporary}.html`), { mode: 0o600 });
        for (const page of scene.texts) await writeFile(path.join(sceneFolder, page.src), page.html, { mode: 0o600 });
        url = files.urlFor(getOrigin(), `renders/${sessionId}-review/${temporary}/film.html`);
      }
      tab = await openTab(provider, url, { width, height, background: 'black' });
      const clockStart = scene?.start ?? start;
      if (!(tab.meta.duration >= clockStart + duration - 1e-6)) throw new AiEditError('arguments_invalid', '复核区间超出页面真实时长。', 422);
      encoder = await openTab(provider, files.urlFor(getOrigin(), '__encoder.html'), { plain: true });
      const w = Math.max(2, Math.round(width * crop[2])), h = Math.max(2, Math.round(height * crop[3]));
      const scale = Math.min(1, 960 / Math.max(w, h)), ow = Math.max(2, Math.floor(w * scale / 2) * 2), oh = Math.max(2, Math.floor(h * scale / 2) * 2);
      const frame = async i => {
        signal?.throwIfAborted();
        await tab.seek(clockStart + i / fps);
        return sharp(await tab.capture({ format: 'png' })).extract({ left: Math.floor(width * crop[0]), top: Math.floor(height * crop[1]), width: Math.min(w, width - Math.floor(width * crop[0])), height: Math.min(h, height - Math.floor(height * crop[1])) })
          .flatten({ background: 'black' }).resize(ow, oh).jpeg({ quality: 88 }).toBuffer();
      };
      await encodeMp4({ encoderTab: encoder, file: `${output}.part`, width: ow, height: oh, fps, count, frame, signal, onProgress });
      if (tab.problems.length) throw new AiEditError('page_failed', `复核片段存在加载或脚本错误：${tab.problems.join('；')}`, 422);
      signal?.throwIfAborted();
      await renameRetrying(`${output}.part`, output);
      return { ...metadata, cached: false };
    } finally {
      await Promise.allSettled([tab?.close(), encoder?.close()]);
      await rm(`${output}.part`, { force: true });
      await rm(pageId ? pageFile : pageFolder, { recursive: !pageId, force: true });
      await rm(sceneFolder, { recursive: true, force: true });
    }
  };
  return { composition, render(args) { const run = queue.then(() => render(args), () => render(args)); queue = run.catch(() => undefined); return run; } };
}
