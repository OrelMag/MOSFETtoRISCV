// A software radio (DOM-free): a synthesized band of four FM stations, and the receiver that picks one out of it. The mixer and the CIC are integer and equal the gates of lib/sdr.ts clock by clock
// (tests/dsp-sdr.test.ts); the channel filter, the discriminator, the audio filter and the de-emphasis are floating point, the DSP core's job, and are labelled so wherever they appear.
// Frequencies are in hertz at the band's rate FS unless a name says otherwise. Carson's rule and the occupied band are measured from an FFT of a station on its own.

import { cx, fft } from '../comm/fourier';
import { signedOf } from '../comm/signals';
import { CicModel, cicDcGain, cicWidth } from './multirate';

export const FS = 960_000;
export const AUD = 24_000;
/** Peak deviation of every station. Broadcast uses 75 kHz; 50 keeps the whole band small enough to draw. */
export const DEV = 50_000;
/** The audio's time constant: the transmitter boosts the treble by it, the receiver takes it back out. */
export const TAU = 75e-6;
export const ALPHA = Math.exp(-1 / (AUD * TAU));

// ---- what the mixer is made of -------------------------------------------------------------------------------------------------------

/** Input words: signed, one ADC for I and one for Q. */
export const W_IN = 10;
/** The oscillator's phase register, and how many of its top bits address the table. */
export const NCO_BITS = 16;
export const NCO_K = 6;
/** The table's peak (so 127 stands for 1.0) and the shift that takes it back out of a product. */
export const NCO_AMP = 127;
export const NCO_SHIFT = 7;
/** The mixer's output word: a rotated sample can be √2 larger than it was. */
export const W_MIX = 11;
export const CIC_N = 4;
export const CIC_R = 4;
export const W_CIC = cicWidth(CIC_N, CIC_R, W_MIX);
/** The rate after the CIC. */
export const FS_CIC = FS / CIC_R;
/** Scale of the band's unit amplitude in ADC steps: the loudest station at its strongest leaves room for the others and a little noise. */
export const ADC_SCALE = 180;

const mod = (v: number, m: number) => ((v % m) + m) % m;
export const wrap = (v: number, w: number) => (v << (32 - w)) >> (32 - w);

/** One period of the oscillator in 2^k steps, signed words of ±NCO_AMP. */
const tables = new Map<number, { cos: readonly number[]; sin: readonly number[] }>();
export function oscTables(k: number = NCO_K): { cos: readonly number[]; sin: readonly number[] } {
  let t = tables.get(k);
  if (!t) {
    const f = (g: (x: number) => number) => Array.from({ length: 2 ** k }, (_, i) => Math.round(NCO_AMP * g((2 * Math.PI * i) / 2 ** k)) + 0);
    tables.set(k, (t = { cos: f(Math.cos), sin: f(Math.sin) }));
  }
  return t;
}
export const SDR_COS: readonly number[] = oscTables().cos;
export const SDR_SIN: readonly number[] = oscTables().sin;

/** The tuning word that turns by f hertz at the band's rate (negative f wraps). */
export const tuningWord = (f: number): number => mod(Math.round((f / FS) * 2 ** NCO_BITS), 2 ** NCO_BITS);
/** The frequency a word really gives. */
export const wordHz = (ftw: number): number => (signedOf(ftw, NCO_BITS) * FS) / 2 ** NCO_BITS;

/**
 * The gates' behaviour: multiply the sample by e^(−jθ) with θ from a phase register, then drop NCO_SHIFT bits (a floor). The phase advances after each sample.
 * (xr + j xi)(cos θ − j sin θ) = (xr cos + xi sin) + j (xi cos − xr sin).
 */
export class MixModel {
  acc = 0;
  private t: ReturnType<typeof oscTables>;
  constructor(public ftw: number, public k: number = NCO_K) { this.t = oscTables(k); }
  /** One clock: the mixed sample, then the phase moves on. */
  edge(xr: number, xi: number): { yr: number; yi: number } {
    const a = this.acc >> (NCO_BITS - this.k), c = this.t.cos[a], s = this.t.sin[a];
    this.acc = (this.acc + this.ftw) & (2 ** NCO_BITS - 1);
    return { yr: (xr * c + xi * s) >> NCO_SHIFT, yi: (xi * c - xr * s) >> NCO_SHIFT };
  }
}

/** The gates' whole front end: mixer, then a CIC on I and on Q. `edge` takes a sample pair, and y holds the last output of each. */
export class FrontModel {
  mix: MixModel;
  ci = new CicModel(CIC_N, CIC_R, W_CIC);
  cq = new CicModel(CIC_N, CIC_R, W_CIC);
  constructor(ftw: number, k: number = NCO_K) { this.mix = new MixModel(ftw, k); }
  edge(xr: number, xi: number): void { const m = this.mix.edge(xr, xi); this.ci.edge(m.yr); this.cq.edge(m.yi); }
  get yr(): number { return this.ci.y; }
  get yi(): number { return this.cq.y; }
  get valid(): boolean { return this.ci.valid; }
}

/** A CIC of this chapter's order and ratio over a whole block: the same registers as CicModel, on typed arrays so a second of band takes milliseconds. One output a group of R, at clock R − 1. */
export function cicBlock(x: ArrayLike<number>): Int32Array {
  const N = CIC_N, R = CIC_R, w = W_CIC, n = Math.floor(x.length / R), out = new Int32Array(n), ints = new Int32Array(N), combs = new Int32Array(N);
  const sh = 32 - w;
  let cnt = 0, o = 0;
  for (let i = 0; i < x.length; i++) {
    // the last integrator's value before this edge is what a group ends on
    const last = ints[N - 1];
    for (let k = N - 1; k > 0; k--) ints[k] = ((ints[k] + ints[k - 1]) << sh) >> sh;
    ints[0] = ((ints[0] + x[i]) << sh) >> sh;
    if (cnt === R - 1) {
      let v = last;
      for (let k = 0; k < N; k++) { const keep = v; v = ((v - combs[k]) << sh) >> sh; combs[k] = keep; }
      out[o++] = v;
    }
    cnt = cnt === R - 1 ? 0 : cnt + 1;
  }
  return out;
}

/** The mixer over a block, from phase 0: the two words it hands the CIC at every clock. Equal to MixModel clock by clock. */
export function mixBlock(xr: ArrayLike<number>, xi: ArrayLike<number>, ftw: number, k: number = NCO_K): { mr: Int32Array; mi: Int32Array } {
  const n = xr.length, mr = new Int32Array(n), mi = new Int32Array(n), c = new Int32Array(2 ** k), s = new Int32Array(2 ** k), t = oscTables(k);
  c.set(t.cos); s.set(t.sin);
  const top = NCO_BITS - k, mask = 2 ** NCO_BITS - 1;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = acc >> top, cc = c[a], ss = s[a];
    mr[i] = (xr[i] * cc + xi[i] * ss) >> NCO_SHIFT;
    mi[i] = (xi[i] * cc - xr[i] * ss) >> NCO_SHIFT;
    acc = (acc + ftw) & mask;
  }
  return { mr, mi };
}

/** Mixer and CIC over a block, from zeros: the two CIC words per output group. Equal to FrontModel clock by clock. */
export function frontBlock(xr: ArrayLike<number>, xi: ArrayLike<number>, ftw: number, k: number = NCO_K): { yr: Int32Array; yi: Int32Array } {
  const { mr, mi } = mixBlock(xr, xi, ftw, k);
  return { yr: cicBlock(mr), yi: cicBlock(mi) };
}

// ---- the band ------------------------------------------------------------------------------------------------------------------------------

/** `fm`: the highest audio frequency the station sends, for Carson's rule. */
export interface Station { f: number; a: number; name: string; short: string; fm: number }
export const STATIONS: readonly Station[] = [
  { f: -300_000, a: 1, name: 'Test tone, 1 kHz', short: 'tone', fm: 1000 },
  { f: -60_000, a: 0.5, name: 'Arpeggio', short: 'arpeggio', fm: 1046 },
  { f: 140_000, a: 0.7, name: 'Sweep', short: 'sweep', fm: 3000 },
  { f: 340_000, a: 0.04, name: 'Weak station, sending Morse', short: 'weak', fm: 700 },
];
export const TEST_TONE_HZ = 1000;
/** Carson's band of one of the four stations, from its own deviation and highest audio frequency. */
export const stationBand = (st: Station): number => 2 * (DEV + st.fm);
const NOTES = [262, 330, 392, 523, 392, 330];
// D S P in Morse: -.. ... .--. , one unit a character of this string
const MORSE = '1110101' + '000' + '10101' + '000' + '10111011101';

/** What station k says, as a block of n audio samples (at AUD) before pre-emphasis. */
export function program(k: number, n: number): Float64Array {
  const m = new Float64Array(n);
  if (k === 0) for (let i = 0; i < n; i++) m[i] = Math.sin((2 * Math.PI * TEST_TONE_HZ * i) / AUD);
  if (k === 1) for (let i = 0; i < n; i++) { const t = i / AUD, st = Math.floor(t * 6), ph = t * 6 - st, f = NOTES[st % 6]; m[i] = Math.exp(-3 * ph) * (Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t)) * 0.8; }
  if (k === 2) { let ph = 0; for (let i = 0; i < n; i++) { const t = i / AUD; ph += (2 * Math.PI * (300 + 2700 * t)) / AUD; m[i] = 0.8 * Math.sin(ph); } }
  if (k === 3) { const unit = n / AUD / MORSE.length; for (let i = 0; i < n; i++) { const t = i / AUD; m[i] = MORSE[Math.min(MORSE.length - 1, Math.floor(t / unit))] === '1' ? 0.8 * Math.sin(2 * Math.PI * 700 * t) : 0; } }
  return m;
}

/** First-order pre-emphasis, scaled so its gain is 1 at the top of the audio band and less below. de-emphasis is its exact inverse. */
export function preEmphasis(m: Float64Array): Float64Array {
  const out = new Float64Array(m.length);
  let prev = 0;
  for (let i = 0; i < m.length; i++) { out[i] = (m[i] - ALPHA * prev) / (1 + ALPHA); prev = m[i]; }
  return out;
}
export function deEmphasis(x: ArrayLike<number>): Float32Array {
  const out = new Float32Array(x.length);
  let prev = 0;
  for (let i = 0; i < x.length; i++) { prev = x[i] * (1 + ALPHA) + ALPHA * prev; out[i] = prev; }
  return out;
}

/** An FM carrier of baseband frequency f carrying audio m (at AUD, linearly interpolated up to FS) with peak deviation `dev`: n complex samples, added into (re, im) at amplitude a. */
export function addFm(re: Float32Array, im: Float32Array, f: number, a: number, m: ArrayLike<number>, dev = DEV): void {
  const n = re.length, up = AUD / FS, base = (2 * Math.PI * f) / FS, gain = (2 * Math.PI * dev) / FS;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const p = i * up, j = Math.floor(p), fr = p - j, v = (m[j] ?? 0) + ((m[j + 1] ?? m[j] ?? 0) - (m[j] ?? 0)) * fr;
    ph += base + gain * v;
    if (ph > Math.PI) ph -= 2 * Math.PI; else if (ph < -Math.PI) ph += 2 * Math.PI;
    re[i] += a * Math.cos(ph); im[i] += a * Math.sin(ph);
  }
}

const peaks = new Map<number, number>();
/** The loudest the pre-emphasised programme of station k gets in its first second (the same whatever length of band is made). */
export function programPeak(k: number): number {
  let p = peaks.get(k);
  if (p === undefined) { const e = preEmphasis(program(k, AUD + 2)); p = Math.max(...e.map(Math.abs)); peaks.set(k, p); }
  return p;
}

export interface Band { n: number; re: Float32Array; im: Float32Array; noiseRe: Float32Array; noiseIm: Float32Array }
const bands = new Map<number, Band>();
/** The four stations, n samples long, and a fixed stream of unit complex Gaussian noise to scale (so the same slider position is the same sound everywhere). */
export function synthBand(n: number = FS): Band {
  const hit = bands.get(n);
  if (hit) return hit;
  const re = new Float32Array(n), im = new Float32Array(n), nre = new Float32Array(n), nim = new Float32Array(n), na = Math.ceil(n / (FS / AUD)) + 2;
  // each station's pre-emphasised programme is scaled so its loudest moment of a second is the peak deviation: a station modulates to its limit, whatever it sends
  STATIONS.forEach((st, k) => {
    const e = preEmphasis(program(k, na)), top = programPeak(k);
    for (let i = 0; i < e.length; i++) e[i] /= top;
    addFm(re, im, st.f, st.a, e, DEV);
  });
  let s = 99;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return (s + 0.5) / 4294967296; };
  for (let i = 0; i < n; i++) { const r = Math.sqrt(-2 * Math.log(rnd())), a = 2 * Math.PI * rnd(); nre[i] = r * Math.cos(a) * Math.SQRT1_2; nim[i] = r * Math.sin(a) * Math.SQRT1_2; }
  const b = { n, re, im, noiseRe: nre, noiseIm: nim };
  bands.set(n, b);
  return b;
}

export const noiseAmp = (noiseDb: number): number => 10 ** (noiseDb / 20);
const ADC_MAX = 2 ** (W_IN - 1) - 1, ADC_MIN = -(2 ** (W_IN - 1));
/** What the two ADCs hand the mixer: the band plus noise at `noiseDb` (power against one station of amplitude 1), rounded to W_IN bits and clipped at full scale. `clipped` counts the samples that hit it. */
export function sample(b: Band, noiseDb: number, from = 0, count = b.n - from): { xr: Int16Array; xi: Int16Array; clipped: number } {
  const g = noiseAmp(noiseDb), xr = new Int16Array(count), xi = new Int16Array(count);
  let clipped = 0;
  for (let i = 0; i < count; i++) {
    const j = from + i, r = Math.round(ADC_SCALE * (b.re[j] + g * b.noiseRe[j])), q = Math.round(ADC_SCALE * (b.im[j] + g * b.noiseIm[j]));
    if (r > ADC_MAX || r < ADC_MIN || q > ADC_MAX || q < ADC_MIN) clipped++;
    xr[i] = Math.max(ADC_MIN, Math.min(ADC_MAX, r)); xi[i] = Math.max(ADC_MIN, Math.min(ADC_MAX, q));
  }
  return { xr, xi, clipped };
}

// ---- after the CIC: the DSP core's part (floating point here) -------------------------------------------------------------------------------

/** A Hamming-windowed sinc with unit gain at DC; fc in cycles per sample of the rate it runs at. */
export function lowpass(n: number, fc: number): Float64Array {
  const m = (n - 1) / 2, h = new Float64Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) { const t = i - m, v = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t); h[i] = v * (0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (n - 1))); sum += h[i]; }
  for (let i = 0; i < n; i++) h[i] /= sum;
  return h;
}
export const CHAN_TAPS = 41, CHAN_EDGE = 75_000;
export const AUDIO_TAPS = 81, AUDIO_EDGE = 10_000, AUDIO_R = FS_CIC / AUD;
export const CHAN = lowpass(CHAN_TAPS, CHAN_EDGE / FS_CIC);
export const AUDIO = lowpass(AUDIO_TAPS, AUDIO_EDGE / FS_CIC);

export function fir(h: ArrayLike<number>, x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length), L = h.length;
  for (let i = 0; i < x.length; i++) { let s = 0; for (let k = 0, m = Math.min(L, i + 1); k < m; k++) s += h[k] * x[i - k]; out[i] = s; }
  return out;
}

/** The phase step between neighbouring samples, as a share of the deviation: arg(z[n] · conj(z[n−1])) · FS_CIC / (2π DEV). */
export function discriminate(re: ArrayLike<number>, im: ArrayLike<number>): Float64Array {
  const n = re.length, out = new Float64Array(n), k = FS_CIC / (2 * Math.PI * DEV);
  for (let i = 1; i < n; i++) out[i] = Math.atan2(im[i] * re[i - 1] - re[i] * im[i - 1], re[i] * re[i - 1] + im[i] * im[i - 1]) * k;
  return out;
}

export interface Chain { fr: Float64Array; fi: Float64Array; disc: Float64Array; audio: Float32Array }
/** From the CIC's words to sound: channel filter, discriminator, audio filter ÷ 10, de-emphasis. */
export function demodulate(yr: ArrayLike<number>, yi: ArrayLike<number>): Chain {
  const fr = fir(CHAN, yr), fi = fir(CHAN, yi), disc = discriminate(fr, fi), n = Math.floor(disc.length / AUDIO_R), dec = new Float64Array(n);
  for (let i = 0; i < n; i++) { const a = i * AUDIO_R; let v = 0; for (let k = 0, m = Math.min(AUDIO_TAPS, a + 1); k < m; k++) v += AUDIO[k] * disc[a - k]; dec[i] = v; }
  return { fr, fi, disc, audio: deEmphasis(dec) };
}

export interface Reception { chain: Chain; yr: Int32Array; yi: Int32Array; clipped: number }
/** The receiver on a stretch of the band: sample, mix, CIC, then the rest. */
export function receive(b: Band, f: number, noiseDb: number, count = b.n, k: number = NCO_K): Reception {
  const { xr, xi, clipped } = sample(b, noiseDb, 0, count), { yr, yi } = frontBlock(xr, xi, tuningWord(f), k);
  return { chain: demodulate(yr, yi), yr, yi, clipped };
}

// ---- measurements ---------------------------------------------------------------------------------------------------------------------------

/** The station within 25 kHz of a tuning, if there is one. */
export const stationAt = (f: number): Station | undefined => STATIONS.find((s) => Math.abs(s.f - f) <= 25_000);

/** The tone's power against everything else in the audio: a sine and cosine of the tone are fitted by least squares and subtracted, the mean taken out, and what is left is everything else. dB. */
export function toneSnr(aud: ArrayLike<number>, tone = TEST_TONE_HZ, skip = 2000): number {
  const N = aud.length - skip - ((aud.length - skip) % (AUD / tone));
  let c = 0, s = 0, m = 0;
  for (let i = 0; i < N; i++) { const w = (2 * Math.PI * tone * i) / AUD; c += aud[skip + i] * Math.cos(w); s += aud[skip + i] * Math.sin(w); m += aud[skip + i]; }
  c *= 2 / N; s *= 2 / N; m /= N;
  let e = 0;
  for (let i = 0; i < N; i++) { const w = (2 * Math.PI * tone * i) / AUD, r = aud[skip + i] - m - c * Math.cos(w) - s * Math.sin(w); e += r * r; }
  return 10 * Math.log10((c * c + s * s) / 2 / (e / N));
}

/** Carson's rule: a band that holds nearly all the power of an FM signal with peak deviation `dev` and highest modulating frequency `fm`. */
export const carson = (dev: number, fm: number): number => 2 * (dev + fm);
export const modIndex = (dev: number, fm: number): number => dev / fm;

/** One sine-modulated FM carrier at baseband, n samples at FS. */
export function toneFm(dev: number, fm: number, n = 2 ** 16): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(n), im = new Float64Array(n), beta = dev / fm;
  for (let i = 0; i < n; i++) { const ph = beta * Math.sin((2 * Math.PI * fm * i) / FS); re[i] = Math.cos(ph); im[i] = Math.sin(ph); }
  return { re, im };
}
/** The narrowest band centred on the carrier that holds `share` of the power, in hertz, from an FFT of the block. */
export function occupied(x: { re: Float64Array; im: Float64Array }, share = 0.98): number {
  const N = x.re.length, X = fft(cx(x.re, x.im)), p = new Float64Array(N);
  let total = 0;
  for (let k = 0; k < N; k++) { p[k] = X.re[k] ** 2 + X.im[k] ** 2; total += p[k]; }
  let held = p[0];
  for (let half = 1; half < N / 2; half++) {
    held += p[half] + p[N - half];
    if (held >= share * total) return ((2 * half + 1) * FS) / N;
  }
  return FS;
}
/** The power spectrum of a band in dB from its peak, averaged over frames (Hann), bins from −FS/2 up. */
export function bandSpectrum(xr: ArrayLike<number>, xi: ArrayLike<number>, M = 2048, frames = 24): Float64Array {
  const avg = new Float64Array(M), n = xr.length;
  for (let f = 0; f < frames; f++) {
    const o = Math.floor((f * (n - M)) / frames), re = new Float64Array(M), im = new Float64Array(M);
    for (let i = 0; i < M; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / M); re[i] = xr[o + i] * w; im[i] = xi[o + i] * w; }
    const X = fft({ re, im });
    for (let i = 0; i < M; i++) avg[i] += X.re[i] ** 2 + X.im[i] ** 2;
  }
  const out = new Float64Array(M);
  let peak = 0;
  for (let i = 0; i < M; i++) peak = Math.max(peak, avg[i]);
  for (let i = 0; i < M; i++) out[i] = 10 * Math.log10(Math.max(avg[(i + M / 2) % M], 1e-30) / peak);
  return out;
}

/** Carrier to noise in a station's own band, dB: its power against the noise inside Carson's band. */
export const carrierToNoise = (a: number, noiseDb: number, bw: number): number => 20 * Math.log10(a) - noiseDb + 10 * Math.log10(FS / bw);

export const CIC_GAIN = cicDcGain(CIC_N, CIC_R);
/** Multiplications a second, in real arithmetic, of each stage of the receiver (a complex sample is two real ones through a real filter). */
export const workPerSecond = {
  mixer: 4 * FS,
  channel: 2 * CHAN_TAPS * FS_CIC,
  audio: AUDIO_TAPS * AUD,
};

// ---- how fine a table -------------------------------------------------------------------------------------------------------------------------

/** Spurious-free range of the mixer, dB: a steady carrier at 137 kHz mixed by an oscillator 300 Hz away, the largest line of the output outside the carrier's own bins against the carrier's. */
export function mixerSfdr(k: number = NCO_K): number {
  const n = 1 << 14, xr = new Int16Array(n), xi = new Int16Array(n), fin = 137_000;
  for (let i = 0; i < n; i++) { xr[i] = Math.round(400 * Math.cos((2 * Math.PI * fin * i) / FS)); xi[i] = Math.round(400 * Math.sin((2 * Math.PI * fin * i) / FS)); }
  const { mr, mi } = mixBlock(xr, xi, tuningWord(fin + 300), k), re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n); re[i] = mr[i] * w; im[i] = mi[i] * w; }
  const X = fft({ re, im }), p = Array.from({ length: n }, (_, i) => X.re[i] ** 2 + X.im[i] ** 2);
  let peak = 0, at = 0;
  p.forEach((v, i) => { if (v > peak) { peak = v; at = i; } });
  let spur = 0;
  p.forEach((v, i) => { if (Math.min(Math.abs(i - at), n - Math.abs(i - at)) > 4 && v > spur) spur = v; });
  return 10 * Math.log10(peak / spur);
}

/** The weak station's keying: units on and off of the Morse the transmitter sent. */
export const morseUnits = (): string => MORSE;
/** Power while the key is down against power while it is up, dB, over the audio of the weak station (one second): what the receiver can tell apart. The 'up' units are the noise and the spurs of the loud stations beside it. */
export function keyingRatio(aud: ArrayLike<number>): number {
  const n = aud.length, unit = n / MORSE.length;
  let on = 0, off = 0, non = 0, noff = 0;
  for (let u = 1; u < MORSE.length - 1; u++) {
    if (MORSE[u] !== MORSE[u - 1] || MORSE[u] !== MORSE[u + 1]) continue;
    const a = Math.floor(u * unit + unit * 0.25), b = Math.floor((u + 1) * unit - unit * 0.25);
    let q = 0;
    for (let i = a; i < b; i++) q += aud[i] * aud[i];
    q /= b - a;
    if (MORSE[u] === '1') { on += q; non++; } else { off += q; noff++; }
  }
  return 10 * Math.log10(on / non / (off / noff));
}

/** Below this a keying ratio means the keying is lost: key up is as loud as key down, and the figure is only the ratio of two unrelated stretches of garbage (it scatters around 0 dB, either side). */
export const KEYING_LOST_DB = 3;
