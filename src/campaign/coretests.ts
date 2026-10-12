// The programs every core level runs (directed ones that aim at known weak spots, then random
// ones), by stage: 1 arithmetic, 2 + memory, 3 + control flow. Each is checked against the golden
// model with strict register initialisation (tests/campaign-core.test.ts).

import { assemble16 } from '../riscv/rv16/asm16';
import { decode16 } from '../riscv/rv16/isa16';
import { randomProgram } from '../riscv/rv16/randprog';
import type { CoreTest } from './corecheck';

const ARITH = `# every ALU operation on edge values
        li   a0, 0x7fff
        li   a1, 1
        add  a2, a0, a1      # 0x8000: signed overflow, no trap
        sub  t0, a1, a0      # 1 - 32767
        sub  t1, x0, a1      # -1
        slt  ra, a2, a0      # -32768 < 32767: 1
        sltu sp, a2, a0      # 0x8000 < 0x7fff unsigned: 0
        xor  a0, a0, t1      # ~0x7fff = 0x8000
        or   a1, a1, a2
        and  t0, t0, t1
        sll  a2, a1, a1      # by 1 (low 4 bits of a1 = 1)
        srl  t1, t1, a1
        sra  ra, a0, a1
        addi sp, sp, -32
        addi sp, sp, 31
        slli t0, t1, 15
        srli a1, t1, 15
        srai a0, t0, 15
        lui  a2, 1023
        lui  t1, 0
        li   t0, 15
        sll  a1, a0, t0
        srl  a0, a1, t0
        sra  ra, a1, t0
        li   t0, 16          # shifts use the low 4 bits only: by 0
        sll  sp, ra, t0
        add  x0, a0, a1      # x0 stays 0
        add  a1, x0, x0
        halt
`;

const MEMORY = `# stores then loads, negative offsets, a load right after a store
        li   sp, 0x200
        li   a0, 0x1234
        sw   a0, 0(sp)
        sw   a0, -1(sp)
        lw   a1, 0(sp)
        addi a1, a1, 1
        sw   a1, 31(sp)
        lw   a2, 31(sp)
        lw   t0, -1(sp)
        sw   x0, 0(sp)
        lw   t1, 0(sp)
        li   ra, -1
        sw   ra, 5(x0)
        lw   a0, 5(x0)
        sw   a0, -3(x0)      # OUT
        lw   a1, 6(x0)       # never written: 0
        halt
`;

const UNROLLED = `# a small table summed without a loop
        li   t0, 0x40
        lw   a0, 0(t0)
        lw   a1, 1(t0)
        add  a0, a0, a1
        lw   a1, 2(t0)
        add  a0, a0, a1
        lw   a1, 3(t0)
        sub  a0, a0, a1
        sw   a0, 4(t0)
        halt
        .data
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 100, 200, 0x7fff, 5
`;

const BRANCHES = `# every branch condition, taken and not taken, both signs
        li   a0, -1
        li   a1, 1
        li   t0, 0
        beq  a0, a1, bad
        addi t0, t0, 1
        bne  a0, a0, bad
        addi t0, t0, 1
        blt  a1, a0, bad     # 1 < -1? no
        addi t0, t0, 1
        bge  a0, a1, bad     # -1 >= 1? no
        addi t0, t0, 1
        beq  a0, a0, t1_
        j    bad
t1_:    bne  a0, a1, t2_
        j    bad
t2_:    blt  a0, a1, t3_
        j    bad
t3_:    bge  a1, a0, t4_
        j    bad
t4_:    bge  a0, a0, t5_
        j    bad
t5_:    sw   t0, -3(x0)
        halt
bad:    li   t0, -1
        sw   t0, -3(x0)
        halt
`;

const CALLS = `# loops, a function call through jal / jalr, a stack, fibonacci
        li   sp, 0x300
        li   a0, 10
        call fib
        sw   a0, -3(x0)
        li   a0, 5
        la   t0, square
        jalr ra, 0(t0)
        sw   a0, -3(x0)
        halt
fib:    li   a1, 0           # a0 ← fib(a0), iterative
        li   a2, 1
floop:  beqz a0, fdone
        add  t0, a1, a2
        mv   a1, a2
        mv   a2, t0
        addi a0, a0, -1
        j    floop
fdone:  mv   a0, a1
        ret
square: push ra              # a0 ← a0² by repeated addition
        mv   t0, a0
        li   a1, 0
sloop:  beqz t0, sdone
        add  a1, a1, a0
        addi t0, t0, -1
        j    sloop
sdone:  mv   a0, a1
        pop  ra
        ret
`;

const GCD = `# Euclid, branches back and forth
        li   a0, 1071
        li   a1, 462
loop:   beq  a0, a1, done
        blt  a0, a1, less
        sub  a0, a0, a1
        j    loop
less:   sub  a1, a1, a0
        j    loop
done:   sw   a0, -3(x0)
        halt
`;

const rand = (level: 1 | 2 | 3, count: number, from = 1): CoreTest[] =>
  Array.from({ length: count }, (_, i) => ({ name: `random ${level}.${from + i}`, src: randomProgram(from + i, level, 30 + 5 * (i % 4)) }));

/** The tests of a core stage (1: arithmetic, 2: + memory, 3: + branches and jumps). */
export function coreTests(stage: 1 | 2 | 3): CoreTest[] {
  const t: CoreTest[] = [{ name: 'arithmetic', src: ARITH }];
  if (stage >= 2) t.push({ name: 'memory', src: MEMORY }, { name: 'table', src: UNROLLED });
  if (stage >= 3) t.push({ name: 'branches', src: BRANCHES }, { name: 'calls', src: CALLS }, { name: 'gcd', src: GCD });
  t.push(...rand(1, stage === 1 ? 14 : 6));
  if (stage >= 2) t.push(...rand(2, stage === 2 ? 10 : 6));
  if (stage >= 3) t.push(...rand(3, 10));
  return t;
}

const NOP = 0x0004;

/**
 * A branch-free program with nops inserted at the word level: `after` nops after every instruction,
 * or after loads only. Keeps the data image.
 */
function padded(t: CoreTest, after: number, loadsOnly: boolean): CoreTest {
  const a = assemble16(t.src!);
  const words: number[] = [];
  for (const w of a.words) {
    words.push(w);
    const isLoad = decode16(w).spec?.name === 'lw';
    for (let k = 0; k < (loadsOnly ? (isLoad ? after : 0) : after); k++) words.push(NOP);
  }
  return { name: t.name, words, data: a.data };
}

/**
 * The pipeline levels' programs. 0: no hazards (two nops after every instruction, no branches);
 * 1: back-to-back dependences, but a nop after every load; 2: loads used at once; 3: everything.
 */
export function pipeTests(stage: 0 | 1 | 2 | 3): CoreTest[] {
  if (stage === 3) return coreTests(3);
  const base = coreTests(2);
  if (stage === 0) return base.map((t) => padded(t, 2, false));
  if (stage === 1) return base.map((t) => padded(t, 1, true));
  return base;
}

const TRAPS = `# ecall, ebreak and an illegal word trap to mtvec; the handler skips them and counts
        la   t0, handler
        csrw mtvec, t0
        li   a2, 0
        li   a0, 7
        ecall
        addi a0, a0, 1
        ebreak
        .word 0x0000         # illegal
        .word 0x2002         # OPX with f3 = 1: illegal
        .word 0xc005         # shift type 3: illegal
        .word 0x0003         # MD without M: illegal
        sw   a2, -3(x0)
        csrr t1, mcause
        sw   t1, -3(x0)
        halt
handler:
        addi a2, a2, 1
        csrr t1, mcause
        sw   t1, -3(x0)
        csrr t1, mepc
        addi t1, t1, 1
        csrw mepc, t1
        mret
`;

const CSRS = `# csrrw / csrrs / csrrc, x0 sources, mscratch, mstatus bits around a trap
        li   a0, 0x1234
        csrrw a1, mscratch, a0   # a1 = 0
        li   a0, 0x00f0
        csrrs a1, mscratch, a0   # a1 = 0x1234
        csrrc a1, mscratch, a0   # a1 = 0x12f4
        csrrs a2, mscratch, x0   # read only
        csrrc a2, mscratch, x0
        li   t0, 8
        csrs mstatus, t0         # MIE
        csrr a0, mstatus
        la   t1, h
        csrw mtvec, t1
        ecall                    # MIE → MPIE
        csrr a1, mstatus         # MIE back (mret), MPIE = 1
        csrr t0, mtvec
        csrr t1, mie
        halt
h:      csrr a2, mstatus         # MIE = 0, MPIE = 1
        csrr t0, mepc
        addi t0, t0, 1
        csrw mepc, t0
        mret
`;

const IRQ = `# the external interrupt, raised by a store to IRQ; main spins until the handler has run.
# Nothing in main depends on exactly which instruction the interrupt lands on (a pipeline may
# take it a little later than the golden model).
        li   sp, 0x400
        la   t0, handler
        csrw mtvec, t0
        li   t0, 0x800
        csrw mie, t0
        li   a2, 0
        li   t0, 8
        csrs mstatus, t0
        li   t1, 1
        sw   t1, -7(x0)          # raise
wait:   beqz a2, wait
        csrc mstatus, t0         # interrupts off
        sw   t1, -7(x0)          # raise again: not taken
        nop
        nop
        sw   x0, -7(x0)          # lower
        sw   a2, -3(x0)
        halt
handler:
        push t0
        csrr t0, mcause
        sw   t0, -3(x0)
        sw   x0, -7(x0)          # acknowledge
        addi a2, a2, 1
        pop  t0
        mret
`;

/** Act 7's programs: traps (and with irq, the interrupt) plus the core's own tests. */
export function sysTests(irq: boolean): CoreTest[] {
  return [{ name: 'traps', src: TRAPS }, { name: 'csrs', src: CSRS }, ...(irq ? [{ name: 'interrupt', src: IRQ }] : []), ...coreTests(3).filter((_, i) => i % 2 === 0)];
}

const MULS = `# every multiply on edge values
        li   a0, -1
        li   a1, 0x7fff
        li   a2, -32768
        mul  t0, a0, a0      # 1
        mulh t0, a0, a0      # 0
        mulhu t0, a0, a0     # 0xfffe
        mulhsu t0, a0, a0    # -1 × 65535 >> 16 = -1
        mul  t1, a1, a1
        mulh t1, a1, a1      # 0x3fff
        mulh ra, a2, a2      # 0x4000
        mulhsu ra, a2, a0    # -32768 × 65535
        mulhu sp, a2, a2     # 0x4000
        mulh sp, a2, a1
        li   t0, 300
        li   t1, 7
        mul  a0, t0, t1      # 2100
        mul  a1, a0, a0      # wraps
        mulhu a2, a0, a0
        mul  x0, t0, t1      # x0 stays 0
        sw   a1, -3(x0)
        halt
`;

const DIVS = `# every divide on edge values: by zero, overflow, mixed signs
        li   a0, 7
        li   a1, -2
        li   a2, 0
        div  t0, a0, a1      # -3
        rem  t0, a0, a1      # 1
        div  t1, a1, a0      # 0
        rem  t1, a1, a0      # -2
        divu ra, a0, a1      # 0
        remu ra, a0, a1      # 7
        divu sp, a1, a0      # 0xfffe / 7
        remu sp, a1, a0
        div  t0, a0, a2      # by zero: -1
        rem  t0, a0, a2      # a
        divu t1, a1, a2      # 0xffff
        remu t1, a1, a2      # a
        li   a2, -32768
        li   a0, -1
        div  ra, a2, a0      # overflow: -32768
        rem  ra, a2, a0      # 0
        div  sp, a2, a2      # 1
        div  a1, a1, a1      # back to back
        rem  a1, a1, a0
        sw   a1, -3(x0)
        halt
`;

const MULLOOP = `# a power and a division loop: digits of a number
        li   a0, 3
        li   a1, 1
        li   t0, 9
pow:    mul  a1, a1, a0
        addi t0, t0, -1
        bnez t0, pow         # a1 = 3^9 = 19683
        li   t1, 10
dig:    remu a2, a1, t1
        sw   a2, -3(x0)
        divu a1, a1, t1
        bnez a1, dig
        halt
`;

/** The MD levels' programs: multiplies (and divides), then the core's own tests. */
export function mdTests(md: 'mul' | 'all'): CoreTest[] {
  const own = coreTests(3).filter((_, i) => i % 3 === 0);
  const rnd = Array.from({ length: 10 }, (_, i): CoreTest => ({ name: `random md.${i + 1}`, src: randomProgram(100 + i, 3, 30 + 5 * (i % 4), md) }));
  return [{ name: 'multiplies', src: MULS }, ...(md === 'all' ? [{ name: 'divides', src: DIVS }, { name: 'digits', src: MULLOOP }] : []), ...rnd, ...own];
}

const NESTED = `# nested loops: a multiplication table summed, inner loop taken 9 times out of 10
        li   a0, 0
        li   t0, 10
outer:  li   t1, 10
inner:  add  a0, a0, t0
        addi t1, t1, -1
        bnez t1, inner
        addi t0, t0, -1
        bnez t0, outer
        sw   a0, -3(x0)
        halt
`;

const COPY = `# copy and reverse a table, calls in a loop
        li   sp, 0x300
        li   a0, 0x40
        li   a1, 0x80
        li   a2, 16
copy:   lw   t0, 0(a0)
        sw   t0, 0(a1)
        addi a0, a0, 1
        addi a1, a1, 1
        addi a2, a2, -1
        bnez a2, copy
        li   a2, 12
        li   t1, 0
calls:  call bump
        addi a2, a2, -1
        bgt  a2, zero, calls
        sw   t1, -3(x0)
        halt
bump:   addi t1, t1, 3
        ret
        .data
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16
`;

const SORT = `# bubble sort of eight words: data-dependent branches
        li   a2, 7
pass:   li   a0, 0x40
        mv   t1, a2
step:   lw   t0, 0(a0)
        lw   a1, 1(a0)
        bge  a1, t0, keep
        sw   a1, 0(a0)
        sw   t0, 1(a0)
keep:   addi a0, a0, 1
        addi t1, t1, -1
        bnez t1, step
        addi a2, a2, -1
        bnez a2, pass
        li   a0, 0x40
        lw   a0, 0(a0)
        sw   a0, -3(x0)
        halt
        .data
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0, 0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0
        .word 9, -3, 7, 0, 32767, -32768, 5, 5
`;

/** Branch prediction's programs: loops first (where a guess pays), then the pipeline's tests. */
export function predictTests(): CoreTest[] {
  return [{ name: 'nested loops', src: NESTED }, { name: 'copy and calls', src: COPY }, { name: 'sort', src: SORT }, ...pipeTests(3)];
}
