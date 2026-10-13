import { describe, expect, it } from 'vitest';
import { DEP, NINV, nnand, nnor } from '../src/lib/nmos';
import { INV_CMOS, NAND, NOR_CMOS } from '../src/lib/transistors';
import { flatten } from '../src/sim/flatten';
import { NmosSim } from '../src/sim/nmossim';
import { stats } from '../src/sim/stats';
import { SwitchSim } from '../src/sim/switchsim';
import type { ComponentDef } from '../src/sim/types';
import { B0, B1 } from '../src/sim/types';

/** Every input combination: the engine against SwitchSim and the spec. */
function agrees(def: ComponentDef): void {
  const d = flatten(def, { mode: 'switch' });
  const a = new NmosSim(d), b = new SwitchSim(d);
  const ins = def.ports.filter((p) => p.dir === 'in'), outs = def.ports.filter((p) => p.dir === 'out');
  for (let v = 0; v < 1 << ins.length; v++) {
    ins.forEach((p, i) => { a.setInput(p.name, (v >> i) & 1); b.setInput(p.name, (v >> i) & 1); });
    a.settle(); b.settle();
    const want = def.spec!(ins.map((_, i) => (v >> i) & 1));
    outs.forEach((p, i) => {
      const net = d.root.ports[p.name][0];
      expect(a.get(net), `${def.id} ${v}`).toBe(want[i] ? B1 : B0);
      expect(b.get(net)).toBe(a.get(net));
    });
  }
  expect(a.shorts).toBe(0);
}

describe('NmosSim', () => {
  it('NMOS cells match SwitchSim and their specs', () => {
    for (const d of [NINV, nnor(2), nnor(3), nnor(5), nnand(2), nnand(3)]) agrees(d);
  });
  it('CMOS cells too', () => {
    for (const d of [INV_CMOS, NOR_CMOS, NAND]) agrees(d);
  });
  it('counts n + 1 transistors, one of them a load', () => {
    expect(stats(nnor(4))).toMatchObject({ transistors: 5, depletion: 1 });
    expect(stats(NINV)).toMatchObject({ transistors: 2, depletion: 1 });
    expect(stats(DEP)).toMatchObject({ transistors: 1, depletion: 1 });
  });
});
