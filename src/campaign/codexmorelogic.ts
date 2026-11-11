// The fuller codex text for the logic chapter's entry (codexlogic.ts). Numbers are the chapter's, pinned by tests/content-logic.test.ts.

import type { CodexMore } from './codexmore';

export const MORELOGIC: Record<string, CodexMore> = {
  hazard: {
    idea: `A gate's output changes one delay after its inputs, so two paths from the same input to the same gate arrive at different moments. If the settled output should not change but the old path lets go before the new one takes hold, the output leaves its value for a short while and comes back: a <b>static hazard</b> (static because the output starts and ends at the same value; a <b>static-1</b> hazard dips to 0, a static-0 hazard pulses to 1).<br>In a sum of products the cause is easy to see on the Karnaugh map. Two adjacent 1s covered by <em>different</em> loops that touch but do not overlap hand the output from one product term to the other, and while the first turns off and the second turns on neither is 1. Any single input change across that seam can show it. The cure is a third loop over the seam, the <b>consensus term</b> of the two (for s·b and ¬s·a it is a·b): it is 1 throughout the hand-over. It does not change the function, so a minimizer strips it as redundant, and it must be kept on purpose.<br>It matters when something reacts to a pulse rather than to a settled value: a reset or a set input, a latch enable, a clock or the enable of a clock gate. A register that samples the output after the logic has settled never sees it.`,
    example: {
      title: 'The multiplexer, with and without a·b',
      body: `<pre>y = s·b + ¬s·a        a = b = 1, s falls
without a·b   4 NANDs   y: 1 → 0 for one delay → 1
with a·b      7 NANDs   y: 1, 1, 1</pre>With one unit of delay per NAND, s·b turns off at 1 and ¬s·a turns on at 2: one delay with both off. The third term's NAND is 0 the whole time and holds the output NAND at 1. The brick has no 3-input NAND: the output gate is three 2-input NANDs, which is most of the seven.`,
    },
    mistakes: [
      'Treating the glitch as a wrong answer: the settled output is right. It is wrong only for something that listens during the change.',
      'Letting a logic minimizer remove the consensus term: it is redundant for the function and essential for the hazard.',
      'Expecting a fix inside one path. A hazard comes from two paths of different delay; making one path faster or slower moves it or widens it, only a term covering the seam removes it.',
    ],
    lib: 'mux2',
    chapters: [{ chapter: 'logic', step: 6, label: 'A glitch in two-level logic' }],
  },
};
