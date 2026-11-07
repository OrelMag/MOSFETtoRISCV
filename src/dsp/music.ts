// Music (DOM-free): the MDCT with a sine window and its perfect reconstruction, a simplified masking model, and a teaching codec of ours that spends its bits where the mask says
// noise would be heard. No format is followed or claimed. The MDCT is checked against scipy's DCT-IV through the folding identity (scripts/dsp/oracle.py); the masking model's
// constants are from memory and labelled so wherever they are shown.

/** Coefficients a frame: a window of 2M samples moves on by M. At 16 kHz, M = 256 is a 16 ms hop. */
export const MDCT_M = 256;
/** The sine window: w[n]² + w[n + M]² = 1, which is what makes overlapping halves cancel their aliasing (Princen–Bradley). */
export const sineWindow = (M: number): number[] => Array.from({ length: 2 * M }, (_, n) => Math.sin((Math.PI * (n + 0.5)) / (2 * M)));

const cosTable = new Map<number, Float64Array>();
function table(M: number): Float64Array {
  let t = cosTable.get(M);
  if (!t) {
    t = new Float64Array(2 * M * M);
    for (let k = 0; k < M; k++) for (let n = 0; n < 2 * M; n++) t[k * 2 * M + n] = Math.cos((Math.PI / M) * (n + 0.5 + M / 2) * (k + 0.5));
    cosTable.set(M, t);
  }
  return t;
}
/** X[k] = Σ w[n] x[n] cos(π/M (n + ½ + M/2)(k + ½)), n = 0 … 2M − 1: M numbers from 2M samples. */
export function mdct(x: ArrayLike<number>, M = MDCT_M): Float64Array {
  const w = sineWindow(M), t = table(M), X = new Float64Array(M);
  for (let k = 0; k < M; k++) { let s = 0; for (let n = 0; n < 2 * M; n++) s += w[n] * x[n] * t[k * 2 * M + n]; X[k] = s; }
  return X;
}
/** The inverse, windowed again: 2M samples, (2/M) Σ X[k] cos(…) w[n]. Alone each is aliased; overlap-added with its neighbours the aliasing cancels. */
export function imdct(X: ArrayLike<number>, M = MDCT_M): Float64Array {
  const w = sineWindow(M), t = table(M), y = new Float64Array(2 * M);
  for (let n = 0; n < 2 * M; n++) { let s = 0; for (let k = 0; k < M; k++) s += X[k] * t[k * 2 * M + n]; y[n] = (2 / M) * s * w[n]; }
  return y;
}
/** A whole signal through frames, every coefficient passed through `edit` (none: perfect reconstruction), overlap-added back. Edges are padded with M zeros. */
export function mdctRoundTrip(x: readonly number[], edit?: (X: Float64Array, frame: number) => Float64Array, M = MDCT_M): number[] {
  const n = x.length, pad = [...new Array<number>(M).fill(0), ...x, ...new Array<number>(2 * M).fill(0)], out = new Float64Array(pad.length);
  for (let f = 0, at = 0; at + 2 * M <= pad.length; f++, at += M) {
    const X = mdct(pad.slice(at, at + 2 * M), M), y = imdct(edit ? edit(X, f) : X, M);
    for (let i = 0; i < 2 * M; i++) out[at + i] += y[i];
  }
  return Array.from(out.subarray(M, M + n));
}
/** Frames of MDCT coefficients for a signal, for the codec and the plots. */
export function mdctFrames(x: readonly number[], M = MDCT_M): Float64Array[] {
  const pad = [...new Array<number>(M).fill(0), ...x, ...new Array<number>(2 * M).fill(0)], out: Float64Array[] = [];
  for (let at = 0; at + 2 * M <= pad.length; at += M) out.push(mdct(pad.slice(at, at + 2 * M), M));
  return out;
}

// ---- a simplified masking model -------------------------------------------------------------------------------------------------------------

/** Zwicker's approximation of the Bark scale, from memory: 13 atan(0.00076 f) + 3.5 atan((f / 7500)²). */
export const bark = (f: number): number => 13 * Math.atan(0.00076 * f) + 3.5 * Math.atan((f / 7500) ** 2);
/** Terhardt's threshold in quiet, from memory, in dB SPL: what a tone must reach to be heard at all. */
export function quietDb(f: number): number {
  const k = Math.max(f, 20) / 1000;
  return 3.64 * k ** -0.8 - 6.5 * Math.exp(-0.6 * (k - 3.3) ** 2) + 1e-3 * k ** 4;
}
/** The model's knobs, all simplified: a masker spreads 25 dB a Bark downward and 10 upward, and masks at OFFSET below itself. Full scale is taken as 96 dB SPL. */
export const MASK = { down: 25, up: 10, offset: 14, fullScaleSpl: 96 };

export interface Band { lo: number; hi: number; bark: number }
/** Groups of coefficients about a Bark wide (a critical band), from coefficient k to its frequency (k + ½) fs / 2M. */
export function bands(fs: number, M = MDCT_M): Band[] {
  const out: Band[] = [];
  let lo = 0;
  while (lo < M) {
    const z0 = bark(((lo + 0.5) * fs) / (2 * M));
    let hi = lo + 1;
    while (hi < M && bark(((hi + 0.5) * fs) / (2 * M)) - z0 < 1) hi++;
    out.push({ lo, hi, bark: bark(((lo + hi) / 2 * fs) / (2 * M)) });
    lo = hi;
  }
  return out;
}
/** Level in dB of full scale of a band's coefficients, for a signal whose full scale is ±1. */
const toDb = (p: number) => 10 * Math.log10(Math.max(p, 1e-20));
export function bandPowersDb(X: ArrayLike<number>, bs: readonly Band[], M = MDCT_M): number[] {
  // a full-scale sine puts about M²/4 into its coefficient; scale so that reads 0 dB
  return bs.map((b) => { let p = 0; for (let k = b.lo; k < b.hi; k++) p += X[k] * X[k]; return toDb(p / ((M * M) / 4)); });
}
/** The mask per band in dB of full scale: every band's level spread across the others, less OFFSET, summed as powers, and never below the threshold in quiet. Simplified. */
export function maskDb(levels: readonly number[], bs: readonly Band[], fs: number, M = MDCT_M): number[] {
  return bs.map((b, i) => {
    let p = 0;
    levels.forEach((L, j) => { const dz = b.bark - bs[j].bark, spread = dz >= 0 ? -MASK.up * dz : MASK.down * dz; p += 10 ** ((L + spread - MASK.offset) / 10); });
    const width = b.hi - b.lo, quiet = quietDb(((b.lo + b.hi) / 2 * fs) / (2 * M)) - MASK.fullScaleSpl + 10 * Math.log10(width);
    void i;
    return Math.max(toDb(p), quiet);
  });
}

// ---- the codec ------------------------------------------------------------------------------------------------------------------------------

export interface CodecOpts { fs: number; bitsPerFrame: number; by: 'mask' | 'signal'; M?: number }
export interface CodecFrame { bits: number[]; levels: number[]; mask: number[]; noise: number[]; used: number }
/** Bits the side information costs a frame: a 4-bit bit count for every band, and a 6-bit scale factor for each band that has bits. */
export const sideBits = (bits: readonly number[]): number => 4 * bits.length + 6 * bits.filter((b) => b > 0).length;

/**
 * A frame's bits, band by band: each extra bit a coefficient takes lowers that band's noise by 6 dB, and bits go one at a time to the band where the next one buys most for what
 * it costs (a band's coefficients, and its scale factor the first time). By mask, a bit buys the dB it takes off the noise above the mask, and nothing once the noise is well under it.
 * By signal, it buys noise power, wherever it is: the loudest bands first, which is what the best SNR asks for. Same loop, two measures of what a bit is worth.
 */
export function allocate(levels: readonly number[], target: readonly number[] | 'signal', bs: readonly Band[], budget: number): number[] {
  const bits = bs.map(() => 0), width = bs.map((b) => b.hi - b.lo);
  // a band's first bit also pays for its scale factor
  const cost = (i: number) => width[i] + (bits[i] ? 0 : 6);
  // a band with no bits leaves all its signal as noise
  const noise = (i: number) => (bits[i] ? levels[i] + 1.76 - 6.02 * bits[i] : levels[i]);
  // what the next bit buys, per bit it costs: by mask, dB taken off the noise above the mask (none once it is 6 dB under); by signal, noise power removed (a bit takes 3/4 of it)
  const gain = (i: number) => {
    if (target === 'signal') return (10 ** (noise(i) / 10) * 0.75) / cost(i);
    const over = noise(i) - target[i];
    return over <= -6 ? 0 : Math.min(over + 6, 6.02) / cost(i);
  };
  let left = budget - 4 * bs.length;
  for (;;) {
    let best = -1, top = 0;
    for (let i = 0; i < bs.length; i++) { if (bits[i] >= 15 || cost(i) > left) continue; const g = gain(i); if (g > top) { top = g; best = i; } }
    if (best < 0) break;
    left -= cost(best); bits[best]++;
  }
  return bits;
}
/** Uniform quantization of a band's coefficients to `b` bits under its own peak (the scale factor): 2^b levels between ±peak, mid-rise, so even one bit has a level each side of zero. */
export function quantBand(X: Float64Array, lo: number, hi: number, b: number): void {
  let peak = 0;
  for (let k = lo; k < hi; k++) peak = Math.max(peak, Math.abs(X[k]));
  if (!b || !peak) { for (let k = lo; k < hi; k++) X[k] = 0; return; }
  const L = 2 ** b, step = (2 * peak) / L;
  for (let k = lo; k < hi; k++) X[k] = step * (Math.min(L - 1, Math.max(0, Math.floor(X[k] / step + L / 2))) - L / 2 + 0.5);
}
/** The codec over a whole signal: each frame's bands measured, a mask computed, bits given out, coefficients quantized, then the signal rebuilt. */
export function encodeMusic(x: readonly number[], o: CodecOpts): { y: number[]; frames: CodecFrame[]; bitRate: number } {
  const M = o.M ?? MDCT_M, bs = bands(o.fs, M), frames: CodecFrame[] = [];
  const y = mdctRoundTrip(x, (X0) => {
    const X = Float64Array.from(X0), levels = bandPowersDb(X, bs, M), mask = maskDb(levels, bs, o.fs, M);
    const bits = allocate(levels, o.by === 'mask' ? mask : 'signal', bs, o.bitsPerFrame);
    const before = Float64Array.from(X);
    bs.forEach((b, i) => quantBand(X, b.lo, b.hi, bits[i]));
    const noise = bs.map((b) => { let p = 0; for (let k = b.lo; k < b.hi; k++) p += (X[k] - before[k]) ** 2; return toDb(p / ((M * M) / 4)); });
    frames.push({ bits, levels, mask, noise, used: sideBits(bits) + bits.reduce((s, b, i) => s + b * (bs[i].hi - bs[i].lo), 0) });
    return X;
  }, M);
  // the bits actually spent, side information included, not the budget: by mask, a frame stops once the model says nothing more would be heard
  return { y, frames, bitRate: (frames.reduce((s, f) => s + f.used, 0) / Math.max(1, frames.length) * o.fs) / M };
}
/** How far the noise rose above the mask, averaged over bands with something in them: below 0 dB the model says it is not heard. */
export function meanNmrDb(frames: readonly CodecFrame[]): number {
  let s = 0, n = 0;
  for (const f of frames) f.levels.forEach((L, i) => { if (L > -90) { s += f.noise[i] - f.mask[i]; n++; } });
  return s / Math.max(n, 1);
}
/** Share of band-frames whose noise is above the mask. */
export function audibleShare(frames: readonly CodecFrame[]): number {
  let a = 0, n = 0;
  for (const f of frames) f.levels.forEach((L, i) => { if (L > -90) { n++; if (f.noise[i] > f.mask[i]) a++; } });
  return a / Math.max(n, 1);
}
