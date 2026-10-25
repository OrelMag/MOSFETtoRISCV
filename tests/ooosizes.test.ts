// The out-of-order core at other window sizes (lib/ooocore.ts oooCpu({ rob, iq, sq }), the lab's knobs) against
// riscv/ooomodel.ts's OooModel at the same sizes, cycle by cycle (commits and the instruction each port issues), and
// against the golden model (every register after every commit, memory at the halt): as tests/ooocore.test.ts does for
// the default sizes.

import { describe, expect, it } from 'vitest';
import { oooCpu } from '../src/lib/ooocore';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, retireCount } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { randomProgram32 } from '../src/riscv/randprog32';
import { OooModel } from '../src/riscv/ooomodel';
import type { OooSizes } from '../src/lib/ooo';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { pack } from '../src/sim/values';
import { stepped } from './yieldtick';

interface Run { cycles: number; retired: number; robFull: number; iqFull: number; sqFull: number }

function* cosimSteps(source: string, z: OooSizes, { imemK = 6, dmemK = 5, max = 6000 } = {}): Generator<void, Run> {
  const words = assemble(source).words;
  const opts = { imemWords: 2 ** imemK, dmemWords: 2 ** dmemK };
  const design = flatten(oooCpu(words, { imemK, dmemK, ...z }));
  const sim = new GateSim(design);
  sim.setInput('clk', 0);
  sim.settle();
  const model = new OooModel(words, z, opts), iss = new ISS(words, { m: true, ...opts });
  const iq = design.root.children!.get('iq')!;
  const tw = Math.log2(z.rob);
  const pcOf = (p: number) => pack(sim.getBits(iq.ports[`pay${p}`].slice(tw, tw + 32))) >>> 0;
  let cycles = 0, retired = 0;
  while (!model.halted && cycles < max) {
    const n = retireCount(sim), info = model.step();
    const issued = [0, 1].map((p) => (sim.getBits(iq.ports[`go${p}`])[0] === 1 ? pcOf(p) : -1));
    const want = model.halted ? issued : [0, 1].map((p) => info.issued.find((u) => u.port === p)?.pc ?? -1);
    expect({ cycle: cycles, commits: n, issued }, `cycle ${cycles}`).toEqual({ cycle: cycles, commits: info.committed.length, issued: want });
    clockCycle(sim);
    cycles++;
    for (let k = 0; k < n && !iss.halted; k++) { iss.step(); retired++; }
    if (n) expect(cpuState(sim).x, `after #${retired} (cycle ${cycles})`).toEqual([...iss.x]);
    if (cycles % 200 === 0) yield;
  }
  expect(model.halted, 'the model halted').toBe(true);
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  const { robFull, iqFull, sqFull } = model.stats;
  return { cycles, retired, robFull, iqFull, sqFull };
}

const cosim = (source: string, z: OooSizes, o: Parameters<typeof cosimSteps>[2] = {}) => stepped(cosimSteps(source, z, o));

/** Programs that fill each window: a run of independent stores, a long divide chain with work behind it, a loop. */
const STORES = `li x1, 5\n li x2, 9\n sw x1, 0(x0)\n sw x2, 4(x0)\n sw x1, 8(x0)\n sw x2, 12(x0)\n sw x1, 16(x0)\n lw x3, 4(x0)\n sw x3, 20(x0)\n lw x4, 20(x0)
  lw x5, 16(x0)\n add x6, x4, x5\n sw x6, 24(x0)\n sw x6, 28(x0)\n lw x7, 28(x0)\n halt: j halt`;
const WINDOW = `li x1, 1000\n li x2, 7\n div x3, x1, x2\n div x4, x3, x2\n addi x5, x0, 1\n addi x6, x5, 1\n addi x7, x6, 1\n add x8, x4, x3\n addi x9, x0, 3
  addi x10, x9, 3\n mul x11, x10, x9\n addi x12, x11, 1\n sw x12, 0(x0)\n lw x13, 0(x0)\n addi x14, x13, 1\n add x15, x14, x8\n rem x16, x15, x2\n addi x17, x0, 9
  addi x18, x17, 1\n addi x19, x18, 1\n addi x20, x19, 1\n add x21, x20, x16\n halt: j halt`;
const LOOP = `li x1, 0\n li x2, 12\n li x3, 0\nloop: addi x1, x1, 1\n add x3, x3, x1\n sw x3, 0(x0)\n lw x4, 0(x0)\n mul x5, x4, x1\n bne x1, x2, loop
  li sp, 64\n jal ra, f\n jal ra, f\n j halt\nf: addi sp, sp, -4\n sw ra, 0(sp)\n addi a0, a0, 1\n lw ra, 0(sp)\n addi sp, sp, 4\n ret\nhalt: j halt`;

const POINTS: OooSizes[] = [
  { rob: 8, iq: 4, sq: 2 }, { rob: 32, iq: 16, sq: 8 },
  { rob: 8, iq: 8, sq: 4 }, { rob: 32, iq: 8, sq: 4 }, { rob: 16, iq: 4, sq: 4 }, { rob: 16, iq: 16, sq: 4 }, { rob: 16, iq: 8, sq: 2 }, { rob: 16, iq: 8, sq: 8 },
];
const name = (z: OooSizes) => `ROB ${z.rob}, IQ ${z.iq}, SQ ${z.sq}`;

describe('out-of-order core at other sizes vs the model and the golden model', () => {
  for (const z of POINTS) describe(name(z), () => {
    for (const [nm, src] of [['stores', STORES], ['window', WINDOW], ['loop', LOOP]] as const) it(nm, async () => {
      const r = await cosim(src, z);
      console.log(`${name(z)} ${nm}: ${r.retired} instructions in ${r.cycles} cycles (full: ROB ${r.robFull}, IQ ${r.iqFull}, SQ ${r.sqFull})`);
    }, 600_000);
    for (const seed of [1, 2]) it(`random seed ${seed}`, async () => {
      const src = randomProgram32(seed + 100 * z.rob + 10 * z.iq + z.sq, { m: true, dmemWords: 32 });
      const n = assemble(src).words.length;
      await cosim(src, z, { imemK: Math.max(6, Math.ceil(Math.log2(n))), dmemK: 5, max: 20000 });
    }, 600_000);
  });
});
