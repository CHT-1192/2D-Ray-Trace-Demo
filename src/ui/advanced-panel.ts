import { resetSettings, settings, type Settings } from '../settings';

export interface AdvancedActions {
  /** 某个参数被改动（app 用来重算光照 / 让计时器重测） */
  onChange(key: keyof Settings): void;
  /** 点了「恢复默认」 */
  onReset(): void;
  onClose(): void;
}

interface Knob {
  key: keyof Settings;
  label: string;
  min: number;
  max: number;
  step: number;
  /** 显示小数位 */
  digits: number;
  hint?: string;
}

interface Group {
  title: string;
  note?: string;
  open?: boolean;
  knobs: Knob[];
}

/**
 * 面板里列出的就是「改完立刻能看到变化」的那些参数。
 * 没列进来的三类参数，原因写在 README 的参数速查表里：
 *   - `opts` 里的运行项（算法/速度/射线数/ε/种子/开关）已经在主面板上；
 *   - 数值鲁棒性阈值（角点去重 1e-9、平行判定 1e-12 等）改了只会出 bug，不算「可调」；
 *   - 计时器的 targetMs / budget 属于内部实现，与画面无关。
 */
const GROUPS: Group[] = [
  {
    title: '光照',
    open: true,
    knobs: [
      { key: 'glowRadius', label: '光照范围', min: 300, max: 2400, step: 10, digits: 0 },
      { key: 'glowPower', label: '衰减指数', min: 0.3, max: 2.5, step: 0.05, digits: 2 },
      { key: 'glowAmp', label: '辉光亮度', min: 0, max: 0.8, step: 0.01, digits: 2 },
      { key: 'bgFar', label: '环境光', min: 0, max: 0.8, step: 0.005, digits: 3 },
      {
        key: 'directShare',
        label: '阴影深度',
        min: 0,
        max: 0.95,
        step: 0.01,
        digits: 2,
        hint: '每个遮挡物挡掉的比例，同时决定重叠阴影的累积速度',
      },
      { key: 'rimStrength', label: '棱边高光', min: 0, max: 1, step: 0.02, digits: 2 },
    ],
  },
  {
    title: '灯泡与位置',
    knobs: [
      { key: 'bulbSize', label: '灯泡大小', min: 0.2, max: 4, step: 0.1, digits: 1 },
      { key: 'bulbBright', label: '灯泡亮度', min: 0, max: 2, step: 0.05, digits: 2 },
      { key: 'lightX', label: '光源 X', min: 0.02, max: 0.98, step: 0.005, digits: 3 },
      { key: 'lightY', label: '光源 Y', min: 0.02, max: 0.98, step: 0.005, digits: 3 },
    ],
  },
  {
    title: '方块与线宽',
    knobs: [
      { key: 'blockTone', label: '方块灰度', min: 0.05, max: 0.6, step: 0.005, digits: 3, hint: '参考图实测 0.239' },
      { key: 'rimWidth', label: '棱边宽', min: 0.2, max: 4, step: 0.05, digits: 2 },
      { key: 'rayWidth', label: '射线宽', min: 0.2, max: 3, step: 0.05, digits: 2 },
      { key: 'dotRadius', label: '端点亮点', min: 0, max: 6, step: 0.2, digits: 1 },
    ],
  },
  {
    title: '生成器',
    note: '只影响之后新生成的方块：想立刻看到效果就按 N 换种子',
    knobs: [
      { key: 'overlap', label: '重叠程度', min: 0, max: 0.95, step: 0.05, digits: 2, hint: '越小越容易出现同带内 x 重叠' },
      { key: 'stepSpread', label: '疏密抖动', min: 0, max: 300, step: 5, digits: 0 },
      { key: 'gap', label: '最小间隙', min: 0, max: 60, step: 2, digits: 0 },
      { key: 'widthScale', label: '宽度缩放', min: 0.4, max: 1.6, step: 0.02, digits: 2 },
      { key: 'heightMin', label: '高度下限', min: 20, max: 200, step: 2, digits: 0 },
      { key: 'heightMax', label: '高度上限', min: 20, max: 240, step: 2, digits: 0 },
      { key: 'aspectMu', label: '长宽比中心', min: 0, max: 1.2, step: 0.01, digits: 2 },
      { key: 'aspectSigma', label: '长宽比离散', min: 0, max: 0.8, step: 0.01, digits: 2 },
    ],
  },
  {
    title: '宽度档位权重',
    note: '三档按比例归一化，参考图拟合值是 2 : 8 : 6',
    knobs: [
      { key: 'weightSmall', label: '小方块', min: 0, max: 1, step: 0.02, digits: 2 },
      { key: 'weightMedium', label: '中条', min: 0, max: 1, step: 0.02, digits: 2 },
      { key: 'weightLarge', label: '长条', min: 0, max: 1, step: 0.02, digits: 2 },
    ],
  },
  {
    title: '兜底',
    knobs: [{ key: 'wallMargin', label: '外墙距离', min: 40, max: 600, step: 10, digits: 0, hint: '只影响射线兜底，画面无变化' }],
  },
];

/** 高级参数面板：把所有「改完立刻生效」的参数都收在这里。 */
export class AdvancedPanel {
  private readonly inputs = new Map<keyof Settings, { input: HTMLInputElement; value: HTMLElement }>();
  private hidden = true;

  constructor(
    private readonly root: HTMLElement,
    private readonly actions: AdvancedActions,
  ) {
    root.classList.add('panel', 'panel-adv');
    root.hidden = true;

    const header = document.createElement('header');
    const title = document.createElement('h2');
    title.textContent = '高级参数';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'close';
    close.title = '关闭（A）';
    close.textContent = '×';
    close.addEventListener('click', () => this.actions.onClose());
    header.append(title, close);

    const note = document.createElement('p');
    note.className = 'adv-note';
    note.textContent = '拖动即时生效';

    const groups = document.createElement('div');
    groups.className = 'adv-groups';

    for (const group of GROUPS) {
      const details = document.createElement('details');
      if (group.open) details.open = true;
      const summary = document.createElement('summary');
      summary.textContent = group.title;
      details.append(summary);

      if (group.note) {
        const p = document.createElement('p');
        p.className = 'adv-group-note';
        p.textContent = group.note;
        details.append(p);
      }

      for (const knob of group.knobs) {
        const row = document.createElement('label');
        row.className = 'knob';
        if (knob.hint) row.title = knob.hint;

        const name = document.createElement('span');
        name.textContent = knob.label;

        const input = document.createElement('input');
        input.type = 'range';
        input.dataset.knob = knob.key;
        input.min = String(knob.min);
        input.max = String(knob.max);
        input.step = String(knob.step);

        const value = document.createElement('b');
        const format = (v: number) => v.toFixed(knob.digits);
        input.value = String(settings[knob.key]);
        value.textContent = format(settings[knob.key]);

        input.addEventListener('input', () => {
          const v = Number(input.value);
          settings[knob.key] = v;
          value.textContent = format(v);
          this.actions.onChange(knob.key);
        });

        row.append(name, input, value);
        details.append(row);
        this.inputs.set(knob.key, { input, value });
      }

      groups.append(details);
    }

    const footer = document.createElement('footer');
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'reset';
    reset.textContent = '恢复默认值';
    reset.addEventListener('click', () => {
      resetSettings();
      this.refresh();
      this.actions.onReset();
    });
    footer.append(reset);

    root.append(header, note, groups, footer);
  }

  get visible(): boolean {
    return !this.hidden;
  }

  toggle(force?: boolean): void {
    this.hidden = force === undefined ? !this.hidden : !force;
    this.root.hidden = this.hidden;
  }

  /** 把 settings 的当前值刷回控件（恢复默认后调用）。 */
  refresh(): void {
    for (const [key, { input, value }] of this.inputs) {
      const v = settings[key];
      input.value = String(v);
      value.textContent = v.toFixed(this.digitsOf(key));
    }
  }

  private digitsOf(key: keyof Settings): number {
    for (const g of GROUPS) for (const k of g.knobs) if (k.key === key) return k.digits;
    return 2;
  }
}
