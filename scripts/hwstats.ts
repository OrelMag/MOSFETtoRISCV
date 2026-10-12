// Writes the workbench Statistics tab's data (src/lib/hwstats.ts) as JSON: `npm run build` runs it
// into public/hwstats.json, which Vite copies next to the site.
import fs from 'node:fs';
import path from 'node:path';
import '../src/lib';
import { hwStats } from '../src/lib/hwstats';

const out = process.argv[2] ?? 'public/hwstats.json';
const t = performance.now();
const rows = hwStats();
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ rows }));
console.log(`hwstats: ${rows.length} components in ${((performance.now() - t) / 1000).toFixed(1)} s → ${out}`);
