// Port memories (lib/portmem.ts): a read and a write port per lane, up to 1K words. Above 64 words the
// memory is one behavioural leaf over banks of lanePortMemory(6, …): the leaf must behave exactly like
// that structure (the highest port winning a word several write), and opened, show its words.

import { describe, expect, it } from 'vitest';
import { lanePortMemory } from '../src/lib/warps';
import { bigPortMemory, portBank, portMemory, type PortRamState } from '../src/lib/portmem';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { ViewCtx } from '../src/view/context';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';
import { lcg, out, set } from './util';

function host(id: string, M: ComponentDef): ComponentDef {
  return {
    id, name: id, category: 'memory', ports: M.ports, symbol: { kind: 'box' },
    netlist: () => ({ instances: [{ name: 'mem', def: M, at: [10, 0] }], nets: M.ports.map((p) => ({ ends: p.dir === 'in' ? [p.name, `mem.${p.name}`] : [`mem.${p.name}`, p.name] })) }),
  };
}

const tick = (sim: { setInput(p: string, v: number): void; settle(): void }) => {
  sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
};

describe('port memory', { timeout: 120000 }, () => {
  it('64 words and fewer are lanePortMemory at that width', () => {
    expect(portMemory(6, 16, 4)).toBe(lanePortMemory(6, 4, undefined, false, 16));
    expect(lanePortMemory(6, 4).id).toBe('lpmem6_4');
    expect(lanePortMemory(6, 4, undefined, false, 16).ports.find((p) => p.name === 'rd0')!.width).toBe(16);
  });

  it('behaviour ≡ structure: every port writing and reading at once, the highest port winning', () => {
    const k = 7, w = 5, n = 4;
    const d = bigPortMemory(k, w, n);
    const full = new GateSim(flatten(d, { expand: () => true }));
    const leaf = new GateSim(flatten(d));
    expect(leaf.design.leaves).toHaveLength(1);
    const rnd = lcg(7);
    const ref = new Array<number>(2 ** k).fill(0);
    for (let s = 0; s < 60; s++) {
      // often two ports on one word: the higher one's word lands
      const a = Array.from({ length: n }, () => (rnd(3) ? rnd(2 ** k) : 9)), v = a.map(() => rnd(2 ** w)), we = rnd(2 ** n);
      for (const sim of [full, leaf]) {
        set(sim, { clk: 0, we, ...Object.fromEntries(a.map((x, i) => [`addr${i}`, x])), ...Object.fromEntries(v.map((x, i) => [`wd${i}`, x])) });
        tick(sim);
      }
      for (let i = 0; i < n; i++) if ((we >> i) & 1) ref[a[i]] = v[i];
      const r = a.map(() => rnd(2 ** k));
      for (const sim of [full, leaf]) set(sim, { we: 0, ...Object.fromEntries(r.map((x, i) => [`addr${i}`, x])) });
      for (let i = 0; i < n; i++) expect([out(full, `rd${i}`), out(leaf, `rd${i}`)], `step ${s} port ${i}`).toEqual([ref[r[i]], ref[r[i]]]);
    }
  });

  it('BitSim agrees with the structure', () => {
    const d = bigPortMemory(7, 4, 2);
    const full = new BitSim(flatten(d, { expand: () => true }));
    const leaf = new BitSim(flatten(d));
    const rnd = lcg(3);
    for (let s = 0; s < 40; s++) {
      const v = { addr0: rnd(128), addr1: s % 4 ? rnd(128) : 3, wd0: rnd(16), wd1: rnd(16), we: rnd(4), clk: 0 };
      for (const sim of [full, leaf]) {
        for (const [p, x] of Object.entries(v)) sim.setInput(p, x);
        sim.cycle();
      }
      expect([leaf.get('rd0', 1), leaf.get('rd1', 1)]).toEqual([full.get('rd0', 1), full.get('rd1', 1)]);
    }
  });

  it('initial contents, and opened: the banks hold the leaf’s words down to their registers', () => {
    const init = Array.from({ length: 1024 }, (_, i) => (i * 37) & 0xffff);
    const d = portMemory(10, 16, 4, init);
    const sim = new GateSim(flatten(host('t_pm_host10', d)));
    set(sim, { clk: 0, we: 0, addr0: 5, addr1: 700, addr2: 1023, addr3: 0 });
    expect([0, 1, 2, 3].map((i) => out(sim, `rd${i}`))).toEqual([5 * 37, 700 * 37 & 0xffff, 1023 * 37 & 0xffff, 0]);
    set(sim, { we: 0b0110, addr1: 130, wd1: 0x1111, addr2: 130, wd2: 0x2222 });
    tick(sim);
    set(sim, { we: 0, addr0: 130 });
    expect(out(sim, 'rd0')).toBe(0x2222);
    const mem = new ViewCtx(sim, sim.design.root).child('mem')!;
    expect(mem.isSubSim).toBe(true);
    const b2 = mem.node.children!.get('bank2')!;
    expect((mem.sim.leafState(b2.leafIndex!) as PortRamState).mem[2]).toBe(0x2222);
    const bank = mem.child('bank2')!;
    expect(bank.def).toBe(portBank(16, 4));
    const reg = (i: number) => pack(bank.sim.getBits(bank.node.children!.get(`w${i}`)!.ports.q));
    expect([reg(1), reg(2), reg(3)]).toEqual([129 * 37, 0x2222, 131 * 37]);
  });

  it('draws cleanly: no symbol on another, no label hiding one, no two nets on one line', () => {
    for (const d of [bigPortMemory(10, 16, 4), bigPortMemory(7, 16, 4), portBank(16, 4)]) {
      const nl = netlistOf(d)!;
      expect(symbolOverlaps(nl), d.id).toEqual([]);
      expect(labelOverlaps(d, nl), d.id).toEqual([]);
      expect(wireOverlaps(routeNetlist(d, nl).nets), d.id).toEqual([]);
    }
  });
});
