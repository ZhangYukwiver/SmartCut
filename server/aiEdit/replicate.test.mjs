import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { MediaLibrary } from './library.mjs';
import { mediaKind, probeMedia } from './media.mjs';
import { ProjectStore } from './projectStore.mjs';
import { createToolRunner, timelineSummary } from './tools.mjs';
import { parseLookResult } from './look.mjs';
import { requestAnalysis } from '../videoAnalysis.mjs';
import { completeDrawing } from './drawingTools.mjs';
import { improvesRefinement, refinementTarget } from './refine.mjs';
import { parseReplicaPlan, replicaCorrectionCandidate } from './replicate.mjs';

const roots = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const fixtures = path.resolve('server/fixtures/ai-edit/media');
const full = [[0, 0], [1, 0], [1, 1], [0, 1]];
const paint = { color: '#315060' };
const plan = () => ({ summary: '背景、分块蒙版和独立标题', limitations: [], layers: [
  { name: '底色', start: 0, duration: 3, drawing: { type: 'field', keys: [{ t: 0, paint }] } },
  { name: '蒙版', start: 0, duration: 3, drawing: { type: 'mask', keys: [{ t: 0, paint: { color: '#b4d9dd' } }], steps: [{ t: 0, add: [[[0, 0], [.3, 0], [.3, 1], [0, 1]]] }, { t: .5, replace: [full] }], fullAt: .5 } },
  { name: '标题', start: 1, duration: 2, drawing: { type: 'text', text: 'Hello', center: [.5, .5], fontSize: 32 }, keyframes: [{ property: 'alpha', offset: 0, value: 0 }, { property: 'alpha', offset: .2, value: 1 }] },
] });
const look = { duration: 3, width: 1280, height: 720, audio: true, beats: null, flashes: [], shots: [{ start: 0, end: 3, frame: null }], sheets: [{ times: [0, .1, .2, .3], image: 'data:image/jpeg;base64,AAAA' }], sampleStep: .1 };
async function setup(extra = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'replica-test-')); roots.push(folder);
  const library = new MediaLibrary({ directory: path.join(folder, 'media'), probe: probeMedia, kindOf: mediaKind }); await library.load();
  const item = await library.importFile(path.join(fixtures, 'clip-720p.mp4'), '参考.mp4');
  const store = new ProjectStore({ directory: path.join(folder, 'projects'), mediaRoots: [library.root], probe: probeMedia });
  const project = await store.createProject({ name: '原工程', canvas: { width: 1080, height: 1920, fps: 30 } });
  const sent = [], asked = [];
  const ctx = { store, library, projectId: project.id, config: { baseUrl: 'https://vision.example/v1', apiKey: 'test', model: 'vision' },
    askLook: async request => { asked.push(request); return request.kind === 'extract' ? { duration: 3, assets: [], wav: await readFile(path.join(fixtures, 'tone.wav')) }
      : request.kind === 'replica-review' ? { duration: 3, meanError: .02, worstError: .05, samples: [{ t: 0, error: .02 }], sheets: look.sheets } : structuredClone(look); },
    fetchImpl: async (_url, request) => { sent.push(JSON.parse(request.body)); return Response.json({ choices: [{ message: { content: JSON.stringify(plan()) }, finish_reason: 'stop' }] }); },
    ...extra,
  };
  return { ...ctx, project, item, sent, asked, run: createToolRunner(ctx) };
}

describe('reference to editable timeline', () => {
  it('normalizes static paint and a single polygon from a real model response without merging mask parts', () => {
    const d = completeDrawing({ type: 'mask', paint: { color: '#1E8C96' }, steps: [{ t: 0, add: [[0, 0], [.15, 0], [.15, .28], [0, .28]] }, { t: .6, replace: [full] }], fullAt: .9 }, { width: 1920, height: 1080 });
    expect(d.keys).toEqual([{ t: 0, paint: { color: '#1E8C96' } }]);
    expect(d.steps[0].add).toHaveLength(1);
    expect(d.steps[0].parts[0].quad).toEqual(d.steps[0].add[0]);
    d.steps[0].parts[0].keys[0].t = .1;
    expect(d.keys[0].t).toBe(0);
    expect(d.steps[1].parts[0].keys[0].t).toBe(0);
  });
  it('creates independent editable layers and original audio in one persisted revision, then edits one mask only', async () => {
    const t = await setup();
    const result = await t.run('replicate_reference', { media_id: t.item.id });
    expect(result.result).toMatchObject({ ok: true, clip_count: 4, total_duration: 3 });
    expect(result.action.verification).toMatchObject({ flowCompleted: true, initial: { meanError: .02 }, final: { meanError: .02 }, candidates: [] });
    const saved = await t.store.getProject(t.project.id);
    expect(saved.revision).toBe(t.project.revision + 1);
    expect(saved.canvas).toMatchObject({ width: 1280, height: 720 });
    expect(saved.tracks.map(x => x.track_type)).toEqual(['video', 'video', 'video', 'audio']);
    expect(saved.tracks[2].segments[0].keyframes).toHaveLength(2);
    expect(saved.tracks.every(track => track.segments[0].path !== t.library.readyPath(t.item.id))).toBe(true);
    expect(t.asked.map(x => x.kind)).toEqual(['replica', 'replica-review', 'replica-measure', 'extract']);
    expect(t.sent[0].messages[0].content.some(p => p.type === 'image_url')).toBe(true);
    expect(t.sent[0].messages[0].content.some(p => p.type === 'video_url')).toBe(false);
    expect(t.sent[0].messages[0].content.at(-1).text).toContain('分块步骤');
    const id = saved.tracks[1].segments[0].id;
    expect((await t.run('update_drawing_clip', { clip_id: id, node: { kind: 'step', index: 1, time: .8 } })).result.ok).toBe(true);
    const changed = await t.store.getProject(t.project.id);
    expect(changed.tracks[1].segments[0].drawing.steps[1].t).toBe(.8);
    expect(changed.tracks[1].segments[0].drawing.fullAt).toBe(.8);
    expect(changed.tracks[0]).toEqual(saved.tracks[0]);
    expect(changed.tracks[2]).toEqual(saved.tracks[2]);
    expect(timelineSummary(changed, t.library).tracks[1].clips[0].drawing).toMatchObject({ type: 'mask', step_count: 2, reference_media_id: t.item.id });
    await t.store.restoreProject(t.project.id, saved);
    expect((await t.store.getProject(t.project.id)).tracks).toEqual(saved.tracks);
  });

  it('rejects using the reference video as a flattened layer without touching the project', async () => {
    let id;
    const t = await setup({ fetchImpl: async () => { const p = plan(); p.layers[1].source = { media_id: id }; return Response.json({ choices: [{ message: { content: JSON.stringify(p) } }] }); } }); id = t.item.id;
    expect((await t.run('replicate_reference', { media_id: id })).result).toMatchObject({ ok: false, code: 'replica_invalid' });
    expect(await t.store.getProject(t.project.id)).toEqual(t.project);
  });

  it('extracts a replacement still through the app and retains its crop provenance without editing the project', async () => {
    let request;
    const t = await setup({ askLook: async value => {
      request = value;
      return { assets: [`data:image/jpeg;base64,${(await readFile(path.join(fixtures, 'still.jpg'))).toString('base64')}`], wav: null };
    } });
    const crop = [0, .36, 1, .28];
    const result = await t.run('extract_reference_frame', { media_id: t.item.id, time: 1, crop, name: '完整风景静帧' });
    expect(result.result.ok).toBe(true);
    expect(request).toMatchObject({ kind: 'extract', crops: [{ time: 1, crop }], audio: false });
    const item = t.library.get(result.result.media_id);
    expect(item).toMatchObject({ kind: 'image', name: '完整风景静帧', source: { type: 'reference-frame', referenceId: t.item.id, time: 1, crop } });
    expect(await t.store.getProject(t.project.id)).toEqual(t.project);
    const count = t.library.list().length;
    expect((await t.run('extract_reference_frame', { media_id: t.item.id, time: 1, crop: [.9, 0, .2, 1] })).result.ok).toBe(false);
    expect((await t.run('extract_reference_frame', { media_id: t.item.id, time: 999 })).result.ok).toBe(false);
    expect(t.library.list()).toHaveLength(count);
  });

  it('keeps the whole extracted texture in the reviewed and persisted panel on a portrait canvas', async () => {
    const answer = plan();
    answer.layers.push({ name: '横向风景', start: 0, duration: 3,
      source: { frame_time: 1, crop: [0, .36, 1, .14] },
      drawing: { type: 'panel', keys: [{ t: 0, quad: [[0,.36],[1,.36],[1,.5],[0,.5]], paint }] },
    });
    let reviewed;
    const t = await setup({
      fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify(answer) } }] }),
      askLook: async request => {
        if (request.kind === 'extract') return { duration: 3, assets: [`data:image/jpeg;base64,${(await readFile(path.join(fixtures, 'still.jpg'))).toString('base64')}`], wav: null };
        if (request.kind === 'replica-review') {
          reviewed = request.layers.at(-1);
          return { duration: 3, meanError: .02, worstError: .05, samples: [{ t: 0, error: .02 }], sheets: look.sheets };
        }
        return { ...structuredClone(look), width: 972, height: 1920 };
      },
    });
    expect((await t.run('replicate_reference', { media_id: t.item.id, include_audio: false })).result.ok).toBe(true);
    const saved = await t.store.getProject(t.project.id), segment = saved.tracks.at(-1).segments[0];
    expect(saved.canvas).toMatchObject({ width: 972, height: 1920 });
    expect(reviewed.fit).toBe('stretch');
    expect(segment.fit).toBe(reviewed.fit);
    expect(segment.drawing.keys[0].quad).toEqual(answer.layers.at(-1).drawing.keys[0].quad);
    expect(segment.path).not.toBe(t.library.readyPath(t.item.id));
  });

  it('does not publish partial layers when a later keyframe fails store validation', async () => {
    const t = await setup({ fetchImpl: async () => { const p = plan(); p.layers[2].keyframes[1].value = 2; return Response.json({ choices: [{ message: { content: JSON.stringify(p) } }] }); } });
    const count = t.library.list().length;
    expect((await t.run('replicate_reference', { media_id: t.item.id })).result.ok).toBe(false);
    expect(await t.store.getProject(t.project.id)).toEqual(t.project);
    expect(t.library.list()).toHaveLength(count);
  });

  it('rejects a full reference screenshot without changing the project', async () => {
    const t = await setup({ fetchImpl: async () => { const p=plan();p.layers[1].source={frame_time:0,crop:[0,0,1,1]};return Response.json({choices:[{message:{content:JSON.stringify(p)}}]}); } });
    const result=await t.run('replicate_reference',{media_id:t.item.id});
    expect(result.result).toMatchObject({ok:false,code:'replica_invalid'});
    expect(result.result.message).toContain('完整');
    expect(await t.store.getProject(t.project.id)).toEqual(t.project);
  });

  it('preserves the actual video answer when repairing invalid parameters with images', async () => {
    const sent=[];let firstAnswer;
    const t=await setup({visualInput:'video',fetchImpl:async(_url,request)=>{
      const body=JSON.parse(request.body);sent.push(body);const p=plan();p.layers[1].name='视频识别的独立蒙版';
      if(sent.length===1){p.layers[0].duration=3.1;firstAnswer=JSON.stringify(p);}
      return Response.json({choices:[{message:{content:JSON.stringify(p)}}]});
    }});
    const result=await t.run('replicate_reference',{media_id:t.item.id,include_audio:false});
    expect(result.result.ok).toBe(true);expect(sent).toHaveLength(2);
    expect(sent[0].messages[0].content[0].type).toBe('video_url');
    expect(sent[1].messages[0].content.some(p=>p.type==='image_url')).toBe(true);
    expect(sent[1].messages[0].content.at(-1).text).toContain(firstAnswer);
    expect((await t.store.getProject(t.project.id)).tracks[1].name).toBe('视频识别的独立蒙版');
  });

  it('leaves concurrent changes intact instead of overwriting a newer project', async () => {
    let store, projectId;
    const t = await setup({ fetchImpl: async () => { await store.updateProject(projectId, { name: '用户新名字' }); return Response.json({ choices: [{ message: { content: JSON.stringify(plan()) } }] }); } });
    store = t.store; projectId = t.project.id;
    const result = await t.run('replicate_reference', { media_id: t.item.id, include_audio: false });
    expect(result.result.ok).toBe(false);
    expect(await store.getProject(projectId)).toMatchObject({ name: '用户新名字', tracks: [] });
  });

  it('can add a drawn layer without a pre-imported image and keep animation when replacing it', async () => {
    const t = await setup();
    const added = await t.run('add_drawing_clip', { name: '标题', start: 0, duration: 2, drawing: { type: 'text', text: '可编辑' } });
    expect(added.result.ok).toBe(true);
    const id = added.result.clip_id, original = await t.store.getSegment(t.project.id, id);
    expect((await t.run('update_clip', { clip_id: id, media_id: t.item.id })).result.ok).toBe(true);
    const changed = await t.store.getSegment(t.project.id, id);
    expect(changed.drawing).toEqual({ ...original.drawing, content: 'media', showText: false });
    expect(changed.timeline).toEqual(original.timeline);
  });

  it('passes the structured planning prompt to local AI as well as HTTP providers', async () => {
    let passed;
    const result = await requestAnalysis({ config: { runtime: 'codex', model: '' }, parts: [], prompt: '只输出分层 JSON', localAi: { ask: async (_runtime, value) => { passed = value; return '{}'; } } });
    expect(result).toBe('{}'); expect(passed.prompt).toBe('只输出分层 JSON');
  });

  it('bounds and validates dense visual evidence and extracted assets', () => {
    expect(parseLookResult(look, 'replica').sheets).toHaveLength(1);
    expect(() => parseLookResult({ ...look, sheets: [{ times: [99], image: 'data:image/jpeg;base64,AAAA' }] }, 'replica')).toThrow('逐帧材料');
    expect(() => parseLookResult({ duration: 3, assets: ['file:///secret'] }, 'extract')).toThrow('截图无效');
    expect(() => parseLookResult({ duration: 3, assets: [], wav: 'not-a-wave' }, 'extract')).toThrow('原声无效');
    expect(() => parseLookResult({ duration: 3, meanError: NaN, sheets: [] }, 'replica-review')).toThrow('对照结果');
  });

  it('keeps the closer rendered candidate when a later correction makes the picture worse', async () => {
    let response = 0, review = 0;
    const colors = ['#112233', '#445566', '#778899'];
    const t = await setup({
      fetchImpl: async () => { const p = plan(), index = response++; p.layers[0].drawing.keys[0].paint = { color: colors[index] }; return Response.json({ choices: [{ message: { content: JSON.stringify(index ? { patches: [{ layer_id: 'layer-0', changes: { drawing: { keys: p.layers[0].drawing.keys } } }] } : p) } }] }); },
      askLook: async q => q.kind === 'replica-review' ? { duration: 3, meanError: [.24, .1, .18][review++], worstError: .3, samples: [{ t: 0, error: .1 }], sheets: look.sheets } : structuredClone(look),
    });
    const result = await t.run('replicate_reference', { media_id: t.item.id, include_audio: false });
    expect(result.result.ok).toBe(true);
    const saved = await t.store.getProject(t.project.id);
    expect(saved.tracks[0].segments[0].drawing.keys[0].paint.color).toBe('#445566');
    expect(review).toBe(3);
    expect(result.result.note).toContain('0.240 → 0.100');
  });

  it('accepts independent object improvements and sends the rejected parameters and exact frames to the next round', async () => {
    const sent = []; let response = 0;
    const replies = [plan(), { patches: [
      { layer_id: 'layer-0', changes: { drawing: { keys: [{ t: 0, paint: { color: '#445566' } }] } } },
      { layer_id: 'layer-2', changes: { drawing: { text: 'Bad candidate' } } },
    ] }, { patches: [{ layer_id: 'layer-2', changes: { drawing: { text: 'Fixed title' } } }] }];
    const t = await setup({
      fetchImpl: async (_url, request) => { sent.push(JSON.parse(request.body)); return Response.json({ choices: [{ message: { content: JSON.stringify(replies[response++]) } }] }); },
      askLook: async q => {
        if (q.kind !== 'replica-review') return structuredClone(look);
        const errors = [q.layers[0].drawing.keys[0].paint.color === '#445566' ? .2 : .3,
          q.layers[2].drawing.text === 'Bad candidate' ? .6 : q.layers[2].drawing.text === 'Fixed title' ? .2 : .3, .3];
        return { duration: 3, coverage: 'all-frames', frameCount: 3, renderFps: 30, requiredFps: 30,
          meanError: errors.reduce((a, b) => a + b) / 3, localError: errors.reduce((a, b) => a + b) / 3, temporalError: 0, worstError: Math.max(...errors),
          samples: errors.map((error, frame) => ({ frame, t: frame, duration: 1, renderedAt: frame, error, localError: error, temporalError: 0 })), sheets: look.sheets };
      },
    });
    const result = await t.run('replicate_reference', { media_id: t.item.id, include_audio: false });
    expect(result.result.ok).toBe(true);
    expect(result.action.verification.candidates.map(c => [c.layer_id, c.accepted])).toEqual([['layer-0', true], ['layer-2', false], ['layer-2', true]]);
    const rejected = result.action.verification.candidates[1];
    expect(rejected.comparison).toMatchObject({ regressedFrames: 1, worst: [{ frame: 1, t: 1 }] });
    const feedback = sent[2].messages[0].content.at(-1).text;
    expect(feedback).toContain('Bad candidate');
    expect(feedback).toContain('"frame":1,"t":1');
    expect(feedback).toContain('"regressedFrames":1');
    expect(feedback).not.toBe(sent[1].messages[0].content.at(-1).text);
    const saved = await t.store.getProject(t.project.id);
    expect(saved.tracks.map(t => t.name)).toEqual(['底色', '蒙版', '标题']);
    expect(saved.tracks[0].segments[0].drawing.keys[0].paint.color).toBe('#445566');
    expect(saved.tracks[2].segments[0].drawing.text).toBe('Fixed title');
  });

  it('keeps the improvement from one measured object when another measured object regresses', async () => {
    const original = plan(); original.layers = [original.layers[0], ...[1, 2, 3, 4].map(n => ({ name: `面板${n}`, start: 0, duration: 3, drawing: { type: 'panel', text: String(n), keys: [{ t: 0, quad: full, paint: { color: ['#cc0000', '#00cc00', '#0000cc', '#cccc00'][n - 1] } }] } }))];
    let response = 0, reviews = 0, correctionPrompt = '';
    const t = await setup({
      fetchImpl: async (_url, request) => {
        if (response) correctionPrompt = JSON.parse(request.body).messages.flatMap(m => m.content.filter(p => p.type === 'text').map(p => p.text)).join('\n');
        return Response.json({ choices: [{ message: { content: JSON.stringify(response++ ? { patches: [] } : original) } }] });
      },
      askLook: async q => {
        if (q.kind === 'replica-measure') {
          const layers = structuredClone(q.layers); layers[0].drawing.keys[0].paint = { color: '#445566' }; layers[2].drawing.text = 'Wrong';
          return { duration: 3, layers, measured: 2 };
        }
        if (q.kind !== 'replica-review') return structuredClone(look);
        reviews++; const error = q.layers[2].drawing.text === 'Wrong' ? .4 : q.layers[0].drawing.keys[0].paint.color === '#445566' ? .1 : .2;
        return { duration: 3, meanError: error, localError: error, worstError: error, samples: [{ t: 0, error }], sheets: look.sheets };
      },
    });
    const result = await t.run('replicate_reference', { media_id: t.item.id, include_audio: false });
    expect(result.result.ok).toBe(true); expect(reviews).toBe(3);
    expect(result.action.verification.candidates.map(c => c.accepted)).toEqual([true, false]);
    expect(correctionPrompt).toContain('"round":"local-measurement"');
    expect(correctionPrompt).toContain('"layer_id":"layer-2"');
    expect(correctionPrompt).toContain('"accepted":false');
    expect(correctionPrompt).toContain('"frame":0');
    const saved = await t.store.getProject(t.project.id);
    expect(saved.tracks.map(t => t.name)).toEqual(original.layers.map(l => l.name));
    expect(saved.tracks[0].segments[0].drawing.keys[0].paint.color).toBe('#445566');
    expect(saved.tracks[2].segments[0].drawing.text).toBe('2');
  });

  it('prevents object patches from changing identity, source, or unrelated layers', () => {
    const context = { item: { id: 'reference' }, look, canvas: { width: 1280, height: 720, fps: 30 } };
    const original = parseReplicaPlan(JSON.stringify(plan()), context), snapshot = structuredClone(original);
    for (const changes of [{ name: 'Reordered' }, { source: { media_id: 'reference' } }, { drawing: { referenceId: 'other' } }]) {
      expect(() => replicaCorrectionCandidate(original, { layer_id: 'layer-1', changes }, context)).toThrow();
    }
    expect(() => replicaCorrectionCandidate(original, { layer_id: 'unknown', changes: { start: 0 } }, context)).toThrow('未知图层');
    const candidate = replicaCorrectionCandidate(original, { layer_id: 'layer-2', changes: { drawing: { text: 'New title' } } }, context).plan;
    expect(candidate.layers.slice(0, 2)).toEqual(original.layers.slice(0, 2));
    expect(candidate.layers[2].drawing.text).toBe('New title'); expect(original).toEqual(snapshot);
  });

  it('rejects accumulated frame degradation even when the next object passes against the latest accepted result', async () => {
    let response = 0;
    const replies = [plan(), { patches: [{ layer_id: 'layer-0', changes: { drawing: { keys: [{ t: 0, paint: { color: '#445566' } }] } } }] },
      { patches: [{ layer_id: 'layer-2', changes: { drawing: { text: 'Second change' } } }] }];
    const t = await setup({
      fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify(replies[response++]) } }] }),
      askLook: async q => {
        if (q.kind !== 'replica-review') return structuredClone(look);
        const second = q.layers[2].drawing.text === 'Second change', first = q.layers[0].drawing.keys[0].paint.color === '#445566';
        const errors = second ? [.344, .3, .6] : first ? [.322, .4, .6] : [.3, .5, .6];
        return { duration: 3, coverage: 'all-frames', frameCount: 3, requiredFps: 30, renderFps: 30,
          meanError: errors.reduce((a, b) => a + b) / 3, localError: errors.reduce((a, b) => a + b) / 3, temporalError: 0, worstError: .6,
          samples: errors.map((error, frame) => ({ frame, t: frame, duration: 1, error, localError: error, temporalError: 0 })), sheets: look.sheets };
      },
    });
    const result = await t.run('replicate_reference', { media_id: t.item.id, include_audio: false });
    expect(result.action.verification.candidates).toMatchObject([{ accepted: true }, { accepted: false, comparison: { regressedFrames: 0 }, baselineComparison: { regressedFrames: 1 } }]);
    expect((await t.store.getProject(t.project.id)).tracks[2].segments[0].drawing.text).toBe('Hello');
  });

  it('falls back to continuous frames only when the provider refuses video input', async () => {
    const inputs = [];
const t = await setup({ visualInput: 'video', fetchImpl: async (_url, request) => {
      const body = JSON.parse(request.body), type = body.messages[0].content[0].type; inputs.push(type);
      return type === 'video_url' ? Response.json({ error: { message: 'unsupported video_url' } }, { status: 400 })
        : Response.json({ choices: [{ message: { content: JSON.stringify(plan()) } }] });
    } });
    const result = await t.run('replicate_reference', { media_id: t.item.id, include_audio: false });
    expect(result.result.ok).toBe(true);
    expect(inputs).toEqual(['video_url', 'text']);
    expect(result.result.note).toContain('连续截图');
  });

  it('does not write a timeline if the rendered comparison fails', async () => {
    const t = await setup({ askLook: async q => { if (q.kind === 'replica-review') throw new Error('renderer unavailable'); return structuredClone(look); } });
    expect((await t.run('replicate_reference', { media_id: t.item.id })).result.ok).toBe(false);
    expect(await t.store.getProject(t.project.id)).toEqual(t.project);
  });
});

describe('automatic refinement of an existing timeline', () => {
  const evidence = error => ({ duration: 3, meanError: error, localError: error, worstError: error * 2, samples: [{ t: 0, error }], sheets: look.sheets });
  async function existing({ respond, review, signal } = {}) {
    let refining = false, clip, round = 0, reviews = 0;
    const t = await setup({ signal,
      fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify(refining ? await respond(clip, round++) : plan()) } }] }),
      askLook: async q => q.kind === 'extract' ? { duration: 3, assets: [], wav: await readFile(path.join(fixtures, 'tone.wav')) }
        : q.kind === 'replica-review' ? (refining ? review(reviews++, q) : evidence(.02)) : structuredClone(look),
    });
    expect((await t.run('replicate_reference', { media_id: t.item.id })).result.ok).toBe(true);
    const before = await t.store.getProject(t.project.id);
    clip = before.tracks[2].segments[0].id; refining = true;
    return { ...t, before, clip };
  }
  const change = (id, text) => ({ observations: ['标题文字不同'], patches: [{ clip_id: id, changes: { text } }], remaining: ['字体仍有轻微差异'] });

  it('saves only measured improvement, stops after two regressions and preserves unrelated tracks and audio', async () => {
    const t = await existing({ respond: (id, i) => change(id, ['Closer', 'Worse', 'Also worse'][i]), review: i => evidence([.2, .1, .15, .14][i]) });
    const result = await t.run('refine_reference', {});
    expect(result.result.ok).toBe(true);
    expect(result.result.note).toContain('检查 3 轮，采纳 1 轮');
    expect(result.result.note).toContain('连续两轮');
    const saved = await t.store.getProject(t.project.id);
    expect(saved.tracks[2].segments[0].drawing.text).toBe('Closer');
    expect(saved.revision).toBe(t.before.revision + 1);
    expect([saved.tracks[0], saved.tracks[1], saved.tracks[3]]).toEqual([t.before.tracks[0], t.before.tracks[1], t.before.tracks[3]]);
    expect(saved.tracks.map(t => t.id)).toEqual(t.before.tracks.map(t => t.id));
  });

  it('rejects changing unrelated fields or unknown clips without publishing a partial candidate', async () => {
    const t = await existing({ respond: id => ({ patches: [{ clip_id: id, changes: { text: 'Do not save' } }, { clip_id: 'unknown', changes: { text: 'No' } }] }), review: () => evidence(.2) });
    const result = await t.run('refine_reference', {});
    expect(result.result.ok).toBe(true);
    expect(result.result.note).toContain('采纳 0 轮');
    expect(await t.store.getProject(t.project.id)).toEqual(t.before);
  });

  it('does not count an invalid response as a measured regression', async () => {
    const t = await existing({ respond: (id, i) => i === 0 ? [] : i === 3 ? { patches: [], done: true } : change(id, i === 1 ? 'Worse' : 'Closer'), review: i => evidence([.2, .3, .1][i]) });
    const result = await t.run('refine_reference', {});
    expect(result.result.note).toContain('检查 4 轮，采纳 1 轮');
    expect((await t.store.getProject(t.project.id)).tracks[2].segments[0].drawing.text).toBe('Closer');
  });

  it('does not report an unapplied candidate as a completed repair', async () => {
    const t = await existing({ respond: id => ({ ...change(id, 'Worse'), remaining: ['本轮已修好文字，仅颜色仍不同'] }), review: i => evidence(i ? .3 : .2) });
    const result = await t.run('refine_reference', {});
    expect(result.result.note).toContain('采纳 0 轮');
    expect(result.result.note).toContain('标题文字不同');
    expect(result.result.note).not.toContain('已修好文字');
    expect(await t.store.getProject(t.project.id)).toEqual(t.before);
  });

  it('preserves a concurrent manual edit when a measured candidate tries to save', async () => {
    let t;
    t = await existing({ respond: id => change(id, 'Candidate'), review: async i => {
      if (i) await t.store.updateProject(t.project.id, { name: '手动新名字' });
      return evidence(i ? .1 : .2);
    } });
    expect((await t.run('refine_reference', {})).result.ok).toBe(false);
    const saved = await t.store.getProject(t.project.id);
    expect(saved.name).toBe('手动新名字');
    expect(saved.tracks).toEqual(t.before.tracks);
  });

  it('keeps already accepted work when the next review is stopped', async () => {
    const controller = new AbortController();
    const t = await existing({ signal: controller.signal, respond: (id, i) => change(id, i ? 'Unfinished' : 'Accepted'), review: i => {
      if (i === 2) { controller.abort(); controller.signal.throwIfAborted(); }
      return evidence(i ? .1 : .2);
    } });
    await expect(t.run('refine_reference', {})).rejects.toMatchObject({ name: 'AbortError' });
    const saved = await t.store.getProject(t.project.id);
    expect(saved.tracks[2].segments[0].drawing.text).toBe('Accepted');
    expect(saved.revision).toBe(t.before.revision + 1);
  });

  it('requires fixed sample times and rejects hidden local or worst-frame regressions', () => {
    expect(improvesRefinement(evidence(.2), evidence(.1))).toBe(true);
    expect(improvesRefinement(evidence(.2), { ...evidence(.1), localError: .3 })).toBe(false);
    expect(improvesRefinement(evidence(.2), { ...evidence(.1), worstError: .5 })).toBe(false);
    expect(improvesRefinement(evidence(.2), { ...evidence(.1), samples: [{ t: .5, error: .1 }] })).toBe(false);
  });

  it('infers legacy reference placement but refuses unsupported visible overlay tracks', async () => {
    const t = await existing({ respond: () => ({ patches: [], done: true }), review: () => evidence(.2) });
    const legacy = structuredClone(t.before);
    legacy.tracks.forEach(t => t.segments.forEach(s => { if (s.drawing) delete s.drawing.referenceStart; }));
    expect(refinementTarget(legacy, t.library).origin).toBe(0);
    legacy.tracks.push({ track_type: 'text', mute: false, segments: [{ timeline: { start_us: 0, duration_us: 1_000_000 } }] });
    expect(() => refinementTarget(legacy, t.library)).toThrow('暂不支持自动对照');
  });
});
