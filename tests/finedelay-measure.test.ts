// The measurers under load-dependent delay (docs/PLAN-FINEDELAY.md, stage 4): settle, opdelay, edgetiming and the CPU's
// cycle times take the model; under 'load' every time is in tenths of a unit, never past the static bound, and the setup /
// hold sweep steps a tenth at a time. The unit model's numbers are pinned by the existing tests (adders, deepseq, cycletime).

import { describe, expect, it } from 'vitest';
import { DFF, DFF_EDGE6 } from '../src/lib';
import { alu } from '../src/lib/alu';
import { rca } from '../src/lib/combinational';
import { measureClasses } from '../src/riscv/cycletime';
import { sweepEdge } from '../src/sim/edgetiming';
import { portSettle } from '../src/sim/opdelay';
import { outputSettle } from '../src/sim/settle';
import { logicDepth } from '../src/sim/stats';
import { tick } from './yieldtick';

const tenths = (x: number) => Math.abs(x * 10 - Math.round(x * 10)) < 1e-9;
const carryVectors = (n: number): number[][] => {
  const m = 2 ** n - 1, v: number[][] = [[0, 0, 0]];
  for (let i = 0; i < 24; i++) v.push([m, 1, 0], [0, 0, 0], [(i * 2654435761) & m, (i * 40503) & m, i & 1]);
  return v;
};

describe('measurers under load-dependent delay', () => {
  it('outputSettle: tenths, within the static load depth, and not the unit count', () => {
    const def = rca(8), vs = carryVectors(8);
    const unit = outputSettle(def, vs).worst, load = outputSettle(def, vs, 'load').worst;
    expect(Number.isInteger(unit)).toBe(true);
    expect(tenths(load)).toBe(true);
    expect(load).toBeGreaterThan(0);
    expect(load).toBeLessThanOrEqual(logicDepth(def, 'load')! + 0.05 * logicDepth(def, 'unit')! + 1e-9);
    expect(load).not.toBe(unit);
  });

  it('portSettle: the ALU result timed in tenths', () => {
    const A = alu(8), pairs: [number, number][] = [[255, 1], [128, 128], [85, 170]];
    const vs = [[0, 0, 0], ...pairs.flatMap(([a, b]) => [[a, b, 0], [0, 0, 0]])];
    const d = portSettle(A, vs, ['y'], 'load');
    expect(tenths(d)).toBe(true);
    expect(d).toBeGreaterThan(0);
    expect(Number.isInteger(portSettle(A, vs, ['y']))).toBe(true);
  });

  it('sweepEdge: steps a tenth at a time; setup, hold and clock-to-q in tenths; the unit sweep unchanged', () => {
    for (const def of [DFF, DFF_EDGE6]) {
      const unit = sweepEdge(def, 'rise', -4, 4);
      expect(unit.offsets).toEqual([-4, -3, -2, -1, 0, 1, 2, 3, 4]);
      const load = sweepEdge(def, 'rise', -4, 4, undefined, 'load');
      expect(load.offsets.length).toBe(81);
      expect(load.offsets[1]).toBe(-3.9);
      for (const x of [load.setup, load.hold, load.cqRise, load.cqFall]) expect(tenths(x)).toBe(true);
      expect(load.cqRise).toBeGreaterThan(0);
      // the aperture is still one window: captured, then (maybe) undecided, then old
      const firstOld = load.outcome.indexOf('old');
      expect(firstOld).toBeGreaterThan(0);
      expect(load.outcome.slice(firstOld).every((o) => o === 'old')).toBe(true);
    }
  });

  it('the single-cycle CPU: every cycle in tenths, none past the static load period', async () => {
    const r = await measureClasses('rca', [1], 20, tick, 'load');
    expect(r.model).toBe('load');
    expect(r.cycles).toBeGreaterThan(10);
    for (const c of r.classes) expect(tenths(c.max)).toBe(true);
    expect(r.worst).toBeGreaterThan(0);
    expect(r.worst).toBeLessThanOrEqual(r.period + 1e-9);
  }, 120_000);
});
