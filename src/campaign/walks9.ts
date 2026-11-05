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
  sp_goertzel: [
    {
      title: 'The product, brought back to the word',
      text: 'mul multiplies the 16-bit coefficient by the state s1 and gives 30 bits: a Q2.14 number times an integer. hi keeps bits 29 to 14, which is the product divided by 2^14, and lo is bit 13, the first bit dropped. rnd adds it back: round half up, once, and the cost is a row of half adders.',
      parts: ['mul', 'hi', 'lo', 'rnd'], codex: ['qformat'],
      why: 'Cutting bits is free, since it is only how the wires run. Truncating would be cheaper by the rounder, and would lose half a step a sample, which a resonator never forgets.',
      whyNot: { text: 'A shorter state word would make the multiplier smaller, but the worst-case block takes 16 bits to hold: 15 overflows on the worst input.' },
    },
    {
      title: 'x plus the product, minus s2',
      text: 'xs copies the sign of the 8-bit sample into 16 bits. a1 adds it to the rounded product. nr2 inverts s2 and a2 adds that with a carry in of one: that is the subtraction, two\'s complement.',
      parts: ['xs', 'a1', 'nr2', 'a2', 'one', 'zero'], codex: ['headroom'],
      ask: {
        question: 'What does the sum do if a partial result such as x + c·s1 passes the 16-bit word?',
        options: ['It wraps, and the final s[n] is still right, because the arithmetic is modulo 2^16 and s[n] itself fits', 'The state is wrong from there on: a partial sum has to fit as well', 'The adder saturates, so the state sticks at full scale', 'It sets a flag the registers hold until clr'],
        answer: 0,
        explain: 'Adding and subtracting modulo 2^16 gives the true value mod 2^16, and the true s[n] is within the word for 8-bit input, so the answer is exact.',
        why: ['', 'Only the final value has to fit; the partial sums are intermediate in a modular computation.', 'These adders wrap; no clamp is drawn.', 'There is no flag in the cell.'],
      },
      why: 'Two plain adders. The width is the worst-case sum of the impulse response over the block, which is what makes 16 bits enough for 8-bit input.',
      whyNot: { text: 'Subtracting by an adder with an inverted s2 and a carry in of one is the only subtractor needed; a separate one would cost more for the same result.' },
    },
    {
      title: 'Two registers, and a clear',
      text: 'r1 holds s1 and r2 holds s2: r2 loads what r1 held, and r1 loads the new s. m1 and m2 put zeros in front of each when clr is 1. The clear replaces the update, so x does not matter at that clock.',
      parts: ['r1', 'r2', 'm1', 'm2', 'zeros'], codex: ['goertzel'],
      why: 'A block starts from rest. One cell serves eight tones in turn, and the clear between them is what makes each power that tone\'s alone.',
      whyNot: { text: 'Clearing only r1 leaves s2 holding the last tone\'s state: the first sample of the next block is then wrong by that amount.' },
    },
  ],

  // ---- sp_cic

  // ---- sp_cordic

  // ---- sp_sd

};
