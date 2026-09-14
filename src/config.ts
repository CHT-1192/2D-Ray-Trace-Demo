/**
 * 全局配置：参考图（1200×685 截图）里量出来的视觉参数 + 运行时可调项。
 *
 * 所有颜色/亮度都是「0..1 sRGB 灰度」，数值直接来自对参考截图的逐像素采样：
 *   - 方块填充 = 61/255 ≈ 0.239
 *   - 远处背景 = 81/255 ≈ 0.318，光源附近平台期 = 153/255 = 0.600
 *   - 亮度随距离的衰减拟合为  v(d) = 0.315 + 0.300 * (1 - d/R)^p
 *
 * 其中 R / p 后来按需求调过：参考图那套（R=700, p=1.16）光照只够铺到画面中部，
 * 现在放大到 R=1050, p=1.0，让亮光铺满整个画面、阴影在更远处也还看得清。
 * 其余参数仍是参考图实测值。
 */

/** 参考截图的尺寸（像素）。 */
export const REF_W = 1200;
export const REF_H = 685;

/**
 * 世界坐标 = 「以参考图为标尺的像素坐标」：
 * 高度恒为 REF_H，宽度按视口宽高比推导，于是任何窗口尺寸下画面构图都与参考图一致。
 */
export const WORLD_H = REF_H;

export const THEME = {
  /** 方块填充色（参考图实测 0x3D3D3D） */
  blockFill: [0x3d / 255, 0x3d / 255, 0x3d / 255] as const,
  /** 阴影里的环境光下限 */
  bgFar: 0.315,
  /** 光源辉光的振幅 */
  glowAmp: 0.3,
  /** 辉光影响半径（世界单位）：1050 能覆盖 1200×685 画面的最远角（≈690） */
  glowRadius: 1050,
  /** 辉光衰减指数：1.0 时远端抬得起来，光照范围看着更大（参考图拟合值是 1.16） */
  glowPower: 1,
  /** 辉光中「定向光」占比：只有这段会被方块遮挡，其余算环境光 */
  directShare: 0.62,
  /**
   * 灯泡的径向剖面：[半径(世界单位), 叠加的白色透明度]。
   * 逐点实测拟合（r 为世界单位）：0→255, 2→250, 4→242, 6→215, 8→183, 10≈平台期 153。
   * 灯泡叠在「环境光 + 直接光」的平台期 157 之上，换算出的透明度即下表。
   */
  lightStops: [
    [0, 0.7],
    [1, 0.55],
    [2, 0.39],
    [4, 0.36],
    [6, 0.29],
    [8, 0.115],
    [9.5, 0.02],
    [13, 0],
  ] as ReadonlyArray<readonly [number, number]>,
  /** 方块朝向光源那条棱的高光强度 */
  rimStrength: 0.46,
  /** 外墙到视口的额外距离：射线兜底，保证可见多边形永远闭合 */
  wallMargin: 120,
} as const;

/** 三种可见性算法。 */
export type VisibilityMode = 'exact' | 'edge' | 'uniform';

export const MODE_LABEL: Record<VisibilityMode, string> = {
  exact: '精确锁定边缘',
  edge: '角点 ±ε',
  uniform: '均匀射线',
};

export interface Options {
  /** 可见性算法 */
  mode: VisibilityMode;
  /** 滚动速度（世界单位 / 秒） */
  speed: number;
  /** uniform 模式的射线数 */
  rayCount: number;
  /** edge 模式的角偏移（弧度） */
  edgeEpsilon: number;
  /** 画射线（调试：可以看到射线正好钉在角点上） */
  debugRays: boolean;
  /** 光源跟随鼠标 */
  followMouse: boolean;
  /** 暂停滚动 */
  paused: boolean;
  /** 显示方块（关掉就能直接看到可见多边形本身） */
  showBlocks: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  mode: 'exact',
  speed: 70,
  rayCount: 360,
  edgeEpsilon: 1e-3,
  debugRays: false,
  followMouse: false,
  paused: false,
  showBlocks: true,
};
