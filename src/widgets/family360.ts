// Chapter multicycle's last step: one instruction set, four implementations. Every number is read from the saved
// benchmark results (bench/results.json) and the microcode table; nothing is measured or typed here.

import { COMMON, RESULTS, front, meanOf, type BenchCpu } from '../bench/summary';
import { groupDigits } from '../sim/numfmt';
import { MC_PROGRAM } from '../lib/multicycle';
import { WORD_BITS } from '../lib/ucode';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

/** The four RV32I implementations of the chapters, all with the fast (Kogge-Stone) adders so the periods compare. */
export const FAMILY_360: { id: string; label: string }[] = [
  { id: 'sc-ks', label: 'Single-cycle, hardwired' },
  { id: 'mc-fsm', label: 'Multicycle, hardwired FSM' },
  { id: 'mc-micro', label: 'Multicycle, microcoded' },
  { id: 'pipe-ks', label: 'Pipelined' },
];

export interface FamilyRow { id: string; label: string; nands: number; period: number; cpi: number; delaysPerInstr: number; nsPerInstr: number; onFront: boolean }

/** Cost (NANDs without the program ROM), CPI and time per instruction (NAND delays), geometric means over the four programs. */
export function familyRows(): FamilyRow[] {
  const cpus = FAMILY_360.map((f) => RESULTS.cpus.find((c) => c.id === f.id)!);
  const fr = new Set<BenchCpu>(front(cpus));
  return FAMILY_360.map((f, i) => {
    const c = cpus[i], cpi = meanOf(c, 'cpi');
    return { id: f.id, label: f.label, nands: c.nands, period: c.period, cpi, delaysPerInstr: cpi * c.period, nsPerInstr: (cpi * c.period * RESULTS.psPerNand) / 1000, onFront: fr.has(c) };
  });
}

/** The microcode store: words x bits (control 14, next 4, mode 2), as the microcoded controller's ROM holds them. */
export const microStore = () => ({ words: MC_PROGRAM.states.length, bits: WORD_BITS, total: MC_PROGRAM.states.length * WORD_BITS });

/** Spread of the family: the dearest over the cheapest, the slowest over the fastest. */
export function spread(rows: FamilyRow[] = familyRows()) {
  const n = rows.map((r) => r.nands), t = rows.map((r) => r.nsPerInstr);
  return { cost: Math.max(...n) / Math.min(...n), time: Math.max(...t) / Math.min(...t) };
}

export const PROGRAMS_USED = COMMON.join(', ');

export function familyWidget(): Widget {
  const rows = familyRows();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'One instruction set, four machines'),
      h('p', { class: 'sub' }, `RV32I, all four run ${PROGRAMS_USED} and end in the same state as the golden model. Means over those programs; NANDs without the program ROM; delays are NAND delays, ${RESULTS.psPerNand} ps each.`),
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, ...['machine', 'NANDs', 'period', 'CPI', 'delays / instr.', 'ns / instr.'].map((t) => h('th', null, t)))),
        h('tbody', null, rows.map((r) => h('tr', null,
          h('td', null, r.label), h('td', { class: 'num' }, groupDigits(r.nands)), h('td', { class: 'num' }, String(r.period)),
          h('td', { class: 'num' }, r.cpi.toFixed(2)), h('td', { class: 'num' }, String(Math.round(r.delaysPerInstr))),
          h('td', { class: 'num' }, r.nsPerInstr.toFixed(1))))))),
    ),
  };
}
