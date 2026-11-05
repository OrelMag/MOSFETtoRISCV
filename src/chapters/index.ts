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
import { chWidths } from './ch-widths';
import { chOoo } from './ch-ooo';
import { chPython } from './ch-python';
import { chMulticore } from './ch-multicore';
import { chSilicon } from './ch-silicon';
import { chFeed, chLanes, chSimt, chWarps } from './ch-gpu';
import { chGfxPipeline, chPixels } from './ch-gfx';
import { chBinary, chGates } from './ch-gates';
import { chLatches, chMemory, chRegisters } from './ch-memory';
import { chInverter, chMap, chMosfet, chNand } from './ch-transistors';
import { chBasics } from './ch-basics';
import { chAppendix6502 } from './ch-6502';
import { chAppendixDoom } from './ch-doom';
import { chAppendixRunner } from './ch-runner';
import { chAppendixSap } from './ch-sap';
import { chDram } from './ch-dram';
import { chMemCtrl } from './ch-memctrl';
import { chFlash } from './ch-flash';
import { chBus } from './ch-bus';
import { chMessage } from './ch-comm-message';
import { chExchange, chTelegraph } from './ch-comm-relays';
import { chSignals } from './ch-comm-signals';
import { chNoise } from './ch-comm-noise';
import { chWire } from './ch-comm-wire';
import { chClocks } from './ch-comm-clocks';
import { chUart } from './ch-comm-uart';
import { chSpi } from './ch-comm-spi';
import { chModem } from './ch-comm-modem';
import { chCarriers } from './ch-comm-carriers';
import { chSerial } from './ch-comm-serial';
import { chGlass } from './ch-comm-glass';
import { chErrors } from './ch-comm-errors';
import { chCodes } from './ch-comm-codes';
import { chEthernet } from './ch-comm-ethernet';
import { chSwitch } from './ch-comm-switch';
import { chNetwork } from './ch-comm-net';
import { chRouter } from './ch-comm-router';
import { chTcp } from './ch-comm-tcp';
import { chQueues } from './ch-comm-queues';
import { chSecret } from './ch-secret';
import { chPath } from './ch-comm-path';
import { chDatacentre } from './ch-comm-dc';
import { chBench } from './ch-comm-bench';
import { chRelays } from './ch-relays';
import { chTubes } from './ch-tubes';
import { chCards } from './ch-cards';
import { chPcie } from './ch-comm-pcie';
import { chRadio } from './ch-comm-radio';
import { chWifi } from './ch-comm-wifi';
import { chCellular } from './ch-comm-cellular';
import { chFixed } from './ch-dsp-fixed';
import { chZplane } from './ch-dsp-zplane';
import { chSpectrum } from './ch-dsp-spectrum';
import { chFirDesign } from './ch-dsp-firdesign';
import { chIir } from './ch-dsp-iir';
import type { Chapter, FutureChapter } from './types';

export const chapters: Chapter[] = [
  chBasics, chMap,
  // the prologue: before the transistor, labelled P1 …
  chRelays, chTubes, chCards,
  chMosfet, chInverter, chNand, chGates, chBinary, chAdders, chRouting, chLatches, chRegisters, chMemory,
  chAlu, chRegfile, chIsa, chSingleCycle, chPython, chFastAdders, chPipeline, chPipePay, chIO, chTraps, chMulDiv, chCache, chMulticycle, chFloat, chWidths, chOoo, chMulticore, chSilicon, chLanes, chSimt, chWarps, chFeed, chPixels, chGfxPipeline,
  chDram, chMemCtrl, chFlash, chBus,
  chMessage, chTelegraph, chExchange, chWire, chClocks, chUart, chSpi, chSignals, chNoise, chModem, chCarriers, chSerial, chGlass, chErrors, chCodes, chPcie, chEthernet, chSwitch, chNetwork, chRouter, chTcp, chQueues, chSecret, chPath, chRadio, chWifi, chCellular, chDatacentre, chBench, chFixed, chZplane, chSpectrum, chFirDesign, chIir,
  // the appendix: after the journey, lettered
  chAppendix6502, chAppendixDoom, chAppendixSap, chAppendixRunner,
];

// Planned chapters, shown as "coming soon" (none now: the GPU track is complete).
export const future: FutureChapter[] = [];

export function chapterById(id: string): Chapter | undefined {
  return chapters.find((c) => c.id === id);
}
