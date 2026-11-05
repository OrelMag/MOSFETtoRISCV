// Act 13, Signals: optional levels from the Signal processing chapters. Each block is a small build checked against the
// chapter's model (builddsp.ts). The MAC with guard bits and the circular address come with the MAC unit and the DSP core;
// the levels not built yet are on the map as "coming soon" in the order they will play. No DOM.

import type { CampaignNode } from './types';
import { BUILDDSP, cicGives, cordicGives, satGives } from './builddsp';
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
    id: 'sp_mac', act: 13, title: 'MAC with guard bits', kind: 'build', optional: true, soon: true, requires: ['sp_sat'],
    why: 'Coming with the MAC unit: a product added into an accumulator wide enough that a worst-case dot product never wraps, and one clamp at the end.',
    tips: [], codex: [],
  },
  {
    id: 'sp_circ', act: 13, title: 'Circular address', kind: 'build', optional: true, soon: true, requires: ['c_computer'],
    why: 'Coming with the DSP core: a pointer that steps through a buffer and wraps to its start with no instruction spent on it.',
    tips: [], codex: [],
  },
  {
    id: 'sp_biquad', act: 13, title: 'A biquad', kind: 'build', optional: true, soon: true, requires: ['sp_sat'],
    why: 'Five products and two sums in feedback: the section every IIR filter is built from, graded on NANDs and period.',
    tips: [], codex: [],
  },
  {
    id: 'sp_goertzel', act: 13, title: 'Goertzel for one tone', kind: 'build', optional: true, soon: true, requires: ['sp_sat'],
    why: 'One resonator, one multiplier, two registers: the energy at one frequency, enough to hear which key of a keypad is pressed.',
    tips: [], codex: [],
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
      'The decision is the sign of y2, read before the edge and stored in a flip-flop; the sums are wider than the input so they do not wrap. Check names the first clock at which your bit, y1 or y2 leaves the model.',
    ],
    codex: ['sigmadelta', 'noiseshaping'], chapters: [{ chapter: 'converters', step: 4, label: 'One bit, and feedback' }, { chapter: 'converters', step: 5, label: 'The loop in gates, and its CIC' }],
  },
];
