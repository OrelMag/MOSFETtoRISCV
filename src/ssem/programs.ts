// Programs for the Baby.
//
// KILBURN: "Kilburn Highest Factor Routine (amended)", G. C. Tootill's notebook, 18 July 1948, reproduced on the
// University of Manchester's Computer50 site (mark1/firstprog.html). Line for line as the notebook has it: lines 1–19
// the instructions, 20–24 constants, 25–27 working lines (r, −b, b). The 17-instruction program of 21 June 1948 is lost;
// this is the amended version, two instructions longer so it can be rerun on the same number. It finds the highest
// proper factor of a by trying every b downward from a − 1 and dividing by repeated subtraction (the Baby had only a
// subtractor). Line 22 holds 4 ("or 10100", 5, pencilled beside it); the run starts from CI = 0, so line 1 comes first.

export const kilburnSource = (a = 2 ** 18): string => `; Kilburn's highest factor routine (amended), Tootill's notebook, 18 July 1948
1:  LDN 24   ; -24 to C      C = -(a - 1)
    STO 26   ; c to 26       line 26 = -b
    LDN 26   ; -26 to C      C = b
    STO 27   ; c to 27       line 27 = b
5:  LDN 23   ; -23 to C      C = a
    SUB 27   ; Sub 27        C = C - b
    CMP      ; Test          skip if C < 0
    JRP 20   ; Add 20 to Cl  back to line 6
    SUB 26   ; Sub 26        C = C + b: the remainder r
    STO 25   ; c to 25
    LDN 25   ; -25 to C      C = -r
    CMP      ; Test          skip if C < 0, i.e. r > 0
    STP      ; Stop          r = 0: b divides a, and line 27 holds it
    LDN 26   ; -26 to C      C = b
    SUB 21   ; Sub 21        C = b - 1
    STO 27   ; c to 27
    LDN 27   ; -27 to C
    STO 26   ; c to 26       line 26 = -(b - 1)
    JMP 22   ; 22 to Cl      CI = 4: on to line 5
20: NUM -3   ; the relative jump back from line 8 to line 6 (CI + 1 after it)
21: NUM 1
22: NUM 4
23: NUM ${-a} ; -a
24: NUM ${a - 1} ; a - 1, the first b
`;

/** The answer line and the number tried: line 27 holds b when the machine stops. */
export const KILBURN_ANSWER_LINE = 27;

/**
 * Multiplication by repeated subtraction, for the appendix's "Your own program": line 31 = x × y. The Baby has no adder,
 * so t + x is −(−t − x): LDN, SUB, STO, LDN, STO. The counter c runs from −y up to 0 the same way, and CMP skips the Stop
 * while it is still negative. JMP 26 jumps to the line after the number line 26 holds (0): line 1.
 */
export const timesSource = (x = 7, y = 6): string => `; line 31 = x × y by repeated subtraction
1:  LDN 31   ; A = -t
    SUB 30   ; A = -t - x
    STO 27
    LDN 27   ; A = t + x
    STO 31   ; t = t + x
    LDN 29   ; A = -c
    SUB 28   ; A = -c - 1
    STO 27
    LDN 27   ; A = c + 1
    STO 29   ; c = c + 1
    CMP      ; still negative: skip the Stop
    STP
    JMP 26   ; CI = 0: on to line 1
26: NUM 0
28: NUM 1
29: NUM ${-y} ; c, counting up to 0
30: NUM ${x} ; x
31: NUM 0    ; t, the product
`;
