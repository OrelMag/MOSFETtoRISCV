// Fourier for chapters 45 and 46 (DOM-free). A periodic NRZ pattern as harmonics, through phys/line.ts's single pole; the DFT, a
// radix-2 FFT and its count of multiplications; an OFDM block over an FIR channel. tests/comm-fourier.test.ts holds the harmonic sum
// to the pole's closed-form periodic response, the FFT to the plain DFT, and the block to one complex tap per tone.

import { rng } from '../phys/line';

/** A bit pattern repeated forever, ±1 NRZ. The patterns the widget offers. */
export const PATTERNS: { name: string; bits: number[] }[] = [
  { name: '1010: the fastest', bits: [1, 0] },
  { name: '1100', bits: [1, 1, 0, 0] },
  { name: '11110000', bits: [1, 1, 1, 1, 0, 0, 0, 0] },
  { name: 'One 1 in eight', bits: [1, 0, 0, 0, 0, 0, 0, 0] },
  { name: '11101000', bits: [1, 1, 1, 0, 1, 0, 0, 0] },
];

/** The time constant of a pole of `b` GHz, in ns (as phys/line.ts's channel; 1000 / (2π b) there is in ps). */
export const tauOf = (b: number): number => 1 / (2 * Math.PI * b);
/** What a pole of `b` GHz keeps of the last level after one bit at `r` Gb/s: chapter 46's a. */
export const aOf = (r: number, b: number): number => Math.exp((-2 * Math.PI * b) / r);
/** The pole's gain at `f` GHz. */
export const poleGain = (f: number, b: number): number => 1 / Math.hypot(1, f / b);
/** The pole's phase at `f` GHz, radians (negative). */
export const polePhase = (f: number, b: number): number => -Math.atan(f / b);
export const toDb = (g: number): number => 20 * Math.log10(g);

// ---- a periodic pattern as harmonics ----------------------------------------------------------------------------------------

/** One harmonic of a periodic wave: k cycles a period, amplitude and phase of A cos(2π k t / T + φ). */
export interface Harmonic { k: number; amp: number; phase: number }
export interface Series { dc: number; harmonics: Harmonic[] }

/**
 * The Fourier series of the ±1 NRZ pattern (one bit lasts 1 / n of the period): exact, from the bits' DFT times the spectrum of
 * one rectangular bit. Harmonics of amplitude below 1e-12 are left out (the even ones of 1010, each n-th of any pattern).
 */
export function seriesOf(bits: readonly number[], kMax: number): Series {
  const n = bits.length, lv = bits.map((b) => (b ? 1 : -1));
  const out: Harmonic[] = [];
  for (let k = 1; k <= kMax; k++) {
    // c_k = (1/T) ∫ x(t) e^(−j2πkt/T) dt, bit i over [i, i + 1) T / n
    let re = 0, im = 0;
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * k * i) / n, b = (2 * Math.PI * k * (i + 1)) / n;
      re += (lv[i] * (Math.sin(b) - Math.sin(a))) / (2 * Math.PI * k);
      im += (lv[i] * (Math.cos(b) - Math.cos(a))) / (2 * Math.PI * k);
    }
    const amp = 2 * Math.hypot(re, im);
    if (amp > 1e-12) out.push({ k, amp, phase: Math.atan2(im, re) });
  }
  return { dc: lv.reduce((a, b) => a + b, 0) / n, harmonics: out };
}

/** The sum at time `t` in bits (the period is `n` bits), of the first `count` harmonics given. */
export function sumAt(s: Series, n: number, t: number, count = s.harmonics.length): number {
  let v = s.dc;
  for (let i = 0; i < count && i < s.harmonics.length; i++) { const h = s.harmonics[i]; v += h.amp * Math.cos((2 * Math.PI * h.k * t) / n + h.phase); }
  return v;
}

/** The series after a pole of `b` GHz, the pattern's bits at `r` Gb/s: each harmonic scaled and turned by the pole at its own frequency. */
export function throughPole(s: Series, n: number, r: number, b: number): Series {
  const f0 = r / n;
  return { dc: s.dc, harmonics: s.harmonics.map((h) => ({ k: h.k, amp: h.amp * poleGain(h.k * f0, b), phase: h.phase + polePhase(h.k * f0, b) })) };
}

/** The pole's periodic steady state in the time domain, at the start of each bit: y[i + 1] = x[i] + (y[i] − x[i]) a, closed around the period. */
export function periodicStarts(bits: readonly number[], a: number): number[] {
  const n = bits.length, lv = bits.map((v) => (v ? 1 : -1));
  // y0 = Σ_i x_i (1 − a) a^(n − 1 − i) + a^n y0
  let y = 0;
  for (let i = 0; i < n; i++) y = lv[i] + (y - lv[i]) * a;
  y /= 1 - a ** n;
  const out = [y];
  for (let i = 0; i < n - 1; i++) { y = lv[i] + (y - lv[i]) * a; out.push(y); }
  return out;
}

/** The pole's output at `t` bits (closed form within the bit). */
export function poleAt(bits: readonly number[], r: number, b: number, t: number): number {
  const n = bits.length, a = aOf(r, b), ys = periodicStarts(bits, a);
  const tt = ((t % n) + n) % n, i = Math.min(n - 1, Math.floor(tt)), x = bits[i] ? 1 : -1;
  return x + (ys[i] - x) * a ** (tt - i);
}

/** The smallest end-of-bit sample, in the bit's own direction, of a repeating pattern through the pole: how far its worst bit gets. */
export const smallestSample = (bits: readonly number[], r: number, b: number): number => Math.min(...bits.map((v, i) => (v ? 1 : -1) * poleAt(bits, r, b, i + 1 - 1e-9)));

/** Half the swing of the repeating 1010 at a pole: (1 − a) / (1 + a) at the sampling instant. */
export const swing1010 = (a: number): number => (1 - a) / (1 + a);

/** The share of a ±1 square wave's power in its first `count` (odd) harmonics: (8 / π²) Σ 1 / k². */
export function powerShare(count: number): number {
  let s = 0;
  for (let i = 0; i < count; i++) s += 1 / (2 * i + 1) ** 2;
  return (8 / Math.PI ** 2) * s;
}

/** The first peak of a ±1 square wave cut to `count` odd harmonics, at ωt = π / (2 count). */
export function gibbsPeak(count: number): number {
  let v = 0;
  for (let i = 0; i < count; i++) { const k = 2 * i + 1; v += Math.sin((k * Math.PI) / (2 * count)) / k; }
  return (4 / Math.PI) * v;
}
/** The overshoot as a fraction of the step (2 for ±1); tends to 8.95 %. */
export const gibbsOvershoot = (count: number): number => (gibbsPeak(count) - 1) / 2;

// ---- the DFT and the FFT ----------------------------------------------------------------------------------------------------

export interface Cx { re: Float64Array; im: Float64Array }
export const cx = (re: ArrayLike<number>, im?: ArrayLike<number>): Cx => ({ re: Float64Array.from(re), im: im ? Float64Array.from(im) : new Float64Array(re.length) });

/** The DFT by its definition, X[k] = Σ x[n] e^(−j2πkn/N): N² complex multiplications. */
export function dft(x: Cx): Cx {
  const N = x.re.length, re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < N; k++) for (let n = 0; n < N; n++) {
    const w = (-2 * Math.PI * k * n) / N, c = Math.cos(w), s = Math.sin(w);
    re[k] += x.re[n] * c - x.im[n] * s;
    im[k] += x.re[n] * s + x.im[n] * c;
  }
  return { re, im };
}

/** Multiplications of a radix-2 FFT of N points, one a butterfly, the trivial twiddles counted (as chapter 45 does). */
export const fftMults = (N: number): number => (N / 2) * Math.log2(N);

/** A radix-2 decimation-in-time FFT of a power-of-two length; `mults` counts its butterflies. `inverse` divides by N. */
/** cos / sin of step·k for every stage of an N-point transform (one table per size and direction; the same expressions as computed in the loop, so the values are identical). */
const twiddles = new Map<string, { c: Float64Array; s: Float64Array }>();
function twiddlesOf(N: number, inverse: boolean): { c: Float64Array; s: Float64Array } {
  const key = `${N}${inverse ? 'i' : 'f'}`;
  let t = twiddles.get(key);
  if (!t) {
    const c = new Float64Array(N), s = new Float64Array(N);
    for (let size = 2; size <= N; size *= 2) {
      const half = size / 2, step = ((inverse ? 2 : -2) * Math.PI) / size;
      for (let k = 0; k < half; k++) { c[half + k] = Math.cos(step * k); s[half + k] = Math.sin(step * k); }
    }
    t = { c, s };
    if (twiddles.size >= 8) twiddles.delete(twiddles.keys().next().value!);
    twiddles.set(key, t);
  }
  return t;
}

export function fft(x: Cx, inverse = false): Cx & { mults: number } {
  const N = x.re.length;
  if (N & (N - 1)) throw new Error(`fft: ${N} is not a power of two`);
  const re = Float64Array.from(x.re), im = Float64Array.from(x.im), bits = Math.log2(N);
  for (let i = 0; i < N; i++) {
    let j = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) j |= 1 << (bits - 1 - b);
    if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  let mults = 0;
  const tw = twiddlesOf(N, inverse);
  for (let size = 2; size <= N; size *= 2) {
    const half = size / 2;
    for (let st = 0; st < N; st += size) for (let k = 0; k < half; k++) {
      const c = tw.c[half + k], s = tw.s[half + k], a = st + k, b = a + half;
      const tr = re[b] * c - im[b] * s, ti = re[b] * s + im[b] * c;
      re[b] = re[a] - tr; im[b] = im[a] - ti;
      re[a] += tr; im[a] += ti;
      mults++;
    }
  }
  if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
  return { re, im, mults };
}

/** Σ tone k · conj(tone m) over a block of N: N when k = m, else 0. What lets one FFT separate the tones. */
export function toneOverlap(k: number, m: number, N: number): { re: number; im: number } {
  let re = 0, im = 0;
  for (let n = 0; n < N; n++) { const w = (2 * Math.PI * (k - m) * n) / N; re += Math.cos(w); im += Math.sin(w); }
  return { re, im };
}

// ---- a block of tones over a channel ----------------------------------------------------------------------------------------

/** QPSK points by two bits: (±1 ± j) / √2, Gray. */
export const qpsk = (b1: number, b0: number): [number, number] => [(b1 ? -1 : 1) / Math.SQRT2, (b0 ? -1 : 1) / Math.SQRT2];

/** `n` seeded QPSK symbols. */
export function randomQpsk(n: number, seed: number): [number, number][] {
  const u = rng(seed);
  return Array.from({ length: n }, () => qpsk(u() < 0.5 ? 1 : 0, u() < 0.5 ? 1 : 0));
}

/**
 * A real time block of N samples carrying `syms` on tones 1 … syms.length: tone k's conjugate on N − k makes the inverse FFT real,
 * so N points carry N / 2 − 1 tones (DC and N / 2 stay empty). This is how ADSL's 512 points carry its tones 1 … 255 (G.992.1 numbers 256, from 0; tone 0 is DC).
 */
export function blockOf(syms: readonly (readonly [number, number])[], N: number): Float64Array {
  if (syms.length > N / 2 - 1) throw new Error('blockOf: too many tones');
  const re = new Float64Array(N), im = new Float64Array(N);
  syms.forEach(([a, b], i) => { const k = i + 1; re[k] = a; im[k] = b; re[N - k] = a; im[N - k] = -b; });
  return fft({ re, im }, true).re;
}

/** The channel's gain per tone: H[k] = Σ h[n] e^(−j2πkn/N). */
export function toneGains(taps: readonly number[], N: number): Cx {
  const re = new Float64Array(N), im = new Float64Array(N);
  re.set(taps.slice(0, N));
  return dft({ re, im });
}

export const withPrefix = (block: ArrayLike<number>, cp: number): Float64Array => {
  const N = block.length, out = new Float64Array(N + cp);
  for (let i = 0; i < cp; i++) out[i] = block[N - cp + i];
  for (let i = 0; i < N; i++) out[cp + i] = block[i];
  return out;
};

/** Linear convolution, the output as long as the input (what a sample stream sees). */
export function fir(x: ArrayLike<number>, taps: readonly number[]): Float64Array {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) for (let t = 0; t < taps.length && t <= i; t++) y[i] += taps[t] * x[i - t];
  return y;
}

export interface OfdmResult {
  /** The block, with its prefix, as sent and as received (this block's slot only). */
  sent: Float64Array;
  received: Float64Array;
  /** Per tone, for tones 1 …: the channel's gain, the FFT's output, and that output divided by the gain (one complex tap). */
  gain: [number, number][];
  raw: [number, number][];
  equalized: [number, number][];
  /** rms distance of `equalized` from what was sent, against the symbols' rms: the error vector. */
  evm: number;
}

/**
 * A block after another block (`prev`, whose tail runs into it) over an FIR channel: the prefix cut off, an FFT, a division by the
 * channel's gain on each tone. With a prefix of at least len(taps) − 1 the output is H[k] X[k], exact.
 */
export function ofdmLink(syms: readonly (readonly [number, number])[], prev: readonly (readonly [number, number])[], N: number, cp: number, taps: readonly number[]): OfdmResult {
  const a = withPrefix(blockOf(prev, N), cp), sent = withPrefix(blockOf(syms, N), cp);
  const stream = new Float64Array(a.length + sent.length);
  stream.set(a); stream.set(sent, a.length);
  const y = fir(stream, taps), received = y.slice(a.length);
  const R = fft({ re: received.slice(cp, cp + N), im: new Float64Array(N) }), H = toneGains(taps, N);
  const gain: [number, number][] = [], raw: [number, number][] = [], equalized: [number, number][] = [];
  let e = 0, p = 0;
  syms.forEach(([xr, xi], i) => {
    const k = i + 1, hr = H.re[k], hi = H.im[k], d = hr * hr + hi * hi || 1e-300, r = R.re[k], m = R.im[k];
    const qr = (r * hr + m * hi) / d, qi = (m * hr - r * hi) / d;
    gain.push([hr, hi]); raw.push([r, m]); equalized.push([qr, qi]);
    e += (qr - xr) ** 2 + (qi - xi) ** 2; p += xr * xr + xi * xi;
  });
  return { sent, received, gain, raw, equalized, evm: Math.sqrt(e / (p || 1)) };
}

/** Wrong bits among QPSK symbols sent and decided (by the signs). */
export function qpskErrors(sent: readonly (readonly [number, number])[], got: readonly (readonly [number, number])[]): number {
  let e = 0;
  sent.forEach(([a, b], i) => { if (a < 0 !== got[i][0] < 0) e++; if (b < 0 !== got[i][1] < 0) e++; });
  return e;
}
