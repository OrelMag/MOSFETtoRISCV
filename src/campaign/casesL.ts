// Level cases, act 12 (Links). See cases.ts. The numbers are measured on the reference designs (sim/stats, static timing, the
// benches' own models). No DOM.

import type { LevelCase } from './cases';

export const CASESL: Record<string, LevelCase> = {
  l_sync: {
    problem: 'Two clocks that are not the same crystal have every phase between them. A signal from the other domain can change within a flip-flop\'s setup-and-hold window, and then the flip-flop goes metastable: neither 0 nor 1 for a time that has no upper bound, only a probability. At 1.6 GHz with data changing at 160 MHz a window of 25 ps is hit ten million times a second.',
    without: 'With one flip-flop read by 8 NAND delays of logic, the undecided level gets 275 ps to fall to a rail and the port fails about once in 1.6 days. Different gates reading it differently is how a metastable bit becomes a wrong state in a machine.',
    cost: 'Two flip-flops, 22 NANDs and a cycle of latency buy about 2 million years. The asynchronous FIFO of chapter 42 is this two-flop synchronizer on each pointer.',
    alts: [{ name: 'Two-flop synchronizer (library)', lib: 'sync2' }, { name: 'Three-flop synchronizer (library)', lib: 'sync3' }],
  },
  l_uarttx: {
    problem: 'A serial link has no clock wire. Sender and receiver agree beforehand on a bit time, and each byte travels in a frame the receiver can find: an idle line at 1, a start bit of 0 whose falling edge says "now", eight data bits least significant first, and a stop bit of 1 that gives the line time to return to idle before the next frame. The transmitter is the shift register that produces it, paced by a tick it does not make itself.',
    without: 'Without the frame there is no way to tell where a byte starts on a line that is idle for any length of time, and without the same bit length at both ends the receiver reads the wrong bit. A transmitter that restarts on a go during a frame puts a bit of one byte and a bit of the next on the line.',
    cost: '482 NANDs: a 10-bit shift register (the frame), two 4-bit counters (ticks in the bit, bits sent) and a busy flag. At 115 200 baud a frame is 87 µs, 11 520 bytes a second: 80% of the line\'s 115 200 bits are data bits.',
  },
  l_uartrx: {
    problem: 'The sender\'s clock is a different crystal, off by up to a few percent, and its start edge lands anywhere between two of the receiver\'s ticks. A receiver that samples every bit once at its own idea of the bit time drifts across the frame. Oversampling by 16 fixes both: the start edge is found to within 1/16 of a bit, the count restarts there, and every later sample sits near the middle of its bit.',
    without: 'Sampling at the edge of a bit decides the value by noise. A receiver that does not check the start bit again in its middle turns every glitch on an idle line into a byte; one that waits for a whole stop bit misses the next start edge when the sender is fast; a break read as a stream of 0x00 bytes floods the software.',
    cost: '526 NANDs against the transmitter\'s 482: a state register of five states, a tick counter, a bit counter, an 8-bit shift register and the two-flop synchronizer. With 16 ticks to a bit the receiver tolerates about 5% of clock error; at 8 ticks it would be about 10% worse.',
  },
  l_crc: {
    problem: 'A frame can cross a wire, a connector and a transceiver and arrive with a bit flipped. A parity bit catches one error in a byte; a CRC-32 appended to the frame catches every burst up to 32 bits and all but one in 4 294 967 296 of the rest. Ethernet\'s frame check sequence is exactly this: a register of 32 flip-flops and XORs, run once over the frame as it is sent and again over what arrives.',
    without: 'Without a check the receiver passes a corrupted frame up to software as if it were whole, and the damage shows as a wrong file or a wrong address much later. A software CRC on a 100 Mb/s link means one table lookup per byte, more than the processor can spare.',
    cost: '1027 NANDs for a byte a clock: 32 flip-flops with an init mux, the 32 XORs of the complement and a network of 72 shared XOR gates. The serial one-bit unit is 795 NANDs but takes eight clocks a byte; at the same clock a byte-wide unit is eight times the throughput for 29% more gates.',
    alts: [{ name: 'CRC-32, one bit a clock', lib: 'unitcrc32_EDB88320_1s' }],
  },
  l_8b10b: {
    problem: 'A serial link sends bits with no clock beside them, through transformers or capacitors that pass no DC. A long run of equal bits both starves the receiver\'s clock recovery of transitions and drifts the average level. 8b/10b sends every byte as ten bits so that the ones and zeros stay within one of each other and no run is longer than five. PCIe 1 and 2, SATA, Gigabit Ethernet, USB 3 and DisplayPort all use it; its twelve control codes include the commas that let a receiver find the symbol boundaries.',
    without: 'A byte stream of all zeros is a line held low. Without the code the receiver loses the clock; with a transformer the signal droops toward the middle and every bit after the first is misread.',
    cost: '1195 NANDs and 29 gate delays of combinational logic against a raw byte\'s zero: two tables and two XORs. The price on the wire is 25% of the bandwidth: 1.25 Gb/s of line for 1 Gb/s of data, where 64b/66b pays 3%.',
  },
  l_cdr: {
    problem: 'A serial link has no clock wire, and the sender\'s oscillator is a different crystal from the receiver\'s, tens of parts per million off and drifting with temperature. The receiver has to put its sampling instant in the middle of every bit, and keep it there. The transitions the code guarantees are the only information it has: each edge says where a bit boundary is.',
    without: 'A receiver that samples at a fixed rate from its own clock slips a bit every 1/ppm bits: at 100 ppm, one bit in ten thousand is read twice or lost, a link that would corrupt ten times a second at 1 Gb/s. A receiver that tries to follow every single edge instead jitters and samples at the boundary half the time.',
    cost: '487 NANDs: five sampling flip-flops, the early/late detector, a strobe counter and a four-vote filter. The loop follows a clock up to about 3% off, which is thousands of times what crystals give; the limit is the transition density of the code (8b/10b guarantees one in five bits).',
  },
};
