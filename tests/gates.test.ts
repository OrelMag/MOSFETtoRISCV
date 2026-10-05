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
