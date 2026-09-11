import { TAU } from './math';
import { makeRayHit, pinToSegment, rayCast, type RayHit, type Segment } from './segment';
import type { Options } from '../config';

/** 一次角度采样：在 ang 方向上打到了第 segIndex 条线段的参数 u 处。 */
interface Sample {
  ang: number;
  segIndex: number;
  segId: number;
  u: number;
  x: number;
  y: number;
}

/** 可见性计算结果（缓冲区跨帧复用）。 */
export class Visibility {
  /**
   * 可见多边形顶点，[x0,y0,x1,y1,...]，严格按绕光源的极角排列。
   * 因为多边形关于光源是「星形」的，所以直接扇形三角化即可，无需耳切。
   */
  readonly poly: number[] = [];
  /** segmentId → [u0,u1, u0,u1 ...]：这段线段的哪些参数区间被照到（给方块棱边打光用） */
  readonly litSpans = new Map<number, number[]>();
  /** 本帧真正投射的射线数 */
  raysCast = 0;
  /** 光源被方块压住 → 没有可见区域 */
  blackout = false;

  reset(): void {
    this.poly.length = 0;
    for (const spans of this.litSpans.values()) spans.length = 0;
    this.raysCast = 0;
    this.blackout = false;
  }

  get vertexCount(): number {
    return this.poly.length >> 1;
  }

  /** 取某条线段被照亮的参数区间；没有就返回 undefined。 */
  litSpan(id: number): number[] | undefined {
    const s = this.litSpans.get(id);
    return s && s.length > 0 ? s : undefined;
  }
}

/**
 * 可见性求解器 —— 本 Demo 的核心。
 *
 * ## 为什么不能「360 条射线扫一圈」
 * 可见多边形的顶点**只可能**出现在「光源 → 障碍物角点」这些射线上：
 * 相邻两个角点角度之间，最近的遮挡物不会变（方块互不相交时成立），
 * 于是角度区间内部随便取一条射线就能问出「这一段被谁挡着」。
 *
 * ## 精确锁定边缘的做法（exact）
 * 1. 收集所有线段端点的极角 → 排序去重，得到 m 个「临界角」；
 * 2. 每个临界角区间取**中点**投一条射线，问出该区间唯一的遮挡线段（共 m 条射线，与 360 无关）；
 * 3. 把区间两端**精确钉**到这条线段上（u 夹到 [0,1]）—— 端点本身就是角点，
 *    所以阴影边界严格沿着「光源 → 角点」的射线走，一条缝都不漏，也不需要任何 ε。
 *
 * 另外提供两种对照实现：
 *  - `edge`    ：每个角点 ±ε 各投一条（工程上常见的做法，依赖 ε，会有细微漏光）
 *  - `uniform` ：均匀扫 N 条（题目里明确不要的那种，用来看差距）
 */
export class VisibilityEngine {
  private cornerBuffer = new Float64Array(2048);
  private readonly angles: number[] = [];
  private readonly expanded: number[] = [];
  private readonly samples: Sample[] = [];
  private sampleCount = 0;
  private readonly hit: RayHit = makeRayHit();
  private readonly pin: RayHit = makeRayHit();

  compute(px: number, py: number, segments: readonly Segment[], count: number, opts: Options, out: Visibility): void {
    out.reset();
    if (count <= 0) return;

    this.collectCornerAngles(px, py, segments, count);
    switch (opts.mode) {
      case 'uniform':
        this.runUniform(px, py, segments, count, opts.rayCount, out);
        break;
      case 'edge':
        this.runEdge(px, py, segments, count, opts.edgeEpsilon, out);
        break;
      default:
        this.runExact(px, py, segments, count, out);
        break;
    }
  }

  /** 端点极角 → 排序去重，存进 this.angles。 */
  private collectCornerAngles(px: number, py: number, segments: readonly Segment[], count: number): void {
    const need = count * 2;
    if (this.cornerBuffer.length < need) this.cornerBuffer = new Float64Array(Math.max(need, this.cornerBuffer.length * 2));
    const buf = this.cornerBuffer;
    let n = 0;
    for (let i = 0; i < count; i++) {
      const s = segments[i];
      buf[n++] = Math.atan2(s.ay - py, s.ax - px);
      buf[n++] = Math.atan2(s.by - py, s.bx - px);
    }
    const view = buf.subarray(0, n);
    view.sort();

    const list = this.angles;
    list.length = 0;
    let prev = -Infinity;
    for (let i = 0; i < n; i++) {
      const a = view[i];
      if (a - prev > 1e-9) {
        list.push(a);
        prev = a;
      }
    }
  }

  // ─────────────────────────────── 精确锁定边缘 ───────────────────────────────
  private runExact(px: number, py: number, segments: readonly Segment[], count: number, out: Visibility): void {
    const list = this.angles;
    const m = list.length;
    if (m < 2) return;
    this.sampleCount = 0;

    for (let i = 0; i < m; i++) {
      const a0 = list[i];
      // 最后一段绕回第一个角
      const a1 = i === m - 1 ? list[0] + TAU : list[i + 1];
      const span = a1 - a0;
      if (span < 1e-12) continue;

      // 1) 区间中点投一条射线：这一段归谁挡，问一次就够
      const am = a0 + span * 0.5;
      if (!rayCast(segments, count, px, py, Math.cos(am), Math.sin(am), this.hit)) continue;
      out.raysCast++;

      const seg = segments[this.hit.index];
      const segIndex = this.hit.index;

      // 2) 区间两端精确钉在这条线段上（角点即端点，u 会被夹住）
      pinToSegment(seg, px, py, Math.cos(a0), Math.sin(a0), this.pin);
      this.pushSample(a0, segIndex, seg.id, this.pin.u, this.pin.x, this.pin.y);
      pinToSegment(seg, px, py, Math.cos(a1), Math.sin(a1), this.pin);
      this.pushSample(a1, segIndex, seg.id, this.pin.u, this.pin.x, this.pin.y);
    }

    this.build(out);
  }

  // ─────────────────────────────── 角点 ±ε ───────────────────────────────
  private runEdge(px: number, py: number, segments: readonly Segment[], count: number, eps: number, out: Visibility): void {
    const list = this.angles;
    if (list.length < 2) return;
    const expanded = this.expanded;
    expanded.length = 0;
    for (let i = 0; i < list.length; i++) {
      expanded.push(list[i] - eps, list[i], list[i] + eps);
    }
    expanded.sort((a, b) => a - b);
    this.sampleCount = 0;

    let prev = -Infinity;
    for (let i = 0; i < expanded.length; i++) {
      const a = expanded[i];
      if (a - prev <= 1e-12) continue;
      prev = a;
      if (!rayCast(segments, count, px, py, Math.cos(a), Math.sin(a), this.hit)) continue;
      out.raysCast++;
      const seg = segments[this.hit.index];
      this.pushSample(a, this.hit.index, seg.id, this.hit.u, this.hit.x, this.hit.y);
    }

    this.build(out);
  }

  // ─────────────────────────────── 均匀射线 ───────────────────────────────
  private runUniform(px: number, py: number, segments: readonly Segment[], count: number, rayCount: number, out: Visibility): void {
    const n = Math.max(3, Math.floor(rayCount) || 360);
    const step = TAU / n;
    this.sampleCount = 0;

    for (let i = 0; i < n; i++) {
      const a = i * step;
      if (!rayCast(segments, count, px, py, Math.cos(a), Math.sin(a), this.hit)) continue;
      out.raysCast++;
      const seg = segments[this.hit.index];
      this.pushSample(a, this.hit.index, seg.id, this.hit.u, this.hit.x, this.hit.y);
    }

    this.build(out);
  }

  // ─────────────────────────────── 公共部分 ───────────────────────────────

  private pushSample(ang: number, segIndex: number, segId: number, u: number, x: number, y: number): void {
    let s = this.samples[this.sampleCount];
    if (!s) {
      s = { ang: 0, segIndex: 0, segId: 0, u: 0, x: 0, y: 0 };
      this.samples[this.sampleCount] = s;
    }
    this.sampleCount++;
    s.ang = ang;
    s.segIndex = segIndex;
    s.segId = segId;
    s.u = u;
    s.x = x;
    s.y = y;
  }

  /**
   * 把采样点整理成多边形 + 照亮区间：
   * 连续命中同一条线段的采样会被合并成一个「可见段」，只保留首尾两个顶点
   * （同一条线段上极角单调 ⇒ u 单调，中间点必然共线，留着只是浪费）。
   */
  private build(out: Visibility): void {
    const n = this.sampleCount;
    const poly = out.poly;
    let i = 0;
    while (i < n) {
      const segId = this.samples[i].segId;
      let j = i;
      while (j + 1 < n && this.samples[j + 1].segId === segId) j++;

      const a = this.samples[i];
      const b = this.samples[j];
      if (j === i) {
        poly.push(a.x, a.y);
      } else if (a.x !== b.x || a.y !== b.y) {
        poly.push(a.x, a.y, b.x, b.y);
      } else {
        poly.push(a.x, a.y);
      }

      let spans = out.litSpans.get(segId);
      if (!spans) {
        spans = [];
        out.litSpans.set(segId, spans);
      }
      spans.push(a.u, b.u);

      i = j + 1;
    }
  }
}
