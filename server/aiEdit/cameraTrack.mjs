import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, stat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AiEditError } from "./library.mjs";
import { renameRetrying } from "./rename.mjs";

const execute = promisify(execFile);
const worker = fileURLToPath(new URL("./cameraTrackWorker.py", import.meta.url)).replace(/([\\/]app\.asar)([\\/])/u, "$1.unpacked$2");
const point = p => Array.isArray(p) && p.length === 2 && p.every(v => Number.isFinite(v) && v >= 0 && v <= 1);

// Embedded in the exported page dependency. Use the source frame displayed at t, including VFR holds.
export function cameraForFrames(frames, speed = 1) {
  return { at(t) {
    let lo = 0, hi = frames.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      // Match the host's 1 ms seek inside the source frame (film/host.mjs).
      if (frames[mid][0] <= t + .001 / speed) lo = mid; else hi = mid;
    }
    const [, x, height, z, ...p] = frames[lo];
    return { x, height, z, project(X, H, Z, width, stageHeight) {
      const depth = p[8]*X + p[9]*H + p[10]*Z + p[11];
      if (depth <= 0.06) return null;
      return [width*(p[0]*X+p[1]*H+p[2]*Z+p[3])/depth, stageHeight*(p[4]*X+p[5]*H+p[6]*Z+p[7])/depth];
    } };
  } };
}

export async function trackCamera(ctx, { clip_id, vanishing_point, ground_polygon, horizontal_fov = 70, camera_height = 1.5 }) {
  const clip = await ctx.store.getSegment(ctx.projectId, clip_id);
  if (clip.kind !== "video" || clip.curve_speed) throw new AiEditError("invalid_tracking_clip", "请选择恒定倍速的实拍视频片段。");
  if (!point(vanishing_point) || (ground_polygon !== undefined && (!Array.isArray(ground_polygon) || ground_polygon.length < 3 || ground_polygon.length > 12 || !ground_polygon.every(point))) ||
      !Number.isFinite(horizontal_fov) || horizontal_fov < 30 || horizontal_fov > 120 || !Number.isFinite(camera_height) || camera_height < 0.15 || camera_height > 15) {
    throw new AiEditError("arguments_invalid", "消失点与地面选区用 0–1 坐标，视场 30–120 度，镜头离地高度 0.15–15 米。");
  }
  const from = clip.source.start_us / 1e6, length = clip.source.duration_us / 1e6;
  if (!(length > 0 && length <= 30)) throw new AiEditError("tracking_duration", "每次跟踪一段不超过 30 秒的连续镜头，请先裁切视频。");
  const mediaId = ctx.library.idForPath(clip.path), file = ctx.library.readyPath(mediaId);
  const options = { from, length, speed: clip.speed ?? 1, vp: vanishing_point, ground: ground_polygon, fov: horizontal_fov, height: camera_height };
  const root = path.dirname(ctx.library.root);
  const [algorithm, sourceInfo] = await Promise.all([readFile(worker), stat(file)]);
  const key = createHash("sha256").update(algorithm).update(cameraForFrames.toString())
    .update(JSON.stringify([mediaId, sourceInfo.size, sourceInfo.mtimeMs, options])).digest("hex").slice(0, 24);
  const folder = path.join(root, "pages", "_camera_" + key), src = "../_camera_" + key + "/track.js";
  const script = path.join(folder, "track.js");
  const how = `页面用 <script src="${src}"></script>，frame(t) 中取 const c=smartcutCamera.at(t)。t 是从此底片片段入点起的时间线秒数。c.x,height,z 是镜头位置。c.project(X,H,Z,画布宽,画布高) 回像素 [x,y]，在镜头后方回 null。世界 X 向右、H 向上（地面 0）、Z 顺路向前，单位按输入高度估算。首帧镜头在 (0,camera_height,0)。落地点的 X、Z 固定，勿按每帧镜头位置移动拱脚。坐标对应完整原画面，叠加层须跟底片相同裁切、缩放和摆放。`;
  try {
    const header = (await readFile(script, "utf8")).split("\n", 1)[0];
    return { ...JSON.parse(header.slice(2)), script_src: src, usage: how };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const python = process.env.SMARTCUT_TRACK_PYTHON || process.env.SMARTCUT_ASR_PYTHON ||
    path.join(root, "asr", "venv", ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]));
  ctx.onGenerating?.("正在逐帧跟踪地面特征并求解镜头轨迹…");
  try {
    const { stdout } = await execute(python, ["-I", "-X", "utf8", worker, file, JSON.stringify(options)], { signal: ctx.signal, timeout: 300_000, maxBuffer: 4*1024*1024, windowsHide: true });
    const { frames, summary } = JSON.parse(stdout);
    await mkdir(folder, { recursive: true });
    const tmp = path.join(folder, randomBytes(8).toString("hex") + ".tmp");
    try {
      await writeFile(tmp, `//${JSON.stringify(summary)}\nwindow.smartcutCamera=(${cameraForFrames.toString()})(${JSON.stringify(frames)},${options.speed});\n`, { mode: 0o600 });
      await renameRetrying(tmp, script);
    } finally { await rm(tmp, { force: true }); }
    return { ...summary, script_src: src, usage: how };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    if (error.code === "ENOENT" || /ModuleNotFoundError/u.test(error.stderr ?? "")) throw new AiEditError("tracking_runtime_missing", "请在本机跟踪用 Python 环境安装 av、numpy、opencv-python-headless，环境位置见 README。", 422);
    throw new AiEditError("camera_tracking_failed", `镜头跟踪未完成：${String(error.stderr || error.message).trim().split("\n").at(-1).slice(0,250)}`, 422);
  } finally { ctx.onGenerating?.(null); }
}
