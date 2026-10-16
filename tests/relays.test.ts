import { describe, expect, it } from 'vitest';
import { flatten } from '../src/sim/flatten';
import { RELAY_SETTLE_MAX, SwitchSim } from '../src/sim/switchsim';
import { hasFeedback, stats } from '../src/sim/stats';
import { B0, B1, BZ, type ComponentDef } from '../src/sim/types';
import { RELAY, RELAY_BUZZER, RELAY_FA, RELAY_LATCH, RELAY_NAND, RELAY_NOT, RELAY_XOR, relay, relayAdder } from '../src/lib/relays';
import { GND, VDD } from '../src/lib/transistors';
import { define } from '../src/lib/define';

const simOf = (def: ComponentDef) => new SwitchSim(flatten(def, { mode: 'switch' }));
const out = (sim: SwitchSim, port: string) => sim.getBits(sim.design.root.ports[port]);

describe('relay primitive', () => {
  // one relay: input on the coil, its common on VDD, both contacts as outputs
  const ONE = define({
    id: 't_relay1', name: 'one relay', category: 'transistor',
    ports: [{ name: 'k', width: 1, dir: 'in' }, { name: 'no', width: 1, dir: 'out' }, { name: 'nc', width: 1, dir: 'out' }],
    symbol: { kind: 'box' },
    netlist: () => ({
      level: 'switch', pins: { k: [0, 5], no: [20, 9], nc: [20, 11] },
      instances: [{ name: 'r', def: RELAY, at: [6, 4] }, { name: 'g', def: GND, at: [6, 9] }, { name: 'v', def: VDD, at: [9, 1] }],
      nets: [{ ends: ['k', 'r.a'] }, { ends: ['r.b', 'g.p'] }, { ends: ['v.p', 'r.c'] }, { ends: ['r.no', 'no'] }, { ends: ['r.nc', 'nc'] }],
    }),
  });

  it('moves one relay step after its coil, and an open contact floats', () => {
    const sim = simOf(ONE);
    expect(sim.hasRelays).toBe(true);
    expect(out(sim, 'nc')).toEqual([B1]);
    expect(out(sim, 'no')).toEqual([BZ]); // nothing on it: no coil, no load
    const t0 = sim.time;
    sim.setInput('k', 1);
    expect(sim.step()).toBe(true); // solved: the coil now carries current, the armature has not moved
    expect(out(sim, 'nc')).toEqual([B1]);
    const leaf = sim.design.leaves.findIndex((l) => l.kind === 'relay');
    expect(sim.relayEnergized(leaf)).toBe(B1);
    expect(sim.relayState(leaf)).toBe(B0);
    expect(sim.step()).toBe(false); // one relay step: now operated, and nothing left to move
    expect(sim.relayState(leaf)).toBe(B1);
    expect(out(sim, 'no')).toEqual([B1]);
    expect(out(sim, 'nc')).toEqual([BZ]);
    expect(sim.time - t0).toBe(1);
    expect(sim.busy()).toBe(false);
  });

  it('counts relays, and every pole count has a symbol', () => {
    expect(stats(RELAY).relays).toBe(1);
    expect(stats(RELAY_FA).relays).toBe(2);
    expect(stats(relayAdder(4)).relays).toBe(8);
    for (const n of [1, 2, 3, 4, 5, 6]) expect(relay(n).ports.length).toBe(2 + 3 * n);
  });
});

describe('relay logic', () => {
  const table = (def: ComponentDef, f: (a: number, b: number) => number) => {
    const sim = simOf(def);
    for (let v = 0; v < 4; v++) {
      const a = v & 1, b = v >> 1;
      sim.setInput('a', a);
      if (def.ports.some((p) => p.name === 'b')) sim.setInput('b', b);
      sim.settle();
      expect(out(sim, 'y'), `${def.id} a=${a} b=${b}`).toEqual([f(a, b)]);
    }
  };
  it('NOT, NAND, XOR read 0 on an open line (the load) and settle in one relay step', () => {
    table(RELAY_NOT, (a) => 1 - a);
    table(RELAY_NAND, (a, b) => 1 - (a & b));
    table(RELAY_XOR, (a, b) => a ^ b);
    const sim = simOf(RELAY_XOR);
    const t0 = sim.time;
    sim.setInput('a', 1);
    sim.setInput('b', 1);
    sim.settle();
    expect(sim.time - t0).toBe(1);
  });

  it('the relay adder adds any operands in one relay step: the carry runs through contacts', () => {
    const def = relayAdder(4), sim = simOf(def);
    for (const [a, b] of [[15, 1], [7, 9], [0, 0], [15, 15], [10, 5], [8, 8]]) {
      sim.setInput('a', a);
      sim.setInput('b', b);
      const t0 = sim.time;
      sim.settle();
      const s = out(sim, 's').reduce((v, x, i) => v | (x << i), 0);
      expect([s, out(sim, 'co')[0]], `${a} + ${b}`).toEqual([(a + b) & 15, a + b > 15 ? 1 : 0]);
      expect(sim.time - t0).toBeLessThanOrEqual(1);
    }
  });

  it('combinational relay parts have no feedback; the latch and the buzzer have', () => {
    for (const d of [RELAY_NOT, RELAY_NAND, RELAY_XOR, RELAY_FA, relayAdder(4)]) expect(hasFeedback(d), d.id).toBe(false);
    for (const d of [RELAY_LATCH, RELAY_BUZZER]) expect(hasFeedback(d), d.id).toBe(true);
  });
});

describe('relay memory and clocks', () => {
  it('the self-holding relay keeps its bit after set lets go, until reset', () => {
    const sim = simOf(RELAY_LATCH);
    expect(out(sim, 'q')).toEqual([B0]);
    for (const [set, reset, q] of [[1, 0, 1], [0, 0, 1], [0, 1, 0], [0, 0, 0], [1, 0, 1], [0, 0, 1]]) {
      sim.setInput('set', set);
      sim.setInput('reset', reset);
      sim.settle();
      expect(out(sim, 'q'), `set ${set} reset ${reset}`).toEqual([q]);
      expect(sim.unstable).toBe(false);
    }
  });

  it('the buzzer oscillates with a period of two relay steps, and settle gives up on it', () => {
    const sim = simOf(RELAY_BUZZER);
    sim.setInput('en', 1);
    const seen: number[] = [];
    while (sim.step() && seen.length < 12) seen.push(out(sim, 'y')[0]);
    expect(seen.length).toBe(12);
    // after the enable relay pulls in: 1, 1, 0, 0, …: each value lasts while the coil's armature catches up
    const tail = seen.slice(2);
    for (let i = 2; i < tail.length; i++) expect(tail[i]).toBe(tail[i - 2]);
    expect(new Set(tail).size).toBe(2);
    sim.settle();
    expect(sim.unstable).toBe(true);
    expect(sim.time).toBeGreaterThanOrEqual(RELAY_SETTLE_MAX);
  });

  it('Back restores the armatures and the relay time', () => {
    const sim = simOf(RELAY_LATCH);
    const saved = sim.saveState();
    sim.setInput('set', 1);
    sim.settle();
    expect(out(sim, 'q')).toEqual([B1]);
    sim.restoreState(saved);
    expect(sim.time).toBe(0);
    sim.settle();
    expect(out(sim, 'q')).toEqual([B0]);
  });

  it('a rebuilt design keeps its armatures (an edit does not drop a held bit)', () => {
    const a = simOf(RELAY_LATCH);
    a.setInput('set', 1);
    a.settle();
    a.setInput('set', 0);
    a.settle();
    const b = simOf(RELAY_LATCH);
    b.carry(a);
    expect(out(b, 'q')).toEqual([B1]);
  });
});
