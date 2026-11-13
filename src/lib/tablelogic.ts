// A truth table as logic (DOM-free, no editor imports): each output minimized to a sum of products (lib/sop.ts, don't cares
// used, exact while the search stays small), equal terms shared between outputs, and the NAND–NAND (or AND–OR, PLA) circuit
// built from it. The sandbox's truth-table chips (editor/ttable.ts re-exports this) and the logic chapter (widgets/kmap.ts,
// chapters/ch-logic.ts) share it, so the numbers the chapter quotes are the ones the sandbox draws.

import { Builder } from './builder';
import { andN } from './combinational';
import { AND, NOT, OR } from './gates';
import { NAND3 } from './seqparts';
import { cover, type Term } from './sop';
import { LiteralRails } from './rails';
import { NAND, TIE0, TIE1 } from './transistors';
import { orN } from './wide';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, Netlist } from '../sim/types';

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
  const negInst = new Map<number, string>();
  for (let i = 0; i < n; i++) if (needNeg.has(i)) { neg.set(i, b.name(b.op1(NOT, [t.ins[i]], `¬${t.ins[i]}`), `${t.ins[i]}_n`, true)); negInst.set(i, neg.get(i)!.slice(0, neg.get(i)!.indexOf('.'))); }
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
  let laid: Netlist | undefined;
  const R = Math.max(b.right, 30), pitch = 4;
  return {
    id, name: 'Truth table', category: 'gate',
    summary: 'Drawn from a truth table: each output minimized to a sum of products.',
    ports: [...t.ins.map((p) => ({ name: p, width: 1, dir: 'in' as const })), ...t.outs.map((p) => ({ name: p, width: 1, dir: 'out' as const }))],
    symbol: { kind: 'box', label: 'TT' },
    // a small table keeps the Builder's columns (input pointers beside the pins read well there); past LABELLED_TERMS terms, where
    // that drawing turned to labels and a knot, the PLA drawing
    netlist: () => (logic.terms.length > LABELLED_TERMS ? (laid ??= railLayout(t, b, negInst)) : {
      pins: Object.fromEntries([...t.ins.map((p, i) => [p, [0, 2 + pitch * i]]), ...t.outs.map((p, j) => [p, [R, 2 + pitch * j]])]),
      instances: b.instances, nets: b.nets(),
    }),
  };
}

/**
 * The Builder's gates and nets (never changed) laid out as a PLA: the input pins and inverters on top, their true and complement
 * rails running down (lib/rails.ts), the first level of gates one per row tapping the rails, each later level beside the rows it
 * reads, every connection between levels a vertical trunk in a lane of its own. All wires: no pointers. Pins keep port order.
 */
function railLayout(t: TableSpec, b: Builder, negInst: Map<number, string>): Netlist {
  const n = t.ins.length;
  const rails = new LiteralRails(t.ins.map((x, i) => ({ src: x, y: 3 + 2 * i, name: x, not: negInst.get(i) })), 4, 4 + 2 * n);
  const railNots = new Set(negInst.values());
  const gates = b.instances.filter((g) => !railNots.has(g.name));
  const nets: NetDef[] = b.nets().map(({ tags: _t, ...rest }) => rest);
  const endInst = (e: string) => (e.includes('.') ? e.slice(0, e.indexOf('.')) : null);
  const level = new Map<string, number>();
  for (const g of gates) {
    let lv = 1;
    for (const nt of nets) for (const e of nt.ends.slice(1)) if (endInst(e) === g.name) {
      const d = endInst(nt.ends[0]);
      if (d && level.has(d)) lv = Math.max(lv, level.get(d)! + 1);
    }
    level.set(g.name, lv);
  }
  const top = Math.max(1, ...level.values());
  const geom = new Map(gates.map((g) => [g.name, symbolGeom(g.def)]));
  const at = new Map<string, [number, number]>();
  const y0 = 4 + 2 * n + 5;
  const byLevel = (lv: number) => gates.filter((g) => level.get(g.name) === lv);
  const outPortY = (g: string, port: string) => geom.get(g)!.ports[port].pos[1];
  const portOf = (e: string) => e.slice(e.indexOf('.') + 1);
  // rows: level 1 in build order, a later level at the middle of the gates it reads, pushed down past its neighbours
  for (let lv = 1; lv <= top; lv++) {
    const col = byLevel(lv);
    const want = col.map((g) => {
      const c: number[] = [];
      for (const nt of nets) {
        const d = endInst(nt.ends[0]);
        if (d && at.has(d) && nt.ends.slice(1).some((e) => endInst(e) === g.name)) c.push(at.get(d)![1] + outPortY(d, portOf(nt.ends[0])));
      }
      return c.length ? c.reduce((s, v) => s + v, 0) / c.length - geom.get(g.name)!.h / 2 : y0;
    });
    const order = col.map((_, i) => i).sort((a, c) => lv === 1 ? a - c : want[a] - want[c] || a - c);
    let floor = y0;
    for (const i of order) {
      const y = lv === 1 ? floor : Math.max(floor, Math.round(want[i]));
      at.set(col[i].name, [0, y]);
      floor = y + geom.get(col[i].name)!.h + 1;
    }
  }
  // output pins, in port order, level with the gate that drives them when they can be
  const pinY = new Map<string, number>();
  let prev = 1;
  t.outs.forEach((o) => {
    const nt = nets.find((x) => x.ends.slice(1).includes(o));
    const d = nt && endInst(nt.ends[0]);
    const want = d && at.has(d) ? at.get(d)![1] + outPortY(d, portOf(nt!.ends[0])) : prev + 2;
    prev = Math.max(prev + 2, want);
    pinY.set(o, prev);
  });
  // columns and lanes: a net leaving a gate (or the last level, toward the output pins) takes a lane in the gap after its level
  const sinkY = (e: string): number => {
    const i = endInst(e);
    return i ? at.get(i)![1] + (geom.get(i)!.ports[portOf(e)]?.pos[1] ?? 0) : pinY.get(e)!;
  };
  const colX: number[] = [];
  let x = rails.right + 4;
  const trunk = new Map<NetDef, number>();
  for (let lv = 1; lv <= top; lv++) {
    colX[lv] = x;
    const w = Math.max(4, ...byLevel(lv).map((g) => geom.get(g.name)!.w));
    const mine = nets.filter((nt) => { const d = endInst(nt.ends[0]); return d !== null && level.get(d) === lv; });
    const bent = mine.filter((nt) => { const dy = at.get(endInst(nt.ends[0])!)![1] + outPortY(endInst(nt.ends[0])!, portOf(nt.ends[0])); return nt.ends.slice(1).some((e) => sinkY(e) !== dy); });
    const keyOf = (nt: NetDef) => {
      const d = endInst(nt.ends[0])!, dy = at.get(d)![1] + outPortY(d, portOf(nt.ends[0]));
      const m = nt.ends.slice(1).reduce((s, e) => s + sinkY(e), 0) / (nt.ends.length - 1);
      return m > dy ? -dy : dy; // going down: the lower driver further left; going up: the higher one
    };
    const lane = new Map<NetDef, number>();
    let count = 0;
    if (bent.length <= 14) [...bent].sort((a, c) => keyOf(a) - keyOf(c)).forEach((nt, i) => { lane.set(nt, i); count = i + 1; });
    else {
      const span = (nt: NetDef) => { const d = endInst(nt.ends[0])!, dy = at.get(d)![1] + outPortY(d, portOf(nt.ends[0])); const ys = nt.ends.slice(1).map(sinkY).concat(dy); return [Math.min(...ys), Math.max(...ys)]; };
      const ends: number[] = [];
      for (const nt of [...bent].sort((a, c) => span(a)[0] - span(c)[0])) {
        const [lo, hi] = span(nt);
        let l = ends.findIndex((e) => e < lo - 0.5);
        if (l < 0) l = ends.length;
        ends[l] = hi; lane.set(nt, l); count = ends.length;
      }
    }
    for (const [nt, l] of lane) trunk.set(nt, x + w + 2 + 2 * l);
    x += w + 2 * count + 4;
  }
  const R = x + 2;
  const instances: InstanceDef[] = [
    ...rails.instances.map((i) => ({ ...b.instances.find((g) => g.name === i.name)!, at: i.at })),
    ...gates.map((g) => ({ ...g, at: [colX[level.get(g.name)!], at.get(g.name)![1]] as [number, number] })),
  ];
  const out: NetDef[] = nets.map((nt) => {
    const d = nt.ends[0];
    const inIdx = t.ins.indexOf(d);
    const nIdx = [...negInst].find(([, nm]) => d === `${nm}.y`)?.[0];
    if (inIdx >= 0) return { ...nt, trunk: rails.x(inIdx, 1) };
    if (nIdx !== undefined) return { ...nt, trunk: rails.x(nIdx, 0) };
    const tr = trunk.get(nt);
    return tr === undefined ? nt : { ...nt, trunk: tr };
  });
  return {
    pins: Object.fromEntries([...t.ins.map((p, i) => [p, [0, 3 + 2 * i]]), ...t.outs.map((p) => [p, [R, pinY.get(p)!]])]),
    instances, nets: out,
  };
}

function chunks<T>(xs: T[], k: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += k) out.push(xs.slice(i, i + k));
  return out;
}
