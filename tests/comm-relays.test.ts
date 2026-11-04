// Chapters 39 and 40's relay parts on SwitchSim: behaviour, relay steps, relay counts.
import { describe, expect, it } from 'vitest';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { stats } from '../src/sim/stats';
import { B1, type ComponentDef } from '../src/sim/types';
import { DIAL_COUNTER, TELEGRAPH_RELAY, countStage, telegraphChain } from '../src/lib/telegraph';

const simOf = (def: ComponentDef) => new SwitchSim(flatten(def, { mode: 'switch' }));
const out = (sim: SwitchSim, port: string) => sim.getBits(sim.design.root.ports[port]);
const val = (sim: SwitchSim, port: string) => out(sim, port).reduce<number>((v, x, i) => v | ((x === B1 ? 1 : 0) << i), 0);

describe('the telegraph repeater', () => {
  it('one station copies its line one relay step later, at battery strength', () => {
    const sim = simOf(TELEGRAPH_RELAY);
    expect(val(sim, 'out')).toBe(0);
    sim.setInput('line', 1);
    sim.settle();
    expect(val(sim, 'out')).toBe(1);
    sim.setInput('line', 0);
    sim.settle();
    expect(val(sim, 'out')).toBe(0);
    expect(stats(TELEGRAPH_RELAY).relays).toBe(1);
  });

  it('the front of a key press reaches the sounder after exactly n relay steps', () => {
    for (const n of [1, 2, 3, 4]) {
      const sim = simOf(telegraphChain(n));
      sim.setInput('key', 1);
      let steps = 0;
      while (val(sim, 'sounder') === 0 && steps < 20) { sim.step(); steps++; }
      // step() 1 solves (the coil is fed), steps 2 .. n + 1 each move one stage
      expect(steps, `n = ${n}`).toBe(n + 1);
      expect(sim.time).toBe(n);
    }
  });

  it('settles in n relay steps whichever way the key moves', () => {
    const sim = simOf(telegraphChain(3));
    for (const k of [1, 0, 1, 0]) {
      sim.setInput('key', k);
      const t0 = sim.time;
      sim.settle();
      expect(val(sim, 'sounder')).toBe(k);
      expect(sim.time - t0).toBe(3);
      expect(sim.unstable).toBe(false);
    }
  });
});

describe('the relay pulse counter', () => {
  const pulses = (sim: SwitchSim, n: number) => {
    for (let i = 0; i < n; i++) { sim.setInput('pulse', 1); sim.settle(); sim.setInput('pulse', 0); sim.settle(); }
  };
  it('counts falling edges, 0 to 7 and round', () => {
    const sim = simOf(DIAL_COUNTER);
    expect(val(sim, 'count')).toBe(0);
    for (let i = 1; i <= 17; i++) {
      pulses(sim, 1);
      expect(val(sim, 'count'), `after ${i} pulses`).toBe(i & 7);
      expect(sim.unstable).toBe(false);
    }
  });
  it('advances once per pulse however long the pulse lasts, and only when it falls', () => {
    const sim = simOf(DIAL_COUNTER);
    sim.setInput('pulse', 1);
    for (let i = 0; i < 12; i++) { sim.step(); expect(val(sim, 'count'), `high, step ${i}`).toBe(0); }
    sim.settle();
    expect(val(sim, 'count')).toBe(0);
    sim.setInput('pulse', 0);
    sim.settle();
    expect(val(sim, 'count')).toBe(1);
    sim.setInput('pulse', 1);
    for (let i = 0; i < 40; i++) sim.step();
    sim.setInput('pulse', 0);
    sim.settle();
    expect(val(sim, 'count')).toBe(2);
  });
  it('hanging up releases every stage', () => {
    const sim = simOf(DIAL_COUNTER);
    pulses(sim, 5);
    expect(val(sim, 'count')).toBe(5);
    sim.setInput('hangup', 1);
    sim.settle();
    expect(val(sim, 'count')).toBe(0);
    sim.setInput('hangup', 0);
    sim.settle();
    expect(val(sim, 'count')).toBe(0);
    pulses(sim, 3);
    expect(val(sim, 'count')).toBe(3);
  });
  it('costs 3 relays a bit and one to hang up', () => {
    expect(stats(DIAL_COUNTER).relays).toBe(10);
    expect(stats(countStage(0)).relays).toBe(3);
  });
});
