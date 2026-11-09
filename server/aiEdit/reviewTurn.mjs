const readTools = new Set(['get_timeline', 'list_media', 'get_clip', 'read_page', 'read_shared_file',
  'get_page_candidates', 'list_keyframes', 'list_markers', 'search_catalog', 'read_skill']);
const reviewTools = new Set(['review_video_clip', 'review_video_frames', 'check_page_bounds', 'review_timeline']);
const confirmation = '如需返工，请回复「确认修改」，也可在冒号后写明要改的项目。';

export function reviewIntent(text) {
  if (/^(?:请)?(?:定稿验收|定稿|最终验收|完整对照)[。！!]?$/u.test(text.trim())) return 'final';
  if (/^确认修改(?:[。！!]|[：:][\s\S]+)?$/u.test(text.trim())) return 'repair';
  return 'edit';
}

// Only an incoming user turn can authorize repairs. A tool result or continuation cannot.
export function createReviewGate({ session, intent, store, projectId, candidates, pages, reviewClips, library }) {
  const final = intent === 'final';
  const reviews = [];
  const findings = new Map();
  const writtenMedia = new Set();
  const previewedPages = new Set();
  const changedClips = new Set();
  let timelineEdited = false;
  let stopped = '', reviewOnly = false, replicaReviewed = false, calibrated = false;
  function hold(reason) {
    session.pendingReview = true;
    stopped = [reason, confirmation].join('\n');
  }
  return {
    isStopped: () => Boolean(stopped),
    markIncomplete() { session.pendingReview = true; },
    allow(name, args) {
      if (stopped) return stopped;
      if (readTools.has(name)) return null;
      const inspecting = reviewTools.has(name) || (name === 'preview_page' && args?.page_id && args.html === undefined && args.patches === undefined);
      if (final || reviewOnly) return inspecting ? null : '当前只执行复核。' + confirmation;
      if (session.pendingReview && intent !== 'repair') return '当前有待确认的验收问题。' + confirmation;
      if (args?.page_id && previewedPages.has(args.page_id) && ['preview_page', 'write_page'].includes(name)
        && (args.html !== undefined || args.patches !== undefined)) {
        hold('本轮页面候选已预览。再次调整前请确认。');
        return stopped;
      }
      if (name === 'refine_reference' && (intent !== 'repair' || calibrated)) return confirmation;
      if ((replicaReviewed || calibrated) && !inspecting) return '本轮复核已结束。' + confirmation;
      if (reviews.length && !inspecting) {
        const last = reviews.at(-1);
        if (name !== 'write_page' || !last.assessment.ready_to_adopt || !last.preview_id || args?.preview_id !== last.preview_id) {
          return '本轮复核已结束。' + confirmation;
        }
      }
      return null;
    },
    observe(name, result, args) {
      if (name === 'preview_page' && result.preview_id && args?.page_id && (args.html !== undefined || args.patches !== undefined)) {
        previewedPages.add(args.page_id);
      }
      if (name === 'review_timeline' && result.ok) reviewOnly = true;
      if (!final && name === 'check_page_bounds' && result.boundaries && result.boundaries.status !== 'pass') {
        const bounds = result.boundaries;
        hold(`已检查 ${bounds.start}–${Number((bounds.start + bounds.duration).toFixed(3))} 秒的文字边界，`
          + (bounds.status === 'fail' ? `${bounds.violating_frames} 帧存在裁字。` : '现有证据无法确认文字完整。'));
      }
      if (intent === 'repair' && result.ok && result.total_duration > 0 && !readTools.has(name) && !reviewTools.has(name)
        && !['replicate_reference', 'refine_reference', 'create_track', 'rename_project'].includes(name)) {
        timelineEdited = true;
        for (const id of [args?.clip_id, result.clip_id, ...(result.clip_ids ?? [])]) if (id) changedClips.add(id);
      }
      if (name === 'refine_reference') calibrated = true;
      if (name === 'replicate_reference' && result.ok && result.verification) {
        replicaReviewed = true;
        if (result.verification.final?.meanError > 0.12) hold(result.note || '首版与参考仍有差异。');
      }
      if (name === 'write_page' && result.ok !== false) writtenMedia.add(result.media_id);
      if (name !== 'review_video_clip') return;
      // Inspecting source footage before the first edit isn't review of a candidate.
      if (args?.media_id && !writtenMedia.has(args.media_id) && !library.get(args.media_id)?.source?.pageId) return;
      if (result.ok === false) {
        if (['video_unavailable', 'vision_unavailable', 'review_composition_required', 'review_composition_unsupported', 'review_limit', 'review_incomplete'].includes(result.code)) hold(result.message);
        return;
      }
      const a = result.assessment;
      if (!a) return;
      reviews.push(result);
      const passed = result.mode === 'comparison' ? a.ready_to_adopt : a.goal?.status === 'pass';
      if (!passed) {
        const start = result.composition?.start ?? result.verification.start;
        const issues = (a.goal?.criteria ?? []).filter(c => c.status !== 'pass').map(c => c.requirement + '：' + c.evidence);
        const details = [...new Set([a.summary, ...issues, ...(a.regressions ?? []), ...(a.remaining ?? [])].filter(Boolean))];
        const finding = `已复核 ${start}–${Number((start + result.verification.duration).toFixed(3))} 秒，${a.goal?.status === 'fail' || a.decision === 'regressed' ? '未通过' : '仍有待确认项'}。\n${details.join('\n')}`;
        if (final) { findings.set(result, finding); session.pendingReview = true; }
        else hold(finding);
      }
    },
    async check() {
      if (stopped) return { notice: stopped };
      if (!final && !reviews.length && !writtenMedia.size && !timelineEdited) return null;
      const project = await store.getProject(projectId);
      const tracks = (project.tracks ?? []).flatMap(t => t.segments ?? []);
      if (!final && !reviews.length && !timelineEdited && !tracks.some(s => s.path && writtenMedia.has(library.idForPath(s.path)))) return null;
      const end = Math.max(0, ...tracks.map(s => (s.timeline.start_us + s.timeline.duration_us) / 1e6));
      const windows = [], currentFindings = [], reviewedMedia = new Set();
      for (const r of reviews) {
        if ((!r.preview_id && !r.timeline) || !r.composition) continue;
        if (final && r.mode !== 'goal') continue;
        try {
          const c = r.timeline ? null : await candidates.get(r.preview_id);
          if (c && await pages.read(c.pageId) !== c.html) continue;
          const scene = await reviewClips.composition({ project, pageId: c?.pageId, html: c?.html, timeline: r.timeline, clipId: r.composition.clipId,
            start: r.verification.start, duration: r.verification.duration });
          if (scene?.key === r.composition.key) {
            windows.push([scene.start, scene.start + r.verification.duration]);
            if (writtenMedia.size) {
              const clip = tracks.find(s => s.id === r.composition.clipId);
              if (clip?.path) reviewedMedia.add(library.idForPath(clip.path));
            }
            if (findings.has(r)) currentFindings.push(findings.get(r));
          }
        } catch { /* An obsolete candidate cannot certify the current timeline. */ }
      }
      const missing = tracks.filter(s => s.path && writtenMedia.has(library.idForPath(s.path)) && !reviewedMedia.has(library.idForPath(s.path))
        && !windows.some(([a,b]) => s.timeline.start_us / 1e6 < b && (s.timeline.start_us + s.timeline.duration_us) / 1e6 > a));
      if (!final && reviews.length && !missing.length) {
        if (intent === 'repair' && windows.length) delete session.pendingReview;
        if (!windows.length) {
          hold('已复核候选，当前时间线尚无对应的有效复核结果。');
          return { notice: stopped };
        }
        const ranges = windows.map(([from,to]) => `${from}–${Number(to.toFixed(3))} 秒`).join('、');
        return { notice: `本轮局部复核通过（${ranges}）。${reviews.at(-1).assessment.summary}\n定稿时可发起「定稿验收」。` };
      }
      if (final && !end) return { notice: '时间线为空，尚无成片可验收。' };
      let covered = 0;
      for (const [from, to] of windows.sort((a, b) => a[0] - b[0])) {
        if (from > covered + 1e-6) break;
        covered = Math.max(covered, to);
      }
      if (final && covered >= end - 1e-6) {
        if (currentFindings.length) return { notice: [`已检查完整时间线 0–${end} 秒。`, ...currentFindings, confirmation].join('\n') };
        delete session.pendingReview;
        return { notice: `已完成定稿验收，当前时间线 0–${end} 秒的目标检查均已通过。` };
      }
      reviewOnly = true;
      const touched = tracks.filter(s => changedClips.has(s.id)).map(s =>
        `${s.id}（${s.timeline.start_us / 1e6}–${(s.timeline.start_us + s.timeline.duration_us) / 1e6} 秒）`);
      return final
        ? { prompt: `继续只读定稿验收。从时间线 ${Math.min(covered, Math.max(0, end - 0.5))} 秒起，用 review_video_clip(timeline=true,mode=goal,start,duration) 检查至 ${end} 秒，每段最多12秒，按参考区间拆分，覆盖剩余全片。`,
          notice: [`定稿验收未完成。从片头连续验收到 ${covered} 秒，全片 ${end} 秒。`, ...currentFindings, ...(currentFindings.length ? [confirmation] : [])].join('\n') }
        : { prompt: `请按本轮实际改动选取对应的时间，使用 review_video_clip(timeline=true,mode=segment,start,duration) 复核改动前后 2–4 秒，然后报告。涉及片段：${[...touched, ...missing.map(s => s.id)].join('、')}。不要修改工程。`,
          notice: '当前版本已保留，改动区间尚未完成复核。' };
    },
  };
}

export async function runReviewedConversation({ converse, reviewGate, execute, ...options }) {
  // CLI tool calls can overlap. A queued edit must see the preceding review verdict.
  let queue = Promise.resolve();
  const run = call => {
    const done = queue.then(async () => {
      options.signal?.throwIfAborted();
      let args = call.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      const blocked = reviewGate.allow(call.name, args);
      if (blocked) return { ok: false, code: 'review_confirmation_required', message: blocked };
      const output = await execute(call);
      reviewGate.observe(call.name, output, args);
      return output;
    });
    queue = done.catch(() => {});
    return done;
  };
  let calls = 0, continuation = '';
  const seen = new Set();
  for (;;) {
    options.signal?.throwIfAborted();
    const result = await converse({ ...options, execute: run, stopAfterTools: reviewGate.isStopped, maxToolCalls: options.maxToolCalls - calls, continuation,
      context: async () => [await options.context?.(), continuation].filter(Boolean).join('\n\n') });
    await queue;
    options.signal?.throwIfAborted();
    calls += result.toolCalls;
    const next = await reviewGate.check();
    if (!next) return { ...result, toolCalls: calls };
    if (!next.prompt || seen.has(next.prompt) || calls >= options.maxToolCalls) {
      if (next.prompt) reviewGate.markIncomplete();
      options.history.push({ role: 'assistant', content: next.notice });
      options.onText?.(next.notice);
      return { ...result, text: next.notice, toolCalls: calls };
    }
    continuation = next.prompt;
    seen.add(continuation);
  }
}
