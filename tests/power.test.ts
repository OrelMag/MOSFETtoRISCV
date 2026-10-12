// The power estimate (sim/power.ts): GateSim's toggle counts against an independent count from its trace, a
// static hazard's glitch, the capacitance model, the breakdown summing to the total, and seeded repeatability.

import { describe, expect, it } from 'vitest';
import { NAND, NOT, carrySkip, koggeStone, rca, register } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { FF_DRIVER, FF_INPUT, FF_WIRE, PowerMeter, alphaOf, energyFj, fmtEnergy, fmtPower, measurePower, netCaps, powerRefusal, powerW } from '../src/sim/power';
import type { ComponentDef } from '../src/sim/types';
import { carryVectors } from '../src/widgets/adders';

/** y = NAND(a, NOT a): always 1, but a rising a pulses y low for one delay (a static hazard). */
const HAZARD = {
  id: 't_hazard', name: 'hazard', category: 'gate',
  ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
  symbol: { kind: 'box' },
  netlist: () => ({
    pins: { a: [0, 0], y: [20, 0] },
    instances: [{ name: 'i', def: NOT, at: [4, 0] }, { name: 'g', def: NAND, at: [12, 0] }],
    nets: [
      { name: 'a', ends: ['a', 'i.a', 'g.a'] },
      { name: 'n', ends: ['i.y', 'g.b'] },
      { name: 'y', ends: ['g.y', 'y'] },
    ],
  }),
} as unknown as ComponentDef;

describe('toggle counting', () => {
  it('counts every 0 ↔ 1 change the trace reports, glitches included', () => {
    const def = rca(8);
    const sim = new GateSim(flatten(def));
    const n = sim.design.netCount;
    const seen = new Uint32Array(n), last = new Uint8Array(n);
    for (let i = 0; i < n; i++) last[i] = sim.get(i);
    sim.watch(Array.from({ length: n }, (_, i) => i));
    sim.onTrace = (net, b) => { if ((last[net] | b) === 1) seen[net]++; last[net] = b; };
    sim.countToggles();
    for (const [a, b, c] of carryVectors(8, 100)) {
      sim.setInput('a', a); sim.setInput('b', b); sim.setInput('cin', c);
      sim.settle();
    }
    expect([...sim.toggles!]).toEqual([...seen]);
    expect(seen.reduce((s, x) => s + x, 0)).toBeGreaterThan(500);
  });

  it('sees a static hazard as two glitch toggles and no settled change', () => {
    const sim = new GateSim(flatten(HAZARD));
    sim.setInput('a', 0);
    sim.settle();
    const m = new PowerMeter(sim);
    const y = sim.design.root.ports.y[0];
    sim.setInput('a', 1); sim.settle(); m.mark();
    expect(sim.get(y)).toBe(1);
    expect(m.toggles(y)).toBe(2);
    sim.setInput('a', 0); sim.settle(); m.mark();
    expect(m.toggles(y)).toBe(2); // a falling a only delays n's rise: no pulse on y
    const t = m.totals();
    // y's two toggles are glitches; a and n toggled for real
    expect(t.switched - t.functional).toBeCloseTo(2 * netCaps(sim.design)[y]);
  });
});

describe('capacitance model', () => {
  it('charges inputs driven, the driver and a wire per branch', () => {
    const d = flatten(HAZARD);
    const c = netCaps(d), p = d.root.ports;
    expect(c[p.a[0]]).toBeCloseTo(3 * (FF_INPUT + FF_WIRE)); // the NOT's two NAND inputs and g.a
    expect(c[p.y[0]]).toBeCloseTo(FF_DRIVER); // drives nothing inside
    const n = d.root.children!.get('i')!.ports.y[0];
    expect(c[n]).toBeCloseTo(FF_DRIVER + FF_INPUT + FF_WIRE);
  });
});

describe('measurePower', () => {
  it('is repeatable, splits the total among the parts, and counts glitches in a ripple adder', () => {
    const r = measurePower(rca(16), 128);
    expect(measurePower(rca(16), 128)).toEqual(r);
    expect(r.kind).toBe('vectors');
    expect(r.period).toBe(36);
    expect(r.shares.reduce((s, x) => s + x.switched, 0)).toBeCloseTo(r.switched, 6);
    expect(r.functional).toBeLessThan(r.switched);
    expect(alphaOf(r)).toBeGreaterThan(0.1);
    expect(alphaOf(r)).toBeLessThan(1);
  });

  it('clocks a register, the clock net its largest single load', () => {
    const r = measurePower(register(8), 64);
    expect(r.kind).toBe('cycles');
    expect(r.period).toBeGreaterThan(0);
    expect(r.shares[0].name).toBe('clock (clk net)');
  });

  it('pays more for a faster adder', () => {
    const e = (d: ComponentDef) => measurePower(d, 128).switched;
    expect(e(koggeStone(16))).toBeGreaterThan(e(rca(16)));
    expect(e(carrySkip(16))).toBeGreaterThan(e(rca(16)));
  });

  it('refuses what it cannot measure', () => {
    expect(powerRefusal(NAND)).not.toBe('');
    expect(powerRefusal(rca(4))).toBe('');
    expect(powerRefusal(rca(64), 100)).toMatch(/too large/);
  });
});

describe('units', () => {
  it('format energy and power', () => {
    expect(energyFj(2, 1)).toBe(1);
    expect(fmtEnergy(1530)).toBe('1.53 pJ');
    expect(fmtEnergy(0.5)).toBe('0.50 fJ');
    expect(fmtPower(powerW(1000, 40))).toBe('1.00 mW'); // 1 pJ per 1 ns
  });
});
