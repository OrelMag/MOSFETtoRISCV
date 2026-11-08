import { groupDigits } from '../sim/numfmt';
import { DFF, ECCLES_JORDAN, FULL_ADDER, SR_LATCH, TRIODE_SWITCH, TUBE_FA, TUBE_NAND, TUBE_NOR, rca } from '../lib';
import { RELAY_STEP_MS } from '../phys/relay';
import {
  B_PLUS, DIVIDER_RATIO, ENIAC, HEATER_W, R_DIV_BOTTOM, R_DIV_TOP, R_PLATE, TUBE_STEP_US, V_BIAS, V_CUTOFF, V_LOW, dividerOut, gateLevels,
  nandBrickPower, cathodeTemp, emission, plateCurrent, plateVoltage, sectionPower, warmup,
} from '../phys/triode';
import { logicDepth, stats } from '../sim/stats';
import { PS_PER_NAND } from '../sim/timing';
import { triodeCloseup } from '../widgets/triode3d';
import { tubeDividerWidget } from '../widgets/tubedivider';
import type { Chapter } from './types';
import { numOf } from './order';

const SEC = sectionPower(), BRICK = nandBrickPower(), L1 = gateLevels(1), L2 = gateLevels(2);
const WARM = (() => {
  const w = warmup(0), full = w.at(-1)!.ip;
  return { t10: w.find((s) => s.ip >= 0.1 * full)!.t, t90: w.find((s) => s.ip >= 0.9 * full)!.t };
})();
/** How many times the hot cathode's emission exceeds the plate current at a 0 V grid (the model's 1.09 A against 7.7 mA). */
const HEADROOM = Math.round(emission(cathodeTemp(20)) / plateCurrent(0, V_LOW));
const v = (x: number) => Math.round(x).toString();
const w2 = (x: number) => x.toFixed(2);
const thin = (n: number) => groupDigits(Math.round(n));
/** The 4-bit CPU of the examples, without its ROM (Phase 14 mockup, measured). */
const CPU4_NANDS = 3357;
/** Tube steps per CMOS NAND delay, to the nearest 10 000. */
const VS_CMOS = thin(Math.round((TUBE_STEP_US * 1e6) / PS_PER_NAND / 1e4) * 1e4);

export const chTubes: Chapter = {
  id: 'tubes', num: numOf('tubes'), prologue: 'P2', title: 'Vacuum tubes', level: 'Thermionic',
  blurb: 'A switch with no moving parts: the triode, its awkward voltages, NOR as its natural gate, a flip-flop in one bulb, and ENIAC\'s bill.',
  goals: [
    'say why a triode needs a hot cathode and conducts one way only',
    `explain why every grid reads its input through a divider to ${V_BIAS} V, and what that does to fan-out`,
    'build NOR from triodes in parallel, and NAND from a diode AND and a triode',
    'price a tube gate in microseconds per step and in watts of heater, drawn whether it switches or not',
  ],
  builds: ['relays'],
  recap: {
    keep: [
      `Electrons leave only the hot cathode, so a triode conducts from plate to cathode only. The grid sets the current: about 0 V conducts, below ${V_CUTOFF} V the tube is cut off (plate at ${B_PLUS} V). From cold, nothing flows for ${WARM.t10.toFixed(1)} s.`,
      `Under its plate resistor a triode inverts, and its plate swings between ${v(V_LOW)} V and ${B_PLUS} V: ratioed logic. A ${R_DIV_TOP / 1e3} kΩ / ${R_DIV_BOTTOM / 1e3} kΩ divider to ${V_BIAS} V brings a plate to grid levels; it loads the plate, and at four dividers the chain stops working. Wide fan-outs get a cathode follower.`,
      'One-way conduction means no transmission gate and no carry through switches: every tube gate regenerates its output, and every stage adds a step.',
      `NOR is the natural triode gate: triodes in parallel under one plate resistor (real machines also gated with multi-grid tubes and diodes). The NAND brick is a 6AL5 diode AND, a divider and half a 6SN7: ${w2(BRICK.total)} W, ${w2(BRICK.heaters)} W of it heaters. Eccles–Jordan holds a bit in one 6SN7.`,
      `A tube step is about ${TUBE_STEP_US.toFixed(1)} µs (an R·C estimate): about ${thin(Math.round(RELAY_STEP_MS * 1e3 / TUBE_STEP_US / 100) * 100)} times a relay's speed. ENIAC: ${thin(ENIAC.tubes)} tubes, ${ENIAC.power / 1e3} kW, a tube failure about every two days.`,
    ],
    practise: ['v_inv', 'v_ff'],
    check: [
      {
        question: 'One tube plate must feed six grids. What does a tube machine do?',
        options: ['Put a cathode follower in front of the fan-out', 'Nothing: a plate can drive any number of dividers', 'Wire the six grids straight to the plate'],
        answer: 0,
        explain: 'Each divider loads the plate toward the bias rail; past two the margins are thin and at four the chain fails. A cathode follower drives the wide net instead.',
        why: ['', `Each divider pulls the plate toward ${V_BIAS} V: one already holds a cut-off plate at ${v(L1.high)} V, and at four the margins are gone.`, `A grid at plate level (${v(V_LOW)} V or more) conducts for ever: the next tubes would never turn off.`],
      },
      {
        question: 'Why is NOR, not a series stack, the natural gate for triodes?',
        options: [
          'In series the upper tube\'s cathode would float, which moves its grid levels; in parallel each input costs one section',
          'NOR needs fewer resistors',
          'Triodes in series conduct backwards',
        ],
        answer: 0,
        explain: 'Parallel triodes all have their cathodes on ground, so every grid sees the same levels. A series stack lifts the upper cathode off ground.',
        why: ['', 'Each input needs its own divider either way. The trouble with a series pair is the upper cathode, not the resistor count.', 'A triode never conducts backwards, in series or not: current still crosses each tube from plate to cathode.'],
      },
      {
        question: 'About how many tube steps fit in one relay step?',
        options: [`About ${thin(Math.round(RELAY_STEP_MS * 1e3 / TUBE_STEP_US / 100) * 100)}`, `About ${VS_CMOS}`, 'About 10'],
        answer: 0,
        explain: `${RELAY_STEP_MS} ms against about ${TUBE_STEP_US.toFixed(1)} µs: a relay waits for iron to move, a tube for a resistor to charge the next grid.`,
        why: ['', `That is how much slower a tube step is than a ${PS_PER_NAND} ps NAND in <span data-ahead="cmos">CMOS (the transistor logic of chapters 1 to 3)</span>.`, 'A relay step is milliseconds and a tube step about a microsecond: nearly four orders of magnitude apart.'],
      },
    ],
  },
  steps: [
    {
      title: 'A hot cathode',
      body: `
        <p>A relay waits milliseconds for iron to move. A <strong>vacuum tube</strong> moves only electrons. A heater
        brings an oxide-coated <strong>cathode</strong> to about 1000 K, hot enough to boil electrons off its surface;
        a <strong>plate</strong> (anode) at +${B_PLUS} V collects them. Between the two, a <strong>grid</strong>, a fine wire helix wound on two side rods,
        decides how many get through: at 0 V nearly all, and with the plate at ${B_PLUS} V
        none once the grid is below ${V_CUTOFF} V in this model (the ideal cutoff of the law below; on the 6SN7's datasheet curves a few microamps
        still flow to about −18 V). Its field pushes them back. Most electrons never get through at all: a cloud of them, the <strong>space charge</strong>,
        hangs round the cathode and repels the next ones, so at 0 V only about one in ${HEADROOM} of those the cathode could emit reaches the plate.</p>
        <p>This is one section of a 6SN7, the twin triode ENIAC used most. The current follows the space-charge law
        I = K·(V<sub>g</sub> + V<sub>p</sub>/µ)<sup>1.5</sup> with µ = 20, fitted to the datasheet point (250 V, −8 V,
        9 mA), and works into a 22 kΩ plate resistor. The cathode warms with a 6 s time constant, and emission
        (Richardson's law) grows exponentially with temperature. So after switch-on nothing flows for
        ${WARM.t10.toFixed(1)} s, and the full current arrives by ${WARM.t90.toFixed(1)} s.</p>
        <p>The grid is the point. It is a field, not a current: held negative it collects no electrons, so it takes no power to
        hold a level. That is the same idea as <span data-ahead="mosfet">the MOSFET's gate (the voltage-controlled switch of a transistor)</span>
        (<a href="#/c/mosfet/0">chapter 1</a>), reached fifty years earlier, with a vacuum in place of an oxide. What the tube pays for it is
        the heater: ${w2(HEATER_W)} W per section just to keep the cathode emitting, switching or not.</p>
        <div class="try">Switch it on from cold. Then sweep the grid and watch the plate: ${v(V_LOW)} V conducting,
        ${B_PLUS} V cut off.</div>`,
      more: {
        derive: `<p>Current follows I = K·(V<sub>g</sub> + V<sub>p</sub>/µ)<sup>1.5</sup> while the bracket is positive and is zero otherwise. Cutoff is where it reaches zero:
          V<sub>g</sub> = −V<sub>p</sub>/µ = −${B_PLUS}/20 = ${V_CUTOFF.toFixed(1)} V at the full plate supply. With the ${R_PLATE / 1e3} kΩ plate resistor the plate sits on the load line
          V<sub>p</sub> = ${B_PLUS} − R·I. At V<sub>g</sub> = 0 that settles at ${v(V_LOW)} V, a current of ${(1e3 * (B_PLUS - V_LOW) / R_PLATE).toFixed(1)} mA, and ${w2(SEC.resistor)} W is dissipated
          in the resistor and ${w2(SEC.plate)} W in the tube while it conducts.</p>`,
        pitfall: `<p>Reading a cold machine as "all off". Until the cathodes warm (${WARM.t10.toFixed(1)} s to a tenth of the current, ${WARM.t90.toFixed(1)} s to nine tenths) nothing conducts, so every plate
          sits at ${B_PLUS} V, which the logic reads as a 1: the machine wakes up in a state nobody designed, and resets must wait for the heaters.</p>`,
        real: `<p>The 6SN7 is a twin triode with a 6.3 V heater; ENIAC used it more than any other type. An oxide-coated cathode emits at around 1000 K, which is also why
          tubes dim and fail: the coating evaporates and the heater ages. In the model the plate current is already full at about 750 K, because the cathode could emit ${HEADROOM} times more than the plate takes; the 1000 K is the working temperature that keeps that margin for years, and an aged tube whose margin has shrunk still works until it drops below the current asked of it. Computers of the 1950s left their tubes on day and night for this reason.</p>`,
        numbers: `<table class="mini"><tr><th>grid V</th>${[0, -4, -8, -12.5].map((g) => `<td>${g}</td>`).join('')}</tr>
          <tr><th>plate V</th>${[0, -4, -8, -12.5].map((g) => `<td>${v(plateVoltage(g))}</td>`).join('')}</tr></table>`,
      },
      widget: () => triodeCloseup(),
      challenge: {
        kind: 'quiz', question: `The heater draws ${w2(HEATER_W)} W per section whether the tube switches or not. What does that do to a tube machine?`,
        options: [
          'Its power is set by the heaters, so a gate that never switches still costs watts',
          'Nothing: the heater only matters at switch-on',
          'It makes the gate faster the longer it runs',
        ],
        answer: 0,
        explain: `Of a section's ${w2(SEC.average)} W (average, conducting half the time), ${w2(HEATER_W)} W is the heater. <span data-ahead="cmos">CMOS (the transistor logic of chapters 1 to 3)</span> pays when it switches; a tube pays for being ready to.`,
        why: ['', 'The heater keeps the cathode at about 1000 K all the time. Switch it off and emission stops: the tube no longer conducts at all.', 'Once the cathode is hot the emission is steady: a warm tube switches no faster the longer it runs.'],
      },
    },
    {
      title: 'The grid',
      body: `
        <p>As a switch, <span data-show="v1">the triode</span> sits under <span data-show="rl">its plate resistor</span>, cathode on ground. Grid at 1: current flows and the
        plate falls to ${v(V_LOW)} V, a 0. Grid at 0: the tube is cut off and the resistor pulls the plate to
        ${B_PLUS} V, a 1. That is <strong>ratioed logic</strong> (<a href="#/c/inverter/0">chapter 2</a> meets it again in pseudo-NMOS): the tube wins
        over the resistor, and while it conducts, current flows from B+ (the +${B_PLUS} V plate supply) to ground for nothing.</p>
        <p>Electrons only leave the hot cathode, so current crosses the tube one way only. A triode can pull its
        plate down or push its cathode up, but it never passes a signal back the way a contact does (or, from
        chapter 1 on, <span data-ahead="mosfet">a MOSFET channel, the transistor's conducting path</span>). There is no transmission gate in tubes, and no carry that runs through switches as in the relay adder.
        The orange line is the beam: it shows while the tube conducts.</p>
        <p>The plate resistor is the price of the output: while the tube conducts, ${w2(SEC.resistor)} W goes into it and ${w2(SEC.plate)} W into the tube, from the supply
        to ground, on top of the heater. A <span data-ahead="cmos inverter">CMOS inverter (a pair of complementary transistors)</span> has no such standing path; the tube circuit is the pseudo-NMOS inverter of
        <a href="#/c/inverter/4">chapter 2</a>, with a pull-up resistor that never turns off and a tube that, conducting, never pulls the plate below 81 V.</p>
        <div class="try">Toggle <code>g</code> and watch the beam and the plate.</div>`,
      scene: () => ({ root: TRIODE_SWITCH, inputs: { g: 0 } }),
      tries: [(st) => st.value('y') === 0],
      tour: {
        beats: [
          { title: 'Grid low: cut off', set: { g: 0 }, show: ['v1', 'rl'], expect: { y: 1 },
            say: `<p>g = 0 here means the grid is held below cutoff (${V_CUTOFF.toFixed(1)} V or lower). No electrons reach the plate, no current flows in the resistor, and the plate sits at ${B_PLUS} V: y = {v:y}.</p>` },
          { title: 'Grid high: conducting', set: { g: 1 }, show: ['v1', 'rl'], expect: { y: 0 },
            say: `<p>g = 1: the grid is near 0 V, electrons stream to the plate and the resistor drops the voltage: the plate falls to ${v(V_LOW)} V, a 0. y = {v:y}. The beam is drawn while this lasts.</p>` },
          { title: 'Grid low again', set: { g: 0 }, show: ['v1'], expect: { y: 1 },
            say: `<p>g = 0: the tube cuts off, the resistor pulls the plate back to ${B_PLUS} V, y = {v:y}. The inversion needs no moving part, but the plate recharges through ${R_PLATE / 1e3} kΩ: that RC is the tube step, about ${TUBE_STEP_US.toFixed(1)} µs.</p>` },
        ],
      },
      more: {
        derive: `<p>The tube is a switch from the plate to ground with an on-resistance of V<sub>low</sub> / I = ${v(V_LOW)} V over ${(1e3 * (B_PLUS - V_LOW) / R_PLATE).toFixed(1)} mA, about
          ${v(V_LOW / ((B_PLUS - V_LOW) / R_PLATE) / 1e3)} kΩ, against ${R_PLATE / 1e3} kΩ for the plate resistor. The ratio decides the low level: a fraction ${(V_LOW / B_PLUS).toFixed(2)} of the supply, nowhere near 0.
          Ratioed logic means the low level is a fraction of the supply set by the ratio, not zero.</p>`,
        pitfall: `<p>Taking the plate's low (${v(V_LOW)} V) as a 0 V logic level. It is a 0 only relative to the ${B_PLUS} V high, and the next grid needs a divider to bring it
          below cutoff (next step). Looking at the plate on a scope next to the grid shows two different voltage scales for the same bit.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why could the relay adder pass its carry through four bits in one step, but a tube adder cannot?',
        options: [
          'A contact conducts both ways and passes a line; a tube conducts one way only, so every stage needs a tube to drive it',
          'Tubes are slower than relays',
          'Tubes cannot be wired in series',
        ],
        answer: 0,
        explain: 'A contact is metal on metal: whatever is on one side appears on the other. A tube only lets current from plate to cathode, so it can switch a node but never carry a signal through itself. Every tube gate regenerates its output, which also means every stage adds a delay.',
        why: ['', 'Tubes are thousands of times faster than relays. The relay adder wins on steps because its carry needs no switching at all.', 'Being in series is not the issue: current still crosses each tube one way only, so no tube can pass the carry through itself.'],
      },
    },
    {
      title: 'Levels that do not line up',
      body: `
        <p>A <span data-ahead="cmos">CMOS (the transistor logic of chapters 1 to 3)</span> output can drive the next input directly: both live between 0 V and VDD. A tube cannot. Its plate
        swings between ${v(V_LOW)} V and ${B_PLUS} V, but the next grid needs about 0 V to conduct and less than
        ${V_CUTOFF} V to be cut off. Wired straight across, the next tube would conduct for ever.</p>
        <p>So every input goes through a <strong>divider</strong> from the plate to a negative bias rail. To put a
        ${B_PLUS} V plate at 0 V on the grid against ${V_BIAS} V the ratio must be ${DIVIDER_RATIO.toFixed(2)} : 1, here
        ${R_DIV_TOP / 1e3} kΩ over ${R_DIV_BOTTOM / 1e3} kΩ. The divider loads the plate it reads (a cut-off plate
        with one divider on it sits at ${v(L1.high)} V, not ${B_PLUS}), conducts all the time, and limits fan-out: with
        two dividers on a plate the margins shrink to ${(V_CUTOFF - L2.gridLow).toFixed(0)} V and
        ${(L2.marginHigh).toFixed(0)} V, and at four the chain stops working. Machines put a
        <strong>cathode follower</strong> (a tube with its plate on B+ and its output on the cathode, which follows
        the grid) in front of every wide fan-out.</p>
        <p>The cost is plain. The divider conducts from the plate to the bias rail all the time: ${w2(BRICK.divider)} W per divider on average. Every logic level passes through
        a resistor network that wastes power and loads the node. CMOS has none of this, because a gate input is an insulator at the same voltage range as the output.</p>
        <div class="try">Move the bias rail to 0 V, then try a fan-out of 4. Then find the ratio range that still
        works.</div>`,
      more: {
        derive: `<p>The divider output is V<sub>g</sub> = (V<sub>p</sub>·R<sub>b</sub> + V<sub>bias</sub>·R<sub>t</sub>) / (R<sub>t</sub> + R<sub>b</sub>). For a ${B_PLUS} V plate to give
          0 V: ${B_PLUS}·${R_DIV_BOTTOM / 1e3} = ${-V_BIAS}·${R_DIV_TOP / 1e3} in the ratio R<sub>t</sub> / R<sub>b</sub> = ${(R_DIV_TOP / R_DIV_BOTTOM).toFixed(2)}, which is ${B_PLUS} / ${-V_BIAS} = ${DIVIDER_RATIO.toFixed(2)} on the whole divider.
          The low plate (${v(V_LOW)} V) then gives ${v(dividerOut(V_LOW))} V on the next grid, ${(V_CUTOFF - dividerOut(V_LOW)).toFixed(0)} V below cutoff for an unloaded plate. Each added divider on the plate is a ${(R_DIV_TOP + R_DIV_BOTTOM) / 1e3} kΩ
          path to ${V_BIAS} V in parallel with the plate resistor; the numbers below are what that does to both levels.</p>`,
        numbers: `<table class="mini"><tr><th>dividers on a plate</th><th>cut-off plate</th><th>next grid, high</th><th>margin above cutoff</th><th>next grid, low</th><th>margin below cutoff</th></tr>${[1, 2, 3, 4].map((k) => {
          const l = gateLevels(k);
          return `<tr><td>${k}</td><td>${v(l.high)} V</td><td>${l.gridHigh.toFixed(1)} V</td><td>${l.marginHigh.toFixed(1)} V</td><td>${l.gridLow.toFixed(1)} V</td><td>${l.marginLow.toFixed(1)} V</td></tr>`;
        }).join('')}</table>`,
        pitfall: `<p>Choosing the ratio for the high level only. The divider has to put both levels on the right sides of cutoff, and a negative margin at four dividers means the chain
          stops working: a high plate gives a grid at or below cutoff, so the next tube never turns on. Check both margins, as the table does.</p>`,
        real: `<p>Direct-coupled amplifiers use the same trick: a resistor network from a plate to a negative rail. A small speed-up capacitor across the top resistor passes
          fast edges around the divider's own time constant; the model's node capacitance (${(45).toFixed(0)} pF, the next grid with its Miller multiplication, wiring and those capacitors)
          is what sets the ${TUBE_STEP_US.toFixed(1)} µs step with the ${R_PLATE / 1e3} kΩ plate resistor.</p>`,
      },
      widget: () => tubeDividerWidget(),
      challenge: {
        kind: 'quiz', question: 'What goes wrong if the divider\'s bottom leg goes to ground instead of −150 V?',
        options: [
          'A low plate (81 V) still puts the next grid above cutoff: the next tube never turns off',
          'The next tube never turns on',
          'Nothing: the ratio is all that matters',
        ],
        answer: 0,
        explain: 'Between 81 V and 0 V a divider can only produce positive voltages, and a grid above −12.5 V conducts. The negative rail is what lets a plate that never goes below 81 V cut the next tube off.',
        why: ['', 'It is the other way round: every plate level gives a positive grid, so the next tube conducts all the time.', 'The ratio only scales. Against ground it scales 81–250 V into positive grid voltages, all above cutoff.'],
      },
    },
    {
      title: 'NOR is the tube\'s gate',
      body: `
        <p>Put <span data-show="va vb">two triodes</span> in parallel under <span data-show="rl">one plate resistor</span>. Either one conducting pulls the plate down; it is a
        1 only while both are cut off. That is a <strong>NOR</strong>, from one twin triode, and it is the natural triode
        gate: inputs in parallel cost one section each, while two tubes in series (a NAND) would need the upper one's
        cathode to float, which would move its grid's levels too. Real machines mixed styles: ENIAC gated with 6L7
        pentagrids (two control grids in one bulb, an AND), and SEAC and UNIVAC did most of their logic in crystal
        diodes, with tubes to restore the levels.</p>
        <p>The schematic is honest about the cost: each input has <span data-show="ra1 ra2 rb1 rb2">its own ${R_DIV_TOP / 1e3} kΩ / ${R_DIV_BOTTOM / 1e3} kΩ
        divider</span> to ${V_BIAS} V, and the plate resistor burns ${w2(SEC.resistor)} W whenever a tube conducts. In the
        simulation <span data-show="ra1 rb1">the divider's top resistor</span> decides the grid and <span data-show="ra2 rb2">its bottom leg</span> (a bias resistor, the weakest
        element) only holds a grid nothing else reaches.</p>
        <p>Cost: ${stats(TUBE_NOR).triodes} triode sections and ${stats(TUBE_NOR).resistors} resistors for two inputs, and one more section and two resistors for each further input. The plate
        resistor is shared, so a wide NOR is cheaper per input than a narrow one, until the plate's load limits the margins.</p>
        <div class="try">Set both inputs to 0, then either to 1. Double-click a resistor or a tube to see what it is.</div>`,
      scene: () => ({ root: TUBE_NOR, inputs: { a: 1, b: 0 } }),
      tour: {
        beats: [
          { title: 'Both cut off', set: { a: 0, b: 0 }, show: ['va', 'vb', 'rl'], expect: { y: 1 },
            say: '<p>a = b = 0: both grids are below cutoff, neither triode conducts and the plate resistor pulls y up: y = {v:y}.</p>' },
          { title: 'One conducts', set: { a: 1 }, show: ['va', 'vb'], expect: { y: 0 },
            say: `<p>a = 1: the first triode conducts and pulls the shared plate down to about ${v(V_LOW)} V. y = {v:y}. The other tube stays cut off and does not matter.</p>` },
          { title: 'Both conduct', set: { b: 1 }, show: ['va', 'vb'], expect: { y: 0 },
            say: '<p>b = 1 too: two parallel paths share the current, the plate is no lower than a logic 0 needs. y = {v:y}: the output is 1 only when both are 0.</p>' },
          { title: 'Only b', set: { a: 0 }, show: ['vb', 'rb1', 'rb2'], expect: { y: 0 },
            say: '<p>a = 0, b = 1: the second tube alone holds the plate down, y = {v:y}. Each input has its own divider (rb1 over rb2 here) and drives its own grid.</p>' },
        ],
      },
      more: {
        derive: `<p>y = ¬(a + b): the plate is high only if no triode conducts. Two tubes in series would need the upper cathode above ground: with its grid held to the same levels
          the grid-to-cathode voltage falls by the cathode's rise, so the upper tube conducts less, and the logic levels depend on which input is on. In parallel every cathode is at ground, so each
          input sees the same levels and the same ${(R_DIV_TOP / 1e3).toFixed(0)} / ${(R_DIV_BOTTOM / 1e3).toFixed(0)} kΩ divider.</p>`,
        pitfall: `<p>Calling it a NAND from the wiring. Triodes in parallel under one resistor look like an AND gate drawn sideways, but the plate falls on <em>either</em>
          input: with the 1-conducts, 0-cut-off convention it is a NOR. The tour above checks all four rows.</p>`,
        real: `<p>ENIAC gated with pentodes and pentagrids: a second control grid in the same tube gives an AND without a series stack, so a gate and its amplifier are one bulb.
          SEAC and UNIVAC did the gating in crystal diodes and used tubes only to restore levels, the arrangement the next step builds.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Make the output 1.',
        check: (st) => st.value('y') === 1,
        hints: [
          'The plate is pulled down while any triode conducts. What must hold for neither to conduct?',
          'A grid conducts when its input is 1. Look at which input is still at 1.',
        ],
        answer: 'a = 0 and b = 0: both triodes cut off, and nothing pulls against the plate resistor.',
        solve: (st) => st.setInputs({ a: 0, b: 0 }),
      },
    },
    {
      title: 'A NAND from diodes',
      body: `
        <p>The site's brick is the NAND, so here is one in tubes. A <strong>vacuum diode</strong> is a tube with no
        grid: current from plate to cathode only. Wire <span data-show="da db">a diode</span> from a junction to each input, pull the junction up to
        B+ <span data-show="rj">through a resistor</span>: an input at 81 V pulls the junction down through its diode, an input at ${B_PLUS} V cannot pull it up. The
        junction is the <strong>AND</strong> of the inputs; <span data-show="r1 r2">a divider</span> and <span data-show="v1">a triode</span> invert it.</p>
        <p>One NAND: half a 6SN7 and a whole 6AL5 (a twin diode), ${w2(BRICK.total)} W on average:
        ${w2(BRICK.heaters)} W of heaters, ${w2(BRICK.plate)} W through the plate resistor, ${w2(BRICK.divider)} W in the
        divider. ENIAC already carried 7200 crystal diodes; later machines used them for gates like this one, which saved the heaters.</p>
        <p>The diodes do the logic and the triode restores the level: a diode AND alone has no gain, and every stage through it would lose a diode drop of swing. The
        triode after it makes the output a full ${v(V_LOW)} V to ${B_PLUS} V again. That is the same split as in <span data-ahead="cmos">CMOS (the transistor logic of chapters 1 to 3)</span> between the gate and its restoring stage, paid in
        two tube envelopes (${stats(TUBE_NAND).triodes} triode section and ${stats(TUBE_NAND).diodes} diode sections per NAND).</p>
        <div class="try">Set both inputs to 1: both diodes let go, the junction rises, the triode conducts.</div>`,
      scene: () => ({ root: TUBE_NAND, inputs: { a: 1, b: 0 } }),
      tries: [(st) => st.value('y') === 0],
      tour: {
        beats: [
          { title: 'Both high', set: { a: 1, b: 1 }, show: ['da', 'db', 'rj'], expect: { y: 0 },
            say: '<p>a = b = 1: both diodes would need to pass current backwards, so neither conducts and the pull-up lifts the junction. The divider and triode invert it: y = {v:y}.</p>' },
          { title: 'One input low', set: { a: 0 }, show: ['da', 'rj'], expect: { y: 1 },
            say: '<p>a = 0: a\'s diode conducts and the low input pulls the junction down, beating the pull-up resistor. The grid goes below cutoff, the triode stops, y = {v:y}.</p>' },
          { title: 'The other input low', set: { a: 1, b: 0 }, show: ['db', 'rj'], expect: { y: 1 },
            say: '<p>a = 1, b = 0: now b\'s diode does the work and the junction is low again: y = {v:y}. Either low input is enough, which is the AND.</p>' },
          { title: 'The triode inverts', set: { a: 1, b: 1 }, show: ['r1', 'r2', 'v1'], expect: { y: 0 },
            say: '<p>Back to both high: the junction rises through the divider (r1, r2) to the grid, the tube conducts, and the plate falls to the low level. y = {v:y}.</p>' },
        ],
      },
      more: {
        derive: `<p>The junction J = a·b (a diode AND), the divider carries it to the grid, and the triode inverts: y = ¬J = ¬(a·b), a NAND. Power per brick, on average:
          ${w2(BRICK.heaters)} W of heaters (the triode's ${w2(HEATER_W)} W plus both diode sections), ${w2(BRICK.plate)} W through the plate resistor and tube, ${w2(BRICK.divider)} W in the divider:
          ${w2(BRICK.total)} W in all, of which ${(100 * BRICK.heaters / BRICK.total).toFixed(0)} % is heater.</p>`,
        numbers: `<table class="mini"><tr><th>part of a NAND brick</th><th>average power</th></tr>
          <tr><td>heaters (½ 6SN7 + 6AL5)</td><td>${w2(BRICK.heaters)} W</td></tr><tr><td>plate resistor and tube</td><td>${w2(BRICK.plate)} W</td></tr>
          <tr><td>divider</td><td>${w2(BRICK.divider)} W</td></tr><tr><th>total</th><th>${w2(BRICK.total)} W</th></tr></table>`,
        pitfall: `<p>Chaining diode ANDs without a restoring stage. Each diode drops a fraction of a volt, and a pull-up that fights several parallel diodes lets the junction creep up on a
          nominally low input. After two or three stages the levels are gone. The triode is there to bring them back, which also costs the step.</p>`,
        real: `<p>ENIAC also used crystal diodes (${thin(ENIAC.diodes)} of them), but most of its gating was in tubes. Machines that did gate in diodes, like SEAC and UNIVAC, saved a heater for every gate.
          Crystal diodes also gave less drop than vacuum ones, which made the restoring stage easier.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'With a = 0 and b = 1, why does the junction read 0 rather than X, with the pull-up and a diode fighting over it?',
        options: [
          'The diode from the low input conducts and beats the pull-up resistor; the high input\'s diode conducts nothing',
          'Both diodes conduct and cancel',
          'The divider holds the junction at 0',
        ],
        answer: 0,
        explain: 'The low input sinks the pull-up\'s current through its diode, and the junction sits a diode drop above that input. The other diode would have to carry current from the input back into the junction, which a tube cannot do.',
        why: ['', 'Only the low input\'s diode conducts. The high input\'s diode would have to carry current into the junction, against its direction.', 'The divider takes its input from the junction and passes it on to the grid. It does not decide the junction\'s level.'],
      },
    },
    {
      title: 'One bit in one bulb',
      body: `
        <p>Couple <span data-show="va vb">two triodes</span> so each plate holds the other's grid through a divider. If the left one conducts, its
        plate is low, so the right grid is below cutoff, so the right plate is high, so the left grid conducts: it
        holds itself. The other state holds itself too. This is the <strong>Eccles–Jordan</strong> trigger circuit
        (1918), the <span data-ahead="dff">flip-flop (a circuit that stores one bit)</span>, from one 6SN7.</p>
        <p><code>set</code> drives the right grid high through <span data-show="ds">a steering diode</span>: <span data-show="vb">the right tube</span> conducts, <span data-show="va">the left</span>
        is cut off, <code>q</code> (the left plate) rises. <code>reset</code> does the mirror image, through <span data-show="dr">the other diode</span>. Let go and the
        diodes conduct nothing: the pair keeps its bit. The scene starts with <code>reset</code> held: powered up
        with neither, the pair is undecided (X here), and a real one falls into whichever state its slightly
        stronger tube prefers.</p>
        <p>In NAND bricks the same set–reset latch is ${stats(SR_LATCH).nands} NANDs: ${stats(SR_LATCH).nands} triode
        sections and ${2 * stats(SR_LATCH).nands} diodes; a clocked D flip-flop is ${stats(DFF).nands}. ENIAC kept each
        decimal digit of its accumulators in a ring of ten of these pairs.</p>
        <p>Why it holds: each stage inverts its input, and two such stages in a loop have two stable states and one unstable in between. A small
        disturbance at the middle grows round the loop (the loop gain is above 1) until one tube is fully on and the other fully off. That is the same
        regenerative loop as the cross-coupled NANDs of <a href="#/c/latches/0">chapter 8</a>, with a plate resistor and a divider in place of the gate.
        It costs ${stats(ECCLES_JORDAN).triodes} triode sections and ${stats(ECCLES_JORDAN).diodes} steering diodes, and it burns heater and plate power for as long as it holds.</p>
        <div class="try">Set, let go, and the bit stays. Then reset.</div>`,
      scene: () => ({ root: ECCLES_JORDAN, inputs: { set: 0, reset: 1 } }),
      tour: {
        beats: [
          { title: 'Reset held', set: { set: 0, reset: 1 }, show: ['va', 'vb', 'dr'], expect: { q: 0, nq: 1 },
            say: '<p>reset = 1: the left tube is forced on, so the left plate q is low: q = {v:q}. The right grid is below cutoff, its plate nq is high: nq = {v:nq}.</p>' },
          { title: 'Set', set: { set: 1, reset: 0 }, show: ['va', 'vb', 'ds'], expect: { q: 1, nq: 0 },
            say: '<p>set = 1: the steering diode ds drives the right grid up, the right tube conducts and nq falls to {v:nq}. The left grid, fed from nq, goes below cutoff and q rises: q = {v:q}.</p>' },
          { title: 'Let go: it holds', set: { set: 0 }, show: ['va', 'vb'], expect: { q: 1, nq: 0 },
            say: '<p>set = 0: the diode conducts nothing now, but each plate still holds the other grid where it was. q = {v:q}, nq = {v:nq} with both inputs at 0: one stored bit.</p>' },
          { title: 'Reset', set: { reset: 1 }, show: ['va', 'vb', 'dr'], expect: { q: 0, nq: 1 },
            say: '<p>reset = 1: the mirror image through dr. The left tube takes over, q = {v:q}, nq = {v:nq}. Let go of reset and the pair would stay.</p>' },
        ],
      },
      more: {
        derive: `<p>Two stable states: (left on, right off) and (left off, right on); the state with both half on is a balance point that any noise leaves. Each stage inverts, so the loop through the
          two dividers inverts twice and feeds back positively. A stage's gain must stay above 1 even after the divider cuts the plate's swing to ${(R_DIV_BOTTOM / (R_DIV_TOP + R_DIV_BOTTOM)).toFixed(3)} of its size
          (the bias rail only shifts it), which is why the dividers are the part to tune. In NAND bricks the same latch is ${stats(SR_LATCH).nands} NANDs, ${stats(SR_LATCH).nands} triode sections
          and ${2 * stats(SR_LATCH).nands} diode sections, against ${stats(ECCLES_JORDAN).triodes} and ${stats(ECCLES_JORDAN).diodes} here.</p>`,
        pitfall: `<p>Powering up with neither set nor reset. The scene starts with reset held for a reason: both tubes warm together, and which one wins is decided by tiny
          differences in emission and noise. A real machine reset its flip-flops in a power-on sequence before using them, and a simulator that shows X is saying the same.</p>`,
        real: `<p>At two triodes a bit, flip-flops were for registers only: ENIAC's twenty accumulators held twenty ten-digit
          numbers. Larger stores kept bits in something cheaper and used tubes only to read and rewrite them. A
          <strong>mercury delay line</strong> (EDSAC, 1949; UNIVAC I, 1951) sent bits as sound pulses down a tube of mercury
          and fed them back in at the far end: hundreds of bits per tank, but serial, a word coming round once per
          circulation, about a millisecond. The <strong>Williams tube</strong> (the Manchester Baby, 1948) stored bits as
          charge spots on a cathode-ray tube's screen, read through a pickup plate and rewritten, refreshed like
          <a href="#/c/dram/0">chapter 35</a>'s DRAM: 1024 bits a tube, random access, temperamental.
          <strong>Magnetic core</strong> (Whirlwind, 1953) won: a ferrite ring a bit, magnetized one way or the other,
          random access in microseconds, kept with the power off, read destructively and rewritten. Core held main
          memory until semiconductor DRAM displaced it in the 1970s.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Store a 1 in q, with set and reset both back at 0.',
        check: (st) => st.value('q') === 1 && st.getInput('set') === 0 && st.getInput('reset') === 0,
        hints: [
          'q is the left plate. It is high while the left tube is cut off: which tube must conduct?',
          'Look at reset first: the scene starts with it held at 1, which holds the left tube on.',
        ],
        answer: 'Set to 1 (the right tube conducts, the left plate rises), then set back to 0: each plate keeps the other grid where it is.',
        solve: (st) => { st.setInputs({ set: 1, reset: 0 }); st.sim?.settle(); st.setInputs({ set: 0 }); },
      },
    },
    {
      title: 'What it costs',
      body: `
        <p>Here is <a href="#/c/adders/0">chapter 6</a>'s nine-NAND full adder with <span data-show="g1 g2 g3 g4 g5 g6 g7 g8 g9">every NAND a tube NAND</span>: ${stats(TUBE_FA).triodes} triode
        sections, ${stats(TUBE_FA).diodes} diode sections, about ${v(9 * BRICK.total)} W. A tube gate switches in about
        ${TUBE_STEP_US.toFixed(0)} µs (the plate resistor charging the next grid, an estimate), about
        ${thin(Math.round(RELAY_STEP_MS * 1e3 / TUBE_STEP_US / 100) * 100)} times faster than a relay's ${RELAY_STEP_MS} ms and still some
        ${VS_CMOS} times slower than a ${PS_PER_NAND} ps NAND in <span data-ahead="cmos">CMOS (the transistor logic of chapters 1 to 3)</span>.</p>
        <p><strong>ENIAC</strong> (1945): ${thin(ENIAC.tubes)} tubes, ${thin(ENIAC.diodes)} crystal diodes,
        ${thin(ENIAC.relays)} relays, ${thin(ENIAC.resistors)} resistors, ${ENIAC.power / 1e3} kW, ${ENIAC.mass / 1e3} t,
        ${thin(ENIAC.adds)} additions a second. Heaters age fastest while warming up, so it was left on: then a tube
        failed about every two days, and finding which one took a while. Every tube is a filament with a lifetime, so
        reliability, not wiring, bounded a tube machine. SAGE's AN/FSQ-7 (1958) reached some 50 000 tubes a site only by
        building the computer twice, one on line and one on standby, and by running tubes at reduced voltage
        (marginal checking) to find the weak ones before they failed.</p>
        <p>The transistor switches with no heater, no vacuum and no warm-up: the bipolar point-contact transistor in 1947,
        then <span data-ahead="mosfet">the MOSFET (a voltage-controlled transistor switch) in 1959</span>, which is where <a href="#/c/mosfet/0">chapter 1</a> begins.
        <a href="#/c/silicon/0">Chapter 28</a> prices the CPU you build in relays and in tubes.</p>`,
      scene: () => ({ root: TUBE_FA, inputs: { a: 1, b: 1, cin: 0 } }),
      ledger: { kind: 'add', a: 'a', b: 'b', sum: 's', width: 1, cin: 'cin', cout: 'cout', col: () => ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'] },
      tour: {
        beats: [
          { title: 'A carry is generated', set: { a: 1, b: 1, cin: 0 }, show: ['g1', 'g9'], expect: { s: 0, cout: 1 },
            say: `<p>1 + 1 + 0: g1 = NAND(a, b) = 0 forces g9 high, so cout = {v:cout} and s = {v:s}. The carry takes two bricks (g1, then g9): about ${(2 * TUBE_STEP_US).toFixed(0)} µs.</p>` },
          { title: 'The carry passes through', set: { a: 1, b: 0, cin: 1 }, show: ['g1', 'g2', 'g3', 'g4', 'g5', 'g9'], expect: { s: 0, cout: 1 },
            say: `<p>1 + 0 + 1: a ⊕ b = 1 lets cin through the second half. s = {v:s}, cout = {v:cout}. The longest path in the adder is ${logicDepth(FULL_ADDER)} tube steps, about ${(logicDepth(FULL_ADDER)! * TUBE_STEP_US).toFixed(0)} µs, every one a tube regenerating its level.</p>` },
          { title: 'All three set', set: { a: 1, b: 1, cin: 1 }, show: ['g5', 'g6', 'g7', 'g8', 'g9'], expect: { s: 1, cout: 1 },
            say: '<p>1 + 1 + 1 = 3: the second XOR sees x = 0 and cin = 1, so s = {v:s}, and cout = {v:cout}. Every brick in the adder is heated whether or not its output moved.</p>' },
        ],
      },
      more: {
        derive: `<p>The adder is the nine-NAND full adder of <a href="#/c/adders/0">chapter 6</a> with each NAND a brick: ${stats(TUBE_FA).triodes} triode sections, ${stats(TUBE_FA).diodes} diode sections and
          ${stats(TUBE_FA).resistors} resistors. Power: 9 × ${w2(BRICK.total)} W = ${w2(9 * BRICK.total)} W. A 32-bit ripple adder is ${logicDepth(rca(32))} steps deep, about ${(logicDepth(rca(32))! * TUBE_STEP_US).toFixed(0)} µs per
          sum in tubes, against ${(logicDepth(rca(32))! * RELAY_STEP_MS).toFixed(0)} ms through relay-per-NAND bricks.</p>`,
        pitfall: `<p>Quoting a tube machine's power as its switching power. The heaters burn ${(100 * BRICK.heaters / BRICK.total).toFixed(0)} % of a brick's ${w2(BRICK.total)} W whether the gate switches or not, so a
          mostly idle tube machine costs nearly the same as a busy one. The only saving is to switch it off, and then it takes seconds to warm up.</p>`,
        numbers: `<table class="mini"><tr><th>full adder</th><th>NANDs</th><th>devices</th><th>average power</th><th>longest path</th></tr>
          <tr><td>CMOS</td><td>${stats(FULL_ADDER).nands}</td><td>${stats(FULL_ADDER).transistors} transistors</td><td>femtojoules per switch</td><td>${logicDepth(FULL_ADDER)} × ${PS_PER_NAND} ps</td></tr>
          <tr><td>Tubes</td><td>${stats(FULL_ADDER).nands}</td><td>${stats(TUBE_FA).triodes} triodes + ${stats(TUBE_FA).diodes} diodes</td><td>${w2(9 * BRICK.total)} W</td><td>${logicDepth(FULL_ADDER)} × ${TUBE_STEP_US.toFixed(1)} µs</td></tr></table>`,
      },
      challenge: {
        kind: 'quiz', question: `The 4-bit CPU of the examples is about ${thin(CPU4_NANDS)} NANDs without its program memory. Built from tube NAND bricks at ${w2(BRICK.total)} W each, it draws about:`,
        options: [`${v(CPU4_NANDS * BRICK.total / 1e3)} kW`, `${(CPU4_NANDS * BRICK.total / 1e4).toFixed(1)} kW`, `${v(CPU4_NANDS * BRICK.total / 1e2)} kW`],
        answer: 0,
        why: ['', 'That is a tenth of the bill: about 0.5 W per NAND, less than a single 6SN7 section\'s heater.', 'That is ten times the bill: about 49 W per NAND, ten times a brick.'],
        explain: `${thin(CPU4_NANDS)} × ${w2(BRICK.total)} W ≈ ${v(CPU4_NANDS * BRICK.total / 1e3)} kW from ${thin(CPU4_NANDS / 2)} 6SN7s and ${thin(CPU4_NANDS)} 6AL5s, most of it heaters: a tenth of ENIAC for a 4-bit CPU. In <span data-ahead="cmos">CMOS, the transistor logic of chapters 1 to 3,</span> it draws milliwatts.`,
      },
    },
  ],
};
