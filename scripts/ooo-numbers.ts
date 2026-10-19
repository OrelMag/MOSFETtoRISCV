// The numbers chapter 24's prose quotes (tests/ooo-chapter.test.ts pins them).
import { assemble } from '../src/riscv/asm';
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { dataflow, traceOf } from '../src/riscv/ilp';
import { oooRun } from '../src/riscv/ooomodel';
import { OOO_PROGRAMS, SCOREBOARD_SOURCE } from '../src/riscv/oooprograms';
import { Scoreboard } from '../src/riscv/scoreboard';

const OPTS = { dmemWords: 64, imemWords: 128 };
const src = (id: string) => OOO_PROGRAMS.find((p) => p.id === id)?.source ?? BENCHMARKS.find((b) => b.id === id)!.source;
const cpi = (s: { cycles: number; instructions: number }) => (s.cycles / s.instructions).toFixed(3);
for (const id of ['dot', 'chains', 'fib', 'sort', 'matmul', 'matmul-m', 'crc']) {
  const w = assemble(src(id)).words;
  const tr = traceOf(w, OPTS);
  const r = (cfg: object) => oooRun(w, cfg, OPTS);
  const ino = r({ inorder: true }), core = r({}), btb = r({ predict: 'btb' }), res = r({ recover: 'resolve' }), perf = r({ predict: 'perfect' });
  const l4 = { lat: { alu: 1, load: 4, mul: 4, div: 19 } };
  console.log(`${id}: n ${tr.length} dataflow ${dataflow(tr).ipc.toFixed(2)} | inorder ${cpi(ino)} core ${cpi(core)} btb ${cpi(btb)} (${btb.mispredicts} vs ${core.mispredicts}) resolve ${cpi(res)} perfect ${cpi(perf)} | lat4 in ${cpi(r({ inorder: true, ...l4 }))} ooo ${cpi(r(l4))} | 1w ${cpi(r({ width: 1 }))}`);
}
for (const [name, lat] of [['hp', { alu: 2, load: 1, mul: 10, div: 40 }], ['ours', undefined]] as const) {
  const sb = new Scoreboard(assemble(SCOREBOARD_SOURCE).words, lat);
  sb.run();
  console.log(name, sb.cycle, sb.ins.map((i) => `${i.text}: ${i.issue} ${i.read} ${i.exec} ${i.write}`).join(' | '));
}
