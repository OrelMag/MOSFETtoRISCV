import { describe, expect, it } from 'vitest';
import { fpAdd, fpClassify, fpCompare, fpFromInt, fpMinMax, fpMul, fpToInt, lzc, normRound, shiftLeft, shiftRightSticky, FCSR, FPU32 } from '../src/lib';
import { F32, FLAG, RM, bitsToF32, f32ToBits, fpAddX, fpMulX, fpToIntX, fpFromIntX, type FpFormat } from '../src/sim/fpref';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats, logicDepth } from '../src/sim/stats';
import { check, isExhaustive, operandPairs } from './fptest';

const small: FpFormat[] = [{ E: 4, M: 3 }, { E: 3, M: 2 }, { E: 5, M: 2 }];
const E4M3 = small[0];
const MODES = [0, 1, 2, 3, 4, 5, 7]; // the five modes plus a reserved one and 7 (behave as RTZ)

const all = (n: number) => Array.from({ length: n }, (_, i) => i);

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

// Six-bit formats: every pair. Eight-bit formats: every boundary value against every operand plus a
// sample, in every rounding mode with flags (FPU_EXHAUSTIVE=1: every pair).
describe('small-format FPUs against exact arithmetic, every rounding mode and flag', () => {
  for (const f of small) {
    it(`E${f.E}M${f.M}: add, sub and mul (${isExhaustive(f) ? 'every pair' : 'boundary values × every operand, plus a sample'})`, async () => {
      const pairs = operandPairs(f), n = pairs.length;
      await check(fpAdd(f), { count: 2 * n * MODES.length, gen: (i) => { const [a, b] = pairs[(i >> 1) % n]; return [a, b, i & 1, MODES[Math.floor(i / (2 * n))]]; } });
      await check(fpMul(f), { count: n * MODES.length, gen: (i) => { const [a, b] = pairs[i % n]; return [a, b, MODES[Math.floor(i / n)]]; } });
    }, 120000);
  }
  it('E4M3: int ↔ float for every 8-bit integer and every encoding', async () => {
    const v: number[][] = [];
    for (const rm of MODES) for (let x = 0; x < 256; x++) for (const sg of [0, 1]) v.push([x, sg, rm]);
    await check(fpFromInt(E4M3, 8), v);
    for (const f of [E4M3, small[2], { E: 5, M: 3 }]) await check(fpToInt(f, 8), v);
    await check(fpToInt(small[1], 4), v.filter((x) => x[0] < 64));
  });
  it('E4M3: compare, min / max and classify', async () => {
    const pairs = operandPairs(E4M3);
    await check(fpCompare(E4M3), pairs);
    await check(fpMinMax(E4M3), pairs.flatMap(([a, b]) => [[a, b, 0], [a, b, 1]]));
    await check(fpClassify(E4M3), all(256).map((a) => [a]));
  });
  it('underflow is detected after rounding', async () => {
    // E4M3 (emin = −6): 1.111 × 2^-3 × 2^-4 = 1.111 × 2^-7 = 0.111|1 × 2^-6 rounds (a tie, to even)
    // up to 2^-6, the smallest normal. With an unbounded exponent it is exact at 1.111 × 2^-7: tiny.
    expect(fpMulX(0x27, 0x18, E4M3)).toEqual({ y: 0x08, fl: FLAG.UF | FLAG.NX });
    // 1.001 × 2^-3 × 1.110 × 2^-4 = 1.11111 × 2^-7: rounded to 4 bits it reaches 2^-6, so not tiny
    expect(fpMulX(0x21, 0x1e, E4M3)).toEqual({ y: 0x08, fl: FLAG.NX });
    await check(fpMul(E4M3), [[0x27, 0x18, 0], [0x21, 0x1e, 0]]);
    expect(fpAddX(0x07, 0x01, false, E4M3).fl).toBe(0); // 0.111 + 0.001 = 1.000 × 2^-6 exactly: no flags
  });
});

describe('float32 units', () => {
  let seed = 3;
  const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
  const special = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 1, 0x807fffff, 0x00800000, 0x7f7fffff, 0x3f800000, 0xbf800000, 0x33800000, 0x4b800000, 0x4f000000, 0xcf000000, 0x3f000000];
  const pick = () => (r() % 5 === 0 ? special[r() % special.length] : ((r() >>> 8) | ((r() & 0xff) << 24)) >>> 0);
  it('fadd / fsub / fmul / fcvt in every mode, against the exact reference', async () => {
    const add: number[][] = [], mul: number[][] = [], cvt: number[][] = [], toi: number[][] = [];
    for (let i = 0; i < 3000; i++) {
      const a = pick();
      let b = pick();
      if (i % 4 === 0) b = ((a & 0xff800000) | (r() & 0x7fffff)) >>> 0; // near-cancellation
      if (i % 7 === 0) b = ((((a >>> 23) & 0xff) < 30 ? 0x3f800000 : 0x00800000) | (r() & 0x7fffff)) >>> 0; // underflowing products
      const rm = r() % 5;
      add.push([a, b, i & 1, rm]);
      mul.push([a, b, rm]);
      cvt.push([r(), r() & 1, rm]);
      // around the integer range: exponents 120 … 160
      toi.push([i % 3 ? (((r() & 1) << 31) | ((120 + (r() % 40)) << 23) | (r() & 0x7fffff)) >>> 0 : pick(), r() & 1, rm]);
    }
    await check(fpAdd(F32), add);
    await check(fpMul(F32), mul);
    await check(fpFromInt(F32), cvt);
    await check(fpToInt(F32), toi);
    // RNE agrees with the host float32
    for (const [a, b, s, rm] of add) if (rm === RM.RNE) expect(fpAddX(a, b, !!s, F32).y).toBe(f32ToBits(Math.fround(s ? bitsToF32(a) - bitsToF32(b) : bitsToF32(a) + bitsToF32(b))));
  }, 120000);
  it('the event-driven simulator agrees on a sample', () => {
    const add = simulate(fpAdd(F32)), toi = simulate(fpToInt(F32));
    for (let i = 0; i < 40; i++) {
      const a = pick(), b = pick(), rm = i % 5;
      const want = fpAddX(a, b, false, F32, rm);
      expect(evalOnce(add, [a, b, 0, rm])).toEqual([want.y, want.fl]);
      const t = fpToIntX(a, true, F32, rm);
      expect(evalOnce(toi, [a, 1, rm])).toEqual([t.y, t.fl]);
    }
    expect(fpFromIntX(16777217, true, F32, RM.RUP).y).toBe(0x4b800001);
  });
  it('cost and depth', () => {
    for (const d of [fpAdd(F32), fpMul(F32), fpFromInt(F32), fpToInt(F32), fpMinMax(F32), fpClassify(F32), normRound(F32, 48), FCSR, FPU32]) console.log(d.id, stats(d).nands, logicDepth(d));
  }, 300000);
});
