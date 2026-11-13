// The 3D NAND string in 3D (loaded on demand, modelhost.ts): a block of Samsung's 32-layer V-NAND cut through one row of holes;
// the chosen pillar runs on phys/fgate.ts's rules (the same as the chapter's planar string and Ross's floating-gate model),
// widgets/nand3dkit.ts draws it.

import '../styles/nand3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { studioStage } from './studiostage';
import { NAND_HOME, RING_BEATS, freshString, nandModel, type NandState } from './nand3dkit';
import { CORE_NM, HOLE_NM, ONO_NM, LEVELS, PITCH_NM, STAIR_K, WORD_LINES } from '../flash/string3d';
import { V_READ, vtOf } from '../lib/flash';
import { PASS_V, PULSES_TO_PROGRAM, electrons, erase, program, readConduction, stringConducts } from '../phys/fgate';

export function nandView(): Widget {
  const s: NandState = { bank: freshString(), reading: false };
  const stage = studioStage({
    aria: `A block of 3D NAND flash in 3D: ${LEVELS.length} levels of tungsten word lines and oxide pierced by round channel holes, cut through one row; each hole is a string of ${WORD_LINES} cells`,
    home: NAND_HOME,
    aspect: 1.5,
    knobs: { cut: 1 },
    scaleBar: (len) => (len >= 100 ? `${len / 100} µm` : `${len * 10} nm`),
    limits: { minDist: 12, maxDist: 2000 },
    note: `Samsung's second-generation V-NAND (32 word lines, 38 levels), to scale from TechInsights' cross-sections: a ${HOLE_NM} nm hole, a ${CORE_NM} nm core, layers ${PITCH_NM} nm apart (the figure published for the 128-layer part). The split of the ${ONO_NM} nm ONO, the select gates' shape and the bit lines are typical; the staircase is drawn ${STAIR_K} times shorter than its 20 µm. The chosen pillar follows the chapter's rules; the others are drawn.`,
    build: (detail) => nandModel(s, detail),
    // the cell beats cut across the chosen word line, the rest down through the row
    onBeat: (i) => { const c = RING_BEATS.includes(i) ? 'ring' : 'section'; if (c !== (s.cut ?? 'section')) { s.cut = c; paint(); } },
  });

  const kv = h('div', { class: 'r3-kv' }), chip = h('span', { class: 'r3-chip' });
  stage.chips.append(chip);
  function readout(): void {
    const b = s.bank, q = b.q[b.sel], on = stringConducts(b), off = readConduction(b).filter((c) => !c).length;
    const rows: [string, string][] = [
      ['Chosen cell', `word line ${b.sel} of ${WORD_LINES}`],
      ['Its charge', `${(q * 100).toFixed(0)} % (${electrons(q)} electrons drawn)`],
      ['Its threshold', `${vtOf(q).toFixed(1)} V (read at ${V_READ} V)`],
      ['Others', `at the pass voltage, ${PASS_V} V: on whatever they hold`],
      ['Pulses to program', `${PULSES_TO_PROGRAM} from erased`],
      ['String', s.reading ? (on ? 'conducts: reads 1 (erased)' : `blocked by ${off} cell${off === 1 ? '' : 's'}: reads 0`) : 'not being read'],
    ];
    kv.replaceChildren(...rows.flatMap(([k, v]) => [h('span', null, k), h('span', { class: 'v' }, v)]));
    chip.className = `r3-chip ${s.reading ? (on ? 'good' : 'bad') : ''}`;
    chip.textContent = s.reading ? (on ? 'string conducts: 1' : 'string blocked: 0') : `word line ${b.sel}`;
  }
  const paint = () => { stage.refresh(); readout(); };

  const wlIn = h('input', { type: 'range', min: 0, max: WORD_LINES - 1, step: 1, value: s.bank.sel, 'aria-label': 'Word line' }) as HTMLInputElement;
  const wlOut = h('output', null, String(s.bank.sel));
  wlIn.addEventListener('input', () => { s.bank = { ...s.bank, sel: Number(wlIn.value) }; wlOut.textContent = wlIn.value; paint(); });
  const btn = (text: string, cls = 'btn sm') => h('button', { type: 'button', class: cls }, text) as HTMLButtonElement;
  const pgm = btn('Program pulse', 'btn sm primary'), ers = btn('Erase block'), rd = btn('Read');
  rd.setAttribute('aria-pressed', 'false');
  pgm.addEventListener('click', () => { s.bank = program(s.bank); paint(); });
  ers.addEventListener('click', () => { s.bank = erase(s.bank); paint(); });
  rd.addEventListener('click', () => { s.reading = !s.reading; rd.setAttribute('aria-pressed', String(s.reading)); rd.textContent = s.reading ? 'Stop reading' : 'Read'; paint(); });
  stage.slot.append(h('div', { class: 'r3-ctl' },
    h('label', { class: 'r3-sl' }, h('span', null, 'Word line'), wlIn, wlOut),
    h('div', { class: 'r3-btns' }, pgm, ers, rd)));

  const panel = h('div', { class: 'panel m3d n3' },
    h('h3', { class: 'm3-title' }, 'The string stood up'),
    h('p', { class: 'm3-sub' }, `A block of 3D NAND, cut through one row of holes. Each hole is a string of ${WORD_LINES} cells; each tungsten plate it passes through is one word line. Pick a word line, give it program pulses, and read.`),
    stage.el,
    h('div', { class: 'n3-below' }, h('h4', null, 'The chosen string ', h('span', { class: 'r3-badge' }, 'model')), kv));
  paint();
  return { el: panel, destroy() { stage.destroy(); } };
}
