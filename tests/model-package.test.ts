// The opened package (widgets/package3dkit.ts): a 74HC595 in SOIC-16, its outline held to the SOT109-1 table, its pins to
// the data sheet, its wires to phys/line.ts's groundBounce through the inductance of the length drawn.
import { describe, expect, it } from 'vitest';
import { groundBounce, VIH, VIL, VIO } from '../src/phys/line';
import { padSwing } from '../src/widgets/line';
import {
  BODY_D, BODY_E, BODY_H, BODY_TOP, DIE_TOP, FOOT, LEAD_T, LEAD_W, LEN_RAIL, OUTPUT_PINS, PIN_NAMES, PITCH, SOT109, SPAN, STANDOFF, WIRE_R,
  bondL, bonds, bounceOf, kindOf, packageModel, pinX, railL, sideOf, verdictOf, type PkState,
} from '../src/widgets/package3dkit';
import { boundsOfNamed } from '../src/gl/kit/scene';
import type { Vec3 } from '../src/gl/math';

const st = (n: number, g = 1, rise = 1, edge: 'fall' | 'rise' = 'fall'): PkState => ({ n, g, rise, edge });
const within = (v: number, r: readonly [number, number]) => { expect(v).toBeGreaterThanOrEqual(r[0]); expect(v).toBeLessThanOrEqual(r[1]); };

describe('the outline is SOT109-1 (SO16, JEDEC MS-012)', () => {
  it('body, span, pitch, standoff, lead and foot inside the table', () => {
    within(BODY_D, SOT109.D); within(BODY_E, SOT109.E); within(SPAN, SOT109.HE); within(BODY_H, SOT109.A2); within(STANDOFF, SOT109.A1);
    within(LEAD_W, SOT109.bp); within(LEAD_T, SOT109.c); within(FOOT, SOT109.Lp);
    expect(PITCH).toBe(1.27);
    expect(BODY_TOP).toBeLessThanOrEqual(SOT109.A);
    expect(SOT109).toMatchObject({ D: [9.8, 10.0], E: [3.8, 4.0], HE: [5.8, 6.2], A1: [0.10, 0.25], A2: [1.25, 1.45], bp: [0.36, 0.49], c: [0.19, 0.25], Lp: [0.4, 1.0] });
  });
  it('the drawn model measures that: body and leads from the geometry, not the constants', () => {
    const m = packageModel(st(8));
    const body = boundsOfNamed(m, ['mould compound']), leads = boundsOfNamed(m, ['leads']);
    expect(body.max[0] - body.min[0]).toBeCloseTo(BODY_D, 2);
    expect(body.max[2] - body.min[2]).toBeCloseTo(BODY_E, 2);
    expect(body.max[1]).toBeCloseTo(BODY_TOP, 2);
    expect(body.min[1]).toBeCloseTo(STANDOFF, 2);
    expect(leads.max[2] - leads.min[2]).toBeCloseTo(SPAN, 1);
    expect(leads.max[0] - leads.min[0]).toBeCloseTo(7 * PITCH + LEAD_W, 2);
  });
  it('pin 1 at the front left, numbered anticlockwise seen from above', () => {
    expect(sideOf(1)).toBe(1); expect(sideOf(16)).toBe(-1);
    expect(pinX(1)).toBeLessThan(pinX(8)); expect(pinX(9)).toBeGreaterThan(pinX(16));
    expect(pinX(1)).toBeCloseTo(pinX(16), 9); expect(pinX(8)).toBeCloseTo(pinX(9), 9);
  });
});

describe('the pins are the 74HC595\'s', () => {
  it('Q1-Q7 on 1-7, GND 8, Q7S 9, MR 10, SHCP 11, STCP 12, OE 13, DS 14, Q0 15, VCC 16', () => {
    expect(PIN_NAMES.join(' ')).toBe('Q1 Q2 Q3 Q4 Q5 Q6 Q7 GND Q7S MR SHCP STCP OE DS Q0 VCC');
    const kinds = Array.from({ length: 16 }, (_, i) => kindOf(i + 1));
    expect(kinds.filter((k) => k === 'out')).toHaveLength(8);
    expect(kinds.filter((k) => k === 'in')).toHaveLength(5);
    expect(kindOf(8)).toBe('gnd'); expect(kindOf(16)).toBe('vcc'); expect(kindOf(9)).toBe('ser');
    expect(OUTPUT_PINS.map((k) => PIN_NAMES[k - 1])).toEqual(['Q0', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']);
  });
});

describe('the wires are the inductance', () => {
  it('the chapter\'s quoted case: 8 outputs, the 2.8 mm ground wire (3 nH), 1 ns is 0.58 V', () => {
    const g = bonds(st(8)).find((b) => b.pin === 8)!;
    expect(g.len).toBeCloseTo(LEN_RAIL, 3);
    expect(g.nH).toBeCloseTo(3, 1);
    expect(bounceOf(st(8)).toFixed(2)).toBe('0.58');
  });
  it('is groundBounce on a pad\'s current through the rail\'s wires in parallel, at several settings', () => {
    for (const [n, g, r] of [[1, 1, 1], [8, 1, 1], [8, 2, 0.1], [5, 3, 2], [8, 3, 4]] as const) {
      const ws = bonds(st(n, g, r)).filter((b) => b.pin === 8);
      expect(ws).toHaveLength(g);
      const L = 1 / ws.reduce((s, b) => s + 1 / bondL(b.len), 0);
      expect(railL(st(n, g, r))).toBeCloseTo(L, 12);
      expect(bounceOf(st(n, g, r))).toBe(groundBounce(n, padSwing(), r, L));
    }
  });
  it('every wire\'s length is its drawn polyline\'s, and the corners\' are the longest', () => {
    const bs = bonds(st(8));
    for (const b of bs) {
      const poly = b.pts.slice(1).reduce((t, q, i) => t + Math.hypot(q[0] - b.pts[i][0], q[1] - b.pts[i][1], q[2] - b.pts[i][2]), 0);
      expect(b.len).toBeCloseTo(poly, 9);
      expect(b.nH).toBeCloseTo(bondL(b.len), 12);
    }
    const len = (k: number) => bs.find((b) => b.pin === k)!.len;
    for (const k of [2, 3, 4, 5, 6, 7, 10, 11, 12, 13, 14, 15]) expect(len(k)).toBeLessThan(len(8));
    expect(len(1)).toBeCloseTo(len(8), 6); expect(len(9)).toBeCloseTo(len(8), 6); expect(len(16)).toBeCloseTo(len(8), 6);
    // the chapter says 1 to 3 mm: none shorter than half a millimetre, none past 3
    for (const b of bs) { expect(b.len).toBeGreaterThan(0.5); expect(b.len).toBeLessThanOrEqual(3); }
  });
  it('a loop rises at least 100 µm over its pad and comes down on its finger', () => {
    for (const b of bonds(st(8, 3))) {
      const top = Math.max(...b.pts.map((p) => p[1]));
      expect(top - b.pts[0][1]).toBeGreaterThan(0.1);
      expect(b.pts[b.pts.length - 1][1]).toBeLessThan(DIE_TOP);
    }
  });
  it('the wire is drawn at its real 25 µm', () => { expect(2 * WIRE_R).toBeCloseTo(0.025, 9); });
  it('lit outputs equal the outputs switching; the active rail lights on its edge', () => {
    for (const n of [1, 4, 8]) {
      const bs = bonds(st(n, 2));
      expect(bs.filter((b) => b.kind === 'out' && b.lit)).toHaveLength(n);
      expect(bs.filter((b) => b.lit && b.kind === 'gnd')).toHaveLength(2);
      expect(bs.filter((b) => b.lit && b.kind === 'vcc')).toHaveLength(0);
      expect(bonds(st(n, 2, 1, 'rise')).filter((b) => b.lit && b.kind === 'vcc')).toHaveLength(2);
    }
    expect(bounceOf(st(8, 1, 1, 'rise'))).toBeCloseTo(bounceOf(st(8)), 9);
  });
  it('the over-limit flag is the panel\'s: VIL, VIH, then the supply', () => {
    expect(verdictOf(VIL - 1e-6)).toBe('ok'); expect(verdictOf(VIL)).toBe('undefined');
    expect(verdictOf(VIH)).toBe('high'); expect(verdictOf(VIO)).toBe('invalid');
    expect(verdictOf(bounceOf(st(8)))).toBe('ok');
    expect(verdictOf(bounceOf(st(8, 1, 0.2)))).not.toBe('ok');
  });
});

describe('nothing touches what it should not', () => {
  // distance between two segments in 3D (closest points, clamped)
  const segDist = (p: Vec3, q: Vec3, r: Vec3, s: Vec3): number => {
    const d1 = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], d2 = [s[0] - r[0], s[1] - r[1], s[2] - r[2]], w = [p[0] - r[0], p[1] - r[1], p[2] - r[2]];
    const a = d1[0] ** 2 + d1[1] ** 2 + d1[2] ** 2, e = d2[0] ** 2 + d2[1] ** 2 + d2[2] ** 2, b = d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2];
    const c = d1[0] * w[0] + d1[1] * w[1] + d1[2] * w[2], f = d2[0] * w[0] + d2[1] * w[1] + d2[2] * w[2];
    const den = a * e - b * b;
    let sN = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
    const tN = Math.min(1, Math.max(0, (b * sN + f) / e));
    sN = Math.min(1, Math.max(0, (b * tN - c) / a));
    return Math.hypot(w[0] + sN * d1[0] - tN * d2[0], w[1] + sN * d1[1] - tN * d2[1], w[2] + sN * d1[2] - tN * d2[2]);
  };
  it('no wire comes within two wire widths of another, with every rail wire bonded', () => {
    const bs = bonds(st(8, 3)), clear = 4 * WIRE_R;
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      let min = Infinity;
      for (let a = 0; a + 1 < bs[i].pts.length; a++) for (let c = 0; c + 1 < bs[j].pts.length; c++) min = Math.min(min, segDist(bs[i].pts[a], bs[i].pts[a + 1], bs[j].pts[c], bs[j].pts[c + 1]));
      expect(min, `pins ${bs[i].pin}.${bs[i].j} and ${bs[j].pin}.${bs[j].j}`).toBeGreaterThan(clear);
    }
  });
  it('every wire stays inside the moulding', () => {
    for (const b of bonds(st(8, 3))) for (const p of b.pts) {
      expect(Math.abs(p[0])).toBeLessThan(BODY_D / 2 - 0.2);
      expect(Math.abs(p[2])).toBeLessThan(BODY_E / 2 - 0.2);
      expect(p[1]).toBeLessThan(BODY_TOP - 0.1);
    }
  });
});
