// The out-of-order model (riscv/ooomodel.ts) against its own rules, every cycle: capacities, one pick and one result
// per port per cycle, operands ready at issue, loads after older stores, in-order commit of exactly the golden
// model's instructions. On the benchmark set and on random RV32IM programs, at several shapes.

import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { criticalPath, dataflow, traceOf } from '../src/riscv/ilp';
import { OooModel, OOO_CORE, type OooConfig, type Uop } from '../src/riscv/ooomodel';
import { randomProgram32 } from '../src/riscv/randprog32';

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(2, n)));

function check(words: number[], cfg: Partial<OooConfig>, dmemWords: number): { cycles: number; instructions: number } {
  const opts = { dmemWords, imemWords: pow2(words.length) };
  const trace = traceOf(words, opts);
  const m = new OooModel(words, cfg, opts);
  const c = m.cfg;
  const all: Uop[] = [];
  const committed: number[] = [];
  while (!m.halted && m.cycle < 200_000) {
    const t = m.cycle;
    const info = m.step();
    all.push(...info.fetched);
    expect(m.robList.length).toBeLessThanOrEqual(c.rob);
    expect(m.iqList().length).toBeLessThanOrEqual(c.iq);
    expect(m.robList.filter((u) => u.cls === 'store').length).toBeLessThanOrEqual(c.sq);
    expect(info.committed.length).toBeLessThanOrEqual(c.width);
    expect(info.committed.filter((u) => u.cls === 'store').length).toBeLessThanOrEqual(1);
    for (const u of info.committed) {
      expect(u.wrong).toBe(false);
      expect(u.x).toBeLessThan(t);
      committed.push(u.pc);
    }
    const ports = info.issued.map((u) => u.port);
    expect(new Set(ports).size).toBe(ports.length);
    for (const u of info.issued) {
      expect(u.d).toBeLessThan(t);
      for (const p of u.deps) { expect(p.x).toBeGreaterThanOrEqual(0); expect(p.x).toBeLessThanOrEqual(t); }
      if (u.cls === 'load') for (const o of m.robList) if (o.cls === 'store' && o.seq < u.seq) expect(o.x, `${u.text} after ${o.text}`).toBeLessThan(t);
    }
  }
  expect(m.halted).toBe(true);
  expect(committed).toEqual(trace.map((e) => e.pc));
  // One result per port per cycle (results of flushed instructions count only if they came before the flush).
  const bus = new Set<string>();
  for (const u of all) {
    if (u.port < 0 || u.x < 0 || (u.state === 'flushed' && u.x > u.c)) continue;
    const k = `${u.port}:${u.x}`;
    expect(bus.has(k), `two results on port ${u.port} at cycle ${u.x}`).toBe(false);
    bus.add(k);
  }
  return { cycles: m.stats.cycles, instructions: m.stats.instructions };
}

const SHAPES: [string, Partial<OooConfig>][] = [
  ['core', {}],
  ['1-wide', { width: 1 }],
  ['2-wide in order', { inorder: true }],
  ['btb only, resolve', { predict: 'btb', recover: 'resolve' }],
  ['perfect, long latencies', { predict: 'perfect', lat: { alu: 1, load: 4, mul: 4, div: 7 } }],
  ['4-wide, big window', { width: 4, rob: 32, iq: 16, sq: 8 }],
  ['tiny', { rob: 4, iq: 2, sq: 1, btb: 4, ras: 1 }],
];

describe('out-of-order model', () => {
  for (const b of BENCHMARKS.filter((x) => !x.needs?.f)) {
    it(`${b.id}: every rule, every cycle, at every shape`, () => {
      const words = assemble(b.source).words;
      for (const [, cfg] of SHAPES) check(words, cfg, 64);
    });
  }

  it('random RV32IM programs (bytes, halfwords, divides)', () => {
    for (let seed = 1; seed <= 24; seed++) {
      const asm = assemble(randomProgram32(seed, { n: 60, sub: true, m: true, dmemWords: 32 }));
      expect(asm.errors).toEqual([]);
      for (const [, cfg] of SHAPES) check(asm.words, cfg, 32);
    }
  });

  it('the core overlaps work: two wide beats one, out of order beats in order, prediction pays', () => {
    const words = assemble(BENCHMARKS.find((b) => b.id === 'matmul-m')!.source).words;
    const run = (cfg: Partial<OooConfig>) => check(words, cfg, 64).cycles;
    const core = run({});
    expect(core).toBeLessThan(run({ width: 1 }));
    expect(core).toBeLessThan(run({ inorder: true }));
    expect(run({ predict: 'perfect' })).toBeLessThan(core);
    expect(OOO_CORE.width).toBe(2);
  });

  it('dataflow: the critical path is a chain of dependences whose length is the bound', () => {
    const words = assemble(BENCHMARKS.find((b) => b.id === 'crc')!.source).words;
    const tr = traceOf(words, { dmemWords: 64, imemWords: 128 });
    const df = dataflow(tr);
    const path = criticalPath(df);
    expect(df.ready[path[path.length - 1]]).toBe(df.path);
    for (let k = 1; k < path.length; k++) {
      const a = tr[path[k - 1]], b = tr[path[k]];
      expect(b.srcs.includes(a.rd) || (a.cls === 'store' && b.cls === 'load')).toBe(true);
    }
    expect(df.ipc).toBeGreaterThan(1);
  });
});
