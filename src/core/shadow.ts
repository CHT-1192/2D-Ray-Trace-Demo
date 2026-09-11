/**
 * 本影（umbra）几何：一个方块从光源看过去投出的阴影区域。
 *
 * 和可见性算法用的是同一条原则 —— 阴影边界只由「光源 → 角点」的射线决定：
 * 方块是凸的，从外部看过去只有两个**剪影角点**（恰好只有一条相邻边朝向光源的角点），
 * 两条剪影射线围出来的区域就是它的本影。所以这里同样不需要任何 ε。
 *
 * 本影四边形 = [c1, c2, far(c2), far(c1)]：
 * 近端用两个剪影角点之间的**弦**代替方块背面的折线 —— 多出来的那块正好落在方块内部，
 * 而方块是不透明的、后画，所以看不出来（`showBlocks` 关掉时才有极小的差别）。
 */
import type { BlockInstance } from './scene';
import type { Segment } from './segment';

/**
 * 写出方块的本影四边形顶点（8 个数：x0,y0 … x3,y3），返回是否成功。
 * 光源落在方块内部（或退化）时返回 false。
 */
export function umbraQuad(
  inst: BlockInstance,
  segments: readonly Segment[],
  lx: number,
  ly: number,
  far: number,
  out: number[],
): boolean {
  // 边的外法线已知：光源在这条边的外侧 ⇒ 这条边朝向光源
  let front = 0;
  for (let e = 0; e < 4; e++) {
    const s = segments[inst.segIds[e]];
    if ((lx - s.ax) * s.nx + (ly - s.ay) * s.ny > 0) front |= 1 << e;
  }

  // 角点 i 由边 i 与边 (i+3)%4 共享；恰好一条边朝向光源 ⇒ 它是剪影角点
  let n = 0;
  let x1 = 0;
  let y1 = 0;
  let x2 = 0;
  let y2 = 0;
  for (let i = 0; i < 4; i++) {
    const a = (front >> i) & 1;
    const b = (front >> ((i + 3) % 4)) & 1;
    if (a === b) continue;
    const s = segments[inst.segIds[i]];
    if (n === 0) {
      x1 = s.ax;
      y1 = s.ay;
    } else if (n === 1) {
      x2 = s.ax;
      y2 = s.ay;
    }
    n++;
  }
  if (n !== 2) return false;

  const d1 = Math.hypot(x1 - lx, y1 - ly) || 1;
  const d2 = Math.hypot(x2 - lx, y2 - ly) || 1;
  out[0] = x1;
  out[1] = y1;
  out[2] = x2;
  out[3] = y2;
  out[4] = x2 + ((x2 - lx) / d2) * far;
  out[5] = y2 + ((y2 - ly) / d2) * far;
  out[6] = x1 + ((x1 - lx) / d1) * far;
  out[7] = y1 + ((y1 - ly) / d1) * far;
  return true;
}
