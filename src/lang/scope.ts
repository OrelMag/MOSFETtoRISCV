// Static checks and name resolution shared by the compiler and the interpreter: which names are functions,
// global lists, global scalars and each function's locals (Python's rule: a name assigned in a function is
// local unless declared global), with the errors Python would raise, found before anything runs.

import { BUILTINS, PyError } from './ast';
import type { Expr, Module, Stmt } from './ast';
import { constValue } from './parse';

export interface FuncInfo {
  name: string;
  line: number;
  params: string[];
  /** Params first, then other assigned names, in order of first appearance. */
  locals: string[];
  globals: Set<string>;
  /** Calls a user function (so it needs its return address and the callee may clobber temporaries). */
  callsUser: boolean;
  body: Stmt[];
  end: number;
}

export interface ListInfo { name: string; line: number; len: number; init: number[] }

export interface Scope {
  funcs: Map<string, FuncInfo>;
  lists: Map<string, ListInfo>;
  /** Scalars assigned at the top level, in order of first appearance. */
  globals: string[];
  /** Global scalars a function reads or writes: these must live in memory, where every function sees them. */
  shared: Set<string>;
}

const MAX_LIST = 1024;

function walkStmts(body: Stmt[], f: (s: Stmt) => void): void {
  for (const s of body) {
    f(s);
    if (s.kind === 'if') { walkStmts(s.body, f); walkStmts(s.orelse, f); }
    else if (s.kind === 'while' || s.kind === 'for') walkStmts(s.body, f);
  }
}

export function walkExpr(e: Expr, f: (e: Expr) => void): void {
  f(e);
  switch (e.kind) {
    case 'bin': case 'bool': walkExpr(e.left, f); walkExpr(e.right, f); break;
    case 'unary': walkExpr(e.arg, f); break;
    case 'cmp': e.args.forEach((a) => walkExpr(a, f)); break;
    // len(xs) is a constant: its argument names a list, it is not read as a value
    case 'call': if (e.fn !== 'len') e.args.forEach((a) => walkExpr(a, f)); break;
    case 'index': walkExpr(e.index, f); break;
    case 'ifexp': walkExpr(e.test, f); walkExpr(e.yes, f); walkExpr(e.no, f); break;
    case 'list': e.items.forEach((a) => walkExpr(a, f)); if (e.repeat) walkExpr(e.repeat, f); break;
  }
}

/** Every expression directly in a statement (not in nested statements). */
export function stmtExprs(s: Stmt): Expr[] {
  switch (s.kind) {
    case 'assign': case 'aug': return [...(s.target.kind === 'index' ? [s.target.index] : []), s.value];
    case 'expr': return [s.value];
    case 'if': case 'while': return [s.test];
    case 'for': return [s.start, s.stop];
    case 'return': return s.value ? [s.value] : [];
    default: return [];
  }
}

export function analyze(mod: Module): Scope {
  const funcs = new Map<string, FuncInfo>();
  const lists = new Map<string, ListInfo>();
  const globals: string[] = [];
  const shared = new Set<string>();
  const builtin = (n: string) => (BUILTINS as readonly string[]).includes(n);

  // Pass 1: top-level definitions (functions, lists, scalars).
  for (const s of mod.body) {
    if (s.kind === 'def') {
      if (builtin(s.name)) throw new PyError(`"${s.name}" is a built-in function`, s.line);
      if (funcs.has(s.name)) throw new PyError(`function "${s.name}" is defined twice`, s.line);
      funcs.set(s.name, { name: s.name, line: s.line, params: s.params, locals: [], globals: new Set(), callsUser: false, body: s.body, end: s.end });
    }
  }
  const declareList = (s: Stmt & { kind: 'assign' }, e: Expr & { kind: 'list' }, name: string) => {
    if (lists.has(name)) throw new PyError(`list "${name}" is created twice (lists have a fixed place in memory)`, s.line);
    const items = e.items.map((it) => {
      const v = constValue(it);
      if (v === null) throw new PyError('list items must be constants', it.line);
      return v;
    });
    let init = items;
    if (e.repeat) {
      const n = constValue(e.repeat);
      if (n === null || n < 0) throw new PyError('the repeat count must be a non-negative constant', s.line);
      init = Array.from({ length: items.length * n }, (_, i) => items[i % items.length]);
    }
    if (init.length === 0) throw new PyError('a list needs at least one element (lists cannot grow)', s.line);
    if (init.length > MAX_LIST) throw new PyError(`lists are limited to ${MAX_LIST} elements`, s.line);
    lists.set(name, { name, line: s.line, len: init.length, init });
  };
  walkStmts(mod.body, (s) => {
    if (s.kind === 'def' || s.kind === 'return') return;
    if (s.kind === 'global') throw new PyError('"global" belongs inside a function', s.line);
    if (s.kind === 'assign' && s.value.kind === 'list') {
      if (s.target.kind !== 'name') throw new PyError('a list can only be assigned to a name', s.line);
      if (!mod.body.includes(s)) throw new PyError('create lists at the top level, outside any block', s.line);
      declareList(s, s.value, s.target.id);
    }
  });
  const noteGlobal = (name: string, line: number) => {
    if (funcs.has(name)) throw new PyError(`"${name}" is a function`, line);
    if (lists.has(name)) throw new PyError(`"${name}" is a list: assign to its elements`, line);
    if (builtin(name)) throw new PyError(`"${name}" is a built-in function`, line);
    if (!globals.includes(name)) globals.push(name);
  };
  walkStmts(mod.body, (s) => {
    if (s.kind === 'def') return;
    if ((s.kind === 'assign' && s.value.kind !== 'list') || s.kind === 'aug') {
      if (s.target.kind === 'name') noteGlobal(s.target.id, s.line);
    } else if (s.kind === 'for') noteGlobal(s.v, s.line);
  });

  // Pass 2: each function's locals.
  for (const fn of funcs.values()) {
    const assigned: string[] = [];
    walkStmts(fn.body, (s) => {
      if (s.kind === 'def') throw new PyError('no nested functions', s.line);
      if (s.kind === 'global') {
        for (const n of s.names) {
          if (fn.params.includes(n)) throw new PyError(`"${n}" is a parameter and global`, s.line);
          if (assigned.includes(n)) throw new PyError(`"${n}" is assigned before its global declaration`, s.line);
          fn.globals.add(n);
        }
      }
      const tgt = (s.kind === 'assign' || s.kind === 'aug') && s.target.kind === 'name' ? s.target.id : s.kind === 'for' ? s.v : null;
      if (s.kind === 'assign' && s.value.kind === 'list') throw new PyError('create lists at the top level', s.line);
      if (tgt !== null && !assigned.includes(tgt)) assigned.push(tgt);
    });
    for (const n of [...fn.params, ...assigned]) {
      if (builtin(n)) throw new PyError(`"${n}" is a built-in function`, fn.line);
      if (funcs.has(n)) throw new PyError(`"${n}" is a function`, fn.line);
      if (lists.has(n) && !fn.params.includes(n)) throw new PyError(`"${n}" is a list: assign to its elements`, fn.line);
    }
    fn.locals = [...fn.params, ...assigned.filter((n) => !fn.params.includes(n) && !fn.globals.has(n))];
    for (const n of fn.globals) {
      if (lists.has(n)) continue;
      if (!globals.includes(n)) globals.push(n);
      shared.add(n);
    }
  }

  // Pass 3: every use resolves, calls have the right arity.
  const checkExprs = (body: Stmt[], fn: FuncInfo | null) => {
    const isLocal = (n: string) => !!fn && fn.locals.includes(n);
    walkStmts(body, (s) => {
      if (s.kind === 'def') return;
      if ((s.kind === 'assign' || s.kind === 'aug') && s.target.kind === 'index') {
        if (!lists.has(s.target.list) || isLocal(s.target.list)) throw new PyError(`"${s.target.list}" is not a list`, s.line);
      }
      if (s.kind === 'for' && lists.has(s.v) && !isLocal(s.v)) throw new PyError(`"${s.v}" is a list`, s.line);
      for (const root of stmtExprs(s)) walkExpr(root, (e) => {
        if (e.kind === 'list' && !(s.kind === 'assign' && s.value === e)) throw new PyError('a list literal can only be assigned to a global name', e.line);
        if (e.kind === 'name') {
          if (isLocal(e.id)) return;
          if (lists.has(e.id)) throw new PyError(`"${e.id}" is a list: index it, or use len(${e.id})`, e.line);
          if (funcs.has(e.id)) throw new PyError(`"${e.id}" is a function: call it`, e.line);
          if (builtin(e.id)) throw new PyError(`"${e.id}" is a built-in function: call it`, e.line);
          if (!globals.includes(e.id)) throw new PyError(`name "${e.id}" is not defined`, e.line);
          if (fn) shared.add(e.id);
        } else if (e.kind === 'index') {
          if (!lists.has(e.list) || isLocal(e.list)) throw new PyError(`"${e.list}" is not a list`, e.line);
        } else if (e.kind === 'call') {
          const n = e.args.length;
          if (e.fn === 'len') {
            const a = e.args[0];
            if (n !== 1 || a.kind !== 'name' || !lists.has(a.id) || isLocal(a.id)) throw new PyError('len() takes one list', e.line);
            return;
          }
          if (e.fn === 'print') { if (n < 1) throw new PyError('print() needs a value to print', e.line); return; }
          if (e.fn === 'abs') { if (n !== 1) throw new PyError('abs() takes one argument', e.line); return; }
          if (e.fn === 'min' || e.fn === 'max') { if (n < 2) throw new PyError(`${e.fn}() takes two or more arguments`, e.line); return; }
          if (e.fn === 'range') throw new PyError('range() only appears in a for loop', e.line);
          const f = funcs.get(e.fn);
          if (!f) throw new PyError(lists.has(e.fn) || globals.includes(e.fn) || isLocal(e.fn) ? `"${e.fn}" is not a function` : `function "${e.fn}" is not defined`, e.line);
          if (n !== f.params.length) throw new PyError(`${e.fn}() takes ${f.params.length} argument${f.params.length === 1 ? '' : 's'}, got ${n}`, e.line);
          if (n > 8) throw new PyError('at most 8 arguments (a0 to a7)', e.line);
          if (fn) fn.callsUser = true;
        }
      });
    });
  };
  checkExprs(mod.body, null);
  for (const fn of funcs.values()) checkExprs(fn.body, fn);

  // A top-level call runs when it is reached: the function must be defined above it.
  const defined = new Set<string>();
  for (const s of mod.body) {
    if (s.kind === 'def') { defined.add(s.name); continue; }
    const calls: { fn: string; line: number }[] = [];
    walkStmts([s], (t) => { for (const r of stmtExprs(t)) walkExpr(r, (e) => { if (e.kind === 'call' && funcs.has(e.fn)) calls.push(e); }); });
    for (const c of calls) if (!defined.has(c.fn)) throw new PyError(`"${c.fn}" is called before its def runs`, c.line);
  }
  return { funcs, lists, globals, shared };
}
