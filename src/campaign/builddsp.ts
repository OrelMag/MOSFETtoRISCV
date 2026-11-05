// Act 13's build levels (Signals, the Signal processing level's optional act): a saturating adder, a biquad, Goertzel for one
// tone, a CIC decimator, a CORDIC stage and a sigma-delta loop, each checked against the chapter's model (dsp/). The reference
// answers are the chapters' library circuits drawn as chips. The MAC with guard bits and the circular address wait for the
// MAC unit and the DSP core. No DOM.

import type { BuildChallenge } from '../editor/challenges';
import { clampWord, satAdder } from '../lib/fixedpt';
import type { ComponentDef } from '../sim/types';
import { leafGives, pinsOf, refOf } from './buildcomm';
import { runSd, SD_REF, SD_W, SD_WORD } from './sdcheck';

/** The word of the saturating adder level: 8 bits, so Check runs every pair (65 536). */
export const SAT_W = 8;
export const SAT_REF = (): ComponentDef => satAdder(SAT_W);
export const SAT_CLAMP = (): ComponentDef => clampWord(SAT_W);
/** The adder's parts, the clamp's included: the clamp itself is what the level builds. */
export const satGives = leafGives(SAT_REF, () => [SAT_CLAMP()]);

export const BUILDDSP: Record<string, () => BuildChallenge> = {
  sp_sat: () => ({
    id: 'sp_sat', title: 'Saturating adder', level: 'gates', allowed: 'nand',
    brief: `<b>a</b> and <b>b</b> are ${SAT_W}-bit two's complement words (−128 … 127). Make <b>y</b> = a + b when it fits, and the nearest end of the range when it does not: 127 + 1 is 127, −100 − 100 is −128. <b>sat</b> is 1 exactly when y was clamped. `
      + 'Check runs all 65 536 pairs against the chapter\'s model.',
    ports: pinsOf(SAT_REF()),
    check: { kind: 'table', spec: (ins) => SAT_REF().spec!(ins) },
    answer: refOf('sp_sat', SAT_REF, 'Saturating adder', () => [[SAT_CLAMP(), 'Clamp']]),
  }),

  // ---- sp_biquad (its entry goes below this line)

  // ---- sp_goertzel

  // ---- sp_cic

  // ---- sp_cordic

  // ---- sp_sd
  sp_sd: () => ({
    id: 'sp_sd', title: 'Sigma-delta loop', level: 'gates', allowed: 'nand',
    brief: `<b>u</b> is a signed ${SD_W}-bit word (full scale is ±${2 ** (SD_W - 1)}). Build the digital loop of a second-order sigma-delta modulator: <b>y1</b> and <b>y2</b> are two running sums, ${SD_WORD} bits wide so they do not wrap, and <b>bit</b> is one flip-flop. `
      + 'At every rising clock edge the loop decides from the sign of y2 as it stands (1 when it is not negative), then y1 ← y1 + u − v and y2 ← y2 + (the new y1) − v, where v is +full scale after a 1 and −full scale after a 0; <b>bit</b> is that decision. '
      + 'Check runs 16 inputs of 3000 clocks (steady levels, sines, steps, and full scale where the sums outgrow their words and must wrap like the model): bit, y1 and y2 against the chapter model at every clock, and on the steady inputs the average of the bits against the input.',
    ports: pinsOf(SD_REF()),
    check: { kind: 'custom', describe: '16 inputs of 3000 clocks (steady levels from −0.9 to +0.9 full scale, 1 LSB, ±full scale, three sines, steps, seeded sines): bit, y1 and y2 equal the model after every clock, and the bits of each steady input average to the input within 0.01 over the last 2000 clocks.', run: runSd },
    answer: refOf('sp_sd', SD_REF, 'Sigma-delta loop'),
  }),

};
