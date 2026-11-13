// For a studio stage with a set camera (fit: false): its home views are framed on the desktop canvas, gutters included,
// but a narrow column (a phone: no gutters, a minimum height) gives a narrower canvas, which crops the sides. This pulls
// the camera back by the ratio of the two aspects, so what home showed across stays across. The vertical field of view
// is the camera's; the horizontal one narrows with the aspect, so the distance scales with desktop / actual aspect (exact
// for small angles, close enough for a framing).

import type { OrbitView } from '../gl/camera';

interface Stage { el: HTMLElement; goTo(view: OrbitView): void }

/** Watches the stage; `aspect` is the width over height of the canvas the homes were framed on (measured at 1440 px:
 *  wider than the stage's own option where label gutters lie over its sides), `current()` the host's current home, `narrowMore` the extra
 *  room on a narrow stage, whose corners the buttons and badges take. */
export function keepWidth(stage: Stage, aspect: number, current: () => OrbitView, narrowMore = 1.05): { scaled: (v: OrbitView) => OrbitView; stop: () => void } {
  let k = 1;
  const factor = (): number => {
    const c = stage.el.querySelector('canvas, svg.r3-flat') as HTMLElement | null, w = c?.clientWidth ?? 0, h = c?.clientHeight ?? 0;
    const narrow = stage.el.classList.contains('narrow') ? narrowMore : 1;
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
