// Check yourself for Appendix E's codex entries (codexbaby.ts): two questions each, the answer first (quizBox shuffles),
// a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKBABY: Record<string, Quiz[]> = {
  williamstube: [
    {
      question: 'Why does the Baby\'s store have to be rewritten all the time?',
      options: [
        'Each spot\'s charge leaks away within a fraction of a second, and reading a spot disturbs it',
        'The beam wears the phosphor out unless it is moved',
        'The pick-up plate can only hold one line at a time',
        'The program changes its own lines constantly',
      ],
      answer: 0,
      explain: 'A dash is a patch of charge on the phosphor. Kilburn\'s report puts its life at "of the order of 0.2 seconds", and a read leaves it weaker, so a line is read and written back before it fades: regeneration.',
      why: ['', 'Nothing wears out in the model; the charge simply leaks.', 'The plate sees the pulse of whichever spot the beam is on; the tube holds all 32 lines at once.', 'Even a program that never stores anything needs regeneration.'],
    },
    {
      question: 'The charge lasts about 0.2 s, and the Baby rewrites the whole store every 16 instructions, 19.6 ms. About how many times is a line rewritten within the charge\'s life?',
      options: ['About ten', 'About once', 'About a hundred', 'Never: only lines the program reads are rewritten'],
      answer: 0,
      explain: '0.2 s / 19.6 ms is about 10. The margin is deliberate: a missed visit or a slow one costs nothing, and "greater than 5 cycles/second" is the least the report asks for.',
      why: ['', 'Once would leave no margin: one late visit and the line is lost.', '19.6 ms is a fiftieth of a second; a hundred rewrites would take two seconds.', 'The regenerator visits every line, used or not; an unvisited line fades like any other.'],
    },
  ],
  ssem: [
    {
      question: 'Which arithmetic does the Baby have?',
      options: ['Subtraction only (LDN negates a line, SUB subtracts one)', 'Addition and subtraction', 'Addition, subtraction and multiplication', 'None: it only moves data'],
      answer: 0,
      explain: 'Seven instructions: JMP, JRP, LDN, STO, SUB, CMP, STP. Addition is two subtractions through zero, and Kilburn\'s routine divides by repeated subtraction.',
      why: ['', 'There is no ADD in the order code.', 'Multiplication and division are programs, not instructions.', 'LDN and SUB compute: A = −S and A = A − S.'],
    },
    {
      question: 'What makes the Baby a stored-program computer?',
      options: [
        'Its program and its data share the 32 lines of one read-write store, so a program can change its own lines',
        'It has a read-only memory for the program',
        'Its program is set on switches before it runs',
        'It has seven instructions',
      ],
      answer: 0,
      explain: 'The first program ran on 21 June 1948 from the Williams tube. Kilburn\'s routine writes its working values into lines of the same store it is fetched from.',
      why: ['', 'The tube is read-write; a read-only program memory would be a different machine.', 'A program kept outside the store, on switches or a plugboard, is the opposite of stored: the machine cannot write to it.', 'Any instruction count is possible with or without a stored program.'],
    },
  ],
};
