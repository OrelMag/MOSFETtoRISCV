// Vectors: RISC-V's vector extension (RVV 1.0, the Zve32x subset) between the cores and the lanes. The length lives in a
// register (vsetvli), so one loop runs on any vector length with no tail; the 32 registers regroup by SEW and LMUL; and a
// four-lane unit in gates (lib/vector.ts) works through a register group a beat at a time beside the single-cycle core.
// Every number is computed: the RVV rules (riscv/rvv.ts), the golden model at several VLENs, the timing model
// (riscv/vecmodel.ts), and the four machines measured in bench/vectorcosts.json (tests/vectors-chapter.test.ts).

import { CHAIN_KERNEL, chainTimes } from '../riscv/vecmodel';
import { SCALAR_ROLES, VEC_PROGRAMS } from '../riscv/vecprograms';
import { PS_PER_NAND } from '../sim/timing';
import { cpuScene } from '../widgets/cpupanel';
import { chainWidget, kernelWidget, machine, machinesWidget, simdTailWidget, stripMineWidget, stripRun, VEC, vecNum as num, vecPanel, vrfWidget } from '../widgets/vectors';
import { numOf } from './order';
import type { Chapter } from './types';

const prog = (id: string) => VEC_PROGRAMS.find((p) => p.id === id)!.source;
const scene = (id: string, highlight?: string[]) => () => ({ ...cpuScene({ source: prog(id), vector: true, highlight, extraPanels: [vecPanel()] }), autoClock: false });
const sc = machine('scalar'), cores = machine('cores'), vec = machine('vector'), lanes = machine('lanes');
const ns = (m: typeof sc) => Math.round((m.cycles * m.period * PS_PER_NAND) / 1000);
const lm = (l: number) => VEC.byLmul.find((r) => r.lmul === l)!;
const U = VEC.unit;
const pct = (x: number) => `${Math.round(100 * x)} %`;
const per = SCALAR_ROLES.reduce((a, r) => a + r.n, 0);
const n37 = stripRun(37, 128, 1).passes.length, n100 = stripRun(100, 128, 8).passes.length;
const chain = (mode: 'serial' | 'units' | 'chained') => chainTimes(CHAIN_KERNEL, 8, mode).total;

export const chVectors: Chapter = {
  id: 'vectors', num: numOf('vectors'), title: 'Vectors', level: 'Throughput',
  blurb: 'One instruction for many numbers, with the length in a register: vsetvli and strip-mining, SEW and LMUL, a four-lane vector unit in gates that takes a long vector in beats, a line of memory a beat, masks, reductions, chaining, and the same kernel on four machines.',
  goals: [
    'write a loop once with <code>vsetvli</code> that runs on any vector length, and say what a fixed SIMD width costs',
    'read SEW and LMUL as a regrouping of thirty-two registers',
    'watch a four-lane vector unit in gates take a long vector in beats, load four words a beat and mask elements with <code>v0</code>',
    'price vectors against cores and lanes on the same kernel',
  ],
  builds: ['regfile', 'cpu', 'multicore'],
  recap: {
    keep: [
      `<code>vsetvli t0, a0, e32, m1</code> asks for a0 elements and answers in t0 with vl = min(a0, VLMAX), VLMAX = LMUL · VLEN / SEW. A loop that steps by vl needs no tail and runs, unchanged, on a machine with longer registers.`,
      'SEW cuts each register into elements of 8, 16 or 32 bits; LMUL joins 2, 4 or 8 registers into one, whose name must be a multiple of LMUL.',
      `Our unit has four lanes, each a 32-bit slice of all 32 registers and an ALU. A group of L registers takes L beats; the scalar core waits. A unit-stride load moves four words a beat, one from each of four word-interleaved banks, so it never conflicts.`,
      `On the lanes chapter's kernel, measured in gates: one core ${sc.cycles} cycles, four cores ${cores.cycles}, the vector unit ${vec.cycles}, four lanes ${lanes.cycles}. The vector unit and the lane core are almost the same silicon; what differs is the contract.`,
    ],
    check: [
      {
        question: 'With VLEN = 128 and e32, m1, what does <code>vsetvli t0, a0, e32, m1</code> put in t0 when a0 = 10?',
        options: ['4: min(10, VLMAX) with VLMAX = 128 / 32 = 4', '10: the whole request', '2: what is left after two passes', '128: VLEN'],
        answer: 0,
        why: ['', 'vl never exceeds VLMAX; the loop takes 10 in passes of at most 4.', 'That is the last pass\'s answer (a0 = 2 by then), not the first.', 'VLEN is bits per register; vl counts elements.'],
        explain: 'vl = min(AVL, VLMAX). The loop then subtracts it from a0 and goes round again.',
      },
      {
        question: 'On our unit (four lanes, VLEN 128), how many cycles does <code>vadd.vv</code> take at e32, m4?',
        options: ['4: one register of the group a beat, four elements each', '1: all sixteen elements at once', '16: one element a cycle', '8: two cycles per register'],
        answer: 0,
        why: ['', 'Only four ALUs: sixteen elements need four passes over them.', 'That would be one lane; there are four.', 'Each beat reads, computes and writes one register of the group in one cycle.'],
        explain: 'The group v8–v11 is four registers of four 32-bit elements; the four lanes take one register a beat.',
      },
      {
        question: 'Why does a unit-stride vle32 never meet a bank conflict on four word-interleaved banks?',
        options: ['Four consecutive words always fall in four different banks, whatever the base', 'The banks are faster than the lanes', 'The vector unit waits for each bank in turn', 'The base address must be 16-byte aligned'],
        answer: 0,
        why: ['', 'Speed has nothing to do with it; the address bits do.', 'It does not wait: one beat moves all four words.', 'Any word-aligned base works: the lanes are rotated by the base\'s word offset.'],
        explain: 'Word w lives in bank w mod 4, and w, w + 1, w + 2, w + 3 cover the four residues.',
      },
    ],
  },
  steps: [
    {
      title: 'Same operation, many numbers',
      body: `
        <p>The lanes chapter will use a small kernel to compare machines: <code>y[i] = 3·x[i] + y[i]</code> on 16 elements. On the single-cycle CPU of
        <a href="#/c/cpu/0">chapter ${numOf('cpu')}</a> it is a loop, one element a trip, and each trip runs ${per} instructions. Only ${SCALAR_ROLES[0].n} of them compute
        (a shift and two adds); the others load, store, form the address and count. The same three operations are applied to sixteen numbers, and the machine decodes
        them sixteen times.</p>
        <p>There are three ways to say “do this to many numbers” once, and they differ in where the number of numbers lives.</p>
        <table class="data"><thead><tr><th>Contract</th><th>Where the width lives</th><th>Examples</th></tr></thead><tbody>
        <tr><td><b>Packed SIMD</b></td><td>in the opcode: an instruction adds four 32-bit numbers in a 128-bit register, another adds eight</td><td>x86 SSE and AVX, Arm Neon</td></tr>
        <tr><td><b>Vector</b></td><td>in a register: <code>vl</code>, set by the program and capped by the machine</td><td>the Cray-1, RISC-V's V extension, Arm SVE</td></tr>
        <tr><td><b>Lanes running one program</b></td><td>hidden: each lane runs the scalar program on its own element</td><td>the next chapters</td></tr>
        </tbody></table>
        <p>This chapter is about the middle row, built in gates beside the single-cycle core.</p>`,
      widget: kernelWidget,
      challenge: {
        kind: 'quiz', question: `The scalar loop runs ${per} instructions per element and ${SCALAR_ROLES[0].n} of them compute. What does an instruction that works on many elements save?`,
        options: ['Fetching and decoding the same instructions once per element, and most of the loop bookkeeping', 'The arithmetic itself', 'The memory accesses', 'Nothing: each element still needs its own instruction'],
        answer: 0,
        why: ['', 'Every element is still added: by more ALUs or in more cycles, not fewer operations.', 'The words still have to be loaded and stored; only how many instructions ask for them changes.', 'That is the scalar loop; one vector instruction covers many elements.'],
        explain: 'The work per element stays; the instructions that fetch, decode, count and branch are shared across the elements.',
      },
    },
    {
      title: 'Fixed width and its tail',
      body: `
        <p>Packed SIMD puts the width in the opcode. An SSE instruction adds four 32-bit numbers held in a 128-bit register, so a loop over n elements runs ⌊n / 4⌋ times
        and then needs a second, scalar loop for the n mod 4 left over: the <b>tail</b>. With n = 37 that is nine trips of the wide loop and one of the tail.</p>
        <p>The width is also frozen into the binary. A chip with 256-bit registers (AVX) adds eight at a time, but only with new instructions: the 128-bit program still
        runs there at half the width, and using the whole of it means building a third version of the loop. Each widening of x86 (MMX, SSE, AVX, AVX-512) added a new
        set of instructions this way.</p>`,
      widget: simdTailWidget,
      more: {
        real: `<p>Compilers hide the two loops (the main loop, a tail loop, sometimes a peeled head for alignment) and libraries ship one version per instruction set, picked at run time.
          AVX-512 added masks to do the tail in the wide loop, which is a step towards the vector model of the next step.</p>`,
      },
    },
    {
      title: 'The length in a register',
      body: `
        <p>RISC-V's vectors ask the machine instead. <code>vsetvli t0, a0, e32, m1</code> says “I have a0 elements of 32 bits”; the machine answers in t0 how many it
        takes <em>this pass</em>, at most <b>VLMAX</b> = LMUL · VLEN / SEW, and puts the same number in the register <code>vl</code>, which every following vector instruction
        reads. VLEN, the length of a vector register in bits, is the machine's choice; the program never names it.</p>
        <p>The loop takes t0 elements, moves its pointers on by t0 words and goes round until nothing is left. The last pass is simply shorter: there is no tail loop. With
        n = 37 and VLEN = 128 it makes ${n37} passes. And because VLEN appears nowhere in the instruction words, the same binary runs on a machine with longer registers in
        fewer passes: the widget runs the same words on the golden model at three VLENs.</p>
        <pre class="code">${'loop:   vsetvli t0, a0, e32, m1, tu, mu   # t0 = vl = min(a0, VLMAX)\n        vle32.v  v8, (a1)                  # x\n        vle32.v  v16, (a2)                 # y\n        vsll.vi  v24, v8, 1                # 2·x\n        vadd.vv  v24, v24, v8              # 3·x\n        vadd.vv  v16, v16, v24             # 3·x + y\n        vse32.v  v16, (a2)\n        sub   a0, a0, t0\n        slli  t1, t0, 2\n        add   a1, a1, t1\n        add   a2, a2, t1\n        bnez  a0, loop'}</pre>`,
      widget: stripMineWidget,
      challenge: {
        kind: 'quiz', question: 'On VLEN 128 at e32, which LMUL makes n = 100 take exactly 4 passes?',
        options: ['m8', 'm4', 'm2', 'm1'],
        answer: 0,
        why: ['', 'At m4 VLMAX = 16: 100 elements take 7 passes.', 'At m2 VLMAX = 8: 13 passes.', 'At m1 VLMAX = 4: 25 passes.'],
        explain: `At m8 VLMAX = 8 · 128 / 32 = 32, so the passes take 32, 32, 32 and 4: ${n100} passes.`,
      },
      more: {
        derive: `<p>The rule is vl = min(AVL, VLMAX). RVV also allows ⌈AVL / 2⌉ ≤ vl ≤ VLMAX when AVL &lt; 2 · VLMAX, which lets a machine split the last two passes evenly; the golden model and Spike
          both take the minimum, and nothing here relies on the choice. <code>vsetvli rd, x0, …</code> asks for VLMAX itself, and with rd = x0 too it keeps the present vl.</p>`,
        pitfall: `<p>Writing the loop with the count of passes worked out in advance (n / VLMAX). That freezes VLEN into the program again; the loop must take each pass's vl from vsetvli.</p>`,
      },
    },
    {
      title: 'Thirty-two registers, regrouped',
      body: `
        <p>The vector register file is 32 registers of VLEN bits; here VLEN = 128. Our unit has four <b>lanes</b>, and each lane holds one 32-bit <b>slice</b> of every
        register: lane i keeps bytes 4i to 4i + 3 of each. A slice is the same <code>regfile(5, 32)</code> as the scalar CPU's register file, ${num(U.slice)} NANDs.</p>
        <p><b>SEW</b> (selected element width) cuts each register into elements of 8, 16 or 32 bits. <b>LMUL</b> joins 2, 4 or 8 neighbouring registers into one: at m4,
        <code>v8</code> means v8 to v11, sixteen 32-bit elements, and the names a group may start at are multiples of 4, so <code>v10</code> is refused. Element e sits in lane
        e mod 4, which is why a long vector is worked through in beats, four elements at a time. Both live in the register <code>vtype</code>, which vsetvli sets with vl.</p>
        <p><code>v0</code> is also the <b>mask</b>: bit e enables element e of an instruction written with <code>v0.t</code>.</p>`,
      widget: vrfWidget,
      challenge: {
        kind: 'quiz', question: 'At e32 and m2, which instruction is illegal?',
        options: ['<code>vadd.vv v3, v4, v6</code>: v3 cannot start a group of 2', '<code>vadd.vv v2, v4, v6</code>', '<code>vadd.vv v30, v4, v6</code>', '<code>vadd.vv v4, v4, v4</code>'],
        answer: 0,
        why: ['', 'v2, v4 and v6 are all multiples of 2.', 'v30 starts v30–v31, the last group of two.', 'A register group may be read and written by one instruction: each element reads before it is written.'],
        explain: 'A group of L registers starts on a multiple of L; anything else is an illegal instruction.',
      },
      more: {
        numbers: `<p>At e8, m8 a group holds 8 · 128 / 8 = 128 elements, and the mask needs 128 bits, all of v0. At e32 the largest group holds 32 elements, so the mask is v0's first 32 bits:
          lane 0's slice. Our unit, which implements e32 only, keeps a copy of just those 32 bits.</p>`,
      },
    },
    {
      title: 'A vector unit in gates',
      body: `
        <p>Beside the single-cycle CPU sits the <span data-show="vu">vector unit</span>: a decoder that checks each vector instruction against <code>vtype</code>, a block holding
        <code>vl</code> and <code>vtype</code>, a <b>beat counter</b>, four lanes (a register-file slice and an ALU each), an accumulator where the lanes meet, and a copy of v0's mask bits.
        Its <span data-show="dm">data memory</span> is now four banks.</p>
        <p>A vector instruction holds the scalar core: <code>retire</code> stays low, the PC does not move, as for the divider of chapter ${numOf('muldiv')}, for as many beats as the
        instruction needs. <code>vadd.vv v16, v8, v12</code> at m4 with vl = 16 takes four: lanes 0–3 work on elements 0–3, then 4–7, 8–11 and 12–15, one register of each group a
        beat. Elements past vl (the tail) and those whose mask bit is 0 are simply not written: a write enable per element, so <code>tu, mu</code> (tail and mask undisturbed) costs
        no extra read port.</p>
        <p>This is Cray's idea from 1976: fewer lanes than elements, and the vector streams through them. The lane core of the next chapter has one element per lane and no beats;
        here the register is longer than the row of ALUs. The unit costs ${num(U.total)} NANDs, of which the four register-file slices are ${pct((4 * U.slice) / U.total)}; with it the
        CPU grows from ${num(sc.nands)} to ${num(vec.nands)} NANDs (program ROM left out), and its clock period from ${sc.period} to ${vec.period} NAND delays.</p>
        <div class="try">Run “vadd at m4” a cycle at a time and watch the beat counter in the Vector panel go 1, 2, 3 and back to 0 while the PC waits.</div>`,
      scene: scene('vadd4', ['vu']),
      tour: {
        beats: [
          { title: 'vl and vtype', reset: true, cycles: 2, show: ['vu'], expect: { pcOut: 8, retire: 0 },
            say: '<p><code>li</code> and <code>vsetvli</code> took a cycle each, like any scalar instruction: vl = 16, vtype = e32, m4. The PC is at {v:pcOut}, on <code>vid.v</code>, whose first beat is under way: retire = {v:retire}, the core waits.</p>' },
          { title: 'vid.v: four beats', cycles: 4, show: ['vu'], expect: { pcOut: 12, retire: 0 },
            say: '<p><code>vid.v v8</code> wrote each element\'s index into v8–v11, a register a beat: four cycles for one instruction, and the PC moved once, to {v:pcOut}. <code>vadd.vi</code> has begun its own four beats.</p>' },
          { title: 'Beat 2 of the add', cycles: 5, show: ['vu', 'pc'], expect: { pcOut: 16, retire: 0 },
            say: '<p><code>vadd.vi</code> finished; <code>vadd.vv</code> has done its first beat (elements 0–3) and is on its second. retire = {v:retire}: the PC stays at {v:pcOut}.</p>' },
          { title: 'Retired', cycles: 3, show: ['vu', 'pc'], expect: { pcOut: 20, retire: 1 },
            say: '<p>Three more beats, and the add has retired: sixteen elements in four cycles, four lanes each doing four. The PC is at {v:pcOut}, on <code>vmv.x.s</code>, which takes one cycle (retire = {v:retire}).</p>' },
        ],
      },
      more: {
        derive: `<p>The unit's blocks, measured: four lanes of ${num(U.lane)} NANDs (a slice of ${num(U.slice)}, an ALU of ${num(U.alu)}, the compare and pick logic and a write multiplexer), the decoder ${num(U.decode)},
          vl / vtype ${num(U.cfg)}, the beat sequencer ${num(U.seq)}, the accumulator ${num(U.acc)} and the v0 copy ${num(U.v0)}. The four banks cost ${num(U.banks)} NANDs more than one memory of the same size.
          A third read port on every slice, the obvious way to read the mask, would have cost far more than the 32-flip-flop copy.</p>`,
        real: `<p>Ara (ETH Zürich) and the SiFive X280 cut their register files into lanes the same way, with many more lanes and SRAM in place of flip-flops. Real units also overlap instructions instead
          of holding the scalar core: see <a href="#/c/vectors/8">chaining</a>.</p>`,
        pitfall: `<p>Reading “VLEN 128, four lanes” as “128 elements at once”. VLEN is bits per register; at e32 a register is four elements, and only a group (LMUL &gt; 1) is longer than the four ALUs.</p>`,
      },
    },
    {
      title: 'A line a beat',
      body: `
        <p>A unit-stride load, <code>vle32.v</code>, reads consecutive words. The data memory is four <b>word-interleaved banks</b>: word w is in bank w mod 4. Four consecutive words
        therefore always fall in four different banks, whatever the base, so a beat reads four words, one from each bank, with no conflict, ever. When the base is not a multiple of
        16 bytes the lanes are rotated: lane i's word comes from bank (s + i) mod 4, s the base's word offset, one row further on where it wraps. The scalar port uses the same banks one word at a time.</p>
        <p>The lane core of the next chapter has one memory port and serves one lane a cycle, so a load of four words takes four cycles there. Here it takes one beat per register.
        A strided load (<code>vlse32</code>) with a stride of 4 words would hit one bank four times; our unit leaves strided accesses to the golden model, and
        <a href="#/c/feed/0">chapter ${numOf('feed')}</a> takes banks in depth.</p>
        <div class="try">Run “a line a beat” and click the <code>vle32.v</code> line in the listing: the memory and the unit light, and the store before it took two beats for eight words.</div>`,
      scene: scene('vload', ['dm', 'vu']),
      challenge: {
        kind: 'quiz', question: 'A vle32.v starts at byte address 4 (word 1). In the first beat, which bank serves lane 3?',
        options: ['Bank 0, one row further on: word 4', 'Bank 3', 'Bank 1', 'Lane 3 waits for the next beat'],
        answer: 0,
        why: ['', 'Lane 3 takes word 1 + 3 = 4, and 4 mod 4 = 0.', 'Bank 1 holds word 1: that is lane 0\'s.', 'All four lanes are served in one beat: four words, four banks.'],
        explain: 'Lane i reads word base + i; its bank is (1 + i) mod 4, so lane 3 wraps to bank 0, one row down.',
      },
    },
    {
      title: 'A mask you can see',
      body: `
        <p>A compare writes a mask: <code>vmslt.vx v0, v8, a1</code> sets bit e of v0 where element e of v8 is less than a1. An instruction written with <code>v0.t</code> then changes only
        the elements whose bit is 1: <code>vadd.vi v16, v16, 10, v0.t</code> adds 10 to elements 0, 1 and 2 and leaves the others as they were (<code>mu</code>: mask undisturbed). In the
        gates, a lane whose element is masked off just does not write.</p>
        <p><code>vmerge.vxm v24, v8, a2, v0</code> picks, element by element, a2 where the bit is 1 and v8's element where it is 0. With a compare in front, that clamps a vector at a threshold
        without a branch. The mask is explicit: the program, or the compiler, computes it and names it. The lanes of the following chapters will need a mask too, set implicitly by branches.
        The listing ends by adding up the clamped vector (<code>vredsum.vs</code>), the next step's subject.</p>
        <div class="try">Run “a mask you can see” to its end. In the Vector panel, v16's first three elements are 10, 11 and 12, and v24 is clamped at 6.</div>`,
      scene: scene('vmask', ['vu']),
      challenge: {
        kind: 'quiz', question: 'After <code>vmsgt.vx v0, v8, a2</code> (a2 = 6, v8 = 0 … 7), what does <code>vmerge.vxm v24, v8, a2, v0</code> put in v24?',
        options: ['0, 1, 2, 3, 4, 5, 6, 6: min(x, 6)', '6, 6, 6, 6, 6, 6, 6, 7', '0, 1, 2, 3, 4, 5, 6, 7', '7 in element 7, the rest unchanged from before'],
        answer: 0,
        why: ['', 'That takes a2 where the bit is 0; vmerge takes it where the bit is 1.', 'The mask is not all zero: element 7 is greater than 6.', 'vmerge writes every element inside vl, choosing the source by the mask.'],
        explain: 'Only element 7 has its bit set (7 > 6), so it takes a2 = 6; the others keep x.',
      },
    },
    {
      title: 'Adding up a vector',
      body: `
        <p><code>vredsum.vs v2, v8, v1</code> adds every active element of v8 to v1's element 0 and writes the sum into v2's element 0. The lanes meet in the accumulator: the first beat loads
        v1[0], then each beat an adder tree adds the four lanes' elements (two levels of adders) and the running total, and lane 0 writes the result on the last beat. At m4 that is five
        cycles for sixteen numbers; <code>vmv.x.s a0, v2</code> then brings the sum to a scalar register.</p>
        <p>A mask compare uses the same accumulator: its first beat loads the old mask word, each beat sets four bits, and the last writes the word back, so bits past vl keep their value.</p>
        <div class="try">Run “adding up a vector”: a0 ends at 136, the sum of 1 to 16.</div>`,
      scene: scene('vsum', ['vu']),
      more: {
        derive: `<p>Adding sixteen numbers on the scalar CPU takes a loop of at least a load, an add, a pointer step and a branch per number. Here the four lanes add four at a time and the tree adds
          their results: the work is the same additions, in four beats instead of sixty-odd instructions.</p>`,
      },
    },
    {
      title: 'Chaining',
      body: `
        <p>Our unit runs one instruction at a time: the loop body's six vector instructions at m8 (eight element groups each) take ${chain('serial')} cycles. The Cray-1 (1976) did better in two ways.
        It had separate functional units (add, shift, logic, multiply) beside its memory path, so independent instructions could overlap; with a unit each for loads, shifts, adds and stores the model takes ${chain('units')} cycles. And it <b>chained</b>: a dependent instruction starts on
        element group 0 as soon as its producer has written that group, while the producer is still on group 1. The loop body then takes ${chain('chained')} cycles.</p>
        <p>The widget is a timing model, not gates. Chaining in gates needs a ready bit per register group, a path from each unit's result straight to the next unit's input in every lane, and
        a queue of vector instructions so the scalar core can run ahead; our unit has none of these.</p>`,
      widget: chainWidget,
      more: {
        real: `<p>Modern vector units (Ara, the X280, the Fujitsu A64FX's SVE pipelines) chain as a matter of course, and decouple the vector unit from the scalar core with an instruction queue,
          so the scalar loop bookkeeping runs while the vectors stream.</p>`,
      },
    },
    {
      title: 'Vectors, lanes, cores',
      body: `
        <p>The kernel on four machines, each built in gates and timed by its golden model (which the gates match cycle for cycle): one single-cycle core, four of them sharing a memory (<a href="#/c/multicore/0">chapter
        ${numOf('multicore')}</a>), the core with the vector unit, and the four-lane core of the next chapter. NANDs leave out the program ROMs; time is cycles × the static-timing period at 25 ps a NAND delay.</p>
        <p>The vector unit is the fastest: ${vec.cycles} cycles (${ns(vec)} ns) against ${cores.cycles} (${ns(cores)} ns) for four cores and ${lanes.cycles} (${ns(lanes)} ns) for the lanes. Its loads move
        four words a beat, where the cores and the lanes share one memory port; and one instruction covers sixteen elements at m4, ${vec.instrs} instructions in all against ${sc.instrs} on one core.
        But its period is the longest, ${vec.period} NAND delays, and four cores cost a little less silicon for nearly the same time: per NAND, they come out about even. The strip-mined loop at m1
        takes ${lm(1).cycles} cycles; at m8 it takes ${lm(8).cycles}, more than at m4 (${lm(4).cycles}), because our unit always runs all L beats of a group, even past vl.</p>
        <p>The vector unit and the lane core are almost the same silicon: four 32-bit register-file slices and four ALUs, ${num(4 * U.slice)} NANDs of slices in each. The difference is the contract and its
        control: <code>vl</code>, <code>vtype</code>, a beat counter and <code>v0</code> here; a thread index, <span data-ahead="leader">a leader (the lowest active lane, whose results steer branches)</span> and a stack there. The next chapter begins by giving each lane the scalar program
        itself, instead of a vector instruction.</p>`,
      widget: machinesWidget,
      challenge: {
        kind: 'quiz', question: 'Why are the vector unit\'s loads faster than the lane core\'s, on the same kernel?',
        options: ['Its four banks serve four consecutive words in one beat; the lane core\'s one port serves one lane a cycle', 'It has more ALUs', 'Its clock is faster', 'It loads fewer elements'],
        answer: 0,
        why: ['', 'Both have four.', `Its period is the longer of the two: ${vec.period} against ${lanes.period} NAND delays.`, 'Both load all 32 words of x and y.'],
        explain: 'A unit-stride access is known to be four consecutive words, and the banks are built for exactly that.',
      },
      more: {
        numbers: `<p>NANDs (no ROM) and cycles: one core ${num(sc.nands)}, ${sc.cycles}; four cores ${num(cores.nands)}, ${cores.cycles}; core + vector unit ${num(vec.nands)}, ${vec.cycles}; four lanes ${num(lanes.nands)}, ${lanes.cycles}.
          Each machine runs its own version of the program, initialisation included: the cores and the lanes fill x and y with scalar stores, the vector version with vid and two vse32.</p>`,
      },
    },
    {
      title: 'Real vector machines',
      body: `
        <p>The <b>Cray-1</b> (1976) had eight vector registers of 64 elements of 64 bits, a vector length register, and chaining between its pipelined units (<a href="#/c/vectors/8">chaining</a>): the idea of this chapter,
        at about 80 MHz. Its successors and the Japanese supercomputers of the 1980s and 1990s were vector machines.</p>
        <p>The <b>Fujitsu A64FX</b> (2019, in the Fugaku supercomputer) implements Arm's SVE with 512-bit registers. SVE, like RVV, leaves the length to the machine: the same binary runs on 128-bit
        and 2048-bit implementations, as the <a href="#/c/vectors/2">strip-mining loop</a> did on the golden model at three VLENs.</p>
        <p>RISC-V vector cores range from small embedded ones with VLEN 128, like ours, to <b>Ara</b> (ETH Zürich, up to 16 lanes, VLEN up to 16 384) and the <b>SiFive X280</b>, which pairs a core with a
        512-bit vector unit for machine learning. All of them cut the register file into lane slices as our unit does (<a href="#/c/vectors/3">its register file</a>).</p>
        <p>Packed SIMD went on widening: <b>AVX-512</b> on x86 has 512-bit registers and masks. On several Intel chips running it lowered the clock (a frequency licence), because sixteen ALUs
        switching at once draw too much power, the trade the <a href="#/c/power/0">power chapter</a> measured.</p>`,
      more: {
        real: `<p>RVV's full set has fractional LMUL (a half, a quarter or an eighth of a register), widening and narrowing instructions (8-bit × 8-bit into 16-bit), segment loads for structures,
          gathers and scatters, and agnostic tail and mask policies, under which a machine may overwrite those elements with all 1s instead of leaving them. Ours implements undisturbed for both, which agnostic allows.</p>`,
        pitfall: `<p>Comparing peak numbers: a 512-bit unit does sixteen 32-bit operations a cycle only on loops that keep it fed. Memory bandwidth, the tail and the scalar bookkeeping decide what a real loop gets, as <a href="#/c/vectors/9">the four machines</a> showed.</p>`,
      },
    },
  ],
};
