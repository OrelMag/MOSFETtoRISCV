import { pipelinedCpu, singleCycleCpu } from '../lib';
import { assemble } from '../riscv/asm';
import { clockCycle, pipeSnap, retiring, type PipeSnap } from '../riscv/cosim';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { CLK_TO_Q, SETUP, analyzeTiming } from '../sim/timing';
import { netlistOf, outPorts } from '../sim/types';
import { h } from '../ui/dom';
import type { Stage, Widget } from '../view/stage';
import { cpuScene } from '../widgets/cpupanel';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;
/** The single-cycle CPU's logic between registers (period 155), cut into n even stages with a register each. */
const LOGIC = 155 - CLK_TO_Q - SETUP;
const cut = (n: number) => Math.round(LOGIC / n) + CLK_TO_Q + SETUP;

const INDEP = `# independent instructions: no hazards
        li   a0, 1
        li   a1, 2
        li   a2, 3
        li   a3, 4
        li   a4, 5
        li   a5, 6
        li   a6, 7
        li   a7, 8
halt:   j    halt`;

const HAZARDS = `# every kind of hazard, in order
        li   t0, 5
        li   t1, 7
        add  t2, t0, t1      # t0 from W, t1 from M: forwarding
        sub  t3, t2, t0      # t2 from M: forwarding
        sw   t3, 0(zero)
        lw   t4, 0(zero)
        addi t5, t4, 1       # load-use: one bubble, then W→E
        beq  t5, t5, skip    # taken: two wrong-path instructions flushed
        addi t6, zero, 99    # flushed
        addi t6, zero, 98    # flushed
skip:   addi a0, t5, 1
halt:   j    halt`;

/** Bits a pipeline register of the five-stage CPU holds: the widths of its outputs, read from the circuit. */
function regBits(name: string): number {
  const inst = netlistOf(pipelinedCpu(assemble(INDEP).words))!.instances.find((i) => i.name === name);
  return inst ? outPorts(inst.def).reduce((a, p) => a + p.width, 0) : 0;
}

/** What the pipeline's hazard logic does this cycle (null off a pipelined CPU). */
function snap(st: Stage): PipeSnap | null {
  try { return st.sim ? pipeSnap(st.sim, st.sim.design.root, 0) : null; } catch { return null; }
}

function payWidget(): Widget {
  const out = h('div', null, h('p', { class: 'sub' }, 'Measuring: static timing of four processors and a cycle-accurate run of the pipeline…'));
  const el = h('div', { class: 'widget' }, h('div', { class: 'panel' }, h('h3', null, 'Does pipelining pay? Measured'), out));
  setTimeout(() => {
    const words = assemble(src('fib')).words;
    const per = (def: ReturnType<typeof singleCycleCpu>) => analyzeTiming(flatten(def))!.period;
    const sim = new GateSim(flatten(pipelinedCpu(words)));
    sim.setInput('clk', 0);
    sim.settle();
    const iss = new ISS(words);
    let cycles = 0;
    while (!iss.halted && cycles < 2000) {
      const r = retiring(sim);
      clockCycle(sim);
      cycles++;
      if (r) iss.step();
    }
    const cpi = cycles / iss.steps;
    const rows = [
      { name: 'Single-cycle, ripple adders', period: per(singleCycleCpu(words)), cpi: 1 },
      { name: 'Single-cycle, Kogge–Stone', period: per(singleCycleCpu(words, { adder: 'ks' })), cpi: 1 },
      { name: 'Pipelined, ripple adders', period: per(pipelinedCpu(words)), cpi },
      { name: 'Pipelined, Kogge–Stone', period: per(pipelinedCpu(words, { adder: 'ks' })), cpi },
    ];
    const best = Math.min(...rows.map((r) => r.period * r.cpi));
    out.replaceChildren(
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, h('th', null, 'processor'), h('th', null, 'clock period'), h('th', null, 'CPI (fib)'), h('th', null, 'time / instruction'), h('th', null, ''))),
        h('tbody', null, rows.map((r) => {
          const t = r.period * r.cpi;
          return h('tr', null, h('td', null, r.name), h('td', { class: 'num' }, String(r.period)), h('td', { class: 'num' }, r.cpi.toFixed(2)),
            h('td', { class: 'num' }, t.toFixed(0)), h('td', { class: 'barcell' }, h('span', { class: 'cbar k', style: `width:${(best / t) * 100}%` })));
        }))),
      h('p', { class: 'sub', style: 'margin-top:10px' }, `Clock periods in NAND delays from static timing; CPI from running Fibonacci on the gate-level pipeline (${iss.steps} instructions in ${cycles} cycles). Bars: relative speed (longer is faster).`),
    );
  }, 50);
  return { el };
}

export const chPipeline: Chapter = {
  id: 'pipeline', num: 17, title: 'Pipelining', level: 'Processor',
  blurb: 'Five stages working on five instructions at once, and the hazards that come with it.',
  goals: [
    'explain why five stages raise throughput but not the latency of one instruction',
    'find the data hazards in a listing and say where each value is forwarded from',
    'say why a load followed by its use costs one stall, and a taken branch two',
    'judge whether a pipeline pays, from its CPI and its clock period',
  ],
  builds: ['registers', 'cpu'],
  recap: {
    keep: [
      'Five stages, one instruction in each: up to one instruction per cycle, at the period of the <em>slowest</em> stage. One instruction takes no less time than before.',
      'Pipeline registers carry each instruction\'s operands, destination and control bits (and a valid bit), so it acts on the right data cycles later.',
      'Structural hazards (two instructions wanting one unit in one cycle) do not occur here: separate instruction and data memories, two read ports and a write port, adders of its own for PC + 4 and the branch target.',
      'Data hazards: a result one or two instructions back is forwarded from M or W into E; three back, W is bypassed into D. A load followed by its use also costs one stall.',
      'Control hazards: branches resolve in E. A taken branch or a jump flushes the two instructions fetched behind it. The same flush makes exceptions precise: carried with the instruction, acted on in a late stage, nothing younger written.',
      `Every stage pays the register overhead (clk-to-q ${CLK_TO_Q} + setup ${SETUP} = ${CLK_TO_Q + SETUP} NAND delays) and deeper pipelines lose more cycles per flush: depth has diminishing returns.`,
      'Here E keeps almost the whole single-cycle path (145 against at most 21 for F, M and W), so the pipeline does not pay: 145 × CPI 1.34 on fib is about 194 NAND delays per instruction against the single-cycle 155. Balancing the stages (the next chapter) fixes that.',
    ],
    practise: ['pi_reg', 'pi_core0', 'pi_fwd', 'pi_core1', 'pi_haz', 'pi_core2', 'pi_core3'],
    check: [
      {
        question: '<code>add a0, a1, a2</code> then <code>sub t0, a0, a1</code>. Where does sub get a0?',
        options: ['From the register file', 'Forwarded from EX/MEM', 'Forwarded from MEM/WB', 'It stalls one cycle'],
        answer: 1,
        explain: 'When sub is in E, add is one stage ahead with its result in EX/MEM. M is the most recent writer, so it wins.',
        why: ['add writes a0 in W, three cycles after sub reads its registers in D: the register file still holds the old value.', '', 'That is distance 2, with one instruction between them.', 'An ALU result is ready at the end of E, in time to forward. Only a load at distance 1 stalls.'],
      },
      {
        question: '<code>lw t0, 0(a0)</code> then <code>add t1, t0, t0</code>. How many bubbles?',
        options: ['None: forwarding covers it', 'One', 'Two'],
        answer: 1,
        explain: 'The word arrives at the end of M, when add should already be in E: one stall, then forwarding from W.',
        why: ['Forwarding moves a value that exists. The loaded word exists only at the end of M, one cycle too late for E.', '', 'After one stall the load is in W and add in E: W forwards it. A second bubble would be wasted.'],
      },
      {
        question: 'While an instruction is in M, where are its control bits (register write, memory write…)?',
        options: ['In EX/MEM, travelling with it', 'In the control unit, which decodes it again each stage', 'In IF/ID'],
        answer: 0,
        explain: 'Control is decoded once in D and carried along in the pipeline registers, so each stage acts on its own instruction.',
        why: ['', 'The control unit only sees the instruction in D. By the time this one reaches M, it is decoding the instruction two behind it.', 'IF/ID holds the instruction now in D, two behind this one.'],
      },
    ],
  },
  steps: [
    {
      title: 'Overlap the work',
      body: `
        <p>The single-cycle CPU uses each block for a fraction of the cycle: the <span data-show="imem">instruction memory</span>
        is idle while the <span data-show="alu">ALU</span> computes, the ALU idles while the result is written back. A laundry with a
        washer, a dryer and a folding table does not wait for one load to be folded before washing the next.
        <strong>Pipelining</strong> cuts the datapath into five stages separated by <span data-show="FD DE EM MW">registers</span>
        (Fetch, Decode, Execute, Memory, Writeback) and starts a new instruction every cycle.</p>
        <p>Latency per instruction does not improve (it gets slightly worse: each stage now ends in a register, and the clock must fit the
        slowest stage, not the average). <strong>Throughput</strong> can approach one instruction per cycle at a clock period set by the
        slowest stage instead of the whole path. Five instructions are in flight at once, one per stage.</p>
        <p>Three things can stop an instruction from starting: a <strong>structural</strong> hazard (two instructions need
        one unit in the same cycle), a <strong>data</strong> hazard (an operand is not computed yet) and a <strong>control</strong>
        hazard (the next PC is not known yet). This design has no structural ones: separate instruction and data memories, a
        register file with two read ports and a write port, its own adders for PC + 4 and the branch target. One memory port
        for both fetch and loads would collide on every <code>lw</code> and <code>sw</code>. The next three steps take the other two
        kinds one at a time.</p>
        <div class="try">Pulse a few times and watch the pipeline diagram (bottom left): each instruction moves one stage per cycle. These eight instructions are independent, so after four cycles of fill one retires every cycle.</div>`,
      scene: () => ({ ...cpuScene({ source: INDEP, pipeline: true }), autoClock: false }),
      tries: [(st) => st.cycles >= 5],
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['pc', 'imem'], expect: { pcF: 0, validW: 0 },
            say: '<p>The first instruction, <code>li a0, 1</code> at address 0, is in Fetch. Nothing is in the other four stages yet.</p>' },
          { title: 'One cycle', cycles: 1, show: ['FD'], expect: { pcF: 4 },
            say: '<p>One clock edge later it has moved into IF/ID and is being decoded, while Fetch already reads the next one, at 4. Two instructions in flight.</p>' },
          { title: 'Full', cycles: 3, show: ['FD', 'DE', 'EM', 'MW'], expect: { pcF: 16, pcW: 0, validW: 1 },
            say: '<p>After four edges the pipeline is full: five instructions, one per stage. The first reaches Writeback (pcW = {v:pcW}) while Fetch is at {v:pcF}.</p>' },
          { title: 'One per cycle', cycles: 1, show: ['MW'], expect: { pcW: 4, validW: 1 },
            say: '<p>From now on one instruction retires every cycle (pcW = {v:pcW}). Each one still took five cycles from fetch to writeback: throughput went up, latency did not go down.</p>' },
        ],
      },
      more: {
        derive: `<p>Every pipeline register costs its clk-to-q and setup: ${CLK_TO_Q} + ${SETUP} = ${CLK_TO_Q + SETUP} NAND delays per stage
          with our flip-flop. Cut L delays of logic into N even stages and the period is L / N + ${CLK_TO_Q + SETUP}: the single-cycle CPU's
          ${LOGIC} (155 less one register's ${CLK_TO_Q + SETUP}) in five stages is ${cut(5)}, in ten ${cut(10)}, in twenty ${cut(20)}. The overhead becomes
          the clock. Meanwhile a deeper pipeline resolves branches later, so each misprediction flushes more instructions, and a load's result
          waits more stages: CPI rises as the period falls.</p>`,
        real: `<p>Cuts are never even (a 32-bit adder is hard to split). Real cores settled around 10–20 stages after the 31-stage Pentium 4
          (Prescott) ran hot and gained little. Small embedded cores (ARM Cortex-M0, many RISC-V microcontrollers) keep 2 or 3 stages: their
          memories are on chip and fast, and short pipelines need no branch prediction.</p>`,
        pitfall: `<p>"Five stages, so five times faster" ignores three things: the slowest stage sets the clock, every stage adds register overhead,
          and hazards add cycles. The last step of this chapter measures all three on this design: the speed-up there is below one.</p>`,
      },
    },
    {
      title: 'Pipeline registers',
      body: `
        <p>The four tall boxes are the pipeline registers (<span data-show="FD">IF/ID</span>, <span data-show="DE">ID/EX</span>,
        <span data-show="EM">EX/MEM</span>, <span data-show="MW">MEM/WB</span>). Each holds everything the following
        stages need about one instruction: its PC and PC+4, operands, immediate, destination register and the control signals
        that will be used later, plus a <em>valid</em> bit. They get narrower towards the end: once an instruction has used its
        operands in E, nothing after it needs them.</p>
        <p>Each is a wide register with an <strong>enable</strong> (de-assert to stall) and a <strong>synchronous clear</strong>
        (assert to replace the contents with a bubble: all control bits 0, so it writes nothing). Open one: it is the register
        from <a href="#/c/registers/0">chapter 9</a> with a mask in front. Stalls and flushes, the next steps' tools, are nothing more
        than these two inputs.</p>
        <p>Note the <span data-show="rf">register file</span>: written in W, read in D. An instruction's destination
        register number (rd) and its RegWrite bit travel with it so that, when it writes back three cycles later, the right
        register gets the right value. The control unit decodes each instruction once, in D; from there its control bits ride along
        in the pipeline registers.</p>`,
      scene: () => cpuScene({ source: INDEP, pipeline: true, highlight: ['FD', 'DE', 'EM', 'MW'] }),
      tour: {
        beats: [
          { title: 'IF/ID', show: ['FD'],
            say: '<p>IF/ID holds the fetched word and its PC: all Decode needs. Its enable lets the hazard unit hold an instruction in D for a cycle; its clear turns it into a bubble.</p>' },
          { title: 'ID/EX', show: ['DE'],
            say: '<p>ID/EX is the widest: both operands read from the register file, the immediate, rd, the register numbers the forwarding logic compares, and every control bit decoded in D.</p>' },
          { title: 'EX/MEM', show: ['EM'],
            say: '<p>EX/MEM carries the ALU result (an address for a load or store), the value to store, rd and the control bits still to be used: MemWrite, RegWrite, the result select.</p>' },
          { title: 'MEM/WB', show: ['MW'],
            say: '<p>MEM/WB is the narrowest: the value to write, rd and RegWrite. Everything else was used up on the way.</p>' },
        ],
      },
      more: {
        numbers: `<p>Bits per pipeline register in this design, read from the circuit: ${['FD', 'DE', 'EM', 'MW'].map((n) => `${n} ${regBits(n)}`).join(', ')}.</p>`,
        real: `<p>Real cores do not copy every field into every register: a reorder-buffer index or a tag stands for the instruction, and wide values
          are read from a shared structure when needed. In a simple in-order pipeline like this one, the registers are the cost of keeping five
          instructions apart.</p>`,
        pitfall: `<p>Decoding the instruction again in each stage would read the wrong instruction: the control unit only ever sees the one in D. The
          control bits must travel with their instruction.</p>`,
      },
    },
    {
      title: 'Data hazards and forwarding',
      body: `
        <p><code>add t2, t0, t1</code> needs t1 in Execute while the instruction that writes t1 is still one stage ahead, in Memory. The
        register file will only hear about it in Writeback, two cycles later. Waiting would cost cycles. Instead the value is
        <strong>forwarded</strong>: the <span data-show="hz">hazard unit</span> compares the source registers of the instruction in E
        (<code>rs1E</code>, <code>rs2E</code>) with the destinations of the two ahead of it (<code>rdM</code>, <code>rdW</code>), and switches the
        <span data-show="fwdA fwdB">ALU input multiplexers</span> to take the result straight from
        <span data-show="EM">EX/MEM</span> or <span data-show="MW">MEM/WB</span>. The most recent writer (M) wins, and x0 is
        never forwarded (writes to x0 are discarded, so its value is always 0).</p>
        <p>A third case: an instruction in W writes the register in the same cycle an instruction in D reads it. This design
        <span data-show="byA byB">bypasses</span> W into D. Together the three paths cover every distance: one instruction back (M → E),
        two back (W → E), three back (W → D). Four or more back, the register file already has the value.</p>
        <p>Cost: four 5-bit comparators and two 3-input multiplexers of 32 bits, all on the E stage's critical path, which matters in the
        last step.</p>
        <div class="try">Pulse through and watch the event row of the diagram: M→E and W→E mark forwarding.</div>`,
      scene: () => ({ ...cpuScene({ source: HAZARDS, pipeline: true, highlight: ['hz', 'fwdA', 'fwdB', 'byA', 'byB'] }), autoClock: false }),
      tries: [(st) => { const p = snap(st); return !!p && (p.fwdA === 2 || p.fwdB === 2); }],
      tour: {
        beats: [
          { title: 'Fill', reset: true, cycles: 3, show: ['DE', 'EM'], expect: { pcF: 12 },
            say: '<p>Three cycles in: <code>li t0, 5</code> is in M, <code>li t1, 7</code> in E, and <code>add t2, t0, t1</code> in D. Neither value has reached the register file.</p>' },
          { title: 'Two forwards at once', cycles: 1, show: ['hz', 'fwdA', 'fwdB', 'EM', 'MW'], expect: { pcF: 16, pcW: 0, validW: 1 },
            say: '<p><code>add</code> is in E. t0 = 5 comes from W (li t0 is writing back now) and t1 = 7 from M (li t1 computed it last cycle): fwdA selects W, fwdB selects M. The ALU gets 5 + 7 without a single stall.</p>' },
          { title: 'Bypass into D', show: ['byA', 'byB', 'rf'],
            say: '<p>In the same cycle <code>sub t3, t2, t0</code> is in D reading t0, which li t0 writes in W right now. The bypass hands the new value to D directly.</p>' },
          { title: 'The newest wins', cycles: 1, show: ['fwdA', 'EM'], expect: { pcF: 20, pcW: 4 },
            say: '<p><code>sub</code> in E takes t2 = 12 from M (add is one stage ahead) and t0 from ID/EX, already right thanks to the bypass.</p>' },
          { title: 'Store data too', cycles: 1, show: ['fwdB', 'EM'], expect: { pcF: 24 },
            say: '<p><code>sw t3, 0(zero)</code>: the value to store, t3, is forwarded from M through the B side as well. Every operand of every instruction so far arrived on time.</p>' },
        ],
      },
      more: {
        derive: `<p>The hazard unit's rule for operand A (B is the same with rs2): fwdA = M if RegWriteM and rdM ≠ 0 and rdM = rs1E; else W if
          RegWriteW and rdW ≠ 0 and rdW = rs1E; else register file. Checking M first makes the newest value win when both M and W write the same
          register (two writes in a row).</p>`,
        real: `<p>Harris &amp; Harris write the register file on the falling clock edge, so a read in the second half of the cycle sees the new value
          and needs no W → D bypass. A bypass keeps every flip-flop on one edge, which keeps static timing to one register-to-register path
          per stage. Fast cores move the comparisons a stage earlier (into D), so E only has the multiplexers; the next chapter does that.</p>`,
        pitfall: `<p>Forwarding the value of x0 would be wrong: an instruction that "writes" x0 discards its result, so a later reader must still see 0.
          Without the rd ≠ 0 test, <code>add x0, a1, a2</code> followed by <code>add t0, x0, x0</code> would forward the discarded sum.</p>`,
      },
    },
    {
      title: 'The load-use stall',
      body: `
        <p><code>lw t4</code> gets its data at the <em>end</em> of M, but <code>addi t5, t4, 1</code> needs it at the start of E,
        one cycle earlier. No wire can go back in time, so the <span data-show="hz">hazard unit</span> <strong>stalls</strong>:
        it freezes the <span data-show="pc">PC</span> and <span data-show="FD">IF/ID</span> for one cycle and clears
        <span data-show="DE">ID/EX</span>, inserting a bubble. Next cycle the load is in W and forwarding covers the rest.</p>
        <p>The test is simple: the instruction in E is a load (MemRead) and its rd matches either source of the instruction in D. One extra
        cycle per load-use pair; on code that loads a value and immediately uses it in a loop, that is a large share of the CPI. Compilers
        hide it by scheduling an independent instruction into the slot after the load.</p>
        <div class="try">Pulse until the hazard unit stalls: the diagram holds <code>addi t5</code> in D for a second cycle.</div>`,
      scene: () => ({ ...cpuScene({ source: HAZARDS, pipeline: true, highlight: ['hz', 'FD', 'DE'] }), autoClock: false }),
      tries: [(st) => !!snap(st)?.stall],
      tour: {
        beats: [
          { title: 'The load reaches E', reset: true, cycles: 7, show: ['hz', 'DE'], expect: { pcF: 28 },
            say: '<p>Seven cycles in: <code>lw t4, 0(zero)</code> is in E, computing its address, and <code>addi t5, t4, 1</code> is in D. The hazard unit sees MemRead in E and rd = t4 = rs1 in D: stall.</p>' },
          { title: 'The bubble', cycles: 1, show: ['pc', 'FD', 'DE'], expect: { pcF: 28 },
            say: '<p>The PC and IF/ID kept their contents (pcF is still {v:pcF}) and ID/EX was cleared: E holds a bubble that writes nothing, while the load moved on to M and reads memory.</p>' },
          { title: 'Forwarded from W', cycles: 1, show: ['fwdA', 'MW'], expect: { pcF: 32 },
            say: '<p>Now the load is in W with its word, and <code>addi</code> is in E: fwdA takes t4 from MEM/WB. One cycle lost, nothing else.</p>' },
        ],
      },
      more: {
        derive: `<p>stall = MemReadE · (rdE = rs1D + rdE = rs2D) · (rdE ≠ 0). While stall is 1: PC enable = 0, IF/ID enable = 0, ID/EX clear = 1. The
          instruction in D is simply decoded again next cycle, and the comparison then fails because the load has left E.</p>`,
        real: `<p>Longer pipelines have longer load-use delays: two or three cycles behind an L1 cache hit is common. Out-of-order cores keep working on
          independent instructions meanwhile (<a href="#/c/ooo/0">a later chapter</a>); in-order cores rely on the compiler's scheduling.</p>`,
        pitfall: `<p>Stalling the whole pipeline would also hold the load in M, and the word it is fetching would never arrive. Only the stages
          behind the dependent instruction stop; the load keeps going.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why can forwarding not remove the load-use bubble?',
        options: ['The data memory is too slow for forwarding wires', 'The loaded value does not exist yet when the dependent instruction needs it at the start of E', 'Loads cannot write registers in the same cycle'], answer: 1,
        why: ['Speed is not the issue: even an instant memory delivers the word at the end of M, after the next instruction\'s E has begun.', '', 'Loads write in W like everything else, and the bypass covers that. The problem comes earlier: E needs the value before M has produced it.'],
        explain: 'The value appears at the end of the load\'s M stage, which is the same cycle the next instruction would execute. Compilers schedule an independent instruction into that slot to hide the bubble.',
      },
    },
    {
      title: 'Control hazards',
      body: `
        <p>A branch is <span data-show="npc">resolved in E</span>, by which time the pipeline has already fetched the next two
        sequential instructions. This design <em>predicts not taken</em>: it simply keeps fetching PC + 4. If the branch is taken, the
        <span data-show="hz">hazard unit</span> <strong>flushes</strong> <span data-show="FD DE">IF/ID and ID/EX</span> (two
        bubbles) and the <span data-show="pcmux">PC</span> jumps to the target. Jumps always pay the two cycles.</p>
        <p>Loops are full of taken branches: this one loses two cycles per iteration, five cycles for three instructions. Watch the CPI in
        the panel. Real cores predict branches (dynamic predictors are often more than 95% accurate) and resolve them earlier.</p>
        <p>The flush is safe because nothing the two wrong-path instructions did is visible yet: they have not reached M (no store) or W (no
        register write). A design that resolved branches later than the first stage that changes state would need much more care.
        The same flush is how a pipeline keeps a faulting instruction from leaving younger ones half done (In real silicon, below).</p>
        <div class="try">Pulse until the loop branch is taken: two instructions turn into bubbles.</div>`,
      scene: () => ({ ...cpuScene({ source: src('sum'), pipeline: true, highlight: ['npc', 'hz', 'pcmux'] }), autoClock: false }),
      tries: [(st) => !!snap(st)?.flush],
      tour: {
        beats: [
          { title: 'The branch reaches E', reset: true, cycles: 7, show: ['npc', 'hz'], expect: { pcF: 28 },
            say: '<p>Seven cycles in, the loop\'s <code>bne t0, t1, loop</code> is in E and taken. Behind it, the two instructions after the loop (at 0x18 and 0x1c) were fetched anyway: the pipeline guessed "not taken".</p>' },
          { title: 'Flushed', cycles: 1, show: ['FD', 'DE', 'pcmux'], expect: { pcF: 12 },
            say: '<p>The hazard unit cleared IF/ID and ID/EX: two bubbles. The PC took the branch target, so Fetch is back at the loop, pcF = {v:pcF}. Neither wrong-path instruction wrote anything.</p>' },
          { title: 'Five cycles a lap', cycles: 5, show: ['npc'], expect: { pcF: 12 },
            say: '<p>Five cycles later the same thing happens again: three instructions per iteration, plus two bubbles. A loop of n iterations pays 2(n − 1) cycles of flushes.</p>' },
        ],
      },
      more: {
        real: `<p>The same flush serves exceptions. An illegal instruction found in D, a misaligned load in M, a page fault: the handler must see the
          machine as if instructions ran one at a time, with every older instruction finished and no younger one having written a register or
          memory. That is a <strong>precise</strong> exception. A pipeline gets it by recording the exception in the pipeline register beside the
          instruction, doing nothing yet, and acting when it reaches a late stage (before any store of its own commits): squash it and everything
          behind, save its PC (<code>mepc</code>), fetch the handler. An older instruction's exception, discovered later, still wins because it
          reaches that stage first. This pipeline takes no traps; <a href="#/c/traps/0">chapter 20</a> adds them to the single-cycle CPU.</p>`,
        derive: `<p>Cycles per iteration = instructions + 2 × (taken branches). With a branch taken on a fraction t of the instructions, CPI ≈ 1 + 2t
          (plus load-use stalls). For this loop t = 1/3: CPI = 5/3.</p>`,
        pitfall: `<p>"Predict not taken" is the worst guess for loops, whose closing branch is taken on every iteration but the last. Static
          predictors therefore guess backward branches taken and forward branches not taken; the predictor in <a href="#/c/pipepay/0">the next chapter</a> learns.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A loop runs 10 times: its closing branch is taken 9 times and falls through once. How many cycles do its flushes cost?',
        options: ['10', '18', '20', '0: the branch is predicted'], answer: 1,
        explain: 'Each taken branch flushes two instructions: 9 × 2 = 18 cycles. The last, not-taken branch matches the prediction and costs nothing.',
        why: ['Each taken branch flushes two instructions, not one.', '', 'The last branch falls through, which is what the pipeline predicted: no flush.', 'The prediction is always "not taken", so every taken branch is mispredicted.'],
      },
    },
    {
      title: 'Does it pay? Measured',
      body: `
        <p>Time per instruction = CPI × clock period. The table measures both for our designs, and the result is not what
        the textbook diagram promises: <strong>this pipeline is barely faster per cycle and slower per instruction</strong>.</p>
        <p>The static timing shows why. The E stage contains the forwarding comparators, the forwarding muxes, the whole 32-bit
        ALU, the branch decision and the flush logic: almost the entire single-cycle critical path. Meanwhile F, M and W need
        only ~20 NAND delays, because our memories are tiny multiplexer trees, much faster than real SRAM. A pipeline's clock is its
        slowest stage, so cutting off the fast parts gained nothing, and the hazards' extra cycles are pure loss.</p>
        <p>Pipelining pays when stages are balanced. Real designs: precompute forwarding selects a stage early, compute branch
        conditions with a dedicated comparator, predict branches, and split the slowest stage. Here the clock must fit
        the slowest stage, and in a real chip memory access, not the ALU, dominates the single-cycle path.</p>
        <p><a href="#/c/pipepay/0">The next chapter</a> does exactly that, one measured step at a time.</p>`,
      widget: () => payWidget(),
      more: {
        derive: `<p>Speed-up over the single-cycle CPU = (CPI₁ × T₁) / (CPI_pipe × T_pipe). With CPI₁ = 1, a pipeline gains only if its period
          shrinks by more than its CPI grows. Five even stages of the ${LOGIC}-delay logic would give a period of ${cut(5)}: that pays while the CPI stays below
          155 / ${cut(5)} = ${(155 / cut(5)).toFixed(2)}. The unbalanced cut here gives the E stage almost all of it.</p>`,
        pitfall: `<p>Measuring a pipeline by its cycles per instruction alone, or by its clock alone, misleads: only the product is time.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Which change would most directly shorten this pipeline\'s clock period?',
        options: ['A faster register file', 'Moving work out of the E stage (precomputed forwarding, a separate branch comparator, a faster adder)', 'Adding more pipeline registers to the F stage', 'A larger data memory'],
        answer: 1,
        why: ['The register file sits in D, already far shorter than E: the period would not move.', '', 'F is one of the short stages (about 20 NAND delays); splitting it shortens nothing that sets the clock.', 'A larger memory is a deeper mux tree: M gets slower, not faster.'],
        explain: 'The period is set by the slowest stage, and E is about 7× slower than F, M and W with ripple adders (145 against at most 21), 4.4× with Kogge–Stone (93). The IF/ID and PC rows of the timing panel show nearly the same number because they capture the redirect from E, not a slow fetch. Only shortening E (or splitting it) moves the clock: 145 → 93 with the faster adder.',
      },
    },
  ],
};
