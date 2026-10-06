import { FULL_ADDER, INV_CMOS, INV_PSEUDO, NAND, NMOS_SWITCH, NOR_CMOS, PMOS_SWITCH, rca } from '../lib';
import { journeyWidget } from '../widgets/journey';
import { mosfetWidget } from '../widgets/mosfet';
import { bench, type Chapter } from './types';

export const chMap: Chapter = {
  id: 'map', num: 0, title: 'The map', level: 'Overview',
  blurb: 'Where we are going, and how to look inside anything.',
  steps: [
    {
      title: 'From a switch to a processor',
      body: `
        <p>A modern processor is billions of tiny switches. Nobody understands it by staring at
        billions of switches. We understand it in <strong>levels</strong>: a few switches make a gate,
        a few gates make an adder, adders and registers make a processor.</p>
        <p>This journey climbs those levels one at a time. Every level is built <em>only</em> from the
        level below it, and nothing is hidden: every box you see is a <strong>transparent box</strong>.</p>
        <div class="note">The ladder on the right is the whole journey. The first rungs are ready; the
        rest are coming. Each rung lists what it is made of.</div>`,
      widget: () => journeyWidget(),
    },
    {
      title: 'Open the box',
      body: `
        <p>Here is a 4-bit adder. It adds two numbers <code>a</code> and <code>b</code>. Change them in the
        bar at the bottom (or click the pins) and watch the sum <code>s</code>.</p>
        <p>Now the important part: <strong>double-click any block to look inside it</strong>.
        An adder is made of full adders (<code>FA</code>). A full adder is made of NAND gates.
        A NAND gate is made of four transistors. Open one of those and you reach a single MOSFET.</p>
        <div class="try">Open <code>fa0</code>, then a NAND, then a transistor. Use the breadcrumbs above
        the circuit, or press <kbd>Esc</kbd>, to climb back up.</div>
        <p>Wires show their values: a glowing wire carries a <strong>1</strong>, a dim one a <strong>0</strong>.
        Thick blue wires are <em>buses</em> (several bits travelling together); their value is printed on them.
        Use the HEX / BIN / DEC switch in the top bar to change how buses are written.</p>`,
      scene: () => ({ root: rca(4), inputs: { a: 5, b: 3 } }),
      challenge: {
        kind: 'reach', goal: 'Make the adder output s = 15 (0xF) with the carry-out at 0.',
        check: (st) => st.value('s') === 15 && st.value('cout') === 0,
        answer: 'Any pair with a + b = 15 and cin = 0, for example a = 7, b = 8.',
        solve: (st) => st.setInputs({ a: 7, b: 8, cin: 0 }),
      },
    },
    {
      title: 'How the levels stack up',
      body: `
        <p>Look at the <strong>Info</strong> tab on the right: it counts what the adder costs. A 4-bit adder
        is 36 NAND gates, or 144 transistors. Select any part (single click) to see its own cost.</p>
        <p>Every number on this site is <em>measured</em> from the circuit itself, not quoted from a book.
        That includes the "gate delays": how many gates a signal must pass through, which sets how fast the
        circuit can go.</p>
        <p>The <strong>Verilog</strong> tab shows the same circuit as a hardware description. Chip designers
        write Verilog, and tools turn it into gates like these.</p>`,
      scene: () => ({ root: FULL_ADDER, inputs: { a: 1, b: 1, cin: 0 } }),
    },
  ],
};

export const chMosfet: Chapter = {
  id: 'mosfet', num: 1, title: 'The MOSFET', level: 'Transistors',
  blurb: 'A switch with no moving parts, controlled by a voltage.',
  steps: [
    {
      title: 'A switch made of silicon',
      body: `
        <p>Pure silicon barely conducts. Add a pinch of other atoms (<strong>doping</strong>) and you get
        <em>n-type</em> silicon, with spare electrons, or <em>p-type</em>, with "holes" where electrons are missing.</p>
        <p>An <strong>NMOS transistor</strong> is two n-type islands, the <em>source</em> and the <em>drain</em>,
        in a p-type substrate. Above the gap between them sits the <em>gate</em>, insulated by a layer of oxide
        only a few atoms thick.</p>
        <p>Raise the gate voltage and its electric field pulls electrons up against the oxide. Past a
        <strong>threshold voltage</strong> they form a thin <em>channel</em>, and current can flow from drain
        to source. Lower the gate and the channel disappears.</p>
        <div class="try">Drag the gate voltage slowly past the threshold (0.45 V) and watch the channel form.</div>`,
      widget: () => mosfetWidget({ type: 'n', allowTypeSwitch: false }),
    },
    {
      title: 'NMOS and PMOS',
      body: `
        <p>Swap every n for a p and you get a <strong>PMOS</strong> transistor. It conducts when its gate is
        <em>low</em>, and its channel is made of holes.</p>
        <p>For digital logic we stop caring about the exact current. A transistor is either
        <strong>on</strong> (conducting) or <strong>off</strong>:</p>
        <table><tr><th></th><th>gate = 0</th><th>gate = 1</th></tr>
        <tr><th>NMOS</th><td>off</td><td>on</td></tr><tr><th>PMOS</th><td>on</td><td>off</td></tr></table>
        <p>NMOS is good at pulling a wire down to 0 (ground). PMOS is good at pulling it up to 1 (VDD).
        That complementary pair is the C in <strong>CMOS</strong>.</p>`,
      widget: () => mosfetWidget({ type: 'p' }),
      challenge: {
        kind: 'quiz', question: 'A PMOS transistor has its gate at 0 V and its source at VDD. Is it on or off?',
        options: ['On: the gate is below the source by more than the threshold', 'Off: the gate is 0, so nothing happens', 'It depends on the drain voltage'],
        answer: 0, explain: 'PMOS turns on when the gate is pulled below its source. With the source at VDD and the gate at 0 V, it conducts strongly.',
      },
    },
    {
      title: 'One switch is not enough',
      body: `
        <p>Here is an NMOS between an output wire and ground. Toggle the gate <code>g</code>.</p>
        <p>With <code>g = 1</code> the transistor conducts and drags <code>out</code> down to <strong>0</strong>.
        With <code>g = 0</code> it lets go, and <code>out</code> is connected to <em>nothing</em>. It is
        <strong>floating</strong>, shown as <strong>Z</strong> (dashed purple). A floating wire is not 0. It
        is "whatever charge happened to be left there".</p>
        <div class="try">Double-click the transistor to see it in cross-section, switching live.</div>`,
      scene: () => ({ root: NMOS_SWITCH, inputs: { g: 0 } }),
      challenge: {
        kind: 'quiz', question: 'With g = 0, what value does "out" have?',
        options: ['0', '1', 'Z: it is not connected to anything'], answer: 2,
        explain: 'An off transistor is an open switch. Nothing drives the output, so it floats. To always have a valid output we need a second switch that pulls up.',
      },
    },
    {
      title: '…and its mirror image',
      body: `
        <p>A PMOS between VDD and the output does the opposite: <code>g = 0</code> pulls <code>out</code> up to
        <strong>1</strong>; <code>g = 1</code> leaves it floating.</p>
        <p>Each switch can only do half the job. The NMOS can make a 0 but not a 1; the PMOS a 1 but not a 0.
        Put them together and every input gets a firm answer. That is the next chapter.</p>`,
      scene: () => ({ root: PMOS_SWITCH, inputs: { g: 1 } }),
    },
  ],
};

export const chInverter: Chapter = {
  id: 'inverter', num: 2, title: 'The CMOS inverter', level: 'Transistors',
  blurb: 'Two complementary transistors: the first logic gate.',
  steps: [
    {
      title: 'Pull up, pull down',
      body: `
        <p>Stack a PMOS on top of an NMOS and tie their gates together. That is a <strong>CMOS inverter</strong>.</p>
        <ul><li><code>a = 0</code>: the PMOS conducts, the NMOS is off → <code>y</code> is pulled up to <strong>1</strong>.</li>
        <li><code>a = 1</code>: the NMOS conducts, the PMOS is off → <code>y</code> is pulled down to <strong>0</strong>.</li></ul>
        <p>The output is always the opposite of the input: <strong>y = NOT a</strong>. Conducting transistors
        are drawn with a solid glowing channel.</p>
        <div class="try">Toggle <code>a</code> and watch exactly one transistor turn on at a time.</div>`,
      scene: () => ({ root: INV_CMOS, inputs: { a: 0 } }),
      challenge: {
        kind: 'quiz', question: 'For a valid input (0 or 1), how many of the inverter\'s transistors conduct?',
        options: ['None', 'Exactly one', 'Both'], answer: 1,
        explain: 'Exactly one. So there is never a direct path from VDD to ground, and a CMOS gate draws (almost) no current while it is not switching. That is why your phone battery lasts a day, not a minute.',
      },
    },
    {
      title: 'Why this is brilliant',
      body: `
        <p>Three properties make CMOS the technology of every chip you own:</p>
        <ul>
        <li><strong>Restoring.</strong> The output is connected straight to VDD or ground, so a slightly weak input
        still produces a perfect output. Noise does not accumulate from gate to gate.</li>
        <li><strong>Almost no static power.</strong> One of the two paths is always open.</li>
        <li><strong>Power only when switching.</strong> Energy is spent charging and discharging the tiny
        capacitance of the wires and gates downstream. Fewer transitions means less power.</li>
        </ul>
        <p>Switch to the <strong>Truth table</strong> tab: it was computed by actually solving the transistor
        network for every input.</p>`,
      scene: () => ({ root: INV_CMOS, inputs: { a: 1 } }),
    },
    {
      title: 'The cheaper, hotter way: a pull-up',
      body: `
        <p>Replace the PMOS with a <strong>resistor</strong> to VDD and keep the NMOS: a
        <strong>pseudo-NMOS</strong> inverter. With <code>a = 0</code> the resistor pulls <code>y</code> to 1.
        With <code>a = 1</code> both paths conduct and the NMOS wins, because it is sized to be much stronger
        (<em>ratioed</em> logic; here a resistor is weaker than any transistor).</p>
        <p>What it costs: while <code>y = 0</code> a current flows from VDD through the resistor and the NMOS
        to ground, all the time, not just while switching. The low level is only as good as the ratio, and the
        rising edge is as slow as the resistor. What it saves: one device per input. An n-input NOR is n
        transistors and one resistor instead of 2n transistors, which is why wide NORs (PLA and ROM rows) and
        open-drain buses still pull up.</p>
        <div class="try">Toggle <code>a</code> and watch the NMOS override the pull-up. The truth table is the
        CMOS inverter's: same function, half the transistors, none of the standby savings.</div>`,
      scene: () => ({ root: INV_PSEUDO, inputs: { a: 1 } }),
      challenge: {
        kind: 'quiz', question: 'When does the pseudo-NMOS inverter draw current with its input held still?',
        options: ['Never', 'While a = 0', 'While a = 1', 'Always'], answer: 2,
        explain: 'While a = 1 the NMOS conducts and the resistor connects VDD to it: a resistive path from VDD to ground. With a = 0 the NMOS is open and no current flows once y has charged to 1.',
      },
    },
  ],
};

export const chNand: Chapter = {
  id: 'nand', num: 3, title: 'The NAND gate', level: 'Transistors → gates',
  blurb: 'Four transistors, and the only brick we will ever need.',
  steps: [
    {
      title: 'Two inputs',
      body: `
        <p>Give the inverter a second input. Put two PMOS transistors <em>in parallel</em> (either one can pull
        up) and two NMOS <em>in series</em> (both must conduct to pull down).</p>
        <p>The output is 0 only when <code>a</code> AND <code>b</code> are both 1. That is NOT-AND:
        <strong>NAND</strong>.</p>
        <table><tr><th>a</th><th>b</th><th>y</th></tr><tr><td>0</td><td>0</td><td>1</td></tr><tr><td>0</td><td>1</td><td>1</td></tr><tr><td>1</td><td>0</td><td>1</td></tr><tr><td>1</td><td>1</td><td>0</td></tr></table>
        <div class="try">Find the input where the series NMOS pair forms a complete path to ground.</div>`,
      scene: () => ({ root: NAND, inputs: { a: 1, b: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the NAND output 0.', check: (st) => st.value('y') === 0,
        answer: 'a = 1 and b = 1: both series NMOS conduct, connecting y to GND, and both PMOS are off.',
        solve: (st) => st.setInputs({ a: 1, b: 1 }),
      },
    },
    {
      title: 'NOR, for comparison',
      body: `
        <p>Swap the arrangement (PMOS in series, NMOS in parallel) and you get <strong>NOR</strong>:
        the output is 1 only when both inputs are 0.</p>
        <p>Both work, but chip designers prefer NAND. Holes move about two to three times slower than electrons, so
        PMOS transistors are weaker. NOR puts the weak PMOS devices <em>in series</em>, which makes its
        pull-up slow. NAND puts them in parallel. At the same speed, a NAND is smaller.</p>`,
      scene: () => ({ root: NOR_CMOS, inputs: { a: 0, b: 0 } }),
    },
    {
      title: 'One brick to build everything',
      body: `
        <p>NAND is <strong>functionally complete</strong>: every logic function, and therefore every computer,
        can be built from NAND gates alone. So that is what we will do. From now on every circuit on this site
        bottoms out in NANDs.</p>
        <p>Here is our NAND, now drawn with its standard symbol, the "D" shape with a bubble. This is our first
        <strong>abstraction</strong>: we stop drawing four transistors and draw one symbol.</p>
        <div class="note">Abstraction is a promise, not a disguise. Double-click the symbol whenever you want
        to see the four transistors again.</div>`,
      scene: () => ({ root: bench(NAND), inputs: { a: 1, b: 1 } }),
      challenge: {
        kind: 'quiz', question: 'How many transistors does a CMOS AND gate need, built the natural way?',
        options: ['4: same as NAND', '6: a NAND followed by an inverter', '2'], answer: 1,
        explain: 'A single CMOS stage always inverts, so AND = NAND + NOT = 4 + 2 = 6 transistors. Inverting gates are the cheap ones.',
      },
    },
  ],
};
