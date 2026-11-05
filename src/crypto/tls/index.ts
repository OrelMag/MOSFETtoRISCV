// TLS 1.3 client as text in chapter 15's Python subset, compiled for the RV32IM CPU. Each file of this folder exports one CryptoModule (a name and the
// Python text); tlsProgram joins the modules in order, then the application, and compiles the result once. The subset has no strings, no arrays above
// 2 KB and no logical right shift, so the modules work on raw RAM at the addresses of layout.ts and write `(x >> n) & mask` where a logical shift is meant.
// This code is for teaching on a simulator: nothing in it is constant-time or otherwise protected against side channels.

import { compilePy, type Compiled } from '../../lang/compile';
import { TLS_DMEM_WORDS } from './layout';

export interface CryptoModule {
  name: string;
  /** Python subset source. Top-level statements only define functions and set scalar globals. */
  py: string;
}

export interface ModuleRange { name: string; first: number; last: number }

export interface TlsBuild {
  source: string;
  compiled: Compiled;
  ranges: ModuleRange[];
  /** The module and the line within its text that a line of the joined source came from. */
  where(line: number): { name: string; line: number } | null;
  /** Address of a function's first instruction (its label), for per-function accounting. */
  funcPc(name: string): number | null;
  /** The module of an instruction address (null: the frame or a runtime routine). */
  moduleOfPc(pc: number): string | null;
}

/** Concatenate the modules and the application and compile once, for RV32IM (`*` is a mul instruction: the 8-bit limbs' products are single-cycle there). */
export function tlsProgram(modules: readonly CryptoModule[], appSource: string, opts: { m?: boolean } = {}): TlsBuild {
  const parts = [...modules.map((m) => ({ name: m.name, text: m.py })), { name: 'app', text: appSource }];
  const ranges: ModuleRange[] = [];
  const texts: string[] = [];
  let line = 1;
  for (const p of parts) {
    const t = p.text.endsWith('\n') ? p.text : `${p.text}\n`;
    const n = t.split('\n').length - 1;
    ranges.push({ name: p.name, first: line, last: line + n - 1 });
    texts.push(t);
    line += n;
  }
  const source = texts.join('');
  const compiled = compilePy(source, { dmemWords: TLS_DMEM_WORDS, m: opts.m ?? true });
  const where = (l: number) => {
    const r = ranges.find((x) => l >= x.first && l <= x.last);
    return r ? { name: r.name, line: l - r.first + 1 } : null;
  };
  const labels = compiled.assembled?.labels ?? new Map<string, number>();
  return {
    source, compiled, ranges, where,
    funcPc: (n) => labels.get(n) ?? null,
    moduleOfPc: (pc) => { const l = compiled.pyOfPc(pc); return l === null ? null : where(l)?.name ?? null; },
  };
}

/** Python `store8` lines that write an ASCII string at an address (the subset has no strings). */
export const putString = (addr: number, s: string, indent = '    '): string =>
  [...s].map((ch, i) => `${indent}store8(${addr + i}, ${ch.charCodeAt(0)})`).join('\n');
