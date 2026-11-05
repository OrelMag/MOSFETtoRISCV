// The FFT in integers (DOM-free): the golden model of lib/fft.ts, bit for bit. comm/fourier.ts has the FFT in floats; hardware has words.
//
// The rules the gates follow:
// - A sample is two's complement, W bits, read as v / 2^(W-1): [-1, 1). A complex sample packs as { im, re }, 2W bits, re in the low half.
// - Every stage halves. A butterfly's two adders both have their carry-in tied to 1 and drop their lowest bit:
//     add(x, y) = (x + y + 1) >> 1 and sub(x, y) = (x + ~y + 1) >> 1 = (x - y) >> 1,
//   so on an odd total the sum rounds up, the difference down, and the two together lose nothing (sum + difference = x exactly).
// - So an N-point transform gives X[k] / N. The adders cannot overflow; only a twiddle's product can, by rounding near full scale, and it wraps (nothing saturates):
//   a block whose |x| stays at or below safeMagnitude never gets there (tests/comm-fft.test.ts tries the worst blocks).
// - Twiddles W^k = e^(-j2πk/N), k < N / 2, by kind:
//     k = 0: wires. k = N / 4: -j, wires (the adders swap the parts). k = N / 8 and 3N / 8: 1/√2 by shift-and-add on (re + im) and (im - re),
//     then wires for 3N / 8. Any other k: a general complex multiplier with W-bit factors (+1 is out of range, the table clamps to 2^(W-1) - 1).
// - A product keeps all its bits, then the first dropped bit is added back: round half up, once per real output, never per product.

import { fft } from './fourier';

export interface Fx { re: number; im: number }

/** The value of the low W bits, signed. */
export const wrap = (x: number, W: number): number => {
  const M = 2 ** W, v = ((x % M) + M) % M;
  return v >= M / 2 ? v - M : v;
};
export const packFx = (x: Fx, W: number): number => (((x.im % 2 ** W) + 2 ** W) % 2 ** W) * 2 ** W + ((x.re % 2 ** W) + 2 ** W) % 2 ** W;
export const unpackFx = (v: number, W: number): Fx => ({ re: wrap(v % 2 ** W, W), im: wrap(Math.floor(v / 2 ** W), W) });

const shr = (x: number, n: number): number => Math.floor(x / 2 ** n);
export const addH = (x: number, y: number, W: number): number => wrap(shr(x + y + 1, 1), W);
export const subH = (x: number, y: number, W: number): number => wrap(shr(x - y, 1), W);

/** Clamped to the W-bit range: only cos ≈ 1 can round to +1. */
const q = (v: number, W: number): number => Math.min(2 ** (W - 1) - 1, Math.round(v * 2 ** (W - 1)));

/** W^k_N in W-bit integers. */
export const twiddle = (k: number, N: number, W: number): Fx => ({ re: q(Math.cos((2 * Math.PI * k) / N), W), im: q(-Math.sin((2 * Math.PI * k) / N), W) });

/** 1/√2 in W bits. */
export const rootHalf = (W: number): number => Math.round(2 ** (W - 1) * Math.SQRT1_2);

/** x · C rounded, for a W + 1-bit x (1/√2's multiplier): all bits kept, the first dropped one added back. */
export const mulRoot = (x: number, W: number): number => wrap(shr(x * rootHalf(W) + 2 ** (W - 2), W - 1), W);

/** The general complex multiplier: b · w, rounded once per output. */
export function cmulFx(b: Fx, w: Fx, W: number): Fx {
  const R = 2 ** (W - 2);
  return { re: wrap(shr(b.re * w.re - b.im * w.im + R, W - 1), W), im: wrap(shr(b.re * w.im + b.im * w.re + R, W - 1), W) };
}

export type TwKind = 'one' | 'minusj' | 'root1' | 'root3' | 'general';
export function twKind(k: number, N: number): TwKind {
  if (k === 0) return 'one';
  if (4 * k === N) return 'minusj';
  if (8 * k === N) return 'root1';
  if (8 * k === 3 * N) return 'root3';
  return 'general';
}

/** b · (1 - j) / √2 by the adders and one constant multiplier a part. */
export const rot45 = (b: Fx, W: number): Fx => ({ re: mulRoot(b.re + b.im, W), im: mulRoot(b.im - b.re, W) });

/** One butterfly of a decimation-in-time FFT: y0 = (a + W^k b) / 2, y1 = (a - W^k b) / 2. */
export function butterflyFx(a: Fx, b: Fx, k: number, N: number, W: number): [Fx, Fx] {
  const kind = twKind(k, N);
  // -j and 3N/8 multiply by -j at the adders: a + (-j) t has re = a.re + t.im, im = a.im - t.re
  const t = kind === 'one' || kind === 'minusj' ? b : kind === 'general' ? cmulFx(b, twiddle(k, N, W), W) : rot45(b, W);
  if (kind === 'minusj' || kind === 'root3') return [{ re: addH(a.re, t.im, W), im: subH(a.im, t.re, W) }, { re: subH(a.re, t.im, W), im: addH(a.im, t.re, W) }];
  return [{ re: addH(a.re, t.re, W), im: addH(a.im, t.im, W) }, { re: subH(a.re, t.re, W), im: subH(a.im, t.im, W) }];
}

/** Bit reversal of `i` over `bits` bits: the wiring in front of a decimation-in-time FFT. */
export const bitRev = (i: number, bits: number): number => { let j = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) j |= 1 << (bits - 1 - b); return j; };

/** The stages of the flow graph, stage s has 2^s twiddles: which indices meet, with which k. */
export function flowGraph(N: number): { a: number; b: number; k: number }[][] {
  const out: { a: number; b: number; k: number }[][] = [];
  for (let size = 2; size <= N; size *= 2) {
    const st: { a: number; b: number; k: number }[] = [];
    for (let s = 0; s < N; s += size) for (let j = 0; j < size / 2; j++) st.push({ a: s + j, b: s + j + size / 2, k: (j * N) / size });
    out.push(st);
  }
  return out;
}

/** The whole transform in natural order, X[k] / N; `trace` gets each stage's values. */
export function fftFx(x: readonly Fx[], W: number, trace?: Fx[][]): Fx[] {
  const N = x.length, bits = Math.log2(N);
  let v = x.map((_, i) => x[bitRev(i, bits)]);
  trace?.push(v);
  for (const st of flowGraph(N)) {
    const nx = v.slice();
    for (const { a, b, k } of st) { const [y0, y1] = butterflyFx(v[a], v[b], k, N, W); nx[a] = y0; nx[b] = y1; }
    v = nx;
    trace?.push(v);
  }
  return v;
}

/** The largest |x| a block may have: every stage's rounding can add about a unit to a magnitude, and halving keeps the rest below its inputs'. */
export const safeMagnitude = (W: number, N: number): number => 1 - (2 * Math.log2(N) + 2) / 2 ** (W - 1);

/** The inverse by the same hardware: swap the parts going in and coming out. (1 / N) Σ X e^(+j2πkn/N): the inverse transform exactly as defined. */
export const ifftFx = (X: readonly Fx[], W: number): Fx[] => fftFx(X.map((c) => ({ re: c.im, im: c.re })), W).map((c) => ({ re: c.im, im: c.re }));

/** Multiplications that are real work in one transform of N, by the kinds above: what `fftMults` overstates. */
export function twiddleCount(N: number): Record<TwKind, number> {
  const n: Record<TwKind, number> = { one: 0, minusj: 0, root1: 0, root3: 0, general: 0 };
  for (const st of flowGraph(N)) for (const { k } of st) n[twKind(k, N)]++;
  return n;
}

// ---- the streaming FFT: one complex sample a clock -----------------------------------------------------------------------------
//
// A single-path delay-feedback pipeline, decimation in frequency, log₂ N stages. Stage s has a delay line of L = N / 2^(s + 1) samples, a counter and a register at its output.
// While the counter's top bit is 0 the input goes into the line and what comes out of the line (the last block's differences) leaves through the twiddle;
// while it is 1 the butterfly runs: (oldest + input) / 2 leaves, (oldest - input) / 2 goes into the line. The twiddle is W^(j 2^s), j the counter's low bits, and only on the
// differences: k = 0 passes, k = N / 4 is (im, -re), any other k the general multiplier (-j through the multiplier gives the same word, so the model need not say which).
// A stage's counter starts at minus the samples ahead of it, so its first sample meets count 0. The tones leave in bit-reversed order, the first N - 1 + log₂ N edges after the block's first sample.

/** A stage's twiddle on one sample, with `k` the table's index. */
export const twiddleFx = (x: Fx, k: number, N: number, W: number): Fx =>
  k === 0 ? x : 4 * k === N ? { re: x.im, im: wrap(-x.re, W) } : cmulFx(x, twiddle(k, N, W), W);

/** Samples ahead of stage s: the delays and output registers before it. */
export function streamLag(N: number, s: number): number {
  let t = 0;
  for (let i = 0; i < s; i++) t += N / 2 ** (i + 1) + 1;
  return t;
}
export const streamLatency = (N: number): number => streamLag(N, Math.log2(N));

export interface StreamStage { count: number; line: Fx[]; out: Fx }

export class FftStream {
  readonly m: number;
  stages: StreamStage[];
  constructor(readonly N: number, readonly W: number) {
    this.m = Math.log2(N);
    this.stages = Array.from({ length: this.m }, (_, s) => ({ count: 0, line: Array.from({ length: N / 2 ** (s + 1) }, () => ({ re: 0, im: 0 })), out: { re: 0, im: 0 } }));
  }
  /** The counter's reset value at stage s, in its N / 2^s counts. */
  startCount(s: number): number { const M = this.N / 2 ** s; return (M - (streamLag(this.N, s) % M)) % M; }
  get q(): Fx { return this.stages[this.m - 1].out; }
  /** One rising edge. */
  step(d: Fx, en: boolean, rst: boolean): void {
    const { N, W } = this, ins = this.stages.map((_, s) => (s ? this.stages[s - 1].out : d));
    this.stages.forEach((st, s) => {
      const M = N / 2 ** s, L = M / 2;
      const c = st.count;
      // reset only loads the counter: the data keeps moving while en = 1, as the registers do
      st.count = rst ? this.startCount(s) : en ? (c + 1) % M : c;
      if (!en) return;
      const sel = c >= L, j = c % L, x = ins[s], old = st.line[L - 1];
      const y0 = { re: addH(old.re, x.re, W), im: addH(old.im, x.im, W) }, y1 = { re: subH(old.re, x.re, W), im: subH(old.im, x.im, W) };
      st.out = sel ? y0 : twiddleFx(old, j * 2 ** s, N, W);
      st.line = [sel ? y1 : x, ...st.line.slice(0, L - 1)];
    });
  }
  /** Run a block in (zeros after it, to flush it through), returning its tones in natural order: X[k] / N. */
  static transform(x: readonly Fx[], W: number): Fx[] {
    const N = x.length, f = new FftStream(N, W), bits = Math.log2(N), out = new Array<Fx>(N);
    f.step({ re: 0, im: 0 }, false, true);
    const lat = streamLatency(N);
    for (let t = 0; t < lat + N; t++) {
      f.step(t < N ? x[t] : { re: 0, im: 0 }, true, false);
      if (t >= lat - 1 && t - lat + 1 < N) out[bitRev(t - lat + 1, bits)] = f.q;
    }
    return out;
  }
}

/** Tone power over rounding noise (dB), measured on seeded random blocks with |x| up to `m`: what the integer transform leaves of a noise-like block. */
export function fftSnrDb(N: number, W: number, blocks: number, seed: number, m = 0.9): number {
  let v = seed >>> 0, sig = 0, err = 0;
  const u = () => (v = (Math.imul(v, 1103515245) + 12345) >>> 0) / 2 ** 32, FS = 2 ** (W - 1);
  for (let t = 0; t < blocks; t++) {
    const x = Array.from({ length: N }, () => { const r = m * Math.sqrt(u()), a = 2 * Math.PI * u(); return { re: Math.trunc(r * Math.cos(a) * FS), im: Math.trunc(r * Math.sin(a) * FS) }; });
    const F = fft({ re: Float64Array.from(x, (c) => c.re), im: Float64Array.from(x, (c) => c.im) });
    fftFx(x, W).forEach((c, k) => { const fr = F.re[k] / N, fi = F.im[k] / N; sig += fr * fr + fi * fi; err += (c.re - fr) ** 2 + (c.im - fi) ** 2; });
  }
  return 10 * Math.log10(sig / err);
}
