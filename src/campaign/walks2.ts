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
      text: '{instr[15:7], instr[3]} in bits 15:6 above a 6-bit constant 0, not sign-extended. instr[3] is an immediate bit, so lui owns opcodes 7 and 15; lui then addi builds any 16-bit constant in two instructions. Zero NANDs here: four formats are paid for in the core, by its 4:1 16-bit format mux (192 NANDs).',
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
      text: 'a < b from a + ¬b + 1: the sign of the difference, corrected for overflow (N ⊕ V). 217 NANDs, depth 44: the subtraction\'s carry chain sets the comparator\'s depth. blt and bge use it.',
      parts: ['u2'], codex: ['flags'],
    },
    {
      title: 'Pick by cond[1]',
      text: 'cond = op[1:0]. A MUX2 on cond[1] takes equality for beq and bne (opcodes 8, 9) and less-than for blt and bge (10, 11).',
      parts: ['u0', 'u3'], codex: ['mux'],
    },
    {
      title: 'Invert by cond[0]',
      text: 'take = pick ⊕ cond[0]: bne = ¬(a = b) and bge = ¬(a < b) share one XOR. The opcode table puts the condition in op[1:0], so it needs no decoding. Depth 49: 44 for the less-than, 2 through the mux, 3 through the XOR.',
      parts: ['u4'], codex: ['branches'],
    },
  ],

  c_npc: [
    {
      title: 'pc + 1',
      text: 'The incrementer, a chain of half adders: 80 NANDs, depth 33. Its sum is pc1, the link value that jal and jalr write to rd.',
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
      text: 'A 16-bit 2:1 mux on jalr: rs1 + imm for jalr, pc + imm for everything else. This output sets the block\'s depth, 38: adder 36, mux 2.',
      parts: ['u7'],
    },
    {
      title: 'Load the PC?',
      text: 'ld = jal + jalr + br·take. br masks take, because for any other instruction the comparator compares whatever the rs1 and rs2 fields happen to name. When ld = 0 the PC counts.',
      parts: ['u4', 'u5', 'u6'], codex: ['pc', 'branches'],
    },
  ],

  c_core1: [
    {
      title: 'The program counter',
      text: 'The PC block (register, incrementer, two bus muxes: 448 NANDs) does pc ← rst ? 0 : pc + 1; its load input is tied to 0 and its target to a constant. pc goes out to the bench, which answers instr = imem[pc] in the same cycle.',
      parts: ['u7', 'u8', 'u11'], codex: ['pc', 'singlecycle'],
    },
    {
      title: 'Control',
      text: 'The control unit turns instr into rwe, bimm, isel, the ALU operation and wb: 200 NANDs, depth 13. It is the first block after the instruction memory, so everything it steers waits for it.',
      parts: ['u1'], codex: ['control'],
    },
    {
      title: 'The immediate',
      text: 'The generator is wiring; the 4:1 bus mux on isel (192 NANDs) picks I for addi and the shifts, U for lui. The selected value feeds the ALU\'s b mux and the result mux.',
      parts: ['u2', 'u3'], codex: ['immediates'],
    },
    {
      title: 'Register file',
      text: 'The splitter takes rd = instr[6:4], rs1 = instr[9:7] and rs2 = instr[12:10] straight to the register file: with fixed field positions the reads start without waiting for control. 2 627 NANDs, 53% of the core: seven 16-bit registers (x0 is wired to 0), a write decoder, two 8:1 read muxes. Reads are combinational; x[rd] is written at the rising edge when rwe.',
      parts: ['u0', 'u4'], codex: ['regfile'],
    },
    {
      title: 'ALU operand b',
      text: 'A 16-bit 2:1 mux on bimm: rs2 for R-type, the immediate for addi, the shifts, lw and sw. 64 NANDs.',
      parts: ['u5'],
    },
    {
      title: 'The ALU',
      text: 'rs1 op b, with the operation from control: 1 250 NANDs on a ripple adder. Its result also drives daddr, and rs2 drives dwdata: the reference wires the data port already, so the same chip passes Core II.',
      parts: ['u6'], codex: ['alu', 'datapath'],
    },
    {
      title: 'Write back',
      text: 'A 4:1 bus mux on wb picks what rd receives: the ALU, drdata, pc + 1 (a constant here: no jumps) or the immediate, which lets lui skip the ALU. Period 98 with the bench\'s 8-delay memories: PC → instruction memory → control → immediate mux → ALU → data memory → result mux → register file, and every instruction pays for that path.',
      parts: ['u9', 'u10'], codex: ['criticalpath'],
    },
  ],

  c_core2: [
    {
      title: 'Fetch, as in Core I',
      text: 'The same counting PC. The bench serves instructions and data on separate ports in the same cycle: one memory could not fetch and load at once, so a single-cycle core is Harvard.',
      parts: ['u7', 'u8', 'u11'], codex: ['harvard'],
    },
    {
      title: 'Decode a load or a store',
      text: 'lw: rwe, bimm, isel = 0 (offset instr[15:10]), add, wb = 1. sw: mwe, bimm, isel = 1, add, no rwe; it has no rd, so its offset {instr[15:13], instr[6:4]} uses the rd field\'s bits.',
      parts: ['u1', 'u2', 'u3'], codex: ['loadstore'],
    },
    {
      title: 'Base and data',
      text: 'Both read rs1, the base address. A store also reads rs2, and rd2 goes straight to dwdata.',
      parts: ['u0', 'u4'], codex: ['regfile'],
    },
    {
      title: 'The address',
      text: 'The ALU adds the base and the offset: daddr = rs1 + imm, counted in 16-bit words. The top nine addresses (0xFFF7–0xFFFF) are devices, reached as negative offsets from x0: lw a0, -4(x0) reads IN at 0xFFFC.',
      parts: ['u5', 'u6'], codex: ['mmio'],
    },
    {
      title: 'Load write-back',
      text: 'wb = 1 selects drdata, which the memory returns in the same cycle. No new NANDs over Core I (4 973); the cost is time: the data memory sits behind the ALU, and that path sets the period at 98.',
      parts: ['u9', 'u10'], codex: ['criticalpath'],
    },
  ],

  c_core3: [
    {
      title: 'The PC, now loadable',
      text: 'The same 448-NAND PC block, with its load and target inputs driven this time: pc ← ld ? target : pc + 1. The next-PC logic placed below decides both.',
      parts: ['u10'], codex: ['pc'],
    },
    {
      title: 'Decode',
      text: 'Control and the immediate mux as in Core II. br, jal and jalr now matter, and isel picks B for branches, J for jal, I for jalr.',
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
      text: 'take from rs1, rs2 and op[1:0], in parallel with the ALU: 335 NANDs, depth 49. It reads rd2 directly, since a branch\'s immediate goes to the target adder.',
      parts: ['u7'], codex: ['branches', 'comparator'],
    },
    {
      title: 'Next PC',
      text: 'ld = jal + jalr + br·take, and target = pc + imm or rs1 + imm, with the immediate the core already selected: 440 NANDs. Its pc1 duplicates the PC block\'s own incrementer, which has no output for its sum.',
      parts: ['u8'],
    },
    {
      title: 'Write the link',
      text: 'The result mux\'s third input is now pc1: jal and jalr write the return address. 5 748 NANDs, period still 98: the load path stays longer than the branch path through the comparator and next PC.',
      parts: ['u9'], codex: ['cpi'],
    },
  ],

  c_computer: [
    {
      title: 'The core',
      text: 'Core III as one part, 5 748 NANDs. Its instr and drdata pins expect answers in the same cycle; here parts give them instead of the bench.',
      parts: ['u0'], codex: ['cpu'],
    },
    {
      title: 'Program ROM',
      text: 'A 32-word ROM on pc[4:0], combinational: the word arrives in the cycle its address does. Past 31 the PC wraps onto the same 32 words. It holds the Fibonacci program; Edit program… replaces it with your own RV16 assembly.',
      parts: ['u1', 'u3'], codex: ['rom'],
    },
    {
      title: 'Data RAM',
      text: 'A 64-word RAM on daddr[5:0], written with dwdata at the clock edge and read combinationally into drdata. 20 166 NANDs, 72% of the computer: about 79 transistors per stored bit with the decoder and read mux, against 6 in an SRAM cell.',
      parts: ['u2', 'u7'], codex: ['ram'],
    },
    {
      title: 'Decode the address',
      text: 'Partial decoding on daddr[15] alone: RAM write = dwe·¬daddr[15], LED write = dwe·daddr[15]. A NOT and two ANDs, 5 NANDs; the price is aliasing: every address from 0x8000 up is the LED register, and the RAM repeats 512 times below it.',
      parts: ['u4', 'u5', 'u6'], codex: ['mmio'],
    },
    {
      title: 'LED register',
      text: 'A 16-bit register loaded at the edge when its write is 1: the program\'s sw t0, -5(x0) writes 0xFFFB. Nothing reads it back, so a load from an I/O address returns RAM data. Period 110: the RAM\'s decoder and read mux are slower than the bench\'s 8-delay memory.',
      parts: ['u8'], codex: ['register'],
    },
  ],

  // ---- Act 6: the pipeline -----------------------------------------------------------------------
  pi_reg: [
    {
      title: 'The bubble mux',
      text: 'A 16-bit 2:1 mux in front of the register picks d or 0 on clr: 64 NANDs. Zero is a bubble because an all-zero control word has rwe = mwe = br = jal = jalr = 0: an instruction that changes nothing.',
      parts: ['u0', 'u1'], codex: ['flush'],
    },
    {
      title: 'Load on en or clr',
      text: 'The register loads when en + clr. A flush must clear a stage even while it is stalled (en = 0), so clr wins.',
      parts: ['u2'], codex: ['stall'],
    },
    {
      title: 'The register',
      text: 'A 16-bit register with enable, 240 NANDs: q ← clr ? 0 : en ? d : q at the rising edge. 307 NANDs in all, period 8. The finished RV16 has 17 of them, 5 219 NANDs, 35% of the chip.',
      parts: ['u3'], codex: ['register'],
    },
  ],

  pi_core0: [
    {
      title: 'F: the PC',
      text: 'A plain 16-bit register, always enabled, loading pc + 1 (an 80-NAND incrementer), or 0 on rst through the reset mux. These programs have no branches, so nothing else ever loads it.',
      parts: ['u0', 'u2', 'u4', 'u5', 'u6'], codex: ['pipeline'],
    },
    {
      title: 'F/D',
      text: 'Two pipeline registers hold the fetched word and its pc for D. clr = rst, and en = 1: nothing stalls yet.',
      parts: ['u7', 'u8'],
    },
    {
      title: 'D: decode',
      text: 'Control, the immediate generator and the format mux work on F/D\'s word, as in the single-cycle core.',
      parts: ['u9', 'u10', 'u11', 'u12'], codex: ['control'],
    },
    {
      title: 'D: registers, falling edge',
      text: 'The register file is clocked by ¬clk: W writes at mid-cycle and D reads the new value in the second half. An instruction three behind its producer therefore sees the result without forwarding.',
      parts: ['u3', 'u13'], codex: ['regfile'],
    },
    {
      title: 'D/E',
      text: 'Six registers carry the rs1 and rs2 values, the immediate, pc, a control word (rwe, bimm, alu, mwe, wb, br, jal, jalr, cond, packed into 16 bits) and the register numbers. 1 842 NANDs: packing signals into 16-bit words reuses one register type, and the spare bits cost flip-flops all the same.',
      parts: ['u14', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22'],
    },
    {
      title: 'E: execute',
      text: 'The b mux and the ALU compute. The comparator and the next-PC logic are already here, but only next PC\'s pc + 1 (the link value) is used: their other 695 NANDs wait for Pipeline IV. E is the slowest stage at 65 delays, the ripple ALU 55 of them.',
      parts: ['u23', 'u24', 'u25', 'u26', 'u27', 'u28'], codex: ['criticalpath'],
    },
    {
      title: 'E/M',
      text: 'The ALU result, the store data (rs2\'s value), pc + 1, the immediate, and a control word with rwe, mwe, wb and rd. Every value W might write travels separately until wb chooses, in M.',
      parts: ['u29', 'u30', 'u31', 'u32', 'u33', 'u34', 'u35'],
    },
    {
      title: 'M: memory',
      text: 'daddr = E/M\'s ALU result, dwdata = its store data, dwe = mwe: stores are reported from M. The value mux picks ALU, drdata, pc + 1 or the immediate by wb here, so M/W carries one value instead of four.',
      parts: ['u36', 'u37'], codex: ['loadstore'],
    },
    {
      title: 'M/W and write-back',
      text: 'The value, rwe and rd reach the register file\'s write port and the rwe / rwa / rwd pins. 10 290 NANDs, period 65 instead of 98; but with two nops after every instruction the programs take 2 508 cycles, against 824 unpadded on Core II.',
      parts: ['u38', 'u39', 'u40', 'u41', 'u42'], codex: ['cpi'],
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
      parts: ['u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13'], codex: ['pipeline'],
    },
    {
      title: 'D/E',
      text: 'The same six registers. The rs1 and rs2 numbers it carries, unused in Pipeline I, are what E compares now.',
      parts: ['u14', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22'],
    },
    {
      title: 'Forwarding unit',
      text: 'E\'s rs1 and rs2 against rdM / rweM and rdW / rweW, which come back from the M and W control splitters placed below. 110 NANDs, depth 13.',
      parts: ['u25'], codex: ['forwarding'],
    },
    {
      title: 'Operand muxes',
      text: 'One 3:1 mux per operand (a 4:1 bus mux with input 3 tied to 0): 0 the register file, 1 M\'s result, 2 W\'s value. rs2 is forwarded too, because sw stores it and branches compare it. 192 NANDs each.',
      parts: ['u26', 'u27'], codex: ['mux'],
    },
    {
      title: 'Execute',
      text: 'The forwarded operands feed the b mux, the ALU, the comparator and next PC. Forwarding and its mux now sit in front of the ALU, and the period goes from 65 to 78.',
      parts: ['u23', 'u28', 'u29', 'u30', 'u31'], codex: ['criticalpath'],
    },
    {
      title: 'E/M',
      text: 'Unchanged: ALU result, store data, pc + 1, immediate, control.',
      parts: ['u33', 'u34', 'u35', 'u36', 'u37', 'u38'],
    },
    {
      title: 'M: a result to forward',
      text: 'A second 4:1 mux gives M\'s result, with the ALU in drdata\'s place: a load\'s word exists only at the end of M, and these programs leave a nop after every load. The value mux still feeds W.',
      parts: ['u39', 'u40', 'u41'],
    },
    {
      title: 'M/W',
      text: 'W\'s value is written back and forwarded at distance 2; distance 3 is covered by the falling-edge write. +686 NANDs over Pipeline I: 970 cycles instead of 2 508, and 6% fewer NAND delays than Core II.',
      parts: ['u43', 'u44', 'u45', 'u46'], codex: ['cpi'],
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
      parts: ['u3', 'u4', 'u6', 'u7', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15'], codex: ['pipeline'],
    },
    {
      title: 'E, M and W, as before',
      text: 'D/E, forwarding, execute, E/M, the two M muxes and M/W, as in Pipeline II.',
      parts: ['u16', 'u18', 'u20', 'u21', 'u22', 'u23', 'u24', 'u25', 'u28', 'u29', 'u30', 'u31', 'u32', 'u33', 'u34', 'u40', 'u41', 'u42', 'u43', 'u44', 'u45', 'u47', 'u48', 'u50', 'u51', 'u52'],
      codex: ['forwarding'],
    },
    {
      title: 'A load in E',
      text: 'loadE = rwe·(wb = 01), read from E\'s control word: no new pipeline bits.',
      parts: ['u35', 'u36', 'u37', 'u38'],
    },
    {
      title: 'Hazard unit',
      text: 'In D: the instruction being decoded reads the rd of a load in E. That word comes out of memory at the end of M, one cycle too late for E.',
      parts: ['u54'], codex: ['loaduse'],
    },
    {
      title: 'Hold the front',
      text: 'On a stall the PC reloads its own value through a 2:1 mux (the PC register is always enabled), and F/D gets en = ¬stall. The instruction in D is decoded again next cycle.',
      parts: ['u5', 'u8'], codex: ['stall'],
    },
    {
      title: 'Bubble into E',
      text: 'D/E clr = rst + stall, plus a third input tied to 0 that Pipeline IV gives to the flush. The load moves on to M, and a cycle later W forwards its word. +129 NANDs, period unchanged at 78: 917 cycles instead of 970, one lost cycle per load-use pair.',
      parts: ['u19'], codex: ['cpi'],
    },
  ],

  pi_core3: [
    {
      title: 'F and D, as before',
      text: 'The PC with its stall hold, F/D with en = ¬stall, control, immediates, the falling-edge register file and the bubble OR.',
      parts: ['u3', 'u4', 'u5', 'u7', 'u8', 'u9', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u21'], codex: ['pipeline'],
    },
    {
      title: 'E, M and W, as before',
      text: 'D/E, forwarding, execute, the load detector, E/M, M, M/W and the hazard unit, unchanged.',
      parts: ['u18', 'u20', 'u22', 'u23', 'u24', 'u25', 'u26', 'u27', 'u30', 'u31', 'u32', 'u33', 'u34', 'u38', 'u39', 'u40', 'u42', 'u43', 'u44', 'u45', 'u46', 'u47', 'u49', 'u50', 'u52', 'u53', 'u54', 'u56'],
    },
    {
      title: 'Resolve in E',
      text: 'The comparator works on forwarded operands; next PC gives redirect = jal + jalr + br·take and the target. Both have sat in E since Pipeline I; now their outputs go back to F.',
      parts: ['u35', 'u36'], codex: ['branches'],
    },
    {
      title: 'Redirect the PC',
      text: 'A 2:1 mux after the stall hold loads the target when redirect is 1. It would win over a stall, but the two never coincide: a stall needs a load in E, a redirect a branch or jump there.',
      parts: ['u6'], codex: ['controlhazard'],
    },
    {
      title: 'Flush the wrong path',
      text: 'F/D clr = rst + redirect, and redirect is the bubble OR\'s third input: the two younger instructions, fetched as if the branch fell through, become bubbles. +67 NANDs, period 82: forwarding → comparator → next PC → PC is now the critical path. Two cycles per taken branch or jump: 1 495 cycles against Core III\'s 1 236, 1% slower overall.',
      parts: ['u10'], codex: ['flush'],
    },
  ],

  // ---- Act 7: the system -------------------------------------------------------------------------
  y_csr: [
    {
      title: 'A plain write',
      text: 'plain = we·¬trap·¬mret: a csrr* write lands only in a cycle with no trap and no mret. The priority is trap, then mret, then the write.',
      parts: ['u2', 'u3', 'u4'], codex: ['csr'],
    },
    {
      title: 'Which CSR',
      text: 'A 3→8 decoder on sel, each line ANDed with plain: one write enable each for mstatus, mie, mtvec, mepc, mcause and mscratch. mip (2) and mcycle (7) have no register, so writes to them vanish.',
      parts: ['u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11'], codex: ['decoder'],
    },
    {
      title: 'mie, mtvec, mscratch',
      text: 'Three 16-bit registers that load wdata when written, 240 NANDs each. mtvec is also an output: the handler\'s address, which the PC loads on a trap.',
      parts: ['u12', 'u13', 'u14'], codex: ['register'],
    },
    {
      title: 'mepc and mcause',
      text: 'A trap loads pc and cause, a write loads wdata: a 2:1 bus mux on trap and en = trap + write, 67 NANDs over a plain register. mepc is an output too: mret\'s target.',
      parts: ['u15', 'u16', 'u17', 'u18', 'u19', 'u20'], codex: ['traps'],
    },
    {
      title: 'mstatus, written',
      text: 'Always enabled, split into bits 2:0, 3 (MIE), 6:4, 7 (MPIE) and 15:8. A mux per field takes the written bits when mstatus is written and keeps the old ones otherwise; only bits 3 and 7 have more to do.',
      parts: ['u21', 'u22', 'u23', 'u24', 'u25', 'u26', 'u27', 'u28'],
    },
    {
      title: 'MIE and MPIE',
      text: 'MIE\' = trap ? 0 : mret ? MPIE : written; MPIE\' = trap ? MIE : mret ? 1 : written. A trap turns interrupts off and remembers the old enable in MPIE; mret puts it back.',
      parts: ['u29', 'u30', 'u31', 'u32'], codex: ['interrupts'],
    },
    {
      title: 'Read port',
      text: 'An 8:1 bus mux on sel, 448 NANDs. mip is irq at bit 11 (MEIP), and mcycle reads 0. The whole file runs at period 19.',
      parts: ['u1', 'u34', 'u35', 'u36', 'u37'], codex: ['mux'],
    },
    {
      title: 'Interrupt request',
      text: 'intr = MIE·mie[11]·irq, one 3-input AND. The core takes the interrupt whenever it is 1.',
      parts: ['u38', 'u39'], codex: ['interrupts'],
    },
  ],

  y_trap: [
    {
      title: 'Core III, as before',
      text: 'Control, immediates, register file, ALU, comparator, next PC, result mux and PC are Core III\'s.',
      parts: ['u0', 'u1', 'u2', 'u4', 'u5', 'u19', 'u20', 'u21', 'u22', 'u26', 'u32'], codex: ['singlecycle'],
    },
    {
      title: 'Illegal-instruction detector',
      text: 'Given: ill = 1 for a SYSTEM word other than ecall, ebreak, mret, wfi and csrr*, an OPX other than sub and sra, shift type 3, or any MD instruction. 158 NANDs, depth 18, a function of the 16-bit word alone.',
      parts: ['u3'], codex: ['traps'],
    },
    {
      title: 'System decode',
      text: 'Given: opcode 0 with f3 = 0 is ecall, ebreak or mret by its rs2 field (1, 2, 3); f3 = 1–3 is csrrw / csrrs / csrrc. It also computes the CSR write value (rs1, old | rs1, old & ¬rs1) and its enable: csrrs and csrrc with rs1 = x0 only read. 533 NANDs.',
      parts: ['u6'],
    },
    {
      title: 'CSR file',
      text: 'sel is the rs2 field, wdata and we come from system decode, and the old value goes back to it. The irq input is tied to 0 here. 2 156 NANDs, the biggest addition.',
      parts: ['u7', 'u8'], codex: ['csr'],
    },
    {
      title: 'Trap and cause',
      text: 'trap = ill + ecall + ebreak (+ intr, always 0 here). Three bus muxes on constants pick mcause: ebreak 3, ecall 11, illegal 2, interrupt 0x800B. Bit by bit the cause is mostly constant (bit 1 is always 1, bit 15 is intr), so a few gates could replace these 192 NANDs.',
      parts: ['u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17'], codex: ['traps'],
    },
    {
      title: 'The instruction does not run',
      text: 'rwe = (rwe + csr)·¬trap and mwe = mwe·¬trap: a trapping instruction writes no register and stores nothing. The csr term lets csrr* write rd.',
      parts: ['u18', 'u23', 'u24', 'u25'],
    },
    {
      title: 'The CSR result',
      text: 'A 2:1 bus mux after the result mux: a CSR instruction writes the old CSR value to rd. The CSR read joins the result path, and the period rises from 98 to 100.',
      parts: ['u27'], codex: ['criticalpath'],
    },
    {
      title: 'mtvec and mepc',
      text: 'target = trap ? mtvec : mret ? mepc : next PC\'s target, and the PC loads on ld·¬trap + trap + mret. At the same edge the CSR file saves pc in mepc, so ecall\'s handler must add 1 to mepc before mret to skip it.',
      parts: ['u28', 'u29', 'u30', 'u31'], codex: ['pc'],
    },
  ],

  y_irq: [
    {
      title: 'Core III, as before',
      text: 'Control, immediates, register file, ALU, comparator, next PC, result mux and PC.',
      parts: ['u0', 'u1', 'u2', 'u4', 'u5', 'u18', 'u19', 'u20', 'u21', 'u25', 'u31'], codex: ['singlecycle'],
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
      text: 'intr steers the last mux of the cause chain, so an interrupt wins over an exception of the same instruction. Bit 15 marks an interrupt; 11 is machine external.',
      parts: ['u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16'],
    },
    {
      title: 'Nothing runs',
      text: '¬trap cancels the register write and the store. mepc ← pc, so after mret the interrupted instruction runs from the start.',
      parts: ['u17', 'u22', 'u23', 'u24', 'u26'],
    },
    {
      title: 'To the handler',
      text: 'The PC loads mtvec, and MIE drops to 0 so the handler is not interrupted in turn. Zero NANDs over Exceptions: 9 004, period 100.',
      parts: ['u27', 'u28', 'u29', 'u30'], codex: ['traps'],
    },
  ],

  y_final: [
    {
      title: 'Pipeline IV\'s front end',
      text: 'The PC with the stall hold and the redirect mux; F/D with en = ¬stall and clr = rst + redirect.',
      parts: ['u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12'], codex: ['pipeline'],
    },
    {
      title: 'A valid bit',
      text: 'F/D valid loads a constant 1 and clears to 0 with the rest of F/D. A bubble\'s all-zero word is opcode 0, f3 0, rs2 field 0, an illegal SYSTEM encoding: without this bit every bubble would trap. It spends a 307-NAND pipeline register on one bit, where a flip-flop with clear would do.',
      parts: ['u13', 'u14', 'u15'], codex: ['precise'],
    },
    {
      title: 'D: decode, registers',
      text: 'Control, immediates and the falling-edge register file. The valid bit rides in the control word, in the slot the earlier pipelines filled with 0.',
      parts: ['u3', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u23'],
    },
    {
      title: 'D/E, with the word',
      text: 'Pipeline IV\'s six registers plus D/E instr, because the illegal detector and system decode read the word in E. The bubble OR as before.',
      parts: ['u24', 'u25', 'u26', 'u27', 'u28', 'u29', 'u30', 'u31'],
    },
    {
      title: 'E: forward and compute',
      text: 'Forwarding, the operand muxes, the ALU, the comparator and next PC, as in Pipeline IV.',
      parts: ['u34', 'u35', 'u36', 'u37', 'u38', 'u39', 'u40'], codex: ['forwarding'],
    },
    {
      title: 'E: CSRs',
      text: 'The detectors and the CSR file work in E, on pcE, with irq from the pin. A CSR instruction reads and writes there, its write gated by valid; the old value travels down as its result.',
      parts: ['u41', 'u42', 'u43', 'u48'], codex: ['csr'],
    },
    {
      title: 'A precise trap',
      text: 'exception = (ill + ecall + ebreak)·valid, interrupt = intr·valid, mret·valid; trap = exception + interrupt, with the single-cycle core\'s cause chain. The instruction in E has written nothing yet; the older ones in M and W complete, the younger ones in F and D are flushed.',
      parts: ['u44', 'u45', 'u46', 'u47', 'u49', 'u50', 'u51', 'u52', 'u53', 'u54', 'u56', 'u57'], codex: ['precise', 'traps'],
    },
    {
      title: 'Cancel and redirect',
      text: '¬trap gates rwe and mwe in E, and a CSR instruction\'s old value replaces the ALU result. target = mtvec on a trap, mepc on mret; redirect = ld·¬trap + trap + mret loads the PC and flushes F/D and D/E. Trap and mret join the redirect path: period 88 (+6).',
      parts: ['u55', 'u58', 'u59', 'u60', 'u61', 'u62', 'u63', 'u64', 'u65'], codex: ['flush'],
    },
    {
      title: 'Load-use, M and W',
      text: 'As in Pipeline IV, except that loadE uses rwe after the ¬trap gate, so a load interrupted in E raises no stall. 15 050 NANDs; the 45 programs take 2 399 cycles, 211 112 NAND delays, against 197 600 on the single-cycle core with traps.',
      parts: ['u67', 'u68', 'u69', 'u72', 'u73', 'u74', 'u75', 'u76', 'u78', 'u79', 'u82', 'u83', 'u85'], codex: ['loaduse'],
    },
  ],
};
