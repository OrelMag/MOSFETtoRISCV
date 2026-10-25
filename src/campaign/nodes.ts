// The campaign's levels, act by act. Each level says why the block exists (its place in the
// CPU), what it builds on, what it unlocks for the levels after it, hints, codex entries and par.
// Levels marked `soon` are on the map but not playable yet (docs/CAMPAIGN.md tracks them).

import { challengeById } from '../editor/challengeset';
import { BUILD1 } from './build1';
import { BUILD5 } from './build5';
import { BUILD6 } from './build6';
import { BUILD7 } from './build7';
import { BUILD8, partsOf } from './build8';
import { BUILD9 } from './build9';
import { BUILDCARD } from './buildcard';
import { BUILDFP, FP_REF, fpGives } from './buildfp';
import { BUILDH } from './buildh';
import { BUILDK } from './buildk';
import { BUILDM } from './buildm';
import { BUILDR } from './buildr';
import { fpAdd, fpMul, lzc, ROUND_DECIDE } from '../lib/fpu';
import { arrayMul, seqDivider } from '../lib/muldiv';
import { seqMul } from '../lib/multiply';
import { RV16_MUX2 } from '../lib/rv16/logic';
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
  { num: 11, label: 'Act P', title: 'Before the transistor', blurb: 'Optional, beside act 0: the same logic in what computers were first built from. Relays, whose contacts pass a signal both ways and add 32 bits in one 8 ms step; vacuum tubes, ten thousand times faster, that only pull down and need a divider between every two gates; and cards, how the program got in.' },
  { num: 1, title: 'Logic', blurb: 'From one gate, every Boolean function. Decoders choose a register, multiplexers route operands, comparators decide branches: the CPU\'s control is all logic.' },
  { num: 2, title: 'Numbers and arithmetic', blurb: 'Bits become numbers when you agree on what they mean. Then one adder does addition, subtraction and comparison: the heart of the ALU.' },
  { num: 3, title: 'State and memory', blurb: 'Logic forgets; a CPU must remember: the program counter, eight registers, data. Feedback makes a latch, two latches make a flip-flop, flip-flops make everything else.' },
  { num: 4, title: 'The instruction set and assembly', blurb: 'The contract between hardware and software. Before building the processor, learn what it must do, by programming it.' },
  { num: 5, title: 'A single-cycle CPU', blurb: 'Wire your blocks into a datapath, add the control that tells them what to do, and run your own programs on your own processor.' },
  { num: 6, title: 'Pipelining', blurb: 'Five instructions in flight at once: a shorter clock period, and the hazards that come with it. Forwarding, stalls and flushes keep it correct.' },
  { num: 7, title: 'The system: traps and interrupts', blurb: 'A real processor reacts to the outside world and to its own mistakes. CSRs, exceptions and interrupts, precise even in the pipeline: the finale.' },
  { num: 8, title: 'Side quests', blurb: 'Optional: multiply and divide, and floating point. Each trades area or cycles against your core\'s NANDs, period and cycles, and each level measures which way the trade went.' },
  { num: 9, title: 'Throughput: a GPU', blurb: 'Optional, from Core III on: the same bricks arranged for throughput instead of latency: one instruction stream, four lanes, each with its own registers. Then the hard part: what the lanes do when they disagree.' },
  { num: 10, title: 'Memory', blurb: 'Optional, from A computer on: what sits behind the data port. Charge on a bit line, a row buffer that leaks, a controller that keeps a chip\'s timings and refreshes it.' },
];

/** An act's name as the map and the crumbs show it: "Act 3", or its own label ("Act P"). */
export const actName = (num: number): string => ACTS.find((a) => a.num === num)?.label ?? `Act ${num}`;

/** An act's title by its number (acts are listed in map order, not by number). */
export const actTitle = (num: number): string => ACTS.find((a) => a.num === num)?.title ?? '';

export const NODES: CampaignNode[] = [
  // ---- Act 0 --------------------------------------------------------------------------------
  {
    id: 'intro', act: 0, title: 'Anatomy of a CPU', kind: 'lesson', requires: [],
    why: 'What a processor is made of, and why each block. The diagram is the machine you finish with, RV16 pipelined with traps and interrupts, 12 038 NANDs. Each block lights up as you build it, in an order where every block needs only the ones before it.',
    body: 'intro',
    tips: [], codex: ['cpu', 'fde', 'abstraction'],
    chapters: [{ chapter: 'map', label: 'The map' }, { chapter: 'cpu', label: 'A single-cycle CPU' }],
  },
  {
    id: 't_inv', act: 0, title: 'CMOS inverter', kind: 'build', requires: ['intro'], base: sandbox('t_inv'),
    why: 'The first circuit is a switch whose output can drive the next switch\'s gate. Two complementary MOSFETs do it with 2 transistors: one pulls y up, the other down, never both, so no static current flows. The NAND of the next level is the same rule with two inputs.',
    tips: ['A PMOS conducts when its gate is 0, an NMOS when it is 1.', 'PMOS from VDD to y, NMOS from y to GND, both gates on a.', 'Swapped (NMOS on top), each transistor passes only a weak level, H or L, and Check fails a weak output.'],
    codex: ['mosfet', 'cmos', 'inverter', 'power'], unlocks: ['inv_cmos'], par: { transistors: 2 },
    chapters: [{ chapter: 'mosfet', label: 'The MOSFET' }, { chapter: 'inverter', label: 'The CMOS inverter' }, { chapter: 'inverter', step: 2, label: 'The wrong way round: weak levels' }],
  },
  {
    id: 't_nand', act: 0, title: 'CMOS NAND', kind: 'build', requires: ['t_inv'], base: sandbox('t_nand'),
    why: 'An inverter computes one function; a CPU needs all of them. NAND is complete: 4 transistors, 1 delay, the unit every later cost is counted in. From NOT from NAND on it is your only brick: the finished RV16 is 12 038 of them.',
    tips: ['The pull-down network must conduct only when a = b = 1: put the NMOS in series.', 'The pull-up must conduct when either input is 0: PMOS in parallel.', 'PMOS in series too would leave y floating (Z) for a = 1, b = 0: no network conducts.'],
    codex: ['nand', 'universality', 'duality', 'stdcell'], unlocks: ['nand'], par: { transistors: 4 },
    chapters: [{ chapter: 'nand', label: 'The NAND gate' }, { chapter: 'nand', step: 2, label: 'One brick to build everything' }],
  },
  {
    id: 't_nor', act: 0, title: 'CMOS NOR', kind: 'build', optional: true, requires: ['t_inv'], base: sandbox('t_nor'),
    why: 'NOR is NAND\'s dual, also complete and also 4 transistors, yet the campaign builds on NAND: NOR puts its PMOS in series, and holes are about 2–3× less mobile than electrons. Nothing later uses this cell; at gate level a NOR is four NANDs.',
    tips: ['Swap series and parallel relative to the NAND.', 'y = 1 only when a = b = 0: that network is the one in series, and it is the PMOS pair.', 'NMOS in series is the NAND again: y = 0 only for a = b = 1 fails the 01 and 10 rows.'],
    codex: ['nor', 'duality'], unlocks: ['nor_cmos'], par: { transistors: 4 },
    chapters: [{ chapter: 'nand', step: 1, label: 'NOR, for comparison' }],
  },

  // ---- Act P: before the transistor ----------------------------------------------------------
  {
    id: 'r_pull', act: 11, title: 'Pull-in and drop-out', kind: 'drill', optional: true, requires: ['intro'], drill: 'relay', par: { mistakes: 2 },
    why: 'Before a relay is logic it is a magnet against a spring: the chapter\'s relay pulls in at 15.2 V of its 24, drops out only below 3.6 V, and rests 8.2 ms after switch-on. From A relay NAND on, all of that is one relay step.',
    tips: ['Pull-in: where the magnet\'s pull at the full gap first beats the spring\'s preload. Drop-out: where the pull with the gap closed falls below the stretched spring.', 'Settled time counts the bounces: read the last closing, not the first touch.'],
    codex: ['relay', 'relaystep'],
    chapters: [{ chapter: 'relays', label: 'Relays' }],
  },
  {
    id: 'r_nand', act: 11, title: 'A relay NAND', kind: 'build', optional: true, requires: ['r_pull'], base: BUILDR.r_nand, par: { relays: 2, steps: 1 },
    why: 'The brick again, in what the Z3 was built from. Two break contacts in parallel from the supply give 1 unless both coils pull: 2 relays, one 8.2 ms step, an open line reading 0. The XOR and the holding relay build on these contacts.',
    tips: ['a and b each operate a relay: the pin on the coil\'s a end, GND on its b end.', 'From VDD through each relay\'s break contact (c to nc) to y: either released relay connects y to the supply.', 'An output nobody drives reads Z here: end y on a pull-down, the next relay\'s coil drawn as its resistance.'],
    codex: ['openzero'], chapters: [{ chapter: 'relays', step: 2, label: 'Contacts conduct both ways' }],
  },
  {
    id: 'r_xor', act: 11, title: 'Changeover XOR', kind: 'build', optional: true, requires: ['r_nand'], base: BUILDR.r_xor, par: { relays: 2, steps: 1 },
    why: 'Mapped from NANDs, XOR is 4 relays and 3 relay steps. A changeover contact is a 2:1 multiplexer that passes either way, so XOR is 2 relays and one step. The adder of the next level is this pattern with a carry.',
    tips: ['Relay a: VDD on its common, so exactly one of its no / nc lines carries the supply.', 'Relay b: its common is y; its no and nc go to a\'s lines crossed over (b\'s nc to a\'s no, b\'s no to a\'s nc).', 'End y on a load.'],
    codex: ['relay'], chapters: [{ chapter: 'relays', step: 3, label: 'What contacts are good at' }],
  },
  {
    id: 'r_adder', act: 11, title: 'Carry through contacts', kind: 'build', optional: true, requires: ['r_xor'], base: BUILDR.r_adder, par: { relays: 8, steps: 1 },
    why: 'Mapped from NANDs, a 4-bit ripple adder is 36 relays and 12 relay steps. Here the carry runs through the operands\' contacts on two lines, c and ¬c, and never waits for a coil: 8 relays, and the sum is ready one step after the operands, for 4 bits or 32.',
    tips: ['Carry in is 0: the c line open, the ¬c line on VDD.', 'co = b ? (a ? 1 : c) : (a ? c : open); ¬co is its mirror. s = a ? (b ? c : ¬c) : (b ? ¬c : c): two lines chosen by b, then one of them by a.', 'Per bit, relay a needs five poles (four for the carry pair, one for the sum), relay b four. Build one bit as a chip, then chain four.', 'End each sum line and the carry out on a load.'],
    codex: ['contactcarry'], chapters: [{ chapter: 'relays', step: 4, label: 'A carry that needs no time' }],
  },
  {
    id: 'r_latch', act: 11, title: 'A relay that holds', kind: 'build', optional: true, requires: ['r_nand'], base: BUILDR.r_latch, par: { relays: 3 },
    why: 'Logic forgets when its inputs change. A relay feeding its own coil through its own contact stays in after the pulse is gone, until a break contact in that path opens: one relay a bit, how the Z3 held its memory. The buzzer clock builds on it.',
    tips: ['q is the coil line of the holding relay k. Set operates a relay whose make contact puts VDD on q.', 'k feeds itself: its make contact connects q to a holding line.', 'The holding line comes from VDD through the break contact of a reset relay: reset opens it, and k drops out.'],
    codex: ['selfhold'], chapters: [{ chapter: 'relays', step: 5, label: 'Memory that holds itself' }],
  },
  {
    id: 'r_clock', act: 11, title: 'The buzzer clock', kind: 'build', optional: true, requires: ['r_latch'], base: BUILDR.r_clock, par: { relays: 2 },
    why: 'A relay fed through its own break contact cannot rest: a buzzer, a clock of two relay steps. A second relay toggling only while the first is in halves it: 2 relays for a counter bit, where the NAND-mapped T flip-flop alone is 23. The card loader counts with such bits.',
    tips: ['Buzzer: en on the common of k\'s break contact, the break contact on k\'s own coil line, which is y.', 'The divider relay t toggles whenever k is operated: its coil then reads a line that carries VDD only while t is released; while k is released it reads one that carries VDD only while t is operated.', 'Both lines come from t\'s own changeover contact with VDD on its common; one more pole of k chooses between them. q: a make contact of t to a load.'],
    codex: ['buzzer'], chapters: [{ chapter: 'relays', step: 6, label: 'A relay that cannot stop' }],
  },
  {
    id: 'v_inv', act: 11, title: 'Two tubes in a row', kind: 'build', optional: true, requires: ['intro'], base: BUILDR.v_inv, par: { tubes: 2 },
    why: 'A triode switches a thousand times faster than a relay, but its levels do not line up: a plate swings between 81 and 250 V, a grid needs 0 V to conduct and −12.5 V to stop. So every grid reads through a divider to −150 V: 2 triode sections here, the link Eccles–Jordan needs twice.',
    tips: ['Each inverter: a plate resistor from B+ (+250 V) to the plate, the triode from the plate to GND (its cathode), the plate is the output.', 'Every grid reads its input through a divider: a divider resistor from the plate (or the input, also a plate level) to the grid, a bias resistor from the grid to −150 V.', 'na is the first plate, y the second.'],
    codex: ['triode', 'griddivider'], chapters: [{ chapter: 'tubes', step: 2, label: 'Levels that do not line up' }],
  },
  {
    id: 'v_ff', act: 11, title: 'Eccles–Jordan', kind: 'build', optional: true, requires: ['v_inv'], base: BUILDR.v_ff, par: { tubes: 4 },
    why: 'Memory at tube speed. Two triodes, each holding the other\'s grid down through a divider, keep a bit (Eccles and Jordan, 1918): 2 sections of one bulb and 2 steering diodes to set and reset it. Every flip-flop of the tube machines, ENIAC\'s decade counters included, was this pair.',
    tips: ['Two inverters, each grid reading the other\'s plate through a divider: q is one plate, nq the other.', 'set must turn on the tube whose plate is nq, reset the other one. A wire from the pin to the grid would also hold the grid at 0 while the pin is 0.', 'Steering diodes, anode on the pin and cathode on the grid: a 1 pulls the grid up, a 0 lets go.'],
    codex: ['ecclesjordan'], chapters: [{ chapter: 'tubes', step: 5, label: 'One bit in one bulb' }],
  },
  {
    id: 'h_card', act: 11, title: 'Read a card', kind: 'drill', optional: true, requires: ['intro'], drill: 'hollerith', par: { mistakes: 2 },
    why: 'A machine with an empty memory needs its program from somewhere, and for seventy years that was cards. Read the Hollerith code both ways, then the binary kind, a word in row 9, one bit a column: Program on cards loads a deck of those.',
    tips: ['Zones: 12 for A–I, 11 for J–R, 0 for S–Z (S is 0-2, so the digits under that zone start at 2).', 'Object cards: a hole in row 9 is a 1, and column 1 is the most significant bit.'],
    codex: ['hollerith'],
    chapters: [{ chapter: 'cards', step: 2, label: 'Eighty columns' }],
  },
  {
    id: 'h_loader', act: 11, title: 'Program on cards', kind: 'build', optional: true, requires: ['h_card', 'r_clock', 's_dff'], base: BUILDCARD.h_loader,
    par: { relays: 233, cycles: 182 }, gives: ['not', 'and', 'or', 'dff', 'counter8', 'mux2x8', 'cpu4_proc', 'ram256x16'],
    why: 'A stored-program machine starts with its memory empty and its program in the reader. The loader copies the deck in: a counter, a write per card and a switch handing memory to the CPU, 233 relays at par, 172 of them the counter. The Z3 never did this: it ran its film as it read it.',
    tips: [
      'Tie the reader\'s next to 1: it takes a card at every rising edge one waits. Then ready is the write enable: the card\'s word goes into the RAM word the counter addresses, and the counter (enabled by ready) moves on at the same edge.',
      'The RAM\'s address is a 2:1 mux on run: the counter while loading, the CPU\'s pc after. Tie test and sw to 0.',
      'Hold the CPU back by its clock: clk AND run. run must not rise while clk is high (the CPU would see half a pulse before its first word is through the mux): take empty into a flip-flop clocked on the falling edge, clk through a NOT.',
      'Cycles: the reader sets the pace, a card every four edges. Take each card as soon as it is ready and raise run in the cycle the last one goes, and you are at par.',
    ],
    codex: ['loader'],
    chapters: [{ chapter: 'cards', step: 4, label: 'A machine that reads them' }],
  },

  // ---- Act 1 --------------------------------------------------------------------------------
  {
    id: 'l_bool', act: 1, title: 'Boolean algebra', kind: 'drill', requires: ['intro'],
    why: 'A circuit is an equation, and a cheaper circuit is the same equation rewritten. The 2:1 multiplexer read straight off its table is 8 NANDs; rewritten into NAND–NAND it is 4. OR from NAND, the multiplexer and the K-map level all start from these laws.',
    body: 'bool', tips: ['Absorption first: a + a·b = a and a + ¬a·b = a + b remove most redundant terms.', 'De Morgan flips the operator and complements every term: ¬(a·b) = ¬a + ¬b.', 'When the algebra stalls, list the truth table: the minimal sum is read off it, not guessed.'],
    codex: ['identities', 'demorgan', 'bubble', 'sop', 'truthtable'],
    chapters: [{ chapter: 'gates', label: 'Gates from NAND' }], drill: 'boolean', par: { mistakes: 2 } },
  {
    id: 'n_bin', act: 1, title: 'Binary and hex', kind: 'drill', requires: ['intro'], drill: 'binary', par: { mistakes: 2 },
    why: 'A wire carries a bit; a number is a convention about many. Unsigned: bit k weighs 2^k, a 16-bit word holds 0 to 65 535, and four bits make one hex digit. The decoder and the prime detector read their inputs as numbers; two\'s complement reuses the patterns.',
    tips: ['Each hex digit is exactly four bits.', 'Bit k weighs 2^k.', 'Group bits in fours from bit 0, the right end: 1 1111 is 0x1F, not 0xF1.'],
    codex: ['positional', 'hex'], chapters: [{ chapter: 'binary', label: 'Binary numbers' }],
  },
  {
    id: 'g_not', act: 1, title: 'NOT from NAND', kind: 'build', requires: ['t_nand'], base: sandbox('g_not'),
    why: 'Nearly every circuit needs a complement: a mux needs ¬s, the decoder the complemented register number, a flip-flop ¬clk. NOT is 1 NAND with its inputs tied; the single-cycle core holds 196 of them. AND, OR and the multiplexer come next, built on it.',
    tips: ['¬(a·a) = ¬a.', 'Tie both NAND inputs to a. An input left open reads X, not 1, and so does y.'],
    codex: ['not'], unlocks: ['not'], par: { nand: 1, depth: 1 },
    chapters: [{ chapter: 'gates', step: 0, label: 'NOT: tie the inputs together' }],
  },
  {
    id: 'g_and', act: 1, title: 'AND from NAND', kind: 'build', requires: ['g_not'], base: sandbox('g_and'),
    why: 'Every enable is an AND: the register file writes x[rd] only when rwe AND rd\'s decoder line are 1. A NAND gives the complement, so AND is a NAND and a NOT, 2 NANDs; the single-cycle core holds 86 of them. XOR, the decoder and the wide gates use it.',
    tips: ['AND = NOT(NAND).', 'The NOT goes after the NAND: inverting the inputs instead gives ¬a NAND ¬b = a + b, an OR.'],
    codex: ['and'], unlocks: ['and'], par: { nand: 2, depth: 2 },
    chapters: [{ chapter: 'gates', step: 1, label: 'AND: undo the NOT' }],
  },
  {
    id: 'g_or', act: 1, title: 'OR from NAND', kind: 'build', requires: ['g_not', 'l_bool'], base: sandbox('g_or'),
    why: 'Conditions merge: the next PC jumps on jal OR jalr OR a taken branch. NAND has no OR in it until De Morgan: a + b = ¬(¬a · ¬b), 3 NANDs. The zero detect is fifteen ORs in a tree, and every sum of products is an OR in disguise.',
    tips: ['a + b = ¬(¬a · ¬b).', 'Invert both inputs (two NANDs as NOTs), then one NAND.', 'Invert the inputs, not the output: a NOT after the NAND makes an AND.'],
    codex: ['or', 'demorgan'], unlocks: ['or'], par: { nand: 3, depth: 2 },
    chapters: [{ chapter: 'gates', step: 2, label: 'OR: De Morgan\'s trick' }],
  },
  {
    id: 'g_xor', act: 1, title: 'XOR from NAND', kind: 'build', requires: ['g_and', 'g_or'], base: sandbox('g_xor'),
    why: 'The adder\'s sum bit, the subtractor\'s controlled inverter and the equality test\'s difference detector are one function, a ⊕ b. Sharing ¬(a·b) between both halves makes it 4 NANDs where the textbook sum of products is 5. The half adder and the equality test come next.',
    tips: ['Start from n = ¬(a·b).', 'a ⊕ b = ¬(¬(a·n) · ¬(b·n)): four NANDs in total.', 'Build n once and feed it to both halves: two copies make 5 NANDs and miss par.'],
    codex: ['xor'], unlocks: ['xor', 'xnor'], par: { nand: 4, depth: 3 },
    chapters: [{ chapter: 'gates', step: 4, label: 'XOR: are they different?' }],
  },
  {
    id: 'g_mux', act: 1, title: '2:1 multiplexer', kind: 'build', requires: ['g_not', 'l_bool'], base: sandbox('g_mux'),
    why: 'Wherever two values reach one input the hardware must choose: rs2 or the immediate, pc + 1 or a jump target. A 2:1 multiplexer does it in 4 NANDs, depth 3 (as AND–OR, 8 NANDs, depth 5); the single-cycle core has 705 bits of it. The bus multiplexer is sixteen.',
    tips: ['y = s·b + ¬s·a: a sum of products.', 'Sum of products → NAND–NAND: ¬(¬(s·b) · ¬(¬s·a)).', 's = 1 selects b: with a and b swapped, half the table fails.'],
    codex: ['mux', 'sop'], unlocks: ['mux2'], par: { nand: 4, depth: 3 },
    chapters: [{ chapter: 'gates', step: 6, label: 'The multiplexer: a digital switch' }],
  },
  {
    id: 'd_kmap', act: 1, title: 'Karnaugh maps', kind: 'drill', requires: ['l_bool'], drill: 'kmap', par: { mistakes: 2 },
    why: 'Algebra does not say when a sum of products is minimal, yet the control unit is 14 output bits, each a sum to minimise. A K-map draws the table so that neighbours differ in one bit: each doubling of a group drops a literal. The prime detector is built this way next.',
    tips: ['Groups are rectangles of 1, 2, 4 or 8 cells; edges wrap around.', 'Every 1 must be covered; overlapping groups are fine.', 'Rows and columns run in Gray order, 00 01 11 10: cells next to each other in binary order are not neighbours.'],
    codex: ['kmap', 'qm', 'dontcare'],
  },
  {
    id: 'g_sop', act: 1, title: 'Prime detector', kind: 'build', requires: ['d_kmap', 'g_and', 'g_or', 'n_bin'],
    why: 'The control unit (Act 5) is a table, opcode and f3 to 14 signals, that must become gates. Practise on one 4-input function: K-map, minimal sum, NAND–NAND, 20 NANDs; par is 8, from what the terms share. The control unit applies it to each of its 14 outputs.',
    tips: ['Minimise first: every literal saved is a gate input saved.', 'An SoP maps one-to-one onto NAND–NAND: 20 NANDs here, depth 7 (the 3-literal products and the 4-input OR are built from 2-input gates). Par is less than half that.', 'Compare the map\'s two halves (a3 = 0, a3 = 1): one is a function you have built, the other almost the same.'],
    unlocks: ['rv16_prime4'], codex: ['sop', 'nandnand'], base: BUILD1.g_sop, par: { nand: 8, depth: 5 } },
  {
    id: 'g_wide', act: 1, title: 'Zero detect', kind: 'build', requires: ['g_and', 'g_or'],
    why: 'Is a word zero? Fifteen 2-input ORs answer it however they are arranged, 46 NANDs with the NOT, but a chain is 31 NAND delays deep and a balanced tree 9. Depth, not gate count, sets the clock: the equality test and the ALU\'s zero output end in this tree.',
    tips: ['Balance the tree: pairs, then pairs of pairs.', 'The chain and the tree cost the same NANDs: only the depth differs.', 'zero = ¬any: one NOT at the end, not sixteen at the inputs.'],
    codex: ['fanin', 'depth', 'bubble'], unlocks: ['rv16_wide16', 'and3', 'and4', 'and8', 'or3', 'or4', 'or8', 'or16', 'zero*', 'andx*', 'orx*', 'xorx*'], base: BUILD1.g_wide, par: { nand: 46, depth: 9 } },
  {
    id: 'g_dec', act: 1, title: '3→8 decoder', kind: 'build', requires: ['g_wide', 'n_bin'],
    why: 'Eight registers share one write port: the 3-bit rd must become eight enables, one of them 1, none while rwe = 0. Eight 4-input ANDs cost 51 NANDs; decoding two bits at a time and sharing the halves, in 30. The register file\'s write port is one.',
    tips: ['Output k is the AND of the address bits or their complements matching k, and of the enable.', 'Eight 4-input ANDs cost 51. Decode two inputs at a time first: each partial line then serves several outputs.', 'Every en = 0 row must give all zeros, and a0 is the low bit: output 1 is a = 001.'],
    codex: ['decoder'], unlocks: ['rv16_dec3', 'dec*'], base: BUILD1.g_dec, par: { nand: 30, depth: 5 },
    chapters: [{ chapter: 'routing', step: 0, label: 'The decoder: a number becomes one wire' }, { chapter: 'routing', step: 1, label: 'With an enable' }] },
  {
    id: 'g_mux8', act: 1, title: 'Bus multiplexer', kind: 'build', requires: ['g_mux'],
    why: 'Every choice in the datapath is 16 bits wide: sixteen 1-bit multiplexers on one select. Sharing ¬s makes the bus mux 49 NANDs instead of 64, and the single-cycle core holds 37 of them; trees of it are the register file\'s read ports.',
    tips: ['A wide mux is a row of 1-bit muxes sharing the select (and its inverter).', 'An 8:1 mux is a tree of 2:1 muxes, one select bit per level.', 'One ¬s for all sixteen bits: an inverter per bit costs 15 NANDs over par.'],
    codex: ['mux', 'bus'], unlocks: ['rv16_mux*', 'mux*'], base: BUILD1.g_mux8, par: { nand: 49, depth: 3 },
    chapters: [{ chapter: 'routing', step: 3, label: 'Switching whole buses' }, { chapter: 'routing', step: 4, label: '8 words in, 1 word out' }] },
  {
    id: 'g_eq16', act: 1, title: 'Equality', kind: 'build', requires: ['g_xor', 'g_wide'],
    why: 'beq and bne branch on rs1 = rs2, and forwarding asks the same of register numbers. No bit may differ: 16 XORs and the zero detect, 110 NANDs, depth 12. Zero-detecting the comparator\'s a + ¬b + 1 would save 64 NANDs but wait for its carry chain, depth 46.',
    tips: ['a = b ⇔ every bit of a ⊕ b is 0: XOR then zero-detect.', 'The zero detect\'s tree is already unlocked: one per word, not one per bit.', 'eq is the zero output of the XORs; the OR of the XORs (any) is ≠, the opposite.'],
    codex: ['comparator'], unlocks: ['rv16_eq16', 'eq*'], base: BUILD1.g_eq16, par: { nand: 110, depth: 12 },
    chapters: [{ chapter: 'gates', step: 5, label: 'XNOR: are they equal?' }] },

  // ---- Act 2 --------------------------------------------------------------------------------
  {
    id: 'n_twos', act: 2, title: "Two's complement", kind: 'drill', requires: ['n_bin'], drill: 'twos', par: { mistakes: 2 },
    why: 'The ALU must handle negative numbers without a second subtractor. In two\'s complement the top bit weighs −2^15, so −x = ¬x + 1 and one adder serves signed and unsigned alike: a 16-bit word holds −32 768 to 32 767. The adder / subtractor, sra and every immediate rely on it.',
    tips: ['−x = ¬x + 1.', 'Overflow: both operands have the same sign and the result has the other.', 'Overflow is about signs, not the carry out: −1 + 1 carries out of 0xFFFF + 1 and is right.'],
    codex: ['twos', 'overflow', 'signext'], chapters: [{ chapter: 'binary', step: 1, label: "Negative numbers: two's complement" }],
  },
  {
    id: 'a_ha', act: 2, title: 'Half adder', kind: 'build', requires: ['g_xor', 'n_bin'], base: sandbox('a_ha'),
    why: 'Bits are numbers now, and nothing adds them yet. One column is two bits in, a sum and a carry out: XOR and AND, and the XOR\'s first NAND already holds the carry\'s complement, so 5 NANDs. The full adder is two of them; the PC\'s incrementer fifteen in a row.',
    tips: ['The XOR\'s first NAND is ¬(a·b): invert it for the carry.', 'The carry is a·b, not a + b; a separate AND beside the XOR is 6 NANDs and misses par.'],
    codex: ['halfadder'], unlocks: ['half_adder'], par: { nand: 5, depth: 3 },
    chapters: [{ chapter: 'adders', label: 'Adders' }],
  },
  {
    id: 'a_fa', act: 2, title: 'Full adder', kind: 'build', requires: ['a_ha'], base: sandbox('a_fa'),
    why: 'A column of a wider sum has three inputs, two bits and the carry from its right, and the half adder takes only two. Chained, full adders add any width: the single-cycle core holds 64, four 16-bit chains, and pays the carry path at every bit: 2 delays from cin to cout at par, 4 in the 13-NAND version.',
    tips: ['Two half adders and an OR: 13 NANDs.', 'The carry ¬(¬(a·b) · ¬(cin·(a⊕b))) reuses both XORs\' first NANDs: 9.', 'cout is the majority of a, b and cin: (a ⊕ b)·cin alone misses a = b = 1.'],
    codex: ['fulladder', 'majority'], unlocks: ['full_adder', 'full_adder_ha'], par: { nand: 9, depth: 6 },
    chapters: [{ chapter: 'adders', step: 1, label: 'Adding three bits' }, { chapter: 'adders', step: 2, label: 'Optimizing: 13 NANDs → 9' }],
  },
  {
    id: 'a_add4', act: 2, title: '4-bit ripple adder', kind: 'build', requires: ['a_fa'], base: sandbox('a_add4'),
    why: 'One full adder adds one column; a word needs one per bit, each carry out wired to the next carry in. The carry ripples from bit 0 upward: 36 NANDs, depth 12, 2 more delays for every bit added. The 16-bit adder is four of these.',
    tips: ['Splitters and mergers are free.', 'cout of bit k → cin of bit k + 1.', 'Watch the splitter\'s bit order (bit 0 gets cin), and drive cin: left open it reads X, and so does every sum it reaches.'],
    codex: ['ripple'], unlocks: ['rca4'], par: { nand: 36, depth: 12 },
    chapters: [{ chapter: 'adders', step: 3, label: 'Chaining: the ripple-carry adder' }],
  },
  {
    id: 'a_add16', act: 2, title: '16-bit adder', kind: 'build', requires: ['a_add4'],
    why: 'RV16 adds 16-bit words in four places: the ALU, the branch comparator and the next-PC logic\'s pc + imm and rs1 + imm. Each is this chain: 144 NANDs, depth 36. The ALU is 50 of the single-cycle core\'s 98-delay period: Core IV, at the end of Act 5, shortens it with Fast adders.',
    tips: ['Hierarchy: four 4-bit adders, not sixteen full adders.', 'Each adder\'s cout is the next one\'s cin; the last cout is the word\'s.', 'The low nibble\'s adder takes cin: check the splitter\'s order before blaming the adders.'],
    codex: ['ripple', 'criticalpath'], unlocks: ['rv16_add16', 'rca16'], base: BUILD1.a_add16, par: { nand: 144, depth: 36 },
    chapters: [{ chapter: 'adders', step: 4, label: 'Watch the carry ripple' }, { chapter: 'fastadd', step: 0, label: 'The ripple problem' }] },
  {
    id: 'a_inc16', act: 2, title: '16-bit incrementer', kind: 'build', requires: ['a_ha'],
    why: 'The PC adds 1 every cycle (RV16 counts words: pc + 1, not pc + 4). With b = 0 and cin = 1, bit 0 is ¬a0 and every other bit a half adder: 76 NANDs against the adder\'s 144. Its carry still ripples inside the PC\'s loop, depth 31, and alone sets the PC\'s period, 41.',
    tips: ['a + 1: bit 0 is ¬a0, the carry into bit k is a0·…·a(k−1).', 'A half adder per bit from bit 1 on, each carry into the next.', 'Bit 0 needs no half adder (sixteen of them cost 4 NANDs over par), and cout is bit 15\'s carry: left open, the 0xFFFF row fails.'],
    codex: ['incrementer'], unlocks: ['rv16_inc16', 'inc4'], base: BUILD1.a_inc16, par: { nand: 76, depth: 31 } },
  {
    id: 'a_addsub16', act: 2, title: 'Adder / subtractor', kind: 'build', requires: ['a_add16', 'n_twos'],
    why: 'sub, slt and sltu need a − b; a second adder and a mux to choose would cost 368 NANDs. In two\'s complement a − b = a + ¬b + 1: an XOR per bit inverts b when sub = 1, and sub is the carry in, 212 NANDs. The ALU is built around it.',
    tips: ['An XOR is a controlled inverter.', 'Feed sub into cin.', 'v is the carry into bit 15 XOR the carry out, not the carry out (that is the unsigned flag).'],
    codex: ['subtract', 'twos'], unlocks: ['addsub16'], base: BUILD1.a_addsub16, par: { nand: 212, depth: 41 },
    chapters: [{ chapter: 'adders', step: 5, label: 'Subtraction for free' }] },
  {
    id: 'a_slt', act: 2, title: 'Set if less than', kind: 'build', requires: ['a_addsub16'],
    why: 'blt and bge branch on a < b as signed numbers: this block becomes 169 of the branch comparator\'s 287 NANDs and 39 of its 44 delays. One subtraction, a + ¬b + 1, answers it from its carry out and the signs; the ALU does not use it.',
    tips: ['Unsigned: a < b ⇔ no carry out of a + ¬b + 1. Only the carry is read, so ¬b needs 16 NOTs, not the subtractor\'s XORs.', 'Signed: if the signs differ, a < b ⇔ a is negative; if they agree the difference cannot overflow and the unsigned answer holds. (N ⊕ V also works, at the subtractor\'s price.)', 'ltu is ¬cout, not cout; and the difference\'s sign alone fails 0x7FFF against 0x8000, where it overflows.'],
    unlocks: ['rv16_cmp16'], codex: ['flags', 'overflow'], base: BUILD1.a_slt, par: { nand: 169, depth: 39 },
    chapters: [{ chapter: 'adders', step: 7, label: 'Signed comparison' }, { chapter: 'alu', step: 2, label: 'Comparison is subtraction' }] },
  {
    id: 'a_shift16', act: 2, title: 'Barrel shifter', kind: 'build', requires: ['g_mux8', 'g_and', 'n_twos'],
    why: 'sll, srl and sra shift by 0 to 15 places in one cycle; an adder only doubles. Four mux levels shift by 1, 2, 4 and 8, and one right shifter serves all three with a bit reversal each side: 299 NANDs, depth 14. sra keeps the sign: −8 >> 1 = −4.',
    tips: ['Level k shifts by 2^k when shamt bit k is 1.', 'Arithmetic right shift fills with the sign bit instead of 0.', 'A left shift reverses the word before the right shifter and again after it, and never takes the sign fill: it fills with 0 from the right.'],
    codex: ['shifter'], unlocks: ['rv16_shift16'], base: BUILD1.a_shift16, par: { nand: 299, depth: 14 },
    chapters: [{ chapter: 'alu', step: 1, label: 'The barrel shifter' }] },
  {
    id: 'a_alu16', act: 2, title: 'The ALU', kind: 'build', requires: ['a_addsub16', 'a_shift16', 'g_wide'],
    why: 'An instruction names one of ten operations, and every arithmetic instruction and lw / sw address needs the result within the cycle. All ten compute in parallel and a mux on f3 picks one: 1 055 NANDs, depth 64, the adder setting it. Core I puts it after the register file.',
    tips: ['Compute everything in parallel, select one result with a mux tree.', 'Share the one adder between add, sub and the comparisons: slt is N ⊕ V, sltu ¬cout.', 'Decode {OPX, f3}, not f3 alone: ctl 8 is sub, 13 is sra; and shift by b mod 16.'],
    codex: ['alu'], unlocks: ['rv16_alu16'], anatomy: ['alu'], chapters: [{ chapter: 'alu', label: 'The ALU' }], base: BUILD1.a_alu16, par: { nand: 1055, depth: 64 } },
  {
    id: 'o_fastadd', act: 2, title: 'Fast adders', kind: 'build', requires: ['a_add16'],
    why: 'The ripple carry crosses every bit and becomes the single-cycle core\'s critical path: the ALU is 50 of its 98 delays. A parallel-prefix tree computes every carry in 4 levels: 362 NANDs, depth 14, against the ripple adder\'s 144 and 36. Required: Core IV puts it in the ALU, period 76.',
    tips: ['Generate g = a·b, propagate p = a ⊕ b; (g, p) pairs combine associatively.', 'Kogge–Stone: log2(16) = 4 levels of combining.', 'The combine is not commutative (the higher group goes on the left), and cin enters as a generate below bit 0: drop it and only the cin = 0 cases pass.'],
    codex: ['cla', 'prefix', 'carryselect'], unlocks: ['ks16', 'cla4', 'rv16_alu16ks', 'rv16_nextpc_ks'], chapters: [{ chapter: 'fastadd', label: 'Faster adders' }], base: BUILD1.o_fastadd, par: { nand: 362, depth: 14 }, gives: ['gp', 'graycell', 'blackcell'] },

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
    codex: ['dlatch'], unlocks: ['rv16_dlatch'], par: { nand: 4 },
  },
  {
    id: 's_dff', act: 3, title: 'D flip-flop', kind: 'build', requires: ['s_dlatch'], base: sandbox('s_dff'),
    why: 'A latch is transparent for half a cycle: a value could race around a loop. Two latches on opposite clock phases capture d at the rising edge only. Every register of the CPU is flip-flops.',
    tips: ['Master enabled while clk = 0, slave while clk = 1.'],
    codex: ['dff', 'edge', 'setuphold', 'metastability'], unlocks: ['rv16_dff'], par: { nand: 9 },
  },
  {
    id: 's_reg4', act: 3, title: '4-bit register', kind: 'build', requires: ['s_dff', 'g_mux'], base: sandbox('s_reg4'),
    why: 'A register keeps its value unless told to load: a mux in front of each flip-flop feeds q back while en = 0. Never gate the clock with a signal that can change while it is high.',
    tips: ['Build a 1-bit DFF with enable first, then use it four times.'],
    codex: ['register', 'clockgating'], unlocks: ['rv16_dffe', 'rv16_reg4'], par: { nand: 52 },
  },
  {
    id: 's_reg16', act: 3, title: '16-bit register', kind: 'build', requires: ['s_reg4'],
    why: 'The PC, every register of the register file, every pipeline register: 16-bit registers everywhere.',
    tips: ['Four of your 4-bit registers sharing clk and en.'],
    codex: ['register'], unlocks: ['rv16_reg16', 'rv16_dreg16'], base: BUILD1.s_reg16, par: { nand: 208, period: 8 } },
  {
    id: 's_cnt4', act: 3, title: '4-bit counter', kind: 'build', optional: true, requires: ['s_reg4', 'a_inc16'], base: sandbox('s_cnt4'),
    why: 'A register plus an incrementer: the program counter in miniature, and every timer.',
    tips: ['q ← rst ? 0 : q + 1 when en.'], codex: ['counter'], unlocks: ['counter4'], par: { nand: 79, period: 17 },
    chapters: [{ chapter: 'registers', label: 'Registers & counters' }],
  },
  {
    id: 's_pc', act: 3, title: 'Program counter', kind: 'build', requires: ['s_reg16', 'a_inc16', 'g_mux8'],
    why: 'The PC holds the address of the instruction being executed. Each cycle it becomes pc + 1, or a jump target; on reset, 0.',
    tips: ['A 16-bit register without enable (the PC loads every cycle), an incrementer and a bus mux for the load.', 'Reset only ever selects 0: an AND per bit with ¬rst does it for less than a second bus mux.'],
    unlocks: ['rv16_pc'], codex: ['pc'], anatomy: ['pc', 'plus1'], base: BUILD1.s_pc, par: { nand: 302, period: 41 } },
  {
    id: 's_fsm', act: 3, title: 'A state machine', kind: 'build', optional: true, requires: ['s_dff', 'd_kmap'],
    why: 'Multi-cycle units (a divider, a cache miss, microcode) are run by finite-state machines: state register + next-state logic from a table.',
    tips: ['Encode the states, write the next-state table, minimise each bit.'],
    unlocks: ['rv16_det101'], codex: ['fsm'], base: BUILD1.s_fsm, par: { nand: 28, period: 8 } },
  {
    id: 'm_ram', act: 3, title: '4 × 4 RAM', kind: 'build', optional: true, requires: ['s_reg4', 'g_dec', 'g_mux8'], base: sandbox('m_ram'),
    why: 'Memory is registers plus addressing: a decoder picks the word to write, a mux picks the word to read.',
    tips: ['Each word: a register whose en = we AND decoder output.'],
    codex: ['ram', 'sram'], unlocks: ['ram4x4'], par: { nand: 274, period: 11 }, chapters: [{ chapter: 'memory', label: 'Memory arrays' }],
  },
  {
    id: 'm_rf', act: 3, title: 'Register file', kind: 'build', requires: ['s_reg16', 'g_dec', 'g_mux8'],
    why: 'Eight 16-bit registers, two read ports (rs1, rs2) and one write port (rd): an R-type instruction reads two and writes one in the same cycle. x0 always reads 0.',
    tips: ['Write: decoder on wa, ANDed with we, enables one register.', 'Read: two 8:1 bus muxes. x0 needs no register at all.'],
    codex: ['regfile'], unlocks: ['rv16_rf'], anatomy: ['rf'], chapters: [{ chapter: 'regfile', label: 'The register file' }], base: BUILD1.m_rf, par: { nand: 2172, period: 11 } },
  {
    id: 'm_mem', act: 3, title: 'ROM and RAM', kind: 'lesson', requires: ['m_rf'],
    why: 'Programs live in ROM, data in RAM. Building memory from flip-flops is what you just did; real memories are dense arrays (SRAM, DRAM). From here on, memories are given.',
    body: 'mem', tips: [], codex: ['rom', 'harvard'], anatomy: ['imem', 'dmem'], unlocks: ['sb_rom*', 'ram*'],
  },

  // ---- Act 4 --------------------------------------------------------------------------------
  {
    id: 'i_isa', act: 4, title: 'The RV16 instruction set', kind: 'lesson', requires: ['n_twos'],
    why: 'The instruction set is the specification the processor implements: formats, fields, opcodes. RV16 keeps RISC-V\'s ideas (load/store, fixed fields, x0 = 0) in 16 bits.',
    body: 'isa', tips: [], codex: ['isa', 'formats', 'rv16', 'mmio', 'rv32i'], chapters: [{ chapter: 'isa', label: 'Instructions & assembly' }],
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
    id: 'c_ctl', act: 5, title: 'Control unit', kind: 'build', requires: ['i_enc', 'g_dec', 'd_kmap', 'g_sop'], base: BUILD5.c_ctl, par: { nand: 200, depth: 13 },
    why: 'The datapath has muxes and enables; something must set them for each instruction. The control unit is a table (opcode → signals) turned into logic: decode the opcode, then each signal is an OR of the opcodes that need it.',
    tips: ['A 4→16 decoder on op gives one line per opcode.', 'rwe: OP, OPX, ADDI, SHI, LW, LUI (op 7 and 15), JAL, JALR.', 'Don\'t-cares (signals an instruction ignores) are free: choose whatever makes the logic smaller.'],
    codex: ['control', 'dontcare'], unlocks: ['rv16_ctl'], anatomy: ['ctl'],
  },
  {
    id: 'c_br', act: 5, title: 'Branch comparator', kind: 'build', requires: ['g_eq16', 'a_slt', 'g_mux'], base: BUILD5.c_br, par: { nand: 287, depth: 44 },
    why: 'beq, bne, blt and bge differ only in the comparison. One equality test and one signed less-than, a mux and an XOR cover all four.',
    tips: ['Bit 1 of cond picks between "equal" and "less than", bit 0 inverts.'],
    codex: ['branches', 'comparator'], unlocks: ['rv16_branch'], anatomy: ['br'],
  },
  {
    id: 'c_npc', act: 5, title: 'Next PC', kind: 'build', requires: ['a_add16', 'a_inc16', 'c_br', 'g_mux8'], base: BUILD5.c_npc, par: { nand: 421, depth: 38 },
    why: 'Where does the next instruction come from? Usually pc + 1; for a taken branch or jal, pc + imm; for jalr, rs1 + imm (returns, function pointers). jal and jalr also save pc + 1 as the return address.',
    tips: ['Two adders, an incrementer and a bus mux.', 'ld = jal | jalr | (br & take).'],
    codex: ['pc', 'branches'], unlocks: ['rv16_nextpc'], anatomy: ['npc'],
  },
  {
    id: 'c_core1', act: 5, title: 'Core I: arithmetic', kind: 'core', requires: ['c_lesson', 'c_imm', 'c_ctl', 's_pc', 'm_rf', 'a_alu16'], base: BUILD5.c_core1, par: { nand: 3892, period: 84, cycles: 701 },
    why: 'Your first processor: the PC addresses the program, the control unit decodes, the register file and ALU compute, the result goes back. Arithmetic only: the PC just counts.',
    tips: ['Wire the instruction\'s fields straight to the register file: rs1 = instr[9:7], rs2 = instr[12:10], rd = instr[6:4].', 'A mux picks the ALU\'s b (rs2 or the immediate); another picks what is written back (the ALU\'s result, or the immediate for lui).', 'Use pointers (net labels) for long wires: pc, imm, the result.'],
    codex: ['singlecycle', 'datapath'],
  },
  {
    id: 'c_core2', act: 5, title: 'Core II: memory', kind: 'core', requires: ['c_core1', 'm_mem'], base: BUILD5.c_core2, par: { nand: 3990, period: 98, cycles: 824 },
    why: 'Loads and stores: the ALU computes the address, the memory answers in the same cycle. Now programs can use more data than eight registers hold.',
    tips: ['daddr = the ALU result, dwdata = rs2, dwe = the control\'s mwe.', 'A load writes drdata back: the result mux\'s second input.'],
    codex: ['loadstore'], anatomy: ['wb'],
  },
  {
    id: 'c_core3', act: 5, title: 'Core III: control flow', kind: 'core', requires: ['c_core2', 'c_npc'], base: BUILD5.c_core3, par: { nand: 4720, period: 98, cycles: 1236 },
    why: 'Branches and jumps make loops and functions possible: the complete RV16I. Every program from Act 4 now runs on hardware you built.',
    tips: ['The branch comparator takes rs1, rs2 and op[1:0]; the next-PC logic loads the PC when it must jump.', 'jal and jalr write pc + 1: the result mux\'s third input.'],
    codex: ['cpi'], unlocks: ['rv16_cpu'],
  },
  {
    id: 'c_computer', act: 5, title: 'A computer', kind: 'build', requires: ['c_core3', 'p_loop'], base: BUILDH.c_computer, par: { nand: 27083, period: 110 },
    why: 'A processor alone computes nothing: it needs a program, memory and a way to show results. Wire your core to a ROM, a RAM and LEDs, decode the addresses, and you have a computer. Then write your own program for it.',
    tips: ['pc is 16 bits, the ROM has 32 words: a splitter gives pc[4:0].', 'Partial decoding: daddr[15] alone tells I/O from RAM (the program only uses the top of the address space for I/O).', 'The LEDs are a 16-bit register written when dwe and daddr[15].', 'Your own program: select the ROM, Edit program…, RV16 assembly.'],
    codex: ['mmio', 'harvard'], anatomy: ['mmio'],
  },
  {
    id: 'c_fast', act: 5, title: 'Core IV: the critical path', kind: 'core', requires: ['c_core3', 'o_fastadd'], base: BUILD5.c_fast, par: { period: 76, cycles: 1236 },
    why: 'Core III\'s clock period is 98 NAND delays, and 50 of them are the ripple ALU: every instruction waits for a carry to cross 16 bits, the ones that never add included. Static timing names that path; the fast adders you built shorten it. Swap only what lies on it: the same 1 236 cycles, a shorter cycle.',
    tips: ['The Timing panel shows the critical path through your core.', 'Swap the ripple adders on that path for the unlocked Kogge–Stone ALU and adders.', 'After the swap, look again: the path has moved. A fast adder that is now off it costs NANDs and buys no delay.'],
    codex: ['criticalpath', 'cla', 'skew'],
  },

  // ---- Act 6 --------------------------------------------------------------------------------
  {
    id: 'o_mc', act: 6, title: 'Multicycle CPU', kind: 'core', optional: true, requires: ['c_core3'], base: BUILD9.o_mc, par: { nand: 5203, period: 76, cycles: 3865 },
    why: 'A multicycle core runs each instruction as 3 or 4 short steps under a state machine. In the 1960s–80s that let one ALU and one memory serve every step, saving hardware a single-cycle core duplicates. Here the memories stay separate, so it saves nothing: two registers cut the long path (period 98 → 76), and each instruction takes 3 or 4 cycles. Measure period × cycles against Core III. It is why pipelines replaced this design: cut the path the same way, but keep every step busy.',
    tips: ['One-hot states (a flip-flop each): F → E → M → W → F, skipping M unless the instruction loads or stores; reset → F.', 'The instruction register loads in F; everything after decodes from it, not from instr.', 'Registers cut the long path: the ALU result is registered at the end of E, and memory reads it in M.', 'Write rd and load the PC only in W; stores only in M.'],
    codex: ['multicycle', 'fsm', 'microcode', 'cpi'], chapters: [{ chapter: 'multicycle', label: 'Multicycle & microcode' }],
  },
  {
    id: 'pi_lesson', act: 6, title: 'Pipelining', kind: 'lesson', requires: ['c_fast'], body: 'pipe',
    why: 'Core IV runs at 76 delays a cycle, and the adders are no longer the whole problem: the cycle must fit a whole load, instruction ROM → decode → ALU → data RAM → result mux → register file, one after the other. Put registers between those steps and each cycle only has to fit one of them, with five instructions in flight. The price is hazards: an instruction needs a value its predecessor has not written yet, and a branch is decided after two more instructions were fetched. This act builds the pipeline, then forwarding, the load-use stall and the flush. Expect it to lose at first: the 28 Core III programs take 1 495 cycles instead of 1 236, and with ripple adders E alone (forwarding, then the ALU) is 78 delays. Kogge–Stone adders in E win it back: period 56, 83 720 NAND delays against Core IV\'s 93 936.',
    tips: [], codex: ['pipeline', 'hazards'], chapters: [{ chapter: 'pipeline', label: 'Pipelining' }],
  },
  {
    id: 'pi_reg', act: 6, title: 'Pipeline register', kind: 'build', requires: ['s_reg16', 'g_mux8', 'g_or'], base: BUILD6.pi_reg, par: { nand: 260, period: 8 },
    why: 'Between two stages, a register that can hold its value (a stall: the stage waits) or clear itself (a flush: a bubble, all-zero control, does nothing).',
    tips: ['A mux in front picks 0 when clr; the register loads when en or clr.'], codex: ['stall', 'flush'], unlocks: ['rv16_preg'], anatomy: ['p1', 'p2', 'p3', 'p4'],
  },
  {
    id: 'pi_core0', act: 6, title: 'Pipeline I: five stages', kind: 'core', requires: ['pi_lesson', 'pi_reg'], base: BUILD6.pi_core0, par: { nand: 7062, period: 65, cycles: 2508 },
    why: 'The datapath cut into F, D, E, M, W. These programs keep dependent instructions apart and have no branches, so the stages can work without talking to each other.',
    tips: ['Write the register file at the falling edge (clock it with ¬clk): an instruction three behind its producer then reads the new value.', 'Carry everything a later stage needs in the pipeline registers: rd, control signals, the immediate. Without branches no stage after F needs the pc.', 'Report register writes from W and stores from M.'],
    codex: ['pipeline'],
  },
  {
    id: 'pi_fwd', act: 6, title: 'Forwarding unit', kind: 'build', requires: ['g_eq16', 'pi_lesson'], base: BUILD6.pi_fwd, par: { nand: 110, depth: 13 },
    why: 'A result exists at the end of E, but is written back two stages later. The forwarding unit spots when E needs a value that M or W is still carrying, and routes it there.',
    tips: ['Compare 3-bit register numbers: the library equality comparators are unlocked.', 'x0 is never forwarded; M has priority over W (it is newer).'],
    codex: ['forwarding', 'comparator'], unlocks: ['rv16_fwd'], anatomy: ['fwd'],
  },
  {
    id: 'pi_core1', act: 6, title: 'Pipeline II: forwarding', kind: 'core', requires: ['pi_core0', 'pi_fwd'], base: BUILD6.pi_core1, par: { nand: 7417, period: 78, cycles: 970 },
    why: 'Now an instruction uses the result of the one just before it. Two 3:1 muxes in front of the ALU, steered by the forwarding unit, keep the pipeline at one instruction per cycle.',
    tips: ['M\'s forwarded value is its result before memory: the ALU\'s, or the immediate for lui (this pipeline has no jumps, so no pc + 1 yet).', 'Forward rs2 too: stores use it (and from Pipeline IV on, branches).'],
    codex: ['forwarding'],
  },
  {
    id: 'pi_haz', act: 6, title: 'Hazard unit', kind: 'build', requires: ['g_eq16', 'pi_core1'], base: BUILD6.pi_haz, par: { nand: 53, depth: 12 },
    why: 'A load\'s value only exists after M. If the very next instruction needs it, no forwarding can help: hold it one cycle.',
    tips: ['A load in E: rwe and wb = memory.', 'Being conservative is allowed (a stall too many only costs a cycle).'],
    codex: ['loaduse', 'scoreboard'], unlocks: ['rv16_haz'], anatomy: ['haz'],
  },
  {
    id: 'pi_core2', act: 6, title: 'Pipeline III: load-use', kind: 'core', requires: ['pi_core1', 'pi_haz'], base: BUILD6.pi_core2, par: { nand: 7531, period: 78, cycles: 917 },
    why: 'Loads used at once: stall the front (PC and F/D hold), send a bubble into E, then forward from W the cycle after.',
    tips: ['stall: the PC reloads its own value (a 2:1 mux in front of it: the PC register has no enable), F/D en = 0, D/E clr = 1.'], codex: ['stall', 'loaduse'],
  },
  {
    id: 'pi_core3', act: 6, title: 'Pipeline IV: branches', kind: 'core', requires: ['pi_core2'], base: BUILD6.pi_core3, par: { nand: 9218, period: 78, cycles: 1495 },
    why: 'A branch is resolved in E; by then the next two instructions were fetched on the guess "not taken". When the guess is wrong, flush them and fetch from the target.',
    tips: ['redirect = the next-PC logic\'s ld in E; it loads the PC and clears F/D and D/E.', 'Every taken branch costs two cycles: the price predictors (and earlier resolution) try to lower.'],
    codex: ['flush', 'controlhazard'],
  },
  {
    id: 'o_bpred', act: 6, title: 'Branch prediction', kind: 'core', optional: true, requires: ['pi_core3'], base: BUILD9.o_bpred, par: { nand: 9789, period: 80, cycles: 2303 },
    why: 'Every taken branch costs Pipeline IV two flushed cycles, and loops take their branch almost every time. Guess at fetch instead: most guesses are right, and only a wrong one costs the flush.',
    tips: ['Static prediction is enough for ★★★: backward branches (offset sign bit, instr[15]) are loops, so predict them taken; jal is always taken.', 'The target in F is pc + imm: decode the fetched word there (the immediate generator is pure wiring) and add.', 'Carry the guess down the pipeline; in E, redirect when (taken ≠ predicted): to the target, or back to pc + 1 when a predicted branch falls through.', 'Mind the stall: holding the PC must win over the guess.'],
    codex: ['bpred', 'controlhazard'], chapters: [{ chapter: 'pipepay', label: 'Making the pipeline pay' }],
  },

  // ---- Act 7 --------------------------------------------------------------------------------
  {
    id: 'y_lesson', act: 7, title: 'Traps and interrupts', kind: 'lesson', requires: ['c_core3', 'c_computer'], body: 'traps',
    why: 'When the program errs or the world calls, the CPU must stop, save where it was, and jump to a handler.',
    tips: [], codex: ['traps', 'csr'], chapters: [{ chapter: 'traps', label: 'Traps and interrupts' }],
  },
  {
    id: 'y_csr', act: 7, title: 'CSR file', kind: 'build', requires: ['s_reg16', 'g_dec', 'g_mux8', 'y_lesson'], base: BUILD7.y_csr, par: { nand: 1765, period: 17 },
    why: 'mstatus, mtvec, mepc, mcause: the registers of the trap machinery. A trap updates three of them at once; mret undoes it.',
    tips: ['Six 16-bit registers and an 8:1 read mux. mstatus computes its next value every cycle, so it needs no enable.','mstatus: bits 3 (MIE) and 7 (MPIE) have their own next-value logic; the other bits only change on a write.'],
    codex: ['csr'], unlocks: ['rv16_csr'], anatomy: ['csr'],
  },
  {
    id: 'y_trap', act: 7, title: 'Exceptions', kind: 'core', requires: ['c_core3', 'y_csr'], base: BUILD7.y_trap, par: { nand: 7257, period: 100, cycles: 712 },
    why: 'ecall asks the system for help; ebreak stops for a debugger; an illegal word is a bug. All three replace the instruction by a jump to mtvec, remembering where and why.',
    tips: ['The illegal-instruction detector and the system decoder are given (open them: the detector is a function of the 16-bit word, the decoder computes the CSR write value).', 'On a trap: no register write, no store, pc ← mtvec, mepc ← pc.', 'csrr* write the old CSR value to rd.'],
    codex: ['traps', 'vm'], gives: ['rv16_ill', 'rv16_sysdec'], unlocks: ['rv16_ill', 'rv16_sysdec'],
  },
  {
    id: 'y_irq', act: 7, title: 'Interrupts', kind: 'core', requires: ['y_trap'], base: BUILD7.y_irq, par: { nand: 7257, period: 100, cycles: 740 },
    why: 'The outside world (a device raising the IRQ line) interrupts the program between two instructions. Taken like an exception, but with cause bit 15 set, and only when enabled.',
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
    id: 'y_ptrap', act: 7, title: 'Pipeline V: exceptions', kind: 'core', requires: ['pi_core3', 'y_trap'], base: BUILD7.y_ptrap, par: { nand: 12031, period: 81, cycles: 2361 },
    why: 'In the single-cycle core a trap was easy: one instruction at a time, so the trapping one was the only one. The pipeline has five in flight. A precise trap lets every older instruction finish, cancels every younger one, and leaves the culprit\'s address in mepc, so the handler can return to it. Take traps in E, where the instruction has changed nothing yet.',
    tips: ['Take traps in E: older instructions in M and W still complete, younger ones in F and D are flushed.', 'Carry a valid bit: a bubble\'s all-zero word would otherwise look like an illegal instruction.', 'A CSR instruction reads and writes in E; its old value travels down as the result.'],
    codex: ['precise', 'flush'],
  },
  {
    id: 'y_final', act: 7, title: 'Finale: interrupts', kind: 'core', requires: ['y_ptrap', 'y_irq', 'p_handler'], base: BUILD7.y_final, par: { nand: 12038, period: 81, cycles: 2399 },
    why: 'The last piece is the outside world. Pipeline V already takes exceptions precisely in E; an interrupt is one more reason to trap there, taken only when enabled. Then every block you built, from the NAND up, is one chip that runs real programs, handles its own errors and answers a device: the machine your interrupt handler was written for.',
    tips: ['intr = MIE · MEIE · irq comes from the CSR file: wire the pin in and OR the interrupt into the trap.', 'Gate the interrupt with the valid bit too: a bubble in E has no pc of its own (its D/E slot was cleared), so mepc would name an address the program never was at.', 'mcause for the interrupt is 0x800B (bit 15, external cause 11): it wins over every exception.'],
    codex: ['interrupts'],
  },

  // ---- Act 8 --------------------------------------------------------------------------------
  {
    id: 'o_lesson', act: 8, title: 'Area or time', kind: 'lesson', optional: true, requires: ['c_core3'], body: 'arith',
    why: 'Your core adds, shifts and compares in one cycle, and has no multiply, divide or floating point. Each of those can be built for area or for time, and each choice shows up in the numbers your core is graded on: NANDs, period and cycles.',
    tips: [], codex: ['mext', 'ieee754'], chapters: [{ chapter: 'muldiv', label: 'Multiply & divide' }, { chapter: 'float', label: 'Floating point' }],
  },
  {
    id: 'o_mulseq', act: 8, title: 'Shift-and-add multiplier', kind: 'build', optional: true, requires: ['a_add16', 's_reg16', 'p_mul'], base: BUILD8.o_mulseq, givesOf: partsOf(() => seqMul(16)), par: { nand: 1169, period: 48 },
    why: 'Software multiplication (Act 4) in hardware: one adder reused once per clock. 18 cycles of a 48-delay clock against one 150-deep pass: about 5.8 times the time, on less than half the NANDs (1 169 against 2 672).',
    tips: ['The product register starts as {0, b}; each step adds a to its upper half if its lowest bit is 1, then shifts everything right.'],
    codex: ['shiftadd'], chapters: [{ chapter: 'muldiv', label: 'Multiply & divide' }],
  },
  {
    id: 'o_mularr', act: 8, title: 'Array multiplier', kind: 'build', optional: true, requires: ['a_add16'], base: BUILD8.o_mularr, givesOf: partsOf(() => arrayMul(8)), par: { nand: 632, depth: 70 },
    why: 'All partial products at once, summed by rows of adders: one long combinational path, n² cells. The opposite trade to shift-and-add.',
    tips: ['Row k is a AND b[k], shifted left by k.', 'Add the rows one after the other: each adder\'s carry out becomes the next row\'s top bit.'],
    codex: ['arraymul', 'carrysave'],
  },
  {
    id: 'o_mcore', act: 8, title: 'Multiply in the core', kind: 'core', optional: true, requires: ['c_core3', 'o_mularr'], base: BUILD9.o_mcore, gives: ['amul16'], par: { nand: 8037, period: 191, cycles: 876 },
    why: 'Act 4 multiplied with a loop of adds: tens of cycles per product. The MD opcode does it in one instruction. The array is big and slow: watch what it does to the clock period of the whole core.',
    tips: ['The MD opcode is 0011: decode it next to the control unit, and OR its write into rwe.', 'Put the multiplier\'s result on the write-back path with one more mux.', 'Signed high halves: subtract b when a < 0 (mulh, mulhsu) and a when b < 0 (mulh) from the unsigned high half (codex).'],
    codex: ['mext', 'signedmul', 'arraymul', 'booth'], unlocks: ['rv16_mul'], chapters: [{ chapter: 'muldiv', label: 'Multiply & divide' }],
  },
  {
    id: 'o_div', act: 8, title: 'Divider', kind: 'build', optional: true, requires: ['a_addsub16', 's_fsm'], base: BUILD8.o_div, givesOf: partsOf(() => seqDivider(16, RV16_MUX2)), par: { nand: 1445, period: 31 }, unlocks: ['sdiv16_rv16'],
    why: 'Long division in binary: one subtract-and-compare per quotient bit, run by a small state machine. Division is slow everywhere: even fast CPUs take tens of cycles.',
    tips: ['Shift the remainder left, bring in the next dividend bit, subtract the divisor: if the result is not negative keep it and set the quotient bit.'],
    codex: ['division'],
  },
  {
    id: 'o_dcore', act: 8, title: 'Divide in the core', kind: 'core', optional: true, requires: ['o_mcore', 'o_div'], base: BUILD9.o_dcore, par: { nand: 10546, period: 193, cycles: 1859 },
    why: 'A divider takes many cycles, so the core must wait for it: the first instruction that does not finish in one cycle. Holding the PC is the single-cycle core\'s version of a stall.',
    tips: ['start = (a divide); hold = start and not done. Hold the PC by loading it with itself: ld = ld | hold, target = hold ? pc : target.', 'Write nothing while holding: rwe for MD = MD and not hold.', 'Signs: an adder / subtractor with a = 0 negates when sub = 1. Negate the quotient only when b ≠ 0.'],
    codex: ['mext', 'division', 'stall'], unlocks: ['rv16_div'],
  },
  {
    id: 'n_float', act: 8, title: 'Floating point', kind: 'drill', optional: true, requires: ['n_twos'], drill: 'float', par: { mistakes: 2 },
    why: 'Sign, exponent, fraction: a binary scientific notation that trades exactness for range. Encode and decode binary16 by hand before building its adder.',
    tips: ['Write the value as 1.f × 2^e; the exponent field is e + 15.'], codex: ['ieee754'], chapters: [{ chapter: 'float', label: 'Floating point' }],
  },
  {
    id: 'o_fpunpack', act: 8, title: 'Float unpack', kind: 'build', optional: true, requires: ['n_float'], base: BUILDFP.o_fpunpack, givesOf: fpGives(FP_REF.unpack), par: { nand: 63, depth: 14 }, unlocks: ['fpun5_10'],
    why: 'Every FP unit starts here: the hidden bit is not stored, subnormals and zero have none, and the all-ones exponent marks the values that are not numbers at all. Decode once, and the arithmetic only sees sign, exponent and significand.',
    tips: ['The hidden bit is NOT (exponent field = 0).', 'A subnormal\'s exponent is 1, not 0: OR the field\'s low bit with "field = 0".', 'inf and nan share "field all 1s"; the fraction tells them apart.'],
    codex: ['ieee754', 'subnormal'],
  },
  {
    id: 'o_fpround', act: 8, title: 'Rounding decision', kind: 'build', optional: true, requires: ['n_float'], base: BUILDFP.o_fpround, givesOf: fpGives(() => ROUND_DECIDE), par: { nand: 62, depth: 13 }, unlocks: ['fpround'],
    why: 'An exact result has more bits than the format keeps. Three bits are enough to round it correctly in every mode: the last kept bit, the first dropped one (guard) and whether anything below that was 1 (sticky).',
    tips: ['Decode rm into one wire per mode first; each mode is then a small AND.', 'Ties to even: a tie is g = 1 and s = 0; then round up only if lsb = 1.'],
    codex: ['rounding'],
  },
  {
    id: 'o_fpsticky', act: 8, title: 'Sticky shifter', kind: 'build', optional: true, requires: ['n_float', 'a_shift16'], base: BUILDFP.o_fpsticky, givesOf: fpGives(FP_REF.sticky), par: { nand: 264, depth: 21 }, unlocks: ['shrs13_4', 'shrs15_4'],
    why: 'Before adding, the smaller operand is shifted right until the binary points line up. The bits that fall off still matter to rounding, but only as one bit: were they all zero?',
    tips: ['The barrel shifter again, right only: level k shifts by 2^k.', 'Each level also ORs the bits it drops; sticky is the OR of the levels that shifted.'],
    codex: ['sticky', 'shifter'],
  },
  {
    id: 'o_fplzc', act: 8, title: 'Leading-zero counter', kind: 'build', optional: true, requires: ['n_float'], base: BUILDFP.o_fplzc, givesOf: fpGives(FP_REF.lzc, () => [lzc(8), lzc(4), lzc(2)]), par: { nand: 104, depth: 9 }, unlocks: ['lzc*'],
    why: 'Subtracting close numbers cancels the top bits: 1.0001 − 1.0000 leaves 0.0001. Normalizing shifts the first 1 back to the top, and the shift amount is the number of leading zeros.',
    tips: ['A 2-bit counter: c = NOT a1, v = a1 OR a0.', 'Two n/2-bit counters make an n-bit one: if the upper half has a 1, take its count; else n/2 + the lower count. The top bit of c is just NOT v_upper.', 'Build the 8-bit one as a chip from two 4-bit ones, and so on: the recursion is the design.'],
    codex: ['lzc'],
  },
  {
    id: 'o_fpnorm', act: 8, title: 'Normalize & round', kind: 'build', optional: true, requires: ['o_fpround', 'o_fpsticky', 'o_fplzc'], base: BUILDFP.o_fpnorm, givesOf: fpGives(FP_REF.norm), par: { nand: 2058, depth: 86 }, unlocks: ['fpnr5_10_15', 'fpnr5_10_16_rv16', 'fpnr5_10_22'],
    why: 'Add, multiply and convert all end the same way: a raw significand and exponent become a correctly rounded encoding. Build it once, carefully, and every unit after it is mostly wiring.',
    tips: ['Left shift by min(leading zeros, exp − 1): never below exponent 1. If exp < 1, shift right by 1 − exp instead (sticky shifter).', 'After the shift the kept bits are the top 11; then the guard bit; everything below it, and stin, is the sticky bit.', 'Rounding up 1.111…1 carries into a new top bit: the exponent goes up by one and the fraction is 0.', 'Overflow: a final field of 31 or more. Then toInf picks ∞ or 0x7BFF.'],
    codex: ['normalize', 'rounding', 'subnormal'],
  },
  {
    id: 'o_fpadd', act: 8, title: 'FP adder', kind: 'build', optional: true, requires: ['o_fpunpack', 'o_fpnorm'], base: BUILD8.o_fpadd, givesOf: fpGives(() => fpAdd(F16, RV16_MUX2)), par: { nand: 3732, depth: 163 },
    why: 'Adding floats means aligning their binary points first, then adding, normalising and rounding: the hardest of the four operations to get exactly right. Every block it needs is one you have built.',
    tips: ['Swap so that |a| ≥ |b|, shift b right by the exponent difference (keep a sticky bit), add or subtract the significands.', 'Leave room: put the significands at bits 13..3 of a 15-bit word (a carry above, guard and sticky below), and hand normalize & round exponent + 1.', 'x − x is +0 (−0 in RDN). NaN in, or ∞ − ∞, gives the canonical NaN 0x7E00.'],
    codex: ['ieee754', 'rounding'],
  },
  {
    id: 'o_fpmul', act: 8, title: 'FP multiplier', kind: 'build', optional: true, requires: ['o_fpadd', 'o_mularr'], base: BUILD8.o_fpmul, givesOf: fpGives(() => fpMul(F16, RV16_MUX2)), par: { nand: 4912, depth: 150 },
    why: 'Multiplying floats is simpler than adding them: multiply the significands, add the exponents, XOR the signs, then normalise and round.',
    tips: ['11 × 11 bits gives a 22-bit product; its top bit decides whether to shift by one.'], codex: ['ieee754', 'fma'],
  },
  {
    id: 'o_fpcmp', act: 8, title: 'FP comparator', kind: 'build', optional: true, requires: ['o_fpunpack'], base: BUILDFP.o_fpcmp, givesOf: fpGives(FP_REF.cmp), par: { nand: 682, depth: 25 },
    why: 'The format was designed so that comparing floats is almost comparing integers: the exponent sits above the fraction, so for positive numbers the bit patterns are in order. Only the signs, the two zeros and NaN need care.',
    tips: ['|a| < |b| is a 15-bit unsigned compare of the patterns without their sign bits.', 'Two negatives: the order flips. Different signs: the negative one is smaller, unless both are zeros.', 'Any NaN: eq, lt and le are all 0.'],
    codex: ['fpcompare'],
  },
  {
    id: 'o_fpcvt', act: 8, title: 'Integer to float', kind: 'build', optional: true, requires: ['o_fpnorm'], base: BUILDFP.o_fpcvt, givesOf: fpGives(FP_REF.cvt), par: { nand: 2690, depth: 109 },
    why: 'fcvt.h.w: an integer is already a significand, with its binary point at the right. Take the magnitude, and normalize & round finds the leading 1 and rounds what does not fit in 11 bits.',
    tips: ['|x| = signed and x < 0 ? −x : x (a conditional negate).', 'The integer\'s top bit weighs 2^15: the exponent you hand normalize & round is 15 + bias.'],
    codex: ['normalize'],
  },
  // ---- Act 9 --------------------------------------------------------------------------------
  {
    id: 'k_lesson', act: 9, title: 'Latency or throughput', kind: 'lesson', optional: true, requires: ['c_core3'], body: 'gpu',
    why: 'Your core runs one program as fast as its clock allows. Many workloads are the same small program over thousands of data: pixels, vertices, array elements. For them the useful number is results per second, and one control unit can feed several datapaths.',
    tips: [], codex: ['throughput', 'simd', 'amdahl'], chapters: [{ chapter: 'lanes', label: 'Lanes' }],
  },
  {
    id: 'k_lanes', act: 9, title: 'Four lanes', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_lanes, par: { nand: 4596, depth: 55 },
    why: 'The datapath, four times: four ALUs fed by one set of control signals and one immediate. Every lane computes the same operation on its own operands.',
    tips: ['Your ALU and the 49-NAND bus mux are unlocked: one mux and one ALU per lane.', 'nz: OR the 16 bits of each a<sub>i</sub>, then merge the four bits.'],
    codex: ['lane'], unlocks: ['rv16_lanes4'], chapters: [{ chapter: 'lanes', label: 'Lanes' }],
  },
  {
    id: 'k_vrf', act: 9, title: 'Lane register file', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_vrf, par: { nand: 8688, period: 11 },
    why: 'Every lane needs registers of its own: the same register numbers, different values. Four register files, written lane by lane: storage is what a lane costs.',
    tips: ['Your register file is unlocked: one per lane, sharing wa, ra1 and ra2.', 'Split we into four bits: one write enable per lane.'],
    codex: ['vrf'], unlocks: ['rv16_vrf4'], chapters: [{ chapter: 'lanes', label: 'Lanes' }],
  },
  {
    id: 'k_mask', act: 9, title: 'Active mask', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_mask, par: { nand: 102, period: 8 },
    why: 'Not every lane always has work: an array whose length is not a multiple of four, or one side of an if. The mask switches lanes off: they still compute, but write nothing. The lowest active lane, the leader, speaks for the warp.',
    tips: ['A 4-bit register; at reset its input is forced to 1111 (OR each bit with rst) and it loads.', 'lead: lane 0 if m0; else 1 if m1; else 2 if m2; else 3. Bit 1 = ¬m0·¬m1, bit 0 = ¬m0·(m1 + ¬m2).', 'we and dwe: AND the mask with rwe and mwe, copied to four bits.'],
    codex: ['activemask', 'leader'], unlocks: ['rv16_mask4'], chapters: [{ chapter: 'simt', label: 'Threads in lock-step' }],
  },
  {
    id: 'k_simd', act: 9, title: 'SIMD core', kind: 'core', optional: true, requires: ['k_lanes', 'k_vrf', 'k_mask'], base: BUILDK.k_simd, par: { nand: 15669, period: 100, cycles: 810 },
    why: 'One fetch, one decode, one control unit; four lanes. Every lane runs every instruction on its own registers and memory port; tid tells them apart and the mask turns them off. A branch has one PC to steer: the leader decides it.',
    tips: ['Start from your single-cycle core: the control unit, immediates, branch and next-PC logic stay as they are.', 'The lane decoder is given: tmc, tid, split and join (the last two can wait for the SIMT core).', 'Leader operands: two 4:1 bus muxes on the lanes’ rs1 and rs2, selected by lead. They feed the branch unit, jalr and tmc.', 'Results: per lane, ALU or memory; pc + 1 and the immediate are the same for every lane; tid replaces them all when the decoder says so.'],
    codex: ['warp'], gives: ['rv16_lanedec'], unlocks: ['rv16_lanedec'], chapters: [{ chapter: 'lanes', label: 'Lanes' }],
  },
  {
    id: 'k_stack', act: 9, title: 'Reconvergence stack', kind: 'build', optional: true, requires: ['k_simd'], base: BUILDK.k_stack, par: { nand: 1995, period: 19 },
    why: 'When the lanes disagree on an if, the SIMD core follows the leader and the others compute the wrong side. Instead: run the lanes that take one side, park the others with the address to resume, run them next, then reconverge. A stack, because ifs nest.',
    tips: ['An entry is 26 bits: mask, else lanes, pc, pending, valid. Registers with enable, a 2:1 mux in front of each: a push shifts down, a pop shifts up.', 'The top entry decides join: pending → run the else lanes (jump); not pending → restore and pop.', 'Reset clears only the valid bits; the rest may hold anything.'],
    codex: ['reconvergence', 'divergence'], unlocks: ['rv16_stack4'], chapters: [{ chapter: 'simt', label: 'Threads in lock-step' }],
  },
  {
    id: 'k_simt', act: 9, title: 'SIMT core', kind: 'core', optional: true, requires: ['k_simd', 'k_stack'], base: BUILDK.k_simt, par: { nand: 17732, period: 100, cycles: 919 },
    why: 'The SIMD core with the stack: split and join make each lane behave like a thread of its own, a scalar program per lane, while one control unit still drives all four.',
    tips: ['The stack’s p is the lanes’ nz (rs1 ≠ 0); its pc1 is the next-PC logic’s pc + 1.', 'Mask: load when tmc runs or the stack says so; tmc’s value wins.', 'The PC: a 2:1 mux after the next-PC choice, to jpc when the stack jumps.'],
    codex: ['simt'], chapters: [{ chapter: 'simt', label: 'Threads in lock-step' }],
  },
  {
    id: 'p_saxpy', act: 9, title: 'saxpy', kind: 'program', optional: true, requires: ['k_simd'], par: { cycles: 90, laneops: 360 },
    why: 'The classic kernel: y ← a·x + y over an array. Each lane takes every fourth element; nobody waits for anybody.',
    tips: ['Thread i handles elements i, i + 4, i + 8, …: start at tid, step by 4.', 'n is a multiple of 4, so every lane runs the loop the same number of times: no lane idles.'],
    codex: ['utilization'], chapters: [{ chapter: 'lanes', label: 'Lanes' }],
  },
  {
    id: 'p_reduce', act: 9, title: 'Reduction', kind: 'program', optional: true, requires: ['k_simt'], par: { cycles: 35, laneops: 114 },
    why: 'Summing an array is the opposite of saxpy: four partial sums must become one. Every step of the final combine has fewer useful lanes: the cost of a reduction is the lanes left with nothing to do at its end.',
    tips: ['First each lane sums its strided share, all lanes busy.', 'Then combine through memory: lanes store their partial sums, fewer lanes add pairs.', 'Lane-ops count the work: every lane repeating the whole combine saves the tmc (a cycle) and masks no lane, but three of the four compute a sum nobody needs, 20 lane-ops a test. Mask them off.'],
    codex: ['reduction'], chapters: [{ chapter: 'simt', label: 'Threads in lock-step' }],
  },
  // Phases 3 and 4 of the GPU track: warps and memory, then graphics.
  {
    id: 'k_coal', act: 9, title: 'Coalescer', kind: 'build', optional: true, requires: ['k_simd'], base: BUILDK.k_coal, par: { nand: 467, depth: 27 },
    why: 'Four memory ports cost four memories. One port as wide as a line costs one: when neighbouring threads touch neighbouring words, one access serves them all. The coalescer finds which lanes the next access serves.',
    tips: ['Drop each address’s two low bits: what is left (14 bits) names its line.', 'The leader is the lowest active lane, exactly as in your mask; a 4:1 bus mux picks its line.', 'Lane 0, when active, is the leader: it needs no comparator. Lanes 1–3: an equality comparator each, ANDed with their mask bit.', 'left = mask XOR served: served never contains an inactive lane.'],
    codex: ['coalescing'], unlocks: ['rv16_coal4'], chapters: [{ chapter: 'feed', label: 'Feeding the lanes' }],
  },
  {
    id: 'k_warps', act: 9, title: 'Two warps', kind: 'core', optional: true, requires: ['k_simt', 'k_coal'], base: BUILDK.k_warps, par: { nand: 29974, period: 95, cycles: 2093 },
    why: 'Real memory answers late. While one warp waits for its word, let the other issue: latency hidden by switching threads instead of by forwarding or stalling. With a memory one cycle late and two warps taking turns, every load is back before its warp issues again.',
    tips: ['Start from your SIMT core: fetch, decode, control and the lanes stay shared. Duplicate what is state: PC, mask, stack, lane registers.', 'The warp bit is a flip-flop that toggles every cycle (0 after reset); 2:1 muxes pick the issuing warp’s PC, register reads and mask.', 'A load: hold its lanes (mask · rwe) and rd for one cycle, then write drdata into the other warp’s registers. In any cycle each register file has one writer: its warp’s results, or the returning load.', 'bar: a waiting bit per warp. Arriving first sets yours, arriving second clears the other’s. A warp goes only if it is not held at bar (or the other has no lanes) and has lanes of its own; a PC moves only when its warp goes.'],
    codex: ['barrel', 'barrier', 'occupancy'], chapters: [{ chapter: 'warps', label: 'Hiding latency' }],
  },
  {
    id: 'p_hist', act: 9, title: 'Histogram', kind: 'program', optional: true, requires: ['k_warps'], par: { cycles: 176, laneops: 702 },
    why: 'Eight threads count values into sixteen bins. Two threads that meet the same value would update one counter at once, and RV16 has no atomic add: one of the two counts would be lost. Count into private counters, wait at a barrier until both warps have counted, then add the counters up with every thread.',
    tips: ['Thread t counts value v in the word 8·v + t: then bin b’s eight counters sit in a row, at 8·b.', 'Thread t takes elements t, t + 8, …: n is a multiple of 8, so every lane has the same number.', 'After bar, every thread adds up two bins: their sixteen counters are the words 16·tid … 16·tid + 15.', 'The warps take turns, so a kernel without bar can look right. The grader also lets warp 1 run ahead of warp 0.'],
    codex: ['privatization', 'barrier'], chapters: [{ chapter: 'feed', label: 'Feeding the lanes' }],
  },
  {
    id: 'k_edge', act: 9, title: 'Edge stepper', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_edge, par: { nand: 963, period: 58 },
    why: 'Is a pixel inside a triangle? Each edge splits the plane: E = A·(x − x\u1d62) + B·(y − y\u1d62) is positive on one side, negative on the other, and inside means all three are ≥ 0. E is linear, so the pixel to the right has E + 4A and the one below E + 4B: one adder per edge replaces every multiplication of the walk.',
    tips: ['Two 16-bit registers: E, and R, where the current band started (a band is four rows of pixels).', 'One adder / subtractor: its first operand is E, R (band) or 2E (double, a wired shift); its second a, 4a, b or 4b (wired shifts too); subtract only for up.', 'Load and band write R as well as E; hold writes neither.', 'inside: NOT of E\'s bit 15.'],
    codex: ['edgefn'], unlocks: ['rv16_edge'], chapters: [{ chapter: 'pixels', label: 'Pixels and triangles' }],
  },
  {
    id: 'k_tile', act: 9, title: 'Tile walk', kind: 'build', optional: true, requires: ['k_edge'], base: BUILDK.k_tile, par: { nand: 479, period: 26 },
    why: 'Visiting the whole bounding box wastes cycles on pixels no edge can reach. In 4 × 4 tiles, one test at a tile\'s best corner rules the whole tile in or out; inside an accepted tile a serpentine path makes every step one pixel, so the edge steppers never need a multiplier and the tile ends one step from the next.',
    tips: ['State: busy, a TEST flag, the pixel counter k (0 … 15) and the tile (tx, ty).', 'Column = k ÷ 4, row = k mod 4, reversed in odd columns: an XOR of k\'s low bits with bit 2.', 'A tile is done when its TEST fails or its last pixel (k = 15) is out; then: the next tile if tx ≠ tx1, the next band if ty ≠ ty1, else idle.', 'Every command is 0 while idle: gate them with busy.'],
    codex: ['tilewalk'], unlocks: ['rv16_tile'], chapters: [{ chapter: 'pixels', step: 2, label: 'Walking tiles' }],
  },
  {
    id: 'k_raster', act: 9, title: 'Rasterizer', kind: 'build', optional: true, requires: ['k_tile'], base: BUILDK.k_raster, par: { nand: 9188, period: 145, cycles: 7439 },
    why: 'The edge steppers and the tile walk, plus the set-up that starts them: each edge\'s A and B, the top-left bias, the box in tiles, and E at the first tile. That last one is a product, and there is no multiplier here: each stepper computes its own by shift-and-add, a doubling per bit, on the adder it already has.',
    tips: ['A, B, Δx = ox − xᵢ, Δy = oy − yᵢ: 8-bit subtractions (two 4-bit adders, the subtrahend inverted, carry in 1). ox = 16·tx0 + 2.', 'The first tile is the smallest (v + 1) >> 4 of the three vertices; the last the largest (v − 2) >> 4, 0 if negative. A comparison is an adder\'s carry.', 'E = A·Δx + B·Δy − bias, MSB first: E ← 0; E ← E − A·Δx₇ (the sign bit weighs −128); E ← E − B·Δy₇; then for bits 6 … 0: E ← 2E + (Δxₖ ? A : 0), E ← E + (Δyₖ ? B : 0); last E ← E − bias. Then load E into itself, so R starts there too.', 'The sum of the three E plus the three biases is twice the area: ≤ 0 is a back face, done.', 'The tile test: a second adder per edge, E + 12·(A⁺ + B⁺), its sign.'],
    codex: ['horner', 'shiftadd'], unlocks: ['rv16_raster'], chapters: [{ chapter: 'pixels', step: 1, label: 'Inside a triangle' }],
  },
  {
    id: 'k_frame', act: 9, title: 'A frame', kind: 'core', optional: true, requires: ['k_raster', 'k_warps'], base: BUILDK.k_frame, par: { nand: 40275, period: 147, cycles: 7635 },
    why: 'A GPU in miniature: programmable lanes compute where the vertices go, a fixed-function rasterizer turns triangles into pixels, the screen is memory both write. The core talks to the rasterizer through addresses, as to any device, and must not touch the screen or the device while it draws.',
    tips: ['Start from your two-warp core; add the rasterizer, six 7-bit vertex registers and a 16-bit colour register, written from lane 0\'s port when its address is 0xFFF0 … 0xFFF6.', 'A store to 0xFFF6 sets a flip-flop that is the rasterizer\'s go in the next cycle; busy for the core is that flip-flop OR the rasterizer\'s busy.', 'Hold: busy AND (lane 0 is active, the instruction stores, address in 0xFFF0 … 0xFFF6, OR it loads and an active lane\'s address is in 0xF000 … 0xF3FF). AND its inverse into the warp\'s go: nothing of that instruction happens, and its next turn tries again.', 'Use the instruction\'s own signals for the hold, not the write enables it gates: those depend on go.'],
    codex: ['device', 'mmio'], chapters: [{ chapter: 'pixels', label: 'Pixels and triangles' }, { chapter: 'graphics', step: 1, label: 'The pipeline' }],
  },
  {
    id: 'p_spin', act: 9, title: 'Spin', kind: 'program', optional: true, requires: ['k_frame'], par: { cycles: 1432, laneops: 5282 },
    why: 'A spinning square, a few frames of it, on the device you built: warp 0 turns the corners, both warps clear the screen, lane 0 hands two triangles to the rasterizer. No multiplier and no sine table: Minsky\'s rule turns a point with two shifts and two adds. One screen and no depth buffer: the clear must wait for the draw (the second bar), and nothing sorts what overlaps; the GPU chapters add a back frame to draw into and a depth per pixel.',
    tips: ['Clearing is most of the work: give all eight threads a share, several stores per pass.', 'Lane i of warp 0 turns corner i; store each corner\'s screen position (64 + (x >> 8)) where lane 0 can load it.', 'Two bars per frame: after clearing and turning (lane 0 needs the corners and a clean screen), and after drawing (nobody clears a frame still being drawn).', 'On the hardware a load from the screen waits for the rasterizer: one before the clear makes the program right there too.'],
    codex: ['minsky', 'doublebuffer', 'zbuffer'], chapters: [{ chapter: 'pixels', label: 'Pixels and triangles' }, { chapter: 'graphics', step: 2, label: 'A spinning triangle' }],
  },
  // ---- Act 10 -------------------------------------------------------------------------------
  {
    id: 'm_lesson', act: 10, title: 'Where the cycles go', kind: 'lesson', optional: true, requires: ['c_computer'], body: 'memwall',
    why: 'Every core so far read its memory in the same cycle. Real memory is a capacitor per bit, read by a sense amplifier, a row at a time, behind a controller that keeps a chip\'s timing rules and refreshes it before it forgets. This act builds that path, from the bit line up.',
    tips: [], codex: ['memwall', 'rowbuffer', 'amat'], chapters: [{ chapter: 'dram', label: 'Inside a DRAM' }, { chapter: 'memctrl', label: 'A memory controller' }],
  },
  {
    id: 'm_sense', act: 10, title: 'A DRAM column', kind: 'build', optional: true, requires: ['m_lesson'], base: BUILDM.m_sense, par: { transistors: 34 },
    gives: ['drambit', 'blcap', 'dramsa', 'vhalf', 'wdrv'],
    why: 'A DRAM bit is 25 fF on a line of 100 fF: reading it moves the line by a tenth of the supply, and the cell is left holding the same small level. The column turns that into a bit and puts the charge back. Build it from the parts, at switch level.',
    tips: ['Precharge: one NMOS from VDD/2 to the bit line, gate pre. A second NMOS between the two lines (the equalizer) gives the reference line VDD/2 too.', 'Both lines need the bit line capacitance: the amplifier compares their levels, and a line with no capacitance has no level to keep once pre falls.', 'Cells and the write driver hang on the bit line; the amplifier and the driver span both lines. Nothing else touches the reference line.', 'q can be the bit line itself: once the amplifier has fired it sits at a rail.'],
    codex: ['senseamp'], unlocks: ['rv16_dramcol'], chapters: [{ chapter: 'dram', step: 2, label: 'The sense amplifier' }],
  },
  {
    id: 'm_bank', act: 10, title: 'A bank with refresh', kind: 'build', optional: true, requires: ['m_sense'], base: BUILDM.m_bank, par: { nand: 319, period: 30, cycles: 5917 },
    why: 'The amplifiers of a whole row are the row buffer: once a row is open, every word of it is one cycle away, and a word of another row costs a close and an open. Meanwhile every row is leaking, and nobody but the controller will notice before it is too late.',
    tips: ['State: is a row open, which one, the next row to refresh, and a counter of the cycles since the last refresh.', 'A request hits when a row is open and it is the request\'s row: RW, busy = 0. Otherwise PRE if a row is open, else ACT the request\'s row; busy = 1.', 'A refresh is just ACT of the refresh row (after a PRE if needed): leave that row open, the next request may want it. 16 rows in 288 cycles: one refresh every 18 cycles is enough.', 'Refresh early when nobody is asking (the timer past 8), and force it when it is due (15), ahead of any request.'],
    codex: ['refresh', 'rowhammer', 'ecc'], unlocks: ['rv16_bank'], chapters: [{ chapter: 'dram', step: 3, label: 'Leaks and refresh' }, { chapter: 'dram', step: 4, label: 'Rows, columns, banks' }],
  },
  {
    id: 'm_ctrl', act: 10, title: 'Row-buffer controller', kind: 'build', optional: true, requires: ['m_bank'], base: BUILDM.m_ctrl, par: { nand: 779, period: 36, cycles: 10690 },
    why: 'A real DRAM chip refreshes its own rows when told to (REF), keeps a row buffer per bank and sets every interval in nanoseconds: tRCD from ACT to a read, tCAS from the read to the data, tRAS before the row may close, tRP before the next opens. The controller turns requests into commands at the earliest legal cycle.',
    tips: ['Per bank: an open flag and the open row. Counters of the cycles since the last ACT and since the last PRE, saturating at 15, cover tRCD, tRAS and tRP when one request is in flight at a time.', 'A read\'s data comes tCAS = 4 cycles after its RD: a 4-stage shift register of "RD issued" says when to raise ready, and that no command is needed meanwhile.', 'Refresh: count cycles since the last REF and make it pending well before 256 (128 is a bit test). Pending goes first: PREA once tRAS allows, then REF once tRP allows.', 'After REF nothing may happen for tRFC = 12 cycles: remember that the last close was a REF, and wait 12 instead of 4.'],
    codex: ['dramtiming', 'pagepolicy'], unlocks: ['rv16_dramctrl'], chapters: [{ chapter: 'memctrl', step: 0, label: 'Commands' }, { chapter: 'memctrl', step: 1, label: 'Open page or closed page' }],
  },
  {
    id: 'o_cache', act: 10, title: 'A cache', kind: 'build', optional: true, requires: ['m_ctrl'], base: BUILD9.o_cache, par: { nand: 3497, period: 36 },
    why: 'Your controller hands over a word of the open row tCAS = 4 cycles after its read command, and a word of another row only after tRP + tRCD + tCAS = 12, where every core assumed one. Programs use the same words again and again (locality): a small memory that keeps the recent ones answers most accesses at once. It must know which word each line holds: a tag, and a valid bit. Its bench still answers a miss in the same cycle, so the level proves the cache right and grades its own NANDs and period, not the cycles it would save.',
    tips: ['Two small RAMs indexed by addr[2:0]: one for the data, one for {valid, tag}.', 'hit = valid AND (stored tag = addr[7:3]): a 5-bit equality comparator.', 'Write the line when wr, or when rd and not hit; its data is wdata on a write, mdata on a fill.', 'At power-on every valid bit is 0: nothing hits until it is filled.'],
    codex: ['cache', 'threecs', 'assoc', 'writepolicy'], chapters: [{ chapter: 'cache', label: 'Caches' }],
  },
  {
    id: 'm_bus', act: 10, title: 'Two masters, one bus', kind: 'build', optional: true, requires: ['m_lesson'], base: BUILDM.m_bus, par: { nand: 282, period: 26 },
    why: 'A processor is not the only thing that wants memory: a DMA engine, a display, a second core do too. A bus lets several masters reach several slaves over one set of wires, one transfer at a time, with a handshake each side can stretch and an arbiter that keeps either master from starving.',
    tips: ['Three flip-flops of state: who was served last, whether a transfer is in progress, and whose it is.', 'The grant: while a transfer is in progress, its owner; else if both ask, the one not served last; else whoever asks.', 'Two 16-bit muxes take the granted master\'s address and data to every slave; the top two address bits pick whose valid rises, and the same bits pick whose ready and data come back.', 'A transfer is done when the granted master\'s valid and the chosen slave\'s ready are both 1: only that master sees ready.'],
    codex: ['handshake', 'arbitration', 'atomics', 'ordering'], unlocks: ['rv16_bus'], chapters: [{ chapter: 'bus', step: 0, label: 'A handshake' }, { chapter: 'bus', step: 2, label: 'Two masters' }],
  },
  {
    id: 'm_dma', act: 10, title: 'DMA engine', kind: 'build', optional: true, requires: ['m_bus'], base: BUILDM.m_dma, par: { nand: 1366, period: 48, cycles: 2079 },
    why: 'Copying memory word by word keeps the processor busy for two bus transfers per word. A DMA engine does the copy itself, as a second master on the bus, while the processor runs on; it raises an interrupt when it is done.',
    tips: ['Registers: src, dst, a count, and the word in flight; flip-flops for running, read or write, and irq.', 'Count with an incrementer: load NOT len and add 1 per word; the incrementer\'s carry (all ones) means nothing is left, len = 0 included.', 'One request at a time: valid while running and not done, the address src in the read phase and dst in the write phase. When ready: a read latches mq and turns to writing; a write steps src, dst and the count and turns to reading.', 'Hold everything while ready is 0: the address and data come straight from registers that change only when ready.'],
    codex: ['dma', 'coherence'], unlocks: ['rv16_dma'], chapters: [{ chapter: 'bus', step: 3, label: 'DMA' }],
  },
  {
    id: 'm_flash', act: 10, title: 'Flash page store', kind: 'build', optional: true, requires: ['m_lesson'], base: BUILDM.m_flash, par: { nand: 1049, period: 38, cycles: 7844 },
    why: 'Flash keeps its data without power, but it cannot overwrite: a page is programmed once, and only a whole block can be erased, thousands of times at most. Every SSD and SD card hides that behind a controller that writes somewhere new each time and keeps a map: the flash translation layer.',
    tips: ['Write as a log: a head pointer to the next erased page, a table of 8 entries saying where each logical page lives. A write programs the head (with the logical page number as its tag), points the entry there, and moves the head.', 'Keep one block erased ahead of the head. When the head enters a new block, collect the block after it: read each page; if the table still points at it (its tag says whose it was), program it at the head and repoint the entry; then erase the block.', 'Update the table and the head when you issue the program, not when it finishes: fq shows the read page only until the next command.', 'A small state machine: idle, waiting on a read or a program, and the collector\'s read, copy and erase. While fbusy is 1 issue nothing.'],
    codex: ['ftl', 'wearlevel'], unlocks: ['rv16_flashstore'], chapters: [{ chapter: 'flash', step: 3, label: 'Never overwrite' }, { chapter: 'flash', step: 4, label: 'Garbage, wear and bad blocks' }],
  },
  {
    id: 'p_boot', act: 10, title: 'Boot from flash', kind: 'program', optional: true, requires: ['m_dma', 'm_flash'], par: { size: 18, cycles: 253 },
    why: 'At power-on everything a program needs is in flash, which keeps it without power but is slow to read. A boot loader brings it into RAM first. Let the DMA engine do the copying, and the processor can work while it runs.',
    tips: ['Loading the table straight from flash works: 8 stall cycles a word. The DMA copies a word every 4.', 'Simplest: start the copy, wait until 0xFFF9 reads 1, clear it, then sum the copy in RAM.', 'Faster: don\'t wait for the whole copy. The bench\'s engine, unlike your m_dma, lets you read its count: a load from 0xFFF2 gives the words left, so you know how many have landed. Sum each one as soon as it is there.', 'RV16 is word addressed and its offsets reach −32 … 31: the device registers are -16(x0) … -13(x0), irq is -7(x0), OUT is -3(x0).'],
    codex: ['boot'], chapters: [{ chapter: 'bus', step: 4, label: 'A computer on one bus' }],
  },
];

export const nodeById = (id: string): CampaignNode | undefined => NODES.find((n) => n.id === id);
