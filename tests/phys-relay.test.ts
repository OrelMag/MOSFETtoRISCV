import { describe, expect, it } from 'vitest';
import { RELAY_COIL_POWER, RELAY_STEP_MS, RELAY_SUPPLY, relaySim, relayStatic, relaySummary, T_END, T_OFF, T_ON } from '../src/phys/relay';

// The numbers the relay close-up shows and the simulator's relay step uses (Phase 14a mockup, section 3).
describe('relay lumped model', () => {
  const run = relaySim(RELAY_SUPPLY), sum = relaySummary(run);
  const ms = (t: number | null) => (t === null ? NaN : t * 1e3);

  it('has a pull-in and a drop-out voltage far apart (hysteresis)', () => {
    const { pull, drop } = relayStatic();
    expect(pull).toBeCloseTo(15.2, 1);
    expect(drop).toBeCloseTo(3.6, 1);
  });

  it('closes 6.6 ms after switch-on, bounces 3 times, settles at 8.2 ms', () => {
    expect(ms(sum.firstTouch)).toBeCloseTo(6.6, 1);
    expect(sum.bounces).toBe(3);
    expect(ms(sum.settled)).toBeCloseTo(8.2, 1);
  });

  // The mockup's prose says −115 V; its own model (and this port, step for step) computes −116.65 V: the current at
  // switch-off (29.16 mA, still rising: L / R ≈ 19 ms) times the 4 kΩ quench resistor.
  it('releases 3.4 ms after switch-off with a ≈ −117 V spike across the quench resistor', () => {
    expect(ms(sum.release)).toBeCloseTo(3.4, 1);
    expect(sum.spike).toBeCloseTo(-116.65, 1);
  });

  it('never pulls in below its pull-in voltage', () => {
    const low = relaySummary(relaySim(14));
    expect(low.firstTouch).toBeNull();
    expect(low.settled).toBeNull();
    expect(low.bounces).toBe(0);
    expect(relaySim(14).s.every((q) => !q.closed && q.x === 0)).toBe(true);
  });

  it('keeps the simulator constants equal to the model', () => {
    expect(RELAY_STEP_MS).toBe(Math.round(ms(sum.settled) * 10) / 10);
    expect(RELAY_COIL_POWER).toBeCloseTo(1.44, 9);
    expect(sum.power).toBeCloseTo(RELAY_COIL_POWER, 9);
  });

  it('samples every 0.1 ms and the contact is open before switch-on and after release', () => {
    expect(run.s).toHaveLength(Math.round(T_END / 1e-4) + 1);
    expect(run.s.filter((q) => q.t < T_ON).every((q) => !q.closed && q.i === 0)).toBe(true);
    expect(run.s.at(-1)!.closed).toBe(false);
    expect(run.ev.at(-1)!.t).toBeGreaterThan(T_OFF);
  });
});
