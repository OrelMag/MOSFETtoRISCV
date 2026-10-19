import { dataflowWidget, orderWidget, robWidget, scoreboardWidget, speculationWidget } from '../widgets/ooo';
import type { Chapter } from './types';

// Every number in the prose comes from riscv/ooomodel.ts, riscv/ilp.ts and riscv/scoreboard.ts on the programs
// named; tests/ooo-chapter.test.ts recomputes them.

export const chOoo: Chapter = {
  id: 'ooo', num: 24, title: 'Out of order', level: 'Processor',
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
      title: 'Where in-order stops',
      body: `
        <p>The obvious first step is two pipelines side by side: fetch two instructions, issue both when they are
        independent, else only the first. In order, the first instruction that waits stops everything behind it.</p>
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
  ],
};
