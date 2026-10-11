// Instruction sets described as tables (the sandbox's Custom ISA): each instruction is a mnemonic,
// its operands (one letter each) and a bit pattern, most significant bit first, of 0 / 1 (fixed),
// '-' (assembled as 0, ignored when decoding) and operand letters (the operand's bits, most
// significant first; a letter may be split over several runs). Each letter's kind says how it is
// written: a register name, a name or number from a list, an immediate, or an address (a label).
// From the table: an assembler, a disassembler (the most specific matching pattern wins), the
// fields of a word, and a check that every word decodes to at most one instruction. Syntax only:
// the table says how instructions are written, not what they do.

import { AsmError, commentStart, parseImm, splitArgs } from '../riscv/asm';

export type OperandDef =
  /** A register: names[i] encodes as i. */
  | { kind: 'reg'; names: string[] }
  /** A name from a list (each with its value), or (number) any value that fits. */
  | { kind: 'enum'; names: Record<string, number>; number?: boolean }
  /** A number; signed: two's complement; hex: disassembled as 0x… (else decimal). */
  | { kind: 'imm'; signed?: boolean; hex?: boolean }
  /** A label or a number: absolute, or (rel) target − address of the instruction, signed, divided by scale. */
  | { kind: 'addr'; rel?: boolean; scale?: number };

export interface InstrDef {
  mnemonic: string;
  /** Operand letters in the order they are written. */
  operands: string[];
  /** Bits, most significant first (spaces ignored): 0, 1, '-' or an operand letter. */
  pattern: string;
  summary?: string;
}

export interface IsaDoc {
  id: string;
  name: string;
  wordBits: 8 | 16 | 32;
  /** Operand letters → kinds. */
  operands: Record<string, OperandDef>;
  instrs: InstrDef[];
  notes?: string;
}

export interface TableLine { addr: number; word: number; text: string; srcLine: number }
export interface TableAsm {
  words: number[];
  lines: TableLine[];
  labels: Map<string, number>;
  errors: { line: number; message: string }[];
}

export interface WordField { name: string; bits: number; value: number; kind: 'op' | 'reg' | 'imm' | 'cond' | 'none' }

/** A table problem: which instruction (index, or -1 for the table) and what. */
export interface TableProblem { instr: number; message: string }

const isLetter = (c: string) => /^[a-z]$/i.test(c) && c !== '-';

/** An instruction's pattern compiled: the fixed bits and, per letter, the bit positions (MSB first). */
interface Compiled {
  def: InstrDef;
  mask: number;
  value: number;
  /** Bit positions of each operand letter, most significant first. */
  bits: Map<string, number[]>;
  fixed: number;
}

const u32 = (v: number) => v >>> 0;

/** A table ready to use: assemble, disassemble, fields, problems. */
export class IsaTable {
  readonly compiled: Compiled[];
  readonly problems: TableProblem[] = [];
  private readonly byName = new Map<string, Compiled[]>();

  constructor(readonly doc: IsaDoc) {
    const W = doc.wordBits;
    this.compiled = doc.instrs.map((def, i) => {
      const p = def.pattern.replace(/\s+/g, '');
      const c: Compiled = { def, mask: 0, value: 0, bits: new Map(), fixed: 0 };
      if (p.length !== W) this.problems.push({ instr: i, message: `${def.mnemonic}: the pattern has ${p.length} bits, the word ${W}` });
      [...p].forEach((ch, k) => {
        const b = W - 1 - k;
        if (b < 0) return;
        if (ch === '0' || ch === '1') {
          c.mask = u32(c.mask | (1 << b));
          if (ch === '1') c.value = u32(c.value | (1 << b));
          c.fixed++;
        } else if (ch !== '-') {
          if (!isLetter(ch)) this.problems.push({ instr: i, message: `${def.mnemonic}: '${ch}' is not 0, 1, - or a letter` });
          else c.bits.set(ch, [...(c.bits.get(ch) ?? []), b]);
        }
      });
      for (const l of def.operands) {
        if (!doc.operands[l]) this.problems.push({ instr: i, message: `${def.mnemonic}: operand '${l}' has no kind (Operands)` });
        if (!c.bits.has(l)) this.problems.push({ instr: i, message: `${def.mnemonic}: operand '${l}' has no bits in the pattern` });
      }
      for (const l of c.bits.keys()) if (!def.operands.includes(l)) this.problems.push({ instr: i, message: `${def.mnemonic}: '${l}' is in the pattern but not an operand` });
      if (!/^[A-Za-z_.][\w.]*$/.test(def.mnemonic)) this.problems.push({ instr: i, message: `'${def.mnemonic}' is not a mnemonic (letters, digits, _ .)` });
      const k = def.mnemonic.toLowerCase();
      this.byName.set(k, [...(this.byName.get(k) ?? []), c]);
      return c;
    });
    // Two patterns that can match one word with the same number of fixed bits: neither wins.
    for (let i = 0; i < this.compiled.length; i++) {
      for (let j = i + 1; j < this.compiled.length; j++) {
        const a = this.compiled[i], b = this.compiled[j];
        const both = a.mask & b.mask;
        if (u32(a.value & both) !== u32(b.value & both)) continue;
        if (a.fixed === b.fixed) this.problems.push({ instr: j, message: `${b.def.mnemonic} and ${a.def.mnemonic} can encode the same word (${hexWord(u32(a.value | b.value), W)}): give one more fixed bits` });
      }
    }
    for (const [l, d] of Object.entries(doc.operands)) {
      if (d.kind === 'reg' && !d.names.length) this.problems.push({ instr: -1, message: `operand '${l}': a register list needs names` });
    }
  }

  /** The instruction a word is (the matching pattern with the most fixed bits), or null. */
  match(w: number): Compiled | null {
    let best: Compiled | null = null;
    for (const c of this.compiled) if (u32(w & c.mask) === c.value && (!best || c.fixed > best.fixed)) best = c;
    return best;
  }

  /** An operand letter's raw value in a word. */
  private extract(c: Compiled, l: string, w: number): number {
    return (c.bits.get(l) ?? []).reduce((v, b) => v * 2 + ((w >>> b) & 1), 0);
  }

  /** Assembly text of a word (`.word 0x…` when no instruction matches). */
  disasm(w: number, pc = 0): string {
    const c = this.match(w);
    if (!c) return `.word ${hexWord(w, this.doc.wordBits)}`;
    const ops = c.def.operands.map((l) => this.format(l, this.extract(c, l, w), (c.bits.get(l) ?? []).length, pc));
    return ops.length ? `${c.def.mnemonic.padEnd(4)} ${ops.join(', ')}` : c.def.mnemonic;
  }

  private format(l: string, raw: number, n: number, pc: number): string {
    const d = this.doc.operands[l];
    if (!d) return String(raw);
    const signed = (v: number) => (n > 0 && v >= 2 ** (n - 1) ? v - 2 ** n : v);
    switch (d.kind) {
      case 'reg': return d.names[raw] ?? `?${raw}`;
      case 'enum': return Object.entries(d.names).find(([, v]) => v === raw)?.[0] ?? String(raw);
      case 'imm': {
        const v = d.signed ? signed(raw) : raw;
        return d.hex ? `${v < 0 ? '-' : ''}0x${Math.abs(v).toString(16).toUpperCase().padStart(Math.ceil(n / 4), '0')}` : String(v);
      }
      case 'addr': {
        const t = d.rel ? pc + signed(raw) * (d.scale ?? 1) : raw;
        return `0x${(t >>> 0).toString(16).toUpperCase().padStart(Math.ceil((d.rel ? Math.max(n, 8) : n) / 4), '0')}`;
      }
    }
  }

  /** The fields of a word, most significant first: the instruction's runs of fixed bits and operands. */
  fields(w: number): WordField[] {
    const c = this.match(w);
    const W = this.doc.wordBits;
    if (!c) return [{ name: '.word', bits: W, value: w, kind: 'none' }];
    const p = c.def.pattern.replace(/\s+/g, '');
    const out: WordField[] = [];
    let k = 0;
    while (k < p.length) {
      const ch = p[k];
      const cls = ch === '0' || ch === '1' ? 'fixed' : ch;
      let n = 1;
      while (k + n < p.length && ((cls === 'fixed' && (p[k + n] === '0' || p[k + n] === '1')) || p[k + n] === ch)) n++;
      const top = W - 1 - k;
      const value = Array.from({ length: n }, (_, i) => (w >>> (top - i)) & 1).reduce((v, b) => v * 2 + b, 0);
      const d = this.doc.operands[ch];
      const kind: WordField['kind'] = cls === 'fixed' ? 'op' : ch === '-' ? 'none' : !d ? 'imm' : d.kind === 'reg' ? 'reg' : d.kind === 'enum' ? 'cond' : 'imm';
      out.push({ name: cls === 'fixed' ? 'opcode' : ch === '-' ? '—' : ch, bits: n, value, kind });
      k += n;
    }
    return out;
  }

  /** Every mnemonic, register name and enum name (for the highlighter). */
  words(): { mnemonics: string[]; registers: string[]; keywords: string[] } {
    const ops = Object.values(this.doc.operands);
    return {
      mnemonics: [...new Set(this.doc.instrs.map((i) => i.mnemonic))],
      registers: [...new Set(ops.flatMap((d) => (d.kind === 'reg' ? d.names : [])))],
      keywords: [...new Set(ops.flatMap((d) => (d.kind === 'enum' ? Object.keys(d.names) : [])))],
    };
  }

  /** Assemble: labels, `.word`, `.org`, comments (; # //), mnemonics in any case. */
  assemble(src: string): TableAsm {
    const W = this.doc.wordBits, max = 2 ** W - 1;
    const labels = new Map<string, number>();
    const errors: { line: number; message: string }[] = [];
    const stmts: { line: number; op: string; args: string[]; text: string; addr: number }[] = [];
    let at = 0;
    src.split(/\r?\n/).forEach((raw, i) => {
      let ln = raw.slice(0, commentStart(raw)).trim();
      for (;;) {
        const m = ln.match(/^([A-Za-z_.$][\w.$]*)\s*:/);
        if (!m) break;
        if (labels.has(m[1])) errors.push({ line: i + 1, message: `label "${m[1]}" defined twice` });
        labels.set(m[1], at);
        ln = ln.slice(m[0].length).trim();
      }
      if (!ln) return;
      const sp = ln.search(/\s/);
      const op = (sp < 0 ? ln : ln.slice(0, sp)).toLowerCase();
      const args = splitArgs(sp < 0 ? '' : ln.slice(sp + 1));
      if (op === '.org') {
        try {
          const v = parseImm(args[0] ?? '');
          if (v < at) throw new AsmError(`.org ${v} is behind the current address ${at}`);
          at = v;
        } catch (e) {
          errors.push({ line: i + 1, message: (e as Error).message });
        }
        return;
      }
      stmts.push({ line: i + 1, op, args, text: ln, addr: at });
      at += op === '.word' ? Math.max(1, args.length) : 1;
    });
    const words: number[] = [];
    const lines: TableLine[] = [];
    for (const s of stmts) {
      try {
        const ws = s.op === '.word' ? this.dataWords(s.args, labels, max) : [this.encode(s.op, s.args, labels, s.addr)];
        ws.forEach((w, k) => {
          const addr = s.addr + k;
          while (words.length < addr) words.push(0);
          words[addr] = w;
          lines.push({ addr, word: w, text: s.text, srcLine: s.line });
        });
      } catch (e) {
        if (e instanceof AsmError) errors.push({ line: s.line, message: e.message });
        else throw e;
      }
    }
    return { words, lines, labels, errors };
  }

  private dataWords(args: string[], labels: Map<string, number>, max: number): number[] {
    if (!args.length) throw new AsmError('.word needs a value');
    return args.map((a) => {
      const v = labels.get(a.trim()) ?? parseImm(a);
      if (v < -(max + 1) / 2 || v > max) throw new AsmError(`.word ${v} does not fit in ${this.doc.wordBits} bits`);
      return u32(v) & max;
    });
  }

  /** One instruction: the first row of that mnemonic and operand count whose operands all fit. */
  private encode(op: string, args: string[], labels: Map<string, number>, addr: number): number {
    const rows = this.byName.get(op);
    if (!rows) throw new AsmError(`unknown instruction "${op}"`);
    const fit = rows.filter((c) => c.def.operands.length === args.length);
    if (!fit.length) {
      const counts = [...new Set(rows.map((c) => c.def.operands.length))].join(' or ');
      throw new AsmError(`${op.toUpperCase()} takes ${counts} operand${counts === '1' ? '' : 's'}`);
    }
    let first: Error | null = null;
    for (const c of fit) {
      try {
        let w = c.value;
        c.def.operands.forEach((l, i) => {
          const pos = c.bits.get(l) ?? [];
          const v = this.operand(l, args[i], pos.length, labels, addr);
          pos.forEach((b, k) => {
            if ((v >>> (pos.length - 1 - k)) & 1) w = u32(w | (1 << b));
          });
        });
        return w;
      } catch (e) {
        if (!(e instanceof AsmError)) throw e;
        first ??= e;
      }
    }
    throw first!;
  }

  /** An operand's bits (unsigned, n of them) from its text. */
  private operand(l: string, text: string, n: number, labels: Map<string, number>, addr: number): number {
    const d = this.doc.operands[l];
    const t = text.trim();
    const fits = (v: number, lo: number, hi: number, what: string) => {
      if (v < lo || v > hi) throw new AsmError(`${what} ${v} is out of range (${lo}–${hi})`);
      return v < 0 ? v + 2 ** n : v;
    };
    if (!d) throw new AsmError(`operand '${l}' has no kind`);
    switch (d.kind) {
      case 'reg': {
        const i = d.names.findIndex((r) => r.toLowerCase() === t.toLowerCase());
        if (i < 0) throw new AsmError(`not a register: "${t}" (${d.names.length > 4 ? `${d.names[0]}–${d.names[d.names.length - 1]}` : d.names.join(', ')})`);
        return i;
      }
      case 'enum': {
        const hit = Object.entries(d.names).find(([k]) => k.toLowerCase() === t.toLowerCase());
        if (hit) return hit[1];
        if (!d.number) throw new AsmError(`"${t}" is not one of ${Object.keys(d.names).join(', ')}`);
        return fits(parseImm(t), 0, 2 ** n - 1, 'value');
      }
      case 'imm': {
        const v = labels.get(t) ?? parseImm(t);
        return d.signed ? fits(v, -(2 ** (n - 1)), 2 ** (n - 1) - 1, 'immediate') : fits(v, 0, 2 ** n - 1, 'immediate');
      }
      case 'addr': {
        let v: number;
        if (t === '$' || t === '.') v = addr;
        else if (labels.has(t)) v = labels.get(t)!;
        else if (/^[A-Za-z_.$][\w.$]*$/.test(t)) throw new AsmError(`unknown label "${t}"`);
        else v = parseImm(t);
        if (!d.rel) return fits(v, 0, 2 ** n - 1, 'address');
        const s = d.scale ?? 1, off = v - addr;
        if (off % s) throw new AsmError(`offset ${off} is not a multiple of ${s}`);
        return fits(off / s, -(2 ** (n - 1)), 2 ** (n - 1) - 1, 'offset');
      }
    }
  }
}

export const hexWord = (w: number, bits: number) => `0x${(w >>> 0).toString(16).toUpperCase().padStart(bits / 4, '0')}`;

const tables = new WeakMap<IsaDoc, IsaTable>();
/** The compiled table of a document (cached per document object). */
export function tableOf(doc: IsaDoc): IsaTable {
  let t = tables.get(doc);
  if (!t) tables.set(doc, (t = new IsaTable(doc)));
  return t;
}

/** Limits a stored or imported table is held to. */
export const ISA_LIMITS = { instrs: 512, names: 256, text: 200 } as const;

const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const str = (x: unknown, max: number = ISA_LIMITS.text): x is string => typeof x === 'string' && x.length <= max;

function sanitizeOperand(x: unknown): OperandDef | null {
  if (!isObj(x)) return null;
  if (x.kind === 'reg') {
    if (!Array.isArray(x.names) || x.names.length > ISA_LIMITS.names || !x.names.every((n) => str(n, 40))) return null;
    return { kind: 'reg', names: x.names as string[] };
  }
  if (x.kind === 'enum') {
    if (!isObj(x.names)) return null;
    const e = Object.entries(x.names);
    if (e.length > ISA_LIMITS.names || !e.every(([k, v]) => str(k, 40) && Number.isInteger(v) && (v as number) >= 0)) return null;
    return { kind: 'enum', names: Object.fromEntries(e) as Record<string, number>, ...(x.number === true ? { number: true } : {}) };
  }
  if (x.kind === 'imm') return { kind: 'imm', ...(x.signed === true ? { signed: true } : {}), ...(x.hex === true ? { hex: true } : {}) };
  if (x.kind === 'addr') {
    const scale = Number.isInteger(x.scale) && (x.scale as number) >= 1 && (x.scale as number) <= 16 ? (x.scale as number) : undefined;
    return { kind: 'addr', ...(x.rel === true ? { rel: true } : {}), ...(scale && scale !== 1 ? { scale } : {}) };
  }
  return null;
}

/** A table from stored or imported JSON (null: not one). Problems inside a valid shape are kept: the editor shows them. */
export function sanitizeIsa(x: unknown): IsaDoc | null {
  if (!isObj(x) || !str(x.id, 60) || !/^[\w-]+$/.test(x.id) || !str(x.name)) return null;
  if (x.wordBits !== 8 && x.wordBits !== 16 && x.wordBits !== 32) return null;
  if (!isObj(x.operands) || !Array.isArray(x.instrs) || x.instrs.length > ISA_LIMITS.instrs) return null;
  const operands: Record<string, OperandDef> = {};
  for (const [k, v] of Object.entries(x.operands)) {
    const d = sanitizeOperand(v);
    if (!/^[a-z]$/i.test(k) || !d) return null;
    operands[k] = d;
  }
  const instrs: InstrDef[] = [];
  for (const i of x.instrs) {
    if (!isObj(i) || !str(i.mnemonic, 40) || !str(i.pattern, 80) || !Array.isArray(i.operands) || !i.operands.every((o) => str(o, 1))) return null;
    instrs.push({ mnemonic: i.mnemonic, operands: i.operands as string[], pattern: i.pattern, ...(str(i.summary) && i.summary ? { summary: i.summary } : {}) });
  }
  return { id: x.id, name: x.name, wordBits: x.wordBits, operands, instrs, ...(str(x.notes, 2000) && x.notes ? { notes: x.notes } : {}) };
}
