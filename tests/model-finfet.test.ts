// Planar, fin and nanosheet: the numbers from their sources, effective width and swing in the right order, and the model
// drawn at the cited sizes with the gate wrapping 1, 3 and 4 sides.
import { describe, expect, it } from 'vitest';
import { DEVICES, IDEAL_SWING, SIDES, naturalLength, offRatio, swing, weff, weffDensity } from '../src/phys/gatecontrol';
import { FIN_X, OX, ZG, finfetModel, leakGlow, partsOf } from '../src/widgets/finfet3dkit';
import type { Geo } from '../src/gl/kit/geo';

const box = (gs: Geo[]) => gs.map((g) => ({ min: g.min, max: g.max }));

describe('gate control', () => {
  it('the cited devices: Intel 22 nm fins, IBM 2 nm sheets', () => {
    expect([DEVICES.fin.W, DEVICES.fin.H, DEVICES.fin.pitch]).toEqual([8, 34, 60]);
    expect([DEVICES.sheets.n, DEVICES.sheets.W, DEVICES.sheets.H, DEVICES.sheets.gap, DEVICES.sheets.L, DEVICES.sheets.pitch]).toEqual([3, 40, 5, 5, 12, 44]);
  });
  it('effective width: the planar top, a fin’s walls and top, every face of every sheet', () => {
    expect(weff(DEVICES.planar)).toBe(44);
    expect(weff(DEVICES.fin)).toBe(76);
    expect(weff(DEVICES.sheets)).toBe(270);
    expect(weffDensity(DEVICES.fin)).toBeCloseTo(76 / 60, 9);
    expect(weffDensity(DEVICES.sheets)).toBeGreaterThan(weffDensity(DEVICES.fin));
  });
  it('more sides, shorter natural length, a swing nearer the 60 mV limit, less off current', () => {
    const ks = ['planar', 'fin', 'sheets'] as const;
    for (let i = 1; i < 3; i++) {
      expect(naturalLength(DEVICES[ks[i]])).toBeLessThan(naturalLength(DEVICES[ks[i - 1]]));
      expect(swing(DEVICES[ks[i]])).toBeLessThan(swing(DEVICES[ks[i - 1]]));
      expect(offRatio(DEVICES[ks[i]], DEVICES.planar)).toBeLessThan(offRatio(DEVICES[ks[i - 1]], DEVICES.planar));
    }
    for (const k of ks) expect(swing(DEVICES[k])).toBeGreaterThan(IDEAL_SWING);
    expect(IDEAL_SWING).toBeCloseTo(59.5, 0);
    // a long gate recovers the ideal; a thinner oxide helps
    expect(swing(DEVICES.planar, 200)).toBeCloseTo(IDEAL_SWING, 0);
    expect(swing(DEVICES.planar, 12, 0.5)).toBeLessThan(swing(DEVICES.planar, 12, 1));
    expect(leakGlow('planar')).toBe(1);
    expect(leakGlow('sheets')).toBeLessThan(leakGlow('fin'));
  });
});

describe('the model', () => {
  it('fins and sheets at their cited sizes', () => {
    const fin = box(partsOf('fin').channel);
    expect(fin).toHaveLength(2);
    fin.forEach((b, i) => { expect(b.max[0] - b.min[0]).toBeCloseTo(8, 6); expect(b.max[1] - b.min[1]).toBeCloseTo(34, 6); expect((b.max[0] + b.min[0]) / 2).toBeCloseTo(FIN_X[i], 6); expect(b.max[2] - b.min[2]).toBeCloseTo(2 * ZG, 6); });
    expect(FIN_X[1] - FIN_X[0]).toBe(60);
    const sheets = box(partsOf('sheets').channel);
    expect(sheets).toHaveLength(3);
    sheets.forEach((b) => { expect(b.max[0] - b.min[0]).toBeCloseTo(40, 6); expect(b.max[1] - b.min[1]).toBeCloseTo(5, 6); });
    expect(sheets[1].min[1] - sheets[0].max[1]).toBeCloseTo(5, 6);
  });
  it('the dielectric wraps 1, 3 and 4 sides of each channel piece', () => {
    expect(partsOf('planar').hik).toHaveLength(1 * 1);
    expect(partsOf('fin').hik).toHaveLength(3 * 2);
    expect(partsOf('sheets').hik).toHaveLength(4 * 3);
    for (const k of ['planar', 'fin', 'sheets'] as const) expect(SIDES[k]).toBe(partsOf(k).hik.length / partsOf(k).channel.length);
    // every dielectric piece is OX thick in one direction
    for (const g of partsOf('sheets').hik) expect(Math.min(g.max[0] - g.min[0], g.max[1] - g.min[1])).toBeCloseTo(OX, 6);
  });
  it('builds for every device, on and off, cut across the gate, with five beats', () => {
    for (const k of ['planar', 'fin', 'sheets'] as const) for (const on of [true, false]) {
      const m = finfetModel(k, on);
      for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
      expect(m.cuts!.planes[0]).toEqual({ n: [0, 0, 1], d: 0 });
      expect(m.beats).toHaveLength(5);
    }
  });
});
