// "Tune it", the signal-processing capstone (DOM-free): a band the learner has not seen holds a weak FM station keying a message in Morse, and the
// learner's chain of the radio chapter's blocks must find it and decode the message. Bands are seeded (STATIONS in dsp/sdr.ts stays the chapter's).
// The mixer and the CICs are integer, the gates' arithmetic (mixBlock, and cicRun equal to CicModel / lib/multirate.ts clock by clock: tests/dsp-tune.test.ts);
// everything after them is floating point, the DSP core's part, as in the chapter. When a band fails, the cause is measured by running the same chain
// on the parts of the band one at a time (the wanted station, each other station, the noise), never stated.

import { addFm, ADC_SCALE, DEV, FS, lowpass, mixBlock, NCO_BITS, preEmphasis, program, TAU, W_IN, W_MIX } from './sdr';
import { cicWidth, halfBand } from './multirate';
import { cordicVector } from './cordic';

// ---- seeds -----------------------------------------------------------------------------------------------------------------------------------

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- Morse ----------------------------------------------------------------------------------------------------------------------------------

export const MORSE_CODE: Readonly<Record<string, string>> = {
  A: '.-', B: '-...', C: '-.-.', D: '-..', E: '.', F: '..-.', G: '--.', H: '....', I: '..', J: '.---', K: '-.-', L: '.-..', M: '--', N: '-.', O: '---', P: '.--.', Q: '--.-', R: '.-.',
  S: '...', T: '-', U: '..-', V: '...-', W: '.--', X: '-..-', Y: '-.--', Z: '--..', 0: '-----', 1: '.----', 2: '..---', 3: '...--', 4: '....-', 5: '.....', 6: '-....', 7: '--...', 8: '---..', 9: '----.',
};
const FROM_MORSE = new Map(Object.entries(MORSE_CODE).map(([c, m]) => [m, c]));

/** A message as keying units, one character of the string a unit: a dot 1, a dash 3, 1 between marks, 3 between letters, 7 between words. */
export function keyingOf(text: string): string {
  return text.trim().split(/\s+/).map((w) => [...w].map((c) => [...MORSE_CODE[c]].map((m) => (m === '.' ? '1' : '111')).join('0')).join('000')).join('0000000');
}
/** Where each unit of the keying belongs: the index of its character in the text (spaces count), or −1 between letters. */
export function unitOwners(text: string): number[] {
  const own: number[] = [];
  const words = text.trim().split(/\s+/);
  let at = 0;
  words.forEach((w, wi) => {
    [...w].forEach((c, ci) => {
      const k = [...MORSE_CODE[c]].map((m) => (m === '.' ? '1' : '111')).join('0');
      for (let i = 0; i < k.length; i++) own.push(at + ci);
      if (ci < w.length - 1) own.push(-1, -1, -1);
    });
    at += w.length + 1;
    if (wi < words.length - 1) for (let i = 0; i < 7; i++) own.push(-1);
  });
  return own;
}

/** Short messages an amateur station might send, so a band takes a couple of seconds. */
export const MESSAGES = ['SOS', 'CQ DE', 'QRV', '73 GL', 'PSE K', 'TEST', 'QTH', 'FB OM', 'TNX', 'DSP', 'RST 5', 'QSL', 'GM', 'HI HI', 'WX', 'AGN'];
/** The keying speed: 30 words a minute, a unit of 40 ms. The decoder is told it, as an operator would know the speed. */
export const UNIT_S = 0.04;
export const TONE_MIN = 500, TONE_MAX = 900;
/** Silence before the message and after it, seconds. */
export const LEAD_S = 0.15, TAIL_S = 0.25;

// ---- a band ---------------------------------------------------------------------------------------------------------------------------------

export interface TuneStation { f: number; a: number; prog: 0 | 1 | 2 | 'morse' }
export interface TuneBand {
  seed: number;
  stations: TuneStation[];
  /** The weak station's index in `stations`. */
  weak: number;
  message: string;
  keying: string;
  toneHz: number;
  noiseDb: number;
  /** Samples at FS. */
  n: number;
}

/** Strong stations' amplitudes, as in the chapter. */
const STRONG_A = [1, 0.7, 0.5];
export const BAND_EDGE = 420_000;
/** How far the loud station sits from the weak one: past half the rate a CIC ÷ 4 leaves, so it folds into the channel. */
export const FOLD_KHZ: [number, number] = [175, 205];
/** The noise, in dB against a station of amplitude 1 over the whole band. */
export const NOISE_DB: [number, number] = [-46, -42];
/** The weak station against the loudest, dB: weak enough that a coarse oscillator table's spurs, a folding neighbour or a gentle channel edge each take a band. */
export const WEAK_DB: [number, number] = [-36, -42];

/**
 * A band: the weak station somewhere, a strong station far enough off for a CIC ÷ 4 to fold it into the channel (just past half the decimated rate),
 * one close beside it that a wide or gentle channel filter lets in, and one elsewhere. Then noise. Every attempt's bands put the same three traps in
 * a new place, so no fixed setting carries from one band to the next.
 */
export function makeBand(seed: number): TuneBand {
  const r = rng(seed), pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)];
  const khz = (lo: number, hi: number) => 1000 * Math.round((lo + (hi - lo) * r()) / 1000);
  for (;;) {
    const fw = khz(-BAND_EDGE, BAND_EDGE), sgn = () => (r() < 0.5 ? -1 : 1);
    const fold = fw + sgn() * khz(FOLD_KHZ[0] * 1000, FOLD_KHZ[1] * 1000), near = fw + sgn() * khz(108_000, 124_000), far = khz(-BAND_EDGE, BAND_EDGE);
    const fs = [fold, near, far];
    if (fs.some((f) => Math.abs(f) > BAND_EDGE)) continue;
    const all = [fw, ...fs];
    if (all.some((f, i) => all.some((g, j) => j > i && Math.abs(f - g) < 104_000))) continue;
    if (Math.abs(far - fw) < 160_000) continue;
    const order = [0, 1, 2].sort(() => r() - 0.5) as (0 | 1 | 2)[], amps = [...STRONG_A].sort(() => r() - 0.5);
    const a = 10 ** ((WEAK_DB[0] + (WEAK_DB[1] - WEAK_DB[0]) * r()) / 20);
    const message = pick(MESSAGES), keying = keyingOf(message), toneHz = 50 * Math.round((TONE_MIN + (TONE_MAX - TONE_MIN) * r()) / 50);
    const n = Math.round((LEAD_S + keying.length * UNIT_S + TAIL_S) * FS);
    const stations: TuneStation[] = [{ f: fw, a, prog: 'morse' }, ...fs.map((f, i) => ({ f, a: amps[i], prog: order[i] }))];
    // the fold trap gets the loudest station, so it bites
    stations[1].a = 1; stations[2].a = Math.min(stations[2].a, 0.7); if (stations[3].a === 1) stations[3].a = 0.5;
    return { seed, stations, weak: 0, message, keying, toneHz, noiseDb: NOISE_DB[0] + (NOISE_DB[1] - NOISE_DB[0]) * r(), n };
  }
}

/** The practice band: the one the learner sees, hears and may tune by hand. */
export const PRACTICE_SEED = 7;
/** The five graded bands of an attempt. */
/** The attempts the page draws from: each one checked by tests/dsp-tune-attempts.test.ts, so the reference decodes all five bands and the starting chain fails at least one. */
export const ATTEMPTS: readonly number[] = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
export const attemptSeeds = (attempt: number): number[] => Array.from({ length: 5 }, (_, i) => 1000 + 37 * attempt + 7919 * i);

/** The weak station's audio before pre-emphasis: the tone, keyed with 4 ms raised-cosine edges so the keying makes no clicks. n samples at AUD. */
export function morseProgram(b: TuneBand, aud: number, n: number): Float64Array {
  const m = new Float64Array(n), ramp = 0.004;
  for (let i = 0; i < n; i++) {
    const t = i / aud - LEAD_S, u = Math.floor(t / UNIT_S);
    if (t < 0 || u >= b.keying.length) continue;
    // distance into the mark it sits in, and to its end
    let s = u, e = u;
    if (b.keying[u] !== '1') continue;
    while (s > 0 && b.keying[s - 1] === '1') s--;
    while (e < b.keying.length - 1 && b.keying[e + 1] === '1') e++;
    const into = t - s * UNIT_S, left = (e + 1) * UNIT_S - t, g = Math.min(1, into / ramp, left / ramp), w = 0.5 - 0.5 * Math.cos(Math.PI * g);
    m[i] = 0.8 * w * Math.sin(2 * Math.PI * b.toneHz * (i / aud));
  }
  return m;
}

/** A strong station's programme: the chapter's first second, played forward, then backward, and so on, so it never jumps and never leaves the band it has in the chapter (the sweep would climb on). */
function oneSecond(k: 0 | 1 | 2, n: number): Float64Array {
  const s = program(k, AUD_SYN), out = new Float64Array(n);
  for (let i = 0; i < n; i++) { const p = Math.floor(i / AUD_SYN), j = i % AUD_SYN; out[i] = s[p % 2 ? AUD_SYN - 1 - j : j]; }
  return out;
}
const AUD_SYN = 24_000;
/** Each station's pre-emphasised programme scaled so its loudest moment is the peak deviation, as in the chapter. */
function stationAudio(b: TuneBand, st: TuneStation): Float64Array {
  const na = Math.ceil(b.n / (FS / AUD_SYN)) + 2, m = st.prog === 'morse' ? morseProgram(b, AUD_SYN, na) : oneSecond(st.prog, na), e = preEmphasis(m);
  let top = 0;
  for (const v of e) top = Math.max(top, Math.abs(v));
  for (let i = 0; i < e.length; i++) e[i] /= top || 1;
  return e;
}

export interface Part { stations?: readonly number[]; noise?: boolean }
const ADC_MAX = 2 ** (W_IN - 1) - 1, ADC_MIN = -(2 ** (W_IN - 1));

/** What the ADCs hand the mixer: the chosen stations and, if asked, the noise, rounded and clipped to W_IN bits. The noise is the band's own, the same in every part. */
export function sampleBand(b: TuneBand, part: Part = {}): { xr: Int16Array; xi: Int16Array } {
  const re = new Float32Array(b.n), im = new Float32Array(b.n), only = part.stations ?? b.stations.map((_, i) => i), noise = part.noise ?? true;
  for (const k of only) { const st = b.stations[k]; addFm(re, im, st.f, st.a, stationAudio(b, st), DEV); }
  if (noise) {
    const r = rng(b.seed * 31 + 5), g = 10 ** (b.noiseDb / 20) * Math.SQRT1_2;
    for (let i = 0; i < b.n; i++) { const m = Math.sqrt(-2 * Math.log(1 - r())), a = 2 * Math.PI * r(); re[i] += g * m * Math.cos(a); im[i] += g * m * Math.sin(a); }
  }
  const xr = new Int16Array(b.n), xi = new Int16Array(b.n);
  for (let i = 0; i < b.n; i++) {
    xr[i] = Math.max(ADC_MIN, Math.min(ADC_MAX, Math.round(ADC_SCALE * re[i])));
    xi[i] = Math.max(ADC_MIN, Math.min(ADC_MAX, Math.round(ADC_SCALE * im[i])));
  }
  return { xr, xi };
}

// ---- the blocks -----------------------------------------------------------------------------------------------------------------------------

export type Tune = { mode: 'fixed'; hz: number } | { mode: 'find'; marginDb: number };
export type Block =
  | { kind: 'mixer'; tune: Tune; bits: number }
  | { kind: 'cic'; N: number; R: number }
  | { kind: 'halfband'; taps: number }
  | { kind: 'poly'; taps: number; R: number }
  | { kind: 'channel'; taps: number; cutoff: number }
  | { kind: 'disc'; method: 'phase' | 'cordic'; stages: number }
  | { kind: 'audio'; taps: number; cutoff: number; M: number }
  | { kind: 'deemph' }
  | { kind: 'morse'; threshold: 'auto' | number };
export type Kind = Block['kind'];
export type Chain = Block[];

export const BLOCK_NAME: Record<Kind, string> = {
  mixer: 'Mixer', cic: 'CIC ÷ R', halfband: 'Half-band ÷ 2', poly: 'Polyphase ÷ R', channel: 'Channel filter', disc: 'Discriminator', audio: 'Audio filter ÷ M', deemph: 'De-emphasis', morse: 'Morse decoder',
};

/** What each setting may be. */
export const LIMITS = {
  bits: [4, 10], N: [1, 5], cicR: [2, 4, 8, 16], taps: [3, 255], polyR: [2, 3, 4, 5, 6, 8, 10], M: [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 16, 20, 24, 25, 30, 40], stages: [2, 16], marginDb: [0, 60],
} as const;

/** The chapter's receiver, with "find it" in place of a dial: what the page starts from. It fails some band of every attempt, for a measured reason. */
export const DEFAULT_CHAIN: Chain = [
  { kind: 'mixer', tune: { mode: 'find', marginDb: 12 }, bits: 6 },
  { kind: 'cic', N: 4, R: 4 },
  { kind: 'channel', taps: 41, cutoff: 75_000 },
  { kind: 'disc', method: 'phase', stages: 12 },
  { kind: 'audio', taps: 81, cutoff: 10_000, M: 10 },
  { kind: 'morse', threshold: 'auto' },
];

/** Where a block may go: the gates first (the mixer, then any CICs), then the complex filters, the discriminator, the audio blocks, the decoder last. */
const STAGE: Record<Kind, number> = { mixer: 0, cic: 1, halfband: 2, poly: 2, channel: 2, disc: 3, audio: 4, deemph: 4, morse: 5 };

export interface Rates { inRate: number; outRate: number }
/** Why a chain cannot run, or null. Also the rate into and out of each block. */
export function checkChain(c: Chain): { problem: string | null; rates: Rates[] } {
  const rates: Rates[] = [];
  let rate = FS, problem: string | null = null;
  const say = (p: string) => { problem ??= p; };
  if (c[0]?.kind !== 'mixer') say('The chain starts with the mixer: it is what brings the station to zero.');
  if (c.filter((b) => b.kind === 'mixer').length !== 1) say('One mixer, at the start.');
  if (c.filter((b) => b.kind === 'disc').length !== 1) say('One discriminator: FM is turned into sound there.');
  if (c[c.length - 1]?.kind !== 'morse' || c.filter((b) => b.kind === 'morse').length !== 1) say('One Morse decoder, at the end.');
  for (let i = 1; i < c.length; i++) {
    if (STAGE[c[i].kind] < STAGE[c[i - 1].kind]) {
      const b = c[i], why = b.kind === 'cic' ? 'A CIC is gates: it goes straight after the mixer, before anything floating point.' : STAGE[b.kind] === 2 ? `The ${BLOCK_NAME[b.kind].toLowerCase()} filters the complex signal, so it comes before the discriminator.` : `The ${BLOCK_NAME[b.kind].toLowerCase()} works on sound, so it comes after the discriminator.`;
      say(why);
    }
  }
  for (const b of c) {
    const R = b.kind === 'cic' || b.kind === 'poly' ? b.R : b.kind === 'halfband' ? 2 : b.kind === 'audio' ? b.M : 1, out = rate / R;
    if (!Number.isInteger(out)) say(`${BLOCK_NAME[b.kind]}: ${rate.toLocaleString('en')} samples a second do not divide by ${R}.`);
    if ((b.kind === 'channel' || b.kind === 'audio') && !(b.cutoff > 0 && b.cutoff < rate / 2)) say(`${BLOCK_NAME[b.kind]}: its cutoff must be between 0 and half the rate it runs at (${(rate / 2000).toLocaleString('en')} kHz).`);
    if ('taps' in b && (b.taps < LIMITS.taps[0] || b.taps > LIMITS.taps[1] || b.taps % 2 === 0)) say(`${BLOCK_NAME[b.kind]}: an odd number of taps from ${LIMITS.taps[0]} to ${LIMITS.taps[1]}.`);
    rates.push({ inRate: rate, outRate: out });
    rate = out;
  }
  if (!problem && rate < 2 * TONE_MAX + 200) say(`The decoder gets ${rate.toLocaleString('en')} samples a second: too few for a tone of up to ${TONE_MAX} Hz.`);
  return { problem, rates };
}

const wrapW = (v: number, w: number) => (v << (32 - w)) >> (32 - w);
/** An order-N CIC ÷ R in w-bit registers over a block, from zeros: the registers of CicModel, one output a group of R, at clock R − 1. */
export function cicRun(x: Int32Array, N: number, R: number, w: number): Int32Array {
  const n = Math.floor(x.length / R), out = new Int32Array(n), ints = new Int32Array(N), combs = new Int32Array(N);
  let cnt = 0, o = 0;
  for (let i = 0; i < x.length; i++) {
    const last = ints[N - 1];
    for (let k = N - 1; k > 0; k--) ints[k] = wrapW(ints[k] + ints[k - 1], w);
    ints[0] = wrapW(ints[0] + x[i], w);
    if (cnt === R - 1) {
      let v = last;
      for (let k = 0; k < N; k++) { const keep = v; v = wrapW(v - combs[k], w); combs[k] = keep; }
      out[o++] = v;
    }
    cnt = cnt === R - 1 ? 0 : cnt + 1;
  }
  return out;
}

/** y[j] = Σ h[k] x[jR − k]: an FIR keeping one output in R (R = 1: every one). */
export function firDec(h: ArrayLike<number>, x: ArrayLike<number>, R: number): Float64Array {
  const n = Math.floor(x.length / R), out = new Float64Array(n), L = h.length;
  for (let j = 0; j < n; j++) { const a = j * R; let s = 0; for (let k = 0, m = Math.min(L, a + 1); k < m; k++) s += h[k] * x[a - k]; out[j] = s; }
  return out;
}
const unitDc = (h: number[]) => { const s = h.reduce((a, b) => a + b, 0); return h.map((v) => v / s); };
export const halfBandTaps = (n: number): number[] => unitDc(halfBand(n));
export const polyTapsFor = (n: number, R: number): number[] => Array.from(lowpass(n, 0.45 / R));

/** The phase step between samples as a share of the deviation (the chapter's discriminator), at any rate. */
export function discPhase(re: Float64Array, im: Float64Array, rate: number): Float64Array {
  const n = re.length, out = new Float64Array(n), k = rate / (2 * Math.PI * DEV);
  for (let i = 1; i < n; i++) out[i] = Math.atan2(im[i] * re[i - 1] - re[i] * im[i - 1], re[i] * re[i - 1] + im[i] * im[i - 1]) * k;
  return out;
}
/** The same angle by CORDIC vectoring (dsp/cordic.ts) on the product scaled into 14-bit words: n stages leave an angle error of about atan 2^−n. */
export function discCordic(re: Float64Array, im: Float64Array, rate: number, stages: number): Float64Array {
  const n = re.length, out = new Float64Array(n), k = rate / DEV, pr = new Float64Array(n), pi = new Float64Array(n);
  let peak = 0;
  for (let i = 1; i < n; i++) { pr[i] = re[i] * re[i - 1] + im[i] * im[i - 1]; pi[i] = im[i] * re[i - 1] - re[i] * im[i - 1]; peak = Math.max(peak, Math.abs(pr[i]), Math.abs(pi[i])); }
  const s = peak > 0 ? 8191 / peak : 0, spec = { w: 16, z: 16, n: stages };
  for (let i = 1; i < n; i++) {
    const t = cordicVector(Math.round(pr[i] * s), Math.round(pi[i] * s), spec).turn;
    out[i] = (t > 0.5 ? t - 1 : t) * k;
  }
  return out;
}
/** De-emphasis at any rate, its gain 1 at DC: the inverse of the transmitter's lift. */
export function deEmph(x: Float64Array, rate: number): Float64Array {
  const a = Math.exp(-1 / (rate * TAU)), out = new Float64Array(x.length);
  let p = 0;
  for (let i = 0; i < x.length; i++) { p = (1 - a) * x[i] + a * p; out[i] = p; }
  return out;
}

// ---- finding the station ---------------------------------------------------------------------------------------------------------------------

/** The band's spectrum the mixer looks at: dB, 2048 bins of 469 Hz from −FS/2, averaged over Hann frames. */
export const FIND_BINS = 2048;
export function findSpectrum(xr: Int16Array, xi: Int16Array, frames = 32): Float64Array {
  const M = FIND_BINS, avg = new Float64Array(M), n = xr.length;
  const w = Array.from({ length: M }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / M));
  for (let f = 0; f < frames; f++) {
    const o = Math.floor((f * (n - M)) / Math.max(1, frames - 1)), re = new Float64Array(M), im = new Float64Array(M);
    for (let i = 0; i < M; i++) { re[i] = xr[o + i] * w[i]; im[i] = xi[o + i] * w[i]; }
    fftInPlace(re, im);
    for (let i = 0; i < M; i++) avg[i] += re[i] ** 2 + im[i] ** 2;
  }
  const out = new Float64Array(M);
  for (let i = 0; i < M; i++) out[i] = 10 * Math.log10(Math.max(avg[(i + M / 2) % M], 1e-12) / frames);
  return out;
}
function fftInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}
export const binHz = (i: number): number => ((i - FIND_BINS / 2) * FS) / FIND_BINS;

export interface Found { hz: number | null; standsDb: number; candidates: number }
/**
 * "Find it": the weakest line in the band that stands at least `marginDb` above what is around it (the median of ±25 kHz). A keyed FM station rests on
 * its carrier between marks, which is a line; a loud station's power is spread over its whole channel. Too small a margin takes a ripple of the noise
 * for a station; too large finds nothing.
 */
export function findStation(spec: Float64Array, marginDb: number): Found {
  const M = spec.length, half = Math.round(25_000 / (FS / M));
  let best: { i: number; level: number; stands: number } | null = null, count = 0;
  for (let i = half; i < M - half; i++) {
    if (!(spec[i] > spec[i - 1] && spec[i] >= spec[i + 1])) continue;
    const around = Array.from(spec.subarray(i - half, i + half + 1)).sort((a, b) => a - b), med = around[half], stands = spec[i] - med;
    if (stands < marginDb) continue;
    count++;
    if (!best || spec[i] < best.level) best = { i, level: spec[i], stands };
  }
  if (!best) return { hz: null, standsDb: 0, candidates: 0 };
  const { i } = best, a = spec[i - 1], b = spec[i], c = spec[i + 1], d = a - 2 * b + c, off = d === 0 ? 0 : (0.5 * (a - c)) / d;
  return { hz: binHz(i + off), standsDb: best.stands, candidates: count };
}

// ---- running a chain ------------------------------------------------------------------------------------------------------------------------

export interface Run {
  tunedHz: number | null;
  found?: Found;
  /** The complex signal the discriminator is given, and its rate. */
  chanRe: Float64Array; chanIm: Float64Array; chanRate: number;
  /** The rate of each stage of the complex signal between the CICs' last output and the discriminator, for the fold check. */
  audio: Float64Array; audioRate: number;
  decoded: Decoded;
}
export interface RunOpts { part?: Part; tuneHz?: number; bitsOver?: number; skipDecode?: boolean; input?: { xr: Int16Array; xi: Int16Array } }

/** The chain on a band (or on a part of it, tuned where the whole band tuned it). */
export function runChain(c: Chain, b: TuneBand, o: RunOpts = {}): Run {
  const { rates } = checkChain(c), input = o.input ?? sampleBand(b, o.part);
  const mx = c[0] as Extract<Block, { kind: 'mixer' }>;
  let tuned: number | null = o.tuneHz ?? null, found: Found | undefined;
  if (o.tuneHz === undefined) {
    if (mx.tune.mode === 'fixed') tuned = mx.tune.hz;
    else { found = findStation(findSpectrum(input.xr, input.xi), mx.tune.marginDb); tuned = found.hz; }
  }
  const bits = o.bitsOver ?? mx.bits, ftw = ((Math.round(((tuned ?? 0) / FS) * 2 ** NCO_BITS) % 2 ** NCO_BITS) + 2 ** NCO_BITS) % 2 ** NCO_BITS;
  const { mr, mi } = mixBlock(input.xr, input.xi, ftw, bits);
  let ir: Int32Array = mr, ii: Int32Array = mi, w = W_MIX, gain = 1, i = 1;
  for (; i < c.length && c[i].kind === 'cic'; i++) {
    const k = c[i] as Extract<Block, { kind: 'cic' }>, wo = cicWidth(k.N, k.R, w);
    ir = cicRun(ir, k.N, k.R, wo); ii = cicRun(ii, k.N, k.R, wo); w = wo; gain *= k.R ** k.N;
  }
  let re: Float64Array = Float64Array.from(ir, (v) => v / gain / ADC_SCALE), im: Float64Array = Float64Array.from(ii, (v) => v / gain / ADC_SCALE), rate = rates[i - 1].outRate;
  for (; i < c.length && STAGE[c[i].kind] === 2; i++) {
    const k = c[i];
    const h = k.kind === 'halfband' ? halfBandTaps(k.taps) : k.kind === 'poly' ? polyTapsFor(k.taps, k.R) : Array.from(lowpass((k as { taps: number }).taps, (k as { cutoff: number }).cutoff / rate));
    const R = k.kind === 'halfband' ? 2 : k.kind === 'poly' ? k.R : 1;
    re = firDec(h, re, R); im = firDec(h, im, R); rate = rates[i].outRate;
  }
  const chanRe = re, chanIm = im, chanRate = rate, d = c[i] as Extract<Block, { kind: 'disc' }>;
  let a = d.method === 'phase' ? discPhase(re, im, rate) : discCordic(re, im, rate, d.stages);
  for (i++; i < c.length && c[i].kind !== 'morse'; i++) {
    const k = c[i];
    if (k.kind === 'audio') a = firDec(lowpass(k.taps, k.cutoff / rate), a, k.M);
    else a = deEmph(a, rate);
    rate = rates[i].outRate;
  }
  const m = c[c.length - 1] as Extract<Block, { kind: 'morse' }>;
  const decoded = o.skipDecode ? emptyDecode : decodeMorse(a, rate, m.threshold);
  return { tunedHz: tuned, found, chanRe, chanIm, chanRate, audio: a, audioRate: rate, decoded };
}

// ---- the decoder (given) ----------------------------------------------------------------------------------------------------------------------

export const FRAME_S = 0.005;
/** What the decoder ignores at either end of the audio. Less than the lead and tail the station keeps silent. */
export const EDGE_S = 0.06;
export interface Decoded { text: string; key: Uint8Array; env: Float64Array; threshold: number; frameS: number }
const emptyDecode: Decoded = { text: '', key: new Uint8Array(0), env: new Float64Array(0), threshold: 0, frameS: FRAME_S };

/** The tone the decoder listens for: the frequency from 450 to 950 Hz with the most power over the whole clip, as an operator finds a station's note. */
export function hearTone(x: Float64Array, rate: number): number {
  let best = 0, at = 700;
  for (let f = 450; f <= 950; f += 10) {
    // Goertzel: one multiply a sample for each frequency tried
    const k = 2 * Math.cos((2 * Math.PI * f) / rate);
    let s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { const s0 = x[i] + k * s1 - s2; s2 = s1; s1 = s0; }
    const p = s1 * s1 + s2 * s2 - k * s1 * s2;
    if (p > best) { best = p; at = f; }
  }
  return at;
}
/**
 * What the decoder hears in each 5 ms step: over a 10 ms window, the power at the tone against everything else in the sound, dB. Key down is the tone
 * standing out; key up is the rest. Whatever the chain lets into the sound besides the tone (noise, a neighbour, distortion of the tone itself) lowers it.
 */
export function envelope(x: Float64Array, rate: number, tone = hearTone(x, rate)): Float64Array {
  const L = Math.max(2, Math.round(rate * FRAME_S)), W = 2 * L, n = Math.max(0, Math.floor((x.length - W) / L) + 1), out = new Float64Array(n), w = (2 * Math.PI * tone) / rate;
  const cs = new Float64Array(x.length), sn = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) { cs[i] = Math.cos(w * i); sn[i] = Math.sin(w * i); }
  for (let j = 0; j < n; j++) {
    const o = j * L;
    let m = 0;
    for (let i = 0; i < W; i++) m += x[o + i];
    m /= W;
    let re = 0, im = 0, e = 0;
    for (let i = 0; i < W; i++) { const v = x[o + i] - m; re += v * cs[o + i]; im -= v * sn[o + i]; e += v * v; }
    const tp = (2 * (re * re + im * im)) / W, rest = Math.max(e - tp, 1e-3 * e, 1e-30);
    out[j] = 10 * Math.log10(Math.max(tp, 1e-30) / rest);
  }
  return out;
}
/** Otsu's split of the frame levels: the threshold that best separates key down from key up. */
export function otsu(v: Float64Array): number {
  const s = Array.from(v).filter(Number.isFinite).sort((a, b) => a - b);
  if (s.length < 4) return 0;
  const lo = s[Math.floor(s.length * 0.01)], hi = s[Math.floor(s.length * 0.99)], bins = 128, hist = new Array<number>(bins).fill(0);
  for (const x of s) hist[Math.max(0, Math.min(bins - 1, Math.floor(((x - lo) / (hi - lo || 1)) * bins)))]++;
  let total = 0;
  hist.forEach((c, i) => (total += c * i));
  let wB = 0, sumB = 0, best = 0, at = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB || wB === s.length) continue;
    sumB += i * hist[i];
    const wF = s.length - wB, mB = sumB / wB, mF = (total - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; at = i; }
  }
  return lo + ((at + 1) / bins) * (hi - lo);
}

/** Frames of key down (1) and up (0), runs shorter than a third of a unit taken back (a click is not a mark), then marks and gaps read as a stated speed. */
export function decodeMorse(audio: Float64Array, rate: number, threshold: 'auto' | number): Decoded {
  const env = envelope(audio, rate), quiet = [...env].sort((a, b) => a - b)[Math.floor(env.length * 0.1)] ?? 0;
  const thr = threshold === 'auto' ? otsu(env) : quiet + threshold, key = Uint8Array.from(env, (v) => (v > thr ? 1 : 0)), edge = Math.round(EDGE_S / FRAME_S);
  // the filters are still filling at the start, and stop short at the end: nothing there is a mark
  key.fill(0, 0, edge); key.fill(0, Math.max(0, key.length - edge));
  const unit = UNIT_S / FRAME_S, minRun = Math.max(1, Math.round(unit / 3));
  // take back short runs, shortest first, until none is left
  for (let pass = 0; pass < 4; pass++) {
    let i = 0;
    while (i < key.length) {
      let j = i;
      while (j < key.length && key[j] === key[i]) j++;
      if (j - i < minRun && i > 0 && j < key.length) key.fill(1 - key[i], i, j);
      i = j;
    }
  }
  let text = '', sym = '', i = 0;
  while (i < key.length && key[i] === 0) i++;
  while (i < key.length) {
    let j = i;
    while (j < key.length && key[j] === key[i]) j++;
    const len = (j - i) / unit;
    if (key[i] === 1) sym += len < 2 ? '.' : '-';
    else if (j < key.length && len >= 2) { text += FROM_MORSE.get(sym) ?? '?'; sym = ''; if (len >= 5) text += ' '; }
    i = j;
  }
  if (sym) text += FROM_MORSE.get(sym) ?? '?';
  return { text: text.trim(), key, env, threshold: thr, frameS: FRAME_S };
}

/** Where the decoder's key went wrong against what was sent: each unit (a mark or a gap) read the other way over most of its middle. Times from the start of the band. */
export interface Slip { t: number; sent: 'down' | 'up'; char: number }
export function slips(b: TuneBand, d: Decoded): { lag: number; slips: Slip[] } {
  const per = UNIT_S / d.frameS, lead = LEAD_S / d.frameS, truth = (f: number) => { const u = Math.floor((f - lead) / per); return u >= 0 && u < b.keying.length && b.keying[u] === '1' ? 1 : 0; };
  let lag = 0, best = -1;
  for (let L = 0; L < 80; L++) {
    let agree = 0;
    for (let f = 0; f + L < d.key.length; f++) agree += truth(f) === d.key[f + L] ? 1 : 0;
    if (agree > best) { best = agree; lag = L; }
  }
  const own = unitOwners(b.message), out: Slip[] = [];
  for (let u = 0; u < b.keying.length; u++) {
    const a = Math.round(lead + u * per + per * 0.2) + lag, z = Math.round(lead + (u + 1) * per - per * 0.2) + lag;
    let wrong = 0;
    for (let f = a; f < z; f++) if ((d.key[f] ?? 0) !== (b.keying[u] === '1' ? 1 : 0)) wrong++;
    if (wrong > (z - a) / 2 && (out.length === 0 || out[out.length - 1].t < LEAD_S + (u - 1) * UNIT_S)) {
      let ch = own[u];
      if (ch < 0) { let k = u; while (k >= 0 && own[k] < 0) k--; ch = k >= 0 ? own[k] : 0; }
      out.push({ t: LEAD_S + u * UNIT_S, sent: b.keying[u] === '1' ? 'down' : 'up', char: ch });
    }
  }
  return { lag: lag * d.frameS, slips: out };
}

// ---- what it costs --------------------------------------------------------------------------------------------------------------------------

export interface Cost {
  /** NANDs of the gates: the mixer and the CICs (I and Q each). */
  nands: number;
  /** Real multiplies a second in the floating-point part (a complex sample through a real filter is two). */
  mults: number;
  /** Discriminator angles a second, and CORDIC stage operations a second. */
  angles: number;
}
/** NAND counts of the gate blocks at the learner's sizes, from the gates themselves (lib/sdr.ts, lib/multirate.ts): passed in, so this file stays free of the circuit library. */
export interface GatePrices { mixer(bits: number): number; cic(N: number, R: number, wIn: number): number }
export function chainCost(c: Chain, prices: GatePrices): Cost {
  const { rates } = checkChain(c);
  let nands = 0, mults = 0, angles = 0, w = W_MIX;
  c.forEach((b, i) => {
    const { inRate, outRate } = rates[i];
    if (b.kind === 'mixer') nands += prices.mixer(b.bits);
    else if (b.kind === 'cic') { nands += 2 * prices.cic(b.N, b.R, w); w = cicWidth(b.N, b.R, w); }
    else if (b.kind === 'halfband') mults += 2 * halfBandTaps(b.taps).filter((v) => v !== 0).length * outRate;
    else if (b.kind === 'poly' || b.kind === 'channel') mults += 2 * b.taps * outRate;
    else if (b.kind === 'audio') mults += b.taps * outRate;
    else if (b.kind === 'deemph') mults += 2 * inRate;
    else if (b.kind === 'disc') { mults += 4 * inRate; angles += b.method === 'phase' ? inRate : b.stages * inRate; }
  });
  return { nands, mults, angles };
}

// ---- a band graded, and why it failed ----------------------------------------------------------------------------------------------------------

export type Cause =
  | { kind: 'tune-fixed'; hz: number }
  | { kind: 'tune-none'; marginDb: number }
  | { kind: 'tune-wrong'; hz: number; offKhz: number }
  | { kind: 'tone-cut'; lossDb: number }
  | { kind: 'too-narrow'; lossDb: number }
  | { kind: 'disc-rate'; rate: number }
  | { kind: 'cordic'; stages: number }
  | { kind: 'interference'; ciDb: number; worst: Contribution; together: boolean }
  | { kind: 'noise'; cnDb: number }
  | { kind: 'decoder' };

export interface BandResult { band: TuneBand; run: Run; ok: boolean; cause?: Cause; measures?: Measures; slips?: Slip[] }
export interface Measures { ciDb: number; cnDb: number; keyRatioDb: number; contributions: Contribution[] }
/** One other station in the channel: its power against the wanted station's, dB; where it folded in, if it did; how much of it is the mixer's spurs (its power over an ideal oscillator's, dB); and whether it alone, beside the wanted station, breaks the message. */
export interface Contribution { station: number; offKhz: number; db: number; foldedTo: number | null; block: string | null; spurDb: number; breaks: boolean }

/** Mean power of a complex signal after its first 5 ms. */
function power(re: Float64Array, im: Float64Array, rate: number): number {
  const s = Math.ceil(rate * 0.005);
  let p = 0;
  for (let i = s; i < re.length; i++) p += re[i] ** 2 + im[i] ** 2;
  return p / Math.max(1, re.length - s);
}
const db = (x: number) => 10 * Math.log10(Math.max(x, 1e-30));

/** Where an offset lands after each decimation in the chain, and the first block at which it folded, if any. */
export function foldPath(c: Chain, offHz: number): { foldedTo: number | null; block: string | null } {
  const { rates } = checkChain(c);
  let f = offHz, block: string | null = null;
  for (let i = 1; i < c.length && STAGE[c[i].kind] <= 2; i++) {
    const out = rates[i].outRate;
    if (out < rates[i].inRate && Math.abs(f) > out / 2) { f = ((((f + out / 2) % out) + out) % out) - out / 2; block ??= BLOCK_NAME[c[i].kind]; }
  }
  return { foldedTo: block ? f : null, block };
}

/** Key-down power against key-up power in the decoder's envelope, from what was sent, dB. */
export function keyRatio(b: TuneBand, d: Decoded, lagS: number): number {
  const per = UNIT_S / d.frameS, lead = LEAD_S / d.frameS, lag = Math.round(lagS / d.frameS);
  let on = 0, off = 0, non = 0, noff = 0;
  for (let u = 1; u < b.keying.length - 1; u++) {
    if (b.keying[u] !== b.keying[u - 1] || b.keying[u] !== b.keying[u + 1]) continue;
    for (let f = Math.round(lead + u * per) + lag; f < Math.round(lead + (u + 1) * per) + lag; f++) {
      const p = 10 ** ((d.env[f] ?? -200) / 10);
      if (b.keying[u] === '1') { on += p; non++; } else { off += p; noff++; }
    }
  }
  return db(on / Math.max(1, non)) - db(off / Math.max(1, noff));
}


/** Grade one band, and if it failed, measure why. */
export function gradeBand(c: Chain, b: TuneBand): BandResult {
  const input = sampleBand(b), run = runChain(c, b, { input }), ok = run.decoded.text === b.message;
  if (ok) return { band: b, run, ok };
  const weak = b.stations[b.weak], mx = c[0] as Extract<Block, { kind: 'mixer' }>, { slips: sl, lag } = slips(b, run.decoded);
  const fail = (cause: Cause, measures?: Measures): BandResult => ({ band: b, run, ok, cause, measures, slips: sl });
  if (run.tunedHz === null) return fail({ kind: 'tune-none', marginDb: mx.tune.mode === 'find' ? mx.tune.marginDb : 0 });
  const offKhz = (run.tunedHz - weak.f) / 1000;
  if (Math.abs(offKhz) > 3) return fail(mx.tune.mode === 'fixed' ? { kind: 'tune-fixed', hz: run.tunedHz } : { kind: 'tune-wrong', hz: run.tunedHz, offKhz });
  // the chain on the wanted station alone, with no noise: does the chain itself spoil it?
  const alone = runChain(c, b, { part: { stations: [b.weak], noise: false }, tuneHz: run.tunedHz! });
  // the learner's complex filters at the station's peak deviation: more than 6 dB down there, they cut the station's own swing
  const narrow = -chanGainDb(c, DEV);
  const audioBlocks = c.filter((k): k is Extract<Block, { kind: 'audio' }> => k.kind === 'audio');
  const toneLoss = -audioBlocks.reduce((s, k) => s + db(gainAt(lowpass(k.taps, k.cutoff / rateOf(c, k)), b.toneHz, rateOf(c, k)) ** 2), 0);
  if (alone.decoded.text !== b.message) {
    if (toneLoss > 6) return fail({ kind: 'tone-cut', lossDb: toneLoss });
    const d = c.find((k) => k.kind === 'disc') as Extract<Block, { kind: 'disc' }>;
    if (alone.chanRate < 2 * (DEV + b.toneHz)) return fail({ kind: 'disc-rate', rate: alone.chanRate });
    if (narrow > 6) return fail({ kind: 'too-narrow', lossDb: narrow });
    if (d.method === 'cordic') return fail({ kind: 'cordic', stages: d.stages });
    return fail({ kind: 'decoder' });
  }
  // a chain whose filters cut the station's own swing is named for it even where the station alone gets through: what tips it over is then the rest
  if (narrow > 6) return fail({ kind: 'too-narrow', lossDb: narrow });
  // the parts: wanted, each other station, the noise
  const pw = power(alone.chanRe, alone.chanIm, alone.chanRate);
  const contributions = b.stations.map((st, k) => {
    if (k === b.weak) return null;
    const r = runChain(c, b, { part: { stations: [k], noise: false }, tuneHz: run.tunedHz!, skipDecode: true }), p = power(r.chanRe, r.chanIm, r.chanRate);
    const ideal = runChain(c, b, { part: { stations: [k], noise: false }, tuneHz: run.tunedHz!, bitsOver: 10, skipDecode: true }), pi = power(ideal.chanRe, ideal.chanIm, ideal.chanRate);
    return { station: k, offKhz: (st.f - run.tunedHz!) / 1000, db: db(p) - db(pw), ...foldPath(c, st.f - run.tunedHz!), spurDb: db(p) - db(pi), breaks: false };
  }).filter((x): x is NonNullable<typeof x> => x !== null);
  const nz = runChain(c, b, { part: { stations: [], noise: true }, tuneHz: run.tunedHz!, skipDecode: true });
  const ci = -db(contributions.reduce((s, x) => s + 10 ** (x.db / 10), 0)), cn = db(pw) - db(power(nz.chanRe, nz.chanIm, nz.chanRate));
  const measures: Measures = { ciDb: ci, cnDb: cn, keyRatioDb: keyRatio(b, run.decoded, lag), contributions };
  // which part, added to the wanted station on its own, breaks the message: measured by decoding each pair, never judged from a threshold
  const breaks = (part: Part) => runChain(c, b, { part, tuneHz: run.tunedHz! }).decoded.text !== b.message;
  const noiseBreaks = breaks({ stations: [b.weak], noise: true });
  for (const x of contributions) x.breaks = breaks({ stations: [b.weak, x.station], noise: false });
  const byPower = [...contributions].sort((x, y) => y.db - x.db), culprit = byPower.find((x) => x.breaks);
  if (noiseBreaks && (!culprit || -culprit.db > cn)) return fail({ kind: 'noise', cnDb: cn }, measures);
  return fail({ kind: 'interference', ciDb: ci, worst: culprit ?? byPower[0], together: !culprit && !noiseBreaks }, measures);
}
function gainAt(h: ArrayLike<number>, f: number, fs: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < h.length; i++) { const w = (-2 * Math.PI * f * i) / fs; re += h[i] * Math.cos(w); im += h[i] * Math.sin(w); }
  return Math.hypot(re, im);
}
/** The gain of a chain's complex filters (half-band, polyphase, channel; the CICs too) at an offset from the tuned frequency, dB. */
export function chanGainDb(c: Chain, f: number): number {
  const { rates } = checkChain(c);
  let g = 0;
  c.forEach((k, i) => {
    const fs = rates[i].inRate;
    if (k.kind === 'cic') g += 20 * Math.log10(Math.max(1e-12, cicGain(k.N, k.R, f / fs)));
    else if (k.kind === 'halfband') g += 20 * Math.log10(Math.max(1e-12, gainAt(halfBandTaps(k.taps), f, fs)));
    else if (k.kind === 'poly') g += 20 * Math.log10(Math.max(1e-12, gainAt(polyTapsFor(k.taps, k.R), f, fs)));
    else if (k.kind === 'channel') g += 20 * Math.log10(Math.max(1e-12, gainAt(lowpass(k.taps, k.cutoff / fs), f, fs)));
  });
  return g;
}
const cicGain = (N: number, R: number, f: number) => { const s = Math.sin(Math.PI * f); return Math.abs(s) < 1e-12 ? 1 : Math.abs(Math.sin(Math.PI * R * f) / (R * s)) ** N; };
function rateOf(c: Chain, b: Block): number { return checkChain(c).rates[c.indexOf(b)].inRate; }

/** What would help, by block. Never a number, never a setting: those are the learner's to find. */
export function hintsFor(cause: Cause, c: Chain): string[] {
  const has = (k: Kind) => c.some((b) => b.kind === k);
  switch (cause.kind) {
    case 'tune-fixed': return ['the mixer: a fixed tune only fits a band whose station you know', 'the mixer can look for the station itself'];
    case 'tune-none': return ['the mixer: how far a line must stand above its surroundings to count as a station', 'look at how far the practice station stands above its surroundings'];
    case 'tune-wrong': return ['the mixer: what it accepts as a station, so a ripple of the noise does not count', 'the weakest real station stands well clear of the noise'];
    case 'tone-cut': return ['the audio filter: its cutoff must keep the tone the station keys', 'the brief says how high the tone can be'];
    case 'too-narrow': return ['the channel filter: FM needs room for its deviation and its tone, Carson\'s band', 'a wider channel filter, or a gentler edge'];
    case 'disc-rate': return ['the discriminator needs a rate well above the deviation: decimate less before it, and the rest after it'];
    case 'cordic': return ['the discriminator: more CORDIC stages, or the phase difference'];
    case 'interference': {
      const w = cause.worst, out: string[] = [];
      if (w.spurDb > 6) out.push('the mixer: a finer oscillator table, whose spurs fall lower');
      if (w.block === 'CIC ÷ R') out.push('a higher CIC order, which folds less into the channel', 'a smaller CIC ratio, with the rest of the decimation done by a filter', has('halfband') ? 'a half-band with more taps' : 'a half-band ÷ 2 before the rest of the decimation');
      else if (w.block) out.push(`the ${w.block.toLowerCase()}: more taps, so less folds in`);
      else out.push('a narrower channel filter', 'more taps in the channel filter, for a steeper edge');
      return out;
    }
    case 'noise': return ['a narrower channel filter lets in less noise (but not narrower than the station)', has('deemph') ? 'the audio filter: keep less of the noise above the tone' : 'de-emphasis, and an audio filter that keeps less above the tone'];
    case 'decoder': return ['the decoder\'s threshold'];
  }
}

/** The book's own answer, the score's yardstick: a fifth-order CIC, a steep channel filter, de-emphasis and an audio filter. Never shown before a pass. */
export const REFERENCE_CHAIN: Chain = [
  { kind: 'mixer', tune: { mode: 'find', marginDb: 15 }, bits: 8 },
  { kind: 'cic', N: 5, R: 4 },
  { kind: 'channel', taps: 161, cutoff: 55_000 },
  { kind: 'disc', method: 'phase', stages: 12 },
  { kind: 'deemph' },
  { kind: 'audio', taps: 121, cutoff: 1_500, M: 10 },
  { kind: 'morse', threshold: 'auto' },
];

/** Whether a chain decodes a band's message (no diagnosis: the quick check). */
export const decodes = (c: Chain, b: TuneBand): boolean => runChain(c, b).decoded.text === b.message;
