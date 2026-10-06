import { CLA4, koggeStone, rca } from '../lib';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { adderComparison } from '../widgets/timing';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;

export const chFastAdders: Chapter = {
  id: 'fastadd', num: 15, title: 'Faster adders', level: 'Optimization',
  blurb: 'Carry-lookahead and Kogge–Stone: trading gates for speed, measured on the CPU\'s critical path.',
  steps: [
    {
      title: 'The ripple problem',
      body: `
        <p>A ripple-carry adder's worst case is a carry generated in bit 0 and propagated to bit n−1: two NAND delays
        per bit in our 9-NAND full adder, so <strong>depth ≈ 2n</strong>. At 32 bits that is ~66 NAND delays, and in
        the single-cycle CPU the ALU sits on the critical path of every branch.</p>
        <div class="try">Toggle <code>cin</code> (slow motion is on in this scene) and count: the carry crawls through all eight full adders.</div>`,
      scene: () => ({ root: rca(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
    },
    {
      title: 'Generate, propagate, look ahead',
      body: `
        <p>Rewrite the carry: bit i <strong>generates</strong> a carry if g<sub>i</sub> = a<sub>i</sub>b<sub>i</sub> and
        <strong>propagates</strong> one if p<sub>i</sub> = a<sub>i</sub> ⊕ b<sub>i</sub>. Then
        c<sub>i+1</sub> = g<sub>i</sub> + p<sub>i</sub>c<sub>i</sub>, and unrolling gives every carry as a two-level
        sum of products of g, p and c<sub>0</sub>:</p>
        <p style="font-family:var(--font-mono);font-size:13px">c₄ = g₃ + p₃g₂ + p₃p₂g₁ + p₃p₂p₁g₀ + p₃p₂p₁p₀c₀</p>
        <p>"Two-level" assumes wide gates: c<sub>k</sub> needs a (k+1)-input OR of up-to-(k+1)-input ANDs. In CMOS
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
        <ul><li><strong>●</strong> black cell: G and P (5 NANDs).</li>
        <li><strong>◐</strong> gray cell: the result already reaches bit 0, so only G is needed (3 NANDs).</li>
        <li>The carry-in is folded into bit 0 before the network.</li></ul>
        <div class="try">Toggle <code>cin</code> with a = 0xFF: compare the status line's settle time with the ripple adder's.</div>`,
      scene: () => ({ root: koggeStone(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
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
        explain: 'Depth is ~log₂ n prefix levels: doubling the width adds one level (2 NANDs here). The ripple adder adds 32 more NAND delays for the same step.',
      },
    },
    {
      title: 'Static timing on our CPU',
      body: `
        <p><strong>Static timing analysis</strong> finds the longest register-to-register path without running any
        program: start at every flip-flop output (clk→q), propagate arrival times through every gate, and take the
        latest arrival at any flip-flop input (+ setup). The panel shows the result and highlights the path.</p>
        <p>Surprise: it is not <code>lw</code>. It is a <strong>branch</strong>: PC → instruction memory → decode →
        immediate mux → SrcB → 32-bit subtract in the ALU → zero detect → next-PC logic → PC.
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
        at 130 a half-rippled result is captured and the program ends with a0 = 66 instead of 55. The gap between the
        worst case and the typical case is where overclockers find headroom, and why vendors keep a guard band.</p>
        <div class="try">Set the period to the critical path, run to halt; then halve it, reset and run again. Probe
        (<kbd>P</kbd>) the ALU result to watch it arrive late.</div>`,
      scene: () => ({ ...cpuScene({ source: src('sum'), timing: true }), analyzer: true }),
    },
    {
      title: 'Swap in fast adders',
      body: `
        <p>Same CPU, same program, with Kogge–Stone adders in the ALU, the branch-target adder and PC + 4. Every block
        still opens down to transistors, the golden-model check still passes, and the clock period drops by about a third.</p>
        <p>Look at the new critical path: decode (opcode AND gates, OR trees), the immediate multiplexer and the
        ALU's result mux and 32-input zero detector now dominate. That is the usual story of optimization: fix the worst
        path and the next one appears. Pipelining, next, attacks the problem differently: it cuts the path into pieces.</p>`,
      scene: () => cpuScene({ source: src('sum'), timing: true, adder: 'ks' }),
      challenge: {
        kind: 'quiz', question: 'After the adder swap, roughly how much of the ALU\'s ~40 NAND delays is the adder itself?',
        options: ['Almost all of it', 'Less than half: the 8:1 result mux and the zero detector are the rest', 'None: the ALU is no longer on the path'], answer: 1,
        explain: 'A 32-bit Kogge–Stone is ~15 NAND delays. The result multiplexer (3 levels of MUX2) and the zero detector (a 5-level OR tree plus an inverter) add more than that. Real designs compute "zero" in parallel with the sum for exactly this reason.',
      },
    },
  ],
};

