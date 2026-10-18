import { DFF, RELAY_BUZZER, RELAY_LATCH, RELAY_NAND, RELAY_NOT, RELAY_XOR, relayAdder, rca } from '../lib';
import { RELAY_COIL_POWER, RELAY_STEP_MS, relayStatic } from '../phys/relay';
import { logicDepth, stats } from '../sim/stats';
import { relayCloseup } from '../widgets/relay3d';
import type { Chapter } from './types';

const ADD4 = relayAdder(4);
const PULL = relayStatic();
const ms = (x: number) => x.toFixed(1);

export const chRelays: Chapter = {
  id: 'relays', num: 0, prologue: 'P1', title: 'Relays', level: 'Electromechanical',
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
      `Changeover contacts make selection nearly free: XOR is 2 relays and 1 step (in CMOS 4 NANDs, 3 delays). The adder's carry runs through closed contacts on two lines, c and its complement: 1 step at any width, against ${logicDepth(rca(32))} gate delays for a 32-bit CMOS ripple-carry adder.`,
      'A relay fed through its own make contact holds itself: one relay per bit (the Z3: 1 408 of its 2 600 relays). Fed through its own break contact it buzzes with a period of two relay steps, about 60 Hz.',
      `One relay draws ${RELAY_COIL_POWER.toFixed(2)} W while its coil is on. The Z3: about 4 kW, about a tonne, 5 additions a second.`,
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
        why: ['', 'A carry would ripple bit by bit if each bit had to operate a relay. Here it only passes through contacts.', 'That is the 32-bit ripple-carry adder built from NAND bricks, a relay per NAND: then the carry waits for a coil in every gate.'],
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
        <p>This is a telephone relay on 24 V, on a lumped model: the coil's current rises with L / R and L grows as
        the gap closes (the dip in the current is the armature moving); the pull goes as (N·I)² / gap² against a
        preloaded spring; the contact blade is a mass that strikes and bounces. It closes at
        ${ms(PULL.pull ?? 0)} V and opens only below ${ms(PULL.drop ?? 0)} V, and it is closed for good
        ${ms(RELAY_STEP_MS)} ms after the current is switched on, bounces included. That time is the
        <strong>relay step</strong> the rest of this chapter counts in.</p>
        <div class="try">Drag the supply below the pull-in voltage, and play the switch-off: the coil's current has to
        go somewhere.</div>`,
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
        <p>Here the relay's break contact connects <span data-show="vdd">VDD</span> to <span data-show="pin:y"><code>y</code></span>: an inverter. Every relay circuit in this
        chapter moves in relay steps, all relays together, and the status line counts them.</p>
        <div class="try">Toggle <code>a</code>, then use Step: the coil carries current a whole step before the contact moves.</div>`,
      scene: () => ({ root: RELAY_NOT, inputs: { a: 0 }, animate: true }),
    },
    {
      title: 'Contacts conduct both ways',
      body: `
        <p>A contact is two pieces of metal touching. It passes whatever is on one side to the other, in both
        directions and at full strength, with no threshold to lose. A MOSFET's channel is a switch too, but a relay's
        contacts are isolated from the coil that moves them: a line on a contact never disturbs the coil.</p>
        <p>An open contact leaves its line connected to nothing, so why does <code>y</code> read 0 here? Because in a
        relay machine every line ends on the <strong>coil</strong> of the next relay, and a coil is a resistor to ground:
        an undriven line is pulled to 0 through it. The <span data-show="ld"><em>load</em></span> drawn on <code>y</code> stands for that coil.
        That is relay logic's convention: <strong>voltage means 1, no connection means 0</strong>.</p>
        <p>This NAND puts <span data-show="ra rb">the two relays'</span> break contacts in parallel from VDD: the output is connected unless both
        coils pull. In relays the brick costs one relay per input; a relay with four poles serves four gates, so a
        NAND-mapped machine needs about one relay per NAND.</p>
        <div class="try">Set <code>a</code> and <code>b</code> to 1 and watch both blades leave VDD.</div>`,
      scene: () => ({ root: RELAY_NAND, inputs: { a: 0, b: 0 }, animate: true }),
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
        released, L1 when operated), and <span data-show="rb">relay <code>b</code></span> connects the output to the other one. The output is 1 when
        exactly one of them pulled: an <strong>XOR</strong>, from two relays and one relay step.</p>
        <p>In CMOS an XOR is 4 NANDs, 16 transistors, 3 gate delays deep. Changeover contacts make selection nearly
        free, and that is the honest comparison: each technology built in its own style, not one copying the other's
        gates.</p>`,
      scene: () => ({ root: RELAY_XOR, inputs: { a: 1, b: 0 }, animate: true }),
      challenge: {
        kind: 'quiz', question: 'Why does the relay XOR need two lines between the relays, not one?',
        options: ['A contact can pass a line or not, but cannot invert it: the "not" has to be a second line', 'To halve the current in each contact', 'Two lines settle faster'],
        answer: 0,
        explain: 'Contacts only connect. A NOT exists where a coil drives a break contact; between two relays, the only way to carry "a is 0" is a separate line that has voltage exactly when a is 0.',
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
        current. The status line says it: <strong>settled in 1 relay step</strong>, for any width. The CMOS ripple-carry
        adder of <a href="#/c/adders/0">chapter 6</a> is ${logicDepth(rca(4))} gate delays deep at 4 bits and ${logicDepth(rca(32))} at 32.</p>
        <div class="try">Open one adder (double-click) to see its two relays. Then make the carry run through every bit.</div>`,
      scene: () => ({ root: ADD4, inputs: { a: 9, b: 5 }, animate: true }),
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
        <p>Konrad Zuse's <strong>Z3</strong> (1941) stored 64 words of 22 bits this way, one relay per bit: 1 408 of its
        2 600 relays were memory. A CMOS flip-flop is ${stats(DFF).nands} NANDs; a relay bit is one relay. Memory was still the
        expensive part, which is why the Z3 had 64 words.</p>
        <div class="try">Set, let go, and the bit stays. Reset clears it. A pulse shorter than a relay step does
        nothing: the armature never got there.</div>`,
      scene: () => ({ root: RELAY_LATCH, inputs: { set: 0, reset: 0 }, animate: true }),
      challenge: {
        kind: 'reach', goal: 'Store a 1, with set and reset both back at 0.',
        check: (st) => st.value('q') === 1 && st.getInput('set') === 0 && st.getInput('reset') === 0,
        hints: [
          'Setting the bit is easy. The test is whether it stays once set is back at 0.',
          'q is k\'s coil line. Wait until k has pulled in: then one of its own contacts feeds its coil without set.',
        ],
        answer: 'Set to 1 and wait for q (two relay steps: set pulls in, then k), then set back to 0: k holds itself through its own contact.',
        solve: (st) => { st.setInputs({ set: 1, reset: 0 }); st.sim?.settle(); st.setInputs({ set: 0 }); },
      },
    },
    {
      title: 'A relay that cannot stop',
      body: `
        <p>Now feed <span data-show="k">a coil</span> through its own <em>break</em> contact. Current flows, the armature pulls in, the contact
        opens, the current stops, the spring pulls it back, the contact closes: a square wave with a period of two
        relay steps. That is a doorbell's <strong>buzzer</strong>, and the first clock.</p>
        <p>A relay machine needs a clock because contacts bounce and coils take time: every step must wait until the
        slowest relay has moved and stopped bouncing. Real machines used a motor-driven drum of cams to time their
        phases; the Z3 ran at about 5 Hz.</p>
        <div class="try">Switch <code>en</code> on and watch it run. The status line says it never settles.</div>`,
      scene: () => ({ root: RELAY_BUZZER, inputs: { en: 0 }, animate: true }),
      challenge: {
        kind: 'quiz', question: `A relay step takes ${ms(RELAY_STEP_MS)} ms. At what frequency does the buzzer run?`,
        options: ['About 60 Hz', 'About 120 Hz', 'About 8 Hz'], answer: 0,
        explain: 'Two steps per period: 16 ms, about 60 Hz. You hear it as a hum. A CMOS ring oscillator of three inverters runs at gigahertz.',
        why: ['', 'That is one relay step per period. The relay has to pull in and then drop out again: two steps.', `That reads the ${ms(RELAY_STEP_MS)} ms step as a frequency. A period is two steps, ${ms(2 * RELAY_STEP_MS)} ms.`],
      },
    },
    {
      title: 'What it costs',
      body: `
        <p>One relay here (a telephone relay on 24 V) draws <strong>${RELAY_COIL_POWER.toFixed(2)} W</strong> while its
        coil is on and takes <strong>${ms(RELAY_STEP_MS)} ms</strong> to move and stop bouncing. It weighs grams and fills a fist. A CMOS NAND switches in about
        25 ps on femtojoules and is a few square micrometres of silicon.</p>
        <p>The Z3: 2 600 relays, about 4 kW, about a tonne, 5 additions a second, its program read from punched film.
        <span data-show="fa0 fa1 fa2 fa3">The relay adder above</span> beats the CMOS ripple adder in <em>steps</em> (1 against ${logicDepth(rca(32))} at 32 bits),
        and loses by eight orders of magnitude in time per step. That trade, and the tube's answer to it, is <a href="#/c/tubes/0">the next
        chapter</a>. <a href="#/c/silicon/0">Chapter 25</a> prices the whole CPU you build in relays and tubes.</p>`,
      scene: () => ({ root: ADD4, inputs: { a: 15, b: 1 }, animate: true }),
      challenge: {
        kind: 'quiz', question: 'A NAND-mapped relay machine needs about one relay per NAND. The 4-bit CPU of the examples is about 3 400 NANDs without its ROM. With 1.44 W per coil and about half the coils on, it draws about:',
        options: ['2.4 kW', '240 W', '24 kW'], answer: 0,
        explain: 'About 3 400 relays (fan-out adds a little) × 0.72 W ≈ 2.4 kW: a Z3. In CMOS the same CPU draws milliwatts.',
        why: ['', 'That would be 0.07 W per relay. A telephone coil draws 1.44 W while on, 0.72 W on average.', 'That would be 7 W per relay, five times a coil\'s full 1.44 W.'],
      },
    },
  ],
};
