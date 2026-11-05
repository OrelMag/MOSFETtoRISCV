// LDPC codes on a model (DOM-free), for "Codes near the limit": a seeded regular code, peeling on the erasure channel, sum-product and normalized
// min-sum on the binary-input Gaussian channel, density evolution for both, and the concatenated K = 7 + interleaver + RS(255, 223) link they are
// measured against. Nothing here is gates. tests/comm-ldpc.test.ts holds belief propagation to brute-force marginals on a graph without cycles, the
// erasure decoder to the density evolution's recursion, round by round, and the finite codes' waterfalls to the thresholds computed here.
//
// Conventions: an LLR is log P(bit = 0) / P(bit = 1), so a channel value y for x = 1 - 2c on noise σ is 2y / σ²; check messages by the tanh rule.
// comm/ber.ts sends a 1 as +1 and has no LLRs, so nothing here depends on its polarity, only on its σ.

import { gaussian, rng } from '../phys/line';
import { quantize, sigmaOf } from './ber';
import { CONV_K7, convEncode, Viterbi, type ConvSpec } from './conv';
import { deinterleave, interleave } from './interleave';
import { rsDecode, rsEncode } from './rs';

// ---- the graph --------------------------------------------------------------------------------------------------------------

/** A Tanner graph as edge lists: edge e joins variable edgeVar[e] and check edgeChk[e]. */
export interface Tanner {
  n: number; m: number;
  edgeVar: Int32Array; edgeChk: Int32Array;
  /** Edges of variable v: varEdges[varOff[v]] … varEdges[varOff[v + 1] - 1]; the same for checks. */
  varOff: Int32Array; varEdges: Int32Array;
  chkOff: Int32Array; chkEdges: Int32Array;
}

/** The graph of a list of checks, each the variables it sums. */
export function tannerOf(n: number, checks: readonly (readonly number[])[]): Tanner {
  const pairs = checks.flatMap((vs, c) => vs.map((v) => [v, c] as const)), E = pairs.length;
  const edgeVar = Int32Array.from(pairs, (p) => p[0]), edgeChk = Int32Array.from(pairs, (p) => p[1]), m = checks.length;
  const index = (count: number, key: Int32Array) => {
    const off = new Int32Array(count + 1), list = new Int32Array(E);
    for (let e = 0; e < E; e++) off[key[e] + 1]++;
    for (let i = 0; i < count; i++) off[i + 1] += off[i];
    const at = off.slice();
    for (let e = 0; e < E; e++) list[at[key[e]]++] = e;
    return { off, list };
  };
  const v = index(n, edgeVar), c = index(m, edgeChk);
  return { n, m, edgeVar, edgeChk, varOff: v.off, varEdges: v.list, chkOff: c.off, chkEdges: c.list };
}

export const designRate = (t: Tanner): number => 1 - t.m / t.n;

/** Pairs of checks sharing two variables: the 4-cycles, the shortest a Tanner graph can have. A parallel edge counts too. */
export function fourCycles(t: Tanner): number {
  let count = 0;
  for (let c = 0; c < t.m; c++) {
    const hits = new Map<number, number>();
    for (let i = t.chkOff[c]; i < t.chkOff[c + 1]; i++) {
      const v = t.edgeVar[t.chkEdges[i]];
      for (let j = t.varOff[v]; j < t.varOff[v + 1]; j++) { const d = t.edgeChk[t.varEdges[j]]; if (d > c) hits.set(d, (hits.get(d) ?? 0) + 1); }
    }
    for (const k of hits.values()) if (k > 1) count++;
  }
  return count;
}

/**
 * A seeded (dv, dc)-regular graph from the configuration model: every variable has dv sockets, every check dc, joined at random. A second edge
 * between the same pair, or two checks sharing two variables, is then swapped away against a random edge. Nothing is read from a table, so a seed
 * is the whole description of the code, and it stays a sample of the ensemble density evolution describes.
 */
export function regularCode(n: number, dv = 3, dc = 6, seed = 1): Tanner {
  const m = (n * dv) / dc;
  if (!Number.isInteger(m)) throw new Error(`regularCode: ${n} · ${dv} is not a multiple of ${dc}`);
  const u = rng(seed), E = n * dv, chk = new Int32Array(E);
  for (let e = 0; e < E; e++) chk[e] = Math.floor(e / dc);
  for (let e = E - 1; e > 0; e--) { const j = Math.floor(u() * (e + 1)), x = chk[e]; chk[e] = chk[j]; chk[j] = x; }
  // edge e belongs to variable ⌊e / dv⌋; members[c] counts each variable's edges on check c
  const members: Map<number, number>[] = Array.from({ length: m }, () => new Map());
  const join = (c: number, v: number, d: number) => { const k = (members[c].get(v) ?? 0) + d; if (k) members[c].set(v, k); else members[c].delete(v); };
  for (let e = 0; e < E; e++) join(chk[e], Math.floor(e / dv), 1);
  /** Does this edge make a parallel edge, or share two variables with another check? */
  const bad = (e: number): boolean => {
    const v = Math.floor(e / dv), c = chk[e];
    if (members[c].get(v)! > 1) return true;
    for (const w of members[c].keys()) {
      if (w === v) continue;
      for (let i = v * dv; i < (v + 1) * dv; i++) if (i !== e && chk[i] !== c && members[chk[i]].has(w)) return true;
    }
    return false;
  };
  for (let pass = 0; pass < 100; pass++) {
    let left = 0;
    for (let e = 0; e < E; e++) {
      if (!bad(e)) continue;
      left++;
      const j = Math.floor(u() * E), a = chk[e], b = chk[j];
      if (a === b) continue;
      const v = Math.floor(e / dv), w = Math.floor(j / dv);
      join(a, v, -1); join(b, w, -1); join(b, v, 1); join(a, w, 1);
      chk[e] = b; chk[j] = a;
    }
    if (!left) break;
  }
  const checks: number[][] = Array.from({ length: m }, () => []);
  for (let e = 0; e < E; e++) checks[chk[e]].push(Math.floor(e / dv));
  return tannerOf(n, checks);
}

// ---- an encoder -------------------------------------------------------------------------------------------------------------

/** A systematic encoder by Gaussian elimination over GF(2): k message bits go to `free` variables, each pivot variable is a sum of them. Small codes only (the widgets'): the error rates need only the all-zero word. */
export function encoderOf(t: Tanner): { k: number; free: number[]; encode(msg: ArrayLike<number>): Uint8Array } {
  const W = (t.n + 31) >>> 5, rows = Array.from({ length: t.m }, () => new Uint32Array(W));
  for (let e = 0; e < t.edgeVar.length; e++) rows[t.edgeChk[e]][t.edgeVar[e] >>> 5] ^= 1 << (t.edgeVar[e] & 31);
  const pivots: { row: number; col: number }[] = [];
  let r = 0;
  for (let col = 0; col < t.n && r < t.m; col++) {
    let p = -1;
    for (let i = r; i < t.m; i++) if ((rows[i][col >>> 5] >>> (col & 31)) & 1) { p = i; break; }
    if (p < 0) continue;
    [rows[r], rows[p]] = [rows[p], rows[r]];
    for (let i = 0; i < t.m; i++) if (i !== r && (rows[i][col >>> 5] >>> (col & 31)) & 1) for (let w = 0; w < W; w++) rows[i][w] ^= rows[r][w];
    pivots.push({ row: r, col });
    r++;
  }
  const isPivot = new Uint8Array(t.n);
  for (const p of pivots) isPivot[p.col] = 1;
  const free: number[] = [];
  for (let v = 0; v < t.n; v++) if (!isPivot[v]) free.push(v);
  return {
    k: free.length, free,
    encode(msg) {
      const c = new Uint8Array(t.n);
      free.forEach((v, i) => { c[v] = msg[i] ? 1 : 0; });
      for (const { row, col } of pivots) {
        let s = 0;
        for (const v of free) if (c[v] && (rows[row][v >>> 5] >>> (v & 31)) & 1) s ^= 1;
        c[col] = s;
      }
      return c;
    },
  };
}

/** Is `c` a code word? */
export function syndromeOk(t: Tanner, c: ArrayLike<number>): boolean {
  for (let k = 0; k < t.m; k++) {
    let s = 0;
    for (let i = t.chkOff[k]; i < t.chkOff[k + 1]; i++) s ^= c[t.edgeVar[t.chkEdges[i]]];
    if (s) return false;
  }
  return true;
}

// ---- the erasure channel ------------------------------------------------------------------------------------------------------

/**
 * Flooding message passing on the erasure channel, the form density evolution counts: a variable-to-check message is erased when the channel erased
 * the variable and all its other checks' messages are; a check-to-variable message when any other variable's is. `erased` per round, from round 0 (the channel's).
 */
export function peel(t: Tanner, channel: ArrayLike<number>, maxRounds = 1000): { erased: number[]; left: number; rounds: number } {
  const E = t.edgeVar.length, v2c = new Uint8Array(E), c2v = new Uint8Array(E).fill(1);
  const countOf = () => {
    let k = 0;
    for (let v = 0; v < t.n; v++) {
      if (!channel[v]) continue;
      let all = 1;
      for (let i = t.varOff[v]; i < t.varOff[v + 1]; i++) if (!c2v[t.varEdges[i]]) { all = 0; break; }
      k += all;
    }
    return k;
  };
  const erased = [countOf()];
  let rounds = 0;
  while (rounds < maxRounds && erased[rounds] > 0) {
    for (let v = 0; v < t.n; v++) {
      const a = t.varOff[v], b = t.varOff[v + 1];
      for (let i = a; i < b; i++) {
        let er = channel[v] ? 1 : 0;
        for (let j = a; j < b && er; j++) if (j !== i && !c2v[t.varEdges[j]]) er = 0;
        v2c[t.varEdges[i]] = er;
      }
    }
    for (let c = 0; c < t.m; c++) {
      const a = t.chkOff[c], b = t.chkOff[c + 1];
      let total = 0;
      for (let i = a; i < b; i++) total += v2c[t.chkEdges[i]];
      for (let i = a; i < b; i++) { const e = t.chkEdges[i]; c2v[e] = total - v2c[e] > 0 ? 1 : 0; }
    }
    rounds++;
    const k = countOf();
    erased.push(k);
    if (k === erased[rounds - 1] && rounds > 1) break;
  }
  return { erased, left: erased[rounds], rounds };
}

/** Each bit erased independently with probability ε. */
export function erasures(n: number, eps: number, seed: number): Uint8Array {
  const u = rng(seed), e = new Uint8Array(n);
  for (let i = 0; i < n; i++) e[i] = u() < eps ? 1 : 0;
  return e;
}

/** Density evolution on the erasure channel: x, the erasure probability of a variable-to-check message, x₀ = ε, x' = ε (1 - (1 - x)^(dc-1))^(dv-1). */
export function deBecStep(eps: number, x: number, dv = 3, dc = 6): number {
  return eps * (1 - (1 - x) ** (dc - 1)) ** (dv - 1);
}

/** The share of bits still erased after each round: round 0 is ε, then ε (1 - (1 - x)^(dc-1))^dv with x the messages' erasure probability. */
export function deBecBits(eps: number, rounds: number, dv = 3, dc = 6): number[] {
  const out = [eps];
  let x = eps;
  for (let l = 1; l <= rounds; l++) { out.push(eps * (1 - (1 - x) ** (dc - 1)) ** dv); x = deBecStep(eps, x, dv, dc); }
  return out;
}

/** The largest ε whose recursion falls to zero, by bisection. */
export function becThreshold(dv = 3, dc = 6, bits = 34): number {
  let a = 0, b = 1;
  const falls = (eps: number) => {
    let x = eps;
    for (let i = 0; i < 2000000; i++) { const y = deBecStep(eps, x, dv, dc); if (y < 1e-12) return true; if (x - y < 1e-15) return false; x = y; }
    return false;
  };
  for (let i = 0; i < bits; i++) { const m = (a + b) / 2; if (falls(m)) a = m; else b = m; }
  return (a + b) / 2;
}

/** The threshold from its other definition: a fixed point x = ε f(x) needs ε = x / f(x), so it is the smallest value of that over x in (0, 1]. */
export function becThresholdMin(dv = 3, dc = 6, steps = 200000): number {
  let best = Infinity;
  for (let i = 1; i <= steps; i++) { const x = i / steps, v = x / (1 - (1 - x) ** (dc - 1)) ** (dv - 1); if (v < best) best = v; }
  return best;
}

// ---- belief propagation on the Gaussian channel ---------------------------------------------------------------------------------

export type BpKind = 'sum-product' | 'min-sum';
export interface BpOpts { kind?: BpKind; /** Min-sum's normalization: check messages times this. */ alpha?: number }

/** A check's output saturates at the tanh of this much LLR: finite for arctanh, and far past anything that changes a decision. */
const LLR_CLIP = 40;
const TANH_LIMIT = Math.tanh(LLR_CLIP / 2);

/** Flooding belief propagation, one iterate() at a time, its messages open for a widget. */
export class Bp {
  readonly v2c: Float64Array; readonly c2v: Float64Array;
  /** A-posteriori LLR per variable after the last iteration. */
  readonly post: Float64Array;
  /** Hard decisions (LLR < 0 → 1). */
  readonly hard: Uint8Array;
  iterations = 0;
  private kind: BpKind; private alpha: number;
  constructor(readonly t: Tanner, readonly channel: ArrayLike<number>, o: BpOpts = {}) {
    this.kind = o.kind ?? 'sum-product'; this.alpha = o.alpha ?? 0.8;
    const E = t.edgeVar.length;
    this.v2c = new Float64Array(E); this.c2v = new Float64Array(E); this.post = new Float64Array(t.n); this.hard = new Uint8Array(t.n);
    this.total();
  }
  private total(): void {
    const { t, c2v, post, hard, channel } = this;
    for (let v = 0; v < t.n; v++) {
      let s = channel[v];
      for (let i = t.varOff[v]; i < t.varOff[v + 1]; i++) s += c2v[t.varEdges[i]];
      post[v] = s; hard[v] = s < 0 ? 1 : 0;
    }
  }
  /** Variables speak, then checks answer: each message leaves out what its receiver sent. */
  iterate(): void {
    const { t, v2c, c2v, post, kind, alpha } = this;
    const E = t.edgeVar.length;
    for (let e = 0; e < E; e++) v2c[e] = post[t.edgeVar[e]] - c2v[e];
    for (let c = 0; c < t.m; c++) {
      const a = t.chkOff[c], b = t.chkOff[c + 1], d = b - a;
      if (kind === 'sum-product') {
        // the product of the others' tanh, from both ends, so a zero message costs no division
        let f = 1;
        for (let i = 0; i < d; i++) { const e = t.chkEdges[a + i]; c2v[e] = f; f *= Math.tanh(v2c[e] / 2); }
        let g = 1;
        for (let i = d - 1; i >= 0; i--) {
          const e = t.chkEdges[a + i], p = c2v[e] * g;
          c2v[e] = 2 * Math.atanh(Math.max(-TANH_LIMIT, Math.min(TANH_LIMIT, p)));
          g *= Math.tanh(v2c[e] / 2);
        }
      } else {
        let min1 = Infinity, min2 = Infinity, at = -1, sign = 1;
        for (let i = 0; i < d; i++) {
          const m = v2c[t.chkEdges[a + i]], z = Math.abs(m);
          if (m < 0) sign = -sign;
          if (z < min1) { min2 = min1; min1 = z; at = i; } else if (z < min2) min2 = z;
        }
        for (let i = 0; i < d; i++) {
          const e = t.chkEdges[a + i], z = i === at ? min2 : min1;
          c2v[e] = (v2c[e] < 0 ? -sign : sign) * alpha * z;
        }
      }
    }
    this.total();
    this.iterations++;
  }
  get ok(): boolean { return syndromeOk(this.t, this.hard); }
}

/** Decode until the checks hold, or give up. */
export function bpDecode(t: Tanner, channel: ArrayLike<number>, o: BpOpts & { maxIter?: number } = {}): { hard: Uint8Array; post: Float64Array; iterations: number; ok: boolean } {
  const d = new Bp(t, channel, o), max = o.maxIter ?? 100;
  let ok = d.ok;
  while (!ok && d.iterations < max) { d.iterate(); ok = d.ok; }
  return { hard: d.hard, post: d.post, iterations: d.iterations, ok };
}

/** The exact marginals by enumerating every code word: what a graph without cycles must reproduce. Small codes only. */
export function mapMarginals(t: Tanner, channel: ArrayLike<number>): Float64Array {
  const p0 = new Float64Array(t.n), p1 = new Float64Array(t.n), bits = new Uint8Array(t.n);
  for (let w = 0; w < 2 ** t.n; w++) {
    for (let v = 0; v < t.n; v++) bits[v] = (w >>> v) & 1;
    if (!syndromeOk(t, bits)) continue;
    let ll = 0;
    for (let v = 0; v < t.n; v++) if (bits[v]) ll -= channel[v]; // P(y | c = 1) / P(y | c = 0) = e^(-L)
    const q = Math.exp(ll);
    for (let v = 0; v < t.n; v++) { if (bits[v]) p1[v] += q; else p0[v] += q; }
  }
  return p0.map((a, v) => Math.log(a / p1[v]));
}

export interface LdpcRun { bits: number; errors: number; ber: number; frames: number; frameErrors: number; meanIter: number }

/** The channel's LLRs for a word on Eb/N0 at the code's rate. */
export function channelLlr(c: ArrayLike<number>, ebn0Db: number, rate: number, u: () => number): Float64Array {
  const sig = sigmaOf(ebn0Db, rate), scale = 2 / (sig * sig), ch = new Float64Array(c.length);
  for (let i = 0; i < c.length; i++) ch[i] = ((c[i] ? -1 : 1) + sig * gaussian(u)) * scale;
  return ch;
}

/** Frames of the all-zero word on the Gaussian channel (a symmetric channel and decoder: the word sent does not change the error rate, tests/comm-ldpc.test.ts). */
export function ldpcTrial(t: Tanner, ebn0Db: number, frames: number, o: BpOpts & { maxIter?: number; seed?: number } = {}): LdpcRun {
  const u = rng(o.seed ?? 1), zero = new Uint8Array(t.n);
  let errors = 0, frameErrors = 0, iters = 0;
  for (let f = 0; f < frames; f++) {
    const r = bpDecode(t, channelLlr(zero, ebn0Db, designRate(t), u), o);
    let e = 0;
    for (let i = 0; i < t.n; i++) e += r.hard[i];
    errors += e; if (e) frameErrors++;
    iters += r.iterations;
  }
  return { bits: frames * t.n, errors, ber: errors / (frames * t.n), frames, frameErrors, meanIter: iters / frames };
}

// ---- density evolution on the Gaussian channel: a discretized form --------------------------------------------------------------

export interface DeAwgn { /** The bit-error probability of a variable-to-check message, round by round from round 0 (the channel's). */ p: number[]; converged: boolean }

/**
 * Discretized density evolution for sum-product: LLR densities on a grid of `step` out to ±`limit`, mass past the end kept at the end. A variable adds
 * densities (a convolution); a check maps pairs through 2 atanh(tanh(a / 2) tanh(b / 2)), rounded to the grid. This analyses a quantized decoder exactly,
 * so it estimates the continuous threshold, closer as the step shrinks. `converged` when the error falls below `target`.
 */
export function deAwgn(sigma: number, dv = 3, dc = 6, o: { step?: number; limit?: number; rounds?: number; target?: number } = {}): DeAwgn {
  const step = o.step ?? 0.125, limit = o.limit ?? 25, rounds = o.rounds ?? 500, target = o.target ?? 1e-6;
  const K = Math.round(limit / step), N = 2 * K + 1, idx = (x: number) => Math.max(-K, Math.min(K, Math.round(x / step))) + K;
  // the channel's density: L = 2y / σ² on y = 1 + σ z: mean 2 / σ², deviation 2 / σ
  const mu = 2 / (sigma * sigma), sd = 2 / sigma, ch = new Float64Array(N);
  let tot = 0;
  for (let i = 0; i < N; i++) { const x = (i - K) * step; ch[i] = Math.exp(-((x - mu) ** 2) / (2 * sd * sd)); tot += ch[i]; }
  for (let i = 0; i < N; i++) ch[i] /= tot;
  const table = new Int32Array(N * N);
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const a = (i - K) * step, b = (j - K) * step, p = Math.tanh(a / 2) * Math.tanh(b / 2);
    table[i * N + j] = idx(2 * Math.atanh(Math.max(-TANH_LIMIT, Math.min(TANH_LIMIT, p))));
  }
  const check = (a: Float64Array, b: Float64Array) => {
    const o2 = new Float64Array(N);
    for (let i = 0; i < N; i++) { const ai = a[i]; if (ai < 1e-30) continue; for (let j = 0; j < N; j++) o2[table[i * N + j]] += ai * b[j]; }
    return o2;
  };
  const add = (a: Float64Array, b: Float64Array) => {
    const o2 = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const ai = a[i];
      if (ai < 1e-30) continue;
      for (let j = 0; j < N; j++) { const s = i + j - K, k = s < 0 ? 0 : s >= N ? N - 1 : s; o2[k] += ai * b[j]; }
    }
    return o2;
  };
  const power = (d: Float64Array, e: number, op: (a: Float64Array, b: Float64Array) => Float64Array) => {
    let r: Float64Array | null = null, base = d, n = e;
    while (n) { if (n & 1) r = r ? op(r, base) : base; n >>= 1; if (n) base = op(base, base); }
    return r!;
  };
  const err = (d: Float64Array) => { let s = 0.5 * d[K]; for (let i = 0; i < K; i++) s += d[i]; return s; };
  let v = ch;
  const p = [err(v)];
  for (let l = 0; l < rounds; l++) {
    const c = power(v, dc - 1, check), u = power(c, dv - 1, add);
    v = add(ch, u);
    // total mass is raised to the power (dc - 1)(dv - 1) each round, so a rounding error in the last bit would otherwise grow until it swamps everything
    let mass = 0;
    for (let i = 0; i < N; i++) mass += v[i];
    for (let i = 0; i < N; i++) v[i] /= mass;
    const e = err(v);
    p.push(e);
    if (e < target) return { p, converged: true };
    if (l > 30 && Math.abs(p[l] - e) < 1e-9) return { p, converged: false };
  }
  return { p, converged: false };
}

/** The largest σ that converges, by bisection between two values known to bracket it. */
export function awgnThreshold(lo = 0.8, hi = 1, dv = 3, dc = 6, o: { step?: number; limit?: number; rounds?: number; bits?: number } = {}): number {
  let a = lo, b = hi;
  for (let i = 0; i < (o.bits ?? 8); i++) { const m = (a + b) / 2; if (deAwgn(m, dv, dc, { rounds: 3000, ...o }).converged) a = m; else b = m; }
  return (a + b) / 2;
}

/** What the channel's σ means on the Eb/N0 axis at a rate: Eb/N0 = 1 / (2 R σ²), in dB. */
/** (3, 6)'s threshold on the Gaussian channel lies between these: tests/comm-ldpc.test.ts converges at the first and not at the second. */
export const AWGN_SIGMA = [0.875, 0.89] as const;
export const ebn0OfSigma = (sigma: number, rate = 0.5): number => 10 * Math.log10(1 / (2 * rate * sigma * sigma));

// ---- the concatenated code --------------------------------------------------------------------------------------------------

export interface ConcatOpts {
  /** Reed-Solomon words a frame, interleaved by bytes. */ depth?: number;
  frames?: number; seed?: number;
  n?: number; k?: number;
  spec?: ConvSpec;
  /** Levels per channel bit in bits (3: as the Viterbi steps), survivor depth. */ q?: number; vitDepth?: number;
  /** When given, collects each wrong byte's place over the frames as sent, for a picture of the bursts. */ errs?: number[];
}

export interface ConcatRun {
  words: number; failed: number;
  /** After Viterbi, before Reed-Solomon. */ innerBitErrors: number; innerBits: number; byteErrors: number; bytes: number;
  /** After both, over the data bytes. */ dataBits: number; dataBitErrors: number;
}

/** The whole rate including both codes: Reed-Solomon's times ½. */
export const concatRate = (n = 255, k = 223): number => (0.5 * k) / n;

/**
 * The deep-space shape, RS outside, K = 7 inside: `depth` words of k data bytes, each with its n - k check bytes, written as rows and sent by columns as bytes,
 * most significant bit first, through the encoder and Gaussian noise (Eb/N0 counted on the whole rate) to the Viterbi decoder and back. The encoder is flushed
 * with survivor-depth zeros after each frame, so the frame's end is as safe as its middle, and that flush is left out of the rate as a real stream has none.
 */
export function concatTrial(ebn0Db: number, o: ConcatOpts = {}): ConcatRun {
  const D = o.depth ?? 8, n = o.n ?? 255, k = o.k ?? 223, frames = o.frames ?? 1, q = o.q ?? 3, spec = o.spec ?? CONV_K7, nsym = n - k;
  const u = rng(o.seed ?? 1), sig = sigmaOf(ebn0Db, concatRate(n, k));
  const r: ConcatRun = { words: 0, failed: 0, innerBitErrors: 0, innerBits: 0, byteErrors: 0, bytes: 0, dataBits: 0, dataBitErrors: 0 };
  for (let f = 0; f < frames; f++) {
    const msgs = Array.from({ length: D }, () => Array.from({ length: k }, () => Math.floor(u() * 256)));
    const words = msgs.map((m) => [...m, ...rsEncode(m, nsym)]), stream = interleave(words);
    const bits: number[] = [];
    for (const b of stream) for (let i = 7; i >= 0; i--) bits.push((b >>> i) & 1);
    const vit = new Viterbi(spec, { q, depth: o.vitDepth }), Dv = vit.depth, tx = convEncode(spec, [...bits, ...new Array<number>(Dv).fill(0)]), got = new Uint8Array(bits.length);
    for (let i = 0; i < tx.length / 2; i++) {
      vit.step(quantize((tx[2 * i] ? 1 : -1) + sig * gaussian(u), q), quantize((tx[2 * i + 1] ? 1 : -1) + sig * gaussian(u), q));
      const j = i - (Dv - 1);
      if (j >= 0 && j < bits.length) got[j] = vit.out;
    }
    const rxBytes: number[] = [];
    for (let i = 0; i < stream.length; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) { b = (b << 1) | got[8 * i + j]; if (got[8 * i + j] !== bits[8 * i + j]) r.innerBitErrors++; }
      if (b !== stream[i]) { r.byteErrors++; o.errs?.push(f * stream.length + i); }
      rxBytes.push(b);
    }
    r.innerBits += bits.length; r.bytes += stream.length;
    deinterleave(rxBytes, D).forEach((w, i) => {
      r.words++;
      const dec = rsDecode(w, nsym), out = dec.word ?? w;
      let wrong = dec.word ? 0 : 1;
      for (let j = 0; j < k; j++) {
        let x = out[j] ^ msgs[i][j];
        if (x) wrong = 1;
        for (; x; x &= x - 1) r.dataBitErrors++;
      }
      r.dataBits += 8 * k;
      if (wrong) r.failed++;
    });
  }
  return r;
}

/** P(more than t of n symbols wrong) when each is wrong independently with probability P: the closed form an ideal interleaver gives Reed-Solomon. */
export function rsWordFailure(n: number, t: number, P: number): number {
  let sum = 0, term = (1 - P) ** n;
  for (let i = 0; i <= t; i++) { sum += term; term *= ((n - i) / (i + 1)) * (P / (1 - P)); }
  return Math.max(0, 1 - sum);
}
