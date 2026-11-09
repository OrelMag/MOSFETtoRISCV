// Convolutional codes and the Viterbi decoder (DOM-free): chapter modem's golden model for lib/viterbi.ts. Rate 1/2, feed-forward.
//
// The rules the gates follow, bit for bit:
// - Generators are written with the most significant of K bits on the input bit: reg = (u << (K - 1)) | state, each output the
//   parity of reg & g, next state = reg >> 1. So bit K - 2 of a state is the newest input.
// - Each received symbol is two levels of q bits, 0 a sure 0 and 2^q - 1 a sure 1 (q = 1: a hard decision). The branch metric of
//   an expected pair is the sum over both levels of (expected ? max - r : r): q = 1 makes it the Hamming distance.
// - Metrics are w bits and wrap (Hekstra's modulo normalization): width() makes every compared difference smaller than 2^(w-1), so
//   the sign of the w-bit difference orders them with nothing ever subtracted from all of them. rst zeroes the metrics.
// - A state's predecessors are p0 = (ns << 1) & mask and p1 = p0 | 1; it takes p1 only when c1 - c0 has its top bit set, so a tie
//   takes p0.
// - Survivors are register exchange: a state's D-bit register takes its winner's register shifted left, with the input bit that
//   enters this state (its own top bit) at the bottom. `out` is bit D - 1 of state 0's register, read before the edge.

export interface ConvSpec { K: number; g: readonly [number, number]; name: string }

/** The textbook code: four states, 7 and 5 octal. */
export const CONV_K3: ConvSpec = { K: 3, g: [0o7, 0o5], name: 'K = 3 (7, 5)' };
/** The NASA / 802.11 code: 64 states, 133 and 171 octal (802.11 sends the 133 output first). */
export const CONV_K7: ConvSpec = { K: 7, g: [0o133, 0o171], name: 'K = 7 (133, 171)' };

export const parity = (x: number): number => { let v = x, p = 0; while (v) { p ^= v & 1; v >>>= 1; } return p; };
export const statesOf = (s: ConvSpec): number => 2 ** (s.K - 1);

/** One encoder step: the two output bits and the next state. */
export function convStep(s: ConvSpec, state: number, u: number): { a: number; b: number; next: number } {
  const reg = (u << (s.K - 1)) | state;
  return { a: parity(reg & s.g[0]), b: parity(reg & s.g[1]), next: reg >>> 1 };
}

/** The encoded bits, two per input bit, the first generator's first; `tail` appends K - 1 zeros to end in state 0. */
export function convEncode(s: ConvSpec, bits: ArrayLike<number>, tail = false): number[] {
  const out: number[] = [];
  let st = 0;
  const n = bits.length + (tail ? s.K - 1 : 0);
  for (let i = 0; i < n; i++) { const r = convStep(s, st, i < bits.length ? bits[i] : 0); out.push(r.a, r.b); st = r.next; }
  return out;
}

/** The largest branch metric: two levels of q bits. */
export const bmMax = (q: number): number => 2 * (2 ** q - 1);

/** Metric width: from one state any state is K - 1 steps away, so metrics spread at most (K - 1) bmMax; a comparison adds one more bmMax. */
export function metricWidth(K: number, q: number): number {
  let w = 1;
  while (2 ** (w - 1) <= K * bmMax(q)) w++;
  return w;
}

/** The branch metric of an expected pair against levels r0, r1. */
export const branchMetric = (q: number, e0: number, e1: number, r0: number, r1: number): number => {
  const max = 2 ** q - 1;
  return (e0 ? max - r0 : r0) + (e1 ? max - r1 : r1);
};

/** Survivor depth: ten constraint lengths, where reading from a fixed state stops costing anything measurable (tests/comm-codes.test.ts). */
export const defaultDepth = (K: number): number => 10 * K;

export interface ViterbiOpts { q?: number; depth?: number }

/** The decoder's whole state, as the gates hold it. Survivors are bytes per bit (depth may exceed 32). */
export class Viterbi {
  readonly n: number; readonly q: number; readonly depth: number; readonly w: number;
  metric: Uint32Array;
  surv: Uint8Array[];
  sel: Uint8Array;
  private exp: { a: number; b: number }[][];
  constructor(readonly spec: ConvSpec, o: ViterbiOpts = {}) {
    this.n = statesOf(spec); this.q = o.q ?? 1; this.depth = o.depth ?? defaultDepth(spec.K); this.w = metricWidth(spec.K, this.q);
    this.metric = new Uint32Array(this.n); this.sel = new Uint8Array(this.n);
    this.surv = Array.from({ length: this.n }, () => new Uint8Array(this.depth));
    // for each next state, the expected pair from each predecessor
    this.exp = Array.from({ length: this.n }, (_, ns) => {
      const u = ns >>> (spec.K - 2), p0 = (ns << 1) & (this.n - 1);
      return [p0, p0 | 1].map((p) => { const r = convStep(spec, p, u); return { a: r.a, b: r.b }; });
    });
  }
  /** Oldest bit of state 0's survivor: the decoder's output, valid before the next edge. */
  get out(): number { return this.surv[0][this.depth - 1]; }
  /** Metrics to 0 (the survivors keep their contents). */
  resetMetrics(): void { this.metric.fill(0); }
  /** One clock edge with en = 1: add, compare, select in every state at once. */
  step(r0: number, r1: number): void {
    const M = 2 ** this.w, half = M / 2, { n, q } = this;
    const m = new Uint32Array(n), surv: Uint8Array[] = new Array<Uint8Array>(n);
    for (let ns = 0; ns < n; ns++) {
      const p0 = (ns << 1) & (n - 1), p1 = p0 | 1, [e0, e1] = this.exp[ns];
      const c0 = (this.metric[p0] + branchMetric(q, e0.a, e0.b, r0, r1)) % M, c1 = (this.metric[p1] + branchMetric(q, e1.a, e1.b, r0, r1)) % M;
      const s = (c1 - c0 + M) % M >= half ? 1 : 0;
      this.sel[ns] = s;
      m[ns] = s ? c1 : c0;
      const from = this.surv[s ? p1 : p0], to = new Uint8Array(this.depth);
      to.set(from.subarray(0, this.depth - 1), 1);
      to[0] = ns >>> (this.spec.K - 2);
      surv[ns] = to;
    }
    this.metric = m; this.surv = surv;
  }
  /** The largest difference between two metrics, read through the wrap from the smallest: stays below half the range by construction. */
  spread(): number {
    const M = 2 ** this.w;
    let worst = 0;
    for (let i = 0; i < this.n; i++) for (let j = 0; j < this.n; j++) { const d = (this.metric[i] - this.metric[j] + M) % M; if (d < M / 2 && d > worst) worst = d; }
    return worst;
  }
}

/** Decode a stream of level pairs with the gates' rules; the output for input i comes `depth` steps later, so the stream needs flushing. */
export function viterbiDecode(spec: ConvSpec, levels: ArrayLike<number>, o: ViterbiOpts = {}): number[] {
  const v = new Viterbi(spec, o), out: number[] = [];
  for (let i = 0; i + 1 < levels.length; i += 2) { v.step(levels[i], levels[i + 1]); out.push(v.out); }
  return out;
}

// ---- the code's distance -------------------------------------------------------------------------------------------------

/**
 * Error events by output weight, the code's distance spectrum: from state 0 leaving on a 1, every path back to state 0 first time,
 * counted by weight up to dMax: A[d] paths, B[d] input bits set over those paths. Dynamic programming over (state, weight, ones).
 */
export function spectrum(s: ConvSpec, dMax: number): { dfree: number; A: number[]; B: number[] } {
  const n = statesOf(s), ones = 200;
  const key = (st: number, w: number) => st * (dMax + 1) + w;
  // cnt[state, weight] = per number of input ones, the number of paths; floats are exact far beyond these counts
  let cur = new Map<number, Float64Array>();
  const first = convStep(s, 0, 1), w0 = first.a + first.b;
  const seed = new Float64Array(ones); seed[1] = 1;
  cur.set(key(first.next, w0), seed);
  const A = new Array<number>(dMax + 1).fill(0), B = new Array<number>(dMax + 1).fill(0);
  for (let len = 0; len < 40 * s.K + dMax * n && cur.size; len++) {
    const nxt = new Map<number, Float64Array>();
    for (const [k, c] of cur) {
      const st = Math.floor(k / (dMax + 1)), w = k % (dMax + 1);
      for (const u of [0, 1]) {
        const r = convStep(s, st, u), w2 = w + r.a + r.b;
        if (w2 > dMax) continue;
        if (r.next === 0) { // back at state 0: a complete event (only u = 0 can reach it)
          for (let i = 0; i + u < ones; i++) if (c[i]) { A[w2] += c[i]; B[w2] += c[i] * (i + u); }
          continue;
        }
        const kk = key(r.next, w2);
        let t = nxt.get(kk);
        if (!t) nxt.set(kk, (t = new Float64Array(ones)));
        for (let i = 0; i + u < ones; i++) t[i + u] += c[i];
      }
    }
    cur = nxt;
  }
  return { dfree: A.findIndex((x) => x > 0), A, B };
}
