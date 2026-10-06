// A two-pass RV32I assembler: labels, ABI register names, the common pseudo-instructions and
// .word. Errors are collected per line instead of thrown, so the editor can show them all.

import { BY_NAME, CSRS, encB, encI, encJ, encR, encS, encU, OPCODES, regNumber } from './isa';

export interface AsmLine {
  addr: number;
  word: number;
  /** Source text this word came from (pseudo-instructions produce several words). */
  text: string;
  srcLine: number;
}

export interface AsmResult {
  words: number[];
  lines: AsmLine[];
  labels: Map<string, number>;
  errors: { line: number; message: string }[];
}

interface Stmt {
  line: number;
  op: string;
  args: string[];
  text: string;
  addr: number;
  size: number;
}

class AsmError extends Error {}

function parseImm(s: string): number {
  const t = s.trim().toLowerCase().replace(/_/g, '');
  let v: number;
  if (/^-?0x[0-9a-f]+$/.test(t)) v = t.startsWith('-') ? -parseInt(t.slice(3), 16) : parseInt(t.slice(2), 16);
  else if (/^-?0b[01]+$/.test(t)) v = t.startsWith('-') ? -parseInt(t.slice(3), 2) : parseInt(t.slice(2), 2);
  else if (/^-?\d+$/.test(t)) v = parseInt(t, 10);
  else if (/^'.'$/.test(s.trim())) v = s.trim().charCodeAt(1);
  else throw new AsmError(`not a number: "${s.trim()}"`);
  return v;
}

const fitsI = (v: number) => v >= -2048 && v <= 2047;

/** Number of words a statement assembles to (decided in pass 1). */
function sizeOf(op: string, args: string[]): number {
  if (op === 'li') {
    try {
      const v = parseImm(args[1] ?? '0') | 0;
      return fitsI(v) ? 1 : (v & 0xfff) === 0 ? 1 : 2;
    } catch {
      return 2;
    }
  }
  if (op === 'la' || op === 'call' || op === 'tail') return 2;
  if (op === '.word') return Math.max(1, args.length);
  return 1;
}

/** Split operands on commas that are not inside a character literal. */
function splitArgs(s: string): string[] {
  if (!s.trim()) return [];
  const out: string[] = [];
  let cur = '', q = false;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (ch === ',' && !q) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** Remove a trailing comment (#, // or ;) that is not inside a character literal. */
function stripComment(line: string): string {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") q = !q;
    if (q) continue;
    if (ch === '#' || ch === ';' || (ch === '/' && line[i + 1] === '/')) return line.slice(0, i);
  }
  return line;
}

export function assemble(src: string): AsmResult {
  const stmts: Stmt[] = [];
  const labels = new Map<string, number>();
  const errors: { line: number; message: string }[] = [];
  let addr = 0;

  // Pass 1: strip comments, collect labels, size every statement.
  src.split(/\r?\n/).forEach((raw, i) => {
    let ln = stripComment(raw).trim();
    while (true) {
      const m = ln.match(/^([A-Za-z_.$][\w.$]*)\s*:/);
      if (!m) break;
      if (labels.has(m[1])) errors.push({ line: i + 1, message: `label "${m[1]}" defined twice` });
      labels.set(m[1], addr);
      ln = ln.slice(m[0].length).trim();
    }
    if (!ln) return;
    const sp = ln.search(/\s/);
    const op = (sp < 0 ? ln : ln.slice(0, sp)).toLowerCase();
    if (op === '.text' || op === '.globl' || op === '.global' || op === '.section' || op === '.align') return;
    const args = splitArgs(sp < 0 ? '' : ln.slice(sp + 1));
    const size = sizeOf(op, args);
    stmts.push({ line: i + 1, op, args, text: ln, addr, size });
    addr += 4 * size;
  });

  // Pass 2: encode.
  const words: number[] = [];
  const lines: AsmLine[] = [];
  for (const st of stmts) {
    try {
      const out = encode(st, labels);
      if (out.length !== st.size) throw new AsmError('internal: size mismatch');
      out.forEach((w, k) => {
        words.push(w >>> 0);
        lines.push({ addr: st.addr + 4 * k, word: w >>> 0, text: st.text, srcLine: st.line });
      });
    } catch (e) {
      errors.push({ line: st.line, message: e instanceof Error ? e.message : String(e) });
      for (let k = 0; k < st.size; k++) {
        words.push(0x00000013);
        lines.push({ addr: st.addr + 4 * k, word: 0x13, text: st.text, srcLine: st.line });
      }
    }
  }
  return { words, lines, labels, errors };
}

function encode(st: Stmt, labels: Map<string, number>): number[] {
  const { op, args, addr } = st;
  const need = (n: number) => {
    if (args.length !== n) throw new AsmError(`${op} expects ${n} operand${n === 1 ? '' : 's'}, got ${args.length}`);
  };
  const reg = (s: string | undefined) => {
    const r = s === undefined ? null : regNumber(s);
    if (r === null) throw new AsmError(`not a register: "${s ?? ''}"`);
    return r;
  };
  const imm = (s: string, lo: number, hi: number) => {
    const v = labels.has(s.trim()) ? labels.get(s.trim())! : parseImm(s);
    if (v < lo || v > hi) throw new AsmError(`immediate ${v} out of range [${lo}, ${hi}]`);
    return v;
  };
  const target = (s: string, bits: number) => {
    const t = s.trim();
    let off: number;
    if (labels.has(t)) off = labels.get(t)! - addr;
    else off = parseImm(t);
    if (off % 2) throw new AsmError('branch / jump offset must be even');
    const lim = 2 ** (bits - 1);
    if (off < -lim || off >= lim) throw new AsmError(`target out of range (${off} bytes)`);
    return off;
  };
  const mem = (s: string) => {
    const m = s.trim().match(/^(.*)\(\s*([\w]+)\s*\)$/);
    if (!m) throw new AsmError(`expected offset(register), got "${s}"`);
    return { off: m[1].trim() ? imm(m[1], -2048, 2047) : 0, base: reg(m[2]) };
  };
  const value = (s: string) => {
    const t = s.trim();
    return labels.has(t) ? labels.get(t)! : parseImm(t);
  };
  const hiLo = (v: number) => {
    const lo = ((v & 0xfff) ^ 0x800) - 0x800; // sign-extended low 12 bits
    const hi = ((v - lo) >>> 12) & 0xfffff;
    return { hi, lo };
  };

  const csr = (s: string) => {
    const t = s.trim().toLowerCase();
    if (t in CSRS) return CSRS[t];
    const v = parseImm(t);
    if (v < 0 || v > 0xfff) throw new AsmError(`CSR address out of range: ${s}`);
    return v;
  };
  const csrOps: Record<string, number> = { csrrw: 1, csrrs: 2, csrrc: 3, csrrwi: 5, csrrsi: 6, csrrci: 7 };
  if (op in csrOps) {
    need(3);
    const f3 = csrOps[op];
    const src = f3 & 4 ? imm(args[2], 0, 31) : reg(args[2]);
    return [encI(OPCODES.SYSTEM, reg(args[0]), f3, src, csr(args[1]))];
  }

  // Pseudo-instructions first.
  switch (op) {
    case 'csrr': need(2); return [encI(OPCODES.SYSTEM, reg(args[0]), 2, 0, csr(args[1]))];
    case 'csrw': need(2); return [encI(OPCODES.SYSTEM, 0, 1, reg(args[1]), csr(args[0]))];
    case 'csrs': need(2); return [encI(OPCODES.SYSTEM, 0, 2, reg(args[1]), csr(args[0]))];
    case 'csrc': need(2); return [encI(OPCODES.SYSTEM, 0, 3, reg(args[1]), csr(args[0]))];
    case 'csrwi': need(2); return [encI(OPCODES.SYSTEM, 0, 5, imm(args[1], 0, 31), csr(args[0]))];
    case 'csrsi': need(2); return [encI(OPCODES.SYSTEM, 0, 6, imm(args[1], 0, 31), csr(args[0]))];
    case 'csrci': need(2); return [encI(OPCODES.SYSTEM, 0, 7, imm(args[1], 0, 31), csr(args[0]))];
    case 'mret': need(0); return [0x30200073];
    case 'wfi': need(0); return [0x10500073];
    case 'nop': need(0); return [encI(OPCODES.OPIMM, 0, 0, 0, 0)];
    case 'mv': need(2); return [encI(OPCODES.OPIMM, reg(args[0]), 0, reg(args[1]), 0)];
    case 'not': need(2); return [encI(OPCODES.OPIMM, reg(args[0]), 4, reg(args[1]), -1)];
    case 'neg': need(2); return [encR(OPCODES.OP, reg(args[0]), 0, 0, reg(args[1]), 0x20)];
    case 'seqz': need(2); return [encI(OPCODES.OPIMM, reg(args[0]), 3, reg(args[1]), 1)];
    case 'snez': need(2); return [encR(OPCODES.OP, reg(args[0]), 3, 0, reg(args[1]), 0)];
    case 'li': {
      need(2);
      const rd = reg(args[0]);
      const v = parseImm(args[1]) | 0;
      if (fitsI(v)) return [encI(OPCODES.OPIMM, rd, 0, 0, v)];
      const { hi, lo } = hiLo(v);
      if (lo === 0) return [encU(OPCODES.LUI, rd, hi)];
      return [encU(OPCODES.LUI, rd, hi), encI(OPCODES.OPIMM, rd, 0, rd, lo)];
    }
    case 'la': {
      need(2);
      const rd = reg(args[0]);
      const { hi, lo } = hiLo(value(args[1]) - addr);
      return [encU(OPCODES.AUIPC, rd, hi), encI(OPCODES.OPIMM, rd, 0, rd, lo)];
    }
    case 'j': need(1); return [encJ(OPCODES.JAL, 0, target(args[0], 21))];
    case 'jr': need(1); return [encI(OPCODES.JALR, 0, 0, reg(args[0]), 0)];
    case 'ret': need(0); return [encI(OPCODES.JALR, 0, 0, 1, 0)];
    case 'call': {
      need(1);
      const { hi, lo } = hiLo(value(args[0]) - addr);
      return [encU(OPCODES.AUIPC, 1, hi), encI(OPCODES.JALR, 1, 0, 1, lo)];
    }
    case 'tail': {
      need(1);
      const { hi, lo } = hiLo(value(args[0]) - addr);
      return [encU(OPCODES.AUIPC, 6, hi), encI(OPCODES.JALR, 0, 0, 6, lo)];
    }
    case 'beqz': need(2); return [encB(OPCODES.BRANCH, 0, reg(args[0]), 0, target(args[1], 13))];
    case 'bnez': need(2); return [encB(OPCODES.BRANCH, 1, reg(args[0]), 0, target(args[1], 13))];
    case 'blez': need(2); return [encB(OPCODES.BRANCH, 5, 0, reg(args[0]), target(args[1], 13))];
    case 'bgez': need(2); return [encB(OPCODES.BRANCH, 5, reg(args[0]), 0, target(args[1], 13))];
    case 'bltz': need(2); return [encB(OPCODES.BRANCH, 4, reg(args[0]), 0, target(args[1], 13))];
    case 'bgtz': need(2); return [encB(OPCODES.BRANCH, 4, 0, reg(args[0]), target(args[1], 13))];
    case 'bgt': need(3); return [encB(OPCODES.BRANCH, 4, reg(args[1]), reg(args[0]), target(args[2], 13))];
    case 'ble': need(3); return [encB(OPCODES.BRANCH, 5, reg(args[1]), reg(args[0]), target(args[2], 13))];
    case 'bgtu': need(3); return [encB(OPCODES.BRANCH, 6, reg(args[1]), reg(args[0]), target(args[2], 13))];
    case 'bleu': need(3); return [encB(OPCODES.BRANCH, 7, reg(args[1]), reg(args[0]), target(args[2], 13))];
    case '.word': return args.map((a) => value(a) >>> 0);
  }

  const spec = BY_NAME.get(op);
  if (!spec) throw new AsmError(`unknown instruction "${op}"`);
  const f3 = spec.funct3 ?? 0;
  switch (spec.fmt) {
    case 'R': need(3); return [encR(spec.opcode, reg(args[0]), f3, reg(args[1]), reg(args[2]), spec.funct7!)];
    case 'U': need(2); return [encU(spec.opcode, reg(args[0]), imm(args[1], 0, 0xfffff))];
    case 'J':
      if (args.length === 1) return [encJ(spec.opcode, 1, target(args[0], 21))];
      need(2);
      return [encJ(spec.opcode, reg(args[0]), target(args[1], 21))];
    case 'B': need(3); return [encB(spec.opcode, f3, reg(args[0]), reg(args[1]), target(args[2], 13))];
    case 'S': { need(2); const m = mem(args[1]); return [encS(spec.opcode, f3, m.base, reg(args[0]), m.off)]; }
    case 'I': {
      if (op === 'ecall') { need(0); return [0x00000073]; }
      if (op === 'ebreak') { need(0); return [0x00100073]; }
      if (op === 'fence') return [0x0ff0000f];
      if (spec.opcode === OPCODES.LOAD || (op === 'jalr' && args.length === 2 && args[1].includes('('))) {
        need(2);
        const m = mem(args[1]);
        return [encI(spec.opcode, reg(args[0]), f3, m.base, m.off)];
      }
      if (op === 'jalr' && args.length === 1) return [encI(spec.opcode, 1, 0, reg(args[0]), 0)];
      need(3);
      if (op === 'slli' || op === 'srli' || op === 'srai') {
        const sh = imm(args[2], 0, 31);
        return [encI(spec.opcode, reg(args[0]), f3, reg(args[1]), (spec.funct7! << 5) | sh)];
      }
      return [encI(spec.opcode, reg(args[0]), f3, reg(args[1]), imm(args[2], -2048, 2047))];
    }
  }
}
