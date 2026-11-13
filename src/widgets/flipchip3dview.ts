// A lidded flip-chip package in 3D on the studio renderer (flipchip3dkit.ts; loaded on demand, modelhost.ts), beside the
// opened SOIC of chapter wire's "From the pad to the pin". The bounce is phys/line.ts's groundBounce on a pad's current
// (line.ts padSwing) at a 1 ns edge, the call the SOIC model makes, with phys/flipchip.ts's bump in place of the bond wire;
// the heat is phys/flipchip.ts's series stack over the die's area.

import '../styles/flipchip3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { groundBounce, VIL } from '../phys/line';
import { BOND, BUMP, STACK, bondNh, bumpNh, layerR, stackR } from '../phys/flipchip';
import { padSwing } from './line';
import { studioStage } from './studiostage';
import { BALLS, BUMPS, DIE_X, DIE_Z, FC_ASPECT, FC_HOME, FC_HOME_FRAME, fcModel, fcScale } from './flipchip3dkit';

/** The edge the step's noise panel and the SOIC model use. */
const RISE_NS = 1;

export function flipchipView(): Widget {
  let n = 8, watts = 100, heat = false, open: 'cut' | 'lid' | undefined;
  const panel = h('div', { class: 'panel fc3' });
  const stage = studioStage({
    aria: `A lidded flip-chip package in 3D, to scale: a 37.5 mm substrate on ${BALLS} solder balls, a silicon die face down on solder bumps in underfill, a thermal interface and a copper lid over it, cut open in a quarter`,
    home: FC_HOME, homeFrame: FC_HOME_FRAME, aspect: FC_ASPECT,
    hidden: ['heat'],
    limits: { minDist: 0.8, maxDist: 200 },
    scaleBar: fcScale,
    // the names follow what the knobs open (the renderer does not hide a name behind a part)
    onKnobs: (k) => { const o = k.cut > 0.3 ? 'cut' : k.explode > 0.3 ? 'lid' : undefined; if (o !== open) { open = o; stage.refresh(); } },
    onBeat: (i) => { const on = i === 4; if (on !== heat) { heat = on; stage.refresh(); } },
    note: 'To scale in millimetres: the outline is AMD’s Versal VFVC1596 drawing, the die its lidless sibling VSVA1596’s. Derived from the two drawings’ heights: the substrate’s 1.45 mm and the lid plate. Illustrative: the substrate’s layer split, the lid’s wall, the TIM’s 50 µm, the bumps (70 µm at 150 µm pitch, a typical C4; AMD does not publish Versal’s), which ball places are empty (the drawing gives the count) and the capacitors’ layout. Bumps are drawn only where the cut opens; a real die has them over its whole face.',
    build: (detail) => fcModel({ heat, open }, detail),
  });

  const chip = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const kv = h('div', { class: 'r3-kv' });
  const f2 = (v: number) => v.toFixed(2);
  const area = DIE_X * DIE_Z;

  function readout(): void {
    const i = padSwing(), lb = bondNh(), lu = bumpNh();
    const vb = groundBounce(n, i, RISE_NS, lb), vu = groundBounce(n, i, RISE_NS, lu), r = stackR(STACK, area);
    chip.textContent = `${n} outputs: ${f2(vb)} V through one bond wire, ${(vu * 1000).toFixed(0)} mV through one bump`;
    chip.className = `r3-chip ${vb >= VIL ? 'bad' : ''}`;
    const rows: [string, string][] = [
      ['Bond wire', `${BOND.l} mm of ${BOND.r * 2000} µm gold: ${f2(lb)} nH`],
      ['Solder bump', `${Math.round(BUMP.h * 1000)} µm tall, ${Math.round(BUMP.r * 2000)} µm across: ${(lu * 1000).toFixed(0)} pH, ${Math.round(lb / lu)} times less`],
      [`${n} outputs, ${RISE_NS} ns`, `bounce ${f2(vb)} V on a wire, ${(vu * 1000).toFixed(1)} mV on a bump (V_IL ${f2(VIL)} V)`],
      ['Bumps under the die', `about ${BUMPS.toLocaleString('en')} at ${Math.round(BUMP.pitch * 1000)} µm pitch: hundreds can be grounds`],
      ['Not modelled', 'the substrate’s vias and planes from bump to ball: more than the bump, still far less than a wire'],
      ...STACK.map((l, k): [string, string] => [['Silicon', 'TIM (polymer)', 'Copper lid'][k] ?? l.name, `${Math.round(l.tMm * 1000)} µm, k ${l.k} W/m·K: ${(layerR(l, area) * 1000).toFixed(1)} mK/W`]),
      ['Die to lid top', `${(r * 1000).toFixed(1)} mK/W over ${area.toFixed(0)} mm²: ${(watts * r).toFixed(1)} K at ${watts} W`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
  }

  const slider = (label: string, min: number, max: number, step: number, val: number, set: (v: number) => void, fmt: (v: number) => string) => {
    const inp = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement, out = h('output', null, fmt(val));
    inp.addEventListener('input', () => { set(Number(inp.value)); out.textContent = fmt(Number(inp.value)); readout(); });
    return h('label', { class: 'r3-sl' }, h('span', null, label), inp, out);
  };
  const heatBtn = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Show the heat') as HTMLButtonElement;
  heatBtn.addEventListener('click', () => { heat = !heat; heatBtn.setAttribute('aria-pressed', String(heat)); stage.refresh(); });
  stage.slot.append(h('div', { class: 'r3-ctl' },
    slider('Outputs switching', 1, 64, 1, n, (v) => { n = v; }, (v) => String(v)),
    slider('Power', 10, 250, 10, watts, (v) => { watts = v; }, (v) => `${v} W`),
    h('div', { class: 'r3-btns' }, heatBtn)));
  panel.append(
    h('h3', { class: 'm3-title' }, 'The other way: a flip chip'),
    h('p', { class: 'm3-sub' }, 'A large chip has no bond wires. Its die is turned face down and soldered straight onto a substrate through bumps under its whole face, not a ring of pads round its edge; the substrate’s wiring fans the bumps out to balls a board can take, and a copper lid on a thermal paste carries the heat away from the die’s back. A bump is about a fortieth of a bond wire’s length, so its inductance is too small to matter beside the wire’s, and there are thousands of them: the ground bounce of the panel above all but disappears, leaving the substrate and the board to account for.'),
    h('div', { class: 'r3' }, h('div', { class: 'r3-main' }, stage.el), h('div', { class: 'r3-side' }, h('h4', null, 'Bump against wire ', h('span', { class: 'r3-badge' }, 'model')), kv)));

  readout();
  return { el: panel, destroy() { stage.destroy(); } };
}
