// Check yourself questions for the entries of codexmore10.ts (verification and test; see codexcheck.ts). Answers first:
// the quiz shuffles the options (ui/quiz.ts shuffleOrder). Numbers pinned by tests/content-codexverify.test.ts. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK12: Record<string, Quiz[]> = {
  golden: [
    {
      question: 'A pipelined CPU is compared with the golden model. When is the comparison made?',
      options: ['Each time an instruction retires, as many steps of the model as instructions retired', 'Every clock cycle', 'Once, when the program halts', 'Each time an instruction is fetched'],
      answer: 0,
      explain: 'Only a retired instruction has changed the architectural state the model knows. Comparing then names the first instruction whose effect differs.',
      why: ['', 'Mid-pipeline, half-finished instructions have not written anything yet: every cycle would compare against a state that is not meant to exist.', 'A final comparison says what is wrong, not where; and a wrong value overwritten later is never seen.', 'A fetched instruction may be flushed and never execute.'],
    },
    {
      question: 'The CPU and the golden model agree on every program. What can still be wrong?',
      options: ['Both, if they share a misreading of the specification', 'Nothing: agreement proves the CPU right', 'Only the timing', 'Only the instructions no program used'],
      answer: 0,
      explain: 'Lock step finds differences between two descriptions. A mistake both make is invisible to it: an outside oracle (the riscv-tests, Spike) is needed for that.',
      why: ['', 'Agreement is evidence, not proof: two models written from one reading of the text can be wrong together.', 'Timing is a real gap too, but it is not the only one.', 'Unexercised instructions are a coverage gap; a shared misreading can sit in instructions that run all the time.'],
    },
  ],
  selfcheck: [
    {
      question: 'A riscv-test ends with tohost = 9. What happened?',
      options: ['Case 4 failed: (4 << 1) | 1 = 9', 'All 9 cases passed', 'Case 9 failed', 'The test ran 9 cycles'],
      answer: 0,
      explain: 'A pass writes 1; a failure writes the case number shifted left with the low bit set.',
      why: ['', 'A pass writes exactly 1, whatever the number of cases.', 'The case number is shifted left one place first: 9 = 0b1001 is case 4.', 'tohost holds a verdict, not a time.'],
    },
    {
      question: 'With alu.slt stuck at 0, why do slt and slti both fail at case 4 and not at case 1?',
      options: ['Cases 1–3 expect 0, which the stuck output gives anyway; case 4 is the first whose answer is 1', 'The first three cases are skipped', 'The fault only appears after three instructions have run', 'slt needs four cycles'],
      answer: 0,
      explain: 'A stuck-at-0 output is right whenever the answer is 0: only a case that expects 1 can show it.',
      why: ['', 'Every case runs; they pass because 0 is the right answer for them.', 'A stuck net is wrong from power-on; it just happens to agree.', 'The pipeline completes slt like any ALU instruction.'],
    },
  ],
  fuzzing: [
    {
      question: '3 of 64 random programs meet a bug. About how likely is one batch of 32 programs to miss it?',
      options: ['About 22 %: (61/64)³²', 'About 5 %', 'About 50 %', 'It cannot miss it'],
      answer: 0,
      explain: 'Each program misses with probability 61/64; 32 independent ones all miss with (61/64)³². Eight batches miss it with under 0.01 %.',
      why: ['', 'That is the chance one program meets it, not that a batch misses it.', '32 tries at 1 in 21 each are far better than a coin toss.', 'Random tests only make a miss unlikely, never impossible.'],
    },
    {
      question: 'Delta debugging shrinks a failing program. Which deletion does it keep?',
      options: ['One after which the program still assembles, halts on the golden model and fails on the gates', 'Any that makes the program shorter', 'One after which the program passes', 'One that removes a branch'],
      answer: 0,
      explain: 'The goal is a smaller program with the same failure: each candidate must still be a valid, halting program that the gates get wrong.',
      why: ['', 'A shorter program that no longer fails has lost the bug.', 'A passing program is the opposite of what is kept.', 'Branches are often part of the recipe: the FP pipeline\'s bug needs one.'],
    },
  ],
  coverage: [
    {
      question: 'Every instruction and every pipeline event is covered. What does that prove?',
      options: ['Only that each was exercised at least once; combinations can still hide bugs', 'That the CPU is correct', 'That the golden model is correct', 'That no random program can fail'],
      answer: 0,
      explain: 'The FP pipeline\'s bug survived full coverage: it needs a taken branch while an FP interlock holds D, a combination no single point counts.',
      why: ['', 'Coverage measures the tests, not the design.', 'Coverage says nothing about the oracle being right.', 'The bug in the chapter was found by random programs after coverage was complete.'],
    },
    {
      question: 'The Primer sample makes all 7 pipeline events. How many of the 31 RV32I word instructions does it use?',
      options: ['13', '31', '7', '24'],
      answer: 0,
      explain: 'One well-written program can exercise every hazard and still leave most instructions untested; 32 random programs reach all 31.',
      why: ['', 'That is what 32 random programs reach.', 'That is the number of events, not of instructions.', 'Far fewer: the sample uses a handful of instructions in loops.'],
    },
  ],
  stuckat: [
    {
      question: 'How many stuck-at faults does the 9-NAND full adder have, counting every input bit and every NAND output?',
      options: ['24', '12', '18', '9'],
      answer: 0,
      explain: '3 inputs + 9 NAND outputs = 12 nets, each stuck at 0 or at 1.',
      why: ['', 'That is the number of nets; each has two faults.', 'That counts only the NAND outputs, twice.', 'That is the number of NANDs.'],
    },
    {
      question: 'A design bug is on every die. Does a manufacturing test against stuck-at faults catch it?',
      options: ['No: the tester compares with the design, bug included', 'Yes, if the coverage is 100 %', 'Yes, as a stuck-at fault on the wrong net', 'Only with scan'],
      answer: 0,
      explain: 'Test asks whether a die is the design. Verification asks whether the design is right; only it can find a design bug.',
      why: ['', 'Full coverage means every modelled defect is caught; a design bug is not a defect.', 'The faulty die and the expected answer would both carry the bug.', 'Scan reaches the flip-flops; it compares with the same design.'],
    },
  ],
  faultcov: [
    {
      question: 'Random vectors on the 4-bit adder catch 40, 60, 76, 88, 90 of its 90 faults after 1, 2, 4, 8, 16 vectors. Why does it slow down?',
      options: ['The last faults are each shown by few vectors, which random draws rarely hit', 'The fault simulator gets slower', 'Random vectors repeat', 'The last faults are untestable'],
      answer: 0,
      explain: 'Most faults are caught by many vectors; the tail by a few. That tail is where generated (ATPG) vectors pay.',
      why: ['', 'The simulator\'s speed does not change what a vector catches.', 'Repeats happen, but 16 of 512 rarely repeat; that is not the cause.', 'All 90 are caught by 16: none is untestable.'],
    },
    {
      question: 'Greedy picks 4 vectors to catch all of the full adder\'s faults. The smallest set has:',
      options: ['3', '4', '2', '8'],
      answer: 0,
      explain: 'Greedy takes the vector catching the most first, which overlaps the others\' catches. An exact search finds 3.',
      why: ['', 'Greedy is good, not always best.', 'Two vectors cannot activate every fault at 0 and at 1.', 'All 8 vectors work, far from the smallest.'],
    },
  ],
  atpg: [
    {
      question: 'To carry a fault\'s effect through a NAND to its output, its other inputs must be:',
      options: ['1', '0', 'the same as the faulty input', 'anything'],
      answer: 0,
      explain: 'A NAND with a 0 input gives 1 whatever the rest are; only with the other inputs at 1 does its output follow the faulty one.',
      why: ['', 'A 0 forces the output to 1 and blocks the difference.', 'Equal values do not help in general: it is the value 1 that opens the gate.', 'Then the path may be blocked.'],
    },
    {
      question: 'The search proves a fault untestable. What does that say about the circuit?',
      options: ['The logic at that net is redundant: removing it would not change any output', 'The circuit is wrong', 'The fault is harmless and costs nothing', 'The search ran out of time'],
      answer: 0,
      explain: 'Untestable means no input makes the fault change an output, so that logic never decides the outputs: the consensus term b·c.',
      why: ['', 'The outputs are right; there is just more logic than needed.', 'The redundant gate still costs area and power, and can mask a second fault.', 'That is "aborted", a different verdict.'],
    },
  ],
  scan: [
    {
      question: 'A chain of 2 676 scan flip-flops is split into 8 chains. How many shift clocks does one pattern need now?',
      options: ['335 (2 676 / 8, rounded up)', '2 676', '8', '21 408'],
      answer: 0,
      explain: 'The chains shift at once, so a pattern takes as many clocks as the longest chain, at the price of two pins a chain.',
      why: ['', 'That is one chain.', 'That is the number of chains.', 'Splitting divides the time; it does not multiply it.'],
    },
    {
      question: 'What does a scan flip-flop add to a D flip-flop?',
      options: ['A 2:1 multiplexer in front of d: 15 NANDs against 11', 'A second clock', 'A reset', 'Nothing: any flip-flop shifts'],
      answer: 0,
      explain: 'se chooses between the functional input d and the chain\'s si; the flip-flop itself is unchanged.',
      why: ['', 'One clock serves both modes; se selects the input.', 'Reset is separate and often added too, but it is not what makes scan.', 'Without the mux q could not be loaded from the neighbour.'],
    },
  ],
  lfsr: [
    {
      question: 'A 4-bit LFSR with taps 4, 3 starts at 0000. What happens?',
      options: ['It stays at 0000 for ever', 'It visits all 16 states', 'It visits 15 states', 'It counts up'],
      answer: 0,
      explain: 'The new bit is 0 XOR 0 = 0: all zeros is a fixed point. Seed it with anything else and it visits the 15 non-zero states.',
      why: ['', 'No XOR-feedback LFSR reaches all 2ⁿ: the zero state is cut off from the rest.', 'Only from a non-zero seed.', 'It shifts; the order looks random, not counted.'],
    },
    {
      question: 'Why do built-in self-tests use an LFSR rather than a counter as the pattern generator?',
      options: ['It is cheaper (a shift register and a few XORs) and its patterns change many inputs at once', 'It covers more vectors than a counter', 'A counter cannot be built on a chip', 'It never repeats'],
      answer: 0,
      explain: 'A counter needs an incrementer and changes its high bits rarely; an LFSR costs one XOR per tap and moves every bit each clock.',
      why: ['', 'Both run through about 2ⁿ values; the difference is cost and order.', 'Counters are everywhere on chips.', 'It repeats after 2ⁿ − 1 states.'],
    },
  ],
  bist: [
    {
      question: 'The adder\'s self-test catches 89 of 90 faults with 32 patterns. Why does the last one escape?',
      options: ['Its wrong sums fold into the good signature (aliasing)', 'No pattern shows it at the outputs', 'The LFSR skips it', 'It is untestable'],
      answer: 0,
      explain: 'The 32 patterns show all 90 faults at the adder\'s outputs; the 5-bit MISR then maps one faulty stream onto the same word as the good one.',
      why: ['', 'Every fault is shown by some pattern; the loss is in the compression.', 'The patterns do reach it.', 'It changes the outputs, so it is testable.'],
    },
    {
      question: 'Roughly how often does a wrong answer stream alias in a 32-bit MISR?',
      options: ['About one in 2³², four billion', 'One in 32', 'Never', 'One in 5'],
      answer: 0,
      explain: 'A long wrong stream lands on any signature about equally often: 1 / 2ⁿ for n bits. 5 bits give 1 in 32, which is why real MISRs are wide.',
      why: ['', 'That is a 5-bit MISR.', 'Compression always loses something; it can only be made rare.', 'Unrelated to the width.'],
    },
  ],
};
