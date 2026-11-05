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
  sp_biquad: [
    {
      title: 'Four words of memory',
      text: 'x1 and x2 hold the last two inputs, y1 and y2 the last two outputs; each pair is a chain, the second register reading the first. They load on every clock (the load input is tied high). The current x is not in a register: y[n] depends on x[n] at once.',
      parts: ['x1', 'x2', 'y1', 'y2', 'one'], codex: ['biquad'],
      why: 'Two samples of each, because the section is second order: the response to a step reaches back two clocks on both sides.',
      whyNot: { text: 'Direct form II shares one pair of registers for an in-between signal and saves two. The chapter builds direct form I because its whole sum has one rounding and one clamp, and what circulates is the output itself.' },
    },
    {
      title: 'Five products, kept whole',
      text: 'mb0 … ma2 multiply a 16-bit data word by a 16-bit coefficient: Q1.15 times Q2.14 is a 32-bit Q3.29 product, signed, exact. Nothing is dropped here. Three multiply the inputs (b₀ of x, b₁ of x1, b₂ of x2) and two the outputs (a₁ of y1, a₂ of y2).',
      parts: ['mb0', 'mb1', 'mb2', 'ma1', 'ma2'],
      why: 'Rounding a product would put an error into the loop for each one, five a clock. Keeping all 32 bits costs only wires; the adders after it are what get wider.',
      whyNot: { text: 'Truncating each product to 16 bits would shrink the adders and the accumulator, but the errors add up, and a small a₂ times a small y would vanish altogether.' },
    },
    {
      title: 'One exact sum, the feedback subtracted',
      text: 'eb0 … ea2 sign-extend each product to 35 bits: five terms of at most 2³⁰ need 3 more bits than a product. sum01 and sum012 add the three input terms, sumA the two feedback terms; inv inverts sumA and acc adds it with a carry in of 1: s − t = s + ¬t + 1. The sum is exact whatever the data.',
      parts: ['eb0', 'eb1', 'eb2', 'ea1', 'ea2', 'sum01', 'sum012', 'sumA', 'inv', 'acc', 'zero'], codex: ['guardbits'],
      why: 'Subtracting the whole feedback sum at the end needs one inverter row and one carry; negating a₁ and a₂ instead would turn the word −2, a legal a₁, into +2, which does not exist in Q2.14.',
      whyNot: { text: 'Adding the terms in a chain, one adder each, is the same number of adders and the same value, but puts four adders in series where the tree puts three, and a longer clock period: the bench grades the period.' },
    },
    {
      title: 'Round half up, once',
      text: 'hi keeps bits 34 … 14 of the 35-bit sum (29 fraction bits): 21 bits with 15 fraction bits. lo is bit 13, the first one dropped; round adds it to hi, which is round half up.',
      parts: ['hi', 'lo', 'round'],
      ask: {
        question: 'A sum is exactly +0.5 of an output step, and round half up gives 1. What does the circuit give for exactly −0.5?',
        options: ['Gives 0: bit 13 of −0.5 is a 1, added back to the value above it, which is −1 plus 1', 'Gives −1: half always rounds away from zero', 'Gives 0: negative sums are never rounded', 'Gives −1: the inverter row rounds the other way'],
        answer: 0,
        explain: 'Written in two\'s complement, −0.5 is …1111.1000…: the integer part is −1, the first dropped bit is 1, so the added bit makes it 0. Half goes up, whichever sign. Rounding toward zero would give 0 for both +0.5 and −0.5 and is a different circuit (41 NANDs more).',
        why: ['', 'Half-up rounds towards +∞; the sign plays no part. Away from zero would be another rule.', 'The rounder never looks at the sign; the bits do the work.', 'There is no second rounding rule in the inverter row: it only subtracts.'],
      },
      why: 'The dropped 14 bits are not wasted: a half step of error at most, once, instead of five.',
      whyNot: { text: 'Rounding toward zero is the other choice, 41 NANDs dearer, and unlike half up it kills the limit cycle of a resonator that rings after one input word.' },
    },
    {
      title: 'Clamp once, and what circulates',
      text: 'clamp brings the 21 bits to 16 and raises sat when it had to. Its y goes to the output and into y1, then y2. The registers hold the rounded, clamped words, not the exact sum: that is what the model does, and what makes the output after an impulse a rounding of a rounding. sat is the flag of the clamp.',
      parts: ['clamp'], codex: ['saturate', 'limitcycle'],
      why: 'A filter hit past full scale clamps, and the feedback must see the clamped value: the wrapped one would carry the overflow back in as a huge error.',
      whyNot: { text: 'Feeding the exact 35-bit sum back would need 35-bit registers and wider multipliers: five times the cost, and a different filter from the model.' },
    },
  ],

  // ---- sp_goertzel

  // ---- sp_cic

  // ---- sp_cordic

  // ---- sp_sd

};
