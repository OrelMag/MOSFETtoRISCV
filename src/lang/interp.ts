// The reference interpreter: the subset's meaning, run on the syntax tree with the machine's 32-bit ints.
// It is the golden model for the compiler (tests run every program both ways and compare what they print),
// and it says where Python itself would stop (a name read before it is set, an index out of range).

import { HEAP_BYTES, PyError, wrap } from './ast';
import type { BinOpName, CmpOpName, Expr, Module, Stmt, Target } from './ast';
import { parse } from './parse';
import { analyze } from './scope';
import type { FuncInfo, Scope } from './scope';

/** Floor division and modulo as Python defines them, on 32-bit ints; x // 0 = -1 and x % 0 = x (RISC-V's divide). */
export function pyDivMod(a: number, b: number): [number, number] {
  if (b === 0) return [-1, a];
  const A = BigInt(a), B = BigInt(b);
  let q = A / B, r = A % B;
  if (r !== 0n && (r < 0n) !== (B < 0n)) { q -= 1n; r += B; }
  return [Number(BigInt.asIntN(32, q)), Number(r)];
}

export function binop(op: BinOpName, a: number, b: number): number {
  switch (op) {
    case '+': return wrap(a + b);
    case '-': return wrap(a - b);
    case '*': return Math.imul(a, b);
    case '//': return pyDivMod(a, b)[0];
    case '%': return pyDivMod(a, b)[1];
    case '&': return a & b;
    case '|': return a | b;
    case '^': return a ^ b;
    // the shift amount is taken mod 32, as the hardware's shifter does
    case '<<': return a << (b & 31);
    case '>>': return a >> (b & 31);
  }
}

export function cmpop(op: CmpOpName, a: number, b: number): boolean {
  switch (op) {
    case '<': return a < b;
    case '<=': return a <= b;
    case '>': return a > b;
    case '>=': return a >= b;
    case '==': return a === b;
    case '!=': return a !== b;
  }
}

/** A value: an int, or a str (the compiled program holds a pointer to a length-prefixed block in the heap or the literal pool). */
type Val = number | string;

/** Heap bytes a str of this length takes: its length word, then its bytes rounded up to a word. */
export const strBlock = (len: number): number => 4 + ((len + 3) & ~3);

export interface RunResult {
  output: number[];
  /** Parallel to `output`: 0 for an int, else which str (1, 2, ...) the word is a character of. Words print as their character codes, one a word. */
  strOut: number[];
  /** Bytes of the heap taken so far (concatenations, s[i] and chr() each take a block; nothing is freed). */
  heapUsed: number;
  globals: Map<string, Val>;
  lists: Map<string, number[]>;
  /** Statements executed. */
  steps: number;
  /** Where Python would have stopped, if it did. */
  error?: PyError;
  /** The bytes load8 / store8 / load32 / store32 touched: a sparse byte map (an address never stored reads 0). */
  memory: Map<number, number>;
}

/** Little-endian word and byte access over a sparse byte map: the interpreter's model of the memory the builtins reach. Addresses are taken mod 2^32. */
export const memLoad8 = (m: Map<number, number>, a: number): number => m.get(a >>> 0) ?? 0;
export const memStore8 = (m: Map<number, number>, a: number, v: number): void => { m.set(a >>> 0, v & 255); };
export const memLoad32 = (m: Map<number, number>, a: number): number => (memLoad8(m, a) | (memLoad8(m, a + 1) << 8) | (memLoad8(m, a + 2) << 16) | (memLoad8(m, a + 3) << 24)) | 0;
export const memStore32 = (m: Map<number, number>, a: number, v: number): void => { for (let k = 0; k < 4; k++) memStore8(m, a + k, v >>> (8 * k)); };

class Return { constructor(readonly value: Val) {} }
class Break {}
class Continue {}
const BREAK = new Break(), CONTINUE = new Continue();

export function runPy(src: string | Module, opts: { maxSteps?: number; maxDepth?: number; memory?: Map<number, number>; heapBytes?: number } = {}): RunResult {
  const mod = typeof src === 'string' ? parse(src) : src;
  const scope = analyze(mod);
  return new Interp(scope, opts.maxSteps ?? 1_000_000, opts.maxDepth ?? 200, opts.memory ?? new Map(), opts.heapBytes ?? HEAP_BYTES).run(mod);
}

class Interp {
  readonly output: number[] = [];
  readonly strOut: number[] = [];
  heapUsed = 0;
  private strN = 0;
  readonly globals = new Map<string, Val>();
  readonly lists = new Map<string, number[]>();
  steps = 0;
  depth = 0;
  constructor(private readonly scope: Scope, private readonly maxSteps: number, private readonly maxDepth: number, readonly memory: Map<number, number>, private readonly heapBytes: number) {}

  run(mod: Module): RunResult {
    try {
      this.block(mod.body, null);
    } catch (e) {
      if (e instanceof PyError) return { ...this.result(), error: e };
      throw e;
    }
    return this.result();
  }

  private result(): RunResult {
    return { output: this.output, strOut: this.strOut, heapUsed: this.heapUsed, globals: this.globals, lists: this.lists, steps: this.steps, memory: this.memory };
  }

  /** The bump heap: a block for a str of this many characters, or MemoryError when the arena is full (the compiled program stops there). */
  private alloc(len: number, line: number): void {
    const size = strBlock(len);
    if (this.heapUsed + size > this.heapBytes) throw new PyError(`MemoryError: the heap (${this.heapBytes} bytes, never freed) is full`, line);
    this.heapUsed += size;
  }

  private block(body: Stmt[], fr: Frame | null): void {
    for (const s of body) this.stmt(s, fr);
  }

  private stmt(s: Stmt, fr: Frame | null): void {
    if (++this.steps > this.maxSteps) throw new PyError(`still running after ${this.maxSteps} statements`, s.line);
    switch (s.kind) {
      case 'def': case 'global': case 'pass': return;
      case 'assign':
        if (s.value.kind === 'list') { this.lists.set((s.target as { id: string }).id, this.scope.lists.get((s.target as { id: string }).id)!.init.slice()); return; }
        this.store(s.target, this.expr(s.value, fr), fr, s.line);
        return;
      case 'aug': {
        // the index is evaluated once, as in Python
        if (s.target.kind === 'index') {
          const xs = this.lists.get(s.target.list)!;
          const i = this.indexOf(xs, this.int(s.target.index, fr), s.target.list, s.line);
          xs[i] = binop(s.op, xs[i], this.int(s.value, fr));
        } else if (s.isStr) {
          const a = this.load(s.target.id, fr, s.line) as string, b = this.expr(s.value, fr) as string;
          this.alloc(a.length + b.length, s.line);
          this.store(s.target, a + b, fr, s.line);
        } else this.store(s.target, binop(s.op, this.load(s.target.id, fr, s.line) as number, this.expr(s.value, fr) as number), fr, s.line);
        return;
      }
      case 'expr': this.expr(s.value, fr); return;
      case 'if': this.block(this.expr(s.test, fr) ? s.body : s.orelse, fr); return;
      case 'while':
        while (this.expr(s.test, fr)) {
          if (++this.steps > this.maxSteps) throw new PyError(`still running after ${this.maxSteps} statements`, s.line);
          try { this.block(s.body, fr); } catch (e) { if (e === BREAK) break; if (e !== CONTINUE) throw e; }
        }
        return;
      case 'for': {
        const start = this.int(s.start, fr), stop = this.int(s.stop, fr);
        for (let i = start; s.step > 0 ? i < stop : i > stop; i += s.step) {
          if (++this.steps > this.maxSteps) throw new PyError(`still running after ${this.maxSteps} statements`, s.line);
          this.store({ kind: 'name', line: s.line, id: s.v }, i, fr, s.line);
          try { this.block(s.body, fr); } catch (e) { if (e === BREAK) break; if (e !== CONTINUE) throw e; }
        }
        return;
      }
      case 'return': throw new Return(s.value ? this.expr(s.value, fr) : 0);
      case 'break': throw BREAK;
      case 'continue': throw CONTINUE;
    }
  }

  private indexOf(xs: number[], i: number, name: string, line: number): number {
    if (i < 0 || i >= xs.length) throw new PyError(`IndexError: ${name}[${i}] is outside 0..${xs.length - 1}`, line);
    return i;
  }

  private load(id: string, fr: Frame | null, line: number): Val {
    if (fr && fr.fn.locals.includes(id)) {
      const v = fr.vars.get(id);
      if (v === undefined) throw new PyError(`UnboundLocalError: "${id}" is read before it is set`, line);
      return v;
    }
    const v = this.globals.get(id);
    if (v === undefined) throw new PyError(`NameError: "${id}" is read before it is set`, line);
    return v;
  }

  private store(t: Target, v: Val, fr: Frame | null, line: number): void {
    if (t.kind === 'index') {
      const xs = this.lists.get(t.list)!;
      xs[this.indexOf(xs, this.int(t.index, fr), t.list, line)] = v as number;
    } else if (fr && fr.fn.locals.includes(t.id)) fr.vars.set(t.id, v);
    else this.globals.set(t.id, v);
  }

  /** An expression the type pass says is an int. */
  private int(e: Expr, fr: Frame | null): number { return this.expr(e, fr) as number; }

  expr(e: Expr, fr: Frame | null): Val {
    switch (e.kind) {
      case 'num': return e.value;
      case 'str': return e.value;
      case 'name': return this.load(e.id, fr, e.line);
      case 'bin': {
        const a = this.expr(e.left, fr), b = this.expr(e.right, fr);
        if (e.isStr) { this.alloc((a as string).length + (b as string).length, e.line); return (a as string) + (b as string); }
        return binop(e.op, a as number, b as number);
      }
      case 'unary': {
        const a = this.int(e.arg, fr);
        return e.op === '-' ? wrap(-a) : e.op === '~' ? ~a : e.op === 'not' ? (a ? 0 : 1) : a;
      }
      case 'bool': {
        const a = this.int(e.left, fr);
        return (e.op === 'and' ? !a : !!a) ? a : this.expr(e.right, fr);
      }
      case 'cmp': {
        if (e.strCmp) {
          const a = this.expr(e.args[0], fr) as string, b = this.expr(e.args[1], fr) as string;
          return +((e.ops[0] === '==') === (a === b));
        }
        let a = this.int(e.args[0], fr);
        for (let k = 0; k < e.ops.length; k++) {
          const b = this.int(e.args[k + 1], fr);
          if (!cmpop(e.ops[k], a, b)) return 0;
          a = b;
        }
        return 1;
      }
      case 'ifexp': return this.int(e.test, fr) ? this.expr(e.yes, fr) : this.expr(e.no, fr);
      case 'index': {
        if (e.isStr) {
          const ch = this.charAt(e, fr);
          this.alloc(1, e.line); // s[i] is a str of its own: a new block
          return ch;
        }
        const xs = this.lists.get(e.list);
        if (!xs) throw new PyError(`NameError: list "${e.list}" is used before it is created`, e.line);
        return xs[this.indexOf(xs, this.int(e.index, fr), e.list, e.line)];
      }
      case 'list': throw new PyError('internal: list literal as a value', e.line);
      case 'call': return this.call(e, fr);
    }
  }

  /** The character s[i] of a str variable, Python's negative indices included. */
  private charAt(e: Expr & { kind: 'index' }, fr: Frame | null): string {
    const s = this.load(e.list, fr, e.line) as string, i = this.int(e.index, fr);
    const k = i < 0 ? i + s.length : i;
    if (k < 0 || k >= s.length) throw new PyError(`IndexError: ${e.list}[${i}] is outside a str of length ${s.length}`, e.line);
    return s[k];
  }

  private call(e: Expr & { kind: 'call' }, fr: Frame | null): Val {
    if (e.fn === 'len') {
      const a = e.args[0];
      return a.isStr ? (this.expr(a, fr) as string).length : this.scope.lists.get((a as { id: string }).id)!.len;
    }
    if (e.fn === 'ord') {
      const a = e.args[0];
      // ord(s[i]) reads the byte and makes no str, as the compiled program does
      if (a.kind === 'index' && a.isStr) return this.charAt(a, fr).charCodeAt(0);
      const s = this.expr(a, fr) as string;
      if (s.length !== 1) throw new PyError(`TypeError: ord() expected a str of length 1, got ${s.length}`, e.line);
      return s.charCodeAt(0);
    }
    const args = e.args.map((a) => this.expr(a, fr));
    switch (e.fn) {
      case 'print':
        for (const a of args) {
          if (typeof a === 'string') {
            this.strN++;
            for (let j = 0; j < a.length; j++) { this.output.push(a.charCodeAt(j)); this.strOut.push(this.strN); }
          } else { this.output.push(a); this.strOut.push(0); }
        }
        return 0;
      case 'chr': {
        const n = args[0] as number;
        if (n < 0 || n > 255) throw new PyError(`ValueError: chr() takes 0 to 255, got ${n}`, e.line);
        this.alloc(1, e.line);
        return String.fromCharCode(n);
      }
      case 'abs': return wrap(Math.abs(args[0] as number));
      case 'min': return Math.min(...(args as number[]));
      case 'max': return Math.max(...(args as number[]));
      case 'load8': return memLoad8(this.memory, args[0] as number);
      case 'load32': return memLoad32(this.memory, args[0] as number);
      case 'store8': memStore8(this.memory, args[0] as number, args[1] as number); return 0;
      case 'store32': memStore32(this.memory, args[0] as number, args[1] as number); return 0;
    }
    const fn = this.scope.funcs.get(e.fn)!;
    if (++this.depth > this.maxDepth) throw new PyError(`RecursionError: more than ${this.maxDepth} calls deep`, e.line);
    const frame: Frame = { fn, vars: new Map(fn.params.map((p, i) => [p, args[i]])) };
    try {
      this.block(fn.body, frame);
      return 0;
    } catch (r) {
      if (r instanceof Return) return r.value;
      throw r;
    } finally {
      this.depth--;
    }
  }
}

interface Frame { fn: FuncInfo; vars: Map<string, Val> }
