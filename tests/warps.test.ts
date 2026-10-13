import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { WARP_PROGRAMS, WARP_SMEM_K } from '../src/riscv/warpprograms';
import { WarpISS } from '../src/riscv/warps';

/** Run to the end, choosing the next warp with `pick` among the runnable ones. */
function run(src: string, W: number, n: number, pick: (ready: number[], k: number) => number, data?: number[], lsu = false): WarpISS {
  const a = assemble(src);
  expect(a.errors).toEqual([]);
  const m = new WarpISS(a.words, { warps: W, lanes: n, dmemWords: 128, data, smemWords: lsu ? 2 ** WARP_SMEM_K : 0, mul: true });
  for (let k = 0; k < 20000 && !m.halted; k++) {
    const ready = Array.from({ length: W }, (_, w) => w).filter((w) => m.runnable(w));
    m.step(pick(ready, k));
  }
  expect(m.halted).toBe(true);
  return m;
}

describe('warp golden model', () => {
  for (const p of WARP_PROGRAMS) {
    for (const [W, n] of [[1, 4], [2, 4], [4, 4], [4, 2], [2, 8], [8, 2]].filter(([W, n]) => !p.threads || W * n === p.threads)) {
      it(`${p.id}: ${W} warps × ${n} lanes, the same memory whatever the order`, () => {
        const rr = run(p.source(n), W, n, (r, k) => r[k % r.length], p.data(), p.lsu);
        const last = run(p.source(n), W, n, (r) => r[r.length - 1], p.data(), p.lsu);
        for (const [i, v] of p.expect()) expect(rr.dmem[i], `word ${i}`).toBe(v >>> 0);
        expect([...last.dmem]).toEqual([...rr.dmem]);
        expect(rr.active.every(Boolean)).toBe(true);
      });
    }
  }

  it('tid and nwarps per warp; a warp never started cannot issue', () => {
    const a = assemble('csrr a0, tid\ncsrr a1, nwarps\ncsrr a2, warp\nend: j end');
    const m = new WarpISS(a.words, { warps: 2, lanes: 4 });
    expect(m.runnable(1)).toBe(false);
    expect(() => m.step(1)).toThrow(/never started/);
    for (let k = 0; k < 3; k++) m.step(0);
    expect(m.warps[0].lanes.map((l) => [l.x[10], l.x[11], l.x[12]])).toEqual([[0, 2, 0], [1, 2, 0], [2, 2, 0], [3, 2, 0]]);
  });

  it('wspawn starts warps 1 … rs1 − 1 at rs2 with every lane active', () => {
    const a = assemble('li t0, 3\nla t1, go\nwspawn t0, t1\nend: j end\ngo: csrr a0, tid\nj go');
    const m = new WarpISS(a.words, { warps: 4, lanes: 4 });
    for (let k = 0; k < 4; k++) m.step(0); // li, la (two words), wspawn
    expect(m.active).toEqual([true, true, true, false]);
    expect(m.warps[1].pc).toBe(20);
    m.step(2);
    expect(m.warps[2].lanes.map((l) => l.x[10])).toEqual([8, 9, 10, 11]);
  });
});

describe('warp golden model: shared memory, bar, mul', () => {
  const asm = (...lines: string[]) => assemble(lines.join('\n')).words;

  it('bar holds each warp until rs2 have arrived; the last arrival goes on', () => {
    const m = new WarpISS(asm('li t0, 3', 'la t1, go', 'wspawn t0, t1', 'go: li a0, 3', 'bar x0, a0', 'csrr a1, warp', 'end: j end'), { warps: 4, lanes: 2 });
    for (let k = 0; k < 4; k++) m.step(0); // li, la (two words), wspawn
    m.step(1); m.step(1); // li, bar: waits
    expect([m.runnable(1), m.waiting[1]]).toEqual([false, true]);
    expect(() => m.step(1)).toThrow(/waits at the barrier/);
    m.step(0); m.step(0); // li, bar: two arrived
    expect(m.waiting).toEqual([true, true, false, false]);
    m.step(2); m.step(2); // the third: all go
    expect(m.waiting).toEqual([false, false, false, false]);
    expect([0, 1, 2].every((w) => m.runnable(w))).toBe(true);
  });

  it('a barrier counting more warps than run deadlocks; two ids at once is an error', () => {
    const m = new WarpISS(asm('li a0, 2', 'bar x0, a0', 'end: j end'), { warps: 2, lanes: 2 });
    m.step(0); m.step(0);
    expect([m.halted, m.deadlocked]).toEqual([false, true]);
    const m2 = new WarpISS(asm('li t0, 2', 'la t1, go', 'wspawn t0, t1', 'li a0, 3', 'li a1, 0', 'bar a1, a0', 'end: j end', 'go: li a0, 3', 'li a1, 1', 'bar a1, a0', 'j go'), { warps: 2, lanes: 2 });
    for (let k = 0; k < 7; k++) m2.step(0);
    m2.step(1); m2.step(1);
    expect(() => m2.step(1)).toThrow(/one barrier/);
  });

  it('shared memory at 0x1000 (words only, wrapping at its size); mul only when the lanes multiply', () => {
    const m = new WarpISS(asm('li s0, 0x1000', 'csrr t0, tid', 'slli t1, t0, 2', 'add t1, t1, s0', 'sw t0, 0(t1)', 'lw a0, 256(t1)', 'sw t0, 0(t1)', 'mul a1, t0, t0', 'end: j end'),
      { warps: 1, lanes: 4, smemWords: 64, mul: true });
    for (let k = 0; k < 9; k++) m.step(0);
    expect([...m.smem.slice(0, 4)]).toEqual([0, 1, 2, 3]);
    expect([...m.dmem.slice(0, 4)]).toEqual([0, 0, 0, 0]);
    expect(m.warps[0].lanes.map((l) => l.x[11])).toEqual([0, 1, 4, 9]);
    const noMul = new WarpISS(asm('mul a0, a0, a0'), { warps: 1, lanes: 2 });
    expect(() => noMul.step(0)).toThrow(/no multiplier/);
    const div = new WarpISS(asm('div a0, a0, a0'), { warps: 1, lanes: 2, mul: true });
    expect(() => div.step(0)).toThrow(/do not divide/);
  });
});
