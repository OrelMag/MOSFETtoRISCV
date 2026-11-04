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
};
