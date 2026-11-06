// Independent glyph samples follow the same Canvas 2D transforms, source crops
// and native clip state as the real drawing. Triangle pieces are unioned by
// source sample id, so an intentional mesh split is not counted as lost text.
function installGlyphAudit() {
  const states = new WeakMap(), internal = new WeakSet(), notes = new Set();
  const lyricMarked = canvas => Boolean(canvas?.matches?.('[data-smartcut-lyrics]') || canvas?.closest?.('[data-smartcut-lyrics]'));
  const prototypes = [window.CanvasRenderingContext2D?.prototype, window.OffscreenCanvasRenderingContext2D?.prototype].filter(Boolean);
  const native = new Map(prototypes.map(p => [p, Object.fromEntries(Object.getOwnPropertyNames(p).filter(k => typeof Object.getOwnPropertyDescriptor(p, k)?.value === 'function').map(k => [k, p[k]]))]));
  const methods = c => native.get(Object.getPrototypeOf(c));
  const scratch = (w, h) => { const c = document.createElement('canvas'); internal.add(c); c.width = w; c.height = h; return c; };
  const state = c => {
    if (internal.has(c.canvas)) return null;
    if (!states.has(c.canvas)) { const mask = scratch(c.canvas.width, c.canvas.height); states.set(c.canvas, { records: [], mask, context: mask.getContext('2d', { willReadFrequently: true }), clipped: false, stack: [] }); }
    return states.get(c.canvas);
  };
  let serial = 0;
  const rect = points => points.length ? points.reduce((b, p) => ({ left: Math.min(b.left, p.x), top: Math.min(b.top, p.y), right: Math.max(b.right, p.x), bottom: Math.max(b.bottom, p.y) }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity }) : null;
  const transform = (p, m) => ({ ...p, x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f });
  const visiblePoints = (c, s, points) => {
    let kept = points.filter(p => p.x >= 0 && p.y >= 0 && p.x < c.canvas.width && p.y < c.canvas.height);
    if (!s.clipped || !kept.length) return kept;
    const b = rect(kept), x = Math.floor(b.left), y = Math.floor(b.top), w = Math.ceil(b.right) - x + 1, h = Math.ceil(b.bottom) - y + 1;
    const g = s.context, n = methods(g); n.save.call(g); n.resetTransform.call(g); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; g.fillStyle = 'white';
    n.fillRect.call(g, x, y, w, h);
    const pixels = n.getImageData.call(g, x, y, w, h).data;
    n.clearRect.call(g, x, y, w, h); n.restore.call(g);
    kept = kept.filter(p => pixels[((Math.floor(p.y) - y) * w + Math.floor(p.x) - x) * 4 + 3] >= 128);
    return kept;
  };
  for (const proto of [window.HTMLCanvasElement?.prototype, window.OffscreenCanvas?.prototype].filter(Boolean)) {
    for (const key of ['width', 'height']) {
      const d = Object.getOwnPropertyDescriptor(proto, key);
      if (d?.set) Object.defineProperty(proto, key, { ...d, set(v) { d.set.call(this, v); const s = states.get(this); if (s) { s.mask[key] = v; s.records = []; s.stack = []; s.clipped = false; } } });
    }
  }
  for (const proto of prototypes) {
    const n = native.get(proto);
    if (n.reset) proto.reset = function () { const s=state(this);if(s){s.mask.width=this.canvas.width;s.records=[];s.stack=[];s.clipped=false;}return n.reset.call(this); };
    for (const key of ['save', 'restore', 'scale', 'rotate', 'translate', 'transform', 'setTransform', 'resetTransform', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'roundRect', 'clip']) {
      if (!n[key]) continue;
      proto[key] = function (...args) {
        const s = state(this);
        if (s) {
          if (key === 'save') s.stack.push(s.clipped);
          if (key === 'restore' && s.stack.length) s.clipped = s.stack.pop();
          if (key === 'clip') s.clipped = true;
          methods(s.context)[key].apply(s.context, args);
        }
        return n[key].apply(this, args);
      };
    }
    for (const key of ['fillText', 'strokeText']) proto[key] = function (text, x, y, maxWidth) {
      const s = state(this);
      if (s && String(text).trim() && this.globalAlpha > .01) {
        const m = this.measureText(text), matrix = this.getTransform(), scale = maxWidth > 0 && m.width > maxWidth ? maxWidth / m.width : 1, pad = key === 'strokeText' ? this.lineWidth : 1;
        const corners = [[x - m.actualBoundingBoxLeft * scale - pad, y - m.actualBoundingBoxAscent - pad], [x + m.actualBoundingBoxRight * scale + pad, y - m.actualBoundingBoxAscent - pad], [x - m.actualBoundingBoxLeft * scale - pad, y + m.actualBoundingBoxDescent + pad], [x + m.actualBoundingBoxRight * scale + pad, y + m.actualBoundingBoxDescent + pad]].map(([x,y]) => transform({x,y}, matrix));
        const b = rect(corners), left = Math.floor(b.left), top = Math.floor(b.top), width = Math.max(1, Math.ceil(b.right) - left), height = Math.max(1, Math.ceil(b.bottom) - top);
        if (width * height > 4e6) notes.add('超大字形超过像素检查上限');
        else {
          const tile = scratch(width, height), g = tile.getContext('2d', { willReadFrequently: true }), gm = methods(g);
          for (const property of ['font', 'textAlign', 'textBaseline', 'direction', 'fontKerning', 'fontStretch', 'fontVariantCaps', 'letterSpacing', 'wordSpacing', 'lineWidth', 'lineJoin', 'miterLimit']) if (property in this) g[property] = this[property];
          g.fillStyle = g.strokeStyle = 'white'; gm.setTransform.call(g, matrix.a, matrix.b, matrix.c, matrix.d, matrix.e - left, matrix.f - top);
          gm[key].apply(g, maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth]);
          const pixels = gm.getImageData.call(g, 0, 0, width, height).data, points = [], step = Math.max(1, Math.ceil(Math.sqrt(width * height / 12000)));
          for (let yy = 0; yy < height; yy += step) for (let xx = 0; xx < width; xx += step) if (pixels[(yy * width + xx) * 4 + 3] >= 128) points.push({ x: left + xx + .5, y: top + yy + .5, sample: points.length });
          const paint = key === 'fillText' ? this.fillStyle : this.strokeStyle;
          const rgba = typeof paint === 'string' ? paint.match(/^rgba\(\s*(\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/u) : null;
          if (typeof paint !== 'string') notes.add('渐变或图案字色未纳入高亮时序识别');
          s.records.push({ id: ++serial, text: String(text), kind: key === 'fillText' ? 'canvas-fill' : 'canvas-stroke', paint: rgba ? `rgb(${rgba[1]},${rgba[2]},${rgba[3]})` : typeof paint === 'string' ? paint : null, alpha: this.globalAlpha * (rgba ? Number(rgba[4]) : 1), lyric_scope: lyricMarked(this.canvas), total: points.length, sample_step: step, raw: b, points: visiblePoints(this, s, points) });
        }
      }
      return n[key].apply(this, arguments);
    };
    proto.clearRect = function (x,y,w,h) { const s = state(this); if (s && this.getTransform().isIdentity && x <= 0 && y <= 0 && w >= this.canvas.width && h >= this.canvas.height) { if (!s.clipped) s.records = []; else notes.add('局部裁切下清屏未完整跟踪'); } return n.clearRect.apply(this, arguments); };
    proto.drawImage = function (source, ...args) {
      const s = state(this), records = states.get(source)?.records;
      if (s && records?.length && this.globalAlpha > .01) {
        let sx=0,sy=0,sw=source.width,sh=source.height,dx,dy,dw,dh;
        if (args.length === 2) { [dx,dy]=args;dw=sw;dh=sh; } else if (args.length === 4) [dx,dy,dw,dh]=args; else [sx,sy,sw,sh,dx,dy,dw,dh]=args;
        const m = this.getTransform();
        for (const r of records) {
          const points = r.points.filter(p=>p.x>=sx&&p.x<sx+sw&&p.y>=sy&&p.y<sy+sh).map(p=>transform({...p,x:dx+(p.x-sx)*dw/sw,y:dy+(p.y-sy)*dh/sh},m));
          // Keep empty pieces too: a fully clipped word must not disappear from the audit.
          s.records.push({...r,raw:null,alpha:r.alpha*this.globalAlpha,lyric_scope:lyricMarked(this.canvas)||lyricMarked(source)||Boolean(r.lyric_scope),points:visiblePoints(this,s,points)});
        }
        if (this.globalCompositeOperation !== 'source-over') notes.add('非 source-over 合成需要额外遮挡验收');
      }
      return n.drawImage.call(this, source, ...args);
    };
  }
  window.__glyphAudit = { collect(canvas) {
    const records=states.get(canvas)?.records??[], grouped=new Map();
    for(const r of records){if(r.alpha<=.01||!r.total)continue;let g=grouped.get(r.id);if(!g){g={...r,points:new Map()};grouped.set(r.id,g);}for(const p of r.points){const old=g.points.get(p.sample);if(old&&Math.hypot(old.x-p.x,old.y-p.y)>3)notes.add('同一源字形存在多处独立副本或重叠投影，未分离验收');g.points.set(p.sample,p);}}
    const boxes=[];
    const scoped=lyricMarked(canvas);
    for(const r of grouped.values()){
      const points=[...r.points.values()], b=r.raw??rect(points)??{left:0,top:0,right:0,bottom:0},lost=r.total-points.length;
      boxes.push({...b,text:r.text,kind:r.kind,paint:r.paint,alpha:r.alpha,lyric_scope:scoped||Boolean(r.lyric_scope),clipped:lost>=3&&lost/r.total>.005,glyph_coverage:points.length/r.total,glyph_samples:r.total,missing_samples:lost,sample_step:r.sample_step});
    }
    return {boxes,limitations:[...notes]};
  }};
}

export const GLYPH_AUDIT_SCRIPT = `(${installGlyphAudit.toString()})()`;
