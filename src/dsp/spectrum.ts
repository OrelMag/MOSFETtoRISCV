// Measuring a spectrum (DOM-free): windows, leakage, resolution, spectrograms, overlap-save fast convolution, and Goertzel, floating and in words.
// Frequency is cycles a sample (comm/signals.ts), a window is the periodic form that spectral analysis uses (the DFT-even window, scipy's sym=False),
// and every transform is comm/fourier.ts's fft: the instrument is not rebuilt here. A value is a signed JS number; words follow dsp/fixed.ts
// (the Goertzel state is an integer, the coefficient Q2.14, the product rounded half up once). tests/dsp-spectrum.test.ts holds this to scipy's vectors.

import { cx, fft, fftMults } from '../comm/fourier';
import { convolve } from './zplane';
import { bitsToHold, satTo, shiftRound, wrapTo } from './fixed';

// ---- windows ---------------------------------------------------------------------------------------------------------------------------------

export type WinKind = 'rect' | 'hann' | 'hamming' | 'blackman' | 'blackmanharris' | 'kaiser';
export const KAISER_BETA = 8;
/** Generalized cosine windows: w[n] = Σ (−1)^k a[k] cos(2πkn/N). */
const COSINE: Partial<Record<WinKind, number[]>> = { rect: [1], hann: [0.5, 0.5], hamming: [0.54, 0.46], blackman: [0.42, 0.5, 0.08], blackmanharris: [0.35875, 0.48829, 0.14128, 0.01168] };
export const WINDOWS: { id: WinKind; name: string }[] = [
  { id: 'rect', name: 'Rectangular (none)' }, { id: 'hann', name: 'Hann' }, { id: 'hamming', name: 'Hamming' },
  { id: 'blackman', name: 'Blackman' }, { id: 'blackmanharris', name: 'Blackman–Harris (4 terms)' }, { id: 'kaiser', name: `Kaiser, β = ${KAISER_BETA}` },
];
export const windowName = (k: WinKind): string => WINDOWS.find((w) => w.id === k)!.name;
export const cosineTerms = (k: WinKind): number[] | undefined => COSINE[k];

/** Modified Bessel function of order 0, by its power series. */
export function bessel0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 200; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-18 * sum) break; }
  return sum;
}

export function windowOf(kind: WinKind, N: number, beta = KAISER_BETA): number[] {
  const a = COSINE[kind];
  if (a) return Array.from({ length: N }, (_, n) => a.reduce((s, c, k) => s + (k % 2 ? -c : c) * Math.cos((2 * Math.PI * k * n) / N), 0));
  return Array.from({ length: N }, (_, n) => bessel0(beta * Math.sqrt(Math.max(0, 1 - ((2 * n) / N - 1) ** 2))) / bessel0(beta));
}

const sum = (v: readonly number[]) => v.reduce((s, x) => s + x, 0);

/** Equivalent noise bandwidth in bins: N Σw² / (Σw)². White noise through the window grows by this much compared with the rectangular one. */
export const enbwBins = (w: readonly number[]): number => (w.length * sum(w.map((v) => v * v))) / sum(w) ** 2;
/** The same from a cosine window's terms alone: (a0² + Σ a_k² / 2) / a0². Exact for the periodic window. */
export const enbwClosed = (a: readonly number[]): number => (a[0] ** 2 + a.slice(1).reduce((s, c) => s + (c * c) / 2, 0)) / a[0] ** 2;

// ---- transforms ------------------------------------------------------------------------------------------------------------------------------

export const dbOf = (m: number, floor = -240): number => Math.max(floor, 20 * Math.log10(Math.max(m, 1e-15)));
export const tone = (N: number, f: number, A = 1, phase = 0): number[] => Array.from({ length: N }, (_, n) => A * Math.cos(2 * Math.PI * f * n + phase));
const pow2 = (n: number): number => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/** |DFT| of the windowed block, zero padded to a power of two of at least `pad` × N points, scaled so a bin-centred cosine of amplitude A reads A. Bins 0 … P/2. */
export function amplitudeSpectrum(x: readonly number[], kind: WinKind = 'rect', pad = 1): number[] {
  const N = x.length, P = pow2(N * pad), w = windowOf(kind, N), g = 2 / sum(w);
  const re = new Float64Array(P);
  for (let n = 0; n < N; n++) re[n] = x[n] * w[n];
  const X = fft(cx(re));
  return Array.from({ length: P / 2 + 1 }, (_, k) => g * Math.hypot(X.re[k], X.im[k]));
}
/** The padded length used for N points at `pad`. */
export const paddedLength = (N: number, pad: number): number => pow2(N * pad);

export interface WindowFigures {
  /** Σw / N: the loss of a tone that sits on a bin. */
  coherentGain: number;
  enbw: number;
  /** First local minimum of the window's transform, in bins; the main lobe is twice this wide. */
  firstMin: number;
  mainLobeBins: number;
  /** The highest sidelobe against the peak, dB (negative). */
  sidelobeDb: number;
  /** Loss at half a bin off the tone's frequency, dB (positive). */
  scallopDb: number;
}
const GRID = 32;
/** The window's transform on a grid of 1/32 bin, by zero padding: the shape a tone's skirt has. Index i is the frequency i / 32 bins; value |W| / |W(0)|. */
export function windowTransform(kind: WinKind, N = 128, bins = 24): number[] {
  const w = windowOf(kind, N), P = N * GRID, re = new Float64Array(P);
  w.forEach((v, n) => { re[n] = v; });
  const X = fft(cx(re)), s = Math.hypot(X.re[0], X.im[0]);
  return Array.from({ length: bins * GRID + 1 }, (_, i) => Math.hypot(X.re[i], X.im[i]) / s);
}
export function windowFigures(kind: WinKind, N = 128): WindowFigures {
  const w = windowOf(kind, N), t = windowTransform(kind, N, Math.min(48, N / 2 - 1));
  let i = 1;
  while (i < t.length - 1 && !(t[i] <= t[i - 1] && t[i] <= t[i + 1])) i++;
  const sidelobe = Math.max(...t.slice(i));
  return { coherentGain: sum(w) / N, enbw: enbwBins(w), firstMin: i / GRID, mainLobeBins: (2 * i) / GRID, sidelobeDb: dbOf(sidelobe), scallopDb: -dbOf(t[GRID / 2]) };
}

/** Level of the window's skirt at `bins` from the tone, dB against its peak: the worst of the grid points within half a bin of there. */
export function skirtAt(kind: WinKind, bins: number, N = 128): number {
  const t = windowTransform(kind, N, Math.ceil(bins) + 2), c = Math.round(bins * GRID);
  return dbOf(Math.max(...t.slice(Math.max(0, c - GRID / 2), c + GRID / 2 + 1)));
}

// ---- two tones -------------------------------------------------------------------------------------------------------------------------------

export interface Pair { N: number; f1: number; sep: number; relDb: number }
/** A cosine whose phase is zero at the middle of the block, so that two of them add in phase there: what a window's transform assumes (otherwise the pair's skirts cancel or add by luck of phase). */
export const centred = (N: number, f: number, A = 1): number[] => tone(N, f, A, (-2 * Math.PI * f * (N - 1)) / 2);
/** Two cosines, the second `sep` bins above the first and `relDb` below it. */
export function twoTones(p: Pair): number[] {
  const a = centred(p.N, p.f1 / p.N), b = centred(p.N, (p.f1 + p.sep) / p.N, 10 ** (p.relDb / 20));
  return a.map((v, i) => v + b[i]);
}
export const PAIR_AT = 0.3; // the first tone sits at bin N / 4 + 0.3: off a bin centre, away from DC and Nyquist
export const pairOf = (N: number, sep: number, relDb = 0): Pair => ({ N, f1: N / 4 + PAIR_AT, sep, relDb });
const PAD = 16;

export interface Dip { /** dB between the lower of the two tones' levels and the lowest point between them (0 when the spectrum never dips). */ dipDb: number; resolved: boolean }
export const DIP_NEEDED = 3;
/** Two equal tones are resolved when the spectrum between them falls DIP_NEEDED dB under both. */
/** `perBin` points of the padded transform to each bin of the block: paddedLength(N, pad) / N. */
export function dipIn(S: readonly number[], perBin: number, nuA: number, nuB: number): Dip {
  const a = Math.round(nuA * perBin), b = Math.round(nuB * perBin);
  let lo = Infinity;
  for (let i = a; i <= b; i++) lo = Math.min(lo, S[i]);
  const dip = Math.max(0, dbOf(Math.min(S[a], S[b])) - dbOf(lo));
  return { dipDb: dip, resolved: dip >= DIP_NEEDED };
}
export function dipOf(N: number, sep: number, kind: WinKind): Dip {
  const p = pairOf(N, sep);
  return dipIn(amplitudeSpectrum(twoTones(p), kind, PAD), paddedLength(N, PAD) / N, p.f1, p.f1 + sep);
}
/** The smallest separation (steps of 0.05 bin) at which equal tones are resolved. */
export function resolvingSep(N: number, kind: WinKind): number {
  for (let s = 5; s <= 600; s++) if (dipOf(N, s / 20, kind).resolved) return s / 20;
  return Infinity;
}

export const SEEN_BY = 6;
/** Is the second tone seen? Its frequency reads at least SEEN_BY dB away (up, or down where it cancels the first tone's skirt) from what the first tone alone puts there. */
export function seenAt(N: number, sep: number, relDb: number, kind: WinKind): { seen: boolean; byDb: number } {
  const p = pairOf(N, sep, relDb), both = amplitudeSpectrum(twoTones(p), kind, PAD), alone = amplitudeSpectrum(centred(N, p.f1 / N), kind, PAD);
  const i = Math.round((p.f1 + sep) * (paddedLength(N, PAD) / N)), by = dbOf(both[i]) - dbOf(alone[i]);
  return { seen: Math.abs(by) >= SEEN_BY, byDb: by };
}
/** The weakest level (dB under the first tone, in steps of 1) still seen, counting down from 0 while every level above it is seen too. */
export function weakestSeen(N: number, sep: number, kind: WinKind, floor = -140): number {
  let last = 1;
  for (let r = 0; r >= floor; r--) { if (!seenAt(N, sep, r, kind).seen) break; last = r; }
  return last === 1 ? Infinity : last;
}

// ---- time and frequency ----------------------------------------------------------------------------------------------------------------------

/** A linear chirp: cycles a sample from f0 to f1 over n samples. */
export const chirp = (n: number, f0: number, f1: number, A = 1): number[] => Array.from({ length: n }, (_, i) => A * Math.sin(2 * Math.PI * (f0 * i + ((f1 - f0) * i * i) / (2 * n))));
export const SG_LEN = 2048;
/** The spectrogram's signal: a rising chirp, a steady tone, and two short bursts of another tone, each under a raised-cosine envelope so that it is a tone and not a click. */
const burst = (i: number, s: number): number => (i >= s && i < s + 128 ? 0.5 * Math.sin((Math.PI * (i - s)) / 128) ** 2 * Math.sin(2 * Math.PI * 0.06 * i) : 0);
export function spectrogramSignal(n = SG_LEN): number[] {
  const c = chirp(n, 0.03, 0.4, 0.5), t = tone(n, 0.25, 0.3);
  return c.map((v, i) => v + t[i] + burst(i, 512) + burst(i, 1280));
}
/** Frames of amplitude spectra (bins 0 … N/2), a frame every `hop` samples while a whole frame fits. */
export function spectrogram(x: readonly number[], N: number, hop: number, kind: WinKind): number[][] {
  const out: number[][] = [];
  for (let s = 0; s + N <= x.length; s += hop) out.push(amplitudeSpectrum(x.slice(s, s + N), kind, 1));
  return out;
}
export const frameCount = (len: number, N: number, hop: number): number => (len < N ? 0 : Math.floor((len - N) / hop) + 1);

// ---- overlap-save ----------------------------------------------------------------------------------------------------------------------------

export interface OlsRun { y: number[]; blocks: number; hop: number }
/** Linear convolution by blocks of N: each block is the last M − 1 inputs and L = N − M + 1 new ones, through FFT, a product, and an inverse FFT; the first M − 1 outputs of a block
 *  are circular wrap-around and are thrown away. The full output (x.length + M − 1 samples). `keepAll` keeps them, to show what they are. */
export function overlapSave(x: readonly number[], h: readonly number[], N: number, keepAll = false): OlsRun {
  const M = h.length, L = N - M + 1;
  if (L < 1) throw new Error(`overlapSave: a block of ${N} cannot hold ${M} taps`);
  const total = x.length + M - 1, H = fft(cx([...h, ...new Array<number>(N - M).fill(0)]));
  const padded = [...new Array<number>(M - 1).fill(0), ...x, ...new Array<number>(total + N).fill(0)];
  const y: number[] = [];
  let blocks = 0;
  for (let s = 0; y.length < total; s += L) {
    const X = fft(cx(padded.slice(s, s + N))), re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < N; k++) { re[k] = X.re[k] * H.re[k] - X.im[k] * H.im[k]; im[k] = X.re[k] * H.im[k] + X.im[k] * H.re[k]; }
    const r = fft({ re, im }, true).re;
    y.push(...Array.from(r.slice(keepAll ? 0 : M - 1)));
    blocks++;
  }
  return { y: keepAll ? y : y.slice(0, total), blocks, hop: L };
}
/** What a block's circular result gets wrong: the largest error in its first M − 1 samples (wrap-around) and in the rest, against the true convolution. */
export function blockErrors(x: readonly number[], h: readonly number[], N: number): { wrapped: number; kept: number } {
  const M = h.length, L = N - M + 1, want = convolve(x, h), H = fft(cx([...h, ...new Array<number>(N - M).fill(0)]));
  const padded = [...new Array<number>(M - 1).fill(0), ...x, ...new Array<number>(N).fill(0)];
  let wrapped = 0, kept = 0;
  for (let b = 0; b * L < want.length; b++) {
    const X = fft(cx(padded.slice(b * L, b * L + N))), re = new Float64Array(N), im = new Float64Array(N);
    for (let k = 0; k < N; k++) { re[k] = X.re[k] * H.re[k] - X.im[k] * H.im[k]; im[k] = X.re[k] * H.im[k] + X.im[k] * H.re[k]; }
    const r = fft({ re, im }, true).re;
    for (let i = 0; i < N; i++) {
      const pos = b * L + i - (M - 1), e = Math.abs(r[i] - (pos >= 0 && pos < want.length ? want[pos] : 0));
      if (i < M - 1) wrapped = Math.max(wrapped, e); else kept = Math.max(kept, e);
    }
  }
  return { wrapped, kept };
}
/** Real multiplications a sample: direct form one a tap; blocks two FFTs and N products of complex numbers per L outputs, 4 real each, the real input's savings not taken. */
export const directMults = (M: number): number => M;
export const olsMults = (M: number, N: number): number => (4 * (2 * fftMults(N) + N)) / (N - M + 1);
/** The power-of-two block that costs least for M taps. */
export function bestBlock(M: number): number {
  let best = pow2(M + 1), cost = Infinity;
  for (let N = pow2(M + 1); N <= 2 ** 16; N *= 2) { const c = olsMults(M, N); if (c < cost) { cost = c; best = N; } else break; }
  return best;
}
/** The fewest taps for which the best block beats the direct form. */
export function crossoverTaps(): number {
  for (let M = 2; M < 4096; M++) if (olsMults(M, bestBlock(M)) < directMults(M)) return M;
  return Infinity;
}

// ---- Goertzel --------------------------------------------------------------------------------------------------------------------------------

export const goertzelCoef = (f: number): number => 2 * Math.cos(2 * Math.PI * f);
/** s[n] = x[n] + c s[n−1] − s[n−2] over a block; the last two states. */
export function goertzelRun(x: readonly number[], c: number): { s1: number; s2: number; states: number[] } {
  let s1 = 0, s2 = 0;
  const states: number[] = [];
  for (const v of x) { const s = v + c * s1 - s2; states.push(s); s2 = s1; s1 = s; }
  return { s1, s2, states };
}
/** |X(f)|² from the last two states: s1² + s2² − c s1 s2, three multiplications for the whole block. */
export const goertzelPower = (s1: number, s2: number, c: number): number => s1 * s1 + s2 * s2 - c * s1 * s2;
/** |Σ x[n] e^(−j2πfn)|² by its definition, N complex multiplications. */
export function dftPowerAt(x: readonly number[], f: number): number {
  let re = 0, im = 0;
  x.forEach((v, n) => { re += v * Math.cos(2 * Math.PI * f * n); im -= v * Math.sin(2 * Math.PI * f * n); });
  return re * re + im * im;
}

export const COEF_FRAC = 14;
export const COEF_BITS = 16;
/** 2 cos(2πf) as a Q2.14 word, saturated (only f = 0 reaches +2). */
export const coefWord = (f: number): number => satTo(Math.round(goertzelCoef(f) * 2 ** COEF_FRAC), COEF_BITS);

export interface GzFx { s1: number; s2: number; overflowed: boolean; peak: number }
/** The gates' recursion: s = x + round(C s1 / 2^14) − s2 in an sw-bit word that wraps; `overflowed` says the true value ever left it. */
export function goertzelFx(x: readonly number[], C: number, sw: number): GzFx {
  let s1 = 0, s2 = 0, over = false, peak = 0;
  for (const v of x) {
    const t = v + shiftRound(C * s1, COEF_FRAC, 'half-up') - s2, s = wrapTo(t, sw);
    if (s !== t) over = true;
    peak = Math.max(peak, Math.abs(t));
    s2 = s1; s1 = s;
  }
  return { s1, s2, overflowed: over, peak };
}
export const fxPower = (g: GzFx, C: number): number => goertzelPower(g.s1, g.s2, C / 2 ** COEF_FRAC);

/** Σ|h[k]| for k < N: the most the state can reach per unit of input amplitude, for the recursion with this coefficient word. */
export function stateGain(C: number, N: number): number {
  const c = C / 2 ** COEF_FRAC;
  let h1 = 0, h2 = 0, g = 0;
  for (let k = 0; k < N; k++) { const h = (k === 0 ? 1 : 0) + c * h1 - h2; g += Math.abs(h); h2 = h1; h1 = h; }
  return g;
}
/** Word width that holds the state for inputs from −128 to 127 and every coefficient given: the worst input's sum, plus half a step of rounding a sample. */
export function stateBits(Cs: readonly number[], N: number): number {
  return bitsToHold(Math.ceil(128.5 * Math.max(...Cs.map((C) => stateGain(C, N)))));
}
/** The worst input for a block: the sign of the impulse response, reversed, at full scale. */
export function worstInput(C: number, N: number): number[] {
  const c = C / 2 ** COEF_FRAC, h: number[] = [];
  let h1 = 0, h2 = 0;
  for (let k = 0; k < N; k++) { const v = (k === 0 ? 1 : 0) + c * h1 - h2; h.push(v); h2 = h1; h1 = v; }
  return Array.from({ length: N }, (_, n) => (h[N - 1 - n] >= 0 ? 127 : -128));
}

/** Multiplications for K bins of an N-point block: Goertzel one a sample a bin, the FFT's butterflies at 4 real each (all bins at once). */
export const goertzelMults = (K: number, N: number): number => K * N;
export const fftRealMults = (N: number): number => 4 * fftMults(N);
/** How many bins before the FFT is cheaper: 4 (N / 2) log₂N / N = 2 log₂N. */
export const binsBreakEven = (N: number): number => fftRealMults(N) / N;

// ---- DTMF ------------------------------------------------------------------------------------------------------------------------------------

export const DTMF_ROWS = [697, 770, 852, 941] as const;
export const DTMF_COLS = [1209, 1336, 1477, 1633] as const;
export const DTMF_KEYS = ['123A', '456B', '789C', '*0#D'] as const;
export const DTMF_FS = 8000;
export const dtmfFreqs = (): number[] => [...DTMF_ROWS, ...DTMF_COLS];
export function keyAt(key: string): { row: number; col: number } {
  for (let r = 0; r < 4; r++) { const c = DTMF_KEYS[r].indexOf(key); if (c >= 0) return { row: r, col: c }; }
  throw new Error(`no DTMF key ${key}`);
}

/** The block size ≤ nMax for which the eight tones sit closest to a bin centre (the worst offset, in bins). */
export function bestBlockFor(freqs: readonly number[], fs: number, nMax: number, nMin = 64): { N: number; worst: number } {
  let best = { N: nMin, worst: Infinity };
  for (let N = nMin; N <= nMax; N++) {
    const worst = Math.max(...freqs.map((f) => Math.abs((f * N) / fs - Math.round((f * N) / fs))));
    if (worst < best.worst) best = { N, worst };
  }
  return best;
}
/** How far from a bin centre a tone is for a block of N, in bins. */
export const binOffset = (f: number, N: number, fs = DTMF_FS): number => { const k = (f * N) / fs; return k - Math.round(k); };

/** A key's block: its two tones at `amp` each, plus seeded noise of ± `noise`, rounded to integers and clamped to a byte. */
export function dtmfBlock(key: string, N: number, opts: { amp?: number; noise?: number; seed?: number } = {}): number[] {
  const { row, col } = keyAt(key), amp = opts.amp ?? 50, noise = opts.noise ?? 0;
  let v = (opts.seed ?? 1) >>> 0;
  const u = () => { v = (Math.imul(v, 1664525) + 1013904223) >>> 0; return v / 2 ** 31 - 1; };
  return Array.from({ length: N }, (_, n) => {
    const s = amp * (Math.cos((2 * Math.PI * DTMF_ROWS[row] * n) / DTMF_FS) + Math.cos((2 * Math.PI * DTMF_COLS[col] * n) / DTMF_FS)) + noise * u();
    return Math.max(-128, Math.min(127, Math.round(s))) + 0;
  });
}
export interface DtmfRead { key: string | null; row: number; col: number; why: string }
/** Our rule, not a standard's: the strongest of each group must beat the runner-up in its group by RATIO, and reach a power of MIN_AMP's tone. */
export const RATIO = 4;
export const MIN_AMP = 10;
export function dtmfDecode(power: readonly number[], N: number): DtmfRead {
  const pick = (g: readonly number[]) => { const o = g.map((p, i) => [p, i]).sort((a, b) => b[0] - a[0]); return { i: o[0][1], p: o[0][0], next: o[1][0] }; };
  const r = pick(power.slice(0, 4)), c = pick(power.slice(4)), floor = ((MIN_AMP * N) / 2) ** 2;
  if (r.p < floor || c.p < floor) return { key: null, row: r.i, col: c.i, why: 'a tone is too weak' };
  if (r.p < RATIO * r.next || c.p < RATIO * c.next) return { key: null, row: r.i, col: c.i, why: 'two tones in one group are close in power' };
  return { key: DTMF_KEYS[r.i][c.i], row: r.i, col: c.i, why: 'one tone in each group stands out' };
}

/** A keypress as sound: the key's two tones for `on` samples, silence for `off`, floating point, at DTMF_FS. */
export function dtmfClip(keys: string, on = 800, off = 480, amp = 0.4): number[] {
  const out: number[] = [];
  for (const k of keys) {
    const { row, col } = keyAt(k);
    for (let n = 0; n < on; n++) out.push(amp * (Math.cos((2 * Math.PI * DTMF_ROWS[row] * n) / DTMF_FS) + Math.cos((2 * Math.PI * DTMF_COLS[col] * n) / DTMF_FS)));
    for (let n = 0; n < off; n++) out.push(0);
  }
  return out;
}
