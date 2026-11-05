// Filters that learn (DOM-free): the Wiener solution, LMS and NLMS, an echo canceller and an equalizer on labelled models, and the exact integer LMS that lib/lms.ts is compared with every clock.
// The chapter's far end is a recording (dsp/echofigs.ts); farEnd here is a generated stand-in the tests also use. Everything is seeded.

import { gaussian, rng } from '../phys/line';
import { wrapTo } from './fixed';

/** r[0 … n−1] from x with itself, p from x with d: the two things the best filter depends on. Averages over the block. */
export function correlate(x: readonly number[], d: readonly number[], n: number): { r: number[]; p: number[] } {
  const r = new Array<number>(n).fill(0), p = new Array<number>(n).fill(0), N = x.length;
  for (let k = 0; k < n; k++) for (let i = k; i < N; i++) { r[k] += x[i] * x[i - k]; p[k] += d[i] * x[i - k]; }
  return { r: r.map((v) => v / N), p: p.map((v) => v / N) };
}

/** Solve the symmetric Toeplitz system R w = p by Levinson's recursion: n² work where a general solver takes n³. */
export function levinson(r: readonly number[], p: readonly number[]): number[] {
  const n = r.length;
  let w = [p[0] / r[0]], a = [1], e = r[0];
  for (let m = 1; m < n; m++) {
    let k = 0;
    for (let i = 0; i < m; i++) k += a[i] * r[m - i];
    const refl = -k / e, next = new Array<number>(m + 1).fill(0);
    for (let i = 0; i <= m; i++) next[i] = (a[i] ?? 0) + refl * (a[m - i] ?? 0);
    a = next;
    e *= 1 - refl * refl;
    let c = p[m];
    for (let i = 0; i < m; i++) c -= w[i] * r[m - i];
    const q = c / e;
    w = [...w, 0].map((v, i) => v + q * a[m - i]);
  }
  return w;
}

/** LMS, or normalized LMS: a step down the error's slope at every sample, from the sample's own squared error. */
export class Lms {
  w: number[];
  x: number[];
  constructor(public n: number, public mu: number, public normalized = false, public eps = 1e-6) {
    this.w = new Array<number>(n).fill(0);
    this.x = new Array<number>(n).fill(0);
  }
  /** The filter's output for a new input, before it learns. */
  step(v: number, d: number, learn = true): { y: number; e: number } {
    this.x.pop(); this.x.unshift(v);
    let y = 0, en = 0;
    for (let k = 0; k < this.n; k++) { y += this.w[k] * this.x[k]; en += this.x[k] * this.x[k]; }
    const e = d - y;
    if (learn) { const g = this.normalized ? this.mu / (this.eps + en) : this.mu; for (let k = 0; k < this.n; k++) this.w[k] += g * e * this.x[k]; }
    return { y, e };
  }
}

/** The most energy the filter's n samples ever hold. Plain LMS shrinks its error at every step only while μ is below 2 / this: the loudest stretch sets the limit, not the average. */
export function peakEnergy(x: readonly number[], n: number): number {
  let win = 0, top = 0;
  x.forEach((v, i) => { win += v * v; if (i >= n) win -= x[i - n] * x[i - n]; top = Math.max(top, win); });
  return top;
}

/** Echo return loss enhancement: how far the canceller brought the echo down, in dB, over a stretch. */
export function erleDb(d: readonly number[], e: readonly number[], from = 0, to = d.length): number {
  let a = 0, b = 0;
  for (let i = from; i < to; i++) { a += d[i] * d[i]; b += e[i] * e[i]; }
  return 10 * Math.log10(a / Math.max(b, 1e-30));
}

export const ECHO_RATE = 8000;
/** A room or a hybrid: a delay, then seeded reflections dying away. A model, and not any measured path. */
export function echoPath(seed: number, taps = 128): number[] {
  const u = rng(seed), h = new Array<number>(taps).fill(0), start = 8 + Math.floor(u() * 12);
  for (let i = start; i < taps; i++) if (u() < 0.25) h[i] = 0.5 * gaussian(u) * Math.exp(-(i - start) / 28);
  return h;
}
/** Generated speech-like sound, not speech: bursts of a falling pitch through two resonances, with pauses. Enough to be highly coloured and start and stop as a voice does. */
export function farEnd(n: number, seed: number): number[] {
  const u = rng(seed), out = new Array<number>(n).fill(0);
  let t = 0;
  while (t < n) {
    const len = Math.floor(0.12 * ECHO_RATE + u() * 0.3 * ECHO_RATE), gap = Math.floor(0.03 * ECHO_RATE + u() * 0.15 * ECHO_RATE);
    const pitch = 100 + u() * 90, f1 = 300 + u() * 500, f2 = 900 + u() * 1400;
    let y1 = 0, y2 = 0, z1 = 0, z2 = 0, nextPulse = 0;
    const res = (f: number, r: number) => [2 * r * Math.cos((2 * Math.PI * f) / ECHO_RATE), -r * r];
    const [a1, a2] = res(f1, 0.97), [b1, b2] = res(f2, 0.95);
    for (let i = 0; i < len && t + i < n; i++) {
      const env = Math.sin((Math.PI * i) / len), period = ECHO_RATE / (pitch * (1 - (0.25 * i) / len));
      let src = 0.02 * gaussian(u);
      if (i >= nextPulse) { src += 1; nextPulse = i + period; }
      const v1 = a1 * y1 + a2 * y2 + src; y2 = y1; y1 = v1;
      const v2 = b1 * z1 + b2 * z2 + src; z2 = z1; z1 = v2;
      out[t + i] = env * (v1 + 0.5 * v2);
    }
    t += len + gap;
  }
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
  return out.map((v) => (0.8 * v) / peak);
}

export interface EchoRun { d: number[]; e: number[]; w: number[]; erle: number; misalign: number[] }
/** A far-end signal through a hidden path, a canceller learning the path, and optionally near-end talk or noise on top. erle is over the last quarter, against the echo alone. */
export function runEcho(o: { n: number; seed: number; taps: number; mu: number; normalized: boolean; noise?: number; talkFrom?: number; talkTo?: number; freeze?: boolean; x?: readonly number[]; near?: readonly number[] }): EchoRun {
  const x = o.x ?? farEnd(o.n, o.seed), h = echoPath(o.seed + 7), u = rng(o.seed + 11), near = o.near ?? farEnd(o.n, o.seed + 99);
  const f = new Lms(o.taps, o.mu, o.normalized), hist = new Array<number>(h.length).fill(0);
  const d: number[] = [], e: number[] = [], clean: number[] = [], residual: number[] = [], misalign: number[] = [];
  const pathEnergy = h.reduce((a, b) => a + b * b, 0);
  for (let i = 0; i < o.n; i++) {
    hist.pop(); hist.unshift(x[i]);
    let echo = 0;
    for (let k = 0; k < h.length; k++) echo += h[k] * hist[k];
    const talking = o.talkFrom !== undefined && i >= o.talkFrom && i < (o.talkTo ?? o.n);
    const mic = echo + (o.noise ? o.noise * gaussian(u) : 0) + (talking ? 0.5 * near[i] : 0);
    const r = f.step(x[i], mic, !(o.freeze && talking));
    d.push(mic); e.push(r.e); clean.push(echo); residual.push(echo - r.y);
    if (i % 64 === 0) { let m = 0; for (let k = 0; k < h.length; k++) m += ((h[k] ?? 0) - (f.w[k] ?? 0)) ** 2; misalign.push(10 * Math.log10(m / pathEnergy)); }
  }
  return { d, e, w: f.w, erle: erleDb(clean, residual, Math.floor(0.75 * o.n)), misalign };
}

/** An equalizer: BPSK through a smeared channel, a known training stretch, and then decisions it makes for itself. Returns the output and the worst gap between + and − after training. */
export function runEqualizer(o: { channel: readonly number[]; taps: number; delay: number; mu: number; n: number; seed: number; noise?: number; train: number }): { y: number[]; mse: number[]; opening: number; openingBefore: number; wrongAfter: number } {
  const u = rng(o.seed), syms = Array.from({ length: o.n }, () => (u() < 0.5 ? 1 : -1)), f = new Lms(o.taps, o.mu), hist = new Array<number>(o.channel.length).fill(0);
  // the raw line's own best sampling instant: the channel's largest tap
  const cursor = o.channel.reduce((m, v, i, c) => (Math.abs(v) > Math.abs(c[m]) ? i : m), 0);
  const y: number[] = [], mse: number[] = [];
  let run = 0, top = 1e9, bot = -1e9, rawTop = 1e9, rawBot = -1e9, wrong = 0;
  for (let i = 0; i < o.n; i++) {
    hist.pop(); hist.unshift(syms[i]);
    let v = o.noise ? o.noise * gaussian(u) : 0;
    for (let k = 0; k < o.channel.length; k++) v += o.channel[k] * hist[k];
    const want = syms[i - o.delay] ?? 0, trained = i < o.train;
    // after training it learns from its own decisions
    f.x.pop(); f.x.unshift(v);
    let out = 0, en = 0;
    for (let k = 0; k < o.taps; k++) { out += f.w[k] * f.x[k]; en += f.x[k] * f.x[k]; }
    const target = trained ? want : out >= 0 ? 1 : -1, e = target - out;
    for (let k = 0; k < o.taps; k++) f.w[k] += (o.mu / (1e-6 + en)) * e * f.x[k];
    y.push(out);
    run = 0.99 * run + 0.01 * (want - out) * (want - out);
    if (i % 16 === 0) mse.push(10 * Math.log10(Math.max(run, 1e-9)));
    if (i >= o.train && i >= o.delay) {
      if ((out >= 0 ? 1 : -1) !== want) wrong++;
      if (want > 0) top = Math.min(top, out); else bot = Math.max(bot, out);
      if ((syms[i - cursor] ?? 0) > 0) rawTop = Math.min(rawTop, v); else rawBot = Math.max(rawBot, v);
    }
  }
  return { y, mse, opening: top - bot, openingBefore: rawTop - rawBot, wrongAfter: wrong };
}

// ---- the integer filter the gates hold -----------------------------------------------------------------------------------------------------

export interface LmsSpec {
  /** Taps. */
  n: number;
  /** Bits of the input and of d, as they arrive. */
  wx: number;
  /** Bits of every coefficient, and of y and e. */
  w: number;
  /** Fraction bits of a coefficient. */
  f: number;
  /** How far e · x is moved down before it joins a coefficient. A larger shift is a smaller step. */
  s: number;
}

/**
 * The gates' behaviour. Every word wraps at w bits. The products keep all their bits, are summed, and that sum is rounded half up once; each update is rounded half up too, with the bit below the cut as a carry-in.
 * y = (Σ c[k] x[k] + 2^(f−1)) ≫ f, e = d − y, and at each edge c[k] += (e x[k] + 2^(s−1)) ≫ s, then the new sample shifts in. That rounding is a dead zone: while e x stays within ±2^(s−1), c does not move.
 */
export class LmsFixed {
  c: number[];
  x: number[];
  constructor(public o: LmsSpec) {
    this.c = new Array<number>(o.n).fill(0);
    this.x = new Array<number>(o.n).fill(0);
  }
  get y(): number { let s = 2 ** (this.o.f - 1); for (let k = 0; k < this.o.n; k++) s += this.c[k] * this.x[k]; return wrapTo(Math.floor(s / 2 ** this.o.f), this.o.w); }
  e(d: number): number { return wrapTo(d - this.y, this.o.w); }
  edge(x: number, d: number): void {
    const e = this.e(d);
    this.c = this.c.map((c, k) => wrapTo(c + Math.floor((e * this.x[k] + 2 ** (this.o.s - 1)) / 2 ** this.o.s), this.o.w));
    this.x = [x, ...this.x.slice(0, this.o.n - 1)];
  }
}
