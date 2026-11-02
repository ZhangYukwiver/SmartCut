import { Input, UrlSource, ALL_FORMATS, CanvasSink } from 'mediabunny';

async function playbackColorSpace(url, signal) {
  const video = document.createElement('video'); video.muted = true; video.preload = 'auto'; video.crossOrigin = 'anonymous';
  try {
    await new Promise((resolve, reject) => {
      const done = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); video.onloadeddata = video.onerror = null; error ? reject(error) : resolve(); };
      const abort = () => done(signal.reason ?? new DOMException('Stopped', 'AbortError'));
      const timer = setTimeout(() => done(new Error('无法读取原片的播放色彩参数，未继续自动改色。')), 20_000);
      signal?.addEventListener('abort', abort, { once: true });
      video.onloadeddata = () => done(); video.onerror = () => done(new Error('无法读取原片的播放色彩参数。')); video.src = url;
      if (signal?.aborted) abort();
    });
    const frame = new VideoFrame(video);
    try { return frame.colorSpace.toJSON(); } finally { frame.close(); }
  } finally { video.removeAttribute('src'); video.load(); }
}

/** 用容器的呈现时间戳顺序解码；不依赖播放回调，不跳帧，也不按平均帧率猜取帧时间。 */
export async function openReferenceFrames(url, signal) {
  signal?.throwIfAborted();
  if (typeof VideoDecoder === 'undefined') throw new Error('当前环境不能逐帧解码，请使用支持 WebCodecs 的 ReelLab 桌面版。');
  const input = new Input({ formats: ALL_FORMATS, source: new UrlSource(url, { maxCacheSize: 32 * 1024 * 1024, getRetryDelay: () => null }) });
  const close = () => input.dispose();
  signal?.addEventListener('abort', close, { once: true });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw new Error('这条视频的编码无法逐帧解码；未降级成抽样对照，请先转成 H.264 MP4。');
    const config = await track.getDecoderConfig();
    if (['primaries', 'transfer', 'matrix', 'fullRange'].some(k => config.colorSpace?.[k] == null)) {
      // 缺标记时沿用本机视频播放器实际采用的色彩参数，避免库默认 BT.709 把 BT.601 红/绿读偏。
      // 这里只取色彩元数据；后续所有画面仍由容器时间戳逐帧解码。
      const fallback = await playbackColorSpace(url, signal);
      const colorSpace = { ...fallback, ...Object.fromEntries(Object.entries(config.colorSpace ?? {}).filter(([, v]) => v != null)) };
      track.getDecoderConfig = async () => ({ ...config, colorSpace });
    }
    const width = await track.getDisplayWidth(), height = await track.getDisplayHeight(), duration = await track.computeDuration();
    const sink = new CanvasSink(track, { poolSize: 1 });
    return { width, height, duration,
      frames: () => sink.canvases(0, duration),
      at: time => sink.getCanvas(time),
      selected: times => sink.canvasesAtTimestamps(times),
      close() { signal?.removeEventListener('abort', close); close(); },
    };
  } catch (error) {
    signal?.removeEventListener('abort', close); close();
    signal?.throwIfAborted();
    throw error;
  }
}
