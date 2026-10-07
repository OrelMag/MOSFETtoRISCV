// The programs every core level runs (directed ones that aim at known weak spots, then random
// ones), by stage: 1 arithmetic, 2 + memory, 3 + control flow. Each is checked against the golden
// model with strict register initialisation (tests/campaign-core.test.ts).

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
