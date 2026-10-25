// The C extension's expander in gates (chapter 25): the 32 bits at the PC in, the instruction the rest of the
// core runs out. A 16-bit parcel (low bits ≠ 11) is rewritten into its 32-bit instruction, anything else passes
// through. Two parts: C_FORMS recognizes which of the 30 forms the parcel is (one-hot, plus `pass` for a 32-bit
// instruction), and six field multiplexers build the instruction a RISC-V field at a time.
//
// Every output bit of every form is a constant or one of the parcel's bits (the expansion only moves bits and adds
// constants: rd′ becomes 01·rd′), so a field is a one-hot AND-OR: per "recipe" (forms that fill the field the same
// way, their selects ORed) a NAND per non-zero bit, then a NAND across the recipes. The recipes are read off the
// specification (riscv/rvc.ts decodeC) over all 65 536 parcels, so the wiring cannot disagree with it.

import type { ComponentDef, PortDef } from '../sim/types';
import { decodeC } from '../riscv/rvc';
import { Builder } from './builder';
import { andN, decoder } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT } from './gates';
import { NAND } from './transistors';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

/** Pins of a Builder netlist: inputs down the left edge, outputs down the right (labels carry the nets). */
function edgePins(b: Builder, ins: string[], outs: string[], pitch = 2): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  ins.forEach((p, i) => (pins[p] = [0, 2 + pitch * i]));
  outs.forEach((p, i) => (pins[p] = [b.right, 2 + pitch * i]));
  return pins;
}

/** The forms in C_FORMS's output order (c.nop is c.addi with rd = x0: the same wiring); `pass` comes after them. */
export const C_FORM_NAMES = [
  'c.addi4spn', 'c.lw', 'c.flw', 'c.sw', 'c.fsw',
  'c.addi', 'c.jal', 'c.li', 'c.addi16sp', 'c.lui', 'c.srli', 'c.srai', 'c.andi', 'c.sub', 'c.xor', 'c.or', 'c.and',
  'c.j', 'c.beqz', 'c.bnez',
  'c.slli', 'c.lwsp', 'c.flwsp', 'c.jr', 'c.mv', 'c.ebreak', 'c.jalr', 'c.add', 'c.swsp', 'c.fswsp',
] as const;
const NF = C_FORM_NAMES.length;
/** The `f` bus: one bit per form, then pass (a 32-bit instruction). */
export const PASS = NF;
const formIndex = new Map<string, number>(C_FORM_NAMES.map((n, i) => [n, i]));

/** Which f bit a parcel sets: a form, PASS, or -1 (an illegal parcel). */
export function formOf(h: number): number {
  if ((h & 3) === 3) return PASS;
  const d = decodeC(h);
  if (!d) return -1;
  return formIndex.get(d.name === 'c.nop' ? 'c.addi' : d.name)!;
}

// ---- recipes ---------------------------------------------------------------------------------

/** A bit's source: 'zero', 'one', or w[k] (k < 16: a parcel bit; pass reads all 32). */
type Src = 'zero' | 'one' | number;
interface Field { name: string; lo: number; hi: number }
/** The 32-bit instruction's fields, low to high. */
export const C_FIELDS: Field[] = [
  { name: 'opcode', lo: 0, hi: 6 }, { name: 'rd', lo: 7, hi: 11 }, { name: 'funct3', lo: 12, hi: 14 },
  { name: 'rs1', lo: 15, hi: 19 }, { name: 'rs2', lo: 20, hi: 24 }, { name: 'funct7', lo: 25, hi: 31 },
];
/** A field's recipes: the forms (f bits) that share it, and each field bit's source. */
export interface Recipe { forms: number[]; src: Src[] }

let RECIPES: Recipe[][] | null = null;

/** Per field, the recipes (computed once from decodeC over every parcel). */
export function cRecipes(): Recipe[][] {
  if (RECIPES) return RECIPES;
  // per form and output bit: the sources it may use (a constant and / or the parcel bits always equal to it)
  const allowed: Src[][][] = Array.from({ length: NF }, () => []);
  const seen: number[][] = Array.from({ length: NF }, () => []);
  for (let h = 0; h < 0x10000; h++) {
    const f = formOf(h);
    if (f >= 0 && f < NF) seen[f].push(h);
  }
  for (let f = 0; f < NF; f++) {
    const hs = seen[f];
    const ws = hs.map((h) => decodeC(h)!.word);
    for (let j = 0; j < 32; j++) {
      const out: Src[] = [];
      const v0 = (ws[0] >>> j) & 1;
      if (ws.every((w) => ((w >>> j) & 1) === v0)) out.push(v0 ? 'one' : 'zero');
      for (let k = 0; k < 16; k++) if (hs.every((h, i) => ((ws[i] >>> j) & 1) === ((h >>> k) & 1))) out.push(k);
      if (!out.length) throw new Error(`${C_FORM_NAMES[f]}: bit ${j} is not a constant or a parcel bit`);
      allowed[f][j] = out;
    }
  }
  RECIPES = C_FIELDS.map(({ lo, hi }) => {
    const groups: Recipe[] = [];
    for (let f = 0; f < NF; f++) {
      const al = allowed[f].slice(lo, hi + 1);
      const g = groups.find((r) => r.src.every((s, i) => al[i].includes(s)));
      if (g) g.forms.push(f);
      else groups.push({ forms: [f], src: al.map((a) => a[0]) }); // a constant when there is one: cheaper
    }
    groups.push({ forms: [PASS], src: Array.from({ length: hi - lo + 1 }, (_, i) => lo + i) });
    return groups;
  });
  return RECIPES;
}

/** What a field's multiplexer gives for an f word and a window w (its spec). */
function fieldValue(fi: number, f: number, w: number): number {
  const { lo, hi } = C_FIELDS[fi];
  let y = 0;
  for (const r of cRecipes()[fi]) {
    if (!r.forms.some((k) => (f >>> k) & 1)) continue;
    r.src.forEach((s, i) => { if (s === 'one' || (typeof s === 'number' && (w >>> s) & 1)) y |= 1 << i; });
  }
  return (y & (2 ** (hi - lo + 1) - 1)) >>> 0;
}

/** NOT of the AND of the inputs (a NAND as wide as asked). */
function nandOf(b: Builder, ins: string[], label?: string, name?: string): string {
  if (ins.length === 1) return b.op1(NOT, ins, label, name);
  if (ins.length === 2) return b.op1(NAND, ins, label, name);
  const a = b.op1(andN(ins.length), ins);
  return b.op1(NOT, [a], label, name);
}

const fieldCache = new Map<number, ComponentDef>();

/** One field's multiplexer: f (forms, one-hot) and w (the window) in, the field out. */
export function cField(fi: number): ComponentDef {
  let d = fieldCache.get(fi);
  if (d) return d;
  const { name, lo, hi } = C_FIELDS[fi];
  const W = hi - lo + 1;
  const recipes = cRecipes()[fi];
  const b = new Builder(14);
  b.pins('f', 'w');
  const sf = b.op(splitter(ones(NF + 1)), ['f'], undefined, 'sf');
  const sw = b.op(splitter(ones(32)), ['w'], undefined, 'sw');
  b.next();
  // a recipe's select: the OR of its forms
  const sel = recipes.map((r, g) => (r.forms.length === 1 ? `${sf}.o${r.forms[0]}` : b.op1(orN(r.forms.length), r.forms.map((k) => `${sf}.o${k}`), `${r.forms.length} forms`, `s${g}`)));
  b.next();
  // per field bit, a NAND per recipe that sets it (constant 1: the select's inverse), then a NAND across them
  const terms: string[][] = Array.from({ length: W }, () => []);
  recipes.forEach((r, g) => r.src.forEach((s, i) => {
    if (s === 'zero') return;
    terms[i].push(s === 'one' ? b.op1(NOT, [sel[g]], undefined, `t${i}_${g}`) : b.op1(NAND, [sel[g], `${sw}.o${s}`], undefined, `t${i}_${g}`));
  }));
  b.next();
  const ys = terms.map((t, i) => nandOf(b, t, `${name}[${i}]`, `y${i}`));
  b.next();
  b.wire(b.op1(merger(ones(W)), ys, undefined, 'my'), 'y');
  d = define({
    id: `rvc_${name}`, name: `C expander: ${name}`, category: 'routing',
    summary: `The ${name} field (bits ${hi}:${lo}) of the instruction a parcel stands for: ${recipes.length} ways to fill it (forms that fill it alike share one, their selects ORed), each bit a NAND per way, then a NAND across them.`,
    ports: [bus('f', NF + 1, 'in'), bus('w', 32, 'in'), bus('y', W, 'out')],
    symbol: { kind: 'box', label: name.toUpperCase() },
    spec: ([f, w]) => [fieldValue(fi, f, w)],
    netlist: () => ({ pins: edgePins(b, ['f', 'w'], ['y'], 4), instances: b.instances, nets: b.nets() }),
  });
  fieldCache.set(fi, d);
  return d;
}

// ---- recognizing the form -----------------------------------------------------------------------

/** The parcel's form, one-hot (f), pass for a 32-bit instruction, illegal for a parcel that is no form. */
export const C_FORMS: ComponentDef = (() => {
  const b = new Builder(14);
  b.pins('c');
  const sb = b.op(splitter(ones(16)), ['c'], undefined, 'sb');
  const sg = b.op(splitter([2, 3, 2, 3, 2, 1, 3]), ['c'], undefined, 'sg'); // 1:0 4:2 6:5 9:7 11:10 12 15:13
  const c = (k: number) => `${sb}.o${k}`;
  b.next();
  const q = b.op(decoder(2), [`${sg}.o0`], 'quadrant', 'q');
  const f3 = b.op(decoder(3), [`${sg}.o6`], 'funct3', 'f3');
  const s10 = b.op(decoder(2), [`${sg}.o4`], '11:10', 's10');
  const s5 = b.op(decoder(2), [`${sg}.o2`], '6:5', 's5');
  b.next();
  const nzRd = b.op1(orN(5), [7, 8, 9, 10, 11].map(c), 'rd ≠ 0', 'nzrd');
  const nzRs2 = b.op1(orN(5), [2, 3, 4, 5, 6].map(c), 'rs2 ≠ 0', 'nzrs2');
  const nzU = b.op1(orN(8), [5, 6, 7, 8, 9, 10, 11, 12].map(c), 'uimm ≠ 0', 'nzu');
  const not2 = b.op1(orN(4), [7, 9, 10, 11].map(c), undefined, 'n2o');
  b.next();
  const nzImm = b.op1(orN(2), [c(12), nzRs2], 'imm ≠ 0', 'nzimm');
  const zRd = b.op1(NOT, [nzRd], undefined, 'zrd');
  const zRs2 = b.op1(NOT, [nzRs2], undefined, 'zrs2');
  const nc12 = b.op1(NOT, [c(12)], undefined, 'nc12');
  const is2 = b.op1(AND, [c(8), b.op1(NOT, [not2], undefined, 'n2n')], 'rd = 2', 'is2');
  b.next();
  const isnt2 = b.op1(NOT, [is2], undefined, 'isnt2');
  b.next();
  const Q = (i: number) => `${q}.y${i}`, F = (i: number) => `${f3}.y${i}`;
  const cond: Record<string, string[]> = {
    'c.addi4spn': [Q(0), F(0), nzU], 'c.lw': [Q(0), F(2)], 'c.flw': [Q(0), F(3)], 'c.sw': [Q(0), F(6)], 'c.fsw': [Q(0), F(7)],
    'c.addi': [Q(1), F(0)], 'c.jal': [Q(1), F(1)], 'c.li': [Q(1), F(2)],
    'c.addi16sp': [Q(1), F(3), is2, nzImm], 'c.lui': [Q(1), F(3), isnt2, nzImm],
    'c.srli': [Q(1), F(4), `${s10}.y0`, nc12], 'c.srai': [Q(1), F(4), `${s10}.y1`, nc12], 'c.andi': [Q(1), F(4), `${s10}.y2`],
    'c.sub': [Q(1), F(4), `${s10}.y3`, nc12, `${s5}.y0`], 'c.xor': [Q(1), F(4), `${s10}.y3`, nc12, `${s5}.y1`],
    'c.or': [Q(1), F(4), `${s10}.y3`, nc12, `${s5}.y2`], 'c.and': [Q(1), F(4), `${s10}.y3`, nc12, `${s5}.y3`],
    'c.j': [Q(1), F(5)], 'c.beqz': [Q(1), F(6)], 'c.bnez': [Q(1), F(7)],
    'c.slli': [Q(2), F(0), nc12], 'c.lwsp': [Q(2), F(2), nzRd], 'c.flwsp': [Q(2), F(3)],
    'c.jr': [Q(2), F(4), nc12, zRs2, nzRd], 'c.mv': [Q(2), F(4), nc12, nzRs2],
    'c.ebreak': [Q(2), F(4), c(12), zRs2, zRd], 'c.jalr': [Q(2), F(4), c(12), zRs2, nzRd], 'c.add': [Q(2), F(4), c(12), nzRs2],
    'c.swsp': [Q(2), F(6)], 'c.fswsp': [Q(2), F(7)],
  };
  const forms = C_FORM_NAMES.map((n, i) => b.op1(andN(cond[n].length), cond[n], n, `k${i}`));
  b.next();
  const any = b.op1(orN(NF), forms, 'a form', 'any');
  const ill = b.op1(AND, [b.op1(NOT, [Q(3)], undefined, 'cmp'), b.op1(NOT, [any], undefined, 'none')], 'illegal', 'illg');
  b.next();
  b.wire(b.op1(merger(ones(NF + 1)), [...forms, Q(3)], undefined, 'mf'), 'f');
  b.wire(Q(3), 'pass');
  b.wire(ill, 'illegal');
  return define({
    id: 'rvc_forms', name: 'C expander: which form', category: 'routing',
    summary: `Which of the ${NF} 16-bit forms a parcel is, one-hot: the quadrant (bits 1:0) and funct3 (15:13) decoded, ANDed with the few extra bits a form looks at (rd ≠ 0, rs2 ≠ 0, a non-zero immediate, bit 12, bits 11:10 and 6:5). pass: bits 1:0 = 11, a 32-bit instruction. illegal: neither.`,
    ports: [bus('c', 16, 'in'), bus('f', NF + 1, 'out'), bit('pass', 'out'), bit('illegal', 'out')],
    symbol: { kind: 'box', label: 'FORM' },
    spec: ([h]) => {
      const k = formOf(h);
      return [k < 0 ? 0 : 2 ** k, (h & 3) === 3 ? 1 : 0, k < 0 ? 1 : 0];
    },
    netlist: () => ({ pins: edgePins(b, ['c'], ['f', 'pass', 'illegal'], 4), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the expander ---------------------------------------------------------------------------------

/** The instruction the core runs for a 32-bit window (an illegal parcel: 0), and the length bit. */
export function expandWindow(w: number): { instr: number; c: number; illegal: number } {
  if ((w & 3) === 3) return { instr: w >>> 0, c: 0, illegal: 0 };
  const d = decodeC(w & 0xffff);
  return { instr: d ? d.word : 0, c: 1, illegal: d ? 0 : 1 };
}

export const C_EXPAND: ComponentDef = (() => {
  const b = new Builder(14, 14, 4);
  b.pins('w');
  const sw = b.op(splitter([16, 16]), ['w'], undefined, 'sw');
  b.next();
  const fm = b.op(C_FORMS, [`${sw}.o0`], undefined, 'form');
  b.next();
  const fields = C_FIELDS.map((_, i) => b.op1(cField(i), [`${fm}.f`, 'w'], undefined, C_FIELDS[i].name));
  b.next();
  b.wire(b.op1(merger(C_FIELDS.map((f) => f.hi - f.lo + 1)), fields, undefined, 'mi'), 'instr');
  b.wire(b.op1(NOT, [`${fm}.pass`], 'compressed', 'cmp'), 'c');
  b.wire(`${fm}.illegal`, 'illegal');
  return define({
    id: 'c_expand', name: 'C expander', category: 'routing',
    summary: 'Turns the 32 bits at the PC into the instruction the core runs. A 16-bit parcel (bits 1:0 ≠ 11) becomes the 32-bit instruction it stands for, anything else passes through. Mostly wiring: register fields gain a leading 01, immediate bits move. The gates recognize the form and pick each field. c: the instruction is 16 bits (the PC steps by 2). An illegal parcel gives 0.',
    ports: [bus('w', 32, 'in'), bus('instr', 32, 'out'), bit('c', 'out'), bit('illegal', 'out')],
    symbol: { kind: 'box', label: 'C EXPAND' },
    spec: ([w]) => { const e = expandWindow(w); return [e.instr, e.c, e.illegal]; },
    netlist: () => ({ pins: edgePins(b, ['w'], ['instr', 'c', 'illegal'], 4), instances: b.instances, nets: b.nets() }),
  });
})();
