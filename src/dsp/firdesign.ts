// FIR design for the signal processing level (DOM-free): the Parks–McClellan (Remez exchange) algorithm, the window method, a mask and its check, tap
// quantization, constant multipliers in canonical signed digits, and the structures that compute the same filter (folded, transposed, one MAC time-shared
// over the taps). tests/dsp-firdesign.test.ts holds the designs to scipy.signal.remez / firwin / kaiserord and to the mask each one is built for.
// Frequencies are cycles a sample (fs = 1, so Nyquist is 0.5); a mask given "as a fraction of Nyquist" is converted once, in MASK.
// Words, as dsp/fixed.ts: a model value is a signed JS number; the time-shared MAC keeps every bit and rounds once per output.

import { csdDigits } from '../lib/fft';
import { satTo, shiftRound, wrapTo, wordMax, wordMin } from './fixed';

// ---- the mask ---------------------------------------------------------------------------------------------------------------------------

export interface Mask {
  /** Passband edge and stopband edge, cycles a sample. */
  pass: number; stop: number;
  /** The passband may vary by this much, peak to peak, in dB: gain stays within 1 ± δp with 20 log10((1 + δp) / (1 − δp)) = rippleDb. */
  rippleDb: number;
  /** The stopband stays this far below 1, in dB. */
  stopDb: number;
}
/** The chapter's specification: pass to 0.20 of Nyquist, stop from 0.25 of it, 0.1 dB of ripple, 60 dB of rejection. */
export const MASK: Mask = { pass: 0.2 * 0.5, stop: 0.25 * 0.5, rippleDb: 0.1, stopDb: 60 };

export const deltaPass = (m: Mask): number => { const g = 10 ** (m.rippleDb / 20); return (g - 1) / (g + 1); };
export const deltaStop = (m: Mask): number => 10 ** (-m.stopDb / 20);
export const dB = (v: number): number => 20 * Math.log10(Math.max(v, 1e-30));

/** The frequencies of scipy.signal.freqz(worN = count, fs = 1): count points from 0 up to, not including, 0.5. The same grid in Python and here. */
export const GRID_POINTS = 8192;
export const gridFreq = (i: number, count = GRID_POINTS): number => i / (2 * count);

/** |H| on the freqz grid, by Horner's rule in the complex plane. */
export function magnitudeGrid(taps: readonly number[], count = GRID_POINTS): Float64Array {
  const out = new Float64Array(count), n = taps.length;
  for (let i = 0; i < count; i++) {
    const w = 2 * Math.PI * gridFreq(i, count), c = Math.cos(w), s = -Math.sin(w);
    let re = taps[n - 1], im = 0;
    for (let k = n - 2; k >= 0; k--) { const r = re * c - im * s + taps[k], q = re * s + im * c; re = r; im = q; }
    out[i] = Math.hypot(re, im);
  }
  return out;
}

export interface MaskReport {
  /** Largest |gain − 1| in the passband, and the same as a peak-to-peak ripple in dB. */
  passDev: number; passRippleDb: number;
  /** Largest gain in the stopband, and in dB. */
  stopPeak: number; stopDb: number;
  passOk: boolean; stopOk: boolean; ok: boolean;
}
export function maskReport(taps: readonly number[], mask: Mask = MASK, count = GRID_POINTS): MaskReport {
  const mag = magnitudeGrid(taps, count), dp = deltaPass(mask), ds = deltaStop(mask);
  let passDev = 0, stopPeak = 0, pmax = 0, pmin = Infinity;
  for (let i = 0; i < count; i++) {
    const f = gridFreq(i, count);
    if (f <= mask.pass) { passDev = Math.max(passDev, Math.abs(mag[i] - 1)); pmax = Math.max(pmax, mag[i]); pmin = Math.min(pmin, mag[i]); }
    else if (f >= mask.stop) stopPeak = Math.max(stopPeak, mag[i]);
  }
  const passOk = passDev <= dp, stopOk = stopPeak <= ds;
  return { passDev, passRippleDb: dB(pmax / pmin), stopPeak, stopDb: dB(stopPeak), passOk, stopOk, ok: passOk && stopOk };
}

// ---- Parks–McClellan --------------------------------------------------------------------------------------------------------------------

export interface RemezOptions { density?: number; maxIter?: number }
export interface RemezResult {
  taps: number[];
  /** The weighted error the exchange converged to: every extremal frequency has |W (D − A)| = delta. */
  delta: number;
  iterations: number;
  converged: boolean;
  /** The extremal frequencies of the last pass, cycles a sample. */
  extremal: number[];
}

/**
 * Equiripple linear-phase FIR of `numtaps` taps (symmetric: type I for odd, type II for even), by the Remez exchange. Arguments as scipy.signal.remez with
 * fs = 1: band edges in pairs [lo0, hi0, lo1, hi1, …] up to 0.5, the desired gain in each band (constant), and a weight for each band.
 * The dense grid is scipy's (16 points per extremal frequency, in proportion to the band widths), so the two designs compare tap for tap.
 */
export function remez(numtaps: number, edges: readonly number[], desired: readonly number[], weight?: readonly number[], opts: RemezOptions = {}): RemezResult {
  const density = opts.density ?? 16, maxIter = opts.maxIter ?? 100, nb = desired.length;
  if (edges.length !== 2 * nb) throw new Error('remez: two edges per band');
  const odd = numtaps % 2 === 1, r = odd ? (numtaps + 1) / 2 : numtaps / 2;
  const wts = weight ?? desired.map(() => 1);
  // the dense grid: round((hi − lo) / delf) points a band, the last put on the band edge
  const delf = 0.5 / (density * r);
  const grid: number[] = [], des: number[] = [], wt: number[] = [], bandOf: number[] = [];
  for (let b = 0; b < nb; b++) {
    let f = edges[2 * b];
    const k = Math.floor((edges[2 * b + 1] - f) / delf + 0.5);
    for (let i = 0; i < k; i++) { grid.push(f); des.push(desired[b]); wt.push(wts[b]); bandOf.push(b); f += delf; }
    grid[grid.length - 1] = edges[2 * b + 1];
  }
  if (!odd && grid[grid.length - 1] > 0.5 - delf) grid[grid.length - 1] = 0.5 - delf;
  // type II: the filter is cos(πf) times a polynomial, so the polynomial's targets are D / cos and its weights W · cos
  if (!odd) for (let i = 0; i < grid.length; i++) { const c = Math.cos(Math.PI * grid[i]); des[i] /= c; wt[i] *= c; }
  const G = grid.length, x = grid.map((f) => Math.cos(2 * Math.PI * f));
  if (G < r + 1) throw new Error('remez: too few grid points');
  const ext: number[] = Array.from({ length: r + 1 }, (_, i) => Math.floor((i * (G - 1)) / r));
  const err = new Float64Array(G);

  /** Barycentric weights of the points (their reciprocal products), scaled by a common factor so that no product leaves double range. */
  const baryWeights = (idx: number[]): number[] => {
    const logs: number[] = [], signs: number[] = [];
    for (let a = 0; a < idx.length; a++) {
      let l = 0, sg = 1;
      for (let c = 0; c < idx.length; c++) if (c !== a) { const d = x[idx[a]] - x[idx[c]]; l -= Math.log(Math.abs(d)); if (d < 0) sg = -sg; }
      logs.push(l); signs.push(sg);
    }
    const top = Math.max(...logs);
    return logs.map((l, a) => signs[a] * Math.exp(l - top));
  };

  let delta = 0, iterations = 0, converged = false;
  let ys: number[] = [], bw: number[] = [], pts: number[] = [];
  for (; iterations < maxIter; iterations++) {
    // the deviation that makes r + 1 alternating errors possible
    const ad = baryWeights(ext);
    let num = 0, den = 0;
    ext.forEach((g, k) => { num += ad[k] * des[g]; den += (ad[k] * (k % 2 ? -1 : 1)) / wt[g]; });
    delta = num / den;
    // the polynomial through the first r points
    pts = ext.slice(0, r);
    ys = pts.map((g, k) => des[g] - ((k % 2 ? -1 : 1) * delta) / wt[g]);
    bw = baryWeights(pts);
    const at = (xv: number): number => {
      let top = 0, bot = 0;
      for (let k = 0; k < r; k++) {
        const d = xv - x[pts[k]];
        if (d === 0) return ys[k];
        const t = bw[k] / d; top += t * ys[k]; bot += t;
      }
      return top / bot;
    };
    for (let i = 0; i < G; i++) err[i] = wt[i] * (des[i] - at(x[i]));
    // candidates: local extrema of the error within each band, its ends included
    const cand: number[] = [];
    for (let i = 0; i < G; i++) {
      const e = err[i], hasL = i > 0 && bandOf[i - 1] === bandOf[i], hasR = i < G - 1 && bandOf[i + 1] === bandOf[i];
      const l = hasL ? err[i - 1] : null, rr = hasR ? err[i + 1] : null;
      const up = (l === null || e >= l) && (rr === null || e >= rr), down = (l === null || e <= l) && (rr === null || e <= rr);
      if ((e > 0 && up) || (e < 0 && down) || (e === 0 && (up || down))) cand.push(i);
    }
    // keep them alternating: of two neighbours with the same sign, the larger
    let list: number[] = [];
    for (const i of cand) {
      const last = list[list.length - 1];
      if (last !== undefined && Math.sign(err[last]) === Math.sign(err[i])) { if (Math.abs(err[i]) > Math.abs(err[last])) list[list.length - 1] = i; } else list.push(i);
    }
    // too many: drop the smallest, from the ends, or from the inside together with its smaller neighbour
    while (list.length > r + 1) {
      if (list.length === r + 2) { if (Math.abs(err[list[0]]) < Math.abs(err[list[list.length - 1]])) list.shift(); else list.pop(); continue; }
      let m = 0;
      for (let k = 1; k < list.length; k++) if (Math.abs(err[list[k]]) < Math.abs(err[list[m]])) m = k;
      if (m === 0) { list.shift(); continue; }
      if (m === list.length - 1) { list.pop(); continue; }
      const drop = Math.abs(err[list[m - 1]]) < Math.abs(err[list[m + 1]]) ? m - 1 : m + 1;
      list.splice(Math.min(m, drop), 2);
    }
    if (list.length < r + 1) break;
    const mags = list.map((i) => Math.abs(err[i])), hi = Math.max(...mags), lo = Math.min(...mags);
    const same = list.every((g, k) => g === ext[k]);
    for (let k = 0; k <= r; k++) ext[k] = list[k];
    if (same || (hi - lo) / hi < 1e-12) { converged = true; iterations++; break; }
  }
  // the polynomial's value anywhere, and so the amplitude at the n frequencies k / n the inverse DFT needs
  const poly = (f: number): number => {
    const xv = Math.cos(2 * Math.PI * f);
    let top = 0, bot = 0;
    for (let k = 0; k < r; k++) { const d = xv - x[pts[k]]; if (d === 0) return ys[k]; const t = bw[k] / d; top += t * ys[k]; bot += t; }
    return top / bot;
  };
  const amp = (f: number): number => (odd ? poly(f) : Math.cos(Math.PI * f) * poly(f));
  const taps = new Array<number>(numtaps), M = (numtaps - 1) / 2, top = odd ? M : numtaps / 2 - 1;
  for (let m = 0; m < numtaps; m++) {
    let s = amp(0);
    for (let k = 1; k <= top; k++) s += 2 * amp(k / numtaps) * Math.cos((2 * Math.PI * k * (m - M)) / numtaps);
    taps[m] = s / numtaps;
  }
  // exactly symmetric, as the filter is
  for (let m = 0; m < numtaps >> 1; m++) { const v = (taps[m] + taps[numtaps - 1 - m]) / 2; taps[m] = v; taps[numtaps - 1 - m] = v; }
  return { taps, delta: Math.abs(delta), iterations, converged, extremal: ext.map((g) => grid[g]) };
}

/** A low-pass to a mask: pass to mask.pass with weight 1 / δp, stop from mask.stop with weight 1 / δs. */
export function remezLowpass(numtaps: number, mask: Mask = MASK, opts?: RemezOptions): RemezResult {
  return remez(numtaps, [0, mask.pass, mask.stop, 0.5], [1, 0], [1 / deltaPass(mask), 1 / deltaStop(mask)], opts);
}

/** The fewest taps from `from` upward whose design meets the mask, and that design. Searches one length at a time: length is not monotone for sure, so it stops at the first. */
export function fewestTaps(design: (n: number) => number[], mask: Mask, from: number, to: number, step = 1): { n: number; taps: number[]; report: MaskReport } | null {
  for (let n = from; n <= to; n += step) {
    const taps = design(n), report = maskReport(taps, mask);
    if (report.ok) return { n, taps, report };
  }
  return null;
}

// ---- windows ----------------------------------------------------------------------------------------------------------------------------

export type WindowKind = 'rectangular' | 'hann' | 'hamming' | 'blackman' | 'kaiser';
export const WINDOW_NAMES: Record<WindowKind, string> = { rectangular: 'Rectangular', hann: 'Hann', hamming: 'Hamming', blackman: 'Blackman', kaiser: 'Kaiser' };

/** Modified Bessel function of the first kind, order 0 (power series: every term is positive, so it cannot cancel). */
export function besselI0(x: number): number {
  const q = (x * x) / 4;
  let sum = 1, term = 1;
  for (let k = 1; k < 500; k++) { term *= q / (k * k); sum += term; if (term < sum * 1e-17) break; }
  return sum;
}

/** The symmetric window of n points (scipy.signal.get_window(…, fftbins = False)). */
export function windowOf(kind: WindowKind, n: number, beta = 0): number[] {
  const M = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => {
    if (n === 1) return 1;
    const t = (2 * Math.PI * i) / (n - 1);
    switch (kind) {
      case 'rectangular': return 1;
      case 'hann': return 0.5 - 0.5 * Math.cos(t);
      case 'hamming': return 0.54 - 0.46 * Math.cos(t);
      case 'blackman': return 0.42 - 0.5 * Math.cos(t) + 0.08 * Math.cos(2 * t);
      case 'kaiser': return besselI0(beta * Math.sqrt(Math.max(0, 1 - ((i - M) / M) ** 2))) / besselI0(beta);
    }
  });
}

/** scipy.signal.kaiserord: taps and β for a ripple (dB, the same in both bands) and a transition width given as a fraction of Nyquist. */
export function kaiserord(rippleDb: number, widthNyquist: number): { numtaps: number; beta: number } {
  const A = Math.abs(rippleDb);
  const beta = A > 50 ? 0.1102 * (A - 8.7) : A > 21 ? 0.5842 * (A - 21) ** 0.4 + 0.07886 * (A - 21) : 0;
  return { numtaps: Math.ceil((A - 7.95) / 2.285 / (Math.PI * widthNyquist) + 1), beta };
}

/** Kaiser's estimate of a length that meets δp and δs over a transition of Δf cycles a sample. An estimate: it ignores the algorithm's own freedom. */
export const kaiserLengthEstimate = (dp: number, ds: number, df: number): number => Math.ceil((-20 * Math.log10(Math.sqrt(dp * ds)) - 13) / (14.6 * df) + 1);

/** The window method (scipy.signal.firwin, scale = True): an ideal low-pass with cut-off fc, times a window, scaled to a gain of 1 at DC. */
export function firwinLowpass(n: number, fc: number, kind: WindowKind, beta = 0): number[] {
  const M = (n - 1) / 2, w = windowOf(kind, n, beta);
  const h = w.map((v, i) => { const t = i - M; return v * (t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t)); });
  const s = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / s);
}

/** The Kaiser design of the chapter: kaiserord for the tighter of the two ripples, a cut-off midway through the transition. */
export function kaiserDesign(mask: Mask = MASK): { numtaps: number; beta: number; taps: number[] } {
  const rip = -dB(Math.min(deltaPass(mask), deltaStop(mask))), { numtaps, beta } = kaiserord(rip, (mask.stop - mask.pass) / 0.5);
  return { numtaps, beta, taps: firwinLowpass(numtaps, (mask.pass + mask.stop) / 2, 'kaiser', beta) };
}

// ---- linear phase ---------------------------------------------------------------------------------------------------------------------

export const isSymmetric = (h: readonly number[], tol = 0): boolean => h.every((v, i) => Math.abs(v - h[h.length - 1 - i]) <= tol);
/** Linear phase has one delay for every frequency: half the length less a half sample. */
export const linearDelay = (n: number): number => (n - 1) / 2;
/** Folding adds the two samples a tap pair multiplies: half the multiplications, rounded up (the middle tap of an odd length has none to pair with). */
export const foldedMults = (n: number): number => Math.ceil(n / 2);

/** The same output three ways, integer taps and samples so that they can be compared exactly. */
export function directFir(h: readonly number[], x: readonly number[]): number[] {
  return x.map((_, n) => h.reduce((s, c, k) => s + c * (x[n - k] ?? 0), 0));
}
export function foldedFir(h: readonly number[], x: readonly number[]): number[] {
  const N = h.length;
  return x.map((_, n) => {
    let s = 0;
    for (let k = 0; k < N >> 1; k++) s += h[k] * ((x[n - k] ?? 0) + (x[n - (N - 1 - k)] ?? 0));
    if (N % 2) s += h[N >> 1] * (x[n - (N >> 1)] ?? 0);
    return s;
  });
}
/** Transposed form: the input reaches every multiplier at once, and the registers hold partial sums that move toward the output. */
export function transposedFir(h: readonly number[], x: readonly number[]): number[] {
  const N = h.length, reg = new Array<number>(N - 1).fill(0), out: number[] = [];
  for (const v of x) {
    out.push(h[0] * v + (reg[0] ?? 0));
    for (let k = 0; k < N - 1; k++) reg[k] = h[k + 1] * v + (reg[k + 1] ?? 0);
  }
  return out;
}

// ---- tap words --------------------------------------------------------------------------------------------------------------------------

/** A tap as an integer of `frac` bits after the point, rounded half up and saturated to a w-bit word. */
export const tapWord = (h: number, frac: number, w: number): number => satTo(Math.floor(h * 2 ** frac + 0.5), w);
export const tapWords = (taps: readonly number[], frac: number, w: number): number[] => taps.map((h) => tapWord(h, frac, w));
/** What the words mean. */
export const tapValues = (words: readonly number[], frac: number): number[] => words.map((v) => v / 2 ** frac);

/** The most bits after the point a w-bit word can give these taps: the largest tap fills the word. */
export function widestFrac(taps: readonly number[], w: number): number {
  const big = Math.max(...taps.map(Math.abs));
  let f = w - 1;
  while (f > 0 && Math.floor(big * 2 ** f + 0.5) > wordMax(w)) f--;
  while (Math.floor(big * 2 ** (f + 1) + 0.5) <= wordMax(w)) f++;
  return f;
}

/** The fewest bits after the point whose rounded taps still meet the mask, with how many bits the largest tap then needs. */
export function fewestFrac(taps: readonly number[], mask: Mask = MASK, from = 4, to = 30): { frac: number; bits: number; report: MaskReport } | null {
  const big = Math.max(...taps.map(Math.abs));
  for (let f = from; f <= to; f++) {
    const q = tapValues(tapWords(taps, f, 40), f), report = maskReport(q, mask);
    if (report.ok) return { frac: f, bits: Math.ceil(Math.log2(Math.floor(big * 2 ** f + 0.5) + 1)) + 1, report };
  }
  return null;
}

// ---- constants in canonical signed digits --------------------------------------------------------------------------------------------

export interface CsdTerm { pos: number; neg: boolean }
/** c = Σ ±2^pos with the fewest non-zero digits, for any integer: the sign goes to every digit of a negative constant. */
export function csdOf(c: number): CsdTerm[] {
  const d = csdDigits(Math.abs(c));
  return c < 0 ? d.map((t) => ({ pos: t.pos, neg: !t.neg })) : d;
}
export const csdValue = (t: readonly CsdTerm[]): number => t.reduce((s, d) => s + (d.neg ? -1 : 1) * 2 ** d.pos, 0);
/** x · c as the shift-and-add the gates do. */
export const csdMul = (c: number, x: number): number => csdOf(c).reduce((s, d) => s + (d.neg ? -1 : 1) * x * 2 ** d.pos, 0);
/** Adders a constant multiplier needs: one fewer than its non-zero digits when one is positive to start from (a lone positive digit is a shift); a sum of negative digits only starts from 0 − term. */
export const csdAdders = (c: number): number => { const t = csdOf(c); return t.length === 0 ? 0 : t.length - (t.some((d) => !d.neg) ? 1 : 0); };
/** Binary has digits too: the ones of |c|. */
export const binaryDigits = (c: number): number => { let v = Math.abs(c), n = 0; while (v) { n += v & 1; v = Math.floor(v / 2); } return n; };

// ---- one MAC over the taps ---------------------------------------------------------------------------------------------------------

export interface MacConfig {
  /** The tap words (integers); the filter is len(taps) cycles a sample. */
  taps: readonly number[];
  /** Sample and tap word width: the multiplier is w × w signed. */
  w: number;
  /** Bits after the point in a tap word: the output comes down by this many places. */
  frac: number;
  /** Guard bits above the 2w-bit product. */
  guard: number;
}
export const macAccWidth = (c: MacConfig): number => 2 * c.w + c.guard;

/**
 * lib/firmac.ts cycle for cycle. The sample memory is a ring: while k < N − 1 it turns one place a cycle (head = x[n − k]); in the last cycle only
 * the head takes the new sample and the rest stay, so the oldest falls out and the ring is in order again. The accumulator starts afresh when k = 0.
 * A finished sum is rounded half up and clamped once, in the cycle after it, into the output register.
 */
export class MacModel {
  ring: number[]; k = 0; acc = 0; y = 0; sat = 0;
  readonly N: number; readonly A: number;
  constructor(readonly cfg: MacConfig) { this.N = cfg.taps.length; this.A = macAccWidth(cfg); this.ring = new Array<number>(this.N).fill(0); }
  get first(): boolean { return this.k === 0; }
  get last(): boolean { return this.k === this.N - 1; }
  /** The rounded and clamped value of the accumulator, and whether the clamp acted. */
  get result(): { y: number; sat: number } {
    const { w, frac } = this.cfg, A = this.A;
    const r = wrapTo(shiftRound(this.acc, frac, 'half-up'), A - frac);
    const y = satTo(r, w);
    return { y, sat: y === r ? 0 : 1 };
  }
  /** The clock edge, with x on the input. */
  edge(x: number): void {
    const c = this.cfg, p = this.ring[0] * c.taps[this.k];
    const accN = wrapTo((this.first ? 0 : this.acc) + p, this.A);
    if (this.first) { const r = this.result; this.y = r.y; this.sat = r.sat; }
    if (this.last) this.ring[0] = x;
    else this.ring = [...this.ring.slice(1), this.ring[0]];
    this.k = this.last ? 0 : this.k + 1;
    this.acc = accN;
  }
}

/** Guard bits that make the accumulator unable to overflow for any samples: the sum of |tap| times the largest sample, in bits above the product. */
export function guardFor(taps: readonly number[], w: number): number {
  const worst = taps.reduce((s, c) => s + Math.abs(c), 0) * 2 ** (w - 1);
  return Math.max(0, Math.ceil(Math.log2(worst + 1)) + 1 - 2 * w);
}
/** The worst case when every tap's product can be as large as the largest word: log2 N guard bits, whatever the taps. */
export const guardForN = (n: number): number => Math.ceil(Math.log2(n));

/** Clamp bounds as a convenience for tests. */
export const outRange = (w: number): [number, number] => [wordMin(w), wordMax(w)];

// ---- the filter drawn in gates ----------------------------------------------------------------------------------------------------------

/** What the gate-level scene filters with: 16 taps, equal weights, pass to 0.10 and stop from 0.20 cycles a sample. A looser mask than the chapter's: sixteen taps cannot reach 60 dB. */
export const SCENE_MASK: Mask = { pass: 0.1, stop: 0.2, rippleDb: 1, stopDb: 30 };
export const SCENE_TAPS = 16;
let sceneMemo: { design: RemezResult; words: number[]; cfg: MacConfig; report: MaskReport } | null = null;
export function sceneMac(): { design: RemezResult; words: number[]; cfg: MacConfig; report: MaskReport } {
  if (!sceneMemo) {
    const design = remez(SCENE_TAPS, [0, SCENE_MASK.pass, SCENE_MASK.stop, 0.5], [1, 0]), w = 16, frac = widestFrac(design.taps, w), words = tapWords(design.taps, frac, w);
    sceneMemo = { design, words, cfg: { taps: words, w, frac, guard: guardFor(words, w) }, report: maskReport(tapValues(words, frac), SCENE_MASK) };
  }
  return sceneMemo;
}

// ---- searching and listening ----------------------------------------------------------------------------------------------------------

/** |H| at one frequency (cycles a sample). */
export function gainOf(taps: readonly number[], f: number): number {
  let re = 0, im = 0;
  taps.forEach((h, k) => { re += h * Math.cos(2 * Math.PI * f * k); im -= h * Math.sin(2 * Math.PI * f * k); });
  return Math.hypot(re, im);
}

/**
 * The smallest odd length in [lo, hi] that meets the mask (odd only, so every candidate is a type I filter). Bisection finds where meeting begins, and a scan
 * of the 15 odd lengths below it settles the first: meeting a mask is not quite monotone in length for a window design, and a bisection alone can land a few taps high.
 */
export function fewestOdd(design: (n: number) => number[], mask: Mask, lo: number, hi: number): number | null {
  let a = lo % 2 ? lo : lo + 1, b = hi % 2 ? hi : hi - 1;
  if (!maskReport(design(b), mask).ok) return null;
  while (a < b) {
    const m = (a + b) / 2 | 0, mid = m % 2 ? m : m + 1;
    if (mid >= b) break;
    if (maskReport(design(mid), mask).ok) b = mid; else a = mid + 2;
  }
  for (let n = Math.max(lo % 2 ? lo : lo + 1, b - 30); n < b; n += 2) if (n % 2 === 1 && maskReport(design(n), mask).ok) return n;
  return b;
}
