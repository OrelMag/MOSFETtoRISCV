import { RELAY_BUZZER, RELAY_LATCH, RELAY_NAND, RELAY_NOT, RELAY_XOR, relayAdder, rca } from '../lib';
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
      },
    },
    {
      title: 'The relay as a symbol',
      body: `
        <p>In a schematic a relay is its coil (left) and its contacts (right), joined by a dashed line for the
        armature. The blade rests on NC; drive <code>a</code> to 1 and it moves to NO. Not at once: the coil lights up
        first, and the blade follows one relay step later.</p>
        <p>Here the relay's break contact connects VDD to <code>y</code>: an inverter. Every relay circuit in this
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
        an undriven line is pulled to 0 through it. The <em>load</em> drawn on <code>y</code> stands for that coil.
        That is relay logic's convention: <strong>voltage means 1, no connection means 0</strong>.</p>
        <p>This NAND puts the two relays' break contacts in parallel from VDD: the output is connected unless both
        coils pull. In relays the brick costs one relay per input; a relay with four poles serves four gates, so a
        NAND-mapped machine needs about one relay per NAND.</p>
        <div class="try">Set <code>a</code> and <code>b</code> to 1 and watch both blades leave VDD.</div>`,
      scene: () => ({ root: RELAY_NAND, inputs: { a: 0, b: 0 }, animate: true }),
      challenge: {
        kind: 'quiz', question: 'With a = b = 1, no contact connects y to anything. What does a real relay machine read on y?',
        options: ['Z: a floating line has no value', '0: the next relay\'s coil pulls the line to ground', 'Whatever y was before'],
        answer: 1,
        explain: 'Every line in a relay machine feeds a coil, and a coil is a resistor to ground. An open line carries no current: the next relay stays released, which is a 0.',
      },
    },
    {
      title: 'What contacts are good at',
      body: `
        <p>A changeover contact chooses between two lines. Relay <code>a</code> puts VDD on one of two lines (L0 when
        released, L1 when operated), and relay <code>b</code> connects the output to the other one. The output is 1 when
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
      },
    },
    {
      title: 'A carry that needs no time',
      body: `
        <p>Do the same with a full adder. <code>a</code> and <code>b</code> operate the relays; the carry does not. It
        arrives on two lines, c and its complement (exactly one has voltage), and passes <em>through</em> contacts to
        the carry out and the sum. Relay A has 5 poles, relay B 4; telephone relays carried a dozen.</p>
        <p>Four of them make this ${stats(ADD4).relays}-relay adder. When <code>a</code> and <code>b</code> change, the
        relays move once, together, and the carry crosses all four bits through closed contacts at the speed of the
        current. The status line says it: <strong>settled in 1 relay step</strong>, for any width. The CMOS ripple-carry
        adder of chapter 6 is ${logicDepth(rca(4))} gate delays deep at 4 bits and ${logicDepth(rca(32))} at 32.</p>
        <div class="try">Open one adder (double-click) to see its two relays. Then make the carry run through every bit.</div>`,
      scene: () => ({ root: ADD4, inputs: { a: 9, b: 5 }, animate: true }),
      challenge: {
        kind: 'reach', goal: 'Make a carry start in bit 0 and run through all four bits (the carry out lights up).',
        check: (st) => st.value('co') === 1 && (st.getInput('a') & st.getInput('b') & 1) === 1 && ((st.getInput('a') ^ st.getInput('b')) & 14) === 14,
        answer: 'a = 15, b = 1: bit 0 generates a carry, bits 1 to 3 each have exactly one 1 and pass it on; the sum is 0 with a carry out, one relay step after the inputs change.',
        solve: (st) => st.setInputs({ a: 15, b: 1 }),
      },
    },
    {
      title: 'Memory that holds itself',
      body: `
        <p>Feed a relay's coil through its own make contact and it holds itself in: once pulled, it keeps its current
        flowing. <code>set</code> starts it, <code>reset</code> breaks the holding path. Set and reset are relays too: a
        push button is just a contact.</p>
        <p>Konrad Zuse's <strong>Z3</strong> (1941) stored 64 words of 22 bits this way, one relay per bit: 1 408 of its
        2 600 relays were memory. A CMOS flip-flop is about 15 NANDs; a relay bit is one relay. Memory was still the
        expensive part, which is why the Z3 had 64 words.</p>
        <div class="try">Set, let go, and the bit stays. Reset clears it. A pulse shorter than a relay step does
        nothing: the armature never got there.</div>`,
      scene: () => ({ root: RELAY_LATCH, inputs: { set: 0, reset: 0 }, animate: true }),
      challenge: {
        kind: 'reach', goal: 'Store a 1, with set and reset both back at 0.',
        check: (st) => st.value('q') === 1 && st.getInput('set') === 0 && st.getInput('reset') === 0,
        answer: 'Set to 1 and wait for q (two relay steps: set pulls in, then k), then set back to 0: k holds itself through its own contact.',
        solve: (st) => { st.setInputs({ set: 1, reset: 0 }); st.sim?.settle(); st.setInputs({ set: 0 }); },
      },
    },
    {
      title: 'A relay that cannot stop',
      body: `
        <p>Now feed a coil through its own <em>break</em> contact. Current flows, the armature pulls in, the contact
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
      },
    },
    {
      title: 'What it costs',
      body: `
        <p>One relay here (a telephone relay on 24 V) draws <strong>${RELAY_COIL_POWER.toFixed(2)} W</strong> while its
        coil is on and takes <strong>${ms(RELAY_STEP_MS)} ms</strong> to move and stop bouncing. It weighs grams and fills a fist. A CMOS NAND switches in about
        25 ps on femtojoules and is a few square micrometres of silicon.</p>
        <p>The Z3: 2 600 relays, about 4 kW, about a tonne, 5 additions a second, its program read from punched film.
        The relay adder above beats the CMOS ripple adder in <em>steps</em> (1 against ${logicDepth(rca(32))} at 32 bits),
        and loses by eight orders of magnitude in time per step. That trade, and the tube's answer to it, is the next
        chapter. Chapter 25 prices the whole CPU you build in relays and tubes.</p>`,
      scene: () => ({ root: ADD4, inputs: { a: 15, b: 1 }, animate: true }),
      challenge: {
        kind: 'quiz', question: 'A NAND-mapped relay machine needs about one relay per NAND. The 4-bit CPU of the examples is about 3 400 NANDs without its ROM. With 1.44 W per coil and about half the coils on, it draws about:',
        options: ['2.4 kW', '240 W', '24 kW'], answer: 0,
        explain: 'About 3 400 relays (fan-out adds a little) × 0.72 W ≈ 2.4 kW: a Z3. In CMOS the same CPU draws milliwatts.',
      },
    },
  ],
};
