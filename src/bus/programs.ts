// Chapter 35's programs: a boot ROM that copies a program from flash into RAM by DMA and jumps to it, and
// the program it copies (it runs from RAM at 0x400 and prints on the console).

/** Where the boot ROM puts the program, and how many words it copies. */
export const LOAD_AT = 0x400, LOAD_WORDS = 16;

export const BOOT_SOURCE = `# boot ROM: copy ${LOAD_WORDS} words from flash (0x1000_0000) to RAM ${'0x' + LOAD_AT.toString(16)} by DMA, wait, jump
        li   t0, 0x40000000     # the DMA's registers
        li   t1, 0x10000000
        sw   t1, 0(t0)          # source: the flash
        li   t1, ${LOAD_AT}
        sw   t1, 4(t0)          # destination: RAM
        li   t1, ${LOAD_WORDS}
        sw   t1, 8(t0)          # length in words
        li   t1, 1
        sw   t1, 12(t0)         # go
wait:   lw   t1, 12(t0)         # status: bit 1 = done
        andi t1, t1, 2
        beqz t1, wait
        li   t1, ${LOAD_AT}
        jr   t1                 # run what was loaded`;

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
