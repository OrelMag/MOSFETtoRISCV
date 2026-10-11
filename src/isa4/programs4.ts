// Sample programs for the 4-bit CPU (the sandbox's ROM samples and the example's program). Ports:
// 0–3 the four digits (left to right), 4 the LEDs; RDR reads the switches; TEST is the Space key.

export interface Program4 { id: string; name: string; src: string }

export const BCD4 = `; BCD addition, the 4004's calculator job: 1234 + 5876 = 7110 on the four digits
        FIM  P0, 0x12      ; R0 R1 R2 R3 = 1 2 3 4
        FIM  P1, 0x34
        FIM  P4, 0x58      ; R8 R9 R10 R11 = 5 8 7 6
        FIM  P5, 0x76
        CLB                ; A = 0, CY = 0
        LD   R3            ; ones
        ADD  R11
        DAA                ; past 9: + 6 and a carry
        XCH  R3
        LD   R2            ; tens, with the carry
        ADD  R10
        DAA
        XCH  R2
        LD   R1            ; hundreds
        ADD  R9
        DAA
        XCH  R1
        LD   R0            ; thousands
        ADD  R8
        DAA
        XCH  R0
show:   FIM  P7, 0x00      ; port 0: the leftmost digit
        SRC  P7
        LD   R0
        WRR
        FIM  P7, 0x10
        SRC  P7
        LD   R1
        WRR
        FIM  P7, 0x20
        SRC  P7
        LD   R2
        WRR
        FIM  P7, 0x30
        SRC  P7
        LD   R3
        WRR
done:   JUN  done          ; the halt part stops Run here`;

export const COUNTER4 = `; Count on the LEDs, with an ISZ delay loop between steps (Run; never halts)
        FIM  P7, 0x40      ; port 4: the LEDs
        SRC  P7
        CLB
loop:   IAC                ; A = A + 1 (15 wraps to 0)
        WRR                ; show it
        FIM  P0, 0x00      ; delay: R1 counts 16 steps, R0 counts those 16 times
wait:   ISZ  R1, wait
        ISZ  R0, wait
        JUN  loop`;

export const SWITCHES4 = `; The switches + 1 on the LEDs, the carry on the rightmost digit (flip them while it runs)
        FIM  P6, 0x40      ; P6: the LED port
        FIM  P7, 0x30      ; P7: the rightmost digit
loop:   RDR                ; A = switches
        IAC                ; + 1, a carry on 15 + 1
        SRC  P6
        WRR                ; LEDs = switches + 1
        TCC                ; A = the carry, CY = 0
        SRC  P7
        WRR
        JUN  loop`;

export const MULTIPLY4 = `; A subroutine: R0:R1 = R2 × R3 by repeated addition (JMS / BBL); 7 × 9 = 0x3F on the right two digits
        FIM  P1, 0x79      ; R2 = 7, R3 = 9
        JMS  mul
        FIM  P7, 0x20      ; digit 2: the high nibble
        SRC  P7
        LD   R0
        WRR
        FIM  P7, 0x30      ; digit 3: the low nibble
        SRC  P7
        LD   R1
        WRR
done:   JUN  done

mul:    FIM  P0, 0x00      ; R0:R1 = 0
        CLB
        SUB  R3            ; A = 16 - R3 (R3 > 0): ISZ counts R4 up to 0, R3 times
        XCH  R4
again:  LD   R1            ; low nibble += R2
        CLC
        ADD  R2
        XCH  R1
        TCC                ; A = the carry, CY = 0
        ADD  R0            ; high nibble += the carry
        XCH  R0
        ISZ  R4, again
        BBL  0             ; return, A = 0`;

export const TEST4 = `; Count presses of the TEST key (Space) in decimal on the rightmost digit
        FIM  P7, 0x30
        SRC  P7
        CLB
        WRR
up:     JCN  TZ, up        ; wait while TEST = 0 (key up)
        IAC                ; pressed: count it
        DAA                ; 9 + 1 = 10 → 0, the decimal way
        WRR
down:   JCN  TN, down      ; wait while TEST = 1 (key held)
        JUN  up`;

export const PROGRAMS4: Program4[] = [
  { id: 'cpu4bcd', name: '4-bit: BCD addition', src: BCD4 },
  { id: 'cpu4count', name: '4-bit: counter on the LEDs', src: COUNTER4 },
  { id: 'cpu4sw', name: '4-bit: switches + 1', src: SWITCHES4 },
  { id: 'cpu4mul', name: '4-bit: multiply subroutine', src: MULTIPLY4 },
  { id: 'cpu4test', name: '4-bit: count TEST presses', src: TEST4 },
];
