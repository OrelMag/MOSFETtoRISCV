// Chapter 21's multi-word arithmetic: 64-bit add / subtract and a 64 × 64 → 128 product on RV32IM (no flags: the
// carry is an sltu). DOM-free; tests/multiword.test.ts runs it on the golden model against BigInt.

/** a1:a0 + a3:a2 → s5:s4, a3:a2 − a1:a0 → s7:s6, a1:a0 × a3:a2 → s3:s2:s1:s0, from the operands in the registers. */
export const MULTIWORD_BODY = `        add  s4, a0, a2        # sum, low word
        sltu t1, s4, a0        # carry out: the wrapped sum is below an operand
        add  s5, a1, a3
        add  s5, s5, t1        # sum, high word + carry
        sltu t3, a2, a0        # borrow out of B - A: B.lo < A.lo
        sub  s6, a2, a0        # difference, low word
        sub  s7, a3, a1
        sub  s7, s7, t3        # difference, high word - borrow
        mul  s0, a0, a2        # four 32 x 32 -> 64 products, a mul and a mulhu each
        mulhu s1, a0, a2
        mul  t0, a0, a3
        mulhu t1, a0, a3
        mul  t2, a1, a2
        mulhu t3, a1, a2
        mul  t4, a1, a3
        mulhu t5, a1, a3
        add  s1, s1, t0        # word 1: three terms, two carries
        sltu t6, s1, t0
        add  s1, s1, t2
        sltu a4, s1, t2
        add  t6, t6, a4        # carries out of word 1 (0, 1 or 2)
        add  s2, t1, t3        # word 2: three terms and those carries
        sltu a4, s2, t3
        add  s2, s2, t4
        sltu a5, s2, t4
        add  a4, a4, a5
        add  s2, s2, t6
        sltu a5, s2, t6
        add  a4, a4, a5
        add  s3, t5, a4        # word 3: the high product and the carries (never overflows)`;

/** The chapter's program: A = 0x1_FFFFFFFF, B = 0x2_00000003. */
export const MULTIWORD_SOURCE = `# A = a1:a0 = 0x1_FFFFFFFF   B = a3:a2 = 0x2_00000003   (low word first)
        li   a0, -1
        li   a1, 1
        li   a2, 3
        li   a3, 2
${MULTIWORD_BODY}
halt:   j    halt`;

/**
 * The signed 64 × 64 → 128 product: the cross products' high words are mulhsu (signed high word, unsigned low word), the top
 * one mulh, and the two cross products' sign extends into the top word (srai by 31).
 */
export const MULTIWORD_SIGNED_BODY = MULTIWORD_BODY.split('\n').slice(8)
  .map((l) => l.replace('mulhu t1, a0, a3', 'mulhsu t1, a3, a0').replace('mulhu t3, a1, a2', 'mulhsu t3, a1, a2').replace('mulhu t5, a1, a3', 'mulh  t5, a1, a3'))
  .join('\n') + `
        srai t0, t1, 31        # the cross products are signed: their sign fills word 3
        add  s3, s3, t0
        srai t0, t3, 31
        add  s3, s3, t0`;
