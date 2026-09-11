import { THEME } from '../config';
import { MeshBuilder } from './mesh';
import { BG_FRAG, FLAT_FRAG, FLAT_VERT, LIT_FRAG, POS_VERT } from './shaders';
import type { RenderModel, Renderer } from './types';

function compile(gl: WebGL2RenderingContext, type: number, src: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`创建 shader 失败: ${label}`);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader 编译失败 (${label}): ${log}`);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string, label: string): WebGLProgram {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSrc, `${label}.vert`);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSrc, `${label}.frag`);
  const prog = gl.createProgram();
  if (!prog) throw new Error(`创建 program 失败: ${label}`);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`program 链接失败 (${label}): ${log}`);
  }
  return prog;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;

function uniformMap(gl: WebGL2RenderingContext, prog: WebGLProgram, names: readonly string[]): Uniforms {
  const out: Uniforms = {};
  for (const n of names) out[n] = gl.getUniformLocation(prog, n);
  return out;
}

/**
 * WebGL2 后端。
 *
 * 一帧三次 draw：
 *   1. 背景层   —— 全屏辉光（等价于参考图那张「没有光线追踪」的图）
 *   2. 直接光层 —— 可见多边形扇形，叠加混合，按像素距离衰减 ⇒ 硬阴影
 *   3. 叠加层   —— 方块 / 被照亮的棱边 / 调试射线 / 灯泡（线段用三角形拼，避免 lineWidth 失效）
 */
export class WebGL2Renderer implements Renderer {
  readonly backend = 'webgl2' as const;
  readonly detail: string;

  private readonly gl: WebGL2RenderingContext;
  private readonly bgProg: WebGLProgram;
  private readonly litProg: WebGLProgram;
  private readonly flatProg: WebGLProgram;
  private readonly bgU: Uniforms;
  private readonly litU: Uniforms;
  private readonly flatU: Uniforms;
  private readonly quadVao: WebGLVertexArrayObject;
  private readonly quadBuf: WebGLBuffer;
  private readonly quadData = new Float32Array(12);
  private readonly fanVao: WebGLVertexArrayObject;
  private readonly fanBuf: WebGLBuffer;
  private readonly flatVao: WebGLVertexArrayObject;
  private readonly flatBuf: WebGLBuffer;

  private readonly mesh = new MeshBuilder(1 << 16);
  private fan = new Float32Array(1 << 13);
  private fanVerts = 0;
  private alphaVerts = 0;
  private addVerts = 0;

  private pixelW = 1;
  private pixelH = 1;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: true,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 不可用');
    this.gl = gl;

    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const raw = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : (gl.getParameter(gl.RENDERER) as string);
    this.detail = String(raw ?? 'WebGL2');

    this.bgProg = link(gl, POS_VERT, BG_FRAG, 'bg');
    this.litProg = link(gl, POS_VERT, LIT_FRAG, 'lit');
    this.flatProg = link(gl, FLAT_VERT, FLAT_FRAG, 'flat');

    this.bgU = uniformMap(gl, this.bgProg, ['u_world', 'u_light', 'u_bgFar', 'u_glowAmp', 'u_glowRadius', 'u_glowPower', 'u_ambShare']);
    this.litU = uniformMap(gl, this.litProg, ['u_world', 'u_light', 'u_glowAmp', 'u_glowRadius', 'u_glowPower', 'u_directShare']);
    this.flatU = uniformMap(gl, this.flatProg, ['u_world']);

    this.quadVao = gl.createVertexArray()!;
    this.quadBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.quadData, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.fanVao = gl.createVertexArray()!;
    this.fanBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.fanVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.flatVao = gl.createVertexArray()!;
    this.flatBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 24, 8);

    gl.bindVertexArray(null);
  }

  resize(cssW: number, cssH: number, dpr: number): void {
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (w === this.pixelW && h === this.pixelH) return;
    this.pixelW = w;
    this.pixelH = h;
    const canvas = this.gl.canvas as HTMLCanvasElement;
    canvas.width = w;
    canvas.height = h;
  }

  render(model: RenderModel): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.pixelW, this.pixelH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    this.drawBackground(model);
    this.drawLit(model);
    this.drawOverlay(model);
  }

  private drawBackground(model: RenderModel): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.useProgram(this.bgProg);
    gl.uniform2f(this.bgU.u_world, model.worldW, model.worldH);
    gl.uniform2f(this.bgU.u_light, model.light.x, model.light.y);
    gl.uniform1f(this.bgU.u_bgFar, THEME.bgFar);
    gl.uniform1f(this.bgU.u_glowAmp, THEME.glowAmp);
    gl.uniform1f(this.bgU.u_glowRadius, THEME.glowRadius);
    gl.uniform1f(this.bgU.u_glowPower, THEME.glowPower);
    gl.uniform1f(this.bgU.u_ambShare, 1 - THEME.directShare);
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const w = model.worldW;
    const h = model.worldH;
    this.quadData.set([0, 0, w, 0, w, h, 0, 0, w, h, 0, h]);
    gl.bufferData(gl.ARRAY_BUFFER, this.quadData, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private drawLit(model: RenderModel): void {
    const gl = this.gl;
    const n = model.vis.vertexCount;
    if (model.blackout || n < 3) return;

    if (this.fan.length < n * 6) this.fan = new Float32Array(n * 12);
    const poly = model.vis.poly;
    const lx = model.light.x;
    const ly = model.light.y;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      this.fan[k++] = lx;
      this.fan[k++] = ly;
      this.fan[k++] = poly[i * 2];
      this.fan[k++] = poly[i * 2 + 1];
      this.fan[k++] = poly[j * 2];
      this.fan[k++] = poly[j * 2 + 1];
    }
    this.fanVerts = k / 2;

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE, gl.ZERO, gl.ONE);
    gl.useProgram(this.litProg);
    gl.uniform2f(this.litU.u_world, model.worldW, model.worldH);
    gl.uniform2f(this.litU.u_light, lx, ly);
    gl.uniform1f(this.litU.u_glowAmp, THEME.glowAmp);
    gl.uniform1f(this.litU.u_glowRadius, THEME.glowRadius);
    gl.uniform1f(this.litU.u_glowPower, THEME.glowPower);
    gl.uniform1f(this.litU.u_directShare, THEME.directShare);
    gl.bindVertexArray(this.fanVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.fan.subarray(0, this.fanVerts * 2), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, this.fanVerts);
  }

  private drawOverlay(model: RenderModel): void {
    const gl = this.gl;
    this.buildOverlay(model);
    if (this.mesh.n === 0) return;

    gl.useProgram(this.flatProg);
    gl.uniform2f(this.flatU.u_world, model.worldW, model.worldH);
    gl.bindVertexArray(this.flatVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.view(), gl.DYNAMIC_DRAW);

    // 普通 alpha 部分：调试射线 / 方块 / 棱边高光
    if (this.alphaVerts > 0) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, this.alphaVerts);
    }
    // 叠加部分：灯泡与外晕（src * srcAlpha + dst，即带 alpha 的加色）
    if (this.addVerts > 0) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, this.alphaVerts, this.addVerts);
    }
  }

  private buildOverlay(model: RenderModel): void {
    const m = this.mesh;
    const o = model.opts;
    const light = model.light;
    m.reset();

    // ── 调试射线：光源 → 每一个可见多边形顶点（可以看到射线正好钉在角点上）
    if (o.debugRays) {
      const w = 0.5 * model.pxScale;
      const poly = model.vis.poly;
      const n = model.vis.vertexCount;
      for (let i = 0; i < n; i++) {
        m.thickLine(light.x, light.y, poly[i * 2], poly[i * 2 + 1], w, 1, 0.87, 0.6, 0.22);
      }
    }

    // ── 方块本体 + 被照亮的棱边
    if (o.showBlocks) {
      const [fr, fg, fb] = THEME.blockFill;
      const count = model.instanceCount;
      for (let i = 0; i < count; i++) {
        const inst = model.instances[i];
        m.rect(inst.x, inst.y, inst.w, inst.h, fr, fg, fb, 1);
      }
      const halfWidth = 0.85 * model.pxScale;
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
            const dx = x1 - x0;
            const dy = y1 - y0;
            const len = Math.hypot(dx, dy);
            if (len < 0.5) continue;
            // 这一小段棱边朝向光源的程度
            const mx = (x0 + x1) * 0.5 - light.x;
            const my = (y0 + y1) * 0.5 - light.y;
            const dist = Math.hypot(mx, my) || 1;
            const ndotl = Math.max(0, (-mx * seg.nx - my * seg.ny) / dist);
            const k = THEME.rimStrength * (0.3 + 0.7 * ndotl);
            m.thickLine(x0, y0, x1, y1, halfWidth, fr + (1 - fr) * k, fg + (1 - fg) * k, fb + (1 - fb) * k, 1);
          }
        }
      }
    }
    this.alphaVerts = m.vertexCount;

    // ── 灯泡：实心白点 + 柔和外晕（叠加混合）
    m.disc(
      light.x,
      light.y,
      THEME.lightStops.map(([r, a]) => [r, 1, 1, 1, a]),
    );
    this.addVerts = m.vertexCount - this.alphaVerts;
    if (model.opts.debugRays) {
      // 射线端点上再点一个小亮点，强调「钉在角点」
      const poly = model.vis.poly;
      const n = model.vis.vertexCount;
      for (let i = 0; i < n; i++) {
        m.disc(poly[i * 2], poly[i * 2 + 1], [
          [0, 1, 0.9, 0.6, 0.95],
          [2.2 * model.pxScale, 1, 0.9, 0.6, 0],
        ], 12);
      }
      this.addVerts = m.vertexCount - this.alphaVerts;
    }
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteProgram(this.bgProg);
    gl.deleteProgram(this.litProg);
    gl.deleteProgram(this.flatProg);
    gl.deleteBuffer(this.quadBuf);
    gl.deleteBuffer(this.fanBuf);
    gl.deleteBuffer(this.flatBuf);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteVertexArray(this.fanVao);
    gl.deleteVertexArray(this.flatVao);
  }
}
