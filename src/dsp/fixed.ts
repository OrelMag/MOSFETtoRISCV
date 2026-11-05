// Fixed-point arithmetic for the signal processing level (DOM-free): the golden model of lib/fixedpt.ts and of every later chapter's words.
// A value in a model is a signed JS number v meaning v / 2^f; packed words only appear at the gates' boundary (comm/signals signedOf / wordOf).
// Exact while |v| < 2^53, so a product of two words up to 26 bits. As in comm/fftfix.ts, hardware keeps every bit and rounds once per output.

export interface Q { w: number; f: number }
/** Qm.f, with the sign counted in m: Q1.15 is 16 bits. */
export const qName = (q: Q): string => `Q${q.w - q.f}.${q.f}`;
export type Overflow = 'wrap' | 'sat';
export type Rounding = 'trunc' | 'half-up' | 'convergent';

export const wordMax = (w: number): number => 2 ** (w - 1) - 1;
export const wordMin = (w: number): number => -(2 ** (w - 1));

/** The low w bits, read as two's complement: what an adder does past full scale. */
export function wrapTo(v: number, w: number): number {
  const M = 2 ** w, u = ((v % M) + M) % M;
  return u >= M / 2 ? u - M : u;
}
export const satTo = (v: number, w: number): number => Math.max(wordMin(w), Math.min(wordMax(w), v));
export const fit = (v: number, w: number, o: Overflow): number => (o === 'wrap' ? wrapTo(v, w) : satTo(v, w));

/** v / 2^s as an integer. trunc drops the bits (toward −∞); half-up adds the first dropped bit back; convergent sends ties to even. */
export function shiftRound(v: number, s: number, mode: Rounding): number {
  if (s <= 0) return v * 2 ** -s;
  const p = 2 ** s;
  if (mode === 'trunc') return Math.floor(v / p);
  const up = Math.floor((v + p / 2) / p);
  if (mode === 'half-up') return up;
  const tie = ((v % p) + p) % p === p / 2;
  return tie && up % 2 !== 0 ? up - 1 : up;
}

/** A real number into a word. */
export const toFixed = (x: number, q: Q, o: Overflow = 'sat', r: Rounding = 'half-up'): number => {
  const v = x * 2 ** q.f;
  if (r === 'trunc') return fit(Math.floor(v), q.w, o);
  const up = Math.floor(v + 0.5);
  return fit(r === 'convergent' && v + 0.5 === up && up % 2 !== 0 ? up - 1 : up, q.w, o);
};
export const fromFixed = (v: number, q: Q): number => v / 2 ** q.f;

/** a + b, clamped. */
export const satAdd = (a: number, b: number, w: number): number => satTo(a + b, w);
/** Did a + b leave the word? */
export const addOverflows = (a: number, b: number, w: number): boolean => a + b > wordMax(w) || a + b < wordMin(w);

/** Q1.(w−1) × Q1.(w−1): the product has two sign bits, so it comes down by w − 1, rounded half up and clamped. Only −1 × −1 can overflow. */
export const fracMul = (a: number, b: number, w: number): number => satTo(shiftRound(a * b, w - 1, 'half-up'), w);

/** The fewest two's complement bits that hold v. */
export const bitsToHold = (v: number): number => (v >= 0 ? Math.ceil(Math.log2(v + 1)) : Math.ceil(Math.log2(-v))) + 1;

/** An n-word sum's worst case needs this many guard bits above a word. */
export const guardBits = (n: number): number => Math.ceil(Math.log2(n));

/** Variance of rounding to a step q: q² / 12, whichever rule, for a busy signal; truncation has a mean of −q / 2 besides. */
export const roundingNoise = (q: number): number => (q * q) / 12;
