// A chip package opened up (loaded on demand, modelhost.ts): die, pads, bond wires, lead frame, board. The bounce is
// phys/line.ts's groundBounce on the current of a pad (line.ts padSwing), the same call as chapter 41's noise panel, so
// the two agree at the same settings; the ground wires are the return path, and bonding more of them divides L.

import '../styles/package3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { VIH, VIL, VIO } from '../phys/line';
import { padSwing } from './line';
import { modelStage } from './modelstage';
import { bonds, bounceOf, pkAnchors, pkParts, verdictOf, GROUNDS, SIGNALS, type PkPalette, type PkState } from './package3dparts';

const TEXT = { ok: 'inside the margin', undefined: 'input undefined', high: 'a 0 can read as a 1', invalid: 'beyond the supply' };

export function packageView(): Widget {
  const st: PkState = { n: 8, g: 1, lnh: 3, rise: 1 };
  const panel = h('div', { class: 'panel' });
  const palette = (): PkPalette => ({
    board: stage.rgb('--pk-board'), lead: stage.rgb('--pk-lead'), paddle: stage.rgb('--pk-paddle'), die: stage.rgb('--m3-si'), pad: stage.rgb('--pk-gold'),
    gold: stage.rgb('--pk-gold'), ground: stage.rgb('--pk-ground'), lit: stage.rgb('--pk-lit'), bad: stage.rgb('--pk-bad'),
  });
  const stage = modelStage(panel, {
    aria: 'A chip package opened up in 3D: a die on a paddle, bond wires from its pads to the lead frame, the board below',
    camera: { target: [0, 0, 0], yaw: -0.45, pitch: 0.7, dist: 128 },
    limits: { minDist: 50, maxDist: 320 },
    note: 'No plastic body is drawn, the die is far larger against the leads than a real one, and the wires are much thicker than the 25 µm they are.',
    draw: () => stage.paint(pkParts(st, palette()), pkAnchors(st)),
  });
  const chipV = h('span', { class: 'r3-chip' }), chipS = h('span', { class: 'r3-chip' });
  stage.chips.append(chipV, chipS);
  const kv = h('div', { class: 'r3-kv' });
  const fill = h('i'), mark = h('b'), bar = h('div', { class: 'pk-bar', role: 'img' }, fill, mark);
  const scale = h('div', { class: 'pk-scale' }, ...([['0', 0], ['VIL', VIL], ['VIH', VIH], ['VDD', VIO]] as const).map(([t, v]) => h('span', { style: `left:${(v / VIO) * 100}%` }, t)));
  mark.style.left = `${(VIL / VIO) * 100}%`;
  const f2 = (v: number) => v.toFixed(2);

  const readout = () => {
    const v = bounceOf(st), vd = verdictOf(v), lit = bonds(st).filter((b) => b.lit && !b.ground).length, i = padSwing(), leff = st.lnh / st.g;
    chipV.textContent = vd === 'invalid' ? `${f2(v)} V (> VDD)` : `${f2(v)} V`; chipV.className = `r3-chip ${vd === 'ok' ? 'good' : 'bad'}`;
    chipS.textContent = vd === 'ok' ? `${Math.round((v / VIL) * 100)} % of VIL` : TEXT[vd]; chipS.className = `r3-chip ${vd === 'ok' ? '' : 'bad'}`;
    fill.style.width = `${Math.min(100, (v / VIO) * 100)}%`; fill.className = v >= VIL ? 'bad' : '';
    bar.setAttribute('aria-label', `Ground bounce ${f2(v)} V against VIL ${f2(VIL)} V and VIH ${f2(VIH)} V`);
    const rows: [string, string][] = [
      ['Outputs switching', `${st.n} of ${SIGNALS} (${lit} wires lit)`], ['Current per pad', `${(i * 1000).toFixed(1)} mA`],
      ['Through the ground wires', `${(st.n * i * 1000).toFixed(0)} mA, ${((st.n * i * 1000) / st.g).toFixed(0)} mA each`],
      ['Return inductance', `${st.lnh} nH / ${st.g} = ${leff.toFixed(2)} nH`], ['Ground bounce', `${f2(v)} V`], ['VIL / VIH', `${f2(VIL)} V / ${f2(VIH)} V`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, x]) => [h('span', null, k), h('span', { class: 'v' }, x)]));
  };
  const repaint = () => { readout(); stage.paint(pkParts(st, palette()), pkAnchors(st)); };
  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); repaint(); });
    return h('label', { class: 'r3-sl' }, h('span', null, label), input, out);
  };
  const ctl = h('div', { class: 'r3-ctl' },
    slider('Outputs switching', 1, SIGNALS, 1, st.n, String, (v) => { st.n = v; }), slider('Ground pins shared', 1, GROUNDS, 1, st.g, String, (v) => { st.g = v; }),
    slider('Edge time', 0.1, 4, 0.1, st.rise, (v) => `${v.toFixed(1)} ns`, (v) => { st.rise = v; }), slider('Inductance per bond', 0.5, 10, 0.5, st.lnh, (v) => `${v} nH`, (v) => { st.lnh = v; }));

  panel.append(
    h('h3', { class: 'm3-title' }, 'From the pad to the pin'),
    h('p', { class: 'm3-sub' }, 'The die sits on a paddle; a bond wire runs from each pad to a lead, and the lead fans out to the board. Every output returns its current through the ground bond wires (blue), and a wire of a few mm has a few nH. When n outputs switch in one edge, that shared inductance sees n times di/dt and the chip\'s ground lifts by L · n · di/dt, the figure of the noise panel of step 7 at the same settings. Bonding k ground wires is modelled as L / k, which ignores their mutual inductance: neighbouring wires couple, so a real set does worse than the division says. Beyond VDD the linear formula is invalid.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, ctl, stage.el, stage.hint, h('div', { class: 'r3-btns' }, stage.resetBtn)),
      h('div', { class: 'r3-side' }, h('h4', null, 'The ground wire ', h('span', { class: 'r3-badge' }, 'model')), bar, scale, kv)));
  repaint();
  return { el: panel, destroy() { stage.destroy(); } };
}
