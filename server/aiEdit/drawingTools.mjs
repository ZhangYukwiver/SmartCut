import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AiEditError } from './library.mjs';
import { ProjectStore } from './projectStore.mjs';
import { drawingProblem, drawingTimes } from './drawing.mjs';

const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const number = { type: 'number' };
const point = { type: 'array', items: number, minItems: 2, maxItems: 2 };
const polygon = { type: 'array', items: point, minItems: 3, maxItems: 64 };
const polygons = { type: 'array', items: polygon, maxItems: 64 };
const paint = object({ color: { type: 'string', description: '#RRGGBB 纯色' }, colors: { type: 'array', items: { type: 'string' }, minItems: 4, maxItems: 4, description: '左上、右上、右下、左下的 #RRGGBB，平滑渐变' }, coef: { type: 'array', items: { type: 'array', items: number } }, range: { type: 'array', items: { type: 'array', items: number } } });
const key = object({ t: number, paint, quad: polygon }, ['t', 'paint']);
const step = object({ t: number, add: polygons, replace: polygons, parts: { type: 'array', items: object({ quad: polygon, keys: { type: 'array', items: key }, paintOverride: { type: 'boolean' } }, ['quad', 'keys']) } }, ['t']);
export const DRAWING_SCHEMA = object({
  type: { type: 'string', enum: ['field', 'panel', 'mask', 'text', 'opening', 'signature'] },
  width: number, height: number, offset: number,
  content: { type: 'string', enum: ['generated', 'media'] },
  text: { type: 'string' }, fontSize: number, textColor: { type: 'string' }, showText: { type: 'boolean' }, echo: { type: 'boolean' }, plain: { type: 'boolean' },
  sharedPaint: { type: 'boolean', description: '蒙版的所有分块共用这一层随时间变化的颜色。' },
  keys: { type: 'array', items: key, description: '严格递增的秒数；panel 每个 key 的 quad 必须是左上、右上、右下、左下四点，坐标归一化 0–1。' },
  steps: { type: 'array', items: step, description: 'mask 的分块步骤；add 追加、replace 替换轮廓。parts 可省略，自动用这一层的颜色填充。' },
  fullAt: number, quad: polygon, center: point, numberAt: number, fadeEnd: number,
}, ['type']);

export const DRAWING_NODE_SCHEMA = object({
  kind: { type: 'string', enum: ['key', 'step'] }, index: { type: 'integer', minimum: 0 },
  time: { type: 'number', description: '新的片段内秒数，裁剪偏移由工具处理' }, quad: polygon, paint,
  add: polygons, replace: polygons, remove: { type: 'boolean' },
  polygon_index: { type: 'integer', minimum: 0, description: '只修改 step 内这一条路径，保留其余外框、内圈和色块。' },
  paint_keys: { type: 'array', items: object({ time: number, paint }, ['time', 'paint']), maxItems: 100, description: '该填充色块自己的颜色动画，time 为片段内秒数。' },
}, ['kind', 'index']);

const fail = message => { throw new AiEditError('drawing_invalid', message, 422); };
export const finite = (n, lo = 0, hi = 86400) => typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

/** 给 AI 的简写补默认值，落盘始终是预览/导出已支持的同一份 drawing 数据。 */
export function completeDrawing(input, canvas) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('drawing 应为对象');
  const scale = Math.min(1, 640 / Math.max(canvas.width, canvas.height));
  const d = {
    width: Math.max(16, Math.round(canvas.width * scale)), height: Math.max(16, Math.round(canvas.height * scale)),
    content: 'generated', text: '', fontSize: 24, showText: Boolean(input.text), plain: true, echo: false,
    ...structuredClone(input),
  };
  // 静态颜色是颜色关键帧在 t=0 的简写；单个多边形也可以直接给顶点列表。
  if (!d.keys && d.paint && ['field', 'mask', 'panel'].includes(d.type)) {
    d.keys = [{ t: 0, paint: d.paint, ...(d.quad ? { quad: d.quad } : {}) }];
    delete d.paint;
  }
  if (d.type === 'mask' && Array.isArray(d.steps)) {
    d.fullAt ??= d.steps.at(-1)?.t ?? 0;
    d.steps = d.steps.map(s => {
      if (!s) return s;
      for (const field of ['add', 'replace']) if (Array.isArray(s[field]?.[0]) && typeof s[field][0][0] === 'number') s[field] = [s[field]];
      return { ...s, parts: s.parts ?? (s.replace ?? s.add ?? []).map(quad => ({ quad, keys: structuredClone(d.keys) })) };
    });
  }
  const problem = drawingProblem(d);
  if (problem) fail(problem);
  return d;
}

export function drawingSummary(d) {
  return { type: d.type, text: d.text, content: d.content, ...(d.referenceId ? { reference_media_id: d.referenceId } : {}), nodes: drawingTimes(d).slice(0, 80), key_count: d.keys?.length ?? 0, step_count: d.steps?.length ?? 0 };
}

/** 分层计划先在临时工程里通过现有 Store 校验，最后只写一次真实工程；失败/停止不会留下半条时间线。 */
export async function commitDrawingLayers(ctx, layers, { before, canvas = before.canvas, name = before.name, audioId, duration, note = '' } = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'reellab-layers-'));
  const imported = [];
  let committed = false;
  try {
    const staged = new ProjectStore({ directory: path.join(folder, 'projects'), mediaRoots: ctx.store.mediaRoots, probe: ctx.store.probe, maxMediaBytes: ctx.store.maxMediaBytes });
    let p = await staged.createProject({ name, canvas });
    p = await staged.restoreProject(p.id, { ...before, name, canvas });
    let backing = ctx.library.list().find(m => m.status === 'ready' && m.source?.type === 'drawing');
    for (const layer of layers) {
      ctx.signal?.throwIfAborted();
      if (!finite(layer.start) || !finite(layer.duration, .000001) || !finite(layer.start + layer.duration)) fail('图层开始时间或时长无效');
      const drawing = completeDrawing(layer.drawing, canvas);
      let item = layer.media_id ? ctx.library.get(layer.media_id) : null;
      if (!item) {
        if (layer.media_id) fail('指定的替换素材不存在');
        if (drawing.content === 'media') fail('media 图层需要素材');
        if (!backing) {
          const file = path.join(folder, 'drawing.png');
          await writeFile(file, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==', 'base64'));
          backing = await ctx.library.importFile(file, '动画图层底图.png', { source: { type: 'drawing' } });
          imported.push(backing.id);
        }
        item = backing;
      }
      if (!['image', 'video'].includes(item.kind)) fail('图层素材只能是图片或视频');
      if (layer.media_id) drawing.content = 'media';
      let trackId = layer.track_id;
      if (!trackId) {
        const wanted = String(layer.name || '动画图层').slice(0, 180);
        let label = wanted, suffix = 2;
        while (p.tracks.some(t => t.name === label)) label = `${wanted} ${suffix++}`;
        p = await staged.createTrack(p.id, { track_type: 'video', name: label });
        trackId = p.tracks.at(-1).id;
      }
      const startUs = Math.round(layer.start * 1e6), durationUs = Math.round(layer.duration * 1e6);
      const sourceStart = Math.round((layer.source_start ?? 0) * 1e6);
      const existing = new Set(p.tracks.find(t => t.id === trackId)?.segments.map(s => s.id));
      p = await staged.addMediaSegment(p.id, trackId, {
        path: ctx.library.readyPath(item.id), material_name: String(layer.name || item.name).slice(0, 200),
        timeline: { start_us: startUs, duration_us: durationUs }, source: { start_us: sourceStart, duration_us: durationUs },
        speed: 1, volume: 0, fit: layer.fit ?? 'cover', drawing,
        ...(layer.transform ? { transform: layer.transform } : {}),
      });
      if (layer.keyframes?.length) {
        const segment = p.tracks.find(t => t.id === trackId).segments.find(s => !existing.has(s.id));
        p = await staged.addKeyframes(p.id, segment.id, { keyframes: layer.keyframes.map(k => ({ property: k.property, offset_us: Math.round(k.offset * 1e6), value: k.value })) });
      }
    }
    if (audioId) {
      p = await staged.createTrack(p.id, { track_type: 'audio', name: '参考原声' });
      p = await staged.addMediaSegment(p.id, p.tracks.at(-1).id, {
        path: ctx.library.readyPath(audioId), material_name: '参考原声',
        timeline: { start_us: Math.round((layers[0]?.origin ?? 0) * 1e6), duration_us: Math.round(duration * 1e6) },
      });
    }
    ctx.signal?.throwIfAborted();
    const project = await ctx.store.restoreProject(ctx.projectId, p, { expectRevision: before.revision });
    committed = true;
    return { project, note };
  } finally {
    if (!committed) for (const id of imported) await ctx.library.remove(id).catch(() => undefined);
    await rm(folder, { recursive: true, force: true });
  }
}

export async function addDrawingClip(ctx, args) {
  const before = await ctx.store.getProject(ctx.projectId);
  return commitDrawingLayers(ctx, [{ ...args, start: args.start ?? 0 }], { before });
}

/** 对话编辑与自动校准共用的局部修改；先在副本上完成所有节点，再校验整层。 */
export function reviseDrawing(drawing, args) {
  if (!drawing) fail('这个片段不是可编辑动画图层');
  const d = structuredClone(drawing);
  for (const [arg, field] of [['text', 'text'], ['font_size', 'fontSize'], ['text_color', 'textColor'], ['show_text', 'showText'], ['center', 'center'], ['echo', 'echo'], ['plain', 'plain']]) {
    if (Object.hasOwn(args, arg)) d[field] = args[arg];
  }
  if (args.drawing_type !== undefined) {
    if (!['text', 'signature'].includes(d.type) || !['text', 'signature'].includes(args.drawing_type)) fail('只能在独立文字与手写署名之间切换');
    d.type = args.drawing_type;
  }
  if (args.full_at !== undefined) d.fullAt = args.full_at + (d.offset ?? 0);
  const nodes = args.nodes ?? (args.node ? [args.node] : []);
  for (const n of nodes.filter(n => !n.insert)) {
    const list = n.kind === 'key' ? d.keys : n.kind === 'step' ? d.steps : null;
    if (!list || !Number.isInteger(n.index) || n.index < 0 || !list[n.index]) fail('动画节点不存在，先用 get_clip 查看节点序号');
    const target = list[n.index];
    if (n.polygon_index !== undefined) {
      const polygons = target.replace ?? target.add, index = n.polygon_index;
      if (n.kind !== 'step' || !Number.isInteger(index) || index < 0 || !polygons?.[index] || !target.parts?.[index]
        || n.time !== undefined || n.add || n.replace) fail('局部路径修改需要 step 的 index、polygon_index，只传 quad、paint、paint_keys 或 remove');
      if (n.remove) {
        if (polygons.length === 1 || n.quad || n.paint || n.paint_keys) fail('删除路径时不同时改颜色或坐标，且至少保留一条路径');
        polygons.splice(index, 1); target.parts.splice(index, 1);
      } else {
        const part = target.parts[index];
        if (n.quad && (!Array.isArray(n.quad) || n.quad.length < 3 || n.quad.length > 64 || !n.quad.every(p => Array.isArray(p) && p.length === 2 && p.every(v => finite(v, -10, 10))))) fail('局部路径坐标无效');
        if (n.quad) { polygons[index] = n.quad; part.quad = n.quad; }
        if (n.paint || n.paint_keys) {
          const q = polygons[index], signedArea = q.reduce((sum, p, i) => { const next = q[(i + 1) % q.length]; return sum + p[0] * next[1] - next[0] * p[1]; }, 0);
          if (signedArea <= 0) fail('内圈是透明镂空，不能给内圈上色；请选正面积的填充色块');
          if (n.paint && n.paint_keys) fail('paint 和 paint_keys 只选一项');
          if (n.paint_keys && (!Array.isArray(n.paint_keys) || !n.paint_keys.length || n.paint_keys.length > 100 || n.paint_keys.some(k => !finite(k?.time, -(d.offset ?? 0)) || !k.paint))) fail('局部颜色动画需要有效的 time 和 paint');
          part.keys = n.paint_keys ? n.paint_keys.map(k => ({ t: k.time + (d.offset ?? 0), paint: k.paint })) : [{ t: target.t, paint: n.paint }];
          part.paintOverride = true;
        }
      }
      continue;
    }
    if (n.paint_keys) fail('局部颜色动画需要 polygon_index');
    if (n.remove) {
      if (list.length === 1) fail('至少保留一个动画节点');
      list.splice(n.index, 1);
    } else {
      if (n.time !== undefined) {
        if (!finite(n.time, -86400)) fail('节点时间无效');
        const time = n.time + (d.offset ?? 0), delta = time - target.t;
        if (n.kind === 'step') {
          if (Math.abs(d.fullAt - target.t) < 1e-5) d.fullAt = time;
          target.parts.forEach(p => p.keys.forEach(k => { k.t = Math.max(0, k.t + delta); }));
        }
        target.t = time;
      }
      if (n.kind === 'key') {
        if (n.quad) target.quad = n.quad;
        if (n.paint) target.paint = n.paint;
        if (n.add || n.replace) fail('轮廓关键帧不能写蒙版步骤');
      } else {
        if (n.quad || n.paint) fail('蒙版步骤使用 add 或 replace 多边形列表');
        if (n.add || n.replace) {
          const priorParts = target.parts;
          delete target.add; delete target.replace;
          if (n.replace) target.replace = n.replace; else target.add = n.add;
          target.parts = (n.replace ?? n.add).map((quad, i, all) => {
            const prior = priorParts.find(p => JSON.stringify(p.quad) === JSON.stringify(quad)) ?? (all.length === priorParts.length ? priorParts[i] : null);
            return { ...(prior ? structuredClone(prior) : { keys: structuredClone(d.sharedPaint ? [d.keys[0]] : d.keys) }), quad };
          });
        }
      }
    }
  }
  // 原节点索引始终先按原列表处理，最后再插入，避免前面的插入挪动后面的修改目标。
  for (const n of nodes.filter(n => n.insert)) {
    if (n.polygon_index !== undefined || n.paint_keys) fail('新增时间节点不能同时修改已有路径');
    if (n.insert !== true || n.remove || n.index !== undefined || !finite(n.time, -86400)) fail('新增节点使用 insert:true 和 time，不使用 index 或 remove');
    const list = n.kind === 'key' ? d.keys : n.kind === 'step' ? d.steps : null, time = n.time + (d.offset ?? 0);
    if (!list?.length || time < 0 || list.some(k => Math.abs(k.t - time) < .000001)) fail('新增节点时间无效或已有同时间节点，请改用原 index 修改');
    let added;
    if (n.kind === 'key') {
      if (n.add || n.replace) fail('轮廓关键帧不能写蒙版步骤');
      const prior = list.findLast(k => k.t < time) ?? list[0];
      added = { ...structuredClone(prior), t: time, ...(n.quad ? { quad: n.quad } : {}), ...(n.paint ? { paint: n.paint } : {}) };
    } else {
      if (n.quad || n.paint || Boolean(n.add) === Boolean(n.replace)) fail('新增蒙版步骤需要 add 或 replace 中的一项');
      const polygons = n.replace ?? n.add;
      if (!Array.isArray(polygons)) fail('新增蒙版步骤需要多边形列表');
      added = { t: time, ...(n.replace ? { replace: n.replace } : { add: n.add }), parts: polygons.map(quad => ({ quad, keys: structuredClone(d.sharedPaint ? [d.keys[0]] : d.keys) })) };
    }
    list.push(added); list.sort((a, b) => a.t - b.t);
  }
  const problem = drawingProblem(d);
  if (problem) fail(problem);
  return d;
}

/** 修改单个节点时只动指定字段，保留同层其余参数及所有其他图层。 */
export async function updateDrawingClip(ctx, args) {
  const segment = await ctx.store.getSegment(ctx.projectId, args.clip_id);
  const d = reviseDrawing(segment.drawing, args);
  return ctx.store.updateSegment(ctx.projectId, args.clip_id, { drawing: d });
}
