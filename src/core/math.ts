/** 标量 / 角度小工具（无分配、够用就好）。 */

export const TAU = Math.PI * 2;

/** 把角度归一化到 [0, TAU)。 */
export function wrapAngle(a: number): number {
  const r = a % TAU;
  return r < 0 ? r + TAU : r;
}

/**
 * 由「种子 + 盐」派生出互不相关的整数种子（murmur3 风格的雪崩混合）。
 * 用途：让每条放置带拥有独立的随机数流 —— 这样某条带什么时候生成几个方块，
 * 都不会影响另一条带的序列。
 */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ Math.imul(salt + 1, 0x9e3779b9)) | 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h | 0;
}

/**
 * 随机一颗种子。
 * 世界本身是**种子决定论**的（同种子 ⇒ 同世界，且与帧率无关），
 * 但「挑哪颗种子」必须是随机的 —— 否则每个访客看到的世界一模一样。
 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

/** 可复现的伪随机数（xorshift32）：同一个种子永远给出同一串数。 */
export function makeRng(seed: number): () => number {
  let s = seed | 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}
