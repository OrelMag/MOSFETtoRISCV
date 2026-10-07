// The RV16 assembler: two passes, labels, ABI register names, pseudo-instructions, .text / .data
// sections (data labels are data-memory word addresses), .word. Errors are collected per line.
// Shares number, operand and comment syntax with the RV32 assembler.

import { AsmError, commentStart, parseImm, splitArgs } from '../asm';
import {
  BY_NAME16, CSRS16, encCSR, encI, encJ, encR, encSB, encSH, encSYS, encU, hiLo, OP16, reg16,
} from './isa16';

export interface AsmLine16 {
  /** Word address in instruction memory. */
  addr: number;
  word: number;
  text: string;
  srcLine: number;
}

export interface AsmResult16 {
  /** Instruction memory image. */
  words: number[];
  /** Initial data memory (word address → value), from .data. */
  data: Map<number, number>;
  lines: AsmLine16[];
  labels: Map<string, number>;
  errors: { line: number; message: string }[];
}

/** Mnemonics that expand to real instructions (for the highlighter; tests check them against the assembler). */
export const PSEUDO16: readonly string[] = [
  'nop', 'mv', 'not', 'neg', 'seqz', 'snez', 'sltz', 'sgtz', 'li', 'la', 'j', 'jr', 'ret', 'call', 'tail',
  'beqz', 'bnez', 'bltz', 'bgez', 'blez', 'bgtz', 'bgt', 'ble', 'csrr', 'csrw', 'csrs', 'csrc', 'push', 'pop', 'halt', 'exit',
];
export const DIRECTIVES16: readonly string[] = ['.word', '.text', '.data', '.globl', '.global', '.align'];

const fits6 = (v: number) => v >= -32 && v <= 31;

interface Stmt { line: number; op: string; args: string[]; text: string; addr: number; size: number; data: boolean }

/** Words a statement takes (decided in pass 1, before labels are known). */
function sizeOf(op: string, args: string[]): number {
  if (op === 'li') {
    try {
      const v = parseImm(args[1] ?? '0');
      return fits6(v) || (v & 63) === 0 ? 1 : 2;
    } catch {
      return 2;
    }
  }
  if (op === 'la' || op === 'push' || op === 'pop') return 2;
  if (op === 'not') return 2;
  if (op === 'seqz') return 3;
  if (op === '.word') return Math.max(1, args.length);
  return 1;
}

export function assemble16(src: string): AsmResult16 {
  const stmts: Stmt[] = [];
  const labels = new Map<string, number>();
  const errors: { line: number; message: string }[] = [];
  let text = 0, data = 0, inData = false;

  src.split(/\r?\n/).forEach((raw, i) => {
    let ln = raw.slice(0, commentStart(raw)).trim();
    for (;;) {
      const m = ln.match(/^([A-Za-z_.$][\w.$]*)\s*:/);
      if (!m) break;
      if (labels.has(m[1])) errors.push({ line: i + 1, message: `label "${m[1]}" defined twice` });
      labels.set(m[1], inData ? data : text);
      ln = ln.slice(m[0].length).trim();
    }
    if (!ln) return;
    const sp = ln.search(/\s/);
    const op = (sp < 0 ? ln : ln.slice(0, sp)).toLowerCase();
    if (op === '.text') { inData = false; return; }
    if (op === '.data') { inData = true; return; }
    if (op === '.globl' || op === '.global' || op === '.align') return;
    const args = splitArgs(sp < 0 ? '' : ln.slice(sp + 1));
    if (inData && op !== '.word') {
      errors.push({ line: i + 1, message: 'only .word data in the .data section' });
      return;
    }
    const size = sizeOf(op, args);
    stmts.push({ line: i + 1, op, args, text: ln, addr: inData ? data : text, size, data: inData });
    if (inData) data += size;
    else text += size;
  });

  const words: number[] = [];
  const dataMem = new Map<number, number>();
  const lines: AsmLine16[] = [];
  for (const st of stmts) {
    try {
      const out = encode16(st, labels);
      if (out.length !== st.size) throw new AsmError('internal: size mismatch');
      out.forEach((w, k) => {
        if (st.data) dataMem.set(st.addr + k, w & 0xffff);
        else {
          words.push(w & 0xffff);
          lines.push({ addr: st.addr + k, word: w & 0xffff, text: st.text, srcLine: st.line });
        }
      });
    } catch (e) {
      errors.push({ line: st.line, message: e instanceof Error ? e.message : String(e) });
      for (let k = 0; k < st.size; k++) {
        if (st.data) dataMem.set(st.addr + k, 0);
        else {
          words.push(0x0004);
          lines.push({ addr: st.addr + k, word: 0x0004, text: st.text, srcLine: st.line });
        }
      }
    }
  }
  return { words, data: dataMem, lines, labels, errors };
}

function encode16(st: Stmt, labels: Map<string, number>): number[] {
  const { op, args, addr } = st;
  const need = (n: number) => {
    if (args.length !== n) throw new AsmError(`${op} expects ${n} operand${n === 1 ? '' : 's'}, got ${args.length}`);
  };
  const reg = (s: string | undefined) => {
    const r = s === undefined ? null : reg16(s);
    if (r === null) throw new AsmError(`not a register: "${s ?? ''}" (x0–x7, zero, ra, sp, a0–a2, t0–t1)`);
    return r;
  };
  const value = (s: string) => {
    const t = s.trim();
    return labels.has(t) ? labels.get(t)! : parseImm(t);
  };
  const imm6 = (s: string) => {
    const v = value(s);
    if (!fits6(v)) throw new AsmError(`immediate ${v} out of range −32…31 (use li for larger constants)`);
    return v;
  };
  const target = (s: string, bits: number) => {
    const t = s.trim();
    const off = labels.has(t) ? labels.get(t)! - addr : parseImm(t);
    const lim = 2 ** (bits - 1);
    if (off < -lim || off >= lim) throw new AsmError(`target out of range (${off} words; ${bits === 6 ? 'branches reach −32…31: branch over a j instead' : 'jal reaches −256…255'})`);
    return off;
  };
  const mem = (s: string) => {
    const m = s.trim().match(/^(.*)\(\s*([\w]+)\s*\)$/);
    if (!m) throw new AsmError(`expected offset(register), got "${s}"`);
    return { off: m[1].trim() ? imm6(m[1]) : 0, base: reg(m[2]) };
  };
  const csr = (s: string) => {
    const t = s.trim().toLowerCase();
    const i = CSRS16.indexOf(t);
    if (i >= 0) return i;
    const v = parseImm(t);
    if (v < 0 || v > 7) throw new AsmError(`not a CSR: ${s} (${CSRS16.join(', ')})`);
    return v;
  };
  const li = (rd: number, v: number): number[] => {
    if (fits6(v)) return [encI(OP16.ADDI, rd, 0, v)];
    const { hi, lo } = hiLo(v);
    if (lo === 0) return [encU(rd, hi)];
    return [encU(rd, hi), encI(OP16.ADDI, rd, rd, lo)];
  };
  const B = (o: number, rs1: number, rs2: number, t: string) => [encSB(o, rs1, rs2, target(t, 6))];

  switch (op) {
    case 'nop': need(0); return [encI(OP16.ADDI, 0, 0, 0)];
    case 'mv': need(2); return [encI(OP16.ADDI, reg(args[0]), reg(args[1]), 0)];
    case 'neg': need(2); return [encR(OP16.OPX, 0, reg(args[0]), 0, reg(args[1]))];
    case 'not': { need(2); const rd = reg(args[0]); return [encR(OP16.OPX, 0, rd, 0, reg(args[1])), encI(OP16.ADDI, rd, rd, -1)]; }
    case 'snez': need(2); return [encR(OP16.OP, 3, reg(args[0]), 0, reg(args[1]))];
    case 'seqz': {
      need(2);
      const rd = reg(args[0]);
      return [encR(OP16.OP, 3, rd, 0, reg(args[1])), encI(OP16.ADDI, rd, rd, -1), encR(OP16.OPX, 0, rd, 0, rd)];
    }
    case 'sltz': need(2); return [encR(OP16.OP, 2, reg(args[0]), reg(args[1]), 0)];
    case 'sgtz': need(2); return [encR(OP16.OP, 2, reg(args[0]), 0, reg(args[1]))];
    case 'li': {
      need(2);
      const rd = reg(args[0]), v = parseImm(args[1]);
      if (v < -32768 || v > 0xffff) throw new AsmError(`${v} does not fit in 16 bits`);
      const out = li(rd, v);
      return out;
    }
    case 'la': {
      need(2);
      const rd = reg(args[0]);
      const { hi, lo } = hiLo(value(args[1]));
      return [encU(rd, hi), encI(OP16.ADDI, rd, rd, lo)];
    }
    case 'j': need(1); return [encJ(0, target(args[0], 9))];
    case 'tail': need(1); return [encJ(0, target(args[0], 9))];
    case 'call': need(1); return [encJ(1, target(args[0], 9))];
    case 'jr': need(1); return [encI(OP16.JALR, 0, reg(args[0]), 0)];
    case 'ret': need(0); return [encI(OP16.JALR, 0, 1, 0)];
    case 'halt': need(0); return [encJ(0, 0)];
    case 'exit': need(1); return [encSB(OP16.SW, 0, reg(args[0]), -1)];
    case 'beqz': need(2); return B(OP16.BEQ, reg(args[0]), 0, args[1]);
    case 'bnez': need(2); return B(OP16.BNE, reg(args[0]), 0, args[1]);
    case 'bltz': need(2); return B(OP16.BLT, reg(args[0]), 0, args[1]);
    case 'bgez': need(2); return B(OP16.BGE, reg(args[0]), 0, args[1]);
    case 'blez': need(2); return B(OP16.BGE, 0, reg(args[0]), args[1]);
    case 'bgtz': need(2); return B(OP16.BLT, 0, reg(args[0]), args[1]);
    case 'bgt': need(3); return B(OP16.BLT, reg(args[1]), reg(args[0]), args[2]);
    case 'ble': need(3); return B(OP16.BGE, reg(args[1]), reg(args[0]), args[2]);
    case 'csrr': need(2); return [encCSR(2, reg(args[0]), csr(args[1]), 0)];
    case 'csrw': need(2); return [encCSR(1, 0, csr(args[0]), reg(args[1]))];
    case 'csrs': need(2); return [encCSR(2, 0, csr(args[0]), reg(args[1]))];
    case 'csrc': need(2); return [encCSR(3, 0, csr(args[0]), reg(args[1]))];
    case 'push': { need(1); return [encI(OP16.ADDI, 2, 2, -1), encSB(OP16.SW, 2, reg(args[0]), 0)]; }
    case 'pop': { need(1); return [encI(OP16.LW, reg(args[0]), 2, 0), encI(OP16.ADDI, 2, 2, 1)]; }
    case '.word': return args.map((a) => {
      const v = value(a);
      if (v < -32768 || v > 0xffff) throw new AsmError(`${v} does not fit in 16 bits`);
      return v & 0xffff;
    });
  }

  const spec = BY_NAME16.get(op);
  if (!spec) throw new AsmError(`unknown instruction "${op}"`);
  switch (spec.fmt) {
    case 'R': need(3); return [encR(spec.op, spec.f3!, reg(args[0]), reg(args[1]), reg(args[2]))];
    case 'SH': {
      need(3);
      const sh = value(args[2]);
      if (sh < 0 || sh > 15) throw new AsmError(`shift amount ${sh} out of range 0…15`);
      return [encSH(spec.sub!, reg(args[0]), reg(args[1]), sh)];
    }
    case 'U': {
      need(2);
      const v = value(args[1]);
      if (v < 0 || v > 1023) throw new AsmError(`lui takes 0…1023 (the value is that × 64)`);
      return [encU(reg(args[0]), v)];
    }
    case 'B': need(3); return B(spec.op, reg(args[0]), reg(args[1]), args[2]);
    case 'J':
      if (args.length === 1) return [encJ(1, target(args[0], 9))];
      need(2);
      return [encJ(reg(args[0]), target(args[1], 9))];
    case 'S': { need(2); const m = mem(args[1]); return [encSB(OP16.SW, m.base, reg(args[0]), m.off)]; }
    case 'SYS': need(0); return [encSYS(spec.sub!)];
    case 'CSR': need(3); return [encCSR(spec.f3!, reg(args[0]), csr(args[1]), reg(args[2]))];
    case 'I': {
      if (op === 'lw' || (op === 'jalr' && args.length === 2 && args[1].includes('('))) {
        need(2);
        const m = mem(args[1]);
        return [encI(spec.op, reg(args[0]), m.base, m.off)];
      }
      if (op === 'jalr' && args.length === 1) return [encI(spec.op, 1, reg(args[0]), 0)];
      need(3);
      return [encI(spec.op, reg(args[0]), reg(args[1]), imm6(args[2]))];
    }
  }
  throw new AsmError(`cannot encode "${op}"`);
}
