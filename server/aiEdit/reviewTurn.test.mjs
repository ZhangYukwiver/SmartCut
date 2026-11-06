import { describe, expect, it, vi } from 'vitest';
import { runConversation } from './chat.mjs';
import { createReviewGate, runReviewedConversation } from './reviewTurn.mjs';

function fixture() {
  const state = { html: 'draft', scene: 'scene-1', project: { canvas: { width: 1920, height: 1080, fps: 30 }, tracks: [{ segments: [{ id: 'clip', path: 'page', timeline: { start_us: 0, duration_us: 8e6 } }] }] } };
  const candidate = { id: 'preview', pageId: 'page', html: 'draft', original: 'draft' };
  const budget = { calls: 1, noImprovement: 0 };
  const gate = createReviewGate({ store: { getProject: async () => state.project }, projectId: 'project', candidates: { get: async () => candidate }, pages: { read: async () => state.html }, reviewClips: { composition: async () => ({ key: state.scene }) }, budget });
  const review = { ok: true, mode: 'goal', preview_id: 'preview', composition: { key: 'scene-1', start: 0, clipId: 'clip' }, verification: { start: 0, duration: 8 },
    assessment: { ready_to_deliver: false, goal: { status: 'uncertain', criteria: [{ requirement: '幕布随节拍变化', status: 'uncertain', evidence: '未见明显变化' }] }, remaining: ['文字仍是平面叠加，需贴合幕布曲面'] },
    audible: { lyric_accuracy: { status: 'uncertain', uncertain_words: [{ alternatives: ['fool', 'wall'] }], confirmed_differences: [] }, synchronization: { status: 'uncertain', late_or_early: [], missing_highlights: [], uncertain_timings: [{ word: 'when' }] } } };
  return { state, candidate, budget, gate, review, observe: () => gate.observe('review_video_clip', structuredClone(review)) };
}
const options = (gate, converse, extra = {}) => ({ reviewGate: gate, converse, history: [{ role: 'user', content: '歌词放在透明隧道幕布上' }], maxToolCalls: 20, ...extra });

describe('application-controlled review continuation', () => {
  it('continues after the recorded failure pattern, then accepts a corrected and reviewed current page', async () => {
    const f = fixture(), prompts = [], limits = [];
    const history = [{ role: 'user', content: '原始要求' }];
    const converse = vi.fn(async opts => {
      prompts.push(await opts.context()); limits.push(opts.maxToolCalls);
      if (prompts.length === 2) { f.state.html = f.candidate.html = 'curved'; f.state.scene = f.review.composition.key = 'scene-2'; f.review.assessment.ready_to_deliver = true; }
      f.observe();
      opts.history.push({ role: 'assistant', content: prompts.length === 1 ? '做好了但有问题' : '已修正并复核' });
      return { text: opts.history.at(-1).content, toolCalls: 3 };
    });
    const result = await runReviewedConversation(options(f.gate, converse, { history }));
    expect(converse).toHaveBeenCalledTimes(2);
    expect(prompts[1]).toContain('文字仍是平面');
    expect(prompts[1]).toContain('不是用户追加消息');
    expect(prompts[1]).toContain('不重听同一素材');
    expect(limits).toEqual([20, 17]);
    expect(result).toEqual({ text: '已修正并复核', toolCalls: 6 });
    expect(history.filter(e => e.role === 'user')).toHaveLength(1);
  });

  it('does not reopen a completed review or interfere with a non-editing conversation', async () => {
    const f = fixture();
    expect(await f.gate.check()).toBeNull();
    f.review.assessment.ready_to_deliver = true; f.observe();
    expect(await f.gate.check()).toBeNull();
  });

  it('stops without re-listening when only unresolved audio evidence remains', async () => {
    const f = fixture(); f.review.assessment.goal.criteria[0].status = 'pass'; f.observe();
    const converse = vi.fn(async () => ({ text: '全部做好了', toolCalls: 1 }));
    const result = await runReviewedConversation(options(f.gate, converse));
    expect(converse).toHaveBeenCalledTimes(1);
    expect(result.text).toContain('1 处唱词分歧、1 个不确定时间点');
    expect(result.text).not.toContain('全部做好了');
  });

  it('stops after passing only a partial reviewed range', async () => {
    const f = fixture();
    f.state.project.tracks[0].segments[0].timeline.duration_us = 20e6;
    f.review.assessment.goal.criteria[0].status = 'pass'; f.review.assessment.goal.status = 'pass'; f.observe();
    const result = await f.gate.check();
    expect(result.notice).toContain('本次区间目标已通过');
    expect(result.notice).toContain('完整成片仍未验收');
    expect(f.review.assessment.ready_to_deliver).toBe(false);
  });

  it('continues for confirmed timing errors even if other words remain uncertain', async () => {
    const f = fixture(); f.review.assessment.goal.criteria[0].status = 'pass';
    f.review.audible.synchronization.late_or_early = [{ word: 'beat', delta_ms: 400 }]; f.observe();
    expect((await f.gate.check()).prompt).toContain('400');
  });

  it('requires adoption and refuses a passing review after the composition changes', async () => {
    const f = fixture(); f.candidate.html = 'curved'; f.review.assessment.ready_to_deliver = true; f.observe();
    expect((await f.gate.check()).prompt).toContain('尚未保存');
    f.state.html = 'curved'; f.state.scene = 'scene-2';
    expect((await f.gate.check()).prompt).toContain('验收后发生变化');
  });

  it('stops a repeated finish without new evidence instead of resetting the retry budget', async () => {
    const f = fixture(); f.observe();
    const converse = vi.fn(async () => ({ text: '仍然结束', toolCalls: 0 }));
    const result = await runReviewedConversation(options(f.gate, converse));
    expect(converse).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('没有新的有效修改或验收证据');
  });

  it('does not count a new preview id or a different model verdict on identical media as progress', async () => {
    const f = fixture(); let n = 0;
    const converse = vi.fn(async () => { f.review.preview_id = `preview-${++n}`; f.review.assessment.remaining = [`换个说法 ${n}`]; f.observe(); return { text: '未修改', toolCalls: 2 }; });
    const result = await runReviewedConversation(options(f.gate, converse));
    expect(converse).toHaveBeenCalledTimes(2);
    expect(result.text).toContain('没有新的有效修改或验收证据');
  });

  it('does not abandon a visually corrected candidate just because audio remains unresolved', async () => {
    const f = fixture(); f.candidate.html = 'curved'; f.review.assessment.goal.criteria[0].status = 'pass'; f.observe();
    expect((await f.gate.check()).prompt).toContain('真实合成对照');
    f.candidate.reviews = [{ decision: 'improved', ready_to_adopt: true, regressions: [] }];
    expect((await f.gate.check()).prompt).toContain('write_page');
  });

  it('respects the shared review limit and user cancellation', async () => {
    const f = fixture(); f.observe(); f.budget.calls = 4;
    expect((await f.gate.check()).notice).toContain('复核上限');
    const controller = new AbortController();
    const converse = vi.fn(async () => { controller.abort(); return { text: '停', toolCalls: 1 }; });
    await expect(runReviewedConversation(options(f.gate, converse, { signal: controller.signal }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(converse).toHaveBeenCalledTimes(1);
  });

  it('caps three automatic continuations even when every attempt has a different state', async () => {
    const f = fixture(); let n = 0;
    const converse = vi.fn(async () => { f.state.html = f.candidate.html = `draft-${++n}`; f.observe(); return { text: '未完成', toolCalls: 1 }; });
    const result = await runReviewedConversation(options(f.gate, converse));
    expect(converse).toHaveBeenCalledTimes(4);
    expect(result.text).toContain('自动修正已到本轮上限');
  });

  it('continues the real API loop without adding a user message or re-executing earlier tools', async () => {
    const f = fixture(), requests = [], executed = [];
    const replies = [
      { content: null, tool_calls: [{ id: 'review-1', type: 'function', function: { name: 'review_video_clip', arguments: '{}' } }] },
      { content: '已完成' },
      { content: null, tool_calls: [{ id: 'fix', type: 'function', function: { name: 'write_page', arguments: '{}' } }, { id: 'review-2', type: 'function', function: { name: 'review_video_clip', arguments: '{}' } }] },
      { content: '修正后验收通过' },
    ];
    const opts = options(f.gate, runConversation, {
      config: { baseUrl: 'https://test.invalid/v1', apiKey: 'test', model: 'test' }, tools: [], system: async () => 'system',
      fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); const message = replies.shift(); if (!message) throw Error('Unexpected extra model request'); return Response.json({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }); },
      execute: async call => { executed.push(call.name); if (call.name === 'write_page') { f.state.html = f.candidate.html = 'curved'; f.review.assessment.ready_to_deliver = true; } else f.observe(); return { ok: true }; },
    });
    const result = await runReviewedConversation(opts);
    expect(result.text).toBe('修正后验收通过');
    expect(executed).toEqual(['review_video_clip', 'write_page', 'review_video_clip']);
    expect(requests[2].messages.at(-1).content).toContain('应用自主验收反馈');
    expect(opts.history.filter(e => e.role === 'user')).toHaveLength(1);
  });
});
