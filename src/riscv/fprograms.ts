// Programs for the single-cycle CPU with the FPU (chapter 23). Constants enter through integer
// registers (li + fmv.w.x) or conversions (fcvt.s.w).

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
  {
    id: 'rmodes',
    name: 'Rounding modes',
    blurb: 'Converts 2.5 and −2.5 to integers in all five rounding modes, rounds 2^24 + 1 to a float statically and with the dynamic mode in frm.',
    source: `# the five rounding modes on halfway cases (rm in the instruction, or frm when rm = dyn)
        li   t0, 0x40200000    # 2.5
        fmv.w.x ft0, t0
        fneg.s ft1, ft0        # -2.5
        fcvt.w.s a0, ft0, rne  #  2 (ties to even)
        fcvt.w.s a1, ft0, rtz  #  2
        fcvt.w.s a2, ft0, rdn  #  2
        fcvt.w.s a3, ft0, rup  #  3
        fcvt.w.s a4, ft0, rmm  #  3 (ties away from zero)
        fcvt.w.s s2, ft1, rne  # -2
        fcvt.w.s s3, ft1, rtz  # -2
        fcvt.w.s s4, ft1, rdn  # -3
        fcvt.w.s s5, ft1, rup  # -2
        fcvt.w.s s6, ft1, rmm  # -3
        li   t1, 16777217      # 2^24 + 1: halfway between two floats
        fcvt.s.w ft2, t1, rne  # 2^24 (0x4B800000, the even one)
        fcvt.s.w ft3, t1, rup  # 2^24 + 2 (0x4B800001)
        fsrmi 2                # frm = RDN: the dynamic mode
        li   t1, -16777217
        fcvt.s.w ft4, t1       # rm = dyn: -(2^24 + 2) (0xCB800001)
        frrm a5                # 2
        frflags a6             # 0x01: NX, every conversion above was inexact
halt:   j    halt`,
  },
  {
    id: 'flags',
    name: 'Exception flags',
    blurb: 'Raises NV, OF, UF and NX one at a time and reads them from fflags (fsflags reads and clears them in one instruction). A tiny exact result raises nothing.',
    source: `# every exception, caught in fflags: NV 0x10, DZ 0x08, OF 0x04, UF 0x02, NX 0x01
        li   t0, 0x7f800000
        fmv.w.x ft0, t0        # +inf
        fsub.s ft1, ft0, ft0   # inf - inf = NaN
        fsflags a0, zero       # a0 = 0x10 (NV); fflags = 0
        li   t0, 0x7f000000    # 2^127
        fmv.w.x ft2, t0
        fadd.s ft3, ft2, ft2   # 2^128 overflows: +inf
        fsflags a1, zero       # 0x05 (OF NX)
        fmul.s ft4, ft2, ft2, rtz # towards zero, overflow stops at 0x7F7FFFFF
        fsflags a2, zero       # 0x05
        li   t0, 0x00800000    # 2^-126, the smallest normal
        fmv.w.x ft5, t0
        li   t0, 0x3f400000    # 0.75
        fmv.w.x ft6, t0
        fmul.s ft7, ft5, ft6   # 0.75 * 2^-126: subnormal but exact
        fsflags a3, zero       # 0x00: tiny and exact is not an underflow
        li   t0, 0x3eaaaaab    # 1/3
        fmv.w.x ft8, t0
        fmul.s ft9, ft5, ft8   # 2^-126 / 3: subnormal and inexact
        fsflags a4, zero       # 0x03 (UF NX)
        li   t0, 0x4f32d05e    # 3e9
        fmv.w.x fs0, t0
        fcvt.w.s a5, fs0       # too big for int32: 0x7FFFFFFF and NV
        fcvt.wu.s a6, fs0      # fits uint32: 3000000000, exact
        frflags a7             # 0x10
halt:   j    halt`,
  },
  {
    id: 'minmax',
    name: 'fmin, fmax, fclass',
    blurb: 'fmin and fmax ignore a NaN operand and order −0 below +0; fclass names the class of a value in one bit; flt signals on a quiet NaN, feq does not.',
    source: `# min / max with NaNs and signed zeros, classification, and quiet vs signaling compares
        li   t0, 0x7fc00000    # quiet NaN
        fmv.w.x ft0, t0
        li   t0, 1
        fcvt.s.w ft1, t0       # 1.0
        fmin.s ft2, ft0, ft1   # 1.0: the NaN is ignored
        fmax.s ft3, ft0, ft0   # both NaN: canonical NaN
        fmv.w.x ft4, zero      # +0
        fneg.s ft5, ft4        # -0
        fmin.s ft6, ft4, ft5   # -0
        fmax.s ft7, ft5, ft4   # +0
        fclass.s a0, ft0       # 0x200: quiet NaN
        fclass.s a1, ft5       # 0x008: -0
        li   t0, 1
        fmv.w.x ft8, t0        # the smallest subnormal, 2^-149
        fclass.s a2, ft8       # 0x020: +subnormal
        feq.s a3, ft0, ft0     # 0, and no flag: feq is a quiet compare
        frflags a4             # 0x00
        flt.s a5, ft0, ft1     # 0, and NV: flt and fle signal on any NaN
        li   t0, 0x7f800001
        fmv.w.x ft9, t0        # a signaling NaN
        fclass.s a6, ft9       # 0x100
        fmin.s ft10, ft9, ft1  # 1.0, NV
        frflags a7             # 0x10
halt:   j    halt`,
  },
  {
    id: 'divsqrt',
    name: 'Division and square root',
    blurb: 'fdiv.s and fsqrt.s on the iterative units: each stalls the CPU for 29 or 28 cycles. 1/3, x/0 (DZ), 0/0 (NV), √2, √−0 and √−1.',
    source: `# iterative division and square root: watch the PC wait while they run
        li   t0, 1
        fcvt.s.w ft0, t0       # 1.0
        li   t0, 3
        fcvt.s.w ft1, t0       # 3.0
        fdiv.s ft2, ft0, ft1   # 1/3 = 0x3EAAAAAB (rounded up: 0.333333343)
        fdiv.s ft3, ft0, ft1, rtz # 0x3EAAAAAA, truncated
        fsflags a0, zero       # 0x01: NX
        fmv.w.x ft4, zero      # +0
        fdiv.s ft5, ft0, ft4   # 1/0 = +inf
        fsflags a1, zero       # 0x08: DZ
        fdiv.s ft6, ft4, ft4   # 0/0 = NaN
        fsflags a2, zero       # 0x10: NV
        li   t0, 2
        fcvt.s.w ft7, t0
        fsqrt.s ft8, ft7       # sqrt 2 = 0x3FB504F3
        fneg.s ft9, ft4        # -0
        fsqrt.s ft10, ft9      # sqrt -0 = -0
        fneg.s ft11, ft0
        fsqrt.s fs0, ft11      # sqrt -1 = NaN
        frflags a3             # 0x11: NV NX
        fmv.x.w a4, ft8
halt:   j    halt`,
  },
  {
    id: 'newton',
    name: "Newton's √2",
    blurb: "Newton's iteration x = (x + 2/x) / 2 from x = 1, four times, against one fsqrt.s: the iteration lands on the same correctly rounded float, at four divisions' cost.",
    source: `# sqrt(2) by Newton's method, compared with the hardware square root
        li   t0, 2
        fcvt.s.w fs0, t0       # a = 2
        li   t0, 1
        fcvt.s.w fa0, t0       # x = 1
        li   t0, 0x3f000000
        fmv.w.x fs1, t0        # 0.5
        li   t1, 4
loop:   fdiv.s ft0, fs0, fa0   # a / x
        fadd.s ft0, ft0, fa0   # x + a / x
        fmul.s fa0, ft0, fs1   # x = (x + a / x) / 2
        addi t1, t1, -1
        bnez t1, loop
        fsqrt.s fa1, fs0       # one instruction, 28 cycles
        feq.s a0, fa0, fa1     # 1: the same float
        fmv.x.w a1, fa0        # 0x3FB504F3
halt:   j    halt`,
  },
  {
    id: 'fma',
    name: 'Fused multiply-add',
    blurb: 'x·x − p with x = 1 + 2^-12: fmul then fsub rounds twice and gets 0; fmsub.s rounds once and gets the exact 2^-24. Then the four sign variants.',
    source: `# one rounding instead of two
        li   t0, 0x3f800800    # x = 1 + 2^-12
        fmv.w.x ft0, t0
        li   t0, 0x3f801000    # p = 1 + 2^-11, the float nearest to x*x
        fmv.w.x ft1, t0
        fmul.s ft2, ft0, ft0   # x*x = 1 + 2^-11 + 2^-24, rounded: p (a tie, to even)
        fsub.s ft3, ft2, ft1   # 0: the 2^-24 was rounded away
        fmsub.s ft4, ft0, ft0, ft1  # x*x - p in one step: 2^-24 = 0x33800000, exact
        fmv.x.w a0, ft3
        fmv.x.w a1, ft4
        frflags a2             # 0x01: only fmul was inexact
        li   t0, 3
        fcvt.s.w fa0, t0       # 3
        li   t0, 4
        fcvt.s.w fa1, t0       # 4
        li   t0, 5
        fcvt.s.w fa2, t0       # 5
        fmadd.s fa3, fa0, fa1, fa2   #  3*4 + 5 =  17
        fmsub.s fa4, fa0, fa1, fa2   #  3*4 - 5 =   7
        fnmsub.s fa5, fa0, fa1, fa2  # -3*4 + 5 =  -7
        fnmadd.s fa6, fa0, fa1, fa2  # -3*4 - 5 = -17
        fcvt.w.s a3, fa3
        fcvt.w.s a4, fa4
        fcvt.w.s a5, fa5
        fcvt.w.s a6, fa6
halt:   j    halt`,
  },
  {
    id: 'horner',
    name: 'Horner with fmadd',
    blurb: 'Evaluates 1 + t + t²/2 + t³/6 (e^t to third order) at t = 0.3 by Horner\'s rule: three fmadd.s, one rounding each, against three fmul.s + fadd.s pairs. Half the instructions, and here one ulp closer to the exact 1.34950001603.',
    source: `# p(t) = ((t/6 + 1/2) t + 1) t + 1 at t = 0.3
        li   t0, 0x3e2aaaab    # 1/6
        fmv.w.x fs0, t0
        li   t0, 0x3f000000    # 1/2
        fmv.w.x fs1, t0
        li   t0, 1
        fcvt.s.w fs2, t0       # 1
        li   t0, 0x3e99999a    # t = 0.3
        fmv.w.x fs3, t0
        fmadd.s ft0, fs0, fs3, fs1   # t/6 + 1/2
        fmadd.s ft0, ft0, fs3, fs2   # (...) t + 1
        fmadd.s ft0, ft0, fs3, fs2   # (...) t + 1 = 1.34950006 (0x3FACBC6B)
        fmul.s ft1, fs0, fs3         # the same, rounding twice per step
        fadd.s ft1, ft1, fs1
        fmul.s ft1, ft1, fs3
        fadd.s ft1, ft1, fs2
        fmul.s ft1, ft1, fs3
        fadd.s ft1, ft1, fs2         # 1.34949994 (0x3FACBC6A)
        fmv.x.w a0, ft0
        fmv.x.w a1, ft1
        feq.s a2, ft0, ft1           # 0
halt:   j    halt`,
  },
  {
    id: 'fpchain',
    name: 'Dependent vs independent adds',
    blurb: 'Twelve fadd.s into one accumulator (each waits for the previous one: the FP pipe is three stages deep), then the same twelve spread over three accumulators. On the pipelined CPU the second half runs without a single stall.',
    source: `# one accumulator: every fadd.s needs the previous result
        li   t0, 1
        fcvt.s.w ft0, t0       # 1.0
        fmv.w.x fa0, zero
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0
        fadd.s fa0, fa0, ft0   # 12.0
# three accumulators: three independent chains, interleaved
        fmv.w.x fa1, zero
        fmv.w.x fa2, zero
        fmv.w.x fa3, zero
        fadd.s fa1, fa1, ft0
        fadd.s fa2, fa2, ft0
        fadd.s fa3, fa3, ft0
        fadd.s fa1, fa1, ft0
        fadd.s fa2, fa2, ft0
        fadd.s fa3, fa3, ft0
        fadd.s fa1, fa1, ft0
        fadd.s fa2, fa2, ft0
        fadd.s fa3, fa3, ft0
        fadd.s fa1, fa1, ft0
        fadd.s fa2, fa2, ft0
        fadd.s fa3, fa3, ft0
        fadd.s fa4, fa1, fa2
        fadd.s fa4, fa4, fa3   # 12.0
        feq.s a0, fa0, fa4     # 1
halt:   j    halt`,
  },
];
