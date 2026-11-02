const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
const hex = rgb => '#' + rgb.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
const polygonArea = q => q.reduce((sum, p, i) => { const n = q[(i + 1) % q.length]; return sum + p[0] * n[1] - n[0] * p[1]; }, 0) / 2;
const polygonBounds = q => [Math.min(...q.map(p => p[0])), Math.min(...q.map(p => p[1])), Math.max(...q.map(p => p[0])), Math.max(...q.map(p => p[1]))];

/** 只给局部矩形的边缘和颜色测量提示；不据此直接改工程，候选仍须完整逐帧验收。 */
export function measureRectangle(pixels, width, height, bounds) {
  const [x0, y0, x1, y1] = bounds.map((v, i) => v * (i % 2 ? height : width));
  if (x1 - x0 < 20 || y1 - y0 < 12 || (x1 - x0) * (y1 - y0) > width * height * .5) return null;
  const edge = (axis, at, lo, hi, radius) => {
    let best = null;
    for (let q = Math.max(2, Math.round(at - radius)); q <= Math.min((axis ? height : width) - 3, at + radius); q++) {
      const differences = [];
      for (let c = Math.ceil(lo); c <= hi; c += 2) {
        const p = axis ? (q * width + c) * 4 : (c * width + q) * 4, offset = axis ? width * 4 : 4;
        differences.push((Math.abs(pixels[p] - pixels[p - offset]) + Math.abs(pixels[p + 1] - pixels[p - offset + 1]) + Math.abs(pixels[p + 2] - pixels[p - offset + 2])) / 3);
      }
      const strength = median(differences);
      if (!best || strength > best.strength) best = { q, strength };
    }
    return best;
  };
  const dx = x1 - x0, dy = y1 - y0;
  const left = edge(0, x0, y0 + dy * .2, y1 - dy * .2, Math.max(5, dx * .15));
  const right = edge(0, x1, y0 + dy * .2, y1 - dy * .2, Math.max(5, dx * .15));
  const top = edge(1, y0, x0 + dx * .2, x1 - dx * .2, Math.max(5, dy * .2));
  const bottom = edge(1, y1, x0 + dx * .2, x1 - dx * .2, Math.max(5, dy * .2));
  if ([left, right, top, bottom].some(e => !e || e.strength < 5) || right.q - left.q < 12 || bottom.q - top.q < 8) return null;
  const colors = [[], [], []];
  for (let y = top.q + 3; y < bottom.q - 3; y += 2) for (let x = left.q + 3; x < right.q - 3; x += 2) {
    const i = (y * width + x) * 4, rgb = [...pixels.slice(i, i + 3)];
    if (Math.min(...rgb) > 190 && Math.max(...rgb) - Math.min(...rgb) < 30) continue;
    rgb.forEach((v, k) => colors[k].push(v));
  }
  if (colors[0].length < 20) return null;
  return { bounds: [left.q / width, top.q / height, right.q / width, bottom.q / height],
    color: hex(colors.map(median)), edgeStrength: Math.min(left.strength, right.strength, top.strength, bottom.strength) };
}

export function measureMaskRegions(layers, pixels, width, height, t, frame, previous = []) {
  // 只测最上方可见蒙版，避免把后景被遮挡部分的颜色误当成该层固有颜色。
  const layerIndex = layers.findLastIndex(l => l.drawing.type !== 'signature' && t >= l.start && t < l.start + l.duration);
  const layer = layers[layerIndex], d = layer?.drawing;
  if (d?.type !== 'mask' || d.content !== 'generated' || layer.transform || layer.keyframes?.length) return [];
  const local = t - layer.start + (d.offset ?? 0), step = d.steps.findLastIndex(s => s.t <= local + 1e-5);
  const paths = d.steps[step]?.replace;
  if (!paths) return [];
  if (local >= d.fullAt - 1e-5) return [];
  const regions = (polygons, sourceStep) => polygons.flatMap((q, polygon_index) => {
    const area = q.reduce((sum, p, i) => { const n = q[(i + 1) % q.length]; return sum + p[0] * n[1] - n[0] * p[1]; }, 0) / 2;
    if (area <= 0 || area > .4) return [];
    const bounds = [Math.min(...q.map(p => p[0])), Math.min(...q.map(p => p[1])), Math.max(...q.map(p => p[0])), Math.max(...q.map(p => p[1]))];
    // 颜色渐暗后附近外框可能成为更强边缘；沿上一帧已定位的矩形继续搜索，避免跳到外框。
    const prior = previous.find(m => m.layer === layerIndex && m.currentBounds.every((v, i) => Math.abs(v - bounds[i]) < .03));
    const measured = measureRectangle(pixels, width, height, prior?.reference.bounds ?? bounds);
    return measured ? [{ layer: layerIndex, name: layer.name, step, polygon_index: sourceStep === step ? polygon_index : null,
      ...(sourceStep === step ? {} : { trackedFromStep: sourceStep }), frame, t, localTime: t - layer.start, currentBounds: bounds, reference: measured }] : [];
  });
  const current = regions(paths, step);
  if (current.length) return current;
  // 后续拓扑可能把中央块误连到外框。沿用上一状态的区域去测原片，明确标为无现成路径，避免误改外框。
  for (let i = step - 1; i >= 0; i--) {
    const tracked = regions(d.steps[i].replace ?? [], i);
    if (tracked.length) return tracked;
  }
  return [];
}

/** 实测矩形只生成候选：联动相邻步骤的轮廓/内部空洞/颜色，保存仍由完整逐帧验收决定。 */
export function rectangleRepairNodes(d, measurements, { duration, fps }) {
  if (d.type !== 'mask' || d.content !== 'generated' || !d.sharedPaint) return [];
  const valid = measurements.filter(m => Number.isInteger(m.step) && d.steps[m.step]?.replace && Number.isFinite(m.localTime)
    && Array.isArray(m.currentBounds) && m.currentBounds.length === 4 && m.currentBounds.every(Number.isFinite)
    && Array.isArray(m.reference?.bounds) && m.reference.bounds.length === 4 && m.reference.bounds.every(v => Number.isFinite(v) && v >= 0 && v <= 1)
    && /^#[\da-f]{6}$/iu.test(m.reference.color));
  const anchor = valid.find(m => Number.isInteger(m.polygon_index));
  if (!anchor) return [];
  const overlap = (a, b) => {
    const area = q => (q[2] - q[0]) * (q[3] - q[1]);
    const shared = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    return shared / Math.max(.000001, area(a) + area(b) - shared);
  };
  const selected = valid.filter(m => overlap(m.currentBounds, anchor.currentBounds) > .75), nodes = [];
  for (const step of [...new Set(selected.map(m => m.step))]) {
    const ms = selected.filter(m => m.step === step).sort((a, b) => a.localTime - b.localTime), m = ms[0];
    const start = d.steps[step].t - (d.offset ?? 0), end = Math.min(duration, (d.steps[step + 1]?.t ?? duration + (d.offset ?? 0)) - (d.offset ?? 0));
    // 不从半截窗口推断整个步骤的颜色，也不将运动形状强行改成静止矩形。
    if (ms.length > 100 || ms[0].localTime > start + 1 / fps + 1e-5 || ms.at(-1).localTime < end - 1 / fps - 1e-5
      || ms.some(v => v.reference.bounds.some((b, i) => Math.abs(b - m.reference.bounds[i]) > .005))) return [];
    const source = d.steps[m.trackedFromStep ?? step]?.replace;
    if (!source) return [];
    const index = m.polygon_index ?? source.findIndex(q => polygonArea(q) > 0 && polygonBounds(q).every((v, i) => Math.abs(v - m.currentBounds[i]) < 1e-6));
    if (!source[index] || polygonArea(source[index]) <= 0) return [];
    // 拓扑连在一起时，只允许恢复同一外框里上一状态的独立色块；其他形状留给模型。
    if (m.polygon_index === null && (d.steps[step].replace.length !== 2 || source.length > 4 || JSON.stringify(source[0]) !== JSON.stringify(d.steps[step].replace[0]))) return [];
    const [x0, y0, x1, y1] = m.reference.bounds, quad = [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
    const [left, top, right, bottom] = m.currentBounds;
    const polygons = source.filter((q, i) => {
      const b = polygonBounds(q);
      return i === index || polygonArea(q) >= 0 || !(b[0] >= left && b[1] >= top && b[2] <= right && b[3] <= bottom);
    });
    const fittedIndex = polygons.indexOf(source[index]); polygons[fittedIndex] = quad;
    nodes.push({ kind: 'step', index: step, replace: polygons }, { kind: 'step', index: step, polygon_index: fittedIndex,
      paint_keys: ms.map(v => ({ time: v.localTime, paint: { color: v.reference.color } })) });
  }
  return nodes;
}
