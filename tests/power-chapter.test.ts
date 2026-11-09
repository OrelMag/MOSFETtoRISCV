// What the Power chapter's prose says of its widgets' measurements (widgets/power.ts), checked on the circuits.

import { describe, expect, it } from 'vitest';
import { benchOf } from '../src/bench/powercosts';
import { activityMeasure, atSpeed, FRONT_CPUS, glitchMeasure, POWER, raceCases } from '../src/widgets/power';

describe('Power chapter claims', () => {
  it('activity: a held operand costs least, random operands most', () => {
    const [count, random, held] = activityMeasure().map((r) => r.fj);
    expect(held).toBeLessThan(count);
    expect(count).toBeLessThan(random);
  }, 60_000);
  it('glitches: the ripple-carry adder glitches more than Kogge–Stone; the single-cycle CPU more than the pipeline', () => {
    const [ripple, ks] = glitchMeasure();
    expect(ripple.glitch).toBeGreaterThan(ks.glitch);
    expect(benchOf('sc').glitch).toBeGreaterThan(2 * benchOf('pipe').glitch);
  }, 60_000);
  it('clock gating: the data memory and the clock net shrink, the register file grows', () => {
    const b = (c: typeof POWER.plain, n: string) => c.blocks.find(([x]) => x === n)?.[1] ?? 0;
    expect(b(POWER.gated, 'dm')).toBeLessThan(b(POWER.plain, 'dm'));
    expect(b(POWER.gated, 'rf')).toBeGreaterThan(b(POWER.plain, 'rf'));
    expect(POWER.gated.glitch).toBeGreaterThan(POWER.plain.glitch);
  });
  it('race to halt: with slack, pacing beats racing; at the deadline they are close', () => {
    for (const id of ['hp', 'lp'] as const) {
      const [stop, off, pace] = raceCases(id, 1e-3);
      expect(pace.j).toBeLessThan(Math.min(stop.j, off.j));
    }
    const tight = raceCases('hp', 5e-5);
    expect(tight[2].j / Math.min(tight[0].j, tight[1].j)).toBeGreaterThan(0.5);
  });
  it('at 4 ns per instruction the balanced pipeline spends less than the single-cycle CPU and the out-of-order core', () => {
    const at = (id: string) => atSpeed(FRONT_CPUS.find((c) => c.id === id)!, 4)!;
    expect(at('pipe-bal').pj).toBeLessThan(at('sc').pj);
    expect(at('pipe-bal').pj).toBeLessThan(at('ooo').pj);
  });
});
