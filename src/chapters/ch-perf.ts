import { CLA4, addSubFast, alu, brentKung, carrySelect, carrySkip, isZero, koggeStone, muxTree, rca, sklansky } from '../lib';
import { FF_INPUT, FF_WIRE } from '../sim/netcap';
import { nandDelay } from '../sim/delay';
import { logicDepth } from '../sim/stats';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { adderVariants } from '../widgets/adders';
import { adderComparison, prefixDelays } from '../widgets/timing';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;
const fmt = (x: number | null) => (x ?? 0).toFixed(1);
const fo16 = { drawn: fmt(nandDelay(16 * (FF_INPUT + FF_WIRE), false)), buffered: fmt(nandDelay(16 * (FF_INPUT + FF_WIRE))) };

export const chFastAdders: Chapter = {
  id: 'fastadd', num: 16, title: 'Faster adders', level: 'Optimization',
  blurb: 'Carry-lookahead, Kogge–Stone, carry-select and carry-skip: trading gates for speed, measured on the CPU\'s critical path.',
  goals: [
    'say why a ripple adder\'s depth grows as 2n, and what that costs the CPU',
    'derive every carry from generate and propagate, and combine them in a log₂ n prefix tree',
    'compare ripple, lookahead, Kogge–Stone, carry-select and carry-skip on gates and depth',
    'find a CPU\'s critical path with static timing, and see what breaks when the clock outruns it',
  ],
  builds: ['adders', 'cpu'],
  recap: {
    keep: [
      'Ripple carry: two NAND delays per bit. 32 bits: 288 NANDs, 68 NAND delays.',
      'g = a·b, p = a ⊕ b, c<sub>i+1</sub> = g<sub>i</sub> + p<sub>i</sub>c<sub>i</sub>. The combine operator is associative, so a prefix tree finds every carry in log₂ n levels. Flat lookahead from 2-input NANDs is deeper than ripple at 4 bits (15 vs 12).',
      'Kogge–Stone, 32 bits: 878 NANDs, 18 NAND delays, one level more per doubling of the width. Carry-select: 680 NANDs, 32 delays.',
      'Carry-skip: static depth 83, but that path is false; simulated, it settles in about 31. Static timing assumes every path can carry the last change.',
      'On the single-cycle CPU the critical path is a branch, 155 NAND delays. Kogge–Stone adders cut it to 103, and decode, the immediate mux and the zero detector take over.',
      'Counting load (d = p + g·h, one unit = a NAND driving one input), with buffer trees: 32 bits, Kogge–Stone 30.0 units, Sklansky 31.5, Brent–Kung 40.5. Drawn without buffers, the 64-bit Sklansky is the slowest of the three. Wire length is not in the model.',
    ],
    practise: ['o_fastadd', 'c_fast'],
    check: [
      {
        question: 'Built from 2-input NANDs only, why is the 4-bit carry-lookahead adder deeper than the 4-bit ripple adder?',
        options: ['Its wide ANDs and ORs become trees of 2-input gates', 'It computes the carries one after another', 'It chains four full adders and adds lookahead on top', 'g + p·c cannot be built from NANDs directly'],
        answer: 0,
        explain: 'c₄ needs a 5-input OR of up-to-5-input ANDs. From 2-input NANDs each becomes a tree: 15 delays against ripple\'s 12. Lookahead pays with wide gates, or hierarchically at larger widths.',
        why: ['', 'Every carry is computed independently, in parallel: that is the point of lookahead.', 'It has no full adders: sums come from p ⊕ c, carries from the g / p expressions.', 'NAND is complete, and g + p·c is two NAND levels. The cost is the width of the terms.'],
      },
      {
        question: 'Static timing says 155, yet at period 140 the sum program still ends with the right result. Why?',
        options: ['The paths exercised in those cycles were shorter than the worst case', 'Static timing is wrong about this CPU', 'The simulator waits for the logic to settle', 'Early edges are ignored'],
        answer: 0,
        explain: 'The worst path needs a particular pattern of carries and opcodes. When no cycle exercises it, an early edge still captures settled values. That gap is the overclocker\'s headroom and the reason for a guard band.',
        why: ['', 'Static timing is right about the worst path; that path simply did not carry the last change in those cycles.', 'With a period set, edges come on schedule, finished or not: that is how 130 breaks the program.', 'An early edge captures whatever is on the wires: at 130 that is a half-rippled result.'],
      },
      {
        question: 'With Kogge–Stone adders the period drops from 155 to 103 NAND delays. What would shorten it next?',
        options: ['Faster decode, immediate mux, ALU result mux and zero detector', 'An even faster adder', 'A faster register-file write', 'Nothing: 103 is the limit for this instruction set'],
        answer: 0,
        explain: 'Fix the worst path and the next one appears: the new critical path runs through decode, the immediate mux, the ALU\'s result mux and its zero detector.',
        why: ['', 'The 32-bit Kogge–Stone is now under 20 NAND delays, a minority of the path: shaving it further moves little.', 'The critical path is a branch: it ends at the PC and never writes the register file.', 'Pipelining cuts the path into pieces; the next chapter\'s pipeline runs at 93 with these adders.'],
      },
    ],
  },
  steps: [
    {
      title: 'The ripple problem',
      body: `
        <p>A ripple-carry adder's worst case is a carry generated in <span data-show="fa0">bit 0</span> and propagated to
        <span data-show="fa7">bit n−1</span>: two NAND delays per bit in our 9-NAND full adder, so
        <strong>depth ≈ 2n</strong>. At 32 bits that is 68 NAND delays, and in
        the single-cycle CPU the ALU sits on the critical path of every branch.</p>
        <div class="try">Toggle <code>cin</code> (slow motion is on in this scene) and count: the carry crawls through all <span data-show="fa0 fa1 fa2 fa3 fa4 fa5 fa6 fa7">eight full adders</span>.</div>`,
      scene: () => ({ root: rca(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
      tries: [(st) => st.getInput('cin') === 1],
    },
    {
      title: 'Generate, propagate, look ahead',
      body: `
        <p>Rewrite the carry: bit i <strong>generates</strong> a carry if g<sub>i</sub> = a<sub>i</sub>b<sub>i</sub> and
        <strong>propagates</strong> one if p<sub>i</sub> = a<sub>i</sub> ⊕ b<sub>i</sub>
        (<span data-show="gp0 gp1 gp2 gp3">one g / p cell per bit</span>). Then
        c<sub>i+1</sub> = g<sub>i</sub> + p<sub>i</sub>c<sub>i</sub>, and unrolling gives every carry as a two-level
        sum of products of g, p and c<sub>0</sub>:</p>
        <p style="font-family:var(--font-mono);font-size:13px">c₄ = g₃ + p₃g₂ + p₃p₂g₁ + p₃p₂p₁g₀ + p₃p₂p₁p₀c₀</p>
        <p>"Two-level" assumes wide gates: c<sub>k</sub> needs a <span data-show="c4">(k+1)-input OR</span> of
        <span data-show="t4_0 t4_1 t4_2 t4_3">up-to-(k+1)-input ANDs</span>. In CMOS
        those are complex gates (NAND4, AOI). Here we only have 2-input NANDs, so every wide gate becomes a tree, and
        the Info tab shows the uncomfortable result: <strong>this 4-bit CLA is deeper than the 4-bit ripple adder</strong>
        (15 vs 12 NAND delays) and three times larger. Lookahead pays off with wide gates or at larger widths, built
        hierarchically from 4-bit blocks. The prefix formulation on the next step scales properly.</p>`,
      scene: () => ({ root: CLA4, inputs: { a: 0b0111, b: 0b0001, cin: 0 } }),
    },
    {
      title: 'Parallel prefix: Kogge–Stone',
      body: `
        <p>Treat (g, p) pairs as groups and define the combine operator ∘:
        (g, p) ∘ (g′, p′) = (g + p·g′, p·p′). It is <strong>associative</strong>, so all prefixes
        G[i:0] can be computed by a parallel-prefix network in log₂ n levels: at level j every row combines with the row
        2<sup>j</sup> below it. Then c<sub>i+1</sub> = G[i:0] and s<sub>i</sub> = p<sub>i</sub> ⊕ c<sub>i</sub>.</p>
        <ul><li><strong>●</strong> <span data-show="L0_2 L0_3 L0_4 L0_5 L0_6 L0_7">black cell</span>: G and P (5 NANDs).</li>
        <li><strong>◐</strong> <span data-show="L0_1 L1_2 L1_3 L2_4 L2_5 L2_6 L2_7">gray cell</span>: the result already reaches bit 0, so only G is needed (3 NANDs).</li>
        <li>The carry-in is <span data-show="cin0">folded into bit 0</span> before the network.</li></ul>
        <div class="try">Toggle <code>cin</code> with a = 0xFF: compare the status line's settle time with the ripple adder's.</div>`,
      scene: () => ({ root: koggeStone(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
    },
    {
      title: 'Carry-select: compute both answers',
      body: `
        <p>A cruder way to stop waiting for the carry: build each block twice, <span data-show="u5 u6">once assuming its carry-in is 0 and once 1</span>, and let both work
        while the real carry is still on its way. When it arrives, <span data-show="u7 u8">a multiplexer</span> picks the right sum. The carry then crosses one multiplexer
        per block instead of rippling through it.</p>
        <p>At 32 bits with 4-bit blocks: 32 NAND delays instead of 68, for 680 NANDs instead of 288. Uneven blocks (small first, growing
        later, so every block's answers are ready just as its carry arrives) do better; so does selecting at two levels.</p>
        <div class="try">Toggle <code>cin</code> (slow motion is on): only the first block and the chain of multiplexers react.</div>`,
      scene: () => ({ root: carrySelect(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
    },
    {
      title: 'Carry-skip, and a false path',
      body: `
        <p>Carry-skip spends much less: plain <span data-show="u8 u10">ripple blocks</span>, plus
        <span data-show="u6 u7">one test per block</span>, "does every bit propagate?" (all a XOR b = 1). If so, the
        block's carry-out must equal its carry-in, and <span data-show="u9 u11">a multiplexer</span> passes the carry-in straight on. A long carry ripples out of the first
        block, skips the middle ones, and ripples into the last.</p>
        <p>Here static analysis gets it wrong. The Info tab reports a depth larger than ripple carry's, because the path that ripples through
        every block <em>and</em> its multiplexer is still in the netlist. But that path can never carry the last change: whenever a block would
        ripple all the way through, its multiplexer has already chosen the skip. It is a <strong>false path</strong>. Simulated, the 32-bit
        version settles in about 31 NAND delays, not 83.</p>
        <div class="try">With a = 0xFF, toggle <code>cin</code>: both blocks propagate, so the carry skips. Then set b = 1 and toggle again.</div>`,
      scene: () => ({ root: carrySkip(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
      challenge: {
        kind: 'quiz', question: 'Why does a static timing tool overestimate the carry-skip adder?',
        options: [
          'It assumes every path in the netlist can carry the last change, including the ripple through a block whose skip multiplexer is selected',
          'It ignores the multiplexers',
          'It counts the XOR gates twice',
          'Static timing is always pessimistic by a constant factor',
        ],
        answer: 0,
        why: ['', 'It includes them: that is why its worst path runs through every block and then its multiplexer.', 'Every gate on a path counts once. The excess is a whole path that no input can ever sensitize.', 'Static timing is exact wherever every path can be sensitized; the error here comes from one false path, not a factor.'],
        explain: 'Static timing is pessimistic only where the circuit has paths that no input can sensitize. Designers declare them as false paths (set_false_path in SDC), or prefer structures without them. That is one reason carry-skip is rare in synthesized logic.',
      },
    },
    {
      title: 'Measured, not quoted',
      body: `
        <p>The table is computed from the netlists: NAND count and worst-case depth for both adders. Kogge–Stone buys
        logarithmic depth with n·log n cells and, on silicon, long wires: level j's diagonal spans 2<sup>j</sup> rows.</p>
        <p>Other members of the family trade those three costs differently: Brent–Kung (fewer cells, 2·log n depth),
        Sklansky (minimum depth, high fan-out), Han–Carlson (a hybrid). Synthesis tools pick per timing constraint.</p>`,
      widget: () => adderComparison(),
      challenge: {
        kind: 'quiz', question: 'Going from 16 to 32 bits, how much deeper does a Kogge–Stone adder get?',
        options: ['Twice as deep', 'One more prefix level', 'Not at all', 'Four times as deep'], answer: 1,
        why: ['That is ripple carry\'s growth: depth proportional to n.', '', 'The prefix tree needs log₂ n levels, and log₂ 32 is one more than log₂ 16.', 'No adder\'s depth grows faster than linearly in the width.'],
        explain: 'Depth is ~log₂ n prefix levels: doubling the width adds one level (2 NANDs here). The ripple adder adds 32 more NAND delays for the same step.',
      },
    },
    {
      title: 'Four adders, measured two ways',
      body: '<p>Static depth against simulated delay, from the netlists of this chapter.</p>',
      widget: adderVariants,
    },
    {
      title: 'Static timing on our CPU',
      body: `
        <p><strong>Static timing analysis</strong> finds the longest register-to-register path without running any
        program: start at every flip-flop output (clk→q), propagate arrival times through every gate, and take the
        latest arrival at any flip-flop input (+ setup). The panel shows the result and highlights the path. Its clock rate
        converts NAND delays at an illustrative 25 ps each, a loaded NAND2 at 28 nm; real sign-off timing comes from a
        characterized cell library, with slew, load and wire RC per arc (<a href="#/c/silicon/0">chapter 28</a> runs our dual-core through one).</p>
        <p>Surprise: it is not <code>lw</code>. It is a <strong>branch</strong>: <span data-show="pc">PC</span> →
        <span data-show="imem">instruction memory</span> → <span data-show="ctl">decode</span> →
        <span data-show="imm">immediate mux</span> → <span data-show="srcB">SrcB</span> → 32-bit subtract in the
        <span data-show="alu">ALU</span> → zero detect → next-PC logic → PC.</p>
        <p>The ALU is about 60% of the path, and most of that is the ripple carry.</p>`,
      scene: () => cpuScene({ source: src('sum'), timing: true }),
    },
    {
      title: 'Overclock it',
      body: `
        <p>So far every clock edge waited until the logic had settled. Real clocks don't wait. Type a number into
        <strong>period</strong> (gate delays per cycle) and the edges come on schedule, finished or not; the timing panel
        marks an edge that arrives while signals are still switching with a red triangle.</p>
        <p>Measured on this program (static critical path 155): at 150 every edge is clean; at 140 one edge comes
        early, yet the sum is still right, because the path being exercised that cycle was shorter than the worst case;
        at 130 the last <code>bne</code> (11 − 11, a carry through all 32 bits) is captured half-rippled in the
        <span data-show="alu">ALU</span>: its zero flag still says "different", the loop adds an eleventh time, and Run to
        halt stops at the first mismatch with a0 = 66 instead of 55. Past i = 11 the hardware never leaves the loop. The gap
        between the worst case and the typical case is where overclockers find headroom, and why vendors keep a guard band.</p>
        <div class="try">Set the period to the critical path, run to halt; then halve it, reset and run again. Probe
        (<kbd>P</kbd>) the ALU result to watch it arrive late.</div>`,
      scene: () => ({ ...cpuScene({ source: src('sum'), timing: true }), analyzer: true }),
    },
    {
      title: 'Swap in fast adders',
      body: `
        <p>Same CPU, same program, with Kogge–Stone adders in the <span data-show="alu">ALU</span>, the
        <span data-show="target">branch-target adder</span> and <span data-show="plus4">PC + 4</span>. Every block
        still opens down to transistors, the check against the instruction-set simulator still passes, and the clock period drops by about a third.</p>
        <p>Look at the new critical path: <span data-show="ctl">decode</span> (opcode AND gates, OR trees), the
        <span data-show="imm">immediate multiplexer</span> and the ALU's result mux and 32-input zero detector now dominate. That is the usual story of optimization: fix the worst
        path and the next one appears. Pipelining, next, attacks the problem differently: it cuts the path into pieces.</p>`,
      scene: () => cpuScene({ source: src('sum'), timing: true, adder: 'ks' }),
      challenge: {
        kind: 'quiz', question: `After the adder swap, roughly how much of the ALU's ${logicDepth(alu(32, 'ks'))} NAND delays is the adder itself?`,
        options: ['Almost all of it', 'Less than half: the 8:1 result mux and the zero detector are the rest', 'None: the ALU is no longer on the path'], answer: 1,
        why: ['That was true of the ripple adder. A Kogge–Stone grows with log₂ n and is now a minority of the ALU\'s path.', '', 'The branch path still subtracts in the ALU and reads its zero flag.'],
        explain: `A 32-bit Kogge–Stone is ${logicDepth(koggeStone(32))} NAND delays (${logicDepth(addSubFast(32))} with the inversion for subtraction). The result multiplexer (3 levels of MUX2, ${logicDepth(muxTree(3, 32, 16))}) and the zero detector (a 5-level OR tree plus an inverter, ${logicDepth(isZero(32))}) add as much again. Real designs compute "zero" in parallel with the sum for exactly this reason.`,
      },
    },
    {
      title: 'When fan-out costs',
      body: `
        <p>Every delay so far counted one unit per NAND, whatever it drives. A real gate charges its load. By logical
        effort a NAND2 takes d = p + g·h: parasitic delay p = 2τ, logical effort g = 4/3, and h its load over one input's
        capacitance (the same per-net capacitance the power estimate uses). One unit below is a NAND driving one NAND input.
        A NAND driving sixteen takes ${fo16.drawn} units with minimum-size gates. A pair of inverters sized up in front of
        the load, which synthesis inserts, brings that to ${fo16.buffered}.</p>
        <p>Under unit delay, Sklansky ties Kogge–Stone with fewer cells. Its last level has one cell driving n/2 others.
        Count the loads and, drawn with minimum-size gates, the 64-bit Sklansky falls behind even Brent–Kung. With buffer
        trees it comes back to within a few units of Kogge–Stone, and the buffers are not in its NAND count. Brent–Kung pays
        in levels in every model. Kogge–Stone's own price, n·log n cells and diagonals 2<sup>j</sup> rows long, is wiring.
        This model does not see wire length: a drawing's wires are not a layout's, and length is only real once a design is
        placed (<a href="#/c/silicon/0">chapter 28</a>).</p>
        <p>The last two rows are loads every design has. A memory's row decoder is 7 NAND delays by unit delay and nearly
        three times that under load: each address inverter feeds half the rows, and each word line three inputs per bit of
        its word (the enable muxes). The clock is worse. Unit delay counts the NAND driving a 64-bit register's clock as one
        delay; its 256 inputs make it, drawn with minimum-size gates, over three times slower than the whole 64-bit
        Kogge–Stone. Real chips drive the clock through a buffer tree (about 6 units here) and balance its branches so
        every flip-flop sees the edge at once.</p>
        <p>The Timing panels have the same <b>Unit / Load</b> switch, here and in the sandbox. The view menu's
        <b>Load-dependent delay</b> makes them open on Load. The other chapters quote unit delay.</p>`,
      widget: () => prefixDelays(),
      challenge: {
        kind: 'quiz', question: 'Drawn with minimum-size gates and no buffers, which 64-bit prefix adder is slowest?',
        options: ['Sklansky', 'Brent–Kung', 'Kogge–Stone', 'They tie: all three have logarithmic carries'], answer: 0,
        why: ['', `It has the most levels (${logicDepth(brentKung(64))} NAND delays in unit delay against ${logicDepth(sklansky(64))}), but every cell output drives at most two cells per level.`,
          'It has the most cells and wires, but each cell drives at most two cells per level: its loads stay light.',
          'The number of levels is only the unit-delay view. What each level drives decides the rest.'],
        explain: `As drawn: Sklansky ${fmt(logicDepth(sklansky(64), 'drawn'))}, Brent–Kung ${fmt(logicDepth(brentKung(64), 'drawn'))}, Kogge–Stone ${fmt(logicDepth(koggeStone(64), 'drawn'))} units. Sklansky's last level has one cell driving 32. Buffer trees bring it to ${fmt(logicDepth(sklansky(64), 'load'))}, against Kogge–Stone's ${fmt(logicDepth(koggeStone(64), 'load'))}.`,
      },
    },
  ],
};

