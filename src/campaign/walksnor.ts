// Walkthroughs of the NOR3 ladder (buildnor.ts): the reference answers of lib/agcnor.ts, part by part. Part ids are
// the answers' instance names: a gate is g_<the net it drives>, a block its own name (xa, mux, master …).
import type { WalkScript } from './walk';

export const WALKSNOR: Record<string, WalkScript> = {
  nor_basic: [
    {
      title: 'Two inverters',
      text: 'g_na is a NOR3 with a on all three inputs: it is 1 only while a is 0, so it is ¬a, the na output. g_nb does the same for b.',
      parts: ['g_na', 'g_nb'], codex: ['demorgan'],
      why: 'A NOR is 1 only when every input is 0. With one signal on every input that is the NOT of it, so the brick gives its own inverter as NAND does.',
      whyNot: { text: 'Leaving the spare inputs open would not work: at switch level an input nothing drives is undefined, and a floating input can turn its transistor on. Tie spares to a used input.' },
    },
    {
      title: 'OR: a NOR and a NOT',
      text: 'g_nab is the NOR of a and b (its third input tied to b). g_o inverts it: o = a + b. Two gates where NAND needed three.',
      parts: ['g_nab', 'g_o'],
      why: 'NOR is OR with its output inverted, so one more inversion gives OR back. NOR makes OR cheap the way NAND makes AND cheap.',
      whyNot: { text: 'An OR by De Morgan from inverted inputs, ¬(¬a·¬b), needs an AND of the inverted inputs: in NOR3 gates that is more gates, not fewer.' },
    },
    {
      title: 'AND from the two inverters',
      text: 'g_y is the NOR of na and nb: 1 only when both are 0, so when a and b are both 1. y = a·b, reusing the ¬a the na output already has. 5 gates in all: par.',
      parts: ['g_y'], codex: ['duality'],
      ask: {
        question: 'Which NOR3 gives y = a·b, given ¬a and ¬b?',
        options: ['NOR3(¬a, ¬b, ¬b)', 'NOR3(a, b, b)', 'NOR3(¬a, b, b)', 'NOR3(a, ¬b, ¬b)'],
        answer: 0,
        explain: 'De Morgan: a·b = ¬(¬a + ¬b). A NOR of the two inverted inputs is 1 only when both are 0, that is when a and b are both 1.',
        why: ['', 'That is ¬(a + b), 1 only when both are 0: the NOR itself.', 'That is a·¬b: 1 only when a = 1 and b = 0.', 'That is ¬a·b: 1 only when a = 0 and b = 1.'],
      },
      why: 'NAND makes AND from a NAND and a NOT; NOR makes it from inverted inputs and a NOR. Each brick finds one of the two cheap and pays for the other.',
      whyNot: { text: 'NOR then NOT gives OR, not AND: the inversion has to go on the inputs to swap OR for AND.' },
    },
  ],
  nor_fa: [
    {
      title: 'The first half: ¬(a ⊕ b)',
      text: 'xa is four NORs: n1 = NOR(a, b), then NOR(a, n1) and NOR(b, n1), then the NOR of those two. They are the four gates of the NAND adder\'s XOR, each a NOR, and they give h = ¬(a ⊕ b); n1 comes out too, for the carry.',
      parts: ['xa'], codex: ['duality'],
      why: 'Swapping every NAND for a NOR turns each function into its dual: the NAND XOR becomes an XNOR. The second half inverts it back for free.',
      whyNot: { text: 'An XOR built as OR · NAND costs more NOR3 gates, and the four-gate pattern shares n1 with the carry.' },
    },
    {
      title: 'The second half and the sum',
      text: 'xb is the same block on h and ci: its first gate gives n5 = NOR(h, ci), its output s = ¬(h ⊕ ci) = a ⊕ b ⊕ ci.',
      parts: ['xb'],
      ask: {
        question: 'The NAND adder\'s wiring with every gate a NOR: why does s still come out as a ⊕ b ⊕ ci?',
        options: ['The three-input XOR is its own dual: inverting every input and the output gives the same function', 'A NOR is the same gate as a NAND at switch level', 'The second half undoes the first half\'s mistake by chance', 'It does not: s comes out inverted'],
        answer: 0,
        explain: 'Every NAND turned NOR computes the dual function, f with all inputs and the output inverted. ¬(¬a ⊕ ¬b ⊕ ¬c) = a ⊕ b ⊕ c: an odd number of inputs makes XOR self-dual, so the sum is unchanged.',
        why: ['', 'A NAND is 0 only when all inputs are 1, a NOR is 1 only when all are 0: different gates, dual functions.', 'There is no chance in it: the result follows from duality for every input row.', 'Two inputs would invert (a two-input XOR becomes XNOR), but with three the inversions cancel.'],
      },
      why: 'The dual of a ⊕ b ⊕ c is itself, so the dual network adds. The two-input XOR is not self-dual, which is why h came out inverted halfway.',
    },
    {
      title: 'The carry',
      text: 'g_co = NOR(n1, n5): the majority of a, b and ci, the carry out. Nine NOR3 gates, 27 transistors and 36 resistors: par. The same nine as CMOS NANDs are 36 transistors.',
      parts: ['g_co'], codex: ['majority'],
      why: 'The majority is self-dual too, so the NAND adder\'s carry gate, made a NOR, gives the carry again.',
      whyNot: { text: 'With all three inputs of a NOR3 used, the majority alone is NOR3(NOR(a, b), NOR(b, ci), NOR(a, ci)): four gates, but they share nothing with the sum.' },
    },
  ],
  nor_reg: [
    {
      title: 'The enable\'s multiplexer',
      text: 'mux makes ¬en and ¬d, then en·d = NOR(¬en, ¬d) and ¬en·q = NOR(en, ¬q) (¬q is the slave\'s qn), their NOR mn = ¬m, and one more gate m: m = en ? d : q, six gates.',
      parts: ['mux'],
      why: 'A register that holds must feed its own q back while en = 0: a multiplexer in front of the flip-flop, as in your NAND register, never a gate on the clock.',
      whyNot: { text: 'An AND of en into clk makes edges of its own when en changes while clk is high, and delays this clock against every other.' },
    },
    {
      title: 'The master latch',
      text: 'master is two gates, NOR(mn, en_n) and NOR(m, en_n), setting and resetting a cross-coupled NOR pair. Its en_n is clk itself: it listens only while clk = 0.',
      parts: ['master'], codex: ['dlatch'],
      ask: {
        question: 'Two NOR gates, each reading the other\'s output, with both set and reset at 0. What do they do?',
        options: ['Hold whichever of the two states they were in', 'Oscillate', 'Both outputs go to 1', 'Both outputs go to 0'],
        answer: 0,
        explain: 'With set and reset at 0, each gate is a NOT of the other: q = ¬qn and qn = ¬q. Both (1, 0) and (0, 1) satisfy that, so the pair keeps the one it was put in: a bit of memory.',
        why: ['', 'Two inverters in a ring have two stable states; only an odd number of inversions oscillates.', 'A NOR outputs 1 only when all its inputs are 0: two 1s would each force the other to 0.', 'Two 0s would make both NORs see only 0s and go to 1: not stable.'],
      },
      why: 'A latch from the brick alone. Gating set and reset with clk makes it listen only during one phase.',
    },
    {
      title: 'The slave latch and q',
      text: 'g_ckn = ¬clk opens slave, the same latch, while clk = 1. It takes the master\'s q and ¬q, so it needs no inverter of its own: q takes what the master held at the rising edge. 6 + 4 + 1 + 4 = 15 NOR3 gates: par.',
      parts: ['g_ckn', 'slave'],
      why: 'The master listens while clk = 0 and the slave while clk = 1, so a value crosses only at the rising edge and cannot run round a loop twice in one cycle.',
      whyNot: { text: 'Both latches on the same phase make one transparent latch: d changing while clk is high would reach q.' },
    },
  ],
};

export const NUDGESNOR: Record<string, string> = {
  nor_basic: 'A NOR3 with its inputs tied is a NOT; think about where NOR puts the inversion, and move it with De Morgan.',
  nor_fa: 'Take the 9-NAND full adder you know and ask what changes if every gate is a NOR.',
  nor_reg: 'Two NORs crossed hold a bit. Build a latch, use it twice on opposite clock phases, then put the enable in front.',
};
