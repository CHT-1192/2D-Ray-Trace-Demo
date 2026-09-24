import { WORLD_H } from '../config';
import { umbraQuad } from '../core/shadow';
import { blockFill, bulbStops, settings } from '../settings';
import { falloffStops } from './mesh';
import { collectRimSegments } from './rim';
import type { RenderModel, Renderer } from './types';

function gray(v: number): string {
  const c = toByte(v);
  return `rgb(${c},${c},${c})`;
}

function toByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
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
  /** 离屏「光场」：只有 amp·f，然后被每个方块的本影逐个 multiply 掉 */
  private field = document.createElement('canvas');
  private readonly umbra = [0, 0, 0, 0, 0, 0, 0, 0];
  private scale = 1;
  private pixelScale = 1;

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
    this.pixelScale = dpr * this.scale;
    this.ctx.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);
    if (this.field.width !== w || this.field.height !== h) {
      this.field.width = w;
      this.field.height = h;
    }
  }

  render(model: RenderModel): void {
    const ctx = this.ctx;
    const { light, worldW, worldH } = model;
    const ds = 1 - settings.directShare; // 一个遮挡物之后剩下的比例

    // ── 离屏光场：先铺满 amp·f，再让每个方块的本影乘掉一次 ds
    //    于是被 n 个方块挡住的像素拿到 amp·f·dsⁿ —— 多重阴影就是这么累积的。
    const field = this.field;
    const fctx = field.getContext('2d');
    if (!fctx) return;
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.globalCompositeOperation = 'source-over';
    fctx.clearRect(0, 0, field.width, field.height);
    fctx.setTransform(this.pixelScale, 0, 0, this.pixelScale, 0, 0);

    if (model.blackout) {
      // 灯泡被方块埋住：整屏都按「一层遮挡」处理，和 WebGL 版一致
      fctx.fillStyle = gray(settings.glowAmp * ds);
      fctx.fillRect(0, 0, worldW, worldH);
    } else {
      const glow = fctx.createRadialGradient(light.x, light.y, 0, light.x, light.y, settings.glowRadius);
      for (const [t, v] of falloffStops(settings.glowRadius, settings.glowPower, 1)) {
        glow.addColorStop(t, gray(v));
      }
      fctx.fillStyle = glow;
      fctx.fillRect(0, 0, worldW, worldH);

      fctx.globalCompositeOperation = 'multiply';
      fctx.fillStyle = gray(ds);
      for (let i = 0; i < model.instanceCount; i++) {
        const inst = model.instances[i];
        if (!umbraQuad(inst, model.segments, light.x, light.y, 4000, this.umbra)) continue;
        const q = this.umbra;
        fctx.beginPath();
        fctx.moveTo(q[0], q[1]);
        fctx.lineTo(q[2], q[3]);
        fctx.lineTo(q[4], q[5]);
        fctx.lineTo(q[6], q[7]);
        fctx.closePath();
        fctx.fill();
      }
      fctx.globalCompositeOperation = 'source-over';
    }

    // ── 主画布：环境光地板 + 光场（叠加），等价于 WebGL 版的
    //    背景 + 可见多边形扇形 + 多重阴影修正
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = gray(settings.bgFar);
    ctx.fillRect(0, 0, worldW, worldH);
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(field, 0, 0, worldW, worldH);

    // ── 调试射线
    if (model.opts.debugRays) {
      const n = model.vis.vertexCount;
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
      for (const rim of collectRimSegments(model, blockFill())) {
        ctx.strokeStyle = `rgb(${toByte(rim.r)},${toByte(rim.g)},${toByte(rim.b)})`;
        ctx.beginPath();
        ctx.moveTo(rim.x0, rim.y0);
        ctx.lineTo(rim.x1, rim.y1);
        ctx.stroke();
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
