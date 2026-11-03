import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { F_PROGRAMS } from '../src/riscv/fprograms';
import { ISS } from '../src/riscv/iss';
import { EPSILON, evalText, parseExpr, q, qNum, qOfBits, qText, relErr, roundQ32, ulpsOff, UNIT_ROUNDOFF, valueOfBits } from '../src/sim/errorlab';
import { F32, f32ToBits, fpAddX, fpValue } from '../src/sim/fpref';
import { bounds, dataset, errorCurve, exactSum, kahanSum, naiveSum, pairwiseSum, relErrOf } from '../src/sim/sumerror';

const ok = (s: string) => { const r = evalText(s); if ('error' in r) throw new Error(r.error); return r; };
const relOf = (s: string) => { const r = ok(s); return relErr(qOfBits(r.bits), r.real); };
const lcg = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };

describe('error lab: exact arithmetic', () => {
  it('rounds rationals like the hardware and reads digits', () => {
    expect(roundQ32(q(1n, 10n))).toBe(0x3dcccccd);
    expect(roundQ32(q(16777217n))).toBe(0x4b800000); // tie to even
    expect(qText(qOfBits(0x3dcccccd), 12)).toBe('0.10000000149');
    expect(qText(q(1n, 3n), 5)).toBe('0.33333');
    expect(qText(q(123456789n, 1000n), 4)).toBe('123500');
    expect(qText(q(1n, 10n ** 9n))).toBe('1e−9');
    expect(valueOfBits(0x4b800010)).toBe(16777248);
  });
  it('machine epsilon and unit roundoff', () => {
    expect(fpValue(0x3f800001, F32) - 1).toBe(EPSILON);
    expect(UNIT_ROUNDOFF).toBe(EPSILON / 2);
    expect(ok('1 + 2^-24').bits).toBe(0x3f800000); // a tie: back to even
    expect(ok('1 + 2^-24 * 1.001').bits).toBe(0x3f800001);
  });
  it('ulps of error', () => {
    expect(ulpsOff(qOfBits(0x3f800001), q(1n))).toBe(1);
    expect(ulpsOff(q(3n, 2n), q(1n))).toBe(2 ** 22);
    expect(ulpsOff(q(1n), q(0n))).toBeNull();
    expect(ulpsOff(qOfBits(0x40000000), q(2n))).toBe(0);
    // just below 2 the ulp is 2^-23
    expect(ulpsOff(q(2n), q((1n << 24n) - 1n, 1n << 23n))).toBe(1);
  });
  it('parses', () => {
    expect(() => parseExpr('1 +')).toThrow();
    expect(() => parseExpr('2 $ 3')).toThrow();
    expect('error' in evalText('1/0')).toBe(true);
    expect('error' in evalText('sqrt(0-1)')).toBe(true);
    expect('error' in evalText('1e39')).toBe(true);
    expect(qNum(ok('2^-3 + 1.5e1 * −2').real)).toBe(0.125 - 30);
  });
});

describe("error lab: the chapter's cases", () => {
  it('(1 + x) − 1 loses x entirely below u, and about u / x above', () => {
    expect(ok('(1 + 1e-8) - 1').bits).toBe(0);
    expect(relOf('(1 + 1e-8) - 1')).toBe(1);
    expect(relOf('(1 + 1e-3) - 1')!).toBeLessThanOrEqual(UNIT_ROUNDOFF / 1e-3);
    expect(relOf('(1 + 1e-3) - 1')!).toBeGreaterThan(1e-6);
  });
  it('the subtraction is exact (Sterbenz) while the error it exposes is large', () => {
    const sub = ok('1.0001 - 1.00005').steps.find((s) => s.op === '-')!;
    expect(sub.sterbenz).toBe(true);
    expect(sub.delta).toBe(0);
    expect(sub.amplify!).toBeGreaterThan(100);
    const far = ok('1e8 - 0.3').steps.find((s) => s.op === '-')!;
    expect(far.sterbenz).toBe(false);
    expect(far.delta!).toBeGreaterThan(0);
    expect(far.delta!).toBeLessThanOrEqual(1);
  });
  it('Sterbenz: x − y is exact whenever y/2 ≤ x ≤ 2y (random float pairs)', () => {
    const rnd = lcg(7);
    for (let i = 0; i < 400; i++) {
      const y = f32ToBits(Math.fround(1 + rnd() * 100)), x = f32ToBits(Math.fround(fpValue(y, F32) * (0.5 + rnd() * 1.5)));
      expect(fpValue(fpAddX(x, y, true, F32).y, F32)).toBe(fpValue(x, F32) - fpValue(y, F32));
    }
  });
  it('the quadratic: the naive small root is lost, the rewrite keeps every digit', () => {
    const naive = ok('(10000 - sqrt(10000*10000 - 4*1*0.1)) / (2*1)');
    const stable = ok('(2*0.1) / (10000 + sqrt(10000*10000 - 4*1*0.1))');
    expect(naive.bits).toBe(0); // b² − 4ac rounds to b²: sqrt gives 10000, the root 0
    expect(relErr(qOfBits(naive.bits), naive.real)).toBe(1);
    expect(qNum(naive.real)).toBeCloseTo(1e-5, 12);
    expect(relErr(qOfBits(stable.bits), stable.real)!).toBeLessThan(4 * EPSILON);
  });
  it('x² − y² against (x − y)(x + y)', () => {
    expect(relOf('1.000244140625*1.000244140625 - 1.0001220703125*1.0001220703125')!).toBeGreaterThan(1e-5);
    expect(relOf('(1.000244140625 - 1.0001220703125)*(1.000244140625 + 1.0001220703125)')!).toBeLessThan(4 * EPSILON);
  });
  it('0.3 × 3 − 0.9 is not 0 in float32', () => {
    const r = ok('0.3*3 - 0.9');
    expect(qNum(r.real)).toBe(0);
    expect(r.bits).not.toBe(0);
    expect(relErr(qOfBits(r.bits), r.real)).toBeNull();
  });
  it('each operation alone obeys the standard model (δ ≤ u) on random expressions', () => {
    const rnd = lcg(99);
    for (let i = 0; i < 150; i++) {
      const lit = () => (rnd() * 1000).toFixed(3);
      const e = `(${lit()} ${'+-*/'[Math.floor(rnd() * 4)]} ${lit()}) ${'+-*/'[Math.floor(rnd() * 4)]} sqrt(${lit()})`;
      for (const s of ok(e).steps) if (s.delta !== null) expect(s.delta, `${e}: ${s.text}`).toBeLessThanOrEqual(1);
    }
  });
});

describe('summation', () => {
  it('float32 sums as Math.fround computes them equal fpref', () => {
    const rnd = lcg(5);
    for (let i = 0; i < 2000; i++) {
      const a = Math.fround((rnd() - 0.5) * 2 ** (rnd() * 40 - 20)), b = Math.fround((rnd() - 0.5) * 2 ** (rnd() * 40 - 20));
      expect(f32ToBits(Math.fround(a + b))).toBe(fpAddX(f32ToBits(a), f32ToBits(b), false, F32).y);
      expect(f32ToBits(Math.fround(a - b))).toBe(fpAddX(f32ToBits(a), f32ToBits(b), true, F32).y);
    }
  });
  it('the RV32F program equals the TypeScript loops and the exact sum', () => {
    const a = assemble(F_PROGRAMS.find((p) => p.id === 'kahan')!.source);
    expect(a.errors).toEqual([]);
    const iss = new ISS(a.words);
    let steps = 0;
    while (!iss.halted && steps < 2000) { iss.step(); steps++; }
    expect(iss.halted).toBe(true);
    const xs = [2 ** 24, ...Array<number>(32).fill(1)];
    const exact = exactSum(xs);
    expect(qNum(exact)).toBe(16777248);
    const k = kahanSum(xs);
    expect(iss.x[10] >>> 0).toBe(f32ToBits(naiveSum(xs)));
    expect(iss.x[11] >>> 0).toBe(f32ToBits(k.sum));
    expect(iss.x[10] >>> 0).toBe(0x4b800000); // naive: every 1 absorbed
    expect(iss.x[11] >>> 0).toBe(0x4b800010); // Kahan: exact
    expect(iss.x[12] >>> 0).toBe(f32ToBits(32));
    expect(relErrOf(naiveSum(xs), exact)).toBe(32 / 16777248);
    expect(relErrOf(k.sum, exact)).toBe(0);
    expect(steps).toBeLessThan(400);
  });
  it('the compensation walks −1, 0, +1, 0 as the chapter says', () => {
    const cs = [1, 2, 3, 4, 32].map((k) => kahanSum([2 ** 24, ...Array<number>(k).fill(1)]).c);
    expect(cs).toEqual([-1, 0, 1, 0, 0]);
  });
  it('error bounds hold, and the data sets show their point', () => {
    for (const kind of ['wide', 'uniform', 'absorb'] as const) {
      for (const p of errorCurve(kind, 12)) {
        const b = bounds(p.n);
        expect(p.naive, `${kind} naive n=${p.n}`).toBeLessThanOrEqual(b.naive + 1e-12);
        expect(p.pairwise, `${kind} pairwise n=${p.n}`).toBeLessThanOrEqual(b.pairwise + 1e-12);
        expect(p.kahan, `${kind} kahan n=${p.n}`).toBeLessThanOrEqual(b.kahan + 1e-12);
      }
    }
    const last = (k: Parameters<typeof errorCurve>[0]) => errorCurve(k, 14).at(-1)!;
    const n = 2 ** 14, ab = last('absorb');
    expect(ab.naive).toBeCloseTo(((n - 1) * 2 ** -24) / (1 + (n - 1) * 2 ** -24), 6); // every tiny term lost: the n·u bound, attained
    expect(ab.kahan).toBeLessThanOrEqual(2 * UNIT_ROUNDOFF);
    expect(ab.pairwise).toBeLessThan(ab.naive / 100);
    const u = last('uniform');
    expect(u.kahan).toBeLessThan(u.naive);
    expect(u.pairwise).toBeLessThan(u.naive);
    expect(pairwiseSum(dataset('wide', 1))).toBe(dataset('wide', 1)[0]);
  });
  it('Kahan error does not grow with n (at most 2u for every set up to 2^14)', () => {
    for (const kind of ['wide', 'uniform', 'absorb'] as const) for (const p of errorCurve(kind, 14)) expect(p.kahan).toBeLessThanOrEqual(2 * UNIT_ROUNDOFF);
  });
});
