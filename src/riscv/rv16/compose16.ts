// RV16 for the instruction builder: each format's operands and fields (the layout lives in isa16.ts's
// encoders; here it is written out per format, so the strip can name every bit), encode / decode
// through isa16.ts, text through disasm16 and assemble16 (tests/compose-isa.test.ts runs every
// instruction through both).

import { carryParts, clampSlot, parseWithOffsets, wiresOf, type CField, type CGroup, type CInstr, type ComposeIsa, type CSlot, type Parts } from '../../isa/composekit';
import { assemble16, PSEUDO16 } from './asm16';
import { BY_NAME16, CSRS16, decode16, disasm16, encCSR, encI, encJ, encR, encSB, encSH, encSIMT, encSYS, encU, INSTRS16, REG_NAMES16, SIMT_RS1, type Instr16 } from './isa16';

const reg = (key: string, dest = false): CSlot => ({ key, label: key, kind: 'reg', names: REG_NAMES16, min: 0, max: 7, step: 1, dest });
const imm6 = (role: CSlot['role']): CSlot => ({ key: 'imm', label: 'imm', kind: 'num', min: -32, max: 31, step: 1, role });

function slots16(s: Instr16): CSlot[] {
  switch (s.fmt) {
    case 'R': return [reg('rd', true), reg('rs1'), reg('rs2')];
    case 'I': return s.name === 'addi' ? [reg('rd', true), reg('rs1'), imm6('imm')] : [reg('rd', true), imm6('offset'), reg('rs1')];
    case 'SH': return [reg('rd', true), reg('rs1'), { key: 'imm', label: 'shamt', kind: 'num', min: 0, max: 15, step: 1, role: 'shamt' }];
    case 'U': return [reg('rd', true), { key: 'imm', label: 'imm', kind: 'num', min: 0, max: 1023, step: 1, role: 'upper' }];
    case 'B': return [reg('rs1'), reg('rs2'), { ...imm6('target') }];
    case 'J': return [reg('rd', true), { key: 'imm', label: 'imm', kind: 'num', min: -256, max: 255, step: 1, role: 'target' }];
    case 'S': return [reg('rs2'), imm6('offset'), reg('rs1')];
    case 'CSR': return [reg('rd', true), { key: 'csr', label: 'csr', kind: 'enum', options: CSRS16.map((name, value) => ({ name, value })), min: 0, max: 7, step: 1 }, reg('rs1')];
    case 'SIMT': return SIMT_RS1.has(s.name) ? [reg('rs1')] : [];
    case 'SYS': return [];
  }
}

const INSTRS = new Map(INSTRS16.map((s): [string, CInstr] => [s.name, { id: s.name, name: s.name, slots: slots16(s) }]));

function encode16(s: Instr16, p: Parts): number {
  const ins = INSTRS.get(s.name)!;
  const v = (k: string) => {
    const sl = ins.slots.find((x) => x.key === k);
    return sl ? clampSlot(sl, p[k] ?? 0) : 0;
  };
  switch (s.fmt) {
    case 'R': return encR(s.op, s.f3!, v('rd'), v('rs1'), v('rs2'));
    case 'I': return encI(s.op, v('rd'), v('rs1'), v('imm'));
    case 'SH': return encSH(s.sub!, v('rd'), v('rs1'), v('imm'));
    case 'U': return encU(v('rd'), v('imm'));
    case 'B': return encSB(s.op, v('rs1'), v('rs2'), v('imm'));
    case 'J': return encJ(v('rd'), v('imm'));
    case 'S': return encSB(s.op, v('rs1'), v('rs2'), v('imm'));
    case 'CSR': return encCSR(s.f3!, v('rd'), v('csr'), v('rs1'));
    case 'SIMT': return encSIMT(s.f3!, v('rs1'));
    case 'SYS': return encSYS(s.sub!);
  }
}

const F = (key: string, label: string, hi: number, lo: number, role: CField['role'], w: number, meaning = '', used = true): CField =>
  ({ key, label, hi, lo, role, used, meaning, value: (w >> lo) & ((1 << (hi - lo + 1)) - 1) });
const rn = (w: number, lo: number) => { const r = (w >> lo) & 7; return `x${r} (${REG_NAMES16[r]})`; };

function fields16(w: number): CField[] {
  const d = decode16(w), s = d.spec;
  const op = F('op', 'op', 3, 0, 'op', w, s ? `${s.name}` : 'not an RV16 instruction');
  const rd = (used = true) => F('rd', 'rd', 6, 4, 'rd', w, used ? rn(w, 4) : 'ignored', used);
  const rs1 = (used = true) => F('rs1', 'rs1', 9, 7, 'rs', w, used ? rn(w, 7) : 'ignored', used);
  const rs2 = (used = true) => F('rs2', 'rs2', 12, 10, 'rs', w, used ? rn(w, 10) : 'ignored', used);
  const f3 = F('f3', 'f3', 15, 13, 'fn', w, s ? `→ ${s.name}` : '?');
  if (!s) return [f3, rs2(), rs1(), rd(), op];
  const imm = `imm = ${s.fmt === 'U' ? `0x${d.imm.toString(16)}` : d.imm}`;
  switch (s.fmt) {
    case 'R': return [f3, rs2(), rs1(), rd(), op];
    case 'I': return [F('imm', 'imm[5:0]', 15, 10, 'imm', w, imm), rs1(), rd(), op];
    case 'SH': return [F('type', 'type', 15, 14, 'fn', w, ['logical left', 'logical right', 'arithmetic right', '?'][(w >> 14) & 3]), F('imm', 'shamt', 13, 10, 'imm', w, `shift by ${d.imm}`), rs1(), rd(), op];
    case 'U': return [F('imm', 'imm[9:1]', 15, 7, 'imm', w, imm), rd(), F('imm', 'imm[0]', 3, 3, 'imm', w, imm), F('op', 'op', 2, 0, 'op', w, 'lui (op[3] is an immediate bit)')];
    case 'B': case 'S': return [F('imm', 'imm[5:3]', 15, 13, 'imm', w, imm), rs2(), rs1(), F('imm', 'imm[2:0]', 6, 4, 'imm', w, imm), op];
    case 'J': return [F('imm', 'imm[8:0]', 15, 7, 'imm', w, imm), rd(), op];
    case 'CSR': return [f3, F('csr', 'csr', 12, 10, 'imm', w, CSRS16[d.csr] ?? String(d.csr)), rs1(), rd(), op];
    case 'SIMT': return [f3, rs2(false), rs1(SIMT_RS1.has(s.name)), rd(false), op];
    case 'SYS': return [f3, F('sub', 'rs2', 12, 10, 'fn', w, `→ ${s.name}`), rs1(false), rd(false), op];
  }
}

const IMM_SRC: Partial<Record<Instr16['fmt'], { bits: number[]; signed: boolean; shift: number }>> = {
  I: { bits: [15, 14, 13, 12, 11, 10], signed: true, shift: 0 },
  B: { bits: [15, 14, 13, 6, 5, 4], signed: true, shift: 0 },
  S: { bits: [15, 14, 13, 6, 5, 4], signed: true, shift: 0 },
  J: { bits: [15, 14, 13, 12, 11, 10, 9, 8, 7], signed: true, shift: 0 },
  U: { bits: [15, 14, 13, 12, 11, 10, 9, 8, 7, 3], signed: false, shift: 6 },
};

export const GROUPS16: CGroup[] = [
  { name: 'Register', ids: ['add', 'sub', 'and', 'or', 'xor', 'sll', 'srl', 'sra', 'slt', 'sltu'] },
  { name: 'Immediate', ids: ['addi', 'slli', 'srli', 'srai', 'lui'] },
  { name: 'Memory', ids: ['lw', 'sw'] },
  { name: 'Branch · jump', ids: ['beq', 'bne', 'blt', 'bge', 'jal', 'jalr'] },
  { name: 'System', ids: ['ecall', 'ebreak', 'mret', 'wfi', 'csrrw', 'csrrs', 'csrrc'] },
  { name: 'Multiply', ids: ['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu'], more: true },
  { name: 'SIMT (lanes)', ids: ['split', 'join', 'tmc', 'bar'], more: true },
];

const BRANCH16 = new Set(['beqz', 'bnez', 'bltz', 'bgez', 'blez', 'bgtz', 'bgt', 'ble', 'j']);

/** RV16 for the instruction builder. */
export const RV16_COMPOSE: ComposeIsa = {
  id: 'rv16', name: 'RV16', wordBits: 16, step: 1, start: encI(4, 3, 3, -1),
  groups: GROUPS16,
  instr: (id) => INSTRS.get(id),
  encode: (id, parts) => encode16(BY_NAME16.get(id)!, parts),
  decode(word) {
    const w = word & 0xffff;
    const d = decode16(w);
    if (!d.spec) return null;
    const ins = INSTRS.get(d.spec.name)!;
    const all: Parts = { rd: d.rd, rs1: d.rs1, rs2: d.rs2, csr: d.csr, imm: d.spec.fmt === 'U' ? d.imm >> 6 : d.imm };
    const parts = carryParts(all, {}, ins);
    return encode16(d.spec, parts) === w ? { id: d.spec.name, parts } : null;
  },
  fields: fields16,
  imm(word) {
    const d = decode16(word & 0xffff);
    const src = d.spec && IMM_SRC[d.spec.fmt];
    if (!d.spec || !src) return null;
    const note = d.spec.fmt === 'U' ? 'imm[9:0] shifted up 6: the low 6 bits tied to ground'
      : `sign-extended to 16 bits${d.spec.fmt === 'B' || d.spec.fmt === 'J' ? '; a branch offset counts words' : ''}`;
    return { wires: wiresOf(word, src.bits, 16, src.signed, src.shift), value: d.imm, text: d.spec.fmt === 'U' ? `0x${d.imm.toString(16)}` : String(d.imm), note };
  },
  text(word, pc, labels) {
    const d = decode16(word & 0xffff);
    const base = disasm16(word);
    if (pc === undefined || !labels || !d.spec || (d.spec.fmt !== 'B' && d.spec.fmt !== 'J') || base === 'halt') return base;
    for (const [name, at] of labels) if (at === pc + d.imm) return base.replace(/-?\d+$/, name);
    return base;
  },
  parse: (line, pc, labels) => parseWithOffsets(line, assemble16, 16, pc, labels, (op) => {
    const s = BY_NAME16.get(op);
    return s ? s.fmt === 'B' || s.fmt === 'J' : BRANCH16.has(op) && PSEUDO16.includes(op);
  }),
  program(src) {
    const r = assemble16(src);
    return { lines: r.lines, labels: r.labels, errors: r.errors, end: r.words.length };
  },
};
