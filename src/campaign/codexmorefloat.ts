// The fuller codex for the Floating point chapter's later steps (codexfloat.ts holds the summaries; numbers pinned by
// tests/content-codexfloat.test.ts). No DOM.

import type { CodexMore } from './codexmore';

export const MOREFLOAT: Record<string, CodexMore> = {
  fpspecial: {
    idea: `The all-ones exponent field is reserved. With a zero fraction it is ±∞; with any other fraction it is a NaN, so a float32 has 2·(2<sup>23</sup> − 1) = 16 777 214 of them, about 0.4 % of all patterns, spent so that every operation has an answer and no
      program has to trap. <b>Infinity</b> is the limit of the real line and the arithmetic respects it: ∞ + x = ∞, 1 / ∞ = 0, atan(∞) = π/2. It is also the rounded result of an overflow (in round to nearest) and of a finite x / 0. <b>NaN</b> is "not a number": it is returned when
      no real result exists (∞ − ∞, 0 × ∞, 0 / 0, ∞ / ∞, √−1) and it infects what it touches. The top fraction bit is the quiet bit: a quiet NaN (1) flows through arithmetic silently; a signaling NaN (0, some lower bit set) raises NV when used, meant for uninitialised data. IEEE 754 lets a NaN carry a payload; RISC-V does not, and every NaN an operation computes is the canonical 0x7FC00000.
      <b>Signed zero</b> follows from sign-and-magnitude: −0 = 0x80000000. It compares equal to +0, and almost every formula treats them alike, but the sign survives as a direction: 1 / −0 = −∞, √−0 = −0, and the result of x − x is +0 in every mode except round down, where it is −0.
      Comparisons: a NaN is unordered, so ==, &lt; and &gt; against it are all false and x != x is the portable NaN test. In RISC-V feq never raises NV for a quiet NaN while flt and fle raise it for any NaN; fmin and fmax return the other operand when one is a NaN (fmin(NaN, 1) = 1) and the canonical NaN only when both are, and they put −0 below +0.`,
    example: {
      title: 'What a few operations return (float32)',
      body: `<pre>1 / +0        = +∞    (0x7F800000)   DZ
1 / −0        = −∞    (0xFF800000)   DZ
0 / 0         = NaN   (0x7FC00000)   NV
∞ − ∞         = NaN   (0x7FC00000)   NV
0 × ∞         = NaN   (0x7FC00000)   NV
√−1           = NaN                  NV
√−0           = −0
fmin(NaN, 1)  = 1
fmin(sNaN, 1) = 1                    NV
fmin(−0, +0)  = −0     fmax(−0, +0) = +0
1 − 1         = +0     (round down: −0)</pre>`,
    },
    mistakes: [
      'Testing x == NaN. It is always false, even for a NaN against itself; use x != x, an isnan, or fclass.',
      'Treating a NaN as "just another value" in a sort or a max: every comparison is false, so a NaN stops the sort from being a total order and fmax(NaN, x) quietly returns x.',
      'Expecting a NaN to keep its payload or sign on RISC-V. Loads, stores, moves and sign injection copy the bits; every arithmetic result is the canonical NaN.',
      'Comparing floats as integers and trusting −0 = +0: the bit patterns differ, only the float comparison calls them equal.',
    ],
    chapters: [{ chapter: 'float', step: 2, label: 'Unpack' }, { chapter: 'float', step: 6, label: 'Exception flags' }, { chapter: 'float', step: 25, label: 'Rounding surprises' }],
  },
  fpflags: {
    idea: `An IEEE 754 operation can do more than return a number: it can note that something unusual happened. There are five conditions, and in RISC-V each one sets a sticky bit in <b>fflags</b>, the low bits of the fcsr register (NX 1, UF 2, OF 4, DZ 8, NV 16). Nothing traps; the program decides when to look.
      <b>NV</b> (invalid) is set when the result is not defined, with a NaN returned: ∞ − ∞, 0 × ∞, 0 / 0, √ of a negative, a signaling NaN as an operand, an fcvt of a NaN or an out-of-range value (which saturates). <b>DZ</b> is x / 0 with x finite and non-zero, result ±∞. <b>OF</b> is a rounded result beyond the largest finite number: ∞ in round to nearest, the largest finite number in round toward zero; OF always comes with NX.
      <b>UF</b> needs two things at once, a result that is tiny (below the smallest normal, judged <em>after</em> rounding) and inexact: an exact subnormal result is not an underflow. <b>NX</b> is any rounded result that differs from the exact one, which is nearly every division and most additions.
      Flags are decided early where they can be: NV and DZ from the operand classes before the datapath runs, OF, UF and NX from the guard and sticky bits at the rounder. They accumulate by OR, so a single read after a loop shows whether anything went wrong inside it, and a program clears them with <code>csrrw</code> or <code>fsflags</code>.`,
    example: {
      title: 'Which flags (float32)',
      body: `<pre>1 / 3                    NX
2^−126 / 3                UF NX    (tiny and inexact; the result is subnormal)
10^38 × 10                OF NX    (round to nearest: ∞; toward zero: 0x7F7FFFFF)
1 / 0                     DZ
0 / 0                     NV
fcvt.w.s(3 × 10^9)        NV       (saturates to 2^31 − 1)
fmin(sNaN, 1) = 1         NV       fmin(NaN, 1) = 1  no flag</pre>`,
    },
    mistakes: [
      'Expecting an exception to stop the program. RISC-V never traps on a float exception; a program that cares reads fflags.',
      'Reading UF as "the result is subnormal". An exact subnormal result raises nothing, and a tiny result that rounds up to the smallest normal is not tiny after rounding.',
      'Forgetting that flags are sticky: a value read after a loop reports the whole loop, so clear them first.',
      'Treating NX as an error. It is set by almost every real computation; it matters only to code that wants an exact result.',
    ],
    chapters: [{ chapter: 'float', step: 6, label: 'Exception flags' }, { chapter: 'float', step: 18, label: 'fcsr: the mode and the flags' }],
  },
  ulp: {
    idea: `The spacing of floats grows with their size, so an absolute error means little and a relative one means everything. The <b>ulp</b> (unit in the last place) of a float is the gap to the next one: 2<sup>e − 23</sup> in float32's binade e. It is 2<sup>−23</sup> at 1, 1 over 2<sup>23</sup> … 2<sup>24</sup>, and 8 around 10<sup>8</sup>. A correctly rounded result is within half an ulp of the exact one, which as a relative error is between 2<sup>−25</sup> and 2<sup>−24</sup>: the <b>unit roundoff</b> u = 2<sup>−24</sup> is the worst case.
      <b>Machine epsilon</b>, ε = 2<sup>−23</sup>, is the ulp of 1 (the gap above 1; below 1 it is half as big); some libraries mean u by the word, so state which. Results are judged in ulps: a library function "within 1 ulp" is nearly as good as correct rounding.
      The rounding error is tiny, but one operation can make it visible. <b>Subtraction of nearby numbers is exact</b> (Sterbenz: if y/2 ≤ x ≤ 2y then x − y is exactly representable), yet if x and y were already rounded, the exact difference of the rounded values is a wrong answer to the exact difference of the true ones: the leading digits cancel and the earlier errors become the leading digits of the result. That is <b>catastrophic cancellation</b>. The cure is algebra, not precision: rewrite the formula so the subtraction does not appear (1 − cos x = 2 sin²(x/2), the quadratic formula with the larger root first), or compute the difference exactly with an fma.`,
    example: {
      title: 'Cancellation in float32',
      body: `1 + 10<sup>−7</sup> rounds to 1.00000012 (the ulp at 1 is 1.19 × 10<sup>−7</sup>), so (1 + 10<sup>−7</sup>) − 1 = 1.19 × 10<sup>−7</sup>: the subtraction is exact, and the answer is 19 % off, because the error was made in the addition. The ten additions of 0.1 sum to 1.0000001192, one ulp above 1, for the same reason.`,
    },
    mistakes: [
      'Calling the relative error of one operation "1 ulp": it is at most half an ulp, and the relative size of an ulp varies by a factor of two across a binade.',
      'Confusing ε (2<sup>−23</sup>) with u (2<sup>−24</sup>): the bound on the relative error of one rounding is u.',
      'Blaming the subtraction. The subtraction is exact; the damage was done by the roundings before it.',
      'Comparing floats with a fixed absolute tolerance. Near 10<sup>8</sup> an ulp is 8, so a tolerance of 10<sup>−6</sup> is an equality test; near 10<sup>−6</sup> it is far too loose. Compare with a tolerance of a few ulps, or relative.',
    ],
    chapters: [{ chapter: 'float', step: 26, label: 'Measuring error: ulps and relative error' }, { chapter: 'float', step: 25, label: 'Rounding surprises' }],
  },
  kahan: {
    idea: `Adding n numbers into a running total rounds n times, and each rounding drops the low bits of the term added when the total is much bigger. In the worst case the error is n·u times the sum of the magnitudes; random errors grow more slowly (about √n·u). Pairwise summation, adding in a balanced tree, lowers the bound to log n·u. <b>Kahan's compensated summation</b>
      keeps a second variable c, the part of the total that did not fit, and subtracts it from the next term:
      <pre>y = x − c        // the term, corrected by what was lost last time
t = s + y        // the new sum: the low bits of y are rounded away
c = (t − s) − y  // (what was added) − (what we meant to add): the rounding error, as a number
s = t</pre>
      Algebraically c is always 0. Floating-point rounding makes it the exact error of the addition, which is why the order of the brackets is the algorithm. The total error is about 2u plus a term of order n·u², independent of n for any practical n. The price is four floating-point operations per term in a dependent chain, latency rather than throughput, and a loop the compiler must not touch.
      Kahan needs round to nearest and every operation rounded to the stated format; it breaks under reassociation (-ffast-math), where c is simplified to 0, and under extended-precision intermediates. Neumaier's variant also handles a term bigger than the running total; the same idea, Fast2Sum, builds double-double arithmetic.`,
    example: {
      title: '2^24 and thirty-two ones (float32)',
      body: `A plain loop stops at 16 777 216: adding 1 to 2<sup>24</sup> is a tie, rounded to even, back to 2<sup>24</sup>, thirty-two times. Kahan's c walks −1, 0, +1, 0, and the total reaches 16 777 248, exact. The naive sum is 32 short: 16 ulps at the answer.`,
    },
    mistakes: [
      'Simplifying (t − s) − y to 0 "because it is zero". It is not, in floating point; a compiler that does so (-ffast-math) turns Kahan into the plain sum silently.',
      'Reaching for a wider accumulator when only a few terms matter: a float64 total over float32 terms is simpler and faster when it is available.',
      'Assuming Kahan makes the result exact. It makes the error independent of n; it is still a few ulps.',
    ],
    chapters: [{ chapter: 'float', step: 27, label: 'Summing many numbers' }, { chapter: 'float', step: 28, label: 'Kahan on the CPU' }],
  },
  fpformats: {
    idea: `A format is a choice of two numbers, exponent bits E (the range) and fraction bits M (the precision), with the sign. Neural networks tolerate noise but need range, and a multiplier costs about M², so smaller formats are paid for in power and silicon.
      <b>binary16</b> (5 + 10) has 11 significant bits and tops out at 65 504, which a training run overflows. <b>bfloat16</b> (8 + 7) is the top 16 bits of a float32: the same range as float32 (about 3.4 × 10<sup>38</sup>), 8 significant bits, and a conversion that is a truncation or one rounding step.
      <b>FP8</b> has two shapes. <b>E5M2</b> (5 + 2) is an IEEE-style format with infinities and NaNs, largest value 57 344. <b>E4M3</b> (4 + 3) has a smaller range, and there are two of them: the IEEE-style one, whose top binade is ∞ and NaN, tops out at 240; the one machine-learning hardware implements (the OCP specification) <em>reuses</em> that binade for numbers, has no ∞ and one NaN pattern (S.1111.111), and tops out at 448.
      Overflow on that format is a NaN (or saturation to ±448), not an infinity. Narrow products are accumulated in float32, scaled by a per-tensor or per-block power of two so that values sit in the representable range, and rounded back only at the end.
      The cost follows the significand, not the format's width: a bf16 multiplier is about 38 % of float32's NANDs and an FP8 one 14 to 16 %, while a float64 one is 3.2 times float32's.`,
    example: {
      title: 'The same value in each format (0.1)',
      body: `float32 0.100000001, bfloat16 0.100097656, binary16 0.0999756; 70 000 overflows binary16 and both FP8 formats, and is 70 144 in bfloat16 (8 significant bits: the spacing there is 512).`,
    },
    mistakes: [
      'Quoting "FP8 E4M3 max = 448" without saying which E4M3: the IEEE-shaped one tops out at 240 and has infinities, the OCP one at 448 and has none.',
      'Assuming a narrow format needs a narrow accumulator. Training accumulates in float32; the narrow format is for storage and for the multiplier inputs.',
      'Comparing bf16 and binary16 by size alone: the same 16 bits, bf16 trades three bits of precision for the whole float32 range.',
    ],
    chapters: [{ chapter: 'float', step: 13, label: 'Narrower and wider: f16, bf16, FP8, f64' }, { chapter: 'float', step: 14, label: 'What the formats cost' }],
  },
  newtondiv: {
    idea: `Newton's method finds a root of f by x' = x − f(x)/f′(x). Applied to f(x) = 1/x − b it finds 1/b using only multiplication and subtraction. Write e = 1 − b·x, the relative error of the estimate; then x' = x + x·e = x(2 − b·x) has relative error e²: the correct bits double each step. On a machine with a fused multiply-add one step is two fma instructions, and e is computed by one rounding of 1 − b·x (the 48-bit product is not rounded first), so it keeps its own bits.
      The estimate starts from one integer subtraction on the bit pattern: a float's bits are about 2<sup>23</sup>·(log₂ v + 127), so subtracting them from a constant (0x7EF311C7) negates the logarithm and lands within 5.05 % of 1/b, which is 4.3 correct bits. Three steps reach 2<sup>−24</sup>; a table of the top fraction bits would start at 8 bits and save one.
      The quotient is a·x, and it is not always the correctly rounded one: x was rounded, then the product was. <b>Markstein's correction</b> fixes it with two more fma: r = a − b·q (the remainder, exact when q is within an ulp) and q' = q + r·x. The result is the correctly rounded quotient for normal-range cases.
      <b>Goldschmidt's</b> variant scales numerator and denominator by the same factor 2 − D each step; its two products are independent, so a pipelined multiplier overlaps them.
      Division by Newton is not faster in general: each step waits for the last, so a pipelined unit loses to a dedicated divider on one division and wins on many divisions by the same b, or where there is no divider.`,
    example: {
      title: 'Error after each step',
      body: `<pre>seed (one subtract)   5.05 %          4.3 bits
after 1 step           2.6 × 10<sup>−3</sup>      8.6
after 2 steps          6.5 × 10<sup>−6</sup>      17.2
after 3 steps          4.2 × 10<sup>−11</sup>     34.5   (float32 needs 24)</pre>`,
    },
    mistakes: [
      'Computing e as 1 − b·x with a multiply and a subtract: the first rounding loses the residual that the second step needs. Use the fma.',
      'Stopping at q = a·x because x is accurate to 10<sup>−11</sup>. 27 % of quotients are then one ulp off.',
      'Adding a fourth step to repair the quotient: x is already as good as a float can be; the missing step is the remainder, not more reciprocal.',
    ],
    chapters: [{ chapter: 'float', step: 21, label: 'Division without a divider' }, { chapter: 'float', step: 9, label: 'Division, one bit per clock' }],
  },
};
