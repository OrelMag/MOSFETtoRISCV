// Level cases, act 13 (Signals). See cases.ts. The numbers are measured on the reference designs (sim/stats, logic depth) and
// pinned by tests/campaign-dsp.test.ts. No DOM.

import type { LevelCase } from './cases';

export const CASESS: Record<string, LevelCase> = {
  sp_sat: {
    problem: 'A sample is a number with a ceiling. Two loud signals added, or one given gain, go past it, and a two\'s complement adder then wraps: 127 + 1 is −128, the loudest positive sample turned into the loudest negative one. Played, that is a crack, not a little extra loudness.',
    without: 'With an 8-bit adder alone every overflow is a jump of 256 steps, a full-scale error from a sum that was one step too large. Saturating leaves an error of one step there.',
    cost: 'The 9-bit ripple adder is 81 NANDs and 22 delays; the clamp that reads its top two bits is 37 NANDs and 6 delays: 118 against 72 for the 8-bit adder that wraps. Every result of a filter pays it once, and an accumulator with guard bits pays it only at the end.',
    alts: [{ name: '8-bit adder that wraps (library)', lib: 'rca8' }, { name: '8-bit saturating adder (library)', lib: 'satadd8' }],
  },

  // ---- sp_biquad (its entry goes below this line)
  sp_biquad: {
    problem: 'A recursive filter reaches a narrow band with five coefficients where an FIR filter needs hundreds of taps, because each output is built from earlier outputs. That feedback is the whole difficulty in hardware: the previous two outputs are inputs of this one, so whatever the arithmetic throws away on one clock is part of the next sum.',
    without: 'Round each product, or let each sum wrap, and the error enters the loop five times a clock instead of once and sits at full scale when it wraps. Round once, at the end, and clamp once: the loop adds one half step of error a clock. Even so, a rounding inside a loop can hold an output up after the input has stopped: a resonator hit by one word keeps ringing at ±5 steps for ever (a limit cycle), where a filter that rounds toward zero dies away.',
    cost: 'Five 16 × 16 signed multipliers are 3 572 NANDs each, 17 860 of the 20 313; the four registers 960, four 35-bit adders 1 260 and an inversion, the rounder 105, the clamp 93. One clock is 135 NAND delays: a multiplier, three adders in a row, the rounder and the clamp. Rounding toward zero instead of half up costs 41 NANDs more.',
    alts: [{ name: 'Biquad, rounds half up (library)', lib: 'biquad16' }, { name: 'Biquad, rounds toward zero', nand: 20354, note: 'the second gate-level variant of the chapter, counted there (biquad16z)' }],
  },

  // ---- sp_goertzel

  // ---- sp_cic

  // ---- sp_cordic

  // ---- sp_sd

};
