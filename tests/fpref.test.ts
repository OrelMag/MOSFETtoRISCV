import { describe, expect, it } from 'vitest';
import { F32, bitsToF32, f32ToBits, fpAddRef, fpFromIntRef, fpMulRef } from '../src/sim/fpref';

describe('reference float arithmetic agrees with the host float32', () => {
  it('add, sub, mul and int conversion on random and special operands', () => {
    let seed = 1;
    const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
    const special = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 1, 0x807fffff, 0x00800000, 0x7f7fffff, 0x3f800000, 0xbf800000, 0x33800000, 0x4b800000];
    const pick = () => (r() % 4 === 0 ? special[r() % special.length] : ((r() >>> 8) | ((r() & 0xff) << 24)) >>> 0);
    for (let i = 0; i < 20000; i++) {
      let a = pick(), b = pick();
      if (i % 5 === 0) b = ((a & 0xff800000) | (r() & 0x7fffff)) >>> 0; // near-equal exponents: cancellation
      const A = bitsToF32(a), B = bitsToF32(b);
      expect(fpAddRef(a, b, false, F32), `${a.toString(16)} + ${b.toString(16)}`).toBe(f32ToBits(Math.fround(A + B)));
      expect(fpAddRef(a, b, true, F32), `${a.toString(16)} - ${b.toString(16)}`).toBe(f32ToBits(Math.fround(A - B)));
      expect(fpMulRef(a, b, F32), `${a.toString(16)} * ${b.toString(16)}`).toBe(f32ToBits(Math.fround(A * B)));
      const v = r();
      expect(fpFromIntRef(v, true, F32)).toBe(f32ToBits(Math.fround(v | 0)));
      expect(fpFromIntRef(v, false, F32)).toBe(f32ToBits(Math.fround(v >>> 0)));
    }
  });
});

import { encodeNumber } from '../src/widgets/float';
describe('decimal → float encoding for the explorer', () => {
  it('matches Math.fround', () => {
    let seed = 11;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let i = 0; i < 20000; i++) {
      const x = (r() - 0.5) * 10 ** Math.floor(r() * 90 - 50);
      expect(encodeNumber(x, F32), String(x)).toBe(f32ToBits(Math.fround(x)));
    }
    for (const x of [0, -0, 0.1, 1e-45, 1.4e-45, 3.4028235e38, 3.5e38, Infinity, -Infinity, NaN]) expect(encodeNumber(x, F32), String(x)).toBe(f32ToBits(Math.fround(x)));
  });
});
