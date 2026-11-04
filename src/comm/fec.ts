// Forward error correction as a trade (DOM-free): CRC + retransmission against Hamming SEC-DED blocks + CRC + retransmission
// on a binary symmetric channel with independent bit errors (real links burst: that needs interleaving and the stronger
// codes of comm/interleave.ts, conv.ts and rs.ts, and is not modelled here). Rate, residual frame loss, goodput and the time to deliver a frame, from
// closed forms that tests/comm-fec.test.ts holds to seeded simulations that run the real encoder, errors and decoder.

import { hammingLayout } from '../lib/coding';
import { rng } from '../phys/line';

/** Bits in a frame check sequence. */
export const CRC_BITS = 32;

// ---- SEC-DED on bit arrays (any width; lib/coding.ts's reference works on numbers, which stop at 31 bits) -----------------

/** Code bits (position 0 the overall parity) for the data bits, by the same layout as hamming{Enc,Dec}. */
export function secdedEncode(d: ArrayLike<number>): number[] {
  const k = d.length, { r, n, dataPos } = hammingLayout(k), c = new Array<number>(n).fill(0);
  dataPos.forEach((p, i) => { c[p] = d[i]; });
  for (let j = 0; j < r; j++) { let par = 0; dataPos.forEach((p, i) => { if ((p >> j) & 1) par ^= d[i]; }); c[1 << j] = par; }
  c[0] = c.reduce((a, b) => a ^ b, 0);
  return c;
}

export interface Decoded { data: number[]; syndrome: number; single: boolean; double: boolean }

export function secdedDecode(c: ArrayLike<number>, k: number): Decoded {
  const { r, n, dataPos } = hammingLayout(k), x = Array.from(c);
  let s = 0, all = 0;
  for (let p = 0; p < n; p++) if (x[p]) { all ^= 1; s ^= p; }
  s &= 2 ** r - 1;
  if (all && s < n) x[s] ^= 1;
  return { data: dataPos.map((p) => x[p]), syndrome: s, single: all === 1, double: !all && s !== 0 };
}

/** The code of k data bits: check bits and total length. */
export function codeOf(k: number): { r: number; n: number; rate: number } {
  const { r, n } = hammingLayout(k);
  return { r: r + 1, n, rate: k / n };
}

// ---- the two schemes ----------------------------------------------------------------------------------------------------

export interface Scheme {
  name: string;
  /** Payload bits. */
  payload: number;
  /** Bits on the wire per frame. */
  wire: number;
  /** Probability that the receiver rejects the frame (and the sender must repeat it). */
  pFail: number;
  /** Payload bits per bit on the wire, retransmissions included: the efficiency. */
  goodput: number;
}

/** CRC-32 and retransmission: any bit error in payload + CRC rejects the frame. */
export function crcOnly(payloadBytes: number, p: number): Scheme {
  const wire = 8 * payloadBytes + CRC_BITS, pFail = 1 - (1 - p) ** wire;
  return { name: 'CRC + retransmit', payload: 8 * payloadBytes, wire, pFail, goodput: ((8 * payloadBytes) / wire) * (1 - pFail) };
}

/** Probability that a SEC-DED block of `n` bits is received correctable: no error, or one. */
export const blockOk = (n: number, p: number): number => (1 - p) ** n + n * p * (1 - p) ** (n - 1);

/** Payload + CRC cut into blocks of `k` data bits, each a Hamming SEC-DED code word; a block with two or more errors rejects the frame. */
export function secdedCrc(payloadBytes: number, p: number, k = 64): Scheme {
  const blocks = Math.ceil((8 * payloadBytes + CRC_BITS) / k), { n } = hammingLayout(k), wire = blocks * n;
  const pFail = 1 - blockOk(n, p) ** blocks;
  return { name: `SEC-DED(${n},${k}) + CRC + retransmit`, payload: 8 * payloadBytes, wire, pFail, goodput: ((8 * payloadBytes) / wire) * (1 - pFail) };
}

/**
 * Mean time to deliver one frame (seconds): sending it, the one-way delay, plus for every failed try (geometric,
 * p/(1 - p) of them on average) a send time and a round trip before the repeat.
 */
export function deliveryTime(wireBits: number, pFail: number, bitRate: number, oneWay: number): number {
  const t = wireBits / bitRate;
  return t + oneWay + (pFail / (1 - pFail)) * (t + 2 * oneWay);
}

/** The bit error rate at which the second scheme's goodput first exceeds the first's (log-bisected between lo and hi), or null. */
export function crossover(payloadBytes: number, lo = 1e-9, hi = 1e-2, k = 64): number | null {
  const f = (p: number) => secdedCrc(payloadBytes, p, k).goodput - crcOnly(payloadBytes, p).goodput;
  if (f(lo) > 0 || f(hi) < 0) return null;
  let a = Math.log(lo), b = Math.log(hi);
  for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if (f(Math.exp(m)) < 0) a = m; else b = m; }
  return Math.exp((a + b) / 2);
}

/** The bit error rate at which the second scheme delivers a frame sooner than the first, at this rate and delay. */
export function crossoverTime(payloadBytes: number, bitRate: number, oneWay: number, lo = 1e-9, hi = 1e-2, k = 64): number | null {
  const f = (p: number) => { const a = crcOnly(payloadBytes, p), b = secdedCrc(payloadBytes, p, k); return deliveryTime(b.wire, b.pFail, bitRate, oneWay) - deliveryTime(a.wire, a.pFail, bitRate, oneWay); };
  if (f(lo) < 0 || f(hi) > 0) return null;
  let a = Math.log(lo), b = Math.log(hi);
  for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if (f(Math.exp(m)) > 0) a = m; else b = m; }
  return Math.exp((a + b) / 2);
}

// ---- simulation -------------------------------------------------------------------------------------------------------

export interface Trial { frames: number; rejected: number; corrected: number; viaCrc: number }

/**
 * Run `frames` frames of random payload through the scheme: encode (SEC-DED blocks, or none), flip each wire bit with
 * probability p, decode, and reject when a block reports two errors. The CRC is taken as perfect (a miss is 2^-32), so
 * a frame whose data differs although no block gave up (three errors in a block, miscorrected) is rejected by it too;
 * `viaCrc` counts those.
 */
export function trial(secded: boolean, payloadBytes: number, p: number, frames: number, seed = 1, k = 64): Trial {
  const u = rng(seed), bitsTotal = 8 * payloadBytes + CRC_BITS;
  const res: Trial = { frames, rejected: 0, corrected: 0, viaCrc: 0 };
  for (let f = 0; f < frames; f++) {
    const data = Array.from({ length: bitsTotal }, () => (u() < 0.5 ? 1 : 0));
    let reject = false, wrong = false, fixed = 0;
    if (!secded) {
      for (let i = 0; i < bitsTotal; i++) if (u() < p) reject = true;
    } else {
      for (let off = 0; off < bitsTotal; off += k) {
        const blk = data.slice(off, off + k);
        while (blk.length < k) blk.push(0);
        const cw = secdedEncode(blk);
        let errs = 0;
        for (let i = 0; i < cw.length; i++) if (u() < p) { cw[i] ^= 1; errs++; }
        if (!errs) continue;
        const dec = secdedDecode(cw, k);
        if (dec.double) { reject = true; continue; }
        if (dec.data.some((v, i) => v !== blk[i])) wrong = true; else fixed++;
      }
    }
    if (wrong && !reject) { res.viaCrc++; reject = true; }
    if (reject) res.rejected++;
    else res.corrected += fixed;
  }
  return res;
}
