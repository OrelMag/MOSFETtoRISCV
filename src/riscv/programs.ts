// Sample programs. They use only what the single-cycle CPU implements (all of RV32I except
// byte / halfword memory access and system instructions). Each ends in a self-loop ("halt").

export interface Program {
  id: string;
  name: string;
  blurb: string;
  source: string;
}

export const PROGRAMS: Program[] = [
  {
    id: 'sum',
    name: 'Sum 1..10',
    blurb: 'A loop with a counter and a branch. Leaves 55 in a0.',
    source: `# sum = 1 + 2 + ... + 10
        li   a0, 0          # sum
        li   t0, 1          # i
        li   t1, 11         # limit
loop:   add  a0, a0, t0     # sum += i
        addi t0, t0, 1      # i++
        bne  t0, t1, loop   # until i == 11
        sw   a0, 0(zero)    # store the result at address 0
halt:   j    halt`,
  },
  {
    id: 'fib',
    name: 'Fibonacci',
    blurb: 'Writes the first 12 Fibonacci numbers to data memory.',
    source: `# fib[0..11] in data memory, one word each
        li   t0, 0          # fib(n-2)
        li   t1, 1          # fib(n-1)
        li   t2, 0          # address
        li   t3, 48         # 12 words * 4 bytes
loop:   sw   t0, 0(t2)
        add  t4, t0, t1     # next
        mv   t0, t1
        mv   t1, t4
        addi t2, t2, 4
        blt  t2, t3, loop
halt:   j    halt`,
  },
  {
    id: 'mul',
    name: 'Multiply (shift & add)',
    blurb: 'RV32I has no multiply instruction. Here is how software does it: 123 × 45.',
    source: `# a0 = a1 * a2, by shifting and adding
        li   a1, 123
        li   a2, 45
        li   a0, 0
loop:   andi t0, a2, 1      # lowest bit of the multiplier
        beqz t0, skip
        add  a0, a0, a1     # add the shifted multiplicand
skip:   slli a1, a1, 1      # multiplicand * 2
        srli a2, a2, 1      # next multiplier bit
        bnez a2, loop
        sw   a0, 0(zero)    # 5535
halt:   j    halt`,
  },
  {
    id: 'sort',
    name: 'Bubble sort',
    blurb: 'Stores 8 numbers, then sorts them in memory. Loads, stores, nested loops.',
    source: `# write 8 unsorted numbers to memory, then bubble-sort them
        li   t0, 0
        li   t1, 37
        sw   t1, 0(t0)
        li   t1, -5
        sw   t1, 4(t0)
        li   t1, 12
        sw   t1, 8(t0)
        li   t1, 99
        sw   t1, 12(t0)
        li   t1, 0
        sw   t1, 16(t0)
        li   t1, 7
        sw   t1, 20(t0)
        li   t1, -40
        sw   t1, 24(t0)
        li   t1, 3
        sw   t1, 28(t0)
        li   s0, 28         # last index * 4
outer:  li   t0, 0          # j
        li   s1, 0          # swapped?
inner:  lw   t1, 0(t0)
        lw   t2, 4(t0)
        ble  t1, t2, noswap # signed compare
        sw   t2, 0(t0)
        sw   t1, 4(t0)
        li   s1, 1
noswap: addi t0, t0, 4
        blt  t0, s0, inner
        bnez s1, outer
halt:   j    halt`,
  },
  {
    id: 'gcd',
    name: 'Greatest common divisor',
    blurb: 'Euclid by subtraction: gcd(1071, 462) = 21. Uses a function call (jal / ret).',
    source: `# a0 = gcd(a0, a1), called as a function
        li   a0, 1071
        li   a1, 462
        jal  ra, gcd
        sw   a0, 0(zero)
halt:   j    halt

gcd:    beq  a0, a1, done
        bltu a0, a1, less
        sub  a0, a0, a1
        j    gcd
less:   sub  a1, a1, a0
        j    gcd
done:   ret`,
  },
  {
    id: 'primer',
    name: 'Primer test program',
    blurb: 'The test program from the NAND-to-CPU primer: every instruction class, hazards included.',
    source: `        addi x1, x0, 0        # sum = 0
        addi x2, x0, 1        # i = 1
        addi x3, x0, 11       # limit
loop:   add  x1, x1, x2       # sum += i
        addi x2, x2, 1        # i++
        beq  x2, x3, done     # taken once
        jal  x0, loop         # back edge
done:   sw   x1, 100(x0)      # mem[100] = 55
        lw   x4, 100(x0)      # x4 = 55
        add  x5, x4, x4       # x5 = 110
        sub  x6, x5, x1       # 55
        slt  x7, x6, x5       # 1
        and  x8, x5, x6       # 38
        or   x9, x5, x6       # 127
        addi x10, x0, -7      # -7
        slt  x12, x10, x0     # 1  (signed compare)
        slti x13, x6, -1      # 0
        andi x14, x9, 0x0f    # 15
        ori  x15, x8, 0x100   # 294
        sw   x5, 104(x0)
        jal  x11, skip        # x11 = return address
        addi x5, x0, 0        # skipped
skip:   sw   x7, 108(x0)
        sub  x16, x0, x3      # -11
        sw   x16, 112(x0)
halt:   beq  x0, x0, halt`,
  },
  {
    id: 'alu',
    name: 'Every ALU operation',
    blurb: 'Exercises shifts, comparisons, LUI and AUIPC: a quick hardware check.',
    source: `        li   a0, -20        # 0xFFFFFFEC
        li   a1, 3
        sll  t0, a0, a1     # -160
        srl  t1, a0, a1     # 0x1FFFFFFD
        sra  t2, a0, a1     # -3
        slt  t3, a0, a1     # 1 (signed)
        sltu t4, a0, a1     # 0 (unsigned: huge > 3)
        xor  t5, a0, a1
        lui  s0, 0x12345    # 0x12345000
        addi s0, s0, 0x678  # 0x12345678
        auipc s1, 0         # address of this instruction
        srai s2, s0, 4
        sltiu s3, a1, 4     # 1
halt:   j    halt`,
  },
];
