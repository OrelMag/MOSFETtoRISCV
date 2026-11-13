// The DRAM array in 3D on the studio renderer (dram3dkit.ts; loaded on demand, modelhost.ts). A SwitchSim of the chapter's 4 x 4 array (dram3dbench.ts) steps
// through the panel's protocol when the learner presses a button; the heights are its `level`s, read back after each step.
// It opens with the pattern stored and row 0 activated, so the first frame is charge sharing. Nothing runs per frame.
// The learner can make the bit lines longer (more capacitance against the same cell) and watch the swing shrink until the
// amplifier cannot tell a 1 from a 0.

import '../styles/dram3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import type { OrbitView } from '../gl/camera';
import { SENSE_OFFSET, VDD_VOLTS } from '../sim/switchsim';
import { CELL_HALFLIFE } from '../lib/dram';
import { DramBench, RATIO, RATIOS, safeCyclesOf, swingOf } from './dram3dbench';
import { LINE_Z0, lineLength, Z_OF } from './dram3dparts';
import { DRAM_ASPECT, DRAM_HOME, dramModel } from './dram3dkit';
import { studioStage } from './studiostage';

const mv = (d: number) => (Number.isFinite(d) ? `${d >= 0 ? '+' : '−'}${Math.abs(d * VDD_VOLTS * 1000).toFixed(0)} mV` : 'unknown');
const volts = (l: number) => (Number.isFinite(l) ? `${(l * VDD_VOLTS).toFixed(2)} V` : 'unknown');
const mvOf = (frac: number) => `${(frac * VDD_VOLTS * 1000).toFixed(frac * VDD_VOLTS * 1000 < 20 ? 1 : 0)} mV`;

/** The whole array in view, the lines as long as the ratio makes them. */
function viewFor(ratio: number): OrbitView {
  const zf = Z_OF(0) + 7, zb = LINE_Z0 - lineLength(ratio) - 4, depth = zf - zb;
  return { target: [6, 2, (zf + zb) / 2 + 4], yaw: 2.55, pitch: 0.62, dist: 48 + 1.25 * depth };
}

export function dramView(): Widget {
  let ratio: number = RATIO, bench = new DramBench(ratio);
  const fresh = () => { bench = new DramBench(ratio); bench.write(); bench.activate(0); };
  fresh();
  let row = 0;
  const panel = h('div', { class: 'panel dr3' });
  const stage = studioStage({
    aria: 'A 4 by 4 DRAM array in 3D: a well of charge on every cell and a trough for every bit line, each as high as its voltage',
    home: DRAM_HOME, aspect: DRAM_ASPECT,
    limits: { minDist: 20, maxDist: 900 },
    note: `Heights are the simulator’s charge levels and footprints are proportional to capacitance, so volume is charge: a 25 fF cell is a column, a bit line a trough as long as its capacitance. The chapter’s array is 4 × 4 with bit lines 4 × a cell, and each reference line is a line with no cells (on a chip it is another bit line: its folded twin or the neighbouring mat’s); real arrays hang hundreds of cells on a line and run about 10 × (Keeth, Baker, Johnson & Lin, DRAM Circuit Design, 2nd ed., ch. 2). The grid pitch is exaggerated. Leakage is exponential with a ${CELL_HALFLIFE}-cycle half-life standing for tens of milliseconds: a real array refreshes every row within 64 ms (JEDEC DDR4 tREFW). The word line of an open row is drawn up; on a chip it is boosted above VDD + VT so the access transistor passes a full 1.`,
    build: (detail) => dramModel(bench.snap(), detail),
  });
  const draw = () => stage.refresh();
  const chip = h('span', { class: 'r3-chip' });
  stage.chips.append(chip);
  const kv = h('div', { class: 'r3-kv' }), note = h('div', { class: 'dr-note', 'aria-live': 'polite' });

  const repaint = () => {
    const s = bench.snap(), safe = safeCyclesOf(s.ratio), oldest = Math.max(...s.age);
    const phase = s.open >= 0 && s.sensed ? `row ${s.open} open, sensed` : s.open >= 0 ? `row ${s.open} activated: charge shared` : s.precharged ? 'precharged' : s.sensed ? 'word lines down, amplifiers latched' : 'idle';
    chip.textContent = phase;
    chip.className = `r3-chip ${oldest > safe ? 'bad' : oldest > safe * 0.75 ? 'warn' : ''}`;
    const rows: [string, string, string?][] = [
      ['Bit line', `${s.ratio}× a cell, swing ±${mvOf(swingOf(s.ratio))}`, swingOf(s.ratio) <= SENSE_OFFSET ? 'bad' : ''],
      ['Amplifier offset', mvOf(SENSE_OFFSET)],
    ];
    s.dv.forEach((d, c) => rows.push([`bl − blb, col ${c}`, mv(d), Number.isFinite(d) ? '' : 'bad']));
    s.cell[row].forEach((l, c) => rows.push([`cell ${row},${c}`, volts(l), Number.isFinite(l) ? '' : 'bad']));
    s.age.forEach((a, r) => rows.push([`row ${r}, cycles since restore`, `${a}`, a > safe ? 'bad' : '']));
    rows.push(['A 1 is readable for', safe ? `${safe} cycles` : 'never: under the offset']);
    kv.replaceChildren(...rows.flatMap(([k, v, cls]) => [h('span', null, k), h('span', { class: `v ${cls ?? ''}` }, v)]));
    note.textContent = bench.note || 'Press Sense: the amplifiers push every column of the open row to a rail, which restores the charge the read destroyed.';
    draw();
  };
  const op = (f: () => void) => () => { f(); repaint(); };
  const btn = (label: string, title: string, f: () => void) => {
    const b = h('button', { type: 'button', class: 'btn sm', title }, label);
    b.addEventListener('click', op(() => f()));
    return b;
  };
  const segOf = (label: string, values: readonly number[], text: (v: number) => string, get: () => number, set: (v: number) => void) => {
    const seg = h('span', { class: 'dr-seg', role: 'group', 'aria-label': label }, h('span', null, label));
    const btns = values.map((v) => {
      const b = h('button', { type: 'button', class: 'btn sm' }, text(v)) as HTMLButtonElement;
      b.addEventListener('click', () => { set(v); sync(); repaint(); });
      seg.append(b);
      return b;
    });
    const sync = () => btns.forEach((b, i) => { const on = values[i] === get(); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    sync();
    return seg;
  };
  const rowSeg = segOf('Row', [0, 1, 2, 3], String, () => row, (r) => { row = r; });
  const ratioSeg = segOf('Bit line', RATIOS, (k) => `${k}×`, () => ratio, (k) => { ratio = k; fresh(); stage.goTo(viewFor(k)); });

  panel.append(
    h('h3', { class: 'm3-title' }, 'The array, live'),
    h('p', { class: 'm3-sub' }, 'Each solid is a charge: a cell’s 25 fF capacitor is a column, a bit line a trough as long as its capacitance, each standing as high as its voltage. Activate a row and its cells pour into the bit lines until both stand level, a little above or below the reference line beside them; the amplifier at the head of each pair then pulls the two to opposite rails and the cells refill. Wait and every 1 sinks; refresh before it falls below the amplifier’s offset. Make the bit lines longer, as on a real chip with hundreds of cells to a line, and the swing a cell can make shrinks until the amplifier cannot tell.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'dr-ops' }, rowSeg,
          btn('Precharge', 'Close nothing: equalize every bit line to VDD/2', () => bench.precharge()),
          btn('Activate', 'Raise the selected row’s word line: its cells share their charge with the bit lines', () => bench.activate(row)),
          btn('Sense', 'Enable the amplifiers: each column latches the higher line and drives both to the rails', () => bench.sense()),
          btn('Close', 'Lower the word line, then release the amplifiers', () => bench.close())),
        h('div', { class: 'dr-ops' },
          btn('Write pattern', 'Store the pattern again, row by row', () => bench.write()),
          btn('Wait 50', 'Let 50 cycles of leakage pass', () => bench.wait(50)),
          btn('Wait 200', 'Let 200 cycles of leakage pass', () => bench.wait(200)),
          btn('Refresh row', 'Precharge, activate, sense, close the selected row', () => bench.refresh(row)),
          btn('Refresh all', 'Refresh every row', () => bench.refreshAll())),
        h('div', { class: 'dr-ops' }, ratioSeg)),
      h('div', { class: 'r3-side' }, h('h4', null, 'The open row ', h('span', { class: 'r3-badge' }, 'simulator')), kv, note)));
  // the protocol's controls under the canvas, in the stage's slot; the canvas takes the main column
  const main = panel.querySelector('.r3-main')!;
  stage.slot.append(...main.querySelectorAll(':scope > .dr-ops'));
  main.append(stage.el);
  repaint();
  return { el: panel, destroy() { stage.destroy(); } };
}
