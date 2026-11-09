// Instructions a program uses that a given CPU's hardware lacks: the assembler accepts any RV32 mnemonic, but the
// chapters' CPUs implement subsets (`InstrSpec.hw`), and the first sign of a gap would otherwise be a red mismatch
// between the gates and the golden model.

import { decode } from './isa';
import type { AsmResult } from './asm';

import { numOf } from '../chapters/order';
export interface HwFeatures {
  /** M extension in hardware (mul / div). */
  m?: boolean;
  /** F extension (the chapter float FPU). */
  fpu?: boolean;
  /** Zicsr, traps and a memory-mapped system (ecall, ebreak, mret, csr*). */
  system?: boolean;
  /** Byte and halfword accesses (lb / lh / sb / sh ...). */
  subword?: boolean;
}

/** What a CPU scene's hardware (cpuScene's options) implements: the larger cores and the system CPU are complete enough
 *  (byte lanes, CSRs, atomics) that only what the plain single-cycle CPU lacks is worth a note. */
export function hwFeaturesOf(o: { m?: boolean; wide?: boolean; ooo?: boolean; fpu?: boolean; system?: boolean }): HwFeatures {
  const big = !!(o.wide || o.ooo || o.system);
  return { m: !!(o.m || o.wide || o.ooo), fpu: !!o.fpu, system: big, subword: big };
}

const M_OPS = new Set(['mul', 'mulh', 'mulhsu', 'mulhu', 'div', 'divu', 'rem', 'remu']);
const SUBWORD = new Set(['lb', 'lh', 'lbu', 'lhu', 'sb', 'sh']);

/** One note per source line using an instruction the CPU does not implement. */
export function hardwareGaps(r: AsmResult, f: HwFeatures): { line: number; message: string }[] {
  const out: { line: number; message: string }[] = [];
  const seen = new Set<string>();
  for (const l of r.lines) {
    if (l.size === 2 || l.text.trimStart().startsWith('.')) continue; // a 16-bit parcel, or data (.word / .half)
    const d = decode(l.word);
    if (!d.spec) continue;
    const name = d.name;
    let msg: string | null = null;
    if (M_OPS.has(name)) { if (!f.m) msg = `${name} needs the M extension; this CPU is RV32I`; }
    else if (SUBWORD.has(name)) { if (!f.subword) msg = `${name}: this CPU's data memory is word-only (lw / sw)`; }
    else if (d.spec.fp) { if (!f.fpu) msg = `${name} needs the F extension; this CPU has no FPU`; }
    // (the FPU's fcsr is read with csrr*)
    else if (!d.spec.hw && !f.system && !(f.fpu && name.startsWith('csr'))) msg = `${name}: this CPU does not implement it`;
    if (!msg || seen.has(`${l.srcLine}:${name}`)) continue;
    seen.add(`${l.srcLine}:${name}`);
    out.push({ line: l.srcLine, message: msg });
  }
  return out;
}

/**
 * The note for a program with lr.w / sc.w on a design that has none: the chapter's shared-memory dual-core decodes them as
 * amoswap.w (its decoder predates them), the single-cycle CPUs not at all, while the golden model (ISS, MultiISS) applies the real
 * reservation rule. Only the coherent dual-core (lib/coherent.ts, chapter multicore's cache steps) implements them.
 */
export function lrScNote(words: readonly number[]): string | null {
  const used = new Set(words.map((w) => decode(w).name).filter((n) => n === 'lr.w' || n === 'sc.w'));
  if (!used.size) return null;
  return `${[...used].join(' and ')} is not in this design's hardware (the shared-memory dual-core runs it as amoswap.w); only the coherent dual-core of chapter ${numOf('multicore')} implements it. The golden model applies the real rule, so a mismatch is expected.`;
}
