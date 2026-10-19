// The compiler's back end: the checked syntax tree → RV32I assembly for the site's CPUs (no M: * // % call
// shift-and-add / shift-and-subtract routines unless an operand is a power of two). Every emitted line keeps
// the Python line it came from, so the listing, the machine words and the running gates map back to it.
//
// Registers: t0–t6 evaluate expressions (a stack, one per nesting level); s0–s11 hold variables (a function's
// are saved in its frame; the top level's never return); a0–a7 pass arguments and hold a leaf function's
// variables (a leaf calls nothing, so nothing clobbers them); gp points at the next free word of the output
// (print stores there); sp is the stack. Globals that a function reads or writes live in data memory.

import { PyError } from './ast';
import type { BinOpName, CmpOpName, Expr, Module, Stmt, Target } from './ast';
import { binop, cmpop } from './interp';
import { walkExpr, stmtExprs } from './scope';
import type { FuncInfo, Scope } from './scope';

export const TEMPS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'] as const;
const SREGS = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10', 's11'];
const AREGS = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'];

export interface AsmLineOut {
  text: string;
  /** The Python line this line came from (null: the program's frame, a runtime routine). */
  py: number | null;
}

/** Where a variable lives. */
export interface Home {
  name: string;
  /** '' for the top level, else the function's name. */
  scope: string;
  reg?: string;
  addr?: number;
  /** Made by the compiler (a loop's counter or bound), not named in the source. */
  hidden?: boolean;
}

export interface Layout {
  homes: Home[];
  lists: { name: string; addr: number; len: number }[];
  /** First byte of the output (gp's start). */
  outBase: number;
  /** sp's start (the top of data memory). */
  stackTop: number;
  dmemWords: number;
  /** Runtime routines the program needed. */
  runtime: string[];
}

const fitsI = (v: number) => v >= -2048 && v <= 2047;
const log2 = (v: number) => (v > 0 && (v & (v - 1)) === 0 ? 31 - Math.clz32(v) : -1);

/** x * c in shifts: c = 2^k, 2^a + 2^b or 2^a − 1 (else null: the multiply routine). */
function mulPlan(c: number): { k: number } | { a: number; b: number } | { sub: number } | null {
  if (c <= 0) return null;
  if (log2(c) >= 0) return { k: log2(c) };
  const b = log2(c & -c), rest = c - (c & -c);
  if (log2(rest) >= 0) return { a: log2(rest), b };
  if (log2(c + 1) >= 0) return { sub: log2(c + 1) };
  return null;
}

// ---- constant folding (both the runtime decision and the emitted code use the folded tree) ----

export function fold(e: Expr): Expr {
  switch (e.kind) {
    case 'bin': {
      const l = fold(e.left), r = fold(e.right);
      if (l.kind === 'num' && r.kind === 'num') return { kind: 'num', line: e.line, value: binop(e.op, l.value, r.value) };
      return { ...e, left: l, right: r };
    }
    case 'unary': {
      const a = fold(e.arg);
      if (a.kind === 'num') return { kind: 'num', line: e.line, value: e.op === '-' ? -a.value | 0 : e.op === '~' ? ~a.value : e.op === 'not' ? +!a.value : a.value };
      return e.op === '+' ? a : { ...e, arg: a };
    }
    case 'bool': {
      const l = fold(e.left), r = fold(e.right);
      if (l.kind === 'num') return (e.op === 'and' ? !l.value : !!l.value) ? l : r;
      return { ...e, left: l, right: r };
    }
    case 'cmp': {
      const args = e.args.map(fold);
      if (args.every((a) => a.kind === 'num')) {
        const v = e.ops.every((op, k) => cmpop(op, (args[k] as { value: number }).value, (args[k + 1] as { value: number }).value));
        return { kind: 'num', line: e.line, value: +v };
      }
      return { ...e, args };
    }
    case 'ifexp': {
      const t = fold(e.test);
      if (t.kind === 'num') return t.value ? fold(e.yes) : fold(e.no);
      return { ...e, test: t, yes: fold(e.yes), no: fold(e.no) };
    }
    case 'call': return { ...e, args: e.fn === 'len' ? e.args : e.args.map(fold) };
    case 'index': return { ...e, index: fold(e.index) };
    default: return e;
  }
}

/** Does this operation need a runtime routine (RV32I has no multiply or divide)? */
function runtimeOf(op: BinOpName, r: Expr): 'mul' | 'divmod' | null {
  const c = r.kind === 'num' ? r.value : null;
  if (op === '*') return c !== null && mulPlan(c) ? null : 'mul';
  if (op === '//' || op === '%') return c !== null && log2(c) >= 0 ? null : 'divmod';
  return null;
}

function exprRuntime(e: Expr, out: Set<string>): void {
  walkExpr(e, (x) => {
    if (x.kind === 'bin') {
      // a constant on the left of a commutative * is moved to the right
      const r = x.op === '*' && x.left.kind === 'num' ? x.left : x.right;
      const rt = runtimeOf(x.op, r);
      if (rt) out.add(rt);
    }
  });
}

function stmtsRuntime(body: Stmt[], out: Set<string>): void {
  for (const s of body) {
    for (const e of stmtExprs(s)) exprRuntime(e, out);
    if (s.kind === 'aug') {
      const rt = runtimeOf(s.op, s.value);
      if (rt) out.add(rt);
    }
    if (s.kind === 'if') { stmtsRuntime(s.body, out); stmtsRuntime(s.orelse, out); }
    if (s.kind === 'while' || s.kind === 'for' || s.kind === 'def') stmtsRuntime(s.body, out);
  }
}

// ---- folding the statements ----

function foldStmts(body: Stmt[]): Stmt[] {
  return body.map((s): Stmt => {
    const ft = (t: Target): Target => (t.kind === 'index' ? { ...t, index: fold(t.index) } : t);
    switch (s.kind) {
      case 'assign': return { ...s, target: ft(s.target), value: s.value.kind === 'list' ? s.value : fold(s.value) };
      case 'aug': return { ...s, target: ft(s.target), value: fold(s.value) };
      case 'expr': return { ...s, value: fold(s.value) };
      case 'if': return { ...s, test: fold(s.test), body: foldStmts(s.body), orelse: foldStmts(s.orelse) };
      case 'while': return { ...s, test: fold(s.test), body: foldStmts(s.body) };
      case 'for': return { ...s, start: fold(s.start), stop: fold(s.stop), body: foldStmts(s.body) };
      case 'def': return { ...s, body: foldStmts(s.body) };
      case 'return': return { ...s, value: s.value && fold(s.value) };
      default: return s;
    }
  });
}

// ---- loop variables a for loop may count in directly ----

function namesIn(body: Stmt[], skip: Stmt | null, out: Map<string, number>): void {
  for (const s of body) {
    if (s === skip || s.kind === 'def') continue;
    const add = (n: string) => out.set(n, (out.get(n) ?? 0) + 1);
    if ((s.kind === 'assign' || s.kind === 'aug') && s.target.kind === 'name') add(s.target.id);
    if (s.kind === 'for') add(s.v);
    if (s.kind === 'global') s.names.forEach(add);
    for (const e of stmtExprs(s)) walkExpr(e, (x) => { if (x.kind === 'name') add(x.id); });
    if (s.kind === 'if') { namesIn(s.body, skip, out); namesIn(s.orelse, skip, out); }
    if (s.kind === 'while' || s.kind === 'for') namesIn(s.body, skip, out);
  }
}

function assigns(body: Stmt[], v: string): boolean {
  for (const s of body) {
    if ((s.kind === 'assign' || s.kind === 'aug') && s.target.kind === 'name' && s.target.id === v) return true;
    if (s.kind === 'for' && s.v === v) return true;
    if (s.kind === 'if' && (assigns(s.body, v) || assigns(s.orelse, v))) return true;
    if ((s.kind === 'while' || s.kind === 'for') && assigns(s.body, v)) return true;
  }
  return false;
}

interface ForPlan { id: number; direct: boolean; counter: string; stop: string | null }

// ---- the generator ----

interface Loop { cont: string; brk: string }

interface FnCtx {
  name: string;
  info: FuncInfo | null;
  homes: Map<string, Home>;
  /** The epilogue's label, or null when returning is a bare `ret`. */
  retLabel: string | null;
  saved: string[];
}

export class CodeGen {
  readonly out: AsmLineOut[] = [];
  private line: number | null = null;
  private labelN = 0;
  private loops: Loop[] = [];
  private fn!: FnCtx;
  private readonly forPlans = new Map<Stmt, ForPlan>();
  readonly layout: Layout;
  private readonly memHomes = new Map<string, Home>();
  private readonly listAddr = new Map<string, { addr: number; len: number }>();
  private readonly runtime = new Set<string>();

  constructor(private readonly mod: Module, private readonly scope: Scope, private readonly dmemWords: number) {
    const body = foldStmts(mod.body);
    this.mod = { ...mod, body };
    for (const s of body) if (s.kind === 'def') { const f = scope.funcs.get(s.name)!; f.body = s.body; }
    stmtsRuntime(body, this.runtime);
    this.layout = { homes: [], lists: [], outBase: 0, stackTop: 4 * dmemWords, dmemWords, runtime: [] };
  }

  private emit(text: string): void { this.out.push({ text: `        ${text}`, py: this.line }); }
  private label(name: string): void { this.out.push({ text: `${name}:`, py: this.line }); }
  private comment(text: string): void { this.out.push({ text: `# ${text}`, py: this.line }); }
  private newLabel(kind: string): string { return `${kind}.${++this.labelN}`; }
  private err(msg: string, line = this.line ?? 0): never { throw new PyError(msg, line); }

  private tmp(d: number): string {
    if (d >= TEMPS.length) this.err(`this expression nests too deeply: the compiler has ${TEMPS.length} temporaries (t0–t6). Split it with a variable.`);
    return TEMPS[d];
  }

  generate(): AsmLineOut[] {
    const { scope } = this;
    const top = this.mod.body.filter((s) => s.kind !== 'def');

    // Plan the top level's loops and homes, then data memory: shared globals, lists, output, stack.
    const topNames = this.planLoops(top, '', scope.shared);
    let addr = 0;
    const homes = new Map<string, Home>();
    let sNext = 0;
    for (const n of [...scope.globals, ...topNames.filter((n) => !scope.globals.includes(n))]) {
      const hidden = !scope.globals.includes(n);
      if (scope.shared.has(n) || sNext >= SREGS.length) {
        const h: Home = { name: n, scope: '', addr, ...(hidden ? { hidden } : {}) };
        addr += 4;
        homes.set(n, h); this.memHomes.set(n, h);
      } else homes.set(n, { name: n, scope: '', reg: SREGS[sNext++], ...(hidden ? { hidden } : {}) });
    }
    for (const l of scope.lists.values()) {
      this.listAddr.set(l.name, { addr, len: l.len });
      this.layout.lists.push({ name: l.name, addr, len: l.len });
      addr += 4 * l.len;
    }
    this.layout.outBase = addr;
    if (addr > 2040 || addr > 4 * this.dmemWords - 32) this.err(`the variables and lists need ${addr / 4} words: data memory has ${this.dmemWords}, and the stack and output need room too`, 1);
    this.layout.homes.push(...homes.values());

    // The frame: stack, output pointer, the program, halt.
    this.line = null;
    this.comment('set up: the stack at the top of data memory, the output after the data');
    this.emit(`li   sp, ${this.layout.stackTop}`);
    this.emit(`li   gp, ${this.layout.outBase}`);
    this.fn = { name: '', info: null, homes, retLabel: null, saved: [] };
    for (const s of top) this.stmt(s);
    this.line = null;
    const halt = scope.funcs.has('halt') ? 'program.halt' : 'halt';
    this.label(halt);
    this.emit(`j    ${halt}`);

    for (const f of scope.funcs.values()) this.func(f);
    this.emitRuntime();
    this.layout.runtime = [...this.runtime].sort();
    return this.out;
  }

  /** Decide how each for loop counts; returns the hidden variables the scope needs. */
  private planLoops(body: Stmt[], scopeName: string, shared: Set<string>): string[] {
    const hidden: string[] = [];
    const visit = (stmts: Stmt[]) => {
      for (const s of stmts) {
        if (s.kind === 'for') {
          const refs = new Map<string, number>();
          namesIn(body, s, refs);
          const direct = !refs.has(s.v) && !assigns(s.body, s.v) && !(scopeName === '' && shared.has(s.v));
          const k = ++this.labelN;
          const plan: ForPlan = { id: k, direct, counter: direct ? s.v : `for.${k}.i`, stop: s.stop.kind === 'num' ? null : `for.${k}.stop` };
          if (!direct) hidden.push(plan.counter);
          if (plan.stop) hidden.push(plan.stop);
          this.forPlans.set(s, plan);
        }
        if (s.kind === 'if') { visit(s.body); visit(s.orelse); }
        if (s.kind === 'while' || s.kind === 'for') visit(s.body);
      }
    };
    visit(body);
    return hidden;
  }

  private func(f: FuncInfo): void {
    const hidden = this.planLoops(f.body, f.name, new Set());
    const rt = new Set<string>();
    stmtsRuntime(f.body, rt);
    const leaf = !f.callsUser && rt.size === 0;
    const names = [...f.locals, ...hidden];
    const regs = leaf ? [...AREGS, ...SREGS] : SREGS;
    if (names.length > regs.length) this.err(`${f.name}() has ${names.length} variables: the compiler keeps them in registers, at most ${regs.length}`, f.line);
    const homes = new Map<string, Home>();
    names.forEach((n, i) => homes.set(n, { name: n, scope: f.name, reg: regs[i], ...(i >= f.locals.length ? { hidden: true } : {}) }));
    for (const [n, h] of this.memHomes) if (!homes.has(n)) homes.set(n, h);
    this.layout.homes.push(...[...homes.values()].filter((h) => h.scope === f.name));
    const saved = [...(leaf ? [] : ['ra']), ...names.map((n) => homes.get(n)!.reg!).filter((r) => r.startsWith('s'))];
    this.fn = { name: f.name, info: f, homes, retLabel: saved.length ? `${f.name}.ret` : null, saved };

    this.line = f.line;
    this.out.push({ text: '', py: null });
    this.label(f.name);
    if (saved.length) {
      this.emit(`addi sp, sp, -${4 * saved.length}`);
      saved.forEach((r, i) => this.emit(`sw   ${r}, ${4 * i}(sp)`));
    }
    if (!leaf) f.params.forEach((p, i) => this.emit(`mv   ${homes.get(p)!.reg}, a${i}`));
    for (const s of f.body) this.stmt(s);
    const last = f.body[f.body.length - 1];
    if (!last || last.kind !== 'return') {
      this.line = f.end;
      this.emit('li   a0, 0');
      if (!saved.length) this.emit('ret');
    }
    if (saved.length) {
      this.line = f.end;
      this.label(`${f.name}.ret`);
      saved.forEach((r, i) => this.emit(`lw   ${r}, ${4 * i}(sp)`));
      this.emit(`addi sp, sp, ${4 * saved.length}`);
      this.emit('ret');
    }
  }

  private home(id: string): Home {
    const h = this.fn.homes.get(id) ?? this.memHomes.get(id);
    if (!h) this.err(`internal: no home for "${id}"`);
    return h;
  }

  // ---- statements ----

  private stmt(s: Stmt): void {
    this.line = s.line;
    if (s.kind !== 'def' && s.kind !== 'global' && s.kind !== 'pass') this.comment(this.mod.lines[s.line - 1].trim());
    switch (s.kind) {
      case 'def': case 'global': case 'pass': return;
      case 'assign': {
        if (s.value.kind === 'list') return this.listInit(s.target as { id: string }, s.line);
        if (s.target.kind === 'name') return this.assignName(s.target.id, s.value);
        const v = this.gen(s.value, 0);
        return this.storeIndex(s.target, v, 1);
      }
      case 'aug': {
        if (s.target.kind === 'name') {
          const value: Expr = { kind: 'bin', line: s.line, op: s.op, left: { kind: 'name', line: s.line, id: s.target.id }, right: s.value };
          return this.assignName(s.target.id, value);
        }
        // xs[i] op= v: the element's address is computed once
        const { addr: base } = this.listAddr.get(s.target.list)!;
        if (s.target.index.kind === 'num') {
          const a = base + 4 * s.target.index.value;
          this.emit(`lw   t0, ${a}(zero)`);
          const r = this.binTo(s.op, 't0', s.value, 1, 't0');
          this.emit(`sw   ${r}, ${a}(zero)`);
        } else {
          const i = this.gen(s.target.index, 0);
          this.emit(`slli t0, ${i}, 2`);
          this.emit(`lw   t1, ${base}(t0)`);
          const r = this.binTo(s.op, 't1', s.value, 2, 't1');
          this.emit(`sw   ${r}, ${base}(t0)`);
        }
        return;
      }
      // a call's result is not wanted: it stays in a0
      case 'expr': if (s.value.kind === 'call' && this.scope.funcs.has(s.value.fn)) this.call(s.value, 0, 'a0'); else this.gen(s.value, 0); return;
      case 'if': {
        const els = this.newLabel('else'), end = s.orelse.length ? this.newLabel('endif') : els;
        this.jumpIf(s.test, false, els, 0);
        for (const b of s.body) this.stmt(b);
        if (s.orelse.length) { this.line = s.line; this.emit(`j    ${end}`); }
        this.line = s.line;
        this.label(els);
        if (s.orelse.length) {
          for (const b of s.orelse) this.stmt(b);
          this.line = s.line;
          this.label(end);
        }
        return;
      }
      case 'while': {
        const top = this.newLabel('while'), end = `${top}.end`;
        this.label(top);
        this.jumpIf(s.test, false, end, 0);
        this.loops.push({ cont: top, brk: end });
        for (const b of s.body) this.stmt(b);
        this.loops.pop();
        this.line = s.line;
        this.emit(`j    ${top}`);
        this.label(end);
        return;
      }
      case 'for': return this.forLoop(s);
      case 'return': {
        if (s.value) this.genTo(s.value, 0, 'a0');
        else this.emit('li   a0, 0');
        const f = this.fn.info!;
        if (s === f.body[f.body.length - 1] && this.fn.retLabel) return; // falls into the epilogue
        this.emit(this.fn.retLabel ? `j    ${this.fn.retLabel}` : 'ret');
        return;
      }
      case 'break': case 'continue': {
        const l = this.loops[this.loops.length - 1];
        if (!l) this.err(`"${s.kind}" outside a loop`);
        this.emit(`j    ${s.kind === 'break' ? l.brk : l.cont}`);
        return;
      }
    }
  }

  private listInit(t: { id: string }, line: number): void {
    const l = this.scope.lists.get(t.id)!, { addr } = this.listAddr.get(t.id)!;
    const v0 = l.init[0];
    if (l.len > 4 && v0 !== 0 && l.init.every((v) => v === v0)) {
      // [v] * n: a loop of stores (the ROM is the only place a program's constants can come from)
      const top = this.newLabel('fill');
      this.emit(`li   t0, ${v0}`);
      this.emit(`li   t1, ${addr}`);
      this.emit(`li   t2, ${addr + 4 * l.len}`);
      this.label(top);
      this.emit('sw   t0, 0(t1)');
      this.emit('addi t1, t1, 4');
      this.emit(`blt  t1, t2, ${top}`);
      return;
    }
    // Data memory powers on to zeros: only the non-zero elements are stored.
    l.init.forEach((v, i) => {
      if (v === 0) return;
      const r = this.gen({ kind: 'num', line, value: v }, 0);
      this.emit(`sw   ${r}, ${addr + 4 * i}(zero)`);
    });
  }

  private assignName(id: string, value: Expr): void {
    const h = this.home(id);
    if (h.reg) this.genTo(value, 0, h.reg);
    else {
      const r = this.gen(value, 0);
      this.emit(`sw   ${r}, ${h.addr}(zero)`);
    }
  }

  private storeIndex(t: Target & { kind: 'index' }, v: string, d: number): void {
    const { addr: base } = this.listAddr.get(t.list)!;
    if (t.index.kind === 'num') { this.emit(`sw   ${v}, ${base + 4 * t.index.value}(zero)`); return; }
    const i = this.gen(t.index, d), a = this.tmp(d);
    this.emit(`slli ${a}, ${i}, 2`);
    this.emit(`sw   ${v}, ${base}(${a})`);
  }

  private forLoop(s: Stmt & { kind: 'for' }): void {
    const plan = this.forPlans.get(s)!;
    const top = `for.${plan.id}`, cont = `${top}.next`, end = `${top}.end`;
    const c = this.home(plan.counter);
    const cReg = this.varReg(c, 0);
    // range's bounds are both evaluated before the loop variable changes: a bound that reads it waits in t0
    let reads = false;
    walkExpr(s.stop, (x) => { if (x.kind === 'name' && x.id === plan.counter) reads = true; });
    const startReg = plan.stop && reads ? 't0' : cReg;
    this.genTo(s.start, 0, startReg);
    if (startReg === cReg && !c.reg) this.emit(`sw   ${cReg}, ${c.addr}(zero)`);
    if (plan.stop) {
      const h = this.home(plan.stop), d = startReg === cReg ? 0 : 1;
      if (h.reg) this.genTo(s.stop, d, h.reg);
      else this.emit(`sw   ${this.gen(s.stop, d)}, ${h.addr}(zero)`);
    }
    if (startReg !== cReg) this.emit(c.reg ? `mv   ${c.reg}, t0` : `sw   t0, ${c.addr}(zero)`);
    this.label(top);
    {
      const cr = this.loadVar(c, 0);
      const stop = plan.stop ? this.loadVar(this.home(plan.stop), 1) : this.gen(s.stop, 1);
      // exit once the counter reaches the bound (a negative step counts down)
      this.emit(s.step > 0 ? `bge  ${cr}, ${stop}, ${end}` : `ble  ${cr}, ${stop}, ${end}`);
    }
    if (!plan.direct) {
      this.line = s.line;
      this.assignName(s.v, { kind: 'name', line: s.line, id: plan.counter });
    }
    this.loops.push({ cont, brk: end });
    for (const b of s.body) this.stmt(b);
    this.loops.pop();
    this.line = s.line;
    this.label(cont);
    const cr = this.loadVar(c, 0);
    if (fitsI(s.step)) this.emit(`addi ${cReg}, ${cr}, ${s.step}`);
    else { this.emit(`li   t1, ${s.step}`); this.emit(`add  ${cReg}, ${cr}, t1`); }
    if (!c.reg) this.emit(`sw   ${cReg}, ${c.addr}(zero)`);
    this.emit(`j    ${top}`);
    this.label(end);
  }

  /** The register a variable is computed into: its own, or a temporary for one in memory. */
  private varReg(h: Home, d: number): string { return h.reg ?? this.tmp(d); }

  private loadVar(h: Home, d: number): string {
    if (h.reg) return h.reg;
    const t = this.tmp(d);
    this.emit(`lw   ${t}, ${h.addr}(zero)`);
    return t;
  }

  // ---- expressions ----

  /** Evaluate into `dest` (a variable's register, a0, or a temporary). */
  private genTo(e: Expr, d: number, dest: string): void {
    // These write their destination once, after reading every operand: they can compute straight into it.
    const direct = e.kind === 'num' || e.kind === 'name' || e.kind === 'bin' || e.kind === 'unary' || e.kind === 'index'
      || (e.kind === 'cmp' && e.ops.length === 1) || (e.kind === 'call' && !['min', 'max', 'print'].includes(e.fn));
    if (direct) { this.gen(e, d, dest); return; }
    const r = this.gen(e, d);
    if (r !== dest) this.emit(`mv   ${dest}, ${r}`);
  }

  /**
   * Evaluate `e` using temporaries from t<d> up; returns the register holding the value (a variable's own
   * register, zero, or t<d> / dest). With `dest`, the value is computed into it.
   */
  private gen(e: Expr, d: number, dest?: string): string {
    const into = (r: string): string => {
      if (dest && r !== dest) this.emit(`mv   ${dest}, ${r}`);
      return dest ?? r;
    };
    switch (e.kind) {
      case 'num': {
        if (e.value === 0 && !dest) return 'zero';
        const r = dest ?? this.tmp(d);
        this.emit(`li   ${r}, ${e.value}`);
        return r;
      }
      case 'name': {
        const h = this.home(e.id);
        if (h.reg) return into(h.reg);
        const r = dest ?? this.tmp(d);
        this.emit(`lw   ${r}, ${h.addr}(zero)`);
        return r;
      }
      case 'index': {
        const { addr: base } = this.listAddr.get(e.list)!;
        const r = dest ?? this.tmp(d);
        if (e.index.kind === 'num') { this.emit(`lw   ${r}, ${base + 4 * e.index.value}(zero)`); return r; }
        const i = this.gen(e.index, d);
        const a = this.tmp(d);
        this.emit(`slli ${a}, ${i}, 2`);
        this.emit(`lw   ${r}, ${base}(${a})`);
        return r;
      }
      case 'bin': {
        let { left, right } = e;
        if (left.kind === 'num' && right.kind !== 'num' && ['+', '*', '&', '|', '^'].includes(e.op)) [left, right] = [right, left];
        const l = this.gen(left, d);
        return this.binTo(e.op, l, right, d + 1, dest ?? this.tmp(d));
      }
      case 'unary': {
        const a = this.gen(e.arg, d);
        if (e.op === '+') return into(a);
        const r = dest ?? this.tmp(d);
        this.emit(e.op === '-' ? `neg  ${r}, ${a}` : e.op === '~' ? `not  ${r}, ${a}` : `seqz ${r}, ${a}`);
        return r;
      }
      case 'cmp': {
        if (e.ops.length === 1) return this.cmpValue(e.ops[0], e.args[0], e.args[1], d, dest ?? this.tmp(d));
        const r = this.tmp(d), no = this.newLabel('cmp'), end = `${no}.end`;
        this.jumpIf(e, false, no, d);
        this.emit(`li   ${r}, 1`);
        this.emit(`j    ${end}`);
        this.label(no);
        this.emit(`li   ${r}, 0`);
        this.label(end);
        return into(r);
      }
      case 'bool': {
        // the value of the operand that decides, as in Python: `a or b` is a if a is true
        const r = this.tmp(d), end = this.newLabel(e.op);
        this.genTo(e.left, d, r);
        this.emit(`${e.op === 'or' ? 'bnez' : 'beqz'} ${r}, ${end}`);
        this.genTo(e.right, d, r);
        this.label(end);
        return into(r);
      }
      case 'ifexp': {
        const r = this.tmp(d), no = this.newLabel('ifx'), end = `${no}.end`;
        this.jumpIf(e.test, false, no, d);
        this.genTo(e.yes, d, r);
        this.emit(`j    ${end}`);
        this.label(no);
        this.genTo(e.no, d, r);
        this.label(end);
        return into(r);
      }
      case 'list': this.err('internal: a list literal as a value');
      // falls through (unreachable)
      case 'call': return this.call(e, d, dest);
    }
  }

  /** `l op right` into dest; l is already in a register, right is evaluated from t<d>. */
  private binTo(op: BinOpName, l: string, right: Expr, d: number, dest: string): string {
    const c = right.kind === 'num' ? right.value : null;
    if (c !== null) {
      const k = log2(c);
      switch (op) {
        case '+': if (fitsI(c)) { this.emit(`addi ${dest}, ${l}, ${c}`); return dest; } break;
        case '-': if (fitsI(-c)) { this.emit(`addi ${dest}, ${l}, ${-c}`); return dest; } break;
        case '&': if (fitsI(c)) { this.emit(`andi ${dest}, ${l}, ${c}`); return dest; } break;
        case '|': if (fitsI(c)) { this.emit(`ori  ${dest}, ${l}, ${c}`); return dest; } break;
        case '^': if (fitsI(c)) { this.emit(`xori ${dest}, ${l}, ${c}`); return dest; } break;
        case '<<': this.emit(`slli ${dest}, ${l}, ${c & 31}`); return dest;
        case '>>': this.emit(`srai ${dest}, ${l}, ${c & 31}`); return dest;
        // powers of two: a shift (an arithmetic shift right is exactly Python's floor division) or a mask
        case '*': {
          const p = mulPlan(c);
          if (!p) break;
          if ('k' in p) { this.emit(`slli ${dest}, ${l}, ${p.k}`); return dest; }
          // two shifted copies added (3 x = 2 x + x), or one subtracted (7 x = 8 x − x)
          const t = this.tmp(d);
          this.emit(`slli ${t}, ${l}, ${'a' in p ? p.a : p.sub}`);
          if ('a' in p && p.b === 0) this.emit(`add  ${dest}, ${t}, ${l}`);
          else if ('a' in p) { this.emit(`slli ${dest}, ${l}, ${p.b}`); this.emit(`add  ${dest}, ${dest}, ${t}`); }
          else this.emit(`sub  ${dest}, ${t}, ${l}`);
          return dest;
        }
        case '//': if (k >= 0) { this.emit(`srai ${dest}, ${l}, ${k}`); return dest; } break;
        case '%':
          if (k >= 0) {
            if (fitsI(c - 1)) this.emit(`andi ${dest}, ${l}, ${c - 1}`);
            else { const m = this.tmp(d); this.emit(`li   ${m}, ${c - 1}`); this.emit(`and  ${dest}, ${l}, ${m}`); }
            return dest;
          }
          break;
      }
    }
    const r = this.gen(right, d);
    const rt = runtimeOf(op, right);
    if (rt) {
      this.emit(`mv   a0, ${l}`);
      this.emit(`mv   a1, ${r}`);
      this.emit(`jal  ra, rt.${rt}`);
      this.emit(`mv   ${dest}, ${op === '%' ? 'a1' : 'a0'}`);
      return dest;
    }
    const ins: Record<string, string> = { '+': 'add', '-': 'sub', '&': 'and', '|': 'or', '^': 'xor', '<<': 'sll', '>>': 'sra' };
    this.emit(`${ins[op].padEnd(4)} ${dest}, ${l}, ${r}`);
    return dest;
  }

  private cmpValue(op: CmpOpName, a: Expr, b: Expr, d: number, dest: string): string {
    const l = this.gen(a, d);
    const c = b.kind === 'num' ? b.value : null;
    if ((op === '<' || op === '>=') && c !== null && fitsI(c)) {
      this.emit(`slti ${dest}, ${l}, ${c}`);
      if (op === '>=') this.emit(`xori ${dest}, ${dest}, 1`);
      return dest;
    }
    if ((op === '==' || op === '!=') && c !== null && fitsI(-c)) {
      if (c !== 0) this.emit(`addi ${dest}, ${l}, ${-c}`);
      this.emit(`${op === '==' ? 'seqz' : 'snez'} ${dest}, ${c !== 0 ? dest : l}`);
      return dest;
    }
    const r = this.gen(b, d + 1);
    switch (op) {
      case '<': this.emit(`slt  ${dest}, ${l}, ${r}`); break;
      case '>': this.emit(`slt  ${dest}, ${r}, ${l}`); break;
      case '<=': this.emit(`slt  ${dest}, ${r}, ${l}`); this.emit(`xori ${dest}, ${dest}, 1`); break;
      case '>=': this.emit(`slt  ${dest}, ${l}, ${r}`); this.emit(`xori ${dest}, ${dest}, 1`); break;
      case '==': this.emit(`xor  ${dest}, ${l}, ${r}`); this.emit(`seqz ${dest}, ${dest}`); break;
      case '!=': this.emit(`xor  ${dest}, ${l}, ${r}`); this.emit(`snez ${dest}, ${dest}`); break;
    }
    return dest;
  }

  /** Branch to `label` when e's truth equals `when`; falls through otherwise. */
  private jumpIf(e: Expr, when: boolean, label: string, d: number): void {
    switch (e.kind) {
      case 'num': if (!!e.value === when) this.emit(`j    ${label}`); return;
      case 'unary': if (e.op === 'not') return this.jumpIf(e.arg, !when, label, d); break;
      case 'bool': {
        // and: false as soon as one is false; or: true as soon as one is true
        if ((e.op === 'and') === !when) { this.jumpIf(e.left, when, label, d); this.jumpIf(e.right, when, label, d); return; }
        const skip = this.newLabel(e.op);
        this.jumpIf(e.left, !when, skip, d);
        this.jumpIf(e.right, when, label, d);
        this.label(skip);
        return;
      }
      case 'cmp': {
        const skip = when && e.ops.length > 1 ? this.newLabel('cmp') : null;
        let l = this.gen(e.args[0], d);
        for (let k = 0; k < e.ops.length; k++) {
          const last = k === e.ops.length - 1;
          let r = this.gen(e.args[k + 1], d + 1);
          // every link but the last only decides "false"
          if (!last || !when) this.branch(e.ops[k], false, l, r, skip ?? label);
          else this.branch(e.ops[k], true, l, r, label);
          if (!last && r === TEMPS[d + 1]) { this.emit(`mv   ${this.tmp(d)}, ${r}`); r = TEMPS[d]; }
          l = r;
        }
        if (skip) this.label(skip);
        return;
      }
    }
    const r = this.gen(e, d);
    this.emit(`${when ? 'bnez' : 'beqz'} ${r}, ${label}`);
  }

  private branch(op: CmpOpName, when: boolean, l: string, r: string, label: string): void {
    const inv: Record<CmpOpName, CmpOpName> = { '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!=', '!=': '==' };
    const o = when ? op : inv[op];
    const zero = r === 'zero';
    const m: Record<CmpOpName, string> = zero
      ? { '<': `bltz ${l}`, '>=': `bgez ${l}`, '>': `bgtz ${l}`, '<=': `blez ${l}`, '==': `beqz ${l}`, '!=': `bnez ${l}` }
      : { '<': `blt  ${l}, ${r}`, '>=': `bge  ${l}, ${r}`, '>': `bgt  ${l}, ${r}`, '<=': `ble  ${l}, ${r}`, '==': `beq  ${l}, ${r}`, '!=': `bne  ${l}, ${r}` };
    this.emit(`${m[o]}, ${label}`);
  }

  private call(e: Expr & { kind: 'call' }, d: number, dest?: string): string {
    switch (e.fn) {
      case 'print': {
        // Python evaluates every argument before printing any: those up to the last that calls a function
        // (which may print) wait in temporaries; the rest are stored as soon as they are computed.
        const calls = e.args.map((a) => { let c = false; walkExpr(a, (x) => { if (x.kind === 'call' && this.scope.funcs.has(x.fn)) c = true; }); return c; });
        const held = calls.lastIndexOf(true) + 1;
        const regs = e.args.slice(0, held).map((a, i) => this.gen(a, d + i));
        regs.forEach((r, i) => this.emit(`sw   ${r}, ${4 * i}(gp)`));
        e.args.slice(held).forEach((a, i) => this.emit(`sw   ${this.gen(a, d)}, ${4 * (held + i)}(gp)`));
        this.emit(`addi gp, gp, ${4 * e.args.length}`);
        return dest ? (this.emit(`li   ${dest}, 0`), dest) : 'zero';
      }
      case 'len': {
        const r = dest ?? this.tmp(d);
        this.emit(`li   ${r}, ${this.listAddr.get((e.args[0] as { id: string }).id)!.len}`);
        return r;
      }
      case 'abs': {
        const a = this.gen(e.args[0], d), s = this.tmp(d + 1), r = dest ?? this.tmp(d);
        // sign = a >> 31 (all ones if negative); |a| = (a ^ sign) - sign
        this.emit(`srai ${s}, ${a}, 31`);
        this.emit(`xor  ${r}, ${a}, ${s}`);
        this.emit(`sub  ${r}, ${r}, ${s}`);
        return r;
      }
      case 'min': case 'max': {
        const r = this.tmp(d);
        this.genTo(e.args[0], d, r);
        for (const a of e.args.slice(1)) {
          const b = this.gen(a, d + 1), keep = this.newLabel(e.fn);
          this.emit(`${e.fn === 'min' ? 'ble ' : 'bge '} ${r}, ${b}, ${keep}`);
          this.emit(`mv   ${r}, ${b}`);
          this.label(keep);
        }
        if (dest && dest !== r) this.emit(`mv   ${dest}, ${r}`);
        return dest ?? r;
      }
    }
    // A user function: arguments into temporaries, then a0…; the live temporaries are saved around the call
    // (the callee uses t0–t6 too); s registers are the callee's to save.
    const regs = e.args.map((a, i) => this.gen(a, d + i));
    regs.forEach((r, i) => { if (r !== `a${i}`) this.emit(`mv   a${i}, ${r}`); });
    const live = TEMPS.slice(0, d);
    if (live.length) {
      this.emit(`addi sp, sp, -${4 * live.length}`);
      live.forEach((t, i) => this.emit(`sw   ${t}, ${4 * i}(sp)`));
    }
    this.emit(`jal  ra, ${e.fn}`);
    if (live.length) {
      live.forEach((t, i) => this.emit(`lw   ${t}, ${4 * i}(sp)`));
      this.emit(`addi sp, sp, ${4 * live.length}`);
    }
    const r = dest ?? this.tmp(d);
    if (r !== 'a0') this.emit(`mv   ${r}, a0`);
    return r;
  }

  // ---- runtime routines (RV32I has no multiply or divide) ----

  private emitRuntime(): void {
    this.line = null;
    const R = (lines: string[]) => lines.forEach((l) => (l.endsWith(':') ? this.label(l.slice(0, -1)) : l.startsWith('#') ? this.comment(l.slice(2)) : this.emit(l)));
    if (this.runtime.has('mul')) {
      this.out.push({ text: '', py: null });
      R([
        '# a0 = a0 * a1: shift and add, one bit of a1 per pass (RV32I has no multiplier)',
        'rt.mul:',
        'mv   a2, a0',
        'li   a0, 0',
        'rt.mul.loop:',
        'andi a3, a1, 1',
        'beqz a3, rt.mul.skip',
        'add  a0, a0, a2',
        'rt.mul.skip:',
        'slli a2, a2, 1',
        'srli a1, a1, 1',
        'bnez a1, rt.mul.loop',
        'ret',
      ]);
    }
    if (this.runtime.has('divmod')) {
      this.out.push({ text: '', py: null });
      R([
        '# a0 = a0 // a1, a1 = a0 % a1 (Python: rounded toward minus infinity): shift and subtract on the magnitudes',
        'rt.divmod:',
        'bnez a1, rt.div.go',
        'mv   a1, a0',
        'li   a0, -1',
        'ret',
        'rt.div.go:',
        'mv   a4, a0',
        'mv   a5, a1',
        'bgez a0, rt.div.pa',
        'neg  a0, a0',
        'rt.div.pa:',
        'bgez a1, rt.div.pb',
        'neg  a1, a1',
        'rt.div.pb:',
        'li   a2, 0',
        'li   a3, 32',
        'rt.div.loop:',
        'slli a2, a2, 1',
        'srli a6, a0, 31',
        'or   a2, a2, a6',
        'slli a0, a0, 1',
        'bltu a2, a1, rt.div.skip',
        'sub  a2, a2, a1',
        'ori  a0, a0, 1',
        'rt.div.skip:',
        'addi a3, a3, -1',
        'bnez a3, rt.div.loop',
        '# signs: the quotient is negative when the operands differ, the remainder takes the dividend\'s',
        'xor  a6, a4, a5',
        'bgez a6, rt.div.sq',
        'neg  a0, a0',
        'rt.div.sq:',
        'bgez a4, rt.div.sr',
        'neg  a2, a2',
        'rt.div.sr:',
        '# floor: a remainder whose sign differs from the divisor\'s moves the quotient down one',
        'beqz a2, rt.div.done',
        'xor  a6, a2, a5',
        'bgez a6, rt.div.done',
        'addi a0, a0, -1',
        'add  a2, a2, a5',
        'rt.div.done:',
        'mv   a1, a2',
        'ret',
      ]);
    }
  }
}
