import { describe, expect, it } from 'vitest';
import { RELAY, RELAY_COIL_POWER, RELAY_STEP_MS, RELAY_SUPPLY, SETTLED_WINDOW, coilTau, relaySim, relayStatic, relaySummary, T_END, T_OFF, T_ON } from '../src/phys/relay';

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

// Batch 24: the switch-off instant is a parameter, and the close-up quotes the model's own L / R.
describe('relay: switch-off window and coil time constant', () => {
  const ms = (t: number | null) => (t === null ? NaN : t * 1e3);
  it('L / R is 3.1 ms with the armature open and 19 ms closed (not the 3.6 ms the chapter once quoted)', () => {
    expect(coilTau(0) * 1e3).toBeCloseTo(3.14, 1);
    expect(coilTau(RELAY.travel) * 1e3).toBeCloseTo(18.85, 1);
  });

  it('the chapter run switches off at 15 ms with 29 mA through the 4 kΩ quench resistor', () => {
    const sum = relaySummary(relaySim(RELAY_SUPPLY));
    expect(sum.iOff).toBeCloseTo(0.02916, 4);
    expect(sum.spike).toBeCloseTo(-sum.iOff * RELAY.Rq, 6);
  });

  it('a settled coil (60 mA) switched off at 60 ms gives about −240 V and a release a little longer than the 15 ms run', () => {
    const run = relaySim(RELAY_SUPPLY, RELAY, SETTLED_WINDOW), sum = relaySummary(run);
    expect(run.tOff).toBe(SETTLED_WINDOW.tOff);
    expect(sum.iOff).toBeCloseTo(RELAY_SUPPLY / RELAY.Rc, 2);
    expect(sum.spike).toBeCloseTo(-239.5, 0);
    expect(ms(sum.release)).toBeGreaterThan(3.4);
    expect(ms(sum.release)).toBeLessThan(6);
    // the switch-on half is the same run: nothing quoted for the step changes
    expect(ms(sum.settled)).toBeCloseTo(8.2, 1);
    expect(run.s).toHaveLength(Math.round(SETTLED_WINDOW.tEnd / 1e-4) + 1);
  });
});
