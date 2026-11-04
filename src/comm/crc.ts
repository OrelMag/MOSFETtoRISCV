// Cyclic redundancy checks, DOM-free: the golden model the CRC gates (lib/crc.ts) are compared with every cycle, and
// the polynomial arithmetic behind the chapter's numbers. A CRC is the remainder of the message, read as a polynomial
// over GF(2), divided by a generator. Two orders exist: MSB first (the textbook division, `polyRem`) and the
// reflected form Ethernet, zlib and PNG use, where bits go out least significant first and the register shifts right.
// The reflected CRC-32 is checked against Node's zlib.crc32 (tests/comm-crc.test.ts).

/** CRC-32 (IEEE 802.3) generator x^32 + x^26 + x^23 + … + x + 1: MSB-first and bit-reversed. */
export const CRC32_POLY = 0x04c11db7;
export const CRC32_REFLECTED = 0xedb88320;
/** The register after a good frame: a message followed by its own FCS leaves the (uncomplemented) register here. */
export const CRC32_RESIDUE = 0xdebb20e3;

export const CRC32_INIT = 0xffffffff;

/** One step of the reflected register: shift right, and if the bit coming out XOR the input bit is 1, XOR the generator in. */
export function stepBit(q: number, d: number, poly = CRC32_REFLECTED, n = 32): number {
  const fb = (q ^ d) & 1;
  const top = n === 32 ? 0xffffffff : 2 ** n - 1;
  return (((q >>> 1) ^ (fb ? poly : 0)) & top) >>> 0;
}

/** `w` bits at once (d's bit 0 first), as w serial steps. */
export function stepBits(q: number, d: number, w: number, poly = CRC32_REFLECTED, n = 32): number {
  let r = q >>> 0;
  for (let i = 0; i < w; i++) r = stepBit(r, (d >>> i) & 1, poly, n);
  return r;
}

/** The byte table of the software implementation: 256 entries of eight serial steps from a register holding the byte. */
export const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) t[i] = stepBits(i, 0, 8);
  return t;
})();

/** The register after the bytes (a table lookup a byte: the same function as eight serial steps). */
export function crc32Register(bytes: ArrayLike<number>, q = CRC32_INIT): number {
  let r = q >>> 0;
  for (let i = 0; i < bytes.length; i++) r = ((r >>> 8) ^ CRC32_TABLE[(r ^ bytes[i]) & 0xff]) >>> 0;
  return r;
}

/** The CRC-32 of a byte string as zlib, Ethernet and PNG define it: initial all ones, final complement. */
export const crc32 = (bytes: ArrayLike<number>): number => (~crc32Register(bytes) >>> 0);

/** The FCS as it is sent: the four bytes of the CRC, least significant byte first (Ethernet). */
export const fcsBytes = (crc: number): number[] => [crc & 0xff, (crc >>> 8) & 0xff, (crc >>> 16) & 0xff, (crc >>> 24) & 0xff];

/** The bits of a byte string in transmission order for the reflected form: each byte least significant bit first. */
export function bitsLsb(bytes: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) for (let b = 0; b < 8; b++) out.push((bytes[i] >>> b) & 1);
  return out;
}

/** The register after serial bits: what the one-bit-a-clock circuit holds. */
export function crc32Serial(bits: ArrayLike<number>, q = CRC32_INIT): number {
  let r = q >>> 0;
  for (let i = 0; i < bits.length; i++) r = stepBit(r, bits[i]);
  return r;
}

// ---- the same arithmetic as polynomial division -------------------------------------------------------------------------

/** Remainder of the message polynomial times x^width, the bits MSB first, divided by the generator `poly` (without its x^width term): the shift register that takes the bits in directly. */
export function polyRem(bits: ArrayLike<number>, poly: number, width: number): number {
  let r = 0;
  const top = 2 ** (width - 1);
  for (let i = 0; i < bits.length; i++) {
    const fb = (r >= top ? 1 : 0) ^ bits[i];
    r = (r % top) * 2;
    if (fb) r = (r ^ poly) >>> 0;
  }
  return r >>> 0;
}

export interface CrcSpec { name: string; width: number; poly: number }
export const CRC8: CrcSpec = { name: 'CRC-8 (ATM HEC)', width: 8, poly: 0x07 };
export const CRC16: CrcSpec = { name: 'CRC-16-CCITT', width: 16, poly: 0x1021 };
export const CRC32: CrcSpec = { name: 'CRC-32 (IEEE 802.3)', width: 32, poly: CRC32_POLY };

/** The data bits (MSB first) of a k-bit word. */
export const wordBits = (d: number, k: number): number[] => Array.from({ length: k }, (_, i) => (d >>> (k - 1 - i)) & 1);

/** The remainder to append after the k data bits of `d` (systematic code). */
export const crcOf = (d: number, k: number, c: CrcSpec): number => polyRem(wordBits(d, k), c.poly, c.width);

/** The codeword d·x^width + crc as an integer of k + width bits. */
export const codeword = (d: number, k: number, c: CrcSpec): number => d * 2 ** c.width + crcOf(d, k, c);

/** Does a received word (k data bits + width check bits) pass? */
export function passes(word: number, k: number, c: CrcSpec): boolean {
  return polyRem(wordBits(word, k + c.width), c.poly, c.width) === 0;
}

/**
 * Weight distribution of the code: A[w] = how many codewords have w ones. A linear code detects an error pattern unless
 * the pattern is itself a codeword, so the number of undetected patterns of weight w is A[w] (for w ≥ 1).
 */
export function weightDistribution(k: number, c: CrcSpec): number[] {
  const n = k + c.width, A = new Array<number>(n + 1).fill(0);
  for (let d = 0; d < 2 ** k; d++) {
    let x = codeword(d, k, c), w = 0;
    while (x > 0) { w += x % 2; x = Math.floor(x / 2); }
    A[w]++;
  }
  return A;
}

/** Weight distribution of the single parity code: n = k + 1 bits, all even-weight words. */
export function parityWeights(k: number): number[] {
  const n = k + 1, A = new Array<number>(n + 1).fill(0);
  let c = 1;
  for (let w = 0; w <= n; w += 2) { A[w] = c; c = (c * (n - w) * (n - w - 1)) / ((w + 1) * (w + 2)); }
  return A;
}

/** Probability that a binary symmetric channel with bit error rate p turns a codeword into a different codeword. */
export function undetected(A: number[], p: number): number {
  const n = A.length - 1;
  let s = 0;
  for (let w = 1; w <= n; w++) if (A[w]) s += A[w] * p ** w * (1 - p) ** (n - w);
  return s;
}

/** Closed form for single parity over n bits: (1 + (1 − 2p)^n) / 2 − (1 − p)^n. */
export const parityUndetected = (n: number, p: number): number => (1 + (1 - 2 * p) ** n) / 2 - (1 - p) ** n;

/** The shortest burst (first to last bit flipped, inclusive) the code can miss: its generator's width + 1 is the first miss. */
export const burstGuarantee = (c: CrcSpec): number => c.width;

// ---- the byte-wide next-state matrix -----------------------------------------------------------------------------------

/**
 * The next state of the register is linear in (q, d): bit i of the next state is the XOR of the state bits and data bits
 * whose unit vectors set it. Returned as one mask per output bit over the n + w inputs (state bits 0..n-1, then data bits).
 * The gates (lib/crc.ts) are built from exactly this matrix.
 */
export function nextMatrix(n: number, poly: number, w: number): bigint[] {
  const rows: bigint[] = new Array<bigint>(n).fill(0n);
  for (let j = 0; j < n + w; j++) {
    const q = j < n ? 2 ** j : 0, d = j < n ? 0 : 2 ** (j - n);
    const next = stepBits(q, d, w, poly, n);
    for (let i = 0; i < n; i++) if (Math.floor(next / 2 ** i) % 2) rows[i] |= 1n << BigInt(j);
  }
  return rows;
}

/** Terms of a mask. */
export const termsOf = (m: bigint): number[] => { const t: number[] = []; for (let j = 0; m >> BigInt(j); j++) if ((m >> BigInt(j)) & 1n) t.push(j); return t; };

export interface XorPlan {
  /** Node ids 0 … inputs-1 are the inputs; node inputs + k is pairs[k] = a XOR b. */
  pairs: [number, number][];
  /** Per output, the node holding it (an input when the output is a single term; -1 for a constant 0). */
  out: number[];
  /** XOR2 gates and levels of the deepest output. */
  gates: number;
  depth: number;
}

/**
 * XOR trees for the rows: each row a balanced tree of its terms (`share` false), or with the most common pair of terms
 * first factored out of every row that holds it, until no pair is shared (`share` true): fewer gates, and a pair shared
 * by rows of different depth can deepen one of them.
 */
export function xorPlan(rows: bigint[], inputs: number, share: boolean): XorPlan {
  const sets = rows.map((m) => new Set(termsOf(m)));
  const pairs: [number, number][] = [];
  const level: number[] = new Array<number>(inputs).fill(0);
  const make = (a: number, b: number): number => {
    const id = inputs + pairs.length;
    pairs.push([a, b]);
    level[id] = Math.max(level[a], level[b]) + 1;
    return id;
  };
  if (share) {
    for (;;) {
      const count = new Map<string, number>();
      for (const s of sets) {
        const t = [...s].sort((a, b) => a - b);
        for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) { const k = `${t[i]},${t[j]}`; count.set(k, (count.get(k) ?? 0) + 1); }
      }
      let best = '', bc = 1;
      for (const [k, c] of count) if (c > bc) { best = k; bc = c; }
      if (bc < 2) break;
      const [a, b] = best.split(',').map(Number), id = make(a, b);
      for (const s of sets) if (s.has(a) && s.has(b)) { s.delete(a); s.delete(b); s.add(id); }
    }
  }
  const out = sets.map((s) => {
    // combine the two shallowest terms first: a balanced tree for the row
    const t = [...s];
    if (!t.length) return -1;
    while (t.length > 1) {
      t.sort((x, y) => level[x] - level[y] || x - y);
      const a = t.shift()!, b = t.shift()!;
      t.push(make(a, b));
    }
    return t[0];
  });
  return { pairs, out, gates: pairs.length, depth: Math.max(...out.map((o) => (o < 0 ? 0 : level[o]))) };
}

/** Evaluate a plan on input bits (inputs as a bigint). */
export function evalPlan(p: XorPlan, inputs: number, x: bigint): bigint {
  const v: number[] = [];
  for (let i = 0; i < inputs; i++) v.push(Number((x >> BigInt(i)) & 1n));
  for (const [a, b] of p.pairs) v.push(v[a] ^ v[b]);
  let r = 0n;
  p.out.forEach((o, i) => { if (o >= 0 && v[o]) r |= 1n << BigInt(i); });
  return r;
}
