// Basics step 2, "A bucket of charge": the closed form behind widgets/basics.ts bucketWidget, DOM-free.
// 63 % at t = RC, the energy halves (stored = heat = ½CV², battery = CV²) and the heat does not depend on R.

import { describe, expect, it } from 'vitest';
import { FRACTION_AT_5RC, FRACTION_AT_RC, GATE, RC, RC_RANGE, currentAt, rc, rcRun, voltageAt } from '../src/widgets/basics';
import type { RcEvent, RcPart } from '../src/widgets/basics';
import { VDD, loadOf } from '../src/widgets/mosphys';

const part = (ohms: number, farads = RC.farads): RcPart => ({ volts: RC.volts, ohms, farads });
const fill: RcEvent[] = [{ at: 0, mode: 'charge' }];

describe('the RC bucket', () => {
  it('the step\'s bucket is 1 kΩ and 1000 µF: RC = 1 s, Q = 1.5 mC, first current 1.5 mA', () => {
    expect(rc(RC)).toBeCloseTo(1, 12);
    expect(RC.farads * RC.volts).toBeCloseTo(1.5e-3, 12);
    expect(currentAt(0, RC, 'charge')).toBeCloseTo(1.5e-3, 12);
  });

  it('63.2 % of the way at t = RC, within 1 % at 5 RC', () => {
    expect(voltageAt(rc(RC), RC, 'charge') / RC.volts).toBeCloseTo(0.632, 3);
    expect(FRACTION_AT_RC).toBeCloseTo(0.632, 3);
    expect(1 - FRACTION_AT_5RC).toBeLessThan(0.01);
    for (const r of [RC_RANGE.ohms[0], 1000, RC_RANGE.ohms[1]]) expect(voltageAt(rc(part(r)), part(r), 'charge') / RC.volts).toBeCloseTo(FRACTION_AT_RC, 12);
  });

  it('the current starts at V / R and falls with the voltage left to push', () => {
    for (const r of [100, 1000, 10000]) {
      expect(currentAt(0, part(r), 'charge')).toBeCloseTo(RC.volts / r, 12);
      const t = 0.3 * rc(part(r));
      expect(currentAt(t, part(r), 'charge')).toBeCloseTo((RC.volts - voltageAt(t, part(r), 'charge')) / r, 15);
    }
    expect(currentAt(5, RC, 'open', 0.7)).toBe(0);
    expect(currentAt(0, RC, 'discharge', 1.5)).toBeCloseTo(-1.5e-3, 12);
  });

  it('a full charge takes C·V² from the cell: half stored, half heat', () => {
    const now = rcRun(RC, fill, 50 * rc(RC));
    const cv2 = RC.farads * RC.volts ** 2;
    expect(now.v).toBeCloseTo(RC.volts, 9);
    expect(now.q).toBeCloseTo(RC.farads * RC.volts, 9);
    expect(now.battery).toBeCloseTo(cv2, 9);
    expect(now.stored).toBeCloseTo(cv2 / 2, 9);
    expect(now.heat).toBeCloseTo(cv2 / 2, 9);
    expect(cv2 * 1e3).toBeCloseTo(2.25, 12);
  });

  it('the heat is independent of R: ∫ i²R dt is ½CV² at 100 Ω, 1 kΩ and 10 kΩ', () => {
    for (const r of [100, 1000, 10000]) {
      const p = part(r), tau = rc(p), dt = tau / 4000;
      let heat = 0;
      for (let t = 0; t < 20 * tau; t += dt) {
        const i = currentAt(t + dt / 2, p, 'charge');
        heat += i * i * r * dt;
      }
      expect(heat / (0.5 * p.farads * p.volts ** 2), `R = ${r}`).toBeCloseTo(1, 4);
      // and the bookkeeping agrees with the integral at 20 RC
      expect(rcRun(p, fill, 20 * tau).heat / heat).toBeCloseTo(1, 4);
    }
  });

  it('energy is conserved at every instant: heat = from the cell − stored, and never negative', () => {
    const events: RcEvent[] = [{ at: 0, mode: 'charge' }, { at: 0.5, mode: 'open' }, { at: 1.5, mode: 'charge' }, { at: 2.5, mode: 'discharge' }];
    for (let t = 0; t <= 8; t += 0.1) {
      const n = rcRun(RC, events, t);
      expect(n.heat).toBeGreaterThanOrEqual(-1e-15);
      expect(n.heat).toBeCloseTo(n.battery - n.stored, 15);
    }
  });

  it('open holds the voltage; discharge turns the stored half into heat too', () => {
    const held = rcRun(RC, [...fill, { at: 1, mode: 'open' }], 4);
    expect(held.v).toBeCloseTo(RC.volts * FRACTION_AT_RC, 12);
    expect(held.i).toBe(0);
    const spent = rcRun(RC, [...fill, { at: 40, mode: 'discharge' }], 80);
    expect(spent.v).toBeCloseTo(0, 9);
    expect(spent.stored).toBeCloseTo(0, 12);
    expect(spent.heat).toBeCloseTo(spent.battery, 9);
  });

  it('a doubled C doubles both the time constant and the energy (the step\'s quiz)', () => {
    const big = part(1000, 2 * RC.farads);
    expect(rc(big)).toBeCloseTo(2 * rc(RC), 12);
    expect(rcRun(big, fill, 100).battery).toBeCloseTo(2 * rcRun(RC, fill, 100).battery, 12);
  });

  it('the gate figure comes from the MOSFET chapter\'s own load: 5 fF at 1.8 V, 16 fJ a swing', () => {
    expect(GATE.femtofarads).toBe(loadOf(2));
    expect(GATE.volts).toBe(VDD);
    expect(GATE.femtofarads).toBe(5);
    expect(Math.round(GATE.femtojoules)).toBe(16);
  });
});
