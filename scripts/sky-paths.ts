// Our static timing against OpenSTA's after routing on sky130, path by path (docs/PLAN-FINEDELAY.md, "Checked against
// silicon"): every endpoint's worst path from the layout flow (scripts/layout/paths.tcl, the sky-paths-<design> artifact of
// .github/workflows/layout.yml) matched to the same flip-flop pin or output in our netlist, with the picoseconds one NAND
// delay (unit model) or one unit (load model) is worth on it. A model that times paths the way the cells do gives the same
// ps per delay on every path: the spread is the measure. Paths whose worst route starts where ours does are reported apart
// from those where the two analyses pick different routes to the same pin.
// Run: npx vite-node scripts/sky-paths.ts <dual | sys> <paths_max.rpt[.gz]> [--json out.json]

import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { dualCore, systemCore } from '../src/lib';
import { flatten } from '../src/sim/flatten';
import { FF_DRIVER, FF_INPUT, FF_WIRE } from '../src/sim/netcap';
import { distinct, matchPaths, parsePaths, type PinKind, type Row, segmentsOf, spread } from './skypathlib';

const DESIGNS = { dual: () => dualCore([], 5, true), sys: () => systemCore({ m: true }) };
const [design, file] = process.argv.slice(2) as [keyof typeof DESIGNS, string];
if (!DESIGNS[design] || !file) throw new Error('usage: sky-paths.ts <dual | sys> <paths_max.rpt[.gz]> [--json out.json]');
const jsonAt = process.argv.indexOf('--json');

const raw = readFileSync(file);
const paths = parsePaths((file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
const d = flatten(DESIGNS[design](), { mode: 'gate' });
// the dual-core's cores are one block each at the top: look a level further in
const { rows, unmatched } = matchPaths(d, paths, design === 'dual' ? 2 : 1);

const worst = Math.max(...rows.map((r) => r.sky));
// short paths are mostly a flip-flop's clk-to-q, a constant on both sides: keep paths of at least a quarter of the worst,
// each distinct timing once (a register file's words copy one path per word)
const long = distinct(rows.filter((r) => r.sky >= worst / 4));
const ps = (r: Row, m: 'unit' | 'load') => (r.sky * 1000) / r[m].arrival;
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '–'), f1 = (x: number) => x.toFixed(1), f2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : '–');
const pc = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(0)} %` : '–');

/** Spearman's rank correlation: does the model order the paths as the silicon does? */
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
  return n > 2 && da && db ? num / Math.sqrt(da * db) : NaN;
}

const out: string[] = [];
const line = (s = '') => out.push(s);
const kinds = (rs: Row[]) => (['D', 'DE', 'D (no DE)', 'port'] as PinKind[]).map((k) => `${rs.filter((r) => r.kind === k).length} ${k}`).join(', ');
line(`## ${design}: ${paths.length} endpoints (${kinds(rows)}), ${rows.length} matched${unmatched.length ? ` (not: ${unmatched.slice(0, 4).join(', ')}${unmatched.length > 4 ? ', …' : ''})` : ''}`);
line(`Worst sky path ${f2(worst)} ns. Paths of at least ${f2(worst / 4)} ns, each distinct timing once: ${long.length} (${kinds(long)}); ${long.filter((r) => r.same).length} start where our worst path to the pin does, ${long.filter((r) => r.route).length} have a route in ours from the same start.`);
line();
line('| ps per delay, distinct paths ≥ ¼ of the worst | n | median | p10 … p90 | spread (sd / mean) | rank correlation with sky |');
line('|---|---|---|---|---|---|');
const statRow = (label: string, rs: Row[], ours: (r: Row) => number) => {
  const s = spread(rs.map((r) => (r.sky * 1000) / ours(r)));
  line(`| ${label} | ${s.n} | ${f0(s.median)} | ${f0(s.p10)} … ${f0(s.p90)} | ${pc(s.cv)} | ${f2(spearman(rs.map((r) => r.sky), rs.map(ours)))} |`);
};
// our worst path to the pin may start elsewhere (a flip-flop launches at clk-to-q 3, an input after ~1: ours prefers the
// register behind a mux, silicon the select input in front of it); timed from OpenSTA's own start, the two ends are the same
const routed = long.filter((r) => r.route);
statRow('our worst path to the pin: per NAND delay (unit)', long, (r) => r.unit.arrival);
statRow('… per unit (load model)', long, (r) => r.load.arrival);
statRow("ours from the sky path's own start: per NAND delay", routed, (r) => r.route!.unit);
statRow('… per unit (load model)', routed, (r) => r.route!.load);
line();
line('| by endpoint pin (distinct, ≥ ¼; ours from the same start) | n | ps / NAND delay: median, spread | ps / unit: median, spread | rank correlation unit / load |');
line('|---|---|---|---|---|---|');
for (const k of ['D', 'DE', 'D (no DE)', 'port'] as PinKind[]) {
  const rs = routed.filter((r) => r.kind === k);
  if (!rs.length) continue;
  const su = spread(rs.map((r) => (r.sky * 1000) / r.route!.unit)), sl = spread(rs.map((r) => (r.sky * 1000) / r.route!.load));
  line(`| ${k} | ${rs.length} | ${f0(su.median)}, ${pc(su.cv)} | ${f0(sl.median)}, ${pc(sl.cv)} | ${f2(spearman(rs.map((r) => r.sky), rs.map((r) => r.route!.unit)))} / ${f2(spearman(rs.map((r) => r.sky), rs.map((r) => r.route!.load)))} |`);
}
line();
// what a net carries on silicon (pins and wire) against the model's per-input charge: every cell output on every path once
const cellCap = new Map<string, { fanout: number; cap: number }>();
for (const p of paths) for (const c of p.cells) if (c.fanout > 0) cellCap.set(c.inst, { fanout: c.fanout, cap: c.cap });
const BUCKETS: [number, number][] = [[1, 1], [2, 4], [5, 16], [17, 64], [65, 1e9]];
const ours = (FF_INPUT + FF_WIRE).toFixed(1);
line(`| net fan-out (every driver on a reported path) | nets | silicon fF per input driven (median, p10 … p90) | ours: ${ours} fF per input + ${FF_DRIVER} fF |`);
line('|---|---|---|---|');
for (const [lo, hi] of BUCKETS) {
  const per = [...cellCap.values()].filter((x) => x.fanout >= lo && x.fanout <= hi).map((x) => (x.cap * 1000) / x.fanout);
  if (!per.length) continue;
  const s = spread(per);
  line(`| ${lo === hi ? lo : hi > 1e8 ? `${lo}+` : `${lo}–${hi}`} | ${s.n} | ${f1(s.median)} (${f1(s.p10)} … ${f1(s.p90)}) | ${ours} |`);
}
line();
// at nets the sky report names and we have too (instance ports, named nets): the latest sky time seen there against ours
const atNet = new Map<string, { sky: number; unit: number; load: number }>();
for (const r of rows) for (const [t, u, l, name] of r.at) {
  const x = atNet.get(name);
  if (!x || t > x.sky) atNet.set(name, { sky: t, unit: u, load: l });
}
if (atNet.size) {
  const byBlock = new Map<string, { sky: number; unit: number; load: number }[]>();
  for (const [name, x] of atNet) {
    if (x.sky < worst / 8 || x.unit <= 0) continue;
    const b = segmentsOf(name).slice(0, design === 'dual' ? 2 : 1).join('.');
    byBlock.set(b, [...(byBlock.get(b) ?? []), x]);
  }
  line(`| block (nets the sky report names, ≥ ⅛ of the worst; latest sky time there) | nets | sky ns (median) | ps / NAND delay | ps / unit |`);
  line('|---|---|---|---|---|');
  for (const [b, xs] of [...byBlock].sort((p, q) => q[1].length - p[1].length).slice(0, 14)) {
    line(`| ${b} | ${xs.length} | ${f2(spread(xs.map((x) => x.sky)).median)} | ${f0(spread(xs.map((x) => (x.sky * 1000) / x.unit)).median)} | ${f0(spread(xs.map((x) => (x.sky * 1000) / x.load)).median)} |`);
  }
  line();
}
const blocks = new Map<string, Row[]>();
for (const r of long) blocks.set(r.block, [...(blocks.get(r.block) ?? []), r]);
line('| endpoint block (distinct, ≥ ¼) | paths | same start | sky ns (median) | ps / NAND delay | ps / unit | sky: in buffers, in wire |');
line('|---|---|---|---|---|---|---|');
for (const [b, rs] of [...blocks].sort((x, y) => y[1].length - x[1].length)) {
  const med = (f: (r: Row) => number) => spread(rs.map(f)).median;
  line(`| ${b} | ${rs.length} | ${pc(rs.filter((r) => r.same).length / rs.length)} | ${f2(med((r) => r.sky))} | ${f0(med((r) => ps(r, 'unit')))} | ${f0(med((r) => ps(r, 'load')))} | ${pc(med((r) => r.skyBuf / r.sky))}, ${pc(med((r) => r.skyWire / r.sky))} |`);
}
line();
line('| the 10 slowest distinct sky paths | from (sky; ours if not the same) | sky ns | cells | ours: NAND delays / units | ps / NAND delay | ps / unit | sky in buffers |');
line('|---|---|---|---|---|---|---|---|');
for (const r of [...long].sort((a, b) => b.sky - a.sky).slice(0, 10)) {
  line(`| ${r.end} | ${r.start}${r.same ? '' : `; ${r.unit.from}`} | ${f2(r.sky)} | ${r.skyCells} | ${f0(r.unit.arrival)} / ${f1(r.load.arrival)} | ${f0(ps(r, 'unit'))} | ${f0(ps(r, 'load'))} | ${pc(r.skyBuf / r.sky)} |`);
}
console.log(out.join('\n'));
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify({ design, endpoints: paths.length, unmatched, rows }, null, 1));
