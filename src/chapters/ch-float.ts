import { groupDigits } from '../sim/numfmt';
import { FPU32, fpAdd, fpDiv, fpFma, fpMul, fpSqrt, fpToInt, fpUnpack, normRound, ROUND_DECIDE } from '../lib';
import { cpuState } from '../riscv/cosim';
import { F_PROGRAMS } from '../riscv/fprograms';
import { F16, F32, type FpFormat } from '../sim/fpref';
import { logicDepth, stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { formatSteps } from './float/formats';
import { cpuScene } from '../widgets/cpupanel';
import { floatExplorer, floatLine } from '../widgets/float';
import type { Chapter, Layers } from './types';
import { newtonSteps } from './float/newton';
import { errorSteps } from './float/error';

const E4M3 = { E: 4, M: 3 };
const F6: FpFormat = { E: 3, M: 2 };
const fsrc = (id: string) => F_PROGRAMS.find((p) => p.id === id)!.source;

// Numbers the prose quotes come from the circuits: the same generators at four formats.
const FORMATS: [string, FpFormat][] = [['6-bit (3 + 2)', F6], ['8-bit (4 + 3)', E4M3], ['float16 (5 + 10)', F16], ['float32 (8 + 23)', F32]];
/** The rounding decision as a specification: add one to the magnitude? (rm: 0 RNE, 1 RTZ, 2 RDN, 3 RUP, 4 RMM; checked against ROUND_DECIDE by the tour.) */
const roundUp = (rm: number, sign: number, lsb: number, g: number, s: number): boolean =>
  rm === 0 ? !!(g && (s || lsb)) : rm === 2 ? !!(sign && (g || s)) : rm === 3 ? !!(!sign && (g || s)) : rm === 4 ? !!g : false;
const u32cache = new Map<string, { n: number; d: number }>();
/** NANDs and depth of a float32 adder, multiplier or fma (flattened once, on first use). */
function u32(name: 'add' | 'mul' | 'fma'): { n: number; d: number } {
  let r = u32cache.get(name);
  if (!r) {
    const def = name === 'add' ? fpAdd(F32) : name === 'mul' ? fpMul(F32) : fpFma(F32);
    u32cache.set(name, (r = { n: nands(def), d: deep(def) }));
  }
  return r;
}
/** The bits of a float32 as 0x…, from the host's Math.fround. */
const hex32 = (x: number) => `0x${new Uint32Array(new Float32Array([x]).buffer)[0].toString(16).toUpperCase().padStart(8, '0')}`;
/** The running sums of ten additions of float32 0.1, each rounded to float32. */
function tenth(): number[] {
  const out: number[] = [];
  let s = 0;
  for (let i = 0; i < 10; i++) out.push((s = Math.fround(s + Math.fround(0.1))));
  return out;
}
/** Measured cycles (single-cycle → pipelined, tests/benchmarks) of the seven FP programs; times and gains follow from the two periods. */
const SC_PERIOD = 313, PIPE_PERIOD = 121;
const FP_RUNS: [string, number, number][] = [['0.1 ten times', 41, 67], ['dot product', 80, 137], ['fused multiply-add', 26, 42], ['Horner with fmadd', 23, 45], ['division and square root', 215, 257], ["Newton's √2", 170, 199], ['exception flags', 28, 76]];
const kt = (n: number) => `${(n / 1000).toFixed(1)} k`;
const perfTable = () => `<table><tr><th>program</th><th>cycles</th><th>time (NAND delays)</th><th>gain</th></tr>${FP_RUNS.map(([n, c1, c2]) => `<tr><td>${n === 'Horner with fmadd' ? `<span data-ahead="horner">${n} (a polynomial as nested multiply-adds)</span>` : n}</td><td>${c1} → ${c2}</td><td>${kt(c1 * SC_PERIOD)} → ${kt(c2 * PIPE_PERIOD)}</td><td>${((c1 * SC_PERIOD) / (c2 * PIPE_PERIOD)).toFixed(2)}×</td></tr>`).join('')}</table>`;
/** A count rounded to hundreds, as the prose says "about". */
const about = (n: number) => grp(Math.round(n / 100) * 100);
const bias = (f: FpFormat) => 2 ** (f.E - 1) - 1;
const minNormal = (f: FpFormat) => 2 ** (1 - bias(f));
const maxFinite = (f: FpFormat) => (2 - 2 ** -f.M) * 2 ** bias(f);
/** 1.18 × 10<sup>−38</sup> */
function sci(x: number): string {
  const [m, e] = x.toExponential(2).split('e');
  if (Math.abs(Number(e)) <= 3) return String(Number(x.toPrecision(3)));
  return Number(e) === 0 ? String(Number(m)) : `${Number(m)} × 10<sup>${e.replace('-', '−').replace('+', '')}</sup>`;
}
const grp = (n: number) => groupDigits(Math.round(n));
const nands = (d: ComponentDef) => stats(d).nands;
const deep = (d: ComponentDef) => logicDepth(d) ?? 0;
/** Layers built on first use: the cost tables flatten float32 units, which would slow the chapter's load. */
function lazy(make: () => Layers): Layers {
  let m: Layers | undefined;
  const get = () => (m ??= make());
  return new Proxy({} as Layers, {
    get: (_, k) => get()[k as keyof Layers],
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_, k) => ({ value: get()[k as keyof Layers], enumerable: true, configurable: true, writable: true }),
    has: (_, k) => k in get(),
  });
}
/** One row of a cost table: a unit generated at each format, NANDs (and NAND delays when it is combinational). */
const costRow = (name: string, make: (f: FpFormat) => ComponentDef, depth = true) =>
  `<tr><td>${name}</td>${FORMATS.map(([, f]) => { const d = make(f); return `<td>${grp(nands(d))}${depth ? ` / ${deep(d)}` : ''}</td>`; }).join('')}</tr>`;
const costTable = (rows: string, depth = true) => `<table class="mini"><tr><th>${depth ? 'NANDs / depth' : 'NANDs'}</th>${FORMATS.map(([n]) => `<th>${n}</th>`).join('')}</tr>${rows}</table>`;

export const chFloat: Chapter = {
  id: 'float', num: 24, title: 'Floating point', level: 'Arithmetic',
  blurb: 'IEEE 754 from the bits up: unpack, align, add or multiply, normalize, round in five modes with exception flags, and an FPU in the CPU.',
  goals: [
    'decode a float from its sign, biased exponent and fraction, subnormals, infinities and NaNs included',
    'round a result in any of the five RISC-V modes from its last kept bit, guard and sticky bits, and say which flags it raises',
    'trace an addition through align, add, normalize and round, say why a fused multiply-add rounds only once, and price the same units in f16, bf16, FP8 and f64',
    'weigh the single-cycle FPU against the pipelined one, and the FPU against Newton–Raphson division and soft-float, by period, cycles and NAND count',
    'measure a result\'s error in ulps, spot catastrophic cancellation, and say why Kahan summation stays at one rounding error while a plain loop grows with n',
  ],
  builds: ['muldiv', 'pipeline'],
  recap: {
    keep: [
      'A float is (−1)<sup>s</sup> × 1.f × 2<sup>e − bias</sup>, the leading 1 hidden. Exponent 0 holds zero and the subnormals, all ones ∞ and NaN. Every binade holds the same 2<sup>M</sup> values (2<sup>23</sup> in float32), so precision is relative. A NaN\'s top fraction bit is its quiet bit (0: signaling, NV when used); every NaN RISC-V computes is the canonical 0x7FC00000.',
      'Guard, round and sticky bits are enough to round exactly. RNE rounds up when G = 1 and (S = 1 or the last kept bit is 1); the five modes differ in that one decision, a 62-NAND block.',
      'RISC-V never traps on a float exception: NV, DZ, OF, UF and NX accumulate in fflags. UF needs a result that is tiny (judged after rounding) <em>and</em> inexact.',
      'float32: the adder is about 8200 NANDs and 181 deep, the multiplier 14 900 and 176, the fma 26 300 and 270, one rounding against 357 for fmul then fadd.',
      'In the single-cycle CPU the FPU triples the size and stretches the period from 103 to 313 NAND delays. Cut into E, M and X, the pipelined RV32IF runs at 121, is smaller (163 500 against 172 500 NANDs) and 1.3 to 2.2 times faster on six of the seven programs; the CSR-heavy one is 5 % slower.',
      'Cost follows the significand: the multiplier tree grows as M², so a bf16 multiplier (float32\'s exponent, 8-bit significand) costs 38 % of float32\'s NANDs and an FP8 one 14–16 %; float64\'s costs 3.2 times as much. The ML E4M3 is not IEEE: no infinities, max 448.',
      'Division without a divider: three Newton–Raphson steps on the fma (e = 1 − b·x, x += x·e) from an integer-subtract seed, then one Markstein correction, give the correctly rounded quotient in every normal-range case measured. Soft-float costs about 233 RV32I instructions per fmul.s.',
      'Error is measured in ulps (u = 2<sup>−24</sup> relative under RNE). Subtraction of nearby numbers is exact (Sterbenz) but exposes earlier rounding: catastrophic cancellation. A plain sum\'s error grows like n·u, pairwise like log n·u, Kahan\'s stays near 2u.',
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
        <p>An integer has a fixed step: a 32-bit one counts by 1 from −2³¹ to 2³¹ − 1, about ±2.1 × 10⁹. It cannot hold 0.5, and a quantity of 10⁻¹⁵ (a gate's
        capacitance in farads) or 10¹⁵ is either lost or out of range. Science, engineering and graphics want the opposite trade: a fixed number of
        significant digits at any scale. A floating-point number keeps a fixed number of significant bits and moves the binary point: float32 holds 24
        significant bits (about 7 decimal digits) from about 1.2 × 10⁻³⁸ to 3.4 × 10³⁸, in the same 32 bits as an integer. The price is paid in hardware:
        before adding two floats it must line up their points, and after every operation it must renormalize and round. That is what this chapter builds.</p>
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
        2<sup>32</sup> patterns.</p>
        <p>Why this layout and not a fixed point: a fixed-point word spends the same resolution everywhere, so it either covers a small range finely or a large range coarsely. A float spends
        its bits on a ratio: the exponent chooses a binade [2<sup>k</sup>, 2<sup>k+1</sup>), the fraction chooses one of 2<sup>M</sup> equally spaced values in it. Relative error is therefore
        bounded by 2<sup>−M</sup> over the whole range, from ${sci(minNormal(F32))} to ${sci(maxFinite(F32))} in float32, which is what scientific computation needs. The cost is that the spacing
        between neighbours grows with the magnitude, so addition is no longer exact and no longer associative.</p>`,
      widget: floatExplorer,
      more: {
        derive: `<p>For a normal number with stored exponent e and fraction f (M bits): value = (1 + f / 2<sup>M</sup>) · 2<sup>e − bias</sup>, with bias = 2<sup>E−1</sup> − 1. The gap to the next float is
          2<sup>e − bias − M</sup>, so the relative gap is between 2<sup>−M−1</sup> and 2<sup>−M</sup>: ${sci(2 ** -24)} to ${sci(2 ** -23)} in float32, about 7 decimal digits. Ordering as integers works because the
          exponent sits above the fraction and the bias keeps it non-negative: for positive floats, a larger pattern is a larger number. Negative floats are sign-magnitude, so they order
          backwards, and ±0 compare equal as floats but not as integers.</p>`,
        numbers: `<table class="mini"><tr><th>Format</th><th>Bias</th><th>Largest</th><th>Smallest normal</th><th>Smallest subnormal</th><th>Spacing at 1</th></tr>
          ${FORMATS.map(([n, f]) => `<tr><td>${n}</td><td>${2 ** (f.E - 1) - 1}</td><td>${sci(maxFinite(f))}</td><td>${sci(minNormal(f))}</td><td>${sci(minNormal(f) * 2 ** -f.M)}</td><td>${sci(2 ** -f.M)}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Testing floats for equality, or summing them and expecting the order not to matter. Both fail for the same reason: each operation rounds to the nearest neighbour. 0.1 above is stored as
          0.100000001490116…, and ten additions of it do not give exactly 1 (a later step of this chapter runs that sum on the CPU). Compare with a tolerance, and sum small values before large ones.</p>`,
        real: `<p>IEEE 754 float32 and float64 are universal in CPUs and GPUs. Machine-learning hardware pushes the other way: bfloat16 keeps float32's 8 exponent bits and cuts the fraction to 7, trading precision
          for range with a multiplier a small fraction of float32's; 8-bit formats with 4 or 5 exponent bits, like the one these circuits use, are in common use for inference.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'How many float32 values lie in [1, 2), and how many in [1024, 2048)?',
        options: ['2²³ and 2²³', '2²³ and 2¹³', 'Infinitely many in both', '2³² and 2²²'], answer: 0,
        why: ['', 'That mixes up count and spacing: the gap grows from 2⁻²³ to 2⁻¹³, but each binade still holds every 23-bit fraction once.', 'The reals in each interval are infinite; the floats are a finite set of 2³² patterns.', '2³² is every pattern of the format, all exponents and both signs. One binade fixes sign and exponent, leaving the 23 fraction bits.'],
        explain: 'Every binade holds exactly 2²³ values (all fraction patterns with one exponent). The spacing in [1024, 2048) is 1024 times larger: 2⁻¹³ instead of 2⁻²³. Precision is relative.',
      },
    },
    {
      title: 'Where the floats are',
      body: `<p>A 6-bit format shows what float32 hides by sheer size.</p>
        <p>Of its ${2 ** 6} patterns, ${2 * 2 ** F6.M} have the all-ones exponent: two infinities and ${2 * 2 ** F6.M - 2} NaNs. The remaining ${2 ** 6 - 2 * 2 ** F6.M} are zeros (two of them,
        +0 and −0), subnormals and normals, giving ${2 ** 6 - 2 * 2 ** F6.M - 1} distinct finite values. Look at how they sit on the line: the same number of values in every binade, so
        the gaps double each time the exponent goes up, and the smallest binade is the same width as the subnormals below it. Nothing special happens at the bottom: that is the point of
        gradual underflow. Without subnormals there would be a hole between zero and the smallest normal number, wider than the gap between that and its neighbour.</p>`,
      widget: floatLine,
      more: {
        derive: `<p>Normal binade e (stored exponent 1 … ${2 ** F6.E - 2}) covers [2<sup>e − ${bias(F6)}</sup>, 2<sup>e − ${bias(F6)} + 1</sup>) in steps of 2<sup>e − ${bias(F6)} − ${F6.M}</sup>. Subnormals (stored exponent 0) have no hidden bit and
          use the exponent of binade 1: steps of 2<sup>1 − ${bias(F6)} − ${F6.M}</sup> = ${sci(minNormal(F6) * 2 ** -F6.M)} from 0 up to the smallest normal, ${sci(minNormal(F6))}. Without them the first gap above zero would be
          ${sci(minNormal(F6))}, against ${sci(minNormal(F6) * 2 ** -F6.M)} between adjacent subnormals and ${sci(minNormal(F6) * 2 ** -F6.M)} between the first normal numbers: x − y = 0 would be possible with x ≠ y.</p>`,
        numbers: `<table class="mini"><tr><th>Binade</th><th>Range</th><th>Values</th><th>Spacing</th></tr>
          ${Array.from({ length: 2 ** F6.E - 2 }, (_, i) => i + 1).map((e) => `<tr><td>${e}</td><td>${sci(2 ** (e - bias(F6)))} … ${sci(2 ** (e - bias(F6) + 1))}</td><td>${2 ** F6.M}</td><td>${sci(2 ** (e - bias(F6) - F6.M))}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Assuming that a − b = 0 means a = b. That holds with subnormals and fails without them, and every flush-to-zero mode gives it up for speed: values below the smallest normal become 0, and
          a program that divides by a difference can then divide by zero. Look for the hole on the line: nothing lies between 0 and the first mark.</p>`,
        real: `<p>Hardware that flushes subnormals to zero (some GPUs, and x86 and Arm modes called FTZ and DAZ) does it because a subnormal result needs a normalization shift the fast path lacks: a slow microcode
          assist costing a hundred cycles or more on some CPUs. RISC-V requires gradual underflow in the base F extension.</p>`,
      },
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
        <p>Why a unit just for this: every later stage wants the same few facts about each operand, and computing them once keeps the others simple. The hidden bit is the OR of the exponent
        bits; zero, infinity and NaN are three comparisons of the exponent and fraction fields. A NaN is told apart as signaling by one more bit, the top of the fraction. Treating a subnormal as
        exponent 1 with no hidden bit makes its value follow the same formula as a normal number's, so the aligner and the multiplier need no special case for it.</p>
        <div class="try">0x5A = 0 1011 010 = +1.010₂ × 2^(11 − 7) = 20. Try 0x05 (a subnormal) and 0x78 (infinity).</div>`,
      scene: () => ({ root: fpUnpack(E4M3), inputs: { x: 0x5a } }),
      tries: [(st) => st.value('inf') === 1],
      tour: {
        beats: [
          { title: 'A normal number', show: ['u6', 'u1'], expect: { sign: 0, exp: 11, mant: 0b1010, zero: 0, inf: 0, nan: 0 },
            say: '<p>0x5A = 0 1011 010. The exponent field is {v:exp}, not zero, so the hidden bit is 1 and the significand is {b:mant} = 1.010₂ = 1.25. Value: 1.25 × 2<sup>11 − 7</sup> = 20.</p>' },
          { title: 'A subnormal', set: { x: 0x05 }, show: ['u6', 'u1'], expect: { exp: 1, mant: 0b0101, zero: 0, inf: 0, nan: 0 },
            say: '<p>0x05 has exponent field 0: the hidden bit is 0, the significand is {b:mant} = 0.101₂, and the exponent is forced to {v:exp}. It still follows value = significand × 2<sup>exp − 7</sup>.</p>' },
          { title: 'Infinity', set: { x: 0x78 }, expect: { exp: 15, mant: 0b1000, inf: 1, nan: 0 },
            say: '<p>0x78 has all-ones exponent and a zero fraction: inf = {v:inf}, nan = {v:nan}.</p>' },
          { title: 'Quiet NaN', set: { x: 0x7c }, expect: { nan: 1, snan: 0, inf: 0 },
            say: '<p>0x7C = 0 1111 100: all-ones exponent, non-zero fraction with the top bit set. nan = {v:nan} and snan = {v:snan}: quiet, so arithmetic passes it on without raising a flag. This is also the canonical NaN of the format.</p>' },
          { title: 'Signaling NaN', set: { x: 0x7a }, expect: { nan: 1, snan: 1 },
            say: '<p>0x7A = 0 1111 010: the same exponent, but the quiet bit is 0 and a lower fraction bit is set. snan = {v:snan}: an operation that consumes it raises the invalid flag.</p>' },
        ],
      },
      more: lazy(() => ({
        numbers: costTable(costRow('Unpack', fpUnpack)),
        derive: `<p>hidden = (exp ≠ 0), an OR tree over the ${E4M3.E} exponent bits. expAllOnes = AND of them. zero = ¬hidden AND (fraction = 0); inf = expAllOnes AND (fraction = 0);
          nan = expAllOnes AND (fraction ≠ 0); snan = nan AND ¬fraction[top]. The effective exponent is exp OR ¬hidden, which turns 0 into 1 for subnormals and zero without a multiplexer.</p>`,
        pitfall: `<p>Reading exponent 0 as "exponent −bias". The subnormal formula uses 1 − bias, and zero is just a subnormal with a zero fraction. Getting this wrong makes every subnormal come out a factor of
          2 too small, and shows up as an error only in the narrow band below the smallest normal number.</p>`,
        real: `<p>Production FPUs often keep numbers in an internal, wider recoded format (as in the Berkeley hardfloat library, 33 bits for float32) so that the unpack work is done once, at the register file, rather
          than in front of every operation.</p>`,
      })),
    },
    {
      title: 'Addition: align, add, normalize, round',
      body: `
        <p>To add, the exponents must match. <span data-show="u6">Compare the magnitudes</span> and <span data-show="u7">swap</span> so the bigger operand comes first.
        <span data-show="u22">Shift the smaller significand right</span> by the <span data-show="u14">exponent difference</span>: bits that fall off are not thrown away but ORed into a <strong>sticky bit</strong>.
        Then <span data-show="u27">add, or subtract</span> if the signs differ. Then <span data-show="u40">normalize</span>: a carry shifts the sum right one place; a cancellation leaves leading zeros, which are counted and shifted out.</p>
        <p>Three extra bits below the significand (<strong>guard</strong>, <strong>round</strong>, <strong>sticky</strong>) are provably enough to round the
        result exactly as if it had been computed with infinite precision.</p>
        <p>Why the steps come in this order. Adding is only meaningful at equal weights, so the exponents are matched first, and it is the smaller operand that moves right: shifting the larger left
        would grow the word, shifting the smaller right only loses bits at the bottom, and those are exactly the bits that matter least. The sum can then be off by a carry (one place right)
        or, when the signs differ, by massive cancellation (many places left), which is why the normalize shifter has to handle both directions. The dropped bits are never looked at again, only summarized:
        guard is the first, round the second, and sticky the OR of all the rest. Rounding needs to know if the dropped part is below, exactly at or above half, and these three bits say so.</p>
        <div class="try">a = 0x44 (3.0), b = 0x38 (1.0): 4.0 = 0x48. Then b = 0x01 (the smallest subnormal): too small to change a.</div>`,
      scene: () => ({ root: fpAdd(E4M3), inputs: { a: 0x44, b: 0x38, sub: 0 } }),
      tour: {
        beats: [
          { title: 'Align and add', show: ['u6', 'u7', 'u14', 'u22', 'u27'], expect: { y: 0x48, flags: 0 },
            say: '<p>3.0 (0x44) + 1.0 (0x38). The exponents differ by 1, so the smaller significand is shifted right one place and added: 1.1₂ + 0.1₂ = 10.0₂. The sum carries, normalization moves it back: y = {v:y} = 0x48 = 4.0, no flags.</p>' },
          { title: 'Cancellation', set: { sub: 1, a: 0x39, b: 0x38 }, show: ['u27', 'u40'], expect: { y: 0x20, flags: 0 },
            say: '<p>1.125 − 1.0: the subtraction leaves 0.001₂, three leading zeros. Normalize counts them and shifts the result left three places, lowering the exponent by 3: y = {v:y} = 0x20 = 0.125. The result is exact, flags {b:flags}: cancellation loses no bits, it only exposes the ones below.</p>' },
          { title: 'Absorbed', set: { sub: 0, a: 0x44, b: 0x01 }, show: ['u14', 'u22'], expect: { y: 0x44, flags: 1 },
            say: '<p>3.0 + the smallest subnormal. The difference of exponents is larger than the datapath is wide: b is shifted completely out, and only its sticky bit survives. y = {v:y} = 3.0 unchanged, with NX raised (flags = {b:flags}): the sum was not exact.</p>' },
          { title: 'x − x', set: { sub: 1, a: 0x44, b: 0x44 }, show: ['u27'], expect: { y: 0, flags: 0 },
            say: '<p>Subtracting a number from itself cancels everything. In round to nearest the sign of an exact zero sum is +, so y = {v:y} (0x00, not 0x80), and nothing is inexact.</p>' },
        ],
      },
      more: lazy(() => ({
        numbers: costTable(costRow('Adder', (f) => fpAdd(f))),
        derive: `<p>Let a ≥ b in magnitude, with exponents e<sub>a</sub> ≥ e<sub>b</sub> and significands of M + 1 bits. Shift b's right by d = e<sub>a</sub> − e<sub>b</sub>; bits beyond the M + 3 kept (guard, round,
          sticky) are ORed into sticky. For the sum, the result lies in [1, 4) and normalizes by at most one place right. For the difference with d ≥ 2 the result lies in (½, 2): at most one place left, so there
          the three extra bits suffice. For d ≤ 1 the cancellation can be total, but then the shifted-out part is at most one bit and the difference is exact. That is the argument for the three
          bits being exactly enough: no case needs more.</p>`,
        pitfall: `<p>Keeping only guard and round and dropping the sticky bit. Then 1.000|10 (an exact tie) and 1.000|10 followed by a non-zero bit far below (above the tie) look identical, and ties-to-even
          rounds both down. Everything shifted out must be summarized: on the circuit, add 3.0 and the smallest subnormal, and see that y is unchanged but NX is raised.</p>`,
        real: `<p>A fast adder runs two paths in parallel: a near path (exponents within 1, a small right shift but a long left shift for cancellation) and a far path (a long right shift, at most one place of
          normalization), and selects one. The datapath here is shared by both and so is simpler and slower. Denormalized inputs, flags and rounding modes are then bolted onto either.</p>`,
      })),
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
        <span data-show="u62">infinity</span>.</p>
        <p>Why ties go to even and not always up: rounding up every tie adds a small positive error each time, and in a long sum those errors accumulate in one direction. Rounding to the even neighbour
        takes the tie half the time down and half the time up, since the last bit of the neighbours alternates, so the errors cancel on average. The cost is the rule itself: the decision reads the last kept bit, the guard and the sticky bit, a few gates
        on the carry path of the incrementer.</p>`,
      scene: () => ({ root: normRound(E4M3, 8), inputs: { sign: 0, exp: 3, mant: 0b10011100, stin: 0, rm: 0 } }),
      tour: {
        beats: [
          { title: 'Above half', show: ['u45'], expect: { y: 0x1a, flags: 1 },
            say: '<p>The input is 1.001|1100: kept 001, then G = 1 and the rest non-zero. More than half a unit is dropped, so it rounds up to 010: y = {v:y} (0x1A) with NX.</p>' },
          { title: 'Below half', set: { mant: 0b10010100 }, show: ['u45'], expect: { y: 0x19, flags: 1 },
            say: '<p>1.001|0100: G = 0. Less than half is dropped and the kept bits stay: y = {v:y} (0x19), still inexact.</p>' },
          { title: 'A tie, last bit even', set: { mant: 0b10101000 }, show: ['u45'], expect: { y: 0x1a, flags: 1 },
            say: '<p>1.010|1000: exactly half (G = 1, S = 0). The kept bits end in 0, already even, so nothing is added: y = {v:y} (0x1A).</p>' },
          { title: 'A tie, last bit odd', set: { mant: 0b10111000 }, show: ['u45'], expect: { y: 0x1c, flags: 1 },
            say: '<p>1.011|1000: the same tie, but the kept bits end in 1. Rounding up gives the even neighbour 1.100: y = {v:y} (0x1C).</p>' },
          { title: 'The carry reaches the exponent', set: { mant: 0b11111100 }, show: ['u45', 'u57'], expect: { y: 0x20, flags: 1 },
            say: '<p>1.111|1100 rounds up to 10.000: the carry out of the fraction bumps the exponent and the fraction restarts at 0. y = {v:y} (0x20) is exactly 2<sup>exp</sup> with exponent field 4.</p>' },
        ],
      },
      more: lazy(() => ({
        numbers: costTable(costRow('Normalize and round (2M + 2 bits in)', (f) => normRound(f, 2 * f.M + 2))),
        derive: `<p>With the kept significand k (M + 1 bits), G the next bit and S the OR of the rest, the exact value lies between k and k + 1 ulp. Its position relative to the midpoint is read from G and S:
          below the midpoint: G = 0; exactly at it: G = 1, S = 0; above it: G = 1, S = 1. RNE rounds up if G · (S + lsb(k)) = 1. The incrementer produces k + 1; its carry out is
          the exponent bump. The rounding error is at most ½ ulp, so the relative error is at most 2<sup>−M−1</sup>, the unit roundoff u = 2<sup>−${E4M3.M + 1}</sup> = ${2 ** -(E4M3.M + 1)} here and 2<sup>−24</sup> in float32.</p>`,
        pitfall: `<p>Rounding twice. Rounding a value to a wider intermediate format and then to the final one can move a result that the single rounding would have put elsewhere (double rounding). The unit
          therefore keeps all the bits and rounds once; it is also why the fused multiply-add of a later step rounds only at its end.</p>`,
        real: `<p>Round to nearest even is the default of every IEEE 754 system and of RISC-V's frm register. Code that must match decimal rounding (money) uses decimal formats or integers instead: a binary
          tie is an exact binary half, and most decimal fractions, 0.1 and 0.05 among them, are not exactly representable, so they are never ties at all.</p>`,
      })),
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
      tour: {
        label: 'Walk me through the modes',
        beats: [
          { title: 'RNE: a tie, last bit odd', show: ['u6'], expect: { up: 1 },
            say: '<p>G = 1, S = 0 is an exact tie and the last kept bit is 1 (odd): round to nearest even goes up to the even neighbour. up = {v:up}.</p>' },
          { title: 'RNE: a tie, last bit even', set: { lsb: 0 }, show: ['u6'], expect: { up: 0 },
            say: '<p>The same tie with an even last bit: the truncated value already is the even neighbour, up = {v:up}.</p>' },
          { title: 'RMM: ties away', set: { rm: 4 }, show: ['u9'], expect: { up: 1 },
            say: '<p>Round to nearest, ties to max magnitude: any tie goes away from zero whatever the last bit says. up = {v:up}.</p>' },
          { title: 'RTZ: truncate', set: { rm: 1 }, expect: { up: 0 },
            say: '<p>Towards zero never increases the magnitude: up = {v:up} however large G and S are.</p>' },
          { title: 'RDN on a negative number', set: { rm: 2, sign: 1 }, show: ['u7'], expect: { up: 1 },
            say: '<p>Towards −∞ on a negative value moves away from zero, so the magnitude is increased as soon as anything is dropped: up = {v:up}.</p>' },
          { title: 'RUP on a negative number', set: { rm: 3 }, show: ['u8'], expect: { up: 0 },
            say: '<p>Towards +∞ on a negative value moves towards zero, which truncating the magnitude does: up = {v:up}.</p>' },
          { title: 'RUP on a positive number', set: { sign: 0 }, show: ['u8'], expect: { up: 1 },
            say: '<p>Positive again: the same mode now rounds the magnitude up whenever G or S is set, up = {v:up}.</p>' },
        ],
      },
      more: lazy(() => ({
        derive: `<p>The decision as a function of sign s, last kept bit l, guard g and sticky t (S): RNE = g · (t + l); RTZ = 0; RDN = s · (g + t); RUP = ¬s · (g + t); RMM = g. The five terms are selected by rm,
          and the whole block is ${nands(ROUND_DECIDE)} NANDs and ${deep(ROUND_DECIDE)} deep. Every directed mode depends on the sign because rounding acts on the magnitude: towards −∞ for a negative result
          lengthens the magnitude, and for a positive one shortens it.</p>`,
        numbers: `<table class="mini"><tr><th>Case (positive)</th><th>RNE</th><th>RTZ</th><th>RDN</th><th>RUP</th><th>RMM</th></tr>
          ${([['below half', 0, 1, 0], ['tie, even', 1, 0, 0], ['tie, odd', 1, 0, 1], ['above half', 1, 1, 0]] as [string, number, number, number][]).map(([n, g, s, l]) => `<tr><td>${n}</td>${[0, 1, 2, 3, 4].map((rm) => `<td>${roundUp(rm, 0, l, g, s) ? 'up' : 'down'}</td>`).join('')}</tr>`).join('')}</table>`,
        pitfall: `<p>Treating "up" as "towards +∞" for every sign. The block says whether to add one to the magnitude. For −2.5, RUP does not increase the magnitude (−2 is above −2.5) and RDN does (−3): the quiz below turns on
          exactly this. Reserved modes 5 and 6 are illegal in RISC-V; here they truncate.</p>`,
        real: `<p>Directed modes exist for interval arithmetic and for verifying numerical code: run once in RDN and once in RUP and the exact answer lies between. Most software never leaves RNE, and
          some FPUs implement the others only on the slow path. Stochastic rounding, used in low-precision machine learning, is not an IEEE mode: it rounds up with probability equal to the dropped fraction.</p>`,
      })),
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
        and overflow test made parallel (see the pipelined FPU at the end of the chapter), the multiplier's instance (48-bit significand) is 6120 NANDs and
        102 NAND delays deep.</p>
        <div class="try">exp = 0, mant = 1111 0000: 1.111 × 2<sup>−7</sup>. It rounds to 0x08 = 2<sup>−6</sup>, the smallest normal, yet flags = UF NX (0x03): with an unbounded exponent it is exact at 1.111 × 2<sup>−7</sup>, below 2<sup>−6</sup>. Now mant = 1111 1100: the same result, but only NX. In RTZ (rm = 1) the first stays subnormal, 0x07.</div>`,
      scene: () => ({ root: normRound(E4M3, 8), inputs: { sign: 0, exp: 0, mant: 0b11110000, stin: 0, rm: 0 } }),
      tour: {
        beats: [
          { title: 'Tiny and inexact', show: ['u60', 'u50', 'u80', 'u81'], expect: { y: 0x08, flags: 0b11 },
            say: '<p>1.111 × 2<sup>−7</sup> is below the smallest normal number. Rounding it gives y = {v:y} (0x08), exactly 2<sup>−6</sup>, the smallest normal, yet flags = {b:flags}: UF and NX. Tininess is judged as if the exponent were unbounded, where this result would still be below 2<sup>−6</sup>, and the rounding was inexact.</p>' },
          { title: 'Same result, one flag', set: { mant: 0b11111100 }, show: ['u60', 'u81'], expect: { y: 0x08, flags: 0b01 },
            say: '<p>With mant = 1111 1100 a little more is dropped: with an unbounded exponent the rounded value reaches 2<sup>−6</sup> itself, which is not tiny. The result is the same, y = {v:y}, but only NX is raised: flags = {b:flags}.</p>' },
          { title: 'Towards zero', set: { rm: 1, mant: 0b11110000 }, show: ['u60', 'u80'], expect: { y: 0x07, flags: 0b11 },
            say: '<p>In RTZ the first input is truncated and stays subnormal: y = {v:y} (0x07), UF and NX again. Tininess does not depend on the rounding direction here, because the unbounded result is still tiny.</p>' },
        ],
      },
      more: {
        derive: `<p>Five flags, each a few gates on signals the unit already has. NX = G or S (or overflow). Overflow = the rounded exponent exceeds the largest, and then the result is ∞ or the largest finite number depending on the mode.
          UF = tiny AND NX, where tiny uses a second rounding decision: round the result as though the exponent range were unbounded (one extra bit, R as the new guard, and the carry into 2<sup>emin</sup> is the question).
          NV and DZ are decided before the datapath, from the operand classes: ∞ − ∞, 0 × ∞, a signaling NaN, an out-of-range conversion, x / 0 with x finite and non-zero.</p>`,
        numbers: `<table class="mini"><tr><th>Flag</th><th>Bit</th><th>Raised when</th></tr>
          <tr><td>NX</td><td>0</td><td>the rounded result differs from the exact one</td></tr><tr><td>UF</td><td>1</td><td>tiny after rounding and inexact</td></tr>
          <tr><td>OF</td><td>2</td><td>the rounded exponent is past the largest</td></tr><tr><td>DZ</td><td>3</td><td>finite, non-zero ÷ 0</td></tr>
          <tr><td>NV</td><td>4</td><td>the result is not defined (∞ − ∞, 0 × ∞, 0 ÷ 0, signaling NaN, bad conversion)</td></tr></table>`,
        pitfall: `<p>Raising UF for every subnormal result. An exact subnormal (3 × 2<sup>−149</sup> in float32, say) is not an underflow, and raises nothing; only a tiny result that lost accuracy does. The challenge
          below turns on this: UF without NX is never raised.</p>`,
        real: `<p>Other architectures can trap on these exceptions; x86 can unmask them, RISC-V cannot. A program that wants a trap checks fflags after a region and branches. The cost of this choice is that
          a faulting operation in a long loop is found late; the gain is that the pipeline never has to take a precise exception out of the FPU.</p>`,
      },
    },
    {
      title: 'Multiplication',
      body: `
        <p>Multiplication is simpler than addition: no alignment. <span data-show="u2">The sign is an XOR</span>, <span data-show="u9 u12">the exponents add</span>
        (minus one bias), and the significands go through <span data-show="u3">a tree multiplier</span> from <a href="#/c/muldiv/0">chapter 21</a>. The product of two
        numbers in [1, 2) lies in [1, 4), so normalization moves it at most one place, unless subnormal inputs leave leading zeros, which
        <span data-show="u14">the shared unit</span> handles anyway. <span data-show="u17">∞ × 0 is NaN</span>.</p>
        <div class="try">a = b = 0x3A (1.25): 1.5625 = 1.1001₂ needs 4 fraction bits, an exact tie, so it rounds to the even neighbour 1.100₂ = 1.5 (0x3C). Then 0x46 (3.5) × 0x42 (2.5) = 8.75 = 1.00011₂ × 2³: above the tie, it rounds up to 9 (0x51).</div>`,
      scene: () => ({ root: fpMul(E4M3), inputs: { a: 0x3a, b: 0x3a } }),
      tour: {
        beats: [
          { title: 'A tie', show: ['u2', 'u9', 'u3'], expect: { y: 0x3c, flags: 1 },
            say: '<p>1.25 × 1.25 = 1.5625 = 1.1001₂ needs four fraction bits and the format keeps three. The dropped bit is exactly half: a tie, resolved to the even neighbour 1.100₂ = 1.5. y = {v:y} (0x3C) with NX.</p>' },
          { title: 'Above the tie', set: { a: 0x46, b: 0x42 }, show: ['u3', 'u14'], expect: { y: 0x51, flags: 1 },
            say: '<p>3.5 × 2.5 = 8.75 = 1.00011₂ × 2³. The dropped part is above half, so the product rounds up to 1.001₂ × 2³ = 9: y = {v:y} (0x51).</p>' },
          { title: 'Infinity times zero', set: { a: 0x78, b: 0x00 }, show: ['u17'], expect: { y: 0x7c, flags: 0x10 },
            say: '<p>∞ × 0 has no defined value. The unit returns the canonical NaN, y = {v:y} (0x7C), and raises NV (flags = {b:flags}), even though both operands are quiet.</p>' },
        ],
      },
      more: lazy(() => ({
        numbers: costTable(costRow('Multiplier', (f) => fpMul(f))),
        derive: `<p>Product of 1.f<sub>a</sub> × 1.f<sub>b</sub> with M + 1 bit significands: 2M + 2 bits, in [1, 4). One normalization step: if the top bit is set, shift right one and add 1 to the exponent. Result exponent = e<sub>a</sub> + e<sub>b</sub> − bias
          (+1 on that shift). Everything below the M + 2 top bits becomes guard and sticky for the shared rounder. The cost is the significand multiplier: (M + 1)² partial-product bits, so it grows with the square of the
          precision, ${grp(nands(fpMul(F16)))} NANDs for float16 and ${grp(nands(fpMul(F32)))} for float32 (${(nands(fpMul(F32)) / nands(fpMul(F16))).toFixed(1)} times for 2.3 times the fraction width), against an adder that grows nearly linearly.</p>`,
        pitfall: `<p>Forgetting that the bias is subtracted once. Adding two biased exponents counts the bias twice: e<sub>a</sub> + e<sub>b</sub> − 7 here. On the circuit, 1.0 × 1.0 = 1.0 only because 7 + 7 − 7 = 7.</p>`,
        real: `<p>Hardware multipliers use Booth recoding and a Wallace or Dadda tree, as chapter 21 builds; the product is kept in carry-save form until the last moment, and the rounder works on it before the final carry-propagate
          add. Subnormal inputs need a leading-zero count in front of the multiplier or after it: this design does it after, in the shared normalizer.</p>`,
      })),
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
        <p>The float32 → int32 converter costs 3450 NANDs and is 104 deep: <span data-show="u0">an aligning box</span> (a 33-bit sticky shifter) and <span data-show="u1">a rounding box</span> (a prefix
        incrementer, the range check, a negator), which the pipelined FPU puts in two stages.</p>
        <div class="try">a = 0x42 is 2.5 (0 1000 010), into an 8-bit integer: y = 2 in RNE. Try rm = 3 (RUP) and rm = 4 (RMM). Then 0x7F (NaN): 127 and NV.</div>`,
      scene: () => ({ root: fpToInt(E4M3, 8), inputs: { a: 0x42, signed: 1, rm: 0 } }),
      tour: {
        beats: [
          { title: 'A tie in RNE', show: ['u0', 'u1'], expect: { y: 2, flags: 1 },
            say: '<p>0x42 is 2.5. It is aligned to integer weights, leaving 2 with G = 1 and S = 0, a tie. RNE picks the even neighbour: y = {v:y}, and NX records that something was dropped.</p>' },
          { title: 'Towards +∞', set: { rm: 3 }, show: ['u1'], expect: { y: 3, flags: 1 },
            say: '<p>The same bits in RUP: any dropped part rounds the magnitude of a positive number up, y = {v:y}.</p>' },
          { title: 'Ties away', set: { rm: 4 }, show: ['u1'], expect: { y: 3, flags: 1 },
            say: '<p>RMM sends every tie away from zero: y = {v:y} again, for a different reason.</p>' },
          { title: 'NaN saturates', set: { a: 0x7f, rm: 0 }, show: ['u1'], expect: { y: 127, flags: 0x10 },
            say: '<p>0x7F is a NaN. There is no integer for it: the result saturates to the largest signed value, y = {v:y}, and NV is raised (flags = {b:flags}).</p>' },
          { title: 'Out of range', set: { a: 0xf7 }, show: ['u1'], expect: { y: 0x80, flags: 0x10 },
            say: '<p>0xF7 is −240, below the signed 8-bit range. It saturates to the bottom of the range, y = {v:y} = −128, again with NV.</p>' },
        ],
      },
      more: lazy(() => ({
        numbers: costTable(costRow('float → int32', (f) => fpToInt(f, 32))),
        derive: `<p>The shift amount is (w − 1 + bias) − e: the exponent says where the binary point of the significand sits, and the converter slides it to the integer's. A value with e − bias ≥ w − 1 is out of range
          before any rounding, except exactly −2<sup>w−1</sup> in signed mode. If e − bias &lt; −1 the value is below ½ and only the sticky bit survives. The range check comes after rounding, since rounding can carry across a limit:
          2<sup>w−1</sup> − 0.3 rounds to 2<sup>w−1</sup>, which does not fit.</p>`,
        pitfall: `<p>Checking the range before rounding. Both 127.4 and 127.6 lie below 128, but the first rounds to 127 and fits the signed 8-bit range, the second rounds to 128 and does not. And a negative value converted to unsigned: −0.3 gives 0 with only NX, −0.7 rounds to −1 and gives 0 with NV,
          because the check is on the rounded integer.</p>`,
        real: `<p>C's cast from float to int truncates, which in RISC-V is fcvt.w.s with rm = RTZ; the saturating results are RISC-V's choice, where x86 returns a single "integer indefinite" value (0x80000000) for every invalid case.
          The difference matters when porting numerical code.</p>`,
      })),
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
      get body() { return `
        <p>Division has no shortcut like the multiplier's tree: each quotient bit depends on the remainder left by the previous one. So the FPU
        reuses the integer divider of <a href="#/c/muldiv/0">chapter 21</a>: <strong>radix-2 restoring division</strong>, one step per clock. Both significands are first
        <span data-show="u3 u4"><em>prenormalized</em></span> (a subnormal's leading zeros shifted out, the exponent lowered), so they lie in [1, 2) and the quotient in (½, 2).
        <span data-show="u11">The step</span> tries remainder − divisor; if it does not borrow, the quotient bit is 1 and the difference is kept, otherwise the remainder is
        restored (<span data-show="u13">a multiplexer</span>). M + 4 steps give the M + 1 kept bits, G and one more bit (for tininess) even when the quotient is below 1; the final
        remainder ≠ 0 is the sticky bit, and <span data-show="u23">the shared normalize &amp; round</span> does the rest, in any mode. Exponent: e<sub>a</sub> − e<sub>b</sub> + bias.
        <span data-show="u30">x / 0</span> is ∞ with <strong>DZ</strong>; 0 / 0 and ∞ / ∞ are NaN with NV.</p>
        <p>float32: ${F32.M + 4} steps, <strong>${F32.M + 6} cycles</strong>, ${about(nands(fpDiv(F32)))} NANDs (4500 of them normalize &amp; round, 2300 the two prenormalizers); the step
        loop is 58 NAND delays.</p>
        <p>Why a loop and not a tree: the multiplier could be flattened into a tree because every partial product is known at once. In a division each quotient bit decides what the next subtraction is, so the
        bits cannot be found in parallel without guessing. The divider trades time for area: one subtractor reused for ${F32.M + 4} clocks costs a small fraction of the multiplier's tree, which is why a divide is an order of magnitude
        slower than a multiply on every FPU.</p>
        <div class="try">1.0 / 3.0 in the 8-bit format: start = 1. Pulse the clock 8 times: q fills from the right, then done = 1 and y = 0x2B (1.011₂ × 2<sup>−2</sup> = 0.34375, rounded up: NX). Try b = 0 (1 / 0 = ∞, DZ).</div>`; },
      scene: () => ({ root: fpDiv(E4M3), inputs: { a: 0x38, b: 0x44, rm: 0, start: 1, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Start', cycles: 1, show: ['u3', 'u4'], expect: { busy: 1, done: 0 },
            say: '<p>With start = 1 the first edge loads the dividend 1.0 and the divisor 3.0, both prenormalized into [1, 2). busy = {v:busy}, done = {v:done}.</p>' },
          { title: 'One bit a clock', cycles: 3, show: ['u11', 'u13'], expect: { busy: 1, done: 0 },
            say: '<p>Each edge tries remainder − divisor: if it does not borrow the quotient bit is 1 and the difference is kept, otherwise the remainder is restored through the multiplexer. Four edges so far; the output is not valid until done rises.</p>' },
          { title: 'Done', cycles: 4, show: ['u23'], expect: { done: 1, y: 0x2b, flags: 1 },
            say: `<p>After ${E4M3.M + 5} edges the ${E4M3.M + 4} quotient bits are in, the last remainder is non-zero (the sticky bit) and the shared rounder presents the result: done = {v:done}, y = {v:y} (0x2B), 1.011₂ × 2<sup>−2</sup> = 0.34375 with NX. 1/3 is never exact in binary.</p>` },
        ],
      },
      more: lazy(() => ({
        numbers: `<table class="mini"><tr><th>Format</th><th>Quotient steps (M + 4)</th><th>Cycles (M + 6)</th><th>NANDs, divider</th></tr>
          ${FORMATS.map(([n, f]) => `<tr><td>${n}</td><td>${f.M + 4}</td><td>${f.M + 6}</td><td>${grp(nands(fpDiv(f)))}</td></tr>`).join('')}</table>`,
        derive: `<p>The significands a, b ∈ [1, 2) give a quotient in (½, 2): if a &lt; b the top quotient bit is 0 and the result needs one normalization step left. The M + 1 kept bits, a guard bit and one more for the
          tininess test make M + 4 bits when the quotient is below 1. Each step is one subtraction: r<sub>i+1</sub> = 2r<sub>i</sub> − q<sub>i</sub> b with q<sub>i</sub> = 1 if 2r<sub>i</sub> ≥ b. The final remainder is the exact
          error of the quotient, so r ≠ 0 is the sticky bit with no extra work.</p>`,
        pitfall: `<p>Sampling y before done. While busy the output pins show the rounder's view of a partial quotient, with flags that come and go (the tour passes through that state). Only done = 1 says the value is final, which is the
          reason the CPU stalls until then and gates the flag update with retire.</p>`,
        real: `<p>Why restoring here: it is the integer step unchanged, and a mux is cheap. Chapter 21 built the alternatives. <a href="#/c/muldiv/16">Non-restoring division</a> drops the mux (add or subtract by the previous sign)
          but needs a correction step before the remainder can serve as a sticky bit. <a href="#/c/muldiv/17">SRT</a> keeps the remainder in carry-save form, so no carry chain sits in the loop, and
          <a href="#/c/muldiv/19">radix 4</a> makes two quotient bits a clock, at the price of a digit-selection table; real FPUs use radix-4 (or higher) SRT, shared with square root. Here the 58-delay step already
          fits well inside the CPU's clock (313 NAND delays single-cycle, 121 pipelined), so a shorter step buys nothing; fewer steps would: radix 4 would roughly halve the ${F32.M + 6} cycles.</p>
          <p>Newton–Raphson in the multiplier is the alternative where a multiplier is cheap: it doubles the correct bits each iteration but needs a correction step to be correctly rounded.</p>`,
      })),
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
        always agree. float32: 26 steps, <strong>28 cycles</strong>, 9200 NANDs. Real FPUs share one SRT unit between division and square root;
        here they are two transparent boxes.</p>
        <div class="try">a = 0x40 (2.0): pulse the clock 7 times. y = 0x3B (1.011₂ = 1.375, with NX): √2 = 1.0110101…₂ rounds down. Try rm = 3 (RUP): 0x3C.</div>`,
      scene: () => ({ root: fpSqrt(E4M3), inputs: { a: 0x40, rm: 0, start: 1, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Load', cycles: 1, show: ['u4'], expect: { busy: 1, done: 0 },
            say: '<p>2.0 = 1.0 × 2<sup>1</sup>: the exponent is odd, so the significand is doubled to make it even, 2.0 × 2<sup>0</sup>, a radicand in [1, 4). busy = {v:busy}.</p>' },
          { title: 'Two bits a clock', cycles: 3, show: ['u13'], expect: { busy: 1, done: 0 },
            say: '<p>Each edge brings down two more radicand bits (r ← 4r + next two) and tries to subtract 4q + 1. If it fits the next root bit is 1. Four edges in, the root has four bits.</p>' },
          { title: 'Done', cycles: 3, show: ['u25'], expect: { done: 1, y: 0x3b, flags: 1 },
            say: '<p>Seven edges, M + 4: done = {v:done}, y = {v:y} (0x3B) = 1.011₂ = 1.375 with NX. √2 = 1.0110101…₂, and the part after the third fraction bit is below half: round down.</p>' },
        ],
      },
      more: lazy(() => ({
        numbers: `<table class="mini"><tr><th>Format</th><th>Root steps (M + 3)</th><th>Cycles (M + 5)</th><th>NANDs, square root</th></tr>
          ${FORMATS.map(([n, f]) => `<tr><td>${n}</td><td>${f.M + 3}</td><td>${f.M + 5}</td><td>${grp(nands(fpSqrt(f)))}</td></tr>`).join('')}</table>`,
        derive: `<p>Suppose q is the partial root after k bits and r the remainder x − q². The next bit is 1 if (q + 2<sup>−k−1</sup>)² ≤ x, that is if r ≥ 2<sup>−k</sup> q + 2<sup>−2k−2</sup>. Scaled by 4<sup>k+1</sup> this
          reads 4r ≥ 4q + 1 on integers, which is the trial subtraction of the step. No multiplication appears: (2q + 1)² − (2q)² = 4q + 1, so the root is built from additions alone, like division. The exponent is halved after
          making it even; a root cannot overflow or underflow.</p>`,
        pitfall: `<p>Forgetting the odd exponent. √(1.0 × 2<sup>1</sup>) is not 2<sup>½</sup> times the root of the significand: it is the root of 2.0 × 2<sup>0</sup>. Try 0x40 against 0x38 on the circuit: the first needs the doubling, the second (1.0)
          does not, and their roots differ by √2.</p>`,
        real: `<p>FPUs commonly share one SRT unit between division and square root, since both are digit recurrences on the same datapath. Reciprocal square root estimates (one lookup plus a couple of Newton steps) are what graphics and
          machine-learning code uses, since correct rounding is not worth the cycles there.</p>`,
      })),
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
      get body() { return `
        <p>fmadd.s computes a × b + c and rounds <em>once</em>. Keep the product exact: <span data-show="u0">the 24 × 24 tree</span> gives all 48 bits. Widen c to the same 48 bits,
        take the operand with the larger exponent as the base, shift the other right with guard and sticky bits, <span data-show="u1">add or subtract</span> (a difference can come
        out negative when the exponents are within 3 of each other; it is then exact and is negated), and send the 52-bit result to
        <span data-show="u3">the same normalize &amp; round</span>. fmsub, fnmsub and fnmadd only flip the signs of c and the product. ∞ × 0 is invalid even when c is a quiet NaN, as RISC-V requires.</p>
        <p>One rounding makes x·x − p exact where fmul then fsub gives 0, and makes dot products, polynomial evaluation and Newton steps
        both faster and more accurate. float32 fma: ${about(u32('fma').n)} NANDs, ${u32('fma').d} deep: deeper than either multiplier (${u32('mul').d}) or adder (${u32('add').d}), but shallower than
        the two in a row (${u32('mul').d + u32('add').d}). It is built as three boxes, multiply (92 deep), align and add (91), round (106: the 52-bit normalize &amp; round, ${deep(normRound(F32, 52))}, then the NaN and ∞
        cases): the stages of the pipelined FPU. The price of fusing is area, ${(u32('fma').n / (u32('mul').n + u32('add').n)).toFixed(2)} times a separate multiplier and adder, since the adder must be as wide as the exact product.
        A production FMA shifts the addend in a 3M + 5-bit window <em>while</em> the tree multiplies; this one swaps like the adder, which is
        simpler but puts the shifter after the tree.</p>
        <div class="try">x = 0x39 (1.125): x² = 1.265625 = 1.010001₂ needs 6 fraction bits. fmul gives 1.010₂ = 1.25 (0x3A). Here c = 0x3A with negC = 1: fma(x, x, −1.25) = 2<sup>−6</sup> = 0x08, exactly, no flags; fmul then fsub would give 0.</div>`; },
      scene: () => ({ root: fpFma(E4M3), inputs: { a: 0x39, b: 0x39, c: 0x3a, negProd: 0, negC: 1, rm: 0 } }),
      tour: {
        beats: [
          { title: 'The exact product', show: ['u0'], expect: { y: 0x08, flags: 0 },
            say: '<p>x = 1.125. The tree computes x² = 1.265625 = 1.010001₂ in full, six fraction bits, without rounding. c = 1.25 is subtracted (negC = 1) from that exact product: 1.265625 − 1.25 = 0.015625 = 2<sup>−6</sup>. y = {v:y} (0x08) is exactly that, with flags = {b:flags}.</p>' },
          { title: 'What fmul then fsub would do', show: ['u0'],
            say: '<p>If the product were rounded first, to three fraction bits, it would become 1.25 = 1.010₂, and subtracting c = 1.25 would give exactly 0. The 2<sup>−6</sup> is the rounding error of the product, which the fused unit never throws away.</p>' },
          { title: 'Adding instead', set: { negC: 0 }, show: ['u1', 'u3'], expect: { y: 0x42, flags: 1 },
            say: '<p>With negC = 0 the sum is 1.265625 + 1.25 = 2.515625 = 10.100001₂. It is rounded once, to three fraction bits: 2.5, y = {v:y} (0x42), with NX.</p>' },
        ],
      },
      more: lazy(() => ({
        numbers: costTable(costRow('Fused multiply-add', (f) => fpFma(f))),
        derive: `<p>Let P = a·b be exact, 2M + 2 significand bits, and c widened to the same weight. The unit aligns by the exponent difference (d = e<sub>p</sub> − e<sub>c</sub>): the operand with the smaller exponent shifts right, with guard and sticky.
          Two roundings (fmul then fadd) each contribute an error of at most u = 2<sup>−M−1</sup> relative: |ε<sub>1</sub>| + |ε<sub>2</sub>| up to 2u. The fma has one: ≤ u. The deeper reason it
          matters is cancellation, where c ≈ −P: the result then consists of the low bits of P, which a rounded product has already lost, so even the sign of the answer can be wrong without fusing.
          Cost in float32: ${grp(nands(fpFma(F32)))} NANDs against ${grp(nands(fpMul(F32)) + nands(fpAdd(F32)))} for a separate multiplier and adder, and ${deep(fpFma(F32))} NAND delays against ${deep(fpMul(F32)) + deep(fpAdd(F32))} for the two in a row.</p>`,
        pitfall: `<p>Expecting an fma to give the same bits as a * b + c compiled to two instructions. It will not: results differ in the last place, and a compiler that contracts them (fp-contract) changes
          what a program prints. Reproducible numerics means choosing either, everywhere.</p>`,
        real: `<p>Every modern core has an fma unit and uses it for multiply and add alike (a multiply is a × b + 0, an add a × 1 + c). It is what makes dot products, polynomial evaluation and Newton iterations
          both faster and more accurate, and the basis of the linear-algebra libraries' peak-FLOPS figures: two floating-point operations in one instruction.</p>`,
      })),
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
      get body() { return `
        <p>Generated from the same code with 8 exponent and 23 fraction bits. The float32 adder costs about <strong>${about(u32('add').n)} NANDs</strong> and is
        ${u32('add').d} NAND delays deep. The multiplier costs about <strong>${about(u32('mul').n)}</strong> (mostly its 24 × 24 tree) and is ${u32('mul').d} deep.</p>
        <p>What changes with the format is how the cost grows. The adder's shifters and incrementers grow with the width times the logarithm of it; the multiplier's tree with the square of the significand
        width; the exponent logic hardly at all. Going from the 8-bit format to float32 multiplies the adder by ${(u32('add').n / nands(fpAdd(E4M3))).toFixed(0)} and the multiplier by ${(u32('mul').n / nands(fpMul(E4M3))).toFixed(0)}, for 7.7 times
        the fraction bits. Nothing in the design is specific to the small format: the same generator builds each, which is why the small ones can stand in for it in tests and in the drawings.</p>
        <p>The small formats are tested in every rounding mode, flags included, against exact rational arithmetic, simulated 32 cases at a time. The 6-bit
        format (3 exponent bits, 2 fraction bits) is exhaustive: every operand pair for add, subtract, multiply and divide, every triple and sign variant
        for the fma (one rounding mode per case, rotating). The 8-bit formats are sampled: every special or boundary operand (zeros, subnormals, the smallest and largest normals, infinities,
        NaNs) against every operand, plus 3000 random pairs; the fma on random triples biased towards cancellation. Square root and the conversions
        see every 8-bit input. Well over a million cases in all; every pair of the 8-bit formats is a switch for a long run by hand, not part of the
        regular test suite. float32 is tested on random and special operands (subnormals, infinities, NaNs, cancellation), and against the host CPU in
        round to nearest even.</p>
        <div class="try">1.5 (0x3FC00000) + 2.25 (0x40100000) = 3.75 (0x40700000). Follow <span data-show="u22 u27">the significands</span> through the aligner and the adder.</div>`; },
      scene: () => ({ root: fpAdd(F32), inputs: { a: 0x3fc00000, b: 0x40100000, sub: 0 } }),
      more: lazy(() => ({
        numbers: costTable(
          costRow('Unpack', fpUnpack) + costRow('Adder', (f) => fpAdd(f)) + costRow('Multiplier', (f) => fpMul(f)) + costRow('Fused multiply-add', (f) => fpFma(f)) + costRow('float → int32', (f) => fpToInt(f, 32)) +
          costRow('Divider (sequential)', (f) => fpDiv(f), false) + costRow('Square root (sequential)', (f) => fpSqrt(f), false),
        ),
        derive: `<p>Why the cost splits as it does. A right shifter by up to w positions is w·log<sub>2</sub> w multiplexers; the adder needs one to align and one to normalize, plus an incrementer for rounding, so it grows like w log w with
          a small constant. A w × w multiplier has w² partial-product bits compressed by a tree of about w² full adders. From 8-bit (significand ${E4M3.M + 1} bits) to float32 (${F32.M + 1} bits): the width ratio is
          ${((F32.M + 1) / (E4M3.M + 1)).toFixed(1)}, the multiplier's expected cost ratio the square of it, ${(((F32.M + 1) / (E4M3.M + 1)) ** 2).toFixed(0)}, against ${(u32('mul').n / nands(fpMul(E4M3))).toFixed(0)} measured (the exponent logic and the rounder do not grow with the square).</p>`,
        pitfall: `<p>Reading the cost of the small format as the cost of the real one. A circuit that fits on the screen at 8 bits is a very different object at float32: ${about(u32('fma').n)} NANDs in the fma alone. Count first, then draw the
          conclusion: the 6-bit exhaustive tests prove the design, the float32 numbers say what it costs.</p>`,
        real: `<p>A synthesis tool trades area for speed: the same adder can be made smaller if it is given more time, or faster with duplicated shifters. These counts are one point on that curve, a straightforward design built only
          from NANDs. GPUs spend their area on thousands of fma units, with the register files that feed them costing as much as the arithmetic.</p>`,
      })),
    },
    ...formatSteps,
    {
      title: 'An FPU in the CPU',
      body: `
        <p>The single-cycle CPU gains <span data-show="frf">a second register file</span> (f0–f31, no hard-wired zero, three read ports) and
        <span data-show="fpu">an FPU</span> implementing all of RV32F:
        flw, fsw, fadd.s, fsub.s, fmul.s, the four fused multiply-adds, fdiv.s and fsqrt.s (iterative: they stall the CPU, see below), sign injection
        (fsgnj.s, fsgnjn.s, fsgnjx.s, behind the pseudo-instructions fmv.s, fneg.s and fabs.s), fmin/fmax.s, feq/flt/fle.s, fcvt.w[u].s, fcvt.s.w[u], fmv.x.w, fmv.w.x and fclass.s, in all five rounding modes, with
        the exception flags. flw and fsw reuse the integer load/store path, disguised as lw and sw. The opcode or funct7 selects one of <span data-show="fpu.u61">the units'
        results</span>; the FPU is 85 200 NANDs. The f registers are 32 bits wide because there is no D. A core with doubles has 64-bit f registers
        and keeps a single <em>NaN-boxed</em>, its upper 32 bits all ones: read as a double it is a NaN, and a single whose upper half is not all ones
        reads as the canonical NaN.</p>
        <p>The cost: about 172 500 NANDs (3 times the integer CPU), and a clock period of <strong>313</strong> NAND delays instead of 103, set by
        the fused multiply-add. A float operation in one cycle makes every instruction slow. Real cores pipeline the FPU over 3 to 5 cycles.</p>
        <div class="try">Run "0.1 ten times": the sum is 0x3F800001, one ulp above 1.0, and feq.s says 0.</div>`,
      scene: () => cpuScene({ source: fsrc('tenth'), fpu: true, adder: 'ks', timing: true, highlight: ['fpu', 'frf'] }),
      more: lazy(() => ({
        derive: `<p>Float32 0.1 is ${hex32(0.1)} = ${Math.fround(0.1).toPrecision(12)}…, a little above 0.1. Adding it ten times in float32, rounding after each addition, gives the partial sums
          ${tenth().map((x) => Math.fround(x).toPrecision(8)).join(', ')}, and the last is ${hex32(tenth()[9])}: ${Math.fround(tenth()[9]).toPrecision(10)}, one unit in the last place above 1.0. The
          error of each step is at most half an ulp of the running sum, and the ulp grows as the sum does, so the errors do not cancel.</p>`,
        numbers: `<table class="mini"><tr><th>Part</th><th>NANDs</th></tr><tr><td>FPU (all of RV32F)</td><td>${grp(nands(FPU32))}</td></tr><tr><td>adder</td><td>${grp(u32('add').n)}</td></tr>
          <tr><td>multiplier</td><td>${grp(u32('mul').n)}</td></tr><tr><td>fused multiply-add</td><td>${grp(u32('fma').n)}</td></tr></table>`,
        pitfall: `<p>Comparing a float sum with feq.s against the number it should be. After ten additions of 0.1 the program's a1 holds ${hex32(tenth()[9])}, not 0x3F800000, and the comparison is false. A test for "close enough" uses a tolerance
          relative to the operands, not an exact comparison.</p>`,
        real: `<p>Cores pipeline the FPU: an add or multiply takes 3 to 5 cycles, issued one a cycle, and the fused multiply-add is the same unit, so a dependent chain runs at one operation per latency. The last step of this chapter
          builds the pipelined version and measures what the chain costs. Cores with double precision keep 64-bit f registers; a single there is NaN-boxed, its upper 32 bits all ones.</p>`,
      })),
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
        <p><span data-show="fpu.u11">fmin.s / fmax.s</span> follow IEEE 754-2019 (minimumNumber): a NaN operand is ignored, −0 &lt; +0, NV only for a signaling NaN (1994 NANDs,
        comparator included). <span data-show="fpu.u14">fclass.s</span> returns one of ten bits (147 NANDs). feq.s is a quiet comparison; flt.s and fle.s raise NV on any NaN.</p>
        <div class="try">Run "Exception flags": a0…a4 hold the flags after ∞ − ∞, an overflow in RNE and in RTZ, an exact subnormal (no flag at all) and an inexact one.
        The panel shows fcsr beside the f registers, and checks it against the instruction-set simulator after every instruction. Then try "Rounding modes" and "fmin, fmax, fclass".</div>`,
      scene: () => cpuScene({ source: fsrc('flags'), fpu: true, adder: 'ks', highlight: ['fcsr'] }),
      more: {
        derive: `<p>fcsr is eight bits: frm in bits 7:5, fflags in 4:0. The write rule for fflags is flags ← (flags OR new) AND ¬clear, evaluated on the clock edge of a retiring instruction: an OP-FP instruction ORs in the flags its unit
          produced; a CSR write sets or clears bits as the csrrw, csrrs or csrrc operation says. frm is only changed by CSR writes. The three CSR numbers are windows on the same register: 0x001 is fflags alone, 0x002 frm alone, 0x003 the
          whole fcsr, so a program can read frm and clear the flags without disturbing either.</p>`,
        numbers: `<table class="mini"><tr><th>CSR</th><th>Number</th><th>Bits</th><th>Pseudo-instructions</th></tr><tr><td>fflags</td><td>0x001</td><td>4:0 (NV DZ OF UF NX)</td><td>frflags, fsflags</td></tr>
          <tr><td>frm</td><td>0x002</td><td>2:0</td><td>frrm, fsrm, fsrmi</td></tr><tr><td>fcsr</td><td>0x003</td><td>7:0</td><td>frcsr, fscsr</td></tr></table>`,
        pitfall: `<p>Reading the flags to learn about one operation. fflags accumulates: it holds the OR over everything since it was last cleared, so a flag found after a loop says some iteration raised it, not which. Clear before the region
          you want to test (<code>fsflags zero, zero</code>) and read after it; the program above does exactly that between its cases.</p>`,
        real: `<p>Keeping the flags sticky, and not trapping, is what lets a pipelined FPU run ahead of the integer pipeline: the flags are merged into fflags at retirement, in order, without ever having to undo a younger instruction.
          Compilers rely on the same property to reorder floating-point operations freely when exceptions are not observed.</p>`,
      },
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
        <p><span data-show="fpu.u27">The two units</span> add 19 500 NANDs. They do not lengthen the clock: one step is 58 NAND delays, far below a float add.
        "Division and square root" takes 215 cycles for 22 instructions. "Newton's √2" computes x ← (x + 2 / x) / 2 four times: 132 cycles to reach the
        same correctly rounded float that one fsqrt.s gives in 28.</p>
        <div class="try">Run "Division and square root": the PC waits at each fdiv.s and fsqrt.s while the panel says stalled, and the CPI climbs.</div>`,
      scene: () => cpuScene({ source: fsrc('divsqrt'), fpu: true, adder: 'ks', highlight: ['fpu'] }),
      more: lazy(() => ({
        derive: `<p>An iterative instruction takes its unit's cycle count: a float32 fdiv is ${F32.M + 6} cycles (${F32.M + 4} quotient steps plus load and present), an fsqrt ${F32.M + 5}. With the stall, CPI of a program is
          1 + (stall cycles ÷ instructions): "Division and square root" runs 22 instructions in 215 cycles, CPI ${(215 / 22).toFixed(1)}, because each of its divides and roots adds about ${F32.M + 5} cycles. Newton's √2 does it with
          fmul and fadd in 132 cycles against one fsqrt.s's ${F32.M + 5}: the hardware instruction wins by ${(132 / (F32.M + 5)).toFixed(1)} times, and the CPU does not need to be told.</p>`,
        numbers: `<table class="mini"><tr><th>Unit</th><th>NANDs</th><th>Cycles</th><th>Step (NAND delays)</th></tr><tr><td>fdiv.s</td><td>${grp(nands(fpDiv(F32)))}</td><td>${F32.M + 6}</td><td>58</td></tr>
          <tr><td>fsqrt.s</td><td>${grp(nands(fpSqrt(F32)))}</td><td>${F32.M + 5}</td><td>58</td></tr></table>`,
        pitfall: `<p>Writing the registers before the unit is done. The register-file write enable is gated by retire like the PC, but the FPU's flag outputs also change during the division and must not reach fflags until retire: an OR of
          28 cycles of intermediate flags is a sticky wrong answer. The gate is the AND with retire that the quiz below asks about.</p>`,
        real: `<p>Divide and square root are the slowest common FP operations: 10 to 20 cycles of latency even on high-end cores, with a throughput of one every 4 to 6 cycles, against 4 cycles of latency and two issues per cycle for a fused multiply-add.
          Code that divides by the same value repeatedly multiplies by its reciprocal instead, when the compiler may.</p>`,
      })),
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
        32-way multiplexer tree of 32-bit words, 3970 NANDs. Bits 3:2 of the opcode are the two negations (bit 3 negates the product, bit 2 c), so
        <span data-show="fdec">the decoder</span> hands them to <span data-show="fpu">the unit</span> directly.</p>
        <p>In a single-cycle CPU the deepest instruction sets the clock: adding the fma took the period from 274 to 368 NAND delays (+34 %), paid by
        every add and branch (313 once normalize &amp; round is shortened, below). A pipelined FPU gives fma several cycles of latency instead.</p>
        <div class="try">Run "Fused multiply-add": a0 = 0 (fmul then fsub), a1 = 0x33800000 (fmsub.s, 2<sup>−24</sup>), then 17, 7, −7, −17 from the four variants.
        <span data-ahead="horner">"Horner with fmadd" (a polynomial written as nested multiply-adds)</span> evaluates a cubic in 3 instructions instead of 6.</div>`,
      scene: () => cpuScene({ source: fsrc('fma'), fpu: true, adder: 'ks', highlight: ['fpu', 'frf'] }),
      more: {
        derive: `<p>R4 format, 32 bits: rs3 [31:27], fmt [26:25] (00 = single), rs2 [24:20], rs1 [19:15], rm [14:12], rd [11:7], opcode [6:0]. The four opcodes differ in bits 3:2, and those two bits are the signs applied by the FPU:
          bit 3 negates the product, bit 2 negates c. fmadd = a·b + c, fmsub = a·b − c, fnmsub = −(a·b) + c, fnmadd = −(a·b) − c. The register file's third read port adds one 32-way multiplexer tree of 32-bit words.</p>`,
        numbers: `<table class="mini"><tr><th>Instruction</th><th>Opcode</th><th>Bit 3 (−product)</th><th>Bit 2 (−c)</th><th>Computes</th></tr>
          ${([['fmadd.s', 0x43, 'a·b + c'], ['fmsub.s', 0x47, 'a·b − c'], ['fnmsub.s', 0x4b, '−(a·b) + c'], ['fnmadd.s', 0x4f, '−(a·b) − c']] as [string, number, string][]).map(([n, op, f]) => `<tr><td>${n}</td><td>0x${op.toString(16).toUpperCase()}</td><td>${(op >> 3) & 1}</td><td>${(op >> 2) & 1}</td><td>${f}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Reading fnmsub and fnmadd as "negated fmsub and fmadd" in the other order. Their names come from the signs applied to the product and to c, not from the result: fnmsub is −(a·b) + c, whose result is the negative of fmsub's.
          The quiz below, with a·b = 2 and c = −2, turns on exactly this.</p>`,
        real: `<p>The R4 format uses four of the 32 major opcodes for these four instructions; it is why RISC-V needs the third operand in the instruction word and a third read port, and why the base integer ISA never has one.
          Cores that issue fma twice a cycle need six read ports in the f register file.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'fnmadd.s computes −(a × b) − c. With a × b = 2 and c = −2, what does it return in RNE, and with which sign?',
        options: ['+0', '−0', '−4', '+4'], answer: 0,
        why: ['', 'An exact zero from terms of opposite sign is −0 only in RDN; the negations in fnmadd do not change that rule.', 'That is fnmsub, −(a × b) + c = −2 − 2: fnmadd negates c as well.', 'That is fmsub, a × b − c = 2 + 2: fnmadd negates the product as well.'],
        explain: '−(2) − (−2) = −2 + 2: an exact zero from two terms of opposite sign, which is +0 in every mode except RDN (−0).',
      },
    },
    ...newtonSteps,
    {
      title: 'A pipelined FPU',
      body: `
        <p>The five-stage pipeline of <a href="#/c/pipeline/0">chapter 17</a> gains <span data-show="MX XW">a sixth stage, <strong>X</strong></span>, between M and W. Every instruction, integer or FP,
        walks F D E M X W, so they all retire in program order and the instruction-set simulator can still be stepped at W. The FP pipe is the fused
        multiply-add cut into its three boxes: <span data-show="fpx"><em>multiply</em> in E</span>, <span data-show="fadd"><em>align and add</em> in M</span>,
        <span data-show="fres"><em>round</em> in X</span>. One rounder serves all the arithmetic (fadd, fmul, the fused multiply-adds, fcvt.s.w, fdiv, fsqrt), so the pipelined RV32IF CPU,
        163 500 NANDs, is <em>smaller</em> than the single-cycle one (172 500). The other operations (sign injection, min / max, compares, fclass,
        moves) finish in E; fcvt.w.s aligns in E and <span data-show="ftoi">rounds in M</span>.</p>
        <p>Hazards. An FP result exists only at the end of X, so an instruction in D that reads an f register written by an instruction in E or M
        <span data-show="fhz"><strong>waits</strong></span> (an interlock), and then gets the value <span data-show="fA fB fC"><strong>forwarded from W</strong></span>
        (the select is decided in D, one cycle early).</p>
        <p>The clock: <strong>121</strong> NAND delays instead of 313. The E stage (unpack, prenormalize, the 24 × 24 tree) sets it; X, the stage built
        around the round box (106 deep on its own), is 118; the integer stages are at most 97.</p>
        <div class="try">Run "Dependent vs independent adds" and watch the pipeline diagram: in the first half every fadd.s waits two cycles for the previous
        one; with three accumulators the adds flow one per cycle. The timing panel shows the critical path.</div>`,
      scene: () => cpuScene({ source: fsrc('fpchain'), pipeline: true, fpu: true, adder: 'ks', timing: true, highlight: ['fpx', 'fadd', 'fres'] }),
      more: {
        derive: `<p>Every operation runs on the fma pipe: fadd is a × 1 + b, fmul is a × b + 0 (the zero signed like the product), fcvt.s.w puts |x| where the product would be; fdiv and fsqrt iterate in E behind operand latches and
          send their unrounded quotient or root down the same pipe. One rounder then serves all of them, which is what makes the pipelined CPU smaller than the single-cycle one even with its extra pipeline registers.
          The clock follows the slowest stage: 121 NAND delays against the single-cycle 313 is a factor ${(313 / 121).toFixed(2)} at CPI 1, and the pipeline loses once CPI exceeds that ratio.</p>`,
        pitfall: `<p>Counting a dependent chain as one instruction a cycle. The sum exists only at the end of X, so the next fadd waits in D for two cycles: each of a chain of dependent adds takes 3, and a loop that accumulates into one
          register runs at a third of the pipeline's peak. The remedy is software: three accumulators, summed at the end, as the second half of the program does. The pipeline diagram shows the two stall rows.</p>`,
        real: `<p>Why not forward from X? That would chain the X stage (118 deep) into the next multiply (92) in one cycle and nearly double the period. FP results bound for x registers wait the same way; loads are forwarded from X.
          fdiv / fsqrt hold F, D and E and send bubbles into M (a structural stall). fcsr is read in E and written in W: CSR accesses wait until no FP instruction is in flight, and FP instructions wait behind a CSR write.</p>
          <p>Getting to 121 meant shortening normalize &amp; round first: its two ripple incrementers became prefix trees (49 → 13 levels) and its overflow test now runs in parallel with the rounding, 142 → 102 deep, which also took the
          single-cycle CPU from 368 to 313. Production cores spread the fma over four or five cycles for the same reason, and issue a new one every cycle.</p>`,
      },

      challenge: {
        kind: 'quiz', question: 'fadd.s fa0, fa0, ft0 repeated: how many cycles does each one take on this pipeline, and why?',
        options: [
          'Three',
          'One: forwarding removes every stall',
          'Two: one stall for the load-use hazard',
          'Six: one per stage',
        ], answer: 0,
        why: ['', 'Forwarding moves a value that exists. The sum exists only at the end of X, two cycles after the next fadd wants it in E.', 'There is no load here, and the wait is two stall cycles, so each fadd takes three cycles.', 'That is one instruction\'s latency with no overlap. The next fadd only waits until its producer reaches W, while the stages keep overlapping.'],
        explain: 'Three: each waits in D while the previous one is in E and in M, then takes its result forwarded from W. The sum exists only at the end of X. The next fadd can enter E when its producer reaches W, three cycles after the producer entered E: two stall cycles each. Twelve dependent adds take 45 cycles with the fill; spread over three accumulators the same adds have no stalls at all (23 instructions in 35 cycles).',
      },
    },
    {
      title: 'Pipelined vs single-cycle: CPI × period',
      body: `
        <p>Measured on the gate-level CPUs, every program co-simulated against the instruction-set simulator: single-cycle → pipelined, cycles (the pipeline's
        include its five-cycle fill) and time = cycles × period (313 and 121 NAND delays).</p>
        ${perfTable()}
        <p>The pipeline wins 1.3 to 2.2 times on six of the seven programs; the iterative units gain most, because their 28 cycles now run at the short clock. CPI rises from 1 to
        1.6–2.7 (fadd chains, the fill; 11.7 with divisions). "Exception flags" is slower: almost every other instruction reads fflags, and each CSR access
        <span data-show="fhz">waits for the FP pipe to drain</span>. Real code keeps CSR accesses out of loops and interleaves independent work, as the compiler would schedule it.</p>`,
      scene: () => cpuScene({ source: fsrc('dot'), pipeline: true, fpu: true, adder: 'ks', highlight: ['fhz'] }),
      more: {
        derive: `<p>Time per program = cycles × period. The pipeline needs fewer NAND delays per cycle by a factor ${(SC_PERIOD / PIPE_PERIOD).toFixed(2)}, and more cycles by its CPI. Break-even is where the cycle ratio equals the period ratio: the pipeline wins
          while cycles<sub>pipe</sub> / cycles<sub>single</sub> &lt; ${(SC_PERIOD / PIPE_PERIOD).toFixed(2)}. "Exception flags" runs ${FP_RUNS[6][1]} instructions in ${FP_RUNS[6][2]} cycles, ratio ${(FP_RUNS[6][2] / FP_RUNS[6][1]).toFixed(2)}, just past it. "Division and square root" has the
          ratio ${(FP_RUNS[4][2] / FP_RUNS[4][1]).toFixed(2)}, so it gains ${(SC_PERIOD / PIPE_PERIOD / (FP_RUNS[4][2] / FP_RUNS[4][1])).toFixed(2)}×.</p>`,
        pitfall: `<p>Comparing cycle counts. The pipeline's ${FP_RUNS[0][2]} cycles for "0.1 ten times" look worse than the single-cycle ${FP_RUNS[0][1]}, and in time they are ${(FP_RUNS[0][1] * SC_PERIOD / (FP_RUNS[0][2] * PIPE_PERIOD)).toFixed(2)} times better. Always multiply by the period:
          that is the only reason the pipelined design exists.</p>`,
        real: `<p>Benchmarks of real processors report time or instructions per second, with clock frequency as part of the answer, for this reason. A design that raises frequency by deepening the pipeline gains only if the extra stalls do not eat the
          clock: the Pentium 4's long pipeline is the cautionary example the pipelining chapter mentions.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why must an integer instruction pass through X too, although it has nothing to do there?',
        options: [
          'So that every instruction has the same path length and results retire in order: an add must not write its register before an older fmul',
          'To give the ALU more time',
          'Because the register file needs two cycles to write',
          'To forward loads',
        ], answer: 0,
        why: ['', 'The ALU still has its one cycle in E; X adds latency to the pipe, not time to any stage.', 'The register file writes in one cycle, in W. The extra stage is there for ordering.', 'Loads are forwarded from X because they pass through it: a consequence of the extra stage, not its reason.'],
        explain: 'With different path lengths a younger integer instruction would finish before an older FP instruction: write-after-write and precise state would need extra logic (extra tracking of pending results, as in chapter 26, or a reorder buffer). Equal lengths keep it simple; the cost is one more forwarding source (X) and one stage of latency for nothing.',
      },
    },
    {
      title: 'Rounding surprises',
      body: `
        <p>Load "Rounding surprises" in the program menu: 10⁸ + 1 = 10⁸, 2²⁴ + 1 becomes 2²⁴, +0 equals −0 although their bits differ, ∞ − ∞ is NaN,
        NaN is not equal to itself, and 10⁶⁴ overflows to infinity. Each of these is the specified, correctly rounded answer.</p>
        <p>Every one follows from the three facts of the chapter: a result is the nearest representable value, the spacing grows with the magnitude, and a few encodings stand for things that are not numbers. Once the gap between neighbours
        exceeds the operand you add, that operand vanishes; once a result has no meaning, a NaN says so and propagates. Reading these as bugs is the common mistake; reading them as the arithmetic is the habit to build.</p>`,
      scene: () => cpuScene({ source: fsrc('absorb'), fpu: true, adder: 'ks' }),
      more: {
        numbers: `<table class="mini"><tr><th>Expression (float32)</th><th>Result</th><th>Why</th></tr>
          <tr><td>10<sup>8</sup> + 1</td><td>${Math.fround(Math.fround(1e8) + 1)}</td><td>the spacing at 10<sup>8</sup> is ${2 ** (Math.floor(Math.log2(1e8)) - 23)}</td></tr>
          <tr><td>2<sup>24</sup> + 1</td><td>${Math.fround(2 ** 24 + 1)}</td><td>above 2<sup>24</sup> float32 skips every other integer</td></tr>
          <tr><td>10<sup>38</sup> × 10</td><td>${String(Math.fround(Math.fround(1e38) * 10)).replace("Infinity", "∞")}</td><td>overflow: beyond ${sci(maxFinite(F32))}</td></tr></table>`,
        derive: `<p>Absorption: x + y = x when |y| &lt; ½ ulp(x). For x = 10<sup>8</sup> the ulp is ${2 ** (Math.floor(Math.log2(1e8)) - 23)}, so adding 1 is below half of it and the round-to-nearest returns x. At 2<sup>24</sup> the ulp becomes 2:
          2<sup>24</sup> + 1 is a tie between 2<sup>24</sup> and 2<sup>24</sup> + 2, and ties-to-even picks the one with the even fraction, 2<sup>24</sup>. A loop that counts with a float32 therefore stops at 16 777 216.</p>`,
        pitfall: `<p>Using a float as a loop counter or an accumulator of many small terms. Past 2<sup>24</sup> the counter gets stuck, and a long sum of small values added to a large running total loses them all.
          Sum the small ones first, use a wider accumulator, or use compensated (Kahan) summation, which captures the rounding error of each addition and feeds it back.</p>`,
        real: `<p>These effects are why a numerical library documents its error bounds, why financial code avoids binary floats, and why GPUs offering only float32 or lower precision use tricks such as pairwise summation in reductions.
          The behaviours are identical on every IEEE 754 machine, which is the achievement of the standard: you can reason about them once.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why does x == x fail when x is NaN?',
        options: ['A hardware bug', 'IEEE 754 defines every comparison with NaN as unordered (false), so x != x is the portable NaN test', 'NaN has many encodings', 'Only signaling NaNs do this'],
        answer: 1,
        why: ['It is the specified behaviour: IEEE 754 requires it, and the comparator forces it on purpose.', '', 'The same NaN bit pattern compared with itself is unequal too: the rule is about NaN, not about its encodings.', 'Quiet NaNs compare unordered as well. A signaling NaN (quiet bit 0) differs only in raising NV in feq.s (flt.s / fle.s raise NV on any NaN).'],
        explain: 'NaN means "no meaningful value"; ordering it would be meaningless too. The comparator checks the NaN flags of both operands and forces eq, lt and le to 0.',
      },
    },
    ...errorSteps,
  ],
};

void F32;
