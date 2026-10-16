// Chapter 32's DRAM panel: drives the switch-level array through its protocol (precharge, activate,
// sense, read / write, close, refresh), lets cycles of leakage pass, and shows what the simulator
// holds: every cell's charge, each bit line's level and its distance from VDD/2, what each sense
// amplifier latched (the row buffer), and how long ago each row was last restored.

import { CELL_C, CELL_HALFLIFE, BITLINE_C, DRAM4X4 } from '../lib/dram';
import { findNode, type HierNode } from '../sim/flatten';
import { SENSE_OFFSET, type SwitchSim, VDD_VOLTS } from '../sim/switchsim';
import { B0, B1, type ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { Scene, ScenePanel, Stage, Widget } from '../view/stage';

/** The array's own inputs: the panel drives them. */
const INPUTS = ['row', 'act', 'pre', 'sae', 'col', 'cs', 'we', 'din'];

/** Cycles a stored 1 is still read as 1 (the amplifier sees at least its offset). */
export const SAFE_CYCLES = Math.floor(CELL_HALFLIFE * Math.log2(1 / (0.5 + SENSE_OFFSET * (CELL_C + BITLINE_C) / CELL_C)));

export interface DramSceneOptions {
  /** Rows written at load (index = row, bit c = column c); absent: the cells power on unknown. */
  pattern?: number[];
  /** Open this deep (instance names). */
  path?: string[];
  highlight?: string[];
}

/** Panel state a challenge reads: cycles waited in total, per row the cycles since its last restore. */
export interface DramPanelState { waited: number; age: number[]; lastRead: number | null }
const states = new WeakMap<Stage, DramPanelState>();
export const dramState = (st: Stage): DramPanelState | undefined => states.get(st);

/** Nets and leaves the panel reads, by path in the flat design. */
function probes(sim: SwitchSim, def: ComponentDef) {
  const root = sim.design.root, R = def.ports.find((p) => p.name === 'row')!.width, C = def.ports.find((p) => p.name === 'col')!.width;
  const rows = 1 << R, cols = 1 << C;
  const netOf = (n: HierNode | null, name: string) => {
    const i = n?.def.netlist?.().nets.findIndex((x) => x.name === name) ?? -1;
    return i < 0 || !n?.nets ? -1 : n.nets[i][0];
  };
  const col = Array.from({ length: cols }, (_, c) => findNode(root, [`col${c}`]));
  return {
    rows, cols,
    cell: Array.from({ length: rows }, (_, r) => col.map((_, c) => netOf(findNode(root, [`col${c}`, `c${r}`]), 'storage'))),
    bl: col.map((n) => netOf(n, 'bl')),
    blb: col.map((n) => netOf(n, 'bl̄')),
    sa: col.map((n) => n?.children?.get('sa')?.leafIndex ?? -1),
  };
}

export function dramScene(opts: DramSceneOptions = {}): Scene {
  return {
    root: DRAM4X4,
    inputs: { row: 0, act: 0, pre: 1, sae: 0, col: 0, cs: 0, we: 0, din: 0 },
    hiddenInputs: INPUTS,
    path: opts.path,
    highlight: opts.highlight,
    panels: [dramPanel(opts)],
  };
}

const volts = (l: number) => (Number.isFinite(l) ? `${(l * VDD_VOLTS).toFixed(2)} V` : 'unknown');
const mv = (d: number) => `${d >= 0 ? '+' : '−'}${Math.abs(d * VDD_VOLTS * 1000).toFixed(0)} mV`;

function dramPanel(opts: DramSceneOptions): ScenePanel {
  return (stage: Stage): Widget => {
    const sim = () => stage.sim as SwitchSim;
    const p = probes(sim(), DRAM4X4);
    const st: DramPanelState = { waited: 0, age: new Array<number>(p.rows).fill(0), lastRead: null };
    states.set(stage, st);
    let sel = { row: 0, col: 0, din: 1 };
    let note = '';
    stage.historyHooks.add({
      save: () => ({ st: { ...st, age: st.age.slice() }, sel: { ...sel }, note }),
      restore: (s) => {
        const v = s as { st: DramPanelState; sel: typeof sel; note: string };
        Object.assign(st, { ...v.st, age: v.st.age.slice() });
        sel = { ...v.sel };
        note = v.note;
      },
    });

    const drive = (o: Record<string, number>) => {
      for (const [k, v] of Object.entries(o)) sim().setInput(k, v);
      sim().settle();
    };
    const inp = (k: string) => sim().getInput(k);
    const isOpen = () => inp('act') === 1 && inp('sae') === 1;
    /** The rows whose cells the amplifiers hold at full level right now: their age stays 0. */
    const restored = () => { if (isOpen()) st.age[inp('row')] = 0; };
    const op = (f: () => void) => () => {
      stage.checkpoint();
      note = '';
      f();
      restored();
      stage.refresh();
    };
    const precharge = () => { drive({ cs: 0, we: 0 }); drive({ act: 0 }); drive({ sae: 0 }); drive({ pre: 1 }); };
    const activate = () => {
      if (inp('act') === 1) { note = `Row ${inp('row')} is still open: close it (and precharge) first.`; return; }
      if (inp('pre') === 0) note = 'The bit lines were not precharged: what they share with the cells is whatever they held.';
      drive({ pre: 0 });
      drive({ row: sel.row, act: 1 });
    };
    const sense = () => {
      if (inp('act') === 0) note = 'No row is open: the amplifiers latch whatever the bit lines hold.';
      drive({ sae: 1 });
    };
    const read = () => {
      if (!isOpen()) { note = 'Open a row first (activate, then sense).'; return; }
      drive({ col: sel.col, cs: 1 });
      const b = sim().get(sim().design.root.ports.dout[0]);
      st.lastRead = b === B1 ? 1 : b === B0 ? 0 : -1;
      note = `Row ${inp('row')}, column ${sel.col}: ${st.lastRead < 0 ? 'X' : st.lastRead}.`;
      drive({ cs: 0 });
    };
    const write = () => {
      if (!isOpen()) { note = 'Open a row first: a write goes through the sense amplifier into the open row.'; return; }
      drive({ col: sel.col, din: sel.din, cs: 1, we: 1 });
      drive({ we: 0, cs: 0 });
    };
    const close = () => { drive({ act: 0 }); drive({ sae: 0 }); };
    const refresh = () => {
      if (inp('act') === 1) close();
      precharge();
      activate();
      drive({ sae: 1 });
      st.age[sel.row] = 0;
      close();
      precharge();
      note = `Row ${sel.row} refreshed: read into the amplifiers and written back.`;
    };
    const wait = (n: number) => () => {
      stage.checkpoint();
      sim().leak(n);
      st.waited += n;
      for (let r = 0; r < p.rows; r++) st.age[r] += n;
      restored();
      note = `${n} cycles passed.`;
      stage.refresh();
    };
    const refreshAll = () => {
      for (let r = 0; r < p.rows; r++) { sel.row = r; refresh(); }
      note = 'Every row refreshed.';
    };

    // Load: the pattern, written row by row, then precharged.
    if (opts.pattern) {
      opts.pattern.forEach((bits, r) => {
        precharge(); drive({ pre: 0 }); drive({ row: r, act: 1 }); drive({ sae: 1 });
        for (let c = 0; c < p.cols; c++) { drive({ col: c, din: (bits >> c) & 1, cs: 1, we: 1 }); drive({ we: 0, cs: 0 }); }
        close();
      });
      precharge();
    }

    const btn = (label: string, title: string, f: () => void, cls = 'btn sm') => {
      const b = h('button', { class: cls, title }, label);
      b.addEventListener('click', f);
      return b;
    };
    const seg = (name: string, n: number, get: () => number, set: (v: number) => void) => {
      const g = h('span', { class: 'seg dram-seg', role: 'group', 'aria-label': name });
      for (let i = 0; i < n; i++) {
        const b = h('button', { type: 'button' }, String(i));
        b.addEventListener('click', () => { set(i); update(); });
        g.append(b);
      }
      return { el: g, sync: () => g.querySelectorAll('button').forEach((b, i) => { b.classList.toggle('on', i === get()); b.setAttribute('aria-pressed', String(i === get())); }) };
    };
    const rowSeg = seg('Row', p.rows, () => sel.row, (v) => (sel.row = v));
    const colSeg = seg('Column', p.cols, () => sel.col, (v) => (sel.col = v));
    const dinSeg = seg('Data', 2, () => sel.din, (v) => (sel.din = v));

    const status = h('div', { class: 'dram-status' });
    const grid = h('div', { class: 'dram-grid' });
    const msg = h('div', { class: 'dram-note' });
    const title = h('h4', null, `DRAM ${p.rows} × ${p.cols}`, h('span', { class: 'fold-hint' }));
    title.addEventListener('click', () => el.classList.toggle('collapsed'));
    const body = h('div', { class: 'dram-body' },
      h('div', { class: 'dram-sel' }, h('span', null, 'row'), rowSeg.el, h('span', null, 'column'), colSeg.el, h('span', null, 'data'), dinSeg.el),
      h('div', { class: 'dram-ops' },
        btn('Precharge', 'Close nothing, equalize both bit lines of every column to VDD/2', op(precharge)),
        btn('Activate', 'Raise the selected row\'s word line: its cells share their charge with the bit lines', op(activate), 'btn sm primary'),
        btn('Sense', 'Enable the sense amplifiers: each column latches the higher line and drives both to the rails', op(sense)),
        btn('Read', 'Join the selected column to the data lines and read dout', op(read)),
        btn('Write', 'Drive the data lines: the selected column\'s amplifier flips, the open cell follows', op(write)),
        btn('Close', 'Lower the word line (the cells keep the restored charge), then release the amplifiers', op(close))),
      h('div', { class: 'dram-ops' },
        btn('Refresh row', 'Precharge, activate, sense, close: read the row and write it back, nothing out', op(refresh)),
        btn('Refresh all', 'Refresh every row', op(refreshAll)),
        btn('Wait 50 cycles', 'Let 50 clock cycles of leakage pass', wait(50)),
        btn('Wait 200', 'Let 200 clock cycles of leakage pass', wait(200))),
      status, grid, msg);
    const el = h('div', { class: 'mem-panel cpu-panel dram-panel', 'data-dock': 'right', 'data-fold': 'narrow' }, title, body);

    const update = () => {
      const s = sim();
      rowSeg.sync(); colSeg.sync(); dinSeg.sync();
      const act = inp('act'), sae = inp('sae'), pre = inp('pre'), row = inp('row');
      status.textContent = act && sae ? `Row ${row} open: the amplifiers hold it (the row buffer).`
        : act ? `Row ${row} activated, not sensed: the bit lines carry the cells' charge.`
          : pre ? 'Precharged: every bit line at VDD/2, ready to activate.'
            : sae ? 'Word lines down, the amplifiers still latched.' : 'Idle: bit lines floating.';
      grid.replaceChildren();
      const head = h('div', { class: 'dram-row head' }, h('span', { class: 'lbl' }, ''));
      for (let c = 0; c < p.cols; c++) head.append(h('span', { class: `cellh${c === sel.col ? ' sel' : ''}` }, `col ${c}`));
      head.append(h('span', { class: 'age' }, 'since restore'));
      grid.append(head);
      for (let r = 0; r < p.rows; r++) {
        const line = h('div', { class: `dram-row${r === sel.row ? ' sel' : ''}${act && r === row ? ' open' : ''}` }, h('span', { class: 'lbl' }, `row ${r}`));
        for (let c = 0; c < p.cols; c++) {
          const l = s.level(p.cell[r][c]);
          const cell = h('button', { type: 'button', class: `dcell${Number.isFinite(l) ? '' : ' x'}${r === sel.row && c === sel.col ? ' sel' : ''}`, title: `row ${r}, column ${c}: ${volts(l)}` },
            Number.isFinite(l) ? (l * VDD_VOLTS).toFixed(2) : 'X');
          if (Number.isFinite(l)) cell.style.setProperty('--lv', l.toFixed(3));
          cell.addEventListener('click', () => { sel.row = r; sel.col = c; update(); });
          line.append(cell);
        }
        const age = st.age[r];
        line.append(h('span', { class: `age${age > SAFE_CYCLES ? ' bad' : age > SAFE_CYCLES * 0.75 ? ' warn' : ''}`, title: `a 1 is read correctly for ${SAFE_CYCLES} cycles` }, `${age}`));
        grid.append(line);
      }
      // bit lines: level and distance from VDD/2 (what the amplifier sees), then what it latched
      const bl = h('div', { class: 'dram-row lines' }, h('span', { class: 'lbl' }, 'bit line'));
      const dv = h('div', { class: 'dram-row lines' }, h('span', { class: 'lbl' }, 'bl − bl̄'));
      const sa = h('div', { class: 'dram-row lines' }, h('span', { class: 'lbl' }, 'amplifier'));
      for (let c = 0; c < p.cols; c++) {
        const a = s.level(p.bl[c]), b = s.level(p.blb[c]);
        bl.append(h('span', { class: 'v' }, volts(a)));
        const d = a - b;
        dv.append(h('span', { class: `v${Number.isFinite(d) && Math.abs(d) < SENSE_OFFSET ? ' bad' : ''}` }, Number.isFinite(d) ? mv(d) : '·'));
        const k = p.sa[c] < 0 ? -1 : s.senseState(p.sa[c]);
        sa.append(h('span', { class: `v${k === 2 ? ' bad' : ''}` }, k < 0 ? 'off' : k === 2 ? 'X' : String(k)));
      }
      grid.append(bl, dv, sa);
      msg.textContent = note || `A stored 1 is read correctly for ${SAFE_CYCLES} cycles after its last restore (Cs ${CELL_C} fF, Cb ${BITLINE_C} fF, offset ${Math.round(SENSE_OFFSET * VDD_VOLTS * 1000)} mV).`;
    };
    update();
    return { el, update, destroy: () => states.delete(stage) };
  };
}
