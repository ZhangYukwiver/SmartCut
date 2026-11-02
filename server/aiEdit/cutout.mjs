import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Worker } from "node:worker_threads";

import { modelFetch } from "../systemProxy.mjs";
import { AiEditError } from "./library.mjs";

// BiRefNet_lite (MIT), 固定权重版本和校验值；照片只在本机解码、推理，不发送到模型站。
const MODEL = "birefnet-lite-512-962e6796";
const CUTOUT_MODEL = { id: MODEL, label: "抠图", code: "cutout_model_unavailable",
  url: "https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model.onnx",
  bytes: 191877254, sha256: "1cb0fb360dadd15af77c639085d77a9df67db0c64315560c3de005f676345ac2" };
export const MAX_PIXELS = 40_000_000;
export const MAX_BYTES = 50 * 1024 ** 2;

export async function cachedImageModel(root, spec, signal, progress) {
  const directory = path.join(root, "models");
  const file = path.join(directory, `${spec.id}.onnx`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await stat(file).then(info => info.size === spec.bytes, () => false)) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") === spec.sha256) return file;
  }
  const partial = `${file}.${randomBytes(6).toString("hex")}.part`;
  progress(`首次下载${spec.label}模型`, 0);
  try {
    const response = await modelFetch(spec.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]) });
    if (!response.ok || !response.body) throw new Error("model_download_failed");
    let received = 0;
    const hash = createHash("sha256");
    const counter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      if (received > spec.bytes) return callback(new Error("model_size_invalid"));
      hash.update(chunk);
      progress(`首次下载${spec.label}模型`, received / spec.bytes);
      callback(null, chunk);
    } });
    await pipeline(response.body, counter, createWriteStream(partial, { flags: "wx", mode: 0o600 }), { signal });
    if (received !== spec.bytes || hash.digest("hex") !== spec.sha256) throw new Error("model_checksum_invalid");
    await rm(file, { force: true });
    await rename(partial, file);
    return file;
  } catch {
    throw new AiEditError(spec.code, `${spec.label}模型没下载完整，请检查网络后重试（首次需下载约 ${Math.round(spec.bytes / 1e6)}MB，支持系统 HTTP 代理）。`, 503);
  } finally {
    await rm(partial, { force: true });
  }
}

export function runImageWorker(workerData, { signal, progress, workerURL = new URL("./cutoutWorker.mjs", import.meta.url), label = "抠图", code = "cutout" }) {
  // ONNX 的原生 run 会阻塞调用线程；放到 Worker，处理结束即释放模型和原生内存。
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerURL, { workerData: { ...workerData, maxPixels: MAX_PIXELS }, execArgv: [] });
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (error) void worker.terminate();
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(new AiEditError(`${code}_interrupted`, `${label}已停止，请重新打开后再试。`, 409));
    const timeout = setTimeout(() => finish(new AiEditError(`${code}_timeout`, `${label}超过 3 分钟，请缩小图片或关闭其他占用内存的应用后重试。`, 422)), 3 * 60_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.on("message", message => {
      if (message.stage) progress(message.stage);
      else finish(message.error ? new AiEditError(`${code}_failed`, message.error, 422) : null);
    });
    worker.once("error", () => finish(new AiEditError(`${code}_runtime_unavailable`, `本机${label}引擎启动失败，请重新安装应用后再试。`, 503)));
    worker.once("exit", () => { if (!settled) finish(new AiEditError(`${code}_failed`, `${label}进程意外退出，请重试。`, 422)); });
    if (signal.aborted) abort();
  });
}

export function createCutout({ root, library, signal = new AbortController().signal, infer = null }) {
  const jobs = new Map();
  let tail = Promise.resolve();
  let closed = false;
  const snapshot = job => ({ status: job.status, stage: job.stage, progress: job.progress, item: job.item, error: job.error });
  const validate = id => {
    const file = library.readyPath(id);
    const item = library.get(id);
    if (item.kind !== "image") throw new AiEditError("cutout_image_required", "自动抠图只支持图片，请先选择一张照片。", 422);
    if (item.size > MAX_BYTES || item.width * item.height > MAX_PIXELS) throw new AiEditError("cutout_image_too_large", "图片太大，抠图支持 50MB、4000 万像素以内的图片。", 422);
    return { file, item };
  };
  const start = id => {
    if (closed || signal.aborted) throw new AiEditError("cutout_closed", "服务正在关闭，请重新打开后再抠图。", 503);
    const { file, item } = validate(id);
    const found = library.list().find(other => other.status === "ready" && other.source.type === "cutout"
      && other.source.model === MODEL && other.source.mediaId === id);
    if (found || item.source.type === "cutout") {
      const job = { status: "ready", stage: "抠图完成", progress: 1, item: found ?? library.list().find(other => other.id === id), error: null };
      job.promise = Promise.resolve(job.item);
      jobs.set(id, job);
      return snapshot(job);
    }
    if (jobs.get(id)?.status === "running") return snapshot(jobs.get(id));
    library.assertRoom();
    const job = { status: "running", stage: "等待抠图", progress: null, item: null, error: null };
    jobs.set(id, job);
    // ponytail: 同一时间只推理一张，避免多个模型同时占满内存。
    job.promise = tail.catch(() => undefined).then(async () => {
      const progress = (stage, ratio = null) => Object.assign(job, { stage, progress: ratio });
      let directory;
      try {
        signal.throwIfAborted();
        validate(id);
        await mkdir(root, { recursive: true, mode: 0o700 });
        directory = await mkdtemp(path.join(root, "cutout-"));
        const output = path.join(directory, "subject.png");
        if (infer) await infer(file, output, { signal, progress });
        else {
          const model = await cachedImageModel(root, CUTOUT_MODEL, signal, progress);
          await runImageWorker({ model, file, output }, { signal, progress });
        }
        signal.throwIfAborted();
        progress("保存透明图片");
        const result = await library.importFile(output, `${path.parse(item.name).name.slice(0, 170)}-抠图.png`, {
          source: { type: "cutout", mediaId: id, model: MODEL, transparent: true },
        });
        Object.assign(job, { status: "ready", stage: "抠图完成", progress: 1, item: result });
        return result;
      } catch (error) {
        const problem = error instanceof AiEditError ? error : new AiEditError("cutout_failed", "图片抠图失败，请确认图片可正常打开后重试。", 422);
        Object.assign(job, { status: "failed", stage: "抠图失败", progress: null, error: problem.message });
        throw problem;
      } finally {
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });
    // HTTP 先回进度，失败由 GET 取回；立即接住 rejection，避免后台失败使服务退出。
    tail = job.promise.catch(() => undefined);
    return snapshot(job);
  };
  return {
    start,
    get(id) {
      validate(id);
      if (!jobs.has(id)) throw new AiEditError("cutout_not_found", "这张图片还没有抠图任务。", 404);
      return snapshot(jobs.get(id));
    },
    busy: id => jobs.get(id)?.status === "running",
    async remove(id) { start(id); return jobs.get(id).promise; },
    close() {
      closed = true;
    },
  };
}
