import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { integratedLoudness } from './film/master.mjs';
import { SFX_SOUNDS, makeSoundEffects, renderSoundEffects, wavBytes } from './sfx.mjs';

const RATE = 48_000;
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const peakIn = (data, from, to) => data.subarray(Math.round(from * RATE), Math.round(to * RATE)).reduce((most, v) => Math.max(most, Math.abs(v)), 0);

it('puts every sound at its cue and stays silent elsewhere', () => {
  for (const [sound, { length }] of Object.entries(SFX_SOUNDS)) {
    const { left, right } = renderSoundEffects({ cues: [{ sound, at: 1 }], duration: 1 + length + 0.5 });
    expect(peakIn(left, 0, 1), sound).toBe(0);
    expect(peakIn(left, 1, 1 + length), sound).toBeGreaterThan(0.0005);
    expect(peakIn(right, 1 + length + 0.01, 1 + length + 0.5), sound).toBe(0);
    expect(left.every(Number.isFinite), sound).toBe(true);
  }
}, 20_000);

it('stays quiet by default, repeats exactly, pans and never clips', () => {
  const cues = Object.keys(SFX_SOUNDS).map((sound, index) => ({ sound, at: index }));
  const once = renderSoundEffects({ cues });
  expect(integratedLoudness([once.left, once.right])).toBeLessThan(-22);
  expect(Buffer.compare(Buffer.from(renderSoundEffects({ cues }).left.buffer), Buffer.from(once.left.buffer))).toBe(0);
  const leftOnly = renderSoundEffects({ cues: [{ sound: 'chime', at: 0, pan: -1 }] });
  expect(peakIn(leftOnly.right, 0, 0.5)).toBeLessThan(peakIn(leftOnly.left, 0, 0.5) / 100);
  // 一堆 -6 dB 的声音叠在一起也不过顶
  const pile = renderSoundEffects({ cues: Array.from({ length: 40 }, () => ({ sound: 'chime', at: 0, gain_db: -6 })) });
  expect(peakIn(pile.left, 0, 1)).toBeLessThan(0.9);
}, 20_000);

it('rejects cues outside the limits with the cue number', () => {
  expect(() => renderSoundEffects({ cues: [] })).toThrow('卡点');
  expect(() => renderSoundEffects({ cues: [{ sound: 'boom', at: 0 }] })).toThrow('第 1 个卡点');
  expect(() => renderSoundEffects({ cues: [{ sound: 'tick', at: 0 }, { sound: 'tick', at: -1 }] })).toThrow('第 2 个卡点');
  expect(() => renderSoundEffects({ cues: [{ sound: 'tick', at: 0, gain_db: 0 }] })).toThrow('gain_db');
  expect(() => renderSoundEffects({ cues: [{ sound: 'tick', at: 0 }], duration: 1000 })).toThrow('最长');
});

it('writes a playable 16-bit stereo WAV into the library', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'sfx-')); roots.push(root);
  const adopted = [];
  const library = { root, adopt: vi.fn(async (temp, meta) => { adopted.push(await readFile(temp)); return { id: 'm', name: meta.name }; }) };
  const result = await makeSoundEffects({ library }, { cues: [{ sound: 'whoosh', at: 0.5 }, { sound: 'chime', at: 1 }], name: '卡点' });
  expect(result).toMatchObject({ media_id: 'm', name: '卡点.wav', cues: 2, duration: 1.8 });
  expect(result.peak_db).toBeLessThan(-6);
  expect(library.adopt.mock.calls[0][1]).toMatchObject({ extension: '.wav', source: { type: 'sfx' } });
  const wav = adopted[0];
  expect(wav.toString('latin1', 0, 4)).toBe('RIFF');
  expect(wav.readUInt32LE(24)).toBe(RATE);
  expect(wav.length).toBe(44 + Math.round(1.8 * RATE) * 4);
  expect(wavBytes(new Float32Array(1), new Float32Array(1)).length).toBe(48);
});
