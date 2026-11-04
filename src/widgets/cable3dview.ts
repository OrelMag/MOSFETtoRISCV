// Why a pair is twisted, in 3D (loaded on demand, modelhost.ts). Each half twist flips the sign of a loop's EMF, so the
// loops along a twisted pair cancel (phys/cable.ts); a toggle swaps in a coax, whose impedance comes from phys/line.ts's
// z0Of on the L and C that D and d give.

import '../styles/cable3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { coaxLC, coaxZ0, loopCount, pairLoops, runningSum } from '../phys/cable';
import { z0Of } from '../phys/line';
import { cableAnchors, cableParts, type CablePalette, type CableState } from './cable3dparts';
import { modelStage } from './modelstage';

/** Run length (m), conductor spacing (mm) and a polyethylene dielectric: the numbers behind the readouts. */
const RUN = 1, SPACING_MM = 1, ER = 2.3;

export function cableView(): Widget {
  const st: CableState = { twists: 5, coax: false, D: 4.6, d: 0.9 };
  let dbdt = 10; // T / s
  const panel = h('div', { class: 'panel' });
  const palette = (): CablePalette => ({
    a: stage.rgb('--m3-wire-a'), b: stage.rgb('--m3-wire-b'), pos: stage.rgba('--m3-loop-pos', 0.55), neg: stage.rgba('--m3-loop-neg', 0.55),
    shield: stage.rgba('--m3-shield', 0.35), core: stage.rgb('--m3-core'), field: stage.rgb('--m3-field'),
  });
  const stage = modelStage(panel, {
    aria: 'A twisted pair in 3D with each loop tinted by the sign of its induced voltage, or a coax',
    camera: { target: [0, 0, 0], yaw: -0.5, pitch: 0.75, dist: 80 },
    limits: { minDist: 30, maxDist: 220 },
    note: 'The spacing and the twist are drawn far larger than life, and the loops are lenses; the model counts equal loops.',
    draw: () => stage.paint(cableParts(st, palette()), cableAnchors(st)),
  });
  const chipA = h('span', { class: 'r3-chip' }), chipB = h('span', { class: 'r3-chip' });
  stage.chips.append(chipA, chipB);
  const kv = h('div', { class: 'r3-kv' }), sum = h('div', { class: 'cb-sum', role: 'group', 'aria-label': 'Running sum of the loops, in mV' });
  const mv = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v * 1000).toFixed(2)} mV`;
  const fill = (rows: [string, string][]) => kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));

  const readout = () => {
    if (st.coax) {
      const { l, c } = coaxLC(st.D, st.d, ER), z = z0Of(l, c);
      chipA.textContent = `Z0 = ${z.z0.toFixed(1)} Ω`; chipA.className = 'r3-chip good'; chipB.textContent = `${z.psPerMm.toFixed(2)} ps / mm`; chipB.className = 'r3-chip';
      fill([['D / d', (st.D / st.d).toFixed(2)], ['L per metre', `${l.toFixed(0)} nH`], ['C per metre', `${c.toFixed(1)} pF`], ['Z0 = √(L / C)', `${z.z0.toFixed(1)} Ω`],
        ['60 / √εr · ln(D / d)', `${coaxZ0(st.D, st.d, ER).toFixed(1)} Ω`], ['Dielectric', `εr = ${ER}`]]);
      sum.replaceChildren();
      return;
    }
    const loops = pairLoops(st.twists, SPACING_MM / 1000, RUN, dbdt), run = runningSum(loops), total = run[run.length - 1], full = pairLoops(0, SPACING_MM / 1000, RUN, dbdt)[0];
    const zero = Math.abs(total) < 1e-12;
    chipA.textContent = `${loopCount(st.twists)} loops`; chipA.className = 'r3-chip';
    chipB.textContent = zero ? 'cancels exactly' : `${mv(total)} left over`; chipB.className = `r3-chip ${zero ? 'good' : 'warn'}`;
    fill([['Half twists', String(st.twists)], ['Untwisted', mv(full)], ['One loop', mv(loops[0])], ['Delivered', mv(zero ? 0 : total)], ['Share of untwisted', `${Math.abs(zero ? 0 : total / full * 100).toFixed(0)} %`]]);
    sum.replaceChildren(...loops.map((e, k) => h('span', { class: e > 0 ? 'p' : 'n', title: `loop ${k + 1}: ${mv(e)}, sum ${mv(run[k])}` }, `${e > 0 ? '+' : '−'}${Math.abs(e * 1000).toFixed(1)} → Σ ${(Math.abs(run[k]) < 1e-12 ? 0 : run[k] * 1000).toFixed(1)}`)), h('span', { class: 'tot' }, `Σ ${(zero ? 0 : total * 1000).toFixed(2)} mV`));
  };
  const repaint = () => { readout(); stage.paint(cableParts(st, palette()), cableAnchors(st)); };

  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); repaint(); });
    return h('label', { class: 'r3-sl' }, h('span', null, label), input, out);
  };
  const toggle = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, 'Swap in a coax') as HTMLButtonElement;
  const pairCtl = h('div', { class: 'r3-ctl' }, slider('Half twists', 0, 12, 1, st.twists, String, (v) => { st.twists = v; }), slider('dB/dt', 1, 50, 1, dbdt, (v) => `${v} T/s`, (v) => { dbdt = v; }));
  const coaxCtl = h('div', { class: 'r3-ctl' }, slider('D', 2, 10, 0.1, st.D, (v) => `${v.toFixed(1)} mm`, (v) => { st.D = Math.max(v, st.d * 1.2); }), slider('d', 0.2, 3, 0.1, st.d, (v) => `${v.toFixed(1)} mm`, (v) => { st.d = Math.min(v, st.D / 1.2); }));
  coaxCtl.hidden = true;
  toggle.addEventListener('click', () => {
    st.coax = !st.coax; toggle.setAttribute('aria-pressed', String(st.coax)); toggle.textContent = st.coax ? 'Back to the pair' : 'Swap in a coax';
    pairCtl.hidden = st.coax; coaxCtl.hidden = !st.coax; repaint();
  });

  panel.append(
    h('h3', { class: 'm3-title' }, 'Why a pair is twisted'),
    h('p', { class: 'm3-sub' }, 'A noisy neighbour’s changing field threads the loop the pair makes with its load and induces dΦ/dt = A · dB/dt. Each half twist swaps the conductors and flips the loop’s sign, so n half twists give n + 1 loops of equal area and alternating sign: odd n sum to zero, even n leave one loop. The field here is uniform along the pair, which is what makes the cancellation exact. A real field falls off along the cable and a real twist is uneven, so a real pair cancels most of the noise, not all of it. A coax closes the loop inside its shield; D and d set its impedance.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, pairCtl, coaxCtl, stage.el, stage.hint, h('div', { class: 'r3-btns' }, toggle, stage.resetBtn)),
      h('div', { class: 'r3-side' }, h('h4', null, 'The cable ', h('span', { class: 'r3-badge' }, 'model')), kv, sum)));
  repaint();
  return { el: panel, destroy() { stage.destroy(); } };
}
