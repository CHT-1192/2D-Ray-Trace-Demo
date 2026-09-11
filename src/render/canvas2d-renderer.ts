import { WORLD_H } from '../config';
import { blockFill, bulbStops, settings } from '../settings';
import { falloffStops } from './mesh';
import type { RenderModel, Renderer } from './types';

function gray(v: number): string {
  const c = Math.max(0, Math.min(255, Math.round(v * 255)));
  return `rgb(${c},${c},${c})`;
}

/**
 * Canvas2D 后端：没有 WebGL2 时的兜底，画的是同一套几何。
 * 径向衰减用「把同一条衰减曲线采样成多个色标」的径向渐变来近似，肉眼与 WebGL 版本一致。
 */
export class Canvas2DRenderer implements Renderer {
  readonly backend = 'canvas2d' as const;
  readonly detail = 'Canvas 2D（CPU 回退）';

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private scale = 1;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.canvas = canvas;
    this.ctx = ctx;
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // 世界坐标 → CSS 像素是等比缩放（世界高度恒为 WORLD_H）
    this.scale = cssH / WORLD_H;
    this.ctx.setTransform(dpr * this.scale, 0, 0, dpr * this.scale, 0, 0);
  }

  render(model: RenderModel): void {
    const ctx = this.ctx;
    const { light, worldW, worldH } = model;

    // ── 背景：环境光 + 那层「没有光线追踪」的辉光
    const bg = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, settings.glowRadius);
    for (const [t, v] of falloffStops(settings.glowRadius, settings.glowPower, 1 - settings.directShare)) {
      bg.addColorStop(t, gray(settings.bgFar + v));
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, worldW, worldH);

    // ── 直接光：把可见多边形裁出来，叠加一层径向衰减
    const n = model.vis.vertexCount;
    if (!model.blackout && n >= 3) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(model.vis.poly[0], model.vis.poly[1]);
      for (let i = 1; i < n; i++) ctx.lineTo(model.vis.poly[i * 2], model.vis.poly[i * 2 + 1]);
      ctx.closePath();
      ctx.clip();
      ctx.globalCompositeOperation = 'lighter';
      const lit = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, settings.glowRadius);
      for (const [t, v] of falloffStops(settings.glowRadius, settings.glowPower, settings.directShare)) {
        lit.addColorStop(t, gray(v));
      }
      ctx.fillStyle = lit;
      ctx.fillRect(0, 0, worldW, worldH);
      ctx.restore();
    }

    // ── 调试射线
    if (model.opts.debugRays) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(255,222,153,0.22)';
      ctx.lineWidth = settings.rayWidth * model.pxScale;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        ctx.moveTo(light.x, light.y);
        ctx.lineTo(model.vis.poly[i * 2], model.vis.poly[i * 2 + 1]);
      }
      ctx.stroke();
    }

    // ── 方块 + 被照亮的棱边
    if (model.opts.showBlocks) {
      ctx.globalCompositeOperation = 'source-over';
      const fr = blockFill()[0];
      ctx.fillStyle = gray(fr);
      const count = model.instanceCount;
      for (let i = 0; i < count; i++) {
        const inst = model.instances[i];
        ctx.fillRect(inst.x, inst.y, inst.w, inst.h);
      }

      ctx.lineCap = 'butt';
      ctx.lineWidth = settings.rimWidth * 2 * model.pxScale;
      for (let i = 0; i < count; i++) {
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
            const mx = (x0 + x1) * 0.5 - light.x;
            const my = (y0 + y1) * 0.5 - light.y;
            const dist = Math.hypot(mx, my) || 1;
            const ndotl = Math.max(0, (-mx * seg.nx - my * seg.ny) / dist);
            const k = settings.rimStrength * (0.3 + 0.7 * ndotl);
            ctx.strokeStyle = gray(fr + (1 - fr) * k);
            ctx.beginPath();
            ctx.moveTo(x0, y0);
            ctx.lineTo(x1, y1);
            ctx.stroke();
          }
        }
      }
    }

    // ── 灯泡
    ctx.globalCompositeOperation = 'lighter';
    const stops = bulbStops();
    const halo = stops[stops.length - 1][0] || 1;
    const glow = ctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, halo);
    for (const [r, , , , a] of stops) glow.addColorStop(Math.min(1, r / halo), `rgba(255,255,255,${a})`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(light.x, light.y, halo, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalCompositeOperation = 'source-over';
  }

  dispose(): void {
    /* 无需释放 */
  }
}
