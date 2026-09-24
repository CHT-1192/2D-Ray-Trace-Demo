import { DEFAULT_OPTIONS, WORLD_H, type Options } from './config';
import { randomSeed } from './core/math';
import { Scene } from './core/scene';
import { Visibility, VisibilityEngine } from './core/visibility';
import { createRenderer } from './render';
import { collectRimSegments } from './render/rim';
import type { RenderModel } from './render/types';
import { blockFill, settings, type Settings } from './settings';
import { CostMeter } from './timing';
import { AdvancedPanel } from './ui/advanced-panel';
import { Hud, type Stats } from './ui/hud';
import { attachInput } from './ui/input';

/** 主循环：滚动方块 → 求可见性 → 交给渲染后端。 */
function boot(): void {
  const initialCanvas = document.getElementById('stage');
  const uiRoot = document.getElementById('ui');
  const advRoot = document.getElementById('advanced');
  if (!(initialCanvas instanceof HTMLCanvasElement) || !uiRoot || !advRoot) throw new Error('页面结构不完整');

  const { renderer, canvas } = createRenderer(initialCanvas);
  const scene = new Scene();
  const engine = new VisibilityEngine();
  const vis = new Visibility();
  const opts: Options = { ...DEFAULT_OPTIONS };

  // 可见性求解只有几十微秒，远低于 performance.now() 的 0.1ms 刻度，
  // 所以用批量计时取平均（详见 src/timing.ts）。
  // 闭包里只做和真实帧完全相同的一件事：一次 compute。
  const meterLight = { x: 0, y: 0 };
  const solveMeter = new CostMeter(() => {
    engine.compute(meterLight.x, meterLight.y, scene.segments, scene.segmentCount, opts, vis);
  });

  const pointer = { x: 0.5, y: 0.47, inside: false };
  const stats: Stats = { fps: 0, frameMs: 0, visMs: 0, segments: 0, rays: 0, vertices: 0, instances: 0, blocks: 0 };

  let worldW = 1200;
  let worldH = WORLD_H;
  let pxScale = 1;
  let dpr = 1;
  let lastDpr = 0;

  /** 复现入口：URL 里带 #seed=… 就用它；没有就随机一颗（下面会立刻写回地址栏） */
  const readSeedFromUrl = (): number | null => {
    const m = /(?:^|[#&])seed=(-?\d+)/.exec(location.hash);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? Math.trunc(v) | 0 : null;
  };
  const writeSeedToUrl = (value: number): void => {
    try {
      history.replaceState(null, '', `#seed=${value}`);
    } catch {
      /* file:// 下可能被拒绝，忽略即可 */
    }
  };


  const hud = new Hud(uiRoot, opts, {
    onMode(mode) {
      opts.mode = mode;
      solveMeter.invalidate();
      hud.sync();
    },
    onSpeed(v) {
      opts.speed = v;
      hud.sync();
    },
    onRayCount(v) {
      opts.rayCount = v;
      solveMeter.invalidate();
      hud.sync();
    },
    onEpsilon(v) {
      opts.edgeEpsilon = v;
      solveMeter.invalidate();
      hud.sync();
    },
    onFlag(key, value) {
      opts[key] = value;
      hud.sync();
    },
    onSeed(value) {
      applySeed(value);
    },
    onRandomSeed() {
      applySeed(randomSeed());
    },
    onToggleAdvanced() {
      advanced.toggle();
    },
    onToggleHud() {
      hud.toggle();
    },
  });

  const advanced = new AdvancedPanel(advRoot, {
    onChange(key: keyof Settings) {
      // 光源位置变了要重算光照几何；其余参数渲染时每帧现读，改完即生效
      if (key === 'lightX' || key === 'lightY' || key === 'wallMargin') relayout();
      solveMeter.invalidate();
    },
    onReset() {
      relayout();
      solveMeter.invalidate();
    },
    onClose() {
      advanced.toggle(false);
    },
  });
  const backendName = renderer.backend === 'webgl2' ? 'WebGL2' : 'Canvas 2D';
  hud.setBackend(backendName, `${backendName} · ${renderer.detail}`);

  /** 唯一的入口：换种子 = 重建世界，并同步 HUD 与地址栏。 */
  function applySeed(value: number): void {
    scene.generate(value);
    hud.setSeed(scene.seed);
    writeSeedToUrl(scene.seed);
  }

  function relayout(): void {
    const cssW = Math.max(1, canvas.clientWidth || window.innerWidth);
    const cssH = Math.max(1, canvas.clientHeight || window.innerHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    lastDpr = dpr;
    worldH = WORLD_H;
    worldW = worldH * (cssW / cssH);
    pxScale = worldH / cssH;
    scene.resize(worldW, worldH);
    renderer.resize(cssW, cssH, dpr);
    scene.rebuild();
    solveMeter.invalidate(); // 尺寸变了 ⇒ 可见线段数变了，重新测
  }

  function currentLight(): { x: number; y: number } {
    if (opts.followMouse && pointer.inside) {
      return { x: pointer.x * worldW, y: pointer.y * worldH };
    }
    return { x: worldW * settings.lightX, y: worldH * settings.lightY };
  }

  let last = performance.now();
  let smoothDt = 16.7;

  function frame(now: number): void {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    if (Math.abs((window.devicePixelRatio || 1) - lastDpr) > 0.01) relayout();

    scene.update(dt, opts.paused ? 0 : opts.speed);
    const light = currentLight();
    meterLight.x = light.x;
    meterLight.y = light.y;
    // scene.light 供遮挡计数等调试接口使用
    scene.light.x = light.x;
    scene.light.y = light.y;
    const blackout = scene.occludedAt(light.x, light.y);

    const t0 = performance.now();
    engine.compute(light.x, light.y, scene.segments, scene.segmentCount, opts, vis);
    const rays = vis.raysCast;
    // 至少测够一次（否则读数只能是初始猜测）；之后暂停 / 不可见 / 面板收起时就不再做无谓采样
    const needTiming = !solveMeter.measured || (!opts.paused && !document.hidden && hud.visible);
    const visMs = needTiming ? solveMeter.sample() : solveMeter.value;
    if (blackout) vis.reset(); // 光源被方块压住：整个房间只剩环境光

    hud.setBlackout(blackout);

    const model: RenderModel = {
      worldW,
      worldH,
      pxScale,
      light,
      instances: scene.instances,
      instanceCount: scene.visibleInstanceCount,
      segments: scene.segments,
      segmentCount: scene.segmentCount,
      vis,
      opts,
      blackout,
    };
    renderer.render(model);

    // cpuMs = 可见性 + 渲染的实际耗时；fps 取真实帧间隔（受 vsync 限制）
    const cpuMs = performance.now() - t0;
    smoothDt += (Math.max(dt * 1000, 0.1) - smoothDt) * 0.1;
    stats.fps = 1000 / Math.max(smoothDt, 0.1);
    stats.frameMs = cpuMs;
    stats.visMs = visMs;
    stats.segments = scene.segmentCount;
    stats.rays = rays;
    stats.vertices = vis.vertexCount;
    stats.instances = scene.visibleInstanceCount;
    stats.blocks = scene.blocks.length;
    hud.update(stats);

    requestAnimationFrame(frame);
  }

  attachInput(canvas, {
    onKey(code) {
      switch (code) {
        case 'Digit1':
          opts.mode = 'exact';
          solveMeter.invalidate();
          break;
        case 'Digit2':
          opts.mode = 'edge';
          solveMeter.invalidate();
          break;
        case 'Digit3':
          opts.mode = 'uniform';
          solveMeter.invalidate();
          break;
        case 'Space':
          opts.paused = !opts.paused;
          break;
        case 'ArrowLeft':
          opts.speed = Math.max(0, opts.speed - 10);
          break;
        case 'ArrowRight':
          opts.speed = Math.min(400, opts.speed + 10);
          break;
        case 'KeyR':
          opts.debugRays = !opts.debugRays;
          break;
        case 'KeyM':
          opts.followMouse = !opts.followMouse;
          break;
        case 'KeyB':
          opts.showBlocks = !opts.showBlocks;
          break;
        case 'KeyN':
          applySeed(randomSeed());
          break;
        case 'KeyA':
          advanced.toggle();
          return;
        case 'Escape':
          if (advanced.visible) advanced.toggle(false);
          return;
        case 'KeyH':
          hud.toggle();
          return;
        default:
          return;
      }
      hud.sync();
    },
    onPointer(x, y) {
      pointer.x = x;
      pointer.y = y;
      pointer.inside = true;
    },
    onPointerLeave() {
      pointer.inside = false;
    },
  });

  window.addEventListener('resize', relayout);
  applySeed(readSeedFromUrl() ?? randomSeed());
  relayout();
  requestAnimationFrame(frame);

  // 自动化验证用的句柄（Playwright 会读这个）
  (window as unknown as Record<string, unknown>).__RT2D__ = {
    opts,
    scene,
    vis,
    engine,
    renderer,
    stats,
    relayout,
    solveMeter,
    settings,
    theme: settings,
    blockerCount: (x: number, y: number) => scene.blockerCount(x, y),
    applySeed,
    getSeed: () => scene.seed,
    /** 当前帧真正会被画出来的棱边亮段（验证脚本用它核对像素与模型是否一致） */
    rimSegments: () =>
      collectRimSegments(
        {
          instanceCount: scene.visibleInstanceCount,
          instances: scene.instances,
          segments: scene.segments,
          vis,
          light: scene.light,
        },
        blockFill(),
      ),
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
