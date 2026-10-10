// The benchmark set on every gate-level RV32 CPU: instructions, cycles, CPI, clock period, time, NANDs and cache
// misses, each run checked against the golden model. Prints a table; with --write, saves src/bench/results.json
// (read by the workbench's Benchmarks tab) and the table in docs/BENCHMARKS.md.
//   npx vite-node scripts/benchmarks.ts [cpu ids…] [--write]
import { mkdirSync, writeFileSync } from 'node:fs';
import { PS_PER_NAND } from '../src/sim/timing';
import { BENCH_DMEM_K, BENCH_IMEM_K, benchCases, benchLanes, measureCpu, programsHash } from '../tests/verify/bench';
import { CPUS } from '../tests/verify/cpus';

const args = process.argv.slice(2);
const ids = args.filter((a) => !a.startsWith('--'));
const write = args.includes('--write');
if (write && ids.length) throw new Error('--write measures every CPU: give no CPU ids');
const cpus = CPUS.filter((c) => !ids.length || ids.includes(c.id));

const t0 = performance.now();
const rows = [];
let failed = 0;
for (const cfg of cpus) {
  const t1 = performance.now();
  const cases = benchCases(cfg);
  const m = measureCpu(cfg.build(cases[0].words, BENCH_IMEM_K, BENCH_DMEM_K));
  const runs = await benchLanes(cfg, cases);
  rows.push({ id: cfg.id, name: cfg.name, ...m, runs });
  const cells = runs.map((r) => `${r.bench} ${r.cycles} (${(r.cycles / r.instructions).toFixed(2)})${r.dmiss !== undefined ? ` d${r.dmiss}` : ''}${r.imiss !== undefined ? ` i${r.imiss}` : ''}`);
  console.log(`${cfg.id.padEnd(15)} ${String(m.nands).padStart(6)} NAND  period ${String(m.period).padStart(3)}  ${cells.join('  ')}  (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
  for (const r of runs) if (r.diff) { failed++; console.log(`    ${r.bench}: ${r.diff}`); }
}
console.log(`total ${((performance.now() - t0) / 1000).toFixed(0)} s`);
if (failed) { console.error(`${failed} runs differ from the golden model`); process.exit(1); }

if (write) {
  const out = { programs: programsHash(), psPerNand: PS_PER_NAND, imemWords: 2 ** BENCH_IMEM_K, dmemWords: 2 ** BENCH_DMEM_K, cpus: rows.map(({ runs, ...r }) => ({ ...r, runs: runs.map(({ diff: _, ...x }) => x) })) };
  mkdirSync(new URL('../src/bench/', import.meta.url), { recursive: true });
  writeFileSync(new URL('../src/bench/results.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
  console.log('wrote src/bench/results.json');
}
