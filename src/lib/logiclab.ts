// The logic chapter's models (DOM-free; chapters/ch-logic.ts, widgets/kmap.ts, widgets/logiclab.ts and tests/content-logic.test.ts
// share them): the sum of minterms and the minimal sum as NAND circuits, the algebra laws with their gate counts, a table's cost
// under the exact and the greedy cover, the seven-segment decoder, and the multiplexer that glitches.

import { Builder } from './builder';
import { evalBool, parseBool, type BoolEx } from './boolexpr';
import { andN } from './combinational';
import { define } from './define';
import { AND, MUX2, NOT, XOR } from './gates';
import { NAND3 } from './seqparts';
import { cover, covers, literals, primes, type Term } from './sop';
import { tableDef, tableLogic, termText, type TableLogic, type TableSpec } from './tablelogic';
import { NAND } from './transistors';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { logicDepth, stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';

/** The prime detector's ones: the 4-bit numbers 2, 3, 5, 7, 11, 13 (the campaign's g_sop, rv16/logic.ts PRIMES4). */
export const PRIME_ONES = [2, 3, 5, 7, 11, 13];
export const ABCD = ['a', 'b', 'c', 'd'];

/** A one-output table over `ins` from its ones and don't cares. */
export function tableOf(ins: string[], ones: number[], dc: number[] = [], out = 'y'): TableSpec {
  const n = ins.length;
  return { ins, outs: [out], rows: [Array.from({ length: 1 << n }, (_, r) => (ones.includes(r) ? '1' : dc.includes(r) ? '-' : '0')).join('')], form: 'nand' };
}

/** The ones and don't cares of a row string. */
export function onesDc(s: string): { ones: number[]; dc: number[] } {
  const ones: number[] = [], dc: number[] = [];
  for (let r = 0; r < s.length; r++) if (s[r] === '1') ones.push(r); else if (s[r] === '-') dc.push(r);
  return { ones, dc };
}

/** The sum of minterms as a logic: one term with every literal per 1. */
export const mintermLogic = (ones: number[]): TableLogic => ({
  outs: [{ kind: 'terms', uses: ones.map((_, i) => i) }], terms: ones.map((m): Term => ({ val: m, mask: 0 })), exact: true,
});

/** The cover of a one-output table: exact (lib/sop.ts, as the sandbox draws it) or the greedy one (essential primes, then the biggest). */
export function coverLogic(t: TableSpec, greedy = false): TableLogic {
  if (!greedy) return tableLogic(t);
  const n = t.ins.length, s = t.rows[0];
  const { ones, dc } = onesDc(s);
  if (!ones.length) return { outs: [{ kind: 'const', value: 0 }], terms: [], exact: true };
  if (ones.length + dc.length === s.length) return { outs: [{ kind: 'const', value: 1 }], terms: [], exact: true };
  const c = cover(n, ones, dc, 0);
  return { outs: [{ kind: 'terms', uses: c.terms.map((_, i) => i) }], terms: c.terms, exact: c.exact };
}

export interface SopCost { terms: number; literals: number; nands: number; depth: number | null; exact: boolean; text: string }

/** What a one-output logic costs drawn as NAND–NAND (the sandbox truth-table chip's drawing, lib/tablelogic.ts tableDef), and its equation. */
export function costOf(t: TableSpec, logic: TableLogic, id = 'logic_cost'): SopCost {
  const def = tableDef({ ...t, form: 'nand' }, id, logic);
  const o = logic.outs[0];
  const uses = o.kind === 'terms' ? o.uses : [];
  return {
    terms: uses.length, literals: uses.reduce((a, k) => a + literals(logic.terms[k], t.ins.length), 0), nands: stats(def).nands, depth: logicDepth(def), exact: logic.exact,
    text: o.kind === 'const' ? String(o.value) : uses.map((k) => termText(t, logic.terms[k])).join(' + '),
  };
}

/** The prime implicants of a one-output table (Quine–McCluskey, don't cares joined, a prime that covers no 1 dropped). */
export function primesOfRows(s: string): Term[] {
  const { ones, dc } = onesDc(s);
  return primes(ones, dc).filter((p) => ones.some((m) => covers(p, m)));
}

// ---- the sum of minterms, drawn with names --------------------------------------------------------------

/**
 * A function as the sum of its minterms in NAND–NAND: the same gates (and so the same count) lib/tablelogic.ts draws for a
 * logic with one all-literal term per 1, with the instances named: n<x> for the complements, m<row> for a minterm, or.
 */
export function mintermDef(ones: number[], id: string, name: string, ins = ABCD): ComponentDef {
  const n = ins.length;
  const b = new Builder(8, 10, 2);
  b.pins(...ins);
  const neg = ins.map((x) => b.name(b.op1(NOT, [x], `¬${x}`, `n${x}`), `${x}_n`, true));
  b.next();
  const and = (ds: string[], nm?: string): string => (ds.length === 1 ? ds[0] : b.op1(ds.length === 2 ? AND : andN(ds.length), ds, undefined, nm));
  // columns: the halves of every term, the term NANDs, the halves of the output's inputs, the output NAND
  const halves = (ds: string[], nm?: string): [string, string] => { const h = ds.length >> 1; return [and(ds.slice(0, h), nm && `${nm}l`), and(ds.slice(h), nm && `${nm}r`)]; };
  const hs = ones.map((m) => halves(ins.map((x, i) => ((m >> (n - 1 - i)) & 1 ? x : neg[i])), `m${m}`));
  b.next();
  const terms = ones.map((m, k) => b.op1(NAND, hs[k], `¬m${m}`, `m${m}`));
  b.next();
  const oh = halves(terms);
  b.next();
  const y = b.op1(NAND, oh, 'y', 'or');
  b.next();
  b.wire(y, 'y');
  const R = Math.max(b.right, 30);
  return define({
    id, name, category: 'gate',
    summary: `y = 1 for ${ones.join(', ')}: one AND per 1 of the truth table, ORed (NAND–NAND).`,
    ports: [...ins.map((p) => ({ name: p, width: 1, dir: 'in' as const })), { name: 'y', width: 1, dir: 'out' as const }],
    symbol: { kind: 'box', label: 'Σ m' },
    spec: (v) => [ones.includes(v.reduce((acc, bit) => (acc << 1) | bit, 0)) ? 1 : 0],
    netlist: () => ({
      pins: Object.fromEntries([...ins.map((p, i) => [p, [0, 2 + 4 * i]]), ['y', [R, 6]]]),
      instances: b.instances, nets: b.nets(),
    }),
  });
}
let primeMinterms: ComponentDef | undefined;
/** The prime detector as the sum of its six minterms (the chapter's first step). */
export const PRIME_MINTERMS = (): ComponentDef => (primeMinterms ??= mintermDef(PRIME_ONES, 'logic_prime_minterms', 'Prime detector (sum of minterms)'));

// ---- algebra ------------------------------------------------------------------------------------------

/** NAND counts of an expression drawn gate by gate from the previous chapter's boxes: NOT 1, AND 2, OR 3, XOR 4, a NOT of an AND one NAND. */
export function gateNands(e: BoolEx): number {
  switch (e.k) {
    case 'v': case 'c': return 0;
    case 'not': return e.a.k === 'and' ? 1 + gateNands(e.a.a) + gateNands(e.a.b) : 1 + gateNands(e.a);
    case 'and': return 2 + gateNands(e.a) + gateNands(e.b);
    case 'or': return 3 + gateNands(e.a) + gateNands(e.b);
    default: return 4 + gateNands(e.a) + gateNands(e.b);
  }
}

export interface Law {
  id: string;
  name: string;
  /** Expressions over `vars` (lib/boolexpr.ts syntax). */
  before: string;
  after: string;
  vars: string[];
  /** The after circuit is this library part (the mux's NAND–NAND, the XOR box), not the expression's gates one by one. */
  afterPart?: ComponentDef;
  note: string;
}

export const LAWS: Law[] = [
  { id: 'absorb', name: 'Absorption', before: 'a + a·b', after: 'a', vars: ['a', 'b'], note: 'if a is 1 the OR is 1 whatever b is; if a is 0 the AND is 0 and the OR is 0. b never matters.' },
  { id: 'absorb2', name: 'Absorption, second form', before: 'a + ¬a·b', after: 'a + b', vars: ['a', 'b'], note: 'where a is 1 the OR is 1; where a is 0 the term is b. The ¬a only said "when a is 0", which the OR already knows.' },
  { id: 'combine', name: 'Combining', before: 'a·b + a·¬b', after: 'a', vars: ['a', 'b'], note: 'x·y + x·¬y = x: two terms that differ in one variable merge, and that variable drops out. This is the step a Karnaugh map does by eye.' },
  { id: 'demorgan', name: 'De Morgan', before: '¬a + ¬b', after: '¬(a·b)', vars: ['a', 'b'], note: '"Not both" is "at least one is false": a NAND is an OR of inverted inputs.' },
  { id: 'consensus', name: 'Consensus', before: 's·b + ¬s·a + a·b', after: 's·b + ¬s·a', vars: ['s', 'a', 'b'], note: 'a·b is 1 only where s·b or ¬s·a already is (s is 1 or 0, and either term catches it): the third term adds nothing to the function.' },
  { id: 'mux', name: 'AND–OR into NAND–NAND', before: 's·b + ¬s·a', after: '¬(¬(s·b)·¬(¬s·a))', vars: ['s', 'a', 'b'], afterPart: MUX2, note: 'De Morgan twice: the inverters between the two levels cancel, and each AND is a NAND. The previous chapter\'s multiplexer.' },
  { id: 'xor', name: 'A sum of two products that has a gate of its own', before: 'a·¬b + ¬a·b', after: 'a ⊕ b', vars: ['a', 'b'], afterPart: XOR, note: 'the same function, built in the previous chapter as four NANDs, one of them shared by both halves.' },
];

export interface LawRow { law: Law; before: number; after: number; same: boolean }

/** Do two expressions agree on every row? true, false, or the parser's complaint. */
export function sameFunction(a: string, b: string, vars: string[]): boolean | string {
  const pa = parseBool(a, vars), pb = parseBool(b, vars);
  if ('error' in pa) return pa.error;
  if ('error' in pb) return pb.error;
  for (let x = 0; x < 1 << vars.length; x++) if (evalBool(pa.ex, x, vars.length) !== evalBool(pb.ex, x, vars.length)) return false;
  return true;
}

/** An expression's gate cost, or the parser's complaint. */
export function exprCost(src: string, vars: string[]): number | string {
  const p = parseBool(src, vars);
  return 'error' in p ? p.error : gateNands(p.ex);
}

export function lawRow(l: Law): LawRow {
  return {
    law: l, before: exprCost(l.before, l.vars) as number, same: sameFunction(l.before, l.after, l.vars) === true,
    after: l.afterPart ? stats(l.afterPart).nands : (exprCost(l.after, l.vars) as number),
  };
}

// ---- the seven-segment decoder ---------------------------------------------------------------------------

export const SEGMENTS = ['a', 'b', 'c', 'd', 'e', 'f', 'g'] as const;
/** The lit segments of the digits 0–9 (6 with its top bar, 7 without f, 9 with its bottom bar). */
export const FONT: string[] = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg'];
export const SEG_INS = ['w', 'x', 'y', 'z'];

/** Segment si's column for the digits 0–9. */
export const fontRows = (si: number): string => FONT.map((g) => (g.includes(SEGMENTS[si]) ? '1' : '0')).join('');

/** One segment over a BCD digit w x y z, rows 10–15 given (six cells of 0 / 1 / -). */
export const segmentTable = (si: number, fill: string): TableSpec => ({ ins: SEG_INS, outs: [`seg_${SEGMENTS[si]}`], form: 'nand', rows: [fontRows(si) + fill] });

/** The seven segments' rows given the six unused cells of each (a string of six per segment). */
export const sevenSegRows = (fill: string[]): string[] => SEGMENTS.map((_, si) => fontRows(si) + fill[si]);

/** The seven segments' cost as NAND–NAND with equal terms shared between segments, and each segment's equation. */
export function sevenSegCost(rows: string[]): { nands: number; terms: number; literals: number; text: string[] } {
  const t: TableSpec = { ins: SEG_INS, outs: SEGMENTS.map((s) => `seg_${s}`), rows, form: 'nand' };
  const logic = tableLogic(t);
  return {
    nands: stats(tableDef(t, 'logic_seg7_cost', logic)).nands, terms: logic.terms.length, literals: logic.terms.reduce((a, p) => a + literals(p, 4), 0),
    text: logic.outs.map((o, j) => `${t.outs[j]} = ${o.kind === 'const' ? o.value : o.uses.map((k) => termText(t, logic.terms[k])).join(' + ')}`),
  };
}

/** Do the first ten cells of every segment spell the font? */
export const fontIntact = (rows: string[]): boolean => rows.every((r, si) => r.slice(0, 10) === fontRows(si));

// ---- the multiplexer that glitches -------------------------------------------------------------------------

/**
 * y = s ? b : a as the sum of two products (ns = ¬s, sb = ¬(s·b), nsa = ¬(¬s·a), a NAND at the output), plus a third term a·b
 * behind `cons`: with cons = 0 that term's NAND reads 1 and y is the plain multiplexer, which dips for one gate delay when s
 * falls with a = b = 1; with cons = 1 the consensus term holds y at 1 through the hand-over. The output NAND has three inputs
 * (lib/seqparts.ts NAND3, three 2-input NANDs here as everywhere on the site).
 */
export const MUX_HAZARD: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('a', 'b', 's', 'cons');
  const ns = b.name(b.op1(NAND, ['s', 's'], '¬s', 'ns'), 'ns', true);
  const sb = b.op1(NAND, ['s', 'b'], '¬(s·b)', 'sb');
  b.next();
  const nsa = b.op1(NAND, [ns, 'a'], '¬(¬s·a)', 'nsa');
  const ab = b.op1(NAND3, ['a', 'b', 'cons'], '¬(a·b·cons)', 'ab');
  b.next();
  const y = b.op1(NAND3, [sb, nsa, ab], 'y', 'out');
  b.next();
  b.wire(y, 'y');
  const R = b.right;
  return define({
    id: 'logic_mux_hazard', name: 'Multiplexer with a switchable consensus term', category: 'routing',
    summary: 'y = s ? b : a as s·b + ¬s·a, plus the consensus term a·b when cons = 1. With cons = 0, y dips for one gate delay when s falls with a = b = 1.',
    ports: [
      { name: 'a', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' }, { name: 's', width: 1, dir: 'in' }, { name: 'cons', width: 1, dir: 'in' },
      { name: 'y', width: 1, dir: 'out' },
    ],
    symbol: { kind: 'box', label: 'MUX' },
    spec: ([a, bb, s]) => [s ? bb : a],
    netlist: () => ({ pins: { a: [0, 2], b: [0, 6], s: [0, 10], cons: [0, 14], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The multiplexer with the consensus term built in (a·b a third input of the output NAND), for its cost. */
export const MUX_CONSENSUS: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('a', 'b', 's');
  const ns = b.name(b.op1(NAND, ['s', 's'], '¬s', 'ns'), 'ns', true);
  const sb = b.op1(NAND, ['s', 'b'], '¬(s·b)', 'sb');
  b.next();
  const nsa = b.op1(NAND, [ns, 'a'], '¬(¬s·a)', 'nsa');
  const ab = b.op1(NAND, ['a', 'b'], '¬(a·b)', 'ab');
  b.next();
  const y = b.op1(NAND3, [sb, nsa, ab], 'y', 'out');
  b.next();
  b.wire(y, 'y');
  const R = b.right;
  return define({
    id: 'logic_mux_consensus', name: 'Multiplexer with its consensus term', category: 'routing',
    summary: 'y = s·b + ¬s·a + a·b: the multiplexer that cannot glitch on a = b = 1.',
    ports: [{ name: 'a', width: 1, dir: 'in' }, { name: 'b', width: 1, dir: 'in' }, { name: 's', width: 1, dir: 'in' }, { name: 'y', width: 1, dir: 'out' }],
    symbol: { kind: 'box', label: 'MUX' },
    spec: ([a, bb, s]) => [s ? bb : a],
    netlist: () => ({ pins: { a: [0, 2], b: [0, 6], s: [0, 10], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

export interface Edge { t: number; v: number }
export interface MuxRun { y0: number; edges: Edge[]; settled: number }

/**
 * y of the glitching multiplexer over an input change on GateSim with the unit delay (transport delay, every change kept): a, b
 * and cons settle first, then s changes from `from` to `to`. y before, every change of y with the time since s changed, y after.
 */
export function muxRun(inputs: { a: number; b: number; cons: number }, from: number, to: number): MuxRun {
  const sim = new GateSim(flatten(MUX_HAZARD));
  const y = sim.design.root.ports.y;
  sim.setInput('a', inputs.a);
  sim.setInput('b', inputs.b);
  sim.setInput('cons', inputs.cons);
  sim.setInput('s', from);
  sim.settle();
  const y0 = sim.get(y[0]);
  sim.watch(y);
  const edges: Edge[] = [];
  const t0 = sim.time;
  sim.onTrace = (_net, v, t) => { edges.push({ t: t - t0, v }); };
  sim.setInput('s', to);
  sim.settle();
  return { y0, edges, settled: sim.get(y[0]) };
}

/** How long (gate delays) y sits away from the value it starts and ends at: 0 when it never leaves it. */
export function dipWidth(r: MuxRun): number {
  let w = 0, since: number | null = null, level = r.y0;
  for (const e of r.edges) {
    if (e.v === level) continue;
    if (level !== r.settled && since !== null) w += e.t - since;
    level = e.v;
    since = e.t;
  }
  return w;
}
