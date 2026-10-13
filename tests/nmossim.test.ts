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

describe('NmosSim: buses and oscillation', () => {
  it('a precharged bus line: precharge, wired AND, a destination holding its bit', async () => {
    const { BUS_LINE } = await import('../src/lib/m6502/demo');
    const d = flatten(BUS_LINE, { mode: 'switch' });
    const s = new NmosSim(d);
    const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) s.setInput(k, v); s.settle(); };
    const out = () => [s.get(d.root.ports.bus[0]), s.get(d.root.ports.q[0])];
    set({ p2: 1, en_a: 0, en_b: 0, ld: 0, a: 1, b: 0 });
    expect(out()[0]).toBe(B1);
    set({ p2: 0, en_a: 1 });
    expect(out()[0]).toBe(B1); // a = 1 leaves the charge
    set({ en_b: 1, ld: 1 });
    expect(out()).toEqual([B0, B0]); // 1 AND 0, loaded
    set({ ld: 0, en_a: 0, en_b: 0, p2: 1 });
    expect(out()).toEqual([B1, B0]); // precharged again; the destination keeps its 0
    expect(s.shorts).toBe(0);
  });

  it('an oscillation gives up, and leaves nothing half-propagated once it stops', async () => {
    // a ring of three inverters closed through a NOR: en = 1 holds it, en = 0 lets it run
    const { define } = await import('../src/lib/define');
    const ring = define({
      id: 'test_nmos_ring', name: 'test ring', category: 'cell',
      ports: [{ name: 'en', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
      symbol: { kind: 'box' },
      netlist: () => ({
        level: 'switch',
        instances: [{ name: 'g', def: nnor(2) }, { name: 'i1', def: NINV }, { name: 'i2', def: NINV }],
        nets: [{ ends: ['en', 'g.a'] }, { ends: ['i2.y', 'g.b', 'y'] }, { ends: ['g.y', 'i1.a'] }, { ends: ['i1.y', 'i2.a'] }],
      }),
    });
    const d = flatten(ring, { mode: 'switch' });
    const s = new NmosSim(d);
    s.setInput('en', 1); s.settle();
    expect(s.unstable).toBe(false);
    s.setInput('en', 0); s.settle();
    expect(s.unstable).toBe(true);
    s.setInput('en', 1); s.settle();
    expect(s.unstable).toBe(false);
    const before = s.snapshot();
    s.recomputeAll();
    expect(s.snapshot()).toEqual(before);
    expect(s.get(d.root.ports.y[0])).toBe(B0); // en = 1: the NOR gives 0, two inversions later y = 0
  });
});
