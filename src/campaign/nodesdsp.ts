// Act 13, Signals: optional levels from the Signal processing chapters. Each block is a small build checked against the
// chapter's model (builddsp.ts). The MAC with guard bits and the circular address come with the MAC unit and the DSP core;
// the levels not built yet are on the map as "coming soon" in the order they will play. No DOM.

import type { CampaignNode } from './types';
import { BUILDDSP, satGives } from './builddsp';
import { gzGives } from './builddsp';

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
