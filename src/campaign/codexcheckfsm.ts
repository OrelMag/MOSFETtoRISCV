// Check yourself for the chapter "Designing state machines" codex entries (codexfsm.ts): two questions each, the answer first
// (quizBox shuffles), a why for every option.

import type { Quiz } from '../chapters/types';

export const CHECKFSM: Record<string, Quiz[]> = {
  stateenc: [
    {
      question: 'A machine has 5 states. How many flip-flops do binary and one-hot codes use, and how many codes are unused in each?',
      options: ['Binary 3 flip-flops, 3 unused codes; one-hot 5 flip-flops, 27 unused codes', 'Binary 3 and one-hot 3, both with 3 unused', 'Binary 5 and one-hot 3, with 27 and 3 unused', 'Binary 2 flip-flops with no unused codes'],
      answer: 0,
      explain: 'Binary needs ⌈log₂ 5⌉ = 3 flip-flops: 8 codes, 5 used. One-hot has one flip-flop per state: 5 flip-flops, 32 codes, only the 5 with a single 1 are states.',
      why: ['', 'One-hot has a flip-flop per state, so 5, not 3.', 'It is the other way round: one-hot is the code with many flip-flops.', 'Two flip-flops hold only 4 codes; 5 states do not fit.'],
    },
    {
      question: 'Which statement about changing a machine\'s state code is true?',
      options: ['It changes the gates and flip-flops, but the circuit still reads back as the same diagram', 'It changes which input sequences the machine accepts', 'It can only be done before the diagram is drawn', 'One-hot always costs fewer NANDs than binary'],
      answer: 0,
      explain: 'The code is a naming of states. Every encoding implements the same arcs and outputs; only the cost differs (32, 37 and 51 NANDs for the 101 detector).',
      why: ['', 'The behaviour is the diagram\'s, whatever the code.', 'It is the last decision, taken after the diagram, and a tool can change it later.', 'For three states it costs more (51 against 32); it wins only with many states and few arcs into each.'],
    },
  ],
  fsmd: [
    {
      question: 'Why is a controller plus a datapath better than one state machine with a state per value of the data?',
      options: ['A register holds a number in n flip-flops, where a state per value would need 2ⁿ states', 'A controller is always faster', 'A datapath needs no clock', 'The states of a controller cannot have outputs'],
      answer: 0,
      explain: 'The datapath stores the numbers compactly and does arithmetic with adders; the controller keeps only the phase of the algorithm (a handful of states).',
      why: ['', 'Speed is not the point; the split is about size and clarity.', 'The datapath\'s registers are clocked by the same clock as the controller\'s.', 'A controller\'s states do have outputs: the load and select lines of the datapath.'],
    },
    {
      question: 'In the GCD machine, how does the controller know whether to subtract a − b or b − a?',
      options: ['A comparator in the datapath feeds status bits back to its next-state logic', 'It stores a and b in its states', 'It counts clock cycles', 'It reads the answer from memory'],
      answer: 0,
      explain: 'The status bits (a = b, a < b) are inputs of the controller\'s table; the arc taken in TEST picks SUBA, SUBB or DONE.',
      why: ['', 'The values live in the registers; the states are IDLE, TEST, SUBA, SUBB, DONE.', 'The number of subtractions depends on the data, not on a fixed count.', 'Nothing is read from memory; x and y come in on the data inputs.'],
    },
  ],
  debounce: [
    {
      question: 'A button bounces for up to 12 samples. What is the narrowest debounce counter that ignores every bounce, if a new level must last 2ⁿ samples?',
      options: ['4 bits (16 samples)', '3 bits (8 samples)', '12 bits', '2 bits (4 samples)'],
      answer: 0,
      explain: 'The counter must need more samples than the bounce lasts: 2ⁿ > 12 gives n = 4.',
      why: ['', '8 samples is less than 12: the longest bounce would be accepted as a press.', 'Bits count powers of two; twelve bits would wait 4096 samples.', 'Four samples are shorter than the bounce.'],
    },
    {
      question: 'Why does the button go through a synchronizer before the debouncer?',
      options: ['The raw button can change at any moment, even inside a flip-flop\'s setup window, where it may go metastable', 'The synchronizer removes the bounce', 'The debouncer cannot count without it', 'To make the press arrive earlier'],
      answer: 0,
      explain: 'The first flip-flop may be undecided for a while, so the second looks a cycle later. After that the signal is on the machine\'s own clock and the debouncer\'s flip-flops are safe.',
      why: ['', 'It passes every change on, bounces included; they are the debouncer\'s to remove.', 'A counter counts clock edges; it does not need a synchronizer to run, only to read the button safely.', 'It adds two cycles of latency.'],
    },
  ],
};
