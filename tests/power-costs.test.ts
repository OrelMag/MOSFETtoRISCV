// The Power chapter's numbers (src/bench/powercosts.json) are what the circuits give: recomputed and compared. After a
// change to the CPU, the power model or the device law: npx vite-node scripts/power-costs.ts --write.

import { describe, expect, it } from 'vitest';
import { powerCosts } from '../src/bench/powercosts';
import saved from '../src/bench/powercosts.json';

describe('powercosts.json', () => {
  it('equals a fresh measurement', () => {
    const c = powerCosts();
    expect(JSON.parse(JSON.stringify(c))).toEqual(saved);
    // what the chapter says of them
    expect(c.gated.pj).toBeLessThan(c.plain.pj);
    expect(c.gated.nands).toBeLessThan(c.plain.nands);
    expect(c.gated.clockFf).toBeLessThan(c.plain.clockFf / 10);
    const dmRf = c.plain.clockBy.filter(([n]) => n === 'dm' || n === 'rf').reduce((a, [, k]) => a + k, 0);
    expect(dmRf / c.plain.clockInputs).toBeGreaterThan(0.95);
    for (const id of ['hp', 'lp'] as const) {
      const m = c.minimum[id], v = c.atVdd[id];
      expect(m.v).toBeLessThan(0.5);
      expect(m.dynPj + m.leakPj).toBeLessThan(v.dynPj + v.leakPj);
    }
  }, 120_000);
});
