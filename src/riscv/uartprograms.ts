// Chapter 43's programs for the computer with a UART (lib/soc.ts busComputer({ uart: true })): the UART at 0x3000_0000
// (data +0, status +4 [bit 0 rx not empty, bit 1 tx full, bit 2 tx idle, bit 3 framing error, bit 4 overrun],
// divisor +8, interrupt enables +12), the keyboard at 0x6000_0000, the console at 0x8000_0000. Assembly for riscv/asm.ts.

/** The UART's base address and register offsets. */
export const UART_BASE = 0x30000000;
export const UART_REGS = { data: 0, status: 4, divisor: 8, enable: 12 } as const;

const PRELUDE = (div: number) => `        li   s0, 0x80000000     # console
        li   s1, 0x30000000     # UART: data +0, status +4, divisor +8, enables +12
        li   s2, 0x60000000     # keyboard: key +0, status +4
        li   t0, ${div}
        sw   t0, 8(s1)          # bit rate = clock / (16 · divisor)`;

/** Poll: say hello, then print every byte that arrives (a loop on the status register). */
export const uartPollSource = (div: number): string => `# poll: send "Hi", then echo each received byte to the console
${PRELUDE(div)}
        li   a0, 72             # H
        sw   a0, 0(s1)
        li   a0, 105            # i
        sw   a0, 0(s1)
poll:   lw   t0, 4(s1)          # status
        andi t0, t0, 1          # rx not empty?
        beqz t0, poll
        lw   a0, 0(s1)          # take the byte
        sw   a0, 0(s0)          # print it
        j    poll`;

/** Interrupt: the same echo, in a handler; the main loop is free (it counts in s5). */
export const uartIrqSource = (div: number): string => `# interrupt: each received byte is echoed by a handler; main counts
        la   t0, handler
        csrw mtvec, t0
${PRELUDE(div)}
        li   a0, 72
        sw   a0, 0(s1)
        li   a0, 105
        sw   a0, 0(s1)
        li   t0, 1
        sw   t0, 12(s1)         # interrupt when the receive FIFO is not empty
        li   t0, 0x800
        csrs mie, t0            # the external interrupt
        csrsi mstatus, 8        # interrupts on
        li   s5, 0
main:   addi s5, s5, 1          # the work the CPU is free to do
        j    main
handler: lw  s3, 4(s1)          # s3, s4 belong to the handler
        andi s3, s3, 1
        beqz s3, out
        lw   s4, 0(s1)
        sw   s4, 0(s0)
        j    handler
out:    mret`;

/** Chat: keys typed go out on the UART, bytes received go to the console. Polled, or the receive side by interrupt. */
export const uartChatSource = (div: number, irq = false): string => `# chat: keyboard to UART, UART to console${irq ? ' (receive by interrupt)' : ''}
${irq ? `        la   t0, handler
        csrw mtvec, t0
` : ''}${PRELUDE(div)}
${irq ? `        li   t0, 1
        sw   t0, 12(s1)
        li   t0, 0x800
        csrs mie, t0
        csrsi mstatus, 8
` : ''}loop:   lw   t0, 4(s2)          # a key waiting?
        andi t0, t0, 1
        beqz t0, ${irq ? 'loop' : 'rx'}
        lw   a0, 0(s2)          # take it
full:   lw   t1, 4(s1)          # transmit FIFO full?
        andi t1, t1, 2
        bnez t1, full
        sw   a0, 0(s1)          # send it
${irq ? `        j    loop
handler: lw  s3, 4(s1)
        andi s3, s3, 1
        beqz s3, out
        lw   s4, 0(s1)
        sw   s4, 0(s0)
        j    handler
out:    mret` : `rx:     lw   t0, 4(s1)
        andi t0, t0, 1
        beqz t0, loop
        lw   a0, 0(s1)
        sw   a0, 0(s0)
        j    loop`}`;

/** Cost experiment, polled: receive n bytes (the status loop), summing them in s6; s7 = 1 when done. */
export const uartCostPoll = (div: number, n: number): string => `# receive ${n} bytes by polling
${PRELUDE(div)}
        li   s6, 0
        li   s8, ${n}
poll:   lw   t0, 4(s1)
        andi t0, t0, 1
        beqz t0, poll
        lw   a0, 0(s1)
        add  s6, s6, a0
        addi s8, s8, -1
        bnez s8, poll
        li   s7, 1
done:   j    done`;

/** Cost experiment, interrupt: the same bytes, summed in a handler; main counts s5 until s8 reaches 0. */
export const uartCostIrq = (div: number, n: number): string => `# receive ${n} bytes by interrupt
        la   t0, handler
        csrw mtvec, t0
${PRELUDE(div)}
        li   s6, 0
        li   s8, ${n}
        li   s5, 0
        li   t0, 1
        sw   t0, 12(s1)
        li   t0, 0x800
        csrs mie, t0
        csrsi mstatus, 8
main:   addi s5, s5, 1
        bnez s8, main
        li   s7, 1
done:   j    done
handler: lw  s3, 4(s1)
        andi s3, s3, 1
        beqz s3, out
        lw   s4, 0(s1)
        add  s6, s6, s4
        addi s8, s8, -1
        j    handler
out:    mret`;
