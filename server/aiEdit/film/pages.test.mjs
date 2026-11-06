import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, it, vi } from 'vitest';
import { createPages, patchPageHtml } from './pages.mjs';
import { openTab } from './browser.mjs';

vi.mock('./browser.mjs', () => ({ openTab: vi.fn() }));
const roots = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('patches only unique literal text, preserves other drawing code and refuses ambiguous or stale patches', () => {
  const original = '<script>window.film={duration:10.2,frame(t){drawRoof();drawFloor();}}</script>';
  const changed = patchPageHtml(original, [{ find: 'drawFloor();', replace: 'drawFloorVideo("$&");' }]);
  expect(changed).toBe('<script>window.film={duration:10.2,frame(t){drawRoof();drawFloorVideo("$&");}}</script>');
  expect(original).toContain('drawFloor();');
  expect(() => patchPageHtml(original, [{ find: 'drawFloorVideo();', replace: '' }])).toThrow('原文未找到或不唯一');
  expect(() => patchPageHtml(original, [{ find: 'draw', replace: 'paint' }])).toThrow('原文未找到或不唯一');
  expect(() => patchPageHtml(null, [{ find: 'drawFloor();', replace: '' }])).toThrow('已有 page_id');
  expect(() => patchPageHtml(original, [{ find: '', replace: '' }])).toThrow('非空 find');
});

async function fixture({ unstable = false, controller } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'page-preview-')); roots.push(root);
  const dark = await sharp({ create: { width: 32, height: 24, channels: 3, background: 'black' } }).png().toBuffer();
  const green = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#22cc44' } }).png().toBuffer();
  const seeks = []; let time = 0, shots = 0;
  const tab = { meta: { duration: 10.2 }, problems: [], close: vi.fn(async () => {}),
    evaluate:async()=>({applicable:false,status:'pass',reports:[]}),
    seek: async t => { time = t; seeks.push(t); },
    capture: async () => { controller?.abort(); shots++; return time === 0 || (unstable && shots > 2) ? dark : green; } };
  openTab.mockResolvedValue(tab);
  const library = { adopt: vi.fn() };
  const pages = createPages({ root, library, provider: {}, files: { urlFor: (_origin, rel) => rel }, getOrigin: () => '' });
  const html = '<img src="../../media/photo.png"><script>window.film={duration:10.2,frame(t){}}</script>';
  return { root, pages, html, seeks, tab, library };
}

it('samples real times and crops without encoding, adopting media or touching a formal page', async () => {
  const f = await fixture();
  const formal = path.join(f.pages.directory, '0123456789abcdef'); await mkdir(formal, { recursive: true });
  await writeFile(path.join(formal, 'index.html'), 'unchanged');
  const result = await f.pages.preview({ html: f.html, pageId: '0123456789abcdef', times: [0, 7], width: 32, height: 24, crop: [.25, 0, .5, 1] });
  expect(f.seeks).toEqual([0, 7, 7, 0]);
  expect(result.diagnostics).toEqual([{ time: 0, nearly_black: true, unstable: false, repeat_difference: 0 }, { time: 7, nearly_black: false, unstable: false, repeat_difference: 0 }]);
  expect(result.duration).toBe(10.2);
  const image = await sharp(Buffer.from(result.images[1].split(',')[1], 'base64')).metadata();
  expect([image.width, image.height]).toEqual([16, 24]);
  expect(f.library.adopt).not.toHaveBeenCalled();
  expect(openTab).toHaveBeenCalledTimes(1); // 没有编码器页面。
  expect(openTab.mock.calls[0][1]).toMatch(/^pages\/0123456789abcdef\/_preview-.*\.html$/u);
  expect(f.tab.close).toHaveBeenCalledOnce();
  expect(await readdir(f.pages.directory)).toEqual(['0123456789abcdef']);
  expect(await readFile(path.join(formal, 'index.html'), 'utf8')).toBe('unchanged');
  expect(await readdir(formal)).toEqual(['index.html']);
});

it('reports unstable frames and cleans up when a frame is out of range or cancelled', async () => {
  const f = await fixture({ unstable: true });
  const result = await f.pages.preview({ html: f.html, times: [1, 7], width: 32, height: 24 });
  expect(result.diagnostics.every(frame => frame.unstable)).toBe(true);
  await expect(f.pages.preview({ html: f.html, times: [10.2] })).rejects.toMatchObject({ code: 'arguments_invalid' });
  expect(await readdir(f.pages.directory)).toEqual([]);
  const controller = new AbortController(), cancelled = await fixture({ controller });
  await expect(cancelled.pages.preview({ html: cancelled.html, times: [1], signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled.tab.close).toHaveBeenCalledOnce();
  expect(await readdir(cancelled.pages.directory)).toEqual([]);
});

it('detects changing transparency even when both mask screenshots flatten to black', async () => {
  const f = await fixture();
  const opaque = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#000000ff' } }).png().toBuffer();
  const clear = await sharp({ create: { width: 32, height: 24, channels: 4, background: '#00000000' } }).png().toBuffer();
  let shots = 0; f.tab.capture = async () => ++shots === 1 ? opaque : clear;
  const result = await f.pages.preview({ html: f.html, times: [1], width: 32, height: 24, transparent: true });
  expect(result.diagnostics[0]).toMatchObject({ nearly_black: true, unstable: true, repeat_difference: .25 });
});
