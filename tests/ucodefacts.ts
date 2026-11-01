// Measuring the microcode painter's facts (scripts/ucode-facts.ts writes them, tests/ucode.test.ts holds them).
import { BENCHMARKS } from '../src/riscv/benchprograms';
import { assemble } from '../src/riscv/asm';
import { ISS } from '../src/riscv/iss';
import { mcOpClass } from '../src/lib/multicycle';
import { bookProgram, cyclesByClass, iTypeInThree } from '../src/lib/ucode';
import { checkProgram } from '../src/lib/ucodecheck';

export interface UcodeFacts {
  tests: number;
  benches: number;
  /** Instructions the benchmarks execute, and the share that are I-type (OP-IMM). */
  instructions: number;
  iShare: number;
  bookCpi: number;
  solvedCpi: number;
  bookCycles: Record<string, number>;
  solvedCycles: Record<string, number>;
}

export async function measureUcodeFacts(): Promise<UcodeFacts> {
  const [book, solved] = [await checkProgram(bookProgram()), await checkProgram(iTypeInThree())];
  let n = 0, i = 0;
  for (const b of BENCHMARKS.filter((x) => !x.needs?.m && !x.needs?.f)) {
    const asm = assemble(b.source);
    const iss = new ISS(asm.words, { dmemWords: 64, imemWords: 128 });
    while (!iss.halted && iss.steps < 1_000_000) { const info = iss.step(); n++; if (mcOpClass(info.word & 0x7f) === 'I') i++; }
  }
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return {
    tests: book.tests.length, benches: book.benches.length, instructions: n, iShare: r3(i / n),
    bookCpi: r3(book.cpi!), solvedCpi: r3(solved.cpi!),
    bookCycles: cyclesByClass(bookProgram()) as Record<string, number>, solvedCycles: cyclesByClass(iTypeInThree()) as Record<string, number>,
  };
}
