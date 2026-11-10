// GateSim's own speed under the unit model and under load-dependent delay (docs/PLAN-FINEDELAY.md): cycles/s of three
// CPUs and settles/s of a 64-bit adder on the bare engine, rounds alternating between the models, medians of 5.
// Run on two checkouts back to back to compare engines (the unit model must stay within ±3 %).
// Run: npx vite-node scripts/finedelay-perf.ts [--unit-only]
import '../src/lib';
import { koggeStone } from '../src/lib/fastadd';
import { singleCycleCpu } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { systemCpu } from '../src/lib/system';
import { assemble } from '../src/riscv/asm';
import { flatten, type FlatDesign } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

const LOOP = assemble(`
  addi x1, x0, 9
loop:
  add  x2, x2, x1
  sw   x2, 4(x0)
  lw   x3, 4(x0)
  addi x1, x1, -1
  bne  x1, x0, loop
  j loop`).words;
const unitOnly = process.argv.includes('--unit-only');
const MS = 1500, ROUNDS = 5;

function rate(d: FlatDesign, delay: 'unit' | 'load', clocked: boolean): number {
  const opts = delay === 'load' ? ({ delay } as never) : {};
  const sim = new GateSim(d, opts);
  let n = 0, x = 1;
  const t0 = performance.now();
  while (performance.now() - t0 < MS) {
    if (clocked) { sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle(); }
    else { x = (Math.imul(x, 1103515245) + 12345) >>> 0; sim.setInput('a', x); sim.setInput('b', x >>> 3); sim.settle(); }
    n++;
  }
  return (n * 1000) / (performance.now() - t0);
}

const med = (a: number[]) => [...a].sort((p, q) => p - q)[a.length >> 1];
for (const [name, def, clocked] of [['single-cycle RV32I', singleCycleCpu(LOOP), true], ['pipelined RV32I', pipelinedCpu(LOOP), true],
  ['system RV32I', systemCpu(LOOP), true], ['ks64 (settles/s)', koggeStone(64), false]] as const) {
  const d = flatten(def, { mode: 'gate' });
  const r: Record<string, number[]> = { unit: [], load: [] };
  for (let i = 0; i < ROUNDS; i++) for (const m of unitOnly ? ['unit'] as const : ['unit', 'load'] as const) r[m].push(rate(d, m, clocked));
  const u = med(r.unit), l = unitOnly ? 0 : med(r.load);
  console.log(`${name.padEnd(20)} unit ${u.toFixed(0).padStart(7)}${unitOnly ? '' : `   load ${l.toFixed(0).padStart(7)}   load / unit ${(100 * l / u).toFixed(0)} %`}`);
}
