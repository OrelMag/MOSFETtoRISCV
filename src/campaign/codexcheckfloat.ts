// Check yourself for the Floating point chapter's later codex entries: two questions an entry, the right option first (the page shuffles),
// each wrong one saying why. Numbers pinned by tests/content-codexfloat.test.ts.

import type { Quiz } from '../chapters/types';

export const CHECKFLOAT: Record<string, Quiz[]> = {
  fpspecial: [
    {
      question: 'On RISC-V, what does <code>fmin.s</code> return for fmin(NaN, 1.0), with the NaN quiet?',
      options: ['1.0, and no flag', 'NaN', '1.0, with NV set', '0'],
      answer: 0,
      explain: 'fmin and fmax return the non-NaN operand; they return the canonical NaN only when both are NaN. NV is raised only for a signaling NaN.',
      why: ['', 'Comparisons with a NaN are unordered, but fmin is defined to skip it: the NaN does not propagate.', 'A quiet NaN raises nothing; only a signaling NaN sets NV here.', 'There is no reason to return zero: the result is one of the operands.'],
    },
    {
      question: 'x = −0.0 in float32. What is 1 / x, and what is x == 0.0?',
      options: ['−∞, and true', '+∞, and true', '−∞, and false', 'NaN, and false'],
      answer: 0,
      explain: 'The sign of a zero survives as a direction: 1 / −0 = −∞ (flag DZ). A float comparison calls +0 and −0 equal; only the bit patterns (0x80000000 and 0) differ.',
      why: ['', 'The sign of the zero decides the sign of the infinity.', 'The comparison treats +0 and −0 as equal even though the bits differ.', 'x / 0 with a finite non-zero x is ∞ with DZ; the NaN comes from 0 / 0.'],
    },
  ],
  fpflags: [
    {
      question: 'Which flags does 2<sup>−126</sup> / 3 (float32) raise?',
      options: ['UF and NX', 'NX only', 'OF and NX', 'NV'],
      answer: 0,
      explain: 'The exact quotient is below the smallest normal number (tiny) and the rounded subnormal differs from it (inexact), so UF and NX are both set.',
      why: ['', 'NX is set, but the result is also tiny, which with inexactness is underflow.', 'Overflow is a result beyond the largest finite number; this is the other end of the range.', 'The operands are ordinary and the result is defined, so nothing is invalid.'],
    },
    {
      question: 'A loop of float operations ends. fflags reads 0b00001. What happened?',
      options: ['Some result was rounded, and nothing worse', 'A result overflowed', 'The program trapped', 'A division by zero'],
      answer: 0,
      explain: 'Bit 0 is NX: inexact. It is sticky, so one rounded result anywhere in the loop sets it. OF would be bit 2, DZ bit 3, and RISC-V never traps on a float exception.',
      why: ['', 'Overflow is bit 2 (and comes with NX).', 'RISC-V does not trap on float exceptions; it accumulates flags.', 'Divide by zero is bit 3.'],
    },
  ],
  ulp: [
    {
      question: 'What is the ulp of a float32 around 10<sup>8</sup> (between 2<sup>26</sup> and 2<sup>27</sup>)?',
      options: ['8', '1', '2<sup>−23</sup>', '10<sup>−8</sup>'],
      answer: 0,
      explain: 'In the binade [2<sup>e</sup>, 2<sup>e+1</sup>) the gap is 2<sup>e−23</sup>; for e = 26 that is 2<sup>3</sup> = 8. So 10<sup>8</sup> + 1 is rounded back to 10<sup>8</sup>.',
      why: ['', 'The ulp is 1 only from 2<sup>23</sup> to 2<sup>24</sup>; it doubles with every binade.', '2<sup>−23</sup> is machine epsilon, the ulp of 1.', 'The gap grows with the magnitude; it is not relative to 1 over the value.'],
    },
    {
      question: 'Why is a − b exact when a and b are within a factor of two (Sterbenz), yet the result can be badly wrong?',
      options: ['The subtraction adds no error; a and b already carried their rounding errors, which are now the leading digits', 'The subtraction rounds but gets lucky', 'Floats cannot hold a small difference', 'The result is always subnormal'],
      answer: 0,
      explain: 'The difference of two nearby floats fits in the format, so no rounding happens. But a and b were results of earlier roundings, and cancelling their equal leading digits leaves the old errors as the result: catastrophic cancellation.',
      why: ['', 'It does not round at all: that is what Sterbenz\'s lemma says.', 'It can: any difference of two floats with nearby exponents is representable.', 'The result is only small, not necessarily subnormal.'],
    },
  ],
  kahan: [
    {
      question: 'Why is <code>c = (t − s) − y</code> in Kahan summation not simply 0?',
      options: ['t − s is what was really added after rounding, and subtracting y leaves the rounding error', 'Because c is initialised to a random value', 'Because s and t differ by one ulp', 'It is 0; the loop only changes s'],
      answer: 0,
      explain: 'Algebraically it is zero, but t = s + y was rounded. t − s is exact (the sum is close to s), so (t − s) − y is exactly the error of that addition, which the next term gets back.',
      why: ['', 'c starts at 0; the compensation is computed from the data.', 'The gap between s and t is whatever y rounds to, not always one ulp.', 'It is zero only in exact arithmetic, which is why a compiler that assumes exact arithmetic breaks the algorithm.'],
    },
    {
      question: 'Which compiler option can turn a Kahan loop into a plain sum?',
      options: ['-ffast-math, which allows reassociation', '-O0', '-march=rv32imf', '-Wall'],
      answer: 0,
      explain: 'With reassociation allowed, (t − s) − y is simplified to 0, c is constant, and the loop is the naive sum with extra instructions.',
      why: ['', 'Without optimisation nothing is rewritten, so the loop runs as written.', 'The architecture flag only selects instructions.', 'Warnings do not change the generated code.'],
    },
  ],
  fpformats: [
    {
      question: 'What distinguishes the ML E4M3 FP8 format (OCP) from an IEEE-style 4-exponent-bit format?',
      options: ['No infinities and one NaN pattern, so its largest value is 448 rather than 240', 'It has more fraction bits', 'It uses a different sign bit', 'It has no subnormals'],
      answer: 0,
      explain: 'It reuses the all-ones exponent for ordinary numbers, keeping only S.1111.111 as NaN; the largest finite value is 1.75 × 2<sup>8</sup> = 448. An IEEE-style one gives that binade to ∞ and NaN and stops at 240.',
      why: ['', 'Both have 3 fraction bits.', 'The sign is one bit in both.', 'It keeps subnormals; the difference is in the top binade.'],
    },
    {
      question: 'Why is converting float32 to bfloat16 cheap?',
      options: ['bfloat16 is float32\'s top 16 bits: same sign, exponent and bias', 'It has the same fraction as float32', 'It uses an integer encoding', 'Both formats are 16 bits'],
      answer: 0,
      explain: 'Same 8-bit exponent and bias, 7 of float32\'s 23 fraction bits: narrowing drops 16 bits (with one rounding step if rounded), widening appends zeros and is exact.',
      why: ['', 'It has 7 fraction bits, not 23; the exponent is what they share.', 'It is a floating-point format with the same layout as float32.', 'float32 has 32 bits.'],
    },
  ],
  newtondiv: [
    {
      question: 'After a Newton–Raphson step for 1/b the relative error was 10<sup>−3</sup>. About how large is it after the next step?',
      options: ['10<sup>−6</sup>', '5 × 10<sup>−4</sup>', '10<sup>−3</sup> still', '10<sup>−9</sup>'],
      answer: 0,
      explain: 'The error is squared each step: e → e². The number of correct bits doubles.',
      why: ['', 'That would be linear convergence (the error halves); Newton\'s is quadratic.', 'Each step improves the estimate while it is above the format\'s own precision.', 'That is a cube: the step squares the error, it does not cube it.'],
    },
    {
      question: 'Why does q = a · x need Markstein\'s correction, even when x is accurate to 10<sup>−11</sup>?',
      options: ['x and the product are both rounded to float32, so q can be one ulp from the correctly rounded quotient', 'x is not accurate enough', 'The product overflows', 'a is not exact'],
      answer: 0,
      explain: 'x is within half an ulp of 1/b, and q = a·x rounds again; a/b can lie near a rounding boundary. The remainder r = a − b·q, exact with an fma, shows which side it is on.',
      why: ['', 'Another reciprocal step cannot improve x past the float\'s spacing.', 'Overflow is not what goes wrong; the quotient is merely 1 ulp off.', 'a is a float; the error is in the two roundings.'],
    },
  ],
};
