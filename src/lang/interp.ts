// The reference interpreter: the subset's meaning, run on the syntax tree with the machine's 32-bit ints.
// It is the golden model for the compiler (tests run every program both ways and compare what they print),
// and it says where Python itself would stop (a name read before it is set, an index out of range).

import { PyError, wrap } from './ast';
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

export interface RunResult {
  output: number[];
  globals: Map<string, number>;
  lists: Map<string, number[]>;
  /** Statements executed. */
  steps: number;
  /** Where Python would have stopped, if it did. */
  error?: PyError;
}

class Return { constructor(readonly value: number) {} }
class Break {}
class Continue {}
const BREAK = new Break(), CONTINUE = new Continue();

export function runPy(src: string | Module, opts: { maxSteps?: number; maxDepth?: number } = {}): RunResult {
  const mod = typeof src === 'string' ? parse(src) : src;
  const scope = analyze(mod);
  return new Interp(scope, opts.maxSteps ?? 1_000_000, opts.maxDepth ?? 200).run(mod);
}

class Interp {
  readonly output: number[] = [];
  readonly globals = new Map<string, number>();
  readonly lists = new Map<string, number[]>();
  steps = 0;
  depth = 0;
  constructor(private readonly scope: Scope, private readonly maxSteps: number, private readonly maxDepth: number) {}

  run(mod: Module): RunResult {
    try {
      this.block(mod.body, null);
    } catch (e) {
      if (e instanceof PyError) return { output: this.output, globals: this.globals, lists: this.lists, steps: this.steps, error: e };
      throw e;
    }
    return { output: this.output, globals: this.globals, lists: this.lists, steps: this.steps };
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
          const i = this.indexOf(xs, this.expr(s.target.index, fr), s.target.list, s.line);
          xs[i] = binop(s.op, xs[i], this.expr(s.value, fr));
        } else this.store(s.target, binop(s.op, this.load(s.target.id, fr, s.line), this.expr(s.value, fr)), fr, s.line);
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
        const start = this.expr(s.start, fr), stop = this.expr(s.stop, fr);
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

  private load(id: string, fr: Frame | null, line: number): number {
    if (fr && fr.fn.locals.includes(id)) {
      const v = fr.vars.get(id);
      if (v === undefined) throw new PyError(`UnboundLocalError: "${id}" is read before it is set`, line);
      return v;
    }
    const v = this.globals.get(id);
    if (v === undefined) throw new PyError(`NameError: "${id}" is read before it is set`, line);
    return v;
  }

  private store(t: Target, v: number, fr: Frame | null, line: number): void {
    if (t.kind === 'index') {
      const xs = this.lists.get(t.list)!;
      xs[this.indexOf(xs, this.expr(t.index, fr), t.list, line)] = v;
    } else if (fr && fr.fn.locals.includes(t.id)) fr.vars.set(t.id, v);
    else this.globals.set(t.id, v);
  }

  expr(e: Expr, fr: Frame | null): number {
    switch (e.kind) {
      case 'num': return e.value;
      case 'name': return this.load(e.id, fr, e.line);
      case 'bin': { const a = this.expr(e.left, fr); return binop(e.op, a, this.expr(e.right, fr)); }
      case 'unary': {
        const a = this.expr(e.arg, fr);
        return e.op === '-' ? wrap(-a) : e.op === '~' ? ~a : e.op === 'not' ? (a ? 0 : 1) : a;
      }
      case 'bool': {
        const a = this.expr(e.left, fr);
        return (e.op === 'and' ? !a : !!a) ? a : this.expr(e.right, fr);
      }
      case 'cmp': {
        let a = this.expr(e.args[0], fr);
        for (let k = 0; k < e.ops.length; k++) {
          const b = this.expr(e.args[k + 1], fr);
          if (!cmpop(e.ops[k], a, b)) return 0;
          a = b;
        }
        return 1;
      }
      case 'ifexp': return this.expr(e.test, fr) ? this.expr(e.yes, fr) : this.expr(e.no, fr);
      case 'index': {
        const xs = this.lists.get(e.list);
        if (!xs) throw new PyError(`NameError: list "${e.list}" is used before it is created`, e.line);
        return xs[this.indexOf(xs, this.expr(e.index, fr), e.list, e.line)];
      }
      case 'list': throw new PyError('internal: list literal as a value', e.line);
      case 'call': return this.call(e, fr);
    }
  }

  private call(e: Expr & { kind: 'call' }, fr: Frame | null): number {
    const args = e.fn === 'len' ? [] : e.args.map((a) => this.expr(a, fr));
    switch (e.fn) {
      case 'print': this.output.push(...args); return 0;
      case 'len': return this.scope.lists.get((e.args[0] as { id: string }).id)!.len;
      case 'abs': return wrap(Math.abs(args[0]));
      case 'min': return Math.min(...args);
      case 'max': return Math.max(...args);
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

interface Frame { fn: FuncInfo; vars: Map<string, number> }
