import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { AiEditError } from '../library.mjs';
import { projectToFilm, droppedText } from './filmFile.mjs';

export const CANDIDATE_FILE = '_review-candidate.html';
const fail = message => { throw new AiEditError('review_composition_required', message, 422); };
export const assetStamp = async file => { const s = await stat(file); return [file, s.size, s.mtimeMs]; };

// 包括页面相对素材和共用脚本；临时预览不参与缓存指纹。
export async function pageAssetStamps(root, pageId, html) {
  const assets = [];
  for (const [ref] of String(html ?? '').matchAll(/(?:\.\.\/)+media\/[a-f0-9]{32}\.[a-z0-9]+/giu)) {
    const file = path.resolve(root, 'pages', pageId ?? '_review', ref);
    if (!file.startsWith(path.join(root, 'media') + path.sep)) fail('页面素材路径无效。');
    assets.push(await assetStamp(file));
  }
  const folders = new Set(pageId ? [path.join(root, 'pages', pageId)] : []);
  for (const [, rel] of String(html ?? '').matchAll(/\.\.\/(_skills\/[\w.-]+|_[\w.-]+)\//gu)) folders.add(path.join(root, 'pages', rel));
  const scan = async folder => {
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('_preview-') || entry.name.startsWith('_review-') || entry.name.endsWith('.tmp')) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) await scan(file);
      else if (entry.isFile()) assets.push(await assetStamp(file));
    }
  };
  for (const folder of folders) await scan(folder);
  return assets;
}

// 与正式导出共用合成器，仅替换目标页的临时引用；时间线及原始页不改写。
export async function reviewComposition({ root, library, project, pageId, html, clipId, start, duration, timeline = false }) {
  if (!pageId && !timeline) return null;
  const mediaOf = file => library.get(library.idForPath(file));
  const segments = (project.tracks ?? []).flatMap(t => t.segments ?? []);
  const matches = pageId ? segments.filter(s => s.path && mediaOf(s.path)?.source?.pageId === pageId) : [];
  if (!timeline && !matches.length) {
    if (clipId) fail('指定片段没有使用这份候选页面。');
    return null;
  }
  const target = clipId ? matches.find(s => s.id === clipId) : matches.length === 1 ? matches[0] : null;
  if (!timeline && !target) fail('同一页面在时间线出现多次，请提供 clip_id，明确复核哪一处合成。');
  // film.html 使用毫秒时钟；网页片段在当前原生合成器中不变速。
  const ms = us => Math.round(us / 1000) / 1000;
  const at = ms(target?.timeline.start_us ?? 0), from = ms(target?.source?.start_us ?? 0);
  const end = target ? ms(target.timeline.start_us + target.timeline.duration_us)
    : Math.max(0, ...segments.map(s => (s.timeline.start_us + s.timeline.duration_us) / 1e6));
  const timelineStart = at + start - from;
  if (timelineStart < at - 1e-6 || timelineStart + duration > end + 1e-6) fail('页面复核区间不在指定时间线片段内，请缩短区间或选择对应 clip_id。');
  const active = { ...project, tracks: project.tracks.map(t => ({ ...t, segments: (t.segments ?? []).filter(s =>
    s.timeline.start_us / 1e6 < timelineStart + duration && (s.timeline.start_us + s.timeline.duration_us) / 1e6 > timelineStart) })) };
  const mediaFiles = new Set(), pages = new Set();
  const plan = projectToFilm(active, {
    mediaOf,
    srcFor: (item, file) => {
      if (!item) fail('时间线素材缺失，不能用黑底替代后判断合成通过。');
      const ready = library.readyPath(item.id);
      if (!ready?.startsWith(path.join(root, 'media') + path.sep)) fail('时间线素材来源无效。');
      mediaFiles.add(ready);
      return `../../../media/${path.basename(ready)}`;
    },
    pageSrc: rel => {
      const normalized = path.posix.normalize(rel);
      if (normalized.startsWith('../') || path.isAbsolute(normalized)) fail('时间线网页路径无效。');
      pages.add(normalized);
      return `../../../pages/${path.posix.dirname(normalized) === pageId ? `${pageId}/${CANDIDATE_FILE}` : normalized}`;
    },
    textSrc: s => `text/${s.id}.html`,
  });
  if (Object.keys(plan.dropped).length) throw new AiEditError('review_composition_unsupported', `当前区间含原生合成器未支持的效果，不能据此判定通过：${droppedText(plan.dropped)}`, 422);
  const assets = await Promise.all([...mediaFiles].sort().map(assetStamp));
  for (const rel of [...pages].sort()) {
    const html = await readFile(path.join(root, 'pages', rel), 'utf8');
    assets.push(...await pageAssetStamps(root, path.posix.dirname(rel), html));
  }
  const candidateAssets = html === undefined ? [] : await pageAssetStamps(root, pageId, html);
  const key = createHash('sha256').update(JSON.stringify({ version: 1, plan, assets, html, candidateAssets, clipId: target?.id, timelineStart, duration })).digest('hex');
  return { ...plan, key, clipId: target?.id, start: timelineStart };
}
