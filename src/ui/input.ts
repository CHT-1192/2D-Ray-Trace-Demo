export interface InputHandlers {
  /** code 是 KeyboardEvent.code */
  onKey(code: string): void;
  /** 归一化到 [0,1] 的指针位置 */
  onPointer(x: number, y: number): void;
  onPointerLeave(): void;
}

/** 键盘 + 指针输入；返回解绑函数。 */
export function attachInput(target: HTMLElement, handlers: InputHandlers): () => void {
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // 正在输入框 / 下拉框 / 复选框上操作时，别抢它的按键
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
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
