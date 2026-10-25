// The random RV64 programs (src/riscv/randprog64.ts) the 64-bit core is fuzzed with and Spike checks the golden
// model on: they assemble, halt, keep every access aligned and inside the window, and between them run every
// RV64I / M instruction.
import { describe, expect, it } from 'vitest';
import { assemble } from '../src/riscv/asm';
import { BY_NAME64, decode, INSTRS, OPCODES } from '../src/riscv/isa';
import { accessSize, ISS64 } from '../src/riscv/iss64';
import { randomProgram64 } from '../src/riscv/randprog64';

const words = (src: string) => {
  const a = assemble(src, undefined, { xlen: 64 });
  if (a.errors.length) throw new Error(`line ${a.errors[0].line}: ${a.errors[0].message}`);
  return a.words;
};

describe('random RV64 programs', () => {
  it('is deterministic per seed and differs between seeds', () => {
    expect(randomProgram64(7, { m: true })).toBe(randomProgram64(7, { m: true }));
    expect(randomProgram64(7)).not.toBe(randomProgram64(8));
  });

  it('assembles, halts, stays aligned in the window and covers RV64I / M', () => {
    const seen = new Set<string>();
    const dataBase = 0x20000, B = 256;
    for (let seed = 1; seed <= 48; seed++) {
      const w = words(randomProgram64(seed, { m: true, n: 120, dataBase }));
      const iss = new ISS64(w, { m: true, dmemWords: 64, imemWords: 2 ** Math.ceil(Math.log2(w.length)) });
      while (!iss.halted && iss.steps < 20_000) {
        const word = iss.fetch(iss.pc), d = decode(word, undefined, 64);
        if (d.opcode === OPCODES.LOAD || d.opcode === OPCODES.STORE) {
          const addr = BigInt.asUintN(64, iss.x[d.rs1] + BigInt(d.imm)), size = BigInt(accessSize(d.funct3));
          expect(addr % size, `seed ${seed}: ${d.name} at 0x${addr.toString(16)}`).toBe(0n);
          expect(addr >= BigInt(dataBase) && addr < BigInt(dataBase + B), `seed ${seed}: 0x${addr.toString(16)}`).toBe(true);
        }
        iss.step();
        if (d.name) seen.add(d.name);
      }
      expect(iss.halted, `seed ${seed}`).toBe(true);
    }
    const want = [...INSTRS.filter((i) => ['LUI', 'AUIPC', 'JAL', 'JALR', 'BRANCH', 'LOAD', 'STORE', 'OPIMM', 'OP'].some((k) => i.opcode === OPCODES[k as keyof typeof OPCODES])).map((i) => i.name), ...BY_NAME64.keys()];
    expect(want.filter((n) => !seen.has(n))).toEqual([]);
    expect(want.length).toBeGreaterThanOrEqual(37 + 8 + 15);
  });
});
