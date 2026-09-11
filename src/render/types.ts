import type { Options } from '../config';
import type { BlockInstance } from '../core/scene';
import type { Segment } from '../core/segment';
import type { Visibility } from '../core/visibility';

/** 渲染器需要知道的全部信息（两个后端共用同一份，保证画面一致）。 */
export interface RenderModel {
  /** 世界尺寸（高度恒为 685，宽度随视口宽高比） */
  worldW: number;
  worldH: number;
  /** 1 CSS 像素等于多少世界单位（用于线宽/灯泡半径） */
  pxScale: number;
  light: { x: number; y: number };
  /** 本帧有效的方块副本（前面的 instanceCount 个） */
  instances: readonly BlockInstance[];
  instanceCount: number;
  segments: readonly Segment[];
  segmentCount: number;
  vis: Visibility;
  opts: Options;
  /** 光源被方块压住 */
  blackout: boolean;
}

export interface Renderer {
  readonly backend: 'webgl2' | 'canvas2d';
  /** 给 HUD 显示的后端细节（GPU 名称等） */
  readonly detail: string;
  resize(cssW: number, cssH: number, dpr: number): void;
  render(model: RenderModel): void;
  dispose(): void;
}
