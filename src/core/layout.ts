import { REF_H, REF_W } from '../config';
import { makeRng } from './math';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 参考图 (1200×685) 里逐像素提取出来的 16 个方块。
 *
 * 提取方式：解码 PNG → 阈值分割（填充色恰好是 0x3D3D3D）→ 连通域 → 外接矩形，
 * 每个矩形的填充率都 ≥ 0.99（都是实心矩形，没有粘连）。
 *
 * 这份数据有两个用途：① 首帧 1:1 复刻参考图；② 作为**统计样本**拟合尺寸分布
 * （`SIZE_CLASSES` / `ASPECT_FIT` / `BANDS` 都是从它算出来的，不是另写死的）。
 */
export const REFERENCE_BLOCKS: readonly Rect[] = [
  { x: 243, y: 16, w: 141, h: 94 },
  { x: 960, y: 36, w: 141, h: 95 },
  { x: 749, y: 67, w: 141, h: 70 },
  { x: 502, y: 80, w: 203, h: 125 },
  { x: 81, y: 97, w: 130, h: 86 },
  { x: 261, y: 145, w: 203, h: 92 },
  { x: 949, y: 161, w: 207, h: 71 },
  { x: 811, y: 172, w: 59, h: 60 },
  { x: 209, y: 420, w: 146, h: 102 },
  { x: 958, y: 442, w: 145, h: 103 },
  { x: 736, y: 476, w: 148, h: 76 },
  { x: 479, y: 490, w: 212, h: 136 },
  { x: 40, y: 508, w: 135, h: 94 },
  { x: 227, y: 561, w: 213, h: 100 },
  { x: 945, y: 578, w: 215, h: 77 },
  { x: 800, y: 590, w: 63, h: 66 },
];

/** 参考图里灯泡的位置（1200×685 坐标系，实测最亮像素）。 */
export const REFERENCE_LIGHT = { x: 600, y: 325 };

// ─────────────────────── 尺寸分布：从上面 16 个样本拟合 ───────────────────────

/**
 * 宽度实测分布是明显的三峰：59~63(2 个) / 130~148(8 个) / 203~215(6 个)，
 * 而 80~120 与 160~200 是空的 —— 说明原图就是「小方块 / 中条 / 长条」三档。
 * 这里保留三档与权重，但每档宽度**连续随机**且左右各放宽一点，
 * 因此生成结果不会退化成那 16 个固定值。
 */
export const SIZE_CLASSES = [
  { weight: 2 / 16, min: 50, max: 86 }, // 小方块
  { weight: 8 / 16, min: 116, max: 164 }, // 中条
  { weight: 6 / 16, min: 188, max: 230 }, // 长条
] as const;

/** 长宽比实测 ≈ LogNormal(μ=0.510, σ=0.304)：中位数 1.66，跨度 0.95~2.92。 */
export const ASPECT_FIT = { mu: 0.51, sigma: 0.304, min: 0.9, max: 3.2 } as const;

/** 高度实测 60~136，两端各放宽一点。 */
export const HEIGHT_RANGE = { min: 46, max: 150 } as const;

/**
 * 水平放置带：把参考图的 16 个方块按 y 聚类（在最大的垂直空隙处切开）得到上下两条带。
 * 带与带 y 区间不重叠 ⇒ 跨带永不相交，只有带内需要碰撞检测。
 * 副产品：中间那条空带正好留给灯泡，和参考图的构图一致。
 */
export interface Band {
  y: number;
  h: number;
}

export function deriveBands(blocks: readonly Rect[], pad = 6): Band[] {
  const sorted = [...blocks].sort((a, b) => a.y - b.y);
  let splitAt = -1;
  let biggest = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].y - (sorted[i].y + sorted[i].h);
    if (gap > biggest) {
      biggest = gap;
      splitAt = i;
    }
  }
  const groups: Rect[][] = splitAt < 0 ? [sorted] : [sorted.slice(0, splitAt + 1), sorted.slice(splitAt + 1)];
  return groups.map((g) => {
    const top = Math.max(0, Math.min(...g.map((b) => b.y)) - pad);
    const bottom = Math.min(REF_H, Math.max(...g.map((b) => b.y + b.h)) + pad);
    return { y: top, h: bottom - top };
  });
}

export const BANDS: readonly Band[] = deriveBands(REFERENCE_BLOCKS);

/** 两个矩形是否重叠（可加间隙）。 */
export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
}

/** 布局自检：两两不重叠 —— 可见性算法「区间内遮挡者唯一」的前提就靠它。 */
export function layoutIsDisjoint(rects: readonly Rect[], pad = 0): boolean {
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j], pad)) return false;
    }
  }
  return true;
}

export { REF_H, REF_W, makeRng };
