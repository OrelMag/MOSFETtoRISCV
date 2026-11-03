import { describe, expect, it } from 'vitest';
import { fpAdd, fpAddNearFar, lza } from '../src/lib';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { F32, type FpFormat } from '../src/sim/fpref';
import { evalOnce, simulate } from '../src/sim/harness';
import { check, isExhaustive, operandPairs } from './fptest';

const E4M3: FpFormat = { E: 4, M: 3 }, E3M2: FpFormat = { E: 3, M: 2 };
const MODES = [0, 1, 2, 3, 4, 5, 7];

describe('lza', () => {
  it('the anticipator is within one place of the true count (A ≥ B, exhaustive at 6 bits)', () => {
    const n = 6, s = simulate(lza(n));
    for (let a = 0; a < 2 ** n; a++) for (let b = 0; b <= a; b++) {
      const [c] = evalOnce(s, [a, b]);
      expect(c).toEqual(lza(n).spec!([a, b])[0]);
      if (a !== b) { const lz = n - 1 - Math.floor(Math.log2(a - b)); expect([lz, lz - 1]).toContain(c); }
    }
  });
});

describe('near / far adder', () => {
  for (const f of [E3M2, E4M3]) {
    it(`E${f.E}M${f.M}: add and sub, every rounding mode and flag (${isExhaustive(f) ? 'every pair' : 'boundary values × every operand, plus a sample'})`, async () => {
      const pairs = operandPairs(f), n = pairs.length;
      await check(fpAddNearFar(f), { count: 2 * n * MODES.length, gen: (i) => { const [a, b] = pairs[(i >> 1) % n]; return [a, b, i & 1, MODES[Math.floor(i / (2 * n))]]; } });
    }, 180000);
  }
});

describe('near / far adder: wider formats', () => {
  let seed = 11;
  const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  /** Operands biased to the interesting regions: equal or adjacent exponents (the near path), deep cancellation, subnormals, the top of the range. */
  function vectors(f: FpFormat, n: number): number[][] {
    const N = 1 + f.E + f.M, mant = 2 ** f.M, top = 2 ** f.E - 1;
    const word = (s: number, e: number, m: number) => s * 2 ** (N - 1) + e * mant + m;
    const frac = () => (r() >>> 4) % mant;
    const out: number[][] = [];
    for (let i = 0; i < n; i++) {
      const s = r() & 1, e = 1 + (r() % (top - 1)), a = word(s, e, frac());
      let b: number;
      switch (i % 8) {
        case 0: b = word(r() & 1, e, frac()); break; // equal exponents
        case 1: b = word(r() & 1, e + 1 <= top - 1 ? e + 1 : e, frac()); break; // one apart
        case 2: b = word(r() & 1, e - 1, frac()); break;
        case 3: b = word(s ^ 1, e, (a % mant) ^ (1 << (r() % f.M))); break; // a − a', one bit apart: deep cancellation
        case 4: b = word(r() & 1, r() % 3, frac()); break; // subnormal / smallest normals
        case 5: b = word(r() & 1, Math.max(0, e - 2 - (r() % 6)), frac()); break; // far, small exponent difference
        case 6: b = word(r() & 1, top - 1 - (r() % 2), frac()); break; // near overflow
        default: b = (r() >>> 3) % 2 ** N; // anything, specials included
      }
      out.push([a, b, r() & 1, r() % 5]);
    }
    return out;
  }
  for (const f of [{ E: 5, M: 10 }, F32]) {
    it(`${f.E === 8 ? 'float32' : 'binary16'}: biased random operands, every mode and flag`, async () => {
      await check(fpAddNearFar(f), vectors(f, 20000));
    }, 120000);
  }
  it('E5M2 and E3M4 (other aspect ratios)', async () => {
    for (const f of [{ E: 5, M: 2 }, { E: 3, M: 4 }]) await check(fpAddNearFar(f), vectors(f, 20000));
  }, 120000);
});

describe('near / far adder: cost and depth against the single-path adder (pinned: the chapter quotes them)', () => {
  const measure = (d: ComponentDef) => ({ nands: stats(d).nands, unit: logicDepth(d)!, load: Math.round(logicDepth(d, 'load')!) });
  it('E4M3', () => {
    expect(measure(fpAdd(E4M3))).toEqual({ nands: 2553, unit: 151, load: 240 });
    expect(measure(fpAddNearFar(E4M3))).toEqual({ nands: 3270, unit: 101, load: 162 });
    expect(measure(fpAddNearFar(E4M3, false))).toEqual({ nands: 2506, unit: 111, load: 182 });
  });
  it('float32', () => {
    expect(measure(fpAdd(F32))).toEqual({ nands: 8218, unit: 181, load: 293 });
    expect(measure(fpAddNearFar(F32))).toEqual({ nands: 12170, unit: 114, load: 190 });
    // without anticipation (the count behind the subtractor): most of the depth saving stays, most of the area growth goes
    expect(measure(fpAddNearFar(F32, false))).toEqual({ nands: 8672, unit: 129, load: 221 });
  });
  it('the paths: far and near are balanced, the shared rounder is the rest', () => {
    const inst = (n: string) => fpAddNearFar(F32).netlist!().instances.find((i) => i.name === n)!.def;
    expect([stats(inst('far')).nands, logicDepth(inst('far'))]).toEqual([2365, 57]);
    expect([stats(inst('near')).nands, logicDepth(inst('near'))]).toEqual([6574, 53]);
    expect([stats(inst('rnd')).nands, logicDepth(inst('rnd'))]).toEqual([1497, 27]);
  });
});

describe('near / far adder without anticipation (the ablation the chapter quotes)', () => {
  it('is the same function: E3M2 every pair, E4M3, float32', async () => {
    for (const f of [E3M2, E4M3, F32]) {
      const pairs = f === F32 ? [] : operandPairs(f), n = pairs.length;
      if (f === F32) {
        let seed = 5;
        const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
        const v = Array.from({ length: 20000 }, (_, i) => { const a = (r() & 0xfff00000) | (r() & 0xfffff), e = (a >>> 23) & 0xff; return [a >>> 0, i % 3 ? ((a & 0x80000000 ? 0 : 0x80000000) | ((e - (i % 3 === 1 ? 0 : 1)) << 23) | (r() & 0x7fffff)) >>> 0 : r() >>> 0, i & 1, i % 5]; });
        await check(fpAddNearFar(f, false), v);
      } else await check(fpAddNearFar(f, false), { count: 2 * n * MODES.length, gen: (i) => { const [a, b] = pairs[(i >> 1) % n]; return [a, b, i & 1, MODES[Math.floor(i / (2 * n))]]; } });
    }
  }, 180000);
});
