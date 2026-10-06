import { fpAdd, fpMul, fpUnpack, normRound } from '../lib';
import { cpuState } from '../riscv/cosim';
import { F_PROGRAMS } from '../riscv/fprograms';
import { F32 } from '../sim/fpref';
import { cpuScene } from '../widgets/cpupanel';
import { floatExplorer, floatLine } from '../widgets/float';
import type { Chapter } from './types';

const E4M3 = { E: 4, M: 3 };
const fsrc = (id: string) => F_PROGRAMS.find((p) => p.id === id)!.source;

export const chFloat: Chapter = {
  id: 'float', num: 23, title: 'Floating point', level: 'Arithmetic',
  blurb: 'IEEE 754 from the bits up: unpack, align, add or multiply, normalize, round to nearest even, and an FPU in the CPU.',
  steps: [
    {
      title: 'Scientific notation in binary',
      body: `
        <p>A float is a sign, an exponent and a fraction: (−1)<sup>s</sup> × 1.f × 2<sup>e − bias</sup>. The leading 1 is not stored
        (the <em>hidden bit</em>). The exponent is biased, so that comparing two positive floats as integers orders them correctly.
        Exponent 0 marks zero and the <strong>subnormals</strong> (no hidden bit, gradual underflow). Exponent all ones marks
        <strong>infinity</strong> and <strong>NaN</strong>.</p>
        <p>0.1 has no finite binary expansion, so the float called 0.1 is really 0.100000001490116…: the nearest of the
        2<sup>32</sup> patterns.</p>`,
      widget: floatExplorer,
      challenge: {
        kind: 'quiz', question: 'How many float32 values lie in [1, 2), and how many in [1024, 2048)?',
        options: ['2²³ and 2²³', '2²³ and 2¹³', 'Infinitely many in both', '2³² and 2²²'], answer: 0,
        explain: 'Every binade holds exactly 2²³ values (all fraction patterns with one exponent). The spacing in [1024, 2048) is 1024 times larger: 2⁻¹³ instead of 2⁻²³. Precision is relative.',
      },
    },
    {
      title: 'Where the floats are',
      body: '<p>A 6-bit format shows what float32 hides by sheer size.</p>',
      widget: floatLine,
    },
    {
      title: 'Unpack',
      body: `
        <p>The hardware first takes the encoding apart: sign, exponent, fraction, the hidden bit (1 unless the exponent field is 0), and flags for zero,
        infinity and NaN. Subnormals behave as if their exponent were 1, which makes the rest of the datapath uniform.</p>
        <p>These steps use an 8-bit format (4 exponent bits, 3 fraction bits) so you can see every wire. The same generators build float32,
        and the small versions are tested on <em>every</em> input combination against exact arithmetic.</p>
        <div class="try">0x5A = 0 1011 010 = +1.010₂ × 2^(11 − 7) = 20. Try 0x05 (a subnormal) and 0x78 (infinity).</div>`,
      scene: () => ({ root: fpUnpack(E4M3), inputs: { x: 0x5a } }),
    },
    {
      title: 'Addition: align, add, normalize, round',
      body: `
        <p>To add, the exponents must match. Compare the magnitudes and swap so the bigger operand comes first. Shift the smaller significand right
        by the exponent difference: bits that fall off are not thrown away but ORed into a <strong>sticky bit</strong>. Then add, or subtract if the signs
        differ. Then normalize: a carry shifts the sum right one place; a cancellation leaves leading zeros, which are counted and shifted out.</p>
        <p>Three extra bits below the significand (<strong>guard</strong>, <strong>round</strong>, <strong>sticky</strong>) are provably enough to round the
        result exactly as if it had been computed with infinite precision.</p>
        <div class="try">a = 0x44 (3.0), b = 0x38 (1.0): 4.0 = 0x48. Then b = 0x01 (the smallest subnormal): too small to change a.</div>`,
      scene: () => ({ root: fpAdd(E4M3), inputs: { a: 0x44, b: 0x38, sub: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the result exactly zero by subtracting a number from itself, and check its sign: x − x is +0.',
        check: (st) => st.getInput('sub') === 1 && st.getInput('a') === st.getInput('b') && st.getInput('a') !== 0 && st.value('y') === 0,
        answer: 'Set sub = 1 and b = a (e.g. both 0x44). The significands cancel completely; in round-to-nearest the sign of an exact zero sum is +, so y = 0x00, not 0x80.',
        solve: (st) => st.setInputs({ sub: 1, b: st.getInput('a') || 0x48, a: st.getInput('a') || 0x48 }),
      },
    },
    {
      title: 'Round to nearest, ties to even',
      body: `
        <p>The normalize-and-round unit is shared by every operation. It counts leading zeros and shifts left, but never below the smallest exponent;
        there it shifts right instead, producing a subnormal. Then it rounds: with G the first dropped bit and S the OR of all the others, it rounds up when
        G = 1 and (S = 1 or the last kept bit is 1). A tie (G = 1, S = 0) goes to the even neighbour, so ties do not bias long sums upwards.</p>
        <p>A carry out of the rounding (1.111 + 1 = 10.000) bumps the exponent. An exponent beyond the top becomes infinity.</p>`,
      scene: () => ({ root: normRound(E4M3, 8), inputs: { sign: 0, exp: 3, mant: 0b10011100, stin: 0 } }),
      challenge: {
        kind: 'quiz', question: 'Keeping 3 fraction bits, how does 1.0101₂ round? And 1.0111₂? (Round to nearest, ties to even.)',
        options: ['1.010 and 1.100', '1.011 and 1.011', '1.010 and 1.011', '1.011 and 1.100'], answer: 0,
        explain: 'Both are exact ties (G = 1, S = 0). 1.010|1 keeps 1.010 because its last bit is already even (0); 1.011|1 rounds up to 1.100, the even neighbour.',
      },
    },
    {
      title: 'Multiplication',
      body: `
        <p>Multiplication is simpler than addition: no alignment. The sign is an XOR, the exponents add (minus one bias), and the significands go through
        a tree multiplier from chapter 20. The product of two numbers in [1, 2) lies in [1, 4), so normalization moves it at most one place, unless subnormal
        inputs leave leading zeros, which the shared unit handles anyway. ∞ × 0 is NaN.</p>
        <div class="try">a = b = 0x3A (1.25): 1.5625 = 1.1001₂ needs 4 fraction bits, an exact tie, so it rounds to the even neighbour 1.100₂ = 1.5 (0x3C). Then 0x46 (3.5) × 0x42 (2.5) = 8.75 = 1.00011₂ × 2³: above the tie, it rounds up to 9 (0x51).</div>`,
      scene: () => ({ root: fpMul(E4M3), inputs: { a: 0x3a, b: 0x3a } }),
    },
    {
      title: 'float32: the same circuit, bigger',
      body: `
        <p>Generated from the same code with 8 exponent and 23 fraction bits. The float32 adder costs about <strong>7 600 NANDs</strong> and is
        223 NAND delays deep. The multiplier costs about <strong>14 400</strong> (mostly its 24 × 24 tree) and is 214 deep. Both are checked against the host
        CPU's float32 on random and special operands, including subnormals, infinities, NaNs and cancellation.</p>
        <div class="try">1.5 (0x3FC00000) + 2.25 (0x40100000) = 3.75 (0x40700000). Open the adder and follow the significands.</div>`,
      scene: () => ({ root: fpAdd(F32), inputs: { a: 0x3fc00000, b: 0x40100000, sub: 0 } }),
    },
    {
      title: 'An FPU in the CPU',
      body: `
        <p>The single-cycle CPU gains a second register file (f0–f31, no hard-wired zero) and an FPU implementing a subset of RV32F: flw, fsw, fadd.s,
        fsub.s, fmul.s, sign injection (fmv.s, fneg.s, fabs.s), feq/flt/fle.s, fmv.x.w, fmv.w.x and fcvt.s.w[u]. Rounding is always to nearest even.
        Not implemented: fdiv, fsqrt, fused multiply-add, other rounding modes and the exception flags. flw and fsw reuse the integer load/store path,
        disguised as lw and sw.</p>
        <p>The cost: about 114 000 NANDs (twice the integer CPU), and a clock period of <strong>270</strong> NAND delays instead of 103. A float add in one
        cycle makes every instruction slow. Real cores pipeline the FPU over 3 to 5 cycles.</p>
        <div class="try">Run "0.1 ten times": the sum is 0x3F800001, one ulp above 1.0, and feq.s says 0.</div>`,
      scene: () => cpuScene({ source: fsrc('tenth'), fpu: true, adder: 'ks', timing: true, highlight: ['fpu', 'frf'] }),
      challenge: {
        kind: 'reach', goal: 'Run the program to the end (a1 holds the bits of the sum).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x[11] === 0x3f800001 : false; } catch { return false; } },
        answer: '"Run to halt". Each addition rounds; nine of the ten additions lose a little, and the errors do not cancel: 1.0000001192.',
        solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
      },
    },
    {
      title: 'Rounding surprises',
      body: `
        <p>Load "Rounding surprises" in the program menu: 10⁸ + 1 = 10⁸, 2²⁴ + 1 becomes 2²⁴, +0 equals −0 although their bits differ, ∞ − ∞ is NaN,
        NaN is not equal to itself, and 10⁶⁴ overflows to infinity. Each of these is the specified, correctly rounded answer.</p>`,
      scene: () => cpuScene({ source: fsrc('absorb'), fpu: true, adder: 'ks' }),
      challenge: {
        kind: 'quiz', question: 'Why does x == x fail when x is NaN?',
        options: ['A hardware bug', 'IEEE 754 defines every comparison with NaN as unordered (false), so x != x is the portable NaN test', 'NaN has many encodings', 'Only signaling NaNs do this'],
        answer: 1,
        explain: 'NaN means "no meaningful value"; ordering it would be meaningless too. The comparator checks the NaN flags of both operands and forces eq, lt and le to 0.',
      },
    },
  ],
};

void F32;
