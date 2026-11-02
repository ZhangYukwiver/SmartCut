import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";

import { createCutout } from "./cutout.mjs";
import { createAiEdit } from "./index.mjs";
import { MediaLibrary } from "./library.mjs";
import { mediaKind, probeMedia } from "./media.mjs";
import { createToolRunner, toolsFor } from "./tools.mjs";

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(infer) {
  const root = await mkdtemp(path.join(tmpdir(), "reellab-cutout-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const library = new MediaLibrary({ directory: path.join(root, "media"), probe: probeMedia, kindOf: mediaKind });
  await library.load();
  const original = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#d2a070" } }).png().toBuffer();
  const item = await library.upload(Readable.from(original), "照片.png");
  const cutout = createCutout({ root, library, infer });
  cleanups.push(() => cutout.close());
  return { root, library, original, item, cutout };
}

// 任务和素材入库检查用确定性的假推理；真实模型另用普通照片做集成验收。
const transparent = async (file, output) => sharp(file).removeAlpha().ensureAlpha(0).png().toFile(output);

it("相同图片并发请求只推理一次，原图保留，透明 PNG 可由 AI 使用，重启后仍复用", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const infer = vi.fn(async (...args) => { await gate; return transparent(...args); });
  const { root, library, original, item, cutout } = await setup(infer);
  expect(cutout.start(item.id).status).toBe("running");
  const first = cutout.remove(item.id);
  const second = cutout.remove(item.id);
  expect(cutout.busy(item.id)).toBe(true);
  release();
  const [one, two] = await Promise.all([first, second]);
  expect(infer).toHaveBeenCalledTimes(1);
  expect(one.id).toBe(two.id);
  expect(one).toMatchObject({ kind: "image", status: "ready", width: 4, height: 3, name: "照片-抠图.png", source: { type: "cutout", mediaId: item.id, transparent: true } });
  expect(await readFile(library.readyPath(item.id))).toEqual(original);
  expect((await sharp(library.readyPath(one.id)).metadata()).hasAlpha).toBe(true);
  expect(cutout.get(item.id).status).toBe("ready");
  const afterRestart = createCutout({ root, library, infer });
  cleanups.push(() => afterRestart.close());
  expect((await afterRestart.remove(item.id)).id).toBe(one.id);
  expect((await afterRestart.remove(one.id)).id).toBe(one.id);
  const onGenerating = vi.fn();
  const run = createToolRunner({ library, cutout: afterRestart, onGenerating });
  const answer = await run("remove_image_background", { media_id: item.id });
  expect(answer).toMatchObject({ changed: true, action: { ok: true }, result: { ok: true, media_id: one.id } });
  expect(onGenerating).toHaveBeenLastCalledWith(null);
  expect(toolsFor().some(tool => tool.function.name === "remove_image_background")).toBe(true);
  expect(infer).toHaveBeenCalledTimes(1);
  expect((await readdir(root)).filter(name => name.startsWith("cutout-"))).toEqual([]);
});

it("失败任务清理临时文件、保留原图，允许重试，队列继续处理后续图片", async () => {
  const infer = vi.fn().mockRejectedValueOnce(new Error("bad inference")).mockImplementation(transparent);
  const { root, library, original, item, cutout } = await setup(infer);
  await expect(cutout.remove(item.id)).rejects.toMatchObject({ code: "cutout_failed" });
  expect(cutout.get(item.id)).toMatchObject({ status: "failed", item: null });
  expect(library.list()).toHaveLength(1);
  expect(await readFile(library.readyPath(item.id))).toEqual(original);
  expect((await readdir(root)).filter(name => name.startsWith("cutout-"))).toEqual([]);
  expect((await cutout.remove(item.id)).status).toBe("ready");
  expect(infer).toHaveBeenCalledTimes(2);
});

it("只接受就绪且大小受限的图片，参数不能作为任意本机路径使用", async () => {
  const infer = vi.fn(transparent);
  const { library, item, cutout } = await setup(infer);
  expect(() => cutout.start("/etc/passwd")).toThrow();
  library.get(item.id).kind = "video";
  expect(() => cutout.start(item.id)).toThrow("只支持图片");
  Object.assign(library.get(item.id), { kind: "image", width: 10000, height: 10000 });
  expect(() => cutout.start(item.id)).toThrow("图片太大");
  Object.assign(library.get(item.id), { width: 4, height: 3, status: "importing" });
  expect(() => cutout.start(item.id)).toThrow("还在导入");
  expect(infer).not.toHaveBeenCalled();
});

it("HTTP 走配对边界，立即回后台进度，阻止处理中删除原图，完成后返回真实素材", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { root, library, item } = await setup(transparent);
  const api = createAiEdit({ dataDirectory: path.join(root, "api"), cutoutInfer: async (...args) => { await gate; return transparent(...args); } });
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (await api.handle(request, response, url)) return;
    if (request.headers.authorization !== "Bearer paired") { response.writeHead(401).end(); return; }
    await api.handle(request, response, url, { paired: true });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { release(); await api.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const source = await api.importFile(library.readyPath(item.id), item.name, { type: "local" });
  const base = `http://127.0.0.1:${server.address().port}/v1/ai-edit/media/${source.id}`;
  const headers = { Authorization: "Bearer paired" };
  expect((await fetch(`${base}/cutout`, { method: "POST" })).status).toBe(401);
  const started = await fetch(`${base}/cutout`, { method: "POST", headers });
  expect(started.status).toBe(202);
  expect((await started.json()).status).toBe("running");
  expect((await fetch(base, { method: "DELETE", headers })).status).toBe(409);
  release();
  let job;
  await vi.waitFor(async () => { job = await (await fetch(`${base}/cutout`, { headers })).json(); expect(job.status).toBe("ready"); });
  expect(job.item.source.mediaId).toBe(source.id);
  const reused = await fetch(`${base}/cutout`, { method: "POST", headers });
  expect(reused.status).toBe(200);
  expect((await reused.json()).item.id).toBe(job.item.id);
});
