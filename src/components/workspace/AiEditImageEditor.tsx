import React, { useEffect, useRef, useState } from "react";
import { Modal, useWindowDimensions } from "react-native";
import type { Connection } from "../../services/connection";
import { imageEditBase64, repairAiEditImage, saveAiEditImage, type AiEditMediaItem } from "../../services/aiEdit";
import { workspaceColors as color } from "./workspaceTheme";

type Mode = "erase" | "restore" | "repair";
type Point = { x: number; y: number };
type Stroke = { kind: "stroke"; mode: Mode; size: number; points: Point[] };
type Step = Stroke | { kind: "repair"; bitmap: ImageBitmap; item: AiEditMediaItem } | { kind: "clear" };
const modes: Record<Mode, string> = { erase: "擦除", restore: "恢复", repair: "涂选去字" };
const button: React.CSSProperties = { border: `1px solid ${color.border}`, borderRadius: 6, background: color.surface, color: color.text, padding: "7px 11px", cursor: "pointer", font: "inherit", whiteSpace: "nowrap" };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const checker: React.CSSProperties = { backgroundColor: "#eee", backgroundImage: "conic-gradient(#ccc 25%, transparent 0 50%, #ccc 0 75%, transparent 0)", backgroundSize: "20px 20px" };
// base、原图和两张画布共用一个有界的解码预算；推理仍可处理更大的图片。
const EDITOR_MAX_PIXELS = 16_000_000;

async function bitmap(url: string, signal: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("图片没加载好，请重新打开。");
  return createImageBitmap(await response.blob());
}
const png = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("图片太大或无法导出，请缩小图片后重试。")), "image/png"));

/** 手动改透明度，选区修复走本机模型；所有保存都产生新的素材。 */
export function AiEditImageEditor({ connection, item, original, mediaUrl, onSaved, onClose }: {
  connection: Connection; item: AiEditMediaItem; original: AiEditMediaItem | null;
  mediaUrl: (id: string) => string | null; onSaved: (item: AiEditMediaItem) => void; onClose: () => void;
}) {
  const viewport = useWindowDimensions();
  const canvas = useRef<HTMLCanvasElement>(null), selection = useRef<HTMLCanvasElement>(null);
  const dialog = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const base = useRef<ImageBitmap | null>(null), source = useRef<ImageBitmap | null>(null);
  const steps = useRef<Step[]>([]), position = useRef(0), working = useRef(item);
  const painting = useRef<Stroke | null>(null), controller = useRef<AbortController | null>(null), alive = useRef(true), blocked = useRef(false);
  const background = useRef(false);
  const [size, setSize] = useState({ width: 0, height: 0 }), [mode, setMode] = useState<Mode>("erase"), [brush, setBrush] = useState(40);
  const [zoom, setZoom] = useState(1), [, setVersion] = useState(0), [hasSelection, setHasSelection] = useState(false);
  const [problem, setProblem] = useState(""), [busy, setBusy] = useState(""), [showOriginal, setShowOriginal] = useState(false);
  const imageUrl = mediaUrl(item.id), originalUrl = mediaUrl(original?.id ?? item.id);
  const fit = size.width ? Math.max(.02, Math.min(1, (viewport.width - 100) / size.width, (viewport.height - 270) / size.height)) : 1;
  const scale = fit * zoom;

  function stamp(stroke: Stroke, from: Point, to: Point) {
    const target = (stroke.mode === "repair" ? selection.current : canvas.current)?.getContext("2d");
    if (!target || !source.current) return;
    const count = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / Math.max(1, stroke.size / 5)));
    for (let i = 1; i <= count; i += 1) {
      const x = from.x + (to.x - from.x) * i / count, y = from.y + (to.y - from.y) * i / count;
      target.save(); target.beginPath(); target.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
      if (stroke.mode === "restore") { target.clip(); target.drawImage(source.current, 0, 0); }
      else { target.globalCompositeOperation = stroke.mode === "erase" ? "destination-out" : "source-over"; target.fillStyle = "#ef4444"; target.fill(); }
      target.restore();
    }
  }
  function replay() {
    const ctx = canvas.current?.getContext("2d"), mask = selection.current?.getContext("2d");
    if (!ctx || !mask || !base.current) return;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.drawImage(base.current, 0, 0);
    mask.clearRect(0, 0, mask.canvas.width, mask.canvas.height);
    let selected = false; working.current = item;
    for (const step of steps.current.slice(0, position.current)) {
      if (step.kind === "repair") {
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height); ctx.drawImage(step.bitmap, 0, 0);
        mask.clearRect(0, 0, mask.canvas.width, mask.canvas.height); selected = false; working.current = step.item;
      } else if (step.kind === "clear") { mask.clearRect(0, 0, mask.canvas.width, mask.canvas.height); selected = false; }
      else {
        step.points.forEach((point, index) => stamp(step, step.points[Math.max(0, index - 1)]!, point));
        if (step.mode === "repair") selected = true;
      }
    }
    setHasSelection(selected); setVersion(value => value + 1);
  }
  function push(step: Step) {
    for (const discarded of steps.current.splice(position.current)) if (discarded.kind === "repair") discarded.bitmap.close();
    steps.current.push(step); position.current += 1;
  }
  function undo(delta: number) {
    if (blocked.current || painting.current) return;
    position.current = Math.max(0, Math.min(steps.current.length, position.current + delta)); replay();
  }

  useEffect(() => {
    const abort = new AbortController(); alive.current = true;
    const focused = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const load = async () => {
      if (!imageUrl || !originalUrl) throw new Error("素材文件地址不可用，请重新打开。");
      if ((item.width ?? 0) * (item.height ?? 0) > EDITOR_MAX_PIXELS || (item.size ?? 0) > 50 * 1024 ** 2) throw new Error("精修支持 50MB、1600 万像素以内的图片，请缩小图片后再试。");
      const currentImage = bitmap(imageUrl, abort.signal);
      const loaded = await Promise.allSettled([currentImage, imageUrl === originalUrl ? currentImage : bitmap(originalUrl, abort.signal)]);
      if (abort.signal.aborted || loaded.some(result => result.status === "rejected")) {
        for (const result of loaded) if (result.status === "fulfilled") result.value.close();
        if (!abort.signal.aborted) throw new Error("读不出图片或原图，请重新打开。");
        return;
      }
      const current = (loaded[0] as PromiseFulfilledResult<ImageBitmap>).value, origin = (loaded[1] as PromiseFulfilledResult<ImageBitmap>).value;
      if (current.width * current.height > EDITOR_MAX_PIXELS || current.width !== origin.width || current.height !== origin.height) {
        current.close(); origin.close(); throw new Error("图片和原图尺寸不一致，无法精修。");
      }
      base.current = current; source.current = origin;
      for (const target of [canvas.current, selection.current]) if (target) { target.width = current.width; target.height = current.height; }
      setSize({ width: current.width, height: current.height }); replay();
    };
    void load().catch(error => { if (!abort.signal.aborted) setProblem(error.message); });
    return () => {
      alive.current = false; abort.abort(); if (!background.current) controller.current?.abort(); base.current?.close(); source.current?.close();
      for (const step of steps.current) if (step.kind === "repair") step.bitmap.close();
      steps.current = []; position.current = 0; base.current = null; source.current = null;
      focused?.focus?.();
    };
    // 素材长轮询返回新对象不重置用户正在画的内容。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageUrl, originalUrl]);

  function point(event: React.PointerEvent<HTMLCanvasElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(size.width, (event.clientX - rect.left) * size.width / rect.width)), y: Math.max(0, Math.min(size.height, (event.clientY - rect.top) * size.height / rect.height)) };
  }
  function begin(event: React.PointerEvent<HTMLCanvasElement>) {
    if (event.button !== 0 || blocked.current || !base.current || showOriginal) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = point(event), stroke: Stroke = { kind: "stroke", mode, size: brush, points: [start] };
    push(stroke); painting.current = stroke; stamp(stroke, start, start);
    if (mode === "repair") setHasSelection(true);
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    const stroke = painting.current; if (!stroke) return;
    const next = point(event), previous = stroke.points.at(-1)!;
    stamp(stroke, previous, next); stroke.points.push(next);
  }
  function end() { if (painting.current) { painting.current = null; setVersion(value => value + 1); } }

  async function repair() {
    if (blocked.current || !canvas.current || !selection.current || !hasSelection) return;
    const maximum = Math.max(1, Math.min(6, Math.floor(64 * 1024 ** 2 / (size.width * size.height * 4))));
    if (steps.current.slice(0, position.current).filter(step => step.kind === "repair").length >= maximum) { setProblem("本次编辑的修复记录已达内存上限，请先另存素材，再打开继续修复。"); return; }
    const abort = new AbortController(); controller.current = abort; background.current = true; blocked.current = true; setBusy("正在提交修复选区…"); setProblem("");
    try {
      const [image, mask] = await Promise.all([png(canvas.current).then(imageEditBase64), png(selection.current).then(imageEditBase64)]);
      const result = await repairAiEditImage(connection, working.current.id, image, mask, job => { if (alive.current) setBusy(`${job.stage}${job.progress !== null && job.status === "running" ? ` ${Math.round(job.progress * 100)}%` : "…"}`); }, abort.signal);
      onSaved(result);
      if (!alive.current) return;
      const url = mediaUrl(result.id); if (!url) throw new Error("修复图片地址不可用。");
      const repaired = await bitmap(url, abort.signal);
      if (!alive.current) { repaired.close(); return; }
      push({ kind: "repair", bitmap: repaired, item: result }); replay();
    } catch (error) { if (!abort.signal.aborted && alive.current) setProblem(error instanceof Error ? error.message : "图片修复失败，请重试。"); }
    finally { background.current = false; blocked.current = false; if (alive.current) setBusy(""); }
  }
  async function save() {
    if (blocked.current || !canvas.current || !position.current || hasSelection) return;
    const abort = new AbortController(); controller.current = abort; background.current = true; blocked.current = true; setBusy("正在另存精修素材…"); setProblem("");
    try {
      const last = steps.current[position.current - 1];
      const result = last?.kind === "repair" ? last.item : await saveAiEditImage(connection, working.current.id, await imageEditBase64(await png(canvas.current)), abort.signal);
      onSaved(result); if (alive.current) onClose();
    } catch (error) { if (!abort.signal.aborted && alive.current) setProblem(error instanceof Error ? error.message : "精修素材没保存成功，请重试。"); }
    finally { background.current = false; blocked.current = false; if (alive.current) setBusy(""); }
  }
  function keyboard(event: React.KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); onClose(); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey ? 1 : -1); }
    if (event.key !== "Tab") return;
    const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), canvas[tabindex="0"]') ?? [])];
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
  const loaded = size.width > 0;
  return <Modal visible transparent animationType="fade" onRequestClose={onClose}>
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div ref={dialog} className="reellab-image-editor" role="dialog" aria-modal="true" aria-label="图片精修" onKeyDown={keyboard} style={{ width: "min(1200px,100%)", height: "min(900px,calc(100dvh - 32px))", background: color.surface, borderRadius: 12, display: "flex", flexDirection: "column", color: color.text, fontSize: 13, fontFamily: "inherit", overflow: "hidden" }}>
        <style>{".reellab-image-editor button:disabled { opacity: .4; cursor: default; }"}</style>
        <header style={{ ...row, justifyContent: "space-between", padding: "12px 16px", borderBottom: `1px solid ${color.border}` }}>
          <strong>图片精修 · {item.name}</strong><button ref={closeButton} style={button} aria-label="关闭图片精修" onClick={onClose}>关闭</button>
        </header>
        <div style={{ ...row, padding: "10px 16px", borderBottom: `1px solid ${color.border}` }}>
          {(Object.keys(modes) as Mode[]).map(value => <button key={value} style={{ ...button, background: mode === value ? color.accent : color.surface, color: mode === value ? "white" : color.text }} aria-pressed={mode === value} disabled={!loaded || Boolean(busy)} onClick={() => { setMode(value); setShowOriginal(false); }}>{modes[value]}</button>)}
          <label style={row}>画笔 <input aria-label="精修画笔大小" type="range" min={2} max={220} value={brush} disabled={Boolean(busy)} onChange={event => setBrush(Number(event.target.value))} style={{ width: 100 }} />{brush}px</label>
          <button style={button} disabled={!loaded || Boolean(busy) || !position.current} onClick={() => undo(-1)}>撤销</button>
          <button style={button} disabled={Boolean(busy) || position.current >= steps.current.length} onClick={() => undo(1)}>重做</button>
          <button style={button} disabled={!loaded || Boolean(busy)} aria-pressed={showOriginal} onClick={() => setShowOriginal(value => !value)}>{showOriginal ? "返回编辑" : "查看原图"}</button>
          <div style={row}><button style={button} aria-label="缩小精修图片" disabled={zoom <= .5} onClick={() => setZoom(value => Math.max(.5, value / 1.4))}>−</button><span>{Math.round(scale * 100)}%</span><button style={button} aria-label="放大精修图片" disabled={zoom >= 8} onClick={() => setZoom(value => Math.min(8, value * 1.4))}>＋</button><button style={button} onClick={() => setZoom(1)}>适应窗口</button></div>
        </div>
        <div style={{ padding: "8px 16px", color: color.textMuted }}>
          {mode === "repair" ? "涂满字幕和文字边缘，再点「修复选区」。一次涂小块，补出的纹理可撤销。" : mode === "restore" ? "涂抹恢复原图中的区域，擦错的位置可以补回来。" : "涂抹去掉椅背、桌面等残留；放大后可修边。"}
          {!original ? " 原图已删除，恢复仅能回到本次打开时的画面。" : ""}
        </div>
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", background: color.surfaceMuted }} aria-label="精修画布视口">
          <div style={{ minWidth: "100%", minHeight: "100%", width: "max-content", display: "flex", justifyContent: "center", alignItems: "center", boxSizing: "border-box", padding: 16 }}>
            {!loaded ? <span>{problem || "正在加载图片…"}</span> : null}
            <div style={{ ...checker, position: "relative", width: size.width * scale, height: size.height * scale, flexShrink: 0, display: loaded ? "block" : "none" }}>
              <canvas ref={canvas} aria-label="图片精修画布" tabIndex={0} onPointerDown={begin} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} style={{ width: "100%", height: "100%", display: "block", touchAction: "none", cursor: showOriginal ? "default" : "crosshair" }} />
              <canvas ref={selection} aria-hidden style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: .45, pointerEvents: "none", display: showOriginal ? "none" : "block" }} />
              {showOriginal && originalUrl ? <img src={originalUrl} alt="原图对比" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} /> : null}
            </div>
          </div>
        </div>
        <footer style={{ padding: "10px 16px", borderTop: `1px solid ${color.border}` }}>
          {problem ? <div role="alert" style={{ color: color.danger, marginBottom: 8 }}>{problem}</div> : null}
          {busy ? <div role="status" aria-live="polite" style={{ marginBottom: 8 }}>{busy}关闭窗口后，已提交的修复仍会在本机完成并加入素材库。</div> : null}
          <div style={{ ...row, justifyContent: "space-between" }}>
            <span style={{ color: color.textMuted, flex: "1 1 280px" }}>另存为新素材，原图保留。去字在本机运行，首次下载约 208MB 模型；补全纹理由模型推测。</span>
            <button style={button} disabled={!hasSelection || Boolean(busy)} onClick={() => { push({ kind: "clear" }); replay(); }}>清空选区</button>
            <button style={button} disabled={!hasSelection || Boolean(busy) || !loaded} onClick={() => void repair()}>修复选区</button>
            <button style={{ ...button, color: "white", background: color.accent }} disabled={!loaded || !position.current || Boolean(busy) || hasSelection} onClick={() => void save()}>另存素材</button>
          </div>
        </footer>
      </div>
    </div>
  </Modal>;
}
