// Runs in each same-origin frame before page code. Measures drawn text, not an
// author-supplied bounding box. Does not modify the drawing or exported page.
import { GLYPH_AUDIT_SCRIPT } from './glyphAudit.mjs';

function installTextAudit() {
  const records = new WeakMap(), canvases = new Set(), unsupported = new Set();
  const lyricMarked = node => Boolean(node?.matches?.('[data-smartcut-lyrics]') || node?.closest?.('[data-smartcut-lyrics]'));
  const list = canvas => { canvases.add(canvas); if (!records.has(canvas)) records.set(canvas, []); return records.get(canvas); };
  const box = points => ({ left: Math.min(...points.map(p => p.x)), top: Math.min(...points.map(p => p.y)), right: Math.max(...points.map(p => p.x)), bottom: Math.max(...points.map(p => p.y)) });
  const corners = b => [{ x: b.left, y: b.top }, { x: b.right, y: b.top }, { x: b.right, y: b.bottom }, { x: b.left, y: b.bottom }];
  const transform = (b, m) => box(corners(b).map(p => ({ x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f })));
  for (const proto of [window.HTMLCanvasElement?.prototype, window.OffscreenCanvas?.prototype].filter(Boolean)) {
    for (const name of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(proto, name);
      if (d?.set) Object.defineProperty(proto, name, { ...d, set(value) { records.set(this, []); d.set.call(this, value); } });
    }
    const get = proto.getContext;
    proto.getContext = function (kind) { if (String(kind).includes('webgl') || kind === 'webgpu') unsupported.add('WebGL/WebGPU 路径或贴图文字不在几何检查覆盖内'); return get.apply(this, arguments); };
  }
  for (const proto of [window.CanvasRenderingContext2D?.prototype, window.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean)) {
    for (const name of ['fillText', 'strokeText']) {
      const original = proto[name];
      proto[name] = function (text, x, y, maxWidth) {
        if (String(text).trim() && this.globalAlpha > .01) {
          const m = this.measureText(String(text)), scale = maxWidth > 0 && m.width > maxWidth ? maxWidth / m.width : 1;
          const pad = name === 'strokeText' ? this.lineWidth / 2 : 0;
          const b = transform({ left: x - m.actualBoundingBoxLeft * scale - pad, right: x + m.actualBoundingBoxRight * scale + pad,
            top: y - m.actualBoundingBoxAscent - pad, bottom: y + m.actualBoundingBoxDescent + pad }, this.getTransform());
          list(this.canvas).push({ ...b, text: String(text).slice(0, 120), kind: 'canvas-text', lyric_scope: lyricMarked(this.canvas) });
        }
        return original.apply(this, arguments);
      };
    }
    const clear = proto.clearRect;
    proto.clearRect = function (x, y, w, h) { const m = this.getTransform(); if (m.isIdentity && x <= 0 && y <= 0 && w >= this.canvas.width && h >= this.canvas.height) records.set(this.canvas, []); return clear.apply(this, arguments); };
    const clip = proto.clip;
    proto.clip = function () { if (!window.__glyphAudit) unsupported.add('canvas 自定义 clip 路径未检查'); return clip.apply(this, arguments); };
    const draw = proto.drawImage;
    proto.drawImage = function (source, ...args) {
      const sourceRecords = records.get(source);
      if (sourceRecords?.length) {
        let sx = 0, sy = 0, sw = source.width, sh = source.height, dx, dy, dw, dh;
        if (args.length === 2) { [dx, dy] = args; dw = sw; dh = sh; }
        else if (args.length === 4) [dx, dy, dw, dh] = args;
        else [sx, sy, sw, sh, dx, dy, dw, dh] = args;
        for (const b of sourceRecords) list(this.canvas).push({ ...b, ...transform({ left: dx + (b.left - sx) * dw / sw, right: dx + (b.right - sx) * dw / sw,
          top: dy + (b.top - sy) * dh / sh, bottom: dy + (b.bottom - sy) * dh / sh }, this.getTransform()), lyric_scope: lyricMarked(this.canvas) || lyricMarked(source) || Boolean(b.lyric_scope), sourceClipped: b.left < sx || b.top < sy || b.right > sx + sw || b.bottom > sy + sh });
      }
      return draw.call(this, source, ...args);
    };
  }
  const visible = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) <= .01) return false; } return true; };
  const outside = (r, clip) => r.left < clip.left - .5 || r.right > clip.right + .5 || r.top < clip.top - .5 || r.bottom > clip.bottom + .5;
  // An axis-aligned inset is a rectangle we can measure. Other CSS masks must
  // remain explicitly uncovered instead of inheriting a passing outer box.
  const cssClip = (el, style, limitations) => {
    if (style.clip && style.clip !== 'auto') limitations.add('旧式 CSS clip 字形裁切未覆盖');
    if (style.maskImage !== 'none' || (style.webkitMaskImage && style.webkitMaskImage !== 'none')) limitations.add('CSS mask 字形保留率未覆盖');
    const value = style.clipPath;
    if (!value || value === 'none') return null;
    const match = /^inset\(([-\d.%px\s]+)\)$/u.exec(value);
    let axisAligned = true;
    for (let e = el; e; e = e.parentElement) {
      const matrix = new DOMMatrix(getComputedStyle(e).transform);
      if (!matrix.is2D || Math.abs(matrix.b) > 1e-6 || Math.abs(matrix.c) > 1e-6 || matrix.a <= 0 || matrix.d <= 0) axisAligned = false;
    }
    if (!match || !axisAligned) { limitations.add('非轴向 inset 或其他 CSS clip-path 字形裁切未覆盖'); return null; }
    const values = match[1].trim().split(/\s+/u);
    if (!values.length || values.length > 4 || values.some(v => !/^-?\d*\.?\d+(?:px|%)?$/u.test(v))) { limitations.add('CSS inset 单位未覆盖'); return null; }
    const [top, right = top, bottom = top, left = right] = values, r = el.getBoundingClientRect();
    const length = (v, extent, unscaled) => parseFloat(v) * (v.endsWith('%') ? extent / 100 : extent / (unscaled || extent || 1));
    return { left: r.left + length(left, r.width, el.offsetWidth), right: r.right - length(right, r.width, el.offsetWidth),
      top: r.top + length(top, r.height, el.offsetHeight), bottom: r.bottom - length(bottom, r.height, el.offsetHeight) };
  };
  const clippedByAncestors = (el, r, limitations) => {
    let clipped = false;
    for (let e = el; e; e = e.parentElement) {
      const s = getComputedStyle(e), er = e.getBoundingClientRect(), clip = cssClip(e, s, limitations);
      if (clip && outside(r, clip)) clipped = true;
      if (/(hidden|clip|scroll|auto)/.test(s.overflowX) && (r.left < er.left - .5 || r.right > er.right + .5)) clipped = true;
      if (/(hidden|clip|scroll|auto)/.test(s.overflowY) && (r.top < er.top - .5 || r.bottom > er.bottom + .5)) clipped = true;
      if (/(hidden|clip|scroll|auto)/.test(s.overflowX + s.overflowY) && [s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomLeftRadius, s.borderBottomRightRadius].some(v => parseFloat(v) > 0)) limitations.add('圆角 overflow 的字形裁切未覆盖');
    }
    return clipped;
  };
  const collect = () => {
    const boxes = [], limitations = new Set(unsupported);
    for (const canvas of document.querySelectorAll('canvas')) {
      if (!visible(canvas)) continue;
      const r = canvas.getBoundingClientRect(); if (!r.width || !r.height) continue;
      if (getComputedStyle(canvas).transform !== 'none') limitations.add('CSS 变换 canvas 采用外接矩形，非轴向投影需视觉复核');
      const glyphs = window.__glyphAudit?.collect(canvas);
      glyphs?.limitations.forEach(s => limitations.add(s));
      const text = glyphs?.boxes ?? records.get(canvas) ?? [];
      for (const b of text) {
        const projected = { ...b, left: r.left + b.left / canvas.width * r.width, right: r.left + b.right / canvas.width * r.width,
          top: r.top + b.top / canvas.height * r.height, bottom: r.top + b.bottom / canvas.height * r.height,
          lyric_scope: lyricMarked(canvas) || Boolean(b.lyric_scope) };
        projected.clipped = clippedByAncestors(canvas, projected, limitations) || b.clipped || b.sourceClipped || b.left < -.5 || b.top < -.5 || b.right > canvas.width + .5 || b.bottom > canvas.height + .5;
        boxes.push(projected);
      }
    }
    const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const el = node.parentElement;
      if (!node.textContent.trim() || !el || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TITLE'].includes(el.tagName) || !visible(el)) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (!r.width || !r.height) continue;
        const clipped = clippedByAncestors(el, r, limitations);
        boxes.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, text: node.textContent.trim().slice(0, 120), kind: 'dom-text', paint: getComputedStyle(el).color, lyric_scope: lyricMarked(el), clipped });
      }
    }
    for (const frame of document.querySelectorAll('iframe')) {
      if (!visible(frame)) continue;
      try {
        const audit = frame.contentWindow.__textAudit;
        if (!audit) { limitations.add('iframe 未安装文字检测'); continue; }
        const result = audit.collect(), r = frame.getBoundingClientRect(), w = frame.contentWindow.innerWidth, h = frame.contentWindow.innerHeight;
        const m = new DOMMatrix(getComputedStyle(frame).transform);
        if (Math.abs(m.b) > 1e-6 || Math.abs(m.c) > 1e-6 || !m.is2D) limitations.add('iframe 旋转或透视变换采用外接矩形，需视觉复核');
        result.limitations.forEach(s => limitations.add(s));
        for (const b of result.boxes) boxes.push({ ...b, lyric_scope: lyricMarked(frame) || Boolean(b.lyric_scope), clipped: b.clipped || b.left < -.5 || b.top < -.5 || b.right > w + .5 || b.bottom > h + .5,
          left: r.left + b.left / w * r.width, right: r.left + b.right / w * r.width, top: r.top + b.top / h * r.height, bottom: r.top + b.bottom / h * r.height });
      } catch { limitations.add('跨域 iframe 无法测量文字'); }
    }
    return { boxes, limitations: [...limitations] };
  };
  window.__textAudit = { collect };
}

export const TEXT_AUDIT_SCRIPT = GLYPH_AUDIT_SCRIPT + `;(${installTextAudit.toString()})()`;
export const TEXT_AUDIT_READ = 'window.__textAudit.collect()';

export function summarizeTextBounds(frames, { width, height, fps, start, duration }) {
  const violations = [], limitations = new Set(), spans = [], heights = [];
  const expected = Math.ceil(duration * fps - 1e-8), seen = new Set();
  let duplicateFrames = 0, invalidFrames = 0;
  for (const frame of frames) {
    const index = Math.round((frame.time - start) * fps);
    if (!Number.isFinite(frame.time) || index < 0 || index >= expected || Math.abs(frame.time - start - index / fps) > 1e-5) invalidFrames++;
    else if (seen.has(index)) duplicateFrames++;
    else seen.add(index);
  }
  const missingFrames = Math.max(0, expected - seen.size);
  if (missingFrames || duplicateFrames || invalidFrames) limitations.add(`原生帧率覆盖不完整：缺少 ${missingFrames} 帧、重复 ${duplicateFrames} 帧、无效时刻 ${invalidFrames} 帧`);
  let measured = 0;
  for (const { time, boxes, limitations: notes = [] } of frames) {
    notes.forEach(s => limitations.add(s));
    if (!boxes.length) continue;
    measured++;
    const left = Math.min(...boxes.map(b => b.left)), right = Math.max(...boxes.map(b => b.right));
    spans.push((right - left) / width);
    heights.push(Math.max(...boxes.map(b => b.bottom - b.top)));
    const bad = boxes.filter(b => b.clipped || b.left < -.5 || b.top < -.5 || b.right > width + .5 || b.bottom > height + .5);
    if (bad.length) violations.push({ time, overflow_px: Math.ceil(Math.max(0, ...bad.flatMap(b => [-b.left, -b.top, b.right - width, b.bottom - height]))),
      text: [...new Set(bad.map(b => b.text))].join(' ').slice(0, 240) });
  }
  return { status: violations.length ? 'fail' : measured && !limitations.size ? 'pass' : 'uncertain',
    scope: 'DOM文字边界及Canvas 2D字形核心采样经真实clip/源裁切/仿射曲面映射后的保留率；不证明歌词或任意后续图层遮挡。丢失超过0.5%且至少3个字形样本判裁字。',
    start, duration, fps, checked_frames: frames.length, expected_frames: expected, missing_frames: missingFrames, duplicate_frames: duplicateFrames, invalid_frames: invalidFrames, frames_with_text: measured, violating_frames: violations.length,
    first_violation: violations[0] ?? null, last_violation: violations.at(-1) ?? null,
    max_overflow_px: Math.max(0, ...violations.map(v => v.overflow_px)), violations: violations.slice(0, 12),
    text_width_ratio: spans.length ? { min: Math.min(...spans), max: Math.max(...spans) } : null,
    max_glyph_height_px: heights.length ? { min: Math.min(...heights), max: Math.max(...heights) } : null, limitations: [...limitations] };
}
