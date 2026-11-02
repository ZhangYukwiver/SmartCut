import { availableParallelism } from "node:os";
import { parentPort, workerData } from "node:worker_threads";

const SIDE = 512;

async function removeBackground() {
  const { model, file, output, maxPixels } = workerData;
  parentPort.postMessage({ stage: "加载抠图模型" });
  const [ort, { default: sharp }] = await Promise.all([import("onnxruntime-node"), import("sharp")]);
  // Electron/macOS 下默认 CPU 内存池在真实推理时会原生崩溃；使用普通分配，任务结束即释放。
  const session = await ort.InferenceSession.create(model, { executionProviders: ["cpu"], intraOpNumThreads: Math.min(2, availableParallelism()), enableCpuMemArena: false, enableMemPattern: false, logSeverityLevel: 3 });
  try {
    parentPort.postMessage({ stage: "正在识别主体并去背景" });
    // EXIF 旋转、镜像先转正；原图 RGB 和已有透明度保留，只改变 alpha。
    const { data: rgba, info } = await sharp(file, { limitInputPixels: maxPixels }).autoOrient().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const rgb = await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } })
      .removeAlpha().resize(SIDE, SIDE, { fit: "fill", kernel: "linear" }).raw().toBuffer();
    const area = SIDE * SIDE;
    const input = new Float32Array(area * 3);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];
    for (let i = 0; i < area; i += 1) {
      for (let c = 0; c < 3; c += 1) input[c * area + i] = (rgb[i * 3 + c] / 255 - mean[c]) / std[c];
    }
    const result = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, SIDE, SIDE]) });
    const tensor = result[session.outputNames.at(-1)];
    if (tensor?.data?.length !== area) throw new Error("cutout_output_invalid");
    const mask = Buffer.alloc(area);
    for (let i = 0; i < area; i += 1) mask[i] = Math.round(255 / (1 + Math.exp(-tensor.data[i])));
    const alpha = await sharp(mask, { raw: { width: SIDE, height: SIDE, channels: 1 } })
      .resize(info.width, info.height, { fit: "fill", kernel: "linear" }).greyscale().raw().toBuffer();
    for (let i = 0; i < info.width * info.height; i += 1) rgba[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * alpha[i] / 255);
    await sharp(rgba, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toFile(output);
  } finally { await session.release(); }
}

removeBackground().then(() => parentPort.postMessage({ ok: true }), () => parentPort.postMessage({ error: "图片抠图失败，请确认图片可正常打开、电脑有足够可用内存后重试。" }));
