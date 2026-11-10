// The Vectors chapter's timing (DOM-free).
//
// vecRun: the gate-level vector CPU's cycles from the golden model. The unit (lib/vector.ts) holds the scalar core for
// as many beats as an instruction needs: a group of L = LMUL registers takes L beats (one register, four elements, a
// beat), a mask compare or vredsum one more (the first beat reads the old mask word or vs1[0]); vset*, vmv.x.s,
// vmv.s.x, a csrr and anything illegal take one cycle, like every scalar instruction. tests/vectors-chapter.test.ts holds
// it equal to the gates' cycle count.
//
// chainTimes: the chaining step's model, not gates. Four units (load, shift, add, store: the Cray-1's are separate) take one element group a cycle each;
// instructions issue in order. Without chaining an instruction waits until its producers have written their whole
// result; with it (the Cray-1's, 1976) element group g may start as soon as its producers' group g is written. 'serial'
// is our gate-level unit: one instruction at a time, whatever unit it uses.

import { ISS } from './iss';
import { decodeV, execV, OPI, VILL, type VContext } from './rvv';

export interface VecRun {
  /** Instructions retired and clock cycles to the halt. */
  instrs: number;
  cycles: number;
  /** Vector instructions retired, and the cycles they took. */
  vInstrs: number;
  vCycles: number;
  iss: ISS;
}

/** The beats a vector word takes on the unit now (1 for a scalar word or an illegal one). */
export function beatsOf(iss: ISS, word: number): number {
  const k = decodeV(word);
  if (!k || k.k === 'vsetvli' || k.k === 'vsetivli' || k.k === 'vsetvl' || k.k === 'mvxs' || k.k === 'mvsx') return 1;
  if ((iss.vtype >>> 0) === VILL) return 1;
  // legal? run it on a copy that touches nothing
  const c: VContext = { vlenb: iss.vlenb, vregs: iss.vregs.slice(), vl: iss.vl, vtype: iss.vtype, x: iss.x.slice(), gates: true, load: () => 0, store: () => {} };
  if (execV(word, c).illegal) return 1;
  const L = 1 << (iss.vtype & 3);
  const pre = k.k === 'redsum' || (k.k === 'opi' && !!OPI[k.name].mask);
  return L + (pre ? 1 : 0);
}

/** Run a program on the golden model of the vector CPU (VLEN 128, the gate subset) and count the cycles the gates take. */
export function vecRun(words: number[], o: { dmemWords?: number; imemWords?: number; maxSteps?: number } = {}): VecRun {
  const iss = new ISS(words, { v: { vlen: 128, gates: true }, dmemWords: o.dmemWords ?? 64, imemWords: o.imemWords ?? 256 });
  let cycles = 0, vInstrs = 0, vCycles = 0;
  while (!iss.halted && iss.steps < (o.maxSteps ?? 100_000)) {
    const word = iss.instrAt(iss.pc).word, b = beatsOf(iss, word);
    if (decodeV(word)) { vInstrs++; vCycles += b; }
    cycles += b;
    iss.step();
  }
  return { instrs: iss.steps, cycles, vInstrs, vCycles, iss };
}

export type VecUnit = 'load' | 'shift' | 'add' | 'store';
export interface ChainInstr { text: string; unit: VecUnit; dst?: string; srcs: string[] }
export type ChainMode = 'serial' | 'units' | 'chained';

/** Start cycle of every element group of every instruction, and the cycle the last one ends. */
export function chainTimes(prog: readonly ChainInstr[], groups: number, mode: ChainMode): { start: number[][]; total: number } {
  const start: number[][] = [];
  const unitFree: Record<VecUnit, number> = { load: 0, shift: 0, add: 0, store: 0 };
  let serialFree = 0, issue = 0, total = 0;
  for (const [i, ins] of prog.entries()) {
    const producers = ins.srcs.map((s) => { for (let j = i - 1; j >= 0; j--) if (prog[j].dst === s) return j; return -1; }).filter((j) => j >= 0);
    const row: number[] = [];
    for (let g = 0; g < groups; g++) {
      let t = g === 0 ? Math.max(issue, mode === 'serial' ? serialFree : unitFree[ins.unit]) : row[g - 1] + 1;
      for (const j of producers) t = Math.max(t, mode === 'chained' ? start[j][g] + 1 : start[j][groups - 1] + 1);
      row.push(t);
    }
    start.push(row);
    const end = row[groups - 1] + 1;
    unitFree[ins.unit] = end;
    serialFree = end;
    issue = row[0] + 1; // in order: the next instruction issues a cycle after this one started
    total = Math.max(total, end);
  }
  return { start, total };
}

/** The chaining step's sequence: the kernel's loop body (its scalar bookkeeping aside). */
export const CHAIN_KERNEL: ChainInstr[] = [
  { text: 'vle32.v v8, (a1)', unit: 'load', dst: 'v8', srcs: [] },
  { text: 'vle32.v v16, (a2)', unit: 'load', dst: 'v16', srcs: [] },
  { text: 'vsll.vi v24, v8, 1', unit: 'shift', dst: 'v24', srcs: ['v8'] },
  { text: 'vadd.vv v24, v24, v8', unit: 'add', dst: 'v24', srcs: ['v24', 'v8'] },
  { text: 'vadd.vv v16, v16, v24', unit: 'add', dst: 'v16', srcs: ['v16', 'v24'] },
  { text: 'vse32.v v16, (a2)', unit: 'store', srcs: ['v16'] },
];
