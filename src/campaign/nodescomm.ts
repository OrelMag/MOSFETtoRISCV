// Act 12, Links (roadmap Phase 21 g): optional levels from chapters 39–47 (relays, crossing clocks, a UART, I²C, CRC, 8b/10b, clock
// recovery). The levels whose parts come with chapters 48–53 (Ethernet, a switch, the stack) are on the map as "coming soon"
// in the order they will play. No DOM.

import type { CampaignNode } from './types';
import { BUILDCOMM } from './buildcomm';
import { partsOf } from './build8';
import { crcGives, leafGives, SYNC_REF } from './buildcomm';
import { CDR, CDR_CTL, ENC34, ENC56, ENC8B10B } from '../lib/serdes';
import { UART_RX, UART_TX } from '../lib/uart';

export const NODES_COMM: CampaignNode[] = [
  {
    id: 'l_sync', act: 12, title: 'Synchronizer', kind: 'build', optional: true, requires: ['c_computer'], base: BUILDCOMM.l_sync, givesOf: partsOf(SYNC_REF), unlocks: ['sync2'], par: { nand: 22, period: 6, cycles: 2 },
    why: 'A signal from another clock arrives at any moment, including the one in which the first flip-flop cannot decide. Two flip-flops in a row give it a whole period to decide: 22 NANDs, two cycles of latency, and a failure about once in two million years at 1.6 GHz where one flip-flop read by logic fails in under two days.',
    tips: ['q is the same signal some whole number of cycles later: flip-flops on clk, d into the first.', 'The bench computes the failure rate from the structure. A gate between two flip-flops eats resolution time from the one before it.', 'One flip-flop is not enough at this clock; three are more than enough and cost a cycle more than par.'],
    codex: ['edge'], chapters: [{ chapter: 'clocks', step: 5, label: 'The two-flop synchronizer' }],
  },
  {
    id: 'l_uarttx', act: 12, title: 'UART transmitter', kind: 'build', optional: true, requires: ['c_computer'], base: BUILDCOMM.l_uarttx, givesOf: partsOf(() => UART_TX), par: { nand: 482, period: 23 },
    why: 'Two machines with no clock between them agree on a bit time instead. A UART frames each byte (a start bit, eight data bits, a stop bit) and holds every bit for the same number of ticks: 482 NANDs, a 10-bit shift register and two counters.',
    tips: ['A 10-bit shift register holds the frame {stop, data, start}; load it when go meets busy = 0, shift it at the end of each bit.', 'Two counters: ticks within the bit (0 to 15) and bits sent (0 to 9). Both count only on a tick while busy.', 'Reset is all zeros, so store the line inverted: a register of zeros then means idle, and one inverter makes tx.', 'busy = a flip-flop set by load and cleared at the last tick of the stop bit.'],
    codex: ['handshake'], chapters: [{ chapter: 'uart', step: 1, label: 'The transmitter' }],
  },
  {
    id: 'l_uartrx', act: 12, title: 'UART receiver', kind: 'build', optional: true, requires: ['l_uarttx', 'l_sync'], base: BUILDCOMM.l_uartrx, givesOf: partsOf(() => UART_RX), par: { nand: 526, period: 26 },
    why: 'The sender\'s clock is not yours and its start edge falls anywhere between two of your ticks. The receiver oversamples: it finds the start edge to within a tick, confirms it in the middle of the start bit, then samples every 16 ticks, the middle of each bit, so it survives a clock 5% off and a glitch: 526 NANDs.',
    tips: ['rx is asynchronous: a two-flop synchronizer first (its inverse, so that reset means idle).', 'A state register: idle, start, data, stop, break. A tick counter of 0 to 15 restarts at the start edge and at the middle of the start bit.', 'In the middle of the start bit (7 ticks after the detecting one) rx must still be low, else go back to idle: that rejects a glitch.', 'A shift register takes a bit at each sample; a counter of 0 to 7 counts bits. The stop sample decides: 1 pushes, 0 is a framing error and waits for the line to go high.'],
    codex: ['edge'], chapters: [{ chapter: 'uart', step: 3, label: 'Sampling in the middle' }, { chapter: 'uart', step: 4, label: 'Errors: framing, false start, break, overrun' }],
  },
  {
    id: 'l_crc', act: 12, title: 'CRC-32', kind: 'build', optional: true, requires: ['c_computer'], base: BUILDCOMM.l_crc, givesOf: crcGives, par: { nand: 1027, period: 22 },
    why: 'A frame that crosses a wire can arrive with a bit flipped, and the receiver has to know. The sender appends the remainder of the frame as a polynomial over GF(2); the receiver divides again and gets a constant. In hardware the division is a register and XORs, a byte a clock.',
    tips: ['One bit: shift the register right by one and, if the bit shifted out XOR the data bit is 1, XOR the generator 0xEDB88320 into the result. That is a few XOR gates at the 1 bits of the generator.', 'A byte is that step eight times, one after the other with no register between: each output bit is the XOR of some of the 32 state bits and the 8 data bits. Chaining eight steps works; sharing the common pairs of terms makes it smaller.', 'init sits in front of the register: a 32-bit mux between the next state and all ones, selected by init; the register loads when init OR en.', 'fcs is q XOR all ones.'],
    codex: ['ecc'], chapters: [{ chapter: 'errors', step: 4, label: 'CRC in gates, a bit a clock' }, { chapter: 'errors', step: 5, label: 'A byte at a time' }],
  },
  {
    id: 'l_8b10b', act: 12, title: '8b/10b encoder', kind: 'build', optional: true, requires: ['c_computer'], base: BUILDCOMM.l_8b10b, givesOf: leafGives(() => ENC8B10B, () => [ENC56, ENC34]), par: { nand: 1195, depth: 29 },
    why: 'A fast serial link sends no clock, and its receiver is AC coupled: a long run of equal bits drifts the level and starves clock recovery. 8b/10b spends two extra bits in ten to guarantee a transition every five and a running disparity within one. Two small tables and an XOR for each disparity change.',
    tips: ['Split the byte: five low bits (x) go through the 5b/6b table, three high bits (y) through the 3b/4b table. The disparity entering the 4b block is the one after the 6b block.', 'Most 5b/6b blocks have two forms, complements of each other, chosen by the running disparity; balanced ones have one. Two exceptions are balanced yet depend on rd.', 'D.x.7 has an alternate 4b form (a run of five would otherwise form after certain x); K28 uses its own 6b block and a different 4b.', 'rdout: flip the disparity at each block that is not balanced, an XOR of rd with the block\'s flip.'],
    codex: ['ecc'], chapters: [{ chapter: 'serial', step: 1, label: '8b/10b and running disparity' }],
  },
  {
    id: 'l_cdr', act: 12, title: 'Clock recovery', kind: 'build', optional: true, requires: ['l_sync', 'l_8b10b'], base: BUILDCOMM.l_cdr, givesOf: leafGives(() => CDR, () => [CDR_CTL]), par: { nand: 487, period: 29 },
    why: 'The line carries no clock, and the sender\'s is never quite yours. Every transition in the data is a free look at where the sender\'s bit boundaries are; a loop that nudges its strobe toward them, a sample at a time, follows a clock that drifts. That is why 8b/10b guarantees a transition every five bits.',
    tips: ['Sample the line every cycle into a chain of flip-flops. At a strobe, three of them are what the detector needs: the newest data sample, the one two cycles before it (the sample near the edge) and the data sample two cycles before that.', 'If the data changed between the two data samples and the edge sample still shows the old value, the strobe was early; if it already shows the new one, late. If the data did not change there is no vote.', 'A counter of 0 to 3 times the strobe (4 cycles a bit). A vote filter counts early minus late and only at four the same way makes the next period 5 or 3 cycles instead of 4: a bang-bang loop with hysteresis.', 'Do not move on one vote: a single noisy edge would shake the strobe, and a sample point that moves every bit is jitter.'],
    codex: ['edge'], chapters: [{ chapter: 'serial', step: 4, label: 'Finding the clock in the data' }],
  },
];
