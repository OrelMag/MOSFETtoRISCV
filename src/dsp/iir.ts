// IIR filters (DOM-free): the biquad in fixed point (the golden model of lib/biquad.ts, bit for bit), analog prototypes through the bilinear transform,
// orders for a mask, second-order sections, coefficient sensitivity, limit cycles, section order and scaling.
// Frequency is cycles a sample (Nyquist = 0.5), as in comm/signals.ts; scipy's Wn is a fraction of Nyquist, so its 0.2 is 0.1 here.
// Values in a model are signed JS numbers; words are integers. tests/dsp-iir.test.ts holds the design half to scipy (tests/dsp/vectors/iir.json).

import { satTo, shiftRound, type Rounding } from './fixed';
import { convolve, filter, gainAt, polyRoots, type Cx } from './zplane';

// ---- the biquad's words ---------------------------------------------------------------------------------------------------------------------

/** Data Q1.15 (16 bits). Coefficients Q2.14 (16 bits: −2 … 2 − 2⁻¹⁴, so a₁ = −2 is a word and +2 is not). A product is Q3.29 in 32 bits; five of them
 *  need log₂ 5 → 3 guard bits: a 35-bit accumulator. The sum drops the 14 low bits once (29 → 15 fractional bits), rounds, and is clamped to 16. */
export const BQ = { w: 16, f: 15, cw: 16, cf: 14, prod: 32, guard: 3, accW: 35, drop: 14 } as const;
export type BqRound = Rounding | 'zero';
export interface Words { b0: number; b1: number; b2: number; a1: number; a2: number }
export const COEF_STEP = 2 ** -BQ.cf;
/** A coefficient (real) as a Q2.14 word, rounded to nearest and kept in range. */
export const coefWord = (v: number, cw = BQ.cw): number => satTo(Math.round(v * 2 ** (cw - 2)), cw);
export const coefValue = (word: number, cw = BQ.cw): number => word / 2 ** (cw - 2);
export const wordsOf = (c: { b: readonly number[]; a: readonly number[] }, cw = BQ.cw): Words => ({ b0: coefWord(c.b[0], cw), b1: coefWord(c.b[1] ?? 0, cw), b2: coefWord(c.b[2] ?? 0, cw), a1: coefWord(c.a[1] ?? 0, cw), a2: coefWord(c.a[2] ?? 0, cw) });
export const realOf = (w: Words, cw = BQ.cw): { b: number[]; a: number[] } => ({ b: [w.b0, w.b1, w.b2].map((v) => coefValue(v, cw)), a: [1, coefValue(w.a1, cw), coefValue(w.a2, cw)] });

/** v / 2^s as an integer by rule: the three of chapter "Numbers that fit", and toward zero (the hardware's other option). */
export function dropBits(v: number, s: number, mode: BqRound): number {
  if (mode === 'zero') return v < 0 ? 0 - shiftRound(-v, s, 'trunc') : shiftRound(v, s, 'trunc');
  return shiftRound(v, s, mode);
}

/** The exact sum of the five products, in Q3.29: what the accumulator holds before it is rounded. */
export const accumulate = (c: Words, x: number, x1: number, x2: number, y1: number, y2: number): number => c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;

export interface BqOpts {
  /** The one rounding. The hardware's is 'half-up'. */
  round?: BqRound;
  /** Extra fractional bits kept in the delayed outputs (a labelled model, not built): the output port is still rounded to Q1.15. */
  extra?: number;
}

/** y[n] = b₀x[n] + b₁x[n−1] + b₂x[n−2] − a₁y[n−1] − a₂y[n−2], direct form I. step(x) is one clock: the output for this input, then the registers shift. */
export class Biquad {
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  readonly round: BqRound; readonly extra: number;
  constructor(public c: Words, o: BqOpts = {}) { this.round = o.round ?? 'half-up'; this.extra = o.extra ?? 0; }
  reset(): void { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
  /** The output for input x, and the state after the edge. y1 and y2 hold the delayed outputs at 15 + extra fractional bits. */
  step(x: number): number {
    const e = this.extra, k = 2 ** e;
    const acc = accumulate(this.c, x * k, this.x1 * k, this.x2 * k, this.y1, this.y2);
    const y = satTo(dropBits(acc, BQ.drop + e, this.round), BQ.w);
    const state = e ? satTo(dropBits(acc, BQ.drop, this.round), BQ.w + e) : y;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = state;
    return y;
  }
  get state(): [number, number, number, number] { return [this.x1, this.x2, this.y1, this.y2]; }
  set state(s: readonly number[]) { [this.x1, this.x2, this.y1, this.y2] = s; }
}

export const runBiquad = (c: Words, xs: readonly number[], o: BqOpts = {}): number[] => { const m = new Biquad(c, o); return xs.map((x) => m.step(x)); };

// ---- limit cycles ---------------------------------------------------------------------------------------------------------------------------

export interface Cycle { start: number; period: number; peak: number; seq: number[] }
/** After the input has stopped, does the output settle to a repeating non-zero pattern? Looks for a period up to maxPeriod in the last stretch of a zero-input run. */
export function findCycle(ys: readonly number[], maxPeriod = 64): Cycle | null {
  const n = ys.length, tail = ys.slice(n - 4 * maxPeriod);
  if (tail.every((v) => v === 0)) return null;
  for (let p = 1; p <= maxPeriod; p++) {
    let ok = true;
    for (let i = n - 3 * maxPeriod; i < n - p && ok; i++) ok = ys[i] === ys[i + p];
    if (!ok) continue;
    let start = n - 3 * maxPeriod;
    while (start > 0 && ys[start - 1] === ys[start - 1 + p]) start--;
    const seq = ys.slice(n - p), peak = Math.max(...seq.map(Math.abs));
    return peak === 0 ? null : { start, period: p, peak, seq };
  }
  return null;
}

/** An input and then silence: `burst` samples of `amp` (the input word), then zeros up to `len` samples. */
export const burstThenSilence = (amp: number, burst: number, len: number): number[] => Array.from({ length: len }, (_, i) => (i < burst ? amp : 0));

// ---- analog prototypes → digital filters ------------------------------------------------------------------------------------------------------

export interface Zpk { z: Cx[]; p: Cx[]; k: number }
export type Family = 'butter' | 'cheby1' | 'ellip';
export const FAMILIES: { id: Family; name: string }[] = [{ id: 'butter', name: 'Butterworth' }, { id: 'cheby1', name: 'Chebyshev I' }, { id: 'ellip', name: 'Elliptic' }];

const cx = (re: number, im = 0): Cx => ({ re, im });
const cmul = (a: Cx, b: Cx): Cx => cx(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const cdiv = (a: Cx, b: Cx): Cx => { const m = b.re * b.re + b.im * b.im; return cx((a.re * b.re + a.im * b.im) / m, (a.im * b.re - a.re * b.im) / m); };
const csub = (a: Cx, b: Cx): Cx => cx(a.re - b.re, a.im - b.im);
const cprod = (v: readonly Cx[]): Cx => v.reduce(cmul, cx(1));
const conj = (a: Cx): Cx => cx(a.re, -a.im);
const cneg = (a: Cx): Cx => cx(-a.re, -a.im);
export const cabs = (a: Cx): number => Math.hypot(a.re, a.im);

/** Complete elliptic integral of the first kind K(m), parameter m = k², by the arithmetic–geometric mean. */
export function ellipk(m: number): number { return ellipkm1(1 - m); }
/** K(1 − p), exact for tiny p. */
export function ellipkm1(p: number): number {
  let a = 1, b = Math.sqrt(p);
  for (let i = 0; i < 40 && Math.abs(a - b) > 1e-16 * a; i++) { const t = (a + b) / 2; b = Math.sqrt(a * b); a = t; }
  return Math.PI / (2 * a);
}
/** sn, cn, dn of a real argument and parameter 0 ≤ m < 1 (descending Landen / AGM). */
export function ellipj(u: number, m: number): { sn: number; cn: number; dn: number } {
  if (m < 1e-9) { const t = Math.sin(u), b = Math.cos(u), ai = 0.25 * m * (u - t * b); return { sn: t - ai * b, cn: b + ai * t, dn: 1 - 0.5 * m * t * t }; }
  const a = [1], c = [Math.sqrt(m)];
  let b = Math.sqrt(1 - m), n = 0, twon = 1;
  while (Math.abs(c[n] / a[n]) > 1e-16 && n < 12) { const an = a[n]; n++; c[n] = (an - b) / 2; a[n] = (an + b) / 2; b = Math.sqrt(an * b); twon *= 2; }
  let phi = twon * a[n] * u;
  for (let i = n; i > 0; i--) phi = (Math.asin((c[i] * Math.sin(phi)) / a[i]) + phi) / 2;
  const sn = Math.sin(phi);
  return { sn, cn: Math.cos(phi), dn: Math.sqrt(1 - m * sn * sn) };
}
/** The modulus m of the elliptic filter's degree equation for order n and selectivity m1, from the nome series (Orfanidis). */
export function ellipdeg(n: number, m1: number): number {
  const k1 = ellipk(m1), k1p = ellipkm1(m1), q = Math.exp((-Math.PI * k1p) / k1) ** (1 / n);
  let num = 0, den = 1;
  for (let i = 0; i <= 7; i++) num += q ** (i * (i + 1));
  for (let i = 1; i <= 8; i++) den += 2 * q ** (i * i);
  return 16 * q * (num / den) ** 4;
}
/** Im of the inverse of sn at the imaginary argument i·w (the elliptic filter's scale), by ascending Landen. */
function arcJacSc1(w: number, m: number): number {
  const ks = [Math.sqrt(m)];
  while (ks[ks.length - 1] > 1e-16 && ks.length < 30) { const kp = Math.sqrt(1 - ks[ks.length - 1] ** 2); ks.push((1 - kp) / (1 + kp)); }
  let K = Math.PI / 2;
  for (let i = 1; i < ks.length; i++) K *= 1 + ks[i];
  let x = w;
  for (let i = 0; i + 1 < ks.length; i++) x = (2 * x) / ((1 + ks[i + 1]) * (1 + Math.sqrt(1 + ks[i] ** 2 * x * x)));
  return K * (2 / Math.PI) * Math.asinh(x);
}

const gainOf = (rp: number): number => 10 ** (0.1 * rp);
/** Analog low-pass prototypes with edge 1 rad/s: Butterworth (−3 dB), Chebyshev I and elliptic (the end of the ripple band, ripple rp dB; elliptic stopband rs dB). */
export function analogPrototype(kind: Family, n: number, rp = 0.1, rs = 60): Zpk {
  if (kind === 'butter') return { z: [], p: Array.from({ length: n }, (_, i) => { const t = (Math.PI * (1 - n + 2 * i)) / (2 * n); return cx(-Math.cos(t), -Math.sin(t)); }), k: 1 };
  const eps2 = gainOf(rp) - 1, eps = Math.sqrt(eps2);
  if (kind === 'cheby1') {
    const mu = Math.asinh(1 / eps) / n;
    const p = Array.from({ length: n }, (_, i) => { const th = (Math.PI * (1 - n + 2 * i)) / (2 * n); return cx(-Math.sinh(mu) * Math.cos(th), -Math.cosh(mu) * Math.sin(th)); });
    return { z: [], p, k: cprod(p.map(cneg)).re / (n % 2 ? 1 : Math.sqrt(1 + eps2)) };
  }
  const ck1sq = eps2 / (gainOf(rs) - 1), kk1 = ellipk(ck1sq), m = ellipdeg(n, ck1sq), capk = ellipk(m);
  const js = Array.from({ length: Math.ceil(n / 2) }, (_, i) => 2 * i + (1 - (n % 2)));
  const r = arcJacSc1(1 / eps, ck1sq), v0 = (capk * r) / (n * kk1), { sn: sv, cn: cv, dn: dv } = ellipj(v0, 1 - m);
  const z: Cx[] = [], p: Cx[] = [];
  for (const j of js) {
    const { sn: s, cn: c, dn: d } = ellipj((j * capk) / n, m);
    const den = 1 - (d * sv) ** 2, pole = cx(-(c * d * sv * cv) / den, -(s * dv) / den);
    if (Math.abs(s) > 2e-16) { const zz = cx(0, 1 / (Math.sqrt(m) * s)); z.push(zz, conj(zz)); }
    if (j === 0) p.push(cx(pole.re)); else p.push(pole, conj(pole));
  }
  return { z, p, k: cdiv(cprod(p.map(cneg)), cprod(z.map(cneg))).re / (n % 2 ? 1 : Math.sqrt(1 + eps2)) };
}

/** The bilinear transform at one sample a second: s → z = (2 + s) / (2 − s). Zeros at z = −1 for the degree the analog filter lacks. */
export function bilinearZpk(a: Zpk): Zpk {
  const map = (s: Cx): Cx => cdiv(cx(2 + s.re, s.im), cx(2 - s.re, -s.im));
  const extra = a.p.length - a.z.length;
  const num = cprod(a.z.map((s) => csub(cx(2), s))), den = cprod(a.p.map((s) => csub(cx(2), s)));
  return { z: [...a.z.map(map), ...Array.from({ length: extra }, () => cx(-1))], p: a.p.map(map), k: a.k * cdiv(num, den).re };
}
/** An analog edge that lands at f cycles a sample after the transform: ω = 2 tan(π f). */
export const prewarp = (f: number): number => 2 * Math.tan(Math.PI * f);
/** The digital frequency (cycles a sample) an analog ω rad/s lands on: the inverse of the prewarp, f = atan(ω / 2) / π. */
export const warpedAt = (omega: number): number => Math.atan(omega / 2) / Math.PI;

/** A low-pass of this family and order with its edge at f cycles a sample (Butterworth: the −3 dB point; the others: the end of the ripple band). */
export function lowpass(kind: Family, n: number, f: number, rp = 0.1, rs = 60): Zpk {
  const a = analogPrototype(kind, n, rp, rs), w = prewarp(f);
  return bilinearZpk({ z: a.z.map((q) => cx(q.re * w, q.im * w)), p: a.p.map((q) => cx(q.re * w, q.im * w)), k: a.k * w ** (a.p.length - a.z.length) });
}

/** A mask: pass to fp with ripple rp dB, stop from fs with at least rs dB, in cycles a sample. */
export interface Mask { fp: number; fs: number; rp: number; rs: number }
/** The mockup's: pass to 0.20 of Nyquist = 0.10 cycles a sample, stop from 0.25 of Nyquist = 0.125. */
export const MASK: Mask = { fp: 0.1, fs: 0.125, rp: 0.1, rs: 60 };
const natural = (m: Mask): number => Math.tan(Math.PI * m.fs) / Math.tan(Math.PI * m.fp);
const gains = (m: Mask): [number, number] => [gainOf(m.rp), gainOf(m.rs)];
export const butterOrder = (m: Mask = MASK): number => { const [gp, gs] = gains(m); return Math.ceil(Math.log10((gs - 1) / (gp - 1)) / (2 * Math.log10(natural(m)))); };
export const cheby1Order = (m: Mask = MASK): number => { const [gp, gs] = gains(m); return Math.ceil(Math.acosh(Math.sqrt((gs - 1) / (gp - 1))) / Math.acosh(natural(m))); };
export const ellipOrder = (m: Mask = MASK): number => {
  const [gp, gs] = gains(m), a1 = Math.sqrt((gp - 1) / (gs - 1)), a0 = 1 / natural(m);
  return Math.ceil((ellipk(a0 * a0) * ellipkm1(a1 * a1)) / (ellipkm1(a0 * a0) * ellipk(a1 * a1)));
};
export const maskOrder = (kind: Family, m: Mask = MASK): number => (kind === 'butter' ? butterOrder(m) : kind === 'cheby1' ? cheby1Order(m) : ellipOrder(m));
/** Butterworth's −3 dB edge for a mask, where scipy's buttord puts it: the passband just meets its ripple, the stopband has margin. */
export function butterEdge(m: Mask = MASK): number {
  const n = butterOrder(m), [gp] = gains(m);
  return Math.atan(Math.tan(Math.PI * m.fp) * (gp - 1) ** (-1 / (2 * n))) / Math.PI;
}
/** The design for a mask: the order the mask needs, and the filter. */
export function maskDesign(kind: Family, m: Mask = MASK): { order: number; zpk: Zpk } {
  const order = maskOrder(kind, m);
  return { order, zpk: lowpass(kind, order, kind === 'butter' ? butterEdge(m) : m.fp, m.rp, m.rs) };
}
/** Kaiser's estimate of a window FIR's length for the same mask (scipy's kaiserord): the larger attenuation the ripples ask for, and the transition width. */
export function kaiserTaps(m: Mask = MASK): number {
  const a = Math.max(m.rs, -20 * Math.log10(10 ** (m.rp / 20) - 1));
  return Math.ceil((a - 7.95) / 2.285 / (2 * Math.PI * (m.fs - m.fp)) + 1);
}

// ---- second-order sections --------------------------------------------------------------------------------------------------------------------

/** One section: b and a in z⁻¹, a[0] = 1. A first-order section has b[2] = a[2] = 0. */
export interface Sos { b: [number, number, number]; a: [number, number, number] }
const REAL = 1e-7;

/** zeros and poles → sections: conjugate pairs together, the pole pair nearest the circle first picks the nearest zero pair; the gain goes into the first section.
 *  The cascade is returned with the poles nearest the circle LAST, the order the chapter ends up recommending. */
export function zpkToSos(f: Zpk): Sos[] {
  const split = (v: readonly Cx[]) => {
    const up = v.filter((q) => q.im > REAL).sort((a, b) => cabs(b) - cabs(a));
    const reals = v.filter((q) => Math.abs(q.im) <= REAL).map((q) => q.re).sort((a, b) => Math.abs(b) - Math.abs(a));
    return { up, reals };
  };
  const P = split(f.p), Z = split(f.z), sections: Sos[] = [];
  const nearest = (to: Cx, pool: Cx[]): Cx | undefined => { let k = -1, d = Infinity; pool.forEach((q, i) => { const e = cabs(csub(q, to)); if (e < d) { d = e; k = i; } }); return k < 0 ? undefined : pool.splice(k, 1)[0]; };
  const nearestReal = (to: number, pool: number[]): number | undefined => { let k = -1, d = Infinity; pool.forEach((q, i) => { const e = Math.abs(q - to); if (e < d) { d = e; k = i; } }); return k < 0 ? undefined : pool.splice(k, 1)[0]; };
  const numFrom = (r: number[], c?: Cx): [number, number, number] => (c ? [1, -2 * c.re, c.re * c.re + c.im * c.im] : r.length >= 2 ? [1, -(r[0] + r[1]), r[0] * r[1]] : r.length === 1 ? [1, -r[0], 0] : [1, 0, 0]);
  for (const p of P.up) {
    const zc = nearest(p, Z.up);
    const zr: number[] = [];
    if (!zc) for (let i = 0; i < 2; i++) { const q = nearestReal(p.re, Z.reals); if (q !== undefined) zr.push(q); }
    sections.push({ b: numFrom(zr, zc), a: [1, -2 * p.re, p.re * p.re + p.im * p.im] });
  }
  while (P.reals.length) {
    const r: number[] = [P.reals.shift()!];
    if (P.reals.length) r.push(P.reals.shift()!);
    const zr: number[] = [], zc = r.length === 1 && !Z.reals.length ? nearest(cx(r[0]), Z.up) : undefined;
    if (!zc) for (let i = 0; i < r.length; i++) { const q = nearestReal(r[0], Z.reals); if (q !== undefined) zr.push(q); }
    sections.push({ b: numFrom(zr, zc), a: r.length === 2 ? [1, -(r[0] + r[1]), r[0] * r[1]] : [1, -r[0], 0] });
  }
  const out = sections.reverse();
  out[0] = { ...out[0], b: out[0].b.map((v) => v * f.k) as [number, number, number] };
  return out;
}
export const sosGain = (s: readonly Sos[], f: number): number => s.reduce((g, q) => g * gainAt(q.b, q.a, f), 1);
/** The cascade as one direct-form polynomial pair. */
export function sosToTf(s: readonly Sos[]): { b: number[]; a: number[] } {
  const trim = (c: number[]) => { const o = [...c]; while (o.length > 1 && o[o.length - 1] === 0) o.pop(); return o; };
  return { b: s.reduce<number[]>((c, q) => convolve(c, trim(q.b)), [1]), a: s.reduce<number[]>((c, q) => convolve(c, trim(q.a)), [1]) };
}
export const sosfilt = (s: readonly Sos[], x: readonly number[]): number[] => s.reduce<number[]>((v, q) => filter(q.b, q.a, v), [...x]);
/** Multiplications a sample: five for a biquad, three for a first-order section. */
export const sosMults = (s: readonly Sos[]): number => s.reduce((n, q) => n + (q.a[2] === 0 && q.b[2] === 0 ? 3 : 5), 0);
export const sosPeak = (s: readonly Sos[], n = 4000): number => { let m = 0; for (let i = 0; i <= n; i++) m = Math.max(m, sosGain(s, (i / n) * 0.5)); return m; };

// ---- coefficient sensitivity ------------------------------------------------------------------------------------------------------------------

/** Exact stability of a polynomial in z⁻¹ with integer coefficients (a[0] > 0): Schur–Cohn without a division, in BigInt. No root finder, so a double root on the
 *  circle, or a cluster of poles a hair apart, cannot fool it. The same steps as scripts/dsp/oracle.py's stable_exact. */
export function stableExact(coef: readonly (number | bigint)[]): boolean {
  let a = coef.map((v) => BigInt(v));
  while (a.length > 1) {
    const m = a.length - 1, last = a[m] < 0n ? -a[m] : a[m];
    if (a[0] <= 0n || last >= a[0]) return false;
    a = Array.from({ length: m }, (_, i) => a[0] * a[i] - a[m] * a[m - i]);
  }
  return a[0] > 0n;
}
const rnd = (v: number): number => Math.floor(v + 0.5);

/** Direct form: every coefficient after a₀ in one word of `bits` bits, its integer part (sign included) just big enough for the largest, rounded half up. */
export function quantDirect(coef: readonly number[], bits: number): { ints: number[]; f: number } {
  const mx = Math.max(...coef.map(Math.abs)), ib = Math.max(2, Math.floor(Math.log2(mx)) + 2), f = bits - ib;
  return { ints: coef.map((v) => rnd(v * 2 ** f)), f };
}
/** The feedback polynomial after rounding, as real numbers: [1, a₁ … a_n]. */
export function directHeld(a: readonly number[], bits: number): number[] {
  const { ints, f } = quantDirect(a.slice(1), bits);
  return [1, ...ints.map((v) => v / 2 ** f)];
}
export function directStable(a: readonly number[], bits: number): boolean {
  const { ints, f } = quantDirect(a.slice(1), bits);
  return stableExact([2 ** f, ...ints]);
}
/** A section's a₁, a₂ as Q2.(bits−2) integers, rounded half up and kept in range. */
export function sectionWords(a1: number, a2: number, bits: number): [number, number] {
  const S = 2 ** (bits - 2), hi = 2 ** (bits - 1) - 1;
  return [Math.max(-hi - 1, Math.min(hi, rnd(a1 * S))), Math.max(-hi - 1, Math.min(hi, rnd(a2 * S)))];
}
/** Stable by the triangle: |a₂| < 1 and |a₁| < 1 + a₂, exactly, on the integers. */
export const sectionStable = (a1: number, a2: number, bits: number): boolean => { const S = 2 ** (bits - 2), [x, y] = sectionWords(a1, a2, bits); return stableExact([S, x, y]); };
export const sosStable = (s: readonly Sos[], bits: number): boolean[] => s.map((q) => sectionStable(q.a[1], q.a[2], bits));
/** The largest pole radius of a polynomial in z⁻¹ (numerical: Durand–Kerner, so rough for clustered poles; stability itself comes from stableExact). */
export const poleRadiusOf = (a: readonly number[]): number => Math.max(0, ...polyRoots(a).map(cabs));

// ---- limit cycles: the search ------------------------------------------------------------------------------------------------------------------

/** The cycle of the chapter, on the gates and the model: a resonator at a quarter of the sample rate, radius 0.95 (a₂ = 14 787 / 2¹⁴), a₁ = 0, hit by one input word. */
export const LIMIT_CYCLE = {
  words: { b0: 1024, b1: 0, b2: 0, a1: 0, a2: coefWord(0.95 * 0.95) } as Words,
  amp: 8000, burst: 1, cycles: 140,
};
/** The largest output that rounding can hold up: |y| · a₂ rounds back to |y| while |y| ≤ ½ / (1 − a₂), for a pole pair at a quarter of the rate. */
export const deadBand = (a2: number): number => 0.5 / (1 - a2 / 2 ** BQ.cf);

export interface SweepRow { name: string; round: BqRound; extra: number }
export const SWEEP_VARIANTS: SweepRow[] = [
  { name: 'as built: rounds half up', round: 'half-up', extra: 0 },
  { name: 'floor (drop the bits)', round: 'trunc', extra: 0 },
  { name: 'rounds toward zero', round: 'zero', extra: 0 },
  { name: 'half up, 4 more bits in the delayed outputs', round: 'half-up', extra: 4 },
  { name: 'toward zero, 4 more bits in the delayed outputs', round: 'zero', extra: 4 },
];
/** Pole positions on the Q2.14 lattice (radius 0.90 … 0.97, angle 0.02 … 0.45 cycles, from the table below), a burst of two sizes and two lengths, then silence:
 *  how many of the runs end in a repeating non-zero output. Every run is a real run of the model. */
export function cycleSweep(variants: readonly SweepRow[] = SWEEP_VARIANTS, len = 800): { runs: number; cycling: number[] } {
  const rs = [0.9, 0.93, 0.95, 0.97], ts = [0.02, 0.05, 0.08, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45], cycling = variants.map(() => 0);
  let runs = 0;
  for (const r of rs) for (const t of ts) for (const amp of [8000, 30000]) for (const burst of [1, 3]) {
    const c: Words = { b0: 1024, b1: 0, b2: 0, a1: coefWord(-2 * r * Math.cos(2 * Math.PI * t)), a2: coefWord(r * r) };
    runs++;
    variants.forEach((v, i) => { if (findCycle(runBiquad(c, burstThenSilence(amp, burst, len), v), 16)) cycling[i]++; });
  }
  return { runs, cycling };
}

// ---- section order and scaling -----------------------------------------------------------------------------------------------------------------

const GRID = 1024;
const freqs = Array.from({ length: GRID + 1 }, (_, i) => (i / GRID) * 0.5);
/** The gain of the first i sections at each frequency, for i = 1 … n. */
function prefixes(s: readonly Sos[]): number[][] {
  const g = new Array<number>(freqs.length).fill(1);
  return s.map((q) => freqs.map((f, k) => (g[k] *= gainAt(q.b, q.a, f))).slice());
}
/** Peak gain from the input to each section's output: the largest sine that can enter before that section's word overflows is its reciprocal. */
export const prefixPeaks = (s: readonly Sos[]): number[] => prefixes(s).map((g) => Math.max(...g));
/** Scales each section's numerator so that the peak gain to every section's output is 1 (L∞ scaling): no sine at full scale overflows any word on the way. */
export function scaleSos(s: readonly Sos[]): Sos[] {
  const out: Sos[] = [];
  const g = new Array<number>(freqs.length).fill(1);
  for (const q of s) {
    const h = freqs.map((f, k) => g[k] * gainAt(q.b, q.a, f)), c = 1 / Math.max(...h);
    out.push({ a: q.a, b: q.b.map((v) => v * c) as [number, number, number] });
    freqs.forEach((_, k) => (g[k] = h[k] * c));
  }
  return out;
}
/** Output noise from rounding once at each section's output, in LSB² (one rounding is 1 / 12): section i's noise passes through the sections after it. */
export function noiseGain(s: readonly Sos[]): number {
  let total = 1;
  for (let i = 0; i < s.length - 1; i++) {
    let acc = 0;
    for (let k = 0; k <= GRID; k++) { let g = 1; for (let j = i + 1; j < s.length; j++) g *= gainAt(s[j].b, s[j].a, freqs[k]); acc += (k === 0 || k === GRID ? 0.5 : 1) * g * g; }
    total += acc / GRID;
  }
  return total;
}
/** The best signal-to-noise ratio a full-scale-limited sine can have through this cascade: the largest input that overflows no section, over the rounding noise. dB. */
export function cascadeSnr(s: readonly Sos[]): number {
  const amp = Math.min(1, 1 / Math.max(...prefixPeaks(s)));
  return 10 * Math.log10((amp * amp) / 2 / ((noiseGain(s) / 12) * 2 ** (-2 * BQ.f)));
}
/** Every order of the sections, as index lists. */
export function permutations(n: number): number[][] {
  if (n <= 1) return [Array.from({ length: n }, (_, i) => i)];
  return permutations(n - 1).flatMap((p) => Array.from({ length: n }, (_, k) => [...p.slice(0, k), n - 1, ...p.slice(k)]));
}
/** The cascade in fixed point, section by section (Biquad models with these coefficients), on a sine, against the same coefficients in floating point: the rounding noise it made, dB below the signal. */
export function measuredSnr(s: readonly Sos[], amp: number, f = 0.013, n = 6000): { snr: number; overflows: number } {
  const words = s.map((q) => wordsOf(q)), mods = words.map((c) => new Biquad(c));
  const x = Array.from({ length: n }, (_, i) => Math.round(amp * 2 ** BQ.f * Math.sin(2 * Math.PI * f * i)));
  let overflows = 0;
  const y = x.map((v) => { let t = v; for (const m of mods) { const acc = accumulate(m.c, t, m.x1, m.x2, m.y1, m.y2) / 2 ** BQ.drop; if (Math.abs(acc) > wordMax16) overflows++; t = m.step(t); } return t; });
  const real = sosfilt(words.map((c) => { const r = realOf(c); return { b: r.b as [number, number, number], a: r.a as [number, number, number] }; }), x);
  let e = 0, p = 0;
  for (let i = n >> 1; i < n; i++) { e += (y[i] - real[i]) ** 2; p += real[i] ** 2; }
  return { snr: 10 * Math.log10(p / e), overflows };
}
const wordMax16 = 2 ** (BQ.w - 1) - 1;
