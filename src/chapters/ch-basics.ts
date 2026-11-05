// Chapter 0, Basics: what a reader needs before the first switch. A loop of wire, why two levels, counting on lamps, a
// rule as a table, a program as steps, and how this site draws a circuit. Numbers come from widgets/basics.ts.

import { rca } from '../lib';
import { LOOP, loopAmps, misreads, NOISE, TOY, lampCountWidget, loopWidget, noiseWidget, switchTableWidget, toyMachineWidget } from '../widgets/basics';
import type { Chapter } from './types';
import { numOf } from './order';

const amps = loopAmps(1), amps2 = loopAmps(2);
const two = misreads(2, NOISE.start), ten = misreads(10, NOISE.start);

export const chBasics: Chapter = {
  id: 'basics', num: numOf('basics'), label: 'Start', title: 'Before the switch', level: 'Basics',
  blurb: 'Voltage and current, two levels, binary, a truth table, a program: what the first switch needs.',
  goals: [
    'say why a lamp lights only on a closed loop, and what voltage and current measure',
    'explain why a computer reads a wire as one of two levels, not ten',
    'count to 15 on four lamps, and read a truth table',
    'step a four-instruction program through a small machine, and read a circuit drawn on this site',
  ],
  steps: [
    {
      title: 'A loop of wire',
      body: `
        <p class="note">Already at home with voltage, binary and truth tables? Go straight to <a href="#/c/map/0">the map</a>.</p>
        <p>A battery keeps one of its terminals at a higher <strong>voltage</strong> than the other: ${LOOP.volts} V here. Voltage
        is measured between two points, like a height difference. On its own it moves nothing.</p>
        <p>Charge moves, as a <strong>current</strong> measured in amperes (A), only around a closed loop: out of one terminal,
        through the wire and the lamp, back into the other. Close the switch and ${amps.toFixed(2)} A flows: the lamp's
        resistance, ${LOOP.ohms} Ω, sets how much (current = voltage ÷ resistance). Open the loop <em>anywhere</em> and the
        current is 0 everywhere at once: a switch on the far side does the same job as this one.</p>
        <p>The lamp turns that current into light and heat: power = voltage × current = ${(amps * LOOP.volts).toFixed(2)} W. Put
        two lamps in a row and each gets half the voltage; the current halves to ${amps2.toFixed(3)} A and each lamp glows
        at a quarter of the power.</p>
        <p>The return side of every loop is called <strong>ground</strong>: the 0 V that every other voltage on the site is
        measured from.</p>
        <div class="try">Close the switch. Then cut the return wire instead: the lamp goes out just the same.</div>
        <p>Every circuit on this site is loops like this one. What changes is the switch: in chapter 1 it becomes a switch
        that a voltage opens and closes, instead of a finger.</p>`,
      widget: () => loopWidget(),
    },
    {
      title: 'Two levels, not ten',
      body: `
        <p>A lit or dark lamp is information: one of two states. A wire can carry more than two: it could be at any voltage from
        0 to 1 V. So why do computers read a wire as only "low" or "high"?</p>
        <p>Because every real wire picks up <strong>noise</strong>: small, random changes from its neighbours, from heat, from
        the supply. Read as two levels, a wire is wrong only when the noise moves it more than halfway, 0.5 V. Read as ten
        levels a ninth of a volt apart, it is wrong after ${(1 / 18).toFixed(3)} V.</p>
        <p>With ±${NOISE.start} V of noise, ${NOISE.symbols} symbols arrive with ${two} misread at two levels and ${ten} at ten.
        Ten levels would carry ${Math.log2(10).toFixed(2)} bits a symbol against 1, but only on a wire nine times quieter.
        Two levels win: each wire carries one <strong>bit</strong>, 0 or 1, and a circuit can restore a weak 1 to a full one at
        every step, so noise never adds up.</p>
        <div class="try">Slide the noise up until the two-level wire starts to misread. Note how long ago the ten-level one did.</div>`,
      widget: () => noiseWidget(),
    },
    {
      title: 'Counting with lamps',
      body: `
        <p>One bit tells two things apart. Four bits, each on or off, give 2 × 2 × 2 × 2 = 16 patterns, enough for the numbers
        0 to 15.</p>
        <p>The rule that turns a pattern into a number is the one you use for decimal, with 2 in place of 10. In 305 the 3 is
        worth 3 × 100 because of where it sits. In binary each place is worth twice the one to its right: 1, 2, 4, 8. The lamps
        1011 are 8 + 0 + 2 + 1 = 11. This is <strong>positional notation</strong>, and every number in a computer is written
        this way.</p>
        <p>Count past 15 and four lamps run out: 15 + 1 needs a fifth lamp. With four, the count wraps round to 0, as a car's
        odometer does at 99 999. Chapter 5 turns this into arithmetic, negative numbers included.</p>
        <div class="try">Set the lamps to 6. Then count up and watch the place worth 1 flip on every step.</div>`,
      widget: () => lampCountWidget(),
    },
    {
      title: 'A rule as a table',
      body: `
        <p>Put two switches, A and B, in the loop. Wired in a row, current flows only when A <em>and</em> B are closed. Wired
        side by side, it flows when A <em>or</em> B is closed.</p>
        <p>Write closed as 1 and open as 0, lit as 1 and dark as 0. Two switches have four cases, so the whole behaviour of the
        circuit fits in a table of four rows: a <strong>truth table</strong>. It lists every input case and the output for
        each, and it is complete: nothing else can happen.</p>
        <p>A truth table is how this site says what a circuit must do. Every block from here to the finished computer has one, or is
        built from blocks that do, and the simulator checks each against its table. A circuit with n one-bit inputs has
        2<sup>n</sup> rows: 4 here, 256 for eight inputs.</p>
        <div class="try">Find the wiring and the switch settings that light the lamp with only B closed.</div>`,
      widget: () => switchTableWidget(),
      challenge: {
        kind: 'quiz',
        question: 'Two switches in a row, then a third switch C wired side by side with the pair. When is the lamp lit?',
        options: ['When A and B are both closed, or C is closed', 'Only when all three are closed', 'When any one of the three is closed', 'Only when C is closed'],
        answer: 0,
        explain: 'The pair is one path (both must close it); C is a second path beside it. Either path closes the loop.',
        why: [
          'Right: two paths side by side, one needing A and B, the other C.',
          'That would be all three in a row: one path through every switch.',
          'A alone leaves B open, so the pair\'s path is still broken.',
          'C is one way, but A and B closed together are another.',
        ],
      },
    },
    {
      title: 'A program is a list of steps',
      body: `
        <p>A computer does one small step at a time, and the list of steps is kept in its memory as numbers, like the data.
        That list is a <strong>program</strong>.</p>
        <p>The machine here is the 8-bit computer of Appendix C, with 16 words of memory. Its program adds two numbers: load the
        first into A, add the second, show the result on OUT, stop. The four steps sit in words 0 to 3; the numbers
        (${TOY.src.match(/\.byte (\d+)/g)?.map((x) => x.slice(6)).join(' and ')}) sit in words 4 and 5. Each step is one
        8-bit word: its first four bits say what to do, the last four usually say where.</p>
        <p>An arrow marks the next step to do. The machine keeps it in a
        <span data-ahead="pc">program counter (a small register holding the address of the next instruction; chapter 9 builds
        one)</span>. After each step the arrow moves on by one, unless the step says to jump elsewhere.</p>
        <div class="try">Do one step at a time until OUT shows ${TOY.outs[0]}. How many steps did it take?</div>
        <p>Everything that follows builds such a machine from the bottom: switches that remember, switches that add, switches
        that pick the next step.</p>`,
      widget: () => toyMachineWidget(),
    },
    {
      title: 'How to read a circuit here',
      body: `
        <p>Here is a 4-bit adder: it adds two numbers <code>a</code> and <code>b</code> of four bits each. Every circuit on the
        site is drawn and simulated like this one.</p>
        <p><strong>Wires show their values.</strong> A wire carrying a 1 glows and shows moving dots; a 0 is dim. A thicker
        wire is a <em>bus</em>: several bits travelling together, with their value printed on it. The HEX / BIN / DEC switch in
        the top bar picks how bus values are written. Each net has a colour of its own, so a wire can be followed by eye.</p>
        <p><strong>Inputs are yours.</strong> Click an input pin, or use the bar under the circuit, to change it; the outputs
        follow at once.</p>
        <p><strong>Every box opens.</strong> Double-click a block to look inside. The adder is made of four
        <span data-ahead="fulladder">full adders (each adds two bits and a carry; chapter 6 builds one)</span>, and
        each of those of <span data-ahead="nand">NAND gates (two-input gates whose output is 0 only when both inputs are 1;
        chapter 3 builds one from four transistors)</span>. The breadcrumbs above the circuit, or <kbd>Esc</kbd>, take you back
        up. A single click selects a part and shows what it costs.</p>
        <div class="try">Open <span data-show="fa0">the first block</span>, then one of its gates, then climb back with Esc.</div>`,
      scene: () => ({ root: rca(4), inputs: { a: 5, b: 3 } }),
      challenge: {
        kind: 'reach', goal: 'Make the carry out of the top (cout) 1: a sum too big for four bits.',
        check: (st) => st.value('cout') === 1,
        hints: ['Four bits hold 0 to 15. Which sums do not fit?', 'Any a + b of 16 or more sets cout.'],
        answer: 'Any a + b of 16 or more, for example a = 8, b = 8: the sum shows 0 and cout is 1 (16 = 1 0000).',
        solve: (st) => st.setInputs({ a: 8, b: 8 }),
      },
    },
  ],
  recap: {
    keep: [
      'Current flows only around a closed loop; voltage is measured between two points, from ground at 0 V.',
      'A wire carries one bit: two levels survive noise that would ruin ten, and can be restored at every step.',
      'n bits give 2<sup>n</sup> patterns; in binary each place is worth twice the one to its right.',
      'A truth table lists every input case and its output: the complete description of a circuit without memory.',
      'A program is a list of steps kept in memory as numbers, done one at a time from where an arrow points.',
    ],
    check: [
      {
        question: 'Four lamps show 1101 (the leftmost worth 8). What number is that?',
        options: ['13', '11', '1101', '14'],
        answer: 0,
        explain: '8 + 4 + 0 + 1 = 13.',
        why: ['Right: 8 + 4 + 1.', '11 is 1011: the places worth 4 and 2 are swapped.', 'That is the pattern read as a decimal number.', '14 is 1110.'],
      },
      {
        question: 'A switch on the return wire of a lamp\'s loop is opened. What happens?',
        options: ['The lamp goes out: the loop is broken', 'The lamp stays lit: the return wire is only ground', 'The lamp dims to half', 'The battery\'s voltage drops to 0'],
        answer: 0,
        explain: 'Current needs the whole loop. Breaking it anywhere stops it everywhere.',
        why: ['Right.', 'Ground is still part of the loop; current must come back through it.', 'Dimming needs a second resistance in the loop, not a break.', 'The battery still holds its voltage; no current flows, so nothing is used.'],
      },
      {
        question: 'Why does a computer read each wire as two levels rather than ten?',
        options: ['Two levels tolerate far more noise, and can be restored at every step', 'Ten levels cannot be made with transistors', 'Binary arithmetic is the only kind that works', 'Two levels carry more information per wire'],
        answer: 0,
        explain: 'Halfway between two levels is a wide margin; between ten it is a narrow one.',
        why: ['Right.', 'Multi-level circuits exist (flash memory stores 2 to 4 bits a cell); they need careful, slow reading.', 'Arithmetic works in any base; binary is chosen for the wires.', 'Ten levels carry more per symbol, about 3.3 bits, which is exactly what they pay for in noise margin.'],
      },
    ],
    practise: ['n_bin'],
  },
};
