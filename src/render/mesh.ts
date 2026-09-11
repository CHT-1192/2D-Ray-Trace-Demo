import { settings } from '../settings';

/**
 * 三角形的动态顶点缓冲（pos.xy + rgba），两个后端共用同一套「几何组装」逻辑。
 * 每帧只重写前 n 个 float，不做任何分配。
 */
export class MeshBuilder {
  private data: Float32Array;

  /** 当前写了多少个 float */
  n = 0;

  constructor(capacity = 1 << 15) {
    this.data = new Float32Array(capacity);
  }

  reset(): void {
    this.n = 0;
  }

  get floats(): Float32Array {
    return this.data;
  }

  /** 只读视图，交给 gl.bufferData 用 */
  view(): Float32Array {
    return this.data.subarray(0, this.n);
  }

  get vertexCount(): number {
    return this.n / 6;
  }

  private ensure(extra: number): void {
    if (this.n + extra <= this.data.length) return;
    let cap = this.data.length * 2;
    while (cap < this.n + extra) cap *= 2;
    const next = new Float32Array(cap);
    next.set(this.data.subarray(0, this.n));
    this.data = next;
  }

  vert(x: number, y: number, r: number, g: number, b: number, a: number): void {
    this.ensure(6);
    const d = this.data;
    let i = this.n;
    d[i++] = x;
    d[i++] = y;
    d[i++] = r;
    d[i++] = g;
    d[i++] = b;
    d[i++] = a;
    this.n = i;
  }

  tri(
    x0: number, y0: number, x1: number, y1: number, x2: number, y2: number,
    r: number, g: number, b: number, a: number,
  ): void {
    this.vert(x0, y0, r, g, b, a);
    this.vert(x1, y1, r, g, b, a);
    this.vert(x2, y2, r, g, b, a);
  }

  rect(x: number, y: number, w: number, h: number, r: number, g: number, b: number, a: number): void {
    this.tri(x, y, x + w, y, x + w, y + h, r, g, b, a);
    this.tri(x, y, x + w, y + h, x, y + h, r, g, b, a);
  }

  /** 以 (x0,y0)-(x1,y1) 为轴、半宽 hw 的矩形（用来画线，WebGL 的 lineWidth 不可靠） */
  thickLine(
    x0: number, y0: number, x1: number, y1: number, hw: number,
    r: number, g: number, b: number, a: number,
  ): void {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return;
    const nx = (-dy / len) * hw;
    const ny = (dx / len) * hw;
    this.tri(x0 + nx, y0 + ny, x1 + nx, y1 + ny, x1 - nx, y1 - ny, r, g, b, a);
    this.tri(x0 + nx, y0 + ny, x1 - nx, y1 - ny, x0 - nx, y0 - ny, r, g, b, a);
  }

  /** 带径向渐变的圆盘（灯泡 + 外晕）：stops = [半径, r, g, b, a] */
  disc(cx: number, cy: number, stops: readonly (readonly number[])[], segments = 48): void {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      for (let s = 0; s < segments; s++) {
        const t0 = (s / segments) * Math.PI * 2;
        const t1 = ((s + 1) / segments) * Math.PI * 2;
        const c0 = Math.cos(t0);
        const s0 = Math.sin(t0);
        const c1 = Math.cos(t1);
        const s1 = Math.sin(t1);
        // 环带用两个三角形拼
        this.tri(cx + c0 * a[0], cy + s0 * a[0], cx + c1 * a[0], cy + s1 * a[0], cx + c1 * b[0], cy + s1 * b[0], a[1], a[2], a[3], a[4]);
        this.tri(cx + c0 * a[0], cy + s0 * a[0], cx + c1 * b[0], cy + s1 * b[0], cx + c0 * b[0], cy + s0 * b[0], b[1], b[2], b[3], b[4]);
      }
    }
  }
}

/** 参考图亮度曲线在 Canvas2D 里的近似：把同一个衰减函数采样成一串渐变色标。 */
export function falloffStops(radius: number, power: number, scale: number, steps = 24): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const d = t * radius;
    const f = d >= radius ? 0 : Math.pow(1 - d / radius, power);
    out.push([t, f * scale * settings.glowAmp]);
  }
  return out;
}
