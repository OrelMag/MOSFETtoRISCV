// Programs for the sandbox's 6502 computer (Examples ▸ 6502 computer): its memory map, and samples a
// ROM can load. Each halts on a JMP to itself (the computer's halt detector and the CPU drawer both
// stop there).

/** The computer's map: RAM $0000–$3FFF (2K, repeating), devices $4000–$7FFF, ROM $8000–$FFFF (4K, repeating). */
export const MAP6502 = { CON: 0x4000, LEDS: 0x4001, SW: 0x4002, ROM: 0xf000 } as const;

export interface SbProgram6502 { id: string; name: string; src: string }

const HEAD = `CON  = $4000           ; console: a byte stored here is printed
LEDS = $4001           ; eight LEDs: a byte stored here lights them
SW   = $4002           ; eight switches: a load reads them
*= $F000               ; the ROM answers at $8000-$FFFF; the program sits at its top
start:  ldx #$FF
        txs            ; the stack: page 1 of the RAM
        cld`;

const VECTORS = `
nmi:
irq:    rti
*= $FFFA
        .word nmi, start, irq   ; NMI, RESET, IRQ`;

export const HELLO6502 = `; 6502: a greeting on the console
${HEAD}
        ldx #0
loop:   lda msg,x
        beq done       ; the 0 at the end
        sta CON
        inx
        bne loop
done:   jmp done       ; halt
msg:    .text "Hello from the 6502!\\n"
        .byte 0
${VECTORS}
`;

export const FIB6502 = `; 6502: the Fibonacci numbers below 10000, in decimal on the console
; 16-bit additions with the carry; decimal digits by subtracting powers of ten
F0   = $00             ; F(n), low and high byte
F1   = $02             ; F(n + 1)
N    = $04             ; the number being printed
T    = $06
LEAD = $07             ; a digit was printed (no leading zeros)
${HEAD}
        lda #0
        sta F0
        sta F0+1
        sta F1+1
        lda #1
        sta F1
next:   lda F0+1       ; F0 < 10000 ($2710)?
        cmp #$27
        bcc show
        bne done
        lda F0
        cmp #$10
        bcs done
show:   lda F0
        sta N
        lda F0+1
        sta N+1
        jsr print
        lda #' '
        sta CON
        clc            ; (F0, F1) = (F1, F0 + F1)
        lda F0
        adc F1
        tax
        lda F0+1
        adc F1+1
        tay
        lda F1
        sta F0
        lda F1+1
        sta F0+1
        stx F1
        sty F1+1
        jmp next
done:   lda #10
        sta CON
halt:   jmp halt

print:  ldy #0         ; N in decimal: digit y counts how often 10^(4-y) goes into N
        sty LEAD
digit:  ldx #'0'
sub:    sec
        lda N
        sbc powlo,y
        sta T
        lda N+1
        sbc powhi,y
        bcc out        ; a borrow: this digit is done
        sta N+1
        lda T
        sta N
        inx
        bne sub
out:    cpx #'0'
        bne put
        lda LEAD
        bne put
        cpy #4         ; the last digit shows, even a 0
        bne skip
put:    stx CON
        stx LEAD
skip:   iny
        cpy #5
        bne digit
        rts
powlo:  .byte $10, $E8, $64, $0A, $01   ; 10000, 1000, 100, 10, 1
powhi:  .byte $27, $03, $00, $00, $00
${VECTORS}
`;

export const BCD6502 = `; 6502: count 00 to 99 on the LEDs in decimal mode, then halt
${HEAD}
        sed            ; decimal mode: ADC adds in BCD
        lda #0
loop:   sta LEDS
        clc
        adc #1         ; $09 + 1 = $10, $99 + 1 = $00 with the carry set
        bcc loop       ; (test the carry: the NMOS 6502's Z flag is the binary sum's in decimal mode)
        cld
halt:   jmp halt
${VECTORS}
`;

export const ECHO6502 = `; 6502: the LEDs follow the switches, forever (flip them while it runs)
${HEAD}
loop:   lda SW
        sta LEDS
        jmp loop
${VECTORS}
`;

export const SB_PROGRAMS_6502: SbProgram6502[] = [
  { id: 'm65hello', name: '6502: hello on the console', src: HELLO6502 },
  { id: 'm65fib', name: '6502: Fibonacci in decimal', src: FIB6502 },
  { id: 'm65bcd', name: '6502: BCD count on the LEDs', src: BCD6502 },
  { id: 'm65echo', name: '6502: switches to LEDs', src: ECHO6502 },
];
