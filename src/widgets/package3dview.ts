// A chip package opened up (loaded on demand, modelhost.ts): die, pads, bond wires, lead frame, board. The bounce is
// phys/line.ts's groundBounce on the current of a pad (line.ts padSwing), the same call as chapter 41's noise panel, so
// the two agree at the same settings; the ground wires are the return path, and bonding more of them divides L.

import '../styles/package3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { VIH, VIL, VIO } from '../phys/line';
import { padSwing } from './line';
import { modelStage } from './modelstage';
import { bondL, bonds, bounceOf, drawnLenMm, pkAnchors, pkParts, verdictOf, GROUNDS, LEN_DEFAULT, LEN_MAX, LEN_MIN, SIGNALS, type PkPalette, type PkState } from './package3dparts';

const TEXT = { ok: 'inside the margin', undefined: 'input undefined', high: 'a 0 can read as a 1', invalid: 'beyond the supply' };
const TEXT_RISE = { ...TEXT, high: 'a 1 can read as a 0' };

export function packageView(): Widget {
  const st: PkState = { n: 8, g: 1, lnh: bondL(LEN_DEFAULT), rise: 1, len: LEN_DEFAULT, edge: 'fall', mould: false };
  const panel = h('div', { class: 'panel' });
  const palette = (): PkPalette => ({
    board: stage.rgb('--pk-board'), lead: stage.rgb('--pk-lead'), paddle: stage.rgb('--pk-paddle'), die: stage.rgb('--m3-si'), pad: stage.rgb('--pk-al'),
    gold: stage.rgb('--pk-gold'), ground: stage.rgb('--pk-ground'), vdd: stage.rgb('--pk-vdd'), attach: stage.rgb('--pk-attach'), mould: stage.rgb('--pk-mould'), lit: stage.rgb('--pk-lit'), bad: stage.rgb('--pk-bad'),
  });
  const stage = modelStage(panel, {
    aria: 'A chip package opened up in 3D: a die on a paddle, bond wires from its pads to the lead frame, the board below',
    camera: { target: [0, 0, 0], yaw: -0.45, pitch: 0.7, dist: 128 },
    limits: { minDist: 50, maxDist: 320 },
    note: 'Scaled: the wires are drawn about 8 times thicker than a 25 µm gold wire, the pads 2 to 3 times closer to the lead pitch than the 50 to 100 µm they are, the die film and ball bonds enlarged, and the die about 8 mm across. The wire length is true to the drawn loop; the mould is shown on request.',
    draw: () => stage.paint(pkParts(st, palette()), pkAnchors(st)),
  });
  const chipV = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' }), chipS = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' });
  stage.chips.append(chipV, chipS);
  const kv = h('div', { class: 'r3-kv' }), side = h('h4');
  const toggle = (label: string, on: () => void) => { const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, label) as HTMLButtonElement; b.addEventListener('click', () => { on(); repaint(); }); return b; };
  const btnFall = toggle('Outputs fall: ground bounce', () => { st.edge = 'fall'; }), btnRise = toggle('Outputs rise: supply droop', () => { st.edge = 'rise'; });
  const btnMould = toggle('Mould', () => { st.mould = !st.mould; });
  const fill = h('i'), mark = h('b'), bar = h('div', { class: 'pk-bar', role: 'img' }, fill, mark);
  const scale = h('div', { class: 'pk-scale' }, ...([['0', 0], ['VIL', VIL], ['VIH', VIH], ['VDD', VIO]] as const).map(([t, v]) => h('span', { style: `left:${(v / VIO) * 100}%` }, t)));
  mark.style.left = `${(VIL / VIO) * 100}%`;
  const f2 = (v: number) => v.toFixed(2);

  const readout = () => {
    const v = bounceOf(st), vd = verdictOf(v), lit = bonds(st).filter((b) => b.lit && b.rail === 'sig').length, i = padSwing(), leff = st.lnh / st.g;
    const rise = st.edge === 'rise', rail = rise ? 'VDD' : 'ground', what = rise ? 'Supply droop' : 'Ground bounce';
    chipV.textContent = vd === 'invalid' ? `${f2(v)} V (> VDD)` : `${f2(v)} V ${rise ? 'droop' : 'bounce'}`; chipV.className = `r3-chip ${vd === 'ok' ? 'good' : 'bad'}`;
    chipS.textContent = vd === 'ok' ? `${Math.round((v / VIL) * 100)} % of VIL` : (rise ? TEXT_RISE : TEXT)[vd]; chipS.className = `r3-chip ${vd === 'ok' ? '' : 'bad'}`;
    fill.style.width = `${Math.min(100, (v / VIO) * 100)}%`; fill.className = v >= VIL ? 'bad' : '';
    bar.setAttribute('aria-label', `${what} ${f2(v)} V against VIL ${f2(VIL)} V and VIH ${f2(VIH)} V`);
    const rows: [string, string][] = [
      ['Outputs switching', `${st.n} of ${SIGNALS} (${lit} wires lit), ${rise ? 'rising' : 'falling'}`], ['Current per pad', `${(i * 1000).toFixed(1)} mA`],
      [`Through the ${rail} wires`, `${(st.n * i * 1000).toFixed(0)} mA, ${((st.n * i * 1000) / st.g).toFixed(0)} mA each`],
      ['Drawn wire', `${drawnLenMm(st).toFixed(1)} mm of 25 µm gold`],
      ['Return inductance', `${st.lnh.toFixed(2)} nH / ${st.g} = ${leff.toFixed(2)} nH`], [what, `${f2(v)} V`], ['VIL / VIH', `${f2(VIL)} V / ${f2(VIH)} V`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, x]) => [h('span', null, k), h('span', { class: 'v' }, x)]));
    side.textContent = `The ${rail} wire `;
    side.append(h('span', { class: 'r3-badge' }, 'model'));
    for (const [btn, on] of [[btnFall, !rise], [btnRise, rise], [btnMould, !!st.mould]] as const) btn.setAttribute('aria-pressed', String(on));
  };
  const repaint = () => { readout(); stage.paint(pkParts(st, palette()), pkAnchors(st)); };
  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); repaint(); });
    return h('label', { class: 'r3-sl' }, h('span', null, label), input, out);
  };
  const ctl = h('div', { class: 'r3-ctl' },
    slider('Outputs', 1, SIGNALS, 1, st.n, String, (v) => { st.n = v; }), slider('Rail pins', 1, GROUNDS, 1, st.g, String, (v) => { st.g = v; }),
    slider('Edge', 0.1, 4, 0.1, st.rise, (v) => `${v.toFixed(1)} ns`, (v) => { st.rise = v; }), slider('Wire length', LEN_MIN, LEN_MAX, 0.1, st.len ?? LEN_DEFAULT, (v) => `${v.toFixed(1)} mm`, (v) => { st.len = v; st.lnh = bondL(v); }),
    h('div', { class: 'r3-btns' }, btnFall, btnRise, btnMould));

  panel.append(
    h('h3', { class: 'm3-title' }, 'From the pad to the pin'),
    h('p', { class: 'm3-sub' }, 'The die sits on a paddle; a bond wire runs from each pad to a lead, and the lead fans out to the board. Every falling output returns its current through the ground bond wires and every rising one draws it through the VDD wires; the wires are coloured by role (ground blue, VDD orange, both glowing red as the noise nears VIL), not by metal: all are gold. The inductance comes from the drawn length: a straight round wire has L ≈ 0.2 · ℓ · [ln(2ℓ / r) − 0.75] nH (ℓ and r in mm; Grover), about 1 nH per mm, so 2.8 mm of 25 µm gold is 3 nH. When n outputs switch in one edge, that shared inductance sees n times di/dt and the chip ground lifts (on a rising edge its supply sags: the same formula and thresholds, since VDD − VIH = VIL) by L · n · di/dt, the figure of the noise panel on “Crosstalk, ground bounce and pairs” at the same settings. Bonding k ground wires (and k VDD wires) is modelled as L / k, which ignores their mutual inductance: neighbouring wires couple, so a real set does worse than the division says. Beyond VDD the linear formula is invalid.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main pk-main' }, ctl, stage.el, stage.hint, h('div', { class: 'r3-btns' }, stage.resetBtn)),
      h('div', { class: 'r3-side' }, side, bar, scale, kv)));
  repaint();
  return { el: panel, destroy() { stage.destroy(); } };
}
