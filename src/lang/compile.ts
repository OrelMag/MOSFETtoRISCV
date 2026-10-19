// compilePy: Python subset → RV32I assembly → machine words, with the maps between them (Python line ↔
// assembly lines ↔ instruction addresses) that the chapter draws, and where every variable lives.

import { assemble } from '../riscv/asm';
import type { AsmResult } from '../riscv/asm';
import { PyError } from './ast';
import { CodeGen } from './codegen';
import type { AsmLineOut, Layout } from './codegen';
import { parse } from './parse';
import { analyze } from './scope';

export interface CompileOptions {
  /** Data memory in words (the CPU's dmemK: 2^k). */
  dmemWords?: number;
}

export interface Compiled {
  /** The generated assembly, one line per AsmLineOut. */
  asm: string;
  lines: AsmLineOut[];
  /** The assembled program (absent when compiling failed). */
  words: number[];
  assembled: AsmResult | null;
  layout: Layout | null;
  error: PyError | null;
  /** Instruction address → Python line (null: the frame or a runtime routine). */
  pyOfPc(pc: number): number | null;
  /** Python line → the addresses of the instructions it compiled to. */
  pcsOfPy(line: number): number[];
}

export function compilePy(src: string, opts: CompileOptions = {}): Compiled {
  const dmemWords = opts.dmemWords ?? 64;
  const fail = (error: PyError): Compiled => ({ asm: '', lines: [], words: [], assembled: null, layout: null, error, pyOfPc: () => null, pcsOfPy: () => [] });
  let gen: CodeGen;
  let lines: AsmLineOut[];
  try {
    const mod = parse(src);
    const scope = analyze(mod);
    gen = new CodeGen(mod, scope, dmemWords);
    lines = gen.generate();
  } catch (e) {
    if (e instanceof PyError) return fail(e);
    throw e;
  }
  const asm = lines.map((l) => l.text).join('\n');
  const assembled = assemble(asm);
  if (assembled.errors.length) {
    const e = assembled.errors[0];
    return fail(new PyError(`internal: the assembler rejected "${lines[e.line - 1]?.text.trim()}": ${e.message}`, lines[e.line - 1]?.py ?? 0));
  }
  const byPc = new Map<number, number | null>();
  const byPy = new Map<number, number[]>();
  for (const l of assembled.lines) {
    const py = lines[l.srcLine - 1].py;
    byPc.set(l.addr, py);
    if (py !== null) {
      if (!byPy.has(py)) byPy.set(py, []);
      byPy.get(py)!.push(l.addr);
    }
  }
  return {
    asm, lines, words: assembled.words, assembled, layout: gen.layout, error: null,
    pyOfPc: (pc) => byPc.get(pc) ?? null,
    pcsOfPy: (line) => byPy.get(line) ?? [],
  };
}

/** What a compiled program printed: the words from the output's start up to gp. */
export function outputOf(layout: Layout, gp: number, dmem: ArrayLike<number>): number[] {
  const out: number[] = [];
  for (let a = layout.outBase; a < gp && a < 4 * layout.dmemWords; a += 4) out.push(dmem[a >>> 2] | 0);
  return out;
}
