import { describe, expect, it } from 'vitest';
import { PIXEL_4T } from '../src/lib/sensor';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { levelText, PixelBench, type PixelSim } from '../src/widgets/sensors';

// The switch-level pixel's panel (step 3): its readout is never NaN, in any state the buttons can reach.
const fresh = () => {
  let sim = new SwitchSim(flatten(PIXEL_4T, { mode: 'switch' }));
  sim.setInput('rst', 0); sim.setInput('tx', 0); sim.setInput('light', 0); sim.setInput('sel', 0); sim.settle();
  const bench = new PixelBench(() => sim as unknown as PixelSim);
  return { bench, powerOn: () => { sim = new SwitchSim(flatten(PIXEL_4T, { mode: 'switch' })); sim.settle(); bench.clear(); } };
};
const clean = (t: string) => { expect(t).not.toMatch(/NaN|undefined|null/); return t; };

describe('the pixel panel', () => {
  it('prints X, not NaN, for a node with no defined charge', () => {
    expect(levelText(Number.NaN)).toBe('X');
    expect(levelText(null)).toBe('X');
    expect(levelText(1)).toBe('100 %');
  });
  it('shows X for PD and FD on load, before any button', () => {
    const { bench } = fresh();
    const t = bench.status();
    clean(bench.text());
    expect([t.pd, t.fd]).toEqual(['X', 'X']);
  });
  it('never prints NaN after any button, in any order, or after the stage\'s Reset', () => {
    const { bench, powerOn } = fresh();
    const acts: [string, () => void][] = [['reset', () => bench.reset()], ['dark', () => bench.expose(false)], ['light', () => bench.expose(true)], ['read', () => bench.read()]];
    // every sequence of three buttons from power-on
    for (const a of acts) for (const b of acts) for (const c of acts) {
      powerOn();
      for (const [name, f] of [a, b, c]) { f(); clean(bench.text()); for (const l of bench.log) clean(l); expect(name).toBeTruthy(); }
    }
    powerOn();
    clean(bench.text());
  });
  it('reads a bright pixel after Reset, Light, Read, and a dark one after Reset, Dark, Read', () => {
    const { bench, powerOn } = fresh();
    bench.reset(); bench.expose(true); bench.read();
    expect(bench.sawBright).toBe(true);
    expect(bench.log.at(-1)).toMatch(/bright pixel/);
    powerOn();
    bench.reset(); bench.expose(false); bench.read();
    expect(bench.sawBright).toBe(false);
    expect(bench.log.at(-1)).toMatch(/dark pixel/);
    expect(bench.status().pd).toBe('100 %');
  });
});
