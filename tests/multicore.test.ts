import { describe, expect, it } from 'vitest';
import { ARBITER2, dualCore } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { disasm } from '../src/riscv/isa';
import { MC_PROGRAMS } from '../src/riscv/mcprograms';
import { MultiISS } from '../src/riscv/multi';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';

describe('A extension subset and mhartid', () => {
  it('assembles and disassembles', () => {
    const r = assemble('amoswap.w t2, t3, (s2)\namoadd.w t0, t1, (s0)\ncsrr a0, mhartid');
    expect(r.errors).toEqual([]);
    expect(r.words.slice(0, 2).map((w) => disasm(w))).toEqual(['amoswap.w t2, t3, (s2)', 'amoadd.w t0, t1, (s0)']);
  });
  it('the golden model reproduces the race and its fixes', () => {
    const run = (id: string) => { const m = new MultiISS(assemble(MC_PROGRAMS.find((p) => p.id === id)!.source).words); for (let c = 0; c < 2000 && !m.halted; c++) m.step(); return m; };
    const race = run('race').dmem[16];
    console.log('race counter', race);
    expect(race).toBeLessThan(40);
    expect(run('atomic').dmem[16]).toBe(40);
    expect(run('lock').dmem[16]).toBe(40);
    const h = run('harts');
    expect([h.dmem[20], h.dmem[21]]).toEqual([36, 36]);
  });
});

describe('arbiter', () => {
  it('grants one requester per cycle and alternates on conflicts', () => {
    const s = simulate(ARBITER2);
    const set = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) s.setInput(k, x); s.settle(); };
    const g = () => [pack(s.getBits(s.design.root.ports.g0)), pack(s.getBits(s.design.root.ports.g1))];
    const tick = () => { set({ clk: 1 }); set({ clk: 0 }); };
    set({ clk: 0, r0: 0, r1: 0 });
    expect(g()).toEqual([0, 0]);
    set({ r0: 1 }); expect(g()).toEqual([1, 0]);
    set({ r0: 0, r1: 1 }); expect(g()).toEqual([0, 1]);
    set({ r0: 1, r1: 1 });
    const seq: number[][] = [];
    for (let i = 0; i < 4; i++) { seq.push(g()); tick(); }
    expect(seq).toEqual([[1, 0], [0, 1], [1, 0], [0, 1]]);
  });
});

function cosim(source: string, cycles = 1500) {
  const asm = assemble(source);
  const design = flatten(dualCore(asm.words));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const m = new MultiISS(asm.words);
  const root = design.root;
  const cores = [root.children!.get('core0')!, root.children!.get('core1')!];
  let c = 0, stalls = 0;
  for (; c < cycles && !m.halted; c++) {
    const hwRetire = [0, 1].map((i) => sim.getBits(root.ports[`retire${i}`])[0] === 1);
    const retired = m.step();
    expect(hwRetire, `cycle ${c}: who retires`).toEqual(retired);
    stalls += retired.filter((r) => !r).length;
    clockCycle(sim);
    cores.forEach((core, i) => {
      const st = cpuState(sim, core);
      expect(st.pc, `cycle ${c}: core ${i} pc`).toBe(m.harts[i].pc);
      expect(st.x, `cycle ${c}: core ${i} registers`).toEqual([...m.harts[i].x]);
    });
  }
  expect(m.halted).toBe(true);
  const dm = root.children!.get('dm')!.children!.get('ram')!;
  const mem = Array.from({ length: 32 }, (_, i) => pack(sim.getBits(dm.children!.get(`w${i}`)!.ports.q)) >>> 0);
  expect(mem).toEqual([...m.dmem]);
  return { cycles: c, stalls, counter: m.dmem[16], leaves: design.leaves.length };
}

describe('dual-core (gate level) vs multi-hart golden model', () => {
  for (const p of MC_PROGRAMS) it(p.id, () => { const r = cosim(p.source); console.log(`${p.id}: ${r.cycles} cycles, ${r.stalls} stalls, counter ${r.counter}, ${r.leaves} leaves`); }, 600000);
});

import { Coherence } from '../src/sim/coherence';
describe('coherence protocols', () => {
  it('MSI vs MESI on private read-then-write, and ping-pong', () => {
    const run = (p: 'MSI' | 'MESI', ops: [number, number, boolean][]) => { const c = new Coherence(2, p); for (const [a, b, w] of ops) c.access(a, b, w); return c; };
    const priv: [number, number, boolean][] = [[0, 0, false], [0, 0, true], [1, 1, false], [1, 1, true]];
    expect(run('MSI', priv).stats.bus).toBe(4);   // BusRd + BusUpgr each
    expect(run('MESI', priv).stats.bus).toBe(2);  // E → M is silent
    const pp = run('MESI', [[0, 0, true], [1, 0, true], [0, 0, true], [1, 0, true]]);
    expect(pp.stats).toMatchObject({ bus: 4, invalidations: 3, writebacks: 3 });
    const shared = run('MESI', [[0, 0, false], [1, 0, false]]);
    expect(shared.state.map((r) => r[0])).toEqual(['S', 'S']);
  });
});
