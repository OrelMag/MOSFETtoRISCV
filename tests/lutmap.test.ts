// sim/lutmap.ts: the LUT network computes, on every net it drives, the value the gates settle to (GateSim), for every
// input of the small circuits and random inputs and clock cycles of larger ones; the cuts respect k; depth and counts
// for the circuits the FPGA chapter quotes.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { resolveComponent } from '../src/lib/resolve';
import { evalLuts, lutMap, type LutMap } from '../src/sim/lutmap';
import { simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import { inPorts, type ComponentDef } from '../src/sim/types';
import type { Sim } from '../src/sim/sim';

const lib = (id: string): ComponentDef => {
  const d = resolveComponent(id);
  if (!d) throw new Error(`no ${id}`);
  return d;
};

/** Every LUT output against the gate-level simulation's settled value, from the sources' values in that state. */
let compared = 0;
function agrees(m: LutMap, sim: Sim): string | null {
  const bits = (ns: number[]) => sim.getBits(ns);
  const src = new Map<number, number>();
  const sv = bits(m.sources);
  m.sources.forEach((n, i) => src.set(n, sv[i] as number));
  if ([...src.values()].some((b) => b !== 0 && b !== 1)) return null; // an unknown source: nothing to compare
  compared++;
  const v = evalLuts(m, src);
  const outs = m.luts.map((l) => l.out), got = bits(outs);
  for (let i = 0; i < outs.length; i++) if (got[i] !== v.get(outs[i])) return `LUT ${i} (net ${outs[i]}): gates ${got[i]}, LUTs ${v.get(outs[i])}`;
  return null;
}

let seed = 1;
const rnd = (bits: number) => { let v = 0; for (let b = 0; b < bits; b += 16) { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; v += ((seed >>> 8) & 0xffff) * 2 ** b; } return bits >= 53 ? v : v % 2 ** bits; };

function check(def: ComponentDef, k = 4, vectors = 300): LutMap {
  const sim = simulate(def, 'gate');
  // the simulation's own flat design, so nets are numbered alike
  const m = lutMap(sim.design, { k });
  for (const l of m.luts) {
    expect(l.ins.length).toBeLessThanOrEqual(k);
    expect(l.table < 1n << BigInt(2 ** l.ins.length)).toBe(true);
  }
  const ins = inPorts(def);
  const total = ins.reduce((s, p) => s + p.width, 0);
  const clk = ins.find((p) => p.clock);
  sim.reset('zero');
  compared = 0;
  const exhaustive = total <= 12 && !clk;
  const n = exhaustive ? 2 ** total : vectors;
  for (let t = 0; t < n; t++) {
    let rest = t;
    for (const p of ins) {
      if (p === clk) continue;
      const v = exhaustive ? rest % 2 ** p.width : rnd(p.width);
      rest = Math.floor(rest / 2 ** p.width);
      sim.setInput(p.name, v);
    }
    sim.settle();
    expect(agrees(m, sim), `${def.id} vector ${t}`).toBeNull();
    if (clk) {
      sim.setInput(clk.name, 1); sim.settle();
      expect(agrees(m, sim), `${def.id} vector ${t}, clock high`).toBeNull();
      sim.setInput(clk.name, 0); sim.settle();
    }
  }
  // every state compared: no source was unknown
  expect(compared).toBe(clk ? 2 * n : n);
  return m;
}

describe('LUT mapping', () => {
  it('flattening twice numbers the nets alike', () => {
    const a = lutMap(lib('rca4')), b = lutMap(lib('rca4'));
    expect(a.luts).toEqual(b.luts);
  });

  it('the full adder: 2 LUTs, 1 level, for 9 NANDs 6 deep', () => {
    const fa = lib('full_adder');
    expect([stats(fa).nands, logicDepth(fa)]).toEqual([9, 6]);
    const m = check(fa);
    expect([m.luts.length, m.depth, m.nands, m.loops.length]).toEqual([2, 1, 9, 0]);
    // the tables are XOR3 and majority, inputs in some order: count the ones
    const ones = (t: bigint) => t.toString(2).split('').filter((c) => c === '1').length;
    expect(m.luts.map((l) => [l.ins.length, ones(l.table)]).sort()).toEqual([[3, 4], [3, 4]]);
  });

  it('the 4-bit ripple adder: the carry still ripples', () => {
    const m = check(lib('rca4'));
    // a carry from a generate / propagate split two bits at a time: 3 levels, not one per bit (10 LUTs)
    expect([m.depth, m.luts.length]).toEqual([3, 10]);
  });

  for (const id of ['mux16x1', 'dec3', 'rca8', 'xor', 'and4', 'addsub4', 'inc4']) {
    it(`${id}: the LUTs equal the gates on every input`, () => { check(lib(id)); });
  }

  it('wider and with k = 6: the 16-bit ALU, on random inputs', () => {
    const alu = lib('alu16');
    const m4 = check(alu, 4, 200), m6 = check(alu, 6, 200);
    expect(m6.depth).toBeLessThanOrEqual(m4.depth);
    expect(m6.luts.length).toBeLessThan(m4.luts.length);
  }, 60_000);

  it('storage drawn as gates stays: a counter maps its logic, its flip-flops are loops', () => {
    const m = check(lib('counter4'), 4, 40);
    expect(m.loops.length).toBeGreaterThan(0);
    expect(m.luts.length).toBeGreaterThan(0);
  });

  it('refuses switch-level designs and odd k', () => {
    expect(() => lutMap(lib('full_adder'), { k: 1 })).toThrow();
    expect(() => lutMap(lib('cmos_inv'))).toThrow();
  });
});
