// Chapter flash: how many bit errors a page's error-correcting code absorbs. A BCH code over GF(2^m) with t-bit
// correction adds m·t parity bits to a codeword of `data` bits; the codeword fails when it has more than t errors.
// Raw bit errors are independent with probability p (the raw bit error rate, RBER).

/** Parity bits of a t-error-correcting BCH code on `data` data bits: m·t with 2^m − 1 ≥ data + m·t. */
export function bchParity(data: number, t: number): number {
  let m = 1;
  while (2 ** m - 1 < data + m * t) m++;
  return m * t;
}

/** P(more than t of n bits are in error) at raw bit error rate p: the tail summed term by term from t + 1. */
export function codewordFail(n: number, t: number, p: number): number {
  if (p <= 0) return 0;
  const lp = Math.log(p), lq = Math.log1p(-p);
  let lc = 0; // log C(n, i), built up as i grows
  for (let i = 1; i <= t + 1; i++) lc += Math.log((n - i + 1) / i);
  let sum = 0;
  for (let i = t + 1; i <= Math.min(n, t + 80); i++) {
    const term = Math.exp(lc + i * lp + (n - i) * lq);
    sum += term;
    if (term < sum * 1e-18) break;
    lc += Math.log((n - i) / (i + 1));
  }
  return Math.min(1, sum);
}

/** The largest RBER at which an uncorrectable codeword is rarer than `uber` per data bit (the JEDEC target is 1e-15). */
export function maxRber(data: number, t: number, uber = 1e-15): number {
  const n = data + bchParity(data, t);
  let lo = 0, hi = 0.5;
  for (let i = 0; i < 200; i++) {
    const mid = Math.sqrt(Math.max(lo, 1e-12) * hi);
    if (codewordFail(n, t, mid) / data > uber) hi = mid; else lo = mid;
  }
  return lo;
}
