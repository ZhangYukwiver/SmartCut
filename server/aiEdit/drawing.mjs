// 可编辑的图层绘制数据。预览和出片使用同一份 Canvas 实现；工程只保存数据，不保存可执行脚本。
export function drawingProblem(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return '动画参数应为对象';
  if (JSON.stringify(d).length > 1_000_000) return '单层动画参数过大';
  const finite = (v, lo = -1e6, hi = 1e6) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
  const point = p => Array.isArray(p) && p.length === 2 && p.every(v => finite(v, -10, 10));
  const quad = q => Array.isArray(q) && q.length === 4 && q.every(point);
  const polygon = q => Array.isArray(q) && q.length >= 3 && q.length <= 64 && q.every(point);
  const polygons = p => Array.isArray(p) && p.length <= 64 && p.every(polygon);
  const color = c => typeof c === 'string' && /^#[\da-f]{6}$/iu.test(c);
  const paint = p => p && (color(p.color) || (Array.isArray(p.colors) && p.colors.length === 4 && p.colors.every(color))
    || (Array.isArray(p.coef) && p.coef.length === 6 && p.coef.every(c => Array.isArray(c) && c.length === 3 && c.every(v => finite(v)))
      && Array.isArray(p.range) && p.range.length === 2 && p.range.every(c => Array.isArray(c) && c.length === 3 && c.every(v => finite(v, 0, 255)))));
  const keys = (k, geometry = false) => Array.isArray(k) && k.length > 0 && k.length <= 500
    && k.every((v, i) => v && finite(v.t, 0, 86400) && (!i || v.t > k[i - 1].t) && paint(v.paint) && (!geometry || quad(v.quad)));
  if (!['field', 'opening', 'panel', 'mask', 'signature', 'text'].includes(d.type)) return '未知动画图层类型';
  if (!finite(d.width, 16, 2048) || !finite(d.height, 16, 2048)) return '动画基准尺寸无效';
  if (!finite(d.offset ?? 0, -86400, 86400)) return '动画偏移时间无效';
  if (d.referenceStart !== undefined && !finite(d.referenceStart, 0, 86400)) return '参考片段起点无效';
  if (!['generated', 'media'].includes(d.content)) return '动画内容类型无效';
  if (typeof d.text !== 'string' || d.text.length > 200 || !finite(d.fontSize, 1, 500)) return '图层文字参数无效';
  if (typeof d.showText !== 'boolean') return '显示文字应为布尔值';
  if (['plain', 'echo'].some(k => d[k] !== undefined && typeof d[k] !== 'boolean')) return '文字描边和重影应为布尔值';
  if (d.sharedPaint !== undefined && typeof d.sharedPaint !== 'boolean') return '共用颜色应为布尔值';
  if (d.textColor !== undefined && !color(d.textColor)) return '文字颜色需要 #RRGGBB';
  if (d.center !== undefined && !point(d.center)) return '文字位置需要归一化坐标';
  if (d.type === 'panel' && !keys(d.keys, true)) return '轮廓关键帧需要有效坐标、颜色和递增时间';
  if (['field', 'opening'].includes(d.type) && !keys(d.keys)) return '颜色关键帧无效';
  if (d.type === 'opening' && (!quad(d.quad) || !point(d.center) || !finite(d.numberAt, 0, 86400) || !finite(d.fadeEnd, 0, 86400))) return '开场参数无效';
  if (d.type === 'mask') {
    if (!keys(d.keys) || !finite(d.fullAt, 0, 86400)) return '蒙版颜色或结束时间无效';
    if (!Array.isArray(d.steps) || !d.steps.length || d.steps.length > 100) return '蒙版步骤数量无效';
    if (!d.steps.every((s, i) => s && finite(s.t, 0, 86400) && (!i || s.t > d.steps[i - 1].t)
      && (polygons(s.add) || polygons(s.replace)) && Array.isArray(s.parts) && s.parts.length <= 64 && s.parts.every(p => p && polygon(p.quad) && keys(p.keys) && (p.paintOverride === undefined || typeof p.paintOverride === 'boolean')))) return '蒙版步骤需要有效轮廓和递增时间';
    if (d.fullAt < d.steps.at(-1).t) return '铺满时间不能早于最后一个蒙版步骤';
  }
  return null;
}

/** 可视时间线上的动画节点（秒，片段内时间）。 */
export function drawingTimes(d) {
  if (!d) return [];
  const times = [...(d.keys ?? []).map(k => k.t), ...(d.steps ?? []).map(s => s.t)];
  if (d.type === 'opening') times.push(d.numberAt, d.fadeEnd);
  if (d.type === 'mask') times.push(d.fullAt);
  return [...new Set(times.map(t => Math.round((t - (d.offset ?? 0)) * 1e6) / 1e6))].sort((a, b) => a - b);
}

/** 闭包无外部依赖，可嵌入导出页面。 */
export function createDrawingRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const cache = new Map();
  let cacheBytes = 0;
  function span(keys, t) {
    let i = 0;
    while (i + 1 < keys.length && keys[i + 1].t <= t + 1e-5) i++;
    const a = keys[i], b = keys[Math.min(keys.length - 1, i + 1)];
    return [a, b, a === b ? 0 : Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t)))];
  }
  function field(p, W, H) {
    if (cache.has(p)) { const saved = cache.get(p); cache.delete(p); cache.set(p, saved); return saved; }
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const cc = c.getContext('2d'), im = cc.createImageData(W, H);
    const colors = (p.colors ?? (p.color ? [p.color, p.color, p.color, p.color] : null))?.map(hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)));
    for (let y = 0; y < H; y++) {
      const Y = y / H * 2 - 1;
      for (let x = 0; x < W; x++) {
        const X = x / W * 2 - 1, b = [1, X, Y, X * X, X * Y, Y * Y], i = (y * W + x) * 4;
        for (let k = 0; k < 3; k++) {
          if (colors) {
            const u = x / Math.max(1, W - 1), v = y / Math.max(1, H - 1);
            im.data[i + k] = (colors[0][k] * (1 - u) + colors[1][k] * u) * (1 - v) + (colors[3][k] * (1 - u) + colors[2][k] * u) * v;
            continue;
          }
          let v = 0;
          for (let n = 0; n < 6; n++) v += b[n] * p.coef[n][k];
          im.data[i + k] = Math.min(p.range[1][k], Math.max(p.range[0][k], v));
        }
        im.data[i + 3] = 255;
      }
    }
    cc.putImageData(im, 0, 0); cache.set(p, c); cacheBytes += W * H * 4;
    // 逐帧拟合的颜色节点可能有数百个，不能把整片所有底图一直留在显存里。
    while (cacheBytes > 32 * 1024 * 1024 && cache.size > 1) {
      const key = cache.keys().next().value, old = cache.get(key); cacheBytes -= old.width * old.height * 4; cache.delete(key);
    }
    return c;
  }
  function homography(q) {
    const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
    const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
    const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
    const den = dx1 * dy2 - dx2 * dy1;
    const g = Math.abs(den) < 1e-8 ? 0 : (dx3 * dy2 - dx2 * dy3) / den;
    const h = Math.abs(den) < 1e-8 ? 0 : (dx1 * dy3 - dx3 * dy1) / den;
    return (u, v) => [((x1 - x0 + g * x1) * u + (x3 - x0 + h * x3) * v + x0) / (g * u + h * v + 1),
      ((y1 - y0 + g * y1) * u + (y3 - y0 + h * y3) * v + y0) / (g * u + h * v + 1)];
  }
  // 用小三角形将素材映射到透视四边形，替换素材后保留面板的形变。
  function warped(source, project, W, H, fit) {
    const sw = source.videoWidth || source.naturalWidth || source.width, sh = source.videoHeight || source.naturalHeight || source.height;
    if (!sw || !sh) return;
    const tmp = document.createElement('canvas'); tmp.width = W * 2; tmp.height = H * 2;
    const tc = tmp.getContext('2d'), scale = fit === 'contain' ? Math.min(tmp.width / sw, tmp.height / sh) : Math.max(tmp.width / sw, tmp.height / sh);
    if (fit === 'stretch') tc.drawImage(source, 0, 0, tmp.width, tmp.height);
    else tc.drawImage(source, (tmp.width - sw * scale) / 2, (tmp.height - sh * scale) / 2, sw * scale, sh * scale);
    function triangle(s, d) {
      const [[sx0, sy0], [sx1, sy1], [sx2, sy2]] = s, [[x0, y0], [x1, y1], [x2, y2]] = d;
      const det = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
      const a = ((x1 - x0) * (sy2 - sy0) - (x2 - x0) * (sy1 - sy0)) / det;
      const c = ((x2 - x0) * (sx1 - sx0) - (x1 - x0) * (sx2 - sx0)) / det;
      const b = ((y1 - y0) * (sy2 - sy0) - (y2 - y0) * (sy1 - sy0)) / det;
      const e = ((y2 - y0) * (sx1 - sx0) - (y1 - y0) * (sx2 - sx0)) / det;
      ctx.save(); ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); ctx.clip();
      ctx.transform(a, b, c, e, x0 - a * sx0 - c * sy0, y0 - b * sx0 - e * sy0); ctx.drawImage(tmp, 0, 0); ctx.restore();
    }
    const n = 8;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const uv = [[x / n, y / n], [(x + 1) / n, y / n], [(x + 1) / n, (y + 1) / n], [x / n, (y + 1) / n]];
      const s = uv.map(([u, v]) => [u * tmp.width, v * tmp.height]);
      const d = uv.map(([u, v]) => { const p = project(u, v); return [p[0] * W, p[1] * H]; });
      triangle([s[0], s[1], s[2]], [d[0], d[1], d[2]]); triangle([s[0], s[2], s[3]], [d[0], d[2], d[3]]);
    }
  }
  return function draw(d, localTime, source = null, fit = 'cover') {
    const W = d.width, H = d.height, t = localTime + (d.offset ?? 0), media = d.content === 'media' && source;
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / H, 0, 0); ctx.clearRect(0, 0, W, H); ctx.globalAlpha = 1;
    function shape(polys) {
      const p = new Path2D();
      for (const q of polys) { p.moveTo(q[0][0] * W, q[0][1] * H); for (let i = 1; i < q.length; i++) p.lineTo(q[i][0] * W, q[i][1] * H); p.closePath(); }
      return p;
    }
    function paint(keys) {
      const [a, b, f] = span(keys, t); ctx.drawImage(field(a.paint, W, H), 0, 0);
      if (f > 0) { ctx.globalAlpha = f; ctx.drawImage(field(b.paint, W, H), 0, 0); ctx.globalAlpha = 1; }
    }
    function content(keys, q = [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      if (media) warped(media, homography(q), W, H, fit); else if (d.content === 'generated') paint(keys);
    }
    function number(x, y, transform = null) {
      if (!d.showText) return;
      ctx.save(); ctx.translate(x * W, y * H); if (transform) ctx.transform(...transform, 0, 0);
      const size = d.fontSize; ctx.font = `bold ${size}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      const m = ctx.measureText(d.text), base = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2; ctx.lineJoin = 'round';
      const lines = d.text.split('\n');
      lines.forEach((line, i) => {
        const y = base + (i - (lines.length - 1) / 2) * size * 1.2;
        if (d.echo) { const dx = size < 30 ? .8 : 2.2, dy = size < 30 ? 1.2 : 4.4; ctx.lineWidth = .6; ctx.strokeStyle = '#29242c'; ctx.fillStyle = 'rgba(255,255,255,.88)'; ctx.strokeText(line, dx, y + dy); ctx.fillText(line, dx, y + dy); }
        if (!d.plain) { ctx.lineWidth = 1; ctx.strokeStyle = '#27212a'; ctx.strokeText(line, 0, y); }
        ctx.fillStyle = d.textColor ?? '#f6f7f6'; ctx.fillText(line, 0, y);
      }); ctx.restore();
    }
    if (d.type === 'field') content(d.keys);
    else if (d.type === 'text') { if (media) content(); number(...(d.center ?? [.5, .5])); }
    else if (d.type === 'signature') {
      if (media) content();
      if (d.showText) { ctx.save(); ctx.font = `italic ${d.fontSize}px "Snell Roundhand",cursive`; ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(246,247,245,.7)'; ctx.shadowBlur = 1; ctx.shadowColor = '#ddd'; ctx.fillText(d.text, W * .5, H * .958); ctx.restore(); }
    } else if (d.type === 'opening') {
      if (t < d.fadeEnd) { ctx.save(); ctx.clip(shape([d.quad])); content(d.keys, d.quad); ctx.restore(); }
      if (t >= d.numberAt - 1e-5) number(...d.center);
    } else if (d.type === 'panel') {
      const [a, b, f] = span(d.keys, t), q = a.quad.map((v, i) => v.map((x, j) => x * (1 - f) + b.quad[i][j] * f));
      ctx.save(); ctx.clip(shape([q])); content(d.keys, q);
      const project = homography(q), c = project(.5, .5), u = project(.51, .5), v = project(.5, .51);
      const ux = (u[0] - c[0]) * W, uy = (u[1] - c[1]) * H, vx = (v[0] - c[0]) * W, vy = (v[1] - c[1]) * H;
      const ul = Math.hypot(ux, uy) || 1, vl = Math.hypot(vx, vy) || 1;
      number(c[0], c[1], [ux / ul, uy / ul, vx / vl, vy / vl]); ctx.restore();
    } else if (d.type === 'mask') {
      let polygons = [], parts = [];
      for (const step of d.steps) { if (step.t > t + 1e-5) break; if (step.replace) { polygons = step.replace; parts = step.parts; } else { polygons = [...polygons, ...step.add]; parts = [...parts, ...step.parts]; } }
      if (!polygons.length) return;
      const p = shape(polygons); ctx.save(); ctx.shadowColor = 'rgba(0,0,0,1)'; ctx.fillStyle = '#101016';
      for (const [blur, offset] of [[28, 5], [6, 1]]) { ctx.shadowBlur = blur; ctx.shadowOffsetY = offset; ctx.fill(p); } ctx.restore();
      ctx.save(); ctx.clip(p);
      if (media || d.sharedPaint || t >= d.fullAt - 1e-5) {
        content(d.keys);
        if (!media && t < d.fullAt - 1e-5) for (const part of parts) if (part.paintOverride) { ctx.save(); ctx.clip(shape([part.quad])); content(part.keys); ctx.restore(); }
      }
      else for (const part of parts) { ctx.save(); ctx.clip(shape([part.quad])); content(part.keys); ctx.restore(); }
      number(.5, .5); ctx.restore();
    }
  };
}

/** 同预览的线性关键帧（用于导出页面）。 */
export function drawingTransform(segment, offset) {
  const base = { scale_x: 1, scale_y: 1, transform_x: 0, transform_y: 0, rotation: 0, alpha: 1, ...segment.transform };
  const properties = new Set((segment.keyframes ?? []).map(k => k.property));
  for (const property of properties) {
    const points = segment.keyframes.filter(k => k.property === property).sort((a, b) => a.offset_us - b.offset_us);
    let value = points.at(-1).value;
    if (offset <= points[0].offset_us) value = points[0].value;
    else for (let i = 1; i < points.length; i++) if (offset <= points[i].offset_us) {
      const a = points[i - 1], b = points[i]; value = a.value + (b.value - a.value) * (offset - a.offset_us) / (b.offset_us - a.offset_us); break;
    }
    base[property] = value;
  }
  if (properties.has('uniform_scale')) base.scale_x = base.scale_y = base.uniform_scale;
  return base;
}

/** 与其他文字页面一样作为 film.html 的透明图层，独立的素材地址相对这个页面。 */
export function drawingPage(segment, stage, sourceUrl = null) {
  const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
  return `<!doctype html><html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden;background:transparent}canvas{position:absolute;inset:0;width:100%;height:100%}</style><canvas width="${stage.width}" height="${stage.height}"></canvas><script>
const segment=${json(segment)},src=${json(sourceUrl)},canvas=document.querySelector('canvas');
const draw=(${createDrawingRenderer.toString()})(canvas),transform=${drawingTransform.toString()};
let media=null;
const ready=src&&segment.drawing.content==='media'?new Promise((resolve,reject)=>{media=document.createElement(segment.kind==='video'?'video':'img');media.crossOrigin='anonymous';media.muted=true;media.preload='auto';media.addEventListener(segment.kind==='video'?'loadeddata':'load',resolve,{once:true});media.addEventListener('error',()=>reject(new Error('替换素材加载失败')),{once:true});media.src=src;}):Promise.resolve();
window.film={width:${stage.width},height:${stage.height},duration:segment.timeline.duration_us/1e6,async frame(t){
await ready;
if(media&&segment.kind==='video'){const at=Math.max(0,Math.min(media.duration-.001,(segment.source.start_us+t*1e6*segment.speed)/1e6));if(Math.abs(media.currentTime-at)>.00001)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('替换视频寻帧超时')),10000);media.addEventListener('seeked',()=>{clearTimeout(timer);resolve();},{once:true});media.currentTime=at;});}
draw(segment.drawing,t,media,segment.fit);
const v=transform(segment,t*1e6);canvas.style.transform='translate('+(v.transform_x*50)+'%,'+(-v.transform_y*50)+'%) rotate('+v.rotation+'deg) scale('+(v.scale_x*(v.flip_horizontal?-1:1))+','+(v.scale_y*(v.flip_vertical?-1:1))+')';canvas.style.opacity=v.alpha;
canvas.style.filter='brightness('+Math.max(0,1+(v.brightness??0))+') contrast('+Math.max(0,1+(v.contrast??0))+') saturate('+Math.max(0,1+(v.saturation??0))+')';
}};
</script></html>`;
}
