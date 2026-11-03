import { describe, expect, it } from 'vitest';
import { curve, metrics, MOBILITY_RATIO, point, strength, vout } from '../src/phys/inverter';
import { VDD } from '../src/widgets/mosphys';

describe('inverter transfer curve', () => {
  it('swings rail to rail and falls monotonically', () => {
    const c = curve(1);
    expect(c[0].vout).toBeCloseTo(VDD, 6);
    expect(c[c.length - 1].vout).toBeCloseTo(0, 6);
    for (let i = 1; i < c.length; i++) expect(c[i].vout).toBeLessThanOrEqual(c[i - 1].vout + 1e-9);
  });
  it('a matched pair switches at VDD / 2 with equal noise margins', () => {
    const m = metrics(strength(MOBILITY_RATIO));
    expect(m.vm).toBeCloseTo(VDD / 2, 4);
    expect(m.nmL).toBeCloseTo(m.nmH, 3);
    expect(m.vil).toBeLessThan(m.vm);
    expect(m.vih).toBeGreaterThan(m.vm);
    expect(m.gain).toBeGreaterThan(5);
  });
  it('a stronger PMOS moves VM up; both devices conduct at VM', () => {
    const ms = [1, 2.5, 4].map((w) => metrics(strength(w)).vm);
    expect(ms[0]).toBeLessThan(ms[1]);
    expect(ms[1]).toBeLessThan(ms[2]);
    const p = point(metrics(1).vm, 1);
    expect([p.n, p.p]).toEqual(['sat', 'sat']);
  });
  it('VM solves Vout(Vin) = Vin', () => {
    const k = strength(1.5), m = metrics(k);
    expect(vout(m.vm, k)).toBeCloseTo(m.vm, 5);
  });
});
