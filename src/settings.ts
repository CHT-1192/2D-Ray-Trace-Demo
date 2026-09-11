/**
 * 运行时可调参数的**唯一真源**。
 *
 * 默认值分两类来源：
 *   - 视觉：`config.THEME`（对参考截图逐像素采样的结果，光照范围后来按需求调大过）
 *   - 生成：`core/layout.ts` 里的 `SIZE_CLASSES` / `ASPECT_FIT` / `HEIGHT_RANGE`（从参考图拟合）
 *
 * 渲染与生成每帧都直接读这个对象，所以高级面板里拖动滑块是立刻生效的：
 *   - 视觉参数（光照、灯泡、方块灰度、线宽）当帧生效；
 *   - 生成参数只影响**之后新生成**的方块，已经在场上的不会变（想立刻看到就按 N 换种子）；
 *   - 光源位置改完要重算光照，app 会顺带 relayout 一次。
 */
import { THEME } from './config';
import { ASPECT_FIT, HEIGHT_RANGE, SIZE_CLASSES } from './core/layout';

export interface Settings {
  // ── 光照 ──────────────────────────────────────────────
  /** 辉光影响半径（世界单位） */
  glowRadius: number;
  /** 辉光衰减指数 */
  glowPower: number;
  /** 辉光振幅 */
  glowAmp: number;
  /** 阴影里 / 最远处的地板亮度 */
  bgFar: number;
  /** 辉光里「会被遮挡」的比例，也就是阴影深度 */
  directShare: number;
  /** 方块迎光棱边的高光强度 */
  rimStrength: number;

  // ── 灯泡 ──────────────────────────────────────────────
  /** 灯泡剖面半径的整体缩放 */
  bulbSize: number;
  /** 灯泡剖面透明度的整体缩放 */
  bulbBright: number;
  /** 光源归一化位置（0~1） */
  lightX: number;
  lightY: number;

  // ── 方块外观与线宽 ────────────────────────────────────
  /** 方块灰度（参考图实测 0x3D3D3D ≈ 0.239） */
  blockTone: number;
  /** 迎光棱边高光宽度（CSS 像素） */
  rimWidth: number;
  /** 调试射线宽度（CSS 像素） */
  rayWidth: number;
  /** 调试射线端点亮点半径（CSS 像素，0 = 不画） */
  dotRadius: number;

  // ── 生成器 ────────────────────────────────────────────
  /** 横向步进里「按自身宽度推进」的比例：越小越容易出现同带内 x 重叠 */
  overlap: number;
  /** 横向步进里的随机附加量：越大越疏密不均 */
  stepSpread: number;
  /** 同带内两个方块的最小间隙 */
  gap: number;
  /** 采样出的宽度整体缩放 */
  widthScale: number;
  /** 高度上下限 */
  heightMin: number;
  heightMax: number;
  /** 长宽比对数正态的中心与离散度 */
  aspectMu: number;
  aspectSigma: number;
  /** 三档宽度权重（小方块 / 中条 / 长条），采样时按比例归一化 */
  weightSmall: number;
  weightMedium: number;
  weightLarge: number;

  // ── 兜底 ──────────────────────────────────────────────
  /** 外墙离视口的距离：只影响射线兜底，画面无变化 */
  wallMargin: number;
}

export function defaultSettings(): Settings {
  const [small, medium, large] = SIZE_CLASSES;
  return {
    glowRadius: THEME.glowRadius,
    glowPower: THEME.glowPower,
    glowAmp: THEME.glowAmp,
    bgFar: THEME.bgFar,
    directShare: THEME.directShare,
    rimStrength: THEME.rimStrength,

    bulbSize: 1,
    bulbBright: 1,
    lightX: 0.5,
    lightY: 325 / 685,

    blockTone: THEME.blockFill[0],
    rimWidth: 0.85,
    rayWidth: 0.5,
    dotRadius: 2.2,

    overlap: 0.45,
    stepSpread: 100,
    gap: 10,
    widthScale: 1,
    heightMin: HEIGHT_RANGE.min,
    heightMax: HEIGHT_RANGE.max,
    aspectMu: ASPECT_FIT.mu,
    aspectSigma: ASPECT_FIT.sigma,
    weightSmall: small.weight,
    weightMedium: medium.weight,
    weightLarge: large.weight,

    wallMargin: THEME.wallMargin,
  };
}

/** 当前生效的参数。高级面板直接改这里。 */
export const settings: Settings = defaultSettings();

/** 恢复默认值。 */
export function resetSettings(): void {
  Object.assign(settings, defaultSettings());
}

/** 方块填充色（灰度）。 */
export function blockFill(): [number, number, number] {
  const t = settings.blockTone;
  return [t, t, t];
}

/** 灯泡径向剖面：`[半径, r, g, b, a]`，按 bulbSize / bulbBright 缩放。 */
export function bulbStops(): Array<[number, number, number, number, number]> {
  return THEME.lightStops.map(([r, a]) => [
    r * settings.bulbSize,
    1,
    1,
    1,
    Math.min(1, a * settings.bulbBright),
  ]);
}

/**
 * 从当前设置采样一个方块尺寸（单位：参考坐标系像素）。
 * 三档权重按比例归一化，宽度在档内连续随机，长宽比取自对数正态。
 */
export function sampleSize(rng: () => number): { w: number; h: number } {
  const classes = [SIZE_CLASSES[0], SIZE_CLASSES[1], SIZE_CLASSES[2]];
  const weights = [settings.weightSmall, settings.weightMedium, settings.weightLarge];
  const total = weights[0] + weights[1] + weights[2];

  let cls = classes[2];
  if (total > 1e-6) {
    let r = rng() * total;
    for (let i = 0; i < 3; i++) {
      if (r < weights[i]) {
        cls = classes[i];
        break;
      }
      r -= weights[i];
    }
  }

  const w = (cls.min + rng() * (cls.max - cls.min)) * settings.widthScale;

  // 长宽比取自对数正态；算出的高度越界就重采几次，
  // 避免所有极端宽度都被夹到同一个高度、在边界上堆成一堆。
  let h = w / Math.exp(settings.aspectMu);
  for (let attempt = 0; attempt < 6; attempt++) {
    const u1 = Math.max(1e-9, rng());
    const u2 = rng();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    const aspect = Math.min(ASPECT_FIT.max, Math.max(ASPECT_FIT.min, Math.exp(settings.aspectMu + settings.aspectSigma * z)));
    h = w / aspect;
    if (h >= settings.heightMin && h <= settings.heightMax) break;
  }
  const lo = Math.min(settings.heightMin, settings.heightMax);
  const hi = Math.max(settings.heightMin, settings.heightMax);
  h = Math.min(hi, Math.max(lo, h));
  return { w: Math.round(w), h: Math.round(h) };
}
