import { describe, expect, it } from 'vitest';
import { temporalWindows, improvesFrameReview, frameReviewDiagnostics } from './replicaTiming.mjs';
import { completeDrawing, reviseDrawing } from './drawingTools.mjs';
import { parseLookResult } from './look.mjs';

const evidence = (count = 600) => ({
  coverage: 'all-frames', duration: count / 60, frameCount: count, renderFps: 60, requiredFps: 60,
  meanError: .1, localError: .1, temporalError: .01, worstError: .1,
  samples: Array.from({ length: count }, (_, frame) => ({ frame, t: frame / 60, duration: 1 / 60, renderedAt: frame / 60, error: .1, localError: .1, temporalError: .01 })),
  sheets: [{ times: [0], image: 'data:image/jpeg;base64,AAAA' }], detailSheets: [], temporalSheets: [],
});

describe('complete frame review', () => {
  it('retains consecutive context for one-frame, two-frame and last-frame errors', () => {
    const samples = evidence(120).samples.map(s => ({ ...s, error: .2, localError: .2, temporalError: 0 }));
    for (const i of [7, 16, 17, 119]) samples[i].localError = .8;
    const windows = temporalWindows(samples);
    for (const i of [7, 16, 17, 119]) expect(windows.some(w => w.start <= i && w.end >= i)).toBe(true);
    expect(windows.find(w => w.peak === 119)).toMatchObject({ start: 117, end: 119 });
    expect(windows.find(w => w.peak === 7)).toMatchObject({ start: 5, end: 14 });
  });

  it('rejects a new one-frame regression even if whole-clip averages improve', () => {
    const before = evidence(), after = structuredClone(before);
    after.meanError = after.localError = .05;
    after.samples[7].localError = .3;
    expect(improvesFrameReview(before, after)).toBe(false);
    after.samples[7].localError = .1;
    after.samples[7].temporalError = .2;
    expect(improvesFrameReview(before, after)).toBe(false);
    expect(frameReviewDiagnostics(before, after)).toMatchObject({ regressedFrames: 1, worst: [{ frame: 7, t: 7 / 60 }] });
  });

  it('accepts a small improvement confined to one frame in a long clip', () => {
    const before = evidence(2000), after = structuredClone(before);
    after.samples[7].error = after.samples[7].localError = .05;
    after.meanError -= .05 / 2000; after.localError -= .05 / 2000;
    expect(improvesFrameReview(before, after)).toBe(true);
    after.samples[7].t += .001;
    expect(improvesFrameReview(before, after)).toBe(false);
  });

  it('validates more than 160 frames and rejects missing or discontinuous frames', () => {
    const all = evidence();
    expect(parseLookResult(all, 'replica-review').samples).toHaveLength(600);
    const missing = structuredClone(all); missing.samples.splice(7, 1);
    expect(() => parseLookResult(missing, 'replica-review')).toThrow('对照结果');
    const gap = structuredClone(all); gap.samples[7].duration /= 2;
    expect(() => parseLookResult(gap, 'replica-review')).toThrow('对照结果');
  });

  it('inserts a short flash and recovery without mutating the original drawing', () => {
    const original = completeDrawing({ type: 'field', keys: [{ t: 0, paint: { color: '#000000' } }] }, { width: 320, height: 180 });
    const changed = reviseDrawing(original, { nodes: [6, 7, 8].map((frame, i) => ({ kind: 'key', insert: true, time: frame / 60, paint: { color: i === 1 ? '#ff0000' : '#000000' } })) });
    expect(changed.keys.map(k => k.t)).toEqual([0, .1, 7 / 60, 8 / 60]);
    expect(changed.keys[2].paint.color).toBe('#ff0000');
    expect(original.keys).toHaveLength(1);
    expect(() => reviseDrawing(original, { nodes: [{ kind: 'key', insert: true, time: 0, paint: { color: '#ffffff' } }] })).toThrow('同时间');
    expect(original.keys[0].paint.color).toBe('#000000');
  });

  it('edits one filled island and removes its hole while preserving the surrounding mask and paints', () => {
    const full = [[0,0],[1,0],[1,1],[0,1]], hole = [[.1,.1],[.1,.9],[.9,.9],[.9,.1]], island = [[.3,.3],[.7,.3],[.7,.7],[.3,.7]], smallHole = [[.4,.4],[.4,.6],[.6,.6],[.6,.4]];
    const original = completeDrawing({ type: 'mask', sharedPaint: true, keys: [{t:0,paint:{color:'#334455'}}], fullAt:2,
      steps:[{t:0,replace:[full,hole,island,smallHole]},{t:2,replace:[full]}] }, {width:320,height:180});
    const changed = reviseDrawing(original, {nodes:[
      {kind:'step',index:0,polygon_index:3,remove:true},
      {kind:'step',index:0,polygon_index:2,quad:island,paint_keys:[{time:0,paint:{color:'#aacccc'}},{time:1,paint:{color:'#77aaaa'}}]},
    ]});
    expect(changed.steps[0].replace).toEqual([full,hole,island]);
    expect(changed.steps[0].parts.slice(0,2)).toEqual(original.steps[0].parts.slice(0,2));
    expect(changed.steps[0].parts[2]).toMatchObject({paintOverride:true,keys:[{t:0,paint:{color:'#aacccc'}},{t:1,paint:{color:'#77aaaa'}}]});
    expect(changed.keys).toEqual(original.keys);
    expect(changed.steps[1]).toEqual(original.steps[1]);
    expect(original.steps[0].replace).toHaveLength(4);
    expect(() => reviseDrawing(original, {nodes:[{kind:'step',index:0,polygon_index:1,paint:{color:'#ffffff'}}]})).toThrow('内圈');
    expect(() => reviseDrawing(original, {nodes:[{kind:'step',index:0,polygon_index:2,quad:[null],paint:{color:'#ffffff'}}]})).toThrow('坐标无效');
  });
});
