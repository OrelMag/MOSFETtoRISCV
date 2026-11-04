// Chapter 50's driver in RV32 assembly, for a computer with a NIC (lib/soc.ts busComputer({ nic: true })) whose transmitter is wired back to its
// receiver (loopback): initialise the rings, send one 64-byte frame to its own address, and take it in again, polling the descriptor or by the NIC's
// interrupt. The timer (mtime at 0x8000_0010) stamps each step, so the cost of every part of the path is read off the gates' own clock.
//
// Memory: rings at 0x1800 (receive) and 0x1840 (transmit), eight descriptors of two words; buffers of 1536 bytes from 0x1900 and 0x4900
// (comm/stack/layout.ts). Registers at 0x7000_0000: CTRL +0, STATUS +4 (write 1 to clear), IE +8, RXBASE +12, TXBASE +16, MACL +20, MACH +24, KICK +28.
//
// Results (read from the registers when s7 = 1):  s4 = mtime when the doorbell was rung, s5 = mtime when the CPU saw the received frame,
// s6 = polls (polling) or the main loop's count (interrupt), s8 = the length the NIC wrote, s9 = mtime at the end of the setup (before the frame is built),
// s10 = mtime when the CPU came back from ringing the doorbell, s11 = mtime when the transmit descriptor was handed back (seen after the receive).

export const NIC_BASE = 0x70000000;
export const MTIME = 0x80000010;

/** The MAC the driver gives the NIC and puts in the frame's destination: 02:00:00:00:00:0a. */
export const DRIVER_MAC = [0x02, 0x00, 0x00, 0x00, 0x00, 0x0a];

const INIT = `        li   s0, 0x80000000     # console / timer (mtime at +16)
        li   s1, 0x70000000     # the NIC
        li   s2, 0x1800         # receive ring
        li   s3, 0x1840         # transmit ring
        li   t0, 0
init:   slli t1, t0, 3          # 8 bytes a descriptor
        slli t3, t0, 9
        slli t4, t0, 10
        add  t3, t3, t4         # 1536 · i
        add  t2, s2, t1
        li   t4, 0x1900
        add  t4, t4, t3
        sw   t4, 0(t2)          # buffer address
        li   t5, 0x80000000
        sw   t5, 4(t2)          # OWN: the NIC may fill it
        add  t2, s3, t1
        li   t4, 0x4900
        add  t4, t4, t3
        sw   t4, 0(t2)
        sw   zero, 4(t2)        # the software holds it
        addi t0, t0, 1
        li   t6, 8
        blt  t0, t6, init
        sw   s2, 12(s1)         # RXBASE
        sw   s3, 16(s1)         # TXBASE
        li   t0, 0x00000002
        sw   t0, 20(s1)         # MACL: 02:00:00:00
        li   t0, 0x00000a00
        sw   t0, 24(s1)         # MACH: 00:0a
        li   t0, 1
        sw   t0, 0(s1)          # CTRL: enable
        lw   s9, 16(s0)         # setup done`;

const SEND = `        li   t0, 0x4900         # transmit buffer 0: destination = source = our address, type 0800
        li   t1, 0x00000002
        sw   t1, 0(t0)
        li   t1, 0x00020a00
        sw   t1, 4(t0)
        li   t1, 0x0a000000
        sw   t1, 8(t0)
        li   t1, 0x00000008
        sw   t1, 12(t0)
        li   t2, 4              # words 4..15: a pattern
fill:   slli t3, t2, 2
        add  t3, t3, t0
        sw   t2, 0(t3)
        addi t2, t2, 1
        li   t6, 16
        blt  t2, t6, fill
        li   t1, 0x80000040     # OWN | 64 bytes
        sw   t1, 4(s3)          # transmit descriptor 0, word 1
        lw   s4, 16(s0)         # the doorbell
        li   t1, 1
        sw   t1, 28(s1)
        lw   s10, 16(s0)`;

/** Polling: ring the doorbell and spin on the receive descriptor's OWN bit. */
export const nicPollSource = (): string => `# NIC loopback, polled
${INIT}
${SEND}
        li   s6, 0
poll:   addi s6, s6, 1
        lw   t0, 4(s2)          # receive descriptor 0, word 1
        bltz t0, poll           # OWN still set: nothing yet
        lw   s5, 16(s0)
        andi s8, t0, 0x7ff
        lw   s11, 16(s0)
        li   s7, 1
done:   j    done`;

/** Interrupt: the handler reads the length, clears the status and hands the descriptor back; main counts. */
export const nicIrqSource = (): string => `# NIC loopback, receive by interrupt
        la   t0, handler
        csrw mtvec, t0
${INIT}
        li   t0, 1
        sw   t0, 8(s1)          # IE: receive complete
        li   t0, 0x800
        csrs mie, t0
        csrsi mstatus, 8
${SEND}
        li   s6, 0
main:   addi s6, s6, 1
        beqz s7, main
done:   j    done
handler: lw  s5, 16(s0)
        li   t5, 15
        sw   t5, 4(s1)          # STATUS: clear every flag
        lw   t5, 4(s2)
        andi s8, t5, 0x7ff
        li   t5, 0x80000000
        sw   t5, 4(s2)          # give the buffer back
        li   s7, 1
        mret`;
