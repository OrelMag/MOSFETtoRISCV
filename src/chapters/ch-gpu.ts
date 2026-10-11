import { divergenceWidget, laneCoreScene, lanesVsCoresWidget } from '../widgets/lanes';
import type { Chapter } from './types';

export const chLanes: Chapter = {
  id: 'lanes', num: 26, title: 'Lanes', level: 'Throughput',
  blurb: 'One fetch and decode feeding four ALUs, each with its own registers: a lane core, measured against four cores.',
  steps: [
    {
      title: 'Latency or throughput',
      body: `
        <p>Chapters 15 to 23 spent gates on <em>latency</em>: forwarding, branch prediction and caches all make one instruction stream finish sooner. Many
        workloads are instead thousands of independent copies of one small program: a pixel, a matrix element, a neuron's activation. For them the figure of
        merit is results per second per gate (and per watt), and the latency of any one result hardly matters.</p>
        <p>Chapter 24 got parallelism by copying whole cores. The other way is to keep <strong>one instruction stream</strong> and copy only the datapath: one
        fetch, one decode, one control unit, and N <strong>lanes</strong>, each with its own registers and ALU. Give each lane a way to sit out an instruction
        and the programmer can write an ordinary scalar program per element, a <em>thread</em>; the N threads stepping together form a <em>warp</em>. NVIDIA
        calls this SIMT (single instruction, multiple threads). Its warps are 32 lanes wide; ours has 4.</p>`,
      challenge: {
        kind: 'quiz', question: 'Which of these does a lane core have only once, however many lanes it has?',
        options: ['The register file', 'The ALU', 'The program counter', 'The result multiplexer'], answer: 2,
        explain: 'One PC per warp is the definition: every lane runs the instruction it points to. Registers, ALU and the result mux are per lane, because each thread computes its own values.',
      },
    },
    {
      title: 'One decoder, four ALUs',
      body: `
        <p>On the left, the single-cycle CPU's front end: PC, program ROM, control unit, immediate generator, next-PC logic. Further right, four <strong>LANE</strong>
        boxes. Open one: a 31 × 32-bit register file, the SrcA / SrcB multiplexers, an ALU and the result multiplexer, exactly the single-cycle datapath. Every lane
        receives the same rs1, rs2 and rd fields, the same control signals and the same immediate; only its registers differ.</p>
        <p>A lane learns which thread it is with <code>csrr t0, tid</code>: a constant wired into each lane (0, 1, 2, 3) answers. Here every lane takes the elements
        i = tid, tid + 4, tid + 8, tid + 12 of y = 3·x + y. <code>nlanes</code> reads 4, <code>lane</code> the lane number, <code>tmask</code> the active mask.</p>
        <p>The Warp panel runs the SIMT golden model (riscv/simt.ts) in lock-step and compares the PC, the mask and every lane's registers after each instruction.</p>
        <div class="try">Run to halt, then open a lane and its register file: four different sets of values from one instruction stream.</div>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['lane0', 'lane1', 'lane2', 'lane3'] }),
    },
    {
      title: 'The leader',
      body: `
        <p>One PC means one branch decision per instruction. The lanes all compute the comparison, but only one is listened to: the <strong>leader</strong>, the
        lowest active lane. A lowest-set-bit circuit turns the active mask into a one-hot word, and one-hot multiplexers (an AND per bit and an OR tree: no decoder,
        the select is already one-hot) bring the leader's ALU flags to the next-PC logic and its ALU result to the jalr target.</p>
        <p>In saxpy the branch agrees in every lane: each lane does exactly four elements, so <code>blt t3, t2, loop</code> is taken or not taken by all of them at
        once. When lanes disagree, the leader's choice is wrong for the others; chapter 27 fixes that.</p>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['lead', 'lF', 'lAlu', 'npc'] }),
    },
    {
      title: 'One memory port',
      body: `
        <p>Four lanes produce four addresses per load, and the data memory has one port. The <strong>memory sequencer</strong> serves the lowest active lane not yet
        served, one per cycle, writing the loaded word into that lane's registers only, and holds the PC until none is left. A load or store therefore takes as
        many cycles as there are active lanes.</p>
        <p>saxpy runs 74 instructions in 134 cycles: 20 of them are loads or stores at 4 cycles each (80 cycles), the other 54 take one.</p>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['mseq', 'mAd', 'mWd'] }),
      challenge: {
        kind: 'quiz', question: 'A sw executes with lanes 0, 1 and 3 active. How many cycles does it take, and in which order are the lanes written?',
        options: ['1 cycle, all at once', '3 cycles: lanes 0, 1, 3', '4 cycles: lanes 0, 1, 2, 3', '3 cycles: lanes 3, 1, 0'], answer: 1,
        explain: 'One cycle per active lane, lowest first: the sequencer\'s lowest-set-bit circuit picks lane 0, then 1, then 3, clearing each from its "lanes left" register. Lane 2 is masked off and never served.',
      },
    },
    {
      title: 'Lanes against cores',
      body: `
        <p>The same work on chapter 24's cores, four of them, each finding its index with <code>csrr mhartid</code>, against the lane core. Both bars are counted
        from the actual designs, and both cycle counts come from the golden models that the gate-level circuits match cycle for cycle.</p>
        <p>The lanes save the front end three times over, yet only about a fifth of the gates: here a lane is mostly its register file (23 141 of its 27 584 NANDs,
        flip-flops and multiplexers). And they are slower on saxpy, because a load or store stops all four lanes, while a core that waits for the memory port lets
        the other three compute. Real GPUs answer both: memory as wide as a warp, with a <strong>coalescer</strong> merging neighbouring addresses into one access
        (chapter 29), and many warps so that one waiting does not idle the lanes (chapter 28). Their register files are SRAM, and the cores they compete with have
        large front ends (out-of-order logic, predictors, caches), so the sharing pays far more than it does here.</p>`,
      widget: lanesVsCoresWidget,
    },
  ],
};

export const chSimt: Chapter = {
  id: 'simt', num: 27, title: 'Threads in lock-step', level: 'Throughput',
  blurb: 'The active mask, divergent branches, split / join and the reconvergence stack, predication, and what divergence costs.',
  steps: [
    {
      title: 'The active mask',
      body: `
        <p>Each lane has one bit in the <strong>active mask</strong>. A lane whose bit is 0 still sees every instruction, but its register write enable is off and
        the memory sequencer skips it. The mask register stores the mask inverted, so at power-on, with every flip-flop at 0, all lanes are active.</p>
        <p><code>tmc rs1</code> (thread mask control) loads the mask from the leader's rs1. Here every lane stores a value, then <code>tmc</code> with 1 leaves lane 0
        alone to add them up, and <code>tmc</code> with −1 brings the others back. While lane 0 works alone the other three idle: 45 % of the lane-steps do work in
        this kernel.</p>`,
      scene: () => laneCoreScene('tmc'),
    },
    {
      title: 'When lanes disagree',
      body: `
        <p>Odd lanes should compute 3·lane, even lanes lane / 2. Written as a plain <code>if</code>, the lanes disagree at <code>beqz</code>: lanes 0 and 2 want to
        branch, lanes 1 and 3 do not. One PC cannot go both ways, so the warp follows its leader (lane 0) to the even path, and the odd lanes compute the even
        result. The golden model counts the divergent branch; the hardware simply follows the leader.</p>`,
      scene: () => laneCoreScene('nosplit'),
      challenge: {
        kind: 'quiz', question: 'With the leader deciding, what does lane 3 store?',
        options: ['9 (3 · 3)', '1 (3 / 2)', 'Nothing: it is masked off', '0'], answer: 1,
        explain: 'Lane 3 is active the whole time; the warp went down the even path because lane 0 is even, so lane 3 ran srli and stored 3 >> 1 = 1.',
      },
    },
    {
      title: 'split and join',
      body: `
        <p>The fix runs the two sides one after the other. <code>split t1</code> divides the active lanes: those with t1 ≠ 0 go first, the others wait. It pushes
        one stack entry: the mask before the split, the waiting (else) lanes, where they will resume (the instruction after the split), and a pending bit. The branch
        after the split is now uniform: every active lane agrees.</p>
        <p>The <code>join</code> at the end of the if is reached twice. The first time the entry is pending: the else lanes become the mask and the PC jumps back to
        just after the split, where their branch goes the other way. The second time it is not: the original mask comes back and the entry is popped. This is
        the scheme of Vortex, the open-source RISC-V GPU. A split on which the lanes agree pushes an entry with nothing pending, so its join just pops.</p>
        <div class="try">Step through the joins and watch the stack and the mask grid: odd lanes, then even lanes, then all four.</div>`,
      scene: () => laneCoreScene('diverge'),
    },
    {
      title: 'An if inside an if',
      body: `
        <p>Each split pushes one entry, so nested ifs nest on the stack. The stack is a shift register of four entries (the top is entry 0): a push shifts everything
        down, a pop shifts it up. Four entries allow four levels of nesting; a fifth split would lose the bottom entry, and the golden model stops with a stack
        overflow instead.</p>
        <p>The lanes split twice here: odd and even, then within the odd lanes on bit 1. Each path runs with only the lanes that took it, so only 58 % of the
        lane-steps do work.</p>`,
      scene: () => laneCoreScene('nested'),
    },
    {
      title: 'Loops of different lengths',
      body: `
        <p>Lane l adds up l + 1, l, …, 1, so the lanes need 1 to 4 iterations. <code>pred t1, s0</code> turns off the lanes whose t1 reached 0, without a stack entry
        (predication); when no lane would remain, it loads the mask from the leader's s0 instead, saved at the start with <code>csrr s0, tmask</code>. The loop's
        branch is uniform because only lanes still counting are active, and after the last iteration all four lanes come back for the store.</p>`,
      scene: () => laneCoreScene('pred'),
    },
    {
      title: 'What divergence costs',
      body: `
        <p>A divergent if runs both sides, each with part of the lanes: the warp pays for the then-path plus the else-path, every lane idle during the side it did
        not take. Lane utilization, the fraction of lane-steps that do work, measures it. With 32 lanes and one thread taking a long path, 31 lanes wait through it,
        which is why GPU programmers keep branches uniform across a warp, arrange data so that neighbouring threads agree, or compute both sides and select.</p>`,
      widget: divergenceWidget,
      challenge: {
        kind: 'quiz', question: 'A 4-lane warp runs an if / else with 10 instructions on each side; 3 lanes take the then-path, 1 the else-path. What fraction of the lane-steps in the if / else do work?',
        options: ['100 %', '75 %', '50 %', '25 %'], answer: 2,
        explain: 'The warp runs 20 instructions × 4 lanes = 80 lane-steps. Useful: 3 lanes × 10 + 1 lane × 10 = 40. So 50 %; without divergence it would be 100 %.',
      },
    },
  ],
};
