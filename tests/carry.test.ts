// carry(): a rebuilt design takes over the state of the previous simulation (the sandbox
// editor recompiles the circuit on every edit; a counter must keep counting).

import { describe, expect, it } from 'vitest';
import { DRAM_CELL, SRAM_COLUMN } from '../src/lib/cells';
import { counter, SR_LATCH } from '../src/lib/sequential';
import { INV_CMOS, NAND } from '../src/lib/transistors';
import { findNode, flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { SwitchSim } from '../src/sim/switchsim';
import { B0, B1, BZ, type ComponentDef, type InstanceDef, type NetDef, type PortDef } from '../src/sim/types';
import { out, set, tick } from './util';

const bit = (name: string, dir: 'in' | 'out', width = 1): PortDef => ({ name, width, dir });

/** A throwaway top level (not registered in the library), like the editor's compiled circuit. */
function wrap(id: string, ports: PortDef[], instances: InstanceDef[], nets: NetDef[]): ComponentDef {
  return { id, name: id, category: 'sequential', ports, symbol: { kind: 'box' }, netlist: () => ({ instances, nets }) };
}

/** The extra, unrelated part added by the "edit": a NAND used as an inverter. */
const extra = { ports: [bit('x', 'in'), bit('nx', 'out')], inst: { name: 'extra', def: NAND }, nets: [{ ends: ['x', 'extra.a', 'extra.b'] }, { ends: ['extra.y', 'nx'] }] };

describe('GateSim.carry', () => {
  const C = counter(4);
  const cPorts = [bit('en', 'in'), bit('clk', 'in'), bit('q', 'out', 4)];
  const cNets: NetDef[] = [{ ends: ['en', 'cnt.en'] }, { ends: ['clk', 'cnt.clk'] }, { ends: ['cnt.q', 'q'] }];
  const before = wrap('t_cnt_a', cPorts, [{ name: 'cnt', def: C }], cNets);
  const after = wrap('t_cnt_b', [...cPorts, ...extra.ports], [{ name: 'cnt', def: C }, extra.inst], [...cNets, ...extra.nets]);

  it('a counter keeps its count when an unrelated gate is added, and keeps counting', () => {
    const a = new GateSim(flatten(before));
    set(a, { en: 1, clk: 0 });
    for (let i = 0; i < 5; i++) tick(a);
    expect(out(a, 'q')).toBe(5);

    const fresh = new GateSim(flatten(after));
    expect(out(fresh, 'q')).toBe(0);

    const b = new GateSim(flatten(after));
    b.carry(a);
    expect(b.getInput('en')).toBe(1);
    expect(out(b, 'q')).toBe(5);
    expect(b.time).toBe(a.time);
    set(b, { x: 1 });
    expect(out(b, 'nx')).toBe(0);
    tick(b);
    tick(b);
    expect(out(b, 'q')).toBe(7);
    expect(out(a, 'q')).toBe(5); // the old simulation is untouched
  });

  it('a renamed instance is a different part: it starts from power-on', () => {
    const a = new GateSim(flatten(before));
    set(a, { en: 1, clk: 0 });
    for (let i = 0; i < 3; i++) tick(a);
    const renamed = wrap('t_cnt_c', cPorts, [{ name: 'cnt2', def: C }],
      [{ ends: ['en', 'cnt2.en'] }, { ends: ['clk', 'cnt2.clk'] }, { ends: ['cnt2.q', 'q'] }]);
    const b = new GateSim(flatten(renamed));
    b.carry(a);
    expect(out(b, 'q')).toBe(0);
  });

  it('an SR latch keeps its stored bit', () => {
    const lPorts = [bit('s_n', 'in'), bit('r_n', 'in'), bit('q', 'out'), bit('q_n', 'out')];
    const lNets: NetDef[] = [{ ends: ['s_n', 'sr.s_n'] }, { ends: ['r_n', 'sr.r_n'] }, { ends: ['sr.q', 'q'] }, { ends: ['sr.q_n', 'q_n'] }];
    const after = wrap('t_sr_b', [...lPorts, ...extra.ports], [{ name: 'sr', def: SR_LATCH }, extra.inst], [...lNets, ...extra.nets]);
    for (const v of [1, 0]) {
      const a = new GateSim(flatten(wrap('t_sr_a', lPorts, [{ name: 'sr', def: SR_LATCH }], lNets)));
      set(a, { s_n: v ? 0 : 1, r_n: v ? 1 : 0 });
      set(a, { s_n: 1, r_n: 1 }); // hold
      expect([out(a, 'q'), out(a, 'q_n')]).toEqual([v, 1 - v]);

      const b = new GateSim(flatten(after));
      b.carry(a);
      expect([b.getInput('s_n'), b.getInput('r_n')]).toEqual([1, 1]);
      expect([out(b, 'q'), out(b, 'q_n')]).toEqual([v, 1 - v]);
      expect(b.unstable).toBe(false);
      set(b, { s_n: v, r_n: 1 - v }); // and it still flips
      set(b, { s_n: 1, r_n: 1 });
      expect([out(b, 'q'), out(b, 'q_n')]).toEqual([1 - v, v]);
    }
  });

  it('copies the private state of a behavioural leaf with the same path and id', () => {
    const EDGES: ComponentDef = {
      id: 't_edges', name: 'edge counter', category: 'sequential',
      ports: [bit('c', 'in'), bit('n', 'out', 8)], symbol: { kind: 'box' },
      behavior: {
        init: () => ({ n: 0, last: 0 }),
        eval: ([c], s) => {
          const st = s as { n: number; last: number };
          if (c === 1 && st.last === 0) st.n++;
          if (c >= 0) st.last = c;
          return [st.n];
        },
      },
    };
    const nets: NetDef[] = [{ ends: ['clk', 'e.c'] }, { ends: ['e.n', 'n'] }];
    const ports = [bit('clk', 'in'), bit('n', 'out', 8)];
    const a = new GateSim(flatten(wrap('t_e_a', ports, [{ name: 'e', def: EDGES }], nets)));
    for (let i = 0; i < 3; i++) { set(a, { clk: 1 }); set(a, { clk: 0 }); }
    expect(out(a, 'n')).toBe(3);
    const b = new GateSim(flatten(wrap('t_e_b', [...ports, ...extra.ports], [{ name: 'e', def: EDGES }, extra.inst], [...nets, ...extra.nets])));
    b.carry(a);
    expect(out(b, 'n')).toBe(3);
    set(b, { clk: 1 });
    expect(out(b, 'n')).toBe(4);
    expect(out(a, 'n')).toBe(3);
    set(a, { clk: 1 }); // the two states are separate copies
    expect(out(a, 'n')).toBe(4);
    set(b, { clk: 0 });
    set(b, { clk: 1 });
    expect(out(b, 'n')).toBe(5);
  });
});

describe('SwitchSim.carry', () => {
  it('a DRAM cell keeps its stored charge', () => {
    const ports = [bit('wl', 'in'), bit('bl', 'in'), bit('q', 'out')];
    const nets: NetDef[] = [{ ends: ['wl', 'm.wl'] }, { ends: ['bl', 'm.bl'] }, { ends: ['m.q', 'q'] }];
    const before = wrap('t_dram_a', ports, [{ name: 'm', def: DRAM_CELL }], nets);
    const after = wrap('t_dram_b', [...ports, bit('x', 'in'), bit('nx', 'out')],
      [{ name: 'm', def: DRAM_CELL }, { name: 'inv', def: INV_CMOS }],
      [...nets, { ends: ['x', 'inv.a'] }, { ends: ['inv.y', 'nx'] }]);
    for (const v of [1, 0]) {
      const a = new SwitchSim(flatten(before, { mode: 'switch' }));
      set(a, { wl: 1, bl: v });
      set(a, { wl: 0, bl: 1 - v });
      expect(a.get(a.design.root.ports.q[0])).toBe(v ? B1 : B0);

      const fresh = new SwitchSim(flatten(after, { mode: 'switch' }));
      expect(fresh.get(fresh.design.root.ports.q[0])).toBe(BZ);

      const b = new SwitchSim(flatten(after, { mode: 'switch' }));
      b.carry(a);
      expect(b.getInput('bl')).toBe(1 - v);
      expect(b.get(b.design.root.ports.q[0])).toBe(v ? B1 : B0);
      set(b, { x: 1 });
      expect(b.get(b.design.root.ports.nx[0])).toBe(B0);
      expect(b.get(b.design.root.ports.q[0])).toBe(v ? B1 : B0);
      set(b, { wl: 1 }); // and it can still be overwritten
      expect(b.get(b.design.root.ports.q[0])).toBe(v ? B0 : B1);
    }
  });

  it('6T SRAM cells keep their bits (cross-coupled inverters)', () => {
    const a = new SwitchSim(flatten(SRAM_COLUMN, { mode: 'switch' }));
    set(a, { pre_n: 1, w0: 0, w1: 0, wl0: 0, wl1: 0 });
    set(a, { w1: 1, wl0: 1 });
    set(a, { wl0: 0, w1: 0 });
    set(a, { w0: 1, wl1: 1 });
    set(a, { wl1: 0, w0: 0 });
    const q = (s: SwitchSim, cell: string) => {
      const n = findNode(s.design.root, [cell])!;
      return s.get(n.nets![n.def.netlist!().nets.findIndex((x) => x.name === 'q')][0]);
    };
    expect([q(a, 'c0'), q(a, 'c1')]).toEqual([B1, B0]);
    const b = new SwitchSim(flatten(SRAM_COLUMN, { mode: 'switch' }));
    b.carry(a);
    expect([q(b, 'c0'), q(b, 'c1')]).toEqual([B1, B0]);
  });
});

describe('carry({ known })', () => {
  const C = counter(4);
  const en: NetDef = { ends: ['en', 'cnt.en'] }, q: NetDef = { ends: ['cnt.q', 'q'] };
  // The clock not wired yet: it floats at X, and so does the count.
  const half = wrap('t_cnt_half', [bit('en', 'in'), bit('q', 'out', 4)], [{ name: 'cnt', def: C }], [en, q]);
  const full = wrap('t_cnt_full', [bit('en', 'in'), bit('clk', 'in'), bit('q', 'out', 4)], [{ name: 'cnt', def: C }], [en, { ends: ['clk', 'cnt.clk'] }, q]);

  it('heals storage that went X while half wired; a plain carry keeps the X', () => {
    // A rebuild re-evaluates everything: with the clock at X the latches lose their bit.
    const a = new GateSim(flatten(half));
    a.carry(new GateSim(flatten(half)));
    set(a, { en: 1 });
    expect(out(a, 'q')).toBe(-1);
    const plain = new GateSim(flatten(full));
    plain.carry(a);
    expect(out(plain, 'q')).toBe(-1);
    const healed = new GateSim(flatten(full));
    healed.carry(a, { known: true });
    expect(out(healed, 'q')).toBe(0);
    set(healed, { clk: 0 });
    tick(healed);
    expect(out(healed, 'q')).toBe(1);
  });
});
