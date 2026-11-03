// Chapter 24, error in practice: measuring error (ulps, relative error, ε against u, cancellation), summing many numbers
// (naive, pairwise, Kahan) and Kahan on the CPU. Every figure in the prose is computed by sim/errorlab.ts / sumerror.ts,
// the same code the widgets run, and pinned by tests/fperror.test.ts.

import { cpuState } from '../../riscv/cosim';
import type { Stage } from '../../view/stage';
import { F_PROGRAMS } from '../../riscv/fprograms';
import { EPSILON, evalText, qOfBits, qText, relErr, UNIT_ROUNDOFF } from '../../sim/errorlab';
import { groupDigits } from '../../sim/numfmt';
import { dataset, exactSum, kahanSum, naiveSum, pairwiseSum, relErrOf } from '../../sim/sumerror';
import { cpuScene } from '../../widgets/cpupanel';
import { errorLab, sumLab } from '../../widgets/fperror';
import type { Step } from '../types';

const fsrc = (id: string) => F_PROGRAMS.find((p) => p.id === id)!.source;

/** "2.63 × 10<sup>−8</sup>" */
function sci(x: number): string {
  if (x === 0) return '0';
  if (x >= 0.01 && x < 1000) return String(+x.toPrecision(3));
  const [m, e] = x.toExponential(2).split('e');
  return `${Number(m)} × 10<sup>${e.replace('-', '−').replace('+', '')}</sup>`;
}
/** Value and relative error of an expression, from the lab's own evaluator. */
function lab(src: string) {
  const r = evalText(src);
  if ('error' in r) throw new Error(`${src}: ${r.error}`);
  const f = qOfBits(r.bits);
  return { v: qText(f, 9), real: qText(r.real, 9), rel: relErr(f, r.real) ?? 0, steps: r.steps };
}
/** Relative errors of the three sums over n terms of a data set. */
function sums(kind: 'uniform' | 'absorb' | 'wide', n: number) {
  const xs = dataset(kind, n), ex = exactSum(xs);
  return { naive: relErrOf(naiveSum(xs), ex), pairwise: relErrOf(pairwiseSum(xs), ex), kahan: relErrOf(kahanSum(xs).sum, ex) };
}
const reachedKahan = (st: Stage): boolean => { try { return st.sim ? cpuState(st.sim).x[11] === 0x4b800010 : false; } catch { return false; } };

const eps = sci(EPSILON), u = sci(UNIT_ROUNDOFF);

export const errorSteps: Step[] = [
  {
    title: 'Measuring error: ulps and relative error',
    body: `
      <p>Three ways to say how wrong a float result is. The <strong>absolute error</strong> |computed − exact| depends on the scale. The <strong>relative error</strong> |computed − exact| / |exact| does not, and is what a
      float is built to bound. The <strong>error in ulps</strong> divides by the spacing of floats at the exact value: 2<sup>⌊log<sub>2</sub>|x|⌋ − 23</sup> in float32, so a correctly rounded result is
      always within ½ ulp, and one ulp is between 2<sup>−24</sup> and 2<sup>−23</sup> of the value (a relative error that wobbles by a factor of 2 across a binade; ulps are the honest unit for "how many last digits are wrong").</p>
      <p>Two constants are both called "the precision". <strong>Machine epsilon</strong> ε = 2<sup>−23</sup> = ${eps} is the gap from 1.0 to the next float. The <strong>unit roundoff</strong>
      u = ε/2 = 2<sup>−24</sup> = ${u} is the largest relative error one operation can make under round to nearest: the <em>standard model</em> says fl(a ∘ b) = (a ∘ b)(1 + δ) with |δ| ≤ u, for + − × ÷ and √.
      The directed modes (RTZ, RDN, RUP) can lose a whole ε. The widget's last column, "this step", is each operation's own δ in units of u, measured: never above 1.</p>
      <p><strong>Cancellation</strong> is where bounds on single operations stop being the story. Subtracting nearly equal numbers is <em>exact</em> when y/2 ≤ x ≤ 2y (Sterbenz's lemma: the difference needs no more bits than x and y have), so the
      subtraction never loses anything. But it promotes the error already in x and y: each carries up to u relative to itself, and when 14 of their leading bits cancel (1.0001 − 1.00005), that same absolute
      error is ${sci(lab('1.0001 - 1.00005').rel)} of the result. <em>Benign</em> cancellation subtracts exact quantities (inputs, or products that did not round). <em>Catastrophic</em> cancellation subtracts quantities that
      carry rounding error, and the cure is algebra, not precision: rewrite so that the subtraction happens on exact values, or does not happen.</p>
      <p>The quadratic x² − 10 000 x + 0.1 = 0 has a root near 10<sup>−5</sup>. The textbook formula subtracts √(b² − 4ac) ≈ 10 000 from b = 10 000: in float32 b² − 4ac rounds to b² (the 0.4 is far below half an ulp of 10<sup>8</sup>), the
      square root is exactly 10 000 and the root comes out as ${lab('(10000 - sqrt(10000*10000 - 4*1*0.1)) / (2*1)').v}: relative error ${sci(lab('(10000 - sqrt(10000*10000 - 4*1*0.1)) / (2*1)').rel)}, nothing left. The product of the roots is c/a, so the small root is
      2c / (−b + √(b² − 4ac)), an addition of two positive numbers: ${lab('(2*0.1) / (10000 + sqrt(10000*10000 - 4*1*0.1))').v}, relative error ${sci(lab('(2*0.1) / (10000 + sqrt(10000*10000 - 4*1*0.1))').rel)}, under u. Same inputs, same format,
      six orders of magnitude apart. And (x − y)(x + y) beats x² − y² for the same reason: the subtraction is on the exact inputs, not on two rounded squares.</p>
      <div class="try">Pick "quadratic root": A loses everything, B keeps about seven digits. Pick "Sterbenz": the subtraction's row says "exact", and the error is all inherited. Then type your own expression.</div>`,
    widget: errorLab,
    more: {
      derive: `<p>Why ½ ulp and u are different bounds. Within the binade [2<sup>k</sup>, 2<sup>k+1</sup>) the spacing is 2<sup>k−23</sup>, so the rounding error of a result x there is at most 2<sup>k−24</sup>. Relative to x that is between
        2<sup>−25</sup> (x near 2<sup>k+1</sup>) and 2<sup>−24</sup> (x = 2<sup>k</sup>): u = 2<sup>−24</sup> is the worst case, at the bottom of the binade. Error bounds in terms of u are therefore pessimistic by up to 2 for most values.</p>
        <p>Sterbenz: let y/2 ≤ x ≤ 2y, both floats with the same exponent range. Then x − y has magnitude at most min(x, y), so its exponent is no larger than the smaller operand's, and it is a multiple of the smaller operand's last place:
        it fits in 24 bits and is exact. The tests run it on 400 random pairs against double arithmetic.</p>`,
      pitfall: `<p>Quoting "float32 has 7 digits" as an error bound for a computation. One operation is good to u = ${u}; a chain of n of them to about n·u in the worst case, and an ill-conditioned step (a cancellation) multiplies the error already there by the ratio
        of the operands to the result. The figure in the table's "inherited error" note is that ratio, measured.</p>`,
      real: `<p>Numerical libraries state accuracy in ulps (a math library's sinf is typically within 1 ulp, a correctly rounded one within ½ ulp), and tests compare with a bound in ulps rather than a tolerance. Compilers' <code>-ffast-math</code> trades the
        exact IEEE semantics these bounds rely on for speed. Hardware helps where it can: the fused multiply-add rounds a·b + c once, which is why the Horner step and the dot product earlier in this chapter lose less.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'In float32, (1 + 10⁻⁸) − 1 evaluates to 0, yet the subtraction is exact. Where was the information lost?',
      options: [
        'In 1 + 10⁻⁸: the sum is rounded to a multiple of 2⁻²³ (nearest is 1.0), which discards the 10⁻⁸',
        'In the subtraction: two nearly equal numbers cannot be subtracted exactly',
        'In the literal 10⁻⁸, which float32 cannot represent',
        'In the final comparison with zero',
      ],
      answer: 0,
      why: [
        '',
        'Sterbenz: with y/2 ≤ x ≤ 2y the difference is exact. The widget\'s subtraction row says so.',
        'float32 holds 10⁻⁸ to a relative error of at most u (the first row shows 0.1 u): the literal is fine.',
        'There is no comparison in the expression; the result is simply the encoding 0x00000000.',
      ],
      explain: 'The addition 1 + 10⁻⁸ rounds to 1.0 because 10⁻⁸ is below half the spacing (2⁻²⁴) of floats near 1. Everything after that is exact arithmetic on the wrong number: cancellation exposes an earlier rounding, it does not cause one.',
    },
  },
  {
    title: 'Summing many numbers',
    body: `
      <p>A sum of n terms is n − 1 roundings. <strong>Naive</strong> summation, s ← s + x<sub>i</sub>, rounds the running total each time, so as the total grows each addition may lose up to u·|s|: the worst-case relative error
      is (n − 1)u. The bound is attained on data built for it ("1.0, then n − 1 × 2<sup>−24</sup>": every tiny term falls below half an ulp of the total and vanishes; at n = 4096 the naive sum is off by
      ${sci(sums('absorb', 4096).naive)}), and on more ordinary data it grows roughly like √n or n (uniform values in [0, 1), n = 4096: ${sci(sums('uniform', 4096).naive)}, against ${sci(sums('uniform', 4096).kahan)} for Kahan).</p>
      <p><strong>Pairwise</strong> summation adds halves recursively: a term takes part in ⌈log<sub>2</sub> n⌉ additions instead of up to n, so the bound is ⌈log<sub>2</sub> n⌉u, and the same absorption data gives ${sci(sums('absorb', 4096).pairwise)}. It costs the
      same n − 1 additions and needs no extra registers beyond a stack, and it is how vectorized and GPU reductions add: lanes sum independently, then a tree combines them. <strong>Kahan</strong> (compensated)
      summation keeps the rounding error of every addition in a second variable c and feeds it into the next: y = x − c; t = s + y; c = (t − s) − y; s = t. For |s| ≥ |y| the expression (t − s) − y is the <em>exact</em> rounding
      error of s + y (Dekker's fast two-sum), so nothing is lost for good, only deferred: the bound is 2u + O(n·u²), <em>independent of n</em>. The same data: ${sci(sums('absorb', 4096).kahan)}, which is the final rounding of the result and nothing else.</p>
      <p>The price is four floating-point operations per term instead of one, with a loop-carried dependency through both s and c (so no free overlap on a pipelined FPU, the previous chapter's point); pairwise is the cheaper choice
      when u·log n is good enough, Kahan when the sum must be as good as one rounding. A compiler that may reassociate (<code>-ffast-math</code>, <code>-fassociative-math</code>) sees (t − s) − y as algebraically zero and deletes it:
      the loop silently becomes naive summation. Numerical code that depends on the correction is built without those flags, or marks it.</p>
      <div class="try">Pick "1.0, then n − 1 × 2⁻²⁴" and slide n up: naive reaches its worst-case line, Kahan stays flat at the last rounding. On "uniform", naive is far below its bound until n gets large, but still grows.</div>`,
    widget: sumLab,
    more: {
      derive: `<p>Why naive is (n − 1)u: s<sub>k</sub> = fl(s<sub>k−1</sub> + x<sub>k</sub>) = (s<sub>k−1</sub> + x<sub>k</sub>)(1 + δ<sub>k</sub>), so x<sub>i</sub> is multiplied by ∏<sub>k ≥ i</sub>(1 + δ<sub>k</sub>), up to n − i + 1 factors, and for positive terms the total error is at most
        (n − 1)u·Σ|x<sub>i</sub>| (to first order). In a balanced tree no term is behind more than ⌈log<sub>2</sub> n⌉ additions, which is the whole pairwise bound. Kahan works because each δ-error is captured exactly in c (a float, since the error of an
        add is representable) and re-added one step later; what remains are products δ·c of two tiny numbers, the O(nu²) term.</p>
        <p>The 2u is Higham's bound (Accuracy and Stability of Numerical Algorithms, ch. 4). The measured curves are held under their bounds for every n up to 2<sup>14</sup> on all three data sets by tests/fperror.test.ts.</p>`,
      pitfall: `<p>Summing in a different order and expecting the same bits. Floating-point addition is not associative: the naive, pairwise and Kahan results above are three different numbers for the same data, and so is any parallel reduction, whose order depends on the machine. For
        reproducibility, fix the order (a fixed tree, as here), or use an exact accumulator (a "superaccumulator", Python's <code>math.fsum</code>).</p>`,
      real: `<p>BLAS and NumPy use blocked or pairwise sums for exactly this reason (<code>numpy.sum</code> adds pairwise). GPU libraries reduce in trees; deep-learning frameworks accumulate float16 products in float32 for the same
        reason the naive sum above fails. Kahan appears where sums are long and one rounding is the budget: accumulating a time, a simulation's conserved quantity or a financial total.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'Kahan summation\'s error bound does not grow with n. What does that cost per term?',
      options: [
        'Four floating-point operations instead of one, and a dependency through both s and c',
        'A wider accumulator, such as float64',
        'Sorting the terms by magnitude first',
        'A fused multiply-add, which only some CPUs have',
      ],
      answer: 0,
      why: [
        '',
        'Nothing is widened: s, c and t are all float32. The extra precision is carried in c, the part of the sum that no longer fits in s.',
        'Order helps a naive sum (small terms first) but Kahan needs no sorting: its bound holds in any order.',
        'The loop uses plain fadd.s / fsub.s, as the next step shows. An fma would not help: no operation here is a multiply.',
      ],
      explain: 'y = x − c, t = s + y, t − s, (t − s) − y: four additions or subtractions in a chain, against one for the naive sum. The compensation is paid for in latency and in the instructions a compiler is forbidden to remove.',
    },
  },
  {
    title: 'Kahan on the CPU',
    body: `
      <p>The program adds 2<sup>24</sup> and thirty-two 1.0s twice: <span data-show="frf">in the f registers</span> ft1 is the naive sum, and ft2 / ft3 are Kahan's sum and compensation c. At 2<sup>24</sup> the spacing of floats is 2, so 2<sup>24</sup> + 1 is
      a tie that rounds to even, back to 2<sup>24</sup>: the naive loop never moves, and ends at <strong>0x4B800000</strong> = ${groupDigits(16777216)}, short by 32 (16 ulps, ${sci(32 / 16777248)} relative). The Kahan loop is
      six instructions on <span data-show="fpu">the FPU</span> per term: <code>fsub.s</code> y = x − c, <code>fadd.s</code> t = s + y, <code>fsub.s</code> t − s, <code>fsub.s</code> c = (t − s) − y, <code>fmv.s</code> s = t.</p>
      <p>Watch ft3. After the first term t is still 2<sup>24</sup>, so (t − s) − y = 0 − 1 = <strong>c = −1</strong>: the 1 that was lost, with its sign. Next, y = 1 − (−1) = 2 is exactly one ulp, t = 2<sup>24</sup> + 2, and c returns to 0. The third 1 is
      a tie again (2<sup>24</sup> + 3 sits between + 2 and + 4; even is + 4), which makes c = +1, the extra the sum was given. c walks −1, 0, +1, 0: after thirty-two terms ft2 holds <strong>0x4B800010</strong> = ${groupDigits(16777248)}, the exact answer, and a2 = fsub(ft2, ft1) = 32.0 is what the naive loop lost.</p>
      <p>This is also the loop <code>-ffast-math</code> would break: with reassociation allowed, (t − s) − y is simplified to 0, c is constant 0, y = x, and ft2 follows ft1 into the same wrong answer. The hardware does what it is told; the compiler's licence to
      rewrite is what changes the result.</p>
      <div class="try">Run to halt: a0 = 0x4B800000 (naive), a1 = 0x4B800010 (Kahan), a2 = 0x42000000 (32.0). Use Step and watch ft3 go −1, 0, +1, 0.</div>`,
    scene: () => cpuScene({ source: fsrc('kahan'), fpu: true, adder: 'ks', highlight: ['fpu', 'frf'] }),
    more: {
      derive: `<p>The exact sum is ${groupDigits(16777248)} = 2<sup>24</sup> + 32, representable (spacing 2). The naive loop's error is ${sci(32 / 16777248)} = 32 / 16 777 248, which is 16 ulps at the answer and ${sci(32 / 16777248 / UNIT_ROUNDOFF)} u:
        a worst-case-style failure from only 32 additions, because the whole total sits above 2<sup>24</sup>, where float32 stops counting by 1. The Kahan loop is the six-operation recurrence of the previous step, checked in tests/fperror.test.ts against the
        TypeScript float32 loop and the exact sum, and at gate level, on both the single-cycle and the pipelined FPU CPU, by the F-program co-simulation.</p>`,
      pitfall: `<p>Assuming the compensation is harmless to keep and costless to drop. With <code>-ffast-math</code> the program above is as inaccurate as its naive half, silently. If an accurate sum matters, test it (compare against an exact reference like this chapter's), and keep the
        flags that reorder arithmetic off the file that contains it.</p>`,
      real: `<p>Compilers expose the choice at fine grain: GCC's <code>-fno-associative-math</code>, per-function <code>__attribute__((optimize("no-fast-math")))</code>, or Clang's <code>#pragma clang fp reassociate(off)</code>. Kahan's recurrence is also the basis of double-double arithmetic,
        where the pair (s, c) is kept as one number of about twice the precision.</p>`,
    },
    challenge: {
      kind: 'reach', goal: 'Run the program to the end: a1 holds the bits of the Kahan sum, 0x4B800010.',
      check: (st) => reachedKahan(st),
      hints: [
        'The CPU panel can clock the program until it halts.',
        'The program ends by moving the naive sum into a0, the Kahan sum into a1 and their difference into a2.',
      ],
      answer: '"Run to halt". The naive sum stays at 0x4B800000 (2^24: every 1 is absorbed); the Kahan sum is 0x4B800010 = 16 777 248, exact, and a2 = 32.0.',
      solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
    },
    tries: [(st) => reachedKahan(st)],
  },
];
