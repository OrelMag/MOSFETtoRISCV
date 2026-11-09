// The first wrong instruction (DOM-free): a CPU run against the golden model the way the CPU panel compares them
// (widgets/cpupanel.ts): before each rising edge, how many instructions retire at it; after it, the model steps that
// many and every register must agree; a CPU that is not pipelined must also agree on the PC at an instruction boundary.
// What a fault in a chapter's "find it" step looks like from outside (widgets/findfault.ts), computed for any fault.

import { DualSim } from '../sim/dualsim';
import { flatten } from '../sim/flatten';
import type { ComponentDef } from '../sim/types';
import { cpuState, retireCount } from './cosim';
import { ABI } from './isa';
import { ISS, type IssOptions } from './iss';

export interface FirstWrong {
  /** Clock cycles from reset to the edge after which it showed. */
  cycle: number;
  /** "a1 differs after “addi a1, a0, 3”: hardware 0x9, model 0x1", or the PC's. */
  text: string;
  /** The instruction the model ran last before it showed ('' at reset). */
  after: string;
}

const hex = (v: number) => `0x${(v >>> 0).toString(16)}`;

/**
 * Run `def` (a CPU whose ROM holds `words`) from reset for at most `maxCycles` clock cycles beside the golden model.
 * The first disagreement, or null: none before the model halted (or the cycles ran out). `inputs`: the scene's (clk 0,
 * switches, irq). `pipelined`: the PC is not compared (the panel compares the pipeline's registers only).
 */
export function firstWrong(def: ComponentDef, words: readonly number[], iss: IssOptions, opts: { inputs?: Record<string, number>; pipelined?: boolean; maxCycles?: number } = {}): FirstWrong | null {
  const sim = new DualSim(flatten(def, { mode: 'gate' }));
  sim.preferFast = true;
  for (const [k, v] of Object.entries(opts.inputs ?? { clk: 0 })) sim.setInput(k, v);
  sim.reset('zero');
  sim.settle();
  const model = new ISS([...words], iss);
  const root = sim.design.root;
  const fetch = root.ports.fetch;
  let after = '';
  const max = opts.maxCycles ?? 3000;
  for (let cycle = 1; cycle <= max && !model.halted; cycle++) {
    const n = retireCount(sim);
    sim.setInput('clk', 1);
    sim.settle();
    sim.setInput('clk', 0);
    sim.settle();
    for (let k = 0; k < n && !model.halted; k++) after = model.step().text;
    const st = cpuState(sim);
    const d = st.x.findIndex((v, i) => v !== model.x[i]);
    if (d >= 0) return { cycle, after, text: `${ABI[d]} differs after “${after || 'reset'}”: hardware ${hex(st.x[d])}, model ${hex(model.x[d])}` };
    const boundary = !fetch || sim.getBits(fetch)[0] === 1;
    if (!opts.pipelined && boundary && st.pc !== model.pc) return { cycle, after, text: `PC differs after “${after || 'reset'}”: hardware ${hex(st.pc)}, model ${hex(model.pc)}` };
  }
  return null;
}
