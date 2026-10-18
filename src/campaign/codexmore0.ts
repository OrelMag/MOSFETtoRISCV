// The fuller codex: components, laws and tools. See codexmore.ts.

import type { CodexMore } from './codexmore';

export const MORE0: Record<string, CodexMore> = {
  // ---- transistors
  mosfet: {
    idea: 'A MOSFET is a switch whose control terminal, the gate, draws no DC current: it is a capacitor plate over a thin oxide. In an <b>NMOS</b>, a gate voltage more than the threshold V<sub>t</sub> above the source pulls electrons into a channel between source and drain; a <b>PMOS</b> forms a channel of holes when its gate sits V<sub>t</sub> below its source. Each passes one level well: an NMOS pulls a node fully to 0 but raises it only to V<sub>DD</sub> − V<sub>t</sub>, a PMOS the reverse. That asymmetry is why logic puts NMOS between the output and ground and PMOS between the output and V<sub>DD</sub>.<br>The simulator works at switch level: a conducting transistor joins its two terminals, an off one is open, and conflicts are settled by strength: rails and inputs, then transistors, then resistors, then charge left on a floating node. Area is counted in transistors below the gate level and in NANDs above it.',
    example: { title: 'An NMOS asked to pass a 1', body: 'V<sub>DD</sub> = 1.0 V, V<sub>t</sub> = 0.3 V. Gate and drain at 1.0 V: the source node charges until V<sub>GS</sub> falls to V<sub>t</sub>, so it stops at 1.0 − 0.3 = <b>0.7 V</b>, a weak 1 the next gate may misread. The same NMOS passing a 0 pulls its node all the way to 0 V. A PMOS is the mirror image: a full 1, and a 0 stuck at 0.3 V.' },
    mistakes: [
      'Using an NMOS as a pull-up (or a PMOS as a pull-down): the output stops a threshold short of the rail, and the next stage, half on, draws static current.',
      'Treating the gate as a current input: it is a capacitance. Delay comes from charging the gates a net drives (fan-out) and the wire, not from a gate consuming its input.',
      'Forgetting that a node whose paths are all off keeps its last value as charge for a while: DRAM relies on it on purpose, a floating input in a design does it by accident.',
    ],
    lib: 'nmos_switch',
    chapters: [{ chapter: 'mosfet', step: 0, label: 'A switch made of silicon' }, { chapter: 'mosfet', step: 1, label: 'Three regions' }, { chapter: 'mosfet', step: 2, label: 'NMOS and PMOS' }, { chapter: 'mosfet', step: 3, label: 'What one switch costs' }, { chapter: 'mosfet', step: 4, label: 'One switch is not enough' }],
  },
  inverter: {
    idea: 'The CMOS inverter is one PMOS from V<sub>DD</sub> to the output and one NMOS from the output to ground, gates tied together. a = 0: the PMOS conducts, the NMOS is off, y = 1; a = 1: the reverse. In either steady state one transistor is off, so no current flows from rail to rail, and power is spent only charging and discharging the output when it switches (dynamic power ∝ C·V²·f). The output is always driven by a rail, so the inverter restores a degraded input: a chain of inverters regenerates logic levels.<br>It is 2 transistors. NOT built from a NAND with both inputs tied is 4, which is why cell libraries keep the real inverter, and use chains of growing inverters as buffers to drive large loads.',
    example: { title: 'Pseudo-NMOS against CMOS', body: 'Replace the PMOS by a pull-up resistor (pseudo-NMOS, 1 transistor). For a = 1 the NMOS and the resistor conduct together: the output is a voltage divider, near 0 only if the NMOS is much stronger, and current flows for as long as a = 1. A million such gates at 10 µA each draw 10 A doing nothing. The CMOS inverter draws essentially no static current.' },
    mistakes: [
      'Building inverters from NANDs in a real cell library: twice the transistors and more input capacitance for the same function.',
      'Assuming the switching threshold is V<sub>DD</sub>/2 whatever the sizing: it moves with the PMOS/NMOS strength ratio, which is why PMOS are drawn wider.',
      'Driving a large load (a clock net, a long bus) from a minimum-size inverter: delay grows with the load, so real designs taper up through a chain of inverters.',
    ],
    lib: 'inv_cmos', compare: ['not', 'inv_pseudo'],
    chapters: [{ chapter: 'inverter', step: 0, label: 'Pull up, pull down' }, { chapter: 'inverter', step: 1, label: 'Why this is brilliant' }, { chapter: 'inverter', step: 2, label: 'The cheaper, hotter way: a pull-up' }],
  },
  nand: {
    idea: 'NAND puts two NMOS in series between the output and ground and two PMOS in parallel from V<sub>DD</sub>. The output is pulled low only when both NMOS conduct (a = b = 1); otherwise at least one PMOS pulls it high. It is the cheapest 2-input CMOS gate that is also universal, and its series devices are the faster NMOS, so it is the brick of the gate level here: every count is in NANDs (4 transistors each) and every delay in NAND delays, one per gate regardless of load.<br>A 3-input NAND stacks three NMOS, and each series device slows the pull-down, so wide functions are built as trees of 2-input gates.',
    example: { title: 'a = 1, b = 0', body: 'Pull-down: NMOS(a) on, NMOS(b) off: the series path is open.<br>Pull-up: PMOS(b) on (its gate is 0): y connects to V<sub>DD</sub>.<br>y = 1 = ¬(1·0). For each of the four input pairs exactly one network conducts, so y is never floating and never shorted.' },
    mistakes: [
      'Counting a NAND as an AND: the inversion is the free part. AND costs a second stage (2 NANDs, 2 delays).',
      'Swapping the networks (NMOS in parallel, PMOS in series): that is a NOR.',
      'Expecting one delay per gate in silicon: here every NAND costs 1 whatever it drives; a real gate slows with fan-out and wire load.',
    ],
    lib: 'nand',
    chapters: [{ chapter: 'nand', step: 0, label: 'Two inputs' }, { chapter: 'nand', step: 2, label: 'One brick to build everything' }],
  },
  nor: {
    idea: 'NOR is the dual of NAND: NMOS in parallel (any input at 1 pulls the output down), PMOS in series (the output rises only when every input is 0). It is functionally complete too. Its cost is the series PMOS: holes are 2–3× less mobile than electrons, so a PMOS needs that much more width to conduct like an NMOS, and two in series need twice that again. A NOR is therefore slower than a NAND of the same area, or bigger at the same speed, which is why CMOS logic is mostly NANDs and inverters.<br>From NANDs, NOR is an OR followed by a NOT: 4 NANDs, 3 delays.',
    example: { title: 'Sizing for equal drive', body: 'Unit NMOS width 1, PMOS 2× weaker per unit width.<br>Inverter: NMOS 1, PMOS 2.<br>NAND2: series NMOS 2 each, parallel PMOS 2 each: total width 8, 4 per input.<br>NOR2: parallel NMOS 1 each, series PMOS 4 each: total width 10, 5 per input. Every NOR input loads its driver 25 % more.' },
    mistakes: [
      'Building a NOR from four NANDs when a De Morgan rewrite of the surrounding logic removes it: ¬(a + b) is ¬a·¬b, and the complements may already exist.',
      'Assuming NAND and NOR cost the same because both have 4 transistors: the series PMOS make the NOR larger or slower.',
    ],
    lib: 'nor_cmos', compare: ['nor'],
    chapters: [{ chapter: 'nand', step: 1, label: 'NOR, for comparison' }, { chapter: 'gates', step: 3, label: 'NOR: a box of boxes' }],
  },
  universality: {
    idea: 'A set of gates is functionally complete when every Boolean function can be built from it. The proof has two steps: every function is a sum of products of literals (read it off the truth table\'s 1 rows), so AND, OR and NOT suffice; and each of those is a few NANDs: NOT a = NAND(a, a), AND = NOT(NAND), OR = NAND(¬a, ¬b). NOR works the same way by duality. AND and OR alone do not: they are monotone (raising an input never lowers the output), so no circuit of them computes ¬a.<br>This is why one cell type is enough for a CPU and why everything here is counted in NANDs. Completeness says nothing about cost: a NAND realization is only as good as the minimization and sharing behind it.',
    example: { title: 'XOR in 4 NANDs, not 5', body: 'From the sum of products a·¬b + ¬a·b: 2 NOTs, 2 NANDs for the terms, 1 NAND to combine: 5.<br>Sharing: n = NAND(a, b), y = NAND(NAND(a, n), NAND(b, n)).<br>a = 1, b = 0: n = 1, NAND(1, 1) = 0, NAND(0, 1) = 1, y = NAND(0, 1) = 1. 4 NANDs, depth 3.' },
    mistakes: [
      'Concluding that NAND-only means NAND-optimal: the canonical sum of products is complete and rarely cheap.',
      'Thinking AND and OR are complete because sums of products look like them: without an inverter, ¬a cannot be made from a.',
      'Forgetting constants: NOT a = NAND(a, 1) works as well as NAND(a, a), and a tie cell supplies the 1.',
    ],
    lib: 'xor',
    chapters: [{ chapter: 'nand', step: 2, label: 'One brick to build everything' }, { chapter: 'gates', step: 0, label: 'NOT: tie the inputs together' }, { chapter: 'gates', step: 4, label: 'XOR: are they different?' }],
  },
  duality: {
    idea: 'The dual of an expression swaps AND with OR and 0 with 1; variables and their complements stay as they are. If an identity holds, its dual holds, so the laws of Boolean algebra come in pairs: <code>a + 0 = a</code> and <code>a·1 = a</code>, the two distributive laws, the two De Morgan laws. Prove one, get the other.<br>In CMOS, duality is the construction rule. The NMOS pull-down conducts when the output should be 0: series transistors for AND, parallel for OR. The PMOS pull-up is its dual (series ↔ parallel) on the same inputs; since a PMOS conducts on 0, the pull-up conducts exactly when the pull-down does not. Any function of the form ¬(AND–OR of uncomplemented inputs) becomes one complex gate this way.',
    example: { title: 'y = ¬(a·(b + c)) in 6 transistors', body: 'Pull-down: NMOS a in series with (NMOS b ∥ NMOS c): conducts when a·(b + c).<br>Pull-up, the dual: PMOS a in parallel with (PMOS b in series with PMOS c): conducts when ¬a + ¬b·¬c = ¬(a·(b + c)).<br>6 transistors, one stage. From 2-input NANDs: b + c takes 3, then NAND with a: 4 NANDs, 16 transistors, 3 delays.' },
    mistakes: [
      'Complementing the variables when taking the dual: the dual of <code>a + ¬a·b</code> is <code>a·(¬a + b)</code>.',
      'Confusing the dual with the complement: the complement also inverts every literal (De Morgan); the dual does not, and is in general a different function.',
      'Drawing the pull-up as a copy of the pull-down: for some inputs both conduct and short V<sub>DD</sub> to ground, for others neither does and the output floats.',
    ],
    lib: 'nor_cmos',
    chapters: [{ chapter: 'inverter', step: 0, label: 'Pull up, pull down' }, { chapter: 'nand', step: 1, label: 'NOR, for comparison' }],
  },

  // ---- algebra and gates
  truthtable: {
    idea: 'A truth table lists the output for every input combination: n inputs give 2ⁿ rows. It is the specification a combinational block must meet, independent of how it is built, so it is also the test: apply every row, compare. That is cheap up to about 16 input bits (65 536 rows) and hopeless at 32 (4.3 × 10⁹). Wider blocks are tested on chosen vectors (a carry through every bit, 0x7FFF and 0x8000, x0) plus random ones, and trusted by construction: a 16-bit adder is sixteen copies of a full adder whose 8 rows were checked completely.<br>The table also starts the design flow: its 1 rows are the minterms of the canonical sum of products, the input to a K-map or Quine–McCluskey, and rows that cannot occur are don\'t-cares.',
    example: { title: 'How many rows', body: '<code>NAND: 2 inputs → 4 rows</code><br><code>full adder: 3 → 8</code><br><code>prime detector: 4 → 16</code><br><code>4-bit adder: 4 + 4 + 1 = 9 → 512</code><br><code>16-bit equality: 32 → 4 294 967 296</code><br>The campaign\'s Check runs every row up to 16 input bits; beyond that, the level\'s directed cases plus 4 096 random vectors.' },
    mistakes: [
      'Testing a wide block on a few friendly values: the bugs live in long carries, sign boundaries and writes to x0.',
      'Writing rows in an order other than binary counting, then misnumbering the minterms when minimizing.',
      'Using a table for a circuit with state: the same inputs can give different outputs, so it needs a sequence.',
    ],
    lib: 'full_adder',
    chapters: [{ chapter: 'adders', step: 1, label: 'Adding three bits' }],
  },
  identities: {
    idea: 'The identities are the rewrite rules that turn an expression into a cheaper one with the same truth table. Four do most of the work. <b>Complement</b> merges two terms that differ in one variable (a·b + a·¬b = a), which is all a K-map rectangle does. <b>Absorption</b> drops a term covered by a smaller one (a + a·b = a). <b>Distributivity</b> factors a shared literal out (a·b + a·c = a·(b + c): fewer gates, one level deeper). <b>Consensus</b> drops the redundant b·c from a·b + ¬a·c + b·c. Each has a dual.<br>Rewriting trades area against depth: factoring saves gates and adds levels, flattening to a sum of products does the reverse. A redundant term is not always waste: the consensus term is what keeps a mux from glitching.',
    example: { title: 'Simplify, then put one term back', body: '<code>f = a·b + a·¬b + ¬a·b</code><br><code>&nbsp;&nbsp;= a + ¬a·b</code> (complement on the first two)<br><code>&nbsp;&nbsp;= (a + ¬a)·(a + b) = a + b</code> (distributivity, second form)<br>An OR: 3 NANDs, against 8 for the sum of products as written.<br>The 4-NAND mux <code>y = s·b + ¬s·a</code> glitches to 0 for one delay when s falls with a = b = 1, because ¬s arrives one NAND late. The consensus term a·b holds y at 1 through the change.' },
    mistakes: [
      'Forgetting the second distributive law: a + b·c = (a + b)·(a + c) holds in Boolean algebra though not in arithmetic.',
      'Removing a consensus term from logic whose glitches matter (an asynchronous reset, a latch enable): the function is unchanged, the transient is not.',
      'Minimizing each output for the fewest literals and ignoring sharing: a term used by two outputs is built once.',
    ],
    chapters: [{ chapter: 'gates', step: 6, label: 'The multiplexer: a digital switch' }],
  },
  demorgan: {
    idea: 'De Morgan: ¬(a·b) = ¬a + ¬b and ¬(a + b) = ¬a·¬b. An inversion passes through a gate by inverting each input and swapping AND with OR. Read the other way, a NAND is an OR with inverted inputs and a NOR is an AND with inverted inputs: one physical gate, two drawings. That is the basis of NAND-only logic: an AND–OR (sum of products) becomes NAND–NAND by putting a bubble at each end of every internal wire, and two bubbles on one wire cancel.<br>The general form complements a whole expression: complement every literal and swap · with +. ¬(a·b + c) = (¬a + ¬b)·¬c.',
    example: { title: 'OR, and a zero detector', body: '<code>a + b = ¬(¬a·¬b) = NAND(NAND(a, a), NAND(b, b))</code>: 3 NANDs, depth 2.<br>"All 16 bits are 0" is <code>¬(x15 + … + x0) = ¬x15·…·¬x0</code>: an OR tree and one inverter, or an AND tree of inverted bits. The library\'s 16-bit zero detector is the OR tree: 46 NANDs, 9 delays.' },
    mistakes: [
      'Inverting the operator but not the inputs: ¬(a·b) is ¬a + ¬b, not a + b.',
      'Pushing a bubble onto a wire that fans out: every other reader of that wire then needs its own inverter.',
      'Applying it to part of an expression only: ¬(a·b + c) needs both rewrites, giving (¬a + ¬b)·¬c.',
    ],
    lib: 'or',
    chapters: [{ chapter: 'gates', step: 2, label: "OR: De Morgan's trick" }, { chapter: 'gates', step: 3, label: 'NOR: a box of boxes' }],
  },
  not: {
    idea: 'NOT from a NAND ties both inputs together: ¬(a·a) = ¬a. 1 NAND, 1 delay. Every complemented literal in a sum of products, the select inversion of a mux and the "no carry" of an unsigned compare cost one. NOTs are also the easiest gates to remove: two in a row cancel, and De Morgan moves an inversion to where a NAND absorbs it, which is where most NAND-count savings come from.<br>Built from a NAND it is 4 transistors; the CMOS inverter does the same with 2, which is why real cell libraries have both.',
    example: { title: 'Inverters in a bus mux', body: '<code>y = s·b + ¬s·a</code> needs ¬s once: 1 NOT, then NAND(s, b), NAND(¬s, a) and a NAND to combine: 4 NANDs.<br>A 16-bit bus mux shares one ¬s across its 16 bits: 1 + 16 × 3 = 49 NANDs, RV16\'s bus mux. The library\'s mux2x16 repeats the 4-NAND mux, 64 NANDs.' },
    mistakes: [
      'Placing a NOT at each of several readers of one signal instead of one NOT feeding them all.',
      'Inverting a signal in one block and inverting it back in the next: remove both.',
    ],
    lib: 'not', compare: ['inv_cmos'],
    chapters: [{ chapter: 'gates', step: 0, label: 'NOT: tie the inputs together' }],
  },
  and: {
    idea: 'AND is a NAND followed by a NOT: 2 NANDs, 2 delays. It is the gate of enables and conditions: a register\'s write enable is decoder output ∧ we, a branch is taken when br ∧ condition, a cache hits when valid ∧ tag match. Wide ANDs are trees: an n-input AND is 2(n − 1) NANDs in 2·⌈log2 n⌉ levels (4 inputs: 6 NANDs, 4 delays; 8 inputs: 14 and 6).<br>Inside a larger expression the trailing NOT usually disappears: a product feeding an OR is the first NAND of a NAND–NAND pair, so a sum of products costs fewer NANDs than counting its ANDs and ORs suggests.',
    example: { title: 'Branch taken', body: 'In the RV16 next-PC logic, <code>taken = br·take</code> (2 NANDs), then <code>ld = jal + jalr + taken</code>.<br>Written as NAND–NAND, the AND\'s output NOT and the OR\'s input inverter cancel: NAND(br, take) is already the ¬taken the OR wants.' },
    mistakes: [
      'Making a clock enable with clk AND en: it glitches and delays the clock. Put a mux in front of the flip-flop instead.',
      'Building an 8-input AND as a chain: 14 delays instead of a 3-level tree\'s 6, for the same 14 NANDs.',
    ],
    lib: 'and', anatomy: ['npc', 'rf'],
    chapters: [{ chapter: 'gates', step: 1, label: 'AND: undo the NOT' }],
  },
  or: {
    idea: 'OR from NANDs is De Morgan: a + b = ¬(¬a·¬b) = NAND(¬a, ¬b), 3 NANDs and 2 delays, the two input inverters working in parallel. In a CPU it merges conditions (the PC redirects on jal + jalr + taken; a trap is the OR of its sources) and finds any 1 in a word: a 16-input OR tree is 45 NANDs, 8 delays.<br>Its inverters are often already there: if the inputs come from NANDs, their outputs are the complements the OR needs, and the OR collapses into one NAND. That is NAND–NAND logic.',
    example: { title: 'Four signals, three ways', body: 'Chain OR(OR(OR(a, b), c), d): 9 NANDs, 6 delays.<br>Tree OR(OR(a, b), OR(c, d)): 9 NANDs, 4 delays.<br>Inputs that are products made by NANDs: one 4-input NAND of the NAND outputs (5 two-input NANDs), 3 delays, no inverters.' },
    mistakes: [
      'Building OR as NOT(NOR) from the 4-NAND NOR: 5 NANDs and 4 delays for a 3-NAND, 2-delay gate.',
      'Counting the input inverters of every OR when the inputs already exist complemented.',
    ],
    lib: 'or', anatomy: ['npc', 'alu'],
    chapters: [{ chapter: 'gates', step: 2, label: "OR: De Morgan's trick" }],
  },
  xor: {
    idea: 'XOR is 1 when its inputs differ. It is the sum bit of an adder (a ⊕ b ⊕ cin), a controlled inverter (x ⊕ 1 = ¬x, x ⊕ 0 = x, so b ⊕ sub flips b for subtraction), a one-bit inequality (an equality comparator is an XOR per bit and a zero detector) and the parity of a word. From NANDs the minimum is 4: the first NAND n = ¬(a·b) is shared by both halves, y = NAND(NAND(a, n), NAND(b, n)), depth 3. XNOR is XOR plus a NOT: 5 NANDs, 4 delays.<br>XOR is associative and commutative, so a parity tree or a three-input sum can be grouped in any order. In CMOS it takes more transistors than a NAND in any common style, which is why adders and comparators are designed around as few XORs as possible.',
    example: { title: 'b ⊕ sub in a subtractor', body: 'a − b = a + ¬b + 1. With sub = 1, b = 0101 becomes 0101 ⊕ 1111 = 1010 = ¬b, and cin = sub = 1.<br>7 − 5: <code>0111 + 1010 + 1 = 1 0010</code>: result 0010 = 2, carry out 1 (no borrow).' },
    mistakes: [
      'Building XOR from its sum of products a·¬b + ¬a·b: 5 NANDs where 4 suffice.',
      'Taking a full adder\'s carry from a ⊕ b: that is the propagate signal; the carry is a·b + cin·(a ⊕ b).',
    ],
    lib: 'xor', anatomy: ['alu', 'br', 'fwd'],
    chapters: [{ chapter: 'gates', step: 4, label: 'XOR: are they different?' }, { chapter: 'gates', step: 5, label: 'XNOR: are they equal?' }, { chapter: 'adders', step: 5, label: 'Subtraction for free' }],
  },
  mux: {
    idea: 'A 2:1 multiplexer passes a when s = 0 and b when s = 1: y = s·b + ¬s·a, which is NAND–NAND logic plus an inverter for ¬s: 4 NANDs, depth 3 from s and 2 from the data inputs. It is the datapath\'s switch: wherever the control unit chooses (ALU operand: register or immediate; result: ALU, load or pc + 1; next PC: pc + 1 or target; a forwarded operand) there is a bus of muxes driven by one control bit.<br>An N:1 mux is a tree of log2 N levels of 2:1 muxes, level k steered by select bit k; a w-bit bus mux is w of them on a common select. Cost grows as (N − 1)·w muxes, so wide many-input muxes are expensive: the 8:1 result mux of the 16-bit ALU is 343 NANDs, a third of the ALU, even with one ¬s shared by each bus mux\'s sixteen bits (49 NANDs instead of 64).',
    example: { title: 'An 8:1 mux, s = 101', body: 'Level 0 (s0 = 1): d1, d3, d5, d7 win their pairs.<br>Level 1 (s1 = 0): d1 and d5.<br>Level 2 (s2 = 1): d5.<br>7 muxes, 28 NANDs per bit; depth 7: 3 through the first level\'s select path, then 2 per level.' },
    mistakes: [
      'Driving a select from a late signal: the select path is the deep one (3 delays against 2 for data).',
      'Leaving unused inputs of a mux tree unconnected: tie them to a constant so the output is defined for every select value.',
    ],
    lib: 'mux2', anatomy: ['wb', 'alu', 'npc', 'fwd'],
    chapters: [{ chapter: 'gates', step: 6, label: 'The multiplexer: a digital switch' }, { chapter: 'routing', step: 2, label: 'Bigger multiplexers are trees' }, { chapter: 'routing', step: 3, label: 'Switching whole buses' }],
  },
  decoder: {
    idea: 'A decoder turns an n-bit number into 2ⁿ wires, exactly one of them 1. Output k is the AND of the address bits, each taken true or complemented according to the digits of k, so the decoder is n inverters and 2ⁿ n-input ANDs; an enable is one more AND input. It is how a number selects a thing: the register written by rd (output ∧ we is that register\'s load enable), the RAM word written, the device a store reaches in the MMIO range, the state wire of a one-hot controller.<br>Cost grows as 2ⁿ: 3→8 is 35 NANDs (51 with an enable), 4→16 is 100. Large memories split the address into row and column decoders, and large decoders are built from small predecoders whose outputs are ANDed.',
    example: { title: 'rd = 5, we = 1', body: '5 = 101: y5 = a2·¬a1·a0·en = 1·1·1·1 = 1.<br>Every other output has a factor 0: y4 = a2·¬a1·¬a0·en has ¬a0 = 0.<br>With we = 0 all eight outputs are 0 and no register loads: that is how a store or a branch writes no register.' },
    mistakes: [
      'Leaving out the enable: some register then loads on every cycle, including sw and branches.',
      'Building every output from scratch: the complemented address bits are shared by all outputs, and two 2→4 predecoders plus sixteen 2-input ANDs make a 4→16.',
      'Relying on exactly one output being 1 while the address changes: two can be 1 briefly. Clocked use is safe; a decoder driving latches or asynchronous enables is not.',
    ],
    lib: 'dec3e', anatomy: ['rf', 'dmem', 'mmio'],
    chapters: [{ chapter: 'routing', step: 0, label: 'The decoder: a number becomes one wire' }, { chapter: 'routing', step: 1, label: 'With an enable' }],
  },
  comparator: {
    idea: 'Two words are equal when no bit differs: eq = ¬(Σ a<sub>i</sub> ⊕ b<sub>i</sub>), an XOR per bit and a zero detector (an OR tree and one inverter). The XORs work in parallel and the tree is logarithmic, so 16 bits cost 110 NANDs and 12 delays, while a 16-bit subtraction alone takes 41. In a CPU it decides beq and bne, finds forwarding and load-use matches between 3-bit register numbers, and checks cache tags.<br>Less-than is a different circuit: a subtraction (unsigned: no carry out; signed: the sign corrected for overflow, N ⊕ V) or a magnitude comparator that merges per-field "greater" and "equal" signals in a tree, the high field deciding unless it is equal.',
    example: { title: 'A forwarding match', body: 'rs1 = 3 (011), rd in E/M = 3, rweM = 1: <code>011 ⊕ 011 = 000</code>, so eq = 1; rd ≠ 0, so forward.<br>A 3-bit comparator is 19 NANDs, 8 delays; the RV16 forwarding unit uses four (rs1 and rs2 against rd in M and in W).' },
    mistakes: [
      'Matching register numbers without checking rd ≠ x0: an instruction writing x0 would forward a value no one may read.',
      'Taking equality from the ALU\'s zero flag after a subtraction: correct, but behind the whole carry chain.',
      'Comparing cache tags without the valid bit: after reset a stale tag can match and hit on a line never filled.',
    ],
    lib: 'eq4', anatomy: ['br', 'fwd', 'haz'],
    chapters: [{ chapter: 'adders', step: 6, label: 'Comparing without subtracting' }, { chapter: 'pipepay', step: 1, label: 'A comparator for branches' }],
  },

  // ---- arithmetic
  halfadder: {
    idea: 'A half adder adds two bits: s = a ⊕ b, c = a·b (1 + 1 = 10). It has no carry input, so it fits only where the incoming carry is known: bit 0 of an adder with cin = 0, or an incrementer, where each bit adds the carry from below to a single bit. In NANDs the carry is nearly free: the XOR\'s first NAND is ¬(a·b), and one more NAND as an inverter gives a·b. 5 NANDs; s after 3 delays, c after 2.<br>Two half adders and an OR make a full adder (13 NANDs); sharing more gives 9.',
    example: { title: '1 + 1, gate by gate', body: '<code>n = NAND(1, 1) = 0</code><br><code>c = NAND(n, n) = 1</code><br><code>NAND(a, n) = 1, NAND(b, n) = 1, s = NAND(1, 1) = 0</code><br>c s = 10 = 2.' },
    mistakes: [
      'Using a half adder where a carry can arrive: the sum is off by one whenever it does.',
      'Making the carry with a separate AND (2 NANDs) instead of inverting the XOR\'s first NAND (1).',
    ],
    lib: 'half_adder', anatomy: ['plus1'],
    chapters: [{ chapter: 'adders', step: 0, label: 'Adding two bits' }],
  },
  fulladder: {
    idea: 'A full adder adds one column of binary addition, with the carry from the column to its right as a third input. The sum is 1 when an odd number of the three inputs are 1 (parity), the carry when at least two are (majority): cout = a·b + cin·(a ⊕ b). Chain <i>n</i> of them, each <code>cout</code> into the next <code>cin</code>, and you have an <i>n</i>-bit adder whose last sum bit waits for every carry before it.<br>The 9-NAND version is two XORs whose first NANDs, ¬(a·b) and ¬((a ⊕ b)·cin), are exactly the two terms of the carry: one more NAND combines them. Depth 6 from a or b, but cin reaches cout through only 2 NANDs, and that 2 per bit is the speed of a ripple adder.',
    example: { title: '1 + 1 + 1', body: '<code>a⊕b = 0 → s = 0 ⊕ 1 = 1</code><br><code>a·b = 1 → cout = 1</code> (binary 11 = 3)' },
    mistakes: [
      'Taking the carry from <code>a⊕b</code> instead of <code>a·b</code>: wrong for a = b = 1.',
      'Building the carry from fresh gates (13 NANDs) when <code>¬(a·b)</code> and <code>¬((a⊕b)·cin)</code> already exist inside the two XORs.',
    ],
    lib: 'full_adder', compare: ['full_adder_ha'], anatomy: ['alu', 'npc', 'br'],
    chapters: [{ chapter: 'adders', step: 1, label: 'Adding three bits' }, { chapter: 'adders', step: 2, label: 'Optimizing: 13 NANDs → 9' }],
  },
  ripple: {
    idea: 'Chain n full adders, each carry out into the next carry in, and you add n-bit words: 9n NANDs, the cheapest adder there is. Its delay is the carry chain: bit 0 produces its carry 5 delays after the inputs settle, each later bit passes it on in 2 (cin → cout through two NANDs), and the top sum bit adds its XOR: 2n + 4 delays, 36 at 16 bits, 68 at 32. The worst case is a carry generated at the bottom and propagated through every bit, as in 0xFFFF + 1.<br>The carry chain is the longest path through the ALU, the branch comparator and the next-PC adders of a simple CPU, so it sets the clock: the RV16 single-cycle core needs 98 NAND delays per cycle with ripple adders and 76 with Kogge–Stone. Faster adders spend NANDs to shorten the chain: the 16-bit Kogge–Stone is 366 NANDs and 16 delays against 144 and 36.',
    example: { title: '0xFFFF + 0x0001, timed', body: 'Bit 0 generates (a0 = b0 = 1); every other bit propagates (a ⊕ b = 1).<br><code>c1 at 5, c2 at 7, …, c(k+1) at 5 + 2k</code><br><code>c15 at 33, cout at 35, s15 = p15 ⊕ c15 at 36</code><br>Result 0x0000 with carry out 1, after 36 delays. Most additions settle sooner; the clock must allow for this one.' },
    mistakes: [
      'Feeding a late signal into cin: it enters at the bottom of the chain and waits for all n bits.',
      'Measuring an adder on random inputs: carries rarely propagate far, but the period must cover the longest chain, which static timing finds.',
      'Expecting a flat 4-bit lookahead adder to beat ripple with 2-input gates: here it is 15 delays against 12. Lookahead pays at larger widths, organized as a tree.',
    ],
    lib: 'rca8', compare: ['ks8', 'csel8_4'], anatomy: ['alu', 'npc', 'br'],
    chapters: [{ chapter: 'adders', step: 3, label: 'Chaining: the ripple-carry adder' }, { chapter: 'adders', step: 4, label: 'Watch the carry ripple' }, { chapter: 'fastadd', step: 0, label: 'The ripple problem' }],
  },
  incrementer: {
    idea: 'An incrementer adds 1: an adder with b = 0 and cin = 1. With b fixed, each full adder collapses into a half adder adding the carry from below to one bit, and bit i flips exactly when all bits below it are 1. 5 NANDs per bit: 80 for 16 bits against 144 for a 16-bit adder. The chain is still serial: the carry into bit i is the AND of bits 0…i − 1, built as a chain of ANDs, 2 delays per bit, 33 at 16 bits. Bit 0 needs no half adder (its sum is ¬a0, its carry a0 itself): RV16\'s incrementer is 76 NANDs, 31 delays. A prefix version computes those ANDs as a tree: 159 NANDs, 11 delays.<br>The PC uses one every cycle (pc + 1 in RV16, which counts words; pc + 4 in RV32, which counts bytes), and so does every counter.',
    example: { title: '1011 + 1', body: 'bit 0: 1 + 1 → s = 0, carry 1<br>bit 1: 1 + 1 → s = 0, carry 1<br>bit 2: 0 + 1 → s = 1, carry 0<br>bit 3: 1 + 0 → s = 1<br>1100 = 12. The carry runs up through the trailing 1s and stops at the first 0.' },
    mistakes: [
      'Using a full adder chain with b = 0 for pc + 1: correct, but 9 NANDs per bit where 5 do.',
      'Ignoring the wrap: 0xFFFF + 1 = 0x0000 with carry out 1; a counter that must stop has to look at the carry.',
      'Treating the incrementer as fast because it is small: its carry chain is as long as a ripple adder\'s.',
    ],
    lib: 'inc4', anatomy: ['plus1', 'pc'],
    chapters: [{ chapter: 'registers', step: 2, label: 'A counter' }],
  },
  shifter: {
    idea: 'A barrel shifter shifts a word by any amount 0…n − 1 in one pass. Write the amount in binary: shifting by 5 is shifting by 4 and by 1. So log2 n levels of 2:1 bus muxes, level k shifting by 2ᵏ when bit k of the amount is 1. The shift itself is free: a shifted bus is the same wires moved over; each level costs n muxes. 16 bits in one direction: 4 levels × 16 muxes, 196 NANDs with one ¬s per level (256 with a 4-NAND mux per bit).<br>RV16\'s shifter serves sll, srl and sra with one right-shifting core: a left shift reverses the bit order on the way in and out (two more bus muxes), and an arithmetic shift fills the vacated bits with the sign instead of 0. The 16-bit unit is 299 NANDs and 14 delays: shallow beside the adder, large in area.',
    example: { title: 'sra 0xF0F0 by 5', body: 'Amount 5 = 0101: the by-1 and by-4 levels shift, the by-2 and by-8 levels pass.<br><code>1111 0000 1111 0000</code><br>by 1: <code>1111 1000 0111 1000</code><br>by 4: <code>1111 1111 1000 0111</code> = 0xFF87<br>The vacated top bits copy bit 15. Signed: −3856 / 32 = −120.5, rounded down to −121 = 0xFF87.' },
    mistakes: [
      'Using a shift register for a variable shift: one place per clock, up to n − 1 cycles.',
      'Filling an arithmetic right shift with 0: sra of a negative number then turns it positive.',
      'Taking the whole of rs2 as the amount: RV16 uses its low 4 bits (a shift by 16 is a shift by 0), RV32 the low 5.',
    ],
    lib: 'shift8', anatomy: ['alu'],
    chapters: [{ chapter: 'alu', step: 1, label: 'The barrel shifter' }],
  },
  alu: {
    idea: 'The ALU computes every operation at once and a multiplexer keeps one: an adder/subtractor (add, sub, and slt / sltu from the subtraction\'s flags), a barrel shifter (sll, srl, sra), three bitwise rows (xor, or, and), and an 8:1 bus mux steered by f3. RV16 drives it with ctl = {OPX, f3}, the instruction\'s own bits, so the control unit has almost nothing to decode: ctl[3] turns add into sub and srl into sra.<br>The 16-bit ALU is 1 055 NANDs. The result mux (343) and the shifter (299) are most of the area, the subtractor (212) most of the delay: depth 64 with ripple carry, 42 with a Kogge–Stone adder, for 218 more NANDs.',
    example: { title: 'slt and sltu on the same operands', body: 'a = 0x8000, b = 0x7FFF. The subtractor computes a + ¬b + 1 = 0x8000 + 0x8000 + 1 = 0x1_0001: result 0x0001, carry out 1.<br>sltu: carry out 1 means no borrow, a ≥ b unsigned: 0.<br>slt: N = 0, V = 1 (negative minus positive gave a positive): N ⊕ V = 1, so −32768 &lt; 32767: 1.' },
    mistakes: [
      'Taking signed less-than from the sign of a − b alone: wrong whenever the subtraction overflows, as for 0x8000 − 0x7FFF.',
      'Inventing a separate ALU operation code in the control unit when the instruction\'s own bits can drive the ALU.',
      'Speeding up the shifter or the mux: the delay is in the carry chain; they matter for area.',
    ],
    lib: 'rv16_alu16', compare: ['rv16_alu16ks'], anatomy: ['alu'],
    chapters: [{ chapter: 'alu', step: 0, label: 'Bitwise operations are free parallelism' }, { chapter: 'alu', step: 3, label: 'The complete ALU' }],
  },

  // ---- state
  latch: {
    idea: 'Two NANDs, each output feeding the other\'s input, make a loop with two stable states: q = 1, q̄ = 0 or the reverse. With both inputs at 1 each NAND inverts the other, so the loop holds its state indefinitely: one bit of memory, 2 NANDs, no clock. Pulling s̄ to 0 forces q = 1, pulling r̄ to 0 forces q = 0; the inputs are active-low because 0 is a NAND\'s controlling value.<br>s̄ = r̄ = 0 drives both outputs to 1, breaking q̄ = ¬q, and releasing both together starts a race decided by mismatch and noise (metastability). The latches and flip-flops built on it exist to make that input combination impossible.',
    example: { title: 'Set, then hold', body: 'Start q = 0, q̄ = 1. s̄ ← 0: q = NAND(0, q̄) = 1 after 1 delay; q̄ = NAND(q, r̄) = NAND(1, 1) = 0 after 2.<br>s̄ ← 1: q = NAND(1, 0) = 1: the loop holds q = 1 by itself.<br>The set pulse must last 2 delays, until q̄ has fallen and holds q up.' },
    mistakes: [
      'Releasing s̄ and r̄ at the same instant: the outcome is unpredictable, and a real latch may hover between levels before it falls.',
      'Making the set pulse shorter than the loop delay: q rises, q̄ has not fallen yet, and q drops back.',
      'Reading the inputs as active-high: with NANDs, 1 on both inputs is hold.',
    ],
    lib: 'sr_latch',
    chapters: [{ chapter: 'latches', step: 0, label: 'Two NANDs holding hands' }, { chapter: 'latches', step: 1, label: 'The forbidden input, and races' }],
  },
  dlatch: {
    idea: 'A D latch derives the SR latch\'s set and reset from one data input so they can never be active together: s̄ = ¬(d·e), r̄ = ¬(¬d·e). While the enable e = 1 the latch is transparent (q follows d a few delays later); when e falls it keeps the last value. The cheapest form reuses s̄: while e = 1, s̄ equals ¬d, so r̄ = ¬(s̄·e) needs no inverter, 4 NANDs. The library draws the version with the inverter, 5.<br>Transparency is the problem in a loop: while e = 1 a value can pass through the latch, through logic and back, and change again in the same phase. Register-to-register logic therefore uses two latches in opposite phases (the flip-flop).',
    example: { title: 'The 4-NAND version', body: 'e = 1, d = 1: s̄ = ¬(1·1) = 0, r̄ = ¬(0·1) = 1: set, q = 1.<br>e = 1, d = 0: s̄ = 1, r̄ = ¬(1·1) = 0: reset, q = 0.<br>e = 0: s̄ = 1, r̄ = ¬(1·0) = 1: hold.' },
    mistakes: [
      'Using a latch where a flip-flop is needed: in a counter, q + 1 races around the loop while the latch is open.',
      'Changing d as e falls: the latch may capture either value or go metastable, like a flip-flop whose setup time is violated.',
      'Spending a NOT on ¬d: r̄ = ¬(s̄·e) is the same function with one NAND less.',
    ],
    lib: 'd_latch',
    chapters: [{ chapter: 'latches', step: 2, label: 'The D latch: store what you are told' }],
  },
  dff: {
    idea: 'A master–slave D flip-flop is two D latches enabled on opposite clock phases. While clk = 0 the master follows d and the slave holds; when clk rises the master closes on the value d has at that instant and the slave opens to pass it on. The two are never open together, so d cannot race through to q: the output changes once per cycle, just after the rising edge.<br>Cost: 9 NANDs with the 4-NAND latch (two latches and a clock inverter), 11 in the library\'s drawing. Timing here: clk-to-q 3 NAND delays, setup 3 (d must cross the master before it closes). Every register-to-register path then needs a period of at least 3 + logic + 3.',
    example: { title: 'Two periods from clk-to-q + logic + setup', body: 'A 16-bit register whose d passes through its load-enable mux: 3 + 2 (mux data path) + 3 = <b>8</b> delays, the campaign\'s par for the 16-bit register.<br>The RV16 PC, which loads every cycle and needs no enable mux: 3 + 31 (incrementer) + 2 + 2 (load and reset muxes) + 3 = <b>41</b>.' },
    mistakes: [
      'Clocking a flip-flop from logic (clk AND en): the clock arrives late and can glitch. Use an enable mux on d.',
      'Fixing a hold violation by slowing the clock: hold depends on the shortest path and on clock skew; the period does not enter it.',
      'Expecting q to follow d: it changes only after the rising edge; between edges d may do anything as long as it is stable around the edge.',
    ],
    lib: 'dff', anatomy: ['pc', 'rf', 'p1', 'p2', 'p3', 'p4'],
    chapters: [{ chapter: 'latches', step: 3, label: 'The flip-flop: act only on the edge' }],
  },
  register: {
    idea: 'A register is n flip-flops on one clock, one per bit of a word. It must also be able to keep its value, so each flip-flop gets a 2:1 mux in front that feeds q back when en = 0 and takes d when en = 1: the flip-flop is clocked every cycle and reloads its own value when it should not change. With the 9-NAND flip-flop that is 13 NANDs per bit, 52 for 4 bits; the library\'s is 15 per bit.<br>Registers hold a CPU\'s state: the PC, the register file (seven real registers in RV16, x0 is wired to 0), the pipeline registers, the CSRs. A pipeline register also needs a clear to inject a bubble: a second mux that forces 0.',
    example: { title: 'Where RV16\'s storage goes', body: 'Register file: 7 × 16 bits × 13 NANDs = 1 456 of its 2 193 NANDs; the two 8:1 read muxes are 686 more.<br>A 16-bit pipeline register with enable and clear: 260 NANDs.<br>13 NANDs is 52 transistors per bit, against 6 for an SRAM cell: why real register files and caches are SRAM.' },
    mistakes: [
      'Gating the clock to hold a value: clk ∧ en glitches and skews the clock. The feedback mux is the safe enable.',
      'Leaving out the enable: the register then loads on every edge and cannot hold a value across cycles.',
      'Giving a pipeline register a clear but no enable, or the reverse: a stall needs hold, a flush needs clear, and both occur.',
    ],
    lib: 'reg4', anatomy: ['pc', 'rf', 'p1', 'p2', 'p3', 'p4', 'csr'],
    chapters: [{ chapter: 'latches', step: 4, label: 'Load enable' }, { chapter: 'registers', step: 0, label: 'A register is a row of flip-flops' }],
  },
  counter: {
    idea: 'A counter is a register fed by an incrementer of its own output: q ← q + 1 at every rising edge while enabled. The loop register → logic → register is the shape of every synchronous circuit, and the counter is its simplest case. The 4-bit counter is 80 NANDs: a 60-NAND register and a 20-NAND incrementer. Its period is clk-to-q + the incrementer\'s carry chain + setup, so it slows as it widens unless the incrementer looks ahead.<br>Counters count cycles (RISC-V\'s mcycle, a timer compared with mtimecmp), steps of a multicycle unit (a divider\'s iterations, a cache refill\'s wait) and, with a load input, addresses: the PC is a counter that can jump.',
    example: { title: 'Ripple against synchronous', body: 'A ripple counter clocks each flip-flop from the previous bit: no incrementer, but bit k settles k flip-flop delays after the edge, so 0111 → 1000 passes through 0110, 0100 and 0000.<br>The synchronous counter changes every bit on the same edge, clk-to-q later: readers see 0111, then 1000.' },
    mistakes: [
      'Building a counter from latches: while they are open, q + 1 feeds back and counts as fast as the logic allows.',
      'Decoding a ripple counter\'s bits: they settle at different times and decode to false values in between.',
      'Leaving out the reset: at power-on the counter starts wherever its flip-flops did.',
    ],
    lib: 'counter4', anatomy: ['pc', 'csr'],
    chapters: [{ chapter: 'registers', step: 2, label: 'A counter' }, { chapter: 'registers', step: 3, label: 'Asynchronous reset' }],
  },
  pc: {
    idea: 'The program counter is the register holding the address of the instruction being fetched: the CPU\'s position in the program. Each cycle it loads one of 0 on reset, pc + 1 for the next word, or a target from the next-PC logic (taken branch or jal: pc + imm; jalr: rs1 + imm; a trap: mtvec; mret: mepc). In RV16 it is sixteen flip-flops (it loads every cycle, so it needs no enable), an incrementer and two bus muxes (load, reset): 318 NANDs, period 41. In the complete core the next-PC logic already computes pc + 1, and the PC takes it from there instead of keeping an incrementer of its own.<br>RV16 is word-addressed, so sequential execution adds 1; RV32 addresses bytes and adds 4. In a pipeline the PC is the F stage\'s register: a stall holds it, a taken or mispredicted branch reloads it, and each instruction carries its own PC down the pipe for jal\'s link value and for mepc.',
    example: { title: 'A taken beq', body: 'pc = 0x0010: <code>beq a0, a1, -4</code> with a0 = a1.<br>pc + 1 = 0x0011 (not taken).<br>target = pc + imm = 0x0010 + 0xFFFC = 0x000C (16-bit wrap).<br>take = 1, so ld = 1 and the PC loads 0x000C at the next edge.' },
    mistakes: [
      'Adding 4 in a word-addressed machine: the PC skips three instructions.',
      'Linking the wrong value in jal / jalr: rd gets pc + 1, the return address, not the target.',
      'Getting the priority of next-PC sources wrong: reset wins over everything, a trap over a branch.',
    ],
    lib: 'rv16_pc', anatomy: ['pc', 'npc', 'plus1'],
    chapters: [{ chapter: 'registers', step: 2, label: 'A counter' }, { chapter: 'cpu', step: 3, label: 'Branches and jumps' }],
  },
  ram: {
    idea: 'A RAM is an array of words with an address: a write stores a word at the addressed location, a read returns the addressed word. From registers: a decoder on the address, ANDed with we, gives each word its load enable (one word written per clock edge), and a mux tree on the address picks the word read, combinationally, so the read follows the address within the cycle. The 4 × 4 RAM is 306 NANDs: 240 of registers, 48 of read mux, 18 of write select.<br>That is 15 NANDs (60 transistors) per bit, which is why real memories use 6-transistor SRAM cells (caches, register files) or one transistor and a capacitor (DRAM, main memory), read through sense amplifiers. The organization stays: row decoder, cell array, column select.',
    example: { title: 'Write, then read', body: 'addr = 10, din = 0110, we = 1: decoder output y2 ∧ we enables word 2. At the rising edge word 2 = 0110; words 0, 1 and 3 reload themselves.<br>we = 0, addr = 10: the 4:1 mux selects word 2: dout = 0110 without waiting for a clock.' },
    mistakes: [
      'Expecting a write to show in the same cycle: the word changes at the edge, so a read of that address before it returns the old value.',
      'Driving we from logic that can glitch into an asynchronous memory: a glitching decoder output writes a wrong word. A clocked enable only matters at the edge.',
      'Assuming the decoder is the expensive part: storage and the read mux dominate.',
    ],
    lib: 'ram4x4', anatomy: ['dmem'],
    chapters: [{ chapter: 'memory', step: 0, label: 'Four words, one address' }, { chapter: 'memory', step: 1, label: 'Writing' }, { chapter: 'memory', step: 2, label: 'Reading' }],
  },
  regfile: {
    idea: 'The register file is a small RAM with more ports: an R-type instruction reads two registers and writes one in the same cycle, so it has two read ports (two independent mux trees over all the registers, combinational) and one write port (decoder ∧ we → one register\'s load enable, at the clock edge). RV16 has eight 16-bit registers and x0 has no storage: its slot in the muxes is the constant 0 and writes to it go nowhere, which makes mv, li, nop, j and beqz pseudo-instructions over real ones.<br>The 8 × 16 file is 2 193 NANDs: 1 456 of registers, 686 for the two 8:1 read muxes, 51 for the write decoder. Every extra read port is another mux tree, which is why wide-issue CPUs spend so much area here.',
    example: { title: 'add t0, t0, t0 in one cycle', body: 't0 = x6 = 5. Both read ports select x6: rd1 = rd2 = 5. The ALU makes 10, and at the rising edge the write port loads x6 = 10.<br>Reads are combinational and the write happens at the edge, so the instruction reads the old 5 and the next instruction sees 10.' },
    mistakes: [
      'Giving x0 a register and trusting software never to write it: writes to x0 must be discarded by the hardware.',
      'Expecting a write to be visible to a read in the same cycle: here it is not; a pipeline forwards the value or writes in the first half of the cycle.',
      'Sharing one mux tree between the two read ports: two operands need two selections at once.',
    ],
    lib: 'regfile4x4', anatomy: ['rf'],
    chapters: [{ chapter: 'regfile', step: 0, label: 'A memory with two read ports' }, { chapter: 'regfile', step: 1, label: 'The real thing: 32 × 32' }],
  },
  rom: {
    idea: 'A ROM is a fixed function from address to word. Built from gates it is a decoder giving one wire per address and an OR plane: output bit j is the OR of the address wires whose word has a 1 in bit j. It is the instruction memory of a Harvard CPU: the program does not change while it runs, and fetch reads one word per cycle at the PC.<br>A ROM decodes every address even when the function needs few of them. A PLA keeps the two planes but builds only the product terms the outputs need, minimized: the 7-segment font is 313 NANDs as a ROM and 164 as a PLA. Real ROMs are transistor arrays (a transistor or none at each crossing), far denser than either.',
    example: { title: 'Digit 1 in the font ROM', body: 'Address 0001: the decoder raises wire 1. The word is 000 0110: segments b and c (bits 1 and 2), so wire 1 feeds only those two OR gates.<br>Address 1011 of the squares ROM holds 121 = 0111 1001: its wire feeds the OR gates of bits 6, 5, 4, 3 and 0.' },
    mistakes: [
      'Storing a sparse function as a full ROM: every address costs a word whether it is used or not.',
      'Storing into the instruction ROM: in a Harvard machine data goes to the RAM, and the program memory is read-only.',
      'Leaving the ROM out of timing: every instruction\'s path starts with fetch through the decoder and the OR plane.',
    ],
    lib: 'rom_seg7', compare: ['pla_seg7'], anatomy: ['imem'],
    chapters: [{ chapter: 'memory', step: 4, label: 'Read-only memory' }, { chapter: 'memory', step: 5, label: 'The PLA' }],
  },

  // ---- the CPU
  control: {
    idea: 'The control unit turns the opcode (and f3 where it matters) into the signals that steer the datapath: write a register (rwe), take the ALU\'s second operand from the immediate (bimm), which immediate format (isel), the ALU operation, write memory (mwe), what goes back to rd (wb: ALU, load, pc + 1 or the lui immediate), and whether this is a branch, jal or jalr. In a single-cycle CPU it is combinational: a truth table from instruction bits to signals.<br>Most of the table is don\'t-cares: a store writes no register, so its wb is irrelevant; a branch compares rs1 with rs2 directly, so its bimm and ALU operation are free. The library\'s RV16 control takes the direct route, a 4→16 decoder on the opcode and an OR per signal: 200 NANDs, 13 delays. Fixed field positions help everywhere else: rs1, rs2 and rd never move, so the register file reads before decoding finishes, and the ALU operation is the instruction\'s own bits.',
    example: { title: 'Four rows of the table', body: '<pre>       op    rwe bimm isel mwe wb   br\nadd   0001    1   0    x    0  ALU  0\nlw    0110    1   1    I    0  mem  0\nsw    1110    0   1    S    1  x    0\nbeq   1000    0   x    B    0  x    1</pre>x: don\'t care, free to be whatever makes each signal\'s logic smallest.' },
    mistakes: [
      'Leaving a don\'t-care unspecified in the hardware: it is free during design, but the built circuit gives it some value, and that value must be harmless.',
      'Treating write enables as don\'t-cares: rwe and mwe must be 0 for every instruction that does not write.',
      'Decoding fields that never move: rs1, rs2 and rd go straight from the instruction to the register file.',
    ],
    lib: 'rv16_ctl', anatomy: ['ctl'],
    chapters: [{ chapter: 'cpu', step: 0, label: 'The datapath' }, { chapter: 'multicycle', step: 2, label: 'Hardwired control' }],
  },
  csr: {
    idea: 'Control and status registers are a second register space, separate from x0–x7, holding the machine\'s configuration and trap state. RV16 names seven: mstatus (MIE: interrupts enabled; MPIE: MIE before the trap), mie and mip (interrupts enabled and pending), mtvec (the handler\'s address), mepc (the PC to return to), mcause (why: 2 illegal instruction, 3 ebreak, 11 ecall, 0x800B external) and mscratch (a spare register for the handler); number 7 has no register and reads 0. csrrw swaps a CSR with a register, csrrs sets the bits given, csrrc clears them, each in one instruction.<br>Hardware writes some of them too: a trap loads mepc and mcause and moves MIE into MPIE on the same edge that sends the PC to mtvec; mret moves MPIE back. The campaign\'s CSR file is 1 765 NANDs, mostly its five 16-bit registers with enable (1 040), mstatus as 16 flip-flops that load their next value every cycle (144) and the 8:1 read mux (343).',
    example: { title: 'A trap and its return', body: 'An ecall at pc = 0x0040 with MIE = 1, mtvec = 0x0100:<br>edge: mepc ← 0x0040, mcause ← 11, MPIE ← 1, MIE ← 0, pc ← 0x0100.<br>The handler adds 1 to mepc (to skip the ecall) and executes mret: pc ← 0x0041, MIE ← MPIE = 1.' },
    mistakes: [
      'Returning to mepc after an ecall without adding 1: the handler runs the ecall again forever.',
      'Leaving interrupts enabled on trap entry: a second interrupt overwrites mepc before the handler has saved it. Hardware clears MIE for that reason.',
      'Implementing csrrs / csrrc with rs1 = x0 as writes: they only read, which matters for registers with side effects.',
    ],
    lib: 'rv16_csr', anatomy: ['csr'],
    chapters: [{ chapter: 'traps', step: 0, label: 'Control and status registers' }, { chapter: 'traps', step: 5, label: 'Inside the trap unit' }],
  },
  cpi: {
    idea: 'Execution time = instruction count × CPI × clock period. The factors belong to different people: the instruction count to the ISA and the compiler, CPI (average cycles per instruction) to the microarchitecture, the period to the critical path and the process. A design change usually moves two of them in opposite directions, and only the product counts. Single-cycle: CPI = 1, period set by the slowest instruction. Multicycle: shorter period, CPI 3–5. Pipelined: the short period with CPI back near 1, plus stalls and flushes. A hardware multiplier cuts the instruction count of a multiply loop and may lengthen the period of everything else.<br>On this site the period is measured in NAND delays by static timing and CPI by counting cycles on real programs, so the law is checked, not quoted.',
    example: { title: 'Two measured trade-offs', body: 'RV16, ripple → Kogge–Stone adders, same tests: 1 236 cycles both, period 98 → 76: 121 128 → 93 936 delays, 22 % less time for 218 more NANDs (4 741 → 4 959: only the ALU, the adder on the critical path).<br>RV32 single-cycle → multicycle (chapter 22): period 103 → 85, CPI 1 → about 3.8: about 323 delays per instruction instead of 103, 3× slower.' },
    mistakes: [
      'Comparing clock rates across designs: a faster clock with a higher CPI can lose.',
      'Measuring CPI on programs that skip the slow cases: load-use pairs, taken branches, divides.',
      'Speeding up one instruction class without weighing its share: a 10× faster divide does nothing for a program that never divides.',
    ],
    chapters: [{ chapter: 'multicycle', step: 5, label: 'Was it worth it?' }, { chapter: 'pipeline', step: 5, label: 'Does it pay? Measured' }, { chapter: 'fastadd', step: 9, label: 'Swap in fast adders' }],
  },

  // ---- side quests
  arraymul: {
    idea: 'An array multiplier is long multiplication done all at once. Partial product row i is a ANDed with bit i of b, shifted left i places: n² AND gates. Rows of adders sum them, each row adding the next partial product to the running sum. An n × n unsigned array has n(n − 1) adders and produces all 2n product bits in one combinational pass: 16 × 16 is 2 672 NANDs and 150 delays, more than twice the area of the 16-bit ALU and longer than the whole RV16 single-cycle path.<br>A Wallace tree sums the same partial products with layers of 3:2 compressors (full adders whose carries go to the next layer, not along the row), so depth grows with log n instead of n, and one fast adder resolves the last two rows. It buys speed with area: at 8 bits the tree is 911 NANDs and 40 delays against the array\'s 632 and 70.',
    example: { title: '1011 × 1101 (11 × 13)', body: '<pre>       1011   b0 = 1\n      0000    b1 = 0\n     1011     b2 = 1\n    1011      b3 = 1\n   --------\n   10001111   = 143</pre>Four rows of 4 ANDs, summed by three rows of adders.' },
    mistakes: [
      'Dropping a combinational array into a single-cycle core without checking the period: in RV16 it moves the clock from 98 to 191 NAND delays for every instruction, multiply or not.',
      'Feeding signed operands to the unsigned array: the low half is right, the high half is wrong whenever an operand is negative.',
      'Expecting the Wallace tree to be smaller: it is faster, not cheaper.',
    ],
    lib: 'amul4', compare: ['wmul4'],
    chapters: [{ chapter: 'muldiv', step: 0, label: 'Long multiplication is AND and add' }, { chapter: 'muldiv', step: 2, label: 'The array is slow' }, { chapter: 'muldiv', step: 5, label: 'The Wallace tree' }],
  },
  sticky: {
    idea: 'Floating-point addition aligns the smaller operand by shifting its significand right by the exponent difference. The bits shifted out cannot simply be dropped: round to nearest must know whether the discarded part was zero, under half, exactly half or over half. The guard bit (the first one dropped) is kept in the word; everything below it collapses into one sticky bit, the OR of all of them, and that is all any rounding mode needs.<br>The sticky shifter is a barrel shifter whose level k, when it shifts by 2ᵏ, also ORs the 2ᵏ bits it pushes out; sticky is the OR of the levels\' flags. The campaign\'s 13-bit, 4-level unit is 264 NANDs and 21 delays: 52 muxes (208) and 56 NANDs of OR logic.',
    example: { title: '1011 0110 shifted right by 3', body: 'Amount 3 = 011.<br>By 1: <code>0101 1011</code>, dropped 0 → flag 0.<br>By 2: <code>0001 0110</code>, dropped 11 → flag 1.<br>By 4: passes.<br>sticky = 0 + 1 = 1: the three bits that fell off (110) were not all zero.' },
    mistakes: [
      'ORing the dropped bits with a separate mask from the shift amount: correct, but a second wide OR tree and a decoder, where the per-level flags come almost free.',
      'Rounding on the guard bit alone: an exact half (G = 1, the rest 0) then looks like more than half, and ties to even breaks.',
      'Letting a shift past the width wrap or saturate early: an amount larger than the significand must push every bit into sticky.',
    ],
    lib: 'shrs8_3',
    chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }],
  },
  lzc: {
    idea: 'A leading-zero counter reports how many zeros sit above the first 1 of a word (c) and whether there is a 1 at all (v). A floating-point unit needs it after subtracting close numbers: the result has leading zeros that normalization must shift out, and c is the shift amount. It splits recursively. For 2 bits, c = ¬a1 and v = a1 + a0. For a word split in halves: if the high half has a 1 (v<sub>hi</sub>), the count is the high half\'s with a 0 in front; otherwise the high half is n/2 zeros, and the count is the low half\'s with a 1 in front. v = v<sub>hi</sub> + v<sub>lo</sub>.<br>Each level adds a row of muxes and an OR, so delay grows with log n: 4 NANDs and 2 delays at 2 bits, 44 and 7 at 8, 104 and 9 at 16.',
    example: { title: '0000 0101', body: 'High nibble 0000: v<sub>hi</sub> = 0, so c = 1 followed by the low nibble\'s count.<br>Low nibble 0101: its high pair 01 has a 1, so 0 followed by the pair\'s count, ¬a1 = 1.<br>c = 101 = 5 zeros, v = 1. Shifted left by 5 the leading 1 reaches the top: 1010 0000.' },
    mistakes: [
      'Ignoring v: an all-zero word has no leading 1, its count is meaningless, and the result is a true zero rather than something to normalize.',
      'Counting trailing zeros: normalization needs the zeros above the first 1.',
      'Building it as a priority encoder plus a subtraction: correct, but deeper than the recursive form.',
    ],
    lib: 'lzc8',
    chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }],
  },
  normalize: {
    idea: 'Every floating-point operation computes an exact result as a sign, an exponent and a wide significand, then rounds it once to the format. That back end is shared: the adder, the multiplier and int → float all end in normalize & round. Normalize moves the leading 1 to the hidden-bit position: count leading zeros and shift left by min(lz, exp − 1), so the exponent never drops below the minimum; if the exponent is already below 1, shift right instead, with sticky, to make a subnormal. Then round on guard and sticky in mode rm. A rounding carry can turn 1.11…1 into 10.00…0 and bump the exponent; an exponent past the maximum becomes ∞ or the largest finite number, depending on the mode. Flags come out alongside: NX, OF, UF.<br>For binary16 with a 15-bit significand it is 2 058 NANDs and 86 delays: leading-zero counter, left shifter, sticky right shifter, rounding incrementer and exponent arithmetic, in series.',
    example: { title: '1.5 − 1.25 in binary16', body: '1.5 = 1.1000000000 × 2⁰, 1.25 = 1.0100000000 × 2⁰. Same exponent, subtract significands: 0.0100000000.<br>Leading zeros: 2. Shift left by 2: 1.0000000000, exponent 0 − 2 = −2.<br>1.0 × 2⁻² = 0.25, exact: G = S = 0, no rounding, NX = 0. Exponent field −2 + 15 = 13: 0x3400.' },
    mistakes: [
      'Shifting left by the whole leading-zero count when that takes the exponent below the minimum: the result must stop in the subnormal range (shift by exp − 1 at most).',
      'Rounding before normalizing: the guard bit is then taken from the wrong position.',
      'Forgetting that rounding can carry out of the significand: the exponent goes up, and may overflow to ∞.',
    ],
    lib: 'fpnr5_10_15',
    chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }, { chapter: 'float', step: 4, label: 'Round to nearest, ties to even' }, { chapter: 'float', step: 6, label: 'Exception flags' }],
  },
  cache: {
    idea: 'A cache keeps copies of recently used memory words in a small fast array, betting on locality: a word used now will likely be used again soon (temporal), and so will its neighbours (spatial). The address splits into an index that picks a line and a tag, stored with the line, that says which address the line holds; a valid bit says it holds anything. Hit = valid ∧ (stored tag = address tag): one equality comparator. On a miss the line comes from the next level and the CPU waits.<br>The campaign\'s cache is direct-mapped, eight one-word lines over an 8-bit address: index = addr[2:0], tag = addr[7:3], 8 × (16 + 5 + 1) bits of storage, write-through (every store also goes to memory), a write filling its line. It is 3 497 NANDs, 3 358 of them the two small RAMs for data and tags. Set-associative caches compare several tags at once to avoid conflict misses; write-back caches keep dirty lines and write them out only on eviction.',
    example: { title: 'Two addresses, one line', body: '0x2B = 00101 011: index 3, tag 00101.<br>0x4B = 01001 011: index 3, tag 01001.<br>Alternating loads of the two both map to line 3 and evict each other: every access misses (conflict misses) while seven lines sit idle. A 2-way set-associative cache holds both.' },
    mistakes: [
      'Leaving out the valid bit: after reset the tag array holds zeros, and address 0 hits on lines never filled.',
      'Taking the index from the top address bits: consecutive addresses then share a line and spatial locality turns into conflicts.',
      'Assuming write-through is free: every store goes to memory, so a store-heavy loop runs at memory speed unless a write buffer absorbs it.',
    ],
    lib: 'rv16_cache', anatomy: ['dmem'],
    chapters: [{ chapter: 'cache', step: 6, label: 'A direct-mapped cache' }, { chapter: 'cache', step: 8, label: 'The three Cs and associativity' }, { chapter: 'cache', step: 10, label: 'Write-back: dirty lines' }],
  },

  // ---- tools
  sop: {
    idea: 'Any Boolean function is the OR of its minterms: one AND term per 1 row of the truth table, each term containing every input, true or complemented. That canonical sum of products is correct and large (up to 2ⁿ terms of n literals). Minimizing merges terms that differ in one variable (a·b·c + a·b·¬c = a·b) until nothing merges, then picks the fewest terms that cover every 1: by K-map up to 4–5 variables, Quine–McCluskey beyond. The result is two-level logic, ANDs then one OR, built as NAND–NAND with inverters only on complemented inputs. Depth is fixed (input inverters plus two levels, more once wide gates become trees); area follows the number of literals.<br>The product of sums is the dual, read off the 0 rows. A PLA is a sum of products in hardware: an AND plane makes the terms, an OR plane sums them, and outputs share terms.',
    example: { title: 'The mux from its truth table', body: 'y = 1 on rows (s, b, a) = 001, 011, 110, 111:<br><code>y = ¬s·¬b·a + ¬s·b·a + s·b·¬a + s·b·a</code><br>Merge 001 and 011 (b changes): ¬s·a. Merge 110 and 111 (a changes): s·b.<br><code>y = ¬s·a + s·b</code> = NAND(NAND(¬s, a), NAND(s, b)) with one NOT: 4 NANDs, depth 3.' },
    mistakes: [
      'Stopping at the canonical form: every term has every variable, and the circuit is several times larger than needed.',
      'Minimizing each output alone when outputs can share product terms (the point of a PLA).',
      'Assuming two levels is always best: wide ORs become trees of 2-input gates, and a factored form can be smaller at the same depth.',
    ],
    lib: 'pla_fa', anatomy: ['ctl'],
    chapters: [{ chapter: 'memory', step: 5, label: 'The PLA' }],
  },
  kmap: {
    idea: 'A Karnaugh map is the truth table drawn so that algebra becomes geometry. Rows and columns are labelled in Gray code (00, 01, 11, 10), so touching cells, including across the edges, differ in exactly one variable. A rectangle of 2ᵏ cells that are all 1 is one product term with k variables gone: the ones that change inside it. Minimize by covering every 1 with the largest rectangles, as few as possible; a 1 that only one rectangle can cover makes that rectangle essential. Don\'t-cares join a rectangle when they make it larger and are left out otherwise.<br>It is exact and quick by eye up to 4 variables, workable at 5–6 with paired maps, and useless beyond, where Quine–McCluskey takes over. It also shows hazards: two adjacent rectangles with no third bridging them mark a possible glitch, which a consensus rectangle removes.',
    example: { title: 'The 4-bit prime detector', body: '<pre>          x1x0\nx3x2   00 01 11 10\n 00     0  0  1  1\n 01     0  1  1  0\n 11     0  1  0  0\n 10     0  0  1  0</pre>Primes 2, 3, 5, 7, 11, 13. Essential: ¬x3·¬x2·x1 (2, 3), ¬x2·x1·x0 (3, 11), x2·¬x1·x0 (5, 13). Cell 7 needs one more: ¬x3·x2·x0 (5, 7).<br>3 NOTs, four 3-input NANDs (3 each), one 4-input NAND (5): 20 NANDs, depth 7, the level\'s par.' },
    mistakes: [
      'Labelling the axes 00, 01, 10, 11: neighbouring cells then differ in two variables and the rectangles lie.',
      'Missing the wrap-around: the left and right columns, and the top and bottom rows, are neighbours.',
      'Circling groups of 3 or 6 cells: only rectangles of 1, 2, 4, 8… cells are product terms.',
    ],
    lib: 'rv16_prime4',
  },
  qm: {
    idea: 'Quine–McCluskey is the K-map as an algorithm, so it works for any number of variables and a program can run it. Write the minterms (and don\'t-cares) in binary, grouped by their number of 1s. Merge every pair from neighbouring groups that differs in one bit, writing a dash there; repeat on the merged terms until nothing merges. Terms never merged are the prime implicants. Then choose a minimum set of primes covering every minterm (don\'t-cares need no cover): the essential primes first, then the rest, a set-cover problem that is exponential in the worst case (Petrick\'s method, or a heuristic).<br>The site\'s PLA generator runs it on every output when the page loads: the 7-segment decoder comes out as 28 terms, 164 NANDs, against 313 for the same function as a ROM.',
    example: { title: 'The full adder\'s carry', body: 'Minterms of cout (a b cin): 3 = 011, 5 = 101, 6 = 110, 7 = 111.<br>Groups: {3, 5, 6} (two 1s), {7} (three).<br>Merges: 3·7 → -11, 5·7 → 1-1, 6·7 → 11-. Nothing merges further.<br>Primes b·cin, a·cin, a·b, each the only cover of 3, 5 and 6: all essential.<br><code>cout = a·b + a·cin + b·cin</code>, the majority function.' },
    mistakes: [
      'Merging terms whose dashes sit in different positions: 1-1 and -11 differ in two places.',
      'Stopping at the prime implicants: there are usually more than a minimum cover needs; the covering step is the minimization.',
      'Requiring don\'t-cares to be covered: they help merges but need no prime of their own.',
    ],
    lib: 'pla_seg7', compare: ['rom_seg7'],
    chapters: [{ chapter: 'memory', step: 5, label: 'The PLA' }],
  },
  cla: {
    idea: 'Carry lookahead removes the chain by computing every carry from the inputs directly. Per bit: generate g<sub>i</sub> = a<sub>i</sub>·b<sub>i</sub> (this bit makes a carry whatever arrives) and propagate p<sub>i</sub> = a<sub>i</sub> ⊕ b<sub>i</sub> (it passes an incoming carry on). Then c<sub>i+1</sub> = g<sub>i</sub> + p<sub>i</sub>·c<sub>i</sub>, and unrolling gives each carry as a two-level sum of products: c<sub>4</sub> = g<sub>3</sub> + p<sub>3</sub>g<sub>2</sub> + p<sub>3</sub>p<sub>2</sub>g<sub>1</sub> + p<sub>3</sub>p<sub>2</sub>p<sub>1</sub>g<sub>0</sub> + p<sub>3</sub>p<sub>2</sub>p<sub>1</sub>p<sub>0</sub>c<sub>0</sub>. The terms grow with the bit position, so lookahead is done in 4-bit groups, each producing a group G and P, with a second level of lookahead over the groups.<br>Two levels assume wide gates. From 2-input NANDs every wide AND and OR becomes a tree, and the flat 4-bit CLA here is 106 NANDs and 15 delays against ripple\'s 36 and 12. Lookahead pays once the expansion is organized as a tree: the prefix adders.',
    example: { title: '0110 + 0011', body: 'g = a·b = 0010, p = a ⊕ b = 0101, c<sub>0</sub> = 0.<br><code>c1 = g0 = 0</code><br><code>c2 = g1 + p1·g0 = 1</code><br><code>c3 = g2 + p2·g1 + p2·p1·g0 = 0 + 1 + 0 = 1</code><br><code>c4 = g3 + p3·g2 + … = 0</code><br>Carries into bits 3…0: 1100. Sum = p ⊕ c = 0101 ⊕ 1100 = 1001 (6 + 3 = 9).' },
    mistakes: [
      'Using p = a + b in the sum: OR is enough for the carry recurrence, but the sum needs p = a ⊕ b.',
      'Expanding lookahead flat across 16 bits: the top carry needs 17-input gates. Group in 4s, or use a prefix tree.',
      'Expecting lookahead to pay at 4 bits with 2-input gates: here it costs three times the NANDs and three more delays than ripple.',
    ],
    lib: 'cla4', compare: ['rca4'], anatomy: ['alu'],
    chapters: [{ chapter: 'fastadd', step: 1, label: 'Generate, propagate, look ahead' }],
  },
  prefix: {
    idea: 'A prefix adder computes every carry with a tree. Treat each bit\'s (g, p) as a span and combine adjacent spans with (g<sub>hi</sub>, p<sub>hi</sub>) ∘ (g<sub>lo</sub>, p<sub>lo</sub>) = (g<sub>hi</sub> + p<sub>hi</sub>·g<sub>lo</sub>, p<sub>hi</sub>·p<sub>lo</sub>): the combined span generates if its upper part generates or passes on what the lower part generates, and propagates if both parts do. The operator is associative, so the group generate G[i:0], which is c<sub>i+1</sub>, can be computed for every i by a parallel-prefix network in log2 n levels; then s<sub>i</sub> = p<sub>i</sub> ⊕ c<sub>i</sub>.<br>Kogge–Stone combines every bit with the one 2ʲ below it at level j: minimum depth, fan-out 2, about n·log2 n cells and long wires. Brent–Kung uses about 2n cells and twice the levels; Sklansky has log2 n levels with high fan-out. The 16-bit Kogge–Stone here is 366 NANDs and 16 delays against ripple\'s 144 and 36; at 32 bits, 878 and 18 against 288 and 68.',
    example: { title: '0111 + 0001 in two levels', body: 'g = 0001, p = 0110.<br>Level 1 (distance 1): G[1:0] = g1 + p1·g0 = 1; G[2:1] = g2 + p2·g1 = 0, P[2:1] = 1; G[3:2] = 0, P[3:2] = 0.<br>Level 2 (distance 2): G[2:0] = G[2:1] + P[2:1]·G[0:0] = 1; G[3:0] = G[3:2] + P[3:2]·G[1:0] = 0.<br>Carries into bits 3…0: 1110. Sum = 0110 ⊕ 1110 = 1000 (7 + 1 = 8).' },
    mistakes: [
      'Computing P for spans that already reach bit 0: only G is needed there (a gray cell, 3 NANDs, instead of a black cell, 5).',
      'Forgetting the carry-in: fold it into bit 0 (g0 = a0·b0 + p0·cin) before the tree.',
      'Counting only depth: the Kogge–Stone\'s cells and wires cost area and power, and at 8 bits a carry-select adder matches its depth with fewer NANDs.',
    ],
    lib: 'ks8', compare: ['rca8'], anatomy: ['alu', 'npc'],
    chapters: [{ chapter: 'fastadd', step: 2, label: 'Parallel prefix: Kogge–Stone' }, { chapter: 'fastadd', step: 5, label: 'Measured, not quoted' }],
  },
  fsm: {
    idea: 'A finite-state machine is a state register plus combinational logic: next state = f(state, inputs), outputs = g(state) (Moore) or g(state, inputs) (Mealy). It is how hardware runs a sequence: a divider\'s iterations, a cache refill, a multicycle CPU\'s steps, a bus protocol. The design is mechanical: list states and transitions, choose an encoding, write the next-state and output tables, minimize each bit, add a reset to a defined start state.<br>Encoding is a trade. Binary uses ⌈log2 S⌉ flip-flops and denser logic; one-hot uses S flip-flops and makes each next-state bit a small OR of transition terms, usually faster and easier to change. Mealy outputs react within the cycle, with fewer states, but follow input glitches; Moore outputs depend only on the registered state, one cycle later.',
    example: { title: 'Detect 1-0-1, overlapping', body: 'States S0 (nothing), S1 (saw 1), S2 (saw 10), encoded s1 s0 = 00, 01, 10.<br>Any x = 1 → S1; S1 with x = 0 → S2; otherwise S0.<br><code>n0 = x</code>, <code>n1 = ¬x·s0</code>, Mealy output <code>y = x·s1</code>, with ¬rst ANDed into both next bits as a synchronous reset.<br>Two flip-flops (22 NANDs) and 10 NANDs of logic: 32.' },
    mistakes: [
      'Leaving out the reset: the state register powers up anywhere, possibly in an unused code with no way out.',
      'Feeding a Mealy output into logic that needs it stable for the whole cycle: it changes, and can glitch, with the input.',
      'Choosing the encoding before writing the transitions: one-hot, or adjacent codes for frequent transitions, falls out of the table.',
    ],
    lib: 'rv16_det101',
    chapters: [{ chapter: 'registers', step: 10, label: 'State machines' }, { chapter: 'multicycle', step: 1, label: 'The state table' }, { chapter: 'multicycle', step: 2, label: 'Hardwired control' }],
  },
  assembly: {
    idea: 'Assembly is machine code with names: one line per instruction, mnemonics for opcodes, ABI names for registers (a0, sp, ra), labels for addresses, and pseudo-instructions that expand to real ones (li, mv, j, call, ret, beqz). The assembler needs two passes because a branch may name a label further down. Pass 1 walks the source counting words to give every label an address, so each pseudo-instruction\'s size must be decided before its operands are known: li is one word when the value fits a 6-bit immediate or has its low 6 bits zero, else two. Pass 2 encodes each instruction, computing branch and jump offsets as target − pc and checking that they fit.<br>RV16 branch offsets are 6 bits (−32…31 words) and jal\'s 9 bits (−256…255): a loop longer than that closes with an inverted branch around a jump.',
    example: { title: 'Encode a loop', body: '<code>0: loop: addi a0, a0, -1</code>: op 4, rd 3, rs1 3, imm −1 = 111111 → <code>0xFDB4</code><br><code>1: bne a0, x0, loop</code>: offset 0 − 1 = −1, split as imm[5:3] at bits 15:13 and imm[2:0] at 6:4 → <code>0xE1F9</code><br><code>li a1, 1000</code>: 1000 = 1024 − 24 → <code>lui a1, 16</code> (16 × 64 = 1024, <code>0x0447</code>), <code>addi a1, a1, -24</code> (<code>0xA244</code>)' },
    mistakes: [
      'Computing a branch offset from the next instruction: RV16 offsets are relative to the branch itself (pc + imm).',
      'Assuming li is one instruction: a value outside −32…31 without zero low bits takes lui + addi, and every label after it moves.',
      'Splitting a constant as hi = v &gt;&gt; 6, lo = v &amp; 63: addi sign-extends, so when bit 5 of v is 1 the high part must be rounded up (1000 = 1024 − 24, not 960 + 40).',
    ],
    chapters: [{ chapter: 'isa', step: 1, label: 'The assembler' }],
  },
  shiftadd: {
    idea: 'Binary multiplication needs no table: for each 1 bit of the multiplier b, add the multiplicand a shifted left by that bit\'s position. In software it is a loop of n iterations: test the low bit of b, add if set, shift a left, shift b right. In hardware it is the sequential multiplier: one adder and a 2n-bit product register that starts as {0, b}. Each cycle, if the register\'s low bit is 1, a is added to the upper half; then the whole register shifts right one place, the adder\'s carry entering at the top. After n steps it holds a·b.<br>Against the array multiplier: the 16-bit sequential unit is 1 169 NANDs and 16 add-and-shift steps, the 16 × 16 array 2 672 NANDs and one long cycle. At 8 bits the two are the same size (633 and 632 NANDs), so the sequential form saves area only at larger widths.',
    example: { title: '6 × 5 in four steps', body: 'a = 0110; register {upper, lower} = 0000 0101.<br>1: low bit 1: upper = 0000 + 0110 = 0110; shift → 0011 0010<br>2: low bit 0: shift → 0001 1001<br>3: low bit 1: upper = 0001 + 0110 = 0111; shift → 0011 1100<br>4: low bit 0: shift → 0001 1110 = 30' },
    mistakes: [
      'Dropping the adder\'s carry: the upper half can overflow n bits before the shift, and that carry must enter at the top.',
      'Running the software loop for all 16 bits when b is small: stop as soon as b reaches 0.',
      'Using the unsigned loop on signed operands: the low half is right, the high half needs the sign corrections of mulh.',
    ],
    lib: 'smul8', compare: ['amul8'],
    chapters: [{ chapter: 'muldiv', step: 1, label: 'Or reuse one adder' }],
  },
  bpred: {
    idea: 'A pipeline fetches the next instruction before the current branch is decided, so it must guess the next PC. A wrong guess costs a flush: the campaign\'s RV16 pipeline resolves branches in E, two instructions behind fetch, so every redirect costs 2 cycles. Static prediction uses the instruction alone: predict not taken (free: keep fetching pc + 1), or backward taken, forward not taken (loops close with a backward branch). Dynamic prediction learns per branch: a table indexed by low PC bits holds a 2-bit saturating counter (00 and 01 predict not taken, 10 and 11 taken, each outcome moves it one step), so one surprise does not flip an established guess. A branch target buffer stores the target as well, so the redirect happens in F, before the instruction is decoded.<br>The price is a table read in F, which is on the critical path, and area: the 16-entry, 62-bit BTB of the RV32 pipeline is 22 849 NANDs.',
    example: { title: 'A 10-iteration loop, run repeatedly', body: 'The closing branch is taken 9 times, then falls through, every run.<br>Predict not taken: 9 mispredictions per run, 18 flushed cycles.<br>1-bit history: 2 per run (the exit, then the first iteration of the next run).<br>2-bit counter: 1 per run; the exit only moves it from strongly to weakly taken, so it still predicts taken on re-entry: 2 flushed cycles.' },
    mistakes: [
      'Updating the predictor with its own guess at fetch instead of the outcome at resolution: it then learns nothing.',
      'Indexing the table with high PC bits: nearby branches share an entry while most entries stay unused.',
      'Predicting taken without a target: without a BTB the target is known only after decode, and a correct taken guess still loses a cycle.',
    ],
    lib: 'satctr', anatomy: ['npc', 'p1'],
    chapters: [{ chapter: 'pipepay', step: 2, label: 'Predicting branches' }, { chapter: 'pipepay', step: 3, label: 'Two bits of history' }, { chapter: 'pipepay', step: 4, label: 'The price of prediction' }],
  },
  microcode: {
    idea: 'Microcode implements a control FSM as a stored table. A micro-PC addresses a ROM; each microword holds the control signals for one cycle and says how to pick the next micro-address: a field in the word, or a dispatch through a second ROM indexed by the opcode. Changing the machine\'s behaviour means changing ROM contents, not wiring, which is how IBM ran the System/360 instruction set on machines of very different cost, and why x86 processors still execute their rarest, most complex instructions from microcode and patch bugs with microcode updates.<br>The price is area and a ROM access in the control path. The multicycle RV32 controller of chapter 22 has 13 states: hardwired it is 412 NANDs; microcoded, with 20-bit microwords (14 control bits, a 4-bit next address, 2 sequencing bits), 6 124, because our ROMs are mux trees of constants. Microcode pays when the table is large and irregular, or must stay changeable.',
    example: { title: 'A load, word by word', body: 'Fetch, then Decode, whose sequencing field says dispatch: the opcode 0x03 (load) indexes the dispatch ROM and selects MemAdr.<br>MemAdr → MemRead → MemWB follow by their next-address fields, and MemWB returns to Fetch.<br>Five microwords, five cycles: the same sequence the hardwired FSM steps through.' },
    mistakes: [
      'Expecting microcode to be faster than hardwired control: it adds a ROM read to every cycle\'s control path.',
      'Forgetting the dispatch: the opcode decides only where Decode goes; after that the ROM holds the sequence.',
      'Estimating the controller from the state count alone: the ROM is states × microword width, and every bit costs.',
    ],
    lib: 'mc_micro', compare: ['mc_fsm'],
    chapters: [{ chapter: 'multicycle', step: 3, label: 'Microcode' }, { chapter: 'multicycle', step: 4, label: 'Same CPU, microprogrammed' }],
  },
  division: {
    idea: 'Binary long division produces one quotient bit per step, and each digit is 0 or 1: does the divisor fit? A restoring step shifts the next dividend bit into the partial remainder (r ← 2r + bit), subtracts the divisor and looks at the borrow. No borrow: it fits, quotient bit 1, keep the difference. Borrow: quotient bit 0, keep (restore) the old value. n bits take n steps: an iterative divider runs them one per clock on one subtractor under a small FSM (16 steps for RV16; the campaign\'s 16-bit divider is 1 445 NANDs), an array divider unrolls them into n rows of subtractors, as slow combinationally as it is large.<br>Faster dividers change the digit set. Non-restoring division never restores: a negative remainder is corrected by adding in the next step. SRT allows digits −1, 0 and 1, chosen from a few top bits of a carry-save remainder, so no step waits for a carry chain; radix 4 retires two bits per step. Division remains the slowest common operation, the one a CPU makes the rest of the pipeline wait for.',
    example: { title: '13 ÷ 3 in four steps', body: '<pre>step  r = 2r + bit    − 3    q\n 1    0·2 + 1 = 1    &lt; 0    0\n 2    1·2 + 1 = 3      0    1\n 3    0·2 + 0 = 0    &lt; 0    0\n 4    0·2 + 1 = 1    &lt; 0    0</pre>The dividend 1101 enters from its top bit. q = 0100 = 4, r = 1: 13 = 4 · 3 + 1.' },
    mistakes: [
      'Feeding the dividend from its low bit: long division consumes it from the most significant bit down.',
      'Trapping on division by zero: RISC-V returns all ones as the quotient and the dividend as the remainder, and the divider must produce exactly that.',
      'Running the unsigned algorithm on signed operands: divide the magnitudes, negate the quotient if the signs differ, and give the remainder the dividend\'s sign.',
    ],
    lib: 'divstep4',
    chapters: [{ chapter: 'muldiv', step: 13, label: 'Division: one restoring step' }, { chapter: 'muldiv', step: 15, label: 'The iterative divider' }, { chapter: 'muldiv', step: 20, label: 'Dividers compared' }],
  },

  // ---- act 9: lanes
  lane: {
    idea: 'A lane is the part of a datapath that one data element needs: in the RV16 lane cores, the operand-b mux (rs2 or the shared immediate) and the ALU, plus, outside the lanes block, the lane\'s own register file, memory port and result muxes. Every lane receives the same decoded instruction in the same cycle: the ALU operation, bimm, the immediate, the register numbers. What differs is the contents of its registers, so one <code>add</code> makes a different sum in each lane.<br>A lane has no PC, no instruction memory and no control unit: those are what SIMD shares. One RV16 lane costs 3 489 NANDs (registers 2 193, ALU, mux and nz 1 149, result muxes 147), 74% of the single-cycle core\'s 4 741, so four lanes behind one front end are only 17% smaller than four cores. The ratio favours GPUs more than it does here, because the cores they compete with spend far more on their front ends (prediction, out-of-order issue, caches).',
    example: { title: 'One addi, four lanes', body: '<pre>csrr t0, tid       lanes:  0   1   2   3\n                   t0  =   0   1   2   3\naddi a0, t0, 1     a0  =   1   2   3   4</pre>The control unit decodes the addi once: bimm = 1, ALU = add, imm = 1, rd = a0. Each ALU adds 1 to its own t0, and each register file writes its own a0 at the same edge.' },
    mistakes: [
      'Giving a lane its own control signals: the instruction is decoded once, and a lane that needs a different operation needs a different instruction, which one PC cannot fetch in the same cycle.',
      'Counting a lane as an ALU: its register file is twice the ALU (2 193 against 1 055 NANDs), and its memory port costs more than either once memory is real.',
      'Expecting a masked-off lane to stop: it still reads, computes and drives its address; the mask only blocks its writes.',
    ],
    lib: 'rv16_lanes4', compare: ['rv16_alu16'],
    chapters: [{ chapter: 'lanes', step: 1, label: 'One decoder, four ALUs' }, { chapter: 'lanes', step: 4, label: 'Lanes against cores' }],
  },
  vrf: {
    idea: 'Each thread needs its own architectural registers, so a 4-lane core holds four copies of x1–x7. The copies share every address: the instruction names rs1, rs2 and rd once, and all four files are read and written at those numbers in the same cycle. The only per-lane input besides the data is the write enable, driven by the active mask: a masked-off lane keeps its registers.<br>Storage is the one part of a lane nothing can share, so it dominates. The RV16 lane register file is four 2 193-NAND files, 8 772 NANDs, 56% of the SIMD core; built from flip-flops and mux trees it spends about 78 transistors per stored bit, against 6 in an SRAM cell. Real GPUs keep it in banked SRAM (65 536 32-bit registers per streaming multiprocessor on recent Nvidia parts), and it is still the largest structure on the chip; its size also bounds how many warps a core can hold at once.',
    example: { title: 'A masked write', body: 'mask = 0101, <code>addi a0, t0, 10</code> with t0 = 0, 1, 2, 3:<br>wa = a0 (x3), wd = 10, 11, 12, 13, we = mask = 0101.<br>Lanes 0 and 2 write 10 and 12; lanes 1 and 3 keep their old a0. At the next instruction ra1 = x3 reads (10, old, 12, old).' },
    mistakes: [
      'Giving lanes different register numbers: the instruction carries one rs1, so a lane that needs another register needs another instruction.',
      'Gating the register write but not the store: the mask must gate both, or a masked lane changes memory.',
      'Forgetting x0 in each lane: every one of the four files must read 0 for register 0 and ignore writes to it.',
    ],
    lib: 'rv16_vrf4', compare: ['rv16_rf'],
    chapters: [{ chapter: 'lanes', step: 1, label: 'One decoder, four ALUs' }, { chapter: 'lanes', step: 4, label: 'Lanes against cores' }],
  },
  activemask: {
    idea: 'The active mask has one bit per lane and answers one question: may this lane change state? A lane whose bit is 0 still sees every instruction, reads its registers and computes, but its register and store enables are forced to 0. That is how a warp of lanes in lock-step does less than all of its work: the tail of an array whose length is not a multiple of the lane count, one side of an if, a lane that has finished its loop.<br>Three things load it: <code>tmc rs1</code> (the leader\'s rs1, low four bits), and split and join through the reconvergence stack; reset sets all ones, and an empty mask ends the warp. RV16\'s is 102 NANDs: a 4-bit register with enable, the reset ORs, the leader, <i>any</i> and the eight ANDs on rwe and mwe. The RV32 lane core of chapter 27 stores it inverted, so that flip-flops powering up at 0 mean every lane active.',
    example: { title: 'tmc, three times', body: '<pre>                  mask   leader\nli  t1, 3         1111   0\ntmc t1            0011   0       lanes 0, 1 only\nli  t1, 12        0011   0\ntmc t1            1100   2       lane 0 turned itself off\nli  t1, 15        1100   2       only lanes 2, 3 load 15\ntmc t1            1111   0</pre>The whole test program runs 16 instructions; 75% of its lane-steps do work.' },
    mistakes: [
      'Gating only the register write: a masked lane\'s store still reaches memory.',
      'Forgetting that the leader moves with the mask: after tmc 1100 the leader is lane 2, and lane 0\'s registers no longer decide anything.',
      'Expecting a masked lane to save time: the warp issues the instruction anyway; only the lane utilization drops.',
    ],
    lib: 'rv16_mask4', compare: ['low1_4'],
    chapters: [{ chapter: 'simt', step: 0, label: 'The active mask' }, { chapter: 'simt', step: 4, label: 'Loops of different lengths' }],
  },
  reconvergence: {
    idea: 'Divergence needs two things the mask alone cannot give: a record of the lanes still owed the other side of an if, and a point where all of them come back. The stack gives both. <code>split rs1</code> divides the active lanes into then (rs1 ≠ 0) and else, pushes (the mask before the split, the else lanes, the address after the split, pending = both sides non-empty) and runs the then lanes. The <code>join</code> at the end of the if is reached twice: on a pending entry it switches the mask to the else lanes, clears pending and jumps back to just after the split, where their branch now goes the other way; on a non-pending one it restores the saved mask and pops. A split the lanes agree on pushes an entry with nothing pending, so its join only pops.<br>RV16\'s stack is a shift register of four 26-bit entries (mask, else, pc, pending, valid), 1 995 NANDs, period 19, with the top entry always in the same place. Four entries allow four nested ifs. It is Vortex\'s scheme, and the idea of Nvidia\'s SSY / SYNC; since Volta, Nvidia keeps a PC per thread instead and lets the scheduler regroup them.',
    example: { title: 'An if / else on four lanes', body: '<pre>pc  mask  instruction       stack top (mask, else, pc, pending)\n 2  1111  split t1          push (1111, 0101, 3, 1): mask ← 1010\n 3  1010  beqz t1, even     odd lanes fall through\n 4  1010  slli, add, j done\n 8  1010  join              pending: mask ← 0101, pc ← 3\n 3  0101  beqz t1, even     even lanes branch\n 7  0101  srli a0, t0, 1\n 8  0101  join              not pending: mask ← 1111, pop\n 9  1111  sw a0, 16(t0)</pre>14 instructions on the golden model, every lane right, 71% of the lane-steps doing work.' },
    mistakes: [
      'Jumping to the else code at the first join: the entry holds the address after the split, so the else lanes run the branch again, and it now goes their way. The branch needs no change.',
      'Popping at the first join: the else lanes never run.',
      'Marking an entry pending when one side is empty: its first join would load an empty mask and end the warp.',
      'Nesting deeper than the stack: a fifth split drops the bottom entry, and its lanes never get their mask back.',
    ],
    lib: 'rv16_stack4', compare: ['simtctl4_4'],
    chapters: [{ chapter: 'simt', step: 2, label: 'split and join' }, { chapter: 'simt', step: 3, label: 'An if inside an if' }],
  },
  coalescing: {
    idea: 'A memory port as wide as a line reads or writes several neighbouring words at once. Lanes whose words share a line can all be served by one access; the coalescer works out which. The leader (lowest active lane) picks the line; every active lane whose address agrees with it above the word-in-line bits is served; the others are left for the next access, which a sequencer issues with the mask set to the lanes left, until none is.<br>RV16 is word-addressed with 16-bit words, so a four-word line is the address with bits 1 … 0 dropped. The coalescer is 467 NANDs, depth 27: the leader logic, a 4:1 mux for the leader\'s line, three 14-bit equality comparators (lane 0, when active, is the leader) and the served / left bits. How many accesses a load takes depends only on the addresses: neighbouring threads on neighbouring words is one, a stride of four words is four. GPU programmers lay out data for the first case (a structure of arrays rather than an array of structures).',
    example: { title: 'Four lanes, four patterns', body: '<pre>addresses (lanes 0–3)        mask  line   served  left   accesses\n0x100 0x101 0x102 0x103       1111  0x040  1111    0000   1\n0x102 0x103 0x104 0x105       1111  0x040  0011    1100   2\n0x100 0x104 0x108 0x10C       1111  0x040  0001    1110   4\n0x7F3 0x100 0x101 0x102       1110  0x040  1110    0000   1  (lane 0 off: lane 1 leads)</pre>The second row is the same four neighbours, two words off the line boundary: aligning arrays to a line matters.' },
    mistakes: [
      'Comparing whole addresses: equal words are only a special case; a line holds four.',
      'Taking lane 0\'s line instead of the leader\'s: with lane 0 masked off its stale address picks a line that may serve nobody, and a sequencer looping until left = 0 never ends.',
      'Leaving inactive lanes in left (or in served): the sequencer would issue accesses for lanes that do nothing.',
    ],
    lib: 'rv16_coal4',
    chapters: [{ chapter: 'feed', step: 0, label: 'One port, a line wide' }, { chapter: 'feed', step: 1, label: 'Coalescing' }],
  },
  edgefn: {
    idea: 'Every edge of a triangle splits the plane in two. For the edge from vertex i to vertex i + 1, E(x, y) = A·(x − xᵢ) + B·(y − yᵢ) with A = yᵢ − yᵢ₊₁ and B = xᵢ₊₁ − xᵢ is the cross product of the edge with the vector to (x, y): zero on the line, positive on one side, negative on the other. A pixel is inside when all three edge functions are ≥ 0 at its centre. Wound the other way, all three flip sign: the triangle shows its back, and a renderer that draws only front faces skips it.<br>Two properties make it the rasterizer\'s tool. It is linear, so moving one pixel right adds 4A and one down adds 4B (vertices in quarter pixels): a pixel a cycle needs one adder per edge, never a multiplier. And the three E add up to the same number everywhere, twice the triangle\'s signed area: their ratios to it are the barycentric weights, what depth and colour are interpolated with. A centre exactly on an edge shared by two triangles must go to one of them: the top-left rule subtracts 1 from every edge that is neither left (A &gt; 0) nor top (A = 0, B &gt; 0).',
    example: { title: 'One pixel, three edges', body: '<pre>vertices (10, 10) (120, 30) (40, 120), quarter pixels\nedge 0: A = 10 − 30 = −20   B = 120 − 10 = 110\nedge 1: A = 30 − 120 = −90  B = 40 − 120 = −80\nedge 2: A = 120 − 10 = 110  B = 10 − 40 = −30\npixel (12, 12): centre (50, 50)\nE0 = −20·40 + 110·40 = 3 600 − 1 (bias) = 3 599\nE1 = −90·(−70) − 80·20 = 4 700 − 1 = 4 699\nE2 = 110·10 − 30·(−70) = 3 200\nall ≥ 0: inside. E0 + E1 + E2 + 2 = 11 500 = twice the area.</pre>' },
    mistakes: [
      'Testing the pixel\'s corner instead of its centre: triangles grow by half a pixel on two sides and shrink on the others.',
      'Using &gt; 0 on every edge: a pixel centred on a shared edge is drawn by neither triangle, a crack; ≥ 0 everywhere draws it twice. The top-left bias picks one.',
      'Too few bits: with 7-bit quarter-pixel vertices |E| reaches 2·127², 32 258: 16 bits signed, with nothing to spare.',
    ],
    lib: 'rv16_edge',
    chapters: [{ chapter: 'pixels', step: 1, label: 'Inside a triangle' }],
  },
  // ---- act 10: memory
  senseamp: {
    idea: 'A DRAM cell cannot drive its bit line: it can only share its charge with it. A 25 fF cell on a 100 fF line precharged to VDD/2 moves the line to (25·V + 100·V/2) / 125: 0.6 VDD for a stored 1, 0.4 VDD for a 0, a swing of 50 mV at 0.5 V around the middle. The sense amplifier is two inverters, each driving the other\'s input, between that line and a <b>reference line</b> of the same capacitance and the same precharge with no cell on it. Powered up (sae), the side that is a little higher turns the opposite pull-down on a little harder, which pulls the other side lower, which turns its own pull-up on harder: positive feedback until the lines sit at the rails.<br>The cell\'s word line is still up, so the rail it ends on is written back into it: the read destroyed the charge and the amplifier restores it. A write is the same with a driver strong enough to flip the amplifier. The two lines must be twins (same capacitance, same precharge, which is what the equalizer guarantees in silicon): any imbalance adds to the signal, and an amplifier\'s offset of some 15 mV leaves little margin.',
    example: { title: 'A read of a stored 1, in levels of VDD', body: '<pre>pre = 1      bl = 0.50  bl̄ = 0.50   cell = 1.00\npre = 0      bl = 0.50  bl̄ = 0.50   (floating, charge kept)\nwl0 = 1      bl = 0.60  bl̄ = 0.50   cell = 0.60   shared\nsae = 1      bl = 1.00  bl̄ = 0.00   cell = 1.00   restored</pre>' },
    mistakes: [
      'Leaving the reference line without capacitance: once pre falls it holds no level, and the amplifier has nothing to compare with.',
      'Raising sae before the word line: the lines are still equal and the amplifier decides on noise (here: X).',
      'Forgetting that a read is destructive: closing the word line before the amplifier has fired leaves the cell at 0.6 or 0.4, half way to forgotten.',
    ],
    lib: 'rv16_dramcol',
    chapters: [{ chapter: 'dram', step: 1, label: 'The read, in slow motion' }, { chapter: 'dram', step: 2, label: 'The sense amplifier' }],
  },
  dma: {
    idea: 'A processor copying a buffer spends a load, a store and loop overhead on every word, and waits on memory for each. A <b>DMA engine</b> is a second bus master built for that one job: the processor stores a source, a destination and a length into its registers and moves on; the engine reads a word, writes it, steps its pointers and counts down, then raises an interrupt. Disk controllers, network cards and display controllers all move their data this way.<br>The engine competes for the bus like any master, so the arbiter decides who waits; a processor with caches mostly does not notice. m_dma is 1 366 NANDs: four 16-bit registers (source, destination, count, the word in flight) are 832 of them, three incrementers and the load muxes most of the rest. Its count register holds NOT(words left) and counts up, so the incrementer\'s carry, true when the register is all ones, says the copy is complete, len = 0 included, with no comparator.',
    example: { title: 'Starting a copy from RV16', body: '<pre>li  t0, 0x8000     # source\nsw  t0, -16(x0)    # 0xFFF0\nli  t0, 0x0100     # destination\nsw  t0, -15(x0)    # 0xFFF1\nli  t0, 64         # words: starts the copy\nsw  t0, -14(x0)    # 0xFFF2\n…                  # work, or wait for the interrupt</pre>' },
    mistakes: ['Changing the address as soon as the read is issued instead of when it is ready: the memory is still answering the old request.', 'Raising irq when the last read completes instead of the last write.', 'A count that is compared against len: a 16-bit comparator where the incrementer\'s carry already says it.'],
    lib: 'rv16_dma',
    chapters: [{ chapter: 'bus', step: 3, label: 'DMA' }],
  },
};
