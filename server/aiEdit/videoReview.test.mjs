import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { pageCandidates } from './pageCandidates.mjs';
import { reviewVideoClip, parseVideoReview, requireCurrentVideoReview } from './videoReview.mjs';
import { reviewHash } from './film/reviewClips.mjs';

const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const assessment = { decision: 'improved', summary: '推进增强', evidence: ['3.8–6秒中央缝线持续下移'], regressions: [], remaining: ['亮度仍有差异'], ready_to_adopt: true };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'video-review-')); roots.push(root);
  const candidates = pageCandidates(root, 'a'.repeat(32)), requests = [], renders = [];
  const candidate = await candidates.add({ html: 'new', original: 'old', pageId: 'b'.repeat(16), canvas: { width: 960, height: 532, fps: 60 }, duration: 10.2, problems: [], unstable: false,
    reference: { media_id: 'reference', offset: 2.8, crop: [0, .36, 1, .28], reference_crop: [0, .36, 1, .28] } });
  const ctx = { candidates, sessionId: 'a'.repeat(32), config: { runtime: 'api', model: 'qwen3.8-max', baseUrl: 'https://model.example/v1' },
    pages: { read: async () => 'old' }, store: { getProject: async () => ({ canvas: candidate.canvas }) },
    library: { get: () => ({ kind: 'video', width: 1920, height: 3792, durationUs: 25_783_333 }), readyPath: id => id },
    reviewBudget: { calls: 0, noImprovement: 0 },
    reviewClips: { composition: async () => null, render: async source => { renders.push(source); const key = reviewHash({ ...source, signal: undefined }); const file = path.join(root, key + '.mp4'); await writeFile(file, 'video'); return { file, relative: key + '.mp4', key, start: source.start, duration: source.duration, fps: source.fps }; } },
    vision: { snapshot: () => ({ capabilities: [{ video: true }] }), ask: async request => { requests.push(request); return JSON.stringify(assessment); } } };
  return { root, ctx, candidate, requests, renders, args: { preview_id: candidate.id, start: 3.8, duration: 2.2 } };
}

it('sends aligned videos, keeps the candidate across turns, reuses identical reviews without another model call', async () => {
  const f = await fixture();
  const first = await reviewVideoClip(f.ctx, f.args);
  expect(f.renders.map(s => s.start)).toEqual([6.6, 3.8, 3.8]);
  expect(f.renders[1].html).toBe('old'); expect(f.renders[2].html).toBe('new');
  expect(f.requests[0].videos.filter(p => p.type === 'video_url')).toHaveLength(3);
  expect(f.requests[0].videos.some(p => p.type === 'image_url')).toBe(false);
  expect(first.assessment.ready_to_adopt).toBe(true);
  expect(JSON.stringify(first)).not.toContain('base64');
  f.ctx.candidates = pageCandidates(f.root, 'a'.repeat(32));
  expect((await f.ctx.candidates.get(f.candidate.id)).reviews).toHaveLength(1);
  expect((await reviewVideoClip(f.ctx, f.args)).cached).toBe(true);
  expect(f.requests).toHaveLength(1); expect(f.ctx.reviewBudget.calls).toBe(1);
  await reviewVideoClip(f.ctx, { ...f.args, instructions: '单独检查顶部' });
  expect(f.requests).toHaveLength(2);
  await expect(pageCandidates(f.root, 'c'.repeat(32)).get(f.candidate.id)).rejects.toMatchObject({ code: 'preview_not_found' });
});

it('refuses stale or unreadable sources before a paid request and never fabricates an accepted verdict', async () => {
  const f = await fixture();
  f.ctx.pages.read = async () => 'changed';
  await expect(reviewVideoClip(f.ctx, f.args)).rejects.toMatchObject({ code: 'page_conflict' });
  expect(f.renders).toHaveLength(0);
  f.ctx.pages.read = async () => 'old';
  f.ctx.vision.snapshot = () => ({ capabilities: [{ video: false }] });
  await expect(reviewVideoClip(f.ctx, f.args)).rejects.toMatchObject({ code: 'video_unavailable' });
  expect(f.requests).toHaveLength(0);
  expect(parseVideoReview(JSON.stringify({ ...assessment, decision: 'regressed' })).ready_to_adopt).toBe(false);
  expect(() => parseVideoReview('看不清，但应该好了')).toThrow('完整的结论');
});

it('does not count repeated focus on the same candidate as two failed candidates and stops after two distinct failures', async () => {
  const f = await fixture();
  f.ctx.vision.ask = async () => JSON.stringify({ ...assessment, decision: 'unchanged', ready_to_adopt: false });
  await reviewVideoClip(f.ctx, f.args);
  await reviewVideoClip(f.ctx, { ...f.args, instructions: '复查顶部' });
  expect(f.ctx.reviewBudget.noImprovement).toBe(1);
  const identical = await f.ctx.candidates.add({ ...f.candidate });
  await reviewVideoClip(f.ctx, { ...f.args, preview_id: identical.id, instructions: '相同内容新编号' });
  expect(f.ctx.reviewBudget.noImprovement).toBe(1);
  const next = await f.ctx.candidates.add({ ...f.candidate, html: 'new2' });
  await reviewVideoClip(f.ctx, { ...f.args, preview_id: next.id });
  expect(f.ctx.reviewBudget.noImprovement).toBe(2);
  await expect(reviewVideoClip(f.ctx, { ...f.args, instructions: '继续' })).rejects.toMatchObject({ code: 'review_limit' });
  expect((await reviewVideoClip(f.ctx, f.args)).cached).toBe(true);
});

it('reviews transparent pages in their timeline composite and rejects missing or changing composition', async () => {
  const f = await fixture();
  await f.ctx.candidates.put({ ...f.candidate, transparent: true });
  await expect(reviewVideoClip(f.ctx, f.args)).rejects.toMatchObject({ code: 'review_composition_required' });
  expect(f.renders).toHaveLength(0); expect(f.requests).toHaveLength(0);
  const scene = { key: 'scene-key', clipId: 'mask-clip', start: 5.8 };
  f.ctx.reviewClips.composition = async () => scene;
  const render = f.ctx.reviewClips.render;
  f.ctx.reviewClips.render = async source => ({ ...await render(source), composition: source.project ? scene : undefined });
  const result = await reviewVideoClip(f.ctx, f.args);
  expect(f.renders.slice(1).every(r => r.project && r.clipId === 'mask-clip')).toBe(true);
  expect(result.composition).toEqual(scene);
  expect((await f.ctx.candidates.get(f.candidate.id)).reviews.at(-1).composition).toEqual(scene);
  expect(f.requests[0].prompt).toContain('底层连续视频被固定遮罩逐步揭开');
  const reviewed = await f.ctx.candidates.get(f.candidate.id), project = await f.ctx.store.getProject();
  await expect(requireCurrentVideoReview(reviewed, project, f.ctx.reviewClips)).resolves.toBeUndefined();
  f.ctx.reviewClips.composition = async () => ({ ...scene, key: 'changed' });
  await expect(requireCurrentVideoReview(reviewed, project, f.ctx.reviewClips)).rejects.toMatchObject({ code: 'video_review_required' });
  f.ctx.reviewClips.composition = async () => scene;
  await expect(requireCurrentVideoReview({ ...reviewed, reviews: [{ ...assessment, start: 3.8, duration: 2.2 }] }, project, f.ctx.reviewClips)).rejects.toMatchObject({ code: 'video_review_required' });
  f.ctx.reviewClips.render = async source => ({ ...await render(source), composition: { ...scene, key: 'changed' } });
  await expect(reviewVideoClip(f.ctx, { ...f.args, instructions: '再检查' })).rejects.toMatchObject({ code: 'page_conflict' });
  expect(f.requests).toHaveLength(1);
});

it('retains only six candidates without changing their exact HTML or another session', async () => {
  const f = await fixture();
  for (let i = 0; i < 7; i++) await f.ctx.candidates.add({ ...f.candidate, html: `candidate${i}` });
  expect(await f.ctx.candidates.list()).toHaveLength(6);
  expect(await readFile(path.join(f.root, 'candidates', 'a'.repeat(32), (await f.ctx.candidates.list())[0].id + '.json'), 'utf8')).toContain('candidate');
});
