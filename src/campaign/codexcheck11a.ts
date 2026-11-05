// Check yourself for the Signal processing level: numbers that fit, the z-plane. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK11A: Record<string, Quiz[]> = {
  qformat: [
    {
      question: 'What is the largest value in Q1.7, and what is the step between values?',
      options: ['127 / 128, in steps of 1 / 128', '1, in steps of 1 / 128', '127, in steps of 1', '255 / 128, in steps of 1 / 128'],
      answer: 0,
      explain: 'Q1.7 is eight bits with the point after the sign: the largest word is 0111 1111 = 127, meaning 127 / 128. There is a word for −1 and none for +1.',
      why: ['', 'No word means +1, which is why a coefficient of exactly 1 needs care.', 'That is the same word read as an integer; the format moves the point.', 'That would need an unsigned word, and here the top bit is the sign.'],
    },
    {
      question: 'Two Q1.7 words are multiplied into a 16-bit product. By how many places does it come down to return to Q1.7?',
      options: ['7: the product is Q2.14, with two sign bits', '8: the word length', '16: the whole product', '0: a fraction times a fraction needs no shift'],
      answer: 0,
      explain: 'The product has 14 fraction bits and the answer wants 7, so 7 are dropped. Shifting by 8 would halve every answer.',
      why: ['', 'That keeps the spare sign bit, so every answer comes out half its size.', 'That would throw away everything, leaving only the sign.', 'The product has twice the fraction bits, so its point sits in a different place.'],
    },
  ],
  saturate: [
    {
      question: 'In an 8-bit signed word, 0111 1111 + 0000 0001 is computed. What do a wrapping and a saturating adder give?',
      options: ['Wrapping: −128. Saturating: 127', 'Wrapping: 127. Saturating: −128', 'Both give −128 and set a flag', 'Wrapping: 128. Saturating: 128'],
      answer: 0,
      explain: 'The wrapped sum is 1000 0000, the most negative word; the saturating adder stops at the rail, 0111 1111.',
      why: ['', 'That has the two the wrong way round.', 'A flag tells the program about it, but only the wrapped result changes sign.', 'There is no 8-bit signed word for 128.'],
    },
    {
      question: 'How does a saturating adder know the sum does not fit in w bits?',
      options: ['It adds with one more bit and finds the top two bits differ', 'The carry out of the top bit is 1', 'The sum is zero', 'Either input is negative'],
      answer: 0,
      explain: 'A (w + 1)-bit sum cannot overflow. If its top two bits agree it fits; if not, the top bit is the true sign and picks the limit.',
      why: ['', 'The carry out tells unsigned overflow; a signed sum can overflow with no carry out.', 'A zero sum always fits.', 'Two negatives can fit, and so can a negative and a positive.'],
    },
  ],
  guardbits: [
    {
      question: 'A filter sums 512 products, each below 1 in magnitude. How many guard bits can the worst case need?',
      options: ['9: log₂ 512', '512', '5: one for each hundred taps', '1: the sign bit'],
      answer: 0,
      explain: 'Each product may be nearly full scale, so the sum can reach 512 times a product, 2⁹ times: nine bits above the product.',
      why: ['', 'That is the number of terms; the bits are its logarithm.', 'The need grows with the logarithm of the count, not in proportion to it.', 'The sign is already counted; the growth is above it.'],
    },
    {
      question: 'An accumulator wraps part way through a sum whose final value is known to fit. What is the result?',
      options: ['Correct: the arithmetic is modulo 2^w', 'Off by the amount that wrapped', 'Saturated at the rail', 'Wrong in its sign only'],
      answer: 0,
      explain: 'Every step is right modulo 2^w. A value that fits is fixed by its residue, so the excursion leaves no trace; a clamp would have lost it.',
      why: ['', 'A wrap removes exactly 2^w, which a later wrap or the true sum fitting puts back.', 'A wrapping adder never clamps; that is the saturating one.', 'If the final value fits, the top bit is its true sign.'],
    },
  ],
  headroom: [
    {
      question: 'A filter\'s impulse response sums, in absolute value, to 5.5. At least how many bits must the input be shifted down to rule out overflow for any input?',
      options: ['3: the input stays under 1 / 8', '2: the input stays under 1 / 4', '5: one bit for each unit of gain', '6: the gain rounded up, doubled'],
      answer: 0,
      explain: 'The worst output is 5.5 times the input peak. 1 / 4 is 0.25, above 1 / 5.5 = 0.18, so two bits are not enough; three give 0.125.',
      why: ['', 'A quarter is larger than 1 / 5.5, so a full-scale input could still overflow.', 'The bits count a power of two, not the gain itself.', 'That rounds the gain up as a number, where the shift is its logarithm.'],
    },
    {
      question: 'A gain of 1 is made from a shift down by 3 bits and a shift up by 3 bits, and the signal only reaches a tenth of full scale. What is the better order?',
      options: ['Up first: no bits are thrown away', 'Down first, to leave headroom', 'Either one: the overall gain is 1', 'Neither: it needs floating point'],
      answer: 0,
      explain: 'A tenth of full scale times 8 still fits. Going down first throws 3 bits away, and the later gain raises the rounding noise with the signal.',
      why: ['', 'There is room already, and the bits thrown away cannot be brought back.', 'The gain is the same; the noise is not, 78.1 dB against 59.7 dB here.', 'The signal fits with room to spare.'],
    },
  ],
  diffeq: [
    {
      question: 'y[n] = x[n] + 0.5 y[n−1], starting from rest, receives an impulse of 1 at n = 0. What is y[2]?',
      options: ['0.25', '0.5', '1', '0'],
      answer: 0,
      explain: 'y[0] = 1, y[1] = 0.5 × 1, y[2] = 0.5 × 0.5. Each output is half the last.',
      why: ['', 'That is y[1].', 'That is y[0], the first output.', 'An FIR filter would be finished by now; this one has feedback.'],
    },
    {
      question: 'y[n] = b₀x[n] + b₁x[n−1] + b₂x[n−2] − a₁y[n−1] − a₂y[n−2]. What does one output cost?',
      options: ['5 multiplications, 4 additions, 4 words', '3 multiplications, 2 additions, 2 words', '5 multiplications, 4 additions, 2 words', '4 multiplications, 5 additions, 5 words'],
      answer: 0,
      explain: 'One multiplication per coefficient, one addition per term after the first, and one word for each delay: two of the input, two of the output.',
      why: ['', 'That counts only the b terms and forgets the feedback.', 'The outputs need their own two words as well as the inputs.', 'It is the coefficients that cost multiplications, and the first term needs no addition.'],
    },
  ],
  convolution: [
    {
      question: 'A block of 10 samples goes through a filter of 4 taps by direct convolution. How many samples come out, and how many multiplications?',
      options: ['13 samples, 40 multiplications', '10 samples, 40 multiplications', '13 samples, 13 multiplications', '14 samples, 40 multiplications'],
      answer: 0,
      explain: 'N + M − 1 = 13 samples, and each of the 10 inputs meets each of the 4 taps once: 40.',
      why: ['', 'The extra M − 1 samples are the filter\'s tail after the input stops.', 'Every pair of input and tap needs its own multiplication.', 'The length is N + M − 1, one less than N + M.'],
    },
    {
      question: 'Two filters with taps 1, 1 and 1, 1 are connected one after the other. What are the taps of the pair?',
      options: ['1, 2, 1', '2, 2', '1, 1, 1, 1', '1, 1'],
      answer: 0,
      explain: '(1 + z⁻¹)² = 1 + 2z⁻¹ + z⁻²: convolving the taps is multiplying the polynomials.',
      why: ['', 'That adds them, which would be two filters in parallel.', 'That appends the lists, which is not an operation on filters.', 'The first filter has not gone away.'],
    },
  ],
  ztransform: [
    {
      question: 'A filter has taps 1, 2, 1. What is its gain at half the sample rate?',
      options: ['0: a double zero at z = −1', '4: the sum of the taps', '2: the middle tap alone', '1: the first tap alone'],
      answer: 0,
      explain: 'Half the sample rate is z = −1, and 1 − 2 + 1 = 0. The gain at DC is 4.',
      why: ['', 'That is the gain at DC, where z = 1, not at z = −1.', 'At z = −1 the taps alternate in sign and cancel the middle one.', 'The first tap is only one of three terms of the sum.'],
    },
    {
      question: 'Which point on the unit circle is a frequency of a quarter of the sample rate?',
      options: ['z = j, an angle of 90°', 'z = 1', 'z = −1', 'z = 0.25'],
      answer: 0,
      explain: 'z = e^(j2πf) with f = 0.25 is e^(jπ/2) = j. Each delay turns a tone at this frequency by a quarter turn.',
      why: ['', 'That is DC, an angle of 0.', 'That is half the sample rate, an angle of 180°.', 'That is a point on the real axis inside the circle, and no frequency has it.'],
    },
  ],
  polezero: [
    {
      question: 'A zero on the circle and a pole just inside it, both at 0.2 cycles a sample. What does the filter do near that frequency?',
      options: ['A notch: a null with full gain beside it', 'A peak at 0.2, as a pole makes', 'Nothing at all: pole and zero cancel', 'It becomes unstable at 0.2'],
      answer: 0,
      explain: 'The zero gives the null; just beside it the pole\'s distance is nearly the zero\'s, so the ratio returns to about 1.',
      why: ['', 'That needs a pole with no zero beside it.', 'They cancel only exactly at the same point; one is on the circle and one inside.', 'A pole inside the circle is stable, however close.'],
    },
    {
      question: 'y[n] = x[n] + 1.2 y[n−1] − 0.5 y[n−2]. Is it stable?',
      options: ['Yes: poles of radius √0.5, about 0.71', 'No: the 1.2 is greater than 1', 'No: feedback filters all diverge', 'It depends on the input signal'],
      answer: 0,
      explain: 'The product of a conjugate pair is r², so r² = 0.5. Both poles are inside the circle.',
      why: ['', 'A coefficient may exceed 1; the roots decide.', 'A pole inside the circle dies away.', 'Stability is a property of the filter, not of what is fed in.'],
    },
  ],
  minphase: [
    {
      question: 'A symmetric FIR filter has 201 taps. How long, in samples, is its delay at every frequency?',
      options: ['100', '201', '101', '0'],
      answer: 0,
      explain: 'A symmetric filter of N taps delays everything by (N − 1) / 2 samples, the centre of the taps.',
      why: ['', 'That is the length of the filter, twice the delay.', 'That is the number of taps up to and including the centre.', 'Linear phase means the same delay at all frequencies, not none.'],
    },
    {
      question: 'Two filters have a zero at the same angle, one at radius 0.5 and one at radius 2. How do they compare?',
      options: ['Same gain shape; the inner one has less delay', 'Same delay, but different gain shapes', 'The outer one has the smaller delay', 'Identical in every respect'],
      answer: 0,
      explain: 'A zero and its mirror image across the circle differ in gain only by a constant factor and in delay by a lot. Inside gives the least delay a gain can have.',
      why: ['', 'The gain shape is what stays the same; the phase differs.', 'The zero outside adds delay.', 'The taps are reversed, so the delay is not the same.'],
    },
  ],
};
