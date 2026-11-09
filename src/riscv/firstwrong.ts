// The first wrong instruction (DOM-free): a CPU run against the golden model the way the CPU panel compares them
// (widgets/cpupanel.ts): before each rising edge, how many instructions retire at it; after it, the model steps that
// many and every register must agree; a CPU that is not pipelined must also agree on the PC at an instruction boundary;
// at the model's halt, the data memory too. What a fault in a chapter's "find it" step looks like from outside
// (widgets/findfault.ts), computed for any fault.

import { DualSim } from '../sim/dualsim';
import { flatten } from '../sim/flatten';
import type { ComponentDef } from '../sim/types';
import { cpuState, retireCount } from './cosim';
import { ABI } from './isa';
import { ISS, type IssOptions } from './iss';

export interface FirstWrong {
  /**
   * wrong: a register, the PC or a memory word disagreed (`text` says which); hung: the CPU stopped finishing
   * instructions (none retired for HANG_CYCLES, or the cycles ran out before the model halted); clean: the model
   * halted with everything equal.
   */
  kind: 'wrong' | 'hung' | 'clean';
  /** Clock cycles from reset to the edge after which it showed (or the run ended). */
  cycle: number;
  /** "a1 differs after “addi a1, a0, 3”: hardware 0x9, model 0x1", the PC's or a memory word's ('' when clean). */
  text: string;
  /** The instruction the model ran last before it showed ('' at reset). */
  after: string;
}

/** Cycles without a retirement that count as hung (a cache miss or a divide takes tens). */
export const HANG_CYCLES = 400;

const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;

/**
 * Run `def` (a CPU whose ROM holds `words`) from reset for at most `maxCycles` clock cycles beside the golden model.
 * `inputs`: the scene's (clk 0, switches, irq). `pipelined`: the PC is not compared (the panel compares the
 * pipeline's registers only).
 */
export function firstWrong(def: ComponentDef, words: readonly number[], iss: IssOptions, opts: { inputs?: Record<string, number>; pipelined?: boolean; maxCycles?: number } = {}): FirstWrong {
  const sim = new DualSim(flatten(def, { mode: 'gate' }));
  sim.preferFast = true;
  for (const [k, v] of Object.entries(opts.inputs ?? { clk: 0 })) sim.setInput(k, v);
  sim.reset('zero');
  sim.settle();
  const model = new ISS([...words], iss);
  const root = sim.design.root;
  const fetch = root.ports.fetch;
  let after = '';
  let idle = 0;
  const said = () => `after “${after || 'reset'}”`;
  const max = opts.maxCycles ?? 3000;
  let cycle = 1;
  for (; cycle <= max && !model.halted; cycle++) {
    const n = retireCount(sim);
    sim.setInput('clk', 1);
    sim.settle();
    sim.setInput('clk', 0);
    sim.settle();
    for (let k = 0; k < n && !model.halted; k++) after = model.step().text;
    idle = n ? 0 : idle + 1;
    if (idle >= HANG_CYCLES) return { kind: 'hung', cycle, after, text: `no instruction finished for ${HANG_CYCLES} cycles ${said()}` };
    const st = cpuState(sim);
    const d = st.x.findIndex((v, i) => v !== model.x[i]);
    if (d >= 0) return { kind: 'wrong', cycle, after, text: `${ABI[d]} differs ${said()}: hardware ${hex(st.x[d])}, model ${hex(model.x[d])}` };
    const boundary = !fetch || sim.getBits(fetch)[0] === 1;
    if (!opts.pipelined && boundary && st.pc !== model.pc) return { kind: 'wrong', cycle, after, text: `PC differs ${said()}: hardware ${hex(st.pc)}, model ${hex(model.pc)}` };
  }
  if (!model.halted) return { kind: 'hung', cycle: cycle - 1, after, text: `the program had not finished after ${max} cycles (last “${after || 'reset'}”)` };
  // at the halt, memory: the words both hold (a pipeline's last stores retire a few cycles after the model's halt)
  if (opts.pipelined) for (let k = 0; k < 8; k++) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
  const mem = cpuState(sim).dmem;
  const a = mem.findIndex((v, i) => i < model.dmem.length && v !== model.dmem[i]);
  if (a >= 0) return { kind: 'wrong', cycle: cycle - 1, after, text: `the word at address ${hex(4 * a)} differs at the end: hardware ${hex(mem[a])}, model ${hex(model.dmem[a])}` };
  return { kind: 'clean', cycle: cycle - 1, after, text: '' };
}
