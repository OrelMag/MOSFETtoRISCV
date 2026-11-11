// The Vectors chapter's programs (DOM-free): the lanes chapter's kernel y = 3·x + y on 16 elements (x[i] = i + 1 at 0,
// y[i] = 100 − i at 64: riscv/simtprograms.ts's 'saxpy', so the machines compare like for like), written as a scalar
// loop, a strip-mined vector loop, and the small programs of the gate-level steps. Every vector instruction is in the
// gate unit's subset (riscv/rvv.ts with gates: e32, unit stride); tests/vectors-chapter.test.ts runs each on the gates.

import type { Program } from './programs';

/** y[i] = 3·x[i] + y[i] for i < 16, after the same initialisation as the lanes chapter's saxpy. */
export const SAXPY_RESULT = Array.from({ length: 16 }, (_, i) => 3 * (i + 1) + 100 - i);

/** The kernel on the scalar CPU: one element per trip, with the roles of its instructions marked for step 0. */
export const SCALAR_SAXPY = `# y[i] = 3·x[i] + y[i], 16 elements (x at 0, y at 64)
        li    t2, 16
        li    t3, 0
init:   slli  t4, t3, 2         # x[i] = i + 1, y[i] = 100 − i
        addi  t5, t3, 1
        sw    t5, 0(t4)
        li    t6, 100
        sub   t6, t6, t3
        sw    t6, 64(t4)
        addi  t3, t3, 1
        blt   t3, t2, init
        li    t3, 0
loop:   slli  t4, t3, 2         # address
        lw    t5, 0(t4)         # load x[i]
        lw    t6, 64(t4)        # load y[i]
        slli  a0, t5, 1         # work: 2·x
        add   a0, a0, t5        # work: 3·x
        add   a0, a0, t6        # work: + y
        sw    a0, 64(t4)        # store y[i]
        addi  t3, t3, 1         # loop
        blt   t3, t2, loop      # loop
halt:   j     halt`;

/** The kernel's loop body by role: what each instruction of the scalar loop is for. */
export const SCALAR_ROLES: { role: 'work' | 'memory' | 'address' | 'loop'; n: number }[] = [
  { role: 'work', n: 3 }, { role: 'memory', n: 3 }, { role: 'address', n: 1 }, { role: 'loop', n: 2 },
];

/** The kernel strip-mined: vsetvli takes min(n, VLMAX) elements a pass, at any VLEN, with no tail loop. */
export const vectorSaxpy = (lmul: 1 | 2 | 4 | 8 = 1) => `# y[i] = 3·x[i] + y[i], 16 elements (x at 0, y at 64), m${lmul}
        li    a0, 16
        vsetvli zero, a0, e32, m4, tu, mu
        vid.v   v8              # v8 = 0, 1, 2, …
        vadd.vi v12, v8, 1      # x[i] = i + 1
        li    t0, 100
        vrsub.vx v16, v8, t0    # y[i] = 100 − i
        li    a1, 0
        vse32.v v12, (a1)
        li    a2, 64
        vse32.v v16, (a2)
loop:   vsetvli t0, a0, e32, m${lmul}, tu, mu   # t0 = vl = min(a0, VLMAX)
        vle32.v  v8, (a1)
        vle32.v  v16, (a2)
        vsll.vi  v24, v8, 1
        vadd.vv  v24, v24, v8
        vadd.vv  v16, v16, v24
        vse32.v  v16, (a2)
        sub   a0, a0, t0
        slli  t1, t0, 2
        add   a1, a1, t1
        add   a2, a2, t1
        bnez  a0, loop
halt:   j     halt`;

/** The strip-mining loop alone (step 2): n elements of x at a1 added to y at a2, any n, any VLEN. */
export const STRIP_MINE = `loop:   vsetvli t0, a0, e32, m1, tu, mu   # t0 = vl = min(a0, VLMAX)
        vle32.v  v8, (a1)
        vle32.v  v16, (a2)
        vsll.vi  v24, v8, 1
        vadd.vv  v24, v24, v8
        vadd.vv  v16, v16, v24
        vse32.v  v16, (a2)
        sub   a0, a0, t0
        slli  t1, t0, 2
        add   a1, a1, t1
        add   a2, a2, t1
        bnez  a0, loop`;

export const VEC_PROGRAMS: Program[] = [
  {
    id: 'vsaxpy', name: 'Vector: y = 3·x + y',
    blurb: `The lanes chapter's kernel, strip-mined: four passes of four elements at m1. Leaves y[15] = ${SAXPY_RESULT[15]} in t3.`,
    result: { reg: 't3', value: SAXPY_RESULT[15] },
    source: vectorSaxpy(1).replace('halt:   j     halt', '        lw    t3, 124(zero)\nhalt:   j     halt'),
  },
  {
    id: 'vadd4', name: 'Vector: vadd at m4',
    blurb: 'Sixteen elements in one instruction: vadd.vv at m4 takes four beats, four elements a beat.',
    result: { reg: 'a0', value: 30 },
    source: `# one vadd over a group of four registers: 16 elements, 4 beats
        li    t0, 16
        vsetvli zero, t0, e32, m4, tu, mu
        vid.v   v8              # v8…v11  = 0 … 15
        vadd.vi v12, v8, 0      # v12…v15 = 0 … 15
        vadd.vv v16, v8, v12    # v16…v19 = 0, 2, … 30: four beats
        vmv.x.s a1, v19         # v19 holds elements 12 … 15: a1 = 24
        vse32.v v16, (zero)
        lw    a0, 60(zero)      # the last element: 30
halt:   j     halt`,
  },
  {
    id: 'vload', name: 'Vector: a line a beat',
    blurb: 'vle32 and vse32 at m2 from a base that is not 16-byte aligned: four banks, four words a beat, no conflict. Leaves 7 in a0.',
    result: { reg: 'a0', value: 7 },
    source: `# eight words from address 4 (word 1): lane i's word sits in bank (1 + i) mod 4
        li    t0, 8
        vsetvli zero, t0, e32, m2, tu, mu
        vid.v   v4              # 0 … 7
        li    a1, 4
        vse32.v v4, (a1)        # words 1 … 8
        vle32.v v8, (a1)        # back: two beats, one line each
        vmv.x.s a0, v9          # element 4 = v9's element 0
        addi  a0, a0, 3         # 4 + 3 = 7
halt:   j     halt`,
  },
  {
    id: 'vmask', name: 'Vector: a mask you can see',
    blurb: 'A compare writes v0; a masked add changes only the elements whose bit is 1; vmerge clamps at a threshold. Leaves 6 in a0.',
    result: { reg: 'a0', value: 6 },
    source: `# x = 0 … 7; add 10 where x < 3; then clamp x at 6
        li    t0, 8
        vsetvli zero, t0, e32, m2, tu, mu
        vid.v   v8              # 0 … 7
        vmv.v.v v16, v8
        li    a1, 3
        vmslt.vx v0, v8, a1     # v0 = 00000111: elements 0, 1, 2
        vadd.vi v16, v16, 10, v0.t   # only they change (to 10, 11, 12)
        li    a2, 6
        vmsgt.vx v0, v8, a2     # v0 = 10000000: x > 6
        vmerge.vxm v24, v8, a2, v0   # min(x, 6): 6 where the bit is 1, x elsewhere
        vmv.s.x v2, zero
        vredsum.vs v1, v24, v2       # 0 + 1 + … + 6 + 6 = 27 in v1[0]
        vmv.x.s a3, v1
        vse32.v v24, (zero)
        lw    a0, 28(zero)      # the clamped last element: 6
halt:   j     halt`,
  },
  {
    id: 'vsum', name: 'Vector: adding up a vector',
    blurb: 'vredsum over 16 elements at m4: a tree across the lanes in each beat, an accumulator across the beats, then vmv.x.s. Leaves 136 in a0.',
    result: { reg: 'a0', value: 136 },
    source: `# 1 + 2 + … + 16 = 136
        li    t0, 16
        vsetvli zero, t0, e32, m4, tu, mu
        vid.v   v8
        vadd.vi v8, v8, 1       # 1 … 16
        vmv.s.x v1, zero        # the start value, element 0 of v1: 0
        vredsum.vs v2, v8, v1   # v2[0] = v1[0] + Σ v8
        vmv.x.s a0, v2
halt:   j     halt`,
  },
];
