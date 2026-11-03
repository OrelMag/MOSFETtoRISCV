// Chapter 24's summation lab (DOM-free): naive, pairwise and Kahan sums of float32 terms against the exact sum (BigInt).
// Math.fround of a double sum of two float32s is the correctly rounded float32 sum (a double holds it exactly first),
// so the loops here are the CPU's fadd.s / fsub.s (tests/fperror.test.ts holds the Kahan loop equal to the RV32F program).

import { q, qAbs, qDiv, qNum, qSub, UNIT_ROUNDOFF, type Q } from './errorlab';

const f = Math.fround;

export function naiveSum(xs: readonly number[]): number { let s = 0; for (const x of xs) s = f(s + x); return s; }
/** Recursive halving: the tree is log2 n deep, so each term meets about log2 n roundings. */
export function pairwiseSum(xs: readonly number[], lo = 0, hi = xs.length): number {
  if (hi - lo === 0) return 0;
  if (hi - lo === 1) return xs[lo];
  const m = (lo + hi) >> 1;
  return f(pairwiseSum(xs, lo, m) + pairwiseSum(xs, m, hi));
}
/** Kahan: c carries what the last addition lost (algebraically 0), the same six float operations as the RV32F program. */
export function kahanSum(xs: readonly number[]): { sum: number; c: number } {
  let s = 0, c = 0;
  for (const x of xs) {
    const y = f(x - c), t = f(s + y);
    c = f(f(t - s) - y);
    s = t;
  }
  return { sum: s, c };
}

/** A float32 as an integer multiple of 2^-149 (every float32 is one). */
function scaled(x: number): bigint {
  if (x === 0) return 0n;
  const dv = new DataView(new ArrayBuffer(4));
  dv.setFloat32(0, x);
  const b = dv.getUint32(0), field = (b >>> 23) & 0xff, frac = b & 0x7fffff;
  const mant = BigInt(field === 0 ? frac : frac | 0x800000), sh = (field === 0 ? 1 : field) - 127 - 23 + 149;
  const v = mant << BigInt(sh);
  return b >>> 31 ? -v : v;
}
export const qOfNumber32 = (x: number): Q => q(scaled(x), 1n << 149n);

/** The exact sum of float32 terms. */
export function exactSum(xs: readonly number[]): Q {
  let acc = 0n;
  for (const x of xs) acc += scaled(x);
  return q(acc, 1n << 149n);
}

/** |s − exact| / |exact| (exact ≠ 0). */
export function relErrOf(s: number, exact: Q): number {
  return qNum(qDiv(qAbs(qSub(qOfNumber32(s), exact)), qAbs(exact)));
}

export type DataKind = 'wide' | 'uniform' | 'absorb';
export const DATA_NAMES: Record<DataKind, string> = {
  wide: 'n values over 17 binades (2⁻⁸ … 2⁹)',
  uniform: 'n uniform values in [0, 1)',
  absorb: '1.0, then n − 1 × 2⁻²⁴',
};
/** The first n terms of a data set (seeded: the same every time). */
export function dataset(kind: DataKind, n: number): number[] {
  const xs: number[] = [];
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let i = 0; i < n; i++) xs.push(kind === 'wide' ? f(rnd() * 2 ** (Math.floor(rnd() * 17) - 8)) : kind === 'uniform' ? f(rnd()) : i === 0 ? 1 : 2 ** -24);
  return xs;
}

export interface SumPoint { n: number; naive: number; pairwise: number; kahan: number }
/** Relative errors of the three sums at n = 2^1 … 2^maxK terms of one data set (prefixes of the same sequence). */
export function errorCurve(kind: DataKind, maxK: number): SumPoint[] {
  const all = dataset(kind, 2 ** maxK), out: SumPoint[] = [];
  for (let k = 1; k <= maxK; k++) {
    const xs = all.slice(0, 2 ** k), ex = exactSum(xs);
    out.push({ n: xs.length, naive: relErrOf(naiveSum(xs), ex), pairwise: relErrOf(pairwiseSum(xs), ex), kahan: relErrOf(kahanSum(xs).sum, ex) });
  }
  return out;
}

/** Worst-case bounds on the relative error for positive terms (Higham, Accuracy and Stability, ch. 4): (n−1)u, ⌈log2 n⌉u, 2u + O(nu²). */
export const bounds = (n: number) => ({
  naive: (n - 1) * UNIT_ROUNDOFF,
  pairwise: Math.ceil(Math.log2(n)) * UNIT_ROUNDOFF,
  kahan: 2 * UNIT_ROUNDOFF + 2 * n * UNIT_ROUNDOFF * UNIT_ROUNDOFF,
});
