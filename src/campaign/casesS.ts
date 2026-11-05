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

  // ---- sp_cic
  sp_cic: {
    problem: 'A sample stream at a high rate has to reach a slower consumer, and keeping every fourth sample alone folds everything between the new rates onto the band you want. A filter has to come first, and a good one needs multipliers at the high rate, where there is no time for them. Moving averages need none, and a moving average computed as a running sum needs no memory of the samples either.',
    without: 'Sample-and-drop passes noise from the rest of the spectrum straight into the band. A saturating integrator, the careful-looking choice, fails differently: it clamps a sum the combs need exactly, and the output is wrong for as long as the input stays loud.',
    cost: 'Order 2, ÷ 4, 6-bit samples: 1 263 NANDs and a period of 41 delays. Each of the two integrators is 240 NANDs (a 10-bit adder and a register), each comb 284, the counter 50, the output register 150 and valid 15. The adders run once per input clock and the combs once per group; nothing multiplies.',
    alts: [{ name: 'CIC decimator, order 2, ÷ 4 (library)', lib: 'cic2_4_6' }],
  },

  // ---- sp_cordic
  sp_cordic: {
    problem: 'Turning a vector by an angle is four multiplications and two sums. A CORDIC does it with a fixed ladder of angles, atan 1, atan ½, atan ¼ …: each stage turns by its own angle one way or the other, and the choice of way is the only decision. A stage is that step: x and y each take a shifted copy of the other, z takes off the angle.',
    without: 'Without the stage, a rotation by an arbitrary angle needs a multiplier per product. With it the shift is a set of wires and the angle a constant, so the stage has no multiplier and no shifter, only adders.',
    cost: 'Three 5-bit add / subtracts are 69 NANDs each, 207 together; the direction logic (two inverters and a mux) adds 6: 213 NANDs and 21 delays for the whole stage. A 4-bit array multiplier alone is 140 NANDs and 30 delays, and a rotation by any angle needs four of them.',
    alts: [{ name: '5-bit add / subtract (library)', lib: 'addsub5' }, { name: '4-bit array multiplier (library)', lib: 'amul4' }],
  },

  // ---- sp_sd
  sp_sd: {
    problem: 'A converter with one comparator and one bit can only say above or below, and a comparator is cheap and exact. Fed back through a running sum, it says it fast enough that the average of its bits is the input, and its error (the quantizer error) is pushed to high frequencies, where a digital filter removes it.',
    without: 'A one-bit quantizer alone has an error as large as the signal. In the loop the error is shaped by (1 − z⁻¹) per order: with 64 clocks per output sample a first-order loop reaches about 50 dB and a second-order one about 70 dB on a half-scale tone, from the same single bit.',
    cost: 'First order is 502 NANDs, second order 987: a second adder, subtractor and register of 13 bits. The 8 input bits become a bit each clock, and the loop has no multiplier. The 16-bit loop of the chapter is 1 579 NANDs; the filter after it (the CIC level) costs more than the loop.',
    alts: [{ name: 'First-order loop (one sum)', nand: 502, note: 'sdModulator(1, 8), counted by the simulator' }, { name: 'Second-order loop (two sums)', nand: 987, note: 'sdModulator(2, 8), counted by the simulator' }],
  },

};
