import { describe, expect, it } from 'vitest';
import { boothMul, boothRef, boothRow, boothTree, pipeMul, seqMul, treeMul } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { evalOnce, simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { analyzeTiming } from '../src/sim/timing';
import { checkSpec, corners, lcg, out, set, tick } from './util';

describe('Booth parts match their specs', () => {
  for (const d of [boothRow(3), boothRow(4), boothMul(4)]) it(d.id, () => checkSpec(d));
  for (const d of [boothRow(8), boothMul(6), boothMul(8), boothMul(16), boothMul(24)]) it(d.id, () => checkSpec(d, 300, corners(d)));
  it('the tree alone: s + c is the signed product', () => {
    const s = simulate(boothTree(8)), r = lcg(5);
    for (let t = 0; t < 300; t++) {
      const a = r(256), b = r(256);
      const [sum, carry] = evalOnce(s, [a, b]);
      expect((sum + carry) % 65536, `${a} × ${b}`).toBe(boothRef(a, b, 8));
    }
  });
});

describe('Booth versus Baugh–Wooley', () => {
  it('half the rows: fewer NANDs at 32 bits, not at 16', () => {
    expect(stats(boothMul(32)).nands).toBeLessThan(stats(treeMul(32, true)).nands);
    expect(stats(boothMul(16)).nands).toBeGreaterThan(stats(treeMul(16, true)).nands);
  });
  it('depth stays logarithmic', () => {
    expect(logicDepth(boothMul(32))!).toBeLessThan(logicDepth(boothMul(8))! * 2);
  });
});

describe('iterative multiplier', () => {
  it('multiplies in n + 2 cycles', () => {
    for (const n of [4, 8]) {
      const s = simulate(seqMul(n)), r = lcg(n);
      set(s, { clk: 0, start: 0, a: 0, b: 0 });
      const M = 2 ** n - 1;
      const pairs = [[0, 0], [M, M], [M, 1], [1, M], [5, 3], ...Array.from({ length: 30 }, () => [r(M + 1), r(M + 1)])];
      for (const [a, b] of pairs) {
        set(s, { start: 1, a, b });
        let cycles = 1;
        tick(s);
        set(s, { start: 0 });
        while (!out(s, 'done')) { tick(s); cycles++; expect(cycles).toBeLessThan(40); }
        expect([out(s, 'p'), cycles + 1], `${a} × ${b}`).toEqual([a * b, n + 2]);
        tick(s);
      }
    }
  });
});

describe('pipelined multiplier', () => {
  it('one product per cycle, four edges after its operands', () => {
    const n = 8, s = simulate(pipeMul(n)), r = lcg(77);
    set(s, { clk: 0, a: 0, b: 0 });
    const ops = Array.from({ length: 40 }, () => [r(256), r(256)]);
    const seen: number[] = [];
    for (let t = 0; t < ops.length + 4; t++) {
      const [a, b] = ops[t] ?? [0, 0];
      set(s, { a, b });
      tick(s);
      seen.push(out(s, 'p'));
    }
    // after edge t + 4 (index t + 3), the product of operands presented before edge t + 1 (index t)
    for (let t = 0; t < ops.length; t++) expect(seen[t + 3], `op ${t}`).toBe(boothRef(ops[t][0], ops[t][1], n));
  });
  it('the period is shorter than the unpipelined multiplier between registers', () => {
    const t = analyzeTiming(flatten(pipeMul(16)))!;
    expect(t.period).toBeLessThan(logicDepth(boothMul(16))! );
  });
});
