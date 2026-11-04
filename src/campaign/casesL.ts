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
};
