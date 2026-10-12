// Slow mode: an edge played one gate delay at a time must land exactly where a whole cycle
// does, and the trace must describe what each instruction did.

import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { PROGRAMS } from '../src/riscv/programs';
import { fmtRate, ratePos, rateScale, stepEffect } from '../src/riscv/trace';
import { completeEdge, riseEdge, stepEdge } from '../src/sim/edge';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { analyzeTiming } from '../src/sim/timing';

const sum = assemble(PROGRAMS.find((p) => p.id === 'sum')!.source).words;

function cpu(): GateSim {
  const sim = new GateSim(flatten(singleCycleCpu(sum)));
  sim.setInput('clk', 0);
  sim.settle();
  return sim;
}

describe('slow-mode clock edge', () => {
  it('stepping one gate delay at a time matches a whole cycle and the golden model', () => {
    const slow = cpu(), fast = cpu();
    const iss = new ISS(sum);
    let longest = 0, moved = false;
    for (let c = 0; c < 40 && !iss.halted; c++) {
      const before = cpuState(slow).x;
      const e = riseEdge(slow, 'clk');
      let steps = 0;
      while (stepEdge(slow, e)) {
        steps++;
        // the time advances by exactly one gate delay per step
        expect(slow.time - e.start).toBe(steps);
        if (cpuState(slow).x.some((v, i) => v !== before[i])) moved = true;
      }
      longest = Math.max(longest, steps);
      slow.setInput('clk', 0);
      slow.settle();
      clockCycle(fast);
      iss.step();
      expect(cpuState(slow), `cycle ${c}`).toEqual(cpuState(fast));
      expect(cpuState(slow).x).toEqual([...iss.x]);
      expect(cpuState(slow).pc).toBe(iss.pc);
    }
    expect(iss.halted).toBe(true);
    expect(moved).toBe(true);
    expect(longest).toBeGreaterThan(20);
  }, 60000);

  it('with a fixed period the high phase ends on time', () => {
    const P = analyzeTiming(flatten(singleCycleCpu(sum)))!.period + 4;
    const sim = cpu();
    const iss = new ISS(sum);
    let E = sim.time;
    for (let c = 0; c < 40 && !iss.halted; c++) {
      sim.runUntil(E);
      const e = riseEdge(sim, 'clk', E + Math.ceil(P / 2));
      let steps = 0;
      while (stepEdge(sim, e)) steps++;
      expect(sim.time).toBe(E + Math.ceil(P / 2));
      expect(steps).toBe(Math.ceil(P / 2) - 1);
      sim.setInput('clk', 0);
      sim.runUntil(E + P);
      E += P;
      iss.step();
      expect(cpuState(sim).x, `cycle ${c}`).toEqual([...iss.x]);
    }
    expect(iss.halted).toBe(true);
  }, 60000);

  it('completeEdge finishes an edge midway', () => {
    const slow = cpu(), fast = cpu();
    for (let c = 0; c < 6; c++) {
      const e = riseEdge(slow, 'clk');
      for (let i = 0; i < 5; i++) stepEdge(slow, e);
      completeEdge(slow, e);
      slow.setInput('clk', 0);
      slow.settle();
      clockCycle(fast);
      expect(cpuState(slow)).toEqual(cpuState(fast));
    }
  }, 60000);
});

describe('trace entries', () => {
  const run = (src: string, n: number, opts = {}) => {
    const iss = new ISS(assemble(src).words, opts);
    const out: string[] = [];
    for (let i = 0; i < n; i++) out.push(stepEffect(iss.step()));
    return out;
  };

  it('register writes, stores, no-ops and halt', () => {
    expect(run('li a0, 42\nsw a0, 16(zero)\nbeq zero, a0, skip\nskip: lw t0, 16(zero)\nhalt: j halt', 5)).toEqual([
      'a0 ← 0x0000002a (42)',
      '[0x10] ← 0x0000002a',
      '—',
      't0 ← 0x0000002a (42)',
      'halt',
    ]);
    expect(run('addi a1, zero, -1', 1)).toEqual(['a1 ← 0xffffffff (-1)']);
  });

  it('traps', () => {
    const [e] = run('ecall', 1, { system: true });
    expect(e).toMatch(/^trap: ecall \(mcause 0xb\)/);
  });
});

describe('speed slider', () => {
  it('log scale round-trips and is monotonic', () => {
    for (const [lo, hi] of [[0.25, 20], [2, 400]]) {
      expect(rateScale(0, lo, hi)).toBeCloseTo(lo);
      expect(rateScale(1, lo, hi)).toBeCloseTo(hi);
      let prev = 0;
      for (let p = 0; p <= 1; p += 0.05) {
        const r = rateScale(p, lo, hi);
        expect(r).toBeGreaterThan(prev);
        expect(ratePos(r, lo, hi)).toBeCloseTo(p);
        prev = r;
      }
    }
    expect(fmtRate(0.25)).toBe('0.25');
    expect(fmtRate(1.4999)).toBe('1.5');
    expect(fmtRate(123.4)).toBe('123');
  });
});
