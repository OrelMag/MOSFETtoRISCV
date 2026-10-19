// The out-of-order model on the benchmark set: CPI per configuration, mispredictions, stalls.
// npx vite-node scripts/ooo-model.ts

import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { dataflow, traceOf } from '../src/riscv/ilp';
import { OooModel, type OooConfig } from '../src/riscv/ooomodel';

const OPTS = { dmemWords: 64, imemWords: 128 };
const CONFIGS: [string, Partial<OooConfig>][] = [
  ['2-wide in-order', { width: 2, inorder: true }],
  ['core', {}],
  ['core br2', { branchPorts: 2 }],
  ['core balance', { bind: 'balance' }],
  ['core br2 balance', { branchPorts: 2, bind: 'balance' }],
  ['br2 bal resolve', { branchPorts: 2, bind: 'balance', recover: 'resolve' }],
  ['br2 bal perfect', { branchPorts: 2, bind: 'balance', predict: 'perfect' }],
  ['br2 bal 4-cycle ld/mul', { branchPorts: 2, bind: 'balance', lat: { alu: 1, load: 4, mul: 4, div: 19 } }],
  ['in-order 4-cycle', { width: 2, inorder: true, branchPorts: 2, bind: 'balance', lat: { alu: 1, load: 4, mul: 4, div: 19 } }],
];

for (const b of BENCHMARKS.filter((x) => x.id !== 'fmatmul' && !x.needs?.f)) {
  const words = assemble(b.source).words;
  const tr = traceOf(words, OPTS);
  console.log(`\n${b.id}: ${tr.length} instructions, dataflow IPC ${dataflow(tr).ipc.toFixed(2)}`);
  for (const [name, cfg] of CONFIGS) {
    const m = new OooModel(words, cfg, OPTS);
    const s = m.run(200_000);
    const ok = s.instructions === tr.length ? '' : `  ✗ ${s.instructions} committed`;
    console.log(`  ${name.padEnd(24)} CPI ${(s.cycles / s.instructions).toFixed(3)}  mispred ${String(s.mispredicts).padStart(4)}  wrong ${String(s.wrongPath).padStart(5)}  robFull ${s.robFull} iqFull ${s.iqFull} sqFull ${s.sqFull}${ok}`);
  }
}
