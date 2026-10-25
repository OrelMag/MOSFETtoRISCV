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
  { num: 8, title: 'Arithmetic units', blurb: 'Optional: multiply and divide, and floating point. Each trades area or cycles against your core\'s NANDs, period and cycles, and each level measures which way the trade went.' },
  { num: 9, title: 'Throughput: a GPU', blurb: 'Optional, from Core III on: throughput. Lanes: one instruction stream, four datapaths, a mask and a stack. Warps: hide memory latency. Pixels: a rasterizer beside the lanes.' },
  { num: 10, title: 'Memory', blurb: 'Optional, from A computer on: what sits behind the data port. DRAM, its controller and a cache; a bus other masters share, a DMA engine, and flash to boot from.' },
];

/** An act's name as the map and the crumbs show it: "Act 3", or its own label ("Act P"). */
export const actName = (num: number): string => ACTS.find((a) => a.num === num)?.label ?? `Act ${num}`;

/** An act's title by its number (acts are listed in map order, not by number). */
export const actTitle = (num: number): string => ACTS.find((a) => a.num === num)?.title ?? '';

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
    codex: ['mosfet', 'cmos', 'inverter', 'power'], unlocks: ['inv_cmos'], par: { transistors: 2 },
    chapters: [{ chapter: 'mosfet', label: 'The MOSFET' }, { chapter: 'inverter', label: 'The CMOS inverter' }],
  },
  {
    id: 't_nand', act: 0, title: 'CMOS NAND', kind: 'build', requires: ['t_inv'], base: sandbox('t_nand'),
    why: 'NAND is functionally complete: every circuit of this campaign, the whole CPU included, is NANDs. Four transistors; from the next level on, the NAND is your brick.',
    tips: ['The pull-down network must conduct only when a = b = 1: put the NMOS in series.', 'The pull-up must conduct when either input is 0: PMOS in parallel.'],
    codex: ['nand', 'universality', 'duality', 'stdcell'], unlocks: ['nand'], par: { transistors: 4 },
    chapters: [{ chapter: 'nand', label: 'The NAND gate' }],
  },
  {
    id: 't_nor', act: 0, title: 'CMOS NOR', kind: 'build', optional: true, requires: ['t_inv'], base: sandbox('t_nor'),
    why: 'The dual of NAND, also complete. Why do cell libraries and this campaign prefer NAND? Series PMOS are slow (holes are about 2–3× less mobile than electrons), and NOR puts them in series.',
    tips: ['Swap series and parallel relative to the NAND.'],
    codex: ['nor', 'duality'], unlocks: ['nor_cmos'], par: { transistors: 4 },
    chapters: [{ chapter: 'nand', step: 1, label: 'NOR, for comparison' }],
  },

  // ---- Act P: before the transistor ----------------------------------------------------------
  {
    id: 'r_pull', act: 11, title: 'Pull-in and drop-out', kind: 'drill', optional: true, requires: ['intro'], drill: 'relay', par: { mistakes: 2 },
    why: 'A relay is a magnet against a spring, so it is not a clean switch: it closes at one voltage, opens at a much lower one, takes milliseconds and bounces. Read those numbers off the physical model before building with its logic, where all of it becomes one relay step.',
    tips: [], codex: ['relay', 'relaystep'],
    chapters: [{ chapter: 'relays', label: 'Relays' }],
  },
  {
    id: 'r_nand', act: 11, title: 'A relay NAND', kind: 'build', optional: true, requires: ['r_pull'], base: BUILDR.r_nand, par: { relays: 2, steps: 1 },
    why: 'The brick again, in relays. A NAND is 1 unless both coils pull: two break contacts in parallel from the supply. Nothing ever drives the output to 0; an open line feeds the next coil, which pulls it down.',
    tips: ['a and b each operate a relay: the pin on the coil\'s a end, GND on its b end.', 'From VDD through each relay\'s break contact (c to nc) to y: either released relay connects y to the supply.', 'An output nobody drives reads Z here: end y on a pull-down, the next relay\'s coil drawn as its resistance.'],
    codex: ['openzero'], chapters: [{ chapter: 'relays', step: 2, label: 'Contacts conduct both ways' }],
  },
  {
    id: 'r_xor', act: 11, title: 'Changeover XOR', kind: 'build', optional: true, requires: ['r_nand'], base: BUILDR.r_xor, par: { relays: 2, steps: 1 },
    why: 'XOR costs 4 NANDs and 3 delays in CMOS. A changeover contact is a 2:1 multiplexer that passes either way, so XOR is two relays and one step: the first puts the supply on one of two lines, the second picks the other one.',
    tips: ['Relay a: VDD on its common, so exactly one of its no / nc lines carries the supply.', 'Relay b: its common is y; its no and nc go to a\'s lines crossed over (b\'s nc to a\'s no, b\'s no to a\'s nc).', 'End y on a load.'],
    codex: ['relay'], chapters: [{ chapter: 'relays', step: 3, label: 'What contacts are good at' }],
  },
  {
    id: 'r_adder', act: 11, title: 'Carry through contacts', kind: 'build', optional: true, requires: ['r_xor'], base: BUILDR.r_adder, par: { relays: 8, steps: 1 },
    why: 'A 4-bit adder whose carry never waits for a coil. The operands operate the relays; the carry runs through their contacts on two lines, c and not c, and arrives at once. The sum is ready one relay step after the operands, for 4 bits or 32.',
    tips: ['Carry in is 0: the c line open, the ¬c line on VDD.', 'co = b ? (a ? 1 : c) : (a ? c : open); ¬co is its mirror. s = a ? (b ? c : ¬c) : (b ? ¬c : c): two lines chosen by b, then one of them by a.', 'Per bit, relay a needs five poles (four for the carry pair, one for the sum), relay b four. Build one bit as a chip, then chain four.', 'End each sum line and the carry out on a load.'],
    codex: ['contactcarry'], chapters: [{ chapter: 'relays', step: 4, label: 'A carry that needs no time' }],
  },
  {
    id: 'r_latch', act: 11, title: 'A relay that holds', kind: 'build', optional: true, requires: ['r_nand'], base: BUILDR.r_latch, par: { relays: 3 },
    why: 'Memory in relays: a relay that feeds its own coil through its own contact stays in after the pulse that pulled it in is gone, until a break contact in that path opens. The Z3 stored every bit of its memory this way.',
    tips: ['q is the coil line of the holding relay k. Set operates a relay whose make contact puts VDD on q.', 'k feeds itself: its make contact connects q to a holding line.', 'The holding line comes from VDD through the break contact of a reset relay: reset opens it, and k drops out.'],
    codex: ['selfhold'], chapters: [{ chapter: 'relays', step: 5, label: 'Memory that holds itself' }],
  },
  {
    id: 'r_clock', act: 11, title: 'The buzzer clock', kind: 'build', optional: true, requires: ['r_latch'], base: BUILDR.r_clock, par: { relays: 2 },
    why: 'A relay fed through its own break contact cannot rest: the doorbell\'s buzzer, and a clock of two relay steps. Then halve it with a second relay that toggles only while the first is pulled in: a counter bit, the start of every sequencer.',
    tips: ['Buzzer: en on the common of k\'s break contact, the break contact on k\'s own coil line, which is y.', 'The divider relay t toggles whenever k is operated: its coil then reads a line that carries VDD only while t is released; while k is released it reads one that carries VDD only while t is operated.', 'Both lines come from t\'s own changeover contact with VDD on its common; one more pole of k chooses between them. q: a make contact of t to a load.'],
    codex: ['buzzer'], chapters: [{ chapter: 'relays', step: 6, label: 'A relay that cannot stop' }],
  },
  {
    id: 'v_inv', act: 11, title: 'Two tubes in a row', kind: 'build', optional: true, requires: ['intro'], base: BUILDR.v_inv, par: { tubes: 2 },
    why: 'A triode inverts: grid 1, the plate falls; grid 0, the plate resistor pulls it up. But a plate swings between 81 and 250 V, and a grid needs 0 V to conduct and −12.5 V to stop. Two inverters in a row only work with a level shift between them.',
    tips: ['Each inverter: a plate resistor from B+ (+250 V) to the plate, the triode from the plate to GND (its cathode), the plate is the output.', 'Every grid reads its input through a divider: a divider resistor from the plate (or the input, also a plate level) to the grid, a bias resistor from the grid to −150 V.', 'na is the first plate, y the second.'],
    codex: ['triode', 'griddivider'], chapters: [{ chapter: 'tubes', step: 2, label: 'Levels that do not line up' }],
  },
  {
    id: 'v_ff', act: 11, title: 'Eccles–Jordan', kind: 'build', optional: true, requires: ['v_inv'], base: BUILDR.v_ff, par: { tubes: 4 },
    why: 'One bit in one bulb (1918): two triodes, each holding the other off. Every flip-flop of the tube machines, ENIAC\'s counters included, was this pair.',
    tips: ['Two inverters, each grid reading the other\'s plate through a divider: q is one plate, nq the other.', 'set must turn on the tube whose plate is nq, reset the other one. A wire from the pin to the grid would also hold the grid at 0 while the pin is 0.', 'Steering diodes, anode on the pin and cathode on the grid: a 1 pulls the grid up, a 0 lets go.'],
    codex: ['ecclesjordan'], chapters: [{ chapter: 'tubes', step: 5, label: 'One bit in one bulb' }],
  },
  {
    id: 'h_card', act: 11, title: 'Read a card', kind: 'drill', optional: true, requires: ['intro'], drill: 'hollerith', par: { mistakes: 2 },
    why: 'For seventy years programs and data arrived on cards. Read the Hollerith code both ways: what a column says, and which holes a character needs. Then the binary kind, a word punched one bit a column.',
    tips: [], codex: ['hollerith'],
    chapters: [{ chapter: 'cards', step: 2, label: 'Eighty columns' }],
  },
  {
    id: 'h_loader', act: 11, title: 'Program on cards', kind: 'build', optional: true, requires: ['h_card', 'r_clock', 's_dff'], base: BUILDCARD.h_loader,
    par: { relays: 233, cycles: 182 }, gives: ['not', 'and', 'or', 'dff', 'counter8', 'mux2x8', 'cpu4_proc', 'ram256x16'],
    why: 'A computer with an empty memory and a deck in the reader. Build the loader: a counter that addresses the memory, a write for each card, and the switch that hands memory to the 4-bit CPU once the hopper is empty. The Z3 never did this: it ran its film as it read it. A stored-program machine copies the deck into memory first: that copy is a loader. It is priced as the Z3 was built: in relays.',
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
    why: 'Circuits are equations. Algebra lets you transform one circuit into a cheaper equivalent before you build it: fewer gates, shorter paths. This is how every par in the campaign is reached.',
    body: 'bool', tips: [], codex: ['identities', 'demorgan', 'bubble', 'sop', 'truthtable'],
    chapters: [{ chapter: 'gates', label: 'Gates from NAND' }], drill: 'boolean', par: { mistakes: 2 } },
  {
    id: 'n_bin', act: 1, title: 'Binary and hex', kind: 'drill', requires: ['intro'], drill: 'binary', par: { mistakes: 2 },
    why: 'Every value inside the machine is a pattern of bits; the meaning is a convention. Read and write unsigned binary and hexadecimal fluently: the rest of the campaign speaks them.',
    tips: ['Each hex digit is exactly four bits.', 'Bit k weighs 2^k.'],
    codex: ['positional', 'hex'], chapters: [{ chapter: 'binary', label: 'Binary numbers' }],
  },
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
    id: 'g_or', act: 1, title: 'OR from NAND', kind: 'build', requires: ['g_not', 'l_bool'], base: sandbox('g_or'),
    why: 'OR merges conditions: "take the branch if beq-and-equal OR bne-and-unequal", "the result is zero unless any bit is 1". De Morgan turns it into NANDs.',
    tips: ['a + b = ¬(¬a · ¬b).', 'Invert both inputs (two NANDs as NOTs), then one NAND.'],
    codex: ['or', 'demorgan'], unlocks: ['or'], par: { nand: 3, depth: 2 },
  },
  {
    id: 'g_xor', act: 1, title: 'XOR from NAND', kind: 'build', requires: ['g_and', 'g_or'], base: sandbox('g_xor'),
    why: 'XOR is addition without carry, a controlled inverter (the subtractor\'s ¬b), and the difference detector behind the equality test (a ⊕ b = 0).',
    tips: ['Start from n = ¬(a·b).', 'a ⊕ b = ¬(¬(a·n) · ¬(b·n)): four NANDs in total.'],
    codex: ['xor'], unlocks: ['xor', 'xnor'], par: { nand: 4, depth: 3 },
  },
  {
    id: 'g_mux', act: 1, title: '2:1 multiplexer', kind: 'build', requires: ['g_not', 'l_bool'], base: sandbox('g_mux'),
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
    id: 'g_sop', act: 1, title: 'Prime detector', kind: 'build', requires: ['d_kmap', 'g_and', 'g_or', 'n_bin'],
    why: 'The control unit is specified as a table (opcode → signals) and built as logic. Practise the method on one function: K-map, sum of products, NAND–NAND.',
    tips: ['Minimise first: every literal saved is a gate input saved.', 'An SoP maps one-to-one onto NAND–NAND: 20 NANDs here, depth 7 (the 3-literal products and the 4-input OR are built from 2-input gates). Par is less than half that.', 'Compare the map\'s two halves (a3 = 0, a3 = 1): one is a function you have built, the other almost the same.'],
    unlocks: ['rv16_prime4'], codex: ['sop', 'nandnand'], base: BUILD1.g_sop, par: { nand: 8, depth: 5 } },
  {
    id: 'g_wide', act: 1, title: 'Zero detect', kind: 'build', requires: ['g_and', 'g_or'],
    why: 'The equality test behind beq and bne asks "is a ⊕ b zero?": a 16-input NOR. A chain of 2-input ORs is 15 gates deep, 31 NAND delays with the NOT; a balanced tree is 4 gates, 9 delays. Depth, not gate count, sets the clock.',
    tips: ['Balance the tree: pairs, then pairs of pairs.', 'The chain and the tree cost the same NANDs: only the depth differs.'],
    codex: ['fanin', 'depth', 'bubble'], unlocks: ['rv16_wide16', 'and3', 'and4', 'and8', 'or3', 'or4', 'or8', 'or16', 'zero*', 'andx*', 'orx*', 'xorx*'], base: BUILD1.g_wide, par: { nand: 46, depth: 9 } },
  {
    id: 'g_dec', act: 1, title: '3→8 decoder', kind: 'build', requires: ['g_wide', 'n_bin'],
    why: 'Eight registers, one write port: a decoder turns the 3-bit register number into eight enable lines, only one of them 1. Decoders also select memory words and MMIO devices.',
    tips: ['Output k is the AND of the address bits or their complements matching k, and of the enable.', 'Eight 4-input ANDs cost 51. Decode two inputs at a time first: each partial line then serves several outputs.'],
    codex: ['decoder'], unlocks: ['rv16_dec3', 'dec*'], base: BUILD1.g_dec, par: { nand: 30, depth: 5 } },
  {
    id: 'g_mux8', act: 1, title: 'Bus multiplexer', kind: 'build', requires: ['g_mux'],
    why: 'Data moves 16 bits at a time: a 2:1 mux per bit makes a bus mux. Reading a register is an 8:1 mux of 16-bit words.',
    tips: ['A wide mux is a row of 1-bit muxes sharing the select (and its inverter).', 'An 8:1 mux is a tree of 2:1 muxes, one select bit per level.'],
    codex: ['mux', 'bus'], unlocks: ['rv16_mux*', 'mux*'], base: BUILD1.g_mux8, par: { nand: 49, depth: 3 } },
  {
    id: 'g_eq16', act: 1, title: 'Equality', kind: 'build', requires: ['g_xor', 'g_wide'],
    why: 'beq and bne compare two registers; the pipeline\'s forwarding unit compares register numbers. Equality is XNOR per bit and a wide AND.',
    tips: ['a = b ⇔ every bit of a ⊕ b is 0: XOR then zero-detect.'],
    codex: ['comparator'], unlocks: ['rv16_eq16', 'eq*'], base: BUILD1.g_eq16, par: { nand: 110, depth: 12 } },

  // ---- Act 2 --------------------------------------------------------------------------------
  {
    id: 'n_twos', act: 2, title: "Two's complement", kind: 'drill', requires: ['n_bin'], drill: 'twos', par: { mistakes: 2 },
    why: 'Negative numbers without a sign bit circuit: in two\'s complement the top bit weighs −2^(n−1), so the same adder adds signed and unsigned numbers. Only comparison and overflow differ.',
    tips: ['−x = ¬x + 1.', 'Overflow: both operands have the same sign and the result has the other.'],
    codex: ['twos', 'overflow', 'signext'], chapters: [{ chapter: 'binary', step: 1, label: "Negative numbers: two's complement" }],
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
    codex: ['incrementer'], unlocks: ['rv16_inc16', 'inc4'], base: BUILD1.a_inc16, par: { nand: 76, depth: 31 } },
  {
    id: 'a_addsub16', act: 2, title: 'Adder / subtractor', kind: 'build', requires: ['a_add16', 'n_twos'],
    why: 'sub and slt subtract (branches compare in their own unit). a − b = a + ¬b + 1: XOR gates invert b when sub = 1, and sub is also the carry in.',
    tips: ['An XOR is a controlled inverter.', 'Feed sub into cin.'],
    codex: ['subtract', 'twos'], unlocks: ['addsub16'], base: BUILD1.a_addsub16, par: { nand: 212, depth: 41 } },
  {
    id: 'a_slt', act: 2, title: 'Set if less than', kind: 'build', requires: ['a_addsub16'],
    why: 'slt / sltu and blt / bge need a < b, signed and unsigned. Both come from one subtraction, a + ¬b + 1: its carry out answers unsigned, and signed differs only when the signs do.',
    tips: ['Unsigned: a < b ⇔ no carry out of a + ¬b + 1. Only the carry is read, so ¬b needs 16 NOTs, not the subtractor\'s XORs.', 'Signed: if the signs differ, a < b ⇔ a is negative; if they agree the difference cannot overflow and the unsigned answer holds. (N ⊕ V also works, at the subtractor\'s price.)'],
    unlocks: ['rv16_cmp16'], codex: ['flags', 'overflow'], base: BUILD1.a_slt, par: { nand: 169, depth: 39 } },
  {
    id: 'a_shift16', act: 2, title: 'Barrel shifter', kind: 'build', requires: ['g_mux8', 'g_and', 'n_twos'],
    why: 'sll / srl / sra by any amount in one cycle: four levels of muxes, shifting by 1, 2, 4 and 8.',
    tips: ['Level k shifts by 2^k when shamt bit k is 1.', 'Arithmetic right shift fills with the sign bit instead of 0.'],
    codex: ['shifter'], unlocks: ['rv16_shift16'], base: BUILD1.a_shift16, par: { nand: 299, depth: 14 } },
  {
    id: 'a_alu16', act: 2, title: 'The ALU', kind: 'build', requires: ['a_addsub16', 'a_shift16', 'g_wide'],
    why: 'The execute stage: ten operations selected by a 4-bit control word from the instruction\'s op and f3 fields. Every arithmetic and logic instruction and every load / store address goes through it; branches compare in their own unit.',
    tips: ['Compute everything in parallel, select one result with a mux tree.', 'Share the one adder between add, sub and the comparisons.'],
    codex: ['alu'], unlocks: ['rv16_alu16'], anatomy: ['alu'], chapters: [{ chapter: 'alu', label: 'The ALU' }], base: BUILD1.a_alu16, par: { nand: 1055, depth: 64 } },
  {
    id: 'o_fastadd', act: 2, title: 'Fast adders', kind: 'build', requires: ['a_add16'],
    why: 'The ripple adder\'s carry chain will be the CPU\'s critical path (Core IV, at the end of Act 5, comes back for it). Computing carries with a prefix tree takes log2(n) levels: more gates, a faster clock.',
    tips: ['Generate g = a·b, propagate p = a ⊕ b; (g, p) pairs combine associatively.', 'Kogge–Stone: log2(16) = 4 levels of combining.'],
    codex: ['cla', 'prefix', 'carryselect'], unlocks: ['ks16', 'cla4', 'rv16_alu16ks', 'rv16_nextpc_ks'], chapters: [{ chapter: 'fastadd', label: 'Faster adders' }], base: BUILD1.o_fastadd, par: { nand: 362, depth: 14 }, gives: ['gp', 'graycell', 'blackcell'] },

  // ---- Act 3 --------------------------------------------------------------------------------
  {
    id: 's_sr', act: 3, title: 'SR latch', kind: 'build', requires: ['g_not'], base: sandbox('s_sr'),
    why: 'Everything built so far is combinational: its outputs follow its inputs and forget them. A CPU must hold its PC and registers from one cycle to the next. Feed two NANDs into each other and they hold one bit: 2 NANDs, the storage loop inside every latch and flip-flop to come.',
    tips: ['Cross-couple two NANDs: each one\'s output is the other\'s second input. With s_n = r_n = 1 each inverts the other: two stable states.', 's_n = 0 forces q = 1; then q_n = ¬(q · r_n) = 0, which holds q at 1 after s_n returns to 1.', 'Both inputs at 0 drive q and q_n to 1 together, and releasing them together is a race: the D latch next makes that input impossible.'],
    codex: ['feedback', 'latch'], unlocks: ['sr_latch'], par: { nand: 2 },
    chapters: [{ chapter: 'latches', step: 0, label: 'Two NANDs holding hands' }],
  },
  {
    id: 's_dlatch', act: 3, title: 'D latch', kind: 'build', requires: ['s_sr'], base: sandbox('s_dlatch'),
    why: 'An SR latch has two inputs that must never fall together. A D latch derives both from one data input and an enable: transparent while e = 1, holding while e = 0, the bad combination impossible, for 4 NANDs at par. The flip-flop next is two of them on opposite clock phases.',
    tips: ['s_n = ¬(d·e), r_n = ¬(¬d·e).', 'r_n can use s_n instead of ¬d: ¬(s_n·e). That saves the NOT.', 's_n must come from d and r_n from ¬d: the other way round the latch stores ¬d.'],
    chapters: [{ chapter: 'latches', step: 2, label: 'The D latch: store what you are told' }], codex: ['dlatch'], unlocks: ['rv16_dlatch'], par: { nand: 4 },
  },
  {
    id: 's_dff', act: 3, title: 'D flip-flop', kind: 'build', requires: ['s_dlatch'], base: sandbox('s_dff'),
    why: 'A latch passes d as long as its enable is high, so in a loop (PC → incrementer → PC) a value can run round twice in one cycle. Two latches on opposite clock phases change q once, at the rising edge: 9 NANDs a bit, with setup and clk-to-q of 3 delays each. Every register from here on is built from them.',
    tips: ['Use your D latch twice: d into the master, the master\'s q into the slave.', 'The master is enabled by ¬clk, the slave by clk: 4 + 4 + 1 = 9 NANDs.', 'Both latches on clk make one transparent latch: the test changes d while clk is high, and q follows.'],
    chapters: [{ chapter: 'latches', step: 3, label: 'The flip-flop: act only on the edge' }], codex: ['dff', 'edge', 'setuphold', 'metastability'], unlocks: ['rv16_dff'], par: { nand: 9 },
  },
  {
    id: 's_reg4', act: 3, title: '4-bit register', kind: 'build', requires: ['s_dff', 'g_mux'], base: sandbox('s_reg4'),
    why: 'A flip-flop takes d at every edge, but most state must hold until written: x[rd] only when an instruction names it. A mux in front of each flip-flop feeds q back while en = 0: 13 NANDs a bit, 52 for four at par. Never gate the clock instead; the 16-bit register next is four of these.',
    tips: ['Build a 1-bit flip-flop with enable first, then use it four times.', 'The mux: en = 1 selects d, en = 0 selects the flip-flop\'s own q: 9 + 4 = 13 NANDs a bit.', 'Do not AND en into clk: a change of en while clk is high makes an edge of its own, and the AND delays this clock against every other.'],
    chapters: [{ chapter: 'latches', step: 4, label: 'Load enable' }], codex: ['register', 'clockgating'], unlocks: ['rv16_dffe', 'rv16_reg4'], par: { nand: 52 },
  },
  {
    id: 's_reg16', act: 3, title: '16-bit register', kind: 'build', requires: ['s_reg4'],
    why: 'Everything RV16 remembers is a 16-bit word: the PC, x1–x7, the CSRs, and in Act 6 every value passed between stages. Four 4-bit registers sharing clk and en: 208 NANDs at par, period 8 (clk-to-q 3, the enable mux 2, setup 3). Its first two jobs come next: the program counter, then seven of them in the register file.',
    tips: ['Four of your 4-bit registers sharing clk and en.', 'Split d into four nibbles and merge the four q back in the same order: the low nibble holds bits 3:0.', 'A nibble crossed at a splitter passes the values whose nibbles happen to match and fails the rest.'],
    chapters: [{ chapter: 'registers', step: 1, label: 'Wider words' }], codex: ['register'], unlocks: ['rv16_reg16', 'rv16_dreg16'], base: BUILD1.s_reg16, par: { nand: 208, period: 8 } },
  {
    id: 's_cnt4', act: 3, title: '4-bit counter', kind: 'build', optional: true, requires: ['s_reg4', 'a_inc16'], base: sandbox('s_cnt4'),
    why: 'A register whose input is its own value plus one counts clock edges: the PC without jumps, a divider\'s step counter, every timer. Par is 79 NANDs at period 17: the incrementer\'s carry is inside the loop, so it sets the clock. The program counter is the same loop, 16 bits wide, with a load.',
    tips: ['q ← rst ? 0 : q + 1 when en.', 'rst wins over en: clear the next value after the enable mux, not only on the incremented path.', 'Feed the incrementer from q, the register\'s output: from d it is a combinational loop.'], codex: ['counter'], unlocks: ['counter4'], par: { nand: 79, period: 17 },
    chapters: [{ chapter: 'registers', step: 2, label: 'A counter' }],
  },
  {
    id: 's_pc', act: 3, title: 'Program counter', kind: 'build', requires: ['s_reg16', 'a_inc16', 'g_mux8'],
    why: 'Nothing yet says which instruction runs. The PC holds its address: each cycle it becomes pc + 1, or a jump target, or 0 on reset, a 16-bit register in a loop with Act 2\'s incrementer. Par 302 NANDs at period 41, the incrementer inside the loop. Core I fetches from it; Core III loads it from next PC.',
    tips: ['A 16-bit register without enable (the PC loads every cycle), an incrementer and a bus mux for the load.', 'Reset only ever selects 0: an AND per bit with ¬rst does it for less than a second bus mux.', 'Reset must win over load: the AND goes after the load mux, so a jump during reset still gives 0.'],
    unlocks: ['rv16_pc'], chapters: [{ chapter: 'registers', step: 2, label: 'A counter' }], codex: ['pc'], anatomy: ['pc', 'plus1'], base: BUILD1.s_pc, par: { nand: 302, period: 41 } },
  {
    id: 's_fsm', act: 3, title: 'A state machine', kind: 'build', optional: true, requires: ['s_dff', 'd_kmap'],
    why: 'Some units take several cycles and must remember which one they are in: a divider counts its steps, a multicycle core walks fetch → execute → memory → write back. A state register plus next-state logic read off a table does it: this one spots 1, 0, 1 in a bit stream, 28 NANDs at par. Act 8\'s divider runs on one.',
    tips: ['Three states: S0 nothing useful seen, S1 the last bit was 1, S2 a 1 then a 0.', 'Encode S0 = 00, S1 = 01, S2 = 10, write the next-state table and minimise each bit; the unused code 11 is a don\'t-care, and rst clears it.', 'From S2, x = 1 gives y = 1 and goes to S1, not S0: patterns overlap (10101 gives two).'],
    unlocks: ['rv16_det101'], chapters: [{ chapter: 'registers', step: 10, label: 'State machines' }], codex: ['fsm'], base: BUILD1.s_fsm, par: { nand: 28, period: 8 } },
  {
    id: 'm_ram', act: 3, title: '4 × 4 RAM', kind: 'build', optional: true, requires: ['s_reg4', 'g_dec', 'g_mux8'], base: sandbox('m_ram'),
    why: 'Memory is registers plus addressing: a decoder on the address picks the one word to write, a mux picks the one word to read. Par is 274 NANDs for 16 bits, about 17 NANDs a bit; an SRAM cell is 6 transistors. The register file is the same circuit with a second read port.',
    tips: ['Each word: a register whose en = we AND its decoder output.', 'Reading needs no clock: a 4:1 bus mux on addr picks the word.', 'Use we as the decoder\'s enable: without it every edge writes the addressed word.'],
    codex: ['ram', 'sram'], unlocks: ['ram4x4'], par: { nand: 274, period: 11 }, chapters: [{ chapter: 'memory', step: 0, label: 'Four words, one address' }],
  },
  {
    id: 'm_rf', act: 3, title: 'Register file', kind: 'build', requires: ['s_reg16', 'g_dec', 'g_mux8'],
    why: 'An R-type instruction reads two registers and writes a third in one cycle, so the register file needs two read ports and a write port, and x0 must read 0 whatever is written to it. 2 172 NANDs at par: nearly half of Core III. Core I wires rs1, rs2 and rd straight from the instruction word to it.',
    tips: ['Write: the decoder on wa, enabled by we, picks the one register that loads.', 'Read: two 8:1 bus muxes. x0 needs no register at all.', 'x0 is input 0 of each read mux tied to the constant 0: a real register there costs 208 NANDs and is written unless its enable is cut.'],
    codex: ['regfile'], unlocks: ['rv16_rf'], anatomy: ['rf'], chapters: [{ chapter: 'regfile', step: 0, label: 'A memory with two read ports' }], base: BUILD1.m_rf, par: { nand: 2172, period: 11 } },
  {
    id: 'm_mem', act: 3, title: 'ROM and RAM', kind: 'lesson', requires: ['m_rf'],
    why: 'Built like the register file, memory costs about 20 NANDs a bit: the 64-word RAM a small program needs would be 20 166 NANDs, over four times Core III. Real memories are arrays of 6-transistor or 1-transistor cells, so from here on ROM and RAM are given parts. Core II hangs the data RAM on the ALU\'s output.',
    body: 'mem', tips: [], chapters: [{ chapter: 'memory', step: 4, label: 'Read-only memory' }], codex: ['rom', 'harvard'], anatomy: ['imem', 'dmem'], unlocks: ['sb_rom*', 'ram*'],
  },

  // ---- Act 4 --------------------------------------------------------------------------------
  {
    id: 'i_isa', act: 4, title: 'The RV16 instruction set', kind: 'lesson', requires: ['n_twos'],
    why: 'You can compute (Act 2) and remember (Act 3), but nothing yet says what to compute. The instruction set is that contract: what state exists, what each of RV16I\'s 23 instructions does to it, how each is spelled in 16 bits. Program it first, on the golden model: every instruction you use becomes a path you wire in Act 5.',
    body: 'isa', tips: [], codex: ['isa', 'formats', 'rv16', 'mmio', 'rv32i'], chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }],
  },
  {
    id: 'i_enc', act: 4, title: 'Encode and decode', kind: 'drill', requires: ['i_isa'], drill: 'isa16', par: { mistakes: 2 },
    why: 'The control unit of Act 5 does one thing: read the fields of a word. Do it by hand first, both ways: the opcode in bits 3:0 says which fields are registers and which are pieces of an immediate. Six right answers pass; the Control unit level builds the same decode in 200 NANDs.',
    tips: ['op is the low nibble; rd, rs1, rs2 start at bits 4, 7 and 10, f3 at 13.', 'Registers by name: zero ra sp a0 a1 a2 t0 t1 are x0 … x7, so a0 is x3.', 'S and B split their immediate: imm[5:3] in bits 15:13, imm[2:0] in bits 6:4, where an R-type keeps f3 and rd.'], chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }], codex: ['immediates'],
  },
  {
    id: 'p_add', act: 4, title: 'First program', kind: 'program', requires: ['i_isa'], par: { size: 5, cycles: 5 },
    why: 'Act 5\'s core needs a path for every kind of instruction a program uses; the first program uses four. Two loads from the input device, an add, a store to the output device and a halt: 5 words, 5 instructions at par, and nothing shorter exists. Every program, however large, is made of these steps.',
    tips: ['IN is address 0xFFFC: from x0, that is offset −4. OUT is −3.', 'Two loads, one ALU operation, one store, halt: five words.'],
    chapters: [{ chapter: 'isa', step: 1, label: 'The assembler' }], codex: ['assembly', 'mmio'],
  },
  {
    id: 'p_loop', act: 4, title: 'Loops', kind: 'program', requires: ['p_add'], par: { size: 8, cycles: 330 },
    why: 'Straight-line code runs each instruction once. A branch that goes backwards runs the same few again: sum 1 … n in 8 words, 4 instructions an iteration, 330 on average at par. Most of a processor\'s time goes to loops like this, which is why Act 6 works hardest on the branch that closes one.',
    tips: ['Count n down to 0: add it to the sum, decrement, branch back while it is not zero.', 'Test at the top (<code>beqz a0, done</code>) so that n = 0 works.', 'A test only at the bottom runs the body once for n = 0: the n = 0 test fails.'],
    codex: ['branches'],
  },
  {
    id: 'p_mem', act: 4, title: 'Arrays', kind: 'program', requires: ['p_loop'], par: { size: 14, cycles: 77 },
    why: 'Eight registers hold eight words; everything else lives in memory, reached only by <code>lw</code> and <code>sw</code> with a 6-bit offset (−32 … 31). An array is walked with its address in a register: 14 words, 77 instructions on average at par. Functions next keep their return addresses the same way, on a stack in memory.',
    tips: ['Keep the address in a register and add 1 each step (word addressing).', 'Signed comparison: <code>bge a0, t1, skip</code> keeps the larger one in a0.', '0x0FF and 0x100 do not fit an offset: <code>li</code> the address into a register first.'],
    codex: ['loadstore'],
  },
  {
    id: 'p_call', act: 4, title: 'Functions', kind: 'program', requires: ['p_mem'], par: { size: 15, cycles: 1388 },
    why: 'Code needed in several places should exist once: <code>call</code> (<code>jal ra</code>) jumps and saves the return address, <code>ret</code> (<code>jalr</code> through ra) comes back. 15 words at par; gcd by subtraction averages 1 388 instructions a test. Act 7\'s interrupt handler is a function no instruction calls, so it must save every register it touches.',
    tips: ['Euclid by subtraction: while a ≠ b, subtract the smaller from the larger.', 'gcd calls nothing, so it need not save ra.'],
    codex: ['callconv', 'stack'],
  },
  {
    id: 'p_mul', act: 4, title: 'Multiply in software', kind: 'program', requires: ['p_loop'], par: { size: 13, cycles: 74 },
    why: 'RV16I has no multiply: a product is a loop of shifts and adds, one bit of b per iteration, 28 to 134 instructions (74 on average at par). Act 8\'s sequential multiplier runs the same loop in hardware at one bit a clock, and the MD opcode makes it one instruction.',
    tips: ['Test the low bit of b with <code>and</code> (put 1 in a register first: there is no andi).', 'Each iteration: a ← a &lt;&lt; 1, b ← b &gt;&gt; 1; stop when b = 0.', 'Shift b with <code>srli</code>, not <code>srai</code>: an arithmetic shift of a b with bit 15 set never reaches 0.'],
    codex: ['shiftadd'],
  },
  {
    id: 'p_sort', act: 4, title: 'Sort', kind: 'program', optional: true, requires: ['p_mem'], par: { size: 17, cycles: 353 },
    why: 'Nested loops, data-dependent branches and loads used by the very next instruction, all at once: the mix that exercises every hazard path of Act 6\'s pipeline. Bubble sort in place, 17 words and 353 instructions on average at par, growing as n².',
    tips: ['Bubble sort: n − 1 passes, each swapping neighbours that are out of order.', 'Load a[i] and a[i+1] with offsets 0 and 1 of the same pointer.'],
    codex: [],
  },
  {
    id: 'p_print', act: 4, title: 'Print a number', kind: 'program', optional: true, requires: ['p_mul'], par: { size: 23, cycles: 78 },
    why: 'Numbers are binary inside and decimal on the console, and RV16I cannot divide. Each digit is how many times its power of ten can be subtracted before the rest drops below it: 23 words, 78 instructions on average at par, at most nine subtractions a digit.',
    tips: ['Keep 10000, 1000, 100, 10 in a .data table and walk it.', 'Unsigned compare: <code>sltu</code> then <code>bnez</code> (there is no bltu).', 'Skip leading zeros, but always print the last digit.'],
    codex: [],
  },

  // ---- Act 5 --------------------------------------------------------------------------------
  {
    id: 'c_lesson', act: 5, title: 'The datapath', kind: 'lesson', requires: ['i_isa', 'a_alu16', 'm_rf'],
    why: 'You have every block: an ALU (1 055 NANDs), a register file (2 172), a PC, memories, Act 4\'s programs. Every instruction takes one path through them with different mux settings, and the control unit is the table of those settings. This act builds the table, then three cores, then Core IV: the ripple ALU is 50 of Core III\'s 98 delays.',
    body: 'datapath', tips: [], codex: ['datapath', 'control'], chapters: [{ chapter: 'cpu', step: 0, label: 'The datapath' }],
  },
  {
    id: 'c_imm', act: 5, title: 'Immediate generator', kind: 'build', requires: ['i_isa', 'g_mux8'], base: BUILD5.c_imm, par: { nand: 0, depth: 0 },
    why: 'Constants travel inside instructions, in four formats, and the datapath needs each as a 16-bit word. RV16 keeps every immediate bit where its format put it and the sign always in instr[15], so the generator is wiring: par 0 NANDs. Core I feeds it to the ALU\'s b input and to lui\'s write-back.',
    tips: ['Sign extension is wiring: fan the sign bit (instr[15]) out to every upper bit.', 'Splitters and mergers cost nothing; a 6-bit constant 0 makes the low bits of U.', 'U\'s odd bit: instr[3] is imm[0] (op 7 and 15 are both lui), so u = {instr[15:7], instr[3]} &lt;&lt; 6.'],
    chapters: [{ chapter: 'isa', step: 0, label: 'Six formats, fixed register fields' }], codex: ['immediates', 'signext'], unlocks: ['rv16_imm'], anatomy: ['imm'],
  },
  {
    id: 'c_ctl', act: 5, title: 'Control unit', kind: 'build', requires: ['i_enc', 'g_dec', 'd_kmap', 'g_sop'], base: BUILD5.c_ctl, par: { nand: 200, depth: 13 },
    why: 'The datapath\'s muxes and write enables have nobody to set them. The control unit is the opcode table as logic: a 4→16 decoder, then an OR per signal of the opcodes that need it, 200 NANDs and 13 delays at par. Core I\'s ALU learns its operation 13 delays after the word arrives.',
    tips: ['A 4→16 decoder on op gives one line per opcode.', 'Read the table a column at a time: each bit is an OR of rows. rwe = OP + OPX + ADDI + SHI + LW + LUI + JAL + JALR; isel0 = B + SW + LUI, isel1 = JAL + LUI; wb0 = LW + LUI, wb1 = JAL + JALR + LUI.', 'alu = {OPX, f3} for OP and OPX, from f3[2:1] for SHI, else add (0). An X is free: give it whatever shortens an OR.'],
    chapters: [{ chapter: 'cpu', step: 1, label: 'ALU instructions' }], codex: ['control', 'dontcare'], unlocks: ['rv16_ctl'], anatomy: ['ctl'],
  },
  {
    id: 'c_br', act: 5, title: 'Branch comparator', kind: 'build', requires: ['g_eq16', 'a_slt', 'g_mux'], base: BUILD5.c_br, par: { nand: 287, depth: 44 },
    why: 'Loops end on a condition, and nothing yet decides one. beq, bne, blt and bge differ only in op[1:0], so the comparator is the Equality you built in Act 1 (110 NANDs), Set if less than from Act 2 (169), a mux and an XOR: 287 NANDs at par. Next PC turns its take into a jump.',
    tips: ['Bit 1 of cond picks between "equal" and "less than", bit 0 inverts.', 'Place your Equality and Set if less than: the comparator needs no subtractor of its own.', 'blt and bge are signed: use lt, not ltu (0x8000 is less than 0x7FFF).'],
    chapters: [{ chapter: 'cpu', step: 3, label: 'Branches and jumps' }], codex: ['branches', 'comparator'], unlocks: ['rv16_branch'], anatomy: ['br'],
  },
  {
    id: 'c_npc', act: 5, title: 'Next PC', kind: 'build', requires: ['a_add16', 'a_inc16', 'c_br', 'g_mux8'], base: BUILD5.c_npc, par: { nand: 421, depth: 38 },
    why: 'The PC can only count. Next PC picks where the next instruction comes from: pc + 1, pc + imm (a taken branch, jal) or rs1 + imm (jalr: returns, function pointers), from two of Act 2\'s 16-bit adders, its incrementer and a bus mux: 421 NANDs at par. Core III wires it in front of the PC.',
    tips: ['Two adders, an incrementer and a bus mux.', 'ld = jal | jalr | (br &amp; take).', 'jalr adds the immediate to rs1, not to pc: it is the only target with another base.'],
    chapters: [{ chapter: 'cpu', step: 3, label: 'Branches and jumps' }], codex: ['pc', 'branches'], unlocks: ['rv16_nextpc'], anatomy: ['npc'],
  },
  {
    id: 'c_core1', act: 5, title: 'Core I: arithmetic', kind: 'core', requires: ['c_lesson', 'c_imm', 'c_ctl', 's_pc', 'm_rf', 'a_alu16'], base: BUILD5.c_core1, par: { nand: 3892, period: 84, cycles: 701 },
    why: 'The blocks of acts 1–5 become one loop that runs a program by itself. First the instructions that touch only registers: PC → instruction memory → control → register file → ALU → register file, the spine every later core adds to. 3 892 NANDs and period 84 at par.',
    tips: ['Wire the instruction\'s fields straight to the register file: rs1 = instr[9:7], rs2 = instr[12:10], rd = instr[6:4].', 'A mux picks the ALU\'s b (rs2 or the immediate); another picks what is written back (the ALU\'s result, or the immediate for lui).', 'Use pointers (net labels) for long wires: pc, imm, the result.'],
    chapters: [{ chapter: 'cpu', step: 1, label: 'ALU instructions' }], codex: ['singlecycle', 'datapath'],
  },
  {
    id: 'c_core2', act: 5, title: 'Core II: memory', kind: 'core', requires: ['c_core1', 'm_mem'], base: BUILD5.c_core2, par: { nand: 3990, period: 98, cycles: 824 },
    why: 'Programs need more data than eight registers. <code>lw</code> and <code>sw</code> take their address from the ALU\'s add and the memory answers in the same cycle: only 98 NANDs more, but the period goes from 84 to 98 delays, a data memory read now on every cycle\'s longest path. Core III adds the control flow.',
    tips: ['daddr = the ALU result, dwdata = rs2, dwe = the control\'s mwe.', 'A load writes drdata back: the result mux\'s second input.', 'A store writes no register: its bits 6:4 are imm[2:0], not rd, so rwe must be 0.'],
    chapters: [{ chapter: 'cpu', step: 2, label: 'Loads and stores' }], codex: ['loadstore'], anatomy: ['wb'],
  },
  {
    id: 'c_core3', act: 5, title: 'Core III: control flow', kind: 'core', requires: ['c_core2', 'c_npc'], base: BUILD5.c_core3, par: { nand: 4720, period: 98, cycles: 1236 },
    why: 'Core II runs straight-line code only. The branch comparator and next PC make loops and calls: the complete RV16I, 4 720 NANDs at par, and every Act 4 program runs on hardware you built. Its 98-delay period, 50 of them in the ripple ALU, is what Core IV attacks next.',
    tips: ['The branch comparator takes rs1, rs2 and op[1:0]; the next-PC logic loads the PC when it must jump.', 'jal and jalr write pc + 1: the result mux\'s third input.', 'The branch target comes from next PC (pc + imm), never from the ALU, which a branch does not use.'],
    chapters: [{ chapter: 'cpu', step: 3, label: 'Branches and jumps' }], codex: ['cpi'], unlocks: ['rv16_cpu'],
  },
  {
    id: 'c_computer', act: 5, title: 'A computer', kind: 'build', requires: ['c_core3', 'p_loop'], base: BUILDH.c_computer, par: { nand: 27083, period: 110 },
    why: 'A core alone needs a test bench to serve its memory. Wire it to a ROM, a 64-word RAM and LEDs, decode the addresses, and it runs with nothing outside: 27 083 NANDs at par, three quarters of them the RAM. Then write your own program for it. Act 7\'s interrupts come from devices like these.',
    tips: ['pc is 16 bits, the ROM has 32 words: a splitter gives pc[4:0].', 'Partial decoding: daddr[15] alone tells I/O from RAM (the program only uses the top of the address space for I/O).', 'The LEDs are a 16-bit register written when dwe and daddr[15].', 'Your own program: select the ROM, Edit program…, RV16 assembly.'],
    chapters: [{ chapter: 'io', step: 4, label: 'Switches in, LEDs out' }], codex: ['mmio', 'harvard'], anatomy: ['mmio'],
  },
  {
    id: 'c_fast', act: 5, title: 'Core IV: the critical path', kind: 'core', requires: ['c_core3', 'o_fastadd'], base: BUILD5.c_fast, par: { period: 76, cycles: 1236 },
    why: 'Core III\'s period is 98 NAND delays, and 50 of them are the ripple ALU: every instruction waits for a carry to cross 16 bits, the ones that never add included. Static timing names that path; the fast adders you built shorten it: the same 1 236 cycles at period 76 (par). Act 6 then cuts what is left of the path into stages.',
    tips: ['The Timing panel shows the critical path through your core.', 'Swap the ripple adders on that path for the unlocked Kogge–Stone ALU and adders.', 'After the swap, look again: the path has moved. A fast adder that is now off it costs NANDs and buys no delay.'],
    chapters: [{ chapter: 'fastadd', step: 9, label: 'Swap in fast adders' }], codex: ['criticalpath', 'cla', 'skew'],
  },

  // ---- Act 6 --------------------------------------------------------------------------------
  {
    id: 'o_mc', act: 6, title: 'Multicycle CPU', kind: 'core', optional: true, requires: ['c_core3'], base: BUILD9.o_mc, par: { nand: 5203, period: 76, cycles: 3865 },
    why: 'Core III spends a whole cycle on every instruction, an add as long as a load. Cut the path with registers into 3 or 4 steps under a state machine: period 98 → 76, but Core III\'s programs take 3 865 cycles instead of 1 236, 2.4 times as long. Pipelining cuts the path the same way and keeps every step busy.',
    tips: ['One-hot states (a flip-flop each): F → E → M → W → F, skipping M unless the instruction loads or stores; reset → F.', 'The instruction register loads in F; everything after decodes from it, not from instr.', 'Registers cut the long path: the ALU result is registered at the end of E, and memory reads it in M.', 'Write rd and load the PC only in W; stores only in M.'],
    codex: ['multicycle', 'fsm', 'microcode', 'cpi'], chapters: [{ chapter: 'multicycle', label: 'Multicycle & microcode' }],
  },
  {
    id: 'pi_lesson', act: 6, title: 'Pipelining', kind: 'lesson', requires: ['c_fast'], body: 'pipe',
    why: 'Core IV runs at 76 delays a cycle: every instruction must fit a whole load. Registers between its steps let five run at once, but hazards make the 28 Core III programs take 1 495 cycles instead of 1 236, and with ripple adders E alone is 78 delays. With Kogge–Stone adders in E it wins: period 56, 83 720 NAND delays against Core IV\'s 93 936.',
    tips: [], codex: ['pipeline', 'hazards'], chapters: [{ chapter: 'pipeline', label: 'Pipelining' }, { chapter: 'pipeline', step: 5, label: 'Does it pay? Measured' }],
  },
  {
    id: 'pi_reg', act: 6, title: 'Pipeline register', kind: 'build', requires: ['s_reg16', 'g_mux8', 'g_or'], base: BUILD6.pi_reg, par: { nand: 260, period: 8 },
    why: 'A plain register can only load; between two stages one must also hold (a stall) and clear to a bubble that writes nothing (a flush). A mux to 0 in front does both: 260 NANDs, and the finished RV16 places 16 of them, 4 160 NANDs, a third of the chip. Pipeline I places the first twelve.',
    tips: ['Two controls, two questions: en decides whether to load at all, clr what is loaded.', 'A mux in front picks 0 when clr; the register loads when en or clr.', 'Clear wins over hold: a flush during a stall must still leave a bubble. Leaving clr out of the load enable is the classic miss.'],
    codex: ['stall', 'flush'], unlocks: ['rv16_preg'], anatomy: ['p1', 'p2', 'p3', 'p4'], chapters: [{ chapter: 'pipeline', step: 1, label: 'Pipeline registers' }],
  },
  {
    id: 'pi_core0', act: 6, title: 'Pipeline I: five stages', kind: 'core', requires: ['pi_lesson', 'pi_reg'], base: BUILD6.pi_core0, par: { nand: 7062, period: 65, cycles: 2508 },
    why: 'Cut the datapath into F, D, E, M and W, and five instructions run at once. No stage knows yet what the others hold, so these programs never branch and keep producers two apart: 7 062 NANDs at period 65, but the two nops after every instruction make it 2 508 cycles. Pipeline II removes the nops.',
    tips: ['Write the register file at the falling edge (clock it with ¬clk): an instruction three behind its producer then reads the new value.', 'Carry everything a later stage needs in the pipeline registers: rd, control signals, the immediate. Without branches no stage after F needs the pc.', 'Report register writes from W and stores from M.'],
    codex: ['pipeline'], chapters: [{ chapter: 'pipeline', step: 0, label: 'Overlap the work' }],
  },
  {
    id: 'pi_fwd', act: 6, title: 'Forwarding unit', kind: 'build', requires: ['g_eq16', 'pi_lesson'], base: BUILD6.pi_fwd, par: { nand: 110, depth: 13 },
    why: 'Pipeline I pads with nops because a result made in E reaches the register file only from W. The forwarding unit spots when E reads a register that M or W is about to write and picks that value: 110 NANDs, but its 13 delays land on E, period 65 → 78. Pipeline II and every later pipeline place it.',
    tips: ['Compare 3-bit register numbers: the library equality comparators are unlocked.', 'x0 is never forwarded; M has priority over W (it is newer).', 'Gate each match with that stage\'s rwe: a store\'s or a branch\'s rd bits are part of its immediate, not a register it writes.'],
    codex: ['forwarding', 'comparator'], unlocks: ['rv16_fwd'], anatomy: ['fwd'], chapters: [{ chapter: 'pipeline', step: 2, label: 'Data hazards and forwarding' }],
  },
  {
    id: 'pi_core1', act: 6, title: 'Pipeline II: forwarding', kind: 'core', requires: ['pi_core0', 'pi_fwd'], base: BUILD6.pi_core1, par: { nand: 7417, period: 78, cycles: 970 },
    why: 'Pipeline I pads every instruction with two nops. With two 3:1 muxes in front of E, steered by the forwarding unit, an instruction may use the result of the one just before it: +355 NANDs and period 78, and the 19 programs fall from 2 508 cycles to 970. Pipeline III removes the last nop, the one after each load.',
    tips: ['Each operand comes from one of three places: the register file, M or W.', 'M\'s forwarded value is its result before memory: the ALU\'s, or the immediate for lui (this pipeline has no jumps, so no pc + 1 yet).', 'Forward rs2 too: stores use it (and from Pipeline IV on, branches). Forwarding rs1 only is the classic miss.'],
    codex: ['forwarding'], chapters: [{ chapter: 'pipeline', step: 2, label: 'Data hazards and forwarding' }],
  },
  {
    id: 'pi_haz', act: 6, title: 'Hazard unit', kind: 'build', requires: ['g_eq16', 'pi_core1'], base: BUILD6.pi_haz, par: { nand: 53, depth: 12 },
    why: 'Pipeline II still needs a nop after every load: its word leaves memory at the end of M, when the user is already in E. The hazard unit, in D, spots that case and holds the front one cycle: 53 NANDs, and the stall is paid only when the next instruction reads the loaded register. Pipeline III wires it in.',
    tips: ['A load in E: rwe and wb = memory.', 'Compare against the instruction in D, not in E: once the user is in E it is too late to hold it.', 'Being conservative is allowed: a stall too many only costs a cycle. One too few is wrong: test the load\'s rd against rs1 and rs2 both, even for a store, whose rs2 is the word it writes.'],
    codex: ['loaduse', 'scoreboard'], unlocks: ['rv16_haz'], anatomy: ['haz'], chapters: [{ chapter: 'pipeline', step: 3, label: 'The load-use stall' }],
  },
  {
    id: 'pi_core2', act: 6, title: 'Pipeline III: load-use', kind: 'core', requires: ['pi_core1', 'pi_haz'], base: BUILD6.pi_core2, par: { nand: 7531, period: 78, cycles: 917 },
    why: 'Pipeline II still needs a nop after every load. With the hazard unit it stalls only when the next instruction really reads the loaded register: hold the PC and F/D, put a bubble into E, then forward from W. +114 NANDs, period unchanged, 970 → 917 cycles. Pipeline IV builds on this core.',
    tips: ['A stall touches three registers: the PC, F/D and D/E.', 'stall: the PC reloads its own value (a 2:1 mux in front of it: the PC register has no enable), F/D en = 0, D/E clr = 1.', 'Clearing F/D instead of D/E is the classic miss: the waiting instruction must stay in D, and the bubble goes into E.'],
    codex: ['stall', 'loaduse'], chapters: [{ chapter: 'pipeline', step: 3, label: 'The load-use stall' }],
  },
  {
    id: 'pi_core3', act: 6, title: 'Pipeline IV: branches', kind: 'core', requires: ['pi_core2'], base: BUILD6.pi_core3, par: { nand: 9218, period: 78, cycles: 1495 },
    why: 'Pipeline III cannot branch: a branch is decided in E, after the next two words were fetched as if not taken. Flush them and fetch the target: +1 687 NANDs, and every taken branch or jump costs two cycles, 1 495 on Core III\'s 28 programs against 1 236. Pipeline V adds traps to it.',
    tips: ['redirect = the next-PC logic\'s ld in E; it loads the PC and clears F/D and D/E.', 'jal and jalr write pc + 1: carry pc and pc + 1 down to E, and forward pc + 1 from M like any result.', 'Every taken branch costs two cycles: the price predictors (and earlier resolution) try to lower. Clearing only F/D is the classic miss: the word in D was fetched on the wrong path too.'],
    codex: ['flush', 'controlhazard'], chapters: [{ chapter: 'pipeline', step: 4, label: 'Control hazards' }],
  },
  {
    id: 'o_bpred', act: 6, title: 'Branch prediction', kind: 'core', optional: true, requires: ['pi_core3'], base: BUILD9.o_bpred, par: { nand: 9789, period: 80, cycles: 2303 },
    why: 'Pipeline IV flushes two instructions on every taken branch, and a loop takes its branch every time but the last. Guess in F, jal and backward branches taken: +571 NANDs, period 80, and 13% fewer cycles on these 31 programs. Alone that does not catch Core IV; with Kogge–Stone adders in E it does.',
    tips: ['Static prediction is enough for ★★★: backward branches (offset sign bit, instr[15]) are loops, so predict them taken; jal is always taken.', 'The target in F is pc + imm: decode the fetched word there (the immediate generator is pure wiring) and add.', 'Carry the guess down the pipeline; in E, redirect when (taken ≠ predicted): to the target, or back to pc + 1 when a predicted branch falls through.', 'Mind the stall: holding the PC must win over the guess.'],
    codex: ['bpred', 'controlhazard'], chapters: [{ chapter: 'pipepay', label: 'Making the pipeline pay' }, { chapter: 'pipepay', step: 2, label: 'Predicting branches' }],
  },

  // ---- Act 7 --------------------------------------------------------------------------------
  {
    id: 'y_lesson', act: 7, title: 'Traps and interrupts', kind: 'lesson', requires: ['c_core3', 'c_computer'], body: 'traps',
    why: 'Your computer cannot be told anything: it must poll a device in a loop, and an undefined word runs as whatever its bits select. A real processor stops between two instructions, saves where and why in CSRs, runs a handler and resumes. This act builds that on the single-cycle core, for 2 537 NANDs over Core III, then in the pipeline.',
    tips: [], codex: ['traps', 'csr'], chapters: [{ chapter: 'traps', label: 'Traps and interrupts' }],
  },
  {
    id: 'y_csr', act: 7, title: 'CSR file', kind: 'build', requires: ['s_reg16', 'g_dec', 'g_mux8', 'y_lesson'], base: BUILD7.y_csr, par: { nand: 1765, period: 17 },
    why: 'A trap needs somewhere to keep the return address, the cause and the interrupt enable without touching the program\'s eight registers. Six 16-bit registers and an 8:1 read port: 1 765 NANDs, more than a third of Core III. A trap writes three of them on one edge and mret undoes it; Exceptions places the file, and every core after it keeps it.',
    tips: ['Six 16-bit registers and an 8:1 read mux. mstatus computes its next value every cycle, so it needs no enable.', 'mstatus: bits 3 (MIE) and 7 (MPIE) have their own next-value logic; the other bits only change on a write.', 'A trap wins over a software write in the same cycle: the instruction that writes is the one being trapped, so its write must not happen.'],
    codex: ['csr'], unlocks: ['rv16_csr'], anatomy: ['csr'], chapters: [{ chapter: 'traps', step: 0, label: 'Control and status registers' }],
  },
  {
    id: 'y_trap', act: 7, title: 'Exceptions', kind: 'core', requires: ['c_core3', 'y_csr'], base: BUILD7.y_trap, par: { nand: 7257, period: 100, cycles: 712 },
    why: 'Core III runs an undefined word as whatever its bits select, and a program cannot call the system or stop for a debugger. Exceptions replaces such an instruction by a jump to mtvec, with pc saved in mepc and the cause in mcause: +2 537 NANDs over Core III, period 100. Interrupts reuses all of it, and Pipeline V moves it into the pipeline.',
    tips: ['The illegal-instruction detector and the system decoder are given (open them: the detector is a function of the 16-bit word, the decoder computes the CSR write value).', 'On a trap: no register write, no store, pc ← mtvec, mepc ← pc.', 'csrr* write the old CSR value to rd.'],
    codex: ['traps', 'vm'], gives: ['rv16_ill', 'rv16_sysdec'], unlocks: ['rv16_ill', 'rv16_sysdec'], chapters: [{ chapter: 'traps', step: 2, label: 'Exceptions' }],
  },
  {
    id: 'y_irq', act: 7, title: 'Interrupts', kind: 'core', requires: ['y_trap'], base: BUILD7.y_irq, par: { nand: 7257, period: 100, cycles: 740 },
    why: 'Exceptions ignores its irq pin: a device must still be polled. Taking it costs 0 NANDs (the CSR file already computes intr, the cause logic has its term), so this level adds the protocol, checked by an interrupt-driven program: enable order, acknowledge, an mepc naming the instruction not yet run. The finale reuses it.',
    tips: ['intr = MIE · MEIE · irq, from the CSR file.', 'Check it before the instruction at pc runs; it wins over everything else.', 'An interrupt\'s mepc is the pc of the instruction that did not run, and mret returns to it: adding 1, as an ecall handler does, skips an instruction.'],
    codex: ['interrupts'], unlocks: ['rv16_cpu_irq'], chapters: [{ chapter: 'traps', step: 4, label: 'External interrupts' }],
  },
  {
    id: 'p_handler', act: 7, title: 'An interrupt handler', kind: 'program', requires: ['y_lesson', 'p_call'], par: { size: 22 },
    why: 'An interrupt lands between any two instructions of main, so the handler saves what it touches, serves and acknowledges the device and returns with mret: 22 words in the reference. It runs on the golden model; the finale requires it because its interrupt-driven test is a handler of this shape.',
    tips: ['mtvec ← the handler\'s address; mie ← 0x800 (MEIE); then set mstatus bit 3 (MIE) last.', 'push / pop what the handler uses (main\'s registers must survive).', 'Acknowledge with <code>sw x0, -7(x0)</code> before mret, or the interrupt fires again at once.'],
    codex: ['interrupts', 'traps'], chapters: [{ chapter: 'traps', step: 4, label: 'External interrupts' }],
  },
  {
    id: 'y_ptrap', act: 7, title: 'Pipeline V: exceptions', kind: 'core', requires: ['pi_core3', 'y_trap'], base: BUILD7.y_ptrap, par: { nand: 12031, period: 81, cycles: 2361 },
    why: 'Pipeline IV holds five instructions, so a trap must be precise: older ones finish, younger ones are cancelled, and mepc names the culprit. Taking traps in E, where the instruction has written nothing yet, does it: +2 813 NANDs over Pipeline IV, period 81. The finale adds the interrupt to this core.',
    tips: ['Take traps in E: older instructions in M and W still complete, younger ones in F and D are flushed.', 'Carry a valid bit: a bubble\'s all-zero word would otherwise look like an illegal instruction.', 'A CSR instruction reads and writes in E; its old value travels down as the result.'],
    codex: ['precise', 'flush'], chapters: [{ chapter: 'traps', step: 5, label: 'Inside the trap unit' }],
  },
  {
    id: 'y_final', act: 7, title: 'Finale: interrupts', kind: 'core', requires: ['y_ptrap', 'y_irq', 'p_handler'], base: BUILD7.y_final, par: { nand: 12038, period: 81, cycles: 2399 },
    why: 'Pipeline V still polls. The finale takes the interrupt in E, on a valid instruction only: 7 NANDs, 12 038 in all. The 45 programs take 194 319 NAND delays against 197 600 on the single-cycle core with interrupts, and that 2% is all a ripple-adder pipeline wins; with Kogge–Stone adders in E it would be 28%.',
    tips: ['intr = MIE · MEIE · irq comes from the CSR file: wire the pin in and OR the interrupt into the trap.', 'Gate the interrupt with the valid bit too: a bubble in E has no pc of its own (its D/E slot was cleared), so mepc would name an address the program never was at.', 'mcause for the interrupt is 0x800B (bit 15, external cause 11): it wins over every exception.'],
    codex: ['interrupts'], chapters: [{ chapter: 'traps', step: 4, label: 'External interrupts' }, { chapter: 'pipepay', step: 5, label: 'Measured, all together' }],
  },

  // ---- Act 8 --------------------------------------------------------------------------------
  {
    id: 'o_lesson', act: 8, title: 'Area or time', kind: 'lesson', optional: true, requires: ['c_core3'], body: 'arith',
    why: 'Your core has no multiply, divide or floating point: Act 4\'s software multiply took 28 to 134 instructions a product. Each can be built for area or for time, and each choice moves NANDs, period or cycles: an array multiplier in the core takes its period from 98 to 191. Two tracks: multiply and divide, and the FP units.',
    tips: [], codex: ['mext', 'ieee754'], chapters: [{ chapter: 'muldiv', label: 'Multiply & divide' }, { chapter: 'float', label: 'Floating point' }],
  },
  {
    id: 'o_mulseq', act: 8, title: 'Shift-and-add multiplier', kind: 'build', optional: true, requires: ['a_add16', 's_reg16', 'p_mul'], base: BUILD8.o_mulseq, givesOf: partsOf(() => seqMul(16)), par: { nand: 1169, period: 48 },
    why: 'Act 4\'s software multiply took 28 to 134 instructions a product; this is that loop in hardware, one adder reused once per clock. 18 cycles of a 48-delay clock against one 150-deep pass: about 5.8 times the time, on less than half the NANDs (1 169 against 2 672). The Divider runs the same pattern, one datapath step per clock under a counter.',
    tips: ['The iteration counter is given: you build the datapath it steps.', 'The product register starts as {0, b}; each step adds a to its upper half if its lowest bit is 1, then shifts everything right.', 'The adder\'s carry out is the new top bit after the shift: dropping it is the classic miss, and only small products come out right.'],
    codex: ['shiftadd'], chapters: [{ chapter: 'muldiv', label: 'Multiply & divide' }],
  },
  {
    id: 'o_mularr', act: 8, title: 'Array multiplier', kind: 'build', optional: true, requires: ['a_add16'], base: BUILD8.o_mularr, givesOf: partsOf(() => arrayMul(8)), par: { nand: 632, depth: 70 },
    why: 'A shift-and-add unit takes 18 cycles a product; the array does every addition at once, in rows of adders: 632 NANDs, 70 deep at 8 × 8, and 2 672 NANDs, 150 deep at 16 × 16. Multiply in the core places the 16 × 16 one and finds out what 150 delays do to every instruction\'s clock.',
    tips: ['Row k is a AND b[k], shifted left by k.', 'Add the rows one after the other: each adder\'s carry out becomes the next row\'s top bit.', 'Row 0\'s lowest bit is already p[0], and each row after it fixes one more product bit: only the last row\'s adder gives the top half.'],
    codex: ['arraymul', 'carrysave'], chapters: [{ chapter: 'muldiv', step: 0, label: 'Long multiplication is AND and add' }],
  },
  {
    id: 'o_mcore', act: 8, title: 'Multiply in the core', kind: 'core', optional: true, requires: ['c_core3', 'o_mularr'], base: BUILD9.o_mcore, gives: ['amul16'], par: { nand: 8037, period: 191, cycles: 876 },
    why: 'Act 4 multiplied with a loop of 28 to 134 instructions; the MD opcode does it in one. The 16 × 16 array sits between the register file\'s read and its write, so every instruction pays its depth: period 98 → 191, and code without a single multiply runs 1.95 times slower. Divide in the core adds the divider to this core.',
    tips: ['The MD opcode is 0011: decode it next to the control unit, and OR its write into rwe.', 'Put the multiplier\'s result on the write-back path with one more mux.', 'With p = a·b unsigned (32 bits): mulhu = p[31:16]; mulhsu = p[31:16] − (a < 0 ? b : 0); mulh = p[31:16] − (a < 0 ? b : 0) − (b < 0 ? a : 0), all mod 2^16. A negative a is worth a − 2^16, which is where the correction comes from.'],
    codex: ['mext', 'signedmul', 'arraymul', 'booth'], unlocks: ['rv16_mul'], chapters: [{ chapter: 'muldiv', label: 'Multiply & divide' }],
  },
  {
    id: 'o_div', act: 8, title: 'Divider', kind: 'build', optional: true, requires: ['a_addsub16', 's_fsm'], base: BUILD8.o_div, givesOf: partsOf(() => seqDivider(16, RV16_MUX2)), par: { nand: 1445, period: 31 }, unlocks: ['sdiv16_rv16'],
    why: 'RV16I has no divide, and in one pass it is expensive: unrolled, the 16 subtract-and-compare steps are 4 464 NANDs on a 613-deep path. The iterative divider does one step per clock under a counter: 1 445 NANDs, period 31, 18 cycles a quotient. Divide in the core puts it in your core and makes the core wait for it.',
    tips: ['Shift the remainder left, bring in the next dividend bit, subtract the divisor: if the result is not negative keep it and set the quotient bit.', 'b = 0 needs no special case: every subtraction succeeds, so q = 0xFFFF and r = a, as RISC-V wants.', 'Subtracting before the shift is the classic miss: the next dividend bit must be in the remainder before it is compared.'],
    codex: ['division'], chapters: [{ chapter: 'muldiv', step: 15, label: 'The iterative divider' }],
  },
  {
    id: 'o_dcore', act: 8, title: 'Divide in the core', kind: 'core', optional: true, requires: ['o_mcore', 'o_div'], base: BUILD9.o_dcore, par: { nand: 10546, period: 193, cycles: 1859 },
    why: 'Every instruction so far finished in one cycle; a divide takes 18. The core starts the divider, holds the PC and writes nothing until done, the single-cycle core\'s version of a stall: 10 546 NANDs at period 193, and the 23 programs take 1 859 cycles. It ends the multiply-and-divide track.',
    tips: ['start = (a divide); hold = start and not done. Hold the PC by loading it with itself: ld = ld | hold, target = hold ? pc : target.', 'Write nothing while holding: rwe for MD = MD and not hold.', 'Signs: an adder / subtractor with a = 0 negates when sub = 1. Negate the quotient only when b ≠ 0.'],
    codex: ['mext', 'division', 'stall'], unlocks: ['rv16_div'], chapters: [{ chapter: 'muldiv', step: 21, label: 'The M unit' }],
  },
  {
    id: 'n_float', act: 8, title: 'Floating point', kind: 'drill', optional: true, requires: ['n_twos'], drill: 'float', par: { mistakes: 2 },
    why: 'A 16-bit integer stops at 32 767 and has no fractions. Binary16 spends the same 16 bits on a sign, an exponent and a fraction, a binary scientific notation that reaches 65 504 and keeps 11 significant bits. Encode and decode it by hand: Float unpack, the first FP unit, reads these fields.',
    tips: ['Write the value as 1.f × 2^e; the exponent field is e + 15.', 'Exponent field 0 has no hidden bit (zero and the subnormals, worth 0.f × 2^−14); field 31 is not a number at all, ∞ or NaN.'],
    codex: ['ieee754'], chapters: [{ chapter: 'float', label: 'Floating point' }, { chapter: 'float', step: 0, label: 'Scientific notation in binary' }],
  },
  {
    id: 'o_fpunpack', act: 8, title: 'Float unpack', kind: 'build', optional: true, requires: ['n_float'], base: BUILDFP.o_fpunpack, givesOf: fpGives(FP_REF.unpack), par: { nand: 63, depth: 14 }, unlocks: ['fpun5_10'],
    why: 'Every FP unit needs a sign, an exponent and an 11-bit significand, but the hidden bit is not stored and the exponent field also encodes zero, subnormals, infinity and NaN. Unpack decodes that once: 63 NANDs, depth 14. The adder, the multiplier and the comparator each place two.',
    tips: ['The hidden bit is NOT (exponent field = 0).', 'A subnormal\'s exponent is 1, not 0: OR the field\'s low bit with "field = 0".', 'inf and nan share "field all 1s"; the fraction tells them apart.'],
    codex: ['ieee754', 'subnormal'], chapters: [{ chapter: 'float', step: 2, label: 'Unpack' }],
  },
  {
    id: 'o_fpround', act: 8, title: 'Rounding decision', kind: 'build', optional: true, requires: ['n_float'], base: BUILDFP.o_fpround, givesOf: fpGives(() => ROUND_DECIDE), par: { nand: 62, depth: 13 }, unlocks: ['fpround'],
    why: 'An exact sum or product has more bits than the 11 the format keeps, and three of them decide its rounding in all five modes: the last kept bit, the first dropped one (guard) and whether anything below was 1 (sticky). 62 NANDs, depth 13. Normalize & round places it, so every FP result passes through it once.',
    tips: ['Decode rm into one wire per mode first; each mode is then a small AND.', 'Ties to even: a tie is g = 1 and s = 0; then round up only if lsb = 1.', 'The directed modes read the sign: rounding "down" a negative result moves it away from zero.'],
    codex: ['rounding'], chapters: [{ chapter: 'float', step: 5, label: 'Five rounding modes' }],
  },
  {
    id: 'o_fpsticky', act: 8, title: 'Sticky shifter', kind: 'build', optional: true, requires: ['n_float', 'a_shift16'], base: BUILDFP.o_fpsticky, givesOf: fpGives(FP_REF.sticky), par: { nand: 264, depth: 21 }, unlocks: ['shrs13_4', 'shrs15_4'],
    why: 'Adding floats shifts the smaller operand right to align the binary points, and the bits that fall off still decide rounding, as one bit: was any of them 1? A right barrel shifter whose levels OR what they drop: 264 NANDs, depth 21. The FP adder places it, normalize & round a 15-bit one.',
    tips: ['The barrel shifter again, right only: level k shifts by 2^k.', 'Each level also ORs the bits it drops; sticky is the OR of the levels that shifted.', 'A level that does not shift drops nothing: gate its OR with its shift bit, or sticky reads bits that are still in the word.'],
    codex: ['sticky', 'shifter'], chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }],
  },
  {
    id: 'o_fplzc', act: 8, title: 'Leading-zero counter', kind: 'build', optional: true, requires: ['n_float'], base: BUILDFP.o_fplzc, givesOf: fpGives(FP_REF.lzc, () => [lzc(8), lzc(4), lzc(2)]), par: { nand: 104, depth: 9 }, unlocks: ['lzc*'],
    why: 'Subtracting close numbers cancels the top bits (1.0001 − 1.0000 leaves 0.0001), and normalizing must shift the first 1 back up by the number of leading zeros. Counting them by halves takes 104 NANDs at depth 9 for 16 bits. Normalize & round places it.',
    tips: ['A 2-bit counter: c = NOT a1, v = a1 OR a0.', 'Two n/2-bit counters make an n-bit one: if the upper half has a 1, take its count; else n/2 + the lower count. The top bit of c is just NOT v_upper.', 'Build the 8-bit one as a chip from two 4-bit ones, and so on: the recursion is the design.'],
    codex: ['lzc'], chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }],
  },
  {
    id: 'o_fpnorm', act: 8, title: 'Normalize & round', kind: 'build', optional: true, requires: ['o_fpround', 'o_fpsticky', 'o_fplzc'], base: BUILDFP.o_fpnorm, givesOf: fpGives(FP_REF.norm), par: { nand: 2058, depth: 86 }, unlocks: ['fpnr5_10_15', 'fpnr5_10_16_rv16', 'fpnr5_10_22'],
    why: 'Add, multiply and int → float all end the same way: a raw significand and exponent must become a correctly rounded word, subnormals and overflow included. Built from the three blocks below it: 2 058 NANDs, depth 86, more than half the FP adder. The adder and Integer to float place it.',
    tips: ['Left shift by min(leading zeros, exp − 1): never below exponent 1. If exp < 1, shift right by 1 − exp instead (sticky shifter).', 'After the shift the kept bits are the top 11; then the guard bit; everything below it, and stin, is the sticky bit.', 'Rounding up 1.111…1 carries into a new top bit: the exponent goes up by one and the fraction is 0.', 'Overflow: a final field of 31 or more. Then toInf picks ∞ or 0x7BFF.'],
    codex: ['normalize', 'rounding', 'subnormal'], chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }],
  },
  {
    id: 'o_fpadd', act: 8, title: 'FP adder', kind: 'build', optional: true, requires: ['o_fpunpack', 'o_fpnorm'], base: BUILD8.o_fpadd, givesOf: fpGives(() => fpAdd(F16, RV16_MUX2)), par: { nand: 3732, depth: 163 },
    why: 'Adding floats means aligning their binary points, adding, then normalizing and rounding, and every block for that is built: 3 732 NANDs, depth 163, normalize & round 2 058 of them. RV16 has no F registers, so this and the other FP units stand alone: no core in the campaign runs them. The FP multiplier reuses its normalizer, wider.',
    tips: ['Swap so that |a| ≥ |b|, shift b right by the exponent difference (keep a sticky bit), add or subtract the significands.', 'Leave room: put the significands at bits 13..3 of a 15-bit word (a carry above, guard and sticky below), and hand normalize & round exponent + 1.', 'x − x is +0 (−0 in RDN). NaN in, or ∞ − ∞, gives the canonical NaN 0x7E00.'],
    codex: ['ieee754', 'rounding'], chapters: [{ chapter: 'float', step: 3, label: 'Addition: align, add, normalize, round' }, { chapter: 'float', step: 13, label: 'An FPU in the CPU' }],
  },
  {
    id: 'o_fpmul', act: 8, title: 'FP multiplier', kind: 'build', optional: true, requires: ['o_fpadd', 'o_mularr'], base: BUILD8.o_fpmul, givesOf: fpGives(() => fpMul(F16, RV16_MUX2)), par: { nand: 4912, depth: 150 },
    why: 'Multiplying floats needs no alignment: XOR the signs, add the exponents less one bias, multiply the 11-bit significands, normalize & round. 4 912 NANDs at depth 150, against the adder\'s 163; the significand product grows with the square of the width, and the binary32 multiplier is 14 913 NANDs.',
    tips: ['Signs, exponents and significands are three separate datapaths: s = sa XOR sb, e = ea + eb − 15, and the given 11 × 11 multiplier for the significands.', '11 × 11 bits gives a 22-bit product; its top bit decides whether to shift by one (and add one to the exponent).', 'Special cases before the arithmetic: 0 × ∞ is NaN, NaN in gives the canonical NaN, and a subnormal input has exponent 1 and no hidden bit, as unpack says.'],
    codex: ['ieee754', 'fma'], chapters: [{ chapter: 'float', step: 7, label: 'Multiplication' }, { chapter: 'float', step: 13, label: 'An FPU in the CPU' }],
  },
  {
    id: 'o_fpcmp', act: 8, title: 'FP comparator', kind: 'build', optional: true, requires: ['o_fpunpack'], base: BUILDFP.o_fpcmp, givesOf: fpGives(FP_REF.cmp), par: { nand: 682, depth: 25 },
    why: 'Comparing floats as integers almost works, because the exponent sits above the fraction: non-negative patterns are already in order. What breaks is the sign (two negatives order backwards), the two zeros (−0 = +0) and NaN (unordered). 682 NANDs, depth 25, one unpack per operand; like the other FP units it stands alone.',
    tips: ['|a| < |b| is a 15-bit unsigned compare of the patterns without their sign bits.', 'Two negatives: the order flips. Different signs: the negative one is smaller, unless both are zeros.', 'Any NaN: eq, lt and le are all 0.'],
    codex: ['fpcompare'], chapters: [{ chapter: 'float', label: 'Floating point' }],
  },
  {
    id: 'o_fpcvt', act: 8, title: 'Integer to float', kind: 'build', optional: true, requires: ['o_fpnorm'], base: BUILDFP.o_fpcvt, givesOf: fpGives(FP_REF.cvt), par: { nand: 2690, depth: 109 },
    why: 'fcvt.h.w: an integer is already a significand, with its binary point at the right. Take its magnitude, and normalize & round finds the leading 1 and rounds what does not fit in 11 bits: 2 690 NANDs, depth 109, with no new arithmetic. It closes the ladder\'s conversion branch.',
    tips: ['|x| = signed and x < 0 ? −x : x (a conditional negate).', 'The integer\'s top bit weighs 2^15: the exponent you hand normalize & round is 15 + bias.', 'The sign comes from x, not from |x|: negate, convert, then put the sign back. −32 768 is its own negation, and still converts right as an unsigned magnitude.'],
    codex: ['normalize'], chapters: [{ chapter: 'float', label: 'Floating point' }],
  },
  // ---- Act 9 --------------------------------------------------------------------------------
  {
    id: 'k_lesson', act: 9, title: 'Latency or throughput', kind: 'lesson', optional: true, requires: ['c_core3'], body: 'gpu',
    why: 'Much of computing is one small program over thousands of data, where what counts is results per second. One control unit can feed four lanes: 15 669 NANDs against 18 880 for four of your cores. Lanes first, then warps, then a rasterizer.',
    tips: [], codex: ['throughput', 'simd', 'amdahl'], chapters: [{ chapter: 'lanes', label: 'Latency or throughput' }, { chapter: 'lanes', step: 4, label: 'Lanes against cores' }],
  },
  {
    id: 'k_lanes', act: 9, title: 'Four lanes', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_lanes, par: { nand: 4596, depth: 55 },
    why: 'Your core computes one result per instruction. Here its execute step comes four times, four ALUs on one set of control signals: 4 596 NANDs, all of it replicated. The SIMD core puts what they share around them.',
    tips: ['Your ALU and the 49-NAND bus mux are unlocked: one mux and one ALU per lane.', 'nz: OR the 16 bits of each a<sub>i</sub>, then merge the four bits.', 'Every lane gets the same alu, bimm and imm: fan them out, never decode them per lane.'],
    codex: ['lane'], unlocks: ['rv16_lanes4'], chapters: [{ chapter: 'lanes', step: 1, label: 'One decoder, four ALUs' }],
  },
  {
    id: 'k_vrf', act: 9, title: 'Lane register file', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_vrf, par: { nand: 8688, period: 11 },
    why: 'Four ALUs on one register file compute the same results. Each lane needs its own registers, same numbers, different values: four files, 8 688 NANDs, 55% of the SIMD core. Storage, not control, is what a lane costs.',
    tips: ['Your register file is unlocked: one per lane, sharing wa, ra1 and ra2.', 'Split we into four bits: one write enable per lane.', 'Each lane writes its own word wd<sub>i</sub>: a single data input fanned out to all four would give every lane lane 0\'s result.'],
    codex: ['vrf'], unlocks: ['rv16_vrf4'], chapters: [{ chapter: 'lanes', step: 1, label: 'One decoder, four ALUs' }],
  },
  {
    id: 'k_mask', act: 9, title: 'Active mask', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_mask, par: { nand: 102, period: 8 },
    why: 'Not every lane has work: the tail of an array, one side of an if. The mask stops a lane writing and names the leader, the lowest active lane, which speaks for the warp: 102 NANDs. The SIMD core gates its writes with it.',
    tips: ['A 4-bit register; at reset its input is forced to 1111 (OR each bit with rst) and it loads.', 'lead: lane 0 if m0; else 1 if m1; else 2 if m2; else 3. Bit 1 = ¬m0·¬m1, bit 0 = ¬m0·(m1 + ¬m2).', 'we and dwe: AND the mask with rwe and mwe, copied to four bits.'],
    codex: ['activemask', 'leader'], unlocks: ['rv16_mask4'], chapters: [{ chapter: 'simt', label: 'Threads in lock-step' }],
  },
  {
    id: 'k_simd', act: 9, title: 'SIMD core', kind: 'core', optional: true, requires: ['k_lanes', 'k_vrf', 'k_mask'], base: BUILDK.k_simd, par: { nand: 15669, period: 100, cycles: 810 },
    why: 'One fetch, one decode, one control unit; four lanes on their own registers and memory ports, told apart by tid: 15 669 NANDs against 18 880 for four single-cycle cores. A branch has one PC, so the leader decides it.',
    tips: ['Start from your single-cycle core: the control unit, immediates, branch and next-PC logic stay as they are.', 'The lane decoder is given: tmc, tid, split and join (the last two can wait for the SIMT core).', 'Leader operands: two 4:1 bus muxes on the lanes’ rs1 and rs2, selected by lead. They feed the branch unit, jalr and tmc.', 'Results: per lane, ALU or memory; pc + 1 and the immediate are the same for every lane; tid replaces them all when the decoder says so.'],
    codex: ['warp'], gives: ['rv16_lanedec'], unlocks: ['rv16_lanedec'], chapters: [{ chapter: 'lanes', step: 2, label: 'The leader' }, { chapter: 'lanes', step: 4, label: 'Lanes against cores' }],
  },
  {
    id: 'k_stack', act: 9, title: 'Reconvergence stack', kind: 'build', optional: true, requires: ['k_simd'], base: BUILDK.k_stack, par: { nand: 1995, period: 19 },
    why: 'When lanes disagree on an if, the SIMD core follows the leader and the rest compute the wrong side. Run one side, park the other with where to resume, then reconverge; ifs nest, so it is a stack: 1 995 NANDs.',
    tips: ['An entry is 26 bits: mask, else lanes, pc, pending, valid. Registers with enable, a 2:1 mux in front of each: a push shifts down, a pop shifts up.', 'The top entry decides join: pending → run the else lanes (jump); not pending → restore and pop.', 'Reset clears only the valid bits; the rest may hold anything.'],
    codex: ['reconvergence', 'divergence'], unlocks: ['rv16_stack4'], chapters: [{ chapter: 'simt', step: 2, label: 'split and join' }, { chapter: 'simt', step: 3, label: 'An if inside an if' }],
  },
  {
    id: 'k_simt', act: 9, title: 'SIMT core', kind: 'core', optional: true, requires: ['k_simd', 'k_stack'], base: BUILDK.k_simt, par: { nand: 17732, period: 100, cycles: 919 },
    why: 'With the stack, split and join let each lane follow its own control flow under one control unit: +2 063 NANDs, period unchanged. Divergence now costs utilization instead of correctness; the two-warp core starts here.',
    tips: ['The stack’s p is the lanes’ nz (rs1 ≠ 0); its pc1 is the next-PC logic’s pc + 1.', 'Mask: load when tmc runs or the stack says so; tmc’s value wins.', 'The PC: a 2:1 mux after the next-PC choice, to jpc when the stack jumps.'],
    codex: ['simt'], chapters: [{ chapter: 'simt', step: 2, label: 'split and join' }, { chapter: 'simt', step: 5, label: 'What divergence costs' }],
  },
  {
    id: 'p_saxpy', act: 9, title: 'saxpy', kind: 'program', optional: true, requires: ['k_simd'], par: { cycles: 90, laneops: 360 },
    why: 'The kernel the SIMD core was built for: y ← a·x + y, every element independent, a the same in every lane, so no lane ever disagrees with the leader. 90 cycles, against 281 for the same program on one lane.',
    tips: ['Thread i handles elements i, i + 4, i + 8, …: start at tid, step by 4.', 'n is a multiple of 4, so every lane runs the loop the same number of times: no lane idles.', 'The usual slip: forgetting tid. Then every lane walks elements 0, 4, 8, … together, and 1–3, 5–7, … are never written.'],
    codex: ['utilization'], chapters: [{ chapter: 'lanes', step: 3, label: 'One memory port' }, { chapter: 'lanes', step: 4, label: 'Lanes against cores' }],
  },
  {
    id: 'p_reduce', act: 9, title: 'Reduction', kind: 'program', optional: true, requires: ['k_simt'], par: { cycles: 35, laneops: 114 },
    why: 'A sum\'s four partials must become one, so the lanes cannot stay busy to the end: 29% of the lane-steps idle on 4 words, 12% on 32. The SIMT core\'s mask keeps the spare lanes from doing work nobody needs.',
    tips: ['First each lane sums its strided share, all lanes busy.', 'Then combine through memory: lanes store their partial sums, fewer lanes add pairs.', 'Lane-ops count the work: every lane repeating the whole combine saves the tmc (a cycle) and masks no lane, but three of the four compute a sum nobody needs, 20 lane-ops a test. Mask them off.'],
    codex: ['reduction'], chapters: [{ chapter: 'simt', step: 5, label: 'What divergence costs' }],
  },
  // Phases 3 and 4 of the GPU track: warps and memory, then graphics.
  {
    id: 'k_coal', act: 9, title: 'Coalescer', kind: 'build', optional: true, requires: ['k_simd'], base: BUILDK.k_coal, par: { nand: 467, depth: 27 },
    why: 'Four memory ports are four memories; one port a line wide serves every lane whose word is in the line: 467 NANDs. The two-warp core keeps a port per lane and does not place it; chapter 32\'s access unit (5 870 NANDs) does.',
    tips: ['Drop each address’s two low bits: what is left (14 bits) names its line.', 'The leader is the lowest active lane, exactly as in your mask; a 4:1 bus mux picks its line.', 'Lane 0, when active, is the leader: it needs no comparator. Lanes 1–3: an equality comparator each, ANDed with their mask bit.', 'left = mask XOR served: served never contains an inactive lane.'],
    codex: ['coalescing'], unlocks: ['rv16_coal4'], chapters: [{ chapter: 'feed', label: 'One port, a line wide' }, { chapter: 'feed', step: 1, label: 'Coalescing' }],
  },
  {
    id: 'k_warps', act: 9, title: 'Two warps', kind: 'core', optional: true, requires: ['k_simt', 'k_coal'], base: BUILDK.k_warps, par: { nand: 29974, period: 95, cycles: 2093 },
    why: 'Memory answers late: here a cycle, in a GPU hundreds. A GPU switches warps instead of stalling. A warp is its state (PC, mask, stack, lane registers): +12 242 NANDs, 71% of them lane registers. The frame core starts here.',
    tips: ['Start from your SIMT core: fetch, decode, control and the lanes stay shared. Duplicate what is state: PC, mask, stack, lane registers.', 'The warp bit is a flip-flop that toggles every cycle (0 after reset); 2:1 muxes pick the issuing warp’s PC, register reads and mask.', 'A load: hold its lanes (mask · rwe) and rd for one cycle, then write drdata into the other warp’s registers. In any cycle each register file has one writer: its warp’s results, or the returning load.', 'bar: a waiting bit per warp. Arriving first sets yours, arriving second clears the other’s. A warp goes only if it is not held at bar (or the other has no lanes) and has lanes of its own; a PC moves only when its warp goes.'],
    codex: ['barrel', 'barrier', 'occupancy'], chapters: [{ chapter: 'warps', label: 'A memory that makes you wait' }, { chapter: 'warps', step: 4, label: 'Occupancy' }],
  },
  {
    id: 'p_hist', act: 9, title: 'Histogram', kind: 'program', optional: true, requires: ['k_warps'], par: { cycles: 176, laneops: 702 },
    why: 'No atomic add: two threads that update one counter lose a count. Privatize (128 words of counters), synchronize (bar), combine: 176 cycles, every lane busy. Real GPUs added atomics, chapter 32\'s amoadd.w.',
    tips: ['Thread t counts value v in the word 8·v + t: then bin b’s eight counters sit in a row, at 8·b.', 'Thread t takes elements t, t + 8, …: n is a multiple of 8, so every lane has the same number.', 'After bar, every thread adds up two bins: their sixteen counters are the words 16·tid … 16·tid + 15.', 'The warps take turns, so a kernel without bar can look right. The grader also lets warp 1 run ahead of warp 0.'],
    codex: ['privatization', 'barrier'], chapters: [{ chapter: 'feed', step: 3, label: 'A barrier' }, { chapter: 'feed', step: 4, label: 'Atomics' }],
  },
  {
    id: 'k_edge', act: 9, title: 'Edge stepper', kind: 'build', optional: true, requires: ['k_lesson'], base: BUILDK.k_edge, par: { nand: 963, period: 58 },
    why: 'The lanes could rasterize: chapter 34 measured 6 825 cycles for one triangle on 16 threads, against 1 268 on a rasterizer of 26 708 NANDs. The edge function is linear, so each step is one add: 963 NANDs an edge.',
    tips: ['Two 16-bit registers: E, and R, where the current band started (a band is four rows of pixels).', 'One adder / subtractor: its first operand is E, R (band) or 2E (double, a wired shift); its second a, 4a, b or 4b (wired shifts too); subtract only for up.', 'Load and band write R as well as E; hold writes neither.', 'inside: NOT of E\'s bit 15.'],
    codex: ['edgefn'], unlocks: ['rv16_edge'], chapters: [{ chapter: 'pixels', label: 'Pixels and triangles' }],
  },
  {
    id: 'k_tile', act: 9, title: 'Tile walk', kind: 'build', optional: true, requires: ['k_edge'], base: BUILDK.k_tile, par: { nand: 479, period: 26 },
    why: 'Scanning the bounding box wastes cycles on pixels no edge reaches. In 4 × 4 tiles one test rules 16 pixels in or out, and a serpentine inside keeps every step one pixel: 479 NANDs, run by the rasterizer.',
    tips: ['State: busy, a TEST flag, the pixel counter k (0 … 15) and the tile (tx, ty).', 'Column = k ÷ 4, row = k mod 4, reversed in odd columns: an XOR of k\'s low bits with bit 2.', 'A tile is done when its TEST fails or its last pixel (k = 15) is out; then: the next tile if tx ≠ tx1, the next band if ty ≠ ty1, else idle.', 'Every command is 0 while idle: gate them with busy.'],
    codex: ['tilewalk'], unlocks: ['rv16_tile'], chapters: [{ chapter: 'pixels', step: 2, label: 'Walking tiles' }],
  },
  {
    id: 'k_raster', act: 9, title: 'Rasterizer', kind: 'build', optional: true, requires: ['k_tile'], base: BUILDK.k_raster, par: { nand: 9188, period: 145, cycles: 7439 },
    why: 'The steppers need a start: A, B, the bias, the box in tiles, E at the first tile. E is a product and act 9 has no multiplier, so each stepper shift-adds its own: 9 188 NANDs, mostly adders, a device of the frame core.',
    tips: ['A, B, Δx = ox − xᵢ, Δy = oy − yᵢ: 8-bit subtractions (two 4-bit adders, the subtrahend inverted, carry in 1). ox = 16·tx0 + 2.', 'The first tile is the smallest (v + 1) >> 4 of the three vertices; the last the largest (v − 2) >> 4, 0 if negative. A comparison is an adder\'s carry.', 'E = A·Δx + B·Δy − bias, MSB first: E ← 0; E ← E − A·Δx₇ (the sign bit weighs −128); E ← E − B·Δy₇; then for bits 6 … 0: E ← 2E + (Δxₖ ? A : 0), E ← E + (Δyₖ ? B : 0); last E ← E − bias. Then load E into itself, so R starts there too.', 'The sum of the three E plus the three biases is twice the area: ≤ 0 is a back face, done.', 'The tile test: a second adder per edge, E + 12·(A⁺ + B⁺), its sign.'],
    codex: ['horner', 'shiftadd'], unlocks: ['rv16_raster'], chapters: [{ chapter: 'pixels', step: 1, label: 'Inside a triangle' }, { chapter: 'graphics', step: 3, label: 'Where the gates go' }],
  },
  {
    id: 'k_frame', act: 9, title: 'A frame', kind: 'core', optional: true, requires: ['k_raster', 'k_warps'], base: BUILDK.k_frame, par: { nand: 40275, period: 147, cycles: 7635 },
    why: 'A GPU in miniature: lanes place the vertices, the rasterizer fills the pixels, the screen is memory both write. The core reaches the rasterizer through addresses and must not race it: 40 275 NANDs. Spin runs on it.',
    tips: ['Start from your two-warp core; add the rasterizer, six 7-bit vertex registers and a 16-bit colour register, written from lane 0\'s port when its address is 0xFFF0 … 0xFFF6.', 'A store to 0xFFF6 sets a flip-flop that is the rasterizer\'s go in the next cycle; busy for the core is that flip-flop OR the rasterizer\'s busy.', 'Hold: busy AND (lane 0 is active, the instruction stores, address in 0xFFF0 … 0xFFF6, OR it loads and an active lane\'s address is in 0xF000 … 0xF3FF). AND its inverse into the warp\'s go: nothing of that instruction happens, and its next turn tries again.', 'Use the instruction\'s own signals for the hold, not the write enables it gates: those depend on go.'],
    codex: ['device', 'mmio'], chapters: [{ chapter: 'pixels', label: 'Pixels and triangles' }, { chapter: 'graphics', step: 1, label: 'The pipeline' }],
  },
  {
    id: 'p_spin', act: 9, title: 'Spin', kind: 'program', optional: true, requires: ['k_frame'], par: { cycles: 1432, laneops: 5282 },
    why: 'Everything at once: warp 0 turns the corners, eight threads clear, lane 0 draws. The clear is 462 of the reference\'s 577 cycles a frame. One screen and no depth buffer: the GPU chapters add both.',
    tips: ['Clearing is most of the work: give all eight threads a share, several stores per pass.', 'Lane i of warp 0 turns corner i; store each corner\'s screen position (64 + (x >> 8)) where lane 0 can load it.', 'Two bars per frame: after clearing and turning (lane 0 needs the corners and a clean screen), and after drawing (nobody clears a frame still being drawn).', 'On the hardware a load from the screen waits for the rasterizer: one before the clear makes the program right there too.'],
    codex: ['minsky', 'doublebuffer', 'zbuffer'], chapters: [{ chapter: 'graphics', step: 2, label: 'A spinning triangle' }, { chapter: 'graphics', step: 4, label: 'A faster clear' }],
  },
  // ---- Act 10 -------------------------------------------------------------------------------
  {
    id: 'm_lesson', act: 10, title: 'Where the cycles go', kind: 'lesson', optional: true, requires: ['c_computer'], body: 'memwall',
    why: 'Your computer\'s 64-word RAM is 20 166 of its 27 083 NANDs (74%), about 79 transistors a bit. Real memory is one transistor a bit: dense, slow, forgetful. This act builds it and prices what every core assumed.',
    tips: [], codex: ['memwall', 'rowbuffer', 'amat'], chapters: [{ chapter: 'dram', label: 'Inside a DRAM' }, { chapter: 'memctrl', label: 'A memory controller' }],
  },
  {
    id: 'm_sense', act: 10, title: 'A DRAM column', kind: 'build', optional: true, requires: ['m_lesson'], base: BUILDM.m_sense, par: { transistors: 34 },
    gives: ['drambit', 'blcap', 'dramsa', 'vhalf', 'wdrv'],
    why: 'A DRAM bit is 25 fF on a 100 fF line: a read moves the line by a tenth of the supply and leaves the cell at that level. The column turns it into a bit and restores the charge: 34 transistors. A row of them is a row buffer.',
    tips: ['Precharge: one NMOS from VDD/2 to the bit line, gate pre. A second NMOS between the two lines (the equalizer) gives the reference line VDD/2 too.', 'Both lines need the bit line capacitance: the amplifier compares their levels, and a line with no capacitance has no level to keep once pre falls.', 'Cells and the write driver hang on the bit line; the amplifier and the driver span both lines. Nothing else touches the reference line.', 'q can be the bit line itself: once the amplifier has fired it sits at a rail.'],
    codex: ['senseamp'], unlocks: ['rv16_dramcol'], chapters: [{ chapter: 'dram', step: 2, label: 'The sense amplifier' }],
  },
  {
    id: 'm_bank', act: 10, title: 'A bank with refresh', kind: 'build', optional: true, requires: ['m_sense'], base: BUILDM.m_bank, par: { nand: 319, period: 30, cycles: 5917 },
    why: 'An open row\'s words are a cycle away; another row costs a close and an open, and every row leaks. 319 NANDs keep the open row and refresh, the 1970s way: between a cache\'s miss port and the cell array.',
    tips: ['State: is a row open, which one, the next row to refresh, and a counter of the cycles since the last refresh.', 'A request hits when a row is open and it is the request\'s row: RW, busy = 0. Otherwise PRE if a row is open, else ACT the request\'s row; busy = 1.', 'A refresh is just ACT of the refresh row (after a PRE if needed): leave that row open, the next request may want it. 16 rows in 288 cycles: one refresh every 18 cycles is enough.', 'Refresh early when nobody is asking (the timer past 8), and force it when it is due (15), ahead of any request.'],
    codex: ['refresh', 'rowhammer', 'ecc'], unlocks: ['rv16_bank'], chapters: [{ chapter: 'dram', step: 3, label: 'Leaks and refresh' }, { chapter: 'dram', step: 4, label: 'Rows, columns, banks' }],
  },
  {
    id: 'm_ctrl', act: 10, title: 'Row-buffer controller', kind: 'build', optional: true, requires: ['m_bank'], base: BUILDM.m_ctrl, par: { nand: 779, period: 36, cycles: 10690 },
    why: 'Your bank refreshed its rows itself; a DDR chip does that on REF but sets rules: tRCD, tCAS, tRAS, tRP. The controller issues each command at the earliest legal cycle: 779 NANDs against the bank\'s 319. RV32 computers put one behind their caches.',
    tips: ['Per bank: an open flag and the open row. Counters of the cycles since the last ACT and since the last PRE, saturating at 15, cover tRCD, tRAS and tRP when one request is in flight at a time.', 'A read\'s data comes tCAS = 4 cycles after its RD: a 4-stage shift register of "RD issued" says when to raise ready, and that no command is needed meanwhile.', 'Refresh: count cycles since the last REF and make it pending well before 256 (128 is a bit test). Pending goes first: PREA once tRAS allows, then REF once tRP allows.', 'After REF nothing may happen for tRFC = 12 cycles: remember that the last close was a REF, and wait 12 instead of 4.'],
    codex: ['dramtiming', 'pagepolicy'], unlocks: ['rv16_dramctrl'], chapters: [{ chapter: 'memctrl', step: 0, label: 'Commands' }, { chapter: 'memctrl', step: 1, label: 'Open page or closed page' }, { chapter: 'memctrl', step: 2, label: 'Refresh' }],
  },
  {
    id: 'o_cache', act: 10, title: 'A cache', kind: 'build', optional: true, requires: ['m_ctrl'], base: BUILD9.o_cache, par: { nand: 3497, period: 36 },
    why: 'Your controller answers tCAS = 4 cycles after a read on the open row, tRP + tRCD + tCAS = 12 on another; every core assumed one. A small memory of recent words, a tag and a valid bit each, answers most at once: 3 497 NANDs.',
    tips: ['Two small RAMs indexed by addr[2:0]: one for the data, one for {valid, tag}.', 'hit = valid AND (stored tag = addr[7:3]): a 5-bit equality comparator.', 'Write the line when wr, or when rd and not hit; its data is wdata on a write, mdata on a fill.', 'At power-on every valid bit is 0: nothing hits until it is filled.'],
    codex: ['cache', 'threecs', 'assoc', 'writepolicy'], chapters: [{ chapter: 'cache', step: 6, label: 'A direct-mapped cache' }, { chapter: 'memctrl', step: 3, label: 'The CPU behind it' }],
  },
  {
    id: 'm_bus', act: 10, title: 'Two masters, one bus', kind: 'build', optional: true, requires: ['m_lesson'], base: BUILDM.m_bus, par: { nand: 282, period: 26 },
    why: 'A DMA engine, a display, a second core want memory too. A bus shares one set of wires, one transfer at a time, with a handshake and a fair arbiter: 282 NANDs, 196 of them the muxes that move the words.',
    tips: ['Three flip-flops of state: who was served last, whether a transfer is in progress, and whose it is.', 'The grant: while a transfer is in progress, its owner; else if both ask, the one not served last; else whoever asks.', 'Two 16-bit muxes take the granted master\'s address and data to every slave; the top two address bits pick whose valid rises, and the same bits pick whose ready and data come back.', 'A transfer is done when the granted master\'s valid and the chosen slave\'s ready are both 1: only that master sees ready.'],
    codex: ['handshake', 'arbitration', 'atomics', 'ordering'], unlocks: ['rv16_bus'], chapters: [{ chapter: 'bus', step: 0, label: 'A handshake' }, { chapter: 'bus', step: 2, label: 'Two masters' }],
  },
  {
    id: 'm_dma', act: 10, title: 'DMA engine', kind: 'build', optional: true, requires: ['m_bus'], base: BUILDM.m_dma, par: { nand: 1366, period: 48, cycles: 2079 },
    why: 'Copying costs a processor two bus transfers a word. A DMA engine copies as a second master and interrupts when done: 1 366 NANDs. A 64-word table summed straight from flash takes 845 cycles, copied by DMA first 595.',
    tips: ['Registers: src, dst, a count, and the word in flight; flip-flops for running, read or write, and irq.', 'Count with an incrementer: load NOT len and add 1 per word; the incrementer\'s carry (all ones) means nothing is left, len = 0 included.', 'One request at a time: valid while running and not done, the address src in the read phase and dst in the write phase. When ready: a read latches mq and turns to writing; a write steps src, dst and the count and turns to reading.', 'Hold everything while ready is 0: the address and data come straight from registers that change only when ready.'],
    codex: ['dma', 'coherence'], unlocks: ['rv16_dma'], chapters: [{ chapter: 'bus', step: 3, label: 'DMA' }],
  },
  {
    id: 'm_flash', act: 10, title: 'Flash page store', kind: 'build', optional: true, requires: ['m_lesson'], base: BUILDM.m_flash, par: { nand: 1049, period: 38, cycles: 7844 },
    why: 'Flash keeps data without power but cannot overwrite: a page is written once per erase of its whole block. A page store writes somewhere new each time and keeps a map, as every SSD does: 1 049 NANDs.',
    tips: ['Write as a log: a head pointer to the next erased page, a table of 8 entries saying where each logical page lives. A write programs the head (with the logical page number as its tag), points the entry there, and moves the head.', 'Keep one block erased ahead of the head. When the head enters a new block, collect the block after it: read each page; if the table still points at it (its tag says whose it was), program it at the head and repoint the entry; then erase the block.', 'Update the table and the head when you issue the program, not when it finishes: fq shows the read page only until the next command.', 'A small state machine: idle, waiting on a read or a program, and the collector\'s read, copy and erase. While fbusy is 1 issue nothing.'],
    codex: ['ftl', 'wearlevel'], unlocks: ['rv16_flashstore'], chapters: [{ chapter: 'flash', step: 3, label: 'Never overwrite' }, { chapter: 'flash', step: 4, label: 'Garbage, wear and bad blocks' }],
  },
  {
    id: 'p_boot', act: 10, title: 'Boot from flash', kind: 'program', optional: true, requires: ['m_dma', 'm_flash'], par: { size: 18, cycles: 253 },
    why: 'The table is in flash, 8 stall cycles a load. Let the DMA engine copy and work meanwhile: waiting for the copy takes 595 cycles on 64 words, summing each word as it lands 470.',
    tips: ['Loading the table straight from flash works: 8 stall cycles a word. The DMA copies a word every 4.', 'Simplest: start the copy, wait until 0xFFF9 reads 1, clear it, then sum the copy in RAM.', 'Faster: don\'t wait for the whole copy. The bench\'s engine, unlike your m_dma, lets you read its count: a load from 0xFFF2 gives the words left, so you know how many have landed. Sum each one as soon as it is there.', 'RV16 is word addressed and its offsets reach −32 … 31: the device registers are -16(x0) … -13(x0), irq is -7(x0), OUT is -3(x0).'],
    codex: ['boot'], chapters: [{ chapter: 'bus', step: 4, label: 'A computer on one bus' }],
  },
];

export const nodeById = (id: string): CampaignNode | undefined => NODES.find((n) => n.id === id);
