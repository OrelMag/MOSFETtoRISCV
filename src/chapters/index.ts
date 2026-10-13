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
import { chMulticore } from './ch-multicore';
import { chSilicon } from './ch-silicon';
import { chFeed, chLanes, chSimt, chWarps } from './ch-gpu';
import { chPixels } from './ch-gfx';
import { chBinary, chGates } from './ch-gates';
import { chLatches, chMemory, chRegisters } from './ch-memory';
import { chInverter, chMap, chMosfet, chNand } from './ch-transistors';
import type { Chapter, FutureChapter } from './types';

export const chapters: Chapter[] = [
  chMap, chMosfet, chInverter, chNand, chGates, chBinary, chAdders, chRouting, chLatches, chRegisters, chMemory,
  chAlu, chRegfile, chIsa, chSingleCycle, chFastAdders, chPipeline, chPipePay, chIO, chTraps, chMulDiv, chCache, chMulticycle, chFloat, chMulticore, chSilicon, chLanes, chSimt, chWarps, chFeed, chPixels,
];

// The rest of the GPU track (docs/ROADMAP.md Phase 15), shown as "coming soon" so the journey does not stop mid-track.
export const future: FutureChapter[] = [
  { num: 31, title: 'The graphics pipeline', level: 'Throughput',
    blurb: 'Vertex transform as a kernel on the lanes, the fixed-function rasterizer behind it: a spinning triangle, frames per second at gate level, and each stage\'s cost.' },
];

export function chapterById(id: string): Chapter | undefined {
  return chapters.find((c) => c.id === id);
}
