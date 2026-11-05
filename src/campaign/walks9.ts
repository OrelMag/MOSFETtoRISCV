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
  sp_cordic: [
    {
      title: 'The shifts are wires, the angle a constant',
      text: 'xsc / xs and ysc / ys move x and y down one place: the low bit is dropped and the sign is copied into the top, an arithmetic shift made only of wires. atan is the angle of this stage, atan ½ as a share of a turn, a word tied to the rails.',
      parts: ['xsc', 'xs', 'ysc', 'ys', 'atan'], codex: ['cordic'],
      why: 'The stage index is fixed in the drawing, so nothing has to shift at run time: the cost of ≫ 1 is zero gates.',
      whyNot: { text: 'A barrel shifter with a count input is what an iterative CORDIC needs, one stage over and over. A pipelined stage never changes its shift.' },
    },
    {
      title: 'Which way',
      text: 'zsgn and nz give z ≥ 0. ysgn is y < 0. The mux d picks one by rotate: rotating, steer z to 0; vectoring, steer y to 0. nd is its opposite.',
      parts: ['zsgn', 'nz', 'ysgn', 'd', 'nd'], codex: ['cordic'],
      ask: {
        question: 'Rotating with z < 0 (the target angle is behind us), which way does the stage turn?',
        options: ['Against: d = 0, z grows by atan, x grows by y ≫ 1', 'With: d = 1, z shrinks by atan', 'It holds: the stage is skipped', 'It depends on the sign of y'],
        answer: 0,
        explain: 'z < 0 means the angle left to turn is negative, so the vector turns the negative way: z takes the angle back by adding it, and z moves toward 0. A stage is never skipped, so the gain stays constant.',
        why: ['', 'z would move away from 0, further from the target.', 'Skipping would make the gain depend on the angle.', 'When vectoring y decides; when rotating z does.'],
      },
      why: 'One bit of decision per stage, shared by all three adders.',
      whyNot: { text: 'Choosing from the sign of the new z after the subtraction would put the adder in the path of the decision: the stage would be twice as slow.' },
    },
    {
      title: 'Three adders',
      text: 'ax computes x ∓ (y ≫ 1), ay computes y ± (x ≫ 1) and az z ∓ atan. ax and az subtract when d = 1; ay adds then, so it takes nd.',
      parts: ['ax', 'ay', 'az'], codex: ['cordic'],
      why: 'These are the stage: x and y never see a multiplier, and the vector grows by a constant factor that no angle can change.',
    },
  ],

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
