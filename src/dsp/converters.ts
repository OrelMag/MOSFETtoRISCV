// Converters (DOM-free). Flash, SAR, a resistor ladder and clock jitter are labelled models of analogue parts with seeded mismatch; the sigma-delta loop's digital arithmetic is exact, and is the golden model of
// lib/sigmadelta.ts clock by clock. Voltages are shares of full scale, −1 … 1, unless a word is named. Spectra come from comm/fourier.ts.

import { cx, fft } from '../comm/fourier';
import { gaussian, rng } from '../phys/line';
import { wrapTo } from './fixed';

// ---- what a converter is judged by --------------------------------------------------------------------------------------------------------

export const idealSqnrDb = (bits: number): number => 6.02 * bits + 1.76;
/** Effective number of bits: the bits an ideal converter would need to reach this signal-to-noise-and-distortion. */
export const enob = (sndrDb: number): number => (sndrDb - 1.76) / 6.02;

/** A Hann window: a tone's power lands in three bins, and nothing leaks far from them. */
const hann = (n: number) => Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));

/** Power per bin of a real block, Hann windowed: relative to a sine of amplitude 1, whose three bins then sum to about 1. */
export function powerSpectrum(x: readonly number[]): number[] {
  const n = x.length, w = hann(n), z = fft(cx(x.map((v, i) => v * w[i]))), k = (8 / 3) * (4 / (n * n));
  return Array.from({ length: n / 2 }, (_, i) => k * (z.re[i] * z.re[i] + z.im[i] * z.im[i]));
}

/** Signal to everything else within [0, band) of the sample rate. The tone's bin k and one bin either side are signal, and the two lowest bins are left out as DC. */
export function sndrDb(x: readonly number[], k: number, band = 0.5): number {
  const p = powerSpectrum(x), top = Math.min(p.length, Math.ceil(band * x.length));
  let sig = 0, rest = 0;
  for (let i = 2; i < top; i++) { if (Math.abs(i - k) <= 2) sig += p[i]; else rest += p[i]; }
  return 10 * Math.log10(sig / Math.max(rest, 1e-30));
}

// ---- flash and SAR -------------------------------------------------------------------------------------------------------------------------

/** A flash converter: one comparator per step, each off by its own offset. Returns the count of comparators that say "above". `offsets` are in steps. */
export function flashConvert(v: number, bits: number, offsets?: readonly number[]): number {
  const n = 2 ** bits - 1, lsb = 2 / 2 ** bits;
  let code = 0;
  for (let i = 0; i < n; i++) if (v >= -1 + (i + 1) * lsb + (offsets ? offsets[i] * lsb : 0)) code++;
  return code;
}
export const flashComparators = (bits: number): number => 2 ** bits - 1;

/** A successive-approximation converter: `bits` trials on a capacitor DAC whose weights may be off, one bit a clock. Each step says what was tried and what it decided. */
export function sarConvert(v: number, bits: number, weights?: readonly number[]): { code: number; steps: { bit: number; tried: number; keep: boolean }[] } {
  const w = weights ?? Array.from({ length: bits }, (_, i) => 2 ** (bits - 1 - i) / 2 ** bits);
  let code = 0, level = -1;
  const steps: { bit: number; tried: number; keep: boolean }[] = [];
  for (let i = 0; i < bits; i++) {
    const tried = level + 2 * w[i], keep = v >= tried;
    steps.push({ bit: bits - 1 - i, tried, keep });
    if (keep) { level = tried; code += 2 ** (bits - 1 - i); }
  }
  return { code, steps };
}

/** Seeded weights, each capacitor off by σ of its own share: the MSB's error is the one that matters most. */
export function mismatchedWeights(bits: number, sigma: number, seed: number): number[] {
  const u = rng(seed);
  return Array.from({ length: bits }, (_, i) => (2 ** (bits - 1 - i) / 2 ** bits) * (1 + sigma * gaussian(u)));
}

// ---- an R-2R ladder ----------------------------------------------------------------------------------------------------------------------------

/**
 * The output of an R-2R ladder, by solving its nodes. `dr` holds each resistor's fractional error: rs[i] are the series R's, rt[i] the 2R's, with one terminating 2R. Each 2R goes to +1 (bit set) or 0.
 * Node 0 is the output end, the MSB's. Solved as a chain, from the far end in: a Thevenin source moves along the ladder.
 */
export function ladderOutput(code: number, bits: number, dr?: { rs: readonly number[]; rt: readonly number[] }): number {
  // from the LSB end: the terminating 2R to ground, then each bit
  let vt = 0, rt = 2;
  for (let i = bits - 1; i >= 0; i--) {
    const on = (code >> (bits - 1 - i)) & 1, r2 = 2 * (1 + (dr?.rt[i] ?? 0));
    const g = 1 / rt + 1 / r2;
    const v = (vt / rt + on / r2) / g;
    vt = v; rt = 1 / g;
    if (i > 0) rt += 1 + (dr?.rs[i] ?? 0);
  }
  return vt;
}

/** Seeded resistor errors for a ladder. */
export function ladderErrors(bits: number, sigma: number, seed: number): { rs: number[]; rt: number[] } {
  const u = rng(seed);
  return { rs: Array.from({ length: bits }, () => sigma * gaussian(u)), rt: Array.from({ length: bits }, () => sigma * gaussian(u)) };
}

/** Differential and integral nonlinearity of a staircase, in LSBs, against the line between its ends. DNL below −1 means the output went backwards. */
export function linearity(levels: readonly number[]): { dnl: number[]; inl: number[]; worstDnl: number; worstInl: number; monotonic: boolean } {
  const n = levels.length, lsb = (levels[n - 1] - levels[0]) / (n - 1);
  const dnl = levels.slice(1).map((v, i) => (v - levels[i]) / lsb - 1), inl = levels.map((v, i) => (v - levels[0]) / lsb - i);
  const abs = (a: number[]) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return { dnl, inl, worstDnl: abs(dnl), worstInl: abs(inl), monotonic: dnl.every((d) => d > -1) };
}

// ---- jitter ------------------------------------------------------------------------------------------------------------------------------------

/** The limit a clock's RMS jitter sets on a sine at f: −20 log₁₀(2π f σ), whatever the bits. f in Hz, σ in seconds. */
export const jitterLimitDb = (f: number, sigma: number): number => -20 * Math.log10(2 * Math.PI * f * sigma);
/** Measured: a full-scale sine sampled at instants off by Gaussian jitter, against the same sine sampled exactly. */
export function jitterMeasuredDb(f: number, fs: number, sigma: number, seed: number, n = 4096): number {
  const u = rng(seed);
  let sig = 0, err = 0;
  for (let i = 0; i < n; i++) {
    const t = i / fs, a = Math.sin(2 * Math.PI * f * t), b = Math.sin(2 * Math.PI * f * (t + sigma * gaussian(u)));
    sig += a * a; err += (a - b) * (a - b);
  }
  return 10 * Math.log10(sig / err);
}

// ---- sigma-delta ---------------------------------------------------------------------------------------------------------------------------------

/** Bits above the input's word that the integrators hold: enough for the sizes the sheet allows, up to OVERLOAD of full scale, by measurement (tests/dsp-converters.test.ts). */
export const SD_GUARD = 3;
/** Past this share of full scale a second-order loop with a one-bit quantizer goes unstable. */
export const SD_OVERLOAD = 0.8;

/**
 * The digital loop, clock by clock, order 1 or 2. u is a signed w-bit word; the output is ±2^(w−1) as a word, so 1 → +, 0 → −. It decides from the last integrator before the edge, then:
 *   y₁ += u − v, and for order 2, y₂ += y₁ (the new one) − v.
 * That gives V = z⁻¹U + (1 − z⁻¹)^N E exactly, where E is what the quantizer added. Registers wrap at w + SD_GUARD and are sized never to.
 */
export class SdLoop {
  y1 = 0;
  y2 = 0;
  /** The bit decided before the last edge. */
  bit = 0;
  /** What the quantizer added on the last clock: v − (its input). */
  e = 0;
  constructor(public order: 1 | 2, public w: number) {}
  get word(): number { return this.w + SD_GUARD; }
  get fs(): number { return 2 ** (this.w - 1); }
  /** Which way the next decision goes: the sign of the last integrator, with 0 counted as positive. */
  get decide(): number { return (this.order === 1 ? this.y1 : this.y2) >= 0 ? 1 : 0; }
  edge(u: number): void {
    const b = this.decide, v = b ? this.fs : -this.fs, last = this.order === 1 ? this.y1 : this.y2;
    this.e = v - last;
    const y1 = wrapTo(this.y1 + u - v, this.word);
    if (this.order === 2) this.y2 = wrapTo(this.y2 + y1 - v, this.word);
    this.y1 = y1;
    this.bit = b;
  }
}

/** A tone through the loop, as ±1. `level` is a share of full scale, `k` whole cycles in the block. */
export function sdBitstream(order: 1 | 2, n: number, k: number, level: number, w = 16): number[] {
  const m = new SdLoop(order, w), out: number[] = [];
  for (let i = 0; i < n; i++) { m.edge(Math.round(level * m.fs * Math.sin((2 * Math.PI * k * i) / n))); out.push(m.bit ? 1 : -1); }
  return out;
}

/** The band a loop keeps at an oversampling ratio: [0, 1 / (2 OSR)) of its rate. */
export const sdBand = (osr: number): number => 1 / (2 * osr);

/** The textbook linear model of a one-bit loop's SQNR: the quantizer as white noise with step 2, the noise shaped by (1 − z⁻¹)^L. Right in its slope, only roughly in its level. */
export function sdLinearModelDb(order: number, osr: number, level: number): number {
  const L = order;
  return 6.02 + 1.76 + 20 * Math.log10(level) - 10 * Math.log10(Math.PI ** (2 * L) / (2 * L + 1)) + (20 * L + 10) * Math.log10(osr);
}

/** SQNR in the kept band, measured from the loop's own bitstream. */
export function sdMeasuredDb(order: 1 | 2, osr: number, level: number, n = 1 << 15): number {
  const k = Math.max(3, Math.round(n / osr / 8)) | 1;
  return sndrDb(sdBitstream(order, n, k, level), k, sdBand(osr));
}
