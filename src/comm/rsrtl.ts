// The Reed-Solomon decoder at register-transfer level (DOM-free): the golden model of lib/rsdec.ts, for "Codes near the limit". comm/rs.ts says what the answer
// is; this says how a clocked circuit reaches it, register by register, and tests/comm-rsdec.test.ts holds both to each other and the gates to this.
//
// The rules the gates follow, bit for bit. t = nsym / 2, n the word's length, both fixed when it is built. rst = 1 at an edge beats everything: phase RX, counter
// 0, λ = b = γ = 1, the rest 0. The phases run in order, each ending when `last`:
// - RX, n clocks with en = 1 (en = 0 holds everything; en is ignored afterwards). Syndromes by Horner: ring[k] ← ring[k] · α^k + d. Buffer shifts d in.
// - BM, 2t clocks, one iteration of inversionless Berlekamp-Massey each. The ring rotates every clock (ring[k] ← ring[k + 1], ring[2t - 1] ← ring[0]), so ring[0]
//   is S_r at iteration r and its tail is the window: S_(r - j) = ring[2t - j]. There is no window register. δ = λ₀ ring[0] + Σ_(j = 1..t) mask[j] λ_j ring[2t - j];
//   mask[j] = 1 once j ≤ the phase's step, a shift register of 1s, cleared on entering OM. Here λ_j = 0 for j > L ≤ r anyway, so it changes nothing; in OM it matters.
//   λ_j ← γ λ_j + δ b_(j - 1). k = r - 2L, so swap = (δ ≠ 0 and k ≥ 0) means 2L ≤ r: then b_j ← λ_j, γ ← δ, k ← ~k (that is -k - 1); else b_j ← b_(j - 1), b₀ ← 0, k ← k + 1.
//   Holding k and not L saves a subtractor and a comparator; L = (2t - k) / 2 afterwards. All λ_j are t + 1 bytes: once L > t the word is refused anyway, whatever falls off.
// - OM, t clocks. The ring keeps rotating, from S₀ again, and the same δ is now Ω_i = Σ_(j ≤ i) λ_j S_(i - j): the mask is what stops the window wrapping round to the
//   ring's far end. om[i] ← om[i + 1], om[t - 1] ← δ, so after t clocks om[i] = Ω_i.
// - INI, one clock. Position p counts from the word's end; the first byte sent is p = n - 1, so λ_j and om_j are multiplied by α^(-(n - 1) j), a constant. over ← k < 0: L > t.
// - CH, n clocks, one byte each. Registers now hold λ_j X^(-j) and Ω_j X^(-j) for X = α^p. Each edge multiplies by α^j (p falls by one). The sums: even, odd over λ's
//   terms; root = even + odd = 0 (Chien). Forney with first root 0 is e = X Ω(X⁻¹) / Λ'(X⁻¹), and Λ'(X⁻¹) = X · odd, so X cancels: e = Ω(X⁻¹) · odd⁻¹, the inverse
//   a^254 from 4 general multipliers (0⁻¹ = 0: a root with odd = 0 is a repeated root, and the count below catches it). out = buffer's end + (root ? e : 0), valid = 1.
//   Buffer shifts every clock. At a root k ← k + 2.
// - DONE, until rst. fail = over or k ≠ 2t: roots found ≠ L, since k + 2 L = 2t. out is not meaningful here. Bytes already sent cannot be taken back: fail is the verdict.

import { gfMul, gfPow } from './rs';

export const RS_PHASE = { RX: 0, BM: 1, OM: 2, INI: 3, CH: 4, DONE: 5 } as const;
export const RS_PHASE_NAMES = ['RX', 'BM', 'OM', 'INI', 'CH', 'DONE'];

/** k runs from -2t - 1 to 2t while the word can still be accepted: a signed register this wide. */
export const rsKWidth = (nsym: number): number => { let w = 1; while (2 ** (w - 1) <= nsym) w++; return w; };
/** The counter counts every phase's clocks. */
export const rsCntWidth = (nsym: number, n: number): number => { let w = 1; while (2 ** w < Math.max(n, nsym)) w++; return w; };
/** Clocks from the first byte's edge to the last corrected byte's: n, 2t, t, 1, n. */
export const rsLatency = (nsym: number, n: number): number => 2 * n + nsym + nsym / 2 + 1;

/** a^254 by the addition chain 1, 2, 3, 6, 7 on exponents 2^i - 1, as the gates: four multiplications, the rest squarings. */
export function gfInvChain(a: number): number {
  const sq = (x: number, times: number) => { let y = x; for (let i = 0; i < times; i++) y = gfMul(y, y); return y; };
  const b1 = a, b2 = gfMul(sq(b1, 1), b1), b3 = gfMul(sq(b2, 1), b1), b6 = gfMul(sq(b3, 3), b3), b7 = gfMul(sq(b6, 1), b1);
  return sq(b7, 1);
}

/** The combinational values of the current state and input. */
export interface RsComb { delta: number; swap: boolean; even: number; odd: number; root: boolean; inv: number; e: number; out: number; valid: boolean; done: boolean; fail: boolean; last: boolean }

export class RsRtl {
  readonly t: number;
  readonly kw: number;
  readonly cw: number;
  phase = 0; cnt = 0; k = 0; gamma = 0; over = 0;
  ring: number[]; lam: number[]; b: number[]; om: number[]; buf: number[];
  /** mask[j], j = 1 … t, at index j - 1. */
  mask: number[];
  constructor(readonly nsym: number, readonly n: number) {
    if (nsym % 2 || nsym < 2 || n <= nsym || n > 255) throw new Error(`RsRtl: no RS(${n}, ${n - nsym})`);
    this.t = nsym / 2; this.kw = rsKWidth(nsym); this.cw = rsCntWidth(nsym, n);
    this.ring = new Array<number>(nsym).fill(0); this.lam = new Array<number>(this.t + 1).fill(0); this.b = new Array<number>(this.t + 1).fill(0);
    this.om = new Array<number>(this.t).fill(0); this.buf = new Array<number>(n).fill(0); this.mask = new Array<number>(this.t).fill(0);
  }
  private get kNeg(): boolean { return this.k >= 2 ** (this.kw - 1); }
  comb(en: number): RsComb {
    const { t, nsym, n, lam, ring, mask, om, phase } = this;
    let delta = gfMul(lam[0], ring[0]);
    for (let j = 1; j <= t; j++) if (mask[j - 1]) delta ^= gfMul(lam[j], ring[nsym - j]);
    const swap = delta !== 0 && !this.kNeg;
    let even = 0, odd = 0, value = 0;
    lam.forEach((v, j) => { if (j & 1) odd ^= v; else even ^= v; });
    for (const v of om) value ^= v;
    const root = (even ^ odd) === 0, inv = gfInvChain(odd), e = gfMul(value, inv), out = this.buf[n - 1] ^ (root ? e : 0);
    const P = RS_PHASE;
    const last = phase === P.RX ? en === 1 && this.cnt === n - 1 : phase === P.BM ? this.cnt === nsym - 1 : phase === P.OM ? this.cnt === t - 1 : phase === P.INI ? true : phase === P.CH ? this.cnt === n - 1 : false;
    return { delta, swap, even, odd, root, inv, e, out, valid: phase === P.CH, done: phase === P.DONE, fail: phase === P.DONE && (this.over === 1 || this.k !== nsym), last };
  }
  /** One rising edge. */
  step(d: number, en: number, rst: number): void {
    const { t, nsym, n, kw, phase } = this, P = RS_PHASE, K = 2 ** kw;
    if (rst) {
      this.phase = 0; this.cnt = 0; this.k = 0; this.gamma = 1; this.over = 0;
      this.ring.fill(0); this.om.fill(0); this.mask.fill(0); this.lam.fill(0); this.b.fill(0);
      this.lam[0] = 1; this.b[0] = 1;
      return; // the buffer keeps its contents: nothing reads it until it has been refilled
    }
    const c = this.comb(en), rx = phase === P.RX && en === 1, bm = phase === P.BM, omp = phase === P.OM, ini = phase === P.INI, ch = phase === P.CH;
    const { lam, b, om, ring, buf } = this;
    if (rx) { for (let k = 0; k < nsym; k++) ring[k] = gfMul(ring[k], gfPow(k)) ^ d; }
    else if (bm || omp) { const h = ring[0]; for (let k = 0; k + 1 < nsym; k++) ring[k] = ring[k + 1]; ring[nsym - 1] = h; }
    if (rx || ch) { for (let i = n - 1; i > 0; i--) buf[i] = buf[i - 1]; buf[0] = d; }
    if (bm) {
      const nl = lam.map((v, j) => gfMul(this.gamma, v) ^ (j ? gfMul(c.delta, b[j - 1]) : 0));
      const nb = c.swap ? lam.slice() : b.map((_, j) => (j ? b[j - 1] : 0));
      this.lam = nl; this.b = nb;
      if (c.swap) { this.gamma = c.delta; this.k = (K - 1) - this.k; } else this.k = (this.k + 1) % K;
    }
    if (bm || omp) {
      if (bm && c.last) this.mask.fill(0);
      else { for (let j = t - 1; j > 0; j--) this.mask[j] = this.mask[j - 1]; this.mask[0] = 1; }
    }
    if (omp) { for (let i = 0; i + 1 < t; i++) om[i] = om[i + 1]; om[t - 1] = c.delta; }
    if (ini) {
      this.over = this.kNeg ? 1 : 0;
      for (let j = 0; j <= t; j++) lam[j] = gfMul(lam[j], gfPow(-(n - 1) * j));
      for (let j = 0; j < t; j++) om[j] = gfMul(om[j], gfPow(-(n - 1) * j));
    }
    if (ch) {
      if (c.root) this.k = (this.k + 2) % K;
      for (let j = 0; j <= t; j++) lam[j] = gfMul(lam[j], gfPow(j));
      for (let j = 0; j < t; j++) om[j] = gfMul(om[j], gfPow(j));
    }
    if (c.last) { this.cnt = 0; this.phase = phase + 1; }
    else if (rx || bm || omp || ch) this.cnt++;
  }
}

/** A word through the model: the bytes it sends and the verdict. */
export function rsRtlDecode(word: ArrayLike<number>, nsym: number): { out: number[]; fail: boolean; cycles: number } {
  const r = new RsRtl(nsym, word.length);
  r.step(0, 0, 1);
  const out: number[] = [];
  let cycles = 0;
  for (let i = 0; i < word.length; i++) { r.step(word[i], 1, 0); cycles++; }
  while (!r.comb(0).done) {
    const c = r.comb(0);
    if (c.valid) out.push(c.out);
    r.step(0, 0, 0); cycles++;
  }
  return { out, fail: r.comb(0).fail, cycles };
}
