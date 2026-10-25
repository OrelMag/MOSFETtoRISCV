// Authored walkthroughs, acts 5–7 (the main path). See walks.ts for the conventions.
// The pipeline and system cores share most of their parts with the level before; their walks
// gather what an earlier level explained into an "as before" step and spend the others on what
// the level adds.

import type { WalkScript } from './walk';

export const WALKS2: Record<string, WalkScript> = {
  // ---- Act 5: the single-cycle core --------------------------------------------------------------
  c_imm: [
    {
      title: 'Cut the word at the fields',
      text: 'The splitter cuts instr into [2:0], [3], rd [6:4], rs1 [9:7], rs2 [12:10], [14:13] and [15]. Every immediate is a regrouping of these pieces. instr[15] is the sign bit of all four formats, because RV16 keeps the immediate bits in the same place in every format.',
      parts: ['u0'], codex: ['formats'],
    },
    {
      title: 'I: instr[15:10]',
      text: 'The merger puts instr[12:10], instr[14:13] and instr[15] in bits 5:0 and copies instr[15] into bits 15:6. Sign extension is fan-out: the 6-bit 111111 becomes 0xFFFF = −1. addi, lw and jalr use it, with offsets −32 to 31.',
      parts: ['u2'], codex: ['signext', 'immediates'],
      ask: {
        question: 'addi\'s field instr[15:10] reads 111110. Which 16-bit value must the generator output?',
        options: ['0xFFFE', '0x003E', '0x00FE', '0x803E'],
        answer: 0,
        explain: '111110 is −2 in six bits; sign extension copies instr[15] into bits 15:6, giving 0xFFFE. In hardware that is fan-out: zero gates.',
        why: ['', 'Zero extension reads the field as 62, but addi takes offsets from −32 to 31: the top bit is a sign.', 'The ALU adds 16-bit words: all ten upper bits must copy the sign, not just two.', 'Two\'s complement is not sign-magnitude: 0x803E is −32 706.'],
      },
    },
    {
      title: 'S/B: f3 and rd',
      text: '{instr[15:13], instr[6:4]}: the low three bits sit in the rd field, because sw and the branches write no register. The same sign fan-out fills bits 15:6, so the range is again −32 to 31 words.',
      parts: ['u3'],
    },
    {
      title: 'J: nine bits',
      text: 'instr[15:7], sign-extended: jal reaches pc − 256 to pc + 255. The rd field stays free for the link register.',
      parts: ['u4'],
    },
    {
      title: 'U: the upper ten bits',
      text: '{instr[15:7], instr[3]} in bits 15:6 above a 6-bit constant 0, not sign-extended. instr[3] is an immediate bit, so lui owns opcodes 7 and 15; lui then addi builds any 16-bit constant in two instructions. Zero NANDs here: four formats are paid for in the core, by its 16-bit format mux (a 4:1 bus mux, 147 NANDs, once jumps need the J format).',
      parts: ['u1', 'u5'],
    },
  ],

  c_ctl: [
    {
      title: 'One line per opcode',
      text: 'A 4→16 decoder on instr[3:0] raises exactly one of y0…y15: 100 NANDs, depth 5, half of the unit. Three outputs need nothing more: mwe = y14 (sw), jal = y12, jalr = y13.',
      parts: ['u0', 'u1'], codex: ['decoder', 'control'],
    },
    {
      title: 'Shared terms',
      text: 'LUI = y7 + y15: op[3] is an immediate bit, so lui has two opcodes. OP | OPX = y1 + y2 marks the R-type instructions, whose ALU operation comes from f3. Several signals below reuse each OR.',
      parts: ['u2', 'u3'],
    },
    {
      title: 'Write rd, ALU b from imm',
      text: 'rwe = OP + OPX + ADDI + SHI + LW + LUI + JAL + JALR, an 8-input OR (21 NANDs, depth 6). LUI arrives at depth 7, so rwe ends at 13, the unit\'s depth. bimm = ADDI + SHI + LW + SW: lui, jumps and branches leave it a don\'t-care, so four lines suffice.',
      parts: ['u4', 'u5'], codex: ['dontcare'],
    },
    {
      title: 'Immediate format, branch',
      text: 'isel = 0 I, 1 S/B, 2 J, 3 U, so isel0 = branches + SW + LUI and isel1 = JAL + LUI; addi, lw and jalr get I with no term at all. br = y8 + y9 + y10 + y11. isel0 has six lines, so its 8-input OR has two inputs tied to 0.',
      parts: ['u8', 'u9', 'u10'],
    },
    {
      title: 'Write-back source',
      text: 'wb = 0 ALU, 1 memory, 2 pc + 1, 3 the immediate: wb0 = LW + LUI, wb1 = JAL + JALR + LUI, and R-type and addi get 0 for free. Stores and branches write nothing, so their wb is a don\'t-care.',
      parts: ['u11', 'u12'],
    },
    {
      title: 'The ALU operation',
      text: 'For R-type, alu = {OPX, f3}: alu[k] = (OP | OPX)·f3[k] and alu3 = OPX, so addi, lw and sw get 0000 = add with no term of their own. The immediate shifts take their type from instr[15:14]: sll 0001, srl 0101, sra 1101. So SHI is ORed into alu0, SHI·(f2 + f1) into alu2 and SHI·f2 into alu3.',
      parts: ['u13', 'u14', 'u15', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21'], codex: ['alu'],
      ask: {
        question: 'For R-type, alu = {OPX, f3}: alu[k] = (OP | OPX)·f3[k]. addi, lw and sw must add (code 0000). What does the unit need for them?',
        options: ['Nothing: their alu bits are already 0', 'An OR of ADDI, LW and SW into each alu bit', 'A 4-bit mux that selects 0000 for them', 'f3 passed through for every opcode'],
        answer: 0,
        explain: 'Every term of alu is gated by an R-type line (or SHI), so any other opcode gets 0000, which is add: the three instructions cost no logic at all.',
        why: ['', 'Raising bits would select another operation: add is the code with no bit set.', 'The AND with OP | OPX already gives 0000 off R-type; a mux would buy zeros that are free.', 'In lw and addi, instr[15:13] is part of the immediate: passing it on would pick an operation from the offset.'],
      },
    },
  ],

  c_br: [
    {
      title: 'Equality',
      text: '16 XORs flag the bits that differ, and a zero detect over them gives a = b: 110 NANDs, depth 12. beq and bne need nothing else.',
      parts: ['u1'], codex: ['comparator'],
    },
    {
      title: 'Signed less-than',
      text: 'a < b from a + ¬b + 1: 16 NOTs and a 16-bit adder of which only the carry is read, ltu = ¬cout; when the signs differ, a\'s sign alone decides lt. 169 NANDs, depth 39: the adder\'s carry chain sets the comparator\'s depth. blt and bge use it.',
      parts: ['u2'], codex: ['flags'],
    },
    {
      title: 'Pick by cond[1]',
      text: 'cond = op[1:0]. A MUX2 on cond[1] takes equality for beq and bne (opcodes 8, 9) and less-than for blt and bge (10, 11).',
      parts: ['u0', 'u3'], codex: ['mux'],
    },
    {
      title: 'Invert by cond[0]',
      text: 'take = pick ⊕ cond[0]: bne = ¬(a = b) and bge = ¬(a < b) share one XOR. The opcode table puts the condition in op[1:0], so it needs no decoding. 287 NANDs, depth 44: 39 for the less-than, 2 through the mux, 3 through the XOR.',
      parts: ['u4'], codex: ['branches'],
      ask: {
        question: 'The mux gives a = b for opcodes 8, 9 and a < b for 10, 11. bne (9) and bge (11) need the opposite. How do they get it?',
        options: ['One XOR with cond[0] after the mux', 'Two more comparators, for a ≠ b and a ≥ b', 'A 4:1 mux over eq, ¬eq, lt and ¬lt', 'Swap a and b in the comparator for bge'],
        answer: 0,
        explain: 'bne = ¬(a = b) and bge = ¬(a < b), and cond[0] is 1 for exactly those two: take = pick ⊕ cond[0], 4 NANDs.',
        why: ['', 'Inverting a result costs one gate; the existing comparators (110 and 169 NANDs) already hold the information.', 'It works, but cond[0] alone says whether to invert: one XOR replaces the wider mux and two inverters.', 'b < a is a > b, not a ≥ b: equal operands would not branch.'],
      },
    },
  ],

  c_npc: [
    {
      title: 'pc + 1',
      text: 'The incrementer: a NOT for bit 0, half adders for bits 1 to 15, 76 NANDs, depth 31. Its sum is pc1, the link value that jal and jalr write to rd; in the core it is also the PC\'s next value.',
      parts: ['u1'], codex: ['incrementer'],
    },
    {
      title: 'Branch and jal target',
      text: 'pc + imm on a 16-bit ripple adder with carry in 0: 144 NANDs, depth 36. Offsets count words, so the immediate needs no shift.',
      parts: ['u0', 'u2'], codex: ['ripple'],
    },
    {
      title: 'jalr target',
      text: 'rs1 + imm, on a second adder: jalr returns through ra and calls through a pointer. Muxing pc and rs1 in front of one adder would save 144 NANDs, and put the jalr select in front of the 36-deep adder instead of after it.',
      parts: ['u3'],
    },
    {
      title: 'Choose the target',
      text: 'A 16-bit 2:1 mux on jalr (49 NANDs): rs1 + imm for jalr, pc + imm for everything else. This output sets the block\'s depth, 38: adder 36, mux 2.',
      parts: ['u7'],
    },
    {
      title: 'Load the PC?',
      text: 'ld = jal + jalr + br·take. br masks take, because for any other instruction the comparator compares whatever the rs1 and rs2 fields happen to name. When ld = 0 the PC counts. 421 NANDs in all.',
      parts: ['u4', 'u5', 'u6'], codex: ['pc', 'branches'],
      ask: {
        question: 'The comparator\'s take is computed for every instruction, branch or not. What must ld be?',
        options: ['jal + jalr + br·take', 'jal + jalr + take', 'br·take', 'take'],
        answer: 0,
        explain: 'Jumps always load the PC; a branch loads it only when taken. br masks take, which for any other instruction compares whatever the rs1 and rs2 fields name.',
        why: ['', 'An add would jump whenever its rs1 and rs2 fields happen to satisfy the condition.', 'jal and jalr always jump: they need their own terms.', 'Both mistakes: jumps would not load, and any instruction could.'],
      },
    },
  ],

  c_core1: [
    {
      title: 'The program counter',
      text: 'The PC block (register, incrementer, two bus muxes: 318 NANDs) does pc ← rst ? 0 : pc + 1; its load input is tied to 0 and its target to a constant. pc goes out to the bench, which answers instr = imem[pc] in the same cycle.',
      parts: ['u12', 'u8', 'u9'], codex: ['pc', 'singlecycle'],
    },
    {
      title: 'Control',
      text: 'The control unit turns instr into rwe, bimm, isel, the ALU operation and wb: 200 NANDs, depth 13. It is the first block after the instruction memory, so everything it steers waits for it.',
      parts: ['u1'], codex: ['control'],
    },
    {
      title: 'The immediate',
      text: 'The generator is wiring. Core I uses two formats, I for addi and the shifts and U for lui, and isel bit 1 tells them apart: one 16-bit 2:1 mux, 49 NANDs. The selected value feeds the ALU\'s b mux and the result mux.',
      parts: ['u2', 'u3', 'u4'], codex: ['immediates'],
    },
    {
      title: 'Register file',
      text: 'The splitter takes rd = instr[6:4], rs1 = instr[9:7] and rs2 = instr[12:10] straight to the register file: with fixed field positions the reads start without waiting for control. 2 172 NANDs, 56% of the core: seven 16-bit registers (x0 is wired to 0), a write decoder, two 8:1 read muxes. Reads are combinational; x[rd] is written at the rising edge when rwe.',
      parts: ['u0', 'u5'], codex: ['regfile'],
      ask: {
        question: 'Control is 13 NAND delays deep. When can the register file start reading rs1 and rs2?',
        options: ['At once: the fields sit at fixed bits of instr', 'Once control has decoded the format', 'Once the immediate is selected'],
        answer: 0,
        explain: 'RV16 keeps rs1 and rs2 at the same bits in every format, so a splitter wires them straight from instr and the reads overlap control; an instruction that does not use them ignores the values.',
        why: ['', 'Only the register numbers matter, and their position never depends on the format: there is nothing to decode.', 'The immediate goes to the b mux, not to the register file.'],
      },
    },
    {
      title: 'ALU operand b',
      text: 'A 16-bit 2:1 mux on bimm: rs2 for R-type, the immediate for addi and the shifts. 49 NANDs.',
      parts: ['u6'],
    },
    {
      title: 'The ALU',
      text: 'rs1 op b, with the operation from control: 1 055 NANDs on a ripple adder. Its result also drives daddr, and rs2 drives dwdata: the data port is wired, though Core I\'s programs never load or store.',
      parts: ['u7'], codex: ['alu', 'datapath'],
    },
    {
      title: 'Write back',
      text: 'wb is 0 (the ALU) or 3 (the immediate, so lui skips the ALU), and bit 0 tells them apart: one more 2:1 bus mux picks what rd receives. 3 892 NANDs, period 84 with the bench\'s 8-delay memories: PC → instruction memory → control → ALU → result mux → register file, and every instruction pays for that path.',
      parts: ['u10', 'u11'], codex: ['criticalpath'],
    },
  ],

  c_core2: [
    {
      title: 'Fetch, as in Core I',
      text: 'The same counting PC. The bench serves instructions and data on separate ports in the same cycle: one memory could not fetch and load at once, so a single-cycle core is Harvard.',
      parts: ['u7', 'u8', 'u10'], codex: ['harvard'],
    },
    {
      title: 'Decode a load or a store',
      text: 'lw: rwe, bimm, isel = 0 (offset instr[15:10]), add, wb = 1. sw: mwe, bimm, isel = 1, add, no rwe; it has no rd, so its offset {instr[15:13], instr[6:4]} uses the rd field\'s bits. A third format, so the immediate gets a second 2:1 mux: isel[0] picks I or S/B, isel[1] that or U (without jumps J is never picked): 98 NANDs.',
      parts: ['u1', 'u2', 'pick3', 'u3'], codex: ['loadstore'],
      ask: {
        question: 'sw names a base (rs1) and a value to store (rs2) and writes no register. Where does RV16 keep the low three bits of its offset?',
        options: ['In the rd field, instr[6:4]', 'In the rs2 field', 'In the opcode bits', 'Nowhere: store offsets are multiples of 8'],
        answer: 0,
        explain: 'The offset is {instr[15:13], instr[6:4]}: the field sw does not need carries it. That is a third immediate format, so the generator\'s output gets a second 2:1 mux.',
        why: ['', 'rs2 names the register whose value is stored: sw reads it.', 'The opcode tells sw from every other instruction; its bits cannot double as an offset.', 'sw has the same −32 to 31 word range as lw: it needs all six bits.'],
      },
    },
    {
      title: 'Base and data',
      text: 'Both read rs1, the base address. A store also reads rs2, and rd2 goes straight to dwdata.',
      parts: ['u0', 'u4'], codex: ['regfile'],
    },
    {
      title: 'The address',
      text: 'The ALU adds the base and the offset: daddr = rs1 + imm, counted in 16-bit words. The top seven addresses (0xFFF9–0xFFFF) are devices, reached as negative offsets from x0: lw a0, -4(x0) reads IN at 0xFFFC.',
      parts: ['u5', 'u6'], codex: ['mmio'],
    },
    {
      title: 'Load write-back',
      text: 'wb = 1 selects drdata, which the memory returns in the same cycle: the result gets a second 2:1 mux too (wb is 0, 1 or 3: no pc + 1 without jumps). 3 990 NANDs, 98 over Core I for the two extra muxes; the bigger cost is time: the data memory sits behind the ALU, and that path sets the period at 98 instead of 84.',
      parts: ['pick11', 'u9'], codex: ['criticalpath'],
    },
  ],

  c_core3: [
    {
      title: 'The PC, now loadable',
      text: 'pc ← rst ? 0 : ld ? target : pc + 1. The next-PC logic placed below decides ld and target and already computes pc + 1, so the PC is a plain 16-bit register (144 NANDs, no enable: it loads every cycle) behind two 2:1 bus muxes. The 318-NAND PC block would repeat that incrementer.',
      parts: ['u10', 'u11', 'u12', 'u13'], codex: ['pc'],
      ask: {
        question: 'Next PC already computes pc + 1 for the link register. What should the PC itself be now?',
        options: ['A plain register behind load and reset muxes, fed next PC\'s pc + 1', 'Core II\'s 318-NAND PC block, incrementer included', 'A register with enable, loaded only on jumps'],
        answer: 0,
        explain: 'The PC loads every cycle (pc + 1, a target, or 0), so it needs no enable; reusing next PC\'s pc + 1 saves the PC block\'s 76-NAND incrementer.',
        why: ['', 'Its incrementer would compute the same pc + 1 a second time: 76 NANDs for nothing.', 'Between jumps the PC must still count: an enable that is 0 would freeze it.'],
      },
    },
    {
      title: 'Decode',
      text: 'Control as in Core II. br, jal and jalr now matter, and isel picks B for branches, J for jal, I for jalr: a fourth format, so the immediate mux becomes a 4:1 bus mux (147 NANDs).',
      parts: ['u1', 'u2', 'u3'], codex: ['control'],
    },
    {
      title: 'Register file',
      text: 'The splitter also gives cond = instr[1:0] for the comparator. rd1 and rd2 feed the ALU, the comparator and the jalr adder.',
      parts: ['u0', 'u4'],
    },
    {
      title: 'ALU',
      text: 'The b mux and the ALU are unchanged: branches compare in a block of their own, so the ALU gets no branch mode.',
      parts: ['u5', 'u6'],
    },
    {
      title: 'Branch comparator',
      text: 'take from rs1, rs2 and op[1:0], in parallel with the ALU: 287 NANDs, depth 44. It reads rd2 directly, since a branch\'s immediate goes to the target adder.',
      parts: ['u7'], codex: ['branches', 'comparator'],
    },
    {
      title: 'Next PC',
      text: 'ld = jal + jalr + br·take, and target = pc + imm or rs1 + imm, with the immediate the core already selected: 421 NANDs. Its pc1 is the PC\'s next value when ld = 0.',
      parts: ['u8'],
    },
    {
      title: 'Write the link',
      text: 'The result mux becomes a 4:1 bus mux, its third input pc1: jal and jalr write the return address. 4 720 NANDs, period still 98: the load path stays longer than the branch path through the comparator and next PC.',
      parts: ['u9'], codex: ['cpi'],
    },
  ],

  c_computer: [
    {
      title: 'The core',
      text: 'Core III as one part, 4 720 NANDs. Its instr and drdata pins expect answers in the same cycle; here parts give them instead of the bench.',
      parts: ['u0'], codex: ['cpu'],
    },
    {
      title: 'Program ROM',
      text: 'The given 32-word ROM, on pc[4:0] (a splitter takes the low five bits), combinational: the word arrives in the cycle its address does. Past 31 the PC wraps onto the same 32 words. It holds the Fibonacci program; Edit program… replaces it with your own RV16 assembly.',
      parts: ['u1'], codex: ['rom'],
    },
    {
      title: 'Data RAM',
      text: 'A 64-word RAM on daddr[5:0], written with dwdata at the clock edge and read combinationally into drdata. 20 166 NANDs, 74% of the computer: about 79 transistors per stored bit with the decoder and read mux, against 6 in an SRAM cell.',
      parts: ['u2', 'u6'], codex: ['ram'],
    },
    {
      title: 'Decode the address',
      text: 'Partial decoding on daddr[15] alone: RAM write = dwe·¬daddr[15], LED write = dwe·daddr[15]. A NOT and two ANDs, 5 NANDs; the price is aliasing: every address from 0x8000 up is the LED register, and the RAM repeats 512 times below it.',
      parts: ['u3', 'u4', 'u5'], codex: ['mmio'],
      ask: {
        question: 'The program keeps its data in words 0 to 63 and writes the LEDs at 0xFFFB. What is the cheapest decode that keeps the two apart?',
        options: ['daddr[15] alone', 'A 16-bit comparison with 0xFFFB', 'None: the RAM only sees daddr[5:0]'],
        answer: 0,
        explain: 'RAM write = dwe·¬daddr[15], LED write = dwe·daddr[15]: a NOT and two ANDs, 5 NANDs. One bit separates the two ranges the program uses; every other address aliases one of them.',
        why: ['', 'Exact, but it compares 16 bits where one already tells the two ranges apart.', 'Then every store would write the RAM, 0xFFFB as word 59 (0xFFFB mod 64), and the LEDs would have no write enable of their own.'],
      },
    },
    {
      title: 'LED register',
      text: 'A 16-bit register (208 NANDs) loaded at the edge when its write is 1: the program\'s sw t0, -5(x0) writes 0xFFFB. Nothing reads it back, so a load from an I/O address returns RAM data: reading it would take read decoding as well, a 2:1 bus mux on drdata steered by daddr[15] (49 NANDs). 27 083 NANDs, period 110: the RAM\'s decoder and read mux are slower than the bench\'s 8-delay memory.',
      parts: ['u7'], codex: ['register'],
    },
  ],

  // ---- Act 6: the pipeline -----------------------------------------------------------------------
  pi_reg: [
    {
      title: 'The bubble mux',
      text: 'A 16-bit 2:1 mux in front of the register picks d or 0 on clr: 49 NANDs. Zero is a bubble because an all-zero control word has rwe = mwe = br = jal = jalr = 0: an instruction that changes nothing.',
      parts: ['u0', 'u1'], codex: ['flush'],
    },
    {
      title: 'Load on en or clr',
      text: 'The register loads when en + clr. A flush must clear a stage even while it is stalled (en = 0), so clr wins.',
      parts: ['u2'], codex: ['stall'],
      ask: {
        question: 'A flush must clear a stage even while a stall holds it (en = 0). What should the register\'s load enable be?',
        options: ['en + clr', 'en', 'en·¬clr', 'clr'],
        answer: 0,
        explain: 'An OR lets clr load the mux\'s zeros whatever en says: clr wins.',
        why: ['', 'With en = 0 the stage would keep its wrong-path instruction through the flush.', 'That blocks the clear exactly when both arrive together.', 'Then the register would never take d.'],
      },
    },
    {
      title: 'The register',
      text: 'A 16-bit register with enable, 208 NANDs: q ← clr ? 0 : en ? d : q at the rising edge. 260 NANDs in all, period 8. The finished RV16 has 16 of them, 4 160 NANDs, a third of the chip.',
      parts: ['u3'], codex: ['register'],
    },
  ],

  pi_core0: [
    {
      title: 'F: the PC',
      text: 'A plain 16-bit register (144 NANDs, no enable), loading pc + 1 from a 76-NAND incrementer, or 0 on rst through the reset mux. These programs have no branches, so nothing else ever loads it.',
      parts: ['u2', 'u4', 'u5', 'u6'], codex: ['pipeline'],
    },
    {
      title: 'F/D',
      text: 'One pipeline register holds the fetched word for D. clr = rst, and en = 1: nothing stalls yet. The pc stays in F: without branches or jumps, no later stage needs it.',
      parts: ['u7'],
    },
    {
      title: 'D: decode',
      text: 'Control, the immediate generator and the format mux work on F/D\'s word, as in the single-cycle core.',
      parts: ['u8', 'u9', 'u10', 'pick11', 'u11'], codex: ['control'],
    },
    {
      title: 'D: registers, falling edge',
      text: 'The register file is clocked by ¬clk: W writes at mid-cycle and D reads the new value in the second half. An instruction three behind its producer therefore sees the result without forwarding.',
      parts: ['u3', 'u12'], codex: ['regfile'],
      ask: {
        question: 'An instruction three behind its producer is in D in the cycle the producer is in W. How can it read the new value without forwarding?',
        options: ['Write the register file at the falling edge, so D reads the new value in the second half', 'Nothing to do: W writes at the rising edge, before D reads', 'It cannot: it needs a third nop'],
        answer: 0,
        explain: 'Clocked by ¬clk, the register file takes W\'s value at mid-cycle, and D/E captures what D reads at the next rising edge.',
        why: ['', 'D/E captures D\'s reads at the same rising edge at which W would write: D still saw the old value.', 'That works, at one more cycle per instruction; the falling-edge write makes it unnecessary.'],
      },
    },
    {
      title: 'D/E',
      text: 'Five registers carry the rs1 and rs2 values, the immediate, a control word (rwe, bimm, alu, mwe, wb, br, jal, jalr, cond, packed into 16 bits) and the register numbers: 1 300 NANDs. br, jal, jalr and cond ride along unused; packing signals into 16-bit words reuses one register type, and the spare bits cost flip-flops all the same.',
      parts: ['u13', 'u15', 'u16', 'u17', 'u18', 'u19', 'u20'],
    },
    {
      title: 'E: execute',
      text: 'The b mux and the ALU compute, and nothing else happens in E. It is the slowest stage at 65 delays, the ripple ALU 55 of them.',
      parts: ['u21', 'u22', 'u23', 'u24'], codex: ['criticalpath'],
    },
    {
      title: 'E/M',
      text: 'The ALU result, the store data (rs2\'s value), the immediate, and a control word with rwe, mwe, wb and rd. Every value W might write travels separately until wb chooses, in M.',
      parts: ['u26', 'u27', 'u28', 'u29', 'u30'],
    },
    {
      title: 'M: memory',
      text: 'daddr = E/M\'s ALU result, dwdata = its store data, dwe = mwe: stores are reported from M. The value mux picks the ALU, drdata or the immediate by wb (no jumps, so no pc + 1: two 2:1 bus muxes), so M/W carries one value instead of three.',
      parts: ['u31', 'pick34', 'u32'], codex: ['loadstore'],
    },
    {
      title: 'M/W and write-back',
      text: 'The value, rwe and rd reach the register file\'s write port and the rwe / rwa / rwd pins. 7 062 NANDs, period 65 instead of 98; but with two nops after every instruction the programs take 2 508 cycles, against 824 unpadded on Core II.',
      parts: ['u34', 'u35', 'u36', 'u37'], codex: ['cpi'],
    },
  ],

  pi_fwd: [
    {
      title: 'Does M or W write?',
      text: 'vM = rweM·(rdM ≠ 0) and vW = rweW·(rdW ≠ 0): a 3-bit zero detect, a NOT and an AND each. x0 is never forwarded: a write to it is discarded, so forwarding it would hand E a value the register file never holds.',
      parts: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5'], codex: ['forwarding'],
    },
    {
      title: 'Compare rs1',
      text: 'rs1 = rdM and rs1 = rdW: two 3-bit equality comparators (19 NANDs, depth 8 each), each ANDed with its stage\'s write flag.',
      parts: ['u6', 'u7', 'u8', 'u9'], codex: ['comparator'],
    },
    {
      title: 'M before W, for fa',
      text: 'fa[0] = from M; fa[1] = from W·¬(from M). When both stages write rs1, M holds the newer value, so it wins.',
      parts: ['u10', 'u11'],
      ask: {
        question: 'Two instructions in a row write x1, and the next one reads it: M and W both match rs1. Which value goes to E?',
        options: ['M\'s: it is the newer write', 'W\'s: it was written first', 'The register file\'s'],
        answer: 0,
        explain: 'In program order the instruction in M comes after the one in W, so its x1 is the one the reader must see: from W only when M does not match.',
        why: ['', 'W holds the older instruction: its x1 is overwritten by the one in M.', 'The register file was read in D, before either had written x1.'],
      },
    },
    {
      title: 'The same for rs2',
      text: 'A copy of the comparators and the priority logic gives fb. 110 NANDs, depth 13; in front of the ALU, those 13 delays are why Pipeline II\'s period rises from 65 to 78.',
      parts: ['u13', 'u14', 'u15', 'u16', 'u17', 'u18'],
    },
  ],

  pi_core1: [
    {
      title: 'F and D, as before',
      text: 'PC, F/D, control, immediates and the falling-edge register file are Pipeline I\'s.',
      parts: ['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'pick11', 'u11', 'u12', 'u13'], codex: ['pipeline'],
    },
    {
      title: 'D/E',
      text: 'The same five registers. The rs1 and rs2 numbers it carries, unused in Pipeline I, are what E compares now.',
      parts: ['u15', 'u16', 'u17', 'u18', 'u19', 'u20'],
    },
    {
      title: 'Forwarding unit',
      text: 'E\'s rs1 and rs2 against rdM / rweM and rdW / rweW, which come back from the M and W control splitters placed below. 110 NANDs, depth 13.',
      parts: ['u22', 'u23'], codex: ['forwarding'],
    },
    {
      title: 'Operand muxes',
      text: 'One 3:1 choice per operand, fa = 0 the register file, 1 M\'s result, 2 W\'s value (never 3): two 2:1 bus muxes, fa[0] picking M\'s result over the register, fa[1] W\'s value over that, 98 NANDs. rs2 is forwarded too, because sw stores it (and, from Pipeline IV, branches compare it).',
      parts: ['pick26', 'u24', 'pick29', 'u25'], codex: ['mux'],
    },
    {
      title: 'Execute',
      text: 'The forwarded operands feed the b mux and the ALU. Forwarding and its mux now sit in front of the ALU, and the period goes from 65 to 78. The select path sets it: fa and fb settle 13 delays after the clock edge, long after the operands, and every bit of both muxes waits for them.',
      parts: ['u21', 'u26', 'u27'], codex: ['criticalpath'],
    },
    {
      title: 'E/M',
      text: 'Unchanged: ALU result, store data, immediate, control.',
      parts: ['u29', 'u30', 'u31', 'u32', 'u33'],
    },
    {
      title: 'M: a result to forward',
      text: 'A 2:1 mux on wb[1] gives M\'s result, the ALU or the immediate: a load\'s word exists only at the end of M (these programs leave a nop after every load), and without jumps there is no pc + 1. The value mux still feeds W.',
      parts: ['u34', 'u35', 'pick43', 'u36'],
      ask: {
        question: 'Which value should M forward to E?',
        options: ['The ALU result or the immediate, picked by wb[1]', 'The value mux\'s output, a load\'s word included', 'The ALU result only'],
        answer: 0,
        explain: 'A load\'s word exists only at the end of M, so M forwards what it already has: the ALU result, or lui\'s immediate. These programs leave a nop after every load.',
        why: ['', 'Forwarding drdata would put the data memory and the ALU in series in one cycle, the path the pipeline was cut to avoid.', 'lui writes its immediate: a user right after it would read a stale register.'],
      },
    },
    {
      title: 'M/W',
      text: 'W\'s value is written back and forwarded at distance 2; distance 3 is covered by the falling-edge write. 7 417 NANDs, +355 over Pipeline I: 970 cycles instead of 2 508, and 6% fewer NAND delays than Core II.',
      parts: ['u38', 'u39', 'u40', 'u41'], codex: ['cpi'],
    },
  ],

  pi_haz: [
    {
      title: 'A real load',
      text: 'v = loadE·(rdE ≠ 0): a load into x0 writes nothing, so nothing waits for it. A 3-bit zero detect, a NOT and an AND.',
      parts: ['u0', 'u1', 'u5'], codex: ['loaduse'],
    },
    {
      title: 'Does D read it?',
      text: 'rs1 = rdE or rs2 = rdE: two 3-bit comparators and an OR. rs2 counts even for addi and lw, which do not read it: an occasional needless stall costs a cycle and spares decoding which sources each opcode reads.',
      parts: ['u2', 'u3', 'u4'], codex: ['comparator'],
      ask: {
        question: 'The unit compares rs2 with rdE even for addi and lw, whose rs2 field holds immediate bits. What does that cost?',
        options: ['Now and then a needless one-cycle stall', 'Wrong results when the bits match', 'A stall after every load'],
        answer: 0,
        explain: 'A stall only delays: the instruction is decoded again a cycle later. Decoding which sources each opcode reads would add gates to save a rare cycle.',
        why: ['', 'A stall never changes what an instruction computes, only when.', 'Only a match stalls: a load whose rd the next instruction\'s fields do not name costs nothing.'],
      },
    },
    {
      title: 'Stall',
      text: 'stall = match·v: 53 NANDs, depth 12. It sits in D, comparing the instruction being decoded with the load one stage ahead.',
      parts: ['u6'], codex: ['stall'],
    },
  ],

  pi_core2: [
    {
      title: 'F and D, as before',
      text: 'PC, F/D, control, immediates and the falling-edge register file, as in Pipeline II.',
      parts: ['u3', 'u4', 'u6', 'u7', 'u9', 'u10', 'u11', 'u12', 'pick13', 'u13', 'u14', 'u15'], codex: ['pipeline'],
    },
    {
      title: 'E, M and W, as before',
      text: 'D/E, forwarding, execute, E/M, the two M muxes and M/W, as in Pipeline II.',
      parts: ['u17', 'u19', 'u20', 'u21', 'u22', 'u23', 'u24', 'u25', 'u26', 'pick29', 'u27', 'pick32', 'u28', 'u29', 'u30', 'u36', 'u37', 'u38', 'u39', 'u40', 'u41', 'u42', 'pick50', 'u43', 'u45', 'u46', 'u47', 'u48'],
      codex: ['forwarding'],
    },
    {
      title: 'A load in E',
      text: 'loadE = rwe·(wb = 01), read from E\'s control word: no new pipeline bits.',
      parts: ['u31', 'u32', 'u33', 'u34'],
    },
    {
      title: 'Hazard unit',
      text: 'In D: the instruction being decoded reads the rd of a load in E. That word comes out of memory at the end of M, one cycle too late for E.',
      parts: ['u49'], codex: ['loaduse'],
    },
    {
      title: 'Hold the front',
      text: 'On a stall the PC reloads its own value through a 2:1 mux (the PC register is always enabled), and F/D gets en = ¬stall. The instruction in D is decoded again next cycle.',
      parts: ['u5', 'u8'], codex: ['stall'],
      ask: {
        question: 'On a stall the instruction in D must be decoded again next cycle. What do the PC and F/D do?',
        options: ['Both hold: the PC reloads its own value, F/D gets en = 0', 'F/D holds and the PC moves on', 'The PC holds and F/D clears'],
        answer: 0,
        explain: 'The PC register has no enable, so a 2:1 mux feeds pc back to it; F/D gets en = ¬stall. The bubble goes into D/E, behind the load.',
        why: ['', 'The word fetched meanwhile has nowhere to go, since F/D refuses it: that instruction would be skipped.', 'Clearing F/D throws away the very instruction that is waiting for the load.'],
      },
    },
    {
      title: 'Bubble into E',
      text: 'D/E clr = rst + stall, plus a third input tied to 0 that Pipeline IV gives to the flush. The load moves on to M, and a cycle later W forwards its word. 7 531 NANDs, +114, period unchanged at 78: 917 cycles instead of 970, one lost cycle per load-use pair.',
      parts: ['u18'], codex: ['cpi'],
    },
  ],

  pi_core3: [
    {
      title: 'F and D, as before',
      text: 'The PC with its stall hold, F/D instr with en = ¬stall, control, immediates, the falling-edge register file and the bubble OR.',
      parts: ['u3', 'u4', 'u5', 'u7', 'u8', 'u9', 'u11', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18', 'u20', 'u21'], codex: ['pipeline'],
    },
    {
      title: 'E, M and W, as before',
      text: 'D/E, forwarding, execute, the load detector, E/M, M, M/W and the hazard unit, unchanged.',
      parts: ['u22', 'u23', 'u24', 'u26', 'u27', 'u28', 'u29', 'u30', 'pick31', 'u31', 'pick34', 'u32', 'u33', 'u34', 'u37', 'u38', 'u39', 'u40', 'u42', 'u43', 'u44', 'u46', 'u47', 'u48', 'pick53', 'u49', 'u50', 'u52', 'u53', 'u54', 'u55', 'u56'],
    },
    {
      title: 'The pc travels',
      text: 'F/D pc and D/E pc carry each instruction\'s address to E, 520 NANDs: a branch\'s target is its own pc + imm, and by the time it reaches E the PC is two instructions further on.',
      parts: ['u12', 'u25'],
    },
    {
      title: 'Resolve in E',
      text: 'The comparator works on forwarded operands; next PC gives redirect = jal + jalr + br·take, the target and pc + 1. 287 + 421 NANDs.',
      parts: ['u35', 'u36'], codex: ['branches'],
    },
    {
      title: 'Write the link',
      text: 'E/M pc + 1 takes next PC\'s pc1 to M, where the result and value muxes pick it for jal and jalr: the value mux becomes a 4:1 bus mux, the result two 2:1 muxes (a load forwards nothing). Pipelines I to III had no such input.',
      parts: ['u45'],
    },
    {
      title: 'Redirect the PC',
      text: 'A 2:1 mux after the stall hold loads the target when redirect is 1. It would win over a stall, but the two never coincide: a stall needs a load in E, a redirect a branch or jump there.',
      parts: ['u6'], codex: ['controlhazard'],
    },
    {
      title: 'Flush the wrong path',
      text: 'F/D clr = rst + redirect, and redirect is the bubble OR\'s third input: the two younger instructions, fetched as if the branch fell through, become bubbles. 9 218 NANDs, +1 687; period still 78: forwarding → comparator → next PC → F/D clear takes 77. Two cycles per taken branch or jump: 1 495 cycles against Core III\'s 1 236, but 116 610 NAND delays against 121 128, about 4% faster.',
      parts: ['u10'], codex: ['flush'],
      ask: {
        question: 'A taken branch is in E. How many instructions behind it were fetched on the wrong path?',
        options: ['Two: the ones in D and F', 'One: the one in D', 'Three: D, F and the target'],
        answer: 0,
        explain: 'At the edge the PC loads the target, F/D clears (dropping F\'s word) and D/E clears (dropping D\'s): two cycles per taken branch or jump.',
        why: ['', 'F is fetching in the same cycle: its word would enter F/D at the edge.', 'The target is the right path: the PC loads it at that edge.'],
      },
    },
  ],

  // ---- Act 7: the system -------------------------------------------------------------------------
  y_csr: [
    {
      title: 'A plain write',
      text: 'plain = we·¬trap·¬mret: a csrr* write lands only in a cycle with no trap and no mret. The priority is trap, then mret, then the write.',
      parts: ['u1', 'u2', 'u3'], codex: ['csr'],
    },
    {
      title: 'Which CSR',
      text: 'A 3→8 decoder on sel, each line ANDed with plain: one write enable each for mstatus, mie, mtvec, mepc, mcause and mscratch. mip (2) and CSR 7 have no register, so writes to them vanish.',
      parts: ['u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10'], codex: ['decoder'],
    },
    {
      title: 'mie, mtvec, mscratch',
      text: 'Three 16-bit registers that load wdata when written, 208 NANDs each. mtvec is also an output: the handler\'s address, which the PC loads on a trap.',
      parts: ['u11', 'u12', 'u13'], codex: ['register'],
    },
    {
      title: 'mepc and mcause',
      text: 'A trap loads pc and cause, a write loads wdata: a 2:1 bus mux on trap and en = trap + write, 52 NANDs over a plain register. mepc is an output too: mret\'s target.',
      parts: ['u14', 'u15', 'u16', 'u17', 'u18', 'u19'], codex: ['traps'],
    },
    {
      title: 'mstatus, written',
      text: 'A 16-bit register with no enable (144 NANDs): its next value is computed every cycle. It is split into bits 2:0, 3 (MIE), 6:4, 7 (MPIE) and 15:8; a mux per field takes the written bits when mstatus is written and keeps the old ones otherwise. Only bits 3 and 7 have more to do.',
      parts: ['u20', 'u21', 'u22', 'u23', 'u24', 'u25', 'u26', 'u27'],
    },
    {
      title: 'MIE and MPIE',
      text: 'MIE\' = trap ? 0 : mret ? MPIE : written; MPIE\' = trap ? MIE : mret ? 1 : written. A trap turns interrupts off and remembers the old enable in MPIE; mret puts it back.',
      parts: ['u28', 'u29', 'u30', 'u31', 'u32'], codex: ['interrupts'],
      ask: {
        question: 'A trap must turn interrupts off, and mret must later restore whatever the enable was. What does a trap do to MIE and MPIE?',
        options: ['MPIE ← MIE, MIE ← 0', 'MIE ← 0 only', 'MIE ← MPIE', 'MPIE ← 0, MIE ← 1'],
        answer: 0,
        explain: 'MPIE keeps the enable the trap interrupted; mret copies it back into MIE and sets MPIE to 1.',
        why: ['', 'Then mret has nothing to restore: the old enable is lost.', 'That is mret\'s move, not the trap\'s.', 'Backwards: the handler would run with interrupts on and the old enable forgotten.'],
      },
    },
    {
      title: 'Read port',
      text: 'An 8:1 bus mux on sel, 343 NANDs. mip is irq at bit 11 (MEIP), and CSR 7 reads a constant 0. The whole file: 1 765 NANDs, period 17.',
      parts: ['u0', 'u33', 'u34', 'u35', 'u36'], codex: ['mux'],
    },
    {
      title: 'Interrupt request',
      text: 'intr = MIE·mie[11]·irq, one 3-input AND. The core takes the interrupt whenever it is 1.',
      parts: ['u37', 'u38'], codex: ['interrupts'],
    },
  ],

  y_trap: [
    {
      title: 'Core III, as before',
      text: 'Control, immediates, register file, ALU, comparator, next PC, result mux, and the PC register with its load and reset muxes are Core III\'s.',
      parts: ['u0', 'u1', 'u2', 'u4', 'u5', 'u21', 'u22', 'u23', 'u24', 'u28', 'u33', 'u34', 'u35', 'u36'], codex: ['singlecycle'],
    },
    {
      title: 'Illegal-instruction detector',
      text: 'Given: ill = 1 for a SYSTEM word other than ecall, ebreak, mret, wfi and csrr*, an OPX other than sub and sra, shift type 3, or any MD instruction. 158 NANDs, depth 18, a function of the 16-bit word alone.',
      parts: ['u3'], codex: ['traps'],
    },
    {
      title: 'System decode',
      text: 'Given: opcode 0 with f3 = 0 is ecall, ebreak or mret by its rs2 field (1, 2, 3); f3 = 1–3 is csrrw / csrrs / csrrc. It also computes the CSR write value (rs1, old | rs1, old & ¬rs1) and its enable: csrrs and csrrc with rs1 = x0 only read. 439 NANDs.',
      parts: ['u6'],
    },
    {
      title: 'CSR file',
      text: 'sel is the rs2 field, wdata and we come from system decode, and the old value goes back to it. The irq input is tied to 0 here. 1 765 NANDs, the biggest addition.',
      parts: ['u7', 'u8'], codex: ['csr'],
    },
    {
      title: 'Trap and cause',
      text: 'trap = ill + ecall + ebreak (+ intr, always 0 here). mcause is mostly constant bit by bit: bit 1 = 1, bit 15 = intr, bit 0 = intr + ¬ill, bit 3 = intr + ¬ill·ecall, the rest 0. That gives ebreak 3, ecall 11, illegal 2, interrupt 0x800B in 5 NANDs.',
      parts: ['u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18', 'u19'], codex: ['traps'],
      ask: {
        question: 'mcause is 3 for ebreak, 11 for ecall, 2 for an illegal instruction and 0x800B for an interrupt. Which bit is 1 for all four?',
        options: ['Bit 1', 'Bit 0', 'Bit 3', 'Bit 15'],
        answer: 0,
        explain: 'Bit 1 is a constant 1; of the rest only bits 0, 3 and 15 ever change, each a function of ill, ecall and intr. No 16-bit mux of constants is needed.',
        why: ['', 'Illegal (2) has it clear: bit 0 = intr + ¬ill.', 'ebreak (3) and illegal (2) have it clear: bit 3 = intr + ¬ill·ecall.', 'Only the interrupt sets it.'],
      },
    },
    {
      title: 'The instruction does not run',
      text: 'rwe = (rwe + csr)·¬trap and mwe = mwe·¬trap: a trapping instruction writes no register and stores nothing. The csr term lets csrr* write rd.',
      parts: ['u20', 'u25', 'u26', 'u27'],
    },
    {
      title: 'The CSR result',
      text: 'A 2:1 bus mux after the result mux: a CSR instruction writes the old CSR value to rd. The CSR read joins the result path, and the period rises from 98 to 100.',
      parts: ['u29'], codex: ['criticalpath'],
    },
    {
      title: 'mtvec and mepc',
      text: 'target = trap ? mtvec : mret ? mepc : next PC\'s target, and the PC loads on ld + trap + mret: a trap wins in the target mux, so ld needs no ¬trap. At the same edge the CSR file saves pc in mepc, so ecall\'s handler must add 1 to mepc before mret to skip it. 7 257 NANDs, period 100.',
      parts: ['u30', 'u31', 'u32'], codex: ['pc'],
    },
  ],

  y_irq: [
    {
      title: 'Core III, as before',
      text: 'Control, immediates, register file, ALU, comparator, next PC, result mux and PC.',
      parts: ['u0', 'u1', 'u2', 'u4', 'u5', 'u20', 'u21', 'u22', 'u23', 'u27', 'u32', 'u33', 'u34', 'u35'], codex: ['singlecycle'],
    },
    {
      title: 'Exception decoders',
      text: 'The illegal-instruction detector and system decode, as in Exceptions.',
      parts: ['u3', 'u6'], codex: ['traps'],
    },
    {
      title: 'irq into the CSR file',
      text: 'The irq pin replaces Exceptions\' constant 0: mip bit 11 shows it, and intr = MIE·MEIE·irq comes out. The bench raises irq after a store of 1 to IRQ (0xFFF9) and lowers it after a store of 0.',
      parts: ['u7'], codex: ['interrupts', 'csr'],
    },
    {
      title: 'intr joins the trap',
      text: 'trap = ill + ecall + ebreak + intr. The interrupt is taken before the instruction at pc runs, as the golden model does.',
      parts: ['u8', 'u9'],
    },
    {
      title: 'Cause 0x800B',
      text: 'intr sets bit 15 and, through the NANDs on ¬intr, forces bits 0 and 3 to 1, whatever ill and ecall say: an interrupt wins over an exception of the same instruction. Bit 15 marks an interrupt; 11 is machine external.',
      parts: ['u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18'],
    },
    {
      title: 'Nothing runs',
      text: '¬trap cancels the register write and the store. mepc ← pc, so after mret the interrupted instruction runs from the start.',
      parts: ['u19', 'u24', 'u25', 'u26', 'u28'],
      ask: {
        question: 'An interrupt is taken in the cycle an add is at pc. Where must the handler\'s mret return?',
        options: ['To pc: the add has not run', 'To pc + 1: the add completed', 'To mtvec'],
        answer: 0,
        explain: '¬trap cancelled the add\'s register write, so mepc ← pc and the handler returns to mepc unchanged; only ecall\'s handler adds 1.',
        why: ['', 'Its write was cancelled: skipping it would lose the add.', 'mtvec is the handler itself.'],
      },
    },
    {
      title: 'To the handler',
      text: 'The PC loads mtvec, and MIE drops to 0 so the handler is not interrupted in turn. Zero NANDs over Exceptions: 7 257, period 100.',
      parts: ['u29', 'u30', 'u31'], codex: ['traps'],
    },
  ],

  y_ptrap: [
    {
      title: 'Pipeline IV\'s front end',
      text: 'The PC with the stall hold and the redirect mux; F/D instr and F/D pc with en = ¬stall and clr = rst + redirect.',
      parts: ['u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12'], codex: ['pipeline'],
    },
    {
      title: 'A valid bit',
      text: 'One flip-flop with clear: valid ← ¬clr·(en + valid), so it loads 1 with F/D and clears with it. An OR, a NOT, an AND and a 9-NAND flip-flop: 15 NANDs. A bubble\'s all-zero word is opcode 0, f3 0, rs2 field 0, an illegal SYSTEM encoding: without this bit every bubble would trap.',
      parts: ['u13', 'u14', 'u15', 'u16'], codex: ['precise'],
      ask: {
        question: 'Pipelines I to IV needed no valid bit. Why does this one?',
        options: ['A bubble\'s all-zero word would trap as an illegal instruction', 'Bubbles would write registers', 'The hazard unit needs it to stall'],
        answer: 0,
        explain: 'Opcode 0, f3 0, rs2 field 0 is no legal SYSTEM instruction. The valid bit is 0 in a bubble and gates every trap, so only real instructions raise one.',
        why: ['', 'A bubble\'s control word is all zeros: rwe = mwe = 0, as before.', 'The load-use test reads rdE and the load bit, as in Pipeline III.'],
      },
    },
    {
      title: 'D: decode, registers',
      text: 'Control, immediates and the falling-edge register file. The valid bit rides in the control word, in the slot the earlier pipelines filled with 0.',
      parts: ['u3', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22', 'u24'],
    },
    {
      title: 'D/E, with the word',
      text: 'Pipeline IV\'s six registers plus D/E instr, because the illegal detector and system decode read the word in E. The bubble OR as before.',
      parts: ['u25', 'u26', 'u27', 'u28', 'u29', 'u30', 'u31', 'u32'],
    },
    {
      title: 'E: forward and compute',
      text: 'Forwarding, the operand muxes, the ALU, the comparator and next PC, as in Pipeline IV.',
      parts: ['u33', 'u34', 'u35', 'pick36', 'u36', 'pick39', 'u37', 'u38', 'u39', 'u40', 'u41'], codex: ['forwarding'],
    },
    {
      title: 'E: CSRs',
      text: 'The detectors and the CSR file work in E, on pcE; its irq input is tied to 0 (no interrupts yet). A CSR instruction reads and writes there, its write gated by valid; the old value travels down as its result.',
      parts: ['u42', 'u43', 'u44', 'u48'], codex: ['csr'],
    },
    {
      title: 'A precise trap',
      text: 'exception = (ill + ecall + ebreak)·valid, and mret·valid: a bubble never traps and never returns. Here trap = exception. Its cause takes three NANDs: bit 1 is always 1, bit 0 = ¬ill, bit 3 = ¬ill·ecall (2 illegal, 11 ecall, 3 ebreak). The instruction in E has written nothing yet; the older ones in M and W complete, the younger ones in F and D are flushed.',
      parts: ['u45', 'u46', 'u47', 'u50', 'u51', 'u52', 'u56'], codex: ['precise', 'traps'],
    },
    {
      title: 'Cancel and redirect',
      text: '¬trap gates rwe and mwe in E, and a CSR instruction\'s old value replaces the ALU result. target = mtvec on a trap, mepc on mret; redirect = ld + trap + mret loads the PC and flushes F/D and D/E. The 3-input OR lengthens the flush path: period 81 (+3).',
      parts: ['u49', 'u57', 'u58', 'u59', 'u60', 'u61', 'u62', 'u63'], codex: ['flush'],
    },
    {
      title: 'Load-use, M and W',
      text: 'As in Pipeline IV, except that loadE uses rwe after the ¬trap gate, so a load that traps in E raises no stall. 12 031 NANDs; the 44 programs take 2 361 cycles, 191 241 NAND delays, against 194 800 on the single-cycle core with traps (1 948 cycles at period 100).',
      parts: ['u64', 'u65', 'u66', 'u67', 'u69', 'u70', 'u71', 'u72', 'u73', 'u74', 'u75', 'pick80', 'u76', 'u77', 'u79', 'u80', 'u81', 'u82', 'u83'], codex: ['loaduse'],
    },
  ],

  y_final: [
    {
      title: 'Pipeline V',
      text: 'Your pipeline with precise exceptions, as it was: the valid bit, D/E instr, the detectors and the CSR file in E, trap and mret on the redirect. Its CSR file now reads irq from the pin, so mip and intr see the device.',
      parts: ['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22', 'u24', 'u25', 'u26', 'u27', 'u28', 'u29', 'u30', 'u31', 'u32',
        'u33', 'u34', 'u35', 'sel36', 'pick36', 'u36', 'sel39', 'pick39', 'u37', 'u38', 'u39', 'u40', 'u41', 'u42', 'u43', 'u44', 'u45', 'u46', 'u48', 'u49', 'u51', 'u53', 'u55',
        'u61', 'u62', 'u63', 'u64', 'u65', 'u66', 'u67', 'u68', 'u69', 'u70', 'u71', 'u73', 'u74', 'u75', 'u76', 'u77', 'u78', 'u79', 'sel84', 'pick84', 'u80', 'u81', 'u83', 'u84', 'u85', 'u86', 'u87'],
      codex: ['precise'],
    },
    {
      title: 'An interrupt, on a valid instruction',
      text: 'interrupt = intr·valid, one AND. The instruction in E does not run; it is the one mepc names, and mret runs it again.',
      parts: ['u47'], codex: ['interrupts'],
      ask: {
        question: 'An interrupt belongs to no instruction. Must it wait for a valid one in E?',
        options: ['Yes: a bubble has no pc of its own, so mepc would be wrong', 'No: any cycle will do, since the interrupt does not depend on the program', 'No: bubbles never reach E'],
        answer: 0,
        explain: 'A bubble\'s D/E slot was cleared, pc included: taken on it, the interrupt would save mepc = 0, and mret would restart the program instead of resuming it.',
        why: ['', 'The handler returns to mepc: the interrupt must look as if it came just before a real instruction, so one must be in E.', 'A stall or a flush puts one in D/E: the load-use stall, and two after every taken branch.'],
      },
    },
    {
      title: 'Into the trap',
      text: 'trap = exception + interrupt: an OR in front of everything Pipeline V already does on a trap (cancel E, flush, PC ← mtvec).',
      parts: ['u50'], codex: ['traps'],
    },
    {
      title: 'The cause',
      text: 'mcause 0x800B for the interrupt, ahead of every exception: bit 15 = intr, bit 0 = intr + ¬ill, bit 3 = intr + ¬ill·ecall, the single-cycle core\'s five NANDs. 12 038 NANDs, 7 over Pipeline V, period 81; the 45 programs take 2 399 cycles, 194 319 NAND delays, against 197 600 on the single-cycle core with interrupts (1 976 cycles at period 100).',
      parts: ['u52', 'u54', 'u56', 'u60'], codex: ['interrupts'],
    },
  ],
};
