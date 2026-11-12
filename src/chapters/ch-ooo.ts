import { groupDigits } from '../sim/numfmt';
import { ageBit, iqEntry, RAT, SELECT8 } from '../lib/ooo';
import RESULTS from '../bench/results.json';
import { logicDepth, stats } from '../sim/stats';
import { PAY } from '../lib/ooocore';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { oooLabWidget } from '../widgets/ooolab';
import { dataflowWidget, measuredWidget, orderWidget, robWidget, scoreboardWidget, speculationWidget } from '../widgets/ooo';
import { cpuState } from '../riscv/cosim';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

// Every number in the prose comes from riscv/ooomodel.ts, riscv/ilp.ts and riscv/scoreboard.ts on the programs
// named; tests/ooo-chapter.test.ts recomputes them. The dual-issue pipeline's (step 2) come from the gate-level CPU
// (src/bench/results.json; tests/pipe2w.test.ts).

/** Step 2's program: two vectors filled, then their dot product (72) stored at 0x80. */
export const DUAL_SOURCE = `# a[i] = i + 1 at 0x00, b[i] = 2 at 0x20 (8 words each), then a · b into 0x80
        li   a0, 0
        li   t0, 1
        li   t1, 2
        li   t3, 8
fill:   sw   t0, 0(a0)
        sw   t1, 32(a0)
        addi t0, t0, 1
        addi a0, a0, 4
        addi t3, t3, -1
        bnez t3, fill
        li   a0, 0
        li   a1, 32
        li   t3, 8
        li   s0, 0
loop:   lw   t0, 0(a0)
        lw   t1, 0(a1)
        mul  t2, t0, t1
        add  s0, s0, t2
        addi a0, a0, 4
        addi a1, a1, 4
        addi t3, t3, -1
        bnez t3, loop
        sw   s0, 128(zero)
halt:   j    halt`;

/** The loads-and-stores step's program: a divide per element holds commit back while the store and load behind it run. */
export const STORE_SOURCE = `# s0 = 8 + 7 + … + 1 through memory, a divide per element holding commit back
        li   a0, 0
        li   t3, 8
        li   t5, 3
        li   s0, 0
loop:   div  t4, t3, t5       # 19 cycles: nothing younger commits before it
        sw   t3, 0(a0)        # executes at once and waits in the store queue
        lw   t1, 0(a0)        # takes t3 from the store queue
        add  s0, s0, t1
        addi a0, a0, 4
        addi t3, t3, -1
        bnez t3, loop
        sw   s0, 64(zero)     # 36
halt:   j    halt`;

const CRC_HEAD = `# CRC-32 (as zlib) of 4 words of xorshift32 at word 0; the CRC at word 4
        li   t0, 0x2545f491   # seed
        li   t1, 0
        li   t2, 16           # 4 words
gen:    slli t3, t0, 13      # xorshift32
        xor  t0, t0, t3
        srli t3, t0, 17
        xor  t0, t0, t3
        slli t3, t0, 5
        xor  t0, t0, t3
        sw   t0, 0(t1)
        addi t1, t1, 4
        bne  t1, t2, gen
        li   a0, -1           # crc = 0xffffffff
        li   a1, 0xedb88320   # the reflected polynomial
        li   t1, 0
word:   lw   t3, 0(t1)
        xor  a0, a0, t3       # bytes enter least significant first
        li   t4, 32
`;
const CRC_TAIL = `        addi t1, t1, 4
        bne  t1, t2, word
        not  a0, a0
        sw   a0, 16(zero)
halt:   j    halt`;
/** The last step's program: CRC-32 of four words, one bit at a time, a branch on each bit. */
export const CRC4_SOURCE = CRC_HEAD + `bit:    andi t5, a0, 1
        srli a0, a0, 1
        beqz t5, next         # taken half the time, at random
        xor  a0, a0, a1
next:   addi t4, t4, -1
        bnez t4, bit
` + CRC_TAIL;
/** Its answer: the decision made data (0 or all ones, and the polynomial). */
export const CRC4_BRANCHLESS = CRC_HEAD + `bit:    andi t5, a0, 1
        srli a0, a0, 1
        neg  t5, t5           # 0 or all ones
        and  t5, t5, a1
        xor  a0, a0, t5       # the polynomial or 0: no branch
        addi t4, t4, -1
        bnez t4, bit
` + CRC_TAIL;
/** CRC-32 of xorshift32's first four words from 0x2545f491 (benchprograms.ts crc32), and the challenge's cycle budget. */
export const CRC4_VALUE = 0x32036c8a, CRC4_BUDGET = 700;
const halted = (st: Stage) => !!st.sim && st.sim.getBits(st.sim.design.root.ports.halted ?? [])[0] === 1;

/** The select step: entries from oldest to youngest (7 last: the 56-bit matrix stays an exact number), and the candidates. */
export const SELECT_ORDER = [4, 1, 6, 0, 3, 2, 5, 7], SELECT_CAND = [6, 3, 5];
const olderBits = (order: number[]) => order.reduce((m, i, a) => order.slice(a + 1).reduce((mm, j) => mm + 2 ** ageBit(i, j), m), 0);
const ratio = (a: number, b: number) => (a / b).toFixed(2);
const IQ_PAY = PAY.reduce((a, [, w]) => a + w, 0);
/** A CPU's measured period and a benchmark's CPI (src/bench/results.json, the gate-level runs). */
const period = (id: string) => RESULTS.cpus.find((c) => c.id === id)!.period;
const cpi = (id: string, bench: string) => { const r = RESULTS.cpus.find((c) => c.id === id)!.runs.find((x) => x.bench === bench)!; return (r.cycles / r.instructions).toFixed(2); };

export const chOoo: Chapter = {
  id: 'ooo', num: numOf('ooo'), title: 'Out of order', level: 'Processor',
  blurb: 'More than one instruction per cycle: dependences, renaming, a reorder buffer and speculation, priced on real programs.',
  goals: [
    'measure how much parallelism a program holds (its dataflow limit) and what width, window and prediction take from it',
    'say why an in-order machine stalls behind a slow instruction, and what reordering needs to avoid it',
    'follow a scoreboard through RAW, WAR and WAW hazards, and say which of them renaming removes',
    'trace an instruction through rename, issue queue, result bus and reorder buffer, and say why commit stays in order',
  ],
  builds: ['pipepay', 'muldiv'],
  recap: {
    keep: [
      'The dataflow limit: start each instruction the cycle its operands are ready, with unlimited width, window and prediction. The longest chain bounds every machine. On the benchmark set the ceiling runs from IPC 3.8 (crc) to 87 (matmul).',
      'In order, the first stalled instruction stops everything behind it. Reordering hides latency (the dot product, 2-wide: CPI 1.14 → 0.91 at load and multiply latency 2, 1.60 → 1.10 at 4) but adds no units: one divider still finishes one division at a time.',
      'RAW is a true dependence. WAR and WAW are clashes of names. The CDC 6600\'s scoreboard stalls on all three; renaming removes the last two.',
      'P6 style: an instruction\'s tag is its reorder-buffer entry. Dispatch renames in order, each port issues the oldest ready instruction, result buses wake the waiting ones, and commit leaves the head in order, so the register file always holds the state of a prefix of the program (a precise state).',
      'Measured on the gates, the out-of-order core has the lowest CPI (0.99) but not the shortest time: its clock is 93 NAND delays against the dual-issue pipeline\'s 80, so 92.3 delays an instruction against 83.1, for 1.85× the NANDs and 1.9× the energy. Wider and deeper helps less and less (Pollack\'s rule), and code without unpredictable branches helps every core.',
      'Speculation fills the window. Our core finds a misprediction when the branch executes and recovers when it commits. On fib a 4-entry return-address stack takes CPI from 1.29 to 0.99, recovering at execute would give 0.92, and perfect prediction 0.63: on these programs the front end limits more than the window.',
    ],
    check: [
      {
        question: 'A program\'s dataflow limit is IPC 3.8. What does that bound?',
        options: ['Every machine running it, whatever its width, window or predictor', 'Only an out-of-order machine with a 16-entry window', 'Only machines without branch prediction', 'The number of instructions fetched per cycle'],
        answer: 0,
        explain: 'The dataflow schedule keeps only the dependences and the latencies. Any real machine adds limits on top, so none can beat it.',
        why: ['', 'The limit assumes an unlimited window; a 16-entry one can only do worse.', 'It assumes perfect prediction: branches cost nothing in it.', 'Fetch width is one of the limits it leaves out.'],
      },
      {
        question: 'Which hazards does register renaming remove?',
        options: ['WAR and WAW', 'RAW only', 'RAW, WAR and WAW', 'Structural hazards'],
        answer: 0,
        explain: 'WAR and WAW arise because two values share a register name. Give every new value its own name (a ROB entry) and they disappear. RAW is the program\'s own dataflow.',
        why: ['', 'RAW is a true dependence: the value does not exist until its producer runs.', 'No hardware can remove RAW: the consumer needs the value.', 'A busy unit is a lack of hardware, not of names: renaming adds no divider.'],
      },
      {
        question: 'Why does our core commit in order, when it executes out of order?',
        options: ['So the register file always holds the state of a prefix of the program, and a mispredicted path can be thrown away', 'Because the register file has only one write port', 'Because results arrive in order anyway', 'To save the cost of the result buses'],
        answer: 0,
        explain: 'Values wait in the ROB until every older instruction has committed. When a branch turns out mispredicted, everything younger is still uncommitted and is simply dropped.',
        why: ['', 'It has two write ports, one per committing instruction.', 'They do not: a load can finish after a younger add.', 'The result buses serve execution, not commit.'],
      },
    ],
  },
  parts: [['Why reorder', 3], ['Hazards and renaming', 2], ['The machinery in gates', 4], ['Branches and memory', 2], ['The whole core', 2], ['Your turn', 2]],
  steps: [
    {
      title: 'How much parallelism is there?',
      body: `
        <p>Every machine so far finishes at most one instruction per cycle; the best pipeline averages CPI 1.26 on the
        benchmark set. Going below 1 means starting several instructions per cycle, and they must not depend on each
        other. How many such instructions does a program offer?</p>
        <p>The trace answers that. Take the golden model's run, start each instruction the cycle its last operand is
        ready, give it its latency (ALU 1, load 2, multiply 2, divide 19), and ignore everything else: width, window,
        branches. The longest chain of dependences is a lower bound on time for <em>any</em> machine, and
        instructions ÷ chain length is the ceiling on IPC (instructions per cycle).</p>
        <p>The ceilings are high and uneven: fib 10.3, sort 10.6, matmul 87, crc 3.8. matmul's iterations hardly depend
        on each other; crc feeds every bit into the next. Reaching them would take a machine that sees thousands of
        instructions ahead and knows every branch in advance. The rest of the chapter prices getting part of the way.</p>
        <p>Each limit the model leaves out is one a real machine adds back, and the chapter takes them in turn: width (how many instructions start per
        cycle), the window (how far ahead the machine can see), the units (one divider is one divider), the predictor (what it fetches past a branch) and
        memory. The ceiling is a bound for comparison, not a target: it shows which programs have something to gain from all the hardware that follows, and which
        (crc) have almost nothing.</p>`,
      widget: dataflowWidget,
      more: {
        derive: `<p>With L the length in cycles of the longest dependence chain and N the instruction count, time ≥ L and IPC ≤ N / L. A chain of k dependent single-cycle
          adds has L = k and IPC ≤ 1: nothing to overlap. k independent adds have L = 1 and IPC ≤ k. A loop mixes the two: the iteration's own chain sets L per
          iteration, the iterations overlap when they do not depend on each other (matmul) and do not when each feeds the next (crc).</p>`,
        real: `<p>Limit studies of this kind (David Wall's, in the early 1990s) found that real integer programs, given realistic prediction and a finite window, offer a few
          instructions per cycle, far under the perfect-machine ceiling. That is the reason the industry's wide cores stop at 4 to 10 wide.</p>`,
        pitfall: `<p>Reading the ceiling as what a bigger machine will reach. It assumes unlimited width, an unlimited window and perfect prediction; every later step of
          the chapter takes one of these away.</p>`,
      },
    },
    {
      title: 'Two at a time, in order',
      body: `
        <p>The obvious first step is two pipelines side by side: the balanced RV32IM pipeline with prediction, twice.
        <span data-show="imem">Fetch reads two words a cycle</span> (pc and pc + 4) and <span data-show="btb">the BTB
        looks both up</span>; a slot predicted taken ends the pair. Decode issues the second instruction beside the first
        unless <span data-show="pair">the pair check</span> says no: lane 1 has no data memory, multiplier or divider, a
        pair carries at most one control instruction (one redirect, one predictor update), nothing pairs with a divide,
        and the second may not read the first one's result. Then the first goes alone, and the second moves up a slot
        while the PC holds for a cycle.</p>
        <p>The rest is the single pipeline twice, wired across: <span data-show="rf">a register file with four read and
        two write ports</span>, <span data-show="hz">forwarding from both lanes' M and W stages, the younger lane
        first</span> (it wrote last), and a misprediction in lane 0 killing lane 1's instruction in E (it is younger).
        Returns are predicted by a <span data-show="ras">4-entry return-address stack</span>. Up to two instructions
        retire a cycle: the golden model steps once for each, and the diagram shows each stage's second lane under
        it.</p>
        <p>Measured on the benchmark set: 193 768 NANDs against 141 655 for one lane, the balanced RV32IM pipeline with its predictor (+37 %; both without the program ROM, with the benchmarks' 64-word data memory), a clock period of 80 NAND
        delays against 79, and CPI fib 1.13, sort 1.01, matmul 1.05, matmul-m 1.09, crc 0.97 against 1.35, 1.18,
        1.30, 1.25, 1.23. Only 29 to 53 % of the instructions go in pairs; the others wait for a result, the one memory
        lane or a branch. About a sixth less time for a third more gates.</p>
        <p>Why not more gain: the second lane is a copy of the ALU and its forwarding paths, so its cost is the cost of a lane; its benefit is only the cycles in which
        two adjacent instructions are independent and not both memory or control. The register file is the other price: four read ports and two write
        ports instead of two and one, which grows a flip-flop array's read multiplexers and write decoder by the port count.</p>`,
      scene: () => cpuScene({ source: DUAL_SOURCE, wide: true, highlight: ['pair', 'hz', 'rf'] }),
      tour: {
        beats: [
          { title: 'Filling the pipeline', reset: true, cycles: 4, show: ['pc', 'imem', 'FD', 'FD1'], expect: { retire: 2, pcW0: 0 },
            say: '<p>Four edges in, two instructions are in Writeback together: <code>li a0, 0</code> and <code>li t0, 1</code>, {v:retire} retired. Fetch is already at {v:pcF}, three pairs ahead.</p>' },
          { title: 'A pair a cycle', cycles: 1, show: ['alu', 'alu1'], expect: { retire: 2, pcW0: 8 },
            say: '<p>The next two <code>li</code>s, at {v:pcW0} and 12, were independent and neither touches memory: they issued together, one in each lane.</p>' },
          { title: 'Memory only in lane 0', cycles: 1, show: ['pair', 'dm'], expect: { retire: 1, pcW0: 16 },
            say: '<p>Now two stores in a row. Lane 1 has no data memory, so the pair check sends the first alone: {v:retire} retires, <code>sw</code> at {v:pcW0}.</p>' },
          { title: 'The second store alone too', cycles: 1, show: ['pair', 'dm'], expect: { retire: 1, pcW0: 20 },
            say: '<p>The second store moved up to lane 0 and goes alone as well (pcW0 = {v:pcW0}). Two cycles for two instructions: the pair rule cost a cycle.</p>' },
          { title: 'Independent again', cycles: 1, show: ['alu', 'alu1'], expect: { retire: 2, pcW0: 24 },
            say: '<p>The two <code>addi</code>s behind them are independent: two retire at {v:pcW0}.</p>' },
        ],
      },
      more: {
        derive: `<p>If a fraction p of the instructions go in pairs, N instructions take about N(1 − p / 2) cycles with no other stalls: each pair saves a cycle. At the
          quoted range of 29 to 53 % that is ${(100 * (1 - 0.29 / 2)).toFixed(0)} to ${(100 * (1 - 0.53 / 2)).toFixed(0)} % of the cycles at best; branches and load-use stalls take part of
          the gain back, which is why the measured gain is smaller.</p>`,
        real: `<p>In-order dual-issue is how many mid-range cores are built: the original Pentium (two pipes, U and V), ARM's Cortex-A53, SiFive's U74. They issue in pairs under
          rules like this one and stall on the first non-ready instruction, which is the weakness the next steps address.</p>`,
        pitfall: `<p>Reading "2-wide" as "twice as fast". The pair rules are conservative (no second memory access, one control instruction, no dependence on the first
          result) and the second slot often holds an instruction that needs the first: on these programs the 2-wide core issues a single instruction in most cycles. Watch pcW0 move by 4 in some cycles and 8 in others.</p>`,
      },
    },
    {
      title: 'Where in-order stops',
      body: `
        <p>That pipeline is still in order: the first instruction that waits stops everything behind it, in both
        lanes.</p>
        <p>Below, the dot product runs on two 2-wide machines with the same front end, ports and latencies. In order,
        the add waits for the multiply, and the next element's loads wait behind the add. Out of order, those loads go
        while the multiply runs. At load and multiply latency 2 that is CPI 1.14 against 0.91; at latency 4, 1.60
        against 1.10. Reordering hides latency, and the longer the latency, the more it hides.</p>
        <p>It cannot add hardware. Switch to <em>Two chains</em>: every element needs the divider for 19 cycles, and
        there is one divider. Both machines run at its pace (CPI 4.13 against 3.72).</p>
        <p>The two results say what reordering is for: it finds work to do <em>during</em> a wait, and it can only find work that exists. A wait on latency (a load, a
        multiply) leaves independent instructions to run; a wait on a unit that is the bottleneck leaves none, because every candidate needs that unit too. Hardware cannot
        turn a serial program into a parallel one.</p>`,
      widget: orderWidget,
      more: {
        derive: `<p>In order, a dependent instruction one slot behind a producer of latency L waits L − 1 cycles, and everything behind it waits too. Out of order, the
          wait is filled by instructions from later in the program that are ready; the saving is at most min(L − 1, r) cycles per stall, r being the number of ready
          instructions the window holds. Longer latency and a longer window both help; with no ready instruction (the divider case) r = 0 and the saving is 0.</p>`,
        real: `<p>This is the case for out-of-order execution on loads: a load that misses the cache is a latency of hundreds of cycles, and a window of hundreds of
          instructions finds the independent work behind it. Narrow in-order cores avoid the cost by not having much to hide: small caches, short latencies.</p>`,
        pitfall: `<p>Expecting a faster divider from reordering. The out-of-order machine does the same divides at the same rate; it only overlaps the instructions between them.
          If every iteration needs the divider, the divider sets the pace.</p>`,
      },
    },
    {
      title: 'The scoreboard (CDC 6600, 1964)',
      body: `
        <p>Seymour Cray's CDC 6600 was the first machine to execute out of order. Its scoreboard records, for each
        functional unit, the instruction it holds, its registers, and which units will produce its sources.
        Instructions issue in order, then read operands, execute and write as soon as they may.</p>
        <p>Three hazards decide the waits. <strong>RAW</strong> (read after write) is a true dependence: the reader
        waits for the value. <strong>WAW</strong> (write after write): while one instruction in flight writes a
        register, another that writes it may not issue, or the older value could land last. <strong>WAR</strong>
        (write after read): an instruction may not overwrite a register that an earlier one has yet to read.</p>
        <p>Step through Hennessy and Patterson's example with its latencies (add 2, multiply 10, divide 40; the real 6600 divided in 29). The add
        is done at cycle 16 but may not write t1 until cycle 22, because the divide, still waiting for the multiply,
        has yet to read the old t1. The second load waits at issue because the one load unit is busy. Only RAW is a
        real dependence. WAR and WAW are clashes of names: the program reuses t1 for a new value. <em>Reused
        names</em> shows WAW stopping issue.</p>
        <p>The scoreboard also shows the limit of working with names. It never renames: every WAR and WAW wait is a wait for the name to be free, not for a value, and it
        grows with how often the compiler reuses registers. A small register set means the program reuses names constantly, which is what step 5 removes.</p>`,
      widget: scoreboardWidget,
      more: {
        derive: `<p>The scoreboard's four stages and what each checks. Issue (in order): the functional unit is free, and no active instruction has the same destination (WAW).
          Read operands: both source registers are ready (RAW), meaning no unit is yet to write them. Execute: the unit's latency. Write result: no earlier instruction still has to read
          the old value of this destination (WAR). A stall at issue blocks everything behind it; stalls at read and write block only that unit.</p>`,
        real: `<p>The CDC 6600 had ten functional units behind its scoreboard and was the fastest machine of its day. Tomasulo's 1967 refinement for the IBM 360/91 added
          renaming through reservation stations, which is the idea the rest of the chapter builds out; the 6600's scheme survived in simple designs.</p>`,
        pitfall: `<p>Reading a WAR wait as a data dependence. In the example the add has its result at cycle 16 and still waits to cycle 22: nothing in the add depends on
          the divide, which only has not yet read the register the add wants to write. A different destination register would have no wait at all.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'In the example, the add has its result at cycle 16. Why does it write t1 only at cycle 22?',
        options: ['The divide has yet to read the old t1 (WAR)', 'The add depends on the divide (RAW)', 'Another instruction in flight also writes t1 (WAW)', 'The ALU is busy'],
        answer: 0,
        explain: 'The divide waits for the multiply\'s t0, so it has not read t1 yet. Writing t1 earlier would hand it the add\'s value instead of the load\'s. It reads at 21; the add writes at 22.',
        why: ['', 'The add reads t3 and t2, neither written by the divide.', 'The add issued at 13: a WAW would have stopped it at issue, not at write.', 'The ALU finished the add at 16; it is the write that waits.'],
      },
    },
    {
      title: 'Rename, wait, commit in order',
      body: `
        <p>Robert Tomasulo's algorithm for the IBM 360/91 (1967) removes the false hazards by renaming: each result
        gets a fresh name, a tag, and readers name the tag instead of the register. Our core uses the form of the
        Pentium Pro (1995): the tag is the instruction's entry in a <strong>reorder buffer</strong> (ROB).</p>
        <p><strong>Dispatch</strong>, in order, two per cycle: each instruction takes the next ROB entry, and the
        rename table maps its destination register to that entry. Each source comes from the register file, from a
        ROB entry already done, or stays a tag. The instruction then waits in an 8-entry issue queue.</p>
        <p><strong>Issue</strong>, out of order: each of the two ports picks the oldest instruction whose operands
        are ready. A result goes out on its port's result bus; every waiting entry compares the bus's tag with its
        operand tags (wakeup) and takes the value. Wakeup and pick happen in one cycle, so a dependent instruction
        issues the cycle after its producer.</p>
        <p><strong>Commit</strong>, in order: up to two done entries leave the head of the ROB per cycle and write the
        register file. A younger instruction may finish first, but its value waits in the ROB. So the register file
        always holds exactly what the program has done up to some instruction, and a mispredicted path (or, in a core
        with traps, a fault) can be thrown away.</p>
        <p>Step through the dot product: the ROB fills, the second element's loads issue before the first element's
        add, and entries leave in program order.</p>
        <p>The cost of this arrangement is capacity. An instruction holds its ROB entry from dispatch to commit, so the window is the ROB: when the oldest instruction is slow
        (a divide, a load that misses), younger ones finish and wait in their entries, and once all 16 are taken dispatch stops. The ROB size is the number of instructions the
        machine can have in flight, and it is why the next steps cost what they do.</p>`,
      widget: () => robWidget('dot'),
      more: {
        derive: `<p>Renaming removes a false dependence by giving each destination a new name. A sequence <code>add t1, t2, t3</code>; <code>sub t4, t1, t5</code>;
          <code>mul t1, t6, t7</code> has a WAW (two writes to t1) and a WAR (the sub reads t1 before the mul writes it). With tags: the add writes entry 3, the sub names tag 3 as its
          source, the mul writes entry 5 and the rename table now maps t1 to 5. Nothing waits on the name t1; only the sub waits on the value of entry 3 (a true RAW).</p>`,
        real: `<p>The Pentium Pro (1995) put this design in a PC: a 40-entry reorder buffer and three-wide dispatch. Windows have grown by an order of magnitude since:
          224 entries in Intel's Skylake, over 500 in recent Apple and Intel cores. The ROB is a large share of such a core's area, and the reason the window cannot simply be doubled.</p>`,
        pitfall: `<p>Calling commit "the slow part". Execution is out of order and fast; commit only retires in program order what has finished. What commit order costs is capacity:
          one slow instruction at the head fills the window behind it. Look at the divide in "Loads and stores": nothing commits for the divide's 19 cycles, and the ROB fills.</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: 'An instruction in the issue queue shows a source as #5. What is it waiting for?',
        options: ['The instruction in ROB entry 5 to put its result on a result bus', 'Register x5 to be written by a commit', 'Issue-queue entry 5 to be picked', 'Five cycles to pass'],
        answer: 0,
        explain: 'The rename table mapped that source register to ROB entry 5 at dispatch. When entry 5\'s instruction executes, its tag goes out on a result bus and the waiting entry takes the value.',
        why: ['', 'The tag names a ROB entry, not a register. Waiting for the commit would add cycles for nothing: the value is on the bus first.', 'Tags are ROB entries; issue-queue entries are not named.', 'Waiting is by tag match, not by a count.'],
      },
    },
    {
      title: 'The rename table in gates',
      deep: true,
      body: `
        <p>This is our core's rename table at gate level. <span data-show="rows">31 rows</span>, one per register (x0 is
        never renamed), each hold a valid bit and a 4-bit tag: the reorder-buffer entry of the youngest instruction in
        flight that writes the register. Each row recognizes its own register number among the four that can touch it
        in a cycle: the two destinations dispatch maps and the two that commit unmaps.</p>
        <p><span data-show="rd0 rd1 rd2 rd3">Four read ports</span> look up the sources of the pair being dispatched. The
        second instruction's sources also <span data-show="byp2 byp3 by2 by3">compare against the first's
        destination</span>: the first maps it in this same cycle, too late for the table to answer. At commit,
        <span data-show="rc0 rc1">two more read ports</span> check that the register still names the committing entry;
        only then does it go back to the register file (a younger writer keeps it). A flush clears every valid bit at
        once. We recover at commit, when everything older has committed, so the register file is then exactly
        right.</p>
        <div class="try">The scene dispatches a pair writing <code>t0</code> (entry 3) and <code>t1</code> (entry 4),
        and the second reads <code>t0</code>: its lookup (<code>a1v</code>, <code>a1t</code>) says entry 3 already.
        Pulse the clock: rows t0 and t1 now hold their tags.</div>
        <p>Cost: 12 443 NANDs, of which the 31 rows take 275 each.</p>
        <p>The table is small in bits (${31 * 5} flip-flops) and large in ports. Four reads, two commit compares and two writes a cycle, each across all 31 rows, are what make it
        12 443 NANDs; the number of ports, not the number of entries, sets its cost and its delay, so it limits how wide a machine can dispatch.</p>`,
      scene: () => ({ root: RAT, autoClock: false, inputs: { rs1_0: 10, rs2_0: 11, rs1_1: 5, rs2_1: 0, rd0: 5, we0: 1, tag0: 3, rd1: 6, we1: 1, tag1: 4, clk: 0 }, highlight: ['rows', 'by2'] }),
      tries: [(st) => st.value('a1v') === 1 && st.value('a1t') === 3],
      tour: {
        beats: [
          { title: 'An unrenamed source', show: ['rows'], expect: { a0v: 0, b0v: 0 },
            say: '<p>The first instruction reads x10 and x11. No instruction in flight writes them, so the table has no tag: <code>a0v</code> = {v:a0v}, <code>b0v</code> = {v:b0v}, and the operands come from the register file.</p>' },
          { title: 'Same-cycle dependence', show: ['by2', 'by3'], expect: { a1v: 1, a1t: 3 },
            say: '<p>The second instruction reads x5, which the first writes in this very cycle (<code>tag0</code> = 3). The table cannot know yet, but the bypass comparators can: <code>a1v</code> = {v:a1v}, <code>a1t</code> = {v:a1t}.</p>' },
          { title: 'The edge', cycles: 1, show: ['rows'], expect: { a1v: 1, a1t: 3 },
            say: '<p>One clock edge writes both mappings into the table: x5 → entry 3, x6 → entry 4. The answer for the second instruction does not change: the row now holds the same tag, and while <code>we0</code> is high the bypass goes on giving it too. Once dispatch stops (next beat), the row alone answers.</p>' },
          { title: 'A later lookup', set: { we0: 0, we1: 0, rs1_0: 5, rs2_0: 6 }, show: ['rows', 'rd0', 'rd1'], expect: { a0v: 1, a0t: 3, b0v: 1, b0t: 4 },
            say: '<p>With nothing being dispatched, a lookup of x5 and x6 reads the rows: x5 waits for entry {v:a0t}, x6 for entry {v:b0t}.</p>' },
        ],
      },
      more: {
        derive: `<p>Storage: 31 rows × (1 valid + 4 tag bits) = ${31 * 5} flip-flops; a 16-entry ROB needs 4 bits to name an entry. Ports: each of the two dispatched instructions reads two
          sources (4 reads) and writes one destination (2 writes), and commit adds 2 compare-and-clear ports. A row recognizes its register from the 5-bit numbers on 4 ports, which is why a
          row costs 275 NANDs against a row of plain flip-flops: ${groupDigits(stats(RAT).nands)} NANDs for the table.</p>`,
        real: `<p>Big cores keep the rename table as a RAM, not rows of comparators, and checkpoint it at each branch so a misprediction restores it at once. That copy per branch
          in flight is what recovery at execute needs, and it is the table's main cost there.</p>`,
        pitfall: `<p>Forgetting the same-cycle case. Without the bypass, the second instruction of a pair that reads the first's destination reads the old mapping and takes
          a stale register-file value. <code>a1v</code> and <code>a1t</code> would show the previous owner, or none, until the next cycle.</p>`,
      },
    },
    {
      title: 'Wakeup (Tomasulo, IBM 360/91, 1967)',
      deep: true,
      body: `
        <p>Tomasulo's reservation stations held an instruction with, for each operand, either its value or the tag of
        the unit that would produce it. Every result went out on the Common Data Bus with its tag, and every station
        compared. Our issue-queue entry is the same idea with reorder-buffer tags: the instruction's
        <span data-show="payR">payload</span> (${IQ_PAY} bits: tag, PC, immediate, predicted next PC, control) and, per
        operand, <span data-show="rdyAQ rdyBQ">a ready bit</span>, <span data-show="valAQ valBQ">a 32-bit value</span>
        and <span data-show="tags">a producer tag</span>.</p>
        <p>Each cycle two result buses carry a tag and a value each. <span data-show="e0A e1A e0B e1B">Four 4-bit
        comparators</span> (two operands × two buses) watch them. A waiting operand whose tag matches wakes:
        <span data-show="rdy">ready</span> rises in the same cycle and <code>opA</code> passes the bus value straight on,
        so the entry can be picked at once; the clock edge then captures the value. That pass-through is what lets a
        dependent instruction issue the cycle after its producer.</p>
        <div class="try">Pulse once: the entry fills, operand B ready (7), operand A waiting for entry 5.</div>
        <div class="try">Set <code>alloc</code> to 0 and <code>bv0</code> to 1: bus 0 now carries tag 5 with the value 42.
        <code>ready</code> rises before any clock edge, and <code>opA</code> (the bus value, passed on while the operand
        waits) is what the port would take.</div>
        <p>4247 NANDs an entry, eight entries. The four comparators are a small part of that: storage and 32-bit
        multiplexers are most of it. Big cores keep scores of entries and read the operands after issue, so an entry holds
        no values; there the comparators, tags × buses × entries, are what grows.</p>`,
      scene: () => ({
        root: iqEntry(IQ_PAY), autoClock: false, highlight: ['e0A', 'e1A', 'e0B', 'e1B'],
        inputs: { alloc: 1, port: 0, load: 0, div: 0, lat2: 0, tagA: 5, rdyA: 0, valA: 0, tagB: 0, rdyB: 1, valB: 7, smask: 0, pay: 0, bv0: 0, bt0: 5, bx0: 42, bv1: 0, bt1: 0, bx1: 0, sdone: 0, pick: 0, flush: 0, clk: 0 },
      }),
      tries: [(st) => st.value('valid') === 1, (st) => st.value('ready') === 1 && st.value('opA') === 42],
      tour: {
        beats: [
          { title: 'Dispatch fills the entry', cycles: 1, show: ['payR', 'rdyAQ', 'rdyBQ'], expect: { valid: 1, ready: 0 },
            say: '<p>One edge: the entry is valid ({v:valid}). Operand B was ready at dispatch (value 7); operand A names a producer, ROB entry 5, so the entry is not ready: <code>ready</code> = {v:ready}.</p>' },
          { title: 'The producer\'s tag arrives', set: { alloc: 0, bv0: 1 }, show: ['e0A', 'tags'], expect: { ready: 1, opA: 42 },
            say: '<p>Bus 0 now carries tag 5 with the value 42. The comparator for operand A against bus 0 matches: <code>ready</code> rises at once, before any edge, and <code>opA</code> = {v:opA} is the bus value passed straight on.</p>' },
          { title: 'The edge captures it', cycles: 1, show: ['valAQ'], expect: { ready: 1, opA: 42 },
            say: '<p>The clock edge stores the value in the entry: operand A now holds {v:opA} itself.</p>' },
          { title: 'The bus moves on', set: { bv0: 0 }, show: ['valAQ', 'rdyAQ'], expect: { ready: 1, opA: 42 },
            say: '<p>With the bus idle again the entry is still ready and still holds {v:opA}: it waited for a value once, and has it.</p>' },
        ],
      },
      more: {
        derive: `<p>Per operand and per bus, a tag comparator: the entry's 4-bit tag against the bus tag, ANDed with the bus's valid bit. Two operands × two buses = four comparators per
          entry, and an entry is ready when both operands are, each being ready-already or matched-now. Timing of the loop: the producer's pick, then its result on the bus,
          then the match and the select in the same cycle, so the consumer picks the cycle after: tag broadcast, compare, AND-OR and select must fit in the period.</p>`,
        real: `<p>Large cores split the entry: a payload RAM read after issue, and a small wakeup array holding only tags and ready bits. Matching tags × bus ports × entries is
          the wakeup array's cost, and it grows faster than the window, so wide cores split the queue into clusters.</p>`,
        pitfall: `<p>Waking on the clock edge instead of in the cycle. If the comparator only set ready at the next edge, a chain of dependent adds would run every other
          cycle. Here <code>ready</code> rises as soon as the bus carries the tag, and <code>opA</code> passes the value on: set <code>bv0</code> and see it before pulsing.</p>`,
      },
    },
    {
      title: 'Choosing who goes',
      body: `
        <p>Each port picks the oldest ready entry bound to it: the oldest first drains the head of the reorder buffer,
        and commit waits on nothing else. The entries are not kept in order, though (a freed slot takes whatever comes
        next), and keeping them sorted would mean shifting ~200-bit entries every cycle. Instead an <strong>age
        matrix</strong> records, for every ordered pair of entries, which holds the older instruction: 56 bits for eight
        entries, 1536 NANDs. A new entry is younger than every entry present: its row clears and its column sets.</p>
        <p>Select is then two wide stages. Entry e wins when it is a candidate and no other candidate is older:
        <span data-show="blk6">an OR over seven ANDs</span>, <span data-show="g6">then an AND with its own
        request</span>. The whole grant word is 280 NANDs and 11 NAND delays deep, with no chain from entry 0 to 7 as in a
        priority encoder.</p>
        <div class="try">Entries 6, 3 and 5 are candidates, and the matrix orders the entries 4, 1, 6, 0, 3, 2, 5, 7 from
        the oldest: 6 gets the grant. Clear its bit in <code>cand</code>: 3 wins.</div>
        <p>Wakeup and select together are the loop that sets the clock: a result's tag arrives on a bus, the waiting entry
        wakes, select picks it, and its operands reach the port's register, all within one cycle, or a chain of dependent
        additions cannot run back to back. It is the loop designers fight for; in our core the 93 NAND delays against the
        pipeline's 80 come from the path beside it: the divider's result, its result bus and the operand bypass. Port binding sat on the critical path at first, when dispatch counted each port's entries after this cycle's
        picks; counting before the picks and taking them off in parallel moved it off.</p>`,
      scene: () => ({ root: SELECT8, inputs: { cand: SELECT_CAND.reduce((m, e) => m | (1 << e), 0), older: olderBits(SELECT_ORDER) }, highlight: ['blk6', 'g6'] }),
      tries: [(st) => st.value('grant') === 1 << 3],
      tour: {
        beats: [
          { title: 'Three candidates', show: ['blk6', 'g6'], expect: { grant: 1 << 6 },
            say: '<p>Entries 6, 3 and 5 are ready. The age matrix orders the entries 4, 1, 6, 0, 3, 2, 5, 7 from the oldest, so of the three, 6 is the oldest: <code>grant</code> = {b:grant}, entry 6 only.</p>' },
          { title: 'The oldest leaves', set: { cand: (1 << 3) | (1 << 5) }, show: ['blk6', 'g6'], expect: { grant: 1 << 3 },
            say: '<p>Clear 6 from the candidates (it was picked, or is no longer ready). The grant moves to the oldest of the rest: entry 3, <code>grant</code> = {b:grant}.</p>' },
          { title: 'A lone candidate', set: { cand: 1 << 5 }, expect: { grant: 1 << 5 },
            say: '<p>With only entry 5 ready it wins whatever its age: {b:grant}.</p>' },
          { title: 'Nobody ready', set: { cand: 0 }, expect: { grant: 0 },
            say: '<p>No candidate, no grant: the port issues nothing this cycle.</p>' },
        ],
      },
      more: {
        derive: `<p>With older[i][j] = 1 when entry i is older than j, entry e is granted when cand[e] AND NOT (OR over j ≠ e of (cand[j] AND older[j][e])): nobody older is a
          candidate. That is an OR over 7 ANDs and one more AND per entry, two wide stages whatever the position of the entry. The matrix holds one bit for each of the
          ${8 * 7} ordered pairs. Select alone is ${stats(SELECT8).nands} NANDs, ${logicDepth(SELECT8)} NAND delays deep.</p>`,
        real: `<p>Cores that issue by age keep the matrix; others pick by position in a collapsing queue, or pick the oldest ready instruction approximately (a random pick,
          or the first of each bank). The pick plus the wakeup is the loop that sets the clock, and wide cores spend design effort cutting it.</p>`,
        pitfall: `<p>Picking by position. An entry that sits in slot 0 is not the oldest: a freed slot takes whatever comes next. Pick by slot number and the youngest instruction may
          win while an older one that the ROB head is waiting for starves. With 6, 3 and 5 as candidates the grant is 6, not the lowest slot: it follows the age matrix, not the index.</p>`,
      },
    },
    {
      title: 'The reorder buffer, in gates',
      body: `
        <p>The reorder buffer is shown in place, inside the complete core (the step "The whole core" counts its cost): <span data-show="pc imem btb ras fp">fetch</span> of two words a cycle with the BTB and
        the return stack, <span data-show="dc rat bind">decode, rename and binding to a port</span>, <span data-show="iq">the
        issue queue</span>, two ports with <span data-show="e1_0 e1_1">an ALU each</span>, and on port 1
        <span data-show="mule mulm div">the multiplier and the divider</span>, <span data-show="rob">the reorder
        buffer</span> and <span data-show="cm rf">commit into the register file</span>.</p>
        <p><span data-show="rob">The reorder buffer</span> is the largest block: 16 entries of 109 bits (done; the
        destination, PC and kind of control transfer, written at dispatch; the value, the real next PC and a mispredict
        bit, written by a result bus), 70 541 NANDs. Up to two entries leave the head a cycle, at most one of them a
        store, and write the register file. The core's <code>retire</code> output counts them and the golden model steps
        once per commit, so the CPU panel compares the registers after every commit even though instructions finish out of
        order.</p>
        <p>The Out of order panel reads the reorder buffer, the issue queue, the rename table and the store queue from
        their registers. Its timeline is the model of the earlier steps, running beside the gates: every cycle both must
        commit the same instructions and pick the same one on each port. Click an instruction in either panel to light
        the hardware it uses. The program is step 2's dot product, on the cycle engine.</p>
        <p>Read the commit count first. A cycle that retires two instructions is the machine at its width; a cycle that retires none is a bubble at the head of the buffer.
        The first loop of the program (the fill) shows both, and the second time round shows what the branch target buffer changes.</p>`,
      scene: () => cpuScene({ source: DUAL_SOURCE, ooo: true, highlight: ['rob', 'cm', 'rf'] }),
      tour: {
        beats: [
          { title: 'First commit', reset: true, cycles: 4, show: ['pc', 'imem', 'rob'], expect: { retire: 2, pcW0: 0 },
            say: '<p>Four edges in, the first two instructions leave the head of the reorder buffer: <code>li a0, 0</code> and <code>li t0, 1</code>, {v:retire} retired, oldest at {v:pcW0}.</p>' },
          { title: 'A store goes alone', cycles: 2, show: ['rob', 'cm'], expect: { retire: 1, pcW0: 16 },
            say: '<p>The loop starts at {v:pcW0} with <code>sw</code>, <code>sw</code>. Commit takes at most one store a cycle, so the pair breaks up: {v:retire} instruction retires.</p>' },
          { title: 'The loop branch', cycles: 3, show: ['rob', 'btb'], expect: { retire: 1, pcW0: 36 },
            say: '<p>The <code>bnez</code> at {v:pcW0} commits alone. The BTB had never seen it, so fetch ran on past the loop and the instructions behind the branch are on the wrong path.</p>' },
          { title: 'The flush', cycles: 1, show: ['rob', 'rat', 'rf'], expect: { retire: 0 },
            say: '<p>The misprediction is acted on at commit: everything younger is dropped, the rename table is cleared, fetch restarts at the loop. Nothing commits this cycle (retire = {v:retire}), nor the next three.</p>' },
          { title: 'Refilled', cycles: 4, show: ['pc', 'rob'], expect: { retire: 1, pcW0: 16 },
            say: '<p>Four cycles later the first store of the loop commits again at {v:pcW0}: four cycles with no commit, the price of recovering at the head of the buffer.</p>' },
          { title: 'Predicted', cycles: 4, show: ['btb', 'rob'], expect: { retire: 1, pcW0: 16 },
            say: '<p>This time round the <code>bnez</code> committed in the cycle before, and the next iteration\'s first store commits straight after it: the BTB learned the branch, and the gap is gone.</p>' },
        ],
      },
      more: {
        derive: `<p>The reorder buffer's storage: 16 entries × 109 bits = ${16 * 109} flip-flops, which with the ports (two allocations, two commits, two result buses writing, operands read by tag)
          is why the buffer takes more NANDs than any other block. Commit throughput: 2 a cycle, at most one store. A flush costs the distance from the branch to the head
          plus the refill of the front end, which the tour shows as the zero-commit cycles.</p>`,
        real: `<p>Intel's Skylake retires 4 micro-ops a cycle; Apple's recent cores decode and rename 8. Recovery is faster in real cores: the branch's checkpoint is restored when it
          resolves, without waiting for it to reach the head, which is the "recover at execute" row of the speculation table.</p>`,
        pitfall: `<p>Reading the CPU panel's golden-model check as a statement about timing. The ISS agrees after every <em>commit</em> because the registers change only there; it says nothing
          about which cycle an instruction executed in. The Out of order panel's timeline, from the model, is what checks the timing.</p>`,
      },
    },
    {
      title: 'Guessing past branches',
      body: `
        <p>A 16-entry window is eight cycles of fetch at two per cycle, and these programs branch every two to four
        instructions. The window fills only by predicting branches and fetching down the predicted path:
        <strong>speculation</strong>. Wrong-path instructions are renamed and executed like any other; they never
        commit.</p>
        <p>Our core finds a misprediction when the branch executes and recovers when it commits: it flushes
        everything younger, resets the rename table (every register is then in the register file, since everything
        older has committed) and restores the return-address stack from its committed copy. That is simple, but the
        branch must first reach the head of the ROB.</p>
        <p>The table prices it. On fib, the BTB alone mispredicts 613 times, mostly at the one <code>ret</code>, which
        returns to two call sites in turn. A 4-entry return-address stack cuts that to 287 and CPI from 1.29 to 0.99.
        Recovering when the branch executes, which needs a copy of the rename table for every branch in flight, gives
        0.92. Perfect prediction would give 0.63: on these programs the front end limits more than the window.
        matmul's software multiply and crc branch on data bits, which no predictor learns.</p>
        <p>Speculation turns the window from a bound on latency tolerance into a bet. Each fetched branch is a guess; the cost of a wrong one is every cycle between
        the guess and the recovery, times the width, in slots that did no committed work. Hence two levers: guess better (the return stack), or find out sooner
        (recover at execute). The table prices each, and the third, perfect prediction, as the bound on both.</p>`,
      widget: speculationWidget,
      more: {
        derive: `<p>The penalty of a misprediction is the time from fetching the branch to restarting fetch on the right path: the pipeline to execute, plus (here) the time for the
          branch to reach the head of the reorder buffer. With m mispredictions in N instructions and penalty P cycles, CPI ≈ CPI<sub>0</sub> + (m / N) · P. Recovering at execute cuts P by the
          wait at the head; a better predictor cuts m. Which pays depends on the program: a return stack takes the returns' share of m to zero, while a data-dependent branch has no pattern to learn.</p>`,
        real: `<p>Modern predictors use long global history (TAGE and perceptron designs) and reach well over 95 % on typical code; the remaining mispredictions cost 15 to 20
          cycles in a deep core, so a 2 % miss rate on a branch every five instructions still takes a visible part of the performance.</p>`,
        pitfall: `<p>Counting only the mispredicted branch. The cost is also the work done on the wrong path: it consumed fetch slots, issue slots and energy, and its
          results were discarded. Wrong-path instructions are renamed and executed like any other here, which is why a flush clears the rename table.</p>`,
      },
    },
    {
      title: 'Loads and stores',
      body: `
        <p>A store cannot write memory when it executes: it may be on a wrong path, and memory has no undo. So
        <span data-show="sq">the store queue</span> (4 entries) takes each store's address and data when it executes, and
        commit drains the oldest into <span data-show="dm">the data memory</span>, one a cycle, in program order. A flush
        just drops the younger entries.</p>
        <p>A load must then see stores that have not reached memory. Ours waits until every older store has executed (its
        address is known), then reads memory and the queue together: the youngest older store to the same word, if there
        is one, supplies the value (store-to-load forwarding). Waiting for the older addresses is the simple, safe rule;
        big cores guess that a load does not alias a store and replay it when a store proves them wrong.</p>
        <p>The program sums 8 + 7 + … + 1 through memory. Each element starts with a divide that holds commit back for 19
        cycles; the store and the load behind it execute meanwhile, and every load takes its value from the queue, long
        before its store reaches memory. The queue costs 8544 NANDs.</p>
        <p>Two ordering rules do the work. Stores reach memory in program order and only at commit, so memory always holds the state of a prefix of the program. Loads
        read memory plus the queue, so they see every older store even though none of them has been written yet. The simple rule that a load waits for all older store addresses
        gives up some parallelism and all risk of reading a stale word.</p>`,
      scene: () => cpuScene({ source: STORE_SOURCE, ooo: true, highlight: ['sq', 'dm'] }),
      tour: {
        beats: [
          { title: 'The divide reaches the head', reset: true, cycles: 6, show: ['div', 'rob'], expect: { retire: 0, pcF: 16 },
            say: '<p>The four <code>li</code>s committed. Now the <code>div</code> at {v:pcF} is the oldest instruction, and it takes 19 cycles. Nothing younger can commit before it: retire = {v:retire}.</p>' },
          { title: 'The store waits in the queue', cycles: 16, show: ['sq', 'dm'], expect: { retire: 0, pcF: 16 },
            say: '<p>Sixteen cycles later still nothing has committed. Behind the divide the <code>sw</code> has executed and sits in the store queue; the <code>lw</code> reads its value from there. Data memory has not been written.</p>' },
          { title: 'The divide commits', cycles: 2, show: ['rob', 'sq'], expect: { retire: 2, pcW0: 16 },
            say: '<p>The divide finishes and commits at {v:pcW0}, together with the <code>sw</code> behind it: the store leaves the queue for the data memory in program order.</p>' },
          { title: 'The rest at once', cycles: 1, show: ['rob', 'rf'], expect: { retire: 2, pcW0: 24 },
            say: '<p>The <code>lw</code> and <code>add</code>, finished long before, commit together at {v:pcW0}: two a cycle until the finished work is used up.</p>' },
        ],
      },
      more: {
        derive: `<p>Forwarding rule: for a load at address a with the store queue holding older stores s<sub>1</sub> … s<sub>k</sub> in program order, scan from the youngest older store to the oldest;
          the first whose word address equals a supplies the value (our core has word accesses only; a core with byte stores must merge a partial store with memory, by byte, or make the load wait). If none matches, memory supplies it. Every older store must already have its address,
          or the load waits. The cost is a comparator per queue entry (4 entries here) on every load, and a priority chain among the matches.</p>`,
        real: `<p>Big cores let a load run ahead of older stores whose addresses are unknown, guided by a predictor of which loads alias which stores, and replay the load when a
          store proves the guess wrong. The store queue plus the load queue are the memory-ordering hardware, and as large as the reorder buffer in some designs.</p>`,
        pitfall: `<p>Letting the store write memory when it executes. It may be on a wrong path, and memory has no undo; a flush would leave a value in memory that the program never stored.
          Stores write at commit only, which is why the queue exists.</p>`,
      },
    },
    {
      title: 'The whole core',
      body: `
        <p>All together: 359 262 NANDs without the program ROM (with the 64-word data memory, like the others here), against 193 768 for the dual-issue pipeline and 141 655
        for one pipeline. The reorder buffer takes 70 541, the issue queue 56 888, the BTB 35 662, the register file
        (four reads, two writes) 35 463, the divider 16 742, the rename table 12 443, the return stack 10 824 and the
        store queue 8544.</p>
        <p>Measured on the benchmark set at a period of 93 NAND delays: CPI fib 0.99, sort 0.77, matmul 1.28, matmul-m
        0.84, crc 0.99, against 1.13, 1.01, 1.05, 1.09, 0.97 for the dual-issue pipeline. sort gains most. matmul loses:
        its software multiply branches on data bits, and every misprediction costs the trip to the head of the reorder
        buffer, where the in-order pipeline recovers in E.</p>
        <p>Pick a program in the CPU panel and run it to the halt. Its ✓ says the golden model agreed after every commit;
        the Out of order panel's, that the model agreed every cycle.</p>
        <p>Compare the three machines on one number, NANDs for CPI. The pipeline pair spends a third more than one pipeline for a sixth less time. This core spends
        about two and a half times the single pipeline for CPI near one and a longer clock. The window and its wakeup are where the area goes, and the clock pays for the bypass that feeds them.</p>`,
      scene: () => cpuScene({ source: PROGRAMS.find((p) => p.id === 'sort')!.source, ooo: true }),
      tour: {
        beats: [
          { title: 'Two a cycle', reset: true, cycles: 4, show: ['pc', 'imem', 'rob'], expect: { retire: 2, pcW0: 0 },
            say: '<p>Sort starts with straight-line code: eight stores and the constants behind them. After four edges two instructions commit per cycle, {v:retire}.</p>' },
          { title: 'Full width', cycles: 5, show: ['rob', 'cm'], expect: { retire: 2, pcW0: 40 },
            say: '<p>Five cycles later it is still two a cycle, now at {v:pcW0}: 12 instructions committed. CPI is 0.5, the width of the machine.</p>' },
          { title: 'Then a load', cycles: 5, show: ['rob', 'iq'], expect: { retire: 0, pcW0: 80 },
            say: '<p>At {v:pcW0} the loop body starts with <code>lw</code>. The next cycle commits nothing (retire = {v:retire}): a load needs its data before it can finish, and these two come after the stores.</p>' },
          { title: 'Loads one at a time', cycles: 1, show: ['sq', 'dm'], expect: { retire: 1, pcW0: 80 },
            say: '<p>The first <code>lw</code> commits alone ({v:retire}), the second a cycle later: from here the loop is limited by its loads, not by the width.</p>' },
        ],
      },
      more: {
        derive: `<p>Time per instruction is period × CPI. On sort the out-of-order core has CPI ${cpi('ooo', 'sort')} at a period of ${period('ooo')} NAND delays: ${(period('ooo') * Number(cpi('ooo', 'sort'))).toFixed(1)} delays an instruction;
          the dual-issue pipeline, CPI ${cpi('pipe-2w', 'sort')} at ${period('pipe-2w')}, takes ${(period('pipe-2w') * Number(cpi('pipe-2w', 'sort'))).toFixed(1)}. On matmul the order reverses: ${(period('ooo') * Number(cpi('ooo', 'matmul'))).toFixed(1)} against ${(period('pipe-2w') * Number(cpi('pipe-2w', 'matmul'))).toFixed(1)}.</p>`,
        real: `<p>In shipping cores the same machine is 4 to 10 wide with windows of 200 to 600 instructions and runs the clock at several GHz by splitting wakeup and select
          across clusters and pipelining the rest. The cost grows faster than the benefit, which is why the next chapter turns to more cores.</p>`,
        pitfall: `<p>Reading CPI below 1 as success. The machine is also slower in cycle time than the pipeline it beats on CPI; only the product matters. Compare NAND delays per instruction, as the next step does.</p>`,
      },
    },
    {
      title: 'Measured, all together',
      body: `
        <p>Four machines, the same benchmark programs, every number from the gate-level CPUs' benchmark runs: the fastest
        single-cycle CPU, the best RV32IM pipeline, the dual-issue pipeline and the out-of-order core. The time of an
        instruction is the clock period times the CPI: NAND delays per instruction.</p>
        <p>The out-of-order core has the lowest CPI, 0.99, but not the shortest time: its period is 93 NAND delays
        against the dual-issue pipeline's 80 (the divider's result through the operand bypass), so an instruction takes 92.3 delays against
        83.1, and the pipeline 99.6. With the hardware multiply (matmul-m) it is ahead: 78 against 88. It costs 2.54× the
        pipeline's NANDs and spends 133.6 pJ an instruction, 1.9× the dual-issue pipeline's.</p>
        <p>Pollack's rule says a core's performance grows as the square root of its area: 2.54× the NANDs should buy
        1.59×. Here it buys 1.08×. Our memory answers in one cycle; a real core's misses its caches for hundreds, and
        hiding that is what large windows are for. The model shows the rest, on the five programs with matmul-m (where our core is 0.96): at 2 wide the window stops paying at 16
        entries (CPI 0.96 at 16, 32 and 64), 4 wide reaches 0.83 at 16 and 0.79 at 32, and 1 wide gains nothing from any
        window (1.36). Each step costs more than the last, which is why chips since the mid-2000s spend their transistors on
        more cores rather than wider ones: the next chapter.</p>`,
      widget: measuredWidget,
      more: {
        derive: `<p>Pollack's rule: performance grows as the square root of area. The out-of-order core has ${ratio(RESULTS.cpus.find((c) => c.id === 'ooo')!.nands, RESULTS.cpus.find((c) => c.id === 'pipe-m-bal-bp')!.nands)}× the NANDs of the
          best single pipeline, so the rule predicts ${Math.sqrt(RESULTS.cpus.find((c) => c.id === 'ooo')!.nands / RESULTS.cpus.find((c) => c.id === 'pipe-m-bal-bp')!.nands).toFixed(2)}×. Time per instruction is period × CPI, so a core can win on CPI and lose on the clock: the
          out-of-order core's CPI on fib is ${cpi('ooo', 'fib')} at ${period('ooo')} delays, the dual-issue pipeline's ${cpi('pipe-2w', 'fib')} at ${period('pipe-2w')}.</p>`,
        real: `<p>The gap between CPI and speed is why wide cores spent the 2000s fighting the clock: wakeup and select, the bypass network and the register file's ports all
          scale badly with width. Cores in production are 4 to 10 wide, and the extra transistors went to caches, prediction and more cores.</p>`,
        pitfall: `<p>Comparing CPI alone. The out-of-order core has the lowest average CPI of the machines in the table and a longer clock than either pipeline; only the product, delays per instruction, ranks the machines.
          A machine measured on a memory that answers in one cycle also shows less of what the window is for than a real one would.</p>`,
      },
    },
    {
      title: 'Your own core',
      deep: true,
      body: `
        <p>The model behind this chapter is the specification the gate-level core follows cycle for cycle. Here it takes
        any shape: fetch and commit widths, issue ports and the units on each, the window, the predictor, where a
        misprediction is recovered, the latencies. Run it on the benchmark set, one program, your own assembly or a
        chapter ${numOf('python')} Python program (the same workbench page is the Lab tab).</p>
        <p>Every commit slot is accounted for. Two a cycle make 2n slots in n cycles; each one either commits an
        instruction or is charged to what the oldest instruction in flight waits for, since everything younger waits
        behind it. On our core 50.2 % commit and 32.0 % go to mispredictions: the wait for a mispredicted branch to
        reach the head, the flush, the refill. Perfect prediction alone takes CPI from 0.96 to 0.60; recovering when the
        branch resolves instead of at commit (which needs a copy of the rename table per branch in flight) gives 0.88. A
        reorder buffer of 64 changes nothing (0.96). Four wide with a 32-entry window reaches 0.79, and mispredictions
        then take 40.5 % of the slots: a wider machine has more work in flight to throw away.</p>
        <p>Make memory slow and the window matters more, but less than you would hope: at a load latency of 20 the
        CPI is 1.78 with 51.6 % of the slots waiting on loads, and a 64-entry window only brings it to 1.68. This core
        never lets a load pass an older store, so a slow load holds everything that depends on memory. Real cores
        predict which loads do not alias and check later.</p>
        <p>The price comes from the gates. Where the gate-level core can be built in your shape (it stays 2-wide with its
        own ports, predictor and latencies; its window sizes vary), the lab gives its NANDs and its clock period, and the
        period times the CPI is the time of an instruction. Other shapes are timed, not priced. The window costs area,
        hardly any clock: from a reorder buffer of 8, an issue queue of 4 and a store queue of 2 (286 574 NANDs) to 32,
        16 and 8 (509 252) the period only goes from 93 to 95 NAND delays, since the critical path runs from the divider's
        result through the operand bypass, not through wakeup and select. Keep a shape to set it beside the next.</p>`,
      widget: oooLabWidget,
      more: {
        derive: `<p>The slot accounting. A machine that commits up to W instructions a cycle has W × T commit slots in T cycles. Each slot either commits an instruction or is charged to
          the cause the oldest instruction in flight is waiting for (a load, a divide, a misprediction, an empty window, a busy unit). The charges sum to W × T, so
          CPI = (T / N) = (1 / W) · (1 + charged slots / committed slots): the stack of causes is the stack of CPI.</p>`,
        real: `<p>Performance engineers read the same breakdown from hardware counters, as a top-down analysis: front end bound, bad speculation, back end bound, retiring.
          The lab's slot causes are that analysis on a model you can change.</p>`,
        pitfall: `<p>Changing one knob and expecting a proportional gain. Widening the machine raises the share of slots lost to mispredictions; enlarging the window does nothing
          if the front end cannot fill it. Look at which cause moves in the slot stack before reading the CPI.</p>`,
      },
    },
    {
      title: 'Code that helps the hardware',
      body: `
        <p>crc spends its time on one branch: is the low bit 1? It goes either way at random, so no predictor learns it:
        290 mispredictions in 3049 instructions on our core, each paid when the branch reaches the head of the reorder
        buffer. The cure is in the code. Make the decision data: <code>neg</code> turns the bit into 0 or all ones,
        <code>and</code> with the polynomial picks it or 0, and the <code>xor</code> always runs. One and a half more instructions a
        bit on average, and no branch.</p>
        <p>On the benchmark that is 3819 instructions instead of 3049, but 2330 cycles instead of 3021: 21
        mispredictions. The in-order dual-issue machine of step 2 gains as much (3045 → 2370 cycles): the win is in
        prediction, not in reordering. Compilers do this where they can (if-conversion into a select, cmov on x86,
        czero in RISC-V's Zicond).</p>
        <p>The core runs the CRC of four words, a branch on every bit: 807 cycles. Edit the program in the CPU panel and
        run it to the halt.</p>`,
      scene: () => ({ ...cpuScene({ source: CRC4_SOURCE, ooo: true }), autoClock: false }),
      more: {
        derive: `<p>The trade, per bit of the CRC: with the branch the loop runs 5 instructions when the bit is 0 and 6 when it is 1 (5.5 on average) and mispredicts about half the time; branchless it runs 7 on every path and never mispredicts. If a flush costs P cycles and the machine commits W a cycle, the branch version averages 5.5 / W + P / 2 cycles a bit against 7 / W, so branchless wins when P &gt; 3 / W: for W = 2, whenever a flush costs more than ${3 / 2} cycles. Here a flush costs several, since the branch must reach the head of the reorder buffer first.</p>`,
        real: `<p>Compilers if-convert short branches into conditional moves or selects where the target has them (cmov on x86, the Zicond extension's czero on RISC-V) and
          keep the branch where the outcome is predictable. The programmer's tool is the same: a mask from a comparison, then AND and XOR.</p>`,
        pitfall: `<p>Removing a branch that was predictable. A loop-closing branch costs almost nothing when predicted, and replacing it with arithmetic adds instructions to every
          iteration. Only a branch that goes either way at random, as the CRC's does, is worth turning into data.</p>`,
      },
      challenge: {
        kind: 'reach',
        goal: `Rewrite the inner loop without its branch: the same CRC in a0 (0x${CRC4_VALUE.toString(16)}), halted in under ${CRC4_BUDGET} cycles.`,
        // a0 at the halt (the register file is written at commit; the store to word 4 drains from the store queue after)
        check: (st) => halted(st) && st.cycles < CRC4_BUDGET && !!st.sim && cpuState(st.sim).x[10] === CRC4_VALUE,
        hints: [
          'The branch only decides whether to xor the polynomial. Could the xor always run, with either the polynomial or 0?',
          '<code>neg</code> of a bit that is 0 or 1 gives 0 or all ones (0xFFFFFFFF): a mask.',
        ],
        answer: `<pre>bit:    andi t5, a0, 1
        srli a0, a0, 1
        neg  t5, t5           # 0 or all ones
        and  t5, t5, a1
        xor  a0, a0, t5       # the polynomial or 0
        addi t4, t4, -1
        bnez t4, bit</pre><p>610 cycles: 963 instructions at CPI 0.63, 9 mispredictions instead of 81.</p>`,
        solve: (st) => {
          // a scene this large is built after a paint: clock it once it is on the stage, a few cycles a frame, to the halt
          const sc = { ...cpuScene({ source: CRC4_BRANCHLESS, ooo: true }), autoClock: false };
          st.load(sc);
          const run = () => {
            if (st.scene !== sc) return void setTimeout(run, 50);
            st.runCycles(12, () => halted(st));
            if (!halted(st) && st.cycles < 3 * CRC4_BUDGET) requestAnimationFrame(run);
          };
          run();
        },
      },
    },
  ],
};
