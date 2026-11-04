// Act 12, Links (roadmap Phase 21 g): optional levels from chapters 39–47 (relays, crossing clocks, a UART, I²C, CRC, 8b/10b, clock
// recovery). The levels whose parts come with chapters 48–53 (Ethernet, a switch, the stack) are on the map as "coming soon"
// in the order they will play. No DOM.

import type { CampaignNode } from './types';
import { BUILDCOMM } from './buildcomm';
import { partsOf } from './build8';
import { SYNC_REF } from './buildcomm';
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
];
