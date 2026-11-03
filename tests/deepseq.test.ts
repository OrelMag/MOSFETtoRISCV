// Chapters 8, 11 and 12, the deeper steps: the circuits they add and the numbers their prose quotes.

import { describe, expect, it } from 'vitest';
import { DFF, DFF_EDGE6, latchFile, regfile, rfBypass, skewPair } from '../src/lib';
import { clkToQ, sweepEdge } from '../src/sim/edgetiming';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { simulate } from '../src/sim/harness';
import { stats } from '../src/sim/stats';
import { CLK_TO_Q, SETUP } from '../src/sim/timing';
import type { ComponentDef } from '../src/sim/types';

const rd = (s: ReturnType<typeof simulate>, n: string) => s.getBits(s.design.root.ports[n]).reduce((a: number, b, i) => a + (b << i), 0);

describe('edge-triggered flip-flop of six gates', () => {
  it('samples d at the rising edge, like the master-slave DFF, over a random sequence', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 1;
    const a = new GateSim(flatten(DFF_EDGE6, { mode: 'gate' })), b = new GateSim(flatten(DFF, { mode: 'gate' }));
    for (const s of [a, b]) { s.setInput('d', 0); s.setInput('clk', 0); s.reset('zero'); s.settle(); }
    let prev = 0;
    for (let i = 0; i < 200; i++) {
      const d = rnd();
      for (const s of [a, b]) { s.setInput('d', d); s.settle(); }
      for (const s of [a, b]) { s.setInput('clk', 1); s.settle(); }
      expect(a.getBits(a.design.root.ports.q)[0]).toBe(d);
      expect(b.getBits(b.design.root.ports.q)[0]).toBe(d);
      expect(a.getBits(a.design.root.ports.q_n)[0]).toBe(1 - d);
      // d moving while the clock is high changes nothing
      for (const s of [a, b]) { s.setInput('d', 1 - d); s.settle(); }
      expect(a.getBits(a.design.root.ports.q)[0]).toBe(d);
      for (const s of [a, b]) { s.setInput('clk', 0); s.settle(); }
      expect(a.getBits(a.design.root.ports.q)[0]).toBe(d);
      prev = d;
    }
    expect(prev).toBeGreaterThanOrEqual(0);
  });
  it('is 8 NANDs against the master-slave flip-flop\'s 11', () => {
    expect([stats(DFF_EDGE6).nands, stats(DFF).nands]).toEqual([8, 11]);
  });
});

describe('setup, hold and clock-to-q measured on the circuit', () => {
  const m = (def: ComponentDef) => ({ rise: sweepEdge(def, 'rise'), fall: sweepEdge(def, 'fall') });
  it('the master-slave DFF: setup 1 / 2, hold 1 / 0, clock-to-q 2 / 3 (rise / fall)', () => {
    const { rise, fall } = m(DFF);
    expect([rise.setup, fall.setup]).toEqual([1, 2]);
    expect([rise.hold, fall.hold]).toEqual([1, 0]);
    expect([rise.cqRise, rise.cqFall]).toEqual([2, 3]);
    // a change at the edge itself is the SR latch's race: the pair never decides
    expect(rise.outcome[rise.offsets.indexOf(0)]).toBe('x');
  });
  it('the static timing model\'s constants cover the measurement', () => {
    const { rise, fall } = m(DFF);
    expect(Math.max(rise.setup, fall.setup)).toBeLessThanOrEqual(SETUP);
    expect(Math.max(rise.cqRise, rise.cqFall)).toBe(CLK_TO_Q);
  });
  it('the six-gate flip-flop: setup -1 / 2, hold 3 / 0, clock-to-q 2 / 5', () => {
    const { rise, fall } = m(DFF_EDGE6);
    expect([rise.setup, fall.setup]).toEqual([-1, 2]);
    expect([rise.hold, fall.hold]).toEqual([3, 0]);
    expect([rise.cqRise, rise.cqFall]).toEqual([2, 5]);
    expect(clkToQ(DFF_EDGE6, 1)).toBe(2);
  });
});

describe('clock skew', () => {
  const shift = (k: number) => {
    const fd = flatten(skewPair(k), { mode: 'gate' });
    const s = new GateSim(fd);
    s.setInput('d', 0); s.setInput('clk', 0); s.reset('zero'); s.settle();
    s.setInput('d', 1); s.settle();
    s.setInput('clk', 1); s.settle();
    const q = (n: string) => s.getBits(fd.root.ports[n])[0];
    return { q1: q('q1'), q2: q('q2'), unstable: s.unstable };
  };
  it('no skew: one stage per edge; two buffers: the value races through both; one buffer: the hold window', () => {
    expect(shift(0)).toEqual({ q1: 1, q2: 0, unstable: false });
    expect(shift(1).unstable).toBe(true);
    expect(shift(2)).toEqual({ q1: 1, q2: 1, unstable: false });
  });
});

describe('register files', () => {
  it('rfBypass forwards a write to a read of the same register, never x0', () => {
    const s = simulate(rfBypass(3, 8));
    const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) s.setInput(k, v); s.settle(); };
    set({ wa: 5, wd: 0x42, we: 1, byp: 1, ra1: 5, ra2: 0, clk: 0 });
    expect([rd(s, 'rd1'), rd(s, 'rd2')]).toEqual([0x42, 0]);
    set({ byp: 0 });
    expect(rd(s, 'rd1')).toBe(0);
    set({ byp: 1, wa: 0, ra1: 0 });
    expect(rd(s, 'rd1')).toBe(0); // x0 is never forwarded
    set({ wa: 5, ra1: 5, we: 0 });
    expect(rd(s, 'rd1')).toBe(0); // no write, no forwarding
    set({ we: 1 }); set({ clk: 1 }); set({ clk: 0 }); set({ we: 0 });
    expect(rd(s, 'rd1')).toBe(0x42);
  });
  it('latchFile writes while clk is high, holds after it falls, reads the word being written', () => {
    const s = simulate(latchFile(3, 8));
    const set = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) s.setInput(k, v); s.settle(); };
    set({ wa: 5, wd: 0x42, we: 1, ra1: 5, ra2: 0, clk: 0 });
    expect(rd(s, 'rd1')).toBe(0);
    set({ clk: 1 });
    expect(rd(s, 'rd1')).toBe(0x42);
    set({ clk: 0 }); set({ wd: 0x11 });
    expect(rd(s, 'rd1')).toBe(0x42);
    set({ we: 0, wa: 0, wd: 0x33 }); set({ clk: 1 });
    expect(rd(s, 'rd1')).toBe(0x42);
  });
  it('costs: the latch file is cheaper per bit, the bypass costs a comparator and a mux per port', () => {
    const rf = stats(regfile(5, 32)).nands, lf = stats(latchFile(5, 32)).nands, by = stats(rfBypass(5, 32)).nands;
    expect([rf, lf, by]).toEqual([23141, 13283, 23483]);
    expect(stats(regfile(5, 32, false)).nands - rf).toBe(480);
  });
});
