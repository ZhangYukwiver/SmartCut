import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { drawingPage, drawingProblem, drawingTimes, drawingTransform } from './drawing.mjs';
import { easeAt, KEYFRAME_CURVES } from './curves.mjs';
import { refinementLayers } from './refine.mjs';
import { ProjectStore } from './projectStore.mjs';
import { createToolRunner } from './tools.mjs';
import { projectToFilm } from './film/filmFile.mjs';
import { readFilmFile } from './film/vendor/film-doc.mjs';
import { openMovie } from './film/mp4.mjs';

const paint = { coef: [[120, 30, 50], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], range: [[0, 0, 0], [255, 255, 255]] };
const quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
const drawing = { type: 'panel', width: 480, height: 270, text: '2', fontSize: 20, showText: true, content: 'generated', keys: [{ t: 0, quad, paint }, { t: 1, quad, paint }] };
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), 'drawing-')); roots.push(root);
  const options = { directory: root, mediaRoots: [root], probe: async file => ({ path: file, kind: file.endsWith('.mp4') ? 'video' : 'image', duration_us: 86400e6, width: 1920, height: 1080 }) };
  const store = new ProjectStore(options);
  let p = await store.createProject({ name: '图层动画', canvas: { width: 1920, height: 1080, fps: 30 } });
  p = await store.createTrack(p.id, { track_type: 'video', name: '2 号' });
  p = await store.addMediaSegment(p.id, p.tracks[0].id, { path: path.join(root, 'image.png'), timeline: { start_us: 1e6, duration_us: 3e6 }, drawing });
  return { store, options, project: p, segment: p.tracks[0].segments[0] };
}
describe('editable drawing layers', () => {
  it('preserves keyframe easing in calibration and the standalone exported page', () => {
    const curve = KEYFRAME_CURVES.ease_out.curve;
    const segment = { drawing, timeline: { start_us: 0, duration_us: 1e6 }, keyframes: [
      { property: 'transform_x', offset_us: 0, value: 0, curve },
      { property: 'transform_x', offset_us: 1e6, value: .4 },
    ] };
    const expected = .4 * easeAt(curve, .5);
    expect(expected).toBeGreaterThan(.3);
    expect(drawingTransform(segment, 500000).transform_x).toBeCloseTo(expected);
    const reviewed = refinementLayers({ tracks: [{ track_type: 'video', segments: [segment] }] }, {}, { origin: 0, duration: 1 });
    expect(reviewed[0].keyframes[0].curve).toEqual(curve);
    const html = drawingPage(segment, { width: 480, height: 270 });
    const script = html.match(/<script>([\s\S]*)<\/script>/u)[1];
    const exported = runInNewContext(`${script}\ntransform(segment, 500000)`, {
      document: { querySelector: () => ({ getContext: () => ({}) }) }, window: {},
    });
    expect(exported.transform_x).toBeCloseTo(expected);
  });
  it('writes AAC priming and tail padding as a presentation edit, preserving beat alignment', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'audio-priming-')); roots.push(root);
    const file = path.join(root, 'a.mp4'), movie = await openMovie(file);
    await movie.writeVideo(Buffer.from([1, 2, 3]), { duration: 30 });
    for (let i = 0; i < 50; i++) await movie.writeAudio(Buffer.from([1, 2]), 1024);
    await movie.close({ codec: 'avc1', description: Buffer.from([1, 100, 0, 40]), width: 16, height: 16, timescale: 30 },
      { sampleRate: 48000, channels: 2, bitrate: 192000, description: Buffer.from([0x11, 0x90]), primingSamples: 2112, presentationSamples: 48000 });
    const bytes = await readFile(file), at = bytes.indexOf(Buffer.from('elst'));
    expect(at).toBeGreaterThan(0);
    expect(bytes.readUInt32BE(at + 8)).toBe(1);
    expect(bytes.readUInt32BE(at + 12)).toBe(1000);
    expect(bytes.readUInt32BE(at + 16)).toBe(2112);
  });
  it('validates numeric geometry, ordered timing and bounded payloads', () => {
    expect(drawingProblem(drawing)).toBeNull();
    expect(drawingProblem({ ...drawing, keys: [{ t: 1, quad, paint }, { t: 0, quad, paint }] })).toBeTruthy();
    expect(drawingProblem({ ...drawing, width: NaN })).toBeTruthy();
    expect(drawingProblem({ ...drawing, keys: [{ t: 0, quad: [[Infinity, 0], ...quad.slice(1)], paint }] })).toBeTruthy();
  });
  it('persists independent data and keeps it when replacing a still with a video', async () => {
    const { store, options, project, segment } = await setup();
    const runner = createToolRunner({ store, projectId: project.id, library: { readyPath: () => path.join(options.directory, 'replacement.mp4'), get: () => ({ name: '替换视频', kind: 'video' }), idForPath: () => 'media' } });
    const result = await runner('update_clip', { clip_id: segment.id, media_id: 'replacement' });
    expect(result.result.ok).not.toBe(false);
    const saved = await new ProjectStore(options).getSegment(project.id, segment.id);
    expect(saved.kind).toBe('video');
    expect(saved.timeline).toEqual(segment.timeline);
    expect(saved.drawing).toEqual({ ...drawing, content: 'media', showText: false });
  });
  it('keeps local animation timing through a move, split and head trim', async () => {
    const { store, project, segment } = await setup();
    await store.moveSegment(project.id, segment.id, 4e6);
    expect((await store.getSegment(project.id, segment.id)).drawing).toEqual(drawing);
    const { segments } = await store.splitSegment(project.id, segment.id, 1e6);
    expect(drawingTimes(segments[1].drawing)).toEqual([-1, 0]);
    await store.updateSegment(project.id, segments[1].id, { timeline: { start_us: 5.5e6, duration_us: 1.5e6 } });
    expect((await store.getSegment(project.id, segments[1].id)).drawing.offset).toBe(1.5);
    expect((await store.getSegment(project.id, segments[0].id)).drawing.offset).toBeUndefined();
  });
  it('interpolates transforms and retains mask/keyframe code in the actual film export', async () => {
    const { store, project, segment } = await setup();
    await store.addKeyframes(project.id, segment.id, { keyframes: [{ property: 'transform_x', offset_us: 0, value: 0 }, { property: 'transform_x', offset_us: 1e6, value: .4 }] });
    const p = await store.getProject(project.id);
    expect(drawingTransform(p.tracks[0].segments[0], 500000).transform_x).toBe(.2);
    const result = projectToFilm(p, { mediaOf: () => null, srcFor: () => 'assets/image.png', pageSrc: x => x, textSrc: s => `text/${s.id}.html` });
    expect(result.dropped).toEqual({});
    expect(readFilmFile(result.html).problems).toEqual([]);
    expect(result.texts[0].html).toContain('createDrawingRenderer');
    expect(result.texts[0].html).toContain('"transform_x"');
    expect(result.texts[0].html).not.toContain('</script><script>');
  });
});
