// Test tables on a chip (ChipDoc.tests), in Digital's test syntax, so a Digital Testcase imports unchanged and a
// Logisim test vector converts to it (import/logisim.ts). A table is run as a build challenge's sequence over the
// chip's own pins (challenges.ts runSequence), so Check's failures and the test player work on it as they are. No DOM.
//
// The syntax: the first line names the signals (the chip's pins), each later line is a row of values, one per name:
//   0 1 42 0x2a 0b101   numbers (a negative one is two's complement in the pin's width)
//   X                   an input: every value (the row repeats for each); an output: not checked
//   C                   a clock column: the inputs set, then one clock cycle, then the outputs checked
//   (expr)              an expression over the variables below; bits(n, expr) is n one-bit columns, msb first
//   repeat(n) row       the row n times, `n` counting 0 … n − 1 in its expressions
//   loop(v, n) … end loop, while(expr) … end while, let v = expr;
// `#` starts a comment. Rows run in order on one simulation (state carries from row to row), as Digital runs them.

import type { ComponentDef } from '../sim/types';
import type { BuildChallenge, PinSpec, SeqStep } from './challenges';
import { matches, seqClock, seqStart, seqStep, simFor } from './challenges';
import type { Bit } from '../sim/types';
import type { ChipDoc, TestDoc } from './model';

/** A row's cell: a number, every value (X), high impedance (Z) or a clock cycle (C). */
export type Cell = bigint | 'X' | 'Z' | 'C';

export interface TestRow {
  cells: Cell[];
  /** Columns computed by an expression: wrapped to the pin's width (Digital's (n+1) past 15 on 4 bits), not refused. */
  computed?: boolean[];
  /** Source line (1-based) and, inside repeat / loop, the variables' values ("n = 3"). */
  line: number;
  where?: string;
}

export interface ParsedTest {
  names: string[];
  rows: TestRow[];
}

export interface TestError {
  error: string;
  line: number;
}

/** More rows than a check runs on every edit; a table past it is refused, not truncated. */
export const MAX_ROWS = 100_000;
const MAX_WHILE = 1_000_000;

// ---- tokens ------------------------------------------------------------------------------------

type Tok = { t: 'num'; v: bigint; line: number } | { t: 'id'; v: string; line: number } | { t: 'op'; v: string; line: number } | { t: 'nl'; line: number };

const OPS = ['<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '(', ')', ',', ';', '=', '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', ':'];

function tokenize(src: string): Tok[] | TestError {
  const out: Tok[] = [];
  const lines = src.split(/\r?\n/);
  for (let li = 0; li < lines.length; li++) {
    const s = lines[li].replace(/#.*$/, '');
    const line = li + 1;
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      if (/\s/.test(c)) { i++; continue; }
      const num = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|[0-9][0-9_]*)/.exec(s.slice(i));
      if (num) {
        const txt = num[1].replace(/_/g, '');
        out.push({ t: 'num', v: BigInt(/^0[oO]/.test(txt) ? `0o${txt.slice(2)}` : txt), line });
        i += num[1].length;
        continue;
      }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (id) { out.push({ t: 'id', v: id[0], line }); i += id[0].length; continue; }
      const op = OPS.find((o) => s.startsWith(o, i));
      if (!op) return { error: `unexpected '${c}'`, line };
      out.push({ t: 'op', v: op, line });
      i += op.length;
    }
    out.push({ t: 'nl', line });
  }
  return out;
}

// ---- syntax tree -------------------------------------------------------------------------------

type Expr =
  | { k: 'num'; v: bigint }
  | { k: 'var'; name: string; line: number }
  | { k: 'un'; op: string; a: Expr }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'call'; fn: string; args: Expr[]; line: number };

type CellExpr = { k: 'lit'; v: 'X' | 'Z' | 'C' } | { k: 'val'; e: Expr } | { k: 'bits'; n: Expr; e: Expr; line: number };

type Stmt =
  | { k: 'row'; cells: CellExpr[]; line: number }
  | { k: 'repeat'; n: Expr; row: Stmt & { k: 'row' }; line: number }
  | { k: 'loop'; v: string; n: Expr; body: Stmt[]; line: number }
  | { k: 'while'; cond: Expr; body: Stmt[]; line: number }
  | { k: 'let'; v: string; e: Expr; line: number }
  | { k: 'reset'; line: number };

class Fail extends Error {
  constructor(msg: string, readonly line: number) { super(msg); }
}

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}
  private peek(): Tok | undefined { return this.toks[this.i]; }
  private line(): number { return this.peek()?.line ?? this.toks[this.toks.length - 1]?.line ?? 1; }
  private isOp(v: string): boolean { const t = this.peek(); return !!t && t.t === 'op' && t.v === v; }
  private isId(v?: string): boolean { const t = this.peek(); return !!t && t.t === 'id' && (v === undefined || t.v.toLowerCase() === v); }
  private op(v: string): void {
    if (!this.isOp(v)) throw new Fail(`expected '${v}'`, this.line());
    this.i++;
  }
  private ident(): string {
    const t = this.peek();
    if (!t || t.t !== 'id') throw new Fail('expected a name', this.line());
    this.i++;
    return t.v;
  }
  skipNl(): void { while (this.peek()?.t === 'nl') this.i++; }
  done(): boolean { this.skipNl(); return this.i >= this.toks.length; }

  header(): string[] {
    this.skipNl();
    const names: string[] = [];
    while (this.peek() && this.peek()!.t !== 'nl') names.push(this.ident());
    if (!names.length) throw new Fail('the first line names the signals (the chip\'s pins)', this.line());
    return names;
  }

  /** Statements until `end <what>` (consumed) or the end of the text. */
  block(end?: string): Stmt[] {
    const out: Stmt[] = [];
    for (;;) {
      this.skipNl();
      if (!this.peek()) {
        if (end) throw new Fail(`'end ${end}' missing`, this.line());
        return out;
      }
      if (this.isId('end')) {
        const line = this.line();
        this.i++;
        const w = this.isId() ? this.ident().toLowerCase() : '';
        if (!end || w !== end) throw new Fail(end ? `expected 'end ${end}'` : `'end ${w}' without a ${w || 'block'}`, line);
        return out;
      }
      out.push(this.stmt());
    }
  }

  private stmt(): Stmt {
    const line = this.line();
    if (this.isId('repeat') && this.toks[this.i + 1]?.t === 'op') {
      this.i++;
      this.op('(');
      const n = this.expr();
      this.op(')');
      return { k: 'repeat', n, row: this.row(), line };
    }
    if (this.isId('loop')) {
      this.i++;
      this.op('(');
      const v = this.ident();
      this.op(',');
      const n = this.expr();
      this.op(')');
      return { k: 'loop', v, n, body: this.block('loop'), line };
    }
    if (this.isId('while')) {
      this.i++;
      this.op('(');
      const cond = this.expr();
      this.op(')');
      return { k: 'while', cond, body: this.block('while'), line };
    }
    if (this.isId('let') || this.isId('declare')) {
      this.i++;
      const v = this.ident();
      this.op('=');
      const e = this.expr();
      this.op(';');
      return { k: 'let', v, e, line };
    }
    if (this.isId('resetrandom')) {
      this.i++;
      this.op(';');
      return { k: 'reset', line };
    }
    for (const w of ['program', 'memory', 'init', 'virtual']) {
      if (this.isId(w.toLowerCase())) throw new Fail(`'${w}' is not supported here (memories and programs are set on their parts)`, line);
    }
    return this.row();
  }

  private row(): Stmt & { k: 'row' } {
    const line = this.line();
    const cells: CellExpr[] = [];
    while (this.peek() && this.peek()!.t !== 'nl') {
      const t = this.peek()!;
      if (t.t === 'id' && /^[xzc]$/i.test(t.v)) { this.i++; cells.push({ k: 'lit', v: t.v.toUpperCase() as 'X' | 'Z' | 'C' }); continue; }
      if (t.t === 'id' && t.v.toLowerCase() === 'bits') {
        this.i++;
        this.op('(');
        const n = this.expr();
        this.op(',');
        const e = this.expr();
        this.op(')');
        cells.push({ k: 'bits', n, e, line: t.line });
        continue;
      }
      if (t.t === 'num') { this.i++; cells.push({ k: 'val', e: { k: 'num', v: t.v } }); continue; }
      if (t.t === 'op' && t.v === '-' && this.toks[this.i + 1]?.t === 'num') {
        this.i++;
        const v = (this.peek() as { v: bigint }).v;
        this.i++;
        cells.push({ k: 'val', e: { k: 'num', v: -v } });
        continue;
      }
      if (t.t === 'op' && t.v === '(') { this.i++; const e = this.expr(); this.op(')'); cells.push({ k: 'val', e }); continue; }
      throw new Fail(t.t === 'id' ? `'${t.v}' in a row: an expression goes in parentheses, (${t.v})` : `unexpected '${t.t === 'op' ? t.v : ''}' in a row`, t.line);
    }
    return { k: 'row', cells, line };
  }

  // Precedence, loosest first, as Digital's.
  private static LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '<=', '>', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

  expr(level = 0): Expr {
    if (level === Parser.LEVELS.length) return this.unary();
    let a = this.expr(level + 1);
    while (Parser.LEVELS[level].some((o) => this.isOp(o))) {
      const op = (this.peek() as { v: string }).v;
      this.i++;
      a = { k: 'bin', op, a, b: this.expr(level + 1) };
    }
    return a;
  }

  private unary(): Expr {
    for (const op of ['-', '~', '!']) {
      if (this.isOp(op)) { this.i++; return { k: 'un', op, a: this.unary() }; }
    }
    const t = this.peek();
    if (!t || t.t === 'nl') throw new Fail('expression ends too early', this.line());
    if (t.t === 'num') { this.i++; return { k: 'num', v: t.v }; }
    if (t.t === 'op' && t.v === '(') { this.i++; const e = this.expr(); this.op(')'); return e; }
    if (t.t === 'id') {
      this.i++;
      if (this.isOp('(')) {
        this.i++;
        const args: Expr[] = [];
        if (!this.isOp(')')) {
          args.push(this.expr());
          while (this.isOp(',')) { this.i++; args.push(this.expr()); }
        }
        this.op(')');
        return { k: 'call', fn: t.v, args, line: t.line };
      }
      return { k: 'var', name: t.v, line: t.line };
    }
    throw new Fail(`unexpected '${t.v}'`, t.line);
  }
}

// ---- evaluation ----------------------------------------------------------------------------------

const B = (b: boolean) => (b ? 1n : 0n);

class Runner {
  rows: TestRow[] = [];
  private vars = new Map<string, bigint>();
  private seed = 1n;

  constructor(private width: number) {}

  private random(n: bigint): bigint {
    // a fixed LCG: the same table gives the same rows every run (Digital's resetRandom restarts it)
    this.seed = (this.seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return n > 0n ? (this.seed >> 16n) % n : 0n;
  }

  ev(e: Expr): bigint {
    switch (e.k) {
      case 'num': return e.v;
      case 'var': {
        const v = this.vars.get(e.name);
        if (v === undefined) throw new Fail(`no variable '${e.name}'`, e.line);
        return v;
      }
      case 'un': {
        const a = this.ev(e.a);
        return e.op === '-' ? -a : e.op === '~' ? ~a : B(a === 0n);
      }
      case 'bin': {
        if (e.op === '&&') return B(this.ev(e.a) !== 0n && this.ev(e.b) !== 0n);
        if (e.op === '||') return B(this.ev(e.a) !== 0n || this.ev(e.b) !== 0n);
        const a = this.ev(e.a), b = this.ev(e.b);
        switch (e.op) {
          case '+': return a + b;
          case '-': return a - b;
          case '*': return a * b;
          case '/': return b === 0n ? 0n : a / b;
          case '%': return b === 0n ? 0n : a % b;
          case '&': return a & b;
          case '|': return a | b;
          case '^': return a ^ b;
          case '<<': return b > 1024n ? 0n : a << b;
          case '>>': return a >> b;
          case '==': return B(a === b);
          case '!=': return B(a !== b);
          case '<': return B(a < b);
          case '<=': return B(a <= b);
          case '>': return B(a > b);
          default: return B(a >= b);
        }
      }
      case 'call': {
        const f = e.fn.toLowerCase();
        const args = e.args.map((x) => this.ev(x));
        const want = (n: number) => { if (args.length !== n) throw new Fail(`${e.fn} takes ${n} argument${n > 1 ? 's' : ''}`, e.line); };
        if (f === 'random') { want(1); return this.random(args[0]); }
        if (f === 'ite') { want(3); return args[0] !== 0n ? args[1] : args[2]; }
        if (f === 'signext') { want(2); return BigInt.asIntN(Number(args[1]), args[0]); }
        throw new Fail(`no function '${e.fn}' (there are random, ite, signExt)`, e.line);
      }
    }
  }

  private count(e: Expr, line: number): number {
    const n = this.ev(e);
    if (n < 0n) throw new Fail('a count must not be negative', line);
    if (n > BigInt(MAX_ROWS)) throw new Fail(`at most ${MAX_ROWS} rows`, line);
    return Number(n);
  }

  private push(cells: Cell[], line: number, where?: string, computed?: boolean[]): void {
    if (cells.length !== this.width) throw new Fail(`${cells.length} value${cells.length === 1 ? '' : 's'} for ${this.width} signal${this.width === 1 ? '' : 's'}`, line);
    if (this.rows.length >= MAX_ROWS) throw new Fail(`at most ${MAX_ROWS} rows`, line);
    const row: TestRow = { cells, line };
    if (where) row.where = where;
    if (computed?.some((c) => c)) row.computed = computed;
    this.rows.push(row);
  }

  private row(r: Stmt & { k: 'row' }, where?: string): void {
    const cells: Cell[] = [];
    const computed: boolean[] = [];
    for (const c of r.cells) {
      if (c.k === 'lit') cells.push(c.v);
      else if (c.k === 'val') {
        computed[cells.length] = c.e.k !== 'num';
        cells.push(this.ev(c.e));
      }
      else {
        const n = this.count(c.n, c.line), v = this.ev(c.e);
        for (let b = n - 1; b >= 0; b--) cells.push((v >> BigInt(b)) & 1n);
      }
    }
    this.push(cells, r.line, where, computed);
  }

  private where(): string | undefined {
    const vs = [...this.vars].filter(([k]) => this.scoped.includes(k));
    return vs.length ? vs.map(([k, v]) => `${k} = ${v}`).join(', ') : undefined;
  }
  /** Loop variables in force, outermost first: named in a row's `where`. */
  private scoped: string[] = [];

  run(stmts: Stmt[]): void {
    for (const s of stmts) {
      switch (s.k) {
        case 'row': this.row(s, this.where()); break;
        case 'let': this.vars.set(s.v, this.ev(s.e)); break;
        case 'reset': this.seed = 1n; break;
        case 'repeat': {
          const n = this.count(s.n, s.line);
          const old = this.vars.get('n');
          this.scoped.push('n');
          for (let i = 0; i < n; i++) { this.vars.set('n', BigInt(i)); this.row(s.row, this.where()); }
          this.scoped.pop();
          if (old === undefined) this.vars.delete('n'); else this.vars.set('n', old);
          break;
        }
        case 'loop': {
          const n = this.count(s.n, s.line);
          const old = this.vars.get(s.v);
          this.scoped.push(s.v);
          for (let i = 0; i < n; i++) { this.vars.set(s.v, BigInt(i)); this.run(s.body); }
          this.scoped.pop();
          if (old === undefined) this.vars.delete(s.v); else this.vars.set(s.v, old);
          break;
        }
        case 'while': {
          let guard = 0;
          while (this.ev(s.cond) !== 0n) {
            if (++guard > MAX_WHILE) throw new Fail('the while loop does not end', s.line);
            this.run(s.body);
          }
          break;
        }
      }
    }
  }
}

/** A table's signal names and rows, every repeat / loop unrolled; or the first error with its line. */
export function parseTest(src: string): ParsedTest | TestError {
  const toks = tokenize(src);
  if ('error' in toks) return toks;
  try {
    const p = new Parser(toks);
    const names = p.header();
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) return { error: `'${dup}' named twice`, line: toks[0]?.line ?? 1 };
    const body = p.block();
    const r = new Runner(names.length);
    r.run(body);
    return { names, rows: r.rows };
  } catch (e) {
    if (e instanceof Fail) return { error: e.message, line: e.line };
    throw e;
  }
}

// ---- a table as a challenge --------------------------------------------------------------------

/** A parsed table on a chip: the challenge that runs it, and each step's row (X inputs give a row several steps). */
export interface TestPlan {
  ch: BuildChallenge;
  /** Per step: the row index in ParsedTest.rows. */
  rowOf: number[];
  rows: TestRow[];
  /** Columns not checked, said once ("Z expected on y: not checked"). */
  notes: string[];
}

/** Values a pin of width w takes from a cell (two's complement for a negative number); null when it does not fit. */
function fit(v: bigint, w: number): number | null {
  const m = (1n << BigInt(w)) - 1n;
  if (v < -(1n << BigInt(w - 1)) - (w === 1 ? 1n : 0n) || v > m) return null;
  const u = v & m;
  return u > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(u);
}

/**
 * The table as a sequence over the compiled chip's pins: its inputs not named in the table held at 0, its outputs
 * not named left unchecked. `name` names the table in Check's messages.
 */
export function planTest(def: ComponentDef, test: TestDoc): TestPlan | TestError {
  const parsed = parseTest(test.src);
  if ('error' in parsed) return parsed;
  const ports = def.ports;
  const cols = parsed.names.map((n) => ports.find((p) => p.name === n));
  const missing = parsed.names.findIndex((_, i) => !cols[i]);
  if (missing >= 0) return { error: `no pin named '${parsed.names[missing]}' (pins: ${ports.map((p) => p.name).join(', ') || 'none'})`, line: 1 };
  const inout = cols.find((p) => p!.dir === 'inout');
  if (inout) return { error: `'${inout.name}' is bidirectional: a table drives inputs and checks outputs`, line: 1 };
  const clocks = [...new Set(parsed.rows.flatMap((r) => r.cells.flatMap((c, i) => (c === 'C' ? [i] : []))))];
  if (clocks.length > 1) return { error: `one clock column only (C under ${clocks.map((i) => parsed.names[i]).join(' and ')})`, line: parsed.rows.find((r) => r.cells.filter((c) => c === 'C').length)?.line ?? 1 };
  const clockCol = clocks[0];
  if (clockCol !== undefined && cols[clockCol]!.dir !== 'in') return { error: `C is a clock: '${parsed.names[clockCol]}' is an output`, line: 1 };
  const portSpecs: PinSpec[] = ports.filter((p) => p.dir !== 'inout').map((p) => ({
    name: p.name, dir: p.dir as 'in' | 'out', width: p.width, ...(clockCol !== undefined && p.name === parsed.names[clockCol] ? { clock: true } : {}),
  }));
  const notes = new Set<string>();
  const steps: SeqStep[] = [];
  const rowOf: number[] = [];
  for (let r = 0; r < parsed.rows.length; r++) {
    const row = parsed.rows[r];
    const set: Record<string, number> = {};
    const expect: Record<string, number> = {};
    const free: { name: string; width: number }[] = [];
    let tick = false;
    for (let i = 0; i < cols.length; i++) {
      const p = cols[i]!, c = row.cells[i];
      if (c === 'C') { tick = true; continue; }
      if (c === 'Z') {
        if (p.dir === 'in') return { error: `Z drives nothing: '${p.name}' is an input`, line: row.line };
        notes.add(`Z expected on ${p.name}: not checked (a pin's high impedance shows at switch level only)`);
        continue;
      }
      if (c === 'X') {
        if (p.dir === 'in') free.push({ name: p.name, width: p.width });
        continue;
      }
      const v = row.computed?.[i] ? fit(BigInt.asUintN(p.width, c), p.width) : fit(c, p.width);
      if (v === null) return { error: `${c} does not fit '${p.name}' (${p.width} bit${p.width > 1 ? 's' : ''})${p.width > 53 ? ': tables take up to 53 bits a column' : ''}`, line: row.line };
      (p.dir === 'in' ? set : expect)[p.name] = v;
    }
    const bits = free.reduce((a, f) => a + f.width, 0);
    if (bits > 16) return { error: `X on ${bits} input bits: at most 16 a row`, line: row.line };
    if (steps.length + 2 ** bits > MAX_ROWS) return { error: `at most ${MAX_ROWS} rows (the X inputs multiply them)`, line: row.line };
    for (let v = 0; v < 2 ** bits; v++) {
      const s = { ...set };
      let rest = v;
      for (let f = free.length - 1; f >= 0; f--) {
        s[free[f].name] = rest % 2 ** free[f].width;
        rest = Math.floor(rest / 2 ** free[f].width);
      }
      steps.push({ set: s, ...(tick ? { tick: true } : {}), expect });
      rowOf.push(r);
    }
  }
  const ch: BuildChallenge = {
    id: `test_${test.name}`, title: test.name, level: 'gates', brief: '', ports: portSpecs,
    check: { kind: 'sequence', steps }, allowed: 'any', answer: () => [],
  };
  return { ch, rowOf, rows: parsed.rows, notes: [...notes] };
}

/** The chip's tables, or none. */
export const testsOf = (doc: ChipDoc): TestDoc[] => doc.tests ?? [];

/** A fresh table for a chip: its pins as the header and one row of zeros (outputs X: fill them from the circuit). */
export function starterTest(doc: ChipDoc, name: string): TestDoc {
  const pins = doc.pins.filter((p) => p.dir !== 'inout');
  const ins = pins.filter((p) => p.dir === 'in'), outs = pins.filter((p) => p.dir === 'out');
  const head = [...ins, ...outs].map((p) => p.name);
  const row = [...ins.map(() => '0'), ...outs.map(() => 'X')];
  const pad = head.map((h, i) => Math.max(h.length, row[i].length));
  const line = (xs: string[]) => xs.map((x, i) => x.padEnd(pad[i])).join(' ').trimEnd();
  return { name, src: `${line(head)}\n${line(row)}\n` };
}

// ---- running a table ---------------------------------------------------------------------------

export interface StepResult {
  /** Per output column of the table (ParsedTest order, outputs only): what the circuit showed after the step. */
  got: Bit[][];
  ok: boolean;
}

export interface TestRun {
  /** One per step that ran; a step that did not settle ends the run (`error`). */
  steps: StepResult[];
  /** Indices of the failing steps. */
  failed: number[];
  /** The output columns: names in table order. */
  outputs: string[];
  error?: string;
}

/**
 * Runs a plan on a fresh simulation from power-on, as Check runs a sequence (challenges.ts seqStart / seqStep), keeping
 * what every output showed so the pane can list rows and "Fill outputs from the circuit" can write them.
 */
export function runTest(def: ComponentDef, mode: 'gate' | 'switch', plan: TestPlan, names: string[]): TestRun {
  const c = plan.ch.check as Extract<BuildChallenge['check'], { kind: 'sequence' }>;
  const outputs = names.filter((n) => plan.ch.ports.some((p) => p.name === n && p.dir === 'out'));
  const run: TestRun = { steps: [], failed: [], outputs };
  try {
    const { sim } = simFor(def, mode);
    const vals = seqStart(sim, plan.ch.ports, c);
    const clk = seqClock(plan.ch.ports);
    c.steps.forEach((st, k) => {
      seqStep(sim, clk, st, k, vals);
      const got = outputs.map((n) => sim.getBits(sim.design.root.ports[n]));
      const ok = outputs.every((n, i) => st.expect[n] === undefined || matches(got[i], st.expect[n]));
      run.steps.push({ got, ok });
      if (!ok) run.failed.push(k);
    });
  } catch (e) {
    run.error = e instanceof Error ? e.message : String(e);
    if (run.steps.length < c.steps.length) run.failed.push(run.steps.length);
  }
  return run;
}

/**
 * The table with its outputs filled in from a run: on every line that is a plain row (literal values, one row, no X
 * input), each output's cell becomes what the circuit showed (X where it showed X). Lines inside repeat / loop and
 * rows with expressions are left as they are; `kept` counts them.
 */
export function fillOutputs(src: string, plan: TestPlan, names: string[], run: TestRun): { src: string; filled: number; kept: number } {
  const lines = src.split(/\r?\n/);
  const stepsOfLine = new Map<number, number[]>();
  plan.rowOf.forEach((r, k) => {
    const l = plan.rows[r].line;
    const xs = stepsOfLine.get(l) ?? [];
    xs.push(k);
    stepsOfLine.set(l, xs);
  });
  const outCols = names.map((n, i) => (run.outputs.includes(n) ? i : -1)).filter((i) => i >= 0);
  let filled = 0, kept = 0;
  for (const [line, ks] of stepsOfLine) {
    const text = lines[line - 1];
    const m = /^(\s*)([^#]*?)(\s*(#.*)?)$/.exec(text);
    const cells = m ? m[2].split(/\s+/) : [];
    const plain = ks.length === 1 && cells.length === names.length && cells.every((c) => /^(-?[0-9][0-9_]*|0[xXbBoO][0-9a-fA-F_]+|[xXzZcC])$/.test(c));
    if (!plain || ks[0] >= run.steps.length) { kept++; continue; }
    const got = run.steps[ks[0]].got;
    for (const i of outCols) {
      const g = got[run.outputs.indexOf(names[i])];
      if (g.some((b) => b !== 0 && b !== 1)) { cells[i] = 'X'; continue; }
      const v = g.reduce((a, b, j) => a + (b === 1 ? 2n ** BigInt(j) : 0n), 0n);
      // keep the cell's own base: hex stays hex, binary binary
      const was = cells[i];
      cells[i] = /^0[xX]/.test(was) ? `0x${v.toString(16)}` : /^0[bB]/.test(was) ? `0b${v.toString(2).padStart(g.length, '0')}` : v.toString();
    }
    lines[line - 1] = `${m![1]}${cells.join(' ')}${m![3]}`;
    filled++;
  }
  return { src: lines.join('\n'), filled, kept };
}
