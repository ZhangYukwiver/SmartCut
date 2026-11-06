import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { openTab } from './browser.mjs';
import { createTimelineSheets, frameStats, sheetFlags, sheetTimes } from './timelineSheet.mjs';

vi.mock('./browser.mjs', () => ({ openTab: vi.fn() }));
const roots = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('spreads sample times over the requested range and refuses empty or reversed ranges', () => {
  expect(sheetTimes({ duration: 10, count: 4 })).toEqual([1.25, 3.75, 6.25, 8.75]);
  expect(sheetTimes({ duration: 10, start: 2, end: 4, count: 2 })).toEqual([2.5, 3.5]);
  expect(() => sheetTimes({ duration: 0 })).toThrow('时间线是空的');
  expect(() => sheetTimes({ duration: 10, start: 6, end: 3 })).toThrow('起止时间不对');
  expect(() => sheetTimes({ duration: 10, count: 49 })).toThrow('最多看 48 帧');
});

it('measures brightness and flags black, glaring and jumping frames', async () => {
  const solid = color => sharp({ create: { width: 32, height: 18, channels: 3, background: color } }).png().toBuffer();
  const black = await frameStats(await solid('#000000')), white = await frameStats(await solid('#ffffff')), gray = await frameStats(await solid('#606060'));
  expect(black).toMatchObject({ luma: 0, dark: 1, bright: 0 });
  expect(white).toMatchObject({ luma: 1, bright: 1, dark: 0 });
  expect(gray.luma).toBeCloseTo(0.376, 2);
  const flags = sheetFlags([{ time: 1, ...gray }, { time: 2, ...black }, { time: 3, ...white }]);
  expect(flags.map(f => f.issue)).toEqual(['几乎全黑', expect.stringContaining('亮度跳变'), '大面积过亮，可能刺眼', expect.stringContaining('亮度跳变')]);
});

it('composites the whole timeline once, samples each time and tiles labelled frames without touching the project', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'timeline-sheet-')); roots.push(root);
  await mkdir(path.join(root, 'media'));
  const video = path.join(root, 'media', 'c'.repeat(32) + '.mp4'); await writeFile(video, 'video');
  const library = { idForPath: () => 'v', get: () => ({ id: 'v', kind: 'video', width: 64, height: 36 }), readyPath: () => video };
  const project = { canvas: { width: 64, height: 36, fps: 30 }, tracks: [
    { track_type: 'video', segments: [{ id: 'clip', kind: 'video', path: video, timeline: { start_us: 0, duration_us: 10e6 }, source: { start_us: 0, duration_us: 10e6 } }] },
  ] };
  const png = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#336699' } }).png().toBuffer();
  const seeks = [];
  let film = '';
  openTab.mockImplementation(async (_provider, rel, options) => {
    film = await readFile(path.join(root, rel), 'utf8');
    expect(options).toMatchObject({ width: 64, height: 36 });
    return { meta: { duration: 10 }, problems: [], seek: async t => seeks.push(t), capture: async () => png, close: vi.fn() };
  });
  const sheets = createTimelineSheets({ root, library, provider: {}, files: { urlFor: (_, rel) => rel }, getOrigin: () => '' });
  const before = JSON.stringify(project);
  const times = Array.from({ length: 30 }, (_, i) => i * 0.3 + 0.1);
  const result = await sheets.render({ sessionId: 'a'.repeat(32), project, times });
  expect(film).toContain('<video');
  expect(seeks).toEqual(times);
  expect(result.sheets).toHaveLength(2);
  expect(await sharp(result.sheets[0]).metadata()).toMatchObject({ width: 1920, height: 4 * (180 + 26) });
  expect(await sharp(result.sheets[1]).metadata()).toMatchObject({ width: 1920, height: 1 * (180 + 26) });
  expect(result.frames[0]).toMatchObject({ time: 0.1, dark: 0, bright: 0 });
  expect(result.flags).toEqual([]);
  expect(JSON.stringify(project)).toBe(before);
  expect(await readdir(path.join(root, 'renders', `${'a'.repeat(32)}-review`))).toEqual([]);
  await expect(sheets.render({ sessionId: 'a'.repeat(32), project, times: [2, 1] })).rejects.toMatchObject({ code: 'arguments_invalid' });
}, 15_000);
