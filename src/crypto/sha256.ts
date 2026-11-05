// SHA-256 (FIPS 180-4), the golden model for lib/sha256.ts and the chapter's widgets. DOM-free.
// The constants are computed, not typed: K[t] is the first 32 bits of the fractional part of the cube root of the t-th prime,
// H0 the same for the square roots of the first eight (FIPS 180-4 §4.2.2, §5.3.3). Words are unsigned 32-bit numbers.

const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;
const add = (...xs: number[]) => xs.reduce((a, b) => (a + b) >>> 0, 0);

export const ch = (e: number, f: number, g: number): number => ((e & f) ^ (~e & g)) >>> 0;
export const maj = (a: number, b: number, c: number): number => ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
export const bigSigma0 = (x: number): number => (rotr(x, 2) ^ rotr(x, 13) ^ rotr(x, 22)) >>> 0;
export const bigSigma1 = (x: number): number => (rotr(x, 6) ^ rotr(x, 11) ^ rotr(x, 25)) >>> 0;
export const smallSigma0 = (x: number): number => (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
export const smallSigma1 = (x: number): number => (rotr(x, 17) ^ rotr(x, 19) ^ (x >>> 10)) >>> 0;

/** ⌊n^(1/k)⌋ for BigInt n, by Newton's method on integers. */
function iroot(n: bigint, k: bigint): bigint {
  let x = 1n << (BigInt(n.toString(2).length) / k + 1n);
  for (;;) {
    const y = ((k - 1n) * x + n / x ** (k - 1n)) / k;
    if (y >= x) return x;
    x = y;
  }
}
export const PRIMES: readonly number[] = (() => { const p: number[] = []; for (let n = 2; p.length < 64; n++) if (p.every((q) => n % q)) p.push(n); return p; })();
const frac32 = (p: number, k: bigint) => Number(iroot(BigInt(p) << (32n * k), k) & 0xffffffffn);
/** The 64 round constants: fractional cube roots of the first 64 primes. */
export const K: readonly number[] = PRIMES.map((p) => frac32(p, 3n));
/** The initial hash value: fractional square roots of the first 8 primes. */
export const H0: readonly number[] = PRIMES.slice(0, 8).map((p) => frac32(p, 2n));

/** The message schedule of a 16-word block (FIPS 180-4 §6.2.2 step 1). */
export function schedule(block: number[]): number[] {
  const w = block.slice();
  for (let t = 16; t < 64; t++) w[t] = add(smallSigma1(w[t - 2]), w[t - 7], smallSigma0(w[t - 15]), w[t - 16]);
  return w;
}

/** One round on the working variables [a..h] with this round's K and W. */
export function roundStep(v: number[], k: number, w: number): number[] {
  const [a, b, c, d, e, f, g, h] = v;
  const t1 = add(h, bigSigma1(e), ch(e, f, g), k, w), t2 = add(bigSigma0(a), maj(a, b, c));
  return [add(t1, t2), a, b, c, add(d, t1), e, f, g];
}

export interface ShaRound { t: number; k: number; w: number; t1: number; t2: number; vars: number[] }
export interface ShaTrace { w: number[]; rounds: ShaRound[]; before: number[]; out: number[] }

/** Compress one block into the chaining value, keeping every round's a..h and the schedule. */
export function compressTrace(h: readonly number[], block: number[]): ShaTrace {
  const w = schedule(block);
  let v = h.slice();
  const rounds: ShaRound[] = [];
  for (let t = 0; t < 64; t++) {
    const [a, , , , e, f, g, hh] = v;
    const t1 = add(hh, bigSigma1(e), ch(e, f, g), K[t], w[t]), t2 = add(bigSigma0(a), maj(a, v[1], v[2]));
    v = roundStep(v, K[t], w[t]);
    rounds.push({ t, k: K[t], w: w[t], t1, t2, vars: v });
  }
  return { w, rounds, before: h.slice(), out: h.map((x, i) => add(x, v[i])) };
}
export const compress = (h: readonly number[], block: number[]): number[] => compressTrace(h, block).out;

/** The padded message as 16-word blocks (a 1 bit, zeros, the length in bits as 64 bits). */
export function blocksOf(msg: ArrayLike<number>): number[][] {
  const n = msg.length, bytes = Array.from(msg);
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const bits = BigInt(n) * 8n;
  for (let i = 7; i >= 0; i--) bytes.push(Number((bits >> BigInt(8 * i)) & 0xffn));
  const blocks: number[][] = [];
  for (let o = 0; o < bytes.length; o += 64) blocks.push(Array.from({ length: 16 }, (_, i) => ((bytes[o + 4 * i] << 24) | (bytes[o + 4 * i + 1] << 16) | (bytes[o + 4 * i + 2] << 8) | bytes[o + 4 * i + 3]) >>> 0));
  return blocks;
}

export function sha256Words(msg: ArrayLike<number>): number[] {
  let h = H0.slice();
  for (const b of blocksOf(msg)) h = compress(h, b);
  return h;
}
export const sha256 = (msg: ArrayLike<number>): string => sha256Words(msg).map((x) => x.toString(16).padStart(8, '0')).join('');
export const utf8 = (s: string): number[] => Array.from(new TextEncoder().encode(s));
