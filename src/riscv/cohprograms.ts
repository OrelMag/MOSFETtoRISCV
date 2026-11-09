// Programs for the coherent dual-core (chapter multicore's cache steps). Both cores run the same code; csrr mhartid tells
// them apart. The shared counter is at 64 (line 4), the lock of the lock programs at 80 (line 5).

import { MC_PROGRAMS } from './mcprograms';
import type { Program } from './programs';

const mc = (id: string) => MC_PROGRAMS.find((p) => p.id === id)!;

const CRITICAL = `        lw   t0, 0(s0)         # critical section: one core at a time
        addi t0, t0, 1
        sw   t0, 0(s0)
        sw   zero, 0(s2)       # release
        addi s1, s1, -1
        bnez s1, loop
halt:   j    halt`;

export const COH_PROGRAMS: Program[] = [
  {
    id: 'stale',
    name: 'A stale copy',
    blurb: 'Core 1 reads x, waits, reads x again. Core 0 stores 7 into x in between.',
    source: `# x is at 64. Core 0 stores 7; core 1 reads x, waits 40 loops, reads it again
        csrr a0, mhartid
        li   s0, 64
        bnez a0, reader
writer: li   t0, 7
        sw   t0, 0(s0)         # core 0: x = 7
        j    halt
reader: lw   t1, 0(s0)         # core 1: its first read caches the line (x = 0)
        li   t3, 40
wait:   addi t3, t3, -1
        bnez t3, wait          # long after core 0's store
        lw   t2, 0(s0)         # t2 = 7 with coherence; a private cache answers 0
halt:   j    halt`,
  },
  {
    id: 'predict',
    name: 'Four accesses to x',
    blurb: 'Core 0 reads x, core 1 reads x, core 0 writes x, core 1 reads x: in that order, spaced by waiting loops.',
    source: `# x is at 64. In time order: core 0 reads, core 1 reads, core 0 writes, core 1 reads
        csrr a0, mhartid
        li   s0, 64
        bnez a0, c1
c0:     lw   t0, 0(s0)         # (1) core 0 reads x
        li   t3, 25
w0:     addi t3, t3, -1
        bnez t3, w0
        addi t0, t0, 5
        sw   t0, 0(s0)         # (3) core 0 writes x
        j    halt
c1:     li   t3, 12
w1:     addi t3, t3, -1
        bnez t3, w1
        lw   t1, 0(s0)         # (2) core 1 reads x
        li   t3, 40
w2:     addi t3, t3, -1
        bnez t3, w2
        lw   t2, 0(s0)         # (4) core 1 reads x again
halt:   j    halt`,
  },
  mc('race'),
  mc('atomic'),
  mc('harts'),
  {
    id: 'spin',
    name: 'Spin lock: amoswap',
    blurb: 'Every attempt is an amoswap.w: a write, so a bus transaction, even when the lock is held.',
    source: `# acquire: swap 1 into the lock (at 80); if the old value was 1, someone else holds it
        li   s0, 64            # &counter
        li   s2, 80            # &lock (0 = free)
        li   s1, 20
        li   t3, 1
loop:
acquire: amoswap.w t2, t3, (s2)
        bnez t2, acquire       # spin: every try needs the line Modified
${CRITICAL}`,
  },
  {
    id: 'ttas',
    name: 'Spin lock: test-and-test-and-set',
    blurb: 'Spin with plain loads on a Shared copy; swap only when the lock reads free.',
    source: `# test first (a read of the cached copy), test-and-set only when it reads free
        li   s0, 64            # &counter
        li   s2, 80            # &lock (0 = free)
        li   s1, 20
        li   t3, 1
loop:
spin:   lw   t2, 0(s2)         # test: a hit on the Shared copy, no bus
        bnez t2, spin
        amoswap.w t2, t3, (s2) # test-and-set: only now a write
        bnez t2, spin          # lost the race: back to testing
${CRITICAL}`,
  },
  {
    id: 'falseshare',
    name: 'False sharing',
    blurb: 'Each core increments its own word, 4 bytes apart: the same line.',
    source: `# core h adds 1 to the word at 64 + 4h, twenty times: the two words share a line
        csrr a0, mhartid
        slli t0, a0, 2         # 4 bytes apart
        addi s0, t0, 64
        li   s1, 20
loop:   lw   t1, 0(s0)
        addi t1, t1, 1
        sw   t1, 0(s0)
        addi s1, s1, -1
        bnez s1, loop
halt:   j    halt`,
  },
  {
    id: 'padded',
    name: 'Padded',
    blurb: 'The same loop with the words 16 bytes apart: a line each.',
    source: `# core h adds 1 to the word at 64 + 16h, twenty times: a line of its own each
        csrr a0, mhartid
        slli t0, a0, 4         # 16 bytes apart
        addi s0, t0, 64
        li   s1, 20
loop:   lw   t1, 0(s0)
        addi t1, t1, 1
        sw   t1, 0(s0)
        addi s1, s1, -1
        bnez s1, loop
halt:   j    halt`,
  },
  {
    id: 'lrsc',
    name: 'Atomic add with lr / sc',
    blurb: 'counter += 1 as a retry loop: lr.w, add, sc.w; a failed sc.w (rd = 1) tries again.',
    source: `# counter += 1, twenty times each, with load-reserved / store-conditional
        li   s0, 64            # &counter
        li   s1, 20
loop:   lr.w t0, (s0)          # read the counter and reserve its line
        addi t0, t0, 1
        sc.w t1, t0, (s0)      # store only if the reservation still holds: t1 = 0 / 1
        bnez t1, loop          # lost it (the other core wrote the line): try again
        addi s1, s1, -1
        bnez s1, loop
halt:   j    halt`,
  },
];
