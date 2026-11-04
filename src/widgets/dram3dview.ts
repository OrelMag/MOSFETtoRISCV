// The DRAM array in 3D (loaded on demand, modelhost.ts). A SwitchSim of the chapter's 4 x 4 array (dram3dbench.ts) steps
// through the panel's protocol when the learner presses a button; the heights are its `level`s, read back after each step.
// It opens with the pattern stored and row 0 activated, so the first frame is charge sharing. Nothing runs per frame.

import '../styles/dram3d.css';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import { VDD_VOLTS } from '../sim/switchsim';
import { SAFE_CYCLES } from './dram';
import { DramBench } from './dram3dbench';
import { dramAnchors, dramParts, type DramPalette } from './dram3dparts';
import { modelStage } from './modelstage';

const mv = (d: number) => (Number.isFinite(d) ? `${d >= 0 ? '+' : '−'}${Math.abs(d * VDD_VOLTS * 1000).toFixed(0)} mV` : 'unknown');
const volts = (l: number) => (Number.isFinite(l) ? `${(l * VDD_VOLTS).toFixed(2)} V` : 'unknown');

export function dramView(): Widget {
  const bench = new DramBench();
  bench.write();
  bench.activate(0);
  let row = 0;
  const panel = h('div', { class: 'panel' });
  const palette = (): DramPalette => ({
    plate: stage.rgb('--m3-dram-plate'), line: stage.rgb('--m3-dram-line'), wl: stage.rgb('--m3-dram-wl'), charge: stage.rgb('--m3-dram-charge'),
    open: stage.rgb('--m3-dram-open'), bl: stage.rgb('--m3-dram-bl'), unknown: stage.rgba('--m3-dram-x', 0.45),
  });
  const draw = () => stage.paint(dramParts(bench.snap(), palette()), dramAnchors(bench.snap()));
  const stage = modelStage(panel, {
    aria: 'A 4 by 4 DRAM array in 3D: a column on every cell and bit line whose height is its charge',
    camera: { target: [0, 5, -6], yaw: -0.3, pitch: 0.5, dist: 94 },
    limits: { minDist: 50, maxDist: 260 },
    note: 'Heights are the simulator’s charge levels. A column’s footprint is proportional to its capacitance, so volume is charge. The array is 4 by 4 and the grid pitch is exaggerated.',
    draw,
  });
  const chipA = h('span', { class: 'r3-chip' }), chipB = h('span', { class: 'r3-chip' });
  stage.chips.append(chipA, chipB);
  const kv = h('div', { class: 'r3-kv' }), note = h('div', { class: 'dr-note', 'aria-live': 'polite' });

  const repaint = () => {
    const s = bench.snap();
    const phase = s.open >= 0 && s.sensed ? `row ${s.open} open, sensed` : s.open >= 0 ? `row ${s.open} activated: charge shared` : s.precharged ? 'precharged' : s.sensed ? 'word lines down, amplifiers latched' : 'idle';
    chipA.textContent = phase; chipA.className = 'r3-chip';
    const age = s.age[row];
    chipB.textContent = `row ${row}: ${age} cycles since restore`; chipB.className = `r3-chip ${age > SAFE_CYCLES ? 'bad' : age > SAFE_CYCLES * 0.75 ? 'warn' : 'good'}`;
    const rows: [string, string, string?][] = s.dv.map((d, c) => [`bl − blb, col ${c}`, mv(d), Number.isFinite(d) ? '' : 'bad']);
    s.cell[row].forEach((l, c) => rows.push([`cell ${row},${c}`, volts(l), Number.isFinite(l) ? '' : 'bad']));
    rows.push(['Readable for', `${SAFE_CYCLES} cycles`]);
    kv.replaceChildren(...rows.flatMap(([k, v, cls]) => [h('span', null, k), h('span', { class: `v ${cls ?? ''}` }, v)]));
    note.textContent = bench.note || 'Press Sense: the amplifiers push every column of the open row to a rail, which restores the charge the read destroyed.';
    draw();
  };
  const op = (f: () => void) => () => { f(); repaint(); };
  const btn = (label: string, title: string, f: () => void) => {
    const b = h('button', { type: 'button', class: 'btn sm', title }, label);
    b.addEventListener('click', op(f));
    return b;
  };
  const seg = h('span', { class: 'dr-seg', role: 'group', 'aria-label': 'Row' }, h('span', null, 'Row'));
  const rowBtns = [0, 1, 2, 3].map((r) => {
    const b = h('button', { type: 'button', class: 'btn sm' }, String(r)) as HTMLButtonElement;
    b.addEventListener('click', () => { row = r; sync(); repaint(); });
    seg.append(b);
    return b;
  });
  const sync = () => rowBtns.forEach((b, r) => { b.classList.toggle('on', r === row); b.setAttribute('aria-pressed', String(r === row)); });
  sync();

  panel.append(
    h('h3', { class: 'm3-title' }, 'The array, live'),
    h('p', { class: 'm3-sub' }, 'Each column is a charge: a cell’s 25 fF capacitor or a 100 fF bit line, standing as high as its voltage. Activate a row and its cells pour into the bit lines until both stand level; the amplifier then pulls the pair to a rail and the cells refill. Wait and every 1 sinks; refresh before it falls below the amplifier’s offset.'),
    h('div', { class: 'r3' },
      h('div', { class: 'r3-main' },
        h('div', { class: 'dr-ops' }, seg,
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
        stage.el, stage.hint, h('div', { class: 'r3-btns' }, stage.resetBtn)),
      h('div', { class: 'r3-side' }, h('h4', null, 'The open row ', h('span', { class: 'r3-badge' }, 'simulator')), kv, note)));
  repaint();
  return { el: panel, destroy() { stage.destroy(); } };
}
