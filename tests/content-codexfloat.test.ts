// The Floating point chapter's later codex entries quote numbers (codexfloat.ts, codexmorefloat.ts, codexcheckfloat.ts):
// each is recomputed here from the reference arithmetic (sim/fpref.ts) and looked up in the text.
import { describe, expect, it } from 'vitest';
import { CODEX_FLOAT, TAUGHT_FLOAT } from '../src/campaign/codexfloat';
import { MOREFLOAT } from '../src/campaign/codexmorefloat';
import { CHECKFLOAT } from '../src/campaign/codexcheckfloat';
import { NODES } from '../src/campaign/nodes';
import {
  F16, F32, FLAG, RM, bitsToF32, f32ToBits, flagNames, fpAddX, fpCmpX, fpDivX, fpMinMaxX, fpMulX, fpSqrtX, fpToIntX, fpValue,
} from '../src/sim/fpref';

const f = Math.fround, b = f32ToBits;
const all = (id: string) => {
  const e = CODEX_FLOAT.find((x) => x.id === id)!, m = MOREFLOAT[id];
  return [e.body, m.idea, m.example?.body ?? '', ...(m.mistakes ?? [])].join(' ').replace(/<[^>]+>/g, '');
};

describe('float codex', () => {
  it('has all six entries, taught at float, with two questions and a fuller text each', () => {
    expect(CODEX_FLOAT.map((e) => e.id).sort()).toEqual(['fpflags', 'fpformats', 'fpspecial', 'kahan', 'newtondiv', 'ulp']);
    for (const e of CODEX_FLOAT) {
      expect(TAUGHT_FLOAT[e.id]).toBe('float');
      expect(MOREFLOAT[e.id]?.idea.length, e.id).toBeGreaterThan(300);
      expect(CHECKFLOAT[e.id]?.length, e.id).toBe(2);
      expect(NODES.some((n) => n.codex?.includes(e.id)), `${e.id} is in a level`).toBe(true);
    }
  });
  it('special values', () => {
    expect(2 * (2 ** 23 - 1)).toBe(16777214);
    expect(all('fpspecial')).toContain('16 777 214');
    expect(fpDivX(b(1), 0x80000000, F32).y).toBe(0xff800000);
    expect(fpDivX(0, 0, F32).y).toBe(0x7fc00000);
    expect(fpAddX(0x7f800000, 0x7f800000, true, F32).y).toBe(0x7fc00000);
    expect(fpMulX(0, 0x7f800000, F32).fl).toBe(FLAG.NV);
    expect(fpSqrtX(b(-1), F32).fl).toBe(FLAG.NV);
    expect(fpSqrtX(0x80000000, F32).y).toBe(0x80000000);
    expect(fpMinMaxX(0x7fc00000, b(1), false, F32)).toEqual({ y: b(1), fl: 0 });
    expect(fpMinMaxX(0x7fa00000, b(1), false, F32)).toEqual({ y: b(1), fl: FLAG.NV });
    expect(fpMinMaxX(0x80000000, 0, false, F32).y).toBe(0x80000000);
    expect(fpMinMaxX(0x80000000, 0, true, F32).y).toBe(0);
    expect(fpAddX(b(1), b(1), true, F32).y).toBe(0);
    expect(fpAddX(b(1), b(1), true, F32, RM.RDN).y).toBe(0x80000000);
    expect(flagNames(fpCmpX(0x7fc00000, 0x7fc00000, 'eq', F32).fl)).toBe('–');
    expect(flagNames(fpCmpX(0x7fc00000, b(1), 'lt', F32).fl)).toBe('NV');
  });
  it('flags', () => {
    expect([FLAG.NX, FLAG.UF, FLAG.OF, FLAG.DZ, FLAG.NV]).toEqual([1, 2, 4, 8, 16]);
    expect(fpDivX(0x00800000, b(3), F32).fl).toBe(FLAG.UF | FLAG.NX);
    expect(fpMulX(b(1e38), b(10), F32)).toEqual({ y: 0x7f800000, fl: FLAG.OF | FLAG.NX });
    expect(fpMulX(b(1e38), b(10), F32, RM.RTZ).y).toBe(0x7f7fffff);
    expect(fpDivX(b(1), 0, F32).fl).toBe(FLAG.DZ);
    expect(fpDivX(b(1), b(3), F32).fl).toBe(FLAG.NX);
    expect(fpToIntX(b(3e9), true, F32)).toEqual({ y: 2 ** 31 - 1, fl: FLAG.NV });
  });
  it('ulp and cancellation', () => {
    expect(2 ** -23).toBeCloseTo(1.19e-7, 9);
    const ulp = (x: number) => bitsToF32(b(x) + 1) - x;
    expect(ulp(1e8)).toBe(8);
    expect(ulp(2 ** 23)).toBe(1);
    expect(ulp(2 ** 24)).toBe(2);
    const d = f(f(1 + f(1e-7)) - 1);
    expect(d).toBeCloseTo(1.19e-7, 9);
    expect(Math.abs(d - 1e-7) / 1e-7).toBeCloseTo(0.19, 2);
    let s = 0;
    for (let i = 0; i < 10; i++) s = f(s + f(0.1));
    expect(s).toBe(1 + 2 ** -23);
    expect(all('ulp')).toContain('1.0000001192');
  });
  it('kahan: 2^24 and thirty-two ones', () => {
    let naive = 2 ** 24, ks = 2 ** 24, c = 0;
    for (let i = 0; i < 32; i++) {
      naive = f(naive + 1);
      const y = f(1 - c), t = f(ks + y);
      c = f(f(t - ks) - y);
      ks = t;
    }
    expect([naive, ks]).toEqual([16777216, 16777248]);
    expect(all('kahan')).toContain('16 777 248');
    expect(all('kahan')).toContain('16 777 216');
  });
  it('formats', () => {
    expect(fpValue(14 * 8 + 7, { E: 4, M: 3 })).toBe(240);
    expect((1 + 6 / 8) * 2 ** 8).toBe(448);   // OCP E4M3: S.1111.110
    expect(fpValue(30 * 4 + 3, { E: 5, M: 2 })).toBe(57344);
    expect(fpValue(30 * 1024 + 1023, F16)).toBe(65504);
    expect(fpValue(254 * 128 + 127, { E: 8, M: 7 })).toBeCloseTo(3.39e38, -36);
    // 70 000 in bfloat16: 8 significant bits, spacing 512 in [65536, 131072)
    expect(Math.round(70000 / 512) * 512).toBe(70144);
    expect(all('fpformats')).toContain('70 144');
  });
  it('newton', () => {
    expect([0.0505, 0.0505 ** 2, 0.0505 ** 4, 0.0505 ** 8].map((e) => -Math.log2(e).valueOf()).map((x) => +x.toFixed(1))).toEqual([4.3, 8.6, 17.2, 34.5]);
    expect(0.0505 ** 2).toBeCloseTo(2.6e-3, 4);
    expect(0.0505 ** 4).toBeCloseTo(6.5e-6, 7);
    expect(0.0505 ** 8).toBeCloseTo(4.2e-11, 12);
    // the seed: 0x7EF311C7 minus the bits, worst relative error over a sweep of one binade pair
    let worst = 0;
    for (let k = 0; k < 4000; k++) {
      const v = 1 + k / 2000, x = bitsToF32(0x7ef311c7 - b(v));
      worst = Math.max(worst, Math.abs(1 - v * x));
    }
    expect(worst).toBeGreaterThan(0.045);
    expect(worst).toBeLessThan(0.0506);
  });
});
