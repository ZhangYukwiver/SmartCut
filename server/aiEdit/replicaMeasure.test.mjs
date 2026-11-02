import { afterEach, describe, expect, it, vi } from 'vitest';
import { canMeasureReplica, measureReplica, replicaMeasurementObjects } from './replicaMeasure.mjs';
import { drawingProblem } from './drawing.mjs';
import { completeDrawing } from './drawingTools.mjs';

afterEach(() => vi.unstubAllGlobals());
const full = [[0, 0], [1, 0], [1, 1], [0, 1]];
const layer = (name, text, start, type = 'panel') => ({ name, start, duration: .4 - start, keyframes: [],
  drawing: completeDrawing({ type, text, keys: [{ t: 0, paint: { color: type === 'field' ? '#000000' : '#ffffff' }, ...(type === 'panel' ? { quad: full } : {}) }] }, { width: 480, height: 270 }) });

describe('measured object order', () => {
  it('uses stable layer identity for repeated numbers and keeps independent text separate', () => {
    const first = layer('同名', '1', 0), next = layer('同名', '1', .2);
    first.drawing.keys[0].paint = { color: '#cc0000' };
    next.drawing.keys[0].paint = { color: '#00cc00' };
    const text = { ...layer('12 的先行 1', '1', .3), drawing: completeDrawing({ type: 'text', text: '1' }, { width: 480, height: 270 }) };
    const objects = replicaMeasurementObjects([first, next, text]);
    expect(objects.map(o => o.id)).toEqual(['layer-0', 'layer-1', 'layer-2']);
    expect(objects.map(o => o.eligible)).toEqual([true, true, false]);
    expect(canMeasureReplica([first, next, text], .4)).toBe(true);
  });

  it('skips only same-color ambiguous objects and unsupported media, not healthy neighbors', () => {
    const a = layer('遮罩左', '', .1), b = layer('遮罩右', '', .2), healthy = layer('2', '2', .25);
    healthy.drawing.keys[0].paint = { color: '#00cc00' };
    const media = { ...layer('图片', '', .3), drawing: { ...a.drawing, content: 'media' } };
    const objects = replicaMeasurementObjects([a, b, healthy, media]);
    expect(objects.map(o => o.eligible)).toEqual([false, false, true, false]);
    expect(objects[0].reason).toBe('ambiguous-color:layer-1');
    expect(objects[1].reason).toBe('ambiguous-color:layer-0');
    expect(canMeasureReplica([a, b, healthy, media], .4)).toBe(true);
  });

  it('measures a shrinking coverage contour without merging its historical union or inventing fullscreen', async () => {
    let t = 0;
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData() {
      const pixels = new Uint8ClampedArray(480 * 270 * 4), edge = t < .2 ? 480 : 180;
      for (let y = 0; y < 270; y++) for (let x = 0; x < 480; x++) {
        const p = (y * 480 + x) * 4; pixels[p] = x < edge ? 220 : 0; pixels[p + 3] = 255;
      }
      return { data: pixels };
    } }) }) });
    const mask = { ...layer('覆盖', '4', 0), drawing: completeDrawing({ type: 'mask', text: '4', keys: [{ t: 0, paint: { color: '#dc0000' } }], steps: [{ t: 0, replace: [full] }], fullAt: .1 }, { width: 480, height: 270 }) };
    const result = await measureReplica({ video: { duration: .4, videoWidth: 480, videoHeight: 270 }, layers: [mask], seek: async (_, time) => { t = time; } });
    expect(result.measured).toBe(1);
    const drawing = result.layers[0].drawing;
    expect(drawingProblem(drawing)).toBeNull();
    const right = step => Math.max(...step.replace.flat().map(p => p[0]));
    expect(right(drawing.steps[0])).toBeGreaterThan(.95);
    expect(right(drawing.steps.at(-1))).toBeLessThan(.4);
    expect(drawing.fullAt).toBeGreaterThan(result.layers[0].duration);
    expect(mask.drawing.fullAt).toBe(.1);
  }, 15000);

  it('keeps an ungrouped foreground layer between the same objects while fitting the visible background', async () => {
    const pixels = new Uint8ClampedArray(480 * 270 * 4);
    for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
    vi.stubGlobal('document', { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: pixels }) }) }) });
    const extra = layer('保留的遮挡层', '', .22);
    const layers = [layer('底色', '', 0, 'field'), layer('1', '1', .2), extra, layer('2', '2', .25), layer('3', '3', .3), layer('4', '4', .35)];
    const snapshot = structuredClone(layers);
    const result = await measureReplica({ video: { duration: .4, videoWidth: 480, videoHeight: 270 }, layers, seek: async () => {} });
    expect(result.measured).toBe(1);
    expect(result.layers.map(l => l.name)).toEqual(layers.map(l => l.name));
    expect(result.layers[2]).toBe(extra);
    expect(result.layers[0].drawing.keys[0].paint.coef).toBeDefined();
    expect(result.layers.slice(1)).toEqual(layers.slice(1));
    expect(layers).toEqual(snapshot);
  }, 15000);
});
