// The sky130 paths tests/skypaths-spread.test.ts reads: from a layout run's sky-paths-<design> artifact (OpenSTA's worst path to
// every endpoint after routing, scripts/sky-paths.ts's input), the paths of at least a quarter of the worst, slimmed to what the
// comparison needs (ends, endpoint pin and its cell, launch and arrival), gzipped into tests/sky/<design>.json.gz.
// Run: npx vite-node scripts/sky-fixture.ts <dual | sys> <paths_max.rpt[.gz]> <layout run id>

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { capBuckets, parsePaths, slimPath, type SkyFixture } from './skypathlib';

const [design, file, run] = process.argv.slice(2);
if (!design || !file || !run) throw new Error('usage: sky-fixture.ts <dual | sys> <paths_max.rpt[.gz]> <layout run id>');
const raw = readFileSync(file);
const paths = parsePaths((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
const sky = (p: { arrival: number; launch: number }) => p.arrival - p.launch;
const worst = Math.max(...paths.map(sky));
const kept = paths.filter((p) => sky(p) >= worst / 4);
const fx: SkyFixture = { design, run: Number(run), endpoints: paths.length, worst, paths: kept.map(slimPath), caps: capBuckets(paths) };
mkdirSync('tests/sky', { recursive: true });
writeFileSync(`tests/sky/${design}.json.gz`, gzipSync(JSON.stringify(fx), { level: 9 }));
console.log(`${design}: ${paths.length} endpoints, ${kept.length} kept (≥ ${(worst / 4).toFixed(2)} ns)`);
