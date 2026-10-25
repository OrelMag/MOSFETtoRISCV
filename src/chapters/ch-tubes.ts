import { DFF, ECCLES_JORDAN, SR_LATCH, TRIODE_SWITCH, TUBE_FA, TUBE_NAND, TUBE_NOR } from '../lib';
import { RELAY_STEP_MS } from '../phys/relay';
import {
  B_PLUS, DIVIDER_RATIO, ENIAC, HEATER_W, R_DIV_BOTTOM, R_DIV_TOP, TUBE_STEP_US, V_BIAS, V_CUTOFF, V_LOW, gateLevels, nandBrickPower,
  sectionPower, warmup,
} from '../phys/triode';
import { stats } from '../sim/stats';
import { PS_PER_NAND } from '../sim/timing';
import { triodeCloseup } from '../widgets/triode3d';
import { tubeDividerWidget } from '../widgets/tubedivider';
import type { Chapter } from './types';

const SEC = sectionPower(), BRICK = nandBrickPower(), L1 = gateLevels(1), L2 = gateLevels(2);
const WARM = (() => {
  const w = warmup(0), full = w.at(-1)!.ip;
  return { t10: w.find((s) => s.ip >= 0.1 * full)!.t, t90: w.find((s) => s.ip >= 0.9 * full)!.t };
})();
const v = (x: number) => Math.round(x).toString();
const w2 = (x: number) => x.toFixed(2);
const thin = (n: number) => Math.round(n).toLocaleString('en-US').replace(/,/g, ' ');
/** The 4-bit CPU of the examples, without its ROM (Phase 14 mockup, measured). */
const CPU4_NANDS = 3357;
/** Tube steps per CMOS NAND delay, to the nearest 10 000. */
const VS_CMOS = thin(Math.round((TUBE_STEP_US * 1e6) / PS_PER_NAND / 1e4) * 1e4);

export const chTubes: Chapter = {
  id: 'tubes', num: 0, prologue: 'P2', title: 'Vacuum tubes', level: 'Thermionic',
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
        why: ['', `That is how much slower a tube step is than a ${PS_PER_NAND} ps CMOS NAND.`, 'A relay step is milliseconds and a tube step about a microsecond: nearly four orders of magnitude apart.'],
      },
    ],
  },
  steps: [
    {
      title: 'A hot cathode',
      body: `
        <p>A relay waits milliseconds for iron to move. A <strong>vacuum tube</strong> moves only electrons. A heater
        brings an oxide-coated <strong>cathode</strong> to about 1 000 K, hot enough to boil electrons off its surface;
        a <strong>plate</strong> (anode) at +${B_PLUS} V collects them. Between the two, a wire mesh, the
        <strong>grid</strong>, decides how many get through: at 0 V nearly all, and with the plate at ${B_PLUS} V
        none once the grid is below ${V_CUTOFF} V. Its field pushes them back.</p>
        <p>This is one section of a 6SN7, the twin triode ENIAC used most. The current follows the space-charge law
        I = K·(V<sub>g</sub> + V<sub>p</sub>/µ)<sup>1.5</sup> with µ = 20, fitted to the datasheet point (250 V, −8 V,
        9 mA), and works into a 22 kΩ plate resistor. The cathode warms with a 6 s time constant, and emission
        (Richardson's law) grows exponentially with temperature. So after switch-on nothing flows for
        ${WARM.t10.toFixed(1)} s, and the full current arrives by ${WARM.t90.toFixed(1)} s.</p>
        <div class="try">Switch it on from cold. Then sweep the grid and watch the plate: ${v(V_LOW)} V conducting,
        ${B_PLUS} V cut off.</div>`,
      widget: () => triodeCloseup(),
      challenge: {
        kind: 'quiz', question: `The heater draws ${w2(HEATER_W)} W per section whether the tube switches or not. What does that do to a tube machine?`,
        options: [
          'Its power is set by the heaters, so a gate that never switches still costs watts',
          'Nothing: the heater only matters at switch-on',
          'It makes the gate faster the longer it runs',
        ],
        answer: 0,
        explain: `Of a section's ${w2(SEC.average)} W (average, conducting half the time), ${w2(HEATER_W)} W is the heater. CMOS pays when it switches; a tube pays for being ready to.`,
        why: ['', 'The heater keeps the cathode at about 1 000 K all the time. Switch it off and emission stops: the tube no longer conducts at all.', 'Once the cathode is hot the emission is steady: a warm tube switches no faster the longer it runs.'],
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
        chapter 1 on, a MOSFET channel). There is no transmission gate in tubes, and no carry that runs through switches as in the relay adder.
        The orange line is the beam: it shows while the tube conducts.</p>
        <div class="try">Toggle <code>g</code> and watch the beam and the plate.</div>`,
      scene: () => ({ root: TRIODE_SWITCH, inputs: { g: 0 } }),
      tries: [(st) => st.value('y') === 0],
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
        <p>A CMOS output can drive the next input directly: both live between 0 V and VDD. A tube cannot. Its plate
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
        <div class="try">Move the bias rail to 0 V, then try a fan-out of 4. Then find the ratio range that still
        works.</div>`,
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
        <div class="try">Set both inputs to 0, then either to 1. Double-click a resistor or a tube to see what it is.</div>`,
      scene: () => ({ root: TUBE_NOR, inputs: { a: 1, b: 0 } }),
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
        divider. ENIAC itself used 7 200 germanium crystal diodes for gates like this one, which saved the heaters.</p>
        <div class="try">Set both inputs to 1: both diodes let go, the junction rises, the triode conducts.</div>`,
      scene: () => ({ root: TUBE_NAND, inputs: { a: 1, b: 0 } }),
      tries: [(st) => st.value('y') === 0],
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
        (1918), the flip-flop, from one 6SN7.</p>
        <p><code>set</code> drives the right grid high through <span data-show="ds">a steering diode</span>: <span data-show="vb">the right tube</span> conducts, <span data-show="va">the left</span>
        is cut off, <code>q</code> (the left plate) rises. <code>reset</code> does the mirror image, through <span data-show="dr">the other diode</span>. Let go and the
        diodes conduct nothing: the pair keeps its bit. The scene starts with <code>reset</code> held: powered up
        with neither, the pair is undecided (X here), and a real one falls into whichever state its slightly
        stronger tube prefers.</p>
        <p>In NAND bricks the same set–reset latch is ${stats(SR_LATCH).nands} NANDs: ${stats(SR_LATCH).nands} triode
        sections and ${2 * stats(SR_LATCH).nands} diodes; a clocked D flip-flop is ${stats(DFF).nands}. ENIAC kept each
        decimal digit of its accumulators in a ring of ten of these pairs.</p>
        <details class="deeper"><summary>Deeper: memory in the tube era</summary>
        <p>At two triodes a bit, flip-flops were for registers only: ENIAC's twenty accumulators held twenty ten-digit
        numbers. Larger stores kept bits in something cheaper and used tubes only to read and rewrite them. A
        <strong>mercury delay line</strong> (EDSAC, 1949; UNIVAC I, 1951) sent bits as sound pulses down a tube of mercury
        and fed them back in at the far end: hundreds of bits per tank, but serial, a word coming round once per
        circulation, about a millisecond. The <strong>Williams tube</strong> (the Manchester Baby, 1948) stored bits as
        charge spots on a cathode-ray tube's screen, read through a pickup plate and rewritten, refreshed like
        <a href="#/c/dram/0">chapter 35</a>'s DRAM: 1 024 bits a tube, random access, temperamental.
        <strong>Magnetic core</strong> (Whirlwind, 1953) won: a ferrite ring a bit, magnetized one way or the other,
        random access in microseconds, kept with the power off, read destructively and rewritten. Core held main
        memory until semiconductor DRAM displaced it in the 1970s.</p></details>
        <div class="try">Set, let go, and the bit stays. Then reset.</div>`,
      scene: () => ({ root: ECCLES_JORDAN, inputs: { set: 0, reset: 1 } }),
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
        ${VS_CMOS} times slower than a ${PS_PER_NAND} ps CMOS NAND.</p>
        <p><strong>ENIAC</strong> (1945): ${thin(ENIAC.tubes)} tubes, ${thin(ENIAC.diodes)} crystal diodes,
        ${thin(ENIAC.relays)} relays, ${thin(ENIAC.resistors)} resistors, ${ENIAC.power / 1e3} kW, ${ENIAC.mass / 1e3} t,
        ${thin(ENIAC.adds)} additions a second. Heaters age fastest while warming up, so it was left on: then a tube
        failed about every two days, and finding which one took a while. Every tube is a filament with a lifetime, so
        reliability, not wiring, bounded a tube machine. SAGE's AN/FSQ-7 (1958) reached some 50 000 tubes a site only by
        building the computer twice, one on line and one on standby, and by running tubes at reduced voltage
        (marginal checking) to find the weak ones before they failed.</p>
        <p>The transistor switches with no heater, no vacuum and no warm-up: the bipolar point-contact transistor in 1947,
        then the MOSFET in 1959, which is where <a href="#/c/mosfet/0">chapter 1</a> begins.
        <a href="#/c/silicon/0">Chapter 28</a> prices the CPU you build in relays and in tubes.</p>`,
      scene: () => ({ root: TUBE_FA, inputs: { a: 1, b: 1, cin: 0 } }),
      challenge: {
        kind: 'quiz', question: `The 4-bit CPU of the examples is about ${thin(CPU4_NANDS)} NANDs without its ROM. Built from tube NAND bricks at ${w2(BRICK.total)} W each, it draws about:`,
        options: [`${v(CPU4_NANDS * BRICK.total / 1e3)} kW`, `${(CPU4_NANDS * BRICK.total / 1e4).toFixed(1)} kW`, `${v(CPU4_NANDS * BRICK.total / 1e2)} kW`],
        answer: 0,
        why: ['', 'That is a tenth of the bill: about 0.5 W per NAND, less than a single 6SN7 section\'s heater.', 'That is ten times the bill: about 49 W per NAND, ten times a brick.'],
        explain: `${thin(CPU4_NANDS)} × ${w2(BRICK.total)} W ≈ ${v(CPU4_NANDS * BRICK.total / 1e3)} kW from ${thin(CPU4_NANDS / 2)} 6SN7s and ${thin(CPU4_NANDS)} 6AL5s, most of it heaters: a tenth of ENIAC for a 4-bit CPU. In CMOS it draws milliwatts.`,
      },
    },
  ],
};
