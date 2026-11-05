import { randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { AiEditError } from '../library.mjs';
import { openTab } from './browser.mjs';
import { droppedText, projectToFilm } from './filmFile.mjs';

// 整片联系表：整条时间线（视频、网页片段、文字、字幕，和导出用同一个合成器）按时刻抽帧拼成几张图，
// 一次看全片的节奏、亮度、构图和衔接。只截画面，不编码、不入库、不改工程，也没有音轨。
export const MAX_SHEET_FRAMES = 48;
const PER_SHEET = 24, COLUMNS = 6, TILE_WIDTH = 320, LABEL_HEIGHT = 26;

const fail = message => { throw new AiEditError('arguments_invalid', message, 422); };

/** 在 [start, end) 里均匀取 count 个时刻（每格的中点，避开开头和末尾那一帧），保留到毫秒。 */
export function sheetTimes({ duration, start = 0, end = duration, count = PER_SHEET }) {
  if (!(duration > 0)) fail('时间线是空的，没有可看的画面。');
  const from = Math.max(0, start), to = Math.min(duration, end);
  if (!(to > from)) fail('联系表的起止时间不对：要在 0 到时间线总长之间，而且结束晚于开始。');
  if (!Number.isInteger(count) || count < 1 || count > MAX_SHEET_FRAMES) fail(`一次最多看 ${MAX_SHEET_FRAMES} 帧。`);
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, i) => Math.round((from + step * (i + 0.5)) * 1000) / 1000);
}

/** 一帧的亮度统计：平均亮度、过亮和过暗的像素占比、平均饱和度（都是 0–1）。 */
export async function frameStats(image) {
  const { data } = await sharp(image).flatten({ background: 'black' }).resize(96, 54, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let luma = 0, bright = 0, dark = 0, saturation = 0;
  const n = data.length / 3;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2], y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    luma += y; if (y > 235) bright++; if (y < 16) dark++;
    saturation += max ? (max - min) / max : 0;
  }
  const round = v => Math.round(v * 1000) / 1000;
  return { luma: round(luma / n / 255), bright: round(bright / n), dark: round(dark / n), saturation: round(saturation / n) };
}

/** 从统计里挑出值得看的帧：几乎全黑、大面积过亮、和前一帧亮度跳得很大。 */
export function sheetFlags(frames) {
  const flags = [];
  frames.forEach((frame, i) => {
    if (frame.dark >= 0.97) flags.push({ time: frame.time, issue: '几乎全黑' });
    else if (frame.bright >= 0.2) flags.push({ time: frame.time, issue: '大面积过亮，可能刺眼' });
    const before = frames[i - 1];
    if (before && Math.abs(frame.luma - before.luma) >= 0.25) flags.push({ time: frame.time, issue: `和 ${before.time} 秒相比亮度跳变 ${Math.round((frame.luma - before.luma) * 100)}%` });
  });
  return flags;
}

const label = (text, width) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${LABEL_HEIGHT}">`
  + `<rect width="100%" height="100%" fill="#1d1d1d"/><text x="8" y="18" font-family="Menlo, Consolas, monospace" font-size="15" fill="#ffd84d">${text}</text></svg>`);

export function createTimelineSheets({ root, library, files, provider, getOrigin }) {
  let queue = Promise.resolve();
  const render = async ({ sessionId, project, times, signal }) => {
    if (!/^[a-f0-9]{32}$/u.test(sessionId ?? '')) fail('会话编号无效。');
    if (!Array.isArray(times) || !times.length || times.length > MAX_SHEET_FRAMES
      || times.some((t, i) => !Number.isFinite(t) || t < 0 || (i && t <= times[i - 1]))) fail(`联系表要 1–${MAX_SHEET_FRAMES} 个严格递增的时间线秒数。`);
    if (!provider) throw new AiEditError('film_unavailable', '没有可用的本地渲染浏览器。', 503);
    const { width, height } = project.canvas;
    const mediaOf = file => library.get(library.idForPath(file));
    const plan = projectToFilm(project, {
      mediaOf,
      srcFor: (item) => {
        if (!item) throw new AiEditError('media_not_found', '时间线上有素材找不到了，先修好再看联系表。', 422);
        const ready = library.readyPath(item.id);
        if (!ready?.startsWith(path.join(root, 'media') + path.sep)) throw new AiEditError('media_not_found', '时间线素材来源无效。', 422);
        return `../../../media/${path.basename(ready)}`;
      },
      pageSrc: rel => {
        const normalized = path.posix.normalize(rel);
        if (normalized.startsWith('../') || path.isAbsolute(normalized)) throw new AiEditError('arguments_invalid', '时间线网页路径无效。', 422);
        return `../../../pages/${normalized}`;
      },
      textSrc: s => `text/${s.id}.html`,
    });
    const temporary = `_sheet-${randomBytes(8).toString('hex')}`;
    const folder = path.join(root, 'renders', `${sessionId}-review`, temporary);
    let tab;
    try {
      await mkdir(path.join(folder, 'text'), { recursive: true, mode: 0o700 });
      await writeFile(path.join(folder, 'film.html'), plan.html, { mode: 0o600 });
      for (const page of plan.texts) await writeFile(path.join(folder, page.src), page.html, { mode: 0o600 });
      signal?.throwIfAborted();
      tab = await openTab(provider, files.urlFor(getOrigin(), `renders/${sessionId}-review/${temporary}/film.html`), { width, height, background: 'black' });
      const tileHeight = Math.max(2, Math.round(TILE_WIDTH * height / width));
      const frames = [], tiles = [];
      for (const time of times) {
        signal?.throwIfAborted();
        await tab.seek(time);
        const shot = await tab.capture({ format: 'png' });
        frames.push({ time, ...await frameStats(shot) });
        tiles.push(await sharp(shot).flatten({ background: 'black' }).resize(TILE_WIDTH, tileHeight, { fit: 'fill' }).jpeg({ quality: 85 }).toBuffer());
      }
      const sheets = [];
      for (let first = 0; first < tiles.length; first += PER_SHEET) {
        const group = tiles.slice(first, first + PER_SHEET), rows = Math.ceil(group.length / COLUMNS), cell = tileHeight + LABEL_HEIGHT;
        const parts = group.flatMap((tile, i) => {
          const left = (i % COLUMNS) * TILE_WIDTH, top = Math.floor(i / COLUMNS) * cell;
          return [{ input: label(`${times[first + i].toFixed(2)}s`, TILE_WIDTH), left, top }, { input: tile, left, top: top + LABEL_HEIGHT }];
        });
        sheets.push(await sharp({ create: { width: COLUMNS * TILE_WIDTH, height: rows * cell, channels: 3, background: '#111111' } })
          .composite(parts).jpeg({ quality: 85 }).toBuffer());
      }
      return { sheets, frames, flags: sheetFlags(frames), problems: [...tab.problems],
        ...(Object.keys(plan.dropped).length ? { dropped: droppedText(plan.dropped) } : {}) };
    } finally {
      await Promise.allSettled([tab?.close()]);
      await rm(folder, { recursive: true, force: true });
    }
  };
  return { render(args) { const run = queue.then(() => render(args), () => render(args)); queue = run.catch(() => undefined); return run; } };
}
