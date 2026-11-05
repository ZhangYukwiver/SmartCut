// 成片的母带处理：给旁白让位（侧链压缩）、响度归一化（BS.1770 积分响度）、真峰值限幅。应用不带 ffmpeg，全在 JS 里做。
// 这些函数原样塞进编码页里跑（encoder.mjs 用 toString 拼进去），所以只能互相调用、不能引用模块里别的东西；
// 声道是 Float32Array 的数组，采样率固定 48000（编码页就按这个混音）。

/** 成片真峰值的上限（dBTP）：限幅压到 -2，AAC 编码再冒出来一点也在 -1.5 以下。 */
export const TRUE_PEAK_DB = -2;
export const LOUDNESS_TARGETS = [-14, -15, -16];

/**
 * K 加权后 400ms 块（重叠 75%，每 100ms 一块）的均方值；不够一块回空数组。
 * ponytail: K 加权的系数是 48 kHz 的（BS.1770 表 1、2），别的采样率要按双线性变换重算
 */
export function loudnessBlocks(channels) {
  const step = 4800;
  const parts = Math.floor(channels[0].length / step);
  if (parts < 4) return [];
  const power = new Float64Array(parts);
  for (const data of channels) {
    // 第一级高架 + 第二级高通，直接型 I
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, v1 = 0, v2 = 0;
    for (let i = 0; i < parts * step; i += 1) {
      const x = data[i];
      const y = 1.53512485958697 * x - 2.69169618940638 * x1 + 1.19839281085285 * x2 + 1.69065929318241 * y1 - 0.73248077421585 * y2;
      const v = y - 2 * y1 + y2 + 1.99004745483398 * v1 - 0.99007225036621 * v2;
      x2 = x1; x1 = x; y2 = y1; y1 = y; v2 = v1; v1 = v;
      power[(i / step) | 0] += v * v;
    }
  }
  const blocks = [];
  for (let j = 0; j + 4 <= parts; j += 1) blocks.push((power[j] + power[j + 1] + power[j + 2] + power[j + 3]) / (4 * step));
  return blocks;
}

/** 按 -70 LUFS 绝对门限和 -10 LU 相对门限算积分响度（LUFS）。太短或全是静音回 -Infinity。 */
export function gatedLoudness(blocks) {
  const lufs = (z) => -0.691 + 10 * Math.log10(z);
  const mean = (list) => list.reduce((sum, z) => sum + z, 0) / list.length;
  const loud = blocks.filter((z) => z > 0 && lufs(z) > -70);
  if (!loud.length) return -Infinity;
  const relative = lufs(mean(loud)) - 10;
  return lufs(mean(loud.filter((z) => lufs(z) > relative)));
}

export function integratedLoudness(channels) {
  return gatedLoudness(loudnessBlocks(channels));
}

/**
 * 每个采样点到下一个点之间的真峰值（各声道取最大的绝对值）：4 倍过采样，插值用 16 抽头 Hann 窗 sinc。
 * 回 Float32Array（和声道一样长）。
 */
export function peakTrack(channels) {
  const n = channels[0].length;
  // 0.25、0.5、0.75 三个插值点各 16 个抽头（取 i-7 到 i+8），每组归一到直流增益 1
  const taps = new Float64Array(48);
  for (let p = 0; p < 3; p += 1) {
    let sum = 0;
    for (let k = 0; k < 16; k += 1) {
      const t = (p + 1) / 4 - (k - 7);
      taps[p * 16 + k] = (Math.sin(Math.PI * t) / (Math.PI * t)) * 0.5 * (1 + Math.cos((Math.PI * t) / 8));
      sum += taps[p * 16 + k];
    }
    for (let k = 0; k < 16; k += 1) taps[p * 16 + k] /= sum;
  }
  const peaks = new Float32Array(n);
  for (const data of channels) {
    for (let i = 0; i < n; i += 1) {
      let peak = Math.abs(data[i]);
      // 几乎没声的地方不用插值
      if (peak > 1e-4 || (i + 1 < n && Math.abs(data[i + 1]) > 1e-4)) {
        for (let p = 0; p < 48; p += 16) {
          let sum = 0;
          for (let k = 0; k < 16; k += 1) {
            const at = i + k - 7;
            if (at >= 0 && at < n) sum += data[at] * taps[p + k];
          }
          if (Math.abs(sum) > peak) peak = Math.abs(sum);
        }
      }
      if (peak > peaks[i]) peaks[i] = peak;
    }
  }
  return peaks;
}

export function truePeak(channels) {
  const peaks = peakTrack(channels);
  let max = 0;
  for (let i = 0; i < peaks.length; i += 1) if (peaks[i] > max) max = peaks[i];
  return max;
}

/**
 * 真峰值限幅（原地改）：要压的地方提前 5ms 开始压（离线处理，往后看多远都行），松开用 100ms。
 * 增益先按每点要的取前看窗口里的最小值，再在同一宽度上平均：平均里每一项都管得住这一点，所以压得够、又没有跳变。
 */
export function limitPeaks(channels, ceiling, rate = 48000) {
  const n = channels[0].length;
  const peaks = peakTrack(channels);
  const want = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i += 1) {
    want[i] = peaks[i] > ceiling ? ceiling / peaks[i] : 1;
    if (want[i] < 1) any = true;
  }
  if (!any) return;
  const look = Math.max(1, Math.round(rate * 0.005));
  // 往后 look 个点里的最小值（单调队列）
  const least = new Float32Array(n);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i -= 1) {
    while (tail > head && want[queue[tail - 1]] >= want[i]) tail -= 1;
    queue[tail++] = i;
    while (queue[head] > i + look - 1) head += 1;
    least[i] = want[queue[head]];
  }
  const release = 1 - Math.exp(-1 / (rate * 0.1));
  // 开头之前的窗口按 least[0] 算（它不大于那些窗口真正的最小值，压得只多不少）
  let windowSum = look * least[0];
  let gain = 1;
  for (let i = 0; i < n; i += 1) {
    windowSum += least[i] - (i >= look ? least[i - look] : least[0]);
    const smooth = Math.min(1, windowSum / look);
    gain = smooth < gain ? smooth : gain + (smooth - gain) * release;
    for (const data of channels) data[i] *= gain;
  }
}

/**
 * 给旁白让位（原地改 music）：照 ffmpeg 的 sidechaincompress（rms 检测、两声道平均）算，侧链是旁白 × level。
 * 默认参数是手工后期用过的：threshold=0.03 ratio=3 attack=60ms release=500ms，旁白先放大 2.5 倍再去检测。
 * ponytail: 硬拐点（ffmpeg 默认有 2.83 倍的软拐点），差别只在刚过门限那几 dB
 */
export function duckUnder(music, voice, { rate = 48000, threshold = 0.03, ratio = 3, attack = 0.06, release = 0.5, level = 2.5 } = {}) {
  const n = music[0].length;
  const attackCoef = Math.min(1, 4 / (attack * rate));
  const releaseCoef = Math.min(1, 4 / (release * rate));
  const floor = threshold * threshold;
  const thres = Math.log(threshold);
  let slope = 0;
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (const data of voice) sum += Math.abs(data[i] ?? 0);
    const sample = (sum / voice.length) * level;
    const squared = sample * sample;
    slope += (squared - slope) * (squared > slope ? attackCoef : releaseCoef);
    if (slope <= floor) continue;
    const at = 0.5 * Math.log(slope);
    const gain = Math.exp((at - thres) / ratio + thres - at);
    for (const data of music) data[i] *= gain;
  }
}

/**
 * 响度归一化到 target（LUFS），真峰值压在 ceilingDb（dBTP）以下（原地改）。限幅会把响度压低一点，所以量了再补，最多三遍。
 * 回 { before, after, peak }（after、peak 是处理完的积分响度和真峰值 dBTP）；静音的不动。
 */
export function normalizeLoudness(channels, target, ceilingDb = -2) {
  const before = integratedLoudness(channels);
  if (!Number.isFinite(before)) return { before, after: before, peak: -Infinity };
  const ceiling = 10 ** (ceilingDb / 20);
  let now = before;
  // 第一遍总要做（响度正好也得限幅）
  for (let round = 0; round < 3 && (round === 0 || Math.abs(target - now) > 0.2); round += 1) {
    const gain = 10 ** ((target - now) / 20);
    for (const data of channels) for (let i = 0; i < data.length; i += 1) data[i] *= gain;
    limitPeaks(channels, ceiling);
    // 平均出来的增益在插值的边上还可能冒一点：整体再压到上限以下
    const over = truePeak(channels);
    if (over > ceiling) for (const data of channels) for (let i = 0; i < data.length; i += 1) data[i] *= ceiling / over;
    now = integratedLoudness(channels);
  }
  return { before, after: now, peak: 20 * Math.log10(truePeak(channels)) };
}

/**
 * 成片声音的指标：积分响度、真峰值（dBTP）、0.5 秒内瞬时响度（400ms 块）最大上跳、静音段（低于 -50 dBFS 至少 0.1 秒）。
 * 上跳里比积分响度低 20 LU 以下的都按 -20 算（和 LRA 的门限一样），不然开头和静音后面一响就是几十 LU，真正的突变反而看不见。
 * at 是开始变响的时刻。全是静音时 loudness、peak 回 -Infinity、jump 回 null。
 */
export function audioReport(channels, rate = 48000) {
  const blocks = loudnessBlocks(channels);
  const loudness = gatedLoudness(blocks);
  let jump = null;
  if (Number.isFinite(loudness)) {
    const floor = loudness - 20;
    const level = blocks.map((z) => (z > 0 ? Math.max(floor, -0.691 + 10 * Math.log10(z)) : floor));
    jump = { lu: 0, at: 0, from: floor, to: floor };
    for (let i = 1; i < level.length; i += 1) {
      for (let j = Math.max(0, i - 5); j < i; j += 1) {
        if (level[i] - level[j] > jump.lu) jump = { lu: level[i] - level[j], at: (j + 4) / 10, from: level[j], to: level[i] };
      }
    }
  }
  const step = rate / 100, limit = 10 ** (-50 / 20), n = channels[0].length;
  const silences = [];
  let from = null;
  for (let at = 0; at < n + step; at += step) {
    let quiet = at < n;
    for (const data of channels) for (let i = at; quiet && i < Math.min(n, at + step); i += 1) if (Math.abs(data[i]) >= limit) quiet = false;
    if (quiet) from ??= at;
    else if (from !== null) {
      if (at - from >= rate / 10) silences.push({ start: from / rate, end: Math.min(at, n) / rate });
      from = null;
    }
  }
  return { seconds: n / rate, loudness, peak: 20 * Math.log10(truePeak(channels)), jump, silences };
}

/** 编码页里用的源码：上面这几个函数原样拼进去。 */
export const MASTER_SOURCE = [loudnessBlocks, gatedLoudness, integratedLoudness, peakTrack, truePeak, limitPeaks, duckUnder, normalizeLoudness, audioReport].map(String).join("\n");
