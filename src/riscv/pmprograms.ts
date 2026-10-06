// Programs for the pipelined RV32IM CPU: multiply and divide hazards (no system features needed).

import { M_PROGRAMS } from './mprograms';
import type { Program } from './programs';

export const PIPE_M_PROGRAMS: Program[] = [
  M_PROGRAMS.find((p) => p.id === 'mcorner')!,
  {
    id: 'mhazards',
    name: 'Multiply and divide hazards',
    blurb: 'Products used at once (a load-use stall), divides followed by their consumer, back-to-back divides, a divide in front of a branch.',
    source: `# every result is used by the very next instruction
        li   a0, 12
        li   a1, -5
        mul  t0, a0, a1        # -60
        add  t1, t0, a0        # needs t0 at once: one stall, then forwarded from W
        mul  t2, t1, t1        # 2304, dependent on the add
        mulh t3, t2, a1        # -1
        div  t4, t2, a0        # 192: the front of the pipeline waits for the divider
        add  t5, t4, t4        # 384, right after the divide
        divu t6, t5, a0        # 32: back-to-back divides
        rem  s2, a1, t6        # -5
        beq  s2, a1, same      # the branch reads a divide result
        li   s3, 1
same:   remu s4, t5, t6        # 0
        mul  s5, s4, a0        # 0
        sw   t5, 0(zero)
        lw   s6, 0(zero)
        mul  s7, s6, s6        # a load feeding a multiply
halt:   j    halt`,
  },
  {
    id: 'mdot',
    name: 'Dot product and mean',
    blurb: 'Sum of products of two 8-word vectors, then divided by 8: a tight multiply loop.',
    source: `# x = 1..8, y = 8..1 (built in memory), dot = sum x[i]*y[i] = 120, mean = dot / 8
        li   t0, 0
        li   t1, 8
fill:   addi t2, t0, 1         # x[i] = i + 1
        sub  t3, t1, t0        # y[i] = 8 - i
        slli t4, t0, 2
        sw   t2, 0(t4)
        sw   t3, 32(t4)
        addi t0, t0, 1
        blt  t0, t1, fill
        li   a0, 0
        li   t0, 0
dot:    slli t4, t0, 2
        lw   t2, 0(t4)
        lw   t3, 32(t4)
        mul  t5, t2, t3
        add  a0, a0, t5
        addi t0, t0, 1
        blt  t0, t1, dot
        div  a1, a0, t1        # 15
        sw   a0, 64(zero)
        sw   a1, 68(zero)
halt:   j    halt`,
  },
];
