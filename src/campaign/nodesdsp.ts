// Act 13, Signals: optional levels from the Signal processing chapters. Each block is a small build checked against the
// chapter's model (builddsp.ts). The MAC with guard bits and the circular address come with the MAC unit and the DSP core;
// the levels not built yet are on the map as "coming soon" in the order they will play. No DOM.

import type { CampaignNode } from './types';
import { BUILDDSP, biquadGives, satGives } from './builddsp';

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
    id: 'sp_goertzel', act: 13, title: 'Goertzel for one tone', kind: 'build', optional: true, soon: true, requires: ['sp_sat'],
    why: 'One resonator, one multiplier, two registers: the energy at one frequency, enough to hear which key of a keypad is pressed.',
    tips: [], codex: [],
  },
  {
    id: 'sp_cic', act: 13, title: 'CIC decimator', kind: 'build', optional: true, soon: true, requires: ['sp_sat'],
    why: 'Integrators at the high rate, combs at the low rate, no multiplier: a filter that throws away most of the samples for the price of adders.',
    tips: [], codex: [],
  },
  {
    id: 'sp_cordic', act: 13, title: 'A CORDIC stage', kind: 'build', optional: true, soon: true, requires: ['sp_sat'],
    why: 'Three adders and two shifts turn a vector by a fixed angle one way or the other: one step of a rotation with no multiplier.',
    tips: [], codex: [],
  },
  {
    id: 'sp_sd', act: 13, title: 'Sigma-delta loop', kind: 'build', optional: true, soon: true, requires: ['sp_cic'],
    why: 'An integrator, a comparator and feedback: one bit a clock whose average is the input, and noise pushed to where a filter removes it.',
    tips: [], codex: [],
  },
];
