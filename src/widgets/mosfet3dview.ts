// The MOSFET in 3D (loaded on demand, modelhost.ts): what the cross-section cannot show. W widens the current and L
// shortens it because of where they lie; the sheet is the model's inversion charge, the carriers keep the current
// constant through it (faster where it is thin), and the gate's capacitance grows with its area.

import '../styles/mosfet3d.css';
import type { Carrier, MosPalette, MosState } from './mosfet3dparts';
import type { BiasLink } from './mosshare';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { depletionAt, lengthNm, mosAnchors, mosParts, NM_PER_UNIT, widthNm } from './mosfet3dparts';
import { carrierVelocity, channelCharge, current, depletionDepth, gateCap, sizedCurrent, VDD, VT } from './mosphys';
import { modelStage } from './modelstage';

const REGION = { cut: 'cut-off', lin: 'linear', sat: 'saturation' } as const;
const PER_W = 5, PER_L = 7;

/** `link`: the gate and drain of the cross-section above (mosshare.ts); without it the view keeps its own. */
export function mosfetView(link?: BiasLink): Widget {
  const st: MosState = { vg: link?.vg ?? 1.2, vd: link?.vd ?? 0.9, w: 1, l: 1, lift: 8 };
  let carriers: Carrier[] = [];
  const panel = h('div', { class: 'panel mf3' });
  const stage = modelStage(panel, {
    aria: 'An NMOS transistor in 3D: source and drain islands, the channel between them, oxide and gate above',
    camera: { target: [0, 4, 0], yaw: -0.55, pitch: 0.5, dist: 84 },
    limits: { minDist: 30, maxDist: 260 },
    note: `A 180 nm-class device (the 1.8 V, 0.45 V model's), 1 unit = ${NM_PER_UNIT} nm along the channel and the width. Gate oxide 4 nm, polysilicon 200 nm, spacers 60 nm are to scale; the gate is lifted to show the channel, the sheet (a few nm in silicon) and the contacts are drawn larger than life (the gate contact stands over the channel here; a layout lands it on polysilicon over the field oxide, off the transistor), and the field oxide (STI), silicide, lightly doped drain extensions, metal and the body contact are left out.`,
    draw,
  });

  function seed(): void {
    const rows = Math.round(PER_W * st.w), cols = Math.round(PER_L * st.l);
    carriers = [];
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) carriers.push({ x: (j + (i % 2) / 2) / cols, z: rows > 1 ? -1 + (2 * i) / (rows - 1) : 0 });
  }

  const region = h('span', { class: 'r3-chip' }), idChip = h('span', { class: 'r3-chip' });
  stage.chips.append(region, idChip);
  const kv = h('div', { class: 'r3-kv' });
  const palette = (): MosPalette => ({
    si: stage.rgb('--m3-si'), p: stage.rgb('--m3-p'), pClear: stage.rgba('--m3-p', 0.22), n: stage.rgb('--m3-n'), poly: stage.rgb('--m3-poly'),
    oxide: stage.rgba('--m3-oxide', 0.45), depl: stage.rgba('--mf-depl', 0.6), metal: stage.rgb('--m3-metal'), charge: stage.rgb('--m3-charge'), carrier: stage.rgb('--m3-carrier'), dim: stage.rgb('--m3-dim'),
  });

  const flowing = () => current(st.vg - VT, st.vd).id > 0;
  function draw(): void {
    const on = flowing();
    stage.paint(mosParts(st, palette(), on ? carriers : []), mosAnchors(st));
  }

  const readout = () => {
    const vov = st.vg - VT, { kind } = current(vov, st.vd), id = sizedCurrent(vov, st.vd, st.w, st.l);
    region.textContent = REGION[kind];
    region.className = `r3-chip ${kind === 'cut' ? '' : kind === 'sat' ? 'warn' : 'good'}`;
    idChip.textContent = `Id = ${id.toFixed(0)} µA`;
    const rows: [string, string][] = [
      ['Size', `W ${widthNm(st.w)} nm / L ${lengthNm(st.l)} nm`],
      ['Depletion depth', `${Math.round(depletionDepth(st.vg) * 100)} % of max (${Math.round(depletionAt(st.vg) * NM_PER_UNIT)} nm)`],
      ['Overdrive', vov > 0 ? `${vov.toFixed(2)} V` : 'none'],
      ['Charge at the source', `${channelCharge(vov, st.vd, 0).toFixed(2)} V`],
      ['Charge at the drain', `${channelCharge(vov, st.vd, 1).toFixed(2)} V`],
      ['Drain current', `${id.toFixed(0)} µA`],
      ['Gate capacitance', `${gateCap(st.w, st.l).toFixed(1)} fF`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
  };

  const repaint = () => { readout(); draw(); loop.kick(); };
  const loop = frameLoop((_now, dt) => {
    const vov = st.vg - VT, id = current(vov, st.vd).id;
    // Per unit width the current is k·(W/L)·…/W: the same through every x, so speed is that over the local charge; a
    // longer channel also has further to go.
    for (const c of carriers) {
      c.x += (carrierVelocity(id / st.l, channelCharge(vov, st.vd, c.x)) * dt * 0.28) / st.l;
      if (c.x >= 1) c.x -= 1;
    }
    draw();
  }, () => flowing() && !reducedMotion());

  const fmtV = (v: number) => `${v.toFixed(2)} V`, fmtX = (v: number) => `${v}×`;
  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); repaint(); });
    return { el: h('label', { class: 'r3-sl' }, h('span', null, label), input, out), set(v: number) { input.value = String(v); out.textContent = fmt(v); } };
  };
  const gSl = slider('Gate', 0, VDD, 0.01, st.vg, fmtV, (v) => { st.vg = v; link?.set(st.vg, st.vd, st); }),
    dSl = slider('Drain', 0, VDD, 0.01, st.vd, fmtV, (v) => { st.vd = v; link?.set(st.vg, st.vd, st); });
  const unlink = link?.follow(st, (g, d) => { st.vg = g; st.vd = d; gSl.set(g); dSl.set(d); repaint(); });
  const ctl = h('div', { class: 'r3-ctl' },
    gSl.el, dSl.el,
    slider('W', 1, 4, 0.5, st.w, fmtX, (v) => { st.w = v; seed(); }).el,
    slider('L', 1, 3, 0.5, st.l, fmtX, (v) => { st.l = v; seed(); }).el,
    slider('Lift', 0, 14, 0.5, st.lift, (v) => v.toFixed(1), (v) => { st.lift = v; }).el,
    h('div', { class: 'r3-btns' }, stage.resetBtn));

  panel.append(
    h('h3', { class: 'm3-title' }, 'The same device, in three dimensions'),
    h('p', { class: 'm3-sub' }, (link ? 'Gate and drain here are the cross-section’s: move either and both follow, the same square-law model. ' : 'The same equations as the cross-section. ') + 'The cross-section is one slice: it cannot show W, the width of the sheet, which runs into the page. Double W and there are two channels side by side, so the current doubles. Double L and each carrier goes twice as far at half the field, so it halves. Either way the gate gets bigger, and the capacitance is what you pay. The amber layer under the channel is the depletion layer, from the same depth law as the cross-section: it grows as √Vgs up to Vt and then stops.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, ctl, stage.el, stage.hint,
        h('details', { class: 'r3-hint mf-try' }, h('summary', null, 'Predict, then see: the depletion layer'),
          h('p', null, 'At Vgs = 0.30 V, is the depletion layer deeper or shallower than at Vt = 0.45 V? Set the gate and read “Depletion depth”: it is ' + Math.round(depletionDepth(0.3) * 100) + ' % of the maximum at 0.30 V and 100 % from 0.45 V up, since past Vt the extra gate charge goes into the channel, not deeper.'))),
      h('div', { class: 'r3-side' }, h('h4', null, 'This transistor ', h('span', { class: 'r3-badge' }, 'model')), kv)));

  seed();
  readout();
  loop.kick();
  return { el: panel, destroy() { loop.stop(); unlink?.(); stage.destroy(); } };
}
