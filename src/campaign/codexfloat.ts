// Codex entries for the Floating point chapter's later steps (chapters/ch-float.ts, float/*.ts). Same shape as codex.ts; the fuller texts are
// codexmorefloat.ts, the questions codexcheckfloat.ts, the numbers pinned by tests/content-codexfloat.test.ts. No DOM, no library import:
// the chapters' hover cards load this.

import type { CodexEntry, CodexKind } from './codex';

const E = (id: string, title: string, kind: CodexKind, body: string, related?: string[]): CodexEntry => ({ id, title, kind, body, related });

export const CODEX_FLOAT: CodexEntry[] = [
  E('fpspecial', 'NaN, infinities and signed zero', 'concept', `The all-ones exponent holds ±∞ (fraction 0) and NaN (anything else: 2·(2<sup>23</sup> − 1) = 16 777 214 float32 patterns). <b>∞</b> is what an overflow or x / 0 gives and it behaves as a limit: 1 / ∞ = 0, ∞ + 1 = ∞. <b>NaN</b> means "no value": ∞ − ∞, 0 × ∞, 0 / 0 and √−1 produce it and raise NV; it is unequal to everything including itself, and every ordered comparison with it is false. A quiet NaN has the top fraction bit set; RISC-V returns only the canonical one, 0x7FC00000. <b>−0</b> exists because a float is sign and magnitude: it equals +0 in a comparison, but 1 / −0 = −∞, and x − x is +0 except in round-down, where it is −0. fmin and fmax ignore a NaN (fmin(NaN, 1) = 1) and treat −0 as less than +0.`, ['ieee754', 'subnormal', 'fpcompare']),
  E('fpflags', 'Floating-point exception flags', 'concept', `Five sticky bits record what happened since they were last cleared, and nothing traps: <b>NV</b> invalid (the result is not defined: ∞ − ∞, 0 × ∞, √−1, a signaling NaN, an out-of-range fcvt), <b>DZ</b> divide by zero (x / 0 with x finite and non-zero: the result is ±∞), <b>OF</b> overflow (the rounded result is beyond the largest finite number; always with NX), <b>UF</b> underflow (the result is tiny, judged after rounding, <em>and</em> inexact) and <b>NX</b> inexact (the rounded result differs from the exact one: 1 / 3). In RISC-V they are fflags, the low five bits of fcsr (NX = 1, UF = 2, OF = 4, DZ = 8, NV = 16). One check after a whole loop finds any exception inside it; a flag is cleared only by writing it, so reading it twice answers the same.`, ['ieee754', 'rounding', 'fpspecial']),
  E('ulp', 'Ulp and machine epsilon', 'concept', `An <b>ulp</b> is the gap between a float and the next one: 2<sup>e − 23</sup> for float32 in binade e, so it doubles with every binade (1 for 2<sup>23</sup> … 2<sup>24</sup>, 8 around 10<sup>8</sup>). <b>Machine epsilon</b> is the ulp of 1: 2<sup>−23</sup> ≈ 1.19 × 10<sup>−7</sup> in float32, 2<sup>−52</sup> in float64. Round to nearest never errs by more than half an ulp, a relative error of at most the <b>unit roundoff</b> u = 2<sup>−24</sup>. Errors are measured in ulps because the same absolute error is large near 1 and negligible near 10<sup>8</sup>. <b>Catastrophic cancellation</b> is the one place a tiny relative error becomes a large one: subtracting nearly equal numbers is exact (Sterbenz) but leaves the earlier rounding errors as the leading digits of the result.`, ['ieee754', 'rounding', 'kahan']),
  E('kahan', 'Kahan summation', 'trick', `A running float sum adds each term to a total that is much larger, and rounds away the low bits of every term; the error grows like n·u in the worst case. Kahan keeps those lost bits in a compensation c and feeds them back: <code>y = x − c; t = s + y; c = (t − s) − y; s = t</code>. The algebra says c is always 0; in floating point c is the rounding error of the addition. The total error stays near 2u for any n, at the price of four additions per term instead of one. It needs every operation rounded as written: a compiler allowed to reassociate (-ffast-math) simplifies c to 0 and the loop is a plain sum again.`, ['ulp', 'rounding']),
  E('fpformats', 'Reduced-precision formats (bf16, FP8)', 'concept', `Machine learning trades precision for throughput. <b>bfloat16</b> is float32's sign and 8 exponent bits with a 7-bit fraction: the top half of a float32, the same range and 8 significant bits. <b>binary16</b> has 5 + 10 bits (range to 65 504). <b>FP8</b> comes as <b>E4M3</b> (4 exponent, 3 fraction bits: precision) and <b>E5M2</b> (5 + 2: range). The common ML E4M3 of the OCP specification is not IEEE-shaped: it has no infinity and a single NaN pattern, which frees the top binade, so its largest value is 448 instead of 240. A multiplier grows with the square of the significand, so a bf16 one costs about 38 % of float32's NANDs and an FP8 one 14 to 16 %; products are usually accumulated in float32.`, ['ieee754', 'fma']),
  E('newtondiv', 'Newton–Raphson division', 'trick', `Division without a divider: refine an estimate x of 1/b with the residual e = 1 − b·x, then x' = x + x·e. The relative error is squared each step (e → e²), so the correct bits double. A seed from one integer subtract on the bit pattern is good to 4.3 bits, and three steps of two fused multiply-adds reach float32. The quotient a·x can still be one ulp off, since x and the product are both rounded; one more fma pair (r = a − b·q, q' = q + r·x, Markstein's correction) makes it correctly rounded in normal-range cases. It is slower than a divider where each step waits for the last and faster where the multiplier is free.`, ['fma', 'division']),
];

/** Codex id → the chapter that teaches it. */
export const TAUGHT_FLOAT: Record<string, string> = {
  fpspecial: 'float', fpflags: 'float', ulp: 'float', kahan: 'float', fpformats: 'float', newtondiv: 'float',
};

/** Other names an entry goes by in the chapters' prose (glossary.ts). */
export const ALIASES_FLOAT: Record<string, string[]> = {
  fpspecial: ['NaN', 'signaling NaN', 'quiet NaN', 'signed zero'],
  fpflags: ['exception flags', 'fflags'],
  ulp: ['ulp', 'ulps', 'machine epsilon', 'catastrophic cancellation', 'unit roundoff'],
  kahan: ['Kahan summation', 'compensated summation'],
  fpformats: ['bfloat16', 'bf16', 'FP8', 'E4M3', 'E5M2'],
  newtondiv: ['Newton–Raphson division', "Markstein's correction"],
};
