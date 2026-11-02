import { describe, expect, it } from 'vitest';
import { VDD_VOLTS, VT_VOLTS, WEAK_H, weakLevel } from '../src/sim/switchsim';
import { LOOP, loopAmps } from '../src/widgets/basics';
import { current, VDD, VT } from '../src/widgets/mosphys';
import {
  columnSettle, columnStep, columnWords, COLUMN_VT, faucetOpen, fetWater, fetWords, loopWater, openings, pointAlong, polyLength, wasted, weakCapVolts,
  type ColumnIn,
} from '../src/widgets/water';
import { alongQuat } from '../src/widgets/waterkit';
import { quatRotate } from '../src/gl/math';

const col = (o: Partial<ColumnIn> = {}): ColumnIn => ({ vin: 0, short: false, weak: false, ...o });

describe('water: the loop', () => {
  it('shares the widget\u2019s numbers', () => {
    const on = loopWater({ closed: true, cut: false, lamps: 1 });
    expect(on.amps).toBeCloseTo(loopAmps(1), 12);
    expect(on.amps).toBeCloseTo(0.1, 12);
    expect(on.vLamp).toBeCloseTo(1.5, 12);
    expect(on.power).toBeCloseTo(0.15, 12);
    expect(on.tank).toBeCloseTo(LOOP.volts / 3, 12);
    const two = loopWater({ closed: true, cut: false, lamps: 2 });
    expect(two.amps).toBeCloseTo(0.05, 12);
    expect(two.power).toBeCloseTo(0.05 * 0.05 * 15, 12);
    expect(two.bore).toBeLessThan(1);
  });
  it('a valve shut anywhere stops everything', () => {
    for (const st of [{ closed: false, cut: false, lamps: 1 }, { closed: true, cut: true, lamps: 1 }, { closed: false, cut: true, lamps: 2 }]) {
      const m = loopWater(st);
      expect([m.amps, m.power, m.dropSpeed, m.wheelRate]).toEqual([0, 0, 0, 0]);
    }
  });
  it('drops follow the current, the wheel the power', () => {
    const a = loopWater({ closed: true, cut: false, lamps: 1 }), b = loopWater({ closed: true, cut: false, lamps: 2 });
    expect(b.dropSpeed / a.dropSpeed).toBeCloseTo(b.amps / a.amps, 12);
    expect(b.wheelRate / a.wheelRate).toBeCloseTo(b.power / a.power, 12);
  });
});

describe('water: the faucet', () => {
  it('flow is mosphys.current()', () => {
    for (const vg of [0, 0.3, 0.45, 0.9, 1.35, 1.8]) for (const vd of [0, 0.2, 0.45, 0.9, 1.8]) {
      const f = fetWater(vg, vd), c = current(vg - VT, vd);
      expect(f.id).toBe(c.id);
      expect(f.kind).toBe(c.kind);
      expect(f.flow).toBeGreaterThanOrEqual(0);
      expect(f.flow).toBeLessThanOrEqual(1 + 1e-12);
    }
  });
  it('handle opening runs from the threshold to VDD, the tank level is V_DS', () => {
    expect(fetWater(VT, 0.5).opening).toBe(0);
    expect(fetWater(VDD, 0.5).opening).toBeCloseTo(1, 12);
    expect(fetWater(0.9, 0.9).level).toBeCloseTo(0.5, 12);
    expect(fetWater(VDD, VDD).flow).toBeCloseTo(1, 12);
  });
  it('regions: shut below Vt, choked once Vds passes the overdrive', () => {
    expect(fetWater(0.3, 1.8).kind).toBe('cut');
    expect(fetWater(0.9, 0.2).kind).toBe('lin');
    const sat = fetWater(0.9, 0.5);
    expect(sat.kind).toBe('sat');
    expect(sat.choked).toBe(true);
    expect(fetWords(sat)).toMatch(/choked/);
    // choked: lowering the basin (more V_DS) adds only the lambda slope
    expect(fetWater(0.9, 1.8).id / sat.id).toBeLessThan(1.1);
  });
});

describe('water: two faucets on one column', () => {
  it('uses the site\u2019s supply and threshold', () => {
    expect(COLUMN_VT).toBeCloseTo(VT_VOLTS / VDD_VOLTS, 12);
    expect(faucetOpen(COLUMN_VT)).toBe(0);
    expect(faucetOpen(1)).toBe(1);
  });
  it('a settled input drives the column to a rail and nothing runs through', () => {
    for (const [vin, rail] of [[0, 1], [1, 0]] as const) {
      const out = columnSettle(0.5, col({ vin }));
      expect(out).toBeCloseTo(rail, 6);
      const s = columnStep(out, col({ vin }), 0);
      expect(wasted(s)).toBeLessThan(1e-6);
    }
  });
  it('halfway, both are partly open and water runs straight through', () => {
    const c = col({ vin: 0.5 }), out = columnSettle(0, c), s = columnStep(out, c, 0);
    expect(out).toBeCloseTo(0.5, 6);
    expect(s.p).toBeGreaterThan(0.02);
    expect(s.n).toBeGreaterThan(0.02);
    expect(wasted(s)).toBeGreaterThan(0.1);
    expect(columnWords(s, c).tone).toBe('warn');
  });
  it('both open (short): the column sits at half and the drain takes it all', () => {
    const c = col({ short: true }), out = columnSettle(1, c), s = columnStep(out, c, 0);
    expect(out).toBeCloseTo(0.5, 6);
    expect(wasted(s)).toBeCloseTo(0.5, 6);
    expect(columnWords(s, c).tone).toBe('bad');
  });
  it('an NMOS on top stops at VDD \u2212 Vt = 0.80 V of 1.1 V, the weak H the switch solver names', () => {
    const c = col({ weak: true, vin: 0 }), out = columnSettle(0, c);
    expect(out * VDD_VOLTS).toBeCloseTo(weakCapVolts(), 4);
    expect(out * VDD_VOLTS).toBeCloseTo(0.8, 4);
    expect(out).toBeCloseTo(weakLevel(WEAK_H), 4);
    // the top faucet has shut itself well before the column is full
    expect(openings(c, out).p).toBeLessThan(1e-3);
    expect(columnWords(columnStep(out, c, 0), c).text).toMatch(/weak 1: H · 0\.80 V/);
    // it never passes the cap, however long it runs
    let o = 0;
    for (let i = 0; i < 5000; i++) o = columnStep(o, c, 0.05).out;
    expect(o).toBeLessThanOrEqual(weakLevel(WEAK_H) + 1e-9);
    // the bottom NMOS still empties it
    expect(columnSettle(out, col({ weak: true, vin: 1 }))).toBeCloseTo(0, 6);
  });
  it('the normal PMOS on top reaches the full rail', () => {
    expect(columnSettle(0, col({ vin: 0 }))).toBeCloseTo(1, 6);
  });
});

describe('water: paths', () => {
  const path: [number, number, number][] = [[0, 0, 0], [3, 0, 0], [3, 4, 0]];
  it('length and a point along it, wrapping', () => {
    expect(polyLength(path)).toBe(7);
    expect(pointAlong(path, 1.5)).toEqual([1.5, 0, 0]);
    expect(pointAlong(path, 5)).toEqual([3, 2, 0]);
    expect(pointAlong(path, 7 + 1.5)).toEqual([1.5, 0, 0]);
  });
  it('a tube turns the cylinder axis onto its direction', () => {
    for (const d of [[1, 0, 0], [0, -1, 0], [0, 1, 0], [1, 2, 0], [0, 0, 1]] as [number, number, number][]) {
      const v = quatRotate(alongQuat(d), [0, 1, 0]), l = Math.hypot(...d);
      v.forEach((x, i) => expect(x).toBeCloseTo(d[i] / l, 6));
    }
  });
});
