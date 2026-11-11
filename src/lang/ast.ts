// The Python subset's syntax tree (chapter "From Python to gates"). Every node carries the 1-based source
// line it starts on, so the generated assembly, the machine words and the running CPU map back to it.

export type BinOpName = '+' | '-' | '*' | '//' | '%' | '&' | '|' | '^' | '<<' | '>>';
export type CmpOpName = '<' | '<=' | '>' | '>=' | '==' | '!=';

/** Set by the type pass (types.ts) on an expression whose value is a str (a pointer to a length-prefixed block); absent: an int. */
export interface StrMark { isStr?: true }

export type Expr = StrMark & (
  | { kind: 'num'; line: number; value: number }
  /** A string literal ('…' or "…"): ASCII, the escapes \n \t \\ \' \\". */
  | { kind: 'str'; line: number; value: string }
  | { kind: 'name'; line: number; id: string }
  | { kind: 'bin'; line: number; op: BinOpName; left: Expr; right: Expr }
  | { kind: 'unary'; line: number; op: '-' | '+' | '~' | 'not'; arg: Expr }
  /** `a and b` / `a or b`: the value of the operand that decided it, as in Python. */
  | { kind: 'bool'; line: number; op: 'and' | 'or'; left: Expr; right: Expr }
  /** A chain `a < b <= c`: every middle operand evaluated once. */
  | { kind: 'cmp'; line: number; ops: CmpOpName[]; args: Expr[]; strCmp?: true }
  | { kind: 'call'; line: number; fn: string; args: Expr[] }
  | { kind: 'index'; line: number; list: string; index: Expr }
  /** `a if c else b` */
  | { kind: 'ifexp'; line: number; test: Expr; yes: Expr; no: Expr }
  /** `[1, 2, 3]` or `[0] * n` (n constant): only as the value of a global list's assignment. */
  | { kind: 'list'; line: number; items: Expr[]; repeat?: Expr });

export type Target = { kind: 'name'; line: number; id: string } | { kind: 'index'; line: number; list: string; index: Expr };

export type Stmt =
  | { kind: 'assign'; line: number; target: Target; value: Expr }
  /** isStr: the target is a str (`s += t`). */
  | { kind: 'aug'; line: number; target: Target; op: BinOpName; value: Expr; isStr?: true }
  | { kind: 'expr'; line: number; value: Expr }
  | { kind: 'if'; line: number; test: Expr; body: Stmt[]; orelse: Stmt[]; elif?: boolean }
  | { kind: 'while'; line: number; test: Expr; body: Stmt[] }
  /** `for v in range(start, stop, step)`; step is a non-zero constant. */
  | { kind: 'for'; line: number; v: string; start: Expr; stop: Expr; step: number; body: Stmt[] }
  | { kind: 'def'; line: number; name: string; params: string[]; body: Stmt[]; end: number }
  | { kind: 'return'; line: number; value: Expr | null }
  | { kind: 'global'; line: number; names: string[] }
  | { kind: 'break'; line: number }
  | { kind: 'continue'; line: number }
  | { kind: 'pass'; line: number };

export interface Module {
  body: Stmt[];
  lines: string[];
}

export class PyError extends Error {
  constructor(message: string, readonly line: number, readonly col = 0) {
    super(message);
  }
}

/** Built-in functions the compiler and the interpreter both know. */
export const BUILTINS = ['print', 'len', 'abs', 'min', 'max', 'range', 'load8', 'store8', 'load32', 'store32', 'ord', 'chr', 'spawn', 'join', 'lock', 'unlock', 'wait', 'signal'] as const;

/**
 * Chapter 'threads''s builtins, for the user target only (each a system call of the threads kernel, riscv/osprograms.ts THREAD_SYS): spawn(f) starts
 * the function f (no parameters) as a second thread and answers 0 (or -1 when one already runs); join() waits for it to end; lock(i) / unlock(i)
 * take and give back lock i (0..3); wait(c, i) lets lock i go and waits for a signal on condition c (0..3), holding the lock again on return;
 * signal(c) wakes the thread waiting on c, if any. The number of arguments of each.
 */
export const THREAD_BUILTINS: Record<string, number> = { spawn: 1, join: 0, lock: 1, unlock: 1, wait: 2, signal: 1 };

/** The bump heap's size in bytes (strings made at run time: concatenation, indexing, chr). It never grows and nothing frees it. */
export const HEAP_BYTES = 96;

/** The memory builtins: an address is an int, load8 is unsigned, load32 / store32 are little-endian and need a word-aligned address (as lw / sw do). */
export const MEMORY_BUILTINS: Record<string, number> = { load8: 1, load32: 1, store8: 2, store32: 2 };

/** Reserved words of the subset (and Python's others, so they are not taken as names). */
export const KEYWORDS = new Set([
  'if', 'elif', 'else', 'while', 'for', 'in', 'def', 'return', 'global', 'break', 'continue', 'pass', 'and', 'or', 'not', 'True', 'False',
  'None', 'class', 'import', 'from', 'lambda', 'try', 'except', 'finally', 'with', 'as', 'yield', 'del', 'is', 'raise', 'assert', 'nonlocal', 'async', 'await',
]);

/** 32-bit two's-complement wrap: Python's ints are unbounded, the machine's registers are not. */
export const wrap = (v: number): number => v | 0;
