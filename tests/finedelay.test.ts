// GateSim under load-dependent delay (docs/PLAN-FINEDELAY.md, stage 2): tenths of a unit, each NAND by its load. The unit
// model is pinned separately (gatesim-fingerprint.test.ts); here the loaded engine itself.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { rca } from '../src/lib/combinational';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { skewPair } from '../src/lib/seqdeep';
import { DFF_R, lfsr, shiftRegister } from '../src/lib/seqparts';
import { counter } from '../src/lib/sequential';
import { assemble } from '../src/riscv/asm';
import { leafDelays } from '../src/sim/delay';
import { logicDepth } from '../src/sim/stats';
import { DualSim } from '../src/sim/dualsim';
import { completeEdge, riseEdge, stepEdge } from '../src/sim/edge';
import { flatten } from '../src/sim/flatten';
import { GateSim, LOAD_TICKS } from '../src/sim/gatesim';
import { tick } from './yieldtick';

const PROGRAM = assemble(`
  addi x1, x0, 9
loop:
  add  x2, x2, x1
  sw   x2, 4(x0)
  lw   x3, 4(x0)
  xor  x4, x3, x1
  addi x1, x1, -1
  bne  x1, x0, loop
  j loop`).words;

const isTenth = (t: number) => Math.abs(t * 10 - Math.round(t * 10)) < 1e-9;

describe('GateSim under load-dependent delay', () => {
  it('times each NAND by its load: changes land on tenths, many off whole units, and the wheel holds the longest delay', () => {
    const d = flatten(singleCycleCpu(PROGRAM), { mode: 'gate' });
    const sim = new GateSim(d, { delay: 'load' });
    expect(sim.ticksPerUnit).toBe(LOAD_TICKS);
    const times: number[] = [];
    sim.onTrace = (_n, _v, t) => times.push(t);
    sim.watch(Array.from({ length: d.netCount }, (_, i) => i));
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    expect(times.length).toBeGreaterThan(1000);
    expect(times.every(isTenth)).toBe(true);
    expect(times.some((t) => !Number.isInteger(t))).toBe(true);
    expect(isTenth(sim.time)).toBe(true);
    expect(sim.ticks).toBe(Math.round(sim.time * LOAD_TICKS));
    // the delays it uses are leafDelays' rounded to ticks
    expect(Math.max(...leafDelays(d, 'load'))).toBeGreaterThan(6.3); // a memory's 18 and loaded NANDs: past the old 64-slot wheel
  });

  it('settles a ripple adder\'s worst carry no later than static timing under the same model says', () => {
    const def = rca(8), sim = new GateSim(flatten(def, { mode: 'gate' }), { delay: 'load' });
    sim.setInput('a', 0); sim.setInput('b', 0); sim.setInput('cin', 0); sim.settle();
    const t0 = sim.time;
    sim.setInput('a', 255); sim.setInput('b', 0); sim.setInput('cin', 1); sim.settle();
    const took = sim.time - t0, bound = logicDepth(def, 'load')!;
    expect(took).toBeGreaterThan(0);
    // each NAND rounds to a tick (≤ 0.05 unit off), so allow that per gate on the path
    expect(took).toBeLessThanOrEqual(bound + 0.05 * logicDepth(def, 'unit')! + 1e-9);
    expect(sim.get(sim.design.root.ports.s[7])).toBe(0);
  });

  it('runUntil and nextEventTime speak units: it stands on tenths and steps to the next change', () => {
    const sim = new GateSim(flatten(rca(8), { mode: 'gate' }), { delay: 'load' });
    sim.settle();
    const t0 = sim.time;
    sim.setInput('a', 255); sim.setInput('b', 1);
    const next = sim.nextEventTime()!;
    expect(next).toBeGreaterThan(t0);
    expect(isTenth(next)).toBe(true);
    sim.runUntil(t0 + 2.3);
    expect(sim.time).toBeCloseTo(t0 + 2.3, 9);
    sim.settle();
    expect(sim.nextEventTime()).toBeNull();
  });

  it('stepEdge goes from change to change and never past a fixed period\'s end', () => {
    const sim = new GateSim(flatten(singleCycleCpu(PROGRAM), { mode: 'gate' }), { delay: 'load' });
    for (const period of [null, 7.5]) {
      const e = riseEdge(sim, 'clk', period === null ? null : sim.time + period);
      let last = sim.time, steps = 0;
      while (stepEdge(sim, e)) {
        expect(sim.time).toBeGreaterThan(last);
        expect(isTenth(sim.time)).toBe(true);
        if (e.end !== null) expect(sim.time).toBeLessThanOrEqual(e.end + 1e-9);
        last = sim.time;
        steps++;
      }
      expect(steps).toBeGreaterThan(3);
      completeEdge(sim, e);
      sim.setInput('clk', 0); sim.settle();
    }
  });

  it('saves and restores mid-propagation: the same changes at the same times afterwards', () => {
    const d = flatten(rca(8), { mode: 'gate' });
    const sim = new GateSim(d, { delay: 'load' });
    sim.settle();
    sim.setInput('a', 255); sim.setInput('b', 1);
    sim.runUntil(sim.time + 3.4);
    const saved = sim.saveState();
    const run = () => {
      const seen: string[] = [];
      sim.onTrace = (n, v, t) => seen.push(`${n}:${v}@${t.toFixed(1)}`);
      sim.watch(Array.from({ length: d.netCount }, (_, i) => i));
      sim.settle();
      return seen;
    };
    const first = run();
    sim.restoreState(saved);
    expect(run()).toEqual(first);
    expect(first.length).toBeGreaterThan(5);
  });
});

describe('load-dependent delay against the cycle engine', () => {
  // a CPU clocked straight from its pin: settled state equal every cycle, whatever the gate delays
  for (const [name, make] of [['single-cycle', () => singleCycleCpu(PROGRAM)], ['pipelined', () => pipelinedCpu(PROGRAM)]] as const) {
    it(`${name} RV32I: every net equal after every cycle, GateSim under load against the cycle engine`, async () => {
      const d = flatten(make(), { mode: 'gate' });
      const loaded = new GateSim(d, { delay: 'load' });
      const fast = new DualSim(d);
      fast.preferFast = true;
      fast.prepare();
      for (let c = 0; c < 120; c++) {
        for (const v of [1, 0]) { loaded.setInput('clk', v); loaded.settle(); fast.setInput('clk', v); fast.settle(); }
        if (c > 8) expect(fast.engine, fast.whyNot).toBe('cycle');
        for (let n = 0; n < d.netCount; n++) if (loaded.get(n) !== fast.get(n)) throw new Error(`cycle ${c}: net ${n} ${loaded.get(n)} ≠ ${fast.get(n)}`);
        if (c % 20 === 0) await tick();
      }
      expect(loaded.unstable).toBe(false);
    }, 120_000);
  }

  // flip-flop to flip-flop with no logic between (shift register, LFSR, counter): where a hold race would show if the loads
  // moved a flip-flop's internal timing off the cycle engine's unit-delay tables
  for (const [name, def] of [['8-bit counter', counter(8)], ['8-bit LFSR', lfsr(8)], ['4-bit shift register', shiftRegister(4)]] as const) {
    it(`${name}: every net equal after every edge, random inputs, under load against the cycle engine`, () => {
      const d = flatten(def, { mode: 'gate' });
      const loaded = new GateSim(d, { delay: 'load' }), fast = new DualSim(d);
      fast.preferFast = true;
      fast.prepare();
      const ins = def.ports.filter((p) => p.dir === 'in' && p.name !== 'clk');
      let x = 99;
      for (let c = 0; c < 400; c++) {
        for (const p of ins) {
          x = (Math.imul(x, 1103515245) + 12345) >>> 0;
          const v = (x >>> 7) & ((1 << p.width) - 1);
          for (const s of [loaded, fast]) s.setInput(p.name, v);
        }
        for (const v of [1, 0]) for (const s of [loaded, fast]) { s.setInput('clk', v); s.settle(); }
        if (c > 8) expect(fast.engine, fast.whyNot).toBe('cycle');
        for (let n = 0; n < d.netCount; n++) if (loaded.get(n) !== fast.get(n)) throw new Error(`${name}, edge ${c}: net ${n} ${loaded.get(n)} ≠ ${fast.get(n)}`);
      }
    });
  }

  it('a flip-flop with an asynchronous reset: equal every step of random d / rst_n / clk', () => {
    const d = flatten(DFF_R, { mode: 'gate' });
    const loaded = new GateSim(d, { delay: 'load' }), fast = new DualSim(d);
    fast.preferFast = true;
    fast.prepare();
    let x = 7;
    for (let i = 0; i < 400; i++) {
      x = (Math.imul(x, 1103515245) + 12345) >>> 0;
      const pin = ['d', 'rst_n', 'clk'][x % 3], v = (x >>> 8) & 1;
      for (const s of [loaded, fast]) { s.setInput(pin, v); s.settle(); }
      expect(loaded.get(d.root.ports.q[0]), `step ${i}`).toBe(fast.get(d.root.ports.q[0]));
    }
    expect(fast.engine).toBe('cycle');
  });

  it('a clock through buffers (the skew pair) is refused by the cycle engine under load for that reason, never under the unit model', () => {
    const d = flatten(skewPair(2), { mode: 'gate' });
    const loaded = new DualSim(d, { delay: 'load' }), unit = new DualSim(d);
    for (const s of [loaded, unit]) {
      s.preferFast = true;
      s.prepare();
      s.setInput('clk', 1); s.settle(); s.setInput('clk', 0); s.settle();
    }
    // under the unit model the engine is built (it may still decline a state for its own reasons, as here a glitch)
    expect(unit.whyNot).not.toMatch(/clock reaches storage/);
    expect(loaded.engine).toBe('gate');
    expect(loaded.whyNot).toMatch(/clock reaches storage through/);
  });
});
