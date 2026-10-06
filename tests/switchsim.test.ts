// Switch-level solver: sources (rails, driven inputs) are terminals, never paths between the
// transistors that share them. One rail symbol shared by many transistors ≡ one per transistor.

import { describe, expect, it } from 'vitest';
import { GND, NAND, NMOS, NMOS_STRONG, NOR_CMOS, PMOS, PMOS_WEAK, SRAM_CELL, VDD } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BX, BZ, type Bit, type ComponentDef, type NetDef, netlistOf } from '../src/sim/types';

const sw = (def: ComponentDef) => new SwitchSim(flatten(def, { mode: 'switch' }));
const outBit = (s: SwitchSim, p: string) => s.get(s.design.root.ports[p][0]);
const BITS: Bit[] = [B0, B1, BX, BZ];

/** A 6T cell with ONE VDD for both pull-ups and ONE GND for both pull-downs. */
const SRAM_SHARED: ComponentDef = {
  id: 't_sram_shared', name: '6T (shared rails)', category: 'memory',
  ports: [{ name: 'wl', width: 1, dir: 'in' }, { name: 'bl', width: 1, dir: 'inout' }, { name: 'blb', width: 1, dir: 'inout' }],
  symbol: { kind: 'box', label: '6T' },
  netlist: () => ({
    level: 'switch',
    instances: [
      { name: 'vdd', def: VDD }, { name: 'gnd', def: GND },
      { name: 'p1', def: PMOS_WEAK }, { name: 'n1', def: NMOS_STRONG }, { name: 'a1', def: NMOS },
      { name: 'p2', def: PMOS_WEAK }, { name: 'n2', def: NMOS_STRONG }, { name: 'a2', def: NMOS },
    ],
    nets: [
      { name: 'wl', ends: ['wl', 'a1.g', 'a2.g'] },
      { name: 'bl', ends: ['bl', 'a1.d'] }, { name: 'blb', ends: ['blb', 'a2.d'] },
      { name: 'vdd', ends: ['vdd.p', 'p1.s', 'p2.s'] }, { name: 'gnd', ends: ['gnd.p', 'n1.s', 'n2.s'] },
      { name: 'q', ends: ['p1.d', 'n1.d', 'a1.s', 'p2.g', 'n2.g'] },
      { name: 'q̄', ends: ['p2.d', 'n2.d', 'a2.s', 'p1.g', 'n1.g'] },
    ],
  }),
};

/** The same gate with every rail net split: one rail symbol per transistor terminal. */
function splitRails(def: ComponentDef): ComponentDef {
  const nl = netlistOf(def)!;
  const railOf = new Map(nl.instances.filter((i) => i.def === VDD || i.def === GND).map((i) => [`${i.name}.p`, i.def]));
  const instances = nl.instances.filter((i) => !railOf.has(`${i.name}.p`));
  const nets: NetDef[] = [];
  for (const n of nl.nets) {
    const rail = n.ends.map((e) => railOf.get(e)).find((d) => d);
    if (!rail) { nets.push(n); continue; }
    n.ends.filter((e) => !railOf.has(e)).forEach((e, k) => {
      const name = `${n.name ?? 'rail'}_${k}`;
      instances.push({ name, def: rail });
      nets.push({ ends: [`${name}.p`, e] });
    });
  }
  return { ...def, id: `${def.id}_split`, netlist: () => ({ level: 'switch', instances, nets }) };
}

describe('SwitchSim: rails and inputs are terminals', () => {
  it('a 6T cell with one shared VDD and GND writes from X, holds and reads like the library cell', () => {
    const a = sw(SRAM_SHARED), b = sw(SRAM_CELL);
    const q = (s: SwitchSim) => {
      const nl = netlistOf(s.design.root.def)!;
      return [s.get(s.design.root.nets![nl.nets.findIndex((n) => n.name === 'q')][0]), s.get(s.design.root.nets![nl.nets.findIndex((n) => n.name === 'q̄')][0])];
    };
    const steps: [number, Bit, Bit][] = [
      [0, BZ, BZ], [1, B1, B0], [0, B1, B0], [0, BZ, BZ], [1, BZ, BZ], [0, BZ, BZ],
      [1, B0, B1], [0, BZ, BZ], [1, BZ, BZ], [1, B1, B0], [1, BZ, BZ], [0, B0, B0], [1, BX, B0],
    ];
    const seen: Bit[][] = [];
    steps.forEach(([wl, bl, blb], k) => {
      for (const s of [a, b]) {
        s.setInput('wl', wl);
        s.setInputBit('bl', bl);
        s.setInputBit('blb', blb);
        s.settle();
      }
      const at = `step ${k}: wl=${wl} bl=${bl} blb=${blb}`;
      expect(q(a), at).toEqual(q(b));
      expect([outBit(a, 'bl'), outBit(a, 'blb')], at).toEqual([outBit(b, 'bl'), outBit(b, 'blb')]);
      expect(a.shorted.some((x) => x), at).toBe(false);
      seen.push(q(a));
    });
    expect(seen[0]).toEqual([BX, BX]); // powers up unknown
    expect(seen[1]).toEqual([B1, B0]); // written from X
    expect(seen[3]).toEqual([B1, B0]); // holds with the bit lines released
    expect(seen[4]).toEqual([B1, B0]); // a read does not disturb it
    expect(seen[8]).toEqual([B0, B1]); // rewritten
  });
  it('inout root ports: bl / blb are undriven (Z) until driven, and read the stored bit', () => {
    const s = sw(SRAM_SHARED);
    expect([outBit(s, 'bl'), outBit(s, 'blb')]).toEqual([BZ, BZ]);
    s.setInput('wl', 1); s.setInput('bl', 0); s.setInput('blb', 1); s.settle();
    s.setInputBit('bl', BZ); s.setInputBit('blb', BZ); s.settle();
    expect([outBit(s, 'bl'), outBit(s, 'blb')]).toEqual([B0, B1]);
  });
  for (const def of [NAND, NOR_CMOS]) {
    it(`${def.id}: shared rails ≡ one rail per transistor, for 0 / 1 / X / Z inputs`, () => {
      const a = sw(def), b = sw(splitRails(def));
      expect(b.design.leaves.filter((l) => l.kind === 'vdd' || l.kind === 'gnd').length).toBeGreaterThan(a.design.leaves.filter((l) => l.kind === 'vdd' || l.kind === 'gnd').length);
      for (const x of BITS) for (const y of BITS) {
        for (const s of [a, b]) { s.setInputBit('a', x); s.setInputBit('b', y); s.settle(); }
        expect(outBit(a, 'y'), `a=${x} b=${y}`).toBe(outBit(b, 'y'));
      }
    });
  }
  it('an X in one gate does not leak into its neighbour through the shared rails', () => {
    // two inverters on one VDD and one GND: a = X makes ya = X, but yb (b = 0) is a clean 1
    const def: ComponentDef = {
      id: 't_two_inv', name: 'two inverters', category: 'cell', symbol: { kind: 'box' },
      ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' }, { name: 'ya', width: 1, dir: 'out' }, { name: 'yb', width: 1, dir: 'out' }],
      netlist: () => ({
        level: 'switch',
        instances: [{ name: 'vdd', def: VDD }, { name: 'gnd', def: GND }, { name: 'pa', def: PMOS }, { name: 'na', def: NMOS }, { name: 'pb', def: PMOS }, { name: 'nb', def: NMOS }],
        nets: [
          { ends: ['a', 'pa.g', 'na.g'] }, { ends: ['b', 'pb.g', 'nb.g'] },
          { ends: ['vdd.p', 'pa.s', 'pb.s'] }, { ends: ['gnd.p', 'na.s', 'nb.s'] },
          { ends: ['pa.d', 'na.d', 'ya'] }, { ends: ['pb.d', 'nb.d', 'yb'] },
        ],
      }),
    };
    const s = sw(def);
    s.setInputBit('a', BX); s.setInput('b', 0); s.settle();
    expect([outBit(s, 'ya'), outBit(s, 'yb')]).toEqual([BX, B1]);
    s.setInput('b', 1); s.settle();
    expect(outBit(s, 'yb')).toBe(B0);
  });
  it('a driven input is a terminal too: two pass transistors on one input do not join their far sides', () => {
    // d —[g1]— x, d —[g2]— y: with g1 = 1 and g2 = X, x follows d; y may or may not (X)
    const def: ComponentDef = {
      id: 't_pass2', name: 'two pass gates', category: 'cell', symbol: { kind: 'box' },
      ports: [{ name: 'd', width: 1, dir: 'in' }, { name: 'g1', width: 1, dir: 'in' }, { name: 'g2', width: 1, dir: 'in' }, { name: 'e', width: 1, dir: 'in' },
        { name: 'x', width: 1, dir: 'out' }, { name: 'y', width: 1, dir: 'out' }],
      netlist: () => ({
        level: 'switch',
        instances: [{ name: 't1', def: NMOS }, { name: 't2', def: NMOS }, { name: 't3', def: NMOS }],
        nets: [
          { ends: ['d', 't1.d', 't2.d'] }, { ends: ['g1', 't1.g'] }, { ends: ['g2', 't2.g'] },
          { ends: ['t1.s', 'x'] }, { ends: ['t2.s', 't3.d', 'y'] }, { ends: ['e', 't3.s', 't3.g'] },
        ],
      }),
    };
    const s = sw(def);
    // e = 1 turns t3 on, so y sees a 1 from e and (maybe) a 0 from d
    s.setInput('d', 0); s.setInput('g1', 1); s.setInputBit('g2', BX); s.setInput('e', 1); s.settle();
    expect(outBit(s, 'x')).toBe(B0); // d's other transistor (to y, which sees e = 1) does not reach x
    expect(outBit(s, 'y')).toBe(BX);
  });
});
