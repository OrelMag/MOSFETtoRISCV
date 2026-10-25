import { ageBit, iqEntry, RAT, SELECT8 } from '../lib/ooo';
import { PAY } from '../lib/ooocore';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { dataflowWidget, measuredWidget, orderWidget, robWidget, scoreboardWidget, speculationWidget } from '../widgets/ooo';
import { cpuState } from '../riscv/cosim';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

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
const IQ_PAY = PAY.reduce((a, [, w]) => a + w, 0);

export const chOoo: Chapter = {
  id: 'ooo', num: 26, title: 'Out of order', level: 'Processor',
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
      'P6 style: an instruction\'s tag is its reorder-buffer entry. Dispatch renames in order, each port issues the oldest ready instruction, result buses wake the waiting ones, and commit leaves the head in order, so the register file always holds a precise state.',
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
        instructions ahead and knows every branch in advance. The rest of the chapter prices getting part of the way.</p>`,
      widget: dataflowWidget,
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
        <p>Measured on the benchmark set: 193 768 NANDs against 141 655 for one lane (+37 %), a clock period of 80 NAND
        delays against 79, and CPI fib 1.13, sort 1.01, matmul 1.05, matmul-m 1.09, crc 0.97 against 1.35, 1.18,
        1.30, 1.25, 1.23. Only 29 to 53 % of the instructions go in pairs; the others wait for a result, the one memory
        lane or a branch. About a sixth less time for a third more gates.</p>`,
      scene: () => cpuScene({ source: DUAL_SOURCE, wide: true, highlight: ['pair', 'hz', 'rf'] }),
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
        there is one divider. Both machines run at its pace (CPI 4.13 against 3.72).</p>`,
      widget: orderWidget,
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
        <p>Step through Hennessy and Patterson's example with the 6600's latencies (multiply 10, divide 40). The add
        is done at cycle 16 but may not write t1 until cycle 22, because the divide, still waiting for the multiply,
        has yet to read the old t1. The second load waits at issue because the one load unit is busy. Only RAW is a
        real dependence. WAR and WAW are clashes of names: the program reuses t1 for a new value. <em>Reused
        names</em> shows WAW stopping issue.</p>`,
      widget: scoreboardWidget,
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
        add, and entries leave in program order.</p>`,
      widget: () => robWidget('dot'),
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
        <p>Cost: 12 443 NANDs, of which the 31 rows take 275 each.</p>`,
      scene: () => ({ root: RAT, autoClock: false, inputs: { rs1_0: 10, rs2_0: 11, rs1_1: 5, rs2_1: 0, rd0: 5, we0: 1, tag0: 3, rd1: 6, we1: 1, tag1: 4, clk: 0 }, highlight: ['rows', 'by2'] }),
      tries: [(st) => st.value('a1v') === 1 && st.value('a1t') === 3],
    },
    {
      title: 'Wakeup (Tomasulo, IBM 360/91, 1967)',
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
        <p>4 247 NANDs an entry, eight entries. The four comparators are a small part of that: storage and 32-bit
        multiplexers are most of it. Big cores keep scores of entries and read the operands after issue, so an entry holds
        no values; there the comparators, tags × buses × entries, are what grows.</p>`,
      scene: () => ({
        root: iqEntry(IQ_PAY), autoClock: false, highlight: ['e0A', 'e1A', 'e0B', 'e1B'],
        inputs: { alloc: 1, port: 0, load: 0, div: 0, lat2: 0, tagA: 5, rdyA: 0, valA: 0, tagB: 0, rdyB: 1, valB: 7, smask: 0, pay: 0, bv0: 0, bt0: 5, bx0: 42, bv1: 0, bt1: 0, bx1: 0, sdone: 0, pick: 0, flush: 0, clk: 0 },
      }),
      tries: [(st) => st.value('valid') === 1, (st) => st.value('ready') === 1 && st.value('opA') === 42],
    },
    {
      title: 'Choosing who goes',
      body: `
        <p>Each port picks the oldest ready entry bound to it: the oldest first drains the head of the reorder buffer,
        and commit waits on nothing else. The entries are not kept in order, though (a freed slot takes whatever comes
        next), and keeping them sorted would mean shifting ~200-bit entries every cycle. Instead an <strong>age
        matrix</strong> records, for every ordered pair of entries, which holds the older instruction: 56 bits for eight
        entries, 1 536 NANDs. A new entry is younger than every entry present: its row clears and its column sets.</p>
        <p>Select is then two levels of logic. Entry e wins when it is a candidate and no other candidate is older:
        <span data-show="blk6">an OR over seven ANDs</span>, <span data-show="g6">then an AND with its own
        request</span>. The whole grant word is 280 NANDs and 11 levels deep, with no chain from entry 0 to 7 as in a
        priority encoder.</p>
        <div class="try">Entries 6, 3 and 5 are candidates, and the matrix orders the entries 4, 1, 6, 0, 3, 2, 5, 7 from
        the oldest: 6 gets the grant. Clear its bit in <code>cand</code>: 3 wins.</div>
        <p>Wakeup and select together are the loop that sets the clock: a result's tag arrives on a bus, the waiting entry
        wakes, select picks it, and its operands reach the port's register, all within one cycle, or a chain of dependent
        additions cannot run back to back. In our core this is the critical path, 93 NAND delays against the dual-issue
        pipeline's 80. Port binding sat on it at first, when dispatch counted each port's entries after this cycle's
        picks; counting before the picks and taking them off in parallel moved it off.</p>`,
      scene: () => ({ root: SELECT8, inputs: { cand: SELECT_CAND.reduce((m, e) => m | (1 << e), 0), older: olderBits(SELECT_ORDER) }, highlight: ['blk6', 'g6'] }),
      tries: [(st) => st.value('grant') === 1 << 3],
    },
    {
      title: 'The reorder buffer, in gates',
      body: `
        <p>Here is the whole core: <span data-show="pc imem btb ras fp">fetch</span> of two words a cycle with the BTB and
        the return stack, <span data-show="dc rat bind">decode, rename and binding to a port</span>, <span data-show="iq">the
        issue queue</span>, two ports with <span data-show="e1_0 e1_1">an ALU each</span>, and on port 1
        <span data-show="mule mulm div">the multiplier and the divider</span>, <span data-show="rob">the reorder
        buffer</span> and <span data-show="cm rf">commit into the register file</span>.</p>
        <p><span data-show="rob">The reorder buffer</span> is the largest block: 16 entries of 109 bits (done; the
        destination, PC and kind of control transfer, written at dispatch; the value, the real next PC and a mispredict
        bit, written by a result bus), 70 541 NANDs. Up to two entries leave the head a cycle, at most one of them a
        store, and write the register file. The core's <code>retire</code> output counts them and the golden model steps
        once per commit, so the CPU panel compares the registers after every commit even though instructions finish out of
        order.</p>
        <p>The Out of order panel reads the reorder buffer, the issue queue, the rename table and the store queue from
        their registers. Its timeline is the model of the earlier steps, running beside the gates: every cycle both must
        commit the same instructions and pick the same one on each port. Click an instruction in either panel to light
        the hardware it uses. The program is step 2's dot product, on the cycle engine.</p>`,
      scene: () => cpuScene({ source: DUAL_SOURCE, ooo: true, highlight: ['rob', 'cm', 'rf'] }),
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
        matmul's software multiply and crc branch on data bits, which no predictor learns.</p>`,
      widget: speculationWidget,
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
        before its store reaches memory. The queue costs 8 544 NANDs.</p>`,
      scene: () => cpuScene({ source: STORE_SOURCE, ooo: true, highlight: ['sq', 'dm'] }),
    },
    {
      title: 'The whole core',
      body: `
        <p>All together: 359 262 NANDs without the program ROM, against 193 768 for the dual-issue pipeline and 141 655
        for one pipeline. The reorder buffer takes 70 541, the issue queue 56 888, the BTB 35 662, the register file
        (four reads, two writes) 35 463, the divider 16 742, the rename table 12 443, the return stack 10 824 and the
        store queue 8 544.</p>
        <p>Measured on the benchmark set at a period of 93 NAND delays: CPI fib 0.99, sort 0.77, matmul 1.28, matmul-m
        0.84, crc 0.99, against 1.13, 1.01, 1.05, 1.09, 0.97 for the dual-issue pipeline. sort gains most. matmul loses:
        its software multiply branches on data bits, and every misprediction costs the trip to the head of the reorder
        buffer, where the in-order pipeline recovers in E.</p>
        <p>Pick a program in the CPU panel and run it to the halt. Its ✓ says the golden model agreed after every commit;
        the Out of order panel's, that the model agreed every cycle.</p>`,
      scene: () => cpuScene({ source: PROGRAMS.find((p) => p.id === 'sort')!.source, ooo: true }),
    },
    {
      title: 'Measured, all together',
      body: `
        <p>Four machines, the same four programs, every number from the gate-level CPUs' benchmark runs: the fastest
        single-cycle CPU, the best RV32IM pipeline, the dual-issue pipeline and the out-of-order core. The time of an
        instruction is the clock period times the CPI: NAND delays per instruction.</p>
        <p>The out-of-order core has the lowest CPI, 0.99, but not the shortest time: its period is 93 NAND delays
        against the dual-issue pipeline's 80 (wakeup and select in one cycle), so an instruction takes 92.3 delays against
        83.1, and the pipeline 99.6. With the hardware multiply (matmul-m) it is ahead: 78 against 88. It costs 2.54× the
        pipeline's NANDs and spends 133.6 pJ an instruction, 1.9× the dual-issue pipeline's.</p>
        <p>Pollack's rule says a core's performance grows as the square root of its area: 2.54× the NANDs should buy
        1.59×. Here it buys 1.08×. Our memory answers in one cycle; a real core's misses its caches for hundreds, and
        hiding that is what large windows are for. The model shows the rest: at 2 wide the window stops paying at 16
        entries (CPI 0.96 at 16, 32 and 64), 4 wide reaches 0.83 at 16 and 0.79 at 32, and 1 wide gains nothing from any
        window (1.36). Each step costs more than the last, which is why chips since the mid-2000s spend their transistors on
        more cores rather than wider ones: the next chapter.</p>`,
      widget: measuredWidget,
    },
    {
      title: 'Code that helps the hardware',
      body: `
        <p>crc spends its time on one branch: is the low bit 1? It goes either way at random, so no predictor learns it:
        290 mispredictions in 3 049 instructions on our core, each paid when the branch reaches the head of the reorder
        buffer. The cure is in the code. Make the decision data: <code>neg</code> turns the bit into 0 or all ones,
        <code>and</code> with the polynomial picks it or 0, and the <code>xor</code> always runs. Two more instructions a
        bit, and no branch.</p>
        <p>On the benchmark that is 3 819 instructions instead of 3 049, but 2 330 cycles instead of 3 021: 21
        mispredictions. The in-order dual-issue machine of step 3 gains as much (3 045 → 2 370 cycles): the win is in
        prediction, not in reordering. Compilers do this where they can (if-conversion into a select, cmov on x86,
        czero in RISC-V's Zicond).</p>
        <p>The core runs the CRC of four words, a branch on every bit: 807 cycles. Edit the program in the CPU panel and
        run it to the halt.</p>`,
      scene: () => ({ ...cpuScene({ source: CRC4_SOURCE, ooo: true }), autoClock: false }),
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
