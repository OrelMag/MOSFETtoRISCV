// Act 13's build levels (Signals, the Signal processing level's optional act): a saturating adder, a biquad, Goertzel for one
// tone, a CIC decimator, a CORDIC stage and a sigma-delta loop, each checked against the chapter's model (dsp/). The reference
// answers are the chapters' library circuits drawn as chips. The MAC with guard bits and the circular address wait for the
// MAC unit and the DSP core. No DOM.

import type { BuildChallenge } from '../editor/challenges';
import { cordicStage as cordicModel, type CordicSpec } from '../dsp/cordic';
import { atanTable } from '../dsp/cordic';
import { wrapTo } from '../dsp/fixed';
import { cordicStage } from '../lib/cordic';
import { clampWord, satAdder } from '../lib/fixedpt';
import type { ComponentDef } from '../sim/types';
import { goertzelCell, GZ_STATE } from '../lib/goertzel';
import { RV16_MUX2 } from '../lib/rv16/logic';
import { leafGives, pinsOf, refOf } from './buildcomm';
import { CIC_CYCLES, CIC_LV, CIC_REF, CIC_W, runCic } from './cicbench';
import { comb, integrator, rateCount } from '../lib/multirate';
import { runSd, SD_REF, SD_W, SD_WORD } from './sdcheck';
import { biquad } from '../lib/biquad';
import { BQ_CYCLES, BQ_LANES, runBiquadBench } from './dspcheck';
import { GZ_BLOCK, GZ_NOISE, runGoertzel } from './goertzelcheck';

/** The word of the saturating adder level: 8 bits, so Check runs every pair (65 536). */
export const SAT_W = 8;
export const SAT_REF = (): ComponentDef => satAdder(SAT_W);
export const SAT_CLAMP = (): ComponentDef => clampWord(SAT_W);
/** The adder's parts, the clamp's included: the clamp itself is what the level builds. */
export const satGives = leafGives(SAT_REF, () => [SAT_CLAMP()]);

const CIC_K = Math.round(Math.log2(CIC_LV.R));
/** The decimator's parts, its integrator, comb and counter excluded: those are what the level builds. */
export const cicGives = leafGives(CIC_REF, () => [integrator(CIC_W), comb(CIC_W), rateCount(CIC_K)]);

/** The CORDIC stage level: 5-bit x and y, a 5-bit angle (32 steps a turn), the stage that moves by 1 place: 5 + 5 + 5 + 1 = 16 inputs, so Check runs all 65 536. */
export const CORDIC_SPEC: CordicSpec = { w: 5, z: 5, n: 4 };
export const CORDIC_I = 1;
export const CORDIC_REF = (): ComponentDef => cordicStage(CORDIC_SPEC, CORDIC_I);
/** The stage's parts (adders, wiring, the angle constant): the stage itself is what the level builds. */
export const cordicGives = leafGives(CORDIC_REF, () => []);
/** The chapter's model on packed words: x, y, z as unsigned bit patterns, rotate 1 steers z to 0, 0 steers y to 0. */
export function cordicSpec([x, y, z, rot]: number[]): number[] {
  const s = CORDIC_SPEC, sg = (v: number, w: number) => wrapTo(v, w);
  const r = cordicModel({ x: sg(x, s.w), y: sg(y, s.w), z: sg(z, s.z) }, CORDIC_I, atanTable(s)[CORDIC_I], s, rot ? 'rotate' : 'vector');
  const u = (v: number, w: number) => ((v % 2 ** w) + 2 ** w) % 2 ** w;
  return [u(r.x, s.w), u(r.y, s.w), u(r.z, s.z)];
}
/** The biquad level's reference: the chapter's direct form I, 16-bit data (Q1.15), coefficients Q2.14, rounding half up. Its parts (multipliers, adders, registers, rounder, clamp) are all given. */
export const BIQUAD_REF = (): ComponentDef => biquad();
export const biquadGives = leafGives(BIQUAD_REF, () => []);
/** The Goertzel level's resonator: the chapter's DTMF cell, a 16-bit state, a Q2.14 coefficient on a pin. */
export const GZ_REF = (): ComponentDef => goertzelCell(GZ_STATE, RV16_MUX2);
/** The multiplier is given with every other leaf: the recurrence around it is what the level builds. */
export const gzGives = leafGives(GZ_REF, () => []);

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
  sp_goertzel: () => ({
    id: 'sp_goertzel', title: 'Goertzel for one tone', level: 'sequential', allowed: 'nand',
    brief: 'One resonator for one tone at a time. <b>x</b> is an 8-bit signed sample and <b>c</b> a 16-bit signed coefficient, 2 cos(2πf) in Q2.14 (value = c / 2<sup>14</sup>), a pin because one resonator serves all eight keypad tones, one after another. '
      + 'Two 16-bit registers hold the state: at each rising clock <b>s1</b> takes s = x + c·s1 − s2 and <b>s2</b> takes the old s1. The product c·s1 comes down by 14 bits and rounds half up, once; the sum wraps in 16 bits (the word is sized so that it never has to for 8-bit input). '
      + '<b>clr</b> = 1 at a clock empties both registers instead, whatever x says. The multiplier is given. '
      + `The bench plays ${GZ_BLOCK}-sample blocks of the keypad tones (seeded keys, noise of ±${GZ_NOISE}), each block eight times with one tone's coefficient and a clear before it, compares s1 and s2 with the chapter's model after every clock, and finally reads the key from the eight powers.`,
    ports: pinsOf(GZ_REF()),
    check: { kind: 'custom', describe: `32 blocks of ${GZ_BLOCK} samples (28 keypad blocks, the worst case of each tone and its mirror, full-scale alternation, a constant) at each of the 8 tones: s1 and s2 after every clock, then the key read from the powers.`, run: runGoertzel },
    answer: refOf('sp_goertzel', GZ_REF, 'Goertzel resonator'),
  }),

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
  sp_cordic: () => ({
    id: 'sp_cordic', title: 'A CORDIC stage', level: 'gates', allowed: 'nand',
    brief: `One stage of a CORDIC rotator, the one that moves by 1 place (angle atan ½): <b>x</b>, <b>y</b> are ${CORDIC_SPEC.w}-bit two's complement, <b>z</b> a ${CORDIC_SPEC.z}-bit angle in which ${2 ** CORDIC_SPEC.z} steps are a full turn (atan ½ is ${atanTable(CORDIC_SPEC)[CORDIC_I]} of them). `
      + 'Turn the vector by that angle one way or the other: <b>xo</b> = x ∓ (y ≫ 1), <b>yo</b> = y ± (x ≫ 1), <b>zo</b> = z ∓ atan ½, where ≫ drops bits toward −∞. '
      + 'With <b>rotate</b> = 1 the upper sign is taken when z ≥ 0, driving z toward 0; with rotate = 0 it is taken when y &lt; 0, driving y toward 0. Check runs every input (65 536) against the model of the chapter.',
    ports: pinsOf(CORDIC_REF()),
    check: { kind: 'table', spec: cordicSpec },
    answer: refOf('sp_cordic', CORDIC_REF, 'CORDIC stage'),
  }),

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
