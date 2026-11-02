// Measures the design brief's reference cores on its workload (src/campaign/brief.ts) and, with --write, saves
// src/campaign/briefrefs.json. tests/brief.test.ts holds the file equal to a fresh measurement.
import { writeFileSync } from 'node:fs';
import '../src/lib';
import { BRIEF_REFS, measureCore } from '../src/campaign/brief';

const out: Record<string, unknown> = {};
for (const r of BRIEF_REFS) {
  const t0 = Date.now();
  const m = measureCore(r.def());
  if (!m) throw new Error(`reference ${r.id} fails the workload`);
  out[r.id] = m;
  console.log(r.id, m, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
if (process.argv.includes('--write')) {
  writeFileSync(new URL('../src/campaign/briefrefs.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
  console.log('written');
}
