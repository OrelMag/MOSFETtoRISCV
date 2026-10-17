// Act 10's build levels (memory in depth, roadmap Phase 16e): a DRAM column at switch level, a bank with refresh
// and a row-buffer controller, each against a device on its bench (memcheck.ts). No DOM.

import type { BuildChallenge, PinSpec, SeqStep } from '../editor/challenges';
import { docFromDef } from '../editor/fromdef';
import type { ChipDoc } from '../editor/model';
import { BANK16, CTRL16, DRAM_COL2 } from '../lib/rv16/mem16';
import type { ComponentDef } from '../sim/types';
import { BANK, bankTraces, ctrlTraces, DRAM16, runBank, runCtrl } from './memcheck';

const pinsOf = (def: ComponentDef): PinSpec[] => def.ports.map((p) => ({ name: p.name, dir: p.dir === 'out' ? 'out' : 'in', width: p.width, ...(p.clock ? { clock: true } : {}) }));

const answers = new Map<string, ChipDoc[]>();
const refOf = (id: string, def: () => ComponentDef, name: string) => (): ChipDoc[] => {
  let a = answers.get(id);
  if (a) return a;
  const top = docFromDef(def(), { id: `u_ref_cp_${id}`, name: `${name} ref` });
  if ('error' in top) throw new Error(`reference ${id}: ${top.error}`);
  answers.set(id, (a = [{ ...top, notes: `Reference answer. ${def().summary ?? ''}`.trim() }]));
  return a;
};

/**
 * The column's test: writes and reads of both cells through the protocol of chapter 32 (precharge, word line,
 * sense, then write or read, close). Each read is destructive, so reading a cell twice proves the restore.
 */
export function senseSeq(): SeqStep[] {
  const st: SeqStep[] = [];
  const idle = { pre: 0, wl0: 0, wl1: 0, sae: 0, we: 0 };
  const open = (r: number, v?: number) => {
    st.push({ set: { ...idle, pre: 1 }, expect: {} }, { set: { pre: 0 }, expect: {} }, { set: { [`wl${r}`]: 1 }, expect: {} });
    st.push({ set: { sae: 1 }, expect: v === undefined ? {} : { q: v } });
  };
  const close = (r: number) => st.push({ set: { [`wl${r}`]: 0 }, expect: {} }, { set: { sae: 0 }, expect: {} });
  const write = (r: number, v: number) => {
    open(r);
    st.push({ set: { we: 1, d: v }, expect: { q: v } }, { set: { we: 0 }, expect: { q: v } });
    close(r);
  };
  const read = (r: number, v: number) => { open(r, v); close(r); };
  write(0, 1); write(1, 0);
  read(0, 1); read(1, 0); read(0, 1); read(1, 0);
  write(0, 0); read(1, 0); read(0, 0);
  write(1, 1); read(0, 0); read(1, 1); read(1, 1);
  write(0, 1); read(0, 1); read(1, 1); read(0, 1);
  return st;
}

export const BUILDM: Record<string, () => BuildChallenge> = {
  m_sense: () => ({
    id: 'm_sense', title: 'A DRAM column', level: 'memory', allowed: 'nand',
    brief: 'Two 1T1C cells on a bit line, read and written through a sense amplifier, at switch level. The bench drives chapter 32\'s protocol: <b>pre</b> = 1 then 0 (both bit lines to VDD/2, then floating), a word line <b>wl0</b> or <b>wl1</b> (the cell shares its charge with its line), <b>sae</b> (the amplifier drives the higher line to VDD and the other to GND, and the open cell is restored), then either a read or a write (<b>we</b> = 1 with <b>d</b>: the write driver flips the lines), then the word line and sae fall. <b>q</b> must be the cell\'s bit once sensed. '
      + 'Given: the cells, a bit line capacitance part (100 fF), the amplifier, VDD/2 and the write driver. The amplifier compares two lines, so the second one needs the same capacitance and the same precharge, and nothing else on it.',
    ports: pinsOf(DRAM_COL2),
    check: { kind: 'sequence', steps: senseSeq() },
    answer: refOf('m_sense', () => DRAM_COL2, 'DRAM column'),
  }),
  m_bank: () => ({
    id: 'm_bank', title: 'A bank with refresh', level: 'memory', allowed: 'nand',
    brief: `Requests on one side, a ${BANK.rows} × ${BANK.cols} array of 16-bit words on the other (it is on the bench). A request (<code>re</code> or <code>we</code>, <code>addr</code> = row · column, <code>wd</code>) is held until a cycle with <b>busy</b> = 0: that cycle it must be done, a read's word on <b>rd</b>. `
      + 'The array takes one command a cycle on <b>cmd</b>: 1 <b>ACT</b> opens row <b>ra</b> (its words move into the sense amplifiers: the row buffer); 3 <b>RW</b> reads word <b>ca</b> of the open row onto <code>aq</code> in the same cycle, or writes <b>ad</b> into it when <b>aw</b> = 1; 2 <b>PRE</b> closes the row; 0 nothing. ACT needs the bank closed, RW a row open. '
      + `The cells leak: every row must be opened at least every <b>${BANK.RET} cycles</b> (opening restores it, and an open row holds), or the bench reports it lost. ${bankTraces().length} request traces; graded on cycles too: keep the row open while requests hit it.`,
    ports: pinsOf(BANK16),
    check: { kind: 'custom', describe: `${bankTraces().length} request traces against the cell array (runs along a row, random words, two rows taking turns, long pauses, no pause at all): every read's word, every command legal, no row older than ${BANK.RET} cycles.`, run: runBank },
    answer: refOf('m_bank', () => BANK16, 'Bank with refresh'),
  }),
  m_ctrl: () => ({
    id: 'm_ctrl', title: 'Row-buffer controller', level: 'memory', allowed: 'nand',
    brief: `A DRAM chip on the bench: ${DRAM16.banks} banks of ${DRAM16.rows} rows of ${DRAM16.cols} words, each bank with its own row buffer. A request (<code>req</code>, <code>addr</code> = row (6 bits) · bank · column (4 bits), <code>we</code>, <code>wd</code>) is held until <b>ready</b>: a write is ready in the cycle of its WR, a read in the cycle its word is on <code>dq</code> (<b>rd</b>). `
      + `Commands on <b>cmd</b> with <b>ba</b>, <b>ra</b>, <b>ca</b>, <b>dd</b>: 1 ACT (open row ra of bank ba), 2 RD (word ca of its open row: on dq <b>tCAS = ${DRAM16.tCAS}</b> cycles later), 3 WR (dd into word ca now), 4 PRE (close bank ba), 5 PREA (close both), 6 REF (needs both closed). `
      + `The chip's rules, in cycles: ACT → RD / WR ≥ <b>tRCD = ${DRAM16.tRCD}</b>; ACT → PRE ≥ <b>tRAS = ${DRAM16.tRAS}</b>; PRE → ACT or REF ≥ <b>tRP = ${DRAM16.tRP}</b>; REF → anything ≥ <b>tRFC = ${DRAM16.tRFC}</b>; a REF at least every <b>${DRAM16.tREFI}</b> cycles. Graded on cycles over the traces.`,
    ports: pinsOf(CTRL16),
    check: { kind: 'custom', describe: `${ctrlTraces().length} request traces against the DRAM chip (runs along a row, a stream per bank, row conflicts, random, long pauses, no pause at all): every word, every timing rule, refresh.`, run: runCtrl },
    answer: refOf('m_ctrl', () => CTRL16, 'Row-buffer controller'),
  }),
};

