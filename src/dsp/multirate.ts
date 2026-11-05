// Changing the sample rate (DOM-free): decimation and interpolation, polyphase, half-band filters and the CIC. The golden model of lib/multirate.ts clock by clock, and the arithmetic of what each
// form costs. Frequencies are cycles a sample at the input's rate. Filters come from comm/signals.ts; the reference for resampling is scipy's (tests/dsp/vectors/multirate.json).

import { firFilter, firGain, windowedSinc } from '../comm/signals';
import { wrapTo } from './fixed';

/** Keep every R-th sample, from the first. Nothing else: what lay above the new half-rate folds down. */
export const downsample = (x: readonly number[], R: number, phase = 0): number[] => x.filter((_, i) => i % R === phase);
/** L − 1 zeros after each sample. The spectrum repeats: the images are what the filter after it removes. */
export const upsample = (x: readonly number[], L: number): number[] => x.flatMap((v) => [v, ...new Array<number>(L - 1).fill(0)]);

/** The textbook way: filter at the high rate, then throw away R − 1 samples of the work. */
export const decimateDirect = (h: readonly number[], R: number, x: readonly number[]): number[] => downsample(firFilter(h, x), R);

/**
 * The same output, computed branch by branch. Branch p holds every R-th sample and every R-th tap, so a tap only ever meets a sample that will be kept:
 * y[k] = Σₚ Σⱼ h[p + Rj] · x[Rk − p − Rj].
 */
export function polyphaseDecimate(h: readonly number[], R: number, x: readonly number[]): number[] {
  const out: number[] = [];
  for (let t = 0; t < x.length; t += R) {
    let sum = 0;
    for (let p = 0; p < R; p++) for (let j = 0; p + R * j < h.length; j++) sum += h[p + R * j] * (x[t - p - R * j] ?? 0);
    out.push(sum);
  }
  return out;
}

/** Interpolation by L: the same idea from the other side. Each input sample passes L branches, each with every L-th tap. */
export function polyphaseInterpolate(h: readonly number[], L: number, x: readonly number[]): number[] {
  const out: number[] = [];
  for (let n = 0; n < x.length; n++) {
    for (let p = 0; p < L; p++) {
      let sum = 0;
      for (let j = 0; p + L * j < h.length; j++) sum += h[p + L * j] * (x[n - j] ?? 0);
      out.push(sum);
    }
  }
  return out;
}

/** Up by L, filter, down by M, the way scipy.signal.upfirdn does: no scaling, no alignment. */
export const upfirdn = (h: readonly number[], L: number, M: number, x: readonly number[]): number[] => {
  const up = upsample(x, L), padded = [...up, ...new Array<number>(h.length - 1).fill(0)];
  return downsample(firFilter(h, padded), M).slice(0, Math.floor(((x.length - 1) * L + h.length - 1) / M) + 1);
};

/** Multiplications for each input sample. */
export const directCost = (taps: number): number => taps;
export const polyphaseCost = (taps: number, R: number): number => taps / R;
/** Half-band taps are zero at every even distance from the middle, so about half need no multiplier, and folding halves the rest. */
export function halfBand(n: number): number[] {
  const t = windowedSinc(n, 0.25);
  return t.map((v) => (Math.abs(v) < 1e-12 ? 0 : v));
}
export const nonZero = (h: readonly number[]): number => h.filter((v) => v !== 0).length;

/** The fewest odd taps of the chapter's windowed design that keep [0, pass] within `ripple` dB of 0 dB and everything from `stop` up below −atten dB. Hamming's window stops near 53 dB. */
export function tapsFor(pass: number, stop: number, atten: number, ripple = 0.5): { n: number; h: number[] } {
  const fc = (pass + stop) / 2, ok = (h: readonly number[]) => {
    for (let i = 0; i <= 12; i++) { const g = firGain(h, (pass * i) / 12); if (Math.abs(20 * Math.log10(g)) > ripple) return false; }
    for (let i = 0; i <= 160; i++) { const f = stop + ((0.5 - stop) * i) / 160, g = Math.abs(firGain(h, f)); if (20 * Math.log10(Math.max(g, 1e-12)) > -atten) return false; }
    return true;
  };
  for (let n = Math.max(3, Math.floor(2 / (stop - pass)) | 1); n < 200001; n += 2) {
    const h = windowedSinc(n, fc);
    if (ok(h)) return { n, h };
  }
  throw new Error('no such filter');
}

// ---- CIC ---------------------------------------------------------------------------------------------------------------------------

/** Bits the registers must grow by: Hogenauer's N log₂ (R M), here with M = 1 (and R a power of two, so exact). */
export const cicGrowth = (N: number, R: number): number => Math.ceil(N * Math.log2(R));
export const cicWidth = (N: number, R: number, wIn: number): number => wIn + cicGrowth(N, R);
export const cicDcGain = (N: number, R: number): number => R ** N;
/** The response at frequency f of the input's rate, as a share of its DC gain: (sin(π R f) / (R sin(π f)))^N. */
export function cicResponse(N: number, R: number, f: number): number {
  const s = Math.sin(Math.PI * f);
  return Math.abs(s) < 1e-12 ? 1 : Math.abs(Math.sin(Math.PI * R * f) / (R * s)) ** N;
}
/** The CIC's response as an ordinary FIR: a boxcar of R, convolved with itself N times. */
export function cicTaps(N: number, R: number): number[] {
  let t = [1];
  for (let i = 0; i < N; i++) {
    const out = new Array<number>(t.length + R - 1).fill(0);
    t.forEach((v, a) => { for (let b = 0; b < R; b++) out[a + b] += v; });
    t = out;
  }
  return t;
}
/** How far down what folds onto the edge of the kept band comes: the worst alias at output frequency `edge`, given as a share of the output's rate. In dB, negative. */
export function cicAliasDb(N: number, R: number, edge: number): number {
  const passF = edge / R;
  let worst = 0;
  for (let k = 1; k <= Math.floor(R / 2); k++) worst = Math.max(worst, cicResponse(N, R, k / R - passF));
  return 20 * Math.log10(worst / cicResponse(N, R, passF));
}

/** The gates' behaviour. Every register wraps at w bits and that is harmless, as long as w holds the result. */
export class CicModel {
  ints: number[];
  combs: number[];
  cnt = 0;
  y = 0;
  valid = false;
  constructor(public N: number, public R: number, public w: number) {
    this.ints = new Array<number>(N).fill(0);
    this.combs = new Array<number>(N).fill(0);
  }
  edge(x: number): void {
    const { N, R, w } = this, was = this.ints;
    this.ints = was.map((r, i) => wrapTo(r + (i === 0 ? x : was[i - 1]), w));
    this.valid = this.cnt === R - 1;
    if (this.valid) {
      let v = was[N - 1];
      this.combs = this.combs.map((d) => { const o = wrapTo(v - d, w), keep = v; v = o; return keep; });
      this.y = v;
    }
    this.cnt = (this.cnt + 1) % R;
  }
}

// ---- a polyphase decimator ------------------------------------------------------------------------------------------------------------

export interface PolySpec { R: number; M: number; w: number; taps: readonly number[] }

/** A low-pass for a decimator of R, in w-bit two's complement, summing to about 2^(w − 1): the model and the gates share it. */
export function polyTaps(R: number, M: number, w: number): number[] {
  const h = windowedSinc(R * M, 0.45 / R), dc = h.reduce((a, b) => a + b, 0);
  return h.map((v) => Math.round((v / dc) * 2 ** (w - 1)));
}

/**
 * The gates' behaviour, M multipliers for R·M taps. A sample goes into its branch at one edge; on the next, that branch's M products join the sum. After the R-th branch of a group the sum is an output:
 * y = Σ h[j] x[t − j], with no rounding: the sum is held in full.
 */
export class PolyModel {
  lines: number[][];
  cnt = 0;
  acc = 0;
  y = 0;
  valid = false;
  /** False until something has loaded: the first clock has no branch to finish. */
  private run = false;
  constructor(public s: PolySpec) { this.lines = Array.from({ length: s.R }, () => new Array<number>(s.M).fill(0)); }
  /** The branch the last edge loaded. */
  private last(): number { const { R } = this.s; return R - 1 - ((this.cnt + R - 1) % R); }
  edge(x: number): void {
    const { R, M, taps } = this.s, p = this.last();
    let term = 0;
    for (let k = 0; k < M; k++) term += taps[p + R * k] * this.lines[p][k];
    const sum = (p === R - 1 ? 0 : this.acc) + term;
    this.acc = sum;
    this.valid = p === 0 && this.run;
    if (this.valid) this.y = sum;
    this.run = true;
    const q = R - 1 - this.cnt;
    this.lines[q] = [x, ...this.lines[q].slice(0, M - 1)];
    this.cnt = (this.cnt + 1) % R;
  }
}
