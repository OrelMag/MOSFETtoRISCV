// Level cases, acts 0–3 (transistors, logic, numbers and arithmetic, state and memory). See cases.ts.
// Every build level of these acts has one (optional ones included), plus the two lessons and drills
// whose case adds to their `why` (n_twos, m_mem). Numbers are measured from the library (stats,
// logicDepth, static timing); hand counts say how in `note`. "The single-cycle core" is rv16_cpu,
// "the pipeline" rv16_pipe_111s (the finale); a core's period here excludes the bench's memories.

import type { LevelCase } from './cases';

export const CASES0: Record<string, LevelCase> = {
  // ---- Act 0 ----------------------------------------------------------------------------------
  t_inv: {
    problem: 'A computer is switches driving the gates of other switches. Every CMOS gate is two networks on one output: PMOS pulling it to VDD, NMOS pulling it to GND, driven by the same inputs. The inverter is the smallest case, one transistor in each, and sets the rule every later cell obeys: for any input exactly one network conducts, so the output is always driven and no static current flows.',
    without: 'With a resistor in place of the PMOS (pseudo-NMOS) the output still inverts with one transistor, but current flows from VDD to GND for as long as a = 1, and the rising edge is only as fast as the resistor charges the load.',
    cost: 'Two transistors. The campaign keeps a single brick, so its NOT is a NAND with tied inputs (4 transistors): the single-cycle core\'s 196 NOT gates cost 784 transistors where CMOS inverters would need 392.',
    alts: [{ name: 'Pseudo-NMOS inverter (pull-up resistor + NMOS)', lib: 'inv_pseudo' }],
  },
  t_nand: {
    problem: 'NAND is functionally complete: NOT, AND, OR, the multiplexers, the adders, the flip-flops, all of RV16 down to its last register bit is NANDs. Two NMOS in series pull the output low only when a = b = 1; two PMOS in parallel pull it high when either input is 0. From the next level on this cell is the only primitive, and every cost in the campaign is counted in it: NANDs for area, NAND delays for depth and clock period.',
    without: 'A single CMOS stage can only invert: AND and OR each need a second stage (6 transistors). Without an inverting gate that is complete on its own (NAND or NOR) the brick would be bigger and slower.',
    cost: 'Four transistors, one delay. The single-cycle core is 4720 NANDs (18880 transistors), the pipeline with traps 12038 (48152). Cell libraries also offer inverters, AOI cells and 3- and 4-input NANDs; counting in 2-input NANDs keeps one unit for area and time.',
    alts: [{ name: 'CMOS NOR (the dual)', lib: 'nor_cmos' }],
  },
  t_nor: {
    problem: 'NOR is the dual of NAND (PMOS in series, NMOS in parallel) and also complete. It shows why cell libraries and this campaign build on NAND: NOR puts its series pair in the pull-up, and holes are about 2–3× less mobile than electrons, so its rising edge is the slow one unless the PMOS are made wider, which costs area and input capacitance.',
    cost: 'Four transistors, like the NAND. At gate level the campaign builds a NOR from four NANDs (16 transistors, depth 3).',
    alts: [{ name: 'NOR from four NANDs', lib: 'nor' }],
  },

  // ---- Act 1 ----------------------------------------------------------------------------------
  g_not: {
    problem: 'Control signals are needed in both polarities. A mux needs ¬s next to s, the decoder ANDs the complements of the register number, a flip-flop\'s master latch runs on ¬clk, the ALU\'s sltu is ¬carry, and the pipeline writes its register file on ¬clk. NOT is a NAND with its inputs tied: ¬(a·a) = ¬a.',
    without: 'No AND (a NAND, then NOT) and no OR (NOT on both inputs, then a NAND): only the inverting function itself.',
    cost: '1 NAND, depth 1: 4 transistors where a CMOS inverter is 2. Tying one input to 1 instead gives the same function at the same cost.',
  },
  g_and: {
    problem: 'AND gates a signal: it passes only while an enable is 1. The register file writes a register only when rwe AND the decoder line for rd are 1; the next-PC logic loads a branch target only when br AND take; each decoder output is an AND of address bits or their complements.',
    without: 'NAND gives the complement; every enable would be active-low and the next gate would have to absorb the inversion.',
    cost: '2 NANDs, depth 2: a NAND, then a NOT. When the result feeds another NAND the NOT can often be dropped (NAND–NAND logic): that is how the par of most later levels is reached.',
  },
  g_or: {
    problem: 'OR merges conditions. The next-PC logic redirects on jal OR jalr OR (branch AND taken); each control signal is the OR of the opcode lines that need it (rwe is the OR of nine opcode lines, lui\'s two among them); the zero detect is a tree of ORs over 16 bits. De Morgan makes it from NANDs: a + b = ¬(¬a · ¬b).',
    without: 'An OR would need its own cell. With De Morgan it is two inverters and a NAND.',
    cost: '3 NANDs, depth 2. When the inputs come from NANDs their inversions cancel: an OR of two ANDs is three NANDs in all (NAND–NAND), the shape every sum of products takes.',
    alts: [{ name: 'NOR, then NOT', nand: 5, depth: 4, note: 'The four-NAND NOR (depth 3) followed by a NOT.' }],
  },
  g_xor: {
    problem: 'XOR is the sum bit of an adder without its carry. It is also a controlled inverter: the adder / subtractor feeds b ⊕ sub to its adder, so one adder also subtracts. And it is a difference detector: the equality comparator behind beq and bne is 16 XORs and a zero detect. The ALU\'s <code>xor</code> is 16 more, and its signed less-than is N ⊕ V.',
    without: 'No subtraction through the adder and no cheap equality test: each would need its own sum-of-products circuit per bit.',
    cost: 'Par shares the first NAND, n = ¬(a·b), between both halves: ¬(¬(a·n) · ¬(b·n)), 4 NANDs, depth 3. The plain sum of products ¬a·b + a·¬b needs two inverters and three NANDs: 5, also depth 3.',
    alts: [
      { name: 'Sum of products ¬a·b + a·¬b', nand: 5, depth: 3, note: 'Two NOTs, two NANDs for the products, one NAND for the OR (NAND–NAND).' },
      { name: '(a + b) · ¬(a·b)', nand: 6, depth: 4, note: 'OR (3 NANDs, depth 2) and NAND (1) side by side, then AND (2).' },
    ],
  },
  g_mux: {
    problem: 'Wherever two values can reach one input there is a multiplexer, y = s ? b : a. The ALU\'s b operand is rs2 or the immediate; the PC loads pc + 1 or a jump target; the register file is written the ALU result, a loaded word, pc + 1 or the immediate. Enables, read ports, the shifter and the ALU\'s result select are trees of the same cell: about half the NANDs of both RV16 cores are in 2:1 muxes.',
    without: 'An AND–OR mux from the gates so far is 8 NANDs and depth 5 per bit. The single-cycle core has 705 bits of 2:1 mux: that would be about 2900 more NANDs.',
    cost: 'NAND–NAND form ¬(¬(s·b) · ¬(¬s·a)): 4 NANDs, depth 3, one of them the inverter on s, which a bus mux can share across its bits. In CMOS two transmission gates and an inverter make a mux of 6 transistors against these 16, at the price of a path that does not restore the signal level.',
    alts: [{ name: 'AND–OR with a NOT', nand: 8, depth: 5, note: 'NOT s (1), two ANDs (2 each), OR (3); the path is NOT, AND, OR.' }],
  },
  g_sop: {
    problem: 'The control unit is specified as a table, opcode → control signals, and must become gates. This level practises the method on one function of 4 inputs (is a prime?): K-map, minimal sum of products, then two levels of NANDs, which map one-to-one onto the products and the OR. The RV16 control unit (Act 5) has 14 output bits, each a function of the opcode and f3.',
    without: 'Read straight off the table the function is six minterms of four literals each; minimised it is four products of three literals.',
    cost: 'Minimised and built NAND–NAND (three inverters, each 3-literal product from 2-input gates, a 4-input NAND for the OR) it is 20 NANDs, depth 7; with the pairs ¬a2·a1 and a2·a0 shared between products, 16. Par is 8, depth 5: the map\'s lower half is a2 ? a0 : a1 and its upper half that mux with two cells removed, so y = (a2 ? a0 : a1) · (¬a3 + a0·¬(a1·a2)), ¬(a1·a2) serving both factors and standing in for the mux\'s inverter. No circuit of 2-input NANDs is smaller or shallower. A 16:1 mux used as a lookup table (an FPGA LUT: constants on the data inputs, a on the select) fits any 4-input function and costs 60 NANDs before simplification.',
    alts: [
      { name: 'Minimal sum of products, NAND–NAND', nand: 20, depth: 7, note: 'Three inverters, four 3-literal products (an AND and a NAND each), the 4-input NAND as two ANDs and a NAND.' },
      { name: 'Sum of products, shared pairs', nand: 16, depth: 7, note: '(¬a2·a1)·¬a3 + (¬a2·a1)·a0 + (a2·a0)·¬a3 + (a2·a0)·¬a1: two pairs serve the four products.' },
      { name: '16:1 mux as a lookup table', lib: 'mux16x1' },
    ],
  },
  g_wide: {
    problem: 'Some questions are about a whole word: is it zero? The ALU\'s zero output and the equality comparator behind beq / bne both end in a 16-input OR, fifteen 2-input gates however they are arranged. In a chain the first input passes through all fifteen; in a balanced tree through four. The gate count is the same either way: depth sets the clock.',
    without: 'As a chain of ORs: the same 46 NANDs, depth 31 instead of 9.',
    cost: 'Par is the reference: fifteen ORs in four levels and a NOT, 46 NANDs, depth 9. A tree grows with log2 of the width: the 32-bit zero detect of RV32 is 94 NANDs, depth 11.',
    alts: [{ name: 'Chain of 15 ORs', nand: 46, depth: 31, note: 'The same gates in a line: the first input crosses all fifteen ORs (2 delays each), then the NOT.' }],
  },
  g_dec: {
    problem: 'The register file has eight registers and one write port: the 3-bit rd field must become eight enable lines, exactly one of them 1, and none while rwe = 0. Output k is the AND of the enable and the address bits or their complements that spell k. A 4→16 decoder on the opcode is the first stage of the control unit.',
    without: 'Each of x1–x7 would compare rd itself: seven 3-bit equality comparators (19 NANDs each, 133 in all) plus their enables, against one 30-NAND decoder.',
    cost: 'Predecoded: two inverters and four 2-input ANDs turn (a0, a1) into four lines, a NAND, a NOT and an AND turn (a2, en) into two, and eight 2-input ANDs combine one of each: 30 NANDs, depth 5, par equal to the reference. Eight 4-input ANDs on three shared inverters, the textbook form, are 51 at the same depth. The enable costs 3 NANDs and no delay here (an inverter on a2 would replace the pair\'s 4), where eight ANDs after the decoder would cost 16 and add 2 delays. Memory row decoders are built the same way: predecoders, then one 2- or 3-input AND per row.',
    alts: [{ name: 'Eight 4-input ANDs', nand: 51, depth: 5, note: 'Three inverters, then per output en and three literals through three 2-input ANDs (6 NANDs, depth 4).' }, { name: '3→8 decoder without enable (library)', lib: 'dec3' }],
  },
  g_mux8: {
    problem: 'Data moves 16 bits at a time, so every mux of the datapath is sixteen copies of the 1-bit cell sharing one select. This bus mux picks the ALU\'s b operand (rs2 or the immediate) and the PC\'s next value; trees of it are the 4:1 immediate and result selects and the register file\'s two 8:1 read ports.',
    without: 'No datapath: every unit could feed only one destination, and an instruction could not choose between a register and an immediate.',
    cost: 'Sixteen 4-NAND muxes would be 64 NANDs, depth 3. They all invert the same s, so one shared inverter saves 15: 49 NANDs, same depth, the reference and par (3 NANDs per bit, one ¬s for all sixteen). Trees of them make the 4:1 and 8:1 bus muxes, 147 and 343 NANDs (depth 7 for the 8:1), against 192 and 448 from the library\'s 64-NAND muxes; the register file has two 8:1 trees.',
    alts: [{ name: 'Sixteen 4-NAND muxes (library)', lib: 'mux2x16' }],
  },
  g_eq16: {
    problem: 'beq and bne branch on rs1 = rs2. Two words are equal when no bit differs, that is when a ⊕ b is zero: 16 XORs feeding the zero detect. The finished CPU holds one, in the branch comparator; its forwarding and hazard units compare 3-bit register numbers with 3-bit copies of their own.',
    without: 'beq would zero-detect the a + ¬b + 1 the branch comparator already computes for blt: 46 more NANDs, but the answer would wait for the carry chain (depth 46 instead of 12).',
    cost: '16 XORs (64) and the zero detect (46): 110 NANDs, depth 12, par equal to the reference. XNOR per bit and a 16-input AND come to the same 110 NANDs and depth 12.',
    alts: [
      { name: 'Zero detect on the comparator\'s a + ¬b + 1 (NANDs added)', nand: 46, depth: 46, note: 'Reuses the branch comparator\'s adder (its sum bits, unused there, at depth 37) and adds a 16-bit zero detect (46 NANDs, depth 9).' },
      { name: 'XNOR per bit and a 16-input AND', nand: 110, depth: 12, note: '16 XNORs (5 NANDs, depth 4) and and16 (30 NANDs, depth 8).' },
    ],
  },

  // ---- Act 2 ----------------------------------------------------------------------------------
  a_ha: {
    problem: 'One column of binary addition: two bits in, a sum and a carry out; the sum is a ⊕ b, the carry a·b. Adding a constant 1 needs nothing more than a chain of them, and the PC adds 1 every cycle: the RV16 core\'s incrementer (pc + 1, in the next-PC logic: the PC\'s next value and the link value of jal / jalr) is fifteen half adders and a NOT.',
    without: 'Every incrementer bit would be a full adder with b = 0: 9 NANDs instead of 5.',
    cost: 'The XOR\'s first NAND already computes ¬(a·b); one more NAND inverts it into the carry: 5 NANDs, depth 3, the carry at depth 2. A separate XOR and AND cost 6.',
    alts: [{ name: 'Separate XOR and AND', nand: 6, depth: 3, note: 'XOR (4 NANDs, depth 3) and AND (2, depth 2) side by side, sharing nothing.' }],
  },
  a_fa: {
    problem: 'The half adder adds one column but has nowhere to put the carry coming in from the column to its right. A <b>full adder</b> takes it as a third input, so sixteen in a row add two 16-bit words: the ALU\'s <code>add</code>, <code>sub</code> and <code>slt</code>, every load and store address and every branch target go through that chain.',
    without: 'Only 1-bit sums: a chain of half adders can add a constant 1, never a second word.',
    cost: 'Two half adders and an OR cost 13 NANDs, depth 7, with 4 delays from carry in to carry out. Par shares the two XORs\' first NANDs with the carry: 9 NANDs, depth 6, and 2 delays from carry in to carry out. Of a 16-bit ripple adder\'s 36 delays, 28 are that path, bits 1 to 14.',
    alts: [{ name: 'Two half adders + OR', lib: 'full_adder_ha' }, { name: 'PLA (AND and OR planes)', lib: 'pla_fa' }],
  },
  a_add4: {
    problem: 'Four full adders, each carry out wired to the next carry in, add two 4-bit words: the carry ripples from bit 0 upward. It is the unit RV16\'s 16-bit adders are built from, four per adder, in the next-PC logic\'s pc + imm and rs1 + imm. Correct and cheap; its delay grows with the width.',
    without: 'Without a carry chain bit k must see every lower bit directly: as a two-level circuit the top sum bit of a 4-bit adder has 9 inputs, of a 16-bit adder 33.',
    cost: 'Four 9-NAND full adders: 36 NANDs, depth 12 (5 to the first carry out, 2 for each of bits 1 and 2, 3 for the last sum). At this width lookahead does not pay: the library\'s 4-bit carry-lookahead adder is 106 NANDs, depth 15, and a 4-bit Kogge–Stone 62 NANDs, depth 12.',
    alts: [{ name: '4-bit carry-lookahead', lib: 'cla4' }, { name: '4-bit Kogge–Stone', lib: 'ks4' }],
  },
  a_add16: {
    problem: 'RV16 words are 16 bits. Four 4-bit adders, the carry out of each into the next, add them. The next-PC logic has two: pc + imm for taken branches and jal, rs1 + imm for jalr. The ALU\'s adder / subtractor and the branch comparator\'s less-than carry the same chain.',
    without: 'No branch or jump targets and no 16-bit arithmetic: the ALU, the comparator and the next-PC logic all start from this adder.',
    cost: '144 NANDs, depth 36: the carry crosses every bit, and the single-cycle core\'s critical path runs through such chains. A 16-bit Kogge–Stone adder (Fast adders, later in this act) is 362 NANDs, depth 14 as its level builds it (the library\'s, listed below, 366 and 16); a carry-select adder 312 NANDs, depth 20.',
    alts: [{ name: 'Kogge–Stone (parallel prefix)', lib: 'ks16' }, { name: 'Carry-select, 4-bit blocks', lib: 'csel16_4' }],
  },
  a_inc16: {
    problem: 'The PC advances by one word every cycle, and jal / jalr save pc + 1 as the return address. Adding the constant 1 needs no b input: bit 0 is ¬a0 and the carry into bit k is a0·…·a(k−1), so a chain of half adders does it. The PC level builds one into its loop; in the complete core the next-PC logic\'s pc + 1 feeds both the PC and the link value, so one incrementer serves both.',
    without: 'A 16-bit adder with b = 0 and cin = 1 does the same work for 144 NANDs, depth 36.',
    cost: 'Bit 0 is a NOT (its carry out is a0 itself) and bits 1–15 are half adders: 76 NANDs, depth 31. Sixteen half adders, as the library builds it, are 80 NANDs, depth 33. A prefix incrementer is 159 NANDs, depth 11: a PC built on it clocks at 21 delays instead of 41, which the single-cycle core does not need: its own clock period is 79 delays without memories (98 with the bench\'s 8-delay memories).',
    alts: [{ name: 'Sixteen half adders (library)', lib: 'inc16' }, { name: 'Ripple adder with b = 0, cin = 1', lib: 'rca16' }, { name: 'Prefix incrementer', lib: 'incf16' }],
  },
  a_addsub16: {
    problem: 'sub, slt / sltu and blt / bge all subtract. In two\'s complement a − b = a + ¬b + 1, so one adder does both: an XOR per bit inverts b when sub = 1, and sub is also the carry in. The ALU subtracts this way for sub, slt and sltu; the v output flags signed overflow. The branch comparator, which only needs the carry, inverts b with plain NOTs.',
    without: 'A separate subtractor (16 inverters and a second adder) and a bus mux to choose: 368 NANDs against 212.',
    cost: '144 for the adder, 64 for the 16 XORs, 4 for the overflow XOR: 212 NANDs, depth 41. The XORs put 3 delays in front of the carry chain. With a Kogge–Stone adder inside: 430 NANDs, depth 19.',
    alts: [
      { name: 'Fast adder / subtractor (Kogge–Stone)', lib: 'addsubks16' },
      { name: 'Separate adder and subtractor + bus mux', nand: 368, depth: 39, note: 'rca16 (144) for a + b, 16 NOTs and a second rca16 (160) for a + ¬b + 1, mux2x16 (64): 1 + 36 + 2 delays.' },
    ],
  },
  a_slt: {
    problem: 'slt / sltu write 1 when rs1 < rs2, and blt / bge branch on it. Both orders come from one subtraction a + ¬b + 1: unsigned, a < b exactly when there is no carry out. Signed, when the signs differ a < b exactly when a is negative; when they agree the difference cannot overflow and the unsigned answer holds. The ALU derives both from its own adder / subtractor (signed as N ⊕ V); the branch comparator holds this block for blt / bge.',
    without: 'The sign bit alone fails on overflow: 0x7FFF < 0x8000 is false as signed numbers, yet 0x7FFF − 0x8000 = 0xFFFF reads negative.',
    cost: 'Only the carry out is read, so 16 NOTs invert b in place of the subtractor\'s XORs; ltu = ¬cout, an XOR compares the signs and three NANDs and a NOT pick a15 or ltu: 169 NANDs, depth 39. The adder\'s sum gates are still there, unused; only a carry-only chain would drop them. On the adder / subtractor, N ⊕ V costs 217 NANDs, depth 44. A tree magnitude comparator computes one of the two orders in 237 NANDs, depth 23: faster, larger, and with no adder to share.',
    alts: [{ name: 'Adder / subtractor, then N ⊕ V and ¬cout', nand: 217, depth: 44, note: 'addsub16 (212, depth 41) with sub = 1, an XOR (4) for N ⊕ V and a NOT (1) on the carry.' }, { name: 'Tree magnitude comparator (signed only)', lib: 'cmp16s' }],
  },
  a_shift16: {
    problem: 'sll, srl, sra and their immediate forms shift by 0 to 15 places in one cycle. Each of the four shift-amount bits controls a level of muxes shifting by 1, 2, 4 or 8; a level that is off passes the word through. The ALU has one right shifter for all three: a left shift reverses the bits before and after it, and sra fills with the sign bit instead of 0.',
    without: 'A left shift by k could be k additions (x + x); srl and sra would have no short substitute.',
    cost: 'Four shift levels and a reversal level on each side, six 16-bit 2:1 muxes (49 NANDs each), plus 3 gates for the fill: 299 NANDs, depth 14. A left-only shifter of these muxes is 196 NANDs, depth 9 (the library\'s, with 64-NAND muxes, 256): sharing one array between both directions costs the two reversal levels (98 NANDs) instead of a second array.',
    alts: [
      { name: 'Left shifter only (4 levels)', lib: 'shl16_4' },
      { name: 'A 16:1 mux per output bit', nand: 960, depth: 9, note: 'One direction only: sixteen 1-bit 16:1 muxes (60 NANDs, depth 9 each), each output bit picking its source bit.' },
    ],
  },
  a_alu16: {
    problem: 'The execute stage: ten operations (add, sub, sll, slt, sltu, xor, srl, sra, or, and) on two 16-bit operands, selected by a 4-bit word {OPX, f3} from the control unit. Every R-type and immediate arithmetic instruction computes here, and so does every lw / sw address (rs1 + imm). Branches are decided by the separate branch comparator.',
    without: 'One unit per instruction class with its own result path: add, sub, slt and sltu would not share an adder, and the write-back mux would grow.',
    cost: 'All units compute in parallel and an 8:1 bus mux on f3 picks one: 1055 NANDs, depth 64. The mux tree (343) and the shifter (299) cost more than the adder / subtractor (212), but the depth is the adder\'s: with a Kogge–Stone adder the ALU is 1273 NANDs, depth 42.',
    alts: [{ name: 'ALU with a Kogge–Stone adder', lib: 'rv16_alu16ks' }],
  },
  o_fastadd: {
    problem: 'In a ripple adder the carry crosses every bit at 2 delays each, and that chain is on the single-cycle core\'s critical path: the ALU, the branch comparator and the next-PC adders all ripple. A parallel-prefix adder computes every carry from generate / propagate pairs (g = a·b, p = a ⊕ b), combined in log2(16) = 4 levels, so the carry into bit k no longer waits for bit k − 1.',
    without: 'Depth doubles with the width: 36 for a 16-bit ripple adder, 68 for 32 bits.',
    cost: 'Kogge–Stone: 362 NANDs, depth 14 (the library\'s version 366, depth 16), against the ripple adder\'s 144 and 36; carry-select sits between them (312, depth 20). In the core, the fast ALU makes it 4938 NANDs instead of 4720, and the core level\'s clock period (with the bench\'s 8-delay memories) falls from 98 to 76 delays; fast next-PC adders on top would cost 444 more and buy nothing, being off the critical path.',
    alts: [{ name: 'Ripple carry', lib: 'rca16' }, { name: 'Carry-select, 4-bit blocks', lib: 'csel16_4' }],
  },

  // ---- Act 3 ----------------------------------------------------------------------------------
  s_sr: {
    problem: 'Combinational logic forgets: its outputs follow its inputs. The CPU must hold the PC, its registers and the pipeline\'s state from one cycle to the next. Two NANDs, each one\'s output feeding the other\'s second input, have two stable states: one bit of memory. Every bit of RV16\'s state sits in latches like this, two per flip-flop.',
    without: 'No state, so no PC and no registers: a pure function of its inputs cannot step through a program.',
    cost: '2 NANDs, 8 transistors. With both active-low inputs at 0 both outputs are 1, and releasing them together leaves a race whose winner is unpredictable: the D latch exists to make that input impossible. A 6T SRAM cell is the same feedback pair (two inverters) with two access transistors.',
    alts: [{ name: 'Cross-coupled NOR latch', nand: 8, note: 'Active-high S and R; each NOR is 4 NANDs here, though in CMOS both latches are 8 transistors.' }],
  },
  s_dlatch: {
    problem: 'An SR latch has two inputs that must never be active together. A D latch derives both from one data input and an enable: transparent while e = 1 (q follows d), holding while e = 0, and the forbidden combination cannot occur. Two of them, enabled on opposite clock phases, make each flip-flop of the CPU.',
    without: 'Each stored bit would need set and reset pulses generated separately, and a glitch that made both active at once would corrupt it.',
    cost: 'Par 4 NANDs: s_n = ¬(d·e), and r_n = ¬(s_n·e) uses s_n in place of ¬d. The library\'s latch inverts d with a fifth NAND, so its flip-flop is 2 NANDs larger.',
    alts: [{ name: 'With an inverter on d', lib: 'd_latch' }, { name: 'With an asynchronous reset', lib: 'd_latch_r' }],
  },
  s_dff: {
    problem: 'A latch is transparent for half the cycle, so a value can run around a loop (PC → incrementer → PC) several times while the clock is high. Two latches on opposite phases fix that: the master follows d while clk = 0, the slave copies the master while clk = 1, and q changes only at the rising edge. The PC, the register file, the CSRs and every pipeline register are built from it.',
    without: 'A register of latches would pass its new value straight on to the logic computing its next one: the PC would race ahead within one clock phase.',
    cost: 'Par 9 NANDs: two 4-NAND latches and a NOT on clk. The library\'s flip-flop is 11 (each latch inverts d). The classic 7474 uses six 3-input NAND gates (with its preset and clear) in a different edge-triggered structure.',
    alts: [{ name: 'Library flip-flop (latches invert d)', lib: 'dff' }, { name: 'With an asynchronous reset', lib: 'dff_r' }],
  },
  s_reg4: {
    problem: 'A register keeps its value unless told to load: x[rd] changes only when written, a CSR only on a trap or a CSR instruction, a pipeline register not while its stage is stalled. A mux in front of each flip-flop feeds q back while en = 0: the flip-flop still sees every clock edge and reloads its own value.',
    without: 'Gating the clock instead (clk AND en) saves the muxes, but a glitch on en becomes a clock edge, and the gate delays this clock against every other flip-flop (skew).',
    cost: 'Four par flip-flops (9) and four muxes (4): 52 NANDs; the library\'s register, with 11-NAND flip-flops, is 60. A gated clock would be 38. Real chips do gate clocks, to save power, through a dedicated cell in which a latch holds en steady while clk is high.',
    alts: [
      { name: 'Library register (11-NAND flip-flops)', lib: 'reg4' },
      { name: 'Gated clock (clk AND en)', nand: 38, note: 'Four 9-NAND flip-flops and one AND on the clock; it fails on silicon (glitches on en, skew).' },
    ],
  },
  s_reg16: {
    problem: '16-bit registers hold all of RV16\'s state: the PC, x1–x7, the CSRs, and in the pipeline the instructions, operands and results passed between stages. Four 4-bit registers sharing clk and en make one.',
    cost: 'Four par 4-bit registers make 208 NANDs, the reference; the library\'s, from 11-NAND flip-flops, is 240. Clock period 8: clk-to-q 3, the enable mux 2, setup 3. Where a register loads every cycle (the PC, mstatus) the enable muxes would do no work: 16 bare flip-flops are 144 NANDs, and this level unlocks that register too.',
    alts: [
      { name: 'Library register', lib: 'reg16' },
      { name: 'Sixteen flip-flops, no enable', nand: 144, note: '16 × 9 NANDs; only for a register that loads at every edge.' },
    ],
  },
  s_cnt4: {
    problem: 'A register whose input is its own value plus one counts clock edges: the program counter without jumps, the divider\'s step counter, every timer. A synchronous reset to 0 and an enable make it usable: q ← rst ? 0 : en ? q + 1 : q.',
    cost: 'A 4-bit register, a 4-bit incrementer (20 NANDs, depth 9) and the reset gating. The library\'s counter (register and incrementer, no reset) is 80 NANDs with a clock period of 17: the incrementer\'s carry is inside the loop.',
    alts: [{ name: 'Library counter (no reset)', lib: 'counter4' }],
  },
  s_pc: {
    problem: 'The PC holds the address of the instruction being fetched: the instruction ROM reads the word at pc every cycle. At each rising edge it becomes pc + 1, or the target when the next-PC logic asserts ld (a taken branch, jal, jalr), or 0 while rst is held, reset winning over load. Sixteen flip-flops, an incrementer, a bus mux and a reset.',
    without: 'No sequencing: the CPU could only ever execute the instruction at one fixed address.',
    cost: 'The PC loads at every edge, so it needs no enable: 16 flip-flops 144, incrementer 76, the load mux 49 and the reset as an AND per bit with ¬rst 33: 302 NANDs, clock period 41, the incrementer\'s 31 delays inside the loop. A 16-bit register with enable would add 64 NANDs that do no work. A second bus mux for the reset, its other input the constant 0, is 16 NANDs more at the same depth (the library\'s PC, which the cores place, is built so: 318). A prefix incrementer brings the period to 21 for 385 NANDs; the single-cycle core does not need it, its own period being 79 delays without memories (98 with the bench\'s 8-delay memories).',
    alts: [{ name: 'Reset by a second bus mux (the library\'s PC)', lib: 'rv16_pc' }, { name: 'With a prefix incrementer', nand: 385, note: 'incf16 (159 NANDs, depth 11) in place of the ripple incrementer: clock period 21 instead of 41 (static timing).' }, { name: 'With an enabled register, en tied to 1', nand: 366, note: 'A 16-bit register with enable (208) in place of the 16 bare flip-flops (144).' }],
  },
  s_fsm: {
    problem: 'Some units take several cycles and must remember where they are: the iterative divider keeps a busy flag and a step count, the multicycle core walks fetch → execute → memory → write back. A finite-state machine is a state register plus next-state logic read from a table. This one recognises 1, 0, 1 on a serial input: three states in two flip-flops, with a Mealy output.',
    cost: 'Binary encoding (S0 = 00, S1 = 01, S2 = 10): two flip-flops (18 NANDs) and 10 NANDs of next-state and output logic, 28 in all, clock period 8. One-hot encoding spends a flip-flop per state to make each next-state equation a short OR of ANDs; the RV16 multicycle core uses it.',
  },
  m_ram: {
    problem: 'Memory is registers plus addressing. A decoder on addr, ANDed with we, enables the one word that loads at the clock edge; a mux tree on addr reads the addressed word combinationally. The register file is this circuit with two read ports, and the 64-word RAM the core levels\' bench provides is the same circuit, larger.',
    without: 'Every word would need its own wires to the CPU.',
    cost: 'Four 4-bit registers, a 2→4 decoder with enable and a 4:1 mux: the library\'s version is 306 NANDs (1224 transistors, 77 per bit). An SRAM bit is 6 transistors, read through shared bit lines and a sense amplifier: real memories are arrays of such cells.',
    alts: [{ name: '6T SRAM cell (one bit)', lib: 'sram6t' }],
  },
  m_rf: {
    problem: 'An R-type instruction reads two registers and writes a third in the same cycle, so the register file has two read ports (rs1 = instr[9:7], rs2 = instr[12:10]) and one write port (rd = instr[6:4]). Writes: the 3→8 decoder on rd, enabled by rwe, loads one of x1–x7 at the clock edge. Reads: two 8:1 bus muxes, combinational. x0 always reads 0: a constant, with no register behind it.',
    without: 'With one read port an R-type instruction would take two cycles; a real x0 would spend 208 NANDs storing a value no write may change.',
    cost: 'Seven 16-bit registers (1456), two 8:1 read muxes (343 each) and the decoder (30): 2172 NANDs, nearly half the single-cycle core. Each extra read port is another 343. The pipeline writes the file at the falling edge, so an instruction three behind its producer reads the new value with no third port and no forwarding.',
    alts: [{ name: 'x0 as a real register', nand: 2380, note: 'Eight 16-bit registers instead of seven (+208 NANDs), x0\'s never enabled.' }],
  },

  // ---- Lessons and drills whose case adds to the why --------------------------------------------
  n_twos: {
    problem: 'RV16 is two\'s complement throughout. The 6-bit immediates of addi, lw, sw and the branches are sign-extended by wiring alone: instr[15] fans out to every upper bit, so the immediate generator has no gates. The same adder adds signed and unsigned words; only the comparisons differ (signed less-than looks at the signs or N ⊕ V, unsigned at the carry out), and sra fills with the sign bit.',
  },
  m_mem: {
    problem: 'Programs live in ROM, data in RAM. Built like the register file, a 64-word RAM is 20166 NANDs (80664 transistors, about 79 per bit), over four times the single-cycle core. Real memories are dense arrays: an SRAM bit is 6 transistors, a DRAM bit one transistor and a capacitor. From here on memories are given; the core levels\' bench serves the instruction and data words in the same cycle.',
  },
};
