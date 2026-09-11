import { Canvas2DRenderer } from './canvas2d-renderer';
import { WebGL2Renderer } from './webgl-renderer';
import type { Renderer } from './types';

export interface RendererHandle {
  renderer: Renderer;
  /** 回退时 canvas 会被换掉，所以要把新的返回给调用方 */
  canvas: HTMLCanvasElement;
}

/**
 * 优先 WebGL2；初始化失败（或被禁用）时换一块新 canvas 走 Canvas2D。
 * 注意：一个 canvas 只能有一种上下文，所以回退必须换元素。
 */
export function createRenderer(canvas: HTMLCanvasElement): RendererHandle {
  try {
    return { renderer: new WebGL2Renderer(canvas), canvas };
  } catch (err) {
    console.warn('[rt2d] WebGL2 初始化失败，回退到 Canvas 2D：', err);
    const replacement = canvas.cloneNode(false) as HTMLCanvasElement;
    canvas.replaceWith(replacement);
    return { renderer: new Canvas2DRenderer(replacement), canvas: replacement };
  }
}

export type { RenderModel, Renderer } from './types';
