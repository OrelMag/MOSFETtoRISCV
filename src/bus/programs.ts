// Chapter 35's programs: a boot ROM that copies a program from flash into RAM by DMA and jumps to it, and
// the program it copies (it runs from RAM at 0x400 and prints on the console).

/** Where the boot ROM puts the program, and how many words it copies. */
export const LOAD_AT = 0x400, LOAD_WORDS = 16;

/** The boot ROM for a payload of n words. */
export const bootSource = (n: number) => `# boot ROM: copy ${n} words from flash (0x1000_0000) to RAM ${'0x' + LOAD_AT.toString(16)} by DMA, wait, jump
        li   t0, 0x40000000     # the DMA's registers
        li   t1, 0x10000000
        sw   t1, 0(t0)          # source: the flash
        li   t1, ${LOAD_AT}
        sw   t1, 4(t0)          # destination: RAM
        li   t1, ${n}
        sw   t1, 8(t0)          # length in words
        li   t1, 1
        sw   t1, 12(t0)         # go
wait:   lw   t1, 12(t0)         # status: bit 1 = done
        andi t1, t1, 2
        beqz t1, wait
        li   t1, ${LOAD_AT}
        jr   t1                 # run what was loaded`;

export const BOOT_SOURCE = bootSource(LOAD_WORDS);

export const PAYLOAD_SOURCE = `# loaded from flash, runs from RAM: say hello, then count on the LEDs
        li   t0, 0x80000000     # console
        li   t1, 72             # H
        sw   t1, 0(t0)
        li   t1, 105            # i
        sw   t1, 0(t0)
        li   t1, 10
        sw   t1, 0(t0)
        li   a0, 0
loop:   addi a0, a0, 1
        sw   a0, 4(t0)          # LEDs
        j    loop`;

/** The payload of the computer with every slave, and the words its boot ROM copies (four flash pages). */
export const SYSTEM_WORDS = 64;

export const SYSTEM_SOURCE = `# loaded from flash, runs from RAM: each key typed goes to the console, into a line kept in DRAM, and
# onto the screen as an 8 × 8 block of its colour; Enter prints the line back from DRAM, last key first
        li   s0, 0x80000000     # console
        li   s1, 0x20000000     # DRAM: the line typed so far, a word a key
        li   s2, 0x50000000     # screen: 64 × 64, a byte a pixel (RGB332)
        li   s3, 0x60000000     # I/O port: keyboard +0 the oldest key (reading takes it), +4 status; timer +8, +12
        li   s4, 0              # keys in the line
        li   s5, 0              # the next cell on the screen (8 × 8 of them)
        j    prompt
wait:   lw   t0, 4(s3)          # a key waiting?
        andi t0, t0, 1
        beqz t0, wait
        lw   a0, 0(s3)          # take it
        sw   a0, 0(s0)          # echo it
        li   t0, 10
        beq  a0, t0, enter
        slli t1, s4, 2
        add  t1, s1, t1
        sw   a0, 0(t1)          # append it to the line, in DRAM
        addi s4, s4, 1
        andi t1, s5, 7          # its cell: column (s5 mod 8) · 8 pixels
        slli t1, t1, 3
        srli t2, s5, 3          # row (s5 / 8) · 8 lines of 64 bytes
        slli t2, t2, 9
        add  t1, t1, t2
        add  t1, s2, t1
        slli t2, a0, 8          # the key's code as a colour, in four bytes
        or   t2, t2, a0
        slli t3, t2, 16
        or   t2, t2, t3
        li   t3, 8
block:  sw   t2, 0(t1)          # 8 pixels: two words a line
        sw   t2, 4(t1)
        addi t1, t1, 64
        addi t3, t3, -1
        bnez t3, block
        addi s5, s5, 1
        andi s5, s5, 63
        j    wait
enter:  beqz s4, prompt
back:   addi s4, s4, -1         # the line back from DRAM, last key first
        slli t1, s4, 2
        add  t1, s1, t1
        lw   t0, 0(t1)
        sw   t0, 0(s0)
        bnez s4, back
        li   t0, 10
        sw   t0, 0(s0)
prompt: li   t0, 62             # '>'
        sw   t0, 0(s0)
        j    wait`;

/** The sandbox's System on a bus (editor/examplebus.ts): the words its boot ROM copies from the flash. */
export const SANDBOX_WORDS = 96;

export const SANDBOX_SOURCE = `# loaded from flash, runs from RAM at 0x400. The timer interrupts every 1000 cycles and the LEDs count
# its ticks. Each key typed is echoed on the console, kept in a line in DRAM and drawn on the screen as a
# 6 × 6 block of its colour; Enter prints the line back from DRAM, last key first.
        li   s0, 0x80000000     # console (+0), LEDs (+4)
        li   s1, 0x20000000     # DRAM: the line, a word a key
        li   s2, 0x50000000     # screen: pixel (x, y) at + 256·y + 4·x, its colour the low byte
        li   s3, 0x60000000     # I/O port: keyboard +0 the oldest key (reading takes it), +4 status; timer +8, +12
        li   s4, 0              # keys in the line
        li   s5, 0              # the next cell (8 × 8 cells of 8 pixels)
        li   s9, 0              # timer ticks
        la   t0, handler
        csrw mtvec, t0
        li   t0, 0x800          # the external interrupt: the timer's, or the DMA's
        csrs mie, t0
        csrsi mstatus, 8
        j    prompt
wait:   lw   t0, 4(s3)          # a key waiting?
        andi t0, t0, 1
        beqz t0, wait
        lw   a0, 0(s3)          # take it
        sw   a0, 0(s0)          # echo it
        li   t0, 10
        beq  a0, t0, enter
        slli t1, s4, 2
        add  t1, s1, t1
        sw   a0, 0(t1)          # append it to the line, in DRAM
        addi s4, s4, 1
        andi t1, s5, 7          # its cell: column · 8 pixels · 4 bytes
        slli t1, t1, 5
        srli t2, s5, 3          # row · 8 lines · 256 bytes
        slli t2, t2, 11
        add  t1, t1, t2
        add  t1, s2, t1
        li   t3, 6
block:  sw   a0, 0(t1)          # 6 pixels a line, a store each
        sw   a0, 4(t1)
        sw   a0, 8(t1)
        sw   a0, 12(t1)
        sw   a0, 16(t1)
        sw   a0, 20(t1)
        addi t1, t1, 256
        addi t3, t3, -1
        bnez t3, block
        addi s5, s5, 1
        andi s5, s5, 63
        j    wait
enter:  beqz s4, prompt
back:   addi s4, s4, -1         # the line back from DRAM, last key first
        slli t1, s4, 2
        add  t1, s1, t1
        lw   t0, 0(t1)
        sw   t0, 0(s0)
        bnez s4, back
        li   t0, 10
        sw   t0, 0(s0)
prompt: li   t0, 62             # '>'
        sw   t0, 0(s0)
        j    wait
# the interrupt: its own registers (s6, s7), so the program never notices it
handler: li  s6, 0x40000000
        li   s7, 2
        sw   s7, 12(s6)         # clear the DMA's done (still up from the boot's copy)
        lw   s7, 12(s3)         # the timer's irq (the I/O port: +8 its count, +12 its irq)?
        beqz s7, out
        lw   s7, 8(s3)          # reading its count acknowledges it
        addi s9, s9, 1
        sw   s9, 4(s0)          # the LEDs count the ticks
out:    mret`;

// ---- booting from punched cards (chapter 35's card reader at 0x7000_0000) -------------------------------

/** The card reader's registers: STATUS (bit 0 a card waits, bit 1 the hopper is empty), DATA at +4. */
export const CARD_BASE = 0x70000000;

/**
 * Clock edges between taking a card and the next one at the read station. A real reader took ~75 ms a card (the
 * IBM 2540 read 800 a minute): millions of cycles of a CPU like this one; 8 keeps the wait visible but short.
 */
export const CARD_FEED = 8;

/** The card boot ROM: what the IBM 1401's Load key did in hardware, read cards into memory until the hopper is empty, then run them. */
export const CARD_BOOT_SOURCE = `# boot ROM: read the deck word by word into RAM at ${'0x' + LOAD_AT.toString(16)}, then jump there
boot:   li   s0, 0x${CARD_BASE.toString(16)}     # card reader: STATUS +0, DATA +4
        li   s1, 0x${LOAD_AT.toString(16)}          # RAM address
next:   lw   t0, 0(s0)          # bit 0 card ready, bit 1 hopper empty
        andi t1, t0, 2
        bnez t1, run
        andi t0, t0, 1
        beqz t0, next
        lw   t0, 4(s0)          # the word; the reader feeds the next card
        sw   t0, 0(s1)
        addi s1, s1, 4
        j    next
run:    li   t0, 0x${LOAD_AT.toString(16)}
        jr   t0                 # the loaded program`;

/** The program on the cards: runs from RAM, prints CARDS, then counts on the LEDs. */
export const CARD_PAYLOAD_SOURCE = `# punched on cards, a word a card; runs from RAM at ${'0x' + LOAD_AT.toString(16)}
        li   t0, 0x80000000     # console
        li   t1, 67             # C
        sw   t1, 0(t0)
        li   t1, 65             # A
        sw   t1, 0(t0)
        li   t1, 82             # R
        sw   t1, 0(t0)
        li   t1, 68             # D
        sw   t1, 0(t0)
        li   t1, 83             # S
        sw   t1, 0(t0)
        li   t1, 10
        sw   t1, 0(t0)
        li   a0, 0
loop:   addi a0, a0, 1
        sw   a0, 4(t0)          # LEDs
        j    loop`;
