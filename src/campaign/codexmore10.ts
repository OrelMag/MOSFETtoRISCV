// The fuller codex for verification and test (codexverify.ts holds the summaries). Every number is measured
// (tests/content-codexverify.test.ts pins them). No DOM.

import type { CodexMore } from './codexmore';

const V = (step: number, label: string) => ({ chapter: 'verify', step, label });

export const MORE10: Record<string, CodexMore> = {
  golden: {
    idea: 'To check a circuit you need an <b>oracle</b>: something other than the circuit that says what the answer should be. For a CPU it is the golden model, an instruction-set simulator written from the specification in a few hundred lines of ordinary code, sharing nothing with the gates.<br><b>Lock step</b> runs both. Whenever the hardware retires an instruction, the model executes the same one, and the PC, all 32 registers and, after a store, the memory word are compared. A pipeline holds several instructions at once; only a retired one has changed the state the model knows, so the comparison waits for retirement. A CPU that retires two a cycle reports how many, and the model steps that many times.<br>The first mismatch is the point: it names the instruction, the cycle and the register, where a final-state comparison says only "x7 is wrong".',
    example: { title: 'A forwarding fault, caught', body: '<pre>addi t0, x0, 7      gates and model: t0 = 7\nadd  t1, t0, t0     gates: t1 = 7   model: t1 = 14\n                    ↑ first mismatch</pre>forwardA[1] stuck at 0: forward A never takes the value waiting in M and reads the register file\'s stale 0; forward B still takes 7. 0 + 7 = 7.' },
    mistakes: [
      'Comparing only at the end, or only the registers: a store to the wrong address leaves every register right.',
      'Trusting the model because the CPU agrees with it: both were written from the same reading of the specification. A shared misreading passes every lock-step comparison; it takes an outside oracle (the riscv-tests, Spike) to see it.',
      'Comparing every cycle in a pipeline: half-finished instructions have not changed the architectural state yet.',
    ],
    chapters: [{ chapter: 'cpu', step: 5, label: 'Run real programs' }, V(1, 'The golden model in lock step'), V(6, 'A second oracle')],
  },
  selfcheck: {
    idea: 'A test that carries its own expected answers needs no second model to judge it. Each case computes a result, compares it with the value the specification gives, and on the first difference reports which case failed. The riscv-tests, written by the RISC-V community, are built this way: one program per instruction, a few dozen cases each, chosen at the edges (0, −1, the most negative number, shifts by 31).<br>The verdict is one word: <code>tohost</code> = 1 when every case passes, (case &lt;&lt; 1) | 1 at the first failure. The same image judges the golden model, every CPU in lanes of the bit-parallel simulator, and the hardware of anyone else.',
    example: { title: 'alu.slt stuck at 0', body: '<pre>32 rv32ui tests run on the pipeline\nslt    fails at case 4\nslti   fails at case 4\nthe other 30 pass</pre>Cases 1–3 expect 0, which a stuck-at-0 comparison gives anyway; case 4 is the first whose answer is 1. Every other instruction passes: the self-checking tests point straight at one ALU output.' },
    mistakes: [
      'Reading "all tests pass" as "correct": each case checks one instruction alone. Two instructions meeting in a pipeline is where most pipeline bugs live, and no single-instruction test makes them meet.',
      'Expected values computed by the code under test: then the test checks that the code agrees with itself.',
    ],
    chapters: [V(2, 'Who checks the checker? riscv-tests')],
  },
  fuzzing: {
    idea: 'Nobody writes a test for every pair of instructions in every pipeline state. A random program generator draws programs nobody wrote, weighted towards the meetings that matter: sources taken from the last few destinations, branches right after loads, edge values. Each runs to its halt on the golden model and on the gates, and the final states are compared; a failure is replayed in lock step to find where.<br>A failing program is mostly noise. <b>Delta debugging</b> deletes halves, then quarters, then single instructions, keeping each deletion that leaves the program still failing (still assembling, still halting on the model), until nothing more can go. What remains is the bug\'s recipe and the regression test for its fix.',
    example: { title: 'The FP pipeline\'s old bug', body: '<pre>first 64 seeds:     3 fail (3, 15, 42)\nseed 3:             111 instructions\nafter shrinking:      4</pre>A taken branch in E while D waits on an FP interlock: the stall held the PC the branch had to load. With p = 3 / 64, one batch of 32 misses the bug with probability (61/64)³² ≈ 22 %; 256 programs miss it with probability under 0.01 %.' },
    mistakes: [
      'Expecting random programs to find the golden model\'s bugs: they compare against it, so a model and a CPU that agree on a misreading pass.',
      'A generator that never draws an instruction never tests it: measure what it reaches (coverage).',
      'Keeping the 111-instruction program as the regression test: the shrunk one fails for the same reason and can be read.',
    ],
    chapters: [V(3, 'Random programs'), V(4, 'Make it small')],
  },
  coverage: {
    idea: 'A passing suite says nothing about what it never touched. Coverage counts what was exercised, against a list of points someone wrote down: here, each RV32I instruction executed by the golden model, and each pipeline event the gates\' own hazard unit produced (forwarding from M and from W on each operand, the write-back bypass, the load-use stall, the flush after a taken branch).<br>Industrial teams add <b>cross coverage</b>, combinations of points (this hazard in this stage while that one holds), and steer random tests at the points still empty. Reaching them all is how a block is signed off; it is a measure of the tests, not a proof of the design.',
    example: { title: 'Samples against random programs', body: '<pre>                 instructions   events\nPrimer sample      13 / 31       7 / 7\n32 random progs    31 / 31       7 / 7</pre>The FP pipeline\'s PC-enable bug was found after every instruction and every event was covered: it needs a taken branch <em>while</em> an FP interlock holds D, a cross no single event counts.' },
    mistakes: [
      'Treating 100 % as done: the list of points is only as good as the person who wrote it.',
      'Counting lines of the golden model executed instead of hardware events: the model can be fully covered while the hazard unit never forwards.',
    ],
    chapters: [V(5, 'Coverage: what did the tests reach?')],
  },
  stuckat: {
    idea: 'A manufactured die can carry a short to ground, a short to the supply, a broken via or a transistor that never conducts: far too many kinds to test one by one. The <b>stuck-at fault model</b> stands in for most of them: one net reads 0, or 1, whatever its gate drives. It is crude and works: a test set that catches every stuck-at fault catches most real defects too.<br>Here the sites are the stems: every input bit and every NAND output, each stuck at 0 and at 1. A fault is caught by a vector when the faulty circuit\'s outputs differ from the good one\'s on it. Real tools add a fault for each fan-out branch (one reader\'s copy of a net), and other models for what stuck-at misses: transition faults (a gate too slow, caught only at speed), bridges between neighbouring wires.',
    example: { title: 'Counting the faults', body: '<pre>9-NAND full adder    3 inputs + 9 NANDs = 12 nets   24 faults\n4-bit ripple adder   9 inputs + 36 NANDs = 45 nets  90 faults</pre>The tester applies vectors at the pins and compares the outputs with the design\'s. One differing bit rejects the die.' },
    mistakes: [
      'Testing the function instead of the structure: "2 + 3 = 5" is one vector, and whether it catches a fault depends on whether it drives that net and opens a path from it.',
      'Confusing a manufacturing fault with a design bug: the tester compares with the design, so a design bug is on every die and passes every manufacturing test.',
    ],
    lib: 'full_adder',
    chapters: [V(7, 'A chip comes back from the fab')],
  },
  faultcov: {
    idea: 'Fault coverage is the share of modelled faults a test set catches. A <b>fault simulator</b> measures it: for each fault, simulate the faulty circuit on every vector and compare. Here it runs 32 vectors per pass, one per bit of a machine word.<br>Random vectors cover most faults fast and the rest slowly, because the last faults are each shown by few vectors. Choosing the smallest set that catches everything is set cover, NP-hard in general but exact for a small block: always taking the vector that catches the most remaining faults (greedy) is good, not always best. Production test uses random patterns for the bulk and generated ones (ATPG) for the tail, and every pattern costs tester time on every die.',
    example: { title: 'The adders', body: '<pre>                     faults  vectors  greedy  smallest\nfull adder              24        8       4         3\n4-bit ripple adder      90      512       4         3\n\nrandom vectors (ripple adder):  1  2  4  8 16\nfaults caught:                 40 60 76 88 90</pre>' },
    mistakes: [
      'Calling 99 % enough: at a million faults, 1 % is ten thousand untested places.',
      'Counting untestable faults against the test: a fault on redundant logic cannot change any output; it is reported apart.',
    ],
    chapters: [V(8, 'Fault coverage')],
  },
  atpg: {
    idea: 'Automatic test pattern generation finds a vector for one chosen fault without trying them all. PODEM (Goel, 1981) searches over input values only, simulating forward after each choice with two values per net, the good circuit\'s and the faulty one\'s:<br><b>Activate</b>: the faulty net must carry the opposite of its stuck value. <b>Propagate</b>: pick a gate where the difference has arrived and open it, its other inputs at the value that lets a change pass (1 for a NAND). <b>Justify</b>: trace each needed value back to an input and set it. On a contradiction, flip the last choice; when every choice is used up, the fault is <b>untestable</b>, and the logic it sits on was not needed.',
    example: { title: 'The consensus circuit', body: '<pre>y = a·b + ¬a·c + b·c        (b·c is redundant)\n20 faults, 19 caught by some vector\nthe b·c NAND stuck at 1: untestable</pre>Whenever b·c = 1, one of the other two terms is 1 already, so that NAND\'s output never decides y. The search tries every assignment and proves it.' },
    mistakes: [
      'Reading "untestable" as "harmless": the redundant gate still costs area and power, and a second fault can unmask the first.',
      'Running ATPG for every fault: each new vector is fault-simulated against all the faults left, and drops every one it happens to catch.',
    ],
    lib: 'consensus',
    chapters: [V(9, 'ATPG in miniature')],
  },
  scan: {
    idea: 'Faults behind flip-flops are hard to reach: to put a counter in state 6 a tester has to count to it, and a fault shows at the pins only cycles later. A <b>scan flip-flop</b> puts a 2:1 multiplexer in front of D. With scan enable se = 0 it is the ordinary flip-flop; with se = 1 it takes si, and the chip\'s flip-flops chained q → si form one long shift register.<br>A test is shift, capture, shift: shift a state in (one clock per flip-flop), one normal clock with se = 0, then shift the answer out while the next state shifts in. Every flip-flop becomes an input and an output the tester controls, and the logic between them is tested with the combinational methods. Split the flip-flops into k chains, at two pins each, and every pattern shifts k times faster.',
    example: { title: 'Full scan on the pipelined CPU', body: '<pre>flip-flops              2 676\nmultiplexer each            4 NANDs\nadded                  10 704 NANDs\nthe CPU                68 957 NANDs   +15.5 %\none chain:  2 676 shift clocks a pattern</pre>' },
    mistakes: [
      'Forgetting the scan path\'s timing: q to the next si is a short wire, a hold-time race when the clock arrives late. Chains are ordered by placement and padded where needed.',
      'Shifting the wrong way: the first bit shifted in must end in the last flip-flop of the chain.',
    ],
    lib: 'scan_dff',
    compare: ['dff'],
    chapters: [V(10, 'Scan chains')],
  },
  lfsr: {
    idea: 'Shift the register one place and feed in the XOR of a few chosen bits, the <b>taps</b>. The map from one state to the next is linear over GF(2); when the taps are the exponents of a primitive polynomial the state runs through every non-zero value, 2ⁿ − 1 of them, before repeating. The all-zero state maps to itself, so a register that wakes up as 0 never starts.<br>That makes it the cheapest source of pseudo-random bits there is: one XOR for 4 bits, a handful of gates for 32. It generates test patterns on chips (BIST), scrambles serial links so long runs of equal bits never happen, and computes CRCs when the data is XORed in as it shifts.',
    example: { title: 'Four bits, taps 4 and 3', body: '<pre>0001 → 0010 → 0100 → 1001 → 0011 → 0110 → 1101 → 1010\n→ 0101 → 1011 → 0111 → 1111 → 1110 → 1100 → 1000 → 0001</pre>15 states, every non-zero 4-bit value once. The 9-bit LFSR of the self-test runs 511.' },
    mistakes: [
      'Seeding it with 0: XOR feedback locks up there.',
      'Using successive n-bit states as random numbers: each is the last one shifted, so neighbours share n − 1 bits.',
      'Using it where security matters: 2n consecutive output bits reveal the taps.',
    ],
    lib: 'lfsr4',
    chapters: [{ chapter: 'registers', step: 7, label: 'LFSR: cheap pseudo-random' }, V(11, 'The chip tests itself')],
  },
  bist: {
    idea: 'A tester\'s pins are slow next to the chip\'s own clock, and its time is paid for every die. <b>Built-in self-test</b> puts the tester on the die: an LFSR generates a new pattern every clock and a <b>multiple-input signature register</b> (MISR), an LFSR with the block\'s outputs XORed into its state, folds every answer into one word. After the last pattern a single comparison passes or fails the block.<br>Compression costs a little: a wrong answer stream can fold into the good signature (aliasing), about one stream in 2ⁿ for an n-bit MISR, so real ones are 32 bits or more. Memories use a different self-test, a March test, since their faults sit in cells and between neighbours: March C− finds every single stuck, transition, coupling and decoder fault in 10 operations a word.',
    example: { title: 'The 4-bit adder testing itself', body: '<pre>9-bit LFSR → the adder\'s 9 inputs\n5-bit MISR ← its 5 outputs\n32 clocks, 90 faults:  89 change the signature\n                        1 escapes (aliases)</pre>The 32 patterns show every fault at the outputs; the one that escapes is lost in the compression, not the patterns.' },
    mistakes: [
      'Reading a good signature as a good block: aliasing lets a few faulty streams through, fewer the wider the MISR.',
      'Testing a memory with all zeros then all ones: it finds no decoder fault (two addresses on one word read back what was written).',
    ],
    lib: 'misr5',
    chapters: [V(11, 'The chip tests itself'), V(12, 'What a CPU costs to test')],
  },
};
