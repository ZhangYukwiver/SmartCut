// 成片质检：量导出的 MP4，不靠 ffmpeg（解码和响度都在渲染浏览器的编码页里，encoder.mjs 的 enc.inspect）。
// 这里只放判定：把逐帧亮度和声音指标换成给模型看的报告。只说「可疑」，故意留的黑场、静音由模型对照分镜自己判断。

const TARGET_SLACK_LU = 1, PEAK_LIMIT_DB = -1, JUMP_LIMIT_LU = 6, LONG_SILENCE = 1.5, LONG_DARK = 1;
const MAX_LISTED = 30;

/** 一帧（RGBA 小图）的 [平均亮度, 亮度标准差, 近黑像素占比]，都是 0–1。原样拼进编码页跑，不能引用别的东西。 */
export function frameLight(data) {
  const n = data.length / 4;
  let sum = 0, squares = 0, dark = 0;
  for (let i = 0; i < data.length; i += 4) {
    const y = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
    sum += y; squares += y * y;
    if (y < 0.07) dark += 1;
  }
  const mean = sum / n, round = (v) => Math.round(v * 1000) / 1000;
  return [round(mean), round(Math.sqrt(Math.max(0, squares / n - mean * mean))), round(dark / n)];
}

const seconds = (value) => Math.round(value * 100) / 100;
const db = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);

/** 连着的黑屏（近黑像素 ≥98%）和空白帧（整张一个颜色）并成段：[{ kind, first, last }]，帧号。 */
export function darkRuns(lights) {
  const kindOf = (light) => (!light ? null : light[2] >= 0.98 ? "黑屏" : light[1] < 0.01 ? "空白" : null);
  const runs = [];
  lights.forEach((light, index) => {
    const kind = kindOf(light), last = runs.at(-1);
    if (!kind) return;
    if (last?.kind === kind && last.last === index - 1) last.last = index;
    else runs.push({ kind, first: index, last: index });
  });
  return runs;
}

/** movie：readMovie 的结果；measured：enc.inspect 的结果；timeline 时间线总长（秒）；target 工程的成片响度（LUFS，没设是 null）。 */
export function judgeOutput({ movie, measured, timeline, target = null }) {
  const { video } = movie, { frames, audio } = measured;
  const fps = video.frames / video.seconds, issues = [];
  if (Math.abs(video.seconds - timeline) > 1.5 / fps) issues.push(`成片 ${seconds(video.seconds)} 秒，时间线 ${seconds(timeline)} 秒，对不上`);
  const missing = frames.filter((frame) => !frame).length;
  if (missing) issues.push(`有 ${missing} 帧解不出来`);

  const runs = darkRuns(frames).map(({ kind, first, last }) => ({ kind, start: seconds(first / fps), end: seconds((last + 1) / fps), frames: last - first + 1, first, last }));
  for (const { kind, start, end, frames: count, first, last } of runs) {
    if (first === 0 || last === frames.length - 1) continue;
    const before = frames[first - 1]?.[0], after = frames[last + 1]?.[0], here = frames[first]?.[0];
    if (count <= 2 && before - here > 0.1 && after - here > 0.1) issues.push(`${start} 秒闪了 ${count} 帧${kind}（前后都有画面）`);
    else if (end - start >= LONG_DARK) issues.push(`${start}–${end} 秒中间${kind}了 ${seconds(end - start)} 秒`);
  }

  let sound = null;
  if (!audio) issues.push("成片没有声音");
  else if (!Number.isFinite(audio.loudness ?? NaN)) issues.push("声音轨全是静音");
  else {
    if (target !== null && Math.abs(audio.loudness - target) > TARGET_SLACK_LU) issues.push(`响度 ${db(audio.loudness)} LUFS，目标 ${target}`);
    if (audio.peak > PEAK_LIMIT_DB) issues.push(`真峰值 ${db(audio.peak)} dBTP，高过 ${PEAK_LIMIT_DB}`);
    if (audio.jump?.lu > JUMP_LIMIT_LU) issues.push(`${seconds(audio.jump.at)} 秒附近 0.5 秒内响度上跳 ${db(audio.jump.lu)} LU，会一惊一乍`);
    for (const { start, end } of audio.silences) {
      if (start > 0.05 && end < audio.seconds - 0.05 && end - start >= LONG_SILENCE) issues.push(`${seconds(start)}–${seconds(end)} 秒中间没声音`);
    }
    sound = {
      seconds: seconds(audio.seconds), loudness_lufs: db(audio.loudness), true_peak_dbtp: db(audio.peak),
      loudness_jump: audio.jump ? { lu: db(audio.jump.lu), at: seconds(audio.jump.at), from_lufs: db(audio.jump.from), to_lufs: db(audio.jump.to) } : null,
      silences: audio.silences.slice(0, MAX_LISTED).map(({ start, end }) => ({ start: seconds(start), end: seconds(end) })),
    };
  }
  return {
    duration: seconds(video.seconds), timeline_duration: seconds(timeline), width: video.width, height: video.height, fps: Math.round(fps * 100) / 100, size: movie.size,
    sound, dark_frames: runs.slice(0, MAX_LISTED).map(({ kind, start, end, frames: count }) => ({ kind, start, end, frames: count })), issues,
  };
}
