// Check yourself questions for codex entries (see codexcheck.ts), group 0. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK0: Record<string, Quiz[]> = {
  mosfet: [
    {
      question: 'V<sub>DD</sub> = 1.2 V, V<sub>t</sub> = 0.4 V. An NMOS with its gate at 1.2 V passes a 1 from its drain to a node only it drives. The node settles at:',
      options: ['1.2 V', '0.8 V', '0.4 V'], answer: 1,
      explain: 'The NMOS conducts only while V<sub>GS</sub> &gt; V<sub>t</sub>: the source node charges until V<sub>GS</sub> = V<sub>t</sub>, so it stops at 1.2 − 0.4 = 0.8 V, a weak 1.',
      why: ['Only a PMOS (or a transmission gate) passes a full 1. The NMOS turns itself off a threshold short of the rail.', '', '0.4 V is where a PMOS passing a 0 stops. The NMOS loses V<sub>t</sub> from the top; it does not stop at V<sub>t</sub>.'],
    },
    {
      question: 'In the switch-level simulator a node has a pull-up resistor to V<sub>DD</sub> and a conducting NMOS to ground. It reads:',
      options: ['X: two drivers disagree', '1: the rail wins over everything', '0: a transistor beats a resistor', 'Its previous value, kept as charge'], answer: 2,
      explain: 'Conflicts settle by strength: rails and inputs, then transistors, then resistors, then stored charge. The NMOS beats the resistor, which is how ratioed (pseudo-NMOS) logic makes its 0.',
      why: ['X comes from opposing drivers of equal strength, such as two resistors. A resistor loses to any transistor.', 'The rail reaches the node only through the resistor, so it arrives with the resistor\'s strength, not the rail\'s.', '', 'Stored charge is the weakest level: it holds only when nothing drives the node.'],
    },
  ],
  inverter: [
    {
      question: 'A pseudo-NMOS design has 200 000 gates whose NMOS is on, each drawing 25 µA through its pull-up. Its static current, and that of the same logic in CMOS:',
      options: ['5 A; essentially none in CMOS', '5 A; also 5 A, since both have one NMOS per gate', 'Essentially none for both: current flows only while switching'], answer: 0,
      explain: '200 000 × 25 µA = 5 A, drawn for as long as the inputs stay at 1. In CMOS the PMOS that replaces the resistor is off whenever the NMOS is on.',
      why: ['', 'In CMOS the pull-up is a PMOS that turns off when the NMOS turns on: no rail-to-rail path in either steady state.', 'That is true of CMOS only. In pseudo-NMOS the resistor and the NMOS conduct together for as long as the input is 1.'],
    },
    {
      question: 'A NAND with both inputs tied computes NOT. Why do cell libraries still keep a separate inverter?',
      options: ['The tied NAND leaves its output floating when a = 1', 'The tied NAND is slower because its two NMOS are in parallel', 'The tied NAND is 4 transistors and loads its driver with more gate capacitance'], answer: 2,
      explain: 'Same function, but 4 transistors against 2, and the input drives two PMOS and two NMOS gates instead of one of each.',
      why: ['With a = 1 both series NMOS conduct and pull y to 0: the output is always driven.', 'A NAND\'s NMOS are in series, not parallel. What it costs is area and input load, not a different function.', ''],
    },
  ],
  nand: [
    {
      question: 'A CMOS NAND has a = 0, b = 1. Which transistors conduct, and what is y?',
      options: ['NMOS(b) only: y = 0', 'PMOS(a) and NMOS(b): y = 1', 'NMOS(a) and PMOS(b): y = 1'], answer: 1,
      explain: 'a = 0 turns PMOS(a) on and NMOS(a) off; b = 1 turns NMOS(b) on and PMOS(b) off. The series pull-down is open at NMOS(a), and PMOS(a) pulls y to V<sub>DD</sub>.',
      why: ['One NMOS on is not enough: the pull-down is two in series, and NMOS(a) is off.', '', 'Swapped: an NMOS conducts with its gate at 1, a PMOS with its gate at 0.'],
    },
    {
      question: 'Put the two NMOS in parallel and the two PMOS in series. The gate now computes:',
      options: ['¬(a + b), a NOR', 'a·b, an AND', '¬(a·b) still: only the sizing changes'], answer: 0,
      explain: 'Parallel NMOS pull the output down when any input is 1, and series PMOS pull it up only when both are 0: the inverted OR.',
      why: ['', 'A single CMOS stage always inverts: neither network can produce an uninverted function.', 'Topology sets the function: parallel pull-downs make an inverted OR, series ones an inverted AND.'],
    },
  ],
  nor: [
    {
      question: 'Size a 3-input NOR and a 3-input NAND for equal drive (NMOS width 1, PMOS twice as wide, series devices widened by their count). The width each input drives:',
      options: ['The same: both have six transistors', 'NOR 7, NAND 5: 40 % more load per input', 'NOR 5, NAND 7: the NOR\'s NMOS are minimum size'], answer: 1,
      explain: 'NOR3: NMOS 1 each in parallel, PMOS 3 × 2 = 6 each in series: 1 + 6 = 7 per input. NAND3: series NMOS 3 each, parallel PMOS 2 each: 3 + 2 = 5.',
      why: ['Equal transistor count is not equal width: three PMOS in series must each be 6 wide to drive like one inverter PMOS.', '', 'Its NMOS are minimum width, but each input also drives a PMOS 6 wide; a NAND3 input drives 3 + 2.'],
    },
    {
      question: 'A circuit needs ¬(a + b), and ¬a and ¬b already exist as signals. The cheapest NAND form:',
      options: ['A NOR from NANDs: 4 NANDs, 3 delays', 'One NAND of ¬a and ¬b', 'An AND of ¬a and ¬b: 2 NANDs, 2 delays'], answer: 2,
      explain: 'De Morgan: ¬(a + b) = ¬a·¬b. With the complements available, that is a NAND and a NOT.',
      why: ['Correct but wasteful: the NOR rebuilds the complements it is given.', 'NAND(¬a, ¬b) = a + b: that is the OR, not the NOR.', ''],
    },
  ],
  not: [
    {
      question: 'An 8-bit bus mux, built with one shared ¬s, and built by repeating the 4-NAND mux per bit:',
      options: ['24 and 32 NANDs', '32 NANDs either way', '25 and 32 NANDs'], answer: 2,
      explain: 'Shared: one NOT for ¬s plus 3 NANDs per bit, 1 + 8 × 3 = 25. Repeated: 8 × 4 = 32.',
      why: ['The shared ¬s still costs one NAND: 1 + 8 × 3.', 'Every bit reads the same s, so one inverter serves all eight.', ''],
    },
    {
      question: 'Block A ends with NOT(x) and block B starts with NOT of that signal. The best fix:',
      options: ['Remove both and wire x through', 'Keep both: the second NOT restores the logic level', 'Replace them with one NAND with tied inputs, as a buffer'], answer: 0,
      explain: 'Two inversions in a row cancel: removing them saves 2 NANDs and 2 delays.',
      why: ['', 'Every NAND drives its output from a rail; at the gate level there is no degraded level to restore.', 'A NAND with tied inputs is a NOT: it would invert x, not buffer it.'],
    },
  ],
  and: [
    {
      question: 'A 16-input AND built as a tree of 2-input ANDs costs:',
      options: ['30 NANDs, 30 delays', '30 NANDs, 8 delays', '15 NANDs, 4 delays'], answer: 1,
      explain: '15 two-input ANDs, 2(n − 1) = 30 NANDs, in log<sub>2</sub> 16 = 4 levels of 2 delays.',
      why: ['That is the chain: the same 15 ANDs, each waiting for the one before. A tree has 4 levels.', '', 'Each 2-input AND is 2 NANDs and 2 delays, not 1.'],
    },
    {
      question: 'A register must load only when en = 1. Which is safe?',
      options: ['A 2:1 mux on d that feeds q back when en = 0', 'Clock the flip-flops with clk AND en', 'AND d with en'], answer: 0,
      explain: 'The flip-flops see the clock every cycle and reload their own value when en = 0: the clock stays clean.',
      why: ['', 'clk ∧ en delays the clock and glitches when en changes while clk = 1.', 'd ∧ en loads 0 when en = 0: it clears the register instead of holding it.'],
    },
  ],
  or: [
    {
      question: 'An 8-input OR built as a tree of 2-input ORs (3 NANDs each) costs:',
      options: ['21 NANDs, 14 delays', '21 NANDs, 6 delays', '7 NANDs, 3 delays'], answer: 1,
      explain: '7 ORs × 3 NANDs = 21, in log<sub>2</sub> 8 = 3 levels of 2 delays.',
      why: ['14 delays is a chain of seven ORs; the tree has 3 levels.', '', 'A 2-input OR is 3 NANDs, ¬(¬a·¬b), not one.'],
    },
    {
      question: 'y = a·b + c·d as two ANDs and an OR is 2 + 2 + 3 = 7 NANDs. In NAND–NAND form it is:',
      options: ['5 NANDs, 3 delays', '7 NANDs: De Morgan changes the form, not the count', '3 NANDs, 2 delays'], answer: 2,
      explain: 'NAND(NAND(a, b), NAND(c, d)) = a·b + c·d: each AND\'s output NOT cancels the OR\'s input inverter on that line.',
      why: ['Dropping only the ANDs\' NOTs leaves the OR\'s input inverters re-inverting the NAND outputs; those cancel too.', 'The inverters really disappear: four of the seven NANDs were inversions undoing each other.', ''],
    },
  ],
  xor: [
    {
      question: 'The parity of 4 bits as a tree of 2-input XORs costs:',
      options: ['12 NANDs, depth 6', '12 NANDs, depth 9', '16 NANDs, depth 6'], answer: 0,
      explain: '(a ⊕ b) ⊕ (c ⊕ d): 3 XORs of 4 NANDs, in 2 levels of 3 delays.',
      why: ['', 'Depth 9 is the chain ((a ⊕ b) ⊕ c) ⊕ d. XOR is associative, so the tree has two levels.', '4 inputs need 3 XORs, not 4: each XOR merges two values into one.'],
    },
    {
      question: 'A subtractor feeds its adder b ⊕ sub and cin = sub. With sub = 1 and b = 0011, the second operand is:',
      options: ['0011, with cin = 1', '1101, with cin = 0', '1100, with cin = 1'], answer: 2,
      explain: 'x ⊕ 1 = ¬x, so each XOR inverts its bit: ¬b = 1100. The + 1 that completes −b comes in as cin.',
      why: ['With sub = 1 each XOR inverts its bit of b; only sub = 0 passes b unchanged.', '1101 is −3 in two\'s complement, but the XORs only invert; the + 1 arrives through cin = sub.', ''],
    },
  ],
  mux: [
    {
      question: 'A 1-bit 4:1 mux as a tree of 2:1 muxes costs:',
      options: ['12 NANDs, depth 6', '12 NANDs, depth 5', '16 NANDs, depth 5'], answer: 1,
      explain: '3 muxes of 4 NANDs. Worst path: s<sub>0</sub> through the first level\'s select (3), then the second level\'s data input (2).',
      why: ['Only one select path lies on the way: after the first level the signal enters the second mux as data, 2 deep.', '', 'A tree of N inputs has N − 1 muxes: 3, not 4.'],
    },
    {
      question: 'A 2:1 mux must take one late-arriving signal. Where should it go?',
      options: ['On a data input: 2 delays to y', 'On the select: it controls the whole mux', 'Anywhere: a mux is one gate level'], answer: 0,
      explain: 'y = NAND(NAND(s, b), NAND(¬s, a)): the data inputs cross two NANDs, the select also crosses the ¬s inverter.',
      why: ['', 'The select path is the deep one (3 delays): it goes through the ¬s inverter first.', 'A mux is three NAND levels from s and two from the data inputs.'],
    },
  ],
  decoder: [
    {
      question: 'A 3→8 decoder with enable has address 110 and en = 1, so y6 = 1. What makes y7 = 0?',
      options: ['Its factor ¬a1', 'Its factor a0: y7 needs a0 = 1', 'Nothing in y7: a priority stage after the ANDs clears every output but one'], answer: 1,
      explain: 'y7 = a2·a1·a0·en; with a0 = 0 that product is 0. Each output is its own AND, true for exactly one address.',
      why: ['7 = 111, so y7 takes every address bit true; ¬a1 belongs to outputs whose bit 1 is 0 (y0, y1, y4, y5).', '', 'There is no priority stage: only one AND can be 1 because each tests a different address.'],
    },
    {
      question: 'A decoder drives the enables of transparent latches, and its address changes from 01 to 10. The risk:',
      options: ['None: exactly one output is 1 at all times', 'All outputs go X until the next clock', 'The two bits switch at slightly different times: 00 or 11 can appear briefly and open a wrong latch'], answer: 2,
      explain: 'Exactly one output is 1 once settled; in between, the inputs can pass through other codes. A clocked register ignores that, a latch does not.',
      why: ['One-hot holds only after the inputs settle; the decoder is combinational and glitches.', 'The decoder has no clock and its inputs are known values; it glitches through valid codes, not X.', ''],
    },
  ],
  comparator: [
    {
      question: 'An 8-bit equality comparator (XOR per bit, OR tree, one inverter) costs:',
      options: ['54 NANDs, 12 delays', '32 NANDs, 3 delays', '54 NANDs, 10 delays'], answer: 2,
      explain: '8 XORs (32) + 7 ORs (21) + 1 NOT = 54; depth 3 + 6 + 1 = 10, which is 4 + 2·log<sub>2</sub> 8.',
      why: ['12 is the 16-bit depth: log<sub>2</sub> 8 = 3 gives 4 + 6.', 'The XORs alone are 32 NANDs and 3 deep; their eight outputs still need an OR tree and an inverter.', ''],
    },
    {
      question: 'A forwarding unit finds rs1 of the instruction in E equal to rd of the one in M (which writes a register). When must it still not forward?',
      options: ['When rd = x0', 'When the instruction in E also writes rs1', 'Never: equal numbers name the same register'], answer: 0,
      explain: 'The instruction in M may compute a nonzero result for x0, but x0 reads 0, so its value must not reach anyone.',
      why: ['', 'The instruction in E reads rs1 before it writes anything; its own rd does not affect its operand.', 'x0 is the exception: a write to it is discarded, so forwarding it would hand out a value no one may read.'],
    },
  ],
  halfadder: [
    {
      question: 'Where can a half adder replace a full adder without error?',
      options: ['The top bit, since nothing comes after it', 'Bit 0 of an adder whose carry-in is fixed at 0', 'Bit 0 of a subtractor computing a + ¬b + 1'], answer: 1,
      explain: 'A half adder has no carry input, so it fits only where the incoming carry is known to be 0 (or, in an incrementer, where the second operand is).',
      why: ['The top bit still receives a carry from the bit below; what it lacks is a next bit for its carry out.', '', 'A subtractor sets cin = 1: its bit 0 adds three bits, a, ¬b and 1.'],
    },
    {
      question: 'In the 5-NAND half adder, how long after a and b change does each output settle?',
      options: ['c after 2 delays, s after 3', 'Both after 3', 'c after 1: it is the XOR\'s first NAND'], answer: 0,
      explain: 'c is the XOR\'s first NAND, ¬(a·b), inverted by one more NAND: 2 levels. s needs the whole 3-level XOR.',
      why: ['', 'c does not wait for the XOR: it branches off after its first NAND.', 'The first NAND gives ¬(a·b); one more NAND inverts it into c.'],
    },
  ],
  fulladder: [
    {
      question: 'a = 1, b = 1, cin = 0. What are s and cout, and what cout would a design give that forgets the generate term, cout = cin·(a ⊕ b)?',
      options: ['s = 1, cout = 0; that design agrees', 's = 0, cout = 1; that design gives 0', 's = 0, cout = 0; that design agrees'], answer: 1,
      explain: '1 + 1 + 0 = 2 = binary 10. The carry is a·b + cin·(a ⊕ b) = 1; without the generate term a·b only cin·(a ⊕ b) = 0 is left.',
      why: ['Two 1s have even parity: the sum bit is 0, and a column summing to 2 carries.', '', 'A column summing to 2 must carry: cout is the majority of the inputs, here 1.'],
    },
    {
      question: 'The 9-NAND full adder is 6 deep. Why does a ripple adder built from it add only 2 delays per bit?',
      options: ['All bits settle in parallel', 'The second XOR is skipped when cin = 0', 'cin reaches cout through two NANDs; a and b arrive early and are ready'], answer: 2,
      explain: 'The 6 is from a or b, which every bit receives at once. On the chain only cin → ¬((a ⊕ b)·cin) → cout lies: two NANDs.',
      why: ['Each bit\'s carry out still waits for its carry in; the chain costs 2 per bit, not 0.', 'Paths are fixed by the gates, not by values; nothing is skipped.', ''],
    },
  ],
  ripple: [
    {
      question: 'A 12-bit ripple-carry adder costs:',
      options: ['108 NANDs, 28 delays', '108 NANDs, 72 delays', '108 NANDs, 24 delays'], answer: 0,
      explain: '9 NANDs per bit. c1 at 5, each later carry 2 more: c11 at 25, and s11 = p11 ⊕ c11 at 28 (2n + 4).',
      why: ['', '72 = 6 × 12 assumes each bit waits for its whole full adder; only cin → cout, 2 NANDs, is on the chain.', '2n misses the ends: bit 0 makes its carry 5 delays in, and the top sum bit adds its XOR.'],
    },
    {
      question: 'Which 8-bit addition takes a ripple adder longest to settle?',
      options: ['0xFF + 0xFF: the largest operands', '0x80 + 0x80: it overflows', '0xFF + 0x01'], answer: 2,
      explain: 'Bit 0 generates a carry and every bit above propagates it (a ⊕ b = 1): it crosses the whole chain.',
      why: ['Every bit of 0xFF + 0xFF generates its own carry (a = b = 1), so none has to travel far.', 'Bit 7 makes the carry out by itself; nothing below it propagates.', ''],
    },
  ],
  incrementer: [
    {
      question: '0x0FF7 + 1 in a 16-bit incrementer. How many bits change?',
      options: ['1', '4', '12'], answer: 1,
      explain: 'Bit i flips when every bit below it is 1: bits 0–2 (the trailing 1s) and bit 3 (the first 0). Result 0x0FF8.',
      why: ['Only one bit changes when bit 0 is 0; here the carry runs up through three trailing 1s.', '', 'The carry stops at the first 0, bit 3; the 1s in bits 4–11 stay.'],
    },
    {
      question: 'The 8-bit incrementer is 40 NANDs and 17 delays, the 8-bit ripple adder 72 and 20. Why is the incrementer barely faster?',
      options: ['Its carry is still a serial chain, 2 delays per bit', 'A half adder is deeper than a full adder', 'Its delay is set by the sum XORs, not by the carries'], answer: 0,
      explain: 'Bit i still has to learn whether every bit below it is 1, through a chain of ANDs. Fixing b removes gates, not that dependency.',
      why: ['', 'A half adder is shallower (3 deep against 6); the depth comes from the chain, not the cell.', 'Each XOR is only 3 deep; the 17 comes from the carry passing through every bit.'],
    },
  ],
  shifter: [
    {
      question: 'RV16: sra of 0x8421 by 3 gives:',
      options: ['0x1084', '0xF084', '0x2108'], answer: 1,
      explain: 'Shifting 1000 0100 0010 0001 right by 3 and filling with bit 15 (1): 1111 0000 1000 0100.',
      why: ['That is srl: the vacated bits filled with 0. sra copies the sign bit into them.', '', 'That is a left shift by 3 (with the top bits lost): the direction is reversed.'],
    },
    {
      question: 'RV16: sll t0, t1, t2 with t2 = 0x0013 shifts t1 left by:',
      options: ['19, which empties the word', '0: amounts above 15 are ignored', '3'], answer: 2,
      explain: 'The shifter takes only the low 4 bits of rs2: 0x13 &amp; 0xF = 3.',
      why: ['The amount is not saturated: bits above bit 3 of rs2 never reach the shifter.', 'Nothing checks the range; the high bits are simply not wired, so the low four, 0011, decide.', ''],
    },
  ],
  alu: [
    {
      question: 'a = 0x0001, b = 0xFFFF. slt and sltu give:',
      options: ['slt = 1, sltu = 0', 'Both 1', 'slt = 0, sltu = 1'], answer: 2,
      explain: 'Signed, 0xFFFF is −1 and 1 &lt; −1 is false. Unsigned it is 65 535, and a − b borrows (no carry out): 1.',
      why: ['Swapped: signed 0xFFFF is −1, unsigned it is 65 535.', 'Signed, 1 is not less than −1.', ''],
    },
    {
      question: 'The 16-bit ALU is 1 055 NANDs, 64 delays deep with ripple carry. What should be made faster to shorten its critical path?',
      options: ['The subtractor\'s carry chain', 'The 8:1 result mux, its biggest part', 'The barrel shifter'], answer: 0,
      explain: 'The delay is in the carry chain: a Kogge–Stone adder takes the ALU from 64 to 42 delays for 218 more NANDs.',
      why: ['', 'The result mux is the largest part (343 NANDs, a third of the ALU) but only 7 levels deep.', 'The shifter is large (299 NANDs) but only 14 deep.'],
    },
  ],
  latch: [
    {
      question: 'A NAND SR latch holds q = 1. r̄ pulses to 0 for one NAND delay, then returns to 1. What happens?',
      options: ['q = 0 reliably: one delay starts the reset and the loop finishes it', 'The reset can fail: q̄ rose, but q had not yet fallen to hold it', 'Nothing: the pulse never reaches the loop'], answer: 1,
      explain: 'q̄ rises after 1 delay, q falls after 2, and only then does q hold q̄ up. The pulse must last the loop delay, 2 NAND delays.',
      why: ['The loop finishes only once q has fallen; after 1 delay q̄ is still held up by r̄ alone.', '', 'It does reach the loop: q̄ = NAND(q, r̄) rises one delay later. What the pulse lacks is time for q to follow.'],
    },
    {
      question: 's̄ and r̄ are both 0, then both return to 1 at the same instant. The latch:',
      options: ['Races: mismatch and noise decide the state (metastability)', 'Returns to the state it held before', 'Stays at q = q̄ = 1'], answer: 0,
      explain: 'Both outputs were forced to 1; released, each NAND sees two 1s and starts to fall, and the faster one wins.',
      why: ['', 'Holding both inputs at 0 overwrote the old state: q = q̄ = 1 while they were held.', 'q = q̄ = 1 holds only while both inputs are 0.'],
    },
  ],
  dlatch: [
    {
      question: 'A counter q ← q + 1 uses D latches enabled by clk instead of flip-flops. While clk = 1:',
      options: ['It counts once, at the rising edge', 'q + 1 races around the loop, counting as fast as the logic allows', 'Nothing changes until clk falls'], answer: 1,
      explain: 'A latch is transparent for the whole phase: the new q reaches the incrementer, which feeds a newer value back through the open latch.',
      why: ['Acting only on the edge is what the flip-flop adds; a latch is open for the whole phase.', '', 'While e = 1 the latch follows d; it holds only after e falls.'],
    },
    {
      question: 'The 4-NAND D latch uses r̄ = ¬(s̄·e) instead of ¬(¬d·e). Why is it the same function?',
      options: ['It is not: it only works for d = 1', 's̄ and ¬d are equal at all times', 'While e = 1, s̄ = ¬d; while e = 0, r̄ = 1 either way'], answer: 2,
      explain: 's̄ = ¬(d·e) equals ¬d whenever e = 1, the only time r̄ matters; with e = 0 both forms give r̄ = 1, hold.',
      why: ['Check d = 0, e = 1: s̄ = 1, r̄ = ¬(1·1) = 0: reset, as it should be.', 'With e = 0, s̄ is 1 whatever d is; it equals ¬d only while e = 1, which is enough.', ''],
    },
  ],
  dff: [
    {
      question: 'A 16-bit register loads every cycle (no enable mux) from q + b through a 16-bit ripple adder (36 delays). Its minimum period:',
      options: ['42 NAND delays', '36 NAND delays', '39 NAND delays'], answer: 0,
      explain: 'clk-to-q (3) + adder (36) + setup (3) = 42.',
      why: ['', 'The adder is only part of the loop: q leaves the flip-flop 3 delays after the edge and must reach d 3 delays before the next one.', 'Both clk-to-q and setup count: 3 + 36 + 3.'],
    },
    {
      question: 'A path between two flip-flops violates hold. Doubling the clock period:',
      options: ['Fixes it: data has more time to arrive', 'Fixes it if setup is also met', 'Does not help: hold depends on the shortest path and on clock skew'], answer: 2,
      explain: 'Hold is about new data arriving too soon after the same edge; the period does not enter it.',
      why: ['More time to arrive fixes setup. Hold is violated by data that arrives too early, not too late.', 'Setup and hold are separate checks, and only setup involves the period.', ''],
    },
  ],
  register: [
    {
      question: 'With the 9-NAND flip-flop and a 4-NAND enable mux per bit (as s_reg4 builds it), a 12-bit register with load enable costs:',
      options: ['108 NANDs', '156 NANDs', '180 NANDs'], answer: 1,
      explain: '9 for the flip-flop + 4 for the enable mux = 13 per bit, × 12 = 156. Sharing one ¬en across the bits, as a bus mux can share ¬s, makes it 1 + 12 × 12 = 145.',
      why: ['108 is the flip-flops alone; each bit also needs its 4-NAND enable mux.', '', '180 is 15 per bit, the library\'s 11-NAND flip-flop drawing; with the 9-NAND one it is 13.'],
    },
    {
      question: 'With en = 0 a register holds its value. What do its flip-flops do at each rising edge?',
      options: ['Load again: the mux feeds each q back to its d', 'Nothing: their clock is stopped', 'Load 0 from the mux'], answer: 0,
      explain: 'The flip-flops are clocked every cycle; the enable mux chooses between d and their own q.',
      why: ['', 'Stopping the clock (clk ∧ en) is the gating the mux exists to avoid: it glitches and skews the clock.', 'Forcing 0 is a clear, a second mux used to inject a bubble; the enable mux keeps q.'],
    },
  ],
  counter: [
    {
      question: 'A 4-bit ripple counter steps from 0011 to 0100. What can a reader see in between?',
      options: ['Nothing: every bit changes on the same edge', '0010, then 0000', '0111, then 0101'], answer: 1,
      explain: 'Each flip-flop is clocked by the bit below: bit 0 falls (0010), which toggles bit 1 (0000), which toggles bit 2 (0100).',
      why: ['That is the synchronous counter. In a ripple counter each bit changes one flip-flop delay after the bit below it.', '', 'The change runs from the bottom up, so bit 2 changes last, not first.'],
    },
    {
      question: 'An 8-bit synchronous counter loads every cycle (no enable mux) through the 8-bit incrementer (17 delays). Its minimum period:',
      options: ['17 delays', '3 delays: all bits change on the same edge', '23 delays'], answer: 2,
      explain: 'clk-to-q (3) + carry chain (17) + setup (3).',
      why: ['The incrementer is only the logic: q leaves the flip-flops 3 delays after the edge and must reach d 3 delays before the next.', 'The bits do change together, but the next value must still be computed through the carry chain before the next edge.', ''],
    },
  ],
  pc: [
    {
      question: 'RV16: a jal with rd = ra and immediate 6 sits at pc = 0x0030. After it:',
      options: ['ra = 0x0034, pc = 0x0036', 'ra = 0x0036, pc = 0x0036', 'ra = 0x0031, pc = 0x0036'], answer: 2,
      explain: 'RV16 counts words: the link is pc + 1, the target pc + imm.',
      why: ['Adding 4 is RV32, which addresses bytes; RV16 is word-addressed.', 'The link is the return address, the instruction after the jal, not the target.', ''],
    },
    {
      question: 'In one cycle reset is asserted and a taken branch resolves. The PC loads:',
      options: ['0', 'The branch target', 'pc + 1'], answer: 0,
      explain: 'Reset has priority over every other next-PC source.',
      why: ['', 'Reset wins over a branch (and a trap) in the next-PC priority.', 'Neither the sequential nor the branch path counts while reset is asserted.'],
    },
  ],
  ram: [
    {
      question: 'Word 3 of a RAM holds 1001. In one cycle we = 1, addr = 3, din = 0110. Before the rising edge, dout reads:',
      options: ['0110: the write passes straight to the read port', '1001: the word changes only at the edge', 'X while the write is pending'], answer: 1,
      explain: 'The read mux selects the stored word combinationally; the word\'s register takes din only at the rising edge.',
      why: ['The read mux is fed by the registers, not by din; the new word appears after the edge.', '', 'Nothing is unknown: the register holds 1001 until the edge, and the mux shows it.'],
    },
    {
      question: 'What costs the most in the 4 × 4 RAM (306 NANDs)?',
      options: ['The 16 storage bits: 240 NANDs', 'The write decoder', 'The read mux'], answer: 0,
      explain: '15 NANDs per bit of register (flip-flop and enable mux) dominate; real memories use 6T SRAM or 1T1C DRAM cells for that reason.',
      why: ['', 'Write select is 18 NANDs: a 2→4 decoder ANDed with we.', 'The 4:1 read mux is 48 NANDs, a fifth of the storage.'],
    },
  ],
  regfile: [
    {
      question: 'Adding a third read port to the RV16 8 × 16 register file (2 172 NANDs) costs about:',
      options: ['1 456 NANDs: another copy of the registers', '343 NANDs: one more 8:1 bus mux tree', '30 NANDs: another decoder'], answer: 1,
      explain: 'Read ports share the storage; each has its own mux tree. The two existing ones are 686 NANDs, 343 each.',
      why: ['Every port reads the same registers; only the selection is duplicated.', '', 'A decoder selects the register written; a read port selects with a mux tree.'],
    },
    {
      question: 'add x0, t1, t2 computes 7. Then add a0, x0, x0 gives a0 =',
      options: ['14: x0 now holds 7', '7, forwarded from the previous write', '0'], answer: 2,
      explain: 'x0 has no storage: its slot in the read muxes is the constant 0, and writes to it go nowhere.',
      why: ['The write to x0 is discarded by the hardware; there is nothing to hold the 7.', 'A pipeline must never forward a write to x0, which reads 0 by definition.', ''],
    },
  ],
  rom: [
    {
      question: 'A ROM stores n² at address n (4-bit address, 8-bit word). The decoder wire of address 0110 feeds the OR gates of which bits?',
      options: ['Bits 5 and 2', 'Bits 2 and 1', 'All eight: each wire reaches every OR gate'], answer: 0,
      explain: 'The word at 6 is 36 = 0010 0100: the wire feeds only the OR gates of its 1 bits, 5 and 2.',
      why: ['', '0110 is the address (bits 2 and 1); the wire follows the word stored there, 36.', 'A wire feeds only the OR gates of bits that are 1 in its word.'],
    },
    {
      question: 'A 6-input function is 1 for 5 of its 64 inputs. ROM or PLA?',
      options: ['ROM: no minimization, so always smaller', 'Either: both decode every address', 'PLA: it builds only the product terms the outputs need'], answer: 2,
      explain: 'A ROM decodes all 64 addresses whether they are used or not; a PLA keeps the two planes but only the minimized terms.',
      why: ['A ROM pays for every address; skipping minimization saves design effort, not gates.', 'Only the ROM decodes every address; a PLA\'s AND plane holds just the terms needed.', ''],
    },
  ],
  control: [
    {
      question: 'In the RV16 control table, which signal is a don\'t-care for sw?',
      options: ['rwe', 'wb, the source of the value written to rd', 'mwe'], answer: 1,
      explain: 'A store writes no register, so what would be written back does not matter, as long as rwe = 0.',
      why: ['rwe must be 0: a don\'t-care here could let the store write some register.', '', 'mwe must be 1: it is what makes the store happen.'],
    },
    {
      question: 'Why can the register file read rs1 and rs2 before the control unit has finished decoding?',
      options: ['The fields never move: rs1, rs2 and rd sit in the same bits in every format', 'The control unit is faster than the register file', 'The control unit decodes rs1 and rs2 first'], answer: 0,
      explain: 'Fixed field positions let the register numbers go straight from the instruction to the register file, in parallel with decoding.',
      why: ['', 'The control unit takes 13 delays; the point is that the register file does not wait for it at all.', 'The control unit never decodes register numbers: they bypass it.'],
    },
  ],
  csr: [
    {
      question: 'An external interrupt is taken at pc = 0x0080, before the instruction there has run. Which is right?',
      options: ['mepc = 0x0081: the hardware skips to the next instruction', 'mepc = 0x0080, mcause = 0x800B, and mret returns to 0x0080 as is', 'mepc = 0x0080, and the handler must add 1 as after an ecall'], answer: 1,
      explain: 'mepc holds the instruction that was interrupted, which has not executed; it must run on return.',
      why: ['mepc is the interrupted instruction, not the next one; skipping it would lose an instruction that never ran.', '', 'After an ecall mepc holds the ecall itself, so the handler adds 1 or mret would trap again; an interrupted instruction has not run, and adding 1 would skip it.'],
    },
    {
      question: 'csrrs t0, mip, x0:',
      options: ['Sets every bit of mip', 'Clears mip', 'Reads mip into t0 and writes nothing'], answer: 2,
      explain: 'csrrs sets the bits given by rs1; with rs1 = x0 there are none, and the CSR is not written at all, which matters for registers with side effects.',
      why: ['csrrs sets the bits that are 1 in rs1, and x0 has none.', 'Clearing is csrrc, and it too writes nothing with rs1 = x0.', ''],
    },
  ],
  arraymul: [
    {
      question: 'An 8 × 8 unsigned array multiplier has how many AND gates and adders?',
      options: ['64 ANDs, 64 adders', '16 ANDs, 7 adders', '64 ANDs, 56 adders'], answer: 2,
      explain: 'n² = 64 partial-product bits, summed by n(n − 1) = 56 adders: 632 NANDs and 70 delays here.',
      why: ['The first partial-product row needs no adder: 8 rows take 7 rows of 8 adders.', 'Every bit of a meets every bit of b: n² ANDs, not 2n.', ''],
    },
    {
      question: '−1 × 2 on a 4 × 4 unsigned array: 1111 × 0010 gives',
      options: ['0001 1110: the low half is right, the high half wrong', '1111 1110: two\'s complement needs no correction', '0000 0010: both halves wrong'], answer: 0,
      explain: 'Unsigned, 1111 is 15 and 15 × 2 = 30 = 0001 1110. The signed product −2 is 1111 1110: same low half, different high half.',
      why: ['', 'That is the signed product; the unsigned array sees 15, not −1.', 'The low half of a product is the same for signed and unsigned operands; only the high half differs.'],
    },
  ],
  sticky: [
    {
      question: '0110 1000 shifted right by 3 in a sticky shifter. Sticky is:',
      options: ['1: the by-1 and by-2 levels both shifted', '0: the bits that fell off are 000', '1: the result 0000 1101 is inexact'], answer: 1,
      explain: 'By 1 drops 0, by 2 drops 00: both level flags are 0. Nothing nonzero was lost.',
      why: ['A level\'s flag is the OR of the bits it pushes out, not whether it shifted.', '', 'The result is exact: all three dropped bits were 0.'],
    },
    {
      question: 'Why keep a sticky bit as well as the guard bit?',
      options: ['To tell an exact half (G = 1, rest 0) from more than half, for ties to even', 'To round up whenever any bit was lost', 'To detect overflow'], answer: 0,
      explain: 'G says at least half an ulp was dropped; S says whether anything below it was nonzero. G = 1, S = 0 is the tie.',
      why: ['', 'Round to nearest rounds down below half an ulp; rounding up on any loss is a different mode.', 'Overflow is decided by the exponent after rounding, not by the dropped bits.'],
    },
  ],
  lzc: [
    {
      question: 'An 8-bit leading-zero counter reads 0001 0110. c and v are:',
      options: ['c = 1, v = 1', 'c = 3, v = 1', 'c = 4, v = 1'], answer: 1,
      explain: 'High nibble 0001 has a 1: c = 0 followed by its count. Its high pair 00 is empty: 1 followed by the low pair 01\'s ¬a1 = 1. c = 011.',
      why: ['1 is the trailing-zero count; normalization needs the zeros above the first 1.', '', 'The high nibble is not all zero: its bit 0 (bit 4 of the word) is the first 1.'],
    },
    {
      question: 'The input is 0000 0000. What must the FP unit do with c and v?',
      options: ['Shift left by c = 7', 'Shift left by 8 and lower the exponent by 8', 'v = 0: the result is a true zero, ignore c'], answer: 2,
      explain: 'There is no leading 1 to bring up; c is meaningless when v = 0.',
      why: ['There is nothing to normalize; v = 0 marks a true zero.', 'Shifting zeros changes nothing and would lower the exponent of what is really 0.', ''],
    },
  ],
  normalize: [
    {
      question: 'A raw significand has 5 leading zeros, and its biased exponent is 3. Normalize shifts it:',
      options: ['Left by 2 (exp − 1): it ends subnormal', 'Left by 5, putting the leading 1 at the hidden bit', 'Right, with sticky, because the exponent is small'], answer: 0,
      explain: 'The shift is min(lz, exp − 1) = min(5, 2) = 2: the exponent may not drop below the minimum, so the result stops in the subnormal range.',
      why: ['', 'A shift of 5 would take the exponent below the minimum; it stops at exp − 1.', 'A right shift is for an exponent already below 1; exp = 3 leaves room to shift left by 2.'],
    },
    {
      question: 'In binary16, 1.1111111111 × 2³ is rounded up (G = 1, S = 1). The result:',
      options: ['1.1111111111 × 2³: the significand is already full', '1.0000000000 × 2³: the carry is lost', '1.0000000000 × 2⁴'], answer: 2,
      explain: 'Adding one ulp carries out of the significand: 10.0000000000 × 2³, renormalized to 1.0 × 2⁴.',
      why: ['Rounding does not saturate: a full significand carries out.', 'The carry out bumps the exponent; dropping it would halve the value.', ''],
    },
  ],
  cache: [
    {
      question: 'The campaign\'s cache: 8 one-word lines, index = addr[2:0], tag = addr[7:3]. Which pair, loaded alternately, misses every time?',
      options: ['0x15 and 0x16', '0x15 and 0x25', '0x15 and 0x51'], answer: 1,
      explain: '0x15 = 00010 101 and 0x25 = 00100 101: both index 5 with different tags, so each evicts the other (conflict misses).',
      why: ['Neighbouring addresses differ in the index (5 and 6) and live in different lines.', '', 'The index is the low three bits: 0x51 ends in 001 (line 1), 0x15 in 101 (line 5).'],
    },
    {
      question: 'A hit takes 1 cycle and a miss 20 more. Direct-mapped, 10% of accesses miss; 2-way set-associative, 6% miss, but the way mux stretches every hit to 2 cycles. Average access time of each?',
      options: ['3 and 3.2 cycles: the direct-mapped cache wins', '3 and 2.2 cycles: the 2-way cache wins', '2 and 1.2 cycles: the 2-way cache wins'], answer: 0,
      explain: 'AMAT = hit time + miss rate × miss penalty: 1 + 0.10 × 20 = 3 against 2 + 0.06 × 20 = 3.2. Associativity buys fewer conflict misses with a slower hit; it pays once misses are dear: at a 50-cycle penalty it is 6 against 5.',
      why: ['', 'That keeps the 2-way hit at 1 cycle. The slower hit is paid by every access, not only by the misses.', 'That leaves out the hit time: a miss still pays the lookup, so AMAT starts from the hit time and adds miss rate × penalty.'],
    },
  ],
  lane: [
    {
      question: 'Four lanes run csrr t0, tid, then slli a0, t0, 2. a0 in lanes 0–3:',
      options: ['0, 0, 0, 0', '0, 4, 8, 12', '12, 12, 12, 12'], answer: 1,
      explain: 'One decoded instruction, four ALUs: each lane shifts its own t0 (0, 1, 2, 3) and writes its own a0.',
      why: ['Lane 0 does not broadcast its result: decoding is shared, data is not.', '', 'No lane\'s result overwrites another\'s: each register file writes its own a0.'],
    },
    {
      question: 'What does each lane have of its own?',
      options: ['Its PC, so it can branch alone', 'Its control unit, so it can run another operation', 'Its register file and ALU'], answer: 2,
      explain: 'SIMD shares the PC, the instruction memory and the control unit; each lane has registers, operand mux, ALU and a memory port.',
      why: ['One PC fetches one instruction per cycle for every lane.', 'The instruction is decoded once, and the same control signals reach every lane.', ''],
    },
  ],
  vrf: [
    {
      question: 'mask = 0110, t0 = 0, 1, 2, 3 in lanes 0–3. After addi a0, t0, 5:',
      options: ['All four write 5, 6, 7, 8: the mask only stops stores', 'Lanes 0 and 3 write 5 and 8', 'Lanes 1 and 2 write 6 and 7; lanes 0 and 3 keep their a0'], answer: 2,
      explain: 'Every file is written at rd = a0 with its own data; the write enables are the mask bits, lane 3 to lane 0.',
      why: ['The mask drives every lane\'s register write enable as well as its store enable.', 'Mask bits read lane 3 … lane 0: 0110 enables lanes 2 and 1.', ''],
    },
    {
      question: 'Why are the four lane register files read and written at the same register numbers?',
      options: ['The instruction names rs1, rs2 and rd once for every lane', 'To save area: separate addresses would need more storage', 'They are not: each lane adds its tid to the register numbers'], answer: 0,
      explain: 'One instruction carries one rs1, one rs2 and one rd. A lane that needs another register needs another instruction.',
      why: ['', 'Addresses cost no storage; the sharing is forced by the single instruction.', 'Register numbers come straight from the instruction; lanes differ only in their contents.'],
    },
  ],
  activemask: [
    {
      question: 'From mask 1111: li t1, 10, then tmc t1. The new mask and leader:',
      options: ['Mask 1010, leader lane 0', 'Mask 1010, leader lane 1', 'Mask 1010, leader lane 3'], answer: 1,
      explain: '10 = 1010 enables lanes 3 and 1; the leader is the lowest active lane, lane 1.',
      why: ['The leader moves with the mask: lane 0 is now masked off.', '', 'The leader is the lowest active lane, not the highest.'],
    },
    {
      question: 'A warp runs 10 instructions with mask 0011. Compared with mask 1111:',
      options: ['The same 10 issues; half the lane-steps do work', '5 cycles: half the lanes, half the time', 'Fewer cycles: masked lanes skip reading their registers'], answer: 0,
      explain: 'Every lane still receives every instruction; the mask only blocks register and store writes, so utilization drops, not time.',
      why: ['', 'The warp issues each instruction once for all four lanes, whatever the mask.', 'Masked lanes still read and compute; only their writes are blocked.'],
    },
  ],
  reconvergence: [
    {
      question: 'split t1 runs with t1 ≠ 0 in all four active lanes. Its join:',
      options: ['Jumps back after the split with an empty mask', 'Restores the saved mask and pops, without jumping back', 'Ends the warp, since the else side has no lanes'], answer: 1,
      explain: 'An entry is pending only when both sides are non-empty; this one was pushed with pending = 0, so its join only pops.',
      why: ['Jumping back happens only on a pending entry, and this one is not.', '', 'Loading the empty else mask would end the warp, which is exactly why such an entry is not pending.'],
    },
    {
      question: 'At the first join of a pending entry, the else lanes continue at:',
      options: ['The first instruction of the else code', 'The instruction after the join', 'The address after the split, where their branch now goes the other way'], answer: 2,
      explain: 'The entry stores the address after the split; the if\'s branch runs again for the else lanes and takes them to their side.',
      why: ['The entry holds the address after the split, not the else code; the branch needs no change.', 'Going past the join is the second join\'s job, once both sides have run.', ''],
    },
  ],
  coalescing: [
    {
      question: 'Lanes 0–3 load from 0x203, 0x204, 0x205, 0x206 with mask 1111. How many accesses?',
      options: ['2: lane 0 alone, then lanes 1–3', '1: the addresses are consecutive', '4: no two addresses are equal'], answer: 0,
      explain: 'Lines are the address with bits 1 … 0 dropped: 0x203 is in line 0x080, the other three in line 0x081.',
      why: ['', 'Consecutive words share a line only within an aligned group of four; 0x203 ends one line, 0x204 starts the next.', 'Equal words are a special case: any lanes whose addresses agree above bits 1 … 0 are served together.'],
    },
    {
      question: 'Lane 0 is masked off and holds a stale address. Why must the line come from the leader, not lane 0?',
      options: ['Lane 0\'s address reads X while it is masked', 'It need not: any lane\'s line serves someone', 'A stale line may serve no active lane, and the sequencer would loop forever'], answer: 2,
      explain: 'The leader is an active lane, so its line serves at least the leader, and every access makes progress until left = 0.',
      why: ['The stale address is an ordinary number, not X; the trouble is that it may match no active lane.', 'Lane 0\'s line serves only active lanes that share it; if none does, the access serves nobody.', ''],
    },
  ],
  senseamp: [
    {
      question: 'A 20 fF cell storing a 1 shares charge with a 180 fF bit line precharged to V<sub>DD</sub>/2, V<sub>DD</sub> = 1.0 V. The line moves to:',
      options: ['1.0 V: the cell drives it to its level', '0.55 V: +50 mV', '0.6 V: +100 mV'], answer: 1,
      explain: '(20 · 1.0 + 180 · 0.5) / 200 = 0.55 V. The sense amplifier must resolve those 50 mV against its offset.',
      why: ['A cell cannot drive its line; it only shares charge, and 20 fF against 180 fF moves the line a little.', '', '0.6 V is the 25 fF-on-100 fF case; here the cell is a tenth of the total capacitance.'],
    },
    {
      question: 'The word line closes before sae fires. The cell is left with:',
      options: ['The shared level near VDD/2: the read destroyed its charge', 'Its full original level: a read leaves the cell untouched', 'The rail the amplifier picks later'], answer: 0,
      explain: 'Charge sharing moved the cell toward the middle as much as it moved the line; only the amplifier, with the word line up, writes it back.',
      why: ['', 'Charge sharing is mutual: the cell lost what the line gained.', 'The amplifier\'s rail reaches the cell only while the word line is up.'],
    },
  ],
  dma: [
    {
      question: 'm_dma\'s count register holds NOT(words left) and counts up. A 3-word copy starts it at:',
      options: ['0x0003, counting down to a comparator\'s 0', '0xFFFC, done when the incrementer\'s carry shows 0xFFFF', '0xFFFD (−3), done when it reaches 0x0000'], answer: 1,
      explain: 'NOT(3) = 0xFFFC; three increments reach 0xFFFF, where the incrementer\'s carry is 1. len = 0 starts at 0xFFFF and is done at once.',
      why: ['That needs the 16-bit comparator the design avoids; the carry already says all ones.', '', 'NOT(3) is 0xFFFC, one less than −3, and completion is all ones, read from the carry, with no zero detector.'],
    },
    {
      question: 'When should the DMA engine raise its interrupt?',
      options: ['When the last read completes', 'When the count is written', 'When the last write completes'], answer: 2,
      explain: 'The copy is done only when the last word is in the destination.',
      why: ['The last word is still in flight until it is written; software reading the destination now would miss it.', 'Writing the count starts the copy; the interrupt marks its end.', ''],
    },
  ],
  relay: [
    {
      question: 'Relay A\'s coil is driven by an input; B\'s coil is fed through A\'s make contact, C\'s through B\'s. The input rises at step 0. C operates at:',
      options: ['Step 1: current through contacts arrives at once', 'Step 0', 'Step 3, about 25 ms'], answer: 2,
      explain: 'A closes at step 1; B\'s coil gets current at once and B closes at step 2; C at step 3: 3 × 8.2 ms.',
      why: ['Current is instant, but each armature moves a step after its coil changes, and B\'s coil is fed only once A has closed.', 'An armature always takes a relay step to move after its coil changes.', ''],
    },
    {
      question: 'What can a relay contact do that no triode can?',
      options: ['Pass a signal in either direction at full strength', 'Switch faster', 'Work without a supply'], answer: 0,
      explain: 'A closed contact is metal on metal, like a CMOS transmission gate; a triode conducts only plate to cathode.',
      why: ['', 'A relay step is 8.2 ms; a tube gate switches in about 1 µs.', 'The coil needs current to hold; the difference is in the contact, which conducts both ways.'],
    },
  ],
  selfhold: [
    {
      question: 'A designer feeds the holding contact k.no straight from VDD instead of through reset\'s break contact. After one set pulse:',
      options: ['q falls back to 0 when set lets go', 'q stays 1 for good: nothing can open the holding path', 'q oscillates'], answer: 1,
      explain: 'k.no keeps k\'s coil fed; only a break contact in the holding path can let it drop out.',
      why: ['Holding after set lets go is what the make contact does; the missing piece is a way to stop it.', '', 'Oscillation needs a coil fed through its own break contact (the buzzer); a make contact holds.'],
    },
    {
      question: 'Why does the set pin operate a relay of its own instead of driving q directly?',
      options: ['A pin always drives its line: at 0 it would hold q at 0 against the holding contact', 'A pin is too weak to pull in a coil', 'Each bit needs two coils'], answer: 0,
      explain: 'A contact either connects the supply or leaves the line open; a pin at 0 actively holds the line low.',
      why: ['', 'Strength is not the problem: the pin wins, which is exactly what goes wrong when it says 0.', 'The bit itself is one relay; the set relay stands for set being a contact of another relay in a machine.'],
    },
  ],
  buzzer: [
    {
      question: 'The buzzer y alternates every relay step, and the divider q toggles once per buzzer period. q\'s period:',
      options: ['2 relay steps, about 16 ms', '4 relay steps, about 33 ms', '1 relay step'], answer: 1,
      explain: 'y is a square wave of 2 steps; halving its rate gives 4 steps, 4 × 8.2 = 32.8 ms.',
      why: ['That is the buzzer\'s own period; the divider halves the rate.', '', 'One step is half of the buzzer\'s period: y is 1 for one step and 0 for the next.'],
    },
    {
      question: 'The divider computes t′ = k ? ¬t : t from its own state t. Why does it not race?',
      options: ['The buzzer is slower than the divider', 'Its coil, a resistor, delays the change', 'Every armature moves at once at a relay step, so the toggle reads the old t'], answer: 2,
      explain: 'Contacts are read with every armature at rest; all move together at the next step, so t′ is computed from t, not from itself.',
      why: ['Both run on the same relay step; the guarantee comes from all armatures moving together.', 'The coil being a resistor sets what an undriven line reads (0); the timing comes from the relay step.', ''],
    },
  ],
  triode: [
    {
      question: 'A 6SN7 (μ = 20) has 200 V on its plate. Its grid cuts it off below about:',
      options: ['−10 V', '−12.5 V', '0 V'], answer: 0,
      explain: 'I ≈ K·(V<sub>g</sub> + V<sub>p</sub>/μ)<sup>1.5</sup> reaches zero at V<sub>g</sub> = −200 / 20 = −10 V.',
      why: ['', '−12.5 V is the cutoff with 250 V on the plate; it moves with the plate as −V<sub>p</sub>/μ.', 'At 0 V the tube conducts; the grid must cancel the plate\'s pull, V<sub>p</sub>/μ.'],
    },
    {
      question: 'Why is NOR, not NAND, the tube\'s natural gate?',
      options: ['Tubes can only pass a 1', 'A NAND would need a negative supply', 'Tubes in parallel on one plate resistor: any conducting tube pulls the plate low'], answer: 2,
      explain: 'Ratioed logic: the resistor pulls up, each tube pulls down, so parallel tubes give ¬(a + b). A NAND needs a diode AND in front of an inverter.',
      why: ['The reverse: a triode only conducts toward its cathode, so it pulls its plate down and never passes a 1.', 'Tube gates here use a negative supply anyway, for the grid dividers; it is not what separates NOR from NAND.', ''],
    },
  ],
  ecclesjordan: [
    {
      question: 'q is V1\'s plate. To set q = 1, the set pulse raises the grid of:',
      options: ['V1: a 1 on its grid makes its plate 1', 'V2: it conducts, its low plate cuts V1 off, and q rises', 'Both, so the pair settles faster'], answer: 1,
      explain: 'A conducting tube pulls its plate low. Making V2 conduct drops nq, which through the divider cuts V1 off: q goes to 250 V.',
      why: ['A higher grid makes V1 conduct, which pulls q low: the opposite of set.', '', 'With both grids raised both tubes conduct and both plates are low: neither state.'],
    },
    {
      question: 'Why do set and reset reach the grids through steering diodes rather than wires?',
      options: ['A diode can pull a grid up but never hold it down, so between pulses the pair holds itself', 'The diodes amplify the pulse', 'The diodes shift the pin\'s plate level down to a grid level'], answer: 0,
      explain: 'A wire would hold the grid at the pin\'s 0 between pulses, and the pair could never hold the other state.',
      why: ['', 'Diodes do not amplify; the tubes do.', 'Level shifting is the divider\'s job; the diode\'s job is to let go when the pin is 0.'],
    },
  ],
};
