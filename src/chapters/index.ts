import { chAdders, chRouting } from './ch-arith';
import { chAlu, chIsa, chRegfile, chSingleCycle } from './ch-cpu';
import { chFastAdders } from './ch-perf';
import { chPipeline } from './ch-pipe';
import { chPipePay } from './ch-pipe2';
import { chIO, chTraps } from './ch-system';
import { chMulDiv } from './ch-muldiv';
import { chCache } from './ch-cache';
import { chMulticycle } from './ch-multicycle';
import { chFloat } from './ch-float';
import { chBinary, chGates } from './ch-gates';
import { chLatches, chMemory, chRegisters } from './ch-memory';
import { chInverter, chMap, chMosfet, chNand } from './ch-transistors';
import type { Chapter, FutureChapter } from './types';

export const chapters: Chapter[] = [
  chMap, chMosfet, chInverter, chNand, chGates, chBinary, chAdders, chRouting, chLatches, chRegisters, chMemory,
  chAlu, chRegfile, chIsa, chSingleCycle, chFastAdders, chPipeline, chPipePay, chIO, chTraps, chMulDiv, chCache, chMulticycle, chFloat,
];

export const future: FutureChapter[] = [
  { num: 24, title: 'Many cores', level: 'Systems', blurb: 'Coherence, atomics and a spin-lock on a multi-core RISC-V.' },
  { num: 25, title: 'From netlist to silicon', level: 'Physical design', blurb: 'Standard cells, layout, place & route, and the finished die.' },
];

export function chapterById(id: string): Chapter | undefined {
  return chapters.find((c) => c.id === id);
}
