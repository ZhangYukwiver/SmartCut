import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { cachedImageModel } from "./cutout.mjs";
import { createAiEdit } from "./index.mjs";
import { createImageRefine } from "./imageRefine.mjs";
import { refineImage } from "./imageRefineWorker.mjs";
import { MediaLibrary } from "./library.mjs";
import { mediaKind, probeMedia } from "./media.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function folder() {
  const root = await mkdtemp(path.join(tmpdir(), "reellab-image-refine-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true })); return root;
}
async function serve(handler) {
  const server = createServer(handler); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}
const predict = async () => {
  const output = new Float32Array(512 * 512 * 3);
  output.fill(20, 0, 512 * 512); output.fill(50, 512 * 512, 512 * 512 * 2); output.fill(80, 512 * 512 * 2);
  return output;
};
async function fixture() {
  const root = await folder(), width = 40, height = 30;
  const data = Buffer.alloc(width * height * 4), selected = Buffer.alloc(data.length);
  for (let i = 0; i < width * height; i += 1) {
    data[i * 4] = i % 256; data[i * 4 + 1] = 120; data[i * 4 + 2] = 200; data[i * 4 + 3] = i % 3 === 0 ? 0 : 200;
    if (i % width >= 10 && i % width < 20 && Math.floor(i / width) >= 10 && Math.floor(i / width) < 15) selected[i * 4 + 3] = 255;
  }
  const image = await sharp(data, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const mask = await sharp(selected, { raw: { width, height, channels: 4 } }).png().toBuffer();
  const input = path.join(root, "input.png"), selection = path.join(root, "mask.png"), output = path.join(root, "output.png");
  await writeFile(input, image); await writeFile(selection, mask);
  return { root, width, height, data, selected, image, mask, task: { image: input, reference: input, mask: selection, output } };
}

it("修复只改变选区 RGB，保留每个像素的 alpha、选区外像素和原图", async () => {
  const f = await fixture();
  await refineImage(f.task, { infer: predict });
  const output = await sharp(f.task.output).raw().toBuffer();
  for (let i = 0; i < f.width * f.height; i += 1) {
    expect(output[i * 4 + 3]).toBe(f.data[i * 4 + 3]);
    const expected = f.selected[i * 4 + 3] && f.data[i * 4 + 3] ? [20, 50, 80] : [...f.data.subarray(i * 4, i * 4 + 3)];
    expect([...output.subarray(i * 4, i * 4 + 3)]).toEqual(expected);
  }
  expect(await readFile(f.task.image)).toEqual(f.image);
});

it("AI 矩形修复复用本地处理器，只修改选区并保留原图、来源与取消能力", async () => {
  const f = await fixture();
  const library = new MediaLibrary({ directory: path.join(f.root, 'media'), probe: probeMedia, kindOf: mediaKind }); await library.load();
  const source = await library.upload(Readable.from(f.image), '原图.png');
  const processImage = vi.fn((task, options) => refineImage(task, { infer: predict, progress: options.progress }));
  const manager = createImageRefine({ root: f.root, library, processImage });
  cleanups.push(() => manager.close());
  const item = await manager.repairRegions(source.id, [[.25, 1 / 3, .25, 1 / 6]]);
  expect(item.source).toMatchObject({ operation: 'repair', mediaId: source.id, baseId: source.id });
  const output = await sharp(library.readyPath(item.id)).raw().toBuffer();
  for (let y = 0; y < f.height; y++) for (let x = 0; x < f.width; x++) {
    const i = (y * f.width + x) * 4;
    expect(output[i + 3]).toBe(f.data[i + 3]);
    const repaired = x >= 10 && x < 20 && y >= 10 && y < 15 && f.data[i + 3];
    expect([...output.subarray(i, i + 3)]).toEqual(repaired ? [20, 50, 80] : [...f.data.subarray(i, i + 3)]);
  }
  expect(await readFile(library.readyPath(source.id))).toEqual(f.image);
  const controller = new AbortController(); controller.abort();
  await expect(manager.repairRegions(source.id, [[.1, .1, .2, .2]], { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  for (const regions of [[], [[.9, 0, .2, .2]], [[0, 0, 1, 1]], [[NaN, 0, .2, .2]]]) {
    await expect(manager.repairRegions(source.id, regions)).rejects.toMatchObject({ code: 'arguments_invalid' });
  }
  expect(processImage).toHaveBeenCalledTimes(1);
  expect(manager.busy(source.id)).toBe(false);
  expect(library.list()).toHaveLength(2);
});

it("空选区、尺寸错误和无透明度的选区在推理前拒绝", async () => {
  const f = await fixture(), infer = vi.fn(predict);
  const empty = await sharp({ create: { width: 40, height: 30, channels: 4, background: "#00000000" } }).png().toBuffer();
  await writeFile(f.task.mask, empty);
  await expect(refineImage(f.task, { infer })).rejects.toThrow("先涂");
  await sharp({ create: { width: 20, height: 20, channels: 4, background: "#ffffffff" } }).png().toFile(f.task.mask);
  await expect(refineImage(f.task, { infer })).rejects.toThrow("同尺寸");
  await sharp({ create: { width: 40, height: 30, channels: 3, background: "white" } }).png().toFile(f.task.mask);
  await expect(refineImage(f.task, { infer })).rejects.toThrow("透明度");
  expect(infer).not.toHaveBeenCalled();
});

it("另存精修保持完整 RGBA，JPEG 的 EXIF 旋转按显示尺寸验证", async () => {
  const f = await fixture();
  await refineImage({ ...f.task, mask: null });
  expect(await sharp(f.task.output).raw().toBuffer()).toEqual(f.data);
  const jpeg = path.join(f.root, "rotated.jpg");
  await sharp({ create: { width: 30, height: 40, channels: 3, background: "white" } }).withMetadata({ orientation: 6 }).jpeg().toFile(jpeg);
  await expect(refineImage({ ...f.task, mask: null, reference: jpeg })).resolves.toBeUndefined();
});

it("任务保存为独立素材，失败可重试、清理临时文件，原素材保持不变", async () => {
  const f = await fixture();
  const library = new MediaLibrary({ directory: path.join(f.root, "media"), probe: probeMedia, kindOf: mediaKind }); await library.load();
  const source = await library.upload(Readable.from(f.image), "照片.png");
  const manager = createImageRefine({ root: f.root, library, processImage: (task) => refineImage(task, { infer: predict }) });
  cleanups.push(() => manager.close());
  const saved = await manager.save(source.id, { image: f.image.toString("base64") });
  expect(saved.id).not.toBe(source.id); expect(saved.source).toMatchObject({ type: "image_edit", mediaId: source.id, baseId: source.id, operation: "mask" });
  const body = { image: f.image.toString("base64"), mask: f.mask.toString("base64") };
  const job = manager.start(saved.id, body); expect(manager.busy(saved.id)).toBe(true);
  await vi.waitFor(() => expect(manager.get(saved.id, job.id).status).toBe("ready"));
  expect(manager.get(saved.id, job.id).item.source).toMatchObject({ mediaId: source.id, baseId: saved.id, operation: "repair" });
  expect(manager.busy(saved.id)).toBe(false);
  expect(() => manager.get(source.id, job.id)).toThrow("没有这条");
  await library.remove(saved.id);
  expect(manager.get(saved.id, job.id).status).toBe("ready");
  expect(() => manager.start(source.id, { ...body, mask: "not-png" })).toThrow("PNG");
  expect(() => manager.start("/etc/passwd", body)).toThrow();
  expect(await readFile(library.readyPath(source.id))).toEqual(f.image);
  expect((await readdir(f.root)).filter(name => name.startsWith("image-refine-"))).toEqual([]);
});

it("保存与修复共用有界队列，同一时刻最多运行一个处理器", async () => {
  const f = await fixture(), library = new MediaLibrary({ directory: path.join(f.root, "media"), probe: probeMedia, kindOf: mediaKind }); await library.load();
  const source = await library.upload(Readable.from(f.image), "照片.png");
  let release; const gate = new Promise(resolve => { release = resolve; }); let active = 0, peak = 0;
  const manager = createImageRefine({ root: f.root, library, processImage: async task => { active += 1; peak = Math.max(peak, active); await gate; try { await refineImage(task, { infer: predict }); } finally { active -= 1; } } });
  cleanups.push(() => manager.close());
  const first = manager.save(source.id, { image: f.image.toString("base64") });
  const second = manager.save(source.id, { image: f.image.toString("base64") });
  await expect(manager.save(source.id, { image: f.image.toString("base64") })).rejects.toMatchObject({ code: "repair_busy" });
  release(); await Promise.all([first, second]);
  expect(peak).toBe(1); expect(manager.busy(source.id)).toBe(false);
});

it("HTTP 精修和修复都要求配对；后台任务处理中保护源素材，结束后可读取结果", async () => {
  const f = await fixture(); let release; const gate = new Promise(resolve => { release = resolve; });
  const api = createAiEdit({ dataDirectory: path.join(f.root, "api"), imageRefineProcess: async task => { if (task.mask) await gate; await refineImage(task, { infer: predict }); } });
  cleanups.push(async () => { release(); await api.close(); });
  const source = await api.importFile(f.task.image, "照片.png", { type: "local" });
  const base = await serve(async (request, response) => {
    const url = new URL(request.url, "http://localhost"); if (await api.handle(request, response, url)) return;
    if (request.headers.authorization !== "Bearer paired") { response.writeHead(401).end(); return; }
    await api.handle(request, response, url, { paired: true });
  });
  const endpoint = `${base}/v1/ai-edit/media/${source.id}`, headers = { Authorization: "Bearer paired", "Content-Type": "application/json" };
  for (const action of ["image-refine", "image-repair"]) expect((await fetch(`${endpoint}/${action}`, { method: "POST" })).status).toBe(401);
  const saved = await fetch(`${endpoint}/image-refine`, { method: "POST", headers, body: JSON.stringify({ image: f.image.toString("base64") }) }); expect(saved.status).toBe(201);
  const response = await fetch(`${endpoint}/image-repair`, { method: "POST", headers, body: JSON.stringify({ image: f.image.toString("base64"), mask: f.mask.toString("base64") }) }); expect(response.status).toBe(202);
  const job = await response.json(); expect((await fetch(endpoint, { method: "DELETE", headers })).status).toBe(409);
  release(); await vi.waitFor(async () => expect((await (await fetch(`${endpoint}/image-repair/${job.id}`, { headers })).json()).status).toBe("ready"));
});

it("模型下载验证固定 SHA，缓存被改坏后重新下载，失败不留下半成品", async () => {
  const root = await folder(), bytes = Buffer.from("verified model bytes"); let calls = 0, corrupt = false;
  const base = await serve((_request, response) => { calls += 1; response.end(corrupt ? Buffer.from("wrong model bytes!!!") : bytes); });
  const spec = { id: "fixture-model", label: "测试", code: "model_failed", url: base, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  const signal = new AbortController().signal;
  const file = await cachedImageModel(root, spec, signal, () => {});
  expect(await cachedImageModel(root, spec, signal, () => {})).toBe(file); expect(calls).toBe(1);
  await writeFile(file, Buffer.alloc(bytes.length));
  expect(await cachedImageModel(root, spec, signal, () => {})).toBe(file); expect(calls).toBe(2);
  await writeFile(file, Buffer.alloc(bytes.length)); corrupt = true;
  await expect(cachedImageModel(root, spec, signal, () => {})).rejects.toMatchObject({ code: "model_failed" });
  expect((await readdir(path.dirname(file))).filter(name => name.endsWith(".part"))).toEqual([]);
});
