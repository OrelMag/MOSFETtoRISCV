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
import { chGfxPipeline, chPixels } from './ch-gfx';
import { chBinary, chGates } from './ch-gates';
import { chLatches, chMemory, chRegisters } from './ch-memory';
import { chInverter, chMap, chMosfet, chNand } from './ch-transistors';
import { chAppendix6502 } from './ch-6502';
import { chAppendixDoom } from './ch-doom';
import { chDram } from './ch-dram';
import { chMemCtrl } from './ch-memctrl';
import type { Chapter, FutureChapter } from './types';

export const chapters: Chapter[] = [
  chMap, chMosfet, chInverter, chNand, chGates, chBinary, chAdders, chRouting, chLatches, chRegisters, chMemory,
  chAlu, chRegfile, chIsa, chSingleCycle, chFastAdders, chPipeline, chPipePay, chIO, chTraps, chMulDiv, chCache, chMulticycle, chFloat, chMulticore, chSilicon, chLanes, chSimt, chWarps, chFeed, chPixels, chGfxPipeline,
  chDram, chMemCtrl,
  // the appendix: after the journey, lettered
  chAppendix6502, chAppendixDoom,
];

// Planned chapters, shown as "coming soon" (none now: the GPU track is complete).
export const future: FutureChapter[] = [];

export function chapterById(id: string): Chapter | undefined {
  return chapters.find((c) => c.id === id);
}
