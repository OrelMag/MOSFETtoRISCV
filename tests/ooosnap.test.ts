// The out-of-order core's state read from its gates (riscv/ooosnap.ts) equals the model's every cycle: the fetch
// register, the reorder buffer, the issue queue (with the tags each operand waits for), the rename table and the
// store queue. The Out of order panel shows the snapshot, so what it shows is what the hardware holds.

import { describe, expect, it } from 'vitest';
import { DUAL_SOURCE } from '../src/chapters/ch-ooo';
import { oooCpu } from '../src/lib/ooocore';
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { clockCycle } from '../src/riscv/cosim';
import { OooModel } from '../src/riscv/ooomodel';
import { isOooCore, oooSnap, type OooSnap } from '../src/riscv/ooosnap';
import { randomProgram32 } from '../src/riscv/randprog32';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

/** The model's state after cycle t, in the snapshot's shape; wrong: the reorder-buffer tags on a wrong path. */
function modelSnap(m: OooModel): OooSnap & { wrong: Set<number> } {
  const t = m.cycle - 1, done = (x: number) => x >= 0 && x <= t;
  return {
    fetched: m.fd.map((u) => ({ pc: u.pc, word: u.word })),
    rob: m.robList.map((u) => ({ tag: u.rob, pc: u.pc, rd: u.rd, store: u.cls === 'store', done: done(u.x), mis: done(u.x) && u.mispredict, value: 0 })),
    iq: m.iqList().map((u, k) => {
      const wait = (r: number | undefined) => {
        const p = r === undefined ? undefined : u.deps.find((d) => d.rd === r);
        return p && !done(p.x) ? p.rob : null;
      };
      return { slot: k, tag: u.rob, pc: u.pc, port: u.port, waitA: wait(u.srcs[0]), waitB: wait(u.srcs[1]), ready: false, load: u.cls === 'load' };
    }),
    rat: [...m.rat()].map(([r, u]) => [r, u.rob] as [number, number]).sort((a, b) => a[0] - b[0]),
    sq: m.robList.filter((u) => u.cls === 'store').map((u) => ({ tag: u.rob, executed: done(u.x), addr: 0, data: 0 })),
    wrong: new Set(m.robList.filter((u) => u.wrong).map((u) => u.rob)),
  };
}

/**
 * What both sides define the same way: the slots, values and addresses are the hardware's own, a word past the
 * program its ROM's, and a wrong-path entry's mispredict bit means nothing (it never commits).
 */
const comparable = (s: OooSnap, wrong: Set<number>) => ({
  fetched: s.fetched.map((f) => f.pc),
  rob: s.rob.map(({ value: _, ...r }) => ({ ...r, mis: r.mis && !wrong.has(r.tag) })),
  iq: s.iq.map(({ tag, pc, port, load, waitA, waitB }) => ({ tag, pc, port, load, waits: [waitA, waitB].filter((w) => w !== null).sort() })),
  rat: s.rat,
  sq: s.sq.map(({ addr: _a, data: _d, ...r }) => r),
});

function check(source: string, { imemK = 6, dmemK = 6, max = 4000 } = {}): number {
  const words = assemble(source).words;
  const design = flatten(oooCpu(words, { imemK, dmemK }));
  expect(isOooCore(design.root)).toBe(true);
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const model = new OooModel(words, {}, { imemWords: 2 ** imemK, dmemWords: 2 ** dmemK });
  let cycles = 0;
  while (!model.halted && cycles < max) {
    model.step();
    clockCycle(sim);
    cycles++;
    if (model.halted) break;
    const want = modelSnap(model);
    expect(comparable(oooSnap(sim, design.root), want.wrong), `after cycle ${cycles - 1}`).toEqual(comparable(want, want.wrong));
  }
  expect(model.halted).toBe(true);
  return cycles;
}

describe('the out-of-order core read from its gates equals the model', () => {
  it('chapter 24\'s dot product', () => { check(DUAL_SOURCE); }, 600_000);
  it('fib (calls, returns, mispredictions)', () => { check(BENCHMARKS.find((b) => b.id === 'fib')!.source, { imemK: 7, dmemK: 7, max: 8000 }); }, 600_000);
  it('random programs (divides, loads behind stores, flushes)', () => {
    for (const seed of [3, 7, 11]) check(randomProgram32(seed, { m: true, dmemWords: 32 }), { imemK: 7, dmemK: 5 });
  }, 600_000);
});
