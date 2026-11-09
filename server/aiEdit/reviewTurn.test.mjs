import { expect, it, vi } from 'vitest';
import { createReviewGate, reviewIntent, runReviewedConversation } from './reviewTurn.mjs';

function setup(session, text = '制作一版') {
  return createReviewGate({ session, intent: reviewIntent(text), projectId: 'p',
    store: { getProject: async () => ({ tracks: [{ segments: [{ id: 'clip', timeline: { start_us: 0, duration_us: 20e6 }, path: 'page' }] }] }) },
    library: { idForPath: s => s }, candidates: { get: async () => ({ pageId: 'page', html: 'current' }) },
    pages: { read: async () => 'current' }, reviewClips: { composition: async ({ start }) => ({ key: 'current', start }) } });
}
const review = (mode, status, start, duration) => ({ ok: true, mode, preview_id: 'candidate',
  composition: { key: 'current', clipId: 'clip', start }, verification: { start, duration },
  assessment: { summary: '检查字幕', goal: { status, criteria: [{ requirement: '字幕可读', status, evidence: '观察字幕边界' }] } } });

it.each(['fail', 'uncertain'])('holds the actual tools, even when a repair is already queued after a %s review', async status => {
  const session = {}, gate = setup(session), history = [];
  const execute = vi.fn(async () => review('segment', status, 5, 2));
  const converse = vi.fn(async opts => {
    const [, write] = await Promise.all(['review_video_clip', 'write_page'].map(name => opts.execute({ name, arguments: '{}' })));
    expect(write.code).toBe('review_confirmation_required');
    return { text: '完成', toolCalls: 2 };
  });
  const result = await runReviewedConversation({ reviewGate: gate, converse, execute, history, maxToolCalls: 20 });
  expect(converse).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(result.text).toContain('5–7 秒');
  expect(result.text).toContain('观察字幕边界');
  const restored = JSON.parse(JSON.stringify(session));
  expect(setup(restored, '为什么要确认修改？').allow('write_page', {})).toContain('确认修改');
  expect(setup(restored, '确认修改：只调字幕').allow('write_page', {})).toBeNull();
});

it('requests only a read-only local review when the model finishes a page without checking it', async () => {
  const gate = setup({});
  gate.observe('write_page', { ok: true, media_id: 'page' });
  expect((await gate.check()).prompt).toContain('2–4 秒');
  expect(gate.allow('preview_page', { page_id: 'page', patches: [] })).toContain('只执行复核');
  expect(gate.allow('preview_page', { page_id: 'page' })).toBeNull();
  gate.observe('review_video_clip', review('segment', 'pass', 13, 3));
  expect((await gate.check()).notice).toContain('13–16 秒');
});

it('checks every final interval without writing, and keeps a failed interval in the final report', async () => {
  for (const status of ['pass', 'fail']) {
    const gate = setup({}, '定稿验收');
    expect(gate.allow('write_shared_file', {})).toContain('只执行复核');
    gate.observe('review_video_clip', review('goal', status, 0, 9));
    gate.observe('review_video_clip', review('goal', 'pass', 10, 10));
    expect((await gate.check()).prompt).toContain('9 秒起');
    gate.observe('review_video_clip', review('goal', 'pass', 9, 1));
    const { notice, prompt } = await gate.check();
    expect(prompt).toBeUndefined();
    expect(notice).toContain(status === 'pass' ? '均已通过' : '确认修改');
  }
});

it('reviews native timeline edits and accepts current-timeline evidence without a page candidate', async () => {
  const session = {}, gate = setup(session, '确认修改');
  gate.observe('update_clip', { ok: true, total_duration: 20 }, { clip_id: 'clip' });
  expect((await gate.check()).prompt).toContain('timeline=true');
  const r = { ...review('segment', 'pass', 3, 2), preview_id: undefined, timeline: true };
  gate.observe('review_video_clip', r);
  expect((await gate.check()).notice).toContain('3–5 秒');
});

it('keeps the reviewed page candidate when a second revision is attempted from still-frame feedback', () => {
  const session = {}, gate = setup(session);
  gate.observe('preview_page', { preview_id: 'one' }, { page_id: 'page', html: 'version one' });
  expect(gate.allow('review_video_clip', { preview_id: 'one' })).toBeNull();
  expect(gate.allow('preview_page', { page_id: 'page', patches: [] })).toContain('再次调整前请确认');
  expect(session.pendingReview).toBe(true);
});
