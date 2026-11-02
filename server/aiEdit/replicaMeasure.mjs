// 编号色块动画的测量器：AI 给对象与颜色线索，像素只用来测量几何/光照，工程不保存原片帧。
const area = p => p.reduce((s, v, i) => { const n = p[(i + 1) % p.length]; return s + v[0] * n[1] - n[0] * v[1]; }, 0) / 2;
const median = a => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] ?? 0; };
const rgb = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
function polygonMask(q, W, H) {
  const mask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let inside = false; const X = (x + .5) / W, Y = (y + .5) / H;
    for (let i = 0, j = q.length - 1; i < q.length; j = i++) if ((q[i][1] > Y) !== (q[j][1] > Y) && X < (q[j][0] - q[i][0]) * (Y - q[i][1]) / (q[j][1] - q[i][1]) + q[i][0]) inside = !inside;
    mask[y * W + x] = +inside;
  }
  return mask;
}
const linear = Array.from({ length: 256 }, (_, v) => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; });
function lab(r, g, b) {
  const R = linear[r], G = linear[g], B = linear[b], f = v => v > .008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116;
  const x = f((R * .4124564 + G * .3575761 + B * .1804375) / .95047), y = f(R * .2126729 + G * .7151522 + B * .072175), z = f((R * .0193339 + G * .119192 + B * .9503041) / 1.08883);
  return [(116 * y - 16) * 2.55 * .4, 500 * (x - y), 200 * (y - z)];
}
function morph(mask, W, H, radius, dilate) {
  const stride = W + 1, integral = new Int32Array((H + 1) * stride), out = new Uint8Array(mask.length);
  for (let y = 0; y < H; y++) { let row = 0; for (let x = 0; x < W; x++) { row += mask[y * W + x]; integral[(y + 1) * stride + x + 1] = integral[y * stride + x + 1] + row; } }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const l = Math.max(0, x - radius), r = Math.min(W, x + radius + 1), t = Math.max(0, y - radius), b = Math.min(H, y + radius + 1);
    const sum = integral[b * stride + r] - integral[t * stride + r] - integral[b * stride + l] + integral[t * stride + l];
    out[y * W + x] = +(dilate ? sum > 0 : sum === (r - l) * (b - t));
  }
  return out;
}
function components(mask, W, H, invert = false) {
  const ids = new Int32Array(mask.length), queue = new Int32Array(mask.length), groups = [];
  for (let start = 0; start < mask.length; start++) {
    if (ids[start] || Boolean(mask[start]) === invert) continue;
    const id = groups.length + 1, g = { id, count: 0, x0: W, y0: H, x1: 0, y1: 0, border: false };
    let read = 0, write = 1; queue[0] = start; ids[start] = id;
    while (read < write) {
      const p = queue[read++], x = p % W, y = Math.floor(p / W); g.count++; g.x0 = Math.min(g.x0, x); g.x1 = Math.max(g.x1, x); g.y0 = Math.min(g.y0, y); g.y1 = Math.max(g.y1, y);
      if (!x || !y || x === W - 1 || y === H - 1) g.border = true;
      for (const n of [x ? p - 1 : -1, x < W - 1 ? p + 1 : -1, y ? p - W : -1, y < H - 1 ? p + W : -1]) {
        if (n < 0 || ids[n] || Boolean(mask[n]) === invert) continue; ids[n] = id; queue[write++] = n;
      }
    }
    groups.push(g);
  }
  return { ids, groups };
}
function clean(mask, pixels, W, H) {
  let out = morph(morph(morph(morph(mask, W, H, 2, true), W, H, 2, false), W, H, 1, false), W, H, 1, true);
  const cc = components(out, W, H), keep = new Set(cc.groups.filter(g => g.count > W * H * .008).map(g => g.id));
  for (let i = 0; i < out.length; i++) out[i] = +keep.has(cc.ids[i]);
  const holes = components(out, W, H, true), white = new Int32Array(holes.groups.length + 1);
  for (let i = 0; i < out.length; i++) if (holes.ids[i]) { const p = i * 4, lo = Math.min(pixels[p], pixels[p + 1], pixels[p + 2]), hi = Math.max(pixels[p], pixels[p + 1], pixels[p + 2]); if (lo > 180 && hi - lo < 60) white[holes.ids[i]]++; }
  const fill = new Set(holes.groups.filter(g => !g.border && (g.count < W * H * .01 || white[g.id] / g.count > .3)).map(g => g.id));
  for (let i = 0; i < out.length; i++) if (fill.has(holes.ids[i])) out[i] = 1;
  return out;
}
function simplifyLine(p, tolerance) {
  if (p.length < 3) return p;
  const a = p[0], b = p.at(-1), dx = b[0] - a[0], dy = b[1] - a[1], den = dx * dx + dy * dy;
  let max = 0, at = 0;
  for (let i = 1; i < p.length - 1; i++) { const t = den ? Math.max(0, Math.min(1, ((p[i][0] - a[0]) * dx + (p[i][1] - a[1]) * dy) / den)) : 0; const d = Math.hypot(p[i][0] - a[0] - t * dx, p[i][1] - a[1] - t * dy); if (d > max) { max = d; at = i; } }
  return max > tolerance ? [...simplifyLine(p.slice(0, at + 1), tolerance).slice(0, -1), ...simplifyLine(p.slice(at), tolerance)] : [a, b];
}
function simplifyClosed(p, tolerance) {
  let at = 1, far = 0;
  for (let i = 1; i < p.length; i++) { const d = (p[i][0] - p[0][0]) ** 2 + (p[i][1] - p[0][1]) ** 2; if (d > far) { far = d; at = i; } }
  return [...simplifyLine(p.slice(0, at + 1), tolerance).slice(0, -1), ...simplifyLine([...p.slice(at), p[0]], tolerance).slice(0, -1)];
}
function contours(mask, W, H) {
  const edges = new Map(), stride = W + 1;
  const add = (a, b) => { const list = edges.get(a) ?? []; list.push(b); edges.set(a, list); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x; if (!mask[p]) continue;
    const a = y * stride + x, b = a + 1, c = b + stride, d = a + stride;
    if (!y || !mask[p - W]) add(a, b); if (x === W - 1 || !mask[p + 1]) add(b, c);
    if (y === H - 1 || !mask[p + W]) add(c, d); if (!x || !mask[p - 1]) add(d, a);
  }
  const paths = [];
  while (edges.size) {
    const start = edges.keys().next().value, points = []; let current = start;
    do { points.push([current % stride, Math.floor(current / stride)]); const list = edges.get(current); if (!list?.length) break; const next = list.pop(); if (!list.length) edges.delete(current); current = next; } while (current !== start && points.length < 4 * W * H);
    if (points.length >= 3 && Math.abs(area(points)) > W * H * .003) paths.push(points);
  }
  return paths;
}
function hull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const half = list => { const h = []; for (const q of list) { while (h.length > 1 && cross(h.at(-2), h.at(-1), q) <= 0) h.pop(); h.push(q); } return h; };
  return [...half(p).slice(0, -1), ...half(p.slice().reverse()).slice(0, -1)];
}
function fittedQuad(paths, W, H) {
  const p = paths.filter(p => area(p) > 0).sort((a, b) => area(b) - area(a))[0]; if (!p) return null;
  const h = hull(p); if (Math.abs(area(h)) > Math.abs(area(p)) * 1.15) return null;
  for (let eps = 2; eps <= 6; eps++) {
    let q = simplifyClosed(h, eps);
    if (q.length === 5) for (let i = 0; i < 5; i++) {
      const a = q[(i + 4) % 5], u = q[i], v = q[(i + 1) % 5], b = q[(i + 2) % 5];
      if (![0, 1].some(k => u[k] === v[k] && (u[k] < 2 || u[k] > [W, H][k] - 3))) continue;
      const dx = u[0] - a[0], dy = u[1] - a[1], ex = b[0] - v[0], ey = b[1] - v[1], det = dx * ey - dy * ex;
      if (Math.abs(det) < 1e-6) continue;
      const t = ((v[0] - a[0]) * ey - (v[1] - a[1]) * ex) / det;
      q = [[a[0] + t * dx, a[1] + t * dy], q[(i + 2) % 5], q[(i + 3) % 5], q[(i + 4) % 5]]; break;
    }
    if (q.length !== 4) continue;
    const cx = q.reduce((s, p) => s + p[0], 0) / 4, cy = q.reduce((s, p) => s + p[1], 0) / 4;
    q.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
    return q.map(p => [p[0] / W, p[1] / H]);
  }
  return null;
}
function solve(samples) {
  const m = Array.from({ length: 6 }, () => new Float64Array(9));
  for (const [b, v] of samples) for (let i = 0; i < 6; i++) { for (let j = 0; j < 6; j++) m[i][j] += b[i] * b[j]; for (let k = 0; k < 3; k++) m[i][6 + k] += b[i] * v[k]; }
  for (let i = 0; i < 6; i++) m[i][i] += 1e-7;
  for (let i = 0; i < 6; i++) {
    let pivot = i; for (let j = i + 1; j < 6; j++) if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    [m[i], m[pivot]] = [m[pivot], m[i]]; const d = m[i][i]; if (Math.abs(d) < 1e-10) return null;
    for (let k = i; k < 9; k++) m[i][k] /= d;
    for (let j = 0; j < 6; j++) if (j !== i) { const f = m[j][i]; for (let k = i; k < 9; k++) m[j][k] -= f * m[i][k]; }
  }
  return m.map(row => [...row.slice(6)]);
}
function fitPaint(pixels, mask, W, H) {
  let count = 0; for (const v of mask) count += v; if (count < 30) return null;
  const step = Math.max(1, Math.floor(count / 2500)); let picked = 0, samples = [];
  for (let i = 0; i < mask.length; i++) if (mask[i] && picked++ % step === 0) { const x = i % W / W * 2 - 1, y = Math.floor(i / W) / H * 2 - 1; samples.push([[1, x, y, x * x, x * y, y * y], [pixels[i * 4], pixels[i * 4 + 1], pixels[i * 4 + 2]]]); }
  for (let pass = 0; pass < 2; pass++) {
    const c = solve(samples); if (!c) return null;
    const residual = samples.map(([b, v]) => Math.hypot(...v.map((n, k) => n - b.reduce((s, x, j) => s + x * c[j][k], 0))));
    const sorted = residual.slice().sort((a, b) => a - b), cut = Math.max(8, sorted[Math.floor(sorted.length * .9)]);
    samples = samples.filter((_, i) => residual[i] <= cut);
  }
  const c = solve(samples); if (!c || samples.length < 20) return null;
  const channels = [0, 1, 2].map(k => samples.map(s => s[1][k]).sort((a, b) => a - b));
  return { coef: c.map(row => row.map(v => Math.round(v * 1000) / 1000)), range: [channels.map(c => Math.max(0, c[Math.floor(c.length * .02)] - 8)), channels.map(c => Math.min(255, c[Math.floor(c.length * .98)] + 8))] };
}

// 身份来自本轮不可重排的图层索引；显示文字可以重复，也不用于归并独立文字与色块。
function graphicGroups(layers) {
  return layers.map((layer, index) => {
    const d = layer.drawing, colors = (d?.keys ?? []).flatMap(k => k.paint.colors ?? (k.paint.color ? [k.paint.color] : []))
      .map(c => lab(...rgb(c)));
    const reason = d?.content !== 'generated' ? 'non-generated' : !['field', 'panel', 'mask'].includes(d.type) ? 'independent-text-or-unsupported'
      : layer.keyframes?.length || layer.transform || d.offset ? 'existing-transform' : !colors.length ? 'no-color-evidence' : null;
    const covering = d?.type === 'mask' || (d?.type === 'panel' && d.keys.some(k => Math.abs(area(k.quad)) > .9));
    return { id: `layer-${index}`, index, layers: [layer], drawings: [d], text: d?.text ?? '', start: layer.start,
      end: layer.start + layer.duration, colors, mask: covering, field: d?.type === 'field', reason };
  });
}

function measurementGroups(layers) {
  const groups = graphicGroups(layers);
  for (const g of groups) {
    if (g.reason) continue;
    // 同时入场的同色对象无法仅凭颜色分离；无字同色蒙版也可能只是背景孔洞。
    const ambiguous = groups.find(other => other !== g && other.colors.length && other.end > g.start && g.end > other.start
      && (g.field ? Math.abs(other.start - g.start) < .00001
        : Math.abs(other.start - g.start) < .4 || (g.mask && !g.text && other.field))
      && g.colors.some(a => other.colors.some(b => Math.hypot(...a.map((v, k) => v - b[k])) < 10)));
    if (ambiguous) g.reason = `ambiguous-color:${ambiguous.id}`;
  }
  return groups;
}

export function replicaMeasurementObjects(layers) {
  return measurementGroups(layers).map(g => ({ id: g.id, index: g.index, name: g.layers[0].name,
    eligible: !g.reason, reason: g.reason, covering: g.mask }));
}

export function canMeasureReplica(layers, duration) { return duration <= 30 && measurementGroups(layers).some(g => !g.reason); }

/** 只校准可识别的短编号色块片；未识别或无法测量的对象保留模型参数。 */
export async function measureReplica({ video, layers, seek, signal }) {
  const objects = replicaMeasurementObjects(layers), duration = video.duration;
  const groups = measurementGroups(layers).filter(g => !g.reason);
  if (!groups.length || duration > 30) return { duration, layers, measured: 0, objects };
  const scale = 480 / Math.max(video.videoWidth, video.videoHeight), W = Math.round(video.videoWidth * scale), H = Math.round(video.videoHeight * scale), N = W * H;
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const count = Math.min(480, Math.round(duration * 30)), step = duration / count;
  groups.forEach(g => {
    // 短窗口在后续上层对象开始前结束，不能把遮挡后的残片当成完整对象轮廓。
    g.following = Math.min(duration, ...layers.filter((l, i) => i > g.index && l.drawing?.type !== 'text' && l.start > g.start + .05).map(l => l.start));
    g.windowEnd = Math.min(g.end, g.following, g.mask ? g.start + 1.6 : g.start + .9);
    g.records = []; g.steps = []; g.paints = []; g.panelPaints = []; g.strokeVotes = []; g.priorEnd = g.windowEnd; g.previous = null;
  });
  let firstPixels, previousPixels;
  for (let frame = 0; frame < count; frame++) {
    signal?.throwIfAborted(); const t = Math.round(frame * step * 1e6) / 1e6;
    await seek(video, Math.min(duration - .001, t + .001)); context.drawImage(video, 0, 0, W, H);
    const pixels = context.getImageData(0, 0, W, H).data; firstPixels ??= pixels.slice();
    const features = new Float32Array(N * 3), labels = new Int16Array(N); labels.fill(-1);
    const active = groups.map((g, i) => ({ g, i, palette: g.updated ? g.mask && !g.full ? [...g.colors, g.updated] : [g.updated] : g.colors }))
      .filter(({ g }) => g.start - .35 <= t && t < g.windowEnd);
    for (const { g } of active) if (!g.mask && !g.field && g.lastQuad && t < g.priorEnd - .1) {
      const paint = fitPaint(pixels, morph(g.region, W, H, 3, false), W, H);
      if (paint) g.panelPaints.push({ t, quad: g.lastQuad, paint });
    }
    for (let p = 0; p < N; p++) {
      const color = lab(pixels[p * 4], pixels[p * 4 + 1], pixels[p * 4 + 2]); features.set(color, p * 3); let best = 32 * 32;
      for (const { g, i, palette } of active) for (const c of palette) {
        const light = (color[0] - c[0]) * (g.mask && color[0] > c[0] ? .5 : 1);
        const d = (light ** 2 + (color[1] - c[1]) ** 2 + (color[2] - c[2]) ** 2) * (!g.mask && g.region?.[p] && t < g.priorEnd ? .35 : 1); if (d < best) { best = d; labels[p] = i; }
      }
    }
    for (const { g, i, palette } of active) {
      const binary = new Uint8Array(N); let detected = 0;
      for (let p = 0; p < N; p++) { binary[p] = +(labels[p] === i); detected += binary[p]; }
      if (g.mask && !g.full && detected > N * .02 && !g.beforePixels) {
        g.beforePixels = previousPixels;
        g.ambiguous = active.some(({ g: other, i: earlier, palette: prior }) => earlier < i && other.text && !other.mask && prior.some(a => palette.some(b => Math.hypot(...a.map((v, k) => v - b[k])) < 24)));
      }
      // 同色蒙版的新分块可能比外圈亮很多。用入场前后的变化补齐它，避免被旧面板抢走标签。
      if (g.mask && !g.full && g.ambiguous && g.beforePixels) for (let p = 0; p < N; p++) {
        if (binary[p]) continue;
        const j = p * 4, delta = Math.hypot(...[0, 1, 2].map(k => pixels[j + k] - g.beforePixels[j + k]));
        if (delta < 12) continue;
        if (palette.some(c => Math.hypot((features[p * 3] - c[0]) * .5, features[p * 3 + 1] - c[1], features[p * 3 + 2] - c[2]) < 32)) binary[p] = 1;
      }
      const mask = clean(binary, pixels, W, H); let covered = 0; for (const v of mask) covered += v;
      if (covered < N * .02) continue;
      const core = morph(mask, W, H, 3, false), paint = fitPaint(pixels, core, W, H); if (!paint) continue;
      const values = [[], [], []]; let coreCount = 0;
      for (let p = 0; p < N; p++) if (core[p]) { coreCount++; if (p % 17 === 0) for (let k = 0; k < 3; k++) values[k].push(features[p * 3 + k]); }
      if (coreCount > N * .025) g.updated = values.map(median);
      const paths = contours(mask, W, H), q = fittedQuad(paths, W, H), white = new Uint8Array(N);
      if (q && !g.mask && g.text) { g.region = polygonMask(q, W, H); g.lastQuad = q; }
      for (let p = 0; p < N; p++) if (mask[p]) { const lo = Math.min(pixels[p * 4], pixels[p * 4 + 1], pixels[p * 4 + 2]), hi = Math.max(pixels[p * 4], pixels[p * 4 + 1], pixels[p * 4 + 2]); white[p] = +(lo > 200 && hi - lo < 55); }
      const letters = components(white, W, H).groups.filter(c => c.count >= 3 && c.count <= N * .015 && c.y1 - c.y0 + 1 > 4 && c.y1 - c.y0 + 1 < H * .25 && c.x1 - c.x0 + 1 < W * .18);
      const size = Math.max(0, ...letters.map(c => c.y1 - c.y0 + 1)) / .74 / H * g.drawings[0].height;
      if (letters.length) {
        const ring = morph(white, W, H, 1, true); let dark = 0, total = 0;
        const background = paint.range[0].reduce((a, b) => a + b, 0) / 3;
        for (let p = 0; p < N; p++) if (ring[p] && !white[p] && mask[p]) { total++; if ((pixels[p * 4] + pixels[p * 4 + 1] + pixels[p * 4 + 2]) / 3 < background - 15) dark++; }
        if (total) g.strokeVotes.push(dark / total > .1);
      }
      g.records.push({ t, q, paint, size, area: covered / N });
      if (g.mask) {
        g.measuredStart ??= t;
        let changed = 0; for (let p = 0; p < N; p++) if (!g.previous || g.previous[p] !== mask[p]) changed++;
        // 记录真实 replace 轮廓，允许缺口恢复，不以历史并集永久填掉孔洞。
        if (changed / N > .005 || !g.steps.length) {
          const polygons = paths.map(p => { let eps = 2, q = simplifyClosed(p, eps); while (q.length > 64 && eps < 20) q = simplifyClosed(p, ++eps); return q.map(([x, y]) => [x / W, y / H]); }).filter(p => p.length >= 3 && p.length <= 64);
          if (polygons.length && polygons.length <= 64) { g.steps.push({ t: t - g.measuredStart, replace: polygons, parts: polygons.map(quad => ({ quad, keys: [{ t: 0, paint }] })) }); g.previous = mask.slice(); }
        }
        g.paints.push({ t: t - g.measuredStart, paint });
        if (covered / N > .975) {
          if (!g.full || changed / N > .005) g.fullAt = t - g.measuredStart;
          g.full = true;
        } else { g.full = false; g.fullAt = undefined; }
      }
    }
    previousPixels = pixels;
  }
  const replacements = new Map(); let measured = 0;
  for (const g of groups) {
    // 不合并不同对象，也不把未识别的图层挪到最上面。已有变换由原图层保留，
    // 测量到的可见轮廓不能再叠加一次旧变换；这类对象暂不拟合。
    if (g.layers.length !== 1 || g.layers[0].keyframes?.length || g.layers[0].transform) continue;
    const following = g.following, onset = g.records.filter(r => r.t >= g.start - .35 && r.t < g.windowEnd);
    const base = structuredClone(g.drawings[0]);
    if (g.field) {
      base.keys = g.records.filter(r => r.t >= g.start && r.t < following).filter((_, j) => j % 3 === 0).map(r => ({ t: r.t - g.start, paint: r.paint }));
      if (!base.keys.length) continue;
      if (base.keys[0].t > .02) {
        const paint = g.start === 0 ? fitPaint(firstPixels, new Uint8Array(N).fill(1), W, H) : base.keys[0].paint;
        if (paint) base.keys.unshift({ t: 0, paint }, { t: Math.max(.000001, base.keys[0].t - step), paint });
      }
      // 原背景的生命周期也属于对象身份，不能延长到片尾覆盖其他场景。
      replacements.set(g.layers[0], { ...g.layers[0], drawing: base }); measured++; continue;
    }
    if (!onset.length) continue;
    let start, fonts;
    if (g.mask) {
      if (!g.steps.length || g.steps.length > 100) continue;
      start = g.measuredStart; Object.assign(base, { type: 'mask', steps: g.steps,
        fullAt: g.fullAt ?? Math.max(g.end - start, g.steps.at(-1).t) + step, keys: g.paints, sharedPaint: true });
      fonts = g.records.filter(r => r.t > start + .3 && r.t < following + .05 && r.size > 0).map(r => r.size);
    } else {
      const usable = onset.filter(r => r.q && r.area > .035); if (!usable.length) continue;
      start = usable[0].t;
      const nextStart = g.windowEnd;
      const keys = g.panelPaints.length ? [{ t: 0, quad: usable[0].q, paint: usable[0].paint }, ...g.panelPaints.filter(r => r.t > start && r.t < nextStart).map(r => ({ t: r.t - start, quad: r.quad, paint: r.paint }))]
        : usable.filter((_, j) => j % 2 === 0).map(r => ({ t: r.t - start, quad: r.q, paint: r.paint }));
      Object.assign(base, { type: 'panel', keys }); fonts = usable.filter(r => r.size > 0).map(r => r.size);
    }
    if (fonts.length) base.fontSize = median(fonts);
    if (g.strokeVotes.length) base.plain = g.strokeVotes.filter(Boolean).length * 2 < g.strokeVotes.length;
    if (base.type !== 'opening') for (const field of ['quad', 'center', 'fadeEnd', 'numberAt']) delete base[field];
    const stop = Math.min(g.end, duration);
    if (stop <= start) continue;
    replacements.set(g.layers[0], { ...g.layers[0], start, duration: stop - start, drawing: base }); measured++;
  }
  return { duration, layers: layers.map(l => replacements.get(l) ?? l), measured, sampleStep: step,
    objects: objects.map(o => ({ ...o, measured: replacements.has(layers[o.index]) })) };
}
