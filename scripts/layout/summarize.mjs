// Turn the flow outputs (instances.csv, metrics JSON, reports) into what the site's viewer reads:
// summary.json (numbers, the critical path from the finish report, our estimates from source.json) and
// cells.json (every cell: block, kind, rectangle in µm).
// Run: node scripts/layout/summarize.mjs [layout/out] [layout/site] [layout/design]
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'layout/out';
const target = process.argv[3] ?? 'layout/site';
const designDir = process.argv[4] ?? 'layout/design';
mkdirSync(target, { recursive: true });
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)])) : []);
const metrics = {};
for (const f of [...walk(join(dir, 'logs')), ...walk(join(dir, 'reports'))]) {
  if (!f.endsWith('.json')) continue;
  try { Object.assign(metrics, JSON.parse(readFileSync(f, 'utf8'))); } catch { /* not a metrics file */ }
}
const read = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const source = read(join(designDir, 'source.json'));
const KINDS = ['logic', 'flop', 'buffer', 'clock', 'filler'];
// the blocks our netlist names (source.json, largest first), at most 8, then "other"
const BLOCKS = [...(source?.blocks ?? []).slice(0, 8).map((b) => b.name), 'other'];
const kindOf = (master) => {
  const m = master.replace(/^sky130_fd_sc_hd__/, '');
  if (/^(fill|decap|tapvpwrvgnd|tap)/.test(m)) return 'filler';
  if (/^(df|edf|sdf|dl)/.test(m)) return 'flop';
  if (/^(clkbuf|clkinv|clkdly)/.test(m)) return 'clock';
  if (/^(buf|inv|dlygate)/.test(m)) return 'buffer';
  return 'logic';
};
// a cell's name starts with the top-level instance it came from (core0/rf.rp2.mux/_1627_, dm.ram.w18.ff24.q$_DFFE_PP_)
const blockOf = (name) => {
  const b = name.replace(/^\\/, '').split(/[./]/)[0];
  return BLOCKS.includes(b) ? b : 'other';
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

// OpenSTA's view after routing (6_finish.rpt): the minimum period and the worst setup path, cell by cell
function finishTiming() {
  const rpt = walk(join(dir, 'reports')).find((f) => f.endsWith('6_finish.rpt'));
  if (!rpt) return null;
  const text = readFileSync(rpt, 'utf8');
  const min = /period_min = ([\d.]+) fmax = ([\d.]+)/.exec(text);
  const sec = text.split(/^=+$/m).find((s) => /report_checks -path_delay max\b/.test(s));
  if (!sec) return min ? { periodMin: +min[1], fmax: +min[2] } : null;
  const start = /Startpoint: (\S+)/.exec(sec)?.[1] ?? '', end = /Endpoint: (\S+)/.exec(sec)?.[1] ?? '';
  const arrival = +(/([\d.]+)\s+data arrival time/.exec(sec)?.[1] ?? NaN);
  const setup = +(/(-?[\d.]+)\s+-?[\d.]+\s+library setup time/.exec(sec)?.[1] ?? NaN);
  // an output pin's line: fanout cap slew delay time edge pin (master)
  const cellsOn = [];
  for (const m of sec.split('data arrival time')[0].matchAll(/^\s+\d+\s+[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s+[\^v]\s+(\S+)\s+\((sky130\S+)\)/gm)) {
    cellsOn.push({ delay: +m[1], time: +m[2], inst: m[3].replace(/\/[^/]+$/, ''), master: m[4].replace(/^sky130_fd_sc_hd__/, '') });
  }
  // by block, as our own critical path is listed (inputs and output buffers belong to no block)
  const stages = [];
  for (const c of cellsOn) {
    const block = blockOf(c.inst);
    if (stages.length && stages[stages.length - 1].block === block) { stages[stages.length - 1].time = c.time; stages[stages.length - 1].cells++; }
    else stages.push({ block, time: c.time, cells: 1 });
  }
  return {
    periodMin: min ? +min[1] : null, fmax: min ? +min[2] : null, start, end, arrival, setup: Number.isFinite(setup) ? -setup : null,
    cells: cellsOn.length, stages,
  };
}

const pick = (re) => Object.fromEntries(Object.entries(metrics).filter(([k, v]) => re.test(k) && typeof v !== 'object'));
const summary = {
  generated: new Date().toISOString(), platform: 'sky130hd',
  source, run: read(join(dir, 'run.json')), tiles: read(join(dir, 'tiles/tiles.json')),
  die, core, kinds: kindCount, blocks: BLOCKS, blockArea, sta: finishTiming(),
  masters: Object.entries(masters).filter(([m]) => kindOf(m) !== 'filler').sort((a, b) => b[1] - a[1]).slice(0, 30),
  metrics: pick(/(instance__(count|area)|utilization|timing__setup__(ws|tns)|clock__skew|wirelength|power__total|die__area|core__area|drc__errors|antenna__violating)/i),
};
writeFileSync(join(target, 'summary.json'), JSON.stringify(summary, null, 1));
writeFileSync(join(target, 'cells.json'), JSON.stringify({ blocks: BLOCKS, kinds: KINDS, cells }));
console.log(`summary: ${cells.length} instances, die ${die.join(' ')}, ${Object.keys(summary.metrics).length} metrics, critical path ${summary.sta?.periodMin ?? '?'} ns over ${summary.sta?.cells ?? '?'} cells`);
