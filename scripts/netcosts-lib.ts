// Runs chapter 50's ping on the gates (two computers, two NICs, a switch) and counts, from the program counter, the retire strobe and the bus
// handshakes of every clock, what each layer of the stack costs: instructions, clocks, loads and stores by the CPU, and the NIC's own DMA
// transactions. Shared by scripts/net-costs.ts (--write saves src/comm/stack/netcosts.json) and tests/comm-net-costs.test.ts (pins the file).

import { DEFAULT_STACK } from '../src/comm/stack/all';
import { hostApp, PING_DATA, pingApp } from '../src/comm/stack/apps';
import { stackProgram, type StackBuild } from '../src/comm/stack';
import { lanComputers } from '../src/lib/lan';
import { macRx, macTx } from '../src/lib/ethernet';
import { ethSwitch } from '../src/lib/ethswitch';
import { nic } from '../src/lib/nic';
import { busComputer } from '../src/lib/soc';
import { lanSoc } from '../src/lib/lan';
import { stats } from '../src/sim/stats';
import { LAN_SWITCH } from '../src/lib/lan';
import { DualSim } from '../src/sim/dualsim';
import { flatten } from '../src/sim/flatten';
import { pack } from '../src/sim/values';

export interface Cost { instr: number; clocks: number; loads: number; stores: number }
/** One piece of work for the software, from the call that starts it to the return to the polling loop: a frame handled or a frame sent. */
export interface Window { computer: 'a' | 'b'; start: number; end: number; entry: string; /** Functions visited, first appearance order. */ visited: string[]; layers: Record<string, Cost>; total: Cost }
export interface LanCosts {
  windows: Window[];
  /** Clock at which the first ARP request left computer A, and at which A printed its first reply line; the round trip A printed. */
  clocksToFirstReply: number;
  rtt: number;
  /** Intervals [first clock, clock after the last] in which each link carried a frame: computer A's transmitter, the switch's port to B, B's transmitter, the switch's port to A (txen / carrier sense pins). */
  wire: Record<'aTx' | 'toB' | 'bTx' | 'toA', [number, number][]>;
  words: { a: number; b: number };
  /** Per computer, per layer (eth, arp, ip, icmp, app, runtime) and per function. */
  layers: Record<'a' | 'b', Record<string, Cost>>;
  functions: Record<'a' | 'b', Record<string, Cost>>;
  /** NIC DMA transactions (reads and writes) of each computer over the run, and frames each sent. */
  dma: Record<'a' | 'b', { reads: number; writes: number }>;
  /** Clocks in one pass of the application's polling loop when nothing has arrived (median), per computer. */
  pollPass: Record<'a' | 'b', number>;
  console: { a: string; b: string };
}

const zero = (): Cost => ({ instr: 0, clocks: 0, loads: 0, stores: 0 });

/** Function boundaries of a build: the address each function's label sits at, in order. */
function functionTable(sb: StackBuild): { name: string; at: number }[] {
  const labels = sb.compiled.assembled!.labels as Map<string, number>;
  const fs = (sb.compiled.layout!.funcs).map((name) => ({ name, at: labels.get(name) ?? -1 })).filter((f) => f.at >= 0);
  fs.sort((x, y) => x.at - y.at);
  return fs;
}

export async function measureLan(pings = 1, tick: () => Promise<void> = async () => {}, maxClocks = 120000): Promise<LanCosts> {
  const A = stackProgram(DEFAULT_STACK, pingApp(pings, PING_DATA)), B = stackProgram(DEFAULT_STACK, hostApp());
  if (A.compiled.error || B.compiled.error) throw new Error('the stack does not compile');
  const sim = new DualSim(flatten(lanComputers(A.compiled.words, B.compiled.words)));
  sim.preferFast = true;
  sim.reset('zero');
  sim.setInput('clk', 0);
  sim.settle(); sim.prepare(); sim.settle();
  const root = sim.design.root;
  const out = (p: string) => pack(sim.getBits(root.ports[p]));
  const builds = { a: A, b: B } as const;
  const tables = { a: functionTable(A), b: functionTable(B) };
  const startOf = { a: new Map(tables.a.map((f) => [f.at, f.name])), b: new Map(tables.b.map((f) => [f.at, f.name])) };
  const fnAt = (c: 'a' | 'b', pc: number): string => {
    const t = tables[c];
    let lo = 0, hi = t.length - 1, r = '(top)';
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (t[mid].at <= pc) { r = t[mid].name; lo = mid + 1; } else hi = mid - 1; }
    const first = t[0]?.at ?? 0;
    return pc < first ? '(top)' : r;
  };
  /** The byte helpers (ip.ts) serve every layer: counted apart, so that ARP and ICMP are not billed to IP. */
  const BYTES = new Set(['get16', 'put16', 'get32', 'put32', 'ones_sum']);
  // a function belongs to the module (layer) whose text defines it, the application's own functions to 'app'
  const moduleOf = { a: new Map<string, string>(), b: new Map<string, string>() };
  for (const c of ['a', 'b'] as const) {
    const lines = builds[c].source.split('\n');
    for (const r of builds[c].ranges) for (const line of lines.slice(r.first - 1, r.last)) { const m = /^def (\w+)\(/.exec(line); if (m) moduleOf[c].set(m[1], r.name === 'stub' ? 'udp' : r.name); }
  }
  const layerOf = (c: 'a' | 'b', pc: number): string => {
    const fn = fnAt(c, pc);
    if (BYTES.has(fn)) return 'bytes';
    return moduleOf[c].get(fn) ?? (fn === '(top)' ? 'app' : 'runtime');
  };
  const node = (c: 'a' | 'b', n: string) => root.children!.get(c)!.children!.get(n)!;
  const cpu = { a: node('a', 'cpu'), b: node('b', 'cpu') };
  const nicN = { a: node('a', 'nic'), b: node('b', 'nic') };
  const get = (n: { ports: Record<string, number[]> }, p: string) => pack(sim.getBits(n.ports[p]));
  const layers = { a: {} as Record<string, Cost>, b: {} as Record<string, Cost> };
  const functions = { a: {} as Record<string, Cost>, b: {} as Record<string, Cost> };
  const dma = { a: { reads: 0, writes: 0 }, b: { reads: 0, writes: 0 } };
  const con = { a: '', b: '' };
  const entries = { a: [] as number[], b: [] as number[] };
  const windows: Window[] = [];
  const open: Record<'a' | 'b', Window | null> = { a: null, b: null };
  const STARTS = new Set(['eth_input', 'icmp_echo', 'arp_request', 'udp_send']);
  const poll = { a: A.compiled.assembled!.labels as Map<string, number>, b: B.compiled.assembled!.labels as Map<string, number> };
  const at = (r: Record<string, Cost>, k: string) => (r[k] ??= zero());
  let clocksToFirstReply = -1, rtt = 0, c = 0;
  const wire: LanCosts['wire'] = { aTx: [], toB: [], bTx: [], toA: [] };
  const pins = { aTx: 'atxenOut', toB: 'bcrsOut', bTx: 'btxenOut', toA: 'acrsOut' } as const;
  // a pin already high at power-on (a carrier from before the first clock) opens no interval
  const level: Record<keyof typeof pins, number | undefined> = { aTx: undefined, toB: undefined, bTx: undefined, toA: undefined };
  for (; c < maxClocks; c++) {
    for (const S of ['A', 'B'] as const) if (out(`consoleValid${S}`) === 1) con[S.toLowerCase() as 'a' | 'b'] += String.fromCharCode(out(`consoleData${S}`));
    for (const x of ['a', 'b'] as const) {
      const pc = out(`pc${x.toUpperCase()}`) >>> 0;
      const fn = fnAt(x, pc), ly = layerOf(x, pc);
      const f = at(functions[x], fn), l = at(layers[x], ly);
      const retire = out(`retire${x.toUpperCase()}`) === 1;
      const n = cpu[x];
      const ld = get(n, 'arvalid') && get(n, 'arready') ? 1 : 0, st = get(n, 'awvalid') && get(n, 'awready') && get(n, 'wready') ? 1 : 0;
      f.clocks++; l.clocks++;
      if (retire) { f.instr++; l.instr++; }
      f.loads += ld; l.loads += ld; f.stores += st; l.stores += st;
      // windows of work
      let w = open[x];
      if (w && (fn === 'net_poll' || fn === '(top)')) { w.end = c; windows.push(w); w = open[x] = null; }
      if (!w && STARTS.has(fn) && startOf[x].get(pc) === fn) w = open[x] = { computer: x, start: c, end: c, entry: fn, visited: [], layers: {}, total: zero() };
      if (w) {
        if (!w.visited.includes(fn)) w.visited.push(fn);
        for (const k of [at(w.layers, ly), w.total]) { k.clocks++; if (retire) k.instr++; k.loads += ld; k.stores += st; }
      }
      const nn = nicN[x];
      if (get(nn, 'm_arvalid') && get(nn, 'm_arready')) dma[x].reads++;
      if (get(nn, 'm_awvalid') && get(nn, 'm_awready') && get(nn, 'm_wready')) dma[x].writes++;
      if (startOf[x].get(pc) === 'net_poll') entries[x].push(c);
    }
    for (const k of Object.keys(pins) as (keyof typeof pins)[]) {
      const v = out(pins[k]);
      if (level[k] !== undefined && v && !level[k]) wire[k].push([c, c]);
      if (level[k] && !v && wire[k].length && wire[k][wire[k].length - 1][0] === wire[k][wire[k].length - 1][1]) wire[k][wire[k].length - 1][1] = c;
      level[k] = v;
    }
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
    if (c % 5000 === 0) await tick();
    if (clocksToFirstReply < 0 && con.a.includes('time=')) clocksToFirstReply = c;
    if (con.a.includes('done')) break;
  }
  void poll;
  const m = con.a.match(/time=(\d+)/);
  rtt = m ? Number(m[1]) : 0;
  // one pass of the polling loop when idle: the shortest gaps between entries into net_poll (the frame-handling passes are longer)
  const gaps = (e: number[]) => { const g = e.slice(1).map((v, i) => v - e[i]).sort((x, y) => x - y); return g.length ? g[Math.floor(g.length / 2)] : 0; };
  return {
    windows, clocksToFirstReply, rtt, wire, words: { a: A.compiled.words.length, b: B.compiled.words.length }, layers, functions, dma,
    pollPass: { a: gaps(entries.a), b: gaps(entries.b) }, console: con,
  };
}

/** NAND counts of the parts the chapter quotes (symbolic: nothing is simulated). */
export function nandCounts(): Record<string, number> {
  const prog = [0x13];
  const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
  const withNic = busComputer(prog, [0], lanSoc(12)), without = busComputer(prog, [0], { ...lanSoc(12), nic: false });
  const sw = ethSwitch(LAN_SWITCH);
  return { nic: n(nic()), macTx: n(macTx()), macRx: n(macRx()), computerNic: n(withNic), computer: n(without), switch: n(sw), lan: 2 * n(withNic) + n(sw) + 2 * n(macTx()) + 2 * n(macRx()) };
}
