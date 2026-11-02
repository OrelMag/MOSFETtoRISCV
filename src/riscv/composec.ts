// The instruction builder for the C extension: a 16-bit instruction as a form plus its operands, both ways. Built on
// riscv/rvc.ts's decoder (decodeC: what a parcel is) and the assembler's c.* mnemonics (what spells it), so a composed
// parcel is exactly what `c.addi a0, 5` assembles to: tests/compose.test.ts runs every form through both. DOM-free.

import { assemble } from './asm';
import { ABI } from './isa';
import { type CDecoded, type CFmt, decodeC, disasmC } from './rvc';
import { parseWithOffsets, type CField, type CInstr, type ComposeIsa, type CSlot, type Parts, type ParseResult, type Role } from '../isa/composekit';

type Kind = 'reg' | 'rego' | 'imm' | 'offset' | 'target' | 'upper';
interface Op {
  key: string;
  kind: Kind;
  /** reg: x8–x15 only (the 3-bit register fields). */
  prime?: boolean;
  /** reg: not x0 (the form means something else, or nothing, for x0). */
  nonzero?: boolean;
  min?: number;
  max?: number;
  step?: number;
}

/** One form: the c.* mnemonic, its operands in assembly order, and how a decoded parcel gives them. */
interface Form {
  name: string;
  group: string;
  ops: Op[];
  /** The operand text after the mnemonic. */
  text(p: Parts): string;
  /** The decoded parcel's operands. */
  from(d: CDecoded): Parts;
  summary: string;
}

const reg = (key: string, prime = false, nonzero = false): Op => ({ key, kind: 'reg', prime, nonzero });
const num = (key: string, kind: Kind, min: number, max: number, step = 1): Op => ({ key, kind, min, max, step });
const r = (n: number) => ABI[n];

const FORMS: Form[] = [
  { name: 'c.nop', group: 'Arithmetic', ops: [], text: () => '', from: () => ({}), summary: 'addi x0, x0, 0' },
  { name: 'c.addi', group: 'Arithmetic', ops: [reg('rd', false, true), num('imm', 'imm', -32, 31)], text: (p) => `${r(p.rd)}, ${p.imm}`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'addi rd, rd, imm (imm ≠ 0)' },
  { name: 'c.li', group: 'Arithmetic', ops: [reg('rd', false, true), num('imm', 'imm', -32, 31)], text: (p) => `${r(p.rd)}, ${p.imm}`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'addi rd, x0, imm' },
  { name: 'c.lui', group: 'Arithmetic', ops: [reg('rd', false, true), num('imm', 'upper', -32, 31)], text: (p) => `${r(p.rd)}, 0x${(p.imm & 0xfffff).toString(16)}`, from: (d) => ({ rd: d.rd, imm: d.imm >> 12 }), summary: 'lui rd, imm (rd ≠ sp, imm ≠ 0)' },
  { name: 'c.addi16sp', group: 'Arithmetic', ops: [num('imm', 'imm', -512, 496, 16)], text: (p) => `sp, ${p.imm}`, from: (d) => ({ imm: d.imm }), summary: 'addi sp, sp, 16·n' },
  { name: 'c.addi4spn', group: 'Arithmetic', ops: [reg('rd', true), num('imm', 'imm', 4, 1020, 4)], text: (p) => `${r(p.rd)}, sp, ${p.imm}`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'addi rd′, sp, 4·n (a stack address)' },
  { name: 'c.slli', group: 'Shift · logic', ops: [reg('rd', false, true), num('imm', 'imm', 1, 31)], text: (p) => `${r(p.rd)}, ${p.imm}`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'slli rd, rd, shamt' },
  { name: 'c.srli', group: 'Shift · logic', ops: [reg('rd', true), num('imm', 'imm', 1, 31)], text: (p) => `${r(p.rd)}, ${p.imm}`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'srli rd′, rd′, shamt' },
  { name: 'c.srai', group: 'Shift · logic', ops: [reg('rd', true), num('imm', 'imm', 1, 31)], text: (p) => `${r(p.rd)}, ${p.imm}`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'srai rd′, rd′, shamt' },
  { name: 'c.andi', group: 'Shift · logic', ops: [reg('rd', true), num('imm', 'imm', -32, 31)], text: (p) => `${r(p.rd)}, ${p.imm}`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'andi rd′, rd′, imm' },
  { name: 'c.mv', group: 'Register', ops: [reg('rd', false, true), reg('rs2', false, true)], text: (p) => `${r(p.rd)}, ${r(p.rs2)}`, from: (d) => ({ rd: d.rd, rs2: d.rs2 }), summary: 'add rd, x0, rs2' },
  { name: 'c.add', group: 'Register', ops: [reg('rd', false, true), reg('rs2', false, true)], text: (p) => `${r(p.rd)}, ${r(p.rs2)}`, from: (d) => ({ rd: d.rd, rs2: d.rs2 }), summary: 'add rd, rd, rs2' },
  ...(['sub', 'xor', 'or', 'and'] as const).map((n): Form => ({ name: `c.${n}`, group: 'Register', ops: [reg('rd', true), reg('rs2', true)], text: (p) => `${r(p.rd)}, ${r(p.rs2)}`, from: (d) => ({ rd: d.rd, rs2: d.rs2 }), summary: `${n} rd′, rd′, rs2′` })),
  { name: 'c.lw', group: 'Memory', ops: [reg('rd', true), num('imm', 'offset', 0, 124, 4), reg('rs1', true)], text: (p) => `${r(p.rd)}, ${p.imm}(${r(p.rs1)})`, from: (d) => ({ rd: d.rd, imm: d.imm, rs1: d.rs1 }), summary: 'lw rd′, 4·n(rs1′)' },
  { name: 'c.sw', group: 'Memory', ops: [reg('rs2', true), num('imm', 'offset', 0, 124, 4), reg('rs1', true)], text: (p) => `${r(p.rs2)}, ${p.imm}(${r(p.rs1)})`, from: (d) => ({ rs2: d.rs2, imm: d.imm, rs1: d.rs1 }), summary: 'sw rs2′, 4·n(rs1′)' },
  { name: 'c.lwsp', group: 'Memory', ops: [reg('rd', false, true), num('imm', 'offset', 0, 252, 4)], text: (p) => `${r(p.rd)}, ${p.imm}(sp)`, from: (d) => ({ rd: d.rd, imm: d.imm }), summary: 'lw rd, 4·n(sp)' },
  { name: 'c.swsp', group: 'Memory', ops: [reg('rs2'), num('imm', 'offset', 0, 252, 4)], text: (p) => `${r(p.rs2)}, ${p.imm}(sp)`, from: (d) => ({ rs2: d.rs2, imm: d.imm }), summary: 'sw rs2, 4·n(sp)' },
  { name: 'c.j', group: 'Jump · branch', ops: [num('imm', 'target', -2048, 2046, 2)], text: (p) => `${p.imm}`, from: (d) => ({ imm: d.imm }), summary: 'jal x0, offset' },
  { name: 'c.jal', group: 'Jump · branch', ops: [num('imm', 'target', -2048, 2046, 2)], text: (p) => `${p.imm}`, from: (d) => ({ imm: d.imm }), summary: 'jal ra, offset' },
  { name: 'c.jr', group: 'Jump · branch', ops: [reg('rs1', false, true)], text: (p) => `${r(p.rs1)}`, from: (d) => ({ rs1: d.rs1 }), summary: 'jalr x0, 0(rs1)' },
  { name: 'c.jalr', group: 'Jump · branch', ops: [reg('rs1', false, true)], text: (p) => `${r(p.rs1)}`, from: (d) => ({ rs1: d.rs1 }), summary: 'jalr ra, 0(rs1)' },
  { name: 'c.beqz', group: 'Jump · branch', ops: [reg('rs1', true), num('imm', 'target', -256, 254, 2)], text: (p) => `${r(p.rs1)}, ${p.imm}`, from: (d) => ({ rs1: d.rs1, imm: d.imm }), summary: 'beq rs1′, x0, offset' },
  { name: 'c.bnez', group: 'Jump · branch', ops: [reg('rs1', true), num('imm', 'target', -256, 254, 2)], text: (p) => `${r(p.rs1)}, ${p.imm}`, from: (d) => ({ rs1: d.rs1, imm: d.imm }), summary: 'bne rs1′, x0, offset' },
  { name: 'c.ebreak', group: 'Jump · branch', ops: [], text: () => '', from: () => ({}), summary: 'ebreak' },
];
const BY = new Map(FORMS.map((f) => [f.name, f]));

const PRIME = ABI.slice(8, 16);

function cslot(o: Op): CSlot {
  if (o.kind === 'reg') {
    return { key: o.key, label: o.key, kind: 'reg', names: o.prime ? PRIME : ABI, min: 0, max: o.prime ? 7 : 31, step: 1, dest: o.key === 'rd' };
  }
  return { key: o.key, label: o.key, kind: 'num', min: o.min!, max: o.max!, step: o.step!, role: o.kind === 'imm' ? 'imm' : o.kind === 'offset' ? 'offset' : o.kind === 'target' ? 'target' : 'upper' };
}

const CINSTRS = new Map(FORMS.map((f): [string, CInstr] => [f.name, { id: f.name, name: f.name, summary: f.summary, slots: f.ops.map(cslot) }]));

/** The builder keeps primed registers as 0…7 (the field) and the others as 0…31; the assembler wants numbers 8…15. */
const toReal = (f: Form, p: Parts): Parts => {
  const q: Parts = { ...p };
  for (const o of f.ops) if (o.kind === 'reg') {
    let v = Math.max(0, Math.min(o.prime ? 7 : 31, Math.round(p[o.key] ?? 0)));
    if (o.prime) v += 8;
    else if (o.nonzero && v === 0) v = 1;
    if (f.name === 'c.addi16sp') v = 2;
    q[o.key] = v;
  }
  for (const o of f.ops) if (o.kind !== 'reg') {
    let v = Math.max(o.min!, Math.min(o.max!, Math.round(p[o.key] ?? 0)));
    if (o.step! > 1) v -= (((v - o.min!) % o.step!) + o.step!) % o.step!;
    if (f.name === 'c.addi' && v === 0) v = 1;
    if ((f.name === 'c.lui' || f.name === 'c.addi16sp' || f.name === 'c.addi4spn') && v === 0) v = o.step!;
    q[o.key] = v;
  }
  return q;
};

/** The parcel of a form with operands (clamped into what the form can hold). */
export function encodeC16(id: string, parts: Parts): number {
  const f = BY.get(id)!;
  const q = toReal(f, parts);
  const src = `${f.name} ${f.text(q)}`.trim();
  const a = assemble(src);
  if (a.errors.length) throw new Error(a.errors[0].message);
  return a.words[0] & 0xffff;
}

/** A parcel as form + operands (null: none matches, or the builder would set other bits). */
export function decodeC16(half: number): { id: string; parts: Parts } | null {
  const d = decodeC(half & 0xffff);
  if (!d) return null;
  const f = BY.get(d.name);
  if (!f) return null; // c.flw and friends: not in the builder
  const raw = f.from(d);
  const parts: Parts = {};
  for (const o of f.ops) parts[o.key] = o.kind === 'reg' && o.prime ? raw[o.key] - 8 : raw[o.key];
  const back = encodeC16(f.name, parts);
  return back === (half & 0xffff) ? { id: f.name, parts } : null;
}

// ---- the strip: the parcel's bits by form -------------------------------------------------------------------

type Layout = [key: string, label: string, hi: number, lo: number, role: Role][];
const L = (...x: [string, string, number, number, Role][]): Layout => x;
const LAYOUT: Record<CFmt, Layout> = {
  CR: L(['funct4', 'funct4', 15, 12, 'fn'], ['rd', 'rd / rs1', 11, 7, 'rd'], ['rs2', 'rs2', 6, 2, 'rs'], ['op', 'op', 1, 0, 'op']),
  CI: L(['funct3', 'funct3', 15, 13, 'fn'], ['imm5', 'imm[5]', 12, 12, 'imm'], ['rd', 'rd / rs1', 11, 7, 'rd'], ['imm', 'imm[4:0]', 6, 2, 'imm'], ['op', 'op', 1, 0, 'op']),
  CSS: L(['funct3', 'funct3', 15, 13, 'fn'], ['imm', 'imm', 12, 7, 'imm'], ['rs2', 'rs2', 6, 2, 'rs'], ['op', 'op', 1, 0, 'op']),
  CIW: L(['funct3', 'funct3', 15, 13, 'fn'], ['imm', 'imm', 12, 5, 'imm'], ['rd', "rd′", 4, 2, 'rd'], ['op', 'op', 1, 0, 'op']),
  CL: L(['funct3', 'funct3', 15, 13, 'fn'], ['imm', 'imm', 12, 10, 'imm'], ['rs1', "rs1′", 9, 7, 'rs'], ['imm2', 'imm', 6, 5, 'imm'], ['rd', "rd′", 4, 2, 'rd'], ['op', 'op', 1, 0, 'op']),
  CS: L(['funct3', 'funct3', 15, 13, 'fn'], ['imm', 'imm', 12, 10, 'imm'], ['rs1', "rs1′", 9, 7, 'rs'], ['imm2', 'imm', 6, 5, 'imm'], ['rs2', "rs2′", 4, 2, 'rs'], ['op', 'op', 1, 0, 'op']),
  CA: L(['funct6', 'funct6', 15, 10, 'fn'], ['rd', "rd′ / rs1′", 9, 7, 'rd'], ['funct2', 'funct2', 6, 5, 'fn'], ['rs2', "rs2′", 4, 2, 'rs'], ['op', 'op', 1, 0, 'op']),
  CB: L(['funct3', 'funct3', 15, 13, 'fn'], ['imm', 'offset', 12, 10, 'imm'], ['rs1', "rs1′", 9, 7, 'rs'], ['imm2', 'offset', 6, 2, 'imm'], ['op', 'op', 1, 0, 'op']),
  CJ: L(['funct3', 'funct3', 15, 13, 'fn'], ['imm', 'jump target', 12, 2, 'imm'], ['op', 'op', 1, 0, 'op']),
};

function fieldsC(word: number): CField[] {
  const h = word & 0xffff;
  const d = decodeC(h);
  const fmt: CFmt = d?.fmt ?? 'CI';
  let layout = LAYOUT[fmt];
  // CB's shifts and andi: funct3, imm[5], funct2, rd′, imm[4:0]
  if (d && fmt === 'CB' && d.name !== 'c.beqz' && d.name !== 'c.bnez') layout = L(['funct3', 'funct3', 15, 13, 'fn'], ['imm5', 'imm[5]', 12, 12, 'imm'], ['funct2', 'funct2', 11, 10, 'fn'], ['rd', "rd′", 9, 7, 'rd'], ['imm', 'imm[4:0]', 6, 2, 'imm'], ['op', 'op', 1, 0, 'op']);
  return layout.map(([key, label, hi, lo, role]): CField => {
    const value = (h >>> lo) & ((1 << (hi - lo + 1)) - 1);
    const meaning = !d ? '?'
      : role === 'op' ? `quadrant ${value} (${d.fmt}): ${d.name}`
      : role === 'fn' ? `→ ${d.name}`
      : role === 'imm' ? `part of the immediate ${d.imm}`
      : /′/.test(label) ? `${ABI[8 + value]} (x${8 + value})` : `${ABI[value]} (x${value})`;
    return { key, label, hi, lo, role, used: true, meaning, value };
  });
}

/** C for the instruction builder: 16-bit parcels, one instruction at a time (step 2). */
export const RVC_COMPOSE: ComposeIsa = (() => {
  const groups: { name: string; ids: string[] }[] = [];
  for (const f of FORMS) {
    const g = groups.find((x) => x.name === f.group);
    if (g) g.ids.push(f.name);
    else groups.push({ name: f.group, ids: [f.name] });
  }
  const asm = (src: string) => {
    const a = assemble(`.option rvc\n${src}`);
    return { words: a.words.map((w) => w >>> 0), errors: a.errors.map((e) => ({ message: e.message })) };
  };
  const parse = (line: string, pc = 0, labels?: Map<string, number>): ParseResult => {
    const res = parseWithOffsets(line, (s) => {
      const a = asm(s);
      // one parcel (the second half of the word is c.nop's padding), or a 32-bit instruction with no 16-bit form
      if (!a.errors.length && a.words.length === 1) {
        const w = a.words[0];
        return (w & 3) === 3 ? { words: [], errors: [{ message: 'That instruction has no 16-bit form' }] } : { words: [w & 0xffff], errors: [] };
      }
      return a;
    }, 16, pc, labels, (op) => /^c\.(j|jal|beqz|bnez)$/.test(op) || /^(j|jal|beqz|bnez)$/.test(op));
    return res;
  };
  return {
    id: 'asmc', name: 'RV32C', wordBits: 16, step: 2, groups, rv32: false, start: 0x4501,
    instr: (id) => CINSTRS.get(id),
    encode: (id, parts) => encodeC16(id, parts),
    decode: (word) => decodeC16(word),
    loose: (word) => decodeC16(word),
    fields: fieldsC,
    imm: () => null,
    text(word, pc, labels) {
      const h = word & 0xffff, base = disasmC(h);
      const d = decodeC(h);
      if (pc === undefined || !labels || !d || !/^c\.(j|jal|beqz|bnez)$/.test(d.name)) return base;
      for (const [name, addr] of labels) if (addr === pc + d.imm) return base.replace(/-?\d+$/, name);
      return base;
    },
    parse,
    program(src) {
      const a = assemble(src);
      const lines = a.lines.map((l) => ({ addr: l.addr, word: l.size === 2 ? l.word : l.word, srcLine: l.srcLine }));
      return { lines, labels: a.labels, errors: a.errors, end: a.words.length * 4 };
    },
  };
})();
