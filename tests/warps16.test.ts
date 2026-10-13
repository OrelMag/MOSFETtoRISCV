// The two-warp RV16 golden model (riscv/rv16/warps16.ts): turn-taking slots, tid per warp, the
// barrier (arrival, release, a warp that ended, a deadlock), and kernels that give the same memory
// under two issue orders.

import { describe, expect, it } from 'vitest';
import { PUZZLES } from '../src/campaign/puzzles';
import { assemble16 } from '../src/riscv/rv16/asm16';
import { Warps16 } from '../src/riscv/rv16/warps16';

const machine = (src: string, data?: Record<number, number>) => {
  const a = assemble16(src);
  expect(a.errors).toEqual([]);
  const d = new Map(a.data);
  for (const [k, v] of Object.entries(data ?? {})) d.set(Number(k), v);
  return new Warps16(a.words, { strictInit: true }, d);
};

/** Run with warp `first` issuing whenever it can, the others only when it cannot. */
function runAhead(m: Warps16, first: number, max = 10000): void {
  for (let k = 0; !m.halted && k < max; k++) {
    const order = [first, ...[...m.warps.keys()].filter((w) => w !== first)];
    const w = order.find((v) => m.runnable(v));
    if (w === undefined) break;
    m.stepWarp(w);
  }
}

describe('two warps taking turns', () => {
  it('each thread reads tid = warp · 4 + lane; warp 0 issues first and the slots alternate', () => {
    const m = machine('csrr a0, tid\nslli a1, a0, 2\nsw a1, 20(a0)\nhalt');
    const slots = Array.from({ length: 8 }, () => m.step());
    expect(slots.map((s) => s.warp)).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    expect(m.halted).toBe(true);
    expect(m.steps).toBe(8);
    expect(Array.from(m.dmem.slice(20, 28))).toEqual([0, 4, 8, 12, 16, 20, 24, 28]);
    expect(m.idle).toBe(0);
  });

  it('a finished warp wastes its slots: they count as cycles with every lane idle', () => {
    // warp 1 ends at once (tmc x0); warp 0 runs four more instructions, each in its own turn
    const m = machine(`        csrr t0, tid
        srli t0, t0, 2
        beqz t0, go
        tmc  x0
go:     addi a0, t0, 1
        addi a0, a0, 1
        addi a0, a0, 1
        halt
`);
    m.run();
    expect(m.warps[1].mask).toBe(0);
    expect(m.warps[0].lanes[0].x[3]).toBe(3);
    // warp 0: 7 instructions in slots 0, 2, …, 12; warp 1: 4 in slots 1, 3, 5, 7
    expect(m.steps).toBe(13);
    expect(m.activeLaneSteps).toBe(4 * (7 + 4)); // tmc x0 ran with four lanes; then nobody
    expect(m.idle).toBe(Math.round(100 * (1 - 44 / 52)));
  });
});

describe('the barrier', () => {
  // warp 0 writes 8 words, warp 1 reads four of them after the bar
  const SHARE = `        csrr t0, tid
        srli t1, t0, 2        # the warp
        bnez t1, reader
        slli a0, t0, 3
        sw   a0, 8(t0)        # warp 0: words 8 … 11
        addi a0, a0, 1
        sw   a0, 12(t0)       # and 12 … 15
        bar
        halt
reader: bar
        lw   a1, 4(t0)        # tid 4 … 7 read words 8 … 11
        sw   a1, 16(t0)       # into 20 … 23
        halt
`;

  it('a warp waits at bar until the other arrives; the last to arrive releases both', () => {
    for (const first of [0, 1]) {
      const m = machine(SHARE);
      runAhead(m, first);
      expect(m.error).toBeNull();
      expect(m.halted).toBe(true);
      expect(Array.from(m.dmem.slice(20, 24)), `warp ${first} ahead`).toEqual([0, 8, 16, 24]);
    }
    const m = machine(SHARE);
    const idle: string[] = [];
    while (!m.halted) {
      const s = m.step();
      if (s.idle) idle.push(`${s.warp}:${s.idle}`);
    }
    // warp 1 reaches bar long before warp 0: its turns go by waiting
    expect(idle.length).toBeGreaterThan(0);
    expect(idle.every((x) => x === '1:waiting' || x === '1:ended' || x === '0:ended')).toBe(true);
    expect(Array.from(m.dmem.slice(20, 24))).toEqual([0, 8, 16, 24]);
  });

  it('a warp that ended (tmc x0) does not hold the barrier', () => {
    const m = machine(`        csrr t0, tid
        srli t1, t0, 2
        beqz t1, w0
        tmc  x0
w0:     bar
        addi a0, t0, 9
        halt
`);
    m.run();
    expect(m.error).toBeNull();
    expect(m.warps[0].lanes[2].x[3]).toBe(11);
  });

  it('a warp that halts with lanes on, while the other waits at bar, is a deadlock', () => {
    const m = machine(`        csrr t0, tid
        srli t1, t0, 2
        beqz t1, w0
        halt
w0:     bar
        halt
`);
    m.run();
    expect(m.error).toMatch(/deadlock: warp 0 waits at bar for warp 1, which halted with lanes still on/);
    expect(m.halted).toBe(true);
  });

  it('a warp waiting at bar cannot be issued', () => {
    const m = machine('bar\nhalt');
    m.stepWarp(0);
    expect(m.waiting).toEqual([true, false]);
    expect(() => m.stepWarp(0)).toThrow(/waits at the barrier/);
    m.stepWarp(1);
    expect(m.waiting).toEqual([false, false]);
  });
});

describe('the histogram kernel under two issue orders', () => {
  it('gives the same memory whichever warp runs ahead, and the same as turn-taking', () => {
    const p = PUZZLES.p_hist;
    const a = assemble16(p.ref);
    for (const t of p.tests()) {
      const data = new Map(a.data);
      for (const [k, v] of Object.entries(t.mem ?? {})) data.set(Number(k), v);
      const runs = [-1, 0, 1].map((first) => {
        const m = new Warps16(a.words, {}, data);
        if (first < 0) m.run();
        else runAhead(m, first);
        expect(m.error).toBeNull();
        expect(m.halted).toBe(true);
        return Array.from(m.dmem.slice(0xe0, 0xf0));
      });
      expect(runs[1], t.name).toEqual(runs[0]);
      expect(runs[2], t.name).toEqual(runs[0]);
    }
  });
});
