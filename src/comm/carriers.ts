// Many carriers' models (DOM-free): how to share a power budget among tones, and what breaks a block of tones. Closed forms; tests/comm-carriers.test.ts holds water-filling to a
// hand-solved case and to a search, greedy loading to an exhaustive search, the peak's distribution and the offset's interference to runs of the real transform.

import { rng } from '../phys/line';
import { fft, type Cx } from './fourier';

const log2p1 = (x: number): number => Math.log2(1 + x);

export interface PowerPlan {
  /** Power per tone, summing to the budget. */
  power: number[];
  /** Bits per tone: log₂(1 + g p / Γ), not rounded. */
  bits: number[];
  total: number;
  /** The water level: 1 / g + p on every tone in use (water-filling only). */
  level: number;
  used: number;
}

const plan = (g: readonly number[], power: number[], level: number, gamma: number): PowerPlan => {
  const bits = power.map((p, i) => log2p1((g[i] * p) / gamma));
  return { power, bits, total: bits.reduce((a, b) => a + b, 0), level, used: power.filter((p) => p > 0).length };
};

/** `g[k]`: the tone's SNR per unit of power. The whole budget, spread evenly over all the tones. */
export const flatPower = (g: readonly number[], budget: number, gamma = 1): PowerPlan => plan(g, g.map(() => budget / g.length), 0, gamma);

/** Evenly, over the tones that are worth it: the same level of power on the best `n` (the most a plan with one power can do). */
export function flatBest(g: readonly number[], budget: number, gamma = 1): PowerPlan {
  const order = g.map((v, i) => [v, i] as const).sort((a, b) => b[0] - a[0]);
  let best = flatPower(g, budget, gamma);
  for (let n = 1; n < g.length; n++) {
    const pw = new Array<number>(g.length).fill(0);
    for (let i = 0; i < n; i++) pw[order[i][1]] = budget / n;
    const c = plan(g, pw, 0, gamma);
    if (c.total > best.total) best = c;
  }
  return best;
}

/**
 * Water-filling: maximize Σ log₂(1 + g p / Γ) with Σ p = budget. The solution has p = μ − Γ / g on every tone where that is positive and 0 elsewhere: pour the budget over a floor of height
 * Γ / g, and the water finds one level. Exact: sort by floor, and the used set is the longest prefix whose level clears its last floor.
 */
export function waterFill(g: readonly number[], budget: number, gamma = 1): PowerPlan {
  const floors = g.map((v) => (v > 0 ? gamma / v : Infinity)), order = floors.map((_, i) => i).sort((a, b) => floors[a] - floors[b]);
  let sum = 0, n = 0, level = 0;
  for (let i = 0; i < order.length; i++) {
    const f = floors[order[i]];
    if (!Number.isFinite(f)) break;
    const lv = (budget + sum + f) / (i + 1);
    if (lv <= f) break;
    sum += f; n = i + 1; level = lv;
  }
  const power = g.map((_, i) => 0 * i);
  for (let i = 0; i < n; i++) power[order[i]] = level - floors[order[i]];
  return plan(g, power, level, gamma);
}

export interface Loading { bits: number[]; total: number; energy: number }

/**
 * Greedy discrete loading (Hughes-Hartogs): whole bits, each to the tone where one more bit costs least. A tone with b bits holds E(b) = Γ (2^b − 1) / g, so bit b + 1 costs Γ 2^b / g.
 * The costs on each tone rise, so the greedy order is optimal for a budget (tests/comm-carriers.test.ts checks it against every allocation on small cases).
 */
export function loadBits(g: readonly number[], budget: number, gamma = 1, maxBits = 15): Loading {
  const bits = g.map(() => 0);
  let energy = 0;
  for (;;) {
    let best = -1, cost = Infinity;
    g.forEach((v, i) => { if (v > 0 && bits[i] < maxBits) { const c = (gamma * 2 ** bits[i]) / v; if (c < cost) { cost = c; best = i; } } });
    if (best < 0 || energy + cost > budget) break;
    energy += cost; bits[best]++;
  }
  return { bits, total: bits.reduce((a, b) => a + b, 0), energy };
}

// ---- what breaks it ---------------------------------------------------------------------------------------------------------

/** Peak over mean power of a sample block (dB). */
export function paprDb(x: Cx): number {
  let peak = 0, sum = 0;
  for (let i = 0; i < x.re.length; i++) { const p = x.re[i] ** 2 + x.im[i] ** 2; sum += p; if (p > peak) peak = p; }
  return 10 * Math.log10(peak / (sum / x.re.length));
}

/** The chance that a block of N independent tones peaks above `db` over its mean: each sample's power is exponential, so 1 − (1 − e^(−x))^N. */
export function paprCcdf(db: number, N: number): number {
  const x = 10 ** (db / 10);
  return -Math.expm1(N * Math.log1p(-Math.exp(-x)));
}

/** A block of `tones` random QPSK points through the inverse transform (complex: tones 0 … tones − 1 of N). */
export function randomBlock(tones: number, N: number, u: () => number): Cx {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < tones; k++) { re[k] = u() < 0.5 ? 1 : -1; im[k] = u() < 0.5 ? 1 : -1; }
  return fft({ re, im }, true);
}

/** Share of `blocks` random blocks whose peak exceeds `db`. */
export function paprMeasured(db: number, N: number, blocks: number, seed: number): number {
  const u = rng(seed);
  let n = 0;
  for (let i = 0; i < blocks; i++) if (paprDb(randomBlock(N, N, u)) > db) n++;
  return n / blocks;
}

/** What a tone leaks onto a neighbour `d` tones away when the receiver's carrier is off by `eps` of a tone: |sin π(d + ε) / (N sin(π(d + ε) / N))|. d = 0: what is left of the tone itself. */
export function leak(d: number, eps: number, N: number): number {
  const a = Math.PI * (d + eps);
  if (Math.abs(Math.sin(a / N)) < 1e-15) return 1;
  return Math.abs(Math.sin(a) / (N * Math.sin(a / N)));
}

/** Signal over interference (dB) on one tone with every tone loaded equally, from the closed form: what stays over what leaks in. The sum of all the leaks is 1 (Parseval). */
export function offsetSirDb(eps: number, N: number): number {
  const s = leak(0, eps, N) ** 2;
  return 10 * Math.log10(s / (1 - s));
}

/** The same measured: all tones loaded with random QPSK, the carrier off by `eps`, one FFT; error against the signal after the tone's common turn and scale are removed. */
export function offsetSirMeasured(eps: number, N: number, seed: number): number {
  const u = rng(seed), re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < N; k++) { re[k] = u() < 0.5 ? 1 : -1; im[k] = u() < 0.5 ? 1 : -1; }
  const x = fft({ re, im }, true), yr = new Float64Array(N), yi = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const w = (2 * Math.PI * eps * n) / N, c = Math.cos(w), s = Math.sin(w);
    yr[n] = x.re[n] * c - x.im[n] * s; yi[n] = x.re[n] * s + x.im[n] * c;
  }
  const Y = fft({ re: yr, im: yi });
  // the common factor: Σ Y conj(X) / Σ |X|²
  let cr = 0, ci = 0, pow = 0;
  for (let k = 0; k < N; k++) { cr += Y.re[k] * re[k] + Y.im[k] * im[k]; ci += Y.im[k] * re[k] - Y.re[k] * im[k]; pow += re[k] ** 2 + im[k] ** 2; }
  cr /= pow; ci /= pow;
  let err = 0;
  for (let k = 0; k < N; k++) err += (Y.re[k] - (cr * re[k] - ci * im[k])) ** 2 + (Y.im[k] - (cr * im[k] + ci * re[k])) ** 2;
  return 10 * Math.log10(((cr * cr + ci * ci) * pow) / err);
}

/** A two-tap echo's FIR inverse (zero-forcing): the tail of 1 / (1 + a z^−d) falls by a a term, so this many taps (a term every d samples) get it below `eps`. What one carrier pays, per sample. */
export function equalizerTaps(a: number, d: number, eps: number): number {
  return d * Math.ceil(Math.log(eps) / Math.log(a));
}

// ---- real systems, from their standards: what the prose quotes ---------------------------------------------------------------

export interface OfdmSystem { name: string; spacingHz: number; fft: number; used: number; cp: number; note: string }
/** The part of the time a block spends on its data, not its prefix. */
export const dataShare = (s: OfdmSystem): number => s.fft / (s.fft + s.cp);
/** The symbol's length with its prefix, seconds. */
export const blockTime = (s: OfdmSystem): number => (s.fft + s.cp) / (s.fft * s.spacingHz);
