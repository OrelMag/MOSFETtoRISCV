// Programs for chapter 21 (caches). The first group produces address traces for the cache
// explorer (run on the ISS with a 4 KB data memory); the second runs on the gate-level CPU with
// its 4-line direct-mapped data cache (256-byte main memory).

import type { Program } from './programs';
import { PROGRAMS } from './programs';

export const TRACE_PROGRAMS: Program[] = [
  {
    id: 'rowmajor',
    name: 'Matrix sum, row by row',
    blurb: '16 × 16 words, consecutive addresses: every line fetched is fully used.',
    source: `# sum a 16x16 matrix of words, row-major: address = 4 * (16 i + j)
        li   a0, 0
        li   t2, 16
        li   s0, 0             # i
rows:   li   s1, 0             # j
cols:   slli t0, s0, 4
        add  t0, t0, s1        # 16 i + j
        slli t0, t0, 2
        lw   t1, 0(t0)
        add  a0, a0, t1
        addi s1, s1, 1
        blt  s1, t2, cols
        addi s0, s0, 1
        blt  s0, t2, rows
halt:   j    halt`,
  },
  {
    id: 'colmajor',
    name: 'Matrix sum, column by column',
    blurb: 'The same sum, but walking down columns: a 64-byte stride between accesses.',
    source: `# the same sum, column-major: address = 4 * (16 i + j) with j in the outer loop
        li   a0, 0
        li   t2, 16
        li   s1, 0             # j
cols:   li   s0, 0             # i
rows:   slli t0, s0, 4
        add  t0, t0, s1
        slli t0, t0, 2
        lw   t1, 0(t0)
        add  a0, a0, t1
        addi s0, s0, 1
        blt  s0, t2, rows
        addi s1, s1, 1
        blt  s1, t2, cols
halt:   j    halt`,
  },
  {
    id: 'vecadd',
    name: 'Vector add, arrays 1 KB apart',
    blurb: 'c[i] = a[i] + b[i] with a, b and c exactly 1 KB apart: they fight for the same sets.',
    source: `# c[i] = a[i] + b[i], i = 0..63; a at 0, b at 1024, c at 2048
        li   t0, 0             # byte offset
        li   t3, 256
        li   s2, 2048          # base of c (beyond the 12-bit offset range)
loop:   lw   t1, 0(t0)
        lw   t2, 1024(t0)
        add  t1, t1, t2
        add  t4, t0, s2
        sw   t1, 0(t4)
        addi t0, t0, 4
        blt  t0, t3, loop
halt:   j    halt`,
  },
  {
    id: 'sort',
    name: 'Bubble sort (8 words)',
    blurb: 'A tiny working set: everything fits after the first touch.',
    source: PROGRAMS.find((p) => p.id === 'sort')!.source,
  },
];

export const CACHE_CPU_PROGRAMS: Program[] = [
  {
    id: 'reuse',
    name: 'Sum an array twice',
    blurb: '16 words fit in the 16-word cache: the first pass misses once per line, the second never.',
    source: `# fill a[0..15], then sum it twice (the cache holds 4 lines of 4 words)
        li   t0, 0
        li   t3, 64
fill:   sw   t0, 0(t0)         # a[i] = 4 i (write-through, no allocate)
        addi t0, t0, 4
        blt  t0, t3, fill
        li   a0, 0
        li   s0, 2             # passes
pass:   li   t0, 0
sum:    lw   t1, 0(t0)         # miss at the start of each line, then 3 hits
        add  a0, a0, t1
        addi t0, t0, 4
        blt  t0, t3, sum
        addi s0, s0, -1
        bnez s0, pass
        sw   a0, 128(zero)
halt:   j    halt`,
  },
  {
    id: 'pingpong',
    name: 'Two arrays, one set',
    blurb: 'a[i] + b[i] with b exactly one cache-size (64 bytes) after a: every access evicts the other array.',
    source: `# s += a[i] + b[i] with a at 0 and b at 64: same index, different tag
        li   t0, 0
        li   t3, 64
        li   a0, 0
loop:   lw   t1, 0(t0)         # a[i]: evicts b's line
        lw   t2, 64(t0)        # b[i]: evicts a's line
        add  a0, a0, t1
        add  a0, a0, t2
        addi t0, t0, 4
        blt  t0, t3, loop
        sw   a0, 128(zero)
halt:   j    halt`,
  },
];
