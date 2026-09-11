import { DEFAULT_SEED, REF_H, REF_W, WORLD_H } from '../config';
import { settings, sampleSize } from '../settings';
import { BANDS, makeRng, rectsOverlap } from './layout';
import { mixSeed } from './math';
import { makeSegment, pointInRect, setSegment, type Segment } from './segment';

/**
 * 方块（参考坐标系 1200×685）：位置固定不动，动的是相机。
 * 屏幕坐标 = (x + scrollX) * scaleX —— 相机向左走，于是方块在画面上自左向右平移。
 * 可见窗口在世界坐标里是 [-scrollX, -scrollX + REF_W]，新方块在窗口左侧生成。
 */
export interface Block {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一个可见的方块（屏幕坐标）。 */
export interface BlockInstance {
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 四条边在 segments 池里的下标：0 上 / 1 右 / 2 下 / 3 左 */
  segIds: [number, number, number, number];
}

function makeInstance(): BlockInstance {
  return { id: 0, x: 0, y: 0, w: 0, h: 0, segIds: [-1, -1, -1, -1] };
}

/** 在可见窗口左边多远之外生成（保证新方块出现时完全在屏幕外）。 */
const SPAWN_MARGIN = 280;
/** 在右边多远之外回收（同样保证消失时看不见）。 */
const CULL_MARGIN = 120;
/**
 * 场景：一条不断向远处延伸的滚动条带。
 *
 * 方块由程序化生成器在窗口左侧之外产生（尺寸从参考图拟合出的分布里采样，
 * 位置在上下两条带内随机），随相机推进进入视野、滚出右侧后被回收。
 *
 * ## 可复现性
 * 两条放置带各有**独立**的随机数流，由 `mixSeed(seed, bandIndex)` 派生。
 * 因此「这条带这一帧要生成几个方块」不会影响另一条带的序列 ——
 * 换句话说，给定种子后，方块序列只与**滚动距离**有关，
 * 与帧率、步长、掉帧都无关：同种子 + 同滚动距离 ⇒ 完全相同的一批方块。
 *
 * 硬约束：任意时刻方块两两不重叠（带间 y 不相交；带内生成时做碰撞检测），
 * 这正是可见性算法「一个角区间内遮挡者唯一」的前提。
 */
export class Scene {
  /** 屏幕（世界）尺寸 */
  worldW = REF_W;
  worldH = WORLD_H;
  /** 相机走过的距离（参考单位）；可见窗口在世界坐标里是 [-scrollX, -scrollX + REF_W] */
  scrollX = 0;
  /** 当前世界种子 */
  seed = DEFAULT_SEED;
  /** 灯泡位置（屏幕坐标），固定在画面中心偏上 */
  light = { x: REF_W / 2, y: (REF_H * 325) / 685 };
  /** 灯泡被方块压住 → 整个房间全黑 */
  lightOccluded = false;

  readonly blocks: Block[] = [];
  /** 本帧可见的方块（屏幕坐标） */
  readonly instances: BlockInstance[] = [];
  /** 线段池：只增长、原地重写，配合 segmentCount 使用 */
  readonly segments: Segment[] = [];
  segmentCount = 0;
  /** 累计生成过的方块数 */
  spawned = 0;

  /** 每条放置带一条独立随机流 */
  private bandRng: Array<() => number> = [];
  /** 每条带下一次生成的位置（参考单位，代表下一个方块的右边界） */
  private cursors: number[] = [];
  private nextId = 0;
  private instanceCount = 0;

  constructor() {
    this.generate(DEFAULT_SEED);
  }

  /**
   * 用给定种子重建整个世界。同一个 seed 永远得到同一个世界，
   * 且与调用时机、帧率无关。
   */
  generate(seed: number): void {
    this.seed = seed | 0;
    this.bandRng = BANDS.map((_, i) => makeRng(mixSeed(this.seed, i)));
    this.blocks.length = 0;
    this.nextId = 0;
    this.spawned = 0;
    this.scrollX = 0;
    this.cursors = BANDS.map(() => REF_W);
    this.spawn();
    this.rebuild();
  }

  resize(w: number, h: number): void {
    this.worldW = w;
    this.worldH = h;
    this.light.x = w * settings.lightX;
    this.light.y = h * settings.lightY;
  }

  /** 推进相机并维护方块条带。 */
  update(dtSeconds: number, speed: number): void {
    this.scrollX += speed * dtSeconds;
    this.spawn();
    this.cull();
    this.rebuild();
  }

  /**
   * 在可见窗口左侧补齐方块，直到越过生成地平线。
   * 光标代表「下一个方块的右边界」，一路向左推进。
   */
  private spawn(): void {
    const edge = -this.scrollX; // 可见窗口左边界（世界坐标）
    const horizon = edge - SPAWN_MARGIN;
    for (let i = 0; i < BANDS.length; i++) {
      const band = BANDS[i];
      const rng = this.bandRng[i];
      let cursor = this.cursors[i];
      let guard = 0;
      while (cursor > horizon && guard++ < 128) {
        const size = sampleSize(rng);
        const h = Math.min(size.h, band.h - 8);
        const x = cursor - size.w;
        const y = this.pickY(x, size.w, h, band, rng);
        if (y < 0) {
          cursor -= 48; // 这段挤不下，往左挪一点再试
          continue;
        }
        this.blocks.push({ id: this.nextId++, x, y, w: size.w, h });
        this.spawned++;
        // 横向步进：有时故意小于自身宽度，允许同带内 x 方向部分重叠（靠 y 错开），
        // 这样疏密更接近参考图，而不是整齐排队。
        const t = Math.min(0.95, Math.max(0, settings.overlap));
        cursor -= size.w * (t + (1 - t) * rng()) + settings.gap + rng() * settings.stepSpread;
      }
      this.cursors[i] = cursor;
    }
  }

  /** 在带内挑一个不与他人重叠的 y；挑不到返回 -1。 */
  private pickY(x: number, w: number, h: number, band: { y: number; h: number }, rng: () => number): number {
    const yMin = band.y;
    const yMax = band.y + band.h - h;
    if (yMax < yMin) return -1;
    const candidate = { x, y: 0, w, h };
    for (let attempt = 0; attempt < 14; attempt++) {
      const y = yMin + rng() * (yMax - yMin);
      candidate.y = y;
      if (!this.collides(candidate)) return y;
    }
    // 随机没撞上就退化成细网格扫描
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const y = yMin + ((yMax - yMin) * i) / steps;
      candidate.y = y;
      if (!this.collides(candidate)) return y;
    }
    return -1;
  }

  private collides(candidate: { x: number; y: number; w: number; h: number }): boolean {
    for (let i = 0; i < this.blocks.length; i++) {
      if (rectsOverlap(candidate, this.blocks[i], settings.gap)) return true;
    }
    return false;
  }

  /** 回收已经滚出右边界的方块。 */
  private cull(): void {
    const right = -this.scrollX + REF_W + CULL_MARGIN;
    let k = 0;
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      if (b.x > right) continue;
      this.blocks[k++] = b;
    }
    this.blocks.length = k;
  }

  /** 把参考坐标的方块换算成屏幕坐标，重建本帧几何。 */
  rebuild(): void {
    const sx = this.worldW / REF_W;
    const sy = this.worldH / REF_H;
    this.instanceCount = 0;
    this.segmentCount = 0;
    this.lightOccluded = false;

    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const x = (b.x + this.scrollX) * sx;
      const w = b.w * sx;
      // 完全在屏幕外的方块不可能影响到画面：灯泡在画面中间，
      // 右侧方块的阴影只会更靠右，左侧同理 —— 所以可以安全剔除。
      if (x + w < -2 || x > this.worldW + 2) continue;
      this.emitBlock(i, x, b.y * sy, w, b.h * sy);
    }

    this.emitWalls();
  }

  /** 点 (x,y)（屏幕坐标）是否被某个方块盖住 —— 光源埋进方块时整个房间全黑。 */
  occludedAt(x: number, y: number): boolean {
    for (let i = 0; i < this.instanceCount; i++) {
      const inst = this.instances[i];
      if (pointInRect(x, y, inst.x, inst.y, inst.w, inst.h)) return true;
    }
    return false;
  }

  get visibleInstanceCount(): number {
    return this.instanceCount;
  }

  private emitBlock(id: number, x: number, y: number, w: number, h: number): void {
    let inst = this.instances[this.instanceCount];
    if (!inst) {
      inst = makeInstance();
      this.instances[this.instanceCount] = inst;
    }
    this.instanceCount++;
    inst.id = id;
    inst.x = x;
    inst.y = y;
    inst.w = w;
    inst.h = h;

    // 四条边，法线一律朝外（用于棱边受光）
    inst.segIds[0] = this.emitSegment(x, y, x + w, y, 0, -1, id, 0);
    inst.segIds[1] = this.emitSegment(x + w, y, x + w, y + h, 1, 0, id, 1);
    inst.segIds[2] = this.emitSegment(x + w, y + h, x, y + h, 0, 1, id, 2);
    inst.segIds[3] = this.emitSegment(x, y + h, x, y, -1, 0, id, 3);

    if (!this.lightOccluded && pointInRect(this.light.x, this.light.y, x, y, w, h)) this.lightOccluded = true;
  }

  private emitSegment(ax: number, ay: number, bx: number, by: number, nx: number, ny: number, owner: number, edge: number): number {
    const index = this.segmentCount++;
    let seg = this.segments[index];
    if (!seg) {
      seg = makeSegment(index);
      this.segments[index] = seg;
    }
    setSegment(seg, ax, ay, bx, by, nx, ny, owner, edge);
    return index;
  }

  /** 视口外的「外墙」：给逃逸的射线一个兜底，保证可见多边形永远闭合。 */
  private emitWalls(): void {
    const m = settings.wallMargin;
    const w = this.worldW;
    const h = this.worldH;
    this.emitSegment(-m, -m, w + m, -m, 0, -1, -1, -1);
    this.emitSegment(w + m, -m, w + m, h + m, 1, 0, -1, -1);
    this.emitSegment(w + m, h + m, -m, h + m, 0, 1, -1, -1);
    this.emitSegment(-m, h + m, -m, -m, -1, 0, -1, -1);
  }
}
