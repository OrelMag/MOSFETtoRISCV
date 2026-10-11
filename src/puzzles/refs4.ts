// Reference programs for the puzzles on the 4-bit CPU (4004 assembly, src/isa4) puzzle computer (computers.ts: its I/O). Each passes every
// test on the gates (tests/puzzles.test.ts); their cycles and sizes are the pars (refdata.json).
// A word comes and goes as two nibbles, high first. Registers, A and CY power on at 0 (the 4004's reset clears
// them), and several programs count on it. SUB is A + ¬r + ¬CY with CY = 1 meaning no borrow: CY = 0 before
// the low nibble, CMC between the nibbles. reverse and sort are missing: n words do not fit in 16 nibbles.

export const REFS_4: Record<string, string> = {
  echo: `; a high nibble ≠ 0 means the word is not the 0 that ends the stream: echo it at once
        RDR
        JCN  AZ, hz
hnz:    WRR                ; high nibble
        RDR
        WRR                ; low nibble
        RDR                ; the next word's high nibble
        JCN  AN, hnz
hz:     RDR                ; high nibble 0: a low 0 is the end
        JCN  AZ, done
        XCH  R0            ; R0 = low, A = 0 (R0 is 0 between words)
        WRR
        XCH  R0            ; A = low, R0 = 0 again
        WRR
        RDR
        JCN  AN, hnz
        JUN  hz
done:   JUN  done
`,

  countdown: `; R1 holds −l (16 − l), so ISZ counts it up to 0 as the low nibble l counts down to 1
        RDR
        XCH  R0            ; R0 = h (high nibble)
        RDR
        CMA
        IAC                ; A = −l, CY = 1 only for l = 0
        JCN  C1, zero
        XCH  R1
out:    LD   R0            ; write h
        WRR
        LDM  0
        SUB  R1            ; A = 0 − R1 = l (CY = 0 throughout the loop)
        WRR
        ISZ  R1, out
zero:   LD   R0            ; l = 0: next is h:0, unless h = 0 too
        JCN  AZ, done
        WRR
        DAC
        XCH  R0            ; h − 1
        CLB                ; A = 0, CY = 0
        WRR
        LDM  1             ; l = 15: R1 = −15 = 1
        XCH  R1
        JUN  out
done:   JUN  done
`,

  add_pairs: `; R15 = −n counts the pairs (ISZ); a in R0:R1, b's high nibble in R2
        RDR                ; n's high nibble (0: n ≤ 10)
        RDR
        JCN  AZ, done
        CMA
        IAC
        XCH  R15           ; R15 = −n
loop:   RDR
        XCH  R0
        RDR
        XCH  R1
        RDR
        XCH  R2
        RDR                ; b low
        CLC
        ADD  R1            ; low sum, CY = its carry
        XCH  R1
        LD   R2
        ADD  R0            ; high sum + the carry
        WRR
        LD   R1
        WRR
        ISZ  R15, loop
done:   JUN  done
`,

  stream_sum: `; sum in R0:R1. A low nibble's carry stays in CY until the next high nibble's ADD picks it up
        RDR
        JCN  AZ, hz
hnz:    ADD  R0            ; high: R0 + high + the pending carry
        XCH  R0
        CLC
        RDR
lo:     ADD  R1
        XCH  R1            ; CY = the carry into R0, pending
        RDR
        JCN  AN, hnz
hz:     ADD  R0            ; high nibble 0 (A = 0): just the pending carry
        XCH  R0
        CLC
        RDR
        JCN  AN, lo        ; a low 0 too is the end
        LD   R0
        WRR
        LD   R1
        WRR
done:   JUN  done
`,

  running_max: `; max in R0:R1. CY = 0 at next on every path, so SUB R0 there subtracts exactly
        JUN  next
hc:     SUB  R0            ; A = h − R0, CY = 1: h ≥ R0
        JCN  C0, keep      ; h < R0: the max stays
        JCN  AZ, eq        ; same high nibble: compare the lows
        CLC
        ADD  R0            ; h > R0: h back, the word is the new max
        XCH  R0
        RDR
        XCH  R1
        JUN  out
eq:     RDR
eqc:    CLC
        SUB  R1            ; A = l − R1, CY = 1: l ≥ R1
        JCN  C0, out
        CLC
        ADD  R1            ; l back
        XCH  R1
        JUN  out
keep:   RDR                ; the low nibble does not matter
out:    LD   R0
        WRR
        LD   R1
        WRR
next:   RDR
        JCN  AN, hc
        RDR                ; high nibble 0: a low 0 is the end
        JCN  AZ, done
        XCH  R2
        LD   R0
        JCN  AN, out       ; R0 > 0: the max stays
        LD   R2
        JUN  eqc
done:   JUN  done
`,

  odd_only: `; RAR puts bit 0 in CY; RAL puts it back. CY = 0 on entry to every RAR
        JUN  next
odd:    RAL                ; A = l again, CY = 0
        XCH  R1
        LD   R0
        WRR
        LD   R1
        WRR
next:   RDR
        XCH  R0            ; R0 = high nibble
        RDR
        RAR                ; CY = bit 0, A = l >> 1
        JCN  C1, odd
        JCN  AN, next      ; even and l ≥ 2: not the end
        LD   R0
        JCN  AN, next      ; l = 0: the end only if the high nibble is 0
done:   JUN  done
`,

  popcount: `; a 16-entry table of BBL n: JMS lut jumps (JIN) to entry R15 and returns A = the ones in R15
        FIM  P7, 0x10      ; R14 = the table's page (0x10)
next:   RDR
        JCN  AN, hnz
hz:     RDR                ; high nibble 0: a low 0 is the end
        JCN  AZ, done
        XCH  R15
        LDM  0
        WRR                ; count < 16: high nibble 0
        JMS  lut
        WRR
        JUN  next
lut:    JIN  P7
done:   JUN  done
        .org 0x10
        BBL  0             ; 0000
        BBL  1
        BBL  1
        BBL  2
        BBL  1
        BBL  2
        BBL  2
        BBL  3
        BBL  1
        BBL  2
        BBL  2
        BBL  3
        BBL  2
        BBL  3
        BBL  3
        BBL  4             ; 1111
hnz:    XCH  R15
        JMS  lut
        XCH  R2            ; R2 = ones in the high nibble, A = 0 (R2 is 0 between words)
        WRR
        RDR
        XCH  R15
        JMS  lut
        ADD  R2            ; CY = 0 always
        WRR
        LDM  0
        XCH  R2            ; R2 = 0 again
        RDR
        JCN  AN, hnz
        JUN  hz
`,

  multiply: `; shift and add, a nibble of b at a time: CY:R4:R5:R6 >> 1 per bit, adding a = R0:R1 to R4:R5 first when
; R6's low bit is 1. After four bits R6 holds a product nibble. Product = R4 R5 R6 R7
        RDR
        XCH  R0
        RDR
        XCH  R1
        RDR
        XCH  R2            ; b high, for later
        RDR
        XCH  R6            ; b low first
        JMS  four
        LD   R2
        XCH  R6            ; R6 = b high, A = product bits 3–0
        XCH  R7
        JMS  four
        LD   R4
        WRR
        LD   R5
        WRR
        LD   R6
        WRR
        LD   R7
        WRR
done:   JUN  done

four:   LDM  12            ; R3 counts 12 … 15: four steps
        XCH  R3
step:   LD   R6
        RAR                ; CY = the multiplier's next bit
        JCN  C0, shift
        CLC
        LD   R5            ; R4:R5 += a, CY = the carry out
        ADD  R1
        XCH  R5
        LD   R4
        ADD  R0
        XCH  R4
shift:  LD   R4            ; CY:R4:R5:R6 >> 1
        RAR
        XCH  R4
        LD   R5
        RAR
        XCH  R5
        LD   R6
        RAR
        XCH  R6
        ISZ  R3, step
        BBL  0
`,

  divide: `; restoring division, a nibble of a at a time: R4:R5:R6 << 1 per bit (the remainder takes a's next bit
; from R6, R6 takes the last quotient bit from CY), then R4:R5 −= b = R2:R3 when it fits (quotient bit 1)
        RDR
        XCH  R6            ; a high first
        RDR
        XCH  R9            ; a low, for later
        RDR
        XCH  R2
        RDR
        XCH  R3
        JMS  four          ; R6 = 0 q7 q6 q5, CY = q4
        LD   R9
        XCH  R6
        XCH  R9            ; R9 = 0 q7 q6 q5, R6 = a low
        JMS  four          ; R6 = q4 q3 q2 q1, CY = q0
        LD   R6
        RAL                ; q3 q2 q1 q0, CY = q4
        XCH  R6
        LD   R9
        RAL                ; q7 q6 q5 q4
        WRR
        LD   R6
        WRR
        LD   R4            ; the remainder
        WRR
        LD   R5
        WRR
done:   JUN  done

four:   LDM  12            ; R7 counts 12 … 15: four steps
        XCH  R7
step:   LD   R6            ; CY:R4:R5:R6 << 1, CY in = the last quotient bit
        RAL
        XCH  R6
        LD   R5
        RAL
        XCH  R5
        LD   R4
        RAL
        XCH  R4            ; CY = the remainder's 9th bit
        JCN  C1, big
        LD   R5            ; trial R4:R5 − b (CY = 0)
        SUB  R3
        XCH  R8
        CMC
        LD   R4
        SUB  R2            ; CY = 1: no borrow, it fits
        JCN  C0, next      ; quotient bit 0 (CY = 0)
        XCH  R4
        LD   R8
        XCH  R5            ; quotient bit 1 (CY = 1)
next:   ISZ  R7, step
        BBL  0
big:    CLC                ; ≥ 256 > b: subtract for sure
        LD   R5
        SUB  R3
        XCH  R5
        CMC
        LD   R4
        SUB  R2
        XCH  R4
        STC                ; quotient bit 1
        JUN  next
`,

  // Binary GCD (Stein): plain subtraction would take 254 rounds for gcd(255, 1); halving takes 8.
  gcd: `; binary GCD: gcd(2a, 2b) = 2 gcd(a, b); with a odd, b's factors of 2 go; for a, b odd, b − a is even.
; a = R0:R1, b = R2:R3, k (common factors of 2) = R10, R11 = 0
        RDR
        XCH  R0
        RDR
        XCH  R1
        RDR
        XCH  R2
        RDR
        XCH  R3
two:    LD   R1
        RAR                ; CY = a's bit 0
        JCN  C1, strip     ; a odd
        LD   R3
        RAR
        JCN  C1, swap      ; a even, b odd: swap them
        LD   R0            ; both even (CY = 0): halve both, k + 1
        RAR
        XCH  R0
        LD   R1
        RAR
        XCH  R1
        LD   R2
        RAR
        XCH  R2
        LD   R3
        RAR
        XCH  R3
        INC  R10
        JUN  two
swap:   LD   R0
        XCH  R2
        XCH  R0
        LD   R1
        XCH  R3
        XCH  R1
strip:  LD   R3            ; a odd: halve b until it is odd
        JCN  AZ, nib
        RAR
        JCN  C1, sub
        LD   R2            ; b even (CY = 0): b >> 1
        RAR
        XCH  R2
        LD   R3
        RAR
        XCH  R3
        JUN  strip
nib:    LD   R2            ; low nibble 0: b >> 4, or b = 0: done
        JCN  AZ, fin
        XCH  R3            ; R3 = R2, A = 0 (old R3)
        XCH  R2            ; R2 = 0
        JUN  strip
sub:    CMC                ; both odd (CY = 1 → 0): b −= a
        LD   R3
        SUB  R1
        XCH  R3
        CMC
        LD   R2
        SUB  R0
        XCH  R2
        JCN  C1, strip     ; b ≥ a: b − a, even
        LD   R1            ; b < a (d = b − a < 0, CY = 0): a += d is the old b
        ADD  R3
        XCH  R1
        LD   R0
        ADD  R2
        XCH  R0
        LD   R3            ; b = −d = a − old b
        CMA
        IAC
        XCH  R3
        LD   R2
        CMA
        ADD  R11           ; + the carry
        XCH  R2
        JUN  strip
fin:    LD   R10           ; gcd = a · 2^k
        JCN  AZ, out
        DAC
        XCH  R10
        CLC
        LD   R1
        RAL
        XCH  R1
        LD   R0
        RAL
        XCH  R0
        JUN  fin
out:    LD   R0
        WRR
        LD   R1
        WRR
done:   JUN  done
`,

  fibonacci: `; a = R0:R1, b = R2:R3, unrolled twice so neither is copied: write a, a += b, write b, b += a
        RDR                ; n's high nibble (0: n ≤ 13)
        RDR
        CMA
        IAC
        XCH  R15           ; R15 = −n: ISZ after each word
        FIM  P0, 1
        FIM  P1, 1
loop:   LD   R0
        WRR
        LD   R1
        WRR
        ISZ  R15, adda
done:   JUN  done
adda:   ADD  R3            ; A = a low (CY = 0: no sum written overflows)
        XCH  R1
        LD   R0
        ADD  R2
        XCH  R0
        LD   R2
        WRR
        LD   R3
        WRR
        ISZ  R15, addb
done2:  JUN  done2
addb:   ADD  R1
        XCH  R3
        LD   R2
        ADD  R0
        XCH  R2
        JUN  loop
`,

  decimal: `; hundreds by trial subtraction (adding −200, −100: CY = 1 when it fits), then n = 16h + l < 100 in
; decimal: DAA turns l into units and a ten, and each of the h sixteens adds 6 units and 1 ten
        RDR
        XCH  R0
        RDR
        XCH  R1            ; n = R0:R1
        FIM  P1, 0x38      ; −200
        FIM  P2, 0x9C      ; −100
        LD   R1            ; (CY = 0)
        ADD  R3
        XCH  R8
        LD   R0
        ADD  R2
        JCN  C1, h2        ; n ≥ 200
        LD   R1
        ADD  R5
        XCH  R8
        LD   R0
        ADD  R4
        JCN  C0, tens      ; n < 100: no hundreds digit
        XCH  R0
        LDM  1
com:    XCH  R12           ; R12 = the hundreds digit (≠ 0: the tens digit is written too)
        LD   R8
        XCH  R1            ; n −= 100 or 200
        CLC
        LDM  3             ; ASCII '0' + d: nibbles 3, d
        WRR
        LD   R12
        WRR
tens:   LD   R1
        DAA                ; units, CY = a ten
        XCH  R7
        TCC
        XCH  R6            ; tens, CY = 0
        LD   R0
        JCN  AZ, out
        CMA
        IAC
        XCH  R0            ; R0 = −h: ISZ counts the sixteens
add16:  LDM  6
        ADD  R7
        DAA
        XCH  R7            ; units + 6, CY = a ten
        LDM  1
        ADD  R6
        XCH  R6            ; tens + 1 + the ten, CY = 0
        ISZ  R0, add16
out:    LD   R6
        JCN  AN, pt
        LD   R12
        JCN  AZ, pu        ; no hundreds and no tens: units only
pt:     LDM  3
        WRR
        LD   R6
        WRR
pu:     LDM  3
        WRR
        LD   R7
        WRR
done:   JUN  done
h2:     XCH  R0
        LDM  2
        JUN  com
`,
};
