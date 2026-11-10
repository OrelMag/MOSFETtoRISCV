// Check yourself for the Vectors chapter's codex entries: two questions an entry, the right option first (the page shuffles), each wrong one saying why.

import type { Quiz } from '../chapters/types';

export const CHECKVEC: Record<string, Quiz[]> = {
  vlen: [
    {
      question: 'On a machine with VLEN = 256, what does <code>vsetvli t0, a0, e32, m1</code> put in t0 when a0 = 20?',
      options: ['8: VLMAX = 256 / 32', '20: everything asked for', '256: the register length', '4: as on VLEN 128'],
      answer: 0,
      explain: 'vl = min(a0, VLMAX), VLMAX = LMUL · VLEN / SEW = 1 · 256 / 32 = 8.',
      why: ['', 'vl never exceeds VLMAX; the loop asks again for the rest.', 'VLEN is bits, not elements.', 'VLEN 128 gives 4; this machine\'s registers are twice as long.'],
    },
    {
      question: 'Why does no vector instruction name VLEN?',
      options: ['So the same binary runs on machines with different register lengths', 'Because VLEN is always 128', 'Because the assembler fills it in', 'Because only vsetvli needs it'],
      answer: 0,
      explain: 'The program learns its piece size from vsetvli at run time; VLEN is the implementation\'s choice.',
      why: ['', 'Implementations choose VLEN: 128, 256, 512 and more exist.', 'The assembler does not know the machine the program will run on.', 'Even vsetvli does not name it: it returns vl.'],
    },
  ],
  stripmine: [
    {
      question: 'A strip-mined loop over n = 37 elements runs on VLEN 128 at e32, m1. How many passes, and how many elements in the last?',
      options: ['10 passes, the last with 1', '9 passes, the last with 4', '10 passes, the last with 4', '37 passes of 1'],
      answer: 0,
      explain: 'VLMAX = 4: nine passes of 4 make 36, and the tenth vsetvli returns 1.',
      why: ['', 'Nine passes of 4 cover only 36 elements.', 'The last vsetvli is asked for the 1 element left and returns 1.', 'vsetvli returns up to VLMAX, here 4, each pass.'],
    },
    {
      question: 'What does a strip-mined loop advance its pointers by each pass?',
      options: ['The vl returned in that pass, scaled to bytes', 'VLEN / 8 bytes', 'One word', 'n / passes elements'],
      answer: 0,
      explain: 'Each pass did vl elements, so the pointers move by vl · 4 bytes at e32; the last pass moves less.',
      why: ['', 'That overruns the arrays on the short last pass, and names VLEN, which the loop must not.', 'A pass does vl elements, not one.', 'The loop does not know the number of passes in advance.'],
    },
  ],
  lmul: [
    {
      question: 'At e32, m4 on our unit (VLEN 128, four lanes), which instruction is illegal?',
      options: ['<code>vadd.vv v8, v10, v12</code>: v10 does not start a group of 4', '<code>vadd.vv v8, v12, v16</code>', '<code>vadd.vv v0, v4, v8</code>', '<code>vadd.vv v28, v28, v28</code>'],
      answer: 0,
      explain: 'At m4 a group starts at a multiple of 4; v10 is in the middle of v8–v11.',
      why: ['', 'v8, v12 and v16 all start groups of four.', 'Legal for an unmasked add, though writing v0 overwrites the mask.', 'v28 to v31 is the last group; one register may be source and destination.'],
    },
    {
      question: 'Our 16-element kernel takes 56 cycles at m4 and 80 at m8 with the same 23 instructions. Why is m8 slower?',
      options: ['Each instruction steps through all eight registers of its group, though only four hold elements inside vl', 'm8 needs more instructions', 'The clock is slower at m8', 'An m8 group does not fit the register file'],
      answer: 0,
      explain: 'VLMAX at m8 is 32, vl is 16; our unit takes a beat per register of the group, so half the beats work on the tail.',
      why: ['', 'The instruction count is 23 at both.', 'The clock period is a property of the gates, not of vtype.', 'Four groups of eight registers fit in 32.'],
    },
  ],
  vmask: [
    {
      question: 'After <code>vmslt.vx v0, v8, a1</code> (v8 = 0 … 7, a1 = 3), what does <code>vadd.vi v16, v16, 10, v0.t</code> change?',
      options: ['Elements 0, 1 and 2 of v16', 'Elements 3 to 7 of v16', 'Every element of v16', 'Nothing: the mask stops it'],
      answer: 0,
      explain: 'vmslt sets bit e where element e is less than 3: bits 0, 1, 2. Only those elements are written.',
      why: ['', 'Those are the elements with the bit clear: they keep their value.', 'Only the elements with a 1 in v0 are written.', 'The mask enables some elements, not none.'],
    },
    {
      question: 'Why does a vector machine use a mask rather than a branch for an if over elements?',
      options: ['The elements share one instruction stream: a branch would have to send all of them one way', 'Branches are illegal in vector code', 'A mask is cheaper than a compare', 'The scalar core cannot branch while the vector unit runs'],
      answer: 0,
      explain: 'One instruction serves every element; a per-element choice must be data, the mask, not control flow.',
      why: ['', 'Scalar branches around vector code are fine; they just cannot choose per element.', 'The mask is written by a compare: it needs one.', 'It can, between vector instructions; that is how strip-mining loops.'],
    },
  ],
  chaining: [
    {
      question: 'What does chaining let a dependent vector instruction do?',
      options: ['Start on element group 0 as soon as its producer has written group 0', 'Run before its producer', 'Skip the elements past vl', 'Share its producer\'s functional unit in the same cycle'],
      answer: 0,
      explain: 'The consumer follows one step behind the producer, group by group, instead of waiting for the whole vector.',
      why: ['', 'It still needs the producer\'s values; it starts as soon as the first ones exist.', 'That is what vl does, chaining or not.', 'Producer and consumer run at once only on separate units.'],
    },
    {
      question: 'Our unit runs the y = 3·x + y loop body at m8 in 48 cycles, one instruction at a time. Separate units without chaining: 41. Chained: 27. Why do separate units alone save so little?',
      options: ['Most instructions depend on the one before, so without chaining each still waits for its producer to finish', 'Separate units are slower', 'The adds take two cycles a group', 'The store must wait for the next pass'],
      answer: 0,
      explain: 'The two loads share the load unit, and the adds and the store each need a whole result first: only the shift overlaps (the second load). Chaining overlaps the dependent ones.',
      why: ['', 'Each unit takes one cycle a group, the same as ours.', 'Every unit, the adder too, takes one cycle a group.', 'The store is the last of the pass; the next pass is not in the 41.'],
    },
  ],
};
