// Chapter 8's timing steps, placed after "The flip-flop": the setup / hold window measured on the circuit, the skew that
// breaks a shift register, and the six-gate flip-flop of the 7474. Every number comes from the circuits (tests/deepseq.test.ts).

import { DFF_EDGE6, skewPair } from '../../lib/seqdeep';
import { DFF } from '../../lib/sequential';
import { stats } from '../../sim/stats';
import { CLK_TO_Q, SETUP } from '../../sim/timing';
import { edgeSweepWidget, sweepOf } from '../../widgets/edgesweep';
import { FINE } from '../../widgets/finedelay';
import { skewPanel } from '../../widgets/skewpanel';
import type { Step } from '../types';

const m = (id: 'ms' | 'e6') => {
  const r = sweepOf(id, 'rise'), f = sweepOf(id, 'fall');
  return { r, f, setup: Math.max(r.setup, f.setup), hold: Math.max(r.hold, f.hold), cq: Math.max(r.cqRise, r.cqFall, f.cqRise, f.cqFall) };
};
export const MS_TIMING = () => m('ms');

/** The sweep's numbers under each delay model (widgets/finedelay.ts FINE.sweep, measured) and the skew pair's. */
const FS = FINE.sweep, SK = FINE.skew;
const sgn = (x: number) => (x < 0 ? `−${-x}` : x > 0 ? `+${x}` : '0');
const band = (b: number[]) => (b[0] === b[1] ? `the one cell at ${sgn(b[0])}` : `a band from ${sgn(b[0])} to ${sgn(b[1])}, ${Math.round(10 * (b[1] - b[0] + 0.1)) / 10} units wide`);

export const timingSteps: Step[] = [
  {
    title: 'Measuring setup and hold',
    get body() {
      const a = m('ms');
      return `
      <p>The previous step quoted three numbers; here they are <em>measured</em>. Each cell below is one run of the flip-flop's real netlist: d flips <em>t</em> gate delays from the rising edge, and q is read once the
      circuit has settled. For a <strong>rising d</strong> the edge captures the new value if d moved at least <strong>${a.r.setup}</strong> delay${a.r.setup === 1 ? '' : 's'} earlier and still sees the old one when d
      moves ${a.r.hold} or more delays later; a <strong>falling d</strong> needs <strong>${a.f.setup}</strong> before and is ignored from ${a.f.hold} after. The two directions differ because a falling d reaches the master
      through its inverter and a NAND, a rising one through one NAND. Worst case over both: <strong>setup ${a.setup}, hold ${a.hold}, clock-to-q ${a.cq}</strong> delays. That is the table the static timing of chapters 14 and 17 reads: it
      budgets setup ${SETUP} and clock-to-q ${CLK_TO_Q}, the measured worst cases with ${SETUP - a.setup} delay${SETUP - a.setup === 1 ? '' : 's'} of margin on setup.</p>
      <p>Two names fit what the table is used for. A circuit's <strong>propagation delay</strong> is the <em>longest</em> time from an input change to the output settled: it is what a clock period must cover, with setup. Its <strong>contamination delay</strong> is the <em>shortest</em> time before an output can start to change: it is what a hold time must be covered by. The flip-flop shows both in its own clock-to-q: between ${Math.min(a.r.cqRise, a.r.cqFall, a.f.cqRise, a.f.cqFall)} (contamination) and ${a.cq} (propagation) delays depending on the direction, against a hold of ${a.hold}.</p>
      <p>Between "new captured" and "old kept" sits the <strong>aperture</strong>: the one cell marked <code>?</code> (d moving exactly at the edge for a rising d). There the master's SR pair is released from both sides
      at once, the race of step 2: with unit delays it oscillates for ever, and the simulator stops it after a fixed budget and picks a side. Silicon does not oscillate; it hangs half way and resolves with probability
      growing as 1 − e<sup>−t/τ</sup> (metastability). The window is not a wall either: the nearer d moves to the edge, the longer the resolution takes, which is why a synchronizer (chapter 9) gives it a whole cycle.</p>
      <div class="try">Switch to <strong>d falls</strong>: the window moves. Click the <code>?</code> cell and read q's waveform: it toggles every delay. Then compare the two flip-flops (the second is the next-but-one step).</div>`;
    },
    widget: edgeSweepWidget,
    more: {
      derive: `<p>The constraints between a launching and a capturing flip-flop are T ≥ t<sub>cq</sub> + t<sub>logic</sub> + t<sub>su</sub> (slow path) and t<sub>cq,min</sub> + t<sub>logic,min</sub> ≥ t<sub>h</sub> (fast path). For
        these numbers the fastest clk-to-q is ${m('ms').r.cqRise} against a hold of ${m('ms').hold}: a bare wire satisfies it when both flip-flops see the same clock edge. It stops being true when the capturing clock is late: the next step.</p>`,
      real: `<p>A characterization run does what the widget does, with a SPICE-level cell instead of a gate model: it moves d towards the edge until clk-to-q grows by a set percentage (10 % is common), and records that distance as setup (or hold) for each
        input slew and load. The "window" of a real cell is therefore a convention on a smooth curve, not the sharp band drawn here.</p>`,
      pitfall: `<p>Reading setup as "d must be stable for ${m('ms').setup} delays before the edge". It says that a change <em>earlier</em> than that is captured; a change later is either missed (the old value) or undecided. A signal that moves inside the window
        may produce either value, or a runt, and a design must never depend on which.</p>`,
      numbers: `<p><strong>Load</strong> (the switch beside the direction) times every NAND by what it drives, in tenths of a unit, instead of one delay each; a cell then stands for a tenth. In the master–slave flip-flop, for a rising d, setup grows from ${FS.ms.rise.unit.setup} to ${FS.ms.rise.load.setup}, hold from ${FS.ms.rise.unit.hold} to ${FS.ms.rise.load.hold} and clock-to-q from ${FS.ms.rise.unit.cq.join(' / ')} to ${FS.ms.rise.load.cq.join(' / ')}; for a falling d setup ${FS.ms.fall.unit.setup} → ${FS.ms.fall.load.setup}, hold ${FS.ms.fall.unit.hold} → ${FS.ms.fall.load.hold}. The six-gate flip-flop: rising d setup ${FS.e6.rise.unit.setup} → ${FS.e6.rise.load.setup}, hold ${FS.e6.rise.unit.hold} → ${FS.e6.rise.load.hold}, clock-to-q ${FS.e6.rise.unit.cq.join(' / ')} → ${FS.e6.rise.load.cq.join(' / ')}.</p>
        <p>The undecided cells change most. With unit delays the latch's two NANDs tie, and only a change at one exact offset leaves them racing; under load they no longer tie, and the master–slave's <code>?</code> for a rising d becomes ${band(FS.ms.rise.load.band)}: a change anywhere in it leaves a pulse running round the master latch's loop, and the run never settles (q may already read the new value while it does). The simulator passes a pulse however short (transport delay, under either model); a real gate swallows a pulse much shorter than its own delay, so the band on silicon is narrower: what is left of it is the metastable window.</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: 'On this flip-flop d falls exactly at the rising edge. What does q hold afterwards?',
      options: ['The old value: a falling d needs 2 delays before the edge, and is ignored from 0 after it', 'The new value: any change before the edge is captured', 'Neither: the SR pair oscillates', 'It depends on clk-to-q'],
      answer: 0,
      explain: `A falling d goes through the master's inverter and a NAND, so setup is ${sweepOf('ms', 'fall').setup} delays and hold ${sweepOf('ms', 'fall').hold}. At 0 the change arrives too late to matter; at −1 it lands in the ? cell.`,
      why: ['', 'Only changes at least the setup time earlier are captured, and the setup time for a falling d is 2.', 'That is a rising d at the edge; for a falling d the undecided cell is one delay earlier, and at the edge the master has already closed on the old value.', 'Clock-to-q is how long q takes to follow the edge; it does not decide which value was captured.'],
    },
  },
  {
    title: 'Clock skew: hold fails at any period',
    get body() {
      const a = m('ms');
      return `
      <p>Two flip-flops, <code>ff1</code> feeding <code>ff2</code> with nothing between them: the fastest path in a design is a wire, so only clk-to-q (${a.r.cqRise} delays rising) separates q1's change from the edge that should not have seen it.
      Now delay the second clock by <em>k</em> buffers, 2 gate delays each: the capturing edge arrives <strong>skewed</strong>. ff1's new q reaches d2 ${a.r.cqRise} delays after ff1's edge; if ff2's edge comes at least the setup time (${a.r.setup} for a rising d) later than that, ff2 captures ff1's
      <em>new</em> value, and one edge moves the bit through both stages. The condition is the second inequality of the previous step, with the skew on the other side: <strong>t<sub>cq,min</sub> + t<sub>logic,min</sub> &ge; t<sub>h</sub> + skew</strong>. With ${a.r.cqRise} + 0 and
      hold ${a.r.hold}, one buffer (skew 2) lands in the window and the pair hangs undecided; two buffers (skew 4) is a clean race-through. Lengthening the period changes none of it: hold has no T in it.</p>
      <p>Skew is not exotic: a clock reaches thousands of flip-flops through a buffer tree, and unequal wire lengths, loads and a gated branch (the load-enable step's pitfall) all show up as skew. Fixes: pad the short data path with delay buffers (hold fixing, which
      costs area), balance the clock tree, or build a stage that cannot race (latches on opposite clock phases: chapter 12's "Latches instead of flip-flops").</p>
      <div class="try">Press <strong>Pulse</strong> at 0 buffers: d = 1 moves to q1 only. Choose 2 buffers and pulse once: q2 follows at the same edge.</div>`;
    },
    scene: () => ({ root: skewPair(0), inputs: { d: 1, clk: 0 }, autoClock: false, panels: [skewPanel] }),
    tour: {
      beats: [
        { title: 'No skew', set: { d: 1 }, cycles: 1, show: ['ff1', 'ff2'], expect: { q1: 1, q2: 0 },
          say: '<p>Both flip-flops see the same edge: ff1 takes d, ff2 takes ff1\'s <em>old</em> q. q1 = {v:q1}, q2 = {v:q2}: one stage per edge, a shift register.</p>' },
        { title: 'The next edge', cycles: 1, show: ['ff2'], expect: { q1: 1, q2: 1 },
          say: '<p>The second edge carries the bit into ff2: q2 = {v:q2}. The skewed versions below do this in one edge.</p>' },
      ],
    },
    more: {
      derive: `<p>ff1's q changes ${m('ms').r.cqRise} delays after its edge (rising) or ${m('ms').r.cqFall} (falling). ff2's master must be closed by then: its clock arrives 2<em>k</em> delays late and the master takes ${m('ms').hold} to close, so the fast path
        survives while ${m('ms').r.cqRise} &ge; 2<em>k</em> + ${m('ms').hold}, i.e. k = 0 only. At k = 1 the change lands in the window (undecided); from k = 2 the new value wins.</p>`,
      pitfall: `<p>Slowing the clock to fix a hold failure. Setup is cured by a longer period; hold is a race between two edges of the same cycle and does not contain T at all. A chip with a hold violation is dead at every frequency, which is why hold is
        fixed before tape-out, not by binning.</p>`,
      numbers: `<p>With <strong>Load</strong> in the Clock skew box every NAND is timed by what it drives. A buffer is no longer 2: ff2's clock arrives ${SK.load.slice(1).map((x) => x.late).join(', ')} units late for 1, 2, 3 buffers (unit: ${SK.unit.slice(1).map((x) => x.late).join(', ')}), the last inverter of each driving the flip-flop's clock inputs, and ff1's q changes ${SK.load[0].cq} units after the edge (unit: ${SK.unit[0].cq}). The outcome does not move: no buffer shifts one stage an edge, one buffer leaves ff2 undecided, two or three carry the bit through both. The race is between the same two paths, so it is decided the same way; only the margins are different.</p>`,
    },
    challenge: {
      kind: 'reach',
      goal: 'Make a single clock edge carry d = 1 through both flip-flops (q1 = q2 = 1 after one Pulse).',
      check: (st) => st.cycles === 1 && st.value('q1') === 1 && st.value('q2') === 1 && st.scene!.root.id !== 'skewpair0',
      hints: ['The second flip-flop must see its clock late enough to catch ff1\'s new q.', 'Pick buffers in the Clock skew box: one lands in the undecided window, two or more win the race.'],
      answer: 'Choose 2 (or 3) buffers on the second clock and press Pulse once with d = 1: ff2\'s edge comes 4 delays late, after ff1\'s q has already changed, so it captures the new value.',
      solve: (st) => { st.load({ root: skewPair(2), inputs: { d: 1, clk: 0 }, autoClock: false, panels: [skewPanel] }); st.pulse(); },
    },
  },
  {
    title: 'Six gates: the 7474 flip-flop',
    get body() {
      const a = m('ms'), e = m('e6');
      return `
      <p>A master–slave flip-flop is two latches and an inverter: ${stats(DFF).nands} NANDs. The 7474 of the 1960s does the same job in <strong>six gates</strong>: three cross-coupled pairs with no inverter and no second latch. In our brick that is five 2-input NANDs and one
      3-input NAND, which the brick builds from three 2-input ones: ${stats(DFF_EDGE6).nands} NANDs. The mechanism is <em>lockout</em>: while clk = 0, <span data-show="n2 n3">n2 and n3 are both 1</span>, holding the output pair <span data-show="gq gqn">q, q̄</span>, and <span data-show="n4 n1">n4, n1</span> follow d. When clk rises with d = 1, n4 = 0 keeps n3 at 1 and
      n2 falls (set); with d = 0, n4 = 1 and n3 falls (reset). Each result feeds back: n2 low forces n3 high whatever n4 does, and n3 low holds n4 high whatever d does. The state is decided at the edge, then locked for as long as clk stays high.</p>
      <p>Measured on the circuit exactly as in the sweep: setup ${e.r.setup} / ${e.f.setup}, hold ${e.r.hold} / ${e.f.hold}, clock-to-q ${e.r.cqRise} / ${e.r.cqFall} delays (rising d / falling d; q rising / falling). A negative setup means a d that changes just after the edge is still captured. Against the master–slave
      flip-flop's ${a.r.setup} / ${a.f.setup}, ${a.r.hold} / ${a.f.hold}, ${a.r.cqRise} / ${a.r.cqFall}: ${stats(DFF).nands - stats(DFF_EDGE6).nands} NANDs fewer, but a falling q takes ${e.r.cqFall} delays instead of ${a.r.cqFall} and the hold is longer (${e.r.hold} against ${a.r.hold}).
      Libraries kept the master–slave: its output is a latch that only a settled value reaches, its single-phase clock inverter is shared by a whole register, and its cell can be sized for both setup and hold; the 6-gate one has the d-to-q path through three levels.</p>
      <div class="try">Pulse with d = 1: q = 1 and q̄ = 0 at the edge. With the clock high, change d: nothing moves (lockout). Then open the Timing panel to see n2 and n3 fall in turn.</div>`;
    },
    scene: () => ({ root: DFF_EDGE6, inputs: { d: 1, clk: 0 }, autoClock: false }),
    tour: {
      beats: [
        { title: 'Clock low', set: { d: 1 }, show: ['n4', 'n1'], expect: { q: 0, q_n: 1 },
          say: '<p>clk = 0: n2 = n3 = 1 hold the output pair, q = {v:q}. n4 follows d (¬(n3 · d)), n1 follows n4.</p>' },
        { title: 'The edge', cycles: 1, show: ['n2', 'n3', 'gq', 'gqn'], expect: { q: 1, q_n: 0 },
          say: '<p>clk rises with d = 1: n4 = ¬(n3 · d) = 0 keeps n3 at 1, and n2 = ¬(n1 · clk) falls: the set side. q = {v:q}, q̄ = {v:q_n}.</p>' },
        { title: 'Locked out', set: { d: 0 }, expect: { q: 1, q_n: 0 },
          say: '<p>The clock is low again: n2 = n3 = 1 hold the output pair, and d = 0 only moves n4 and n1. q = {v:q}. Lockout is the same immunity while clk is high: hold the clock high and change d to see it.</p>' },
        { title: 'Next edge, d = 0', cycles: 1, expect: { q: 0, q_n: 1 },
          say: '<p>The next rising edge captures d = 0: q = {v:q}.</p>' },
      ],
    },
    more: {
      derive: `<p>With clk = 1: n2 = ¬n1 and n3 = ¬(n2 · n4). Case d = 1 at the edge: n4 = 0, n1 = ¬(0 · n2) = 1, so n2 = 0 and n3 = 1: set. A late d = 0 gives n4 = 1, n1 = ¬(1 · 0) = 1, n2 stays 0. Case d = 0: n4 = 1, n3 = ¬(1 · 1 · 1) = 0, n4 = ¬(0 · d) = 1 for any d: reset, locked. The four front gates
        form two interlocked SR latches; the output pair is the third.</p>`,
      real: `<p>74LS74 and its successors are this circuit in TTL, with asynchronous preset and clear on extra NAND inputs. CMOS libraries use the master–slave transmission-gate form instead, for the output and hold reasons above.</p>`,
      pitfall: `<p>Thinking fewer gates means faster. The count says nothing about the paths: here a falling q goes through three levels after the edge (${m('e6').r.cqFall} delays against ${m('ms').r.cqFall}).</p>`,
    },
    challenge: {
      kind: 'quiz',
      question: `Which is true of the six-gate flip-flop against the master–slave one on our brick?`,
      options: [
        'Fewer NANDs, but a slower falling clock-to-q and a longer hold',
        'Fewer NANDs and faster in every respect',
        'The same NANDs, with the clock inverter removed',
        'More NANDs: it needs an extra latch for the output',
      ],
      answer: 0,
      explain: `${stats(DFF_EDGE6).nands} NANDs against ${stats(DFF).nands}; clock-to-q ${m('e6').r.cqRise} / ${m('e6').r.cqFall} against ${m('ms').r.cqRise} / ${m('ms').r.cqFall}; hold ${m('e6').r.hold} against ${m('ms').r.hold} for a rising d.`,
      why: ['', 'The measured clock-to-q for a falling q is 5 delays against 3, and its hold is longer.', 'The gate count differs (8 against 11): there is no inverter and no second latch.', 'It has the output pair inside its three pairs of gates; nothing extra.'],
    },
  },
];
