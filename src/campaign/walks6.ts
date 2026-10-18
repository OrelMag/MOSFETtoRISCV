// Authored walkthroughs, group 6: act 9, the GPU (see walks.ts for the conventions). Part ids are
// the reference chips' own (buildk.ts draws lib/rv16/lanes16.ts, warps16.ts and raster16.ts with
// docFromDef). The cores repeat earlier levels' blocks: their walks gather those into "as before"
// steps and spend the others on what the level adds. No DOM.

import type { WalkScript } from './walk';

export const WALKS6: Record<string, WalkScript> = {
  k_lanes: [
    {
      title: 'Operand b, per lane',
      text: 'Each lane gets a 49-NAND 16-bit 2:1 mux: its own b, or the shared immediate when bimm = 1. The immediate is one word for all four lanes, but b is not, so the mux cannot be shared. 196 NANDs.',
      parts: ['u0', 'u1', 'u2', 'u3'], codex: ['mux', 'immediates'],
    },
    {
      title: 'Four ALUs, one operation',
      text: 'Four copies of your 1055-NAND ALU, every one on the same alu code: 4220 of the level\'s 4596 NANDs. Lane i computes y_i from a_i and its operand; the four results differ only because the operands do.',
      parts: ['u4', 'u5', 'u6', 'u7'], codex: ['alu', 'lane', 'simd'],
      ask: {
        question: 'The four ALUs all execute the operation on alu. What do lanes 1 to 3 add to the cost of decoding the instruction?',
        options: ['Nothing: they read the same alu, bimm and imm wires', 'A control unit each', 'A small decoder per lane that turns the instruction into its alu code', 'One control unit per pair of lanes'],
        answer: 0,
        explain: 'One decode drives every lane. The datapath scales with the lanes, the control does not: that is all SIMD is.',
        why: ['', 'Every lane runs the same instruction, so four control units would produce four identical copies of the same signals.', 'The alu code is the same for all four lanes: it is decoded once, outside, and fanned out.', 'Any copy of the control unit is redundant: it would compute the same signals as the first.'],
      },
    },
    {
      title: 'Which lanes have rs1 ≠ 0',
      text: 'Per lane, a 16-input OR (45 NANDs) of a_i\'s bits, then a merger packs the four results into nz. split will test it: lanes whose rs1 is not zero take the then side. 4 × (49 + 1055 + 45) = 4596 NANDs.',
      parts: ['u9', 'u11', 'u13', 'u15'], codex: ['fanin'],
    },
  ],

  k_vrf: [
    {
      title: 'Lane 0\'s registers',
      text: 'Your 8 × 16 register file, 2193 NANDs. wa, ra1 and ra2 are wired to it unchanged: every lane uses the same register numbers. The splitter cuts we into four bits; bit 0 is this file\'s write enable. x0 reads 0 inside it, so it reads 0 in every lane.',
      parts: ['u1'], codex: ['regfile', 'vrf'],
    },
    {
      title: 'Lane 1: same numbers, its own values',
      text: 'A second file on the same wa, ra1, ra2 and clk, with wd1 and we bit 1. ra1 = 3 now reads lane 0\'s x3 on a0 and lane 1\'s x3 on a1: one register name, a value per thread.',
      parts: ['u2'],
      ask: {
        question: 'wa = 5, we = 5 and every wd_i is different. After the clock edge, which lanes\' x5 has changed?',
        options: ['Lanes 0 and 2', 'Lanes 1 and 3', 'All four, each to its own wd', 'Only lane 0: there is one write address'],
        answer: 0,
        explain: 'we = 5 = 0101 sets bits 0 and 2, and bit i is lane i\'s write enable. The other lanes keep their x5.',
        why: ['', 'Bit i belongs to lane i: 5 = 0101 sets bits 0 and 2, not 1 and 3.', 'Each lane writes only when its own bit of we is 1: that is how the mask will switch lanes off.', 'The address is shared, but each file has its own enable: any subset of lanes can write register wa in the same cycle.'],
      },
    },
    {
      title: 'Lanes 2 and 3',
      text: 'Two more files: 4 × 2193 = 8772 NANDs, almost twice the four lanes (4596). Logic can be shared between threads, storage cannot: in the SIMD core this block is 8772 of 15774 NANDs.',
      parts: ['u3', 'u4'], codex: ['register'],
    },
  ],

  k_mask: [
    {
      title: 'Reset forces all on',
      text: 'The OR gives the register its enable: ld or rst. The 4-bit OR forces d to 1111 while rst is 1 (rst copied four times by the merger). After reset every lane runs. 15 NANDs.',
      parts: ['u1', 'u2'], codex: ['activemask'],
    },
    {
      title: 'The mask',
      text: 'A 4-bit register with enable, 52 NANDs: one bit per lane, loaded when ld or rst, else held. Its output is mask, and everything below reads it.',
      parts: ['u3'], codex: ['register'],
    },
    {
      title: 'Any lane on',
      text: 'A 4-input OR of the mask bits, 9 NANDs. With any = 0 the warp has no thread left, and lead means nothing.',
      parts: ['u8'],
    },
    {
      title: 'The leader',
      text: 'lead is the number of the lowest active lane, a priority encoder: bit 1 = ¬m0·¬m1 (no lane below 2 is on), bit 0 = ¬m0·(m1 + ¬m2). Three NOTs, two ANDs and an OR, 10 NANDs. The leader\'s registers will decide branches for the whole warp.',
      parts: ['u5', 'u6', 'u7', 'u9', 'u10', 'u11'], codex: ['leader'],
      ask: {
        question: 'Bit 0 of lead is ¬m0·(m1 + ¬m2). Why is the ¬m2 term there?',
        options: ['So that lead = 3 (binary 11) when lanes 0, 1 and 2 are all off', 'So that lane 2 can lead', 'To choose between lanes 1 and 2 when both are on', 'It is redundant: ¬m0·m1 alone is enough'],
        answer: 0,
        explain: 'Bit 0 is 1 for leaders 1 and 3. Leader 1 is ¬m0·m1; leader 3 (or no lane at all) is ¬m0·¬m1·¬m2, which ¬m0·¬m2 covers once m1 is ORed in.',
        why: ['', 'Lane 2 is 10 in binary: bit 0 must be 0 for it, and ¬m2 is 0 when lane 2 is on.', 'With m1 = 1, m1 + ¬m2 is 1 whatever m2 is: lane 1 wins on its own.', 'Without it, lead would be 2 instead of 3 when only lane 3 is on.'],
      },
    },
    {
      title: 'Only active lanes write',
      text: 'rwe and mwe copied to four bits and ANDed with the mask (8 NANDs each): we and dwe. A masked lane still computes, it just writes nothing, neither a register nor memory. 102 NANDs in all.',
      parts: ['u15', 'u16'], codex: ['and'],
    },
  ],

  k_simd: [
    {
      title: 'One front end',
      text: 'The single-cycle core\'s control unit (200 NANDs) and immediate generator (0), the 147-NAND 4:1 mux that picks the immediate format, and the given lane decoder (73), which spots split, join, tmc and csrr on tid. All decoded once, for the four lanes.',
      parts: ['u1', 'u2', 'u3', 'u4'], codex: ['control', 'immediates', 'warp'],
    },
    {
      title: 'The mask',
      text: 'Your active mask, 102 NANDs. Its rwe is the control unit\'s rwe OR tid (csrr writes rd too); its we and dwe become the lanes\' register and memory write enables, so a masked lane writes nothing. rst sets it to 1111.',
      parts: ['u5', 'u6'], codex: ['activemask'],
    },
    {
      title: 'Lane registers',
      text: 'The lane register file, 8772 NANDs: rd, rs1 and rs2 straight from the instruction fields, we from the mask. It is 56% of the core.',
      parts: ['u7'], codex: ['vrf'],
    },
    {
      title: 'Four lanes',
      text: 'Your four lanes (4596 NANDs) on the registers\' a and b, the shared immediate, bimm and alu. Each lane\'s y is also its memory address (daddr_i), its rs2 the word it stores (dwdata_i).',
      parts: ['u8'], codex: ['lane', 'loadstore'],
    },
    {
      title: 'The leader\'s operands',
      text: 'Two 4:1 bus muxes (147 NANDs each) pick the leader\'s rs1 and rs2, selected by lead. There is one PC: the branch unit, jalr and tmc each need one value, and the leader\'s is the one the warp follows.',
      parts: ['u9', 'u10'], codex: ['leader'],
      ask: {
        question: 'mask = 1110 and beq compares equal in lanes 1 and 2 but not in lane 3. What does the warp do?',
        options: ['Takes the branch, all three lanes: lane 1 leads', 'Falls through, because lane 3 disagrees', 'Takes it only in lanes 1 and 2, and lane 3 falls through', 'Takes the branch because lane 0 leads'],
        answer: 0,
        explain: 'The branch unit sees only the leader\'s operands, and lane 1 is the lowest active lane. Lane 3 follows it to the target: without split, a disagreement is settled by the leader.',
        why: ['', 'No vote is taken: the branch unit compares one pair of operands, the leader\'s.', 'One PC cannot be in two places. Running both sides needs split and the stack, in the SIMT core.', 'Lane 0 is masked off (bit 0 of 1110 is 0): the leader is the lowest active lane.'],
      },
    },
    {
      title: 'Branch and next PC',
      text: 'The branch comparator (287 NANDs) and the next-PC logic (421), as in the single-cycle core, on the leader\'s operands. tmc loads the mask from the low four bits of the leader\'s rs1 (a splitter, no gates).',
      parts: ['u11', 'u13'], codex: ['branches', 'pc'],
    },
    {
      title: 'Results per lane',
      text: 'pc + 1 and the immediate are the same for every lane: one shared mux. Per lane, ALU or memory, then that or the shared value: eight more muxes, the wb bits steering all of them. 9 × 49 = 441 NANDs.',
      parts: ['u15', 'u16', 'u17', 'u18', 'u19', 'u20', 'u21', 'u22', 'u23'], codex: ['datapath'],
    },
    {
      title: 'tid',
      text: 'When the lane decoder says tid, lane i writes the constant i instead: a mux and a constant per lane. This is the only place where the lanes are told apart, and every kernel starts by reading it.',
      parts: ['u25', 'u27', 'u29', 'u31'], codex: ['warp'],
    },
    {
      title: 'The PC',
      text: 'pc + 1 or the branch / jump target, 0 at reset, into a 16-bit register without enable (144 NANDs). One PC for four threads: 15774 NANDs, of which the four datapaths are 4596.',
      parts: ['u32', 'u34', 'u35'], codex: ['pc', 'simd'],
    },
  ],

  k_stack: [
    {
      title: 'Four entries',
      text: 'Each entry holds 26 bits in registers with enable: the mask before the split (52 NANDs), the else lanes (52), the resume PC (208), pending and valid (13 each). 338 NANDs an entry, 1352 for four; entry 0 is the top.',
      parts: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12', 'u13', 'u14', 'u15', 'u16', 'u17', 'u18', 'u19'], codex: ['stack', 'register'],
    },
    {
      title: 'Then, else, both?',
      text: 'then = mask · p (a 4-bit AND), else = mask XOR then: the active lanes whose rs1 is 0. A 4-input OR on each says whether that side has a lane; pending = both do. A split the active lanes agree on parks nobody.',
      parts: ['u25', 'u26', 'u28', 'u32', 'u35'], codex: ['divergence'],
    },
    {
      title: 'What join does',
      text: 'A join on an empty stack (top not valid) does nothing. Otherwise the top\'s pending bit decides: doClr = join · valid · pending sends the else lanes off, doPop = join · valid · ¬pending restores the mask and pops.',
      parts: ['u29', 'u30', 'u33', 'u34'], codex: ['reconvergence'],
      ask: {
        question: 'A split pushed then = 1010, else = 0101. The then lanes reach join. What happens?',
        options: ['mask ← 0101, the PC jumps to the instruction after the split, pending clears', 'mask ← the saved mask and the entry pops', 'mask ← 0101 and the PC carries on after the join', 'A second entry is pushed for the else lanes'],
        answer: 0,
        explain: 'The top is pending, so this is the first join: the else lanes now run the region from its start, and the entry stays for the second join, which restores the mask and pops.',
        why: ['', 'That is the second join. Here the else lanes have not run yet: restoring the mask now would skip them.', 'The else lanes must run the region from its start, the instruction after the split: that is what the saved PC is for.', 'Only split pushes. join reuses the top entry: it clears pending, and the next join pops it.'],
      },
    },
    {
      title: 'Entry 0\'s next value',
      text: 'Two 26-bit 2:1 muxes (104 NANDs each). join: the top with pending cleared (doClr), or entry 1 moving up (doPop). split overrides: the pushed entry (mask, else, pc1, pending, valid = 1).',
      parts: ['u45', 'u46'], codex: ['mux'],
    },
    {
      title: 'Shift down, shift up',
      text: 'Entries 1 to 3 take the entry above on a split (push) and the entry below on a pop, entry 3 a constant 0. A shift register in both directions: three more 26-bit muxes, 312 NANDs.',
      parts: ['u47', 'u48', 'u50'], codex: ['shifter'],
    },
    {
      title: 'Enables and reset',
      text: 'Entry 0 loads on split, join or rst; entries 1 to 3 on split, a pop or rst. rst clears only the valid bits (valid AND ¬rst into each entry): the other fields may hold anything once nothing marks them valid.',
      parts: ['u40', 'u41', 'u42', 'u43', 'u44', 'u52', 'u54', 'u56', 'u58'],
    },
    {
      title: 'The new mask',
      text: 'split: then if pending, else the mask unchanged; join: the top\'s else lanes on doClr, its saved mask on a pop; three 4-bit muxes. ld = split + a join on a non-empty stack. jump is doClr and jpc the top\'s PC, plain wires. 1995 NANDs.',
      parts: ['u59', 'u60', 'u61', 'u62'], codex: ['activemask'],
    },
  ],

  k_simt: [
    {
      title: 'Front end, as before',
      text: 'The SIMD core\'s control unit, immediates and format mux, lane decoder, and rwe = control\'s rwe OR tid. Now split and join from the lane decoder will be used.',
      parts: ['u1', 'u2', 'u3', 'u4', 'u5'], codex: ['control'],
    },
    {
      title: 'Mask, registers, lanes, as before',
      text: 'The active mask (102 NANDs), the lane register file (8772) and the four lanes (4596), wired as in the SIMD core.',
      parts: ['u6', 'u7', 'u8'], codex: ['lane'],
    },
    {
      title: 'Leader, branch, next PC, as before',
      text: 'The leader\'s rs1 and rs2 through two 4:1 bus muxes, the branch comparator and the next-PC logic. A branch the lanes disagree on still follows the leader: the program is expected to split first.',
      parts: ['u9', 'u10', 'u11', 'u13'], codex: ['leader'],
    },
    {
      title: 'The stack',
      text: 'Your reconvergence stack, 1995 NANDs: split and join from the lane decoder, the current mask, rst, and pc1 = the next-PC logic\'s pc + 1, the address the else lanes resume at.',
      parts: ['u14'], codex: ['reconvergence', 'simt'],
      ask: {
        question: 'split rs1 parks the lanes whose rs1 is 0. Which existing signal feeds the stack\'s p input?',
        options: ['The lanes\' nz: a bit per lane, rs1 ≠ 0', 'The branch unit\'s taken bit', 'The lanes\' ALU results y_i', 'The mask'],
        answer: 0,
        explain: 'The four lanes already OR each a_i (rs1) into nz: exactly split\'s predicate, a bit per lane, built before you needed it.',
        why: ['', 'That is one bit, computed from the leader\'s operands only: it cannot tell the lanes apart.', 'y_i depends on the operation and the second operand; split tests rs1 itself.', 'The mask says which lanes are active; the stack ANDs it with p, so p must come from elsewhere.'],
      },
    },
    {
      title: 'Who loads the mask',
      text: 'The mask loads when tmc runs or the stack says so (an OR); a 4-bit mux gives tmc\'s value priority over the stack\'s nmask. 19 NANDs.',
      parts: ['u15', 'u16'], codex: ['activemask'],
    },
    {
      title: 'Results, as before',
      text: 'The shared pc + 1 / immediate mux, ALU or memory and the result per lane, and tid in place of them: thirteen 49-NAND muxes, unchanged from the SIMD core.',
      parts: ['u18', 'u19', 'u20', 'u21', 'u22', 'u23', 'u24', 'u25', 'u26', 'u28', 'u30', 'u32', 'u34'], codex: ['datapath', 'warp'],
    },
    {
      title: 'The join\'s jump',
      text: 'One more 16-bit mux after the branch / jump choice: jpc when the stack jumps. Then reset and the PC register as before. 17837 NANDs, 2063 more than the SIMD core: the price of letting four lanes behave as four threads.',
      parts: ['u35', 'u36', 'u38', 'u39'], codex: ['pc'],
    },
  ],

  k_coal: [
    {
      title: 'The leader, again',
      text: 'The same priority encoder as in your mask: lead bit 1 = ¬m0·¬m1, bit 0 = ¬m0·(m1 + ¬m2). Three NOTs, two ANDs and an OR, 10 NANDs.',
      parts: ['u5', 'u6', 'u7', 'u8', 'u9', 'u10'], codex: ['leader'],
    },
    {
      title: 'The leader\'s line',
      text: 'A line is four 16-bit words: an address without its two low bits, a_i[15:2]. Each lane\'s line, padded with two zero bits to a word, enters a 147-NAND 4:1 bus mux selected by lead: line.',
      parts: ['u17'], codex: ['coalescing', 'mux'],
    },
    {
      title: 'Same line?',
      text: 'Three 14-bit equality comparators (96 NANDs each) compare lanes 1, 2 and 3 with the leader\'s line. 288 of the level\'s 467 NANDs.',
      parts: ['u19', 'u20', 'u21'], codex: ['comparator'],
      ask: {
        question: 'Lanes 1, 2 and 3 each get a comparator. Why does lane 0 need none?',
        options: ['When lane 0 is active it is the leader, so it is always in the line; when inactive it is not served anyway', 'Lane 0\'s address is always aligned to a line', 'Lane 0 is never served together with other lanes', 'The 4:1 mux already compares lane 0\'s line'],
        answer: 0,
        explain: 'served bit 0 is simply mask bit 0: an active lane 0 picked the line itself. Each comparator saved is 96 NANDs.',
        why: ['', 'Addresses are arbitrary; nothing aligns lane 0\'s.', 'Neighbouring threads touching neighbouring words is the common case: lane 0 rides with them.', 'A mux selects, it does not compare.'],
      },
    },
    {
      title: 'Served and left',
      text: 'served = lane 0\'s mask bit, and for lanes 1 to 3 the mask bit AND its comparator. left = mask XOR served (a 4-bit XOR): served never holds an inactive lane, so XOR is subtraction here. 467 NANDs, depth 27.',
      parts: ['u22', 'u23', 'u24', 'u26'], codex: ['xor'],
    },
  ],

  k_warps: [
    {
      title: 'Whose turn',
      text: 'A flip-flop that toggles every cycle: its d is ¬warp AND ¬rst, so warp 0 issues first after reset, then 1, 0, 1. Barrel scheduling: no choice to make and no stall to detect.',
      parts: ['u0', 'u1', 'u2', 'u3'], codex: ['barrel', 'dff'],
    },
    {
      title: 'Shared front end, two new decodes',
      text: 'Control, immediates and their format mux, the lane decoder and rwe = control\'s rwe OR tid, once for both warps. New: bar (SYSTEM, funct3 = 7: op = 0 by a NOR, three bits ANDed) and load (control writes rd from memory: rwe · wb = 01).',
      parts: ['u5', 'u6', 'u7', 'u11', 'u21', 'u12', 'u13', 'u14', 'u15', 'u17', 'u18', 'u19', 'u20'], codex: ['control', 'barrier'],
    },
    {
      title: 'State, twice',
      text: 'Everything that is state is duplicated: per warp a PC with enable (208 NANDs), a mask (102), a stack (1995), lane registers (8772) and a waiting bit for bar (9). 11086 NANDs a warp; the shared parts are paid once.',
      parts: ['u22', 'u23', 'u24', 'u25', 'u26', 'u27', 'u28', 'u29', 'u30', 'u31'], codex: ['vrf', 'warp'],
    },
    {
      title: 'May this warp go?',
      text: 'Three 1-bit muxes pick the issuing warp\'s waiting bit and lanes and the other warp\'s lanes. go = ¬(waiting · the other has lanes) · this warp has lanes; go0 and go1 are go for warp 0 or 1. A warp that does not go loses its turn; nothing of its instruction happens.',
      parts: ['u32', 'u33', 'u34', 'u35', 'u36', 'u37', 'u38', 'u39'],
    },
    {
      title: 'The issuing warp\'s operands',
      text: 'Both warps\' register files read the same rs1 and rs2; eight 16-bit muxes pass the issuing warp\'s to the lanes, a 2-bit mux its leader, and one more mux its PC to the pc pin. 9 × 49 + 8 = 449 NANDs.',
      parts: ['u40', 'u41', 'u42', 'u43', 'u44', 'u45', 'u46', 'u47', 'u48', 'u49'], codex: ['mux'],
    },
    {
      title: 'Lanes, leader, branch: shared',
      text: 'The four lanes, the leader\'s rs1 and rs2, the branch comparator and the next-PC logic: one of each, used by whichever warp issues.',
      parts: ['u50', 'u51', 'u52', 'u53', 'u55'], codex: ['lane', 'leader'],
    },
    {
      title: 'Results of the issuing warp',
      text: 'The shared pc + 1 / immediate mux, ALU or that per lane, then tid = warp · 4 + lane (a merger of constants and the warp bit). No memory input: the word a load asked for is not there yet.',
      parts: ['u56', 'u57', 'u58', 'u59', 'u60', 'u73', 'u74', 'u75', 'u76'], codex: ['warp'],
    },
    {
      title: 'Loads in flight',
      text: 'A load writes nothing when it issues. Its lanes (the mask\'s we, AND load) and rd wait one cycle in two 4-bit registers, which drive lwe and lwa; drdata passes straight to lwd. The issuing warp\'s other writes are we AND ¬load.',
      parts: ['u77', 'u78', 'u83', 'u92', 'u94', 'u124', 'u126', 'u148', 'u150'], codex: ['loadstore', 'barrel'],
      ask: {
        question: 'Warp 0 issues lw in cycle t. When, and into which registers, is the word written?',
        options: ['In cycle t + 1, while warp 1 issues: into warp 0\'s registers, through the second port', 'In cycle t, through rwe like any other result', 'In cycle t + 2, when warp 0 issues again', 'Warp 0 stalls a cycle and writes it then'],
        answer: 0,
        explain: 'drdata in cycle t + 1 is the word for cycle t\'s address. Warp 0 is not issuing then, so its register file has a free write port, and the word is there before warp 0\'s next instruction reads it.',
        why: ['', 'The memory answers one cycle late: in cycle t, drdata is the word for the previous cycle\'s address.', 'Too late: warp 0\'s next instruction issues in t + 2 and may read rd then; and warp 0\'s own results use that write port in t + 2.', 'Nothing stalls: the other warp\'s turn is the wait.'],
      },
    },
    {
      title: 'Each warp\'s register writes',
      text: 'Each file has one writer per cycle: its warp\'s results while it issues (rd, wd), else the returning load (lwa, drdata, lwe), which belongs to the warp that issued last cycle. Per warp a 3-bit mux, a 4-bit AND and OR for we, four word muxes. rwe = both warps\' issuing writes ORed.',
      parts: ['u95', 'u97', 'u98', 'u99', 'u100', 'u101', 'u102', 'u127', 'u129', 'u130', 'u131', 'u132', 'u133', 'u134', 'u151'], codex: ['regfile'],
    },
    {
      title: 'Each warp\'s mask and stack',
      text: 'rwe, mwe, split, join and tmc reach a warp only through its go bit (ANDs), so the warp not issuing is left alone. Mask loading and the tmc-over-stack priority as in the SIMT core, per warp. dwe = the two masks\' dwe ORed.',
      parts: ['u84', 'u85', 'u86', 'u87', 'u88', 'u89', 'u90', 'u116', 'u117', 'u118', 'u119', 'u120', 'u121', 'u122', 'u152'], codex: ['activemask', 'reconvergence'],
    },
    {
      title: 'Each warp\'s PC',
      text: 'Next PC, or the stack\'s jpc, 0 at reset; the register is enabled by go_w OR rst, so a PC moves only when its warp goes. A warp that lost its turn retries the same instruction next time.',
      parts: ['u103', 'u104', 'u106', 'u107', 'u135', 'u136', 'u138', 'u139'], codex: ['pc'],
    },
    {
      title: 'bar',
      text: 'Arriving first (bar · go_w · the other not waiting) sets the warp\'s waiting bit; it stays set until the other warp goes on bar. A warp waits while its bit is set and the other still has lanes, so a finished warp releases it. 30163 NANDs, against 17837 for one SIMT core.',
      parts: ['u108', 'u109', 'u110', 'u111', 'u112', 'u113', 'u114', 'u115', 'u140', 'u141', 'u142', 'u143', 'u144', 'u145', 'u146', 'u147'], codex: ['barrier'],
    },
  ],

  k_edge: [
    {
      title: 'Decode the command',
      text: 'A 3→8 decoder (51 NANDs), enabled by a constant 1: one line per command, hold, load, right, skip, down, up, band and double. Everything below is steered by single lines.',
      parts: ['u1'], codex: ['decoder'],
    },
    {
      title: 'E and R',
      text: 'Two 16-bit registers with enable, 208 NANDs each: E, the edge function at the current pixel, and R, its value where the current band started.',
      parts: ['E', 'R'], codex: ['register', 'edgefn'],
    },
    {
      title: 'Who moves',
      text: 'E is enabled by ¬hold; R only by load OR band. Every other command walks E away from R, which keeps the band\'s start.',
      parts: ['u20', 'u21'],
    },
    {
      title: 'The base',
      text: 'A mux picks E, or R for band; a second picks that, or 2E for double. 2E is E shifted left by a splitter and a merger, no gates.',
      parts: ['u3', 'u7'], codex: ['shiftadd'],
      ask: {
        question: 'band sets E and R to R + 4b. Why start from R and not from E?',
        options: ['E has moved right along the band; R still holds where the band began, and 4b below that is the next band\'s start', 'R + 4b and E + 4b are equal', 'To keep E unchanged for the tile test', 'R is E delayed by one cycle'],
        answer: 0,
        explain: 'A band is a row of tiles walked left to right, so E ends far from its start. R remembers the start; four pixel rows down is R + 4b.',
        why: ['', 'They differ by every a and 4a added along the band.', 'band writes E as well: E becomes R + 4b.', 'R loads only on load and band, so it can hold a value for a whole band.'],
      },
    },
    {
      title: 'The operand',
      text: 'a or 4a (skip), b or 4b (band), both shifts wired; a 3-input OR says down, up or band takes the b side, and a third mux picks it. The shifts cost nothing, the muxes 49 NANDs each.',
      parts: ['u11', 'u15', 'u16', 'u17'], codex: ['mux'],
    },
    {
      title: 'One adder',
      text: 'A 16-bit adder / subtractor, 212 NANDs, subtracting only for up. E is linear in x and y, so every move of the walk is one addition: no multiplier anywhere.',
      parts: ['u18'], codex: ['subtract', 'edgefn'],
    },
    {
      title: 'Load or step',
      text: 'A last mux: e0 for load, else the sum, into both registers\' d. Their enables decide which of them takes it.',
      parts: ['u19'],
    },
    {
      title: 'inside',
      text: 'inside = E ≥ 0: NOT of the sign bit, 1 NAND. 984 NANDs in all, 416 of them the two registers.',
      parts: ['u23'], codex: ['not'],
    },
  ],

  k_tile: [
    {
      title: 'The state',
      text: 'busy and a TEST flag (flip-flops, 9 NANDs each), the pixel counter k and the tile tx, ty (4-bit registers with enable, 52 each): 174 of the level\'s 479 NANDs.',
      parts: ['busyF', 'testF', 'k', 'tx', 'ty'], codex: ['register', 'tilewalk'],
    },
    {
      title: 'TEST or a pixel',
      text: 'While busy, a cycle is either a tile\'s TEST (the flag is 1) or one of its pixels (the flag is 0). test and pix are both 0 while idle.',
      parts: ['u4', 'u5', 'u6'], codex: ['fsm'],
    },
    {
      title: 'Where the walk is',
      text: 'Two 3-bit equality comparators: last tile across (tx = tx1), last band (ty = ty1). k = 15 is a 4-input AND, the end of a column (k1·k0) a 2-input one. Two NOTs for not last.',
      parts: ['u7', 'u8', 'u9', 'u10', 'u11', 'u12'], codex: ['comparator'],
    },
    {
      title: 'Tile done',
      text: 'A tile is done when its TEST fails (test · ¬ok) or its last pixel goes out (pix · k = 15).',
      parts: ['u13', 'u14', 'u15', 'u16'],
    },
    {
      title: 'What comes next',
      text: 'After a tile: the next tile if not the last across; the next band if the last across but not the last band; finished if both. start = go while not busy.',
      parts: ['u17', 'u18', 'u19', 'u20', 'u21', 'u22', 'u23'],
    },
    {
      title: 'The steppers\' moves',
      text: 'Within a tile: right at a column\'s end, else down in even columns, up in odd ones (k bit 2). The last pixel moves right to the next tile unless that was the last across. A rejected TEST skips (+4a) to the next tile.',
      parts: ['u24', 'u25', 'u26', 'u27', 'u28', 'u29', 'u30', 'u31', 'u32', 'u33', 'u34', 'u35'],
    },
    {
      title: 'Encode the command',
      text: 'The moves are one-hot; the codes are right 2, skip 3, down 4, up 5, band 6. bit 0 = skip + up, bit 1 = right + skip + band, bit 2 = down + up + band: three ORs. Every term includes busy, so cmd is 0 while idle.',
      parts: ['u36', 'u37', 'u38'], codex: ['sop'],
    },
    {
      title: 'busy and TEST next',
      text: 'busy next = (start + busy · ¬finished) · ¬rst. TEST next = start + tile done: every tile, the first included, begins with a TEST cycle.',
      parts: ['u3', 'u40', 'u41', 'u42', 'u43', 'u44'],
    },
    {
      title: 'The counters',
      text: 'k, tx and ty each step by a 4-bit ripple adder with carry in 1 (36 NANDs). k counts pixels and returns to 0 when a tile is done or the walk starts; tx loads tx0 at start and at each band; ty loads ty0 at start and steps at each band.',
      parts: ['u47', 'u49', 'u50', 'u51', 'u55', 'u57', 'u58', 'u59', 'u62', 'u64', 'u65'], codex: ['counter', 'incrementer'],
    },
    {
      title: 'The pixel\'s x and y',
      text: 'x = 4·tx + column, column = k[3:2]; y = 4·ty + row, all mergers except one 2-bit XOR. 479 NANDs in all.',
      parts: ['u68'], codex: ['xor'],
      ask: {
        question: 'Columns run down, then up: column 1 (k = 4 … 7) runs up. Which row is k = 5?',
        options: ['2', '1', '3', '0'],
        answer: 0,
        explain: 'row = k[1:0] XOR (k2, k2): for k = 5, 01 XOR 11 = 10. k = 4 is row 3, the bottom, one step right of k = 3.',
        why: ['', 'That is k mod 4, the row in a column that runs down. Column 1 runs up, so the row is reversed.', 'Row 3 is k = 4, the first pixel of column 1: right next to k = 3 at the bottom of column 0.', 'Row 0 is k = 7, the column\'s last pixel, after which the walk moves right.'],
      },
    },
  ],

  k_raster: [
    {
      title: 'Set-up',
      text: 'One combinational block from the vertices: per edge A and B (8-bit subtractors), the top-left bias, Δx and Δy from the first tile\'s top-left pixel centre, the tile test\'s offset 12·(A⁺ + B⁺); and the box in tiles. Adders only, 3564 NANDs.',
      parts: ['setup'], codex: ['subtract', 'edgefn'],
    },
    {
      title: 'Set-up steps',
      text: 'A flip-flop per step, started by go while idle: load, two sign steps, 14 pairs counted by t, the bias, the cull. A chain of 19 cycles before the walk, 250 NANDs.',
      parts: ['seq'], codex: ['fsm'],
    },
    {
      title: 'Each stepper\'s operands',
      text: 'One block per edge (353 NANDs): during the walk a = 4A and b = 4B; during the set-up the shift-and-add\'s operand, A or B when the chosen bit of Δx or Δy is set, else 0, then the bias. e0 is 0, or the stepper\'s own E in the cull step.',
      parts: ['op0', 'op1', 'op2'], codex: ['horner'],
      ask: {
        question: 'E at the first tile is A·Δx + B·Δy − bias, and there is no multiplier. How does each stepper compute it?',
        options: ['Top bit first: double E and add A where Δx\'s bit is set (then add B where Δy\'s is), on its own adder', 'Add A to E Δx times, then B Δy times', 'One multiplier in the set-up, shared by the three edges', 'A table of products in the set-up'],
        answer: 0,
        explain: 'Horner\'s rule on the stepper\'s double command: 14 steps for bits 6 … 0 of Δx and Δy, plus two for their sign bits, which weigh −128.',
        why: ['', 'Up to 127 + 127 cycles, and a different count for every triangle.', 'The level allows no multiplier, and the steppers already have adders.', 'A table of 8-bit by 8-bit products would cost far more than three adders that are there anyway.'],
      },
    },
    {
      title: 'Three edge steppers',
      text: 'Your edge stepper, three times (984 NANDs each), each on its operands. Their command is the set-up\'s OR the walk\'s: each is 0 while the other runs, so a 3-bit OR merges them.',
      parts: ['edge0', 'edge1', 'edge2', 'u0'], codex: ['edgefn'],
    },
    {
      title: 'Cull and tile test',
      text: 'front: E0 + E1 + E2 plus the biases, twice the signed area and the same at every point, is > 0. ok: E + 12·(A⁺ + B⁺) ≥ 0 for all three edges, each at its tile\'s best corner. Six 16-bit adders and a full adder, 930 NANDs.',
      parts: ['test'], codex: ['flags'],
    },
    {
      title: 'The walk',
      text: 'Your tile walk (479 NANDs) over the set-up\'s box, ok from the tile test, its command into the steppers. It starts only on the cull step of a front face: a back face never walks.',
      parts: ['walk', 'u1'], codex: ['tilewalk'],
    },
    {
      title: 'Write a pixel',
      text: 'fwe = pix · all three inside; fa = 32·y + x is a merger of the walk\'s y and x, fd is col. 9251 NANDs, 6516 of them the set-up and the three steppers.',
      parts: ['u2', 'u3'], codex: ['and'],
    },
  ],

  k_frame: [
    {
      title: 'Turn, front end, decodes, as before',
      text: 'The two-warp core\'s turn flip-flop, the shared control, immediates, lane decoder, and the bar and load decodes.',
      parts: ['u0', 'u1', 'u2', 'u3', 'u5', 'u6', 'u7', 'u11', 'u12', 'u13', 'u14', 'u15', 'u17', 'u18', 'u19', 'u20', 'u21'], codex: ['barrel'],
    },
    {
      title: 'State per warp, as before',
      text: 'Per warp a PC, mask, stack, lane registers and waiting bit: 11086 NANDs a warp.',
      parts: ['u22', 'u23', 'u24', 'u25', 'u26', 'u27', 'u28', 'u29', 'u30', 'u31'], codex: ['warp'],
    },
    {
      title: 'Go, with a hold',
      text: 'The go logic of the two-warp core with one more AND: go also needs NOT held. held is computed from the device further on; while it is 1 the issuing warp\'s instruction does nothing and its turn passes.',
      parts: ['holdN', 'u32', 'u33', 'u34', 'u35', 'u36', 'u37', 'u38', 'u39', 'u40'], codex: ['stall'],
    },
    {
      title: 'Operands, lanes, results, as before',
      text: 'The issuing warp\'s operands, leader and PC, the shared lanes, branch and next-PC logic, and the results with tid.',
      parts: ['u41', 'u42', 'u43', 'u44', 'u45', 'u46', 'u47', 'u48', 'u49', 'u50', 'u51', 'u52', 'u53', 'u54', 'u56', 'u57', 'u58', 'u59', 'u60', 'u61', 'u74', 'u75', 'u76', 'u77'], codex: ['lane'],
    },
    {
      title: 'Loads and register writes, as before',
      text: 'The loads in flight (lanes and rd held a cycle), and each register file\'s single writer: its warp\'s results, or the returning load.',
      parts: ['u78', 'u79', 'u84', 'u93', 'u95', 'u125', 'u127', 'u149', 'u151', 'u96', 'u98', 'u99', 'u100', 'u101', 'u102', 'u103', 'u128', 'u130', 'u131', 'u132', 'u133', 'u134', 'u135', 'u152'], codex: ['loadstore'],
    },
    {
      title: 'Masks, stacks, PCs, bar, as before',
      text: 'Per warp the mask and stack controls gated by go, the PC that moves only when its warp goes, and the waiting bit for bar. Up to here, the two-warp core (30163 NANDs) and the hold gate.',
      parts: ['u85', 'u86', 'u87', 'u88', 'u89', 'u90', 'u91', 'u117', 'u118', 'u119', 'u120', 'u121', 'u122', 'u123', 'u153', 'u104', 'u105', 'u107', 'u108', 'u136', 'u137', 'u139', 'u140', 'u109', 'u110', 'u111', 'u112', 'u113', 'u114', 'u115', 'u116', 'u141', 'u142', 'u143', 'u144', 'u145', 'u146', 'u147', 'u148'], codex: ['barrier'],
    },
    {
      title: 'Is it the device?',
      text: 'Lane 0\'s address (its ALU result) is a rasterizer register when bits 15:3 equal 0x1FFE (0xFFF0 … 0xFFF7, a 13-bit comparator) and bits 2:0 are not all 1 (0xFFF7 is not one). 96 NANDs.',
      parts: ['u156', 'u158', 'u159', 'u160'], codex: ['device', 'mmio'],
    },
    {
      title: 'Lane 0 stores to it',
      text: 'A 4-bit mux picks the issuing warp\'s mask; devStore = the control unit\'s mwe · mask bit 0 · the address test. The instruction\'s own signals, not the write enables.',
      parts: ['u161', 'u163'],
    },
    {
      title: 'A lane reads the screen',
      text: 'Per lane, address bits 15:10 = 111100 (0xF000 … 0xF3FF, a 6-bit comparator) AND its mask bit; any of the four, AND load. 179 NANDs.',
      parts: ['u166', 'u167', 'u170', 'u171', 'u174', 'u175', 'u178', 'u179', 'u180', 'u181'], codex: ['comparator'],
    },
    {
      title: 'The device registers',
      text: 'A write happens when lane 0\'s store actually goes (dwe bit 0, which includes go) to the device: a 3→8 decoder on address bits 2:0 enables one of six vertex registers (lane 0\'s rs2, low 7 bits) or the colour register. Seven 208-NAND registers, 1456 NANDs.',
      parts: ['u185', 'u187', 'u188', 'r_v0x', 'r_v0y', 'r_v1x', 'r_v1y', 'r_v2x', 'r_v2y', 'r_col'], codex: ['register', 'decoder'],
    },
    {
      title: 'The rasterizer',
      text: 'Your rasterizer, 9251 NANDs, on the seven registers. The store to 0xFFF6 sets a flip-flop that is its go in the next cycle, when the colour is in its register. Its fa, fd and fwe are the core\'s pixel port.',
      parts: ['rast', 'startF'], codex: ['device'],
    },
    {
      title: 'Hold while busy',
      text: 'busy for the core = the rasterizer\'s busy OR the start flip-flop; held = busy · (devStore + screen load), into the NOT before go. 41250 NANDs: the two-warp core, the rasterizer, 1456 for the registers and 380 for the rest.',
      parts: ['u182', 'u183', 'u184'], codex: ['stall', 'device'],
      ask: {
        question: 'Why is held built from the control unit\'s mwe and the load decode, not from dwe and the masks\' write enables?',
        options: ['Those enables are ANDed with go, and go depends on held: a combinational loop', 'dwe arrives one cycle late', 'dwe covers only lane 0', 'No reason: either would work'],
        answer: 0,
        explain: 'held feeds go, and go gates every write enable. Taking held from them would close a loop through go; the instruction\'s own decode signals do not depend on it.',
        why: ['', 'dwe is combinational in the same cycle; the problem is what it depends on, not when.', 'dwe has a bit per lane; the screen-load test needs every lane anyway.', 'A loop through go has no stable answer while the rasterizer is busy: held = 1 blocks the store, which clears held, which lets the store go.'],
      },
    },
  ],
};
