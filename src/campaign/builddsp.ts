// Act 13's build levels (Signals, the Signal processing level's optional act): a saturating adder, a biquad, Goertzel for one
// tone, a CIC decimator, a CORDIC stage and a sigma-delta loop, each checked against the chapter's model (dsp/). The reference
// answers are the chapters' library circuits drawn as chips. The MAC with guard bits and the circular address wait for the
// MAC unit and the DSP core. No DOM.

import type { BuildChallenge } from '../editor/challenges';
import { biquad } from '../lib/biquad';
import { clampWord, satAdder } from '../lib/fixedpt';
import type { ComponentDef } from '../sim/types';
import { leafGives, pinsOf, refOf } from './buildcomm';
import { BQ_CYCLES, BQ_LANES, runBiquadBench } from './dspcheck';

/** The word of the saturating adder level: 8 bits, so Check runs every pair (65 536). */
export const SAT_W = 8;
export const SAT_REF = (): ComponentDef => satAdder(SAT_W);
export const SAT_CLAMP = (): ComponentDef => clampWord(SAT_W);
/** The adder's parts, the clamp's included: the clamp itself is what the level builds. */
export const satGives = leafGives(SAT_REF, () => [SAT_CLAMP()]);

/** The biquad level's reference: the chapter's direct form I, 16-bit data (Q1.15), coefficients Q2.14, rounding half up. Its parts (multipliers, adders, registers, rounder, clamp) are all given. */
export const BIQUAD_REF = (): ComponentDef => biquad();
export const biquadGives = leafGives(BIQUAD_REF, () => []);

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
  sp_biquad: () => ({
    id: 'sp_biquad', title: 'A biquad', level: 'sequential', allowed: 'nand',
    brief: '<b>x</b> is a sample (Q1.15, 16 bits) and <b>b0 b1 b2 a1 a2</b> are coefficients (Q2.14: 16384 is 1.0, the range is −2 … 2 − 2⁻¹⁴), all signed, all pins. Each clock <b>y</b> is the output for the <i>current</i> x: '
      + 'y[n] = b₀x[n] + b₁x[n−1] + b₂x[n−2] − a₁y[n−1] − a₂y[n−2]. The sum is formed exactly, with every product bit and a guard-bit wider accumulator, then rounded <i>once</i> (the 14 low bits come off and the first one dropped is added back) and clamped <i>once</i> to 16 bits; <b>sat</b> is 1 when the clamp acted. '
      + 'The values that circulate are the rounded, clamped y words, and the registers are empty at power-on. '
      + `Check runs ${BQ_LANES} runs of ${BQ_CYCLES} clocks, impulses included, and compares y and sat at every clock with the chapter's model. Graded on NANDs and the clock period.`,
    ports: pinsOf(BIQUAD_REF()),
    check: { kind: 'custom', describe: `${BQ_LANES} runs of ${BQ_CYCLES} clocks (impulses, steps, full-scale squares, rounding probes, seeded filters): y and sat at every clock against the model of direct form I with one rounding and one clamp.`, run: runBiquadBench, unit: 'run' },
    answer: refOf('sp_biquad', BIQUAD_REF, 'Biquad'),
  }),

  // ---- sp_goertzel

  // ---- sp_cic

  // ---- sp_cordic

  // ---- sp_sd

};
