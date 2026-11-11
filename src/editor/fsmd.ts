// A state machine with a datapath (DOM-free; roadmap builders step 3). The machine (FsmDoc with `data`) has
// registers of one width, data inputs and outputs; a state's register transfers (reg := expr) happen at the clock edge
// leaving it, and an arc may also need tests on the data (a < b, x = 0, a[7]). It is built as a controller and a
// datapath: the controller is an ordinary state machine (fsmchip.ts) derived from this one, whose inputs are the 1-bit
// inputs and one status bit per test, and whose Moore outputs load the registers and steer their source multiplexers
// and the operator units; the datapath is library blocks: a register (reg<w>) per register, a multiplexer tree in front
// of it, one unit per operator kind and per transfers a state needs at once (+ an adder, − an adder-subtractor, & | ^
// bitwise; shifts by a constant are wiring), operand multiplexers in front of a shared unit, a comparator per pair
// compared. fsmdStep is the reference the built circuit is checked against, cycle by cycle (fsmdCheck).

import { constWord } from '../lib/alu';
import { Builder } from '../lib/builder';
import { magComparator } from '../lib/coding';
import { addSub, muxTree, rca } from '../lib/combinational';
import { merger, ones, splitter } from '../lib/define';
import { AND, NOT } from '../lib/gates';
import { register } from '../lib/sequential';
import { TIE0, TIE1 } from '../lib/transistors';
import { bitwise } from '../lib/wide';
import type { Sim } from '../sim/sim';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, NetDef, Netlist, PortDef } from '../sim/types';
import { pack } from '../sim/values';
import { type FsmDataDoc, type FsmDoc, isIdent } from './model';

export const DATA_WIDTHS = [4, 8, 12, 16];
export const DATA_MAX = 6;

// ---- expressions ----------------------------------------------------------------------------------------

export type Operand = { kind: 'reg' | 'in'; name: string } | { kind: 'k'; v: number };
export type BinOp = '+' | '-' | '&' | '|' | '^';
export type Expr = { op: null; a: Operand } | { op: BinOp; a: Operand; b: Operand } | { op: '<<' | '>>'; a: Operand; k: number };
export type Cmp = 'eq' | 'ne' | 'lt' | 'le' | 'gt' | 'ge';
export type Test = { cmp: Cmp; a: Operand; b: Operand } | { bit: Operand; k: number };
type Shift = Extract<Expr, { op: '<<' | '>>' }>;
type Bin = Extract<Expr, { op: BinOp }>;
const isShift = (e: Expr): e is Shift => e.op === '<<' || e.op === '>>';
const isBin = (e: Expr): e is Bin => e.op !== null && !isShift(e);

const CMP_TEXT: Record<string, Cmp> = { '=': 'eq', '==': 'eq', '!=': 'ne', '≠': 'ne', '<': 'lt', '<=': 'le', '≤': 'le', '>': 'gt', '>=': 'ge', '≥': 'ge' };
const CMP_SHOW: Record<Cmp, string> = { eq: '=', ne: '≠', lt: '<', le: '≤', gt: '>', ge: '≥' };

const tokens = (src: string) => src.replace(/−/g, '-').match(/0x[0-9a-fA-F]+|\d+|[A-Za-z_]\w*|<<|>>|<=|>=|==|!=|[-+&|^<>=≠≤≥[\]]|\S/g) ?? [];

function operand(t: string | undefined, data: FsmDataDoc): Operand | string {
  if (t === undefined) return 'an operand is missing';
  if (/^(0x[0-9a-f]+|\d+)$/i.test(t)) {
    const v = Number(t);
    return v < 2 ** data.width ? { kind: 'k', v } : `${t} does not fit in ${data.width} bits`;
  }
  if (data.regs.includes(t)) return { kind: 'reg', name: t };
  if (data.ins.includes(t)) return { kind: 'in', name: t };
  return `${t} is not a register or a data input (${[...data.regs, ...data.ins].join(', ') || 'none yet'})`;
}

/** reg := expr's right-hand side: an operand, two operands and + − & | ^, or an operand shifted << / >> a constant. */
export function parseExpr(src: string, data: FsmDataDoc): Expr | { error: string } {
  const t = tokens(src);
  const a = operand(t[0], data);
  if (typeof a === 'string') return { error: a };
  if (t.length === 1) return { op: null, a };
  const op = t[1];
  if ((op === '<<' || op === '>>') && t.length === 3) {
    const k = Number(t[2]);
    if (!/^\d+$/.test(t[2]) || k < 1 || k >= data.width) return { error: `shift by a constant from 1 to ${data.width - 1}` };
    return { op, a, k };
  }
  if (!['+', '-', '&', '|', '^'].includes(op) || t.length !== 3) return { error: 'one operator: a + b, a − b, a & b, a | b, a ^ b, a << 1, a >> 1' };
  const b = operand(t[2], data);
  if (typeof b === 'string') return { error: b };
  return { op: op as BinOp, a, b };
}

/** An arc's test: a comparison of two operands (= ≠ < ≤ > ≥) or one bit of an operand (a[7]). */
export function parseTest(src: string, data: FsmDataDoc): Test | { error: string } {
  const t = tokens(src);
  if (t.length === 4 && t[1] === '[' && t[3] === ']') {
    const bit = operand(t[0], data), k = Number(t[2]);
    if (typeof bit === 'string') return { error: bit };
    if (!/^\d+$/.test(t[2]) || k >= data.width) return { error: `a bit from 0 to ${data.width - 1}` };
    return { bit, k };
  }
  const cmp = CMP_TEXT[t[1] ?? ''];
  if (!cmp || t.length !== 3) return { error: 'a comparison (a = b, a ≠ b, a < b, a ≤ b, a > b, a ≥ b) or a bit (a[7])' };
  const a = operand(t[0], data), b = operand(t[2], data);
  if (typeof a === 'string') return { error: a };
  if (typeof b === 'string') return { error: b };
  return { cmp, a, b };
}

export const operandText = (o: Operand): string => (o.kind === 'k' ? String(o.v) : o.name);
export const exprText = (e: Expr): string => (isShift(e) ? `${operandText(e.a)} ${e.op} ${e.k}` : isBin(e) ? `${operandText(e.a)} ${e.op === '-' ? '−' : e.op} ${operandText(e.b)}` : operandText(e.a));
export const testText = (t: Test): string => ('bit' in t ? `${operandText(t.bit)}[${t.k}]` : `${operandText(t.a)} ${CMP_SHOW[t.cmp]} ${operandText(t.b)}`);

// ---- the reference --------------------------------------------------------------------------------------

export interface FsmdState { s: number; regs: Record<string, number> }
export interface FsmdInputs { bits: Record<string, number>; data: Record<string, number>; rst?: number }

const val = (o: Operand, st: FsmdState, inp: FsmdInputs) => (o.kind === 'k' ? o.v : o.kind === 'reg' ? st.regs[o.name] ?? 0 : inp.data[o.name] ?? 0);

export function evalExpr(e: Expr, st: FsmdState, inp: FsmdInputs, w: number): number {
  const m = 2 ** w - 1, a = val(e.a, st, inp);
  switch (e.op) {
    case null: return a & m;
    case '<<': return (a << e.k) & m;
    case '>>': return (a & m) >>> e.k;
    default: {
      const b = val(e.b, st, inp);
      return (e.op === '+' ? a + b : e.op === '-' ? a - b + 2 ** w : e.op === '&' ? a & b : e.op === '|' ? a | b : a ^ b) & m;
    }
  }
}

export function evalTest(t: Test, st: FsmdState, inp: FsmdInputs): number {
  if ('bit' in t) return (val(t.bit, st, inp) >> t.k) & 1;
  const a = val(t.a, st, inp), b = val(t.b, st, inp);
  return Number(t.cmp === 'eq' ? a === b : t.cmp === 'ne' ? a !== b : t.cmp === 'lt' ? a < b : t.cmp === 'le' ? a <= b : t.cmp === 'gt' ? a > b : a >= b);
}

/** The arc out of state s these inputs take, or −1 (the state stays): its 1-bit pattern and every test hold. */
export function fsmdArc(doc: FsmDoc, st: FsmdState, inp: FsmdInputs): number {
  const data = doc.data!;
  return doc.arcs.findIndex((a) => a.from === st.s
    && doc.ins.every((x) => a.when[x] === undefined || a.when[x] === (inp.bits[x] ?? 0))
    && (a.test ?? []).every((t) => { const p = parseTest(t.expr, data); return !('error' in p) && evalTest(p, st, inp) === t.is; }));
}

/** One clock cycle: the outputs before the edge, then the state after it (rst: back to the reset state, the registers hold). */
export function fsmdStep(doc: FsmDoc, st: FsmdState, inp: FsmdInputs): { outs: Record<string, number>; next: FsmdState } {
  const data = doc.data!, w = data.width;
  const k = fsmdArc(doc, st, inp);
  const outs: Record<string, number> = {};
  for (const o of doc.outs) outs[o] = Number(!!doc.states[st.s].out?.includes(o) || (k >= 0 && !!doc.arcs[k].out?.includes(o)));
  for (const o of data.outs) outs[o.name] = data.regs.includes(o.src) ? st.regs[o.src] ?? 0 : inp.data[o.src] ?? 0;
  const regs = { ...st.regs };
  if (!inp.rst) for (const t of doc.states[st.s].act ?? []) {
    const e = parseExpr(t.expr, data);
    if (!('error' in e)) regs[t.reg] = evalExpr(e, st, inp, w);
  }
  return { outs, next: { s: inp.rst ? doc.reset : k >= 0 ? doc.arcs[k].to : st.s, regs } };
}

// ---- checking the machine -------------------------------------------------------------------------------

const RESERVED = /^(rst|clk|st\d+|ld_\w+|sel_\w+|u\d+s\d*)$/;

/** Is the datapath well formed (names, widths, every transfer and test)? null, or why not. */
export function dataProblem(doc: FsmDoc): string | null {
  const d = doc.data;
  if (!d) return null;
  if (!DATA_WIDTHS.includes(d.width)) return `a data width of ${DATA_WIDTHS.join(', ')} bits`;
  if (d.ins.length > DATA_MAX || d.regs.length > DATA_MAX || d.outs.length > DATA_MAX) return `at most ${DATA_MAX} data inputs, registers and data outputs`;
  const names = [...doc.ins, ...doc.outs, ...d.ins, ...d.regs, ...d.outs.map((o) => o.name)];
  const bad = names.find((x) => !isIdent(x) || x.includes('.') || RESERVED.test(x) || /^[sn]\d+$/.test(x));
  if (bad !== undefined) return `'${bad}' cannot be a name here (rst, clk, s0…, n0…, st0…, ld_…, sel_… are the machine's own)`;
  const dup = names.find((x, i) => names.indexOf(x) !== i);
  if (dup) return `two things are called '${dup}'`;
  for (const o of d.outs) if (!d.regs.includes(o.src) && !d.ins.includes(o.src)) return `${o.name} shows '${o.src}': not a register or a data input`;
  for (const s of doc.states) {
    const seen = new Set<string>();
    for (const t of s.act ?? []) {
      if (!d.regs.includes(t.reg)) return `${s.name}: '${t.reg}' is not a register`;
      if (seen.has(t.reg)) return `${s.name} loads ${t.reg} twice`;
      seen.add(t.reg);
      const e = parseExpr(t.expr, d);
      if ('error' in e) return `${s.name}: ${t.reg} := ${t.expr}: ${e.error}`;
    }
  }
  for (const a of doc.arcs) for (const t of a.test ?? []) {
    const p = parseTest(t.expr, d);
    if ('error' in p) return `${doc.states[a.from].name} → ${doc.states[a.to].name}: ${t.expr}: ${p.error}`;
  }
  return null;
}

// ---- the hardware plan ----------------------------------------------------------------------------------

const opKey = (o: Operand) => (o.kind === 'k' ? `#${o.v}` : `${o.kind}:${o.name}`);
const exprKey = (e: Expr) => (isShift(e) ? `${opKey(e.a)}${e.op}${e.k}` : isBin(e) ? `${opKey(e.a)}${e.op}${opKey(e.b)}` : opKey(e.a));
const testKey = (t: Test) => ('bit' in t ? `${opKey(t.bit)}[${t.k}]` : `${opKey(t.a)}${t.cmp}${opKey(t.b)}`);
const bitsFor = (n: number) => (n <= 1 ? 0 : Math.ceil(Math.log2(n)));

/** Operator units: per kind, enough for the transfers one state needs at once; each its expressions, in order. */
export interface Unit { op: BinOp; exprs: Bin[]; keys: string[] }

export interface FsmdPlan {
  /** Per register: its sources (expressions), in mux order. */
  sources: Record<string, Expr[]>;
  units: Unit[];
  /** Distinct tests: each a status bit st<i> into the controller. */
  tests: Test[];
  /** Comparators: one per pair of operands compared (in either order). */
  pairs: [Operand, Operand][];
}

export function planOf(doc: FsmDoc): FsmdPlan {
  const d = doc.data!;
  const sources: Record<string, Expr[]> = Object.fromEntries(d.regs.map((r) => [r, []]));
  const unitExprs = new Map<string, Bin>();
  const inState: string[][] = doc.states.map(() => []);
  doc.states.forEach((s, si) => {
    for (const t of s.act ?? []) {
      const e = parseExpr(t.expr, d);
      if ('error' in e) continue;
      if (!sources[t.reg].some((x) => exprKey(x) === exprKey(e))) sources[t.reg].push(e);
      if (isBin(e)) { unitExprs.set(exprKey(e), e); if (!inState[si].includes(exprKey(e))) inState[si].push(exprKey(e)); }
    }
  });
  // units per kind: greedy colouring, two expressions on one unit only if no state needs both
  const units: Unit[] = [];
  for (const [key, e] of unitExprs) {
    const clash = (u: Unit) => inState.some((ks) => ks.includes(key) && u.keys.some((k) => ks.includes(k)));
    const u = units.find((x) => x.op === e.op && !clash(x));
    if (u) { u.exprs.push(e); u.keys.push(key); } else units.push({ op: e.op, exprs: [e], keys: [key] });
  }
  const tests: Test[] = [];
  for (const a of doc.arcs) for (const t of a.test ?? []) {
    const p = parseTest(t.expr, d);
    if (!('error' in p) && !tests.some((x) => testKey(x) === testKey(p))) tests.push(p);
  }
  const pairs: [Operand, Operand][] = [];
  for (const t of tests) if (!('bit' in t)) {
    const has = pairs.some(([a, b]) => (opKey(a) === opKey(t.a) && opKey(b) === opKey(t.b)) || (opKey(a) === opKey(t.b) && opKey(b) === opKey(t.a)));
    if (!has) pairs.push([t.a, t.b]);
  }
  return { sources, units, tests, pairs };
}

/** The controller's control outputs: ld_<reg>, sel_<reg><bit>, u<k>s<bit>, after the machine's own outputs. */
export function controlOuts(doc: FsmDoc, plan = planOf(doc)): string[] {
  const d = doc.data!, out: string[] = [];
  for (const r of d.regs) {
    out.push(`ld_${r}`);
    for (let b = 0; b < bitsFor(plan.sources[r].length); b++) out.push(`sel_${r}${b}`);
  }
  plan.units.forEach((u, k) => { for (let b = 0; b < bitsFor(u.exprs.length); b++) out.push(`u${k}s${b}`); });
  return out;
}

/** The controller: this machine's states and arcs over 1-bit inputs + status bits, loading and steering the datapath. */
export function controllerOf(doc: FsmDoc, of: string, plan = planOf(doc)): FsmDoc | { error: string } {
  const d = doc.data!;
  const st = plan.tests.map((_, i) => `st${i}`);
  const ctl = controlOuts(doc, plan);
  if (doc.ins.length + st.length > 6) return { error: `${doc.ins.length} inputs and ${st.length} tests: the controller takes 6 at most` };
  if (doc.outs.length + ctl.length > 16) return { error: `${doc.outs.length} outputs and ${ctl.length} control lines: the controller drives 16 at most` };
  const on = (n: number, bits: number, prefix: string) => Array.from({ length: bits }, (_, b) => ((n >> b) & 1 ? `${prefix}${b}` : '')).filter(Boolean);
  const states = doc.states.map((s) => {
    const out = [...(s.out ?? [])];
    for (const t of s.act ?? []) {
      const e = parseExpr(t.expr, d);
      if ('error' in e) continue;
      out.push(`ld_${t.reg}`, ...on(plan.sources[t.reg].findIndex((x) => exprKey(x) === exprKey(e)), bitsFor(plan.sources[t.reg].length), `sel_${t.reg}`));
      plan.units.forEach((u, k) => { const i = u.keys.indexOf(exprKey(e)); if (i >= 0) out.push(...on(i, bitsFor(u.exprs.length), `u${k}s`)); });
    }
    const { act: _a, ...rest } = s;
    return { ...rest, out: out.length ? [...new Set(out)] : undefined };
  });
  const arcs = doc.arcs.map(({ test, ...a }) => {
    const when = { ...a.when };
    for (const t of test ?? []) {
      const p = parseTest(t.expr, d);
      if (!('error' in p)) when[st[plan.tests.findIndex((x) => testKey(x) === testKey(p))]] = t.is;
    }
    return { ...a, when };
  });
  const { data: _d, ...base } = doc;
  return { ...base, ins: [...doc.ins, ...st], outs: [...doc.outs, ...ctl], states, arcs, of };
}

// ---- the datapath, drawn --------------------------------------------------------------------------------

/** A row of the drawing: its parts in the order they were made (a part is made before the one it feeds). */
export interface FsmdRow { kind: 'ctl' | 'unit' | 'reg' | 'test'; names: string[] }

/**
 * The datapath machine's drawing: the pins on the left, the controller, then two columns: the operator units (operand
 * multiplexers into the unit; shifts) with the comparators and status bits under them, and the registers (source
 * multiplexer into the register, the enable's AND beside it). In a row every part sits left of the part it feeds, its output level with that input;
 * a select bus comes up from below. A net is a wire where it runs forward to a few sinks; the feedback (register outputs
 * back into the units, status bits back into the controller) and the clock are named, as on a real schematic.
 */
function fsmdDrawing(ports: PortDef[], b: Builder, rows: FsmdRow[]): Netlist {
  const insts = new Map(b.instances.map((i) => [i.name, i]));
  const geo = (n: string) => symbolGeom(insts.get(n)!.def);
  const nets = b.nets();
  const instOf = (end: string) => (end.includes('.') ? end.slice(0, end.indexOf('.')) : '');
  const portOf = (end: string) => end.slice(end.indexOf('.') + 1);
  const outPort = (n: string) => Object.entries(geo(n).ports).find(([p]) => insts.get(n)!.def.ports.find((q) => q.name === p)?.dir === 'out');
  // in local coordinates of its row: each part's top-left
  const local = new Map<string, [number, number]>();
  const box = (n: string) => { const [x, y] = local.get(n)!, g = geo(n); return { x, y, w: g.w, h: g.h }; };
  const hits = (n: string, names: string[]) => { const a = box(n); return names.some((m) => { if (m === n || !local.has(m)) return false; const c = box(m); return a.x < c.x + c.w + 1 && c.x < a.x + a.w + 1 && a.y < c.y + c.h + 1 && c.y < a.y + a.h + 1; }); };
  const layRow = (r: FsmdRow) => {
    const names = r.names;
    if (r.kind === 'ctl') { local.set('ctl', [0, 0]); if (insts.has('rst_n')) local.set('rst_n', [0, geo('ctl').h + 4]); return; }
    const anchor = names[names.length - 1];
    local.set(anchor, [0, 0]);
    for (const n of [...names].reverse().slice(1)) {
      const o = outPort(n);
      const net = o && nets.find((x) => x.ends[0] === `${n}.${o[0]}`);
      const sink = net?.ends.slice(1).find((e) => local.has(instOf(e)) && names.includes(instOf(e)));
      const g = geo(n);
      if (!o || !sink) { const lo = Math.max(...names.filter((m) => local.has(m)).map((m) => box(m).y + box(m).h)); local.set(n, [0, lo + 3]); continue; }
      const sb = box(instOf(sink)), sp = geo(instOf(sink)).ports[portOf(sink)];
      const px = sb.x + sp.pos[0], py = sb.y + sp.pos[1];
      // a select or enable from below: the part under its sink, its output a little left of the pin
      if (sp.exit === 'down') local.set(n, [px - g.w - 2, py + 3 - o[1].pos[1]]);
      else if (sp.exit === 'up') local.set(n, [px - g.w - 2, py - 3 - o[1].pos[1]]);
      else local.set(n, [px - g.w - 3, py - o[1].pos[1]]);
      // two parts feeding one sink side by side: the later one moves up or down, out of the way
      for (let k = 1; hits(n, names) && k < 40; k++) {
        const [x, y] = local.get(n)!;
        local.set(n, [x, y + (py < sb.y + sb.h / 2 ? -1 : 1)]);
      }
    }
  };
  rows.forEach(layRow);
  // the rows' extents, then the columns
  const extent = (r: FsmdRow) => {
    const bs = r.names.filter((n) => local.has(n)).map(box);
    const x0 = Math.min(...bs.map((q) => q.x)), y0 = Math.min(...bs.map((q) => q.y));
    return { x0, y0, w: Math.max(...bs.map((q) => q.x + q.w)) - x0, h: Math.max(...bs.map((q) => q.y + q.h)) - y0 };
  };
  // the comparators under the units: both are read back by name (status bits, register values), and a column fewer keeps the
  // drawing narrow enough that its pin names stay readable at fit
  const cols: FsmdRow['kind'][][] = [['ctl'], ['unit', 'test'], ['reg']];
  const at = new Map<string, [number, number]>();
  let x = 8;
  for (const kinds of cols) {
    const rs = kinds.flatMap((k) => rows.filter((r) => r.kind === k && r.names.length));
    if (!rs.length) continue;
    let y = 2, cw = 0;
    for (const r of rs) {
      const e = extent(r);
      for (const n of r.names) { const [lx, ly] = local.get(n)!; at.set(n, [x + lx - e.x0, y + ly - e.y0]); }
      y += e.h + 5;
      cw = Math.max(cw, e.w);
    }
    // the controller's outputs fan out to the whole datapath: a wider channel after it
    x += cw + (kinds[0] === 'ctl' ? 12 : 9);
  }
  const instances = b.instances.map((i) => ({ ...i, at: at.get(i.name) ?? i.at }));
  const pins: Record<string, [number, number]> = {};
  const posOf = (end: string): [number, number] => {
    const n = instOf(end);
    if (!n) return pins[end] ?? [0, 0];
    const p = geo(n).ports[portOf(end)].pos, a = at.get(n)!;
    return [a[0] + p[0], a[1] + p[1]];
  };
  // pins level with the first thing each feeds (inputs) or is fed by (outputs), in that order, two units apart at least
  const stackPins = (ps: PortDef[], px: number, want: (p: PortDef) => number) => {
    let y = 0;
    for (const p of [...ps].sort((a, c) => want(a) - want(c))) { const t = p.clock ? y : Math.max(y, Math.round(want(p))); pins[p.name] = [px, t]; y = t + 2; }
  };
  stackPins(ports.filter((p) => p.dir === 'in'), 0, (p) => {
    // the clock is named at every register: its pin need not reach down past the drawing
    if (p.clock) return Infinity;
    const net = nets.find((n) => n.ends[0] === p.name);
    return net ? Math.min(...net.ends.slice(1).map((e) => posOf(e)[1])) : 0;
  });
  stackPins(ports.filter((p) => p.dir === 'out'), x, (p) => {
    const net = nets.find((n) => n.ends.includes(p.name));
    return net ? posOf(net.ends[0])[1] : 0;
  });
  // a wire where the net runs forward to a few sinks; the clock and the feedback named
  const drawnNets: NetDef[] = nets.map((n) => {
    const d = posOf(n.ends[0])[0];
    const forward = n.name !== 'clk' && n.ends.length - 1 <= 4 && n.ends.slice(1).every((e) => posOf(e)[0] > d);
    const { tags: _t, ...rest } = n;
    return forward ? rest : { ...rest, tags: true as const };
  });
  return { pins, instances, nets: drawnNets };
}

/**
 * The top level of a datapath machine: the pins, the controller (its compiled chip `ctl`), the registers and their
 * source multiplexers, the operator units with their operand multiplexers, constants, shifts, the comparators and
 * the status bits back to the controller.
 */
export function fsmdTopDef(doc: FsmDoc, ctl: ComponentDef, plan = planOf(doc)): ComponentDef {
  const d = doc.data!, w = d.width;
  const b = new Builder(8, 12, 3);
  // the parts of each row as they are made (fsmdDrawing places them): the controller, a row per operator unit, per shift,
  // per register, per comparator or bit test
  const rows: FsmdRow[] = [];
  const row = (kind: FsmdRow['kind'], f: () => void) => { const n0 = b.instances.length; f(); rows.push({ kind, names: b.instances.slice(n0).map((i) => i.name) }); };
  const ins = [...doc.ins, ...d.ins, 'rst', 'clk'];
  b.pins(...ins);
  const consts = new Map<number, string>();
  const drive = (o: Operand): string => {
    if (o.kind !== 'k') return o.kind === 'reg' ? `r_${o.name}.q` : o.name;
    let c = consts.get(o.v);
    if (!c) consts.set(o.v, (c = b.name(b.op1(constWord(w, o.v), [], String(o.v)), `k${o.v}`)));
    return c;
  };
  // controller first: its status inputs come from the comparators further right (wired by name)
  const st = plan.tests.map((_, i) => `st${i}`);
  // ¬rst gates every register's load; its inverter is drawn in the first loaded register's row, beside that row's AND
  const nrst = 'rst_n.y';
  let nrstMade = false;
  row('ctl', () => b.add(ctl, 'controller', 'ctl'));
  // the controller's lines are named as its outputs are (ld_a, sel_a0, u0s0, done): what the wires carry
  for (const o of ctl.ports) if (o.dir === 'out') b.name(`ctl.${o.name}`, o.name);
  for (const x of doc.ins) b.wire(x, `ctl.${x}`);
  b.wire('rst', 'ctl.rst');
  b.wire('clk', 'ctl.clk');
  const ctlBus = (bits: number, prefix: string): string => {
    if (!bits) return '';
    if (bits === 1) return `ctl.${prefix}0`;
    return b.op1(merger(ones(bits)), Array.from({ length: bits }, (_, i) => `ctl.${prefix}${i}`));
  };
  b.next();
  // operator units, each with its operand multiplexers
  const mux = (srcs: string[], sel: string, label: string): string => {
    if (srcs.length === 1) return srcs[0];
    const k = bitsFor(srcs.length), padded = [...srcs, ...Array(2 ** k - srcs.length).fill(srcs[0])];
    return b.op1(muxTree(k, w), [...padded, sel], label);
  };
  const unitOut = new Map<string, string>();
  plan.units.forEach((u, k) => row('unit', () => {
    const sel = ctlBus(bitsFor(u.exprs.length), `u${k}s`);
    const A = mux(u.exprs.map((e) => drive(e.a)), sel, `${u.op} left`), B = mux(u.exprs.map((e) => drive(e.b)), sel, `${u.op} right`);
    const label = u.exprs.map(exprText).join(', ');
    const out = u.op === '+' ? `${b.op(rca(w), [A, B, b.op1(TIE0, [])], label, `op${k}`)}.s`
      : u.op === '-' ? `${b.op(addSub(w), [A, B, b.op1(TIE1, [])], label, `op${k}`)}.s`
        : b.op1(bitwise(u.op === '&' ? 'and' : u.op === '|' ? 'or' : 'xor', w), [A, B], label, `op${k}`);
    for (const key of u.keys) unitOut.set(key, out);
  }));
  const shifted = (e: Shift): string => {
    let out = '';
    row('unit', () => {
      const sp = b.op(splitter(ones(w)), [drive(e.a)]);
      const z = b.op1(TIE0, []);
      const bits = Array.from({ length: w }, (_, i) => { const j = e.op === '<<' ? i - e.k : i + e.k; return j >= 0 && j < w ? `${sp}.o${j}` : z; });
      out = b.op1(merger(ones(w)), bits, exprText(e));
    });
    return out;
  };
  const exprOut = (e: Expr): string => (isShift(e) ? shifted(e) : isBin(e) ? unitOut.get(exprKey(e))! : drive(e.a));
  b.next();
  // registers, their sources through a multiplexer
  // the shifts first: their parts go in the units' column, not in a register's row
  const shiftOut = new Map<string, string>();
  for (const r of d.regs) for (const e of plan.sources[r]) if (isShift(e) && !shiftOut.has(exprKey(e))) shiftOut.set(exprKey(e), shifted(e));
  const exprIn = (e: Expr): string => (isShift(e) ? shiftOut.get(exprKey(e))! : exprOut(e));
  for (const r of d.regs) row('reg', () => {
    const srcs = plan.sources[r];
    const dIn = srcs.length ? mux(srcs.map(exprIn), ctlBus(bitsFor(srcs.length), `sel_${r}`), `${r} from`) : `r_${r}.q`;
    // rst holds every register: a controller just out of power-on (one-hot: no state at all) loads nothing
    if (srcs.length && !nrstMade) { b.name(b.op1(NOT, ['rst'], '¬rst', 'rst_n'), 'rst_n'); nrstMade = true; }
    const en = srcs.length ? b.op1(AND, [`ctl.ld_${r}`, nrst], `ld_${r}·¬rst`) : b.op1(TIE0, []);
    b.op(register(w), [dIn, en, 'clk'], r, `r_${r}`);
    b.name(`r_${r}.q`, r);
  });
  b.next();
  // comparators and status bits
  const cmpOf = new Map<string, { inst: string; swap: boolean }>();
  plan.pairs.forEach(([x, y], i) => row('test', () => {
    const inst = b.op(magComparator(w, false), [drive(x), drive(y)], `${operandText(x)} vs ${operandText(y)}`, `cmp${i}`);
    cmpOf.set(`${opKey(x)}|${opKey(y)}`, { inst, swap: false });
    cmpOf.set(`${opKey(y)}|${opKey(x)}`, { inst, swap: true });
  }));
  b.next();
  plan.tests.forEach((t, i) => row('test', () => {
    let src: string, invert = false;
    if ('bit' in t) {
      const sp = b.op(splitter(ones(w)), [drive(t.bit)]);
      src = `${sp}.o${t.k}`;
    } else {
      const c = cmpOf.get(`${opKey(t.a)}|${opKey(t.b)}`)!;
      const lt = c.swap ? 'gt' : 'lt', gt = c.swap ? 'lt' : 'gt';
      const m: Record<Cmp, [string, boolean]> = { eq: ['eq', false], ne: ['eq', true], lt: [lt, false], ge: [lt, true], gt: [gt, false], le: [gt, true] };
      src = `${c.inst}.${m[t.cmp][0]}`;
      invert = m[t.cmp][1];
    }
    // the status bit goes straight to the controller; a test that is the comparator's output inverted gets an inverter st<i>
    // named as the controller's input it feeds, st<i>: the diagram's tests read the same
    b.wire(b.name(invert ? b.op1(NOT, [src], testText(t), `st${i}`) : src, st[i]), `ctl.${st[i]}`);
  }));
  b.next();
  for (const o of doc.outs) b.wire(`ctl.${o}`, o);
  for (const o of d.outs) b.wire(drive(d.regs.includes(o.src) ? { kind: 'reg', name: o.src } : { kind: 'in', name: o.src }), o.name);
  const outs = [...doc.outs, ...d.outs.map((o) => o.name)];
  const width = (p: string) => (d.ins.includes(p) || d.outs.some((o) => o.name === p) ? w : 1);
  return {
    id: 'fsmd', name: 'State machine with a datapath', category: 'sequential', summary: 'A controller and a datapath drawn from a state machine with registers.',
    ports: [...ins.map((p) => ({ name: p, width: width(p), dir: 'in' as const, ...(p === 'clk' ? { clock: true } : {}) })), ...outs.map((p) => ({ name: p, width: width(p), dir: 'out' as const }))],
    symbol: { kind: 'box', label: 'FSMD' },
    netlist(this: ComponentDef) { return fsmdDrawing(this.ports, b, rows); },
  };
}

// ---- the check: circuit against the reference ------------------------------------------------------------

/**
 * Run the built chip (a fresh simulation, power-on zero, one rst cycle) and the reference side by side for `cycles`
 * clock cycles of seeded random inputs (rst now and then); null, or the first difference.
 */
export function fsmdCheck(sim: Sim, doc: FsmDoc, cycles = 200, seed = 1): string | null {
  const d = doc.data!;
  let x = seed >>> 0 || 1;
  const r = () => ((x = (x * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const set = (inp: FsmdInputs) => {
    for (const n of doc.ins) sim.setInput(n, inp.bits[n] ?? 0);
    for (const n of d.ins) sim.setInput(n, inp.data[n] ?? 0);
    sim.setInput('rst', inp.rst ?? 0);
  };
  const outs = (): Record<string, number> => Object.fromEntries([...doc.outs, ...d.outs.map((o) => o.name)].map((n) => [n, pack(sim.getBits(sim.design.root.ports[n]))]));
  sim.reset('zero');
  let st: FsmdState = { s: doc.reset, regs: Object.fromEntries(d.regs.map((g) => [g, 0])) };
  // a reset cycle first: the controller to its reset state, the registers held at their power-on 0
  const first: FsmdInputs = { bits: {}, data: Object.fromEntries(d.ins.map((n) => [n, 0])), rst: 1 };
  for (let c = 0; c <= cycles; c++) {
    const inp: FsmdInputs = c === 0 ? first : {
      bits: Object.fromEntries(doc.ins.map((n) => [n, r() < 0.5 ? 1 : 0])),
      data: Object.fromEntries(d.ins.map((n) => [n, Math.floor(r() * 2 ** d.width)])), rst: r() < 0.03 ? 1 : 0,
    };
    set(inp);
    sim.setInput('clk', 0);
    sim.settle();
    const ref = fsmdStep(doc, st, inp);
    if (c > 0) {
      const got = outs();
      for (const [n, v] of Object.entries(ref.outs)) if (got[n] !== v) return `cycle ${c}, in ${doc.states[st.s].name}: ${n} is ${got[n]}, the machine says ${v}`;
    }
    sim.setInput('clk', 1);
    sim.settle();
    st = ref.next;
  }
  return null;
}

/** GCD by subtraction: the classic machine with a datapath (and New chip ▾ State machine + datapath's start). */
export const GCD_FSMD: FsmDoc = {
  ins: ['start'], outs: ['done'],
  states: [
    { name: 'IDLE', at: [90, 100], act: [{ reg: 'a', expr: 'x' }, { reg: 'b', expr: 'y' }] },
    { name: 'TEST', at: [260, 100] },
    { name: 'SUBA', at: [400, 230], act: [{ reg: 'a', expr: 'a - b' }] },
    { name: 'SUBB', at: [140, 230], act: [{ reg: 'b', expr: 'b - a' }] },
    { name: 'DONE', at: [430, 100], out: ['done'] },
  ],
  arcs: [
    { from: 0, to: 1, when: { start: 1 } },
    { from: 1, to: 4, when: {}, test: [{ expr: 'a = b', is: 1 }] },
    { from: 1, to: 3, when: {}, test: [{ expr: 'a < b', is: 1 }] },
    { from: 1, to: 2, when: {} },
    { from: 2, to: 1, when: {} }, { from: 3, to: 1, when: {} },
    { from: 4, to: 0, when: { start: 0 } },
  ],
  reset: 0, encoding: 'binary', form: 'nand',
  data: { width: 8, ins: ['x', 'y'], regs: ['a', 'b'], outs: [{ name: 'gcd', src: 'a' }] },
};
