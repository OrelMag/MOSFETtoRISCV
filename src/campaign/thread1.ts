// The thread (thread.ts), acts 3–5 (state and memory, the instruction set, the single-cycle CPU): where each
// level's part ends up, how the next levels use it, and the mistakes made building it. Numbers are measured
// (libCost, the levels' pars, static timing) and pinned by tests/content-acts345.test.ts. No DOM.

import type { NodeThread } from './thread';

export const THREAD1: Record<string, NodeThread> = {
  // ---- Act 3 ----------------------------------------------------------------------------------
  s_sr: {
    uses: ['rf', 'pc', 'csr'],
    usedFor: { s_dlatch: 'the storage loop, with two NANDs in front that never let both inputs fall together' },
    pitfalls: [
      'The inputs are active low: s_n = 0 sets, s_n = 1 rests. Driven as active high, the latch never holds.',
      'Both inputs at 0 is not a stored state: q = q_n = 1, and which value remains depends on which input rises first.',
    ],
  },
  s_dlatch: {
    uses: ['rf', 'pc', 'csr'],
    usedFor: { s_dff: 'two of them on opposite clock phases: master and slave' },
    pitfalls: [
      's_n from ¬d and r_n from d stores ¬d: every hold row fails.',
      'With e = 0 both inputs must sit at 1: a d that still reaches the latch then makes it a wire, not a memory.',
    ],
  },
  s_dff: {
    uses: ['rf', 'pc', 'csr', 'p1', 'p2', 'p3', 'p4'],
    usedFor: {
      s_reg4: 'four of them, each behind a mux that feeds q back while en = 0',
      s_fsm: 'two hold the state between edges',
      h_loader: 'the loader\'s address counter and its control are clocked by them',
    },
    pitfalls: [
      'Both latches enabled by clk make one transparent latch: a d that changes while clk = 1 reaches q at once.',
      'The master on clk and the slave on ¬clk is a flip-flop too, but it captures at the falling edge, half a cycle away from where the test reads it.',
      'q changes clk-to-q after the edge, not at it, and d must be steady a setup time before it: a path longer than the period between them breaks the register, not the logic.',
    ],
  },
  s_reg4: {
    uses: ['rf', 'pc', 'csr'],
    usedFor: {
      s_reg16: 'four of them sharing clk and en',
      s_cnt4: 'holds the count; en = 0 holds it still',
      m_ram: 'one per word, en from the address decoder ANDed with we',
    },
    pitfalls: [
      'clk AND en on the clock pin saves the muxes and fails: a change of en while clk is high is an edge.',
      'Swapped mux inputs (en = 1 selects q) make a register that never loads.',
    ],
  },
  s_reg16: {
    uses: ['rf', 'pc', 'csr', 'p1', 'p2', 'p3', 'p4'],
    usedFor: {
      s_pc: 'its flip-flops without the enable muxes: the PC loads every cycle, 144 NANDs instead of 208',
      m_rf: 'seven of them, x1–x7, one enabled at a time by the decoder on rd',
      pi_reg: 'with a mux to 0 in front and an OR on en: stall and flush',
      y_csr: 'mtvec, mepc, mcause and the other CSRs are 16-bit registers behind a 3→8 decoder',
      o_mulseq: 'the multiplicand and the product halves',
    },
    pitfalls: [
      'Nibbles merged back in another order than they were split pass every value with four equal nibbles and fail the rest.',
      'One en for all four registers: a register left on a constant en loads every edge or never.',
      'A register that loads every cycle needs no enable: tying en to 1 wastes 64 NANDs on muxes that always pick d.',
    ],
  },
  s_cnt4: {
    uses: ['pc', 'plus1'],
    usedFor: {},
    pitfalls: [
      'Reset applied only to the incremented value clears the counter only while en = 1.',
      'The incrementer fed from d instead of q is a combinational loop: it never settles.',
    ],
  },
  s_pc: {
    uses: ['pc', 'plus1'],
    usedFor: { c_core1: 'its output addresses the instruction memory; Core III loads it from next PC instead of counting' },
    pitfalls: [
      'Reset must win over load: an AND with ¬rst before the load mux lets a jump escape the reset.',
      'pc + 1 comes from the register\'s output: from its input, the incrementer is inside a combinational loop.',
      'A register with enable, en tied to 1, works and costs 64 NANDs that do nothing.',
    ],
  },
  s_fsm: {
    uses: ['ctl'],
    usedFor: { o_div: 'its busy flag and step count are a state machine of this kind' },
    pitfalls: [
      'Overlap: after 1, 0, 1 the last 1 starts the next pattern, so the machine goes to S1, not S0.',
      'y is Mealy: it depends on x before the edge, not on the state after it.',
      'Leaving the unused code 11 with no next state can lock the machine there; as a don\'t-care it is free, and rst clears it.',
    ],
  },
  m_ram: {
    uses: ['dmem', 'rf'],
    usedFor: {},
    pitfalls: [
      'The decoder\'s outputs must be gated by we: without it every edge writes the addressed word.',
      'Reads are combinational: a register in the read path returns the word one cycle late.',
    ],
  },
  m_rf: {
    uses: ['rf'],
    usedFor: {
      m_mem: 'its cost per bit is why memories are given parts from here on',
      c_lesson: 'the datapath reads rs1 and rs2 from it and writes rd back at the edge',
      c_core1: 'rs1, rs2 and rd wired straight from the instruction word, rwe from the control unit',
    },
    pitfalls: [
      'x0 must read 0 whatever was written: a real register there costs 208 NANDs and needs its enable cut.',
      'The decoder\'s enable is we: ungated, every instruction writes some register.',
      'Two read ports means two independent muxes: ra1 and ra2 may name the same register, or x0.',
    ],
  },
  m_mem: {
    uses: ['imem', 'dmem'],
    usedFor: { c_core2: 'the data RAM, on the ALU\'s result: daddr, dwdata, dwe, drdata' },
    pitfalls: [
      'Reads are combinational, writes happen at the edge: a load right after a store to the same word sees the new value only in the next cycle.',
      'Fetch and load share one cycle: a single memory with one port cannot serve both, hence a ROM and a RAM (Harvard).',
    ],
  },

  // ---- Act 4 ----------------------------------------------------------------------------------
  i_isa: {
    uses: ['ctl', 'imm'],
    usedFor: {
      i_enc: 'its field table, read both ways',
      p_add: 'the instructions, and the device addresses at the top of memory',
      c_lesson: 'each instruction class is one setting of the same path',
      c_imm: 'its formats are the immediates the generator extracts',
    },
    pitfalls: [
      'a0 is x3, not RISC-V\'s x10: three-bit register fields leave room for eight registers.',
      'Addresses count words: the next word is +1, not +2 or +4.',
      'Offsets and branch distances are 6 bits, −32 … 31: farther needs an address in a register, or a <code>j</code>.',
      '<code>lui rd, k</code> loads k × 64: the value\'s low six bits come from an <code>addi</code> after it.',
    ],
  },
  i_enc: {
    uses: ['ctl', 'imm'],
    usedFor: { c_ctl: 'the same decode as logic: a line per opcode, then an OR per signal' },
    pitfalls: [
      'S and B split the immediate around rs2 and rs1: imm[5:3] in bits 15:13, imm[2:0] in bits 6:4.',
      'A 6-bit immediate is signed: 111100 is −4, not 60.',
      'lui is two opcodes (7 and 15): bit 3 is imm[0], not part of the opcode.',
    ],
  },
  p_add: {
    uses: ['mmio', 'alu', 'dmem'],
    usedFor: { p_loop: 'the same input and output, with a loop between them' },
    pitfalls: [
      'Devices are reached from x0 with a negative offset: <code>lw a0, -4(x0)</code> is IN (0xFFFC); 0xFFFC itself does not fit an offset.',
      '<code>sw</code> names the value first: <code>sw a0, -3(x0)</code> stores a0 to OUT.',
      'Without <code>halt</code> the PC runs on into whatever follows the program.',
    ],
  },
  p_loop: {
    uses: ['br', 'npc'],
    usedFor: {
      p_mem: 'the loop again, now walking an array',
      p_mul: 'a loop over b\'s bits',
      c_computer: 'the program you write for it is a loop like this one',
    },
    pitfalls: [
      'A test only at the bottom runs the body once for n = 0.',
      'A branch reaches −32 … 31 words: a longer loop closes with <code>j</code> and a forward branch out.',
    ],
  },
  p_mem: {
    uses: ['dmem', 'alu'],
    usedFor: {
      p_call: 'loads and stores again: the stack is memory addressed by sp',
      p_sort: 'two loads and two stores per pair of neighbours',
    },
    pitfalls: [
      '0x100 does not fit a 6-bit offset: the address goes into a register with <code>li</code>.',
      'The words are signed: compare with <code>blt</code> / <code>bge</code>; an unsigned test (<code>sltu</code>) calls −1 the largest.',
      'Step the pointer by 1: RV16 addresses words, not bytes.',
    ],
  },
  p_call: {
    uses: ['npc', 'wb'],
    usedFor: { p_handler: 'a function nobody calls: it saves what it touches and returns with mret' },
    pitfalls: [
      'A function that calls another overwrites ra: save it first (<code>push ra</code>), restore it before <code>ret</code>.',
      'sp starts nowhere: set it (<code>li sp, 0x1000</code>) before the first push.',
      'Arguments and the result live in a0 and a1 by agreement only: the hardware checks nothing.',
    ],
  },
  p_mul: {
    uses: ['alu'],
    usedFor: {
      p_print: 'subtraction loops of the same shape find each digit',
      o_mulseq: 'the same loop as a circuit, one bit of b per clock',
    },
    pitfalls: [
      'There is no <code>andi</code>: the 1 to test the low bit must be in a register.',
      '<code>srai</code> on b keeps its sign bit: a b with bit 15 set never reaches 0. Use <code>srli</code>.',
      'The product wraps mod 2<sup>16</sup>: nothing needs to catch the overflow.',
    ],
  },
  p_sort: {
    uses: ['dmem', 'br'],
    usedFor: {},
    pitfalls: [
      'Signed order: <code>bge</code>, not an unsigned test.',
      'Each pass needs one compare fewer, and n − 1 passes are enough: an inner count of n reads past the array.',
    ],
  },
  p_print: {
    uses: ['alu', 'mmio'],
    usedFor: {},
    pitfalls: [
      'Unsigned compare: the value can exceed 32 767, so <code>sltu</code>, not <code>slt</code>.',
      'Skip leading zeros but always print the last digit: 0 prints "0".',
      'A character is \'0\' + digit (48 + d), stored to the console at −2.',
    ],
  },

  // ---- Act 5 ----------------------------------------------------------------------------------
  c_lesson: {
    uses: ['ctl', 'rf', 'alu', 'wb'],
    usedFor: { c_core1: 'the path it traces, wired: PC, instruction memory, control, register file, ALU, result mux' },
    pitfalls: [
      'sw writes no register: its bits 6:4 are imm[2:0], so rwe must be 0.',
      'A branch target is pc + imm from next PC, not the ALU\'s result.',
      'jal writes pc + 1 to rd and jumps to pc + imm: the two are easy to swap.',
      'lui writes the immediate itself: sent through the ALU, it is added to whatever rs1 happens to read.',
    ],
  },
  c_imm: {
    uses: ['imm'],
    usedFor: { c_core1: 'the I and U immediates: the ALU\'s b for addi and the shifts, the written value for lui' },
    pitfalls: [
      'U\'s low bit is instr[3]: lui is op 7 and 15, and dropping it halves the reachable values.',
      'The sign is instr[15] in every format: extending from another bit fails every negative offset.',
      'S/B keeps imm[5:3] above rs2 and imm[2:0] where rd would be: in the other order a branch goes to the wrong place.',
    ],
  },
  c_ctl: {
    uses: ['ctl'],
    usedFor: { c_core1: 'sets every mux and enable of the datapath, 13 delays after the word arrives' },
    pitfalls: [
      'LUI is two opcodes, 7 and 15: decoding only 7 fails every lui with an odd immediate.',
      'sw and the branches must not write rd: rwe = 0 for them, though their bits 6:4 look like a register.',
      'SHI\'s ALU operation comes from f3[2:1], not f3: 00 sll, 01 srl, 1x sra.',
      'MD and SYSTEM opcodes do nothing here: rwe, mwe and the jumps all 0.',
    ],
  },
  c_br: {
    uses: ['br'],
    usedFor: { c_npc: 'its take, ANDed with br, decides whether the PC loads the target' },
    pitfalls: [
      'blt and bge compare signed: lt, not ltu.',
      'bne and bge are the inversions of beq and blt: cond[0] flips the answer, it does not pick another test.',
    ],
  },
  c_npc: {
    uses: ['npc'],
    usedFor: { c_core3: 'loads the PC on a jump; its pc1 feeds both the PC and the result mux' },
    pitfalls: [
      'jalr\'s base is rs1, not pc: one adder per target, or a mux on the base.',
      'An untaken branch must not load: ld = jal | jalr | (br &amp; take), never br alone.',
      'pc1 is pc + 1, the return address jal and jalr write: not the target.',
    ],
  },
  c_core1: {
    uses: ['pc', 'imem', 'ctl', 'rf', 'imm', 'alu', 'wb'],
    usedFor: { c_core2: 'the same chip with a data memory port: Core II grows it' },
    pitfalls: [
      'Register fields never move: rs1 = instr[9:7], rs2 = instr[12:10], rd = instr[6:4], for every format.',
      'The ALU\'s b is rs2 or the immediate, by bimm: wired to rs2 alone, every addi adds a register.',
      'A write to x0 must vanish: the register file handles it, so rwe need not.',
    ],
  },
  c_core2: {
    uses: ['dmem', 'wb', 'alu'],
    usedFor: { c_core3: 'branches and jumps added to it: the same chip again' },
    pitfalls: [
      'sw must not write a register: rwe = 0, though its bits 6:4 look like rd.',
      'A store\'s offset is the S/B immediate, not I: isel picks it.',
      'daddr is the ALU result, rs1 + offset: rs1 alone ignores every offset.',
    ],
  },
  c_core3: {
    uses: ['npc', 'br', 'pc', 'wb'],
    usedFor: {
      c_computer: 'placed as a part between a ROM, a RAM and LEDs',
      c_fast: 'the same core with fast adders on its critical path',
      y_lesson: 'traps and interrupts break into this loop between two instructions',
      y_trap: 'gains the CSRs and a trap path: mepc ← pc, pc ← mtvec',
      o_mc: 'the same instructions in 3 or 4 short cycles',
      o_lesson: 'its NANDs, period and cycles are what the units of Act 8 are measured against',
      o_mcore: 'an array multiplier on the MD opcode',
      k_lesson: 'one front end that will feed four lanes',
    },
    pitfalls: [
      'The branch target comes from next PC (pc + imm), never from the ALU.',
      'jal and jalr write pc + 1, not the target: the result mux\'s third input.',
      'The PC loads on next PC\'s ld: loading on br alone takes every branch.',
    ],
  },
  c_computer: {
    uses: ['mmio', 'imem', 'dmem'],
    usedFor: {
      y_lesson: 'devices like its LEDs are what raise interrupts',
      m_lesson: 'what sits behind its RAM in a real machine',
    },
    pitfalls: [
      'The ROM has 32 words: its address is pc[4:0], and the program must fit.',
      'An I/O store must not also write the RAM: gate the RAM\'s we with ¬daddr[15].',
      'The LEDs load only when dwe and daddr[15]: on dwe alone every store lights them.',
    ],
  },
  c_fast: {
    uses: ['alu'],
    usedFor: { pi_lesson: 'the 76-delay cycle the pipeline cuts into stages' },
    pitfalls: [
      'Only what lies on the critical path pays: Kogge–Stone adders in next PC add 444 NANDs and leave the period at 76.',
      'After a swap the path moves: time it again before swapping more.',
      'Faster is not free: the Kogge–Stone ALU is 218 NANDs more than the ripple one, worth it only because it is on the path.',
    ],
  },
};
