// The fuller codex: tricks and concepts. See codexmore.ts. Every count, depth, period and cycle
// figure here was measured on the library (stats, static timing with 8-delay memories, the core
// bench) or on the RV16 golden model; re-measure before changing one.

import type { CodexMore } from './codexmore';

export const MORE1: Record<string, CodexMore> = {
  // ---- the big picture
  cpu: {
    idea: `A processor is a state machine whose next-state function is chosen by data: the word at <code>imem[pc]</code> selects which transformation of (PC, registers, memory) happens this step. The program is an input, so one fixed circuit runs any program. In RV16 the architectural state is the 16-bit PC, seven 16-bit registers (x0 is a constant) and 64 K words of data memory; the program sits in a separate ROM the CPU never writes.<br>Everything else (control unit, immediate generator, ALU, multiplexers) is combinational logic computing the next state. The single-cycle core <code>rv16_cpu</code> is 5,236 NANDs; the only state it holds itself is 128 flip-flops (16 for the PC, 112 for x1–x7). The memories are outside it.`,
    example: {
      title: 'Five instructions, thirteen steps',
      body: `<pre>pc  instruction            state change
0   li   a0, 5             a0 ← 5
1   loop: addi a0, a0, -1  a0 ← 4, 3, 2, 1, 0
2   bnez a0, loop          pc ← 1 while a0 ≠ 0
3   sw   a0, -3(x0)        OUT (0xFFFD) ← 0
4   halt                   pc stays 4</pre>1 + 5 × 2 + 1 + 1 = 13 steps on the golden model; the single-cycle core takes one clock per step.`,
    },
    mistakes: [
      'Forgetting that the PC is state: a jump is a write to it, and a trap must save it (mepc) before overwriting it.',
      'Carrying RV32 habits over: RV16 is word addressed, so the next instruction is pc + 1 and the next array element address + 1, never + 2 or + 4.',
      'Expecting <code>lw</code> to read the program: instruction ROM and data RAM are separate memories, so a table of constants belongs in <code>.data</code>.',
    ],
    anatomy: ['pc', 'rf', 'imem', 'dmem'],
    chapters: [{ chapter: 'map', step: 0, label: 'From a switch to a processor' }, { chapter: 'cpu', step: 4, label: 'Run real programs' }],
  },

  fde: {
    idea: `The five steps are the order in which an instruction's data flows through the datapath, so in a single-cycle CPU their delays add up. Fetch is a memory read addressed by the PC. Decode is mostly wiring in RV16 (the fixed fields go straight to the register file and the immediate generator) plus the control unit, which turns the opcode into multiplexer selects and write enables. Execute is the ALU, with the branch comparator and the next-PC adders working in parallel. Memory is a data RAM access, for lw and sw only. Write back selects the result (ALU, loaded word, pc + 1, immediate) and writes rd at the clock edge, together with the new PC.<br>A pipeline gives each step its own cycle and its own register, with up to five instructions in flight; a multicycle CPU gives each step its own cycle but keeps one instruction at a time.`,
    example: {
      title: 'A load, step by step, in NAND delays',
      body: `<pre>step          block              delay  arrival
              PC clk-to-q            3        3
fetch         ROM read               8       11
decode        control unit          13       24
              immediate mux          5       29
execute       ALU-b mux              2       31
              ALU (add)             50       81
memory        RAM read               8       89
write back    result mux             4       93
              register file input    2       95
              setup                  3       98  = period</pre>Static timing of <code>rv16_cpu</code> with 8-delay memories. The register read (7 delays) runs in parallel with the control unit and is off the critical path.`,
    },
    mistakes: [
      'Assuming the steps take equal time: in <code>rv16_cpu</code> the ALU is 50 of the 98 delays, the fetch 8.',
      'Reading registers only after decoding: RV16\'s fixed fields let the register file start as soon as the instruction arrives, in parallel with the control unit.',
      'Updating the PC early: in a single-cycle CPU the PC, the register and the memory writes all happen at one clock edge; a PC that changes mid-cycle changes the instruction being executed.',
    ],
    anatomy: ['imem', 'ctl', 'rf', 'imm', 'alu', 'dmem', 'wb', 'npc'],
    chapters: [{ chapter: 'cpu', step: 0, label: 'The datapath' }, { chapter: 'cpu', step: 1, label: 'ALU instructions' }],
  },

  abstraction: {
    idea: `Abstraction lets you use a level through its interface only: a full adder is s = a ⊕ b ⊕ c and a carry, whatever is inside. The interface carries a cost summary the next level adds up: NANDs and depth, and for state also clk-to-q and setup. Nothing is hidden here: every part opens down to transistors, and every count on the site is measured from the structure.<br>Costs multiply up the hierarchy, so a saving low down is paid back once per copy. The full adder appears 64 times in <code>rv16_cpu</code> (ALU, branch comparator, two next-PC adders): using the 9-NAND version instead of the 13-NAND one saves 256 NANDs there.`,
    example: {
      title: 'From transistor to core',
      body: `<pre>NAND                         4 transistors
XOR                          4 NANDs
full adder                   9 NANDs
16-bit adder               144 NANDs   (16 full adders)
16-bit ALU               1,250 NANDs
rv16_cpu                 5,236 NANDs   (20,944 transistors)
RV16 pipeline           10,016 NANDs</pre>`,
    },
    mistakes: [
      'Treating a black box as free: a 16:1 multiplexer is one symbol and 15 two-input muxes per bit inside.',
      'Optimising the top level while a block used 64 times stays wasteful: a saving is worth its size times the number of copies.',
      'Breaking the interface: a block whose output depends on internal timing (a glitch, a race) is no longer a function of its inputs, and the level above cannot treat it as one.',
    ],
    chapters: [{ chapter: 'map', step: 1, label: 'Open the box' }, { chapter: 'map', step: 2, label: 'How the levels stack up' }],
  },

  // ---- transistors and gates
  cmos: {
    idea: `Every CMOS gate has two switch networks driven by the same inputs: PMOS transistors from VDD to the output, NMOS from the output to GND. The networks are duals (series in one, parallel in the other), so for every input combination exactly one conducts: the output is always driven, and in a steady state no path joins VDD to GND. Power is spent only when a node switches, charging or discharging its capacitance: about C·V² per full charge and discharge.<br>NMOS passes a strong 0 and PMOS a strong 1, which is why NMOS sit at the bottom and PMOS at the top. A rising input turns NMOS on and pulls the output down, so one stage can only invert: NAND and NOR are 4 transistors, AND and OR need a second stage (6).`,
    example: {
      title: 'NOR, switch by switch',
      body: `<pre>a b   PMOS (series)    NMOS (parallel)   y
0 0   both on: VDD     both off          1
0 1   one off          one on: GND       0
1 0   one off          one on: GND       0
1 1   both off         both on: GND      0</pre>Four transistors. The two PMOS in series are why NOR is slower (or wider) than NAND: holes are 2–3× less mobile than electrons.`,
    },
    mistakes: [
      'Putting an NMOS in the pull-up: it passes a 1 degraded by a threshold voltage (VDD − V<sub>t</sub>), and the next gate may not switch cleanly.',
      'Networks that are not duals: an input where both conduct shorts VDD to GND (X in the switch-level simulation); one where neither conducts leaves the output floating (Z).',
      'Expecting a one-stage AND: a single CMOS stage inverts, so AND = NAND + inverter.',
    ],
    lib: 'nor_cmos',
    chapters: [
      { chapter: 'inverter', step: 0, label: 'Pull up, pull down' },
      { chapter: 'inverter', step: 1, label: 'Why this is brilliant' },
      { chapter: 'inverter', step: 2, label: 'The cheaper, hotter way: a pull-up' },
    ],
  },

  fanin: {
    idea: `Fan-in is the number of inputs of a gate, fan-out the number of gate inputs a net drives; in silicon both are delay. An n-input CMOS NAND has n NMOS in series, so its pull-down resistance grows with n: its logical effort (how much worse it drives than an inverter with the same input capacitance) is (n + 2)/3, and an n-input NOR's is (2n + 1)/3 because its PMOS are in series. Fan-out is capacitance: each input to charge adds delay roughly in proportion, which is why the usual yardstick is the FO4 delay, an inverter driving four copies of itself.<br>The simulator charges one delay per NAND whatever its load and builds wide gates from 2-input NANDs (a 4-input AND is 6 NANDs, depth 4), so fan-in shows up as depth and fan-out is free. In a real CPU the high-fan-out nets (an immediate's sign bit, the ALU operation, a stall signal, the clock) are driven through buffer trees.`,
    example: {
      title: 'The sign bit of RV16\'s immediates',
      body: `instr[15] is the sign of every signed immediate. In the immediate generator it drives bits 5–15 of the I and S/B immediates, bits 8–15 of J and bit 15 of U: 11 + 11 + 8 + 1 = 31 inputs of the immediate mux, plus the f3 logic in the control unit. Here it costs nothing (<code>rv16_imm</code> is 0 NANDs). In silicon a net with about 30 loads gets a buffer tree of fan-out 4 per stage: log<sub>4</sub> 30 ≈ 2.5, so three inverter stages.`,
    },
    mistakes: [
      'Counting a wide gate as one delay: a 16-input NAND would stack 16 transistors in series, so wide functions are trees (a 16-bit zero detect here is 46 NANDs, depth 9).',
      'Ignoring the load of control signals: each ALU-operation bit drives a gate in every one of 16 bit slices.',
      'Choosing NOR for wide functions: its series PMOS make it worse than NAND at every fan-in.',
    ],
    anatomy: ['imm', 'ctl'],
    chapters: [{ chapter: 'nand', step: 1, label: 'NOR, for comparison' }, { chapter: 'silicon', step: 2, label: 'A real cell library' }],
  },

  depth: {
    idea: `Logic depth is the number of gate delays on the longest input-to-output path. A combinational block's outputs are valid only that long after its inputs change, so on a register-to-register path clk-to-q + depth + setup is the clock period. The unit here is one NAND delay, and every gate counts the NANDs it is made of: AND and OR are depth 2, XOR 3, a full adder 6.<br>Depth depends on structure as much as on function. Associative operations (AND, OR, XOR, carry combination) can be evaluated as a balanced tree, depth proportional to log<sub>2</sub> n, with the same number of gates as a chain; an adder's carries can be computed by a prefix tree, at the price of more gates and wires. Reducing depth pays on the critical path and nowhere else.`,
    example: {
      title: 'Same function, different depth',
      body: `<pre>16-input OR, chain of 15 ORs       45 NANDs   depth 30
16-input OR, balanced tree         45 NANDs   depth  8
16-bit ripple-carry adder         144 NANDs   depth 36
16-bit Kogge–Stone adder          366 NANDs   depth 16</pre>`,
    },
    mistakes: [
      'Counting gates instead of NAND delays: an OR is one symbol and two delays (¬a, then a NAND).',
      'Measuring from one input only: the longest path may start elsewhere (in a ripple adder, at bit 0 or cin, ending at the top sum bit).',
      'Trusting static depth as the real delay: a path no input can sensitise (a false path, as in a carry-skip adder) counts statically and never happens.',
    ],
    lib: 'rv16_wide16',
    chapters: [
      { chapter: 'fastadd', step: 0, label: 'The ripple problem' },
      { chapter: 'routing', step: 2, label: 'Bigger multiplexers are trees' },
      { chapter: 'fastadd', step: 4, label: 'Carry-skip, and a false path' },
    ],
  },

  bus: {
    idea: `A bus is a name for a group of 1-bit wires carrying one value. Simulation, netlists and cost all work bit by bit: a 16-bit bus is 16 nets, and an operation on it is 16 copies of the 1-bit circuit (a 16-bit 2:1 multiplexer is 16 muxes, 64 NANDs, depth 3, or 49 when they share one inverter on the select). Splitting a bus into fields or merging fields into a bus only renames wires and costs nothing, which is why RV16's decoder is mostly wiring: rd, rs1, rs2 and f3 are slices of the instruction bus, and the immediate generator, with all its shifting and sign extension, is 0 NANDs.<br>A bus with several sources needs a multiplexer in front of the reader, or tri-state drivers that let go (Z) when not selected; two drivers active at once fight (X).`,
    example: {
      title: 'The fields of one instruction bus',
      body: `<pre>add a0, a1, a2 = 0x1631
bits    15:13  12:10  9:7   6:4   3:0
value    000    101   100   011   0001
field    f3     rs2   rs1   rd    op
         0      a2    a1    a0    OP</pre>Each field is a splitter output: no gates, no delay.`,
    },
    mistakes: [
      'Reversing bit order in a splitter or merger: the circuit still works, with wrong values.',
      'Costing a bus operation as one gate: every per-bit circuit is ×16 at RV16 width (×32 at RV32).',
      'Connecting two outputs to one bus without tri-state drivers or a mux: contention.',
    ],
    lib: 'mux2x4',
    anatomy: ['imm', 'rf'],
    chapters: [{ chapter: 'routing', step: 3, label: 'Switching whole buses' }, { chapter: 'routing', step: 4, label: '8 words in, 1 word out' }],
  },

  // ---- numbers
  positional: {
    idea: `A string of digits is a polynomial in the base: b<sub>n−1</sub>…b<sub>0</sub> means Σ b<sub>k</sub>·2^k. Each position weighs twice the one to its right, so a left shift doubles a number and drops the top bit, a right shift halves it and drops the bottom bit. n bits hold 0 … 2^n − 1 unsigned: 0 … 65,535 at 16 bits.<br>An adder is positional notation in hardware: column k adds the two bits of weight 2^k and a carry of the same weight, and passes a carry of weight 2^(k+1) to the left.`,
    example: {
      title: '1000 in binary',
      body: `<pre>1000 ÷ 2 = 500 r 0      bit 0
 500 ÷ 2 = 250 r 0
 250 ÷ 2 = 125 r 0
 125 ÷ 2 =  62 r 1
  62 ÷ 2 =  31 r 0
  31 ÷ 2 =  15 r 1
  15 ÷ 2 =   7 r 1
   7 ÷ 2 =   3 r 1
   3 ÷ 2 =   1 r 1
   1 ÷ 2 =   0 r 1      bit 9
read upwards: 11 1110 1000 = 0x3E8 = 512 + 256 + 128 + 64 + 32 + 8</pre>`,
    },
    mistakes: [
      'Getting the range off by one: n bits reach 2^n − 1, so 65,536 needs a 17th bit.',
      'Reading the remainders top-down: the first remainder is bit 0.',
      'Assuming a left shift always doubles: the top bit falls off (0x8000 shifted left is 0 at 16 bits).',
    ],
    chapters: [{ chapter: 'binary', step: 0, label: 'Counting with two digits' }],
  },

  hex: {
    idea: `Hexadecimal writes a binary word four bits per digit (0–9, then A–F for 10–15), so converting is a lookup per nibble with no arithmetic, and a 16-bit RV16 word is exactly four digits. Addresses, instruction words and memory dumps are written in hex because each digit stands for fixed bits.<br>The digits follow nibbles, and an encoding's fields need not. RV16's opcode is the low nibble, but rd, rs1 and rs2 are 3-bit fields that straddle digit boundaries, so decoding by eye means writing out the binary first.`,
    example: {
      title: '0xFDB4, decoded',
      body: `<pre>hex       F    D    B    4
binary   1111 1101 1011 0100
fields   111111 011 011 0100
         imm6   rs1 rd  op
         −1     a0  a0  ADDI   →  addi a0, a0, -1</pre>`,
    },
    mistakes: [
      'Reading register fields off hex digits: in 0xFDB4 the digit B holds bit 7 (part of rs1) and all of rd.',
      'Dropping leading zeros of a fixed-width word: 0x0005 is a 16-bit instruction, and its zeros are fields.',
      'Forgetting that 0xFFFB is −5 when it is an offset: the MMIO registers are reached as <code>-5(x0)</code>.',
    ],
    chapters: [{ chapter: 'binary', step: 0, label: 'Counting with two digits' }],
  },

  twos: {
    idea: `In two's complement the top bit weighs −2^(n−1) and the others keep their positive weights, so a pattern with the top bit set reads as u unsigned and u − 2^n signed. Addition modulo 2^n is the same operation under both readings, which is why one adder serves signed and unsigned arithmetic and subtraction is a + ¬b + 1. Only what interprets the bits differs: comparison (slt / sltu, blt), right shifts (sra / srl), widening (sign or zero extension), the high half of a product, division.<br>The range is asymmetric, −32,768 … 32,767 at 16 bits, so −(−32,768) wraps to −32,768: negation, absolute value and division by −1 each have one input without a representable answer.`,
    example: {
      title: '−5 at 16 bits',
      body: `<pre> 5       = 0000 0000 0000 0101 = 0x0005
¬5       = 1111 1111 1111 1010 = 0xFFFA
¬5 + 1   = 1111 1111 1111 1011 = 0xFFFB = −5
unsigned:  65,531 = 65,536 − 5
check:     0xFFFB + 0x0005 = 0x1_0000 → 0x0000 (carry out dropped)</pre>`,
    },
    mistakes: [
      'Negating with ¬x alone (ones\' complement): off by one, and it has two zeros.',
      'Comparing signed values with <code>sltu</code>: −1 (0xFFFF) becomes the largest number.',
      'Forgetting the asymmetry: <code>neg</code> of 0x8000 is 0x8000, and RV16\'s <code>div</code> of −32,768 by −1 returns −32,768 by definition.',
    ],
    anatomy: ['alu'],
    chapters: [{ chapter: 'binary', step: 1, label: 'Negative numbers: two\'s complement' }, { chapter: 'adders', step: 5, label: 'Subtraction for free' }],
  },

  overflow: {
    idea: `An n-bit adder computes the sum modulo 2^n. Overflow means the true result does not fit, and it is a different event for each reading. Unsigned: the carry out of the top bit is 1. Signed: both operands have the same sign and the result has the other; equivalently V = c<sub>15</sub> ⊕ c<sub>16</sub> (carry into the top bit XOR carry out), one XOR at the adder's last stage. For a subtraction the same tests apply to a + ¬b + 1, where an unsigned borrow shows as a carry out of 0.<br>RISC-V, and RV16 with it, has no flags register and never traps on overflow: arithmetic wraps. Software that needs a check builds it from slt / sltu and a branch. Inside the ALU, V corrects the sign of a − b for the signed less-than.`,
    example: {
      title: 'Two additions at 16 bits',
      body: `<pre>0x7FFF + 0x0001 = 0x8000     c15 = 1, c16 = 0 → V = 1, C = 0
  signed 32,767 + 1 → −32,768 (overflow); unsigned 32,768 (correct)
0xFFFF + 0x0001 = 0x0000     c15 = 1, c16 = 1 → V = 0, C = 1
  signed −1 + 1 = 0 (correct); unsigned 65,535 + 1 → 0 (overflow)

add  t0, a0, a1     # signed overflow iff (a1 &lt; 0) ≠ (t0 &lt; a0)
slt  t1, a1, zero
slt  a2, t0, a0
bne  t1, a2, ovf</pre>`,
    },
    mistakes: [
      'Testing the carry for signed overflow: 0xFFFF + 0x0001 carries out and is correct as −1 + 1.',
      'Applying the addition rule to a − b without inverting b: a subtraction overflows when a and b have different signs and the result has b\'s sign.',
      'Expecting a trap: RV16 wraps silently, as RISC-V does.',
    ],
    anatomy: ['alu'],
    chapters: [{ chapter: 'adders', step: 7, label: 'Signed comparison' }],
  },

  signext: {
    idea: `Widening a two's-complement value from k to n bits copies bit k − 1 into the new top bits. The value is unchanged because −2^(k−1) = −2^(n−1) + 2^(n−2) + … + 2^(k−1): the new positive weights add back exactly what moving the sign weight up takes away. Zero extension (new bits 0) is the unsigned counterpart.<br>In hardware it is wiring: the sign bit fans out to the new positions, 0 NANDs. RV16 puts the sign of every signed immediate (I, S/B, J) in instr[15], so the immediate generator extends all of them from one wire; only U (lui) is not extended, since it supplies the top ten bits itself.`,
    example: {
      title: 'lw a0, -6(x0) = 0xE836',
      body: `<pre>imm6    = instr[15:10] = 111010           −6 in 6 bits
sext    = 1111 1111 1111 1010 = 0xFFFA    −6 in 16 bits
address = x0 + 0xFFFA = 0xFFFA            SWITCHES
zero-extended instead: 0x003A = 58         an ordinary RAM word</pre>`,
    },
    mistakes: [
      'Zero-extending branch offsets: a branch back by −1 jumps forward by 63.',
      'Sign-extending the U immediate: lui loads bits 15:6 exactly as encoded.',
      'Taking the sign from the wrong bit of a split field: in S/B the sign is imm[5] = instr[15], and instr[6] is imm[2].',
    ],
    lib: 'rv16_imm',
    anatomy: ['imm'],
    chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }, { chapter: 'io', step: 2, label: 'Loading a byte' }],
  },

  majority: {
    idea: `maj(a, b, c) is 1 when at least two inputs are 1, which is exactly when a column of binary addition carries: a full adder's carry out is maj(a, b, cin). It is symmetric, monotone (no input appears inverted) and self-dual: maj(¬a, ¬b, ¬c) = ¬maj(a, b, c).<br>Adders use the form a·b + cin·(a ⊕ b), because a ⊕ b is already needed for the sum. In NAND–NAND it is ¬(¬(a·b) · ¬(cin·(a ⊕ b))), and both inner NANDs already exist inside the two XORs of the 9-NAND full adder, so the carry costs one NAND and two delays from cin. A ripple adder's carry chain is a chain of majority gates at 2 delays per bit: depth 36 for 16 bits.`,
    example: {
      title: 'maj from its truth table',
      body: `<pre>a b c | maj    rows with at least two 1s: 011 101 110 111
0 1 1 |  1     K-map: three pairs → a·b + a·c + b·c
1 0 1 |  1     with the sum's XOR shared: a·b + c·(a ⊕ b)
1 1 0 |  1     a = b = 1: a·b = 1, carries whatever c is
1 1 1 |  1     a ≠ b: a ⊕ b = 1, carries c</pre>`,
    },
    mistakes: [
      'Using OR as the carry: 1 + 0 + 0 does not carry.',
      'Building the carry from fresh gates: correct, but sharing the XORs\' first NANDs is what takes the full adder from 13 NANDs to 9.',
      'Writing a·b + cin·(a + b) with its own OR gate: correct too, and one more gate than reusing a ⊕ b.',
    ],
    lib: 'full_adder',
    compare: ['full_adder_ha'],
    anatomy: ['alu'],
    chapters: [{ chapter: 'adders', step: 1, label: 'Adding three bits' }, { chapter: 'adders', step: 2, label: 'Optimizing: 13 NANDs → 9' }],
  },

  // ---- state
  feedback: {
    idea: `A combinational circuit is a function of its present inputs. Feed an output back to an input and the next value depends on the current one: the circuit has state. An even number of inversions around the loop gives two stable states, a bit of memory (two cross-coupled NANDs make an SR latch, 2 NANDs); an odd number gives none, and the loop oscillates with a period of twice its delay (a ring of 3 inverters: 6 NAND delays).<br>Every latch, flip-flop, register and memory cell is a controlled feedback loop. Uncontrolled ones are bugs: a combinational path from a block's output back to its own input either latches or oscillates. Synchronous design breaks every loop with an edge-triggered register.`,
    example: {
      title: 'An SR latch holding a 1',
      body: `<pre>q = ¬(s̄ · q̄)      q̄ = ¬(r̄ · q)          s̄, r̄ active low
pulse s̄ = 0:   q → 1, then q̄ → ¬(1 · 1) = 0       2 delays
s̄ = r̄ = 1:    q = ¬(1 · 0) = 1, q̄ = ¬(1 · 1) = 0   held
both 0, then both released at once: q = q̄ = 1, then a race</pre>`,
    },
    mistakes: [
      'Closing a combinational loop by accident: the simulation never settles, or holds a bit nobody meant to store.',
      'Expecting a defined value at power-on: a latch is X until it is set, reset or forced.',
      'Releasing both inputs of an SR latch together: the outcome depends on which NAND is faster (metastability).',
    ],
    lib: 'sr_latch',
    chapters: [{ chapter: 'latches', step: 0, label: 'Two NANDs holding hands' }, { chapter: 'latches', step: 1, label: 'The forbidden input, and races' }],
  },

  edge: {
    idea: `An edge-triggered flip-flop samples its input at the rising clock edge and holds it for the whole cycle. Between edges every register output is constant, so each block of logic sees stable inputs for a full period, settles, and its result is captured at the next edge. Every feedback loop passes through a register, so the circuit is a state machine with one step per cycle, and timing becomes a per-path sum: clk-to-q + logic + setup ≤ period.<br>The master–slave flip-flop gets its edge from two latches on opposite phases: the master is open while clk = 0, the slave while clk = 1, so data passes only at the 0 → 1 transition. Here it costs 11 NANDs with clk-to-q 3 and setup 3 NAND delays; a transparent D latch is 5.`,
    example: {
      title: 'Why a counter needs an edge',
      body: `q ← q + 1 through a 16-bit incrementer (depth 33). With a latch open for a 100-delay high phase, the value goes round the incrementer several times, and what is left at the closing edge depends on path delays. With flip-flops it advances exactly once per rising edge, and the period only has to be ≥ 3 + 33 + 3 = 39 delays.`,
    },
    mistakes: [
      'Using latches where flip-flops are needed: a path from a latch\'s output back to its input runs round while the latch is open.',
      'Clocking a register on the falling edge by accident (an inverted clock): its paths get half a cycle. The RV16 pipeline does it on purpose for the register file, so a value written in W is read in D in the same cycle.',
      'Feeding a clock input from logic: every glitch on it is an edge.',
    ],
    lib: 'dff',
    chapters: [{ chapter: 'latches', step: 3, label: 'The flip-flop: act only on the edge' }],
  },

  setuphold: {
    idea: `A flip-flop captures correctly only if d is stable from the setup time before the edge until the hold time after it; violate either and the captured value is wrong or metastable. Setup bounds the slow paths: period ≥ clk-to-q + longest logic + setup (here 3 + logic + 3 NAND delays). Hold bounds the fast paths: the value launched by an edge must not reach the next flip-flop before that flip-flop's hold time has passed, so clk-to-q + shortest logic ≥ hold + clock skew.<br>A setup violation is fixed by a slower clock or a shorter path. A hold violation does not depend on the period, so only extra delay on the short path or less skew fixes it; a chip with one fails at every frequency.`,
    example: {
      title: 'rv16_cpu at period 98 and at 90',
      body: `<pre>longest path (a load): 3 clk-to-q + 92 logic + 3 setup = 98
period 98: the register file's input settles at 95, in time
period 90: the edge comes before the input settles at 95,
           so the load writes a stale or half-formed word
a shift register (q straight into the next d) relies on
           clk-to-q (3) exceeding hold time + skew</pre>`,
    },
    mistakes: [
      'Fixing a hold violation by slowing the clock: the race happens right after one edge, whatever the period.',
      'Sampling an asynchronous input (a switch, an IRQ line) directly: it changes at arbitrary times and will eventually violate setup; pass it through two flip-flops first.',
      'Leaving the memories out of the path: <code>rv16_cpu</code>\'s 98 delays include two 8-delay memory reads.',
    ],
    chapters: [
      { chapter: 'fastadd', step: 7, label: 'Static timing on our CPU' },
      { chapter: 'fastadd', step: 8, label: 'Overclock it' },
      { chapter: 'silicon', step: 4, label: 'Wires and the clock' },
    ],
  },

  harvard: {
    idea: `A Harvard machine has separate memories (and buses) for instructions and data; a von Neumann machine keeps both in one memory. The difference shows in a single-cycle CPU: a load needs two reads in one cycle, the instruction at pc and the data at rs1 + imm, and a single-port memory cannot do both. RV16 here is Harvard and word addressed: an instruction ROM read at the PC and a data RAM read and written by lw and sw, each with a 16-bit address space.<br>The price is flexibility: a program cannot read its own code as data or write new code. Real processors are usually von Neumann at main memory and Harvard at the first cache level, where split instruction and data caches give fetch and memory access a port each.`,
    example: {
      title: 'One memory instead of two',
      body: `<pre>single-cycle lw, one memory: fetch and data read collide
    → a second cycle for every load and store, CPI > 1
pipeline, one memory: F reads at pc while M reads data
    → a structural hazard on every load and store
RV16: separate imem and dmem, so neither happens</pre>`,
    },
    mistakes: [
      'Putting a lookup table in the program and reading it with <code>lw</code>: lw reads data memory; tables go in <code>.data</code>.',
      'Assuming an instruction address and a data address name the same word: pc 0x0010 and data address 0x0010 are in different memories.',
      'Counting Harvard as free: two memories or two ports cost area; the guided chapter\'s multicycle CPU serves fetches and loads from one port to save it.',
    ],
    anatomy: ['imem', 'dmem'],
    chapters: [{ chapter: 'cpu', step: 0, label: 'The datapath' }, { chapter: 'cache', step: 12, label: 'Caching instructions too' }],
  },

  // ---- ISA and software
  isa: {
    idea: `The ISA is everything a program can observe: the registers and memory, what each instruction does to them, how instructions are encoded, what traps and when. Anything a program cannot see (pipelining, caches, the adder type, the cycles a divide takes) is the implementation's choice. One RV16 binary therefore runs unchanged on the single-cycle core, the pipeline and the multicycle core, and each is checked by comparing its register writes and stores, in order, with the golden model (iss16).<br>ISA decisions are cost decisions. Fixed field positions make decoding wiring; x0 = 0 turns mv, nop, neg and j into pseudo-instructions for free; load / store keeps memory off the ALU path; having no flags register removes a piece of state that every instruction would otherwise update and the pipeline would have to forward.`,
    example: {
      title: 'gcd(1071, 462): one program, four machines',
      body: `<pre>core                    cycles  period   time (NAND delays)
single-cycle                50      98       4,900
pipeline                    83      78       6,474
pipeline + prediction       61      80       4,880
multicycle                 150      76      11,400</pre>51 instructions; cycles counted to the last result, periods from static timing with 8-delay memories. Same register writes and stores on all four. The plain pipeline loses on this program: 15 taken branches and jumps cost 2 cycles each. With prediction it only draws level.`,
    },
    mistakes: [
      'Relying on implementation timing: a program that expects a loaded value one cycle late works on one core and fails on another.',
      'Confusing pseudo-instructions with the ISA: <code>li</code>, <code>mv</code>, <code>call</code> and <code>push</code> are assembler expansions; the hardware sees lui, addi, jal and sw.',
      'Adding an instruction because one program wants it: each costs decode logic, tests and room in a fixed encoding space (RV16 has 16 opcodes).',
    ],
    chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }, { chapter: 'isa', step: 1, label: 'The assembler' }],
  },

  rv16: {
    idea: `RV16 is RISC-V's base integer ISA cut down to 16 bits so that the whole CPU can be built from NANDs and tested exhaustively: 16-bit data and instructions, eight registers with x0 = 0, word addressing (pc + 1), separate instruction and data memories, 4-bit opcodes, 6-bit immediates. Left out, with their replacements: andi / ori / xori (li + the register form), sltiu, bltu / bgeu (<code>sltu</code> + <code>bnez</code>), auipc, byte and halfword access. Optional: MD (multiply / divide, op 3) and SYSTEM (CSRs, ecall, ebreak, mret, wfi, traps and interrupts, op 0).<br>Memory-mapped devices occupy the top seven data addresses, 0xFFF9–0xFFFF, all reachable as a negative offset from x0; 0xFFF7–0xFFF8 are reserved (they read 0 and drop stores). The golden model halts on <code>jal x0, 0</code> (0x000C); a branch to itself is a spin.`,
    example: {
      title: 'The opcode map',
      body: `<pre>op    name    fmt     op    name    fmt
0000  SYSTEM  SYS     1000  BEQ     B
0001  OP      R       1001  BNE     B
0010  OPX     R       1010  BLT     B
0011  MD      R       1011  BGE     B
0100  ADDI    I       1100  JAL     J
0101  SHI     I       1101  JALR    I
0110  LW      I       1110  SW      S
0111  LUI     U       1111  LUI     U    (op[3] = imm bit 0)
x0 zero · x1 ra · x2 sp · x3–x5 a0–a2 · x6–x7 t0–t1</pre>`,
    },
    mistakes: [
      'Stepping through an array by 2 or 4: words are 16 bits and addresses count words.',
      'Expecting 12-bit immediates: addi, lw, sw and branches take −32 … 31, so <code>li</code> of anything else is usually two words, and a branch reaches ±32 words (jal: −256 … 255).',
      'Writing <code>bltu</code> or <code>bgeu</code>: RV16\'s branches are equality and signed only; unsigned needs sltu then bnez / beqz.',
    ],
    chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }],
  },

  formats: {
    idea: `RV16 keeps every field at one position in every format that has it: op [3:0], rd [6:4], rs1 [9:7], rs2 [12:10], f3 [15:13]. Formats differ only in which positions are reused for immediate bits. The payoff is in hardware: the register file's read addresses are wired straight from instr[9:7] and instr[12:10] and start reading as soon as the word arrives, without waiting for the control unit, and the immediate generator is wiring (0 NANDs). S and B have no rd but need rs2, so their 6-bit immediate is split around it: imm[5:3] in f3's place, imm[2:0] in rd's.<br>The register file reads rs1 and rs2 for every instruction, used or not; the control unit decides what to do with them. The sign of every signed immediate is instr[15].`,
    example: {
      title: 'Two encodings, bit by bit',
      body: `<pre>add a0, a1, a2       f3   rs2  rs1  rd   op
                     000  101  100  011  0001   = 0x1631
sw a0, 5(sp)         imm  rs2  rs1  imm  op
  imm = 5 = 000101   000  011  010  101  1110   = 0x0D5E
                     [5:3]          [2:0]</pre>`,
    },
    mistakes: [
      'Treating an S or B instruction\'s rd field as a register: it holds imm[2:0], so anything keyed on rd (writes, forwarding, hazards) must be gated by the register-write enable.',
      'Swapping rs1 and rs2 in a store: <code>sw rs2, imm(rs1)</code> stores rs2 at rs1 + imm.',
      'Counting rs2 as a source for I-type instructions: bits 12:10 are immediate bits there; reading that register is harmless, but a hazard unit that counts it stalls more than needed (RV16\'s does, to stay simple).',
    ],
    anatomy: ['rf', 'imm', 'ctl'],
    chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }],
  },

  immediates: {
    idea: `An immediate is a constant carried inside the instruction. RV16 has four: I (addi, lw, jalr, shifts) imm6 = instr[15:10]; S/B imm6 = {instr[15:13], instr[6:4]}; J imm9 = instr[15:7]; U imm10 = {instr[15:7], instr[3]}, placed in bits 15:6. I, S/B and J are sign-extended, so offsets reach −32 … 31 (J: −256 … 255); U fills the top ten bits and leaves the bottom six to an addi.<br>A constant outside −32 … 31 takes two instructions: <code>li</code> splits v into %hi and %lo with v = (hi &lt;&lt; 6) + sext(lo). Because addi sign-extends lo, %hi is rounded: when bit 5 of v is 1, lo is negative and hi is one more than v &gt;&gt; 6. (A multiple of 64 needs only the lui.) All four immediates are wiring; a 4:1 bus mux selected by the control unit's isel picks one.`,
    example: {
      title: 'li a0, 1000',
      body: `<pre>1000 = 0b11_1110_1000      v &gt;&gt; 6 = 15, v &amp; 63 = 40
40 ≥ 32, so lo = 40 − 64 = −24 and hi = 15 + 1 = 16
lui  a0, 16          a0 = 16 &lt;&lt; 6 = 1024      0x0437
addi a0, a0, -24     a0 = 1024 − 24 = 1000    0xA1B4</pre>`,
    },
    mistakes: [
      'Computing %hi as v &gt;&gt; 6 without rounding: lo = 40 does not fit in −32 … 31.',
      'Measuring a branch offset from pc + 1: the target is pc + imm with pc the branch\'s own address, so a branch to the previous instruction has offset −1.',
      'Forgetting that lui\'s lowest immediate bit sits in op[3]: lui has two opcodes, 0111 and 1111, and a decoder that checks all four op bits misses half of the lui words.',
    ],
    lib: 'rv16_imm',
    anatomy: ['imm'],
    chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }, { chapter: 'isa', step: 1, label: 'The assembler' }],
  },

  branches: {
    idea: `A branch makes the next PC depend on data. RV16 has four conditional branches, beq / bne / blt / bge (pc ← pc + imm6 if the condition holds; lt and ge are signed), and two jumps that link: jal rd, imm9 (rd ← pc + 1, pc ← pc + imm9) and jalr rd, imm(rs1) (rd ← pc + 1, pc ← rs1 + imm6). jal serves calls and local jumps; jalr returns, function pointers and jump tables.<br>In hardware one comparator serves all four conditions: op[1] picks equality or less-than and op[0] inverts the result, so bne = ¬beq and bge = ¬blt. The next-PC logic computes pc + imm and rs1 + imm in parallel and selects. A branch's real cost is in the pipeline: it resolves in E, after two younger instructions have been fetched.`,
    example: {
      title: 'A countdown loop',
      body: `<pre>0x5  loop: addi a0, a0, -1      0xFDB4
0x6        bne  a0, x0, loop    0xE1F9    offset 0x5 − 0x6 = −1 = 111111
bne:  imm[5:3]  rs2  rs1  imm[2:0]  op
      111       000  011  111       1001</pre>`,
    },
    mistakes: [
      'Writing <code>bltu</code>: there is none; use <code>sltu t0, a0, a1</code> then <code>bnez t0, target</code>.',
      'Exceeding the reach: a branch spans −32 … 31 words; a farther target needs the inverted branch around a <code>j</code>.',
      'Returning with <code>jalr ra, 0(ra)</code>: it overwrites ra with its own return point; <code>ret</code> is <code>jalr x0, 0(ra)</code>.',
    ],
    lib: 'rv16_branch',
    anatomy: ['br', 'npc'],
    chapters: [{ chapter: 'cpu', step: 3, label: 'Branches and jumps' }],
  },

  loadstore: {
    idea: `Only two instructions touch data memory: lw rd, imm(rs1) reads the word at rs1 + sext(imm6), and sw rs2, imm(rs1) writes rs2 there. Every other instruction reads and writes registers only. Each instruction thus makes at most one memory access, at a fixed point after the ALU has computed the address, which keeps the datapath a straight line and gives the pipeline a single M stage. The address comes from the same ALU adder as add.<br>Base + offset covers the common cases in one instruction: a local at sp + k, a structure field at p + k, a device at x0 + k (−1 … −7 reach 0xFFFF … 0xFFF9). Arrays are walked by adding 1 to the base register per word.`,
    example: {
      title: 'Summing four words',
      body: `<pre>        li   a0, 0x40        # a0 → the table
        li   a1, 0
        li   t0, 4
loop:   lw   t1, 0(a0)
        add  a1, a1, t1
        addi a0, a0, 1       # next word: + 1
        addi t0, t0, -1
        bnez t0, loop
        sw   a1, -3(x0)      # OUT</pre>`,
    },
    mistakes: [
      'Reading <code>sw a0, 4(a1)</code> as "store a1": the register outside the parentheses is the data, the one inside the base.',
      'Advancing a pointer by 2 or 4: RV16 addresses words.',
      'Using a loaded value in the very next instruction on the pipeline: correct, at the cost of one stall cycle (load-use).',
    ],
    anatomy: ['alu', 'dmem', 'mmio'],
    chapters: [{ chapter: 'cpu', step: 2, label: 'Loads and stores' }],
  },

  callconv: {
    idea: `A calling convention lets separately written functions call each other: where arguments and results go, which registers a call may change, and who saves the rest. RV16's: arguments in a0–a2, result in a0, return address in ra (written by <code>call f</code> = <code>jal ra, f</code>), stack pointer sp. As in RISC-V the a and t registers are caller-saved, and RV16 has no others: a call may change a0–a2 and t0–t1, so a caller that needs a value afterwards keeps it on the stack, and the callee only has to return with sp as it found it.<br>A function that makes a call overwrites ra, so it saves ra on entry and restores it before <code>ret</code> (<code>jalr x0, 0(ra)</code>). A leaf function, one that calls nothing, needs no stack at all.`,
    example: {
      title: 'Who keeps what across a call',
      body: `<pre>reg     name    role                  kept across a call
x0      zero    constant 0            –
x1      ra      return address        no (call writes it)
x2      sp      stack pointer         yes
x3–x5   a0–a2   arguments, a0 result  no
x6–x7   t0–t1   temporaries           no</pre>`,
    },
    mistakes: [
      'Calling from a function without saving ra: its own <code>ret</code> then returns to just after the inner call, forever.',
      'Keeping a value in t0 or a1 across a call: the callee may use them freely.',
      'Returning with sp changed: the caller\'s saved words are then read from the wrong addresses.',
    ],
    anatomy: ['rf', 'npc'],
    chapters: [{ chapter: 'cpu', step: 3, label: 'Branches and jumps' }],
  },

  stack: {
    idea: `The stack is the region of data memory below sp, used last-in first-out: a function claims words on entry by decrementing sp and returns them before it returns, so nested and recursive calls each get their own frame. RV16 has no stack instructions: <code>push r</code> expands to <code>addi sp, sp, -1</code>; <code>sw r, 0(sp)</code> and <code>pop r</code> to <code>lw r, 0(sp)</code>; <code>addi sp, sp, 1</code>, so sp always points at the last word pushed. A frame holds what must survive a call: ra in any function that calls, and values the caller needs afterwards.<br>Each push or pop is two instructions, so a larger frame is better allocated once (addi sp, sp, −k) and addressed as 0(sp) … (k − 1)(sp).`,
    example: {
      title: 'Recursive sum(4)',
      body: `<pre>        li   sp, 0x100
        li   a0, 4
        call sum
        sw   a0, -3(x0)       # OUT ← 10
        halt
sum:    beqz a0, base         # sum(n) = n + sum(n − 1)
        push ra               # sum calls: save ra
        push a0               # and n, needed after the call
        addi a0, a0, -1
        call sum
        pop  a1
        add  a0, a0, a1
        pop  ra
        ret
base:   ret</pre>59 instructions on the golden model; sp goes from 0x100 down to 0xF8: four frames of two words.`,
    },
    mistakes: [
      'Leaving sp at 0: the first push decrements it to 0xFFFF, which is EXIT, and the program stops with the pushed value as its exit code.',
      'Popping in the order pushed: the last word pushed comes off first, or ra and the saved value swap.',
      'Returning with sp unbalanced: every caller up the chain then finds its frame shifted.',
    ],
    anatomy: ['dmem', 'rf'],
    chapters: [{ chapter: 'memory', step: 7, label: 'Stack' }],
  },

  mmio: {
    idea: `Memory-mapped I/O puts device registers in the data address space, so lw and sw reach devices with no new instructions. An address decoder in front of the data memory sends each access to the RAM or to a device: in RV16 the top seven addresses, 0xFFF9–0xFFFF, are devices, the two below them are reserved, and everything below those is RAM. A load from a device returns its state (the switches, the LEDs, the next input number); a store makes it act (set the LEDs, print a character, raise the interrupt line, stop the program).<br>Because offsets are sign-extended and x0 = 0, every device is one instruction away as <code>imm(x0)</code> with imm from −1 to −7. Device accesses have side effects, so they must reach the device every time: never cached, never merged or reordered.`,
    example: {
      title: 'The device map, and an echo loop',
      body: `<pre>0xFFFF  -1(x0)  EXIT       store: stop, value = exit code
0xFFFE  -2(x0)  CONSOLE    store: print a character
0xFFFD  -3(x0)  OUT        store: append a number to the output
0xFFFC  -4(x0)  IN         load: next input number (0 when empty)
0xFFFB  -5(x0)  LEDS       store, load
0xFFFA  -6(x0)  SWITCHES   load
0xFFF9  -7(x0)  IRQ        store 1 / 0: raise / lower the interrupt line
0xFFF8, 0xFFF7           reserved: read 0, stores dropped

echo:   lw   a0, -6(x0)    # 0xE836
        sw   a0, -5(x0)    # 0xEC3E
        j    echo</pre>`,
    },
    mistakes: [
      'Reading IN twice to look at one value: each load consumes the next number.',
      'Putting a cache in front of the device addresses: a cached SWITCHES read never sees the switches move; MMIO must bypass it.',
      'Leaving IRQ raised in the interrupt handler: after mret the interrupt is taken again at once; acknowledge with <code>sw x0, -7(x0)</code>.',
    ],
    anatomy: ['mmio', 'dmem'],
    chapters: [{ chapter: 'io', step: 4, label: 'Switches in, LEDs out' }, { chapter: 'io', step: 3, label: 'The complete machine' }],
  },

  // ---- the CPU
  datapath: {
    idea: `The datapath is the part of the CPU that holds and moves data: PC, instruction memory, register file, immediate generator, ALU, branch comparator, data memory, and the multiplexers that choose each block's inputs. Every instruction uses the same blocks; only the mux selects and the write enables differ, and those come from the control unit. Designing a datapath means walking the instruction set one instruction at a time and adding a path, and a mux input, for whatever the existing paths cannot do.<br>Multiplexers are most of the cost. In <code>rv16_cpu</code> 705 bits of two-input mux make 2,760 of its 5,236 NANDs: 336 in the register file's read ports and write enables, 208 in the ALU's operation select, and the rest in the result, immediate, operand and PC selects.`,
    example: {
      title: 'Settings per instruction (– = don\'t care)',
      body: `<pre>instr  rwe  ALU b  imm  result   mwe  next PC
add     1   rs2    –    ALU       0   pc + 1
addi    1   imm    I    ALU       0   pc + 1
lw      1   imm    I    memory    0   pc + 1
sw      0   imm    S    –         1   pc + 1
beq     0   –      B    –         0   taken ? pc + imm : pc + 1
jal     1   –      J    pc + 1    0   pc + imm
jalr    1   –      I    pc + 1    0   rs1 + imm
lui     1   –      U    imm       0   pc + 1</pre>`,
    },
    mistakes: [
      'Adding a block per instruction: lw, sw and addi share the ALU\'s adder for rs1 + imm; only the result select and the write enables differ.',
      'Leaving rwe = 1 on a store or branch: it writes the register named by the immediate bits in the rd field.',
      'Driving a select with X where it matters: a don\'t-care is fine for an instruction that ignores the signal, never for one that uses it (the result select of a load).',
    ],
    lib: 'rv16_cpu',
    anatomy: ['pc', 'imem', 'rf', 'imm', 'alu', 'br', 'dmem', 'wb', 'npc'],
    chapters: [{ chapter: 'cpu', step: 0, label: 'The datapath' }, { chapter: 'cpu', step: 1, label: 'ALU instructions' }],
  },

  singlecycle: {
    idea: `A single-cycle CPU executes each instruction completely between two clock edges: fetch, decode, execute, memory and write back form one combinational path from the PC back to the PC and the register file. CPI is exactly 1, and control is a pure function of the instruction with no state machine, which makes it the simplest correct implementation and the reference the others are compared with. The price is the period: every instruction gets the time of the slowest one, a load, whose path passes through both memories and the ALU.<br><code>rv16_cpu</code> (5,236 NANDs) has a period of 98 NAND delays with 8-delay memories, and a jal, which needs neither the ALU nor the data memory, gets the same 98. Any long unit on the path stretches every cycle.`,
    example: {
      title: 'One unit sets everyone\'s period',
      body: `<pre>rv16_cpu                      5,236 NANDs   period  98
  with Kogge–Stone adders     5,898 NANDs   period  76   (−22% time, +13% NANDs)
  with the array multiplier   8,553 NANDs   period 191   (paid by every instruction)</pre>`,
    },
    mistakes: [
      'Timing the add path and calling it the clock: the period is set by the worst instruction, here a load.',
      'Building it with one memory: a load needs the instruction and the data in the same cycle.',
      'Putting a slow, rare unit on the path: a combinational multiplier doubles every cycle; the divider instead holds the PC for 18 cycles (<code>rv16_cpu_md</code>).',
    ],
    lib: 'rv16_cpu',
    compare: ['rv16_cpu_ks'],
    chapters: [
      { chapter: 'cpu', step: 0, label: 'The datapath' },
      { chapter: 'cpu', step: 4, label: 'Run real programs' },
      { chapter: 'fastadd', step: 9, label: 'Swap in fast adders' },
    ],
  },

  criticalpath: {
    idea: `The critical path is the longest register-to-register path; its delay plus clk-to-q and setup is the minimum clock period. Static timing finds it without simulating: it computes, for every net, the latest arrival over all paths from the launching flip-flops, so it covers every input at once (and may include false paths no input can exercise). Only that path matters for the period: speeding up anything else changes nothing, and once it is shortened the next-longest path takes over.<br>The site's static timing reports the path block by block. On <code>rv16_cpu</code> it is a load: PC → ROM → control → immediate mux → ALU → data RAM → result mux → register file, 98 delays, half of them in the ripple-carry ALU.`,
    example: {
      title: 'Shorten one path, meet the next',
      body: `<pre>rv16_cpu, period 98:
  PC 3 → ROM 8 → control 13 → imm mux 5 → ALU-b mux 2
  → ALU 50 → RAM 8 → result mux 4 → register file 2 → setup 3
Kogge–Stone adders, period 76: the load path still sets it
  PC 3 → ROM 8 → control 13 → imm mux 5 → ALU-b mux 2
  → ALU 28 → RAM 8 → result mux 4 → register file 2 → setup 3
and the branch path is now two delays behind (74):
  PC 3 → ROM 8 → register read 7 → branch comparator 44
  → next PC 4 → PC muxes 5 → setup 3</pre>The comparator's less-than still waits for a ripple carry chain (<code>rv16_cmp16</code>, depth 39; 44 with the condition logic).`,
    },
    mistakes: [
      'Optimising the block that looks slow in isolation: once the ALU has a fast adder, the branch comparator is within two delays of setting the period, and speeding up the ALU further buys almost nothing.',
      'Measuring delay by simulation only: a test that never exercises the longest carry chain shows less delay than the chip must allow.',
      'Forgetting memories and register overhead: the ALU\'s 50 delays are about half of the 98.',
    ],
    anatomy: ['alu', 'br'],
    chapters: [
      { chapter: 'fastadd', step: 7, label: 'Static timing on our CPU' },
      { chapter: 'fastadd', step: 9, label: 'Swap in fast adders' },
      { chapter: 'fastadd', step: 4, label: 'Carry-skip, and a false path' },
    ],
  },

  pipeline: {
    idea: `Pipelining cuts the single-cycle path with registers so that each piece, a stage, takes one cycle and works on a different instruction: five are in flight, in F, D, E, M and W. Throughput rises to one instruction per (shorter) cycle; the latency of one instruction grows slightly, five cycles plus register overhead. The ideal period is the single-cycle path ÷ 5 + clk-to-q + setup, reached only if the stages are balanced and nothing stalls.<br>The RV16 pipeline shows both limits. Its period is 78 NAND delays against the single-cycle core's 98, because E holds the forwarding logic, the operand muxes and the ripple ALU in one stage (13 + 3 + 2 + 50 delays), and the branch path through the ripple comparator and the PC redirect is only one delay shorter. And each taken branch costs 2 cycles. Measured on the core tests, the plain pipeline is only 4% faster than the single-cycle core (116,610 against 121,128 NAND delays): its CPI eats most of the 20% the period gained, and on the nested loops below it is slower. With static branch prediction it is 12% faster there. The rest of the gain has to come from balancing E: a faster ALU and comparator, an earlier branch decision.`,
    example: {
      title: 'Five in flight, and the measured cost',
      body: `<pre>cycle    1  2  3  4  5  6  7  8  9
add      F  D  E  M  W
sub         F  D  E  M  W
lw             F  D  E  M  W
or                F  D  E  M  W
sw                   F  D  E  M  W

nested loops (334 instructions)   cycles  period    time
single-cycle                        333      98    32,634
pipeline                            534      78    41,652
pipeline + static prediction        358      80    28,640</pre>534 = 333 + 3 (fill) + 2 × 99 taken branches.`,
    },
    mistakes: [
      'Expecting 5× from 5 stages: unbalanced stages and register overhead (6 delays per stage here) eat most of it, and hazards add cycles.',
      'Judging by the period alone: on nested loops the pipeline\'s CPI of 1.6 (534 / 333) more than cancels its 20% shorter period.',
      'Forgetting what the stage registers carry: everything later stages need, so the RV16 pipeline has 368 flip-flops against the single-cycle core\'s 128.',
    ],
    anatomy: ['p1', 'p2', 'p3', 'p4'],
    chapters: [
      { chapter: 'pipeline', step: 0, label: 'Overlap the work' },
      { chapter: 'pipeline', step: 1, label: 'Pipeline registers' },
      { chapter: 'pipeline', step: 5, label: 'Does it pay? Measured' },
    ],
  },

  hazards: {
    idea: `A hazard is a case where overlapping instructions would compute something different from running them one at a time. Data (read after write): an instruction reads a register that an older one, still in E, M or W, has not written yet. The RV16 pipeline writes its register file at the falling edge, so a reader three instructions behind sees the new value; distances 1 and 2 need forwarding, and a load at distance 1 needs a stall as well. Control: the next PC depends on a branch that resolves in E, after two younger instructions were fetched. Structural: two stages need one resource in the same cycle; RV16 has none, with separate instruction and data memories and a register file with two read ports and its write in the other half cycle.<br>Write after read and write after write cannot happen in an in-order five-stage pipeline: every instruction reads in D and writes in W, in program order.`,
    example: {
      title: 'Dependences by distance',
      body: `<pre>add  a0, a1, a2    F D E M W
sub  t0, a0, a1      F D E M W         a0 at distance 1: from M
or   t1, a0, t0        F D E M W       a0 at 2: from W; t0 at 1: from M
and  a2, a0, t1          F D E M W     a0 at 3: from the register file
lw   a1, 0(a2)             F D E M W
add  a0, a1, a1              F D D E M W   load at distance 1: one stall</pre>`,
    },
    mistakes: [
      'Forgetting x0: an instruction "writing" x0 must not forward or stall anything.',
      'Comparing rd without checking that the instruction writes: S and B formats carry immediate bits in the rd field.',
      'Forgetting distance 3: without a register file that writes before it reads in the same cycle, the third instruction is a hazard too.',
    ],
    anatomy: ['fwd', 'haz'],
    chapters: [
      { chapter: 'pipeline', step: 2, label: 'Data hazards and forwarding' },
      { chapter: 'pipeline', step: 3, label: 'The load-use stall' },
      { chapter: 'pipeline', step: 4, label: 'Control hazards' },
    ],
  },

  loaduse: {
    idea: `A load's value exists at the end of M, one cycle later than an ALU result. The instruction right behind the load needs it at the start of its E, the same moment, so forwarding cannot help: no wire runs back in time. The hardware detects the case in D (the instruction in E is a load whose rd, not x0, equals rs1 or rs2 of the instruction in D), holds F and D for one cycle and sends a bubble into E; a cycle later the load is in W and its value is forwarded from there.<br>RV16's hazard unit is 53 NANDs, depth 12. It compares rs2 even for formats without one, so some of its stalls are unnecessary but none is missing. The cost is one cycle per load used at once; the software fix is to schedule an independent instruction between the load and its use.`,
    example: {
      title: 'One stall, and how to remove it',
      body: `<pre>cycle           1  2  3  4  5  6  7
lw   a0, 0(x0)  F  D  E  M  W
add  a2, a0, a0    F  D  D  E  M  W      a0 forwarded from W
addi t0, t1, 1        F  F  D  E  M  W</pre>Measured on an 8-instruction program: 11 cycles; with the addi moved between the lw and the add, 10 cycles and the same results.`,
    },
    mistakes: [
      'Holding D without a bubble into E: the held instruction is then also in E and executes twice.',
      'Holding E as well: the load has to move on to M, or the stall never ends.',
      'Stalling for <code>lw x0, …</code>: its result is discarded, so nothing waits for it (the unit checks rd ≠ 0).',
    ],
    lib: 'rv16_haz',
    anatomy: ['haz', 'p1', 'p2'],
    chapters: [{ chapter: 'pipeline', step: 3, label: 'The load-use stall' }],
  },

  stall: {
    idea: `A stall keeps an instruction where it is for a cycle. The PC and the F/D register are not loaded (their enable is 0), so F fetches the same word again and D decodes the same instruction again, while D/E is cleared so that E receives a bubble, an instruction that writes nothing. The older instructions in E, M and W keep moving, which is what resolves the hazard. Each stall cycle adds one to the cycle count and nothing to the work done.<br>RV16's pipeline register provides both controls: q ← clr ? 0 : en ? d : q. en = 0 holds (a stall), clr = 1 loads zero (a bubble or a flush), and all-zero control bits mean no register write, no store, no branch. When a stall and a flush come in the same cycle the flush wins: the instruction being held is younger than the branch, so it was on the wrong path.`,
    example: {
      title: 'One pipeline register under each control',
      body: `<pre>              en  clr   next q
advance        1   0    d
stall          0   0    q        hold
bubble/flush   –   1    0        nothing happens in the next stage
load-use stall: PC en = 0, F/D en = 0, D/E clr = 1</pre><code>rv16_preg</code> is 260 NANDs per 16 bits: the register with its enable muxes (208), the clear mux (49) and an OR of en and clr (3).`,
    },
    mistakes: [
      'Clearing F/D on a stall: the instruction waiting in D is lost.',
      'Freezing the whole pipeline: a load-use stall holds F and D only; if E is held too, the load never reaches M.',
      'Letting a stall override a flush: the held instruction may be on the wrong path and must disappear.',
    ],
    lib: 'rv16_preg',
    anatomy: ['p1', 'p2', 'haz', 'pc'],
    chapters: [{ chapter: 'pipeline', step: 3, label: 'The load-use stall' }],
  },

  flush: {
    idea: `A flush cancels instructions fetched on a wrong guess. In the RV16 pipeline a branch or jump resolves in E; by then the next two words (pc + 1 in D, pc + 2 in F) are already in the pipeline. When the branch is taken, the PC is loaded with the target and F/D and D/E are cleared at the same edge, so those two become bubbles with zero control bits. Nothing they did is visible, because no instruction changes state before M.<br>The cost is 2 cycles per taken branch or jump, which makes branches the pipeline's largest expense: on the nested-loop program 99 taken branches add 198 cycles to 336. With traps, flushes also empty the pipeline behind a trapping instruction, and the bubbles carry a valid bit of 0, because an all-zero word is an illegal instruction.`,
    example: {
      title: 'A taken branch in E',
      body: `<pre>cycle           1  2  3  4  5  6  7
beq (taken)     F  D  E  M  W
pc + 1             F  D  ×              flushed
pc + 2                F  ×              flushed
target                   F  D  E  M  W</pre>gcd (51 instructions): 50 cycles single-cycle, 83 pipelined = 50 + 3 fill + 2 × 15 taken branches and jumps.`,
    },
    mistakes: [
      'Flushing the branch itself: it is in E and must complete (jal and jalr still write rd).',
      'Clearing only the instruction word: a bubble needs zero control bits, and with traps a valid bit, since 0x0000 decodes as illegal.',
      'Forgetting jumps: jal and jalr also resolve in E here and cost the same 2 cycles.',
    ],
    anatomy: ['p1', 'p2', 'npc', 'br'],
    chapters: [{ chapter: 'pipeline', step: 4, label: 'Control hazards' }],
  },

  controlhazard: {
    idea: `Fetch needs a new PC every cycle, but a branch's outcome and target are known only when it executes, so whatever the pipeline fetches meanwhile is a bet. Stalling fetch until every branch resolves loses cycles on all branches, taken or not. Predicting not taken and flushing when wrong costs 2 cycles per taken branch in RV16 and nothing otherwise (the baseline pipeline). Resolving in D with a dedicated comparator cuts the loss to 1 cycle, but lengthens D and needs operands forwarded into D. Predicting means guessing at fetch and computing the target there, paying only for wrong guesses.<br>RV16's static predictor guesses jal and backward branches (negative offset: loops) taken, with pc + imm computed in F by a second adder. It costs 571 NANDs and 2 delays of period (78 → 80).`,
    example: {
      title: 'Nested loops: 99 of 110 branches taken',
      body: `<pre>inner bnez: taken 9 times in 10, 100 executions
outer bnez: taken 9 times in 10, 10 executions
predict not taken:      2 × 99 = 198 lost cycles  → 534 cycles
predict backward taken: wrong at the 10 inner exits and the outer
                        exit, 2 × 11 = 22 lost cycles → 358 cycles</pre>`,
    },
    mistakes: [
      'Counting only conditional branches: j, call and ret also redirect fetch; jal can be predicted statically, jalr (ret) depends on a register.',
      'Predicting forward branches taken: an if-then\'s forward branch goes either way; backward-taken works because loops repeat.',
      'Ignoring the predictor\'s own delay: its adder and mux in F lengthen every cycle, here by 3 delays.',
    ],
    anatomy: ['npc', 'br', 'p1'],
    chapters: [
      { chapter: 'pipeline', step: 4, label: 'Control hazards' },
      { chapter: 'pipepay', step: 1, label: 'A comparator for branches' },
      { chapter: 'pipepay', step: 2, label: 'Predicting branches' },
      { chapter: 'pipepay', step: 3, label: 'Two bits of history' },
    ],
  },

  // ---- system
  traps: {
    idea: `A trap transfers control to a handler without a branch in the program. On an exception (ecall, ebreak, an illegal instruction) or an interrupt the CPU saves the PC in mepc and the reason in mcause, copies mstatus.MIE into MPIE and clears MIE (so the handler is not interrupted), and jumps to mtvec. mret reverses it: pc ← mepc, MIE ← MPIE. The handler runs with the program's registers, so it saves what it uses; mscratch can hold a pointer to a save area.<br>For an exception mepc is the trapping instruction itself, so a handler that continues after an ecall adds 1 to mepc before mret. RV16's mcause values: 2 illegal instruction, 3 breakpoint, 11 ecall, 0x800B external (bit 15 marks an interrupt). Adding traps to the single-cycle core (CSR file, illegal-instruction detector, system decode) takes it from 5,236 to 7,972 NANDs.`,
    example: {
      title: 'An ecall at 0x0010, handled and resumed',
      body: `<pre>before: pc = 0x0010 (ecall), mstatus.MIE = 1, mtvec = h
trap:   mepc ← 0x0010, mcause ← 11, MPIE ← 1, MIE ← 0, pc ← h
h:      csrr t1, mepc
        addi t1, t1, 1         # skip the ecall
        csrw mepc, t1
        mret                   # pc ← 0x0011, MIE ← 1</pre>`,
    },
    mistakes: [
      'Returning to mepc unchanged after an ecall: the ecall runs again, forever.',
      'Leaving mtvec at 0: the first trap restarts the program at address 0.',
      'Clobbering registers in the handler: the interrupted code expects every register unchanged; push what you use.',
    ],
    lib: 'rv16_csr',
    anatomy: ['csr', 'npc'],
    chapters: [
      { chapter: 'traps', step: 0, label: 'Control and status registers' },
      { chapter: 'traps', step: 1, label: 'ecall: asking the operating system' },
      { chapter: 'traps', step: 2, label: 'Exceptions' },
      { chapter: 'traps', step: 5, label: 'Inside the trap unit' },
    ],
  },

  interrupts: {
    idea: `An interrupt is a trap caused by the outside world: a device raises a line, and if interrupts are enabled the CPU traps between two instructions. Enabling has two levels: the source's bit in mie (MEIE, bit 11, for the external line; full RISC-V adds MTIE and MSIE for timer and software interrupts) and the global mstatus.MIE (bit 3). The trap clears MIE, so the handler runs uninterrupted until mret restores it.<br>mepc is the next instruction that has not run, so mret resumes it with no adjustment. The handler must clear the cause at the device before returning (in RV16, a store of 0 to IRQ at 0xFFF9), or the interrupt is still pending and is taken again immediately. RV16 has that one source, the external line (intr = MIE · MEIE · irq), in the hardware cores and the golden model alike: no timer.`,
    example: {
      title: 'Enable, take, acknowledge',
      body: `<pre>        la   t0, handler
        csrw mtvec, t0
        li   t0, 0x800         # MEIE (mie bit 11)
        csrw mie, t0
        li   t0, 8             # MIE (mstatus bit 3)
        csrs mstatus, t0
        …                      # a store of 1 to IRQ (-7(x0)) raises the line
handler:
        push t0
        csrr t0, mcause        # 0x800B: external
        sw   x0, -7(x0)        # acknowledge: lower the line
        pop  t0
        mret                   # resume the interrupted instruction</pre>`,
    },
    mistakes: [
      'Not acknowledging the device: mret re-enables MIE with the line still high, and the handler runs again forever.',
      'Adding 1 to mepc as after an ecall: the interrupted instruction has not executed and would be skipped.',
      'Setting mstatus.MIE before mtvec: an interrupt arriving in between jumps to address 0.',
    ],
    anatomy: ['csr', 'mmio'],
    chapters: [{ chapter: 'traps', step: 3, label: 'The timer interrupt' }, { chapter: 'traps', step: 4, label: 'External interrupts' }],
  },

  precise: {
    idea: `A trap is precise when it leaves the state of a sequential machine stopped exactly at the trapping instruction: every older instruction has completed, the trapping one and all younger ones have changed nothing, and mepc names the trapping one. The handler can then fix the cause and resume, or report the exact instruction. A single-cycle CPU is precise by construction; in a pipeline, when a trap is detected, older instructions are still in M and W and younger ones in D and F.<br>The RV16 pipeline takes every trap in E. The instruction in E is suppressed (its register write and store are gated off), the older ones in M and W complete normally, the two younger ones are flushed, the PC goes to mtvec and mepc ← the PC of the instruction in E. E is late enough because nothing in RV16 can fault after E: loads and stores never trap. An interrupt is attached to the instruction in E only when that instruction is valid, so a bubble never becomes the return address.`,
    example: {
      title: 'An illegal word reaches E',
      body: `<pre>        F       D       E                 M          W
now:    y       x       .word 0x0000      lw a0      add t0
        flush   flush   trap: no write    completes  completes
next:   pc ← mtvec, mepc ← pc of the illegal word, mcause ← 2</pre>`,
    },
    mistakes: [
      'Letting the trapping instruction write back: its result is not part of the state at the trap.',
      'Taking traps late, in W, without stopping younger instructions: a younger store in M has already written memory.',
      'Taking an interrupt on a bubble: mepc would be the bubble\'s PC; RV16 gates the interrupt with E\'s valid bit.',
    ],
    anatomy: ['csr', 'p2', 'p3'],
    chapters: [{ chapter: 'traps', step: 2, label: 'Exceptions' }],
  },

  // ---- side quests
  mext: {
    idea: `M adds multiply and divide on the MD opcode (op 3), with f3 selecting the operation: 0 mul (low 16 bits), 1 mulh (high 16, signed × signed), 2 mulhsu (signed × unsigned), 3 mulhu (unsigned × unsigned), 4 div, 5 divu, 6 rem, 7 remu. Division truncates toward zero and the remainder takes the dividend's sign. Nothing traps: x ÷ 0 gives a quotient of all ones and a remainder of x; the one signed overflow, −32,768 ÷ −1, gives −32,768 with remainder 0.<br>A full 32-bit product takes two instructions, mulh (or mulhu) and mul on the same operands. In hardware the multiplier is combinational and the divider iterative: the 16 × 16 array multiplier with signed corrections is 3,257 NANDs, depth 166, which raises a single-cycle core's period from 98 to 191 for every instruction; the divider takes 18 cycles and holds the PC meanwhile.`,
    example: {
      title: 'Results from the golden model',
      body: `<pre>a = −1 (0xFFFF), b = 3:
  mul 0xFFFD (−3)    mulh 0xFFFF    mulhsu 0xFFFF    mulhu 0x0002
a = b = 0x8000:
  mul 0x0000         mulh 0x4000    mulhu 0x4000
−7 ÷ 2:          div 0xFFFD (−3)    rem 0xFFFF (−1)
0x8000 ÷ 0:      div 0xFFFF         rem 0x8000
0x8000 ÷ −1:     div 0x8000         rem 0x0000</pre>`,
    },
    mistakes: [
      'Using mulhu on signed operands: −1 × 3 gives a high half of 0x0002, where the signed answer is 0xFFFF.',
      'Expecting floor division: −7 ÷ 2 is −3 remainder −1 in RV16 (floor would give −4 remainder 1).',
      'Waiting for a divide-by-zero trap: there is none; test the divisor first.',
    ],
    anatomy: ['alu', 'wb'],
    chapters: [
      { chapter: 'muldiv', step: 21, label: 'The M unit' },
      { chapter: 'muldiv', step: 22, label: 'RV32IM' },
      { chapter: 'muldiv', step: 23, label: 'What it costs a program' },
    ],
  },

  ieee754: {
    idea: `A float is sign × significand × 2^exponent with the significand normalised to 1.f, so the leading 1 is implicit and every stored fraction bit is precision. binary16 packs a sign bit, a 5-bit exponent with bias 15 and a 10-bit fraction: value = (−1)^s × 1.f × 2^(e − 15) for e = 1 … 30. e = 0 encodes zero and the subnormals, e = 31 infinity (f = 0) and NaN (f ≠ 0). Magnitudes run from 2^−24 to 65,504 with 11 significant bits, so integers are exact up to 2,048.<br>The encoding is ordered: for non-negative values a larger bit pattern is a larger number, so comparison is nearly integer comparison. Spacing is constant within a binade (2^−10 of its lower end), so the absolute error grows with magnitude while the relative error stays bounded.`,
    example: {
      title: 'binary16 encodings',
      body: `<pre>1.0        0 01111 0000000000   0x3C00
1.5        0 01111 1000000000   0x3E00
−2.0       1 10000 0000000000   0xC000
65,504     0 11110 1111111111   0x7BFF   largest finite
2^−14      0 00001 0000000000   0x0400   smallest normal
2^−24      0 00000 0000000001   0x0001   smallest subnormal
+∞         0 11111 0000000000   0x7C00
2,049 → 2,048 (0x6800): above 2,048 the spacing is 2
0.1 + 0.2 = 0x34CC, while 0.3 = 0x34CD</pre>`,
    },
    mistakes: [
      'Comparing floats for equality after arithmetic: 0.1 + 0.2 and 0.3 differ in the last bit, in binary16 as in binary64.',
      'Forgetting the bias: the exponent field 01111 means 2^0.',
      'Storing integers above 2,048 in binary16 and expecting them back: 2,049 becomes 2,048.',
    ],
    lib: 'fpun5_10',
    chapters: [
      { chapter: 'float', step: 0, label: 'Scientific notation in binary' },
      { chapter: 'float', step: 1, label: 'Where the floats are' },
      { chapter: 'float', step: 2, label: 'Unpack' },
    ],
  },

  rounding: {
    idea: `IEEE 754 defines every operation as computed exactly, then rounded once to the format. The hardware does not need the exact result: after alignment and normalisation it keeps the significand plus two facts about what is dropped, the guard bit G (the first dropped bit) and the sticky bit S (the OR of all the rest). With the last kept bit (lsb) these decide every mode: G·S is more than half an ulp, G·¬S exactly half (a tie), ¬G less than half.<br>Round to nearest, ties to even (RNE, the default) sends a tie to the neighbour whose lsb is 0, so ties go up and down equally often and repeated rounding does not drift. Rounding up can carry out of the significand (1.11…1 + 1 ulp = 10.00…0): renormalise and increment the exponent, which may overflow to infinity. The decision itself is small: 62 NANDs, depth 13, for all five modes.`,
    example: {
      title: 'Two ties in binary16',
      body: `<pre>1 + 2^−11   = 1.0000000000|1 000…   lsb 0, G 1, S 0: a tie
   RNE → 0x3C00 (1.0, even)    RUP → 0x3C01    RTZ → 0x3C00
1 + 3·2^−11 = 1.0000000001|1 000…   lsb 1, G 1, S 0: a tie
   RNE → 0x3C02 (up, to even)  RTZ → 0x3C01    RDN → 0x3C01
both inexact: NX is set</pre>`,
    },
    mistakes: [
      'Rounding on G alone: G = 1 with S = 0 is a tie and needs lsb; G = 1 with S = 1 always rounds up in RNE.',
      'Dropping the sticky bit during alignment: bits shifted off the right must be ORed into S, or a just-above-half case rounds as a tie.',
      'Ignoring the carry out of rounding: 1.111…1 rounded up is 10.000…0, and the exponent must increase, possibly to ∞.',
    ],
    lib: 'fpround',
    chapters: [
      { chapter: 'float', step: 4, label: 'Round to nearest, ties to even' },
      { chapter: 'float', step: 5, label: 'Five rounding modes' },
      { chapter: 'float', step: 19, label: 'Rounding surprises' },
    ],
  },

  subnormal: {
    idea: `Without subnormals, binary16 would jump from its smallest normal number, 2^−14, straight to 0. Subnormals fill the gap: with exponent field 0 the hidden bit is 0 and the exponent counts as 1, so the values 0.f × 2^−14 are spaced 2^−24 apart, the same spacing as the lowest binade of normals. The property that matters: x − y = 0 only when x = y (gradual underflow), which flush-to-zero hardware gives up.<br>The cost is in normalisation and rounding: a subnormal input has leading zeros that the leading-zero counter must find, and a result below 2^−14 must be shifted right and rounded, losing precision a bit at a time. The unpacker hides the encoding difference: exp = field OR (field = 0), significand = {field ≠ 0, f}.`,
    example: {
      title: 'Around 2^−14',
      body: `<pre>0x0401 − 0x0400 = 0x0001    2^−24, exact
    flush-to-zero would return 0 for two different numbers
0x0400 × 0.5    = 0x0200    2^−15, a subnormal, exact
0x0001 × 0.5    = 0x0000    2^−25 is a tie, rounds to even 0: UF, NX
largest subnormal 0x03FF = 1023 × 2^−24</pre>`,
    },
    mistakes: [
      'Reading exponent field 0 as 2^−15 (0 − bias): subnormals use 2^−14 with a hidden 0, or there is a gap below 2^−14.',
      'Raising UF for every tiny result: underflow needs tiny and inexact; 0x0400 × 0.5 is exact and raises nothing.',
      'Normalising a tiny result fully: it would need an exponent below the format\'s minimum; it stays subnormal with leading zeros.',
    ],
    lib: 'fpun5_10',
    chapters: [
      { chapter: 'float', step: 1, label: 'Where the floats are' },
      { chapter: 'float', step: 2, label: 'Unpack' },
      { chapter: 'float', step: 6, label: 'Exception flags' },
    ],
  },

  multicycle: {
    idea: `A multicycle CPU spends several short cycles per instruction, one per step, with registers between the steps (an instruction register, an ALU-output register) and a state machine sequencing them. The period shrinks to the slowest step, and CPI rises to the number of steps each instruction needs. It pays when steps share hardware (one memory for instructions and data, one ALU for pc + 1, addresses and arithmetic) and when instructions differ in length, so short ones finish early.<br><code>rv16_mc</code> takes 3 cycles per instruction (4 for lw and sw) under a one-hot state machine. It shares nothing (two memories, its own adders), and its E step still holds control, the immediate select and the ripple ALU, so the period only falls from 98 to 76 while CPI triples: 3 × 76 = 228 delays per instruction against 98. Microcode stores the state machine's table in a ROM instead: each word holds the control signals and the next state.`,
    example: {
      title: 'rv16_mc against rv16_cpu',
      body: `<pre>program                    cycles   CPI   period     time
nested loops   multicycle     999   3.00     76    75,924
               single-cycle   333   1.00     98    32,634
bubble sort    multicycle     777   3.38     76    59,052
               single-cycle   230   1.00     98    22,540</pre>`,
    },
    mistakes: [
      'Cutting the path where it is convenient: here E holds 70 of the 76 delays while F and M hold one memory read each; unbalanced steps waste the short ones.',
      'Expecting the period to shrink by the number of steps: register overhead (clk-to-q + setup = 6) is paid in every step.',
      'Keeping separate memories and adders: without sharing, the multicycle core is bigger than the single-cycle one (5,719 against 5,236 NANDs) and slower.',
    ],
    lib: 'rv16_mc',
    chapters: [
      { chapter: 'multicycle', step: 0, label: 'Several short cycles' },
      { chapter: 'multicycle', step: 3, label: 'Microcode' },
      { chapter: 'multicycle', step: 5, label: 'Was it worth it?' },
    ],
  },

  // ---- tricks
  bubble: {
    idea: `Bubble pushing applies De Morgan on the drawing. An AND with an inverted output equals an OR with inverted inputs, and an OR with an inverted output equals an AND with inverted inputs, so an inversion slides through a gate if the gate flips AND ↔ OR, and two inversions on one wire cancel. In AND–OR logic the inverters that turn NANDs into ANDs and the inverters that turn a NAND into an OR meet on the same wires and cancel, leaving NAND–NAND: the same function with fewer gates and less depth.<br>The method is local and mechanical: insert a pair of bubbles on a wire (free, they cancel), push one each way, and repeat until every gate is a NAND and every remaining bubble sits on an input literal.`,
    example: {
      title: 'The 2:1 multiplexer',
      body: `<pre>y = s·b + ¬s·a
AND–OR:    NOT s, two ANDs (2 NANDs each), one OR (3 NANDs)
           8 NANDs, depth 5
pushed:    each AND's output bubble meets an OR input bubble
           y = NAND(NAND(s, b), NAND(¬s, a))
           4 NANDs, depth 3: the library's mux2</pre>`,
    },
    mistakes: [
      'Moving a bubble through a gate without flipping its type: ¬(a·b) = ¬a + ¬b; writing ¬a · ¬b is wrong whenever a ≠ b.',
      'Pushing a bubble onto a wire that fans out: every gate on that net receives the inverted value, so the others need a compensating bubble.',
      'Leaving one bubble unpaired on an internal wire: that is a real inverter, a NAND and a delay.',
    ],
    lib: 'mux2',
    chapters: [{ chapter: 'gates', step: 2, label: 'OR: De Morgan\'s trick' }, { chapter: 'gates', step: 6, label: 'The multiplexer: a digital switch' }],
  },

  nandnand: {
    idea: `A sum of products f = p<sub>1</sub> + p<sub>2</sub> + … + p<sub>k</sub> equals ¬(¬p<sub>1</sub> · ¬p<sub>2</sub> · … · ¬p<sub>k</sub>) by De Morgan, and each ¬p<sub>i</sub> is a NAND of its literals. So any minimised SoP becomes one NAND per product term feeding one NAND: two levels, no OR gates, inverters only for complemented literals (shared between terms). It is the bubble-pushed form of AND–OR, and the structure a PLA implements.<br>With 2-input NANDs only, wide terms become small trees (a 3-input NAND is an AND and a NAND, 3 NANDs; the final k-input NAND likewise), so depth grows with log<sub>2</sub> of the fan-in. The saving over a literal AND–OR build remains, because each AND's inverter and the OR's input inverters disappear in pairs.`,
    example: {
      title: 'The 4-bit prime detector (2, 3, 5, 7, 11, 13)',
      body: `<pre>K-map → f = ¬a3·¬a2·a1 + ¬a3·a2·a0 + ¬a2·a1·a0 + a2·¬a1·a0
AND–OR:     3 NOT + 4 three-input ANDs (4 NANDs each) + OR4 (9)
            = 28 NANDs, depth 9
NAND–NAND:  3 NOT + 4 × (AND + NAND) + final NAND4 (AND, AND, NAND)
            = 3 + 12 + 5 = 20 NANDs, depth 7</pre>`,
    },
    mistakes: [
      'Forgetting a single-literal term\'s inverter: f = a + b·c is NAND(¬a, NAND(b, c)).',
      'Combining the NAND outputs with an OR: that computes ¬p<sub>1</sub> + ¬p<sub>2</sub>, a different function; the second level is a NAND.',
      'Skipping minimisation: NAND–NAND removes inverters, but the number of terms and literals comes from the K-map.',
    ],
    lib: 'rv16_prime4',
    chapters: [{ chapter: 'gates', step: 2, label: 'OR: De Morgan\'s trick' }, { chapter: 'memory', step: 5, label: 'The PLA' }],
  },

  dontcare: {
    idea: `A don't-care is an input combination whose output nobody observes, or that never occurs. Its value can be chosen group by group in a K-map: 1 where it makes a rectangle larger (fewer literals), 0 elsewhere. Control units are full of them, because most signals matter only for some instructions: the ALU's second operand is irrelevant for a branch (the branch comparator reads rs2 directly), a jal or a lui; the result select is irrelevant when nothing is written; the immediate select when no immediate is used.<br>Some signals have no don't-cares: register and memory write enables, branch and jump bits change state when wrong, so they must be exact for every opcode. The RV16 control specification records which instructions care about each signal, and its tests compare only those bits.`,
    example: {
      title: 'ALU operand select (bimm) in RV16',
      body: `<pre>op     0  1  2  3  4  5  6  7  8  9 10 11 12 13 14 15
bimm   –  0  0  –  1  1  1  –  –  –  –  –  –  –  1  –
cares: OP, OPX (rs2 → 0); ADDI, SHI, LW, SW (imm → 1)
exact, from the decoded opcode: y4 + y5 + y6 + y14   an OR4, 9 NANDs
don't-cares taken as 1:         op[3] + op[2]        one OR, 3 NANDs</pre>`,
    },
    mistakes: [
      'Treating a write enable as a don\'t-care: rwe = 1 on a store writes the register named by its immediate bits.',
      'Forgetting what an unused opcode does: once traps exist, an illegal word must decode to "write nothing", so its enables are cared-for zeros.',
      'Testing a minimised circuit against a table that filled the don\'t-cares with 0: a correct circuit then fails.',
    ],
    anatomy: ['ctl'],
  },

  subtract: {
    idea: `In two's complement −b = ¬b + 1, so a − b = a + ¬b + 1: invert b and set the adder's carry in. A row of XOR gates inverts conditionally (b ⊕ sub is b when sub = 0, ¬b when sub = 1) and the same sub line drives cin, so one adder computes both a + b and a − b. The subtraction also yields every comparison: the carry out says a ≥ b unsigned, the result's sign corrected for overflow says a &lt; b signed, a zero result says equal.<br>In RV16 the ALU's adder/subtractor serves add, addi, sub, slt, sltu and every load and store address; the branch comparator has its own. At 16 bits it costs 212 NANDs against the plain adder's 144 (the XOR row), and is 5 delays deeper.`,
    example: {
      title: '5 − 7 at 16 bits',
      body: `<pre>a          0000 0000 0000 0101    5
¬b         1111 1111 1111 1000    ¬7
cin        1
sum        1111 1111 1111 1110    0xFFFE = −2
carry out  0                      a &lt; b unsigned (a borrow)</pre>`,
    },
    mistakes: [
      'Forgetting cin = 1: a + ¬b alone is a − b − 1 (ones\' complement).',
      'Reading the carry as a borrow: after a + ¬b + 1, carry out = 1 means no borrow, a ≥ b unsigned.',
      'Detecting signed overflow from the carry: it is the carry into the top bit XOR the carry out.',
    ],
    lib: 'addsub16',
    compare: ['rv16_add16'],
    anatomy: ['alu', 'br'],
    chapters: [{ chapter: 'adders', step: 5, label: 'Subtraction for free' }],
  },

  flags: {
    idea: `One subtraction, a + ¬b + 1, answers every comparison. Equal: the result is 0 (a 16-input zero detect). Unsigned a &lt; b: the subtraction borrows, so the carry out is 0. Signed a &lt; b: the true difference is negative; its sign is the result's top bit N unless the subtraction overflowed, which flips that bit, so lt = N ⊕ V with V = carry into the top bit ⊕ carry out. RISC-V keeps no flags: slt and sltu write the answer as 0 or 1 into rd, and branches compute theirs inside the instruction.<br>RV16's less-than unit needs neither N nor V: it reads only the carry of a + ¬b + 1 (16 NOTs invert b, no XOR row), and when the signs differ, a &lt; b exactly when a is negative; when they agree the difference cannot overflow and the unsigned answer holds. 169 NANDs, depth 39. The branch comparator adds an equality test (16 XORs and a zero detect, depth 12), selects with op[1] and inverts with op[0] for bne and bge.`,
    example: {
      title: 'a = 0x8000, b = 0x0001',
      body: `<pre>a + ¬b + 1 = 0x8000 + 0xFFFE + 1 = 0x7FFF, carry out 1
unsigned:  carry 1, no borrow → 32,768 ≥ 1          correct
signed:    N = 0, V = 1 (negative − positive gave positive)
           lt = N ⊕ V = 1 → −32,768 &lt; 1             correct
N alone would answer "not less"</pre>`,
    },
    mistakes: [
      'Taking signed less-than from the sign bit alone: wrong whenever the subtraction overflows (0x8000 against 0x0001).',
      'Inverting the unsigned test: carry out 1 means a ≥ b, 0 means a &lt; b.',
      'Building a comparator per condition: bge is ¬blt and bne is ¬beq, one XOR on the shared result.',
    ],
    lib: 'rv16_cmp16',
    anatomy: ['alu', 'br'],
    chapters: [{ chapter: 'alu', step: 2, label: 'Comparison is subtraction' }, { chapter: 'adders', step: 7, label: 'Signed comparison' }],
  },

  clockgating: {
    idea: `The tempting way to make a register load only when en = 1 is to AND the clock with en. It breaks two assumptions of synchronous design. Glitches: en comes from logic clocked by the same rising edge, so it changes while clk is high, and when it goes 0 → 1 then, clk · en rises mid-cycle and the register captures a value that has not settled. Skew: the gated clock arrives a gate later than everyone else's (2 NAND delays for an AND here), shifting this register's edge against the registers it exchanges data with and eating the hold margin.<br>The safe form leaves the clock alone and recirculates the data: a 2:1 mux in front of each flip-flop selects d when en = 1 and q when en = 0. It costs 4 NANDs per bit (a D flip-flop with enable is 15 NANDs against 11) and a mux delay on the d path. Low-power chips do gate clocks, with an integrated clock-gating cell: a latch transparent while clk is low captures en, so the AND sees an enable that cannot change while clk is high.`,
    example: {
      title: 'A 16-bit register two ways',
      body: `<pre>mux enable:   16 × (flip-flop 11 + mux 4) = 240 NANDs   (reg16)
AND-gated:    16 × 11 + one AND (2)        = 178 NANDs
the 62 NANDs saved buy an extra edge whenever en rises while clk = 1,
and a clock 2 delays late at these 16 flip-flops</pre>`,
    },
    mistakes: [
      'Gating with an enable produced from the same edge: it changes during the high phase, exactly when an AND passes it through.',
      'Gating with an OR (clk + ¬en) to hold the clock high: the glitch moves to the other phase and the skew stays.',
      'Leaving out the enable where a register must hold: a stalled PC that loads every cycle advances anyway.',
    ],
    lib: 'dffe',
    compare: ['dff'],
    anatomy: ['pc', 'rf', 'p1'],
    chapters: [{ chapter: 'latches', step: 4, label: 'Load enable' }],
  },

  forwarding: {
    idea: `A result exists at the end of E, two cycles before W writes it into the register file. Forwarding routes it back: in front of each ALU operand a multiplexer chooses the register file's value, the E/M register's (the instruction one ahead) or the M/W register's (two ahead). The select compares the operand's register number with rd in M and in W, each gated by that instruction's register-write enable and rd ≠ 0, and M has priority because it is newer. It removes every ALU-to-ALU stall: dependent instructions run back to back.<br>Cost in RV16: the forwarding unit is 110 NANDs (four 3-bit comparators, two zero tests, priority logic), plus a three-way choice on each operand (fa never selects input 3: two 16-bit 2:1 muxes, 98 NANDs). Both sit in series with the ALU and the branch comparator, so forwarding lengthens E: 13 delays of comparison and 3 of mux on the pipeline's critical path.`,
    example: {
      title: 'Three dependent instructions, no stall',
      body: `<pre>                   t       t+1           t+2
add a0, a1, a2     E       M             W
sub a1, a0, a2     D       E: a0 ← M     M
or  a2, a0, a1     F       D             E: a0 ← W, a1 ← M</pre>Measured: li, li, add, sub, or, sw and halt run in 9 cycles, 6 results plus 3 cycles of fill, with no stall.`,
    },
    mistakes: [
      'Giving W priority over M: when both match (add a0…; add a0…; use a0), M holds the newer value.',
      'Forwarding from instructions that do not write: a store\'s or branch\'s rd field holds immediate bits; gate with the write enable.',
      'Forwarding x0: an instruction with rd = 0 computes a value that must never reach a reader of x0.',
    ],
    lib: 'rv16_fwd',
    anatomy: ['fwd', 'alu'],
    chapters: [{ chapter: 'pipeline', step: 2, label: 'Data hazards and forwarding' }, { chapter: 'pipepay', step: 0, label: 'Look-ahead forwarding' }],
  },

  fpcompare: {
    idea: `IEEE 754 orders its fields sign, exponent, fraction, and the biased exponent is smallest for the smallest numbers, so for non-negative floats the bit patterns read as unsigned integers sort like the values. A float comparator is therefore an integer comparator on the 15 magnitude bits plus sign logic: with different signs the negative one is smaller unless both are zero; with both negative the magnitude order reverses; −0 = +0, although 0x8000 and 0x0000 differ. Subnormals need nothing special, since exponent field 0 sorts them below the normals.<br>NaN is unordered: every comparison involving a NaN is false, x = x included. feq raises the invalid flag only for a signaling NaN, flt and fle for any NaN. The binary16 comparator is 682 NANDs, depth 25; the 16-bit integer magnitude comparator alone is 237, depth 23.`,
    example: {
      title: 'Four binary16 values',
      body: `<pre> 1.5 = 0x3E00     2.0 = 0x4000     0x3E00 &lt; 0x4000 → 1.5 &lt; 2.0
−1.5 = 0xBE00    −2.0 = 0xC000     magnitudes 0x3E00 &lt; 0x4000,
                                   both negative: flip → −2.0 &lt; −1.5
as signed 16-bit integers 0xBE00 = −16,896 &lt; 0xC000 = −16,384,
which would claim −1.5 &lt; −2.0</pre>`,
    },
    mistakes: [
      'Comparing as two\'s-complement integers: sign–magnitude orders negative values backwards.',
      'Treating −0 and +0 as different because their bits differ.',
      'Letting NaN through the integer comparison: 0x7E00 would compare above +∞ (0x7C00).',
    ],
    lib: 'fpcmp5_10',
    compare: ['cmp16'],
    chapters: [{ chapter: 'float', step: 1, label: 'Where the floats are' }],
  },

  signedmul: {
    idea: `An unsigned multiplier reads a negative 16-bit a as a + 2^16, so the product it forms is (a + 2^16)·b = a·b + b·2^16: the error lies entirely in the high half. The low 16 bits are the same for every signedness, so mul needs no correction, and the signed high half is the unsigned one minus b when a is negative and minus a when b is negative (both when both are; the 2^32 term falls outside the 32-bit product). One unsigned array multiplier and two conditional subtractors give mul, mulh, mulhsu and mulhu.<br>Cost in RV16: the unsigned 16 × 16 array is 2,672 NANDs, depth 150; with the corrections the MD multiplier is 3,257 NANDs, depth 166. Baugh–Wooley and Booth recoding fold the signs into the partial products instead of correcting afterwards.`,
    example: {
      title: '−1 × 3, and 0x8000 × 0x8000',
      body: `<pre>unsigned 0xFFFF × 3 = 196,605 = 0x0002_FFFD
low half   0xFFFD = mul (−3), the same for every signedness
mulhu      0x0002
mulh, mulhsu: a &lt; 0 → 0x0002 − b = 0x0002 − 3 = 0xFFFF
check:     −3 = 0xFFFF_FFFD
0x8000 × 0x8000: unsigned high 0x4000; both negative:
           0x4000 − 0x8000 − 0x8000 = 0x4000 (mod 2^16) = mulh</pre>`,
    },
    mistakes: [
      'Correcting the low half: it is already right for every signedness.',
      'Correcting for b in mulhsu: rs2 is unsigned there, so only a negative rs1 subtracts.',
      'Sign-extending both operands to 32 bits and using a 32 × 32 multiplier: correct, with four times the array.',
    ],
    lib: 'rv16_mul',
    compare: ['amul16'],
    anatomy: ['alu', 'wb'],
    chapters: [{ chapter: 'muldiv', step: 7, label: 'Signed products: Baugh–Wooley' }, { chapter: 'muldiv', step: 21, label: 'The M unit' }],
  },

  // ---- act 9: throughput (lane figures from the RV16 lane golden model, riscv/rv16/simt16.ts)
  throughput: {
    idea: `Latency is how long one result takes; throughput is how many results arrive per unit of time. For one chain of dependent instructions only latency matters, and Acts 5–7 spent gates on it: forwarding, prediction, a shorter period. For n independent copies of one small computation (pixels, array elements) the latency of any one copy hardly matters; what counts is results per second, and per gate. Throughput is bought by overlap (a pipeline) or by replication (cores, lanes), and the two compose.<br>Replication keeps each result's latency: on the 4-lane SIMD core an element of 3·x + y still takes one 9-instruction loop iteration, at a period of 100 against the scalar core's 98, but four elements finish per iteration. Over 16 words that is 43 instructions against 151: 4,300 NAND delays against 14,798, 3.4× the throughput for 3.3× the NANDs.`,
    example: {
      title: 'Four results per cycle, two ways',
      body: `<pre>                       NANDs   period   results / cycle
single-cycle core      4,741     98       1
four cores            18,964     98       4
SIMD core, 4 lanes    15,774    100       4

3·x + y, 16 words      instructions   NAND delays
one lane                   151          14,798
four lanes                  43           4,300</pre>Four cores also need four instruction memories; the lanes share one.`,
    },
    mistakes: [
      'Judging a throughput machine by its latency: the SIMD core\'s period is 2 delays longer than the scalar core\'s, and it finishes the array 3.4× sooner.',
      'Expecting n lanes to give n×: the setup code runs at full length on every lane (151 → 43 is 3.5×, not 4×), and masked lanes, divergence and reductions take more.',
      'Replicating for dependent work: a chain in which each step needs the previous result gives the other lanes nothing to do.',
    ],
    chapters: [{ chapter: 'lanes', step: 0, label: 'Latency or throughput' }, { chapter: 'lanes', step: 4, label: 'Lanes against cores' }, { chapter: 'pipeline', step: 0, label: 'Overlap the work' }],
  },

  simd: {
    idea: `Single instruction, multiple data: one instruction stream drives several datapaths. What depends only on the instruction is built once: PC, instruction memory and fetch, decode and control, the immediate, the next-PC logic. What depends on the data is built per lane: registers, ALU, memory port, result path. The cost model follows: shared logic is paid once, lane logic n times, so SIMD saves as much as the shared part weighs in a core.<br>In RV16 it weighs little: of the SIMD core's 15,774 NANDs, 1,818 are shared and 3,489 belong to each lane, and four single-cycle cores would be 18,964. The larger saving is outside the NAND count: one instruction memory and one fetch per four results instead of four. SIMD appears as vector extensions (one instruction over a vector register: SSE, AVX, RISC-V V) and as GPUs, whose SIMT model hides the lanes from the programmer.`,
    example: {
      title: 'The SIMD core\'s bill',
      body: `<pre>shared, once                                  1,818
  next PC 421, branch 287, control 200, PC 144
  4:1 muxes (leader rs1, rs2; immediate) 441
  mask 102, lane decoder 73, PC muxes 147, OR 3
per lane, × 4                                 3,489
  registers 2,193, ALU + mux + nz 1,149
  result muxes 147
total                                        15,774</pre>The register files alone are 8,772: 56% of the core.`,
    },
    mistakes: [
      'Assuming every instruction does n times the work: setup code, masked lanes and the tail of a reduction do less.',
      'Sharing the memory port as if it were free: the RV32 lane core\'s single port takes one cycle per active lane for every load and store.',
      'Calling a lane a core: it cannot branch on its own. Without a mask and a stack, lanes that disagree follow the leader.',
    ],
    lib: 'rv16_simd',
    compare: ['rv16_cpu', 'rv16_simt'],
    chapters: [{ chapter: 'lanes', step: 1, label: 'One decoder, four ALUs' }, { chapter: 'lanes', step: 3, label: 'One memory port' }, { chapter: 'lanes', step: 4, label: 'Lanes against cores' }],
  },

  leader: {
    idea: `Some values exist once per warp: the next PC, the jalr target, tmc's new mask. Every active lane computes its own candidate and the hardware listens to one, the leader, the lowest active lane. RV16 encodes it in two bits from the mask (lane 0 if m0, else 1 if m1, else 2 if m2, else 3: bit 1 = ¬m0·¬m1, bit 0 = ¬m0·(m1 + ¬m2), 10 NANDs) and selects the leader's rs1 and rs2 through two 16-bit 4:1 muxes (147 NANDs each) feeding the branch comparator, the next-PC logic and tmc. The RV32 lane core of chapter 26 makes the leader a one-hot word (lowest set bit, 18 NANDs) and selects with one-hot muxes.<br>The rule only has to be fixed and to pick an active lane: a masked lane's registers are stale. When the active lanes agree, the leader's choice is everyone's; when they disagree, the branch diverges, and without split the others follow the leader down a path that is wrong for them.`,
    example: {
      title: 'Who decides',
      body: `<pre>csrr t0, tid          t0 = 0, 1, 2, 3
bnez t0, l1           lanes 1–3 want l1; leader 0 falls through: all do
...
tmc  t1  (1110)       leader: lane 1
beq  t0, a1, l2       a1 = 1: lane 1 branches, so all do</pre>The golden model counts 2 divergent branches in the test's 14 instructions; the hardware just follows the leader.`,
    },
    mistakes: [
      'Taking lane 0 instead of the lowest active lane: after tmc turns lane 0 off its registers are stale, and the warp follows a lane that is not running.',
      'Reading the leader where every lane\'s value is needed: only per-warp things (the next PC, the mask) come from it; register writes stay per lane.',
      'Using a binary leader to drive one-hot muxes, or the reverse: a 4:1 mux wants the 2-bit index, a one-hot mux the lowest-set-bit word.',
    ],
    lib: 'rv16_mask4',
    compare: ['low1_4', 'prienc4'],
    chapters: [{ chapter: 'lanes', step: 2, label: 'The leader' }, { chapter: 'simt', step: 1, label: 'When lanes disagree' }],
  },

  warp: {
    idea: `A warp is the set of threads that share one PC: one thread per lane, all executing the same instruction in the same cycle. The program is written for one thread. The threads differ in their data and, at the start, in one number: <code>csrr rd, tid</code> writes warp · lanes + lane into each lane's rd (CSR 7; a scalar RV16 core reads 0 there). The usual pattern is a strided loop: thread i takes elements i, i + 4, i + 8, …, so four threads cover the array once and each runs the same number of iterations.<br>Nvidia's warps are 32 threads, AMD's wavefronts 32 or 64, the campaign's 4. A GPU core keeps many warps and issues from one whose operands are ready while others wait for memory; the campaign's SIMD and SIMT cores hold one, so <code>bar</code> (wait for every warp) does nothing there, and its two-warp core holds two, taking turns.`,
    example: {
      title: '3·x + y, strided',
      body: `<pre>        csrr t0, tid          # 0, 1, 2, 3
        li   t1, 4            # stride: the lane count
        la   a0, x
        add  a0, a0, t0       # address of x[tid]
        li   a1, 4            # 16 / 4 iterations
loop:   lw   a2, 0(a0)        # x[i]
        lw   ra, 16(a0)       # y[i]
        slli sp, a2, 1
        add  a2, a2, sp       # 3·x
        add  a2, a2, ra
        sw   a2, 16(a0)       # y[i] ← 3·x + y
        add  a0, a0, t1
        addi a1, a1, -1
        bnez a1, loop
        halt</pre>43 warp instructions; lane 1 handles elements 1, 5, 9, 13. With stride 1 and 16 iterations, one lane needs 151.`,
    },
    mistakes: [
      'Assuming the threads of a warp run in some order: they run in lock-step, and when two lanes store to one word in the same instruction, the higher lane\'s store lands last here.',
      'Giving lanes different trip counts by accident (n not a multiple of the lane count, a bound computed from tid): the loop branch diverges.',
      'Treating tid as a hart id: harts are cores with PCs of their own (<code>csrr mhartid</code>, chapter 24); the threads of a warp share one PC.',
    ],
    lib: 'rv16_lanedec',
    chapters: [{ chapter: 'lanes', step: 0, label: 'Latency or throughput' }, { chapter: 'lanes', step: 1, label: 'One decoder, four ALUs' }],
  },

  divergence: {
    idea: `A branch diverges when the active lanes of a warp disagree on it. One PC cannot go both ways. Without help the warp follows its leader and the lanes that disagree execute the wrong path: a wrong result, not a slow one. With split and join (or predication) the warp runs both paths one after the other, each with only the lanes that took it, and the lanes reconverge after the if. Correctness is restored, time is not: the warp pays for the then path plus the else path, and every lane idles through the path it did not take.<br>Divergence is a property of the data, not of prediction: a branch that is never mispredicted still costs both sides when its outcome differs between lanes. Branches on uniform values (a loop count shared by all lanes, a kernel parameter) never diverge; branches on tid or on loaded data may.`,
    example: {
      title: 'One if / else, with and without split',
      body: `<pre>odd lanes: a0 = 3·tid; even lanes: a0 = tid / 2

no split   6 instructions    stored 0, 0, 1, 1   (lanes 1, 3 wrong)
split      14 instructions   stored 0, 3, 1, 9
           then side: 5 instructions on lanes 1, 3
           else side: 3 instructions on lanes 0, 2</pre>Without split the leader (lane 0, even) takes every lane down the even path. With split the test runs both sides: 71% of its lane-steps do work.`,
    },
    mistakes: [
      'Assuming a divergent branch is only slow: without split the result is wrong.',
      'Counting the cost of an if / else as its longer side: the warp runs both, so the cost is the sum.',
      'Splitting on a condition the lanes always agree on and expecting it to cost a side: nothing is parked, and the price is the split and the join.',
    ],
    chapters: [{ chapter: 'simt', step: 1, label: 'When lanes disagree' }, { chapter: 'simt', step: 5, label: 'What divergence costs' }],
  },

  simt: {
    idea: `Single instruction, multiple threads: SIMD hardware with the programming model of independent threads. Each thread is an ordinary scalar program over its own registers, with its own ifs and loops; the hardware runs a warp of them on one PC and keeps the illusion with the active mask (which lanes write) and the reconvergence stack (which lanes are still owed the other side of an if). A correct program needs no knowledge of the lanes; a fast one does, because divergence and the tail of a reduction leave lanes idle.<br>The cost over SIMD is small: RV16's SIMT core is the SIMD core plus the stack, a PC mux and a mask mux, 17,837 NANDs against 15,774 (+13%), at the same period of 100. Its 25 test programs, the split ones among them, take 919 cycles. Nvidia named the model; Vortex, the open-source RISC-V GPU, adds split, join and tmc to RV32 as the campaign adds them to RV16.`,
    example: {
      title: 'Nested ifs, four threads',
      body: `<pre>a0 = 0
if (tid &amp; 2) {             lanes 2, 3
  a0 += 10
  if (tid &amp; 1) a0 += 1     lane 3
  a0 += 30
}
store a0                   0, 0, 40, 41

masks: 1111 ×4, 1100 ×4, 1000 ×3, 0100 ×2, 1100 ×2, 0011 ×2, 1111 ×2</pre>Each thread reads like scalar code; the warp ran 19 instructions, 59% of its lane-steps doing work.`,
    },
    mistakes: [
      'Treating the threads of a warp as independent in time: a thread spinning on a flag that another thread of its warp will set never finishes, because the waiting side runs while the other is masked off.',
      'Forgetting a join: the else lanes never run, and the mask never comes back.',
      'Measuring a kernel by the instructions of one thread: the warp pays for every path any of its threads takes.',
    ],
    lib: 'rv16_simt',
    compare: ['rv16_simd'],
    chapters: [{ chapter: 'lanes', step: 0, label: 'Latency or throughput' }, { chapter: 'simt', step: 2, label: 'split and join' }, { chapter: 'simt', step: 3, label: 'An if inside an if' }],
  },

  utilization: {
    idea: `Lane utilization = Σ active lanes / (instructions × lanes): the share of lane-steps that did work. It is to a lane core what CPI is to a pipeline: the warp issues an instruction every cycle regardless, and utilization says how much of each was used. It falls wherever the mask has zeros: the tail of an array, both sides of a divergent if, lanes that leave a loop early, the combine at the end of a reduction. Throughput is lanes × utilization results per cycle.<br>Measured on the golden model: a uniform strided kernel (3·x + y over 16 words) 100%; the tmc test 75%; the if / else test 71%; nested ifs 59%; a 16-word sum 87%, a 64-word sum 95%. The kernel puzzles grade the complement, idle lane-steps in percent.`,
    example: {
      title: 'Counting the if / else',
      body: `<pre>instructions   mask    lane-steps
3              1111    12
5              1010    10      then side
3              0101     6      else side
3              1111    12
14                     40 of 56 = 71%</pre>`,
    },
    mistakes: [
      'Quoting utilization without its region: setup code and the common tail run at full width and lift the figure for a whole program above that of its if.',
      'Treating masked lanes as free: they occupy the cycle; the warp takes as long as all its paths together.',
      'Optimizing utilization instead of time: busy lanes doing useless work raise the figure and not the throughput.',
    ],
    chapters: [{ chapter: 'simt', step: 0, label: 'The active mask' }, { chapter: 'simt', step: 5, label: 'What divergence costs' }],
  },

  reduction: {
    idea: `A reduction combines n values into one with an associative operator: a sum, a maximum, an AND. On lanes it runs in two phases. First each lane reduces its own share, strided like any kernel, with every lane busy. Then the lane partials combine in log₂(lanes) rounds: in each, half of the remaining lanes add a partner's partial (through memory here, since a lane cannot read another lane's registers) and the other half are masked off. The second phase has a fixed length, so its idle lanes weigh less the more elements each lane sums first.<br>Integer addition is associative, so the order changes nothing. Floating-point addition is not: a parallel sum can differ from the sequential one in its last bits.`,
    example: {
      title: 'Sixteen words on four lanes',
      body: `<pre>        # each lane sums x[tid], x[tid+4], …: 32 instructions, 4 lanes
        la   sp, part
        add  sp, sp, t0
        sw   a2, 0(sp)        # part[tid]
        li   t1, 3
        tmc  t1               # lanes 0, 1
        lw   ra, 2(sp)        # part[tid + 2]
        add  a2, a2, ra
        sw   a2, 0(sp)
        li   t1, 1
        tmc  t1               # lane 0
        lw   ra, 1(sp)
        add  a2, a2, ra       # 136 = 1 + 2 + … + 16
        sw   a2, -3(x0)       # OUT</pre>41 instructions: 32 with four lanes, 5 with two, 4 with one: 142 of 164 lane-steps, 87%. With 64 words, 101 instructions and 95%: the tail is the same 9.`,
    },
    mistakes: [
      'Reading another lane\'s register: lanes share no registers, so partials pass through memory (real GPUs add shuffle instructions for this).',
      'Combining serially: lane 0 adding the other three partials takes three load-and-add rounds, pairing takes log₂ 4 = 2.',
      'Expecting a parallel float sum to equal the sequential one: the pairing reorders the additions.',
    ],
    chapters: [{ chapter: 'simt', step: 0, label: 'The active mask' }, { chapter: 'simt', step: 5, label: 'What divergence costs' }],
  },

  barrel: {
    idea: `Barrel scheduling (fine-grained multithreading) gives the issue slots to the warps in a fixed rotation, one instruction each. A warp's consecutive instructions are then W cycles apart, so any latency up to W − 1 cycles between them is invisible: no forwarding, no stall, no scoreboard. The CDC 6600's peripheral processors (1964) shared one datapath this way among ten threads; Sun's Niagara and today's GPUs keep the idea and add a scheduler that picks a ready warp instead of the next one.<br>The campaign's two-warp core rotates two warps over a memory one cycle late: a load's word comes back during the other warp's turn and is written then, through a second register write port. The cost is the state: a PC, mask, stack and lane register file per warp, +12 326 NANDs over the SIMT core (30 163 against 17 837), more than half of it registers. A fixed rotation also wastes the turns of a warp that cannot use them (waiting at a barrier, or finished): 59 of the 2 160 turns in the level's 31 programs.`,
    example: {
      title: 'A load, in turns',
      body: `<pre>cycle  issues               the memory, at the edge   register writes
  1    w0: lw a1, 0(a0)     reads w0's word
  2    w1: lw a1, 0(a0)     reads w1's word           w0's a1 ← its word (load port)
  3    w0: add a1, a1, t0                             w1's a1 ← its word (load port)
  4    w1: add a1, a1, t0                             w0's a1 ← the sum (rwe)</pre>Each add reads a1 a cycle after it was written: nobody waited.`,
    },
    mistakes: [
      'Writing a load\'s word when it issues: a synchronous memory has not read it yet.',
      'Writing the returning word into the registers of the warp issuing now: it belongs to the warp that issued last cycle.',
      'Letting a warp that waits at a barrier, or has ended, move its PC or write anything in its turn.',
    ],
    lib: 'rv16_warps', compare: ['rv16_simt'],
    chapters: [{ chapter: 'warps', step: 2, label: 'Many warps resident' }, { chapter: 'warps', step: 3, label: 'Picking a ready warp' }],
  },

  barrier: {
    idea: `Warps run in an order the program does not control: the campaign's two-warp core gives them turns, chapter 28's core issues whichever warp is ready, a real GPU interleaves dozens. So when one warp stores a word and another loads it, nothing says which happens first, unless something orders them. <code>bar</code> does: a warp that reaches it issues nothing more until every other warp has reached it too, or has ended; the last to arrive releases them all. After a bar, every store made before it by any warp is visible to every load after it.<br>RV16's bar has no operands (SYSTEM funct3 7) and waits for the other warp; a warp that ends with <code>tmc x0</code> (an empty mask) counts as arrived, one that spins on <code>halt</code> with lanes on never arrives. Chapter 29's RV32 bar names a barrier and a warp count, so a subset of warps can synchronise.`,
    example: {
      title: 'The histogram without its bar',
      body: `Taking turns, the two warps of the histogram kernel stay within an instruction of each other: when warp 1 adds up the counters, warp 0 has written them, and every bin comes out right without the bar. Run warp 1 ahead instead (a scheduler may) and it adds up warp 0's counters before they are counted: in the 64-value test, bin 8 comes out 1 instead of 2. The kernel was right by luck of the order; the puzzle's grader runs both orders.`,
    },
    mistakes: [
      'Relying on the issue order: turn-taking is the hardware\'s choice, not a promise; a different scheduler or a cache miss reorders the warps.',
      'Letting a warp halt without reaching the barrier while lanes are on: the other waits for ever. A warp with no work ends with tmc x0.',
      'Expecting bar to order the lanes of one warp: they are in lock-step already, and within an instruction lower lanes store first. bar orders warps.',
    ],
    chapters: [{ chapter: 'feed', step: 3, label: 'A barrier' }],
  },

  privatization: {
    idea: `Counting is a read-modify-write: load the counter, add 1, store it. Two threads doing it to one counter at once both load the old value, and one increment is lost. On lanes it happens inside a single instruction: two lanes of a warp that meet the same value load the same count in the same cycle. The fixes are an atomic add (chapter 29's <code>amoadd.w</code>, which the RV32 lanes perform one lane after another) or not sharing: each thread counts into private copies, and after a barrier the copies are added up, in parallel.<br>The campaign's histogram has 8 threads and 16 bins: 128 private counters. Laid out bin-major (the counter for value v of thread t at 8·v + t), each bin's eight counters are consecutive, so after the bar every thread adds up two bins with plain loads and every lane stays busy: 176 cycles on the tests' mean, 0% idle lanes. One warp doing the whole job with the other ended is 550 cycles at 77% idle.`,
    example: {
      title: 'A lost update in one instruction',
      body: `<pre>                               # lanes 0 and 1 both met value 5 (a1 = 5)
        lw   a2, 0(a1)         # both read the count, 0
        addi a2, a2, 1         # both compute 1
        sw   a2, 0(a1)         # both store 1: the count is 1, not 2</pre>With private counters at 8·v + tid, lane 0 writes word 40 and lane 1 word 41.`,
    },
    mistakes: [
      'Keeping one shared counter per bin "because collisions are rare": a warp\'s four lanes meet the same value often, and every collision loses a count silently.',
      'Adding up the copies before every thread has counted: the combine needs a barrier.',
      'Assuming scratch memory starts at 0: the puzzle\'s does; in general, clear the counters first (and bar after clearing).',
    ],
    chapters: [{ chapter: 'feed', step: 4, label: 'Atomics' }],
  },
  tilewalk: {
    idea: 'A rasterizer that visits every pixel of a triangle\'s bounding box spends most of its cycles outside a thin or diagonal triangle. Group the pixels into tiles (4 × 4 here) and test each tile once: if some edge is negative even at the tile\'s best corner, the corner where that edge is largest, no pixel of the tile can be inside, and the walk moves on. The best corner of edge i is at its top-left pixel plus 12·A⁺ in x and 12·B⁺ in y (A⁺ = A when positive, else 0): one more adder per edge.<br>The walk goes in bands, rows of tiles left to right. Inside an accepted tile it runs down the first column, up the second, down, up: every step is one pixel, so E changes by one constant, and the last pixel, the top-right one, is one step left of the next tile\'s top-left. A band starts again from R, the stepper\'s copy of E at the band\'s first tile: R + 4·(4B) is the next band.',
    example: { title: 'A sliver across the screen', body: '<pre>triangle (4, 8) (124, 112) (116, 124), quarter pixels\nbox: tiles 0 … 7 × 0 … 7, 64 tiles, 1 024 pixels\ntiles accepted: 19, rejected: 45; pixels drawn: 70\ncycles: 64 TEST + 19 × 16 = 368 (+ 19 set-up)\na scan of the box: 1 024 (+ set-up)</pre>The thinner the triangle, the more the TEST cycles save.' },
    mistakes: [
      'Testing a tile at its top-left pixel only: a tile whose top-left is outside can still hold pixels inside.',
      'A row-by-row path inside the tile: the jump back to the left edge is −3·4A, a step the stepper does not have.',
      'Forgetting to return to the band\'s start: after the last tile of a band, E is far to the right; only R knows where the band began.',
    ],
    lib: 'rv16_tile',
    chapters: [{ chapter: 'pixels', step: 2, label: 'Walking tiles' }],
  },
  horner: {
    idea: 'Multiplying a by an n-bit b needs no multiplier if time is cheaper than gates: Horner\'s rule, b = (…((b₇)·2 + b₆)·2 + …)·2 + b₀, turns a·b into n steps of acc ← 2·acc + (bₖ ? a : 0), most significant bit first. The doubling is wiring; the addition is the adder that is already there. A two\'s complement b weighs its top bit −2ⁿ⁻¹: that one step subtracts.<br>The rasterizer\'s set-up needs E = A·Δx + B·Δy − bias for each edge at the first tile, and each edge stepper already has an adder and a register. Interleaving the two products bit by bit, double-and-add A for bit k of Δx, then add B for bit k of Δy, computes both in one pass: E ← 0, two subtracting steps for the sign bits, fourteen steps for bits 6 … 0, one for the bias. The three edges run at once, 17 cycles a triangle, with nothing added but the muxes that feed the steppers.',
    example: { title: '−20 · 40 + 110 · 40, MSB first', body: '<pre>Δx = Δy = 40 = 0010 1000 (bits 7 … 0)\nE = 0\nbit 7: E − 0·A − 0·B          = 0\nbit 6: 2E + 0, + 0             = 0\nbit 5: 2E + A (−20), + B (110) = 90\nbit 4: 2E, + 0                 = 180\nbit 3: 2E + A, + B             = 450\nbit 2 … 0: doublings           = 3 600\nminus the bias 1               = 3 599</pre>' },
    mistakes: [
      'Least significant bit first with a fixed accumulator: then the operand must shift left each step, a second register.',
      'Treating Δ as unsigned: the sign bit weighs −128, so it subtracts.',
      'Doubling between the A and B steps of one bit: both products share the doubling, once per bit.',
    ],
    lib: 'rv16_raster',
    chapters: [{ chapter: 'pixels', step: 1, label: 'Inside a triangle' }],
  },
  device: {
    idea: 'A processor drives other hardware through addresses: the device decodes the address bus, and a store to one of its registers configures it, another starts it. The rasterizer of k_frame listens to lane 0\'s memory port: six stores set the vertices, a seventh sets the colour and starts it. Its output is memory too: it writes the screen, words the lanes can also load and store.<br>A device that runs on its own for hundreds of cycles needs a rule for when the processor may touch it again. Software can poll a status word or wait for an interrupt; k_frame\'s core instead holds an instruction that would interfere, a store to the device or a load from the screen, until the rasterizer is done. A load from the screen then works as a fence: after it, the picture is complete. Stores to the screen are not held, so a program that clears the screen must fence first, or it races the drawing.',
    example: { title: 'Drawing, then reading back', body: '<pre>        sw   a0, -16(x0)     # 0xFFF0: v0x (lane 0)\n        …                    # v0y … v2y\n        sw   a1, -10(x0)     # 0xFFF6: the colour; the rasterizer starts\n        lw   a2, 0(t0)       # t0 in 0xF000 …: waits until it is done\n        sw   x0, 0(t0)       # safe: the triangle is finished</pre>Without the load, the store could land before the rasterizer reaches that pixel, and be painted over.' },
    mistakes: [
      'Holding only the stores to the device: a load from the screen would then read a half-drawn picture.',
      'Building the hold from the write enables it gates: the hold changes go, go changes the enables, a combinational loop.',
      'Assuming the golden model\'s timing: it draws at once, so a program that races the rasterizer looks right there and fails on the hardware.',
    ],
    chapters: [{ chapter: 'pixels', label: 'Pixels and triangles' }],
  },
  minsky: {
    idea: 'Rotating a point by a small angle ε exactly takes cos ε and sin ε: four multiplications. Approximating, x ← x − ε·y; y ← y + ε·x, is cheap but wrong in a way that grows: the matrix [[1, −ε], [ε, 1]] has determinant 1 + ε², so every step pushes the point outward, and after a few hundred steps the circle is a spiral. Minsky\'s version uses the new x in the second line. Its matrix, [[1, −ε], [ε, 1 − ε²]], has determinant exactly 1: the point moves on a closed ellipse, very close to a circle for small ε.<br>With ε = 1/8 both multiplications are arithmetic shifts by 3. In 8.8 fixed point (8 fraction bits) a square\'s corners stay within about 6 % of their radius over 2 000 frames; in whole quarter pixels the rounding errors build up to about 20 %. Marvin Minsky found it drawing circles on the PDP-1 display (HAKMEM, item 149).',
    example: { title: 'One step of a corner, ε = 1/8', body: '<pre>x = −28·256 = −7 168, y = −7 168   (8.8: −28 quarter pixels)\nx ← x − (y &gt;&gt; 3) = −7 168 + 896 = −6 272\ny ← y + (x &gt;&gt; 3) = −7 168 − 784 = −7 952\nscreen: 64 + (x &gt;&gt; 8) = 64 − 25 = 39, 64 + (y &gt;&gt; 8) = 64 − 32 = 32</pre>' },
    mistakes: [
      'Updating y from the old x: the two lines then form the spiral, not the ellipse.',
      'Logical shifts: a negative coordinate turns into a large positive one.',
      'Rounding to whole pixels every step: the errors accumulate; keep the fraction and round only when drawing.',
    ],
    chapters: [{ chapter: 'pixels', label: 'Pixels and triangles' }],
  },
};
