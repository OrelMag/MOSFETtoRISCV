// The pipeline analogy figures (handoff, emptyplate, fork): every cycle count comes from widgets/analogy/pipe.ts and is
// pinned here against the site's own gate-level pipelinedCpu (the cycle each instruction is in W, flushes, forwarding).
import { describe, expect, it } from 'vitest';
import { pipelinedCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, pipeSnap, type PipeSnap } from '../src/riscv/cosim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { BRANCH_STAGE, FLUSH_PENALTY, eLag, fork, schedule, type Op } from '../src/widgets/analogy/pipe';

const TAIL = '\nnop\nnop\nnop\nnop\nnop\nnop';

/** One snapshot per cycle from power-on on the gate-level pipeline. */
function trace(src: string, cycles: number, opts: { predictor?: boolean } = {}): PipeSnap[] {
  const design = flatten(pipelinedCpu(assemble(src + TAIL).words, opts));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const out: PipeSnap[] = [];
  for (let c = 0; c < cycles; c++) {
    out.push(pipeSnap(sim, design.root, c)!);
    clockCycle(sim);
  }
  return out;
}
/** The cycle the instruction at word index `i` is in W (its first time there). */
const wCycle = (t: PipeSnap[], i: number): number => t.findIndex((s) => s.slots[4].valid && s.slots[4].pc === i * 4);

describe('handoff: forwarding', () => {
  const pair = (fwd: boolean) => schedule([{ name: '1', kind: 'alu' }, { name: '2', kind: 'alu', dep: 1 }], fwd);
  const t = trace('addi t0, x0, 5\nadd t1, t0, t0', 12);

  it('with forwarding a dependent ALU pair loses nothing: the model equals the gate-level W cycles, and E takes the value from M', () => {
    const m = pair(true);
    expect(m.stalls).toBe(0);
    expect(m.cycles).toBe(6);
    expect(m.wCycle).toEqual([wCycle(t, 0), wCycle(t, 1)]);
    expect(t.some((s) => s.stall)).toBe(false);
    // the reader is in E one cycle behind the producer, with a forwarding select on
    const e = t.findIndex((s) => s.slots[2].pc === 4 && s.slots[2].valid);
    expect(t[e].fwdA).toBe(2);
    expect(m.hands[0]).toEqual({ from: { stage: 3, cycle: e }, to: { stage: 2, cycle: e } });
  });

  it('without forwarding the reader trails by 3: 2 cycles lost, as the gate-level pipeline needs a producer-reader distance of 3', () => {
    expect(eLag('alu', false)).toBe(3);
    const m = pair(false);
    expect(m.stalls).toBe(2);
    expect(m.cycles).toBe(8);
    // distance 3 (two nops between) uses no forwarding at all on the gate-level pipeline: the register file's W → D bypass
    const far = trace('addi t0, x0, 5\nnop\nnop\nadd t1, t0, t0', 14);
    expect(wCycle(far, 3)).toBe(m.wCycle[1]);
    const e = far.findIndex((s) => s.slots[2].pc === 12 && s.slots[2].valid);
    expect(far[e].fwdA).toBe(0);
    expect(far[e].fwdB).toBe(0);
    expect(far.some((s) => s.byp)).toBe(true);
    // distance 2 needs forwarding (from W): one stall without it
    const two = trace('addi t0, x0, 5\nnop\nadd t1, t0, t0', 14);
    const e2 = two.findIndex((s) => s.slots[2].pc === 8 && s.slots[2].valid);
    expect(two[e2].fwdA).toBe(1);
    expect(schedule([{ name: 'p', kind: 'alu' }, { name: 'n', kind: 'other' }, { name: 'r', kind: 'alu', dep: 2 }], false).stalls).toBe(1);
  }, 60000);
});

describe('emptyplate: the load-use stall', () => {
  const ops = (dep: number): Op[] => [{ name: 'lw', kind: 'load' }, { name: 'add', kind: 'alu', dep }, { name: 'or', kind: 'alu' }];
  const src = (dependent: boolean) => `addi a0, x0, 3\nsw a0, 0(x0)\nlw t0, 0(x0)\nadd t1, ${dependent ? 't0' : 'a0'}, a0\nor t2, a0, a0`;

  it('a dependent instruction right behind a load costs exactly one bubble with forwarding, as on the gate-level pipeline', () => {
    expect(eLag('load', true)).toBe(2);
    const m = schedule(ops(1), true);
    const t = trace(src(true), 14);
    expect(m.stalls).toBe(1);
    expect(t.filter((s) => s.stall).length).toBe(1);
    expect(m.wCycle).toEqual([2, 3, 4].map((i) => wCycle(t, i) - 2)); // two setup instructions come first
    // a bubble goes down E, M, W behind the load
    expect(m.bubbles.map((b) => b.stage)).toEqual([2, 3, 4]);
    const e = t.findIndex((s) => s.slots[2].pc === 12 && s.slots[2].valid);
    expect(t[e].fwdA).toBe(1); // from W
    expect(m.hands[0].from.stage).toBe(4);
  }, 60000);

  it('an independent instruction after the load costs nothing', () => {
    const m = schedule(ops(0), true);
    const t = trace(src(false), 14);
    expect(m.stalls).toBe(0);
    expect(m.bubbles).toEqual([]);
    expect(t.some((s) => s.stall)).toBe(false);
    expect(m.wCycle).toEqual([2, 3, 4].map((i) => wCycle(t, i) - 2)); // two setup instructions come first
  }, 60000);

  it('an ALU result needs no bubble even right behind it; a load followed by one unrelated instruction needs none either', () => {
    expect(schedule([{ name: 'a', kind: 'alu' }, { name: 'b', kind: 'alu', dep: 1 }], true).stalls).toBe(0);
    expect(schedule([{ name: 'l', kind: 'load' }, { name: 'x', kind: 'other' }, { name: 'b', kind: 'alu', dep: 2 }], true).stalls).toBe(0);
  });
});

describe('fork: control hazards', () => {
  const taken = trace('addi t0, x0, 1\nbeq t0, t0, L\nnop\nnop\nL: addi t1, x0, 2\naddi t2, x0, 3\naddi t3, x0, 4', 16);
  const fall = trace('addi t0, x0, 1\nbne t0, t0, L\naddi t1, x0, 2\naddi t2, x0, 3\naddi t3, x0, 4\nL: nop', 16);

  it('guess not taken, actually taken: the branch resolves in E and costs FLUSH_PENALTY = 2, equal to the gate-level pipeline', () => {
    expect(BRANCH_STAGE).toBe(2);
    expect(FLUSH_PENALTY).toBe(2);
    const f = fork(false, true);
    expect(f.lost).toBe(2);
    // the branch is word 1, x y z words 4 5 6; the addi before the branch shifts the gate-level run by one cycle
    expect([1, 4, 5, 6].map((i) => wCycle(taken, i))).toEqual(f.wCycle.filter((c) => c >= 0).map((c) => c + 1));
    expect(taken.filter((s) => s.flush).length).toBe(1);
    // the same instructions with the guess right (fall-through) would reach W 2 cycles earlier
    expect(wCycle(taken, 4) - wCycle(taken, 1)).toBe(1 + FLUSH_PENALTY);
  });

  it('guess not taken, actually not taken: no loss', () => {
    const f = fork(false, false);
    expect(f.lost).toBe(0);
    expect(fall.some((s) => s.flush)).toBe(false);
    expect([1, 2, 3, 4].map((i) => wCycle(fall, i))).toEqual(f.wCycle.map((c) => c + 1));
  });

  it('guess taken: right costs nothing, wrong costs the same 2 (a trained predictor on a loop, flushed on the exit)', () => {
    expect(fork(true, true).lost).toBe(0);
    expect(fork(true, false).lost).toBe(2);
    expect(fork(true, false).cycles).toBe(fork(false, true).cycles);
    const t = trace('addi t0, x0, 4\nL: addi t0, t0, -1\nbne t0, x0, L\nnop\nnop', 30, { predictor: true });
    const flushes = t.map((s, c) => (s.flush ? c : -1)).filter((c) => c >= 0);
    // the first (cold) taken branch and the exit: the three laps between are guessed right and flush nothing
    expect(flushes.length).toBe(2);
    expect(t[flushes[1] + 1].slots[0].pc).toBe(12); // after the exit flush fetch continues behind the loop
    // lap cost: 2 instructions per lap, 2 cycles, no bubble, between the two flushes
    expect(flushes[1] - flushes[0]).toBe(8);
  });

  it('the figure draws the guessed road as ghosts only on a wrong guess', () => {
    for (const g of [false, true]) for (const a of [false, true]) {
      const f = fork(g, a);
      expect(f.rows.filter((r) => r.ghost).length).toBe(g === a ? 0 : 2);
      expect(f.cells.filter((c) => c.ghost).length).toBe(g === a ? 0 : 3);
    }
  });
});
