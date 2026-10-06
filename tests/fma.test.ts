import { describe, expect, it } from 'vitest';
import { fpFma } from '../src/lib';
import { F32, FLAG, RM, fpAddX, fpFmaX, fpMulX, type FpFormat } from '../src/sim/fpref';
import { evalOnce, simulate } from '../src/sim/harness';
import { stats, logicDepth } from '../src/sim/stats';
import { EXHAUSTIVE, check } from './fptest';

/** Stream operand sets through the gate-level fma, 32 per pass, and compare each with the reference. */
const stream = (f: FpFormat, count: number, gen: (i: number) => number[]) => check(fpFma(f), { count, gen });

describe('fused multiply-add', () => {
  it(`E3M2: every a, b, c and all four sign variants (fmadd, fmsub, fnmsub, fnmadd), ${EXHAUSTIVE ? 'in every rounding mode' : 'the rounding mode rotating'}`, async () => {
    // 2^18 operand triples × 4 variants (× 5 modes with FPU_EXHAUSTIVE=1: 5 242 880 cases)
    if (EXHAUSTIVE) await stream({ E: 3, M: 2 }, 20 * 2 ** 18, (i) => { const t = i % 2 ** 18, v = Math.floor(i / 2 ** 18); return [t >> 12, (t >> 6) & 63, t & 63, (v >> 1) & 1, v & 1, v >> 2]; });
    else await stream({ E: 3, M: 2 }, 4 * 2 ** 18, (i) => { const t = i % 2 ** 18, v = Math.floor(i / 2 ** 18); return [t >> 12, (t >> 6) & 63, t & 63, (v >> 1) & 1, v & 1, (t + v) % 5]; });
  }, 120000);
  it('E4M3 and E5M2: random, biased towards cancellation', async () => {
    for (const f of [{ E: 4, M: 3 }, { E: 5, M: 2 }]) {
      let seed = 21;
      const r = () => (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
      const ex = (x: number) => (x >> f.M) & (2 ** f.E - 1);
      await stream(f, 100000, (i) => {
        const a = r(), b = r();
        // c with the product's exponent, so that a × b − c cancels
        const c = i % 2 ? r() : (r() & 0x80) | ((((ex(a) + ex(b) - (2 ** (f.E - 1) - 1)) & (2 ** f.E - 1)) << f.M) | (r() & (2 ** f.M - 1)));
        return [a, b, c, (i >> 1) & 1, (i >> 2) & 1, i % 5];
      });
    }
  }, 120000);
  it('float32: random and special operands in every mode', async () => {
    let seed = 13;
    const r = () => (seed = (seed * 1103515245 + 12345) >>> 0);
    const special = [0, 0x80000000, 0x7f800000, 0xff800000, 0x7fc00000, 0x7f800001, 1, 0x807fffff, 0x00800000, 0x7f7fffff, 0x3f800000, 0xbf800000];
    const pick = () => (r() % 6 === 0 ? special[r() % special.length] : ((r() >>> 8) | ((r() & 0xff) << 24)) >>> 0);
    const prodExp = (a: number, b: number) => ((((a >>> 23) & 0xff) + ((b >>> 23) & 0xff) - 127) & 0xff) << 23;
    await stream(F32, 3200, (i) => {
      const a = pick(), b = pick();
      const c = i % 3 === 0 ? ((r() & 0x80000000) | prodExp(a, b) | (r() & 0x7fffff)) >>> 0 : pick();
      return [a, b, c, (i >> 1) & 1, (i >> 2) & 1, r() % 5];
    });
    // the event-driven simulator agrees on a sample
    const s = simulate(fpFma(F32));
    for (let i = 0; i < 20; i++) {
      const a = pick(), b = pick(), c = pick(), want = fpFmaX(a, b, c, !!(i & 1), !!(i & 2), F32, i % 5);
      expect(evalOnce(s, [a, b, c, i & 1, (i >> 1) & 1, i % 5])).toEqual([want.y, want.fl]);
    }
  }, 120000);
  it('one rounding instead of two: fma differs from fmul then fadd', async () => {
    // x = 1 + 2^-12: x² = 1 + 2^-11 + 2^-24. fmul rounds 2^-24 away (a tie, to even);
    // fma(x, x, −(1 + 2^-11)) keeps it: exactly 2^-24.
    const x = 0x3f800800, sq = fpMulX(x, x, F32).y;
    expect(sq).toBe(0x3f801000); // 1 + 2^-11
    expect(fpAddX(sq, 0x3f801000, true, F32).y).toBe(0); // mul then sub: 0
    expect(fpFmaX(x, x, 0x3f801000, false, true, F32)).toEqual({ y: 0x33800000, fl: 0 }); // fma: 2^-24, exact
    expect(fpMulX(x, x, F32).fl).toBe(FLAG.NX);
    expect(fpFmaX(x, x, 0x3f801000, false, true, F32, RM.RDN).y).toBe(0x33800000);
  });
  it('cost and depth', () => { const d = fpFma(F32); console.log(d.id, stats(d).nands, logicDepth(d)); });
});
