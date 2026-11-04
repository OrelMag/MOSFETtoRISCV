// Shared by the analogy figures: reduced motion, a loop that ends when the figure leaves the page, a button.

import { h } from '../../ui/dom';

export { reducedMotion } from '../../ui/motion';

/** requestAnimationFrame loop calling `fn(dtMs)` while `host` is in the document; `fn` returns false to stop. */
export function frames(host: HTMLElement, fn: (dt: number) => boolean | void): void {
  let last = performance.now();
  const tick = (now: number) => {
    if (!host.isConnected) return;
    const dt = Math.min(100, now - last);
    last = now;
    if (fn(dt) !== false) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function button(label: string, on: () => void, pressed?: boolean): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'af-btn' }, label);
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  b.addEventListener('click', on);
  return b;
}

export const setPressed = (b: HTMLButtonElement, v: boolean): void => b.setAttribute('aria-pressed', String(v));
