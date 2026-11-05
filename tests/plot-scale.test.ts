// The plots' x axis: unchanged wherever a range starts at 0, and honest where it does not. A range below 0 used to lose everything left of 0, silently.

import { describe, expect, it } from 'vitest';
import { axisTicks, axisX, tickStep } from '../src/widgets/plotscale';

const A = 48, B = 628;

describe('a range from 0', () => {
  it('maps as it always did', () => {
    for (const max of [0.55, 1, 7, 22, 64, 500, 16384]) for (const f of [0, 0.1, 0.37, 0.5, 1]) {
      const v = f * max;
      expect(axisX(v, 0, max, A, B)).toBe(A + (v / max) * (B - A));
    }
  });
  it('has the ticks it always had', () => {
    const old = (max: number) => { const st = tickStep(max), out: number[] = []; for (let v = 0; v <= max * 1.0001; v += st) out.push(v); return out; };
    for (const max of [0.5, 0.55, 1, 3.7, 7, 8, 14, 22, 64, 100, 256, 500, 1000, 16384]) expect(axisTicks(0, max).ticks).toEqual(old(max));
  });
});

describe('a range from anywhere else', () => {
  it('puts its ends at the plot\'s ends, and 0 where 0 belongs', () => {
    expect(axisX(-2, -2, 2, A, B)).toBe(A);
    expect(axisX(2, -2, 2, A, B)).toBe(B);
    expect(axisX(0, -2, 2, A, B)).toBe((A + B) / 2);
    expect(axisX(1, 1, 7, A, B)).toBe(A);
  });
  it('labels every tick inside it, and a clean 0', () => {
    const t = axisTicks(-2, 2).ticks;
    expect(t).toEqual([-2, -1, 0, 1, 2]);
    expect(Object.is(t[2], -0)).toBe(false);
    expect(axisTicks(1, 7).ticks.every((v) => v >= 1 && v <= 7)).toBe(true);
    expect(axisTicks(-1, 1).ticks).toContain(0);
    const f = axisTicks(-0.3, 0.3).ticks;
    f.forEach((v) => expect(v).toBeGreaterThanOrEqual(-0.3 - 1e-9));
    expect(f).toContain(0);
  });
});
