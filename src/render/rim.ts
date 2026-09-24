/**
 * 棱边高光的几何与亮度 —— WebGL2 与 Canvas 2D 共用，保证两个后端逐像素一致。
 *
 * 两条棱边线索合起来决定「亮哪一段、有多亮」：
 *
 *   1. **亮哪一段**：可见性计算顺手给出的副产品 `litSpan` —— 每条线段被照亮的参数区间。
 *      它已经扣掉了遮挡，所以棱边亮段天然与阴影边界对齐，不需要额外判定。
 *   2. **有多亮**：先看朝向（外法线与光源方向的夹角），再看 `rimLight` 选定的亮度来源。
 *
 * 关于亮度来源，有个绕不开的事实：棱边画在**不透明的方块本体**之上，
 * 所以它不可能等于「该处地板亮度」——那会和方块内部一样黑，棱边就没了。
 * 能做的只有一件事：把方块底色往白里推，推多少表示「这块表面被照到会有多亮」。
 * 于是四种模式的区别只在**这个比例乘不乘衰减**：
 *
 * | 模式 | 亮度因子 | 观感 |
 * | --- | --- | --- |
 * | `flat` | `1` | 远近一样亮，棱边最清晰 |
 * | `falloff` | `f(d)` | 只带距离衰减，近处亮、远处淡 |
 * | `direct` | `directShare · f(d)` | 只有会被遮挡的那份；阴影里 f→0，棱边随之消失 |
 * | `local` | `(1-directShare) + directShare·f(d)` | 完整复刻地板亮度曲线；最远处仍有环境光那 38%，不会全灭 |
 *
 * 其中 `f(d) = (1 - d/R)^p`，与背景层 / 直接光层用的是同一个 `glowRadius`、`glowPower`。
 */
import type { RimLight } from '../config';
import type { BlockInstance } from '../core/scene';
import type { Segment } from '../core/segment';
import type { Visibility } from '../core/visibility';
import { settings } from '../settings';

/** 「那里的亮度」：辉光衰减因子 `f(d)`，与着色器同式。 */
export function glowFalloff(distance: number): number {
  const t = 1 - distance / settings.glowRadius;
  return t <= 0 ? 0 : Math.pow(t, settings.glowPower);
}

/**
 * 亮度因子：`rimLight` 选定来源下的相对亮度，1 表示不做衰减（= `flat` 的行为）。
 * `directShare = 0` 时 `direct` / `local` 会退化成 `flat`，这是模型的自然结果，不是特例。
 */
export function rimFactor(distance: number, mode: RimLight = settings.rimLight): number {
  switch (mode) {
    case 'falloff':
      return glowFalloff(distance);
    case 'direct':
      return settings.directShare * glowFalloff(distance);
    case 'local': {
      const ds = 1 - settings.directShare;
      return ds + settings.directShare * glowFalloff(distance);
    }
    default:
      return 1;
  }
}

/** 一条待画的棱边亮段（世界坐标端点 + 已经算好的颜色）。 */
export interface RimSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
  g: number;
  b: number;
}

/**
 * 收集一帧里所有要画的棱边亮段。
 *
 * `far` 是底色映射的落点：底色 `fill` 被推到 `far` 表示「完全被照到」（白）。
 * 取 1 是因为叠加层就是按 0..1 的白色在混；`local` 模式下这里正好对应
 * 「该处地板亮度 = 亮区上限」那个点，所以两种理解在这里是同一个值。
 *
 * 长度小于 0.5 世界单位的亮段直接丢掉 —— 看不见，还白白多两个三角形。
 */
export function collectRimSegments(
  model: {
    instanceCount: number;
    instances: readonly BlockInstance[];
    segments: readonly Segment[];
    vis: Visibility;
    light: { x: number; y: number };
  },
  fill: readonly [number, number, number],
  far = 1,
): RimSegment[] {
  const out: RimSegment[] = [];
  const [fr, fg, fb] = fill;
  const light = model.light;

  for (let i = 0; i < model.instanceCount; i++) {
    const inst = model.instances[i];
    for (let e = 0; e < 4; e++) {
      const segId = inst.segIds[e];
      const seg = model.segments[segId];
      if (!seg || seg.id !== segId) continue;
      const spans = model.vis.litSpan(segId);
      if (!spans) continue;

      for (let s = 0; s < spans.length; s += 2) {
        const x0 = seg.ax + seg.ex * spans[s];
        const y0 = seg.ay + seg.ey * spans[s];
        const x1 = seg.ax + seg.ex * spans[s + 1];
        const y1 = seg.ay + seg.ey * spans[s + 1];
        if (Math.hypot(x1 - x0, y1 - y0) < 0.5) continue;

        // 这一小段棱边朝向光源的程度
        const mx = (x0 + x1) * 0.5 - light.x;
        const my = (y0 + y1) * 0.5 - light.y;
        const dist = Math.hypot(mx, my) || 1;
        const ndotl = Math.max(0, (-mx * seg.nx - my * seg.ny) / dist);

        const k = settings.rimStrength * (0.3 + 0.7 * ndotl) * rimFactor(dist);
        const mix = (c: number) => c + (far - c) * k;
        out.push({ x0, y0, x1, y1, r: mix(fr), g: mix(fg), b: mix(fb) });
      }
    }
  }
  return out;
}
