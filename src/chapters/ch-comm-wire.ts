// Chapter wire, A wire is not a wire (level Communication): what happens between a driver's drain and a receiver's gate. The
// model is phys/line.ts (every number below is computed from it), the pad is lib/pad.ts at switch level, the explainers are
// widgets/line.ts. The line is the one box in the book that does not end in transistors (roadmap Phase 21, decisions 2 and 3).

import { PAD_CHAIN, PAD_FINAL, PAD_PIN_FF, padDriveOhms } from '../lib/pad';
import {
  bestRepeaters, boardDelay, coupling, criticalLength, crosstalk, farStats, groundBounce, iSat, lattice, minBandwidth, minRsStaysHigh, parallelPower,
  PCB_PS_PER_MM, rEff, repeatedDelay, repeaterOptimum, rOn, seriesResistor, unitR, VIH, VIL, VIO, wireDelayTerms, wireDominates, WIRE_C_PER_MM,
  WIRE_R_PER_MM, Z0_BOARD,
} from '../phys/line';
import { FO4_TAU, PS_PER_TAU } from '../phys/sizing';
import type { SwitchSim } from '../sim/switchsim';
import { driverWidget, flightWidget, noiseWidget, padScene, reflectionWidget, repeaterWidget, terminationWidget, wireRcWidget } from '../widgets/line';
import { cable3d } from '../widgets/cable3d';
import { package3d } from '../widgets/package3d';
import { withModel } from '../widgets/modelhost';
import type { Chapter } from './types';
import { numOf } from './order';

const f0 = (v: number) => v.toFixed(0), f1 = (v: number) => v.toFixed(1), f2 = (v: number) => v.toFixed(2);
const R1 = unitR(), R16 = rEff(16), R_PAD = padDriveOhms();
const opt = repeaterOptimum(), rep10 = bestRepeaters(10), bare10 = repeatedDelay(10, 1, opt.h);
const w5 = wireDelayTerms({ rd: R16, len: 5, cl: 4 }), w10 = wireDelayTerms({ rd: R16, len: 10, cl: 4 });
const L_FLIGHT = boardDelay(150);
const strong = lattice({ v: VIO, rs: 10, z0: Z0_BOARD, delay: L_FLIGHT, rl: Infinity, rise: 0.2 });
const strongStats = farStats(strong, 40);
const RS_MIN = minRsStaysHigh(VIO, Z0_BOARD, L_FLIGHT, 0.2)!;
const seriesL = lattice({ v: VIO, rs: Z0_BOARD, z0: Z0_BOARD, delay: L_FLIGHT, rl: Infinity, rise: 0.2 });
const seriesStats = farStats(seriesL, 40);
const x1 = coupling(1), x3 = coupling(3);
const xt1 = crosstalk({ v: VIO, rise: 0.2, delay: boardDelay(100), kc: x1.kc, kl: x1.kl });
const xt3 = crosstalk({ v: VIO, rise: 0.2, delay: boardDelay(100), kc: x3.kc, kl: x3.kl });
const I_PAD = VIO / (R_PAD + Z0_BOARD);
const bounce = (n: number, rise: number) => groundBounce(n, I_PAD, rise, 3);
const mv = (v: number) => `${v < 0 ? '−' : ''}${Math.abs(v * 1000).toFixed(0)} mV`;
const FO4_PS = FO4_TAU * PS_PER_TAU;

export const chWire: Chapter = {
  id: 'wire', num: numOf('wire'), title: 'A wire is not a wire', level: 'Communication',
  blurb: 'Between the driver\'s drain and the far pin: on-chip RC, repeaters, transmission lines, reflections, termination, differential pairs and an I/O pad.',
  goals: [
    'turn a driver into a resistance and a wire into an RC, and predict the 50 % delay of a long on-chip wire (0.38 · R · C, quadratic in length) and the number of repeaters that makes it linear',
    'say when a trace stops being a node (one-way delay above a sixth of the edge time) and read a reflection diagram: launch V·Z₀ / (Z₀ + Rs), reflection coefficients, the ringing a strong driver leaves on an open end',
    'choose series or parallel termination from what each costs, and size the damage of crosstalk, ground bounce and common-mode noise against a noise margin',
    'trace an I/O pad from the core to the pin at transistor level and name the first box in the book that does not end in transistors',
  ],
  builds: ['inverter', 'telegraph', 'mosfet'],
  recap: {
    keep: [
      'A driver is a resistance: the 50 % delay into a capacitor is ln 2 · R · C, and R falls with width. The unit device here is ' + f0(R1) + ' Ω, the ' + PAD_FINAL + '× pad stage ' + f0(R_PAD) + ' Ω.',
      'An on-chip wire is distributed RC: ' + WIRE_R_PER_MM + ' Ω and ' + WIRE_C_PER_MM + ' fF per mm in this model. Its own delay is 0.38 · Rw · Cw, so it grows with the square of the length; a driver\'s share grows only linearly.',
      'Repeaters cut the wire into k segments and make the delay linear in length: ' + f0(opt.psPerMm) + ' ps/mm here, with a repeater every ' + f2(opt.segMm) + ' mm, each ' + f0(opt.h) + '× the unit inverter, at the price of area and the repeaters\' own switched capacitance.',
      'A trace is a line, and no longer a node, when its one-way delay exceeds about a sixth of the edge time. Then a wave of V·Z₀ / (Z₀ + Rs) travels at ' + f1(1000 / PCB_PS_PER_MM) + ' mm/ns, and every impedance step reflects a fraction Γ = (R − Z₀) / (R + Z₀).',
      'Termination spends something to stop the echoes: series costs a round trip of half-swing at the driver and no power; parallel costs a DC path, ' + f0(parallelPower(VIO, 10, Z0_BOARD) * 1000) + ' mW per line here. Crosstalk, ground bounce and common-mode pickup eat the noise margin; a differential pair gives the common part back.',
      'The pad is the last transistors before the wire: a tri-state output stage behind a ratio-4 chain, a buffer on the way in. From the driver\'s drain to the receiver\'s gate the voltage comes from the model in phys/line.ts; past the receiver it is gates again.',
    ],
    check: [
      {
        question: 'A driver of ' + f0(R16) + ' Ω charges 1 pF. About how long until the node is halfway?',
        options: ['ln 2 · 387 Ω · 1 pF = 268 ps', '387 Ω · 1 pF = 387 ps', '0.38 · 387 Ω · 1 pF = 147 ps'],
        answer: 0,
        explain: 'A lumped RC charges exponentially; the halfway point is ln 2 of the time constant. The factor 0.38 belongs to a wire whose resistance and capacitance are spread along it.',
        why: ['', 'RC is the time constant: the node has reached 63 %, which is later than half.', '0.38 applies to a distributed RC line. Here the capacitor sits at the driver\'s output.'],
      },
      {
        question: 'A 4 mm and an 8 mm wire of the same metal, each with a driver strong enough that the driver term is negligible. How do their delays compare?',
        options: ['The 8 mm wire is 4 times slower: delay grows with the square of the length', 'The 8 mm wire is 2 times slower', 'The same: both are limited by the driver'],
        answer: 0,
        explain: 'Doubling the length doubles both R and C, so 0.38 · R · C quadruples. Repeaters turn this into a linear growth.',
        why: ['', 'That holds only when a driver\'s resistance dominates. A wire\'s own R and C both grow with length.', 'With a strong driver the wire\'s own RC is all that is left.'],
      },
      {
        question: 'An open CMOS input at the end of a 15 cm trace is driven by a 10 Ω output. What does the far pin see first?',
        options: ['Twice the launched wave: ' + f2(strong.firstFar) + ' V against ' + f2(strong.launch) + ' V, then ringing', 'The full ' + VIO + ' V swing, cleanly, after one flight time', 'Half the swing, until the wave returns'],
        answer: 0,
        explain: 'The line launches V·Z₀ / (Z₀ + Rs) = ' + f2(strong.launch) + ' V; an open end reflects it with Γ = +1, so the pin sees double. The driver\'s low resistance then reflects the echo with Γ = ' + f2(strong.gammaS) + ', and the pin rings.',
        why: ['', 'A clean step needs the echo absorbed, which takes Rs ≈ Z₀ (series termination) or a matched far end.', 'Half the swing is what a series-terminated line shows at the driver. The open far end doubles the wave.'],
      },
    ],
  },
  steps: [
    {
      title: 'The driver and its load',
      body: `
        <p>The first of chapter ${numOf('telegraph')}'s five questions was <em>what is a bit on the wire?</em>, and every chapter since has answered it with a clean 0 or 1 V. This one looks at what the wire does to that voltage, from a millimetre on a chip to a trace across a board.</p>
        <p>Between one gate's output and the next gate's input there is a wire, and to the driver a wire is first a capacitance. Switching a node moves its charge through the driver's channel, so the delay is set by how fast the transistor can carry it.
        With the gate at ${VIO} V the unit NMOS of <a href="#/c/mosfet/0">chapter ${numOf('mosfet')}</a> delivers ${f0(iSat(1))} µA in saturation, a current source for the first part of the swing, and behaves like a resistor of ${f0(rOn(1))} Ω only once V<sub>ds</sub> has fallen below the overdrive.
        Averaging the two regions over the swing gives one number, the <strong>effective resistance</strong> R such that the node reaches 50 % at <code>t<sub>50</sub> = ln 2 · R · C</code>: ${f0(R1)} Ω for the unit device. Width divides it, so R = ${f0(R1)} Ω / w.</p>
        <p>The model has a clean property: the time scale is proportional to C, so R does not depend on the load. A ${PAD_FINAL}× output stage is ${f0(R_PAD)} Ω, and into 1 pF it takes ${f0(Math.LN2 * R_PAD)} ps. Energy is ½ C V² per transition whatever R is: a faster driver does not make the transition cheaper.</p>
        <p>Everything that follows is a question of what C is, and what R sits in front of it. Drag the width and the load below; the dashed curve is a plain resistor of the effective value, and the two meet at 50 % by construction.</p>`,
      widget: () => driverWidget(),
      more: {
        derive: `<p>For the square-law device, the saturation current at V<sub>gs</sub> = ${VIO} V is K/2 · (${VIO} − 0.45)² · (1 + λV<sub>ds</sub>), and below the overdrive K · (V<sub>ov</sub> · V<sub>ds</sub> − V<sub>ds</sub>²/2). The charge equation C · dV/dt = −w · I(V) has no closed form across both regions, but it is invariant under C → k · C, t → k · t, so t<sub>50</sub> / C is a function of w alone. The model integrates it once and divides: R<sub>eff</sub>(w) = t<sub>50</sub> / (ln 2 · C).</p>`,
        pitfall: `<p>Using the small-signal on-resistance (${f0(rOn(1))} Ω for the unit device) for a delay. It describes the end of the swing; the saturated first half is slower, and the effective resistance is ${f1(R1 / rOn(1))}× larger.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Doubling the width of a driver while its load stays the same does what to the delay and the energy per transition?',
        options: ['Halves the delay, leaves ½ C V² unchanged', 'Halves the delay and halves the energy', 'Leaves the delay, doubles the energy'],
        answer: 0,
        why: ['', 'The energy drawn from the supply to charge C is C V², half of it dissipated, and none of it depends on how fast the charge moves.', 'R falls as 1/w, so the delay does fall. The wider device adds its own gate capacitance to the stage before.'],
        explain: `R ∝ 1/w, so t₅₀ = ln 2 · R · C halves. The charge moved is C · V whatever the speed. The price of the wider driver is the capacitance it presents to whatever drives it, which is the inverter chain of chapter ${numOf('inverter')}.`,
      },
    },
    {
      title: 'A long wire on a chip',
      body: `
        <p>Past a few hundred micrometres the wire stops being a capacitor. A mid-level metal track in this model has ${WIRE_R_PER_MM} Ω and ${WIRE_C_PER_MM} fF per millimetre (labelled constants of a 28 nm-class process, in line with the 0.3 fF the delay model assumes for a short branch), so 5 mm is ${f1(5 * WIRE_R_PER_MM / 1000)} kΩ and ${f0(5 * WIRE_C_PER_MM)} fF, a resistor and a capacitor in the same place. Each piece of the capacitance is charged through the resistance of the wire behind it, so the far end is charged through all of it and the near end through almost none.</p>
        <p>The 50 % delay is <code>0.69 · R<sub>d</sub> · (C<sub>w</sub> + C<sub>l</sub>) + 0.38 · R<sub>w</sub> · C<sub>w</sub> + 0.69 · R<sub>w</sub> · C<sub>l</sub></code>. The middle term is the wire itself, and its coefficient is 0.38 where a lumped RC would give 0.69: the capacitance far from the driver sees more resistance, but the capacitance near it is charged early and takes less of the time (Elmore's mean is 0.5; the 50 % point is 0.38). The widget checks the formula against a 40-section ladder solved numerically.</p>
        <p>The first term is linear in length and the second quadratic. With a 16× driver (${f0(R16)} Ω) the wire's own term passes the driver's at ${f1(wireDominates(R16))} mm: 5 mm costs ${f0(w5.total)} ps, 10 mm costs ${f0(w10.total)} ps, ${f1(w10.total / w5.total)} times as much for twice the length. A bigger driver helps the first term and does nothing for the second.
        Scaling makes it worse: a thinner wire has more resistance per length while the gates get faster, so the wire's share of the cycle grows with every process.</p>`,
      widget: () => wireRcWidget(),
      more: {
        numbers: `<p>5 mm from a 16× driver into a 4 fF gate: driver ${f0(w5.driver)} ps, wire ${f0(w5.wire)} ps, load ${f0(w5.load)} ps. A FO4 inverter in this book is ${FO4_PS} ps, so the wire alone is ${f0(w5.wire / FO4_PS)} FO4 delays.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A wire is made twice as long, and the driver is made four times as wide. The wire\'s own term, 0.38 · R<sub>w</sub> · C<sub>w</sub>, changes by:',
        options: ['×4', '×2', '×½'],
        answer: 0,
        why: ['', 'That is the driver\'s term when the driver is unchanged. R<sub>w</sub> and C<sub>w</sub> each double, and the product quadruples.', 'The driver is no part of this term.'],
        explain: 'Both Rw and Cw are proportional to length, so Rw · Cw is proportional to length squared. The driver\'s width only changes the other term.',
      },
    },
    {
      title: 'Repeaters',
      body: `
        <p>If a wire's delay grows with the square of its length, cut it. k segments of length L/k each have a wire term of 0.38 · r · c · L² / k², and k of them add up to 1/k of the original. Each cut costs a driver: 0.69 · R<sub>0</sub> · (C<sub>0</sub> + C<sub>p</sub>) of intrinsic delay, where R<sub>0</sub> = ${f0(R1)} Ω is the unit inverter's resistance, C<sub>0</sub> its input capacitance and C<sub>p</sub> its own drain. The total is a sum of a falling term and a rising one in k, and the minimum lies at
        <code>k = L · √(0.38 · r · c / (0.69 · R<sub>0</sub> · (C<sub>0</sub> + C<sub>p</sub>)))</code>. Each repeater is sized by <code>h = √(R<sub>0</sub> · c / (r · C<sub>0</sub>))</code>, ${f0(opt.h)}× here, which balances the load it drives against the resistance of the wire it feeds.</p>
        <p>At that optimum the delay is <strong>linear</strong>: ${f0(opt.psPerMm)} ps per millimetre, whatever the length, with a repeater every ${f2(opt.segMm)} mm. A 10 mm wire takes ${f0(bare10)} ps from one driver of this size (step 1 used a smaller one) and ${f0(rep10.delay)} ps with ${rep10.k} segments, ${f1(bare10 / rep10.delay)} times faster. The price is ${rep10.k} repeaters of ${f0(opt.h)}× (${f0(rep10.area)} unit inverters of silicon) and their capacitance switching with the wire: ${f0(rep10.switched)} fF per transition against the wire's ${f0(10 * WIRE_C_PER_MM)} fF.</p>
        <p>This is <a href="#/c/inverter/6">chapter ${numOf('inverter')}'s inverter chain</a> with the wire as the load. A repeater drives its segment's ${f0(WIRE_C_PER_MM * opt.segMm)} fF of wire plus the next gate: an electrical effort of ${f1(rep10.stageEffort)} per stage, close to the chain's optimum of 3 to 4. Cut a short wire and you pay the intrinsic delay for nothing, which is why a wire shorter than about ${f1(opt.segMm * 1.4)} mm is best left whole.</p>`,
      widget: () => repeaterWidget(),
      more: {
        pitfall: `<p>Counting only the delay. A 10 mm bit of the data path costs ${f0(rep10.area)} unit inverters and about ${f1(rep10.switched / (10 * WIRE_C_PER_MM))}× the energy per transition of the bare wire. Real designs use fewer, smaller repeaters than the delay optimum, giving up some speed for the rest.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A wire is repeated optimally. Its length doubles. What happens to the delay and the number of repeaters?',
        options: ['The delay doubles and the number of repeaters doubles', 'The delay quadruples and the number of repeaters doubles', 'The delay doubles and the number of repeaters stays the same'],
        answer: 0,
        why: ['', 'Quadratic growth is the unrepeated wire. Each segment has the same optimal length, so the delay per millimetre is constant.', 'The segment length is fixed by the technology, so a longer wire needs more of them.'],
        explain: `The optimum is a fixed segment length (${f2(opt.segMm)} mm here) and a fixed delay per segment, so both the delay and k grow in proportion to L: ${rep10.k} segments for 10 mm, ${bestRepeaters(20).k} for 20 mm.`,
      },
    },
    {
      title: 'Off the chip: a node or a line',
      body: `
        <p>On a chip a wire is thin, resistive and short. A board trace is a few hundred times longer with a resistance of a fraction of an ohm per centimetre, and its inductance and capacitance per unit length are what set the behaviour. The signal cannot be at the far end the moment it leaves the near end: it travels at about ${f1(1000 / PCB_PS_PER_MM)} mm/ns (${PCB_PS_PER_MM} ps/mm on FR-4), so 15 cm takes ${f2(L_FLIGHT)} ns. Whether that matters depends on the edge. A trace is a node, one voltage everywhere, while the edge is long compared with the trip: when the one-way delay is below about a sixth of the rise time. For a 0.2 ns edge that is ${f1(criticalLength(0.2))} mm; for a 1 ns edge, ${f0(criticalLength(1))} mm.</p>
        <p>Picture the line as a ladder of small series inductors and shunt capacitors, L′ and C′ per unit length. A source that raises its end charges the first capacitor through the first inductor; that raises the next section, and so on. The front moves at <code>1 / √(L′C′)</code>. Behind the front the line carries a current that the source supplies at a fixed ratio of voltage to current, <code>Z₀ = √(L′ / C′)</code>: the <strong>characteristic impedance</strong>. For 50 Ω and ${PCB_PS_PER_MM} ps/mm that is ${f0((PCB_PS_PER_MM * Z0_BOARD))} nH/m and ${f0(PCB_PS_PER_MM / Z0_BOARD * 1000)} pF/m. Z₀ dissipates nothing in the line; it is the ratio at which the line takes charge from a source that has not yet heard from the far end.</p>
        <p>Drag the time slider to watch the front cross. A matched line shows a half-swing step travelling from a source of Z₀ into a far end of Z₀. Shorten the trace or slow the edge past the sixth-of-the-edge rule, and the front stretches along the whole line until it is one voltage everywhere.</p>`,
      widget: () => flightWidget(),
      more: {
        real: `<p>Why do on-chip wires not behave like this? A thin wire has ${WIRE_R_PER_MM} Ω/mm against a Z₀ of tens of ohms: the series resistance of a few hundred micrometres already exceeds the characteristic impedance, and the front is damped into diffusion before it can reflect. Only wide, thick top-level metal (clocks, power) shows inductive effects on a chip.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A driver with a 1 ns edge sends it down a 30 cm trace (' + f2(boardDelay(300)) + ' ns one way). Is the trace a node?',
        options: ['No: one-way delay is above a sixth of the edge, so the line carries a front and can reflect', 'Yes: 1 ns is longer than the delay', 'It depends on the receiver\'s input capacitance'],
        answer: 0,
        why: ['', 'The rule compares the delay with a sixth of the edge (0.17 ns here). 2 ns is far above that.', 'The capacitance changes the size of the reflection. The flight time exists whatever the receiver is.'],
        explain: `The critical length for a 1 ns edge is ${f0(criticalLength(1))} mm, and the trace is ${300} mm: ${f1(300 / criticalLength(1))} times past it.`,
      },
    },
    {
      title: 'Reflections',
      body: `
        <p>A driver does not see the far pin at first. It sees the line's characteristic impedance, Z₀ = 50 Ω, and launches a divided wave of <code>V · Z₀ / (Z₀ + R<sub>s</sub>)</code>: ${f2(strong.launch)} V from a 10 Ω driver on a ${VIO} V swing. When the wave reaches a termination R it leaves as a reflected wave Γ times its size, <code>Γ = (R − Z₀) / (R + Z₀)</code>: +1 at an open end, −1 at a short, 0 when R = Z₀. An open CMOS input doubles the wave. A low-resistance driver reflects it again with Γ = ${f2(strong.gammaS)}, and the pin rings: each round trip (${f2(2 * L_FLIGHT)} ns here) multiplies the echo by Γ<sub>far</sub> · Γ<sub>driver</sub> = ${f2(strong.gammaL * strong.gammaS)}.</p>
        <p>The far pin first sees ${f2(strong.firstFar)} V, past its final ${VIO} V (an ESD clamp would carry the excess), and falls back below V<sub>IH</sub> = ${f2(VIH)} V for a moment before it settles: a receiver clocked on that edge sees ${strongStats.fallBacks + 1} rising edges. At ${f0(Z0_BOARD)} Ω the echo disappears (series termination), and with a matched far end it never forms (parallel). The widget solves the lattice exactly: the sum of the waves, shifted by the flight time and smoothed by the edge, is the voltage. V<sub>IL</sub> and V<sub>IH</sub> are a receiver's input thresholds, as in <a href="#/c/inverter/0">chapter ${numOf('inverter')}</a>: below V<sub>IL</sub> it reads 0, above V<sub>IH</sub> 1, and in between nothing is promised. Here they are the I/O standard's levels, 35 % and 65 % of the ${VIO} V supply; the inverter's own are tighter, and chapter ${numOf('clocks')} starts from those.</p>
        <p><b>Try:</b> find the smallest R<sub>s</sub> at which the far pin, once above V<sub>IH</sub>, stays above it. It is ${RS_MIN} Ω for the default trace and edge, and a different edge on this trace leaves it there: each echo arrives whole, so only Γ matters. Shorten the trace to 3 cm and slow the edge to 0.5 ns: the echoes now overlap the edge that made them, and ${minRsStaysHigh(VIO, Z0_BOARD, boardDelay(30), 0.5)} Ω is enough.</p>`,
      widget: () => reflectionWidget(),
      more: {
        derive: `<p>The lattice: forward waves A<sub>k</sub> leave the source at 2kT<sub>d</sub> with A<sub>0</sub> = V · Z₀ / (Z₀ + R<sub>s</sub>) and A<sub>k+1</sub> = A<sub>k</sub> · Γ<sub>L</sub> · Γ<sub>S</sub>; backward waves B<sub>k</sub> = A<sub>k</sub> · Γ<sub>L</sub> leave the load at (2k+1)T<sub>d</sub>. The voltage at x (0 near, 1 far) is Σ A<sub>k</sub>(t − (2k + x)T<sub>d</sub>) + B<sub>k</sub>(t − (2k + 2 − x)T<sub>d</sub>), each a ramp of the source's edge time. It converges to V · R<sub>L</sub> / (R<sub>L</sub> + R<sub>s</sub>), the DC divider, which the tests check along with every closed form here.</p>`,
        pitfall: `<p>Calling the overshoot harmless because the pin is clamped. The clamp diode conducts, and the charge it dumps goes into the supply and the substrate. The signal is also wrong while it rings: a clocked receiver can latch the glitch.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A ' + f0(Z0_BOARD) + ' Ω line is driven through ' + f0(Z0_BOARD) + ' Ω and open at the far end. What does the driver\'s own pin see in the first round trip?',
        options: ['Half the swing, then the full swing after ' + f2(2 * L_FLIGHT) + ' ns', 'The full swing at once', 'Twice the swing, then ringing'],
        answer: 0,
        why: ['', 'The line takes current as Z₀ while the wave is out: the driver is a divider of V into Z₀ + Rs, which is V/2.', 'The doubling happens at the open far end. At the driver, Γ = 0, so the echo is absorbed.'],
        explain: `Launch V/2 = ${f2(seriesL.launch)} V; the open end returns it, doubling the far pin to ${VIO} V, and the echo reaches the driver after ${f2(2 * L_FLIGHT)} ns and is absorbed (Γ_S = 0).`,
      },
    },
    {
      title: 'Termination',
      body: `
        <p>Reflections need two ends that disagree with the line. Fix one of them. <strong>Series termination</strong> adds a resistor R<sub>ser</sub> at the driver so that R<sub>ser</sub> + R<sub>s</sub> = Z₀ (${seriesResistor(10, Z0_BOARD)} Ω after a 10 Ω driver): the launched wave is half the swing, the open far end doubles it to the full swing, and the echo is absorbed at the driver. <strong>Parallel termination</strong> puts a resistor of Z₀ to ground at the far end, so there is no echo at all.</p>
        <p>The costs differ. Series needs no DC power and adds one round trip of half-swing at the driver pin: anything connected along the trace sees ${f2(seriesL.launch)} V for ${f2(2 * L_FLIGHT)} ns before the real edge, so it suits point-to-point links. Parallel gives every receiver on the line a clean edge on arrival and a DC path while the line is high: ${f0(parallelPower(VIO, 10, Z0_BOARD) * 1000)} mW in the terminator from a 10 Ω driver (the supply delivers V² / (R<sub>s</sub> + R<sub>t</sub>) = ${f0((VIO * VIO / (10 + Z0_BOARD)) * 1000)} mW, the driver's own channel taking the rest), which is why it is rare on wide buses and common on a few fast signals. Its final level also drops to ${f2((VIO * Z0_BOARD) / (Z0_BOARD + 10))} V, a divider between the driver and the terminator, which eats noise margin.</p>
        <p>Neither saves delay. The edge reaches the far pin after the flight time and the edge itself, and the series line crosses V<sub>IH</sub> about ${f2(seriesStats.firstHigh! - strongStats.firstHigh!)} ns after the unterminated line's first, wrong, crossing, but it crosses once and stays.</p>`,
      widget: () => terminationWidget(),
      challenge: {
        kind: 'quiz', question: 'Which termination suits a lone driver feeding 16 receivers spread along a bus, all of which must see a clean edge at their pin as it passes?',
        options: ['Parallel at the far end: every tap sees the settled edge as the wave goes by', 'Series at the driver: simplest and no DC power', 'Neither works; a bus cannot be terminated'],
        answer: 0,
        why: ['', 'Series gives a half-swing step that waits for the reflection from the open end to come back before the full swing arrives. Taps near the driver see the half step for a round trip.', 'Multi-drop buses are routinely terminated at the far end (or at both).'],
        explain: 'With series termination the line reaches full voltage only as the reflection from the open end returns; a tap near the driver sees half a swing for up to a round trip. Parallel termination absorbs the wave at the end, so each tap sees the full edge as it passes.',
      },
    },
    {
      title: 'Crosstalk, ground bounce and pairs',
      body: `
        <p>Two traces side by side share a mutual capacitance and a mutual inductance. When one switches, the other, quiet, carries a pulse. The near end (at the aggressor's driver) sees <code>K<sub>b</sub> · V</code> with <code>K<sub>b</sub> = ¼ (C<sub>m</sub>/C + L<sub>m</sub>/L)</code>, for as long as the run lasts, twice its flight time. The far end sees <code>½ (C<sub>m</sub>/C − L<sub>m</sub>/L) · (T<sub>d</sub> / t<sub>r</sub>) · V</code>, a pulse of the edge's width: zero in a homogeneous medium and negative on a microstrip, where the inductive part wins. At a spacing equal to the height over the plane (s = h) and a 0.2 ns edge over 10 cm this model gives ${f0(xt1.next * 1000)} mV at the near end and ${mv(xt1.fext)} at the far end, against ${f0(VIL * 1000)} mV of low-level margin. Spreading the pair to 3h cuts the near end to ${f0(xt3.next * 1000)} mV (layout guides give a similar rule, spacing of three trace widths). The coupling coefficients are a rough estimate in the model, not a field solution, and the far-end figure in particular is only an order of magnitude at this geometry.</p>
        <p><strong>Ground bounce</strong> is the same coupling through the chip's own return path. A pad driving a ${f0(Z0_BOARD)} Ω line draws about ${f1(I_PAD * 1000)} mA (${VIO} V over the ${f0(R_PAD)} Ω driver and the line); eight of them switching in 1 ns through 3 nH of package ground lift the chip's ground by <code>L · n · di/dt</code> = ${f2(bounce(8, 1))} V, already ${f0((100 * bounce(8, 1)) / VIL)} % of V<sub>IL</sub> = ${f2(VIL)} V: a ninth pad would pass it. Between V<sub>IL</sub> and V<sub>IH</sub> = ${f2(VIH)} V a receiver's input is undefined; above V<sub>IH</sub> a quiet low can be read as high. In a 0.2 ns edge the linear formula gives ${f2(bounce(8, 0.2))} V, more than the ${VIO} V supply, which cannot happen: the lifted ground reduces the drive current and slows the edge, so the formula is valid only while the bounce is a small fraction of the supply, and the widget flags it beyond that. This is why pads have slew-rate control and a package has many ground pins.</p>
        <p>A <strong>differential pair</strong> sends the signal as the difference of two legs and puts the noise in the common part. A receiver that subtracts them rejects what is equal on both, up to its common-mode rejection and the mismatch of the legs. The rejection (CMRR) is quoted in decibels of a voltage ratio, 20 log₁₀: 40 dB lets 1 % of the common part through. The last panel passes a pseudo-random pattern through a single-pole channel with Gaussian noise: the eye closes as the bandwidth narrows: a 50 % opening needs about ${f2(minBandwidth(1))} of the bit rate in bandwidth, and the eye closes altogether near ${f2(minBandwidth(1, 0))}, and the bit-error rate follows the Gaussian tail: Q(d/σ), the chance that noise of spread σ crosses the half-opening d. Twisting the pair is what makes the legs equal: in the 3D model beside the widget they swap places every half twist, so an electric field sees both alike (common mode) and the loops’ magnetic pickup cancels, and its unevenness slider is where a leg mismatch comes from. Chapter ${numOf('serial')} reads this picture in depth.</p>`,
      widget: () => withModel(noiseWidget(), cable3d()),
      more: {
        derive: `<p>The near-end coefficient saturates once the run is longer than half the edge: the aggressor's edge, rising over t<sub>r</sub>, couples K<sub>b</sub> · dV/dt for as long as the victim's backward wave keeps arriving, which is 2T<sub>d</sub>. A shorter run (2T<sub>d</sub> &lt; t<sub>r</sub>) reaches only K<sub>b</sub> · V · 2T<sub>d</sub> / t<sub>r</sub>. The far-end wave adds up as it travels with the aggressor's edge, which is why it grows with T<sub>d</sub> / t<sub>r</sub>.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Common-mode noise of 0.3 V is picked up equally by both legs of a pair and by a single wire next to it. A receiver on the pair has a CMRR of 40 dB and a leg mismatch of 2 %. What remains at its input?',
        options: ['About 9 mV: 0.3 V × (2 % + 1 %)', '0.3 V: the receiver sees the same noise either way', 'Nothing: a differential receiver rejects all common-mode noise'],
        answer: 0,
        why: ['', 'A single-ended wire sees all of it. A pair gives the receiver two copies to subtract.', 'Two things limit it: the CMRR (finite) and the mismatch between the legs, which turns a common-mode signal into a differential one.'],
        explain: 'The residue is the common noise times the mismatch plus 10^(−CMRR/20): 0.3 V × (0.02 + 0.01) = 9 mV, against 0.3 V on the single wire.',
      },
    },
    {
      title: 'An I/O pad, and where the transistors stop',
      body: `
        <p>The pad is the last stage of the chip and the first on the way in. Its output is a tri-state inverter wide enough to charge a pin, a bond wire and a trace: ${PAD_FINAL}× the unit device here, <span data-show="a.drv">${f0(R_PAD)} Ω</span> while it switches, about half of Z₀ = ${f0(Z0_BOARD)} Ω. Its gate is a ${PAD_FINAL * 2} fF load for the core, so chapter ${numOf('inverter')}'s rule applies: a chain of three inverters, each four times the last (${PAD_CHAIN.map((w) => `${w}×`).join(', ')}), takes a ${PAD_CHAIN[0]}× input to the ${PAD_FINAL}× stage. Its input is a small buffer reading the pin. With <code>en</code> low the output stage lets go and the pin follows whoever else is on the wire.</p>
        <p>The scene is two such pads joined by a wire. Drive <code>d</code> and <code>en</code> on chip <span data-show="a">A</span> and the other end reads it (A drives d with en and reads ya; B drives rd with ren and reads yb; <code>line</code> is the wire between them); enable both ends in disagreement and the solver shows the fight, VDD shorted to GND through both output stages, about ${f0((VIO / (2 * R_PAD)) * 1000)} mA.</p>
        <p><strong>This is where the transistors stop.</strong> From the driver's drain to the receiver's gate, the voltage is not computed from devices. The panel beside the schematic draws it from phys/line.ts: the source resistance is the output stage's effective ${f0(R_PAD)} Ω from the device model, the pin carries ${f1(PAD_PIN_FF / 1000)} pF, the edge is the RC of the two (${f0((2.2 * R_PAD * PAD_PIN_FF) / 1000)} ps), and the line is the lattice of step 5. This is the first box in the book that does not end in transistors; the UART, modem and serial-link chapters reuse it as their line. Past the receiver it is all gates again, and the rest of the track builds on that: a UART, a serial link, Ethernet and the internet all start with a decision made on the voltage that comes out of this model, and the next chapter makes that decision.</p>
        <p class="try"><b>Try:</b> drive a 1 from chip A (<code>d</code> = 1) and watch chip B read it.</p>
        <p class="try"><b>Try:</b> let go (<code>en</code> = 0) and drive the wire from chip B instead (<code>ren</code> = 1).</p>
        <p class="try"><b>Try:</b> enable both ends with opposite data and read the short, about ${f0((VIO / (2 * R_PAD)) * 1000)} mA through the two output stages.</p>
        <p>A ${f0(R_PAD)} Ω driver on a ${f0(Z0_BOARD)} Ω line rings like step 5's strong driver: Γ at the source is ${f2((R_PAD - Z0_BOARD) / (R_PAD + Z0_BOARD))}. Drive an edge, then slide <em>Series R</em> in the panel to about ${f0(seriesResistor(R_PAD, Z0_BOARD))} Ω, the resistor that makes source and line equal: the far pad steps cleanly to the full swing. Real pads offer a drive-strength setting to do this without a part on the board.</p>`,
      scene: () => padScene(),
      lit: 'Chip <span data-show="a">A</span> and chip <span data-show="b">B</span>: two copies of the same pad on one wire',
      tries: [
        (st) => st.value('line') === 1 && st.value('yb') === 1,
        (st) => st.value('en') === 0 && st.value('ren') === 1,
        (st) => !!(st.sim as SwitchSim | null)?.hasShort,
      ],
      challenge: {
        kind: 'reach',
        goal: 'Make chip B read a 1 from chip A over the wire, then take A off the wire and drive a 0 from B so that A reads it.',
        check: (st) => st.value('en') === 0 && st.value('ren') === 1 && st.value('rd') === 0 && st.value('ya') === 0 && st.value('line') === 0,
        hints: ['Only one end may drive at a time: en and ren are the enables.', 'A drives with d and en. B drives with rd and ren.'],
        answer: 'd = 1, en = 1 (B reads 1 on yb); then en = 0, rd = 0, ren = 1: the wire is driven low by B and A\'s buffer reads 0 on ya. The pad that is not driving is a tri-state output that has let go (Z).',
        solve: (st) => { st.setInputs({ d: 1, en: 1, ren: 0, rd: 0 }); st.setInputs({ en: 0, ren: 1, rd: 0 }); },
      },
      more: {
        real: `<p>Real pads add an ESD structure (two diodes to the rails, the clamp that carries the overshoot of step 5), a bond or bump with a few nanohenries, and slew-rate control to limit ground bounce. Each adds to the ${f1(PAD_PIN_FF / 1000)} pF the driver sees. The model puts the pin capacitance in one illustrative number.</p>`,
      },
    },
    {
      title: 'From the pad to the pin',
      body: `
        <p>The pad is not the pin. Between the die and the board sits a bond wire 1 to 3 mm long, a lead in the lead frame, and the board's own copper. A wire carrying current has inductance, about 1 nH per mm for a 25 µm gold wire (<code>L ≈ 0.2 · ℓ · [ln(2ℓ / r) − 0.75]</code> nH, ℓ and r in mm: 2.8 mm is 3 nH), and every falling output returns its current through the same few ground wires; every rising one draws it through the few VDD wires, so the supply sags by the same formula. When several outputs switch at once the chip's ground lifts by <code>L · n · di/dt</code>, the figure of the noise panel on “Crosstalk, ground bounce and pairs”: eight pads, 3 nH and a 1 ns edge give ${f2(bounce(8, 1))} V against V<sub>IL</sub> = ${f2(VIL)} V.</p>
        <p>Open the package and watch the wires that carry it. Adding rail pins (a ground and a VDD pin each) puts bond wires in parallel and divides L, and a longer wire raises it; the model here divides it exactly, which a real package does not, because neighbouring wires couple through their mutual inductance.</p>
        <p>What arrives at the receiver is a voltage with noise on it; what it must deliver is a bit, on its own clock. Chapter ${numOf('clocks')} is that decision.</p>`,
      widget: () => package3d(),
    },
  ],
};
