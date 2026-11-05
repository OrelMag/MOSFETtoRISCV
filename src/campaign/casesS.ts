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

  // ---- sp_goertzel
  sp_goertzel: {
    problem: 'A keypad key is two tones out of eight, and the decoder wants to know which. An FFT of the block computes 129 bins and the decoder keeps two. A resonator tuned to one frequency computes just that bin: it rings up on a matching tone and stays small on the rest, and after the block its last two values give the power there. The same resonator, with another coefficient, serves the other seven.',
    without: 'Without the clear the second tone starts from the first one\'s ringing, and every power after it is wrong by an amount that depends on the key before. Without the half-up rounding each product loses half a step on average, and a resonator with its poles on the unit circle never forgets it.',
    cost: 'The cell is 4 389 NANDs (4 419 in the chapter, whose clear uses the 64-NAND library bus mux; this one shares the inverter), 3 427 of them the 16 × 16 multiplier; the recurrence around it (two 16-bit registers, two adders, the rounder, a clear) is 962. One cell does a key in 8 × 206 = 1 648 clocks, so at 8 kHz samples it needs a clock of at least 64 kHz and a store for the block. Eight cells at the sample rate are 35 112 NANDs; a 256-point streaming FFT is 167 844.',
    alts: [{ name: 'Goertzel resonator, 16-bit state (library)', lib: 'goertzel16' }],
  },

  // ---- sp_cic

  // ---- sp_cordic

  // ---- sp_sd

};
