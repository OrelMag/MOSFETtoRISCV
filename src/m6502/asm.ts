// A two-pass 6502 assembler.
//
//   assemble(src) → AsmResult { ok, origin, segments, lines, symbols, errors }   (never throws on user errors)
//   toImage(result, fill?) → a 64 KiB memory image;  bytesAt(result, addr, n) → the assembled bytes there
//
// Syntax (one statement per line; `;` starts a comment):
//   label:            a label (several may precede a statement); names are case-sensitive [A-Za-z_][A-Za-z0-9_]*
//   NAME = expr       a constant (may refer to later labels; its own value cannot change between passes)
//   *= expr  .org expr   set the address (the expression must be known when the line is reached)
//   .byte e, "str", …    bytes (strings give their characters; escapes \n \r \t \0 \\ \" \')
//   .word e, …           little-endian words          .text "str", …   same as .byte
//   .fill n[, v]         n bytes of v (default 0; n must be known when the line is reached)
//   mnemonic operand     LDA #$12  LDA $12  LDA $12,X  LDX $12,Y  LDA $1234  LDA ($12,X)  LDA ($12),Y
//                        JMP ($1234)  ASL / ASL A  BNE label (any case for mnemonics, A, X, Y)
// Expressions: + - * / ( ), unary - and +, <e / >e (low / high byte of everything after it), * (the
// address of the current statement), numbers $hex %binary decimal 'c'.
//
// Zero page or absolute: a direct operand takes the zero-page form when its value is known in pass 1
// (no forward reference) and below $100, and the instruction has that form; otherwise absolute. Pass 2
// keeps pass 1's choice, so the two passes always agree on sizes.

import { MODES, opcodeOf, modesOf, type Mode } from './isa';

export interface AsmError { line: number; message: string }

/** One source line (every line appears, blank ones too): where it was placed and what it produced. */
export interface AsmLine {
  /** 1-based source line. */
  line: number;
  /** Address of the statement (the new address for `*=` / `.org`). */
  addr: number;
  bytes: number[];
  source: string;
}

export interface AsmSegment { addr: number; bytes: Uint8Array }

export interface AsmResult {
  ok: boolean;
  /** Address of the first byte emitted (in source order); 0 when nothing was emitted. */
  origin: number;
  /** The emitted bytes as maximal contiguous runs, sorted by address (a later write to a byte wins). */
  segments: AsmSegment[];
  lines: AsmLine[];
  /** Labels and constants. */
  symbols: Map<string, number>;
  errors: AsmError[];
}

/** A 64 KiB image of the program (unwritten bytes = `fill`). */
export function toImage(r: AsmResult, fill = 0): Uint8Array {
  const mem = new Uint8Array(0x10000).fill(fill);
  for (const s of r.segments) mem.set(s.bytes, s.addr);
  return mem;
}

// ---- expressions ----

type Expr =
  | { k: 'num'; v: number }
  | { k: 'sym'; name: string }
  | { k: 'pc' }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr };

class AsmFail extends Error {}

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { i++; continue; }
    let m: RegExpMatchArray | null;
    const rest = s.slice(i);
    if ((m = rest.match(/^\$([0-9a-fA-F]+)/))) out.push({ t: 'num', v: parseInt(m[1], 16) });
    else if ((m = rest.match(/^%([01]+)/))) out.push({ t: 'num', v: parseInt(m[1], 2) });
    else if ((m = rest.match(/^[0-9]+/))) out.push({ t: 'num', v: parseInt(m[0], 10) });
    else if ((m = rest.match(/^'(\\.|[^'\\])'/))) out.push({ t: 'num', v: unescape(m[1]).charCodeAt(0) });
    else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) out.push({ t: 'id', v: m[0] });
    else if ('+-*/()<>'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    else throw new AsmFail(`unexpected '${c}' in expression`);
    i += m[0].length;
  }
  return out;
}

function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const isOp = (v: string) => toks[i]?.t === 'op' && toks[i].v === v;
  const expr = (): Expr => {
    if (isOp('<') || isOp('>')) { const op = toks[i++].v as string; return { k: 'un', op, e: expr() }; }
    let a = term();
    while (isOp('+') || isOp('-')) { const op = toks[i++].v as string; a = { k: 'bin', op, a, b: term() }; }
    return a;
  };
  const term = (): Expr => {
    let a = unary();
    while (isOp('*') || isOp('/')) { const op = toks[i++].v as string; a = { k: 'bin', op, a, b: unary() }; }
    return a;
  };
  const unary = (): Expr => {
    if (isOp('-') || isOp('+') || isOp('<') || isOp('>')) { const op = toks[i++].v as string; return { k: 'un', op, e: unary() }; }
    return primary();
  };
  const primary = (): Expr => {
    const t = peek();
    if (!t) throw new AsmFail('expression expected');
    i++;
    if (t.t === 'num') return { k: 'num', v: t.v };
    if (t.t === 'id') return { k: 'sym', name: t.v };
    if (t.v === '*') return { k: 'pc' };
    if (t.v === '(') {
      const e = expr();
      if (!isOp(')')) throw new AsmFail("')' expected");
      i++;
      return e;
    }
    throw new AsmFail(`unexpected '${t.v}' in expression`);
  };
  const e = expr();
  if (i < toks.length) throw new AsmFail(`unexpected '${toks[i].v}' in expression`);
  return e;
}

/** The value, or undefined when a symbol is not defined (yet). */
function evaluate(e: Expr, syms: Map<string, number>, pc: number): number | undefined {
  switch (e.k) {
    case 'num': return e.v;
    case 'pc': return pc;
    case 'sym': return syms.get(e.name);
    case 'un': {
      const v = evaluate(e.e, syms, pc);
      if (v === undefined) return undefined;
      return e.op === '-' ? -v : e.op === '+' ? v : e.op === '<' ? v & 0xff : (v >> 8) & 0xff;
    }
    case 'bin': {
      const a = evaluate(e.a, syms, pc), b = evaluate(e.b, syms, pc);
      if (a === undefined || b === undefined) return undefined;
      switch (e.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        default:
          if (b === 0) throw new AsmFail('division by zero');
          return Math.trunc(a / b);
      }
    }
  }
}

function undefinedSym(e: Expr, syms: Map<string, number>): string | undefined {
  if (e.k === 'sym') return syms.has(e.name) ? undefined : e.name;
  if (e.k === 'un') return undefinedSym(e.e, syms);
  if (e.k === 'bin') return undefinedSym(e.a, syms) ?? undefinedSym(e.b, syms);
  return undefined;
}

// ---- statements ----

type Form = 'none' | 'acc' | 'imm' | 'ind' | 'izx' | 'izy' | 'dir' | 'dirx' | 'diry';

type Stmt =
  | { k: 'org'; e: Expr }
  | { k: 'const'; name: string; e: Expr }
  | { k: 'data'; size: 1 | 2; items: (Expr | string)[] }
  | { k: 'fill'; n: Expr; v: Expr | null }
  | { k: 'ins'; mn: string; form: Form; e: Expr | null; mode?: Mode };

const ESC: Record<string, string> = { n: '\n', r: '\r', t: '\t', '0': '\0' };
function unescape(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => ESC[c] ?? c);
}

/** Index of the comment's `;` (outside strings and character literals), or the length. */
function commentAt(s: string): number {
  let q: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; }
    else if (c === '"') q = c;
    else if (c === "'" && s[i + 2] === "'") i += 2;
    else if (c === "'" && s[i + 1] === '\\' && s[i + 3] === "'") i += 3;
    else if (c === ';') return i;
  }
  return s.length;
}

/** Splits on top-level commas (outside strings, character literals and parentheses). */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, q: string | null = null, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"') q = c;
    else if (c === "'" && s[i + 2] === "'") i += 2;
    else if (c === "'" && s[i + 1] === '\\' && s[i + 3] === "'") i += 3;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(s.slice(start, i).trim()); start = i + 1; }
  }
  out.push(s.slice(start).trim());
  return out;
}

/** True when s is "( … )" with the first parenthesis closed by the last character. */
function wrapped(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) return false;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i === s.length - 1;
  }
  return false;
}

function parseOperand(s: string): { form: Form; e: Expr | null } {
  if (s === '') return { form: 'none', e: null };
  if (/^a$/i.test(s)) return { form: 'acc', e: null };
  if (s.startsWith('#')) return { form: 'imm', e: parseExpr(s.slice(1)) };
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^\((.*),\s*x\s*\)$/i)) && wrapped(s)) return { form: 'izx', e: parseExpr(m[1]) };
  if ((m = s.match(/^(.*\))\s*,\s*y$/i)) && wrapped(m[1])) return { form: 'izy', e: parseExpr(m[1].slice(1, -1)) };
  if (wrapped(s)) return { form: 'ind', e: parseExpr(s.slice(1, -1)) };
  if ((m = s.match(/^(.*),\s*x$/i))) return { form: 'dirx', e: parseExpr(m[1]) };
  if ((m = s.match(/^(.*),\s*y$/i))) return { form: 'diry', e: parseExpr(m[1]) };
  return { form: 'dir', e: parseExpr(s) };
}

function parseString(s: string): string | null {
  const m = s.match(/^"((?:\\.|[^"\\])*)"$/);
  return m ? unescape(m[1]) : null;
}

function parseStatement(body: string): Stmt {
  let m: RegExpMatchArray | null;
  if ((m = body.match(/^\*\s*=\s*(.+)$/))) return { k: 'org', e: parseExpr(m[1]) };
  if ((m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/))) return { k: 'const', name: m[1], e: parseExpr(m[2]) };
  if ((m = body.match(/^\.([A-Za-z]+)\b\s*(.*)$/))) {
    const dir = m[1].toLowerCase(), args = m[2].trim();
    if (dir === 'org') return { k: 'org', e: parseExpr(args) };
    if (dir === 'byte' || dir === 'text' || dir === 'word') {
      if (!args) throw new AsmFail(`.${dir} needs at least one value`);
      const items = splitArgs(args).map((a) => {
        if (a.startsWith('"')) {
          const str = parseString(a);
          if (str === null) throw new AsmFail('unterminated string');
          if (dir === 'word') throw new AsmFail('.word takes numbers, not strings');
          return str;
        }
        return parseExpr(a);
      });
      return { k: 'data', size: dir === 'word' ? 2 : 1, items };
    }
    if (dir === 'fill') {
      const a = splitArgs(args);
      if (a.length > 2 || !a[0]) throw new AsmFail('.fill count[, value]');
      return { k: 'fill', n: parseExpr(a[0]), v: a[1] ? parseExpr(a[1]) : null };
    }
    throw new AsmFail(`unknown directive .${dir}`);
  }
  if ((m = body.match(/^([A-Za-z]{3})\b\s*(.*)$/))) {
    const mn = m[1].toUpperCase();
    if (!modesOf(mn).length) throw new AsmFail(`unknown instruction ${m[1]}`);
    return { k: 'ins', mn, ...parseOperand(m[2].trim()) };
  }
  throw new AsmFail(`cannot parse '${body}'`);
}

const has = (mn: string, mode: Mode) => opcodeOf(mn, mode) !== undefined;

/** Pass 1's choice of mode (fixes the size). `v` is the operand's value if known now. */
function chooseMode(mn: string, form: Form, v: number | undefined): Mode {
  const pick = (zp: Mode, abs: Mode): Mode => {
    if (has(mn, zp) && (!has(mn, abs) || (v !== undefined && v >= 0 && v < 0x100))) return zp;
    if (has(mn, abs)) return abs;
    throw new AsmFail(`${mn} has no ${MODES[abs].title} mode`);
  };
  const need = (mode: Mode): Mode => {
    if (has(mn, mode)) return mode;
    throw new AsmFail(`${mn} has no ${MODES[mode].title} mode`);
  };
  switch (form) {
    case 'none':
      if (has(mn, 'impl')) return 'impl';
      if (has(mn, 'acc')) return 'acc';
      throw new AsmFail(`${mn} needs an operand`);
    case 'acc': return need('acc');
    case 'imm': return need('imm');
    case 'ind': return need('ind');
    case 'izx': return need('izx');
    case 'izy': return need('izy');
    case 'dir': return has(mn, 'rel') ? 'rel' : pick('zp', 'abs');
    case 'dirx': return pick('zpx', 'abx');
    case 'diry': return pick('zpy', 'aby');
  }
}

const hex = (v: number, n: number) => '$' + v.toString(16).toUpperCase().padStart(n, '0');

export function assemble(src: string): AsmResult {
  const rawLines = src.split(/\r?\n/);
  const errors: AsmError[] = [];
  const symbols = new Map<string, number>();
  const parsed: { labels: string[]; stmt: Stmt | null }[] = [];
  const failed = new Set<number>(); // lines with an error already (no second report in pass 2)
  const fail = (i: number, message: string) => { if (!failed.has(i)) errors.push({ line: i + 1, message }); failed.add(i); };

  rawLines.forEach((raw, i) => {
    let body = raw.slice(0, commentAt(raw)).trim();
    const labels: string[] = [];
    let m: RegExpMatchArray | null;
    while ((m = body.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:/))) { labels.push(m[1]); body = body.slice(m[0].length).trim(); }
    let stmt: Stmt | null = null;
    try { if (body) stmt = parseStatement(body); } catch (e) { if (e instanceof AsmFail) fail(i, e.message); else throw e; }
    parsed.push({ labels, stmt });
  });

  const sizeOf = (st: Stmt, pc: number): number => {
    switch (st.k) {
      case 'org': case 'const': return 0;
      case 'data': return st.items.reduce<number>((n, it) => n + (typeof it === 'string' ? it.length : st.size), 0);
      case 'fill': {
        const n = evaluate(st.n, symbols, pc);
        if (n === undefined) throw new AsmFail('.fill count must be known here (no forward reference)');
        if (n < 0 || n > 0x10000) throw new AsmFail(`.fill count ${n} out of range`);
        return n;
      }
      case 'ins': {
        const v = st.e ? evaluate(st.e, symbols, pc) : undefined;
        st.mode = chooseMode(st.mn, st.form, v);
        return MODES[st.mode].bytes;
      }
    }
  };

  // Pass 1: addresses, labels, modes.
  let pc = 0;
  const addrs: number[] = [];
  parsed.forEach(({ labels, stmt }, i) => {
    try {
      if (stmt?.k === 'org') {
        const v = evaluate(stmt.e, symbols, pc);
        if (v === undefined) throw new AsmFail('the address must be known here (no forward reference)');
        if (v < 0 || v > 0xffff) throw new AsmFail(`address ${v} out of range`);
        pc = v;
      }
      for (const l of labels) {
        if (symbols.has(l)) fail(i, `${l} is already defined`);
        else symbols.set(l, pc);
      }
      addrs.push(pc);
      if (stmt?.k === 'const') {
        if (symbols.has(stmt.name)) throw new AsmFail(`${stmt.name} is already defined`);
        const v = evaluate(stmt.e, symbols, pc);
        if (v !== undefined) symbols.set(stmt.name, v);
      }
      if (stmt) pc += sizeOf(stmt, pc);
    } catch (e) {
      if (!(e instanceof AsmFail)) throw e;
      if (addrs.length === i) addrs.push(pc);
      fail(i, e.message);
    }
  });

  // Constants that referred to later definitions: resolve them now that every label is known.
  for (let progress = true; progress; ) {
    progress = false;
    parsed.forEach(({ stmt }, i) => {
      if (stmt?.k !== 'const' || symbols.has(stmt.name) || failed.has(i)) return;
      try {
        const v = evaluate(stmt.e, symbols, addrs[i]);
        if (v !== undefined) { symbols.set(stmt.name, v); progress = true; }
      } catch (e) { if (e instanceof AsmFail) fail(i, e.message); else throw e; }
    });
  }

  // Pass 2: bytes.
  const mem = new Uint8Array(0x10000), written = new Uint8Array(0x10000);
  let origin: number | undefined;
  const lines: AsmLine[] = [];
  parsed.forEach(({ stmt }, i) => {
    const at = addrs[i];
    const bytes: number[] = [];
    lines.push({ line: i + 1, addr: at, bytes, source: rawLines[i] });
    if (!stmt || failed.has(i)) return;
    const value = (e: Expr): number => {
      const v = evaluate(e, symbols, at);
      if (v === undefined) throw new AsmFail(`undefined symbol ${undefinedSym(e, symbols)}`);
      return v;
    };
    const byte = (v: number) => {
      if (v < -128 || v > 0xff) throw new AsmFail(`value ${v} does not fit in a byte`);
      bytes.push(v & 0xff);
    };
    const word = (v: number) => {
      if (v < -32768 || v > 0xffff) throw new AsmFail(`value ${v} does not fit in a word`);
      bytes.push(v & 0xff, (v >> 8) & 0xff);
    };
    try {
      switch (stmt.k) {
        case 'org': return;
        case 'const':
          if (!symbols.has(stmt.name)) throw new AsmFail(`undefined symbol ${undefinedSym(stmt.e, symbols)}`);
          return;
        case 'data':
          for (const it of stmt.items) {
            if (typeof it === 'string') for (const ch of it) byte(ch.charCodeAt(0));
            else if (stmt.size === 1) byte(value(it));
            else word(value(it));
          }
          break;
        case 'fill': {
          const n = value(stmt.n), v = stmt.v ? value(stmt.v) : 0;
          for (let k = 0; k < n; k++) byte(v);
          break;
        }
        case 'ins': {
          const mode = stmt.mode!;
          bytes.push(opcodeOf(stmt.mn, mode)!);
          if (!stmt.e) break;
          const v = value(stmt.e);
          if (mode === 'rel') {
            const off = v - (at + 2);
            if (off < -128 || off > 127) throw new AsmFail(`branch target ${hex(v & 0xffff, 4)} out of range (${off} bytes)`);
            bytes.push(off & 0xff);
          } else if (MODES[mode].bytes === 2) {
            if (mode !== 'imm' && (v < 0 || v > 0xff)) throw new AsmFail(`${hex(v & 0xffff, 4)} is not a zero-page address`);
            byte(v);
          } else {
            if (v < 0 || v > 0xffff) throw new AsmFail(`address ${v} out of range`);
            word(v);
          }
          break;
        }
      }
    } catch (e) {
      if (!(e instanceof AsmFail)) throw e;
      bytes.length = 0;
      fail(i, e.message);
      return;
    }
    if (at + bytes.length > 0x10000) { fail(i, 'past the end of memory ($FFFF)'); bytes.length = 0; return; }
    if (bytes.length && origin === undefined) origin = at;
    bytes.forEach((b, k) => { mem[at + k] = b; written[at + k] = 1; });
  });

  const segments: AsmSegment[] = [];
  for (let a = 0; a < 0x10000; ) {
    if (!written[a]) { a++; continue; }
    const start = a;
    while (a < 0x10000 && written[a]) a++;
    segments.push({ addr: start, bytes: mem.slice(start, a) });
  }
  errors.sort((a, b) => a.line - b.line);
  return { ok: errors.length === 0, origin: origin ?? 0, segments, lines, symbols, errors };
}
