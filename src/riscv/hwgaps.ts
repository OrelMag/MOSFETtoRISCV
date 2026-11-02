// Instructions a program uses that a given CPU's hardware lacks: the assembler accepts any RV32 mnemonic, but the
// chapters' CPUs implement subsets (`InstrSpec.hw`), and the first sign of a gap would otherwise be a red mismatch
// between the gates and the golden model.

import { decode } from './isa';
import type { AsmResult } from './asm';

export interface HwFeatures {
  /** M extension in hardware (mul / div). */
  m?: boolean;
  /** F extension (the chapter 24 FPU). */
  fpu?: boolean;
  /** Zicsr, traps and a memory-mapped system (ecall, ebreak, mret, csr*). */
  system?: boolean;
  /** Byte and halfword accesses (lb / lh / sb / sh ...). */
  subword?: boolean;
}

const M_OPS = new Set(['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu']);
const SUBWORD = new Set(['lb', 'lh', 'lbu', 'lhu', 'sb', 'sh']);

/** One note per source line using an instruction the CPU does not implement. */
export function hardwareGaps(r: AsmResult, f: HwFeatures): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  const seen = new Set<string>();
  for (const l of r.lines) {
    if (l.size === 2) continue;
    const d = decode(l.word);
    if (!d.spec) continue;
    const name = d.name;
    let msg: string | null = null;
    if (M_OPS.has(name)) { if (!f.m) msg = `${name} needs the M extension; this CPU is RV32I`; }
    else if (SUBWORD.has(name)) { if (!f.subword) msg = `${name}: this CPU's data memory is word-only (lw / sw)`; }
    else if (d.spec.fp) { if (!f.fpu) msg = `${name} needs the F extension; this CPU has no FPU`; }
    else if (!d.spec.hw && !f.system) msg = `${name}: this CPU does not implement it`;
    if (!msg || seen.has(`${l.srcLine}:${name}`)) continue;
    seen.add(`${l.srcLine}:${name}`);
    out.push({ line: l.srcLine, message: msg });
  }
  return out;
}
