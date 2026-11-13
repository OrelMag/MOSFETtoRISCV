// Core rope in 3D (loaded on demand, rope3d.ts), on the studio renderer: eight cores of a Block II rope module with the
// wires that thread them or pass them by, and the module they come from. What moves is rope3dgeom.ts's rule: the inhibit
// wires leave one core free, the set current switches it, the reset switches it back, and the sense wires that thread it pulse.

import { groupNum } from '../sim/numfmt';
import '../styles/rope3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { studioStage } from './studiostage';
import { ROPE_HOME, ropeModel } from './rope3dkit';
import {
  BITS, CORES, FIXED_WORDS, MODULE_CORES, MODULES, SENSE_LINES, STRANDS, UNIT_MM, WORDS, WORDS_PER_CORE, WORD_BITS,
  inhibitDriven, senseWord, type RopePhase, type RopePose,
} from './rope3dgeom';

const PHASE_MS = 1200;
const bits4 = (w: number) => Array.from({ length: BITS }, (_, b) => (w >> (BITS - 1 - b)) & 1).join('');

export function ropeView(): Widget {
  const st: RopePose = { strand: 0, addr: 2, phase: 'idle', module: false };
  let t = 0, read: number | null = null;

  const panel = h('div', { class: 'panel rp3', 'data-view': 'close' });
  const stage = studioStage({
    aria: 'Eight cores of an Apollo core rope module in 3D: sense wires run straight through a core for a 1 or loop round it for a 0, inhibit wires pick one core, set and reset wires switch it; and the whole module of 512 cores',
    home: ROPE_HOME.close,
    fit: false,
    aspect: 1.6,
    limits: { minDist: 60, maxDist: 1400, maxPan: 400 },
    scaleBar: (len) => `${groupNum(len * UNIT_MM)} mm`,
    note: 'From R-700 vol. III and Ken Shirriff’s 2019 study of a Block II rope: cores of permalloy ribbon on steel bobbins 0.249 in across, 512 a module in two layers of 32 × 8, 192 sense wires past each core (12 words of 16 bits), an inhibit pair per address bit. Drawn: 8 of the 512 cores, spread far apart so the wires can be followed; 2 of the 12 strands with 4 of their 16 wires; 3 of the 8 inhibit pairs; one set and one reset wire. The bobbin’s hole, flanges and length, the wire gauge, the frame the cores stand in and the cores’ 8 mm pitch in the module are not sourced: they are guesses, so is the module’s outline. The contents are an example pattern. In a real rope a core holds fewer than 192 threading wires (parity: at most 180).',
    build: (detail) => ropeModel(st, detail),
  });
  function paint(): void { stage.refresh(); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const PH: Record<RopePhase, string> = { idle: 'idle', set: 'set: the free core switches', reset: 'reset: it switches back, the threaded sense wires pulse' };
  function readout(): void {
    const inh = inhibitDriven(st.addr).map((d: { k: number; h: number }) => `pair ${d.k}: through the cores with address bit ${d.k} = ${d.h}`);
    const rows: [string, string][] = [
      ['Word', `core ${st.addr}, strand ${st.strand}: ${bits4(WORDS[st.strand][st.addr])} (example)`],
      ['Phase', PH[st.phase]],
      ['Inhibit current', st.phase === 'set' ? inh.join('; ') : 'off'],
      ['Read', read === null ? 'not yet' : `${bits4(read)}: the wires that thread core ${st.addr}`],
      ['A module', `${MODULE_CORES} cores × ${WORDS_PER_CORE} words a core = ${groupNum(MODULE_CORES * WORDS_PER_CORE)} words of ${WORD_BITS} bits (${SENSE_LINES} sense wires a core); ${MODULES} modules = ${groupNum(FIXED_WORDS)} words`],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    chip.textContent = st.phase === 'idle' ? 'Idle' : st.phase === 'set' ? 'Set' : 'Reset';
    chip.className = `r3-chip ${st.phase === 'idle' ? 'good' : 'warn'}`;
    readBtn.disabled = st.phase !== 'idle' || st.module;
    nextBtn.disabled = st.module;
    coreBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === st.addr)); b.disabled = st.phase !== 'idle'; });
    strandBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === st.strand)); b.disabled = st.phase !== 'idle'; });
    viewBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 1) === st.module)));
  }
  function step(): void {
    if (st.phase === 'set') st.phase = 'reset';
    else if (st.phase === 'reset') {
      st.phase = 'idle'; read = senseWord(st.strand, st.addr);
      live.textContent = `Read core ${st.addr}, strand ${st.strand}: ${bits4(read)}. The wires that thread the core pulsed; those that pass it by did not.`;
    }
    t = 0; readout(); paint();
  }
  const loop = frameLoop((_n, dt) => {
    if (st.phase !== 'idle' && !reducedMotion()) { t += dt * 1000; if (t >= PHASE_MS) step(); }
  }, () => st.phase !== 'idle' && !reducedMotion());

  const btn = (label: string, fn: () => void, aria?: string) => { const b = h('button', { type: 'button', class: 'btn sm', ...(aria ? { 'aria-label': aria } : {}) }, label) as HTMLButtonElement; b.addEventListener('click', fn); return b; };
  const readBtn = btn('Read', () => { if (st.phase !== 'idle') return; st.phase = 'set'; read = null; t = 0; live.textContent = ''; readout(); paint(); loop.kick(); });
  const nextBtn = btn('Next phase', () => { if (st.phase !== 'idle') step(); });
  const coreBtns = Array.from({ length: CORES }, (_, i) => btn(String(i), () => { st.addr = i; read = null; readout(); paint(); }, `Core ${i}`));
  const strandBtns = Array.from({ length: STRANDS }, (_, i) => btn(String(i), () => { st.strand = i; read = null; readout(); paint(); }, `Strand ${i}`));
  const setView = (module: boolean) => {
    st.module = module; st.phase = 'idle'; panel.dataset.view = module ? 'module' : 'close';
    readout(); paint(); stage.goTo(ROPE_HOME[module ? 'module' : 'close']);
  };
  const viewBtns = [btn('Eight cores', () => setView(false)), btn('The module', () => setView(true), 'Zoom out: the module the eight cores come from')];

  stage.slot.append(
    h('div', { class: 'r3-ctl' }, h('div', { class: 'rp-views', role: 'group', 'aria-label': 'View' }, ...viewBtns), h('div', { class: 'r3-btns' }, readBtn, nextBtn)),
    h('div', { class: 'r3-ctl rp-pick' },
      h('span', { class: 'rp-lab' }, 'Core'), h('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Core' }, ...coreBtns),
      h('span', { class: 'rp-lab' }, 'Strand'), h('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Strand' }, ...strandBtns)),
    live);
  panel.append(
    h('h3', { class: 'm3-title' }, 'Core rope'),
    h('p', { class: 'm3-sub' }, 'The program is in the wiring. Each sense wire runs straight through a core where its word has a 1 and loops round it where it has a 0. To read, inhibit wires carry current through every core but the addressed one, a set current then switches that one core, and a reset current switches it back: only the sense wires through it see a pulse. Several words share a core: one strand of wires per word, and a switch passes one strand to the amplifiers. The cut opens the cores along their axis.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' }, stage.el),
      h('div', { class: 'r3-side' }, h('h4', null, 'This read ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  readout(); paint();
  return { el: panel, destroy() { loop.stop(); stage.destroy(); } };
}
