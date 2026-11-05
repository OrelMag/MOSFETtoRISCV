// Authored walkthroughs, group 9: act 13, Signals (references: lib/fixedpt.ts … through builddsp.ts). See walks.ts for the
// conventions. No DOM.

import type { WalkScript } from './walk';

export const WALKS9: Record<string, WalkScript> = {
  sp_sat: [
    {
      title: 'One bit more than the word',
      text: 'xa and xb copy each word\'s sign into a ninth bit, and add sums the two 9-bit words. Any two 8-bit numbers add to between −256 and 254, which 9 bits always hold: this sum is never wrong.',
      parts: ['xa', 'xb', 'zero', 'add'], codex: ['guardbits'],
      why: 'Before deciding whether the result fits, you need the true result. One guard bit is enough for one addition.',
      whyNot: { text: 'Overflow can also be read from an 8-bit adder: the carries into and out of the sign bit differ. That saves the ninth bit of the adder, and the clamp takes its sign from a, since an overflow happens only when a and b share a sign.' },
    },
    {
      title: 'Does it fit, and which end',
      text: 'clamp reads the 9-bit sum. Its top two bits are equal exactly when the value fits in 8 bits; sat is their XOR. When they differ, the top bit is the true sign, and the mux puts out 0111 1111 for a positive overflow or 1000 0000 for a negative one.',
      parts: ['clamp'], codex: ['saturate'],
      ask: {
        question: 'The 9-bit sum of 100 and 100 is 0 1100 1000. What does the clamp put out?',
        options: ['127 and sat = 1: the top two bits differ and the top bit says positive', '−56 and sat = 1: the low 8 bits, with the overflow flagged', '200 and sat = 0: the sum is exact in 9 bits', '−128 and sat = 1: an overflow goes to the most negative value'],
        answer: 0,
        explain: 'Bits 8 and 7 are 0 and 1: it does not fit. Bit 8 is the true sign, 0, so the answer is the largest positive word.',
        why: ['', 'The low 8 bits are what a wrapping adder gives; the clamp replaces them when they are wrong.', 'The output is 8 bits wide: 200 is not a value it can hold.', 'The most negative value is for a sum below −128; this one is too large, not too small.'],
      },
      why: 'Two bits and a mux turn a full-scale error into an error of one step.',
      whyNot: { text: 'Clamping only on the carry out of bit 7 catches positive and negative overflow alike but cannot tell them apart: the sign of the clamp needs bit 8.' },
    },
  ],

  // ---- sp_biquad (its entry goes below this line)

  // ---- sp_goertzel

  // ---- sp_cic

  // ---- sp_cordic

  // ---- sp_sd
  sp_sd: [
    {
      title: 'One bit back, as a word',
      text: 'dec reads the sign of y2 and inverts it: a 1 means y2 is not negative. fb is wiring: +full scale and −full scale differ only in their top bits, which are one and the inverse of the decision. ux widens the input to the sum words.',
      parts: ['sign', 'dec', 'nb', 'fb', 'ux', 'rb'], codex: ['sigmadelta'],
      why: 'The one-bit DAC of a digital loop is free: the feedback word is the bit placed in the top bits of a word.',
      whyNot: { text: 'The decision could come from the sum after the update. That is a different loop, with a delay-free path from the decision into itself through the adders; the one in the chapter decides before the edge so that every output comes from a register.' },
    },
    {
      title: 'Two sums, the same feedback',
      text: 'a1 adds the input into y1 and s1 takes v away; the result is the next y1. a2 adds the new y1 into y2 and s2 takes the same v away. Both sums are 5 bits wider than the input, so they do not wrap for any tone up to 0.95 of full scale.',
      parts: ['r1', 'a1', 's1', 'r2', 'a2', 's2'], codex: ['noiseshaping'],
      ask: {
        question: 'The input is 0 and y1 = y2 = 0 at power-on. What does the loop do at the first clock?',
        options: ['It decides 1 (0 counts as not negative), y1 becomes −full scale and y2 becomes −2 full scales', 'Nothing: with u = 0 the sums stay at 0 and the bit is 0', 'It decides 0, since there is nothing to the sum to say 1', 'y1 becomes +full scale: a 1 is added'],
        answer: 0,
        explain: 'The decision uses the sign before the edge: 0 is not negative, so the bit is 1 and v = +full scale is taken away from both sums, including the new y1 going into y2.',
        why: ['', 'The feedback is v, never 0: the loop always takes one full scale away, and gives it back by deciding the other way later.', 'A zero sum is not negative, and the loop counts it as such.', 'A 1 takes full scale away; it does not add it.'],
      },
      why: 'Each sum integrates the error between the input and the bit. Two of them make the error twice as small at low frequencies, for twice the adders.',
      whyNot: { text: 'A single sum is the first-order loop, half the cost and about 20 dB less noise rejection at 64 clocks per sample.' },
    },
  ],

};
