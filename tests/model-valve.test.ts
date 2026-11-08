// The diaphragm valve in 3D: its force balance held to the site's faucet and column models, and its drawing to the balance.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { flatFaces } from '../src/gl/parts';
import { VDD, VT } from '../src/widgets/mosphys';
import { COLUMN_VT, columnSettle, columnStep, faucetOpen, fetWater, openings } from '../src/widgets/water';
import {
  CAP_Y, DIA_Y, ONE, PAIR, SEAT_Y, TRAVEL, cracking, diaphragmY, lift, netPressure, opening, preload, rate, span, springForce, springLen, swept,
  valveAnchors, valveFigure, type OneValve, type ValvePalette, type ValvePose,
} from '../src/widgets/valve3dparts';

const G: RGB = [0.5, 0.5, 0.5], W: RGBA = [0.2, 0.4, 0.9, 0.5];
const P: ValvePalette = { body: G, metal: G, seat: G, disc: [1, 0, 0], spring: G, diaphragm: G, water: W, gate: W, glass: W, jet: G };
const ramp = Array.from({ length: 41 }, (_, i) => i / 40);

describe('the valve mechanics', () => {
  it('cracking pressure is the preload over the area, and is the threshold of the site’s models', () => {
    expect(cracking(ONE)).toBeCloseTo(VT / VDD, 12);
    expect(cracking(PAIR)).toBeCloseTo(COLUMN_VT, 12);
    expect(cracking(ONE)).toBeCloseTo(preload(ONE) / ONE.area, 12);
  });
  it('nothing lifts at or below the cracking pressure', () => {
    for (const v of [ONE, PAIR]) for (const g of ramp.filter((g) => g <= cracking(v))) expect(lift(v, g)).toBe(0);
    expect(lift(ONE, cracking(ONE) + 0.01)).toBeGreaterThan(0);
  });
  it('the lift is the net force over the spring rate, up to the travel stop', () => {
    for (const v of [ONE, PAIR]) for (const g of ramp) {
      const x = lift(v, g);
      if (x > 0 && x < v.travel) expect(v.area * g - preload(v)).toBeCloseTo(rate(v) * x, 10);
      if (x > 0) expect(springForce(v, x)).toBeLessThanOrEqual(v.area * Math.max(g, 1) + 1e-9);
    }
    expect(lift(ONE, 1)).toBeCloseTo(TRAVEL, 12);
    expect(lift(ONE, 1.5)).toBe(TRAVEL);
    expect(cracking(ONE) + span(ONE)).toBeCloseTo(1, 12); // preload + span = the full swing
  });
  it('one valve opens as fetWater’s handle, at every gate voltage', () => {
    for (const g of ramp) expect(opening(ONE, 'n', g)).toBeCloseTo(fetWater(g * VDD, VDD).opening, 12);
    expect(opening(ONE, 'n', VT / VDD - 1e-6)).toBe(0);
  });
  it('the pair opens as columnStep’s p and n, and the NMOS one is the faucetOpen', () => {
    for (const vin of ramp) {
      const s = columnStep(0.4, { vin, short: false, weak: false }, 0), o = openings({ vin, short: false, weak: false }, 0.4);
      expect(opening(PAIR, 'n', vin)).toBeCloseTo(s.n, 12);
      expect(opening(PAIR, 'p', vin)).toBeCloseTo(s.p, 12);
      expect(opening(PAIR, 'n', vin)).toBeCloseTo(o.n, 12);
      expect(opening(PAIR, 'n', vin)).toBeCloseTo(faucetOpen(vin), 12);
    }
  });
  it('the PMOS valve is pressure-closed: wide open at 0, shut at 1 - V_T', () => {
    expect(netPressure('p', 0)).toBe(1);
    expect(opening(PAIR, 'p', 0)).toBe(1);
    expect(opening(PAIR, 'p', 1 - COLUMN_VT + 1e-9)).toBe(0);
    expect(opening(PAIR, 'p', 1)).toBe(0);
    let prev = 2;
    for (const g of ramp) { const o = opening(PAIR, 'p', g); expect(o).toBeLessThanOrEqual(prev + 1e-12); prev = o; }
  });
  it('the output level the pair settles at is columnSettle’s, and a shut pair holds the rails', () => {
    for (const vin of [0, COLUMN_VT * 0.9, 0.5, 1 - COLUMN_VT * 0.9, 1]) {
      const out = columnSettle(0.5, { vin, short: false, weak: false });
      const s = columnStep(out, { vin, short: false, weak: false }, 0);
      expect(opening(PAIR, 'p', vin)).toBeCloseTo(s.p, 12);
      expect(s.iTop).toBeCloseTo(s.iBot, 6); // settled: what comes in goes out
    }
    expect(columnSettle(0.5, { vin: 0, short: false, weak: false })).toBeCloseTo(1, 6);
    expect(columnSettle(0.5, { vin: 1, short: false, weak: false })).toBeCloseTo(0, 6);
  });
  it('a dead-ended gate holds a volume that is the diaphragm’s sweep and nothing else', () => {
    expect(swept(ONE, 0)).toBe(0);
    expect(swept(ONE, lift(ONE, 0.6))).toBeCloseTo(ONE.area * lift(ONE, 0.6), 12);
    expect(swept(ONE, lift(ONE, 0.6))).toBe(swept(ONE, lift(ONE, 0.6))); // constant at rest: a steady gate moves no more water
  });
});

describe('the valve drawing', () => {
  const pose = (open: number, kind: 'n' | 'p' = 'n', o: Partial<ValvePose> = {}): ValvePose => ({
    valves: [{ kind, cx: 0, open, g: 0.5, left: 1, right: 0.2, flow: open } as OneValve], gateQ: 0, phase: 0, g: 0.5, x0: -50, x1: 50, ...o,
  });
  const disc = (p: ValvePose) => valveFigure(p, P, ONE).find((q) => q.kind === 'cyl' && q.color === P.disc)!;
  it('the plunger sits on its seat below cracking and rises with the lift', () => {
    const d0 = disc(pose(0)), d1 = disc(pose(0.5)), d2 = disc(pose(1));
    expect(d0.pos[1] - d0.scale![1] / 2).toBeCloseTo(SEAT_Y, 9);
    expect(d1.pos[1] - d0.pos[1]).toBeCloseTo(0.5 * TRAVEL, 9);
    expect(d2.pos[1] - d0.pos[1]).toBeCloseTo(TRAVEL, 9);
  });
  it('the spring compresses as the diaphragm rises, and stays inside its cap', () => {
    expect(diaphragmY(0)).toBe(DIA_Y);
    expect(springLen(TRAVEL)).toBeLessThan(springLen(0));
    for (const open of [0, 0.5, 1]) for (const kind of ['n', 'p'] as const) for (const part of valveFigure(pose(open, kind), P, ONE)) {
      expect(part.pos.every(Number.isFinite)).toBe(true);
      expect(part.pos[1] + part.scale![1] / 2).toBeLessThanOrEqual(80);
    }
    expect(CAP_Y - diaphragmY(TRAVEL)).toBeGreaterThan(10);
  });
  it('the gate pellet exists only while the diaphragm moves', () => {
    const n = (q: number) => valveFigure(pose(0.5, 'n', { gateQ: q, phase: 0.3 }), P, ONE).length;
    expect(n(0.6)).toBe(n(0) + 1);
    expect(n(-0.6)).toBe(n(0) + 1);
  });
  it('the pair draws both valves with finite parts and labels, and the flat view shows faces', () => {
    const pair: ValvePose = { valves: [
      { kind: 'p', cx: -30, open: 0.4, g: 0.5, left: 1, right: 0.5, flow: 0.4 }, { kind: 'n', cx: 30, open: 0.4, g: 0.5, left: 0.5, right: 0, flow: 0.4 }],
    gateQ: 0, phase: 0, g: 0.5, x0: -80, x1: 80 };
    const parts = valveFigure(pair, P, PAIR), anchors = valveAnchors(pair);
    expect(parts.length).toBeGreaterThan(60);
    expect(flatFaces(parts, 0.3, 0.25).length).toBeGreaterThan(100);
    expect(anchors.map((a) => a.text)).toEqual(expect.arrayContaining(['PMOS valve', 'NMOS valve', 'spring', 'diaphragm', 'plunger']));
    expect(new Set(anchors.map((a) => a.text)).size).toBe(anchors.length);
  });
});
