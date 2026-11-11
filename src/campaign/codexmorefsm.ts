// The fuller codex texts for the chapter "Designing state machines" (codexfsm.ts). Numbers are the chapter's, pinned by
// tests/content-fsm.test.ts.

import type { CodexMore } from './codexmore';

const at = (step: number, label: string) => ({ chapter: 'fsm', step, label });

export const MOREFSM: Record<string, CodexMore> = {
  stateenc: {
    idea: `The flip-flops of a state machine hold numbers, so every state needs a code, and the choice is made last, after the diagram: it changes what the machine costs, not what it does. <b>Binary</b> numbers the states in order, with the fewest flip-flops (⌈log₂ n⌉), but each next-state bit decodes the whole register. <b>Gray</b> orders the codes so that adjacent states differ in one bit: useful when the register is read by something outside the clock, or when the common transitions should switch few wires. <b>One-hot</b> uses a flip-flop per state, exactly one of them 1: testing a state reads one flip-flop, and a next-state bit is the OR of the arcs that enter its state, however many states there are. The cost moves from logic to flip-flops. FPGAs, rich in flip-flops, synthesize machines one-hot by default.`,
    example: {
      title: 'The 101 detector in three codes (NANDs: flip-flops · logic · total)',
      body: `<pre>            flip-flops  logic  total   Moore (4 states)
binary           2     10     32    36
Gray             2     15     37    51
one-hot          3     18     51    74</pre>For three states binary wins. One-hot starts to pay at a dozen states with one or two arcs into each: its logic per bit stays an OR of a few terms while a binary code's grows with every state it must decode.`,
    },
    mistakes: [
      'Choosing the code before drawing the diagram: it is the last decision, and a tool can try all three.',
      'Counting only flip-flops: binary has the fewest, but the logic that decodes them can cost more than the flip-flops saved.',
      'Forgetting the codes nobody uses: a binary machine with 5 states has 3 unused codes, a one-hot one with 5 has 27. Each needs an arc back to a real state, or a glitch can strand the machine.',
    ],
    lib: 'rv16_det101',
    chapters: [at(2, 'Three ways to number the states'), at(4, 'Reset, and the codes nobody uses')],
  },
  fsmd: {
    idea: `A state machine alone remembers where it is, not a number. Real control splits the work: the <b>controller</b> is a small state machine; the <b>datapath</b> is registers, an arithmetic unit, comparators and the multiplexers between them. A state's action is a register transfer (a := a − b), which the controller turns into control lines (load a, select the subtractor); an arc may test the datapath (a &lt; b), whose comparator feeds a status bit back to the controller's next-state logic. The controller's table is therefore an ordinary one with status bits among its inputs and control lines among its outputs. Euclid's GCD by subtraction is the classic: five states (IDLE, TEST, SUBA, SUBB, DONE) over two 8-bit registers, one subtractor shared by both subtractions and a comparator.`,
    example: {
      title: 'gcd(48, 18)',
      body: `<pre>edge  state  a   b
  1    TEST  48  18
  2    SUBA  48  18
  3    TEST  30  18
  4    SUBA  30  18
  5    TEST  12  18
  6    SUBB  12  18
  7    TEST  12   6
  8    SUBA  12   6
  9    TEST   6   6
 10    DONE   6   6</pre>10 edges from start = 1. The controller is 76 of the machine's 678 NANDs, 11 %; the rest is the datapath.`,
    },
    mistakes: [
      'Giving every value of the data its own state: 256 states for an 8-bit register. The datapath holds the number, the controller the phase.',
      'Forgetting that the status bits are one cycle old: the comparator reads the registers as they are now, not as the transfer in this state will leave them.',
      'Putting the arithmetic in the next-state logic: a subtractor inside the controller is a datapath hidden from the diagram.',
    ],
    chapters: [at(6, 'A controller and a datapath')],
  },
  debounce: {
    idea: `A pressed button does not close once: its contacts make and break for a few milliseconds. A state machine sampling it every cycle counts each bounce as a press. The fix is to accept a new level only after it has lasted, with a counter: count clock samples while the input differs from the output, clear the count the moment they agree, and when it reaches 2<sup>n</sup> − 1 with the input still different, take the new level. A bounce that ends sooner never reaches the output. Because the input is asynchronous, it passes first through a two-flip-flop synchronizer, which gives the first flip-flop a full cycle to settle before anything else looks; the debouncer then sees a signal on its own clock. A 3-bit counter needs 8 samples in a row: 5 ms of bounce at a 1 kHz clock is 5 samples, so 3 bits suffice and a press is seen 8 ms late.`,
    example: {
      title: 'Which counter width?',
      body: `<pre>bounce lasts b samples at most  →  smallest n with 2ⁿ > b
b = 5   →  n = 3   (8 samples, 8 ms at 1 kHz)
b = 12  →  n = 4   (16 samples)
b = 40  →  n = 6   (64 samples)</pre>The delay of a press is 2ⁿ samples; nothing humans press is that slow.`,
    },
    mistakes: [
      'Debouncing an asynchronous signal directly: the counter\'s own flip-flops can go metastable. Synchronize first.',
      'Debouncing the press but not the release: both edges bounce.',
      'Sizing the counter in milliseconds, not in samples: the counter counts clock edges, so the clock rate sets the time.',
    ],
    lib: 'debounce3',
    chapters: [at(7, 'Inputs from outside: synchronize and debounce')],
  },
};
