import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { openTab } from './browser.mjs';
import { encodeMp4 } from './encoder.mjs';
import { createReviewClips } from './reviewClips.mjs';
vi.mock('./browser.mjs', () => ({ openTab: vi.fn() }));
vi.mock('./encoder.mjs', () => ({ encodeMp4: vi.fn() }));
const roots = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('renders only the requested interval at the original clock, caches the clip and preserves the formal page', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-clip-')); roots.push(root);
  const pageId = 'b'.repeat(16), folder = path.join(root, 'pages', pageId); await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'index.html'), 'original');
  const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#339966' } }).png().toBuffer();
  const times = [], tab = { meta: { duration: 10.2 }, problems: [], seek: async t => times.push(t), capture: async () => png, close: vi.fn() };
  openTab.mockResolvedValue(tab);
  encodeMp4.mockImplementation(async ({ file, frame, count }) => { for (let i = 0; i < count; i++) await frame(i); await writeFile(file, 'encoded'); });
  const clips = createReviewClips({ root, provider: {}, files: { urlFor: (_, rel) => rel }, getOrigin: () => '' });
  const args = { sessionId: 'a'.repeat(32), pageId, html: '<script>window.film={duration:10.2,frame(t){}}</script>', width: 64, height: 36, start: 3.8, duration: 2.2, crop: [0, 0, 1, 1] };
  const result = await clips.render(args);
  expect(times).toHaveLength(22); expect(times[0]).toBe(3.8); expect(times.at(-1)).toBeCloseTo(5.9);
  expect(result.duration).toBe(2.2);
  expect(await readFile(path.join(folder, 'index.html'), 'utf8')).toBe('original');
  expect((await clips.render(args)).cached).toBe(true); expect(encodeMp4).toHaveBeenCalledTimes(1);
  await expect(clips.render({ ...args, start: 10 })).rejects.toMatchObject({ code: 'arguments_invalid' });
  expect(encodeMp4).toHaveBeenCalledTimes(1);
});

it('composites the unchanged base video with a temporary overlay at the timeline clock and invalidates changed dependencies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'review-scene-')); roots.push(root);
  const pageId = 'b'.repeat(16), pageDir = path.join(root, 'pages', pageId);
  await mkdir(pageDir, { recursive: true }); await mkdir(path.join(root, 'media'));
  await writeFile(path.join(pageDir, 'index.html'), 'original mask');
  const video = path.join(root, 'media', 'c'.repeat(32) + '.mp4'); await writeFile(video, 'base-video');
  const maskFile = path.join(root, 'media', 'd'.repeat(32) + '.mov');
  const base = { id: 'base', kind: 'video', width: 64, height: 36 };
  const mask = { id: 'mask', kind: 'video', width: 64, height: 36, source: { type: 'page', pageId, page: `${pageId}/index.html`, transparent: true } };
  const library = { idForPath: file => file === video ? 'base' : 'mask', get: id => id === 'base' ? base : mask, readyPath: id => id === 'base' ? video : maskFile };
  const project = { canvas: { width: 64, height: 36, fps: 30 }, tracks: [
    { track_type: 'video', segments: [{ id: 'base-clip', kind: 'video', path: video, timeline: { start_us: 0, duration_us: 10e6 }, source: { start_us: .4e6, duration_us: 10e6 } }] },
    { track_type: 'video', segments: [{ id: 'mask-clip', kind: 'video', path: maskFile, timeline: { start_us: 5e6, duration_us: 3e6 }, source: { start_us: 1e6, duration_us: 3e6 } }] },
  ] };
  const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#339966' } }).png().toBuffer();
  const times = [], films = [];
  const tab = { meta: { duration: 10 }, problems: [], seek: async t => times.push(t), capture: async () => png, close: vi.fn() };
  openTab.mockImplementation(async (_, rel) => {
    if (rel.endsWith('/film.html')) {
      const film = await readFile(path.join(root, rel), 'utf8'); films.push(film);
      expect(film).toContain('<video'); expect(film).toContain('<iframe');
      expect(film).toContain('#t=0.4,10.4'); expect(film).toContain('#t=1,4');
      expect(film).not.toContain('/index.html');
    }
    return tab;
  });
  encodeMp4.mockImplementation(async ({ file, frame, count }) => { for (let i = 0; i < count; i++) await frame(i); await writeFile(file, 'encoded'); });
  const clips = createReviewClips({ root, library, provider: {}, files: { urlFor: (_, rel) => rel }, getOrigin: () => '' });
  const args = { sessionId: 'a'.repeat(32), pageId, html: 'candidate mask', project, width: 64, height: 36, start: 1.2, duration: 1, fps: 10 };
  const before = JSON.stringify(project);
  const first = await clips.render(args);
  expect(first.composition).toMatchObject({ clipId: 'mask-clip', start: 5.2 });
  expect(times[0]).toBe(5.2); expect(times.at(-1)).toBeCloseTo(6.1);
  expect((await clips.render(args)).cached).toBe(true);
  await writeFile(video, 'changed base video');
  const changed = await clips.render(args);
  expect(changed.cached).toBe(false); expect(changed.composition.key).not.toBe(first.composition.key);
  expect(films).toHaveLength(2);
  expect(await readFile(path.join(pageDir, 'index.html'), 'utf8')).toBe('original mask');
  expect(await readdir(pageDir)).toEqual(['index.html']); expect(JSON.stringify(project)).toBe(before);
  project.tracks[1].segments.push({ ...project.tracks[1].segments[0], id: 'other-mask' });
  await expect(clips.composition(args)).rejects.toMatchObject({ code: 'review_composition_required' });
  expect(await clips.composition({ ...args, clipId: 'mask-clip' })).toBeTruthy();
  project.tracks[0].segments[0].filters = ['unsupported'];
  await expect(clips.composition({ ...args, clipId: 'mask-clip' })).rejects.toMatchObject({ code: 'review_composition_unsupported' });
});
