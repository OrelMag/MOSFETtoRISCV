// Authored walkthroughs, group 4 (see walks.ts for the conventions): optional levels on the way
// (fast adders, counter, state machine, RAM) and side quests on the cores (a faster core, branch
// prediction, a cache, the multicycle core). No DOM.

import type { WalkScript } from './walk';

export const WALKS4: Record<string, WalkScript> = {
  o_fastadd: [
    {
      title: 'Generate and propagate',
      text: 'Each bit\'s gp cell gives g = a·b (this bit makes a carry) and p = a ⊕ b (it passes one on): the half adder, 5 NANDs, 80 for sixteen. From here on no carry is computed bit by bit: (g, p) pairs describe whole groups of bits.',
      parts: ['gp0', 'gp1', 'gp2', 'gp3', 'gp4', 'gp5', 'gp6', 'gp7', 'gp8', 'gp9', 'gp10', 'gp11', 'gp12', 'gp13', 'gp14', 'gp15'], codex: ['cla', 'halfadder'],
    },
    {
      title: 'Fold in cin',
      text: 'A gray cell computes G0 = g0 + p0·cin, the carry out of bit 0. Once a group reaches bit 0 its propagate is never needed again, so gray cells (G only, 3 NANDs) replace black ones (G and P, 5 NANDs) wherever the lower group already includes cin.',
      parts: ['cin0'], codex: ['prefix'],
    },
    {
      title: 'Level 0: pairs',
      text: 'Each position i combines its group with the one at i − 1: G = g + p·gl, P = p·pl. L0_1 reaches bit 0 and is gray; the other fourteen are black. 73 NANDs.',
      parts: ['L0_1', 'L0_2', 'L0_3', 'L0_4', 'L0_5', 'L0_6', 'L0_7', 'L0_8', 'L0_9', 'L0_10', 'L0_11', 'L0_12', 'L0_13', 'L0_14', 'L0_15'], codex: ['prefix'],
      ask: {
        question: 'Each prefix level merges every group with the one just below it, doubling its span. How many levels until position 15\'s group reaches bit 0?',
        options: ['4', '15', '8', '16'],
        answer: 0,
        explain: 'Spans of 2, 4, 8, then 16 bits: log2(16) = 4 levels, each two NAND delays deep. The combining operator is associative, so groups can be merged in any bracketing.',
        why: ['', 'That is the ripple adder: one bit per step. Merging groups doubles the span each level.', 'Eight levels would reach a span of 256 bits.', 'Sixteen is the span, not the number of levels.'],
      },
    },
    {
      title: 'Level 1: spans of 4',
      text: 'Position i takes the group at i − 2. L1_2 and L1_3 now reach bit 0 (gray), twelve are black: 66 NANDs.',
      parts: ['L1_2', 'L1_3', 'L1_4', 'L1_5', 'L1_6', 'L1_7', 'L1_8', 'L1_9', 'L1_10', 'L1_11', 'L1_12', 'L1_13', 'L1_14', 'L1_15'],
    },
    {
      title: 'Level 2: spans of 8',
      text: 'Distance 4: four gray cells (positions 4 to 7) and eight black ones, 52 NANDs.',
      parts: ['L2_4', 'L2_5', 'L2_6', 'L2_7', 'L2_8', 'L2_9', 'L2_10', 'L2_11', 'L2_12', 'L2_13', 'L2_14', 'L2_15'],
    },
    {
      title: 'Level 3: every carry',
      text: 'Distance 8, and every lower group already holds cin: eight gray cells, 24 NANDs. Position i\'s G is now the carry into bit i + 1, and L3_15\'s is cout, 13 NAND delays deep. The prefix tree: 16 gray and 34 black cells, 218 NANDs.',
      parts: ['L3_8', 'L3_9', 'L3_10', 'L3_11', 'L3_12', 'L3_13', 'L3_14', 'L3_15'],
    },
    {
      title: 'The sums',
      text: 's_i = p_i ⊕ c_i, with c_0 = cin and c_i the G of position i − 1: sixteen XORs, 64 NANDs, merged into s. Every sum bit is ready by depth 14. 362 NANDs, against 144 NANDs and depth 36 for the ripple adder: 2.5 times the gates for under half the delay. (The library\'s ks16 adds the ALU\'s overflow v = c16 ⊕ c15: one more XOR, depth 16.)',
      parts: ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7', 'x8', 'x9', 'x10', 'x11', 'x12', 'x13', 'x14', 'x15'], codex: ['xor'],
    },
  ],

  s_cnt4: [
    {
      title: 'The count',
      text: 'A 4-bit register holds q and loads d at the rising edge when en = 1: four flip-flops with enable, 52 NANDs, two thirds of the counter. q goes to the pin and, through the q pointer, back to the incrementer.',
      parts: ['reg'], codex: ['register', 'counter'],
    },
    {
      title: 'q + 1',
      text: 'The incrementer: a NOT for bit 0, half adders for bits 1 to 3, 16 NANDs, depth 7. Its carry out is left unconnected, so 15 + 1 wraps to 0.',
      parts: ['inc'], codex: ['incrementer'],
    },
    {
      title: 'Reset as data',
      text: 'nrst = ¬rst, and each bit of q + 1 is ANDed with it: a NAND and an inverting NAND per bit, 9 NANDs in all. A synchronous reset is just another value to load: 0, at the edge.',
      parts: ['nrst', 'g0', 'n0', 'g1', 'n1', 'g2', 'n2', 'g3', 'n3'], codex: ['and'],
    },
    {
      title: 'When to load',
      text: 'ren = NAND(¬en, ¬rst) = en + rst drives the register\'s enable, so the zeros load even while en = 0. 79 NANDs.',
      parts: ['nen', 'ren'], codex: ['demorgan'],
      ask: {
        question: 'The register loads only when its en is 1, and rst must clear q even while the counter\'s en = 0. What should drive the register\'s en?',
        options: ['en + rst', 'en', 'en·¬rst', 'The clock, gated by en'],
        answer: 0,
        explain: 'By De Morgan, NAND(¬en, ¬rst) = en + rst: two inverters and a NAND. With rst = 1 the register loads the zeros from the AND row.',
        why: ['', 'With en = 0 the register holds, and rst would wait until counting resumes.', 'That blocks the load exactly when rst needs it.', 'Never gate the clock (glitches, skew): the register\'s enable mux exists to avoid it.'],
      },
    },
  ],

  s_fsm: [
    {
      title: 'The state',
      text: 'Two flip-flops, 18 NANDs: S0 = 00 (nothing useful seen), S1 = 01 (bit s0: the last input was 1), S2 = 10 (bit s1: the last two were 1, 0). Code 11 is never entered.',
      parts: ['s0', 's1'], codex: ['fsm', 'dff'],
    },
    {
      title: 'Next s0',
      text: 's0\' = x·¬rst: a NOT on rst, a NAND and a NOT. The reset is synchronous, ANDed into each next-state bit.',
      parts: ['inv_rst', 'g0', 'n0'], codex: ['kmap'],
      ask: {
        question: 'With S1 = 01 and S2 = 10, when must bit s0 be 1 after the edge (rst = 0)?',
        options: ['Whenever x = 1, in any state', 'When x = 1 in S0', 'When x = 1 in S2', 'In S1, whatever x'],
        answer: 0,
        explain: 'Every state goes to S1 on a 1: from S0 and S1 the last input is 1, and from S2 a 1 completes the pattern and may start the next one (10101 holds two). s0\' depends on no state bit at all.',
        why: ['', 'S1 stays in S1 on a 1, and S2 goes there too.', 'S0 and S1 also go to S1 on a 1.', 'From S1 a 0 leads to S2, which clears bit s0.'],
      },
    },
    {
      title: 'Next s1',
      text: 's1\' = ¬x·s0·¬rst: only S1 followed by a 0 reaches S2. ¬x·¬rst (a NOT on x, a NAND, a NOT), then ANDed with s0 (a NAND, a NOT): 5 NANDs. S2 on a 0 falls back to S0 because both next bits are 0.',
      parts: ['inv_x', 'g1', 'h1', 'k1', 'n1'],
    },
    {
      title: 'A Mealy output',
      text: 'y = x·s1: in S2 the current x = 1 completes 1, 0, 1, so y rises before the edge, from the input itself (a Mealy machine). A Moore output would need a fourth state and come a cycle later. 28 NANDs.',
      parts: ['yn', 'yg'],
    },
  ],

  m_ram: [
    {
      title: 'Four words',
      text: 'Four 4-bit registers share d and clk: 208 NANDs, 76% of the RAM. Each loads d at the rising edge only when its own en is 1.',
      parts: ['w0', 'w1', 'w2', 'w3'], codex: ['register'],
    },
    {
      title: 'Write select',
      text: 'A 2→4 decoder with enable: line k = we·(addr = k), one register\'s en during a write, none otherwise. 18 NANDs.',
      parts: ['dec'], codex: ['decoder'],
      ask: {
        question: 'Each word\'s register needs its own enable. What should word k\'s en be?',
        options: ['we·(addr = k)', 'we', 'addr = k', 'clk·(addr = k)'],
        answer: 0,
        explain: 'A decoder with an enable input makes all four at once: we on its enable, addr on its select. The tip\'s AND is folded into the decoder.',
        why: ['', 'Every write would store d in all four words.', 'Every edge would write the addressed word, reads (we = 0) included.', 'Never gate the clock: each register already has an enable for exactly this.'],
      },
    },
    {
      title: 'Read port',
      text: 'A 4:1 mux of 4-bit words on addr: q = mem[addr], combinational, 48 NANDs, depth 5. Read and write share addr, so after a write q shows the new word. 274 NANDs, about 17 per stored bit (some 68 transistors, against 6 in an SRAM cell).',
      parts: ['mux'], codex: ['mux', 'ram'],
    },
  ],

  c_fast: [
    {
      title: 'The PC, as in Core III',
      text: 'A plain 16-bit register behind the load and reset muxes: pc ← rst ? 0 : ld ? target : pc + 1, with ld, target and pc + 1 from next PC.',
      parts: ['u10', 'u11', 'u12', 'u13'], codex: ['pc'],
    },
    {
      title: 'Decode and registers',
      text: 'Control (200 NANDs, depth 13), the immediate generator, the 4:1 format mux and the register file, all unchanged. The critical path starts here: instruction memory, control, format mux.',
      parts: ['u0', 'u1', 'u2', 'u3', 'u4'], codex: ['control'],
    },
    {
      title: 'ALU operand b',
      text: 'The same 2:1 bus mux on bimm, the last stop before the ALU on the load path.',
      parts: ['u5'],
    },
    {
      title: 'A Kogge–Stone ALU',
      text: 'The same ten operations, its adder a prefix tree: 1 273 NANDs, +218 over the ripple ALU, and 28 delays on the load path instead of 50. The memories, control and muxes on that path stay as they were.',
      parts: ['u6'], codex: ['cla', 'criticalpath'],
      ask: {
        question: 'Core III\'s period is 98, set by the load path, of which the ripple ALU takes 50. The Kogge–Stone ALU crosses that path in 28. What is the new period?',
        options: ['76', '98', '48', '86'],
        answer: 0,
        explain: '98 − 22 = 76: the same path, 22 delays shorter. The next longest, through the ripple branch comparator, ends two delays behind it.',
        why: ['', 'The ALU is on the critical path, so the period falls with it; the two memories are only 16 of the 98.', 'That removes the ALU entirely: its 28 delays are still on the path.', 'No other path is that long: with only the ALU swapped, the period is already 76.'],
      },
    },
    {
      title: 'Branch comparator, unchanged',
      text: 'Still 287 NANDs, depth 44: its less-than waits for a ripple carry. Instruction memory, register file, comparator, next PC, PC: 74, two delays behind the load path, so a faster comparator would buy nothing.',
      parts: ['u7'], codex: ['branches'],
    },
    {
      title: 'Next PC, fast adders',
      text: 'Next PC keeps its two ripple adders (421 NANDs). Kogge–Stone ones would cost 865, +444, and the period would not move: the branch path reaches the PC through ld, not through the adders, and the target adders (36 deep) finish before the comparator (44). Spend NANDs only on the critical path.',
      parts: ['u8'],
    },
    {
      title: 'Write back',
      text: 'The 4:1 result mux into the register file. 4 959 NANDs (+218, +5%) for period 76 (−22%): the same 1 236 cycles take 93 936 NAND delays instead of 121 128.',
      parts: ['u9'], codex: ['cpi'],
    },
  ],

  o_bpred: [
    {
      title: 'F and D, as in Pipeline IV',
      text: 'The PC with its stall hold, redirect and reset muxes and the incrementer; F/D instr and F/D pc (en = ¬stall, clr = rst + redirect); control, immediates and the falling-edge register file; the bubble OR into D/E.',
      parts: ['u3', 'u4', 'u18', 'u19', 'u20', 'u21', 'u22', 'u23', 'u24', 'u25', 'u31', 'u32', 'u33', 'u34', 'u38'], codex: ['pipeline'],
    },
    {
      title: 'E, M and W, as before',
      text: 'D/E, forwarding and the operand muxes, the ALU, the comparator and next PC, the load detector and hazard unit, E/M, the M muxes and M/W. The control word\'s spare sixteenth bit will carry the guess to E.',
      parts: ['u39', 'u40', 'u41', 'u42', 'u43', 'u44', 'u47', 'pick48', 'u48', 'pick51', 'u49', 'u50', 'u51', 'u52', 'u53', 'u57', 'u58', 'u59', 'u62', 'u63', 'u64', 'u65', 'u66', 'pick72', 'u68', 'u69', 'u72', 'u73', 'u75'],
      codex: ['forwarding'],
    },
    {
      title: 'Decode in F',
      text: 'A second immediate generator (wiring) and two opcode tests on the fetched word: branch = op[3]·¬op[2] (opcodes 8 to 11), jal = op[3]·op[2]·¬(op[1] + op[0]) (opcode 12). 11 NANDs; control in D is untouched.',
      parts: ['u6', 'u7', 'u8', 'u9', 'u10', 'u11', 'u12'], codex: ['bpred'],
    },
    {
      title: 'The guess',
      text: 'predict = branch·instr[15] + jal: 5 NANDs. jalr is never predicted: its target is rs1 + imm, and F has no register value.',
      parts: ['u13', 'u14'], codex: ['bpred'],
      ask: {
        question: 'From the fetched word alone, which branches should be guessed taken?',
        options: ['Those with a negative offset (instr[15] = 1)', 'All of them', 'None: only jal', 'Those with a positive offset'],
        answer: 0,
        explain: 'A backward branch closes a loop and is taken on every iteration but the last. RV16 keeps every immediate\'s sign in instr[15], so the test is one AND.',
        why: ['', 'Forward branches (an if skipping code) often fall through: each wrong guess costs the two-cycle flush a "not taken" guess avoided.', 'Then loops still pay two cycles per iteration, the case worth fixing.', 'Backwards: a forward branch falls through about as often as not, a loop\'s backward branch almost never.'],
      },
    },
    {
      title: 'The target in F',
      text: 'pc + imm (the B immediate, or J for jal) on a ripple adder, and a mux that sends it to the PC when predict is 1: 242 NANDs. The guess sits before the stall hold, so holding the PC still wins.',
      parts: ['u15', 'u16', 'u17'], codex: ['branches'],
    },
    {
      title: 'Carry the guess',
      text: 'F/D predicted, a 260-NAND pipeline register for one bit (the other fifteen are 0), held and cleared with F/D instr. In D the bit joins the control word, so D/E costs nothing more.',
      parts: ['u28'], codex: ['pipeline'],
    },
    {
      title: 'Check in E',
      text: 'redirect = ld ⊕ predicted: taken but not guessed goes to the target, guessed but not taken back to pc + 1 (a mux on predicted). +571 NANDs (9 810); the XOR lengthens the comparator → next PC → flush path, period 80 (+2). The 31 programs fall from 2 653 cycles to 2 303 (−13%), 184 240 NAND delays against 206 934.',
      parts: ['u54', 'u55'], codex: ['controlhazard', 'flush'],
    },
  ],

  o_cache: [
    {
      title: 'Tags and valid bits',
      text: 'addr splits into index = addr[2:0] and tag = addr[7:3]. An 8 × 6 RAM keeps, per line, the tag and a valid bit, written as {tag, 1} whenever the line is: 939 NANDs. At power-on every valid bit is 0.',
      parts: ['u3'], codex: ['cache'],
    },
    {
      title: 'The data',
      text: 'An 8 × 16 RAM on the same index holds one word per line: 2 419 NANDs, 69% of the cache. Tag and valid add 6 bits to every 16-bit line.',
      parts: ['u4'], codex: ['ram'],
    },
    {
      title: 'Hit',
      text: 'hit = valid·(stored tag = addr[7:3]): a 5-bit equality comparator (33 NANDs, depth 10) and an AND.',
      parts: ['u6', 'u7'], codex: ['comparator'],
      ask: {
        question: 'Line 5 holds the word of address 0x2D (tag 00101). A read of 0x35 arrives. What happens?',
        options: ['A miss: same line, other tag; mdata answers and refills line 5', 'A hit: the index matches', 'A miss, and line 6 is filled', 'A hit, because line 5 is valid'],
        answer: 0,
        explain: '0x35 is index 101 = 5, tag 00110 = 6: the stored tag 5 does not match. Addresses 8 apart share a line and evict each other (direct mapping).',
        why: ['', 'The index only picks the line; the tag says which of 32 addresses it holds.', 'The index is addr[2:0] = 5, the same line; 6 is the tag.', 'Valid only says the line holds something; the tag says what.'],
      },
    },
    {
      title: 'Answer',
      text: 'rdata = hit ? line : mdata, a 2:1 bus mux: a miss answers from main memory in the same access.',
      parts: ['u10'], codex: ['mux'],
    },
    {
      title: 'Fill or write',
      text: 'Both RAMs write when wr + rd·¬hit; the line takes wdata on a write, mdata on a fill. Write-through with allocate: the bench writes main memory too. 3 497 NANDs, period 36, for 128 data bits.',
      parts: ['u8', 'u9', 'u11', 'u12'], codex: ['cache'],
    },
  ],

  o_mc: [
    {
      title: 'One flip-flop per state',
      text: 'F, E, M and W, one-hot: exactly one is 1, so "are we in W?" is a wire. 36 NANDs.',
      parts: ['u0', 'u1', 'u2', 'u3'], codex: ['fsm', 'multicycle'],
    },
    {
      title: 'Instruction register',
      text: 'A 16-bit register with enable (208 NANDs) loads instr in F. Everything after F decodes from ir, not from instr.',
      parts: ['u4'], codex: ['register'],
    },
    {
      title: 'Decode and read, as in Core III',
      text: 'Control, the immediates and the 4:1 format mux, and the register file, now on ir\'s fields. They settle in E and hold through M and W: neither ir nor the registers change before the end of W.',
      parts: ['u6', 'u7', 'u8', 'u10'], codex: ['control', 'regfile'],
    },
    {
      title: 'Execute',
      text: 'The b mux, the ripple ALU, the branch comparator and next PC, as in the single-cycle core. Nothing is shared between steps: the ALU computes neither pc + 1 nor targets.',
      parts: ['u11', 'u12', 'u13', 'u14'], codex: ['alu'],
    },
    {
      title: 'The ALU register',
      text: 'A plain 16-bit register (144 NANDs) captures the ALU result at the end of E, and daddr reads it, so the data memory gets a cycle of its own. With no enable it reloads the same value every cycle until W. The longest path is now ir → control → format mux → b mux → ALU → this register: period 76.',
      parts: ['u15'], codex: ['criticalpath'],
    },
    {
      title: 'Load or store?',
      text: 'load = (wb = 01), mem = load + mwe: only these visit M. 6 NANDs.',
      parts: ['u18', 'u19', 'u22'], codex: ['loadstore'],
    },
    {
      title: 'Next state',
      text: '→F = rst + W; →E = ¬rst·F; →M = ¬rst·E·mem; →W = ¬rst·(M + E·¬mem). 18 NANDs: with one-hot states the next-state logic is a gate or two per flip-flop.',
      parts: ['u26', 'u27', 'u28', 'u29', 'u30', 'u31', 'u32', 'u33', 'u34'], codex: ['fsm'],
    },
    {
      title: 'Writes in their step',
      text: 'rwe = rwe·W and dwe = mwe·M: an instruction writes its register only in W and stores only in M. The 4:1 result mux picks the ALU register, drdata (still addressed by it in W), pc + 1 or the immediate.',
      parts: ['u9', 'u35', 'u25'], codex: ['control'],
    },
    {
      title: 'The PC loads in W',
      text: 'next = ld ? target : pc + 1, the reset mux, and a PC register with enable W + rst. 5 224 NANDs (+483 over Core III) and period 76 instead of 98, but 3 865 cycles instead of 1 236: 293 740 NAND delays against 121 128, 2.4 times slower.',
      parts: ['u16', 'u21', 'u23', 'u24'], codex: ['pc', 'cpi'],
      ask: {
        question: 'An instruction spends 3 or 4 cycles in the core. When must the PC load its next value?',
        options: ['Only in W, its last step', 'In F, once the word is in ir', 'Every cycle', 'In E, when next PC has the target'],
        answer: 0,
        explain: 'Next PC\'s target and the link value pc + 1 are computed from pc in every step up to W, so the PC must hold the instruction\'s address until then: enable = W + rst.',
        why: ['', 'E would compute pc + imm and pc + 1 from the following address: every branch target and link would be off by one.', 'The PC would run three or four instructions ahead of the one executing.', 'jal writes its link in W, computed from pc: it would already be the target\'s pc + 1.'],
      },
    },
  ],
};
