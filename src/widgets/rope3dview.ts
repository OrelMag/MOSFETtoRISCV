// Core rope in 3D (loaded on demand, rope3d.ts): eight cores of a Block II rope module with the wires that thread them or
// pass them by, and the module they come from. What moves is rope3dparts.ts's rule: the inhibit wires leave one core free,
// the set current switches it, the reset switches it back, and the sense wires that thread it pulse.

import { groupNum } from '../sim/numfmt';
import '../styles/rope3d.css';
import { h } from '../ui/dom';
import { reducedMotion } from '../ui/motion';
import type { Widget } from '../view/stage';
import { frameLoop } from './mosfet';
import { modelStage } from './modelstage';
import {
  BITS, CORES, CY, FIXED_WORDS, MODULE_CORES, MOD_X, MOD_Z, MODULES, SENSE_LINES, STRANDS, WORDS, WORDS_PER_CORE, WORD_BITS,
  coreX, inhibitDriven, ropeAnchors, ropeParts, senseWord, type RopePalette, type RopePhase, type RopePose,
} from './rope3dparts';

const PHASE_MS = 1200;
const CLOSE = { target: [coreX(2.5), CY - 2, 0] as [number, number, number], yaw: 0.95, pitch: 0.28, dist: 200 };
const MODULE = { target: [MOD_X, 30, MOD_Z] as [number, number, number], yaw: 0.4, pitch: 0.75, dist: 1500 };
const bits4 = (w: number) => Array.from({ length: BITS }, (_, b) => (w >> (BITS - 1 - b)) & 1).join('');

export function ropeView(): Widget {
  const phone = () => typeof matchMedia === 'function' && matchMedia('(max-width: 600px)').matches;
  const st: RopePose = { strand: 0, addr: 2, phase: 'idle', module: false };
  let t = 0, read: number | null = null;

  const panel = h('div', { class: 'panel' });
  const stage = modelStage(panel, {
    aria: 'Eight cores of an Apollo core rope module in 3D: sense wires run straight through a core for a 1 or loop round it for a 0, inhibit wires pick one core, set and reset wires switch it; and the whole module of 512 cores beside them',
    camera: { ...CLOSE },
    limits: { minDist: 120, maxDist: 2600 },
    views: [
      { label: 'Eight cores', view: CLOSE, pick: () => { st.module = false; paint(); } },
      { label: 'The module', view: MODULE, title: 'Zoom out: the module the eight cores come from', pick: () => { st.module = true; paint(); } },
    ],
    note: 'From R-700 vol. III and Ken Shirriff’s 2019 study of a Block II rope: cores of permalloy ribbon on steel bobbins 0.249 in across, 512 a module in two layers of 32 × 8, 192 sense wires past each core (12 words of 16 bits), an inhibit pair per address bit. Drawn: 8 of the 512 cores, spread far apart so the wires can be followed; 2 of the 12 strands with 4 of their 16 wires; 3 of the 8 inhibit pairs; one set and one reset wire. The bobbin’s hole and length, the wire gauge and the cores’ 8 mm pitch in the module are not sourced: they are guesses, so is the module’s outline. The contents are an example pattern. In a real rope a core holds fewer than 192 threading wires (parity: at most 180).',
    draw: () => paint(),
  });
  const palette = (): RopePalette => ({
    ribbon: stage.rgb('--rp-ribbon'), bobbin: stage.rgb('--m3-metal'), copper: stage.rgb('--rp-copper'), inhibit: stage.rgb('--rp-inhibit'), set: stage.rgb('--rp-set'),
    reset: stage.rgb('--rp-reset'), live: stage.rgb('--rp-live'), board: stage.rgb('--rp-board'), res: stage.rgb('--rp-res'), diode: stage.rgb('--rp-diode'),
    lamp: stage.rgb('--rp-live'), lampOff: stage.rgb('--rp-lamp-off'), sel: stage.rgb('--rp-sel'),
  });
  function paint(): void { stage.paint(ropeParts(st, palette()), ropeAnchors(st, phone())); }

  const chip = h('span', { class: 'r3-chip' }), kv = h('div', { class: 'r3-kv' }), live = h('p', { class: 'r3-hint', 'aria-live': 'polite' });
  stage.chips.append(chip);
  const PH: Record<RopePhase, string> = { idle: 'idle', set: 'set: the free core switches', reset: 'reset: it switches back, the threaded sense wires pulse' };
  function readout(): void {
    const inh = inhibitDriven(st.addr).map((d) => `pair ${d.k}: through the cores with address bit ${d.k} = ${d.h}`);
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
    readBtn.disabled = st.phase !== 'idle';
    coreBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === st.addr)); b.disabled = st.phase !== 'idle'; });
    strandBtns.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === st.strand)); b.disabled = st.phase !== 'idle'; });
  }
  function step(): void {
    if (st.phase === 'set') st.phase = 'reset';
    else if (st.phase === 'reset') { st.phase = 'idle'; read = senseWord(st.strand, st.addr); live.textContent = `Read core ${st.addr}, strand ${st.strand}: ${bits4(read)}. The wires that thread the core pulsed; those that pass it by did not.`; }
    t = 0; readout(); paint();
  }
  const loop = frameLoop((_n, dt) => {
    if (st.phase !== 'idle' && !reducedMotion()) { t += dt * 1000; if (t >= PHASE_MS) step(); }
    paint();
  }, () => st.phase !== 'idle' && !reducedMotion());

  const btn = (label: string, fn: () => void) => { const b = h('button', { type: 'button', class: 'btn sm' }, label) as HTMLButtonElement; b.addEventListener('click', fn); return b; };
  const readBtn = btn('Read', () => { if (st.phase !== 'idle') return; st.phase = 'set'; read = null; t = 0; live.textContent = ''; readout(); paint(); loop.kick(); });
  const nextBtn = btn('Next phase', () => { if (st.phase !== 'idle') step(); });
  const coreBtns = Array.from({ length: CORES }, (_, i) => btn(String(i), () => { st.addr = i; read = null; readout(); paint(); }));
  const strandBtns = Array.from({ length: STRANDS }, (_, i) => btn(String(i), () => { st.strand = i; read = null; readout(); paint(); }));

  panel.append(
    h('h3', { class: 'm3-title' }, 'Core rope'),
    h('p', { class: 'm3-sub' }, 'The program is in the wiring. Each sense wire runs straight through a core where its word has a 1 and loops round it where it has a 0. To read, inhibit wires carry current through every core but the addressed one, a set current then switches that one core, and a reset current switches it back: only the sense wires through it see a pulse. Several words share a core: one strand of wires per word, and a switch passes one strand to the amplifiers.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'r3-ctl' }, h('div', { class: 'r3-btns' }, readBtn, nextBtn), stage.viewBar()),
        stage.el, stage.hint, live),
      h('div', { class: 'r3-side' },
        h('h4', null, 'Core'), h('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Core' }, ...coreBtns),
        h('h4', null, 'Strand'), h('div', { class: 'rp-seg', role: 'group', 'aria-label': 'Strand' }, ...strandBtns),
        h('h4', null, 'This read ', h('span', { class: 'r3-badge' }, 'model')), kv)));
  const mq = typeof matchMedia === 'function' ? matchMedia('(max-width: 600px)') : null, onMq = () => paint();
  mq?.addEventListener?.('change', onMq);
  readout(); paint();
  return { el: panel, destroy() { mq?.removeEventListener?.('change', onMq); loop.stop(); stage.destroy(); } };
}
