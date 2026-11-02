import { availableParallelism } from "node:os";
import { parentPort, workerData } from "node:worker_threads";

const SIDE = 512;

/** 只改变选区 RGB，透明度和选区外像素保持原样；infer 供确定性像素检查使用。 */
export async function refineImage({ image, mask, reference, output, model, maxPixels = 40_000_000 }, { infer, progress = () => {} } = {}) {
  const { default: sharp } = await import("sharp");
  const source = await sharp(reference, { limitInputPixels: maxPixels }).metadata();
  const swapped = source.orientation >= 5 && source.orientation <= 8;
  const expected = [swapped ? source.height : source.width, swapped ? source.width : source.height];
  const input = sharp(image, { limitInputPixels: maxPixels });
  if ((await input.metadata()).format !== "png") throw new Error("精修图片必须是 PNG。");
  const { data: rgba, info } = await input.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  if (info.width !== expected[0] || info.height !== expected[1]) throw new Error("精修图片的尺寸与原素材不一致，请重新打开编辑器。");
  if (!mask) { await sharp(rgba, { raw: info }).png().toFile(output); return; }
  const selection = sharp(mask, { limitInputPixels: maxPixels });
  const metadata = await selection.metadata();
  if (metadata.format !== "png" || !metadata.hasAlpha || metadata.width !== info.width || metadata.height !== info.height) throw new Error("修复选区需要与图片同尺寸、带透明度的 PNG。");
  const alpha = await selection.ensureAlpha().extractChannel(3).raw().toBuffer();
  let left = info.width, top = info.height, right = -1, bottom = -1, painted = 0;
  for (let i = 0; i < alpha.length; i += 1) {
    if (!alpha[i] || !rgba[i * 4 + 3]) continue;
    const x = i % info.width, y = Math.floor(i / info.width);
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y); painted += 1;
  }
  if (!painted) throw new Error("先涂出需要去字或修复的区域。");
  if (painted > alpha.length * .75) throw new Error("选区太大，请留出周围可供补全的画面。");
  // 单块局部修复：让小字幕占足够的模型分辨率，避免把整张长图压到 512 后丢掉文字细节。
  const side = Math.max(256, Math.ceil(Math.max(right - left + 1, bottom - top + 1) * 1.5));
  const width = Math.min(side, info.width), height = Math.min(side, info.height);
  const crop = { left: Math.max(0, Math.min(info.width - width, Math.floor((left + right + 1 - width) / 2))), top: Math.max(0, Math.min(info.height - height, Math.floor((top + bottom + 1 - height) / 2))), width, height };
  const ratio = Math.min(SIDE / width, SIDE / height), scaledWidth = Math.max(1, Math.round(width * ratio)), scaledHeight = Math.max(1, Math.round(height * ratio));
  const padding = { left: Math.floor((SIDE - scaledWidth) / 2), top: Math.floor((SIDE - scaledHeight) / 2), width: scaledWidth, height: scaledHeight };
  const rgb = await sharp(rgba, { raw: info }).extract(crop).removeAlpha().resize(SIDE, SIDE, { fit: "contain", kernel: "linear", background: "black" }).raw().toBuffer();
  const patchMask = await sharp(alpha, { raw: { width: info.width, height: info.height, channels: 1 } }).extract(crop).resize(SIDE, SIDE, { fit: "contain", kernel: "nearest", background: "black" }).greyscale().raw().toBuffer();
  const area = SIDE * SIDE, pixels = new Float32Array(area * 3), holes = new Float32Array(area);
  for (let i = 0; i < area; i += 1) {
    holes[i] = patchMask[i] > 0 ? 1 : 0;
    for (let c = 0; c < 3; c += 1) pixels[c * area + i] = rgb[i * 3 + c] / 255;
  }
  let prediction;
  if (infer) prediction = await infer({ pixels, holes, crop });
  else {
    progress("加载去字修复模型");
    const ort = await import("onnxruntime-node");
    const session = await ort.InferenceSession.create(model, { executionProviders: ["cpu"], intraOpNumThreads: Math.min(2, availableParallelism()), enableCpuMemArena: false, enableMemPattern: false, logSeverityLevel: 3 });
    try {
      progress("正在补全选区纹理");
      const result = await session.run({ image: new ort.Tensor("float32", pixels, [1, 3, SIDE, SIDE]), mask: new ort.Tensor("float32", holes, [1, 1, SIDE, SIDE]) });
      prediction = result[session.outputNames[0]].data;
    } finally { await session.release(); }
  }
  if (prediction.length !== area * 3) throw new Error("修复模型返回的画面尺寸不对。");
  const bytes = Buffer.alloc(area * 3);
  for (let i = 0; i < area; i += 1) for (let c = 0; c < 3; c += 1) {
    const value = prediction[c * area + i];
    if (!Number.isFinite(value)) throw new Error("修复模型返回了无效像素。");
    bytes[i * 3 + c] = Math.max(0, Math.min(255, Math.round(value)));
  }
  const patch = await sharp(bytes, { raw: { width: SIDE, height: SIDE, channels: 3 } }).extract(padding).resize(width, height, { fit: "fill", kernel: "linear" }).raw().toBuffer();
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const i = (crop.top + y) * info.width + crop.left + x;
    if (!alpha[i] || !rgba[i * 4 + 3]) continue;
    const ratio = alpha[i] / 255;
    for (let c = 0; c < 3; c += 1) rgba[i * 4 + c] = Math.round(rgba[i * 4 + c] * (1 - ratio) + patch[(y * width + x) * 3 + c] * ratio);
  }
  await sharp(rgba, { raw: info }).png().toFile(output);
}

if (parentPort) refineImage(workerData, { progress: stage => parentPort.postMessage({ stage }) }).then(
  () => parentPort.postMessage({ ok: true }),
  error => parentPort.postMessage({ error: /PNG|尺寸|选区|先涂/u.test(error.message) ? error.message : "图片修复失败，请缩小选区或关闭占用内存的应用后重试。" }),
);
