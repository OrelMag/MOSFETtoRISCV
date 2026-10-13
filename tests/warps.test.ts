import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { WARP_PROGRAMS } from '../src/riscv/warpprograms';
import { WarpISS } from '../src/riscv/warps';

/** Run to the end, choosing the next warp with `pick` among the runnable ones. */
function run(src: string, W: number, n: number, pick: (ready: number[], k: number) => number, data?: number[]): WarpISS {
  const a = assemble(src);
  expect(a.errors).toEqual([]);
  const m = new WarpISS(a.words, { warps: W, lanes: n, dmemWords: 128, data });
  for (let k = 0; k < 20000 && !m.halted; k++) {
    const ready = Array.from({ length: W }, (_, w) => w).filter((w) => m.runnable(w));
    m.step(pick(ready, k));
  }
  expect(m.halted).toBe(true);
  return m;
}

describe('warp golden model', () => {
  for (const p of WARP_PROGRAMS) {
    for (const [W, n] of [[1, 4], [2, 4], [4, 4], [4, 2], [2, 8]]) {
      it(`${p.id}: ${W} warps × ${n} lanes, the same memory whatever the order`, () => {
        const rr = run(p.source(n), W, n, (r, k) => r[k % r.length], p.data());
        const last = run(p.source(n), W, n, (r) => r[r.length - 1], p.data());
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
