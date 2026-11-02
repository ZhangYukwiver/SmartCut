import { expect, it } from 'vitest';
import { measureRectangle, measureMaskRegions, rectangleRepairNodes } from './replicaRegions.mjs';
import { completeDrawing, reviseDrawing } from './drawingTools.mjs';

it('measures shifted rectangle edges and its color without letting white text bias the estimate', () => {
  const width = 200, height = 120, pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const inside = x >= 55 && x < 145 && y >= 40 && y < 80;
    const text = x >= 90 && x < 105 && y >= 50 && y < 70;
    pixels.set(text ? [255,255,255,255] : inside ? [120,170,180,255] : [30,40,50,255], (y * width + x) * 4);
  }
  const result = measureRectangle(pixels, width, height, [.25,.28,.75,.72]);
  expect(result.bounds).toEqual([55 / width, 40 / height, 145 / width, 80 / height]);
  expect(result.color).toBe('#78aab4');
  pixels.fill(120);
  expect(measureRectangle(pixels, width, height, [.25,.28,.75,.72])).toBeNull();
});

it('tracks a visible rectangle after its editable path has merged into a later mask', () => {
  const width = 200, height = 120, pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(x >= 55 && x < 145 && y >= 40 && y < 80 ? [120,170,180,255] : [30,40,50,255], (y * width + x) * 4);
  const full = [[0,0],[1,0],[1,1],[0,1]], island = [[.25,.28],[.75,.28],[.75,.72],[.25,.72]];
  const layers = [{ name: 'panel', start: 0, duration: 3, drawing: { type: 'mask', content: 'generated', fullAt: 2, steps: [{ t: 0, replace: [full,island] }, { t: 1, replace: [full] }] } }];
  expect(measureMaskRegions(layers, pixels, width, height, 1.1, 33)[0]).toMatchObject({ step: 1, polygon_index: null, trackedFromStep: 0, reference: { color: '#78aab4' } });
  expect(measureMaskRegions(layers, pixels, width, height, 2.1, 63)).toEqual([]);
});

it('fits the complete measured interval and restores the following split without changing other paint or steps', () => {
  const full = [[0,0],[1,0],[1,1],[0,1]], hole = [[.1,.1],[.1,.9],[.9,.9],[.9,.1]], island = [[.25,.28],[.75,.28],[.75,.72],[.25,.72]], cut = [[.3,.4],[.3,.6],[.4,.6],[.4,.4]];
  const original = completeDrawing({ type: 'mask', sharedPaint: true, keys: [{ t: 0, paint: { color: '#123456' } }], fullAt: 2,
    steps: [{ t: 0, replace: [full,hole,island,cut] }, { t: 1, replace: [full,hole] }, { t: 2, replace: [full] }] }, { width: 320, height: 180 });
  const measurements = [0,.5,29/30,1,1.5,59/30].map(time => ({ step: time < 1 ? 0 : 1, polygon_index: time < 1 ? 2 : null, ...(time < 1 ? {} : { trackedFromStep: 0 }),
    localTime: time, currentBounds: [.25,.28,.75,.72], reference: { bounds: [.275,1/3,.725,2/3], color: time < 1 ? '#aacccc' : '#77aaaa' } }));
  const nodes = rectangleRepairNodes(original, measurements, { duration: 3, fps: 30 });
  const fitted = reviseDrawing(original, { nodes });
  expect(fitted.steps[0].replace).toHaveLength(3);
  expect(fitted.steps[1].replace).toEqual(fitted.steps[0].replace);
  expect(fitted.steps[1].parts[2]).toMatchObject({ paintOverride: true, keys: [{ t: 1, paint: { color: '#77aaaa' } }, { t: 1.5, paint: { color: '#77aaaa' } }, { t: 59/30, paint: { color: '#77aaaa' } }] });
  expect(fitted.keys).toEqual(original.keys);
  expect(fitted.steps[2]).toEqual(original.steps[2]);
  expect(original.steps[0].replace).toHaveLength(4);
  expect(rectangleRepairNodes(original, measurements.slice(1), { duration: 3, fps: 30 })).toEqual([]);
  expect(rectangleRepairNodes({ ...original, content: 'media' }, measurements, { duration: 3, fps: 30 })).toEqual([]);
});
