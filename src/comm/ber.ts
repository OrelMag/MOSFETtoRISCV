// Bit error rate against Eb/N0 (DOM-free): chapter 47's plot. BPSK on Gaussian noise. The rate scaling is the whole game: a code of
// rate R spends Eb on 1/R channel bits, so each channel bit sees R · Eb/N0 and its raw error rate is Q(√(2 R Eb/N0)). Q is phys/line.ts's and
// the limit's arithmetic comm/limits.ts's. Closed forms here; tests/comm-codes.test.ts holds them to seeded runs of the real decoders.

import { dbToRatio, ebn0AtCapacity, ratioToDb } from './limits';
import { convEncode, Viterbi, spectrum, type ConvSpec } from './conv';
import { rsBer } from './rs';
import { secdedDecode, secdedEncode } from './fec';
import { gaussian, qFunc, rng } from '../phys/line';

/** A channel bit's raw error rate at this Eb/N0 (dB) and code rate. */
export const channelP = (ebn0Db: number, rate = 1): number => qFunc(Math.sqrt(2 * rate * dbToRatio(ebn0Db)));

/** The noise's σ per channel bit, for a ±1 signal. */
export const sigmaOf = (ebn0Db: number, rate: number): number => Math.sqrt(1 / (2 * rate * dbToRatio(ebn0Db)));

export const uncodedBer = (ebn0Db: number): number => channelP(ebn0Db);

/** SEC-DED(n, k) decoded by hard decisions: an even number of wrong bits i is flagged and passed on as it is; an odd i ≥ 3 is miscorrected, about one more wrong bit. */
export function secdedBer(ebn0Db: number, n = 72, k = 64): number {
  const p = channelP(ebn0Db, k / n);
  let sum = 0, term = n * (n - 1) / 2 * p * p * (1 - p) ** (n - 2);
  for (let i = 2; i <= n && term > 0; i++) { sum += term * Math.min(n, i % 2 ? i + 1 : i) / n; term *= ((n - i) / (i + 1)) * (p / (1 - p)); }
  return sum;
}

export const rsCurve = (ebn0Db: number, n: number, k: number): number => rsBer(n, k, channelP(ebn0Db, k / n));

const cache = new Map<string, { dfree: number; A: number[]; B: number[] }>();
const spec = (s: ConvSpec, dMax: number) => { const k = `${s.g}:${dMax}`; let v = cache.get(k); if (!v) cache.set(k, (v = spectrum(s, dMax))); return v; };

/** Union bound for a soft-decision decoder of a rate 1/2 code: Σ B_d Q(√(2 d R Eb/N0)); tight at low error rates. */
export function convSoftBound(s: ConvSpec, ebn0Db: number, dMax = 24): number {
  const { B } = spec(s, dMax), r = dbToRatio(ebn0Db);
  let sum = 0;
  B.forEach((b, d) => { if (b) sum += b * qFunc(Math.sqrt(2 * d * 0.5 * r)); });
  return Math.min(0.5, sum);
}

/** The same for hard decisions: the chance that a path d away wins by a majority of wrong bits at p, ties split. */
export function convHardBound(s: ConvSpec, ebn0Db: number, dMax = 24): number {
  const { B } = spec(s, dMax), p = channelP(ebn0Db, 0.5);
  const choose = (n: number, k: number) => { let c = 1; for (let i = 1; i <= k; i++) c *= (n - k + i) / i; return c; };
  const Pd = (d: number) => {
    let t = 0;
    for (let i = Math.floor(d / 2) + 1; i <= d; i++) t += choose(d, i) * p ** i * (1 - p) ** (d - i);
    if (d % 2 === 0) t += 0.5 * choose(d, d / 2) * p ** (d / 2) * (1 - p) ** (d / 2);
    return t;
  };
  let sum = 0;
  B.forEach((b, d) => { if (b) sum += b * Pd(d); });
  return Math.min(0.5, sum);
}

/** Eb/N0 (dB) where a falling curve crosses `target`, by bisection. */
export function ebn0For(f: (db: number) => number, target: number, lo = -2, hi = 16): number {
  let a = lo, b = hi;
  for (let i = 0; i < 60; i++) { const m = (a + b) / 2; if (f(m) > target) a = m; else b = m; }
  return (a + b) / 2;
}

/** Coding gain at `target`: how many dB less than uncoded the curve needs. */
export const codingGain = (f: (db: number) => number, target: number): number => ebn0For(uncodedBer, target) - ebn0For(f, target);

/** Shannon's limit for rate R bits per real channel use with any input: Eb/N0 = (2^(2R) - 1) / (2R), through limits.ts (2R bits per Hz). */
export const shannonDb = (rate: number): number => ratioToDb(ebn0AtCapacity(2 * rate));

/** Capacity (bits per use) of the binary-input Gaussian channel at noise σ, by numeric integration. */
export function biAwgnCapacity(sigma: number): number {
  const N = 4000, lim = 1 + 12 * sigma, dx = (2 * lim) / N;
  let sum = 0;
  for (let i = 0; i <= N; i++) {
    const y = -lim + i * dx, pdf = Math.exp(-((y - 1) ** 2) / (2 * sigma * sigma)) / (sigma * Math.sqrt(2 * Math.PI));
    const z = -2 * y / (sigma * sigma);
    if (pdf > 0) sum += (i === 0 || i === N ? 0.5 : 1) * pdf * (z > 30 ? z / Math.LN2 : Math.log2(1 + Math.exp(z)));
  }
  return 1 - sum * dx;
}

/** Shannon's limit when the input can only be ±1: the Eb/N0 (dB) at which capacity equals the code's rate. */
export function shannonBinaryDb(rate: number): number {
  let a = -3, b = 12;
  for (let i = 0; i < 50; i++) { const m = (a + b) / 2; if (biAwgnCapacity(sigmaOf(m, rate)) < rate) a = m; else b = m; }
  return (a + b) / 2;
}

/** A received ±1 + noise as a q-bit level: for q > 1 the levels span ±SOFT_CLIP (q = 3: a step of 0.357, near the usual half σ at the 3–4 dB where it matters); q = 1 is the sign. */
export const SOFT_CLIP = 1.25;
export function quantize(y: number, q: number): number {
  const L = 2 ** q;
  if (q === 1) return y > 0 ? 1 : 0;
  const v = Math.floor(((y + SOFT_CLIP) / (2 * SOFT_CLIP)) * (L - 1) + 0.5);
  return Math.max(0, Math.min(L - 1, v));
}

export interface BerRun { bits: number; errors: number; ber: number }

/** Random bits through the encoder, Gaussian noise and the gates' decoder. The first `depth` decoded bits are the reset's and are skipped. */
export function convTrial(s: ConvSpec, ebn0Db: number, bits: number, o: { q?: number; depth?: number; seed?: number } = {}): BerRun {
  const q = o.q ?? 1, u = rng(o.seed ?? 1), v = new Viterbi(s, { q, depth: o.depth }), sig = sigmaOf(ebn0Db, 0.5), D = v.depth;
  const data = new Uint8Array(bits);
  for (let i = 0; i < bits; i++) data[i] = u() < 0.5 ? 1 : 0;
  const coded = convEncode(s, data);
  let errors = 0, seen = 0;
  for (let i = 0; i < bits; i++) {
    const r0 = quantize((coded[2 * i] ? 1 : -1) + sig * gaussian(u), q), r1 = quantize((coded[2 * i + 1] ? 1 : -1) + sig * gaussian(u), q);
    v.step(r0, r1);
    // after step i the oldest bit is input i - (D - 1)
    const j = i - (D - 1);
    if (j >= D) { seen++; if (v.out !== data[j]) errors++; }
  }
  return { bits: seen, errors, ber: seen ? errors / seen : 0 };
}

/** The same with SEC-DED(72, 64) blocks. */
export function secdedTrial(ebn0Db: number, blocks: number, seed = 1, k = 64): BerRun {
  const u = rng(seed), bitsPer = k, p = channelP(ebn0Db, k / secdedEncode(new Array<number>(k).fill(0)).length);
  let errors = 0;
  for (let b = 0; b < blocks; b++) {
    const d = Array.from({ length: bitsPer }, () => (u() < 0.5 ? 1 : 0)), c = secdedEncode(d);
    let any = false;
    for (let i = 0; i < c.length; i++) if (u() < p) { c[i] ^= 1; any = true; }
    if (!any) continue;
    const r = secdedDecode(c, k);
    r.data.forEach((v, i) => { if (v !== d[i]) errors++; });
  }
  return { bits: blocks * bitsPer, errors, ber: errors / (blocks * bitsPer) };
}

/** The live run's schedule (widgets/codes.ts berWidget): chunks short enough for a frame (a K = 7 trial costs about 20 µs a bit), each decoder run to this many errors or this many bits. */
export const BER_CHUNK = 4000, BER_MIN_ERRORS = 100, BER_MAX_BITS = 400000;

/** The seed of chunk `i` of job `j`: a mixed hash, since the generator's consecutive small seeds give correlated noise. */
export function trialSeed(i: number, j: number): number {
  let h = Math.imul(i + 1, 0x9e3779b1) ^ Math.imul(j + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d); h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}
