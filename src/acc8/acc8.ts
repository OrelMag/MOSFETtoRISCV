// The first computer's instruction set and golden model (chapter 'firstcomputer'): an 8-bit accumulator machine with
// eight one-word instructions. A word is 3 op bits and 5 bits of address, jump target or constant. Program in a 32-word
// ROM, data in a 32-byte RAM (Harvard); one instruction per clock, every state change at the rising edge, as lib/acc8.ts
// builds it: PC ← next, A ← its new value, M[a] ← A, OUT ← A. Z (A = 0) is read before the edge. JMP to itself is a halt.
// DOM-free; the assembler is the Custom ISA table ACC8_PRESET (isa/presets.ts).

import { tableOf, type IsaDoc, type TableAsm } from '../isa/table';

export const ACC_OPS = ['LDA', 'ADD', 'SUB', 'STA', 'LDI', 'JMP', 'JZ', 'OUT'] as const;
export type AccOp = (typeof ACC_OPS)[number];
/** Words of program ROM and bytes of data RAM: 2^5, the reach of a 5-bit field. */
export const ACC_WORDS = 32;

const OPS: [AccOp, string, string][] = [
  ['LDA', 'a', 'A = M[a]'], ['ADD', 'a', 'A = A + M[a]'], ['SUB', 'a', 'A = A − M[a]'], ['STA', 'a', 'M[a] = A'],
  ['LDI', 'k', 'A = k (0 … 31)'], ['JMP', 'a', 'jump to a (to itself: halt)'], ['JZ', 'a', 'jump to a if A = 0'], ['OUT', '', 'show A on the output'],
];

export const ACC8_PRESET: IsaDoc = {
  id: 'acc8',
  name: 'First computer (8-bit accumulator)',
  wordBits: 8,
  operands: { a: { kind: 'addr' }, k: { kind: 'imm' } },
  instrs: OPS.map(([m, o, summary], i) => ({
    mnemonic: m, operands: o ? [o] : [], summary,
    pattern: `${i.toString(2).padStart(3, '0')} ${o ? o.repeat(5) : '-----'}`,
  })),
  notes: 'Chapter "A first computer": 3 op bits, then 5 bits of RAM address, jump target or constant. One instruction a clock.',
};

const TABLE = tableOf(ACC8_PRESET);

/** Assemble with the listing, labels and every error (the panel's editor). */
export const accAssembleFull = (src: string): TableAsm => TABLE.assemble(src);

/** Assemble a program; throws on the first error (the chapter's programs are fixed text). */
export function accAssemble(src: string): number[] {
  const r = TABLE.assemble(src);
  if (r.errors.length) throw new Error(`acc8 line ${r.errors[0].line}: ${r.errors[0].message}`);
  if (r.words.length > ACC_WORDS) throw new Error(`acc8: ${r.words.length} words, the ROM holds ${ACC_WORDS}`);
  return r.words;
}
export const accDisasm = (w: number, pc = 0): string => TABLE.disasm(w & 255, pc);
export const accOp = (w: number): AccOp => ACC_OPS[(w >> 5) & 7];

export interface AccState { pc: number; a: number; out: number; mem: number[] }

/** The golden model: what the machine does, one instruction a step. */
export class AccISS {
  pc = 0;
  a = 0;
  out = 0;
  mem: number[] = new Array(ACC_WORDS).fill(0);
  /** Instructions run (= clocks). */
  steps = 0;
  /** Every value OUT showed, with the clock it showed at (1 = the first instruction's edge). */
  outs: { value: number; clock: number }[] = [];
  halted = false;
  constructor(readonly rom: number[]) {}
  get word(): number { return (this.rom[this.pc] ?? 0) & 255; }
  step(): void {
    const w = this.word, op = accOp(w), x = w & 31;
    let next = (this.pc + 1) % ACC_WORDS;
    switch (op) {
      case 'LDA': this.a = this.mem[x]; break;
      case 'ADD': this.a = (this.a + this.mem[x]) & 255; break;
      case 'SUB': this.a = (this.a - this.mem[x]) & 255; break;
      case 'STA': this.mem[x] = this.a; break;
      case 'LDI': this.a = x; break;
      case 'JMP': if (x === this.pc) this.halted = true; next = x; break;
      case 'JZ': if (this.a === 0) next = x; break;
      case 'OUT': this.out = this.a; this.outs.push({ value: this.a, clock: this.steps + 1 }); break;
    }
    this.pc = next;
    this.steps++;
  }
  run(max = 10_000): this { while (!this.halted && this.steps < max) this.step(); return this; }
  state(): AccState { return { pc: this.pc, a: this.a, out: this.out, mem: [...this.mem] }; }
  save(): AccState & { steps: number; outs: { value: number; clock: number }[]; halted: boolean } {
    return { ...this.state(), steps: this.steps, outs: [...this.outs], halted: this.halted };
  }
  restore(s: ReturnType<AccISS['save']>): void {
    this.pc = s.pc; this.a = s.a; this.out = s.out; this.mem = [...s.mem]; this.steps = s.steps; this.outs = [...s.outs]; this.halted = s.halted;
  }
}

/** The chapter's programs. Each sets up its own data with LDI and STA (the RAM powers on at 0), so nothing is hidden. */
export const ACC_PROGRAMS = {
  /** 6 × 7 by repeated addition: count down in M[29], add 7 into M[28]. */
  mul: `# 6 x 7 by repeated addition
      LDI 6
      STA 29        # count
      LDI 7
      STA 30        # what to add
      LDI 1
      STA 31        # the constant 1
      LDI 0
      STA 28        # the sum
loop: LDA 29
      JZ done       # count is 0: finished
      SUB 31
      STA 29        # count - 1
      LDA 28
      ADD 30
      STA 28        # sum + 7
      JMP loop
done: LDA 28
      OUT
halt: JMP halt`,
  /** 5, 4, 3, 2, 1, 0 on the output. */
  countdown: `# count down from 5 to 0 on the output
      LDI 1
      STA 31
      LDI 5
loop: OUT
      JZ halt
      SUB 31
      JMP loop
halt: JMP halt`,
  /** 1 + 2 + … + 10 = 55. */
  sum: `# 1 + 2 + ... + 10
      LDI 1
      STA 31        # the constant 1
      LDI 10
      STA 29        # n
      LDI 0
      STA 28        # the sum
loop: LDA 29
      JZ done
      ADD 28
      STA 28        # sum + n
      LDA 29
      SUB 31
      STA 29        # n - 1
      JMP loop
done: LDA 28
      OUT
halt: JMP halt`,
  /** Step 1: words march past (LDI then OUT, so each word is seen), then a jump back. */
  fetch: `# the fetch loop: each word comes out in turn
      LDI 1
      OUT
      LDI 2
      OUT
      LDI 3
      OUT
      JMP 0`,
} as const;
export type AccProgram = keyof typeof ACC_PROGRAMS;
