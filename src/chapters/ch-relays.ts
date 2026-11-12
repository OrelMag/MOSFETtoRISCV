import { groupDigits } from '../sim/numfmt';
import { rca } from '../lib/combinational';
import { XOR } from '../lib/gates';
import { RELAY_BUZZER, RELAY_LATCH, RELAY_NAND, RELAY_NOT, RELAY_XOR, relayAdder } from '../lib/relays';
import { DFF, SR_LATCH } from '../lib/sequential';
import { NAND2_UM2, RELAY_CONTACTS, RELAY_MASS, RELAY_POWER, RELAY_VOLUME, fmtMass, fmtTime, fmtVolume, relayExtra } from '../lib/tech';
import { RELAY, RELAY_COIL_POWER, RELAY_STEP_MS, RELAY_SUPPLY, Z3, coilTau, relayStatic } from '../phys/relay';
import { logicDepth, stats } from '../sim/stats';
import { PS_PER_NAND } from '../sim/timing';
import { relayCloseup } from '../widgets/relay3d';
import type { Chapter } from './types';
import { numOf } from './order';

const ADD4 = relayAdder(4);
const PULL = relayStatic();
const ms = (x: number) => x.toFixed(1);
const thin = (n: number) => groupDigits(Math.round(n));
/** The Z3's speed (Rojas): an addition in about 0.8 s, a multiplication in about 3 s, on a clock of about 5 Hz. */
const Z3_SPEED = 'an addition in about 0.8 s and a multiplication in about 3 s';
/** The buzzer in the step model: a period of two relay steps. */
const BUZZ_HZ = Math.round(1000 / (2 * RELAY_STEP_MS));
/** Our relay's release after switch-off (ms): relaySummary(relaySim(24)).release, pinned by tests/content-prologue.test.ts (read from the text). */
const RELEASE_MS = 3.4;
/** Operations a telephone relay's contacts are rated for under load (order of magnitude). */
const CONTACT_LIFE = 1e7;

export const chRelays: Chapter = {
  id: 'relays', num: numOf('relays'), prologue: 'P1', title: 'Relays', level: 'Electromechanical',
  blurb: 'A switch moved by a magnet: logic, an adder whose carry needs no time, memory and a clock, from 1937 hardware.',
  goals: [
    `read a relay's pull-in and drop-out voltages and its ${ms(RELAY_STEP_MS)} ms step off its physical model`,
    'build NAND and XOR from contacts, with an open line read as 0',
    'explain why the relay adder\'s carry crosses any width in one relay step',
    'make a relay hold a bit through its own make contact, and buzz through its own break contact',
  ],
  recap: {
    keep: [
      `A telephone relay on 24 V closes at ${ms(PULL.pull ?? 0)} V, opens only below ${ms(PULL.drop ?? 0)} V, and is settled ${ms(RELAY_STEP_MS)} ms after switch-on, bounce included: one relay step.`,
      'Contacts pass a line both ways at full strength, isolated from the coil. Every line ends on a coil, a resistor to ground: <strong>voltage means 1, no connection means 0</strong>.',
      `Changeover contacts make selection nearly free: XOR is 2 relays and 1 step (in <span data-ahead="cmos">CMOS (the transistor logic of chapters ${numOf('mosfet')} to ${numOf('nand')})</span> 4 NANDs, 3 delays). The adder's carry runs through closed contacts on two lines, c and its complement: 1 step at any width, against ${logicDepth(rca(32))} gate delays for a 32-bit <span data-ahead="ripple">ripple-carry adder (each carry waits for the one before)</span> in transistors.`,
      `A relay fed through its own make contact holds itself: one relay per bit (the Z3: ${thin(Z3.memory)} of its ${thin(Z3.relays)} relays). Fed through its own break contact it buzzes: in the step model a period of two relay steps, about ${BUZZ_HZ} Hz.`,
      `One relay draws ${RELAY_COIL_POWER.toFixed(2)} W while its coil is on, and its contacts wear: every break of a coil's current draws an arc. The Z3: ${thin(Z3.relays)} relays, about ${Z3.power / 1e3} kW, about a tonne, ${Z3_SPEED}.`,
    ],
    practise: ['r_pull', 'r_nand', 'r_xor', 'r_adder', 'r_latch', 'r_clock'],
    check: [
      {
        question: 'A relay is operated. Its 24 V supply sags to 10 V. What does it do?',
        options: [`It stays operated: it only drops out below ${ms(PULL.drop ?? 0)} V`, `It drops out: 10 V is below its ${ms(PULL.pull ?? 0)} V pull-in`, 'It chatters between open and closed'],
        answer: 0,
        explain: `Pulling the armature in across a wide gap takes ${ms(PULL.pull ?? 0)} V. Once it is in, the gap is small and the pull (N·I)² / gap² is strong: it holds down to ${ms(PULL.drop ?? 0)} V.`,
        why: ['', 'Pull-in is the voltage needed to close it from rest. A closed armature sits close to the core and needs far less current to stay.', 'Chattering would need the supply to cross both thresholds, and 10 V sits between them.'],
      },
      {
        question: 'The relay adder is widened from 4 to 32 bits. How long after the operands change is the sum settled?',
        options: [`1 relay step (${ms(RELAY_STEP_MS)} ms)`, '32 relay steps, one per bit', `${logicDepth(rca(32))} relay steps`],
        answer: 0,
        explain: 'Only the operand relays move, all together. The carry is never a coil: it passes through contacts that are already closed.',
        why: ['', 'A carry would ripple bit by bit if each bit had to operate a relay. Here it only passes through contacts.', 'That is the 32-bit <span data-ahead="ripple">ripple-carry adder (carry passed from column to column)</span> built from NAND bricks, a relay per NAND: then the carry waits for a coil in every gate.'],
      },
      {
        question: 'In the self-holding relay, how does reset clear the bit?',
        options: ['It operates a relay whose break contact sits in the line that feeds k', 'It opens k\'s own make contact', 'It releases the set relay'],
        answer: 0,
        explain: 'k is fed through its own make contact from a holding line that runs through the reset relay\'s break contact. Reset opens that line, k drops out, and its make contact opens behind it.',
        why: ['', 'k\'s make contact opens only after k has dropped out. Reset has to cut the current first, somewhere else in the path.', 'After the set pulse the set relay is already released. k is fed through the holding line, not through the set relay\'s contact.'],
      },
    ],
  },
  steps: [
    {
      title: 'A switch you can hear',
      body: `
        <p>Before transistors, the switch was a <strong>relay</strong>: a coil around an iron core, and a hinged iron
        <strong>armature</strong> held off the core by a spring. Current through the coil magnetizes the core, the
        armature is pulled in, and the stud it carries moves the contact springs: the <strong>common</strong> leaves
        its <em>break</em> contact (NC, normally closed) and touches its <em>make</em> contact (NO, normally open).
        Switch the current off and the spring pulls everything back.</p>
        <p>So a relay is a switch that another circuit throws: a small current in the coil closes contacts that carry a
        separate circuit, and that is all a logic gate needs. This is a telephone relay on 24 V, on a lumped physical model. It closes at
        ${ms(PULL.pull ?? 0)} V and opens only below ${ms(PULL.drop ?? 0)} V, and it is closed for good
        ${ms(RELAY_STEP_MS)} ms after the current is switched on, bounces included. That time is the
        <strong>relay step</strong> the rest of this chapter counts in.</p>
        <p>Two properties of the curve in the close-up carry the rest of the chapter. First, <strong>hysteresis</strong>: closing the
        armature across the open gap takes ${ms(PULL.pull ?? 0)} V, but once it is in, the gap is nearly gone and a
        fraction of the current holds it, so it lets go only at ${ms(PULL.drop ?? 0)} V. A supply that sags between the two
        changes nothing. And because the coil's own contact keeps the full supply on it, a relay can hold a bit (step 6); the hysteresis is margin on top. Second, <strong>time</strong>: the
        step is partly electrical (the coil's current has to build) and partly mechanical (an armature and blade of a few grams travel, and the blade bounces before it stays). The first touch is not the end of the step.</p>
        <div class="try">Drag the supply below the pull-in voltage, and play the switch-off. Then sweep the supply down and back up: the armature drops out at one voltage and pulls in at another.</div>`,
      more: {
        derive: `<p>The coil is ${RELAY.Rc} Ω on ${RELAY_SUPPLY} V: ${(1e3 * RELAY_SUPPLY / RELAY.Rc).toFixed(0)} mA and
          ${RELAY_COIL_POWER.toFixed(2)} W (V² / R). With N = ${RELAY.N} turns the magnetomotive force is N·I, and the flux is that
          divided by the reluctance of the magnetic circuit, dominated by the air gap: ${(RELAY.gOpen * 1e3).toFixed(2)} mm
          open, ${(RELAY.gRes * 1e3).toFixed(2)} mm of residual shim once closed. The pull goes as the flux squared, so as (N·I)² / gap²:
          closing the gap multiplies the force from one current by roughly ${(((RELAY.gOpen + RELAY.gRes + RELAY.gIron) / (RELAY.gOpen - RELAY.travel + RELAY.gRes + RELAY.gIron)) ** 2).toFixed(0)}
          before the iron saturates. The spring asks ${RELAY.F0.toFixed(1)} N at rest and ${(RELAY.F0 + RELAY.k * RELAY.travel).toFixed(1)} N at the
          end of the travel (${RELAY.k} N/m over ${(RELAY.travel * 1e3).toFixed(2)} mm). The thresholds the model finds from this force balance,
          ${ms(PULL.pull ?? 0)} V and ${ms(PULL.drop ?? 0)} V, are in the ratio ${((PULL.drop ?? 0) / (PULL.pull ?? 1)).toFixed(2)}.</p>
        <p>The model: the coil's current rises with a time constant L / R (the coil's inductance over its resistance), and L grows as
          the gap closes (the dip in the current is the armature moving); the contact blade is a mass that strikes and bounces. L / R is ${ms(coilTau(0) * 1e3)} ms with the armature open and ${(coilTau(RELAY.travel) * 1e3).toFixed(0)} ms once it is closed (the iron's inductance rises as the gap goes), so the armature starts to move about 3.5 ms after switch-on. Twice the voltage, four times the power, shortens the step by only about a quarter.</p>
        <p>At switch-off the coil's current has to go somewhere: here it discharges through a ${RELAY.Rq / 1e3} kΩ quench resistor across the coil, so the terminal voltage jumps to −R<sub>q</sub>·I. The close-up switches off at 15 ms, with the current still rising (about 29 mA of 60), which gives the −117 V; let the coil settle first (Off at 60 ms) and the same resistor sees 60 mA and −240 V.</p>`,
        pitfall: `<p>Reading the supply as the relay's state. Between ${ms(PULL.drop ?? 0)} V and ${ms(PULL.pull ?? 0)} V the relay may be open <em>or</em> closed:
          which one depends on where the voltage came from, so the curve in the close-up is a loop, not a line. The same trap hides in the
          bounce: the first touch is not the end of the step, and a circuit that reads the contact before ${ms(RELAY_STEP_MS)} ms sees
          pulses that are not data.</p>`,
        real: `<p>Telephone relays of this kind switch in 5 to 15 ms and are rated for around ${thin(CONTACT_LIFE / 1e6)} million
          operations under load. Reed relays, a pair of sealed ferromagnetic blades inside the coil, are around a millisecond and
          outlast them, but carry little current. Both lost to the transistor on speed, size and lifetime, not on logic.</p>`,
      },
      widget: () => relayCloseup(),
      challenge: {
        kind: 'quiz', question: 'Why does a relay machine\'s clock wait for the settled time and not for the first touch?',
        options: ['The contact bounces: until it stops, the line it switches flickers between 0 and 1', 'The coil keeps heating up', 'The first touch has too little current'],
        answer: 0,
        explain: 'The blade strikes the fixed contact and bounces off three times before it stays. Anything reading that line during the bounce sees a burst of pulses; a relay counter would count them all.',
        why: ['', 'Heating changes a coil\'s resistance over minutes. The relay step is about the blade coming to rest on its contact.', 'At the first touch the contact already carries the full current. The trouble is that it lifts off again.'],
      },
    },
    {
      title: 'The relay as a symbol',
      body: `
        <p>In a schematic <span data-show="r">a relay</span> is its coil (left) and its contacts (right), joined by a dashed line for the
        armature. The blade rests on NC; drive <span data-show="pin:a"><code>a</code></span> to 1 and it moves to NO. Not at once: the coil lights up
        first, and the blade follows one relay step later.</p>
        <p>Here the relay's break contact connects <span data-show="vdd">VDD</span> (the supply) to <span data-show="pin:y"><code>y</code></span>: y always takes the opposite of a. Every relay circuit in this
        chapter moves in relay steps, all relays together, and the status line counts them.</p>
        <p>This gate costs ${stats(RELAY_NOT).relays} relay and uses one of its poles (a pole is one set of contacts); the others could serve other gates reading the same signal.
        The output is a <em>connection to a rail</em>: whichever rail the contact touches, the line gets the supply's full voltage,
        so there is no level to degrade from gate to gate.</p>
        <div class="try">Toggle <code>a</code>, then use Step: the coil carries current a whole step before the contact moves.</div>`,
      scene: () => ({ root: RELAY_NOT, inputs: { a: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'Released', set: { a: 0 }, show: ['r', 'vdd'], expect: { y: 1 },
            say: '<p>a = 0: no current in the coil, the spring holds the blade on the break contact, which connects VDD to y: y = {v:y}.</p>' },
          { title: 'Operated', set: { a: 1 }, show: ['r', 'g'], expect: { y: 0 },
            say: `<p>a = 1: the coil pulls the armature in, the blade leaves the break contact and y is connected to nothing. The load (a coil, a resistor to ground) pulls it to {v:y}. The move takes one relay step, ${ms(RELAY_STEP_MS)} ms.</p>` },
          { title: 'Released again', set: { a: 0 }, show: ['r', 'vdd'], expect: { y: 1 },
            say: '<p>a back to 0: the coil releases, the spring wins, y = {v:y}. Releasing costs a step too: a relay machine counts both edges in relay steps.</p>' },
        ],
      },
      more: {
        derive: `<p>y = ¬a. One relay, one pole: the common is VDD, the break contact (NC) goes to y, the make contact (NO) is left open. Counting in
          relay steps, the output follows the input one step later: t(y) = t(a) + 1. Chaining n inverters takes n steps, since each coil
          waits for the previous contact to move. It is the rule of a gate delay (<a href="#/c/nand/0">chapter ${numOf('nand')}</a>), with a step of
          ${ms(RELAY_STEP_MS)} ms in place of ${PS_PER_NAND} ps.</p>`,
        pitfall: `<p>Expecting the output to change when the coil lights. The coil's line is the relay's <em>input</em>: it goes to 1 at once, and the
          contact follows a step later. In the schematic the coil lights first and the blade after it; a value read from y in between is the old one.</p>`,
      },
    },
    {
      title: 'Contacts conduct both ways',
      body: `
        <p>A contact is two pieces of metal touching. It passes whatever is on one side to the other, in both
        directions and at full strength, with no threshold to lose (the transistor of <a href="#/c/mosfet/0">chapter ${numOf('mosfet')}</a>,
        later in the book, does lose one). The contacts are also isolated from the coil that moves them: a line on a contact never
        disturbs the coil.</p>
        <p>An open contact leaves its line connected to nothing, so why does <code>y</code> read 0 here? Because in a
        relay machine every line ends on the <strong>coil</strong> of the next relay, and a coil is a resistor to ground:
        an undriven line is pulled to 0 through it. The <span data-show="ld"><em>load</em></span> drawn on <code>y</code> stands for that coil.
        That is relay logic's convention: <strong>voltage means 1, no connection means 0</strong>.</p>
        <p>This NAND (a gate whose output is 0 only when both inputs are 1) puts <span data-show="ra rb">the two relays'</span> break contacts in parallel from VDD: the output is connected unless both
        coils pull. A relay machine pays per <em>signal</em>, not per gate: each signal gets one coil, and that relay's
        ${RELAY_CONTACTS} poles are ${RELAY_CONTACTS} gate inputs reading it. A NAND-mapped machine needs about one relay
        per NAND output, plus one more for every ${RELAY_CONTACTS} readers past the first ${RELAY_CONTACTS}.</p>
        <div class="try">Set <code>a</code> and <code>b</code> to 1 and watch both blades leave VDD.</div>`,
      scene: () => ({ root: RELAY_NAND, inputs: { a: 0, b: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'Both released', set: { a: 0, b: 0 }, show: ['ra', 'rb', 'va', 'vb'], expect: { y: 1 },
            say: '<p>a = b = 0: both break contacts are closed, and both connect VDD to y. y = {v:y}.</p>' },
          { title: 'One operated', set: { a: 1 }, show: ['ra', 'rb'], expect: { y: 1 },
            say: '<p>a = 1: relay a leaves VDD, but b\'s contact still joins y to VDD, in parallel. y = {v:y}: one path is enough.</p>' },
          { title: 'Both operated', set: { b: 1 }, show: ['ra', 'rb', 'ld'], expect: { y: 0 },
            say: '<p>b = 1 too: no contact connects y to anything. The load, standing for the next coil, pulls it to {v:y}: an open line is a 0.</p>' },
          { title: 'Back to one', set: { a: 0 }, show: ['ra', 'va'], expect: { y: 1 },
            say: '<p>a = 0 again: a\'s contact is closed, VDD is back on y, y = {v:y}. Break contacts in parallel are a NAND: y = ¬(a·b).</p>' },
        ],
      },
      more: {
        derive: `<p>Break contacts in parallel connect y when ¬a + ¬b, which by De Morgan is ¬(a·b). A line with no path to VDD reads 0, so "connected" and
          "1" coincide. The gate is ${stats(RELAY_NAND).relays} relays. Counted per signal rather than per gate: each signal is one coil, and its ${RELAY_CONTACTS} poles
          are ${RELAY_CONTACTS} gate inputs, so a net read by k gates needs ⌈k / ${RELAY_CONTACTS}⌉ coils (the first and ${relayExtra(RELAY_CONTACTS + 1)} more past ${RELAY_CONTACTS} readers):
          k = ${RELAY_CONTACTS} needs ${1 + relayExtra(RELAY_CONTACTS)}, k = ${RELAY_CONTACTS + 1} needs ${1 + relayExtra(RELAY_CONTACTS + 1)}, k = ${2 * RELAY_CONTACTS + 1} needs ${1 + relayExtra(2 * RELAY_CONTACTS + 1)}.</p>`,
        real: `<p>In his 1937 MIT master's thesis, <em>A Symbolic Analysis of Relay and Switching Circuits</em>, Claude
          Shannon showed that Boolean algebra describes contact networks exactly: contacts in series are AND, in
          parallel OR, a break contact NOT. A relay circuit could now be written as an expression, simplified on paper
          and built with fewer contacts. The same year George Stibitz, at Bell Labs, wired two relays, two flashlight
          bulbs and strips cut from a tin can on his kitchen table into the <strong>Model K</strong>: a one-bit binary
          adder, sum and carry on the bulbs. It grew into Bell Labs' Complex Number Calculator (1940), which Stibitz
          drove from Dartmouth over a teleprinter line.</p>`,
        pitfall: `<p>Reading the output as Z when both relays pull. A relay line with no path to a rail is not floating: it ends on the next
          coil, a resistor to ground, so it reads 0. A simulator that treats open lines as Z needs the convention written down, here by the load drawn on y.</p>`,
      },
      tries: [(st) => st.value('y') === 0],
      challenge: {
        kind: 'quiz', question: 'With a = b = 1, no contact connects y to anything. What does a real relay machine read on y?',
        options: ['Z: a floating line has no value', '0: the next relay\'s coil pulls the line to ground', 'Whatever y was before'],
        answer: 1,
        why: ['Z belongs to a line nothing touches. In a relay machine every line ends on a coil, a resistor to ground.', '', 'Nothing stores a level on a relay line: the coil at its end pulls it to ground as soon as the contacts open.'],
        explain: 'Every line in a relay machine feeds a coil, and a coil is a resistor to ground. An open line carries no current: the next relay stays released, which is a 0.',
      },
    },
    {
      title: 'What contacts are good at',
      body: `
        <p>A changeover contact chooses between two lines. <span data-show="ra">Relay <code>a</code></span> puts VDD on one of two lines (L0 when
        released, L1 when operated), and <span data-show="rb">relay <code>b</code></span> connects the output to L1 when released and to L0 when operated. The output is 1 when
        exactly one of them pulled: an <strong>XOR</strong>, from two relays and one relay step.</p>
        <p>In <span data-ahead="cmos">CMOS (the transistor logic of chapters ${numOf('mosfet')} to ${numOf('nand')})</span>, through this site's NAND brick an XOR takes 4 NANDs (a dedicated cell, about 12 transistors). Changeover contacts make selection nearly
        free, which is where a relay does best.</p>
        <p>The XOR is ${stats(RELAY_XOR).relays} relays against ${stats(XOR).nands} NANDs (${stats(XOR).transistors} transistors, ${logicDepth(XOR)} gate delays) in the
        brick. The same contacts make a two-way selector or a comparator just as cheaply: here the unit of price is the pole, not the gate.</p>`,
      scene: () => ({ root: RELAY_XOR, inputs: { a: 1, b: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'Both released', set: { a: 0, b: 0 }, show: ['ra', 'rb'], expect: { y: 0 },
            say: '<p>a = b = 0: relay a puts VDD on its released line. Relay b, released, connects y to the other line, which has no voltage: y = {v:y}.</p>' },
          { title: 'a operated', set: { a: 1 }, show: ['ra', 'rb'], expect: { y: 1 },
            say: '<p>a = 1: VDD moves to the other line. Relay b is still released and connects y to it: y = {v:y}. The two lines are never both live.</p>' },
          { title: 'Both operated', set: { b: 1 }, show: ['ra', 'rb'], expect: { y: 0 },
            say: '<p>b = 1: relay b now connects y to the line that has no voltage while a is operated. y = {v:y}: equal inputs give 0.</p>' },
          { title: 'b alone', set: { a: 0 }, show: ['ra', 'rb'], expect: { y: 1 },
            say: '<p>a = 0, b = 1: VDD is back on the released line, which b connects to y: y = {v:y}. Different inputs give 1, one relay step after the change in every case.</p>' },
        ],
      },
      more: {
        derive: `<p>Relay a is a changeover: its common is VDD, and it feeds one of two lines, L0 = VDD·¬a or L1 = VDD·a. Relay b selects between them, so y is a 2:1 multiplexer
          with data inputs a and ¬a (released, b picks the line that is live when a = 1; operated, the other one): y = b ? ¬a : a = a ⊕ b, an XOR being a multiplexer with one input inverted.
          Cost: ${stats(RELAY_XOR).relays} relays and 1 relay step, against ${stats(XOR).nands} NANDs and ${logicDepth(XOR)} delays in CMOS.</p>`,
        pitfall: `<p>Using one line between the relays. A contact cannot invert, so "a is 0" needs a line of its own that has voltage exactly then.
          Drop it and y floats (reads 0) in half the rows. Count the lines per signal: dual rail is the price of selection.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why does the relay XOR need two lines between the relays, not one?',
        options: ['A contact can pass a line or not, but cannot invert it: the "not" has to be a second line', 'To halve the current in each contact', 'Two lines settle faster'],
        answer: 0,
        explain: 'Contacts only connect. An inversion exists where a coil drives a break contact; between two relays, the only way to carry "a is 0" is a separate line that has voltage exactly when a is 0.',
        why: ['', 'Only one line carries current at a time. The second line is there for the logic, not for the current.', 'Both lines are switched in the same relay step: the second adds no speed.'],
      },
    },
    {
      title: 'A carry that needs no time',
      body: `
        <p>Do the same with a full adder. <code>a</code> and <code>b</code> operate the relays; the carry does not. It
        arrives on two lines, c and its complement (exactly one has voltage), and passes <em>through</em> contacts to
        the carry out and the sum. <span data-show="fa0.ra">Relay A</span> has 5 poles, <span data-show="fa0.rb">relay B</span> 4; telephone relays carried a dozen.</p>
        <p><span data-show="fa0 fa1 fa2 fa3">Four of them</span> make this ${stats(ADD4).relays}-relay adder. When <code>a</code> and <code>b</code> change, the
        relays move once, together, and the carry crosses all four bits through closed contacts at the speed of the
        current. The status line says it: <strong>settled in 1 relay step</strong>, for any width. The <span data-ahead="ripple cmos">ripple-carry adder (each column waits for the carry of the one before; CMOS transistor gates)</span>
        of <a href="#/c/adders/0">chapter ${numOf('adders')}</a> is ${logicDepth(rca(4))} gate delays deep at 4 bits and ${logicDepth(rca(32))} at 32.</p>
        <p>Why it works: in a conventional adder a carry is a <em>value</em> that each column computes and passes on, and computing takes a
        gate delay. Here a carry is a <em>connection</em>. Each column's contacts decide, from its own two bits, whether the carry lines pass
        through (propagate), start fresh (generate) or are cut (kill); once those relays have moved, the lines through all columns are one
        piece of metal. The price is two relays per bit (${stats(ADD4).relays} in all) and relays with many poles.</p>
        <div class="try">Open one adder (double-click) to see its two relays. Then make the carry run through every bit.</div>`,
      scene: () => ({ root: ADD4, inputs: { a: 9, b: 5 }, animate: true }),
      ledger: { kind: 'add', a: 'a', b: 'b', sum: 's', width: 4, cout: 'co', col: (i) => [`fa${i}`] },
      tour: {
        beats: [
          { title: 'A sum, no ripple', set: { a: 9, b: 5 }, show: ['fa0', 'fa1', 'fa2', 'fa3'], expect: { s: 14, co: 0 },
            say: '<p>9 + 5 = {v:s}, carry out {v:co}. Every operand relay moved in the same relay step, and the carry crossed the columns that needed it through contacts already closed.</p>' },
          { title: 'Carry through all four', set: { a: 15, b: 1 }, show: ['fa0', 'fa1', 'fa2', 'fa3'], expect: { s: 0, co: 1 },
            say: '<p>15 + 1: bit 0 generates a carry and bits 1 to 3 propagate it. s = {v:s}, co = {v:co}, still one relay step after the inputs changed.</p>' },
          { title: 'A carry that is killed', set: { a: 7, b: 1 }, show: ['fa3'], expect: { s: 8, co: 0 },
            say: '<p>7 + 1: the carry reaches bit 3, where a = b = 0 kills it. s = {v:s}, co = {v:co}. Killing is a contact too: it ties the carry line to the "no carry" rail.</p>' },
          { title: 'Nothing to carry', set: { a: 15, b: 0 }, show: ['fa0'], expect: { s: 15, co: 0 },
            say: '<p>15 + 0: no column generates, so nothing runs. s = {v:s}, after the same single relay step as the long carry.</p>' },
        ],
      },
      more: {
        derive: `<p>Per column the carry out is c' = g + p·c with g = a·b (generate) and p = a ⊕ b (propagate). In contacts, g and p select which of the two carry
          lines connects to the next column: with p = 1 the incoming c passes through, with p = 0 the line is tied to g. Contacts pass the dual-rail carry both ways at full strength, so a chain of
          n columns is one electrical node once the operand relays have settled: 1 relay step for any n. In CMOS the ripple depth is ${logicDepth(rca(4))} gate delays at 4 bits and ${logicDepth(rca(32))} at 32 (2n + 4).</p>`,
        pitfall: `<p>Reading "1 relay step" as "instant". The carry beats the CMOS ripple in <em>steps</em>, but a step is ${ms(RELAY_STEP_MS)} ms, ${thin(RELAY_STEP_MS * 1e-3 / (PS_PER_NAND * 1e-12))} times a NAND delay.
          And a long chain of contacts in series is a long resistor: the adder cannot grow without bound, though the table, which counts relay steps only, does not show it.</p>`,
        numbers: `<table class="mini"><tr><th>bits</th><th>relays</th><th>relay adder</th><th>CMOS ripple, depth</th><th>CMOS ripple, time</th></tr>${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${stats(relayAdder(n)).relays}</td><td>${fmtTime(RELAY_STEP_MS * 1e-3)}</td><td>${logicDepth(rca(n))}</td><td>${fmtTime(logicDepth(rca(n))! * PS_PER_NAND * 1e-12)}</td></tr>`).join('')}</table>`,
      },
      challenge: {
        kind: 'reach', goal: 'Make a carry start in bit 0 and run through all four bits (the carry out lights up).',
        check: (st) => st.value('co') === 1 && (st.getInput('a') & st.getInput('b') & 1) === 1 && ((st.getInput('a') ^ st.getInput('b')) & 14) === 14,
        hints: [
          'A carry starts where both bits are 1. What must each higher bit hold to pass it on rather than start or stop one?',
          'Bit 0: a and b both 1. Bits 1 to 3: exactly one of a and b at 1 in each.',
        ],
        answer: 'a = 15, b = 1: bit 0 generates a carry, bits 1 to 3 each have exactly one 1 and pass it on; the sum is 0 with a carry out, one relay step after the inputs change.',
        solve: (st) => st.setInputs({ a: 15, b: 1 }),
      },
    },
    {
      title: 'Memory that holds itself',
      body: `
        <p>Feed <span data-show="k">a relay's coil</span> through its own make contact and it holds itself in: once pulled, it keeps its current
        flowing. <span data-show="rs"><code>set</code></span> starts it, <span data-show="rr"><code>reset</code></span> breaks the holding path. Set and reset are relays too: a
        push button is just a contact.</p>
        <p>Konrad Zuse's <strong>Z3</strong> (1941) stored 64 words of 22 bits this way, one relay per bit: 1408 of its
        2600 relays were memory. A <span data-ahead="cmos dff">CMOS flip-flop (a clocked one-bit memory made of transistor gates)</span> is ${stats(DFF).nands} NANDs; a relay bit is one relay. Memory was still the
        expensive part, which is why the Z3 had 64 words.</p>
        <p>The mechanism is feedback. While <code>set</code> is held, k operates. Its make contact now joins the holding line to its own coil, so the coil
        stays fed after <code>set</code> returns to 0. Reset cuts the holding line; with no current k falls, and its own contact opens behind it.
        With both held, <code>set</code> wins, since it feeds the coil directly while reset only cuts the holding path.</p>
        <div class="try">Set, let go, and the bit stays. Reset clears it. A pulse shorter than a relay step does
        nothing: the armature never got there.</div>`,
      scene: () => ({ root: RELAY_LATCH, inputs: { set: 0, reset: 0 }, animate: true }),
      tour: {
        beats: [
          { title: 'Set', set: { set: 1 }, show: ['rs', 'k'], expect: { q: 1 },
            say: '<p>set = 1: its relay pulls in and feeds k. k operates: q = {v:q}.</p>' },
          { title: 'Let go', set: { set: 0 }, show: ['k'], expect: { q: 1 },
            say: '<p>set = 0: the set relay releases, but k is now fed through its own make contact. q = {v:q} with both inputs at 0: a stored bit.</p>' },
          { title: 'Reset', set: { reset: 1 }, show: ['rr', 'k'], expect: { q: 0 },
            say: '<p>reset = 1: the reset relay opens the holding line. k loses its current, drops out, and its contact opens: q = {v:q}.</p>' },
          { title: 'Released: stays cleared', set: { reset: 0 }, show: ['k'], expect: { q: 0 },
            say: '<p>reset = 0: the holding line is whole again, but k\'s contact is open, so nothing feeds it. q = {v:q}: the 0 is held too.</p>' },
        ],
      },
      more: {
        derive: `<p>The next state is q⁺ = set + q·¬reset: set feeds the coil, or q does, unless reset cuts the holding line. That is the SR latch of
          <a href="#/c/latches/0">chapter ${numOf('latches')}</a> (set dominant here), in three relays (set, reset and the holding relay k) where the NAND version takes ${stats(SR_LATCH).nands} gates, though those relays also supply the set and reset inputs.
          Holding works because of the feedback: k's own contact keeps the full supply on its coil. Hysteresis adds margin: the bit survives a supply sagging to ${ms(PULL.drop ?? 0)} V, well below the pull-in (${ms(PULL.pull ?? 0)} V).</p>`,
        pitfall: `<p>Looking for a clock. There is none: the latch is level-sensitive, a set pulse shorter than a relay step does nothing (the armature never arrives),
          and a safe one lasts about two steps, since set's own relay must pull in before k's coil is fed. Note too that "both inputs at 0" does not say what q is: the state lives in k, not in the inputs.</p>`,
        real: `<p>The Z3 held 64 words of 22 bits in relays, one relay a bit: ${thin(Z3.memory)} of its ${thin(Z3.relays)} relays. A holding relay draws its coil current for as long as it
          holds, ${RELAY_POWER.toFixed(2)} W on average here, which is why relay memory stayed small.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Store a 1, with set and reset both back at 0.',
        check: (st) => st.value('q') === 1 && st.getInput('set') === 0 && st.getInput('reset') === 0,
        hints: [
          'Setting the bit is easy. The test is whether it stays once set is back at 0.',
          'q is k\'s coil line. Wait until k has pulled in: then one of its own contacts feeds its coil without set.',
        ],
        answer: 'Set to 1 and wait until k has pulled in (two relay steps: set pulls in and lights q, then k operates), then set back to 0: k holds itself through its own contact.',
        solve: (st) => { st.setInputs({ set: 1, reset: 0 }); st.sim?.settle(); st.setInputs({ set: 0 }); },
      },
    },
    {
      title: 'A relay that cannot stop',
      body: `
        <p>Now feed <span data-show="k">a coil</span> through its own <em>break</em> contact. Current flows, the armature pulls in, the contact
        opens, the current stops, the spring pulls it back, the contact closes. In our step model that is a square
        wave with a period of two relay steps. That is a doorbell's <strong>buzzer</strong>, and the simplest clock. A
        real one runs faster and lopsided: our relay takes ${ms(RELAY_STEP_MS)} ms to pull in and settle but releases
        ${ms(RELEASE_MS)} ms after its current stops, and its break contact opens before the armature has finished its
        travel.</p>
        <p>A relay machine needs a clock because contacts bounce and coils take time: every step must wait until the
        slowest relay has moved and stopped bouncing. Real machines used a motor-driven drum of cams to time their
        phases; the Z3 ran at about ${Z3.hz} Hz.</p>
        <p>It is also the first circuit here with no stable state: with <code>en</code> on, every state leads to the other. The simulator's relay step reports it
        as <em>unstable</em> and stops settling, as it does for any oscillator. A relay machine must keep such a loop out of every path it
        expects to settle; a clock is the one place it is wanted.</p>
        <div class="try">Switch <code>en</code> on and watch it run. The status line says it never settles.</div>`,
      scene: () => ({ root: RELAY_BUZZER, inputs: { en: 0 }, animate: true }),
      more: {
        derive: `<p>The relay obeys k⁺ = en·¬k: operated only while en is on and its break contact is still closed. With en = 1 that is k⁺ = ¬k, a toggle every relay
          step, so the period is 2 steps = ${ms(2 * RELAY_STEP_MS)} ms and the frequency 1 / (2 · ${ms(RELAY_STEP_MS)} ms) = ${BUZZ_HZ} Hz. The real relay releases in ${ms(RELEASE_MS)} ms
          against ${ms(RELAY_STEP_MS)} ms to operate, so its period is closer to ${ms(RELAY_STEP_MS + RELEASE_MS)} ms, about ${Math.round(1000 / (RELAY_STEP_MS + RELEASE_MS))} Hz, with the output high for ${(RELAY_STEP_MS / (RELAY_STEP_MS + RELEASE_MS)).toFixed(2)} of it.</p>`,
        pitfall: `<p>Using the buzzer as the clock of a relay machine. Its edges are one relay step apart, but the slowest relay of the machine needs a full step too: a clock
          that fast leaves no margin, and a bounce can read as an extra edge. Real machines used a cam drum with phases much longer than one step (the Z3 ran at about ${Z3.hz} Hz).</p>`,
        real: `<p>The electric bell and the buzzer are this circuit. Radio-era vibrators, which chopped a battery into
          AC for a transformer, did the same with a heavier armature, and wore out at the contacts, the limit the next step puts a number on.</p>`,
      },
      challenge: {
        kind: 'quiz', question: `In the step model a relay step takes ${ms(RELAY_STEP_MS)} ms. At what frequency does the buzzer run?`,
        options: ['About 60 Hz', 'About 120 Hz', 'About 8 Hz'], answer: 0,
        explain: `Two steps per period: ${ms(2 * RELAY_STEP_MS)} ms, about ${BUZZ_HZ} Hz, a hum. The real relay drops out faster than it pulls in (${ms(RELEASE_MS)} ms against ${ms(RELAY_STEP_MS)}), so a real buzzer runs a little faster, its wave lopsided. A <span data-ahead="cmos inverter">CMOS ring oscillator (a loop of three inverting transistor gates)</span> runs at gigahertz.`,
        why: ['', 'That is one relay step per period. The relay has to pull in and then drop out again: two steps.', `That reads the ${ms(RELAY_STEP_MS)} ms step as a frequency. A period is two steps, ${ms(2 * RELAY_STEP_MS)} ms.`],
      },
    },
    {
      title: 'What it costs',
      body: `
        <p>One relay here (a telephone relay on 24 V) draws <strong>${RELAY_COIL_POWER.toFixed(2)} W</strong> while its
        coil is on and takes <strong>${ms(RELAY_STEP_MS)} ms</strong> to move and stop bouncing. Its share of a rack is about
        ${fmtVolume(RELAY_VOLUME)}, and the Z3's tonne over its relays is ${fmtMass(RELAY_MASS)} a relay, frame and wiring
        included. A NAND in <span data-ahead="cmos">CMOS (the transistor logic of chapters ${numOf('mosfet')} to ${numOf('nand')})</span> switches in about ${PS_PER_NAND} ps on femtojoules and takes about ${NAND2_UM2} µm² of
        silicon.</p>
        <p>Contacts wear out. Every contact feeds a coil, and breaking a coil's current is breaking an inductor: its
        stored energy has to go somewhere, and what a quench path (the resistor across the coil, in the first step's layers) does not take arcs across
        the opening gap. Each arc pits one contact and plates metal onto the other. Contacts are rated for some ${thin(CONTACT_LIFE / 1e6)} million operations under load; a relay switching on
        every cycle of a ${Z3.hz} Hz clock spends that in about ${Math.round(CONTACT_LIFE / Z3.hz / 86400)} days. Dust and
        oxide films open contacts too: the "bug" taped into the log of a Mark II relay computer in 1947 was a moth caught in a relay.</p>
        <p>The Z3: ${thin(Z3.relays)} relays, about ${Z3.power / 1e3} kW, about a tonne, ${Z3_SPEED} (its clock about
        ${Z3.hz} Hz), its program read from punched film.
        <span data-show="fa0 fa1 fa2 fa3">The relay adder above</span> beats the <span data-ahead="ripple cmos">CMOS ripple adder (transistor gates, the carry passed from column to column)</span> in <em>steps</em> (1 against ${logicDepth(rca(32))} at 32 bits),
        and loses by eight orders of magnitude in time per step. That trade, and the tube's answer to it, is <a href="#/c/tubes/0">the next
        chapter</a>. <a href="#/c/silicon/0">Chapter ${numOf('silicon')}</a> prices the whole CPU you build in relays and tubes.</p>`,
      scene: () => ({ root: ADD4, inputs: { a: 15, b: 1 }, animate: true }),
      more: {
        derive: `<p>The 4-bit adder above is ${stats(ADD4).relays} relays. At ${RELAY_POWER.toFixed(2)} W average each (${RELAY_COIL_POWER.toFixed(2)} W with the coil on, on about half the time) it draws about
          ${(stats(ADD4).relays * RELAY_POWER).toFixed(1)} W and fills ${fmtVolume(stats(ADD4).relays * RELAY_VOLUME)}, ${fmtMass(stats(ADD4).relays * RELAY_MASS)}. The energy of one addition is power times the step,
          ${(stats(ADD4).relays * RELAY_POWER * RELAY_STEP_MS * 1e-3).toFixed(2)} J, against femtojoules for the same sum in CMOS. Contact life: ${thin(CONTACT_LIFE)} operations at a ${Z3.hz} Hz clock is ${Math.round(CONTACT_LIFE / Z3.hz / 86400)} days.</p>`,
        pitfall: `<p>Comparing steps across technologies without the step's length. A 1-step relay adder against a ${logicDepth(rca(4))}-step CMOS one reads as a win for the relay; the times say
          ${fmtTime(RELAY_STEP_MS * 1e-3)} against ${fmtTime(logicDepth(rca(4))! * PS_PER_NAND * 1e-12)}. Always carry the unit.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>step</th><th>device</th><th>average power per gate</th></tr>
          <tr><td>CMOS</td><td>${PS_PER_NAND} ps</td><td>4 transistors</td><td>femtojoules per switch</td></tr>
          <tr><td>Relay</td><td>${ms(RELAY_STEP_MS)} ms</td><td>1 coil and its contacts</td><td>${RELAY_POWER.toFixed(2)} W</td></tr></table>`,
      },
      challenge: {
        kind: 'quiz', question: 'A NAND-mapped relay machine needs about one relay per NAND. The 4-bit CPU of the examples is about 3357 NANDs without its program memory. With 1.44 W per coil and about half the coils on, it draws about:',
        options: ['2.4 kW', '240 W', '24 kW'], answer: 0,
        explain: `About 3357 relays (shared signals add a little) × 0.72 W ≈ 2.4 kW: a Z3. In <span data-ahead="cmos">CMOS, the transistor logic of chapters ${numOf('mosfet')} to ${numOf('nand')},</span> the same CPU draws milliwatts.`,
        why: ['', 'That would be 0.07 W per relay. A telephone coil draws 1.44 W while on, 0.72 W on average.', 'That would be 7 W per relay, five times a coil\'s full 1.44 W.'],
      },
    },
  ],
};
