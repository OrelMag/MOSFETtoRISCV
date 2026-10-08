// The campaign's levels, act by act. Each level says why the block exists (its place in the
// CPU), what it builds on, what it unlocks for the levels after it, hints, codex entries and par.
// Levels marked `soon` are on the map but not playable yet (docs/CAMPAIGN.md tracks them).

import { challengeById } from '../editor/challengeset';
import { BUILD1 } from './build1';
import { BUILD5 } from './build5';
import { BUILD6 } from './build6';
import { BUILD7 } from './build7';
import { BUILD8, partsOf } from './build8';
import { BUILDH } from './buildh';
import { fpAdd, fpMul } from '../lib/fpu';
import { arrayMul, seqDivider } from '../lib/muldiv';
import { seqMul } from '../lib/multiply';
import { F16 } from '../sim/fpref';
import type { BuildChallenge } from '../editor/challenges';
import type { Act, CampaignNode } from './types';

const sandbox = (id: string) => (): BuildChallenge => {
  const c = challengeById(id);
  if (!c) throw new Error(`no sandbox challenge ${id}`);
  return c;
};

export const ACTS: Act[] = [
  { num: 0, title: 'Prologue: what are we building?', blurb: 'A processor is a loop: fetch an instruction, decode it, execute it, write the result back, go again. Every block of that loop is a circuit you will build. It all starts with a switch.' },
  { num: 1, title: 'Logic', blurb: 'From one gate, every Boolean function. Decoders choose a register, multiplexers route operands, comparators decide branches: the CPU\'s control is all logic.' },
  { num: 2, title: 'Numbers and arithmetic', blurb: 'Bits become numbers when you agree on what they mean. Then one adder does addition, subtraction and comparison: the heart of the ALU.' },
  { num: 3, title: 'State and memory', blurb: 'Logic forgets; a CPU must remember: the program counter, eight registers, data. Feedback makes a latch, two latches make a flip-flop, flip-flops make everything else.' },
  { num: 4, title: 'The instruction set and assembly', blurb: 'The contract between hardware and software. Before building the processor, learn what it must do, by programming it.' },
  { num: 5, title: 'A single-cycle CPU', blurb: 'Wire your blocks into a datapath, add the control that tells them what to do, and run your own programs on your own processor.' },
  { num: 6, title: 'Pipelining', blurb: 'Five instructions in flight at once: a shorter clock period, and the hazards that come with it. Forwarding, stalls and flushes keep it correct.' },
  { num: 7, title: 'The system: traps and interrupts', blurb: 'A real processor reacts to the outside world and to its own mistakes. CSRs, exceptions and interrupts, precise even in the pipeline: the finale.' },
  { num: 8, title: 'Side quests', blurb: 'Optional: faster adders, multipliers and dividers, floating point, caches, microcode. Each one is a trade of area for time.' },
];

export const NODES: CampaignNode[] = [
  // ---- Act 0 --------------------------------------------------------------------------------
  {
    id: 'intro', act: 0, title: 'Anatomy of a CPU', kind: 'lesson', requires: [],
    why: 'Before building anything: what is a processor made of, and why each block? The diagram below is the machine you will finish with. Every block lights up as you build it.',
    body: 'intro',
    tips: [], codex: ['cpu', 'fde', 'abstraction'],
    chapters: [{ chapter: 'map', label: 'The map' }, { chapter: 'cpu', label: 'A single-cycle CPU' }],
  },
  {
    id: 't_inv', act: 0, title: 'CMOS inverter', kind: 'build', requires: ['intro'], base: sandbox('t_inv'),
    why: 'A computer is made of switches that control other switches. Two complementary MOSFETs make the simplest such circuit, the inverter, and show the CMOS rule: exactly one network drives the output, so no static current flows.',
    tips: ['A PMOS conducts when its gate is 0, an NMOS when it is 1.', 'PMOS from VDD to y, NMOS from y to GND, both gates on a.'],
    codex: ['mosfet', 'cmos', 'inverter'], unlocks: ['inv_cmos'], par: { transistors: 2 },
    chapters: [{ chapter: 'mosfet', label: 'The MOSFET' }, { chapter: 'inverter', label: 'The CMOS inverter' }],
  },
  {
    id: 't_nand', act: 0, title: 'CMOS NAND', kind: 'build', requires: ['t_inv'], base: sandbox('t_nand'),
    why: 'NAND is functionally complete: every circuit of this campaign, the whole CPU included, is NANDs. Four transistors; from the next level on, the NAND is your brick.',
    tips: ['The pull-down network must conduct only when a = b = 1: put the NMOS in series.', 'The pull-up must conduct when either input is 0: PMOS in parallel.'],
    codex: ['nand', 'universality', 'duality'], unlocks: ['nand'], par: { transistors: 4 },
    chapters: [{ chapter: 'nand', label: 'The NAND gate' }],
  },
  {
    id: 't_nor', act: 0, title: 'CMOS NOR', kind: 'build', optional: true, requires: ['t_inv'], base: sandbox('t_nor'),
    why: 'The dual of NAND, also complete. Why do cell libraries and this campaign prefer NAND? Series PMOS are slow (holes are about 2–3× less mobile than electrons), and NOR puts them in series.',
    tips: ['Swap series and parallel relative to the NAND.'],
    codex: ['nor', 'duality'], unlocks: ['nor_cmos'], par: { transistors: 4 },
    chapters: [{ chapter: 'nand', step: 2, label: 'NOR' }],
  },

  // ---- Act 1 --------------------------------------------------------------------------------
  {
    id: 'l_bool', act: 1, title: 'Boolean algebra', kind: 'drill', requires: ['intro'],
    why: 'Circuits are equations. Algebra lets you transform one circuit into a cheaper equivalent before you build it: fewer gates, shorter paths. This is how every par in the campaign is reached.',
    body: 'bool', tips: [], codex: ['identities', 'demorgan', 'bubble', 'sop', 'truthtable'],
    chapters: [{ chapter: 'gates', label: 'Gates from NAND' }], drill: 'boolean' },
  {
    id: 'g_not', act: 1, title: 'NOT from NAND', kind: 'build', requires: ['t_nand'], base: sandbox('g_not'),
    why: 'Every control signal has a complement somewhere: the mux select, the subtract line, active-low resets. NOT is a NAND with its inputs tied.',
    tips: ['¬(a·a) = ¬a.'], codex: ['not'], unlocks: ['not'], par: { nand: 1, depth: 1 },
    chapters: [{ chapter: 'gates', label: 'Gates from NAND' }],
  },
  {
    id: 'g_and', act: 1, title: 'AND from NAND', kind: 'build', requires: ['g_not'], base: sandbox('g_and'),
    why: 'AND is a gate: "write the register only if write-enable AND this is the selected register". Every enable in the CPU is an AND.',
    tips: ['AND = NOT(NAND).'], codex: ['and'], unlocks: ['and'], par: { nand: 2, depth: 2 },
  },
  {
    id: 'g_or', act: 1, title: 'OR from NAND', kind: 'build', requires: ['g_not'], base: sandbox('g_or'),
    why: 'OR merges conditions: "take the branch if beq-and-equal OR bne-and-unequal", "the result is zero unless any bit is 1". De Morgan turns it into NANDs.',
    tips: ['a + b = ¬(¬a · ¬b).', 'Invert both inputs (two NANDs as NOTs), then one NAND.'],
    codex: ['or', 'demorgan'], unlocks: ['or'], par: { nand: 3, depth: 2 },
  },
  {
    id: 'g_xor', act: 1, title: 'XOR from NAND', kind: 'build', requires: ['g_and', 'g_or'], base: sandbox('g_xor'),
    why: 'XOR is addition without carry, a controlled inverter (the subtractor\'s ¬b), and the equality test (a ⊕ b = 0). It is the most used gate of the ALU.',
    tips: ['Start from n = ¬(a·b).', 'a ⊕ b = ¬(¬(a·n) · ¬(b·n)): four NANDs in total.'],
    codex: ['xor'], unlocks: ['xor', 'xnor'], par: { nand: 4, depth: 3 },
  },
  {
    id: 'g_mux', act: 1, title: '2:1 multiplexer', kind: 'build', requires: ['g_not'], base: sandbox('g_mux'),
    why: 'A multiplexer is a switch for data: the ALU\'s second operand is a register or an immediate, the PC is PC + 1 or a branch target, the written value is the ALU result or a loaded word. Wherever two paths meet, there is a mux.',
    tips: ['y = s·b + ¬s·a: a sum of products.', 'Sum of products → NAND–NAND: ¬(¬(s·b) · ¬(¬s·a)).'],
    codex: ['mux', 'sop'], unlocks: ['mux2'], par: { nand: 4, depth: 3 },
  },
  {
    id: 'd_kmap', act: 1, title: 'Karnaugh maps', kind: 'drill', requires: ['l_bool'], drill: 'kmap', par: { mistakes: 2 },
    why: 'A K-map draws a truth table so that adjacent cells differ in one bit: groups of 1s become product terms with fewer literals. The control unit is a dozen such functions of the opcode.',
    tips: ['Groups are rectangles of 1, 2, 4 or 8 cells; edges wrap around.', 'Every 1 must be covered; overlapping groups are fine.'],
    codex: ['kmap', 'qm', 'dontcare'],
  },
  {
    id: 'g_sop', act: 1, title: 'A function from its table', kind: 'build', requires: ['d_kmap', 'g_and', 'g_or'],
    why: 'The control unit is specified as a table (opcode → signals) and built as logic. Practise the method on one function: K-map, sum of products, NAND–NAND.',
    tips: ['Minimise first: every literal saved is a gate input saved.', 'An SoP maps one-to-one onto two levels of NANDs.'],
    unlocks: ['rv16_prime4'], codex: ['sop', 'nandnand'], base: BUILD1.g_sop, par: { nand: 20, depth: 7 } },
  {
    id: 'g_wide', act: 1, title: 'Wide gates', kind: 'build', requires: ['g_and', 'g_or'],
    why: 'The branch unit asks "is the result zero?": a 16-input NOR. A chain of 2-input gates is 15 deep; a tree is 4. Depth, not gate count, sets the clock.',
    tips: ['Balance the tree: pairs, then pairs of pairs.', 'Alternate NAND and NOR levels to avoid inverters (bubble pushing).'],
    codex: ['fanin', 'depth', 'bubble'], unlocks: ['rv16_wide16', 'and3', 'and4', 'and8', 'or3', 'or4', 'or8', 'or16', 'zero*', 'andx*', 'orx*', 'xorx*'], base: BUILD1.g_wide, par: { nand: 46, depth: 9 } },
  {
    id: 'g_dec', act: 1, title: '3→8 decoder', kind: 'build', requires: ['g_wide'],
    why: 'Eight registers, one write port: a decoder turns the 3-bit register number into eight enable lines, only one of them 1. Decoders also select memory words and MMIO devices.',
    tips: ['Output k is the AND of the address bits or their complements matching k.', 'Share the inverters; add an enable as a fourth AND input.'],
    codex: ['decoder'], unlocks: ['rv16_dec3', 'dec*'], base: BUILD1.g_dec, par: { nand: 51, depth: 5 } },
  {
    id: 'g_mux8', act: 1, title: 'Bus multiplexers', kind: 'build', requires: ['g_mux'],
    why: 'Data moves 16 bits at a time: a 2:1 mux per bit makes a bus mux. Reading a register is an 8:1 mux of 16-bit words.',
    tips: ['A wide mux is a row of 1-bit muxes sharing the select (and its inverter).', 'An 8:1 mux is a tree of 2:1 muxes, one select bit per level.'],
    codex: ['mux', 'bus'], unlocks: ['mux*'], base: BUILD1.g_mux8, par: { nand: 64, depth: 3 } },
  {
    id: 'g_eq16', act: 1, title: 'Equality', kind: 'build', requires: ['g_xor', 'g_wide'],
    why: 'beq and bne compare two registers; the pipeline\'s forwarding unit compares register numbers. Equality is XNOR per bit and a wide AND.',
    tips: ['a = b ⇔ every bit of a ⊕ b is 0: XOR then zero-detect.'],
    codex: ['comparator'], unlocks: ['rv16_eq16', 'eq*'], base: BUILD1.g_eq16, par: { nand: 110, depth: 12 } },

  // ---- Act 2 --------------------------------------------------------------------------------
  {
    id: 'n_bin', act: 2, title: 'Binary and hex', kind: 'drill', requires: ['intro'], drill: 'binary', par: { mistakes: 2 },
    why: 'Every value inside the machine is a pattern of bits; the meaning is a convention. Read and write unsigned binary and hexadecimal fluently: the rest of the campaign speaks them.',
    tips: ['Each hex digit is exactly four bits.', 'Bit k weighs 2^k.'],
    codex: ['positional', 'hex'], chapters: [{ chapter: 'binary', label: 'Binary numbers' }],
  },
  {
    id: 'n_twos', act: 2, title: "Two's complement", kind: 'drill', requires: ['n_bin'], drill: 'twos', par: { mistakes: 2 },
    why: 'Negative numbers without a sign bit circuit: in two\'s complement the top bit weighs −2^(n−1), so the same adder adds signed and unsigned numbers. Only comparison and overflow differ.',
    tips: ['−x = ¬x + 1.', 'Overflow: both operands have the same sign and the result has the other.'],
    codex: ['twos', 'overflow', 'signext'], chapters: [{ chapter: 'binary', step: 1, label: "Two's complement" }],
  },
  {
    id: 'a_ha', act: 2, title: 'Half adder', kind: 'build', requires: ['g_xor', 'n_bin'], base: sandbox('a_ha'),
    why: 'Adding is the ALU\'s first job, and the PC adds 1 every cycle. One column of binary addition: the sum is XOR, the carry is AND.',
    tips: ['The XOR\'s first NAND is ¬(a·b): invert it for the carry.'],
    codex: ['halfadder'], unlocks: ['half_adder'], par: { nand: 5, depth: 3 },
    chapters: [{ chapter: 'adders', label: 'Adders' }],
  },
  {
    id: 'a_fa', act: 2, title: 'Full adder', kind: 'build', requires: ['a_ha'], base: sandbox('a_fa'),
    why: 'A column with a carry in: chain them and you can add words of any width.',
    tips: ['Two half adders and an OR: 13 NANDs.', 'The carry ¬(¬(a·b) · ¬(cin·(a⊕b))) reuses both XORs\' first NANDs: 9.'],
    codex: ['fulladder', 'majority'], unlocks: ['full_adder', 'full_adder_ha'], par: { nand: 9, depth: 6 },
  },
  {
    id: 'a_add4', act: 2, title: '4-bit ripple adder', kind: 'build', requires: ['a_fa'], base: sandbox('a_add4'),
    why: 'Chain full adders: the carry ripples from bit 0 upward. Correct, cheap and slow: the delay grows with the width.',
    tips: ['Splitters and mergers are free.', 'cout of bit k → cin of bit k + 1.'],
    codex: ['ripple'], unlocks: ['rca4'], par: { nand: 36, depth: 12 },
  },
  {
    id: 'a_add16', act: 2, title: '16-bit adder', kind: 'build', requires: ['a_add4'],
    why: 'RV16 words are 16 bits. Four of your 4-bit adders in a chain.',
    tips: ['Hierarchy: four 4-bit adders, not sixteen full adders.'],
    codex: ['ripple', 'criticalpath'], unlocks: ['rv16_add16', 'rca16'], base: BUILD1.a_add16, par: { nand: 144, depth: 36 } },
  {
    id: 'a_inc16', act: 2, title: '16-bit incrementer', kind: 'build', requires: ['a_ha'],
    why: 'The PC advances by one word every cycle. An adder with a constant input wastes gates: half adders are enough.',
    tips: ['a + 1: bit 0 is ¬a0, the carry into bit k is a0·…·a(k−1).'],
    codex: ['incrementer'], unlocks: ['inc16', 'inc4'], base: BUILD1.a_inc16, par: { nand: 80, depth: 33 } },
  {
    id: 'a_addsub16', act: 2, title: 'Adder / subtractor', kind: 'build', requires: ['a_add16', 'n_twos'],
    why: 'sub, slt, beq/blt all subtract. a − b = a + ¬b + 1: XOR gates invert b when sub = 1, and sub is also the carry in.',
    tips: ['An XOR is a controlled inverter.', 'Feed sub into cin.'],
    codex: ['subtract', 'twos'], unlocks: ['addsub16'], base: BUILD1.a_addsub16, par: { nand: 212, depth: 41 } },
  {
    id: 'a_slt', act: 2, title: 'Set if less than', kind: 'build', requires: ['a_addsub16'],
    why: 'slt / sltu and blt / bge need a < b, signed and unsigned. Both come from the subtractor: the carry out for unsigned, sign ⊕ overflow for signed.',
    tips: ['Unsigned: a < b ⇔ no carry out of a + ¬b + 1.', 'Signed: a < b ⇔ the result\'s sign differs from the true sign, i.e. N ⊕ V.'],
    unlocks: ['rv16_cmp16'], codex: ['flags', 'overflow'], base: BUILD1.a_slt, par: { nand: 217, depth: 44 } },
  {
    id: 'a_shift16', act: 2, title: 'Barrel shifter', kind: 'build', requires: ['g_mux8', 'g_and'],
    why: 'sll / srl / sra by any amount in one cycle: four levels of muxes, shifting by 1, 2, 4 and 8.',
    tips: ['Level k shifts by 2^k when shamt bit k is 1.', 'Arithmetic right shift fills with the sign bit instead of 0.'],
    codex: ['shifter'], unlocks: ['shift16'], base: BUILD1.a_shift16, par: { nand: 389, depth: 14 } },
  {
    id: 'a_alu16', act: 2, title: 'The ALU', kind: 'build', requires: ['a_addsub16', 'a_slt', 'a_shift16', 'g_wide'],
    why: 'The execute stage: ten operations selected by a 4-bit control word from the instruction\'s op and f3 fields. Every arithmetic instruction, every address and every branch comparison goes through it.',
    tips: ['Compute everything in parallel, select one result with a mux tree.', 'Share the one adder between add, sub and the comparisons.'],
    codex: ['alu'], unlocks: ['alu16'], anatomy: ['alu'], chapters: [{ chapter: 'alu', label: 'The ALU' }], base: BUILD1.a_alu16, par: { nand: 1250, depth: 64 } },
  {
    id: 'o_fastadd', act: 2, title: 'Fast adders', kind: 'build', optional: true, requires: ['a_add16'],
    why: 'The ripple adder\'s carry chain is the CPU\'s critical path. Computing carries with a prefix tree takes log2(n) levels: more gates, a faster clock.',
    tips: ['Generate g = a·b, propagate p = a ⊕ b; (g, p) pairs combine associatively.', 'Kogge–Stone: log2(16) = 4 levels of combining.'],
    codex: ['cla', 'prefix'], unlocks: ['ks16', 'cla4', 'alu16ks', 'rv16_nextpc_ks'], chapters: [{ chapter: 'fastadd', label: 'Faster adders' }], base: BUILD1.o_fastadd, par: { nand: 366, depth: 16 }, gives: ['gp', 'graycell', 'blackcell'] },

  // ---- Act 3 --------------------------------------------------------------------------------
  {
    id: 's_sr', act: 3, title: 'SR latch', kind: 'build', requires: ['g_not'], base: sandbox('s_sr'),
    why: 'Feed a gate\'s output back into its input and it can hold a value: one bit of memory, made of two NANDs.',
    tips: ['Cross-couple two NANDs: each one\'s output is the other\'s second input.'],
    codex: ['feedback', 'latch'], unlocks: ['sr_latch'], par: { nand: 2 },
    chapters: [{ chapter: 'latches', label: 'Memory from feedback' }],
  },
  {
    id: 's_dlatch', act: 3, title: 'D latch', kind: 'build', requires: ['s_sr'], base: sandbox('s_dlatch'),
    why: 'An SR latch with one data input and an enable: transparent while e = 1, holding while e = 0. Never both inputs active at once.',
    tips: ['s_n = ¬(d·e), r_n = ¬(¬d·e).', 'r_n can use s_n instead of ¬d: ¬(s_n·e).'],
    codex: ['dlatch'], unlocks: ['d_latch'], par: { nand: 4 },
  },
  {
    id: 's_dff', act: 3, title: 'D flip-flop', kind: 'build', requires: ['s_dlatch'], base: sandbox('s_dff'),
    why: 'A latch is transparent for half a cycle: a value could race around a loop. Two latches on opposite clock phases capture d at the rising edge only. Every register of the CPU is flip-flops.',
    tips: ['Master enabled while clk = 0, slave while clk = 1.'],
    codex: ['dff', 'edge', 'setuphold'], unlocks: ['dff'], par: { nand: 9 },
  },
  {
    id: 's_reg4', act: 3, title: '4-bit register', kind: 'build', requires: ['s_dff', 'g_mux'], base: sandbox('s_reg4'),
    why: 'A register keeps its value unless told to load: a mux in front of each flip-flop feeds q back while en = 0. Never gate the clock.',
    tips: ['Build a 1-bit DFF with enable first, then use it four times.'],
    codex: ['register', 'clockgating'], unlocks: ['dffe', 'reg4'], par: { nand: 52 },
  },
  {
    id: 's_reg16', act: 3, title: '16-bit register', kind: 'build', requires: ['s_reg4'],
    why: 'The PC, every register of the register file, every pipeline register: 16-bit registers everywhere.',
    tips: ['Four of your 4-bit registers sharing clk and en.'],
    codex: ['register'], unlocks: ['reg16'], base: BUILD1.s_reg16, par: { nand: 240, period: 8 } },
  {
    id: 's_cnt4', act: 3, title: '4-bit counter', kind: 'build', optional: true, requires: ['s_reg4'], base: sandbox('s_cnt4'),
    why: 'A register plus an incrementer: the program counter in miniature, and every timer.',
    tips: ['q ← rst ? 0 : q + 1 when en.'], codex: ['counter'], unlocks: ['counter4'],
    chapters: [{ chapter: 'registers', label: 'Registers & counters' }],
  },
  {
    id: 's_pc', act: 3, title: 'Program counter', kind: 'build', requires: ['s_reg16', 'a_inc16', 'g_mux8'],
    why: 'The PC holds the address of the instruction being executed. Each cycle it becomes pc + 1, or a jump target; on reset, 0.',
    tips: ['A 16-bit register, an incrementer and two muxes (load, reset).'],
    unlocks: ['rv16_pc'], codex: ['pc'], anatomy: ['pc', 'plus1'], base: BUILD1.s_pc, par: { nand: 448, period: 45 } },
  {
    id: 's_fsm', act: 3, title: 'A state machine', kind: 'build', optional: true, requires: ['s_dff', 'd_kmap'],
    why: 'Multi-cycle units (a divider, a cache miss, microcode) are run by finite-state machines: state register + next-state logic from a table.',
    tips: ['Encode the states, write the next-state table, minimise each bit.'],
    unlocks: ['rv16_det101'], codex: ['fsm'], base: BUILD1.s_fsm, par: { nand: 32, period: 8 } },
  {
    id: 'm_ram', act: 3, title: '4 × 4 RAM', kind: 'build', optional: true, requires: ['s_reg4', 'g_dec', 'g_mux8'], base: sandbox('m_ram'),
    why: 'Memory is registers plus addressing: a decoder picks the word to write, a mux picks the word to read.',
    tips: ['Each word: a register whose en = we AND decoder output.'],
    codex: ['ram'], unlocks: ['ram4x4'], chapters: [{ chapter: 'memory', label: 'Memory arrays' }],
  },
  {
    id: 'm_rf', act: 3, title: 'Register file', kind: 'build', requires: ['s_reg16', 'g_dec', 'g_mux8'],
    why: 'Eight 16-bit registers, two read ports (rs1, rs2) and one write port (rd): an R-type instruction reads two and writes one in the same cycle. x0 always reads 0.',
    tips: ['Write: decoder on wa, ANDed with we, enables one register.', 'Read: two 8:1 bus muxes. x0 needs no register at all.'],
    codex: ['regfile'], unlocks: ['rv16_rf', 'regfile8x16'], anatomy: ['rf'], chapters: [{ chapter: 'regfile', label: 'The register file' }], base: BUILD1.m_rf, par: { nand: 2627, period: 11 } },
  {
    id: 'm_mem', act: 3, title: 'ROM and RAM', kind: 'lesson', requires: ['m_rf'],
    why: 'Programs live in ROM, data in RAM. Building memory from flip-flops is what you just did; real memories are dense arrays (SRAM, DRAM). From here on, memories are given.',
    body: 'mem', tips: [], codex: ['rom', 'harvard'], anatomy: ['imem', 'dmem'], unlocks: ['sb_rom*', 'ram*'],
  },

  // ---- Act 4 --------------------------------------------------------------------------------
  {
    id: 'i_isa', act: 4, title: 'The RV16 instruction set', kind: 'lesson', requires: ['n_twos'],
    why: 'The instruction set is the specification the processor implements: formats, fields, opcodes. RV16 keeps RISC-V\'s ideas (load/store, fixed fields, x0 = 0) in 16 bits.',
    body: 'isa', tips: [], codex: ['isa', 'formats', 'rv16', 'mmio'], chapters: [{ chapter: 'isa', label: 'Instructions & assembly' }],
  },
  {
    id: 'i_enc', act: 4, title: 'Encode and decode', kind: 'drill', requires: ['i_isa'], drill: 'isa16', par: { mistakes: 2 },
    why: 'Decoding is what the control unit does in hardware. Do it by hand first: fields, immediates, sign extension.',
    tips: ['op is the low nibble; rd, rs1, rs2 are at 4, 7, 10.'], codex: ['immediates'],
  },
  {
    id: 'p_add', act: 4, title: 'First program', kind: 'program', requires: ['i_isa'], par: { size: 5, cycles: 5 },
    why: 'The shortest useful program: two loads from a device, an add, a store to another device. Every program, however large, is made of these steps.',
    tips: ['IN is address 0xFFFC: from x0, that is offset −4. OUT is −3.', '<code>lw a0, -4(x0)</code> twice (a0, a1), <code>add</code>, <code>sw</code>, <code>halt</code>.'],
    codex: ['assembly', 'mmio'],
  },
  {
    id: 'p_loop', act: 4, title: 'Loops', kind: 'program', requires: ['p_add'], par: { size: 8, cycles: 330 },
    why: 'A branch that goes backwards is a loop: the same few instructions run many times. Most of a processor\'s time is spent in loops, which is why branches must be cheap.',
    tips: ['Count n down to 0: add it to the sum, decrement, branch back while it is not zero.', 'Test at the top (<code>beqz a0, done</code>) so that n = 0 works.'],
    codex: ['branches'],
  },
  {
    id: 'p_mem', act: 4, title: 'Arrays', kind: 'program', requires: ['p_loop'], par: { size: 14, cycles: 77 },
    why: 'Data lives in memory; only loads and stores reach it. Walking an array is a pointer in a register, a load, an increment.',
    tips: ['Keep the address in a register and add 1 each step (word addressing).', 'Signed comparison: <code>bge a0, t1, skip</code> keeps the larger one in a0.'],
    codex: ['loadstore'],
  },
  {
    id: 'p_call', act: 4, title: 'Functions', kind: 'program', requires: ['p_mem'], par: { size: 15, cycles: 1388 },
    why: 'Functions make code reusable: <code>call</code> saves the return address in ra, <code>ret</code> jumps back. A stack in memory lets functions call functions.',
    tips: ['Euclid by subtraction: while a ≠ b, subtract the smaller from the larger.', 'gcd calls nothing, so it need not save ra.'],
    codex: ['callconv', 'stack'],
  },
  {
    id: 'p_mul', act: 4, title: 'Multiply in software', kind: 'program', requires: ['p_loop'], par: { size: 13, cycles: 74 },
    why: 'RV16I has no multiply instruction. Shift and add does it in software, one bit of b per iteration: exactly the loop the sequential multiplier of Act 8 runs in hardware.',
    tips: ['Test the low bit of b with <code>and</code> (put 1 in a register first: there is no andi).', 'Each iteration: a ← a &lt;&lt; 1, b ← b &gt;&gt; 1; stop when b = 0.'],
    codex: ['shiftadd'],
  },
  {
    id: 'p_sort', act: 4, title: 'Sort', kind: 'program', optional: true, requires: ['p_mem'], par: { size: 17, cycles: 353 },
    why: 'Nested loops over memory, comparisons and swaps: the kind of program that stresses loads, stores and branches together.',
    tips: ['Bubble sort: n − 1 passes, each swapping neighbours that are out of order.', 'Load a[i] and a[i+1] with offsets 0 and 1 of the same pointer.'],
    codex: [],
  },
  {
    id: 'p_print', act: 4, title: 'Print a number', kind: 'program', optional: true, requires: ['p_mul'], par: { size: 23, cycles: 78 },
    why: 'Numbers are binary inside, decimal for people. Without a divider, subtract powers of ten: each count is a digit.',
    tips: ['Keep 10000, 1000, 100, 10 in a .data table and walk it.', 'Unsigned compare: <code>sltu</code> then <code>bnez</code> (there is no bltu).', 'Skip leading zeros, but always print the last digit.'],
    codex: [],
  },

  // ---- Act 5 --------------------------------------------------------------------------------
  {
    id: 'c_lesson', act: 5, title: 'The datapath', kind: 'lesson', requires: ['i_isa', 'a_alu16', 'm_rf'],
    why: 'Follow one instruction through the blocks you built: PC → ROM → decode → registers → ALU → write back. The datapath is the wiring; the control unit sets the muxes.',
    body: 'datapath', tips: [], codex: ['datapath', 'control'], chapters: [{ chapter: 'cpu', label: 'A single-cycle CPU' }],
  },
  {
    id: 'c_imm', act: 5, title: 'Immediate generator', kind: 'build', requires: ['i_isa', 'g_mux8'], base: BUILD5.c_imm, par: { nand: 0, depth: 0 },
    why: 'Constants live inside instructions, in four formats. The immediate generator extracts each and sign-extends it to 16 bits. Because RV16 keeps the immediate bits where they are, it needs no gates at all.',
    tips: ['Sign extension is wiring: fan the sign bit (instr[15]) out to every upper bit.', 'Splitters and mergers cost nothing; a 6-bit constant 0 makes the low bits of U.'],
    codex: ['immediates', 'signext'], unlocks: ['rv16_imm'], anatomy: ['imm'],
  },
  {
    id: 'c_ctl', act: 5, title: 'Control unit', kind: 'build', requires: ['i_enc', 'g_dec', 'd_kmap'], base: BUILD5.c_ctl, par: { nand: 200, depth: 13 },
    why: 'The datapath has muxes and enables; something must set them for each instruction. The control unit is a table (opcode → signals) turned into logic: decode the opcode, then each signal is an OR of the opcodes that need it.',
    tips: ['A 4→16 decoder on op gives one line per opcode.', 'rwe: OP, OPX, ADDI, SHI, LW, LUI (op 7 and 15), JAL, JALR.', 'Don\'t-cares (signals an instruction ignores) are free: choose whatever makes the logic smaller.'],
    codex: ['control', 'dontcare'], unlocks: ['rv16_ctl'], anatomy: ['ctl'],
  },
  {
    id: 'c_br', act: 5, title: 'Branch comparator', kind: 'build', requires: ['g_eq16', 'a_slt', 'g_mux'], base: BUILD5.c_br, par: { nand: 335, depth: 49 },
    why: 'beq, bne, blt and bge differ only in the comparison. One equality test and one signed less-than, a mux and an XOR cover all four.',
    tips: ['Bit 1 of cond picks between "equal" and "less than", bit 0 inverts.'],
    codex: ['branches', 'comparator'], unlocks: ['rv16_branch'], anatomy: ['br'],
  },
  {
    id: 'c_npc', act: 5, title: 'Next PC', kind: 'build', requires: ['a_add16', 'a_inc16', 'c_br', 'g_mux8'], base: BUILD5.c_npc, par: { nand: 440, depth: 38 },
    why: 'Where does the next instruction come from? Usually pc + 1; for a taken branch or jal, pc + imm; for jalr, rs1 + imm (returns, function pointers). jal and jalr also save pc + 1 as the return address.',
    tips: ['Two adders, an incrementer and a bus mux.', 'ld = jal | jalr | (br & take).'],
    codex: ['pc', 'branches'], unlocks: ['rv16_nextpc'], anatomy: ['npc'],
  },
  {
    id: 'c_core1', act: 5, title: 'Core I: arithmetic', kind: 'core', requires: ['c_lesson', 'c_imm', 'c_ctl', 's_pc', 'm_rf', 'a_alu16'], base: BUILD5.c_core1, par: { nand: 4973, period: 98, cycles: 701 },
    why: 'Your first processor: the PC addresses the program, the control unit decodes, the register file and ALU compute, the result goes back. Arithmetic only: the PC just counts.',
    tips: ['Wire the instruction\'s fields straight to the register file: rs1 = instr[9:7], rs2 = instr[12:10], rd = instr[6:4].', 'A mux picks the ALU\'s b (rs2 or the immediate); another picks what is written back (ALU, memory, pc + 1, immediate).', 'Use pointers (net labels) for long wires: pc, imm, the result.'],
    codex: ['singlecycle', 'datapath'],
  },
  {
    id: 'c_core2', act: 5, title: 'Core II: memory', kind: 'core', requires: ['c_core1', 'm_mem'], base: BUILD5.c_core2, par: { nand: 4973, period: 98, cycles: 824 },
    why: 'Loads and stores: the ALU computes the address, the memory answers in the same cycle. Now programs can use more data than eight registers hold.',
    tips: ['daddr = the ALU result, dwdata = rs2, dwe = the control\'s mwe.', 'A load writes drdata back: the result mux\'s second input.'],
    codex: ['loadstore'], anatomy: ['wb'],
  },
  {
    id: 'c_core3', act: 5, title: 'Core III: control flow', kind: 'core', requires: ['c_core2', 'c_npc'], base: BUILD5.c_core3, par: { nand: 5748, period: 98, cycles: 1236 },
    why: 'Branches and jumps make loops and functions possible: the complete RV16I. Every program from Act 4 now runs on hardware you built.',
    tips: ['The branch comparator takes rs1, rs2 and op[1:0]; the next-PC logic loads the PC when it must jump.', 'jal and jalr write pc + 1: the result mux\'s third input.'],
    codex: ['cpi'], unlocks: ['rv16_cpu'],
  },
  {
    id: 'c_computer', act: 5, title: 'A computer', kind: 'build', requires: ['c_core3', 'p_loop'], base: BUILDH.c_computer, par: { nand: 28143, period: 110 },
    why: 'A processor alone computes nothing: it needs a program, memory and a way to show results. Wire your core to a ROM, a RAM and LEDs, decode the addresses, and you have a computer. Then write your own program for it.',
    tips: ['pc is 16 bits, the ROM has 32 words: a splitter gives pc[4:0].', 'Partial decoding: daddr[15] alone tells I/O from RAM (the program only uses the top of the address space for I/O).', 'The LEDs are a 16-bit register written when dwe and daddr[15].', 'Your own program: select the ROM, Edit program…, RV16 assembly.'],
    codex: ['mmio', 'harvard'], anatomy: ['mmio'],
  },
  {
    id: 'c_fast', act: 5, title: 'A faster core', kind: 'core', optional: true, requires: ['c_core3', 'o_fastadd'], base: BUILD5.c_fast, par: { period: 81, cycles: 1236 },
    why: 'Same instructions, shorter clock period: the critical path runs through the adders. Static timing finds it; fast adders shorten it.',
    tips: ['The Timing panel shows the critical path through your core.', 'Swap the ripple adders on that path for the unlocked Kogge–Stone ALU and adders.'],
    codex: ['criticalpath', 'cla'],
  },

  // ---- Act 6 --------------------------------------------------------------------------------
  {
    id: 'pi_lesson', act: 6, title: 'Pipelining', kind: 'lesson', requires: ['c_core3'], body: 'pipe',
    why: 'Cut the datapath into five stages with registers: five instructions in flight, and a clock period set by the slowest stage instead of the whole path.',
    tips: [], codex: ['pipeline', 'hazards'], chapters: [{ chapter: 'pipeline', label: 'Pipelining' }],
  },
  {
    id: 'pi_reg', act: 6, title: 'Pipeline register', kind: 'build', requires: ['s_reg16', 'g_mux8', 'g_or'], base: BUILD6.pi_reg, par: { nand: 307, period: 8 },
    why: 'Between two stages, a register that can hold its value (a stall: the stage waits) or clear itself (a flush: a bubble, all-zero control, does nothing).',
    tips: ['A mux in front picks 0 when clr; the register loads when en or clr.'], codex: ['stall', 'flush'], unlocks: ['rv16_preg'], anatomy: ['p1', 'p2', 'p3', 'p4'],
  },
  {
    id: 'pi_core0', act: 6, title: 'Pipeline I: five stages', kind: 'core', requires: ['pi_lesson', 'pi_reg'], base: BUILD6.pi_core0, par: { nand: 10487, period: 65, cycles: 2508 },
    why: 'The datapath cut into F, D, E, M, W. These programs keep dependent instructions apart and have no branches, so the stages can work without talking to each other.',
    tips: ['Write the register file at the falling edge (clock it with ¬clk): an instruction three behind its producer then reads the new value.', 'Carry everything a later stage needs in the pipeline registers: rd, control signals, the immediate, pc.', 'Report register writes from W and stores from M.'],
    codex: ['pipeline'],
  },
  {
    id: 'pi_fwd', act: 6, title: 'Forwarding unit', kind: 'build', requires: ['g_eq16', 'pi_lesson'], base: BUILD6.pi_fwd, par: { nand: 110, depth: 13 },
    why: 'A result exists at the end of E, but is written back two stages later. The forwarding unit spots when E needs a value that M or W is still carrying, and routes it there.',
    tips: ['Compare 3-bit register numbers: the library equality comparators are unlocked.', 'x0 is never forwarded; M has priority over W (it is newer).'],
    codex: ['forwarding', 'comparator'], unlocks: ['rv16_fwd'], anatomy: ['fwd'],
  },
  {
    id: 'pi_core1', act: 6, title: 'Pipeline II: forwarding', kind: 'core', requires: ['pi_core0', 'pi_fwd'], base: BUILD6.pi_core1, par: { nand: 10981, period: 78, cycles: 970 },
    why: 'Now an instruction uses the result of the one just before it. Two 3:1 muxes in front of the ALU, steered by the forwarding unit, keep the pipeline at one instruction per cycle.',
    tips: ['M\'s forwarded value is its result before memory (ALU, pc + 1 or immediate).', 'Forward rs2 too: stores and branches use it.'],
    codex: ['forwarding'],
  },
  {
    id: 'pi_haz', act: 6, title: 'Hazard unit', kind: 'build', requires: ['g_eq16', 'pi_lesson'], base: BUILD6.pi_haz, par: { nand: 53, depth: 12 },
    why: 'A load\'s value only exists after M. If the very next instruction needs it, no forwarding can help: hold it one cycle.',
    tips: ['A load in E: rwe and wb = memory.', 'Being conservative is allowed (a stall too many only costs a cycle).'],
    codex: ['loaduse'], unlocks: ['rv16_haz'], anatomy: ['haz'],
  },
  {
    id: 'pi_core2', act: 6, title: 'Pipeline III: load-use', kind: 'core', requires: ['pi_core1', 'pi_haz'], base: BUILD6.pi_core2, par: { nand: 11105, period: 78, cycles: 917 },
    why: 'Loads used at once: stall the front (PC and F/D hold), send a bubble into E, then forward from W the cycle after.',
    tips: ['stall: PC en = 0, F/D en = 0, D/E clr = 1.'], codex: ['stall', 'loaduse'],
  },
  {
    id: 'pi_core3', act: 6, title: 'Pipeline IV: branches', kind: 'core', requires: ['pi_core2'], base: BUILD6.pi_core3, par: { nand: 11172, period: 82, cycles: 1495 },
    why: 'A branch is resolved in E; by then the next two instructions were fetched on the guess "not taken". When the guess is wrong, flush them and fetch from the target.',
    tips: ['redirect = the next-PC logic\'s ld in E; it loads the PC and clears F/D and D/E.', 'Every taken branch costs two cycles: the price predictors (and earlier resolution) try to lower.'],
    codex: ['flush', 'controlhazard'],
  },
  { id: 'o_bpred', act: 6, title: 'Branch prediction', kind: 'core', optional: true, requires: ['pi_core3'], soon: true, why: 'Guess taken or not before knowing: fewer flushes, lower CPI.', tips: [], codex: ['bpred'], chapters: [{ chapter: 'pipepay', label: 'Making the pipeline pay' }] },

  // ---- Act 7 --------------------------------------------------------------------------------
  {
    id: 'y_lesson', act: 7, title: 'Traps and interrupts', kind: 'lesson', requires: ['c_core3'], body: 'traps',
    why: 'When the program errs or the world calls, the CPU must stop, save where it was, and jump to a handler.',
    tips: [], codex: ['traps', 'csr'], chapters: [{ chapter: 'traps', label: 'Traps and interrupts' }],
  },
  {
    id: 'y_csr', act: 7, title: 'CSR file', kind: 'build', requires: ['s_reg16', 'g_dec', 'g_mux8', 'y_lesson'], base: BUILD7.y_csr, par: { nand: 2156, period: 19 },
    why: 'mstatus, mtvec, mepc, mcause: the registers of the trap machinery. A trap updates three of them at once; mret undoes it.',
    tips: ['Six 16-bit registers and an 8:1 read mux.', 'mstatus: bits 3 (MIE) and 7 (MPIE) have their own next-value logic; the other bits only change on a write.'],
    codex: ['csr'], unlocks: ['rv16_csr'], anatomy: ['csr'],
  },
  {
    id: 'y_trap', act: 7, title: 'Exceptions', kind: 'core', requires: ['c_core3', 'y_csr'], base: BUILD7.y_trap, par: { nand: 9004, period: 100, cycles: 712 },
    why: 'ecall asks the system for help; ebreak stops for a debugger; an illegal word is a bug. All three replace the instruction by a jump to mtvec, remembering where and why.',
    tips: ['The illegal-instruction detector and the system decoder are given (open them: the detector is a function of the 16-bit word, the decoder computes the CSR write value).', 'On a trap: no register write, no store, pc ← mtvec, mepc ← pc.', 'csrr* write the old CSR value to rd.'],
    codex: ['traps'], gives: ['rv16_ill', 'rv16_sysdec'], unlocks: ['rv16_ill', 'rv16_sysdec'],
  },
  {
    id: 'y_irq', act: 7, title: 'Interrupts', kind: 'core', requires: ['y_trap'], base: BUILD7.y_irq, par: { nand: 9004, period: 100, cycles: 740 },
    why: 'The outside world (a timer, a device) interrupts the program between two instructions. Taken like an exception, but with cause bit 15 set, and only when enabled.',
    tips: ['intr = MIE · MEIE · irq, from the CSR file.', 'Check it before the instruction at pc runs; it wins over everything else.'],
    codex: ['interrupts'], unlocks: ['rv16_cpu_irq'],
  },
  {
    id: 'p_handler', act: 7, title: 'An interrupt handler', kind: 'program', requires: ['y_lesson', 'p_call'], par: { size: 22 },
    why: 'An interrupt can arrive between any two instructions of main: the handler must save every register it touches, service the device, acknowledge it and return with mret, leaving main none the wiser.',
    tips: ['mtvec ← the handler\'s address; mie ← 0x800 (MEIE); then set mstatus bit 3 (MIE) last.', 'push / pop what the handler uses (main\'s registers must survive).', 'Acknowledge with <code>sw x0, -7(x0)</code> before mret, or the interrupt fires again at once.'],
    codex: ['interrupts', 'traps'],
  },
  {
    id: 'y_final', act: 7, title: 'Finale: the complete RV16', kind: 'core', requires: ['pi_core3', 'y_irq'], base: BUILD7.y_final, par: { nand: 15050, period: 88, cycles: 2399 },
    why: 'The pipelined processor with precise traps and interrupts: every block you built, from the NAND up, in one chip that runs real programs, handles its own errors and answers the outside world.',
    tips: ['Take traps in E: older instructions in M and W still complete, younger ones in F and D are flushed.', 'Carry a valid bit: a bubble\'s all-zero word would otherwise look like an illegal instruction.', 'A CSR instruction reads and writes in E; its old value travels down as the result.'],
    codex: ['precise'],
  },

  // ---- Act 8 --------------------------------------------------------------------------------
  {
    id: 'o_mulseq', act: 8, title: 'Shift-and-add multiplier', kind: 'build', optional: true, requires: ['a_add16', 's_reg16'], base: BUILD8.o_mulseq, givesOf: partsOf(() => seqMul(16)), par: { nand: 1169, period: 48 },
    why: 'Software multiplication (Act 4) in hardware: one adder reused once per clock. Small, and sixteen times slower than an array.',
    tips: ['The product register starts as {0, b}; each step adds a to its upper half if its lowest bit is 1, then shifts everything right.'],
    codex: ['shiftadd'], chapters: [{ chapter: 'muldiv', label: 'Multiply & divide' }],
  },
  {
    id: 'o_mularr', act: 8, title: 'Array multiplier', kind: 'build', optional: true, requires: ['a_add16'], base: BUILD8.o_mularr, givesOf: partsOf(() => arrayMul(8)), par: { nand: 632, depth: 70 },
    why: 'All partial products at once, summed by rows of adders: one long combinational path, n² cells. The opposite trade to shift-and-add.',
    tips: ['Row k is a AND b[k], shifted left by k.', 'Add the rows one after the other: each adder\'s carry out becomes the next row\'s top bit.'],
    codex: ['arraymul'],
  },
  { id: 'o_mcore', act: 8, title: 'Multiply in the core', kind: 'core', optional: true, requires: ['c_core3', 'o_mularr'], soon: true, why: 'The MD opcode: mul, mulh.', tips: [], codex: ['mext'] },
  {
    id: 'o_div', act: 8, title: 'Divider', kind: 'build', optional: true, requires: ['a_addsub16', 's_fsm'], base: BUILD8.o_div, givesOf: partsOf(() => seqDivider(16)), par: { nand: 1490, period: 31 },
    why: 'Long division in binary: one subtract-and-compare per quotient bit, run by a small state machine. Division is slow everywhere: even fast CPUs take tens of cycles.',
    tips: ['Shift the remainder left, bring in the next dividend bit, subtract the divisor: if the result is not negative keep it and set the quotient bit.'],
    codex: ['division'],
  },
  { id: 'o_dcore', act: 8, title: 'Divide in the core', kind: 'core', optional: true, requires: ['o_mcore', 'o_div'], soon: true, why: 'div and rem stall the core until done.', tips: [], codex: ['mext'] },
  {
    id: 'n_float', act: 8, title: 'Floating point', kind: 'drill', optional: true, requires: ['n_twos'], drill: 'float', par: { mistakes: 2 },
    why: 'Sign, exponent, fraction: a binary scientific notation that trades exactness for range. Encode and decode binary16 by hand before building its adder.',
    tips: ['Write the value as 1.f × 2^e; the exponent field is e + 15.'], codex: ['ieee754'], chapters: [{ chapter: 'float', label: 'Floating point' }],
  },
  {
    id: 'o_fpadd', act: 8, title: 'FP adder', kind: 'build', optional: true, requires: ['n_float', 'a_shift16'], base: BUILD8.o_fpadd, givesOf: partsOf(() => fpAdd(F16)), par: { nand: 3785, depth: 163 },
    why: 'Adding floats means aligning their binary points first, then adding, normalising and rounding: the hardest of the four operations to get exactly right.',
    tips: ['Swap so that |a| ≥ |b|, shift b right by the exponent difference (keep a sticky bit), add or subtract the significands.', 'One rounder serves every operation: the given one rounds in all five modes.'],
    codex: ['ieee754', 'rounding'],
  },
  {
    id: 'o_fpmul', act: 8, title: 'FP multiplier', kind: 'build', optional: true, requires: ['o_fpadd', 'o_mularr'], base: BUILD8.o_fpmul, givesOf: partsOf(() => fpMul(F16)), par: { nand: 4965, depth: 150 },
    why: 'Multiplying floats is simpler than adding them: multiply the significands, add the exponents, XOR the signs, then normalise and round.',
    tips: ['11 × 11 bits gives a 22-bit product; its top bit decides whether to shift by one.'], codex: ['ieee754'],
  },
  { id: 'o_cache', act: 8, title: 'A cache', kind: 'build', optional: true, requires: ['m_mem', 'g_eq16'], soon: true, why: 'Keep recently used words close: tags, valid bits, hits and misses.', tips: [], codex: ['cache'], chapters: [{ chapter: 'cache', label: 'Caches' }] },
  { id: 'o_mc', act: 8, title: 'Multicycle CPU', kind: 'core', optional: true, requires: ['c_core3', 's_fsm'], soon: true, why: 'One instruction over several short cycles, run by a state machine or by microcode.', tips: [], codex: ['microcode', 'fsm'], chapters: [{ chapter: 'multicycle', label: 'Multicycle & microcode' }] },
];

export const nodeById = (id: string): CampaignNode | undefined => NODES.find((n) => n.id === id);
