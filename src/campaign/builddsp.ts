// Act 13's build levels (Signals, the Signal processing level's optional act): a saturating adder, a biquad, Goertzel for one
// tone, a CIC decimator, a CORDIC stage and a sigma-delta loop, each checked against the chapter's model (dsp/). The reference
// answers are the chapters' library circuits drawn as chips. The MAC with guard bits and the circular address wait for the
// MAC unit and the DSP core. No DOM.

import type { BuildChallenge } from '../editor/challenges';
import { clampWord, satAdder } from '../lib/fixedpt';
import type { ComponentDef } from '../sim/types';
import { goertzelCell, GZ_STATE } from '../lib/goertzel';
import { RV16_MUX2 } from '../lib/rv16/logic';
import { leafGives, pinsOf, refOf } from './buildcomm';
import { GZ_BLOCK, GZ_NOISE, runGoertzel } from './goertzelcheck';

/** The word of the saturating adder level: 8 bits, so Check runs every pair (65 536). */
export const SAT_W = 8;
export const SAT_REF = (): ComponentDef => satAdder(SAT_W);
export const SAT_CLAMP = (): ComponentDef => clampWord(SAT_W);
/** The adder's parts, the clamp's included: the clamp itself is what the level builds. */
export const satGives = leafGives(SAT_REF, () => [SAT_CLAMP()]);

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

  // ---- sp_cordic

  // ---- sp_sd

};
