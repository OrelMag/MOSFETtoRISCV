import { chAdders, chRouting } from './ch-arith';
import { chAlu, chIsa, chRegfile, chSingleCycle } from './ch-cpu';
import { chFastAdders } from './ch-perf';
import { chPipeline } from './ch-pipe';
import { chBinary, chGates } from './ch-gates';
import { chLatches, chMemory, chRegisters } from './ch-memory';
import { chInverter, chMap, chMosfet, chNand } from './ch-transistors';
import type { Chapter, FutureChapter } from './types';

export const chapters: Chapter[] = [
  chMap, chMosfet, chInverter, chNand, chGates, chBinary, chAdders, chRouting, chLatches, chRegisters, chMemory,
  chAlu, chRegfile, chIsa, chSingleCycle, chFastAdders, chPipeline,
];

export const future: FutureChapter[] = [
  { num: 17, title: 'Branch prediction', level: 'Processor', blurb: 'BTB and 2-bit counters: getting the CPI back towards 1, measured.' },
  { num: 18, title: 'Multicycle & microcode', level: 'Processor', blurb: 'Hardwired FSM versus microprogrammed control.' },
  { num: 19, title: 'Multiply & divide', level: 'Arithmetic', blurb: 'Array, Booth and Dadda multipliers; restoring division; the M extension.' },
  { num: 20, title: 'Byte loads, CSRs & interrupts', level: 'Privileged ISA', blurb: 'Load/store unit, CSRs, exceptions, a timer interrupt and the trap handler.' },
  { num: 21, title: 'Caches & the memory hierarchy', level: 'Memory', blurb: 'SRAM and DRAM cells, direct-mapped and set-associative caches.' },
  { num: 22, title: 'Floating point', level: 'Arithmetic', blurb: 'IEEE 754 and an FPU, from the primer’s design.' },
  { num: 23, title: 'Many cores', level: 'Systems', blurb: 'Coherence, atomics and a spin-lock on a multi-core RISC-V.' },
  { num: 24, title: 'From netlist to silicon', level: 'Physical design', blurb: 'Standard cells, layout, place & route, and the finished die.' },
];

export function chapterById(id: string): Chapter | undefined {
  return chapters.find((c) => c.id === id);
}
