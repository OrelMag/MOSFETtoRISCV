import { describe, expect, it } from 'vitest';
import { evalOnce, forEachInput, inputBits, simulate } from '../src/sim/harness';
import { registry } from '../src/lib/define';
import '../src/lib';
import { NAND, INV_CMOS } from '../src/lib/transistors';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { BX, BZ } from '../src/sim/types';

// Every component that declares a spec must match it exactly, simulated from its own structure.
describe('structure matches spec', () => {
  const defs = [...registry.values()].filter((d) => d.spec && inputBits(d) <= 12);
  for (const def of defs) {
    it(def.id, () => {
      const sim = simulate(def);
      forEachInput(def, (ins) => {
        expect(evalOnce(sim, ins), `${def.id}(${ins.join(',')})`).toEqual(def.spec!(ins));
      });
    });
  }
});

describe('NAND both ways', () => {
  it('switch level and gate level agree', () => {
    const sw = simulate(NAND, 'switch');
    const gt = simulate(NAND, 'gate');
    forEachInput(NAND, (ins) => expect(evalOnce(sw, ins)).toEqual(evalOnce(gt, ins)));
  });
});

describe('switch-level corner cases', () => {
  it('an X input makes the inverter output X (both devices may conduct)', () => {
    const sim = new SwitchSim(flatten(INV_CMOS, { mode: 'switch' }));
    sim.setInputBit('a', BX);
    sim.settle();
    expect(sim.get(sim.design.root.ports.y[0])).toBe(BX);
  });
  it('a floating gate input propagates as X, not as a value', () => {
    const sim = new SwitchSim(flatten(INV_CMOS, { mode: 'switch' }));
    sim.setInputBit('a', BZ);
    sim.settle();
    expect(sim.get(sim.design.root.ports.y[0])).toBe(BX);
  });
});

describe('GateSim.runUntil', () => {
  it('stops mid-propagation at a fixed time and resumes exactly where settle() would go', async () => {
    const { rca } = await import('../src/lib/combinational');
    const { GateSim } = await import('../src/sim/gatesim');
    const { pack } = await import('../src/sim/values');
    const def = rca(8);
    const mk = () => {
      const sim = new GateSim(flatten(def));
      sim.setInput('a', 0); sim.setInput('b', 0); sim.setInput('cin', 0);
      sim.reset('zero'); sim.settle();
      sim.setInput('a', 0xff); sim.setInput('cin', 1);
      return sim;
    };
    const ref = mk();
    const t0 = ref.time;
    ref.settle();
    const full = ref.time - t0;
    expect(full).toBeGreaterThan(4);
    const sim = mk();
    sim.runUntil(t0 + 3);
    expect(sim.time).toBe(t0 + 3);
    expect(sim.busy()).toBe(true);
    // The carry has not rippled through yet: the sum is still wrong at t0 + 3.
    expect(pack(sim.getBits(sim.design.root.ports.s))).not.toBe(pack(ref.getBits(ref.design.root.ports.s)));
    sim.runUntil(t0 + full + 10);
    expect(sim.busy()).toBe(false);
    expect(sim.time).toBe(t0 + full + 10);
    expect(pack(sim.getBits(sim.design.root.ports.s))).toBe(pack(ref.getBits(ref.design.root.ports.s)));
  });
});
