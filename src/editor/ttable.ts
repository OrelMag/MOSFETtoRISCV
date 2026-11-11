// Truth-table chips (DOM-free): a chip whose body is drawn from a table of 1-bit inputs and outputs. Each output is
// minimized to a sum of products (lib/sop.ts: don't-cares used, exact while the search stays small), equal terms are
// shared between outputs, and the logic is built as NAND–NAND (only NANDs and inverters) or AND–OR, then drawn by
// docFromDef like any library block. Every edit of the table redraws the body (one undo step); Editor.edit refuses a
// change to the body itself (isGenerated, as for a Verilog chip), and Detach keeps the drawing as an ordinary chip.

import { Builder } from '../lib/builder';
import { merger, ones, splitter } from '../lib/define';
import { covers, literals } from '../lib/sop';
import { equation, inBit, onDc, rowCount, tableDef, tableLogic, termText, type TableLogic } from '../lib/tablelogic';
import { logicDepth, stats } from '../sim/stats';
import type { ComponentDef } from '../sim/types';
import { docFromDef } from './fromdef';
import { type ChipDoc, emptyChip, isIdent, type PartRef, type TableDoc, uniqueName, type Workspace } from './model';
import { isError, partDef } from './parts';
import { openChip } from './session';

export const TABLE_MAX_IN = 8;
export const TABLE_MAX_OUT = 16;
export { equation, inBit, onDc, rowCount, tableDef, tableLogic, termText };
export type { TableLogic };
export type Cell = '0' | '1' | '-';


/** A new chip's table: the majority of three. */
export const TABLE_TEMPLATE: TableDoc = { ins: ['a', 'b', 'c'], outs: ['y'], rows: ['00010111'], form: 'nand' };


/** Does the table's value (care rows only) match f? For tests and the read-back of a drawn chip. */
export function tableMatches(t: TableDoc, j: number, f: (row: number) => number): boolean {
  const s = t.rows[j];
  for (let r = 0; r < s.length; r++) if (s[r] !== '-' && Number(s[r]) !== f(r)) return false;
  return true;
}



/** The ROM part a table is stored in: 2^n words of 8 bits, output j in bit j (don't cares 0). */
export function tableRomRef(t: TableDoc): Extract<PartRef, { rom: unknown }> {
  const w = t.outs.length > 8 ? 16 : 8;
  const words = Array.from({ length: rowCount(t) }, (_, r) => t.rows.reduce((w, s, j) => w | (s[r] === '1' ? 1 << j : 0), 0));
  return { rom: { k: t.ins.length, w, addr: 'word', lang: 'hex', src: words.map((w) => w.toString(16)).join('\n') } };
}

/** The ROM form: the inputs merged into the address (the first input most significant), the word split into the outputs. */
function romTableDef(t: TableDoc, id: string): { def: ComponentDef; rom: ComponentDef; ref: PartRef } {
  const n = t.ins.length, ref = tableRomRef(t);
  const rom = partDef(ref, () => undefined);
  if (isError(rom)) throw new Error(rom.error);
  const b = new Builder(8, 10, 2);
  b.pins(...t.ins);
  const addr = b.op1(merger(ones(n)), [...t.ins].reverse(), 'address');
  b.next();
  const data = b.op1(rom, [addr], 'every row stored', 'rom');
  b.next();
  const sp = b.op(splitter(ones(t.outs.length > 8 ? 16 : 8)), [data], 'bits');
  b.next();
  t.outs.forEach((o, j) => b.wire(`${sp}.o${j}`, o));
  const R = Math.max(b.right, 30), pitch = 4;
  const def: ComponentDef = {
    id, name: 'Truth table (ROM)', category: 'memory', summary: 'A truth table stored as a ROM: every row a word.',
    ports: [...t.ins.map((p) => ({ name: p, width: 1, dir: 'in' as const })), ...t.outs.map((p) => ({ name: p, width: 1, dir: 'out' as const }))],
    symbol: { kind: 'box', label: 'ROM' },
    netlist: () => ({
      pins: Object.fromEntries([...t.ins.map((p, i) => [p, [0, 2 + pitch * i]]), ...t.outs.map((p, j) => [p, [R, 2 + pitch * j]])]),
      instances: b.instances, nets: b.nets(),
    }),
  };
  return { def, rom, ref };
}

/** The table's circuit in its form, and how docFromDef places a part it cannot name by id (the ROM). */
export function tableBuild(t: TableDoc, id = 'tt', logic?: TableLogic): { def: ComponentDef; refOf?: (d: ComponentDef) => PartRef | undefined } {
  if (t.form !== 'rom') return { def: tableDef(t, id, logic) };
  const r = romTableDef(t, id);
  return { def: r.def, refOf: (d) => (d === r.rom ? r.ref : undefined) };
}

export interface TableCost { nands: number; depth: number | null; terms: number; literals: number; exact: boolean }

export function tableCost(t: TableDoc, logic = tableLogic(t), def = tableBuild(t, 'tt', logic).def): TableCost {
  return {
    nands: stats(def).nands, depth: logicDepth(def), terms: logic.terms.length,
    literals: logic.terms.reduce((a, p) => a + literals(p, t.ins.length), 0), exact: logic.exact,
  };
}

// ---- the workspace --------------------------------------------------------------------------------------

/** Is the table well formed (names, sizes, cells)? null when it is, else why not. */
export function tableProblem(t: TableDoc): string | null {
  if (!t.ins.length) return 'at least one input';
  if (t.ins.length > TABLE_MAX_IN) return `at most ${TABLE_MAX_IN} inputs`;
  if (!t.outs.length) return 'at least one output';
  if (t.outs.length > TABLE_MAX_OUT) return `at most ${TABLE_MAX_OUT} outputs`;
  const names = [...t.ins, ...t.outs];
  const bad = names.find((x) => !isIdent(x) || x.includes('.'));
  if (bad !== undefined) return `'${bad}' is not a pin name (letters, digits and _)`;
  const dup = names.find((x, i) => names.indexOf(x) !== i);
  if (dup) return `two pins are called '${dup}'`;
  if (t.rows.length !== t.outs.length || t.rows.some((s) => s.length !== rowCount(t) || /[^01-]/.test(s))) return 'the rows do not match the inputs';
  return null;
}

/** The chip with its body drawn from `table` (input values kept by pin name; name, colour, notes, face stay). */
export function drawTable(chip: ChipDoc, table: TableDoc): ChipDoc | { error: string } {
  const why = tableProblem(table);
  if (why) return { error: why };
  const b = tableBuild(table, `tt_${chip.id}`);
  const doc = docFromDef(b.def, { id: chip.id, name: chip.name, refOf: b.refOf });
  if ('error' in doc) return doc;
  const old = new Map(chip.pins.map((p) => [p.name, p]));
  const pins = doc.pins.map((p) => {
    const o = old.get(p.name);
    return o && o.dir === p.dir && o.value !== undefined ? { ...p, value: o.value } : p;
  });
  return { ...chip, pins, parts: doc.parts, wires: doc.wires, labels: doc.labels, table };
}

/** A new truth-table chip, opened. */
export function newTableChip(ws: Workspace, table: TableDoc = TABLE_TEMPLATE, name = 'Truth table'): { ws: Workspace; id: string } {
  const id = uniqueName('u_table', Object.keys(ws.chips));
  const chip = drawTable(emptyChip(id, name), table);
  if ('error' in chip) throw new Error(chip.error);
  return { ws: openChip({ ...ws, chips: { ...ws.chips, [id]: chip } }, id), id };
}

/** The table changed: the chip redrawn (one undo step for the caller), or why not. */
export function setTable(ws: Workspace, id: string, table: TableDoc): Workspace | { error: string } {
  const c = ws.chips[id];
  if (!c?.table) return { error: 'not a truth-table chip' };
  const next = drawTable(c, table);
  return 'error' in next ? next : { ...ws, chips: { ...ws.chips, [id]: next } };
}

/** Detach: the drawing stays, the table goes. */
export function detachTable(ws: Workspace, id: string): Workspace {
  const c = ws.chips[id];
  if (!c?.table) return ws;
  const { table: _t, ...rest } = c;
  return { ...ws, chips: { ...ws.chips, [id]: rest } };
}

// ---- table edits (pure) ---------------------------------------------------------------------------------

const nextName = (taken: string[], base: string[]): string => base.find((x) => !taken.includes(x)) ?? uniqueName('x', taken);
const IN_NAMES = 'abcdefghijklmnopqrstuvw'.split('');
const OUT_NAMES = ['y', 'z', ...'stuvw'.split(''), 'q'];

/** An input added as the least significant bit: every output keeps its value (it ignores the new input). */
export function addInput(t: TableDoc): TableDoc {
  if (t.ins.length >= TABLE_MAX_IN) return t;
  const name = nextName([...t.ins, ...t.outs], IN_NAMES);
  return { ...t, ins: [...t.ins, name], rows: t.rows.map((s) => [...s].map((c) => c + c).join('')) };
}

/** Input i removed: the rows where it is 0 stay. */
export function removeInput(t: TableDoc, i: number): TableDoc {
  if (t.ins.length <= 1) return t;
  const keep = (r: number) => !inBit(t, r, i);
  return { ...t, ins: t.ins.filter((_, k) => k !== i), rows: t.rows.map((s) => [...s].filter((_, r) => keep(r)).join('')) };
}

export function addOutput(t: TableDoc): TableDoc {
  if (t.outs.length >= TABLE_MAX_OUT) return t;
  return { ...t, outs: [...t.outs, nextName([...t.ins, ...t.outs], OUT_NAMES)], rows: [...t.rows, '0'.repeat(rowCount(t))] };
}

export function removeOutput(t: TableDoc, j: number): TableDoc {
  if (t.outs.length <= 1) return t;
  return { ...t, outs: t.outs.filter((_, k) => k !== j), rows: t.rows.filter((_, k) => k !== j) };
}

export function renamePin(t: TableDoc, side: 'in' | 'out', k: number, name: string): TableDoc {
  return side === 'in' ? { ...t, ins: t.ins.map((x, i) => (i === k ? name : x)) } : { ...t, outs: t.outs.map((x, i) => (i === k ? name : x)) };
}

export function setCell(t: TableDoc, j: number, r: number, c: Cell): TableDoc {
  const s = t.rows[j];
  if (s[r] === c) return t;
  return { ...t, rows: t.rows.map((x, k) => (k === j ? x.slice(0, r) + c + x.slice(r + 1) : x)) };
}

/** 0 → 1 → – → 0. */
export const nextCell = (c: string): Cell => (c === '0' ? '1' : c === '1' ? '-' : '0');

/** Output j filled from a function of the row (a starting point: "fill from an expression"). */
export function fillOutput(t: TableDoc, j: number, f: (r: number) => Cell): TableDoc {
  return { ...t, rows: t.rows.map((x, k) => (k === j ? Array.from({ length: rowCount(t) }, (_, r) => f(r)).join('') : x)) };
}

/**
 * Rows pasted as text: a line is the inputs then the outputs (n + m symbols), or just the outputs (m symbols: the next
 * row in order); 0 1 - x are the symbols, spaces, | , and tabs are ignored, a line with other letters (a header) or after
 * # or // is skipped. Rows the text leaves out keep their values.
 */
export function pasteRows(t: TableDoc, text: string): TableDoc | { error: string } {
  const n = t.ins.length, m = t.outs.length;
  const rows = t.rows.map((s) => [...s]);
  let next = 0, used = 0;
  const lines = text.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].replace(/(#|\/\/).*$/, '').trim();
    if (!line) continue;
    if (/[A-WYZa-wyz_]/.test(line)) continue; // a header
    const sym = line.replace(/[\s|,;:=]/g, '').replace(/[xX]/g, '-');
    if (/[^01-]/.test(sym)) return { error: `line ${li + 1}: only 0, 1 and - (or x)` };
    let r: number, outs: string;
    if (sym.length === n + m) {
      if (sym.slice(0, n).includes('-')) return { error: `line ${li + 1}: an input cannot be a don't care` };
      r = parseInt(sym.slice(0, n), 2);
      outs = sym.slice(n);
    } else if (sym.length === m) {
      r = next;
      outs = sym;
    } else return { error: `line ${li + 1}: ${sym.length} symbols, expected ${n + m} (inputs and outputs) or ${m} (outputs)` };
    if (r >= rowCount(t)) return { error: `line ${li + 1}: past the last row` };
    for (let j = 0; j < m; j++) rows[j][r] = outs[j];
    next = r + 1;
    used++;
  }
  if (!used) return { error: 'no rows in the text' };
  return { ...t, rows: rows.map((s) => s.join('')) };
}

/** Is row r covered by term p (for the K-map's loops)? */
export const termCovers = covers;
