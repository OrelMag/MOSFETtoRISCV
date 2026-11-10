// OpenSTA's paths after routing (scripts/layout/paths.tcl: one full path per endpoint) read and set beside our static
// timing (sim/timing.ts) at the same endpoint, under the unit and the load model: how many picoseconds one of our
// delays is worth on each path, and where the silicon's time goes. DOM-free; scripts/sky-paths.ts prints the tables.

import type { FlatDesign, HierNode } from '../src/sim/flatten';
import { FF_INPUT, FF_WIRE } from '../src/sim/netcap';
import { type TimingGraph, timingGraph } from '../src/sim/timing';

/** A cell output on a path: instance, master (sky130_fd_sc_hd__ dropped), its arc delay and arrival (ns), fan-out, net driven. */
export interface SkyCell { inst: string; master: string; delay: number; time: number; fanout: number; net: string }

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
    let wire = 0;
    for (let i = 0; i < bl.length; i++) {
      const o = OUT_PIN.exec(bl[i]);
      if (o) {
        const net = NET.exec(bl[i + 1] ?? '')?.[1] ?? '';
        if (o[7] !== 'in') all.push({ cell: { inst: o[6].replace(/\/[^/]+$/, ''), master: o[7].replace(/^sky130_fd_sc_hd__/, ''), delay: +o[4], time: +o[5], fanout: +o[1], net }, wire });
        wire = 0;
        continue;
      }
      const p = IN_PIN.exec(bl[i]);
      if (p) wire += +p[2];
    }
    const tail = wire; // into the endpoint's pin
    const f = all.findIndex((x) => isFlop(x.cell.master));
    const data = f >= 0 ? all.slice(f) : all;
    if (f >= 0) launch = data[0].cell.time - data[0].cell.delay;
    const cells = data.map((x) => x.cell);
    wire = tail + data.slice(f >= 0 ? 1 : 0).reduce((a, x) => a + x.wire, 0);
    const arrival = +(/(-?[\d.]+)\s+data arrival time/.exec(sec)?.[1] ?? NaN);
    const setup = port ? 0 : -(+(/(-?[\d.]+)\s+-?[\d.]+\s+library setup time/.exec(sec)?.[1] ?? 0));
    out.push({ start, end, port, launch, arrival, setup, wire, cells });
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
}

/** Our worst arrival at a sky endpoint: a flip-flop's d / en (Yosys names its register `<instance>.q$_DFF…`), or an output bit. */
export function oursAt(d: FlatDesign, g: TimingGraph, p: SkyPath): Ours | null {
  let nets: number[] = [];
  if (p.port) {
    const m = /^([^[]+)(?:\[(\d+)\])?$/.exec(p.end);
    const bits = m && d.root.ports[m[1]];
    if (!bits) return null;
    nets = [bits[m[2] ? +m[2] : 0]];
  } else {
    const segs = segmentsOf(p.end.replace(/\$_\w+$/, ''));
    if (segs[segs.length - 1] === 'q') segs.pop();
    const n = nodeAt(d.root, segs);
    const ff = n?.def.ff;
    if (!n || !ff) return null;
    nets = [n.ports[ff.d]?.[0], ...(ff.en ? [n.ports[ff.en]?.[0]] : [])].filter((x): x is number => x !== undefined);
  }
  if (!nets.length) return null;
  let best = -1, net = -1;
  for (const x of nets) { const a = g.arr(x); if (a > best) { best = a; net = x; } }
  // trace back: the launch, and the time on heavy nets
  let loaded = 0, gates = 0, launch = 0;
  const seen = new Set<number>();
  while (net >= 0 && !seen.has(net)) {
    seen.add(net);
    if (g.qSource.has(net)) { launch = g.arrival[net]; break; }
    const dr = g.driver[net];
    if (dr < 0) { launch = Math.max(0, g.arrival[net]); break; }
    gates++;
    const inArr = g.via[net] >= 0 ? g.arrival[g.via[net]] : 0;
    if (g.loads && g.loads[net] > 4 * ONE) loaded += g.arrival[net] - inArr;
    net = g.via[net];
  }
  return { arrival: best, launch, loaded, gates };
}

// one NAND input and its wire
const ONE = FF_INPUT + FF_WIRE;

export interface Row {
  end: string; block: string; port: boolean;
  /** Sky data time (ns): arrival less the launch clock latency. */
  sky: number;
  skyLaunch: number; skyBuf: number; skyWire: number; skyCells: number;
  unit: Ours; load: Ours;
}

/** Every sky path matched to ours under both models (unmatched endpoints counted). */
export function matchPaths(d: FlatDesign, paths: SkyPath[], blockDepth = 1): { rows: Row[]; unmatched: string[] } {
  const gu = timingGraph(d, { outputs: true, delay: 'unit' }), gl = timingGraph(d, { outputs: true, delay: 'load' });
  const rows: Row[] = [], unmatched: string[] = [];
  for (const p of paths) {
    const u = oursAt(d, gu, p), l = oursAt(d, gl, p);
    if (!u || !l) { unmatched.push(p.end); continue; }
    const first = p.cells[0];
    // the launch: a flip-flop's clk-to-q, or the input buffer after a port
    const skyLaunch = first && (isFlop(first.master) || p.start === first.inst || /^input\d/.test(first.inst)) ? first.delay : 0;
    const segs = p.port ? ['(outputs)'] : segmentsOf(p.end);
    rows.push({
      end: p.end, block: segs.slice(0, blockDepth).join('.'), port: p.port,
      sky: p.arrival - p.launch, skyLaunch,
      skyBuf: p.cells.filter((c, i) => isBuffer(c.master) && !(i === 0 && skyLaunch)).reduce((a, c) => a + c.delay, 0),
      skyWire: p.wire, skyCells: p.cells.length, unit: u, load: l,
    });
  }
  return { rows, unmatched };
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
