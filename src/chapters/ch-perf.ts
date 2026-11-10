import { carrySelect, carrySkip } from '../lib/adders';
import { alu, isZero } from '../lib/alu';
import { muxTree, rca } from '../lib/combinational';
import { CLA4, addSubFast, brentKung, koggeStone, sklansky } from '../lib/fastadd';
import { arrivals } from '../hdl/srcmap';
import { VADDER_SOURCE } from '../hdl/vadder';
import { VADDER_LINES, VADDER_NET, VADDER_PATH, VERILOG_ADD4 } from '../lib/vadder';
import { FF_INPUT, FF_WIRE } from '../sim/netcap';
import { nandDelay } from '../sim/delay';
import { logicDepth, stats } from '../sim/stats';
import { CLK_TO_Q, PS_PER_NAND, SETUP } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { adderVariants } from '../widgets/adders';
import { babbage3d } from '../widgets/babbage3d';
import { withModel } from '../widgets/modelhost';
import { adderComparison, prefixDelays } from '../widgets/timing';
import type { Chapter } from './types';
import { numOf } from './order';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;
const fmt = (x: number | null) => (x ?? 0).toFixed(1);
const N = (d: ComponentDef) => stats(d).nands;
const D = (d: ComponentDef) => logicDepth(d) ?? 0;
/** NANDs and depth of each adder at each width: a table of the family. */
const FAMILY = (rows: [string, (n: number) => ComponentDef][], widths: number[]) =>
  `<table class="mini"><tr><th>adder</th>${widths.map((n) => `<th>${n} bits</th>`).join('')}</tr>${rows.map(([name, make]) => `<tr><td>${name}</td>${widths.map((n) => `<td>${N(make(n))} NANDs, depth ${D(make(n))}</td>`).join('')}</tr>`).join('')}</table>`;
const CPU_PERIOD = 155, ALU_RIPPLE = D(alu(32)), ALU_KS = D(alu(32, 'ks'));
const PS = PS_PER_NAND; // illustrative ps per NAND delay (the timing panel's conversion)
const fo16 = { drawn: fmt(nandDelay(16 * (FF_INPUT + FF_WIRE), false)), buffered: fmt(nandDelay(16 * (FF_INPUT + FF_WIRE))) };

/** The Verilog adder step: its source with each line pointing at the gates it became, the critical path's lines marked. */
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const VADDER_HTML = VADDER_SOURCE.trimEnd().split('\n').map((text, i) => {
  const ln = i + 1;
  const cells = VADDER_NET.cells.filter((c) => VADDER_LINES[c.name].includes(ln)).map((c) => c.name);
  const row = `<i class="ln">${String(ln).padStart(2)}</i>  ${esc(text)}`;
  return cells.length ? `<span class="vl${VADDER_PATH.lines.includes(ln) ? ' crit' : ''}" data-show="${cells.join(' ')}">${row}</span>` : row;
}).join('\n');
const PATH_LINES = VADDER_PATH.lines.map((l) => `<code>${l}</code>`).join(', ');
const VERILOG_ADD4_NANDS = N(VERILOG_ADD4);
const ARR = arrivals(VADDER_NET);
const ARR_C4 = ARR[VADDER_NET.ports.find((p) => p.name === 'co')!.nets[0]];
const VERILOG_ADD4_ARRIVALS = VADDER_NET.ports.filter((p) => p.dir === 'out')
  .flatMap((p) => p.nets.map((n, i) => `<code>${p.nets.length === 1 ? p.name : `${p.name}[${i}]`}</code> ${ARR[n]}`)).join(', ');

export const chFastAdders: Chapter = {
  id: 'fastadd', num: numOf('fastadd'), title: 'Faster adders', level: 'Optimization',
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
        why: ['', 'The 32-bit Kogge–Stone is now under 20 NAND delays, a minority of the path: shaving it further moves little.', 'The critical path is a branch: it ends at the PC and never writes the register file.', 'Cutting the path into pieces is the next chapter\'s method: that CPU runs at 93 with these adders.'],
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
        <p>The cause is a data dependence, not a design flaw: bit <em>i</em>'s sum needs its carry-in, which is bit <em>i</em>−1's carry-out, which needs <em>its</em> carry-in. Each full adder
        has to wait for the one below it, and a chain of <em>n</em> of them has to be waited for end to end. The adder is cheap for the same reason: ${N(rca(32)) / 32} NANDs a bit, ${N(rca(32))} for 32 bits,
        with no hardware spent on looking ahead. Every faster adder in this chapter is a way of paying NANDs to break that chain.</p>
        <div class="try">Toggle <code>cin</code> (slow motion is on in this scene) and count: the carry crawls through all <span data-show="fa0 fa1 fa2 fa3 fa4 fa5 fa6 fa7">eight full adders</span>.</div>`,
      scene: () => ({ root: rca(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
      tries: [(st) => st.getInput('cin') === 1],
      tour: {
        beats: [
          { title: 'Nothing to carry', show: ['fa0', 'fa7'], expect: { s: 0xff, cout: 0 },
            say: '<p>With cin = 0 and b = 0 every stage computes a<sub>i</sub> + 0 + 0: s = {v:s}, no carry anywhere. Nothing moves.</p>' },
          { title: 'A carry enters', set: { cin: 1 }, show: ['fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7'], expect: { s: 0, cout: 1 },
            say: `<p>cin = 1. Bit 0 sees 1 + 1 and produces a carry; bit 1 sees it, 1 + 1, and passes it on; and so on up to bit 7. The final answer, s = {v:s} with cout = {v:cout}, is correct only after the carry has crossed all eight stages: ${D(rca(8))} NAND delays for this adder.</p>` },
          { title: 'A carry that stops', set: { a: 0x7f }, show: ['fa6', 'fa7'], expect: { s: 0x80, cout: 0 },
            say: '<p>With a = 0x7F the carry ripples through seven stages and is absorbed at bit 7, where a<sub>7</sub> = 0: s = <code>{b:s}</code>, no carry out. The hardware cannot know that in advance, so the clock must wait for the full chain.</p>' },
        ],
      },
      more: {
        derive: `<p>Each full adder's cin → cout path is two NAND levels, so a carry crossing <em>n</em> stages takes 2n, and the sum bit that depends on it adds a final pair: the depths below are 2n + 4.</p>
          ${FAMILY([['Ripple carry', rca]], [8, 16, 32, 64])}`,
        pitfall: `<p>The ripple adder looks hopeless but is fast on average: for random operands the longest carry chain is about log₂ <em>n</em> bits, not <em>n</em>. The problem is that a synchronous
          design must be correct for the worst case, so the clock waits for a chain that almost never happens. Adders that finish early on easy inputs exist (asynchronous, self-timed), and cost a completion detector.</p>`,
        real: `<p>Ripple carry is still used where the chain is short or free: tiny cores, the inside of a carry-select or carry-skip block, and FPGAs, which build a dedicated carry chain into the fabric
          so a 32-bit ripple adder is fast there. In a standard-cell chip, a synthesis tool replaces the ripple adder with a faster structure unless told the path is not critical.</p>`,
      },
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
        <p>"Two-level" assumes wide gates: c<sub>k</sub> needs a <span data-show="lcu.k4.or">(k+1)-input OR</span> of
        <span data-show="lcu.k4.t0 lcu.k4.t1 lcu.k4.t2 lcu.k4.t3">up-to-(k+1)-input ANDs</span>. In CMOS
        those are complex gates (NAND4, AOI). Here we only have 2-input NANDs, so every wide gate becomes a tree, and
        the Info tab shows the uncomfortable result: <strong>this 4-bit CLA is deeper than the 4-bit ripple adder</strong>
        (15 vs 12 NAND delays) and three times larger. Lookahead pays off with wide gates or at larger widths, built
        hierarchically from 4-bit blocks. The prefix formulation on the next step scales properly.</p>
        <p>What lookahead buys is independence: every carry is its own sum of products over g, p and c<sub>0</sub>, computed in parallel instead of waiting for the one below.
        What it costs is fan-in. The term for c<sub>k</sub> has k + 1 factors and the expansion has k + 1 terms, so the gates widen with each bit. At 4 bits that is already a 5-input OR of
        ANDs of up to 5 inputs; at 16 it would be unbuildable as a single level. Real designs stop at 4 bits and then apply the idea again to the blocks: group generate and
        group propagate signals, and a second level of lookahead over them.</p>`,
      scene: () => ({ root: CLA4, inputs: { a: 0b0111, b: 0b0001, cin: 0 } }),
      more: {
        derive: `<p>Unrolling c<sub>i+1</sub> = g<sub>i</sub> + p<sub>i</sub>c<sub>i</sub>: c₁ = g₀ + p₀c₀. c₂ = g₁ + p₁c₁ = g₁ + p₁g₀ + p₁p₀c₀. Each substitution adds one term and one factor to every term, which is why c₄ has the
          five terms above. The sum bit is s<sub>i</sub> = p<sub>i</sub> ⊕ c<sub>i</sub>: with every c<sub>i</sub> available at about the same time, all sum bits finish together. In gates: this 4-bit CLA is ${N(CLA4)} NANDs and ${D(CLA4)} deep,
          against ${N(rca(4))} and ${D(rca(4))} for the ripple adder of the same width.</p>`,
        pitfall: `<p>Counting gate levels as if gates had any number of inputs. In a library of 2-input NANDs a 5-input AND is a tree of three levels, which erases the "two-level" advantage.
          Always ask what the widest gate is allowed to be: with AOI and NAND4 cells lookahead wins, with 2-input cells it loses at 4 bits.</p>`,
        real: `<p>Carry-lookahead was the standard fast adder in the 1970s–1990s with 4-bit lookahead units chained into a second level (the 74182 chip did exactly that). Today the same
          group-generate/group-propagate idea survives inside synthesized prefix adders, which tools choose between by timing constraint.</p>`,
      },
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
        <p>The idea is divide and conquer on the carry chain. A pair of bits already is a group with its own (G, P); two pairs combine into a group of four, two of those into eight.
        Doubling the span each level reaches the full width in log₂ <em>n</em> levels, and every bit's prefix is computed by its own copy of the tree, which is what Kogge–Stone means: no sharing, no fan-out beyond
        two, and a cell at every position of every level. The price is in the cell count, ${N(koggeStone(32))} NANDs at 32 bits against ripple's ${N(rca(32))}, and in the wires between levels.</p>
        <div class="try">Toggle <code>cin</code> with a = 0xFF: compare the status line's settle time with the ripple adder's.</div>`,
      scene: () => ({ root: koggeStone(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
      tour: {
        beats: [
          { title: 'g and p per bit', show: ['gp0', 'gp1', 'gp2', 'gp3', 'gp4', 'gp5', 'gp6', 'gp7'], expect: { s: 0xff, cout: 0 },
            say: '<p>Every bit first computes its own g = a·b and p = a ⊕ b. With b = 0 no bit generates and every bit propagates, so the sum is a: {v:s}.</p>' },
          { title: 'Carry-in', set: { cin: 1 }, show: ['cin0', 'L0_1', 'L1_2', 'L2_4'], expect: { s: 0, cout: 1 },
            say: `<p>cin = 1 is folded into bit 0 as a generate. Level 0 combines neighbours, level 1 pairs at distance 2, level 2 at distance 4: after three levels bit 7 knows a carry reaches it. The result s = {v:s}, cout = {v:cout} is ready in ${D(koggeStone(8))} delays, against ${D(rca(8))} for the ripple adder.</p>` },
          { title: 'Overflow', set: { a: 0x7f, cin: 0 , b: 1 }, show: ['L2_7'], expect: { s: 0x80, cout: 0 },
            say: '<p>0x7F + 1: a carry is generated at bit 0 and propagates through bits 1 to 6; the gray cells at the top of the tree see it at the last level. s = <code>{b:s}</code>, and the overflow flag v is {v:v}.</p>' },
        ],
      },
      more: {
        derive: `<p>Prefix on four bits, level by level, with (G, P)[i:j] for bits i down to j: level 0: [1:0], [2:1], [3:2] from neighbours. Level 1 combines each with the one two below: [3:0] = [3:2] ∘ [1:0],
          [2:0] = [2:1] ∘ [0:0] (once folded with cin), and so on. Two levels give all four prefixes. Each carry c<sub>i+1</sub> = G[i:0] needs one path of log₂ <em>n</em> cells, so depth grows by one cell per doubling.</p>
          ${FAMILY([['Kogge–Stone', koggeStone]], [8, 16, 32, 64])}`,
        pitfall: `<p>Comparing prefix networks by cell count alone. Kogge–Stone has the most cells and the least depth and fan-out, and Brent–Kung the fewest cells and about twice the prefix levels (${D(brentKung(32))} NAND delays against ${D(koggeStone(32))} at 32 bits). The best choice depends on whether
          area, depth or wiring is scarce; the table in the measured step puts them side by side.</p>`,
        real: `<p>High-performance cores use Kogge–Stone-like adders, often sparse (a prefix tree over every fourth bit and short ripple blocks between them) to cut the wires, or Ling and Han–Carlson variants. The wires, not
          the gates, are what makes a pure Kogge–Stone expensive on silicon: level <em>j</em> spans 2<sup>j</sup> bit positions.</p>`,
      },
    },
    {
      title: 'Carry-select: compute both answers',
      body: `
        <p>A cruder way to stop waiting for the carry: build each block twice, <span data-show="u5 u6">once assuming its carry-in is 0 and once 1</span>, and let both work
        while the real carry is still on its way. When it arrives, <span data-show="u7 u8">a multiplexer</span> picks the right sum. The carry then crosses one multiplexer
        per block instead of rippling through it.</p>
        <p>At 32 bits with 4-bit blocks: 32 NAND delays instead of 68, for 680 NANDs instead of 288. Uneven blocks (small first, growing
        later, so every block's answers are ready just as its carry arrives) do better; so does selecting at two levels.</p>
        <p>The trade is speculation: spend hardware on work that will mostly be thrown away (half of every block's sums are discarded) to take the carry off the critical path.
        It is the same bargain as guessing a branch outcome early, but cheaper, because here both outcomes can be computed and nothing has to be undone.
        The price is ${(N(carrySelect(32)) / N(rca(32))).toFixed(1)} times the NANDs of a ripple adder for ${(D(rca(32)) / D(carrySelect(32))).toFixed(1)} times the speed.</p>
        <div class="try">Toggle <code>cin</code> (slow motion is on): only the first block and the chain of multiplexers react.</div>`,
      scene: () => ({ root: carrySelect(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
      tour: {
        beats: [
          { title: 'Both answers ready', show: ['u5', 'u6'], expect: { s: 0xff, cout: 0 },
            say: '<p>Each block after the first has computed its sum twice, once for carry-in 0 and once for 1. With cin = 0 the first block\'s carry-out is 0, so the multiplexers select the "carry 0" sums: s = {v:s}.</p>' },
          { title: 'The carry arrives', set: { cin: 1 }, show: ['u7', 'u8'], expect: { s: 0, cout: 1 },
            say: '<p>cin = 1 changes the first block, whose carry-out now selects the other set of sums in the next block: s = {v:s}, cout = {v:cout}. Only the multiplexers react; the speculative sums were ready already.</p>' },
        ],
      },
      more: {
        derive: `<p>With blocks of <em>k</em> bits and <em>m</em> = n/k blocks, the first block ripples (about 2k delays) and then the carry crosses m − 1 multiplexers as their select, 3 delays each (an inverter and two NAND levels): about 2k + 3(m − 1).
          For n = 32, k = 4 that is ${2 * 4 + 3 * (32 / 4 - 1)} by this count; the circuit measures ${D(carrySelect(32))}, the rest being the last block's sum multiplexers. Choosing k trades the first term against the second, with the best near √n, and growing blocks do better:
          a later block has had longer to finish its speculative sums.</p>`,
        pitfall: `<p>Thinking the speculation is free. Every block is built twice, ${N(carrySelect(32))} NANDs against ${N(rca(32))}, and both copies switch every time the inputs change, so the power also grows by about the area. A carry-select adder
          is a good answer when speed is worth that and a poor one on a power budget.</p>`,
        real: `<p>Carry-select appears in production adders in a conditional-sum form, with the select applied at several levels of the carry tree instead of one.</p>`,
      },
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
        <p>It is the cheapest of the fast adders: ${N(carrySkip(32))} NANDs at 32 bits, against ${N(rca(32))} for ripple, ${N(carrySelect(32))} for carry-select and ${N(koggeStone(32))} for Kogge–Stone.
        The speed-up is data-dependent in the way that matters: the worst case now needs a carry that is generated in the first block, propagates through every other block and is absorbed in the last,
        and the longest carry chain in the middle is replaced by one multiplexer hop per block.</p>
        <div class="try">With a = 0xFF, toggle <code>cin</code>: both blocks propagate, so the carry skips. Then set b = 1 and toggle again.</div>`,
      scene: () => ({ root: carrySkip(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
      tour: {
        beats: [
          { title: 'Every bit propagates', show: ['u6', 'u7'], expect: { s: 0xff, cout: 0 },
            say: '<p>With a = 0xFF and b = 0 every bit has a ⊕ b = 1, so both blocks\' "all propagate" tests are true: a carry arriving at either block would pass straight through.</p>' },
          { title: 'The carry skips', set: { cin: 1 }, show: ['u9', 'u11'], expect: { s: 0, cout: 1 },
            say: '<p>cin = 1. The multiplexers pass the carry-in over each block\'s ripple chain, so cout = {v:cout} comes out after a multiplexer hop per block, not after eight ripple stages. The sum bits inside each block still ripple, in parallel.</p>' },
          { title: 'A carry that is generated', set: { b: 1, cin: 0 }, show: ['u8', 'u10'], expect: { s: 0, cout: 1 },
            say: '<p>With b = 1 bit 0 generates a carry (1 + 1), so the first block no longer propagates everything. The carry ripples to the block\'s end, then skips the second block\'s ripple: s = {v:s}, cout = {v:cout}.</p>' },
        ],
      },
      more: {
        derive: `<p>Static depth for 32 bits: ${D(carrySkip(32))}, the path that ripples through every block and every skip multiplexer. Real worst case: ripple in the first block (about 2k), skip m − 2 blocks
          (one multiplexer hop each) and ripple through the last (2k again). For 32 bits that is the ~31 delays quoted above. The two numbers are far apart because no input pattern both makes a block propagate and makes
          its carry ripple: the path through the ripple chain exists in the netlist and is never exercised.</p>`,
        pitfall: `<p>Trusting the number a timing tool prints. A false path is not a bug in the tool: it follows the netlist, not the logic. The sign-off flow handles it by constraint (a declared false path) or by
          restructuring; with no such declaration, the tool will make you fix a path that cannot happen, or worse, tell you the adder is slower than it is and push you to a bigger one.</p>`,
        real: `<p>Carry-skip suits small ALUs where area counts, and appears as a building block inside hybrid adders. In synthesized logic it is rare, mostly because of the false path:
          static timing cannot see its speed.</p>`,
      },
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
        <p>Other members of the family trade those three costs differently: Brent–Kung (fewer cells, about 2·log n prefix levels),
        Sklansky (minimum depth, high fan-out), Han–Carlson (a hybrid). Synthesis tools pick per timing constraint.</p>
        <p>Read the table by columns of cost: cells (NANDs) are area and power, depth is speed, and fan-out and wire length, which the table does not show, decide whether the depth survives layout.
        At 32 bits Kogge–Stone is ${N(koggeStone(32))} NANDs and ${D(koggeStone(32))} deep, Sklansky ${N(sklansky(32))} and ${D(sklansky(32))}, Brent–Kung ${N(brentKung(32))} and ${D(brentKung(32))}: the same logarithmic family, spread over a factor of ${(N(koggeStone(32)) / N(brentKung(32))).toFixed(1)} in area.</p>
        <p>Below the table is the same race in brass: one column of Babbage's Difference Engine No. 2, whose carry ripples up a run of 9s one arm at a time, and the anticipating carriage he designed so that it would not.</p>`,
      widget: () => withModel(adderComparison(), babbage3d()),
      more: {
        derive: `<p>Cell counts: Kogge–Stone puts a cell at nearly every (bit, level) pair, about n·log₂ n; Brent–Kung builds a tree up and a tree down for about 2n; Sklansky halves the work at each level by sharing, about (n/2)·log₂ n cells, at
          the price of one cell driving up to n/2 others on the last level.</p>
          ${FAMILY([['Ripple', rca], ['Kogge–Stone', koggeStone], ['Sklansky', sklansky], ['Brent–Kung', brentKung]], [8, 16, 32, 64])}`,
        pitfall: `<p>Reading depth as speed. Depth counts gate levels at unit load; a gate that drives many inputs is slower, and a long wire slower still. The last step of this chapter puts the loads back and the ordering of
          the three prefix adders changes.</p>`,
        real: `<p>Adders in shipping cores are sparse, hybrid or Ling-modified prefix trees chosen by a synthesis tool or tuned by hand for the critical path; Kogge–Stone is the textbook limit that the practical designs approach
          from the cheaper side.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Going from 16 to 32 bits, how much deeper does a Kogge–Stone adder get?',
        options: ['Twice as deep', 'One more prefix level', 'Not at all', 'Four times as deep'], answer: 1,
        why: ['That is ripple carry\'s growth: depth proportional to n.', '', 'The prefix tree needs log₂ n levels, and log₂ 32 is one more than log₂ 16.', 'No adder\'s depth grows faster than linearly in the width.'],
        explain: 'Depth is ~log₂ n prefix levels: doubling the width adds one level (2 NANDs here). The ripple adder adds 32 more NAND delays for the same step.',
      },
    },
    {
      title: 'Four adders, measured two ways',
      body: `<p>Static depth against simulated delay, from the netlists of this chapter. The widget shows where the two agree and where they do not; the large gap is carry-skip's, where static depth is ${D(carrySkip(32))} and the simulated worst case is about 31.</p>
        <p>Static analysis asks "what is the longest path in the wiring?" Simulation asks "how long does the last output take to settle after the inputs change?" For a circuit whose every path can carry a change they are the same question.
        When some paths are never sensitized they are not, and the simulation gives the shorter answer, for the inputs it was shown. Use the widget to compare the four at each width.</p>`,
      widget: adderVariants,
      more: {
        derive: `<p>At 32 bits the static depths are ripple ${D(rca(32))}, carry-select ${D(carrySelect(32))}, carry-skip ${D(carrySkip(32))} and Kogge–Stone ${D(koggeStone(32))}. The simulated delay is at most the static depth, and equal to it
          when the worst-case input pattern sensitizes the longest path. Carry-skip's gap (${D(carrySkip(32))} against about 31) is the false path of the previous step.</p>`,
        pitfall: `<p>Simulating a handful of input vectors and calling the largest settle time the delay. A random vector rarely produces the worst carry chain; a static analysis is safe, a simulation is only a lower bound. Use both:
          static timing to bound, simulation to explain.</p>`,
        real: `<p>Sign-off uses static timing with declared false paths and multicycle paths, because exhaustive simulation of a 64-bit adder is impossible (2<sup>129</sup> input pairs with the carry-in). Where a path is
          real but rarely exercised, the clock must still cover it.</p>`,
      },
    },
    {
      title: 'Static timing on our CPU',
      body: `
        <p><strong>Static timing analysis</strong> finds the longest register-to-register path without running any
        program: start at every flip-flop output (clk→q), propagate arrival times through every gate, and take the
        latest arrival at any flip-flop input (+ setup). The panel shows the result and highlights the path. Its clock rate
        converts NAND delays at an illustrative 25 ps each, a loaded NAND2 at 28 nm; real sign-off timing comes from a
        characterized library of gate cells, with slew, load and wire RC per arc (<a href="#/c/silicon/0">chapter ${numOf('silicon')}</a> runs our dual-core through one).</p>
        <p>Surprise: it is not <code>lw</code>. It is a <strong>branch</strong>: <span data-show="pc">PC</span> →
        <span data-show="imem">instruction memory</span> → <span data-show="ctl">decode</span> →
        <span data-show="imm">immediate mux</span> → <span data-show="srcB">SrcB</span> → 32-bit subtract in the
        <span data-show="alu">ALU</span> → zero detect → next-PC logic → PC.</p>
        <p>The ALU is about 60% of the path, and most of that is the ripple carry.</p>
        <p>Why the analysis never needs a program: a flip-flop can only change at a clock edge, so every signal in the machine is a function of flip-flop outputs after a bounded delay, and the worst such delay is a property of
        the wiring. If the period covers it, every cycle of every program is safe, whatever it executes. That is also why the answer is conservative: it covers the slowest path even when no program makes it matter.</p>
        <p>Converted at ${PS} ps a delay, ${CPU_PERIOD} NAND delays is ${(CPU_PERIOD * PS / 1000).toFixed(2)} ns, a clock of about ${Math.round(1e6 / (CPU_PERIOD * PS))} MHz: at 28 nm, only what a late-1990s processor reached on a far older process, because of a textbook ALU.</p>`,
      scene: () => cpuScene({ source: src('sum'), timing: true }),
      tour: {
        beats: [
          { title: 'Launch', reset: true, show: ['pc'], expect: { pcOut: 0 },
            say: '<p>Every path starts at a flip-flop. The PC register launches the address at the clock edge, after its clock-to-q delay.</p>' },
          { title: 'The instruction that sets the clock', cycles: 5, show: ['pc', 'imem', 'ctl', 'imm', 'srcB', 'alu'], expect: { pcOut: 20, aluOut: 0xfffffff7 },
            say: '<p>At {v:pcOut} is <code>bne t0, t1, loop</code>. The path through it: instruction memory, decode, immediate mux, SrcB, a 32-bit subtract (2 − 11 = −9 here; the worst case is a carry through every bit), the zero detector.</p>' },
          { title: 'Capture', cycles: 1, show: ['npc'], expect: { pcOut: 12 },
            say: '<p>The next-PC logic picks the branch target and the PC captures it at the next edge: {v:pcOut}. The sum of the delays along this path plus clock-to-q and setup is the period the panel reports.</p>' },
        ],
      },
      more: {
        derive: `<p>Period = clock-to-q (${CLK_TO_Q}) + the longest combinational path + setup (${SETUP}) = ${CPU_PERIOD}, so the logic is ${CPU_PERIOD - CLK_TO_Q - SETUP} NAND delays. The ALU is ${ALU_RIPPLE} of the ${CPU_PERIOD}: ${Math.round(100 * ALU_RIPPLE / CPU_PERIOD)} %,
          which is the 60 % above. Inside it a 32-bit ripple adder is ${D(rca(32))} delays, the bulk of the ALU's ${ALU_RIPPLE}.</p>`,
        pitfall: `<p>Assuming the instruction you think is slowest (a load) sets the clock. The longest path is the one that passes through the most logic, not the one that sounds heaviest, and in this design
          the branch beats the load because the memory is a mux tree, as fast as logic. Let the tool name it.</p>`,
        real: `<p>Sign-off timing runs the same algorithm on a characterized cell library at several process corners (slow, typical, fast) and supply and temperature points, with wire RC extracted from layout, and a margin for clock
          skew and jitter. Static timing replaced gate-level simulation for timing closure decades ago because it covers every path, not just the ones a test exercises.</p>`,
      },
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
        (<kbd>P</kbd>) the ALU result to watch it arrive late.</div>
        <p>What "half-rippled" means physically: when the edge comes, some flip-flop inputs have not reached their final value, and the flip-flop stores whatever is there. A comparison of 11 with 11 means a subtraction whose carry
        ripples through all 32 bits, setting every sum bit to 0 one after another; sample it early and the zero detector sees some bits still 1 and says "different". The CPU does not crash: it takes a wrong, deterministic branch and carries on, which is
        worse, because the failure looks like a program bug.</p>`,
      scene: () => ({ ...cpuScene({ source: src('sum'), timing: true }), analyzer: true }),
      more: {
        derive: `<p>Slack = period − path delay. At period 150 the worst path (${CPU_PERIOD}) has slack −${CPU_PERIOD - 150}, yet every edge is clean because the cycle-by-cycle path is shorter than the worst case: a path only counts when something toggles along it.
          At 130 the slack for the branch with equal operands is −${CPU_PERIOD - 130} and the capture is wrong. The period at which a program first fails is its own critical path, always at or below the static bound.</p>`,
        pitfall: `<p>Concluding that a design is safe at a given clock because a test program passed. A test exercises the paths it exercises; the static bound covers all of them. Overclocked parts that pass every benchmark and
          fail on one rare input are this case.</p>`,
        real: `<p>Vendors keep a guard band between the tested worst case and the shipped clock, and sell the same die at different speeds by binning. Some designs add error detection on the critical paths (a shadow flip-flop sampling later) and
          slow down when it fires, trading the guard band for a replay.</p>`,
      },
    },
    {
      title: 'Swap in fast adders',
      body: `
        <p>Same CPU, same program, with Kogge–Stone adders in the <span data-show="alu">ALU</span>, the
        <span data-show="target">branch-target adder</span> and <span data-show="plus4">PC + 4</span>. Every block
        still opens down to transistors, the check against the instruction-set simulator still passes, and the clock period drops by about a third.</p>
        <p>Look at the new critical path: <span data-show="ctl">decode</span> (opcode AND gates, OR trees), the
        <span data-show="imm">immediate multiplexer</span> and the ALU's result mux and 32-input zero detector now dominate. That is the usual story of optimization: fix the worst
        path and the next one appears. Overlapping instructions, next, attacks the problem differently: it cuts the path into pieces.</p>
        <p>The accounting is simple because the adder is on the critical path once: the period falls by exactly the ALU's saving, ${ALU_RIPPLE} to ${ALU_KS} delays, from ${CPU_PERIOD} to ${CPU_PERIOD - ALU_RIPPLE + ALU_KS}. The cost is in area, not time: the ALU grows
        from ${N(alu(32))} to ${N(alu(32, 'ks'))} NANDs, and the two other adders grow with it. The remaining path is decode, the immediate mux, the result mux and the zero detector, none of which has an obvious faster form.</p>`,
      scene: () => cpuScene({ source: src('sum'), timing: true, adder: 'ks' }),
      tour: {
        beats: [
          { title: 'Same program', reset: true, show: ['alu'], expect: { pcOut: 0, aluOut: 0 },
            say: '<p>Same CPU, same program, same first instruction. Only the adders inside differ: Kogge–Stone in the ALU, the branch-target adder and PC + 4.</p>' },
          { title: 'Same answers', cycles: 5, show: ['alu', 'target', 'plus4'], expect: { pcOut: 20, aluOut: 0xfffffff7 },
            say: '<p>At the same instruction, <code>bne</code>, the ALU gives the same result (2 − 11 = −9), because the adder computes the same function. What changed is how many gate delays it took to get there.</p>' },
          { title: 'Shorter path', cycles: 1, show: ['ctl', 'imm'], expect: { pcOut: 12 },
            say: '<p>The loop continues exactly as before. The critical path no longer runs through a ripple carry: decode, the immediate multiplexer and the ALU\'s result mux and zero detector are what is left.</p>' },
        ],
      },
      more: {
        derive: `<p>New period = old period − ALU (ripple) + ALU (Kogge–Stone) = ${CPU_PERIOD} − ${ALU_RIPPLE} + ${ALU_KS} = ${CPU_PERIOD - ALU_RIPPLE + ALU_KS}, a ${Math.round(100 * (ALU_RIPPLE - ALU_KS) / CPU_PERIOD)} % shorter clock.
          The speed-up of the whole is bounded by the share you improved (Amdahl): a ${(ALU_RIPPLE / ALU_KS).toFixed(1)}× faster ALU, ${Math.round(100 * ALU_RIPPLE / CPU_PERIOD)} % of the path, makes the machine ${(CPU_PERIOD / (CPU_PERIOD - ALU_RIPPLE + ALU_KS)).toFixed(2)}× faster.</p>`,
        pitfall: `<p>Optimizing the unit you can see rather than the one on the path. Swapping only the branch-target adder, or PC + 4, changes nothing: they are not on the critical path. Check the path before spending NANDs.</p>`,
        real: `<p>Every timing-closure effort is this loop: find the worst path, speed it up, repeat until a different path is worst and no further gain is cheap. The balance is the sign that a design has no obvious waste left.</p>`,
      },
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
        placed (<a href="#/c/silicon/0">chapter ${numOf('silicon')}</a>).</p>
        <p>The last two rows are loads every design has. A memory's row decoder is 7 NAND delays by unit delay and nearly
        three times that under load: each address inverter feeds half the rows, and each word line three inputs per bit of
        its word (the enable muxes). The clock is worse. Unit delay counts the NAND driving a 64-bit register's clock as one
        delay; its 256 inputs make it, drawn with minimum-size gates, over three times slower than the whole 64-bit
        Kogge–Stone. Real chips drive the clock through a buffer tree (about 6 units here) and balance its branches so
        every flip-flop sees the edge at once.</p>
        <p>The Timing panels have the same <b>Unit / Load</b> switch, here and in the sandbox. The view menu's
        <b>Load-dependent delay</b> makes them open on Load. The other chapters quote unit delay.</p>
        <p>The lesson is about the model, not the adders: unit delay is a good first approximation of a circuit whose gates all drive about the same load, and a poor one wherever fan-out varies. Every design has a few places
        where it varies a lot (a decoder's address lines, a clock, a reset, a register file's write enable), and those are where the real timing differs from the unit-delay count.</p>`,
      widget: () => prefixDelays(),
      more: {
        derive: `<p>Logical effort: d = p + g·h, with p = 2 and g = 4/3 for a NAND2 and h the load over one input\'s capacitance. The delay rises linearly with the load: a fan-out of 16 takes ${fo16.drawn} units drawn with minimum-size gates, against 1 for a fan-out of 1.
          Buffering splits one big step into stages of about the same effort: two inverters, each a fan-out of about 4, take it down to ${fo16.buffered}.</p>`,
        numbers: `<table class="mini"><tr><th>64 bits</th><th>unit</th><th>drawn</th><th>buffered</th></tr>${([['Kogge–Stone', koggeStone], ['Sklansky', sklansky], ['Brent–Kung', brentKung]] as const)
          .map(([name, make]) => `<tr><td>${name}</td><td>${D(make(64))}</td><td>${fmt(logicDepth(make(64), 'drawn'))}</td><td>${fmt(logicDepth(make(64), 'load'))}</td></tr>`).join('')}</table>`,
        pitfall: `<p>Picking an adder from the unit-delay depth table. By that count Sklansky ties Kogge–Stone with fewer cells; drawn with minimum-size gates the order flips. The check is to count what each level drives, not how many levels there are.</p>`,
        real: `<p>Synthesis tools size gates and insert buffers to equalize effort per stage, and they do it after placement, when wire loads are known. The unit-delay count is where a design starts; the tool\'s timing report, with loads and wires, is the one that decides.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Drawn with minimum-size gates and no buffers, which 64-bit prefix adder is slowest?',
        options: ['Sklansky', 'Brent–Kung', 'Kogge–Stone', 'They tie: all three have logarithmic carries'], answer: 0,
        why: ['', `It has the most levels (${logicDepth(brentKung(64))} NAND delays in unit delay against ${logicDepth(sklansky(64))}), but every cell output drives at most two cells per level.`,
          'It has the most cells and wires, but each cell drives at most two cells per level: its loads stay light.',
          'The number of levels is only the unit-delay view. What each level drives decides the rest.'],
        explain: `As drawn: Sklansky ${fmt(logicDepth(sklansky(64), 'drawn'))}, Brent–Kung ${fmt(logicDepth(brentKung(64), 'drawn'))}, Kogge–Stone ${fmt(logicDepth(koggeStone(64), 'drawn'))} units. Sklansky's last level has one cell driving 32. Buffer trees bring it to ${fmt(logicDepth(sklansky(64), 'load'))}, against Kogge–Stone's ${fmt(logicDepth(koggeStone(64), 'load'))}.`,
      },
    },
    {
      title: 'A Verilog adder, and its critical path',
      body: `
        <p>Every adder so far was drawn gate by gate. A designer usually writes it as text instead, in a <span data-ahead="hdl">hardware description language (here Verilog)</span>,
        and a program turns the text into gates: <span data-ahead="synthesis">synthesis, which picks gates that compute what the text says and wires them up</span>. This is the generate-and-propagate recipe of this chapter with a carry per bit, written as ${VADDER_SOURCE.split('\n').filter((l) => l.includes('wire')).length} lines of Verilog. Each carry here is written from the one before it, so it is still a ripple; writing every carry straight from <code>g</code>, <code>p</code> and <code>ci</code> would make it the lookahead.
        Yosys, an open-source synthesizer, mapped it onto NANDs and inverters once; the circuit on the stage is its result, held equal to a fresh Yosys run by this site's tests, so nothing is fetched when the page opens.</p>
        <pre class="code vsrc">${VADDER_HTML}</pre>
        <p>In Verilog <code>^</code> is XOR, <code>&amp;</code> AND and <code>|</code> OR; <code>[3:0]</code> makes a 4-bit bus and <code>g[0]</code> picks its lowest bit; <code>{c3, c2, c1, ci}</code> glues bits side by side into one bus.
        Each line declares a wire and what drives it: <code>p</code> and <code>g</code> are the propagate and generate of the previous steps, <code>c1</code>–<code>c4</code> the carries,
        <code>sum</code> the result. Hover a line to light the <span data-show="${VADDER_PATH.cells.join(' ')}">gates it became</span>. After synthesis a gate has no name of its own, so the
        <code>(* keep *)</code> marks do the tracing: synthesis must leave each marked wire as a net, and a gate is blamed on the line of the marked wire it feeds. A gate shared by two lines shows under both.</p>
        <p>The critical path is the longest chain of gates from an input to an output: ${VADDER_PATH.depth} NAND delays, from <code>${VADDER_PATH.from}</code> to <code>${VADDER_PATH.to}</code>
        (${VADDER_PATH.cells.length} of the ${VERILOG_ADD4_NANDS} gates, lit on the circuit). The bar beside a source line marks the lines it came from: ${PATH_LINES}.
        It enters through the propagate, crosses the carries <code>c1</code>, <code>c2</code>, <code>c3</code> in turn, and leaves through the sum. The same ripple as the hand-drawn adder, found by the tool in the text.
        It ends at <code>s[3]</code>, not at the carry-out: <code>c4</code> settles after ${ARR_C4} delays, the last sum bit, which needs <code>c3</code> and one more XOR, after ${VADDER_PATH.depth}.</p>
        <p>The price of writing it this way: ${VERILOG_ADD4_NANDS} NANDs and depth ${VADDER_PATH.depth}, against ${N(rca(4))} and ${D(rca(4))} for the hand-drawn ripple adder of the first step.
        The recipe is the same. The hand-drawn full adder was found by hand to share its first NAND between sum and carry; the text asks for <code>p</code> and <code>g</code> as wires of their own, and the gates came out larger.</p>
        <div class="try">Toggle <code>ci</code>: with a = 7 and b = 0 the carry crosses <code>c1</code>, <code>c2</code> and <code>c3</code> one after another, the lit path.</div>
        <p>To try it yourself, open <em>Examples ▸ The same adder in Verilog</em> in the sandbox: a Verilog chip that synthesizes as you type. It starts from the one-line form, <code>assign {co, s} = a + b + ci;</code>; paste the listing above into its Verilog pane to get this adder, and compare the two NAND counts.</p>`,
      scene: () => ({ root: VERILOG_ADD4, inputs: { a: 7, b: 0, ci: 0 }, highlight: VADDER_PATH.cells, animate: true }),
      actions: [{ label: 'Toggle ci', run: (st) => st.toggleInput('ci') }],
      tries: [(st) => st.getInput('ci') === 1],
      lit: `The ${VADDER_PATH.cells.length} gates of the critical path, ${VADDER_PATH.from} → ${VADDER_PATH.to}`,
      more: {
        derive: `<p>Each cell's arrival is one more than its latest input, with every input at 0. The outputs, in NAND delays:
          ${VERILOG_ADD4_ARRIVALS}</p>`,
        real: `<p>Static timing tools in a real flow report the same thing, a chain of cells from a start point to an end point, but name the nets and cells, not the source lines: ABC rebuilds the logic, so source locations are lost on the way (here too: the gates carry none). That is why designers name the wires they want to find again, and why a timing report is read against the netlist.</p>`,
        pitfall: `<p>Reading the blame as exact. A gate with no marked wire after it has no line, and a gate that feeds two marked wires is listed under both. With fewer <code>keep</code> marks synthesis would be freer to merge gates, and a path could no longer be pointed at a line.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'The critical path of this adder ends at s[3], not at the carry-out co. Why?',
        options: ['The last sum bit needs the carry c3 and then a further XOR, which is deeper than the AND-OR that makes c4', 'co is not connected to the carries', 'Synthesis puts the sum last on purpose', 'Static timing only looks at the sum outputs'],
        answer: 0,
        why: ['', 'co is c4, the last carry.', 'Synthesis does not order outputs; each settles when its inputs allow.', 'Timing covers every output; here the sum bit happens to be the slowest.'],
        explain: `co (c4) settles after ${ARR_C4} NAND delays; s[3] = p3 ⊕ c3 after ${VADDER_PATH.depth}.`,
      },
    },
  ],
};

