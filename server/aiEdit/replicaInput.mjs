import { openReferenceFrames } from './referenceFrames.mjs';
import { MAX_REVIEW_FRAMES } from './replicaTiming.mjs';

/** 先遍历真实源帧，再从整段和变化窗口取图；不把 seek 的目标时间冒充帧时间。 */
export async function replicaInput(url, signal) {
  const source = await openReferenceFrames(url, signal);
  const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
  const thumb = canvas(64, 36), tc = thumb.getContext('2d', { willReadFrequently: true });
  const samples = []; let previous;
  try {
    for await (const frame of source.frames()) {
      signal?.throwIfAborted();
      if (samples.length >= MAX_REVIEW_FRAMES) throw new Error('参考视频帧数超过当前逐帧处理上限');
      tc.drawImage(frame.canvas, 0, 0, 64, 36);
      const pixels = tc.getImageData(0, 0, 64, 36).data;
      let change = 0, x0 = 64, y0 = 36, x1 = 0, y1 = 0;
      if (previous) for (let i = 0; i < pixels.length; i += 4) {
        const delta = (Math.abs(pixels[i] - previous[i]) + Math.abs(pixels[i + 1] - previous[i + 1]) + Math.abs(pixels[i + 2] - previous[i + 2])) / 3;
        change += delta;
        if (delta > 24) { const x = (i / 4) % 64, y = Math.floor(i / 4 / 64); x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + 1); y1 = Math.max(y1, y + 1); }
      }
      samples.push({ frame: samples.length, t: frame.timestamp, duration: frame.duration, change: change / (64 * 36 * 255),
        crop: x1 > x0 && y1 > y0 ? [Math.max(0, x0 - 2) / 64, Math.max(0, y0 - 2) / 36, Math.min(64, x1 + 2) / 64, Math.min(36, y1 + 2) / 36] : null });
      previous = pixels;
    }
    if (!samples.length) throw new Error('没有解码到参考画面');
    const limit = Math.min(144, samples.length), uniform = Math.min(limit, 96);
    const chosen = new Set(Array.from({ length: uniform }, (_, i) => Math.round(i * (samples.length - 1) / Math.max(1, uniform - 1))));
    const ranked = [...samples].sort((a, b) => b.change - a.change);
    for (const s of ranked) for (const offset of [-1, 0, 1, 2]) if (chosen.size < limit && s.frame + offset >= 0 && s.frame + offset < samples.length) chosen.add(s.frame + offset);
    const indices = [...chosen].sort((a, b) => a - b), sheets = [];
    const w = 480, h = Math.max(16, Math.round(w * source.height / source.width));
    const sheet = canvas(w * 2, (h + 24) * 2), sc = sheet.getContext('2d');
    let n = 0, times = [];
    for await (const frame of source.selected(indices.map(i => samples[i].t + Math.min(.00001, samples[i].duration / 4)))) {
      signal?.throwIfAborted(); if (!frame) throw new Error('未能读取选定的源帧');
      if (n >= indices.length || Math.abs(frame.timestamp - samples[indices[n]].t) > .000001) throw new Error('选定源帧的时间戳与完整解码结果不一致');
      if (n % 4 === 0) { sc.fillStyle = '#161616'; sc.fillRect(0, 0, sheet.width, sheet.height); times = []; }
      const x = n % 2 * w, y = Math.floor(n % 4 / 2) * (h + 24);
      sc.drawImage(frame.canvas, x, y + 24, w, h); sc.fillStyle = '#fff'; sc.font = '16px monospace';
      sc.fillText(`#${indices[n]} ${frame.timestamp.toFixed(6)} s`, x + 8, y + 18); times.push(frame.timestamp); n++;
      if (n % 4 === 0 || n === indices.length) sheets.push({ times: [...times], image: sheet.toDataURL('image/jpeg', .85) });
    }
    if (n !== indices.length) throw new Error('未能完整读取所选连续帧');
    const details = ranked.filter(s => s.crop && (s.crop[2] - s.crop[0]) * (s.crop[3] - s.crop[1]) < .5 && s.change > .003)
      .filter((s, i, a) => !a.slice(0, i).some(p => Math.abs(p.t - s.t) < .4)).slice(0, 4);
    for (const s of details) {
      const f = await source.at(s.t + Math.min(.00001, s.duration / 4));
      if (!f || Math.abs(f.timestamp - s.t) > .000001) throw new Error('局部放大的源帧时间戳不一致');
      const c = canvas(640, 384), cc = c.getContext('2d'), [x0, y0, x1, y1] = s.crop;
      cc.drawImage(f.canvas, x0 * source.width, y0 * source.height, (x1 - x0) * source.width, (y1 - y0) * source.height, 0, 0, 640, 384);
      sheets.push({ times: [s.t], detail: `局部放大，原图归一化范围 ${JSON.stringify(s.crop)}；不要把局部边界当作整幅画面`, image: c.toDataURL('image/jpeg', .9) });
    }
    return { duration: source.duration, width: source.width, height: source.height, frameCount: samples.length,
      sheets, sampleStep: source.duration / Math.max(1, indices.length), samples: samples.map(({ frame, t, duration, change }) => ({ frame, t, duration, change })) };
  } finally { source.close(); }
}
