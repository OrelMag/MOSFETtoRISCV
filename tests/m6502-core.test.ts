// The sandbox's 6502 part (lib/m6502/core.ts): its behaviour makes the ISS's bus cycles on the part's
// synchronous pins, its structure (the transistor-level chip behind the pin glue) makes the same ones,
// and opened inside a running circuit the chip replays to the behaviour's state.
import { describe, expect, it } from 'vitest';
import { core6502, type Core6502State } from '../src/lib/m6502/core';
import { assemble, toImage } from '../src/m6502/asm';
import { Cpu6502, Ram64 } from '../src/m6502/iss';
import { PROGRAMS } from '../src/m6502/programs';
import { findNode, flatten, type HierNode } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { NmosSim } from '../src/sim/nmossim';
import type { Sim } from '../src/sim/sim';
import type { ComponentDef } from '../src/sim/types';
import { netlistOf } from '../src/sim/types';
import { ViewCtx } from '../src/view/context';

const image = (name: string) => toImage(assemble(PROGRAMS.find((p) => p.name === name)!.source));
const B = core6502().behavior!;

/** The behaviour alone, clocked by hand with a memory on its pins. */
class Part {
  st = B.init!('zero') as Core6502State;
  out: number[] = [];
  constructor(readonly mem: Ram64) { this.eval(0); }
  eval(clk: number, lines = { res: false, irq: false, nmi: false }): void {
    const a = this.out[0] ?? this.st.addr;
    const din = this.mem.mem[a];
    this.out = B.eval([clk, lines.res ? 0 : 1, lines.irq ? 0 : 1, lines.nmi ? 0 : 1, din], this.st);
  }
  /** One cycle: what it put out, then the edge that ends it (a write stored at the edge). */
  cycle(lines?: { res: boolean; irq: boolean; nmi: boolean }): { addr: number; data: number; write: boolean; sync: number } {
    const [a, d, rw, sync] = this.out;
    const c = { addr: a, data: rw ? this.mem.mem[a] : d, write: rw === 0, sync };
    this.eval(0, lines);
    if (c.write) this.mem.write(a, d);
    this.eval(1, lines);
    return c;
  }
}

describe('6502 part: behaviour', () => {
  for (const name of ['hello', 'fib', 'sort', 'bcd']) {
    it(`${name}: the ISS's bus cycles from power-on`, () => {
      const img = image(name);
      const ram = new Ram64(); ram.mem.set(img);
      const part = new Part(ram);
      const ref = new Ram64(); ref.mem.set(img);
      const iss = new Cpu6502(ref);
      iss.reset();
      for (let c = 0; c < 3000; c++) {
        const got = part.cycle(), want = iss.cycle();
        expect([c, got.addr, got.data, got.write, got.sync]).toEqual([c, want.addr, want.data, want.rw === 'w', want.sync]);
      }
    });
  }

  it('resb low at an edge restarts it; an X read makes it unknown until then', () => {
    const ram = new Ram64(); ram.mem.set(image('fib'));
    const part = new Part(ram);
    for (let c = 0; c < 200; c++) part.cycle();
    part.cycle({ res: true, irq: false, nmi: false });
    // the reset sequence: two reads at PC, three stack reads, the vector
    const seq = Array.from({ length: 7 }, () => part.cycle());
    expect(seq.slice(5).map((c) => c.addr)).toEqual([0xfffc, 0xfffd]);
    expect(part.cycle()).toMatchObject({ addr: 0x0200, sync: 1 });
    B.eval([0, 1, 1, 1, -1], part.st);
    expect(B.eval([1, 1, 1, 1, -1], part.st)).toEqual([-1, -1, -1, -1]);
    part.cycle({ res: true, irq: false, nmi: false });
    expect(part.st.x).toBe(false);
  });
});

/** The registers of the chip inside a design, read from its storage nodes. */
function chipRegs(sim: Sim, root: HierNode) {
  const net = (path: string[], name: string) => {
    const node = findNode(root, path)!;
    const nl = netlistOf(node.def)!;
    const k = nl.nets.findIndex((n) => n.name === name);
    return sim.get(k >= 0 ? node.nets![k][0] : node.ports[name][0]);
  };
  const reg = (blk: string) => {
    let v = 0;
    for (let i = 0; i < 8; i++) v |= net(['chip', 'dp', blk, `b${i}`], 'q') << i;
    return v;
  };
  let pc = 0;
  for (let i = 0; i < 16; i++) pc |= net(['chip', 'dp', 'pc'], `pc${i}`) << i;
  return { a: reg('rega'), x: reg('regx'), y: reg('regy'), s: reg('regs'), pc };
}

describe('6502 part: structure', () => {
  it('the transistor chip behind the pins makes the behaviour\'s bus cycles', () => {
    const img = image('sort');
    const sim = new NmosSim(flatten(core6502(), { mode: 'switch', expand: (d, n) => n.parent === null || !d.preferBehavior }));
    const P = sim.design.root.ports;
    const get = (p: string) => P[p].reduce((v, n, i) => v | (sim.get(n) << i), 0);
    const mem = new Ram64(); mem.mem.set(img);
    const cyc = (res: boolean) => {
      sim.setInput('clk', 1); sim.settle();
      sim.setInput('resb', res ? 0 : 1); sim.setInput('irqb', 1); sim.setInput('nmib', 1); sim.settle();
      const a = get('a'), read = get('rw') === 1;
      sim.setInput('din', read ? mem.mem[a] : 0); sim.settle();
      sim.setInput('clk', 0); sim.settle();
      const c = { addr: a, data: read ? mem.mem[a] : get('dout'), write: !read, sync: get('sync') };
      if (c.write) mem.write(a, c.data);
      return c;
    };
    cyc(true); cyc(true);
    // the chip's power-on registers are arbitrary: the part's start where the chip's are
    const ref = new Ram64(); ref.mem.set(img);
    const part = new Part(ref);
    Object.assign(part.st.cpu, chipRegs(sim, sim.design.root), { p: 0x20 });
    part.eval(0);
    for (let c = 0; c < 1500; c++) {
      const want = part.cycle(), got = cyc(false);
      expect([c, got.addr, got.data, got.write, got.sync]).toEqual([c, want.addr, want.data, want.write, want.sync]);
    }
  });
});

/** A memory part for the bench: q = mem[a], d written at the rising edge of clk while we = 1. */
const MEM: ComponentDef = {
  id: 'test_mem64k', name: 'mem', category: 'memory', symbol: { kind: 'box' },
  ports: [{ name: 'a', width: 16, dir: 'in' }, { name: 'd', width: 8, dir: 'in' }, { name: 'we', width: 1, dir: 'in' }, { name: 'clk', width: 1, dir: 'in' },
    { name: 'q', width: 8, dir: 'out' }],
  behavior: {
    init: () => ({ mem: new Uint8Array(0x10000), clk: 0, a: 0, d: 0, we: 0 }),
    seq: { clk: 'clk', comb: ['a'] },
    eval: ([a, d, we, clk], st) => {
      const s = st as { mem: Uint8Array; clk: number; a: number; d: number; we: number };
      if (clk !== 1) { s.a = a; s.d = d; s.we = we; }
      if (s.clk === 0 && clk === 1 && s.we === 1) s.mem[s.a] = s.d;
      s.clk = clk;
      return [a < 0 ? -1 : s.mem[a]];
    },
  },
};

describe('6502 part: opened inside a running circuit', () => {
  it('the chip replays to the behaviour\'s registers and bus, incrementally and after a jump', () => {
    const NOT: ComponentDef = { id: 'test_not', name: 'not', category: 'gate', symbol: { kind: 'not' }, ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }], behavior: { eval: ([a]) => [a < 0 ? -1 : a ^ 1] } };
    const top: ComponentDef = {
      id: 'test_6502_top', name: 'top', category: 'cpu', symbol: { kind: 'box' },
      ports: [{ name: 'clk', width: 1, dir: 'in' }, { name: 'irqb', width: 1, dir: 'in' }],
      netlist: () => ({
        instances: [{ name: 'cpu', def: core6502() }, { name: 'mem', def: MEM }, { name: 'inv', def: NOT }],
        nets: [
          { ends: ['clk', 'cpu.clk', 'mem.clk'] }, { ends: ['irqb', 'cpu.irqb'] },
          { ends: ['cpu.a', 'mem.a'] }, { ends: ['cpu.dout', 'mem.d'] }, { ends: ['mem.q', 'cpu.din'] },
          { ends: ['cpu.rw', 'inv.a'] }, { ends: ['inv.y', 'mem.we'] },
        ],
      }),
    };
    const sim = new GateSim(flatten(top));
    sim.reset('zero');
    const memLeaf = findNode(sim.design.root, ['mem'])!.leafIndex!;
    (sim.leafState(memLeaf) as { mem: Uint8Array }).mem.set(image('irq'));
    sim.setInput('clk', 0); sim.setInput('irqb', 1); sim.settle();
    const cpuLeaf = findNode(sim.design.root, ['cpu'])!.leafIndex!;
    const st = () => sim.leafState(cpuLeaf) as Core6502State;
    const root = new ViewCtx(sim, sim.design.root);
    const clock = (n: number, irqAt?: (c: number) => boolean) => {
      for (let i = 0; i < n; i++) {
        sim.setInput('irqb', irqAt?.(st().n) ? 0 : 1);
        sim.setInput('clk', 1); sim.settle();
        sim.setInput('clk', 0); sim.settle();
      }
    };
    const check = (label: string) => {
      const inside = root.child('cpu')!;
      inside.sync();
      expect(inside.sim).toBeInstanceOf(NmosSim);
      const s = st(), r = chipRegs(inside.sim, inside.node);
      const P = inside.node.ports, get = (p: string) => P[p].reduce((v, n, i) => v | (inside.sim.get(n) << i), 0);
      // the registers the ISS holds at its last instruction boundary are the chip's after the replay
      expect([label, get('a'), get('rw'), get('sync')]).toEqual([label, s.addr, s.write ? 0 : 1, s.sync]);
      if (s.log.length === 0 && !s.chk!.reset) expect([label, r.a, r.x, r.y, r.s]).toEqual([label, s.cpu.a, s.cpu.x, s.cpu.y, s.cpu.s]);
    };
    check('power-on');
    for (let k = 0; k < 40; k++) { clock(1); check(`cycle ${st().n}`); }
    clock(500, (c) => c % 97 < 20);
    check('after a jump');
    for (let k = 0; k < 40; k++) { clock(1, (c) => c % 97 < 20); check(`cycle ${st().n}`); }
  });
});
