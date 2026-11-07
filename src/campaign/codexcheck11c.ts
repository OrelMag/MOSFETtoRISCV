// Check yourself for the Signal processing level: IIR and stability, changing the rate, CORDIC. Two questions an entry, the right option first (the page shuffles), each wrong one saying why. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK11C: Record<string, Quiz[]> = {
  iirfilter: [
    {
      question: 'One mask needs 58 multiplications a sample as a folded FIR filter. Which cost is typical of an elliptic IIR filter for it?',
      options: ['20: four sections, five each', '58: a mask fixes the cost whatever the filter', '115: one for every tap of the FIR filter', '4: one multiplication for each section'],
      answer: 0,
      explain: 'The elliptic design is order 8, which is four second-order sections, and a section has five multiplications: 20, about 2.9 times fewer than the FIR filter.',
      why: ['', 'Families differ greatly: Butterworth needs 93 and Chebyshev I 35 for the same mask.', 'That is the FIR filter\'s length, and folding already halves its multiplications.', 'A section multiplies five times, three in the numerator and two in the feedback.'],
    },
    {
      question: 'y[n] = x[n] + 1.5 y[n − 1] − 0.7 y[n − 2]. Is the filter stable?',
      options: ['Yes: poles of radius √0.7, about 0.84', 'No: a feedback coefficient of 1.5 is above 1', 'No: every filter with feedback diverges in time', 'Only for inputs that are small enough'],
      answer: 0,
      explain: 'The product of a conjugate pair of poles is r², and here it is 0.7, so r is about 0.84, inside the unit circle. The roots are 0.75 ± 0.371j.',
      why: ['', 'A coefficient can exceed 1; the roots are what count.', 'With every pole inside the circle, every bounded input gives a bounded output.', 'Stability is a property of the filter and not of the input: bounded in, bounded out.'],
    },
  ],
  bilinear: [
    {
      question: 'A Butterworth edge is wanted at 0.2 cycles a sample. To what edge is the prototype scaled before the transform?',
      options: ['1.453, which is 2 tan(0.2π)', '1.257, which is 2π × 0.2, the unwarped value', '0.2, the frequency itself, unchanged', '0.628, which is π × 0.2, half of that'],
      answer: 0,
      explain: 'The map sends ω to atan(ω / 2) / π, so only 2 tan(π f) comes back to exactly f. Scaling by 2π f = 1.257 would land the edge at 0.179.',
      why: ['', 'That is the unwarped scaling; the edge lands below where it was asked for.', 'A frequency in cycles is not an analog edge in radians a second.', 'That is half of the unwarped value and is not a conversion that the map uses.'],
    },
    {
      question: 'Why is a stable analog design always a stable digital one after the bilinear transform?',
      options: ['The left half-plane lands inside the circle', 'The transform moves every pole to the origin', 'It rounds each coefficient to a stable value', 'The imaginary axis maps to the real axis'],
      answer: 0,
      explain: 'z = (2 + s) / (2 − s) sends every s with a negative real part, where stable poles are, inside the unit circle, and the imaginary axis onto the circle itself.',
      why: ['', 'Poles move to wherever the map sends them; only s = −2 goes to the origin.', 'The map is exact and rounds nothing; rounding happens later, in the coefficient word.', 'The imaginary axis becomes the unit circle, which is where the frequency response is read.'],
    },
  ],
  biquad: [
    {
      question: 'Why does the chapter\'s biquad have a 35-bit accumulator?',
      options: ['Products are 32 bits; summing five adds 3', 'The data words themselves are 35 bits wide', 'The coefficients themselves are 35 bits wide', 'It holds the rounding bits and nothing else'],
      answer: 0,
      explain: 'Five terms of up to 32 bits need three guard bits by the rule, 35 in all; every bit of every product is kept and the one rounding comes after the sum.',
      why: ['', 'The data are 16 bits, Q1.15.', 'The coefficients are 16 bits, Q2.14.', 'It holds the whole sum of the products; the rounding then drops 14 of its bits.'],
    },
    {
      question: 'A narrow high-order filter is built as sections and not as one polynomial. What does that buy?',
      options: ['Each pair depends on its own two coefficients', 'It needs fewer multiplications in all', 'The coefficients then become exactly representable', 'It removes the filter\'s state'],
      answer: 0,
      explain: 'In a section the sensitivity is 1 / (2 Im p), 6.5 at worst here, against about 3,021 for the polynomial. It costs two multiplications more: 15 against 13.',
      why: ['', 'The sections cost two more multiplications than the polynomial (15 against 13).', 'The coefficients are rounded either way; the sections make the rounding matter less.', 'The state is the delayed inputs and outputs, which sections have as well.'],
    },
  ],
  coefsens: [
    {
      question: 'A pole is asked for at radius 0.97, 0.04 cycles a sample, in 5-bit coefficients (Q2.3). What does the register hold?',
      options: ['A pair on the unit circle, ringing for ever', 'A pair at radius 0.97, slightly off in angle', 'A double pole at z = 1, which grows', 'A pair just outside the unit circle'],
      answer: 0,
      explain: 'a₂ = r² = 0.941 rounds to 1.000 at a step of 1/8, and a pair with a₂ = 1 lies on the circle. At 4 bits a₁ rounds to −2 as well and both roots are at z = 1.',
      why: ['', 'Rounding moves both: a₂ takes the radius to 1.000 and a₁ takes the angle to about 0.057 cycles a sample against the 0.04 asked.', 'That is the 4-bit word, where a₁ also becomes −2.', 'a₂ rounds to 1.000, no further, so the radius is exactly 1.'],
    },
    {
      question: 'The narrow elliptic filter is stable as three sections at 8 bits. Does that make it a good filter at 8 bits?',
      options: ['No: stable only means poles inside the circle', 'Yes: stability is the only thing required of it', 'Yes, because sections cannot round at all', 'No: sections are never stable at 8 bits'],
      answer: 0,
      explain: 'Rounding still moves the poles within the circle and a narrow response depends on exactly where they are. Stability is the floor; the response must still meet the mask.',
      why: ['', 'A stable filter can miss its mask by any amount.', 'Section coefficients round as any others do.', 'They are stable at every width from 8 bits, where the plot starts.'],
    },
  ],
  limitcycle: [
    {
      question: 'After the input stops, a biquad of radius 0.95 repeats 5, 0, −5, 0. What keeps the output alive?',
      options: ['Rounding of the fed-back output inside the loop', 'The pole radius has risen to 1 through rounding of a₂', 'The accumulator is too narrow to hold the sum', 'The input has not really stopped'],
      answer: 0,
      explain: 'a₂ = 14,787 / 2¹⁴ = 0.9025 throughout. 0.9025 × 5 = 4.51 rounds back to 5 with the sign flipped, and every size up to the dead band 5.13 does the same.',
      why: ['', 'The coefficient words do not change while the filter runs.', 'The accumulator keeps every bit of every product; the rounding comes after it.', 'The input was one word and then zeros.'],
    },
    {
      question: 'For a₁ = 0, which change removes a limit cycle with certainty?',
      options: ['Rounding toward zero, shrinking each size', 'Widening the accumulator before the rounding', 'Moving the clamp ahead of the rounding', 'Running the filter at a higher clock'],
      answer: 0,
      explain: 'With a₁ = 0, y[n] depends on y[n − 2] alone, and rounding toward zero makes each size smaller than the one before until zero. For a₁ ≠ 0 it is only the result of a sweep: none up to radius 0.975, a few from 0.98.',
      why: ['', 'The accumulator is already exact; the rounding that sustains the cycle is applied after it.', 'The clamp acts on values that do not fit, and the cycle is a few LSB.', 'The clock rate takes no part in the recurrence.'],
    },
  ],
  decimation: [
    {
      question: 'A tone at 0.3 of the input rate is decimated by 4 with no filter. Where does it land, as a share of the new rate?',
      options: ['0.2, folded', '0.3, unchanged', '1.2, above the new rate', 'Nowhere: it vanishes'],
      answer: 0,
      explain: '0.3 × 4 = 1.2 cycles for each kept sample, and that looks exactly like 0.2. Nothing is removed; it goes somewhere it should not be.',
      why: ['', 'Every frequency is multiplied by 4 as a share of the new rate.', 'No frequency above half the rate can be seen at that rate; it folds.', 'That is what a filter before it would do, and there is none here.'],
    },
    {
      question: 'Why does lowering the rate early make the rest of a chain cheaper?',
      options: ['A filter\'s price is taps × rate', 'Filters are not needed at low rates', 'Multipliers are smaller at low rates', 'It adds bits of precision to the samples'],
      answer: 0,
      explain: 'At a rate R times lower there are R times fewer outputs to compute, and the band that was kept is all they need to carry.',
      why: ['', 'They are needed, but they run less often.', 'A multiplier is the same size; it is used less often and so can be shared.', 'Changing the rate adds no precision.'],
    },
  ],
  interpolation: [
    {
      question: 'A tone at 0.1 of the old rate is taken up by 4 by inserting zeros. Where is it, and where are its images, in the new rate?',
      options: ['0.025, images at 0.225, 0.275, 0.475', '0.1, with images at 0.2, 0.3 and 0.4', '0.4, with no images at all, only a shift', '0.025, with no images because zeros add none'],
      answer: 0,
      explain: 'The spectrum is the same but spread over a rate four times higher, so the tone is at 0.1 / 4 and it repeats at 1/4 ± 0.025 and 1/2 − 0.025. A low-pass filter removes the images.',
      why: ['', 'The tone is at a quarter of its old share of the rate, and the images follow it.', 'The tone cannot move up when the rate rises; it moves down as a share.', 'Zeros make images; only a filter afterwards removes them.'],
    },
    {
      question: 'How many multiplications does an up-by-4 filter of 64 taps need for each output, done by branches?',
      options: ['16: every fourth tap meets a sample', '64: every tap is used for every output', '256: four zero-stuffed samples for each', '4: one multiplication for each branch'],
      answer: 0,
      explain: 'Three of every four inputs to the filter are zeros, so each output needs only the taps that meet the real samples: 64 / 4 = 16.',
      why: ['', 'That multiplies by the zeros as well, which is the waste that branches avoid.', 'That multiplies where it should divide.', 'A branch has 16 taps, and an output sums one branch.'],
    },
  ],
  polyphase: [
    {
      question: 'A decimator by 8 uses a 64-tap filter. How many multiplications does each input sample cost, done by branches?',
      options: ['8', '64', '512', '1'],
      answer: 0,
      explain: 'One output in eight is computed, using 64 products, so 64 / 8 = 8 for each input sample.',
      why: ['', 'That is the direct form, which computes outputs that are then dropped.', 'That multiplies where it should divide.', 'One a sample would be 8 products an output, and this filter has 64 taps.'],
    },
    {
      question: 'What does polyphase change about the filter\'s output?',
      options: ['Nothing: the same products in another order', 'It adds a small error, the price of its speed', 'It lowers the stop band by a few decibels', 'It shifts the pass band down by the factor R'],
      answer: 0,
      explain: 'Only the results that would have been thrown away are skipped. In integers the two forms agree to every bit.',
      why: ['', 'There is no approximation anywhere in it.', 'The taps are the same taps, so the response is the same response.', 'The same taps again; only the order of the sums changes.'],
    },
  ],
  halfband: [
    {
      question: 'Why is a half-band filter so cheap?',
      options: ['About half its taps are exactly zero', 'It has no multiplier at all, only adders', 'It runs at a quarter of the input rate', 'Its taps are all exact powers of two'],
      answer: 0,
      explain: 'sin(2π · ¼ · t) / t is zero at every even t, so about half the taps vanish, and the rest are symmetric: 23 taps need 7 multipliers.',
      why: ['', 'It still multiplies by the taps that remain.', 'It runs at the input rate, or half of it by branches.', 'The taps come from a sinc and a window, so they are not.'],
    },
    {
      question: 'Which job suits a half-band stage best?',
      options: ['An early stage, with plenty of room left', 'A sharp edge on a narrow band of interest', 'A rate change by a factor of 3', 'The last stage, just before a converter'],
      answer: 0,
      explain: 'Its transition is broad and centred on a quarter of the rate, so it suits a stage where the kept band is a small part of what is sampled.',
      why: ['', 'Its edge is broad; a sharp one needs a longer filter of another kind.', 'The zeros fall at a quarter of the rate, which fits ÷ 2 only.', 'There the kept band fills the rate and a broad edge would not fit.'],
    },
  ],
  cic: [
    {
      question: 'A CIC\'s integrators overflow constantly. Why does the output stay right?',
      options: ['Only differences of them reach the output', 'The combs clamp each sum before it does harm', 'The input is too small to overflow them', 'It is right only on average over many outputs'],
      answer: 0,
      explain: 'Two\'s complement differences are right modulo the word, so every wrap on the way cancels as long as the true output fits.',
      why: ['', 'Nothing saturates, and saturating would destroy the arithmetic that makes it work.', 'A running sum of anything but zero overflows sooner or later.', 'It is exact to the bit.'],
    },
    {
      question: 'How many bits must the registers of a CIC of order 3 and ÷ 8 have for 8-bit samples?',
      options: ['17: eight plus 3 × log₂ 8', '11: eight plus log₂ 8', '32: eight plus 3 × 8', '8: the wraps see to the rest'],
      answer: 0,
      explain: 'The DC gain is 8³ = 512, nine more bits, and the worst input fills a 17-bit word.',
      why: ['', 'That covers one moving average, and there are three.', 'Growth goes with the logarithm of R and not with R.', 'The wraps cancel only if the true result fits in the word, and here it would not.'],
    },
  ],
  cordic: [
    {
      question: 'Why does CORDIC use the angles atan 1, atan ½, atan ¼ and so on?',
      options: ['Their tangents are powers of two', 'They add up to exactly 90°', 'Only those angles fit in a small ROM', 'They keep the vector\'s length at 1'],
      answer: 0,
      explain: 'A rotation has a factor tan θ on each cross term; with tan θ = 2^−i that multiplication is a shift, and a shift is wiring.',
      why: ['', 'They add up to about 99.9°, which is why a half-turn handles the rest of the circle.', 'A ROM could hold any angle; what matters is what the angle does to the multiplications.', 'The length grows at every stage; the start value pays for it.'],
    },
    {
      question: 'In vectoring mode, where do arctangent and magnitude come out?',
      options: ['Angle in z, stretched length in x', 'Angle in y, length in z, both stretched', 'Angle in x, length in y, both stretched', 'Both held in z, one after the other'],
      answer: 0,
      explain: 'y is steered to 0, so the whole length ends up in x, still stretched by 1.6468, and z has summed the turns, which is the angle the vector started at.',
      why: ['', 'y is the one driven to 0, so it holds neither.', 'x holds a length, and an angle is only ever in z.', 'z only ever holds an angle.'],
    },
  ],
  cordicgain: [
    {
      question: 'Why can CORDIC\'s gain of 1.6468 be paid in advance by a single start value?',
      options: ['Every stage runs, either way: cos(−θ) = cos θ', 'The gain falls to exactly 1 after about 16 stages', 'The table of angles corrects it as it goes', 'Each stage divides the vector back down'],
      answer: 0,
      explain: 'A stage lengthens the vector by √(1 + 2^−2i) whichever way it turns, so the total depends on the number of stages and not on the angle. The start value is 0.607253.',
      why: ['', 'The product tends to 1.6468 and stays there.', 'The angles only steer; they never touch the length.', 'Nothing divides; each stage lengthens, which is why x and y need headroom.'],
    },
    {
      question: 'A design skips later stages whenever the angle left is already small. What does it lose?',
      options: ['The constant gain', 'Nothing: fewer stages is simply faster', 'The half-turn at the start', 'The table of angles'],
      answer: 0,
      explain: 'The gain is one fixed number only because every stage always runs. Skip some and each angle gets its own gain, so a real multiplication would be needed at the end.',
      why: ['', 'It saves clocks and pays for them with the multiplier that CORDIC exists to avoid.', 'The half-turn is decided before any stage.', 'The table is still needed for the stages that do run.'],
    },
  ],
};
