import { groupDigits } from '../sim/numfmt';
import { cmosNand, cmosNor, ringOsc } from '../lib/cmosgates';
import { rca } from '../lib/combinational';
import { AND, NOR, NOT, OR, XOR } from '../lib/gates';
import { INV_PSEUDO, WEAK_DEMO } from '../lib/switchparts';
import { INV_CMOS, NAND, NMOS_SWITCH, NOR_CMOS, PMOS_SWITCH } from '../lib/transistors';
import { metrics, MOBILITY_RATIO, strength, vout } from '../phys/inverter';
import { chainDelay, FO4_TAU, P_INV, PS_PER_TAU } from '../phys/sizing';
import { and4Tree, and4Wide, gNand, gNor, pGate } from '../phys/effort';
import { mosfet3d, withModel } from '../widgets/modelhost';
import { valve3d } from '../widgets/valve3d';
import { sizingWidget } from '../widgets/sizing';
import { vtcWidget } from '../widgets/vtc';
import {
  NAND2_UM2, PLATE_FANOUT, RELAY_CONTACTS, RELAY_MASS, RELAY_POWER, RELAY_VOLUME, TECH, TUBE_BRICK_POWER, fmtMass, fmtTime, fmtVolume,
} from '../lib/tech';
import { RELAY_STEP_MS } from '../phys/relay';
import { TUBE_STEP_US } from '../phys/triode';
import { logicDepth, stats } from '../sim/stats';
import { VDD_VOLTS, VT_VOLTS } from '../sim/switchsim';
import { PS_PER_NAND } from '../sim/timing';
import { C_GATE, C_WIRE, K, VDD, VT, current, discharge, loadOf } from '../widgets/mosphys';
import { journeyWidget } from '../widgets/journey';
import { techCompareWidget } from '../widgets/techcompare';
import { mosCostWidget } from '../widgets/moscost';
import { mosfetWidget } from '../widgets/mosfet';
import { biasLink } from '../widgets/mosshare';
import { mosRegionsWidget } from '../widgets/mosregions';
import { bench, type Chapter } from './types';
import { numOf } from './order';

export const chMap: Chapter = {
  id: 'map', num: numOf('map'), title: 'The map', level: 'Overview',
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
        <p>The rule is what makes the climb possible. A level may use the <em>behaviour</em> of the level below (an adder can rely on a gate giving 0 only when both its inputs
        are 1) but never its insides, so a designer working on an adder thinks in gates and needs no transistor in mind. The price of the rule is
        that every level adds overhead the one above cannot see; the benefit is that the descriptions stay small enough to hold in a head. Each chapter
        here ends by pricing what it built in the level below, so you can see both sides.</p>
        <div class="note">The map below is the whole journey, in reading order, by section. Each row
        lists what its chapter builds with; a click opens the chapter.</div>`,
      more: {
        derive: `<p>One number shows why levels are needed. This site's 4-bit adder is ${stats(rca(4)).transistors} transistors; a 32-bit one is ${stats(rca(32)).transistors}, and each
          doubling of width doubles the count. A processor holds billions of transistors, millions of blocks the size of this adder: no one can hold that in mind transistor by
          transistor, but the same adder is "a + b" at the level above, and "a + b" has a one-line description.</p>`,
        pitfall: `<p>Reading "transparent box" as "every level is simulated in full". It is not: a simulation can cut at any level (a ROM as a lookup, an adder as arithmetic) and drop to the
          transistors only where you look. What stays true is that the cut is optional: the lower level exists, was used to build the upper one, and can be opened.</p>`,
        real: `<p>The same layering is how real chips are designed: a standard-cell library fixes the transistor level once, per process; synthesis maps logic onto those cells; placement
          and routing arranges them. Designers of the top levels see cells and timing models, not transistors.</p>`,
      },
      widget: () => journeyWidget(),
    },
    {
      title: 'Open the box',
      body: `
        <p>Here is a 4-bit adder. It adds two numbers <code>a</code> and <code>b</code>. Change them in the
        bar at the bottom (or click the pins) and watch the sum <code>s</code>.</p>
        <p>Now the important part: <strong>double-click any block to look inside it</strong>.
        An adder is made of <span data-ahead="fulladder">full adders (<code>FA</code>: circuits that add one bit position: two input bits plus a carry in, giving a sum bit and a carry out; chapter 6 builds one)</span>.
        A full adder is made of <span data-ahead="nand">NAND gates (gates whose output is 0 only when both inputs are 1; chapter 3 builds one)</span>.
        A NAND gate is made of four transistors. Open one of those and you reach a single transistor.</p>
        <div class="try">Open <code>fa0</code>, then one of its gates, then a transistor. Use the breadcrumbs above
        the circuit, or press <kbd>Esc</kbd>, to climb back up.</div>
        <p>How wires, buses and the HEX / BIN / DEC switch read on this site is in <a href="#/c/basics/5">Basics, step 6</a>.</p>
        <p>The adder is four identical one-bit stages in a row, each passing its carry to the next. Opening <code>fa0</code> shows
        the same nine gates that every later stage repeats; opening one gate shows four transistors. The shape of every level is a handful of
        parts, wired by names, and that is the whole trick.</p>`,
      scene: () => ({ root: rca(4), inputs: { a: 5, b: 3 } }),
      ledger: { kind: 'add', a: 'a', b: 'b', sum: 's', width: 4, cin: 'cin', cout: 'cout', col: (i) => [`fa${i}`] },
      tour: {
        label: 'Walk me down to a transistor',
        beats: [
          { title: 'A sum', set: { a: 5, b: 3 }, show: ['fa0', 'fa1', 'fa2', 'fa3'], expect: { s: 8, cout: 0 },
            say: '<p>5 + 3: the adder gives s = {v:s}, carry out {v:cout}. Four one-bit stages, one per bit.</p>' },
          { title: 'A carry out', set: { a: 15, b: 1 }, show: ['fa0', 'fa1', 'fa2', 'fa3'], expect: { s: 0, cout: 1 },
            say: '<p>15 + 1 = 16, which needs five bits: s = {v:s} and cout = {v:cout}. The carry has run through all four stages, each waiting for the one before.</p>' },
          { title: 'One bit stage', at: ['fa0'], show: ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'],
            say: `<p>Inside fa0: ${stats(rca(4)).nands / 4} gates, all <span data-ahead="nand">NANDs (gates whose output is 0 only when both inputs are 1)</span>. This is the level you get by opening a box one step.</p>` },
          { title: 'One gate', at: ['fa0', 'g1'], show: ['p1', 'p2', 'n1', 'n2'],
            say: '<p>Inside g1: four transistors, two PMOS and two NMOS. This is the bottom of the stack: the next three chapters build up to why these four make a gate (chapter 3).</p>' },
        ],
      },
      more: {
        derive: `<p>Counting down the hierarchy: the adder has 4 full adders; each full adder has ${stats(rca(4)).nands / 4} NANDs; each NAND has 4 transistors. So ${stats(rca(4)).nands} NANDs and 4 × ${stats(rca(4)).nands}
          = ${stats(rca(4)).transistors} transistors for the adder. Opening a box never changes the answer, only the level you read it at.</p>`,
        pitfall: `<p>Looking for the carry as a wire to follow by eye. The carry out of <code>fa0</code> is the carry in of <code>fa1</code>, drawn as a wire between two boxes; with the box
          closed it is a single net, and in the flat netlist it is one net among hundreds. Use the net hue or click the wire to follow it.</p>`,
      },
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
        <p>Look at the inspector's <strong>Info</strong> tab: it counts what the adder costs. A 4-bit adder
        is ${stats(rca(4)).nands} <span data-ahead="nand">NAND gates (two-input gates whose output is 0 only when both inputs are 1)</span>, or ${stats(rca(4)).transistors} transistors. Select any part (single click)
        to see its own cost: a one-bit stage is ${stats(rca(4)).nands / 4} <span data-ahead="nand">NANDs (two-input gates whose output is 0 only when both inputs are 1)</span>.</p>
        <p>Every number on this site is <em>measured</em> from the circuit itself, not quoted from a book.
        That includes the "gate delays": how many gates a signal must pass through, which sets how fast the
        circuit can go.</p>
        <p>The <strong>HDL</strong> tab shows the same circuit as a hardware description, in Verilog and in VHDL. Chip designers
        write one of these languages, and tools turn it into gates like these.</p>
        <p>Cost is counted by the same rule at every level: a box costs the sum of what is inside it, down to the transistors. Delay is not a sum:
        it is the longest chain of gates a signal must pass through, so the adder's ${logicDepth(rca(4))} delays are less than its ${stats(rca(4)).nands} gates.</p>`,
      scene: () => ({ root: rca(4), inputs: { a: 9, b: 7 } }),
      more: {
        derive: `<p>Count is additive; depth is a longest path. In the ripple-carry adder the carry crosses each stage in two gate delays, and the ends add a fixed few: measured on the netlist, the depth is
          2n + 4, which is ${logicDepth(rca(4))} at 4 bits, ${logicDepth(rca(8))} at 8 and ${logicDepth(rca(32))} at 32. The count, ${stats(rca(4)).nands / 4} NANDs a stage, grows as 9n.</p>`,
        numbers: `<table class="mini"><tr><th>bits</th><th>NANDs</th><th>transistors</th><th>gate delays</th></tr>${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${stats(rca(n)).nands}</td><td>${stats(rca(n)).transistors}</td><td>${logicDepth(rca(n))}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Assuming delay is proportional to size. The 32-bit adder has eight times the gates of the 4-bit one but only ${(logicDepth(rca(32))! / logicDepth(rca(4))!).toFixed(1)} times the delay, and a faster adder
          (<a href="#/c/fastadd/0">chapter ${numOf('fastadd')}</a>) can do the same add in far less depth by spending more gates. Cost and depth are separate axes.</p>`,
      },
    },
  ],
};

export const chMosfet: Chapter = {
  id: 'mosfet', num: numOf('mosfet'), title: 'The MOSFET', level: 'Transistors',
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
      'Cut-off: Vgs &lt; Vt, no current (here; in silicon a subthreshold leak, tenfold less per 60–100 mV below Vt). Linear: Vds &lt; Vgs − Vt, a resistor. Saturation: Vds ≥ Vgs − Vt, the drain end pinches off and Id = k·(Vgs − Vt)²/2, set by the gate alone. A falling output passes through saturation, so that current sets the speed.',
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
        <p>Everything in the panel is computed from the classic square-law model: once the channel exists,
        the drain current Id = k·(Vgs − Vt)²/2 in saturation (Vgs: the gate-to-source voltage), with k = 220 µA/V² and Vt = 0.45 V, a plausible small device at
        1.8 V. The channel's thickness is its charge, and each carrier moves at the local field.</p>
        <div class="try">Press <strong>Sweep</strong>, or drag the gate past 0.45 V: the depletion layer grows
        then stops, electrons (filled dots; holes are rings) rise into a channel, and the current leaves zero.
        Then raise the drain and watch the channel taper toward it.</div>`,
      more: {
        derive: `<p>The threshold is the gate voltage at which the surface holds as many electrons as the bulk holds holes; past it the extra charge is the channel's: Q ∝ C<sub>ox</sub>·(V<sub>gs</sub> − V<sub>t</sub>),
          which is why everything below is written in the <em>overdrive</em> V<sub>ov</sub> = V<sub>gs</sub> − V<sub>t</sub>. At the full ${VDD} V gate the overdrive is ${(VDD - VT).toFixed(2)} V, and with k = ${K} µA/V²
          the saturation current is (k / 2)·V<sub>ov</sub>² = ${((K / 2) * (VDD - VT) ** 2).toFixed(0)} µA (${current(VDD - VT, VDD).id.toFixed(0)} µA with the channel-length factor at V<sub>ds</sub> = ${VDD} V). Half the supply on the gate gives V<sub>ov</sub> =
          ${(VDD / 2 - VT).toFixed(2)} V and ${((K / 2) * (VDD / 2 - VT) ** 2).toFixed(0)} µA, ${(((VDD - VT) / (VDD / 2 - VT)) ** 2).toFixed(0)} times less: the switch is steeply nonlinear, which is what makes it a switch.</p>`,
        pitfall: `<p>Reading the threshold as a switching point at ${VT} V and nothing else. Just above V<sub>t</sub> the channel is a thin, weak one, and the current is tiny (${((K / 2) * 0.1 ** 2).toFixed(1)} µA at 0.1 V of overdrive); the
          device behaves as "on" only well above the threshold. The animation shows the channel thickening with overdrive, not appearing at once.</p>`,
        real: `<p>Vt is set by the doping and the oxide, and it varies from device to device and with temperature. The square law in the panel is the textbook model of a long channel; the next step lists where it fails in
          the short ones of a modern chip.</p>`,
      },
      widget: () => { const link = biasLink(); return withModel(mosfetWidget({ type: 'n', allowTypeSwitch: false, link }), mosfet3d(link)); },
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
      more: {
        derive: `<p>The two formulas meet at V<sub>ds</sub> = V<sub>ov</sub>: the linear one gives k·(V<sub>ov</sub>² − V<sub>ov</sub>²/2) = k·V<sub>ov</sub>²/2, the saturation one k·V<sub>ov</sub>²/2. With
          V<sub>gs</sub> = ${VDD} V, V<sub>ov</sub> = ${(VDD - VT).toFixed(2)} V, so the corner is at V<sub>ds</sub> = ${(VDD - VT).toFixed(2)} V and the current there is ${current(VDD - VT, VDD - VT).id.toFixed(0)} µA. At small V<sub>ds</sub> the channel is a resistor of
          1 / (k·V<sub>ov</sub>) = ${(1e6 / (K * (VDD - VT)) / 1e3).toFixed(1)} kΩ (before the channel-length factor). A falling output crosses from saturation (a current source, fast) into linear (a resistor, an exponential tail):
          the saturation current sets the first half of the swing and so most of the delay.</p>`,
        numbers: `<table class="mini"><tr><th>V<sub>gs</sub> = ${VDD} V, V<sub>ds</sub></th>${[0.1, 0.3, 0.6, 0.9, 1.35, 1.8].map((d) => `<td>${d} V</td>`).join('')}</tr>
          <tr><th>region</th>${[0.1, 0.3, 0.6, 0.9, 1.35, 1.8].map((d) => `<td>${current(VDD - VT, d).kind === 'lin' ? 'linear' : 'saturation'}</td>`).join('')}</tr>
          <tr><th>I<sub>d</sub> (µA)</th>${[0.1, 0.3, 0.6, 0.9, 1.35, 1.8].map((d) => `<td>${current(VDD - VT, d).id.toFixed(0)}</td>`).join('')}</tr></table>`,
        pitfall: `<p>Using the saturation formula in the linear region, or the reverse. A discharging output starts with V<sub>ds</sub> = ${VDD} V (saturation, constant current) and ends near 0 (linear, a resistor), so
          "the current" is a function of where on the swing you are. Computing the delay from the peak current alone is optimistic; the widget's charge-up plot shows the shape.</p>`,
        real: `<p>Here cut-off is zero current; in silicon it is not. Below Vt the channel is weak, not gone: carriers diffuse
          across it, and this <strong>subthreshold</strong> current falls about tenfold for every 60–100 mV the gate drops
          below Vt (60 mV a decade, kT/q·ln 10, is the room-temperature limit). An off transistor leaks, and a lower Vt,
          which buys speed at a low VDD, multiplies the leak: billions of off transistors burn watts doing nothing. Thin
          oxide adds gate tunnelling, which is why high-k dielectrics replaced silicon dioxide at 45 nm.</p>
          <p>The square law also fails as channels shorten. Past a critical field carriers stop speeding up
          (<strong>velocity saturation</strong>), so the current grows nearly linearly with Vgs − Vt rather than as its
          square. The drain's field reaches under the gate and lowers the barrier at the source (<strong>DIBL</strong>):
          Vt falls as Vds rises and as the channel shortens, and λ grows. Leakage is why Vt, and with it VDD, stopped
          scaling in the mid-2000s, and clock frequencies stalled with them.</p>`,
      },
      widget: () => { const link = biasLink(1.2, 0.3); return withModel(mosRegionsWidget(link), valve3d(link)); },
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
        That complementary pair is the C in <span data-ahead="cmos"><strong>CMOS</strong> (complementary MOS: NMOS and PMOS used together, each pulling to its own rail; chapter 2 builds the simplest CMOS gate)</span>.</p>
        <p>The reason for the asymmetry is the sign of the carriers and of the source. An NMOS source is its lower terminal, so the gate must rise above it by Vt; if
        the output it drives rises towards VDD, its V<sub>gs</sub> shrinks and it stops short (the weak-levels step of <a href="#/c/inverter/3">chapter 2</a> shows the weak 1). A PMOS source is its upper
        terminal, and its V<sub>sg</sub> grows as the output rises, so it carries a 1 whole. Each type is strong on the rail it is tied to and weak on the other one.</p>`,
      more: {
        derive: `<p>The PMOS equations are the NMOS ones with every voltage measured from the source and its sign reversed: it conducts when V<sub>sg</sub> = V<sub>s</sub> − V<sub>g</sub> > |V<sub>tp</sub>|, and the current
          is (k<sub>p</sub> / 2)·(V<sub>sg</sub> − |V<sub>tp</sub>|)² in saturation. With the source at VDD = ${VDD} V and the gate at 0 V, V<sub>sg</sub> = ${VDD} V, the overdrive is ${(VDD - VT).toFixed(2)} V if
          |V<sub>tp</sub>| = ${VT} V, as for the NMOS here. Holes move about two to three times slower than electrons, so for the same size k<sub>p</sub> is a half to a third of k<sub>n</sub>; chapter 3 uses this.</p>`,
        pitfall: `<p>Reading "PMOS is on at 0" as "PMOS is on whenever its gate is 0". What matters is the gate against the <em>source</em>. A PMOS with its source at 0 V and gate at 0 V has
          V<sub>sg</sub> = 0 and stays off. In a CMOS gate the PMOS sources are on VDD, so the shorthand holds; in a pass transistor it does not.</p>`,
        real: `<p>Both types sit on one die: the NMOS in a p-type substrate, the PMOS in an n-well diffused into it. That well is the extra mask step that makes CMOS dearer than NMOS-only
          processes (Appendix A's 6502 is NMOS-only), and the parasitic structure between the two is the origin of latch-up in CMOS chips.</p>`,
      },
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
        <div class="try">Change the width and the number of inputs the output drives. Delay follows C / I; energy follows C alone.</div>`,
      more: {
        derive: `<p>The load of an output driving f CMOS inputs is C = f · 2 · ${C_GATE} fF (an NMOS gate and a PMOS gate each) + ${C_WIRE} fF of wire. For f = 2 that is ${loadOf(2)} fF. The transistor discharges it from ${VDD} V
          with the saturation current I = ${current(VDD - VT, VDD).id.toFixed(0)} µA at first, so the first part of the fall is ΔV / Δt = I / C = ${(current(VDD - VT, VDD).id / loadOf(2)).toFixed(0)} V/ns, and the output
          reaches VDD / 2 at ${discharge(1, loadOf(2)).t50.toFixed(0)} ps (the waveform, not a straight line: the current falls once V<sub>ds</sub> drops below V<sub>ov</sub>). A full 0 → 1 → 0 swing moves charge C·V once in and once out of the supply,
          for C·V² = ${loadOf(2)} fF · ${VDD}² = ${(loadOf(2) * VDD * VDD).toFixed(0)} fJ; half is dissipated in each network.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>fan-out</th><th>load</th><th>delay to VDD / 2</th><th>energy per swing</th></tr>${[[1, 2], [1, 4], [2, 4], [4, 4]].map(([w, f]) => `<tr><td>${w}×</td><td>${f}</td><td>${loadOf(f)} fF</td><td>${discharge(w, loadOf(f)).t50.toFixed(0)} ps</td><td>${(loadOf(f) * VDD * VDD).toFixed(0)} fJ</td></tr>`).join('')}</table>`,
        pitfall: `<p>Sizing a transistor up to speed up a stage without counting what it does to the stage before. The wider device doubles its current and also doubles its own gate load, which the driving stage now charges: a
          bigger load for the previous gate costs the delay you saved. Past the point where its own load dominates, widening only costs energy; chains of growing sizes (logical effort: chapters 2 and 3; the Timing panel's Load setting uses it) are how this is balanced.</p>`,
      },
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
        <p>This is the first time the simulator needs more than two values. A wire can be driven to 0, driven to 1, driven to both at once (a short: X) or not driven at all (Z),
        and a design that leaves a wire floating is wrong even if it happens to read right in one run. Everything built later makes sure that, for every valid input, exactly one
        network drives each output.</p>
        <div class="try">Double-click the transistor to see it in cross-section, switching live (the gate ramps as the bit flips).</div>`,
      scene: () => ({ root: NMOS_SWITCH, inputs: { g: 0 } }),
      tour: {
        beats: [
          { title: 'Gate high', set: { g: 1 }, show: ['n1', 'gnd'], expect: { out: 0 },
            say: '<p>g = 1: the channel forms and n1 connects out to ground. out = {v:out}, driven.</p>' },
          { title: 'Gate low', set: { g: 0 }, show: ['n1'], expect: { out: -1 },
            say: '<p>g = 0: the channel is gone, and out is connected to nothing. It floats (Z). Nothing says what it is: whatever charge the wire holds, slowly leaking away.</p>' },
          { title: 'Back again', set: { g: 1 }, show: ['n1', 'gnd'], expect: { out: 0 },
            say: '<p>g = 1: driven low again, out = {v:out}. One transistor gives a firm 0 or no answer, never a 1.</p>' },
        ],
      },
      more: {
        derive: `<p>A node with no DC path to a rail keeps its charge: it sits where it was and drifts with leakage. With a load C and a leak current I<sub>leak</sub>, the voltage falls at I<sub>leak</sub> / C, which
          for the ${loadOf(2)} fF load of the last step and a nanoamp of leakage is ${(1e-9 / (loadOf(2) * 1e-15) * 1e-6).toFixed(1)} V/µs: it loses a level in microseconds. (Chapter ${numOf('dram')}'s DRAM stores a bit on exactly this node, and refreshes it before the charge is gone.)
          For logic the rule is simpler: every output must be driven for every valid input.</p>`,
        pitfall: `<p>Reading Z as "probably 0". A floating input to a following gate can sit at any voltage, including the middle, where both its transistors conduct a little and it draws current; the Z
          is drawn in its own colour for that reason. In the sandbox a floating output that feeds logic is flagged.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'With g = 0, what value does "out" have?',
        options: ['0', '1', 'Z'], answer: 2,
        explain: 'Z: the output is not connected to anything. An off transistor is an open switch. Nothing drives the output, so it floats. To always have a valid output we need a second switch that pulls up.',
        why: ['0 is a driven level: it needs a conducting path to ground, and the only one is open.', 'Nothing in this circuit connects out to VDD, so nothing can make a 1.', ''],
      },
    },
    {
      title: '…and its mirror image',
      body: `
        <p><span data-show="p1">A PMOS</span> between <span data-show="vdd">VDD</span> and the output does the opposite: <code>g = 0</code> pulls <code>out</code> up to
        <strong>1</strong>; <code>g = 1</code> leaves it floating.</p>
        <p>Each switch can only do half the job. The NMOS can make a 0 but not a 1; the PMOS a 1 but not a 0.
        Put them together and every input gets a firm answer. That is <a href="#/c/inverter/0">the next chapter</a>.</p>
        <p>The pair is the whole idea of complementary logic: each device covers the input value the other one cannot. Their gates face the same signal, and a signal that is 1 turns one
        off while it turns the other on. Wired from the rails to a shared output, the two are a gate that is never undriven and never shorted for a valid input.</p>`,
      scene: () => ({ root: PMOS_SWITCH, inputs: { g: 1 } }),
      tour: {
        beats: [
          { title: 'Gate high', set: { g: 1 }, show: ['p1'], expect: { out: -1 },
            say: '<p>g = 1: the PMOS is off and out floats (Z). Its mirror, the NMOS of the last step, gave a 0 here.</p>' },
          { title: 'Gate low', set: { g: 0 }, show: ['p1', 'vdd'], expect: { out: 1 },
            say: '<p>g = 0: the gate is below the source by the full supply, the channel forms and out is pulled to VDD: out = {v:out}, a full 1.</p>' },
          { title: 'Gate high again', set: { g: 1 }, show: ['p1'], expect: { out: -1 },
            say: '<p>g = 1: out lets go again. A PMOS makes a 1 or nothing, never a 0.</p>' },
        ],
      },
      more: {
        derive: `<p>Tabulating the two switches: for g = 0, NMOS off and PMOS on; for g = 1, NMOS on and PMOS off. Output with the NMOS to ground and the PMOS to VDD sharing out and g: g = 0 gives 1, g = 1 gives 0, and
          neither case leaves out undriven or driven by both. Two transistors that are both on at once would short VDD to ground through ${(VDD / (current(VDD - VT, VDD).id * 1e-6) / 1e3).toFixed(1)} kΩ at saturation, ${VDD} V over ${current(VDD - VT, VDD).id.toFixed(0)} µA; the complementary gate is built so that never happens in steady state.</p>`,
        pitfall: `<p>Wiring the pair with the wrong polarity, the NMOS to VDD and the PMOS to ground. Each then passes the wrong level weakly (the next chapter's weak-levels step). Put the PMOS on VDD and the NMOS on ground.</p>`,
      },
    },
  ],
};

/** Chapter 2's numbers: the transfer curve of a matched pair and of a PMOS as wide as the NMOS and 4× as wide. */
const VTC_M = metrics(strength(MOBILITY_RATIO)), VTC_LO = metrics(strength(1)), VTC_HI = metrics(strength(4));
/** Short-circuit current (µA) at V_M, both devices saturated. */
const VTC_SC = current(VTC_M.vm - VT, VTC_M.vm).id;
const RING_N = 5;
const fmtFrac = (g: number) => (Number.isInteger(g) ? String(g) : `${Math.round(g * 3)}/3`);

export const chInverter: Chapter = {
  id: 'inverter', num: numOf('inverter'), title: 'The CMOS inverter', level: 'Transistors',
  blurb: 'Two complementary transistors: the first logic gate.',
  goals: [
    'build an inverter from one PMOS pull-up and one NMOS pull-down sharing a gate, and say why it draws almost no current while its input holds still',
    'name the three properties that made CMOS win (restoring levels, no static path, power only when switching) and read the first off the transfer curve: V_M, noise margins, gain',
    'price a pseudo-NMOS gate against CMOS: one always-on pull-up in place of n PMOS, current while its output is 0',
    'predict the period of a ring oscillator (2 gate delays per stage) and the number of stages that drives a big load fastest',
  ],
  builds: ['mosfet'],
  recap: {
    keep: [
      'CMOS inverter: a PMOS from VDD to y, an NMOS from y to GND, both gates on a. For a valid input exactly one conducts, so y is the inverse of a.',
      'With the input still there is no path from VDD to ground: static power is almost zero. Energy goes into charging the capacitance downstream, at each transition.',
      'The output connects straight to a rail, so a slightly weak input still gives a full output: noise does not accumulate from gate to gate.',
      'Pseudo-NMOS: an always-on pull-up (a resistor here, a PMOS with its gate grounded in silicon) against a stronger NMOS (ratioed logic). An n-input <span data-ahead="nor">NOR (a gate whose output is 1 only when every input is 0)</span> is n NMOS and one pull-up, n + 1 devices against 2n, paid for with current while y = 0, a low level only as good as the ratio and a slow rising edge.',
      'The transfer curve is flat near the rails and steep between V_IL and V_IH, where both devices conduct (a short-circuit current): gain above 1 in the band and below 1 outside it is what makes a level restoring. A matched pair switches at VDD / 2 with equal noise margins; the 0 / 1 / X simulator’s X is that band.',
      'An odd ring of inverting stages cannot settle: the period is 2N gate delays. A chain of inverters driving a load F times its input is fastest at a ratio near 4 per stage, and an FO4 inverter (5 τ) is the unit of comparison between processes.',
    ],
    practise: ['t_inv'],
    check: [
      {
        question: 'How many devices does a three-input <span data-ahead="nor">NOR (a gate whose output is 1 only when every input is 0)</span> take in pseudo-NMOS, and in CMOS?',
        options: ['3 NMOS and one always-on pull-up (a resistor here; in silicon a grounded-gate PMOS, so 4 transistors), against 6 transistors', '3 NMOS and three pull-ups, against 6 transistors', '3 NMOS and one pull-up, against 4 transistors'],
        answer: 0,
        explain: 'Pseudo-NMOS keeps the n parallel NMOS and replaces the whole PMOS network with one always-on pull-up: n + 1 devices against 2n.',
        why: ['', 'One pull-up serves the whole gate: pseudo-NMOS replaces the PMOS network, one device per input, with a single always-on load.', 'A CMOS gate needs one PMOS per input as well as one NMOS per input: 2n = 6.'],
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
      {
        question: 'A 9-stage ring oscillator has a stage delay of 20 ps. What is its frequency?',
        options: ['1 / (9 × 20 ps) = 5.6 GHz', '1 / (2 × 9 × 20 ps) = 2.8 GHz', '1 / (20 ps) = 50 GHz'],
        answer: 1,
        explain: 'A change goes round once to arrive inverted and a second time to restore: a period is 2N stage delays, 360 ps, so 2.78 GHz.',
        why: ['One lap is half a period: the output has only made one edge.', '', 'That is a single stage; the signal must pass all nine.'],
      },
      {
        question: 'Why does a CMOS inverter chain restore a degraded logic level?',
        options: ['Its gain exceeds 1 between V_IL and V_IH, and the curve is flat near the rails, so an off-level input leaves closer to a rail', 'Its output is a copy of the input delayed', 'Both transistors are always on'],
        answer: 0,
        explain: 'Outside the band the slope is below 1, so an input error shrinks stage by stage; inside it the gain is far above 1, so the output is pushed to a rail.',
        why: ['', 'It is inverted, not copied, and a delay restores nothing.', 'Both conduct only inside the narrow band around V_M; elsewhere exactly one does.'],
      },
    ],
  },
  steps: [
    {
      title: 'Pull up, pull down',
      body: `
        <p>A logic gate must drive its output to a clean 1 or 0 for every input. One NMOS cannot: it can connect the output to ground, but when it is off
        it leaves the output connected to nothing. Its complement, the PMOS, connects to VDD instead and turns on at the opposite gate level. Use one of each,
        one to pull up and one to pull down, and for either input exactly one of them is on.</p>
        <p>Stack <span data-show="p1">a PMOS</span> on top of <span data-show="n1">an NMOS</span> and tie their gates together. That is a <strong>CMOS inverter</strong>.</p>
        <ul><li><code>a = 0</code>: the PMOS conducts, the NMOS is off → <code>y</code> is pulled up to <strong>1</strong>.</li>
        <li><code>a = 1</code>: the NMOS conducts, the PMOS is off → <code>y</code> is pulled down to <strong>0</strong>.</li></ul>
        <p>The output is always the opposite of the input: <strong>y = <span data-ahead="not">NOT a (the logical inverse: 1 becomes 0, 0 becomes 1)</span></strong>. Conducting transistors
        are drawn with a solid glowing channel.</p>
        <p>It costs ${stats(INV_CMOS).transistors} transistors, and the arrangement is the pattern for every CMOS gate: a <strong>pull-up network</strong> of PMOS from VDD to the output and a <strong>pull-down network</strong>
        of NMOS from the output to ground, each the logical complement of the other. For an inverter each network is one transistor. Between a change of the input and the output settling, the load capacitance moves: that is
        the delay and the energy of the previous chapter, spent swinging a few femtofarads from rail to rail.</p>
        <div class="try">Toggle <code>a</code> and watch exactly one transistor turn on at a time.</div>`,
      scene: () => ({ root: INV_CMOS, inputs: { a: 0 } }),
      tries: [(st) => st.value('y') === 0],
      tour: {
        beats: [
          { title: 'Input low', set: { a: 0 }, show: ['p1', 'vdd'], expect: { y: 1 },
            say: '<p>a = 0: the PMOS has its gate a full supply below its source and conducts; the NMOS has Vgs = 0 and is off. y is connected to VDD: y = {v:y}.</p>' },
          { title: 'Input high', set: { a: 1 }, show: ['n1', 'gnd'], expect: { y: 0 },
            say: '<p>a = 1: the roles swap. The PMOS has no overdrive and is off; the NMOS conducts and connects y to ground: y = {v:y}. Exactly one network conducts.</p>' },
          { title: 'Low again', set: { a: 0 }, show: ['p1', 'n1'], expect: { y: 1 },
            say: '<p>a = 0: y goes back to {v:y}. At no input value are both transistors on in steady state, so there is no path from VDD to ground.</p>' },
        ],
      },
      more: {
        derive: `<p>The output is y = ¬a because the pull-up conducts exactly when a = 0 (a PMOS on a low gate) and the pull-down exactly when a = 1 (an NMOS on a high gate). The energy of one output transition, from the
          previous chapter, is C·V² drawn from the supply on a rising edge (half stored on C, half dissipated in the PMOS), and the stored C·V²/2 dissipated in the NMOS on the falling edge: a full cycle costs C·V² = ${(loadOf(2) * VDD * VDD).toFixed(0)} fJ for a ${loadOf(2)} fF load, and nothing while the input holds.</p>`,
        pitfall: `<p>Counting the inverter's "off" transistor as a resistor to ground. In the logic model a transistor is an open switch when it is off; in silicon it still leaks a little (previous chapter), which is the whole
          standby power of a CMOS chip. The drawing shows only the intended state.</p>`,
      },
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
        <p>Switch to the <strong><span data-ahead="truthtable">Truth table (the output listed for every input combination)</span></strong> tab: it was computed by actually solving the transistor
        network for every input.</p>
        <p>Restoring is what lets a design be deep. Every output is rebuilt from a rail, so after each gate the error budget is reset: a signal that crosses a thousand gates is as clean as one that crosses
        one. Without it (a chain of resistors, or of pass switches) every stage subtracts a little swing, and past a few stages 0 and 1 meet. The price is that each stage inverts,
        which is why a CMOS stage is always an inverting gate and why a non-inverting gate costs more than an inverting one (<a href="#/c/nand/0">chapter ${numOf('nand')}</a>).</p>`,
      scene: () => ({ root: INV_CMOS, inputs: { a: 1 } }),
      more: {
        derive: `<p>Here a wire is 0, 1, X or Z; in silicon it is a voltage, and an inverter maps input voltage to output voltage
          along its <strong>voltage transfer characteristic</strong> (VTC): flat near both rails, steep in the middle,
          crossing V<sub>in</sub> = V<sub>out</sub> at the switching threshold V<sub>M</sub> (about VDD/2 when the PMOS
          is made wide enough to match the NMOS). Where the slope is −1 lie the input limits V<sub>IL</sub> and
          V<sub>IH</sub>; the outputs there, V<sub>OH</sub> and V<sub>OL</sub>, sit close to the rails. The
          <strong>noise margins</strong> NM<sub>L</sub> = V<sub>IL</sub> − V<sub>OL</sub> and NM<sub>H</sub> =
          V<sub>OH</sub> − V<sub>IH</sub> are how much noise a level can pick up between two gates and still be read
          right.</p>
          <p>Restoring means <strong>gain</strong>: between V<sub>IL</sub> and V<sub>IH</sub> the slope is steeper than
          1, near the rails flatter. A level that arrives a little off lands on a flat part and leaves closer to the rail,
          so a chain of gates squeezes errors out instead of adding them up. A network without gain, a resistor divider
          or a chain of pass switches, passes every error on and shrinks the swing at each stage. Pseudo-NMOS (later in this
          chapter) has a V<sub>OL</sub> above 0, set by its ratio: a smaller NM<sub>L</sub>.</p>`,
        real: `<p>Here the transistors are ideal switches; in silicon, while the input passes between Vt (the NMOS turns on)
          and VDD − |Vt| (the PMOS turns off), both conduct, and a <strong>short-circuit current</strong> flows straight
          from VDD to ground. With sharp input edges it costs about a tenth of the switching energy; a slow edge keeps both
          on longer, one reason designers bound transition times. Add the subthreshold leak of
          <a href="#/c/mosfet/1">chapter 1</a>'s off transistor, and "almost no static power" is milliwatts to watts on a
          large chip, not zero.</p>`,
        pitfall: `<p>Taking "no static power" literally when estimating a battery life. The statement holds for the dynamic term, which is zero while nothing switches; the leakage term never is, and on a chip with
          billions of transistors it is the idle power. A clock that is stopped saves the dynamic term only; powering a block down saves the leak too.</p>`,
      },
    },
    {
      title: 'The voltage in between',
      body: `
        <p>The simulator knows a wire as 0, 1 or X. In silicon an input is a voltage, and the inverter maps it to an output voltage along its <strong>transfer curve</strong>. Move Vin below.
        Near either rail the curve is flat: a slightly wrong input gives an output on the rail. In the middle it is steep, and for a stretch both transistors conduct.</p>
        <p>Two numbers describe it. The <strong>switching threshold</strong> V<sub>M</sub> is where Vin = Vout: ${VTC_M.vm.toFixed(2)} V for a matched pair, ${VTC_LO.vm.toFixed(2)} V when the PMOS is as wide as the NMOS (a hole is
        ${MOBILITY_RATIO}× less mobile, so the PMOS is the weaker device, and the output falls early), ${VTC_HI.vm.toFixed(2)} V at 4×. The <strong>noise margins</strong> are measured where the slope is −1: V<sub>IL</sub> = ${VTC_M.vil.toFixed(2)} V
        and V<sub>IH</sub> = ${VTC_M.vih.toFixed(2)} V, where the outputs are V<sub>OH</sub> = ${VTC_M.voh.toFixed(2)} V and V<sub>OL</sub> = ${VTC_M.vol.toFixed(2)} V. So NM<sub>L</sub> = V<sub>IL</sub> − V<sub>OL</sub> = ${VTC_M.nmL.toFixed(2)} V,
        ${((100 * VTC_M.nmL) / VDD).toFixed(0)}% of the ${VDD} V supply, and the same on the high side. Make the PMOS narrower and one margin grows at the other's expense.</p>
        <p>This is what <em>restoring</em> means in volts. Between V<sub>IL</sub> and V<sub>IH</sub> the gain reaches ${VTC_M.gain.toFixed(0)} here (a simple model; real inverters sit at 5 to 20), and outside it the slope is below 1. A 0 that arrives at 0.45 V,
        a quarter of the swing too high, leaves as ${vout(0.45, 1).toFixed(2)} V; the next gate sees that and outputs ${vout(vout(0.45, 1), 1).toFixed(2)} V. One stage already restores a full level, and a second is as clean. The shaded band is what the 0 / 1 / X simulator calls X: an input that
        lands there has no defined output.</p>
        <p>The price is in the middle. At V<sub>M</sub> both devices are saturated and a <strong>short-circuit current</strong> of ${VTC_SC.toFixed(0)} µA flows from VDD to ground. It lasts only while the input crosses the band, which is why slow edges burn power.</p>
        <div class="try">Set Vin to V<sub>M</sub> and read both regions, then make Wp / Wn 1 and watch the shaded band slide.</div>`,
      widget: () => vtcWidget(),
      more: {
        derive: `<p>Each point solves I<sub>n</sub>(Vin, Vout) = I<sub>p</sub>(VDD − Vin, VDD − Vout) with chapter 1's device (k = ${K} µA/V², V<sub>t</sub> = ${VT} V, channel-length factor 0.05 /V) by bisection on Vout, which is monotone. Matched means
          the PMOS carries ${MOBILITY_RATIO}× the width. By symmetry V<sub>M</sub> = VDD / 2, and with both in saturation at V<sub>M</sub> the current is (k / 2)·(V<sub>M</sub> − V<sub>t</sub>)² · (1 + λ V<sub>M</sub>) = ${VTC_SC.toFixed(0)} µA. The test pins V<sub>M</sub> to VDD / 2 for the matched pair and
          to the solver's own fixed point elsewhere.</p>`,
        numbers: `<table class="mini"><tr><th>Wp / Wn</th><th>V<sub>M</sub></th><th>NM<sub>L</sub></th><th>NM<sub>H</sub></th></tr>${[1, MOBILITY_RATIO, 4].map((w) => { const m = metrics(strength(w)); return `<tr><td>${w}</td><td>${m.vm.toFixed(2)} V</td><td>${m.nmL.toFixed(2)} V</td><td>${m.nmH.toFixed(2)} V</td></tr>`; }).join('')}</table>`,
        pitfall: `<p>Reading V<sub>M</sub> = VDD / 2 as a law. It holds only for a matched pair; every real gate has its own V<sub>M</sub> (a NAND's series NMOS and parallel PMOS put it above that of an inverter of the same size, a NOR's below), and the noise margins follow it.</p>`,
        real: `<p>Supplies have fallen from 5 V to under 1 V while V<sub>t</sub> has not followed, so the margins in volts shrink with VDD and the share of the swing the band takes grows. Process variation moves V<sub>t</sub> between transistors on one chip, which is why designers check the margins at the corners.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'At Vin = V<sub>M</sub> of a matched inverter, what are the two transistors doing?',
        options: ['Exactly one conducts, as for a valid input', 'Both conduct, in saturation: a short-circuit current flows', 'Neither conducts: the output floats'], answer: 1,
        why: ['That holds outside the shaded band only. Inside it both channels are open.', '', 'Both gate-source voltages are above V<sub>t</sub> in size, so neither is cut off.'],
        explain: `Vgs = ${VTC_M.vm.toFixed(2)} V is above V<sub>t</sub> = ${VT} V for the NMOS, and so is the PMOS's source-gate voltage. Both are saturated at the middle of the curve, ${VTC_SC.toFixed(0)} µA straight through.`,
      },
    },
    {
      title: 'The wrong way round: weak levels',
      body: `
        <p>Swap the two: <span data-show="n1">an NMOS</span> to VDD, <span data-show="p1">a PMOS</span> to ground. With
        <code>a = 1</code> the NMOS conducts, but only while its gate is a threshold above its source: <code>y</code>
        rises to VDD − V<sub>t</sub> = ${VDD_VOLTS} − ${VT_VOLTS} = <strong>${(VDD_VOLTS - VT_VOLTS).toFixed(1)} V</strong> and the channel pinches off. That is a
        <strong>weak 1</strong>, drawn between the 0 and 1 colours and tagged <strong>H</strong>. With <code>a = 0</code>
        the PMOS stops at V<sub>t</sub>: a weak 0, <strong>L</strong> at ${VT_VOLTS} V. The bits are right; the levels are not. (The switch-level model uses an illustrative ${VDD_VOLTS} V supply and V<sub>t</sub> = ${VT_VOLTS} V, not chapter 1's 1.8 V / 0.45 V device, so its levels are ${(VDD_VOLTS - VT_VOLTS).toFixed(2)} V and ${VT_VOLTS.toFixed(2)} V; the ratios are what carry over.)</p>
        <p>A CMOS gate reading H still reads 1 and drives a full 0 from its rails, so the level is restored one gate
        later. The price is in that gate: its PMOS sees ${(VDD_VOLTS - VT_VOLTS).toFixed(1)} V against ${VDD_VOLTS} V, right at threshold, partly on, and a
        current flows from VDD to ground all the time. A 1 passed by an NMOS whose own gate is H is worse: ${(VDD_VOLTS - VT_VOLTS).toFixed(1)} − ${VT_VOLTS} =
        ${(VDD_VOLTS - 2 * VT_VOLTS).toFixed(1)} V, which no gate reads as anything: X.</p>
        <p><span data-show="tg">A transmission gate</span> puts a PMOS beside the NMOS, gated by the complement
        (<span data-show="inv">an inverter</span> makes <code>en_n</code>): the NMOS carries a 0 whole, the PMOS the
        last 0.3 V of a 1, so <code>q</code> follows <code>d</code> at full swing. Two transistors and an inverted
        enable instead of one transistor; muxes and latches built from them still come out smaller than the same circuits built from plain gates.</p>
        <div class="try">Toggle <code>a</code> and read y's tag; set <code>en = 1</code> and toggle <code>d</code>:
        <code>q</code> has no tag.</div>`,
      scene: () => ({ root: WEAK_DEMO, inputs: { a: 1, d: 1, en: 1 } }),
      tour: {
        beats: [
          { title: 'An NMOS passes a 1', set: { a: 1 }, show: ['n1'], expect: { y: 1 },
            say: `<p>a = 1: n1 conducts and y rises toward VDD, but stops at ${(VDD_VOLTS - VT_VOLTS).toFixed(1)} V. The simulator calls it a 1 ({v:y}) and tags it H: the bit is right, the level is weak.</p>` },
          { title: 'A PMOS passes a 0', set: { a: 0 }, show: ['p1'], expect: { y: 0 },
            say: `<p>a = 0: now p1 conducts toward ground and stops at ${VT_VOLTS} V: y = {v:y}, tagged L. The mirror image.</p>` },
          { title: 'The transmission gate: a 1', set: { en: 1, d: 1 }, show: ['tg', 'inv'], expect: { q: 1 },
            say: '<p>en = 1, d = 1: the NMOS carries the first part, the PMOS the last threshold of the rise. q = {v:q} at the full level, with no tag.</p>' },
          { title: 'The transmission gate: a 0', set: { d: 0 }, show: ['tg'], expect: { q: 0 },
            say: '<p>d = 0: the NMOS pulls the whole way and the PMOS helps near the start. q = {v:q}, whole.</p>' },
        ],
      },
      more: {
        derive: `<p>An NMOS conducts while V<sub>gs</sub> > V<sub>t</sub>. With its gate at VDD and the far terminal rising from 0, V<sub>gs</sub> = VDD − V<sub>out</sub>, so it stops at V<sub>out</sub> = VDD − V<sub>t</sub> =
          ${(VDD_VOLTS - VT_VOLTS).toFixed(1)} V on a ${VDD_VOLTS} V supply: ${(100 * (VDD_VOLTS - VT_VOLTS) / VDD_VOLTS).toFixed(0)} % of the swing. A second NMOS gated by that H level sees V<sub>gs</sub> = ${(VDD_VOLTS - VT_VOLTS).toFixed(1)} − V<sub>out</sub> and stops at
          ${(VDD_VOLTS - 2 * VT_VOLTS).toFixed(1)} V, under the ${(VDD_VOLTS / 2).toFixed(2)} V midpoint: unreadable. The PMOS and NMOS together cover both ends, which is the transmission gate.</p>`,
        pitfall: `<p>Building a pass chain of NMOS switches and reading its far end as a clean 1. Each stage loses a threshold and adds resistance, and the level is no longer a 1 two stages on. A weak level needs a restoring gate
          (an inverter or buffer) every few stages.</p>`,
        real: `<p>Pass-transistor and transmission-gate logic were used in early NMOS and still appear in multiplexers and latches of custom cells, where the cell with two transistors per switch is smaller than the NAND form. Full CMOS standard
          cells avoid them by default because the weak levels and the noise sensitivity are hard for automatic tools to check.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'An NMOS whose gate is at VDD passes a 1 from VDD. What reaches its other side?',
        options: ['VDD − Vt: a weak 1', 'VDD: a full 1', 'Vt: a weak 0', 'Nothing: it is off'], answer: 0,
        why: ['', 'It stops conducting once its source is within Vt of its gate: the last Vt never arrives. A PMOS (or a transmission gate) carries a 1 whole.', 'That is a PMOS passing a 0.', 'A gate at VDD turns an NMOS on; it conducts until its source reaches VDD − Vt.'],
        explain: 'VDD − Vt. An NMOS needs Vgs > Vt to conduct; as the far side rises toward VDD, Vgs shrinks to Vt and the channel closes. That is why pull-ups are PMOS and pull-downs NMOS in every static CMOS gate.',
      },
    },
    {
      title: 'The cheaper, hotter way: a pull-up',
      body: `
        <p>Replace the PMOS with <span data-show="pu"><strong>a pull-up</strong></span> to VDD that is always on and keep
        <span data-show="n1">the NMOS</span>: a <strong>pseudo-NMOS</strong> inverter. Here the pull-up is a resistor; in
        silicon it is a PMOS with its gate tied to ground, always conducting and made weak, which is the same thing to
        the logic. With <code>a = 0</code> the pull-up takes <code>y</code> to 1.
        With <code>a = 1</code> both paths conduct and the NMOS wins, because it is sized to be much stronger
        (<em>ratioed</em> logic; here a resistor is weaker than any transistor).</p>
        <p>What it costs: while <code>y = 0</code> a current flows from VDD through the resistor and the NMOS
        to ground, all the time, not just while switching. The low level is only as good as the ratio, and the
        rising edge is as slow as the pull-up. What it saves: the pull-up network. An n-input <span data-ahead="nor">NOR (a gate whose output is 1 only when every input is 0)</span> is n NMOS and one
        pull-up, n + 1 devices instead of 2n, which is why wide NORs (the row lines of a stored table) and open-drain buses still
        pull up.</p>
        <div class="try">Toggle <code>a</code> and watch the NMOS override the pull-up. The <span data-ahead="truthtable">truth table (the output listed for every input combination)</span> is the
        CMOS inverter's: same function and the same two devices, none of the standby savings.</div>`,
      scene: () => ({ root: INV_PSEUDO, inputs: { a: 1 } }),
      tour: {
        beats: [
          { title: 'Input low', set: { a: 0 }, show: ['pu'], expect: { y: 1 },
            say: '<p>a = 0: the NMOS is off and the pull-up takes y to VDD: y = {v:y}. No current flows once y has charged.</p>' },
          { title: 'Input high: a fight', set: { a: 1 }, show: ['pu', 'n1', 'gnd'], expect: { y: 0 },
            say: '<p>a = 1: the NMOS conducts and so does the pull-up. The NMOS is much stronger, so y goes to {v:y}, but a current runs from VDD through the pull-up and the NMOS to ground for as long as a stays 1.</p>' },
          { title: 'Input low again', set: { a: 0 }, show: ['pu', 'n1'], expect: { y: 1 },
            say: '<p>a = 0: the current stops, y = {v:y}. The rise is slow, as slow as the weak pull-up charging the load, where CMOS has a conducting PMOS.</p>' },
        ],
      },
      more: {
        derive: `<p>With a = 1 the pull-up (resistance R) and the NMOS (on-resistance R<sub>n</sub>) form a divider: V<sub>OL</sub> = VDD · R<sub>n</sub> / (R + R<sub>n</sub>), so the low is a 0 only if R ≫ R<sub>n</sub>, and the current is VDD / (R + R<sub>n</sub>). Making R larger
          improves V<sub>OL</sub> and cuts the standing current but slows the rising edge (R·C); a ratio costs speed, current or noise margin. The saving is in the count: n inputs take n NMOS and one pull-up in a NOR, n + 1 devices, against 2n.</p>`,
        numbers: `<table class="mini"><tr><th>NOR inputs</th>${[2, 3, 4, 8].map((n) => `<td>${n}</td>`).join('')}</tr>
          <tr><th>CMOS devices</th>${[2, 3, 4, 8].map((n) => `<td>${2 * n}</td>`).join('')}</tr>
          <tr><th>pseudo-NMOS devices</th>${[2, 3, 4, 8].map((n) => `<td>${n + 1}</td>`).join('')}</tr></table>`,
        pitfall: `<p>Reading "n + 1 devices" as "half the area". The pull-up must be weak, so it is a long, narrow device, and the NMOS pull-downs must be wide enough to win the ratio; the count shrinks, the area does not shrink as much,
          and the standing current is paid whenever the output is low. A wide NOR with most outputs low (a ROM row at rest) burns the most.</p>`,
        real: `<p>NMOS-only chips (the 6502 of Appendix A) used the same ratioed idea: depletion-mode loads as the pull-up, the only kind of pull-up their process made. CMOS replaced them because the standing current of
          a chip with thousands of gates in the low state became the chip's heat budget.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'When does the pseudo-NMOS inverter draw current with its input held still?',
        options: ['Never', 'While a = 0', 'While a = 1', 'Always'], answer: 2,
        explain: 'While a = 1 the NMOS conducts and the resistor connects VDD to it: a resistive path from VDD to ground. With a = 0 the NMOS is open and no current flows once y has charged to 1.',
        why: ['That is CMOS. Here the resistor is always connected to VDD, so a conducting NMOS below it makes a steady path to ground.', 'With a = 0 the NMOS is open: y charges to 1 through the resistor and the current stops.', '', 'With a = 0 nothing below the resistor conducts, so once y is at 1 no current flows.'],
      },
    },
    {
      title: 'A ring of inverters',
      body: `
        <p>Chain an odd number of inverting stages into a loop and no assignment of 0s and 1s is consistent: every stage's output is the inverse of its input, so the loop contradicts itself, and the
        change goes round and round. That is a <strong>ring oscillator</strong>. Here five stages, one of them a <span data-ahead="nand">NAND (a gate whose output is 0 only when every input is 1)</span> so that <code>en</code> can hold the ring still.</p>
        <p>Set <code>en</code> to 1 and watch <code>y</code>. A change leaves a stage one gate delay after it arrives, so it takes ${RING_N} delays to go once round, and the loop is then inverted: it needs a second lap to return to
        where it began. The period is therefore 2 × ${RING_N} = ${2 * RING_N} gate delays whatever drives it. At an illustrative ${PS_PER_NAND} ps a stage that is ${((1e3 / (2 * RING_N * PS_PER_NAND))).toFixed(1)} GHz.</p>
        <p>This is how a fabrication line measures its transistors: a ring of a few hundred inverters on a test chip, its frequency read from outside, divided by 2N. It is the delay of the real gates with their real wires, with no clock and no probe loading a node.</p>
        <div class="try">Enable the ring, then use <strong>Step</strong> to advance one gate delay at a time and count the steps between two rising edges of y.</div>`,
      scene: () => ({ root: ringOsc(RING_N), inputs: { en: 0 }, analyzer: true, animate: true }),
      tries: [(st) => st.value('en') === 1],
      more: {
        derive: `<p>With stage delay t<sub>d</sub> the period is 2·N·t<sub>d</sub>, so t<sub>d</sub> = T / 2N. Seven stages at ${PS_PER_NAND} ps: T = ${14 * PS_PER_NAND} ps. The test <code>tests/cmosgates.test.ts</code> runs 3, 5 and 7 stages on the gate simulator and finds 6, 10 and 14 delays between rising edges.</p>`,
        pitfall: `<p>Using an even number of stages. The loop then has two consistent states (a latch, chapter 8) and sits in one of them. Odd is what makes it unable to settle.</p>`,
        real: `<p>The simulator settles every circuit it can; an oscillator is the one it cannot, and the stage animates it instead of settling (the Timing panel shows the square wave). In silicon the frequency also drifts with temperature and supply: a ring is a thermometer as much as a clock.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A 7-stage ring runs at an illustrative stage delay of ' + PS_PER_NAND + ' ps. What is its period?',
        options: [`${7 * PS_PER_NAND} ps: one lap`, `${14 * PS_PER_NAND} ps: two laps`, `${3 * PS_PER_NAND} ps: half the stages`], answer: 1,
        why: ['One lap inverts the signal, so y has made one edge, not a period.', '', 'The change visits every stage in turn; nothing runs in parallel.'],
        explain: `A rising edge takes 7 delays to come back inverted as a falling edge, and another 7 to rise again: 14 × ${PS_PER_NAND} = ${14 * PS_PER_NAND} ps.`,
      },
    },
    {
      title: 'Driving a big load',
      body: `
        <p>A gate that must drive far more capacitance than its own input, a long wire, a clock tree, the pads of a chip, is slow if one minimum inverter does it, and one huge inverter loads the stage before. The answer is a chain,
        each inverter bigger than the last. Count delay in <strong>τ</strong>, the time an inverter takes to drive a copy of itself with no parasitics. A stage that drives h times its own input capacitance takes
        <code>d = h + p</code>, with p = ${P_INV} τ of its own drain capacitance. Drive a load F times the first input through N stages and, with equal ratios, h = F<sup>1/N</sup> per stage: D = N·F<sup>1/N</sup> + N·p.</p>
        <p>Try F = 64 below. One stage costs ${chainDelay(64, 1).toFixed(0)} τ. Two take ${chainDelay(64, 2).toFixed(0)}. Three, each 4× the one before, take ${chainDelay(64, 3).toFixed(0)}, the best. Four is already slower (${chainDelay(64, 4).toFixed(1)}), because every extra stage pays another p.
        Whatever the load, the best ratio stays between 3 and 6: the stage count grows with the logarithm of F.</p>
        <p>The yardstick is the <strong>FO4</strong> delay, an inverter driving four copies of itself: ${FO4_TAU} τ, an illustrative ${FO4_TAU * PS_PER_TAU} ps here. Process generations are compared in FO4s, and a processor core fits roughly 15 to 20 of them in one clock cycle.
        <a href="#/c/fastadd/0">Chapter ${numOf('fastadd')}</a> applies the same arithmetic to the <span data-ahead="nand">NAND (a gate whose output is 0 only when every input is 1)</span>, whose effort is 4/3 and not 1.</p>`,
      widget: () => sizingWidget(),
      more: {
        derive: `<p>Minimising D over N for fixed F: dD/dN = 0 gives ρ(ln ρ − 1) = p with ρ = F<sup>1/N</sup>. For p = ${P_INV} that is ρ ≈ 3.6, and the discrete optimum for F = 64 happens to be exactly 4. The delay at the optimum is N·(ρ + p), ${chainDelay(64, 3).toFixed(0)} τ for F = 64, against ${chainDelay(64, 1).toFixed(0)} τ for a single stage: a ${(chainDelay(64, 1) / chainDelay(64, 3)).toFixed(1)}× saving from two extra inverters.</p>`,
        pitfall: `<p>Sizing every stage as large as the load allows. The chain's cost is area and the energy of charging its own gates, a geometric series dominated by the last stage; the optimum for speed is not the optimum for power, and designers back off to ratios near 6 to 8 to save both.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'An inverter must drive 64 times its own input capacitance. How many stages give the least delay?',
        options: ['1: a single, big inverter', '3: each 4× the last', '6: each 2× the last'], answer: 1,
        why: [`${chainDelay(64, 1).toFixed(0)} τ: the load swamps it.`, '', `${chainDelay(64, 6).toFixed(1)} τ: the six parasitic delays outweigh the lower ratio.`],
        explain: `D(N) = N·64^(1/N) + N: ${[1, 2, 3, 4, 6].map((n) => `N = ${n}: ${chainDelay(64, n).toFixed(1)} τ`).join(', ')}. Three stages of ratio 4.`,
      },
    },
  ],
};

const RCA32_DEPTH = logicDepth(rca(32))!;

export const chNand: Chapter = {
  id: 'nand', num: numOf('nand'), title: 'The NAND gate', level: 'Transistors → gates',
  blurb: 'Four transistors, and the only brick we will ever need.',
  goals: [
    'build a two-input gate from a pull-up network of PMOS and its dual pull-down of NMOS',
    'say why designers prefer NAND to NOR (the slow PMOS in parallel, not in series) and put numbers on it: logical effort (n + 2) / 3 against (2n + 1) / 3, and why wide gates lose to trees of two',
    'explain why one gate type is enough for every circuit on this site',
    'price a NAND in transistors, and in <span data-ahead="relay">relays (switches closed by the magnetic pull of a coil)</span> and tubes',
  ],
  builds: ['inverter'],
  recap: {
    keep: [
      'A CMOS gate is a pull-up network of PMOS and a pull-down network of NMOS that are each other\'s dual: parallel in one, series in the other. For every input exactly one of them conducts.',
      'NAND: PMOS in parallel, NMOS in series. NOR is the dual. A single CMOS stage always inverts, so NAND (4 transistors) is cheaper than <span data-ahead="and">AND (a gate whose output is 1 only when every input is 1)</span> (6).',
      'NAND is <strong>functionally complete</strong>. Every circuit on this site bottoms out in NANDs, and the gate counts count them.',
      'An n-input NAND is 2n transistors with a stack n deep: logical effort (n + 2) / 3, parasitic delay n. A NOR is (2n + 1) / 3, so NOR3 (7/3) takes more effort than NAND4 (2). A 4-input <span data-ahead="and">AND (a gate whose output is 1 only when every input is 1)</span> is faster as two NAND2 into a NOR2 than as a NAND4 and an inverter.',
      'A NAND is a function: CMOS, <span data-ahead="relay">relays (switches closed by the magnetic pull of a coil)</span> or tubes change its price (time, power, size), never the netlist.',
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
        question: 'By logical effort, which gate is slowest to drive a given load at minimum input capacitance?',
        options: ['NAND3, g = 5/3', 'NOR3, g = 7/3', 'NAND2, g = 4/3'],
        answer: 1,
        explain: 'A NOR stacks its weak PMOS: widening three in series costs 2n + 1 = 7 units of input capacitance against n + 2 = 5 for a NAND3.',
        why: ['That is the NAND3: the stack is NMOS, the stronger device.', '', 'The two-input NAND is the fastest of the three.'],
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
        <p>The output is 0 only when <code>a</code> and <code>b</code> are both 1. That is NOT-AND:
        <strong>NAND</strong>.</p>
        <table><tr><th>a</th><th>b</th><th>y</th></tr><tr><td>0</td><td>0</td><td>1</td></tr><tr><td>0</td><td>1</td><td>1</td></tr><tr><td>1</td><td>0</td><td>1</td></tr><tr><td>1</td><td>1</td><td>0</td></tr></table>
        <p>Why this arrangement and not another: the output must be driven for every input, so the two networks have to be exact complements. The pull-down conducts when
        <code>a·b</code> = 1 (series: both on). The pull-up must conduct in every other case, <code>¬a + ¬b</code> = 1 (parallel: either PMOS on). <span data-ahead="demorgan">De Morgan's law (inverting a product gives a sum of inverted terms, and the reverse)</span> turns series into parallel and
        back, so the complement of a network is its <em>dual</em>, with every series replaced by a parallel and the reverse. Count: ${stats(NAND).transistors} transistors, one NMOS and one PMOS per input.</p>
        <div class="try">Find the input where the series NMOS pair forms a complete path to ground.</div>`,
      scene: () => ({ root: NAND, inputs: { a: 1, b: 0 } }),
      tour: {
        beats: [
          { title: 'Both low', set: { a: 0, b: 0 }, show: ['p1', 'p2', 'vdd'], expect: { y: 1 },
            say: '<p>a = b = 0: both PMOS conduct, both NMOS are off. Two parallel paths to VDD: y = {v:y}.</p>' },
          { title: 'One high', set: { a: 1, b: 0 }, show: ['p1', 'p2', 'n1', 'n2'], expect: { y: 1 },
            say: '<p>a = 1, b = 0: the PMOS on b conducts, the PMOS on a is off. One path to VDD is enough: y = {v:y}. The NMOS on b is off, so the series chain to ground is broken.</p>' },
          { title: 'Both high', set: { a: 1, b: 1 }, show: ['n1', 'n2', 'gnd'], expect: { y: 0 },
            say: '<p>a = b = 1: both NMOS conduct in series and connect y to ground; both PMOS are off. y = {v:y}. This is the only row with a path to ground.</p>' },
          { title: 'The other single high', set: { a: 0, b: 1 }, show: ['p1', 'p2', 'n1', 'n2'], expect: { y: 1 },
            say: '<p>a = 0, b = 1: the mirror of the second row. y = {v:y}. Exactly one network conducts in every row.</p>' },
        ],
      },
      more: {
        derive: `<p>For n inputs, the pull-down is n NMOS in series (conducts on a₁···aₙ = 1) and the pull-up n PMOS in parallel (conducts if any aᵢ = 0), so an n-input NAND is 2n transistors and
          its pull-down is a stack n deep: ${[2, 3, 4].map((n) => `${n} inputs: ${2 * n} transistors, stack ${n}`).join('; ')}. A deep stack is slow, because the current through n series devices is about 1/n of one; that limits CMOS gates to about four inputs.</p>`,
        pitfall: `<p>Building the pull-up as a series chain "because it looks symmetrical". With series PMOS and series NMOS, no row would be driven to both rails correctly: for a = 1, b = 0 neither chain conducts and y floats.
          A valid complementary gate needs one network in series and the other in parallel.</p>`,
        numbers: `<table class="mini"><tr><th>inputs</th>${[1, 2, 3, 4].map((n) => `<td>${n}</td>`).join('')}</tr><tr><th>transistors</th>${[1, 2, 3, 4].map((n) => `<td>${2 * n}</td>`).join('')}</tr>
          <tr><th>series stack</th>${[1, 2, 3, 4].map((n) => `<td>${n}</td>`).join('')}</tr></table>`,
      },
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
      title: 'Three and four inputs',
      body: `
        <p>Nothing limits a NAND to two inputs: three parallel PMOS, three NMOS in series. Here is the three-input gate, ${stats(cmosNand(3)).transistors} transistors. The pull-down is a stack of
        <span data-show="n1 n2 n3">three NMOS</span>, so it conducts only when all three inputs are 1; any one input at 0 turns on its PMOS in the <span data-show="p1 p2 p3">parallel pull-up</span>.</p>
        <p>What it costs is speed. A series stack of n devices passes about 1/n of the current of one, so to pull down as fast as an inverter each NMOS must be n times wider, and the gate's input capacitance grows with it. In
        logical effort (a gate's input capacitance relative to an inverter delivering the same current, so its delay per unit of load in τ, as in chapter 2's last step) a NAND with n inputs has <strong>g = (n + 2) / 3</strong> and a parasitic delay p = n:
        ${[2, 3, 4].map((n) => `NAND${n} g = ${fmtFrac(gNand(n))}, p = ${n}`).join('; ')}. Every extra input loads every gate that drives it and slows the gate itself.</p>
        <p>That is why libraries stop at four inputs and why the brick of this site has two. Wider gates are not forbidden, but a tree of two-input gates is usually as fast and no larger: the NOR step below compares them.</p>
        <div class="try">Make the output 0, then lift any single input and find the PMOS that takes y back up.</div>`,
      scene: () => ({ root: cmosNand(3), inputs: { a: 1, b: 1, c: 0 } }),
      tries: [(st) => st.value('y') === 0],
      tour: {
        beats: [
          { title: 'One input low', set: { a: 1, b: 1, c: 0 }, show: ['p3', 'n3'], expect: { y: 1 },
            say: '<p>c = 0: the series chain is broken at n3, and the PMOS on c conducts. y = {v:y}.</p>' },
          { title: 'All high', set: { a: 1, b: 1, c: 1 }, show: ['n1', 'n2', 'n3', 'gnd'], expect: { y: 0 },
            say: '<p>a = b = c = 1: the stack of three conducts and all three PMOS are off. y = {v:y}. This is the only row of eight with a path to ground.</p>' },
          { title: 'Another single zero', set: { a: 0, b: 1, c: 1 }, show: ['p1', 'n1'], expect: { y: 1 },
            say: '<p>a = 0: n1 breaks the chain and p1 pulls up. y = {v:y}. Any single zero is enough.</p>' },
        ],
      },
      more: {
        derive: `<p>With the PMOS twice the NMOS width (r = 2), an inverter has input capacitance 3 (in units of one NMOS gate) and delivers one NMOS's current. A NAND<sub>n</sub> sized for the same current widens each NMOS to n and keeps each PMOS at 2: input capacitance n + 2, so g = (n + 2) / 3. Its output node
          carries n PMOS drains and one NMOS drain: the parasitic delay p grows as n.</p>`,
        numbers: `<table class="mini"><tr><th>inputs</th>${[2, 3, 4].map((n) => `<td>${n}</td>`).join('')}</tr><tr><th>transistors</th>${[2, 3, 4].map((n) => `<td>${2 * n}</td>`).join('')}</tr>
          <tr><th>NMOS stack</th>${[2, 3, 4].map((n) => `<td>${n}</td>`).join('')}</tr><tr><th>logical effort g</th>${[2, 3, 4].map((n) => `<td>${fmtFrac(gNand(n))}</td>`).join('')}</tr>
          <tr><th>parasitic p (τ)</th>${[2, 3, 4].map((n) => `<td>${pGate(n)}</td>`).join('')}</tr></table>`,
        pitfall: `<p>Reading g as a count of transistors. The three-input NAND has six transistors and g = 5/3 only because they are sized as above; the Timing panel's Load model prices the NAND2 brick and builds wider gates from it.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Make the three-input NAND output 0.', check: (st) => st.value('y') === 0,
        hints: ['A series chain conducts only when every switch in it does.', 'An NMOS conducts when its gate is 1. How many NMOS are in the chain?'],
        answer: 'a = b = c = 1: all three series NMOS conduct and connect y to ground, and the three PMOS are off.',
        solve: (st) => st.setInputs({ a: 1, b: 1, c: 1 }),
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
        <p>The same transistor count and the same duality; the only difference is which network is in series. The pull-up in a NOR stacks two weak devices, so to pull up as fast as an inverter
        each must be twice as wide, and the gate takes more silicon than the NAND's at the same speed. The sizing table below puts numbers on it.</p>
        <div class="try">Find the one input that makes the NOR output 1.</div>`,
      scene: () => ({ root: NOR_CMOS, inputs: { a: 1, b: 0 } }),
      tries: [(st) => st.value('y') === 1],
      tour: {
        beats: [
          { title: 'Both low', set: { a: 0, b: 0 }, show: ['p1', 'p2', 'vdd'], expect: { y: 1 },
            say: '<p>a = b = 0: both PMOS conduct, and they are in series, so the path to VDD goes through both. y = {v:y}. The weak devices are in the way of the rise.</p>' },
          { title: 'One high', set: { a: 1, b: 0 }, show: ['p1', 'p2', 'n1', 'n2'], expect: { y: 0 },
            say: '<p>a = 1, b = 0: the NMOS on a conducts and pulls y to ground; the series PMOS chain is broken. y = {v:y}. One high input is enough, the NOR.</p>' },
          { title: 'Both high', set: { a: 1, b: 1 }, show: ['n1', 'n2', 'gnd'], expect: { y: 0 },
            say: '<p>a = b = 1: both NMOS conduct in parallel, with the larger current to ground: y = {v:y}.</p>' },
        ],
      },
      more: {
        derive: `<p>For equal drive to an inverter of N-width 1 and P-width r (r is the electron to hole mobility ratio, 2 to 3), a NAND2 needs N-width 2 for its series NMOS and P-width r for its parallel PMOS; a NOR2 needs N-width 1
          and P-width 2r. Total width, in units of the inverter's NMOS: NAND2 = 2·2 + 2·r = ${4 + 2 * 2} at r = 2 and ${4 + 2 * 3} at r = 3; NOR2 = 2·1 + 2·2r = ${2 + 4 * 2} at r = 2 and ${2 + 4 * 3} at r = 3.</p>`,
        numbers: `<table class="mini"><tr><th>mobility ratio r</th><th>NAND2 total width</th><th>NOR2 total width</th><th>NOR2 / NAND2</th></tr>${[2, 3].map((r) => `<tr><td>${r}</td><td>${4 + 2 * r}</td><td>${2 + 4 * r}</td><td>${((2 + 4 * r) / (4 + 2 * r)).toFixed(2)}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Counting transistors instead of area. Both gates have ${stats(NOR_CMOS).transistors}; the comparison only shows when each is sized to match the inverter. Gate-count tables on this site count NANDs for the same reason: the NAND is the cheap unit.</p>`,
      },
    },
    {
      title: 'NOR gets worse faster',
      body: `
        <p>The same widening argument hits NOR on its PMOS. Three PMOS in <span data-show="p1 p2 p3">series</span> must each be three times as wide to match an inverter's pull-up, and a PMOS is already the weaker device: g<sub>NOR<i>n</i></sub> = <strong>(2n + 1) / 3</strong>.
        Side by side: ${[2, 3, 4].map((n) => `${n} inputs, NAND ${fmtFrac(gNand(n))}, NOR ${fmtFrac(gNor(n))}`).join('; ')}. NOR3 costs more effort than NAND4 (as much as a NAND5), and NOR4 is worse than any gate the site uses.</p>
        <p>The effect is on whole structures. A 4-input <span data-ahead="and">AND (a gate whose output is 1 only when every input is 1)</span> driving four loads (H = 4) can be one NAND4 and an inverter, or two NAND2 into a NOR2. Path delay is D = N·F<sup>1/N</sup> + ΣP, with F = G·H the product of the efforts:
        the wide version has G = ${fmtFrac(gNand(4))} · 1, ΣP = ${pGate(4) + 1}, D = ${and4Wide(4).toFixed(1)} τ; the tree has G = ${fmtFrac(gNand(2))} · ${fmtFrac(gNor(2))} = ${(gNand(2) * gNor(2)).toFixed(2)}, ΣP = ${2 * pGate(2)}, D = <strong>${and4Tree(4).toFixed(1)} τ</strong>. The tree wins at every load from 1 to 16
        (${and4Tree(1).toFixed(1)} against ${and4Wide(1).toFixed(1)} τ at H = 1), with shorter stacks. This is the working reason NAND2 is the brick: two-input gates compose into everything with nothing lost.</p>
        <div class="try">Make the output 1: how many inputs must be 0?</div>`,
      scene: () => ({ root: cmosNor(3), inputs: { a: 1, b: 0, c: 0 } }),
      tries: [(st) => st.value('y') === 1],
      tour: {
        beats: [
          { title: 'All low', set: { a: 0, b: 0, c: 0 }, show: ['p1', 'p2', 'p3', 'vdd'], expect: { y: 1 },
            say: '<p>a = b = c = 0: the three PMOS conduct in series, and y is connected to VDD through all of them. y = {v:y}. Three weak devices in a row.</p>' },
          { title: 'One high', set: { a: 0, b: 1, c: 0 }, show: ['n2', 'gnd'], expect: { y: 0 },
            say: '<p>b = 1: its NMOS conducts, alone, to ground; the PMOS chain is broken at p2. y = {v:y}.</p>' },
        ],
      },
      more: {
        derive: `<p>NOR<sub>n</sub> keeps each NMOS at 1 and widens each PMOS to 2n: input capacitance 2n + 1, so g = (2n + 1) / 3. Both gates have p = n. ${[1, 4, 16].map((H) => `At H = ${H}: wide ${and4Wide(H).toFixed(2)} τ, tree ${and4Tree(H).toFixed(2)} τ`).join('; ')}.</p>`,
        pitfall: `<p>Concluding that wide gates are never used. A 4-input NAND on a path with slack costs fewer transistors than the tree, and cell libraries have them; the argument is about what to build when speed matters, and about why a site that counts in NANDs loses little by fixing fan-in at two.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A 4-input <span data-ahead="and">AND (a gate whose output is 1 only when every input is 1)</span> drives four loads. Which implementation has the smaller delay by logical effort?',
        options: [`One NAND4 and an inverter: ${and4Wide(4).toFixed(1)} τ`, `Two NAND2 into a NOR2: ${and4Tree(4).toFixed(1)} τ`, 'The same: both are four inputs'], answer: 1,
        why: ['The NAND4 stack is four deep: its g = 2 and p = 4 outweigh the saving of a narrower path.', '', 'Delay depends on the structure: logical effort and parasitic delay both differ.'],
        explain: `Tree: G = 4/3 · 5/3 = 20/9, F = G·H = ${((20 / 9) * 4).toFixed(2)}, D = 2·√F + 4 = ${and4Tree(4).toFixed(2)} τ. Wide: F = 2·4 = 8, D = 2·√8 + 5 = ${and4Wide(4).toFixed(2)} τ.`,
      },
    },
    {
      title: 'One brick to build everything',
      body: `
        <p>NAND is <strong>functionally complete</strong>: every logic function, and therefore every computer,
        can be built from NAND gates alone. So that is what we will do. From now on every circuit on this site
        bottoms out in NANDs.</p>
        <p>Here is our NAND, now drawn with its standard symbol, the "D" shape with a bubble. This is our first
        <strong>abstraction</strong>: we stop drawing four transistors and draw one symbol.</p>
        <p>Completeness rests on a short argument. Inverting is a NAND with its inputs tied together, "both inputs 1" is a NAND followed by that inversion, and "either input 1" is a NAND of two inverted inputs: with those three operations any
        Boolean function can be written, so any can be built. The rest of the journey is repeated application of this: everything is NANDs, and each chapter prices what it builds
        in NANDs, then in transistors (four each).</p>
        <div class="note">Abstraction is a promise, not a disguise. Double-click the symbol whenever you want
        to see the four transistors again.</div>`,
      scene: () => ({ root: bench(NAND), inputs: { a: 1, b: 1 } }),
      tour: {
        beats: [
          { title: 'A symbol', set: { a: 1, b: 1 }, show: ['u'], expect: { y: 0 },
            say: '<p>a = b = 1: y = {v:y}. The box u is a NAND, drawn as one symbol. Everything about it is its behaviour: 0 only when both inputs are 1.</p>' },
          { title: 'Open it', at: ['u'], show: ['p1', 'p2', 'n1', 'n2'],
            say: '<p>Opening u shows what the symbol stood for: four transistors. The same circuit as the last step, in the same states.</p>' },
          { title: 'Close it', at: [], set: { a: 0 }, show: ['u'], expect: { y: 1 },
            say: '<p>Back at the symbol: a = 0, y = {v:y}. You use the behaviour, and the four transistors are still there.</p>' },
        ],
      },
      more: {
        derive: `<p>NOT(a) = NAND(a, a). AND(a, b) = NOT(NAND(a, b)). OR(a, b) = NAND(NOT a, NOT b), by De Morgan. In NANDs and transistors: ${[['NOT', NOT], ['AND', AND], ['OR', OR], ['NOR', NOR], ['XOR', XOR]].map(([n, d]) => `${n as string} ${stats(d as typeof NOT).nands} NAND${stats(d as typeof NOT).nands > 1 ? 's' : ''} (${stats(d as typeof NOT).transistors} transistors)`).join(', ')}.</p>`,
        numbers: `<table class="mini"><tr><th>gate</th><th>NANDs</th><th>transistors</th><th>gate delays</th></tr>${[['NOT', NOT], ['AND', AND], ['OR', OR], ['NOR', NOR], ['XOR', XOR]].map(([n, d]) => `<tr><td>${n as string}</td><td>${stats(d as typeof NOT).nands}</td><td>${stats(d as typeof NOT).transistors}</td><td>${logicDepth(d as typeof NOT)}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Reading the NAND counts as the cheapest transistor count. A NOT as a NAND costs 4 transistors against 2 for an inverter, and an XOR in four NANDs is 16 transistors where a dedicated cell takes fewer. The site pays that on purpose to have one brick
          to count; standard-cell libraries price each gate directly.</p>`,
        real: `<p>Real standard-cell libraries have a few dozen gates (NAND, NOR, AND-OR-INVERT, multiplexers, XOR, flip-flops) because a design built only of NANDs is larger and slower than one that uses them. Universality matters to the argument that one brick is enough,
          not to the layout.</p>`,

      },
      challenge: {
        kind: 'quiz', question: 'How many transistors does a CMOS <span data-ahead="and">AND gate (output 1 only when both inputs are 1)</span> need, built the natural way?',
        options: ['4: same as NAND', '6: a NAND followed by an inverter', '2'], answer: 1,
        why: ['A NAND is 4, but its output is inverted, and undoing that inversion costs an inverter.', '', 'Two transistors make an inverter: one input, nothing to combine.'],
        explain: 'A single CMOS stage always inverts, so an AND gate is a NAND plus an inverter: 4 + 2 = 6 transistors. Inverting gates are the cheap ones.',
      },
    },
    {
      title: 'One NAND, three technologies',
      body: `
        <p>A NAND is a function, not a device. The prologue built it twice before the transistor, from <span data-ahead="relay">relays (switches closed by the magnetic pull of a coil)</span> (P1) and
        from tubes (P2). Every circuit on this site bottoms out in NANDs, so each can be built in any of the three. The
        netlist stays the same, and only the price of one NAND changes:</p>
        <ul>
          <li><strong>CMOS</strong>: 4 transistors, an illustrative ${PS_PER_NAND} ps, about ${NAND2_UM2} µm² of 28 nm-class
          silicon, femtojoules per switch.</li>
          <li><strong>Relays</strong>: one coil per NAND output. Its contacts are the inputs of the gates that read it,
          ${RELAY_CONTACTS} per relay, so a net read more than ${RELAY_CONTACTS} times needs another coil for every
          ${RELAY_CONTACTS} more. ${RELAY_STEP_MS} ms per step (P1's model: the armature closing, plus bounce), ${RELAY_POWER.toFixed(2)} W
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
      more: {
        derive: `<p>The same gate netlist is priced three ways. Time is steps times the technology's step: the 32-bit ripple adder is ${RCA32_DEPTH} steps, so ${fmtTime(RCA32_DEPTH * TECH.cmos.step)} in CMOS, ${fmtTime(RCA32_DEPTH * TECH.tube.step)} in tubes and
          ${fmtTime(RCA32_DEPTH * TECH.relay.step)} in relays. Power is devices times power each, drawn all the time for relays and tubes (a coil, a heater) and only on switching in CMOS. A relay NAND is one coil plus ${RELAY_CONTACTS}-pole
          fan-out coils; a tube NAND is half a 6SN7 and a 6AL5 with the divider into the grid; a CMOS NAND is four transistors.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>one NAND</th><th>step</th><th>steps vs CMOS</th><th>average power</th></tr>
          <tr><td>CMOS</td><td>4 transistors</td><td>${fmtTime(TECH.cmos.step)}</td><td>1</td><td>on switching only</td></tr>
          <tr><td>Tubes</td><td>½ 6SN7 + 6AL5</td><td>${fmtTime(TECH.tube.step)}</td><td>${groupDigits(Math.round(TECH.tube.step / TECH.cmos.step))}</td><td>${TUBE_BRICK_POWER.toFixed(2)} W</td></tr>
          <tr><td>Relays</td><td>1 coil, ${RELAY_CONTACTS} poles</td><td>${fmtTime(TECH.relay.step)}</td><td>${groupDigits(Math.round(TECH.relay.step / TECH.cmos.step))}</td><td>${RELAY_POWER.toFixed(2)} W</td></tr></table>`,
        pitfall: `<p>Comparing step counts across technologies. A relay adder takes far fewer steps than the same adder through the NAND brick, because its carry is a contact (P1), yet each relay step lasts some 10⁸ CMOS steps; the NAND price, which assumes none of those tricks,
          shows what each technology costs for the same logic. A native part and a NAND-mapped part are different questions, and the widget's Native view is the first.</p>`,
        real: `<p>Switching from relays to tubes to transistors cut the step by more than ${Math.floor(Math.log10(TECH.relay.step / TECH.cmos.step))} orders of magnitude, from the relay (${fmtTime(TECH.relay.step)}) to CMOS (${fmtTime(TECH.cmos.step)}), and area per gate by far more.
          No technology got there by one idea: each removed a limit (moving metal, a hot filament, the size of a switch) the last one had.</p>`,
      },
      widget: () => techCompareWidget(),
      challenge: {
        kind: 'quiz', question: `Through the brick, the 32-bit <span data-ahead="ripple">ripple-carry adder (each stage waits for the carry of the one before)</span> is ${RCA32_DEPTH} NAND delays deep. Built from <span data-ahead="relay">relays (switches closed by the magnetic pull of a coil)</span>, one add takes about:`,
        options: [fmtTime(RCA32_DEPTH * TECH.relay.step), fmtTime(TECH.relay.step), fmtTime(RCA32_DEPTH * TECH.tube.step)], answer: 0,
        why: ['', 'That is P1\'s native relay adder, whose carry runs through changeover contacts in one step. Through the NAND brick the carry ripples gate by gate.', 'That is the tube time: tubes switch in microseconds, relays in milliseconds.'],
        explain: `${RCA32_DEPTH} <span data-ahead="relaystep">relay steps (the time for every relay to follow its coil once)</span> × ${RELAY_STEP_MS} ms ≈ ${fmtTime(RCA32_DEPTH * TECH.relay.step)}. P1's relay adder carries through contacts and adds in one step (${fmtTime(TECH.relay.step)}); tubes take ${fmtTime(RCA32_DEPTH * TECH.tube.step)}, CMOS ${fmtTime(RCA32_DEPTH * TECH.cmos.step)}.`,
      },
    },
  ],
};
