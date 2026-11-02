// 关键帧曲线和曲线变速的算法。看板那边（src/components/workspace/aiEditCurves.ts）有同样的一份，curves.test.mjs 对着比。
//
// 关键帧曲线：记在一段的起点关键帧上，curve = [x1, y1, x2, y2]，和 CSS cubic-bezier 一样：横轴是这一段的时间（0–1），
// 纵轴是从这一帧的值走到下一帧的值（0–1，回弹可以超出）。没有 curve 是直线。写剪映草稿时换成 FreeCurveInOut 的两个控制柄。
//
// 曲线变速：curve_speed = { name, points: [{ x, y }] }，和剪映草稿的 speed_points 同一个意思：x 是在素材里的位置（截取范围归一成
// 0–1），y 是那一刻的倍速。剪映的引擎（字节 VE）先把 x 换成成片里的位置（VECurveSpeedUtils.transferTrimPointXtoSeqPointX：
// 每一小段在成片里的长度 = 素材里的长度 ÷ 两头倍速的平均），倍速在成片时间上按直线走。所以成片时长 = 素材时长 × factor。
//
// 剪映 Mac 11.6 实测（2026-10-28）：导进去的子弹时间、自定义曲线在「曲线变速」里认成对应的预设，剪映自己重套子弹时间后
// 时长和这里算的差不到一帧；缓出、缓入缓出的关键帧在剪映里逐帧读出的位置、缩放和 easeAt 一致（剪映会把片段边界对齐到帧上）。

/** 关键帧曲线的预设（看板和 AI 用名字选，存下来的是四个数）。缓出照 CapCut 界面写出的 Cubic Out 控制柄反推。 */
export const KEYFRAME_CURVES = {
  ease_in: { name: "缓入", curve: [0.42, 0, 1, 1] },
  ease_out: { name: "缓出", curve: [0.32, 0.94, 0.6, 1] },
  ease_in_out: { name: "缓入缓出", curve: [0.42, 0, 0.58, 1] },
  back: { name: "回弹", curve: [0.34, 1.56, 0.64, 1] },
};

/** 剪映曲线变速的预设，速度点取自字节编辑器内置的同名资源（custom/montage/highlight/bullet/jump_cut/flash_in/flash_out）。 */
export const SPEED_CURVES = {
  custom: { name: "自定义", points: [[0, 1], [0.25, 1], [0.5, 1], [0.75, 1], [1, 1]] },
  montage: { name: "蒙太奇", points: [[0, 0.9], [0.1, 0.9], [0.5, 6.8], [0.65, 0.3], [0.8, 1], [1, 1]] },
  hero: { name: "英雄时刻", points: [[0, 1], [0.05, 1], [0.35, 5.5], [0.45, 0.5], [0.55, 0.5], [0.65, 5.5], [0.95, 1], [1, 1]] },
  bullet: { name: "子弹时间", points: [[0, 5.2], [0.4, 5.2], [0.46, 0.5], [0.54, 0.5], [0.6, 5.2], [1, 5.2]] },
  jump_cut: { name: "跳接", points: [[0, 0.6], [0.43, 0.6], [0.5, 6], [0.57, 0.6], [1, 0.6]] },
  flash_in: { name: "闪进", points: [[0, 5.2], [0.4, 5.2], [0.6, 1], [1, 1]] },
  flash_out: { name: "闪出", points: [[0, 1], [0.4, 1], [0.6, 5.2], [1, 5.2]] },
};

export const SPEED_POINT_RANGE = [0.1, 10];
export const MAX_SPEED_POINTS = 30;
export const CURVE_Y_RANGE = [-3, 4];

export const speedPreset = (key) => SPEED_CURVES[key].points.map(([x, y]) => ({ x, y }));

const lerp = (a, b, t) => a + (b - a) * t;

/** 贝塞尔在参数 t 的一个坐标（两头是 0 和 1）。 */
const bez = (p1, p2, t) => 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3;

/** 时间走到 u（0–1）时贝塞尔的参数 t：x1、x2 在 0–1 里时 x 单调，二分 40 次够到 1e-12。 */
function paramAt(x1, x2, u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (bez(x1, x2, mid) < u) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** 这一段走到时间 u 时走了多少（0–1，回弹会超出）。curve 没有就是直线。 */
export function easeAt(curve, u) {
  if (!curve) return u;
  const [x1, y1, x2, y2] = curve;
  return bez(y1, y2, paramAt(x1, x2, u));
}

// 图层导出页嵌入同一份缓动实现，保持预览与出片一致。
export const KEYFRAME_CURVE_SOURCE = `const bez=${bez.toString()};${paramAt.toString()};${easeAt.toString()};`;

/**
 * 在时间 u 处把一段曲线切成两段，各自归一回 0–1 的框（de Casteljau）。哪一半前后的值一样就回 null（那一半是平的）。
 * ponytail: 极端的自定义曲线切出来的控制柄横坐标可能出框，夹回 0–1，形状差一点；要精确就得存不归一的控制柄。
 */
export function splitCurve(curve, u) {
  if (!curve) return [null, null];
  const [x1, y1, x2, y2] = curve;
  const t = paramAt(x1, x2, u);
  const p01 = [lerp(0, x1, t), lerp(0, y1, t)];
  const p12 = [lerp(x1, x2, t), lerp(y1, y2, t)];
  const p23 = [lerp(x2, 1, t), lerp(y2, 1, t)];
  const p012 = [lerp(p01[0], p12[0], t), lerp(p01[1], p12[1], t)];
  const p123 = [lerp(p12[0], p23[0], t), lerp(p12[1], p23[1], t)];
  const mid = [lerp(p012[0], p123[0], t), lerp(p012[1], p123[1], t)];
  const box = (points, [ox, oy], [ex, ey]) => {
    const w = ex - ox;
    const h = ey - oy;
    if (Math.abs(w) < 1e-12 || Math.abs(h) < 1e-12) return null;
    return points.flatMap(([x, y]) => [Math.min(1, Math.max(0, (x - ox) / w)), (y - oy) / h]);
  };
  return [box([p01, p012], [0, 0], mid), box([p123, p23], mid, [1, 1])];
}

/** 速度点在成片里的位置（0–1）和成片时长 / 素材时长（factor）。 */
export function seqOf(points) {
  const seq = [0];
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += (points[i].x - points[i - 1].x) / ((points[i].y + points[i - 1].y) / 2);
    seq.push(total);
  }
  return { seq: seq.map((value) => value / total), factor: total };
}

/** 成片走到 u（0–1）时放到素材的哪儿（0–1）：倍速在成片时间上是折线，积出来是分段二次。 */
export function curveSource(points, u) {
  const { seq, factor } = seqOf(points);
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  let i = 1;
  while (i < seq.length - 1 && seq[i] < u) i += 1;
  const a = points[i - 1];
  const b = points[i];
  const span = seq[i] - seq[i - 1];
  const d = u - seq[i - 1];
  return Math.min(1, a.x + factor * (a.y * d + (span > 0 ? ((b.y - a.y) * d * d) / (2 * span) : 0)));
}

/** 成片走到 u 时的倍速。 */
export function curveSpeedAt(points, u) {
  const { seq } = seqOf(points);
  if (u <= 0) return points[0].y;
  if (u >= 1) return points.at(-1).y;
  let i = 1;
  while (i < seq.length - 1 && seq[i] < u) i += 1;
  const span = seq[i] - seq[i - 1];
  return span > 0 ? lerp(points[i - 1].y, points[i].y, (u - seq[i - 1]) / span) : points[i].y;
}

/** 成片里 [u0, u1] 那一截的速度点（x 重新归一）：切口按成片时间插出倍速，形状和原来一模一样。 */
export function sliceSpeedCurve(points, u0, u1) {
  const { seq } = seqOf(points);
  const x0 = curveSource(points, u0);
  const x1 = curveSource(points, u1);
  const inner = points.filter((_, i) => seq[i] > u0 + 1e-9 && seq[i] < u1 - 1e-9).map((point) => ({ x: (point.x - x0) / (x1 - x0), y: point.y }));
  return [{ x: 0, y: curveSpeedAt(points, u0) }, ...inner, { x: 1, y: curveSpeedAt(points, u1) }];
}
