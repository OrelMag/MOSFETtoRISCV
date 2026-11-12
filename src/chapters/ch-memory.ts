import { groupDigits } from '../sim/numfmt';
import { decoder, equal, muxTree } from '../lib/combinational';
import { MUX2 } from '../lib/gates';
import { ram } from '../lib/memory';
import { LFSR_TAPS, clockDivider, DFF_R, JKFF, lfsr, ringCounter, shiftRegister, upDownCounter } from '../lib/seqparts';
import { counter, DFF, DFFE, D_LATCH, register, SR_LATCH } from '../lib/sequential';
import { cam, fifo, pla, PLA_PRESETS, plaTerms, regfileMP, romArray, stack } from '../lib/storage';
import { CLK_TO_Q, SETUP } from '../sim/timing';
import { DET101, DET101_FSM, RV16_DFF, RV16_DFFE, RV16_DLATCH } from '../lib/rv16';
import { DFF_EDGE6 } from '../lib/seqdeep';
import { logicDepth, stats } from '../sim/stats';
import { pack } from '../sim/values';
import { MS_TIMING, timingSteps } from './seq/timing';
import { fsmPanel } from '../widgets/fsmpanel';
import { memGridPanel } from '../widgets/memgrid';
import { memSizePanel } from '../widgets/memsize';
import { core3d } from '../widgets/core3d';
import { CORE_PLANES, CORE_STORE, CORE_WORDS } from '../lib/coremem';
import { coreActions, coreScene, coreTaken, coreView } from '../widgets/coremem';
import { R221, readCycleFigure } from '../widgets/corefig';
import { portCost } from '../widgets/storage';
import { regfile } from '../lib/regfile';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;

/** Value currently stored in word i of a RAM scene. */
function word(st: Stage, i: number): number {
  const n = st.rootCtx?.node.children?.get(`w${i}`);
  return n ? pack(st.rootCtx!.sim.getBits(n.ports.q)) : -1;
}

export const chLatches: Chapter = {
  id: 'latches', num: numOf('latches'), title: 'Memory from feedback', level: 'Sequential logic',
  blurb: 'Loop a gate\'s output back to its input and it starts to remember.',
  goals: [
    'store a bit in two cross-coupled NANDs, and say what the forbidden input does to them',
    'explain metastability: a balanced latch that noise resolves, in a time with no upper bound',
    'derive a D latch from the SR latch, transparent while its enable is 1',
    'build an edge-triggered flip-flop from two latches, read its setup, hold and clock-to-q off a sweep of the circuit, and give it a load enable',
    'say why clock skew breaks a hold check at any clock frequency, and what the six-gate 7474 trades for its gates',
  ],
  builds: ['gates'],
  recap: {
    keep: [
      `Feedback makes memory. Two cross-coupled NANDs (an SR latch, ${nands(SR_LATCH)} NANDs) set on s_n = 0, reset on r_n = 0 and hold with both at 1.`,
      'Both inputs low gives q = q̄ = 1. Released together, the pair balances at its metastable point: noise picks the winner, and the time it takes has no bound (P(undecided after t) ∝ e^(−t/τ)).',
      `D latch (${nands(D_LATCH)} NANDs): d and ¬d drive set and reset, gated by e, so the forbidden input cannot occur. Transparent while e = 1, closed while e = 0. Taking r_n = NAND(s_n, e) drops the inverter: ${nands(RV16_DLATCH)} NANDs.`,
      `D flip-flop (${nands(DFF)} NANDs, ${nands(RV16_DFF)} with the ${nands(RV16_DLATCH)}-NAND latch): a master latch open while clk is low, a slave open while it is high. q changes only at the rising edge.`,
      'The timing contract: d settled a setup time before the edge, held a hold time after it; q follows clk-to-q later. Period ≥ clk-to-q + slowest logic + setup.',
      `Measured on the circuit: setup ${MS_TIMING().setup}, hold ${MS_TIMING().hold}, clock-to-q ${MS_TIMING().cq} delays (worst case over both directions of d). Between "new captured" and "old kept" is an aperture where q is undecided: the race of the SR latch.`,
      'Hold is a race between two edges of one cycle: a late clock on the capturing flip-flop (skew) breaks it at every frequency. Setup is cured by a longer period, hold only by delay in the data path or less skew.',
      `The 7474 edge-triggered flip-flop is six gates (${nands(DFF_EDGE6)} NANDs here, against ${nands(DFF)}): fewer gates, but a slower falling output and a longer hold.`,
      `Load enable: a multiplexer feeds q back into d while en = 0 (${nands(DFFE)} NANDs a bit). The clock itself is not gated (real chips do, with clock-gating cells).`,
    ],
    practise: ['s_sr', 's_dlatch', 's_dff'],
    check: [
      {
        question: 'A D latch has e = 1 while d goes 0 → 1 → 0. What does q do?',
        options: ['It follows d: 0, 1, 0', 'It keeps its old value', 'It changes only at the next clock edge', 'It goes to 1 and stays there'],
        answer: 0,
        explain: 'With e = 1 the latch is transparent: q follows d after a few gate delays, for as long as e stays 1.',
        why: ['', 'That is the closed latch, e = 0.', 'That is the flip-flop. A latch has no edge: it is transparent for as long as e = 1.', 'An SR latch set once would hold 1, but the D latch drives reset from ¬d, so d = 0 resets it again.'],
      },
      {
        question: 'In the master–slave flip-flop, clk is low. Which latch is transparent?',
        options: ['The master', 'The slave', 'Both', 'Neither'],
        answer: 0,
        explain: 'The master follows d while the clock is low (d flows into it while the slave holds q). At the rising edge it closes on d, and the slave opens to show it.',
        why: ['', 'The slave is open while clk is high: it shows what the master caught at the rising edge.', 'Then d would race straight through to q. The opposite enables exist to prevent exactly that.', 'The two swap at the edge; apart from the inverter\'s one-delay lag, exactly one is open.'],
      },
      {
        question: 'Why do designers keep an SR latch from seeing s_n and r_n released at the same instant?',
        options: ['The pair balances at its metastable point: noise picks the winner, and how long that takes has no bound', 'It always resets the latch', 'It shorts the supply to ground', 'It leaves q = q̄ = 1 for good'],
        answer: 0,
        explain: 'Both NANDs see (1, 1) and start to switch together. In silicon the outputs hang near mid-rail until mismatch and noise, amplified by the loop, tip them: the chance of still being undecided after t falls as e^(−t/τ), small but never zero.',
        why: ['', 'Neither input wins by design: mismatch and noise decide, and nothing bounds when.', 'Each NAND is a complete CMOS gate and never shorts the supply. Both outputs at 1 is a legal logic state, just not a useful one.', 'Both outputs are 1 only while both inputs are held low; on release the pair has to fall one way.'],
      },
      {
        question: 'Between two flip-flops the slowest logic is 20 NAND delays; clk-to-q is 3 and setup 2. What is the shortest safe clock period?',
        options: ['25 delays: clk-to-q + logic + setup', '20 delays: the logic alone', '23 delays: setup is met at the edge itself', '22 delays: clk-to-q overlaps the logic'],
        answer: 0,
        explain: 'After the edge q needs 3 delays to change, the logic 20 more, and the next flip-flop wants d settled 2 delays before its edge: 25.',
        why: ['', 'The logic only starts once q has changed (clk-to-q), and must finish before the capturing flip-flop\'s setup window.', 'd must be settled a setup time before the edge, not at it: the master needs that long to take it.', 'The logic\'s input is q: it cannot start before q has changed.'],
      },
    ],
  },
  steps: [
    {
      title: 'Two NANDs holding hands',
      body: `
        <p>Every circuit so far was <em>combinational</em>: outputs depend only on the current inputs. Now feed
        outputs back into inputs.</p>
        <p><span data-show="g1 g2">Two cross-coupled NANDs</span> form an <strong>SR latch</strong>. Its inputs are <em>active-low</em> (the suffix _n, a bar over
        the name in textbooks, means "acts when 0"):</p>
        <ul><li>pull <code>s_n</code> to 0 → <strong>set</strong>: q becomes 1</li>
        <li>pull <code>r_n</code> to 0 → <strong>reset</strong>: q becomes 0</li>
        <li>both at 1 → <strong>hold</strong>: q keeps whatever it was. One bit of memory.</li></ul>
        <p>Why does the loop remember? With both inputs at 1, each NAND is an inverter of the other's output. Two inversions in a ring
        regenerate themselves: q = 1 forces q̄ = 0, which forces q = 1 again, and the opposite pair is just as stable. The circuit has two
        stable states and the inputs push it from one to the other. The cost is ${nands(SR_LATCH)} NANDs (${stats(SR_LATCH).transistors} transistors): the cheapest
        memory you can make from gates, and the seed of every register in this book.</p>
        <div class="try">Set the latch (pulse s_n to 0 and back to 1), then notice q stays 1 with both inputs at 1.</div>`,
      tour: {
        beats: [
          { title: 'Set', set: { s_n: 0 }, show: ['g1', 'g2'], expect: { q: 1, q_n: 0 },
            say: '<p>s_n = 0: g1 = NAND(0, anything) = 1, so q = {v:q}. That 1 reaches g2, whose other input r_n is 1, so q̄ = {v:q_n}.</p>' },
          { title: 'Let go: it holds', set: { s_n: 1 }, show: ['g1', 'g2'], expect: { q: 1, q_n: 0 },
            say: '<p>s_n back to 1. g1 now sees (1, q̄ = 0) and still gives 1: q = {v:q}. The input is gone and the output stayed. This is the memory.</p>' },
          { title: 'Reset', set: { r_n: 0 }, show: ['g2', 'g1'], expect: { q: 0, q_n: 1 },
            say: '<p>r_n = 0: g2 = NAND(q, 0) = 1, so q̄ = {v:q_n}; g1 sees (1, 1) and falls: q = {v:q}.</p>' },
          { title: 'Holds again', set: { r_n: 1 }, show: ['g1', 'g2'], expect: { q: 0, q_n: 1 },
            say: '<p>r_n released: q = {v:q} stays. Which state the latch is in depends on which input was pulled last, nothing else.</p>' },
        ],
      },
      more: {
        derive: `<p>The two equations are q = ¬(s_n · q̄) and q̄ = ¬(q · r_n). With s_n = r_n = 1 they become q = ¬q̄ and q̄ = ¬q, which q = 1, q̄ = 0 and q = 0, q̄ = 1 both satisfy:
          a loop with an even number of inversions has two fixed points. A loop with an odd number of inversions (one NAND fed back on itself) has none, and oscillates.</p>
          <p>A set moves q one gate delay after s_n falls, and q̄ follows one delay later: the pair is settled after two.</p>`,
        real: `<p>This loop is the heart of SRAM too: a 6-transistor cell is two cross-coupled inverters (4 transistors) plus two access transistors. The latch here spends
          ${stats(SR_LATCH).transistors} transistors on the loop alone because each NAND is a full gate with its own pull-up and pull-down.</p>`,
        pitfall: `<p>Forgetting that the inputs are active low. s_n = 0 means <em>set</em>; an input stuck at 0 holds the latch permanently set. On the circuit, a latch whose
          q never changes is usually one with an input stuck at 0. And at power-on, silicon comes up in either state: this simulator starts at q = 0, a hint of its own, which
          real hardware does not give.</p>`,
      },
      scene: () => ({ root: SR_LATCH, inputs: { s_n: 1, r_n: 1 } }),
      challenge: {
        kind: 'reach', goal: 'Store a 1: q = 1 with both inputs back at 1.',
        check: (st) => st.getInput('s_n') === 1 && st.getInput('r_n') === 1 && st.value('q') === 1,
        hints: [
          'Which input sets q to 1, and does it act when it is 0 or when it is 1?',
          'The latch remembers: set it, then return that input to its resting value.',
        ],
        answer: 'Pulse s_n: set it to 0 (q becomes 1), then back to 1. The latch keeps q = 1.',
        solve: (st) => { st.setInputs({ r_n: 1, s_n: 0 }); st.setInputs({ s_n: 1 }); },
      },
    },
    {
      title: 'The forbidden input, and races',
      body: `
        <p>Pull <em>both</em> inputs low and both outputs go to 1, so q and q̄ are no longer opposites. Worse: release
        both at exactly the same moment and <span data-show="g1 g2">each NAND</span> sees (1, 1) and starts to fall. In the logic
        model they fall together, see 0, rise together, and oscillate forever.</p>
        <p>In silicon the outputs are voltages, and the pair settles first at a balance point near mid-rail, both outputs half
        way. The loop's gain amplifies any imbalance (a transistor mismatch, thermal noise) exponentially, the gap growing as
        e^(t/τ), with τ set by the gates' gain and load (picoseconds in a modern process). Noise decides <em>which</em> way it
        falls; nothing bounds <em>when</em>: the chance of still being undecided after a time t falls as e^(−t/τ), never to zero,
        and a gate reading the half-way voltage meanwhile may see 0 or 1. This is <strong>metastability</strong>. Designers keep the
        forbidden input away, and give any flip-flop that may sample a changing input time to settle before anything reads it
        (chapter ${numOf('registers')}'s synchronizer). Here the simulator detects the oscillation and settles the pair arbitrarily, in no time; in silicon
        the resolution takes time, usually little, occasionally a lot.</p>
        <p>Releasing the inputs one after the other is not a race: the input that is still low decides. Try both orders below, and the tour.</p>`,
      tour: {
        label: 'Walk me through it (the ordered release)',
        beats: [
          { title: 'Both low', show: ['g1', 'g2'], expect: { q: 1, q_n: 1 },
            say: '<p>s_n = r_n = 0: g1 and g2 each see a 0 and give 1. q = {v:q} and q̄ = {v:q_n}: the two outputs agree, which a latch must never show.</p>' },
          { title: 'Release s_n first', set: { s_n: 1 }, show: ['g1', 'g2'], expect: { q: 0, q_n: 1 },
            say: '<p>s_n = 1, r_n still 0. g2 still has its 0 input, so q̄ stays {v:q_n}; g1 now sees (1, 1) and falls: q = {v:q}. The pair has a winner: reset, because r_n was still pulling.</p>' },
          { title: 'Both low again', set: { s_n: 0 }, expect: { q: 1, q_n: 1 },
            say: '<p>Pull s_n low once more: q rises to {v:q} and we are back at (1, 1).</p>' },
          { title: 'Release r_n first', set: { r_n: 1 }, show: ['g1', 'g2'], expect: { q: 1, q_n: 0 },
            say: '<p>This time r_n goes first. g1 keeps its 0 input, so q = {v:q}; g2 sees (1, 1) and falls: q̄ = {v:q_n}. Set wins, because s_n was still pulling. Only a release at the <em>same</em> instant leaves the race.</p>' },
        ],
      },
      more: {
        derive: `<p>Let the imbalance between the two outputs be Δ. Around the loop each pass multiplies it by the loop gain, so Δ(t) = Δ₀·e^(t/τ). The pair has decided when Δ reaches the swing V.
          From a 1 mV imbalance on a 1 V swing that takes τ·ln(1000) = ${Math.log(1 / 0.001).toFixed(1)} τ; from 1 µV, ${Math.log(1 / 1e-6).toFixed(1)} τ. Each extra factor of 1000 in how closely
          the release was balanced adds only ${Math.log(1000).toFixed(1)} τ: unbounded in principle, but the tail dies off exponentially.</p>`,
        real: `<p>Every flip-flop that samples an asynchronous signal (a button, a bus from another clock) can enter this state when the input changes inside its setup window. Chips
          quote a metastability constant τ and a window T₀ for each cell, and the mean time between failures follows from them. Chapter ${numOf('registers')} builds the standard remedy, two flip-flops
          in series.</p>`,
        pitfall: `<p>Believing the simulation's answer. Here the oscillation is detected and settled arbitrarily; in silicon the output can sit between 0 and 1, and two gates reading it
          can disagree about its value. No simulation at gate level can show this, so designs avoid the situation instead of testing for it.</p>`,
      },
      scene: () => ({ root: SR_LATCH, inputs: { s_n: 0, r_n: 0 } }),
      actions: [
        { label: 'Release both at once', run: (st) => st.setInputs({ s_n: 1, r_n: 1 }) },
        { label: 'Pull both low', run: (st) => st.setInputs({ s_n: 0, r_n: 0 }) },
      ],
    },
    {
      title: 'The D latch: store what you are told',
      body: `
        <p>Avoid the forbidden input by construction: <span data-show="inv g1 g2">derive both set and reset</span> from one data input <code>d</code>,
        gated by an enable <code>e</code>.</p>
        <ul><li><code>e = 1</code>: the latch is <strong>transparent</strong>, and q follows d.</li>
        <li><code>e = 0</code>: the latch is <strong>closed</strong>, and q holds the last value.</li></ul>
        <p>The <span data-show="sr">SR latch</span> is inside, as a box. Open it.</p>
        <p>The gating is what makes the forbidden input impossible: while e = 1, s_n = NAND(d, e) = ¬d and r_n = NAND(¬d, e) = d, so exactly one of them is 0 and the
        latch is told to set or reset, never both. While e = 0 both are 1, and the SR latch holds. The price is ${nands(D_LATCH)} NANDs: the SR latch's ${nands(SR_LATCH)}, two
        gates for the enable and an inverter for d.</p>`,
      tour: {
        beats: [
          { title: 'Transparent: q follows d', set: { d: 1, e: 1 }, show: ['g1', 'g2'], expect: { q: 1, q_n: 0 },
            say: '<p>e = 1, d = 1: g1 = NAND(1, 1) = 0 is the set line, g2 = NAND(0, 1) = 1 is idle. q = {v:q}.</p>' },
          { title: 'It follows', set: { d: 0 }, show: ['inv', 'g1', 'g2'], expect: { q: 0, q_n: 1 },
            say: '<p>d = 0 while e is still 1: the roles swap, g2 now pulls the reset line low. q = {v:q}. An open latch is just a wire with a delay.</p>' },
          { title: 'Follows again', set: { d: 1 }, expect: { q: 1 },
            say: '<p>d = 1 again: q = {v:q}. Now close the door.</p>' },
          { title: 'Close it', set: { e: 0 }, show: ['g1', 'g2'], expect: { q: 1, q_n: 0 },
            say: '<p>e = 0: both g1 and g2 now output 1 whatever d is, and the SR latch inside sees (1, 1): it holds. q = {v:q}.</p>' },
          { title: 'd changes, q does not', set: { d: 0 }, show: ['g1', 'g2', 'sr'], expect: { q: 1, q_n: 0 },
            say: '<p>d = 0, but e = 0 keeps both lines at 1: q = {v:q} stays. The latch kept the last value it saw while it was open.</p>' },
        ],
      },
      more: {
        derive: `<p><span data-show="inv">The inverter on d</span> is not needed. <span data-show="g1">g1</span> already computes s_n = NAND(d, e),
          which is ¬d while e = 1. Feed it to <span data-show="g2">g2</span> in place of ¬d: r_n = NAND(NAND(d, e), e). While e = 1,
          r_n = d, so d = 0 resets as before; while e = 0, s_n = r_n = 1: hold. d still reaches r_n through two gates (g1 where the inverter was, then g2), so nothing gets slower: ${nands(RV16_DLATCH)} NANDs in place of ${nands(D_LATCH)}.</p>
          <p>Two of these latches and the clock inverter make a ${nands(RV16_DFF)}-NAND flip-flop (the library's is ${nands(DFF)}), and its
          enable version is ${nands(RV16_DFFE)} (against ${nands(DFFE)}). The campaign's levels build these, so their pars count
          ${nands(RV16_DLATCH)} and ${nands(RV16_DFF)}, and the state machine in chapter ${numOf('registers')} is made of them. The chapters keep the
          ${nands(D_LATCH)}-NAND latch on stage because its set and reset sides read more plainly.</p>`,
        real: `<p>Latches are real building blocks, not only a stepping stone: a level-sensitive latch is half the area of a flip-flop, and high-speed designs use latch pairs on
          the two phases of the clock on purpose, so that a slow stage can borrow time from the next (time borrowing). Standard-cell latches are about 8 to 12 transistors, against
          the ${stats(D_LATCH).transistors} here.</p>`,
        pitfall: `<p>Putting a transparent latch in a feedback loop. With e = 1, a loop of logic from q back to d has no register in it: the signal chases itself around at gate speed and may
          oscillate (a plain wire from q̄ to d does exactly that). A latch is safe when its enable is closed before the loop can come around, and that is what the flip-flop of the next step
          arranges with a second latch.</p>`,
      },
      scene: () => ({ root: D_LATCH, inputs: { d: 1, e: 1 } }),
      challenge: {
        kind: 'reach', goal: 'Make the latch hold a 1 while d = 0.',
        check: (st) => st.getInput('d') === 0 && st.value('q') === 1,
        hints: [
          'q follows d only while e = 1.',
          'Capture a 1 while the latch is transparent, and close it before d changes.',
        ],
        answer: 'd = 1 with e = 1 (transparent), then e = 0 (closed), then d = 0. q stays 1.',
        solve: (st) => { st.setInputs({ d: 1, e: 1 }); st.setInputs({ e: 0 }); st.setInputs({ d: 0 }); },
      },
    },
    {
      title: 'The flip-flop: act only on the edge',
      get body() {
        return `
        <p>A transparent latch is awkward in a big circuit: while it is open, changes race straight through. We want
        a memory that samples its input at one precise instant.</p>
        <p>Chain two D latches with <span data-show="inv">opposite enables</span>: the <strong><span data-show="master">master</span></strong> is open while the clock is low; the
        <strong><span data-show="slave">slave</span></strong> while it is high. At the moment the clock rises, the master closes (capturing d)
        and the slave opens (showing it). This is the <strong>edge-triggered D flip-flop</strong>. The two are open on opposite phases, so a change on d cannot run through to q. The inverter leaves them both open for one gate delay after the rising edge, too short for d to cross the master (that delay is the <em>hold time</em>: the Derivation layer defines it, and the next steps measure it). That is the whole trick. Cost: two latches and an inverter, ${nands(DFF)} NANDs, ${stats(DFF).transistors} transistors.</p>
        <p>"At the edge" is a contract with three numbers: <strong>setup</strong>, <strong>hold</strong> and <strong>clock-to-q</strong>. The next steps measure all three on this circuit.</p>
        <div class="try">Change d while the clock is low: q does not move. Press <strong>Pulse</strong>: q
        takes d's value at the rising edge. Open the <strong>Timing</strong> panel to see it over time.</div>`;
      },
      tour: {
        beats: [
          { title: 'Clock low: master open', set: { d: 1 }, show: ['inv', 'master'], expect: { q: 0 },
            say: '<p>clk = 0, d = 1. The inverter opens the master, which follows d. The slave is closed, so q = {v:q} has not moved.</p>' },
          { title: 'The rising edge', cycles: 1, show: ['master', 'slave'], expect: { q: 1 },
            say: '<p>clk rises: the master closes on d = 1 and the slave opens to show what the master holds. q = {v:q}. (The clock then falls again; the master reopens, and q stays.)</p>' },
          { title: 'd changes: nothing happens', set: { d: 0 }, show: ['master'], expect: { q: 1 },
            say: '<p>d = 0 while the clock is low: the master follows it, but the slave is closed. q = {v:q}. Between edges, d is free to move.</p>' },
          { title: 'Next edge', cycles: 1, show: ['master', 'slave'], expect: { q: 0 },
            say: '<p>The next rising edge carries d = 0 across: q = {v:q}. One value per edge, taken at the edge.</p>' },
        ],
      },
      get more() {
        const T = MS_TIMING();
        return {
        derive: `<p>"At the edge" is a contract with three numbers, all visible here. <strong>Setup</strong> (${T.setup} delays here): d must have crossed
        <span data-show="master">the master</span> before clk rises (the larger of the rising and falling d's setup is quoted); a falling d goes through the master's inverter and a NAND.
        <strong>Hold</strong> (${T.hold} delay here): d must then stay put until the master has closed, and clk reaches the master's enable through
        <span data-show="inv">an inverter</span>. <strong>Clock-to-q</strong> (${T.r.cqRise} delays here for a rising q, ${T.r.cqFall} for a falling one): the time the
        <span data-show="slave">slave</span> takes to show the captured value. Between two flip-flops the period must cover clk-to-q + the
        slowest logic + setup, and clk-to-q plus the fastest path must outlast the hold time. Here the numbers fall out of unit NAND delays; in
        silicon they come from characterizing the cell, tens of picoseconds each, and a d that changes inside the window can leave
        the master balanced half way: metastable.</p>
          <p>With t_cq the clock-to-q delay, t_logic the slowest path between two flip-flops, t_su the setup time and t_h the hold time, the constraints between a launching and a capturing flip-flop are
          T ≥ t_cq + t_logic + t_su and t_cq + t_logic,min ≥ t_h. With the timing model's budget for this flip-flop (clk-to-q ${CLK_TO_Q}, setup ${SETUP}: a little above what the next step measures) a stage of 20 NAND delays needs T ≥ ${CLK_TO_Q} + 20 + ${SETUP} = ${CLK_TO_Q + 20 + SETUP} delays. The first
          inequality is about the slow path, so a slower clock fixes it; the second is about the fast path and does not contain T at all.</p>`,
        real: `<p>A library flip-flop is a master–slave pair like this one, in 20 to 30 transistors with tuned sizes, against ${stats(DFF).transistors} here. Its datasheet lists setup, hold and clk-to-q as tables
          over the input slew and the output load, which is why real timing analysis is a calculation over a graph of such tables.</p>`,
        pitfall: `<p>Hold violations. A flip-flop that feeds another one directly (a shift register) has no logic between them, only clk-to-q, and if the capturing flip-flop's clock arrives late (skew),
          its master may still be open when the new value shows up: the data runs through two stages in one edge. Slowing the clock does not help; the fix is delay in the data path, or less skew.</p>`,
        };
      },
      scene: () => ({ root: DFF, inputs: { d: 1, clk: 0 }, autoClock: false }),
      tries: [(st) => st.cycles > 0 && st.value('q') === st.getInput('d')],
    },
    ...timingSteps,
    {
      title: 'Load enable',
      body: `
        <p>Often we want a flip-flop to keep its value on most clock edges and only load a new one sometimes.
        Put <span data-show="mux">a multiplexer</span> in front: when <code>en = 0</code> it feeds q back into d, so the
        <span data-show="ff">flip-flop</span> reloads its own value. When <code>en = 1</code> it lets the new d through.</p>
        <p>The clock never stops: every edge still loads something, only that something is sometimes the old q. The cost is one multiplexer per bit: ${nands(DFFE)} NANDs
        against the plain flip-flop's ${nands(DFF)}, ${nands(DFFE) - nands(DFF)} more (${stats(DFFE).transistors} transistors against ${stats(DFF).transistors}). Because en is just another data input, it obeys setup and hold
        like d does, and a register whose bits share one en is a word that changes only when told to.</p>`,
      tour: {
        beats: [
          { title: 'Disabled: q is fed back', set: { d: 1, en: 0 }, cycles: 1, show: ['mux', 'ff'], expect: { q: 0 },
            say: '<p>en = 0, d = 1, one clock edge: the multiplexer hands q back to the flip-flop, so it reloads q = {v:q}. d was ignored.</p>' },
          { title: 'Enabled: d goes in', set: { en: 1 }, cycles: 1, show: ['mux', 'ff'], expect: { q: 1 },
            say: '<p>en = 1: the multiplexer passes d, and the next edge stores it: q = {v:q}.</p>' },
          { title: 'Disabled again', set: { d: 0, en: 0 }, cycles: 1, show: ['mux'], expect: { q: 1 },
            say: '<p>d = 0 but en = 0: another edge, and q = {v:q} stays. The old value circulated through the multiplexer and back.</p>' },
          { title: 'Enabled: d = 0 goes in', set: { en: 1 }, cycles: 1, show: ['ff'], expect: { q: 0 },
            say: '<p>en = 1: q = {v:q}. The edge took d = 0.</p>' },
        ],
      },
      more: {
        derive: `<p>The flip-flop loads d' = en ? d : q = en·d + ¬en·q. In the steady state en = 0 gives q' = q: the characteristic equation of a register that holds. The multiplexer on the stage
          is the one from chapter ${numOf('gates')} (${nands(MUX2)} NANDs), so the enable costs exactly one of them per bit.</p>`,
        real: `<p>Real chips do gate clocks, because the clock net and the flip-flops it toggles are a large share of dynamic power, and a register that is not loading need not be clocked. They use an
          <strong>integrated clock-gating cell</strong> (ICG): a latch, transparent while clk is low, holds en steady through the high phase, and an AND passes clk only when the latched en is 1, so the
          gated clock has whole pulses only. One ICG serves a whole register, and synthesis inserts it where it finds exactly this mux-and-feedback pattern. Every load enable on this site is the mux.</p>`,
        pitfall: `<p>The obvious alternative is clk·en into the flip-flop: no mux, no reloading. But an AND on the clock delays this flip-flop's edge
          against its neighbours' (skew, eating into setup or hold), and if en changes while clk is high the gated clock gets a runt pulse
          or a second edge. The <span data-show="mux">mux</span> leaves the clock untouched and makes en an ordinary data input, with its
          own setup and hold like d.</p>`,
      },
      scene: () => ({ root: DFFE, inputs: { d: 1, en: 0, clk: 0 } }),
    },
  ],
};

export const chRegisters: Chapter = {
  id: 'registers', num: numOf('registers'), title: 'Registers & counters', level: 'Sequential blocks',
  blurb: 'Store a whole word on every clock edge; count, shift, reset, and divide a clock.',
  goals: [
    `build a register from enable flip-flops, and price a stored bit (${nands(DFFE)} NANDs, ${stats(DFFE).transistors} transistors)`,
    'close a register → logic → register loop into a counter, a shift register, an LFSR or a ring counter',
    'say why an asynchronous reset is released through a synchronizer, and why a ripple divider\'s bits glitch',
    'meet the state machine: a state register, next-state logic and an output, the shape the next chapter designs by method',
  ],
  builds: ['latches', 'adders'],
  recap: {
    keep: [
      `A register is n enable flip-flops sharing a clock and an enable: ${nands(DFFE)} NANDs (${stats(DFFE).transistors} transistors) per bit here.`,
      'Register → logic → register is the shape of every synchronous circuit: an incrementer makes a counter, neighbour wiring a shift register, an XOR of taps an LFSR (2ⁿ − 1 states), an inverted loop a Johnson counter (2n states).',
      'An asynchronous reset clears q at once, clock or no clock. Its release must meet a recovery time before the edge (a setup for reset), so real designs release it through a synchronizer: two flip-flops in series, the first given a whole cycle to settle if it goes metastable.',
      'A ripple divider (each toggle flip-flop clocked by the one before) halves the frequency per flip-flop, but its bits change one after another: a poor counter, and no clock for logic that also sees the original.',
      `A state machine is a state register plus next-state and output logic. The 101 detector: two flip-flops, n0 = x, n1 = ¬x·s0, Mealy output y = x·s1, ${nands(DET101)} NANDs in all. One-hot encoding spends a flip-flop per state to make that logic trivial.`,
    ],
    practise: ['s_reg4', 's_reg16', 's_cnt4', 's_pc'],
    check: [
      {
        question: 'An 8-bit LFSR with maximal taps steps through how many states before it repeats?',
        options: ['255', '256', '8', '16'],
        answer: 0,
        explain: 'Every non-zero value once: 2⁸ − 1 = 255. All zeros is excluded because it never leaves.',
        why: ['', 'The all-zero state feeds back a 0 (an XOR of zeros) and maps to itself, so the cycle visits every value but that one.', 'That is an 8-bit ring counter: one 1 circulating through 8 flip-flops.', 'That is an 8-bit Johnson counter: 2n states.'],
      },
      {
        question: 'A JK flip-flop has j = 1 and k = 1. What happens at each rising edge?',
        options: ['q toggles', 'q becomes 1', 'q becomes 0', 'Nothing defined: it is the forbidden input'],
        answer: 0,
        explain: 'It loads j·¬q + ¬k·q = ¬q: it flips on every edge, like a T flip-flop with t = 1.',
        why: ['', 'That is j = 1, k = 0: set.', 'That is j = 0, k = 1: reset.', 'The SR latch\'s forbidden input is exactly what JK gives a meaning: j·¬q + ¬k·q = ¬q.'],
      },
      {
        question: 'The 101 detector\'s y = x·s1 is a Mealy output. What does that ask of the logic that reads y?',
        options: ['To sample y at a clock edge: y follows x, glitches included', 'Nothing: y changes only at clock edges', 'To wait a cycle: y comes one cycle late', 'To give y its own flip-flop, without which it is undefined'],
        answer: 0,
        explain: 'A Mealy output reads the inputs directly, so it moves whenever x moves. Read at the clock edge, it is correct a cycle earlier than a Moore output.',
        why: ['', 'That is a Moore output, a function of the state alone.', 'That is the Moore version: it recognises the pattern one edge after the Mealy y.', 'y is plain logic on x and s1, defined at every instant. The Moore version adds a state (S3), not an output flip-flop.'],
      },
    ],
  },
  steps: [
    {
      title: 'A register is a row of flip-flops',
      body: `
        <p>Give each bit of a bus its own <span data-show="ff0 ff1 ff2 ff3">enable flip-flop</span>, all sharing one clock and one enable, and you have a
        <strong>register</strong>: a word of memory. A processor keeps its working values in registers (RISC-V has 32
        of them).</p>
        <p>Nothing new is inside: n copies of the previous chapter's enable flip-flop, so the cost is n times ${nands(DFFE)} NANDs (here ${nands(register(4))} for 4 bits, ${stats(register(4)).transistors} transistors),
        and a delay of one flip-flop's clock-to-q from the edge to the word. The shared en does a second job: it fans out to every bit, so a wide register loads all its bits on the same edge or none, and
        a word is never half-written. RISC-V's 32 registers of 32 bits are ${32 * 32} bits, ${32 * 32 * nands(DFFE)} NANDs of flip-flops before any read logic: this bank of registers is one of the biggest blocks on a small core.</p>
        <div class="try">Type a value into d, set en = 1, then Pulse. Change d again with en = 0 and Pulse: q keeps the old word.</div>`,
      tour: {
        beats: [
          { title: 'd is set, nothing stored', set: { d: 5, en: 1 }, show: ['sd', 'ff0', 'ff1', 'ff2', 'ff3'], expect: { q: 0 },
            say: '<p>d = {b:d}, en = 1, but no clock edge yet: q = {v:q}. Until the edge, the inputs only prepare.</p>' },
          { title: 'The edge', cycles: 1, show: ['ff0', 'ff1', 'ff2', 'ff3'], expect: { q: 5 },
            say: '<p>One rising edge: every flip-flop loads its bit of d at the same instant. q = {b:q}.</p>' },
          { title: 'en = 0: the word is kept', set: { d: 10, en: 0 }, cycles: 1, show: ['ff0', 'ff1', 'ff2', 'ff3'], expect: { q: 5 },
            say: '<p>d = {b:d} now, en = 0, another edge: each flip-flop reloads its own q. The register still holds {b:q}.</p>' },
          { title: 'en = 1: replaced', set: { en: 1 }, cycles: 1, expect: { q: 10 },
            say: '<p>en = 1 and the next edge: q = {b:q}. The old word is gone, all four bits at once.</p>' },
        ],
      },
      more: {
        derive: `<p>The register is q' = en ? d : q, bit by bit, at every rising edge. The word-level view hides the n copies of the multiplexer; the cost is linear in the width:
          NANDs(n) = n·${nands(DFFE)}, with no logic shared between bits.</p>`,
        real: `<p>Register files in real cores are not built from flip-flops: they use latch-based or SRAM-like cells with multiple ports, which are several times denser. A flip-flop register stays the
          choice for the program counter, pipeline registers and control state, where the value is needed at the edge and in several places.</p>`,
        pitfall: `<p>Thinking en = 1 stores the word. The register stores on a rising edge <em>with</em> en = 1; en alone moves nothing, and an edge alone with en = 0 reloads the old word. If a register
          never changes in a circuit, check both: is the clock reaching it, and is its enable high at the edge, not just at some other time?</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>NANDs</th><th>transistors</th></tr>
          ${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${nands(register(n))}</td><td>${stats(register(n)).transistors}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: register(4), inputs: { d: 0x5, en: 1, clk: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Store 0xA in the register, then change d to something else.',
        check: (st) => st.value('q') === 0xa && st.getInput('d') !== 0xa,
        hints: [
          'The register loads d only at a rising clock edge with en = 1.',
          'Once the word is stored, what keeps q from following d when it changes?',
        ],
        answer: 'd = 0xA, en = 1, Pulse; then set d to anything else (or en = 0 first).',
        solve: (st) => { st.setInputs({ d: 0xa, en: 1 }); st.pulse(); st.setInputs({ en: 0, d: 0 }); },
      },
    },
    {
      title: 'Wider words',
      body: `
        <p>An 8-bit register is the same picture with eight rows. Look at the cost in the Info tab: every bit of storage
        is ${nands(DFFE)} NANDs (${stats(DFFE).transistors} transistors) here. Real memories use cleverer cells, six transistors or even a single
        transistor and a capacitor (DRAM), which we will meet later.</p>
        <p>The 8-bit register is ${nands(register(8))} NANDs and ${stats(register(8)).transistors} transistors, against ${8 * 6} for eight 6-transistor cells: ten times as many. What
        the flip-flop buys is simplicity, a clean edge-triggered interface and an output that is always valid. What those cells buy is density, at the price of extra circuits to read them and a more careful
        timing. Both are used, and both appear in this book.</p>`,
      more: {
        derive: `<p>Cost per stored bit: ${nands(DFFE)} NANDs = a ${nands(DFF)}-NAND flip-flop + a ${nands(MUX2)}-NAND enable multiplexer. The flip-flop is two latches (${nands(D_LATCH)} NANDs each) and the clock inverter.
          Reading a register costs nothing extra (q is always there); writing costs the multiplexer.</p>`,
        real: `<p>A 6-transistor SRAM cell is two cross-coupled inverters and two access transistors; a DRAM cell is one transistor and a capacitor. Neither can drive other logic directly: a sense amplifier
          reads them. A later chapter builds both at switch level.</p>`,
        numbers: `<table class="mini"><tr><th>storage</th><th>transistors per bit</th></tr>
          <tr><td>flip-flop with enable (here)</td><td>${stats(DFFE).transistors}</td></tr>
          <tr><td>SRAM cell</td><td>6</td></tr><tr><td>DRAM cell</td><td>1 (plus a capacitor)</td></tr></table>`,
      },
      scene: () => ({ root: register(8), inputs: { d: 0x2a, en: 1, clk: 0 } }),
    },
    {
      title: 'A counter',
      body: `
        <p>Feed a <span data-show="reg">register</span>'s output through an <strong><span data-show="inc">incrementer</span></strong> (a chain of half adders that adds 1) and back into
        its input. Every clock edge, it loads its own value plus one: a <strong>counter</strong>.</p>
        <p>This loop of register → logic → register is the shape of every synchronous circuit, including a
        processor: the program counter is exactly this, plus the ability to jump.</p>
        <p>Cost: the register's ${nands(register(4))} NANDs plus the incrementer's ${nands(counter(4)) - nands(register(4))}, ${nands(counter(4))} for 4 bits. The incrementer is a half-adder chain, so
        its carry ripples: the slowest path between two edges is the carry from bit 0 to bit 3, and the clock period must cover it. A counter wraps at 2ⁿ: it counts 0 to 15 and
        then returns to 0, with no signal that it did.</p>
        <div class="try">The clock runs by itself (if you switched the automatic clock off, press <strong>Run</strong>): watch the count climb in the <strong>Timing</strong> panel. <strong>Pulse</strong> pauses it for one edge at a time.</div>`,
      tour: {
        beats: [
          { title: 'Counting', reset: true, cycles: 3, show: ['reg', 'inc'], expect: { q: 3 },
            say: '<p>Three edges from 0: each edge loads q + 1, q = {v:q}. The incrementer feeds the register its own next value.</p>' },
          { title: 'Enable off', set: { en: 0 }, cycles: 2, show: ['reg'], expect: { q: 3 },
            say: '<p>en = 0: two more edges, and the register reloads q = {v:q} each time. The incrementer still computes 4, but nobody loads it.</p>' },
          { title: 'Counting on', set: { en: 1 }, cycles: 12, show: ['reg', 'inc'], expect: { q: 15 },
            say: '<p>twelve more edges: q = {v:q} ({b:q}), every bit set.</p>' },
          { title: 'Wrap', cycles: 1, show: ['inc'], expect: { q: 0 },
            say: '<p>One more: 15 + 1 does not fit in 4 bits. The carry runs through the whole incrementer and falls off the top: q = {v:q}.</p>' },
        ],
      },
      more: {
        derive: `<p>Bit i of q + 1 flips exactly when all lower bits are 1: tᵢ = q₀·q₁·…·qᵢ₋₁, so qᵢ' = qᵢ ⊕ tᵢ. The incrementer is that rule as a chain of half adders, each passing its AND on to the next: a ripple
          through n − 1 gates, so the period grows with the width. A 32-bit counter built this way wants a faster carry (the fast adders of a later chapter apply directly).</p>`,
        real: `<p>Program counters, timers and address generators are counters, often with a load for jumps and a terminal-count output to flag the wrap. At 1 GHz a 32-bit counter wraps every
          ${(2 ** 32 / 1e9).toFixed(1)} s; a 64-bit one every ${Math.round(2 ** 64 / 1e9 / 3.156e7)} years, which is why a 64-bit cycle counter never needs a wrap check.</p>`,
        pitfall: `<p>Reading the count while it carries. Outputs q[3:0] settle one after another as the carry crosses the incrementer; a clocked consumer sees only settled values, but anything
          asynchronous (a ripple divider, an interrupt line) can catch 0111 → 1000 half done. Counters feeding other clock domains are converted to Gray code for that reason.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>NANDs</th><th>of which incrementer</th></tr>
          ${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${nands(counter(n))}</td><td>${nands(counter(n)) - nands(register(n))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: counter(4), inputs: { en: 1, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Stop the counter at exactly 9.',
        check: (st) => st.value('q') === 9 && st.getInput('en') === 0,
        hints: [
          'With en = 0 every edge reloads the value already held.',
          'Step one edge at a time with Pulse, and clear en while q reads 9.',
        ],
        answer: 'Pulse until q = 9, then set en = 0 so later clock edges change nothing.',
        solve: (st) => { st.setInputs({ en: 1 }); for (let i = 0; i < 32 && st.value('q') !== 9; i++) st.pulse(); st.setInputs({ en: 0 }); },
      },
    },
    {
      title: 'Asynchronous reset',
      body: `
        <p>At power-on every flip-flop holds whatever the race inside it produced. A chip needs a way to force a known state, and it
        must work before any clock runs. Give two NANDs of each latch a third input, <code>rst_n</code>: held low, it blocks the set side
        and forces the reset side, so q = 0 at once, clock or no clock. <span data-show="master slave">Both latches</span> of the flip-flop get it. The price: ${nands(DFF_R)} NANDs
        against the plain flip-flop's ${nands(DFF)}. That difference is the cost of the reset input on each latch.</p>
        <p>"Asynchronous" is the catch: releasing reset is itself an input change that can land right next to a clock edge. A flip-flop
        specifies a <strong>recovery time</strong> (rst_n high at least that long before the edge: reset's setup) and a <strong>removal
        time</strong> (its hold). Release inside that window and some flip-flops leave reset on this edge, others on the next, or one goes
        metastable. Real designs assert reset asynchronously but release it through a <strong>synchronizer</strong>: two flip-flops in
        series on the chip's clock, the first fed a constant 1, both cleared by the raw rst_n. Their output drops with rst_n at once, but
        rises only at a clock edge, so the rest of the chip leaves reset together. If the first flip-flop catches the release inside its
        window and goes metastable, it has a whole clock period to settle before the second samples it.</p>
        <div class="try">Clock a 1 in (d = 1, pulse), then pull rst_n low: q clears immediately, without a clock edge.</div>`,
      tour: {
        beats: [
          { title: 'Load a 1', set: { d: 1 }, cycles: 1, show: ['master', 'slave'], expect: { q: 1 },
            say: '<p>d = 1 and one edge: q = {v:q}, the ordinary way.</p>' },
          { title: 'Reset, no clock', set: { rst_n: 0 }, show: ['master', 'slave'], expect: { q: 0 },
            say: '<p>rst_n = 0 and no clock edge at all: both latches are forced, q = {v:q} at once.</p>' },
          { title: 'Clock ignored', cycles: 2, expect: { q: 0 },
            say: '<p>Two clock edges with d = {v:d} and rst_n still low: q = {v:q}. While reset is held, the clock has no say.</p>' },
          { title: 'Release', set: { rst_n: 1 }, cycles: 1, expect: { q: 1 },
            say: '<p>rst_n = 1, then an edge: the flip-flop works again and takes d: q = {v:q}. In a real design this release would arrive through the synchronizer, a clock edge before the rest of the chip.</p>' },
        ],
      },
      more: {
        derive: `<p>A flip-flop caught metastable is still undecided after a time t with probability ∝ e^(−t/τ) (chapter ${numOf('latches')}). The rate of failures
          is about f_clk · f_data · T₀ · e^(−t_r/τ), where f_data is how often the input changes, T₀ the window the cell is sensitive in, and
          t_r the time allowed to resolve: one clock period minus clk-to-q and setup. Every extra period multiplies the mean time between
          failures by e^(T/τ): with τ = 10 ps and a 1 ns clock, e^100 ≈ 10⁴³. So two flip-flops are the norm, three at high clock rates.
          The same synchronizer serves any single asynchronous bit (a button, an interrupt line, a flag from another clock domain); a
          multi-bit value needs more, since its bits may settle on different cycles: a handshake, a Gray-coded counter, an asynchronous FIFO.</p>`,
        real: `<p>Power-on reset is generated on chip: a voltage monitor holds rst_n low until the supply is stable and then releases it through the synchronizer. Synchronous reset (a gate in front of d,
          as the state machine below does) is the alternative: no recovery problem, but it needs a running clock and costs a gate per bit. Many designs use async assert and sync release.</p>`,
        pitfall: `<p>Driving rst_n from logic. A combinational signal can glitch, and a glitch low on an asynchronous reset clears the flip-flop for good. Resets should come from a flip-flop, or from a pin
          that is not part of any combinational network.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>NANDs</th><th>transistors</th></tr>
          <tr><td>D flip-flop</td><td>${nands(DFF)}</td><td>${stats(DFF).transistors}</td></tr>
          <tr><td>with asynchronous reset</td><td>${nands(DFF_R)}</td><td>${stats(DFF_R).transistors}</td></tr></table>`,
      },
      scene: () => ({ root: DFF_R, inputs: { d: 1, clk: 0, rst_n: 1 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Get q = 1 into the flip-flop, then clear it without touching the clock.',
        check: (st) => st.getInput('rst_n') === 0 && st.value('q') === 0 && st.getInput('d') === 1,
        hints: [
          'First get a 1 into q the normal way: through d and a rising edge.',
          'rst_n acts without the clock, and it is active low.',
        ],
        answer: 'd = 1, pulse the clock (q = 1), then rst_n = 0: q drops to 0 straight away, and stays 0 while rst_n is low.',
        solve: (st) => { st.setInputs({ d: 1, rst_n: 1 }); st.pulse(); st.setInputs({ rst_n: 0 }); },
      },
    },
    {
      title: 'T and JK',
      body: `
        <p>Two classic flip-flops are a <span data-show="ff">D flip-flop</span> with a little logic in front. The <strong>T</strong> (toggle) flip-flop loads
        t XOR q: with t = 1 it flips on every edge, which divides the clock by two. The <strong>JK</strong> flip-flop loads
        <span data-show="nq nk set keep o">j·¬q + ¬k·q</span>:
        j sets, k resets, both together toggle. It gives the SR latch's forbidden input a meaning.</p>
        <p>Textbooks built counters from them when flip-flops came in packages of two. On a chip, a D flip-flop plus logic is what synthesis
        produces anyway. The JK costs ${nands(JKFF)} NANDs here, against ${nands(DFF_R)} for the D flip-flop with reset it is built around: the extra logic is the price of the four-way behaviour.</p>`,
      tour: {
        beats: [
          { title: 'j = 1, k = 0: set', set: { j: 1, k: 0 }, cycles: 1, show: ['set', 'o', 'ff'], expect: { q: 1 },
            say: '<p>j = 1, k = 0, one edge: q = {v:q}. The flip-flop loads j·¬q + ¬k·q = 1.</p>' },
          { title: 'j = 0, k = 1: reset', set: { j: 0, k: 1 }, cycles: 1, show: ['keep', 'o', 'ff'], expect: { q: 0 },
            say: '<p>j = 0, k = 1: it loads 0. q = {v:q}.</p>' },
          { title: 'j = k = 1: toggle', set: { j: 1, k: 1 }, cycles: 1, show: ['nq', 'nk', 'set', 'keep', 'o'], expect: { q: 1 },
            say: '<p>Both: the new value is ¬q. q was 0, so q = {v:q} after one edge.</p>' },
          { title: 'Toggle again', cycles: 1, expect: { q: 0 },
            say: '<p>Another edge: q = {v:q}. With j = k = 1 the output flips on every edge: a divide by two.</p>' },
          { title: 'j = k = 0: hold', set: { j: 0, k: 0 }, cycles: 2, expect: { q: 0 },
            say: '<p>Neither: both terms are 0 or reload q, and two edges leave q = {v:q}.</p>' },
        ],
      },
      more: {
        derive: `<p>Characteristic equation: q' = j·¬q + ¬k·q. Check the four rows: j k = 00 gives q (hold); 01 gives 0 (reset); 10 gives 1 (set); 11 gives ¬q (toggle). The T flip-flop is j = k = t; the D flip-flop
          is j = d, k = ¬d.</p>`,
        real: `<p>The 7476 and 74112 were the standard JK parts of TTL logic. Modern designs, whether FPGA or ASIC, use D flip-flops almost exclusively: a JK's four-way behaviour is a multiplexer
          in front of a D, and a synthesis tool will make exactly that when it needs it.</p>`,
        pitfall: `<p>The old level-triggered JK latch had a famous trap: with j = k = 1 and the clock high for longer than a gate delay or two, q toggles more than once per pulse (race-around). The master–slave JK cured that but kept a flaw called "ones catching": a glitch on j or k during the high phase is remembered. Edge triggering, as here, fixes both: one toggle per rising edge, and you can see the one edge in the tour.</p>`,
      },
      scene: () => ({ root: JKFF, inputs: { j: 1, k: 1, clk: 0, rst_n: 1 } }),
    },
    {
      title: 'Counting both ways',
      body: `
        <p>Replace the incrementer with <span data-show="u3 u1">an adder/subtractor adding the constant 1</span>, its <code>sub</code> input driven
        by <span data-show="u0">NOT up</span>, and add <span data-show="u4">a multiplexer for a parallel load</span>. Now the counter counts up or down, and can be preset: the shape of a timer that counts down to zero
        from a loaded value.</p>
        <p>Subtracting 1 is adding the two's complement of 1, which the adder/subtractor does by inverting its b input and setting the carry-in: a − 1 = a + ¬1 + 1 = a + 0b1110 + 1 = a + 0b1111 (mod 16). So one adder serves both
        directions, with the direction input as its subtract control. The counter costs ${nands(upDownCounter(4))} NANDs against ${nands(counter(4))} for the plain 4-bit one: the adder/subtractor is bigger than the
        incrementer, and the load multiplexer adds a gate level per bit.</p>`,
      tour: {
        beats: [
          { title: 'Load 5', reset: true, set: { load: 1, d: 5 }, cycles: 1, show: ['u4', 'reg'], expect: { q: 5 },
            say: '<p>load = 1, d = {v:d}: the multiplexer ahead of the register chooses d instead of the adder, and one edge stores it. q = {v:q}.</p>' },
          { title: 'Count down', set: { load: 0, up: 0 }, cycles: 3, show: ['u0', 'u1', 'u3'], expect: { q: 2 },
            say: '<p>up = 0, three edges: up is inverted into sub, and the adder adds ¬1 + 1 each time. 5, 4, 3, 2: q = {v:q}.</p>' },
          { title: 'Count up', set: { up: 1 }, cycles: 4, show: ['u0', 'u3'], expect: { q: 6 },
            say: '<p>up = 1: sub = 0 and it adds 1. Four edges from 2: q = {v:q}.</p>' },
          { title: 'Stop', set: { en: 0 }, cycles: 2, expect: { q: 6 },
            say: '<p>en = 0: two edges reload the old value. q = {v:q} holds.</p>' },
        ],
      },
      more: {
        derive: `<p>The next-value logic is q + (up ? 1 : −1) = q + (up ? 0001 : 1111). In two's complement the adder/subtractor computes q + (b ⊕ sub) + sub, with b = 0001 and sub = ¬up: for sub = 1,
          q + 1110 + 1 = q + 1111. One adder, one XOR per bit on the constant, and no separate decrementer.</p>`,
        real: `<p>Down counters with a load are the heart of every hardware timer: load the period, count down, raise the interrupt at zero and reload. Up/down counters also drive FIFO fill levels and
          position decoders for rotary encoders.</p>`,
        pitfall: `<p>A down-counter does not stop at 0: it wraps to ${2 ** 4 - 1} (all ones), exactly as the up-counter wraps at 15 → 0. Timers detect the zero (a NOR of all bits) and use it to stop or reload; the wrap
          itself carries no signal. With en = 1 and load = 1 together, load and count compete and someone has to decide: here the load multiplexer wins.</p>`,
      },
      scene: () => ({ root: upDownCounter(4), inputs: { up: 0, en: 1, load: 0, d: 5, clk: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Load 5, then count down to 2 and stop.',
        check: (st) => st.value('q') === 2 && st.getInput('en') === 0 && st.getInput('load') === 0,
        hints: [
          'load = 1 copies d into the counter at the next edge.',
          'Counting down needs up = 0. Count the edges from 5 to 2, then stop with en.',
        ],
        answer: 'load = 1, d = 5, pulse; load = 0, up = 0, en = 1, pulse three times; en = 0.',
        solve: (st) => { st.setInputs({ load: 1, d: 5 }); st.pulse(); st.setInputs({ load: 0, up: 0, en: 1 }); for (let i = 0; i < 3; i++) st.pulse(); st.setInputs({ en: 0 }); },
      },
    },
    {
      title: 'Shift registers',
      body: `
        <p>Connect each <span data-show="ff0 ff1 ff2 ff3">flip-flop</span> to its neighbour instead of to an adder and the word moves one place per clock.
        <span data-show="m0 m1 m2 m3">A 4:1 multiplexer per bit</span>
        chooses: hold, shift right, shift left, or load in parallel (mode 0–3). Fed one bit at a time at <code>sr</code> (the serial input of a
        right shift; <code>sl</code> serves a left shift), it turns a serial
        stream into a parallel word; loaded in parallel and shifted, it does the reverse. That is the heart of every serial link: UART, SPI,
        PCIe lanes, the iterative multiplier and divider of <a href="#/c/muldiv/0">chapter ${numOf('muldiv')}</a>.</p>
        <p>Without the multiplexers a shift register is only flip-flops in a row, no logic at all: n stages delay a signal by exactly n clock cycles, and the only limit on the clock is clk-to-q
        plus setup. The four modes cost ${nands(shiftRegister(4))} NANDs for 4 bits against ${nands(register(4))} for the plain register: ${nands(shiftRegister(4)) - nands(register(4))} more for the four-way choice.</p>
        <div class="try">mode = 1 (shift right) with sr = 1: pulse four times and watch the ones march in from the top.</div>`,
      tour: {
        beats: [
          { title: 'First bit in', reset: true, set: { mode: 1, sr: 1 }, cycles: 1, show: ['m3', 'ff3'], expect: { q: 8 },
            say: '<p>mode = 1 shifts right: every bit moves one place towards bit 0, and sr enters at the top. Sending 1, 1, 0, 1 (first bit first): after the first edge q = {b:q}.</p>' },
          { title: 'Second bit', set: { sr: 1 }, cycles: 1, expect: { q: 12 },
            say: '<p>The 1 moved down, a new 1 entered: q = {b:q}.</p>' },
          { title: 'A zero', set: { sr: 0 }, cycles: 1, show: ['ff3', 'ff2'], expect: { q: 6 },
            say: '<p>sr = 0: the zero enters at the top and everything moves down: q = {b:q}.</p>' },
          { title: 'Last bit', set: { sr: 1 }, cycles: 1, expect: { q: 11 },
            say: '<p>Four edges, four bits: q = {b:q}. The first bit sent now sits in bit 0 and the last in bit 3. The word was assembled from a single wire.</p>' },
          { title: 'Hold', set: { mode: 0 }, cycles: 2, show: ['m0', 'm1', 'm2', 'm3'], expect: { q: 11 },
            say: '<p>mode = 0: every multiplexer feeds its own flip-flop back. Two edges, q = {v:q}.</p>' },
          { title: 'Parallel load', set: { mode: 3, d: 6 }, cycles: 1, show: ['m0', 'm1', 'm2', 'm3'], expect: { q: 6 },
            say: '<p>mode = 3 loads d = {b:d} in one edge: q = {b:q}. Shift it out with mode 1 and the word leaves one bit per edge: the reverse of what we did.</p>' },
        ],
      },
      more: {
        derive: `<p>Per bit the next value is a 4:1 choice: hold qᵢ, qᵢ₊₁ (right), qᵢ₋₁ (left) or dᵢ (load), with sr entering at bit n − 1 and sl at bit 0. A serial word of w bits takes w edges to assemble
          and w edges to send, so a link at f MHz carries f megabits per second per wire: the trade of parallel width for time that every serial interface makes.</p>`,
        real: `<p>UARTs, SPI and I²C controllers are shift registers with a state machine around them. Serial links such as PCIe use them too, at multi-gigabit rates, with dedicated serializer
          circuits where a multiplexer per bit would be too slow.</p>`,
        pitfall: `<p>Hold time. Each stage feeds the next directly, with only clk-to-q in between, so a shift register is the circuit most prone to hold violations when clocks arrive at slightly different times: a bit
          can race through two stages in one edge. Designers add delay or reorder the clock tree; the fix is never a slower clock.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>NANDs</th><th>plain register</th></tr>
          ${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${nands(shiftRegister(n))}</td><td>${nands(register(n))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: shiftRegister(4), inputs: { mode: 1, sr: 1, sl: 0, d: 0, clk: 0 }, autoClock: false }),
      tries: [(st) => st.value('q') === 0b1111],
      challenge: {
        kind: 'reach', goal: 'Send the serial bits 1, 0, 1, 1 (first bit first) in at sr so that q = 0b1101 at the end.',
        check: (st) => st.value('q') === 0b1101 && st.getInput('mode') === 1,
        hints: [
          'In mode 1 every edge moves each bit one place towards bit 0 and takes sr into bit 3.',
          'The first bit sent travels furthest: after four edges it sits in bit 0.',
        ],
        answer: 'Shifting right, the first bit ends up in q[0]: sr = 1, pulse; sr = 0, pulse; sr = 1, pulse; sr = 1, pulse. q = 1101 (bit 0 = the first bit sent).',
        solve: (st) => { st.setInputs({ mode: 1 }); for (const b of [1, 0, 1, 1]) { st.setInputs({ sr: b }); st.pulse(); } },
      },
    },
    {
      title: 'LFSR: cheap pseudo-random',
      body: `
        <p>Shift left, and feed back <span data-show="fb">the XOR of a few chosen bits</span> (the <em>taps</em>). With the right taps the
        <span data-show="reg">register</span> steps through every
        non-zero value, 2ⁿ − 1 of them, in an order that looks random. Here 4 bits and taps 4, 3: 15 states from one XOR gate.</p>
        <p>Why does a XOR of two bits visit every value? The feedback is a linear map over GF(2) (arithmetic on bits where 1 + 1 = 0); the taps are the exponents of a primitive polynomial (here x⁴ + x³ + 1), and a primitive polynomial makes
        the state a power of x in a field of 2ⁿ elements, whose powers cycle through every non-zero element. Choose the wrong taps and the sequence is shorter: the maximum is a property of the polynomial.</p>
        <p>Linear-feedback shift registers generate test patterns for chips (built-in self-test), scramble serial links so the signal has
        enough transitions, compute CRCs, and make noise. They are not secure random numbers: 2n consecutive outputs reveal the taps.</p>
        <div class="try">While load = 1 every edge loads the seed. Set load = 0 and let the clock run: the sequence repeats after 15 clocks. Try loading 0: it never leaves.</div>`,
      tour: {
        beats: [
          { title: 'Load the seed', reset: true, cycles: 1, show: ['mx', 'reg'], expect: { q: 1 },
            say: '<p>load = 1 and seed = {v:seed}: one edge puts the seed in the register, q = {b:q}. The feedback is being ignored.</p>' },
          { title: 'Run: four steps', set: { load: 0 }, cycles: 4, show: ['taps', 'fb', 'reg'], expect: { q: 3 },
            say: '<p>load = 0. Each edge shifts left and brings in the XOR of the two tap bits. After four edges q = {b:q} = {v:q}: pseudo-random already.</p>' },
          { title: 'Eleven more', cycles: 11, show: ['reg'], expect: { q: 1 },
            say: '<p>Eleven edges later, fifteen in all: q = {v:q}, the seed again. The register visited every non-zero 4-bit value exactly once before repeating.</p>' },
        ],
      },
      more: {
        derive: `<p>The next state is q' = (q ≪ 1) | (qₙ ⊕ qₜ), with n the top tap and t the other. Over GF(2) this is a linear map whose characteristic polynomial is x⁴ + x + 1, the reciprocal of the tap polynomial x⁴ + x³ + 1. Both are primitive (each divides x¹⁵ − 1 but no
          x^k − 1 for smaller k), so the period is exactly 2⁴ − 1 = ${2 ** 4 - 1}. The all-zero state is the only fixed point: 0 XOR 0 = 0, so a register that wakes up as 0 never starts.</p>`,
        real: `<p>CRC checksums are LFSRs fed by the data (Ethernet's CRC-32 is a 32-bit one). PRBS generators of 7, 15 or 31 bits test serial links; scramblers in PCIe and USB use them to avoid long runs of equal bits;
          GPS gives each satellite its own LFSR code.</p>`,
        pitfall: `<p>Starting from zero. An XOR-feedback LFSR locks up in the all-zero state, and a sequence that never leaves 0 is the symptom: seed it non-zero, or use the XNOR form, which locks up at all ones
          instead. Also, using the register's n bits as an n-bit random number gives successive values that are shifts of one another: take one output bit per step, or use a wider register.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>taps</th><th>states</th><th>NANDs</th></tr>
          ${[4, 8, 16].map((n) => `<tr><td>${n}</td><td>${LFSR_TAPS[n].join(', ')}</td><td>${groupDigits(2 ** n - 1)}</td><td>${nands(lfsr(n))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: lfsr(4), inputs: { load: 1, seed: 1, clk: 0 } }),
    },
    {
      title: 'Ring and Johnson counters',
      body: `
        <p>Close a <span data-show="reg">shift register</span> on itself and a single 1 circulates: a <strong>ring counter</strong>, n states from n flip-flops, already
        <em>one-hot</em> (exactly one bit is 1, so no decoder). <span data-show="inv">Invert the bit on its way round</span> and you get a <strong>Johnson counter</strong>: 2n states (0000, 0001, 0011, …,
        1111, 1110, …), only one bit changing per step, and each state is recognised by a single 2-input gate. Both trade flip-flops for
        decoding logic, which is why they show up in state machines and multiphase clocks.</p>
        <p>The Johnson trick is the single inverter: the 1s fill in from one end until the register is full, and then the inverted bit brings in zeros and empties it the same way. The state is
        recognised by looking at one place where the pattern changes (a 1 next to a 0, or the end), so each of the ${2 * 4} states needs one 2-input gate and no wide decoder.
        This 4-bit Johnson counter costs ${nands(ringCounter(4, true))} NANDs, against ${nands(counter(4))} for a binary counter that has 16 states and needs decoding on top.</p>
        <div class="try">While init = 1 every edge loads 0000 and the counter stands still. Set init = 0 and watch 0000, 0001, 0011, 0111,
        1111, then the zeros march in: 1110, 1100, … 8 states.</div>`,
      tour: {
        beats: [
          { title: 'Initial state', reset: true, cycles: 1, show: ['mx', 'reg'], expect: { q: 0 },
            say: '<p>init = 1: the register loads 0000 and stays. q = {b:q}.</p>' },
          { title: 'The first 1 enters', set: { init: 0 }, cycles: 1, show: ['inv', 'reg'], expect: { q: 1 },
            say: '<p>init = 0: the inverter turns the top bit\'s 0 into a 1 entering bit 0, shifted up by the other bits. q = {b:q}.</p>' },
          { title: 'Fill', cycles: 3, show: ['reg'], expect: { q: 15 },
            say: '<p>Three more edges, one more 1 each time: q = {b:q}. Four edges, four ones.</p>' },
          { title: 'Empty out', cycles: 2, expect: { q: 12 },
            say: '<p>Now the top bit is 1 and the inverter feeds in 0s: 1110, then q = {b:q}. The pattern empties from the same end it filled.</p>' },
          { title: 'Back to start', cycles: 2, show: ['inv'], expect: { q: 0 },
            say: '<p>Two more edges and q = {b:q}: 8 edges, 8 states, one bit changed per step. A glitch-free sequence at 2n states.</p>' },
        ],
      },
      more: {
        derive: `<p>An n-bit ring has n states and an n-bit Johnson counter 2n; a binary counter has 2ⁿ. The Johnson state k is recognised by one 2-input gate: for the fill phase, bit k − 1 = 1 and bit k = 0;
          for the empty phase, the reverse. Because exactly one bit changes per step, the decoded outputs cannot glitch, unlike a binary counter's.</p>`,
        real: `<p>Ring counters are the classic one-hot sequencers (the F, E, M, W steps of the campaign's multicycle core). Johnson counters drive multiphase clocks, stepper motors and display
          scanning, where glitch-free decoding matters more than the flip-flop count.</p>`,
        pitfall: `<p>Illegal states. Any n-bit register with fewer than 2ⁿ legal states can power up in an illegal one: in a ring counter, 0000 or two 1s, which then circulate forever. A self-correcting ring
          detects and fixes it, or the init input loads a legal state first, which is exactly what this scene's init does.</p>`,
        numbers: `<table class="mini"><tr><th>flip-flops</th><th>ring states</th><th>Johnson states</th><th>binary states</th></tr>
          ${[4, 8, 16].map((n) => `<tr><td>${n}</td><td>${n}</td><td>${2 * n}</td><td>${groupDigits(2 ** n)}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: ringCounter(4, true), inputs: { init: 1, clk: 0 } }),
      tries: [(st) => st.getInput('init') === 0 && st.value('q') === 0b1100],
    },
    {
      title: 'Dividing a clock',
      body: `
        <p>The simplest frequency divider is <span data-show="t0 t1 t2">a chain of toggle flip-flops</span>, each clocked by the output of the one before: output i runs at
        f / 2ⁱ⁺¹. It costs one flip-flop per halving and no adder at all.</p>
        <p>As a counter it is a poor one. Each stage switches one flip-flop delay after the previous, so after an edge the bits change one
        after another and the value is briefly wrong (watch the Timing panel). That is why the counters on this page share a single clock
        (synchronous), and why a ripple divider's outputs should not be used as clocks for logic that also sees the original one.</p>
        <p>The saving is real, though: the later stages switch rarely (stage i toggles at f / 2ⁱ), so however long the chain, it burns less than twice its first flip-flop. Three stages cost ${nands(clockDivider(3))} NANDs
        here, ${nands(clockDivider(3)) - nands(clockDivider(2))} for each added stage.</p>
        <div class="try">Release rst_n and let the clock run: the Timing panel shows each stage at half the rate of the one before.</div>`,
      tour: {
        beats: [
          { title: 'In reset', reset: true, show: ['t0', 't1', 't2'], expect: { q: 0 },
            say: '<p>rst_n = 0 holds every stage at 0: q = {b:q}.</p>' },
          { title: 'Four input edges', set: { rst_n: 1 }, cycles: 4, show: ['t0', 't1', 't2'], expect: { q: 4 },
            say: '<p>rst_n = 1 and four edges of clk. Stage 0 flipped four times, stage 1 twice, stage 2 once: q = {b:q} ({v:q}), the stages at f/2, f/4 and f/8. (The first edge takes 000 to 111: this chain counts down.)</p>' },
          { title: 'Four more', cycles: 4, show: ['t0', 't1', 't2'], expect: { q: 0 },
            say: '<p>Four more edges: q = {b:q}. One full cycle of the slowest stage takes eight input cycles.</p>' },
        ],
      },
      more: {
        derive: `<p>Each toggle flip-flop outputs half the frequency of its clock: f_i = f / 2ⁱ⁺¹. Delays add: stage i changes after i·t_cq, so the bits of a ripple count change in sequence, not together, and for
          a moment the word shows a value that was never the count. The settling time is n·t_cq, against one t_cq for a synchronous counter.</p>`,
        real: `<p>A 32 768 Hz watch crystal divided by 2¹⁵ (${2 ** 15}) gives exactly 1 Hz: fifteen ripple stages, in every quartz watch. At those rates the delay does not matter, and a ripple divider is
          the cheapest and lowest-power way to count.</p>`,
        pitfall: `<p>Using a stage output as the clock for other logic. Its edge arrives i·t_cq after the master clock's, a skew that moves the setup and hold windows, and the static timing tools then see
          a generated clock to treat as such. A synchronous counter with an enable (a clock-enable pulse every 2ⁱ cycles) keeps one clock domain instead.</p>`,
        numbers: `<table class="mini"><tr><th>stage</th><th>output frequency from 32 768 Hz</th></tr>
          ${[0, 1, 2, 7, 14].map((i) => `<tr><td>${i}</td><td>${groupDigits(32768 / 2 ** (i + 1))} Hz</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: clockDivider(3), inputs: { clk: 0, rst_n: 0 }, analyzer: true }),
    },
    {
      title: 'State machines',
      body: `
        <p>A counter is a register whose next value is a fixed function of its value. Let that function read inputs too and you have a
        <strong>finite-state machine</strong>: a state register, next-state logic, output logic. It is how hardware runs a sequence (a divider's
        iterations, a memory refill, the steps of a CPU that spends several cycles per instruction in <a href="#/c/multicycle/0">chapter ${numOf('multicycle')}</a>).</p>
        <p>The design is mechanical. Recognise 1, 0, 1 on a serial input x, overlaps included: S0 has seen nothing useful, S1 a 1, S2 a 1 then
        a 0. Draw the transitions, encode the states in two flip-flops (s1 s0 = 00, 01, 10), write the table:</p>
        <table class="cmp fsm-tt"><thead><tr><th>s1 s0</th><th>x</th><th>n1 n0</th><th>y</th></tr></thead><tbody>
          <tr><td>00</td><td>0</td><td>00</td><td>0</td></tr><tr><td>00</td><td>1</td><td>01</td><td>0</td></tr>
          <tr><td>01</td><td>0</td><td>10</td><td>0</td></tr><tr><td>01</td><td>1</td><td>01</td><td>0</td></tr>
          <tr><td>10</td><td>0</td><td>00</td><td>0</td></tr><tr><td>10</td><td>1</td><td>01</td><td>1</td></tr></tbody></table>
        <p>Code 11 never occurs, so it is a don't care: <span data-show="g0 n0"><code>n0 = x</code></span>,
        <span data-show="g1 h1 k1 n1"><code>n1 = ¬x·s0</code></span>, and the output <span data-show="yn yg"><code>y = x·s1</code></span>, each next
        bit ANDed with ¬rst for a synchronous reset. <span data-show="s0 s1">Two ${nands(RV16_DFF)}-NAND flip-flops</span>
        (the ${nands(RV16_DLATCH)}-NAND latch from the Derivation layer of <a href="#/c/latches/2">chapter ${numOf('latches')}'s D latch step</a>, as the campaign builds them) and ${nands(DET101) - 2 * nands(RV16_DFF)} NANDs of logic make the whole machine.</p>
        <p>y reads x directly: a <strong>Mealy</strong> output. It rises in the same cycle as the last 1 of the pattern, before the edge that takes the machine on, which is one cycle
        earlier than a state-only output could manage.</p>
        <p>The sandbox does all of this for you: <a href="#/sandbox/new/fsm">open the detector as a state-machine chip</a>, draw on its
        diagram (add the Moore S3, say) and it rebuilds the circuit, each encoding priced, the next-state logic a truth-table chip with its
        Karnaugh map one double-click down.</p>
        <p>The diagram is drawn from the same table as the circuit, and a test reads the circuit back into it state by state. Hover an arc to light
        the gates that make that transition. <a href="#/c/fsm/0">Chapter ${numOf('fsm')}</a> takes the method apart: Moore or Mealy, the cost of each state code, unused states, a controller steering registers and an adder.</p>
        <div class="try">Set x and pulse: 1, 0, 1. Watch the dashed arc move when you flip x before the edge.</div>`,
      tour: {
        label: 'Walk me through it (a 1, 0, 1 and an overlap)',
        beats: [
          { title: 'Reset: S0', reset: true, set: { rst: 1, x: 0 }, cycles: 1, show: ['s0', 's1'], expect: { y: 0 },
            say: '<p>rst = 1 and one edge: both state bits cleared, S0. y = {v:y}.</p>' },
          { title: 'A 1: S1', set: { rst: 0, x: 1 }, cycles: 1, show: ['g0', 'n0', 's0'], expect: { y: 0 },
            say: '<p>x = 1, one edge: n0 = x = 1 sets s0. The machine saw the first 1 and is in S1. y = {v:y}: y = x·s1 and s1 = 0.</p>' },
          { title: 'A 0: S2', set: { x: 0 }, cycles: 1, show: ['g1', 'h1', 'k1', 'n1', 's1'], expect: { y: 0 },
            say: '<p>x = 0: n1 = ¬x·s0 = 1 sets s1 and clears s0. S2: "1, 0 seen". y = {v:y} still, because x is 0.</p>' },
          { title: 'The last 1', set: { x: 1 }, show: ['yn', 'yg', 's1'], expect: { y: 1 },
            say: '<p>x = 1 <em>before</em> the edge: y = x·s1 = {v:y} at once. A Mealy output moves with the input; the pattern is reported in the cycle it completes.</p>' },
          { title: 'The edge: overlap', cycles: 1, show: ['g0', 'n0', 's0'], expect: { y: 0 },
            say: '<p>The edge takes the machine to S1 (the last 1 also starts the next pattern) and y falls to {v:y}. Overlapping matches are why S2 goes to S1 on a 1, not back to S0.</p>' },
          { title: 'And again', set: { x: 0 }, cycles: 1, expect: { y: 0 },
            say: '<p>x = 0, one edge: S2 again after a 1 and a 0. Set x = 1 and y rises once more: the 1, 0, 1, 0, 1 stream matched twice with only three 1s.</p>' },
        ],
      },
      more: {
        derive: `<p>From the table: n0 is 1 on every row with x = 1 and 0 on every row with x = 0, so n0 = x. n1 is 1 only at s1 s0 = 01 with x = 0, and the unused 11 is a don't care that lets us drop s1:
          n1 = ¬x·s0. The output is 1 at 10 with x = 1; 11 is a don't care again, so y = x·s1. With don't cares the logic is ${nands(DET101) - 2 * nands(RV16_DFF)} NANDs; without them, each next bit would need to
          distinguish more rows.</p>
          <p>A <strong>Moore</strong> output depends on the state alone: add S3 "saw 101" with
          y = 1 there (it still fits in two flip-flops, 11 is free) and the detection comes a cycle later, but clean. The Mealy y follows x, glitches
          included, so whatever reads it must sample it at the clock edge.</p>`,
        real: `<p>Two flip-flops for three states is a dense (binary) encoding. <strong>One-hot</strong> gives each state its own flip-flop
          (S0, S1, S2 = 001, 010, 100): one more flip-flop here, but each next-state bit is just the OR of the arcs entering that state,
          and every state test reads one flip-flop with no decoding. For the detector: S1' = x (every 1 leads to S1), S2' = ¬x·S1,
          S0' = ¬x·(S0 + S2), y = x·S2. The costs: reset must set S0 rather than clear everything, and an upset (a particle strike) that makes two bits hot is a state the
          logic never planned for. FPGAs, rich in flip-flops, encode machines one-hot by default; ASIC flows weigh flip-flops against
          logic per machine. A ring counter is a one-hot machine with no inputs, and the campaign's multicycle core steps through F, E, M, W
          one-hot.</p>`,
        pitfall: `<p>Unreachable states are not harmless. Code 11 is a don't care, so the logic does whatever is cheapest there: from 11 the next state is (¬x, x), S1 or S2, so this machine recovers by itself, but y = x·s1 = x
          can pulse once on the way. A machine whose unused codes lead to other unused codes can lock up for good after a glitch on power-up; check the don't-care states, or send them to reset (the "safe" option of the sandbox's state-machine chip).</p>`,
      },
      scene: () => ({
        root: DET101, inputs: { x: 1, rst: 0, clk: 0 }, autoClock: false,
        panels: [fsmPanel(DET101_FSM, { parts: true, ribbon: [{ label: 'x', path: 'x' }, { label: 'state', path: 'state' }, { label: 'y', path: 'y' }] })],
      }),
      challenge: {
        kind: 'reach', goal: 'From reset, make the detector report the pattern (y = 1).',
        check: (st) => st.value('y') === 1,
        hints: [
          'y = x·s1: the output needs state S2 (s1 = 1) and x = 1 at the same time.',
          'Reach S2 with the pattern\'s first two bits, one per clock edge, then set x before the next edge.',
        ],
        answer: 'Two edges: x = 1 (S0 → S1), x = 0 (S1 → S2), then set x = 1: y = x·s1 is 1 before the third edge.',
        solve: (st) => {
          for (const x of [1, 0]) { st.setInputs({ x }); st.runCycles(1); }
          st.setInputs({ x: 1 });
        },
      },
    },
  ],
};

export const chMemory: Chapter = {
  id: 'memory', num: numOf('memory'), title: 'Memory arrays', level: 'Memory',
  blurb: 'Many registers, one address: decoders write, multiplexers read. Then ROM, PLA, FIFO, stack, CAM and extra ports.',
  goals: [
    'build a RAM from registers, a decoder with enable to write and a multiplexer tree to read',
    'say what doubling the number of words costs: an address bit, a bigger decoder, a deeper mux tree',
    'drop the flip-flops for a ROM, and say when a PLA is cheaper',
    'pick a FIFO, a stack or a CAM for a job, and name the trick each relies on',
  ],
  builds: ['registers', 'routing'],
  recap: {
    keep: [
      'A RAM is registers plus a decoder with enable (write: one word\'s load enable, at the clock edge) and a multiplexer tree (read: asynchronous, no clock). 4 words × 4 bits: 306 NANDs.',
      'Each doubling of the words adds an address bit, a decoder input and a mux level. 64 × 16 bits in flip-flops is about 80 000 transistors: why real memories use cells of six transistors, or of one transistor and a capacitor.',
      'A ROM keeps the decoder and puts the data in the wiring: output bit j is the OR of the word lines whose bit j is 1. A PLA builds only the product terms the outputs need: the 7-segment font in 164 NANDs against 313 as a ROM.',
      'FIFO: a circular buffer with read and write pointers, one extra pointer bit telling full from empty. Stack: one pointer, the top at slot sp − 1.',
      'A CAM compares the key with every entry at once and priority-encodes the matches; a comparator per entry keeps CAMs small. Each extra port costs another mux tree (read) or decoder (write).',
    ],
    practise: ['m_ram', 'm_rf'],
    check: [
      {
        question: 'A RAM grows from 16 to 32 words of 8 bits. What happens to its read path?',
        options: ['Each bit\'s mux tree gains one level: 5 instead of 4', 'The number of levels doubles', 'Nothing: the read path depends on the width', 'It now waits for the clock'],
        answer: 0,
        explain: 'The tree has log₂(words) levels: one more address bit, one more level of 2:1 muxes. The width sets how many trees run side by side.',
        why: ['', 'Levels grow with the address bits, log₂ of the words: doubling the words adds one level.', 'The width sets how many mux trees run side by side; the number of words sets how deep each one is.', 'Reading stays asynchronous at any size; only writes wait for the edge.'],
      },
      {
        question: 'A 4-word FIFO has 3-bit pointers. The write pointer is 0b110 and the read pointer 0b010. Is it empty, full or neither?',
        options: ['Full', 'Empty', 'Neither: two words are held'],
        answer: 0,
        explain: 'The low two bits name the same slot (2); the extra bit differs, so the writer is a whole lap ahead: four words held.',
        why: ['', 'Empty needs all three bits equal. The extra bit differs: the writer is a lap ahead.', 'Both pointers name slot 2, and 6 − 2 = 4 words: the whole capacity.'],
      },
      {
        question: 'When is a PLA cheaper than a ROM for the same function?',
        options: ['When the outputs need few product terms, each with few inputs', 'Always: it is a ROM with fewer gates', 'When the contents must change after manufacture', 'When every input pattern gives a different output'],
        answer: 0,
        explain: 'A ROM decodes every input pattern. A PLA pays per product term, so it wins when the minimized function has few, small terms (the 7-segment font: 28 terms of 2 or 3 inputs).',
        why: ['', 'Not always: the PLA pays per product term, and a function needing many wide terms can cost more than the full decoder a ROM shares among all its outputs.', 'Both are wired when built here. Rewritable contents need cells that store each connection as charge, as flash does.', 'Then every input pattern needs its own term: the PLA rebuilds a full decoder and saves nothing.'],
      },
    ],
  },
  steps: [
    {
      title: 'Four words, one address',
      body: `
        <p>A memory is a <span data-show="w0 w1 w2 w3">stack of registers</span> plus two pieces of plumbing you already know:</p>
        <ul><li>The <strong>write path</strong>: <span data-show="dec">a decoder with enable</span> turns <code>addr</code> and <code>we</code> (write enable) into one
        word's load-enable. On the clock edge, only that word loads <code>din</code>.</li>
        <li>The <strong>read path</strong>: <span data-show="rmux">a multiplexer tree</span> uses <code>addr</code> to pick one word for <code>dout</code>.</li></ul>
        <p>The panel at the bottom right shows every stored bit live.</p>
        <p>Cost, from the parts: four 4-bit registers (${4 * nands(register(4))} NANDs), the decoder (${nands(decoder(2, true))}) and the read tree (${nands(muxTree(2, 4))}) make ${4 * nands(register(4)) + nands(decoder(2, true)) + nands(muxTree(2, 4))} NANDs,
        the ${nands(ram(2, 4))} the Info tab shows. The registers dominate, and the plumbing is the memory's whole
        "address" idea: one decoder to choose a word to write, one tree to choose a word to read, shared by every bit.</p>`,
      more: {
        derive: `<p>For 2ᵏ words of w bits: storage 2ᵏ·w·${nands(DFFE)} NANDs; write decoder with enable about 2ᵏ·(k + 1) gate inputs; read tree w·(2ᵏ − 1) two-input multiplexers of ${nands(MUX2)} NANDs.
          The k-dependence is in the decoder and the tree, and both are small next to the storage until the words are few.</p>`,
        real: `<p>A real SRAM array is built the same way at the level of ideas: a row decoder selects a word line, the cells in that row put their bits on the bit lines, and a column multiplexer and sense
          amplifiers read them. The registers become 6-transistor cells and the multiplexer tree becomes a bit-line structure, a later chapter's subject.</p>`,
        pitfall: `<p>One address serves both paths here. A write at the clock edge changes the word dout is showing, just after the edge; before the edge dout shows the old word. Memories with separate read and write
          addresses need two decoders and a rule for what a read of the word being written returns.</p>`,
      },
      scene: () => ({ root: ram(2, 4), inputs: { addr: 1, din: 0x9, we: 0, clk: 0 }, panels: [memGridPanel] }),
    },
    {
      title: 'Writing',
      body: `
        <p>To write: set <code>addr</code>, put the value on <code>din</code>, set <code>we = 1</code>, and <strong>Pulse</strong> the clock.
        The addressed row turns orange in the panel: it will be written on the next rising edge.</p>
        <p>Nothing is stored until the edge. Before it, the decoder has raised exactly one word's load-enable and every other word's is 0, so only the selected word's multiplexers pass din; after it, that word
        holds din and the decoder's line can fall. Each flip-flop in a word does this itself: the memory has no special write circuit.</p>
        <div class="try">Write 0x2 to address 0 and 0x5 to address 3. Open <span data-show="dec"><code>dec</code></span> while <code>we = 1</code> to see exactly one enable line high.</div>`,
      tour: {
        beats: [
          { title: 'Before the edge', reset: true, set: { addr: 0, din: 2, we: 1 }, show: ['dec'], expect: { dout: 0 },
            say: '<p>addr = {v:addr}, din = {v:din}, we = 1. The decoder raises word 0\'s enable, but nothing is stored yet: dout = {v:dout}.</p>' },
          { title: 'The edge', cycles: 1, show: ['w0'], expect: { dout: 2 },
            say: '<p>One rising edge: word 0 loads din. dout reads address 0, so it now shows {v:dout}.</p>' },
          { title: 'Another address', set: { addr: 3, din: 5 }, show: ['dec', 'w3'], expect: { dout: 0 },
            say: '<p>addr = 3, din = 5: the decoder moves its enable to word 3. dout shows word 3, still empty: {v:dout}.</p>' },
          { title: 'The edge', cycles: 1, show: ['w3'], expect: { dout: 5 },
            say: '<p>One edge: word 3 holds {v:dout}. Word 0 was not touched.</p>' },
          { title: 'Read back address 0', set: { addr: 0, we: 0 }, show: ['w0', 'rmux'], expect: { dout: 2 },
            say: '<p>we = 0 and addr = 0: dout = {v:dout}. The first write survived; the second went to a different row.</p>' },
        ],
      },
      more: {
        derive: `<p>Timing of a write: addr, din and we must be stable a setup time before the rising edge, and held a hold time after it, so that the decoder's output, the multiplexer in front of the selected
          flip-flops and the flip-flops themselves all see a clean value. The decoder is part of this path: its depth adds to the time addr needs, which is why a larger memory has a longer write setup.</p>`,
        real: `<p>Real SRAMs register the write address and data on the edge and then do the write in the second half of the cycle, with a self-timed pulse on the word line. Writes are the one memory
          operation with a hard timing window, and most memory bugs are about breaking it.</p>`,
        pitfall: `<p>Changing addr while we = 1. The decoder is combinational, so for a moment during the change two enables can be high (a glitch). A flip-flop only samples at the edge, so a glitch away from the edge
          is harmless, but one that coincides with the edge writes a second word. Hence the rule of setup and hold: keep addr and we steady around the edge.</p>`,
      },
      scene: () => ({ root: ram(2, 4), inputs: { addr: 0, din: 0x2, we: 1, clk: 0 }, panels: [memGridPanel], highlight: ['dec'] }),
      challenge: {
        kind: 'reach', goal: 'Store 0x2 at address 0 and 0x5 at address 3.',
        check: (st) => word(st, 0) === 0x2 && word(st, 3) === 0x5,
        hints: [
          'A write needs addr, din and we = 1, then a rising clock edge.',
          'One word per edge: change addr and din between the two Pulses.',
        ],
        answer: 'addr = 0, din = 0x2, we = 1, Pulse; then addr = 3, din = 0x5, Pulse.',
        solve: (st) => { st.setInputs({ addr: 0, din: 2, we: 1 }); st.pulse(); st.setInputs({ addr: 3, din: 5 }); st.pulse(); st.setInputs({ we: 0 }); },
      },
    },
    {
      title: 'Reading',
      body: `
        <p>Reading needs no clock. Change <code>addr</code> and <code>dout</code> follows immediately (after a few gate
        delays through <span data-show="rmux">the multiplexer tree</span>). That is <em>asynchronous</em> read, like the processor's register
        file will use.</p>
        <p>Note that <code>we = 0</code> protects the contents: pulse the clock as often as you like.</p>
        <p>The delay is the depth of the tree: ${logicDepth(muxTree(2, 4))} NAND delays for these four words, and one more level of multiplexers for each doubling of the words. Because the tree is just logic, it never
        changes the stored words, and any number of readers could watch it at once; only a write needs the clock.</p>`,
      tour: {
        label: 'Walk me through it (fill, then read)',
        beats: [
          { title: 'Fill the memory', reset: true, set: { addr: 0, din: 3, we: 1 }, cycles: 1, show: ['w0'], expect: { dout: 3 },
            say: '<p>Four writes first: address 0 gets {v:din}. dout shows what addr 0 holds: {v:dout}.</p>' },
          { title: '… and the rest', set: { addr: 1, din: 7 }, cycles: 1, show: ['w1'], expect: { dout: 7 },
            say: '<p>Address 1 gets {v:din}: dout = {v:dout}.</p>' },
          { title: 'Third word', set: { addr: 2, din: 12 }, cycles: 1, expect: { dout: 12 } , say: '<p>Address 2 gets {v:din}: dout = {v:dout}.</p>' },
          { title: 'Fourth word', set: { addr: 3, din: 10 }, cycles: 1, expect: { dout: 10 }, say: '<p>Address 3 gets {v:din}. Now turn the writes off.</p>' },
          { title: 'Read: no clock', set: { we: 0, addr: 1 }, show: ['rmux'], expect: { dout: 7 },
            say: '<p>we = 0, addr = 1: dout = {v:dout} straight away, with no clock edge. The tree only selects.</p>' },
          { title: 'Another address', set: { addr: 3 }, show: ['rmux'], expect: { dout: 10 },
            say: '<p>addr = 3: dout = {v:dout}. Any address, any time.</p>' },
          { title: 'Clocks cannot hurt', cycles: 4, expect: { dout: 10 },
            say: '<p>Four clock edges with we = 0: dout = {v:dout}. A write needs we = 1 <em>and</em> an edge.</p>' },
        ],
      },
      more: {
        derive: `<p>The read path is a tree of 2:1 multiplexers on the address bits: level j is selected by addr bit j, and a word-wide tree for each of the w bits. The delay is ${logicDepth(muxTree(2, 4))} for two address bits;
          each added bit adds one multiplexer's data-to-output delay (2 NANDs): the deepest path is the first level's select, then data through the rest. The decoder plays no part in a read.</p>`,
        real: `<p>Register files read asynchronously, as here: the operand is needed in the same cycle as the address. Large SRAMs read synchronously: the address is latched on the edge and the data appears a
          cycle later, which lets the array's slow bit-line sensing take its time. That one cycle of latency is why a cache's hit time is not one cycle.</p>`,
        pitfall: `<p>Reading the address being written. The write takes effect at the edge, so before the edge dout shows the old word; after it, the new one. A pipeline that reads and writes the same register in
          one cycle must decide whether the read should see the new value: that is the bypass (forwarding) of a later chapter, not something the memory does for you.</p>`,
      },
      scene: () => ({ root: ram(2, 4), inputs: { addr: 2, din: 0, we: 0, clk: 0 }, panels: [memGridPanel], highlight: ['rmux'] }),
    },
    {
      title: 'Scale it up',
      body: `
        <p>The same three parts scale to any size. Pick a size in the panel. The address grows one bit each time
        the number of words doubles, and so does <span data-show="dec">the decoder</span> and the depth of <span data-show="rmux">the mux tree</span>.</p>
        <p>Watch the transistor count in the Info tab: a 64 × 16 memory built this way already needs about ${groupDigits(Math.round(stats(ram(6, 16)).transistors / 1000) * 1000).replace(',', ' ')} transistors. That is why real memories use dense custom cells: a phone's 16 GB of DRAM is ${(16 * 2 ** 30 * 8 / 1e11).toFixed(1)} × 10¹¹ bits, each one transistor and a
        capacitor. Stored at ${stats(DFFE).transistors} transistors a bit, as here, it would take ${Math.floor(16 * 2 ** 30 * 8 * stats(DFFE).transistors / 1e12)} × 10¹² transistors.</p>
        <p>The cost splits between storage and plumbing, and the split hardly moves: the table in <em>Numbers</em> shows the stored bits taking close to four fifths at every size, because the read tree adds nearly one
        multiplexer per stored bit. The delay, on the other hand, grows with every added address bit.</p>`,
      more: {
        derive: `<p>For 2ᵏ words of w bits the storage is 2ᵏ·w·${nands(DFFE)} NANDs. The decoder with enable costs about 2ᵏ AND gates of k + 1 inputs and the read tree w·(2ᵏ − 1) multiplexers of ${nands(MUX2)} NANDs, which comes to nearly one
          multiplexer (${nands(MUX2)} NANDs) per stored bit against ${nands(DFFE)} for the bit itself: a quarter or so on top, at every size. Cost is linear in the bits; delay is linear in k.</p>`,
        real: `<p>A phone's memory is DRAM at one transistor and a capacitor per bit, or SRAM at six transistors for caches. Both have sense amplifiers and bit-line structures that the registers here do without,
          and both split the array into banks so that no word line or bit line is long.</p>`,
        pitfall: `<p>Counting only gates. In a real memory the wires matter more than the logic: the delay of a word line or bit line grows with its length, and a naive 2ᵏ-to-1 tree puts a wire the length of the array
          on the critical path. Banking trades extra decoders for shorter wires.</p>`,
        numbers: `<table class="mini"><tr><th>words × bits</th><th>NANDs</th><th>transistors</th><th>of it storage</th><th>read tree depth</th></tr>
          ${([[2, 4], [3, 8], [4, 8], [5, 16], [6, 16]] as const).map(([k, w]) => `<tr><td>${2 ** k} × ${w}</td><td>${groupDigits(nands(ram(k, w)))}</td><td>${groupDigits(stats(ram(k, w)).transistors)}</td><td>${Math.round(100 * 2 ** k * w * nands(DFFE) / nands(ram(k, w)))} %</td><td>${logicDepth(muxTree(k, w))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: ram(4, 8), inputs: { addr: 0, din: 0x42, we: 1, clk: 0 }, panels: [memSizePanel, memGridPanel] }),
      challenge: {
        kind: 'reach', goal: 'In a memory with at least 16 words, store 0x2A at address 13.',
        check: (st) => (st.rootCtx?.node.children?.size ?? 0) >= 18 && word(st, 13) === 0x2a,
        hints: [
          'The memory on the stage already has 16 words; a bigger one works too.',
          'Write as before: address, data, write enable, then one rising edge.',
        ],
        answer: 'With 16 words or more: addr = 13, din = 0x2A, we = 1, Pulse.',
        solve: (st) => { st.setInputs({ addr: 13, din: 0x2a, we: 1 }); st.pulse(); },
      },
    },
    {
      title: 'Read-only memory',
      body: `
        <p>If the contents never change, the flip-flops can go. <span data-show="u0">A decoder</span> raises one word line; output bit j is
        <span data-show="u1 u3 u4 u5 u6 u7 u8">the OR of the word lines</span>
        of every word whose bit j is 1. The data is in the wiring. Mask ROMs were made exactly like this, the pattern set by one metal layer;
        a fuse PROM (programmable ROM) blows the unwanted connections once; flash keeps the same array but stores each connection as charge, so it can be rewritten.</p>
        <p>This one holds the squares of 0–15. The CPU's instruction memory in <a href="#/c/cpu/0">chapter ${numOf('cpu')}</a> is a ROM too (built there from constants and a
        multiplexer tree, the read port's view of the same thing).</p>
        <p>Compare the cost with a RAM of the same size: ${nands(romArray('squares'))} NANDs for 16 words of 8 bits, against ${nands(ram(4, 8))} for a RAM of that shape. A ROM has no flip-flops, no write path and no clock; what remains is the decoder and a few
        OR gates, and its read is purely combinational.</p>
        <div class="try">Set addr = 7: data = 0x31 = 49. Open the decoder, then one of the OR gates, and count its inputs.</div>`,
      tour: {
        beats: [
          { title: 'Address 3', set: { addr: 3 }, show: ['u0'], expect: { data: 9 },
            say: '<p>addr = 3: the decoder raises word line 3, and each output bit ORs the lines of the words that have it set. data = {v:data} = {b:data}: 3² = 9.</p>' },
          { title: 'Address 7', set: { addr: 7 }, expect: { data: 49 },
            say: '<p>addr = 7: data = {v:data} = {b:data}. Seven squared, from wiring alone.</p>' },
          { title: 'Address 15', set: { addr: 15 }, expect: { data: 225 },
            say: '<p>addr = 15: data = {v:data} = {b:data}, the largest entry. Each of its set bits is an OR gate that word line 15 reaches.</p>' },
          { title: 'Address 0', set: { addr: 0 }, expect: { data: 0 },
            say: '<p>addr = 0: no OR gate sees word line 0 at all (0² has no ones), so data = {v:data}.</p>' },
        ],
      },
      more: {
        derive: `<p>Word i has data[i]; the output bit j is OR over {i : bit j of data[i] = 1} of line i. For the squares, bit 0 of n² equals bit 0 of n, so its OR collects the eight odd lines; bit 1 of n² is always 0, so its OR gate is empty and is simply a
          constant.</p>`,
        real: `<p>Mask ROM: the pattern is a metal or contact layer, fixed at manufacture; cheap per bit but costs a mask set. PROM and fuse ROMs are written once; EPROM, EEPROM and flash trap charge on a floating gate and can be rewritten, flash a block at a time.
          Boot code, microcode, font tables and the lookup tables of an FPGA are all this structure.</p>`,
        pitfall: `<p>Thinking a ROM is free hardware. Its cost is the decoder, 2ᵏ word lines with a gate each, and the cost grows with the number of words even if few of them contain any ones. For sparse functions a PLA, next, is cheaper.</p>`,
      },
      scene: () => ({ root: romArray('squares'), inputs: { addr: 3 } }),
      tries: [(st) => st.getInput('addr') === 7 && st.value('data') === 0x31],
      challenge: {
        kind: 'quiz', question: 'Output bit 0 of the squares ROM has an OR gate with eight inputs. Why eight?',
        options: ['n² is odd exactly when n is odd, and 8 of the 16 addresses are odd', 'Every output bit uses half the words', 'A 4-bit address needs 8 lines', 'It is a coincidence'],
        answer: 0,
        why: ['', 'Not every bit: bit 1 of n² is always 0, so its OR gate is gone. Bit 0 happens to be 1 for exactly the odd n.', 'A 4-bit address decodes into 16 word lines. The OR takes only the lines of words whose bit 0 is 1.', 'It follows from arithmetic: odd times odd is odd, and even times anything is even.'],
        explain: 'Bit 0 of n² equals bit 0 of n: the OR collects the word lines of 1, 3, 5, …, 15. Other bits use other subsets (bit 1 of n² is always 0, so its OR gate disappears entirely).',
      },
    },
    {
      title: 'The PLA',
      body: `
        <p>A ROM decodes every possible input, even when the function only cares about a few patterns. A <strong>programmable logic array</strong>
        keeps the two planes but makes the first one flexible: true and <span data-show="u1 u2 u3 u4">complemented input rails</span>, an AND plane that builds only the product
        terms the outputs need, and an OR plane that sums them. The terms here come from Quine–McCluskey minimization, run when the page loads.</p>
        <p>The 7-segment font needs ${plaTerms(PLA_PRESETS.seg7).terms.length} terms (more than the ROM's 16 words, because the seven outputs share few of them), but each term is a
        2- or 3-input AND, so the PLA costs ${nands(pla('seg7'))} NANDs against ${nands(romArray('seg7'))} for the ROM. Early microprocessors decoded instructions with PLAs (the 6502's
        decode ROM is one), and PALs, GALs and CPLDs are their field-programmable descendants. The other branch is the lookup table of an <span data-ahead="fpga">FPGA (a chip of small tables and switches whose
        function is loaded as configuration bits; chapter ${numOf('fpga')} puts our computer on one)</span>: a tiny ROM, 16 or 64 SRAM bits read by a mux tree on its inputs.</p>
        <div class="try">Set x to 0–15 and read y as segments a (bit 0) to g (bit 6). Open <span data-show="u5">a term</span>, then
        <span data-show="u33">an output's OR gate</span>.</div>`,
      more: {
        derive: `<p>A ROM spends one AND of all the address bits per word, ${2 ** 4} here. The PLA spends one AND per <em>product term</em>, ${plaTerms(PLA_PRESETS.seg7).terms.length}, each over only the inputs the term depends on, found by merging adjacent minterms
          (Quine–McCluskey, chapter ${numOf('logic')}'s Karnaugh idea mechanized). The saving is the wide ANDs: ${nands(romArray('seg7'))} → ${nands(pla('seg7'))} NANDs.</p>`,
        real: `<p>Early CPUs decoded instructions through PLAs (the 6502's decode ROM is one); modern designs let synthesis tools do the same minimization on any logic. In an FPGA the same function sits in lookup tables:
          a k-input LUT is a 2ᵏ-bit ROM read by a tree of multiplexers, which is why 4- and 6-input LUTs are the standard sizes.</p>`,
        pitfall: `<p>A PLA wins for functions that need few, small terms. A function whose every minterm is a separate term, like a random truth table, makes the AND plane a full decoder and the PLA no cheaper than a ROM, plus
          the cost of the complement rails. Compare the two for the function at hand, not in general.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>NANDs</th><th>transistors</th></tr>
          <tr><td>ROM (16 words × 7)</td><td>${nands(romArray('seg7'))}</td><td>${stats(romArray('seg7')).transistors}</td></tr>
          <tr><td>PLA (${plaTerms(PLA_PRESETS.seg7).terms.length} terms)</td><td>${nands(pla('seg7'))}</td><td>${stats(pla('seg7')).transistors}</td></tr></table>`,
      },
      scene: () => ({ root: pla('seg7'), inputs: { x: 5 } }),
    },
    {
      title: 'FIFO',
      body: `
        <p>A <strong>first-in first-out</strong> queue decouples a producer from a consumer: a UART receiving bytes faster than software reads
        them, a processing stage that sometimes has to wait. Here, four words in registers, written through <span data-show="dec">a decoder</span> at
        the <span data-show="wp">write pointer</span> and read
        through <span data-show="rdp">a multiplexer</span> at the <span data-show="rp">read pointer</span>. Both pointers only ever count up,
        wrapping around: a <em>circular buffer</em>.</p>
        <p>The trick is one extra pointer bit. Equal pointers mean <span data-show="emp">empty</span>; same slot but different extra bit means the
        writer is a full lap ahead: <span data-show="fl">full</span>. Without it, full and empty would look the same.</p>
        <p>This FIFO costs ${nands(fifo(2, 8))} NANDs for 4 words of 8 bits, of which ${4 * 8 * nands(DFFE)} are the stored bits: the rest is the two pointers, the write decoder, the read multiplexer and the flag logic. A FIFO has no addresses on its
        interface: the order is the address.</p>
        <div class="try">push = 1: pulse with din = 0x11, 0x22, 0x33. Then push = 0, pop = 1: dout shows 0x11 first.</div>`,
      tour: {
        beats: [
          { title: 'Push', reset: true, set: { push: 1, pop: 0, din: 0x11 }, cycles: 1, show: ['dec', 'wp'], expect: { empty: 0, full: 0, dout: 0x11 },
            say: '<p>push = 1, din = 0x11, one edge: the write pointer moves on and the FIFO is no longer empty (empty = {v:empty}). dout shows the oldest word, {v:dout}.</p>' },
          { title: 'Second word', set: { din: 0x22 }, cycles: 1, show: ['wp'], expect: { dout: 0x11 },
            say: '<p>0x22 goes in the next slot. dout is still the oldest word: {v:dout}.</p>' },
          { title: 'Third word', set: { din: 0x33 }, cycles: 1, show: ['wp', 'rp'], expect: { dout: 0x11, empty: 0 },
            say: '<p>0x33 behind it. Three words held; the read pointer has not moved, so dout = {v:dout}.</p>' },
          { title: 'Pop', set: { push: 0, pop: 1 }, cycles: 1, show: ['rp', 'rdp'], expect: { dout: 0x22 },
            say: '<p>pop = 1, one edge: the read pointer moves to the next slot. dout = {v:dout}. First in, first out.</p>' },
          { title: 'Drain it', cycles: 2, show: ['emp', 'rp', 'wp'], expect: { empty: 1 },
            say: '<p>Two more pops: the read pointer catches the write pointer, and empty = {v:empty}.</p>' },
        ],
      },
      more: {
        derive: `<p>With 2ᵏ slots the pointers have k + 1 bits. The slot is the low k bits; empty is wp = rp; full is wp and rp equal in the low k bits and different in the top bit. Used words: (wp − rp) mod 2ᵏ⁺¹, between 0 and 2ᵏ.
          Without the extra bit the same pointer values mean both "no words" and "all words".</p>`,
        real: `<p>When the producer and consumer have different clocks (a network port feeding a CPU), the pointers cross clock domains. They are sent in Gray code, so that only one bit changes at a time and a sample
          taken during the change is at worst one step old, never garbage. This is the asynchronous FIFO, a standard block of every interface.</p>`,
        pitfall: `<p>dout shows the word at the read pointer even when the FIFO is empty: it is stale data, not a valid word. The consumer must look at empty, not at dout. Likewise a push while full is refused by the logic, but the
          producer has to notice, or the word is lost.</p>`,
        numbers: `<table class="mini"><tr><th>slots × bits</th><th>NANDs</th><th>of which storage</th></tr>
          ${([[2, 8], [3, 8], [4, 8], [4, 32]] as const).map(([k, w]) => `<tr><td>${2 ** k} × ${w}</td><td>${groupDigits(nands(fifo(k, w)))}</td><td>${groupDigits(2 ** k * w * nands(DFFE))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: fifo(2, 8), inputs: { push: 1, pop: 0, din: 0x11, clk: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Fill the FIFO until full = 1.',
        check: (st) => st.value('full') === 1,
        hints: [
          'Each Pulse with push = 1 and pop = 0 stores one word.',
          'How many slots does this FIFO have?',
        ],
        answer: 'push = 1, pop = 0, pulse four times (any data). A fifth push is refused.',
        solve: (st) => { st.setInputs({ push: 1, pop: 0 }); for (let i = 0; i < 4; i++) { st.setInputs({ din: 0x11 * (i + 1) }); st.pulse(); } },
      },
    },
    {
      title: 'Stack',
      body: `
        <p>Swap the queue's discipline for <strong>last-in first-out</strong> and one pointer is enough: <span data-show="sp">the stack pointer</span> counts the words held.
        Push writes at slot sp and increments it; pop decrements it; <span data-show="rdp">the top is slot sp − 1</span>. Some CPUs keep a small hardware stack of return addresses, to guess where a function will return to; the program's call stack is the same idea kept in memory, with sp in a register (x2 in RISC-V).</p>
        <p>One pointer instead of two, but the read side is not free: the top is slot sp − 1, so every read passes through a decrement before the multiplexer, which makes the top slower to reach than a FIFO's head, whose read
        pointer is already the address. The stack costs ${nands(stack(2, 8))} NANDs for 4 words of 8 bits, the FIFO ${nands(fifo(2, 8))}.</p>`,
      tour: {
        beats: [
          { title: 'Push 0x0A', reset: true, set: { push: 1, pop: 0, din: 0x0a }, cycles: 1, show: ['sp'], expect: { top: 0x0a, empty: 0 },
            say: '<p>push = 1: 0x0A is written at slot sp = 0 and sp moves to 1. The top is slot sp − 1: top = {v:top}.</p>' },
          { title: 'Push 0x0B', set: { din: 0x0b }, cycles: 1, show: ['sp', 'rdp'], expect: { top: 0x0b },
            say: '<p>0x0B goes in slot 1, sp = 2. The top is now {v:top}; 0x0A is underneath.</p>' },
          { title: 'Pop', set: { push: 0, pop: 1 }, cycles: 1, show: ['sp', 'rdp'], expect: { top: 0x0a },
            say: '<p>pop = 1: sp falls back to 1, so the top is slot 0 again: {v:top}. The last word in came out first.</p>' },
          { title: 'Pop again', cycles: 1, show: ['sp'], expect: { empty: 1 },
            say: '<p>One more pop: sp = 0, and empty = {v:empty}.</p>' },
        ],
      },
      more: {
        derive: `<p>Slots 0 to 2ᵏ − 1, pointer sp from 0 to 2ᵏ (k + 1 bits, as the FIFO's pointers): push writes slot sp, then sp ← sp + 1; pop does sp ← sp − 1; top = slot[sp − 1]. Empty is sp = 0, full is sp = 2ᵏ.
          An incrementer and a decrementer (an adder-subtractor with sub tied high, which also gives the top's address) take the place of the FIFO's two incrementers, with a mux to choose.</p>`,
        real: `<p>A CPU's call stack lives in ordinary memory with sp in a register; a hardware stack is used where the depth is small and the speed matters: a CPU's return-address stack (its guess of where a function returns), the 4-bit CPU's three-level stack, a
          floating-point register stack (x87). The depth is fixed, so overflow has to be defined by the design.</p>`,
        pitfall: `<p>Underflow and overflow. A pop on an empty stack or a push on a full one needs a rule: ignore it, wrap, or fault. A hardware stack that wraps silently gives wrong return addresses a depth later, a bug that is hard
          to see where it happens.</p>`,
      },
      scene: () => ({ root: stack(2, 8), inputs: { push: 1, pop: 0, din: 0x0a, clk: 0 }, autoClock: false }),
      challenge: {
        kind: 'reach', goal: 'Push 0x0A then 0x0B, then pop once: the top should be 0x0A again.',
        check: (st) => st.value('top') === 0x0a && st.value('empty') === 0 && st.getInput('pop') === 1 && st.getInput('push') === 0,
        hints: [
          'push writes at slot sp and moves sp up; pop moves it down.',
          'The goal wants pop = 1 and push = 0 at the end: switch both before the last edge.',
        ],
        answer: 'push = 1: din = 0x0A, pulse; din = 0x0B, pulse. Then push = 0, pop = 1, pulse: top = 0x0A.',
        solve: (st) => { st.setInputs({ push: 1, pop: 0, din: 0x0a }); st.pulse(); st.setInputs({ din: 0x0b }); st.pulse(); st.setInputs({ push: 0, pop: 1 }); st.pulse(); },
      },
    },
    {
      title: 'Content-addressable memory',
      body: `
        <p>An ordinary memory answers "what is at this address?". A <strong>CAM</strong> answers "where is this value?". Each entry gets
        <span data-show="u10 u11 u12 u13">its own comparator</span>, all comparing with the key at the same time, and
        <span data-show="u19">a priority encoder</span> (<a href="#/c/routing/6">chapter ${numOf('routing')}</a>) turns the matches into hit and index.
        A valid bit per entry keeps never-written entries from matching.</p>
        <p>One comparator per entry is why CAMs stay small: an address-translation table has tens of entries and a fast buffer that may keep any line in any slot a few
        hundred lines at most. A network router's lookup table is the big exception, and burns power accordingly.</p>
        <p>The search takes no clock and no sequencing: all entries compare in parallel, so the lookup time is one comparator plus one priority encoder, and only the encoder's log n grows with the entries. What grows is the area: this CAM has four 4-bit entries and costs ${nands(cam(2, 4))} NANDs,
        of which a comparator alone is ${nands(equal(4))}.</p>`,
      tour: {
        beats: [
          { title: 'Searching an empty CAM', reset: true, set: { we: 0, key: 9 }, show: ['u10', 'u11', 'u12', 'u13'], expect: { hit: 0 },
            say: '<p>key = 9 against four entries, none valid yet: hit = {v:hit}. The valid bits keep zeroed entries from matching a key of 0 either.</p>' },
          { title: 'Write 9 into entry 2', set: { we: 1, waddr: 2, wdata: 9 }, cycles: 1, show: ['u19'], expect: { hit: 1, index: 2 },
            say: '<p>One edge with we = 1 stores the word and sets its valid bit. The key is still 9, so the comparator of entry 2 fires: hit = {v:hit}, index = {v:index}.</p>' },
          { title: 'Another key', set: { we: 0, key: 3 }, show: ['u10', 'u11', 'u12', 'u13'], expect: { hit: 0 },
            say: '<p>key = 3: nothing stored matches, hit = {v:hit}. The search is combinational: it follows the key as it changes.</p>' },
          { title: 'Write 3 into entry 0', set: { we: 1, waddr: 0, wdata: 3 }, cycles: 1, expect: { hit: 1, index: 0 },
            say: '<p>Entry 0 now holds 3: hit = {v:hit}, index = {v:index}.</p>' },
          { title: 'Both searchable', set: { we: 0, key: 9 }, expect: { hit: 1, index: 2 },
            say: '<p>Back to key = 9: index = {v:index}. Two entries, two comparators, one answer at once.</p>' },
        ],
      },
      more: {
        derive: `<p>Entry i matches when valid[i] ∧ (entry[i] = key); hit is the OR of the matches and the index comes from the priority encoder over them. Cost: n comparators of ${nands(equal(4))} NANDs (width 4) plus n·w flip-flops
          plus the encoder: each entry pays for a comparator on top of the register a plain register file would spend. Lookup delay is independent of n except for the encoder's log n.</p>`,
        real: `<p>CAM cells in network switches search millions of entries in one cycle, for IP routing, at a power cost that dominates the chip. In a CPU the CAM is the TLB and the tag array of fully associative
          caches; the comparison of 64 entries at once is why the TLB is small.</p>`,
        pitfall: `<p>Duplicates. If two entries hold the same key, two comparators fire, and the priority encoder reports only one (the highest). Software or the write logic must prevent duplicates or define which wins,
          otherwise a stale entry can shadow a newer one.</p>`,
      },
      scene: () => ({ root: cam(2, 4), inputs: { we: 1, waddr: 2, wdata: 9, key: 9, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Store 9 in entry 2, then search for 9: hit = 1, index = 2.',
        check: (st) => st.value('hit') === 1 && st.value('index') === 2 && st.getInput('key') === 9,
        hints: [
          'Writing an entry takes we, waddr, wdata and a rising clock edge.',
          'A search takes no clock: the key is compared with every valid entry all the time.',
        ],
        answer: 'we = 1, waddr = 2, wdata = 9, pulse; we = 0; key = 9.',
        solve: (st) => { st.setInputs({ we: 1, waddr: 2, wdata: 9 }); st.pulse(); st.setInputs({ we: 0, key: 9 }); },
      },
    },
    {
      title: 'Ports cost area',
      body: `
        <p>The register bank of <a href="#/c/regfile/0">chapter ${numOf('regfile')}</a> has two read ports and one write port: enough for one instruction per cycle. A core that issues two
        instructions per cycle needs four reads and two writes. Each read port is another multiplexer tree over every register; each write port
        another decoder, plus a multiplexer in front of every register to choose which port wins.</p>
        <p>Each port adds its own plumbing over the same storage: ${groupDigits(nands(regfileMP(5, 32, 4, 2)))} NANDs for 4 reads and 2 writes of 32 × 32 bits, against ${groupDigits(nands(regfileMP(5, 32, 2, 1)))} for 2 reads and 1 write
        (${(nands(regfileMP(5, 32, 4, 2)) / nands(regfileMP(5, 32, 2, 1))).toFixed(1)} times for twice the ports). These general files store all 32 registers; chapter ${numOf('regfile')}'s keeps x0 at 0 with no flip-flops, so its 2-read, 1-write file is ${groupDigits(nands(regfile(5, 32)))}. In silicon each port also lengthens every bit's wires, so the real cost grows faster.</p>`,
      more: {
        derive: `<p>With R read and W write ports on N registers of w bits: storage N·w·${nands(DFFE)} NANDs (fixed), read side R·w·(N − 1) multiplexers, write side W decoders plus a W:1 choice per register. The ports grow the plumbing with R and W,
          not the storage.</p>`,
        real: `<p>A real register file cell grows in both directions with each port: one more word line and one more pair of bit lines, so area goes roughly as the square of the port count. That is why wide cores split the
          register file into banks, or use a clustered design, instead of adding ports.</p>`,
        pitfall: `<p>Two write ports can write the same register in one cycle. Someone has to decide which wins (the younger instruction, by convention) and the hardware that decides is the multiplexer in front of every register.</p>`,
        numbers: `<table class="mini"><tr><th>ports (read / write)</th><th>NANDs (32 × 32)</th></tr>
          ${([[2, 1], [4, 1], [4, 2]] as const).map(([r, w]) => `<tr><td>${r} / ${w}</td><td>${groupDigits(nands(regfileMP(5, 32, r, w)))}</td></tr>`).join('')}</table>`,
      },
      widget: portCost,
    },
    {
      title: 'Memory in rings of iron',
      body: `
        <p>Before the one-transistor cell, the memory of the 1950s and 60s was a plane of <strong>ferrite cores</strong>: rings of dark ceramic about two millimetres across, each holding one bit as the direction its magnetisation circulates. Whirlwind got the first core storage in August 1953: banks of 32 × 32 × 17 cores, ${groupDigits(32 * 32)} words of 16 bits and a parity bit. A core has a nearly square hysteresis loop: below its switching current <em>I</em><sub>c</sub> it does not move, at or above it it flips completely.</p>
        <p>The address needs no decoder inside the array. One X wire and one Y wire each carry half the current that flips a core, so only the core where they cross sees the whole of it: the <strong>coincident-current</strong> scheme of Forrester's patent. Every other core on those two wires sees half and holds, and that margin is the whole design.</p>
        <p>Reading is destructive. The cycle drives the addressed core toward 0; if it held a 1 it flips, and its magnetism reversing (a change of flux) induces a pulse on the <strong>sense wire</strong> through all cores; if it held 0 nothing moves and the wire stays quiet. A second phase writes the bit back: it drives the addressed core toward 1. To write or restore a 0, the <strong>inhibit wire</strong> carries half the current the other way, so the crossing core sees half and keeps its 0. Compared with the flip-flop RAM above, a bit costs no transistor at all: it is a ring, and the select drivers and the <span data-ahead="senseamp">sense amplifiers (the circuits that turn the sense wire's faint pulse into a clean bit)</span> are shared by the whole plane. The price was that every read had to be followed by a write.</p>`,
      more: {
        real: `<p>Cores of the early planes were about 80 mil (2 mm) outside; by 1966 they were down to 13 mil (0.33 mm), and the CDC 6600 (1964) had a core cycle of 1 µs; Whirlwind's core read-and-rewrite cycle took about 9 µs. Planes were often wired with three wires (sense and inhibit sharing one) and the sense wire ran diagonally through the cores so that the noise of half-selected cores cancelled; the model here draws four wires, its sense wire on the diagonals as Whirlwind's planes ran it (MIT Report R-221, 1954).</p>`,
        pitfall: `<p>Assuming a core is a perfect switch. A half-select current still nudges a real core's flux a little, and thousands of them on one wire add up to noise on the sense wire that the signal has to be picked out of; the square loop in the model below is the idealisation.</p>`,
      },
      widget: () => core3d(),
    },
    {
      title: 'A core plane, wired',
      body: `
        <p>The plane of the last step, as a circuit you can run. The store holds ${CORE_WORDS} words of ${CORE_PLANES} bits in ${CORE_PLANES} planes of 4 × 4 cores, one plane per bit. Plane 0 is open: an X line along each row, a Y line down each column (<span data-show="sx sy">each two wires, one for reads and one for writes</span>), and one inhibit wire and one sense wire through all sixteen cores. A word is one core per plane, at the same row and column.</p>
        <p>Each core follows the square loop of the last step, counted in half-selects: a write half +1, a read half −1, the inhibit −1. At ±2 it switches; anything less, it holds. Click <b>Read</b> in the panel. Word 6 is row 1, column 2, so those two lines carry read halves, and <span data-show="c12">the core where they cross</span> sees −2 and switches to 0; the six other cores on the two lines see −1 and keep their bits. A plane where the word held a 1 gets a pulse on <span data-show="pin:s">its sense wire</span>; the edge that ends READ is the strobe that loads the buffer register from the four sense wires.</p>
        <p>The word now sits only in the buffer, so WRITE puts it back: write halves on the same two lines, with <span data-show="pin:inh">the inhibit</span> carrying a half the other way in every plane whose buffer bit is 0, so that core sees +1 and stays 0. A write of new data is the same two phases, with the new data in the buffer. Every access is read, then write: two clocks here.</p>
        ${readCycleFigure()}
        <div class="try">Switch the inhibit drivers off in the panel, write 0000 into word 1 and read it back: what does every write become without the inhibit?</div>
        <p>The cores cost nothing in gates: ${groupDigits(stats(CORE_STORE).cores ?? 0)} rings, no transistor. The drivers, decoders, registers and phase control around them are ${groupDigits(nands(CORE_STORE))} NANDs, against ${groupDigits(nands(ram(4, 4)))} for a 16 × 4 flip-flop RAM built like the one at the start of this chapter, where every bit is a flip-flop. The periphery is shared: double the words and the cores double, while the decoders grow by a few gates per address bit.</p>`,
      lit: '',
      tour: {
        label: 'Walk me through a read cycle',
        beats: [
          { title: 'READ', reset: true, at: ['p0'], set: { addr: 6, we: 0, go: 1 }, cycles: 1, show: ['c12'], expect: { phase: 1 },
            say: '<p>The store took address 6 and is in READ. Row 1 and column 2 carry read halves; core c12 sees two of them, the others on those lines one. Word 6 holds 1011, so this plane\'s core is switching and its sense wire carries the pulse.</p>' },
          { title: 'The strobe', set: { go: 0 }, cycles: 1, show: ['c12'], expect: { phase: 2, dout: 0b1011 },
            say: '<p>The edge that ended READ loaded the buffer from the sense wires: {b:dout}. Core c12 holds 0 now, as do word 6\'s cores in the other planes: the read destroyed the word.</p>' },
          { title: 'WRITE', at: [], show: ['inh0', 'inh1', 'inh2', 'inh3'], expect: { phase: 2 },
            say: '<p>WRITE: write halves on the same lines. Bit 2 of the buffer is 0, so plane 2\'s inhibit is on: its core will see one half and stay 0. The other three planes\' cores see two and switch back to 1.</p>' },
          { title: 'Back where it was', cycles: 1, expect: { phase: 0, dout: 0b1011 },
            say: '<p>The edge that ended WRITE put the word back: word 6 holds 1011 again. Two clocks, and the store is idle.</p>' },
          { title: 'A write without the inhibit', at: ['p0'], set: { addr: 1, din: 0, we: 1, go: 1, inhOn: 0 }, cycles: 1, expect: { phase: 1 },
            say: '<p>Now write 0000 into word 1 with the inhibit drivers switched off. READ first, as always: a write empties the word too.</p>' },
          { title: 'Every bit set', set: { go: 0 }, cycles: 2, expect: { phase: 0, dout: 0 },
            say: '<p>The buffer held 0000, but nothing held the cores back: every core of word 1 saw two write halves and switched to 1.</p>' },
          { title: 'Read it back', set: { we: 0, go: 1, inhOn: 1 }, cycles: 1, expect: { phase: 1 },
            say: '<p>Read word 1 to see what it holds.</p>' },
          { title: '1111', set: { go: 0 }, cycles: 2, expect: { phase: 0, dout: 0b1111 },
            say: '<p>{b:dout}: without the inhibit a core store can only write ones. The inhibit is how a 0 is written.</p>' },
        ],
      },
      more: {
        derive: `<p>Why half-selects: a core switches at the crossing of two lines because each line carries half the switching current, so the selected core sees a full current and the
          ${2 * (4 - 1)} others on its two lines see half. With n × n cores, 2n lines with a read and a write driver each, 4n drivers, select any of n² bits, and every plane of the stack shares them.
          The inhibit works the same way in reverse: one more wire through every core of a plane, carrying a half against the write, chosen per plane, so one word's bits are written
          by one X line, one Y line and a set of inhibit wires.</p>`,
        real: `<p>Whirlwind stacked 17 planes of 32 × 32; the strobe also fell inside the read current: in the core test of MIT Report R-221 it was a ${R221.strobeUs} µs pulse about ${R221.strobeAtUs} µs into the sense pulse, well within the ${R221.readUs} µs read, and its whole read-and-rewrite cycle took about ${R221.cycleUs} µs. Core memory held its place into the 1970s, helped by that sharing of the periphery.</p>
          <p>Whirlwind's two banks were 32 × 32 × 17, with ${R221.readA} A on each selected X and Y line (R-221, section 5, calls each a selection plane: the line runs through every digit plane). The first bank was installed on 8 August 1953, with a cycle time of about 9 µs against about 25 µs for the electrostatic storage tubes it replaced
          (Project Whirlwind Summary Report 35). The sense signal was about ${R221.senseV} V and ${R221.senseUs} µs long, and Whirlwind's sense wire already ran on the diagonals so that
          half-selected cores' small pulses cancelled. Later planes shared one wire for sense and inhibit, and the cycle fell to about 1 µs by the mid-1960s.</p>`,
        pitfall: `<p>Reading the simulation as the physics. Here a half-selected core gives no pulse at all; a real one moves its flux a little and adds a small pulse to the sense wire, and
          thousands of them on a large plane are the noise the sense amplifier had to reject. The model leaves that noise out (we have no measured size for it to model from), so its
          sense wire is a clean OR of the cores that switched.</p>`,
      },
      tries: [(st) => { const v = coreView(st); return !!v && v.phase === 0 && v.words[1] === 0b1111 && v.buf === 0b1111; }],
      challenge: {
        kind: 'reach',
        goal: 'Catch word 13 read out: its cores all 0, the buffer holding what they held.',
        check: (st) => { const v = coreView(st), t = coreTaken(st); return !!v && !!t && v.phase === 2 && v.addr === 13 && t.addr === 13 && v.words[13] === 0 && v.buf === t.word; },
        hints: [
          'A read takes two clocks. After which of them are the cores empty while the buffer is full?',
          'Pick word 13, click Read, then Next phase once, and stop.',
        ],
        answer: 'Pick word 13, Read, and clock once more (Next phase): the edge that ends READ switched every 1 of word 13 to 0 and strobed the sense wires into the buffer. Until the edge that ends WRITE, the buffer is the only copy.',
        solve: (st) => { const a = coreActions(st); if (coreView(st)?.phase) a?.finish(); a?.inhibit(true); a?.start(13, false); a?.phase(); },
      },
      scene: () => coreScene({ path: ['p0'], highlight: ['c12'] }),
    },
  ],
};
