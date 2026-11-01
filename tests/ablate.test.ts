import { describe, expect, it } from 'vitest';
import { decoder, FULL_ADDER, HALF_ADDER, muxTree, rca, DFF, addSub } from '../src/lib';
import { ablate, type Ablation, roleText } from '../src/sim/ablate';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { B0, B1, type ComponentDef, inPorts, netlistOf, outPorts } from '../src/sim/types';

/** The oracle: the netlist rebuilt without the instance, simulated row by row on GateSim. */
function wrongWithout(def: ComponentDef, inst: string): Record<string, number> {
  const nl = netlistOf(def)!;
  const cut: ComponentDef = {
    ...def, id: `${def.id}_without_${inst}`, spec: undefined,
    netlist: () => ({
      ...nl,
      instances: nl.instances.filter((i) => i.name !== inst),
      nets: nl.nets.map((n) => ({ ...n, ends: n.ends.filter((e) => !e.startsWith(`${inst}.`)) })).filter((n) => n.ends.length),
    }),
  };
  const good = new GateSim(flatten(def, { mode: 'gate' }));
  const bad = new GateSim(flatten(cut, { mode: 'gate' }));
  const ins = inPorts(def);
  const total = ins.reduce((a, p) => a + p.width, 0);
  const out: Record<string, number> = Object.fromEntries(outPorts(def).map((p) => [p.name, 0]));
  for (let r = 0; r < 2 ** total; r++) {
    for (const s of [good, bad]) {
      s.reset('x');
      let shift = 0;
      for (const p of ins) { s.setInput(p.name, (r >>> shift) & (2 ** p.width - 1)); shift += p.width; }
      s.settle();
    }
    for (const p of outPorts(def)) {
      const g = good.getBits(good.design.root.ports[p.name]);
      const b = bad.getBits(bad.design.root.ports[p.name]);
      if (g.some((v, i) => v !== b[i] || (b[i] !== B0 && b[i] !== B1))) out[p.name]++;
    }
  }
  return out;
}

const done = (a: Ablation | string): Ablation => {
  if (typeof a === 'string') throw new Error(a);
  return a;
};

describe('ablate', () => {
  it('names what each NAND of the 9-NAND full adder serves', () => {
    const a = done(ablate(FULL_ADDER));
    expect(a.rows).toBe(8);
    const by = Object.fromEntries(a.parts.map((p) => [p.inst, p]));
    expect(by.g9.serves).toEqual(['cout']);
    expect(roleText(by.g9, a.outputs)).toBe('cout only');
    expect(by.g1.serves.sort()).toEqual(['cout', 's']);
  });

  it('removing a part agrees with simulating the netlist without it', () => {
    for (const def of [HALF_ADDER, FULL_ADDER, rca(2), decoder(2), muxTree(2, 1), addSub(2)]) {
      const a = done(ablate(def));
      for (const p of a.parts) expect(p.wrong.open, `${def.id} without ${p.inst}`).toEqual(wrongWithout(def, p.inst));
    }
  });

  it('a stuck output is wrong on the rows where the intact one differs', () => {
    const a = done(ablate(FULL_ADDER));
    const g9 = a.parts.find((p) => p.inst === 'g9')!;
    // cout is 1 on 4 of the 8 rows: held at 0 it is wrong there, held at 1 on the other 4
    expect(g9.wrong.stuck0.cout).toBe(4);
    expect(g9.wrong.stuck1.cout).toBe(4);
    expect(g9.wrong.stuck0.s).toBe(0);
  });

  it('refuses storage and wide blocks', () => {
    expect(typeof ablate(DFF)).toBe('string');
    expect(ablate(rca(8))).toMatch(/input bits/);
  });
});
