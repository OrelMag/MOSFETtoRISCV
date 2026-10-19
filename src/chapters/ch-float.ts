import { fpAdd, fpDiv, fpFma, fpMul, fpSqrt, fpToInt, fpUnpack, normRound, ROUND_DECIDE } from '../lib';
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
  goals: [
    'decode a float from its sign, biased exponent and fraction, subnormals, infinities and NaNs included',
    'round a result in any of the five RISC-V modes from its last kept bit, guard and sticky bits, and say which flags it raises',
    'trace an addition through align, add, normalize and round, and say why a fused multiply-add rounds only once',
    'weigh the single-cycle FPU against the pipelined one by clock period, CPI and NAND count',
  ],
  builds: ['muldiv', 'pipeline'],
  recap: {
    keep: [
      'A float is (−1)<sup>s</sup> × 1.f × 2<sup>e − bias</sup>, the leading 1 hidden. Exponent 0 holds zero and the subnormals, all ones ∞ and NaN. Every binade holds the same 2<sup>M</sup> values (2<sup>23</sup> in float32), so precision is relative. A NaN\'s top fraction bit is its quiet bit (0: signaling, NV when used); every NaN RISC-V computes is the canonical 0x7FC00000.',
      'Guard, round and sticky bits are enough to round exactly. RNE rounds up when G = 1 and (S = 1 or the last kept bit is 1); the five modes differ in that one decision, a 62-NAND block.',
      'RISC-V never traps on a float exception: NV, DZ, OF, UF and NX accumulate in fflags. UF needs a result that is tiny (judged after rounding) <em>and</em> inexact.',
      'float32: the adder is about 8 200 NANDs and 181 deep, the multiplier 14 900 and 176, the fma 26 300 and 270, one rounding against 357 for fmul then fadd.',
      'In the single-cycle CPU the FPU triples the size and stretches the period from 103 to 313 NAND delays. Cut into E, M and X, the pipelined RV32IF runs at 121, is smaller (163 500 against 172 500 NANDs) and 1.3 to 2.2 times faster on six of the seven programs; the CSR-heavy one is 5 % slower.',
    ],
    practise: ['n_float', 'o_fpunpack', 'o_fpround', 'o_fpsticky', 'o_fplzc', 'o_fpnorm', 'o_fpadd', 'o_fpmul', 'o_fpcmp', 'o_fpcvt'],
    check: [
      {
        question: 'In the chapter\'s 8-bit format (4 exponent bits, bias 7, 3 fraction bits), what is 0x4C = 0 1001 100?',
        options: ['6', '2', '768'],
        answer: 0,
        explain: 'Exponent 1001 = 9, so 2<sup>9 − 7</sup> = 4; the significand is 1.100₂ = 1.5 with the hidden bit. 1.5 × 4 = 6.',
        why: ['', 'That drops the hidden bit: a normal number\'s significand is 1.f, so 100 means 1.5, not 0.5.', 'That forgets the bias: the stored exponent 9 stands for 9 − 7 = 2.'],
      },
      {
        question: 'A positive result is inexact with last kept bit 0, G = 1 and S = 1. Which modes round its magnitude up?',
        options: ['RNE, RMM and RUP', 'Only RUP', 'RNE and RMM only', 'All five'],
        answer: 0,
        explain: 'G = 1 with S = 1 is more than half an ulp, so both nearest modes round up; RUP rounds any inexact positive result up. RTZ truncates, and towards −∞ a positive number truncates too.',
        why: ['', 'Above the halfway point the two nearest modes round up as well: G = 1 with S = 1 is more than half an ulp.', 'RUP rounds a positive inexact result up whatever G and S are.', 'RTZ always truncates, and RDN (towards −∞) truncates a positive number.'],
      },
      {
        question: 'The single-cycle RV32IF runs at 313 NAND delays with CPI 1, the pipelined one at 121. Above roughly what CPI does the pipeline lose?',
        options: ['About 2.6', 'About 1.0', 'About 6, the number of stages'],
        answer: 0,
        explain: 'Time per instruction is CPI × period: 313 / 121 ≈ 2.6. "Exception flags" ran at about 2.7 (76 cycles for 28 instructions) and was the one program that lost.',
        why: ['', 'At CPI 1 the pipeline is 2.6 times faster: it loses only when stalls eat that whole factor.', 'Overlap is the point of a pipeline: an instruction does not hold all six stages. Break-even is where CPI × 121 reaches 313.'],
      },
    ],
  },
  steps: [
    {
      title: 'Scientific notation in binary',
      body: `
        <p>A float is a sign, an exponent and a fraction: (−1)<sup>s</sup> × 1.f × 2<sup>e − bias</sup>. The leading 1 is not stored
        (the <em>hidden bit</em>). The exponent is biased, so that comparing two positive floats as integers orders them correctly.
        Exponent 0 marks zero and the <strong>subnormals</strong> (no hidden bit, gradual underflow). Exponent all ones marks
        <strong>infinity</strong> (fraction 0) and <strong>NaN</strong> (fraction ≠ 0).</p>
        <p>The top fraction bit of a NaN is the <em>quiet</em> bit. A quiet NaN (1) passes through arithmetic without complaint; a
        <em>signaling</em> NaN (0, with some lower fraction bit set so that it is not ∞) raises the invalid flag when an operation consumes it. IEEE 754
        lets a NaN carry a payload through a computation; RISC-V does not: every NaN an operation produces is the <strong>canonical NaN</strong>
        0x7FC00000 (positive, quiet, payload 0), whatever the operands were. Only loads, stores, moves and sign injection copy a NaN's bits unchanged.
        In the 8-bit format the circuits below use, the canonical NaN is 0 1111 100 = 0x7C.</p>
        <p>0.1 has no finite binary expansion, so the float called 0.1 is really 0.100000001490116…: the nearest of the
        2<sup>32</sup> patterns.</p>`,
      widget: floatExplorer,
      challenge: {
        kind: 'quiz', question: 'How many float32 values lie in [1, 2), and how many in [1024, 2048)?',
        options: ['2²³ and 2²³', '2²³ and 2¹³', 'Infinitely many in both', '2³² and 2²²'], answer: 0,
        why: ['', 'That mixes up count and spacing: the gap grows from 2⁻²³ to 2⁻¹³, but each binade still holds every 23-bit fraction once.', 'The reals in each interval are infinite; the floats are a finite set of 2³² patterns.', '2³² is every pattern of the format, all exponents and both signs. One binade fixes sign and exponent, leaving the 23 fraction bits.'],
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
        <p>The hardware first takes the encoding apart: sign, exponent, fraction, <span data-show="u6">the hidden bit</span> (1 unless the
        <span data-show="u1">exponent field is 0</span>), and <span data-show="pin:zero pin:inf pin:nan">flags for zero,
        infinity and NaN</span>. Subnormals behave as if their exponent were 1, which makes the rest of the datapath uniform.</p>
        <p>These steps use an 8-bit format (4 exponent bits, 3 fraction bits) so you can see every wire. The same generators build float32,
        and the small versions are tested against exact arithmetic: a 6-bit format on every operand pair, the 8-bit ones on every special and boundary
        operand against every other, plus a random sample (details in "float32: the same circuit, bigger").</p>
        <div class="try">0x5A = 0 1011 010 = +1.010₂ × 2^(11 − 7) = 20. Try 0x05 (a subnormal) and 0x78 (infinity).</div>`,
      scene: () => ({ root: fpUnpack(E4M3), inputs: { x: 0x5a } }),
      tries: [(st) => st.value('inf') === 1],
    },
    {
      title: 'Addition: align, add, normalize, round',
      body: `
        <p>To add, the exponents must match. <span data-show="u6">Compare the magnitudes</span> and <span data-show="u7">swap</span> so the bigger operand comes first.
        <span data-show="u22">Shift the smaller significand right</span> by the <span data-show="u14">exponent difference</span>: bits that fall off are not thrown away but ORed into a <strong>sticky bit</strong>.
        Then <span data-show="u27">add, or subtract</span> if the signs differ. Then <span data-show="u40">normalize</span>: a carry shifts the sum right one place; a cancellation leaves leading zeros, which are counted and shifted out.</p>
        <p>Three extra bits below the significand (<strong>guard</strong>, <strong>round</strong>, <strong>sticky</strong>) are provably enough to round the
        result exactly as if it had been computed with infinite precision.</p>
        <div class="try">a = 0x44 (3.0), b = 0x38 (1.0): 4.0 = 0x48. Then b = 0x01 (the smallest subnormal): too small to change a.</div>`,
      scene: () => ({ root: fpAdd(E4M3), inputs: { a: 0x44, b: 0x38, sub: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the result exactly zero by subtracting a number from itself, and check its sign: x − x is +0.',
        check: (st) => st.getInput('sub') === 1 && st.getInput('a') === st.getInput('b') && st.getInput('a') !== 0 && st.value('y') === 0,
        hints: [
          'The subtract input is sub. What does a − b give when b holds the same bits as a?',
          'Then read y. An exact zero sum in round to nearest has a fixed sign: which pattern is +0 in this format, and which is −0?',
        ],
        answer: 'Set sub = 1 and b = a (e.g. both 0x44). The significands cancel completely; in round-to-nearest the sign of an exact zero sum is +, so y = 0x00, not 0x80.',
        solve: (st) => st.setInputs({ sub: 1, b: st.getInput('a') || 0x48, a: st.getInput('a') || 0x48 }),
      },
    },
    {
      title: 'Round to nearest, ties to even',
      body: `
        <p>The normalize-and-round unit is shared by every operation. It <span data-show="u2">counts leading zeros</span> and
        <span data-show="u17">shifts left</span>, but never below the smallest exponent; there it <span data-show="u24">shifts right</span> instead, producing a subnormal.
        Then it rounds: with G the first dropped bit and S the OR of all the others, it <span data-show="u45">rounds up</span> when
        G = 1 and (S = 1 or the last kept bit is 1). A tie (G = 1, S = 0) goes to the even neighbour, so ties do not bias long sums upwards.</p>
        <p>A carry out of the rounding (1.111 + 1 = 10.000) <span data-show="u57">bumps the exponent</span>. An exponent beyond the top becomes
        <span data-show="u62">infinity</span>.</p>`,
      scene: () => ({ root: normRound(E4M3, 8), inputs: { sign: 0, exp: 3, mant: 0b10011100, stin: 0, rm: 0 } }),
      challenge: {
        kind: 'quiz', question: 'Keeping 3 fraction bits, how does 1.0101₂ round? And 1.0111₂? (Round to nearest, ties to even.)',
        options: ['1.010 and 1.100', '1.011 and 1.011', '1.010 and 1.011', '1.011 and 1.100'], answer: 0,
        why: ['', 'That rounds the first tie up and the second down: neither ties to even nor ties away.', 'That truncates the second, ignoring that its kept part 1.011 is odd: a tie goes to the even neighbour, 1.100.', 'Rounding every tie up is ties away from zero (RMM). Ties to even keeps 1.010, which is already even.'],
        explain: 'Both are exact ties (G = 1, S = 0). 1.010|1 keeps 1.010 because its last bit is already even (0); 1.011|1 rounds up to 1.100, the even neighbour.',
      },
    },
    {
      title: 'Five rounding modes',
      body: `
        <p>RISC-V has five: <span data-show="u6"><strong>RNE</strong></span> (nearest, ties to even, the default), <strong>RTZ</strong> (towards zero: truncate),
        <span data-show="u7"><strong>RDN</strong></span> (towards −∞), <span data-show="u8"><strong>RUP</strong></span> (towards +∞) and <span data-show="u9"><strong>RMM</strong></span> (nearest, ties away from zero).
        Every arithmetic instruction carries a 3-bit rm field; rm = 7 (<em>dyn</em>) means "use frm", the mode held in the fcsr register.
        RDN and RUP give interval arithmetic: computing a bound twice, once in each mode, brackets the exact result.</p>
        <p>The modes only change one decision: <span data-show="u17">whether to add one unit in the last place</span> to the truncated magnitude, from the sign, the
        last kept bit, G and S. That is this block: 62 NANDs, 13 deep, sitting beside the incrementer of normalize &amp; round. It also says
        <span data-show="u18">where an overflow goes</span>: to ∞ in RNE and RMM and in the direction being rounded towards, otherwise to the largest finite number (RTZ never
        produces ∞ from finite operands). The reserved encodings 5 and 6 are illegal instructions in RISC-V; this CPU has no traps, so here they
        (and frm values above 4) behave as RTZ, in the hardware and in the instruction-set simulator (the reference model the CPUs are
        checked against) alike.</p>
        <div class="try">G = 1, S = 0 (a tie), lsb = 1: RNE and RMM round up, RTZ does not. Set sign = 1 and try RDN (rm = 2) and RUP (rm = 3).</div>`,
      scene: () => ({ root: ROUND_DECIDE, inputs: { rm: 0, sign: 0, lsb: 1, g: 1, s: 0 } }),
      challenge: {
        kind: 'quiz', question: 'fcvt.w.s of −2.5 in RNE, RTZ, RDN, RUP and RMM gives…',
        options: ['−2, −2, −3, −2, −3', '−3, −2, −3, −2, −3', '−2, −2, −2, −3, −3', '−2, −3, −3, −2, −2'], answer: 0,
        why: ['', 'That rounds the RNE tie away from zero. Ties to even picks −2, whose last bit is 0.', 'That swaps RDN and RUP: from −2.5, towards −∞ is −3 and towards +∞ is −2.', 'RTZ never increases the magnitude, so −2.5 truncates to −2; and RMM breaks a tie away from zero, to −3.'],
        explain: 'A tie: RNE picks the even neighbour (−2); RTZ truncates (−2); RDN goes towards −∞ (−3); RUP towards +∞ (−2); RMM away from zero (−3). The "Rounding modes" program on the FPU CPU later in this chapter computes exactly this.',
      },
    },
    {
      title: 'Exception flags',
      body: `
        <p>IEEE 754 defines five exceptions; RISC-V does not trap on them but ORs them into <strong>fflags</strong>, where they stay until software
        clears them, so one check after a long loop finds any exception inside it. <strong>NV</strong> invalid (∞ − ∞, 0 × ∞, a signaling NaN
        operand, an out-of-range float → int), <strong>DZ</strong> divide by zero, <strong>OF</strong> overflow, <span data-show="u80"><strong>UF</strong> underflow</span>,
        <span data-show="u81"><strong>NX</strong> inexact</span> (G or S was 1, or overflow).</p>
        <p>Underflow is subtle. A result is <span data-show="u60"><em>tiny</em></span> if it lies below 2<sup>emin</sup>; RISC-V checks tininess <em>after rounding</em>,
        as if the exponent were unbounded. And UF is raised only if the tiny result is also inexact: a subnormal computed exactly raises nothing. Detecting
        "after rounding" costs <span data-show="u50">a second rounding decision</span>: with G as the last bit and the bit below it (R) as the new guard, would the M + 1 kept
        bits carry into 2<sup>emin</sup>? Modes and flags add about 250 NANDs (4.5 %) to the float32 normalize &amp; round unit. With its incrementers
        and overflow test made parallel (see the pipelined FPU at the end of the chapter), the multiplier's instance (48-bit significand) is 6 120 NANDs and
        102 NAND delays deep.</p>
        <div class="try">exp = 0, mant = 1111 0000: 1.111 × 2<sup>−7</sup>. It rounds to 0x08 = 2<sup>−6</sup>, the smallest normal, yet flags = UF NX (0x03): with an unbounded exponent it is exact at 1.111 × 2<sup>−7</sup>, below 2<sup>−6</sup>. Now mant = 1111 1100: the same result, but only NX. In RTZ (rm = 1) the first stays subnormal, 0x07.</div>`,
      scene: () => ({ root: normRound(E4M3, 8), inputs: { sign: 0, exp: 0, mant: 0b11110000, stin: 0, rm: 0 } }),
    },
    {
      title: 'Multiplication',
      body: `
        <p>Multiplication is simpler than addition: no alignment. <span data-show="u2">The sign is an XOR</span>, <span data-show="u9 u12">the exponents add</span>
        (minus one bias), and the significands go through <span data-show="u3">a tree multiplier</span> from <a href="#/c/muldiv/0">chapter 20</a>. The product of two
        numbers in [1, 2) lies in [1, 4), so normalization moves it at most one place, unless subnormal inputs leave leading zeros, which
        <span data-show="u14">the shared unit</span> handles anyway. <span data-show="u17">∞ × 0 is NaN</span>.</p>
        <div class="try">a = b = 0x3A (1.25): 1.5625 = 1.1001₂ needs 4 fraction bits, an exact tie, so it rounds to the even neighbour 1.100₂ = 1.5 (0x3C). Then 0x46 (3.5) × 0x42 (2.5) = 8.75 = 1.00011₂ × 2³: above the tie, it rounds up to 9 (0x51).</div>`,
      scene: () => ({ root: fpMul(E4M3), inputs: { a: 0x3a, b: 0x3a } }),
    },
    {
      title: 'Float to integer',
      body: `
        <p>fcvt.w.s and fcvt.wu.s reuse the same ideas backwards. Put the significand at the top of a (w + 1)-bit word, its hidden bit at weight
        2<sup>w−1</sup>, and shift right by (w − 1 + bias) − exponent with a sticky shifter: the bottom bit is G, the shifted-out bits are S. Round in mode rm
        (an incrementer), then check the range: −2<sup>31</sup> … 2<sup>31</sup> − 1 signed, 0 … 2<sup>32</sup> − 1 unsigned. NaN, ±∞ and anything out
        of range after rounding saturate and raise NV: NaN, +∞ and too-large positives to the top of the range (2<sup>31</sup> − 1 or
        2<sup>32</sup> − 1), −∞ and too-large negatives to the bottom (−2<sup>31</sup> signed, 0 unsigned); otherwise NX if G or S. −0.3 → unsigned
        is 0 (just NX), but −0.7 rounds (in RNE) to −1, out of the unsigned range: 0 again, now with NV.</p>
        <p>The float32 → int32 converter costs 3 450 NANDs and is 104 deep: <span data-show="u0">an aligning box</span> (a 33-bit sticky shifter) and <span data-show="u1">a rounding box</span> (a prefix
        incrementer, the range check, a negator), which the pipelined FPU puts in two stages.</p>
        <div class="try">a = 0x42 is 2.5 (0 1000 010), into an 8-bit integer: y = 2 in RNE. Try rm = 3 (RUP) and rm = 4 (RMM). Then 0x7F (NaN): 127 and NV.</div>`,
      scene: () => ({ root: fpToInt(E4M3, 8), inputs: { a: 0x42, signed: 1, rm: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the converter saturate: find a finite input whose signed 8-bit result is −128 and which raises NV (flags = 0x10).',
        check: (st) => st.getInput('signed') === 1 && st.value('y') === 0x80 && st.value('flags') === 0x10 && (st.getInput('a') & 0x78) !== 0x78,
        hints: [
          'The signed 8-bit range is −128 … 127. The input must be finite (exponent below 1111) and negative, and beyond that range.',
          'Set the sign bit and use the largest finite exponent, 1110: with bias 7 that is 2<sup>7</sup> = 128 times the significand. Which fractions take the magnitude past 128?',
        ],
        answer: '−240 (0xF7 = 1 1110 111) is far below −128: any negative value of magnitude ≥ 129 (after rounding) saturates to −128 = 0x80 with NV. −128 itself (0xF0 = 1 1110 000) converts exactly, without NV.',
        solve: (st) => st.setInputs({ a: 0xf7, signed: 1 }),
      },
    },
    {
      title: 'Division, one bit per clock',
      body: `
        <p>Division has no shortcut like the multiplier's tree: each quotient bit depends on the remainder left by the previous one. So the FPU
        reuses the integer divider of <a href="#/c/muldiv/0">chapter 20</a>: <strong>radix-2 restoring division</strong>, one step per clock. Both significands are first
        <span data-show="u3 u4"><em>prenormalized</em></span> (a subnormal's leading zeros shifted out, the exponent lowered), so they lie in [1, 2) and the quotient in (½, 2).
        <span data-show="u11">The step</span> tries remainder − divisor; if it does not borrow, the quotient bit is 1 and the difference is kept, otherwise the remainder is
        restored (<span data-show="u13">a multiplexer</span>). M + 4 steps give the M + 1 kept bits, G and one more bit (for tininess) even when the quotient is below 1; the final
        remainder ≠ 0 is the sticky bit, and <span data-show="u23">the shared normalize &amp; round</span> does the rest, in any mode. Exponent: e<sub>a</sub> − e<sub>b</sub> + bias.
        <span data-show="u30">x / 0</span> is ∞ with <strong>DZ</strong>; 0 / 0 and ∞ / ∞ are NaN with NV.</p>
        <p>float32: 27 steps, <strong>29 cycles</strong>, 10 300 NANDs (4 500 of them normalize &amp; round, 2 300 the two prenormalizers); the step
        loop is 58 NAND delays.</p>
        <details class="deeper"><summary>Deeper: why restoring</summary>
        <p>It is the integer step unchanged, and a mux is cheap. Chapter 20 built the alternatives. <a href="#/c/muldiv/16">Non-restoring division</a>
        drops the mux (add or subtract by the previous sign) but needs a correction step before the remainder can serve as a sticky bit.
        <a href="#/c/muldiv/17">SRT</a> keeps the remainder in carry-save form, so no carry chain sits in the loop, and <a href="#/c/muldiv/19">radix 4</a>
        makes two quotient bits a clock, at the price of a digit-selection table; real FPUs use radix-4 (or higher) SRT, shared with square root.
        Here the 58-delay step already fits well inside the CPU's clock (313 NAND delays single-cycle, 121 pipelined), so a shorter step buys nothing; fewer steps would: radix 4 would roughly halve
        the 29 cycles.</p></details>
        <div class="try">1.0 / 3.0 in the 8-bit format: start = 1. Pulse the clock 8 times: q fills from the right, then done = 1 and y = 0x2B (1.011₂ × 2<sup>−2</sup> = 0.34375, rounded up: NX). Try b = 0 (1 / 0 = ∞, DZ).</div>`,
      scene: () => ({ root: fpDiv(E4M3), inputs: { a: 0x38, b: 0x44, rm: 0, start: 1, clk: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Clock the divider until done = 1 with y = 0x2B (1 / 3, rounded to nearest).',
        check: (st) => st.value('done') === 1 && st.value('y') === 0x2b,
        hints: [
          'done rises once every quotient bit has been made. Count clock pulses, not gate delays.',
          'The first pulse loads the remainder with the dividend; each later pulse makes one quotient bit. How many steps does M + 4 give with 3 fraction bits?',
        ],
        answer: 'Eight pulses: one loads the remainder with the dividend, seven make one quotient bit each (M + 4 = 7), and in the ninth cycle done = 1 while normalize & round presents the result.',
        solve: (st) => { st.setInputs({ a: 0x38, b: 0x44, rm: 0, start: 1 }); st.runCycles(8); },
      },
    },
    {
      title: 'Square root, the same way',
      body: `
        <p>Long-hand square root is division by a divisor that is still being built. Write the radicand as 1.f × 2<sup>e</sup>, <span data-show="u4">make e even</span> (double
        the significand if it is odd), and the root of a number in [1, 4) is in [1, 2) with <span data-show="u25">exponent e / 2</span>. Each clock brings down two radicand bits
        (r ← 4r + next two) and <span data-show="u13">tries to subtract 4q + 1</span>, the difference between (2q + 1)² and (2q)², scaled; if it fits, the next root bit is 1. M + 3
        steps, the remainder is the sticky bit. √−0 = −0, the root of anything negative is NaN with NV.</p>
        <p>A square root never overflows or underflows (it halves the exponent), and never lands exactly halfway between two floats, so RNE and RMM
        always agree. float32: 26 steps, <strong>28 cycles</strong>, 9 200 NANDs. Real FPUs share one SRT unit between division and square root;
        here they are two transparent boxes.</p>
        <div class="try">a = 0x40 (2.0): pulse the clock 7 times. y = 0x3B (1.011₂ = 1.375, with NX): √2 = 1.0110101…₂ rounds down. Try rm = 3 (RUP): 0x3C.</div>`,
      scene: () => ({ root: fpSqrt(E4M3), inputs: { a: 0x40, rm: 0, start: 1, clk: 0 }, autoClock: false }),
      tries: [(st) => st.value('done') === 1 && st.value('y') === 0x3b],
      challenge: {
        kind: 'quiz', question: 'Why can a correctly rounded square root never be an exact tie?',
        options: [
          'If √x were a (p + 1)-bit number ending in 1, its square would end in a 1 below x\'s last bit, so it could not equal x',
          'Because the hardware computes one extra bit',
          'Because the exponent is always even',
          'It can; ties are just rare',
        ], answer: 0,
        why: ['', 'The extra bit is how the hardware would see a tie, not what prevents one. The reason is arithmetic: the square of a tie value has too many bits.', 'Making the exponent even scales the radicand by 2; it does not change which bit patterns the root can have.', 'A tie would need √x to have exactly p + 1 significant bits ending in 1; its square then needs 2p + 2 bits, more than x has. It never happens.'],
        explain: 'A tie means √x = q + ½ ulp exactly: a number whose last significant bit is 1 at position p + 1. Squaring doubles the number of bits, and the last 1 lands at position 2p + 2, beyond anything x (p bits) can hold. So G = 1 always comes with S = 1, and RNE never needs its tie rule here.',
      },
    },
    {
      title: 'Fused multiply-add: one rounding',
      body: `
        <p>fmadd.s computes a × b + c and rounds <em>once</em>. Keep the product exact: <span data-show="u0">the 24 × 24 tree</span> gives all 48 bits. Widen c to the same 48 bits,
        take the operand with the larger exponent as the base, shift the other right with guard and sticky bits, <span data-show="u1">add or subtract</span> (a difference can come
        out negative when the exponents are within 3 of each other; it is then exact and is negated), and send the 52-bit result to
        <span data-show="u3">the same normalize &amp; round</span>. fmsub, fnmsub and fnmadd only flip the signs of c and the product. ∞ × 0 is invalid even when c is a quiet NaN, as RISC-V requires.</p>
        <p>One rounding makes x·x − p exact where fmul then fsub gives 0, and makes dot products, polynomial evaluation (Horner) and Newton steps
        both faster and more accurate. float32 fma: 26 300 NANDs, 270 deep: deeper than either multiplier (176) or adder (181), but shallower than
        the two in a row (357). It is built as three boxes, multiply (92 deep), align and add (91), round (106: the 52-bit normalize &amp; round, 102, then the NaN and ∞
        cases): the stages of the pipelined FPU.
        A production FMA shifts the addend in a 3M + 5-bit window <em>while</em> the tree multiplies; this one swaps like the adder, which is
        simpler but puts the shifter after the tree.</p>
        <div class="try">x = 0x39 (1.125): x² = 1.265625 = 1.010001₂ needs 6 fraction bits. fmul gives 1.010₂ = 1.25 (0x3A). Here c = 0x3A with negC = 1: fma(x, x, −1.25) = 2<sup>−6</sup> = 0x08, exactly, no flags; fmul then fsub would give 0.</div>`,
      scene: () => ({ root: fpFma(E4M3), inputs: { a: 0x39, b: 0x39, c: 0x3a, negProd: 0, negC: 1, rm: 0 } }),
      challenge: {
        kind: 'quiz', question: 'Why must the product be kept to all 2M + 2 bits rather than rounded to M + 3 bits with a sticky bit, as the adder does with its smaller operand?',
        options: [
          'Because c may cancel the top of the product, and then the low product bits become the leading bits of the result',
          'Because the multiplier cannot produce fewer bits',
          'For the exponent calculation',
          'It need not be; a sticky bit is always enough',
        ], answer: 0,
        why: ['', 'A multiplier could round its own output. The question is whether the low bits are still needed, and after cancellation they are.', 'The exponent comes from adding the operand exponents; it needs none of the low product bits.', 'A sticky bit only records that something was dropped. When c cancels the top of the product, the dropped bits become the leading bits of the result.'],
        explain: 'When c ≈ −a × b, subtraction cancels the leading bits, and the result consists of the product\'s low bits: they must be exact. The adder can use a sticky bit because its operands are already rounded to M + 1 bits; a full product has 2M + 2 significant bits.',
      },
    },
    {
      title: 'float32: the same circuit, bigger',
      body: `
        <p>Generated from the same code with 8 exponent and 23 fraction bits. The float32 adder costs about <strong>8 200 NANDs</strong> and is
        181 NAND delays deep. The multiplier costs about <strong>14 900</strong> (mostly its 24 × 24 tree) and is 176 deep.</p>
        <p>The small formats are tested in every rounding mode, flags included, against exact rational arithmetic, simulated 32 cases at a time. The 6-bit
        format (3 exponent bits, 2 fraction bits) is exhaustive: every operand pair for add, subtract, multiply and divide, every triple and sign variant
        for the fma (one rounding mode per case, rotating). The 8-bit formats are sampled: every special or boundary operand (zeros, subnormals, the smallest and largest normals, infinities,
        NaNs) against every operand, plus 3 000 random pairs; the fma on random triples biased towards cancellation. Square root and the conversions
        see every 8-bit input. Well over a million cases in all; every pair of the 8-bit formats is a switch for a long run by hand, not part of the
        regular test suite. float32 is tested on random and special operands (subnormals, infinities, NaNs, cancellation), and against the host CPU in
        round to nearest even.</p>
        <div class="try">1.5 (0x3FC00000) + 2.25 (0x40100000) = 3.75 (0x40700000). Follow <span data-show="u22 u27">the significands</span> through the aligner and the adder.</div>`,
      scene: () => ({ root: fpAdd(F32), inputs: { a: 0x3fc00000, b: 0x40100000, sub: 0 } }),
    },
    {
      title: 'An FPU in the CPU',
      body: `
        <p>The single-cycle CPU gains <span data-show="frf">a second register file</span> (f0–f31, no hard-wired zero, three read ports) and
        <span data-show="fpu">an FPU</span> implementing all of RV32F:
        flw, fsw, fadd.s, fsub.s, fmul.s, the four fused multiply-adds, fdiv.s and fsqrt.s (iterative: they stall the CPU, see below), sign injection
        (fsgnj.s, fsgnjn.s, fsgnjx.s, behind the pseudo-instructions fmv.s, fneg.s and fabs.s), fmin/fmax.s, feq/flt/fle.s, fcvt.w[u].s, fcvt.s.w[u], fmv.x.w, fmv.w.x and fclass.s, in all five rounding modes, with
        the exception flags. flw and fsw reuse the integer load/store path, disguised as lw and sw. The opcode or funct7 selects one of <span data-show="fpu.u61">the units'
        results</span>; the FPU is 85 200 NANDs. The f registers are 32 bits wide because there is no D. A core with doubles has 64-bit f registers
        and keeps a single <em>NaN-boxed</em>, its upper 32 bits all ones: read as a double it is a NaN, and a single whose upper half is not all ones
        reads as the canonical NaN.</p>
        <p>The cost: about 172 500 NANDs (3 times the integer CPU), and a clock period of <strong>313</strong> NAND delays instead of 103, set by
        the fused multiply-add. A float operation in one cycle makes every instruction slow. Real cores pipeline the FPU over 3 to 5 cycles.</p>
        <div class="try">Run "0.1 ten times": the sum is 0x3F800001, one ulp above 1.0, and feq.s says 0.</div>`,
      scene: () => cpuScene({ source: fsrc('tenth'), fpu: true, adder: 'ks', timing: true, highlight: ['fpu', 'frf'] }),
      challenge: {
        kind: 'reach', goal: 'Run the program to the end (a1 holds the bits of the sum).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x[11] === 0x3f800001 : false; } catch { return false; } },
        hints: [
          'The CPU panel can clock the program until it halts.',
          'Watch a1 in the register list as it runs: the program ends by moving the sum\'s bits there.',
        ],
        answer: '"Run to halt". Each addition rounds; nine of the ten additions lose a little, and the errors do not cancel: 1.0000001192.',
        solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
      },
    },
    {
      title: 'fcsr: the mode and the flags',
      body: `
        <p>This CPU has no machine-mode CSRs, so <span data-show="fcsr">the floating-point control and status register</span> lives in the FPU path: two registers, frm (3 bits)
        and fflags (5 bits), 541 NANDs with their read and write logic. csrrw / csrrs / csrrc and the immediate forms reach them at 0x001 (fflags),
        0x002 (frm) and 0x003 (both); the assembler's frflags, fsflags, frrm, fsrm(i), frcsr and fscsr are those instructions. Every OP-FP instruction
        ORs its flags into fflags on the clock edge; a CSR read returns the old value, so <code>fsflags a0, zero</code> reads and clears in one go.</p>
        <p><span data-show="fpu.u11">fmin.s / fmax.s</span> follow IEEE 754-2019 (minimumNumber): a NaN operand is ignored, −0 &lt; +0, NV only for a signaling NaN (1 994 NANDs,
        comparator included). <span data-show="fpu.u14">fclass.s</span> returns one of ten bits (147 NANDs). feq.s is a quiet comparison; flt.s and fle.s raise NV on any NaN.</p>
        <div class="try">Run "Exception flags": a0…a4 hold the flags after ∞ − ∞, an overflow in RNE and in RTZ, an exact subnormal (no flag at all) and an inexact one.
        The panel shows fcsr beside the f registers, and checks it against the instruction-set simulator after every instruction. Then try "Rounding modes" and "fmin, fmax, fclass".</div>`,
      scene: () => cpuScene({ source: fsrc('flags'), fpu: true, adder: 'ks', highlight: ['fcsr'] }),
      challenge: {
        kind: 'quiz', question: 'After fmul.s of 0.75 × 2⁻¹²⁶ (a subnormal result, computed exactly), which flags are set?',
        options: ['UF', 'UF and NX', 'None', 'NX'], answer: 2,
        why: ['A tiny result raises UF only when it is also inexact; RISC-V never raises UF without NX.', 'Both need a rounding error, and 0.11₂ × 2⁻¹²⁶ fits the subnormal format exactly.', '', 'Nothing is lost: the product is exactly representable, so it is not inexact.'],
        explain: 'Underflow needs both a tiny result and a loss of accuracy. 0.75 × 2⁻¹²⁶ = 0.11₂ × 2⁻¹²⁶ fits the subnormal format exactly, so no flag. 2⁻¹²⁶ / 3 does not: UF and NX.',
      },
    },
    {
      title: 'Stalling for fdiv and fsqrt',
      body: `
        <p>A 29-cycle instruction in a single-cycle CPU: <span data-show="fpu">the FPU</span> raises <span data-show="fpu.u33"><strong>stall</strong></span> while its divider or square-root unit is busy
        and not done, exactly like the integer divider of the RV32IM system CPU. <span data-show="nstall">retire = ¬stall</span> gates the PC enable and
        <span data-show="xwg fwg">both register-file write enables</span>, so the instruction stays in place until its result is ready, then retires in the done cycle.
        <span data-show="fpg">The fflags write is gated too</span>: during the stall the flags at the FPU's output belong to a half-finished quotient. The
        instruction-set simulator steps only when retire = 1.</p>
        <p><span data-show="fpu.u27">The two units</span> add 19 500 NANDs. They do not lengthen the clock: one step is 58 NAND delays, far below a float add.
        "Division and square root" takes 215 cycles for 22 instructions. "Newton's √2" computes x ← (x + 2 / x) / 2 four times: 132 cycles to reach the
        same correctly rounded float that one fsqrt.s gives in 28.</p>
        <div class="try">Run "Division and square root": the PC waits at each fdiv.s and fsqrt.s while the panel says stalled, and the CPI climbs.</div>`,
      scene: () => cpuScene({ source: fsrc('divsqrt'), fpu: true, adder: 'ks', highlight: ['fpu'] }),
      challenge: {
        kind: 'quiz', question: 'Why must the fflags update be gated by retire, when the register writes already are?',
        options: [
          'Because fflags is sticky: an OR of 28 cycles of intermediate garbage flags would never be undone',
          'To save power',
          'Because CSR instructions stall too',
          'It need not be; the flags only change at the end',
        ], answer: 0,
        why: ['', 'Power is not the issue: ungated, wrong flags would stay set, which is a correctness bug.', 'CSR instructions do not stall in this CPU; only fdiv.s and fsqrt.s do. The gate is for the stalled FP instruction itself.', 'The flag outputs change through the iteration, following a half-finished quotient, and fflags ORs in whatever it sees while enabled.'],
        explain: 'A register write that happens too early is overwritten by the correct one at retirement, but fflags only accumulates: any spurious NX or OF ORed in during the stall would stay set. So the accrual enable is OP-FP AND retire.',
      },
    },
    {
      title: 'fma in the CPU',
      body: `
        <p><span data-show="fpu.u16">The fused multiply-adds</span> have their own opcodes (0x43, 0x47, 0x4B, 0x4F) and their own format, <strong>R4</strong>: a third source register
        rs3 in bits 31:27, the format (00 = single) in 26:25, rm in funct3. Three operands need <span data-show="frf">a third read port on the f register file</span>: one more
        32-way multiplexer tree of 32-bit words, 3 970 NANDs. Bits 3:2 of the opcode are the two negations (bit 3 negates the product, bit 2 c), so
        <span data-show="fdec">the decoder</span> hands them to <span data-show="fpu">the unit</span> directly.</p>
        <p>In a single-cycle CPU the deepest instruction sets the clock: adding the fma took the period from 274 to 368 NAND delays (+34 %), paid by
        every add and branch (313 once normalize &amp; round is shortened, below). A pipelined FPU gives fma several cycles of latency instead.</p>
        <div class="try">Run "Fused multiply-add": a0 = 0 (fmul then fsub), a1 = 0x33800000 (fmsub.s, 2<sup>−24</sup>), then 17, 7, −7, −17 from the four variants.
        "Horner with fmadd" evaluates a cubic in 3 instructions instead of 6.</div>`,
      scene: () => cpuScene({ source: fsrc('fma'), fpu: true, adder: 'ks', highlight: ['fpu', 'frf'] }),
      challenge: {
        kind: 'quiz', question: 'fnmadd.s computes −(a × b) − c. With a × b = 2 and c = −2, what does it return in RNE, and with which sign?',
        options: ['+0', '−0', '−4', '+4'], answer: 0,
        why: ['', 'An exact zero from terms of opposite sign is −0 only in RDN; the negations in fnmadd do not change that rule.', 'That is fnmsub, −(a × b) + c = −2 − 2: fnmadd negates c as well.', 'That is fmsub, a × b − c = 2 + 2: fnmadd negates the product as well.'],
        explain: '−(2) − (−2) = −2 + 2: an exact zero from two terms of opposite sign, which is +0 in every mode except RDN (−0).',
      },
    },
    {
      title: 'A pipelined FPU',
      body: `
        <p>The five-stage pipeline of <a href="#/c/pipeline/0">chapter 16</a> gains <span data-show="MX XW">a sixth stage, <strong>X</strong></span>, between M and W. Every instruction, integer or FP,
        walks F D E M X W, so they all retire in program order and the instruction-set simulator can still be stepped at W. The FP pipe is the fused
        multiply-add cut into its three boxes: <span data-show="fpx"><em>multiply</em> in E</span>, <span data-show="fadd"><em>align and add</em> in M</span>,
        <span data-show="fres"><em>round</em> in X</span>. One rounder serves all the arithmetic (fadd, fmul, the fused multiply-adds, fcvt.s.w, fdiv, fsqrt), so the pipelined RV32IF CPU,
        163 500 NANDs, is <em>smaller</em> than the single-cycle one (172 500). The other operations (sign injection, min / max, compares, fclass,
        moves) finish in E; fcvt.w.s aligns in E and <span data-show="ftoi">rounds in M</span>.</p>
        <details class="deeper"><summary>Deeper: every operation on the fma pipe</summary>
        <p>fadd is a × 1 + b, fmul is a × b + 0 (the zero signed like the product), fcvt.s.w puts |x| where the product would be; fdiv and fsqrt
        iterate in E behind operand latches and send their unrounded quotient or root down the same pipe.</p></details>
        <p>Hazards. An FP result exists only at the end of X, so an instruction in D that reads an f register written by an instruction in E or M
        <span data-show="fhz"><strong>waits</strong></span> (an interlock), and then gets the value <span data-show="fA fB fC"><strong>forwarded from W</strong></span>
        (the select is decided in D, one cycle early).</p>
        <p>The clock: <strong>121</strong> NAND delays instead of 313. The E stage (unpack, prenormalize, the 24 × 24 tree) sets it; X, the stage built
        around the round box (106 deep on its own), is 118; the integer stages are at most 97.</p>
        <details class="deeper"><summary>Deeper: why not forward from X, the other hazards, and a shorter rounder</summary>
        <p>Forwarding from X instead would chain the X stage (118 deep) into the next multiply (92) in one cycle and nearly double the period. FP results
        bound for x registers wait the same way; loads are forwarded from X. fdiv / fsqrt hold F, D and E and send bubbles into M (a structural stall).
        fcsr is read in E and written in W: CSR accesses wait until no FP instruction is in flight, and FP instructions wait behind a CSR write.</p>
        <p>Getting to 121 meant shortening normalize &amp; round first: its two ripple incrementers became prefix trees
        (49 → 13 levels) and its overflow test now runs in parallel with the rounding, 142 → 102 deep, which also took the single-cycle CPU from 368 to 313.</p></details>
        <div class="try">Run "Dependent vs independent adds" and watch the pipeline diagram: in the first half every fadd.s waits two cycles for the previous
        one; with three accumulators the adds flow one per cycle. The timing panel shows the critical path.</div>`,
      scene: () => cpuScene({ source: fsrc('fpchain'), pipeline: true, fpu: true, adder: 'ks', timing: true, highlight: ['fpx', 'fadd', 'fres'] }),
      challenge: {
        kind: 'quiz', question: 'fadd.s fa0, fa0, ft0 repeated: how many cycles does each one take on this pipeline, and why?',
        options: [
          'Three: it waits in D while the previous one is in E and in M, then takes its result forwarded from W',
          'One: forwarding removes every stall',
          'Two: one stall for the load-use hazard',
          'Six: one per stage',
        ], answer: 0,
        why: ['', 'Forwarding moves a value that exists. The sum exists only at the end of X, two cycles after the next fadd wants it in E.', 'There is no load here, and the wait is two stall cycles, so each fadd takes three cycles.', 'That is one instruction\'s latency with no overlap. The next fadd only waits until its producer reaches W, while the stages keep overlapping.'],
        explain: 'The sum exists only at the end of X. The next fadd can enter E when its producer reaches W, three cycles after the producer entered E: two stall cycles each. Twelve dependent adds take 45 cycles with the fill; spread over three accumulators the same adds have no stalls at all (23 instructions in 35 cycles).',
      },
    },
    {
      title: 'Pipelined vs single-cycle: CPI × period',
      body: `
        <p>Measured on the gate-level CPUs, every program co-simulated against the instruction-set simulator: single-cycle → pipelined, cycles (the pipeline's
        include its five-cycle fill) and time = cycles × period (313 and 121 NAND delays).</p>
        <table>
          <tr><th>program</th><th>cycles</th><th>time (NAND delays)</th><th>gain</th></tr>
          <tr><td>0.1 ten times</td><td>41 → 67</td><td>12.8 k → 8.1 k</td><td>1.58×</td></tr>
          <tr><td>dot product</td><td>80 → 137</td><td>25.0 k → 16.6 k</td><td>1.51×</td></tr>
          <tr><td>fused multiply-add</td><td>26 → 42</td><td>8.1 k → 5.1 k</td><td>1.60×</td></tr>
          <tr><td>Horner with fmadd</td><td>23 → 45</td><td>7.2 k → 5.4 k</td><td>1.32×</td></tr>
          <tr><td>division and square root</td><td>215 → 257</td><td>67.3 k → 31.1 k</td><td>2.16×</td></tr>
          <tr><td>Newton's √2</td><td>170 → 199</td><td>53.2 k → 24.1 k</td><td>2.21×</td></tr>
          <tr><td>exception flags</td><td>28 → 76</td><td>8.8 k → 9.2 k</td><td>0.95×</td></tr>
        </table>
        <p>The pipeline wins 1.3 to 2.2 times on six of the seven programs; the iterative units gain most, because their 28 cycles now run at the short clock. CPI rises from 1 to
        1.6–2.7 (fadd chains, the fill; 11.7 with divisions). "Exception flags" is slower: almost every other instruction reads fflags, and each CSR access
        <span data-show="fhz">waits for the FP pipe to drain</span>. Real code keeps CSR accesses out of loops and interleaves independent work, as the compiler would schedule it.</p>`,
      scene: () => cpuScene({ source: fsrc('dot'), pipeline: true, fpu: true, adder: 'ks', highlight: ['fhz'] }),
      challenge: {
        kind: 'quiz', question: 'Why must an integer instruction pass through X too, although it has nothing to do there?',
        options: [
          'So that every instruction has the same path length and results retire in order: an add must not write its register before an older fmul',
          'To give the ALU more time',
          'Because the register file needs two cycles to write',
          'To forward loads',
        ], answer: 0,
        why: ['', 'The ALU still has its one cycle in E; X adds latency to the pipe, not time to any stage.', 'The register file writes in one cycle, in W. The extra stage is there for ordering.', 'Loads are forwarded from X because they pass through it: a consequence of the extra stage, not its reason.'],
        explain: 'With different path lengths a younger integer instruction would finish before an older FP instruction: write-after-write and precise state would need extra logic (a scoreboard or a reorder buffer). Equal lengths keep it simple; the cost is one more forwarding source (X) and one stage of latency for nothing.',
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
        why: ['It is the specified behaviour: IEEE 754 requires it, and the comparator forces it on purpose.', '', 'The same NaN bit pattern compared with itself is unequal too: the rule is about NaN, not about its encodings.', 'Quiet NaNs compare unordered as well. A signaling NaN (quiet bit 0) differs only in raising NV in feq.s (flt.s / fle.s raise NV on any NaN).'],
        explain: 'NaN means "no meaningful value"; ordering it would be meaningless too. The comparator checks the NaN flags of both operands and forces eq, lt and le to 0.',
      },
    },
  ],
};

void F32;
