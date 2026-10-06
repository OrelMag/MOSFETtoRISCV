// Programs for the dual-core processor (chapter 24). Both cores run the same code; csrr mhartid
// returns 0 or 1. The shared counter lives at address 64, the lock at 68.

import type { Program } from './programs';

export const MC_PROGRAMS: Program[] = [
  {
    id: 'race',
    name: 'Race: lw / addi / sw',
    blurb: 'Both cores add 1 to a shared counter 20 times with an ordinary load, add and store. Updates get lost.',
    source: `# counter += 1, twenty times, on both cores: expect 40?
        li   s0, 64            # &counter
        li   s1, 20
loop:   lw   t0, 0(s0)
        addi t0, t0, 1
        sw   t0, 0(s0)
        addi s1, s1, -1
        bnez s1, loop
halt:   j    halt`,
  },
  {
    id: 'atomic',
    name: 'Atomic add',
    blurb: 'The same loop with amoadd.w: read, add and write happen in one memory access. Always 40.',
    source: `# counter += 1 with an atomic memory operation
        li   s0, 64            # &counter
        li   s1, 20
        li   t1, 1
loop:   amoadd.w t0, t1, (s0)  # t0 = old counter; counter = old + 1, indivisibly
        addi s1, s1, -1
        bnez s1, loop
halt:   j    halt`,
  },
  {
    id: 'lock',
    name: 'Spin lock',
    blurb: 'A test-and-set lock built from amoswap.w protects the plain lw / addi / sw critical section.',
    source: `# acquire: swap 1 into the lock; if the old value was 1, someone else holds it
        li   s0, 64            # &counter
        li   s2, 68            # &lock (0 = free)
        li   s1, 20
        li   t3, 1
loop:
acquire: amoswap.w t2, t3, (s2)
        bnez t2, acquire       # spin
        lw   t0, 0(s0)         # critical section: one core at a time
        addi t0, t0, 1
        sw   t0, 0(s0)
        sw   zero, 0(s2)       # release
        addi s1, s1, -1
        bnez s1, loop
halt:   j    halt`,
  },
  {
    id: 'harts',
    name: 'Who am I?',
    blurb: 'Each core reads its hart id and works on its own half of an array: the usual way to split work.',
    source: `# hart h sums words h*8 .. h*8+7 of a[] and stores the partial sum at 80 + 4h
        csrr a0, mhartid
        slli t0, a0, 5         # byte offset of my half: 32 * h
        li   t1, 8
        li   t2, 0             # fill my half with 1..8 first
fill:   addi t2, t2, 1
        sw   t2, 0(t0)
        addi t0, t0, 4
        addi t1, t1, -1
        bnez t1, fill
        slli t0, a0, 5
        li   t1, 8
        li   a1, 0
sum:    lw   t2, 0(t0)
        add  a1, a1, t2
        addi t0, t0, 4
        addi t1, t1, -1
        bnez t1, sum
        slli t0, a0, 2
        sw   a1, 80(t0)        # 36 from each core
halt:   j    halt`,
  },
];
