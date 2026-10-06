// Programs for the single-cycle CPU with the FPU (chapter 23). Constants enter through integer
// registers (li + fmv.w.x) or conversions (fcvt.s.w); there is no fdiv in this subset.

import type { Program } from './programs';

export const F_PROGRAMS: Program[] = [
  {
    id: 'tenth',
    name: '0.1 ten times',
    blurb: 'Adds 0.1 to itself ten times. The sum is not 1.0, and the error is exactly one unit in the last place.',
    source: `# sum = 0.1 + 0.1 + ... (ten times), compared with 1.0
        li   t0, 0x3dcccccd    # 0.1f (the nearest float: 0.100000001490116...)
        fmv.w.x ft0, t0
        fmv.w.x ft1, zero      # sum = +0.0
        li   t1, 10
loop:   fadd.s ft1, ft1, ft0
        addi t1, t1, -1
        bnez t1, loop
        li   t0, 1
        fcvt.s.w ft2, t0       # 1.0
        feq.s a0, ft1, ft2     # 0: not equal
        fsub.s ft3, ft1, ft2   # the error: 2^-23
        fmv.x.w a1, ft1        # 0x3F800001
halt:   j    halt`,
  },
  {
    id: 'dot',
    name: 'Dot product',
    blurb: 'Builds two vectors in memory with fcvt.s.w and fsw, then sums their products with flw, fmul.s and fadd.s.',
    source: `# a[i] = i + 1, b[i] = (4 - i) / 2; dot = 1*2 + 2*1.5 + 3*1 + 4*0.5 = 10
        li   t0, 0x3f000000    # 0.5
        fmv.w.x fs0, t0
        li   t0, 0
        li   t2, 4
fill:   slli t3, t0, 2
        addi t1, t0, 1
        fcvt.s.w ft0, t1
        fsw  ft0, 0(t3)        # a[i] at 0x00
        li   t4, 4
        sub  t1, t4, t0
        fcvt.s.w ft1, t1
        fmul.s ft1, ft1, fs0
        fsw  ft1, 16(t3)       # b[i] at 0x10
        addi t0, t0, 1
        blt  t0, t2, fill
        fmv.w.x fa0, zero
        li   t0, 0
dot:    slli t3, t0, 2
        flw  ft0, 0(t3)
        flw  ft1, 16(t3)
        fmul.s ft2, ft0, ft1
        fadd.s fa0, fa0, ft2
        addi t0, t0, 1
        blt  t0, t2, dot
        fsw  fa0, 32(zero)     # 10.0 = 0x41200000
halt:   j    halt`,
  },
  {
    id: 'absorb',
    name: 'Rounding surprises',
    blurb: 'Absorption (1e8 + 1 = 1e8), ties to even (2^24 + 1 becomes 2^24), signed zero, and infinity minus infinity.',
    source: `# where float arithmetic differs from real arithmetic
        li   t0, 100000000
        fcvt.s.w ft0, t0       # 1e8 (exactly representable)
        li   t0, 1
        fcvt.s.w ft1, t0       # 1.0
        fadd.s ft2, ft0, ft1   # 1e8 + 1 = 1e8: the 1 is absorbed
        feq.s a0, ft2, ft0     # 1
        li   t0, 16777217
        fcvt.s.w ft3, t0       # 2^24 + 1: a tie, rounds to even (2^24)
        fmv.x.w a1, ft3        # 0x4B800000
        fsub.s ft4, ft1, ft1   # +0
        fneg.s ft5, ft4        # -0
        feq.s a2, ft4, ft5     # 1: +0 == -0 ...
        fmv.x.w a3, ft5        # ... but the bits differ: 0x80000000
        li   t0, 0x7f800000
        fmv.w.x ft6, t0        # +infinity
        fsub.s ft7, ft6, ft6   # inf - inf = NaN (0x7FC00000)
        feq.s a4, ft7, ft7     # 0: NaN is not equal to itself
        fmul.s ft8, ft0, ft0   # 1e16: still fine
        fmul.s ft9, ft8, ft8   # 1e32
        fmul.s ft10, ft9, ft9  # 1e64: overflow to +infinity
halt:   j    halt`,
  },
];
