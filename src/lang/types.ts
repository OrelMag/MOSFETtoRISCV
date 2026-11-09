// The type pass: each variable, parameter and function result is an int or a str, found by looking at what is assigned
// (a literal, chr(), a concatenation, a call's result …) until nothing changes, then every use checked against it.
// A program with no string in it never gets here (scope.ts), so int-only programs are untouched. The pass writes its
// findings on the tree: `isStr` on an expression whose value is a str, `strCmp` on a comparison of two strs, `isStr` on
// an `s += t`. The interpreter and the compiler both read those marks, so they cannot disagree about a type.

import { MEMORY_BUILTINS, PyError } from './ast';
import type { Expr, Stmt } from './ast';
import type { FuncInfo, Scope } from './scope';

type Ty = 'int' | 'str';

const NO_TRUTH = 'a str has no truth value here: compare it with ==, or test len(s) > 0';

/** Does every path through the statements end in a return? */
function alwaysReturns(body: Stmt[]): boolean {
  const last = body[body.length - 1];
  if (!last) return false;
  if (last.kind === 'return') return true;
  return last.kind === 'if' && last.orelse.length > 0 && alwaysReturns(last.body) && alwaysReturns(last.orelse);
}

export function typePass(body: Stmt[], scope: Scope): void {
  const vars = new Map<string, Ty>();
  const rets = new Map<string, Ty>();
  let changed = false;
  let final = false;

  const isLocal = (id: string, fn: FuncInfo | null) => !!fn && fn.locals.includes(id);
  const keyOf = (id: string, fn: FuncInfo | null) => (isLocal(id, fn) ? `${fn!.name}.${id}` : `.${id}`);
  const isListName = (id: string, fn: FuncInfo | null) => scope.lists.has(id) && !isLocal(id, fn);
  const name = (id: string) => `"${id}"`;
  const tyName = (t: Ty | null) => (t === 'str' ? 'a str' : 'an int');

  const setVar = (key: string, id: string, t: Ty, line: number) => {
    const old = vars.get(key);
    if (old === t) return;
    if (old) throw new PyError(`${name(id)} is ${tyName(old)} in one place and ${tyName(t)} in another: a name keeps one type`, line);
    vars.set(key, t);
    changed = true;
  };
  const setRet = (fn: FuncInfo, t: Ty, line: number) => {
    const old = rets.get(fn.name);
    if (old === t) return;
    if (old) throw new PyError(`${fn.name}() returns ${tyName(old)} on one path and ${tyName(t)} on another`, line);
    rets.set(fn.name, t);
    changed = true;
  };

  const expect = (t: Ty | null, want: Ty, what: string, line: number) => {
    if (final && t !== null && t !== want) throw new PyError(`${what} must be ${tyName(want)}, not ${tyName(t)}`, line);
  };

  const ty = (e: Expr, fn: FuncInfo | null): Ty | null => {
    const r = inner(e, fn);
    if (final && r === 'str') e.isStr = true;
    return r;
  };

  const inner = (e: Expr, fn: FuncInfo | null): Ty | null => {
    switch (e.kind) {
      case 'num': case 'list': return 'int';
      case 'str': return 'str';
      case 'name': return vars.get(keyOf(e.id, fn)) ?? (final ? 'int' : null);
      case 'bin': {
        const l = ty(e.left, fn), r = ty(e.right, fn);
        if (l === 'str' || r === 'str') {
          if (final && (e.op !== '+' || l !== r)) throw new PyError(e.op === '+' ? 'a str can only be added to a str: use chr(n) for a character' : `"${e.op}" does not work on a str: only + (joining) does`, e.line);
          return e.op === '+' ? 'str' : 'int';
        }
        return l === 'int' || r === 'int' || final ? 'int' : null;
      }
      case 'unary': expect(ty(e.arg, fn), 'int', `the operand of "${e.op}"`, e.line); return 'int';
      case 'bool': {
        const l = ty(e.left, fn), r = ty(e.right, fn);
        if (final && (l === 'str' || r === 'str')) throw new PyError(NO_TRUTH, e.line);
        return 'int';
      }
      case 'cmp': {
        const ts = e.args.map((a) => ty(a, fn));
        if (ts.includes('str')) {
          if (final) {
            if (ts.some((t) => t !== 'str')) throw new PyError('a str can only be compared with a str', e.line);
            if (e.args.length !== 2 || e.ops.some((o) => o !== '==' && o !== '!=')) throw new PyError('strs can be compared with == and != only (one comparison at a time)', e.line);
            e.strCmp = true;
          }
        }
        return 'int';
      }
      case 'ifexp': {
        expect(ty(e.test, fn), 'int', 'a condition', e.line);
        const y = ty(e.yes, fn), n = ty(e.no, fn);
        if (final && y !== n) throw new PyError(`both branches of "if … else" must be the same type (${tyName(y)} and ${tyName(n)} here)`, e.line);
        return y ?? n;
      }
      case 'index': {
        if (isListName(e.list, fn)) {
          expect(ty(e.index, fn), 'int', 'a list index', e.line);
          return 'int';
        }
        expect(ty(e.index, fn), 'int', 'a str index', e.line);
        const vt = vars.get(keyOf(e.list, fn)) ?? null;
        if (final && vt !== 'str') throw new PyError(`${name(e.list)} is not a list or a str`, e.line);
        return vt === 'str' ? 'str' : null;
      }
      case 'call': {
        const args = e.fn === 'len' && e.args[0]?.kind === 'name' && isListName(e.args[0].id, fn) ? [null] : e.args.map((a) => ty(a, fn));
        switch (e.fn) {
          case 'print': return 'int';
          case 'len': if (args[0] !== null) expect(args[0], 'str', 'len() takes a list or a str, and its argument', e.line); return 'int';
          case 'ord': expect(args[0], 'str', 'the argument of ord()', e.line); return 'int';
          case 'chr': expect(args[0], 'int', 'the argument of chr()', e.line); return 'str';
          case 'abs': case 'min': case 'max': args.forEach((t) => expect(t, 'int', `the arguments of ${e.fn}()`, e.line)); return 'int';
        }
        if (Object.hasOwn(MEMORY_BUILTINS, e.fn)) { args.forEach((t) => expect(t, 'int', `the arguments of ${e.fn}()`, e.line)); return 'int'; }
        const f = scope.funcs.get(e.fn)!;
        args.forEach((t, i) => {
          if (t === null) return;
          const p = f.params[i], key = `${f.name}.${p}`;
          if (!final) { const old = vars.get(key); if (old && old !== t) throw new PyError(`${f.name}() takes ${tyName(old)} as ${name(p)}, but gets ${tyName(t)} here`, e.line); setVar(key, p, t, e.line); }
          else expect(t, vars.get(key) ?? 'int', `the argument ${name(p)} of ${f.name}()`, e.line);
        });
        return rets.get(f.name) ?? (final ? 'int' : null);
      }
    }
  };

  const stmts = (list: Stmt[], fn: FuncInfo | null) => {
    for (const s of list) {
      switch (s.kind) {
        case 'assign':
          if (s.value.kind === 'list') break;
          if (s.target.kind === 'name') {
            const t = ty(s.value, fn);
            if (t) setVar(keyOf(s.target.id, fn), s.target.id, t, s.line);
          } else {
            expect(ty(s.target.index, fn), 'int', 'a list index', s.line);
            expect(ty(s.value, fn), 'int', 'a list element', s.line);
          }
          break;
        case 'aug': {
          const t = ty(s.value, fn);
          if (s.target.kind === 'name') {
            const key = keyOf(s.target.id, fn), vt = vars.get(key) ?? null;
            if (s.op === '+' && (vt === 'str' || t === 'str')) {
              setVar(key, s.target.id, 'str', s.line);
              if (final) {
                if (t !== 'str' || vt !== 'str') throw new PyError('a str can only be added to a str', s.line);
                s.isStr = true;
              }
            } else {
              expect(vt, 'int', `the target of "${s.op}="`, s.line);
              expect(t, 'int', `the operand of "${s.op}="`, s.line);
            }
          } else {
            expect(ty(s.target.index, fn), 'int', 'a list index', s.line);
            expect(t, 'int', 'a list element', s.line);
          }
          break;
        }
        case 'expr': ty(s.value, fn); break;
        case 'if': case 'while': {
          if (final && ty(s.test, fn) === 'str') throw new PyError(NO_TRUTH, s.line);
          else if (!final) ty(s.test, fn);
          stmts(s.body, fn);
          if (s.kind === 'if') stmts(s.orelse, fn);
          break;
        }
        case 'for':
          setVar(keyOf(s.v, fn), s.v, 'int', s.line);
          expect(ty(s.start, fn), 'int', 'a range bound', s.line);
          expect(ty(s.stop, fn), 'int', 'a range bound', s.line);
          stmts(s.body, fn);
          break;
        case 'return': {
          const t = s.value ? ty(s.value, fn) : 'int';
          if (t && fn) setRet(fn, t, s.line);
          break;
        }
        default: break;
      }
    }
  };

  const sweep = () => {
    stmts(body, null);
    for (const f of scope.funcs.values()) stmts(f.body, f);
  };
  for (let i = 0; i < 64; i++) {
    changed = false;
    sweep();
    if (!changed) break;
  }
  final = true;
  sweep();
  for (const f of scope.funcs.values()) {
    if (rets.get(f.name) === 'str' && !alwaysReturns(f.body)) throw new PyError(`${f.name}() returns a str: end every path with a return`, f.end);
  }
  scope.strVars = new Set([...vars].filter(([, t]) => t === 'str').map(([k]) => k));
}
