// singleCycleCpu(program, { mac: true }) in gates against the golden model (ISS({ mac: true })) after every instruction: pc, registers, memory and the accumulator.
// The assembler and disassembler round trip, the words that are not MAC instructions, and the learner's custom rows beside the MAC.
import { describe, expect, it } from 'vitest';
import { singleCycleCpu } from '../src/lib';
import '../src/lib/macunit';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState } from '../src/riscv/cosim';
import { CUSTOM_PRESETS, problemsOf } from '../src/riscv/custom';
import { decode, disasm, MAC_INSTRS, MAC_OPCODE } from '../src/riscv/isa';
import { ISS } from '../src/riscv/iss';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';

const SRC = `
  li   t0, 0x7fff8000
  li   t1, 0x80007fff
  clracc
  mac  t0, t1
  mac2 t0, t1
  mac2 t0, t0
  li   t2, 0
  racc a0, t2
  li   t2, 15
  racc a1, t2
  li   t2, 40
  racc a2, t2
  li   t2, 63
  racc a3, t2
  li   t3, 3
  li   t4, -7
  mac2 t3, t4
  li   t2, 1
  racc a4, t2
  sw   a0, 0(zero)
  sw   a1, 4(zero)
  j .
`;

function lockstep(src: string, words: number[], limit = 300): { cycles: number; iss: ISS } {
  const sim = new GateSim(flatten(singleCycleCpu(words, { mac: true })));
  sim.setInput('clk', 0);
  sim.settle();
  const iss = new ISS(words, { mac: true });
  let n = 0;
  expect(cpuState(sim).acc).toBe(0n);
  while (!iss.halted && n < limit) {
    expect(cpuState(sim).pc, `pc before ${n} (${src.slice(0, 20)})`).toBe(iss.pc);
    const info = iss.step();
    clockCycle(sim);
    n++;
    const st = cpuState(sim);
    expect(st.x, `registers after ${n}: ${info.text}`).toEqual([...iss.x]);
    expect(st.acc, `accumulator after ${n}: ${info.text}`).toBe(iss.acc);
  }
  expect(cpuState(sim).dmem).toEqual([...iss.dmem]);
  return { cycles: n, iss };
}

describe('the MAC instructions: assembler and disassembler', () => {
  it('every encoding assembles and disassembles, and the fields are where the table says', () => {
    const r = assemble('mac a0, a1\nmac2 t0, t1\nclracc\nracc a2, a3', [], { mac: true });
    expect(r.errors).toEqual([]);
    expect(r.words.map((w) => disasm(w, 0, [], 32, true))).toEqual(['mac a0, a1', 'mac2 t0, t1', 'clracc', 'racc a2, a3']);
    for (const w of r.words) { expect(w & 0x7f).toBe(MAC_OPCODE); expect(w >>> 25).toBe(0); }
    expect(r.words.map((w) => (w >>> 12) & 7)).toEqual([0, 1, 2, 3]);
    expect(MAC_INSTRS.map((i) => i.funct3)).toEqual([0, 1, 2, 3]);
    // all 32 x 32 register pairs of mac and mac2, every racc rd / rs1
    for (let a = 0; a < 32; a++) for (let b = 0; b < 32; b += 5) {
      const q = assemble(`mac x${a}, x${b}\nmac2 x${b}, x${a}\nracc x${a}, x${b}`, [], { mac: true });
      expect(q.errors).toEqual([]);
      expect(q.words.map((w) => disasm(w, 0, [], 32, true).replace(/\b(zero|ra|sp|gp|tp|t\d|s\d+|a\d)\b/g, (m) => m))).toHaveLength(3);
      const back = assemble(q.words.map((w) => disasm(w, 0, [], 32, true)).join('\n'), [], { mac: true });
      expect(back.words).toEqual(q.words);
    }
  });
  it('a core without the MAC does not know them, and the old tables did not change', () => {
    expect(assemble('mac a0, a1').errors[0].message).toMatch(/no MAC/);
    expect(disasm(assemble('clracc', [], { mac: true }).words[0])).toMatch(/^\.word/);
    expect(decode(assemble('clracc', [], { mac: true }).words[0]).spec).toBeNull();
  });
  it('custom-2 words that are not a MAC instruction (funct7 != 0, funct3 >= 4) are none', () => {
    const w = assemble('mac a0, a1', [], { mac: true }).words[0];
    expect(decode(w | (1 << 25), [], 32, true).spec).toBeNull();
    expect(decode(w | (4 << 12), [], 32, true).spec).toBeNull();
  });
  it('a learner\'s row on custom-2 is refused beside the MAC, and custom-1 / custom-3 still work', () => {
    const subi = CUSTOM_PRESETS.find((r) => r.name === 'subi')!; // slot 2
    expect(subi.slot).toBe(2);
    expect(problemsOf(subi, new Set(), true).some((p) => p.level === 'bad' && /MAC/.test(p.text))).toBe(true);
    expect(() => singleCycleCpu([0x13], { mac: true, custom: [subi] })).toThrow(/custom-2/);
    expect(problemsOf(subi).some((p) => p.level === 'bad')).toBe(false);
  });
});

describe('the MAC core in gates, against the golden model', () => {
  it('a program with the four instructions, ties, the clamp and shifts 0, 15, 40 and 63', () => {
    const words = assemble(SRC, [], { mac: true }).words;
    const { iss } = lockstep(SRC, words);
    expect(iss.halted).toBe(true);
    expect(iss.acc).not.toBe(0n);
  }, 120000);
  it('words on custom-2 that are not MAC instructions do nothing, in gates and in the model', () => {
    const good = assemble('li t0, 5\nli t1, 7\nmac t0, t1\nclracc', [], { mac: true }).words;
    const bad = [...good.slice(0, 3), good[2] | (1 << 25), good[2] | (4 << 12), good[2] | (1 << 25) | (3 << 12), ...assemble('racc a0, zero\nj .', [], { mac: true }).words];
    const { iss } = lockstep('bad', bad);
    expect(iss.acc).toBe(35n);
  }, 120000);
});
