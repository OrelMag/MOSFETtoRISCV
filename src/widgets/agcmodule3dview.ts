// The AGC's logic module in 3D (loaded on demand, agcmodule3d.ts), on the studio renderer: the logic tray, one module
// cut open to its sixty flatpacks a board, one flatpack to its drawing, and its die with the gate a / b / c drive
// (agcmodule3dgeom.ts: the gate's rule and the counts, tested against lib/agcnor.ts).

import '../styles/agcmodule3d.css';
import { h } from '../ui/dom';
import { groupNum } from '../sim/numfmt';
import type { Widget } from '../view/stage';
import { studioStage } from './studiostage';
import { AGC_HOME, agcModel, type AgcPose, type AgcView } from './agcmodule3dkit';
import { ADDER_GATES, ADDER_PACKAGES, GATE_NPN, GATE_RES, MAG, MODULE_GATES, PACKAGES, REG_GATES, REG_PACKAGES, norOut } from './agcmodule3dgeom';

const VIEWS: [AgcView, string][] = [['tray', 'Tray'], ['module', 'Module'], ['package', 'Flatpack'], ['gate', 'Gate']];

export function agcModuleView(): Widget {
  const st: AgcPose = { view: 'module', ins: [0, 0, 0], adder: true };
  const panel = h('div', { class: 'panel agm3', 'data-view': st.view });
  const stage = studioStage({
    aria: 'An Apollo Guidance Computer Block II logic module in 3D: the logic tray of modules, one module cut open to its two boards of sixty flatpacks, one flatpack with its ten leads and its die, and the die enlarged to the three transistors and four resistors of one NOR gate',
    home: AGC_HOME.module,
    fit: false,
    aspect: 1.45,
    knobs: { cut: 1, explode: 1 },
    limits: { minDist: 6, maxDist: 2400, maxPan: 1200 },
    scaleBar: (len) => (st.view === 'gate' ? `${groupNum(Math.round((len / MAG) * 1000))} µm (die ×${MAG})` : `${groupNum(len)} mm`),
    note: `The flatpack is to MIT drawing 1006321; the module’s outline, its 120 packages and 240 NOR gates are sourced. Typical, and drawn: the packages’ spacing, the board’s layers, the connector, the potting’s colour, and the die, drawn ${MAG} times life. Which packages the adder uses is not known here: it lights the first ${ADDER_PACKAGES}.`,
    noteMore: `The flatpack is to MIT / MSC drawing 1006321 (the dual NOR gate's specification control drawing): body 0.275 × 0.190 in at most, 0.070 in high, ten gold-plated leads 0.050 in apart, a keying stripe at the pin 1 end, pin 5 ground and pin 10 the supply. Two boards of sixty chips, 240 NOR gates a module, and A8–A11 as the four arithmetic modules are from Ken Shirriff's study of the AGC (2019); the module's outline, 5/8 × 9 5/8 × 1 3/4 in, from the Computer History Museum's record of one. Typical, and drawn: the packages' spacing on the board, the board's layers (one slab here), the connector's pins, the potting's colour, the tray around the modules, the die's size and layout (a gate as R-700 and drawing 2005011 describe it: three NPN transistors, collectors joined under one collector resistor, a base resistor on each input), drawn ${MAG} times life. The adder's packages are the first ${ADDER_PACKAGES} on the board: which ones they are is not known here.`,
    build: (detail) => agcModel(st, detail),
  });
  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  function readout(): void {
    const y = norOut(...st.ins);
    const rows: [string, string][] = [
      ['A flatpack', '2 NOR gates: 6 transistors, 8 resistors'],
      ['A gate', `${GATE_NPN} transistors, ${GATE_RES} resistors`],
      ['A module', `${PACKAGES} flatpacks on 2 boards = ${MODULE_GATES} gates`],
      ['The 4-bit adder', `${ADDER_GATES} gates = ${ADDER_PACKAGES} flatpacks`],
      ['A 4-bit register', `${REG_GATES} gates = ${REG_PACKAGES} flatpacks`],
      ['Gate 1 now', `a ${st.ins[0]}, b ${st.ins[1]}, c ${st.ins[2]} → y = ${y}`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    chip.textContent = st.view === 'gate' ? `y = ${y}` : st.view === 'module' && st.adder ? `adder: ${ADDER_PACKAGES} packages` : `${MODULE_GATES} gates a module`;
    chip.className = `r3-chip ${st.view === 'gate' && y === 0 ? 'warn' : 'good'}`;
    viewBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(VIEWS[i][0] === st.view)));
    inBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(st.ins[i] === 1)); b.textContent = `${'abc'[i]} = ${st.ins[i]}`; });
    adderBtn.setAttribute('aria-pressed', String(st.adder));
  }
  const paint = () => { stage.refresh(); readout(); };
  const btn = (label: string, fn: () => void, aria?: string) => { const b = h('button', { type: 'button', class: 'btn sm', ...(aria ? { 'aria-label': aria } : {}) }, label) as HTMLButtonElement; b.addEventListener('click', fn); return b; };
  const setView = (v: AgcView) => { st.view = v; panel.dataset.view = v; paint(); stage.goTo(AGC_HOME[v]); };
  const viewBtns = VIEWS.map(([v, label]) => btn(label, () => setView(v)));
  const inBtns = [0, 1, 2].map((i) => btn('', () => {
    st.ins[i] = st.ins[i] ? 0 : 1; paint();
    const y = norOut(...st.ins);
    live.textContent = y ? 'Every input is 0: no transistor conducts, and the collector resistor pulls y up to 1.' : `Input ${'abc'[i]} is ${st.ins[i]}; ${st.ins.filter(Boolean).length > 1 ? `${st.ins.filter(Boolean).length} transistors conduct` : 'one transistor conducts'}, pulling y to 0.`;
  }, `Input ${'abc'[i]}`));
  const adderBtn = btn('Light the adder', () => { st.adder = !st.adder; paint(); });
  stage.slot.append(
    h('div', { class: 'r3-ctl' },
      h('div', { class: 'agm-views', role: 'group', 'aria-label': 'View' }, ...viewBtns),
      h('div', { class: 'r3-btns agm-ins', role: 'group', 'aria-label': 'Gate 1 inputs' }, ...inBtns),
      h('div', { class: 'r3-btns agm-adder' }, adderBtn)),
    live);
  panel.append(
    h('h3', { class: 'm3-title' }, 'A logic module'),
    h('p', { class: 'm3-sub' }, `Every gate of this appendix is the same small part: a dual three-input NOR in a flatpack a quarter of an inch long. A module holds ${PACKAGES} of them on two boards, ${MODULE_GATES} gates, and the logic tray holds the modules. Go from the tray to the module, one flatpack and its die; on the die, set a, b and c and watch the gate.`),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, h('h4', null, 'Counted ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout();
  return { el: panel, destroy() { stage.destroy(); } };
}
