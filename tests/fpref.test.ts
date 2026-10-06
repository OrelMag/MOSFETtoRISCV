import { describe, expect, it } from 'vitest';
import { F32, FLAG, RM, bitsToF32, f32ToBits, fpAddRef, fpAddX, fpDivX, fpFmaX, fpFromIntRef, fpMulRef, fpMulX, fpSqrtX, fpToIntX, fpValue } from '../src/sim/fpref';

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
  /** One exact value and its five roundings: check each mode against its definition. */
  function checkModes(label: string, exact: number, r: (rm: number) => { y: number; fl: number }): void {
    if (!Number.isFinite(exact) || exact === 0 || Math.abs(exact) >= emaxNext) return; // (beyond 2^8: overflow in every mode)
    const res = [0, 1, 2, 3, 4].map(r), v = res.map((x) => val(x.y));
    const [ne, tz, dn, up, mm] = v;
    if (!(res[0].fl & FLAG.NX)) {
      if (!v.every((x) => x === exact)) expect(v, label).toEqual(v.map(() => exact));
      return;
    }
    if (!(dn < exact && exact < up)) expect(false, `${label}: ${dn} < ${exact} < ${up}`).toBe(true);
    expect(res.every((x) => x.fl & FLAG.NX)).toBe(true);
    expect(tz).toBe(Math.abs(dn) < Math.abs(up) ? dn : up);
    const dd = exact - dn, du = up - exact;
    const even = (res[2].y & 1) === 0 ? dn : up;
    expect(ne, `${label} RNE`).toBe(dd < du ? dn : du < dd ? up : even);
    expect(mm, `${label} RMM`).toBe(dd < du ? dn : du < dd ? up : Math.abs(dn) > Math.abs(up) ? dn : up);
    // underflow: only for results below the smallest normal (2^-6)
    if (res[0].fl & FLAG.UF) expect(Math.abs(exact)).toBeLessThan(2 ** -6);
  }
  it('RDN ≤ exact ≤ RUP; RTZ, RNE and RMM pick the right neighbour; NX iff inexact', () => {
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
      const A = fpValue(a, f), B = fpValue(b, f);
      checkModes(`${a} + ${b}`, A + B, (rm) => fpAddX(a, b, false, f, rm));
      checkModes(`${a} * ${b}`, A * B, (rm) => fpMulX(a, b, f, rm));
    }
  }, 60000);
  it('fused multiply-add rounds once', () => {
    let seed = 77;
    const r = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
    for (let i = 0; i < 60000; i++) {
      const a = r(), b = r(), c = i % 3 ? r() : (r() & 0x80) | (((a & 0x78) + (b & 0x78) - 0x38) & 0x78) | (r() & 7); // c near a × b: cancellation
      const A = fpValue(a, f), B = fpValue(b, f), C = fpValue(c, f), np = !!(i & 1), nc = !!(i & 2);
      checkModes(`fma ${a} ${b} ${c}`, (np ? -1 : 1) * A * B + (nc ? -1 : 1) * C, (rm) => fpFmaX(a, b, c, np, nc, f, rm));
    }
    // c = ±0 or a = 1.0 reduce fma to a single multiply or add
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
      expect(fpFmaX(a, b, 0x80, false, false, f, RM.RUP), `${a} ${b}`).toEqual(fpMulX(a, b, f, RM.RUP));
      expect(fpFmaX(0x38, a, b, false, true, f, RM.RDN), `${a} ${b}`).toEqual(fpAddX(a, b, true, f, RM.RDN));
    }
    expect(fpFmaX(0x7f800000, 0, 0x7fc00000, false, false, F32)).toEqual({ y: 0x7fc00000, fl: FLAG.NV }); // ∞ × 0 + qNaN: NV
    expect(fpFmaX(0x7f800000, 0x3f800000, 0x7f800000, false, true, F32)).toEqual({ y: 0x7fc00000, fl: FLAG.NV }); // ∞ − ∞
  }, 60000);
  it('division and square root agree with the host (RNE) and bracket the exact value (RDN / RUP)', () => {
    let seed = 5;
    const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
    const special = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 1, 0x00800000, 0x7f7fffff, 0x3f800000, 0xbf800000, 0x40400000];
    const pick = () => (r() % 5 === 0 ? special[r() % special.length] : ((r() >>> 8) | ((r() & 0xff) << 24)) >>> 0);
    for (let i = 0; i < 20000; i++) {
      const a = pick(), b = pick(), A = bitsToF32(a), B = bitsToF32(b);
      expect(fpDivX(a, b, F32).y, `${a.toString(16)} / ${b.toString(16)}`).toBe(f32ToBits(Math.fround(A / B)));
      expect(fpSqrtX(a, F32).y, `sqrt ${a.toString(16)}`).toBe(f32ToBits(Math.fround(Math.sqrt(A))));
      // a double holds the quotient to 53 bits: enough to know which float32 neighbours bracket it
      const dn = fpValue(fpDivX(a, b, F32, RM.RDN).y, F32), up = fpValue(fpDivX(a, b, F32, RM.RUP).y, F32), q = A / B;
      if (Number.isFinite(q) && q !== 0 && Math.abs(q) < 3e38 && Math.abs(q) > 1e-37) {
        const nx = fpDivX(a, b, F32).fl & FLAG.NX;
        expect(nx ? dn < q && q < up : dn === q && up === q, `${A} / ${B}`).toBe(true);
      }
    }
    expect(fpDivX(0x3f800000, 0, F32)).toEqual({ y: 0x7f800000, fl: FLAG.DZ });
    expect(fpDivX(0, 0, F32)).toEqual({ y: 0x7fc00000, fl: FLAG.NV });
    expect(fpSqrtX(0x80000000, F32)).toEqual({ y: 0x80000000, fl: 0 });
    expect(fpSqrtX(0xbf800000, F32)).toEqual({ y: 0x7fc00000, fl: FLAG.NV });
    expect(fpSqrtX(0x40000000, F32, RM.RUP)).toEqual({ y: 0x3fb504f4, fl: FLAG.NX }); // √2 rounded up
  });
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
