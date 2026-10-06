import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { CACHE_CPU_PROGRAMS, TRACE_PROGRAMS } from '../src/riscv/cprograms';
import { ISS } from '../src/riscv/iss';
import { CacheModel, type CacheConfig } from '../src/sim/cachemodel';

export function traceOf(source: string, dmemWords = 1024) {
  const asm = assemble(source);
  expect(asm.errors).toEqual([]);
  const iss = new ISS(asm.words, { dmemWords });
  iss.memTrace = [];
  for (let i = 0; i < 20000 && !iss.halted; i++) iss.step();
  expect(iss.halted).toBe(true);
  return iss.memTrace;
}

const run = (cfg: CacheConfig, trace: { addr: number; write: boolean }[]) => {
  const c = new CacheModel(cfg);
  for (const a of trace) c.access(a.addr, a.write);
  return c.stats;
};
const base: CacheConfig = { size: 256, line: 16, ways: 1, replacement: 'lru', write: 'wb' };

describe('cache model', () => {
  it('row-major: one miss per line; column-major: misses everywhere', () => {
    const row = run(base, traceOf(TRACE_PROGRAMS[0].source));
    expect(row.accesses).toBe(256);
    expect(row.misses).toBe(64);
    expect(row.compulsory).toBe(64);
    const col = run(base, traceOf(TRACE_PROGRAMS[1].source));
    expect(col.misses).toBe(256);
    expect(col.capacity + col.conflict).toBe(192);
    // a cache as big as the matrix makes them equal
    expect(run({ ...base, size: 1024 }, traceOf(TRACE_PROGRAMS[1].source)).misses).toBe(64);
  });
  it('vector add thrashes direct-mapped, not 4-way', () => {
    const t = traceOf(TRACE_PROGRAMS[2].source);
    const dm = run({ ...base, size: 512 }, t), w4 = run({ ...base, size: 512, ways: 4 }, t);
    expect(dm.conflict).toBeGreaterThan(100);
    expect(w4.conflict).toBe(0);
    expect(w4.misses).toBe(48);
  });
  it('write-through moves every store; write-back only dirty lines', () => {
    const t = traceOf(TRACE_PROGRAMS[2].source);
    const wb = run({ ...base, size: 1024, ways: 4 }, t), wt = run({ ...base, size: 1024, ways: 4, write: 'wt' }, t);
    expect(wt.wordsWritten).toBe(64);
    expect(wb.wordsWritten).toBe(0); // nothing evicted yet
  });
  it('the CPU programs assemble', () => {
    for (const p of CACHE_CPU_PROGRAMS) traceOf(p.source, 64);
  });
});

import { cachedMemory, singleCycleCpu, wayLookup2, equal } from '../src/lib';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { evalOnce, simulate } from '../src/sim/harness';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';

describe('gate-level cache', () => {
  it('2-way lookup and comparators match their specs', () => {
    const d = wayLookup2(3, 4), s = simulate(d);
    let seed = 9;
    const r = (n: number) => ((seed = (seed * 1103515245 + 12345) >>> 0) % n);
    for (let i = 0; i < 400; i++) {
      const ins = [r(8), r(2), r(8), r(16), r(2), r(8), r(16)];
      if (i % 3 === 0) ins[2] = ins[0];
      expect(evalOnce(s, ins)).toEqual(d.spec!(ins));
    }
    const e = equal(2), se = simulate(e);
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) expect(evalOnce(se, [a, b])).toEqual([a === b ? 1 : 0]);
  });
  it('misses stall 8 cycles, then hit; stores write through', () => {
    const s = simulate(cachedMemory(6));
    const set = (v: Record<string, number>) => { for (const [k, x] of Object.entries(v)) s.setInput(k, x); s.settle(); };
    const out = (p: string) => pack(s.getBits(s.design.root.ports[p]));
    const tick = () => { set({ clk: 1 }); set({ clk: 0 }); };
    set({ clk: 0, re: 0, we: 0, addr: 0, wd: 0 });
    for (let i = 0; i < 16; i++) { set({ addr: 4 * i, wd: 0x100 + i, we: 1 }); tick(); }
    set({ we: 0, re: 1, addr: 0x24 });
    expect(out('stall')).toBe(1);
    let n = 0;
    while (out('stall')) { tick(); n++; expect(n).toBeLessThan(20); }
    expect(n).toBe(8);
    expect(out('rd')).toBe(0x109);
    for (const a of [0x20, 0x28, 0x2c]) { set({ addr: a }); expect([out('hit'), out('rd')]).toEqual([1, 0x100 + a / 4]); }
    // a store hit updates the cached copy and memory
    set({ re: 0, we: 1, addr: 0x28, wd: 0xabc }); tick();
    set({ we: 0, re: 1 });
    expect([out('hit'), out('rd')]).toEqual([1, 0xabc]);
    // same index, other tag: 0x24 + 64 misses
    set({ addr: 0x64 });
    expect(out('stall')).toBe(1);
  });
});

function cosimDc(source: string, cycles: number) {
  const asm = assemble(source);
  const design = flatten(singleCycleCpu(asm.words, { dmemK: 6, dcache: true }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words, { dmemWords: 64 });
  let c = 0, hits = 0, misses = 0;
  const root = design.root;
  for (; c < cycles && !iss.halted; c++) {
    const r = retiring(sim);
    const dm = root.children!.get('dm')!;
    if (sim.getBits(dm.ports.re)[0] === 1) { if (r) hits++; else if (pack(sim.getBits(root.children!.get('dm')!.children!.get('cnt')!.ports.q)) === 0) misses++; }
    let text = '(stalled)';
    if (r) text = iss.step().text;
    clockCycle(sim);
    const st = cpuState(sim);
    expect(st.pc, `cycle ${c}: pc after ${text}`).toBe(iss.pc);
    expect(st.x, `cycle ${c}: registers after ${text}`).toEqual([...iss.x]);
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles: c, steps: iss.steps, hits: hits - misses, misses, iss };
}

describe('single-cycle CPU with a data cache vs golden model', () => {
  it('reuse: 4 compulsory misses, then all hits', () => {
    const r = cosimDc(CACHE_CPU_PROGRAMS[0].source, 2000);
    console.log(`reuse: ${r.cycles} cycles, ${r.steps} instructions, ${r.hits} load hits, ${r.misses} misses`);
    expect(r.misses).toBe(4);
    expect(r.hits).toBe(28);
  }, 300000);
  it('pingpong: every load misses', () => {
    const r = cosimDc(CACHE_CPU_PROGRAMS[1].source, 2000);
    console.log(`pingpong: ${r.cycles} cycles, ${r.steps} instructions, ${r.hits} load hits, ${r.misses} misses`);
    expect(r.hits).toBe(0);
  }, 300000);
});
