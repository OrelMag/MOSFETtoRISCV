// State-machine chips (DOM-free): a chip drawn from a state diagram. The machine (ChipDoc.fsm) is encoded (binary,
// Gray or one-hot; the reset state gets the code power-on zero gives where it can), its next-state function and its
// outputs become two truth tables (ttable.ts: minimized, unused codes as don't cares or sent to reset), and the chip
// places them as chips of their own (<id>_next, <id>_out, generated: TableDoc.of) around the state flip-flops, with
// a synchronous reset (rst) and the clock. Opening a block shows its table and Karnaugh map; the machine's spec
// (specOf) draws the diagram and reads the built circuit back (sim/fsmread.ts readFsm) to check it.

import { AND, NOT, OR } from '../lib/gates';
import type { FsmArc, FsmInputs, FsmSpec } from '../lib/fsm';
import { DFF } from '../lib/sequential';
import { Builder } from '../lib/builder';
import { stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { compileChip } from './compile';
import { docFromDef } from './fromdef';
import { type ChipDoc, emptyChip, type FsmDoc, isIdent, type TableDoc, uniqueName, type Workspace } from './model';
import { partDef } from './parts';
import { openChip } from './session';
import { drawTable, tableCost, tableProblem } from './ttable';

export const FSM_MAX_STATES = 16;
export const FSM_MAX_IN = 6;
export const FSM_MAX_OUT = 8;
export type Encoding = FsmDoc['encoding'];
export const ENCODINGS: Encoding[] = ['binary', 'gray', 'onehot'];

/** The "101" detector (chapter 9's): y = 1 on the x that completes 1, 0, 1. */
export const FSM_TEMPLATE: FsmDoc = {
  ins: ['x'], outs: ['y'],
  states: [{ name: 'S0', at: [90, 100] }, { name: 'S1', at: [220, 100] }, { name: 'S2', at: [350, 100] }],
  arcs: [
    { from: 0, to: 0, when: { x: 0 } }, { from: 0, to: 1, when: { x: 1 } },
    { from: 1, to: 1, when: { x: 1 } }, { from: 1, to: 2, when: { x: 0 } },
    { from: 2, to: 1, when: { x: 1 }, out: ['y'] }, { from: 2, to: 0, when: { x: 0 } },
  ],
  reset: 0, encoding: 'binary', form: 'nand',
};

// ---- the machine as data ------------------------------------------------------------------------------

/** The first arc out of state s that the inputs (values in doc.ins order) take, or −1 (the state stays). */
export function arcOf(doc: FsmDoc, s: number, inp: number[]): number {
  return doc.arcs.findIndex((a) => a.from === s && doc.ins.every((x, i) => a.when[x] === undefined || a.when[x] === inp[i]));
}

/** State bits: one per state (one-hot), else enough to count them (at least one). */
export const stateBits = (n: number, enc: Encoding): number => (enc === 'onehot' ? n : Math.max(1, Math.ceil(Math.log2(n))));

/** Each state's code: the reset state first (code 0, or bit 0 one-hot), the others in order. */
export function codesOf(doc: FsmDoc, enc: Encoding = doc.encoding): number[] {
  const order = [doc.reset, ...doc.states.map((_, i) => i).filter((i) => i !== doc.reset)];
  const codes = new Array<number>(doc.states.length);
  order.forEach((s, k) => { codes[s] = enc === 'onehot' ? 1 << k : enc === 'gray' ? k ^ (k >> 1) : k; });
  return codes;
}

const isMealy = (doc: FsmDoc) => doc.arcs.some((a) => a.out?.length);
const RESERVED = new Set(['rst', 'clk']);
const bitName = (p: 's' | 'n', i: number) => `${p}${i}`;

/** Is the machine well formed? null, or why not. */
export function fsmProblem(doc: FsmDoc): string | null {
  if (!doc.states.length) return 'at least one state';
  if (doc.states.length > FSM_MAX_STATES) return `at most ${FSM_MAX_STATES} states`;
  if (doc.ins.length > FSM_MAX_IN) return `at most ${FSM_MAX_IN} inputs`;
  if (!doc.outs.length) return 'at least one output';
  if (doc.outs.length > FSM_MAX_OUT) return `at most ${FSM_MAX_OUT} outputs`;
  const names = [...doc.ins, ...doc.outs];
  const bad = names.find((x) => !isIdent(x) || x.includes('.') || RESERVED.has(x) || /^[sn]\d+$/.test(x));
  if (bad !== undefined) return `'${bad}' cannot be a pin name here (rst, clk, s0…, n0… are the machine's own)`;
  const dup = names.find((x, i) => names.indexOf(x) !== i);
  if (dup) return `two pins are called '${dup}'`;
  const sdup = doc.states.find((s, i) => doc.states.findIndex((t) => t.name === s.name) !== i);
  if (sdup) return `two states are called '${sdup.name}'`;
  if (!(doc.reset >= 0 && doc.reset < doc.states.length)) return 'no reset state';
  if (doc.arcs.some((a) => !doc.states[a.from] || !doc.states[a.to])) return 'an arc joins a state that is gone';
  return null;
}

/** Warnings that do not stop the build: arcs never taken (an earlier arc out of the same state takes their inputs). */
export function fsmWarnings(doc: FsmDoc): string[] {
  const out: string[] = [];
  const combos = 1 << doc.ins.length;
  doc.arcs.forEach((a, k) => {
    let taken = false;
    for (let c = 0; c < combos && !taken; c++) {
      const inp = doc.ins.map((_, i) => (c >> (doc.ins.length - 1 - i)) & 1);
      taken = arcOf(doc, a.from, inp) === k;
    }
    if (!taken) out.push(`${doc.states[a.from].name} → ${doc.states[a.to].name} (${condText(doc, a.when)}) is never taken: an earlier arc out of ${doc.states[a.from].name} takes its inputs`);
  });
  const reach = new Set([doc.reset]);
  for (let grew = true; grew;) {
    grew = false;
    for (const a of doc.arcs) if (reach.has(a.from) && !reach.has(a.to)) { reach.add(a.to); grew = true; }
  }
  doc.states.forEach((s, i) => { if (!reach.has(i)) out.push(`${s.name} cannot be reached from ${doc.states[doc.reset].name}`); });
  return out;
}

/** An arc's condition as text: x=1 · en=0, or "always". */
export const condText = (doc: FsmDoc, when: Record<string, 0 | 1>): string =>
  doc.ins.filter((x) => when[x] !== undefined).map((x) => `${x}=${when[x]}`).join(' · ') || 'always';

// ---- the two tables -----------------------------------------------------------------------------------

/** The next-state table: state bits (most significant first) and inputs → next state bits. */
export function nextTable(doc: FsmDoc, enc: Encoding = doc.encoding, of?: string): TableDoc {
  const k = stateBits(doc.states.length, enc), n = doc.ins.length, codes = codesOf(doc, enc);
  const sNames = Array.from({ length: k }, (_, i) => bitName('s', k - 1 - i));
  const rows = Array.from({ length: k }, () => [] as string[]);
  for (let r = 0; r < 1 << (k + n); r++) {
    const code = r >> n, inp = doc.ins.map((_, i) => (r >> (n - 1 - i)) & 1);
    const s = codes.indexOf(code);
    let next: number | null;
    if (s < 0) next = doc.safe ? codes[doc.reset] : null;
    else { const a = arcOf(doc, s, inp); next = codes[a < 0 ? s : doc.arcs[a].to]; }
    for (let j = 0; j < k; j++) rows[j].push(next === null ? '-' : String((next >> (k - 1 - j)) & 1));
  }
  return { ins: [...sNames, ...doc.ins], outs: sNames.map((x) => `n${x.slice(1)}`), rows: rows.map((r) => r.join('')), form: doc.form, ...(of ? { of } : {}) };
}

/** The output table: state bits (and the inputs, for a Mealy machine) → outputs. */
export function outTable(doc: FsmDoc, enc: Encoding = doc.encoding, of?: string): TableDoc {
  const k = stateBits(doc.states.length, enc), mealy = isMealy(doc), n = mealy ? doc.ins.length : 0, codes = codesOf(doc, enc);
  const sNames = Array.from({ length: k }, (_, i) => bitName('s', k - 1 - i));
  const rows = doc.outs.map(() => [] as string[]);
  for (let r = 0; r < 1 << (k + n); r++) {
    const code = r >> n, inp = doc.ins.map((_, i) => (mealy ? (r >> (n - 1 - i)) & 1 : 0));
    const s = codes.indexOf(code);
    const a = s >= 0 && mealy ? arcOf(doc, s, inp) : -1;
    doc.outs.forEach((o, j) => {
      rows[j].push(s < 0 ? (doc.safe ? '0' : '-') : doc.states[s].out?.includes(o) || (a >= 0 && doc.arcs[a].out?.includes(o)) ? '1' : '0');
    });
  }
  return { ins: [...sNames, ...(mealy ? doc.ins : [])], outs: [...doc.outs], rows: rows.map((r) => r.join('')), form: doc.form, ...(of ? { of } : {}) };
}

/** Why an encoding cannot be built (its tables would pass 8 inputs), or null. */
export function encodingProblem(doc: FsmDoc, enc: Encoding): string | null {
  const k = stateBits(doc.states.length, enc);
  if (k + doc.ins.length > 8) return `${k} state bits + ${doc.ins.length} inputs: more than the 8 a table takes`;
  return null;
}

export interface EncodingCost { enc: Encoding; dffs: number; nands: number; logic: number; problem?: string }

const DFF_NANDS = () => stats(DFF).nands;

/** What each encoding costs: flip-flops, the logic's NANDs (both tables and the reset gating) and the total. */
export function encodingCosts(doc: FsmDoc): EncodingCost[] {
  return ENCODINGS.map((enc) => {
    const problem = encodingProblem(doc, enc) ?? undefined;
    const dffs = stateBits(doc.states.length, enc);
    if (problem) return { enc, dffs, nands: 0, logic: 0, problem };
    const t1 = nextTable(doc, enc), t2 = outTable(doc, enc);
    // the reset gating: one AND (or OR) per bit, an inverter for rst
    const gate = dffs * stats(enc === 'onehot' ? OR : AND).nands + stats(NOT).nands;
    const logic = tableCost(t1).nands + tableCost(t2).nands + gate;
    return { enc, dffs, logic, nands: logic + dffs * DFF_NANDS() };
  });
}

// ---- the chips ----------------------------------------------------------------------------------------

export const childIds = (id: string): { next: string; out: string } => ({ next: `${id}_next`, out: `${id}_out` });

/** A generated table chip compiled as it will be placed. */
function placed(chip: ChipDoc): ComponentDef | { error: string } {
  const c = compileChip(chip, (ref) => partDef(ref, () => undefined));
  const err = c.diags.find((d) => d.level === 'error');
  return err ? { error: `${chip.name}: ${err.msg}` } : c.def;
}

/** The top level: inputs, rst, clk; the next-state chip, the reset gating, the flip-flops, the output chip. */
function topDef(doc: FsmDoc, next: ComponentDef, out: ComponentDef, enc: Encoding): ComponentDef {
  const k = stateBits(doc.states.length, enc), resetCode = codesOf(doc, enc)[doc.reset];
  const b = new Builder(8, 10, 2);
  b.pins(...doc.ins, 'rst', 'clk');
  const nrst = b.name(b.op1(NOT, ['rst'], '¬rst', 'inv_rst'), 'rst_n', true);
  b.next();
  b.add(next, 'next state', 'next');
  for (let i = 0; i < k; i++) b.wire(`s${i}.q`, `next.s${i}`);
  for (const x of doc.ins) b.wire(x, `next.${x}`);
  b.next();
  const gated = Array.from({ length: k }, (_, i) => (resetCode >> i) & 1
    ? b.op1(OR, [`next.n${i}`, 'rst'], `n${i} + rst`, `g${i}`)
    : b.op1(AND, [`next.n${i}`, nrst], `n${i}·¬rst`, `g${i}`));
  b.next();
  for (let i = k - 1; i >= 0; i--) b.op(DFF, [gated[i], 'clk'], `s${i}`, `s${i}`);
  for (let i = 0; i < k; i++) b.name(`s${i}.q`, `s${i}`, true);
  b.next();
  b.add(out, 'outputs', 'out');
  for (let i = 0; i < k; i++) b.wire(`s${i}.q`, `out.s${i}`);
  if (out.ports.some((p) => p.dir === 'in' && doc.ins.includes(p.name))) for (const x of doc.ins) b.wire(x, `out.${x}`);
  b.next();
  for (const o of doc.outs) b.wire(`out.${o}`, o);
  const R = b.right, ins = [...doc.ins, 'rst', 'clk'];
  return {
    id: 'fsm', name: 'State machine', category: 'sequential',
    summary: 'Drawn from a state diagram.',
    ports: [...ins.map((p) => ({ name: p, width: 1, dir: 'in' as const, ...(p === 'clk' ? { clock: true } : {}) })), ...doc.outs.map((p) => ({ name: p, width: 1, dir: 'out' as const }))],
    symbol: { kind: 'box', label: 'FSM' },
    netlist: () => ({
      pins: Object.fromEntries([...ins.map((p, i) => [p, [0, 2 + 4 * i]]), ...doc.outs.map((p, j) => [p, [R, 2 + 4 * j]])]),
      instances: b.instances, nets: b.nets(),
    }),
  };
}

/** The machine's three chips in the workspace (top redrawn, its two table chips made or redrawn), or why not. */
export function setFsm(ws: Workspace, id: string, doc: FsmDoc): Workspace | { error: string } {
  const top = ws.chips[id];
  if (!top) return { error: 'no such chip' };
  const why = fsmProblem(doc) ?? encodingProblem(doc, doc.encoding);
  if (why) return { error: why };
  const ids = childIds(id);
  const chips = { ...ws.chips };
  const made: ComponentDef[] = [];
  for (const [cid, table, name] of [[ids.next, nextTable(doc, doc.encoding, id), 'next state'], [ids.out, outTable(doc, doc.encoding, id), 'outputs']] as const) {
    const tp = tableProblem(table);
    if (tp) return { error: `${name}: ${tp}` };
    const old = chips[cid];
    if (old && old.table?.of !== id) return { error: `a chip called ${cid} is in the way` };
    const drawn = drawTable(old ?? emptyChip(cid, `${top.name}: ${name}`), table);
    if ('error' in drawn) return drawn;
    const def = placed(drawn);
    if ('error' in def) return def;
    chips[cid] = drawn;
    made.push(def);
  }
  const [nextDef, outDef] = made;
  const drawn = docFromDef(topDef(doc, nextDef, outDef, doc.encoding), {
    id, name: top.name, refOf: (d) => (d === nextDef ? { chip: ids.next } : d === outDef ? { chip: ids.out } : undefined),
  });
  if ('error' in drawn) return drawn;
  const old = new Map(top.pins.map((p) => [p.name, p]));
  const pins = drawn.pins.map((p) => {
    const o = old.get(p.name);
    return o && o.dir === p.dir && o.value !== undefined ? { ...p, value: o.value } : p;
  });
  chips[id] = { ...top, pins, parts: drawn.parts, wires: drawn.wires, labels: drawn.labels, fsm: doc };
  return { ...ws, chips };
}

/** A new state-machine chip (the 101 detector), opened. */
export function newFsmChip(ws: Workspace, doc: FsmDoc = FSM_TEMPLATE, name = 'State machine'): { ws: Workspace; id: string } {
  const taken = Object.keys(ws.chips);
  let id = uniqueName('u_fsm', taken);
  while (taken.includes(childIds(id).next) || taken.includes(childIds(id).out)) id = uniqueName(`${id}_`, taken);
  const r = setFsm({ ...ws, chips: { ...ws.chips, [id]: emptyChip(id, name) } }, id, doc);
  if ('error' in r) throw new Error(r.error);
  return { ws: openChip(r, id), id };
}

/** Detach: the machine is dropped, its drawing stays; the two tables become ordinary truth-table chips. */
export function detachFsm(ws: Workspace, id: string): Workspace {
  const c = ws.chips[id];
  if (!c?.fsm) return ws;
  const chips = { ...ws.chips };
  const { fsm: _f, ...rest } = c;
  chips[id] = rest;
  for (const cid of Object.values(childIds(id))) {
    const t = chips[cid]?.table;
    if (t?.of === id) { const { of: _o, ...free } = t; chips[cid] = { ...chips[cid], table: free }; }
  }
  return { ...ws, chips };
}

/** The state-machine chip whose machine a table chip follows (present and still owning it), if any. */
export function ownerOf(ws: Workspace, id: string): ChipDoc | undefined {
  const of = ws.chips[id]?.table?.of;
  const o = of ? ws.chips[of] : undefined;
  return o?.fsm ? o : undefined;
}

// ---- the machine as an FsmSpec: the diagram, and the read-back of the built circuit --------------------------

/** Diagram drawing hints for each arc: a bend apart from a reverse arc or around a state in the way, loop angles. */
function drawingOf(doc: FsmDoc): Pick<FsmArc, 'bend' | 'loop'>[] {
  const loops = new Map<number, number>();
  return doc.arcs.map((a) => {
    if (a.from === a.to) {
      const k = loops.get(a.from) ?? 0;
      loops.set(a.from, k + 1);
      return { loop: [-90, 90, -30, -150, 30, 150][k % 6] };
    }
    const A = doc.states[a.from].at, B = doc.states[a.to].at;
    const reverse = doc.arcs.some((b) => b.from === a.to && b.to === a.from);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const blocked = doc.states.some((s, i) => {
      if (i === a.from || i === a.to) return false;
      const t = ((s.at[0] - A[0]) * (B[0] - A[0]) + (s.at[1] - A[1]) * (B[1] - A[1])) / len / len;
      if (t <= 0 || t >= 1) return false;
      return Math.hypot(A[0] + t * (B[0] - A[0]) - s.at[0], A[1] + t * (B[1] - A[1]) - s.at[1]) < 40;
    });
    return { bend: blocked ? -70 : reverse ? 22 : 0 };
  });
}

/** An arc's diagram label: its condition (inputs in order, – for either), then / and its Mealy outputs. */
export function arcLabel(doc: FsmDoc, a: FsmDoc['arcs'][number]): string {
  const cond = doc.ins.map((x) => (a.when[x] === undefined ? '–' : String(a.when[x]))).join('');
  return isMealy(doc) ? `${cond || '·'}/${doc.outs.map((o) => (a.out?.includes(o) ? 1 : 0)).join('')}` : cond;
}

/**
 * The machine as an FsmSpec over the built chip (state bits s0… least significant first, reset on rst = 1).
 * `implicit`: every state also gets a last arc to itself (no arc matches: it stays), for the read-back.
 */
export function specOf(doc: FsmDoc, implicit = false): FsmSpec {
  const codes = codesOf(doc), k = stateBits(doc.states.length, doc.encoding);
  const hints = drawingOf(doc);
  const xs = doc.states.map((s) => s.at[0]), ys = doc.states.map((s) => s.at[1]);
  const W = Math.max(400, Math.max(...xs) + 80), H = Math.max(200, Math.max(...ys) + 90);
  const when = (w: Record<string, 0 | 1>) => (inp: FsmInputs) => Object.entries(w).every(([x, v]) => inp[x] === v);
  const arcs: FsmArc[] = doc.arcs.map((a, i) => ({
    from: a.from, to: a.to, when: when(a.when), label: arcLabel(doc, a), ...hints[i],
    ...(a.bend !== undefined && a.from !== a.to ? { bend: a.bend } : {}), ...(a.loop !== undefined && a.from === a.to ? { loop: a.loop } : {}),
    ...(a.dx !== undefined ? { dx: a.dx } : {}), ...(a.dy !== undefined ? { dy: a.dy } : {}),
    ...(a.out?.length ? { out: Object.fromEntries(a.out.map((o) => [o, 1])) } : {}),
  }));
  if (implicit) doc.states.forEach((_, s) => arcs.push({ from: s, to: s, cls: 'implicit' }));
  const R = doc.states[doc.reset].at;
  return {
    title: 'state machine', shape: 'circle', size: [W, H],
    states: doc.states.map((s, i) => ({
      name: s.name, code: codes[i], at: [s.at[0], s.at[1]],
      ...(s.out?.length ? { out: Object.fromEntries(s.out.map((o) => [o, 1])), does: `Moore: ${s.out.join(', ')} = 1` } : {}),
    })),
    arcs, reset: doc.reset, inputs: [...doc.ins, 'rst'], outputs: [...doc.outs], resetIn: { rst: 1 },
    stateBits: Array.from({ length: k }, (_, i) => `s${i}.q`), codeBits: k, entry: [Math.max(8, R[0] - 72), R[1]],
  };
}
