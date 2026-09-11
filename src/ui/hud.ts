import type { Options } from '../config';

export interface Stats {
  fps: number;
  frameMs: number;
  visMs: number;
  segments: number;
  rays: number;
  vertices: number;
  instances: number;
  blocks: number;
}

export interface HudActions {
  onMode(mode: Options['mode']): void;
  onSpeed(v: number): void;
  onRayCount(v: number): void;
  onEpsilon(v: number): void;
  onFlag(key: 'debugRays' | 'followMouse' | 'showBlocks' | 'paused', value: boolean): void;
  /** 用指定种子重建世界 */
  onSeed(seed: number): void;
  /** 换一个随机种子 */
  onRandomSeed(): void;
  onToggleHud(): void;
}

const EPSILONS = [0.01, 0.003, 0.001, 0.0003, 0.0001];

/** 亚毫秒用 µs、毫秒级用 ms，避免出现「不是 1µs 就是 1.00ms」这种没有中间值的读数。 */
function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  if (ms < 0.001) return '<1µs';
  if (ms < 0.1) return `${(ms * 1000).toFixed(1)}µs`;
  if (ms < 1) return `${Math.round(ms * 1000)}µs`;
  return `${ms.toFixed(2)}ms`;
}

const TEMPLATE = /* html */ `
<div class="panel">
  <header>
    <h1>2D 光线追踪</h1>
    <span class="badge" data-backend>—</span>
  </header>
  <p class="sub">点光源硬阴影 · 方块程序化生成，自左向右平移</p>

  <div class="modes">
    <button type="button" data-mode="exact">精确锁定边缘</button>
    <button type="button" data-mode="edge">角点 ±ε</button>
    <button type="button" data-mode="uniform">均匀射线</button>
  </div>
  <p class="note" data-note></p>

  <div class="stats">
    <div title="本帧参与求交的线段：每个方块 4 条 + 4 面外墙">
      <span>线段</span><b data-stat="segments">0</b>
    </div>
    <div title="本帧实际投射的射线数。精确模式 = 角区间数，而不是固定 360 条">
      <span>射线</span><b data-stat="rays">0</b>
    </div>
    <div title="可见多边形的顶点数，与角点数量同阶">
      <span>顶点</span><b data-stat="vertices">0</b>
    </div>
    <div title="同屏可见的方块数（屏幕外的邻居不参与求交）">
      <span>方块</span><b data-stat="blocks">0</b>
    </div>
    <div title="可见性求解耗时：角度排序 + 射线求交">
      <span>求解</span><b data-stat="vis">0</b>
    </div>
    <div title="真实帧率（受 vsync 限制）">
      <span>FPS</span><b data-stat="fps">0</b>
    </div>
  </div>

  <label class="row">
    <span>速度</span>
    <input type="range" min="0" max="400" step="5" data-slider="speed">
    <b data-value="speed">0</b>
  </label>
  <label class="row" data-row="rayCount">
    <span>射线数</span>
    <input type="range" min="90" max="1440" step="30" data-slider="rayCount">
    <b data-value="rayCount">0</b>
  </label>
  <label class="row" data-row="epsilon">
    <span>ε / rad</span>
    <select data-select="epsilon"></select>
  </label>

  <label class="row row-seed">
    <span>种子</span>
    <input type="number" data-seed min="0" max="2147483647" step="1" spellcheck="false" />
    <button type="button" class="dice" data-action="dice" title="换一个随机种子">随机</button>
  </label>
  <p class="tip">同一颗种子永远生成同一个世界。种子会写进地址栏，刷新或分享链接都能复现。</p>

  <div class="flags">
    <label><input type="checkbox" data-flag="debugRays"><span>显示射线</span></label>
    <label><input type="checkbox" data-flag="followMouse"><span>光源跟随鼠标</span></label>
    <label><input type="checkbox" data-flag="showBlocks"><span>显示方块</span></label>
    <label><input type="checkbox" data-flag="paused"><span>暂停滚动</span></label>
  </div>

</div>
<div class="hint">
  <kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> 算法 ·
  <kbd>Space</kbd> 暂停 ·
  <kbd>←</kbd><kbd>→</kbd> 速度 ·
  <kbd>R</kbd> 射线 ·
  <kbd>M</kbd> 跟随鼠标 ·
  <kbd>B</kbd> 方块 ·
  <kbd>N</kbd> 换种子 ·
  <kbd>H</kbd> 面板
</div>
`;

const NOTES: Record<Options['mode'], string> = {
  exact: '每个角区间只投 1 条射线确定遮挡者，两端精确钉在角点上 —— 边界零误差，也不需要 ε。',
  edge: '每个角点 ±ε 各投 1 条 —— 实现简单的近似解，边界依赖 ε，会有细微漏光。',
  uniform: '沿圆周均匀扫 360 条 —— 最直观的写法，边界落在采样角度上，方块一动就抖。',
};

/** 左上角控制面板（纯 DOM，和渲染后端无关）。 */
export class Hud {
  private readonly root: HTMLElement;
  private readonly actions: HudActions;
  private readonly modeButtons: HTMLButtonElement[];
  private readonly statFields: Record<string, HTMLElement> = {};
  private readonly sliders: Record<string, HTMLInputElement> = {};
  private readonly sliderValues: Record<string, HTMLElement> = {};
  private readonly flags: Record<string, HTMLInputElement> = {};
  private readonly note: HTMLElement;
  private readonly epsilonSelect: HTMLSelectElement;
  private readonly seedInput: HTMLInputElement;
  private seed = 0;
  private hidden = false;

  constructor(root: HTMLElement, private opts: Options, actions: HudActions) {
    this.root = root;
    this.actions = actions;
    root.innerHTML = TEMPLATE;
    root.classList.add('hud');

    const q = <T extends Element>(sel: string): T => {
      const el = root.querySelector(sel);
      if (!el) throw new Error(`HUD 缺少元素: ${sel}`);
      return el as T;
    };

    this.note = q<HTMLElement>('[data-note]');
    this.modeButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-mode]'));
    for (const btn of this.modeButtons) {
      btn.addEventListener('click', () => this.actions.onMode(btn.dataset.mode as Options['mode']));
    }

    for (const key of ['segments', 'rays', 'vertices', 'blocks', 'vis', 'fps']) {
      this.statFields[key] = q<HTMLElement>(`[data-stat="${key}"]`);
    }

    for (const key of ['speed', 'rayCount'] as const) {
      const input = q<HTMLInputElement>(`[data-slider="${key}"]`);
      const value = q<HTMLElement>(`[data-value="${key}"]`);
      this.sliders[key] = input;
      this.sliderValues[key] = value;
      input.addEventListener('input', () => {
        const v = Number(input.value);
        if (key === 'speed') this.actions.onSpeed(v);
        else this.actions.onRayCount(v);
      });
    }

    this.epsilonSelect = q<HTMLSelectElement>('[data-select="epsilon"]');
    for (const e of EPSILONS) {
      const opt = document.createElement('option');
      opt.value = String(e);
      opt.textContent = e.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
      this.epsilonSelect.append(opt);
    }
    this.epsilonSelect.addEventListener('change', () => this.actions.onEpsilon(Number(this.epsilonSelect.value)));

    for (const key of ['debugRays', 'followMouse', 'showBlocks', 'paused'] as const) {
      const input = q<HTMLInputElement>(`[data-flag="${key}"]`);
      this.flags[key] = input;
      input.addEventListener('change', () => this.actions.onFlag(key, input.checked));
    }

    this.seedInput = q<HTMLInputElement>('[data-seed]');
    const applySeed = () => {
      const v = Number(this.seedInput.value);
      if (Number.isFinite(v) && this.seedInput.value.trim() !== '') this.actions.onSeed(Math.trunc(v) | 0);
      else this.setSeed(this.seed); // 输入非法就还原
    };
    this.seedInput.addEventListener('change', applySeed);
    this.seedInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        applySeed();
        this.seedInput.blur();
      }
    });
    q<HTMLButtonElement>('[data-action="dice"]').addEventListener('click', () => this.actions.onRandomSeed());

    this.sync();
  }

  /** short 显示在徽标里，full 放 tooltip（GPU 型号串通常很长） */
  setBackend(short: string, full = short): void {
    const el = this.root.querySelector('[data-backend]');
    if (el) {
      el.textContent = short;
      el.setAttribute('title', full);
    }
  }

  /** 面板当前是否可见（隐藏时就没必要测耗时了）。 */
  get visible(): boolean {
    return !this.hidden;
  }

  /** 同步种子输入框（生成世界之后由 app 调用）。 */
  setSeed(seed: number): void {
    this.seed = seed;
    this.seedInput.value = String(seed);
  }

  /** 把 opts 的当前值刷到控件上（键盘改选项后也要调）。 */
  sync(): void {
    for (const btn of this.modeButtons) btn.classList.toggle('active', btn.dataset.mode === this.opts.mode);
    this.sliders.speed.value = String(Math.round(this.opts.speed));
    this.sliderValues.speed.textContent = String(Math.round(this.opts.speed));
    this.sliders.rayCount.value = String(this.opts.rayCount);
    this.sliderValues.rayCount.textContent = String(this.opts.rayCount);
    this.epsilonSelect.value = String(this.opts.edgeEpsilon);
    if (this.epsilonSelect.selectedIndex < 0) this.epsilonSelect.selectedIndex = 2;
    for (const key of ['debugRays', 'followMouse', 'showBlocks', 'paused'] as const) {
      this.flags[key].checked = this.opts[key];
    }
    this.note.textContent = NOTES[this.opts.mode];
    this.root.querySelector('[data-row="rayCount"]')?.classList.toggle('dim', this.opts.mode !== 'uniform');
    this.root.querySelector('[data-row="epsilon"]')?.classList.toggle('dim', this.opts.mode !== 'edge');
  }

  update(stats: Stats): void {
    this.statFields.segments.textContent = String(stats.segments);
    this.statFields.rays.textContent = String(stats.rays);
    this.statFields.vertices.textContent = String(stats.vertices);
    this.statFields.blocks.textContent = String(stats.instances);
    this.statFields.vis.textContent = formatMs(stats.visMs);
    this.statFields.fps.textContent = String(Math.round(stats.fps));
  }

  toggle(): void {
    this.hidden = !this.hidden;
    this.root.classList.toggle('hidden', this.hidden);
  }
}
