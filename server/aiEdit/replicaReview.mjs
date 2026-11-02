import { createDrawingRenderer, drawingTransform } from './drawing.mjs';
import { openReferenceFrames } from './referenceFrames.mjs';
import { MAX_REVIEW_FRAMES, temporalWindows } from './replicaTiming.mjs';
import { measureMaskRegions } from './replicaRegions.mjs';

/** 每一张实际解码出的源帧都参与比较；模型看重点连续窗口，评分不抽帧。 */
export async function reviewReplica({ video, url = video?.currentSrc || video?.src, layers, crops = [], signal, canvas: outputCanvas, origin = 0 }) {
  const reference = await openReferenceFrames(url, signal), media = new Map();
  try {
    const { duration, width: sourceWidth, height: sourceHeight } = reference;
    const scale = Math.min(1, 480 / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(16, Math.round(sourceWidth * scale)), height = Math.max(16, Math.round(sourceHeight * scale));
    const canvas = (w = width, h = height) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; };
    const rw = outputCanvas?.width ?? sourceWidth, rh = outputCanvas?.height ?? sourceHeight, fps = outputCanvas?.fps ?? 30;
    const target = canvas(), draft = canvas(), layerCanvas = canvas(rw, rh), composite = canvas(rw, rh);
    const tc = target.getContext('2d', { willReadFrequently: true }), dc = draft.getContext('2d', { willReadFrequently: true });
    const rc = composite.getContext('2d'), draw = createDrawingRenderer(layerCanvas), sources = new Map();
    for (const layer of layers) if (layer.media && !media.has(layer.media.url)) {
      if (layer.media.kind === 'video') media.set(layer.media.url, await openReferenceFrames(layer.media.url, signal));
      else {
        const element = await new Promise((resolve, reject) => {
          const img = new Image();
          const finish = error => { clearTimeout(timer); signal?.removeEventListener('abort', abort); if (error) { img.src = ''; reject(error); } else resolve(img); };
          const abort = () => finish(signal.reason ?? new DOMException('Stopped', 'AbortError'));
          const timer = setTimeout(() => finish(new Error('校准图层素材加载超时')), 20_000);
          signal?.addEventListener('abort', abort, { once: true });
          img.crossOrigin = 'anonymous'; img.onerror = () => finish(new Error('校准时无法读取图层素材')); img.onload = () => finish(); img.src = layer.media.url;
          if (signal?.aborted) abort();
        });
        media.set(layer.media.url, element);
      }
    }
    for (const [index, crop] of crops.entries()) {
      signal?.throwIfAborted();
      const frame = await reference.at(crop.time);
      if (!frame) throw new Error('参考截取帧不存在');
      const [x, y, w, h] = crop.crop, sw = w * sourceWidth, sh = h * sourceHeight;
      const scale = Math.min(1, 960 / Math.max(sw, sh));
      const c = canvas(Math.max(1, Math.round(sw * scale)), Math.max(1, Math.round(sh * scale)));
      c.getContext('2d').drawImage(frame.canvas, x * sourceWidth, y * sourceHeight, sw, sh, 0, 0, c.width, c.height);
      sources.set(index, c);
    }
    const render = async t => {
      // 对照实际导出帧在这个时间点的画面，不能用导出时根本不会出现的中间状态拿高分。
      const renderedAt = Math.floor((t + origin) * fps + .00001) / fps - origin;
      rc.setTransform(1, 0, 0, 1, 0, 0); rc.fillStyle = '#000'; rc.fillRect(0, 0, rw, rh);
      for (const layer of layers) {
        const local = renderedAt - layer.start;
        if (local < -1e-5 || local >= layer.duration - 1e-7) continue;
        let source = layer.extraction === undefined ? null : sources.get(layer.extraction);
        if (layer.media) {
          const item = media.get(layer.media.url);
          source = layer.media.kind === 'video' ? (await item.at(Math.min(item.duration - .000001, layer.media.start + Math.max(0, local) * layer.media.speed)))?.canvas : item;
        }
        if (layer.drawing.content === 'media' && !source) throw new Error('复刻对照缺少图层素材');
        draw(layer.drawing, Math.max(0, local), source, layer.media?.fit ?? layer.fit ?? (layer.extraction === undefined ? undefined : 'stretch'));
        const transform = drawingTransform({ transform: layer.transform, keyframes: (layer.keyframes ?? []).map(k => ({ ...k, offset_us: k.offset * 1e6 })) }, Math.max(0, local) * 1e6);
        rc.save(); rc.globalAlpha = transform.alpha;
        rc.translate(rw / 2 + transform.transform_x * rw / 2, rh / 2 - transform.transform_y * rh / 2);
        rc.rotate(transform.rotation * Math.PI / 180); rc.scale(transform.scale_x, transform.scale_y);
        rc.filter = `brightness(${Math.max(0, 1 + (transform.brightness ?? 0))}) contrast(${Math.max(0, 1 + (transform.contrast ?? 0))}) saturate(${Math.max(0, 1 + (transform.saturation ?? 0))})`;
        rc.drawImage(layerCanvas, -rw / 2, -rh / 2); rc.restore();
      }
      dc.drawImage(composite, 0, 0, width, height);
      return renderedAt;
    };
    const fullRow = (source, t, index) => {
      const row = canvas(width * 2, height + 28), c = row.getContext('2d');
      c.fillStyle = '#161616'; c.fillRect(0, 0, row.width, row.height);
      c.drawImage(source, 0, 28, width, height); c.drawImage(draft, width, 28); c.fillStyle = '#fff'; c.font = '14px monospace';
      c.fillText(`#${index} ${t.toFixed(6)}s REFERENCE`, 6, 20); c.fillText(`#${index} ${t.toFixed(6)}s RENDER`, width + 6, 20);
      return row;
    };
    const detailRow = (source, region, t, label) => {
      const row = canvas(960, 268), c = row.getContext('2d'), [x, y, w, h] = region;
      c.fillStyle = '#161616'; c.fillRect(0, 0, row.width, row.height);
      const fh = Math.min(240, 480 * h * sourceHeight / (w * sourceWidth)), fw = fh * w * sourceWidth / (h * sourceHeight);
      c.drawImage(source, x * sourceWidth, y * sourceHeight, w * sourceWidth, h * sourceHeight, (480 - fw) / 2, 28, fw, fh);
      c.drawImage(composite, x * rw, y * rh, w * rw, h * rh, 480 + (480 - fw) / 2, 28, fw, fh);
      c.fillStyle = '#fff'; c.font = '14px monospace'; c.fillText(`${t.toFixed(6)}s REFERENCE ${label}`, 8, 20); c.fillText(`${t.toFixed(6)}s RENDER ${label}`, 488, 20);
      return row;
    };
    const samples = [], measurements = [], worst = new Map(), details = new Map();
    const textRegions = layers.filter(l => ['text', 'signature'].includes(l.drawing.type) && l.drawing.showText && l.drawing.text.length > 2).slice(0, 4);
    let previousA, previousB, previousMeasurements = [];
    for await (const frame of reference.frames()) {
      signal?.throwIfAborted();
      const i = samples.length, t = frame.timestamp;
      if (i >= MAX_REVIEW_FRAMES) throw new Error(`视频超过 ${MAX_REVIEW_FRAMES} 帧的逐帧校准上限，请缩短参考片段。工程未改，未降级抽帧。`);
      if (!Number.isFinite(t) || (i && t <= samples[i - 1].t)) throw new Error('源帧时间戳未严格递增，无法保证逐帧对照。');
      tc.drawImage(frame.canvas, 0, 0, width, height);
      const renderedAt = await render(t), a = tc.getImageData(0, 0, width, height).data, b = dc.getImageData(0, 0, width, height).data;
      const difference = (p, motion) => motion ? Math.abs((a[p] - previousA[p]) - (b[p] - previousB[p])) : Math.abs(a[p] - b[p]);
      let error = 0;
      for (let p = 0; p < a.length; p += 16) error += difference(p, false) + difference(p + 1, false) + difference(p + 2, false);
      const regionError = (region, motion = false) => {
        if (motion && !previousA) return 0;
        const [x, y, w, h] = region; let sum = 0, n = 0;
        for (let py = Math.floor(y * height); py < Math.min(height, (y + h) * height); py += 2) for (let px = Math.floor(x * width); px < Math.min(width, (x + w) * width); px += 2) {
          const p = (py * width + px) * 4; sum += difference(p, motion) + difference(p + 1, motion) + difference(p + 2, motion); n++;
        }
        return sum / Math.max(1, n * 3 * (motion ? 510 : 255));
      };
      const tiles = Array.from({ length: 12 }, (_, j) => {
        const region = [j % 4 / 4, Math.floor(j / 4) / 3, .25, 1 / 3];
        return { region, error: regionError(region), motion: regionError(region, true) };
      }).sort((x, y) => y.error - x.error);
      const sample = { frame: i, t, duration: frame.duration, renderedAt, error: error / (Math.ceil(a.length / 16) * 3 * 255),
        localError: tiles.slice(0, 3).reduce((sum, item) => sum + item.error, 0) / 3,
        temporalError: [...tiles].sort((a, b) => b.motion - a.motion).slice(0, 3).reduce((sum, item) => sum + item.motion, 0) / 3 };
      samples.push(sample);
      previousMeasurements = measureMaskRegions(layers, a, width, height, t, i, previousMeasurements);
      measurements.push(...previousMeasurements);
      const detailKey = `region-${Math.min(3, Math.floor(t / duration * 4))}`, tile = tiles[0];
      if (!details.has(detailKey) || details.get(detailKey).error < tile.error) details.set(detailKey, { t, error: tile.error, row: detailRow(frame.canvas, tile.region, t, `frame ${i}`) });
      for (const [j, layer] of textRegions.entries()) if (t >= layer.start && t < layer.start + layer.duration) {
        const center = layer.drawing.type === 'signature' ? [.5, .94] : layer.drawing.center ?? [.5, .5];
        const region = [Math.max(0, Math.min(.6, center[0] - .2)), Math.max(0, Math.min(.82, center[1] - .09)), .4, .18];
        const error = regionError(region), key = `text-${j}`;
        if (!details.has(key) || details.get(key).error < error) details.set(key, { t, error, row: detailRow(frame.canvas, region, t, 'text detail') });
      }
      const bucket = Math.min(15, Math.floor(t / duration * 16));
      if (!worst.has(bucket) || worst.get(bucket).error < sample.localError) worst.set(bucket, { t, error: sample.localError, row: fullRow(frame.canvas, t, i) });
      previousA = a; previousB = b;
      if (i % 12 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (!samples.length) throw new Error('视频没有解码出可对照的画面。');
    let minimumDuration = Infinity;
    samples.forEach((s, i) => {
      s.duration = i + 1 < samples.length ? samples[i + 1].t - s.t : duration - s.t;
      if (!(s.duration > 0)) throw new Error('源帧持续时间无效，无法保证逐帧对照。');
      minimumDuration = Math.min(minimumDuration, s.duration);
    });
    const windows = temporalWindows(samples), wanted = [...new Set(windows.flatMap(w => Array.from({ length: w.end - w.start + 1 }, (_, i) => w.start + i)))].sort((a, b) => a - b);
    // 数值拟合要覆盖整个步骤，不能只修窗口里的几帧而把同一步的头尾颜色改坏。
    const wantedSet = new Set(wanted), groups = new Set(measurements.filter(m => wantedSet.has(m.frame)).map(m => `${m.layer}:${m.step}`));
    const regionMeasurements = measurements.filter(m => groups.has(`${m.layer}:${m.step}`)).slice(0, 100);
    const sequenceRows = new Map(); let cursor = 0;
    for await (const frame of reference.selected(wanted.map(i => samples[i].t + Math.min(.00001, samples[i].duration / 4)))) {
      signal?.throwIfAborted();
      const index = wanted[cursor++], sample = samples[index];
      if (!frame || Math.abs(frame.timestamp - sample.t) > .000001) throw new Error('连续帧回读与完整对照时间戳不一致。');
      await render(sample.t); sequenceRows.set(index, fullRow(frame.canvas, sample.t, index));
    }
    const sheetsOf = (rows, groupSize) => {
      const sheets = [];
      for (let i = 0; i < rows.length; i += groupSize) {
        const group = rows.slice(i, i + groupSize), h = group[0].row.height, sheet = canvas(group[0].row.width, h * group.length);
        group.forEach((row, index) => sheet.getContext('2d').drawImage(row.row, 0, index * h));
        sheets.push({ times: group.map(s => s.t), image: sheet.toDataURL('image/jpeg', .9) });
      }
      return sheets;
    };
    const temporalSheets = windows.flatMap(w => sheetsOf(Array.from({ length: w.end - w.start + 1 }, (_, j) => ({ t: samples[w.start + j].t, row: sequenceRows.get(w.start + j) })), 5).map((sheet, i) => {
      const frames = Array.from({ length: sheet.times.length }, (_, j) => w.start + i * 5 + j);
      return { ...sheet, frames, peakFrame: Math.max(frames[0], Math.min(frames.at(-1), w.peak)) };
    }));
    const average = key => samples.reduce((sum, s) => sum + s[key], 0) / samples.length;
    return { duration, coverage: 'all-frames', frameCount: samples.length, renderFps: fps, requiredFps: Math.ceil(1 / minimumDuration - .01),
      meanError: average('error'), localError: average('localError'), temporalError: average('temporalError'),
      worstError: Math.max(...samples.map(s => s.error)), samples, sheets: sheetsOf([...worst.values()], 4), detailSheets: sheetsOf([...details.values()], 4), temporalSheets, windows, regionMeasurements };
  } finally {
    reference.close();
    for (const item of media.values()) if (item.close) item.close(); else item.src = '';
  }
}
