import { describe, expect, it } from 'vitest';
import { bestStages, chainDelay, FO4_TAU } from '../src/phys/sizing';

describe('inverter chain sizing', () => {
  it('64× load: three stages of ratio 4 beat one, two and six', () => {
    expect(bestStages(64)).toBe(3);
    expect(chainDelay(64, 3)).toBeCloseTo(15, 9);
    expect(chainDelay(64, 1)).toBeCloseTo(65, 9);
    expect(chainDelay(64, 2)).toBeCloseTo(18, 9);
    expect(chainDelay(64, 6)).toBeGreaterThan(chainDelay(64, 3));
  });
  it('the best ratio sits near 4 whatever the load (and FO4 = 5 τ)', () => {
    for (const F of [16, 256, 4096, 65536]) {
      const rho = F ** (1 / bestStages(F));
      expect(rho).toBeGreaterThan(2.5);
      expect(rho).toBeLessThan(6);
    }
    expect(FO4_TAU).toBe(5);
  });
});
