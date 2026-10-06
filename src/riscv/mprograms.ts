// Programs for the RV32IM system CPU (chapter 20): multiply and divide.

import type { Program } from './programs';

export const M_PROGRAMS: Program[] = [
  {
    id: 'mcorner',
    name: 'RV32M corner cases',
    blurb: 'Signed and unsigned high products, rounding toward zero, division by zero and the one overflow case.',
    source: `# RV32M: watch the registers after each instruction
        li   a0, -7
        li   a1, 3
        mul  t0, a0, a1        # -21
        mulh t1, a0, a1        # -1: high word of a negative product
        mulhu t2, a0, a1       # 2: 0xFFFFFFF9 * 3 = 0x2_FFFFFFEB unsigned
        mulhsu t3, a0, a1      # -1
        div  t4, a0, a1        # -2: rounds toward zero
        rem  t5, a0, a1        # -1: takes the sign of the dividend
        divu t6, a0, a1        # 0x55555553
        remu s2, a0, a1        # 0
        div  s3, a0, zero      # -1: division by zero does not trap
        rem  s4, a0, zero      # -7: remainder = dividend
        li   a2, 0x80000000
        li   a3, -1
        div  s5, a2, a3        # 0x80000000: the one overflow case
        rem  s6, a2, a3        # 0
halt:   j    halt`,
  },
  {
    id: 'factorial',
    name: 'Factorials in decimal',
    blurb: 'n! with mul, printed to the console digit by digit with divu and remu.',
    source: `# n! for n = 1..8, printed in decimal
        li   s0, 0x80000000    # console
        li   s1, 1             # n
        li   s2, 1             # n!
        li   s3, 10            # base, and the last n
loop:   mul  s2, s2, s1        # n! = (n-1)! * n   (one cycle)
        mv   a0, s2
        jal  ra, print
        addi s1, s1, 1
        li   t0, 8
        ble  s1, t0, loop
halt:   j    halt

# print a0 in decimal and a newline (digits are produced last-first, so buffer them)
print:  li   t1, 64            # buffer grows down from byte 64
digit:  remu t2, a0, s3        # last digit       (34 cycles)
        divu a0, a0, s3        # drop it          (34 cycles)
        addi t2, t2, 48        # '0' + digit
        addi t1, t1, -1
        sb   t2, 0(t1)
        bnez a0, digit
        li   t3, 64
out:    lbu  t2, 0(t1)
        sb   t2, 0(s0)
        addi t1, t1, 1
        blt  t1, t3, out
        li   t2, 10
        sb   t2, 0(s0)
        ret`,
  },
];
