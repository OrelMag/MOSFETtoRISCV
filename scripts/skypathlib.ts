// OpenSTA's paths after routing (scripts/layout/paths.tcl: one full path per endpoint) read and set beside our static
// timing (sim/timing.ts) at the same endpoint, under the unit and the load model: how many picoseconds one of our
// delays is worth on each path, and where the silicon's time goes. DOM-free; scripts/sky-paths.ts prints the tables.

import type { FlatDesign, HierNode } from '../src/sim/flatten';
import { FF_INPUT, FF_WIRE } from '../src/sim/netcap';
import { type TimingGraph, timingGraph } from '../src/sim/timing';
import { netlistOf } from '../src/sim/types';

/** A cell output on a path: instance, master (sky130_fd_sc_hd__ dropped), its arc delay and arrival (ns), fan-out, net driven, the
 *  capacitance on that net (pF: pins and wire). */
export interface SkyCell { inst: string; master: string; delay: number; time: number; fanout: number; net: string; cap: number }

export interface SkyPath {
  start: string; end: string;
  /** The endpoint is an output port (else a flip-flop's data pin). */
  port: boolean;
  /** Launch clock latency (ns): the clock tree's delay to the launching flip-flop, 0 from an input. */
  launch: number;
  /** Data arrival time (ns), launch latency included. */
  arrival: number;
  /** Library setup time at the endpoint (ns), 0 at a port. */
  setup: number;
  /** Wire delays summed (ns): each input pin's delay after the driving output. */
  wire: number;
  cells: SkyCell[];
  /** The endpoint pin (D, DE of a flip-flop with an enable; the port name at a port). */
  pin: string;
  /** The endpoint pin's cell (edfxtp_1 …; 'out' at a port). */
  endMaster: string;
}

const OUT_PIN = /^\s+(\d+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+[\^v]\s+(\S+)\s+\((\S+)\)\s*$/;
const IN_PIN = /^\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+[\^v]\s+(\S+)\s+\((\S+)\)\s*$/;
const NET = /^\s+(\S+) \(net\)\s*$/;

/** Every path of a report_checks -format full report with the fields input_pins slew cap fanout nets. */
export function parsePaths(text: string): SkyPath[] {
  const out: SkyPath[] = [];
  for (const sec of text.split(/^Startpoint: /m).slice(1)) {
    const lines = sec.split('\n');
    const start = lines[0].trim().split(/\s+/)[0];
    const endLine = lines.find((l) => l.startsWith('Endpoint: '));
    if (!endLine) continue;
    const end = endLine.slice(10).trim().split(/\s+/)[0];
    const port = /output port/.test(sec.slice(sec.indexOf('Endpoint: '), sec.indexOf('Path Group')));
    const body = sec.split(/data arrival time/)[0];
    const bl = body.split('\n');
    // Each cell output with the wire delay into it. A path from a flip-flop lists the clock tree first (clk (in),
    // clkbuf…, the flip-flop's CLK): the data part starts at the launching flip-flop, its clock arrival is the launch.
    let launch = 0;
    const lat = /^\s+(-?[\d.]+)\s+(-?[\d.]+)\s+clock network delay/m.exec(body);
    if (lat) launch = +lat[2];
    const all: { cell: SkyCell; wire: number }[] = [];
    let pin = '', endMaster = '';
    let wire = 0;
    for (let i = 0; i < bl.length; i++) {
      const o = OUT_PIN.exec(bl[i]);
      if (o) {
        const net = NET.exec(bl[i + 1] ?? '')?.[1] ?? '';
        if (o[7] !== 'in') all.push({ cell: { inst: o[6].replace(/\/[^/]+$/, ''), master: o[7].replace(/^sky130_fd_sc_hd__/, ''), delay: +o[4], time: +o[5], fanout: +o[1], net, cap: +o[2] }, wire });
        wire = 0;
        continue;
      }
      const p = IN_PIN.exec(bl[i]);
      if (p) { wire += +p[2]; pin = p[4].replace(/^.*\//, ''); endMaster = p[5].replace(/^sky130_fd_sc_hd__/, ''); }
    }
    const tail = wire; // into the endpoint's pin
    const f = all.findIndex((x) => isFlop(x.cell.master));
    const data = f >= 0 ? all.slice(f) : all;
    if (f >= 0) launch = data[0].cell.time - data[0].cell.delay;
    const cells = data.map((x) => x.cell);
    wire = tail + data.slice(f >= 0 ? 1 : 0).reduce((a, x) => a + x.wire, 0);
    const arrival = +(/(-?[\d.]+)\s+data arrival time/.exec(sec)?.[1] ?? NaN);
    const setup = port ? 0 : -(+(/(-?[\d.]+)\s+-?[\d.]+\s+library setup time/.exec(sec)?.[1] ?? 0));
    out.push({ start, end, port, launch, arrival, setup, wire, cells, pin, endMaster });
  }
  return out;
}

/** Inserted buffers (resizer, input / output buffers, delay cells), against the logic Yosys mapped. */
export const isBuffer = (master: string) => /^(buf|clkbuf|dlygate|clkdlybuf|dlymetal)/.test(master);
export const isFlop = (master: string) => /^(df|edf|sdf|dl)/.test(master);

/** An OpenSTA name split into our instance names: kept modules join with '/', flattened ones with '.'. */
export const segmentsOf = (name: string) => name.replace(/\\/g, '').split(/[./]/).filter(Boolean);

function nodeAt(root: HierNode, segs: string[]): HierNode | null {
  let n: HierNode | undefined = root;
  for (const s of segs) {
    n = n.children?.get(s);
    if (!n) return null;
  }
  return n;
}

export interface Ours {
  /** Our arrival at the endpoint (no setup), in NAND delays ('unit') or load-model units. */
  arrival: number;
  /** Of it: the launch (clk-to-q, or an input's drive), and the delay on nets driving more than 4 inputs. */
  launch: number; loaded: number;
  /** Gates on our worst path to it. */
  gates: number;
  /** Where our worst path to it starts: a flip-flop's instance path, or an input bit (name[bit]). */
  from: string;
}

const inputNames = new WeakMap<FlatDesign, Map<number, string>>();
const inputByName = new WeakMap<FlatDesign, Map<string, number>>();
/** Root input bits by OpenSTA's name for them. */
function inputNets(d: FlatDesign): Map<string, number> {
  let m = inputByName.get(d);
  if (!m) {
    const names = new Map<string, number>();
    for (const p of d.root.def.ports) if (p.dir === 'in') d.root.ports[p.name].forEach((n, i) => names.set(p.width > 1 ? `${p.name}[${i}]` : p.name, n));
    inputByName.set(d, (m = names));
  }
  return m;
}

/** Root input nets by name, as OpenSTA prints a port bit (name[bit], a 1-bit port bare). */
function inputName(d: FlatDesign, net: number): string | undefined {
  let m = inputNames.get(d);
  if (!m) {
    const names = new Map<number, string>();
    for (const p of d.root.def.ports) if (p.dir === 'in') d.root.ports[p.name].forEach((n, i) => names.set(n, p.width > 1 ? `${p.name}[${i}]` : p.name));
    inputNames.set(d, (m = names));
  }
  return m.get(net);
}

/** A register's instance path from Yosys's name for it (`rf.w15.ff29.q$_DFFE_PP_` → rf, w15, ff29). */
export function flopPath(name: string): string[] {
  const segs = segmentsOf(name.replace(/\$_\w+$/, ''));
  if (segs[segs.length - 1] === 'q') segs.pop();
  return segs;
}

/** The nets our timing reads at a sky endpoint: a flip-flop's d / en, or an output bit. */
export function endpointNets(d: FlatDesign, p: SkyPath): number[] {
  if (p.port) {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(p.end);
    const bits = m && d.root.ports[m[1]];
    return bits ? [bits[m[2] ? +m[2] : 0]] : [];
  }
  const n = nodeAt(d.root, flopPath(p.end));
  const ff = n?.def.ff;
  if (!n || !ff) return [];
  // an enabled flip-flop's two pins are two endpoints (D, DE); a cell without DE has the enable folded into D
  const d0 = n.ports[ff.d]?.[0], e0 = ff.en ? n.ports[ff.en]?.[0] : undefined;
  return (p.pin === 'DE' ? [e0] : p.pin === 'D' && /^edf/.test(p.endMaster) ? [d0] : [d0, e0]).filter((x): x is number => x !== undefined);
}

/** Our worst arrival at a sky endpoint, and where that path starts. */
export function oursAt(d: FlatDesign, g: TimingGraph, p: SkyPath): Ours | null {
  const nets = endpointNets(d, p);
  if (!nets.length) return null;
  let best = -1, net = -1;
  for (const x of nets) { const a = g.arr(x); if (a > best) { best = a; net = x; } }
  // trace back: the launch, and the time on heavy nets
  let loaded = 0, gates = 0, launch = 0, from = '';
  const seen = new Set<number>();
  while (net >= 0 && !seen.has(net)) {
    seen.add(net);
    if (g.qSource.has(net)) { launch = g.arrival[net]; from = g.qSource.get(net)!.join('.'); break; }
    const dr = g.driver[net];
    if (dr < 0) { launch = Math.max(0, g.arrival[net]); from = inputName(d, net) ?? ''; break; }
    // a leaf with no input on the path starts it: a stateful behaviour (a memory's read register, sim/timing.ts seq0) or a
    // constant (a tie cell, arrival 1): named by its instance path, as timing.ts names a launch
    if (g.via[net] < 0) { launch = g.arrival[net]; from = g.leaves[dr].node.path.join('.'); break; }
    gates++;
    const inArr = g.via[net] >= 0 ? g.arrival[g.via[net]] : 0;
    if (g.loads && g.loads[net] > 4 * ONE) loaded += g.arrival[net] - inArr;
    net = g.via[net];
  }
  return { arrival: best, launch, loaded, gates, from };
}

/** Does OpenSTA's startpoint name the start of our path (the same flip-flop, or the same input bit)? */
export function sameStart(skyStart: string, ours: string): boolean {
  if (!ours) return false;
  if (ours === skyStart) return true;
  const f = flopPath(skyStart).join('.');
  // our boundary may be the flip-flop inside an enabled one (rf.w15.ff29.ff)
  return !!f && (ours === f || ours.startsWith(`${f}.`));
}

/** A net of a path by its OpenSTA name: a port of an instance (L0_5.fa30.g4.y) or a named net of a level (WriteData[15]). */
export function netByName(d: FlatDesign, name: string): number | undefined {
  const m = /^(.*?)(?:\[(\d+)\])?$/.exec(name.split('\\').join(''))!;
  const segs = segmentsOf(m[1]), bit = m[2] ? +m[2] : 0;
  if (!segs.length || segs[segs.length - 1].startsWith('_')) return undefined;
  let n: HierNode = d.root, i = 0;
  while (i < segs.length - 1 && n.children?.get(segs[i])) { n = n.children.get(segs[i])!; i++; }
  if (i === segs.length - 2) return n.children?.get(segs[i])?.ports[segs[i + 1]]?.[bit];
  if (i === segs.length - 1 && !n.children?.get(segs[i])) {
    // a named net of this level
    const k = netlistOf(n.def)?.nets.findIndex((x) => x.name === segs[i]) ?? -1;
    return k >= 0 ? n.nets?.[k]?.[bit] : undefined;
  }
  return undefined;
}

/**
 * Our longest path from one startpoint (a flip-flop's outputs, or an input bit) to a net, under the graph's model: the
 * same two ends as OpenSTA's path, so the delays compare route for route. -Infinity where the start does not reach.
 */
export function fromStart(d: FlatDesign, g: TimingGraph, start: string): ((net: number) => number) | null {
  const src = new Map<number, number>();
  const bit = inputNets(d).get(start);
  if (bit !== undefined) src.set(bit, Math.max(0, g.arr(bit)));
  else {
    const f = flopPath(start).join('.');
    if (f) for (const [net, path] of g.qSource) {
      const p = path.join('.');
      if (p === f || p.startsWith(`${f}.`)) src.set(net, g.clkToQ(net));
    }
  }
  if (!src.size) return null;
  const memo = new Float64Array(d.netCount).fill(NaN);
  const opened = new Uint8Array(d.netCount);
  return (target: number) => {
    // iterative DFS as timing.ts's arr (paths are hundreds of gates deep); a net met again while open is a loop: unreachable
    const stack = [target];
    while (stack.length) {
      const net = stack[stack.length - 1];
      if (!Number.isNaN(memo[net])) { stack.pop(); continue; }
      if (src.has(net)) { memo[net] = src.get(net)!; stack.pop(); continue; }
      const dr = g.driver[net];
      if (dr < 0 || g.qSource.has(net)) { memo[net] = -Infinity; stack.pop(); continue; }
      if (!opened[net]) {
        opened[net] = 1;
        for (const p of g.tin[dr]) for (const i of p) if (Number.isNaN(memo[i]) && !opened[i]) stack.push(i);
        continue;
      }
      let best = -Infinity;
      for (const p of g.tin[dr]) for (const i of p) { const a = Number.isNaN(memo[i]) ? -Infinity : memo[i]; if (a > best) best = a; }
      memo[net] = best === -Infinity ? -Infinity : best + g.delays[dr];
      stack.pop();
    }
    return memo[target];
  };
}

// one NAND input and its wire
const ONE = FF_INPUT + FF_WIRE;

/** The endpoint pin's kind: a flip-flop's data (D), its enable (DE), a flip-flop without an enable pin, an output. */
export type PinKind = 'D' | 'DE' | 'D (no DE)' | 'port';

export interface Row {
  end: string; block: string; port: boolean; kind: PinKind;
  /** Sky data time (ns): arrival less the launch clock latency. */
  sky: number;
  skyLaunch: number; skyBuf: number; skyWire: number; skyCells: number;
  /** OpenSTA's startpoint; does our worst path to the same pin start there too (under both models)? */
  start: string; same: boolean;
  /** Our longest path from OpenSTA's startpoint to the same pin (unit, load): the same two ends; null if ours does not connect them. */
  route: { unit: number; load: number } | null;
  unit: Ours; load: Ours;
  /** Nets on the sky path that name one of ours: [sky time from launch (ns), our unit arrival, our load arrival, net name]. */
  at: [number, number, number, string][];
}

/** Every sky path matched to ours under both models (unmatched endpoints counted). */
export function matchPaths(d: FlatDesign, paths: SkyPath[], blockDepth = 1): { rows: Row[]; unmatched: string[] } {
  const gu = timingGraph(d, { outputs: true, delay: 'unit' }), gl = timingGraph(d, { outputs: true, delay: 'load' });
  const rows: Row[] = [], unmatched: string[] = [];
  // one start's memo at a time (a net array per start would not fit for thousands of starts): paths taken in start order
  let cur = '', s: { unit: ((n: number) => number) | null; load: ((n: number) => number) | null } = { unit: null, load: null };
  const routeOf = (p: SkyPath) => {
    if (p.start !== cur) { cur = p.start; s = { unit: fromStart(d, gu, p.start), load: fromStart(d, gl, p.start) }; }
    if (!s.unit || !s.load) return null;
    const nets = endpointNets(d, p);
    const u = Math.max(...nets.map(s.unit)), l = Math.max(...nets.map(s.load));
    return Number.isFinite(u) && Number.isFinite(l) ? { unit: u, load: l } : null;
  };
  for (const p of [...paths].sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0))) {
    const u = oursAt(d, gu, p), l = oursAt(d, gl, p);
    if (!u || !l) { unmatched.push(p.end); continue; }
    const first = p.cells[0];
    // the launch: a flip-flop's clk-to-q, or the input buffer after a port
    const skyLaunch = first && (isFlop(first.master) || p.start === first.inst || /^input\d/.test(first.inst)) ? first.delay : 0;
    const segs = p.port ? ['(outputs)'] : segmentsOf(p.end);
    const at: Row['at'] = [];
    for (const c of p.cells) {
      const n = c.net ? netByName(d, c.net) : undefined;
      if (n !== undefined) at.push([c.time - p.launch, gu.arr(n), gl.arr(n), c.net]);
    }
    rows.push({
      end: p.port ? p.end : `${p.end}/${p.pin}`, block: segs.slice(0, blockDepth).join('.'), port: p.port,
      kind: p.port ? 'port' : p.pin === 'DE' ? 'DE' : /^edf/.test(p.endMaster) ? 'D' : 'D (no DE)',
      sky: p.arrival - p.launch, skyLaunch,
      skyBuf: p.cells.filter((c, i) => isBuffer(c.master) && !(i === 0 && skyLaunch)).reduce((a, c) => a + c.delay, 0),
      skyWire: p.wire, skyCells: p.cells.length, start: p.start, same: sameStart(p.start, u.from) && sameStart(p.start, l.from), route: routeOf(p),
      unit: u, load: l, at,
    });
  }
  return { rows, unmatched };
}

/** Rows with the same timing on both sides once (the register file's 31 words copy one path 31 times). */
export function distinct(rows: Row[]): Row[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    const k = `${r.kind}|${r.sky.toFixed(3)}|${r.unit.arrival}|${r.load.arrival.toFixed(2)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export interface Spread { n: number; median: number; p10: number; p90: number; cv: number }
export function spread(xs: number[]): Spread {
  const s = [...xs].sort((a, b) => a - b), n = s.length;
  if (!n) return { n: 0, median: NaN, p10: NaN, p90: NaN, cv: NaN };
  const q = (f: number) => s[Math.min(n - 1, Math.max(0, Math.round(f * (n - 1))))];
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / n);
  return { n, median: q(0.5), p10: q(0.1), p90: q(0.9), cv: sd / mean };
}

/** A layout run's paths as tests/sky/<design>.json.gz keeps them (scripts/sky-fixture.ts): the worst of at least a quarter of the worst. */
export interface SkyFixture { design: string; run: number; endpoints: number; worst: number; paths: SlimPath[]; caps: [number, number, number, number][] }
/** start, end, port, launch, arrival, pin, endpoint cell. */
export type SlimPath = [string, string, 0 | 1, number, number, string, string];
export const slimPath = (p: SkyPath): SlimPath => [p.start, p.end, p.port ? 1 : 0, p.launch, p.arrival, p.pin, p.endMaster];
/** A slim path back as a SkyPath: no cells (the comparison needs only its ends and times). */
export const unslim = ([start, end, port, launch, arrival, pin, endMaster]: SlimPath): SkyPath =>
  ({ start, end, port: !!port, launch, arrival, setup: 0, wire: 0, cells: [], pin, endMaster });

/** Spearman's rank correlation: does the model order the paths as the silicon does? */
export function spearman(a: number[], b: number[]): number {
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

/** A distribution of ps per delay, rounded for a table and a pin: median, p10, p90 in ps, cv and rho to 2 places. */
export interface SpreadRow { n: number; median: number; p10: number; p90: number; cv: number; rho: number }
/** What the silicon chapter's table shows of one design (src/chapters/silicon/skytiming.json, tests/skypaths-spread.test.ts). */
export interface SkySummary {
  design: string; run: number; endpoints: number; worst: number; paths: number; sameStart: number;
  /** ps per NAND delay (unit) and per unit (load): our worst path to the pin, and ours timed from the sky path's own start. */
  worstUnit: SpreadRow; worstLoad: SpreadRow; startUnit: SpreadRow; startLoad: SpreadRow;
  byPin: { kind: PinKind; n: number; unit: number; unitCv: number; load: number; loadCv: number }[];
  byBlock: { block: string; n: number; sky: number; unit: number; load: number }[];
  /** Each endpoint block's slowest path: where it ends and starts on silicon, where our worst path to the pin starts, sky ns, ours. */
  slowest: { end: string; start: string; ours: string; sky: number; unit: number; load: number }[];
  /** Silicon's fF per input driven by a net's fan-out, every driver on a reported path once: [lo, hi, nets, median]. */
  caps: [number, number, number, number][];
}

const r0 = (x: number) => Math.round(x), r2 = (x: number) => Math.round(x * 100) / 100;

/** The comparison's numbers from matched rows (paths of at least a quarter of the worst, each distinct timing once). */
export function summarize(fx: Pick<SkyFixture, 'design' | 'run' | 'endpoints' | 'caps'>, rows: Row[]): SkySummary {
  const worst = Math.max(...rows.map((r) => r.sky));
  const long = distinct(rows.filter((r) => r.sky >= worst / 4)), routed = long.filter((r) => r.route);
  const row = (rs: Row[], ours: (r: Row) => number): SpreadRow => {
    const s = spread(rs.map((r) => (r.sky * 1000) / ours(r)));
    return { n: s.n, median: r0(s.median), p10: r0(s.p10), p90: r0(s.p90), cv: r2(s.cv), rho: r2(spearman(rs.map((r) => r.sky), rs.map(ours))) };
  };
  const med = (xs: number[]) => spread(xs).median;
  const byPin = (['D', 'DE', 'D (no DE)', 'port'] as PinKind[]).flatMap((kind) => {
    const rs = routed.filter((r) => r.kind === kind);
    if (!rs.length) return [];
    const su = spread(rs.map((r) => (r.sky * 1000) / r.route!.unit)), sl = spread(rs.map((r) => (r.sky * 1000) / r.route!.load));
    return [{ kind, n: rs.length, unit: r0(su.median), unitCv: r2(su.cv), load: r0(sl.median), loadCv: r2(sl.cv) }];
  });
  const blocks = new Map<string, Row[]>();
  for (const r of long) blocks.set(r.block, [...(blocks.get(r.block) ?? []), r]);
  const byBlock = [...blocks].sort((x, y) => y[1].length - x[1].length || (x[0] < y[0] ? -1 : 1)).map(([block, rs]) => ({
    block, n: rs.length, sky: r2(med(rs.map((r) => r.sky))), unit: r0(med(rs.map((r) => (r.sky * 1000) / r.unit.arrival))), load: r0(med(rs.map((r) => (r.sky * 1000) / r.load.arrival))),
  }));
  // each endpoint block's slowest path (a register file's words copy one path, so one per block says more than the top ten)
  const seen = new Set<string>();
  const slowest = [...long].sort((a, b) => b.sky - a.sky || (a.end < b.end ? -1 : 1)).filter((r) => (seen.has(r.block) ? false : (seen.add(r.block), true))).map((r) => ({ end: r.end, start: r.start, ours: r.unit.from, sky: r2(r.sky), unit: r.unit.arrival, load: r2(r.load.arrival) }));
  return {
    design: fx.design, run: fx.run, endpoints: fx.endpoints, worst: r2(worst), paths: long.length, sameStart: long.filter((r) => r.same).length,
    worstUnit: row(long, (r) => r.unit.arrival), worstLoad: row(long, (r) => r.load.arrival),
    startUnit: row(routed, (r) => r.route!.unit), startLoad: row(routed, (r) => r.route!.load),
    byPin, byBlock, slowest, caps: fx.caps,
  };
}

/** Silicon's capacitance per input driven, by fan-out bucket, over every cell output on the reported paths (once each). */
export function capBuckets(paths: SkyPath[]): [number, number, number, number][] {
  const cellCap = new Map<string, { fanout: number; cap: number }>();
  for (const p of paths) for (const c of p.cells) if (c.fanout > 0) cellCap.set(c.inst, { fanout: c.fanout, cap: c.cap });
  const BUCKETS: [number, number][] = [[1, 1], [2, 4], [5, 16], [17, 64], [65, 1e9]];
  return BUCKETS.flatMap(([lo, hi]) => {
    const per = [...cellCap.values()].filter((x) => x.fanout >= lo && x.fanout <= hi).map((x) => (x.cap * 1000) / x.fanout);
    return per.length ? [[lo, hi, per.length, Math.round(spread(per).median * 10) / 10] as [number, number, number, number]] : [];
  });
}
