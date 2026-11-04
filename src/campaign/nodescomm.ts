// Act 12, Links (roadmap Phase 21 g): optional levels from chapters 39–47 (relays, crossing clocks, a UART, I²C, CRC, 8b/10b, clock
// recovery). The levels whose parts come with chapters 48–53 (Ethernet, a switch, the stack) are on the map as "coming soon"
// in the order they will play. No DOM.

import type { CampaignNode } from './types';
import { BUILDCOMM } from './buildcomm';
import { partsOf } from './build8';
import { SYNC_REF } from './buildcomm';

export const NODES_COMM: CampaignNode[] = [
  {
    id: 'l_sync', act: 12, title: 'Synchronizer', kind: 'build', optional: true, requires: ['c_computer'], base: BUILDCOMM.l_sync, givesOf: partsOf(SYNC_REF), par: { nand: 22, period: 6, cycles: 2 },
    why: 'A signal from another clock arrives at any moment, including the one in which the first flip-flop cannot decide. Two flip-flops in a row give it a whole period to decide: 22 NANDs, two cycles of latency, and a failure about once in 10<sup>14</sup> seconds at 2 GHz where one flip-flop fails in days.',
    tips: ['q is the same signal some whole number of cycles later: flip-flops on clk, d into the first.', 'The bench computes the failure rate from the structure. A gate between two flip-flops eats resolution time from the one before it.', 'One flip-flop is not enough at this clock; three are more than enough and cost a cycle more than par.'],
    codex: ['edge'], chapters: [{ chapter: 'clocks', step: 5, label: 'The two-flop synchronizer' }],
  },
];
