// Appendix A: the MOS 6502 of 1975, at transistor level, built the way it was built then.

import { BUS_LINE, MS_BIT } from '../lib/m6502/demo';
import { NNOR2 } from '../lib/nmos';
import { SwitchSim } from '../sim/switchsim';
import { m6502Scene } from '../widgets/m6502';
import { opcodeMatrix } from '../widgets/m6502isa';
import { ledger } from '../widgets/m6502ledger';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

/**
 * The clock stops for a while: every node held only by its charge (a latch's gate while its pass
 * transistor is off) leaks to 0. Driven nodes come straight back; stored bits do not.
 */
function leak(stage: Stage): void {
  const sim = stage.sim;
  if (!(sim instanceof SwitchSim)) return;
  stage.checkpoint();
  const v = sim.snapshot();
  for (const n of sim.design.caps) v[n] = 0;
  sim.restore(v);
  sim.settle();
  stage.refresh();
}

/** φ1 and φ2 over three cycles: never high together, a gap at every edge (drawn: the switch-level solver has no time axis). */
const PHASES = (() => {
  const wave = (y: number, first: boolean) => {
    let d = `M0,${y + 14}`;
    for (let k = 0; k < 6; k++) {
      const x = k * 40, hi = (k % 2 === 0) === first;
      d += hi ? ` H${x + 4} V${y} H${x + 36} V${y + 14}` : ` H${x + 40}`;
    }
    return `<path d="${d}" />`;
  };
  return `<svg class="m65-phases" viewBox="-28 -4 276 52" role="img" aria-label="φ1 and φ2: never high at the same time">
    <text x="-26" y="12">φ1</text><text x="-26" y="40">φ2</text>
    <g class="p1">${wave(0, true)}</g><g class="p2">${wave(28, false)}</g></svg>`;
})();

const DATAPATH = ['rega', 'regx', 'regy', 'regs', 'alu', 'pc', 'addr', 'data', 'flags', 'buses'];
const CONTROL = ['clock', 'decode', 'control', 'timing', 'intr', 'ir'];

/**
 * The ledger's counts (widgets/m6502ledger.ts measures them when it opens: too slow to build the RV32I here).
 * tests/content-mem.test.ts measures the same parts and holds these to them.
 */
export const LEDGER = {
  /** Transistors: our 6502, our single-cycle RV32I with its memories (rounded as the text quotes them). */
  m6502: 4500, rv32i: 226000,
  /** % of the RV32I's transistors: register file + data memory + program ROM; register file + data memory alone. */
  storePct: 90, rfDmPct: 76,
  /** Transistors per bit: a 6502 register bit, a bit of the RV32I's register file (with its read multiplexers' share). */
  bit6502: 10, bitRf: 90,
} as const;
const k = (n: number) => n.toLocaleString('en-US');

export const chAppendix6502: Chapter = {
  id: 'appendix-6502', num: 37, appendix: 'A', title: '1975: the 6502', level: 'NMOS',
  blurb: 'NMOS, two clock phases, precharged buses, a decode PLA: the 6502 at transistor level, its ISA, and why our RV32I is 50 times bigger.',
  goals: [
    'count the transistors of an NMOS ratioed gate against its CMOS twin (n + 1 against 2n) and say what the saving costs in power',
    'store a bit with two non-overlapping phases, a pass transistor and gate charge, and say why the NMOS 6502 has a minimum clock frequency',
    'move a byte over a precharged bus, and say why two sources enabled at once give the AND of their bits',
    'account for the fifty-fold transistor gap between our 6502 and our single-cycle RV32I',
  ],
  builds: ['nand', 'latches', 'cpu'],
  recap: {
    keep: [
      'NMOS ratioed logic: enhancement pull-downs under one always-on depletion load. An n-input NOR is <strong>n + 1</strong> transistors (CMOS: 2n), and while its output is 0 it draws current all the time.',
      'Two phases φ1 and φ2, never high together, make a latch of one pass transistor and the charge on an inverter\'s gate: a master–slave bit is <strong>6 transistors</strong>, against 44 for our NAND flip-flop. The charge leaks in milliseconds, so the NMOS 6502 cannot stop its clock.',
      'Four precharged buses (DB, SB, ADL, ADH): every line is charged to 1 in φ2, and a source pulls its 0 bits down in φ1. A source costs 2 transistors per bit, a destination 1, and two sources at once give the AND, with no contention.',
      'Control is a ring of T states, the opcode in IR and a decode PLA: 245 computed rows here, about 130 on the real chip. T1 fetches the next opcode while its rows finish the previous instruction.',
      `About ${k(LEDGER.m6502)} transistors against about ${k(LEDGER.rv32i)} for our single-cycle RV32I: ${LEDGER.storePct} % of the RV32I is storage built from logic (register file and data memory ${LEDGER.rfDmPct} %, program ROM ${LEDGER.storePct - LEDGER.rfDmPct} %), and NAND-only static CMOS, 32 bits and separate adders in a single cycle make every part of it dearer.`,
    ],
    practise: ['t_nor', 's_dff'],
    check: [
      {
        question: 'An NMOS gate\'s output sits at 0. What current flows?',
        options: ['A steady current from VDD through the depletion load and the conducting pull-downs to GND', 'None once the output has settled: power is drawn only while it switches', 'A steady current into the gates of the stages it drives'],
        answer: 0,
        explain: 'The depletion load always conducts, and the pull-downs win only because they are stronger (ratioed logic). While the output is 0 both conduct, computing or not: a whole NMOS chip dissipated a few hundred milliwatts.',
        why: ['', 'That is CMOS, where one of the two networks is always off. In NMOS the load never turns off.', 'A MOSFET gate is insulated: current flows into it only while its charge changes.'],
      },
      {
        question: 'In one φ1, two sources are enabled onto the same precharged bus line: one with bit 1, one with bit 0. The line reads:',
        options: ['0: the AND of the two bits', '1: the OR of the two bits', 'X: two drivers in contention', 'Whichever bit was enabled first'],
        answer: 0,
        explain: 'A source pulls its line down only where its bit is 0; a 1 leaves the precharge alone. One 0 is enough to drain the line, so the line carries the AND.',
        why: ['', 'A 1 does nothing on a precharged line: only a 0 acts, by pulling it down.', 'Nothing drives the line high in φ1: the precharge happened in φ2, so a pull-down meets only stored charge.', 'Order does not matter: a 1 leaves the charge alone and a 0 drains it, whenever it arrives.'],
      },
      {
        question: 'Where do most of the extra transistors of our single-cycle RV32I go, compared with our 6502?',
        options: ['Storage built from logic: the register file, the data memory and the program ROM', 'Decoding a harder instruction set', 'More instructions than the 6502\'s 56'],
        answer: 0,
        explain: `${LEDGER.storePct} % of the RV32I is storage, ${LEDGER.rfDmPct} % in the register file and data memory alone. The 6502 keeps three 8-bit registers and leaves memory off the chip; its registers are ${LEDGER.bit6502} transistors a bit against about ${LEDGER.bitRf} for the RV32I's register file.`,
        why: ['', `Decoding is not where the transistors go: storage alone is ${LEDGER.storePct} % of the RV32I.`, 'RV32I has fewer instructions than the 6502. The gap comes from storage, width (32 bits against 8) and technology.'],
      },
    ],
  },
  steps: [
    {
      title: 'One transistor less: NMOS',
      body: `
        <p>In 1975 CMOS existed (RCA's CD4000 logic from 1968, its 1802 CPU in 1976) but was slower and less dense; a dense, fast,
        cheap microprocessor was NMOS. A gate was a pull-down network of
        <span data-show="n0 n1">enhancement NMOS</span> under one <span data-show="ld"><strong>depletion-mode</strong> NMOS</span>: its threshold is below zero, so with its
        gate tied to its source it always conducts, weakly. It is a load resistor that costs one transistor.</p>
        <p>Any pull-down that conducts beats the load (the pull-downs are drawn several times stronger: <em>ratioed
        logic</em>), so the output is 0 when some path to GND conducts and 1 otherwise. An n-input NOR is
        <strong>n + 1</strong> transistors instead of CMOS's 2n: this NOR2 is 3, a CMOS NOR2 is 4.</p>
        <p>The price is power. While the output is 0, current flows from VDD through the load to GND, all the time,
        computing or not: a whole NMOS chip dissipated a few hundred milliwatts. Designers favoured NOR, whose
        pull-downs are in parallel; a NAND's series pull-downs must each be wider to keep the ratio.</p>
        <div class="try">Set both inputs to 0 and open the load (<code>ld</code>): the depletion transistor is drawn
        with a solid channel and its gate tied to its source.</div>`,
      scene: () => ({ root: NNOR2, inputs: { a: 1, b: 0 } }),
      tries: [(st) => st.getInput('a') === 0 && st.getInput('b') === 0],
      challenge: {
        kind: 'quiz', question: 'How many transistors does an NMOS NAND of 4 inputs take, and how many does a CMOS one?',
        options: ['5 and 8', '8 and 8', '4 and 8', '5 and 4'], answer: 0,
        why: ['', 'NMOS has no pull-up network to mirror the pull-downs: one depletion load replaces all four PMOS.', 'The output still needs something to pull it up when the series chain is off: the depletion load is the fifth transistor.', 'CMOS needs a complementary PMOS for every NMOS: four of each.'],
        explain: 'Four pull-downs in series plus one depletion load: 5. CMOS needs a PMOS for every NMOS: 8.',
      },
    },
    {
      title: 'Two phases, no flip-flops',
      body: `
        <p>The 6502 runs on two clocks that are never high together, <strong>φ1</strong> and <strong>φ2</strong>.
        It makes them itself from one input, φ0, so that each starts only after the other has fallen.</p>
${PHASES}
        <p>With two such phases, a latch is a single pass transistor feeding an inverter's gate. While its phase is
        high it copies its input; when the phase falls, the charge left on the gate <em>is</em> the bit. Two of them
        on opposite phases (<span data-show="master">master</span> on φ1, <span data-show="slave">slave</span> on φ2)
        make a master–slave bit from <strong>6 transistors</strong> (4 + 2 loads), never transparent
        end to end. Our NAND master–slave flip-flop costs 44.</p>
        <p>The catch: charge leaks away in milliseconds. The NMOS 6502 has a minimum clock frequency: stop φ0 and its
        dynamic latches forget. It has a <code>RDY</code> pin for pausing instead.</p>
        <div class="try">Set <code>d</code>, raise and drop <code>p1</code>, then raise and drop <code>p2</code>: the bit
        reaches <code>q</code> one phase at a time. Then press <b>Stop the clock for 10 ms</b>.</div>`,
      scene: () => ({ root: MS_BIT, inputs: { d: 1, p1: 0, p2: 0 } }),
      actions: [{ label: 'Stop the clock for 10 ms', run: leak }],
      challenge: {
        kind: 'reach', goal: 'Store a 1 so that q = 1 with both phases low.',
        check: (st) => st.value('q') === 1 && st.value('p1') === 0 && st.value('p2') === 0 && st.value('d') === 0,
        hints: [
          'A bit enters the master while p1 is high and reaches the slave while p2 is high. q follows only the slave.',
          'Once p1 falls, the master\'s gate charge holds the bit whatever d does next; the slave does the same from the master once p2 falls.',
        ],
        answer: 'd = 1, pulse p1 (the master takes it), pulse p2 (the slave shows it), then d = 0: q stays 1 until the next pair of phases.',
        solve: (st) => { st.setInputs({ d: 1, p1: 1 }); st.setInputs({ p1: 0 }); st.setInputs({ p2: 1 }); st.setInputs({ p2: 0, d: 0 }); },
      },
    },
    {
      title: 'Precharged buses',
      body: `
        <p>Inside the 6502, bytes move on four buses: <code>DB</code> (data), <code>SB</code> (special),
        <code>ADL</code> and <code>ADH</code> (address low and high). None has a driver of its own. During φ2 a
        <span data-show="pre">transistor from VDD</span> <strong>precharges</strong> every line to 1. During φ1 a source whose bit is 0 pulls
        its line down through <span data-show="ena va enb vb">two series pull-downs</span> (enabled, and bit = 0); a bit that is 1 does nothing, and the
        line keeps its charge.</p>
        <p>So a source costs 2 transistors per bit, and two sources enabled at once give the <strong>AND</strong> of
        their bits, no contention. A destination is <span data-show="pass">one pass transistor</span> per bit, into a
        <span data-show="i1 i2">storage node and its inverters</span>. Pass transistors also join buses:
        the 6502 links SB to DB, or to ADH, in the same phase.</p>
        <p>The line holds more charge than any storage node it meets, so when a pass transistor connects the two,
        the line's value wins (charge sharing). The simulator decides such meetings by capacitance, as the silicon does.</p>`,
      scene: () => ({ root: BUS_LINE, inputs: { p2: 1, en_a: 0, a: 1, en_b: 0, b: 1, ld: 0 } }),
      challenge: {
        kind: 'reach', goal: 'With a = 1, store b = 0 in q through the bus.',
        check: (st) => st.value('q') === 0 && st.value('a') === 1 && st.value('b') === 0 && st.value('ld') === 0,
        hints: [
          'Only the precharge pulls the line up, and only a source\'s 0 pulls it down. Begin from a charged line.',
          'p2 = 1 charges the bus. A source acts only while its enable is 1 and its bit is 0. ld opens the pass transistor into the storage node behind q, which keeps what it held when ld fell.',
        ],
        answer: 'p2 = 1 then 0 (precharge, then let go), en_b = 1 (b pulls the line to 0), ld = 1 then 0 (q takes it). Enabling a as well changes nothing: 1 AND 0 = 0.',
        solve: (st) => {
          st.setInputs({ p2: 1, b: 0 }); st.setInputs({ p2: 0 }); st.setInputs({ en_b: 1 }); st.setInputs({ ld: 1 }); st.setInputs({ ld: 0, en_b: 0 });
        },
      },
    },
    {
      title: 'The datapath',
      body: `
        <p>Inside our 6502's datapath, every block hangs on the <span data-show="buses">four buses</span>.
        <span data-show="rega"><code>A</code></span> drives SB and DB, <span data-show="regx regy"><code>X</code> and
        <code>Y</code></span> drive SB, the <span data-show="regs">stack pointer <code>S</code></span> drives SB and ADL; each loads from
        SB. A register bit is a storage node refreshed in φ2, loaded in φ1, driving its buses: 10 transistors, against
        about 90 for a bit of our RV32I's register file.</p>
        <p>The <span data-show="alu"><strong>ALU</strong></span> has two input latches (AI from SB or 0; BI from DB, NOT DB or ADL), a ripple adder
        whose carry into bit 4 and out of bit 7 is forced at ten in decimal mode, AND / OR / EOR / shift right, and an
        output latch <code>ADD</code> that drives ADL directly and SB through the <strong>decimal corrector</strong>
        (+6 per nibble after a decimal ADC, −6 after SBC). There is one adder: index arithmetic, the stack pointer's
        steps, branch targets and ADC all take turns on it, one per cycle.</p>
        <p>The <span data-show="pc"><strong>PC</strong></span> has its own incrementer. The <span data-show="addr">address
        register</span> drives the pins A0–A15 for the whole cycle; <span data-show="data"><code>DL</code> (the data latch)</span>
        catches the byte read at the end of φ2, <code>DOR</code> (the data output register) holds the byte to write.
        Constants ($00 / $01 on ADH, the vectors on ADL) are a few pull-downs on the precharged lines.</p>
        <div class="try">Open any block: a register is eight bit cells, a bit cell a storage node, its refresh and its
        bus drivers, each down to transistors.</div>`,
      scene: () => m6502Scene({ path: ['dp'], highlight: DATAPATH }),
    },
    {
      title: 'Timing and the decode PLA',
      body: `
        <p>Control is three things. The <span data-show="timing"><strong>timing</strong></span> block is a ring of T states (T1 … T7), one per cycle
        of an instruction, returning to T1 at its last cycle, early when a page is not crossed or a branch not taken.
        <span data-show="ir"><code>IR</code></span> (the instruction register) holds the opcode, loaded at the end of the fetch.</p>
        <p>The <span data-show="decode"><strong>decode PLA</strong></span> turns IR and T into control signals: each row is a NOR over complemented
        literals (an AND of opcode bits and one T line), each signal a NOR of rows. Ours is computed: for every signal
        and cycle, the opcodes that need it are minimized, with the 105 undocumented opcodes free. That gives 245 rows;
        the real chip, tuned by hand with more of the work in random logic, has about 130. The free opcodes are why
        undocumented 6502 opcodes do something: their rows fire wherever minimization put them.</p>
        <p>While T1 fetches an opcode, IR still holds the previous one, so T1's rows finish the previous instruction: a
        load moves DL into its register, an ADC adds (writing A a cycle later). That overlap is how LDA # fits in two
        cycles. <span data-show="control"><strong>Control lines</strong></span> qualify the PLA's outputs by
        <span data-show="clock">φ1</span>, or latch them in φ1 so they hold through φ2, while the T state and IR change.</p>`,
      scene: () => m6502Scene({ path: ['ctrl'], highlight: CONTROL }),
    },
    {
      title: 'The instruction set',
      body: `
        <p>56 instructions, 151 opcodes, 13 addressing modes. Three registers of 8 bits (A, X, Y), a stack pointer
        into page 1 ($0100–$01FF), the flags N V D I Z C, a 16-bit PC; vectors at $FFFA (NMI), $FFFC (RESET),
        $FFFE (IRQ, BRK).</p>
        <p>Most opcodes follow a pattern <code>aaa bbb cc</code>: cc picks the group, aaa the operation, bbb the
        addressing mode, which is why the matrix has columns of one mode. Zero page (one-byte addresses) is the
        6502's register file in memory: 3 cycles to read it, 4 for an absolute address.</p>
        <p>Every cycle is a bus access, the dummy ones included: a read of the next byte after an implied
        instruction, the old value written back by a read-modify-write, a read at the wrong page while an index's
        carry is fixed. Our transistors make exactly these: on all 1.51 million cases of Tom Harte's SingleStepTests for the
        151 documented opcodes (10 000 each) and all 96 million cycles of Klaus Dormann's functional test, every bus cycle matches a
        reference model.</p>
        <details class="deeper"><summary>Deeper: quirks</summary>
        <p><code>JMP ($xxFF)</code> takes the pointer's high byte from $xx00, not from the next page: the indirect address's low byte is
        incremented without a carry into the high byte (fixed in the CMOS 65C02). <code>BRK</code> shares the IRQ vector at $FFFE; the
        handler tells them apart by the B bit of the status byte pushed on the stack (a flag that exists only there), and BRK skips the
        byte after it. The NMOS chip leaves the D flag set on an interrupt, and its N, V and Z after a decimal ADC are not those of the
        decimal result. The earliest chips (1975–76) shipped without a working <code>ROR</code>. And the 105 undocumented opcodes do
        whatever the PLA's rows make of them; programs came to rely on some (LAX, SAX), and the 65C02 turned them into NOPs or new instructions.</p></details>`,
      widget: () => opcodeMatrix(),
    },
    {
      title: 'The 6502 running',
      body: `
        <p>The whole chip at transistor level, a memory on its pins. Each <b>Cycle</b> is <span data-show="pin:p1">φ1</span>
        (the address goes out, buses are driven, <span data-show="dp.alu">the ALU</span> computes) then
        <span data-show="pin:p2">φ2</span> (memory answers, DL and <span data-show="ctrl.ir">IR</span> latch, the T state advances).
        <b>Instr</b> runs to the next opcode fetch.</p>
        <p>The panel keeps a reference model of the 6502 in lock-step and compares <strong>every bus cycle</strong>:
        <span data-show="pin:a pin:d pin:rw pin:sync">address, data, R/W and SYNC</span> (high while an opcode is
        fetched). The pin trace is what a logic analyser on the real chip would show.</p>
        <div class="try">Step through <code>LDA msg,X</code>: three operand fetches, then the read, and the next
        opcode fetch is where A changes. Try the <code>irq</code> program and press <b>IRQ</b>.</div>
        <p>About ${k(LEDGER.m6502)} transistors switch in an event-driven simulation: thousands of cycles a second, where the
        silicon did a million.</p>`,
      scene: () => m6502Scene({}),
    },
    {
      title: 'The transistor ledger',
      body: `
        <p>Our 6502: about ${k(LEDGER.m6502)} transistors. Our single-cycle RV32I: about ${k(LEDGER.rv32i)}, ${Math.round(LEDGER.rv32i / LEDGER.m6502)} times more. Where does it go?</p>
        <p><strong>Memory.</strong> ${LEDGER.storePct} % of the RV32I is storage built from logic: a 32 × 32 register file and
        32 words of data memory (${LEDGER.rfDmPct} % between them), and the program ROM. The 6502 keeps 3 registers and leaves memory off the chip.</p>
        <p><strong>Technology.</strong> NAND-only static CMOS against NMOS with dynamic latches and pass transistors:
        the table compares the same function in each, measured from both libraries.</p>
        <p><strong>Width and time.</strong> 32 bits against 8, and a single cycle that needs separate adders for the ALU,
        PC + 4 and the branch target, where the 6502 spends several cycles on one adder.</p>
        <p>None of the RV32I's choices are wrong: it is built from one brick so that every bit can be opened. The 6502
        shows what a 1975 team did to fit a CPU on one small, cheap die: it sold for $25, where Intel's 8080 had launched at $360.</p>
        <details class="deeper"><summary>Deeper: the people and the family</summary>
        <p>Chuck Peddle and Bill Mensch had worked on Motorola's 6800; with a few colleagues they left for MOS Technology in 1974 to
        build a far cheaper CPU. Their first, the 6501, fitted the 6800's socket; Motorola sued, and MOS dropped the 6501 and kept the
        6502, whose pins differ. MOS sold it with the KIM-1 board (1976); Commodore bought MOS that year. The family went everywhere:
        the Apple I and II, the Commodore PET and VIC-20, the C64 (its 6510 adds an I/O port), the BBC Micro, the Atari 2600 (a 6507:
        28 pins, 13 address lines, 8 KiB of address space) and the NES (Ricoh's 2A03: a 6502 without decimal mode, with the sound on
        the die). Mensch founded the Western Design Center, whose CMOS 65C02 and 16-bit 65C816 (Apple IIGS, Super NES) are still
        made.</p></details>`,
      widget: () => ledger(),
    },
  ],
};

