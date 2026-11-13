// The diaphragm valve in 3D: its force balance held to the site's faucet and column models, and its drawing to the balance.
import { describe, expect, it } from 'vitest';
import { current, VDD, VT } from '../src/widgets/mosphys';
import { biasLink } from '../src/widgets/mosshare';
import { COLUMN_VT, columnSettle, columnStep, faucetOpen, fetWater, openings } from '../src/widgets/water';
import {
  CAP_Y, DIA_Y, LEVEL_H, ONE, PAIR, TRAVEL, cracking, diaphragmY, lift, netPressure, opening, preload, rate, span, springForce, springLen, swept,
  springPoints, type OneValve, type ValvePose,
} from '../src/widgets/valve3dparts';

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

import { CH_W, channelCharge, newChannelTex, paintChannel, springGeo, valveModel, valvePose } from '../src/widgets/valve3dkit';

describe('the valve model (valve3dkit.ts)', () => {
  const one = (o: Partial<OneValve> = {}, g = 0.5, q: Partial<ValvePose> = {}): ValvePose => ({ valves: [{ kind: 'n', cx: 0, open: 0.5, g, left: 1, right: 0.2, flow: 0.5, ...o }], gateQ: 0, phase: 0, g, x0: -50, x1: 50, ...q });
  const pair: ValvePose = { valves: [
    { kind: 'p', cx: -30, open: 0.4, g: 0.5, left: 1, right: 0.5, flow: 0.4 }, { kind: 'n', cx: 30, open: 0.4, g: 0.5, left: 0.5, right: 0, flow: 0.4 }],
  gateQ: 0, phase: 0, g: 0.5, x0: -80, x1: 80 };
  const model = (p: ValvePose) => valveModel({ pose: p, channel: newChannelTex() });
  it('the plunger and diaphragm rise by the lift; the spring shortens and stays inside its cap', () => {
    for (const open of [0, 0.5, 1]) expect(valvePose(one({ open })).get('lift0')![13]).toBeCloseTo(open * TRAVEL, 9);
    const top = (open: number) => valvePose(one({ open })).get('spring0')![13] + springGeo(springLen(open * TRAVEL), 'full').max[1];
    expect(springLen(TRAVEL)).toBeLessThan(springLen(0));
    for (const open of [0, 0.5, 1]) expect(top(open)).toBeCloseTo(CAP_Y + 0.5, 1); // the wire's centre runs from the plate up to the cap
    expect(springGeo(springLen(0), 'full').positions.length).toBe(springGeo(springLen(TRAVEL), 'full').positions.length);
    expect(diaphragmY(0)).toBe(DIA_Y);
    expect(CAP_Y - diaphragmY(TRAVEL)).toBeGreaterThan(10);
  });
  it('the gate pellet shows only while the diaphragm moves', () => {
    expect(valvePose(one({}, 0.5, { gateQ: 0 })).get('pellet')![5]).toBeLessThan(1e-3);
    expect(valvePose(one({}, 0.5, { gateQ: 0.6, phase: 0.3 })).get('pellet')![5]).toBe(1);
    expect(valvePose(one({}, 0.5, { gateQ: -0.6, phase: 0.3 })).get('pellet')![5]).toBe(1);
  });
  it('the water through the gap is the gap tall, and needs water upstream and a lift', () => {
    expect(valvePose(one({ open: 0.5 })).get('chan0')![5]).toBeCloseTo(0.5 * TRAVEL, 9);
    expect(valvePose(one({ left: 0 })).get('chan0')![5]).toBeLessThan(1e-3);
    expect(valvePose(one({ open: 0 })).get('chan0')![5]).toBeLessThan(1e-3);
  });
  it('the channel’s charge: even with no tank, thinning towards the drain, and pinched off at the drain end in saturation', () => {
    expect(channelCharge(0.5, 0, 0.7)).toBeCloseTo(1, 12);
    expect(channelCharge(0.5, 0.2, 1)).toBeGreaterThan(0.2);
    expect(channelCharge(0.5, 0.2, 1)).toBeLessThan(channelCharge(0.5, 0.2, 0));
    expect(channelCharge(0.5, 0.5, 1)).toBeCloseTo(0, 12);
    expect(channelCharge(0.5, 0.9, 1)).toBeCloseTo(0, 12);
    expect(channelCharge(0.5, 0.9, 0.5)).toBeCloseTo(Math.sqrt(0.5), 12);
    expect(channelCharge(-0.1, 0.3, 0.2)).toBe(0);
    const tex = newChannelTex();
    paintChannel(tex, 0.5, 0.9, 1);
    const g = (i: number) => tex.pixels[i * 4 + 1];
    expect(g(CH_W - 1)).toBeGreaterThan(g(0)); // u = 1 the source end holds charge, u = 0 the drain end has none
  });
  it('the pair draws both valves with finite parts and named labels', () => {
    const m = model(pair), groups = new Set(m.items.map((i) => i.group));
    for (const it of m.items) for (const v of it.geo.positions) expect(Number.isFinite(v)).toBe(true);
    expect(m.anchors!.map((x) => x.text)).toEqual(expect.arrayContaining(['PMOS valve', 'NMOS valve', 'spring', 'diaphragm', 'plunger']));
    for (const x of m.anchors!) expect(groups.has(x.on!)).toBe(true);
    expect(new Set(m.anchors!.map((x) => x.text)).size).toBe(m.anchors!.length);
    expect(valvePose(pair).has('upper0')).toBe(true); // the PMOS valve's gate water is above its diaphragm
  });
  it('the one valve names source, drain, channel and Vt, the tank label at the tank’s level', () => {
    const at = (left: number) => model(one({ left })).anchors!.find((x) => x.text === 'drain: tank')!;
    const txt = model(one({ left: 0.5 })).anchors!.map((x) => x.text);
    expect(txt).toEqual(expect.arrayContaining(['drain: tank', 'source: basin, 0 V', 'channel: the gap', 'spring: preload = Vt', 'diaphragm (gate)']));
    expect(at(0.5).p[1]).toBeGreaterThan(at(0.2).p[1]);
    expect(valvePose(one({ left: 0.5 })).get('w_left')![5]).toBeCloseTo(LEVEL_H * 0.5, 9);
  });
  it('the lift does not depend on the tank, the flow does, in the chapter’s regions', () => {
    const ov = 1.2 - VT;
    for (const vd of [0.1, ov - 0.01, ov + 0.01, VDD]) {
      expect(fetWater(1.2, vd).opening).toBeCloseTo(fetWater(1.2, VDD).opening, 12);
      expect(fetWater(1.2, vd).kind).toBe(vd < ov ? 'lin' : 'sat');
      expect(fetWater(1.2, vd).id).toBeCloseTo(current(ov, vd).id, 9);
    }
    expect(fetWater(1.2, 0.2).flow).toBeLessThan(fetWater(1.2, 0.5).flow);
    expect(fetWater(1.2, ov + 0.2).flow).toBeCloseTo(fetWater(1.2, VDD).flow * (1 + 0.05 * (ov + 0.2)) / (1 + 0.05 * VDD), 9);
  });
  it('the spring is a helix: turns round the axis, rising from the plate to the cap', () => {
    const pts = springPoints(0, 29, CAP_Y);
    expect(pts[0]).toEqual([0, 29, 0]);
    expect(pts.at(-1)).toEqual([0, CAP_Y, 0]);
    const mid = pts.slice(1, -1);
    for (const q of mid) expect(Math.hypot(q[0], q[2])).toBeCloseTo(4.5, 9);
    for (let i = 1; i < mid.length; i++) expect(mid[i][1]).toBeGreaterThan(mid[i - 1][1]);
  });
  it('the valve shares its bias with the widget above', () => {
    const link = biasLink(1.2, 0.3), a = {}, seen: number[][] = [];
    link.follow(a, (g, d) => seen.push([g, d]));
    link.set(1.0, 0.6, {});
    expect(seen).toEqual([[1.0, 0.6]]);
  });
});
