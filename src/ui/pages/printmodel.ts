// A 3D model as a printed figure (print view, ui/pages/print.ts): the model is mounted off screen as its step mounts it
// (widgets/models3dindex.ts open), names on whatever the setting (modelshot.ts printing), and drawn once it has drawn: the
// stage's own picture at home, in paper's look (light, whatever the learner's theme), or its flat SVG where there is no WebGL2.
// Then it is destroyed, which releases its WebGL context: one model at a time, so a chapter of three never holds three.

import { modelById } from '../../widgets/models3dindex';
import { printing, shotIn } from '../../widgets/modelshot';
import { h } from '../dom';

/** How long a model may take to arrive and draw (its chunk, the renderer, the first frame). */
const WAIT_MS = 30000;

const later = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Two frames (labels and the scale bar follow a render), with a timer so a hidden tab goes on. */
const frames = () => new Promise<void>((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r())); setTimeout(r, 200); });

/** The model `id` as an <img> (or the flat <svg>); throws with a reason when it does not draw. `stop`: the reader cancelled. */
export async function modelFigure(id: string, stop: () => boolean): Promise<HTMLElement | SVGSVGElement> {
  const entry = modelById(id);
  if (!entry) throw new Error(`no 3D model named ${id}`);
  // a desktop column's width, so the names sit in their gutters (a phone's badges and list do not print)
  const host = h('div', { 'aria-hidden': 'true', inert: '', style: 'position:fixed;left:-100000px;top:0;width:960px;pointer-events:none' });
  document.body.append(host);
  printing.on = true;
  let destroy: (() => void) | undefined;
  try {
    const w = await entry.open();
    destroy = () => w.destroy?.();
    host.append(w.el);
    const t0 = performance.now();
    let shot = shotIn(host);
    while (!shot) {
      if (stop()) throw new Error('cancelled');
      if (performance.now() - t0 > WAIT_MS) throw new Error('it did not load in time');
      await later(100);
      shot = shotIn(host);
    }
    const ready = await Promise.race([shot.ready().then(() => true), later(Math.max(1000, WAIT_MS - (performance.now() - t0))).then(() => false)]);
    if (!ready) throw new Error('it did not draw in time');
    if (stop()) throw new Error('cancelled');
    await frames();
    const pic = shot.snapshot(true);
    if (!pic) throw new Error('it has no picture');
    if (pic instanceof SVGSVGElement) {
      // the stage's class lays the flat view over its canvas (absolute, filling it): a figure is in the flow
      pic.removeAttribute('width'); pic.removeAttribute('height');
      pic.setAttribute('class', 'pd-model');
      pic.style.cssText = 'width:100%;height:auto';
      return pic;
    }
    return h('img', { class: 'pd-model', src: pic.toDataURL('image/png'), alt: entry.title, width: String(Math.round(pic.width / Math.max(1, devicePixelRatio))) });
  } finally {
    printing.on = false;
    destroy?.();
    host.remove();
  }
}
