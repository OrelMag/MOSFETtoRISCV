// A chip package opened up (loaded on demand, modelhost.ts) on the studio renderer: a 74HC595 in its SOIC-16, true to
// scale (package3dkit.ts). The bounce is phys/line.ts's groundBounce on the current of a pad (line.ts padSwing), the same
// call as chapter wire's noise panel, through the inductance of the wires drawn: the ground lead's on a falling edge, the
// supply's on a rising one.

import '../styles/package3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { VIH, VIL, VIO } from '../phys/line';
import { padSwing } from './line';
import { studioStage } from './studiostage';
import { bonds, bounceOf, railL, packageModel, verdictOf, GND_PIN, MAX_BONDS, OUTPUTS, PK_HOME, PK_HOME_FRAME, VCC_PIN, type PkState } from './package3dkit';

const TEXT = { ok: 'inside the margin', undefined: 'input undefined', high: 'a 0 can read as a 1', invalid: 'beyond the supply' };
const TEXT_RISE = { ...TEXT, high: 'a 1 can read as a 0' };

export function packageView(): Widget {
  const st: PkState = { n: OUTPUTS, g: 1, rise: 1, edge: 'fall' };
  const panel = h('div', { class: 'panel pk3' });
  const stage = studioStage({
    aria: 'A 74HC595 in its SOIC-16 package, opened in 3D: the die on its paddle, a gold bond wire from each pad to a lead, the leads soldered to the board',
    home: PK_HOME,
    homeFrame: PK_HOME_FRAME,
    knobs: { cut: 1 },
    limits: { minDist: 0.8, maxDist: 60, maxPan: 12 },
    scaleBar: (len) => (len >= 1 ? `${len} mm` : `${Math.round(len * 1000)} µm`),
    note: 'To scale: the outline, the leads and the 25 µm wires are true size (the outline from Nexperia\'s SOT109-1 drawing, the pins from the 74HC595 data sheet). Illustrative: the die, the paddle, the fingers\' paths and the loop heights, which no maker publishes; the corner fingers are placed so the ground wire is 2.8 mm, the chapter\'s figure. More than one wire on the ground or VCC lead is a what-if: this chip has one.',
    build: (detail) => packageModel(st, { detail }),
  });
  const chipV = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' }), chipS = h('span', { class: 'r3-chip', role: 'status', 'aria-live': 'polite' });
  stage.chips.append(chipV, chipS);
  const kv = h('div', { class: 'r3-kv' }), side = h('h4');
  const toggle = (label: string, on: () => void) => { const b = h('button', { type: 'button', class: 'btn sm', 'aria-pressed': 'false' }, label) as HTMLButtonElement; b.addEventListener('click', () => { on(); repaint(); }); return b; };
  const btnFall = toggle('Outputs fall: ground bounce', () => { st.edge = 'fall'; }), btnRise = toggle('Outputs rise: supply droop', () => { st.edge = 'rise'; });
  const fill = h('i'), mark = h('b'), bar = h('div', { class: 'pk-bar', role: 'img' }, fill, mark);
  const scale = h('div', { class: 'pk-scale' }, ...([['0', 0], ['VIL', VIL], ['VIH', VIH], ['VDD', VIO]] as const).map(([t, v]) => h('span', { style: `left:${(v / VIO) * 100}%` }, t)));
  mark.style.left = `${(VIL / VIO) * 100}%`;
  const f2 = (v: number) => v.toFixed(2);

  const readout = () => {
    const v = bounceOf(st), vd = verdictOf(v), i = padSwing(), L = railL(st), rise = st.edge === 'rise';
    const pin = rise ? VCC_PIN : GND_PIN, rail = rise ? 'VCC' : 'ground', what = rise ? 'Supply droop' : 'Ground bounce';
    const railWires = bonds(st).filter((b) => b.pin === pin);
    chipV.textContent = vd === 'invalid' ? `${f2(v)} V (> VDD)` : `${f2(v)} V ${rise ? 'droop' : 'bounce'}`; chipV.className = `r3-chip ${vd === 'ok' ? 'good' : 'bad'}`;
    chipS.textContent = vd === 'ok' ? `${Math.round((v / VIL) * 100)} % of VIL` : (rise ? TEXT_RISE : TEXT)[vd]; chipS.className = `r3-chip ${vd === 'ok' ? '' : 'bad'}`;
    fill.style.width = `${Math.min(100, (v / VIO) * 100)}%`; fill.className = v >= VIL ? 'bad' : '';
    bar.setAttribute('aria-label', `${what} ${f2(v)} V against VIL ${f2(VIL)} V and VIH ${f2(VIH)} V`);
    const rows: [string, string][] = [
      ['Outputs switching', `${st.n} of ${OUTPUTS}, ${rise ? 'rising' : 'falling'} on one STCP edge`],
      ['Current per pad', `${(i * 1000).toFixed(1)} mA`],
      [`Through pin ${pin} (${rail})`, `${(st.n * i * 1000).toFixed(0)} mA in ${railWires.length > 1 ? `${railWires.length} wires` : 'one wire'}`],
      [`The ${rail} wire${railWires.length > 1 ? 's' : ''}`, railWires.map((b) => `${f2(b.len)} mm`).join(', ') + ' of 25 µm gold'],
      ['Return inductance', railWires.length > 1 ? `${railWires.map((b) => f2(b.nH)).join(' ∥ ')} = ${f2(L)} nH` : `${f2(L)} nH`],
      [what, `${f2(v)} V`], ['VIL / VIH', `${f2(VIL)} V / ${f2(VIH)} V`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, x]) => [h('span', null, k), h('span', { class: 'v' }, x)]));
    side.textContent = `The ${rail} lead `;
    side.append(h('span', { class: 'r3-badge' }, 'model'));
    for (const [btn, on] of [[btnFall, !rise], [btnRise, rise]] as const) btn.setAttribute('aria-pressed', String(on));
  };
  const repaint = () => { readout(); stage.refresh(); };
  const slider = (label: string, min: number, max: number, step: number, val: number, fmt: (v: number) => string, on: (v: number) => void) => {
    const input = h('input', { type: 'range', min, max, step, value: val, 'aria-label': label }) as HTMLInputElement;
    const out = h('output', null, fmt(val));
    input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); on(v); repaint(); });
    return h('label', { class: 'r3-sl' }, h('span', null, label), input, out);
  };
  stage.slot.append(h('div', { class: 'r3-ctl' },
    slider('Outputs', 1, OUTPUTS, 1, st.n, String, (v) => { st.n = v; }),
    slider('Wires on the rail lead', 1, MAX_BONDS, 1, st.g, String, (v) => { st.g = v; }),
    slider('Edge', 0.1, 4, 0.1, st.rise, (v) => `${v.toFixed(1)} ns`, (v) => { st.rise = v; }),
    h('div', { class: 'r3-btns' }, btnFall, btnRise)));

  panel.append(
    h('h3', { class: 'm3-title' }, 'From the pad to the pin'),
    h('p', { class: 'm3-sub' }, 'A 74HC595 shift register in its SOIC-16, opened: the die sits on a paddle, a gold bond wire runs from each pad to the finger of a lead, and the lead bends down to the board. Its eight outputs change together on one clock edge, and every falling one returns its current through the ground wire on pin 8 (every rising one draws it through the VCC wire on pin 16). Each wire\'s inductance is computed from the length drawn: a straight round wire has L ≈ 0.2 · ℓ · [ln(2ℓ / r) − 0.75] nH (ℓ and r in mm; Grover), about 1 nH per mm, and the corner pins this chip keeps for its supply have the longest wires in the package. When n outputs switch in one edge, that inductance sees n times di/dt and the chip\'s ground lifts by L · n · di/dt, the figure of the noise panel on “Crosstalk, ground bounce and pairs” at the same settings (on a rising edge the supply sags by the same formula, since VDD − VIH = VIL). More wires on the rail lead are taken in parallel, which ignores their mutual inductance: a real set does worse than the division says. Beyond VDD the linear formula is invalid.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, side, h('div', null, bar, scale), kv)));
  repaint();
  return { el: panel, destroy() { stage.destroy(); } };
}
