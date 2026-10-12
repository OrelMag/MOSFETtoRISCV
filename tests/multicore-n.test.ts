import { describe, expect, it } from 'vitest';
import { ARBITER2, arbiterN, multiCore } from '../src/lib';
import { ramLeafState, ramWords } from '../src/lib/bigmem';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { MC_PROGRAMS } from '../src/riscv/mcprograms';
import { MultiISS } from '../src/riscv/multi';
import { CycleSim } from '../src/sim/cyclesim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';

/** MultiISS's arbitration: the first requester at or after the priority wins; a conflict moves the priority past it. */
class RefArbiter {
  p = 0;
  constructor(readonly n: number) {}
  grant(r: boolean[]): number {
    for (let k = 0; k < this.n; k++) if (r[(this.p + k) % this.n]) return (this.p + k) % this.n;
    return -1;
  }
  clock(r: boolean[]): void {
    if (r.filter(Boolean).length > 1) this.p = (this.grant(r) + 1) % this.n;
  }
}

function rng(seed: number) {
  return () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 2 ** 24;
}

function grantsOf(def: typeof ARBITER2, n: number, reqs: boolean[][]): number[][] {
  const s = simulate(def);
  const out: number[][] = [];
  const set = (k: string, v: number) => s.setInput(k, v);
  set('clk', 0);
  for (const r of reqs) {
    r.forEach((x, i) => set(`r${i}`, x ? 1 : 0));
    s.settle();
    out.push(Array.from({ length: n }, (_, i) => pack(s.getBits(s.design.root.ports[`g${i}`]))));
    set('clk', 1); s.settle(); set('clk', 0); s.settle();
  }
  return out;
}

describe('n-way round-robin arbiter', () => {
  for (const n of [2, 3, 4, 5, 8]) {
    it(`${n} ways: the golden model's policy over random requests`, () => {
      const next = rng(n), ref = new RefArbiter(n);
      const reqs = Array.from({ length: 300 }, () => Array.from({ length: n }, () => next() < 0.55));
      const want = reqs.map((r) => { const g = ref.grant(r); ref.clock(r); return Array.from({ length: n }, (_, i) => (i === g ? 1 : 0)); });
      expect(grantsOf(arbiterN(n), n, reqs)).toEqual(want);
    });
  }
  it('2 ways: the same grants as ARBITER2', () => {
    const next = rng(7);
    const reqs = Array.from({ length: 200 }, () => [next() < 0.6, next() < 0.6]);
    expect(grantsOf(arbiterN(2), 2, reqs)).toEqual(grantsOf(ARBITER2, 2, reqs));
  });
  it('every requester is served within n conflicts', () => {
    const n = 8;
    const all = Array.from({ length: n }, () => Array(n).fill(true));
    const g = grantsOf(arbiterN(n), n, all).map((row) => row.indexOf(1));
    expect(g).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

function cosim(source: string, n: number, dmemK = 5, cycles = 3000) {
  const words = assemble(source).words;
  const design = flatten(multiCore(words, n, { dmemK }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const m = new MultiISS(words, n, 2 ** dmemK);
  const root = design.root;
  const cores = Array.from({ length: n }, (_, i) => root.children!.get(`core${i}`)!);
  let c = 0;
  for (; c < cycles && !m.halted; c++) {
    const hw = cores.map((_, i) => sim.getBits(root.ports[`retire${i}`])[0] === 1);
    const retired = m.step();
    expect(hw, `cycle ${c}: who retires`).toEqual(retired);
    clockCycle(sim);
    cores.forEach((core, i) => {
      const st = cpuState(sim, core);
      expect(st.pc, `cycle ${c}: core ${i} pc`).toBe(m.harts[i].pc);
      expect(st.x, `cycle ${c}: core ${i} registers`).toEqual([...m.harts[i].x]);
    });
  }
  expect(m.halted).toBe(true);
  const dm = root.children!.get('dm')!.children!.get('ram')!;
  const mem = dmemK > 6
    ? ramWords(ramLeafState(sim, dm)!).map((v) => v >>> 0)
    : Array.from({ length: 2 ** dmemK }, (_, i) => pack(sim.getBits(dm.children!.get(`w${i}`)!.ports.q)) >>> 0);
  expect(mem).toEqual([...m.dmem]);
  return { cycles: c, counter: m.dmem[16], leaves: design.leaves.length };
}

describe('multi-core (gate level) vs multi-hart golden model', () => {
  for (const p of MC_PROGRAMS) {
    it(`4 cores: ${p.id}`, () => {
      const r = cosim(p.source, 4);
      console.log(`4 cores, ${p.id}: ${r.cycles} cycles, counter ${r.counter}, ${r.leaves} leaves`);
    }, 600000);
  }
  it('8 cores: atomic', () => { cosim(MC_PROGRAMS.find((p) => p.id === 'atomic')!.source, 8); }, 600000);
  it('4 cores, 1K-word memory (large RAM): lock', () => { cosim(MC_PROGRAMS.find((p) => p.id === 'lock')!.source, 4, 10); }, 600000);
  it('runs on the cycle engine', () => {
    const d = flatten(multiCore(assemble(MC_PROGRAMS[0].source).words, 4));
    const c = CycleSim.build(d);
    expect('reason' in c ? c.reason : 'ok').toBe('ok');
  });
});
