import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { stat } from "node:fs/promises";
import { AiEditError } from "./library.mjs";

const execute = promisify(execFile);
const worker = fileURLToPath(new URL("./lyricsWorker.py", import.meta.url)).replace(/([\\/]app\.asar)([\\/])/u, "$1.unpacked$2");
const round = n => Math.round(n * 1000) / 1000;

// Only a uniquely identified, continuous source can supply context outside an
// exported cut. Never pretend a mixed soundtrack came from one arbitrary file.
export async function lyricSourceContext(ctx, check, projectSnapshot = null) {
  if ((!projectSnapshot && !ctx.store?.getProject) || !ctx.library?.idForPath || !ctx.library?.get || check.audio.source_clips?.length !== 1) return null;
  const at = check.audio.start ?? check.composition?.start, duration = check.audio.duration;
  if (!Number.isFinite(at) || !(duration > 0)) return null;
  const project = projectSnapshot ?? await ctx.store.getProject(ctx.projectId), audible = [];
  for (const track of project.tracks ?? []) {
    if (track.mute) continue;
    for (const clip of track.segments ?? []) {
      const begin = clip.timeline.start_us / 1e6, end = begin + clip.timeline.duration_us / 1e6;
      if (end <= at || begin >= at + duration || !clip.path) continue;
      const item = ctx.library.get(ctx.library.idForPath(clip.path));
      if (item?.hasAudio === false || clip.kind === 'image' || clip.kind === 'text') continue;
      if (clip.volume === 0 && !(clip.keyframes ?? []).some(k => k.property === 'volume')) continue;
      audible.push({ clip, item, begin, end });
    }
  }
  if (audible.length !== 1) return null;
  const { clip, item, begin, end } = audible[0], speed = clip.speed ?? 1;
  if (![clip.id, `${clip.id}-audio`].includes(check.audio.source_clips[0])) return null;
  if (!item || item.source?.type === 'page' || begin > at + 1e-6 || end < at + duration - 1e-6 || !(speed > 0)
      || clip.change_pitch || clip.effects?.length || clip.transition) return null;
  const from = clip.source.start_us / 1e6 + (at - begin) * speed, to = from + duration * speed;
  const file = ctx.library.readyPath(item.id), info = await stat(file);
  return { file, clip, at, from, to, speed, stamp: [item.id, info.size, info.mtimeMs, from, to, speed] };
}

export async function analyzeLyricsAudio(ctx, file, from, to, { language = 'auto', mix = false, candidates = [], preparedFile = null } = {}) {
  const root = path.join(path.dirname(ctx.library.root), 'asr');
  const python = process.env.SMARTCUT_ASR_PYTHON || path.join(root, 'venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
  const { stdout } = await execute(python, ['-I', '-X', 'utf8', worker, file, String(from), String(to), language, mix ? 'mix' : 'vocals', path.join(root, 'models'), JSON.stringify(candidates), preparedFile ?? ''], {
    signal: ctx.signal, timeout: 40 * 60_000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  return JSON.parse(stdout);
}

export function placeLyricWords(words, clip, from, to) {
  const source = clip.source.start_us / 1e6, at = clip.timeline.start_us / 1e6;
  const speed = clip.speed ?? 1, end = at + clip.timeline.duration_us / 1e6;
  return words.flatMap(word => {
    const left = Math.max(from, word.start), right = Math.min(to, word.end);
    if (!(right > left) || !word.text.trim()) return [];
    const start = round(at + (left - source) / speed), stop = round(Math.min(end, at + (right - source) / speed));
    const onset = Array.isArray(word.onset_range) ? word.onset_range.map(t => round(at + (Math.max(left, Math.min(right, t)) - source) / speed)) : null;
    return stop > start ? [{ text: word.text.trim(), start, end: stop, source_start: round(left), source_end: round(right), confidence: word.confidence,
      ...(onset ? { onset_range: onset } : {}) }] : [];
  });
}

export async function transcribeLyrics(ctx, { clip_id, offset = 0, duration = 30, language, mix = false, candidates = [] }) {
  const clip = await ctx.store.getSegment(ctx.projectId, clip_id);
  if (clip.kind !== "audio") throw new AiEditError("not_audio", "请先把音乐放到音频轨，传入它的 clip_id。");
  const length = clip.source.duration_us / 1e6;
  if (!Number.isFinite(offset) || offset < 0 || offset >= length || !Number.isFinite(duration) || duration <= 0 || duration > 30 ||
      (language !== undefined && (typeof language !== "string" || !/^[a-z]{2,3}$/u.test(language))) || typeof mix !== "boolean") {
    throw new AiEditError("arguments_invalid", "offset 要在音频片段的源范围内，duration 为 0 到 30 秒（不含 0），language 填 en、zh 等语言代码。");
  }
  const source = clip.source.start_us / 1e6, from = source + offset, to = source + Math.min(length, offset + duration);
  if (!Array.isArray(candidates) || candidates.length > 4 || candidates.some(x => typeof x !== "string" || !x.trim() || x.length > 160)) {
    throw new AiEditError("arguments_invalid", "最多比较四种候选唱词，每种 1 到 160 个字符。");
  }
  const file = ctx.library.readyPath(ctx.library.idForPath(clip.path));
  ctx.onGenerating?.("正在本机听音乐并对齐歌词，首次使用需下载识别模型…");
  try {
    const result = await analyzeLyricsAudio(ctx, file, from, to, { language, mix, candidates });
    const words = placeLyricWords(result.words, clip, from, to);
    return { language: result.language, words, time_unit: "秒，start/end 是工程时间，source_start/source_end 是原曲时间",
      ...(result.candidates ? { candidates: result.candidates.map(c => ({ ...c, words: placeLyricWords(c.words, clip, from, to) })) } : {}),
      ...(offset + duration < length ? { next_offset: offset + duration } : {}),
      ...(!words.length ? { note: "这一段未识别到唱词，不要编词。可切换 mix 或指定语言重听。" } : {}) };
  } catch (error) {
    if (ctx.signal?.aborted) throw error;
    if (error.code === "ENOENT" || /ModuleNotFoundError/u.test(error.stderr ?? "")) {
      throw new AiEditError("lyrics_runtime_missing", "请用 Python 3.12 安装 faster-whisper==1.2.1，并设置 SMARTCUT_ASR_PYTHON 为该解释器，或按 README 放入应用的 asr/venv。", 422);
    }
    const reason = String(error.stderr ?? "").trim().split("\n").at(-1)?.slice(0, 220);
    throw new AiEditError("lyrics_failed", error.killed ? "模型下载或歌词识别超时，请检查网络与缓存后重试。" : `本机歌词识别失败：${reason || "请检查模型缓存和音频文件"}`, 422);
  } finally {
    ctx.onGenerating?.(null);
  }
}
