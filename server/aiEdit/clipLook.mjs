import { easeAt, KEYFRAME_CURVE_SOURCE } from './curves.mjs';

// 视频 / 图片片段某一刻怎么画：关键帧插值、摆放、蒙版、滤镜近似。看板预览（AiEditStage）和出片时片段的小网页（film/filmFile.mjs 的
// clipPage）用的是同一份：整个工厂原样嵌进网页，所以里面不引用外面的东西，缓动从参数进来。
// 坐标约定同剪映 / pyJianYingDraft：transform_x/y 以半个画布宽/高为单位，y 向上为正；rotation 顺时针为正。
function createClipLook(easeAt) {
  const round = (value, digits) => { const factor = 10 ** digits; return Math.round(value * factor) / factor; };

  /** 某属性在片段内偏移 offsetUs 处的关键帧值：两帧之间按前一帧的曲线走（没有曲线是直线），两头之外取最近一帧；没有这个属性的关键帧时为 null。 */
  function keyframeValue(keyframes, property, offsetUs) {
    const points = (keyframes ?? []).filter((item) => item.property === property).sort((a, b) => a.offset_us - b.offset_us);
    if (!points.length) return null;
    if (offsetUs <= points[0].offset_us) return points[0].value;
    for (let index = 1; index < points.length; index += 1) {
      const right = points[index];
      if (offsetUs <= right.offset_us) {
        const left = points[index - 1];
        const span = right.offset_us - left.offset_us;
        return span <= 0 ? right.value : left.value + (right.value - left.value) * easeAt(left.curve, (offsetUs - left.offset_us) / span);
      }
    }
    return points[points.length - 1].value;
  }

  const IDENTITY_TRANSFORM = { scale_x: 1, scale_y: 1, transform_x: 0, transform_y: 0, rotation: 0, alpha: 1, flip_horizontal: false, flip_vertical: false };

  /** 片段在 offsetUs 处实际生效的变换：静态 transform 叠上关键帧（关键帧值是绝对值，覆盖静态值）。 */
  function effectiveTransform(segment, offsetUs) {
    const base = { ...IDENTITY_TRANSFORM, ...(segment.transform ?? {}) };
    const key = (property) => keyframeValue(segment.keyframes, property, offsetUs);
    const uniform = key('uniform_scale');
    return {
      ...base,
      transform_x: key('transform_x') ?? base.transform_x,
      transform_y: key('transform_y') ?? base.transform_y,
      scale_x: uniform ?? key('scale_x') ?? base.scale_x,
      scale_y: uniform ?? key('scale_y') ?? base.scale_y,
      rotation: key('rotation') ?? base.rotation,
      alpha: key('alpha') ?? base.alpha,
    };
  }

  /** 亮度 / 对比度 / 饱和度关键帧（-1..1）换成 CSS filter；都没有时为空串。 */
  function colorFilter(keyframes, offsetUs) {
    const parts = [];
    const add = (property, css) => {
      const value = keyframeValue(keyframes, property, offsetUs);
      if (value !== null && value !== 0) parts.push(`${css}(${round(Math.max(0, 1 + value), 3)})`);
    };
    add('brightness', 'brightness');
    add('contrast', 'contrast');
    add('saturation', 'saturate');
    return parts.join(' ');
  }

  /** 淡入淡出（剪映里是音量淡入淡出）在片段内 offsetUs 处的增益 0–1。 */
  function fadeGain(segment, offsetUs) {
    const fade = segment.fade;
    if (!fade) return 1;
    let gain = 1;
    if (fade.in_duration_us > 0 && offsetUs < fade.in_duration_us) gain = Math.min(gain, Math.max(0, offsetUs / fade.in_duration_us));
    const left = segment.timeline.duration_us - offsetUs;
    if (fade.out_duration_us > 0 && left < fade.out_duration_us) gain = Math.min(gain, Math.max(0, left / fade.out_duration_us));
    return gain;
  }

  /** 片段此刻的音量：片段音量（或音量关键帧）× 淡入淡出，不封顶（浏览器的 1 封顶由预览自己做）。 */
  const volumeAt = (segment, offsetUs) => (keyframeValue(segment.keyframes, 'volume', offsetUs) ?? segment.volume ?? 1) * fadeGain(segment, offsetUs);

  /**
   * 素材按 fit 铺进画布后的大小（画布像素或舞台像素都行，同一单位进同一单位出）。
   * contain 等比放进、cover 等比铺满、stretch 拉满；素材尺寸未知时当作和画布同比例。
   */
  function fitBox(stage, media, fit = 'contain') {
    const width = media?.width > 0 ? media.width : stage.width;
    const height = media?.height > 0 ? media.height : stage.height;
    if (fit === 'stretch') return { width: stage.width, height: stage.height };
    const scale = fit === 'cover' ? Math.max(stage.width / width, stage.height / height) : Math.min(stage.width / width, stage.height / height);
    return { width: width * scale, height: height * scale };
  }

  const SCALE_KEYS = ['uniform_scale', 'scale_x', 'scale_y'];
  /** 片段有没有缩放关键帧。 */
  const hasScaleKeyframes = (keyframes) => Boolean(keyframes?.some((item) => SCALE_KEYS.includes(item.property)));

  /**
   * 视觉片段的基准框，再乘上 effectiveTransform 的缩放就是最终大小。
   * 草稿里 cover / stretch 的放大系数只乘进静态缩放，缩放关键帧照原值写，在剪映里是绝对缩放（1.0 = contain 的大小），
   * 所以哪个方向有缩放关键帧，那个方向就按 contain 框算，预览才和导进剪映后一致。
   */
  function layerBox(stage, media, fit = 'contain', keyframes) {
    const fitted = fitBox(stage, media, fit);
    if (fit === 'contain' || !keyframes || !hasScaleKeyframes(keyframes)) return fitted;
    const has = (property) => keyframes.some((item) => item.property === property);
    const keyedX = has('uniform_scale') || has('scale_x');
    const keyedY = has('uniform_scale') || has('scale_y');
    const contain = fitBox(stage, media, 'contain');
    return { width: keyedX ? contain.width : fitted.width, height: keyedY ? contain.height : fitted.height };
  }

  /** 片段在舞台上的矩形：先按 fit 定大小，再乘缩放、按位移挪中心（y 向上为正）。 */
  function layerRect(stage, box, transform) {
    const width = box.width * transform.scale_x;
    const height = box.height * transform.scale_y;
    const centerX = stage.width / 2 + transform.transform_x * stage.width / 2;
    const centerY = stage.height / 2 - transform.transform_y * stage.height / 2;
    return {
      left: centerX - width / 2, top: centerY - height / 2, width, height,
      rotation: transform.rotation, flipX: transform.flip_horizontal, flipY: transform.flip_vertical, opacity: Math.min(1, Math.max(0, transform.alpha)),
    };
  }

  /** 旋转 + 翻转的 CSS transform；什么都没有时为 "none"。 */
  function cssTransform(rect) {
    const parts = [];
    if (rect.rotation) parts.push(`rotate(${round(rect.rotation, 3)}deg)`);
    if (rect.flipX || rect.flipY) parts.push(`scale(${rect.flipX ? -1 : 1},${rect.flipY ? -1 : 1})`);
    return parts.length ? parts.join(' ') : 'none';
  }

  /** 裁剪的四个角（0–1）换成 clip-path；没裁时为 null。 */
  function cropClipPath(crop) {
    if (!crop) return null;
    const point = (x, y) => `${round(x * 100, 3)}% ${round(y * 100, 3)}%`;
    const identity = crop.upper_left_x === 0 && crop.upper_left_y === 0 && crop.upper_right_x === 1 && crop.upper_right_y === 0
      && crop.lower_left_x === 0 && crop.lower_left_y === 1 && crop.lower_right_x === 1 && crop.lower_right_y === 1;
    if (identity) return null;
    return `polygon(${point(crop.upper_left_x, crop.upper_left_y)}, ${point(crop.upper_right_x, crop.upper_right_y)}, ${point(crop.lower_right_x, crop.lower_right_y)}, ${point(crop.lower_left_x, crop.lower_left_y)})`;
  }

  /**
   * 蒙版的近似：圆形 / 镜面 / 线性用 mask-image 渐变，矩形用 mask-image 内嵌 SVG（都带羽化和反转）；
   * 爱心、星形不画。中心点以素材像素为单位、y 向上，大小以素材高度为比例（同 pyJianYingDraft）。
   * 一律走 mask-image，不占 clip-path：clip-path 留给裁剪，两者同时生效。
   */
  function maskCss(mask, element, material) {
    if (!mask) return null;
    const materialWidth = material?.width > 0 ? material.width : element.width;
    const materialHeight = material?.height > 0 ? material.height : element.height;
    const cx = element.width / 2 + ((mask.center_x ?? 0) / materialWidth) * element.width;
    const cy = element.height / 2 - ((mask.center_y ?? 0) / materialHeight) * element.height;
    const size = (mask.size ?? 0.5) * element.height;
    const feather = Math.min(100, Math.max(0, mask.feather ?? 0)) / 100;
    const [inside, outside] = mask.invert ? ['transparent', '#000'] : ['#000', 'transparent'];
    const px = (value) => `${round(value, 2)}px`;
    if (mask.mask_type === '圆形') {
      const radius = size / 2;
      const image = `radial-gradient(circle ${px(radius * (1 + feather))} at ${px(cx)} ${px(cy)}, ${inside} ${round((1 - feather) / (1 + feather) * 100, 2)}%, ${outside} 100%)`;
      return { maskImage: image, WebkitMaskImage: image };
    }
    if (mask.mask_type === '矩形') {
      const width = (mask.rect_width ?? mask.size ?? 0.5) * element.width;
      const radius = Math.min(width, size) / 2 * Math.min(100, Math.max(0, mask.round_corner ?? 0)) / 100;
      const blur = (feather * Math.min(width, size)) / 8;
      const n = (value) => String(round(value, 2));
      const [w, h] = [element.width, element.height];
      // 反转和羽化都要往画面外多铺一圈，不然模糊会把画面边缘也带虚
      const region = `x="${n(-w)}" y="${n(-h)}" width="${n(3 * w)}" height="${n(3 * h)}"`;
      const filter = blur > 0 ? `<filter id="f" filterUnits="userSpaceOnUse" ${region}><feGaussianBlur stdDeviation="${n(blur)}"/></filter>` : '';
      const shape = (fill) => `<rect x="${n(cx - width / 2)}" y="${n(cy - size / 2)}" width="${n(width)}" height="${n(size)}" rx="${n(radius)}"${mask.rotation ? ` transform="rotate(${n(mask.rotation)} ${n(cx)} ${n(cy)})"` : ''} fill="${fill}"${blur > 0 ? ' filter="url(#f)"' : ''}/>`;
      const body = mask.invert
        ? `<mask id="m" maskUnits="userSpaceOnUse" ${region}><rect ${region} fill="#fff"/>${shape('#000')}</mask><rect width="${n(w)}" height="${n(h)}" fill="#000" mask="url(#m)"/>`
        : shape('#000');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${n(w)} ${n(h)}">${filter}${body}</svg>`;
      const image = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
      return { maskImage: image, WebkitMaskImage: image, maskSize: '100% 100%', WebkitMaskSize: '100% 100%', maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat' };
    }
    if (mask.mask_type === '线性' || mask.mask_type === '镜面') {
      // 渐变方向垂直于蒙版线；线过 (cx, cy)，蒙版旋转 0° 时线是水平的，线性蒙版保留上半边
      const angle = mask.rotation ?? 0;
      const radians = (angle * Math.PI) / 180;
      const span = Math.abs(element.width * Math.sin(radians)) + Math.abs(element.height * Math.cos(radians));
      const along = (cx - element.width / 2) * Math.sin(radians) - (cy - element.height / 2) * Math.cos(radians);
      const at = (offset) => `${round(((span / 2 + along + offset) / span) * 100, 2)}%`;
      const soft = (feather * element.height) / 4;
      const image = mask.mask_type === '线性'
        ? `linear-gradient(${round(angle, 2)}deg, ${outside} ${at(-soft)}, ${inside} ${at(soft)})`
        : `linear-gradient(${round(angle, 2)}deg, ${outside} ${at(-size / 2 - soft)}, ${inside} ${at(-size / 2 + soft)}, ${inside} ${at(size / 2 - soft)}, ${outside} ${at(size / 2 + soft)})`;
      return { maskImage: image, WebkitMaskImage: image };
    }
    return null;
  }

  // 工程里的特效 / 滤镜 / 转场 / 动画名是 pyJianYingDraft 的枚举成员名（_1998、Lofi_II、_3D空间），
  // 剪映里显示的是「1998」「Lofi II」「3D空间」。绝大多数只差下划线；对不上的这十几个单独列出，
  // 单测拿 server/aiEdit/catalog.json 逐个核对。模型直接给了显示名时原样不动。
  const FEATURE_NAMES = {
    X_Signal: 'X-Signal', 报纸_今日热门: '报纸:今日热门', 闪光灯_I: '闪光灯 Ⅰ', 假日闪闪_II: '假日闪闪 Ⅱ', 爱心烟花II: '爱心烟花Ⅱ',
    BOOM: 'BOOM！', crash: 'crash！', 变老_美颜: '变老-美颜', 有事吗: '有事吗？', 报纸拼贴II: '报纸拼贴Ⅱ', 叠叠乐_VI: '叠叠乐 Ⅵ',
    炸开_III: '炸开 Ⅲ', 彩虹_情人节: '彩虹-情人节', 彩虹_新年: '彩虹-新年', 彩虹_马卡龙: '彩虹-马卡龙',
  };
  /** 特效、滤镜、转场、动画、蒙版名换成剪映里显示的名字。 */
  function featureName(raw) {
    const name = (raw ?? '').trim();
    return FEATURE_NAMES[name] ?? name.replace(/^_+/u, '').replace(/_/gu, ' ').replace(/\s+/gu, ' ').trim();
  }

  /** 剪映滤镜按名字近似成 CSS filter，s 是强度（0–1）；认不出来的给一点饱和和对比，看得出套了滤镜。 */
  const FILTER_LOOKS = [
    [/黑白|默片|灰|单色/u, (s) => `grayscale(${s})`],
    [/复古|胶片|怀旧|老|旧|港|年代|\d{4}/u, (s) => `sepia(${0.45 * s}) contrast(${1 + 0.05 * s})`],
    [/暖|日落|夕阳|金|黄|秋|橙|焦糖/u, (s) => `sepia(${0.25 * s}) saturate(${1 + 0.25 * s})`],
    [/冷|蓝|冬|雪|青/u, (s) => `saturate(${1 - 0.15 * s}) hue-rotate(${12 * s}deg) brightness(${1 + 0.03 * s})`],
    [/暗|夜|黑金|低调/u, (s) => `brightness(${1 - 0.15 * s}) contrast(${1 + 0.15 * s})`],
    [/粉|樱|奶|柔|甜|梦|白皙/u, (s) => `brightness(${1 + 0.06 * s}) saturate(${1 - 0.15 * s})`],
    [/鲜|艳|浓|亮丽|绚/u, (s) => `saturate(${1 + 0.4 * s}) contrast(${1 + 0.05 * s})`],
    [/清晰|锐|质感|高清/u, (s) => `contrast(${1 + 0.15 * s})`],
    [/绿|森|抹茶/u, (s) => `hue-rotate(${-12 * s}deg) saturate(${1 + 0.1 * s})`],
  ];
  const filterLook = (name, s) => (FILTER_LOOKS.find(([pattern]) => pattern.test(name))?.[1] ?? ((v) => `saturate(${1 + 0.15 * v}) contrast(${1 + 0.05 * v})`))(s);

  /**
   * 视频 / 图片片段在 offsetUs 处画在舞台上的框（rect）和 CSS：位置大小、object-fit、旋转翻转、不透明度、亮度 / 对比度 / 饱和度关键帧和
   * 片段滤镜、裁剪、蒙版。material 是素材的像素大小（不知道给 null），box 不给按 layerBox 算。长度是舞台像素的数，没有的项是 undefined。
   */
  function layerStyle(stage, segment, material, offsetUs, box) {
    const fit = segment.fit ?? 'contain';
    const rect = layerRect(stage, box ?? layerBox(stage, material, fit, segment.keyframes), effectiveTransform(segment, offsetUs));
    const scaled = hasScaleKeyframes(segment.keyframes);
    const filter = [colorFilter(segment.keyframes, offsetUs), ...(segment.filters ?? []).map((item) => filterLook(featureName(item.filter_type), (item.intensity ?? 100) / 100))];
    return {
      rect,
      css: {
        position: 'absolute', left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        objectFit: material || (fit === 'stretch' && !scaled) ? 'fill' : fit === 'cover' && !scaled ? 'cover' : 'contain',
        transform: cssTransform(rect), opacity: rect.opacity,
        filter: filter.filter(Boolean).join(' ') || undefined,
        clipPath: cropClipPath(segment.crop) ?? undefined,
        ...maskCss(segment.mask, rect, material),
      },
    };
  }

  return {
    keyframeValue, IDENTITY_TRANSFORM, effectiveTransform, colorFilter, fadeGain, volumeAt, fitBox, hasScaleKeyframes, layerBox, layerRect, cssTransform,
    cropClipPath, maskCss, featureName, filterLook, layerStyle,
  };
}

export const {
  keyframeValue, IDENTITY_TRANSFORM, effectiveTransform, colorFilter, fadeGain, volumeAt, fitBox, hasScaleKeyframes, layerBox, layerRect, cssTransform,
  cropClipPath, maskCss, featureName, filterLook, layerStyle,
} = createClipLook(easeAt);

/** 嵌进网页的同一份：跑完页面里有 clipLook（上面那些函数）和 easeAt。 */
export const CLIP_LOOK_SOURCE = `${KEYFRAME_CURVE_SOURCE}const clipLook=(${createClipLook.toString()})(easeAt);`;
