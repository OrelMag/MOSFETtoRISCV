// Random RV32 programs on the gate-level CPUs, against the golden model (tests/verify/fuzz.ts).
//   npx vite-node scripts/fuzz32.ts [cpu ids…] [--seeds <from>..<to>] [--n <units>] [--out <failures.json>]
// Exits 1 on a mismatch; --out keeps every failure (cpu, seed, program, first difference) for a CI artifact.
import { writeFileSync } from 'node:fs';
import { CPUS } from '../tests/verify/cpus';
import { firstDivergence, fuzzCase, fuzzLanes } from '../tests/verify/fuzz';

const args = process.argv.slice(2);
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : undefined);
const [from, to] = (opt('--seeds') ?? '1..32').split('..').map(Number);
const n = Number(opt('--n') ?? 60);
const ids = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const failures: { cpu: string; seed: number; diff: string; first: string; source: string }[] = [];
const t0 = performance.now();
for (const cfg of CPUS.filter((c) => !ids.length || ids.includes(c.id))) {
  const t1 = performance.now();
  let runs = 0, bad = 0;
  for (let s = from; s <= to; s += 32) {
    const cases = Array.from({ length: Math.min(32, to - s + 1) }, (_, i) => fuzzCase(cfg, s + i, n));
    for (const r of fuzzLanes(cfg, cases)) {
      runs++;
      if (r.ok) continue;
      bad++;
      const c = cases.find((x) => x.seed === r.seed)!;
      const first = firstDivergence(cfg, c);
      failures.push({ cpu: cfg.id, seed: r.seed, diff: r.diff, first, source: c.source });
      console.log(`  ${cfg.id} seed ${r.seed}: ${r.diff}\n    first difference: ${first}`);
    }
  }
  console.log(`${cfg.id.padEnd(15)} ${runs - bad}/${runs} programs match (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
}
console.log(`total ${((performance.now() - t0) / 1000).toFixed(0)} s, ${failures.length} failures`);
const out = opt('--out');
if (out) writeFileSync(out, JSON.stringify(failures, null, 1));
if (failures.length) process.exit(1);
