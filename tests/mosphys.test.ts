import { describe, expect, it } from 'vitest';
import { carrierVelocity, channelCharge, current, depletionDepth, K, pinchPoint, tween, VT } from '../src/widgets/mosphys';

// The cross-section animates these functions, so they must agree with the square-law current.
describe('MOSFET channel physics', () => {
  const xs = Array.from({ length: 101 }, (_, i) => i / 100);

  it('inversion charge is Vov at the source and Vov − Vds at the drain (linear)', () => {
    expect(channelCharge(1, 0.3, 0)).toBeCloseTo(1, 9);
    expect(channelCharge(1, 0.3, 1)).toBeCloseTo(0.7, 9);
    expect(channelCharge(1, 0, 0.5)).toBeCloseTo(1, 9);
  });

  it('pinches off at the drain end in saturation, earlier as Vds rises', () => {
    const xp = pinchPoint(0.5, 1.8);
    expect(xp).toBeLessThan(1);
    expect(xp).toBeLessThan(pinchPoint(0.5, 0.9));
    expect(pinchPoint(0.5, 0.3)).toBe(1);
    expect(channelCharge(0.5, 1.8, xp)).toBeCloseTo(0, 9);
    expect(channelCharge(0.5, 1.8, 1)).toBeCloseTo(0, 9);
    expect(channelCharge(0.5, 1.8, xp - 1e-9)).toBeCloseTo(0, 3);
    expect(channelCharge(0.5, 1.8, 0)).toBeCloseTo(0.5, 9);
  });

  it('charge never grows toward the drain, and vanishes in cut-off', () => {
    for (const [vov, vds] of [[1, 0.2], [1, 1], [0.3, 1.5], [1.35, 1.8]]) {
      const q = xs.map((x) => channelCharge(vov, vds, x));
      for (let i = 1; i < q.length; i++) expect(q[i]).toBeLessThanOrEqual(q[i - 1] + 1e-12);
    }
    for (const x of xs) expect(channelCharge(-0.1, 1, x)).toBe(0);
  });

  it('Q·dV/dx equals I/K along the channel (current continuity, linear region)', () => {
    const vov = 1.2, vds = 0.5, id = current(vov, vds).id, dx = 1e-6;
    for (const x of [0.1, 0.4, 0.8]) {
      // V(x) = Vov − Q(x)
      const dv = (channelCharge(vov, vds, x) - channelCharge(vov, vds, x + dx)) / dx;
      expect(channelCharge(vov, vds, x) * dv).toBeCloseTo(id / K, 5);
    }
  });

  it('current is (nearly) continuous where linear meets saturation', () => {
    const vov = 0.8;
    const lin = current(vov, vov - 1e-9).id, sat = current(vov, vov).id;
    expect(Math.abs(sat - lin) / lin).toBeLessThan(0.05);
  });

  it('carriers move faster where the channel is thinner, at constant current', () => {
    const id = current(1, 0.6).id;
    const q0 = channelCharge(1, 0.6, 0), q1 = channelCharge(1, 0.6, 0.9);
    expect(carrierVelocity(id, q1)).toBeGreaterThan(carrierVelocity(id, q0));
    expect(carrierVelocity(id, q0) * q0).toBeCloseTo(carrierVelocity(id, q1) * q1, 9);
    expect(carrierVelocity(0, 1)).toBe(0);
  });

  it('depletion grows until threshold, then stops', () => {
    expect(depletionDepth(0)).toBe(0);
    expect(depletionDepth(VT / 4)).toBeLessThan(depletionDepth(VT / 2));
    expect(depletionDepth(VT)).toBe(1);
    expect(depletionDepth(1.8)).toBe(1);
  });

  it('tweens start at from, end at to, and move monotonically', () => {
    const f = tween(0, 1.8, 100, 600);
    expect(f(100)).toEqual({ v: 0, done: false });
    expect(f(700)).toEqual({ v: 1.8, done: true });
    let last = -1;
    for (let t = 100; t <= 700; t += 25) { const { v } = f(t); expect(v).toBeGreaterThanOrEqual(last); last = v; }
    expect(tween(1, 0, 0, 0)(0)).toEqual({ v: 0, done: true });
  });
});
