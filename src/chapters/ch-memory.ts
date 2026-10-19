import { cam, fifo, pla, romArray, stack, clockDivider, counter, DFF, DFF_R, DFFE, D_LATCH, JKFF, lfsr, ram, register, ringCounter, shiftRegister, SR_LATCH, upDownCounter } from '../lib';
import { DET101, DET101_FSM, RV16_DFF, RV16_DFFE, RV16_DLATCH } from '../lib';
import { stats } from '../sim/stats';
import { pack } from '../sim/values';
import { fsmPanel } from '../widgets/fsmpanel';
import { memGridPanel } from '../widgets/memgrid';
import { memSizePanel } from '../widgets/memsize';
import { portCost } from '../widgets/storage';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;

/** Value currently stored in word i of a RAM scene. */
function word(st: Stage, i: number): number {
  const n = st.rootCtx?.node.children?.get(`w${i}`);
  return n ? pack(st.rootCtx!.sim.getBits(n.ports.q)) : -1;
}

export const chLatches: Chapter = {
  id: 'latches', num: 8, title: 'Memory from feedback', level: 'Sequential logic',
  blurb: 'Loop a gate\'s output back to its input and it starts to remember.',
  goals: [
    'store a bit in two cross-coupled NANDs, and say what the forbidden input does to them',
    'explain metastability: a balanced latch that noise resolves, in a time with no upper bound',
    'derive a D latch from the SR latch, transparent while its enable is 1',
    'build an edge-triggered flip-flop from two latches, state its setup, hold and clock-to-q times, and give it a load enable',
  ],
  builds: ['gates'],
  recap: {
    keep: [
      `Feedback makes memory. Two cross-coupled NANDs (an SR latch, ${nands(SR_LATCH)} NANDs) set on s_n = 0, reset on r_n = 0 and hold with both at 1.`,
      'Both inputs low gives q = q̄ = 1. Released together, the pair balances at its metastable point: noise picks the winner, and the time it takes has no bound (P(undecided after t) ∝ e^(−t/τ)).',
      `D latch (${nands(D_LATCH)} NANDs): d and ¬d drive set and reset, gated by e, so the forbidden input cannot occur. Transparent while e = 1, closed while e = 0. Taking r_n = NAND(s_n, e) drops the inverter: ${nands(RV16_DLATCH)} NANDs.`,
      `D flip-flop (${nands(DFF)} NANDs, ${nands(RV16_DFF)} with the ${nands(RV16_DLATCH)}-NAND latch): a master latch open while clk is low, a slave open while it is high. q changes only at the rising edge.`,
      'The timing contract: d settled a setup time before the edge, held a hold time after it; q follows clk-to-q later. Period ≥ clk-to-q + slowest logic + setup.',
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
        options: ['The master: d flows into it while the slave holds q', 'The slave', 'Both', 'Neither'],
        answer: 0,
        explain: 'The master follows d while the clock is low. At the rising edge it closes on d, and the slave opens to show it.',
        why: ['', 'The slave is open while clk is high: it shows what the master caught at the rising edge.', 'Then d would race straight through to q. The opposite enables exist to prevent exactly that.', 'One of the two is always open; the edge is the instant they swap.'],
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
        <p><span data-show="g1 g2">Two cross-coupled NANDs</span> form an <strong>SR latch</strong>. Its inputs are <em>active-low</em> (the bar over
        the name means "acts when 0"):</p>
        <ul><li>pull <code>s_n</code> to 0 → <strong>set</strong>: q becomes 1</li>
        <li>pull <code>r_n</code> to 0 → <strong>reset</strong>: q becomes 0</li>
        <li>both at 1 → <strong>hold</strong>: q keeps whatever it was. One bit of memory.</li></ul>
        <div class="try">Set the latch (pulse s_n to 0 and back to 1), then notice q stays 1 with both inputs at 1.</div>`,
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
        (chapter 9's synchronizer). Here the simulator detects the oscillation and settles the pair arbitrarily, in no time; in silicon
        the resolution takes time, usually little, occasionally a lot.</p>`,
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
        <details class="deeper"><summary>Deeper: a latch in ${nands(RV16_DLATCH)} NANDs, a flip-flop in ${nands(RV16_DFF)}</summary>
        <p><span data-show="inv">The inverter on d</span> is not needed. <span data-show="g1">g1</span> already computes s_n = NAND(d, e),
        which is ¬d while e = 1. Feed it to <span data-show="g2">g2</span> in place of ¬d: r_n = NAND(NAND(d, e), e). While e = 1,
        r_n = d, so d = 0 resets as before; while e = 0, s_n = r_n = 1: hold. d still reaches r_n through two gates (g1, g2 in
        place of the inverter, g2), so nothing gets slower: ${nands(RV16_DLATCH)} NANDs in place of ${nands(D_LATCH)}.</p>
        <p>Two of these latches and the clock inverter make a ${nands(RV16_DFF)}-NAND flip-flop (the library's is ${nands(DFF)}), and its
        enable version is ${nands(RV16_DFFE)} (against ${nands(DFFE)}). The campaign's levels build these, so their pars count
        ${nands(RV16_DLATCH)} and ${nands(RV16_DFF)}, and the state machine in chapter 9 is made of them. The chapters keep the
        ${nands(D_LATCH)}-NAND latch on stage because its set and reset sides read more plainly.</p></details>`,
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
      body: `
        <p>A transparent latch is awkward in a big circuit: while it is open, changes race straight through. We want
        a memory that samples its input at one precise instant.</p>
        <p>Chain two D latches with <span data-show="inv">opposite enables</span>: the <strong><span data-show="master">master</span></strong> is open while the clock is low; the
        <strong><span data-show="slave">slave</span></strong> while it is high. At the moment the clock rises, the master closes (capturing d)
        and the slave opens (showing it). This is the <strong>edge-triggered D flip-flop</strong>.</p>
        <p>"At the edge" is a contract with three numbers, all visible here. <strong>Setup</strong> (2 delays here): d must have crossed
        <span data-show="master">the master</span> before clk rises; a falling d goes through the master's inverter and a NAND.
        <strong>Hold</strong> (1 delay here): d must then stay put until the master has closed, and clk reaches the master's enable through
        <span data-show="inv">an inverter</span>. <strong>Clock-to-q</strong> (2 delays here for a rising q, 3 for a falling one): the time the
        <span data-show="slave">slave</span> takes to show the captured value. Between two flip-flops the period must cover clk-to-q + the
        slowest logic + setup, and clk-to-q plus the fastest path must outlast the hold time. Here the numbers fall out of unit NAND delays; in
        silicon they come from characterizing the cell, tens of picoseconds each, and a d that changes inside the window can leave
        the master balanced half way: metastable.</p>
        <div class="try">Change d while the clock is low: q does not move. Press <strong>Pulse</strong>: q
        takes d's value at the rising edge. Open the <strong>Timing</strong> panel to see it over time.</div>`,
      scene: () => ({ root: DFF, inputs: { d: 1, clk: 0 }, autoClock: false }),
      tries: [(st) => st.cycles > 0 && st.value('q') === st.getInput('d')],
    },
    {
      title: 'Load enable',
      body: `
        <p>Often we want a flip-flop to keep its value on most clock edges and only load a new one sometimes.
        Put <span data-show="mux">a multiplexer</span> in front: when <code>en = 0</code> it feeds q back into d, so the
        <span data-show="ff">flip-flop</span> reloads its own value. When <code>en = 1</code> it lets the new d through.</p>
        <details class="deeper"><summary>Deeper: why not gate the clock?</summary>
        <p>The obvious alternative is clk·en into the flip-flop: no mux, no reloading. But an AND on the clock delays this flip-flop's edge
        against its neighbours' (skew, eating into setup or hold), and if en changes while clk is high the gated clock gets a runt pulse
        or a second edge. The <span data-show="mux">mux</span> leaves the clock untouched and makes en an ordinary data input, with its
        own setup and hold like d.</p>
        <p>Real chips gate clocks all the same, because the clock net and the flip-flops it toggles are a large share of dynamic power, and a
        register that is not loading need not be clocked. They use an <strong>integrated clock-gating cell</strong> (ICG): a latch,
        transparent while clk is low, holds en steady through the high phase, and an AND passes clk only when the latched en is 1, so the
        gated clock has whole pulses only. One ICG serves a whole register, and synthesis inserts it where it finds exactly this
        mux-and-feedback pattern. Every load enable on this site is the mux.</p></details>`,
      scene: () => ({ root: DFFE, inputs: { d: 1, en: 0, clk: 0 } }),
    },
  ],
};

export const chRegisters: Chapter = {
  id: 'registers', num: 9, title: 'Registers & counters', level: 'Sequential blocks',
  blurb: 'Store a whole word on every clock edge; count, shift, reset, and divide a clock.',
  goals: [
    `build a register from enable flip-flops, and price a stored bit (${nands(DFFE)} NANDs, ${stats(DFFE).transistors} transistors)`,
    'close a register → logic → register loop into a counter, a shift register, an LFSR or a ring counter',
    'say why an asynchronous reset is released through a synchronizer, and why a ripple divider\'s bits glitch',
    'design a state machine from its transition table: state encoding, next-state logic, Mealy or Moore output',
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
    practise: ['s_reg4', 's_reg16', 's_cnt4', 's_pc', 's_fsm'],
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
        <div class="try">Type a value into d, set en = 1, then Pulse. Change d again with en = 0 and Pulse: q keeps the old word.</div>`,
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
        is 15 NANDs (60 transistors) here. Real memories use cleverer cells, a 6-transistor SRAM cell or even a single
        transistor and a capacitor (DRAM), which we will meet later.</p>`,
      scene: () => ({ root: register(8), inputs: { d: 0x2a, en: 1, clk: 0 } }),
    },
    {
      title: 'A counter',
      body: `
        <p>Feed a <span data-show="reg">register</span>'s output through an <strong><span data-show="inc">incrementer</span></strong> (a chain of half adders that adds 1) and back into
        its input. Every clock edge, it loads its own value plus one: a <strong>counter</strong>.</p>
        <p>This loop of register → logic → register is the shape of every synchronous circuit, including a
        processor: the program counter is exactly this, plus the ability to jump.</p>
        <div class="try">The clock runs by itself (with the automatic clock off, press <strong>Run</strong>): watch the count climb in the <strong>Timing</strong> panel. <strong>Pulse</strong> pauses it for one edge at a time.</div>`,
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
        and forces the reset side, so q = 0 at once, clock or no clock. <span data-show="master slave">Both latches</span> of the flip-flop get it.</p>
        <p>"Asynchronous" is the catch: releasing reset is itself an input change that can land right next to a clock edge. A flip-flop
        specifies a <strong>recovery time</strong> (rst_n high at least that long before the edge: reset's setup) and a <strong>removal
        time</strong> (its hold). Release inside that window and some flip-flops leave reset on this edge, others on the next, or one goes
        metastable. Real designs assert reset asynchronously but release it through a <strong>synchronizer</strong>: two flip-flops in
        series on the chip's clock, the first fed a constant 1, both cleared by the raw rst_n. Their output drops with rst_n at once, but
        rises only at a clock edge, so the rest of the chip leaves reset together. If the first flip-flop catches the release inside its
        window and goes metastable, it has a whole clock period to settle before the second samples it.</p>
        <details class="deeper"><summary>Deeper: how safe are two flip-flops?</summary>
        <p>A flip-flop caught metastable is still undecided after a time t with probability ∝ e^(−t/τ) (chapter 8). The rate of failures
        is about f_clk · f_data · T₀ · e^(−t_r/τ), where f_data is how often the input changes, T₀ the window the cell is sensitive in, and
        t_r the time allowed to resolve: one clock period minus clk-to-q and setup. Every extra period multiplies the mean time between
        failures by e^(T/τ): with τ = 10 ps and a 1 ns clock, e^100 ≈ 10⁴³. So two flip-flops are the norm, three at high clock rates.
        The same synchronizer serves any single asynchronous bit (a button, an interrupt line, a flag from another clock domain); a
        multi-bit value needs more, since its bits may settle on different cycles: a handshake, a Gray-coded counter, an asynchronous FIFO.</p></details>
        <div class="try">Clock a 1 in (d = 1, pulse), then pull rst_n low: q clears immediately, without a clock edge.</div>`,
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
        produces anyway.</p>`,
      scene: () => ({ root: JKFF, inputs: { j: 1, k: 1, clk: 0, rst_n: 1 } }),
    },
    {
      title: 'Counting both ways',
      body: `
        <p>Replace the incrementer with <span data-show="u3 u1">an adder/subtractor adding the constant 1</span>, its <code>sub</code> input driven
        by <span data-show="u0">NOT up</span>, and add <span data-show="u4">a multiplexer for a parallel load</span>. Now the counter counts up or down, and can be preset: the shape of a timer that counts down to zero
        from a loaded value.</p>`,
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
        PCIe lanes, the iterative multiplier and divider of <a href="#/c/muldiv/0">chapter 20</a>.</p>
        <div class="try">mode = 1 (shift right) with sr = 1: pulse four times and watch the ones march in from the top.</div>`,
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
        <p>Linear-feedback shift registers generate test patterns for chips (built-in self-test), scramble serial links so the signal has
        enough transitions, compute CRCs, and make noise. They are not secure random numbers: 2n consecutive outputs reveal the taps.</p>
        <div class="try">While load = 1 every edge loads the seed. Set load = 0 and let the clock run: the sequence repeats after 15 clocks. Try loading 0: it never leaves.</div>`,
      scene: () => ({ root: lfsr(4), inputs: { load: 1, seed: 1, clk: 0 } }),
    },
    {
      title: 'Ring and Johnson counters',
      body: `
        <p>Close a <span data-show="reg">shift register</span> on itself and a single 1 circulates: a <strong>ring counter</strong>, n states from n flip-flops, already
        one-hot (no decoder). <span data-show="inv">Invert the bit on its way round</span> and you get a <strong>Johnson counter</strong>: 2n states (0000, 0001, 0011, …,
        1111, 1110, …), only one bit changing per step, and each state is recognised by a single 2-input gate. Both trade flip-flops for
        decoding logic, which is why they show up in state machines and multiphase clocks.</p>
        <div class="try">While init = 1 every edge loads 0000 and the counter stands still. Set init = 0 and watch 0000, 0001, 0011, 0111,
        1111, then the zeros march in: 1110, 1100, … 8 states.</div>`,
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
        <div class="try">Release rst_n and let the clock run: the Timing panel shows each stage at half the rate of the one before.</div>`,
      scene: () => ({ root: clockDivider(3), inputs: { clk: 0, rst_n: 0 }, analyzer: true }),
    },
    {
      title: 'State machines',
      body: `
        <p>A counter is a register whose next value is a fixed function of its value. Let that function read inputs too and you have a
        <strong>finite-state machine</strong>: a state register, next-state logic, output logic. It is how hardware runs a sequence (a divider's
        iterations, a cache refill, the steps of a multicycle CPU in <a href="#/c/multicycle/0">chapter 22</a>).</p>
        <p>The design is mechanical. Recognise 1, 0, 1 on a serial input x, overlaps included: S0 has seen nothing useful, S1 a 1, S2 a 1 then
        a 0. Draw the transitions, encode the states in two flip-flops (s1 s0 = 00, 01, 10), write the table:</p>
        <table class="cmp fsm-tt"><thead><tr><th>s1 s0</th><th>x</th><th>n1 n0</th><th>y</th></tr></thead><tbody>
          <tr><td>00</td><td>0</td><td>00</td><td>0</td></tr><tr><td>00</td><td>1</td><td>01</td><td>0</td></tr>
          <tr><td>01</td><td>0</td><td>10</td><td>0</td></tr><tr><td>01</td><td>1</td><td>01</td><td>0</td></tr>
          <tr><td>10</td><td>0</td><td>00</td><td>0</td></tr><tr><td>10</td><td>1</td><td>01</td><td>1</td></tr></tbody></table>
        <p>Code 11 never occurs, so it is a don't care: <span data-show="g0 n0"><code>n0 = x</code></span>,
        <span data-show="g1 h1 k1 n1"><code>n1 = ¬x·s0</code></span>, and the output <span data-show="yn yg"><code>y = x·s1</code></span>, each next
        bit ANDed with ¬rst for a synchronous reset. <span data-show="s0 s1">Two ${nands(RV16_DFF)}-NAND flip-flops</span>
        (the ${nands(RV16_DLATCH)}-NAND latch from <a href="#/c/latches/2">chapter 8's aside</a>, as the campaign builds them) and ${nands(DET101) - 2 * nands(RV16_DFF)} NANDs of logic.</p>
        <p>y reads x directly: a <strong>Mealy</strong> output.</p>
        <details class="deeper"><summary>Deeper: Mealy or Moore</summary>
        <p>A <strong>Moore</strong> output depends on the state alone: add S3 "saw 101" with
        y = 1 there (it still fits in two flip-flops, 11 is free) and the detection comes a cycle later, but clean. The Mealy y follows x, glitches
        included, so whatever reads it must sample it at the clock edge.</p></details>
        <details class="deeper"><summary>Deeper: one-hot states</summary>
        <p>Two flip-flops for three states is a dense (binary) encoding. <strong>One-hot</strong> gives each state its own flip-flop
        (S0, S1, S2 = 001, 010, 100): one more flip-flop here, but each next-state bit is just the OR of the arcs entering that state,
        and every state test reads one flip-flop with no decoding. For the detector: S1' = x (every 1 leads to S1), S2' = ¬x·S1,
        S0' = ¬x·(S0 + S2), y = x·S2. The costs: reset must set S0 rather than clear everything, and an upset (a particle strike) that makes two bits hot is a state the
        logic never planned for. FPGAs, rich in flip-flops, encode machines one-hot by default; ASIC flows weigh flip-flops against
        logic per machine. A ring counter is a one-hot machine with no inputs, and the campaign's multicycle core steps through F, E, M, W
        one-hot.</p></details>
        <p>The diagram is drawn from the same table as the circuit, and a test reads the circuit back into it state by state. Hover an arc to light
        the gates that make that transition.</p>
        <div class="try">Set x and pulse: 1, 0, 1. Watch the dashed arc move when you flip x before the edge.</div>`,
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
  id: 'memory', num: 10, title: 'Memory arrays', level: 'Memory',
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
      'Each doubling of the words adds an address bit, a decoder input and a mux level. 64 × 16 bits in flip-flops is about 80 000 transistors: why real memories use 6T SRAM or 1T1C DRAM cells.',
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
        <p>The panel at the bottom right shows every stored bit live.</p>`,
      scene: () => ({ root: ram(2, 4), inputs: { addr: 1, din: 0x9, we: 0, clk: 0 }, panels: [memGridPanel] }),
    },
    {
      title: 'Writing',
      body: `
        <p>To write: set <code>addr</code>, put the value on <code>din</code>, set <code>we = 1</code>, and <strong>Pulse</strong> the clock.
        The addressed row turns orange in the panel: it will be written on the next rising edge.</p>
        <div class="try">Write 0x2 to address 0 and 0x5 to address 3. Open <span data-show="dec"><code>dec</code></span> while <code>we = 1</code> to see exactly one enable line high.</div>`,
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
        <p>Note that <code>we = 0</code> protects the contents: pulse the clock as often as you like.</p>`,
      scene: () => ({ root: ram(2, 4), inputs: { addr: 2, din: 0, we: 0, clk: 0 }, panels: [memGridPanel], highlight: ['rmux'] }),
    },
    {
      title: 'Scale it up',
      body: `
        <p>The same three parts scale to any size. Pick a size in the panel. The address grows one bit each time
        the number of words doubles, and so does <span data-show="dec">the decoder</span> and the depth of <span data-show="rmux">the mux tree</span>.</p>
        <p>Watch the transistor count in the Info tab: a 64 × 16 memory built this way already needs about 80 000
        transistors. That is why real memories use dense custom cells: a phone's 16 GB of DRAM is 1.4 × 10¹¹ bits, each one transistor and a
        capacitor. Stored at ${stats(DFFE).transistors} transistors a bit, as here, it would take 8 × 10¹² transistors.</p>`,
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
        a fuse PROM blows the unwanted connections once; flash keeps the same array but stores each connection as charge, so it can be rewritten.</p>
        <p>This one holds the squares of 0–15. The CPU's instruction memory in <a href="#/c/cpu/0">chapter 14</a> is a ROM too (built there from constants and a
        multiplexer tree, the read port's view of the same thing).</p>
        <div class="try">Set addr = 7: data = 0x31 = 49. Open the decoder, then one of the OR gates, and count its inputs.</div>`,
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
        <p>The 7-segment font needs 28 terms (more than the ROM's 16 words, because the seven outputs share few of them), but each term is a
        2- or 3-input AND, so the PLA costs 164 NANDs against 313 for the ROM. Early microprocessors decoded instructions with PLAs (the 6502's
        decode ROM is one), and PALs, GALs and CPLDs are their field-programmable descendants. An FPGA's lookup table is the other branch:
        a tiny ROM, 16 or 64 SRAM bits read by a mux tree on its inputs.</p>
        <div class="try">Set x to 0–15 and read y as segments a (bit 0) to g (bit 6). Open <span data-show="u5">a term</span>, then
        <span data-show="u33">an output's OR gate</span>.</div>`,
      scene: () => ({ root: pla('seg7'), inputs: { x: 5 } }),
    },
    {
      title: 'FIFO',
      body: `
        <p>A <strong>first-in first-out</strong> queue decouples a producer from a consumer: a UART receiving bytes faster than software reads
        them, a pipeline stage that sometimes stalls. Here, four words in registers, written through <span data-show="u6">a decoder</span> at
        the <span data-show="wp">write pointer</span> and read
        through <span data-show="u14">a multiplexer</span> at the <span data-show="rp">read pointer</span>. Both pointers only ever count up,
        wrapping around: a <em>circular buffer</em>.</p>
        <p>The trick is one extra pointer bit. Equal pointers mean <span data-show="emp">empty</span>; same slot but different extra bit means the
        writer is a full lap ahead: <span data-show="fl">full</span>. Without it, full and empty would look the same.</p>
        <div class="try">push = 1: pulse with din = 0x11, 0x22, 0x33. Then push = 0, pop = 1: dout shows 0x11 first.</div>`,
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
        Push writes at slot sp and increments it; pop decrements it; <span data-show="u18">the top is slot sp − 1</span>. Return-address predictors in CPUs are small stacks
        like this one; the program's call stack is the same idea kept in memory, with sp in a register (x2 in RISC-V).</p>`,
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
        <span data-show="u19">a priority encoder</span> (<a href="#/c/routing/6">chapter 7</a>) turns the matches into hit and index.
        A valid bit per entry keeps never-written entries from matching.</p>
        <p>One comparator per entry is why CAMs stay small: a TLB (address translation) has tens of entries, a fully associative cache a few
        hundred lines at most, a network router's lookup table is the big exception, and burns power accordingly.</p>`,
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
        <p>The register file of <a href="#/c/regfile/0">chapter 12</a> has two read ports and one write port: enough for one instruction per cycle. A core that issues two
        instructions per cycle needs four reads and two writes. Each read port is another multiplexer tree over every register; each write port
        another decoder, plus a multiplexer in front of every register to choose which port wins.</p>`,
      widget: portCost,
    },
  ],
};
