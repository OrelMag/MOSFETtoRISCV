// Check yourself questions for the entries of codexmore3.ts (see codexcheck.ts), group 5. Answers first: the quiz
// shuffles the options (ui/quiz.ts shuffleOrder). Numbers pinned by tests/content-codexease.test.ts. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK5: Record<string, Quiz[]> = {
  preg: [
    {
      question: 'A load-use stall in the RV16 pipeline: the instruction in D needs the load in E. What do the F/D and D/E registers get at the next edge?',
      options: ['F/D: en = 0, it holds; D/E: clr = 1, a bubble', 'Both en = 0: everything holds', 'Both clr = 1: both become bubbles', 'F/D: clr = 1; D/E: en = 0'],
      answer: 0,
      explain: 'The user waits in D for one cycle (F/D and the PC hold) while the load moves on to M, so E gets a bubble. A cycle later the load is in W and the user in E: the value is forwarded from W.',
      why: ['', 'Holding D/E as well would keep the load itself in E: it would wait for itself for ever.', 'Clearing F/D throws away the instruction that has to wait: it would never run.', 'That clears the waiting instruction and freezes the load: both wrong.'],
    },
    {
      question: 'rv16_preg sees en = 0 and clr = 1 in the same cycle (a flush during a stall). What does it load at the edge?',
      options: ['Zeros: clr wins (the OR loads, the mux picks 0)', 'Nothing: en = 0 holds it', 'd', 'X: the inputs conflict'],
      answer: 0,
      explain: 'load = en OR clr, and the value is clr ? 0 : d. A flush must not be lost to a stall, or a wrong-path instruction would survive in the stage.',
      why: ['', 'clr reaches the register\'s enable through the OR: it loads whatever en says.', 'The mux picks 0 whenever clr = 1.', 'There is no conflict in the logic: clr has priority by construction.'],
    },
  ],
  clock: [
    {
      question: 'A path leaves a register, runs through 20 NAND delays of logic and ends at another register. In the site\'s model, what is the shortest period?',
      options: ['26 NAND delays: 3 clk-to-q + 20 + 3 setup', '20 delays', '23 delays', '40 delays: twice the logic'],
      answer: 0,
      explain: 'The edge needs 3 delays to reach the first register\'s output and the second register needs its input 3 delays before the next edge: T ≥ 3 + 20 + 3.',
      why: ['', 'That leaves no time for the register at either end.', 'Only one of the two register overheads is counted.', 'Logic is crossed once a cycle; nothing doubles it.'],
    },
    {
      question: 'A design meets timing at exactly its period. To run it at twice the frequency, what has to change?',
      options: ['Its longest register-to-register path, overheads included, has to fit in half the time: less logic on it, or a register in the middle', 'Nothing: the flip-flops just sample twice as often', 'Only the setup time must halve', 'The hold time must double'],
      answer: 0,
      explain: 'The period is set by the slowest path. A faster adder shortens it; a pipeline register splits it into two paths, each in its own cycle.',
      why: ['', 'Sampled early, the slowest path has not settled: the registers capture wrong values.', 'Setup is a small part of the period; the logic is most of it.', 'Hold does not depend on the period at all.'],
    },
  ],
  reset: [
    {
      question: 'RV16\'s register file has no reset. Is that a bug?',
      options: ['No: a program writes a register before it reads it; what is read first (the PC, valid bits, control state) is what needs a reset', 'Yes: every flip-flop must have a reset', 'Yes: the X spreads into the ALU for ever', 'No: flip-flops power up at 0'],
      answer: 0,
      explain: 'Resetting every register costs a mux or a bigger flip-flop per bit. Software never relies on a register it has not written; the hardware must not rely on its own state before reset either.',
      why: ['', 'Only state that is read before it is written needs a known start.', 'A register that is written first never shows its power-on value to anyone.', 'Silicon powers up at random; the simulator shows X.'],
    },
    {
      question: 's_pc resets synchronously: while rst = 1 a mux selects 0 into the register. When does the PC read 0?',
      options: ['After the first rising edge with rst = 1', 'The moment rst rises', 'After rst falls again', 'Only at power-on'],
      answer: 0,
      explain: 'A synchronous reset goes through the d logic like any other value, so it acts at a clock edge. An asynchronous reset would clear the flip-flops at once.',
      why: ['', 'That is an asynchronous reset, forcing the latches directly.', 'The mux selects 0 while rst is high; the edge during that time loads it.', 'rst works whenever it is raised, as long as the clock runs.'],
    },
  ],
  fpadder: [
    {
      question: 'Adding 1.5 and 0.375 in binary16, which step changes nothing?',
      options: ['Normalizing: 1.100 + 0.011 = 1.111 already has its leading 1 in place', 'Aligning: the exponents are equal', 'Adding the significands', 'Unpacking'],
      answer: 0,
      explain: 'The exponents are 0 and −2, so b is shifted right by 2; the sum 1.111 (1.875) needs no shift and no rounding: 0x3F80.',
      why: ['', 'They differ by 2: 0.375 = 1.1 × 2^−2.', 'The add is where 1.875 comes from.', 'Every operand is unpacked into sign, exponent and significand first.'],
    },
    {
      question: '1.0 − 0.99951171875 (0x3BFF) in binary16. What does the result need, and is it exact?',
      options: ['A left shift of 11 places; exact: 2^−11 (0x1000)', 'No shift; rounded', 'A right shift; exact', 'A left shift of 11; rounded to 0'],
      answer: 0,
      explain: 'Subtracting numbers this close cancels the leading bits: only the last one survives. The leading-zero counter finds where it is and the normalizer shifts it to the top. No bit is lost, so nothing rounds.',
      why: ['', 'The difference has leading zeros, which must go.', 'A right shift is for a carry out of an addition.', '2^−11 is a normal binary16 number (exponent field 4): nothing underflows.'],
    },
  ],
  tristate: [
    {
      question: 'Two tri-state buffers on one wire are enabled at once, one driving 1, the other 0. What does the switch-level simulation show?',
      options: ['X, and a short from VDD to GND through both buffers', '0: the pull-down wins', '1: the pull-up wins', 'Z: they cancel'],
      answer: 0,
      explain: 'Two drivers of equal strength fight: the level is undefined and current flows from supply to ground through both. The sandbox names the transistors of the short.',
      why: ['', 'Both drivers are equally strong here: neither wins.', 'Both drivers are equally strong here: neither wins.', 'Z means nobody drives; here two do.'],
    },
    {
      question: 'Why do chips use multiplexers inside, not tri-state buses?',
      options: ['A mux has one driver per net: no contention while enables switch, no floating wire, and static timing and testing work', 'Tri-state buffers are larger than a mux tree for any number of sources', 'Tri-states cannot carry a 1', 'CMOS cannot build a buffer that lets go'],
      answer: 0,
      explain: 'Tri-states survive at the pins (a memory\'s data bus) and in arrays (SRAM bit lines); between logic blocks every tool wants each net driven by exactly one gate.',
      why: ['', 'Per source a tri-state buffer is small; the costs are contention, floating and tooling.', 'They pass both levels while enabled.', 'TRIBUF is exactly that: a CMOS buffer with an enable.'],
    },
  ],
  bin2dec: [
    {
      question: 'Printing 59 999 by subtracting powers of ten: how many subtractions?',
      options: ['32: 5 + 9 + 9 + 9, the last digit is what is left', '5', '36', '59 999'],
      answer: 0,
      explain: 'Each count of subtractions is a digit; the units are what remains, with no subtraction. 59 999 has the most for a 16-bit number.',
      why: ['', 'That is one per digit; each digit needs as many subtractions as its value.', 'The last digit is the remainder: it needs none.', 'That would be subtracting 1 at a time.'],
    },
    {
      question: 'p_print compares x with 10 000 using a signed compare, and x = 40 000. What happens?',
      options: ['40 000 reads as −25 536: "below 10 000", so the ten-thousands digit is skipped', 'Nothing: it prints 40000', 'An overflow trap', 'It prints 4 twice'],
      answer: 0,
      explain: 'Above 32 767 a 16-bit number is negative when read as signed. The unsigned compare (sltu) is the right one for a value that is never negative.',
      why: ['', 'The signed compare sees a negative number.', 'RV16, like RISC-V, never traps on compares or overflow.', 'The digit loop never starts for the ten-thousands.'],
    },
  ],
};
