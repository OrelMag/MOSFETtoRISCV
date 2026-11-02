// The memories inside a simulated design, for the Memory contents views (widgets/memgrid.ts on a scene, the sandbox's
// Memory drawer): every RAM / register file at any depth, found once per build (DOM-free). A memory is
//  - a node with two or more w<i> registers of one width (ram, regfile, the caches' arrays): w<i> is word i;
//  - a large RAM simulated as a lookup (lib/bigmem.ts: its words in the leaf's state);
//  - a byte-banked memory (lsu.ts: four byte lanes b0 … b3 joined into words);
//  - registers of one kind under a node whose pins name a write port (a learner's RAM or register file, rv16_rf): which
//    register sits at which address is found by writing each address on a private copy of the node's definition
//    (probeWrites), so a decoder wired to the wrong register shows as such.
// ROMs hold no state and are never found. Words are read live; the word being read and the word the next rising edge
// writes come from the memory's own ports (addr / wa / ra<i> / we), not the scene's inputs.

import { ramLeafState, type RamState } from '../lib/bigmem';
import { flatten, type HierNode } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { needsSwitchLevel } from '../sim/harness';
import type { Sim } from '../sim/sim';
import { SwitchSim } from '../sim/switchsim';
import { B0, B1, BX, type Bit, type ComponentDef, type PortDef } from '../sim/types';
import { pack } from '../sim/values';

const WORD = /^w(\d+)$/;

/** Registers named w<i> (each with a q port) directly under a node. */
export function wordRegs(n: HierNode): Map<number, HierNode> {
  const out = new Map<number, HierNode>();
  for (const [name, c] of n.children ?? []) {
    const m = WORD.exec(name);
    if (m && c.ports.q) out.set(Number(m[1]), c);
  }
  return out;
}

/** Where the words are read from: registers' outputs (address → nets), a lookup leaf's state, or four byte lanes. */
export type MemSource =
  | { kind: 'regs'; regs: Map<number, number[]> }
  | { kind: 'big'; leaf: number }
  | { kind: 'banked'; lanes: Map<number, number[]>[] };

export interface MemInfo {
  /** Instance path from the root ('' for the root itself, 'dp.rf', 'mem.ram'). */
  path: string;
  node: HierNode;
  /** The rows shown: addresses 0 … words − 1 (a register file's x0 is a row with no storage). */
  words: number;
  width: number;
  /** Row label prefix: 'x' / 'f' for register files (x5), '' for a memory ([5]). */
  prefix: string;
  src: MemSource;
  /** Found by probing (a learner's memory): the instance at each address, and what looked wrong. */
  built?: { names: Map<number, string>; problems: string[] };
}

/** A row's address as shown: x5 for a register file, [5] (or [0F5] past 64 words, in hex) for a memory. */
export function rowLabel(m: MemInfo, i: number): string {
  if (m.prefix) return `${m.prefix}${i}`;
  return m.words > 64 ? `[${i.toString(16).toUpperCase().padStart(Math.ceil(Math.log2(m.words) / 4), '0')}]` : `[${i}]`;
}

const outsOf = (regs: Map<number, HierNode>) => new Map([...regs].map(([i, r]) => [i, r.ports.q]));

const sameWidth = (regs: Map<number, number[]>): number | null => {
  let w: number | null = null;
  for (const q of regs.values()) {
    if (w === null) w = q.length;
    else if (q.length !== w) return null;
  }
  return w;
};

const prefixOf = (n: HierNode): string => /^regfile/.test(n.def.id) || 'ra1' in n.ports ? (/_f(_|$)/.test(n.def.id) ? 'f' : 'x') : '';

// ---- a learner's memory: roles by pin name, addresses by probing ---------------------------------

/** The pins of a write port, by the names the chapters, the campaign and the library use. */
export interface WriteRoles { addr: string; we: string; data: string; clk: string }

const ins = (def: ComponentDef) => def.ports.filter((p) => p.dir === 'in');
const named = (ps: PortDef[], re: RegExp, width?: (w: number) => boolean) => ps.find((p) => re.test(p.name) && (!width || width(p.width)));

export function writeRoles(def: ComponentDef): WriteRoles | null {
  const i = ins(def);
  const clk = i.find((p) => p.clock && p.width === 1) ?? named(i, /^clk$/i, (w) => w === 1);
  const addr = named(i, /^(wa|waddr|addr|adr|a)$/i, (w) => w >= 1 && w <= 6);
  const we = named(i, /^(we|wen|wr|write)$/i, (w) => w === 1);
  const data = named(i, /^(wd|din|d|data|wdata)$/i, (w) => w >= 2);
  return clk && addr && we && data ? { addr: addr.name, we: we.name, data: data.name, clk: clk.name } : null;
}

/** A register-like instance's output: q, else its only output. */
const outPort = (d: ComponentDef): PortDef | undefined => {
  const outs = d.ports.filter((p) => p.dir === 'out');
  return outs.find((p) => p.name === 'q') ?? (outs.length === 1 ? outs[0] : undefined);
};
const clocked = (d: ComponentDef) => d.ports.some((p) => p.dir === 'in' && (p.clock || p.name === 'clk'));

export interface ProbeResult {
  /** Address → the instance it writes (only addresses that write exactly one). */
  at: Map<number, string>;
  /** Output port of the word instances. */
  out: string;
  problems: string[];
}

const probes = new WeakMap<ComponentDef, ProbeResult | null>();

/**
 * Which instance each address writes: on a private simulation of `def`, from power-on (all zero) each address in turn
 * is written with all ones (we = 1, one clock pulse); the registers whose output changed are the ones it wrote.
 * Candidates: two or more clocked instances of one definition whose output is as wide as the data pin. Null when `def`
 * has no such pins or registers, or no address writes exactly one of them. Memoized per definition (a sandbox edit
 * compiles a new one).
 */
export function probeWrites(def: ComponentDef): ProbeResult | null {
  if (probes.has(def)) return probes.get(def)!;
  let res: ProbeResult | null = null;
  try { res = probe(def); } catch { res = null; }
  probes.set(def, res);
  return res;
}

function probe(def: ComponentDef): ProbeResult | null {
  const roles = writeRoles(def);
  if (!roles || !def.netlist) return null;
  const width = def.ports.find((p) => p.name === roles.data)!.width;
  const k = def.ports.find((p) => p.name === roles.addr)!.width;
  // the word candidates: the largest group of same-definition clocked instances with a data-wide output
  const groups = new Map<ComponentDef, string[]>();
  for (const inst of def.netlist().instances) {
    const o = outPort(inst.def);
    if (!o || o.width !== width || !clocked(inst.def)) continue;
    groups.set(inst.def, [...(groups.get(inst.def) ?? []), inst.name]);
  }
  const names = [...groups.values()].sort((a, b) => b.length - a.length)[0];
  if (!names || names.length < 2) return null;
  const out = outPort(def.netlist().instances.find((i) => i.name === names[0])!.def)!.name;
  const level = needsSwitchLevel(def) ? 'switch' : 'gate';
  const sim: Sim = level === 'switch' ? new SwitchSim(flatten(def, { mode: level })) : new GateSim(flatten(def, { mode: level }));
  const kids = sim.design.root.children!;
  const read = () => names.map((n) => pack(sim.getBits(kids.get(n)!.ports[out])));
  const ones = width >= 53 ? -1 : 2 ** width - 1;
  const writes = new Map<number, string[]>();
  for (let a = 0; a < 2 ** k; a++) {
    sim.reset('zero');
    for (const p of ins(def)) sim.setInput(p.name, 0);
    sim.settle();
    const before = read();
    sim.setInput(roles.addr, a);
    sim.setInput(roles.we, 1);
    if (ones < 0) sim.setInputBits(roles.data, new Array(width).fill(1)); else sim.setInput(roles.data, ones);
    sim.settle();
    sim.setInput(roles.clk, 1);
    sim.settle();
    sim.setInput(roles.clk, 0);
    sim.settle();
    const after = read();
    writes.set(a, names.filter((_, j) => after[j] !== before[j]));
  }
  const at = new Map<number, string>();
  const problems: string[] = [];
  const by = new Map<string, number[]>();
  for (const [a, w] of writes) {
    if (w.length === 1) at.set(a, w[0]);
    if (w.length > 1) problems.push(`${roles.addr} = ${a} writes ${w.length} words (${w.join(', ')})`);
    for (const n of w) by.set(n, [...(by.get(n) ?? []), a]);
  }
  for (const [n, as] of by) if (as.length > 1) problems.push(`${n} is written at ${roles.addr} = ${as.join(' and ')}`);
  const never = names.filter((n) => !by.has(n));
  if (never.length) problems.push(`never written: ${never.join(', ')}`);
  return at.size >= 2 ? { at, out, problems } : null;
}

// ---- finding them --------------------------------------------------------------------------------

/** The memory at this node, if it is one (not looking below it). */
function memAt(sim: Sim, n: HierNode, path: string): MemInfo | null {
  if (n.leafIndex !== undefined) {
    const st = ramLeafState(sim, n);
    return st ? { path, node: n, words: st.mem.length, width: n.ports.dout?.length ?? n.ports.q?.length ?? 32, prefix: '', src: { kind: 'big', leaf: n.leafIndex } } : null;
  }
  if (!n.expanded) return null;
  const regs = outsOf(wordRegs(n));
  if (regs.size >= 2) {
    const width = sameWidth(regs);
    if (width === null || width < 2) return null;
    // a register file's x0 has no storage but keeps its row; a RAM's words start at w0
    return { path, node: n, words: Math.max(...regs.keys()) + 1, width, prefix: prefixOf(n), src: { kind: 'regs', regs } };
  }
  // a byte-banked memory (lsu.ts bankedMemory): four RAMs of bytes, b0 the low byte
  const lanes = [0, 1, 2, 3].map((i) => n.children?.get(`b${i}`));
  if (lanes.every((b) => b?.expanded)) {
    const ls = lanes.map((b) => outsOf(wordRegs(b!)));
    if (ls.every((r) => r.size >= 2 && sameWidth(r) === 8)) {
      return { path, node: n, words: Math.max(...ls[0].keys()) + 1, width: 32, prefix: '', src: { kind: 'banked', lanes: ls } };
    }
  }
  const pr = writeRoles(n.def) && probeWrites(n.def);
  if (pr) {
    const regs = new Map<number, number[]>();
    for (const [a, name] of pr.at) {
      const q = n.children?.get(name)?.ports[pr.out];
      if (q) regs.set(a, q);
    }
    const width = sameWidth(regs);
    if (regs.size < 2 || width === null) return null;
    const k = n.ports[writeRoles(n.def)!.addr].length;
    return { path, node: n, words: 2 ** k, width, prefix: prefixOf(n), src: { kind: 'regs', regs }, built: { names: pr.at, problems: pr.problems } };
  }
  return null;
}

/** Every memory in the design, outermost first in instance order; nothing inside a memory is listed again. */
export function findMemories(sim: Sim, root: HierNode = sim.design.root): MemInfo[] {
  const out: MemInfo[] = [];
  const walk = (n: HierNode, path: string) => {
    const m = memAt(sim, n, path);
    if (m) { out.push(m); return; }
    if (!n.expanded || !n.children) return;
    for (const [name, c] of n.children) walk(c, path ? `${path}.${name}` : name);
  };
  walk(root, '');
  return out;
}

// ---- reading them --------------------------------------------------------------------------------

/** A word's bits, LSB first (null: no storage at that address, e.g. x0). */
export function wordBits(sim: Sim, m: MemInfo, i: number): Bit[] | null {
  const s = m.src;
  if (s.kind === 'regs') {
    const q = s.regs.get(i);
    return q ? sim.getBits(q) : null;
  }
  if (s.kind === 'banked') {
    const out: Bit[] = [];
    for (const lane of s.lanes) {
      const q = lane.get(i);
      if (!q) return null;
      out.push(...sim.getBits(q));
    }
    return out;
  }
  const st = sim.leafState(s.leaf) as RamState;
  const v = st.mem[i];
  return Array.from({ length: m.width }, (_, b) => (st.x[i] ? BX : (v >>> b) & 1 ? B1 : B0));
}

/** A word's value (−1: unknown or no storage); exact to 53 bits, which every memory here is below. */
export function wordValue(sim: Sim, m: MemInfo, i: number): number {
  const s = m.src;
  if (s.kind === 'big') {
    const st = sim.leafState(s.leaf) as RamState;
    return st.x[i] ? -1 : st.mem[i];
  }
  const b = wordBits(sim, m, i);
  return b ? pack(b) : -1;
}

/** True when there is no storage at this address (a register file's x0, an address a learner's decoder never selects). */
export const noStorage = (m: MemInfo, i: number): boolean =>
  m.src.kind === 'regs' ? !m.src.regs.has(i) : m.src.kind === 'banked' ? !m.src.lanes[0].has(i) : false;

/** A packed port of the memory's own node (−1: X, null: no such port). */
function portValue(sim: Sim, n: HierNode, name: string): number | null {
  const nets = n.ports[name];
  return nets ? pack(sim.getBits(nets)) : null;
}

/** Write ports: (address, enable) pairs by the library's names. */
const WRITES: [string, string][] = [['wa', 'we'], ['wa0', 'we0'], ['wa1', 'we1'], ['addr', 'we']];
const READ = /^(ra\d*|raddr\d*|addr)$/;

export interface MemMarks {
  /** Addresses being read (a read port's address). */
  read: number[];
  /** Addresses the next rising edge writes (write enable on), storage-less ones (x0) left out. */
  write: number[];
}

/** Which words are being read and which the next rising edge writes, from the memory's own ports. */
export function memMarks(sim: Sim, m: MemInfo): MemMarks {
  const n = m.node;
  const read: number[] = [], write: number[] = [];
  if (m.src.kind === 'big') {
    const st = sim.leafState(m.src.leaf) as RamState;
    const a = portValue(sim, n, 'addr') ?? st.a;
    if (a >= 0) read.push(a);
    if (st.we === 1 && st.a >= 0) write.push(st.a);
    return { read, write };
  }
  for (const p of n.def.ports) {
    if (p.dir !== 'in' || !READ.test(p.name)) continue;
    const a = portValue(sim, n, p.name);
    if (a !== null && a >= 0 && a < m.words && !read.includes(a)) read.push(a);
  }
  const roles = m.built ? writeRoles(n.def) : null;
  for (const [wa, we] of roles ? [[roles.addr, roles.we] as [string, string]] : WRITES) {
    const a = portValue(sim, n, wa), e = portValue(sim, n, we);
    if (a !== null && e === 1 && a >= 0 && a < m.words && !noStorage(m, a) && !write.includes(a)) write.push(a);
  }
  return { read, write };
}
