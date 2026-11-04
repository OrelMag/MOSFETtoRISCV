// Chapter 47's golden model: the reflected CRC-32 against Node's zlib on seeded random inputs, the polynomial division
// against the register, and the closed forms behind the undetected-error figures.
import { describe, expect, it } from 'vitest';
import { crc32 as zcrc32 } from 'node:zlib';
import { bitsLsb, CRC16, CRC32, CRC32_INIT, CRC32_POLY, CRC32_REFLECTED, CRC32_RESIDUE, CRC8, crc32, crc32Register, crc32Serial, fcsBytes, nextMatrix, parityUndetected, parityWeights, passes, polyRem, codeword, stepBits, undetected, weightDistribution, wordBits, xorPlan, evalPlan } from '../src/comm/crc';
import { rng } from '../src/phys/line';

const bytesOf = (r: () => number, n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
const rev32 = (x: number) => { let r = 0; for (let i = 0; i < 32; i++) r = (r << 1) | ((x >>> i) & 1); return r >>> 0; };

describe('CRC-32', () => {
  it('equals zlib.crc32 on seeded random buffers of every small length and some long ones', () => {
    const r = rng(47);
    expect(crc32(new Uint8Array())).toBe(zcrc32(new Uint8Array()));
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    for (let n = 1; n < 80; n++) for (let k = 0; k < 4; k++) { const b = bytesOf(r, n); expect(crc32(b)).toBe(zcrc32(b)); }
    for (let k = 0; k < 20; k++) { const b = bytesOf(r, 1 + Math.floor(r() * 4000)); expect(crc32(b)).toBe(zcrc32(b)); }
  });
  it('the serial register, one bit a clock, ends where the byte table does', () => {
    const r = rng(48);
    for (let k = 0; k < 50; k++) { const b = bytesOf(r, Math.floor(r() * 40)); expect(crc32Serial(bitsLsb(b))).toBe(crc32Register(b)); }
  });
  it('the reflected generator is the bit reversal of 0x04C11DB7', () => {
    expect(rev32(CRC32_POLY)).toBe(CRC32_REFLECTED);
  });
  it('a message followed by its FCS leaves the register at the residue', () => {
    const r = rng(49);
    for (let k = 0; k < 40; k++) {
      const b = bytesOf(r, 1 + Math.floor(r() * 100)), fcs = fcsBytes(crc32(b));
      expect(crc32Register([...b, ...fcs])).toBe(CRC32_RESIDUE);
    }
  });
  it('eight serial steps are the byte step, and the next-state matrix reproduces it', () => {
    const r = rng(50), rows = nextMatrix(32, CRC32_REFLECTED, 8);
    for (let k = 0; k < 200; k++) {
      const q = Math.floor(r() * 2 ** 32) >>> 0, d = Math.floor(r() * 256);
      const x = BigInt(q) | (BigInt(d) << 32n);
      let want = 0n;
      rows.forEach((m, i) => { let v = 0n, t = m & x; while (t) { v ^= t & 1n; t >>= 1n; } if (v) want |= 1n << BigInt(i); });
      expect(Number(want)).toBe(stepBits(q, d, 8));
    }
  });
  it('the XOR plans (plain and shared) compute the matrix', () => {
    const r = rng(51), rows = nextMatrix(32, CRC32_REFLECTED, 8);
    for (const share of [false, true]) {
      const p = xorPlan(rows, 40, share);
      for (let k = 0; k < 100; k++) {
        const q = Math.floor(r() * 2 ** 32) >>> 0, d = Math.floor(r() * 256);
        expect(Number(evalPlan(p, 40, BigInt(q) | (BigInt(d) << 32n)))).toBe(stepBits(q, d, 8));
      }
    }
    expect(xorPlan(rows, 40, true).gates).toBeLessThan(xorPlan(rows, 40, false).gates);
  });
  it('starts from all ones: init 0 would miss leading zero bytes', () => {
    expect(crc32Register([0, 0], CRC32_INIT)).not.toBe(CRC32_INIT);
    expect(crc32Register([0, 0], 0)).toBe(0);
  });
});

describe('polynomial division and undetected errors', () => {
  it('MSB-first division of CRC-32 equals the reflected register on a bit-reflected message', () => {
    // the CRC of the same bits with zero init and no complement, reflected: polyRem on the message bits, bytes MSB first
    const r = rng(52);
    for (let k = 0; k < 20; k++) {
      const b = bytesOf(r, 1 + Math.floor(r() * 20));
      const msb: number[] = [];
      for (const x of b) for (let i = 7; i >= 0; i--) msb.push((rev8(x) >>> i) & 1);
      // reflected input byte bit order: LSB of the real byte is first, so the MSB-first division reads reversed bytes
      const rem = polyRem(msb, CRC32_POLY, 32);
      expect(rev32(rem)).toBe(crc32Register(b, 0));
    }
  });
  it('every single-bit error is caught by CRC-8 and CRC-16 on 16 data bits, and a codeword passes', () => {
    for (const c of [CRC8, CRC16]) {
      const w = codeword(0xbeef, 16, c);
      expect(passes(w, 16, c)).toBe(true);
      for (let i = 0; i < 16 + c.width; i++) expect(passes(w ^ (1 << i), 16, c)).toBe(false);
    }
  });
  it('weights: 2^16 codewords, no codeword lighter than the code\'s distance, bursts up to the width caught', () => {
    for (const c of [CRC8, CRC16]) {
      const A = weightDistribution(16, c), n = 16 + c.width;
      expect(A.reduce((a, b) => a + b, 0)).toBe(2 ** 16);
      expect(A[0]).toBe(1);
      expect(A[1]).toBe(0);
      // every burst of length ≤ width (first and last bit flipped, anything between) is not a codeword
      for (let len = 1; len <= c.width; len++) for (let s = 0; s + len <= n; s++)
        for (let mid = 0; mid < 2 ** Math.max(0, len - 2); mid++) {
          const burst = len === 1 ? 1 : 1 + mid * 2 + 2 ** (len - 1);
          expect(passes(burst * 2 ** s, 16, c)).toBe(false);
        }
    }
  });
  it('CRC-8 on 16 data bits detects every 1, 2 and 3 bit error, and misses a fraction near 2^-8 of the rest', () => {
    const A = weightDistribution(16, CRC8);
    expect(A[1] + A[2] + A[3]).toBe(0);
    expect(undetected(A, 0.5) * 2 ** 24).toBeCloseTo(2 ** 16 - 1, 6);
    expect((2 ** 16 - 1) / (2 ** 24 - 1)).toBeCloseTo(2 ** -8, 3);
  });
  it('parity: the weight distribution is the even binomials, and the undetected probability has a closed form', () => {
    const A = parityWeights(7);
    expect(A.reduce((a, b) => a + b, 0)).toBe(2 ** 7);
    for (const p of [1e-6, 1e-3, 0.05, 0.3]) expect(undetected(parityWeights(15), p)).toBeCloseTo(parityUndetected(16, p), 12);
    expect(undetected(weightDistribution(7, { name: 'p', width: 1, poly: 1 }), 0.01)).toBeCloseTo(parityUndetected(8, 0.01), 12);
  });
  it('the CRC-32 name list is consistent', () => {
    expect(CRC32.width).toBe(32);
    expect(wordBits(5, 4)).toEqual([0, 1, 0, 1]);
  });
});

function rev8(x: number): number { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((x >>> i) & 1); return r; }
