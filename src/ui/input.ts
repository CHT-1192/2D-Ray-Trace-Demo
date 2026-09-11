export interface InputHandlers {
  /** code 是 KeyboardEvent.code */
  onKey(code: string): void;
  /** 归一化到 [0,1] 的指针位置 */
  onPointer(x: number, y: number): void;
  onPointerLeave(): void;
}

/** 键盘 + 指针输入；返回解绑函数。 */
export function attachInput(target: HTMLElement, handlers: InputHandlers): () => void {
  // 控件自己会消费的按键（滑块用方向键、复选框用空格），其余快捷键照常生效，
  // 否则拖完滑块之后键盘就「失灵」了。
  const ARROW_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    const type = (el as HTMLInputElement | null)?.type;
    if (tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (tag === 'INPUT') {
      if (type === 'range' && !ARROW_KEYS.has(e.code)) {
        /* 滑块只吃掉方向键，其余交给全局快捷键 */
      } else if (type === 'checkbox' && e.code !== 'Space') {
        /* 复选框只吃掉空格 */
      } else {
        return;
      }
    }
    if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    handlers.onKey(e.code);
  };

  const onPointerMove = (e: PointerEvent): void => {
    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    handlers.onPointer((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  };

  const onPointerLeave = (): void => handlers.onPointerLeave();

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerleave', onPointerLeave);
  window.addEventListener('blur', onPointerLeave);

  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerleave', onPointerLeave);
    window.removeEventListener('blur', onPointerLeave);
  };
}
