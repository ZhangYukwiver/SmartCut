import { createHash } from 'node:crypto';

// The worker emits PCM16. Crop samples, not compressed packets, so a diagnostic
// clip cannot acquire decoder priming or silently move its musical clock.
export function sliceLyricWav(wav, start, end) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw Error('诊断音轨不是 WAV');
  let format, samples;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), body = at + 8;
    if (body + size > wav.length) throw Error('诊断音轨不完整');
    const kind = wav.toString('ascii', at, at + 4);
    if (kind === 'fmt ') format = wav.subarray(body, body + size);
    if (kind === 'data') samples = wav.subarray(body, body + size);
    at = body + size + size % 2;
  }
  if (!format || format.length < 16 || !samples || format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16) throw Error('诊断音轨需要 PCM16');
  const channels = format.readUInt16LE(2), rate = format.readUInt32LE(4), stride = channels * 2;
  if (!channels || !rate || format.readUInt16LE(12) !== stride || samples.length % stride || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw Error('诊断音轨区间无效');
  const from = Math.round(start * rate), to = Math.min(samples.length / stride, Math.round(end * rate));
  if (to <= from || end > samples.length / stride / rate + .001) throw Error('诊断音轨区间超出实际采样');
  const data = Buffer.alloc(44 + (to - from) * stride);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  format.copy(data, 20, 0, 16); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  samples.copy(data, 44, from * stride, to * stride);
  return { data, start: from / rate, duration: (to - from) / rate, sha256: createHash('sha256').update(data).digest('hex') };
}
