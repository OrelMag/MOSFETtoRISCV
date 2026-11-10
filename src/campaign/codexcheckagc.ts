// Check yourself for Appendix F's codex entries (codexagc.ts): two questions each, the answer first (quizBox shuffles),
// a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKAGC: Record<string, Quiz[]> = {
  corerope: [
    {
      question: 'In core rope, what makes a bit a 1?',
      options: ['Its sense wire threads the core that is switched', 'The core is magnetized one way rather than the other', 'A current flows in the inhibit wire', 'The core is present in the rope'],
      answer: 0,
      explain: 'Reading switches one core; every wire through its hole sees a pulse. A wire routed outside the core sees none, a 0.',
      why: ['', 'Every core switches the same way when read: the data is in the wiring.', 'The inhibit wires choose which core switches; they carry no data.', 'Every core is present; each stores bits of 12 words.'],
    },
    {
      question: 'How was a program in core rope changed?',
      options: ['By weaving a new rope', 'By the computer writing new words into it', 'By remagnetizing its cores', 'By changing its inhibit currents'],
      answer: 0,
      explain: 'The contents are the routing of the sense wires, fixed when the rope is woven (from a punched tape, on a weaving machine). A new program is a new rope, plugged in from outside the computer\'s sealed case.',
      why: ['', 'Rope is read-only: no instruction can change the wiring.', 'Remagnetizing would change nothing: the cores are switched and reset on every read anyway.', 'Those choose the address, not the data.'],
    },
  ],
  agc: [
    {
      question: 'Why does the AGC\'s accumulator have 16 bits when its words have 15?',
      options: ['A word\'s sign goes into both top columns, so an overflow shows as the two differing, with the true sign kept', 'To hold a parity bit', 'For double-precision numbers', 'To address more memory'],
      answer: 0,
      explain: 'Both top columns take the sign; after an addition they agree unless the sum overflowed. The overflow stays visible in A (TS acts on it), and storing keeps the true sign (R-700 p. 37).',
      why: ['', 'Memory words carry the parity bit; the central registers use that column for the second sign instead.', 'Double precision uses two words, A and L, not a wider A.', 'Addresses come from the instruction\'s 12 bits and the bank registers.'],
    },
    {
      question: 'Block I used only one integrated circuit type for its logic. What reason does R-700 give?',
      options: ['Producing and qualifying even a second circuit type would have cost more than the packages it saved', 'NOR was the only gate that could be made then', 'One type needed the least power', 'The computer had to fit one chip'],
      answer: 0,
      explain: 'R-700 p. 10: a gated flip-flop and other blocks would have meant fewer packages, but "the problem of producing and qualifying even a second circuit type would have outweighed the advantages".',
      why: ['', 'Other circuits existed; one was chosen on purpose.', 'Power is not the reason given (Block II\'s gate was redesigned to use less).', 'It used thousands of gates, two to a chip in Block II.'],
    },
  ],
};
