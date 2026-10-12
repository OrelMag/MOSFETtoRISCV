// Reference programs for the puzzles on the RV16 (src/riscv/rv16) puzzle computer (computers.ts: its I/O). Each passes every
// test on the gates (tests/puzzles.test.ts); their cycles and sizes are the pars (refdata.json).

export const REFS_16: Record<string, string> = {
  echo: `loop:   lw   a0, -4(x0)
        beqz a0, done
        sw   a0, -3(x0)
        j    loop
done:   halt
`,

  countdown: `        lw   a0, -4(x0)      # n
        beqz a0, done
loop:   sw   a0, -3(x0)
        addi a0, a0, -1
        bnez a0, loop
done:   halt
`,

  add_pairs: `        lw   a2, -4(x0)      # n
        beqz a2, done
loop:   lw   a0, -4(x0)
        lw   a1, -4(x0)
        add  a0, a0, a1      # OUT keeps the low 8 bits: mod 256
        sw   a0, -3(x0)
        addi a2, a2, -1
        bnez a2, loop
done:   halt
`,

  stream_sum: `        li   a1, 0           # sum
loop:   lw   a0, -4(x0)
        add  a1, a1, a0      # adding the final 0 changes nothing
        bnez a0, loop
        sw   a1, -3(x0)      # OUT keeps the low 8 bits: mod 256
        halt
`,

  running_max: `        li   a1, 0           # max
        lw   a0, -4(x0)
        beqz a0, done
loop:   bge  a1, a0, keep    # words are 0 … 255: a signed compare is fine
        mv   a1, a0
keep:   sw   a1, -3(x0)
        lw   a0, -4(x0)
        bnez a0, loop
done:   halt
`,

  odd_only: `        li   t1, 1
        lw   a0, -4(x0)
        beqz a0, done
loop:   and  t0, a0, t1      # bit 0
        beqz t0, skip
        sw   a0, -3(x0)
skip:   lw   a0, -4(x0)
        bnez a0, loop
done:   halt
`,

  popcount: `        li   a1, 0x55        # masks: every other bit, pairs, a nibble
        li   a2, 0x33
        li   t1, 0x0f
        lw   a0, -4(x0)
        beqz a0, done
loop:   srli t0, a0, 1       # all the bits at once, no loop over them:
        and  t0, t0, a1
        sub  a0, a0, t0      # 4 two-bit counts (a pair 2h + l, minus h: h + l)
        srli t0, a0, 2
        and  t0, t0, a2
        and  a0, a0, a2
        add  a0, a0, t0      # 2 four-bit counts
        srli t0, a0, 4
        add  a0, a0, t0
        and  a0, a0, t1      # 1 count
        sw   a0, -3(x0)
        lw   a0, -4(x0)
        bnez a0, loop
done:   halt
`,

  multiply: `        lw   a0, -4(x0)      # a
        lw   a1, -4(x0)      # b
        bge  a0, a1, go
        mv   t0, a0          # loop over the smaller one: fewer bits
        mv   a0, a1
        mv   a1, t0
go:     li   a2, 0           # product (16 bits)
        li   t1, 1
loop:   and  t0, a1, t1      # bit 0 of b
        beqz t0, skip
        add  a2, a2, a0
skip:   slli a0, a0, 1
        srli a1, a1, 1
        bnez a1, loop        # no 1 bits left: done
        srli t0, a2, 8
        sw   t0, -3(x0)      # high byte
        sw   a2, -3(x0)      # low byte (OUT keeps the low 8 bits)
        halt
`,

  divide: `        lw   a0, -4(x0)      # a, becomes the remainder
        lw   a1, -4(x0)      # b
        li   a2, 0           # quotient
        blt  a0, a1, done    # a < b: 0, remainder a
        mv   t0, a1          # d: b shifted up to the largest b·2^k ≤ a
norm:   slli t0, t0, 1
        bge  a0, t0, norm
        srli t0, t0, 1
step:   slli a2, a2, 1       # long division: one quotient bit per position of d
        blt  a0, t0, skip
        sub  a0, a0, t0
        addi a2, a2, 1
skip:   srli t0, t0, 1
        bge  t0, a1, step    # until d is back down to b
done:   sw   a2, -3(x0)
        sw   a0, -3(x0)
        halt
`,

  // Euclid by remainders: a0 ← a0 mod a1, then a1 ← a1 mod a0, … until one is 0. A remainder is one subtraction
  // when the quotient is 1 (the common case), else a long division (as in divide): gcd(255, 1) takes no 254 rounds.
  gcd: `        lw   a0, -4(x0)      # a
        lw   a1, -4(x0)      # b
        blt  a0, a1, gb
ga:     sub  a0, a0, a1      # a0 ≥ a1 > 0: a0 ← a0 mod a1
        blt  a0, a1, ga_r    # quotient 1
        mv   t0, a1
ga_n:   slli t0, t0, 1       # the largest a1·2^k ≤ a0
        bge  a0, t0, ga_n
        srli t0, t0, 1
ga_s:   blt  a0, t0, ga_k
        sub  a0, a0, t0
ga_k:   srli t0, t0, 1
        bge  t0, a1, ga_s
ga_r:   beqz a0, out_b       # a1 divides a0: the gcd
gb:     sub  a1, a1, a0      # a1 ≥ a0 > 0: a1 ← a1 mod a0
        blt  a1, a0, gb_r
        mv   t0, a0
gb_n:   slli t0, t0, 1
        bge  a1, t0, gb_n
        srli t0, t0, 1
gb_s:   blt  a1, t0, gb_k
        sub  a1, a1, t0
gb_k:   srli t0, t0, 1
        bge  t0, a0, gb_s
gb_r:   bnez a1, ga
        sw   a0, -3(x0)      # a0 divides a1: the gcd
        halt
out_b:  sw   a1, -3(x0)
        halt
`,

  fibonacci: `        lw   a2, -4(x0)      # n
        li   a0, 1           # F(i)
        li   a1, 1           # F(i + 1)
loop:   sw   a0, -3(x0)      # two numbers a turn: no moves
        addi a2, a2, -1
        beqz a2, done
        sw   a1, -3(x0)
        add  a0, a0, a1      # F(i + 2)
        add  a1, a1, a0      # F(i + 3)
        addi a2, a2, -1
        bnez a2, loop
done:   halt
`,

  decimal: `        lw   a0, -4(x0)      # n
        li   t1, 48          # '0'
        li   a1, 100
        li   t0, 10
        mv   a2, t1          # the digit being counted, as a character
        bge  a0, a1, hun
        blt  a0, t0, ones    # n < 10: the ones digit alone
ten:    sub  a0, a0, t0
        addi a2, a2, 1
        bge  a0, t0, ten
tens:   sw   a2, -3(x0)
ones:   add  a0, a0, t1
        sw   a0, -3(x0)
        halt
hun:    sub  a0, a0, a1
        addi a2, a2, 1
        bge  a0, a1, hun
        sw   a2, -3(x0)
        mv   a2, t1
        bge  a0, t0, ten
        j    tens            # a 0 tens digit, written after a hundreds digit
`,

  reverse: `        lw   a2, -4(x0)      # n
        li   t0, 0           # into mem[0 … n − 1]
in:     lw   a0, -4(x0)
        sw   a0, 0(t0)
        addi t0, t0, 1
        bne  t0, a2, in
out:    lw   a0, -1(t0)      # back down from mem[n − 1]
        sw   a0, -3(x0)
        addi t0, t0, -1
        bnez t0, out
        halt
`,

  // Insertion sort as the words arrive, into mem[1 … n]. mem[0] holds −1, below every word (they are 0 … 255,
  // compared signed), so the shifting loop needs no bound check.
  sort: `        lw   t1, -4(x0)      # n
        addi t1, t1, 1       # stop when end = n + 1
        li   a1, -1
        sw   a1, 0(x0)       # the sentinel
        li   a2, 1           # end: one past the sorted words
next:   lw   a0, -4(x0)      # x
        mv   t0, a2          # j: x's place, from the end down
        lw   a1, -1(t0)
        bge  a0, a1, place
shift:  sw   a1, 0(t0)       # mem[j] ← mem[j − 1]
        addi t0, t0, -1
        lw   a1, -1(t0)
        blt  a0, a1, shift
place:  sw   a0, 0(t0)
        addi a2, a2, 1
        bne  a2, t1, next
        li   t0, 1
out:    lw   a0, 0(t0)
        sw   a0, -3(x0)
        addi t0, t0, 1
        bne  t0, t1, out
        halt
`,
};
