// Power: where a CPU's energy goes, measured gate by gate (sim/power.ts), and the four ways to spend less of it: fewer
// toggles (activity, glitches), no clock where nothing changes (lib/clockgate.ts), no supply where nothing runs, and a
// lower supply (phys/cmosv.ts). Every number comes from bench/powercosts.json (the single-cycle CPU measured, recomputed
// by tests/power-costs.test.ts), bench/results.json (the benchmark runs) or a widget's own simulation.

import { benchOf } from '../bench/powercosts';
import { CLOCK_GATES, ICG_HOLD, ICG_SETUP } from '../lib/clockgate';
import { delayScale, deviceOf, PROCESSES, SWING_MV, V_NOM } from '../phys/cmosv';
import { PROGRAMS } from '../riscv/programs';
import { groupDigits } from '../sim/numfmt';
import { FF_DRIVER, FF_INPUT, FF_WIRE } from '../sim/netcap';
import { PS_PER_NAND } from '../sim/timing';
import { cpuScene } from '../widgets/cpupanel';
import { activityWidget, atSpeed, densityWidget, dvfsWidget, FRONT_CPUS, frontWidget, gatedWidget, glitchWidget, leakWidget, POWER, raceWidget, sleepWidget, toggleWidget } from '../widgets/power';
import { powerPanel } from '../widgets/powerscene';
import { numOf } from './order';
import type { Chapter } from './types';

const SUM = PROGRAMS.find((p) => p.id === 'sum')!.source;
const { plain, gated } = POWER;
const blk = (name: string, c = plain) => c.blocks.find(([n]) => n === name)?.[1] ?? 0;
const pj = (x: number) => `${x.toFixed(2)} pJ`;
const pct = (x: number) => `${Math.round(100 * x)} %`;
const num = (n: number) => groupDigits(Math.round(n));
const share = (name: string) => pct(blk(name) / plain.pj);
const clockIn = (name: string) => plain.clockBy.find(([n]) => n === name)?.[1] ?? 0;
const ns = (period: number) => ((period * PS_PER_NAND) / 1000).toFixed(2);
const sc = benchOf('sc'), pipe = benchOf('pipe');
const hp = PROCESSES.hp, lp = PROCESSES.lp;
const minE = (id: 'hp' | 'lp') => POWER.minimum[id].dynPj + POWER.minimum[id].leakPj;
const atV = (id: 'hp' | 'lp') => POWER.atVdd[id].dynPj + POWER.atVdd[id].leakPj;
const front = (id: string, t: number) => atSpeed(FRONT_CPUS.find((c) => c.id === id)!, t)!;
const breakEven = (id: 'hp' | 'lp') => (plain.wakePj * 1e-12) / (plain.leakUw[id] * 1e-6);
const fmtT = (s: number) => (s >= 1e-3 ? `${(s * 1e3).toPrecision(3)} ms` : s >= 1e-6 ? `${(s * 1e6).toPrecision(3)} µs` : `${(s * 1e9).toPrecision(3)} ns`);
const cyclesOf = (s: number) => num(s / (plain.period * PS_PER_NAND * 1e-12));

export const chPower: Chapter = {
  id: 'power', num: numOf('power'), title: 'Power', level: 'Physical design',
  blurb: 'Where a CPU\'s energy goes, measured toggle by toggle: ½ C V², activity and glitches, the clock net, a clock gate that cannot glitch, leakage from the circuit\'s own state, power gating, voltage and frequency down to the minimum-energy point, and which of our CPUs spends least.',
  goals: [
    'measure where a CPU\'s energy goes, block by block, and see why the clock and the storage take most of it',
    'tell dynamic from static power, and compute both from a simulation: toggles, glitches and the state of every NAND',
    'gate a clock with a latch so that it cannot glitch, and measure what that saves on our CPU',
    'trade supply voltage against speed, and find the voltage at which an instruction costs least',
  ],
  builds: ['inverter', 'latches', 'cpu', 'pipeline', 'silicon'],
  recap: {
    practise: ['s_icg'],
    keep: [
      `Every toggle of a net costs ½ C V² from the supply; a whole circuit's dynamic power is that summed over its nets and toggles, times the clock rate. Our single-cycle CPU spends ${pj(plain.pj)} per cycle on “sum” at ${V_NOM} V.`,
      `Activity is the data's: the same adder costs more on random operands than on counting. Glitches are toggles that end where they started: ${pct(sc.glitch)} of the single-cycle CPU's energy, ${pct(pipe.glitch)} of the pipeline's.`,
      `The clock is one net that toggles twice every cycle into every flip-flop. A clock gate is a latch open while the clock is low and an AND: en cannot cut a pulse. Gating our register file and memory takes the CPU from ${pj(plain.pj)} to ${pj(gated.pj)} a cycle.`,
      `Leakage flows through off transistors whether anything switches or not, and depends on each NAND's inputs. Cutting the supply stops it, at the cost of charging the circuit again: worth it past ${fmtT(breakEven('hp'))} of idling in the high-performance process.`,
      `Lowering the supply saves V² per toggle but slows every gate. Below threshold the clock falls faster than the leakage does, so energy per instruction has a minimum: ${minE('hp').toFixed(1)} pJ at ${POWER.minimum.hp.v.toFixed(3)} V for our CPU, against ${atV('hp').toFixed(1)} pJ at ${V_NOM} V.`,
    ],
    check: [
      {
        question: 'Why is a bare AND of the clock and an enable a bad clock gate?',
        options: ['A change of the enable while the clock is high cuts or starts a pulse in the middle: a false edge', 'An AND gate is too slow for a clock', 'It wastes more energy than the flip-flops it stops', 'It cannot pass a clock at all'],
        answer: 0,
        why: ['', 'Its delay is a skew to account for, not the problem: the problem is a pulse cut short.', 'It stops far more than it costs: one gate for a whole register.', 'It passes the clock whenever en is 1; that is the point of it.'],
        explain: 'The latch in front of the AND is open only while the clock is low, so en is frozen through the high half and the AND passes whole pulses or none.',
      },
      {
        question: 'Below the minimum-energy point, why does an instruction cost more energy, although every toggle costs less?',
        options: ['The clock slows exponentially, so each instruction lasts so long that leakage dominates', 'The transistors stop switching', 'Glitches multiply at low voltage', 'The capacitances grow'],
        answer: 0,
        why: ['', 'They still switch, only much more slowly.', 'The circuit and its glitches are the same; only the time and the leakage change.', 'C is the wiring and gates; it does not depend on the supply in this model.'],
        explain: 'Dynamic energy keeps falling with V², but leakage power × an exponentially longer instruction grows; their sum has a minimum.',
      },
      {
        question: 'A block will sit idle for a long time. Why not just stop its clock?',
        options: ['It keeps leaking: only cutting its supply stops that, and it costs a recharge on waking', 'A stopped clock loses the registers\' contents', 'A stopped clock draws more current', 'The clock cannot be stopped'],
        answer: 0,
        why: ['', 'Flip-flops hold their value with the clock stopped, as long as they have power.', 'With the clock stopped nothing toggles: only leakage is left.', 'That is what a clock gate does.'],
        explain: 'Clock gating removes the dynamic power; power gating removes the leakage as well, and pays for it in wake-up energy and lost state.',
      },
    ],
  },
  steps: [
    {
      title: 'Where the energy goes',
      body: `
        <p>Every wire is a small capacitor. When one goes from 0 to 1 the supply charges it, and when it goes back to 0 that charge drains to ground. The simulator
        counts every change of every net, and each net's capacitance follows from what it drives (${FF_INPUT} fF for each NAND input, ${FF_DRIVER} fF for its driver, ${FF_WIRE} fF
        of wire for each branch; illustrative values for a 28 nm-class process, like the 25 ps per NAND). From the two the
        Power panel adds up the energy, block by block, glitches included.</p>
        <p>Here is the single-cycle CPU of <a href="#/c/cpu/0">chapter ${numOf('cpu')}</a> running “sum”. Over its first ${POWER.cycles} cycles it spends
        <strong>${pj(plain.pj)} per cycle</strong> at ${V_NOM} V: at its period of ${plain.period} NAND delays (${ns(plain.period)} ns), ${(plain.pj / Number(ns(plain.period))).toFixed(1)} mW.
        Look at which blocks spend it. The <span data-show="dm">data memory</span> takes ${share('dm')}, the clock net alone ${share('clock (clk net)')}, the
        <span data-show="rf">register file</span> ${share('rf')}, and the <span data-show="alu">ALU</span>, which does the actual work, ${share('alu')}.</p>
        <p>The two largest have nothing to compute in most cycles: “sum” stores one word in all, and writes one register a cycle at most.
        They are arrays of flip-flops, and every flip-flop's clock input toggles twice a cycle whether it is written or not. The next steps take the cost apart:
        what one toggle costs, how many toggles the data cause, how many are wasted, and then the clock.</p>
        <div class="try">Run the program and watch the Power panel's bars settle. Then turn on the <b>Activity</b> overlay (the stage bar's Overlay menu): the
        wires that change most often are coloured hottest, and the clock is among them.</div>`,
      scene: () => cpuScene({ source: SUM, extraPanels: [powerPanel({ per: 'instruction' })] }),
      more: {
        derive: `<p>The CPU's ${pj(plain.pj)} per cycle is the sum over every net of its toggles × its C × ½ V². At one instruction per cycle that is also the energy per instruction:
          over the four benchmarks it averages ${(0.5 * sc.ffPerInstr * 1e-3 * V_NOM * V_NOM).toFixed(1)} pJ, more than on “sum” because their data change more bits.</p>`,
        pitfall: `<p>Confusing power with energy. Power is energy per second: a CPU that runs twice as fast at the same energy per instruction draws twice the power and finishes in half the time. A battery holds energy;
          a heat sink removes power. Which one matters decides which number to make smaller.</p>`,
      },
    },
    {
      title: 'One toggle: ½ C V²',
      body: `
        <p>Charging a capacitor C to V through a transistor takes a charge Q = C·V from the supply, at the supply's voltage: an energy Q·V = C V². Only half of it ends up stored
        on the capacitor (½ C V²); the other half is turned into heat in the transistors on the way, whatever their resistance. When the wire falls back to 0 the stored half drains to ground through
        the pull-down transistors, and the supply delivers nothing. A full rise and fall costs C V², so each toggle costs ½ C V² on average.</p>
        <p>Two levers follow at once. The energy goes with the square of V, so a lower supply is the strongest one. And it goes with C, the gates and wire a net drives: a net
        with a large fan-out is expensive to switch.</p>`,
      widget: toggleWidget,
      challenge: {
        kind: 'quiz', question: 'A wire charges from 0 to 1 and back to 0. Where does the energy taken from the supply go?',
        options: ['Half into heat in the pull-up while charging, the other half into heat in the pull-down while discharging', 'It is stored and given back to the supply', 'All of it into heat in the pull-down', 'It depends on the transistors\' resistance'],
        answer: 0,
        why: ['', 'Nothing returns to the supply: a CMOS gate can only charge from VDD and dump to ground.', 'Half is already lost while charging, in the pull-up.', 'The resistance decides how fast, not how much: the split is half and half for any resistance.'],
        explain: 'C V² leaves the supply on the way up: ½ C V² heats the pull-up, ½ C V² sits on the wire until the pull-down turns it into heat.',
      },
    },
    {
      title: 'Activity: the data decide',
      body: `
        <p>Energy per cycle is ½ C V² summed over the toggles, so a circuit costs what its data make it toggle. Engineers write it as P = α C V² f: C the total
        capacitance, f the clock rate, and α, the <b>activity</b>, the fraction of that capacitance that is charged per cycle on average.</p>
        <p>The same 8-bit adder, three streams of operands, every toggle counted on the gate-level simulator. Counting changes few bits a step; random operands change half of them;
        a held operand barely moves the adder at all. A clock has α = 1: it rises and falls every cycle.</p>`,
      widget: activityWidget,
      challenge: {
        kind: 'quiz', question: 'Two programs run on one CPU at one clock rate. One draws more power. What differs?',
        options: ['The activity: its data make more wires change each cycle', 'The capacitance of the wires', 'The supply voltage', 'The number of gates'],
        answer: 0,
        why: ['', 'C belongs to the circuit, which is the same for both programs.', 'The supply is the same for both.', 'The CPU is the same: same gates.'],
        explain: 'α is the only term of α C V² f that the program controls.',
      },
    },
    {
      title: 'Glitches: toggles that change nothing',
      body: `
        <p>A net can change several times in one cycle before it settles: a sum bit of a ripple-carry adder flips as each carry arrives, then flips back. Those
        intermediate changes are <b>glitches</b>. They cost ½ C V² each like any other toggle and achieve nothing. The simulator sees them because every gate has a delay;
        a meter that only compared each cycle's settled values would miss them.</p>
        <p>Glitches grow with logic depth: the deeper the path, the more times a signal can change on its way. Over the four benchmarks they are
        <strong>${pct(sc.glitch)} of the single-cycle CPU's energy</strong>, against ${pct(pipe.glitch)} of the pipeline's: a pipeline register stops every wave of changes at the end of its stage.</p>`,
      widget: glitchWidget,
      more: {
        real: `<p>Synthesis tools balance path delays where glitch power matters (arithmetic, multipliers), and a register in front of a deep block (operand isolation) keeps its inputs still while its result is not wanted.
          A design's power is estimated with simulated activity, glitches included, just as here, before it is signed off.</p>`,
      },
    },
    {
      title: 'The clock is the biggest net',
      body: `
        <p>One net reaches every flip-flop: the clock. In our CPU it drives ${num(plain.clockInputs)} NAND inputs, ${num(plain.clockFf)} fF, and it toggles twice every cycle,
        ${pj(blk('clock (clk net)'))} a cycle on its own. ${pct((clockIn('dm') + clockIn('rf')) / plain.clockInputs)} of those inputs belong to two blocks: the
        <span data-show="dm">data memory</span> (${num(clockIn('dm'))}) and the <span data-show="rf">register file</span> (${num(clockIn('rf'))}). The PC has the rest.</p>
        <p>That is a property of how we built the memories, from flip-flops. Inside each, the clock goes on toggling the master and slave latches, so the cost does not stop at the clock pin:
        it is part of the ${share('dm')} and ${share('rf')} the two blocks take. A real chip keeps large memories in SRAM arrays, whose cells have no clock at all. For the flip-flops
        that remain there is a better answer: stop their clock when they are not written.</p>`,
      scene: () => cpuScene({ source: SUM, highlight: ['rf', 'dm'], extraPanels: [powerPanel({ per: 'instruction' })] }),
    },
    {
      title: 'A clock gate that cannot glitch',
      body: `
        <p>The obvious clock gate is an AND: gclk = clk AND en. The codex's rule <a href="#/codex/clockgating">“Never gate the clock”</a> says why not:
        if en changes while clk is high, the AND cuts a pulse short or starts one in the middle, and every flip-flop behind it sees a false edge.</p>
        <p>One latch fixes it. The <b>integrated clock gate</b> (ICG) puts a <span data-show="icg">D latch</span>, transparent while the clock is low, in front of the AND. en may change
        freely in the low half; at the rising edge the latch closes and holds it through the high half, so the AND passes whole pulses or none. Like a flip-flop, it asks that en be steady a little before the edge
        (${ICG_SETUP} NAND delays here) and just after it (${ICG_HOLD}).</p>
        <div class="try">Turn the clock on, then flip <b>en</b> while clk is high and watch both outputs in the Timing panel: the <span data-show="pin:bare">bare AND</span> makes a short pulse, the
        <span data-show="pin:gclk">ICG</span> does not.</div>`,
      scene: () => ({ root: CLOCK_GATES, inputs: { en: 0, clk: 0 }, analyzer: true }),
      challenge: {
        kind: 'quiz', question: 'The ICG\'s latch is transparent while the clock is low. Why low, not high?',
        options: ['So en is frozen through the high half, when the AND passes the clock', 'So the latch is faster', 'So en is sampled at the falling edge', 'It makes no difference'],
        answer: 0,
        why: ['', 'Speed has nothing to do with it; which half it is open in does.', 'It closes at the rising edge: en is held from the rising edge through the high half.', 'Transparent while high, en would pass straight to the AND exactly when the AND passes the clock: the glitch is back.'],
        explain: 'While the clock is high the AND\'s other input must not move. A latch closed for exactly that half guarantees it.',
      },
    },
    {
      title: 'Our CPU, clock-gated',
      body: `
        <p>Now every register of the <span data-show="rf">register file</span> and every word of the <span data-show="dm">data memory</span> has its own clock gate, enabled by the
        write select the decoder already makes. A register that is not written does not see the clock at all, so the load-enable multiplexer in front of each flip-flop, which
        fed the old value back in, has nothing left to do: each bit is a plain D flip-flop. The CPU gets smaller, from ${num(plain.nands)} NANDs to ${num(gated.nands)}.</p>
        <p>It runs the same program to the same result (the CPU panel's golden model agrees every cycle), on a clock net of ${num(gated.clockFf)} fF instead of ${num(plain.clockFf)}.
        Run it and compare the Power panel with the first step's.</p>`,
      scene: () => cpuScene({ source: SUM, gatedClocks: true, extraPanels: [powerPanel({ per: 'instruction' })] }),
    },
    {
      title: 'What gating saved',
      body: `
        <p>Measured side by side on “sum”: <strong>${pj(plain.pj)} → ${pj(gated.pj)} per cycle</strong>, ${pct(1 - gated.pj / plain.pj)} less, for a CPU that is also smaller. The clock net all but disappears
        and the data memory falls from ${pj(blk('dm'))} to ${pj(blk('dm', gated))}.</p>
        <p>Not every bar shrinks. The register file's grows, from ${pj(blk('rf'))} to ${pj(blk('rf', gated))}: its glitches go from ${pj(plain.rfGlitchPj)} to ${pj(gated.rfGlitchPj)} a cycle,
        ${pj(gated.rfRegGlitchPj)} of them inside the registers themselves. A flip-flop whose clock is held at 0 keeps its master latch open, so the master of every register that is not written
        follows the write-data bus, every change and every glitch of it, cycle after cycle. In the plain register file the enable multiplexer fed each flip-flop its own q, and an
        unwritten master saw nothing move. Gating the clock moved that cost from the clock to the data.</p>
        <p>The share of glitches rises from ${pct(plain.glitch)} to ${pct(gated.glitch)} for two reasons, then: those new glitches (${pj(plain.glitchPj)} → ${pj(gated.glitchPj)} a cycle in all), and the
        settled toggles that vanished with the clock's (${pj(plain.settledPj)} → ${pj(gated.settledPj)}). Real designs answer the first with flip-flops whose master closes too, or by holding the
        write data still when nothing is written.</p>`,
      widget: gatedWidget,
    },
    {
      title: 'Leakage',
      body: `
        <p>An off transistor is not quite off. Below its threshold the current falls by a decade for every ${SWING_MV.toFixed(0)} mV less gate voltage, but never reaches zero:
        the square law of <a href="#/c/mosfet/0">chapter ${numOf('mosfet')}</a>, continued below threshold (the curve is in the next step). That <b>leakage</b> flows whether the circuit switches or not, so it is static power.</p>
        <p>Two processes, from the semiconductor roadmap's requirements for 2013: a <b>high-performance</b> one that leaks ${hp.ioff * 1e9} nA per µm of transistor width and a
        <b>low-leakage</b> one at ${lp.ioff * 1e12} pA per µm, with ${pct(lp.ion / hp.ion)} of its on current. Their thresholds follow from those currents: ${deviceOf(hp).vt.toFixed(2)} V and
        ${deviceOf(lp).vt.toFixed(2)} V. Which transistors of a NAND are off depends on its inputs, and the simulator knows every input. Summed over the CPU's NANDs, cycle by cycle:
        <strong>${(plain.leakUw.hp).toFixed(0)} µW</strong> in the high-performance process, ${(plain.leakUw.lp * 1e3).toFixed(0)} nW in the low-leakage one.</p>
        <p>At ${V_NOM} V that is ${pct(POWER.atVdd.hp.leakPj / atV('hp'))} of an instruction's energy, small next to switching. It stops being small when the clock slows down, or stops.
        On a real high-performance chip leakage is a much larger share (it is what ended Dennard scaling, <a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>), and every simplification here pushes
        the figure down: our transistors are only ${(deviceOf(hp).w * 1000).toFixed(0)} nm wide, because the book's 25 ps per NAND is slow for a 28 nm-class process; the model leaves out DIBL, which raises the off
        current of short channels; it is taken at room temperature, where leakage is lowest; and it has no SRAM arrays, whose millions of idle cells leak the most.</p>`,
      widget: leakWidget,
      more: {
        real: `<p>Real processes offer several thresholds in one library: fast, leaky cells on the critical paths and slow, frugal ones everywhere else. Leakage also grows steeply with temperature,
          which is why a hot chip can run away: more leakage, more heat. At the smallest nodes the gate oxide itself leaks (tunnelling), one reason high-k dielectrics replaced silicon dioxide.</p>`,
        pitfall: `<p>Reading “static power” as power that needs no supply. It is the power drawn while nothing switches, and it is drawn as long as the supply is on.</p>`,
      },
    },
    {
      title: 'Sleep: stop the clock or cut the power',
      body: `
        <p>An idle CPU with its clock stopped switches nothing, and still leaks. <b>Power gating</b> goes further: a large transistor between the block and its supply is switched off, and the
        leakage stops. The price is waking up: every node that must be 1 has to be charged again, ${POWER.plain.wakePj} pJ for our CPU in the state “sum” leaves it in, and whatever
        the registers held is gone unless it was saved first.</p>
        <p>So power gating pays for itself only after a <b>break-even</b> time: ${fmtT(breakEven('hp'))} (${cyclesOf(breakEven('hp'))} clock cycles) in the high-performance process,
        ${fmtT(breakEven('lp'))} in the low-leakage one, where there is so little leakage to save that only long sleeps are worth it.</p>`,
      widget: sleepWidget,
    },
    {
      title: 'Lower the voltage, slow the clock',
      body: `
        <p>Energy per toggle goes with V², the strongest lever there is. The price is speed: a transistor's current falls as the supply approaches its threshold, every gate gets slower, and the CPU's
        critical path with them. Halving the supply to ${(V_NOM / 2).toFixed(2)} V makes every gate ${delayScale(hp, V_NOM / 2).toFixed(1)} times slower in the high-performance process.</p>
        <p>Below the threshold the current, and the clock with it, falls exponentially, while the leakage falls far less: each instruction now lasts long enough to leak more than it switches. Somewhere the two curves
        cross: the <b>minimum-energy point</b>. For our CPU in the high-performance process it is <strong>${minE('hp').toFixed(1)} pJ per instruction at ${POWER.minimum.hp.v.toFixed(3)} V</strong>, running at
        ${POWER.minimum.hp.mhz.toFixed(0)} MHz, against ${atV('hp').toFixed(1)} pJ at ${V_NOM} V and ${POWER.atVdd.hp.mhz.toFixed(0)} MHz: ${(atV('hp') / minE('hp')).toFixed(1)} times less energy, ${(POWER.atVdd.hp.mhz / POWER.minimum.hp.mhz).toFixed(0)} times slower.</p>
        <div class="try">Find the minimum on the curve, then switch to the low-leakage process: its threshold is higher, so the minimum sits at a clock of a few kHz.</div>`,
      widget: dvfsWidget,
      more: {
        derive: `<p>The law: I = I<sub>s</sub> · [F((V<sub>g</sub> − V<sub>t</sub> − n V<sub>s</sub>) / 2nφ<sub>t</sub>) − F((V<sub>g</sub> − V<sub>t</sub> − n V<sub>d</sub>) / 2nφ<sub>t</sub>)] with F(x) = ln²(1 + eˣ).
          Far above threshold F(x) ≈ x², chapter ${numOf('mosfet')}'s (K / 2)(V<sub>gs</sub> − V<sub>t</sub>)²; far below, F(x) ≈ e^(2x), a decade every n φ<sub>t</sub> ln 10 = ${SWING_MV.toFixed(0)} mV. A gate's delay is C V / I;
          energy per instruction is ½ C<sub>switched</sub> V² + I<sub>leak</sub> V · t<sub>instruction</sub>.</p>`,
        real: `<p>Phones and laptops change voltage and frequency together many times a second (DVFS): a table of operating points, a regulator that moves the supply, and software that picks the point for the load. Near-threshold
          designs run sensors and hearing aids at a few hundred millivolts.</p>`,
      },
    },
    {
      title: 'Race to halt, or pace yourself',
      body: `
        <p>A task must finish before a deadline. One way is to run it flat out at ${V_NOM} V and then idle, clock stopped or power cut; the other is to lower the supply just enough to finish on time.
        Which is cheaper depends on how much slack the deadline leaves and how much the process leaks while idling.</p>
        <p>With little slack, racing and pacing cost about the same. With more, pacing wins, by a wide margin in the high-performance process, until the supply reaches the minimum-energy point: below it, slower costs more, so the best plan
        is to run at that point and stop the clock for the rest.</p>`,
      widget: raceWidget,
    },
    {
      title: 'Which CPU for the job',
      body: `
        <p>Every CPU of this book, over the four benchmarks, at ${V_NOM} V: the time and energy per instruction. A faster design can trade its spare speed for a lower supply. Ask each one for the same speed
        and give it the lowest voltage that delivers it, and the order changes: at 4 ns per instruction the balanced pipeline needs ${front('pipe-bal', 4).v.toFixed(2)} V and spends
        ${front('pipe-bal', 4).pj.toFixed(1)} pJ, the single-cycle CPU needs ${front('sc', 4).v.toFixed(2)} V and ${front('sc', 4).pj.toFixed(1)} pJ, and the out-of-order core,
        with all its hardware switching, ${front('ooo', 4).pj.toFixed(1)} pJ at ${front('ooo', 4).v.toFixed(2)} V.</p>`,
      widget: frontWidget,
      challenge: {
        kind: 'quiz', question: 'At the same speed, why can a pipelined CPU spend less energy per instruction than a single-cycle one, although it has more flip-flops?',
        options: ['Its shorter period leaves room to lower the supply, and its registers cut the glitches', 'Pipeline registers store energy', 'It executes fewer instructions', 'Its gates are smaller'],
        answer: 0,
        why: ['', 'Registers do not give energy back; they cost some.', 'Both run the same programs, instruction for instruction.', 'The gates are the same NANDs.'],
        explain: 'Speed can be spent on a lower V, and energy goes with V². The pipeline also wastes less on glitches.',
      },
    },
    {
      title: 'Power density and dark silicon',
      body: `
        <p>Until about 2005 every new process shrank transistors and lowered the supply together, so a chip of the same area drew the same power (Dennard scaling, <a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>).
        Then the supply stopped falling: a lower threshold leaks exponentially more. Transistors kept shrinking, so the power per mm² of a chip running flat out kept rising.</p>
        <p>Packed onto a die, our CPU's logic draws watts per mm². Within a laptop's or a phone's power budget, only part of a large die can run at full speed at once; the rest must
        stay idle, gated or slowed: <b>dark silicon</b>. Designers spend it on specialised blocks that each do one job at a fraction of the energy, and that are dark when not needed. A GPU is one,
        built from many simple lanes doing the same work: <a href="#/c/lanes/0">chapter ${numOf('lanes')}</a> begins one.</p>`,
      widget: densityWidget,
    },
  ],
};
