// Turn the flow outputs (instances.csv, metrics JSON, reports) into what the site's viewer reads:
// summary.json (numbers) and cells.json (every cell: block, kind, rectangle in µm).
// Run: node scripts/layout/summarize.mjs layout/out layout/site
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'layout/out';
const target = process.argv[3] ?? 'layout/site';
mkdirSync(target, { recursive: true });
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)])) : []);
const metrics = {};
for (const f of [...walk(join(dir, 'logs')), ...walk(join(dir, 'reports'))]) {
  if (!f.endsWith('.json')) continue;
  try { Object.assign(metrics, JSON.parse(readFileSync(f, 'utf8'))); } catch { /* not a metrics file */ }
}
const KINDS = ['logic', 'flop', 'buffer', 'clock', 'filler'];
const BLOCKS = ['core0', 'core1', 'dm', 'arb', 'other'];
const kindOf = (master) => {
  const m = master.replace(/^sky130_fd_sc_hd__/, '');
  if (/^(fill|decap|tapvpwrvgnd|tap)/.test(m)) return 'filler';
  if (/^(df|edf|sdf|dl)/.test(m)) return 'flop';
  if (/^(clkbuf|clkinv|clkdly)/.test(m)) return 'clock';
  if (/^(buf|inv|dlygate)/.test(m)) return 'buffer';
  return 'logic';
};
const blockOf = (name) => {
  const m = name.replace(/^\\/, '').match(/^(core0|core1|dm|arb)[./]/);
  return m ? m[1] : 'other';
};
let die = [0, 0, 0, 0], core = [0, 0, 0, 0];
const cells = [], masters = {}, blockArea = {}, kindCount = {};
if (existsSync(join(dir, 'instances.csv'))) {
  for (const line of readFileSync(join(dir, 'instances.csv'), 'utf8').split('\n')) {
    if (!line) continue;
    const p = line.split(',');
    if (p[0] === '#die') { die = p.slice(1).map(Number); continue; }
    if (p[0] === '#core') { core = p.slice(1).map(Number); continue; }
    const [x0, y0, x1, y1] = p.slice(2).map(Number);
    const kind = kindOf(p[1]), block = blockOf(p[0]);
    masters[p[1]] = (masters[p[1]] ?? 0) + 1;
    kindCount[kind] = (kindCount[kind] ?? 0) + 1;
    if (kind !== 'filler') blockArea[block] = (blockArea[block] ?? 0) + (x1 - x0) * (y1 - y0);
    cells.push([BLOCKS.indexOf(block), KINDS.indexOf(kind), +x0.toFixed(2), +y0.toFixed(2), +(x1 - x0).toFixed(2), +(y1 - y0).toFixed(2)]);
  }
}
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const pick = (re) => Object.fromEntries(Object.entries(metrics).filter(([k, v]) => re.test(k) && typeof v !== 'object'));
const summary = {
  generated: new Date().toISOString(), platform: 'sky130hd',
  source: read('layout/design/source.json'), run: read(join(dir, 'run.json')), tiles: read(join(dir, 'tiles/tiles.json')),
  die, core, kinds: kindCount, blockArea,
  masters: Object.entries(masters).filter(([m]) => kindOf(m) !== 'filler').sort((a, b) => b[1] - a[1]).slice(0, 30),
  metrics: pick(/(instance__(count|area)|utilization|timing__setup__(ws|tns)|clock__skew|wirelength|power__total|die__area|core__area|drc__errors|antenna__violating)/i),
};
writeFileSync(join(target, 'summary.json'), JSON.stringify(summary, null, 1));
writeFileSync(join(target, 'cells.json'), JSON.stringify({ blocks: BLOCKS, kinds: KINDS, cells }));
console.log(`summary: ${cells.length} instances, die ${die.join(' ')}, ${Object.keys(summary.metrics).length} metrics`);
