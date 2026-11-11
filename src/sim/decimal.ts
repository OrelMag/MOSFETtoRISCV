// Decimal text <-> binary floats, exactly (DOM-free): the exact decimal expansion of a value, correctly rounded parsing
// of a decimal string into any format (BigInt rational, one rounding), and the digit counts that round-trip.

import { parts, roundToX, type FpFormat, fpValue } from './fpref';

const bitLength = (v: bigint) => v.toString(2).length;

/** The exact decimal expansion of a finite double, no rounding: 0.1 -> 0.1000000000000000055511151231257827021181583404541015625. */
export function exactDecimal(x: number): string {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'NaN' : x > 0 ? '∞' : '−∞';
  const neg = x < 0 || Object.is(x, -0);
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, Math.abs(x));
  const hi = dv.getUint32(0), lo = dv.getUint32(4), e = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e) mant |= 1n << 52n;
  const exp2 = (e || 1) - 1075;
  let digits: string, frac = 0;
  if (exp2 >= 0) digits = (mant << BigInt(exp2)).toString();
  else { frac = -exp2; digits = (mant * 5n ** BigInt(frac)).toString(); }   // mant / 2^k = mant * 5^k / 10^k
  if (frac) {
    digits = digits.padStart(frac + 1, '0');
    let s = `${digits.slice(0, digits.length - frac)}.${digits.slice(digits.length - frac)}`;
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    digits = s;
  }
  return (neg ? '−' : '') + digits;
}

/** Significant digits of a decimal text (leading zeros and the exponent do not count). */
export function sigDigits(text: string): number {
  const m = /^[+-]?(\d*)\.?(\d*)(?:e[+-]?\d+)?$/i.exec(text.trim());
  if (!m) return 0;
  return (m[1] + m[2]).replace(/^0+/, '').replace(/0+$/, '').length || (/[1-9]/.test(m[1] + m[2]) ? 0 : 1);
}

/** Parse a decimal text into the nearest encoding of f, one rounding (round to nearest even), or null when it is not a number. */
export function parseDecimal(text: string, f: FpFormat): number | null {
  const m = /^([+-])?(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(text.trim());
  if (!m || !(m[2] + m[3])) return null;
  const sign = m[1] === '-' ? 1 : 0;
  const D = BigInt(m[2] + m[3]);
  const e10 = (m[4] ? Number(m[4]) : 0) - m[3].length;
  if (D === 0n) return sign * 2 ** (f.E + f.M);
  if (e10 >= 0) return roundToX(sign, D * 10n ** BigInt(e10), 0, f).y;
  if (e10 < -5000) return sign * 2 ** (f.E + f.M);   // far below every format
  const den = 10n ** BigInt(-e10);
  const s = Math.max(0, bitLength(den) - bitLength(D) + f.M + 6);
  const num = D << BigInt(s);
  const q = num / den, rem = num % den;
  return roundToX(sign, (q << 1n) | (rem ? 1n : 0n), -s - 1, f).y;   // the sticky bit sits far below the guard bit
}

/** v printed with n significant digits (correctly rounded, exact for doubles). */
export const printSig = (v: number, n: number): string => v.toPrecision(Math.min(100, Math.max(1, n)));

/** The fewest significant digits whose decimal text parses back to the same encoding (bits must be finite). */
export function shortestDigits(bits: number, f: FpFormat): number {
  const v = Math.abs(fpValue(bits, f)), k = parts(bits, f);
  if (k.kind === 'zero') return 1;
  for (let n = 1; n < 40; n++) {
    const b = parseDecimal(printSig(v, n), f);
    if (b === (bits & (2 ** (f.E + f.M) - 1))) return n;
  }
  return 40;
}

/** Digits that always bring a float of p significant bits back: ceil(1 + p log10 2) (9 for float32, 17 for float64). */
export const digitsToRoundTrip = (p: number) => Math.ceil(1 + p * Math.LOG10E * Math.LN2);
/** Digits that survive decimal -> float -> decimal: floor((p - 1) log10 2) (6 for float32, 15 for float64). */
export const digitsSurviving = (p: number) => Math.floor((p - 1) * Math.LOG10E * Math.LN2);

/** The exact decimal expansion of a + b for finite non-negative doubles (the sum before it is rounded). */
export function exactSum(a: number, b: number): string {
  const split = (x: number) => { const [i, f = ''] = exactDecimal(x).split('.'); return { i, f }; };
  const A = split(a), B = split(b), k = Math.max(A.f.length, B.f.length);
  const big = (p: { i: string; f: string }) => BigInt(p.i + p.f.padEnd(k, '0'));
  const s = (big(A) + big(B)).toString().padStart(k + 1, '0');
  const t = s.slice(0, s.length - k) + (k ? '.' + s.slice(s.length - k) : '');
  return k ? t.replace(/0+$/, '').replace(/[.]$/, '') : t;
}
