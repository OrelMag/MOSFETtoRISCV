// Act 13, Signals: optional levels from the Signal processing chapters. Each block is a small build checked against the
// chapter's model (builddsp.ts). No DOM.

import type { CampaignNode } from './types';
import { BUILDDSP, biquadGives, cicGives, circGives, cordicGives, gzGives, macGives, satGives } from './builddsp';
import { sdGives } from './sdcheck';

export const NODES_DSP: CampaignNode[] = [
  {
    id: 'sp_sat', act: 13, title: 'Saturating adder', kind: 'build', optional: true, requires: ['c_computer'], base: BUILDDSP.sp_sat, givesOf: satGives,
    unlocks: ['satadd8'], par: { nand: 118, depth: 28 },
    why: 'An adder wraps: 127 + 1 is −128, and a loud signal that passes full scale comes out as a crack at the opposite end. A sample should stop at the top instead. One bit more than the word holds the true sum, and its top two bits say whether it fits.',
    tips: [
      'Sign-extend both words to 9 bits and add: the 9-bit sum is always exact.',
      'The sum fits in 8 bits exactly when its top two bits are equal. sat is their XOR.',
      'When it does not fit, the 9-bit sum\'s top bit is the true sign: a positive overflow gives 0111 1111, a negative one 1000 0000. One mux picks the sum or that limit.',
    ],
    codex: ['saturate', 'guardbits'], chapters: [{ chapter: 'fixed', step: 2, label: 'A saturating adder' }],
  },
  {
    id: 'sp_mac', act: 13, title: 'MAC with guard bits', kind: 'build', optional: true, requires: ['sp_sat'], base: BUILDDSP.sp_mac, givesOf: macGives,
    unlocks: ['macunit'], par: { nand: 10081, period: 127 },
    why: 'A dot product adds many products, and the partial sums wander: they can run far past what a result word holds and come back. Clamp each sum as it is added and the excursion is lost for good; keep 8 guard bits above the 32-bit product and 255 mac2 (511 mac) of full-scale operands still fit, so the sum stays exact and the clamp happens once, at the read. A 64-tap Q1.15 filter adds at most 64 × 2^30 = 2^36, an eighth of what the register can reach. Past 40 bits the register wraps as two\'s complement, with no flag: the guard bits are a budget, not a promise.',
    tips: [
      'Sign-extend the sum of the two products (mac2 adds both, mac only the low pair: a mux sends 0 for the high product) to 40 bits and add it to the register. The register loads when en is 1 and op is not racc; clracc loads 0 instead. Nothing here is clamped.',
      'The word is 40 bits because a product is 32: 255 × 2^31 (mac2 of −32768 × −32768 pairs) is just under 2^39, the largest a signed 40-bit word holds. A 39-bit register wraps long before; the 256th full-scale mac2 wraps even a 40-bit one, to −2^39, and that is the model\'s answer too.',
      'Read once: put one zero below the 40 bits, shift right by sh (arithmetic, six stages of 1, 2, 4 … 32), and the bit that falls out first is the rounding bit. Add it back with half adders into a 41-bit word, then clamp once from 41 to 32 bits: the top 10 bits must agree. y follows the register at all times; racc only names the moment you look.',
    ],
    codex: ['multacc', 'guardbits', 'saturate'], chapters: [{ chapter: 'mac', step: 1, label: 'The MAC unit, in gates' }, { chapter: 'mac', step: 3, label: 'The accumulator and its read' }],
  },
  {
    id: 'sp_circ', act: 13, title: 'Circular address', kind: 'build', optional: true, requires: ['c_computer'], base: BUILDDSP.sp_circ, givesOf: circGives,
    unlocks: [], par: { nand: 639, depth: 53 },
    why: 'A filter keeps its last N samples, and shifting them costs N moves a sample. Leave them still and move the pointer: it steps by one and, at the end of its window, goes back to the start by itself, with no instruction spent. The level is the DSP core\'s whole address step, eight modes, because one adder serves them all: a plus or minus 1 or m, the same step wrapped at the window\'s end, and a bit-reversed one for an FFT. Its subtlety is the end: base + length is an 8-bit sum that wraps, and a window may cross 255.',
    tips: [
      'One adder does p ± 1 and p ± m: pick 1 or m with a mux, invert it for a minus and carry a 1 in. Modes 4 and 5 start from the same sum, so the circular modes cost a comparison and a mux, not another adder.',
      'The window end is base + len in 8 bits, so it wraps when the window crosses 255. Mode 4 wraps when the next address (the adder\'s output) equals the end; mode 5 when p equals the base, and it goes to end − 1, which is one more 8-bit add of 255. Compare with equality, never with greater-than: a pointer outside the window must just step.',
      'Bit-reversed needs no adder of its own beyond one: reversing is wiring. Reverse p, reverse m, add, reverse the sum. Mode 0 is the last mux in line, and it must beat the others: a read without a step leaves p alone.',
    ],
    codex: ['counter', 'comparator', 'ripple', 'nicring'], chapters: [{ chapter: 'dspcore', step: 2, label: 'Address generators' }],
  },
  {
    id: 'sp_biquad', act: 13, title: 'A biquad', kind: 'build', optional: true, requires: ['sp_sat'], base: BUILDDSP.sp_biquad, givesOf: biquadGives,
    unlocks: ['biquad16'], par: { nand: 20313, period: 135 },
    why: 'A second-order IIR section: five products and two sums, two of them in a loop. Every output is built from earlier outputs, so whatever is rounded away goes round again: one rounding and one clamp, after a sum wide enough to hold every product bit, and the registers must hold the rounded words, not the exact ones. Five multipliers are 88% of the NANDs.',
    tips: [
      'Direct form I: four 16-bit registers, two chained from x and two chained from y. y[n] needs x[n] at once, so b₀ multiplies the input pin, not a register.',
      'A product of two 16-bit words is 32 bits; five of them need three guard bits, a 35-bit sum. Sign-extend every product to 35 bits before adding. The feedback terms are subtracted: add the inverse of their sum and a carry-in of 1, which also works for a₁ = −2.',
      '35-bit sum to Q1.15 word: keep bits 14 and up, add the first dropped bit (bit 13) back (round half up), then clamp once from 21 bits to 16. The clamped y is what goes in y[n−1], not the exact sum.',
    ],
    codex: ['biquad', 'limitcycle', 'guardbits'], chapters: [{ chapter: 'iir', step: 4, label: 'A biquad in gates' }, { chapter: 'iir', step: 5, label: 'A limit cycle on the gates' }],
  },
  {
    id: 'sp_goertzel', act: 13, title: 'Goertzel for one tone', kind: 'build', optional: true, requires: ['sp_sat'], base: BUILDDSP.sp_goertzel, givesOf: gzGives,
    unlocks: ['goertzel16_rv16'], par: { nand: 4389, period: 104 },
    why: 'A keypad key is two tones out of eight, and an FFT would compute 129 bins to keep two. One resonator, s = x + c·s1 − s2, rings up on the one frequency its coefficient names and stays small on the others; after a block its last two values give the power there. One multiplier, two adders and two registers, and the same cell serves all eight tones one after another: only c changes.',
    tips: [
      'The registers hold s1 and s2, and s2 loads the old s1. s1 loads the new s: the product c·s1 (c is a pin, in Q2.14), brought down by 14 bits and rounded, plus x, minus s2.',
      'The product is 30 bits wide for a 16-bit state and a 16-bit coefficient. Keep bits 29…14 and add bit 13 back, which is the half-up rounding; the other bits are wiring and cost nothing. Sign-extend x to 16 bits first.',
      'Subtract s2 by inverting it and carrying a 1 into the adder. Put a mux in front of each register that loads 0 when clr is 1: it replaces the update, whatever x is, and s2 must clear too, or the next tone starts from the last one\'s state.',
    ],
    codex: ['goertzel', 'qformat', 'headroom'], chapters: [{ chapter: 'spectrum', step: 6, label: 'One bin, cheaply: Goertzel' }, { chapter: 'spectrum', step: 7, label: 'A keypad in gates' }],
  },
  {
    id: 'sp_cic', act: 13, title: 'CIC decimator', kind: 'build', optional: true, requires: ['sp_sat'], base: BUILDDSP.sp_cic, givesOf: cicGives,
    unlocks: ['cic2_4_6'], par: { nand: 1263, period: 41 },
    why: 'Integrators at the high rate, combs at the low rate, no multiplier: a filter that throws away most of the samples for the price of adders. The integrators wrap all the time and that is correct: only differences of them reach the output, and two\'s complement differences survive a wrap. A register that saturates, the habit the saturating adder just taught, breaks it.',
    tips: [
      'An integrator is a register and an adder: next = value + input, every clock, wrapping. A comb is a register that loads only on the strobe and a subtractor: output = input minus the last loaded input.',
      'The registers need N × log2 R more bits than the samples, and every stage needs all of them: sign-extend x to the full width first, and make every integrator and comb that wide.',
      'The strobe is the last count of a group of R: a counter of log2 R bits, all ones. The combs and the output register load on it, and valid is the strobe in a register, so it rises with y.',
    ],
    codex: ['cic', 'decimation'], chapters: [{ chapter: 'multirate', step: 5, label: 'A moving average, rearranged' }, { chapter: 'multirate', step: 6, label: 'Sums that wrap' }, { chapter: 'multirate', step: 7, label: 'A CIC in gates' }],
  },
  {
    id: 'sp_cordic', act: 13, title: 'A CORDIC stage', kind: 'build', optional: true, requires: ['sp_sat'], base: BUILDDSP.sp_cordic, givesOf: cordicGives,
    unlocks: [], par: { nand: 213, depth: 21 },
    why: 'Three adders and two shifts turn a vector by a fixed angle one way or the other: one step of a rotation with no multiplier. The shifts are wiring and the angle a constant, so the only decision is which way: the sign of z (or of y) picks add or subtract in all three adders at once.',
    tips: [
      'x and y each move toward the other: xo = x ∓ (y ≫ 1), yo = y ± (x ≫ 1). A shift right by 1 is wiring: bit k of the result is bit k+1 of the input, and the top bit is copied.',
      'One signal d (1 = turn by +atan) drives all the adders: the z adder and the x adder subtract when d is 1, the y adder adds. the y adder takes the opposite of d.',
      'd comes from z ≥ 0 (the inverse of the top bit of z) when rotate is 1, and from y < 0 (the top bit of y) when rotate is 0: a 2:1 mux on rotate. The angle constant is atan ½ as a 5-bit word.',
    ],
    codex: ['cordic'], chapters: [{ chapter: 'cordic', step: 1, label: 'One way or the other' }, { chapter: 'cordic', step: 3, label: 'A stage is three adders' }],
  },
  {
    id: 'sp_sd', act: 13, title: 'Sigma-delta loop', kind: 'build', optional: true, requires: ['sp_sat'], base: BUILDDSP.sp_sd, givesOf: sdGives,
    unlocks: [], par: { nand: 987 },
    why: 'An integrator, a comparator and feedback: one bit a clock whose average is the input, and noise pushed to where a filter removes it.',
    tips: [
      'Two registers hold running sums. Each clock adds the input into y1 and y1 into y2, and takes away v, the one-bit DAC: +full scale after a 1, −full scale after a 0.',
      'v is wiring: the word for +full scale and the word for −full scale differ only in their top bits, and those are the bit and its inverse. Subtract it with the adders you have.',
      'The decision is the sign of y2, read before the edge and stored in a flip-flop; the sums are 5 bits wider than the input, enough below full scale; at full scale they wrap like the model. Check names the first clock at which your bit, y1 or y2 leaves the model.',
    ],
    codex: ['sigmadelta', 'noiseshaping'], chapters: [{ chapter: 'converters', step: 4, label: 'One bit, and feedback' }, { chapter: 'converters', step: 5, label: 'The loop in gates, and its CIC' }],
  },
];
