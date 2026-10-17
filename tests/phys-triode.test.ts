import { describe, expect, it } from 'vitest';
import {
  B_PLUS, DIVIDER_RATIO, HEATER_W, K, MU, TUBE_STEP_US, V_CUTOFF, V_HIGH, V_LOW, cutoff, dividerOut, gateLevels, plateCurrent,
  sectionPower, triodeAt, warmup,
} from '../src/phys/triode';

// The numbers the triode close-up and prologue P2 show (Phase 14 mockup, section 4).
describe('triode lumped model', () => {
  it('is fitted to the 6SN7 datasheet point: 9 mA at 250 V and −8 V, µ 20', () => {
    expect(plateCurrent(-8, 250)).toBeCloseTo(9e-3, 9);
    expect(MU).toBe(20);
    expect(K).toBeGreaterThan(0);
  });

  it('pulls its plate to 81 V with the grid at 0 V and leaves it at 250 V below −12.5 V', () => {
    expect(V_LOW).toBeCloseTo(81, 0);
    expect(V_HIGH).toBe(B_PLUS);
    expect(V_CUTOFF).toBe(-12.5);
    expect(plateCurrent(V_CUTOFF - 0.01, B_PLUS)).toBe(0);
    expect(plateCurrent(cutoff(V_LOW), V_LOW)).toBe(0);
  });

  it('needs a 1.67 : 1 divider to −150 V to bring a 250 V plate to a 0 V grid', () => {
    expect(DIVIDER_RATIO).toBeCloseTo(1.67, 2);
    expect(dividerOut(250)).toBeCloseTo(0, 9);
    expect(dividerOut(V_LOW)).toBeLessThan(V_CUTOFF - 30);
  });

  it('draws nothing for 4.5 s after switch-on, then its full current within about 1.5 s', () => {
    const w = warmup(0), full = w.at(-1)!.ip;
    const at = (f: number) => w.find((s) => s.ip >= f * full)!.t;
    expect(full).toBeCloseTo((B_PLUS - V_LOW) / 22e3, 4);
    expect(w.filter((s) => s.t < 4).every((s) => s.ip < 0.05 * full)).toBe(true);
    expect(at(0.1)).toBeGreaterThan(4);
    expect(at(0.9)).toBeLessThan(6.5);
    expect(at(0.9) - at(0.1)).toBeLessThan(2);
    expect(triodeAt(0, 0).ip).toBeLessThan(1e-12);
  });

  it('chains inverters with margin at a fan-out of 1 or 2 dividers, and fails at 4', () => {
    for (const f of [1, 2]) {
      const l = gateLevels(f);
      expect(l.marginLow, `fan-out ${f}`).toBeGreaterThan(10);
      expect(l.marginHigh, `fan-out ${f}`).toBeGreaterThan(3);
    }
    const l4 = gateLevels(4);
    expect(Math.min(l4.marginLow, l4.marginHigh)).toBeLessThan(0);
  });

  it('spends most of a section\'s power on the heater', () => {
    const p = sectionPower();
    expect(HEATER_W).toBeCloseTo(1.89, 9);
    expect(p.average).toBeCloseTo(2.85, 2);
    expect((p.plate + p.resistor) / 2).toBeCloseTo(0.96, 2);
    expect(p.heater / p.average).toBeGreaterThan(0.6);
    expect(TUBE_STEP_US).toBeCloseTo(1, 1);
  });
});
