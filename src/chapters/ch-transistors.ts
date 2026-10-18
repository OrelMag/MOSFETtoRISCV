import { FULL_ADDER, INV_CMOS, INV_PSEUDO, NAND, NMOS_SWITCH, NOR_CMOS, PMOS_SWITCH, rca } from '../lib';
import {
  NAND2_UM2, PLATE_FANOUT, RELAY_CONTACTS, RELAY_MASS, RELAY_POWER, RELAY_VOLUME, TECH, TUBE_BRICK_POWER, fmtMass, fmtTime, fmtVolume,
} from '../lib/tech';
import { RELAY_STEP_MS } from '../phys/relay';
import { TUBE_STEP_US } from '../phys/triode';
import { logicDepth } from '../sim/stats';
import { PS_PER_NAND } from '../sim/timing';
import { journeyWidget } from '../widgets/journey';
import { techCompareWidget } from '../widgets/techcompare';
import { mosCostWidget } from '../widgets/moscost';
import { mosfetWidget } from '../widgets/mosfet';
import { mosRegionsWidget } from '../widgets/mosregions';
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
        <div class="note">The ladder on the right is the whole journey. Each rung lists what it is made of;
        a click opens the chapter that builds it.</div>`,
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
  blurb: 'A switch with no moving parts, controlled by a voltage: its three regions, and what one switch costs in time and energy.',
  goals: [
    'say how a gate voltage past the threshold Vt (0.45 V here) turns a depletion layer into a conducting channel',
    'tell cut-off, linear and saturation apart from Vgs, Vds and Vt, and give the current in each',
    'state which gate level turns an NMOS on and which a PMOS, and which rail each pulls a wire to',
    'estimate a switch\'s delay as C·ΔV / I and its energy per swing as C·V²',
  ],
  recap: {
    keep: [
      'An NMOS is two n-type islands (source, drain) in p-type silicon under an insulated gate. Past the threshold Vt (0.45 V in the model here, a 1.8 V device) extra gate charge pulls electrons into a channel between them.',
      'Cut-off: Vgs &lt; Vt, no current. Linear: Vds &lt; Vgs − Vt, a resistor. Saturation: Vds ≥ Vgs − Vt, the drain end pinches off and Id = k·(Vgs − Vt)²/2, set by the gate alone. A falling output passes through saturation, so that current sets the speed.',
      'NMOS conducts on a 1 and pulls a wire down to 0; PMOS conducts on a 0 and pulls it up to 1. Either one alone leaves its output floating (Z) for the other input value.',
      'Delay ≈ C·ΔV / I, energy ≈ C·V² per full swing, half lost in each network. With 1 fF per gate, an output driving two inputs (5 fF) falls to half in about 21 ps for 16 fJ a swing: the order of the site\'s 25 ps per gate delay.',
      'Widening a transistor buys current (less delay) and adds load to the stage before it. Dynamic power is P ≈ α·C·V²·f.',
    ],
    practise: ['t_inv'],
    check: [
      {
        question: 'An NMOS (Vt = 0.45 V) has Vgs = 0.9 V and Vds = 1.2 V. Which region is it in?',
        options: ['Linear', 'Saturation', 'Cut-off'],
        answer: 1,
        explain: 'Vgs − Vt = 0.45 V and Vds = 1.2 V is above it: the drain end of the channel has pinched off.',
        why: ['Linear needs Vds below Vgs − Vt, here 0.45 V. A large Vgs does not make it linear; the overdrive against Vds does.', '', 'Cut-off needs Vgs below Vt. At 0.9 V a channel exists at the source end.'],
      },
      {
        question: 'An NMOS has Vgs = 0.95 V and Vds = 1.5 V (Vt = 0.45 V). Vgs rises to 1.45 V, Vds unchanged, and it stays in saturation. The drain current becomes about:',
        options: ['Twice as large', 'Four times as large', 'The same: in saturation the current no longer depends on the voltages'],
        answer: 1,
        explain: 'Id = k·(Vgs − Vt)²/2: the overdrive doubles from 0.5 V to 1.0 V, so the current grows four times (the λ factor is unchanged, since Vds is).',
        why: ['The current goes as the square of the overdrive Vgs − Vt, not as Vgs.', '', 'Saturation makes the current (nearly) independent of Vds. The gate still sets it.'],
      },
      {
        question: 'An output\'s load grows from 5 fF to 10 fF, and its transistor is made twice as wide. Its energy per 0 → 1 → 0 swing becomes:',
        options: ['About twice as large', 'The same: the wider transistor makes up for it', 'Four times as large'],
        answer: 0,
        explain: 'Energy per swing is C·V²: it follows the load alone. The wider transistor doubles the current, so the delay, C·ΔV / I, stays the same.',
        why: ['', 'Width buys current, which shortens the delay. The charge moved per swing, C·V, still doubles.', 'Energy goes as V², not as C²: doubling C doubles it.'],
      },
    ],
  },
  steps: [
    {
      title: 'A switch made of silicon',
      body: `
        <p>Pure silicon barely conducts. Add a pinch of other atoms (<strong>doping</strong>) and you get
        <em>n-type</em> silicon, with spare electrons, or <em>p-type</em>, with "holes" where electrons are missing.</p>
        <p>An <strong>NMOS transistor</strong> is two n-type islands, the <em>source</em> and the <em>drain</em>,
        in a p-type substrate. Above the gap between them sits the <em>gate</em>, insulated by a layer of oxide
        a few nanometres thick.</p>
        <p>Raise the gate voltage and its field first pushes holes away from the oxide, leaving a
        <em>depletion</em> layer. Past the <strong>threshold voltage</strong> Vt the depletion stops growing:
        extra gate charge pulls electrons up into a thin <em>channel</em> instead, and current can flow from
        drain to source. Lower the gate and the channel disappears.</p>
        <p>Everything on the right is computed from the classic square-law model: once the channel exists,
        the drain current Id = k·(Vgs − Vt)²/2 in saturation (Vgs: the gate-to-source voltage), with k = 220 µA/V² and Vt = 0.45 V, a plausible small device at
        1.8 V. The channel's thickness is its charge, and each carrier moves at the local field.</p>
        <div class="try">Press <strong>Sweep</strong>, or drag the gate past 0.45 V: the depletion layer grows
        then stops, electrons (filled dots; holes are rings) rise into a channel, and the current leaves zero.
        Then raise the drain and watch the channel taper toward it.</div>`,
      widget: () => mosfetWidget({ type: 'n', allowTypeSwitch: false }),
    },
    {
      title: 'Three regions',
      body: `
        <p>The channel holds Vgs − Vt of charge at the source but only Vgs − Vt − Vds at the drain, so it
        tapers. Hold the gate and raise the drain:</p>
        <ul><li><strong>Linear</strong> (Vds, the drain-to-source voltage, &lt; Vgs − Vt): the current grows with Vds, Id = k·((Vgs − Vt)·Vds − Vds²/2).
        The channel is a resistor.</li>
        <li><strong>Saturation</strong> (Vds ≥ Vgs − Vt): the drain end <strong>pinches off</strong>, and the
        current hardly grows: Id = k·(Vgs − Vt)²/2. A current source set by the gate alone. The same current
        through a thinner channel means faster carriers, and they race across the pinched-off gap.</li>
        <li><strong>Cut-off</strong> (Vgs &lt; Vt): no channel, no current.</li></ul>
        <p>Both formulas carry a factor (1 + λ·Vds), λ = 0.05/V: the pinch-off point creeps toward the source
        as Vds rises, shortening the channel. Applying it in both regions keeps the current continuous at the
        boundary.</p>
        <p>Digital logic lives at the ends: off is cut-off. A gate pulling its output from 1.8 V to 0 V passes
        through saturation first, then linear, so the saturation current decides how fast it switches.</p>
        <div class="try">Press <strong>Sweep drain</strong>: the dot runs along one curve and crosses the dashed
        boundary as the channel pinches off.</div>`,
      widget: () => mosRegionsWidget(),
      challenge: {
        kind: 'quiz', question: 'An NMOS has Vgs = 1.2 V and Vds = 0.3 V (Vt = 0.45 V). Which region is it in?',
        options: ['Linear', 'Saturation', 'Cut-off'], answer: 0,
        explain: 'Vgs − Vt = 0.75 V, and Vds = 0.3 V is below it, so the channel reaches the drain without pinching off: linear. Raise Vds past 0.75 V and it saturates.',
        why: ['', 'Saturation needs Vds ≥ Vgs − Vt = 0.75 V. At 0.3 V the channel still reaches the drain.', 'Cut-off needs Vgs below Vt. 1.2 V is well above 0.45 V.'],
      },
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
        why: ['', 'That is the NMOS rule. A PMOS conducts when its gate sits below its source, and 0 V is the whole supply below VDD.', 'The drain sets how much current flows (the region). Whether a channel exists is set by the gate against the source.'],
      },
    },
    {
      title: 'What one switch costs',
      body: `
        <p>A transistor never drives a bare wire. Its output carries the gates of the next transistors, each a
        small capacitor (gate over oxide over channel). Switching means moving that charge: the output falls at
        <strong>dV/dt = −I / C</strong>.</p>
        <p>So the delay is about <strong>C·ΔV / I</strong>, and every full swing, 0 → 1 → 0, draws
        <strong>C·V²</strong> from the supply: half of it lost in the pull-up, half in the pull-down. A wider
        transistor (more of them in parallel) carries more current and switches faster, but its own gate is
        that much more load for the stage before it.</p>
        <p>With 1 fF per unit gate (illustrative, the order of a small device), one output driving two inputs
        carries 5 fF and falls to half in about 21 ps, for 16 fJ a swing. The site counts time in gate delays
        and converts them at an illustrative 25 ps each: this is where that order of magnitude comes from.
        Multiply the energy by how often a node switches and by the clock frequency and you have dynamic power,
        P ≈ α·C·V²·f, which the power estimates later in the journey count from the simulation.</p>
        <div class="try">Change the width and the fan-out. Delay follows C / I; energy follows C alone.</div>`,
      widget: () => mosCostWidget(),
      challenge: {
        kind: 'quiz', question: 'An output drives 2 inputs (5 fF: 2 × 2 gates + 1 fF of wire). It is rewired to drive 4. Its delay becomes about:',
        options: ['The same: the transistor did not change', '1.8 times longer', 'Twice as long'], answer: 1,
        explain: 'The load grows from 5 fF to 9 fF (the wire stays 1 fF) and the current is unchanged, so the delay, C·ΔV / I, grows by 9 / 5 = 1.8.',
        why: ['The transistor sets the current I, but the delay is C·ΔV / I, and C grew.', '', 'Only the gate load doubles, from 4 fF to 8 fF. The 1 fF of wire stays, so C grows by 9 / 5.'],
      },
    },
    {
      title: 'One switch is not enough',
      body: `
        <p>Here is <span data-show="n1">an NMOS</span> between an output wire and <span data-show="gnd">ground</span>. Toggle the gate <span data-show="pin:g"><code>g</code></span>.</p>
        <p>With <code>g = 1</code> the transistor conducts and drags <span data-show="pin:out"><code>out</code></span> down to <strong>0</strong>.
        With <code>g = 0</code> it lets go, and <code>out</code> is connected to <em>nothing</em>. It is
        <strong>floating</strong>, shown as <strong>Z</strong> (dashed purple). A floating wire is not 0. It
        is "whatever charge happened to be left there".</p>
        <div class="try">Double-click the transistor to see it in cross-section, switching live (the gate ramps as the bit flips).</div>`,
      scene: () => ({ root: NMOS_SWITCH, inputs: { g: 0 } }),
      challenge: {
        kind: 'quiz', question: 'With g = 0, what value does "out" have?',
        options: ['0', '1', 'Z: it is not connected to anything'], answer: 2,
        explain: 'An off transistor is an open switch. Nothing drives the output, so it floats. To always have a valid output we need a second switch that pulls up.',
        why: ['0 is a driven level: it needs a conducting path to ground, and the only one is open.', 'Nothing in this circuit connects out to VDD, so nothing can make a 1.', ''],
      },
    },
    {
      title: '…and its mirror image',
      body: `
        <p><span data-show="p1">A PMOS</span> between <span data-show="vdd">VDD</span> and the output does the opposite: <code>g = 0</code> pulls <code>out</code> up to
        <strong>1</strong>; <code>g = 1</code> leaves it floating.</p>
        <p>Each switch can only do half the job. The NMOS can make a 0 but not a 1; the PMOS a 1 but not a 0.
        Put them together and every input gets a firm answer. That is <a href="#/c/inverter/0">the next chapter</a>.</p>`,
      scene: () => ({ root: PMOS_SWITCH, inputs: { g: 1 } }),
    },
  ],
};

export const chInverter: Chapter = {
  id: 'inverter', num: 2, title: 'The CMOS inverter', level: 'Transistors',
  blurb: 'Two complementary transistors: the first logic gate.',
  goals: [
    'build an inverter from one PMOS pull-up and one NMOS pull-down sharing a gate',
    'say why a CMOS gate draws almost no current while its input holds still',
    'name the three properties that made CMOS win: restoring levels, no static path, power only when switching',
    'price a pseudo-NMOS gate against CMOS: one device fewer per input, current while its output is 0',
  ],
  builds: ['mosfet'],
  recap: {
    keep: [
      'CMOS inverter: a PMOS from VDD to y, an NMOS from y to GND, both gates on a. For a valid input exactly one conducts, so y = NOT a.',
      'With the input still there is no path from VDD to ground: static power is almost zero. Energy goes into charging the capacitance downstream, at each transition.',
      'The output connects straight to a rail, so a slightly weak input still gives a full output: noise does not accumulate from gate to gate.',
      'Pseudo-NMOS: a resistor pull-up against a stronger NMOS (ratioed logic). An n-input NOR is n transistors and a resistor instead of 2n transistors, paid for with current while y = 0, a low level only as good as the ratio and a slow rising edge.',
    ],
    practise: ['t_inv'],
    check: [
      {
        question: 'How many devices does a three-input NOR take in pseudo-NMOS, and in CMOS?',
        options: ['3 transistors and a resistor, against 6 transistors', '4 transistors, against 6', '3 transistors and a resistor, against 4 transistors'],
        answer: 0,
        explain: 'Pseudo-NMOS keeps the n parallel NMOS and replaces the whole PMOS network with one resistor: n + 1 devices against 2n.',
        why: ['', 'The pull-up is a resistor, not a transistor: pseudo-NMOS removes the PMOS network entirely.', 'A CMOS gate needs one PMOS per input as well as one NMOS per input: 2n = 6.'],
      },
      {
        question: 'Where does a CMOS inverter spend its energy?',
        options: ['Charging and discharging the capacitance it drives, at each transition', 'In a current from VDD to ground while y = 0', 'In the PMOS, for as long as y = 1'],
        answer: 0,
        explain: 'One network is always open, so with the input still no current flows. Each transition moves the charge of the load: that is the energy.',
        why: ['', 'That is the pseudo-NMOS inverter. In CMOS the PMOS is off while y = 0, so there is no path from VDD.', 'With y held at 1 the PMOS conducts but the NMOS is off: once y has charged, no current flows.'],
      },
      {
        question: 'A CMOS inverter\'s input is a slightly weak 1, a little below VDD. Its output is:',
        options: ['A full 0: the NMOS connects y straight to GND', 'A slightly weak 0, passing the error on', 'Z: neither transistor is sure'],
        answer: 0,
        explain: 'The output comes from a rail, not from the input. A weak input still turns one network on and the other off, so the level is restored.',
        why: ['', 'Passing the error on is what a restoring gate avoids: y is connected to GND, whatever the exact input voltage.', 'The NMOS is still on and the PMOS still off: one network conducts, so y is driven.'],
      },
    ],
  },
  steps: [
    {
      title: 'Pull up, pull down',
      body: `
        <p>Stack <span data-show="p1">a PMOS</span> on top of <span data-show="n1">an NMOS</span> and tie their gates together. That is a <strong>CMOS inverter</strong>.</p>
        <ul><li><code>a = 0</code>: the PMOS conducts, the NMOS is off → <code>y</code> is pulled up to <strong>1</strong>.</li>
        <li><code>a = 1</code>: the NMOS conducts, the PMOS is off → <code>y</code> is pulled down to <strong>0</strong>.</li></ul>
        <p>The output is always the opposite of the input: <strong>y = NOT a</strong>. Conducting transistors
        are drawn with a solid glowing channel.</p>
        <div class="try">Toggle <code>a</code> and watch exactly one transistor turn on at a time.</div>`,
      scene: () => ({ root: INV_CMOS, inputs: { a: 0 } }),
      tries: [(st) => st.value('y') === 0],
      challenge: {
        kind: 'quiz', question: 'For a valid input (0 or 1), how many of the inverter\'s transistors conduct?',
        options: ['None', 'Exactly one', 'Both'], answer: 1,
        why: ['Then y would float. For either valid input one network conducts and drives it.', '', 'Both on would short VDD to ground. The shared gate turns one on exactly when it turns the other off.'],
        explain: 'Exactly one. So there is never a direct path from VDD to ground, and a CMOS gate draws (almost) no current while it is not switching. That is why your phone battery lasts a day, not a minute.',
      },
    },
    {
      title: 'Why this is brilliant',
      body: `
        <p>Three properties make CMOS the technology of every chip you own:</p>
        <ul>
        <li><strong>Restoring.</strong> The output is connected straight to <span data-show="vdd">VDD</span> or <span data-show="gnd">ground</span>, so a slightly weak input
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
        <p>Replace the PMOS with a <span data-show="pu"><strong>resistor</strong></span> to VDD and keep <span data-show="n1">the NMOS</span>: a
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
        why: ['That is CMOS. Here the resistor is always connected to VDD, so a conducting NMOS below it makes a steady path to ground.', 'With a = 0 the NMOS is open: y charges to 1 through the resistor and the current stops.', '', 'With a = 0 nothing below the resistor conducts, so once y is at 1 no current flows.'],
      },
    },
  ],
};

const RCA32_DEPTH = logicDepth(rca(32))!;

export const chNand: Chapter = {
  id: 'nand', num: 3, title: 'The NAND gate', level: 'Transistors → gates',
  blurb: 'Four transistors, and the only brick we will ever need.',
  goals: [
    'build a two-input gate from a pull-up network of PMOS and its dual pull-down of NMOS',
    'say why designers prefer NAND to NOR (the slow PMOS in parallel, not in series)',
    'explain why one gate type is enough for every circuit on this site',
    'price a NAND in transistors, and in relays and tubes',
  ],
  builds: ['inverter'],
  recap: {
    keep: [
      'A CMOS gate is a pull-up network of PMOS and a pull-down network of NMOS that are each other\'s dual: parallel in one, series in the other. For every input exactly one of them conducts.',
      'NAND: PMOS in parallel, NMOS in series. NOR is the dual. A single CMOS stage always inverts, so NAND (4 transistors) is cheaper than AND (6).',
      'NAND is <strong>functionally complete</strong>. Every circuit on this site bottoms out in NANDs, and the gate counts count them.',
      'A NAND is a function: CMOS, relays or tubes change its price (time, power, size), never the netlist.',
    ],
    practise: ['t_nand', 't_nor', 'r_nand'],
    check: [
      {
        question: 'A three-input CMOS NAND has six transistors. How are they arranged?',
        options: ['Three PMOS in parallel, three NMOS in series', 'Three PMOS in series, three NMOS in parallel', 'Three PMOS in parallel, three NMOS in parallel'],
        answer: 0,
        explain: 'The output may fall to 0 only when every input is 1, so the pull-down needs all three NMOS in a chain, and any one input at 0 must pull up: PMOS in parallel.',
        why: ['', 'That is the three-input NOR: its output is 1 only when every input is 0.', 'Then for mixed inputs both networks conduct at once: a short from VDD to GND, and y is neither 0 nor 1.'],
      },
      {
        question: 'Why do chip designers prefer NAND to NOR?',
        options: ['NAND puts the weaker PMOS in parallel, so at equal speed it is smaller', 'NAND needs fewer transistors', 'NOR is not functionally complete'],
        answer: 0,
        explain: 'Holes are two to three times slower than electrons. NOR stacks its PMOS in series, so they must be made wider to pull up as fast.',
        why: ['', 'Both need four transistors.', 'NOR is complete too. The preference is about speed and area, not about what can be built.'],
      },
      {
        question: 'On a CMOS NAND with a = 0 and b = 1, which transistors conduct?',
        options: ['The PMOS whose gate is a, and the NMOS whose gate is b', 'Both PMOS', 'Both NMOS', 'None of them'],
        answer: 0,
        explain: 'A PMOS conducts on a 0 at its gate, an NMOS on a 1. The PMOS on a pulls y up to 1; the NMOS on b conducts, but the one on a is off, so there is no path to ground.',
        why: ['', 'The PMOS on b has a 1 at its gate: it is off.', 'The NMOS on a has a 0 at its gate: it is off, so the series path is broken.', 'Then y would float. In CMOS one network always conducts.'],
      },
    ],
  },
  steps: [
    {
      title: 'Two inputs',
      body: `
        <p>Give the inverter a second input. Put two PMOS transistors <span data-show="p1 p2">p1, p2</span>
        <em>in parallel</em> (either one can pull up) and two NMOS <span data-show="n1 n2">n1, n2</span> <em>in series</em>
        (both must conduct to pull down).</p>
        <p>The output is 0 only when <code>a</code> AND <code>b</code> are both 1. That is NOT-AND:
        <strong>NAND</strong>.</p>
        <table><tr><th>a</th><th>b</th><th>y</th></tr><tr><td>0</td><td>0</td><td>1</td></tr><tr><td>0</td><td>1</td><td>1</td></tr><tr><td>1</td><td>0</td><td>1</td></tr><tr><td>1</td><td>1</td><td>0</td></tr></table>
        <div class="try">Find the input where the series NMOS pair forms a complete path to ground.</div>`,
      scene: () => ({ root: NAND, inputs: { a: 1, b: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the NAND output 0.', check: (st) => st.value('y') === 0,
        hints: [
          'y can only reach 0 through the two NMOS at the bottom. When does a chain of two switches in series conduct?',
          'An NMOS conducts when its gate is 1. Follow each NMOS gate back to the input that drives it.',
        ],
        answer: 'a = 1 and b = 1: both series NMOS conduct, connecting y to GND, and both PMOS are off.',
        solve: (st) => st.setInputs({ a: 1, b: 1 }),
      },
    },
    {
      title: 'NOR, for comparison',
      body: `
        <p>Swap the arrangement (PMOS <span data-show="p1 p2">in series</span>, NMOS <span data-show="n1 n2">in parallel</span>)
        and you get <strong>NOR</strong>: the output is 1 only when both inputs are 0.</p>
        <p>Both work, but chip designers prefer NAND. Holes move about two to three times slower than electrons, so
        PMOS transistors are weaker. NOR puts the weak PMOS devices <em>in series</em>, which makes its
        pull-up slow. NAND puts them in parallel. At the same speed, a NAND is smaller.</p>
        <div class="try">Find the one input that makes the NOR output 1.</div>`,
      scene: () => ({ root: NOR_CMOS, inputs: { a: 1, b: 0 } }),
      tries: [(st) => st.value('y') === 1],
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
        why: ['A NAND is 4, but its output is inverted, and undoing that inversion costs an inverter.', '', 'Two transistors make an inverter: one input, no AND.'],
        explain: 'A single CMOS stage always inverts, so AND = NAND + NOT = 4 + 2 = 6 transistors. Inverting gates are the cheap ones.',
      },
    },
    {
      title: 'One NAND, three technologies',
      body: `
        <p>A NAND is a function, not a device. The prologue built it twice before the transistor, from relays (P1) and
        from tubes (P2). Every circuit on this site bottoms out in NANDs, so each can be built in any of the three. The
        netlist stays the same, and only the price of one NAND changes:</p>
        <ul>
          <li><strong>CMOS</strong>: 4 transistors, an illustrative ${PS_PER_NAND} ps, about ${NAND2_UM2} µm² of 28 nm-class
          silicon, femtojoules per switch.</li>
          <li><strong>Relays</strong>: one coil per NAND output. Its contacts are the inputs of the gates that read it,
          ${RELAY_CONTACTS} per relay, so a net read more than ${RELAY_CONTACTS} times needs another coil for every
          ${RELAY_CONTACTS} more. ${RELAY_STEP_MS} ms per step (P1's model: pull-in plus bounce), ${RELAY_POWER.toFixed(2)} W
          on average, about ${fmtVolume(RELAY_VOLUME)} and ${fmtMass(RELAY_MASS)}.</li>
          <li><strong>Tubes</strong>: half a 6SN7 with a 6AL5 diode pair in front and a divider into the grid.
          ${TUBE_STEP_US.toFixed(1)} µs per step (an R·C estimate) and ${TUBE_BRICK_POWER.toFixed(2)} W, most of it heater,
          drawn whether the gate switches or not. A plate drives at most ${PLATE_FANOUT} dividers, so a wider net gets a
          cathode follower.</li>
        </ul>
        <p>Scale it up below. <em>Native</em> shows what each technology is good at. Changeover contacts give an adder
        its carry nearly for free, which is why relay machines did not build adders from NAND bricks. Tubes get no
        such gift: P2's tube adder is the nine NANDs again. You can price any part the same way in the inspector
        (<em>In relays and tubes</em>), in the workbench's Statistics tab and in a sandbox chip's properties.</p>`,
      widget: () => techCompareWidget(),
      challenge: {
        kind: 'quiz', question: `Through the brick, the 32-bit ripple-carry adder is ${RCA32_DEPTH} NAND delays deep. Built from relays, one add takes about:`,
        options: [fmtTime(RCA32_DEPTH * TECH.relay.step), fmtTime(TECH.relay.step), fmtTime(RCA32_DEPTH * TECH.tube.step)], answer: 0,
        why: ['', 'That is P1\'s native relay adder, whose carry runs through changeover contacts in one step. Through the NAND brick the carry ripples gate by gate.', 'That is the tube time: tubes switch in microseconds, relays in milliseconds.'],
        explain: `${RCA32_DEPTH} relay steps × ${RELAY_STEP_MS} ms ≈ ${fmtTime(RCA32_DEPTH * TECH.relay.step)}. P1's relay adder carries through contacts and adds in one step (${fmtTime(TECH.relay.step)}); tubes take ${fmtTime(RCA32_DEPTH * TECH.tube.step)}, CMOS ${fmtTime(RCA32_DEPTH * TECH.cmos.step)}.`,
      },
    },
  ],
};
