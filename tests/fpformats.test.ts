// Chapter 24's formats beyond float32: the pinned cost table equals a fresh measurement, float32's units are the numbers
// the chapter quotes, and the new small formats (bfloat16, E5M2) and float64 compute what the reference does.
import { describe, expect, it } from 'vitest';
import { FPU32, fpAdd, fpFma, fpMul } from '../src/lib';
import { FORMAT_COSTS, FORMAT_LIST, formatRange } from '../src/lib/fpformatcosts';
import { type FpFormat } from '../src/sim/fpref';
import { GateSim } from '../src/sim/gatesim';
import { flatten } from '../src/sim/flatten';
import { logicDepth, stats } from '../src/sim/stats';
import { check } from './fptest';
import { tick } from './yieldtick';

const F64: FpFormat = { E: 11, M: 52 };

describe('format costs are pinned', () => {
  for (const { id, f } of FORMAT_LIST) {
    it(`${id}: adder, multiplier and fma measure what the table says`, async () => {
      const add = fpAdd(f), mul = fpMul(f), fma = fpFma(f), c = FORMAT_COSTS[id];
      expect({ nands: stats(add).nands, depth: logicDepth(add) }).toEqual(c.add);
      const ins = mul.netlist!().instances;
      const tree = stats(ins.find((i) => /multiplier/.test(i.def.name))!.def).nands, round = stats(ins.find((i) => /Normalize/.test(i.def.name))!.def).nands;
      expect({ nands: stats(mul).nands, depth: logicDepth(mul), tree, round }).toEqual(c.mul);
      await tick();
      expect({ nands: stats(fma).nands, depth: logicDepth(fma) }).toEqual(c.fma);
    }, 60000);
  }
  it('float32 is untouched: the numbers chapter 24 quotes', () => {
    expect(FORMAT_COSTS.f32.add).toEqual({ nands: 8218, depth: 181 });
    expect(FORMAT_COSTS.f32.mul).toMatchObject({ nands: 14913, depth: 176 });
    expect(FORMAT_COSTS.f32.fma).toEqual({ nands: 26348, depth: 270 });
    expect(Math.round(stats(FPU32).nands / 100) * 100).toBe(85200);
  });
  it('ranges', () => {
    expect(formatRange({ E: 5, M: 10 }).max).toBe(65504);
    expect(formatRange({ E: 4, M: 3 }).max).toBe(240);
    expect(formatRange({ E: 5, M: 2 }).max).toBe(57344);
    expect(formatRange({ E: 11, M: 52 })).toMatchObject({ max: Number.MAX_VALUE, minNormal: 2 ** -1022, minSub: Number.MIN_VALUE });
    expect(formatRange({ E: 8, M: 7 }).max).toBeCloseTo(3.3895313892515355e38, -20);
  });
});

describe('the new formats compute what the reference does', () => {
  for (const f of [{ E: 8, M: 7 }, { E: 5, M: 2 }] as FpFormat[]) {
    it(`E${f.E}M${f.M}: add, mul and fma on random operands, every rounding mode`, async () => {
      const N = 1 + f.E + f.M;
      let seed = 12345;
      const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return (seed >>> 7) % 2 ** N; };
      const v = Array.from({ length: 2400 }, (_, i) => [rnd(), rnd(), rnd(), i & 1, i % 5]);
      await check(fpAdd(f), v.map(([a, b, , s, m]) => [a, b, s, m]));
      await check(fpMul(f), v.map(([a, b, , , m]) => [a, b, m]));
      await check(fpFma(f), v.map(([a, b, c, s, m]) => [a, b, c, s, 0, m]));
    }, 120000);
  }
  it('float64: add and mul match the host double (nearest even), bit for bit', () => {
    const dv = new DataView(new ArrayBuffer(8));
    const bitsOf = (x: number) => { dv.setFloat64(0, x); const v = dv.getBigUint64(0); return Array.from({ length: 64 }, (_, i) => Number((v >> BigInt(i)) & 1n)); };
    const valOf = (b: ArrayLike<number>) => { let v = 0n; for (let i = 63; i >= 0; i--) v = (v << 1n) | BigInt(b[i]); dv.setBigUint64(0, v); return dv.getFloat64(0); };
    const ops: [number, number][] = [[1.5, 2.25], [0.1, 0.2], [1e308, 1e308], [5e-324, 5e-324], [3, -3], [1 / 3, 3], [2 ** 52 + 1, 0.5], [-7.25e-200, 1.1e-150], [1e-300, 1e-300], [123456789.123456789, 987654321.987654321]];
    for (const [name, def, op] of [['add', fpAdd(F64), (a: number, b: number) => a + b], ['mul', fpMul(F64), (a: number, b: number) => a * b]] as const) {
      const d = flatten(def), sim = new GateSim(d);
      for (const [a, b] of ops) {
        sim.setInputBits('a', bitsOf(a)); sim.setInputBits('b', bitsOf(b));
        if (name === 'add') sim.setInput('sub', 0);
        sim.setInput('rm', 0);
        sim.settle();
        const got = valOf(sim.getBits(d.root.ports.y));
        expect(Object.is(got, op(a, b)), `${name} ${a} ${b}: ${got} vs ${op(a, b)}`).toBe(true);
      }
    }
  }, 120000);
});
