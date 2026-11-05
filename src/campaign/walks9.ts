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
  sp_cic: [
    {
      title: 'Sums at the high rate',
      text: 'sx sign-extends each sample to the full 10 bits. int0 and int1 are registers that add their input to themselves at every clock. Nothing is clamped: they run far past the word on any loud signal and wrap, and the word they wrap in is wide enough for the final difference.',
      parts: ['sx', 'int0', 'int1'], codex: ['cic'],
      why: 'Two running sums in a row do the summing of two moving averages without keeping a single past sample.',
      whyNot: { text: 'Saturating the sums, as the previous level did, throws away exactly what the combs later subtract: a clamped register forgets how far past full scale it went.' },
    },
    {
      title: 'A count, and the strobe',
      text: 'cnt counts 4 clocks and raises strobe when all its bits are one, the last clock of a group. Everything after the integrators loads only on that strobe: that is the whole rate change.',
      parts: ['cnt'], codex: ['decimation'],
      why: 'Dropping samples costs a counter and an enable; nothing is computed at the high rate only to be thrown away.',
    },
    {
      title: 'Differences at the low rate',
      text: 'comb0 and comb1 each subtract what their input was at the previous strobe. yr takes the result on the strobe and vr, valid, is the strobe registered the same way, so y and valid arrive together.',
      parts: ['comb0', 'comb1', 'yr', 'vr'], codex: ['cic'],
      ask: {
        question: 'An integrator wrapped five times between two strobes. Is the comb\'s difference wrong?',
        options: ['No: the difference is right modulo the word, and the word holds the true result', 'Yes: the wraps add 5 × 1024 to it', 'Only if the first sample after the wrap is negative', 'Yes, unless the comb is wider than the integrator'],
        answer: 0,
        explain: 'Two\'s complement arithmetic is arithmetic modulo 2^10. Each wrap takes a multiple of 1024 off a value, and the difference is the same number modulo 1024. If the true result fits in 10 bits it is exactly that.',
        why: ['', 'The extra multiples of 1024 sit in both values and cancel in the difference.', 'The sign of a sample does not matter to modular arithmetic.', 'Making the comb wider than the integrator changes nothing; the true result only has to fit.'],
      },
      why: 'Registers sized for the result, not for the sums, are the whole trick.',
      whyNot: { text: 'The combs could be narrower than the integrators with low bits dropped, as Hogenauer prunes them; this design keeps every bit to stay exact.' },
    },
  ],

  // ---- sp_cordic

  // ---- sp_sd

};
