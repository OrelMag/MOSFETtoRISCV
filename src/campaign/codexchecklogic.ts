// Check yourself for the logic chapter's codex entry (codexlogic.ts): two questions, the answer first (quizBox shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKLOGIC: Record<string, Quiz[]> = {
  hazard: [
    {
      question: 'y = s·b + ¬s·a with a = b = 1. When s falls from 1 to 0 the settled y stays 1. What can still happen on the way?',
      options: [
        'y dips to 0 for about one gate delay, because s·b turns off before ¬s·a turns on',
        'Nothing: with a = b = 1 both terms are 1 all the time',
        'y rises to 1 for one delay: a static-0 hazard',
        'y oscillates until s is stable',
      ],
      answer: 0,
      explain: 'With a = b = 1, s·b is 1 while s is 1 and ¬s·a is 1 while s is 0. The first term goes off one gate delay after s falls; the second comes on only after the inverter has made ¬s, a delay later. In between neither is 1.',
      why: ['', 'Only one of the two is 1 at any settled moment, and the hand-over between them is not instantaneous: ¬s needs an inverter.', 'y starts at 1 and ends at 1, so what it can do on the way is dip to 0: that is a static-1 hazard. A static-0 hazard is a pulse up from 0.', 'Nothing feeds back, so nothing oscillates. The dip happens once, then y is steady.'],
    },
    {
      question: 'Why does adding the consensus term a·b to s·b + ¬s·a remove the dip without changing any output of the truth table?',
      options: [
        'a·b is 1 whenever a = b = 1, including during the hand-over, and it adds nothing anywhere else',
        'It makes ¬s arrive earlier',
        'It slows the term s·b so that both change together',
        'It is a second multiplexer that takes over when s changes',
      ],
      answer: 0,
      explain: 'Where a = b = 1 the function is 1 whatever s is, and a·b is 1 there. Where it is 1 the function was already 1 (s·b or ¬s·a covered it). So the third term is redundant for every row, yet it is steady across the seam where the other two let go and take hold.',
      why: ['', 'Nothing in the two other paths is touched. The new term reads a and b only.', 'Slowing a path moves the gap or widens it. Only a term that covers the seam removes it.', 'It has no select and no data input of its own: it is one AND of a and b.'],
    },
  ],
};
