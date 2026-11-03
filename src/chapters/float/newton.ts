// Chapter 24, steps after "fma in the CPU": division on the fma (Newton-Raphson, Markstein's correction) and what the F
// extension buys against a soft-float routine. Every number the prose quotes is measured in tests/newton.test.ts (the ulp
// counts and instruction counts on the golden model, the cycles on both gate-level CPUs).

import { FPU32, fpDiv, singleCycleCpu } from '../../lib';
import { assemble } from '../../riscv/asm';
import { cpuState } from '../../riscv/cosim';
import { F_PROGRAMS } from '../../riscv/fprograms';
import { groupDigits } from '../../sim/numfmt';
import { stats } from '../../sim/stats';
import { F32 } from '../../sim/fpref';
import { cpuScene } from '../../widgets/cpupanel';
import type { Step } from '../types';

const fsrc = (id: string) => F_PROGRAMS.find((p) => p.id === id)!.source;
const grp = (n: number) => groupDigits(Math.round(n));
const xreg = (st: { sim?: unknown }, i: number): number | null => { try { return st.sim ? cpuState(st.sim as never).x[i] >>> 0 : null; } catch { return null; } };
/** NANDs of the single-cycle CPU (64-word program ROM included), without and with the FPU. */
const cpuNands = (fpu: boolean) => stats(singleCycleCpu(assemble(fsrc('recip')).words, { fpu, adder: 'ks' })).nands;

/** Measured (tests/newton.test.ts, both CPUs at gate level): cycles of the Newton section (seed to corrected quotient, 23 instructions) and of one fdiv.s. */
const NEWTON_CYCLES = { single: 23, pipe: 43 };
const FDIV_CYCLES = { single: 29, pipe: 28 };
/** Clock periods in NAND delays (the chapter's own: integer CPU, single-cycle RV32IF, pipelined RV32IF). */
const PERIOD = { int: 103, single: 313, pipe: 121 };
/** Instructions of the soft multiply between its first and last line, for 0.1 x 0.7 (224 to 240 over random operands), and with mul / mulhu. */
const SOFT_INSTRS = 233, SOFT_M_INSTRS = 32;

export const newtonSteps: Step[] = [
  {
    title: 'Division without a divider',
    body: `
      <p><span data-show="fpu.u27">The iterative divider</span> costs ${grp(stats(fpDiv(F32)).nands)} NANDs and 29 cycles. The fused multiply-add of
      <span data-show="fpu">the unit</span> can divide too. Newton–Raphson finds 1/b as the root of f(x) = 1/x − b: from an estimate x, the residual
      e = 1 − b·x is the relative error, and x' = x + x·e has relative error e². Each step is <strong>two fma</strong>,
      <code>fnmsub.s e, b, x, one</code> (−(b·x) + 1, one rounding: the 48-bit product is not rounded first, so e keeps all its own bits) and <code>fmadd.s x, x, e, x</code>; the correct bits double.</p>
      <p>The seed is one integer instruction. A float's bits are nearly 2<sup>23</sup>·(log₂ v + 127), so <code>0x7EF311C7 − bits(b)</code> negates the logarithm and lands near 1/b:
      the worst relative error over all b is 5.05 %, <strong>4.3 bits</strong>. The errors then run 5.05 % → 2.6·10<sup>−3</sup> → 6.5·10<sup>−6</sup> → 4.2·10<sup>−11</sup>: <strong>three steps</strong>
      pass 2<sup>−24</sup> = 6·10<sup>−8</sup> (a table in data memory indexed by the top 8 fraction bits would start at 8 bits and need two steps, for a 256-word load).</p>
      <p>Then the quotient. q = a·x is rounded twice, once in x and once in the product, and <strong>it is not always the correctly rounded a/b</strong>. Over 100 000 random operand pairs
      (exponents kept so that quotients are normal), x after two steps differs from the correctly rounded 1/b in 82 687 cases and after three in 16, and
      <strong>27 090 quotients a·x are one ulp off</strong> (never more); a fourth step does not help, since x is already as good as a float can be. Markstein's correction repairs it with two more fma:
      r = a − b·q (<code>fnmsub.s</code>: the remainder of the division, exactly representable when q is within an ulp) and q' = q + r·x (<code>fmadd.s</code>). It gave the correctly rounded quotient in all 100 000, and for every one of 200 numerators
      against each of 40 divisors whose x was <em>not</em> the correctly rounded reciprocal. That is a measurement, not a proof, and it needs a normal quotient: with exponents spread so wide that q can be subnormal or overflow, 65 of 100 000 pairs came out wrong.</p>
      <p>Cost, measured on the gate-level CPUs: from the seed to q', 23 instructions and <strong>${NEWTON_CYCLES.single} cycles</strong> on the single-cycle CPU against ${FDIV_CYCLES.single} for fdiv.s, so ${(FDIV_CYCLES.single / NEWTON_CYCLES.single).toFixed(2)} times faster; and
      <strong>${NEWTON_CYCLES.pipe} cycles</strong> on the pipelined one against ${FDIV_CYCLES.pipe}: slower, because every fma waits for the one before it through the interlock. The method wins where the latency hides:
      dividing many numbers by one b (the reciprocal is computed once, and each quotient is three independent instructions that pipeline) or where there is no divider at all. <strong>Goldschmidt's variant</strong> multiplies numerator and denominator by
      the same factor 2 − D each step: the two products are independent, so a pipelined multiplier overlaps them (IBM's System/360 Model 91 and AMD's K7 divide this way). Its rounding errors are not corrected by later steps,
      so it too ends with a residual fma.</p>
      <div class="try">Run "Division by Newton–Raphson": a0 = 0x3FD55556 is a·x for 5 / 3, a1 = 0x3FD55555 the corrected quotient, a2 the same bits from fdiv.s, a3 = 1. The loop is the whole divider; the √2 of
      <span data-ahead="newton">"Newton's √2" (Newton's method: refine a guess x by x − f(x)/f′(x), here for x² = 2)</span> does its division <em>inside</em> the iteration instead.</div>`,
    scene: () => cpuScene({ source: fsrc('recip'), fpu: true, adder: 'ks', highlight: ['fpu', 'frf'] }),
    tries: [(st) => xreg(st, 13) === 1],
    more: {
      derive: `<p>Let x = (1 − ε)/b, so b·x = 1 − ε and e = ε. Then x' = x(1 + ε) = (1 − ε²)/b: the error is squared, so bits double. The fma keeps e honest: b·x is a 48-bit product and 1 − b·x is rounded once, so e has its own 24 bits (and is exact once x is within 2<sup>−23</sup>, the case that matters at the end). With an fmul then fsub, b·x would round first and e would be zero or noise once x is within an ulp.</p>
        <p>The correction: q' = q + r·x with r = a − b·q exact. The true quotient is q + r/b, and x ≈ 1/b to 2<sup>−24</sup> relative, so r·x is the missing part to 2<sup>−24</sup> of itself, far below an ulp of q. One rounding, in the last fmadd,
        decides the result. Markstein's theorem makes it exact when x is the correctly rounded 1/b and q is within an ulp of a/b; the sweep shows it holding for 40 divisors where the first condition fails.</p>`,
      numbers: `<table class="mini"><tr><th>Seed and steps</th><th>Worst relative error</th><th>Correct bits</th></tr>
        ${[0.0505, 0.0505 ** 2, 0.0505 ** 4, 0.0505 ** 8].map((e, i) => `<tr><td>${i === 0 ? 'seed (one subtract)' : `after ${i} step${i > 1 ? 's' : ''}`}</td><td>${e.toExponential(1).replace('e-', '·10<sup>−').replace('e', '·10<sup>') + '</sup>'}</td><td>${(-Math.log2(e)).toFixed(1)}</td></tr>`).join('')}</table>
        <table class="mini"><tr><th>Cycles (gate level)</th><th>Newton, seed to q'</th><th>fdiv.s</th><th>Period</th><th>Time, Newton vs fdiv.s (NAND delays)</th></tr>
        <tr><td>single-cycle RV32IF</td><td>${NEWTON_CYCLES.single}</td><td>${FDIV_CYCLES.single}</td><td>${PERIOD.single}</td><td>${grp(NEWTON_CYCLES.single * PERIOD.single)} vs ${grp(FDIV_CYCLES.single * PERIOD.single)}</td></tr>
        <tr><td>pipelined RV32IF</td><td>${NEWTON_CYCLES.pipe}</td><td>${FDIV_CYCLES.pipe}</td><td>${PERIOD.pipe}</td><td>${grp(NEWTON_CYCLES.pipe * PERIOD.pipe)} vs ${grp(FDIV_CYCLES.pipe * PERIOD.pipe)}</td></tr></table>`,
      pitfall: `<p>Computing e as 1 − b·x with a multiply and a subtract, or stopping at q = a·x because x is "accurate to 10<sup>−11</sup>". The first loses the residual to the first rounding; the second leaves 27 % of the quotients one ulp wrong.
        Division is the operation where the standard's correct rounding is most visible: x / y from a library that is 1 ulp off breaks reproducibility between machines.</p>`,
      real: `<p>Itanium had no divider at all: frcpa gave an approximation of 1/b from a table and the compiler emitted fma sequences like this one, scheduled to share the multiplier, with the final correction chosen for each precision (the
        sequences were proven correct by exhaustive case analysis of the remainder). Many GPUs do the same for fast division, trading the last ulp for throughput. Where the divider exists (most CPUs) it is a radix-4 or radix-16 SRT unit that shares hardware with the square root.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'After three steps x is within 4·10⁻¹¹ of 1/b, yet a·x is one ulp off for 27 % of the quotients. Why?',
      options: [
        'x is rounded to float32 and then the product is rounded again: two half-ulp errors, and the quotient\'s last bit sits right at that size',
        'Three steps are too few; a fourth makes a·x correct',
        'The 5 % seed error survives in the low bits',
        'fmadd.s rounds towards zero, which loses one ulp',
      ], answer: 0,
      why: ['', 'x is already the nearest float to 1/b (all but 16 in 100 000); a fourth step leaves 27 % of the quotients off, because the limit is the float format, not the iteration.', 'The error is squared each step: 5 % is gone after two, and by step three the residual is below the float\'s own spacing.', 'The fma rounds to nearest even like every other operation here (rm = dyn, RNE); the miss is the double rounding, not a bias.'],
      explain: 'x carries up to half an ulp of error (2⁻²⁴ relative) and q = a·x adds another rounding; a/b lies within that distance of a rounding boundary about a quarter of the time. Only the remainder r = a − b·q, computed exactly by the fma, can tell which side of the boundary the true quotient is on.',
    },
  },
  {
    title: 'What F buys',
    body: `
      <p>The same job without <span data-show="fpu">the FPU</span>: <strong>fmul</strong> on a plain RV32I core. "fmul without F" unpacks the exponents and the 24-bit significands, multiplies them with a
      24-step shift-and-add loop (RV32I has no multiply), normalizes the 48-bit product, rounds to nearest even from the guard and sticky bits (the rule of the rounding step, in a handful of instructions), and packs.
      For 0.1 × 0.7 it runs <strong>${SOFT_INSTRS} instructions</strong> (224 to 240 over random operands) and finishes with the identical bits that <code>fmul.s</code> gives in one. With <code>mul</code> and <code>mulhu</code> the loop
      becomes two instructions and the routine <strong>${SOFT_M_INSTRS}</strong> (29 to 37).</p>
      <p>It is not IEEE. It skips zeros, subnormals, infinities and NaNs, overflow and underflow, the flags and four of the five rounding modes; each costs branches, and a complete routine (libgcc's) is several times longer.
      The test pins what it does implement: 506 random and tie-heavy operand pairs, every one the correctly rounded product of <code>fpref</code>.</p>
      <p>The trade is area against cycles. The FPU CPU is ${grp(cpuNands(true))} NANDs against ${grp(cpuNands(false))} for the integer CPU (+${grp(cpuNands(true) - cpuNands(false))}: the FPU ${grp(stats(FPU32).nands)}, of which the multiplier is 14 900);
      one float multiply costs 1 cycle against ${SOFT_INSTRS}. But its clock is 313 NAND delays against 103, so in time the gain on this operation is ${SOFT_INSTRS} × ${PERIOD.int} / ${PERIOD.single} = <strong>${(SOFT_INSTRS * PERIOD.int / PERIOD.single).toFixed(0)} times</strong>.
      Mix it into a program and the break-even moves: if a share φ of the instructions are float multiplies, the soft core executes 1 + ${SOFT_INSTRS - 1}·φ times as many, and the two take equal time at
      φ = (313 / 103 − 1) / ${SOFT_INSTRS - 1} = <strong>0.88 %</strong>: about one multiply per 114 instructions. Below that, the small fast core wins and the ${grp(cpuNands(true) - cpuNands(false))} NANDs buy nothing.</p>
      <div class="try">Run "fmul without F": a2 (the soft product) and a3 (fmul.s) are 0x3D8F5C29 and a4, their difference, is 0. The CPU panel counts the instructions retired: 233 for the routine, 5 for the hardware multiply.</div>`,
    scene: () => cpuScene({ source: fsrc('softmul'), fpu: true, adder: 'ks', highlight: ['fpu'] }),
    tries: [(st) => { const a = xreg(st, 12), b = xreg(st, 13); return a !== null && a === b && b !== 0; }],
    more: {
      derive: `<p>With both significands in [2<sup>23</sup>, 2<sup>24</sup>) the product is in [2<sup>46</sup>, 2<sup>48</sup>): bit 47 set means the result is in [2, 4) and the exponent is ea + eb − 127 + 1; otherwise one left shift. The loop keeps the 48-bit product
        as a high word (the running sum, 25 bits) and a low word that starts as the multiplier: each step adds ma to the high word when the multiplier's low bit is 1 and shifts both words right one place, the low word taking the bit the high one lost.
        After 24 steps the multiplier is gone and the low word holds the product's low 24 bits in its top 24: bit 31 is the guard bit, the rest the sticky bits. Packing as (exponent &lt;&lt; 23) + significand lets a rounding carry
        (all ones plus one) ripple into the exponent for free; the hidden bit, still in the significand, adds the 1 to the exponent field that the bias subtraction left out (127 where a product in [2, 4) needs 126).</p>`,
      numbers: `<table class="mini"><tr><th></th><th>Instructions</th><th>Cycles (single-cycle)</th><th>Time (NAND delays)</th><th>Hardware added</th></tr>
        <tr><td>fmul.s, RV32IF</td><td>1</td><td>1</td><td>${PERIOD.single}</td><td>${grp(cpuNands(true) - cpuNands(false))} NANDs</td></tr>
        <tr><td>soft, RV32I (shift-and-add)</td><td>${SOFT_INSTRS}</td><td>${SOFT_INSTRS}</td><td>${grp(SOFT_INSTRS * PERIOD.int)}</td><td>none</td></tr>
        <tr><td>soft, with mul / mulhu</td><td>${SOFT_M_INSTRS}</td><td>${SOFT_M_INSTRS}</td><td>${grp(SOFT_M_INSTRS * PERIOD.int)} + a multiplier's period</td><td>a multiplier</td></tr></table>`,
      pitfall: `<p>Reading the 233 as the cost of float arithmetic. It is the cost of this partial routine on a core without a multiplier: with M it is seven times fewer, and an addition needs an alignment shifter and a normalizing loop instead.
        The fair comparison is a complete, flag-correct library routine on a core with M against an FPU that fits the area budget.</p>`,
      real: `<p>Small RISC-V cores (RV32IMC, Cortex-M0) ship without an FPU and link a soft-float library: a float multiply there costs tens of instructions, and energy follows the instruction count. A core with an FPU spends area, a longer period (or
        pipeline stages) and f registers to make every float operation one instruction, which is what numerical and graphics code needs. The choice is made per product: microcontrollers that mostly move integers do not pay for it.</p>`,
    },
    challenge: {
      kind: 'quiz', question: 'The integer core runs at a period of 103 NAND delays, the FPU core at 313. Float multiplies are 2 % of a program\'s instructions; the soft routine is 233 instructions. Which finishes first, per 100 original instructions?',
      options: [
        'The FPU core: 31 300 NAND delays against 58 100 for the soft routine',
        'The integer core: its clock is three times faster',
        'They tie: the routine\'s length cancels against the clock ratio',
        'The integer core: 98 + 2 = 100 instructions of 103 is 10 300',
      ], answer: 0,
      why: ['', 'The clock ratio is 3.0, but 2 multiplies become 466 instructions: 98 + 2 × 233 = 564 cycles × 103 = 58 100, against 100 × 313 = 31 300.', 'They tie only at 0.88 % multiplies; at 2 % the routine\'s extra instructions outweigh the clock.', 'That forgets the routine replaces each multiply by 233 instructions, not by one.'],
      explain: 'Soft: 98 + 2 × 233 = 564 cycles at 103 = 58 100. FPU core: 100 cycles at 313 = 31 300. The break-even is at 0.88 % multiplies, about one instruction in 114.',
    },
  },
];
