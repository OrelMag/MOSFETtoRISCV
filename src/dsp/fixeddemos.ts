// What "Numbers that fit" shows (DOM-free): each explorer's run on dsp/fixed.ts, so the tests can hold what the chapter says to it.

import { fit, satTo, shiftRound, wrapTo, type Rounding } from './fixed';

const dB = (v: number) => 10 * Math.log10(Math.max(v, 1e-30));

export const TONES_RATE = 16000;
/** Two tones with a peak near 0.9, so a gain above 1 dB reaches full scale. */
export const twoTones = (t: number): number => 0.5 * Math.sin(2 * Math.PI * 440 * t) + 0.4 * Math.sin(2 * Math.PI * 1180 * t);

export type PastFull = 'wrap' | 'sat' | 'scale';
export interface OverflowRun { out: Float32Array; ideal: Float32Array; snrDb: number; overShare: number; shift: number }

/** Two tones with gain, stored in a word of `bits`, past full scale as `mode` says; 'scale' shifts down first by what the peak needs. */
export function overflowRun(gainDb: number, bits: number, mode: PastFull, n = 24000): OverflowRun {
  const gain = 10 ** (gainDb / 20), q = 2 ** (bits - 1), peak = 0.9 * gain;
  const shift = mode === 'scale' ? Math.max(0, Math.ceil(Math.log2(peak * 1.0001))) : 0, sc = 2 ** shift;
  const out = new Float32Array(n), ideal = new Float32Array(n);
  let sig = 0, err = 0, over = 0;
  for (let i = 0; i < n; i++) {
    const v = gain * twoTones(i / TONES_RATE), r = Math.round((v / sc) * q);
    if (r > q - 1 || r < -q) over++;
    const y = ((mode === 'wrap' ? wrapTo(r, bits) : satTo(r, bits)) / q) * sc;
    out[i] = y; ideal[i] = v; sig += v * v; err += (y - v) * (y - v);
  }
  return { out, ideal, snrDb: dB(sig / Math.max(err, 1e-20)), overShare: over / n, shift };
}

/** A busy signal of 13-bit words: tones and noise, seeded. */
export function busyWords(n: number): number[] {
  let s = 2024;
  return Array.from({ length: n }, (_, i) => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return Math.round(2000 * Math.sin(i * 0.137) + 1500 * Math.sin(i * 0.031) + 500 * (s / 2 ** 31 - 1));
  });
}

export interface RoundingRun { mean: number; variance: number; drift: number[] }
/** Each word loses s bits, and the error is measured in the input's steps; `drift` is its running sum, which is what a long accumulation sees. */
export function roundingRun(mode: Rounding, s: number, n = 4000): RoundingRun {
  const x = busyWords(n);
  let sum = 0, sq = 0;
  const drift = x.map((v) => { const e = shiftRound(v, s, mode) * 2 ** s - v; sum += e; sq += e * e; return sum; });
  const mean = sum / n;
  return { mean, variance: sq / n - mean * mean, drift };
}

export interface SumRun { truth: number[]; wrapped: number[]; clamped: number[] }
/** A running sum in a word, by each rule, and without a limit. */
export function runningSum(xs: readonly number[], w: number): SumRun {
  const out: SumRun = { truth: [0], wrapped: [0], clamped: [0] };
  xs.forEach((x, i) => {
    out.truth.push(out.truth[i] + x);
    out.wrapped.push(fit(out.wrapped[i] + x, w, 'wrap'));
    out.clamped.push(fit(out.clamped[i] + x, w, 'sat'));
  });
  return out;
}

export type GainOrder = 'down first' | 'up first';
/**
 * A chain with overall gain 1: a tone of `level` stored in `w` bits, then a 2^s up and a 2^s down, in either order; saturating, rounding half up.
 * Going down first throws bits away. Going up first keeps them, and needs the headroom. The ratio is against the exact tone.
 */
export function chainSnr(level: number, s: number, w: number, order: GainOrder, n = 4096): number {
  const q = 2 ** (w - 1);
  let sig = 0, err = 0;
  for (let i = 0; i < n; i++) {
    const v = level * Math.sin(i * 0.0917), x = satTo(Math.round(v * q), w);
    const y = order === 'down first' ? satTo(shiftRound(x, s, 'half-up') * 2 ** s, w) : shiftRound(satTo(x * 2 ** s, w), s, 'half-up');
    sig += v * v; err += (y / q - v) ** 2;
  }
  return dB(sig / Math.max(err, 1e-30));
}
