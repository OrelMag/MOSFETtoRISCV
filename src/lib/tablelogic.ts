// A truth table as logic (DOM-free, no editor imports): each output minimized to a sum of products (lib/sop.ts, don't cares
// used, exact while the search stays small), equal terms shared between outputs, and the NAND–NAND (or AND–OR, PLA) circuit
// built from it. The sandbox's truth-table chips (editor/ttable.ts re-exports this) and the logic chapter (widgets/kmap.ts,
// chapters/ch-logic.ts) share it, so the numbers the chapter quotes are the ones the sandbox draws.

import { Builder } from './builder';
import { andN } from './combinational';
import { AND, NOT, OR } from './gates';
import { NAND3 } from './seqparts';
import { cover, type Term } from './sop';
import { NAND, TIE0, TIE1 } from './transistors';
import { orN } from './wide';
import type { ComponentDef } from '../sim/types';

/** What a table is, to the logic: named one-bit inputs and outputs, a row string of 0 / 1 / - per output (the first input most significant), a form. */
export interface TableSpec {
  ins: string[];
  outs: string[];
  rows: string[];
  form: 'nand' | 'andor' | 'pla' | 'rom';
}

/** Past this many terms the drawing joins terms to outputs by labels. */
const LABELLED_TERMS = 8;

export const rowCount = (t: TableSpec): number => 1 << t.ins.length;

/** Bit of input i (0 = the first, most significant) in row r. */
export const inBit = (t: TableSpec, r: number, i: number): number => (r >> (t.ins.length - 1 - i)) & 1;

/** Rows where output j is 1, and where it is a don't-care. */
export function onDc(t: TableSpec, j: number): { ones: number[]; dc: number[] } {
  const ones: number[] = [], dc: number[] = [];
  const s = t.rows[j];
  for (let r = 0; r < s.length; r++) if (s[r] === '1') ones.push(r); else if (s[r] === '-') dc.push(r);
  return { ones, dc };
}

export interface TableLogic {
  /** Per output: its terms (indices into `terms`), or a constant. */
  outs: ({ kind: 'terms'; uses: number[] } | { kind: 'const'; value: 0 | 1 })[];
  terms: Term[];
  /** Every cover is a proven minimum. */
  exact: boolean;
}

/** The minimized logic of every output, equal terms shared. */
export function tableLogic(t: TableSpec): TableLogic {
  const n = t.ins.length, all = rowCount(t);
  const terms: Term[] = [];
  let exact = true;
  const outs = t.outs.map((_, j): TableLogic['outs'][number] => {
    const { ones, dc } = onDc(t, j);
    if (!ones.length) return { kind: 'const', value: 0 };
    if (ones.length + dc.length === all) return { kind: 'const', value: 1 };
    const c = cover(n, ones, dc);
    exact &&= c.exact;
    return {
      kind: 'terms',
      uses: c.terms.map((p) => {
        const k = terms.findIndex((u) => u.val === p.val && u.mask === p.mask);
        return k >= 0 ? k : terms.push(p) - 1;
      }),
    };
  });
  return { outs, terms, exact };
}

/** A term as text over the inputs: a·¬b·c ('1' for the empty product). */
export function termText(t: TableSpec, p: Term): string {
  const n = t.ins.length;
  const lits = t.ins.flatMap((v, i) => {
    const bit = 1 << (n - 1 - i);
    return p.mask & bit ? [] : [p.val & bit ? v : `¬${v}`];
  });
  return lits.length ? lits.join('·') : '1';
}

/** Output j's minimized equation, e.g. "y = a·b + ¬c". */
export function equation(t: TableSpec, j: number, logic = tableLogic(t)): string {
  const o = logic.outs[j];
  const rhs = o.kind === 'const' ? String(o.value) : o.uses.map((k) => termText(t, logic.terms[k])).join(' + ');
  return `${t.outs[j]} = ${rhs}`;
}


// ---- the circuit ----------------------------------------------------------------------------------------

/** The table's logic as a component: inputs left, inverters, the term gates, the output gates. */
export function tableDef(t: TableSpec, id = 'tt', logic = tableLogic(t)): ComponentDef {
  const n = t.ins.length;
  const b = new Builder(8, 10, 2);
  b.pins(...t.ins);
  const nand = t.form === 'nand', pla = t.form === 'pla';
  // Inputs whose complement a term reads (NAND–NAND also reads the complement of a one-literal term: its NOT).
  const needNeg = new Set<number>();
  const litsOf = (p: Term) => t.ins.flatMap((_, i) => (p.mask & (1 << (n - 1 - i)) ? [] : [{ i, pos: !!(p.val & (1 << (n - 1 - i))) }]));
  for (const o of logic.outs) {
    if (o.kind !== 'terms') continue;
    for (const k of o.uses) {
      const ls = litsOf(logic.terms[k]);
      // a one-literal term inside a NAND–NAND sum is read inverted: the other rail
      if (nand && o.uses.length > 1 && ls.length === 1) { if (ls[0].pos) needNeg.add(ls[0].i); }
      else for (const l of ls) if (!l.pos) needNeg.add(l.i);
    }
  }
  const neg = new Map<number, string>();
  // a PLA brings both rails of every input across its AND plane, used or not
  if (pla) for (let i = 0; i < n; i++) needNeg.add(i);
  for (let i = 0; i < n; i++) if (needNeg.has(i)) neg.set(i, b.name(b.op1(NOT, [t.ins[i]], `¬${t.ins[i]}`), `${t.ins[i]}_n`, true));
  b.next();
  const rail = (i: number, pos: boolean) => (pos ? t.ins[i] : neg.get(i)!);

  const andOf = (ds: string[], label?: string): string =>
    ds.length === 0 ? b.op1(TIE1, []) : ds.length === 1 ? ds[0] : ds.length === 2 ? b.op1(AND, ds, label)
      : ds.length <= 8 ? b.op1(andN(ds.length), ds, label) : andOf(chunks(ds, 8).map((c) => andOf(c)), label);
  const orOf = (ds: string[], label?: string): string =>
    ds.length === 0 ? b.op1(TIE0, []) : ds.length === 1 ? ds[0] : ds.length === 2 ? b.op1(OR, ds, label)
      : ds.length <= 4 ? b.op1(orN(ds.length), ds, label) : orOf(chunks(ds, 4).map((c) => orOf(c)), label);
  const nandOf = (ds: string[], label?: string): string =>
    ds.length === 1 ? b.op1(NOT, ds, label) : ds.length === 2 ? b.op1(NAND, ds, label) : ds.length === 3 ? b.op1(NAND3, ds, label)
      : b.op1(NAND, [andOf(ds.slice(0, ds.length >> 1)), andOf(ds.slice(ds.length >> 1))], label);

  // Terms: each built once per polarity it is needed in (a lone term is the AND itself; a sum reads NANDs).
  const pos = new Map<number, string>(), inv = new Map<number, string>();
  const termPos = (k: number) => {
    let d = pos.get(k);
    if (!d) pos.set(k, (d = andOf(litsOf(logic.terms[k]).map((l) => rail(l.i, l.pos)), termText(t, logic.terms[k]))));
    return d;
  };
  const termInv = (k: number) => {
    let d = inv.get(k);
    if (d) return d;
    const ls = litsOf(logic.terms[k]);
    d = ls.length === 1 ? rail(ls[0].i, !ls[0].pos) : nandOf(ls.map((l) => rail(l.i, l.pos)), `¬(${termText(t, logic.terms[k])})`);
    inv.set(k, d);
    return d;
  };
  const sums = logic.outs.map((o) => (o.kind === 'terms' && (o.uses.length === 1 || !nand) ? o.uses.map(termPos) : null));
  const invs = logic.outs.map((o) => (o.kind === 'terms' && o.uses.length > 1 && nand ? o.uses.map(termInv) : null));
  // Many terms: each term's result goes to its output gate as a pair of labels, not a wire across the sheet (the
  // router would take seconds to untangle dozens of wires converging on one gate).
  if (logic.terms.length > LABELLED_TERMS) {
    let k = 0;
    for (const d of new Set([...pos.values(), ...inv.values()])) if (d.includes('.')) b.name(d, `t${k++}`, true);
  }
  b.next();
  const drivers = logic.outs.map((o, j) => {
    if (o.kind === 'const') return b.op1(o.value ? TIE1 : TIE0, []);
    if (invs[j]) return nandOf(invs[j]!, t.outs[j]);
    return orOf(sums[j]!, t.outs[j]);
  });
  b.next();
  drivers.forEach((d, j) => b.wire(d, t.outs[j]));
  const R = Math.max(b.right, 30);
  const pitch = 4;
  return {
    id, name: 'Truth table', category: 'gate',
    summary: 'Drawn from a truth table: each output minimized to a sum of products.',
    ports: [...t.ins.map((p) => ({ name: p, width: 1, dir: 'in' as const })), ...t.outs.map((p) => ({ name: p, width: 1, dir: 'out' as const }))],
    symbol: { kind: 'box', label: 'TT' },
    netlist: () => ({
      pins: Object.fromEntries([...t.ins.map((p, i) => [p, [0, 2 + pitch * i]]), ...t.outs.map((p, j) => [p, [R, 2 + pitch * j]])]),
      instances: b.instances, nets: b.nets(),
    }),
  };
}

function chunks<T>(xs: T[], k: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += k) out.push(xs.slice(i, i + k));
  return out;
}
