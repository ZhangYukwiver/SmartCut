import React, { useEffect, useState } from "react";
import { drawingProblem, type DrawingLayer, type DrawingQuad } from "../../../server/aiEdit/drawing.mjs";
import type { EditMediaSegment } from "../../services/aiEdit";
import { useBoard } from "./aiEditBoardContext";
import { workspaceColors as color } from "./workspaceTheme";

const control: React.CSSProperties = { boxSizing: 'border-box', width: '100%', minWidth: 0, background: color.surface, color: color.text, border: `1px solid ${color.border}`, borderRadius: 4, padding: '5px 6px', font: 'inherit' };
const button: React.CSSProperties = { ...control, cursor: 'pointer', width: 'auto' };
const row: React.CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', marginTop: 6 };
const properties: Record<string, string> = { transform_x: '水平位置', transform_y: '垂直位置', uniform_scale: '整体缩放', rotation: '旋转角度', alpha: '不透明度', brightness: '亮度', contrast: '对比度', saturation: '饱和度' };

function Numeric({ label, value, onChange, step = .01 }: { label: string; value: number; onChange: (v: number) => void; step?: number }) {
  return <label style={{ display: 'flex', flex: 1, flexDirection: 'column', gap: 3, minWidth: 0 }}>{label}
    <input aria-label={label} type="number" step={step} value={Number(value.toFixed(6))} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) onChange(e.target.valueAsNumber); }} style={control} />
  </label>;
}
function QuadEditor({ quad, onChange }: { quad: DrawingQuad; onChange: (q: DrawingQuad) => void }) {
  return <div>{quad.map(([x, y], i) => <div key={i} style={row}>
    {(['X', 'Y'] as const).map((axis, j) => <Numeric key={axis} label={`${quad.length === 4 ? ['左上', '右上', '右下', '左下'][i] : `顶点 ${i + 1}`} ${axis} %`} value={(j ? y : x) * 100} step={.1} onChange={v => {
      const next = quad.map(p => [...p]) as DrawingQuad; next[i]![j] = v / 100; onChange(next);
    }} />)}
  </div>)}</div>;
}

/** 数据编辑走已有编辑/撤销接口；不修改素材库中的原文件。 */
export function DrawingEditor({ segment }: { segment: EditMediaSegment }) {
  const { mediaById, editable, runEdit, runEdits, playback, flushHeld } = useBoard();
  const [draft, setDraft] = useState<DrawingLayer>(() => structuredClone(segment.drawing!));
  const [mediaId, setMediaId] = useState('');
  const [node, setNode] = useState(0);
  const [keyId, setKeyId] = useState('');
  const [property, setProperty] = useState('transform_x');
  const [at, setAt] = useState(0);
  const [value, setValue] = useState(0);
  const [saving, setSaving] = useState(false);
  // 长轮询会返回同内容的新对象；只有已保存的动画数据确实改变时才重置表单。
  const savedDrawing = JSON.stringify(segment.drawing);
  useEffect(() => { setDraft(JSON.parse(savedDrawing)); }, [savedDrawing]);
  const changed = JSON.stringify(draft) !== JSON.stringify(segment.drawing);
  const problem = drawingProblem(draft);
  const mutate = (change: (d: DrawingLayer) => void) => setDraft(before => { const d = structuredClone(before); change(d); return d; });
  const operate = async (action: () => Promise<boolean>) => { setSaving(true); try { await flushHeld(); await action(); } finally { setSaving(false); } };
  const seek = (time: number) => { playback.pause(); playback.seek(segment.timeline.start_us + Math.round((time - (draft.offset ?? 0)) * 1e6)); };
  const step = draft.steps?.[node];
  const key = draft.keys?.[node];
  const blocked = !editable || saving;
  return <fieldset disabled={blocked} style={{ border: 0, borderTop: `1px solid ${color.border}`, padding: '10px 0', margin: 0, minWidth: 0, color: color.text, fontSize: 11 }}>
    <legend style={{ fontWeight: 600 }}>图层动画</legend>
    <label>替换素材
      <select aria-label="替换素材" style={{ ...control, marginTop: 5 }} value={mediaId} onChange={e => setMediaId(e.target.value)}>
        <option value="">选择素材库中的图片或视频</option>
        {[...mediaById.values()].filter(m => m.status === 'ready' && (m.kind === 'image' || m.kind === 'video')).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
    </label>
    <div style={row}>
      <button style={button} disabled={!mediaId || changed} onClick={() => void operate(() => runEdit('update_clip', { clip_id: segment.id, media_id: mediaId, fit: 'cover' }))}>使用选中素材</button>
      {draft.content === 'media' ? <button style={button} onClick={() => mutate(d => { d.content = 'generated'; d.showText = true; })}>恢复绘制内容</button> : null}
    </div>
    {changed ? <div style={{ marginTop: 5, color: color.textMuted }}>先保存或撤回动画修改，再替换素材。</div> : null}
    <label style={{ display: 'block', marginTop: 8 }}>画面文字
      <input aria-label="图层文字" style={control} value={draft.text} maxLength={200} onChange={e => mutate(d => { d.text = e.target.value; })} />
    </label>
    <div style={row}>
      <label><input type="checkbox" checked={draft.showText} onChange={e => mutate(d => { d.showText = e.target.checked; })} />显示文字</label>
      <Numeric label="字号" value={draft.fontSize} step={1} onChange={v => mutate(d => { d.fontSize = v; })} />
    </div>
    {draft.content === 'media' ? <label style={{ display: 'block', marginTop: 6 }}>素材适配
      <select aria-label="动画素材适配" style={control} value={segment.fit} onChange={e => void operate(() => runEdit('update_clip', { clip_id: segment.id, fit: e.target.value }))}>
        <option value="cover">铺满裁切</option><option value="contain">完整显示</option><option value="stretch">拉伸</option>
      </select>
    </label> : null}
    {draft.type === 'panel' || draft.type === 'mask' || draft.type === 'field' ? <>
      <p style={{ marginBottom: 5 }}>{draft.type === 'mask' ? '蒙版分块步骤' : '轮廓 / 颜色关键帧'} · 时间为片段内秒数</p>
      <select aria-label="动画节点" style={control} value={node} onChange={e => { const i = Number(e.target.value); setNode(i); const t = (draft.type === 'mask' ? draft.steps : draft.keys)?.[i]?.t; if (t !== undefined) seek(t); }}>
        {(draft.type === 'mask' ? draft.steps : draft.keys)?.map((k, i) => <option key={i} value={i}>{i + 1} · {(k.t - (draft.offset ?? 0)).toFixed(3)} 秒</option>)}
      </select>
      <div style={row}>
        <Numeric label="节点时间（秒）" value={((draft.type === 'mask' ? step?.t : key?.t) ?? 0) - (draft.offset ?? 0)} onChange={v => mutate(d => {
          const t = v + (d.offset ?? 0);
          if (d.type === 'mask') {
            const s = d.steps![node]!, delta = t - s.t;
            if (Math.abs(d.fullAt! - s.t) < 1e-5) d.fullAt = t;
            s.t = t; s.parts.forEach(p => p.keys.forEach(k => { k.t = Math.max(0, k.t + delta); }));
          } else if (d.keys?.[node]) d.keys[node]!.t = t;
        })} />
        <button style={button} onClick={() => seek((draft.type === 'mask' ? step?.t : key?.t) ?? 0)}>定位</button>
      </div>
      {draft.type === 'panel' && key?.quad ? <QuadEditor quad={key.quad} onChange={q => mutate(d => { d.keys![node]!.quad = q; })} /> : null}
      {draft.type === 'mask' && step ? (step.replace ?? step.add ?? []).map((q, index) => <details key={index}>
        <summary style={{ marginTop: 7, cursor: 'pointer' }}>分块 {index + 1} 轮廓</summary>
        <QuadEditor quad={q} onChange={quad => mutate(d => { const s = d.steps![node]!; (s.replace ?? s.add)![index] = quad; if (s.parts[index]) s.parts[index]!.quad = quad; })} />
      </details>) : null}
      {draft.type === 'mask' ? <div style={row}><Numeric label="铺满时间（秒）" value={draft.fullAt! - (draft.offset ?? 0)} onChange={v => mutate(d => { d.fullAt = v + (d.offset ?? 0); })} /></div> : null}
      {draft.type === 'panel' ? <div style={row}>
        <button style={button} onClick={() => mutate(d => { const k = structuredClone(d.keys![node]!); k.t = Math.max(0, (playback.timeRef.current - segment.timeline.start_us) / 1e6 + (d.offset ?? 0)); d.keys!.push(k); d.keys!.sort((a, b) => a.t - b.t); })}>在播放头复制节点</button>
        <button style={button} disabled={draft.keys!.length < 2} onClick={() => { mutate(d => { d.keys!.splice(node, 1); }); setNode(0); }}>删除节点</button>
      </div> : null}
    </> : null}
    {draft.type === 'opening' ? <>
      <div style={row}><Numeric label="文字出现（秒）" value={draft.numberAt! - (draft.offset ?? 0)} onChange={v => mutate(d => { d.numberAt = v + (d.offset ?? 0); })} /><Numeric label="面板结束（秒）" value={draft.fadeEnd! - (draft.offset ?? 0)} onChange={v => mutate(d => { d.fadeEnd = v + (d.offset ?? 0); })} /></div>
      <details><summary>面板轮廓</summary><QuadEditor quad={draft.quad!} onChange={q => mutate(d => { d.quad = q; })} /></details>
    </> : null}
    {problem ? <div role="alert" style={{ color: color.danger, marginTop: 6 }}>{problem}</div> : null}
    <div style={row}>
      <button style={button} disabled={!changed || Boolean(problem)} onClick={() => void operate(() => runEdit('update_clip', { clip_id: segment.id, drawing: draft }))}>保存动画</button>
      <button style={button} disabled={!changed} onClick={() => setDraft(structuredClone(segment.drawing!))}>撤回未保存修改</button>
    </div>
    <details style={{ marginTop: 12 }} open>
      <summary style={{ cursor: 'pointer', fontWeight: 600 }}>变换关键帧</summary>
      <select aria-label="选择变换关键帧" value={keyId} style={{ ...control, marginTop: 6 }} onChange={e => {
        const id = e.target.value; setKeyId(id);
        const k = segment.keyframes?.find(k => `${k.property}:${k.offset_us}` === id);
        if (k) { setProperty(k.property); setAt(k.offset_us / 1e6); setValue(k.value); playback.pause(); playback.seek(segment.timeline.start_us + k.offset_us); }
        else setAt(Math.max(0, Math.min(segment.timeline.duration_us, playback.timeRef.current - segment.timeline.start_us)) / 1e6);
      }}>
        <option value="">新关键帧</option>
        {segment.keyframes?.map(k => <option key={`${k.property}:${k.offset_us}`} value={`${k.property}:${k.offset_us}`}>{properties[k.property] ?? k.property} · {(k.offset_us / 1e6).toFixed(3)}s · {k.value}</option>)}
      </select>
      <select aria-label="关键帧属性" style={{ ...control, marginTop: 6 }} value={property} onChange={e => { setProperty(e.target.value); setValue(['uniform_scale', 'alpha'].includes(e.target.value) ? 1 : 0); }}>
        {Object.entries(properties).map(([key, title]) => <option key={key} value={key}>{title}</option>)}
      </select>
      <div style={row}><Numeric label="关键帧时间（秒）" value={at} onChange={setAt} /><Numeric label="关键帧值" value={value} onChange={setValue} /></div>
      <p style={{ color: color.textMuted, lineHeight: 1.5 }}>位置 1 = 半个画布，缩放 1 = 原始大小，不透明度 0–1。两个关键帧之间线性变化。</p>
      <div style={row}>
        <button style={button} disabled={at < 0 || at * 1e6 > segment.timeline.duration_us} onClick={() => void operate(async () => {
          const previous = segment.keyframes?.find(k => `${k.property}:${k.offset_us}` === keyId);
          const edits = previous && (previous.property !== property || previous.offset_us !== Math.round(at * 1e6))
            ? [{ name: 'remove_keyframe' as const, arguments: { clip_id: segment.id, property: previous.property, offset: previous.offset_us / 1e6 } }] : [];
          const ok = await runEdits([...edits, { name: 'add_keyframes', arguments: { clip_id: segment.id, keyframes: [{ property, offset: at, value }] } }]);
          if (ok) setKeyId(`${property}:${Math.round(at * 1e6)}`); return ok;
        })}>写入关键帧</button>
        <button style={button} disabled={!keyId} onClick={() => void operate(async () => {
          const k = segment.keyframes?.find(k => `${k.property}:${k.offset_us}` === keyId); if (!k) return false;
          const ok = await runEdit('remove_keyframe', { clip_id: segment.id, property: k.property, offset: k.offset_us / 1e6 }); if (ok) setKeyId(''); return ok;
        })}>删除关键帧</button>
      </div>
    </details>
  </fieldset>;
}
