// Check yourself for the PDP-8's codex entry (codexpdp8.ts): two questions, the answer first (quizBox shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKPDP8: Record<string, Quiz[]> = {
  pdp8: [
    {
      question: 'How does a PDP-8 program put a word from memory into the accumulator?',
      options: ['Clear AC, then add the word to it (CLA, then TAD)', 'With a load instruction', 'With DCA', 'With JMS'],
      answer: 0,
      explain: 'There is no load. TAD adds a word to AC, so a cleared AC plus the word is the word; DCA is the way out again (store, then clear).',
      why: ['', 'Eight instructions leave no room for one: AND and TAD cover it from a cleared AC.', 'DCA goes the other way: it stores AC into memory and clears AC.', 'JMS calls a subroutine: it stores the return address, not a value into AC.'],
    },
    {
      question: 'A PDP-8 instruction at 1000 (octal) reads a table at 3000. Why does it go through a pointer (TAD I PTR)?',
      options: ['Its 7-bit address reaches only page zero or the instruction\'s own 128-word page', 'Indirect references are faster', 'Core above 2000 is read-only', 'The accumulator holds only 7 bits'],
      answer: 0,
      explain: 'An instruction has 7 address bits and a page bit: page zero (0000–0177) or its own page. A full 12-bit address fits only in a word of memory, so the instruction names that word and sets I.',
      why: ['', 'They are slower: Defer costs one more memory cycle.', 'All 4096 words are core, read and written alike.', 'AC has 12 bits; the 7 bits are the instruction\'s address field.'],
    },
  ],
};
