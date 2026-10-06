import { describe, expect, it } from 'vitest';
import { BCD_DIGIT, bcdAdder, carrySelect, carrySkip, koggeStone, rca } from '../src/lib';
import { evalOnce, simulate } from '../src/sim/harness';
import { outputSettle } from '../src/sim/settle';
import { logicDepth } from '../src/sim/stats';
import { checkSpec, corners, lcg } from './util';

describe('adder variants match their specs', () => {
  for (const d of [BCD_DIGIT, carrySelect(4, 2), carrySkip(4, 2)]) it(d.id, () => checkSpec(d));
  for (const d of [carrySelect(8), carrySelect(16), carrySkip(8), carrySkip(16), carrySkip(16, 2), bcdAdder(2), bcdAdder(3)]) {
    it(d.id, () => checkSpec(d, 300, corners(d)));
  }
  it('BCD: decimal sums of decimal digits', () => {
    const s = simulate(bcdAdder(2));
    const bcd = (v: number) => parseInt(String(v), 16);
    for (let a = 0; a < 100; a += 7) for (let b = 0; b < 100; b += 3) {
      const t = a + b;
      expect(evalOnce(s, [bcd(a), bcd(b), 0]), `${a} + ${b}`).toEqual([bcd(t % 100), t >= 100 ? 1 : 0]);
    }
  });
});

/** Transitions that exercise long carries: from 0 to a full propagate chain with a carry in, and random ones. */
function vectors(n: number, count = 200): number[][] {
  const M = 2 ** n - 1, r = lcg(3);
  const v: number[][] = [[0, 0, 0], [M, 0, 1], [0, 0, 0], [M, 1, 0], [1, M, 0], [0, M, 1], [M, 0, 0], [M, 0, 1]];
  for (let i = 0; i < count; i++) v.push([r(M + 1), r(M + 1), r(2)]);
  return v;
}

describe('outputSettle', () => {
  it('ripple carry: the measured worst case is the full carry chain', () => {
    const { worst } = outputSettle(rca(8), vectors(8));
    expect(worst).toBeGreaterThan(12);
    expect(worst).toBeLessThanOrEqual(logicDepth(rca(8))!);
  });
});

describe('carry-skip has a false path', () => {
  it('static depth is worse than ripple, but the measured delay is better', () => {
    const n = 32, skip = carrySkip(n), rip = rca(n);
    expect(logicDepth(skip)!).toBeGreaterThan(logicDepth(rip)!);
    expect(outputSettle(skip, vectors(n)).worst).toBeLessThan(outputSettle(rip, vectors(n)).worst * 0.7);
  });
  it('carry-select is genuinely shallow', () => {
    expect(logicDepth(carrySelect(32))!).toBeLessThan(logicDepth(rca(32))! / 2);
    expect(logicDepth(koggeStone(32))!).toBeLessThan(logicDepth(carrySelect(32))!);
  });
});
