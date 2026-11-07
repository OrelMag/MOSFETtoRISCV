// Runs the MAC chapter's benchmarks (src/dsp/macbench.ts) on gates, every machine, and writes the figures to src/dsp/macbench.json (checked in; the chapter reads it,
// tests/dsp-mac-bench.test.ts re-measures and holds them equal). The software-multiply machine takes about four minutes.
//   node node_modules/vite-node/vite-node.mjs scripts/mac-bench.ts [--write]
import { writeFileSync } from 'node:fs';
import { MAC_BENCHES, MAC_MACHINES, macPlan } from '../src/dsp/macbench';
import { macCost, runMachine } from '../tests/verify/macbench';

const out: Record<string, unknown> = {};
const machines: Record<string, unknown> = {};
for (const m of MAC_MACHINES) {
  const t0 = Date.now();
  const runs = await runMachine(m);
  const cost = macCost(m);
  const bad = runs.filter((r) => r.diff);
  if (bad.length) throw new Error(`${m}: ${bad.map((b) => `${b.bench}: ${b.diff}`).join('; ')}`);
  machines[m] = {
    ...cost,
    benches: Object.fromEntries(runs.map((r) => [r.bench, { cycles: r.cycles, setupCycles: r.setupCycles, kernel: r.cycles - r.setupCycles, products: macPlan(r.bench, m).products }])),
  };
  console.log(m, `${((Date.now() - t0) / 1000).toFixed(0)} s`, cost, runs.map((r) => `${r.bench} ${r.cycles - r.setupCycles}`).join(', '));
}
out.imemK = 10; out.dmemK = 8; out.benches = MAC_BENCHES; out.machines = machines;
if (process.argv.includes('--write')) { writeFileSync('src/dsp/macbench.json', JSON.stringify(out, null, 1) + '\n'); console.log('wrote src/dsp/macbench.json'); }
