// Our static timing against OpenSTA's after routing on sky130, path by path (docs/PLAN-FINEDELAY.md, "checked against
// silicon"): every endpoint's worst path from the layout flow (scripts/layout/paths.tcl, the sky-paths-<design> artifact of
// .github/workflows/layout.yml) matched to the same flip-flop or output in our netlist, with the picoseconds one NAND delay
// (unit model) or one unit (load model) is worth on it. A model that times paths the way the cells do gives the same
// ps per delay on every path: the spread is the measure.
// Run: npx vite-node scripts/sky-paths.ts <dual | sys> <paths_max.rpt[.gz]> [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dualCore, systemCore } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { matchPaths, parsePaths, type Row, spread } from './skypathlib';

const DESIGNS = { dual: () => dualCore([], 5, true), sys: () => systemCore({ m: true }) };
const [design, file] = process.argv.slice(2) as [keyof typeof DESIGNS, string];
if (!DESIGNS[design] || !file) throw new Error('usage: sky-paths.ts <dual | sys> <paths_max.rpt[.gz]> [--json out.json]');
const jsonAt = process.argv.indexOf('--json');

const raw = readFileSync(file);
const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
const paths = parsePaths(text);
const d = flatten(DESIGNS[design](), { mode: 'gate' });
// the dual-core's cores are one block each at the top: look a level further in
const { rows, unmatched } = matchPaths(d, paths, design === 'dual' ? 2 : 1);

const worst = Math.max(...rows.map((r) => r.sky));
// short paths are mostly a flip-flop's clk-to-q, which is a constant on both sides: keep paths of at least a quarter of the worst
const long = rows.filter((r) => r.sky >= worst / 4);
const ps = (r: Row, m: 'unit' | 'load') => (r.sky * 1000) / r[m].arrival;
// the logic alone: launch taken off both sides
const psLogic = (r: Row, m: 'unit' | 'load') => ((r.sky - r.skyLaunch) * 1000) / (r[m].arrival - r[m].launch);
const f0 = (x: number) => x.toFixed(0), f1 = (x: number) => x.toFixed(1), f2 = (x: number) => x.toFixed(2), pc = (x: number) => `${(100 * x).toFixed(0)} %`;

// Spearman's rank correlation: does the model order the paths as the silicon does?
function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const idx = xs.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a), rb = rank(b), n = a.length, ma = (n - 1) / 2;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (ra[i] - ma) * (rb[i] - ma); da += (ra[i] - ma) ** 2; db += (rb[i] - ma) ** 2; }
  return num / Math.sqrt(da * db);
}

const out: string[] = [];
const line = (s = '') => out.push(s);
line(`## ${design}: ${paths.length} endpoints, ${rows.length} matched (${unmatched.length} not: ${unmatched.slice(0, 4).join(', ')}${unmatched.length > 4 ? ', …' : ''})`);
line(`Worst sky path ${f2(worst)} ns; ${long.length} paths of at least ${f2(worst / 4)} ns.`);
line();
line('| ps per delay (paths ≥ ¼ of the worst) | n | median | p10 … p90 | spread (sd / mean) | rank correlation with sky |');
line('|---|---|---|---|---|---|');
for (const m of ['unit', 'load'] as const) {
  const s = spread(long.map((r) => ps(r, m))), sl = spread(long.map((r) => psLogic(r, m)));
  const rho = spearman(long.map((r) => r.sky), long.map((r) => r[m].arrival));
  line(`| ${m === 'unit' ? 'NAND delay (unit)' : 'unit (load model)'} | ${s.n} | ${f0(s.median)} | ${f0(s.p10)} … ${f0(s.p90)} | ${pc(s.cv)} | ${f2(rho)} |`);
  line(`| … the logic alone (launch off both sides) | ${sl.n} | ${f0(sl.median)} | ${f0(sl.p10)} … ${f0(sl.p90)} | ${pc(sl.cv)} | |`);
}
line();
// where the time goes, per endpoint block
const blocks = new Map<string, Row[]>();
for (const r of long) blocks.set(r.block, [...(blocks.get(r.block) ?? []), r]);
line('| endpoint block | paths | sky ns (median) | ps / NAND delay | ps / unit | sky: buffers, wire | ours (load): on nets > 4 inputs |');
line('|---|---|---|---|---|---|---|');
for (const [b, rs] of [...blocks].sort((x, y) => y[1].length - x[1].length)) {
  const med = (f: (r: Row) => number) => spread(rs.map(f)).median;
  line(`| ${b} | ${rs.length} | ${f2(med((r) => r.sky))} | ${f0(med((r) => ps(r, 'unit')))} | ${f0(med((r) => ps(r, 'load')))} | ${pc(med((r) => r.skyBuf / r.sky))}, ${pc(med((r) => r.skyWire / r.sky))} | ${pc(med((r) => r.load.loaded / r.load.arrival))} |`);
}
line();
line('| the 12 slowest sky paths | sky ns | cells | ours: NAND delays / units | ps / NAND delay | ps / unit | sky buffers |');
line('|---|---|---|---|---|---|---|');
for (const r of [...rows].sort((a, b) => b.sky - a.sky).slice(0, 12)) {
  line(`| ${r.end} | ${f2(r.sky)} | ${r.skyCells} | ${f0(r.unit.arrival)} / ${f1(r.load.arrival)} | ${f0(ps(r, 'unit'))} | ${f0(ps(r, 'load'))} | ${pc(r.skyBuf / r.sky)} |`);
}
console.log(out.join('\n'));
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ design, endpoints: paths.length, unmatched, rows }, null, 1));
