/**
 * 核心几何 / 可见性 / 生成器的自检（不依赖浏览器，Node 里跑）。
 *
 * 关键思路：用一个「独立实现」当裁判 —— 以极密的角步长直接扫一圈求出可见面积，
 * 再和可见多边形的面积对比。精确锁定边缘应该能贴到裁判值，均匀 360 条则会被甩开。
 */
import { DEFAULT_OPTIONS, REF_H, REF_W, type Options } from '../src/config';
import {
  BANDS,
  REFERENCE_BLOCKS,
  SIZE_CLASSES,
  layoutIsDisjoint,
  rectsOverlap,
  type Rect,
} from '../src/core/layout';
import { settings, blockFill, sampleSize, type Settings } from '../src/settings';
import { makeRng } from '../src/core/math';
import { Scene } from '../src/core/scene';
import { makeRayHit, rayCast, type Segment } from '../src/core/segment';
import { Visibility, VisibilityEngine } from '../src/core/visibility';
import { collectRimSegments, glowFalloff, rimFactor } from '../src/render/rim';
import { check, near, section, summary } from './harness';

/** 测试自己用固定种子，跟产品行为（首次加载随机）无关 */
const TEST_SEED = 20260910;

const engine = new VisibilityEngine();
const vis = new Visibility();

function makeScene(rects?: readonly Rect[], lx = 600, ly = 325): Scene {
  const scene = new Scene();
  scene.resize(REF_W, REF_H);
  scene.generate(TEST_SEED);
  if (rects) {
    scene.blocks.length = 0;
    rects.forEach((r, i) => scene.blocks.push({ id: i, ...r }));
  }
  scene.light.x = lx;
  scene.light.y = ly;
  scene.scrollX = 0;
  scene.rebuild();
  return scene;
}

function opts(mode: Options['mode'], extra: Partial<Options> = {}): Options {
  return { ...DEFAULT_OPTIONS, mode, ...extra };
}

/** 多边形面积：关于光源星形 ⇒ 直接按三角形求和（叉积）。 */
function polygonArea(poly: readonly number[], lx: number, ly: number): number {
  let area = 0;
  const n = poly.length >> 1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[i * 2] - lx;
    const ay = poly[i * 2 + 1] - ly;
    const bx = poly[j * 2] - lx;
    const by = poly[j * 2 + 1] - ly;
    area += ax * by - ay * bx;
  }
  return Math.abs(area) * 0.5;
}

/** 裁判：极密角度扫描求可见面积 ∫½r²dθ（和被测实现完全独立的算法）。 */
function sweepArea(segments: readonly Segment[], count: number, lx: number, ly: number, steps = 400000): number {
  const hit = makeRayHit();
  const dTheta = (Math.PI * 2) / steps;
  let area = 0;
  for (let i = 0; i < steps; i++) {
    const a = i * dTheta;
    if (!rayCast(segments, count, lx, ly, Math.cos(a), Math.sin(a), hit)) continue;
    area += 0.5 * hit.t * hit.t * dTheta;
  }
  return area;
}

function hasVertex(poly: readonly number[], x: number, y: number, tol = 1e-9): boolean {
  for (let i = 0; i < poly.length; i += 2) {
    if (Math.abs(poly[i] - x) <= tol && Math.abs(poly[i + 1] - y) <= tol) return true;
  }
  return false;
}

const quantile = (sorted: number[], p: number): number => {
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

// ─────────────────────────────────────────────────────────────────────────────

section('1. 参考图布局与推导出来的参数');
check('16 个参考方块两两不重叠', layoutIsDisjoint(REFERENCE_BLOCKS), `${REFERENCE_BLOCKS.length} 个`);
{
  const inBands = REFERENCE_BLOCKS.every((b) => BANDS.some((band) => b.y >= band.y && b.y + b.h <= band.y + band.h));
  check('放置带（由参考图聚类推导）完整覆盖全部参考方块', inBands, BANDS.map((b) => `y∈[${b.y},${b.y + b.h}]`).join(' '));
  const disjoint = BANDS.every((a, i) => BANDS.every((b, j) => i === j || a.y + a.h <= b.y || b.y + b.h <= a.y));
  check('带与带的 y 区间不重叠（跨带永不碰撞）', disjoint);
  const lightY = 325;
  const clear = BANDS.every((b) => lightY < b.y || lightY > b.y + b.h);
  check('灯泡所在的横带是空的（和参考图一样不会被压住）', clear);
}

section('2. 尺寸是「按分布生成」而不是查表');
{
  const rng = makeRng(20260911);
  const N = 20000;
  const ws: number[] = [];
  const hs: number[] = [];
  const aspects: number[] = [];
  for (let i = 0; i < N; i++) {
    const s = sampleSize(rng);
    ws.push(s.w);
    hs.push(s.h);
    aspects.push(s.w / s.h);
  }
  const sw = [...ws].sort((a, b) => a - b);
  const sa = [...aspects].sort((a, b) => a - b);
  const q = (arr: number[], p: number) => quantile(arr, p);

  // 参考图实测：width p25=140 p50=146 p75=204 / aspect 中位数 1.66
  check(
    '宽度分位数与参考图同量级',
    Math.abs(q(sw, 0.25) - 140) < 30 && Math.abs(q(sw, 0.5) - 146) < 30 && Math.abs(q(sw, 0.75) - 204) < 35,
    `p25=${q(sw, 0.25).toFixed(0)} p50=${q(sw, 0.5).toFixed(0)} p75=${q(sw, 0.75).toFixed(0)}（参考 140/146/204）`,
  );
  check('长宽比中位数贴合参考图的 1.66', Math.abs(q(sa, 0.5) - 1.66) < 0.15, `实测中位数 ${q(sa, 0.5).toFixed(2)}`);

  const uniqueW = new Set(ws).size;
  check(
    '宽度取值远多于参考图的 16 种（三档整数区间合计 ≈129 种，均匀铺满）',
    uniqueW > 110,
    `${uniqueW} 种不同宽度（参考图 16 种）`,
  );

  const refWidths = REFERENCE_BLOCKS.map((b) => b.w);
  const novel = ws.filter((w) => !refWidths.some((r) => Math.abs(r - w) <= 1)).length / N;
  check('绝大多数样本的宽度不等于参考图里任何一个值', novel > 0.7, `${(novel * 100).toFixed(1)}% 是新尺寸`);

  const counts = [0, 0, 0];
  for (const w of ws) {
    const idx = SIZE_CLASSES.findIndex((c) => w >= c.min && w <= c.max);
    if (idx >= 0) counts[idx]++;
  }
  const ratios = counts.map((c) => c / N);
  const want = SIZE_CLASSES.map((c) => c.weight);
  check(
    '三档权重与参考图的 2:8:6 一致',
    ratios.every((r, i) => Math.abs(r - want[i]) < 0.04),
    `实测 ${ratios.map((r) => (r * 100).toFixed(1)).join('/')}% vs 期望 ${want.map((r) => (r * 100).toFixed(0)).join('/')}%`,
  );

  check('高度都落在合理范围内', hs.every((h) => h >= 40 && h <= 160), `[${Math.min(...hs)}, ${Math.max(...hs)}]`);
}

section('3. 精确锁定边缘：顶点必须正好落在角点上');
{
  const scene = makeScene(); // 默认种子生成的世界
  engine.compute(scene.light.x, scene.light.y, scene.segments, scene.segmentCount, opts('exact'), vis);

  const hit = makeRayHit();
  let visible = 0;
  let locked = 0;
  const missed: string[] = [];
  for (let i = 0; i < scene.segmentCount; i++) {
    const s = scene.segments[i];
    for (const [cx, cy] of [
      [s.ax, s.ay],
      [s.bx, s.by],
    ] as [number, number][]) {
      const dx = cx - scene.light.x;
      const dy = cy - scene.light.y;
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      if (!rayCast(scene.segments, scene.segmentCount, scene.light.x, scene.light.y, dx / len, dy / len, hit)) continue;
      if (Math.abs(hit.t - len) > 1e-6) continue; // 被别的线段挡住 ⇒ 该角点不可见
      visible++;
      if (hasVertex(vis.poly, cx, cy, 1e-9)) locked++;
      else missed.push(`(${cx.toFixed(1)}, ${cy.toFixed(1)})`);
    }
  }
  check('所有可见角点都以 0 误差出现在多边形里', locked === visible, `${locked}/${visible}${missed.length ? ` 漏掉: ${missed.slice(0, 4).join(' ')}` : ''}`);
  check(
    '射线数与角点数同阶，远小于 360',
    vis.raysCast > 0 && vis.raysCast < scene.segmentCount * 2,
    `实际投射 ${vis.raysCast} 条 / ${scene.segmentCount} 条线段 / ${vis.vertexCount} 个顶点`,
  );
}

section('4. 每一个多边形顶点的极角都必须正好是某个角点的极角');
{
  const scene = makeScene();
  const cornerAngles: number[] = [];
  for (let i = 0; i < scene.segmentCount; i++) {
    const s = scene.segments[i];
    cornerAngles.push(Math.atan2(s.ay - 325, s.ax - 600), Math.atan2(s.by - 325, s.bx - 600));
  }
  const wrap = (a: number) => {
    const r = a % (Math.PI * 2);
    return r < 0 ? r + Math.PI * 2 : r;
  };
  const looksLikeCorner = (x: number, y: number) => {
    const a = Math.atan2(y - 325, x - 600);
    return cornerAngles.some((c) => {
      const d = wrap(a - c);
      return d < 1e-9 || d > Math.PI * 2 - 1e-9;
    });
  };
  const ratio = (mode: Options['mode'], extra: Partial<Options> = {}) => {
    engine.compute(600, 325, scene.segments, scene.segmentCount, opts(mode, extra), vis);
    let hits = 0;
    for (let i = 0; i < vis.poly.length; i += 2) if (looksLikeCorner(vis.poly[i], vis.poly[i + 1])) hits++;
    return { hits, total: vis.vertexCount, rays: vis.raysCast };
  };

  const e = ratio('exact');
  const u = ratio('uniform', { rayCount: 360 });
  check('exact：100% 顶点钉在角点射线上', e.hits === e.total, `${e.hits}/${e.total}，用了 ${e.rays} 条射线`);
  check('uniform：绝大多数顶点偏离角点射线（阴影边缘落在随机角度上）', u.hits / u.total < 0.2, `${u.hits}/${u.total} 命中，360 条射线`);
}

section('5. 面积精度：与「极密角度扫描」这个独立裁判对比');
{
  const scene = makeScene();
  const total = sweepArea(scene.segments, scene.segmentCount, scene.light.x, scene.light.y);

  engine.compute(scene.light.x, scene.light.y, scene.segments, scene.segmentCount, opts('exact'), vis);
  const areaExact = polygonArea(vis.poly, scene.light.x, scene.light.y);
  const exactErr = Math.abs(areaExact - total) / total;
  const raysExact = vis.raysCast;

  engine.compute(scene.light.x, scene.light.y, scene.segments, scene.segmentCount, opts('uniform', { rayCount: 360 }), vis);
  const areaUniform = polygonArea(vis.poly, scene.light.x, scene.light.y);
  const uniformErr = Math.abs(areaUniform - total) / total;

  engine.compute(scene.light.x, scene.light.y, scene.segments, scene.segmentCount, opts('edge'), vis);
  const areaEdge = polygonArea(vis.poly, scene.light.x, scene.light.y);
  const edgeErr = Math.abs(areaEdge - total) / total;

  console.log(`     裁判面积 = ${total.toFixed(1)} px²`);
  console.log(`     exact   : 面积 ${areaExact.toFixed(1)}  相对误差 ${(exactErr * 100).toFixed(4)}%  射线 ${raysExact}`);
  console.log(`     edge±ε  : 面积 ${areaEdge.toFixed(1)}  相对误差 ${(edgeErr * 100).toFixed(4)}%`);
  console.log(`     uniform : 面积 ${areaUniform.toFixed(1)}  相对误差 ${(uniformErr * 100).toFixed(4)}%  射线 360`);

  check('exact 面积误差 < 0.1%', exactErr < 1e-3, `${(exactErr * 100).toFixed(4)}%`);
  check('exact 比 uniform 更接近裁判', exactErr < uniformErr, `exact ${(exactErr * 100).toFixed(4)}% < uniform ${(uniformErr * 100).toFixed(4)}%`);
}

section('6. 模式行为与遮挡');
{
  const scene = makeScene();
  engine.compute(scene.light.x, scene.light.y, scene.segments, scene.segmentCount, opts('uniform', { rayCount: 360 }), vis);
  const uniformRays = vis.raysCast;
  check('uniform 模式确实投了 360 条', uniformRays === 360, `${uniformRays} 条`);
  engine.compute(scene.light.x, scene.light.y, scene.segments, scene.segmentCount, opts('exact'), vis);
  check('exact 模式只用角点数级别的射线', vis.raysCast < uniformRays / 4, `${vis.raysCast} 条 vs ${uniformRays} 条`);

  const covered = new Scene();
  covered.resize(REF_W, REF_H);
  covered.blocks.length = 0;
  covered.blocks.push({ id: 0, x: 520, y: 260, w: 160, h: 130 });
  covered.rebuild();
  check('光源落在方块内部时被标记为遮挡', covered.occludedAt(600, 325));
  check('光源在方块外时不受影响', !covered.occludedAt(100, 100));
}

section('7. 程序化生成器：长时间运行的硬约束');
{
  const scene = new Scene();
  scene.resize(REF_W, REF_H);
  scene.generate(12345);

  check(
    '生成模式开局就填满了可见窗口',
    scene.blocks.some((b) => b.x >= 0 && b.x + b.w <= REF_W),
    `${scene.blocks.length} 个方块`,
  );

  let overlaps = 0;
  let worstOverlap = '';
  let outOfBounds = 0;
  let maxCount = 0;
  let maxInstance = 0;
  let spawnedLater = 0;
  let spawnedOffscreen = 0;
  let spawnedChecked = 0;
  let lastMaxId = Math.max(...scene.blocks.map((b) => b.id));
  let areaJump = 0;
  let prevArea = -1;
  const dt = 1 / 60;
  const speed = 150;

  // 90 秒 @150 参考单位/秒 ≈ 滚过 11 个屏幕宽
  for (let step = 0; step < 5400; step++) {
    scene.update(dt, speed);

    for (let i = 0; i < scene.blocks.length; i++) {
      const a = scene.blocks[i];
      if (a.y < 0 || a.y + a.h > REF_H) outOfBounds++;
      for (let j = i + 1; j < scene.blocks.length; j++) {
        if (rectsOverlap(a, scene.blocks[j])) {
          overlaps++;
          if (!worstOverlap) worstOverlap = `${JSON.stringify(a)} ∩ ${JSON.stringify(scene.blocks[j])}`;
        }
      }
    }

    // 新生成的方块在出现那一刻必须完全在屏幕右侧之外
    for (const b of scene.blocks) {
      if (b.id > lastMaxId) {
        spawnedLater++;
        spawnedChecked++;
        // 世界坐标的可见窗口是 [-scrollX, -scrollX + REF_W]，新方块必须完全在它左侧
        if (b.x + b.w <= -scene.scrollX) spawnedOffscreen++;
        if (b.id > lastMaxId) lastMaxId = b.id;
      }
    }

    maxCount = Math.max(maxCount, scene.blocks.length);
    maxInstance = Math.max(maxInstance, scene.visibleInstanceCount);

    if (step % 10 === 0) {
      engine.compute(scene.light.x, scene.light.y, scene.segments, scene.segmentCount, opts('exact'), vis);
      const area = polygonArea(vis.poly, scene.light.x, scene.light.y);
      if (prevArea >= 0) areaJump = Math.max(areaJump, Math.abs(area - prevArea));
      prevArea = area;
    }
  }

  check('90 秒内任意时刻方块两两不重叠', overlaps === 0, overlaps ? `${overlaps} 次重叠，例如 ${worstOverlap}` : '0 次');
  check('方块始终在画面高度范围内（不会跑到屏幕上下方）', outOfBounds === 0, `${outOfBounds} 次越界`);
  check('方块数量有界（不会无限增长）', maxCount < 60, `峰值 ${maxCount} 个，同屏最多 ${maxInstance} 个`);
  check('新方块持续生成（不是固定图样循环）', spawnedLater > 100, `90 秒新生成 ${spawnedLater} 个`);
  check('新方块出现时都在屏幕左侧之外（看不见的地方）', spawnedOffscreen === spawnedChecked, `${spawnedOffscreen}/${spawnedChecked}`);
  check('回收后数量回到合理区间', scene.blocks.length < 60 && scene.blocks.length > 4, `当前 ${scene.blocks.length} 个`);
  check('长时间运行中可见面积无跳变', areaJump < 60000, `相邻采样最大变化 ${areaJump.toFixed(0)} px² / 25 单位`);

  const refWidths = REFERENCE_BLOCKS.map((b) => b.w);
  const live = scene.blocks.filter((b) => !refWidths.some((r) => Math.abs(r - b.w) <= 1));
  check(
    '运行一段时间后场上的方块多数是新尺寸',
    live.length >= Math.ceil(scene.blocks.length * 0.6),
    `${live.length}/${scene.blocks.length} 个不是参考图的尺寸`,
  );
}

section('8. 可复现性：同种子 ⇒ 同世界，且与步长无关');
{
  const fingerprint = (scene: Scene) =>
    scene.blocks.map((b) => `${b.id}:${b.x}:${b.y}:${b.w}:${b.h}`).sort().join('|');

  // 8.1 同一个种子连生成两次，逐位一致
  const a = new Scene();
  a.resize(REF_W, REF_H);
  a.generate(4242);
  const fa = fingerprint(a);
  const b = new Scene();
  b.resize(REF_W, REF_H);
  b.generate(4242);
  check('同种子两次生成，方块列表逐位一致', fa === fingerprint(b), `指纹长度 ${fa.length}`);

  // 8.2 中间生成过别的世界，再切回来仍然一致
  b.generate(777);
  const other = fingerprint(b);
  check('不同种子确实生成不同世界', other !== fa, `指纹长度 ${other.length}`);
  b.generate(4242);
  check('切回原种子后与第一次逐位一致', fingerprint(b) === fa);

  // 8.3 关键：同一颗种子 + 相同滚动距离 ⇒ 同一批方块，与步长/帧率无关。
  //     用「记录所有出现过的方块 id」来比较，避免浮点累积差异干扰判定。
  const runWith = (seed: number, dt: number, steps: number, speed: number) => {
    const scene = new Scene();
    scene.resize(REF_W, REF_H);
    scene.generate(seed);
    const seen = new Map<number, string>();
    const collect = () => {
      for (const blk of scene.blocks) seen.set(blk.id, `${blk.x},${blk.y},${blk.w},${blk.h}`);
    };
    collect();
    for (let i = 0; i < steps; i++) {
      scene.update(dt, speed);
      collect();
    }
    return { seen, scrollX: scene.scrollX, spawned: scene.spawned };
  };

  const seconds = 25;
  const speed = 150;
  const coarse = runWith(4242, 1 / 30, seconds * 30, speed);
  const normal = runWith(4242, 1 / 60, seconds * 60, speed);
  const fine = runWith(4242, 1 / 240, seconds * 240, speed);

  const sameSet = (x: Map<number, string>, y: Map<number, string>) => {
    if (x.size !== y.size) return false;
    for (const [k, v] of x) if (y.get(k) !== v) return false;
    return true;
  };
  check(
    '30fps / 60fps / 240fps 跑同样距离，生成的方块完全相同',
    sameSet(coarse.seen, normal.seen) && sameSet(normal.seen, fine.seen),
    `各生成 ${coarse.spawned} / ${normal.spawned} / ${fine.spawned} 个方块`,
  );
  check(
    '不同步长下累计生成数量一致（RNG 消费与帧率解耦）',
    coarse.spawned === normal.spawned && normal.spawned === fine.spawned,
    `${coarse.spawned} = ${normal.spawned} = ${fine.spawned}`,
  );

  // 8.4 不同种子在同一位置不会有相同的方块串
  const seeded = [1, 2, 3, 4, 5].map((s) => {
    const t = new Scene();
    t.resize(REF_W, REF_H);
    t.generate(s);
    return fingerprint(t);
  });
  check('5 个种子给出 5 个不同世界', new Set(seeded).size === 5);

  // 8.5 默认种子可用
  const def = new Scene();
  def.resize(REF_W, REF_H);
  def.generate(TEST_SEED);
  check('生成的世界非空', def.blocks.length > 8, `${def.blocks.length} 个方块，seed=${def.seed}`);
  check('seed 字段与传入值一致', def.seed === TEST_SEED, `${def.seed}`);
}

section('9. 参考图只用于拟合，不再复刻');
{
  const scene = new Scene();
  scene.resize(REF_W, REF_H);
  scene.generate(TEST_SEED);
  const refKeys = new Set(REFERENCE_BLOCKS.map((r) => `${r.x},${r.y},${r.w},${r.h}`));
  const same = scene.blocks.filter((b) => refKeys.has(`${b.x},${b.y},${b.w},${b.h}`));
  check('首帧里没有任何一个方块与参考图那 16 个重合', same.length === 0, `${same.length} 个重合`);

  const refXs = new Set(REFERENCE_BLOCKS.map((r) => r.x));
  const refYs = new Set(REFERENCE_BLOCKS.map((r) => r.y));
  const bothY = scene.blocks.filter((b) => refYs.has(b.y) && refXs.has(b.x));
  check('连「同一个 x 与 y 组合」都不出现', bothY.length === 0, `${bothY.length} 个`);
}

section('10. 棱边高光：四种取光模式');
{
  // 手搭两个方块：迎光棱（右棱）都完整可见，但离光源一近一远。
  // 远的那个特意放高，否则它的右棱会被近的那个挡住（那样就没有高光可测了）。
  const LIGHT = { x: 600, y: 360 };
  const nearRect = { x: 420, y: 300, w: 100, h: 120 }; // 右棱 x=520 ⇒ d=100
  const farRect = { x: 100, y: 20, w: 140, h: 120 };   // 右棱 x=240 ⇒ d≈430
  const scene = makeScene([nearRect, farRect], LIGHT.x, LIGHT.y);
  engine.compute(LIGHT.x, LIGHT.y, scene.segments, scene.segmentCount, opts('exact'), vis);

  // 注意用 visibleInstanceCount：instances 数组是复用的池子，后面还留着上一批世界的残留
  const model = { instanceCount: scene.visibleInstanceCount, instances: scene.instances, segments: scene.segments, vis, light: LIGHT };
  const fill = blockFill();

  /** 某个方块右棱上的亮段（迎光、被照亮的那条） */
  const rimOf = (instIndex: number, mode: Settings['rimLight']) => {
    settings.rimLight = mode;
    const inst = scene.instances[instIndex];
    const rightX = inst.x + inst.w;
    const segs = collectRimSegments(model, fill).filter(
      (s) => Math.abs(s.x0 - rightX) < 1e-6 && Math.abs(s.x1 - rightX) < 1e-6,
    );
    return { inst, segs };
  };

  const savedDir = settings.directShare;
  const savedStrength = settings.rimStrength;
  const savedMode = settings.rimLight;
  settings.rimStrength = 0.46;
  settings.directShare = 0.62;

  /** 亮段中点离光源的距离 */
  const midDist = (rim: { x0: number; y0: number; x1: number; y1: number }) =>
    Math.hypot((rim.x0 + rim.x1) / 2 - LIGHT.x, (rim.y0 + rim.y1) / 2 - LIGHT.y);

  /** 复算某条亮段应当是什么颜色（与实现同一套公式，但读的是它自己的中点/法线） */
  const expected = (seg3: Segment, rim: { x0: number; y0: number; x1: number; y1: number }, mode: Settings['rimLight']) => {
    const mx = (rim.x0 + rim.x1) / 2;
    const my = (rim.y0 + rim.y1) / 2;
    const dist = midDist(rim);
    const ndotl = Math.max(0, (-(mx - LIGHT.x) * seg3.nx - (my - LIGHT.y) * seg3.ny) / dist);
    const k = settings.rimStrength * (0.3 + 0.7 * ndotl) * rimFactor(dist, mode);
    return { lit: fill[0] + (1 - fill[0]) * k, dist };
  };

  const levels: Record<string, { near: number; far: number }> = {};
  const dists: Record<string, number> = {};
  for (const mode of ['flat', 'falloff', 'direct', 'local'] as const) {
    const a = rimOf(0, mode);
    const b = rimOf(1, mode);
    check(`${mode}: 两个方块的迎光棱都被照亮`, a.segs.length >= 1 && b.segs.length >= 1, `${a.segs.length} / ${b.segs.length} 段`);

    // 逐段核对颜色是否就是那个模型算出来的值
    const dir = scene.segments[a.inst.segIds[1]];
    const farSeg = scene.segments[b.inst.segIds[1]];
    const errs = [
      ...a.segs.map((s) => Math.abs(s.r - expected(dir, s, mode).lit)),
      ...b.segs.map((s) => Math.abs(s.r - expected(farSeg, s, mode).lit)),
    ];
    const worst = Math.max(...errs);
    check(`${mode}: 每段颜色都等于模型值`, worst < 1e-12, `最大误差 ${worst.toExponential(2)}`);

    levels[mode] = { near: a.segs[0].r, far: b.segs[0].r };
    dists[mode] = expected(farSeg, b.segs[0], mode).dist;
  }

  // 近的那个棱中点正好在光源水平线上（d=100），远的那个明显更远
  check('两处方块确实一近一远', dists.flat > 300 && dists.flat < 500, `远处亮段中点 d=${dists.flat.toFixed(1)}，近处 d≈100`);

  // flat：同一段棱在不同远近下「朝向因子」相同 ⇒ 颜色必须一致（衰减因子恒为 1）
  const flatNear = rimOf(0, 'flat');
  const flatFar = rimOf(1, 'flat');
  const nearEdgeSeg = scene.segments[flatNear.inst.segIds[1]];
  const farEdgeSeg = scene.segments[flatFar.inst.segIds[1]];
  const ratio = (rim: { x0: number; y0: number; x1: number; y1: number }, seg3: Segment) => {
    const e = expected(seg3, rim, 'flat');
    return (e.lit - fill[0]) / (1 - fill[0]); // 去掉底面后的 k
  };
  const kNear = ratio(flatNear.segs[0], nearEdgeSeg);
  const kFar = ratio(flatFar.segs[0], farEdgeSeg);
  const factorNear = rimFactor(expected(nearEdgeSeg, flatNear.segs[0], 'flat').dist, 'flat');
  const factorFar = rimFactor(expected(farEdgeSeg, flatFar.segs[0], 'flat').dist, 'flat');
  check('flat 模式两处的衰减因子都是 1（与远近无关）', factorNear === 1 && factorFar === 1, `${factorNear} / ${factorFar}`);
  check(
    'flat 模式两处 k 都只由朝向决定（差 ≤ 朝向项）',
    Math.abs(kFar / kNear - 1) < 0.5,
    `k近=${kNear.toFixed(3)} k远=${kFar.toFixed(3)}（朝向因子 ${(0.3 + 0.7 * 1).toFixed(2)} 已计入）`,
  );

  // 其余三档：远处必然更暗，且按 local > falloff > direct 排序
  for (const mode of ['falloff', 'direct', 'local'] as const) {
    check(`${mode}: 远处的棱边更暗`, levels[mode].far < levels[mode].near - 1e-6, `${levels[mode].far.toFixed(4)} < ${levels[mode].near.toFixed(4)}`);
  }
  check(
    '远处亮度排序 local > falloff > direct',
    levels.local.far > levels.falloff.far && levels.falloff.far > levels.direct.far,
    `${levels.local.far.toFixed(4)} > ${levels.falloff.far.toFixed(4)} > ${levels.direct.far.toFixed(4)}`,
  );

  // 三档与「地板亮度曲线」逐项对齐：flat=1，falloff=f，direct=direct·f，local=ds+direct·f
  const dFar = midDist(flatFar.segs[0]);
  const f = glowFalloff(dFar);
  const modelAt = (m: Settings['rimLight']) => expected(farEdgeSeg, flatFar.segs[0], m).lit;
  near('falloff 远处 = 底面 + 衰减·(白 - 底面)', levels.falloff.far, modelAt('falloff'), 1e-12);
  near('direct 远处 = 底面 + 直接光份额·衰减', levels.direct.far, modelAt('direct'), 1e-12);
  near('local 远处 = 底面 + 完整亮度曲线', levels.local.far, modelAt('local'), 1e-12);
  check('三档的亮度差正好由 f 解释', Math.abs(levels.falloff.far - levels.direct.far) > 1e-3 && f > 0 && f < 1, `f(d=${dFar.toFixed(0)})=${f.toFixed(3)}`);

  // 最远处仍有环境光那一份：local 的下限就是 ds
  near('local 在辉光半径之外仍保留环境光份额', rimFactor(1e6, 'local'), 1 - settings.directShare, 1e-12);
  near('falloff / direct 在辉光半径之外归零', rimFactor(settings.glowRadius, 'falloff') + rimFactor(1e6, 'direct'), 0, 1e-12);

  // 强度为 0 时，四档都退化成底色（棱边消失）
  settings.rimStrength = 0;
  const zero = (['flat', 'falloff', 'direct', 'local'] as const).map((m) => rimOf(1, m).segs[0].r);
  check('高光强度为 0 时棱边退化为底色', zero.every((v) => Math.abs(v - fill[0]) < 1e-12), zero.map((v) => v.toFixed(3)).join(' / '));

  settings.rimStrength = savedStrength;
  settings.directShare = savedDir;
  settings.rimLight = savedMode;
}

summary();
