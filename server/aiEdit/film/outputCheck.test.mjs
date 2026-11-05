import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { audioReport } from './master.mjs';
import { openMovie, readMovie } from './mp4.mjs';
import { darkRuns, frameLight, judgeOutput } from './outputCheck.mjs';

const RATE = 48_000;
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** 分段的 1 kHz 正弦：[[起, 止, 振幅], …]，段外静音。 */
const tone = (seconds, parts) => {
  const data = new Float32Array(seconds * RATE);
  for (const [from, to, amp] of parts) for (let i = Math.round(from * RATE); i < Math.round(to * RATE); i++) data[i] = amp * Math.sin(2 * Math.PI * 1000 * i / RATE);
  return [data, Float32Array.from(data)];
};
const pixels = (r, g, b, n = 64) => Uint8ClampedArray.from({ length: n * 4 }, (_, i) => [r, g, b, 255][i % 4]);

it('reports a loudness step at the moment it starts, and caps silence so it does not hide real jumps', () => {
  const report = audioReport(tone(12, [[0, 5, 0.05], [5, 12, 0.2]])); // 5 秒处 +12 dB
  expect(report.jump.lu).toBeCloseTo(12, 0);
  expect(Math.abs(report.jump.at - 5)).toBeLessThan(0.25);
  // 一段静音后接回同样响：上跳封顶在积分响度下 20 LU
  const gap = audioReport(tone(12, [[0, 5, 0.1], [7, 12, 0.1]]));
  expect(gap.jump.lu).toBeCloseTo(20, 0);
});

it('lists silences of at least 0.1 seconds with their edges, and reports full silence without a level', () => {
  const report = audioReport(tone(6, [[0, 2, 0.1], [2.05, 3, 0.1], [4, 5.875, 0.1]]));
  expect(report.silences.map(({ start, end }) => [Math.round(start * 100) / 100, Math.round(end * 100) / 100])).toEqual([[3, 4], [5.88, 6]]);
  expect(audioReport(tone(2, []))).toMatchObject({ loudness: -Infinity, peak: -Infinity, jump: null });
});

it('reads back the sample table of a movie written by openMovie', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'movie-')); roots.push(root);
  const file = path.join(root, 'a.mp4');
  const movie = await openMovie(file);
  await movie.writeVideo(Buffer.alloc(10, 1), { key: true, duration: 1000 });
  await movie.writeVideo(Buffer.alloc(20, 2), { key: false, duration: 1000 });
  await movie.writeVideo(Buffer.alloc(30, 3), { key: true, duration: 1000 });
  await movie.writeAudio(Buffer.alloc(5, 4), 1024);
  await movie.close({ codec: 'avc1', width: 64, height: 36, timescale: 30_000, description: Buffer.from([1, 0x64, 0, 0x28]) },
    { sampleRate: 48_000, channels: 2, bitrate: 192_000, description: Buffer.from([0x11, 0x90]), primingSamples: 0 });
  const { video, audio } = await readMovie(file);
  expect(video).toMatchObject({ frames: 3, width: 64, height: 36, seconds: 0.1, sizes: [10, 20, 30], keys: [0, 2] });
  expect(video.description.subarray(1, 4).toString('hex')).toBe('640028');
  expect(video.offsets[1] - video.offsets[0]).toBe(10);
  expect(audio.seconds).toBeCloseTo(0.021, 2);
});

it('tells black, blank and normal frames apart and groups neighbours', () => {
  const black = frameLight(pixels(4, 4, 4)), white = frameLight(pixels(250, 250, 250));
  const mixed = frameLight(Uint8ClampedArray.from({ length: 256 }, (_, i) => (i % 4 === 3 ? 255 : Math.floor(i / 4) % 2 ? 230 : 20)));
  expect(black[2]).toBe(1);
  expect(white[0]).toBeCloseTo(0.98, 2);
  expect(mixed[1]).toBeGreaterThan(0.3);
  expect(darkRuns([mixed, black, black, mixed, white, null, white])).toEqual([{ kind: '黑屏', first: 1, last: 2 }, { kind: '空白', first: 4, last: 4 }, { kind: '空白', first: 6, last: 6 }]);
});

const film = ({ frames, seconds = frames.length / 30 }) => ({ size: 1, video: { seconds, frames: frames.length, width: 1920, height: 1080 } });
const light = [0.5, 0.2, 0], dark = [0.01, 0, 1];
const sound = (fields = {}) => ({ seconds: 4, loudness: -14.1, peak: -2, jump: { lu: 3.8, at: 1, from: -18, to: -14.2 }, silences: [], ...fields });

it('passes a clean film and keeps deliberate black at the ends out of the issues', () => {
  const frames = [dark, dark, ...Array(116).fill(light), dark, dark];
  const report = judgeOutput({ movie: film({ frames }), measured: { frames, audio: sound() }, timeline: 4, target: -14 });
  expect(report.issues).toEqual([]);
  expect(report).toMatchObject({ duration: 4, fps: 30, sound: { loudness_lufs: -14.1, true_peak_dbtp: -2, loudness_jump: { lu: 3.8, at: 1 } } });
  expect(report.dark_frames).toEqual([{ kind: '黑屏', start: 0, end: 0.07, frames: 2 }, { kind: '黑屏', start: 3.93, end: 4, frames: 2 }]);
});

it('flags what is worth a second look', () => {
  const frames = [...Array(30).fill(light), dark, ...Array(29).fill(light), ...Array(40).fill(dark), ...Array(20).fill(light)];
  const audio = sound({ seconds: 4, loudness: -11, peak: -0.4, jump: { lu: 9.2, at: 2.5, from: -24, to: -14.8 }, silences: [{ start: 1, end: 3 }, { start: 0, end: 0.2 }] });
  const { issues } = judgeOutput({ movie: film({ frames }), measured: { frames, audio }, timeline: 5, target: -14 });
  expect(issues.join('\n')).toMatchInlineSnapshot(`
    "成片 4 秒，时间线 5 秒，对不上
    1 秒闪了 1 帧黑屏（前后都有画面）
    2–3.33 秒中间黑屏了 1.33 秒
    响度 -11 LUFS，目标 -14
    真峰值 -0.4 dBTP，高过 -1
    2.5 秒附近 0.5 秒内响度上跳 9.2 LU，会一惊一乍
    1–3 秒中间没声音"
  `);
  expect(judgeOutput({ movie: film({ frames }), measured: { frames, audio: null }, timeline: 4 }).issues).toContain('成片没有声音');
  expect(judgeOutput({ movie: film({ frames }), measured: { frames, audio: sound({ loudness: null, peak: null, jump: null }) }, timeline: 4 }).issues).toContain('声音轨全是静音');
});
