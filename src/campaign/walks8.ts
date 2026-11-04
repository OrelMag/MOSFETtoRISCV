// Authored walkthroughs, group 8: act 12, Links (references: lib/sync.ts, lib/uart.ts … through buildcomm.ts). See walks.ts
// for the conventions. No DOM.

import type { WalkScript } from './walk';

export const WALKS8: Record<string, WalkScript> = {
  l_sync: [
    {
      title: 'The flip-flop that may not decide',
      text: 'f0 samples d on the receiving clock. d changes at any moment, so some edges will find it mid-change and leave f0 balanced between 0 and 1 for a while: a metastable output. f0 is the only flip-flop that can see this.',
      parts: ['f0'], codex: ['edge'],
      why: 'Something has to sample the asynchronous signal at one instant of the receiving clock. A flip-flop is that sampler, and its output is not a clean 0 or 1 until it has decided.',
      whyNot: { text: 'Feeding d straight into the logic lets a half-decided level reach many gates at once, which read it differently.' },
    },
    {
      title: 'A whole period to decide',
      text: 'f1 samples f0 one period later. By then the undecided level has had t = T − clk-to-q − setup to fall to a rail; each extra period multiplies the odds by e^(T/τ). Nothing may sit between f0 and f1: a gate there would eat resolution time.',
      parts: ['f1'], codex: ['edge'],
      ask: {
        question: 'At this port one flip-flop read by logic fails in days. What does f1 buy?',
        options: ['A whole extra clock period for f0 to resolve: the failure interval is multiplied by about e^(T/τ)', 'A cleaner copy of d: f1 filters out the glitches', 'Twice the speed: two flip-flops in a row sample twice per period', 'Nothing for the failure rate, only an extra cycle of delay'],
        answer: 0,
        explain: 'The chance that the first flip-flop is still undecided after t falls as e^(−t/τ). A second flip-flop gives it a period more, at the price of a cycle of latency.',
        why: ['', 'f1 does not filter: it repeats f0 a period later, undecided or not. What changes is the chance that f0 is still undecided at that moment.', 'Both flip-flops sample on the same edge; the second just samples what the first held a period ago.', 'The delay is the price; the failure interval is what it buys, and the exponent makes it enormous.'],
      },
      why: 'The exponent is time. One extra period turns a failure in days into one in millions of years.',
      whyNot: { text: 'A third flip-flop is another factor e^(T/τ) for another cycle of latency: no use at this clock, where two already beat the requirement by orders of magnitude.' },
    },
  ],
};
