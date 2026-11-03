// Cycles of every chapter-15 sample on the gate-level pipeline, RV32I routines against RV32IM (npx vite-node scripts/pypipe-table.ts [id…]).
import { compilePy } from '../src/lang/compile';
import { lineTotal, PipeProfile } from '../src/lang/pipeprof';
import { PY_PROGRAMS } from '../src/lang/pyprograms';
import { pipelinedCpu } from '../src/lib';
import { clockCycle } from '../src/riscv/cosim';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { PY_DMEM_K, PY_IMEM_K } from '../src/widgets/python';

const only = process.argv.slice(2); // ids, or none for all (~3 min)
function measure(source: string, m: boolean) {
  const c = compilePy(source, { dmemWords: 2 ** PY_DMEM_K, m });
  if (c.error || c.words.length > 2 ** PY_IMEM_K) return null;
  const sim = new GateSim(flatten(pipelinedCpu(c.words, { imemK: PY_IMEM_K, dmemK: PY_DMEM_K, m })));
  sim.setInput('clk', 0);
  sim.settle();
  const prof = new PipeProfile(c, c.assembled!.labels.get('halt') ?? c.assembled!.labels.get('program.halt') ?? 0);
  while (!prof.finished && prof.cycles < 60_000) { prof.sample(sim); clockCycle(sim); }
  const t = prof.total(), f = prof.cost(0);
  t.instr += f.instr; t.stall += f.stall; t.flush += f.flush; t.divide += f.divide;
  return { cycles: prof.cycles, ...t, words: c.words.length, sum: lineTotal(t) };
}
console.log('id'.padEnd(12), 'I: cycles instr stall flush | IM: cycles instr stall flush divide');
for (const p of PY_PROGRAMS) {
  if (only.length && !only.includes(p.id)) continue;
  const a = measure(p.source, false), b = measure(p.source, true);
  if (!a || !b) { console.log(p.id.padEnd(12), 'skipped'); continue; }
  console.log(p.id.padEnd(12), [a.cycles, a.instr, a.stall, a.flush].map(String).join(' ').padEnd(24), '|', [b.cycles, b.instr, b.stall, b.flush, b.divide].join(' '));
}
