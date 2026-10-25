// Weak levels (switch level): an NMOS passes a 1 only to VDD − Vt (H), a PMOS a 0 only to Vt (L). The bit is kept (a
// CMOS gate reading H reads 1 and restores it, its PMOS partly on: leaky); a 1 passed by an NMOS whose gate is H is X.

import { describe, expect, it } from 'vitest';
import { GND, NMOS, PMOS, TGATE, VDD } from '../src/lib';
import { registry } from '../src/lib/define';
import { flatten } from '../src/sim/flatten';
import { SwitchSim, WEAK_H, WEAK_L } from '../src/sim/switchsim';
import { B0, B1, BX, type ComponentDef, type InstanceDef, type NetDef } from '../src/sim/types';

const sw = (def: ComponentDef) => new SwitchSim(flatten(def, { mode: 'switch' }));
const net = (s: SwitchSim, p: string) => s.design.root.ports[p][0];
const leaf = (s: SwitchSim, name: string) => s.design.leaves.findIndex((l) => l.node.path.join('.') === name);
const cell = (id: string, ins: string[], outs: string[], instances: InstanceDef[], nets: NetDef[]): ComponentDef => ({
  id, name: id, category: 'transistor',
  ports: [...ins.map((name) => ({ name, width: 1, dir: 'in' as const })), ...outs.map((name) => ({ name, width: 1, dir: 'out' as const }))],
  symbol: { kind: 'box', label: id },
  netlist: () => ({ level: 'switch', instances, nets }),
});

/** A buffer drawn the wrong way round: the NMOS to VDD, the PMOS to GND, both gated by a; z = NOT y. */
const BACKWARDS = cell('t_back', ['a'], ['y', 'z'], [
  { name: 'vdd', def: VDD }, { name: 'gnd', def: GND }, { name: 'n1', def: NMOS }, { name: 'p1', def: PMOS },
  { name: 'vdd2', def: VDD }, { name: 'gnd2', def: GND }, { name: 'ip', def: PMOS }, { name: 'in', def: NMOS },
], [
  { ends: ['a', 'n1.g', 'p1.g'] }, { ends: ['vdd.p', 'n1.d'] }, { ends: ['gnd.p', 'p1.d'] },
  { ends: ['y', 'n1.s', 'p1.s', 'ip.g', 'in.g'] },
  { ends: ['vdd2.p', 'ip.s'] }, { ends: ['gnd2.p', 'in.s'] }, { ends: ['z', 'ip.d', 'in.d'] },
]);

/** d passed by an NMOS (y1), by a transmission gate (y2). */
const PASS = cell('t_pass', ['d', 'en', 'enb'], ['y1', 'y2'], [{ name: 'n1', def: NMOS }, { name: 'tg', def: TGATE }], [
  { ends: ['d', 'n1.d', 'tg.a'] }, { ends: ['en', 'n1.g', 'tg.en'] }, { ends: ['enb', 'tg.en_n'] },
  { ends: ['y1', 'n1.s'] }, { ends: ['y2', 'tg.b'] },
]);

/** a 1 from VDD through an NMOS whose gate is y, itself H (passed by n1 from VDD, gated by a). */
const TWO_DROPS = cell('t_two', ['a'], ['y', 'w'], [
  { name: 'vdd', def: VDD }, { name: 'vdd2', def: VDD }, { name: 'n1', def: NMOS }, { name: 'n2', def: NMOS },
], [
  { ends: ['a', 'n1.g'] }, { ends: ['vdd.p', 'n1.d'] }, { ends: ['y', 'n1.s', 'n2.g'] },
  { ends: ['vdd2.p', 'n2.d'] }, { ends: ['w', 'n2.s'] },
]);

describe('weak levels', () => {
  it('an NMOS passes a weak 1, a PMOS a weak 0; the inverter after restores it and leaks', () => {
    const s = sw(BACKWARDS);
    s.setInput('a', 1); s.settle();
    expect(s.get(net(s, 'y'))).toBe(B1);
    expect(s.weakOf(net(s, 'y'))).toBe(WEAK_H);
    expect(s.get(net(s, 'z'))).toBe(B0);
    expect(s.weakOf(net(s, 'z'))).toBe(0); // restored: from the rail
    expect(s.leaky(leaf(s, 'ip'))).toBe(true); // its PMOS sees 0.8 V: partly on
    expect(s.leaky(leaf(s, 'in'))).toBe(false);
    s.setInput('a', 0); s.settle();
    expect(s.get(net(s, 'y'))).toBe(B0);
    expect(s.weakOf(net(s, 'y'))).toBe(WEAK_L);
    expect(s.get(net(s, 'z'))).toBe(B1);
    expect(s.leaky(leaf(s, 'in'))).toBe(true);
    expect(s.leaky(leaf(s, 'ip'))).toBe(false);
  });
  it('a transmission gate passes both values whole; an NMOS alone only the 0', () => {
    const s = sw(PASS);
    s.setInput('en', 1); s.setInput('enb', 0);
    for (const d of [0, 1]) {
      s.setInput('d', d); s.settle();
      expect([s.get(net(s, 'y1')), s.get(net(s, 'y2'))], `d=${d}`).toEqual(d ? [B1, B1] : [B0, B0]);
      expect(s.weakOf(net(s, 'y1')), `d=${d}`).toBe(d ? WEAK_H : 0);
      expect(s.weakOf(net(s, 'y2')), `d=${d}`).toBe(0);
    }
  });
  it('a 1 passed by an NMOS whose gate is a weak 1 is X (0.8 V − Vt)', () => {
    const s = sw(TWO_DROPS);
    s.setInput('a', 1); s.settle();
    expect(s.weakOf(net(s, 'y'))).toBe(WEAK_H);
    expect(s.get(net(s, 'w'))).toBe(BX);
  });
  // (an internal node of a series stack may be weak: a NAND's middle node with a = 1, b = 0 charges through the top
  // NMOS to VDD − Vt; it reaches no gate)
  it('complementary CMOS: outputs never weak, nothing leaks', () => {
    for (const id of ['inv_cmos', 'nand', 'nor_cmos']) {
      const def = registry.get(id)!;
      const s = sw(def);
      for (let v = 0; v < 4; v++) {
        def.ports.filter((p) => p.dir === 'in').forEach((p, k) => s.setInput(p.name, (v >> k) & 1));
        s.settle();
        for (const p of def.ports.filter((q) => q.dir === 'out')) expect(s.weakOf(net(s, p.name)), `${id} ${v}`).toBe(0);
        s.design.leaves.forEach((_, li) => expect(s.leaky(li), `${id} ${v} leaf ${li}`).toBe(false));
      }
    }
  });
});
