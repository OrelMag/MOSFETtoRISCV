// Sample programs for chapter 25's 64-bit core (assemble with { xlen: 64 }). Each ends in a self-loop ("halt") and
// names the register it leaves its answer in; tests/rv64.test.ts runs every one on the golden model.

export interface Program64 {
  id: string;
  name: string;
  blurb: string;
  source: string;
  /** Needs the M extension. */
  m?: boolean;
  result: { reg: string; value: bigint };
}

export const PROGRAMS64: Program64[] = [
  {
    id: 'fib90',
    name: 'Fibonacci to F(90)',
    blurb: 'F(90) = 2 880 067 194 370 816 120 needs 62 bits: a 64-bit add does it in one instruction per step.',
    result: { reg: 'a0', value: 2880067194370816120n },
    source: `# a0 = F(90); every F(n) also stored as a doubleword
        li   a0, 0          # F(n)
        li   a1, 1          # F(n + 1)
        li   t0, 90         # steps left
        li   t1, 0          # address
loop:   sd   a0, 0(t1)
        add  t2, a0, a1     # 64 bits at once
        mv   a0, a1
        mv   a1, t2
        addi t1, t1, 8
        andi t1, t1, 255    # 32 doublewords, then round again
        addi t0, t0, -1
        bnez t0, loop
halt:   j    halt`,
  },
  {
    id: 'fact20',
    name: '20! with mul',
    blurb: '20! = 2 432 902 008 176 640 000, the largest factorial below 2⁶³. On RV32 every product would take mul and mulhu and a carry.',
    m: true,
    result: { reg: 'a0', value: 2432902008176640000n },
    source: `# a0 = 20!
        li   a0, 1
        li   t0, 1
        li   t1, 21
loop:   mul  a0, a0, t0     # the low 64 bits of the product
        addi t0, t0, 1
        bne  t0, t1, loop
halt:   j    halt`,
  },
  {
    id: 'words',
    name: 'Word and doubleword',
    blurb: 'The same additions with add and addw: past 2³¹ the W instruction wraps, as RV32 would, and sign-extends.',
    result: { reg: 'a1', value: 0xffffffff80000000n },
    source: `# a0 counts with add, a1 with addw, from 0x7ffffff0 by 4
        li   a0, 0x7ffffff0
        li   a1, 0x7ffffff0
        li   t0, 4
loop:   add  a0, a0, t0     # 64 bits: 0x80000000 is just a number
        addw a1, a1, t0     # 32 bits: 0x80000000 is -2^31
        lui  t1, 0x80000    # lui sign-extends too: t1 = 0xffffffff80000000
        bne  a1, t1, loop
        sd   a0, 0(zero)
        sw   a1, 8(zero)    # the low word only
        lwu  a2, 8(zero)    # read back without the sign
        lw   a3, 8(zero)    # and with it
halt:   j    halt`,
  },
  {
    id: 'popcount',
    name: 'Count the ones',
    blurb: 'Population count of a 64-bit constant by the SWAR trick: shifts, masks and adds on all 64 bits at once.',
    m: true,
    result: { reg: 'a0', value: 32n },
    source: `# a0 = the number of 1 bits in 0x0123456789abcdef
        li   a1, 0x0123456789abcdef
        li   t1, 0x5555555555555555
        srli t0, a1, 1
        and  t0, t0, t1
        sub  a1, a1, t0     # pairs
        li   t1, 0x3333333333333333
        srli t0, a1, 2
        and  t0, t0, t1
        and  a1, a1, t1
        add  a1, a1, t0     # nibbles
        srli t0, a1, 4
        add  a1, a1, t0
        li   t1, 0x0f0f0f0f0f0f0f0f
        and  a1, a1, t1     # bytes
        li   t1, 0x0101010101010101
        mul  a1, a1, t1     # every byte summed into the top byte
        srli a0, a1, 56
halt:   j    halt`,
  },
];
