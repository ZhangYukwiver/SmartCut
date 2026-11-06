import { createHash } from 'node:crypto';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const AUDIO_CRITERIA = new Set(['唱词准确性（独立听音核对）', '听感同步（实际亮词与声学时序）']);
const unavailable = new Set(['video_unavailable', 'review_composition_unsupported', 'review_limit', 'review_incomplete']);
const pending = '验收尚未通过，当前工程保留为待核实版本，不能作为全部达标的成片。';

// One controller per user turn: tools and automatic continuations share the same
// review budget, actual project and audio cache. Feedback is never a user message.
export function createReviewGate({ store, projectId, candidates, pages, reviewClips, budget, library }) {
  let touched = false, latest = null, failure = null;
  const writtenMedia = new Set();
  return {
    observe(name, result) {
      if (name === 'write_page' && result.ok !== false) { touched = true; writtenMedia.add(result.media_id); }
      if (name !== 'review_video_clip') return;
      if (result.ok === false) {
        if (unavailable.has(result.code)) failure = result.message;
        return;
      }
      if (result.mode === 'goal') { touched = true; latest = result; failure = null; }
    },
    async check() {
      if (!touched) return null;
      const stop = reason => ({ notice: `${pending}\n${reason}` });
      if (failure) return stop(failure);
      const project = await store.getProject(projectId);
      if (!latest && library && !(project.tracks ?? []).flatMap(t => t.segments ?? []).some(s => s.path && writtenMedia.has(library.idForPath(s.path)))) return null;
      let candidate = null, liveHtml = null, scene = null;
      if (latest?.preview_id) {
        try {
          candidate = await candidates.get(latest.preview_id);
          liveHtml = await pages.read(candidate.pageId);
          scene = await reviewClips.composition({ project, pageId: candidate.pageId, html: candidate.html,
            clipId: latest.composition?.clipId, start: latest.verification?.start ?? 0, duration: latest.verification?.duration });
        } catch { /* A removed page or changed timeline needs a fresh preview. */ }
      }
      const fingerprint = hash({ canvas: project.canvas, tracks: project.tracks, html: liveHtml,
        candidate: candidate?.html, scene: scene?.key,
        review: latest && [latest.composition?.key, latest.verification?.start, latest.verification?.duration] });
      const more = prompt => {
        if (budget.calls >= 4 || budget.noImprovement >= 2) return stop('已达到本轮复核上限；保留当前版本及候选，不继续重听或重复评审。');
        return { fingerprint, prompt };
      };
      if (!latest || !candidate || !scene || scene.key !== latest.composition?.key
          || (liveHtml !== candidate.html && liveHtml !== candidate.original)) {
        return more('当前工程缺少有效的完整目标验收，或页面/时间线在验收后发生变化。读取当前工程，preview_page，再用 review_video_clip(mode="goal") 检查真实完整合成；不能拿旧候选的通过结论收尾。8–12秒以内检查全程，较长作品逐段检查并准确报告覆盖范围。');
      }
      const assessment = latest.assessment;
      if (assessment.ready_to_deliver === true) {
        if (liveHtml !== candidate.html) return more(`候选 ${latest.preview_id} 已通过，但尚未保存到时间线。用 write_page(preview_id="${latest.preview_id}") 采纳同一候选，再确认当前合成；不能交付旧页面。`);
        return null;
      }
      const visual = (assessment.goal?.criteria ?? []).filter(c => !AUDIO_CRITERIA.has(c.requirement) && c.status !== 'pass');
      const audible = latest.audible;
      const words = audible?.lyric_accuracy?.confirmed_differences ?? [];
      const timing = audible?.synchronization?.late_or_early ?? [];
      const missing = audible?.synchronization?.missing_highlights ?? [];
      const end = Math.max(0, ...(project.tracks ?? []).flatMap(t => t.segments ?? []).map(s => (s.timeline.start_us + s.timeline.duration_us) / 1e6));
      const full = latest.composition?.start <= 1e-6
        && latest.composition.start + (latest.verification?.duration ?? 0) >= end - 1e-6;
      if (assessment.goal?.status === 'pass' && !full) {
        const reviewStart = Number.isFinite(latest.composition?.start) ? latest.composition.start : (latest.verification?.start ?? 0);
        const reviewDuration = Number.isFinite(latest.verification?.duration) ? latest.verification.duration : 0;
        return stop(`本次区间目标已通过，但只覆盖 ${reviewStart.toFixed(3)}–${(reviewStart + reviewDuration).toFixed(3)} 秒，未覆盖完整 ${end.toFixed(3)} 秒时间线；完整成片仍未验收，ready_to_deliver 保持 false。长作品请继续分段复核并如实报告覆盖范围。`);
      }
      if (!visual.length && !words.length && !timing.length && !missing.length && full && audible) {
        if (liveHtml !== candidate.html) {
          const improved = candidate.reviews?.some(r => r.decision === 'improved' && r.ready_to_adopt && !r.regressions?.length);
          return more(improved
            ? `候选 ${latest.preview_id} 的可测画面已通过，真实对照也确认改善，但尚未保存。先 write_page(preview_id="${latest.preview_id}") 采纳并核对当前合成；音频分歧保留待核实，不再次盲听。`
            : `候选 ${latest.preview_id} 的可测画面已通过，但尚未确认比正式页改善。用真实合成对照确认改善且无回退后保存同一候选；音频分歧不能通过重复盲听消除，也不能让已修复画面只留在未采纳候选里。`);
        }
        return stop(`可测画面项目已通过，但音频仍有证据不足：${audible.lyric_accuracy?.uncertain_words?.length ?? 0} 处唱词分歧、${audible.synchronization?.uncertain_timings?.length ?? 0} 个不确定时间点。保留原始测量，不猜词、不凭低置信度挪动时序，也不重复听同一音轨博取通过。`);
      }
      return more(`当前目标验收未通过，不能只报告问题就结束。请在同一工程内依据以下证据修正，再预览、复核并保存有效候选；只处理用户要求内的问题，保留正常部分。\n${JSON.stringify({ preview_id: latest.preview_id, unmet_visual: visual, remaining: assessment.remaining, confirmed_lyric_differences: words, reliable_timing_errors: timing, missing_highlights: missing, full_timeline_covered: full })}\n音频中未确认的唱词或低置信度时间不属于确定可修正项，复用已有音频诊断，不重听同一素材抽取另一个答案。只有比较结果有实际改善且无回退才采纳修改；剩余不确定性单独报告。`);
    },
  };
}

// Both API and CLI runtimes can finish prematurely. Continue in the same turn,
// with a cumulative tool limit and a bounded number of distinct repair attempts.
export async function runReviewedConversation({ converse, reviewGate, onContinue = () => {}, ...options }) {
  let calls = 0, continuation = '', attempts = 0;
  const seen = new Set();
  const stop = (result, reason) => {
    const text = reason.startsWith(pending) ? reason : `${pending}\n${reason}`;
    options.history.push({ role: 'assistant', content: text });
    options.onText?.(text);
    return { ...result, text, toolCalls: calls };
  };
  for (;;) {
    options.signal?.throwIfAborted();
    const result = await converse({ ...options, maxToolCalls: options.maxToolCalls - calls, continuation,
      context: async () => [await options.context?.(), continuation && `【应用自主验收反馈，不是用户追加消息】\n${continuation}`].filter(Boolean).join('\n\n') });
    calls += result.toolCalls;
    options.signal?.throwIfAborted();
    const next = await reviewGate.check();
    if (!next) return { ...result, toolCalls: calls };
    if (next.notice) return stop(result, next.notice);
    if (calls >= options.maxToolCalls) return stop(result, '工具调用预算已用完，仍有目标未完成或未复核。');
    if (attempts >= 3) return stop(result, '自动修正已到本轮上限，仍有目标未通过。');
    if (seen.has(next.fingerprint)) return stop(result, '自动续跑后没有新的有效修改或验收证据，已停止重复尝试。');
    seen.add(next.fingerprint);
    continuation = next.prompt;
    attempts++;
    options.onText?.('验收未通过，正在依据证据继续修正…');
    await onContinue(attempts);
  }
}
