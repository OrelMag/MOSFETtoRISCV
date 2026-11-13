// Appendix A: the MOS 6502 of 1975, at transistor level, built the way it was built then.

import { groupDigits } from '../sim/numfmt';
import { BUS_LINE, MS_BIT } from '../lib/m6502/demo';
import { NNOR2 } from '../lib/nmos';
import { SwitchSim } from '../sim/switchsim';
import { m6502Scene } from '../widgets/m6502';
import { opcodeMatrix } from '../widgets/m6502isa';
import { ledger } from '../widgets/m6502ledger';
import { withModel } from '../widgets/modelhost';
import { nmosGate3d } from '../widgets/nmosgate3d';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

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
const k = groupDigits;

export const chAppendix6502: Chapter = {
  id: 'appendix-6502', num: numOf('appendix-6502'), appendix: 'A', title: '1975: the 6502', level: 'NMOS',
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
        <p>Almost every block of the journey was built from one brick, the static CMOS NAND, at whatever width the job asked. The 6502 (MOS Technology, 1975, sold
        for $25) is the other end: 8 bits, the CPU of the Apple II and, in variants, of the Commodore 64 and the NES, and small enough to simulate whole at transistor
        level (our rebuild has about ${k(LEDGER.m6502)} transistors). It is built from ratioed NMOS gates, the idea <a href="#/c/inverter/0">chapter ${numOf('inverter')}</a> priced as
        pseudo-NMOS, and from tricks a NAND-only design never needs. This appendix rebuilds it from its own kind of gate up, runs programs on the transistors cycle
        by cycle, and accounts for why our RV32I costs some ${Math.round(LEDGER.rv32i / LEDGER.m6502)} times as many transistors.</p>
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
        <p>Why this was the winning trade in 1975: a CMOS gate needs a p-type device for every n-type one, and p-channel transistors of the time were roughly half as fast per area, and one type had to sit in a well of its own.
        Giving the pull-up network up altogether made the die smaller, the process shorter (fewer masks) and the chip cheaper, and a logic family with only one transistor type could be laid out densely by hand.
        What it cost was static power and an output that never quite reaches 0, as the derivation shows.</p>
        <div class="try">Set both inputs to 0 and open the load (<code>ld</code>): the depletion transistor is drawn
        with a solid channel and its gate tied to its source.</div>`,
      tour: {
        beats: [
          { title: 'A path to ground', say: 'Input <code>a</code> is 1: its pull-down conducts and, being stronger than the load, wins. The output is {v:y}, a 0, and current flows from VDD through the load and that pull-down.', at: [], show: ['n0'], expect: { y: 0 } },
          { title: 'No path', say: 'Both inputs at 0: no pull-down conducts, so the depletion load pulls the output up to VDD. <code>y</code> = {v:y}. No current flows now.', set: { a: 0 }, show: ['ld'], expect: { y: 1 } },
          { title: 'The other input', say: 'Only <code>b</code> is 1: the second pull-down conducts alone. NOR: any 1 gives 0, so <code>y</code> = {v:y}.', set: { b: 1 }, show: ['n1'], expect: { y: 0 } },
          { title: 'Both', say: 'Both pull-downs conduct, in parallel. <code>y</code> = {v:y}, still 0, now with two paths to ground. Parallel pull-downs add no resistance to a path, which is why NOR was the natural NMOS gate.', set: { a: 1 }, show: ['n0', 'n1'], expect: { y: 0 } },
        ],
      },
      more: {
        derive: `<p>With the load as a resistor R<sub>L</sub> and a conducting pull-down as R<sub>pd</sub>, the low output is V<sub>OL</sub> = VDD · R<sub>pd</sub> / (R<sub>pd</sub> + R<sub>L</sub>). Writing k = R<sub>L</sub> / R<sub>pd</sub> (the ratio),
          V<sub>OL</sub> = VDD / (1 + k). At 5 V: ${[2, 4, 8].map((k) => `k = ${k} gives ${(5 / (1 + k)).toFixed(2)} V`).join(', ')}. A bigger ratio gives a cleaner 0 and a slower rising edge (the weak load charges the output), so k is a design choice.
          Transistors for an n-input NOR: n pull-downs and 1 load = n + 1, against CMOS's 2n.</p>`,
        real: `<p>NMOS with depletion loads (Intel's HMOS and the processes of MOS Technology and Zilog) replaced the first PMOS and enhancement-load NMOS logic around 1974 to 1976. Static power set the limit of the
          technology: a chip with a few thousand gates low at any moment ran warm, and by the mid-1980s CMOS, with the process improved, took over (the 65C02 is the CMOS 6502).</p>`,
        pitfall: `<p>Assuming the output swings rail to rail. In ratioed logic a 0 is a voltage above ground, and the next gate must read it as a 0. A NAND is worse: its series pull-downs add resistance, so each
          needs to be wider, which is why designers favoured NOR. In the scene, with a = 1 the output reads 0, but the load and the pull-down are both conducting: that is the steady current.</p>`,
        numbers: `<table class="mini"><tr><th>NOR inputs n</th><th>NMOS (n + 1)</th><th>CMOS (2n)</th></tr>
          ${[1, 2, 3, 4].map((n) => `<tr><td>${n}</td><td>${n + 1}</td><td>${2 * n}</td></tr>`).join('')}</table>`,
      },
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
        <p>The idea is the master–slave rule of <a href="#/c/latches/0">the flip-flop chapter</a> with the storage stripped to its minimum. A flip-flop moves a bit across an edge
        without letting it race through; two non-overlapping phases do that with the clock itself, and the bit is held not by a feedback loop (more transistors, more power) but by the capacitance of a gate.
        The cost is that the memory lasts only as long as the charge: the design trades a static guarantee for area, and then promises, in the data sheet, never to stop the clock.</p>
        <div class="try">Set <code>d</code>, raise and drop <code>p1</code>, then raise and drop <code>p2</code>: the bit
        reaches <code>q</code> one phase at a time. Then press <b>Stop the clock for 10 ms</b>.</div>`,
      tour: {
        beats: [
          { title: 'Data waiting', say: 'The input <code>d</code> is 1 but both phases are low. Both pass transistors are off and the output <code>q</code> is {v:q}: unknown, nothing has been stored.', at: [], show: ['master', 'slave'], expect: { q: -1 } },
          { title: 'φ1: the master opens', say: 'φ1 high. The master\'s pass transistor conducts and its inverter gate charges to the value of <code>d</code>. The slave is still isolated, so <code>q</code> is {v:q}.', set: { p1: 1 }, show: ['master'], expect: { q: -1 } },
          { title: 'φ1 falls: the charge is the bit', say: 'The pass transistor turns off. The master\'s gate is now floating, and the charge left on it is the stored 1. Nothing else changed: <code>q</code> is {v:q}.', set: { p1: 0 }, show: ['master'], expect: { q: -1 } },
          { title: 'φ2: the slave copies it', say: 'φ2 high: the slave\'s pass transistor passes the master\'s value on. <code>q</code> = {v:q}. The bit has crossed from master to slave one phase after it entered.', set: { p2: 1 }, show: ['slave'], expect: { q: 1 } },
          { title: 'Input changes: nobody cares', say: 'φ2 falls and <code>d</code> goes to 0. The master is closed (φ1 is low), so <code>d</code> cannot reach the slave. <code>q</code> stays {v:q}.', set: { p2: 0, d: 0 }, show: ['master', 'slave'], expect: { q: 1 } },
          { title: 'The next pair of phases', say: 'φ1 again takes the new <code>d</code> into the master; <code>q</code> still holds the old bit, {v:q}.', set: { p1: 1 }, show: ['master'], expect: { q: 1 } },
          { title: 'φ2 updates q', say: 'φ1 off, φ2 on: now the slave sees the new value and <code>q</code> = {v:q}. One value per clock period, never transparent end to end.', set: { p1: 0, p2: 1 }, show: ['slave'], expect: { q: 0 } },
        ],
      },
      more: {
        derive: `<p>Per bit: master = pass transistor + pull-down + load = 3 transistors; slave the same; total 6 (the text's 4 + 2 loads). Our NAND master–slave flip-flop is 44 transistors. The dynamic version is about
          one seventh of the size, with no feedback loop and no static power in the storage node itself.</p>
          <p>The node holds V = Q / C. Leakage current I drains it at dV/dt = I / C, so the bit survives a time t = C·ΔV / I before the inverter's threshold is crossed. That time, not any gate delay,
          sets the lowest clock frequency, and it falls rapidly with temperature because leakage rises.</p>`,
        real: `<p>The NMOS 6502 refreshes its dynamic registers simply by running: every φ1 and φ2 reloads the nodes. That is why a data-sheet minimum clock exists, and why
          the 6502 pauses with RDY, which stops the cycle at a safe point, not by stopping the clock. CMOS processors, whose latches are static, can stop their clocks.</p>`,
        pitfall: `<p>Letting the phases overlap. If φ1 and φ2 are both high, the master and the slave conduct together and the new <code>d</code> races straight through to <code>q</code>: the flip-flop becomes a
          transparent buffer and a pipeline built from them loses its register boundaries. Generating φ1 and φ2 with a gap between them (the drawing above) is what makes the scheme work.</p>`,
      },
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
        the line's value wins (charge sharing). The simulator decides such meetings by capacitance, as the silicon does.</p>
        <p>The scheme turns a hard problem into an easy one. A shared bus normally needs a tri-state driver per source and rules against two being on at once. Here nobody ever drives a 1:
        the precharge does it for all of them, and a source can only pull down. Two sources on at once cannot fight; they AND. The price is time (half the cycle goes to precharging) and dynamic
        storage again: the line is a capacitor that must be read before it leaks.</p>`,
      tour: {
        beats: [
          { title: 'Precharged', say: 'φ2 is high: the precharge transistor charges the bus. <code>bus</code> = {v:bus}, a 1 held by the line\'s own capacitance. Nothing is enabled.', at: [], show: ['pre'], expect: { bus: 1 } },
          { title: 'Let go', say: 'φ2 falls and the precharge turns off. The line still reads {v:bus}: now it is stored charge, not a driven level.', set: { p2: 0 }, show: ['pre'], expect: { bus: 1 } },
          { title: 'A source with a 1', say: 'Source A is enabled with <code>a</code> = 1. A 1 does nothing: its pull-down stays off and the line keeps its charge. <code>bus</code> = {v:bus}.', set: { en_a: 1 }, show: ['ena', 'va'], expect: { bus: 1 } },
          { title: 'Into the latch', say: '<code>ld</code> opens the pass transistor into the storage node: <code>q</code> = {v:q}. A 1 went over the bus without any source driving a 1.', set: { ld: 1 }, show: ['pass', 'i1', 'i2'], expect: { q: 1 } },
          { title: 'Precharge again', say: 'The cycle repeats: enables off, φ2 high, the line is charged again. <code>q</code> keeps {v:q}.', set: { ld: 0, en_a: 0, p2: 1 }, show: ['pre'], expect: { bus: 1, q: 1 } },
          { title: 'Two sources: the AND', say: 'φ2 low, then A (bit 1) and B (bit 0) enabled together. B\'s pull-down conducts, and one conducting pull-down is enough: <code>bus</code> = {v:bus}, the AND of 1 and 0.', set: { p2: 0, en_a: 1, en_b: 1, b: 0 }, show: ['ena', 'enb', 'va', 'vb'], expect: { bus: 0 } },
          { title: 'Latch the result', say: 'The destination takes the line: <code>q</code> = {v:q}. A 1 and a 0 on one bus produced a clean 0, with no contention and no current spike.', set: { ld: 1 }, show: ['pass'], expect: { q: 0 } },
        ],
      },
      more: {
        derive: `<p>Each bit of the bus costs, per source, two series pull-downs (enable and bit), and per destination one pass transistor: 2s + d transistors for s sources and d destinations. A conducting source sets the line to
          0, a non-conducting source leaves it; the line after φ1 is therefore the AND of the enabled sources' bits, and with no source enabled it stays at its precharge, 1. Read inverted, the same line is the OR of the complements. The ALU's AND and OR do not use this: they have gates of their own.</p>`,
        real: `<p>Precharged, discharge-only lines are the same idea as dynamic logic, domino logic and the Manchester carry chain, and as DRAM's bit lines (chapter ${numOf('dram')}). Wherever a wire is long, the line's capacitance is large
          and a weak driver can only discharge it fast: precharge turns that into the fast path every cycle. A modern CPU has precharged structures in its register files' read ports, cache bit lines and
          wide gates; what has gone is the global bus built that way.</p>`,
        pitfall: `<p>Enabling a source before the precharge, or reading the line after it has leaked. In φ1 the line holds only charge, so a read that comes late gets a drooped 1 that may be taken for X. And two sources on one line is not the same as two sources on one driven bus: the AND is a feature here, an error there.</p>`,
      },
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
        whose carry into bit 4 and out of bit 7 comes at ten rather than sixteen in decimal mode, AND / OR / EOR / shift right, and an
        output latch <code>ADD</code> that drives ADL directly and SB through the <strong>decimal corrector</strong>
        (+6 per nibble after a decimal ADC, −6 after SBC). There is one adder (the PC's incrementer aside): index arithmetic, the stack pointer's
        steps, branch targets and ADC all take turns on it, one per cycle.</p>
        <p>The <span data-show="pc"><strong>PC</strong></span> has its own incrementer. The <span data-show="addr">address
        register</span> drives the pins A0–A15 for the whole cycle; <span data-show="data"><code>DL</code> (the data latch)</span>
        catches the byte read at the end of φ2, <code>DOR</code> (the data output register) holds the byte to write.
        Constants ($00 / $01 on ADH, the vectors on ADL) are a few pull-downs on the precharged lines.</p>
        <p>The structure is a design philosophy: one ALU, four buses, and everything else a latch that either drives a bus or loads from one. There is no register file in the modern sense, no bypass,
        no second adder. Every instruction is a sequence of bus transfers, and the control unit's work is to say which source and which destination are enabled in each half-cycle. The small
        datapath is what makes the transistor count small, and the many cycles per instruction are what that costs.</p>
        <div class="try">Open any block: a register is eight bit cells, a bit cell a storage node, its refresh and its
        bus drivers, each down to transistors.</div>`,
      more: {
        derive: `<p>One adder shared by every use: ADC, the PC increment on a branch, an index added to a base address, the stack pointer's decrement. Each takes its own cycle, so an indexed load
          ( LDA abs,X ) spends one cycle adding X to the low address byte and, if it carries, a further cycle fixing the high byte. Transistors per register bit: ${LEDGER.bit6502}, against about ${LEDGER.bitRf} for the RV32I's. For
          a register that is ${8 * LEDGER.bit6502} against ${32 * LEDGER.bitRf} transistors: ${Math.round((32 * LEDGER.bitRf) / (8 * LEDGER.bit6502))} times, for four times the width.</p>`,
        real: `<p>The decimal corrector is a small cell, +6 on a nibble, that let a 1975 chip do BCD arithmetic for cash registers, scales and accounting machines without library code. It is also the part of the 6502 whose flags were
          longest wrong in emulators: after a decimal add the NMOS chip's Z is that of the binary sum, and its N and V those of a half-corrected sum (low nibble adjusted, high nibble not), so none of the three describes the decimal result. The 65C02 fixed that.</p>`,
        pitfall: `<p>Counting the programmer's registers (A, X, Y, S, P, PC) as the machine's state. Under them sit the latches that hold values in flight: the ALU's input latches AI and BI, its output ADD, the data latch DL, the output
          register DOR, the instruction register, the address registers. They are why a block diagram of the 6502 looks so much more crowded than its programmer's model.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>6502</th><th>RV32I (ours)</th></tr>
          <tr><td>register bit</td><td>${LEDGER.bit6502} transistors</td><td>about ${LEDGER.bitRf}</td></tr>
          <tr><td>programmer-visible registers</td><td>A, X, Y, S (8 bit), PC</td><td>31 × 32 bit and PC</td></tr>
          <tr><td>adders</td><td>1</td><td>ALU, PC + 4, branch target</td></tr></table>`,
      },
      scene: () => m6502Scene({ path: ['dp'], highlight: DATAPATH }),
    },
    {
      title: 'Timing and the decode PLA',
      body: `
        <p>Control is three things. The <span data-show="timing"><strong>timing</strong></span> block is a ring of T states (T1 … T7), one per cycle
        of an instruction, returning to T1 at its last cycle, early when an address does not cross a 256-byte page or a branch is not taken.
        <span data-show="ir"><code>IR</code></span> (the instruction register) holds the opcode, loaded at the end of the fetch.</p>
        <p>The <span data-show="decode"><strong>decode PLA</strong></span> turns IR and T into control signals: each row is a NOR over complemented
        literals (an AND of opcode bits and one T line), each signal a NOR of rows. Ours is computed: for every signal
        and cycle, the opcodes that need it are minimized, with the 105 undocumented opcodes free. That gives 245 rows;
        the real chip, tuned by hand with more of the work in random logic, has about 130. The free opcodes are why
        undocumented 6502 opcodes do something: their rows fire wherever minimization put them.</p>
        <p>While T1 fetches an opcode, IR still holds the previous one, so T1's rows finish the previous instruction: a
        load moves DL into its register, an ADC adds (writing A a cycle later). That overlap is how LDA # fits in two
        cycles. <span data-show="control"><strong>Control lines</strong></span> qualify the PLA's outputs by
        <span data-show="clock">φ1</span>, or latch them in φ1 so they hold through φ2, while the T state and IR change.</p>
        <p>This is the single-cycle CPU's control unit spread over time: instead of one big truth table from opcode to signals, a table indexed by opcode <em>and</em> cycle. A PLA is the natural
        circuit for it, because in NMOS a NOR plane is a grid of transistors where each crossing is a transistor or a gap, and the table is simply the pattern of crossings. The cost is area proportional to rows times
        literals, which is why the real chip's designers spent so much effort sharing rows.</p>`,
      more: {
        derive: `<p>Instruction timing from the T states, for LDA #imm. Cycle 1: fetch the opcode (this is T1 of whatever ran before, whose rows finish the previous instruction). Cycle 2: IR now holds LDA #; fetch the operand byte into DL (T2 of
          this instruction; the real chip calls this cycle T0). Cycle 3, which is the next instruction's T1: the rows for LDA move DL to A while the next opcode is fetched. The instruction takes 2 cycles because its last step shares a cycle with the next fetch.
          The PLA's 245 rows (about 130 on the real chip) are the minimized form of: for each control signal, the set of (opcode, T) pairs where it must be 1, with the 105 undocumented opcodes free to fall wherever they merge rows.</p>`,
        real: `<p>The real PLA is the part of the chip that was reverse-engineered first from photographs, and then completely in 2010 by the Visual6502 team, who photographed the die, traced the layers into a netlist
          and simulated it. The PLA's rows are visible to the eye on the die, which is why the behaviour of the undocumented opcodes could be explained rather than just catalogued.</p>`,
        pitfall: `<p>Assuming unused opcodes are NOPs. The decoder has no concept of illegal: any 8-bit pattern asserts whichever rows match it, so an undocumented opcode does some combination of the documented behaviours (LAX loads A and X
          together, for instance). Software that used them broke on the CMOS 65C02, which turned most into NOPs. In our PLA the 105 free opcodes are exactly the ones minimization had freedom over.</p>`,
      },
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
        151 documented opcodes (10 000 each) and all 96 million cycles of Klaus Dormann's functional test, every bus cycle matches a
        reference model.</p>
        <p>The ISA is shaped by the datapath: three registers because there are three places a byte can be held on SB, zero page because an address with a known-zero high byte saves a cycle, indexed modes because the single
        adder can add X or Y to an address byte on the way past. Each addressing mode is a recipe of bus transfers, and the opcode matrix is the table of recipes.</p>`,
      more: {
        derive: `<p>The opcode byte aaabbbcc has 256 values; 151 are documented, so 256 − 151 = 105 are not. For most operations cc picks a group, aaa the operation and bbb the addressing mode, so one addressing-mode recipe serves
          eight operations. Timing follows the recipe: an immediate operand costs 2 cycles (opcode, operand), zero page 3 (opcode, address, data), absolute 4 (opcode, two address bytes, data), and indexed modes add
          a cycle when the index carries into the high address byte.</p>`,
        real: `<p><code>JMP ($xxFF)</code> takes the pointer's high byte from $xx00, not from the next page: the indirect address's low byte is
          incremented without a carry into the high byte (fixed in the CMOS 65C02). <code>BRK</code> shares the IRQ vector at $FFFE; the
          handler tells them apart by the B bit of the status byte pushed on the stack (a flag that exists only there), and BRK skips the
          byte after it. The NMOS chip leaves the D flag set on an interrupt, and its N, V and Z after a decimal ADC are not those of the
          decimal result. The earliest chips (1975–76) shipped without a working <code>ROR</code>. And the 105 undocumented opcodes do
          whatever the PLA's rows make of them; programs came to rely on some (LAX, SAX), and the 65C02 turned them into NOPs or new instructions.</p>`,
        pitfall: `<p>Counting cycles from the opcode table alone. Indexed reads take one extra cycle when the low byte of the address plus the index carries, because the first access went to the wrong page and a second one fixes it;
          branches take 2 cycles not taken, 3 taken and 4 when the target is on another page. A cycle-exact emulator (this chip's lock-step check is one) has to model the page crossings, and the dummy bus accesses that go with them.</p>`,
        numbers: `<table class="mini"><tr><th>LDA addressing mode</th><th>cycles</th></tr>
          <tr><td>immediate</td><td>2</td></tr><tr><td>zero page</td><td>3</td></tr><tr><td>zero page, X</td><td>4</td></tr><tr><td>absolute</td><td>4</td></tr>
          <tr><td>absolute, X or Y</td><td>4 (+1 across a page)</td></tr><tr><td>(zero page), Y</td><td>5 (+1 across a page)</td></tr><tr><td>(zero page, X)</td><td>6</td></tr></table>`,
      },
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
        <div class="try">Step through <code>LDA msg,X</code>: the opcode and two operand fetches, then the read, and the next
        opcode fetch is where A changes. Try the <code>irq</code> program and press <b>IRQ</b>.</div>
        <p>About ${k(LEDGER.m6502)} transistors switch in an event-driven simulation: thousands of cycles a second, where the
        silicon did a million.</p>
        <p>What the lock-step check buys is trust in everything above it. The chip is written once, in transistors, and the model is written independently from the data sheet and the test suites; a mismatch on any
        bus cycle, in any of the millions of test cases, would mean a transistor placed wrongly or a model that misreads the chip. Neither side is privileged, and both agree.</p>`,
      more: {
        derive: `<p>LDA msg,X, cycle by cycle: 1 fetch the opcode (SYNC high); 2 fetch the low address byte; 3 fetch the high byte, adding X to the low byte on the shared adder; 4 read the byte at the computed address (5 if the add carried, with
          a read of the wrong page in between); and then the next opcode fetch, in which A takes the loaded value. The panel's trace shows exactly this: the address pins, the data and R/W each cycle, SYNC marking the opcode fetches.</p>`,
        real: `<p>Visual6502 (2010) made the same kind of simulation of a real 6502 from photographs of the die, running in a browser. Hardware 6502 systems from the Apple II to the NES were debugged with a logic analyser
          watching exactly these signals; the cycle-exact emulators of those machines rest on the same bus trace.</p>`,
        pitfall: `<p>Reading A while an instruction is still in flight. The value of an LDA appears in A only in the next instruction's first cycle (the overlap of the previous step), so stopping after the read cycle shows the old A.
          Use <b>Instr</b> to run to the next opcode fetch, or step one more cycle, before concluding the load failed.</p>`,
        numbers: `<table class="mini"><tr><th>cycle</th><th>what the pins show</th></tr>
          <tr><td>1</td><td>SYNC high, address = PC, data = opcode</td></tr><tr><td>2</td><td>address = PC + 1, data = low byte</td></tr>
          <tr><td>3</td><td>address = PC + 2, data = high byte</td></tr><tr><td>4</td><td>address = msg + X, R/W high, data = byte read</td></tr></table>`,
      },
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
        <p>The ledger is an accounting of choices, not of quality. Each line (storage, technology, width, single cycle) is a place where one design spent transistors to get something, and the other spent time or
        capability instead. Reading it is how to estimate a design's cost before building it.</p>`,
      more: {
        derive: `<p>The ratio is ${k(LEDGER.rv32i)} / ${k(LEDGER.m6502)} = ${(LEDGER.rv32i / LEDGER.m6502).toFixed(0)}. Take the storage out: ${LEDGER.storePct} % of the RV32I is storage, so the rest is ${100 - LEDGER.storePct} % of ${k(LEDGER.rv32i)} = about ${k(Math.round(LEDGER.rv32i * (100 - LEDGER.storePct) / 100))},
          which is ${(LEDGER.rv32i * (100 - LEDGER.storePct) / 100 / LEDGER.m6502).toFixed(1)} times the whole 6502. What remains is width (4× the bits), the three adders, and NAND-only static logic against a dense NMOS design. The 6502's
          registers at ${LEDGER.bit6502} transistors a bit against about ${LEDGER.bitRf} account for most of the storage difference by themselves.</p>`,
        real: `<p>Chuck Peddle and Bill Mensch had worked on Motorola's 6800; with a few colleagues they left for MOS Technology in 1974 to
          build a far cheaper CPU. Their first, the 6501, fitted the 6800's socket; Motorola sued, and MOS dropped the 6501 and kept the
          6502, whose pins differ. MOS sold it with the KIM-1 board (1976); Commodore bought MOS that year. The family went everywhere:
          the Apple I and II, the Commodore PET and VIC-20, the C64 (its 6510 adds an I/O port), the BBC Micro, the Atari 2600 (a 6507:
          28 pins, 13 address lines, 8 KiB of address space) and the NES (Ricoh's 2A03: a 6502 without decimal mode, with the sound on
          the die). Mensch founded the Western Design Center, whose CMOS 65C02 and 16-bit 65C816 (Apple IIGS, Super NES) are still
          made.</p>`,
        pitfall: `<p>Comparing transistor counts across technologies as if a transistor were a unit of area or of cost. An NMOS pull-down and a CMOS NAND's transistor are not the same size, a dynamic latch's transistor is not a flip-flop's, and the
          RV32I's counts include the memory that the 6502 leaves outside the chip. The honest comparison is the table: the same function, built each way, counted from both libraries.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>6502</th><th>RV32I (ours)</th></tr>
          <tr><td>transistors</td><td>about ${k(LEDGER.m6502)}</td><td>about ${k(LEDGER.rv32i)}</td></tr>
          <tr><td>storage share</td><td>registers only</td><td>${LEDGER.storePct} %</td></tr>
          <tr><td>register bit</td><td>${LEDGER.bit6502}</td><td>about ${LEDGER.bitRf}</td></tr></table>`,
      },
      widget: () => withModel(ledger(), nmosGate3d()),
    },
  ],
};

