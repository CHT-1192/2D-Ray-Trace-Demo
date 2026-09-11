import { umbraQuad } from '../core/shadow';
import { blockFill, bulbStops, settings } from '../settings';
import { MeshBuilder } from './mesh';
import { BG_FRAG, FLAT_FRAG, FLAT_VERT, LIT_FRAG, POS_VERT, SHADOW_FRAG } from './shaders';
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

  private readonly shadowProg: WebGLProgram;
  private readonly shadowU: Uniforms;
  private countFbo: WebGLFramebuffer | null = null;
  private countTex: WebGLTexture | null = null;

  private readonly mesh = new MeshBuilder(1 << 16);
  private fan = new Float32Array(1 << 13);
  private fanVerts = 0;
  /** mesh 里本影四边形的顶点数（最前面这段） */
  private umbraVerts = 0;
  /** 叠加层在 mesh 里的起点与两段长度 */
  private overlayStart = 0;
  private alphaVerts = 0;
  private addVerts = 0;
  private readonly umbra = [0, 0, 0, 0, 0, 0, 0, 0];

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
    this.shadowProg = link(gl, POS_VERT, SHADOW_FRAG, 'shadow');

    this.bgU = uniformMap(gl, this.bgProg, ['u_world', 'u_light', 'u_bgFar', 'u_glowAmp', 'u_glowRadius', 'u_glowPower', 'u_ambShare']);
    this.litU = uniformMap(gl, this.litProg, ['u_world', 'u_light', 'u_glowAmp', 'u_glowRadius', 'u_glowPower', 'u_directShare']);
    this.flatU = uniformMap(gl, this.flatProg, ['u_world']);
    this.shadowU = uniformMap(gl, this.shadowProg, [
      'u_world',
      'u_light',
      'u_count',
      'u_glowAmp',
      'u_glowRadius',
      'u_glowPower',
      'u_directShare',
      'u_bgFar',
    ]);

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
    this.resizeCountTarget(w, h);
  }

  /** 离屏「遮挡计数」纹理：每个方块的本影往里加 1/16，最多记到 16 个遮挡物。 */
  private resizeCountTarget(w: number, h: number): void {
    const gl = this.gl;
    if (!this.countTex) this.countTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.countTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    if (!this.countFbo) this.countFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.countFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.countTex, 0);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) {
      // 极端情况下（纹理分配失败）就退回「单一阴影」的老样子
      gl.deleteFramebuffer(this.countFbo);
      gl.deleteTexture(this.countTex);
      this.countFbo = null;
      this.countTex = null;
    }
  }

  render(model: RenderModel): void {
    const gl = this.gl;
    gl.viewport(0, 0, this.pixelW, this.pixelH);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);

    // 几何先全部组装好：mesh = [本影四边形…][叠加层 …]
    this.mesh.reset();
    this.buildUmbras(model);
    this.umbraVerts = this.mesh.vertexCount;
    this.overlayStart = this.umbraVerts;
    this.buildOverlay(model);

    // 先把本影画进离屏计数纹理，再画主画面，最后按计数把重叠阴影压暗
    this.drawCountPass(model);
    this.drawBackground(model);
    this.drawLit(model);
    this.drawShadowCorrection(model);
    this.drawOverlay(model);
  }

  /** 每个方块的本影四边形（近端两个剪影角点 + 向外延伸的远端）。 */
  private buildUmbras(model: RenderModel): void {
    if (!this.countTex || model.blackout) return;
    const m = this.mesh;
    // 每个本影给计数纹理加 1/16，16 个遮挡物封顶
    const step = 1 / 16;
    const far = 4000;
    for (let i = 0; i < model.instanceCount; i++) {
      const inst = model.instances[i];
      if (!umbraQuad(inst, model.segments, model.light.x, model.light.y, far, this.umbra)) continue;
      const q = this.umbra;
      m.tri(q[0], q[1], q[2], q[3], q[4], q[5], step, 0, 0, 0);
      m.tri(q[0], q[1], q[4], q[5], q[6], q[7], step, 0, 0, 0);
    }
  }

  /** 把本影写进离屏纹理：叠加混合 ⇒ 每个像素记录的 R 就是遮挡物数量。 */
  private drawCountPass(model: RenderModel): void {
    const gl = this.gl;
    if (!this.countFbo) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.countFbo);
    gl.viewport(0, 0, this.pixelW, this.pixelH);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 注意：无论有没有本影都要上传 —— 叠加层复用同一份缓冲，
    // 漏上传的话叠加层会拿上一帧的旧数据画（表现为"光源埋在方块里时画面冻住"）。
    this.uploadMesh();
    if (this.umbraVerts > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.flatProg);
      gl.uniform2f(this.flatU.u_world, model.worldW, model.worldH);
      gl.bindVertexArray(this.flatVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.umbraVerts);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.pixelW, this.pixelH);
  }

  /** 多重阴影：按「被几个方块挡住」把重叠区域压暗（n ≤ 1 时不动，保持原观感）。 */
  private drawShadowCorrection(model: RenderModel): void {
    const gl = this.gl;
    if (!this.countTex || model.blackout) return;
    // dst ← dst·(1 - src)：定点帧缓冲上唯一能"减"的办法（源色会被钳到 [0,1]）
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_COLOR, gl.ZERO, gl.ONE);
    gl.useProgram(this.shadowProg);
    gl.uniform2f(this.shadowU.u_world, model.worldW, model.worldH);
    gl.uniform2f(this.shadowU.u_light, model.light.x, model.light.y);
    gl.uniform1f(this.shadowU.u_glowAmp, settings.glowAmp);
    gl.uniform1f(this.shadowU.u_glowRadius, settings.glowRadius);
    gl.uniform1f(this.shadowU.u_glowPower, settings.glowPower);
    gl.uniform1f(this.shadowU.u_directShare, settings.directShare);
    gl.uniform1f(this.shadowU.u_bgFar, settings.bgFar);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.countTex);
    gl.uniform1i(this.shadowU.u_count, 0);
    gl.bindVertexArray(this.quadVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuf);
    const w = model.worldW;
    const h = model.worldH;
    this.quadData.set([0, 0, w, 0, w, h, 0, 0, w, h, 0, h]);
    gl.bufferData(gl.ARRAY_BUFFER, this.quadData, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  private uploadMesh(): void {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.flatBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.mesh.view(), gl.DYNAMIC_DRAW);
  }

  private drawBackground(model: RenderModel): void {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    gl.useProgram(this.bgProg);
    gl.uniform2f(this.bgU.u_world, model.worldW, model.worldH);
    gl.uniform2f(this.bgU.u_light, model.light.x, model.light.y);
    gl.uniform1f(this.bgU.u_bgFar, settings.bgFar);
    gl.uniform1f(this.bgU.u_glowAmp, settings.glowAmp);
    gl.uniform1f(this.bgU.u_glowRadius, settings.glowRadius);
    gl.uniform1f(this.bgU.u_glowPower, settings.glowPower);
    gl.uniform1f(this.bgU.u_ambShare, 1 - settings.directShare);
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
    gl.uniform1f(this.litU.u_glowAmp, settings.glowAmp);
    gl.uniform1f(this.litU.u_glowRadius, settings.glowRadius);
    gl.uniform1f(this.litU.u_glowPower, settings.glowPower);
    gl.uniform1f(this.litU.u_directShare, settings.directShare);
    gl.bindVertexArray(this.fanVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fanBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.fan.subarray(0, this.fanVerts * 2), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, this.fanVerts);
  }

  private drawOverlay(model: RenderModel): void {
    const gl = this.gl;
    this.buildOverlay(model);
    if (this.mesh.n === 0) return;

    if (!this.countFbo) this.uploadMesh();

    gl.useProgram(this.flatProg);
    gl.uniform2f(this.flatU.u_world, model.worldW, model.worldH);
    gl.bindVertexArray(this.flatVao);

    // 普通 alpha 部分：调试射线 / 方块 / 棱边高光
    if (this.alphaVerts > 0) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, this.overlayStart, this.alphaVerts);
    }
    // 叠加部分：灯泡与外晕（src * srcAlpha + dst，即带 alpha 的加色）
    if (this.addVerts > 0) {
      gl.enable(gl.BLEND);
      gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ZERO, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, this.overlayStart + this.alphaVerts, this.addVerts);
    }
  }

  private buildOverlay(model: RenderModel): void {
    const m = this.mesh;
    const o = model.opts;
    const light = model.light;
    const start = m.vertexCount;

    // ── 调试射线：光源 → 每一个可见多边形顶点（可以看到射线正好钉在角点上）
    if (o.debugRays) {
      const w = settings.rayWidth * model.pxScale;
      const poly = model.vis.poly;
      const n = model.vis.vertexCount;
      for (let i = 0; i < n; i++) {
        m.thickLine(light.x, light.y, poly[i * 2], poly[i * 2 + 1], w, 1, 0.87, 0.6, 0.22);
      }
    }

    // ── 方块本体 + 被照亮的棱边
    if (o.showBlocks) {
      const [fr, fg, fb] = blockFill();
      const count = model.instanceCount;
      for (let i = 0; i < count; i++) {
        const inst = model.instances[i];
        m.rect(inst.x, inst.y, inst.w, inst.h, fr, fg, fb, 1);
      }
      const halfWidth = settings.rimWidth * model.pxScale;
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
            const k = settings.rimStrength * (0.3 + 0.7 * ndotl);
            m.thickLine(x0, y0, x1, y1, halfWidth, fr + (1 - fr) * k, fg + (1 - fg) * k, fb + (1 - fb) * k, 1);
          }
        }
      }
    }
    this.alphaVerts = m.vertexCount - start;

    // ── 灯泡：实心白点 + 柔和外晕（叠加混合）
    m.disc(light.x, light.y, bulbStops());
    this.addVerts = m.vertexCount - start - this.alphaVerts;
    if (model.opts.debugRays) {
      // 射线端点上再点一个小亮点，强调「钉在角点」
      const poly = model.vis.poly;
      const n = model.vis.vertexCount;
      for (let i = 0; i < n; i++) {
        m.disc(poly[i * 2], poly[i * 2 + 1], [
          [0, 1, 0.9, 0.6, 0.95],
          [settings.dotRadius * model.pxScale, 1, 0.9, 0.6, 0],
        ], 12);
      }
      this.addVerts = m.vertexCount - start - this.alphaVerts;
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
    if (this.countFbo) gl.deleteFramebuffer(this.countFbo);
    if (this.countTex) gl.deleteTexture(this.countTex);
    gl.deleteProgram(this.shadowProg);
    gl.deleteVertexArray(this.quadVao);
    gl.deleteVertexArray(this.fanVao);
    gl.deleteVertexArray(this.flatVao);
  }
}
