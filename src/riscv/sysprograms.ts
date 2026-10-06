// Programs for the complete system CPU: I/O, traps and interrupts.
// Memory map: 0x8000_0000 console (write a byte), 0x8000_0004 LEDs, 0x8000_0008 switches,
// 0x8000_0010 mtime (cycles), 0x8000_0014 mtimecmp.

import type { Program } from './programs';

export const SYSTEM_PROGRAMS: Program[] = [
  {
    id: 'hello',
    name: 'Hello over MMIO',
    blurb: 'Writes a string to the memory-mapped console, one byte store per character.',
    source: `# print a string by storing bytes to the console register
        li   a0, 0x80000000    # console
        li   t0, 'H'
        sb   t0, 0(a0)
        li   t0, 'e'
        sb   t0, 0(a0)
        li   t0, 'l'
        sb   t0, 0(a0)
        sb   t0, 0(a0)
        li   t0, 'o'
        sb   t0, 0(a0)
        li   t0, ','
        sb   t0, 0(a0)
        li   t0, ' '
        sb   t0, 0(a0)
        li   t0, 'R'
        sb   t0, 0(a0)
        li   t0, 'I'
        sb   t0, 0(a0)
        li   t0, 'S'
        sb   t0, 0(a0)
        li   t0, 'C'
        sb   t0, 0(a0)
        li   t0, '-'
        sb   t0, 0(a0)
        li   t0, 'V'
        sb   t0, 0(a0)
        li   t0, '!'
        sb   t0, 0(a0)
        li   t0, 10
        sb   t0, 0(a0)
halt:   j    halt`,
  },
  {
    id: 'bytes',
    name: 'Bytes and halfwords',
    blurb: 'Every load and store width, signed and unsigned, on the byte-banked data memory.',
    source: `        li   t0, 0x12345678
        sw   t0, 0(zero)
        li   t1, 0xAB
        sb   t1, 1(zero)        # word 0 = 0x1234AB78
        li   t1, -2
        sh   t1, 6(zero)        # word 1 = 0xFFFE0000
        lb   a0, 1(zero)        # 0xFFFFFFAB (sign-extended)
        lbu  a1, 1(zero)        # 0x000000AB
        lh   a2, 6(zero)        # 0xFFFFFFFE
        lhu  a3, 6(zero)        # 0x0000FFFE
        lw   a4, 0(zero)        # 0x1234AB78
        lb   a5, 3(zero)        # 0x00000012
halt:   j    halt`,
  },
  {
    id: 'leds',
    name: 'Switches to LEDs',
    blurb: 'Copies the switches to the LEDs, forever. Flip the switches in the input bar.',
    source: `        li   a0, 0x80000000
loop:   lw   t0, 8(a0)         # switches
        not  t1, t0
        andi t1, t1, 0xff
        sw   t0, 4(a0)         # LEDs = switches
        j    loop`,
  },
  {
    id: 'syscall',
    name: 'ecall: a tiny OS',
    blurb: 'The program asks the "operating system" (a trap handler) to print characters via ecall.',
    source: `# main program: put a character in a0, ecall
        la   t0, handler
        csrw mtvec, t0
        li   a0, 'O'
        ecall
        li   a0, 'K'
        ecall
        li   a0, 10
        ecall
halt:   j    halt

# trap handler: print a0, skip the ecall, return
handler:
        li   t1, 0x80000000
        sb   a0, 0(t1)
        csrr t2, mepc
        addi t2, t2, 4
        csrw mepc, t2
        mret`,
  },
  {
    id: 'timer',
    name: 'Timer interrupt',
    blurb: 'The main loop counts; every 40 cycles the timer interrupts it and the handler prints a dot.',
    source: `        la   t0, handler
        csrw mtvec, t0
        li   a0, 0x80000000
        lw   t1, 16(a0)        # mtime
        addi t1, t1, 40
        sw   t1, 20(a0)        # mtimecmp = now + 40
        li   t0, 0x80
        csrs mie, t0           # enable the timer interrupt
        csrsi mstatus, 8       # global interrupt enable
loop:   addi s0, s0, 1         # main program: just count
        j    loop

handler:
        li   t2, '.'
        sb   t2, 0(a0)
        lw   t1, 20(a0)
        addi t1, t1, 40
        sw   t1, 20(a0)        # next tick
        addi s1, s1, 1         # ticks
        mret`,
  },
  {
    id: 'irq',
    name: 'External interrupt',
    blurb: 'Press the IRQ button: the handler toggles the LEDs and counts presses.',
    source: `        la   t0, handler
        csrw mtvec, t0
        li   a0, 0x80000000
        li   t0, 0x800
        csrs mie, t0           # enable the external interrupt
        csrsi mstatus, 8
loop:   addi s0, s0, 1
        j    loop

handler:
        lw   t1, 4(a0)
        xori t1, t1, 0xff
        sw   t1, 4(a0)         # toggle the LEDs
        addi s1, s1, 1         # presses
        mret`,
  },
  {
    id: 'faults',
    name: 'Exceptions',
    blurb: 'An illegal instruction, a misaligned load and an ebreak, each caught by the handler, which logs mcause and mtval.',
    source: `        la   t0, handler
        csrw mtvec, t0
        li   s0, 0             # log pointer
        .word 0xFFFFFFFF       # illegal instruction
        li   t1, 2
        lw   t2, 1(t1)         # misaligned load (address 3)
        ebreak
halt:   j    halt

handler:
        csrr t3, mcause
        sw   t3, 0(s0)
        csrr t3, mtval
        sw   t3, 4(s0)
        addi s0, s0, 8
        csrr t3, mepc
        addi t3, t3, 4
        csrw mepc, t3
        mret`,
  },
];
