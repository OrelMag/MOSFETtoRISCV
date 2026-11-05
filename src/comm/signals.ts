// The signals chapter's models (DOM-free): a block of samples and its spectrum, an FIR filter and its response, folding when sampled,
// quantizing, and a mixer. comm/fourier.ts has the transforms; lib/fir.ts's gates are compared with FirModel every cycle (tests/comm-signals.test.ts).

import { cx, dft } from './fourier';

/** Samples in a block of the spectrum explorer. */
export const BLOCK = 256;

export interface SignalDef { id: string; name: string; at: (t: number) => number }

/** t runs over one block, 0 to 1. Whole numbers of cycles, so each tone falls on one bin. */
export const SIGNALS: readonly SignalDef[] = [
  { id: 'tone', name: 'One tone', at: (t) => Math.sin(2 * Math.PI * 8 * t) },
  { id: 'two', name: 'Two tones', at: (t) => 0.7 * Math.sin(2 * Math.PI * 8 * t) + 0.3 * Math.sin(2 * Math.PI * 40 * t) },
  { id: 'square', name: 'Square wave', at: (t) => ((8 * t) % 1 < 0.5 ? 1 : -1) },
  { id: 'pulse', name: 'One short pulse', at: (t) => (t < 1 / 32 ? 1 : 0) },
  { id: 'burst', name: 'A tone switched on and off', at: (t) => (t > 0.25 && t <= 0.75 ? Math.sin(2 * Math.PI * 32 * t) : 0) },
];

export const samplesOf = (s: SignalDef, n = BLOCK): number[] => Array.from({ length: n }, (_, i) => s.at(i / n));

/** Amplitude per bin of a real block, 0 to N / 2: a sine of amplitude A reads A at its bin. */
export function amplitudes(x: readonly number[]): number[] {
  const X = dft(cx(x)), N = x.length;
  return Array.from({ length: N / 2 + 1 }, (_, k) => (Math.hypot(X.re[k], X.im[k]) * (k === 0 || k === N / 2 ? 1 : 2)) / N);
}

/** The narrowest band from DC that holds `share` of the block's power (bins). */
export function bandHolding(x: readonly number[], share: number): number {
  const a = amplitudes(x), N = x.length;
  const p = a.map((v, k) => (k === 0 || k === N / 2 ? v * v : (v * v) / 2)), all = p.reduce((m, v) => m + v, 0);
  let sum = 0;
  for (let k = 0; k < p.length; k++) { sum += p[k]; if (sum >= share * all - 1e-12) return k; }
  return p.length - 1;
}

// ---- FIR ------------------------------------------------------------------------------------------------------------------------

/** The filter built in gates: the binomial taps. Their sum is 16, so its DC gain is a shift. */
export const FIR_TAPS = [1, 4, 6, 4, 1] as const;
export const FIR_IN = 8;
export const FIR_OUT = 12;

/** Gain at f cycles a sample, relative to DC. */
export function firGain(taps: readonly number[], f: number): number {
  let re = 0, im = 0, dc = 0;
  taps.forEach((h, k) => { re += h * Math.cos(2 * Math.PI * f * k); im -= h * Math.sin(2 * Math.PI * f * k); dc += h; });
  return Math.hypot(re, im) / Math.abs(dc);
}

/** The binomial filter's response in closed form: each factor (1 + z⁻¹) contributes a cosine. */
export const binomialGain = (f: number): number => Math.cos(Math.PI * f) ** 4;

/** A moving average of n samples. */
export const movingAverage = (n: number): number[] => new Array<number>(n).fill(1);

/** A low-pass with cut-off fc (cycles a sample) from a sinc cut to n taps under a Hamming window: the usual first design. */
export function windowedSinc(n: number, fc: number): number[] {
  const m = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => {
    const t = i - m, sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    return sinc * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
  });
}

/** Any FIR over a block, the samples before it taken as 0. */
export function firFilter(taps: readonly number[], x: readonly number[]): number[] {
  return x.map((_, n) => taps.reduce((sum, h, k) => sum + h * (x[n - k] ?? 0), 0));
}

/** The gates' behaviour: five sample registers, the output combinational from them. Samples are two's complement. */
export class FirModel {
  regs: number[] = [0, 0, 0, 0, 0];
  /** The clock edge: the input enters, the others move along. */
  edge(x: number): void { this.regs = [x, ...this.regs.slice(0, 4)]; }
  get y(): number { return this.regs.reduce((sum, v, k) => sum + FIR_TAPS[k] * v, 0); }
}

/** A word's bits read as two's complement. */
export const signedOf = (v: number, w: number): number => (v >= 2 ** (w - 1) ? v - 2 ** w : v);
export const wordOf = (v: number, w: number): number => (v < 0 ? v + 2 ** w : v);

// ---- sampling -------------------------------------------------------------------------------------------------------------------

/** The frequency a tone seems to have once sampled: it folds into 0 … fs / 2. */
export function aliasOf(f: number, fs: number): number {
  const r = ((f % fs) + fs) % fs;
  return r > fs / 2 ? fs - r : r;
}

/** A uniform quantizer of `bits` over −1 … 1. */
export function quantize(x: number, bits: number): number {
  const q = 2 / 2 ** bits;
  return Math.min(1 - q / 2, Math.max(-1 + q / 2, (Math.floor(x / q) + 0.5) * q));
}

/** A full-scale sine against quantization noise, closed form: about 6 dB a bit. */
export const sqnrDb = (bits: number): number => 6.02 * bits + 1.76;

/** The same measured on a sine of an irrational-ish number of cycles, so the error does not repeat. */
export function measuredSqnrDb(bits: number, n = 1 << 16): number {
  let sig = 0, err = 0;
  for (let i = 0; i < n; i++) {
    const x = Math.sin(2 * Math.PI * 0.0137731 * i), e = x - quantize(x, bits);
    sig += x * x; err += e * e;
  }
  return 10 * Math.log10(sig / err);
}

/** A tone times a carrier: half of each sum and difference tone, by cos a · cos b = ½ cos(a − b) + ½ cos(a + b). */
export const mixed = (fa: number, fb: number, t: number): number => Math.cos(2 * Math.PI * fa * t) * Math.cos(2 * Math.PI * fb * t);
export const mixedBySum = (fa: number, fb: number, t: number): number => 0.5 * Math.cos(2 * Math.PI * (fa - fb) * t) + 0.5 * Math.cos(2 * Math.PI * (fa + fb) * t);
