import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createDrawingRenderer } from "../../../server/aiEdit/drawing.mjs";
import type { EditCanvas, EditMediaSegment } from "../../services/aiEdit";

/** 素材只是图层内容；轮廓、蒙版和动画数据始终保留在片段上。 */
export function DrawingLayer({ segment, canvas, url, offset, playing, active, style }: {
  segment: EditMediaSegment; canvas: EditCanvas; url: string | null; offset: number; playing: boolean; active: boolean; style: React.CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const render = useRef<ReturnType<typeof createDrawingRenderer> | null>(null);
  const source = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const latest = useRef({ segment, offset, active, playing });
  latest.current = { segment, offset, active, playing };
  const [problem, setProblem] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(0);
  const draw = () => {
    const state = latest.current;
    if (!state.segment.drawing || !state.active) return;
    render.current?.(state.segment.drawing, state.offset / 1e6, source.current, state.segment.fit);
  };
  useLayoutEffect(() => {
    if (ref.current) render.current = createDrawingRenderer(ref.current);
    draw();
  }, [canvas.width, canvas.height]);
  useEffect(() => {
    setProblem(null); source.current = null;
    if (!url || segment.drawing?.content !== 'media') { draw(); return; }
    const element = document.createElement(segment.kind === 'video' ? 'video' : 'img');
    element.crossOrigin = 'anonymous';
    if (element instanceof HTMLVideoElement) { element.muted = true; element.preload = 'auto'; }
    const loaded = () => { source.current = element; setLoaded(n => n + 1); draw(); };
    const failed = () => setProblem('素材加载失败，请重新替换');
    const seeked = () => {
      const state = latest.current;
      if (element instanceof HTMLVideoElement && !state.playing && state.active) {
        const wanted = Math.max(0, Math.min(element.duration - .001, (state.segment.source.start_us + state.offset * state.segment.speed) / 1e6));
        if (Math.abs(element.currentTime - wanted) > .012) { element.currentTime = wanted; return; }
      }
      draw();
    };
    element.addEventListener(element instanceof HTMLVideoElement ? 'loadeddata' : 'load', loaded);
    element.addEventListener('seeked', seeked);
    element.addEventListener('error', failed);
    element.src = url;
    return () => {
      source.current = null;
      element.removeEventListener(element instanceof HTMLVideoElement ? 'loadeddata' : 'load', loaded);
      element.removeEventListener('seeked', seeked); element.removeEventListener('error', failed);
      if (element instanceof HTMLVideoElement) { element.pause(); element.removeAttribute('src'); element.load(); }
    };
  }, [url, segment.kind, segment.drawing?.content]);
  useLayoutEffect(() => {
    const element = source.current;
    if (element instanceof HTMLVideoElement && element.readyState >= 2) {
      const wanted = Math.max(0, Math.min(element.duration - .001, (segment.source.start_us + offset * segment.speed) / 1e6));
      if (Math.abs(element.currentTime - wanted) > (playing ? .12 : .012) && !element.seeking) element.currentTime = wanted;
      element.playbackRate = Math.max(.0625, Math.min(16, segment.speed));
      if (playing && active) void element.play().catch(() => undefined); else element.pause();
    }
    draw();
  }, [segment, offset, playing, active, url, loaded]);
  return <div data-layer-id={segment.id} data-layer-kind="drawing" style={{ ...style, objectFit: undefined }}>
    <canvas ref={ref} width={canvas.width} height={canvas.height} style={{ width: '100%', height: '100%', display: 'block' }} />
    {problem && active ? <span role="alert" style={{ position: 'absolute', top: 8, left: 8, color: '#fff', background: '#721b24', padding: 6 }}>{problem}</span> : null}
  </div>;
}
