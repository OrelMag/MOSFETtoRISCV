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
  sp_goertzel: {
    problem: 'A keypad key is two tones out of eight, and the decoder wants to know which. An FFT of the block computes 129 bins and the decoder keeps two. A resonator tuned to one frequency computes just that bin: it rings up on a matching tone and stays small on the rest, and after the block its last two values give the power there. The same resonator, with another coefficient, serves the other seven.',
    without: 'Without the clear the second tone starts from the first one\'s ringing, and every power after it is wrong by an amount that depends on the key before. Without the half-up rounding each product loses half a step on average, and a resonator with its poles on the unit circle never forgets it.',
    cost: 'The cell is 4 389 NANDs (4 419 in the chapter, whose clear uses the 64-NAND library bus mux; this one shares the inverter), 3 427 of them the 16 × 16 multiplier; the recurrence around it (two 16-bit registers, two adders, the rounder, a clear) is 962. One cell does a key in 8 × 206 = 1 648 clocks, so at 8 kHz samples it needs a clock of at least 64 kHz and a store for the block. Eight cells at the sample rate are 35 112 NANDs; a 256-point streaming FFT is 167 844.',
    alts: [{ name: 'Goertzel resonator, 16-bit state (library)', lib: 'goertzel16' }],
  },

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

  // ---- sp_mac
  sp_mac: {
    problem: 'A filter output is a sum of products, and the partial sums wander. A run of large positive taps takes the sum far past what a 32-bit result holds, and later negative ones bring it back: the final sum fits, the middle did not. An accumulator the width of a result has to clamp or wrap in the middle, and either one makes the answer wrong; an accumulator with guard bits keeps the sum exact and lets the result be rounded and clamped once, when it is read.',
    without: 'Clamp every sum on the way in and an excursion past 32 bits is cut off: the sum that comes back is off by the whole overshoot, not by a rounding step. Wrap at the result width and it is off by 2^32. With 8 guard bits 255 mac2 (511 mac) of full-scale operands still fit, and a 64-tap Q1.15 filter uses 6 of the 8 bits. Past 40 bits the register wraps as two\'s complement, with no flag: 256 full-scale mac2 turn +2^39 into −2^39.',
    cost: 'The unit is 10 081 NANDs and 127 NAND delays a clock. Two signed 16 × 16 tree multipliers are 3 572 NANDs each, 7 144 together; the read path (shifter, rounder, clamp) is 1 384, of which the clamp is 195; the 40-bit register is 600, its adder 360, the pair adder 297. A clamp on every add would put a second clamp of 188 NANDs in the loop and still be wrong.',
    alts: [{ name: 'MAC unit, 40-bit accumulator (library)', lib: 'macunit' }, { name: 'Read path: shift, round, clamp (library)', lib: 'macread' }],
  },

  // ---- sp_circ
  sp_circ: {
    problem: 'A filter keeps its last N samples, and every new sample pushes the others one place along. Done in memory that is N loads and N stores a sample. Leave the samples where they are, write the new one over the oldest, and let the pointer walk the buffer and go back to its start at the end: the address step has to do the wrap, because an instruction spent on it is a clock lost on every tap.',
    without: 'A plain pointer runs off the end of the buffer into whatever follows it, and the program repairs it with a compare and a branch each tap. In the core that costs a clock a tap, doubling a one-clock loop body. The same adder also has to serve a step of m for a strided walk and a bit-reversed order for an FFT, or each of those takes a program of its own.',
    cost: 'The whole step is 639 NANDs and 53 delays: four 8-bit adders of 72 NANDs each (the pointer step, the window end, the end minus 1 and the reverse-carry add), two equality comparators of 54, five 8-bit muxes of 32, the mode decoder of 35, the step inverter of 32 and 16 gates of glue. The reversals are wiring and cost nothing. The circular modes cost 323 of that: two comparators, two adders for the end, two muxes and the gates that join them.',
    alts: [{ name: '8-bit adder (library)', lib: 'rca8' }, { name: 'Address step, all eight modes (library)', lib: 'dsp24_agu_step' }],
  },

};
