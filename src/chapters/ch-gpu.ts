import { divergenceWidget, laneCoreScene, lanesVsCoresWidget } from '../widgets/lanes';
import { accessWidget, tilingWidget } from '../widgets/feed';
import { occupancyWidget, warpCoreScene } from '../widgets/warps';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

/** The warp core's `halted` output: every warp has run to its end (0 from power-on). */
function halted(st: Stage): boolean {
  try { return st.value('halted') === 1; } catch { return false; }
}

export const chLanes: Chapter = {
  id: 'lanes', num: 26, title: 'Lanes', level: 'Throughput',
  blurb: 'One fetch and decode feeding four ALUs, each with its own registers: a lane core, measured against four cores.',
  goals: [
    'say what a lane core has once (PC, fetch, decode, control) and what it copies per lane (registers, ALU, result multiplexer)',
    'explain how one PC takes a branch: the leader, the lowest active lane, decides',
    'count the cycles of a load or store on one memory port: one per active lane',
    'explain why four lanes save only about a fifth of the gates of four cores here, and run saxpy slower',
  ],
  builds: ['cpu', 'multicore'],
  recap: {
    keep: [
      'A lane core is one PC, one program ROM, one control unit and N lanes, each a 31 × 32-bit register file, SrcA / SrcB multiplexers, an ALU and a result multiplexer. Every lane gets the same fields, control signals and immediate.',
      'A thread finds out which it is with <code>csrr t0, tid</code>, a constant wired into each lane. The threads stepping together form a <em>warp</em> (SIMT: single instruction, multiple threads).',
      'One PC means one branch decision: the <strong>leader</strong>, the lowest active lane, found by a lowest-set-bit circuit, sends its flags to the next-PC logic through one-hot multiplexers.',
      'With one memory port, a load or store takes one cycle per active lane, lowest first: saxpy runs 74 instructions in 134 cycles.',
      'Against four cores the lanes save only about a fifth of the gates (a lane is mostly its register file: 23 141 of its 27 584 NANDs), and they are slower on saxpy, because a memory access stops all four lanes.',
    ],
    practise: ['k_lanes', 'k_vrf', 'k_simd', 'p_saxpy'],
    check: [
      {
        question: 'Why does saxpy on the lane core take 134 cycles for 74 instructions?',
        options: ['Its 20 loads and stores take 4 cycles each, one per active lane', 'Every instruction takes about two cycles', 'The loop branch flushes instructions each iteration', 'The lanes wait for each other at the end of the loop'],
        answer: 0,
        explain: '20 memory instructions × 4 cycles = 80, plus the other 54 at one cycle each: 134. The sequencer serves one lane per cycle and holds the PC meanwhile.',
        why: ['', 'Only memory instructions take more than one cycle; the other 54 take one each.', 'The front end is the single-cycle CPU\'s: a branch is decided in the cycle it executes, and nothing is flushed.', 'The lanes run in lock-step on one PC: there is nothing to wait for at the end of the loop.'],
      },
      {
        question: 'How does lane 2 of a lane core know that it is lane 2?',
        options: ['<code>csrr t0, tid</code> reads a constant wired into that lane', 'It reads its own PC, which differs per lane', 'The program ROM holds a copy of the kernel per lane', 'Its register file starts out holding its number'],
        answer: 0,
        explain: 'Every lane receives the same instruction; only the tid constant wired into each (0, 1, 2, 3) differs, and the kernel turns it into the elements that lane handles.',
        why: ['', 'There is one PC for all lanes: that is what makes it a lane core.', 'There is one program ROM, and one instruction a cycle for every lane.', 'All lanes\' registers start out alike; the wired tid constant is the only difference.'],
      },
      {
        question: '<code>blt t3, t2, loop</code> runs with all four lanes active. Whose comparison steers the PC?',
        options: ['Lane 0\'s, the leader: the lowest active lane', 'Lane 3\'s, the highest', 'A majority vote of the four', 'All four must agree, or the core stops'],
        answer: 0,
        explain: 'A lowest-set-bit circuit turns the active mask into a one-hot word, and one-hot multiplexers bring that lane\'s ALU flags to the next-PC logic.',
        why: ['', 'The leader is the lowest active lane, not the highest.', 'There is no voting logic: one-hot multiplexers pass exactly one lane\'s flags.', 'This core does not check that the lanes agree: when they disagree it follows the leader, which is wrong for the others.'],
      },
    ],
  },
  steps: [
    {
      title: 'Latency or throughput',
      body: `
        <p>Chapters <a href="#/c/fastadd/0">15</a> to <a href="#/c/float/0">23</a> spent gates on <em>latency</em>: forwarding, branch prediction and caches all make one instruction stream finish sooner. Many
        workloads are instead thousands of independent copies of one small program: a pixel, a matrix element, a neuron's activation. For them the figure of
        merit is results per second per gate (and per watt), and the latency of any one result hardly matters.</p>
        <p><a href="#/c/multicore/0">Chapter 24</a> got parallelism by copying whole cores. The other way is to keep <strong>one instruction stream</strong> and copy only the datapath: one
        fetch, one decode, one control unit, and N <strong>lanes</strong>, each with its own registers and ALU. Give each lane a way to sit out an instruction
        and the programmer can write an ordinary scalar program per element, a <em>thread</em>; the N threads stepping together form a <em>warp</em>. NVIDIA
        calls this SIMT (single instruction, multiple threads). Its warps are 32 lanes wide; ours has 4.</p>`,
      challenge: {
        kind: 'quiz', question: 'Which of these does a lane core have only once, however many lanes it has?',
        options: ['The register file', 'The ALU', 'The program counter', 'The result multiplexer'], answer: 2,
        explain: 'One PC per warp is the definition: every lane runs the instruction it points to. Registers, ALU and the result mux are per lane, because each thread computes its own values.',
        why: ['Each thread keeps its own values in the same register numbers, so each lane needs a register file of its own.', 'Every lane computes on its own operands in the same cycle: one ALU per lane.', '', 'Each lane chooses between its own ALU result, its loaded word and the rest: the result multiplexer is per lane.'],
      },
    },
    {
      title: 'One decoder, four ALUs',
      body: `
        <p>Along the top, the single-cycle CPU's front end: <span data-show="pc">PC</span>, <span data-show="imem">program ROM</span>,
        <span data-show="ctl">control unit</span>, <span data-show="imm">immediate generator</span>, <span data-show="npc">next-PC logic</span>. Below, four
        <span data-show="lane0 lane1 lane2 lane3"><strong>LANE</strong> boxes</span>. Open one: a 31 × 32-bit register file, the SrcA / SrcB multiplexers, an ALU and the result multiplexer, exactly the single-cycle datapath. Every lane
        receives the same rs1, rs2 and rd fields, the same control signals and the same immediate; only its registers differ.</p>
        <p>A lane learns which thread it is with <code>csrr t0, tid</code>: a constant wired into each lane (0, 1, 2, 3) answers. Here every lane takes the elements
        i = tid, tid + 4, tid + 8, tid + 12 of y = 3·x + y. <code>nlanes</code> reads 4, <code>lane</code> the lane number, <code>tmask</code> the active mask.</p>
        <p>The Warp panel runs an instruction-set simulator of the SIMT machine (a reference model in software) in lock-step and compares the PC, the mask and every lane's registers after each instruction. Click a line of its listing to light the hardware that instruction
        uses; <strong>Slow</strong> runs the kernel at a pace you set (a gate delay, a cycle or an instruction at a time), the highlight following each
        instruction onto the lanes it runs on.</p>
        <div class="try">Run to halt, then open a lane and its register file: four different sets of values from one instruction stream.</div>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['lane0', 'lane1', 'lane2', 'lane3'] }),
    },
    {
      title: 'The leader',
      body: `
        <p>One PC means one branch decision per instruction. The lanes all compute the comparison, but only one is listened to: the <strong>leader</strong>, the
        lowest active lane. A <span data-show="lead">lowest-set-bit circuit</span> turns the active mask into a one-hot word, and one-hot multiplexers (an AND per bit and an OR tree: no decoder,
        the select is already one-hot) bring the <span data-show="lF">leader's ALU flags</span> to the <span data-show="npc">next-PC logic</span> and its
        <span data-show="lAlu">ALU result</span> to the <span data-show="clr0">jalr target</span>.</p>
        <p>In saxpy the branch agrees in every lane: each lane does exactly four elements, so <code>blt t3, t2, loop</code> is taken or not taken by all of them at
        once. When lanes disagree, the leader's choice is wrong for the others; <a href="#/c/simt/0">chapter 27</a> fixes that.</p>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['lead', 'lF', 'lAlu', 'npc'] }),
    },
    {
      title: 'One memory port',
      body: `
        <p>Four lanes produce four addresses per load, and the <span data-show="dm">data memory</span> has one port. The
        <span data-show="mseq"><strong>memory sequencer</strong></span> serves the lowest active lane not yet served, one per cycle (one-hot multiplexers pick its
        <span data-show="mAd mWd">address and store data</span>), writing the loaded word into that lane's registers only, and holds the PC until none is left. A load or store therefore takes as
        many cycles as there are active lanes.</p>
        <p>saxpy runs 74 instructions in 134 cycles: 20 of them are loads or stores at 4 cycles each (80 cycles), the other 54 take one.</p>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['mseq', 'mAd', 'mWd'] }),
      challenge: {
        kind: 'quiz', question: 'A sw executes with lanes 0, 1 and 3 active. How many cycles does it take, and in which order are the lanes written?',
        options: ['1 cycle, all at once', '3 cycles: lanes 0, 1, 3', '4 cycles: lanes 0, 1, 2, 3', '3 cycles: lanes 3, 1, 0'], answer: 1,
        explain: 'One cycle per active lane, lowest first: the sequencer\'s lowest-set-bit circuit picks lane 0, then 1, then 3, clearing each from its "lanes left" register. Lane 2 is masked off and never served.',
        why: ['The data memory has one port: it serves one lane per cycle.', '', 'Lane 2 is masked off: the sequencer never serves it.', 'The sequencer\'s lowest-set-bit circuit serves the lowest lane first.'],
      },
    },
    {
      title: 'Lanes against cores',
      body: `
        <p>The same work on <a href="#/c/multicore/0">chapter 24</a>'s cores, four of them, each finding its index with <code>csrr mhartid</code>, against the lane core. Both bars are counted
        from the actual designs, and both cycle counts come from the instruction-set simulators, which the gate-level circuits match cycle for cycle.</p>
        <p>The lanes save the front end three times over, yet only about a fifth of the gates: here a lane is mostly its register file (23 141 of its 27 584 NANDs,
        flip-flops and multiplexers). And they are slower on saxpy, because a load or store stops all four lanes, while a core that waits for the memory port lets
        the other three compute. Real GPUs answer both: memory as wide as a warp, with a <strong>coalescer</strong> merging neighbouring addresses into one access
        (<a href="#/c/feed/0">chapter 29</a>), and many warps so that one waiting does not idle the lanes (<a href="#/c/warps/0">chapter 28</a>). Their register files are SRAM, and the cores they compete with have
        large front ends (out-of-order logic, predictors, caches), so the sharing pays far more than it does here.</p>`,
      widget: lanesVsCoresWidget,
    },
  ],
};

export const chSimt: Chapter = {
  id: 'simt', num: 27, title: 'Threads in lock-step', level: 'Throughput',
  blurb: 'The active mask, divergent branches, split / join and the reconvergence stack, predication, and what divergence costs.',
  goals: [
    'say what the active mask switches off in a lane, and what it leaves running',
    'trace split and join through the reconvergence stack on a divergent if, nested ifs included',
    'turn lanes off with pred for loops of different lengths, without a stack entry',
    'compute the lane utilization of a divergent branch',
  ],
  builds: ['lanes'],
  recap: {
    keep: [
      'The active mask: a lane whose bit is 0 still sees every instruction, but its register write enable is off and the memory sequencer skips it. The register stores the mask inverted, so all lanes are active at power-on. <code>tmc</code> loads it from the leader\'s rs1.',
      'Without help, a divergent branch follows the leader, and the other lanes compute the wrong side.',
      '<code>split</code> runs the lanes with rs1 ≠ 0 first and pushes one entry: the mask before, the waiting lanes, the resume PC, a pending bit. The first <code>join</code> switches to the waiting lanes and jumps back; the second restores the mask and pops.',
      'The stack is a shift register of four entries: four levels of nesting. <code>pred</code> turns lanes off without an entry, for loops whose length differs per lane.',
      'Divergence runs both sides, each with part of the lanes: 45 % of the lane-steps did work in the tmc kernel, 58 % with the nested ifs.',
    ],
    practise: ['k_mask', 'k_stack', 'k_simt', 'p_reduce'],
    check: [
      {
        question: 'At power-on every flip-flop is 0. Why are all four lanes active?',
        options: ['The mask register stores the mask inverted', 'Every kernel starts with a <code>tmc</code>', 'The leader turns the other lanes on', 'A reset pin sets every mask bit'],
        answer: 0,
        explain: 'A stored 0 means "active", so the all-zero power-on state is the full mask, with no reset logic.',
        why: ['', 'No instruction is needed: the first instruction already runs on every lane.', 'The leader steers branches and supplies operands; it sets no mask bits.', 'The core has no reset pin: power-on zeroes the flip-flops, and the inverted storage turns that into all ones.'],
      },
      {
        question: 'Lanes 0–3 reach <code>split t1</code> with t1 = 0, 5, 0, 7. What runs first, and what is pushed?',
        options: ['Lanes 1 and 3; an entry with mask 1111, else lanes 0 and 2, the resume PC, pending set', 'Lanes 0 and 2, the leader\'s side', 'All four: split only marks the branch', 'Lanes 1 and 3; an entry holding only the resume PC'],
        answer: 0,
        explain: 'Lanes with t1 ≠ 0 go first; the entry remembers the mask to restore, the lanes to run next, where they resume, and that they are still pending.',
        why: ['', 'split does not follow the leader: the lanes with t1 ≠ 0 go first, whichever lane leads.', 'split changes the mask at once: the waiting lanes are off until the first join.', 'Without the old mask and the waiting lanes, join could neither switch sides nor bring the warp back together.'],
      },
      {
        question: 'A kernel nests five ifs, each with its own split. What happens on this core?',
        options: ['The fifth split loses the bottom stack entry', 'The stack spills into data memory', 'The fifth split is ignored and its if runs on every lane', 'The core waits until a join frees an entry'],
        answer: 0,
        explain: 'The stack is four entries in a shift register: a push shifts everything down, and the bottom entry falls off. The instruction-set simulator stops with a stack overflow instead.',
        why: ['', 'The stack is four entries of flip-flops; nothing connects it to memory.', 'The split still pushes, and the shift register drops its bottom entry.', 'Nothing in the hardware waits for a free entry.'],
      },
    ],
  },
  steps: [
    {
      title: 'The active mask',
      body: `
        <p>Each lane has one bit in the <span data-show="simt"><strong>active mask</strong></span>. A lane whose bit is 0 still sees every instruction, but its
        <span data-show="weg">register write enable</span> is off and the <span data-show="mseq">memory sequencer</span> skips it. The mask register stores the
        mask inverted, so at power-on, with every flip-flop at 0, all lanes are active.</p>
        <p><code>tmc rs1</code> (thread mask control) loads the mask from the <span data-show="lA">leader's rs1</span>. Here every lane stores a value, then <code>tmc</code> with 1 leaves lane 0
        alone to add them up, and <code>tmc</code> with −1 brings the others back. While lane 0 works alone the other three idle: 45 % of the lane-steps do work in
        this kernel.</p>`,
      scene: () => laneCoreScene('tmc'),
    },
    {
      title: 'When lanes disagree',
      body: `
        <p>Odd lanes should compute 3·lane, even lanes lane / 2. Written as a plain <code>if</code>, the lanes disagree at <code>beqz</code>: lanes 0 and 2 want to
        branch, lanes 1 and 3 do not. One PC cannot go both ways, so the warp follows its <span data-show="lead">leader</span> (lane 0) to the even path, and the
        odd lanes compute the even result. The instruction-set simulator counts the divergent branch; the hardware simply follows the leader.</p>`,
      scene: () => laneCoreScene('nosplit'),
      challenge: {
        kind: 'quiz', question: 'With the leader deciding, what does lane 3 store?',
        options: ['9 (3 · 3)', '1 (3 / 2)', 'Nothing: it is masked off', '0'], answer: 1,
        explain: 'Lane 3 is active the whole time; the warp went down the even path because lane 0 is even, so lane 3 ran srli and stored 3 >> 1 = 1.',
        why: ['That is what lane 3 should store; but the warp took the even path with its leader.', '', 'Nothing changes the mask in this kernel: lane 3 stays active and runs the even path.', 'The even path computes lane / 2, and 3 >> 1 is 1, not 0.'],
      },
    },
    {
      title: 'split and join',
      body: `
        <p>The fix runs the two sides one after the other. <code>split t1</code> divides the active lanes: those with <span data-show="pm">t1 ≠ 0</span> go first,
        the others wait. It pushes one <span data-show="simt">stack entry</span>: the mask before the split, the waiting (else) lanes, where they will resume (the instruction after the split), and a pending bit. The branch
        after the split is now uniform: every active lane agrees.</p>
        <p>The <code>join</code> at the end of the if is reached twice. The first time the entry is pending: the else lanes become the mask and the
        <span data-show="jmux">PC jumps back</span> to just after the split, where their branch goes the other way. The second time it is not: the original mask comes back and the entry is popped. This is
        the scheme of Vortex, the open-source RISC-V GPU. A split on which the lanes agree pushes an entry with nothing pending, so its join just pops.</p>
        <div class="try">Watch the stack and the mask grid as the clock passes each join: odd lanes, then even lanes, then all four. <strong>Pulse</strong> pauses the clock for one edge at a time.</div>`,
      scene: () => laneCoreScene('diverge'),
    },
    {
      title: 'An if inside an if',
      body: `
        <p>Each split pushes one entry, so nested ifs nest on the stack. The <span data-show="simt">stack</span> is a shift register of four entries (the top is
        entry 0): a push shifts everything down, a pop shifts it up. Four entries allow four levels of nesting; a fifth split would lose the bottom entry, and the
        instruction-set simulator stops with a stack overflow instead.</p>
        <p>The lanes split twice here: odd and even, then within the odd lanes on bit 1. Each path runs with only the lanes that took it, so only 58 % of the
        lane-steps do work.</p>`,
      scene: () => laneCoreScene('nested'),
    },
    {
      title: 'Loops of different lengths',
      body: `
        <p>Lane l adds up l + 1, l, …, 1, so the lanes need 1 to 4 iterations. <code>pred t1, s0</code> turns off the lanes whose
        <span data-show="pm">t1 reached 0</span>, without a stack entry (predication); when no lane would remain, it loads the
        <span data-show="simt">mask</span> from the <span data-show="lB">leader's s0</span> instead, saved at the start with <code>csrr s0, tmask</code>. The loop's
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
        why: ['That needs every lane busy on every instruction, which only happens without divergence.', 'That is the then-side alone (3 of 4 lanes); the warp also runs the else-side, with one lane busy.', '', 'That is the else-side alone (1 of 4 lanes); the then-side runs at 75 %.'],
      },
    },
  ],
};

export const chWarps: Chapter = {
  id: 'warps', num: 28, title: 'Hiding latency', level: 'Throughput',
  blurb: 'A memory that answers 8 cycles later: a scoreboard, several warps resident, a scheduler picking a ready one each cycle, and what each warp costs.',
  goals: [
    'say why a GPU hides memory latency with more warps rather than with caches',
    'follow a load through the scoreboard: which instruction waits, and until which cycle',
    'say what a warp slot holds and what all warps share',
    'judge when another resident warp stops paying, from empty issue slots and its gate cost',
  ],
  builds: ['simt', 'multicore'],
  recap: {
    keep: [
      'Here memory answers 8 cycles later: a load issued in cycle t is written back at the end of t + 7, and its first use can issue in t + 8. One warp runs saxpy over 64 elements in 266 cycles, 42 % of its issue slots empty.',
      'A scoreboard, one pending bit per register, stops a warp only at the first instruction that reads a pending register or writes one.',
      'A warp slot holds a PC, a mask and stack, a running bit and a scoreboard; each lane holds a register bank per warp. The program ROM, the decoder, the ALUs and the memory are shared.',
      'A round-robin scheduler issues one ready warp a cycle. Four warps: 172 instructions in 172 cycles, the latency hidden; two warps 192 cycles, one 266.',
      'The second warp costs 110 715 NANDs, 92 564 of them registers. A real GPU fixes the register file, and the registers a thread needs decide how many warps fit: the occupancy.',
    ],
    practise: ['k_warps'],
    check: [
      {
        question: 'One warp, 8-cycle loads. Why does saxpy\'s second <code>lw</code> issue right behind the first?',
        options: ['It reads no pending register and writes another one, so the scoreboard lets it go', 'Loads skip the scoreboard check', 'The memory has a second port for it', 'It goes to a faster memory'],
        answer: 0,
        explain: 'The scoreboard only stops an instruction whose rs1, rs2 or rd is pending. The two loads are independent, so both are in flight at once and the warp stops only at the first use.',
        why: ['', 'A load is checked like any instruction, rd included: it must not overwrite a register another load is about to fill.', 'Ports are not the limit: one request enters the memory pipeline every cycle. The memory is slow, not busy.', 'Every load in this chapter\'s core takes 8 cycles; a faster shared memory comes in the next chapter.'],
      },
      {
        question: 'What does a second resident warp add to the core?',
        options: ['A slot (PC, mask, stack, running bit, scoreboard), a register bank in every lane and a read of the program ROM', 'A second decoder, ALUs and memory', 'Only a PC', 'Four more ALUs, so two warps issue at once'],
        answer: 0,
        explain: 'Only state is copied, plus what reads it: 110 715 NANDs, of which 92 564 are the new register banks.',
        why: ['', 'The decoder, the ALUs and the memory are shared; only one warp issues per cycle.', 'Each thread\'s registers must survive while the other warp runs: the register banks are most of the cost.', 'One warp issues per cycle, so the lanes\' ALUs are shared by all warps.'],
      },
      {
        question: 'A GPU has 65 536 registers per streaming multiprocessor. A kernel needs 64 registers per thread. How many threads fit?',
        options: ['1 024', '2 048', '512', '65 536'],
        answer: 0,
        explain: '65 536 / 64 = 1 024 threads, 32 warps of 32: half the 2 048 that fit at 32 registers a thread.',
        why: ['', 'That is at 32 registers a thread.', 'That would be 128 registers a thread.', 'That counts registers, not threads.'],
      },
    ],
  },
  steps: [
    {
      title: 'A memory that makes you wait',
      body: `
        <p>Until now the data memory answered in the cycle it was asked. Real memory does not: a DRAM access takes on the order of 100 ns, hundreds of cycles, and a
        CPU hides that with caches because one thread keeps reusing a little data. A GPU streams through data it touches once, so caches help it much less.</p>
        <p>Here the <span data-show="mem">memory</span> sits behind a <strong>pipeline of 8 cycles</strong>: a load or store enters with its warp, destination register, active lanes,
        addresses and data, and reaches the memory 7 pipeline registers later. A load issued in cycle t is written back at the end of cycle t + 7, so an
        instruction that needs it can issue in cycle t + 8. One request enters every cycle: the memory is slow, not busy. (Each lane still has a port of its own
        into the memory; <a href="#/c/feed/0">chapter 29</a> replaces them with one port and a coalescer.)</p>
        <p>One warp runs saxpy over 64 elements already in memory: 154 instructions in 266 cycles. 112 issue slots, 42 %, pass with nothing to issue.</p>
        <div class="try">Run to halt and read the issue timeline: after each pair of <code>lw</code>s, the warp sits striped (a load in flight) and the idle row fills.</div>`,
      scene: () => warpCoreScene('saxpy64', { warps: 1, highlight: ['mem'] }),
      tries: [halted],
    },
    {
      title: 'A scoreboard',
      body: `
        <p>The warp need not stop at the load itself, only at the first instruction that needs its value. <span data-show="warp0">Each warp</span> keeps a
        <strong>scoreboard</strong>: one pending bit per register, set when a load to that register issues, cleared in the cycle its word is written back. Before
        an instruction issues, the <span data-show="hz0">scoreboard check</span> reads the pending bits of the registers it uses: rs1 and rs2 if its opcode reads them, rd if it writes one (a load must not overwrite
        a register another load is about to fill). Any pending bit set: not ready.</p>
        <p>In saxpy the two loads issue back to back, both in flight at once, and the warp stops only at <code>slli a0, t5, 1</code>, the first use of x[i].
        A load costs the warp 8 − 1 = 7 cycles at most, less when independent work follows it: moving loads up is the compiler's job on a real GPU.</p>`,
      scene: () => warpCoreScene('saxpy64', { warps: 1, highlight: ['hz0', 'warp0'] }),
      challenge: {
        kind: 'quiz', question: 'lw t5, 0(t4) issues in cycle 10 with 8-cycle loads. lw a1, 256(t4) follows. In which cycle can add a0, a0, a1 issue at the earliest?',
        options: ['Cycle 11', 'Cycle 18', 'Cycle 19', 'Cycle 26'], answer: 2,
        explain: 'The second load issues in cycle 11 (it does not depend on the first), so a1 is written back at the end of cycle 18 and an instruction reading it can issue in cycle 19. Waiting for each load in turn would push it to cycle 26.',
        why: ['Cycle 11 is when the second load issues; its word is still 7 cycles away.', 'a1 is written back at the end of cycle 18, so an instruction reading it issues one cycle later.', '', 'That waits for each load in turn; the second load does not depend on the first, so both are in flight at once.'],
      },
    },
    {
      title: 'Many warps resident',
      body: `
        <p>While one warp waits, another could issue, if the core holds several. Each <span data-show="warp0 warp1 warp2 warp3"><strong>warp slot</strong></span>
        keeps one warp's PC, its active mask and split / join stack, a running bit and its scoreboard; <span data-show="lane0 lane1 lane2 lane3">each lane</span>
        keeps one register bank per warp, and the <span data-show="wid">warp number</span> picks the bank. Nothing else is copied: the program ROM, the
        <span data-show="ctl sdec">decoder</span>, the ALUs and the <span data-show="mem">memory</span> are shared.</p>
        <p>Warp 0 runs from reset and starts the others: <span data-show="spGo"><code>wspawn t0, t1</code></span> starts warps 1 to t0 − 1 at the address in t1, every lane active. A thread
        learns who it is with <code>csrr t0, tid</code>, now warp · 4 + lane, and how many threads there are from <code>nwarps</code>: thread tid takes
        elements tid, tid + 16, tid + 32 and tid + 48.</p>
        <p>A returning load writes its word into its own warp's bank, through the bank's one write port. That warp sits out the cycle, so the issuing warp
        and the load never write the same bank at once.</p>`,
      scene: () => warpCoreScene('saxpy64', { warps: 4, highlight: ['warp0', 'warp1', 'warp2', 'warp3'] }),
    },
    {
      title: 'Picking a ready warp',
      body: `
        <p>A warp is <span data-show="rdy0 rdy1 rdy2 rdy3"><strong>ready</strong></span> when it runs, its next instruction passes the
        <span data-show="hz0 hz1 hz2 hz3">scoreboard check</span>, and none of its loads is being written back. The
        <span data-show="sched"><strong>scheduler</strong></span> is <a href="#/c/multicore/0">chapter 24</a>'s round-robin arbiter over the ready warps: the first at or after its pointer issues, and when two or more were
        ready, the pointer moves past the winner. One warp issues per cycle; its PC, mask and stack move, the others' stay.</p>
        <p>Four warps run the same 64 elements in 172 cycles for 172 instructions: not one issue slot is empty, and the 8-cycle latency is hidden entirely. Two
        warps take 192 cycles (83 % of the slots), one warp 266.</p>
        <div class="try">Switch between 1, 2 and 4 warps in the panel and compare the timelines: the colours interleave, and the idle row empties. Then press
        <strong>Slow</strong> at the issue level: each step is one issue, and the highlight follows the warp the scheduler picked through the shared front end.</div>`,
      scene: () => warpCoreScene('saxpy64', { warps: 4, highlight: ['sched'] }),
      challenge: {
        kind: 'quiz', question: 'Four warps issue 172 instructions; one warp alone issues 154 for the same 64 elements. Where do the 18 extra instructions come from?',
        options: ['Stalls counted as instructions', 'Each extra warp runs the prologue (tid, nwarps, the stride, the loop counters) and its final jump', 'The scheduler issues bubbles', 'wspawn runs once per warp'], answer: 1,
        explain: 'Every warp runs the 5-instruction prologue and its own j end: 6 instructions for each of the 3 extra warps. The work per element is the same; this per-warp overhead is why a kernel needs enough elements per thread.',
        why: ['A stall issues nothing: 172 counts issued instructions, and 172 cycles means no slot was empty.', '', 'An empty issue slot is not an instruction, and here there were none.', 'Only warp 0 runs wspawn, once, to start the other three.'],
      },
    },
    {
      title: 'Occupancy',
      body: `
        <p>A warp is cheap to switch to but not cheap to keep. The second warp adds 110 715 NANDs to the core: its registers, 31 × 32 bits in each of 4 lanes
        (92 564), a read of the program ROM for its next instruction (8 064), its slot of PC, mask, stack and scoreboard (6 203), its scoreboard check (736),
        the wspawn compare that starts it, and wider multiplexers. Each resident warp buys issue slots only while some are still empty: past that, it only adds gates.</p>
        <p>A real GPU turns the question around. Its register file is fixed (65 536 32-bit registers per streaming multiprocessor on recent NVIDIA parts), and a
        kernel's register count decides how many threads fit: at 32 registers a thread, 2 048 threads (64 warps of 32); at 64 registers, half as many. That
        fraction of the maximum is the <strong>occupancy</strong>. Fewer registers per thread, more warps, more latency hidden; too few registers, and the
        compiler spills to slow memory instead.</p>
        <p>The widget sweeps the warps and the load latency with the timing model, which the tests check against the gate-level core cycle for cycle.</p>`,
      widget: occupancyWidget,
    },
  ],
};

export const chFeed: Chapter = {
  id: 'feed', num: 29, title: 'Feeding the lanes', level: 'Throughput',
  blurb: 'One memory port a line wide: coalescing, a banked shared memory and bank conflicts, a barrier, atomics; a reduction, a histogram and a tiled matrix multiply.',
  goals: [
    'count the accesses a warp\'s load takes on a line-wide port, from its lanes\' addresses',
    'find bank conflicts in a banked shared memory, and remove one by padding',
    'say when a barrier is needed, and why amoadd.w serves one lane per access',
    'judge when tiling a matrix multiply pays, from memory bandwidth against extra instructions',
  ],
  builds: ['warps', 'cache'],
  recap: {
    keep: [
      'One port a 16-byte line wide replaces a port per lane: 77 829 NANDs instead of 183 964 for 128 words. The access unit serves the leader\'s line and every lane on it; each other line costs another access.',
      'Coalescing is a data-layout question: the same 76-instruction kernel takes 124 cycles by rows (68 accesses) and 76 by columns (20).',
      'Shared memory: 64 words in four banks (word w in bank w mod 4), loads in 2 cycles instead of 8. Different words in one bank conflict, one word read by several lanes is broadcast, and padding a 4-word row to 5 spreads a column over the banks.',
      '<code>bar rs1, rs2</code> holds each warp until rs2 warps have arrived: a waiting bit per warp and a population count. <code>amoadd.w</code> reads, adds and writes in one access, one lane per access, so lanes on one word all count.',
      'Tiling cut global accesses from 144 to 40 but ran 560 instructions instead of 396: here the plain kernel wins, 396 cycles to 592. Tiling pays only when memory is the bottleneck: in the chart, from one line every three cycles.',
    ],
    practise: ['k_coal', 'p_hist'],
    check: [
      {
        question: 'Lanes 0–3 load global words 0, 4, 8 and 12. How many accesses?',
        options: ['4', '1', '2', '3'],
        answer: 0,
        explain: 'A line is four words, so the four words sit in lines 0, 1, 2 and 3: one access each. That is the by-rows layout.',
        why: ['', 'One access serves only the lanes on the leader\'s line, and these addresses are 16 bytes apart.', 'Two accesses would need pairs of lanes on one line; here every line holds one of the four words.', 'Every lane is on a line of its own, so none can go along with another.'],
      },
      {
        question: 'Four lanes read shared-memory word 3, all of them. How many accesses?',
        options: ['1: the word is broadcast', '4: they are all in bank 3', '2', '0: shared memory is a cache'],
        answer: 0,
        explain: 'Lanes asking for the same word share it. A conflict needs two different words in one bank.',
        why: ['', 'One bank, but one word: a conflict needs two different rows of the same bank.', 'There is one word to fetch, and one access serves every lane that asked for it.', 'Shared memory is a scratchpad the threads address explicitly: every load is an access.'],
      },
      {
        question: 'The tiled matrix multiply makes 40 global accesses instead of 144. Why does it still lose on this core?',
        options: ['It runs 560 instructions instead of 396, and this memory takes a line every cycle', 'Its barriers serialize the warps for good', 'Shared memory is slower than global memory here', 'Its bank conflicts cost more than the accesses saved'],
        answer: 0,
        explain: 'A global access costs the issue port no more than a shared one, and four warps hide the 8-cycle latency, so fewer accesses save nothing while the extra instructions cost cycles: 592 against 396.',
        why: ['', 'The barriers cost waiting, but the kernel loses because of its instruction count; with a slow enough memory the same barriers pay.', 'Shared loads take 2 cycles against 8: shared memory is the faster one.', 'A row of the A tile is one word for the whole warp, and a column of the B tile spans the four banks.'],
      },
    ],
  },
  steps: [
    {
      title: 'One port, a line wide',
      body: `
        <p><a href="#/c/warps/0">Chapter 28</a>'s memory gave every lane a read and a write port of its own: four address decoders and four 128-way multiplexers of 32 bits, 183 964 NANDs for
        128 words. No real memory is built that way. A DRAM moves a <em>burst</em> of neighbouring bytes per access, and a cache a whole line; here the memory reads
        and writes a <strong>16-byte line</strong>, four words side by side, through one port: 77 829 NANDs for the same 128 words.</p>
        <p>Four lanes now share that port. The <strong>access unit</strong> decides which of them one access serves: the lowest lane still to serve leads, and every
        lane whose address bits 31 … 4 match the leader's (the same line) goes along. The others wait for the next access. A memory instruction holds the issue
        port for one cycle per access, and its warp moves on only after the last: <a href="#/c/lanes/0">chapter 26</a>'s sequencer, looping over lines instead of lanes. Each access's words
        go back to the lanes it served; the scoreboard clears with the last.</p>
        <p>The widget evaluates the gate-level access unit (5 870 NANDs) on four addresses, then again on the lanes it left, until none is left.</p>
        <div class="try">Try stride 1 with offsets 0 and 1, then stride 3: when does a misaligned access cost a second cycle?</div>`,
      widget: () => accessWidget('global'),
      challenge: {
        kind: 'quiz', question: 'Lanes 0–3 load words 6, 7, 8 and 9. How many accesses does the instruction take, and which lanes does the first one serve?',
        options: ['1: all four', '2: lanes 0 and 1', '2: lanes 0, 1 and 2', '4: one lane each'], answer: 1,
        explain: 'Words 6 and 7 sit in line 1 (words 4–7), words 8 and 9 in line 2. The leader is lane 0 (word 6): lanes 0 and 1 go in the first access, lanes 2 and 3 in the second.',
        why: ['Words 6 to 9 straddle two lines (4–7 and 8–11), and one access serves one line.', '', 'Word 8 starts a new line (8–11), so lane 2 is not on the leader\'s line.', 'Lanes on the leader\'s line go along with it: two lanes per line here.'],
      },
    },
    {
      title: 'Coalescing',
      body: `
        <p>Sixteen threads each add up four values and store the sum. Stored <strong>by rows</strong>, thread g's values are words 4g … 4g + 3, so at each load the
        four lanes' addresses are 16 bytes apart: a line each, four <span data-show="acc mem">accesses</span>. Stored <strong>by columns</strong>, value j of thread g is word 16 j + g, the lanes'
        addresses are neighbours, and every load is one access. The program is the same 76 instructions either way.</p>
        <p>By rows: 68 accesses, 48 cycles holding the issue port, 124 cycles. By columns: 20 accesses and 76 cycles, every issue slot used. The data layout alone
        decides it. GPU programmers call the good case <em>coalesced</em> and arrange arrays so that neighbouring threads touch neighbouring words: a structure of
        arrays rather than an array of structures.</p>
        <div class="try">Run to halt by rows, then switch the kernel to columns: the faded cells in the timeline are the extra accesses, and they are gone.</div>`,
      scene: () => warpCoreScene('rows', { warps: 4, programs: ['rows', 'cols'], highlight: ['acc', 'mem'] }),
      tries: [halted],
    },
    {
      title: 'Banks',
      body: `
        <p>Next to the lanes sits a <strong>shared memory</strong>: 64 words at address 0x1000 (bit 12 of an address picks it), a scratchpad the threads read and
        write explicitly. It is on the chip, close to the lanes: an access enters the memory pipeline one register before the end, so a load takes 2 cycles instead
        of 8. Only one access reaches the memories per cycle, so a shared access waits a cycle when a global one issued 6 cycles earlier would arrive with it.</p>
        <p>It is built from four <strong>banks</strong>: word w lives in bank w mod 4, row w / 4, and each bank has its own row decoder (38 928 NANDs, 300 more than
        a line memory of the same size). One access then serves any four words in different banks, not just one line. Lanes asking for the same word share it (a
        broadcast). Two different words in one bank are a <strong>bank conflict</strong>: per bank the lowest lane picks the row, and a lane wanting another row
        waits for the next access.</p>
        <p>A column of a 4-wide array (stride 4) puts all four lanes in one bank: four accesses. Padding each row to 5 words spreads the column over the four
        banks.</p>`,
      widget: () => accessWidget('shared'),
      challenge: {
        kind: 'quiz', question: 'Four lanes read shared-memory words 0, 2, 4 and 6. How many accesses?',
        options: ['1', '2', '3', '4'], answer: 1,
        explain: 'Words 0 and 4 are both in bank 0 (rows 0 and 1), words 2 and 6 both in bank 2. The first access serves lanes 0 and 1 (bank 0 row 0, bank 2 row 0), the second lanes 2 and 3.',
        why: ['Words 0 and 4 are both in bank 0, on different rows: they conflict.', '', 'The two conflicts happen in different banks, side by side: each bank needs one extra access, and they share it.', 'Only different words in the same bank conflict; banks 0 and 2 each serve one word per access, in parallel.'],
      },
    },
    {
      title: 'A barrier',
      body: `
        <p>The sum of 64 words: each of the 16 threads adds four (coalesced) and writes its sum s[tid] into <span data-show="mem">shared memory</span>; then a tree halves the partial sums,
        s[i] += s[i + s] for s = 8, 4, 2, 1. At each level a thread reads a sum that a thread of <em>another warp</em> wrote, and the warps run in whatever order
        the <span data-show="sched">scheduler</span> picks. Something has to make the readers wait for the writers.</p>
        <p><code>bar rs1, rs2</code> is that: the warp waits at barrier rs1 until rs2 warps have arrived, itself included; the last to arrive releases them all.
        The hardware is <span data-show="atBar">a waiting bit per warp</span> (a waiting warp is not <span data-show="rdy0 rdy1 rdy2 rdy3">ready</span>) and,
        when a bar issues, a population count of those bits plus one, <span data-show="barCmp">compared with rs2</span>. Enough: every bit clears. This core has one barrier, so the warps must agree on rs1.</p>
        <p>With a bar between levels, a warp never reads shared data that another wrote without a barrier in between: the programming model. The
        instruction-set simulator then gives the same memory whatever order the warps run in, and the tests check every kernel under two orders. 298 cycles, many of them spent waiting at
        the barriers (barred cells): at the last levels one thread works and fifteen wait.</p>
        <div class="try">Switch to the strided version (s[2 s t] += s[2 s t + s]): the lanes' words are 2 s apart, so they fall into the same banks. 38 shared accesses
        instead of 20, 18 cycles holding the port, 330 cycles.</div>`,
      scene: () => warpCoreScene('reduceSeq', { warps: 4, programs: ['reduceSeq', 'reduceInt'], highlight: ['atBar', 'sched'] }),
    },
    {
      title: 'Atomics',
      body: `
        <p>A histogram: 64 values from 0 to 15, one count per value. Each thread adds 1 to the bin of each of its values, and two threads (two lanes of one warp,
        even) may hit the same bin at once. With <code>lw</code>, <code>addi</code>, <code>sw</code> they would all read the same count, add one, and store: four
        lanes on one bin count once.</p>
        <p><code>amoadd.w rd, rs2, (rs1)</code> reads the word at rs1, writes it back plus rs2 and returns the old value, all in one memory access, so nothing
        comes in between. In the lanes it is served <strong>one lane per access</strong>, lowest first: the <span data-show="acc">access unit</span> sends the
        leader alone, and an adder at the <span data-show="mem">memory</span> (a 32-bit Kogge–Stone, 878 NANDs) makes the new word. Lanes on one bin then all
        count, one after the other.</p>
        <p>16 loads and 64 atomic adds: 80 accesses, 48 cycles holding the port, 197 cycles. The <span data-show="xdec">decoder</span> hands amoadd.w to the
        <span data-show="ctl">control unit</span> disguised as <code>lw</code> (it reads memory and writes rd) and <span data-show="immA">zeroes its
        immediate</span>: the address is rs1.</p>`,
      scene: () => warpCoreScene('hist', { warps: 4, highlight: ['acc', 'xdec'] }),
      challenge: {
        kind: 'quiz', question: 'Lanes 0–3 of one warp run amoadd.w on bins 3, 3, 7, 3. How many accesses does it take, and what does bin 3 gain?',
        options: ['2 accesses, +3', '4 accesses, +3', '4 accesses, +1', '1 access, +3'], answer: 1,
        explain: 'amoadd.w serves one lane per access, so four accesses whatever the addresses; the three lanes on bin 3 each add 1. A plain load / add / store would leave bin 3 one higher, not three.',
        why: ['That would be coalescing by line; amoadd.w is never coalesced: the access unit sends the leader alone.', '', 'Each access reads, adds and writes back with nothing in between, so all three lanes on bin 3 count: that is what an atomic is for.', 'An amoadd.w access serves one lane, never four.'],
      },
    },
    {
      title: 'Tiles',
      body: `
        <p>A matrix multiply, C = A · B with A 8 × 4 and B 4 × 8, needs a multiplier in each lane: a Wallace tree keeping the low 32 bits of the product
        (<code>mul</code>, 7 388 NANDs a lane). The plain kernel computes C[i][j] from row i of A and column j of B straight from global memory: 8 loads per
        element, each one access (a warp's four threads share a row of A, one word for all, and read neighbouring columns of B).</p>
        <p>The tiled kernel uses shared memory as a staging area. Each thread copies one element of a 4 × 4 tile of A and one of B into shared memory,
        <code>bar</code>, computes its element of C from the tiles (a row of the A tile is one word for the whole warp, a column of the B tile spans the four
        banks), <code>bar</code>, next tile. Each tile element is loaded from global memory once and used by four threads: 40 global accesses instead of 144.</p>
        <p>It also runs 560 instructions instead of 396, and here that decides it. This memory takes a line every cycle, so a global access costs the issue port
        no more than a shared one, and four warps hide the 8-cycle latency: the plain kernel wins, 396 cycles to 592. Tiling trades instructions for memory traffic,
        which pays only when the memory is the bottleneck: in the chart, from one line every three cycles.</p>
        <p>On a real GPU it is, and kernels that reuse data (matrix multiply above all) are written in tiles for exactly this reason.</p>
        <details class="deeper"><summary>Deeper: the numbers on a real GPU</summary>
        <p>An H100 SXM moves 3.35 TB/s from its HBM3 to 132 SMs (streaming multiprocessors) at up to 1.98 GHz: under 13 bytes per SM per cycle, against 128 bytes
        per cycle from each SM's shared memory. Scaled to this core, whose shared memory moves 16 bytes a cycle, that is a line every ten cycles, past the right
        edge of the chart. Caches narrow the gap.</p></details>`,
      widget: tilingWidget,
    },
  ],
};
