import { fmtLog10, log10Mtbf, resolutionTime, T0_PS, TAU_PS, windowRate } from '../phys/metastable';
import { metrics } from '../phys/inverter';
import { keeperLimit, KEEPER, thresholds, VM } from '../phys/schmitt';
import { fifo } from '../lib/storage';
import { asyncFifo, BIN2GRAY, GRAY2BIN, PULSE_SYNC, SCHMITT, SYNC2, syncN } from '../lib/sync';
import { CREDIT_EDGES, sustained } from '../comm/asyncfifo';
import { meanGarbage } from '../comm/graybus';
import { stats } from '../sim/stats';
import { CLK_TO_Q, PS_PER_NAND, SETUP } from '../sim/timing';
import { clockApi, fifoScene, grayBusWidget, metastableWidget, noisyEdgeWidget, pulseScene, receiverWidget, schmittPanel, syncScene, windowWidget } from '../widgets/clocks';
import { VDD, VT } from '../widgets/mosphys';
import { withModel } from '../widgets/modelhost';
import { quartz3d } from '../widgets/quartz3d';
import { MS_TIMING } from './seq/timing';
import type { Chapter } from './types';
import { numOf } from './order';

const nf = (x: number, d = 2) => x.toFixed(d);
const mv = (x: number) => `${Math.round(x * 1000)} mV`;
const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;

const M = metrics(1);
const TH = thresholds(KEEPER);
const years = (stages: number, fclk: number, fdata = 100e6, logic = 8) => fmtLog10(log10Mtbf({ stages, fclk, fdata, logic }));
const m1 = () => years(1, 1e9), m2 = () => years(2, 1e9), m3 = () => years(3, 1e9), h2 = () => years(2, 2e9);
const lone = () => ({ logic: 30, m: years(1, 1e9, 100e6, 30) });
const slow = () => fmtLog10(log10Mtbf({ stages: 2, fclk: 1e9, fdata: 100e6, pair: { tau: 2 * TAU_PS, t0: T0_PS } }));

export const chClocks: Chapter = {
  id: 'clocks', num: numOf('clocks'), title: 'Crossing clocks', level: 'Communication',
  blurb: 'When the receiver may look: noise margins, a Schmitt trigger, metastability, a two-flop synchronizer and an asynchronous FIFO.',
  goals: [
    'read a receiver\'s noise margins off its transfer curve, and say how a Schmitt trigger buys hysteresis with a weak feedback keeper',
    'explain why a signal from an unrelated clock lands in the setup window sooner or later, and what a failing sample does to a flip-flop',
    'compute a synchronizer\'s MTBF from its resolution time, and say which constants belong to the silicon and which to the clocks',
    'build a two-flop synchronizer, a toggle pulse synchronizer and a Gray-coded pointer, and state what each can and cannot carry',
    'derive the asynchronous FIFO\'s full and empty rules, and show that its flags are late but never wrong',
  ],
  builds: ['inverter', 'latches', 'wire'],
  recap: {
    keep: [
      `A receiver is an amplifier with a threshold. The matched inverter has VIL ${nf(M.vil)} V and VIH ${nf(M.vih)} V, drives ${nf(M.vol)} V and ${nf(M.voh)} V, and so has ${mv(M.nmL)} of noise margin each way and a peak gain of ${nf(M.gain, 0)}. Between VIL and VIH the receiver does not decide.`,
      `A Schmitt trigger is two inverters and a weak feedback inverter (${stats(SCHMITT).transistors} transistors). The keeper holds the internal node in its old state, so the input must travel further to flip it: ${nf(TH.down!, 3)} V going down and ${nf(TH.up!, 3)} V going up for a keeper ${KEEPER}× the input devices. The hysteresis grows with the keeper, and the output sticks for good past ${nf(keeperLimit())}×.`,
      'Two clocks with no fixed phase relation put data changes at every phase of the receiver\'s period. Static timing can check a fixed phase; it cannot check all of them, so some change lands in the setup / hold window and the first flip-flop can go metastable.',
      `A cross-coupled pair resolves as V(t) = Δ·e^(t/τ). The chance of still being undecided after t_r is e^(−t_r/τ), so MTBF = e^(t_r/τ) / (T0 · fclk · fdata): each extra flop adds a period to t_r and multiplies the MTBF by e^(T/τ) (τ is ${nf(TAU_PS, 0)} ps in the model). The gate simulator cannot time a real race, so those figures are the model's.`,
      `A two-flop synchronizer (${nands(SYNC2)} NANDs) carries a level that the receiver sees for a full period, after two receiving edges. A pulse shorter than the receiving period can fall between edges and vanish. A toggle synchronizer (${nands(PULSE_SYNC)} NANDs) turns each pulse into a level change that cannot, provided pulses are spaced by its latency.`,
      `The bits of a bus have separate delays, so a sampler can read any subset of the changing bits flipped. A binary count flips up to n bits at once (${nf(meanGarbage(4, 'binary') * 100, 0)} % of mid-change samples of a 4-bit count are garbage); a Gray count flips one, so any sample is the old value or the new one.`,
      'The asynchronous FIFO keeps a binary and a Gray write pointer on wclk and the same on rclk; each Gray pointer crosses through a 2-flop synchronizer. empty = (read Gray = synchronized write Gray), full = (write Gray = synchronized read Gray with the top two bits inverted). A synchronized pointer is old, so a flag can be late and never wrong. The depth is a power of two because the full rule (invert the top two bits) relies on the binary-reflected structure of the code; a one-bit cycle of another even length exists, but it needs a different pointer scheme.',
    ],
    check: [
      {
        question: `A Schmitt trigger has thresholds ${nf(TH.down!, 3)} V and ${nf(TH.up!, 3)} V. A slow edge crosses ${nf(M.vm)} V with 0.05 V of noise on it. How many times does the output switch?`,
        options: [`Once: the noise never gets across the ${mv(TH.width!)} between the thresholds`, 'Several times, like a plain inverter', 'Zero: hysteresis blocks slow edges', 'Twice: once at each threshold'],
        answer: 0,
        explain: `After the output has risen at the upper threshold the input would have to fall back below the lower one to switch it again. Noise of 0.05 V cannot move a signal ${mv(TH.width!)}.`,
        why: ['', 'A plain inverter has one threshold, so noise that crosses it flips the output each time. The second threshold is what removes that.', 'The output does switch once the input has travelled to the far threshold: hysteresis delays the switch and does not forbid it.', 'The two thresholds apply to different directions: a rising edge meets only the upper one.'],
      },
      {
        question: 'A 2-flop synchronizer works at 500 MHz. Which change gives the most MTBF?',
        options: ['Halving the clock to 250 MHz', 'Halving the data rate', 'Replacing both flops with faster ones of half the clock-to-q', 'Doubling the data rate'],
        answer: 0,
        explain: `The clock enters twice: e^(t_r/τ) grows with the period (t_r is a period less ${CLK_TO_Q + SETUP} NAND delays) and the denominator falls with fclk. Halving the data rate only halves the denominator.`,
        why: ['', 'It halves the event rate in the denominator, a factor of 2. The exponent is where the orders of magnitude are.', 'Clock-to-q is a small part of the budget, and it enters the exponent only as a subtraction from one period.', 'That makes the MTBF half as long.'],
      },
      {
        question: 'The asynchronous FIFO shows empty = 0 on the read side. What can be said about the number of words in it?',
        options: ['At least one: a flag that is low is true, one that is high may be late', 'Exactly one: empty would have gone low the moment the first word was written', 'Nothing: the pointers are in different clock domains', 'At most the depth'],
        answer: 0,
        explain: 'The read side sees a write pointer that is two edges old. Words written since are not counted yet, so empty can stay high with words inside. It goes low only when the old pointer already shows a word, and that word is still there.',
        why: ['', 'Empty low says the old write pointer was past the read pointer, so at least one word; more may have arrived since, which the read side has not seen yet.', 'The sampled pointer is the old value or the new one, because it is a Gray code, so something is known.', 'True, but it says nothing about empty.'],
      },
    ],
  },
  steps: [
    {
      title: 'What a receiver decides',
      body: `
        <p>Every input pin ends in an amplifier and a threshold. The inverter of chapter ${numOf('inverter')} is the model: the matched pair has its switching threshold at VM = ${nf(M.vm)} V,
        and its transfer curve falls through VM with a peak gain of ${nf(M.gain, 0)}. The curve defines the receiver's contract. An input below <strong>VIL</strong> = ${nf(M.vil)} V is read as 0, above
        <strong>VIH</strong> = ${nf(M.vih)} V as 1, and in between the output is neither: a level that the next gate may read either way, or as a runt, a pulse too weak to be a clean 0 or 1.</p>
        <p>The curve's outputs at those two points are VOL = ${nf(M.vol)} V and VOH = ${nf(M.voh)} V, the conservative figures a datasheet would quote for a driver (one that swings to the rails has more), so the margin before the receiver's zone is <strong>NML</strong> = VIL − VOL = ${mv(M.nmL)} and
        <strong>NMH</strong> = VOH − VIH = ${mv(M.nmH)}. That budget pays for everything that disturbs a wire between two chips or two blocks of one: supply bounce, crosstalk,
        reflections, ground offset. Chapter ${numOf('wire')} did the arithmetic of those against an I/O standard's wider levels; this chapter starts from the inverter's own, and from where the budget is spent.</p>
        <p>Two consequences matter for what follows. A large gain makes the undefined zone narrow (${mv(M.vih - M.vil)} wide here), and an input that sits in it has an output that takes
        longer than usual to leave the middle. And a slow or noisy edge spends time in the zone, so the receiver sees many crossings of the threshold where the sender made one.</p>
        <div class="try">Raise the noise past ${nf(Math.min(M.nmL, M.nmH))} V. The worst-case level reaches the receiver's undefined zone.</div>`,
      widget: receiverWidget,
      challenge: {
        kind: 'quiz',
        question: `A driver's high level is ${nf(M.voh)} V and the receiver's VIH is ${nf(M.vih)} V. A 0.5 V spike couples onto the high level. What does the receiver read?`,
        options: ['1: the level is still above VIH', '0: any spike flips a level', 'Neither: the receiver is in its undefined zone', 'It depends on the supply voltage only'],
        answer: 0,
        explain: `${nf(M.voh)} − 0.5 = ${nf(M.voh - 0.5)} V is above VIH (${nf(M.vih)} V) by ${mv(M.voh - 0.5 - M.vih)}. The margin NMH = ${mv(M.nmH)} was built for exactly this.`,
        why: ['', `A spike flips a level only when it is larger than the margin, here more than NMH = ${mv(M.nmH)}.`, `That needs the level to fall below ${nf(M.vih)} V, a drop of more than ${mv(M.nmH)}.`, 'The thresholds scale with the supply, but the question fixes the voltages: compare them.'],
      },
    },
    {
      title: 'A Schmitt trigger',
      body: `
        <p>A receiver that must tolerate a slow or noisy input gives itself two thresholds. The <strong>Schmitt trigger</strong> here is ${stats(SCHMITT).transistors} transistors:
        an input inverter A (<span data-show="p1 n1">p1, n1</span>) drives a node m, an output inverter B (<span data-show="p2 n2">p2, n2</span>) turns m into y, and a
        <span data-show="pk nk">keeper</span>, a weak inverter from y back onto m. The keeper restates whatever y is, so m is held where it was. It is built with a narrow PMOS and NMOS
        (strength 2 in the switch-level solver, the input devices 3) the way an SRAM cell's pull-ups are: strong enough to hold, weak enough to lose a fight.</p>
        <p>At switch level the part is a buffer: y follows a. The analogue story is in the panel, computed from the current balance of chapter ${numOf('mosfet')}'s square-law devices.
        With y = 0 the keeper's PMOS pulls m up with a current proportional to its width κ (in units of the input devices). The input rises, A's NMOS pulls m down, and m crosses B's
        threshold only when A's NMOS current exceeds A's PMOS plus the keeper: <strong>VT+ = ${nf(TH.up!, 3)} V</strong> for κ = ${KEEPER}. Going down the keeper is on the other side:
        <strong>VT− = ${nf(TH.down!, 3)} V</strong>. The pair is symmetric, so both sit ${mv(TH.width! / 2)} from VM, a hysteresis of ${mv(TH.width!)}, and it grows in step with κ. At κ = ${nf(keeperLimit())} the
        input inverter no longer wins at any voltage up to VDD and the output sticks.</p>
        <p>The price is area (two more transistors than a buffer of two inverters), a slower edge (the keeper fights every transition) and a hysteresis that moves with process and temperature.</p>`,
      scene: () => ({ root: SCHMITT, inputs: { a: 0 }, panels: [schmittPanel] }),
      more: {
        derive: `<p>At the node's own threshold m = VM = ${nf(VM)} V the keeper's device has V<sub>ov</sub> = VDD − Vt = ${nf(VDD - VT)} V and V<sub>ds</sub> = VDD − VM = ${nf(VDD - VM)} V: it is in its linear region and carries K[(VDD − Vt)(VDD − VM) − (VDD − VM)²/2] = ${nf((VDD - VT) * (VDD - VM) - (VDD - VM) ** 2 / 2)} K per unit of κ. Both devices of A are saturated there, with currents ∝ (Vin − Vt)². An input δ above VM gives the NMOS (VM − Vt + δ)² and the PMOS (VM − Vt − δ)², a difference of 2Kδ(VM − Vt) = ${nf(2 * (VM - VT))} Kδ. Equating the two, δ = ${nf(((VDD - VT) * (VDD - VM) - (VDD - VM) ** 2 / 2) / (2 * (VM - VT)))} κ volts, linear in κ: the figures above are exactly this (tests/comm-phys.test.ts). At κ = 1 the shift is VM, the upper threshold reaches VDD, and that is the keeper's limit.</p>`,
        real: `<p>Production Schmitt inputs (a 74HC14, a microcontroller pin with hysteresis) use the same idea in a six-transistor circuit in which a second PMOS and NMOS feed back to the source of the first pair. The hysteresis is a datasheet number, typically 10 to 20 % of VDD.</p>`,
        pitfall: `<p>Reading hysteresis as noise immunity at any amplitude. It rejects noise smaller than its width on a slow edge. Noise larger than ${mv(TH.width!)} peak to peak still crosses both thresholds, and the next step shows where that limit is.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'The keeper holds node m high (the output is 0). Which threshold does a rising input meet?',
        options: ['The upper one, VT+: A has to overpower the keeper as well as its own PMOS', 'The lower one, VT−', 'VM, as for a plain inverter', 'Neither: the keeper prevents the switch'],
        answer: 0,
        explain: 'The keeper adds to the pull-up, so the NMOS must carry more current before m falls below B\'s threshold. The input has to go further than VM.',
        why: ['', 'VT− applies to a falling input, when the keeper is holding m low and the PMOS must overcome it.', 'Without the keeper, yes. With it the node is held, which moves the point where m crosses.', `Only a keeper wider than the input devices (here κ above ${nf(keeperLimit())}) prevents it.`],
      },
    },
    {
      title: 'Noise on a slow edge',
      body: `
        <p>Count the transitions. The input here is a slow ramp from 0 to ${VDD} V with <span data-ahead="gaussian">Gaussian noise (bell-shaped: most samples near zero, few far out; σ, its width, is the noise's RMS value)</span> on every sample. A plain receiver with one threshold at VM follows every crossing of that threshold, and
        a clocked circuit behind it sees each as an edge: a counter counts them, a flip-flop clocked by it is clocked several times. The Schmitt trigger switches once, when the ramp has gone ${mv(TH.width! / 2)} past VM,
        and stays there until the input has fallen back by the full hysteresis.</p>
        <p>The rule of thumb is a hysteresis at least as wide as the noise peak to peak (about 6 σ for Gaussian noise) and no more than would hide a real signal. The keeper's width is the knob;
        a wider keeper costs more delay and drifts more over process corners.</p>
        <div class="try">At 0.04 V of noise the plain receiver already chatters while the Schmitt trigger switches once. Raise the noise until the Schmitt trigger chatters too: that happens when the excursions approach the hysteresis. Then move the keeper to 0 and watch it become the plain receiver.</div>`,
      widget: noisyEdgeWidget,
      challenge: {
        kind: 'quiz',
        question: `A Schmitt trigger with ${mv(TH.width!)} of hysteresis sees a slow edge with 0.4 V peak-to-peak noise. What can happen?`,
        options: ['It can still chatter: the noise is larger than the hysteresis', 'It switches exactly once, whatever the noise', 'It chatters less than a plain receiver, but never more than twice', 'It sticks high for good'],
        answer: 0,
        explain: 'A noise excursion of 0.4 V can carry the input across both thresholds, and the output follows. Hysteresis has to be sized above the noise it must reject.',
        why: ['', 'Only for noise smaller than the width. Make σ large in the widget and the count rises again.', 'There is no such bound: each full excursion across both thresholds is two more transitions.', 'Sticking needs a keeper wider than the input inverter, which is a different failure.'],
      },
    },
    {
      title: 'Two clocks are a different problem',
      get body() {
        const ms = MS_TIMING(), win = (ms.setup + ms.hold) * PS_PER_NAND, frac = win / 1e3;
        return `
        <p>Inside one clock domain the contract of chapter ${numOf('latches')} holds by construction. A flip-flop launches a change clk-to-q (${CLK_TO_Q} delays) after an edge, the logic adds its delay, and the next edge of the <em>same</em> clock
        captures it, provided the change is there a setup time earlier and stays a hold time after. Static timing walks every path and checks both. It can, because the phase between the launching and the capturing edge is a number it knows.</p>
        <p>Across two clocks that phase is whatever it is. A sender at fA changes data at its own edges, a receiver at fB samples at its edges, and the position of a change inside the receiver's period is
        (n · fB / fA) mod 1. For fA / fB = 1.37 = 137 / 100 that visits 137 values, and with oscillators that drift by parts per million it visits every value in between. The window around the receiver's edge in which a change is neither safely captured nor safely missed is setup + hold = ${ms.setup} + ${ms.hold} delays
        as measured in chapter ${numOf('latches')}, ${win} ps at ${PS_PER_NAND} ps per NAND delay. At a 1 GHz receiver that is ${nf(frac * 100, 1)} % of the period, so one change in ${Math.round(1 / frac)} lands in it: at a data rate of 100 MHz, about ${nf(1e8 * frac / 1e6, 1)} per microsecond. That is not a rare event.</p>
        <p>What happens inside the window is the aperture of chapter ${numOf('latches')}: the master latch is released with its two cross-coupled NANDs balanced, an SR pair freed from both sides at once. The gate simulator
        settles that race by relaxation, in zero time, and picks a side. Silicon does not, as the next step shows.</p>
        <div class="try">Set fA / fB to 1.00 and slide the phase: the edge is in the window at a few phases and nowhere else. Then 1.50, then 1.37.</div>`;
      },
      widget: () => withModel(windowWidget(), quartz3d()),
      challenge: {
        kind: 'quiz',
        question: 'Two blocks run at the same nominal 200 MHz from separate crystals. Why does a transfer between them need a synchronizer?',
        options: ['The oscillators differ by parts per million, so the phase drifts through every value and the window is hit eventually', 'Equal frequencies always collide at the same edge', 'Crystals produce noisy edges that fail setup by themselves', 'Only different frequencies need one'],
        answer: 0,
        explain: 'A fixed phase is a property of one clock tree. Two oscillators at 200 MHz ± 20 ppm move their relative phase by a full period every 125 microseconds or so, so every phase occurs.',
        why: ['', 'Equal and locked gives a fixed phase, which static timing can verify. Equal and independent gives a drifting one.', 'The edges are clean. The problem is where they fall relative to each other.', 'The trouble is the relation of the phases. Different frequencies are one way to get a drifting phase, and not the only way.'],
      },
    },
    {
      title: 'Metastability',
      get body() {
        const tau = (dv: number) => nf(Math.log(0.9 / dv), 1);
        return `
        <p>Sample a signal in the window and the latch's two nodes start almost balanced, apart by some Δ that depends on exactly when the data moved. A cross-coupled pair amplifies a difference exponentially, V(t) = Δ·e<sup>t/τ</sup>,
        until a node reaches a rail. The time that takes is τ · ln(V / Δ): a Δ of a microvolt costs ${tau(1e-6)} τ, a nanovolt ${tau(1e-9)} τ, and a perfectly balanced pair takes for ever. The output meanwhile
        sits between the levels, where the next gate can read it either way.</p>
        <p>As a failure rate, the mean time between failures (MTBF): the pair is still undecided after t<sub>r</sub>, the time it is given to resolve, with probability e<sup>−t<sub>r</sub>/τ</sup>, and a change lands in the window T0 wide at a rate of T0 · fclk · fdata, so</p>
        <p style="text-align:center"><strong>MTBF = e<sup>t<sub>r</sub>/τ</sup> / (T0 · f<sub>clk</sub> · f<sub>data</sub>)</strong>.</p>
        <p>Take τ = ${nf(TAU_PS / PS_PER_NAND, 1)} NAND delays (${nf(TAU_PS, 0)} ps), T0 = 1 delay (${T0_PS} ps), a 1 GHz receiver and data at 100 MHz. The window is hit ${windowRate(1e9, 1e8).toExponential(1)} times a second. A single flop followed by 8 NANDs of logic has t<sub>r</sub> = ${nf(resolutionTime(1, 1000, 8 * PS_PER_NAND), 0)} ps and an MTBF of ${m1()}, already safe in this model. What a lone flop lacks is margin: its budget is the period less clock-to-q, setup and the logic behind it. Let the logic fill most of the period (${lone().logic} NANDs, ${lone().logic * PS_PER_NAND} ps) and t<sub>r</sub> falls to ${nf(resolutionTime(1, 1000, lone().logic * PS_PER_NAND), 0)} ps, MTBF ${lone().m}. A second flop with nothing between them fixes t<sub>r</sub> at a period less clock-to-q and setup whatever the logic is: ${nf(resolutionTime(2, 1000), 0)} ps, MTBF ${m2()}. A third: ${m3()}. So two flops are the default because they take the logic out of the budget, and a third is added where the clock rate eats the period.</p>
        <p>Notice what dominates: the exponent. With τ doubled to ${nf((2 * TAU_PS) / PS_PER_NAND, 1)} NAND delays the two-flop figure at 1 GHz falls from ${m2()} to ${slow()}. The constants here are illustrative, so the sensitivity is the lesson: MTBF is exponential in t<sub>r</sub>/τ, and a factor of two in τ moves the answer by tens of orders of magnitude.</p>`;
      },
      widget: metastableWidget,
      more: {
        derive: `<p>Let a change land uniformly in the period, so the pair starts with a difference proportional to the distance of the change from the edge, within the window of width T0. The chance that the pair is still undecided after t<sub>r</sub> is the chance that Δ &lt; V·e<sup>−t<sub>r</sub>/τ</sup>, which for a uniform Δ over the window scales as e<sup>−t<sub>r</sub>/τ</sup>.
          Multiply by the rate of events in the window, fclk · fdata · T0, for the failure rate. Its inverse is the MTBF.</p>`,
        numbers: `<p>Resolution time and MTBF for the configurations above (data at 100 MHz). The budget charges clock-to-q and setup ${CLK_TO_Q} and ${SETUP} delays, as static timing does; the window measured in chapter ${numOf('latches')} was smaller, so these figures err on the safe side.</p>
          <table class="mini"><tr><th>synchronizer</th><th>t<sub>r</sub></th><th>MTBF at 1 GHz</th><th>MTBF at 2 GHz</th></tr>
          <tr><td>one flop, 8 NANDs behind</td><td>${nf(resolutionTime(1, 1000, 8 * PS_PER_NAND), 0)} ps</td><td>${m1()}</td><td>${years(1, 2e9)}</td></tr>
          <tr><td>one flop, ${lone().logic} NANDs behind</td><td>${nf(resolutionTime(1, 1000, lone().logic * PS_PER_NAND), 0)} ps</td><td>${lone().m}</td><td></td></tr>
          <tr><td>two flops</td><td>${nf(resolutionTime(2, 1000), 0)} ps</td><td>${m2()}</td><td>${h2()}</td></tr>
          <tr><td>three flops</td><td></td><td>${m3()}</td><td></td></tr></table>
          <p>With τ doubled the two-flop figure at 1 GHz is ${slow()}.</p>`,
        real: `<p>τ and T0 are characterized per flip-flop cell by sweeping the data arrival against the edge and fitting the growth of clk-to-q. τ shrinks with the technology (about 10 to 30 ps in 28 nm, a few ps for the fastest cells), which is why the same two-flop synchronizer is safe at 1 GHz and marginal at 4 GHz.</p>`,
        pitfall: `<p>Reading 1 − e<sup>−t/τ</sup> as "mostly resolved". The tail is the whole story: a probability of 10<sup>−20</sup> per event is still a failure within the life of a product at these rates. A metastable output also does not pause the chip. It can reach the next flop as a runt, and be read as 0 by one gate and as 1 by another.</p>
          <p><strong>What these figures are.</strong> The gate simulator resolves a balanced pair in zero time (<code>relax()</code> in gatesim.ts, Gauss–Seidel until one side wins) and cannot time a real race, so every number on this page is the
          model's. The constants are illustrative, tied to the book's delay per NAND; a library cell has its own τ and T0, measured. The gates in the next steps show the structure and the latency of a synchronizer, and those are exact.</p>
          <p>T0 is narrower than the setup + hold window of the previous step (1 delay against ${MS_TIMING().setup + MS_TIMING().hold}). The window is where the captured value is uncertain; T0 is the part of it where the decision takes unboundedly long, the sliver around the exact balance point, and it is what enters the MTBF.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'A synchronizer clocked at 1 GHz has an MTBF of 10 years. A third flop is added at the same 1 GHz clock. How does the MTBF change?',
        options: [`It is multiplied by e^(T/τ), about 10^${Math.round(1e3 / TAU_PS / Math.LN10)} at 1 GHz`, 'It is multiplied by 1.5', 'It doubles', 'It is unchanged: only the first flop can fail'],
        answer: 0,
        explain: `Each flop adds a whole period to the resolution time, and the period is ${Math.round(1000 / TAU_PS)} time constants at 1 GHz. The MTBF is exponential in t_r, so each period multiplies it by e^(T/τ).`,
        why: ['', 'MTBF is exponential in the resolution time, not linear in the number of flops.', 'A doubling would follow if the failure probability merely halved. It falls by e^(T/τ).', 'Only the first flop goes metastable at first, but the second can too, if the first has not resolved when it samples. The third gives the second a period to resolve in turn.'],
      },
    },
    {
      title: 'The two-flop synchronizer',
      body: `
        <p>The standard fix lets the first flop be the one that fails and gives it a period to recover. A <strong>two-flop synchronizer</strong> (${nands(SYNC2)} NANDs, ${stats(SYNC2).transistors} transistors)
        is two flip-flops on the receiving clock with nothing between them. The first samples the asynchronous input and may be undecided; the second samples it a period later, with an MTBF as in the previous step. Nothing else may read the first
        flop's output, and no logic may sit between the two.</p>
        <p>The gates show the structure and its cost in cycles. A level that appears before an edge of B is captured by the first flop at that edge and appears at <code>q</code> at the next one: the second B edge after the sender's change
        (measured on the scene, at every ratio, tests/comm-sync.test.ts), which is between 1 and 2 B periods later, plus clk-to-q. The panel ticks the two clocks one edge at a time in the ratio you pick, with the sender flop on A (<span data-show="tx">tx</span>) feeding the <span data-show="sy">synchronizer</span> on B.</p>
        <p>What gets through is a <em>level</em> that B sees at least once. A pulse that lasts one A cycle is wide enough only if B's edges are closer together than the pulse: with A three times faster than B, the pulse can end between two B edges and the synchronizer never sees it.
        The usual rule is that B is at least 1.5 times faster than A for a one-cycle pulse, or that a level is held for at least three B periods.</p>
        <div class="try">At 3 : 1, press <strong>Send 1-cycle pulse</strong> and Run. Then <strong>Hold send 4 cycles</strong>. Then switch to 1 : 3 and send the pulse again.</div>`,
      scene: syncScene,
      challenge: {
        kind: 'reach', goal: 'Lose a pulse: send the 1-cycle pulse at A : B = 3 : 1 and let B finish without ever seeing it.',
        check: (st) => clockApi.get(st)?.status() === 'lost',
        hints: ['The ratio list starts at 3 : 1: A runs three edges to each of B\'s.', 'Press Send 1-cycle pulse, then let it run for a few B edges.'],
        answer: 'At 3 : 1 the sender flop holds the 1 for one A period, a third of B\'s. Unless a B edge happens to land inside it, B samples 0 at both of its next edges and q never rises.',
        solve: (st) => { const a = clockApi.get(st); a?.setRatio(0); a?.action(0); a?.steps(24); },
      },
    },
    {
      title: 'Passing one event',
      body: `
        <p>A level survives the crossing. An <em>event</em> (a request, a "go") is a pulse, and a pulse may not. The <strong>toggle synchronizer</strong> (${nands(PULSE_SYNC)} NANDs) turns the event into a level that
        cannot be missed. On A, each pulse toggles a flip-flop (<span data-show="tx tg">tx, tg</span>): the level t changes and stays changed until the next pulse. The level crosses through a
        <span data-show="sy">two-flop synchronizer</span> on B, and a flop with an XOR (<span data-show="pv edge">pv, edge</span>) compares the synchronized level with its own value one B cycle earlier. Any change is one pulse of one B cycle on <code>out</code>.</p>
        <p>The level changes rarely compared with either clock (once per event), and one bit changes at a time: any sample is the old value or the new one (the next step needs a code to get the same property for a whole word). What the circuit cannot do is carry two events close together. If A toggles twice before B has sampled the level in between, the level is
        back where it was and B sees nothing, so a second pulse has to wait until the first has crossed: a few B periods. A <em>handshake</em> removes that rule by holding the request until an acknowledge returns through a second synchronizer, which costs
        two crossings per transfer (several cycles of the slower clock).</p>
        <div class="try">Send 1 pulse at 3 : 1: out pulses once. Send 2 close: by the next B edge the level is back where it started, and nothing arrives. Send 2 apart: both do.</div>`,
      scene: pulseScene,
      challenge: {
        kind: 'reach', goal: 'Lose an event: send two pulses on consecutive A edges (A : B = 3 : 1), so that fewer than two reach out.',
        check: (st) => clockApi.get(st)?.status() === 'lost',
        hints: ['The two pulses must be closer together than the synchronizer\'s latency.', 'Use Send 2 close at 3 : 1 and let it run.'],
        answer: 'Two toggles inside one B period return t to its starting value before B samples it, so the receiver sees no change: both events vanish together.',
        solve: (st) => { const a = clockApi.get(st); a?.setRatio(0); a?.action(1); a?.steps(60); },
      },
    },
    {
      title: 'A bus is not synchronized bit by bit',
      body: `
        <p>A multi-bit value cannot cross by synchronizing each bit. The wires have different delays, so for a while after the sender's edge some of the changing bits have arrived at the receiver's flops and some have not, and a sample taken then is
        the old word with an arbitrary subset of the changing bits flipped. A binary counter going from 0111 to 1000 changes four bits: the sampler can read any of sixteen words, and one of them is 1111, 7 away from the nearest word the sender ever meant (the panel's <em>worst error</em> counts from the new word, so it shows 8, for 0000).
        On average ${nf(meanGarbage(4, 'binary') * 100, 0)} % of mid-change samples of a 4-bit binary count are garbage.</p>
        <p>The cure is a code in which neighbouring values differ in a single bit. In <strong>Gray code</strong>, g = b ⊕ (b ≫ 1) (b shifted right one place), consecutive counts differ in one bit, so a mid-change sample is the old word or the new word, and a pointer read one step late is a pointer that is one step late. The conversion is one level of XORs
        one way (${nands(BIN2GRAY(4))} NANDs for 4 bits) and a chain n − 1 deep the other (${nands(GRAY2BIN(4))} NANDs). The chain is the reason the FIFO of the next step compares Gray pointers directly, and converts only on the side that owns the pointer.</p>
        <p>The limit of the trick: it covers a value that moves by one step. A pointer that jumps by two, a counter that wraps before 2<sup>n</sup>, or a general data word, needs a different crossing: a handshake that holds the word steady until the receiver has taken it, or a FIFO.</p>`,
      widget: grayBusWidget,
      challenge: {
        kind: 'quiz',
        question: 'The next step keeps a FIFO\'s read and write pointers in this code, and calls it full when the write pointer equals the read pointer with its top two bits inverted. Why must its depth then be a power of two?',
        options: ['Its full rule (invert the top two bits of the Gray pointer) holds for the binary-reflected Gray code, which cycles over 2^n values', 'No cyclic one-bit sequence of any other length exists', 'The memory decoder needs it', 'The synchronizers need two flops per bit'],
        answer: 0,
        explain: 'A Gray pointer must change one bit per step, wrap included, and the binary-reflected code does so over 2^n values. Its top two bits inverted lie half a cycle away, which is what makes the full compare work. Trimmed sequences of other even lengths can also be one-bit at every step (001, 011, 010, 110, 111, 101 is one), but the half-cycle rule no longer applies, so such a FIFO needs a different full test.',
        why: ['', 'They do exist for any even length. What is lost is the simple full rule, not the one-bit property.', 'A decoder works for any depth, and a memory that is not a power of two is common. The constraint comes from the compare on the pointers.', 'The synchronizers are 2 flops per bit whatever the depth.'],
      },
    },
    {
      title: 'An asynchronous FIFO',
      get body() {
        const a = nands(asyncFifo(2, 8)), s = nands(fifo(2, 8)), sy = nands(syncN(2, 3));
        return `
        <p>Words need a path that does not depend on the clocks at all, and the memory itself is that path: four registers written on <code>wclk</code> (<span data-show="sel w0 w1 w2 w3">a decoder and the registers</span>),
        read through a multiplexer addressed by the read pointer, so <code>rdata</code> always shows the oldest word. The control path is the pointers. Each side keeps a <span data-show="wb rb">binary pointer</span>
        (it addresses the memory, with a lap bit on top) and a <span data-show="wg rg">Gray copy</span> of it, registered. The Gray pointers cross through <span data-show="rs ws">2-flop synchronizers</span>, 3 bits wide, ${sy} NANDs each.</p>
        <p><strong>empty</strong>, on the read side, is <span data-show="em">read Gray = write Gray as synchronized</span>. <strong>full</strong>, on the write side, is <span data-show="fl">write Gray = read Gray as synchronized with its top two bits inverted</span>: the write pointer is
        one lap ahead of the read pointer exactly when that holds, because inverting the top two bits of a Gray code moves it half way round the cycle.</p>
        <p>The synchronized pointer is two edges old. A word written just now is not counted by the read side until it has crossed, so <code>empty</code> stays high a little longer than it should. A slot freed just now is not seen by the write side, so <code>full</code> stays high a little longer. Both errors are <em>conservative</em>: the flag is
        late, never early, so a read never takes an empty slot and a write never lands on a full one. The panel marks a flag that is up while the other side has moved on as "late". The golden model (src/comm/asyncfifo.ts) agrees with the gates at every output after every edge, over seeded interleavings of seven clock ratios, with no word lost, repeated or invented.</p>
        <p><strong>Cost.</strong> ${a} NANDs for 4 × 8 bits, against ${s} for the single-clock FIFO of the library (${nf((a / s - 1) * 100, 0)} % more): two extra pointers, the Gray logic and ${sy * 2} NANDs of synchronizers. A word appears two edges of the read clock after it was written, and a freed slot is seen two edges of the write clock after the read. Throughput is limited by the credit loop: a freed slot reaches the writer, and a written word the reader, only after the two synchronizer edges, so a depth of D sustains min(1, D/${CREDIT_EDGES}) words per edge at 1 : 1 (0.40 at depth 2, ${nf(sustained(2, 1, 1), 2)} at depth 4, full rate from depth 8; the model, pinned in tests/comm-sync.test.ts). With the clocks at other ratios depth 4 already gives ${nf(sustained(2, 2, 1), 2)} words per edge of the slower clock. A shallow FIFO between equal clocks therefore runs below full rate; make it deeper than the round trip.</p>
        <div class="try">Press <strong>Fill</strong> and Run at 1 : 1 until <code>full</code> is up. Switch to <strong>Drain</strong> and watch how long full stays up after the first read. Then try 1 : 7 and 7 : 1.</div>`;
      },
      scene: () => fifoScene(2, 8),
      challenge: {
        kind: 'reach', goal: 'Fill the FIFO: write until the full flag is high.',
        check: (st) => st.value('full') === 1,
        hints: ['Press Fill, then Run or Next.', 'Four words fit; the flag goes up as the fourth is written.'],
        answer: 'With Fill, every W edge writes a word until the write pointer is a lap ahead of the (old) read pointer, which takes four writes from empty.',
        solve: (st) => { const a = clockApi.get(st); a?.setRatio(0); a?.action(0); a?.steps(12); },
      },
    },
  ],
};

void GRAY2BIN;
