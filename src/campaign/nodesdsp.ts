// Act 13, Signals: optional levels from the Signal processing chapters. Each block is a small build checked against the
// chapter's model (builddsp.ts). The MAC with guard bits and the circular address come with the MAC unit and the DSP core;
// the levels not built yet are on the map as "coming soon" in the order they will play. No DOM.

import type { CampaignNode } from './types';
import { BUILDDSP, satGives } from './builddsp';

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
