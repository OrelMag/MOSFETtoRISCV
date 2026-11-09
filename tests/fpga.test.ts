// lib/fpga.ts: the look-up table is its truth table at every width, the logic cell adds and registers, the routing
// switch joins two wires only while its bit is 1, a LUT configured from lutMap's table computes the cone it replaces,
// and the parts draw without overlaps.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { lut, LUT4, ROUTE_SWITCH, SLICE } from '../src/lib/fpga';
import { resolveComponent } from '../src/lib/resolve';
import { evalOnce, simulate } from '../src/sim/harness';
import { lutMap } from '../src/sim/lutmap';
import { netlistOf, type ComponentDef } from '../src/sim/types';
import { B0, B1, BZ } from '../src/sim/types';
import { stats } from '../src/sim/stats';
import { labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

describe('look-up tables', () => {
  it('a LUT is its truth table, at 1 … 4 inputs exhaustively over a few tables', () => {
    for (const k of [1, 2, 3, 4]) {
      const d = lut(k), sim = simulate(d), N = 2 ** k;
      expect(lut(k)).toBe(d);
      for (const cfg of [0, 2 ** N - 1, 0b0110 % 2 ** N, 0xe8e8 % 2 ** N, 0x8001 % 2 ** N]) {
        for (let i = 0; i < N; i++) expect(evalOnce(sim, [i, cfg])[0], `lut${k} cfg ${cfg} i ${i}`).toBe(Math.floor(cfg / 2 ** i) % 2);
      }
    }
  });

  it('a LUT4 costs a 16:1 mux tree: 60 NANDs, the configuration bits are pins', () => {
    expect(stats(LUT4).nands).toBe(60);
  });

  it('configured from lutMap, a LUT4 computes the full adder\'s sum and carry', () => {
    const m = lutMap(resolveComponent('full_adder')!);
    const sim = simulate(LUT4);
    for (const l of m.luts) {
      // pad the table to four inputs: the unused inputs are don't-cares, so repeat it
      let cfg = 0;
      for (let a = 0; a < 16; a++) if ((l.table >> BigInt(a % 2 ** l.ins.length)) & 1n) cfg |= 1 << a;
      for (let a = 0; a < 2 ** l.ins.length; a++) expect(evalOnce(sim, [a, cfg])[0]).toBe(Number((l.table >> BigInt(a)) & 1n));
    }
  });
});

describe('the logic cell', () => {
  /** n cells in arithmetic mode chained by cout → cin: an adder, one cell per bit. */
  function addWith(a: number, b: number, n: number, cin: number): number {
    const sims = Array.from({ length: n }, () => simulate(SLICE));
    let c = cin, s = 0;
    for (let k = 0; k < n; k++) {
      // the LUT computes p = i0 ⊕ i1: config bit a is 1 where bits 0 and 1 of a differ
      const cfg = Array.from({ length: 16 }, (_, x) => ((x & 1) ^ ((x >> 1) & 1)) << x).reduce((u, v) => u | v, 0);
      const i = ((a >> k) & 1) | (((b >> k) & 1) << 1);
      const [y, cout] = evalOnce(sims[k], [i, cfg, c, 1, 0, 0]);
      s |= y << k;
      c = cout;
    }
    return s | (c << n);
  }

  it('chained in arithmetic mode, cells add: one cell per bit', () => {
    for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) for (const c of [0, 1]) expect(addWith(a, b, 4, c), `${a} + ${b} + ${c}`).toBe(a + b + c);
  });

  it('in logic mode the output is the LUT; registered, it is the LUT one clock edge later', () => {
    const sim = simulate(SLICE);
    sim.reset('zero');
    const AND = 0x8888; // y = i0 & i1 (i2, i3 ignored)
    const set = (i: number, reg: number) => { sim.setInput('i', i); sim.setInput('cfg', AND); sim.setInput('cin', 0); sim.setInput('arith', 0); sim.setInput('reg', reg); sim.settle(); };
    const y = () => sim.getBits(sim.design.root.ports.y)[0];
    set(3, 0); expect(y()).toBe(B1);
    set(1, 0); expect(y()).toBe(B0);
    set(3, 1); expect(y()).toBe(B0); // the flip-flop still holds 0
    sim.setInput('clk', 1); sim.settle(); expect(y()).toBe(B1);
    sim.setInput('clk', 0); sim.settle();
    set(1, 1); expect(y()).toBe(B1); // held until the next edge
  });
});

describe('the routing switch', () => {
  it('joins its wires while its bit is 1, at switch level', () => {
    const sim = simulate(ROUTE_SWITCH);
    for (const v of [0, 1]) {
      sim.setInput('a', v); sim.setInput('cfg', 1); sim.settle();
      expect(sim.getBits(sim.design.root.ports.b)[0]).toBe(v ? B1 : B0);
      sim.setInput('cfg', 0); sim.settle();
      expect(sim.getBits(sim.design.root.ports.b)[0]).toBe(BZ);
    }
    expect(stats(ROUTE_SWITCH).transistors).toBe(4);
  });
});

describe('the FPGA parts draw cleanly', () => {
  for (const d of [lut(2), LUT4, lut(6), SLICE, ROUTE_SWITCH] as ComponentDef[]) {
    it(d.id, () => {
      const nl = netlistOf(d)!;
      expect(symbolOverlaps(nl)).toEqual([]);
      expect(labelOverlaps(d, nl)).toEqual([]);
      expect(wireOverlaps(routeNetlist(d, nl).nets).length).toBe(0);
    });
  }
});
