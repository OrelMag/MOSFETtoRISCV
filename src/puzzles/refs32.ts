// Reference programs for the puzzles on the RV32I (src/riscv/asm.ts) puzzle computer (computers.ts: its I/O). Each passes every
// test on the gates (tests/puzzles.test.ts); their cycles and sizes are the pars (refdata.json).

export const REFS_32: Record<string, string> = {
  echo: `        lui  s0, 0x80000
loop:   lw   a0, 0(s0)
        beqz a0, done
        sw   a0, 4(s0)
        j    loop
done:   j    done
`,
  countdown: `        lui  s0, 0x80000
        lw   a0, 0(s0)          # n
        beqz a0, done
loop:   sw   a0, 4(s0)
        addi a0, a0, -1
        bnez a0, loop
done:   j    done
`,
  add_pairs: `        lui  s0, 0x80000
        lw   t0, 0(s0)          # n pairs left
        beqz t0, done
loop:   lw   a0, 0(s0)
        lw   a1, 0(s0)
        add  a0, a0, a1         # OUT keeps the low 8 bits: mod 256
        sw   a0, 4(s0)
        addi t0, t0, -1
        bnez t0, loop
done:   j    done
`,
  stream_sum: `        lui  s0, 0x80000
        li   a1, 0              # sum
loop:   lw   a0, 0(s0)
        add  a1, a1, a0         # adding the final 0 changes nothing
        bnez a0, loop
        sw   a1, 4(s0)          # OUT keeps the low 8 bits: mod 256
done:   j    done
`,
  running_max: `        lui  s0, 0x80000
        li   a1, 0              # max
        lw   a0, 0(s0)
        beqz a0, done
loop:   bltu a0, a1, keep
        mv   a1, a0
keep:   sw   a1, 4(s0)
        lw   a0, 0(s0)          # the next word, tested at the bottom
        bnez a0, loop
done:   j    done
`,
  odd_only: `        lui  s0, 0x80000
loop:   lw   a0, 0(s0)
        beqz a0, done
        andi t0, a0, 1
        beqz t0, loop           # even: drop it
        sw   a0, 4(s0)
        j    loop
done:   j    done
`,
  popcount: `        lui  s0, 0x80000
loop:   lw   a0, 0(s0)
        beqz a0, done
        li   a1, 0              # ones counted
bit:    addi t0, a0, -1
        and  a0, a0, t0         # x & (x − 1) clears the lowest 1: one turn per 1 bit
        addi a1, a1, 1
        bnez a0, bit
        sw   a1, 4(s0)
        j    loop
done:   j    done
`,
  multiply: `        lui  s0, 0x80000
        lw   a0, 0(s0)          # a
        lw   a1, 0(s0)          # b
        bgeu a0, a1, go
        mv   t0, a0             # a < b: swap, so b (the loop count) is the smaller
        mv   a0, a1
        mv   a1, t0
go:     li   a2, 0              # product
        beqz a1, out
loop:   andi t0, a1, 1
        beqz t0, skip
        add  a2, a2, a0         # this bit of b is 1: add a at its position
skip:   slli a0, a0, 1
        srli a1, a1, 1
        bnez a1, loop
out:    srli t0, a2, 8
        sw   t0, 4(s0)          # high byte
        sw   a2, 4(s0)          # low byte (OUT keeps the low 8 bits)
done:   j    done
`,
  divide: `        lui  s0, 0x80000
        lw   a0, 0(s0)          # a: becomes the remainder
        lw   t1, 0(s0)          # b
        slli a1, t1, 7          # d = b · 2^7: long division, one quotient bit per turn
        li   a2, 0              # q
loop:   slli a2, a2, 1
        bltu a0, a1, skip
        sub  a0, a0, a1         # d fits: this quotient bit is 1
        addi a2, a2, 1
skip:   srli a1, a1, 1
        bgeu a1, t1, loop       # until d has shifted back below b
        sw   a2, 4(s0)
        sw   a0, 4(s0)
done:   j    done
`,
  gcd: `        lui  s0, 0x80000
        lw   a0, 0(s0)          # a
        lw   a1, 0(s0)          # b
        beq  a0, a1, out
        bltu a0, a1, bsub
asub:   sub  a0, a0, a1         # a > b: a ← a − b while that holds
        bltu a1, a0, asub
        beq  a0, a1, out        # now a ≤ b
bsub:   sub  a1, a1, a0         # b > a: b ← b − a while that holds
        bltu a0, a1, bsub
        bne  a0, a1, asub       # now b ≤ a
out:    sw   a0, 4(s0)
done:   j    done
`,
  fibonacci: `        lui  s0, 0x80000
        lw   t0, 0(s0)          # n
        li   a0, 1              # a
        li   a1, 1              # b
loop:   sw   a0, 4(s0)
        add  a1, a1, a0         # b ← a + b
        sub  a0, a1, a0         # a ← (a + b) − a = the old b
        addi t0, t0, -1
        bnez t0, loop
done:   j    done
`,
  decimal: `        lui  s0, 0x80000
        lw   a0, 0(s0)          # n
        li   a1, 47             # hundreds digit: '0' − 1, one too many is counted
hund:   addi a1, a1, 1
        addi a0, a0, -100
        bgez a0, hund
        addi a0, a0, 100        # undo the subtraction that went below 0
        li   a2, 47             # tens digit, the same way
tens:   addi a2, a2, 1
        addi a0, a0, -10
        bgez a0, tens
        addi a0, a0, 58         # undo, plus '0': the ones digit
        li   t0, 48             # '0'
        beq  a1, t0, noh
        sw   a1, 4(s0)
        j    tdig               # after a hundreds digit the tens digit always shows
noh:    beq  a2, t0, ones
tdig:   sw   a2, 4(s0)
ones:   sw   a0, 4(s0)
done:   j    done
`,
  reverse: `        lui  s0, 0x80000
        lw   t0, 0(s0)          # n
        slli t0, t0, 2          # end of the words in RAM (byte address)
        li   a1, 0              # pointer
in:     lw   a0, 0(s0)
        sw   a0, 0(a1)
        addi a1, a1, 4
        bne  a1, t0, in
out:    addi a1, a1, -4         # back down from the last word
        lw   a0, 0(a1)
        sw   a0, 4(s0)
        bnez a1, out
done:   j    done
`,
  sort: `        lui  s0, 0x80000
        lw   t0, 0(s0)          # n
        slli t0, t0, 2
        addi t0, t0, 4          # end: the words sit at 4 … 4n, sorted as they arrive
        sw   zero, 0(zero)      # sentinel 0 at address 0: no word is below it
        li   a1, 4              # first free slot
next:   lw   a0, 0(s0)          # x: insert it into the sorted words
        mv   a2, a1             # the slot being filled
        lw   a3, -4(a2)
        bgeu a0, a3, put
shift:  sw   a3, 0(a2)          # the word before is larger: move it up
        addi a2, a2, -4
        lw   a3, -4(a2)
        bltu a0, a3, shift
put:    sw   a0, 0(a2)
        addi a1, a1, 4
        bne  a1, t0, next
        li   a1, 4
out:    lw   a0, 0(a1)
        sw   a0, 4(s0)
        addi a1, a1, 4
        bne  a1, t0, out
done:   j    done
`,
};
