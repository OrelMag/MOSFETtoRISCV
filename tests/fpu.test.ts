import { describe, expect, it } from 'vitest';
import { fpAdd, fpCompare, fpFromInt, fpMul, lzc, normRound, shiftLeft, shiftRightSticky, FPU32 } from '../src/lib';
import { F32, bitsToF32, f32ToBits, fpAddRef, fpFromIntRef, fpMulRef, type FpFormat } from '../src/sim/fpref';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats, logicDepth } from '../src/sim/stats';

const small: FpFormat[] = [{ E: 4, M: 3 }, { E: 3, M: 2 }, { E: 5, M: 2 }];

describe('FPU building blocks', () => {
  it('lzc and shifters', () => {
    for (const n of [2, 4, 8, 16]) {
      const s = simulate(lzc(n));
      for (let a = 0; a < 2 ** n; a += n === 16 ? 7 : 1) expect(evalOnce(s, [a])).toEqual(lzc(n).spec!([a]));
    }
    for (const d of [shiftLeft(8, 3), shiftLeft(7, 3), shiftRightSticky(8, 3), shiftRightSticky(6, 3), shiftRightSticky(5, 4)]) {
      const s = simulate(d);
      const w = d.ports[0].width, k = d.ports[1].width;
      for (let x = 0; x < 2 ** w; x++) for (let sh = 0; sh < 2 ** k; sh++) expect(evalOnce(s, [x, sh]), `${d.id}(${x},${sh})`).toEqual(d.spec!([x, sh]));
    }
  });
});

describe('small-format FPUs, exhaustively against exact arithmetic', () => {
  for (const f of small) {
    it(`E${f.E}M${f.M}: every add, sub and mul`, async () => {
      const N = 1 + f.E + f.M;
      const add = simulate(fpAdd(f)), mul = simulate(fpMul(f));
      for (let a = 0; a < 2 ** N; a++) for (let b = 0; b < 2 ** N; b++) {
        if (b === 0 && a % 8 === 0) await new Promise((res) => setTimeout(res)); // let the test runner breathe
        expect(evalOnce(add, [a, b, 0]), `${a} + ${b}`).toEqual([fpAddRef(a, b, false, f)]);
        expect(evalOnce(add, [a, b, 1]), `${a} - ${b}`).toEqual([fpAddRef(a, b, true, f)]);
        expect(evalOnce(mul, [a, b]), `${a} * ${b}`).toEqual([fpMulRef(a, b, f)]);
      }
    }, 300000);
  }
  it('E4M3: int → float for every 8-bit integer', () => {
    const f = small[0], c = simulate(fpFromInt(f, 8));
    for (let x = 0; x < 256; x++) for (const sg of [0, 1]) expect(evalOnce(c, [x, sg]), `${x} ${sg}`).toEqual([fpFromIntRef(x, !!sg, f, 8)]);
  });
  it('E4M3: compare', () => {
    const f = small[0], c = simulate(fpCompare(f));
    for (let a = 0; a < 256; a++) for (let b = 0; b < 256; b++) {
      const A = fv(a, f), B = fv(b, f);
      expect(evalOnce(c, [a, b])).toEqual([A === B ? 1 : 0, A < B ? 1 : 0, A <= B ? 1 : 0]);
    }
  });
});

function fv(bits: number, f: FpFormat): number {
  const M = f.M, E = f.E, fr = bits % 2 ** M, e = Math.floor(bits / 2 ** M) % 2 ** E, s = bits >> (E + M);
  const b = 2 ** (E - 1) - 1;
  const v = e === 2 ** E - 1 ? (fr ? NaN : Infinity) : e === 0 ? fr * 2 ** (1 - b - M) : (fr + 2 ** M) * 2 ** (e - b - M);
  return s ? -v : v;
}

describe('float32 units', () => {
  let seed = 3;
  const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  const special = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 1, 0x807fffff, 0x00800000, 0x7f7fffff, 0x3f800000, 0xbf800000, 0x33800000, 0x4b800000];
  const pick = () => (r() % 5 === 0 ? special[r() % special.length] : ((r() >>> 8) | ((r() & 0xff) << 24)) >>> 0);
  it('fadd / fsub / fmul / fcvt agree with the host float32', async () => {
    const add = simulate(fpAdd(F32)), mul = simulate(fpMul(F32)), cvt = simulate(fpFromInt(F32));
    for (let i = 0; i < 1500; i++) {
      if (i % 50 === 0) await new Promise((res) => setTimeout(res));
      const a = pick();
      let b = pick();
      if (i % 4 === 0) b = ((a & 0xff800000) | (r() & 0x7fffff)) >>> 0;
      const A = bitsToF32(a), B = bitsToF32(b);
      expect(evalOnce(add, [a, b, 0]), `${a.toString(16)} + ${b.toString(16)}`).toEqual([f32ToBits(Math.fround(A + B))]);
      expect(evalOnce(add, [a, b, 1]), `${a.toString(16)} - ${b.toString(16)}`).toEqual([f32ToBits(Math.fround(A - B))]);
      expect(evalOnce(mul, [a, b]), `${a.toString(16)} * ${b.toString(16)}`).toEqual([f32ToBits(Math.fround(A * B))]);
      const v = r();
      expect(evalOnce(cvt, [v, 1])).toEqual([f32ToBits(Math.fround(v | 0))]);
      expect(evalOnce(cvt, [v, 0])).toEqual([f32ToBits(Math.fround(v >>> 0))]);
    }
  }, 600000);
  it('cost and depth', () => {
    for (const d of [fpAdd(F32), fpMul(F32), fpFromInt(F32), normRound(F32, 48), FPU32]) console.log(d.id, stats(d).nands, logicDepth(d));
  }, 300000);
});
