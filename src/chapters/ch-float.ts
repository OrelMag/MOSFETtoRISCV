import { fpAdd, fpMul, fpToInt, fpUnpack, normRound, ROUND_DECIDE } from '../lib';
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
  blurb: 'IEEE 754 from the bits up: unpack, align, add or multiply, normalize, round in five modes with exception flags, and an FPU in the CPU.',
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
      scene: () => ({ root: normRound(E4M3, 8), inputs: { sign: 0, exp: 3, mant: 0b10011100, stin: 0, rm: 0 } }),
      challenge: {
        kind: 'quiz', question: 'Keeping 3 fraction bits, how does 1.0101₂ round? And 1.0111₂? (Round to nearest, ties to even.)',
        options: ['1.010 and 1.100', '1.011 and 1.011', '1.010 and 1.011', '1.011 and 1.100'], answer: 0,
        explain: 'Both are exact ties (G = 1, S = 0). 1.010|1 keeps 1.010 because its last bit is already even (0); 1.011|1 rounds up to 1.100, the even neighbour.',
      },
    },
    {
      title: 'Five rounding modes',
      body: `
        <p>RISC-V has five: <strong>RNE</strong> (nearest, ties to even, the default), <strong>RTZ</strong> (towards zero: truncate),
        <strong>RDN</strong> (towards −∞), <strong>RUP</strong> (towards +∞) and <strong>RMM</strong> (nearest, ties away from zero).
        Every arithmetic instruction carries a 3-bit rm field; rm = 7 (<em>dyn</em>) means "use frm", the mode held in the fcsr register.
        RDN and RUP give interval arithmetic: computing a bound twice, once in each mode, brackets the exact result.</p>
        <p>The modes only change one decision: whether to add one unit in the last place to the truncated magnitude, from the sign, the
        last kept bit, G and S. That is this block: 62 NANDs, 13 deep, sitting beside the incrementer of normalize &amp; round. It also says where
        an overflow goes: to ∞ in RNE and RMM and in the direction being rounded towards, otherwise to the largest finite number (RTZ never
        produces ∞ from finite operands). The reserved encodings 5 and 6 are illegal instructions in RISC-V; this CPU has no traps, so here they
        (and frm values above 4) behave as RTZ, in the hardware and in the golden model alike.</p>
        <div class="try">G = 1, S = 0 (a tie), lsb = 1: RNE and RMM round up, RTZ does not. Set sign = 1 and try RDN (rm = 2) and RUP (rm = 3).</div>`,
      scene: () => ({ root: ROUND_DECIDE, inputs: { rm: 0, sign: 0, lsb: 1, g: 1, s: 0 } }),
      challenge: {
        kind: 'quiz', question: 'fcvt.w.s of −2.5 in RNE, RTZ, RDN, RUP and RMM gives…',
        options: ['−2, −2, −3, −2, −3', '−3, −2, −3, −2, −3', '−2, −2, −2, −3, −3', '−2, −3, −3, −2, −2'], answer: 0,
        explain: 'A tie: RNE picks the even neighbour (−2); RTZ truncates (−2); RDN goes towards −∞ (−3); RUP towards +∞ (−2); RMM away from zero (−3). The "Rounding modes" program on the CPU below computes exactly this.',
      },
    },
    {
      title: 'Exception flags',
      body: `
        <p>IEEE 754 defines five exceptions; RISC-V does not trap on them but ORs them into <strong>fflags</strong>, where they stay until software
        clears them, so one check after a long loop finds any exception inside it. <strong>NV</strong> invalid (∞ − ∞, 0 × ∞, a signaling NaN
        operand, an out-of-range float → int), <strong>DZ</strong> divide by zero, <strong>OF</strong> overflow, <strong>UF</strong> underflow,
        <strong>NX</strong> inexact (G or S was 1, or overflow).</p>
        <p>Underflow is subtle. A result is <em>tiny</em> if it lies below 2<sup>emin</sup>; RISC-V checks tininess <em>after rounding</em>,
        as if the exponent were unbounded. And UF is raised only if the tiny result is also inexact: a subnormal computed exactly raises nothing. Detecting
        "after rounding" costs a second rounding decision: with G as the last bit and the bit below it (R) as the new guard, would the M + 1 kept
        bits carry into 2<sup>emin</sup>? Modes and flags add 254 NANDs (4.5 %) and 2 levels to the float32 normalize &amp; round unit: 5 916 NANDs, 142 deep.</p>
        <div class="try">exp = 0, mant = 1111 0000: 1.111 × 2<sup>−7</sup>. It rounds to 0x08 = 2<sup>−6</sup>, the smallest normal, yet flags = UF NX (0x03): with an unbounded exponent it is exact at 1.111 × 2<sup>−7</sup>, below 2<sup>−6</sup>. Now mant = 1111 1100: the same result, but only NX. In RTZ (rm = 1) the first stays subnormal, 0x07.</div>`,
      scene: () => ({ root: normRound(E4M3, 8), inputs: { sign: 0, exp: 0, mant: 0b11110000, stin: 0, rm: 0 } }),
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
      title: 'Float to integer',
      body: `
        <p>fcvt.w.s and fcvt.wu.s reuse the same ideas backwards. Put the significand at the top of a (w + 1)-bit word, its hidden bit at weight
        2<sup>w−1</sup>, and shift right by (w − 1 + bias) − exponent with a sticky shifter: the bottom bit is G, the shifted-out bits are S. Round in mode rm
        (an incrementer), then check the range: −2<sup>31</sup> … 2<sup>31</sup> − 1 signed, 0 … 2<sup>32</sup> − 1 unsigned. NaN, ±∞ and anything out
        of range after rounding saturate to the largest integer of that sign (NaN counts as positive) and raise NV; otherwise NX if G or S. −0.3 → unsigned
        is 0 (just NX), but −0.7 rounds (in RNE) to −1: invalid.</p>
        <p>The float32 → int32 converter costs 3 223 NANDs and is 142 deep (a 33-bit sticky shifter, an incrementer, a negator).</p>
        <div class="try">a = 0x42 is 2.5 (0 1000 010), into an 8-bit integer: y = 2 in RNE. Try rm = 3 (RUP) and rm = 4 (RMM). Then 0x7F (NaN): 127 and NV.</div>`,
      scene: () => ({ root: fpToInt(E4M3, 8), inputs: { a: 0x42, signed: 1, rm: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the converter saturate: find a finite input whose signed 8-bit result is −128 and which raises NV (flags = 0x10).',
        check: (st) => st.getInput('signed') === 1 && st.value('y') === 0x80 && st.value('flags') === 0x10 && (st.getInput('a') & 0x78) !== 0x78,
        answer: '−240 (0xF7 = 1 1110 111) is far below −128: any negative value of magnitude ≥ 129 (after rounding) saturates to −128 = 0x80 with NV. −128 itself (0xF0 = 1 1110 000) converts exactly, without NV.',
        solve: (st) => st.setInputs({ a: 0xf7, signed: 1 }),
      },
    },
    {
      title: 'float32: the same circuit, bigger',
      body: `
        <p>Generated from the same code with 8 exponent and 23 fraction bits. The float32 adder costs about <strong>7 900 NANDs</strong> and is
        225 NAND delays deep. The multiplier costs about <strong>14 700</strong> (mostly its 24 × 24 tree) and is 216 deep. The small formats are tested on
        every operand pair in every rounding mode, flags included, against exact rational arithmetic (a few million cases, simulated 32 at a time);
        float32 on random and special operands (subnormals, infinities, NaNs, cancellation), and against the host CPU in round to nearest even.</p>
        <div class="try">1.5 (0x3FC00000) + 2.25 (0x40100000) = 3.75 (0x40700000). Open the adder and follow the significands.</div>`,
      scene: () => ({ root: fpAdd(F32), inputs: { a: 0x3fc00000, b: 0x40100000, sub: 0 } }),
    },
    {
      title: 'An FPU in the CPU',
      body: `
        <p>The single-cycle CPU gains a second register file (f0–f31, no hard-wired zero) and an FPU implementing RV32F except division, square root
        and fused multiply-add: flw, fsw, fadd.s, fsub.s, fmul.s, sign injection (fmv.s, fneg.s, fabs.s), fmin/fmax.s, feq/flt/fle.s, fcvt.w[u].s,
        fcvt.s.w[u], fmv.x.w, fmv.w.x and fclass.s, in all five rounding modes, with the exception flags. flw and fsw reuse the integer load/store path,
        disguised as lw and sw. funct7 selects one of the units' results; the FPU is 38 100 NANDs.</p>
        <p>The cost: about 121 000 NANDs (twice the integer CPU), and a clock period of <strong>274</strong> NAND delays instead of 103. A float add in one
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
      title: 'fcsr: the mode and the flags',
      body: `
        <p>This CPU has no machine-mode CSRs, so the floating-point control and status register lives in the FPU path: two registers, frm (3 bits)
        and fflags (5 bits), 541 NANDs with their read and write logic. csrrw / csrrs / csrrc and the immediate forms reach them at 0x001 (fflags),
        0x002 (frm) and 0x003 (both); the assembler's frflags, fsflags, frrm, fsrm(i), frcsr and fscsr are those instructions. Every OP-FP instruction
        ORs its flags into fflags on the clock edge; a CSR read returns the old value, so <code>fsflags a0, zero</code> reads and clears in one go.</p>
        <p>fmin.s / fmax.s follow IEEE 754-2019 (minimumNumber): a NaN operand is ignored, −0 &lt; +0, NV only for a signaling NaN (1 994 NANDs,
        comparator included). fclass.s returns one of ten bits (147 NANDs). feq.s is a quiet comparison; flt.s and fle.s raise NV on any NaN.</p>
        <div class="try">Run "Exception flags": a0…a4 hold the flags after ∞ − ∞, an overflow in RNE and in RTZ, an exact subnormal (no flag at all) and an inexact one.
        The panel shows fcsr beside the f registers, and checks it against the golden model after every instruction. Then try "Rounding modes" and "fmin, fmax, fclass".</div>`,
      scene: () => cpuScene({ source: fsrc('flags'), fpu: true, adder: 'ks', highlight: ['fcsr'] }),
      challenge: {
        kind: 'quiz', question: 'After fmul.s of 0.75 × 2⁻¹²⁶ (a subnormal result, computed exactly), which flags are set?',
        options: ['UF', 'UF and NX', 'None', 'NX'], answer: 2,
        explain: 'Underflow needs both a tiny result and a loss of accuracy. 0.75 × 2⁻¹²⁶ = 0.11₂ × 2⁻¹²⁶ fits the subnormal format exactly, so no flag. 2⁻¹²⁶ / 3 does not: UF and NX.',
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
