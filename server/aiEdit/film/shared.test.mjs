import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createPages, sharedAssetBytes, sharedFilePath, sharedFolderOf } from './pages.mjs';
import { openTab } from './browser.mjs';
import { encodeMp4 } from './encoder.mjs';

vi.mock('./browser.mjs', () => ({ openTab: vi.fn() }));
vi.mock('./encoder.mjs', () => ({ encodeMp4: vi.fn(), writePngMov: vi.fn() }));
const roots = [];
afterEach(async () => { vi.resetAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const PROJECT = 'a'.repeat(32), FOLDER = `_shared-${PROJECT}`;

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'shared-pages-')); roots.push(root);
  const items = [];
  const library = { root, list: () => items, adopt: vi.fn(async (_temp, meta) => ({ id: meta.id, name: meta.name, width: 64, height: 36, source: meta.source })) };
  const pages = createPages({ root, library, provider: {}, files: { urlFor: (_origin, rel) => rel }, getOrigin: () => '' });
  return { root, pages, items, library };
}

it('lets a page whose window.film comes from a shared engine through validation', async () => {
  const { pages } = await fixture();
  await expect(pages.preview({ html: '<p>no film here</p>', times: [0], width: 64, height: 36 })).rejects.toMatchObject({ code: 'page_not_film' });
  openTab.mockResolvedValue({ meta: { duration: 2 }, problems: [], seek: vi.fn(), capture: vi.fn(), close: vi.fn(async () => {}) });
  await expect(pages.preview({ html: `<script type="module">import { scene } from "../${FOLDER}/engine.js"; scene({ color: "#f00" });</script>`, times: [5], width: 64, height: 36 }))
    .rejects.toMatchObject({ code: 'arguments_invalid' }); // 过了内容校验，卡在预览秒数超出时长
});

it('names one shared folder per project and only accepts short text, font and image paths', () => {
  expect(sharedFolderOf(PROJECT)).toBe(FOLDER);
  expect(() => sharedFolderOf('../x')).toThrow('没有这个工程');
  expect(sharedFilePath('scenes/intro.js')).toBe('scenes/intro.js');
  expect(sharedFilePath('fonts/noto-900.woff2')).toBe('fonts/noto-900.woff2');
  for (const bad of ['../x.js', '/abs.js', 'a/b/c/d/e.js', '.hidden.js', 'run.exe', 'a//b.js', '']) expect(() => sharedFilePath(bad), bad).toThrow();
});

it('writes, lists, reads and patches shared files inside the project folder with size limits', async () => {
  const { root, pages } = await fixture();
  expect(await pages.readShared(FOLDER)).toEqual([]);
  expect(await pages.writeShared(FOLDER, 'engine.js', { content: 'const speed = 1;\nconst glow = 2;' })).toEqual({ file: 'engine.js', bytes: 32, created: true });
  await pages.writeShared(FOLDER, 'scenes/a.js', { content: 'scene()' });
  expect(await pages.readShared(FOLDER)).toEqual([{ path: 'engine.js', bytes: 32 }, { path: 'scenes/a.js', bytes: 7 }]);
  const patched = await pages.writeShared(FOLDER, 'engine.js', { patches: [{ find: 'glow = 2', replace: 'glow = 0.4' }] });
  expect(patched).toMatchObject({ created: false });
  expect(await readFile(path.join(root, 'pages', FOLDER, 'engine.js'), 'utf8')).toBe('const speed = 1;\nconst glow = 0.4;');
  await expect(pages.writeShared(FOLDER, 'engine.js', { patches: [{ find: 'const', replace: 'let' }] })).rejects.toMatchObject({ code: 'page_patch_mismatch' });
  await expect(pages.writeShared(FOLDER, 'missing.js', { patches: [{ find: 'a', replace: 'b' }] })).rejects.toMatchObject({ code: 'arguments_invalid' });
  await expect(pages.writeShared(FOLDER, 'engine.js', { content: 'x', patches: [] })).rejects.toMatchObject({ code: 'arguments_invalid' });
  await expect(pages.writeShared(FOLDER, 'big.js', { content: 'x'.repeat(400 * 1024 + 1) })).rejects.toMatchObject({ code: 'shared_file_too_large' });
  await expect(pages.readShared(FOLDER, 'nope.js')).rejects.toMatchObject({ code: 'shared_file_not_found' });
  expect(await pages.readShared(FOLDER, 'scenes/a.js')).toBe('scene()');
});

it('finds the pages that use the shared folder and rerenders one in place with its old duration and transparency', async () => {
  const { root, pages, items, library } = await fixture();
  const uses = 'b'.repeat(16), other = 'c'.repeat(16);
  for (const [id, html] of [[uses, `<script src="../${FOLDER}/engine.js"></script><script>window.film={duration:2,frame(t){}}</script>`], [other, '<script>window.film={duration:2,frame(){}}</script>']]) {
    await mkdir(path.join(root, 'pages', id), { recursive: true });
    await writeFile(path.join(root, 'pages', id, 'index.html'), html);
  }
  await mkdir(path.join(root, 'pages', FOLDER), { recursive: true });
  expect(await pages.dependents(FOLDER)).toEqual([uses]);
  items.push({ id: 'm'.repeat(32), name: '开场', durationUs: 2_000_000, source: { type: 'page', pageId: uses, page: `${uses}/index.html`, transparent: false } });
  const tab = { meta: { duration: 2, width: 64, height: 36 }, problems: [], seek: vi.fn(), capture: vi.fn(async () => Buffer.from('frame')), evaluate: vi.fn(async () => 0), close: vi.fn() };
  openTab.mockResolvedValue(tab);
  encodeMp4.mockImplementation(async ({ count, frame }) => { for (let i = 0; i < count; i++) await frame(i); });
  const result = await pages.rerender(uses, { width: 64, height: 36, fps: 10 });
  expect(result).toMatchObject({ duration: 2, problems: [] });
  expect(encodeMp4.mock.calls[0][0].count).toBe(20);
  expect(library.adopt.mock.calls[0][1]).toMatchObject({ id: 'm'.repeat(32), name: '开场', extension: '.mp4', source: { pageId: uses, transparent: false } });
  await expect(pages.rerender(other, { width: 64, height: 36, fps: 10 })).rejects.toMatchObject({ code: 'page_not_found' });
});

const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(8)]);

it('imports fonts and images as bytes, checks them by content, and keeps text and binary paths apart', async () => {
  const { root, pages } = await fixture();
  expect(await pages.importShared(FOLDER, 'fonts/a.woff2', WOFF2)).toEqual({ file: 'fonts/a.woff2', bytes: 12, created: true });
  expect((await readFile(path.join(root, 'pages', FOLDER, 'fonts/a.woff2'))).equals(WOFF2)).toBe(true);
  expect(await pages.importShared(FOLDER, 'fonts/a.woff2', WOFF2)).toMatchObject({ created: false });
  await expect(pages.importShared(FOLDER, 'fonts/b.woff2', Buffer.from('<!doctype html>'))).rejects.toMatchObject({ code: 'shared_file_mismatch' });
  await expect(pages.importShared(FOLDER, 'engine.js', Buffer.from('x'))).rejects.toMatchObject({ code: 'arguments_invalid' });
  await expect(pages.writeShared(FOLDER, 'fonts/a.woff2', { content: 'x' })).rejects.toMatchObject({ code: 'arguments_invalid' });
  await expect(pages.readShared(FOLDER, 'fonts/a.woff2')).rejects.toMatchObject({ code: 'arguments_invalid' });
  expect((await pages.readShared(FOLDER)).map(file => file.path)).toEqual(['fonts/a.woff2']);
});

it('takes shared assets from library images, listed CDNs and local font files only', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'shared-assets-')); roots.push(root);
  const png = path.join(root, 'a.png'), font = path.join(root, 'a.woff2'), notes = path.join(root, 'notes.txt');
  await writeFile(png, 'png-bytes'); await writeFile(font, WOFF2); await writeFile(notes, 'private');
  const library = { get: id => ({ i: { kind: 'image' }, v: { kind: 'video' } })[id], readyPath: () => png };
  expect((await sharedAssetBytes({ media_id: 'i' }, { library })).toString()).toBe('png-bytes');
  await expect(sharedAssetBytes({ media_id: 'v' }, { library })).rejects.toMatchObject({ code: 'media_not_found' });
  expect((await sharedAssetBytes({ file: font }, {})).equals(WOFF2)).toBe(true);
  await expect(sharedAssetBytes({ file: notes }, {})).rejects.toMatchObject({ code: 'arguments_invalid' });
  await expect(sharedAssetBytes({ file: 'a.woff2' }, {})).rejects.toMatchObject({ code: 'arguments_invalid' });
  await expect(sharedAssetBytes({ file: path.join(root, 'none.woff2') }, {})).rejects.toMatchObject({ code: 'shared_file_not_found' });
  await expect(sharedAssetBytes({ file: font, media_id: 'i' }, { library })).rejects.toMatchObject({ code: 'arguments_invalid' });

  const fetchImpl = vi.fn(async () => new Response(WOFF2));
  expect((await sharedAssetBytes({ url: 'https://cdn.jsdelivr.net/x.woff2' }, { fetchImpl })).equals(WOFF2)).toBe(true);
  for (const url of ['http://cdn.jsdelivr.net/x.woff2', 'https://evil.example/x.woff2', 'https://127.0.0.1/x.woff2', 'nonsense']) {
    await expect(sharedAssetBytes({ url }, { fetchImpl })).rejects.toMatchObject({ code: 'arguments_invalid' });
  }
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(sharedAssetBytes({ url: 'https://unpkg.com/x.woff2' }, { fetchImpl: async () => new Response('', { status: 404 }) })).rejects.toMatchObject({ code: 'shared_download_failed' });
  await expect(sharedAssetBytes({ url: 'https://unpkg.com/x.woff2' }, { fetchImpl: async () => { throw new Error('dns'); } })).rejects.toMatchObject({ code: 'shared_download_failed' });
});

it('shoots one cover per size with the cover flag and removes the temporary page', async () => {
  const { root, pages } = await fixture();
  const shoot = meta => ({ meta, problems: [], seek: vi.fn(), capture: vi.fn(async () => Buffer.from('jpeg')), close: vi.fn() });
  openTab.mockImplementation(async (_provider, _url, { width, height }) => shoot({ duration: 3, width, height }));
  const shots = [{ aspect: '16:9', width: 64, height: 36 }, { aspect: '3:4', width: 36, height: 48 }];
  const images = await pages.still({ html: '<script>window.film={duration:3,frame(){}}</script>', time: 1, shots });
  expect(images.map(({ aspect, width, height, problems }) => [aspect, width, height, problems])).toEqual([['16:9', 64, 36, []], ['3:4', 36, 48, []]]);
  expect(openTab.mock.calls[1][1]).toMatch(/^pages\/_preview-[0-9a-f]{16}\/index\.html\?cover=3%3A4$/u);
  expect((await readdir(path.join(root, 'pages'))).filter(name => name.startsWith('_preview-'))).toEqual([]);

  // 页面写死了尺寸出不了别的比例，要说出来；时刻过了页面时长就拒绝
  openTab.mockImplementation(async () => shoot({ duration: 3, width: 64, height: 36 }));
  const [fixed] = await pages.still({ html: '<script>window.film={duration:3,frame(){}}</script>', time: 1, shots: [shots[1]] });
  expect(fixed.problems[0]).toContain('写死');
  await expect(pages.still({ html: '<script>window.film={duration:3,frame(){}}</script>', time: 3, shots })).rejects.toMatchObject({ code: 'arguments_invalid' });
  await expect(pages.still({ pageId: 'd'.repeat(16), shots })).rejects.toMatchObject({ code: 'page_not_found' });
});
