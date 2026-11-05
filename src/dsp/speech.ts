// Speech (DOM-free): G.711 μ-law, IMA ADPCM, linear prediction and a vocoder. μ-law follows G.711's Tables 2a and 2b exactly, on 14-bit uniform samples, and is the golden model of
// lib/ulaw.ts. ADPCM is IMA's, with the reference's nibble order as Python's audioop has it (scripts/dsp/oracle.py compares both). LPC reuses dsp/adaptive.ts's Levinson.

import { levinson } from './adaptive';

// ---- μ-law (G.711) --------------------------------------------------------------------------------------------------------------------------

/** G.711 μ-law works on 14-bit uniform samples, −8192 … 8191. */
export const ULAW_BITS = 14;
/** The largest decision value, x₁₂₈ (virtual): inputs at or past it all take the top code. */
export const ULAW_CLIP = 8159;
/** Decision value x_n for n = 0 … 128 (Table 2a, column 5): segment s (1 … 8) ends at 32·2^s − 33, and its 16 intervals are 2^s wide; segment 1 starts with one interval of 1. */
export function ulawDecision(n: number): number {
  if (n === 0) return 0;
  const s = Math.ceil(n / 16), start = s === 1 ? -1 : 32 * 2 ** (s - 1) - 33;
  return start + 2 ** s * (n - 16 * (s - 1));
}
/** Quantized value y_n (column 7): the middle of its interval, y₀ = 0. */
export const ulawQuantized = (n: number): number => (n === 0 ? 0 : (ulawDecision(n) + ulawDecision(n + 1)) / 2);

/**
 * A 14-bit sample to its 8-bit character signal, as sent (bit 1 first, the polarity). The sample's magnitude, clipped to 8159, plus 33: its top bit gives the segment and the four below
 * it the step. The code is then inverted: positive values send 255 − n, negative ones 127 − n (Tables 2a and 2b, note 2). A sample on a decision value goes to the interval above it.
 */
export function ulawEncode(x: number): number {
  const neg = x < 0, v = Math.min(Math.abs(x), ULAW_CLIP) + 33;
  // at the clip v is 8192, one past segment 8: it saturates to the top code
  const n = v >= 8192 ? 127 : 16 * (Math.floor(Math.log2(v)) - 5) + ((v >> (Math.floor(Math.log2(v)) - 4)) & 15);
  return (neg ? 0x00 : 0x80) | (~n & 0x7f);
}
/** A character signal back to its quantized value: ((33 + 2m) << e) − 33, signed by bit 1. */
export function ulawDecode(code: number): number {
  const n = ~code & 0x7f, e = n >> 4, m = n & 15, y = ((33 + 2 * m) << e) - 33;
  return code & 0x80 ? y : -y || 0;
}
/** Segment and step of a code, for the explorer. */
export const ulawFields = (code: number) => { const n = ~code & 0x7f; return { negative: !(code & 0x80), n, segment: (n >> 4) + 1, step: n & 15 }; };

// ---- IMA ADPCM ------------------------------------------------------------------------------------------------------------------------------

/** How far the step index moves for each code's magnitude: three small codes step down, larger ones up. */
export const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];
/** The 89 step sizes, about 10 % apart. */
export const IMA_STEPS = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];

export interface AdpcmState { pred: number; index: number }
const clamp16 = (v: number) => Math.max(-32768, Math.min(32767, v));

/** One 16-bit sample to a 4-bit code. The encoder runs the decoder's own arithmetic, so both sides keep the same prediction. */
export function adpcmEncodeOne(x: number, s: AdpcmState): number {
  let step = IMA_STEPS[s.index], diff = x - s.pred, code = 0, vp = step >> 3;
  if (diff < 0) { code = 8; diff = -diff; }
  if (diff >= step) { code |= 4; diff -= step; vp += step; }
  step >>= 1;
  if (diff >= step) { code |= 2; diff -= step; vp += step; }
  step >>= 1;
  if (diff >= step) { code |= 1; vp += step; }
  s.pred = clamp16(code & 8 ? s.pred - vp : s.pred + vp);
  s.index = Math.max(0, Math.min(88, s.index + IMA_INDEX[code & 7]));
  return code;
}
/** One code back to a sample: the same steps, from the code's bits. */
export function adpcmDecodeOne(code: number, s: AdpcmState): number {
  const step = IMA_STEPS[s.index];
  let vp = step >> 3;
  if (code & 4) vp += step;
  if (code & 2) vp += step >> 1;
  if (code & 1) vp += step >> 2;
  s.pred = clamp16(code & 8 ? s.pred - vp : s.pred + vp);
  s.index = Math.max(0, Math.min(88, s.index + IMA_INDEX[code & 7]));
  return s.pred;
}
/** A block of samples to codes, from a state that carries on to the next block. */
export const adpcmEncode = (x: readonly number[], s: AdpcmState = { pred: 0, index: 0 }): number[] => x.map((v) => adpcmEncodeOne(v, s));
export const adpcmDecode = (c: readonly number[], s: AdpcmState = { pred: 0, index: 0 }): number[] => c.map((v) => adpcmDecodeOne(v, s));
/** Two codes a byte, the first in the high half: audioop's order (IMA's WAV files put the first in the low half). */
export const packNibbles = (c: readonly number[]): number[] => Array.from({ length: Math.ceil(c.length / 2) }, (_, i) => ((c[2 * i] & 15) << 4) | ((c[2 * i + 1] ?? 0) & 15));

// ---- measuring ------------------------------------------------------------------------------------------------------------------------------

/** Signal to noise of y against x, in dB. */
export function snrDb(x: ArrayLike<number>, y: ArrayLike<number>): number {
  let s = 0, e = 0;
  for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; e += (x[i] - y[i]) ** 2; }
  return 10 * Math.log10(s / Math.max(e, 1e-30));
}
/** A sine of the given peak, through a coder, as SNR: the curve a companding law is judged by. */
export function sineSnr(peak: number, coder: (v: number) => number, n = 4000): number {
  const x = Array.from({ length: n }, (_, i) => peak * Math.sin(2 * Math.PI * 0.0371 * i)), r = x.map((v) => Math.round(v));
  return snrDb(x, r.map(coder));
}
/** Uniform rounding to `bits` over the same ±8192 range. */
export const uniform = (bits: number) => { const q = 2 ** (ULAW_BITS - bits); return (v: number) => Math.max(-8192, Math.min(8191 - q + 1, q * Math.round(v / q))); };

// ---- linear prediction ------------------------------------------------------------------------------------------------------------------------

const hamming = (n: number) => Array.from({ length: n }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1)));
/** The autocorrelation of a windowed frame, lags 0 … p. */
export function autocorr(x: readonly number[], p: number): number[] {
  const w = hamming(x.length), y = x.map((v, i) => v * w[i]);
  return Array.from({ length: p + 1 }, (_, k) => { let s = 0; for (let i = k; i < y.length; i++) s += y[i] * y[i - k]; return s; });
}
/** Prediction coefficients a[1 … p], x̂[n] = Σ a[k] x[n − k], from Levinson on R a = r. A silent frame predicts nothing. */
export function lpc(x: readonly number[], p: number): number[] {
  const r = autocorr(x, p);
  if (!(r[0] > 0)) return new Array<number>(p).fill(0);
  return levinson(r.slice(0, p), r.slice(1, p + 1));
}
/** How much smaller the residual is than the frame: the prediction gain, in dB. */
export function predictionGainDb(x: readonly number[], a: readonly number[]): number {
  let s = 0, e = 0;
  for (let i = a.length; i < x.length; i++) { let p = 0; for (let k = 0; k < a.length; k++) p += a[k] * x[i - 1 - k]; s += x[i] * x[i]; e += (x[i] - p) ** 2; }
  return 10 * Math.log10(s / Math.max(e, 1e-30));
}
/** The all-pole filter's response at f (cycles a sample), in dB, gain g: 1 / |1 − Σ a_k e^{−j2πfk}|. */
export function lpcEnvelopeDb(a: readonly number[], f: number, g = 1): number {
  let re = 1, im = 0;
  for (let k = 0; k < a.length; k++) { re -= a[k] * Math.cos(2 * Math.PI * f * (k + 1)); im += a[k] * Math.sin(2 * Math.PI * f * (k + 1)); }
  return 20 * Math.log10(g / Math.hypot(re, im));
}

// ---- a vocoder (ours) ------------------------------------------------------------------------------------------------------------------------

/** Levinson–Durbin on r[0 … p]: the predictor a[1 … p], the reflection coefficients k[1 … p] (|k| < 1 for any real signal) and the error left. */
export function durbin(r: readonly number[], p: number): { a: number[]; k: number[]; err: number } {
  let a: number[] = [], err = r[0];
  const k: number[] = [];
  for (let i = 0; i < p; i++) {
    if (!(err > 0)) { k.push(0); a = [...a, 0]; continue; }
    let acc = r[i + 1];
    for (let j = 0; j < i; j++) acc -= a[j] * r[i - j];
    const ki = acc / err, next = a.map((v, j) => v - ki * a[i - 1 - j]);
    next.push(ki);
    a = next; k.push(ki); err *= 1 - ki * ki;
  }
  return { a, k, err };
}
/** Reflection coefficients back to a predictor (the step-up recursion). */
export function stepUp(k: readonly number[]): number[] {
  let a: number[] = [];
  for (let i = 0; i < k.length; i++) { const n = a.map((v, j) => v - k[i] * a[i - 1 - j]); n.push(k[i]); a = n; }
  return a;
}

/** The frame: 180 samples (22.5 ms at 8 kHz), analysed over a 240-sample window around it. */
export const VOC = { hop: 180, win: 240, order: 10, minLag: 20, maxLag: 146 };
/** Bits for each reflection coefficient (as a log-area ratio), the pitch and voicing word, the gain and a sync bit: 54 a frame. */
export const VOC_BITS = { k: [5, 5, 5, 5, 4, 4, 4, 4, 3, 2], pitch: 7, gain: 5, sync: 1 };
export const vocBitsPerFrame = (): number => VOC_BITS.k.reduce((a, b) => a + b, 0) + VOC_BITS.pitch + VOC_BITS.gain + VOC_BITS.sync;
export const vocBitRate = (rate = 8000): number => (vocBitsPerFrame() * rate) / VOC.hop;

/** A log-area ratio, log((1 + k) / (1 − k)), rounded to `bits` over ±LAR_RANGE: the low coefficients shape the spectrum most and get the most bits. */
const LAR_RANGE = 3.5;
export function quantK(k: number, bits: number): number {
  const lar = Math.log((1 + k) / (1 - k)), L = 2 ** bits, step = (2 * LAR_RANGE) / L;
  const q = Math.max(0, Math.min(L - 1, Math.floor((lar + LAR_RANGE) / step)));
  const back = -LAR_RANGE + (q + 0.5) * step;
  return Math.tanh(back / 2);
}

export interface VocFrame { k: number[]; lag: number; voiced: boolean; gain: number; r: number }
/** Pre-emphasis: 1 − 0.9375 z⁻¹ before analysis lifts the high frequencies a voice has little of, so the predictor is not spent on its low end; synthesis undoes it. */
export const PRE = 0.9375;
/**
 * One frame's parameters: LPC by autocorrelation of the pre-emphasized frame; pitch from the low-passed speech, centre-clipped at 60 % of its peak so that only the pitch pulses' tops
 * are left (Sondhi's trick, from memory), the lag with the largest normalized autocorrelation; voiced above VOICED and not too quiet; the frame's own RMS as gain.
 */
export function analyse(x: readonly number[], at: number, floor: number, lp: readonly number[] = x): VocFrame {
  const { win, order, minLag, maxLag } = VOC, start = at - (win - VOC.hop) / 2, f = Array.from({ length: win }, (_, i) => x[start + i] ?? 0);
  const { k } = durbin(autocorr(f, order), order);
  const raw = Array.from({ length: win }, (_, i) => lp[start + i] ?? 0), top = raw.reduce((m, v) => Math.max(m, Math.abs(v)), 0), cl = 0.6 * top;
  const q = raw.map((v) => (v > cl ? v - cl : v < -cl ? v + cl : 0));
  let best = 0, lag = minLag;
  for (let L = minLag; L <= maxLag; L++) {
    let c = 0, n = 0, m = 0;
    for (let i = L; i < win; i++) { c += q[i] * q[i - L]; n += q[i - L] * q[i - L]; m += q[i] * q[i]; }
    const r = c / Math.sqrt(Math.max(n * m, 1e-12));
    if (r > best) { best = r; lag = L; }
  }
  // octave errors: a lag twice the pitch correlates too, so prefer half the lag when it does nearly as well
  const rAt = (L: number) => { let c = 0, n = 0, m = 0; for (let i = L; i < win; i++) { c += q[i] * q[i - L]; n += q[i - L] * q[i - L]; m += q[i] * q[i]; } return c / Math.sqrt(Math.max(n * m, 1e-12)); };
  const half = Math.round(lag / 2);
  if (half >= minLag && rAt(half) > 0.85 * best) lag = half;
  const level = Math.sqrt(f.reduce((s, v) => s + v * v, 0) / win);
  return { k, lag, voiced: best > VOICED && level > floor, gain: level, r: best };
}
/** The centre-clipped autocorrelation at the pitch lag must reach this for a frame to count as voiced. */
export const VOICED = 0.35;
/** Gain to 5 bits, 2 dB steps from 1. */
const quantGain = (g: number) => (g < 1 ? 0 : 10 ** (Math.min(31, Math.round((20 * Math.log10(g)) / 2)) * 2 / 20));

/** A low-pass at about 900 Hz for the pitch search: a 31-tap windowed sinc. */
function lowpass(x: readonly number[]): number[] {
  const n = 31, m = 15, fc = 900 / 8000, h = Array.from({ length: n }, (_, i) => { const t = i - m, s = t ? Math.sin(2 * Math.PI * fc * t) / (Math.PI * t) : 2 * fc; return s * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1))); });
  return x.map((_, i) => { let s = 0; for (let k = 0; k < n; k++) s += h[k] * (x[i - k + m] ?? 0); return s; });
}
/** The whole vocoder: analysis every frame, the parameters quantized to 54 bits, and speech made again from them: pulses at the pitch, or noise, through 1/A(z). */
export function vocode(x0: readonly number[], seed = 1): { y: number[]; frames: VocFrame[]; voiced: number } {
  const x = x0.map((v, i) => v - PRE * (x0[i - 1] ?? 0)), lp = lowpass(x0), peak = x.reduce((m, v) => Math.max(m, Math.abs(v)), 1), floor = peak / 100, frames: VocFrame[] = [], y: number[] = [];
  let mem = new Array<number>(VOC.order).fill(0), phase = 0, s = seed, voiced = 0, de = 0;
  const noise = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 31 - 1; };
  for (let at = 0; at < x.length; at += VOC.hop) {
    const fr = analyse(x, at, floor, lp), kq = fr.k.map((k, i) => quantK(k, VOC_BITS.k[i])), a = stepUp(kq), g = quantGain(fr.gain);
    frames.push({ ...fr, k: kq, gain: g });
    if (fr.voiced) voiced++;
    // the excitation at unit power, and the filter's output from it, then the whole frame scaled to the level that was sent
    const n = Math.min(VOC.hop, x.length - at), ex: number[] = [];
    for (let i = 0; i < n; i++) {
      if (fr.voiced) { ex.push(phase === 0 ? Math.sqrt(fr.lag) : 0); phase = (phase + 1) % fr.lag; } else { ex.push(Math.sqrt(3) * noise()); phase = 0; }
    }
    const run = (scale: number, m0: number[]) => { let m = m0.slice(); const out: number[] = []; for (const e of ex) { let v = scale * e; for (let j = 0; j < VOC.order; j++) v += a[j] * m[j]; m = [v, ...m.slice(0, VOC.order - 1)]; out.push(v); } return { out, m }; };
    const free = run(1, new Array<number>(VOC.order).fill(0)).out, rms = Math.sqrt(free.reduce((s2, v) => s2 + v * v, 0) / Math.max(1, n));
    const { out, m } = run(rms > 0 ? g / rms : 0, mem);
    mem = m;
    for (const v of out) { de = v + PRE * de; y.push(Math.max(-32768, Math.min(32767, de))); }
  }
  return { y, frames, voiced };
}
