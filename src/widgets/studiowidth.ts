// For a studio stage with a set camera (fit: false): its home views are framed on the desktop canvas (gutters included), but a
// narrow column (a phone: no gutters, a minimum height) gives a narrower canvas, which crops the sides. This pulls the
// camera back by the ratio of the two aspects, so what home showed across stays across. The vertical field of view is
// the camera's; the horizontal one narrows with the aspect, so the distance scales with designed / actual aspect (exact
// for small angles, close enough for a framing).

import type { OrbitView } from '../gl/camera';

interface Stage { el: HTMLElement; goTo(view: OrbitView): void }

/** Watches the stage's canvas; `current()` is the view to keep (the host's current home). Returns: the view to use now
 *  (scaled) and a cleanup. */
export function keepWidth(stage: Stage, aspect: number, current: () => OrbitView): { scaled: (v: OrbitView) => OrbitView; stop: () => void } {
  let k = 1;
  const factor = (): number => {
    const c = stage.el.querySelector('canvas, svg.r3-flat') as HTMLElement | null, w = c?.clientWidth ?? 0, h = c?.clientHeight ?? 0;
    // a narrow stage also loses its corners to the buttons and the badges: a little more room there
    const narrow = stage.el.classList.contains('narrow') ? 1.05 : 1;
    return w && h ? Math.max(1, aspect / (w / h)) * narrow : 1;
  };
  const scaled = (v: OrbitView): OrbitView => ({ ...v, dist: v.dist * k });
  const ro = new ResizeObserver(() => {
    const f = factor();
    if (Math.abs(f - k) / k < 0.03) return;
    k = f;
    stage.goTo(scaled(current()));
  });
  ro.observe(stage.el);
  return { scaled, stop: () => ro.disconnect() };
}
