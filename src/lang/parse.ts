// Lexer and recursive-descent parser for the Python subset. Indentation becomes INDENT / DEDENT tokens as in
// CPython's tokenizer; brackets join lines. Errors are PyError with the line (and column) they are on.

import { KEYWORDS, PyError } from './ast';
import type { BinOpName, CmpOpName, Expr, Module, Stmt, Target } from './ast';

type TokKind = 'name' | 'num' | 'op' | 'nl' | 'indent' | 'dedent' | 'eof';
interface Tok { t: TokKind; v: string; line: number; col: number }

const OPS = ['//=', '<<=', '>>=', '**=', '**', '//', '<<', '>>', '<=', '>=', '==', '!=', '+=', '-=', '*=', '%=', '&=', '|=', '^=', '->',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '<', '>', '=', '(', ')', '[', ']', ',', ':', '.', ';'];

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const indents = [0];
  let depth = 0;
  const lines = src.split(/\r?\n/);
  let cont = false; // the previous line ended in a backslash
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li], ln = li + 1;
    let i = 0;
    if (depth === 0 && !cont) {
      let w = 0;
      for (; i < line.length && (line[i] === ' ' || line[i] === '\t'); i++) w = line[i] === '\t' ? (w + 8) & ~7 : w + 1;
      if (i >= line.length || line[i] === '#') continue; // blank or comment-only: no tokens, no indentation
      if (w > indents[indents.length - 1]) {
        indents.push(w);
        out.push({ t: 'indent', v: '', line: ln, col: 0 });
      } else {
        while (w < indents[indents.length - 1]) {
          indents.pop();
          out.push({ t: 'dedent', v: '', line: ln, col: 0 });
        }
        if (w !== indents[indents.length - 1]) throw new PyError('unindent does not match any outer indentation level', ln, w);
      }
    }
    cont = false;
    let any = false;
    while (i < line.length) {
      const c = line[i];
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '#') break;
      if (c === '\\' && line.slice(i + 1).trim() === '') { cont = true; break; }
      const col = i + 1;
      const rest = line.slice(i);
      const num = rest.match(/^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*)(?![\w.])/);
      if (num) {
        out.push({ t: 'num', v: num[1], line: ln, col });
        i += num[1].length; any = true; continue;
      }
      if (/^\d/.test(rest)) throw new PyError(`only integers are supported: "${rest.match(/^[\w.]+/)![0]}"`, ln, col);
      const name = rest.match(/^[A-Za-z_]\w*/);
      if (name) {
        out.push({ t: 'name', v: name[0], line: ln, col });
        i += name[0].length; any = true; continue;
      }
      if (c === '"' || c === "'") throw new PyError('strings are not supported (print numbers)', ln, col);
      const op = OPS.find((o) => rest.startsWith(o));
      if (!op) throw new PyError(`unexpected character "${c}"`, ln, col);
      if (op === '(' || op === '[') depth++;
      if (op === ')' || op === ']') depth = Math.max(0, depth - 1);
      out.push({ t: 'op', v: op, line: ln, col });
      i += op.length; any = true;
    }
    if (any && depth === 0 && !cont) out.push({ t: 'nl', v: '', line: ln, col: line.length + 1 });
  }
  if (depth > 0) throw new PyError('unclosed bracket', lines.length, 0);
  const last = lines.length;
  if (out.length && out[out.length - 1].t !== 'nl' && out[out.length - 1].t !== 'dedent') out.push({ t: 'nl', v: '', line: last, col: 0 });
  while (indents.length > 1) { indents.pop(); out.push({ t: 'dedent', v: '', line: last, col: 0 }); }
  out.push({ t: 'eof', v: '', line: last, col: 0 });
  return out;
}

export function parseNumber(s: string): number {
  const t = s.replace(/_/g, '').toLowerCase();
  const v = t.startsWith('0x') ? parseInt(t.slice(2), 16) : t.startsWith('0b') ? parseInt(t.slice(2), 2) : t.startsWith('0o') ? parseInt(t.slice(2), 8) : parseInt(t, 10);
  return v;
}

const AUG: Record<string, BinOpName> = { '+=': '+', '-=': '-', '*=': '*', '//=': '//', '%=': '%', '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>' };
const CMP = new Set(['<', '<=', '>', '>=', '==', '!=']);

class Parser {
  private p = 0;
  constructor(private readonly toks: Tok[]) {}

  private get tok(): Tok { return this.toks[this.p]; }
  private err(msg: string, t: Tok = this.tok): never { throw new PyError(msg, t.line, t.col); }
  private isOp(v: string): boolean { return this.tok.t === 'op' && this.tok.v === v; }
  private isKw(v: string): boolean { return this.tok.t === 'name' && this.tok.v === v; }
  private next(): Tok { return this.toks[this.p++]; }
  private eatOp(v: string): Tok {
    if (!this.isOp(v)) this.err(this.tok.t === 'nl' ? `expected "${v}" before the end of the line` : `expected "${v}"`);
    return this.next();
  }
  private eatKw(v: string): Tok {
    if (!this.isKw(v)) this.err(`expected "${v}"`);
    return this.next();
  }
  private ident(): Tok {
    const t = this.tok;
    if (t.t !== 'name') this.err('expected a name');
    if (KEYWORDS.has(t.v)) this.err(`"${t.v}" is a reserved word`);
    return this.next();
  }
  private endLine(): void {
    if (this.isOp(';')) this.err('one statement per line, please');
    if (this.tok.t !== 'nl') this.err('expected the end of the line');
    this.next();
  }

  module(): Stmt[] {
    const body: Stmt[] = [];
    while (this.tok.t !== 'eof') {
      if (this.tok.t === 'indent') this.err('unexpected indent');
      body.push(this.stmt(0));
    }
    return body;
  }

  private block(inDef: number): Stmt[] {
    this.eatOp(':');
    // a method, not this.tok.t: TypeScript would narrow the kind across next()
    const kind = (): TokKind => this.toks[this.p].t;
    if (kind() !== 'nl') this.err('put the block on the following lines, indented');
    this.next();
    if (kind() !== 'indent') this.err('expected an indented block');
    this.next();
    const body: Stmt[] = [];
    while (kind() !== 'dedent' && kind() !== 'eof') body.push(this.stmt(inDef));
    if (kind() === 'dedent') this.next();
    return body;
  }

  private stmt(inDef: number): Stmt {
    const t = this.tok, line = t.line;
    if (t.t === 'name') {
      switch (t.v) {
        case 'if': return this.ifStmt(inDef);
        case 'while': {
          this.next();
          const test = this.expr();
          return { kind: 'while', line, test, body: this.block(inDef) };
        }
        case 'for': return this.forStmt(inDef);
        case 'def': {
          if (inDef) this.err('define functions at the top level (no nested functions)');
          this.next();
          const name = this.ident().v;
          this.eatOp('(');
          const params: string[] = [];
          while (!this.isOp(')')) {
            const pt = this.ident();
            if (params.includes(pt.v)) this.err(`parameter "${pt.v}" named twice`, pt);
            params.push(pt.v);
            if (this.isOp('=')) this.err('default values are not supported');
            if (!this.isOp(')')) this.eatOp(',');
          }
          this.next();
          if (this.isOp('->')) this.err('type annotations are not supported');
          const body = this.block(line);
          const end = this.toks[this.p - 1].line;
          return { kind: 'def', line, name, params, body, end };
        }
        case 'return': {
          if (!inDef) this.err('"return" outside a function');
          this.next();
          const value = this.tok.t === 'nl' ? null : this.expr();
          this.endLine();
          return { kind: 'return', line, value };
        }
        case 'global': {
          this.next();
          const names = [this.ident().v];
          while (this.isOp(',')) { this.next(); names.push(this.ident().v); }
          this.endLine();
          return { kind: 'global', line, names };
        }
        case 'break': case 'continue': case 'pass': {
          this.next();
          this.endLine();
          return { kind: t.v, line } as Stmt;
        }
        case 'elif': case 'else': this.err(`"${t.v}" without a matching "if"`);
        // falls through to an expression statement otherwise
      }
      if (KEYWORDS.has(t.v) && !['not', 'True', 'False'].includes(t.v)) this.err(`"${t.v}" is not supported`);
    }
    const e = this.expr();
    if (this.isOp('=')) {
      const target = this.target(e);
      this.next();
      const value = this.isOp('[') ? this.listLit() : this.expr();
      if (this.isOp('=')) this.err('chained assignment is not supported');
      this.endLine();
      return { kind: 'assign', line, target, value };
    }
    if (this.tok.t === 'op' && AUG[this.tok.v]) {
      const target = this.target(e);
      const op = AUG[this.next().v];
      const value = this.expr();
      this.endLine();
      return { kind: 'aug', line, target, op, value };
    }
    if (this.isOp(',')) this.err('tuples are not supported');
    this.endLine();
    return { kind: 'expr', line, value: e };
  }

  private target(e: Expr): Target {
    if (e.kind === 'name') return { kind: 'name', line: e.line, id: e.id };
    if (e.kind === 'index') return e;
    this.err('can only assign to a name or a list element');
  }

  private ifStmt(inDef: number): Stmt {
    const line = this.tok.line;
    const isElif = this.tok.v === 'elif';
    this.next();
    const test = this.expr();
    const body = this.block(inDef);
    let orelse: Stmt[] = [];
    if (this.isKw('elif')) orelse = [this.ifStmt(inDef)];
    else if (this.isKw('else')) { this.next(); orelse = this.block(inDef); }
    return { kind: 'if', line, test, body, orelse, ...(isElif ? { elif: true } : {}) };
  }

  private forStmt(inDef: number): Stmt {
    const line = this.tok.line;
    this.next();
    const v = this.ident().v;
    this.eatKw('in');
    const r = this.tok;
    if (!(r.t === 'name' && r.v === 'range')) this.err('only "for name in range(...)" loops are supported');
    this.next();
    this.eatOp('(');
    const args: Expr[] = [];
    while (!this.isOp(')')) {
      args.push(this.expr());
      if (!this.isOp(')')) this.eatOp(',');
    }
    this.next();
    if (args.length < 1 || args.length > 3) this.err('range takes 1 to 3 arguments', r);
    let step = 1;
    if (args.length === 3) {
      const s = constValue(args[2]);
      if (s === null) this.err('range\'s step must be a constant', r);
      if (s === 0) this.err('range\'s step must not be zero', r);
      step = s;
    }
    const start: Expr = args.length === 1 ? { kind: 'num', line, value: 0 } : args[0];
    const stop = args.length === 1 ? args[0] : args[1];
    return { kind: 'for', line, v, start, stop, step, body: this.block(inDef) };
  }

  private listLit(): Expr {
    const line = this.tok.line;
    this.eatOp('[');
    const items: Expr[] = [];
    while (!this.isOp(']')) {
      items.push(this.expr());
      if (!this.isOp(']')) this.eatOp(',');
    }
    this.next();
    if (this.isOp('*')) {
      this.next();
      return { kind: 'list', line, items, repeat: this.unary() };
    }
    return { kind: 'list', line, items };
  }

  expr(): Expr {
    const line = this.tok.line;
    const e = this.orExpr();
    if (this.isKw('if')) {
      this.next();
      const test = this.orExpr();
      this.eatKw('else');
      return { kind: 'ifexp', line, test, yes: e, no: this.expr() };
    }
    return e;
  }

  private orExpr(): Expr {
    let e = this.andExpr();
    while (this.isKw('or')) { const line = this.next().line; e = { kind: 'bool', line, op: 'or', left: e, right: this.andExpr() }; }
    return e;
  }

  private andExpr(): Expr {
    let e = this.notExpr();
    while (this.isKw('and')) { const line = this.next().line; e = { kind: 'bool', line, op: 'and', left: e, right: this.notExpr() }; }
    return e;
  }

  private notExpr(): Expr {
    if (this.isKw('not')) { const line = this.next().line; return { kind: 'unary', line, op: 'not', arg: this.notExpr() }; }
    return this.comparison();
  }

  private comparison(): Expr {
    const first = this.bitOr();
    const ops: CmpOpName[] = [], args = [first];
    while (this.tok.t === 'op' && CMP.has(this.tok.v)) {
      ops.push(this.next().v as CmpOpName);
      args.push(this.bitOr());
    }
    if (this.isKw('is') || this.isKw('in')) this.err(`"${this.tok.v}" is not supported`);
    return ops.length ? { kind: 'cmp', line: first.line, ops, args } : first;
  }

  private binLevel(ops: string[], sub: () => Expr): Expr {
    let e = sub();
    while (this.tok.t === 'op' && ops.includes(this.tok.v)) {
      const t = this.next();
      e = { kind: 'bin', line: t.line, op: t.v as BinOpName, left: e, right: sub() };
    }
    return e;
  }

  private bitOr = (): Expr => this.binLevel(['|'], this.bitXor);
  private bitXor = (): Expr => this.binLevel(['^'], this.bitAnd);
  private bitAnd = (): Expr => this.binLevel(['&'], this.shift);
  private shift = (): Expr => this.binLevel(['<<', '>>'], this.arith);
  private arith = (): Expr => this.binLevel(['+', '-'], this.term);
  private term = (): Expr => {
    if (this.isOp('/')) this.err('use // for integer division');
    const e = this.binLevel(['*', '//', '%'], this.unary);
    if (this.isOp('/')) this.err('"/" makes a float: use // for integer division');
    return e;
  };

  private unary = (): Expr => {
    if (this.tok.t === 'op' && (this.tok.v === '-' || this.tok.v === '+' || this.tok.v === '~')) {
      const t = this.next();
      const arg = this.unary();
      if (t.v === '-' && arg.kind === 'num') return { kind: 'num', line: t.line, value: -arg.value | 0 };
      return { kind: 'unary', line: t.line, op: t.v as '-' | '+' | '~', arg };
    }
    const e = this.primary();
    if (this.isOp('**')) this.err('"**" is not supported (write a loop)');
    return e;
  };

  private primary(): Expr {
    const t = this.tok, line = t.line;
    if (t.t === 'num') {
      this.next();
      const v = parseNumber(t.v);
      if (v > 0xffffffff) this.err('the number does not fit in 32 bits', t);
      return { kind: 'num', line, value: v | 0 };
    }
    if (this.isOp('(')) {
      this.next();
      const e = this.expr();
      if (this.isOp(',')) this.err('tuples are not supported');
      this.eatOp(')');
      return e;
    }
    if (this.isOp('[')) this.err('a list literal can only be assigned to a global name');
    if (t.t === 'name') {
      if (t.v === 'True' || t.v === 'False') { this.next(); return { kind: 'num', line, value: t.v === 'True' ? 1 : 0 }; }
      if (t.v === 'None') this.err('None is not supported (use 0)');
      const id = this.ident().v;
      if (this.isOp('(')) {
        this.next();
        const args: Expr[] = [];
        while (!this.isOp(')')) {
          args.push(this.expr());
          if (this.isOp('=')) this.err('keyword arguments are not supported');
          if (!this.isOp(')')) this.eatOp(',');
        }
        this.next();
        return { kind: 'call', line, fn: id, args };
      }
      if (this.isOp('[')) {
        this.next();
        const index = this.expr();
        if (this.isOp(':')) this.err('slices are not supported');
        this.eatOp(']');
        if (this.isOp('[')) this.err('lists of lists are not supported');
        return { kind: 'index', line, list: id, index };
      }
      if (this.isOp('.')) this.err('attributes and methods are not supported');
      return { kind: 'name', line, id };
    }
    if (t.t === 'nl') this.err('expected an expression before the end of the line');
    if (t.t === 'indent') this.err('unexpected indent');
    this.err(`unexpected "${t.v}"`);
  }
}

/** The value of a constant expression (numbers and unary minus), else null. */
export function constValue(e: Expr): number | null {
  if (e.kind === 'num') return e.value;
  if (e.kind === 'unary' && (e.op === '-' || e.op === '+')) {
    const v = constValue(e.arg);
    return v === null ? null : e.op === '-' ? -v | 0 : v;
  }
  return null;
}

export function parse(src: string): Module {
  const p = new Parser(tokenize(src));
  return { body: p.module(), lines: src.split(/\r?\n/) };
}
