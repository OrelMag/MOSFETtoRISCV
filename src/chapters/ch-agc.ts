// Appendix F: the Apollo Guidance Computer (Block II), from its one gate up: the RTL NOR3 (lib/agcnor.ts), an adder
// and a register built of nothing else, the one's-complement end-around carry, core rope (agc/rope.ts, the weave widget,
// the rope model) and the instruction set on the golden model (agc/iss.ts, checked against yaAGC in CI:
// scripts/agc/oracle.ts). Sources: R-700, E. C. Hall, "MIT's Role in Project Apollo", vol. III, "Computer Subsystem"
// (Charles Stark Draper Laboratory, August 1972), cited by printed page; K. Shirriff, "Software woven into wire"
// (righto.com, 2019) for the rope's cores.

import { assembleAgc } from '../agc/asm';
import { AgcISS } from '../agc/iss';
import { BLOCK2_ROPE } from '../agc/rope';
import { NOR3_RTL, NOR_ADD4, NOR_BASIC, NOR_FA, NOR_REG, NOR_REG4 } from '../lib/agcnor';
import { FULL_ADDER } from '../lib/combinational';
import { groupNum } from '../sim/numfmt';
import { stats } from '../sim/stats';
import { AGC_SUM_SOURCE, MCT_US, agcRunWidget } from '../widgets/agcrun';
import { rope3d } from '../widgets/rope3d';
import { ropeWeaveWidget } from '../widgets/ropeweave';
import { numOf } from './order';
import type { Chapter } from './types';

/** NOR3 gates in the chapter's circuits (tests/content-agc.test.ts holds the prose to them). */
export const AGC_NOR = {
  basic: stats(NOR_BASIC).nor3!, fa: stats(NOR_FA).nor3!, add4: stats(NOR_ADD4).nor3!, reg: stats(NOR_REG).nor3!, reg4: stats(NOR_REG4).nor3!,
  faNands: stats(FULL_ADDER).nands,
};
/** The chapter's program on the golden model: instructions and memory cycles to the halt, and the sum it leaves. */
export const AGC_SUM_RUN = (() => {
  const p = assembleAgc(AGC_SUM_SOURCE), m = new AgcISS(p.fixed);
  m.run(10_000);
  return { instrs: m.steps, mct: m.mct, sum: m.e[p.symbols.get('SUM')!] };
})();

const us = (mct: number) => (mct * MCT_US).toFixed(1);

export const chAppendixAgc: Chapter = {
  id: 'appendix-agc', num: numOf('appendix-agc'), appendix: 'F', title: 'The Apollo Guidance Computer', level: 'NOR gates, Apollo',
  blurb: 'The computer that flew to the Moon, from its one gate up: a three-input NOR in resistor-transistor logic, an adder and a register built of nothing else, one\'s complement with its end-around carry, a program woven into wire, and the instruction set on a model checked against Virtual AGC.',
  goals: [
    'build NOT, OR, AND, a full adder and a register from a three-input NOR, and count what each costs',
    'add in one\'s complement with an end-around carry, and say why the carry ring must be cleared',
    'read a word out of core rope, and say what changing a program in it takes',
    'run an AGC program instruction by instruction and price it in memory cycles',
  ],
  builds: ['tubes', 'binary', 'gates', 'adders', 'registers', 'memory', 'multicycle'],
  recap: {
    keep: [
      'The AGC\'s logic is one circuit, a three-input NOR in resistor-transistor logic, two to a package in Block II: about 5600 gates (R-700 Table 2-1). Everything else, adder and registers included, is built from it.',
      'Words are 15 bits in one\'s complement, so there are two zeros; the adder adds the carry out of the top bit back into the bottom one. A ring of carries can hold a carry nothing generates, so it has to be cleared.',
      `Core rope stores a 1 where a sense wire threads a core and a 0 where it passes by: each core holds ${BLOCK2_ROPE.wordsPerCore} words, and changing the program means weaving a new rope.`,
      `A memory cycle (MCT) is ${MCT_US} µs; most instructions take two, a multiply three after its EXTEND.`,
    ],
    practise: ['nor_basic', 'nor_fa', 'nor_reg'],
    check: [
      {
        question: 'In one\'s complement on 4 bits, what is 0101 + 1010, and why?',
        options: ['1111, −0: no bit generates a carry, so none comes round', '0000, +0: the carry comes round and wraps', '1111 + a carry out', 'It depends on the inputs before'],
        answer: 0,
        explain: '5 + (−5): every column has exactly one 1, so every bit propagates and none generates. With the carries cleared first, the sum is 1111, the negative zero, which is what the AGC\'s programs expect.',
        why: ['', 'That is the answer the ring gives when a stray carry is left circling: the reason for clearing it.', 'No column generates a carry, so there is none to come out.', 'It does in a ring that is not cleared: that is the bug the clear removes.'],
      },
      {
        question: 'How is a 0 stored in core rope?',
        options: ['The sense wire for that bit passes outside the core', 'The core is magnetized the other way', 'The core is left out of the rope', 'The sense wire carries no current'],
        answer: 0,
        explain: 'Reading switches one core, and every sense wire threaded through it sees a pulse. A wire routed around the core sees none: a 0. The data is in the wiring, fixed when the rope is woven.',
        why: ['', 'That is how erasable core memory stores a bit; rope cores all switch the same way.', 'Every core is there: each holds 12 words, a 0 in one is a 1 in another.', 'Sense wires carry no current until a core switches; the pattern of threading is what differs.'],
      },
      {
        question: `An AD takes 2 memory cycles. How long is that?`,
        options: [`${us(2)} µs`, `${MCT_US} µs`, '2 µs', `${us(4)} µs`],
        answer: 0,
        explain: `Each memory cycle is ${MCT_US} µs (R-700 Table 2-1), so two are ${us(2)} µs: the "addition time" the table gives.`,
        why: ['', 'That is one cycle.', 'The cycle is microseconds long, but 11.7 of them, not 1.', 'That is a multiply with its EXTEND: four cycles.'],
      },
    ],
  },
  steps: [
    {
      title: 'Meet the AGC',
      body: `
        <p>The Apollo Guidance Computer flew in the command module and the lunar module. Block II, the version
        that landed, has 15-bit words in one's complement (a number is negated by inverting every bit; step 4 shows what that
        costs the adder), ${groupNum(BLOCK2_ROPE.words)} words of read-only <strong>fixed</strong> memory and 2048 of
        <strong>erasable</strong> (read-write) memory, a memory cycle time (<strong>MCT</strong>) of ${MCT_US} µs, about 5600 gates in 2800 packages, 70 pounds and
        55 watts (Table 2-1 of R-700, E. C. Hall's 1972 history of the computer for MIT, the source of every number here).</p>
        <p>All of its logic is one circuit. In R-700's words it is "three NPN bipolar transistors and four resistors
        connected as a modified direct-coupled transistor logic or DCTL NOR gate", also called <strong>resistor-transistor
        logic</strong>: the transistors' emitters to ground, their collectors joined under one <span data-show="rc">collector
        resistor</span> to the supply, an input on each base. Any input high turns its transistor on and pulls the output
        low. That is a three-input NOR, the same shape as the tube NOR of <a href="#/c/tubes/3">prologue P2</a>. (Block I, the
        earlier design, used chips holding one gate type. Block II's came in two, a dual NOR gate and a dual "expander", which "differed only in
        interconnection pattern on the chip": one circuit, R-700 p. 228.)</p>
        <p>Here the transistors are drawn as the NMOS switches of chapter ${numOf('mosfet')}, and the collector resistor as
        a pull-up weaker than any of them. The three base resistors only limit the current into each base; they change no
        logic value, so they are counted (3 transistors, 4 resistors a gate) but not simulated.</p>
        <div class="try">Turn on any input and watch <code>y</code> fall.</div>`,
      scene: () => ({ root: NOR3_RTL, inputs: { a: 0, b: 0, c: 0 } }),
      tries: [(st) => st.value('y') === 0],
      more: {
        real: `<p>Sources: R-700, E. C. Hall, <i>MIT's Role in Project Apollo</i>, vol. III, <i>Computer Subsystem</i> (Charles
          Stark Draper Laboratory, August 1972), cited by printed page; MIT drawing 2005011 (Schematic, Dual NOR Gate, 1965)
          for the gate; K. Shirriff's study of a Block II rope (righto.com, 2019) for the rope's cores; Virtual AGC's yaAGC,
          against which the golden model of the last step is checked instruction by instruction.</p>`,
      },
    },
    {
      title: 'One kind of gate',
      body: `
        <p>A NOR is universal, as NAND is (chapter ${numOf('nand')}): tie its inputs together and it is a NOT; follow it
        with a NOT and it is an OR; feed it two inverted inputs and it is an AND, by De Morgan. Here <code>na</code>,
        <code>o</code> and <code>y</code> are NOT a, a OR b and a AND b: ${AGC_NOR.basic} gates, the
        <span data-show="g_na">NOT of a</span> shared by the NOT and the AND.</p>
        <p>Why only one circuit? R-700 (p. 10): the computer "would have required fewer integrated circuit packages if a
        variety of logic building blocks had been used including, for example, a gated flip-flop. It was estimated, however,
        that the problem of producing and qualifying even a second circuit type would have outweighed the advantages". With
        one part to make, test and trust, a few more packages were the cheaper price. Block II put two of these gates on
        one chip in a 10-lead flatpack (p. 13).</p>`,
      scene: () => ({ root: NOR_BASIC, inputs: { a: 1, b: 0 } }),
      challenge: {
        kind: 'quiz',
        question: 'With only NOR gates, how many does an AND of two inputs take?',
        options: ['3: a NOT of each input, then a NOR of the two', '1', '2: a NOR then a NOT', '4'],
        answer: 0,
        explain: 'a AND b = NOT(NOT a OR NOT b) = NOR(NOT a, NOT b): two gates to invert the inputs, one to NOR them.',
        why: ['', 'A single NOR is NOT(a OR b): true only when both inputs are 0.', 'A NOR then a NOT is an OR.', 'Three do it; a fourth would invert the AND again.'],
      },
    },
    {
      title: 'A full adder in NOR',
      body: `
        <p>Chapter ${numOf('adders')}'s 9-NAND full adder works with every NAND replaced by a NOR. Replacing each gate by its
        dual swaps every function for its dual, and the sum (a XOR b XOR ci) and the carry (the majority of three) are their
        own duals, so the same wiring still adds: ${AGC_NOR.fa} NOR gates, as many as the ${AGC_NOR.faNands} NANDs. The
        <span data-show="xa">first XNOR</span> gives NOT(a XOR b), the <span data-show="xb">second</span> combines it with
        the carry in into the sum, and the <span data-show="g_co">carry gate</span> takes one inner signal from each.</p>
        <p>R-700 (p. 67) describes the Block I adder the same way: for each bit the sum of X, Y and the incoming carry, "and
        also developed the outgoing carry. The logic was arranged so as to limit the number of gate stages between incoming
        and outgoing carries to 2, which is the minimum possible using NOR logic alone." So a carry crossing 16 bits went through
        32 gates, each taking some tens of nanoseconds. Block II added a <strong>carry skip</strong> across groups of four bits, the idea of
        chapter ${numOf('fastadd')}.</p>
        <div class="try">Set a, b and ci to 1: s and co are both 1.</div>`,
      scene: () => ({ root: NOR_FA, inputs: { a: 1, b: 0, ci: 0 } }),
      tries: [(st) => st.value('s') === 1 && st.value('co') === 1],
    },
    {
      title: 'The end-around carry',
      body: `
        <p>One's complement negates a number by inverting every bit, so there are two zeros, 0000 and 1111 (+0 and −0;
        chapter ${numOf('binary')}). To add, add the bits and add the carry out of the top back in at the bottom: −3 + 6 is
        1100 + 0110 = 1 0010, and the carry coming round makes it 0011, 3. So the adder is a ring: the
        <span data-show="fa3">top bit's</span> carry out feeds the <span data-show="fa0">bottom bit's</span> carry in.
        Four bits are ${AGC_NOR.add4} NOR gates.</p>
        <p>A ring has a catch. Add a number to its complement, 0101 + 1010: every column holds one 1, so every bit passes
        its carry on and none starts one. A carry of 0 all round is stable, giving 1111 (−0); so is a carry of 1 all round,
        giving 0000 (+0). Which one the ring settles in depends on what it held before, and it is
        worse than that: while the operands change, a gate can glitch for a moment and start a carry that then circles for
        good. So the ring runs through a <span data-show="g_eacin">gate</span> with a <strong>carry clear</strong>,
        <code>cc</code>: hold it at 1 while the operands change, so no stray carry survives, then let it go. A carry that
        is really generated still comes round; a + ¬a stays −0.</p>
        <p>R-700 records a related need in the real adder (p. 69): "One of the requirements for the control pulse sequence
        for Block II division is for the removal of carry propagations in the adder", and "logic is therefore furnished to
        suppress every fourth existing carry at the appropriate time".</p>
        <div class="try">The adder starts at 0111 + 0001 = 1000, every carry a 1. Turn on b1 and b3, turn off a1, and last
        turn off b0 (in that order: the last change is the one that leaves a carry circling): a is now 0101 and b 1010, and s shows 0000, the +0 the ring held on to. Pulse cc to 1 and back: s
        becomes 1111.</div>`,
      scene: () => ({ root: NOR_ADD4, inputs: { a0: 1, a1: 1, a2: 1, a3: 0, b0: 1, b1: 0, b2: 0, b3: 0, cc: 0 } }),
      challenge: {
        kind: 'quiz',
        question: 'Why must the carry ring be cleared before an addition, and not after?',
        options: [
          'A carry that circles with nothing generating it is stable, so it never dies out by itself; clearing while the operands change leaves only generated carries',
          'Clearing after would erase the answer',
          'The clear speeds the carry up',
          'Without it the adder oscillates',
        ],
        answer: 0,
        explain: 'When every bit propagates, a carry of 1 all the way round holds itself up. Held open while the operands settle, the ring starts from no carry at all, and only a carry some bit generates comes round.',
        why: ['', 'Releasing cc after the sum has settled changes nothing unless a carry was generated, and then it is part of the answer.', 'It adds a gate to the ring, so it slows the carry slightly.', 'The ring is bistable, not unstable: both all-0 and all-1 carries hold.'],
      },
    },
    {
      title: 'Registers of NOR gates',
      body: `
        <p>A register is the flip-flop of chapter ${numOf('registers')} in NOR: an enable that chooses the new bit or the old,
        a master latch open while the clock is low, a slave open while it is high, each a cross-coupled pair of NOR gates.
        ${AGC_NOR.reg} gates a bit, ${AGC_NOR.reg4} for the <span data-show="r0 r1 r2 r3">four bits</span> here. The AGC's
        central registers were "a gated flip-flop in each occupied bit position" (R-700 p. 69), built from the same gates.</p>
        <p>The accumulator A has <strong>16</strong> bits, not 15. A word coming from memory enters both of the top two
        columns (R-700 calls them S2 and S1). When the two agree there is no overflow; when they differ the sum overflowed,
        and the top one holds its true sign (R-700 p. 37, "modified one's complement"). Storing A keeps the true sign, so
        the sign of an overflowed sum survives, which double-precision arithmetic relies on: the overflow of the low word is carried into
        the high one as a ±1 (an "interflow").</p>
        <div class="try">Set d to a value, en to 1, and pulse clk from 0 to 1: q takes it.</div>`,
      scene: () => ({ root: NOR_REG4, inputs: { d0: 1, d1: 0, d2: 1, d3: 0, en: 1, clk: 0 }, autoClock: false }),
      tries: [(st) => st.value('q0') === 1 && st.value('q2') === 1],
      challenge: {
        kind: 'quiz',
        question: 'A holds 37777 (octal, the largest positive word) and AD adds 1. What do A\'s top two bits show?',
        options: ['0 then 1: they differ, so it overflowed, and the top bit says positive', '1 and 1: a negative number', '0 and 0: no overflow', 'The sum wraps to −0 and nothing records it'],
        answer: 0,
        explain: '37777 + 1 = 40000 in 16 bits: the carry reaches the second bit but not the top one. Different signs mean overflow, and the top bit, the true sign, is positive. TS then stores the word and skips the next instruction, leaving +1 in A.',
        why: ['', 'The top bit is still 0: the carry stops one below it.', 'The second bit became 1, so the two differ.', 'With 16 bits the overflow is held in A until it is dealt with.'],
      },
    },
    {
      title: 'A program woven into wire',
      body: `
        <p>The program was not loaded into the AGC: it was <strong>woven</strong>. In core rope, "a single core is switched,
        thereby inducing a voltage in every sense line that threads the core", and "a stored bit is a 1 whenever a sense
        wire threads a core, and is a 0 whenever it fails to thread a core" (R-700 sec. 3.5.2). One core serves many words:
        each Block II core stores ${BLOCK2_ROPE.wordsPerCore} words, so ${BLOCK2_ROPE.senseLines} sense lines run through or
        past it, and a diode switch passes the ${BLOCK2_ROPE.bitsRead} of the addressed word to the sense amplifiers. The
        address picks the core by the <strong>inhibit</strong> lines: every core but one has a current through it that
        cancels the switching current. ${BLOCK2_ROPE.modules} modules held the ${groupNum(BLOCK2_ROPE.words)}
        words, ${groupNum(BLOCK2_ROPE.wordsPerModule)} each, which makes ${BLOCK2_ROPE.coresPerModule} cores a
        module.</p>
        <p>The cores are not the ferrite rings of chapter ${numOf('memory')}'s core memory. R-700's parts count (Table
        7-VIII, p. 266) lists 32 768 ferrite cores, 2048 erasable words of 16 bits, and 3072 tape-wound ones, six modules
        of 512: a rope core is a winding of permalloy ribbon on a steel bobbin (Shirriff 2019). Rope is dense, about 1500
        bits per cubic inch with its electronics (R-700), and it cannot be changed by a program: a new program is a new rope,
        woven by machine from a punched tape (R-700 p. 165) and plugged in from outside the sealed case.</p>
        <div class="try">Read a few words, then click a crossing to thread or unthread it and read the word again.</div>`,
      widget: () => ropeWeaveWidget(),
      challenge: {
        kind: 'quiz',
        question: 'A rope core is switched, and 16 of its sense lines reach the amplifiers. Which word do they hold?',
        options: ['The one of the core\'s 12 words that the strand switch picked', 'All 12 words at once', 'The word in the core\'s magnetization', 'The word the inhibit lines carry'],
        answer: 0,
        explain: 'Every line threaded through the switched core pulses, those of all 12 words. The diode switch in the module passes only the addressed word\'s 16 to the sense amplifiers.',
        why: ['', 'There are 16 sense amplifiers, one word\'s worth.', 'Every core switches the same way; the data is in which wires thread it.', 'The inhibit lines pick the core; they carry no data.'],
      },
    },
    {
      title: 'Inside a rope module',
      body: `
        <p>A rope module seen whole: its ${BLOCK2_ROPE.coresPerModule} cores, the sense wires woven through and around them,
        the inhibit, set and reset wires that pick one core and switch it, and the diode and resistor parts of the selection
        network in cordwood blocks beside them (parts standing upright between two boards, packed like logs). Pick a core and a strand, step through a read, and watch which sense wires
        pulse.</p>`,
      widget: () => rope3d(),
    },
    {
      title: 'Thirty-four instructions',
      body: `
        <p>Block II has 34 instructions (R-700 Table 2-1) in a 15-bit word: a 3-bit operation code and a 12-bit address.
        Eight codes are not enough, so two tricks stretch them (p. 38): a <strong>partial code</strong> takes two address
        bits to choose among four instructions that only address erasable memory (10 bits are enough there), and
        <strong>EXTEND</strong> makes the next instruction an extracode, from a second set (MP, DV, SU, BZF …).</p>
        <p>Some are odd to modern eyes. <strong>CCS</strong> (count, compare and skip) loads |K| − 1 and skips 0, 1, 2 or 3
        words for positive, +0, negative and −0: one instruction both counts a loop down and tests it. <strong>TS</strong>
        stores A, and when A has overflowed it stores the corrected word, leaves ±1 in A and skips. <strong>INDEX</strong>
        adds a word to the next instruction, the AGC's way to index a table.</p>
        <p>The program below sums a table that way. On the golden model it takes ${AGC_SUM_RUN.instrs} instructions and
        ${AGC_SUM_RUN.mct} memory cycles, ${us(AGC_SUM_RUN.mct)} µs, and leaves ${AGC_SUM_RUN.sum}. The model is checked
        against yaAGC, Virtual AGC's emulator, which runs the flight programs: every instruction's registers, erasable
        memory and cycle count, on directed and random programs (docs/VERIFICATION.md).</p>
        <div class="try">Step through the loop and watch CCS count the table down. Change a number in the table, assemble
        and run to the end.</div>`,
      widget: () => agcRunWidget(),
      challenge: {
        kind: 'quiz',
        question: 'CCS reads a counter holding +0. What does it do?',
        options: ['Loads +0 into A and skips one instruction', 'Loads −1 and goes on', 'Skips three instructions', 'Loads +0 and goes on'],
        answer: 0,
        explain: 'CCS skips 0, 1, 2 or 3 for positive, +0, negative and −0, and loads |K| − 1, or +0 when that would be negative. The loop ends there: the instruction after the skip leaves it.',
        why: ['', 'A count of +0 diminishes to +0, not −1.', 'Three is for −0.', 'Going on is for a positive count.'],
      },
    },
  ],
};
