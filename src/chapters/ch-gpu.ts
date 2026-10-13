import { divergenceWidget, laneCoreScene, lanesVsCoresWidget } from '../widgets/lanes';
import { accessWidget, tilingWidget } from '../widgets/feed';
import { occupancyWidget, warpCoreScene } from '../widgets/warps';
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
        <p>Along the top, the single-cycle CPU's front end: PC, program ROM, control unit, immediate generator, next-PC logic. Below, four <strong>LANE</strong>
        boxes. Open one: a 31 × 32-bit register file, the SrcA / SrcB multiplexers, an ALU and the result multiplexer, exactly the single-cycle datapath. Every lane
        receives the same rs1, rs2 and rd fields, the same control signals and the same immediate; only its registers differ.</p>
        <p>A lane learns which thread it is with <code>csrr t0, tid</code>: a constant wired into each lane (0, 1, 2, 3) answers. Here every lane takes the elements
        i = tid, tid + 4, tid + 8, tid + 12 of y = 3·x + y. <code>nlanes</code> reads 4, <code>lane</code> the lane number, <code>tmask</code> the active mask.</p>
        <p>The Warp panel runs the SIMT golden model (riscv/simt.ts) in lock-step and compares the PC, the mask and every lane's registers after each instruction. Click a line of its listing to light the hardware that instruction
        uses; <strong>Slow</strong> runs the kernel at a pace you set (a gate delay, a cycle or an instruction at a time), the highlight following each
        instruction onto the lanes it runs on.</p>
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
        <div class="try">Watch the stack and the mask grid as the clock passes each join: odd lanes, then even lanes, then all four. <strong>Pulse</strong> pauses the clock for one edge at a time.</div>`,
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

export const chWarps: Chapter = {
  id: 'warps', num: 28, title: 'Hiding latency', level: 'Throughput',
  blurb: 'A memory that answers 8 cycles later: a scoreboard, several warps resident, a scheduler picking a ready one each cycle, and what each warp costs.',
  steps: [
    {
      title: 'A memory that makes you wait',
      body: `
        <p>Until now the data memory answered in the cycle it was asked. Real memory does not: a DRAM access takes on the order of 100 ns, hundreds of cycles, and a
        CPU hides that with caches because one thread keeps reusing a little data. A GPU streams through data it touches once, so caches help it much less.</p>
        <p>Here the memory sits behind a <strong>pipeline of 8 cycles</strong>: a load or store enters with its warp, destination register, active lanes,
        addresses and data, and reaches the memory 7 pipeline registers later. A load issued in cycle t is written back at the end of cycle t + 7, so an
        instruction that needs it can issue in cycle t + 8. One request enters every cycle: the memory is slow, not busy. (Each lane still has a port of its own
        into the memory; chapter 29 replaces them with one port and a coalescer.)</p>
        <p>One warp runs saxpy over 64 elements already in memory: 154 instructions in 266 cycles. 112 issue slots, 42 %, pass with nothing to issue.</p>
        <div class="try">Run to halt and read the issue timeline: after each pair of <code>lw</code>s, the warp sits striped (a load in flight) and the idle row fills.</div>`,
      scene: () => warpCoreScene('saxpy64', { warps: 1, highlight: ['mem'] }),
    },
    {
      title: 'A scoreboard',
      body: `
        <p>The warp need not stop at the load itself, only at the first instruction that needs its value. Each warp keeps a <strong>scoreboard</strong>: one
        pending bit per register, set when a load to that register issues, cleared in the cycle its word is written back. Before an instruction issues, the
        scoreboard check reads the pending bits of the registers it uses: rs1 and rs2 if its opcode reads them, rd if it writes one (a load must not overwrite
        a register another load is about to fill). Any pending bit set: not ready.</p>
        <p>In saxpy the two loads issue back to back, both in flight at once, and the warp stops only at <code>slli a0, t5, 1</code>, the first use of x[i].
        A load costs the warp 8 − 1 = 7 cycles at most, less when independent work follows it: moving loads up is the compiler's job on a real GPU.</p>`,
      scene: () => warpCoreScene('saxpy64', { warps: 1, highlight: ['hz0', 'warp0'] }),
      challenge: {
        kind: 'quiz', question: 'lw t5, 0(t4) issues in cycle 10 with 8-cycle loads. lw a1, 256(t4) follows. In which cycle can add a0, a0, a1 issue at the earliest?',
        options: ['Cycle 11', 'Cycle 18', 'Cycle 19', 'Cycle 26'], answer: 2,
        explain: 'The second load issues in cycle 11 (it does not depend on the first), so a1 is written back at the end of cycle 18 and an instruction reading it can issue in cycle 19. Waiting for each load in turn would push it to cycle 26.',
      },
    },
    {
      title: 'Many warps resident',
      body: `
        <p>While one warp waits, another could issue, if the core holds several. Each <strong>warp slot</strong> keeps one warp's PC, its active mask and
        split / join stack, a running bit and its scoreboard; each lane keeps one register bank per warp, and the warp number picks the bank. Nothing else is
        copied: the program ROM, the decoder, the ALUs and the memory are shared.</p>
        <p>Warp 0 runs from reset and starts the others: <code>wspawn t0, t1</code> starts warps 1 to t0 − 1 at the address in t1, every lane active. A thread
        learns who it is with <code>csrr t0, tid</code>, now warp · 4 + lane, and how many threads there are from <code>nwarps</code>: thread tid takes
        elements tid, tid + 16, tid + 32 and tid + 48.</p>
        <p>A returning load writes its word into its own warp's bank, through the bank's one write port. That warp sits out the cycle, so the issuing warp
        and the load never write the same bank at once.</p>`,
      scene: () => warpCoreScene('saxpy64', { warps: 4, highlight: ['warp0', 'warp1', 'warp2', 'warp3'] }),
    },
    {
      title: 'Picking a ready warp',
      body: `
        <p>A warp is <strong>ready</strong> when it runs, its next instruction passes the scoreboard check, and none of its loads is being written back. The
        <strong>scheduler</strong> is chapter 24's round-robin arbiter over the ready warps: the first at or after its pointer issues, and when two or more were
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
  steps: [
    {
      title: 'One port, a line wide',
      body: `
        <p>Chapter 28's memory gave every lane a read and a write port of its own: four address decoders and four 128-way multiplexers of 32 bits, 183 964 NANDs for
        128 words. No real memory is built that way. A DRAM moves a <em>burst</em> of neighbouring bytes per access, and a cache a whole line; here the memory reads
        and writes a <strong>16-byte line</strong>, four words side by side, through one port: 77 829 NANDs for the same 128 words.</p>
        <p>Four lanes now share that port. The <strong>access unit</strong> decides which of them one access serves: the lowest lane still to serve leads, and every
        lane whose address bits 31 … 4 match the leader's (the same line) goes along. The others wait for the next access. A memory instruction holds the issue
        port for one cycle per access, and its warp moves on only after the last: chapter 26's sequencer, looping over lines instead of lanes. Each access's words
        go back to the lanes it served; the scoreboard clears with the last.</p>
        <p>The widget evaluates the gate-level access unit (5 870 NANDs) on four addresses, then again on the lanes it left, until none is left.</p>
        <div class="try">Try stride 1 with offsets 0 and 1, then stride 3: when does a misaligned access cost a second cycle?</div>`,
      widget: () => accessWidget('global'),
      challenge: {
        kind: 'quiz', question: 'Lanes 0–3 load words 6, 7, 8 and 9. How many accesses does the instruction take, and which lanes does the first one serve?',
        options: ['1: all four', '2: lanes 0 and 1', '2: lanes 0, 1 and 2', '4: one lane each'], answer: 1,
        explain: 'Words 6 and 7 sit in line 1 (words 4–7), words 8 and 9 in line 2. The leader is lane 0 (word 6): lanes 0 and 1 go in the first access, lanes 2 and 3 in the second.',
      },
    },
    {
      title: 'Coalescing',
      body: `
        <p>Sixteen threads each add up four values and store the sum. Stored <strong>by rows</strong>, thread g's values are words 4g … 4g + 3, so at each load the
        four lanes' addresses are 16 bytes apart: a line each, four accesses. Stored <strong>by columns</strong>, value j of thread g is word 16 j + g, the lanes'
        addresses are neighbours, and every load is one access. The program is the same 76 instructions either way.</p>
        <p>By rows: 68 accesses, 48 cycles holding the issue port, 124 cycles. By columns: 20 accesses and 76 cycles, every issue slot used. The data layout alone
        decides it. GPU programmers call the good case <em>coalesced</em> and arrange arrays so that neighbouring threads touch neighbouring words: a structure of
        arrays rather than an array of structures.</p>
        <div class="try">Run to halt by rows, then switch the kernel to columns: the faded cells in the timeline are the extra accesses, and they are gone.</div>`,
      scene: () => warpCoreScene('rows', { warps: 4, programs: ['rows', 'cols'], highlight: ['acc', 'mem'] }),
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
      },
    },
    {
      title: 'A barrier',
      body: `
        <p>The sum of 64 words: each of the 16 threads adds four (coalesced) and writes its sum s[tid] into shared memory; then a tree halves the partial sums,
        s[i] += s[i + s] for s = 8, 4, 2, 1. At each level a thread reads a sum that a thread of <em>another warp</em> wrote, and the warps run in whatever order
        the scheduler picks. Something has to make the readers wait for the writers.</p>
        <p><code>bar rs1, rs2</code> is that: the warp waits at barrier rs1 until rs2 warps have arrived, itself included; the last to arrive releases them all.
        The hardware is a waiting bit per warp (a waiting warp is not ready) and, when a bar issues, a population count of those bits plus one, compared with
        rs2. Enough: every bit clears. This core has one barrier, so the warps must agree on rs1.</p>
        <p>With a bar between levels, a warp never reads shared data that another wrote without a barrier in between: the programming model. The golden model
        then gives the same memory whatever order the warps run in, and the tests check every kernel under two orders. 298 cycles, many of them spent waiting at
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
        comes in between. In the lanes it is served <strong>one lane per access</strong>, lowest first: the access unit sends the leader alone, and an adder at
        the memory (a 32-bit Kogge–Stone, 878 NANDs) makes the new word. Lanes on one bin then all count, one after the other.</p>
        <p>16 loads and 64 atomic adds: 80 accesses, 48 cycles holding the port, 197 cycles. The decoder hands amoadd.w to the control unit disguised as
        <code>lw</code> (it reads memory and writes rd) and zeroes its immediate: the address is rs1.</p>`,
      scene: () => warpCoreScene('hist', { warps: 4, highlight: ['acc', 'xdec'] }),
      challenge: {
        kind: 'quiz', question: 'Lanes 0–3 of one warp run amoadd.w on bins 3, 3, 7, 3. How many accesses does it take, and what does bin 3 gain?',
        options: ['2 accesses, +3', '4 accesses, +3', '4 accesses, +1', '1 access, +3'], answer: 1,
        explain: 'amoadd.w serves one lane per access, so four accesses whatever the addresses; the three lanes on bin 3 each add 1. A plain load / add / store would leave bin 3 one higher, not three.',
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
        <p>On a real GPU it is. An H100 SXM moves 3.35 TB/s from its HBM3 to 132 SMs at up to 1.98 GHz: under 13 bytes per SM per cycle, against 128 bytes per cycle
        from each SM's shared memory. Scaled to this core, whose shared memory moves 16 bytes a cycle, that is a line every ten cycles, past the right edge of the
        chart. Caches narrow the gap, and kernels that reuse data (matrix multiply above all) are written in tiles for exactly this reason.</p>`,
      widget: tilingWidget,
    },
  ],
};
