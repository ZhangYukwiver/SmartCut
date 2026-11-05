import { randomBytes } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { integratedLoudness, truePeak } from "./film/master.mjs";
import { AiEditError } from "./library.mjs";

// 音效：按卡点现合成一条 WAV（48 kHz 立体声 16 位），放进素材库当普通音频。全在 Node 里算，不用音效库、不用技能、不要批准，
// 同样的卡点出同样的声音。音色整体轻、平，没有重击。

const RATE = 48_000, TAU = 2 * Math.PI;
const MAX_CUES = 500, MAX_SECONDS = 300;
// 整条的上限（dBFS），软削顶
const CEILING = 10 ** (-1 / 20);

const lowpass = () => { let y = 0; return (x, a) => (y += a * (x - y)); };
const highpass = () => { let y = 0, last = 0; return (x, a) => { y = a * (y + x - last); last = x; return y; }; };
const oscillator = () => { let phase = 0; return (hz) => Math.sin(phase += (TAU * hz) / RATE); };

/** 每种声音：默认音量（dB）、默认长度（秒）、说明，make(长度, 音高倍数, 噪声) 回一个按秒取样的函数。 */
export const SFX_SOUNDS = {
  tick: { gain: -30, length: 0.03, about: "轻短的嗒：打字、选中、计数", make: (_, pitch, noise) => {
    const tone = oscillator(), soft = lowpass();
    return (t) => (tone(2800 * pitch) * 0.5 + soft(noise(), 0.5) * 0.6) * Math.exp(-t * 180);
  } },
  pop: { gain: -26, length: 0.12, about: "轻弹一下：标签、卡片弹出", make: (_, pitch) => {
    const tone = oscillator();
    return (t) => tone((900 + 900 * Math.min(1, t / 0.04)) * pitch) * Math.exp(-t * 30);
  } },
  whoosh: { gain: -26, length: 0.3, about: "风声掠过：转场、东西飞过，长度 0.1–1.2", make: (length, pitch, noise) => {
    const low = lowpass(), high = highpass();
    return (t) => { const k = t / length; return high(low(noise(), Math.min(1, (0.05 + 0.6 * k) * pitch)), 0.9) * Math.sin(Math.PI * k) * 1.6; };
  } },
  snap: { gain: -24, length: 0.9, about: "弦音拨断：线断、开关、切断", make: (_, pitch, noise) => {
    const one = oscillator(), two = oscillator(), three = oscillator(), high = highpass();
    return (t) => {
      const hz = 330 * pitch * (1 + 0.6 * Math.exp(-t * 30));
      return (one(hz) + 0.5 * two(hz * 2.01) + 0.25 * three(hz * 3.03)) * Math.exp(-t * 6) * 0.5 + high(noise(), 0.96) * Math.exp(-t * 90) * 1.6;
    };
  } },
  thud: { gain: -24, length: 1, about: "低沉落地：段落落点，比重击轻得多", make: (_, pitch) => {
    const tone = oscillator();
    return (t) => tone(41 * pitch) * Math.exp(-t * 1.8) * Math.min(1, t / 0.01);
  } },
  rise: { gain: -28, length: 2, about: "上行铺垫：高潮前，at 是开始时刻，要在 X 秒到顶就填 X 减 length", make: (length, pitch, noise) => {
    const low = lowpass(), high = highpass(), one = oscillator(), two = oscillator();
    return (t) => {
      const k = t / length, hz = 110 * pitch * 8 ** k;
      return (high(low(noise(), 0.02 + 0.5 * k * k), 0.95) * 1.4 + one(hz) * 0.35 + two(hz * 2.01) * 0.15) * k * k;
    };
  } },
  chime: { gain: -24, length: 0.6, about: "清亮的铃：好结果、东西落位", make: (_, pitch) => {
    const one = oscillator(), two = oscillator();
    return (t) => one(1568 * pitch) * Math.exp(-t * 7) * 0.7 + two(2352 * pitch) * Math.exp(-t * 9) * 0.3;
  } },
  hum: { gain: -34, length: 3, about: "低电流声：长时间铺底", make: (length, pitch, noise) => {
    const one = oscillator(), three = oscillator();
    return (t) => (one(100 * pitch) * 0.6 + three(300 * pitch) * 0.25 + noise() * 0.05) * Math.min(1, t / 0.2, (length - t) / 0.2);
  } },
  rumble: { gain: -24, length: 2, about: "远处隆隆：大场面铺底", make: (length, _, noise) => {
    const low = lowpass();
    return (t) => low(noise(), 0.01) * Math.sin((Math.PI * t) / length) * 3;
  } },
};

const invalid = (message) => new AiEditError("arguments_invalid", message, 422);
const inRange = (value, low, high) => typeof value === "number" && value >= low && value <= high;

/** cues：[{ sound, at, length?, gain_db?, pan?, pitch? }]。回 { duration, left, right }（Float32Array）。 */
export function renderSoundEffects({ cues, duration }) {
  if (!Array.isArray(cues) || !cues.length || cues.length > MAX_CUES) throw invalid(`cues 要 1–${MAX_CUES} 个卡点。`);
  let end = 0;
  const parsed = cues.map((cue, index) => {
    const spec = SFX_SOUNDS[cue?.sound];
    const where = `第 ${index + 1} 个卡点`;
    if (!spec) throw invalid(`${where}：sound 只能是 ${Object.keys(SFX_SOUNDS).join("、")}。`);
    const { at, length = spec.length, gain_db: gain = spec.gain, pan = 0, pitch = 1 } = cue;
    if (!inRange(at, 0, MAX_SECONDS)) throw invalid(`${where}：at 要在 0 到 ${MAX_SECONDS} 秒之间。`);
    if (!inRange(length, 0.01, MAX_SECONDS)) throw invalid(`${where}：length 不对。`);
    if (!inRange(gain, -60, -6)) throw invalid(`${where}：gain_db 要在 -60 到 -6 之间。`);
    if (!inRange(pan, -1, 1)) throw invalid(`${where}：pan 要在 -1 到 1 之间。`);
    if (!inRange(pitch, 0.25, 4)) throw invalid(`${where}：pitch 要在 0.25 到 4 之间。`);
    end = Math.max(end, at + length);
    return { spec, at, length, gain, pan, pitch };
  });
  const seconds = duration ?? end + 0.2;
  if (!inRange(seconds, 0.05, MAX_SECONDS)) throw invalid(`整条最长 ${MAX_SECONDS} 秒。`);
  const count = Math.round(seconds * RATE), left = new Float32Array(count), right = new Float32Array(count);
  let seed = 20261104;
  const noise = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return (seed / 4294967296) * 2 - 1; };
  for (const { spec, at, length, gain, pan, pitch } of parsed) {
    const sample = spec.make(length, pitch, noise);
    const level = 10 ** (gain / 20), toLeft = level * Math.cos(((pan + 1) * Math.PI) / 4) * Math.SQRT2, toRight = level * Math.sin(((pan + 1) * Math.PI) / 4) * Math.SQRT2;
    const start = Math.round(at * RATE), size = Math.round(length * RATE);
    for (let i = 0; i < size && start + i < count; i += 1) {
      const t = i / RATE;
      // 头尾各收几毫秒，免得切点上有咔嗒
      const value = sample(t) * Math.min(1, t / 0.002, (length - t) / 0.005);
      left[start + i] += value * toLeft;
      right[start + i] += value * toRight;
    }
  }
  for (const data of [left, right]) for (let i = 0; i < count; i += 1) data[i] = Math.tanh(data[i] / CEILING) * CEILING;
  return { duration: seconds, left, right };
}

export function wavBytes(left, right) {
  const count = left.length, bytes = Buffer.alloc(44 + count * 4);
  bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(36 + count * 4, 4); bytes.write("WAVEfmt ", 8, "latin1"); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(2, 22); bytes.writeUInt32LE(RATE, 24); bytes.writeUInt32LE(RATE * 4, 28); bytes.writeUInt16LE(4, 32); bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "latin1"); bytes.writeUInt32LE(count * 4, 40);
  for (let i = 0; i < count; i += 1) {
    bytes.writeInt16LE(Math.round(left[i] * 32767), 44 + i * 4);
    bytes.writeInt16LE(Math.round(right[i] * 32767), 46 + i * 4);
  }
  return bytes;
}

/** 工具：合成好放进素材库。 */
export async function makeSoundEffects(ctx, { cues, duration, name }) {
  const { duration: seconds, left, right } = renderSoundEffects({ cues, duration });
  const temp = path.join(ctx.library.root, `sfx-${randomBytes(8).toString("hex")}.part`);
  await writeFile(temp, wavBytes(left, right), { mode: 0o600 });
  const item = await ctx.library.adopt(temp, { name: `${String(name ?? "音效轨").slice(0, 60)}.wav`, extension: ".wav", source: { type: "sfx" } })
    .catch(async (error) => { await rm(temp, { force: true }); throw error; });
  const loudness = integratedLoudness([left, right]), peak = 20 * Math.log10(truePeak([left, right]));
  const level = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
  return { media_id: item.id, name: item.name, duration: Math.round(seconds * 1000) / 1000, cues: cues.length, loudness_lufs: level(loudness), peak_db: level(peak),
    note: "at 是时间线秒数，所以放音频轨时 start 填 0。比配乐轻多少看 gain_db 和片段的 volume；出片后用 check_output 量。" };
}
