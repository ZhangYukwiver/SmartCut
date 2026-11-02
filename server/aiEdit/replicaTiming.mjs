export const MAX_REVIEW_FRAMES = 21_600;
const local = s => s.localError ?? s.error;
const temporal = s => s.temporalError ?? 0;
const frameScore = s => .3 * s.error + .4 * local(s) + .3 * temporal(s);

/** 每个短窗口保留前后相邻帧；时间跨度按源帧而非固定秒数计算，末帧也可入选。 */
export function temporalWindows(samples, limit = 4) {
  const ranked = samples.map((s, i) => {
    const neighbor = Math.min(local(samples[Math.max(0, i - 1)]), local(samples[Math.min(samples.length - 1, i + 1)]));
    return { index: i, priority: Math.max(temporal(s), Math.max(0, local(s) - neighbor)) };
  }).filter(s => s.priority > .002).sort((a, b) => b.priority - a.priority);
  const windows = [];
  for (const item of ranked) {
    if (windows.some(w => Math.abs(w.peak - item.index) <= 3)) continue;
    // 留出后续恢复状态，避免只修峰值附近两帧、下一次 replace 又跳回旧轮廓。
    windows.push({ peak: item.index, start: Math.max(0, item.index - 2), end: Math.min(samples.length - 1, item.index + 7), error: item.priority });
    if (windows.length === limit) break;
  }
  return windows.sort((a, b) => a.start - b.start);
}

const score = e => .3 * e.meanError + .4 * (e.localError ?? e.meanError) + .3 * (e.temporalError ?? 0);
const regressed = (a, b) => frameScore(b) > frameScore(a) + Math.max(.003, frameScore(a) * .08)
  || local(b) > local(a) + Math.max(.005, local(a) * .08)
  || temporal(b) > temporal(a) + Math.max(.005, temporal(a) * .08);

/** 给下一轮指出改坏的具体帧，而不只给一个全片均值。验收门槛与 improvesFrameReview 共用。 */
export function frameReviewDiagnostics(before, after) {
  const frames = after.samples.map((b, i) => {
    const a = before.samples[i];
    if (!a) return null;
    return { frame: b.frame ?? i, t: b.t, regressed: regressed(a, b),
      before: { error: a.error, localError: local(a), temporalError: temporal(a) },
      after: { error: b.error, localError: local(b), temporalError: temporal(b) },
      delta: frameScore(b) - frameScore(a) };
  }).filter(Boolean);
  return { improvedFrames: frames.filter(f => f.delta < -.00001).length, regressedFrames: frames.filter(f => f.regressed).length,
    worst: frames.filter(f => f.delta > .00001 || f.regressed).sort((a, b) => b.delta - a.delta).slice(0, 5) };
}

export function improvesFrameReview(before, after) {
  if (before.coverage !== after.coverage || before.samples.length !== after.samples.length || !before.samples.length) return false;
  if (before.coverage === 'all-frames' && (before.frameCount !== after.frameCount || before.frameCount !== before.samples.length)) return false;
  for (let i = 0; i < before.samples.length; i++) {
    const a = before.samples[i], b = after.samples[i];
    if (Math.abs(a.t - b.t) > .000001 || (a.duration !== undefined && Math.abs(a.duration - b.duration) > .000001)) return false;
    // 全片平均数下降不能掩盖新出现的一帧闪变或局部坏帧。
    if (before.coverage === 'all-frames' && regressed(a, b)) return false;
  }
  return score(after) < score(before) - .00001 / before.samples.length
    && after.meanError <= before.meanError * 1.01 + .0001
    && (after.localError ?? after.meanError) <= (before.localError ?? before.meanError) * 1.01 + .0001
    && (after.temporalError ?? 0) <= (before.temporalError ?? 0) * 1.01 + .0001
    && after.worstError <= before.worstError + Math.max(.002, before.worstError * .02);
}
