// Act 13's build levels (Signals, the Signal processing level's optional act): a saturating adder, a biquad, Goertzel for one
// tone, a CIC decimator, a CORDIC stage and a sigma-delta loop, each checked against the chapter's model (dsp/). The reference
// answers are the chapters' library circuits drawn as chips. The MAC with guard bits and the circular address wait for the
// MAC unit and the DSP core. No DOM.

import type { BuildChallenge } from '../editor/challenges';
import { clampWord, satAdder } from '../lib/fixedpt';
import type { ComponentDef } from '../sim/types';
import { leafGives, pinsOf, refOf } from './buildcomm';
import { CIC_CYCLES, CIC_LV, CIC_REF, CIC_W, runCic } from './cicbench';
import { comb, integrator, rateCount } from '../lib/multirate';

/** The word of the saturating adder level: 8 bits, so Check runs every pair (65 536). */
export const SAT_W = 8;
export const SAT_REF = (): ComponentDef => satAdder(SAT_W);
export const SAT_CLAMP = (): ComponentDef => clampWord(SAT_W);
/** The adder's parts, the clamp's included: the clamp itself is what the level builds. */
export const satGives = leafGives(SAT_REF, () => [SAT_CLAMP()]);

const CIC_K = Math.round(Math.log2(CIC_LV.R));
/** The decimator's parts, its integrator, comb and counter excluded: those are what the level builds. */
export const cicGives = leafGives(CIC_REF, () => [integrator(CIC_W), comb(CIC_W), rateCount(CIC_K)]);

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
  sp_cic: () => ({
    id: 'sp_cic', title: 'CIC decimator', level: 'sequential', allowed: 'nand',
    brief: `A moving-average filter that keeps one sample in ${CIC_LV.R}, with no multiplier. <b>x</b> is a ${CIC_LV.wIn}-bit two's complement sample, one a clock. Pass it through ${CIC_LV.N} <i>integrators</i> (a register that adds its input to itself every clock), count ${CIC_LV.R} clocks, and on the last of each group take ${CIC_LV.N} <i>combs</i> (this value minus the one at the previous strobe) and load the result into <b>y</b>, with <b>valid</b> = 1 for that one clock. `
      + `All registers are ${CIC_W} bits (${CIC_LV.wIn} + ${CIC_LV.N} × log<sub>2</sub> ${CIC_LV.R}) and wrap: the sums run past the word all the time and the differences still come out right. The bench holds the most negative word, steps, alternates and feeds noise, and compares y and valid after every clock with the chapter's model.`,
    ports: pinsOf(CIC_REF()),
    check: { kind: 'custom', describe: `32 input streams of ${CIC_CYCLES} clocks (the extreme words held, a step, full-scale alternation, a ramp, a square wave, quiet and loud seeded noise): y and valid after every clock against the model.`, run: (d, m) => runCic(d, m) },
    answer: refOf('sp_cic', CIC_REF, 'CIC decimator', () => [[integrator(CIC_W), 'Integrator'], [comb(CIC_W), 'Comb'], [rateCount(CIC_K), 'Count of R']]),
  }),

  // ---- sp_cordic

  // ---- sp_sd

};
