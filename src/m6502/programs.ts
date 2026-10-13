// Sample 6502 programs (assembler source for src/m6502/asm.ts). Conventions: code at $0200, the vectors
// at $FFFA (NMI, RESET, IRQ), a program halts on a JMP to itself. I/O: writing $F001 outputs a byte; the
// `irq` program's device holds IRQ asserted until its handler writes $F002.

export interface Program6502 {
  name: string;
  title: string;
  description: string;
  source: string;
}

/** The output port (a byte written here is printed) and the IRQ acknowledge register. */
export const IO6502 = { OUT: 0xf001, IRQ_ACK: 0xf002 } as const;

const VECTORS = `
; ---- vectors ----
nmi:    rti
*= $FFFA
        .word nmi, start, irq`;

export const PROGRAMS: Program6502[] = [
  {
    name: 'hello',
    title: 'Hello',
    description: 'Prints "HELLO, 6502!" one byte at a time to the output port at $F001, then halts.',
    source: `OUT = $F001
*= $0200
start:  ldx #0
loop:   lda msg,x       ; next character
        beq done        ; the 0 at the end
        sta OUT
        inx
        bne loop
done:   jmp *           ; halt
msg:    .text "HELLO, 6502!"
        .byte 0
irq:${VECTORS}
`,
  },
  {
    name: 'fib',
    title: 'Fibonacci',
    description: 'The first 24 Fibonacci numbers as 16-bit words: low bytes at FIBLO ($0300), high bytes at FIBHI ($0320).',
    source: `N = 24
FIBLO = $0300
FIBHI = $0320
*= $0200
start:  lda #0
        sta FIBLO
        sta FIBHI
        sta FIBHI+1
        lda #1
        sta FIBLO+1
        ldx #2
loop:   clc             ; F(x) = F(x-2) + F(x-1), 16 bits
        lda FIBLO-2,x
        adc FIBLO-1,x
        sta FIBLO,x
        lda FIBHI-2,x
        adc FIBHI-1,x
        sta FIBHI,x
        inx
        cpx #N
        bne loop
halt:   jmp halt
irq:${VECTORS}
`,
  },
  {
    name: 'sort',
    title: 'Bubble sort',
    description: 'Sorts LEN bytes at `data` in place, ascending: passes of adjacent swaps until one swaps nothing.',
    source: `LEN = 10
*= $0200
start:  ldx #0
        stx swapped
inner:  lda data,x
        cmp data+1,x    ; C = 1 when data[x] >= data[x+1]
        bcc next
        beq next
        pha             ; swap the pair
        lda data+1,x
        sta data,x
        pla
        sta data+1,x
        lda #1
        sta swapped
next:   inx
        cpx #LEN-1
        bne inner
        lda swapped
        bne start       ; another pass
halt:   jmp halt
swapped: .byte 0
data:   .byte 42, 7, 199, 3, 88, 150, 7, 0, 255, 64
irq:${VECTORS}
`,
  },
  {
    name: 'mul',
    title: '8 × 8 multiply',
    description: 'Shift-and-add: 200 × 123 into a 16-bit product at $12 (low) / $13 (high), one multiplier bit per pass.',
    source: `MCAND  = $10
MPLIER = $11
PRODLO = $12
PRODHI = $13
*= $0200
start:  lda #200
        sta MCAND
        lda #123
        sta MPLIER
        lda #0          ; A: the product's high byte
        ldx #8
loop:   lsr MPLIER      ; next multiplier bit into C
        bcc shift
        clc
        adc MCAND       ; its carry is the product's new top bit
shift:  ror a           ; shift the product right: A, then PRODLO
        ror PRODLO
        dex
        bne loop
        sta PRODHI
halt:   jmp halt
irq:${VECTORS}
`,
  },
  {
    name: 'bcd',
    title: 'Decimal counter',
    description: 'Counts from 0 to 1234 in binary-coded decimal (SED: ADC adds decimal digits), a 4-digit counter at $10 / $11.',
    source: `COUNT = $10
*= $0200
start:  sed             ; decimal mode
        lda #0
        sta COUNT
        sta COUNT+1
loop:   clc
        lda COUNT       ; COUNT += 1, two digits per byte
        adc #1
        sta COUNT
        lda COUNT+1
        adc #0
        sta COUNT+1
        cmp #$12
        bne loop
        lda COUNT
        cmp #$34
        bne loop
        cld
halt:   jmp halt
irq:${VECTORS}
`,
  },
  {
    name: 'irq',
    title: 'Interrupts',
    description: 'Counts interrupts at $10: the IRQ handler increments the count, prints a star and acknowledges the device ($F002); the main loop stops after 5.',
    source: `OUT   = $F001
COUNT = $10
ACK   = $F002
*= $0200
start:  ldx #$FF
        txs
        lda #0
        sta COUNT
        cli             ; interrupts on
main:   lda COUNT
        cmp #5
        bne main
        sei
halt:   jmp halt
irq:    pha             ; the handler keeps A: main may be between its LDA and CMP
        inc COUNT
        lda #'*'
        sta OUT         ; a star per interrupt
        sta ACK         ; the device releases IRQ
        pla
        rti
${VECTORS}
`,
  },
];
