// Filters as polynomials in z⁻¹ (DOM-free). b and a are scipy's convention: a[0] = 1, y[n] = Σ b[k] x[n−k] − Σ a[k] y[n−k], k ≥ 1 for a.
// Frequency is cycles a sample, as in comm/signals.ts. tests/dsp-zplane.test.ts holds all of this to scipy's vectors (tests/dsp/vectors/zplane.json).

export interface Cx { re: number; im: number }

/** The difference equation over a block, from rest. */
export function filter(b: readonly number[], a: readonly number[], x: readonly number[]): number[] {
  const y = new Array<number>(x.length);
  for (let n = 0; n < x.length; n++) {
    let v = 0;
    for (let k = 0; k < b.length && k <= n; k++) v += b[k] * x[n - k];
    for (let k = 1; k < a.length && k <= n; k++) v -= a[k] * y[n - k];
    y[n] = v;
  }
  return y;
}

export const impulse = (b: readonly number[], a: readonly number[], n: number): number[] => filter(b, a, Array.from({ length: n }, (_, i) => (i ? 0 : 1)));

export function convolve(x: readonly number[], h: readonly number[]): number[] {
  const y = new Array<number>(x.length + h.length - 1).fill(0);
  x.forEach((v, i) => h.forEach((u, k) => { y[i + k] += v * u; }));
  return y;
}

/** Σ c[k] z⁻ᵏ at z = e^(j2πf). */
function polyAt(c: readonly number[], f: number): Cx {
  let re = 0, im = 0;
  c.forEach((v, k) => { re += v * Math.cos(2 * Math.PI * f * k); im -= v * Math.sin(2 * Math.PI * f * k); });
  return { re, im };
}
/** H(e^(j2πf)). A pole on the circle at f gives a non-finite value. */
export function response(b: readonly number[], a: readonly number[], f: number): Cx {
  const n = polyAt(b, f), d = polyAt(a, f), m = d.re * d.re + d.im * d.im;
  return { re: (n.re * d.re + n.im * d.im) / m, im: (n.im * d.re - n.re * d.im) / m };
}
export const gainAt = (b: readonly number[], a: readonly number[], f: number): number => { const r = response(b, a, f); return Math.hypot(r.re, r.im); };
export const phaseAt = (b: readonly number[], a: readonly number[], f: number): number => { const r = response(b, a, f); return Math.atan2(r.im, r.re); };

/** The roots in z of c[0] z^n + c[1] z^(n−1) + … + c[n]: Durand–Kerner. Leading and trailing zeros are handled first. */
export function polyRoots(c: readonly number[]): Cx[] {
  let lo = 0, hi = c.length - 1;
  while (lo < hi && c[lo] === 0) lo++;
  const zeros: Cx[] = [];
  while (hi > lo && c[hi] === 0) { hi--; zeros.push({ re: 0, im: 0 }); }
  const p = c.slice(lo, hi + 1).map((v) => v / c[lo]), n = p.length - 1;
  if (n <= 0) return zeros;
  const R = 1 + Math.max(...p.slice(1).map(Math.abs));
  const z = Array.from({ length: n }, (_, i): Cx => ({ re: 0.5 * R * Math.cos(2.4 * i + 0.4), im: 0.5 * R * Math.sin(2.4 * i + 0.4) }));
  for (let it = 0; it < 2000; it++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      let vr = 1, vi = 0;
      for (let k = 1; k <= n; k++) { const t = vr * z[i].re - vi * z[i].im + p[k]; vi = vr * z[i].im + vi * z[i].re; vr = t; }
      let dr = 1, di = 0;
      for (let j = 0; j < n; j++) if (j !== i) { const xr = z[i].re - z[j].re, xi = z[i].im - z[j].im, t = dr * xr - di * xi; di = dr * xi + di * xr; dr = t; }
      const m = dr * dr + di * di || 1e-300, sr = (vr * dr + vi * di) / m, si = (vi * dr - vr * di) / m;
      z[i] = { re: z[i].re - sr, im: z[i].im - si };
      moved = Math.max(moved, Math.hypot(sr, si));
    }
    if (moved < 1e-14) break;
  }
  return [...z, ...zeros];
}

/** The polynomial with these roots (conjugates included by the caller): 1, c[1], … in z⁻¹; the real parts. */
export function polyFromRoots(roots: readonly Cx[]): number[] {
  let re = [1], im = [0];
  for (const r of roots) {
    const nr = new Array<number>(re.length + 1).fill(0), ni = new Array<number>(re.length + 1).fill(0);
    re.forEach((v, k) => { nr[k] += v; ni[k] += im[k]; nr[k + 1] -= v * r.re - im[k] * r.im; ni[k + 1] -= v * r.im + im[k] * r.re; });
    re = nr; im = ni;
  }
  return re;
}

/** The largest pole's distance from the origin; a filter from rest is stable exactly when this is under 1. */
export const poleRadius = (a: readonly number[]): number => Math.max(0, ...polyRoots(a).map((r) => Math.hypot(r.re, r.im)));
export const isStable = (a: readonly number[]): boolean => poleRadius(a) < 1 - 1e-9;

/** A conjugate pair at radius r, angle θ (radians), as z⁻¹ coefficients 1, −2r cos θ, r². */
export const pairCoeffs = (r: number, t: number): number[] => [1, -2 * r * Math.cos(t), r * r];

/** A conjugate pair: radius and angle (radians, 0 … π); at 0 or π it is a double real root. */
export interface Pair { r: number; t: number }
/** The polynomial in z⁻¹ of these pairs (for no pairs, 1). */
export const pairsPoly = (pairs: readonly Pair[]): number[] => pairs.reduce<number[]>((c, p) => convolve(c, pairCoeffs(p.r, p.t)), [1]);

/** A pair at angle 0 or π is a double real root: on the circle it grows like n, and inside it decays like n rⁿ. */
const isReal = (p: Pair): boolean => Math.abs(Math.sin(p.t)) < 1e-9;
export type PoleState = 'none' | 'stable' | 'on the circle' | 'unstable';
/** From the pairs themselves, not from a root finder: a double root on the circle is exactly where rounding would decide it. */
export function stateOfPoles(poles: readonly Pair[]): PoleState {
  if (!poles.length) return 'none';
  if (poles.some((p) => p.r > 1 + 1e-12 || (p.r >= 1 - 1e-12 && isReal(p)))) return 'unstable';
  return poles.some((p) => p.r >= 1 - 1e-12) ? 'on the circle' : 'stable';
}
/** Samples for a pole pair's envelope to fall to 1 % and stay there: rⁿ, or (n + 1) rⁿ for a double real root. */
export function settleOfPair(p: Pair): number {
  if (p.r >= 1) return Infinity;
  if (p.r <= 0) return 1;
  if (!isReal(p)) return Math.ceil(Math.log(0.01) / Math.log(p.r));
  let n = 1;
  while ((n + 1) * p.r ** n > 0.01) n++;
  return n;
}

/** |H| read off the plane: the distances from the point on the circle to each zero, over those to each pole. Equal to gainAt of the polynomials. */
export function gainByDistances(zeros: readonly Pair[], poles: readonly Pair[], f: number): number {
  const x = Math.cos(2 * Math.PI * f), y = Math.sin(2 * Math.PI * f);
  const d = (p: Pair, sign: number) => Math.hypot(x - p.r * Math.cos(p.t), y - sign * p.r * Math.sin(p.t));
  let g = 1;
  for (const z of zeros) g *= d(z, 1) * d(z, -1);
  for (const p of poles) g /= d(p, 1) * d(p, -1);
  return g;
}

/** Group delay in samples at f: −dφ/dω, exact for a polynomial as Re(Σ k c[k] z⁻ᵏ / Σ c[k] z⁻ᵏ), numerator minus denominator. */
export function groupDelay(b: readonly number[], a: readonly number[], f: number): number {
  const of = (c: readonly number[]) => {
    const n = polyAt(c, f), r = polyAt(c.map((v, k) => k * v), f), m = n.re * n.re + n.im * n.im;
    return (r.re * n.re + r.im * n.im) / m;
  };
  return of(b) - of(a);
}
