/**
 * 线段 + 射线求交。
 *
 * 整个 Demo 的几何原语只有一种：线段。方块 = 4 条线段，屏幕外墙 = 4 条线段。
 * 可见性算法只依赖这里的 rayCast / pinToSegment 两个函数。
 */

export interface Segment {
  readonly id: number;
  /** 起点 */
  ax: number;
  ay: number;
  /** 终点 */
  bx: number;
  by: number;
  /** 方向向量（b - a），预先算好避免每帧重复减法 */
  ex: number;
  ey: number;
  /** 单位外法线（指向方块外侧） */
  nx: number;
  ny: number;
  /** 归属方块下标；-1 = 屏幕外墙 */
  owner: number;
  /** 方块的第几条边（0 上 / 1 右 / 2 下 / 3 左）；外墙为 -1 */
  edge: number;
}

/** 射线求交结果（复用同一个对象，避免每帧产生垃圾）。 */
export interface RayHit {
  /** 沿射线的距离 */
  t: number;
  /** 在线段上的参数 [0,1] */
  u: number;
  /** 命中的线段下标 */
  index: number;
  x: number;
  y: number;
}

export function makeSegment(id: number): Segment {
  return { id, ax: 0, ay: 0, bx: 0, by: 0, ex: 0, ey: 0, nx: 0, ny: 0, owner: -1, edge: -1 };
}

export function makeRayHit(): RayHit {
  return { t: Infinity, u: 0, index: -1, x: 0, y: 0 };
}

/** 原地重写一条线段（id 由池子决定，不在这里改）。 */
export function setSegment(s: Segment, ax: number, ay: number, bx: number, by: number, nx: number, ny: number, owner: number, edge: number): void {
  s.ax = ax;
  s.ay = ay;
  s.bx = bx;
  s.by = by;
  s.ex = bx - ax;
  s.ey = by - ay;
  s.nx = nx;
  s.ny = ny;
  s.owner = owner;
  s.edge = edge;
}

/**
 * 射线 (px,py) + t*(dx,dy) 与「前 count 条线段」的最近交点。
 * 返回是否命中，结果写进 out。
 */
export function rayCast(segments: readonly Segment[], count: number, px: number, py: number, dx: number, dy: number, out: RayHit): boolean {
  let bestT = Infinity;
  let bestU = 0;
  let bestI = -1;
  for (let i = 0; i < count; i++) {
    const s = segments[i];
    const den = dx * s.ey - dy * s.ex;
    if (den === 0) continue; // 射线与线段平行
    const wx = s.ax - px;
    const wy = s.ay - py;
    const t = (wx * s.ey - wy * s.ex) / den;
    if (t <= 1e-9 || t >= bestT) continue;
    const u = (wx * dy - wy * dx) / den;
    if (u < 0 || u > 1) continue;
    bestT = t;
    bestU = u;
    bestI = i;
  }
  if (bestI < 0) return false;
  out.t = bestT;
  out.u = bestU;
  out.index = bestI;
  out.x = px + dx * bestT;
  out.y = py + dy * bestT;
  return true;
}

/**
 * 把给定方向的射线「钉」到指定线段上：参数 u 夹到 [0,1]，
 * 于是当射线正好扫过线段端点（角点）时，交点被精确锁在角点上，不会漏出一丝缝。
 */
export function pinToSegment(seg: Segment, px: number, py: number, dx: number, dy: number, out: RayHit): void {
  const den = dx * seg.ey - dy * seg.ex;
  const wx = seg.ax - px;
  const wy = seg.ay - py;
  let u: number;
  if (Math.abs(den) < 1e-12) {
    // 射线与线段共线（光源刚好在边的延长线上）：取靠近光源的那一端
    u = wx * dx + wy * dy >= 0 ? 0 : 1;
  } else {
    u = (wx * dy - wy * dx) / den;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
  }
  out.u = u;
  out.index = seg.id;
  out.x = seg.ax + seg.ex * u;
  out.y = seg.ay + seg.ey * u;
  out.t = Math.hypot(out.x - px, out.y - py);
}

/** 点是否落在矩形内（用于判断光源有没有被方块压住）。 */
export function pointInRect(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  return px >= x && px <= x + w && py >= y && py <= y + h;
}
