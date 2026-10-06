import { describe, expect, it } from 'vitest';
import { F32, FLAG, RM, bitsToF32, f32ToBits, fpAddRef, fpAddX, fpFromIntRef, fpMulRef, fpMulX, fpToIntX, fpValue } from '../src/sim/fpref';

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

describe('rounding modes: the reference obeys their definitions', () => {
  // E4M3: every sum, difference and product is exact in a double, so it can be compared directly.
  const f = { E: 4, M: 3 }, emaxNext = 2 ** 8; // ∞ stands for 2^(emax + 1) when measuring distance
  const val = (y: number) => { const v = fpValue(y, f); return Math.abs(v) === Infinity ? Math.sign(v) * emaxNext : v; };
  it('RDN ≤ exact ≤ RUP; RTZ, RNE and RMM pick the right neighbour; NX iff inexact', () => {
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
      const A = fpValue(a, f), B = fpValue(b, f);
      for (const [exact, r] of [[A + B, (rm: number) => fpAddX(a, b, false, f, rm)], [A * B, (rm: number) => fpMulX(a, b, f, rm)]] as const) {
        if (!Number.isFinite(exact) || exact === 0 || Math.abs(exact) >= emaxNext) continue; // (beyond 2^8: overflow in every mode)
        const res = [0, 1, 2, 3, 4].map(r), v = res.map((x) => val(x.y));
        const [ne, tz, dn, up, mm] = v;
        if (!(res[0].fl & FLAG.NX)) {
          expect(v.every((x) => x === exact), `${a} ${b}`).toBe(true);
          continue;
        }
        expect(dn < exact && exact < up, `${a} ${b}: ${dn} < ${exact} < ${up}`).toBe(true);
        expect(res.every((x) => x.fl & FLAG.NX)).toBe(true);
        expect(tz).toBe(Math.abs(dn) < Math.abs(up) ? dn : up);
        const dd = exact - dn, du = up - exact;
        const even = (res[2].y & 1) === 0 ? dn : up;
        expect(ne, `${a} ${b} RNE`).toBe(dd < du ? dn : du < dd ? up : even);
        expect(mm, `${a} ${b} RMM`).toBe(dd < du ? dn : du < dd ? up : Math.abs(dn) > Math.abs(up) ? dn : up);
        // underflow: only for results below the smallest normal (2^-6)
        if (res[0].fl & FLAG.UF) expect(Math.abs(exact)).toBeLessThan(2 ** -6);
      }
    }
  }, 60000);
  it('float → int saturates and flags like the RISC-V table', () => {
    const F = F32;
    expect(fpToIntX(0x7fc00000, true, F)).toEqual({ y: 0x7fffffff, fl: FLAG.NV });
    expect(fpToIntX(0xff800000, true, F)).toEqual({ y: 0x80000000, fl: FLAG.NV });
    expect(fpToIntX(0xcf000000, true, F)).toEqual({ y: 0x80000000, fl: 0 }); // −2^31 fits exactly
    expect(fpToIntX(0x4f000000, true, F)).toEqual({ y: 0x7fffffff, fl: FLAG.NV }); // 2^31 does not
    expect(fpToIntX(0xbf800000, false, F)).toEqual({ y: 0, fl: FLAG.NV }); // −1 → unsigned
    expect(fpToIntX(0xbe800000, false, F)).toEqual({ y: 0, fl: FLAG.NX }); // −0.25 rounds to 0: fine
    expect(fpToIntX(0xbf400000, false, F, RM.RDN)).toEqual({ y: 0, fl: FLAG.NV }); // −0.75 rounds to −1
    expect(fpToIntX(0x7fc00000, false, F)).toEqual({ y: 0xffffffff, fl: FLAG.NV });
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
