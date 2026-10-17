import { describe, expect, it } from 'vitest';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { hasFeedback, stats } from '../src/sim/stats';
import { B0, B1, BX, type ComponentDef } from '../src/sim/types';
import {
  CATHODE_FOLLOWER, DIODE, ECCLES_JORDAN, RES_BIAS, TRIODE, TRIODE_SWITCH, TUBE_FA, TUBE_INV, TUBE_NAND, TUBE_NOR,
} from '../src/lib/tubes';
import { PULLDOWN, PULLUP, RES } from '../src/lib/switchparts';
import { GND, VDD } from '../src/lib/transistors';
import { define } from '../src/lib/define';

const simOf = (def: ComponentDef) => new SwitchSim(flatten(def, { mode: 'switch' }));
const out = (sim: SwitchSim, port: string) => sim.getBits(sim.design.root.ports[port])[0];
const bit = (name: string, dir: 'in' | 'out') => ({ name, width: 1, dir });

describe('one-way elements', () => {
  // a triode with its grid on 1, a pin on its cathode, a pull-up on its plate
  const PULL_PLATE = define({
    id: 't_tube_back', name: 'tube backwards', category: 'transistor',
    ports: [bit('k', 'in'), bit('p', 'out')], symbol: { kind: 'box' },
    netlist: () => ({
      level: 'switch', pins: { k: [0, 14], p: [12, 2] },
      instances: [{ name: 'v', def: TRIODE, at: [4, 6] }, { name: 'gv', def: VDD, at: [0, 6] }, { name: 'pu', def: PULLUP, at: [5, 0] }],
      nets: [{ ends: ['gv.p', 'v.g'] }, { ends: ['k', 'v.k'] }, { ends: ['pu.y', 'v.p', 'p'] }],
    }),
  });
  // a triode with its grid on 1, a pin on its plate, a pull-down on its cathode (a cathode follower)
  const PUSH_CATHODE = define({
    id: 't_tube_fwd', name: 'tube forwards', category: 'transistor',
    ports: [bit('p', 'in'), bit('k', 'out')], symbol: { kind: 'box' },
    netlist: () => ({
      level: 'switch', pins: { p: [0, 2], k: [12, 14] },
      instances: [{ name: 'v', def: TRIODE, at: [4, 6] }, { name: 'gv', def: VDD, at: [0, 6] }, { name: 'pd', def: PULLDOWN, at: [5, 11] }],
      nets: [{ ends: ['gv.p', 'v.g'] }, { ends: ['p', 'v.p'] }, { ends: ['v.k', 'pd.y', 'k'] }],
    }),
  });

  it('a conducting triode pulls its plate down to a 0 on its cathode, but never up to a 1', () => {
    const sim = simOf(PULL_PLATE);
    sim.setInput('k', 0); sim.settle();
    expect(out(sim, 'p')).toBe(B0);
    sim.setInput('k', 1); sim.settle();
    expect(out(sim, 'p')).toBe(B1); // only the pull-up: the tube passes nothing back
    expect([...sim.shorted].some(Boolean)).toBe(false);
  });

  it('it pushes its cathode up to a 1 on its plate, but never down to a 0', () => {
    const sim = simOf(PUSH_CATHODE);
    sim.setInput('p', 1); sim.settle();
    expect(out(sim, 'k')).toBe(B1);
    sim.setInput('p', 0); sim.settle();
    expect(out(sim, 'k')).toBe(B0); // the pull-down, not the tube
  });

  it('a grid at X makes it a maybe', () => {
    const sim = simOf(TRIODE_SWITCH);
    sim.setInputBit('g', BX); sim.settle();
    expect(out(sim, 'y')).toBe(BX);
    const li = sim.design.leaves.findIndex((l) => l.kind === 'triode');
    expect(sim.conducting[li]).toBe(2);
  });

  it('a bias resistor loses to any resistor', () => {
    const DIV = define({
      id: 't_bias', name: 'bias fight', category: 'transistor', ports: [bit('a', 'in'), bit('m', 'out')], symbol: { kind: 'box' },
      netlist: () => ({
        level: 'switch', pins: { a: [0, 0], m: [8, 5] },
        instances: [{ name: 'r1', def: RES, at: [3, 0] }, { name: 'r2', def: RES_BIAS, at: [3, 5] }, { name: 'g', def: GND, at: [3, 10] }],
        nets: [{ ends: ['a', 'r1.a'] }, { ends: ['r1.b', 'r2.a', 'm'] }, { ends: ['r2.b', 'g.p'] }],
      }),
    });
    const sim = simOf(DIV);
    sim.setInput('a', 1); sim.settle();
    expect(out(sim, 'm')).toBe(B1);
    sim.setInput('a', 0); sim.settle();
    expect(out(sim, 'm')).toBe(B0);
  });
});

describe('tube logic', () => {
  for (const def of [TRIODE_SWITCH, TUBE_INV, TUBE_NOR, TUBE_NAND, CATHODE_FOLLOWER, TUBE_FA]) {
    it(`${def.id} follows its truth table, with no short anywhere`, () => {
      const sim = simOf(def);
      const ins = def.ports.filter((p) => p.dir === 'in'), outs = def.ports.filter((p) => p.dir === 'out');
      for (let v = 0; v < 1 << ins.length; v++) {
        const bits = ins.map((_, i) => (v >> i) & 1);
        ins.forEach((p, i) => sim.setInput(p.name, bits[i]));
        sim.settle();
        expect(outs.map((p) => out(sim, p.name)), `${def.id} ${bits}`).toEqual(def.spec!(bits));
        expect([...sim.shorted].some(Boolean)).toBe(false);
        expect(sim.unstable).toBe(false);
      }
    });
  }

  it('the Eccles–Jordan flip-flop powers up undecided, then sets, holds and resets', () => {
    const sim = simOf(ECCLES_JORDAN);
    const q = () => [out(sim, 'q'), out(sim, 'nq')];
    expect(q()).toEqual([BX, BX]);
    sim.setInput('set', 1); sim.settle();
    expect(q()).toEqual([B1, B0]);
    sim.setInput('set', 0); sim.settle();
    expect(q()).toEqual([B1, B0]);
    sim.setInput('reset', 1); sim.settle();
    expect(q()).toEqual([B0, B1]);
    sim.setInput('reset', 0); sim.settle();
    expect(q()).toEqual([B0, B1]);
    sim.setInput('set', 1); sim.settle();
    sim.setInput('set', 0); sim.settle();
    expect(q()).toEqual([B1, B0]);
    expect(sim.unstable).toBe(false);
    expect(hasFeedback(ECCLES_JORDAN)).toBe(true);
  });

  it('keeps its bit across save and restore', () => {
    const sim = simOf(ECCLES_JORDAN);
    sim.setInput('set', 1); sim.settle(); sim.setInput('set', 0); sim.settle();
    const saved = sim.saveState();
    sim.setInput('reset', 1); sim.settle(); sim.setInput('reset', 0); sim.settle();
    expect(out(sim, 'q')).toBe(B0);
    sim.restoreState(saved);
    sim.settle();
    expect(out(sim, 'q')).toBe(B1);
  });

  it('counts triode sections and diodes', () => {
    expect(stats(TRIODE).triodes).toBe(1);
    expect(stats(DIODE).diodes).toBe(1);
    expect(stats(TUBE_NAND)).toMatchObject({ triodes: 1, diodes: 2, transistors: 0, nands: 0 });
    expect(stats(TUBE_NOR)).toMatchObject({ triodes: 2, diodes: 0 });
    expect(stats(ECCLES_JORDAN)).toMatchObject({ triodes: 2, diodes: 2 });
    expect(stats(TUBE_FA)).toMatchObject({ triodes: 9, diodes: 18, nands: 0 });
  });
});
