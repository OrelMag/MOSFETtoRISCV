import { describe, expect, it } from 'vitest';
import { WB_MISS_CLEAN, WB_MISS_DIRTY, wbCache } from '../src/lib';
import { CacheModel } from '../src/sim/cachemodel';
import { simulate } from '../src/sim/harness';
import type { Sim } from '../src/sim/sim';
import { lcg, out, set, tick } from './util';

/** One CPU-style access: hold the request until stall drops; a store is written on the edge after. */
function access(s: Sim, addr: number, write: boolean, wd = 0): { rd: number; stalls: number; hit: number } {
  set(s, { addr, we: write ? 1 : 0, re: write ? 0 : 1, wd });
  const hit = out(s, 'hit');
  let stalls = 0;
  while (out(s, 'stall')) { tick(s); stalls++; expect(stalls).toBeLessThan(20); }
  const rd = out(s, 'rd');
  tick(s);
  set(s, { we: 0, re: 0 });
  return { rd, stalls, hit };
}

function run(ib: number, ways: 1 | 2, ops: { a: number; w: boolean; v: number }[]) {
  const k = 6, s = simulate(wbCache(k, ib, ways));
  set(s, { clk: 0, we: 0, re: 0, addr: 0, wd: 0 });
  // power-on: main memory and arrays start at 0 (reset 'zero'), every line invalid
  const model = new CacheModel({ size: 16 * 2 ** ib * ways, line: 16, ways, replacement: 'lru', write: 'wb' });
  const mem = new Array(2 ** k).fill(0);
  for (const { a, w, v } of ops) {
    const exp = model.access(a, w);
    const r = access(s, a, w, v);
    expect(r.hit, `hit at ${a}`).toBe(exp.hit ? 1 : 0);
    expect(r.stalls, `stall cycles at ${a}`).toBe(exp.hit ? 0 : exp.writeback ? WB_MISS_DIRTY : WB_MISS_CLEAN);
    if (w) mem[a / 4] = v;
    else expect(r.rd >>> 0, `load ${a}`).toBe(mem[a / 4] >>> 0);
  }
  return { model };
}

const trace = (n: number, seed: number) => {
  const r = lcg(seed);
  return Array.from({ length: n }, () => ({ a: 4 * r(64), w: r(3) === 0, v: r(2 ** 31) }));
};

describe('write-back cache', () => {
  it('direct-mapped: hits, clean and dirty misses match the model, data is coherent', () => {
    run(2, 1, [
      { a: 0x00, w: true, v: 11 },   // write-allocate miss (clean victim)
      { a: 0x04, w: false, v: 0 },   // hit in the same line
      { a: 0x40, w: false, v: 0 },   // same set, other tag: the dirty line goes back first
      { a: 0x00, w: false, v: 0 },   // and comes back with the stored value
      ...trace(60, 1),
    ]);
  }, 60000);
  it('2-way LRU: matches the model on random traces', () => {
    run(1, 2, trace(80, 2));
  }, 60000);
  it('2-way keeps two lines of one set that direct-mapped would thrash', () => {
    const pingpong = Array.from({ length: 10 }, (_, i) => ({ a: i % 2 ? 0x40 : 0x00, w: false, v: 0 }));
    const dm = run(2, 1, pingpong).model.stats, two = run(1, 2, pingpong).model.stats;
    expect([dm.misses, two.misses]).toEqual([10, 2]);
  });
});

import { singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retiring } from '../src/riscv/cosim';
import { CACHE_CPU_PROGRAMS } from '../src/riscv/cprograms';
import { ISS } from '../src/riscv/iss';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

/** Co-simulate the CPU with a data cache against the ISS; count misses and main-memory word writes. */
function cosim(id: string, dcache: true | 'wb' | 'wb2') {
  const asm = assemble(CACHE_CPU_PROGRAMS.find((p) => p.id === id)!.source);
  const design = flatten(singleCycleCpu(asm.words, { dmemK: 6, dcache }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words, { dmemWords: 64 });
  const dm = design.root.children!.get('dm')!, ram = dm.children!.get('ram')!;
  let c = 0, misses = 0, memWrites = 0, prevStall = false;
  for (; c < 4000 && !iss.halted; c++) {
    const r = retiring(sim);
    const stalled = sim.getBits(dm.ports.stall)[0] === 1;
    if (stalled && !prevStall) misses++;
    prevStall = stalled;
    if (sim.getBits(ram.ports.we)[0] === 1) memWrites++;
    if (r) iss.step();
    clockCycle(sim);
    const st = cpuState(sim);
    expect(st.pc, `${id} cycle ${c}`).toBe(iss.pc);
    expect(st.x, `${id} cycle ${c}`).toEqual([...iss.x]);
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem, `${id}: memory, cached dirty lines included`).toEqual([...iss.dmem]);
  return { cycles: c, misses, memWrites };
}

describe('single-cycle CPU with a write-back cache vs golden model', () => {
  it('in place: write-through sends every store to memory, write-back none', () => {
    const wt = cosim('inplace', true), wb = cosim('inplace', 'wb');
    expect(wt.memWrites).toBe(48);
    expect(wb.memWrites).toBe(0);
    expect(wb.misses).toBe(4);
  }, 300000);
  it('pingpong: two ways remove the conflict misses', () => {
    const wb = cosim('pingpong', 'wb'), wb2 = cosim('pingpong', 'wb2');
    expect(wb.misses).toBe(33);              // 32 loads + the final store (write-allocate)
    expect(wb2.misses).toBe(9);
    expect(wb2.cycles).toBeLessThan(wb.cycles / 2);
  }, 300000);
  it('reuse: write-allocate stores bring the lines in', () => {
    const wb = cosim('reuse', 'wb2');
    expect(wb.misses).toBeGreaterThan(0);
  }, 300000);
});

import { PROGRAMS } from '../src/riscv/programs';

/** Co-simulate with an instruction cache (and optionally a data cache); count fetch misses. */
function cosimI(source: string, dcache?: 'wb') {
  const asm = assemble(source);
  const design = flatten(singleCycleCpu(asm.words, { icache: true, ...(dcache ? { dmemK: 6, dcache } : {}) }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(asm.words, dcache ? { dmemWords: 64 } : {});
  const im = design.root.children!.get('imem')!;
  let c = 0, imiss = 0, prev = false;
  for (; c < 6000 && !iss.halted; c++) {
    const st = sim.getBits(im.ports.stall)[0] === 1;
    if (st && !prev) imiss++;
    prev = st;
    if (retiring(sim)) iss.step();
    clockCycle(sim);
    const s = cpuState(sim);
    expect(s.pc, `cycle ${c}`).toBe(iss.pc);
    expect(s.x, `cycle ${c}`).toEqual([...iss.x]);
  }
  expect(iss.halted).toBe(true);
  expect(cpuState(sim).dmem.slice(0, iss.dmem.length)).toEqual([...iss.dmem]);
  return { cycles: c, steps: iss.steps, imiss };
}

describe('single-cycle CPU with an instruction cache', () => {
  it('a loop that fits misses once per line, then always hits', () => {
    const asm = assemble(CACHE_CPU_PROGRAMS.find((p) => p.id === 'inplace')!.source);
    const r = cosimI(CACHE_CPU_PROGRAMS.find((p) => p.id === 'inplace')!.source);
    expect(r.imiss).toBe(Math.ceil(asm.words.length / 4));
    expect(r.cycles).toBe(r.steps + 8 * r.imiss);
  }, 300000);
  it('with the write-back data cache too: both stall, nothing is lost', () => {
    cosimI(CACHE_CPU_PROGRAMS.find((p) => p.id === 'pingpong')!.source, 'wb');
  }, 300000);
  it('runs a sample program', () => {
    cosimI(PROGRAMS[0].source);
  }, 300000);
});
