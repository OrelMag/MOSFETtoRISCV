import { groupDigits } from '../sim/numfmt';
import { stackEntryWidth } from '../lib/lanes';
import { divergenceWidget, laneCoreScene, lanesVsCoresWidget } from '../widgets/lanes';
import { accessWidget, tilingWidget } from '../widgets/feed';
import { occupancyWidget, warpCoreScene } from '../widgets/warps';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

/** The warp core's `halted` output: every warp has run to its end (0 from power-on). */
function halted(st: Stage): boolean {
  try { return st.value('halted') === 1; } catch { return false; }
}

const pct = (a: number, b: number) => `${Math.round((100 * a) / b)} %`;
const fmt = groupDigits;
/** saxpy on the lane core (chapter lanes): instructions run, loads and stores among them, lanes; one cycle per active lane for a memory instruction. */
const SAXPY = { instrs: 74, mem: 20, lanes: 4 };
const SAXPY_CYCLES = SAXPY.instrs - SAXPY.mem + SAXPY.mem * SAXPY.lanes;
/** Chapter warps: one warp on saxpy64 with 8-cycle loads. */
const WARP1 = { instrs: 154, cycles: 266, latency: 8 };

export const chLanes: Chapter = {
  id: 'lanes', num: numOf('lanes'), title: 'Lanes', level: 'Throughput',
  blurb: 'One fetch and decode feeding four ALUs, each with its own registers: a lane core, measured against four cores.',
  goals: [
    'say what a lane core has once (PC, fetch, decode, control) and what it copies per lane (registers, ALU, result multiplexer)',
    'explain how one PC takes a branch: the leader, the lowest active lane, decides',
    'count the cycles of a load or store on one memory port: one per active lane',
    'explain why four lanes save under a fifth of the gates of four cores here, most of it program ROMs, and run saxpy slower',
  ],
  builds: ['cpu', 'multicore'],
  recap: {
    keep: [
      'A lane core is one PC, one program ROM, one control unit and N lanes, each a 31 × 32-bit register file, SrcA / SrcB multiplexers, an ALU and a result multiplexer. Every lane gets the same fields, control signals and immediate.',
      'A thread finds out which it is with <code>csrr t0, tid</code>, a constant wired into each lane. The threads stepping together form a <em>warp</em> (SIMT: single instruction, multiple threads).',
      'On this core one PC means one branch decision: the <strong>leader</strong>, the lowest active lane, found by a lowest-set-bit circuit, sends its flags to the next-PC logic through one-hot multiplexers.',
      'With one memory port, a load or store takes one cycle per active lane, lowest first: saxpy runs 74 instructions in 134 cycles.',
      'Against four cores the lanes save 18 % of the gates, and 24 192 of the 32 670 NANDs saved are the three program ROMs they do without; without ROMs the saving is 6 %, because a lane is mostly its register file (23 141 of its 27 584 NANDs). And they are slower on saxpy: a memory access stops all four lanes.',
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
        explain: 'A lowest-set-bit circuit turns the lane enable bits into a one-hot word, and one-hot multiplexers bring that lane\'s ALU flags to the next-PC logic.',
        why: ['', 'The leader is the lowest active lane, not the highest.', 'There is no voting logic: one-hot multiplexers pass exactly one lane\'s flags.', 'This core does not check that the lanes agree: when they disagree it follows the leader, which is wrong for the others.'],
      },
    ],
  },
  steps: [
    {
      title: 'Latency or throughput',
      body: `
        <p>Chapters <a href="#/c/pipeline/0">17</a> to <a href="#/c/ooo/0">26</a> spent gates on <em>latency</em>: forwarding, branch prediction, caches and out-of-order issue all make one instruction stream finish sooner. Many
        workloads are instead thousands of independent copies of one small program: a pixel, a matrix element, a neuron's activation. For them the figure of
        merit is results per second per gate (and per watt), and the latency of any one result hardly matters.</p>
        <p><a href="#/c/multicore/0">Chapter ${numOf('multicore')}</a> got parallelism by copying whole cores. The other way is to keep <strong>one instruction stream</strong> and copy only the datapath: one
        fetch, one decode, one control unit, and N <strong>lanes</strong>, each with its own registers and ALU. Give each lane a way to sit out an instruction
        and the programmer can write an ordinary scalar program per element, a <em>thread</em>; the N threads stepping together form a <em>warp</em>. NVIDIA
        calls this SIMT (single instruction, multiple threads). Its warps are 32 threads, issued over 16 or 32 lanes depending on the unit (one instruction
        then takes two cycles or one); AMD's wavefronts are 32 or 64 threads. Ours has 4 threads on 4 lanes.</p>
        <p>Why sharing the instruction stream pays: fetching, decoding and controlling an instruction costs the same gates whether one datapath uses the result
        or sixteen do, so the more identical work there is, the less each result carries of that overhead. It stops paying when the threads need different
        instructions, and the rest of this track is about what that costs and how real GPUs keep the lanes busy anyway.</p>`,
      more: {
        derive: `<p>Let F be the NANDs of the shared front end (PC, fetch, decode, control, next-PC logic) and D one datapath (registers, ALU, result multiplexer).
          N cores cost N·(F + D); one lane core with N lanes costs F + N·D. The saving is (N − 1)·F: it grows with N, but as a fraction of the
          N·(F + D) it replaces it can never exceed F / (F + D). Lanes are a good deal only where the front end is large beside the datapath, which is true of
          wide out-of-order cores and false of the small in-order core used here. The datapath, mostly registers, is paid in full either way.</p>`,
        pitfall: `<p>"More lanes, more speed" only holds while every lane has work. A lane core runs one instruction per cycle for the whole warp, so its throughput is
          the number of <em>active</em> lanes per cycle, and the memory port and divergent branches (the next chapters) cut that number, not the lane count.
          Count results per cycle on the circuit, not lanes on the diagram.</p>`,
        real: `<p>NVIDIA's streaming multiprocessors hold four partitions of this kind, each issuing one warp instruction a cycle to 16 or 32 lanes of FP32 units;
          AMD's compute units issue a wavefront to SIMD units 16 lanes wide, a 64-thread wavefront over four cycles on older parts. The names differ, the bargain is this
          chapter's: one front end per many datapaths.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Which of these does a lane core have only once, however many lanes it has?',
        options: ['The register file', 'The ALU', 'The program counter', 'The result multiplexer'], answer: 2,
        explain: 'One PC per warp is what makes this a lane core: every lane runs the instruction it points to. Registers, ALU and the result mux are per lane, because each thread computes its own values. (NVIDIA since Volta keeps a PC per thread, so a warp\'s threads can drift apart, but it still issues one instruction at a time to the threads that share a PC.)',
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
        i = tid, tid + 4, tid + 8, tid + 12 of y = 3·x + y. <code>nlanes</code> reads 4, <code>lane</code> the lane number, <code>tmask</code> one enable bit per lane.</p>
        <p>The Warp panel runs an instruction-set simulator of the SIMT machine (a reference model in software) in lock-step and compares the PC, the mask and every lane's registers after each instruction. Click a line of its listing to light the hardware that instruction
        uses; <strong>Slow</strong> runs the kernel at a pace you set (a gate delay, a cycle or an instruction at a time), the highlight following each
        instruction onto the lanes it runs on.</p>
        <p>The cost shows in what is not drawn: one ROM, one decoder, one immediate generator and one next-PC adder serve all four lanes, so their gates and their
        delay are paid once. What grows with the lane count is the register files (31 × 32 flip-flops each, plus a read multiplexer pair), the ALUs and the wiring that
        carries the shared control signals to every lane.</p>
        <div class="try">Run to halt, then open a lane and its register file: four different sets of values from one instruction stream.</div>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['lane0', 'lane1', 'lane2', 'lane3'] }),
      tour: {
        beats: [
          { title: 'One instruction', reset: true, show: ['pc', 'imem', 'ctl'], expect: { pcOut: 0, maskOut: 15 },
            say: '<p>Power on: the PC is {v:pcOut}, the lane enables {b:maskOut} (all four lanes on). The first word, <code>csrr t0, tid</code>, goes to the control unit once.</p>' },
          { title: 'Four times the work', cycles: 1, show: ['lane0', 'lane1', 'lane2', 'lane3'], expect: { pcOut: 4 },
            say: '<p>One edge: <code>csrr t0, tid</code> has run in all four lanes at once, each reading its own constant (0, 1, 2, 3) into t0. The PC moved to {v:pcOut}, a single PC for the four threads.</p>' },
          { title: 'Same fields, own values', cycles: 3, show: ['lane0', 'lane1', 'lane2', 'lane3'], expect: { pcOut: 16, maskOut: 15 },
            say: '<p>Three instructions later the PC is {v:pcOut}: <code>nlanes</code>, <code>li</code> and <code>mv</code> have run. Every lane received the same rs1, rs2, rd and control; only the register contents differ. Open a lane and its register file to see t3 hold 0, 1, 2 or 3.</p>' },
          { title: 'Own addresses', cycles: 2, show: ['lane0', 'lane1', 'lane2', 'lane3'], expect: { pcOut: 24 },
            say: '<p>Now <code>slli</code> and <code>addi</code> have computed each lane\'s own byte address and element: PC {v:pcOut}, next the first store, where the four addresses go to a memory with one port.</p>' },
        ],
      },
      more: {
        derive: `<p>Per lane the datapath is the single-cycle CPU's: two register reads, SrcA / SrcB multiplexers, an ALU, a result multiplexer, a register write. The only
          new inputs are three: the lane enables (a write enable per lane), the lane's constant for <code>csrr tid</code>, and a way to hand its operands to the memory
          sequencer. Everything else arrives over wires that fan out to all ${SAXPY.lanes} lanes, so the front end is saved ${SAXPY.lanes - 1} times
          over and the register files, the bulk of a lane, are not saved at all.</p>`,
        pitfall: `<p>The register file is not shared: x5 in lane 0 and x5 in lane 1 are different flip-flops that the same instruction names. Reading "register t3" off a
          single lane's file tells you nothing about the others. Open each lane and compare: the kernel gives them different values from the same code.</p>`,
      },
    },
    {
      title: 'The leader',
      body: `
        <p>Here one PC means one branch decision per instruction. The lanes all compute the comparison, but only one is listened to: the <strong>leader</strong>, the
        lowest active lane. A <span data-show="lead">lowest-set-bit circuit</span> turns the lane enables into a one-hot word, and one-hot multiplexers (an AND per bit and an OR tree: no decoder,
        the select is already one-hot) bring the <span data-show="lF">leader's ALU flags</span> to the <span data-show="npc">next-PC logic</span> and its
        <span data-show="lAlu">ALU result</span> to the <span data-show="clr0">jalr target</span>.</p>
        <p>In saxpy the branch agrees in every lane: each lane does exactly four elements, so <code>blt t3, t2, loop</code> is taken or not taken by all of them at
        once. When lanes disagree, the leader's choice is wrong for the others; <a href="#/c/simt/0">chapter ${numOf('simt')}</a> fixes that.</p>
        <p>Why the lowest lane and not a vote: the choice must be a pure function of the mask, cheap in gates and the same on every run. A fixed order is one
        priority chain; a majority would need a population count and a tie-break, and would still leave the minority lanes wrong. The leader also supplies the
        address a <code>jalr</code> jumps to and the operands of the mask instructions of <a href="#/c/simt/0">chapter ${numOf('simt')}</a>, so everything the single PC needs from the lanes goes through
        the same one-hot multiplexers.</p>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['lead', 'lF', 'lAlu', 'npc'] }),
      tour: {
        beats: [
          { title: 'Four comparisons', reset: true, show: ['lead', 'lF', 'npc'], expect: { pcOut: 0, maskOut: 15 },
            say: '<p>Mask {b:maskOut}: lane 0 is the lowest active lane, so it is the leader. Only its flags will reach the next-PC logic.</p>' },
          { title: 'Reach the branch', cycles: 17, show: ['lead', 'lF', 'npc'], expect: { pcOut: 44, maskOut: 15 },
            say: '<p>After 17 cycles (two stores cost four cycles each) the PC is {v:pcOut}: <code>blt t3, t2, init</code>. All four lanes have compared their t3 with 16; the leader\'s result is the one listened to.</p>' },
          { title: 'Taken', cycles: 1, show: ['lead', 'lF', 'npc', 'pc'], expect: { pcOut: 16 },
            say: '<p>The branch was taken: the PC is back at {v:pcOut}, the top of the init loop. The other three lanes agreed with the leader here, so nothing was lost. Had they disagreed, they would have followed it all the same.</p>' },
        ],
      },
      more: {
        derive: `<p>The leader's one-hot word L = (L0 … L${SAXPY.lanes - 1}) comes from the mask m by isolating its lowest set bit: L = m &amp; (−m) in two's complement, built from a
          priority chain of ${SAXPY.lanes} stages. The flag multiplexer is then an AND of each lane's flag with its Li and an OR of the ${SAXPY.lanes} results: exactly one term is nonzero, so no
          decoder and no tie-breaking is needed. For an N-lane core the cost is O(N) gates per flag bit and O(N) delay in the chain, which is why wide machines build the leader
          select as a tree.</p>`,
        pitfall: `<p>On this core a branch is never checked for agreement: the next PC follows the leader and the hardware does not notice that lane 2 wanted the other way.
          It looks right on a uniform loop and goes quietly wrong on a data-dependent one. The next chapter's <em>When lanes disagree</em> step shows the wrong values it produces.</p>`,
      },
    },
    {
      title: 'One memory port',
      body: `
        <p>Four lanes produce four addresses per load, and the <span data-show="dm">data memory</span> has one port. The
        <span data-show="mseq"><strong>memory sequencer</strong></span> serves the lowest active lane not yet served, one per cycle (one-hot multiplexers pick its
        <span data-show="mAd mWd">address and store data</span>), writing the loaded word into that lane's registers only, and holds the PC until none is left. A load or store therefore takes as
        many cycles as there are active lanes.</p>
        <p>saxpy runs 74 instructions in 134 cycles: 20 of them are loads or stores at 4 cycles each (80 cycles), the other 54 take one.</p>
        <p>The port is the cheapest design that works, not a good one: it needs one address multiplexer and one data multiplexer of ${SAXPY.lanes} inputs, where a port per lane
        would need ${SAXPY.lanes} address decoders and ${SAXPY.lanes} read multiplexers in the memory itself. The price is paid in cycles, and it is paid by every lane,
        including the ones already served: the PC waits for the slowest.</p>`,
      scene: () => laneCoreScene('saxpy', { highlight: ['mseq', 'mAd', 'mWd'] }),
      tour: {
        beats: [
          { title: 'Before the store', reset: true, show: ['mseq', 'dm'], expect: { pcOut: 0, maskOut: 15 },
            say: '<p>The first <code>sw</code> of the init loop is at address 24. Each lane will present its own address, x[i] at 4·i.</p>' },
          { title: 'Lane 0 first', cycles: 6, show: ['mseq', 'mAd', 'mWd', 'dm'], expect: { pcOut: 24, retire: 0 },
            say: '<p>The PC is {v:pcOut} and <code>retire</code> is {v:retire}: the instruction is not done. The sequencer has picked the lowest active lane and sends its address and data to the one port. The PC is held.</p>' },
          { title: 'Last lane', cycles: 3, show: ['mseq', 'mAd', 'mWd'], expect: { pcOut: 24, retire: 1 },
            say: '<p>Three cycles later the fourth lane is being served: <code>retire</code> is {v:retire} again, the PC still {v:pcOut}. Four cycles for one instruction.</p>' },
          { title: 'On', cycles: 1, show: ['pc', 'mseq'], expect: { pcOut: 28, retire: 1 },
            say: `<p>The PC finally moves to {v:pcOut}. A ${SAXPY.lanes}-lane warp paid one cycle per lane for a store that takes one cycle on a single-cycle core.</p>` },
        ],
      },
      more: {
        derive: `<p>With ${SAXPY.instrs} instructions of which ${SAXPY.mem} touch memory, and one cycle per active lane for those, the run takes
          (${SAXPY.instrs} − ${SAXPY.mem}) + ${SAXPY.mem} × ${SAXPY.lanes} = ${SAXPY_CYCLES} cycles: a CPI of ${(SAXPY_CYCLES / SAXPY.instrs).toFixed(2)} for the warp, and
          ${(SAXPY.instrs * SAXPY.lanes / SAXPY_CYCLES).toFixed(2)} lane-instructions per cycle against the ${SAXPY.lanes} the ALUs could do. The memory share is
          ${pct(SAXPY.mem * SAXPY.lanes, SAXPY_CYCLES)} of the cycles for ${pct(SAXPY.mem, SAXPY.instrs)} of the instructions.</p>`,
        pitfall: `<p>A masked-off lane is skipped, not served: with lanes 0, 1 and 3 active a store takes 3 cycles, not 4. The cost scales with the active lanes, which is the
          opposite of a uniform branch, where it is constant. Watch <code>retire</code> in the Warp panel: it stays low until the cycle that serves the last lane, so one cycle fewer than there are lanes served.</p>`,
        real: `<p>A real memory system takes a whole warp's addresses at once and merges those on one cache line into one access (coalescing, chapter ${numOf('feed')}), so a store of 32 neighbouring
          words costs one or a few accesses, not 32. One lane per cycle is the worst case, kept here as the thing to beat.</p>`,
      },
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
        <p>The same work on <a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>'s cores, four of them, each finding its index with <code>csrr mhartid</code>, against the lane core. Both bars are counted
        from the actual designs, and both cycle counts come from the instruction-set simulators, which the gate-level circuits match cycle for cycle.</p>
        <p>The lanes save the front end three times over, yet only 18 % of the gates, and most of that is program ROM: four cores read four copies of the
        program, the lanes one, and 24 192 of the 32 670 NANDs saved are those three ROMs. Leave the ROMs out of both and the lanes save 6 %: a lane is mostly
        its register file (23 141 of its 27 584 NANDs, flip-flops and multiplexers), and the PC, decoder and control they share are small beside it. And they are slower on saxpy, because a load or store stops all four lanes, while a core that waits for the memory port lets
        the other three compute. Real GPUs answer both: memory as wide as a warp, with a <strong>coalescer</strong> merging neighbouring addresses into one access
        (<a href="#/c/feed/0">chapter ${numOf('feed')}</a>), and many warps so that one waiting does not idle the lanes (<a href="#/c/warps/0">chapter ${numOf('warps')}</a>). Their register files are SRAM, and the cores they compete with have
        large front ends (out-of-order logic, predictors, caches), so the sharing pays far more than it does here.</p>`,
      widget: lanesVsCoresWidget,
      more: {
        derive: `<p>The comparison has two parts, and they pull in different directions. <em>Area</em>: the lane core saves the front end (N − 1) times, so with a large shared
          ROM the saving is mostly the ROM copies; without them it is the small front end beside a register-file-dominated lane. <em>Time</em>: on the cores a hart that waits on the
          memory arbiter lets the others compute, while on the lane core one lane waiting stops all of them, so the lane core's cycle count is ${SAXPY_CYCLES} where an ideal ${SAXPY.lanes}-wide
          machine would take ${SAXPY.instrs} (cycles per warp instruction ${(SAXPY_CYCLES / SAXPY.instrs).toFixed(2)}). Gates saved against cycles lost: here 18 % of the gates buys a slower run on saxpy, which is why
          the chapters that follow widen the memory and add threads instead of adding lanes to the datapath.</p>`,
        pitfall: `<p>Do not read the gate saving as a measure of the idea. Here the 18 % is mostly three ROMs; the front end that real lane designs save is orders of magnitude larger
          (out-of-order scheduling, branch predictors, caches), and their registers are SRAM, not flip-flops with multiplexers. The sign of the comparison is the same, its size is not.</p>`,
        real: `<p>A GPU's streaming multiprocessor is the same trade made at scale: thousands of lanes behind a few dozen streaming multiprocessors, with register files among the largest blocks of each streaming multiprocessor. That is also why its programs are written in thousands of threads: the lanes only pay when they are kept busy.</p>`,
      },
    },
  ],
};

export const chSimt: Chapter = {
  id: 'simt', num: numOf('simt'), title: 'Threads in lock-step', level: 'Throughput',
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
      'Without help, a divergent branch on this core follows the leader, and the other lanes compute the wrong side.',
      '<code>split</code> runs the lanes with rs1 ≠ 0 first and pushes one entry: the mask before, the waiting lanes, the resume PC, a pending bit. The first <code>join</code> switches to the waiting lanes and jumps back; the second restores the mask and pops.',
      'The stack is a shift register of four entries: four levels of nesting. <code>pred</code> turns lanes off without an entry, for loops whose length differs per lane.',
      'Divergence runs both sides, each with part of the lanes: 58 % of the lane-steps did work with the nested ifs. Lanes switched off on purpose cost the same: 45 % in the tmc kernel, where lane 0 adds alone.',
      'Here the programmer writes split and join. On real GPUs the compiler places the reconvergence point (the branch\'s immediate post-dominator): a per-warp stack before Volta, per-thread convergence tracking with a PC per thread since, and on AMD an EXEC mask kept by scalar instructions.',
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
        <p>In <a href="#/c/lanes/0">chapter ${numOf('lanes')}</a> every lane ran every instruction, and a branch went wherever the leader said. That is right as long as the four
        threads agree. Real kernels disagree: an <code>if</code> on each thread's own data, a loop whose count depends on the element. This chapter gives a lane a
        way to sit out instructions that are not its own, then builds the bookkeeping that brings the lanes back together after a divergent branch, and counts
        what the idle lanes cost.</p>
        <p>Each lane has one bit in the <span data-show="simt"><strong>active mask</strong></span>. A lane whose bit is 0 still sees every instruction, but its
        <span data-show="weg">register write enable</span> is off and the <span data-show="mseq">memory sequencer</span> skips it. The mask register stores the
        mask inverted, so at power-on, with every flip-flop at 0, all lanes are active.</p>
        <p><code>tmc rs1</code> (thread mask control) loads the mask from the <span data-show="lA">leader's rs1</span>. Here every lane stores a value, then <code>tmc</code> with 1 leaves lane 0
        alone to add them up, and <code>tmc</code> with −1 brings the others back. While lane 0 works alone the other three idle: 45 % of the lane-steps do work in
        this kernel.</p>
        <p>Why the mask is a register of its own and not a property of the instruction: a lane that is off must still see the stream, because it has to be able to rejoin
        at the next <code>tmc</code>, <code>join</code> or <code>pred</code> with its registers and PC context intact. Switching a lane off therefore touches exactly two things,
        its register write enable and its request to the memory sequencer; nothing is gated at the ALU, whose result is simply discarded. The cost of a mask is
        one flip-flop and an AND per lane, and the price of using it is paid in lane-steps that do no work.</p>`,
      scene: () => laneCoreScene('tmc'),
      tour: {
        beats: [
          { title: 'All lanes on', reset: true, show: ['simt', 'weg'], expect: { pcOut: 0, maskOut: 15 },
            say: '<p>Mask {b:maskOut}: all four lanes active. The register stores the mask inverted, so the all-zero power-on state means this, with no reset logic.</p>' },
          { title: 'Everyone stores', cycles: 4, show: ['mseq', 'weg'], expect: { pcOut: 16, maskOut: 15, retire: 0 },
            say: '<p>The PC is {v:pcOut}: <code>sw t1, 0(t3)</code>, each lane storing lane + 5, one lane per cycle through the single port. <code>retire</code> is {v:retire} until the last.</p>' },
          { title: 'Only lane 0', cycles: 6, show: ['simt', 'lA'], expect: { pcOut: 28, maskOut: 1 },
            say: '<p><code>tmc t4</code> with t4 = 1 has run: the mask is {b:maskOut}. Lanes 1 to 3 still see every instruction but write nothing and are skipped by the memory sequencer.</p>' },
          { title: 'Lane 0 adds up', cycles: 22, show: ['simt'], expect: { pcOut: 68, maskOut: 15 },
            say: '<p>Lane 0 looped over the four values alone (the PC went round the <code>sum</code> loop four times), stored the total, and <code>tmc</code> with −1 brought the others back: the mask is {b:maskOut}, the PC {v:pcOut}.</p>' },
        ],
      },
      more: {
        derive: `<p>Utilization is useful lane-steps over lane-steps issued. In the <code>sum</code> loop the warp issues one instruction per cycle with a single lane active, so a
          ${SAXPY.lanes}-lane core runs it at 1 / ${SAXPY.lanes} = ${pct(1, SAXPY.lanes)} utilization; of the whole kernel 45 % of lane-steps do work. In general an active count a over N lanes gives a / N, and a
          loop that runs on a single lane costs the same cycles as on a one-lane core while holding all N lanes' hardware.</p>`,
        pitfall: `<p><code>tmc</code> reads the leader's rs1, not a vote: every lane has its own t4, but only the lowest active lane's value sets the mask. A kernel that computes a
          different mask in each lane gets lane 0's. Put the mask in a register that all lanes agree on, or compute it from <code>tmask</code>, which every lane reads alike.</p>`,
        real: `<p>NVIDIA hardware has the same switch under other names: the active mask of a warp, <code>__activemask()</code>, and predicated execution. AMD's EXEC register is exactly this mask, set by
          scalar instructions, 32 or 64 bits wide.</p>`,
      },
    },
    {
      title: 'When lanes disagree',
      body: `
        <p>Odd lanes should compute 3·lane, even lanes lane / 2. Written as a plain <code>if</code>, the lanes disagree at <code>beqz</code>: lanes 0 and 2 want to
        branch, lanes 1 and 3 do not. One PC cannot go both ways, so the warp follows its <span data-show="lead">leader</span> (lane 0) to the even path, and the
        odd lanes compute the even result. The instruction-set simulator counts the divergent branch; the hardware simply follows the leader.</p>
        <p>This is the failure the rest of the chapter exists to prevent, and it is silent: no flag is raised, no lane stops, the program finishes and stores four values, three of
        them plausible. A divergent branch needs the hardware to run <em>both</em> sides, one after the other, each with the lanes that want it, and to put the warp back together
        afterwards. That takes a mask (already here), a place to remember the lanes that are waiting and where to resume (a stack), and two instructions to drive them.</p>`,
      scene: () => laneCoreScene('nosplit'),
      tour: {
        beats: [
          { title: 'The test', reset: true, show: ['lead', 'npc'], expect: { pcOut: 0, maskOut: 15 },
            say: '<p>Lanes 0 to 3 will compute lane &amp; 1: 0, 1, 0, 1. <code>beqz</code> at address 8 wants to branch for the even lanes only.</p>' },
          { title: 'Disagreement', cycles: 2, show: ['lead', 'lF', 'npc'], expect: { pcOut: 8, maskOut: 15 },
            say: '<p>The PC is {v:pcOut}, at the branch, the mask still {b:maskOut}. Lanes 0 and 2 would take it; lanes 1 and 3 would not.</p>' },
          { title: 'Follow the leader', cycles: 1, show: ['lead', 'lF', 'npc', 'pc'], expect: { pcOut: 24, maskOut: 15 },
            say: '<p>The PC jumped to {v:pcOut}, the even path (<code>srli</code>), because lane 0, the leader, wanted it. The mask is unchanged ({b:maskOut}): lanes 1 and 3 are active and will run the even code on odd data.</p>' },
        ],
      },
      more: {
        pitfall: `<p>The bug does not show in the PC trace or the mask: both look like a normal run. It shows only in the stored values (lane 3 stores 1, not 9). When a SIMT
          program gives right answers on some lanes and wrong ones on others, suspect a branch on per-lane data with no split, and compare the lane that disagrees with the leader.</p>`,
        derive: `<p>With the leader deciding, lane l executes the path that lane 0's condition chose, so its result is that path's formula applied to its own l: the even path is
          l &gt;&gt; 1, giving ${[0, 1, 2, 3].map((l) => l >> 1).join(', ')} for lanes 0 to 3, where the intended odd lanes should hold 3·l = ${[1, 3].map((l) => 3 * l).join(' and ')}. Two of four lanes are wrong because their
          condition differed from the leader's.</p>`,
      },
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
      tour: {
        beats: [
          { title: 'All lanes agree so far', reset: true, show: ['simt', 'pm'], expect: { pcOut: 0, maskOut: 15 },
            say: '<p>Mask {b:maskOut}. Each lane is about to compute t1 = lane &amp; 1: 0, 1, 0, 1.</p>' },
          { title: 'split', cycles: 3, show: ['simt', 'pm'], expect: { pcOut: 12, maskOut: 10 },
            say: '<p><code>split t1</code> has run. The lanes with t1 ≠ 0 go first: the mask is {b:maskOut} (lanes 1 and 3), the PC {v:pcOut}. One stack entry was pushed: the old mask 1111, the waiting lanes 0 and 2, the resume PC and a pending bit.</p>' },
          { title: 'Odd lanes finish', cycles: 4, show: ['simt', 'jmux'], expect: { pcOut: 32, maskOut: 10 },
            say: '<p>The odd lanes ran their side (3·lane) and jumped over the even code to the <code>join</code> at {v:pcOut}. The mask is still {b:maskOut}.</p>' },
          { title: 'First join: even lanes', cycles: 1, show: ['simt', 'jmux'], expect: { pcOut: 12, maskOut: 5 },
            say: '<p>The entry was pending, so the first <code>join</code> made the waiting lanes the mask ({b:maskOut}: lanes 0 and 2) and sent the PC back to {v:pcOut}, just after the split. Their <code>beqz</code> now goes the other way.</p>' },
          { title: 'Second join: all four', cycles: 3, show: ['simt'], expect: { pcOut: 36, maskOut: 15 },
            say: '<p>The even lanes ran lane / 2 and reached the <code>join</code> again. Now nothing is pending: the original mask comes back ({b:maskOut}), the entry is popped, and the warp goes on together at {v:pcOut}.</p>' },
        ],
      },
      more: {
        derive: `<p>The stack entry is the minimum that lets <code>join</code> finish the job with no other state: the mask to restore (N bits), the else-lanes to run next (N bits), the PC
          to resume at (32 bits, or fewer with an aligned program), a pending bit and a valid bit (a join on an empty stack does nothing). For ${SAXPY.lanes} lanes that is 2·${SAXPY.lanes} + 32 + 2 = ${stackEntryWidth(SAXPY.lanes)} flip-flops an entry, and with four entries the stack is ${4 * stackEntryWidth(SAXPY.lanes)} flip-flops of
          mask logic that no lane ever sees. The cost of one if / else is the then-path plus the else-path plus the two joins: every instruction on both sides is issued once, each with part of the lanes.</p>`,
        real: `<p>Here split and join are instructions the programmer writes. On real GPUs the compiler places them: the warp reconverges at the branch's
          <em>immediate post-dominator</em>, the first instruction every path from the branch must pass through (the end of the if, the exit of the loop).</p>
          <p>NVIDIA before Volta did it much as here: <code>SSY</code> pushed the reconvergence address onto a per-warp stack in hardware, the divergent branch
          pushed the side not taken, and a <code>SYNC</code> at the post-dominator popped back to the waiting threads, then to the full mask. Since Volta
          (2017) every thread has its own PC: <code>BSSY</code> / <code>BSYNC</code> name a convergence barrier, the scheduler runs one group of threads with
          a common PC at a time and may switch between them, so a thread spinning on a lock held by another thread of its warp no longer deadlocks
          (on this core, or on a stack machine, it does); <code>__syncwarp()</code> makes reconvergence explicit where the program relies on it.</p>
          <p>AMD keeps no stack at all: a 32- or 64-bit <code>EXEC</code> mask decides which lanes write, and the compiler saves, narrows and restores it with
          scalar instructions (<code>s_and_saveexec_b64</code> before the then-side, an XOR for the else-side, the saved mask back at the end), skipping a
          side whose mask is empty with <code>s_cbranch_execz</code>. Predication with a software stack, in other words: nesting depth is limited only by the
          scalar registers the compiler spends on it.</p>`,
        pitfall: `<p>Forgetting the <code>join</code>, or placing it where only some paths reach it, leaves the entry on the stack and the mask wrong for everything after.
          The symptom is lanes that silently stop writing. Watch the stack in the panel: after the second join of an if it must be empty again.</p>`,
      },
    },
    {
      title: 'An if inside an if',
      body: `
        <p>Each split pushes one entry, so nested ifs nest on the stack. The <span data-show="simt">stack</span> is a shift register of four entries (the top is
        entry 0): a push shifts everything down, a pop shifts it up. Four entries allow four levels of nesting; a fifth split would lose the bottom entry, and the
        instruction-set simulator stops with a stack overflow instead.</p>
        <p>The lanes split twice here: odd and even, then within the odd lanes on bit 1. Each path runs with only the lanes that took it, so only 58 % of the
        lane-steps do work.</p>
        <p>The order is a depth-first walk of the if tree: finish the inner if completely (both sides, two joins, one pop) before the outer join switches to the
        outer else. That is a stack discipline, so a stack is what the hardware keeps. The entries need no names: the innermost split is always the one the next join belongs to, and
        a join that reaches an entry with nothing pending pops it.</p>`,
      scene: () => laneCoreScene('nested'),
      tour: {
        beats: [
          { title: 'Outer split', reset: true, show: ['simt'], cycles: 4, expect: { pcOut: 16, maskOut: 10 },
            say: '<p>The outer <code>split t1</code> sent the odd lanes first: mask {b:maskOut}, PC {v:pcOut}. One entry on the stack: mask 1111, waiting lanes 0 and 2.</p>' },
          { title: 'Inner split', cycles: 3, show: ['simt', 'pm'], expect: { pcOut: 28, maskOut: 8 },
            say: '<p>Within the odd lanes a second <code>split t2</code> separated lane 3 (bit 1 set) from lane 1. Mask {b:maskOut}: lane 3 runs first. Two entries are now on the stack.</p>' },
          { title: 'Inner else', cycles: 4, show: ['simt', 'jmux'], expect: { pcOut: 28, maskOut: 2 },
            say: '<p>The inner join switched to lane 1, mask {b:maskOut}, and sent the PC back to {v:pcOut} to run the other side of the inner if.</p>' },
          { title: 'Inner done', cycles: 3, show: ['simt'], expect: { pcOut: 48, maskOut: 10 },
            say: '<p>The second inner join popped that entry: the mask is {b:maskOut} again, the odd lanes together, at {v:pcOut}, with the outer entry still waiting.</p>' },
          { title: 'Outer else', cycles: 2, show: ['simt', 'jmux'], expect: { pcOut: 16, maskOut: 5 },
            say: '<p>The outer join switched to the even lanes: mask {b:maskOut}, back at {v:pcOut} for the outer else-branch.</p>' },
          { title: 'Together again', cycles: 3, show: ['simt'], expect: { pcOut: 60, maskOut: 15 },
            say: '<p>The second outer join restored the full mask {b:maskOut}. The stack is empty.</p>' },
        ],
      },
      more: {
        derive: `<p>Lane-step utilization by hand: the warp issues, per path, as many instructions as the path has, and counts the lanes active on them. The inner else and
          inner then each run on one lane of four, the outer else on two, the shared head and tail on all four. The simulator's total over the kernel is 58 %: the head and tail run at 100 %,
          each nested side at 25 %, the outer else at 50 %. Deeper nesting multiplies the fractions: a lane that is inside k ifs of equal weights is active for about 1 / 2<sup>k</sup> of the paths.</p>`,
        pitfall: `<p>A fifth split loses the oldest entry (the stack is a shift register of four) and the outermost join then has nothing to restore. The instruction-set simulator
          stops with an overflow so you find out; the hardware just goes wrong. Count the nesting before trusting a kernel on this core.</p>`,
      },
    },
    {
      title: 'Loops of different lengths',
      body: `
        <p>Lane l adds up l + 1, l, …, 1, so the lanes need 1 to 4 iterations. <code>pred t1, s0</code> turns off the lanes whose
        <span data-show="pm">t1 reached 0</span>, without a stack entry (predication); when no lane would remain, it loads the
        <span data-show="simt">mask</span> from the <span data-show="lB">leader's s0</span> instead, saved at the start with <code>csrr s0, tmask</code>. The loop's
        branch is uniform because only lanes still counting are active, and after the last iteration all four lanes come back for the store.</p>
        <p>Compare with <code>split</code>: a split makes two groups and remembers one to run later, so it costs a stack entry and a second pass over the code. A loop of
        different lengths has no second group to run: the lanes that finish simply wait for the rest, and the mask only ever shrinks until the last lane is done. Predication
        is that special case, with a cost of nothing but a register to remember the full mask (here s0) and the idle lane-steps.</p>`,
      scene: () => laneCoreScene('pred'),
      tour: {
        beats: [
          { title: 'First pass', reset: true, show: ['simt', 'pm'], cycles: 7, expect: { pcOut: 28, maskOut: 14 },
            say: '<p>One iteration done: every lane added its t1 and decremented it. Lane 0 started at 1, so its t1 is now 0 and <code>pred</code> switched it off: mask {b:maskOut}. The branch at {v:pcOut} is uniform among the remaining lanes.</p>' },
          { title: 'Second pass', cycles: 4, show: ['simt', 'pm'], expect: { pcOut: 28, maskOut: 12 },
            say: '<p>Lane 1 finished: mask {b:maskOut}. Lanes 2 and 3 still count; lane 0 and 1 keep their sums, because their write enables are off.</p>' },
          { title: 'Third pass', cycles: 4, show: ['simt'], expect: { pcOut: 28, maskOut: 8 },
            say: '<p>Only lane 3 is left: mask {b:maskOut}. The loop runs a fourth time for it alone.</p>' },
          { title: 'Everyone back', cycles: 4, show: ['simt', 'lB'], expect: { pcOut: 28, maskOut: 15 },
            say: '<p>Lane 3 reached 0 too, and no lane would remain, so <code>pred</code> loaded the mask from the leader\'s s0 instead: {b:maskOut}. The branch falls through next.</p>' },
        ],
      },
      more: {
        derive: `<p>The loop runs max(l + 1) = ${SAXPY.lanes} iterations. Lane l is active in its first l + 1 of them, so the lane-steps that do work are 1 + 2 + 3 + 4 = ${[1, 2, 3, 4].reduce((a, b) => a + b)}
          out of ${SAXPY.lanes} × ${SAXPY.lanes} = ${SAXPY.lanes * SAXPY.lanes} issued: ${pct(10, SAXPY.lanes * SAXPY.lanes)} utilization in the loop, the triangle-number shape that the lanes' different trip counts always make. Doubling the
          imbalance (trip counts 1 and 100 in two lanes) leaves a lane idle for 99 of 100 passes.</p>`,
        pitfall: `<p>Do not use <code>pred</code> where the lanes have to reconverge and run different code afterwards: it only shrinks the mask, there is no waiting group to switch to. The
          saved s0 is what brings everyone back, and a loop that forgets <code>csrr s0, tmask</code> at the start leaves the final mask undefined.</p>`,
      },
    },
    {
      title: 'What divergence costs',
      body: `
        <p>A divergent if runs both sides, each with part of the lanes: the warp pays for the then-path plus the else-path, every lane idle during the side it did
        not take. Lane utilization, the fraction of lane-steps that do work, measures it. With 32 lanes and one thread taking a long path, 31 lanes wait through it,
        which is why GPU programmers keep branches uniform across a warp, arrange data so that neighbouring threads agree, or compute both sides and select.</p>
        <p>The loss is a property of the code and the data, not the hardware: the same if / else on a warp whose threads all take one side costs nothing extra, because a
        side no lane takes is skipped (the split sees an empty group). Two things change the number: how many lanes are in each group, and how long each side is. The cost
        is worst when the rare path is the long one.</p>`,
      widget: divergenceWidget,
      more: {
        derive: `<p>Let a warp of N lanes run an if / else whose sides have t and e instructions, with k lanes taking the then-side. The warp issues t + e instructions in all (if k is 0 or N
          one side is skipped), and the useful lane-steps are k·t + (N − k)·e, so utilization is (k·t + (N − k)·e) / (N·(t + e)). With N = ${SAXPY.lanes}, t = e = 10 and k = 3 that is
          (30 + 10) / 80 = ${pct(40, 80)}, the quiz's answer; with k = 1 it is also ${pct(1 * 10 + 3 * 10, 80)}: at equal side lengths every split gives one half, whatever k is. What hurts more is one long side taken by one
          lane (k = 1, t = 100, e = 1 gives ${pct(1 * 100 + 3 * 1, 4 * 101)}).</p>`,
        pitfall: `<p>Utilization says how much of the machine did work, not how long the code takes. A warp with 100 % utilization on a short path still waits for a divergent neighbour
          warp's memory accesses to finish; and "compute both sides and select" always costs t + e, so it only wins when the sides are short or the lanes nearly always disagree.</p>`,
        real: `<p>Compilers turn short ifs into predicated code (both sides issued, results selected per lane) and keep the branch only for long sides; a warp that finds all its
          lanes on one side skips the other. Sorting or binning work so that neighbouring threads share a branch outcome is a standard optimisation for this reason.</p>`,
      },
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
  id: 'warps', num: numOf('warps'), title: 'Hiding latency', level: 'Throughput',
  blurb: 'A memory that answers 8 cycles later: a scoreboard, several warps resident, a scheduler picking a ready one each cycle, and what each warp costs.',
  goals: [
    'say why a GPU hides the memory latency its caches leave with more warps, and what the caches are for',
    'follow a load through the scoreboard: which instruction waits, and until which cycle',
    'say what a warp slot holds and what all warps share',
    'judge when another resident warp stops paying, from empty issue slots and its gate cost',
  ],
  builds: ['simt', 'multicore'],
  recap: {
    keep: [
      'Here memory answers 8 cycles later: a load issued in cycle t is written back at the end of t + 7, and its first use can issue in t + 8. One warp runs saxpy over 64 elements in 266 cycles, 42 % of its issue slots empty.',
      'A scoreboard, one pending bit per register, stops a warp only at the first instruction that reads a pending register or writes one.',
      'A warp slot holds a PC, a mask and stack, a running bit and a scoreboard; each lane holds a register bank per warp. The program, the decoder, the ALUs and the memory are shared; each warp reads the program through a port of its own, which in gates is a copy of the ROM.',
      'A round-robin scheduler issues one ready warp a cycle. Four warps: 172 instructions in 172 cycles, the latency hidden; two warps 192 cycles, one 266.',
      'The second warp costs 110 715 NANDs, 92 564 of them registers. A real GPU fixes the register file, and the registers a thread needs decide how many warps fit: the occupancy.',
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
        explain: 'Only state is copied, plus what reads it: 110 715 NANDs, of which 92 564 are the new register banks.',
        why: ['', 'The decoder, the ALUs and the memory are shared; only one warp issues per cycle.', 'Each thread\'s registers must survive while the other warp runs: the register banks are most of the cost.', 'One warp issues per cycle, so the lanes\' ALUs are shared by all warps.'],
      },
      {
        question: 'A GPU has 65 536 registers per streaming multiprocessor. A kernel needs 64 registers per thread. How many threads fit?',
        options: ['1024', '2048', '512', '65 536'],
        answer: 0,
        explain: '65 536 / 64 = 1024 threads, 32 warps of 32: half the 2048 that fit at 32 registers a thread.',
        why: ['', 'That is at 32 registers a thread.', 'That would be 128 registers a thread.', 'That counts registers, not threads.'],
      },
    ],
  },
  steps: [
    {
      title: 'A memory that makes you wait',
      body: `
        <p>Until now the data memory answered in the cycle it was asked. Real memory does not: a DRAM access takes on the order of 100 ns, hundreds of cycles, and a
        CPU hides most of that with caches, because one thread keeps reusing a little data. GPUs have caches too (an H100's L2 is 50 MB), and kernels that reuse
        data, matrix multiply above all, are written to hit them; but there they mostly save DRAM bandwidth, and every miss that remains still costs hundreds of
        cycles, for thousands of threads at once. A GPU hides that latency instead: while one warp waits, another issues.</p>
        <p>Here the <span data-show="mem">memory</span> sits behind a <strong>pipeline of 8 cycles</strong>: a load or store enters with its warp, destination register, active lanes,
        addresses and data, and reaches the memory 7 pipeline registers later. A load issued in cycle t is written back at the end of cycle t + 7, so an
        instruction that needs it can issue in cycle t + 8. One request enters every cycle: the memory is slow, not busy. (Each lane still has a port of its own
        into the memory; <a href="#/c/feed/0">chapter ${numOf('feed')}</a> replaces them with one port and a coalescer.)</p>
        <p>One warp runs saxpy over 64 elements already in memory: 154 instructions in 266 cycles. 112 issue slots, 42 %, pass with nothing to issue.</p>
        <div class="try">Run to halt and read the issue timeline: after each pair of <code>lw</code>s, the warp sits striped (a load in flight) and the idle row fills.</div>`,
      scene: () => warpCoreScene('saxpy64', { warps: 1, highlight: ['mem'] }),
      tries: [halted],
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['warp0', 'mem'], expect: { pcOut: 0, retire: 1 },
            say: `<p>One warp, four lanes, a memory that answers ${WARP1.latency} cycles after it is asked. The PC is {v:pcOut}; <code>retire</code> is {v:retire}: an instruction issues this cycle.</p>` },
          { title: 'Two loads', cycles: 10, show: ['mem'], expect: { pcOut: 40, retire: 1 },
            say: '<p>Ten instructions in, the PC is {v:pcOut}: the first <code>lw</code> of the loop (x[i]) issues now. The next cycle the second one (y[i]) goes right behind it.</p>' },
          { title: 'Waiting', cycles: 2, show: ['mem'], expect: { pcOut: 48, retire: 0 },
            say: '<p>Both loads are in flight. The PC stops at {v:pcOut}, <code>slli a0, t5, 1</code>, the first use of x[i], and <code>retire</code> falls to {v:retire}: nothing can issue, and with one warp there is nothing else to run.</p>' },
          { title: 'Still waiting', cycles: 6, show: ['mem'], expect: { pcOut: 48, retire: 0 },
            say: '<p>Eight cycles in, x[i] has landed, but y[i] is being written back this cycle and the warp sits out so as not to share the write port of its bank: PC {v:pcOut}, retire {v:retire}.</p>' },
          { title: 'Back', cycles: 1, show: ['mem'], expect: { pcOut: 48, retire: 1 },
            say: '<p>The word has been written back and the instruction issues (<code>retire</code> {v:retire}). Seven slots went empty for one load pair.</p>' },
        ],
      },
      more: {
        derive: `<p>With load latency L = ${WARP1.latency} and two independent loads issued in consecutive cycles, the first use waits L − 1 = ${WARP1.latency - 1} cycles after the second load. Over the 64 elements (16 trips of
          the loop per warp, 4 lanes each) the one warp issues ${WARP1.instrs} instructions in ${WARP1.cycles} cycles: ${WARP1.cycles - WARP1.instrs} empty slots, ${pct(WARP1.cycles - WARP1.instrs, WARP1.cycles)} of the total. A warp that cannot issue wastes a whole warp-wide
          ALU row each cycle, and the figure that matters for a GPU is that number, not the latency itself.</p>`,
        pitfall: `<p>Do not read the stall as the memory being busy. One request enters the pipeline every cycle, so the memory could have taken a load from a second warp in each of these empty
          cycles. The problem is that nobody has one to give it, which is what the next steps change.</p>`,
        real: `<p>A DRAM access is hundreds of cycles, so a real GPU does not hide 8: it hides a few hundred, with tens of warps per scheduler. The cache hierarchy is there to shorten the common
          case; the warps are there for the rest.</p>`,
      },
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
      tour: {
        beats: [
          { title: 'Nothing pending', reset: true, show: ['warp0', 'hz0'], expect: { pcOut: 0, retire: 1 },
            say: '<p>The scoreboard is empty: no register is waiting for a load, so the check passes for every instruction.</p>' },
          { title: 'The loads issue', cycles: 12, show: ['warp0', 'hz0'], expect: { pcOut: 48, retire: 0 },
            say: '<p>Both loads went through the check (their rs1 is ready, their rd is not pending) and set the pending bits of t5 and a1. The next instruction, at {v:pcOut}, reads t5: the check fails and <code>retire</code> is {v:retire}.</p>' },
          { title: 'Until the word lands', cycles: 6, show: ['warp0', 'hz0'], expect: { pcOut: 48, retire: 0 },
            say: '<p>Six more cycles. the bit of t5 cleared a cycle ago and the check on slli now passes, but the word of a1 is being written back, and a warp sits out that cycle.</p>' },
          { title: 'Cleared', cycles: 1, show: ['warp0', 'hz0'], expect: { pcOut: 48, retire: 1 },
            say: '<p>Both words are in; nothing holds the warp, and the instruction issues. The warp waited only for the registers it needed, not for the load instructions themselves.</p>' },
        ],
      },
      more: {
        derive: `<p>The check is a few gates: the instruction's registers form a mask (rs1 and rs2 if the opcode reads them, rd if it writes one); AND it with the 32-bit pending word
          and OR the result. Per warp that is a 32-bit AND, a reduction and the decode of which of the three fields are used. The pending word is 32 flip-flops with a set port
          (a load issues) and a clear port (its word is written back), so a scoreboard costs about the same as one register. It stalls a load pair by ${WARP1.latency} − 1 = ${WARP1.latency - 1} cycles at most,
          and by nothing when independent work lies in between.</p>`,
        pitfall: `<p>The check includes rd, not just the sources. A second load into a register that an earlier load is still filling is the case: one pending bit cannot count two. The first word's return would clear it, and a reader would issue with the older value. With mixed latencies (the next chapter) the older word could even land last and overwrite the newer one
          (a write-after-write hazard). The usual mistake is to leave rd out because "a load only writes". Compile saxpy with both loads into the same register and the stall appears.</p>`,
        real: `<p>Here only loads are slow: the ALU answers in the cycle, so a pending bit per register on loads is all the scoreboard needs. In a real GPU the ALUs are
          pipelined too (about 4 cycles from one FP32 instruction to a dependent one on recent NVIDIA parts, more for the special-function unit), and other warps hide
          that latency just as they hide memory's.</p>
          <p>Nor is it all done by a hardware scoreboard. Since Maxwell (2014), NVIDIA's compiler writes control bits beside each instruction: for fixed-latency operations
          a <em>stall count</em>, the cycles to wait before the warp's next instruction; for variable-latency ones (memory, special functions) one of six
          dependency barriers per warp, which the instruction sets and a later one waits on. AMD's compiler inserts <code>s_waitcnt</code>, waiting until the
          counter of outstanding memory operations falls far enough. And a streaming multiprocessor (SM) is four partitions, each with its own warp scheduler issuing one warp a cycle from
          its own pool: four of this chapter's scheduler side by side.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'lw t5, 0(t4) issues in cycle 10 with 8-cycle loads, and lw a1, 256(t4) follows it. If add a0, a0, a1 came right after the second load, in which cycle could it issue at the earliest?',
        options: ['Cycle 11', 'Cycle 18', 'Cycle 19', 'Cycle 26'], answer: 2,
        explain: 'The second load issues in cycle 11 (it does not depend on the first), so a1 is written back at the end of cycle 18 and an instruction reading it can issue in cycle 19. Waiting for each load in turn would push it to cycle 26. (In saxpy the slli and the add on x[i] come first, so that add issues in cycle 21.)',
        why: ['Cycle 11 is when the second load issues; its word is still 7 cycles away.', 'a1 is written back at the end of cycle 18, so an instruction reading it issues one cycle later.', '', 'That waits for each load in turn; the second load does not depend on the first, so both are in flight at once.'],
      },
    },
    {
      title: 'Many warps resident',
      body: `
        <p>While one warp waits, another could issue, if the core holds several. Each <span data-show="warp0 warp1 warp2 warp3"><strong>warp slot</strong></span>
        keeps one warp's PC, its active mask and split / join stack, a running bit and its scoreboard; <span data-show="lane0 lane1 lane2 lane3">each lane</span>
        keeps one register bank per warp, and the <span data-show="wid">warp number</span> picks the bank. The program, the
        <span data-show="ctl sdec">decoder</span>, the ALUs and the <span data-show="mem">memory</span> are shared. The program's contents are shared, not its
        read port: every warp's scoreboard check needs that warp's next instruction in every cycle, so each slot reads the program through a
        <span data-show="im0 im1 im2 im3">port of its own</span>, and a read port in gates is a whole ROM, a copy of the same words. A real GPU keeps one instruction
        cache and a small buffer of next instructions per warp.</p>
        <p>Warp 0 runs from reset and starts the others: <span data-show="spGo"><code>wspawn t0, t1</code></span> starts warps 1 to t0 − 1 at the address in t1, every lane active. A thread
        learns who it is with <code>csrr t0, tid</code>, now warp · 4 + lane, and how many threads there are from <code>nwarps</code>: thread tid takes
        elements tid, tid + 16, tid + 32 and tid + 48.</p>
        <p>A returning load writes its word into its own warp's bank, through the bank's one write port. That warp sits out the cycle, so the issuing warp
        and the load never write the same bank at once.</p>`,
      scene: () => warpCoreScene('saxpy64', { warps: 4, highlight: ['warp0', 'warp1', 'warp2', 'warp3'] }),
      tour: {
        beats: [
          { title: 'Warp 0 alone', reset: true, show: ['warp0'], cycles: 4, expect: { pcOut: 16, warpOut: 0 },
            say: '<p>Warp 0 has run its first four instructions, the last of them <code>wspawn t0, t1</code>, and the PC is {v:pcOut}. The other three slots were started at that address with every lane on.</p>' },
          { title: 'Warp 1 follows', cycles: 1, show: ['warp0', 'warp1'], expect: { pcOut: 16, warpOut: 1 },
            say: '<p>The next cycle issues from warp {v:warpOut} at the same address: the shared decoder and ALUs now serve warp 1, whose PC, mask and registers are its own.</p>' },
          { title: 'Warps 2 and 3', cycles: 2, show: ['warp2', 'warp3'], expect: { pcOut: 16, warpOut: 3 },
            say: '<p>Two cycles later warp {v:warpOut} issues. Each warp was started by the same instruction and is at the same PC, but each has its own register bank.</p>' },
          { title: 'Around again', cycles: 1, show: ['warp0', 'wid'], expect: { pcOut: 20, warpOut: 0 },
            say: '<p>Back to warp 0, one instruction further: PC {v:pcOut}. Four warps, one issue slot a cycle, each warp advancing once every four cycles.</p>' },
        ],
      },
      more: {
        derive: `<p>State per warp slot: a PC (32 flip-flops), the active mask (${SAXPY.lanes}), a split / join stack (4 entries of 2·${SAXPY.lanes} + 34 = ${stackEntryWidth(SAXPY.lanes)} bits), a running bit and a 32-bit scoreboard. Per lane per
          warp: 31 × 32 register bits and the multiplexer that the warp number steers. The slot is a few hundred flip-flops; the register banks are 31 × 32 × ${SAXPY.lanes} = ${fmt(31 * 32 * SAXPY.lanes)} bits per warp,
          so the cost of a warp is dominated by its registers by more than an order of magnitude.</p>`,
        pitfall: `<p>A warp does not own an ALU. The picture of four warps as four little cores is wrong: one ALU row, one decoder, one memory, and a scheduler that hands them to a
          different warp every cycle. Performance per warp falls as warps are added unless the latency being hidden makes them wait anyway.</p>`,
      },
    },
    {
      title: 'Picking a ready warp',
      body: `
        <p>A warp is <span data-show="rdy0 rdy1 rdy2 rdy3"><strong>ready</strong></span> when it runs, its next instruction passes the
        <span data-show="hz0 hz1 hz2 hz3">scoreboard check</span>, and none of its loads is being written back. The
        <span data-show="sched"><strong>scheduler</strong></span> is <a href="#/c/multicore/0">chapter ${numOf('multicore')}</a>'s round-robin arbiter over the ready warps: the first at or after its pointer issues, and when two or more were
        ready, the pointer moves past the winner. One warp issues per cycle; its PC, mask and stack move, the others' stay.</p>
        <p>Four warps run the same 64 elements in 172 cycles for 172 instructions: not one issue slot is empty, and the 8-cycle latency is hidden entirely. Two
        warps take 192 cycles (83 % of the slots), one warp 266.</p>
        <div class="try">Switch between 1, 2 and 4 warps in the panel and compare the timelines: the colours interleave, and the idle row empties. Then press
        <strong>Slow</strong> at the issue level: each step is one issue, and the highlight follows the warp the scheduler picked through the shared front end.</div>`,
      scene: () => warpCoreScene('saxpy64', { warps: 4, highlight: ['sched'] }),
      tour: {
        beats: [
          { title: 'Ready warps', reset: true, show: ['rdy0', 'rdy1', 'rdy2', 'rdy3', 'sched'], cycles: 8, expect: { pcOut: 20, warpOut: 0, retire: 1 },
            say: '<p>All four warps run the same code and none has a load in flight yet, so all four are ready every cycle. Warp {v:warpOut} issues at PC {v:pcOut}.</p>' },
          { title: 'Round robin', cycles: 1, show: ['rdy1', 'sched'], expect: { pcOut: 20, warpOut: 1, retire: 1 },
            say: '<p>The arbiter moved its pointer past the winner: warp {v:warpOut} issues next, at the same PC. One instruction a cycle, from a different warp each time.</p>' },
          { title: 'No empty slot', cycles: 7, show: ['sched'], expect: { pcOut: 28, warpOut: 0, retire: 1 },
            say: '<p>Two more rounds later, every cycle issued (<code>retire</code> stayed {v:retire}) and warp {v:warpOut} is at PC {v:pcOut}. This is the point of the scheduler: the cycles a single warp would spend waiting are now taken by the others.</p>' },
        ],
      },
      more: {
        derive: `<p>One trip of saxpy's loop is 9 instructions, and a lone warp stalls ${WARP1.latency - 1} cycles in it, so it issues in 9 of 9 + ${WARP1.latency - 1} = ${9 + WARP1.latency - 1} cycles: ${pct(9, 9 + WARP1.latency - 1)} of the slots. n warps
          can fill at most n × ${pct(9, 9 + WARP1.latency - 1)} of them, which on paper is full from two warps (${2 * 9} of ${9 + WARP1.latency - 1} slots a round). Measured, two warps reach 83 % and four are needed, because the warps run
          the same code a cycle apart and reach their stalls together: the idle cycles of one are the idle cycles of the others.</p>`,
        pitfall: `<p>"Ready" is not "has work": a warp that is not running (done, or not yet spawned) never wins, and a warp whose load is being written back sits out the cycle so that
          the issue and the write do not share a bank's port. Count the ready bits in the panel before blaming the scheduler for an empty slot.</p>`,
        real: `<p>Real schedulers also weigh age and fairness (greedy-then-oldest is common) and can dual-issue; the arbiter here is the same round-robin as chapter ${numOf('multicore')}'s, which
          is enough to show the effect and cheap enough to draw.</p>`,
      },
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
        <p>A warp is cheap to switch to but not cheap to keep. The second warp adds 110 715 NANDs to the core: its registers, 31 × 32 bits in each of 4 lanes
        (92 564), its read port into the program, a copy of the ROM (8064), its slot of PC, mask, stack and scoreboard (6203), its scoreboard check (736),
        the wspawn compare that starts it, and wider multiplexers. Each resident warp buys issue slots only while some are still empty: past that, it only adds gates.</p>
        <p>A real GPU turns the question around. Its register file is fixed (65 536 32-bit registers per streaming multiprocessor on recent NVIDIA parts), and a
        kernel's register count decides how many threads fit: at 32 registers a thread, 2048 threads (64 warps of 32, the most an A100 or H100 SM holds; an
        RTX 30 or 40 SM stops at 1536); at 64 registers, half as many. Shared memory per block and the block size limit it too: whichever runs out first
        decides. The resident warps as a fraction of the maximum are the <strong>occupancy</strong>. Fewer registers per thread, more warps, more latency hidden;
        too few registers, and the compiler spills to slow memory instead.</p>
        <p>The widget sweeps the warps and the load latency with the timing model, which the tests check against the gate-level core cycle for cycle.</p>`,
      widget: occupancyWidget,
      more: {
        derive: `<p>Occupancy from the register file: threads per SM = R / r, with R registers and r per thread; warps = threads / 32, capped by the architectural limit (64 warps, or ${fmt(2048)} threads).
          At R = 65 536: r = 32 gives ${fmt(65536 / 32)} threads (the cap), r = 64 gives ${fmt(65536 / 64)}, r = 128 gives ${fmt(65536 / 128)}, r = 255 (the most a thread may use) gives ${fmt(Math.floor(65536 / 255))}.
          Occupancy is that over ${fmt(2048)}: ${pct(65536 / 64, 2048)} at 64 registers, ${pct(65536 / 128, 2048)} at 128. Latency hiding needs enough warps, so the compiler's register allocation is a throughput decision.</p>`,
        pitfall: `<p>Higher occupancy is not always faster. Once the issue slots are full more warps add nothing (this chapter's table), and a kernel that spills registers to memory to raise occupancy
          trades slots for slow loads. The right measure is issue slots used, not warps resident.</p>`,
        real: `<p>Vendors publish occupancy calculators for exactly this: registers per thread, shared memory per block and block size in, resident warps out. Memory-bound kernels benefit most from high occupancy;
          kernels with long independent instruction sequences (instruction-level parallelism) need fewer warps.</p>`,
      },
    },
  ],
};

export const chFeed: Chapter = {
  id: 'feed', num: numOf('feed'), title: 'Feeding the lanes', level: 'Throughput',
  blurb: 'One memory port a line wide: coalescing, a banked shared memory and bank conflicts, a barrier, atomics; a reduction, a histogram and a tiled matrix multiply.',
  goals: [
    'count the accesses a warp\'s load takes on a line-wide port, from its lanes\' addresses',
    'find bank conflicts in a banked shared memory, and remove one by padding',
    'say when a barrier is needed, why this core serves amoadd.w one lane per access, and what real GPUs serialize instead',
    'judge when tiling a matrix multiply pays, from memory bandwidth against extra instructions',
  ],
  builds: ['warps', 'cache'],
  recap: {
    keep: [
      'One port a 16-byte line wide replaces a port per lane: 77 829 NANDs instead of 183 964 for 128 words. The access unit serves the leader\'s line and every lane on it; each other line costs another access.',
      'Coalescing is a data-layout question: the same 76-instruction kernel takes 124 cycles by rows (68 accesses) and 76 by columns (20).',
      'Shared memory: 64 words in four banks (word w in bank w mod 4), loads in 2 cycles instead of 8. Different words in one bank conflict, one word read by several lanes is broadcast, and padding a 4-word row to 5 spreads a column over the banks.',
      '<code>bar rs1, rs2</code> holds each warp until rs2 warps have arrived: a waiting bit per warp and a population count. <code>amoadd.w</code> reads, adds and writes in one access; this core serves it one lane per access (one adder at the memory), so lanes on one word all count. Real GPUs run atomics in units at the L2 slices and shared-memory banks: lanes on different words proceed together, only lanes on one word take turns.',
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
        <p><a href="#/c/warps/0">Chapter ${numOf('warps')}</a>'s memory gave every lane a read and a write port of its own: four address decoders and four 128-way multiplexers of 32 bits, 183 964 NANDs for
        128 words. No real memory is built that way. A DRAM moves a <em>burst</em> of neighbouring bytes per access, and a cache a whole line; here the memory reads
        and writes a <strong>16-byte line</strong>, four words side by side, through one port: 77 829 NANDs for the same 128 words.</p>
        <p>Four lanes now share that port. The <strong>access unit</strong> decides which of them one access serves: the lowest lane still to serve leads, and every
        lane whose address bits 31 … 4 match the leader's (the same line) goes along. The others wait for the next access. A memory instruction holds the issue
        port for one cycle per access, and its warp moves on only after the last: <a href="#/c/lanes/0">chapter ${numOf('lanes')}</a>'s sequencer, looping over lines instead of lanes. Each access's words
        go back to the lanes it served; the scoreboard clears with the last.</p>
        <p>The widget evaluates the gate-level access unit (5870 NANDs) on four addresses, then again on the lanes it left, until none is left.</p>
        <p>Why a line and not a word: DRAM, caches and buses all move their data in blocks because the cost of an access is mostly the address, the decode and the wait, not the
        wires that carry the bytes. Making the port wide spends cheap wires to save expensive accesses, but only for lanes whose addresses fall in the same block. That condition, not
        the width, is what the rest of the chapter is about.</p>
        <div class="try">Try stride 1 with offsets 0 and 1, then stride 3: when does a misaligned access cost a second cycle?</div>`,
      widget: () => accessWidget('global'),
      more: {
        derive: `<p>A line of ${SAXPY.lanes} words (16 bytes) means address bits 1 … 0 pick the byte, bits 3 … 2 the word in the line, bits 31 … 4 the line. For lane addresses a<sub>0</sub> … a<sub>${SAXPY.lanes - 1}</sub>
          the access count is the number of distinct values of a &gt;&gt; 4, at most ${SAXPY.lanes}; the unit serves the leader's line first. Stride s words from word w<sub>0</sub>: the lanes touch words
          w<sub>0</sub> … w<sub>0</sub> + ${SAXPY.lanes - 1}·s, which fit in one line only when s = 1 and w<sub>0</sub> mod ${SAXPY.lanes} = 0, and cross a line boundary otherwise (s = 1 at offset 1: two accesses).
          With stride ${SAXPY.lanes} or more every lane has a line of its own: ${SAXPY.lanes} accesses, no better than serving one lane at a time.</p>`,
        pitfall: `<p>Alignment, not distance, decides it. Words 6, 7, 8, 9 are four neighbours and still take two accesses, because the line boundary falls between 7 and 8. The usual
          fix is to align arrays to the line size and let each warp start on a multiple of it.</p>`,
        real: `<p>NVIDIA's L1 serves a warp's load as a few 32-byte sector requests; AMD merges a wavefront's addresses within a cache line in its texture / vector memory path. Both reward
          the same layout: consecutive threads, consecutive words, base address a multiple of the line.</p>`,
      },
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
      tour: {
        beats: [
          { title: 'Before the loads', reset: true, show: ['acc', 'mem'], expect: { pcOut: 0, served: 0 },
            say: '<p>Four warps of four lanes. In the by-rows layout, lane l of each warp will load word 4·(its thread) + j: addresses 16 bytes apart.</p>' },
          { title: 'First access', cycles: 28, show: ['acc', 'mem'], expect: { pcOut: 40, warpOut: 0, served: 1, retire: 0 },
            say: '<p>Warp {v:warpOut} reaches the first load at PC {v:pcOut}. The access unit serves only lane 0 (served = {b:served}): the other lanes\' addresses are in other lines. The instruction is not done (<code>retire</code> {v:retire}).</p>' },
          { title: 'Second access', cycles: 1, show: ['acc'], expect: { served: 2, retire: 0 },
            say: '<p>Next cycle the leader is lane 1 (served = {b:served}, lane 1 alone): a line each.</p>' },
          { title: 'Four accesses', cycles: 2, show: ['acc'], expect: { served: 8, retire: 1 },
            say: '<p>Lane 3 is served in the fourth access (served = {b:served}) and <code>retire</code> is {v:retire}: the load held the issue port for four cycles. With the columns layout the same load is one access.</p>' },
          { title: 'Next warp', cycles: 1, show: ['sched'], expect: { warpOut: 1, served: 1, pcOut: 40 },
            say: '<p>Warp {v:warpOut} issues its load at the same PC and pays four accesses of its own.</p>' },
        ],
      },
      more: {
        derive: `<p>Count the accesses: by rows, each load of a warp touches ${SAXPY.lanes} lines (addresses 4g, 4g + 4, … 16 bytes apart), so ${SAXPY.lanes} accesses per load; by columns the ${SAXPY.lanes} lanes read
          neighbouring words of one line, so 1. Each of 16 threads adds four values: ${SAXPY.lanes} warps × ${SAXPY.lanes} loads. By rows that is ${SAXPY.lanes} × ${SAXPY.lanes} × ${SAXPY.lanes} = ${SAXPY.lanes ** 3} load accesses, by columns
          ${SAXPY.lanes} × ${SAXPY.lanes} = ${SAXPY.lanes ** 2}; the store of the sum adds one access a warp (${SAXPY.lanes}) either way: ${SAXPY.lanes ** 3 + SAXPY.lanes} against ${SAXPY.lanes ** 2 + SAXPY.lanes} accesses (68 and 20 measured).
          The cycle difference, 124 − 76 = ${124 - 76}, equals the extra accesses, ${68 - 20}: each one holds the issue port a cycle.</p>`,
        pitfall: `<p>The trap is writing the kernel the way the data is shaped in your head: thread g owns elements 4g … 4g + 3, which is natural and uncoalesced. Making thread g own elements g, g + 16, g + 32 …
          is the same arithmetic with a different index, and costs nothing in instructions. Check the layout with the access counter before optimising anything else.</p>`,
        real: `<p>Here a line is 16 bytes, one word per lane of a 4-lane warp. NVIDIA's L1 and L2 keep 128-byte lines, one 4-byte word for each of a warp's 32
          threads, but move them in four 32-byte <em>sectors</em>: a warp's load costs one transaction per sector it touches, not per line. Thirty-two
          consecutive words, aligned, are 4 sectors; shifted by one word, 5; a stride of two words, 8 sectors for the same 128 useful bytes; scattered words, up
          to 32 sectors that each bring 32 bytes for 4 used. DRAM bursts are the same size again (a GDDR6 channel or an HBM2 pseudo-channel moves
          32 bytes a burst, the sector's size; a 64-bit DDR4 channel 64), so layout matters at every level down to the DRAM.</p>`,
      },
    },
    {
      title: 'Banks',
      body: `
        <p>Next to the lanes sits a <strong>shared memory</strong>: 64 words at address 0x1000 (bit 12 of an address picks it), a scratchpad the threads read and
        write explicitly. It is on the chip, close to the lanes: an access enters the memory pipeline one register before the end, so a load takes 2 cycles instead
        of 8. Only one access reaches the memories per cycle, so a shared access waits a cycle when a global one issued 6 cycles earlier would arrive with it.</p>
        <p>It is built from four <strong>banks</strong>: word w lives in bank w mod 4, row w / 4, and each bank has its own row decoder (38 928 NANDs, 300 more than
        a line memory of the same size). One access then serves any four words in different banks, not just one line. Lanes asking for the same word share it (a
        broadcast). Two different words in one bank are a <strong>bank conflict</strong>: per bank the lowest lane picks the row, and a lane wanting another row
        waits for the next access.</p>
        <p>A column of a 4-wide array (stride 4) puts all four lanes in one bank: four accesses. Padding each row to 5 words spreads the column over the four
        banks.</p>
        <p>Banks trade flexibility for cost the other way from a line: a line memory needs the lanes' words to be neighbours, a banked memory needs only that no two lanes want
        different rows of one bank. The mapping w mod 4 is chosen because the common access patterns (consecutive words, or a fixed odd stride) spread evenly over it.</p>`,
      widget: () => accessWidget('shared'),
      more: {
        derive: `<p>Word w sits in bank w mod B and row ⌊w / B⌋, with B = ${SAXPY.lanes} banks. Lanes at stride s words, lane i at word w<sub>0</sub> + i·s, are in banks (w<sub>0</sub> + i·s) mod ${SAXPY.lanes}. These are all
          different exactly when s is coprime to ${SAXPY.lanes}, that is odd: s = 1 and s = 3 give a conflict-free access, s = 2 gives ${SAXPY.lanes / 2}-way conflicts (banks 0 and 2 each hit twice),
          s = ${SAXPY.lanes} gives ${SAXPY.lanes}-way. Padding a row from ${SAXPY.lanes} to ${SAXPY.lanes + 1} words turns a column's stride from ${SAXPY.lanes} to ${SAXPY.lanes + 1}, which is coprime to ${SAXPY.lanes}.
          The same holds for any B: a power-of-two bank count conflicts on every even stride, which is why a prime or a padded stride is the usual cure.</p>`,
        pitfall: `<p>Broadcast is easy to mistake for a conflict and the reverse. Four lanes reading the <em>same</em> word is one access; four lanes reading four words of the <em>same bank</em> is four.
          The tell is the number of distinct rows within a bank, not the number of lanes aimed at it.</p>`,
        real: `<p>NVIDIA's shared memory has 32 banks of 4-byte words, the width of a warp, and the same rule: lanes in distinct banks, or on one word, proceed together. The padding trick (an array
          declared <code>[N][N + 1]</code>) is standard in transpose and tiled matrix-multiply kernels.</p>`,
      },
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
      tour: {
        beats: [
          { title: 'No one waits', reset: true, show: ['atBar', 'sched'], expect: { atBar: 0, pcOut: 0 },
            say: '<p>The waiting bits are all 0: every warp is a candidate for the scheduler. The first phase is each thread summing its four words and writing the partial sum to shared memory.</p>' },
          { title: 'Warp 0 arrives', cycles: 74, show: ['atBar', 'rdy0'], expect: { atBar: 1 },
            say: '<p>Warp 0 has issued <code>bar</code> and its waiting bit is set (atBar = {b:atBar}). It is no longer ready: the scheduler hands the cycles to the others, which are still adding.</p>' },
          { title: 'Warp 1 too', cycles: 4, show: ['atBar', 'rdy0', 'rdy1'], expect: { atBar: 3 },
            say: '<p>Warp 1 has arrived too: atBar = {b:atBar}, warps 0 and 1 waiting. Each <code>bar</code> counts the waiting bits, adds itself, and compares with rs2 (4 warps); two is not four, and warp 2 is about to issue its own.</p>' },
          { title: 'The last warp', cycles: 1, show: ['barCmp', 'atBar'], expect: { atBar: 7, warpOut: 3, pcOut: 88 },
            say: '<p>Warp {v:warpOut} issues its <code>bar</code> at PC {v:pcOut}: three bits set (atBar = {b:atBar}) plus itself is four, the number rs2 asked for.</p>' },
          { title: 'Released', cycles: 1, show: ['atBar', 'sched'], expect: { atBar: 0, pcOut: 92 },
            say: '<p>The bits clear in the same edge (atBar = {b:atBar}) and all four warps are ready again, the next instruction at PC {v:pcOut}. Every partial sum is now in shared memory before anyone reads it.</p>' },
        ],
      },
      more: {
        derive: `<p>The arrival test is a population count of the ${SAXPY.lanes} waiting bits plus one, compared with rs2: for ${SAXPY.lanes} warps, an adder of four bits and a comparator, a few dozen NANDs. If equal, the clear
          is enough (every waiting bit goes to 0 and the arriving warp does not set its own). The reduction itself has log<sub>2</sub> 16 = ${Math.log2(16)} levels, each halving the number of busy threads: 8, 4, 2 and 1 threads add, and at the last
          level 15 of 16 threads wait. The barrier cost is the time the slowest warp needs to arrive, not the barrier's gates.</p>`,
        pitfall: `<p>A barrier inside a branch only some warps reach hangs the kernel: the warps that took the other path never arrive, and rs2 is never met. Put <code>bar</code> where every warp
          runs it, and use one barrier id: this core has one, so warps must agree on rs1 as well.</p>`,
        real: `<p>CUDA's <code>__syncthreads()</code> is this instruction for a thread block (many warps); <code>__syncwarp()</code> synchronizes the threads of one warp. A GPU keeps a barrier per resident block in a small
          hardware table, and a block can use several named barriers.</p>`,
      },
    },
    {
      title: 'Atomics',
      body: `
        <p>A histogram: 64 values from 0 to 15, one count per value. Each thread adds 1 to the bin of each of its values, and two threads (even two lanes of one warp)
        may hit the same bin at once. With <code>lw</code>, <code>addi</code>, <code>sw</code> they would all read the same count, add one, and store: four
        lanes on one bin count once.</p>
        <p><code>amoadd.w rd, rs2, (rs1)</code> reads the word at rs1, writes it back plus rs2 and returns the old value, all in one memory access, so nothing
        comes in between. This core serves it <strong>one lane per access</strong>, lowest first: the <span data-show="acc">access unit</span> sends the
        leader alone, and one adder at the <span data-show="mem">memory</span> (a 32-bit Kogge–Stone, 878 NANDs) makes the new word. Lanes on one bin then all
        count, one after the other; lanes on different bins wait too, which is the price of one adder instead of four.</p>
        <p>Real GPUs serialize less. Atomics run in units beside each L2 slice (global memory) and each shared-memory bank, so lanes on different words are served
        in parallel like any coalesced access, and only lanes on the same word take turns; and the compiler can fold a warp's adds to one word into a single atomic
        (warp-aggregated atomics). A histogram with few bins is therefore still slow on a GPU, and one with many bins is not.</p>
        <p>16 loads and 64 atomic adds: 80 accesses, 48 cycles holding the port, 197 cycles. The <span data-show="xdec">decoder</span> hands amoadd.w to the
        <span data-show="ctl">control unit</span> disguised as <code>lw</code> (it reads memory and writes rd) and <span data-show="immA">zeroes its
        immediate</span>: the address is rs1.</p>`,
      scene: () => warpCoreScene('hist', { warps: 4, highlight: ['acc', 'xdec'] }),
      tour: {
        beats: [
          { title: 'Start', reset: true, show: ['acc', 'mem'], expect: { pcOut: 0, served: 0 },
            say: '<p>Four warps will each count their values into a 16-bin histogram in memory. The core is running; nothing has touched the bins yet.</p>' },
          { title: 'First atomic', cycles: 45, show: ['acc', 'xdec', 'mem'], expect: { pcOut: 56, warpOut: 0, served: 1, retire: 0 },
            say: '<p>Warp {v:warpOut} reaches <code>amoadd.w</code> at PC {v:pcOut}. The access unit serves one lane: served = {b:served}, lane 0 alone, whatever the other lanes\' addresses are.</p>' },
          { title: 'Lane by lane', cycles: 2, show: ['acc', 'mem'], expect: { served: 4, retire: 0 },
            say: '<p>Two cycles later it is lane 2 (served = {b:served}). Each access reads the bin, adds the lane\'s value and writes it back before the next lane starts.</p>' },
          { title: 'Last lane', cycles: 1, show: ['acc', 'mem'], expect: { served: 8, retire: 1 },
            say: '<p>The fourth lane is served and <code>retire</code> is {v:retire}: four accesses for one instruction, every lane counted exactly once even where two lanes shared a bin.</p>' },
        ],
      },
      more: {
        derive: `<p>With a plain load / add / store, two lanes on one bin both read the old count c and both store c + 1: one update is lost. With the atomic, the memory performs
          c → c + v for each lane in turn, so n lanes on one bin give c + n. The price is serialization: ${SAXPY.lanes} accesses for one warp instruction, where the racy <code>lw</code>, <code>addi</code>, <code>sw</code> is three
          instructions that may take fewer accesses and counts wrongly. A real unit serves distinct words in parallel and
          serializes only duplicates, so a warp with all lanes on different bins costs one access, on one bin ${SAXPY.lanes}.</p>`,
        pitfall: `<p>An atomic fixes the update, not the order: the old value each lane gets back depends on which lane went first, so two runs with different schedules can return different
          intermediate values while the final histogram is identical. Never use the returned value as an index into data that must be deterministic.</p>`,
        real: `<p>On a GPU the same operation is <code>atomicAdd</code>. Warp-aggregated atomics let one lane add the warp's total for a word, and shared-memory histograms (private per block, merged at the end)
          avoid contention on the global bins. With 16 bins and 32 lanes, contention is the whole cost.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Lanes 0–3 of one warp run amoadd.w on bins 3, 3, 7, 3. How many accesses does it take, and what does bin 3 gain?',
        options: ['2 accesses, +3', '4 accesses, +3', '4 accesses, +1', '1 access, +3'], answer: 1,
        explain: 'This core serves amoadd.w one lane per access, so four accesses whatever the addresses (a real GPU would take lane 2\'s bin 7 alongside the others and serialize only the three on bin 3); the three lanes on bin 3 each add 1. A plain load / add / store would leave bin 3 one higher, not three.',
        why: ['That would be coalescing by line; on this core amoadd.w is never coalesced: the access unit sends the leader alone.', '', 'Each access reads, adds and writes back with nothing in between, so all three lanes on bin 3 count: that is what an atomic is for.', 'On this core an amoadd.w access serves one lane, never four.'],
      },
    },
    {
      title: 'Tiles',
      body: `
        <p>A matrix multiply, C = A · B with A 8 × 4 and B 4 × 8, needs a multiplier in each lane: a Wallace tree keeping the low 32 bits of the product
        (<code>mul</code>, 7388 NANDs a lane). The plain kernel computes C[i][j] from row i of A and column j of B straight from global memory: 8 loads per
        element, each one access (a warp's four threads share a row of A, one word for all, and read neighbouring columns of B).</p>
        <p>The tiled kernel uses shared memory as a staging area. Each thread copies one element of a 4 × 4 tile of A and one of B into shared memory,
        <code>bar</code>, computes its element of C from the tiles (a row of the A tile is one word for the whole warp, a column of the B tile spans the four
        banks), <code>bar</code>, next tile. Each tile element is loaded from global memory once and used by four threads: 40 global accesses instead of 144.</p>
        <p>It also runs 560 instructions instead of 396, and here that decides it. This memory takes a line every cycle, so a global access costs the issue port
        no more than a shared one, and four warps hide the 8-cycle latency: the plain kernel wins, 396 cycles to 592. Tiling trades instructions for memory traffic,
        which pays only when the memory is the bottleneck: in the chart, from one line every three cycles.</p>
        <p>On a real GPU it is, and kernels that reuse data (matrix multiply above all) are written in tiles for exactly this reason.</p>`,
      widget: tilingWidget,
      more: {
        derive: `<p>For C = A · B with A 8 × 4 and B 4 × 8, each of 64 elements needs 4 products, so 64 × 4 = ${64 * 4} multiplies either way. Plain: 8 loads an element (4 of A, 4 of B). The four threads of a warp share a row of A and read neighbouring columns of B,
          so a warp's load is one access: 8 loads × ${64 / SAXPY.lanes} warp-elements = ${8 * (64 / SAXPY.lanes)}, plus ${64 / SAXPY.lanes} stores of C, ${8 * (64 / SAXPY.lanes) + 64 / SAXPY.lanes} accesses. Tiled: each tile element is loaded once and used by four threads, 40 global accesses, at the cost of
          the stores to shared memory, the two barriers per tile and the extra index arithmetic, which is why 560 instructions replace 396. Tiling wins when
          (accesses saved) × (cycles each costs) &gt; (instructions added): here ${144 - 40} × (the cost of an access) against ${560 - 396}, and an access costs about one cycle, so it loses.</p>`,
        pitfall: `<p>Counting only memory traffic overstates the win. A tile pays in instructions, barriers and shared-memory bank conflicts too; measure the whole kernel, not the number of global accesses.</p>`,
        real: `<p>An H100 SXM moves 3.35 TB/s from its HBM3 to 132 SMs (streaming multiprocessors) at up to 1.98 GHz: under 13 bytes per SM per cycle, against 128 bytes
          per cycle from each SM's shared memory. Scaled to this core, whose shared memory moves 16 bytes a cycle, that is a line every ten cycles, past the right
          edge of the chart. Caches narrow the gap.</p>`,
      },
    },
  ],
};
