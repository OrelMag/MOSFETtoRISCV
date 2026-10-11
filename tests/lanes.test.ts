import { describe, expect, it } from 'vitest';
import { laneCore, stackEntryWidth } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle } from '../src/riscv/cosim';
import { SimtISS, type SimtEntry } from '../src/riscv/simt';
import { SIMT_PROGRAMS } from '../src/riscv/simtprograms';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { HierNode } from '../src/sim/flatten';
import { pack } from '../src/sim/values';

const u = (sim: GateSim, node: HierNode, port: string) => pack(sim.getBits(node.ports[port])) >>> 0;
const child = (n: HierNode, ...path: string[]) => path.reduce((x, p) => x.children!.get(p)!, n);

/** The hardware's stack, top first, valid entries only, in the golden model's shape. */
function hwStack(sim: GateSim, simt: HierNode, n: number): SimtEntry[] {
  const out: SimtEntry[] = [];
  const w = stackEntryWidth(n);
  for (let i = 0; i < 4; i++) {
    const bits = sim.getBits(child(simt, `e${i}`).ports.q);
    if (bits[w - 1] !== 1) break;
    const f = (lo: number, len: number) => pack(bits.slice(lo, lo + len)) >>> 0;
    out.push({ mask: f(0, n), elseMask: f(n, n), pc: f(2 * n, 32), pending: bits[2 * n + 32] === 1 });
  }
  return out;
}

function cosim(source: string, n: number, maxCycles = 3000) {
  const words = assemble(source).words;
  const design = flatten(laneCore(words, n));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const m = new SimtISS(words, { lanes: n });
  const root = design.root, simt = child(root, 'simt');
  let c = 0;
  for (; c < maxCycles && !m.halted; c++) {
    const retire = u(sim, root, 'retire') === 1;
    if (retire) m.step();
    clockCycle(sim);
    const at = `cycle ${c}`;
    expect(u(sim, root, 'pcOut'), `${at}: pc`).toBe(m.pc);
    expect(u(sim, root, 'maskOut'), `${at}: mask`).toBe(m.mask);
    if (!retire) continue;
    for (let i = 0; i < n; i++) {
      const rf = child(root, `lane${i}`, 'rf');
      const x = [0, ...Array.from({ length: 31 }, (_, r) => u(sim, child(rf, `w${r + 1}`), 'q'))];
      expect(x, `${at}: lane ${i} registers`).toEqual([...m.lanes[i].x]);
    }
    expect(hwStack(sim, simt, n), `${at}: stack`).toEqual([...m.stack].reverse());
  }
  expect(m.halted).toBe(true);
  expect(c, 'cycles').toBe(m.cycles);
  const ram = child(root, 'dm', 'ram');
  expect(Array.from({ length: 32 }, (_, i) => u(sim, child(ram, `w${i}`), 'q'))).toEqual([...m.dmem]);
  return { cycles: c, instrs: m.retired, util: m.utilization, leaves: design.leaves.length };
}

describe('lane core (gate level) vs SIMT golden model', () => {
  for (const p of SIMT_PROGRAMS) {
    it(`4 lanes: ${p.id}`, () => {
      const r = cosim(p.source, 4);
      console.log(`${p.id}: ${r.instrs} instructions, ${r.cycles} cycles, utilization ${(100 * r.util).toFixed(0)} %, ${r.leaves} leaves`);
    }, 600000);
  }
  it('2 lanes: nested', () => { cosim(SIMT_PROGRAMS.find((p) => p.id === 'nested')!.source, 2); }, 600000);
  it('8 lanes: saxpy', () => { cosim(SIMT_PROGRAMS.find((p) => p.id === 'saxpy')!.source, 8); }, 600000);
});

import { lowestOne, onehotMux, simtDecode } from '../src/lib';
import { evalOnce, forEachInput, simulate } from '../src/sim/harness';

describe('lane core blocks match their specs', () => {
  const exhaustive = (def: ReturnType<typeof lowestOne>) => {
    const sim = simulate(def);
    forEachInput(def, (ins) => expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins)));
  };
  for (const n of [2, 4, 8]) it(`lowest set bit, ${n}`, () => exhaustive(lowestOne(n)));
  it('one-hot mux 2 × 1 and 4 × 2', () => { exhaustive(onehotMux(2, 1)); exhaustive(onehotMux(4, 2)); });
  it('one-hot mux 4 × 32, random', () => {
    const d = onehotMux(4, 32), sim = simulate(d);
    let s = 7;
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0));
    for (let i = 0; i < 300; i++) {
      const ins = [r() & 15, r(), r(), r(), r()];
      expect(evalOnce(sim, ins)).toEqual(d.spec!(ins));
    }
  });
  for (const n of [2, 4, 8]) {
    it(`SIMT decoder, ${n} lanes`, () => {
      const d = simtDecode(n), sim = simulate(d);
      const cases: number[][] = [];
      for (const op of [0b0001011, 0b1110011, 0b0110011]) for (let f3 = 0; f3 < 8; f3++) for (const rs1 of [0, 5]) {
        for (const csr of [0xcc0, 0xcc1, 0xcc2, 0xcc3, 0xcc4, 0xcc5, 0xcc7, 0xf14, 0x4c0]) cases.push([op, f3, rs1, csr, 0b1010 & (2 ** n - 1)]);
      }
      for (const ins of cases) expect(evalOnce(sim, ins), `${ins}`).toEqual(d.spec!(ins));
    });
  }
});
