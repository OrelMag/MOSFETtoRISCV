// RV16: encodings round-trip through decode and disassembly, the assembler's pseudo-instructions
// expand as documented, and the golden model computes what the ISA says (arithmetic, memory,
// branches, MMIO, traps and interrupts).

import { describe, expect, it } from 'vitest';
import { assemble16, PSEUDO16 } from '../src/riscv/rv16/asm16';
import { CAUSE, CSR16, decode16, disasm16, hiLo, immU, INSTRS16, MMIO16, sext } from '../src/riscv/rv16/isa16';
import { Iss16 } from '../src/riscv/rv16/iss16';

const asm = (src: string) => {
  const r = assemble16(src);
  if (r.errors.length) throw new Error(r.errors.map((e) => `${e.line}: ${e.message}`).join('\n'));
  return r;
};
const run = (src: string, opts = {}) => {
  const a = asm(src);
  const iss = new Iss16(a.words, opts, a.data);
  iss.run(10000);
  return iss;
};

describe('RV16 encoding', () => {
  it('fixed words', () => {
    expect(asm('nop').words).toEqual([0x0004]);
    expect(asm('halt').words).toEqual([0x000c]);
    expect(asm('add x1, x2, x3').words).toEqual([(0 << 13) | (3 << 10) | (2 << 7) | (1 << 4) | 1]);
  });

  it('every 16-bit word decodes to a known instruction or to illegal, and real ones disassemble back to themselves', () => {
    let legal = 0;
    for (let w = 0; w < 0x10000; w++) {
      const d = decode16(w);
      if (!d.spec) continue;
      legal++;
      const text = disasm16(w);
      if (text === 'halt' || text === 'nop') continue;
      const back = assemble16(text);
      expect(back.errors, `${w.toString(16)}: ${text}`).toEqual([]);
      // Fields the instruction ignores (rd of a store, rs2 of an I-type, …) may differ: compare decodings.
      const d2 = decode16(back.words[0]);
      expect([d2.spec?.name, d2.rd, d2.rs1, d2.rs2, d2.imm, d2.csr].join(), `${w.toString(16)}: ${text}`).toEqual(
        [d.spec.name, ['S', 'B', 'SYS'].includes(d.spec.fmt) ? d2.rd : d.rd, ['U', 'J', 'SYS'].includes(d.spec.fmt) ? d2.rs1 : d.rs1,
          ['R', 'S', 'B', 'CSR'].includes(d.spec.fmt) ? d.rs2 : d2.rs2, d.imm, ['CSR'].includes(d.spec.fmt) ? d.csr : d2.csr].join());
    }
    expect(legal).toBeGreaterThan(40000);
    expect(decode16(0).spec).toBeNull(); // an all-zero word is illegal
  });

  it('lui + addi reach every 16-bit value', () => {
    for (let v = 0; v < 0x10000; v += 7) {
      const { hi, lo } = hiLo(v);
      expect(((hi << 6) + lo) & 0xffff).toBe(v);
      expect(lo).toBeGreaterThanOrEqual(-32);
      expect(lo).toBeLessThanOrEqual(31);
    }
    expect(immU(asm('lui x1, 1023').words[0])).toBe(0xffc0);
  });

  it('every instruction of the table assembles', () => {
    for (const i of INSTRS16) {
      const ops = { R: 'x1, x2, x3', SH: 'x1, x2, 3', U: 'x1, 5', B: 'x1, x2, 0', J: 'x1, 0', S: 'x1, 2(x2)', SYS: '', CSR: 'x1, mtvec, x2', I: i.name === 'addi' ? 'x1, x2, -3' : 'x1, 2(x2)' }[i.fmt];
      const r = assemble16(`${i.name} ${ops}`);
      expect(r.errors, i.name).toEqual([]);
      expect(decode16(r.words[0]).spec?.name, i.name).toBe(i.name);
    }
  });

  it('pseudo-instructions and their sizes', () => {
    const sizes: Record<string, number> = {};
    for (const p of PSEUDO16) {
      const ops: Record<string, string> = {
        nop: '', mv: 'a0, a1', not: 'a0, a1', neg: 'a0, a1', seqz: 'a0, a1', snez: 'a0, a1', sltz: 'a0, a1', sgtz: 'a0, a1', li: 'a0, 1000', la: 'a0, l',
        j: 'l', jr: 'a0', ret: '', call: 'l', tail: 'l', beqz: 'a0, l', bnez: 'a0, l', bltz: 'a0, l', bgez: 'a0, l', blez: 'a0, l', bgtz: 'a0, l',
        bgt: 'a0, a1, l', ble: 'a0, a1, l', csrr: 'a0, mepc', csrw: 'mtvec, a0', csrs: 'mie, a0', csrc: 'mie, a0', push: 'a0', pop: 'a0', halt: '', exit: 'a0',
      };
      expect(ops[p], p).toBeDefined();
      const r = assemble16(`l: ${p} ${ops[p]}`);
      expect(r.errors, p).toEqual([]);
      sizes[p] = r.words.length;
    }
    expect(sizes).toMatchObject({ li: 2, la: 2, not: 2, seqz: 3, push: 2, pop: 2, nop: 1, call: 1 });
    expect(asm('li a0, 31').words.length).toBe(1);
    expect(asm('li a0, 0x1240').words.length).toBe(1);
  });

  it('reports errors with line numbers', () => {
    const r = assemble16('addi a0, a0, 40\nfoo a0\nbeq a0, a1, far\n' + 'nop\n'.repeat(40) + 'far: lw a0, (a1)');
    expect(r.errors.map((e) => e.line)).toEqual([1, 2, 3]);
    expect(r.errors[0].message).toMatch(/−32…31/);
  });
});

describe('the RV16 golden model', () => {
  it('arithmetic, signed and unsigned', () => {
    const iss = run(`
      li a0, -5
      li a1, 3
      add t0, a0, a1     # -2
      sub t1, a1, a0     # 8
      slt x1, a0, a1     # 1
      sltu x2, a0, a1    # 0
      sra a2, a0, a1     # -1
      srl a0, a0, a1     # 0xFFFB >> 3 = 0x1FFF
      halt`);
    expect([...iss.x]).toEqual([0, 1, 0, 0x1fff, 3, 0xffff, 0xfffe, 8]);
    expect(iss.halted).toBe(true);
    expect(iss.error).toBeNull();
  });

  it('loops, memory, functions and a stack', () => {
    const iss = run(`
      li sp, 0x100
      la a0, arr
      li a1, 5
      call sum
      sw a0, -3(x0)      # OUT
      halt
    sum:                 # a0 = sum of a1 words at a0
      push ra
      mv t0, a0
      li a0, 0
    loop:
      beqz a1, done
      lw t1, 0(t0)
      add a0, a0, t1
      addi t0, t0, 1
      addi a1, a1, -1
      j loop
    done:
      pop ra
      ret
      .data
    arr: .word 1, 2, 3, 4, 0x7fff`);
    expect(iss.out).toEqual([0x7fff + 10]);
    expect(iss.x[2]).toBe(0x100);
  });

  it('M extension, when enabled', () => {
    const src = 'li a0, -7\nli a1, 2\nmul t0, a0, a1\ndiv t1, a0, a1\nrem a2, a0, a1\nhalt';
    expect(run(src).error).toMatch(/illegal/);
    const iss = run(src, { m: true });
    expect([iss.x[6], iss.x[7], iss.x[5]]).toEqual([0xfff2, 0xfffd, 0xffff]);
    const z = run('li a0, 9\ndivu t0, a0, x0\nremu t1, a0, x0\nhalt', { m: true });
    expect([z.x[6], z.x[7]]).toEqual([0xffff, 9]);
  });

  it('MMIO: console, LEDs, switches, input, exit', () => {
    const a = asm(`li t0, 'H'\nsw t0, -2(x0)\nlw t1, -4(x0)\nsw t1, -5(x0)\nlw a0, -6(x0)\nli a1, 42\nexit a1\nnop`);
    const iss = new Iss16(a.words, {}, a.data);
    iss.input = [0x55];
    iss.switches = 0x0f0f;
    iss.run();
    expect(iss.console).toBe('H');
    expect(iss.leds).toBe(0x55);
    expect(iss.x[3]).toBe(0x0f0f);
    expect(iss.exitCode).toBe(42);
    expect(iss.steps).toBe(9); // li t0, 'H' (72) takes two words
  });

  it('traps: ecall, illegal, mret; interrupts only when enabled', () => {
    const iss = run(`
      la t0, handler
      csrw mtvec, t0
      li a0, 0
      ecall
      .word 0            # illegal
      li t0, 0x800       # MEIE
      csrw mie, t0
      li t0, 1
      sw t0, -7(x0)      # raise the external interrupt: not enabled in mstatus yet
      li t0, 8
      csrs mstatus, t0   # MIE: taken right after this instruction
      halt
    handler:
      addi a0, a0, 1
      csrr a1, mcause
      sw a1, -3(x0)      # OUT the cause
      li t1, 0x800b
      bne a1, t1, back
      sw x0, -7(x0)      # acknowledge the device
    back:
      csrr t1, mcause
      bltz t1, ret_
      csrr t1, mepc      # an exception returns past the instruction
      addi t1, t1, 1
      csrw mepc, t1
    ret_:
      mret`, { system: true });
    expect(iss.out).toEqual([CAUSE.ecall, CAUSE.illegal, CAUSE.external]);
    expect(iss.x[3]).toBe(3);
    expect(iss.halted).toBe(true);
    expect(iss.csr[CSR16.mstatus] & 8).toBe(8);
  });

  it('strictInit catches a read of an unwritten register', () => {
    expect(run('add a0, a1, a2\nhalt', { strictInit: true }).error).toMatch(/x4 read before/);
    expect(run('li a1, 1\nadd a0, a1, x0\nhalt', { strictInit: true }).error).toBeNull();
  });

  it('sign extension helper', () => {
    expect(sext(0x3f, 6)).toBe(-1);
    expect(sext(0x1f, 6)).toBe(31);
    expect(MMIO16.EXIT).toBe(0xffff);
  });
});
