// The Apollo Guidance Computer's numbers (Appendix F): one's complement, 15-bit words in memory (bit 14 the sign, −0 is
// 077777), 16-bit central registers A, L, Q (bit 15 the true sign S2, bit 14 S1: they differ after an overflow).
// All values are plain numbers holding the bits; the names say which width.

export const W15 = 0o77777, W16 = 0o177777, SIGN15 = 0o40000, SIGN16 = 0o100000;

/** A 15-bit word sign-extended to 16 bits (bit 14 copied into bit 15). */
export const sx = (w: number): number => (w & W15) | ((w & SIGN15) << 1);

/** A 16-bit value as 15 bits, overflow-corrected: the true sign (bit 15) becomes the word's sign, bit 14 is dropped. */
export const oc = (x: number): number => (x & 0o37777) | ((x >> 1) & SIGN15);

/** +1 for a positive overflow (bits 15, 14 = 01), −1 for a negative one (10), 0 for none. */
export const ovf = (x: number): -1 | 0 | 1 => {
  const t = x & 0o140000;
  return t === 0o40000 ? 1 : t === 0o100000 ? -1 : 0;
};

/** One's-complement 16-bit sum: a carry out of bit 15 comes back in at bit 0 (end-around carry). */
export const add16 = (a: number, b: number): number => {
  let s = (a & W16) + (b & W16);
  if (s > W16) s = (s + 1) & W16;
  return s;
};

export const neg16 = (x: number): number => ~x & W16;
export const neg15 = (w: number): number => ~w & W15;

/** +1 and −1 as 16-bit words. */
export const PLUS1 = 1, MINUS1 = W16 - 1;

/** A 15-bit word as a signed number (−0 is 0). */
export const val15 = (w: number): number => ((w & SIGN15) ? -(~w & W15) : w & W15);
/** A 16-bit register as a signed number (an overflowed value keeps its 15 magnitude bits: ±16384 … ±32767). */
export const val16 = (x: number): number => ((x & SIGN16) ? -(~x & W16) : x & W16);
/** A signed number |v| ≤ 2^14 − 1 as a 15-bit word (0 is +0). */
export const word15 = (v: number): number => (v < 0 ? ~(-v) & W15 : v & W15);
/** A signed number |v| ≤ 2^15 − 1 as a 16-bit word. */
export const word16 = (v: number): number => (v < 0 ? ~(-v) & W16 : v & W16);

export const isNeg15 = (w: number): boolean => (w & SIGN15) !== 0;
export const isZero15 = (w: number): boolean => (w & W15) === 0 || (w & W15) === W15;
