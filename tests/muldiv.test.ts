import { describe, expect, it } from 'vitest';
import {
  BOOTH_ENC, MDU, MUL32, arrayDiv, arrayMul, compressor, condNegate, csa, divStep, ppRow, seqDivider, treeMul, treeMulInfo,
} from '../src/lib';
import { mExec } from '../src/riscv/iss';
import { evalOnce, forEachInput, inputBits, simulate } from '../src/sim/harness';
import { logicDepth, stats } from '../src/sim/stats';
import type { ComponentDef } from '../src/sim/types';
import { inPorts } from '../src/sim/types';
import { pack } from '../src/sim/values';
import type { Sim } from '../src/sim/sim';

function checkSpec(def: ComponentDef, trials = 400, extra: number[][] = []) {
  const sim = simulate(def);
  for (const ins of extra) expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins));
  if (inputBits(def) <= 12) {
    forEachInput(def, (ins) => expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins)));
  } else {
    let seed = 777;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let t = 0; t < trials; t++) {
      const ins = inPorts(def).map((p) => Math.floor(rnd() * 2 ** p.width));
      expect(evalOnce(sim, ins), `${def.id}(${ins})`).toEqual(def.spec!(ins));
    }
  }
}

describe('multiplier parts match their specs', () => {
  const small = [ppRow(4), ppRow(4, 'bwTop'), ppRow(4, 'bwLast'), csa(4), BOOTH_ENC, divStep(4), arrayMul(4), treeMul(4), treeMul(4, true), arrayDiv(4), condNegate(4)];
  for (const d of small) it(d.id, () => checkSpec(d));
  const big = [csa(16), arrayMul(8), treeMul(8), treeMul(8, true), treeMul(16), treeMul(16, true), arrayDiv(8), divStep(32), condNegate(32)];
  for (const d of big) it(d.id, () => checkSpec(d, 300, [inPorts(d).map(() => 0), inPorts(d).map((p) => 2 ** p.width - 1)]));
  it('offset compressor rows', () => {
    const r = compressor({ lo: 0, w: 5 }, { lo: 1, w: 5 }, { lo: 2, w: 5 }, 6);
    expect(r.s).toEqual({ lo: 0, w: 6 });
    expect(r.c).toEqual({ lo: 2, w: 4 });
    checkSpec(r.def);
  });
  it('MUL32: signed and unsigned high and low words', () => {
    const edge = [0, 1, 2, 0x7fffffff, 0x80000000, 0xffffffff, 0x12345678, 0xdeadbeef];
    const ex: number[][] = [];
    for (const a of edge) for (const b of edge) for (const s of [[0, 0], [1, 1], [1, 0]]) ex.push([a, b, s[0], s[1]]);
    checkSpec(MUL32, 60, ex);
  }, 120000);
});

describe('cost and depth', () => {
  it('a tree multiplier is much shallower than an array multiplier', () => {
    const a = logicDepth(arrayMul(8))!, t = logicDepth(treeMul(8))!;
    console.log(`8x8 array: ${stats(arrayMul(8)).nands} NAND depth ${a}; tree: ${stats(treeMul(8)).nands} NAND depth ${t}, ${JSON.stringify(treeMulInfo(treeMul(8)))}`);
    console.log(`16x16 array: ${stats(arrayMul(16)).nands} NAND depth ${logicDepth(arrayMul(16))}; tree: ${stats(treeMul(16)).nands} NAND depth ${logicDepth(treeMul(16))}`);
    console.log(`MUL32: ${stats(MUL32).nands} NAND depth ${logicDepth(MUL32)}, ${JSON.stringify(treeMulInfo(treeMul(33, true, 64)))}`);
    console.log(`MDU: ${stats(MDU).nands} NAND; divider ${stats(seqDivider(32)).nands}; array div 8 depth ${logicDepth(arrayDiv(8))}`);
    expect(t).toBeLessThan(a);
  });
});

const out = (sim: Sim, port: string) => pack(sim.getBits(sim.design.root.ports[port]));
const set = (sim: Sim, vals: Record<string, number>) => {
  for (const [k, v] of Object.entries(vals)) sim.setInput(k, v);
  sim.settle();
};
const tick = (sim: Sim) => { set(sim, { clk: 1 }); set(sim, { clk: 0 }); };

describe('iterative divider', () => {
  it('divides in n + 2 cycles', () => {
    const s = simulate(seqDivider(8));
    set(s, { clk: 0, start: 0, a: 0, b: 0 });
    for (const [a, b] of [[200, 7], [255, 1], [13, 0], [5, 9], [128, 128]]) {
      set(s, { start: 1, a, b });
      let cycles = 1;
      tick(s);
      set(s, { start: 0 });
      while (!out(s, 'done')) { tick(s); cycles++; expect(cycles).toBeLessThan(20); }
      cycles++;
      expect(cycles).toBe(10);
      expect([out(s, 'q'), out(s, 'r')]).toEqual(b === 0 ? [255, a] : [Math.floor(a / b), a % b]);
      tick(s);
      expect(out(s, 'busy')).toBe(0);
    }
  });
});

describe('M unit', () => {
  it('computes all eight RV32M operations like the golden model', () => {
    const s = simulate(MDU);
    set(s, { clk: 0, isM: 0, noTrap: 1, a: 0, b: 0, funct3: 0 });
    const vals = [0, 1, 7, 0xfffffff9, 0x80000000, 0xffffffff, 0x7fffffff, 12345678, 0xdeadbeef];
    for (let f3 = 0; f3 < 8; f3++) {
      for (const a of vals) for (const b of (f3 < 4 ? vals : [0, 1, 0xffffffff, 7, 0xfffffff9, 0x80000000])) {
        set(s, { a, b, funct3: f3, isM: 1 });
        let n = 0;
        while (out(s, 'stall')) { tick(s); n++; expect(n).toBeLessThan(40); }
        expect(n, `stall cycles f3=${f3}`).toBe(f3 >= 4 ? 33 : 0);
        expect(out(s, 'y') >>> 0, `f3=${f3} a=${a} b=${b}`).toBe(mExec(f3, a, b));
        tick(s);
        set(s, { isM: 0 });
      }
    }
  }, 120000);
});
