// A two-pass RV32I assembler: labels, ABI register names, the common pseudo-instructions and
// .word. Errors are collected per line instead of thrown, so the editor can show them all.

import { specOf, type CustomRow } from './custom';
import { compress32, decodeC, scatter } from './rvc';
import { BY_NAME, CSRS, encB, encI, encJ, encR, encR4, encS, encU, fregNumber, OPCODES, regNumber, RM_OPERANDS } from './isa';

export interface AsmLine {
  addr: number;
  word: number;
  /** Source text this word came from (pseudo-instructions produce several words). */
  text: string;
  srcLine: number;
  /** 2: a 16-bit instruction (C extension), whose bits are word's low half. */
  size?: 2;
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
  /** Bytes. */
  size: number;
  /** Each instruction's length in bytes (2 or 4: a pseudo-instruction has several; .align its padding). */
  parts: number[];
  /** Under .option rvc: compressed wherever a 16-bit form exists. */
  rvc: boolean;
}

export class AsmError extends Error {}

/** A number: decimal, 0x hex, 0b binary (underscores allowed) or a character literal 'c'. Throws. */
export function parseImm(s: string): number {
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
export function splitArgs(s: string): string[] {
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

/** Index of a trailing comment (#, // or ;) that is not inside a character literal, or the
 *  line length. Exported so the editor's highlighter splits lines exactly like the assembler. */
export function commentStart(line: string): number {
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'") q = !q;
    if (q) continue;
    if (ch === '#' || ch === ';' || (ch === '/' && line[i + 1] === '/')) return i;
  }
  return line.length;
}

const stripComment = (line: string) => line.slice(0, commentStart(line));

/** Every mnemonic encode() accepts besides the real instructions in BY_NAME (for the highlighter;
 *  tests/codeedit.test.ts checks the list against the assembler). */
export const PSEUDO_OPS: readonly string[] = [
  'nop', 'mv', 'not', 'neg', 'seqz', 'snez', 'li', 'la', 'j', 'jr', 'ret', 'call', 'tail',
  'beqz', 'bnez', 'blez', 'bgez', 'bltz', 'bgtz', 'bgt', 'ble', 'bgtu', 'bleu',
  'csrr', 'csrw', 'csrs', 'csrc', 'csrwi', 'csrsi', 'csrci',
  'fmv.s', 'fneg.s', 'fabs.s', 'frcsr', 'fscsr', 'frrm', 'fsrm', 'fsrmi', 'frflags', 'fsflags', 'fsflagsi',
];

/** Directives: .word / .half emit data, .option rvc / norvc turn compression on and off, .align pads to a word
 *  with c.nop (only a program with 16-bit instructions can be off a word), the others are accepted and ignored. */
export const DIRECTIVES: readonly string[] = ['.word', '.half', '.text', '.globl', '.global', '.section', '.align', '.option'];

/** custom: the CPU's custom instructions (riscv/custom.ts), assembled like any other. */
export function assemble(src: string, custom: readonly CustomRow[] = []): AsmResult {
  const stmts: Stmt[] = [];
  const labels = new Map<string, number>();
  /** label → the statement it names (stmts.length: the end). */
  const labelAt = new Map<string, number>();
  const errors: { line: number; message: string }[] = [];
  let rvc = false;

  // Pass 1: strip comments, collect labels, split every statement into its instructions.
  src.split(/\r?\n/).forEach((raw, i) => {
    let ln = stripComment(raw).trim();
    while (true) {
      const m = ln.match(/^([A-Za-z_.$][\w.$]*)\s*:/);
      if (!m) break;
      if (labelAt.has(m[1])) errors.push({ line: i + 1, message: `label "${m[1]}" defined twice` });
      labelAt.set(m[1], stmts.length);
      ln = ln.slice(m[0].length).trim();
    }
    if (!ln) return;
    const sp = ln.search(/\s/);
    const op = (sp < 0 ? ln : ln.slice(0, sp)).toLowerCase();
    if (op === '.text' || op === '.globl' || op === '.global' || op === '.section') return;
    const args = splitArgs(sp < 0 ? '' : ln.slice(sp + 1));
    if (op === '.option') {
      const o = args[0]?.toLowerCase();
      if (o === 'rvc' || o === 'norvc') rvc = o === 'rvc';
      else if (o !== 'push' && o !== 'pop') errors.push({ line: i + 1, message: '.option takes rvc or norvc' });
      return;
    }
    const st: Stmt = { line: i + 1, op, args, text: ln, addr: 0, size: 0, parts: [], rvc };
    st.parts = st.op.startsWith('c.') ? [2] : op === '.half' ? args.map(() => 2) : op === '.align' ? [] : Array(sizeOf(op, args)).fill(rvc && op !== '.word' ? 2 : 4);
    stmts.push(st);
  });

  // Pass 2: lay out and encode. A program without C is laid out once (every instruction 4 bytes); with C an
  // instruction starts at 2 bytes and grows to 4 when it does not compress at the addresses that gives (a
  // branch too far, say), until nothing changes: sizes only grow, so this ends.
  const layout = () => {
    let addr = 0;
    for (const st of stmts) {
      st.addr = addr;
      if (st.op === '.align') {
        let n = 2;
        try { n = st.args.length ? parseImm(st.args[0]) : 2; } catch { /* reported below */ }
        const pad = (-addr) & (Math.min(2 ** Math.max(n, 1), 4) - 1); // to 4 bytes at most: our words
        st.parts = pad ? [pad] : [];
      }
      st.size = st.parts.reduce((s, p) => s + p, 0);
      addr += st.size;
    }
    labels.clear();
    for (const [l, k] of labelAt) labels.set(l, k < stmts.length ? stmts[k].addr : addr);
    return addr;
  };
  const anyC = stmts.some((st) => st.parts.includes(2));
  for (let pass = 0; ; pass++) {
    layout();
    if (!anyC) break;
    let grew = false;
    for (const st of stmts) {
      if (!st.rvc || st.op.startsWith('c.') || st.op === '.half' || st.op === '.align') continue;
      let out: number[];
      try { out = encode(st, labels, custom); } catch { out = []; }
      out.forEach((w, k) => {
        if (st.parts[k] === 2 && compress32(w) === null) { st.parts[k] = 4; grew = true; }
      });
    }
    if (!grew || pass > 64) break;
  }

  const bytes: number[] = []; // halfwords, then packed into words
  const lines: AsmLine[] = [];
  const emit = (st: Stmt, at: number, bits: number, size: number) => {
    if (size === 2) bytes.push(bits & 0xffff);
    else bytes.push(bits & 0xffff, (bits >>> 16) & 0xffff);
    lines.push({ addr: at, word: bits >>> 0, text: st.text, srcLine: st.line, ...(size === 2 ? { size: 2 as const } : {}) });
  };
  for (const st of stmts) {
    let at = st.addr;
    if (st.op === '.align') {
      for (const p of st.parts) for (let k = 0; k < p; k += 2) { emit(st, at, 0x0001, 2); at += 2; } // c.nop
      continue;
    }
    try {
      if (st.op === '.half') {
        st.args.forEach((a) => { emit(st, at, (labels.get(a.trim()) ?? parseImm(a)) & 0xffff, 2); at += 2; });
        continue;
      }
      if (st.op.startsWith('c.')) { const h = encodeC(st, labels, custom); emit(st, at, h, 2); continue; }
      const out = encode(st, labels, custom);
      if (out.length !== st.parts.length) throw new AsmError('internal: size mismatch');
      const bits = out.map((w, k) => (st.parts[k] === 2 ? compress32(w) : w >>> 0));
      if (bits.includes(null)) throw new AsmError('internal: no 16-bit form');
      bits.forEach((b, k) => { emit(st, at, b!, st.parts[k]); at += st.parts[k]; });
    } catch (e) {
      errors.push({ line: st.line, message: e instanceof Error ? e.message : String(e) });
      for (const p of st.parts) { emit(st, at, p === 2 ? 0x0001 : 0x00000013, p); at += p; }
    }
  }
  if (bytes.length & 1) bytes.push(0x0001); // a word's last half: c.nop
  const words: number[] = [];
  for (let k = 0; k < bytes.length; k += 2) words.push((bytes[k] | (bytes[k + 1] << 16)) >>> 0);
  return { words, lines, labels, errors };
}

/** The 32-bit instruction each c.* mnemonic spells (operands rewritten), and what its 16-bit form needs. */
const C_OPS: Record<string, { to: (a: string[]) => [string, string[]]; needs: string }> = {
  'c.nop': { to: () => ['nop', []], needs: 'no operands' },
  'c.ebreak': { to: () => ['ebreak', []], needs: 'no operands' },
  'c.addi': { to: (a) => ['addi', [a[0], a[0], a[1]]], needs: 'rd ≠ x0 and a non-zero immediate in −32…31' },
  'c.li': { to: (a) => ['addi', [a[0], 'x0', a[1]]], needs: 'rd ≠ x0 and an immediate in −32…31' },
  'c.lui': { to: (a) => ['lui', a], needs: 'rd ≠ x0, sp and a non-zero value in −32…31 (0xfffe0…0x1f)' },
  'c.addi16sp': { to: (a) => ['addi', ['sp', 'sp', a[a.length - 1]]], needs: 'a non-zero multiple of 16 in −512…496' },
  'c.addi4spn': { to: (a) => ['addi', [a[0], 'sp', a[a.length - 1]]], needs: 'rd in x8–x15 and a non-zero multiple of 4 up to 1020' },
  'c.slli': { to: (a) => ['slli', [a[0], a[0], a[1]]], needs: 'rd ≠ x0 and a shift of 1…31' },
  'c.srli': { to: (a) => ['srli', [a[0], a[0], a[1]]], needs: 'rd in x8–x15 and a shift of 1…31' },
  'c.srai': { to: (a) => ['srai', [a[0], a[0], a[1]]], needs: 'rd in x8–x15 and a shift of 1…31' },
  'c.andi': { to: (a) => ['andi', [a[0], a[0], a[1]]], needs: 'rd in x8–x15 and an immediate in −32…31' },
  'c.mv': { to: (a) => ['add', [a[0], 'x0', a[1]]], needs: 'rd ≠ x0 and rs ≠ x0' },
  'c.add': { to: (a) => ['add', [a[0], a[0], a[1]]], needs: 'rd ≠ x0 and rs ≠ x0' },
  'c.sub': { to: (a) => ['sub', [a[0], a[0], a[1]]], needs: 'both registers in x8–x15' },
  'c.xor': { to: (a) => ['xor', [a[0], a[0], a[1]]], needs: 'both registers in x8–x15' },
  'c.or': { to: (a) => ['or', [a[0], a[0], a[1]]], needs: 'both registers in x8–x15' },
  'c.and': { to: (a) => ['and', [a[0], a[0], a[1]]], needs: 'both registers in x8–x15' },
  'c.lw': { to: (a) => ['lw', a], needs: 'registers in x8–x15 and an offset 0…124 in steps of 4' },
  'c.sw': { to: (a) => ['sw', a], needs: 'registers in x8–x15 and an offset 0…124 in steps of 4' },
  'c.flw': { to: (a) => ['flw', a], needs: 'registers f8–f15 / x8–x15 and an offset 0…124 in steps of 4' },
  'c.fsw': { to: (a) => ['fsw', a], needs: 'registers f8–f15 / x8–x15 and an offset 0…124 in steps of 4' },
  'c.lwsp': { to: (a) => ['lw', a], needs: 'rd ≠ x0, base sp and an offset 0…252 in steps of 4' },
  'c.swsp': { to: (a) => ['sw', a], needs: 'base sp and an offset 0…252 in steps of 4' },
  'c.flwsp': { to: (a) => ['flw', a], needs: 'base sp and an offset 0…252 in steps of 4' },
  'c.fswsp': { to: (a) => ['fsw', a], needs: 'base sp and an offset 0…252 in steps of 4' },
  'c.j': { to: (a) => ['jal', ['x0', ...a]], needs: 'a target within ±2 KiB' },
  'c.jal': { to: (a) => ['jal', ['ra', ...a]], needs: 'a target within ±2 KiB' },
  'c.jr': { to: (a) => ['jalr', ['x0', `0(${a[0]})`]], needs: 'rs ≠ x0' },
  'c.jalr': { to: (a) => ['jalr', ['ra', `0(${a[0]})`]], needs: 'rs ≠ x0' },
  'c.beqz': { to: (a) => ['beq', [a[0], 'x0', a[1]]], needs: 'rs in x8–x15 and a target within ±256 bytes' },
  'c.bnez': { to: (a) => ['bne', [a[0], 'x0', a[1]]], needs: 'rs in x8–x15 and a target within ±256 bytes' },
};
/** The C extension's mnemonics (for the highlighter). */
export const C_MNEMONICS: readonly string[] = Object.keys(C_OPS);

function encodeC(st: Stmt, labels: Map<string, number>, custom: readonly CustomRow[]): number {
  const c = C_OPS[st.op];
  if (!c) throw new AsmError(`unknown instruction "${st.op}"`);
  const [op, args] = c.to(st.args);
  if (st.args.some((a) => !a)) throw new AsmError(`${st.op}: missing operand`);
  const words = encode({ ...st, op, args }, labels, custom);
  let h = words.length === 1 ? compress32(words[0]) : null;
  // addi sp, sp, 16k in −32…31 has two forms: c.addi is compress32's choice, c.addi16sp asked for here
  if (st.op === 'c.addi16sp' && h !== null && decodeC(h)?.name === 'c.addi') {
    const imm = (words[0] | 0) >> 20;
    h = imm % 16 === 0 ? (3 << 13) | (2 << 7) | scatter(imm, 'addi16sp') | 1 : null;
  }
  // c.mv spells `add rd, x0, rs`; compress32 may pick another form of the same effect only for addi (mv)
  if (h === null || decodeC(h)?.name !== st.op) throw new AsmError(`${st.op} needs ${c.needs}`);
  return h;
}

function encode(st: Stmt, labels: Map<string, number>, custom: readonly CustomRow[] = []): number[] {
  const { op, args, addr } = st;
  const need = (n: number) => {
    if (args.length !== n) throw new AsmError(`${op} expects ${n} operand${n === 1 ? '' : 's'}, got ${args.length}`);
  };
  const reg = (s: string | undefined) => {
    const r = s === undefined ? null : regNumber(s);
    if (r === null) throw new AsmError(`not a register: "${s ?? ''}"`);
    return r;
  };
  const freg = (s: string | undefined) => {
    const r = s === undefined ? null : fregNumber(s);
    if (r === null) throw new AsmError(`not a floating-point register: "${s ?? ''}"`);
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
  // F pseudo-instructions
  if (op === 'fmv.s' || op === 'fneg.s' || op === 'fabs.s') {
    need(2);
    const rd = freg(args[0]), rs = freg(args[1]);
    return [encR(OPCODES.OPFP, rd, op === 'fmv.s' ? 0 : op === 'fneg.s' ? 1 : 2, rs, rs, 0x10)];
  }
  const fspec = BY_NAME.get(op);
  if (fspec?.fp) {
    const fp = fspec.fp;
    const R = (role: 'f' | 'x' | undefined, a: string) => (role === 'f' ? freg(a) : reg(a));
    if (fspec.fmt === 'I') { need(2); const m = mem(args[1]); return [encI(fspec.opcode, freg(args[0]), 2, m.base, m.off)]; }
    if (fspec.fmt === 'S') { need(2); const m = mem(args[1]); return [encS(fspec.opcode, 2, m.base, freg(args[0]), m.off)]; }
    const nOps = fp.rs2fixed !== undefined ? 2 : fp.rs3 ? 4 : 3;
    let f3 = fspec.funct3 ?? 7; // rm defaults to dyn: use frm
    if (fp.rm && args.length === nOps + 1) {
      const m = RM_OPERANDS.indexOf(args.pop()!.trim().toLowerCase());
      if (m < 0 || !RM_OPERANDS[m]) throw new AsmError('rounding mode must be rne, rtz, rdn, rup, rmm or dyn');
      f3 = m;
    }
    if (fp.rs2fixed !== undefined) { need(2); return [encR(fspec.opcode, R(fp.rd, args[0]), f3, R(fp.rs1, args[1]), fp.rs2fixed, fspec.funct7!)]; }
    if (fp.rs3) { need(4); return [encR4(fspec.opcode, freg(args[0]), f3, freg(args[1]), freg(args[2]), freg(args[3]))]; }
    need(3);
    return [encR(fspec.opcode, R(fp.rd, args[0]), f3, R(fp.rs1, args[1]), R(fp.rs2, args[2]), fspec.funct7!)];
  }
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

  // F control and status: frcsr / fscsr, frrm / fsrm(i), frflags / fsflags(i)
  const fcsrOps: Record<string, number> = { frcsr: 3, fscsr: 3, frrm: 2, fsrm: 2, fsrmi: 2, frflags: 1, fsflags: 1, fsflagsi: 1 };
  if (op in fcsrOps) {
    const a = fcsrOps[op];
    if (op.startsWith('fr')) { need(1); return [encI(OPCODES.SYSTEM, reg(args[0]), 2, 0, a)]; }
    const rd = args.length === 2 ? reg(args[0]) : 0;
    if (args.length !== 1 && args.length !== 2) throw new AsmError(`${op} expects 1 or 2 operands`);
    const src = args[args.length - 1];
    return op.endsWith('i') ? [encI(OPCODES.SYSTEM, rd, 5, imm(src, 0, 31), a)] : [encI(OPCODES.SYSTEM, rd, 1, reg(src), a)];
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

  const own = custom.find((r) => r.name === op);
  const spec = BY_NAME.get(op) ?? (own ? specOf(own) : undefined);
  if (!spec) throw new AsmError(`unknown instruction "${op}"`);
  if (spec.opcode === OPCODES.AMO) {
    need(3);
    const m = mem(args[2]);
    if (m.off !== 0) throw new AsmError('atomic memory operations take no offset: (rs1)');
    return [encR(spec.opcode, reg(args[0]), 2, m.base, reg(args[1]), spec.funct7!)];
  }
  if (spec.simt) {
    need(spec.simt.length);
    const r = { rs1: 0, rs2: 0 };
    spec.simt.forEach((f, i) => (r[f] = reg(args[i])));
    return [encR(spec.opcode, 0, spec.funct3!, r.rs1, r.rs2, 0)];
  }
  const f3 = spec.funct3 ?? 0;
  switch (spec.fmt) {
    case 'R4': throw new AsmError('internal: R4 is floating-point only');
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
