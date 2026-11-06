import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { cachedImageModel, MAX_BYTES, MAX_PIXELS, runImageWorker } from "./cutout.mjs";
import { AiEditError, isMediaId } from "./library.mjs";

const MODEL = { id: "lama-fp32-c3c0c9e4", label: "去字修复", code: "repair_model_unavailable",
  url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
  bytes: 208044816, sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6" };
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function png(value) {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_BYTES * 4 / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) throw new AiEditError("image_edit_invalid", "精修图片或选区不是有效的 PNG，或者超过 50MB。", 422);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > MAX_BYTES || !bytes.subarray(0, 8).equals(PNG)) throw new AiEditError("image_edit_invalid", "精修图片或选区不是有效的 PNG。", 422);
  return bytes;
}

export function createImageRefine({ root, library, signal = new AbortController().signal, processImage = null }) {
  const jobs = new Map(), active = new Map();
  let tail = Promise.resolve(), closed = false;
  const snapshot = job => ({ id: job.id, status: job.status, stage: job.stage, progress: job.progress, item: job.item, error: job.error });
  const lock = id => active.set(id, (active.get(id) ?? 0) + 1);
  const unlock = id => { const count = (active.get(id) ?? 1) - 1; if (count) active.set(id, count); else active.delete(id); };
  const assertCapacity = () => {
    if ([...active.values()].reduce((sum, count) => sum + count, 0) >= 2) throw new AiEditError("repair_busy", "还有图片正在精修，完成后再试。", 409);
  };
  const validate = id => {
    if (closed || signal.aborted) throw new AiEditError("image_edit_closed", "服务正在关闭，请重新打开后再编辑图片。", 503);
    const reference = library.readyPath(id), item = library.get(id);
    if (item.kind !== "image" || item.size > MAX_BYTES || item.width * item.height > MAX_PIXELS) throw new AiEditError("image_edit_invalid", "请选择 50MB、4000 万像素以内的就绪图片。", 422);
    return { reference, item };
  };
  async function run(id, image, mask, progress, taskSignal = signal) {
    taskSignal.throwIfAborted();
    const { reference, item } = validate(id);
    let directory;
    try {
      library.assertRoom();
      await mkdir(root, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(path.join(root, "image-refine-"));
      const input = path.join(directory, "input.png"), output = path.join(directory, "output.png"), selection = mask ? path.join(directory, "mask.png") : null;
      await writeFile(input, image, { mode: 0o600 });
      if (selection) await writeFile(selection, mask, { mode: 0o600 });
      let model = null;
      if (mask && !processImage) model = await cachedImageModel(root, MODEL, taskSignal, progress);
      const task = { image: input, mask: selection, reference, output, model, maxPixels: MAX_PIXELS };
      if (processImage) await processImage(task, { signal: taskSignal, progress });
      else await runImageWorker(task, { signal: taskSignal, progress, workerURL: new URL("./imageRefineWorker.mjs", import.meta.url), label: mask ? "去字修复" : "图片精修", code: "image_edit" });
      taskSignal.throwIfAborted();
      const parent = isMediaId(item.source.mediaId) && library.get(item.source.mediaId)?.status === "ready" ? item.source.mediaId : id;
      return await library.importFile(output, `${path.parse(item.name).name.slice(0, 160)}-${mask ? "修复" : "精修"}.png`, {
        source: { type: "image_edit", mediaId: parent, baseId: id, transparent: true, operation: mask ? "repair" : "mask", ...(mask ? { model: MODEL.id } : {}) },
      });
    } catch (error) {
      if (taskSignal.aborted) throw taskSignal.reason;
      if (error instanceof AiEditError) throw error;
      throw new AiEditError("image_edit_failed", "图片精修失败，请重新打开图片后再试。", 422);
    } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
  }
  return {
    busy: id => active.has(id),
    /** Internal background recovery: infer only never-observed pixels, not their bounding box. */
    async repairMask(id, selection, { signal: requestSignal, progress = () => {} } = {}) {
      const { reference }=validate(id);assertCapacity();
      const taskSignal=AbortSignal.any([signal,requestSignal].filter(Boolean));taskSignal.throwIfAborted();lock(id);
      const result=tail.catch(()=>undefined).then(async()=>{
        const {default:sharp}=await import('sharp');
        const image=await sharp(reference).rotate().ensureAlpha().png().toBuffer();
        return run(id,image,selection,progress,taskSignal);
      });tail=result.catch(()=>undefined);try{return await result;}finally{unlock(id);}
    },
    /** AI 与手动涂选使用同一修复器、队列和来源记录；坐标相对图片显示方向。 */
    async repairRegions(id, regions, { signal: requestSignal, progress = () => {} } = {}) {
      const { reference } = validate(id);
      if (!Array.isArray(regions) || !regions.length || regions.length > 12 || regions.some(c => !Array.isArray(c) || c.length !== 4 || !c.every(n => Number.isFinite(n) && n >= 0 && n <= 1) || c[2] <= 0 || c[3] <= 0 || c[0] + c[2] > 1 || c[1] + c[3] > 1)) {
        throw new AiEditError("arguments_invalid", "修复区域需要 1–12 个图片内归一化矩形 [x,y,width,height]。", 422);
      }
      assertCapacity();
      const taskSignal = AbortSignal.any([signal, requestSignal].filter(Boolean));
      taskSignal.throwIfAborted();
      lock(id);
      const result = tail.catch(() => undefined).then(async () => {
        taskSignal.throwIfAborted();
        const { default: sharp } = await import("sharp");
        const { data, info } = await sharp(reference, { limitInputPixels: MAX_PIXELS }).rotate().toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        const mask = Buffer.alloc(data.length);
        let painted = 0;
        for (const [x, y, w, h] of regions) {
          const left = Math.floor(x * info.width), top = Math.floor(y * info.height);
          const right = Math.min(info.width, Math.ceil((x + w) * info.width)), bottom = Math.min(info.height, Math.ceil((y + h) * info.height));
          for (let row = top; row < bottom; row++) for (let col = left; col < right; col++) {
            const alpha = (row * info.width + col) * 4 + 3;
            if (!mask[alpha]) painted++;
            mask[alpha] = 255;
          }
        }
        if (painted > info.width * info.height * .75) throw new AiEditError("arguments_invalid", "选区太大，请留出周围可供补全的画面。", 422);
        const image = await sharp(data, { raw: info }).png().toBuffer();
        const selection = await sharp(mask, { raw: info }).png().toBuffer();
        return run(id, image, selection, progress, taskSignal);
      });
      tail = result.catch(() => undefined);
      try { return await result; } finally { unlock(id); }
    },
    async save(id, body) {
      validate(id);
      assertCapacity();
      const image = png(body.image);
      lock(id);
      const result = tail.catch(() => undefined).then(() => run(id, image, null, () => {}));
      tail = result.catch(() => undefined);
      try { return await result; } finally { unlock(id); }
    },
    start(id, body) {
      validate(id);
      assertCapacity();
      const image = png(body.image), mask = png(body.mask);
      // 只保留最近 20 条完成记录；图片结果在素材库中持久保存。
      for (const [key, job] of jobs) if (jobs.size >= 20 && job.status !== "running") jobs.delete(key);
      const job = { id: randomBytes(16).toString("hex"), mediaId: id, status: "running", stage: "等待去字修复", progress: null, item: null, error: null };
      jobs.set(job.id, job); lock(id);
      tail = tail.catch(() => undefined).then(async () => {
        try {
          const item = await run(id, image, mask, (stage, progress = null) => Object.assign(job, { stage, progress }));
          Object.assign(job, { status: "ready", stage: "修复完成", progress: 1, item });
        } catch (error) { Object.assign(job, { status: "failed", stage: "修复失败", error: error.message }); }
        finally { unlock(id); }
      });
      return snapshot(job);
    },
    get(id, jobId) {
      const job = jobs.get(jobId);
      if (!isMediaId(id) || !job || job.mediaId !== id) throw new AiEditError("repair_not_found", "没有这条图片修复任务。", 404);
      return snapshot(job);
    },
    close() { closed = true; },
  };
}
