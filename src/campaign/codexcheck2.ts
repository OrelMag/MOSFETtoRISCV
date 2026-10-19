// Check yourself questions for codex entries (see codexcheck.ts), group 2. No DOM.
// Encodings, li splits and step counts checked with asm16 / iss16; NAND counts and depths with stats / logicDepth.

import type { Quiz } from '../chapters/types';

export const CHECK2: Record<string, Quiz[]> = {
  // ---- the big picture
  cpu: [
    {
      question: 'On the golden model, how many steps does this take, halt included?<br><code>li a0, 3 · loop: addi a0, a0, -1 · bnez a0, loop · sw a0, -3(x0) · halt</code>',
      options: ['9', '8', '10', '6'],
      answer: 0,
      explain: 'li once, the two-instruction loop three times (a0 = 2, 1, 0), then sw and halt: 1 + 3 × 2 + 1 + 1 = 9.',
      why: ['', 'halt is an instruction too (<code>jal x0, 0</code>): the model executes it as a step before it stops.', 'The loop body runs three times, not four: bnez falls through as soon as a0 reaches 0.', 'That counts only the loop; li, sw and halt are steps as well.'],
    },
    {
      question: '<code>rv16_cpu</code> holds 128 flip-flops of its own. What are they?',
      options: ['16 for the PC and 7 × 16 for x1–x7', '8 × 16 for x0–x7; the PC lives in the instruction memory', '16 for the PC, 16 for an instruction register, 96 for six registers'],
      answer: 0,
      explain: 'The architectural state inside the core is the PC and the seven writable registers; x0 is a constant and both memories sit outside.',
      why: ['', 'x0 is wired to 0 and needs no storage, and the PC is the core\'s own register: it addresses the ROM, it is not stored in it.', 'A single-cycle core has no instruction register: the ROM\'s output feeds decode directly for the whole cycle.'],
    },
  ],
  fde: [
    {
      question: 'Which step does <code>sw a1, 3(a0)</code> not use?',
      options: ['Execute', 'Memory', 'Write back', 'Decode'],
      answer: 2,
      explain: 'A store changes memory, not a register: register write is off, so write back does nothing for it.',
      why: ['The ALU computes the address a0 + 3 in execute.', 'Memory is where the store happens: the data RAM is written at the clock edge.', '', 'Decode reads both a0 (the base) and a1 (the data) and builds the split S immediate.'],
    },
    {
      question: 'Which change would <b>not</b> shorten <code>rv16_cpu</code>\'s 98-delay period?',
      options: ['A faster ALU adder', 'A faster register-file read (7 → 3 delays)', 'A faster instruction ROM', 'A faster control unit'],
      answer: 1,
      explain: 'The register read (7) starts with the instruction and runs in parallel with the control unit (13) and the immediate mux, so it is off the critical path; shortening it changes nothing.',
      why: ['The ALU is 50 of the 98 delays on the load path: a faster adder shortens the period directly.', '', 'The ROM read is the first block on the critical path; every delay saved there is saved on the period.', 'The control unit sits on the load path before the immediate mux; the register read is the parallel branch that has slack.'],
    },
  ],
  abstraction: [
    {
      question: 'An 8:1 multiplexer of 16-bit words is one symbol. How many two-input muxes are inside?',
      options: ['112', '7', '16', '128'],
      answer: 0,
      explain: 'Each bit needs a tree of 7 two-input muxes to pick 1 of 8, and there are 16 bits: 7 × 16 = 112.',
      why: ['', 'That is one bit\'s tree; a 16-bit word repeats it 16 times.', 'One mux per bit chooses between 2 words, not 8.', 'A tree selecting 1 of 8 has 7 nodes, not 8.'],
    },
    {
      question: 'A design uses three 16-bit ripple-carry adders. Switching the full adder from the 13-NAND to the 9-NAND version saves how many NANDs?',
      options: ['192', '4', '12', '48'],
      answer: 0,
      explain: 'The saving is paid back once per copy: 4 NANDs × 16 full adders × 3 adders = 192.',
      why: ['', 'That is the saving in one full adder; the design holds 48 of them.', 'That counts one saving per adder, but each adder contains 16 full adders.', '48 is the number of full adders, each of which saves 4 NANDs.'],
    },
  ],

  // ---- transistors and gates
  cmos: [
    {
      question: 'A 3-input CMOS NAND sees a = 1, b = 1, c = 0. Which network conducts?',
      options: ['The pull-up: c\'s PMOS is on, output 1', 'The pull-down: two of its three NMOS are on, output 0', 'Both, partly: the output is X', 'Neither: the output floats'],
      answer: 0,
      explain: 'NAND\'s NMOS are in series, so c = 0 breaks the pull-down; its PMOS are in parallel, so c = 0 alone connects the output to VDD.',
      why: ['', 'The NMOS are in series: the pull-down conducts only when all three are on.', 'The networks are duals, so for every input exactly one conducts; that is CMOS\'s point.', 'One PMOS in the parallel pull-up is enough, and c\'s is on.'],
    },
    {
      question: 'How is a 3-input CMOS NOR built?',
      options: ['6 transistors: three PMOS in series, three NMOS in parallel', '6 transistors: three PMOS in parallel, three NMOS in series', '3 NMOS in parallel with a resistor pull-up'],
      answer: 0,
      explain: 'NOR is 0 if any input is 1 (NMOS in parallel to GND) and 1 only if all are 0 (PMOS in series to VDD).',
      why: ['', 'That is the 3-input NAND: series NMOS pull down only when every input is 1.', 'That is pseudo-NMOS: it works, but current flows from VDD to GND whenever the output is 0, which CMOS avoids.'],
    },
  ],
  fanin: [
    {
      question: 'Logical effort of a 4-input NAND and a 4-input NOR, (n + 2)/3 and (2n + 1)/3?',
      options: ['NAND 2, NOR 3', 'NAND 3, NOR 2', 'Both 4: one unit per input', 'Both 1: one stage each'],
      answer: 0,
      explain: 'NAND: (4 + 2)/3 = 2. NOR: (2·4 + 1)/3 = 3; its four PMOS in series, made of the slower carrier, cost more than NAND\'s four series NMOS.',
      why: ['', 'Swapped: it is NOR whose series transistors are PMOS, which conduct 2–3× worse than NMOS.', 'Logical effort grows with fan-in, but not one-for-one with the number of inputs.', 'One stage is not one unit of effort: a series stack drives worse than an inverter of the same input capacitance.'],
    },
    {
      question: 'What does an 8-input AND cost in this simulator (<code>andN(8)</code>)?',
      options: ['14 NANDs, depth 6', '2 NANDs, depth 2: an 8-input NAND and an inverter', '14 NANDs, depth 14', '7 NANDs, depth 3'],
      answer: 0,
      explain: 'Wide gates are trees of 2-input ANDs: 7 ANDs of 2 NANDs each, 3 levels of 2 delays.',
      why: ['', 'The simulator has only 2-input NANDs; in silicon an 8-high NMOS stack would be far too slow anyway.', 'That is a chain; <code>andN</code> is a balanced tree, 3 levels deep.', 'A 2-input NAND gives ¬(a·b): each AND is two NANDs and two delays.'],
    },
  ],
  depth: [
    {
      question: 'A 32-input OR from 2-input ORs (3 NANDs, depth 2 each): depth as a chain and as a balanced tree?',
      options: ['Chain 62, tree 10, both 93 NANDs', 'Chain 31, tree 5', 'Chain 62, tree 10, but the tree needs about twice the NANDs', 'Chain 62, tree 32'],
      answer: 0,
      explain: 'Both use 31 ORs. The chain puts all 31 on one path (62 delays); the tree has log<sub>2</sub> 32 = 5 levels (10 delays).',
      why: ['', 'That counts OR gates, not NAND delays: each OR is two.', 'A balanced tree of a binary associative operation uses the same n − 1 gates as a chain.', 'A tree\'s depth grows with log<sub>2</sub> n, not n.'],
    },
    {
      question: 'You time a 16-bit ripple-carry adder (depth 36) by toggling a<sub>15</sub> only. What do you see?',
      options: ['Far less than 36: the longest path starts at bit 0 or cin', 'Exactly 36: depth is the same from every input', 'More than 36: the top bit has the most logic'],
      answer: 0,
      explain: 'a<sub>15</sub> only reaches the top sum bit and the carry out through one stage; the 36-delay path ripples from bit 0 through every carry.',
      why: ['', 'Depth is the longest path over all inputs; each input has its own, shorter or equal.', 'Every bit slice has the same logic; the top one is late only because of the carry arriving from below.'],
    },
  ],
  bus: [
    {
      question: 'What does an 8-bit 2:1 bus multiplexer cost here (<code>busMux2(8)</code>)?',
      options: ['32 NANDs, depth 3', '4 NANDs, depth 3', '32 NANDs, depth 24', '8 NANDs, depth 1'],
      answer: 0,
      explain: 'A bus operation is one 1-bit circuit per bit: 8 muxes of 4 NANDs, all in parallel, so depth stays 3. One ¬s shared by every bit would make it 25; busMux2 keeps each slice whole.',
      why: ['', 'One 1-bit mux switches one wire; an 8-bit bus needs 8.', 'The 8 slices work side by side, not in series: depth is that of one slice.', 'A 1-bit mux is 4 NANDs (inverter, two NANDs, a NAND to combine), depth 3.'],
    },
    {
      question: 'Two blocks drive one bus wire directly, with no mux or tri-state driver. One drives 1, the other 0. What does the simulation show?',
      options: ['X: contention', 'The later block wins', 'The OR of the two', 'Z: the drivers cancel'],
      answer: 0,
      explain: 'Two active drivers fight; the value is undefined (and in silicon a short from VDD to GND).',
      why: ['', 'Nothing orders them: both drive at once, all the time.', 'A wired-OR needs open drivers and a pull-down; CMOS outputs drive both ways.', 'Z means no driver at all; here there are two.'],
    },
  ],

  // ---- numbers
  positional: [
    {
      question: 'Shift 0xC000 (49,152) left by one at 16 bits. The result?',
      options: ['0x8000 (32,768)', '0x18000 (98,304)', '0x6000 (24,576)'],
      answer: 0,
      explain: 'Every bit moves up one place and the top bit falls off: 1100… becomes 1000…, which is not double.',
      why: ['', 'Doubling needs a 17th bit; a 16-bit register drops it.', 'That is a right shift, which halves.'],
    },
    {
      question: 'How many bits does the unsigned number 1,024 need?',
      options: ['10', '11', '9'],
      answer: 1,
      explain: 'n bits reach 2<sup>n</sup> − 1; 10 bits stop at 1,023, so 1,024 = 2<sup>10</sup> is a 1 followed by ten 0s: 11 bits.',
      why: ['Off by one: 10 bits hold 0 … 1,023.', '', '9 bits reach only 511.'],
    },
  ],
  hex: [
    {
      question: '<code>0x0EF1</code> is an R-type word (op 0001). Which are rd and rs1?',
      options: ['rd = t1, rs1 = a2', 'rd = t1, rs1 = t0', 'rd = t1, rs1 = a0'],
      answer: 0,
      explain: '0000 1110 1111 0001: rd = bits 6:4 = 111 (x7, t1), rs1 = bits 9:7 = 101 (x5, a2), rs2 = bits 12:10 = 011 (a0): <code>add t1, a2, a0</code>.',
      why: ['', 'That reads rs1 off the digit E (bits 10:8 = 110), but rs1 is bits 9:7: its low bit is the top bit of the digit F.', 'a0 is rs2 (bits 12:10); rs1 is the field just above rd.'],
    },
    {
      question: 'Which RV16 field can always be read straight off a single hex digit?',
      options: ['op, the lowest digit', 'rd, the second digit', 'f3, the top digit', 'All of them: the fields follow the digits'],
      answer: 0,
      explain: 'Only op (bits 3:0) is a whole nibble. The 3-bit fields straddle digit boundaries.',
      why: ['', 'The second digit is bits 7:4: rd plus the lowest bit of rs1.', 'The top digit is bits 15:12: f3 (or immediate bits) plus the top bit of rs2.', 'Hex digits follow nibbles; RV16\'s 3-bit register fields do not.'],
    },
  ],
  twos: [
    {
      question: '−12 as a 16-bit two\'s-complement word?',
      options: ['0xFFF4', '0xFFF3', '0x800C'],
      answer: 0,
      explain: '12 = 0x000C, ¬12 = 0xFFF3, + 1 = 0xFFF4 (= 65,536 − 12).',
      why: ['', 'That is ¬12 alone, ones\' complement: off by one.', 'That is sign-magnitude (a sign bit on top of 12), which an ordinary adder does not add correctly.'],
    },
    {
      question: 'abs(x) at 16 bits is computed as <code>x &lt; 0 ? ¬x + 1 : x</code>. What does it return for x = 0x8000?',
      options: ['0x8000, still −32,768', '0x7FFF, saturated to 32,767', '0x0000', 'It traps'],
      answer: 0,
      explain: '¬0x8000 + 1 = 0x7FFF + 1 = 0x8000. +32,768 is not representable: the range is −32,768 … 32,767.',
      why: ['', 'Nothing saturates: the adder wraps modulo 2<sup>16</sup>.', '+32,768 does not wrap to 0: ¬0x8000 = 0x7FFF, and adding 1 gives 0x8000.', 'RV16 arithmetic never traps; it wraps.'],
    },
  ],
  overflow: [
    {
      question: '0x6000 + 0x3000 at 16 bits. Signed overflow V and carry out C?',
      options: ['V = 1, C = 0', 'V = 0, C = 1', 'V = 1, C = 1', 'V = 0, C = 0'],
      answer: 0,
      explain: '24,576 + 12,288 = 36,864 fits 16 bits unsigned (no carry), but two positives gave 0x9000, which reads negative: signed overflow.',
      why: ['', 'Carry out needs a sum ≥ 65,536; this one is 36,864. And the signed result is wrong.', 'Unsigned it fits, so there is no carry out.', '0x9000 has its top bit set: two positive operands produced a negative signed result.'],
    },
    {
      question: '0x8000 − 0x0001 = 0x7FFF at 16 bits. Which is true?',
      options: ['Signed overflow; unsigned it is correct', 'No overflow: the operands have different signs', 'Unsigned borrow: the result is smaller than both', 'The ALU traps'],
      answer: 0,
      explain: 'Signed: −32,768 − 1 does not fit and wraps to +32,767. Unsigned: 32,768 − 1 = 32,767 is correct, and a + ¬b + 1 carries out 1 (no borrow).',
      why: ['', 'That is the addition rule applied to a − b without inverting b: a subtraction overflows when the signs differ and the result has b\'s sign.', 'A borrow means b &gt; a unsigned; 1 &lt; 32,768.', 'RV16, like RISC-V, never traps on overflow: it wraps.'],
    },
  ],
  signext: [
    {
      question: 'The 6-bit immediate 100000, sign-extended to 16 bits?',
      options: ['0xFFE0 (−32)', '0x0020 (+32)', '0x8020'],
      answer: 0,
      explain: 'Bit 5 is the sign; copying it into bits 15:6 gives 1111 1111 1110 0000 = −32, the bottom of the −32 … 31 range.',
      why: ['', 'That is zero extension: the sign weight −32 becomes +32.', 'Moving the sign to bit 15 and keeping the magnitude is sign-magnitude, not two\'s complement.'],
    },
    {
      question: 'A buggy immediate generator zero-extends B offsets. A loop\'s closing <code>bne</code> has offset −4 (111100). Where does a taken branch go?',
      options: ['pc + 60', 'pc − 4, as intended', 'pc + 4'],
      answer: 0,
      explain: 'Zero-extended, 111100 reads 60: the loop jumps forward instead of back.',
      why: ['', 'The bits are the same, but their meaning is not: zero extension gives the top bit weight +32, not −32.', 'The value is 60, not the magnitude of −4.'],
    },
  ],
  majority: [
    {
      question: 'Which input pattern (a, b, cin) tells OR(a, b, cin) apart from a full adder\'s carry?',
      options: ['1, 0, 0', '1, 1, 0', '0, 0, 0', '1, 1, 1'],
      answer: 0,
      explain: '1 + 0 + 0 = 1 does not carry, so maj = 0, while OR = 1. The carry needs at least two 1s.',
      why: ['', 'Two 1s: the carry is 1 and so is OR.', 'Both are 0.', 'Both are 1.'],
    },
    {
      question: 'Logic depth of this site\'s 8-bit ripple-carry adder?',
      options: ['20', '48', '16', '8'],
      answer: 0,
      explain: 'The carry passes each bit through one majority gate at 2 delays, plus the first stage\'s entry and the top sum bit\'s XOR: 2n + 4 = 20.',
      why: ['', 'The carry does not go through a whole 6-deep full adder per bit: only through its 2-delay majority path.', 'That is the carry chain alone; the longest path also enters the first stage and leaves through the top sum bit.', 'Each majority gate costs 2 NAND delays, not 1.'],
    },
  ],

  // ---- state
  feedback: [
    {
      question: 'Five inverters in a ring (one NAND delay each). What does it do?',
      options: ['Oscillates with a period of 10 delays', 'Oscillates with a period of 5 delays', 'Holds a bit', 'Settles to 0'],
      answer: 0,
      explain: 'An odd number of inversions has no stable state. A change goes round once (5 delays) to flip the first node, and twice to bring it back: period 10.',
      why: ['', 'One trip round inverts every node; it takes a second trip to return to the start: twice the loop delay.', 'Only an even number of inversions has stable states.', 'No value is consistent with an odd ring: whatever a node holds, the loop brings back its inverse.'],
    },
    {
      question: 'Four inverters in a ring. What does it do?',
      options: ['Holds a bit: it has two stable states', 'Oscillates with a period of 8 delays', 'Settles to all zeros'],
      answer: 0,
      explain: 'An even ring is consistent in two ways (0101 and 1010 around the loop): a bit of memory, like two cross-coupled inverters.',
      why: ['', 'Oscillation needs an odd number of inversions; an even ring reinforces its value.', 'Adjacent nodes are inverses of each other, so the nodes cannot all be 0.'],
    },
  ],
  edge: [
    {
      question: 'An 8-bit counter: flip-flops (clk-to-q 3, setup 3) around an 8-bit incrementer of depth 17. Minimum period?',
      options: ['23', '17', '28', '39'],
      answer: 0,
      explain: 'One register-to-register path: clk-to-q + logic + setup = 3 + 17 + 3 = 23 NAND delays.',
      why: ['', 'The flip-flop\'s clk-to-q and setup are on the path too.', 'That adds the flip-flop\'s 11 NANDs as if they were all delay; the flip-flop contributes clk-to-q 3 and setup 3.', 'That is the 16-bit counter, whose incrementer has depth 33.'],
    },
    {
      question: 'The counter\'s flip-flops are replaced by transparent latches open while clk = 1, with a high phase much longer than the incrementer. What happens?',
      options: ['While the latches are open the value goes round the incrementer several times', 'Nothing: a latch is just a cheaper flip-flop', 'It counts on both edges, twice as fast'],
      answer: 0,
      explain: 'An open latch passes its input through, so the loop is combinational while clk = 1; how far it counts depends on the path delays.',
      why: ['', 'A flip-flop updates only at the edge; a latch is transparent for a whole phase, and the loop runs while it is.', 'Neither edge is special to a latch: it follows d for the whole open phase.'],
    },
  ],
  setuphold: [
    {
      question: 'clk-to-q 3, setup 3, and the longest logic between two registers is 40 NAND delays. Minimum period?',
      options: ['46', '40', '43'],
      answer: 0,
      explain: 'Period ≥ clk-to-q + longest logic + setup = 3 + 40 + 3.',
      why: ['', 'The register\'s own clk-to-q and the next one\'s setup are part of the cycle.', 'Both overheads count, not one.'],
    },
    {
      question: 'A shift register (q straight into the next d) fails because clock skew exceeds clk-to-q − hold. How do you fix it?',
      options: ['Add delay on the short path or reduce the skew', 'Lower the clock frequency', 'Shorten the longest path'],
      answer: 0,
      explain: 'A hold race happens just after one edge: the new value must not reach the next flip-flop before it has finished capturing the old one. The period plays no part.',
      why: ['', 'A hold violation does not depend on the period; the chip fails at every frequency.', 'The longest path matters for setup; this is the shortest path being too short.'],
    },
  ],
  harvard: [
    {
      question: 'The single-cycle RV16 is rebuilt with one single-port memory for code and data. What happens?',
      options: ['lw and sw need a second cycle: CPI > 1', 'Nothing: one memory is just a bigger address range', 'Every instruction takes two cycles'],
      answer: 0,
      explain: 'A load or store needs the instruction and a data access in the same cycle; one port can serve only one, so those instructions take two cycles.',
      why: ['', 'One port means one access per cycle; a load needs two.', 'Only instructions that touch data memory need a second access; the others fetch and are done.'],
    },
    {
      question: 'A program puts <code>.word 42</code> among its instructions at address 5, then runs <code>lw a0, 5(x0)</code>. What lands in a0?',
      options: ['Data memory word 5, whatever it holds', '42', 'A trap: address 5 holds code'],
      answer: 0,
      explain: 'lw reads the data RAM; instruction address 5 and data address 5 name different memories. Tables belong in <code>.data</code>.',
      why: ['', 'The 42 is in the instruction ROM, which lw cannot read.', 'Nothing checks the address against the program: the data RAM simply has its own word 5.'],
    },
  ],

  // ---- ISA and software
  isa: [
    {
      question: 'Which of these changes the ISA?',
      options: ['Making jal store pc + 2 in rd', 'Replacing the ripple ALU with Kogge–Stone adders', 'Adding static branch prediction', 'Adding a data cache'],
      answer: 0,
      explain: 'The link value is visible to every program that returns; the other three change only timing, which programs cannot observe.',
      why: ['', 'Results are identical; only the period changes.', 'Prediction changes how many cycles branches cost, not what any instruction does.', 'A cache changes access times, not values (MMIO aside, which it must bypass).'],
    },
    {
      question: 'gcd runs in 50 cycles on the single-cycle core and 83 on the plain pipeline. What must be identical between the two runs?',
      options: ['The register writes and stores, in order', 'The number of instructions fetched', 'The time in NAND delays'],
      answer: 0,
      explain: 'The ISA fixes what each instruction does to the state, so every implementation produces the same sequence of writes; that is what the checks compare with iss16.',
      why: ['', 'The pipeline also fetches wrong-path instructions after taken branches and flushes them.', 'Cycles and periods differ (50 × 98 against 83 × 78); time is the implementation\'s business.'],
    },
  ],
  rv16: [
    {
      question: 'Which of these <code>li</code> assembles to two words?',
      options: ['li a0, -40', 'li a0, 31', 'li a0, 320', 'li a0, -32'],
      answer: 0,
      explain: '−40 is outside addi\'s −32 … 31 and not a multiple of 64, so it is lui + addi (lui 0x3FF, then addi 24).',
      why: ['', '31 fits addi\'s 6-bit immediate: one word.', '320 = 5 × 64: lui alone loads it.', '−32 is the bottom of addi\'s range: one word.'],
    },
    {
      question: 'A <code>beq</code> must reach a label 40 words ahead. What does it take?',
      options: ['The inverted branch (bne) over a j to the label', 'Nothing: beq reaches ±256 words', 'beq with offset 20, since addresses count bytes'],
      answer: 0,
      explain: 'Branches reach −32 … 31 words; jal (j) reaches −256 … 255. So branch around a jump on the opposite condition.',
      why: ['', '±256 is jal\'s 9-bit reach; branches have 6 bits.', 'RV16 is word addressed: 40 words is offset 40.'],
    },
  ],
  formats: [
    {
      question: '<code>sw a1, 5(a0)</code> encodes as 0x11DE. A forwarding unit compares rd fields without checking register write. Which register does it think the store writes?',
      options: ['a2 (x5)', 'a1, the register stored', 'a0, the base', 'None: stores leave the field 0'],
      answer: 0,
      explain: 'S splits imm6 around rs2: imm[2:0] = 101 sits in rd\'s place, bits 6:4, and reads as x5 = a2.',
      why: ['', 'a1 is rs2 (bits 12:10).', 'a0 is rs1 (bits 9:7).', 'The bits are reused for the immediate, not cleared: 5 = 000101 puts 101 there.'],
    },
    {
      question: 'What does keeping rs1 and rs2 at fixed positions in every format buy?',
      options: ['The register file starts reading as soon as the word arrives, in parallel with the control unit', 'Longer immediates', 'No control unit is needed', 'Fewer registers to read per instruction'],
      answer: 0,
      explain: 'The read addresses are wired straight from instr[9:7] and instr[12:10]; nothing has to decode the format first, which takes the read off the critical path.',
      why: ['', 'Fixed register fields leave fewer bits for immediates, which is why S/B split theirs.', 'The control unit still sets every mux select and write enable from the opcode.', 'Both ports read on every instruction, used or not; the control unit decides what to do with the values.'],
    },
  ],
  immediates: [
    {
      question: 'How does the assembler expand <code>li a0, 300</code>?',
      options: ['lui a0, 5 then addi a0, a0, -20', 'lui a0, 4 then addi a0, a0, 44', 'addi a0, x0, 300', 'lui a0, 4 then addi a0, a0, -20'],
      answer: 0,
      explain: '300 >> 6 = 4, 300 & 63 = 44 ≥ 32, so lo = 44 − 64 = −20 and hi rounds up to 5: 5 × 64 − 20 = 300.',
      why: ['', 'Unrounded %hi: 44 does not fit addi\'s −32 … 31.', 'addi\'s immediate is 6 bits, −32 … 31.', 'That gives 256 − 20 = 236: lowering lo to −20 must raise hi by one.'],
    },
    {
      question: 'A decoder recognises lui only when op = 0111. Which instruction does it miss?',
      options: ['lui a0, 5', 'lui a0, 4', 'None: lui has one opcode'],
      answer: 0,
      explain: 'lui\'s lowest immediate bit sits in op[3]. 5 is odd, so <code>lui a0, 5</code> = 0x013F has op 1111.',
      why: ['', '4 is even: op[3] = 0, op = 0111, caught.', 'lui owns two opcodes, 0111 and 1111; half of all lui words use the second.'],
    },
  ],
  branches: [
    {
      question: 'A <code>beq</code> at address 0x12 jumps to 0x0E. What offset is encoded?',
      options: ['−4', '−5', '−8', '+4'],
      answer: 0,
      explain: 'The target is pc + imm with pc the branch\'s own address: 0x0E − 0x12 = −4 (the word is 0xF1C8).',
      why: ['', 'That measures from pc + 1; RV16 adds the offset to the branch\'s own address.', 'RV16 is word addressed: offsets count words, not bytes.', 'The target is behind the branch, so the offset is negative.'],
    },
    {
      question: 'How does RV16\'s branch hardware produce bge?',
      options: ['It inverts blt\'s result (op[0])', 'A second comparator computes ≥', 'It swaps blt\'s operands'],
      answer: 0,
      explain: 'One comparator: op[1] picks equality or less-than, op[0] inverts, so bne = ¬beq and bge = ¬blt.',
      why: ['', 'One less-than comparator serves both; a second would double its cost.', 'b &lt; a is "greater than", which is false when a = b; bge must be true there.'],
    },
  ],
  loadstore: [
    {
      question: 'a0 = 0x20 and a1 = 7. What does <code>sw a1, 3(a0)</code> do?',
      options: ['mem[0x23] ← 7', 'mem[0x0A] ← 0x20', 'a1 ← mem[0x23]'],
      answer: 0,
      explain: 'The register inside the parentheses is the base: address a0 + 3 = 0x23; the one outside is the data.',
      why: ['', 'That swaps the roles: a1 is the data, a0 the base.', 'sw stores; the load is <code>lw a1, 3(a0)</code>.'],
    },
    {
      question: 'What does restricting memory access to lw and sw buy the pipeline?',
      options: ['At most one access per instruction, at a fixed point after the ALU: a single M stage', 'No adder is needed for addresses', 'Faster memories'],
      answer: 0,
      explain: 'Every instruction meets memory at the same place, once, after the address is computed, so one stage handles it for all.',
      why: ['', 'The address rs1 + imm still comes from the ALU\'s adder, the same as addi.', 'The memories are unchanged; it is the datapath\'s shape that gets simpler.'],
    },
  ],
  callconv: [
    {
      question: 'Before calling g, f has values in t0, a1, sp and ra. Which is guaranteed to hold the same value after the call?',
      options: ['sp', 't0', 'a1', 'ra'],
      answer: 0,
      explain: 'RV16 has no callee-saved registers except sp: the callee must return with sp as it found it, and may change a and t registers freely.',
      why: ['', 't registers are caller-saved: g may use them.', 'a registers carry arguments and the result: g may change them.', '<code>call g</code> itself overwrites ra with its return point.'],
    },
    {
      question: 'A function calls nothing and needs only a0–a2 and t0–t1. What must it save?',
      options: ['Nothing: it needs no stack', 'ra, on entry', 'Every register it changes'],
      answer: 0,
      explain: 'A leaf function never overwrites ra, and the registers it uses are all caller-saved, so it can return with <code>ret</code> directly.',
      why: ['', 'ra is overwritten only by a call; a leaf makes none.', 'In RV16 the a and t registers are caller-saved: the caller keeps what it needs.'],
    },
  ],
  stack: [
    {
      question: 'sp = 0x200. After <code>push a0</code> then <code>push ra</code>, where is ra and what is sp?',
      options: ['ra at 0x1FE, sp = 0x1FE', 'ra at 0x1FF, sp = 0x1FE', 'ra at 0x1FC, sp = 0x1FC', 'ra at 0x201, sp = 0x202'],
      answer: 0,
      explain: 'Each push decrements sp by one word and stores at 0(sp): a0 at 0x1FF, ra at 0x1FE, and sp points at the last word pushed.',
      why: ['', 'push decrements first and then stores at 0(sp), so the last value pushed is where sp points.', 'RV16 is word addressed: one word is − 1, not − 2.', 'The stack grows down, below sp.'],
    },
    {
      question: 'A program forgets <code>li sp, …</code>, so sp = 0, and its first instruction after that is <code>push a0</code> with a0 = 7. What happens?',
      options: ['It stops with exit code 7', 'It writes RAM word 0xFFFF and carries on', 'It traps: sp went below zero'],
      answer: 0,
      explain: 'sp − 1 wraps to 0xFFFF, which is the EXIT device: the store ends the program with the stored value as its exit code.',
      why: ['', '0xFFFF is not RAM: the top seven addresses are devices.', 'Addresses wrap modulo 2<sup>16</sup>; nothing checks sp.'],
    },
  ],
  mmio: [
    {
      question: 'What does <code>sw a0, -2(x0)</code> do?',
      options: ['Prints a0 as a character (CONSOLE, 0xFFFE)', 'Stores a0 in RAM word 0x003E', 'Appends a0 to the output numbers (OUT)', 'It traps: negative address'],
      answer: 0,
      explain: 'The offset is sign-extended, so x0 − 2 = 0xFFFE, the console.',
      why: ['', 'That would need a zero-extended offset: 111110 read as 62.', 'OUT is 0xFFFD, −3(x0).', 'Address arithmetic wraps; −2 is simply 0xFFFE.'],
    },
    {
      question: 'The input queue holds 5 then 9. After <code>lw a0, -4(x0)</code> and <code>lw a1, -4(x0)</code>?',
      options: ['a0 = 5, a1 = 9', 'a0 = a1 = 5', 'a0 = 5, a1 = 0'],
      answer: 0,
      explain: 'IN (0xFFFC) has a side effect: each load consumes the next number.',
      why: ['', 'A device register is not a memory word: reading IN again gives the next number, not the same one.', 'IN returns 0 only when the queue is empty; 9 is still waiting.'],
    },
  ],

  // ---- the CPU
  datapath: [
    {
      question: 'Which control settings does <code>jalr</code> need?',
      options: ['rwe 1, result pc + 1, next PC rs1 + imm', 'rwe 1, result ALU, next PC rs1 + imm', 'rwe 0, next PC rs1 + imm', 'rwe 1, result pc + 1, next PC pc + imm'],
      answer: 0,
      explain: 'jalr links (rd ← pc + 1) and jumps to rs1 + imm. <code>ret</code> is jalr with rd = x0, whose write is simply discarded.',
      why: ['', 'The value written to rd is the return address pc + 1, not a sum the ALU computed.', 'jalr writes rd; a return just names x0 as rd.', 'pc + imm is jal\'s target; jalr\'s comes from a register.'],
    },
    {
      question: 'A datapath already runs <code>addi</code>. What must be added for <code>lw</code>?',
      options: ['A path from the data RAM to the result mux, and its select', 'A second adder for rs1 + imm', 'A new immediate format'],
      answer: 0,
      explain: 'lw computes rs1 + imm exactly like addi, with the same I immediate; only the result comes from memory instead of the ALU.',
      why: ['', 'The ALU\'s adder already computes rs1 + imm for addi; lw reuses it for the address.', 'lw uses the I format, like addi.'],
    },
  ],
  singlecycle: [
    {
      question: 'In <code>rv16_cpu</code> (period 98, 8-delay memories) the data RAM is made 8 delays slower. New period?',
      options: ['106, for every instruction', '98 for most, 106 for loads', '114', '98: the RAM is not on the critical path'],
      answer: 0,
      explain: 'The critical path is a load, which passes through the RAM once; it grows by 8, and one clock serves every instruction.',
      why: ['', 'A single-cycle CPU has one period: every instruction gets the slowest one\'s time.', 'The RAM is on the path once; the instruction ROM did not change.', 'The load path, PC → ROM → … → RAM → result mux, is the critical one.'],
    },
    {
      question: 'Why does <code>rv16_cpu_md</code> divide iteratively, holding the PC for 18 cycles, instead of with a combinational divider?',
      options: ['A combinational divider would lengthen every instruction\'s cycle', 'Combinational division cannot be built from NANDs', 'Iteration gives a more exact quotient'],
      answer: 0,
      explain: 'Any unit on the single-cycle path sets the period for all instructions; a rare, slow divide is better paid for only when it runs.',
      why: ['', 'It can (array dividers exist); it would just be very deep, and every add would wait for it.', 'Both give the same exact quotient and remainder.'],
    },
  ],
  criticalpath: [
    {
      question: 'With Kogge–Stone adders, <code>rv16_cpu</code>\'s load path is 76 (28 of it ALU) and its branch path 74. The ALU gets 10 delays faster still. Period at best?',
      options: ['74: the branch path takes over', '66', '76: the ALU is no longer critical'],
      answer: 0,
      explain: 'The load path drops to 66, but the branch path (through the ripple comparator) stays at 74 and now sets the period.',
      why: ['', 'Shortening one path only helps until the next-longest one becomes critical.', 'The ALU is still on the load path, which is critical at 76; it improves, but only by 2.'],
    },
    {
      question: 'Simulating a block on your test vectors shows 30 delays to settle; static timing reports 44. Which sets the clock?',
      options: ['44: the tests may never exercise the longest path', '30: it was actually measured', 'The average, 37'],
      answer: 0,
      explain: 'Static timing takes the latest arrival over all paths, whatever the inputs; a test that never triggers the long carry chain underestimates. (Only a proven false path may be excluded.)',
      why: ['', 'Simulation shows the delay for the inputs you tried, not the worst case the chip must allow.', 'The clock must cover the worst path, not a typical one.'],
    },
  ],
  pipeline: [
    {
      question: 'A program takes 200 cycles on the single-cycle core and has 20 taken branches and jumps, no load-use stalls. Cycles on the plain pipeline?',
      options: ['243', '203', '223', '200'],
      answer: 0,
      explain: '200 + 3 to fill the pipeline + 2 per taken branch or jump: 200 + 3 + 40 = 243.',
      why: ['', 'That forgets the flushes: each taken branch or jump costs 2 cycles.', 'A taken branch flushes two instructions, not one.', 'CPI 1 is the ideal; fill and flushes add cycles.'],
    },
    {
      question: 'The single-cycle path is 98 delays. Why is the 5-stage RV16 pipeline\'s period 78, not about a fifth of that plus register overhead?',
      options: ['E holds the forwarding logic, operand muxes and the ripple ALU in one stage', 'Stalls and flushes lengthen the period', 'The pipeline registers add about 60 delays'],
      answer: 0,
      explain: 'The period is the slowest stage, and the stages are far from balanced: E alone is about 13 + 3 + 2 + 50 delays plus register overhead.',
      why: ['', 'Stalls and flushes add cycles, not length to each cycle.', 'Register overhead is about 6 delays per stage (clk-to-q + setup), not 60.'],
    },
  ],
  hazards: [
    {
      question: '<code>lw a1, 0(a2)</code>, then <code>or t1, a0, t0</code>, then <code>add t0, a1, a1</code>. How does add get a1?',
      options: ['Forwarded from W, no stall', 'One stall: a1 comes from a load', 'From the register file', 'Forwarded from M'],
      answer: 0,
      explain: 'At distance 2, when add is in E the load is in W with its word already read: W forwards it.',
      why: ['', 'Only a load at distance 1 stalls; here or sits in between.', 'The register file is written in W, at the falling edge; only a reader three behind sees the new value there.', 'At distance 2 the producer is in W; M holds the or.'],
    },
    {
      question: '<code>add a0, a1, a2</code> then <code>sub a0, t0, t1</code> (both write a0). What does the pipeline need to do?',
      options: ['Nothing: both write in W, in program order', 'Stall sub until add has written a0', 'Forward add\'s result into sub'],
      answer: 0,
      explain: 'Write after write cannot go wrong in an in-order 5-stage pipeline: every instruction writes in W, so sub\'s write lands after add\'s.',
      why: ['', 'sub does not read a0; there is nothing to wait for.', 'sub reads t0 and t1, not a0: forwarding serves reads only.'],
    },
  ],
  loaduse: [
    {
      question: 'On RV16\'s pipeline: <code>lw a0, 0(a1)</code> then <code>addi t0, t1, 3</code>. What happens?',
      options: ['One stall cycle, though addi does not read a0', 'No stall: addi does not read a0', 'Two stall cycles'],
      answer: 0,
      explain: 'The hazard unit compares the rs2 field even for I-type: addi\'s bits 12:10 are imm[2:0] = 011, which is x3 = a0. A needless stall, never a missing one.',
      why: ['', 'True of the instruction, but the hazard unit counts bits 12:10 as rs2 for every format, and here they spell a0.', 'One cycle is always enough: after it the load is in W and forwards.'],
    },
    {
      question: 'A hazard unit holds F and D on a load-use but forgets the bubble into E. What goes wrong?',
      options: ['The held instruction also enters E and executes twice', 'Nothing: holding D is enough', 'The load is lost'],
      answer: 0,
      explain: 'D/E still loads the instruction in D while D keeps it, so it runs once now (with the stale value) and again next cycle.',
      why: ['', 'Holding D only stops it advancing in its own register; D/E must be cleared or it loads the same instruction.', 'The load is in E and moves on to M as usual; only the younger instruction is affected.'],
    },
  ],
  stall: [
    {
      question: 'Which controls make a load-use stall?',
      options: ['PC en 0, F/D en 0, D/E clr 1', 'PC en 0, F/D clr 1, D/E en 0', 'Every pipeline register en 0', 'F/D en 0 only'],
      answer: 0,
      explain: 'Hold the PC and F/D so the same instructions stay in F and D, and clear D/E so E gets a bubble while the load moves on.',
      why: ['', 'Clearing F/D throws away the instruction waiting in D.', 'Freezing everything holds the load in E too, so it never reaches M and the stall never ends.', 'Without the PC held, a fetch is lost; without a bubble, the instruction in D also enters E.'],
    },
    {
      question: '<code>rv16_preg</code> computes q ← clr ? 0 : en ? d : q. With en = 0 and clr = 1, the next q is?',
      options: ['0', 'q, held', 'd'],
      answer: 0,
      explain: 'clr is tested first, so a flush (clr) wins over a hold (en = 0): an instruction on the wrong path must disappear even if it was being held.',
      why: ['', 'Holding is what en = 0 does only while clr = 0.', 'd is loaded only with en = 1 and clr = 0.'],
    },
  ],
  flush: [
    {
      question: 'A run has 6 taken branches, 3 not-taken ones and 2 jal, on the plain pipeline. How many cycles do flushes cost?',
      options: ['16', '12', '22', '8'],
      answer: 0,
      explain: 'Each taken branch and each jump resolves in E and flushes two instructions: (6 + 2) × 2 = 16. Not-taken branches cost nothing.',
      why: ['', 'jal resolves in E too and flushes the same two instructions.', 'A not-taken branch continues with pc + 1, which is what was fetched: nothing to flush.', 'Two instructions are fetched behind each one by the time it resolves in E.'],
    },
    {
      question: 'A taken <code>beq</code> resolves in E. What is flushed?',
      options: ['The two younger instructions, in D and F', 'The beq and the instruction behind it', 'Everything in the pipeline', 'Only the instruction in D'],
      answer: 0,
      explain: 'pc + 1 (in D) and pc + 2 (in F) were fetched on the wrong path; F/D and D/E are cleared as the PC loads the target.',
      why: ['', 'The branch itself must complete (jal and jalr still write rd).', 'The older instructions in M and W are on the right path and finish.', 'pc + 2 in F is wrong too: two cycles are lost, not one.'],
    },
  ],
};
