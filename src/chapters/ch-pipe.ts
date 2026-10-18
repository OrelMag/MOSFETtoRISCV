import { pipelinedCpu, singleCycleCpu } from '../lib';
import { assemble } from '../riscv/asm';
import { clockCycle, pipeSnap, retiring, type PipeSnap } from '../riscv/cosim';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { analyzeTiming } from '../sim/timing';
import { h } from '../ui/dom';
import type { Stage, Widget } from '../view/stage';
import { cpuScene } from '../widgets/cpupanel';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;

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
  id: 'pipeline', num: 16, title: 'Pipelining', level: 'Processor',
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
      'Data hazards: a result one or two instructions back is forwarded from M or W into E; three back, W is bypassed into D. A load followed by its use also costs one stall.',
      'Control hazards: branches resolve in E. A taken branch or a jump flushes the two instructions fetched behind it.',
      'Here E keeps almost the whole single-cycle path, so the pipeline barely pays until its stages are balanced (the next chapter).',
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
        is idle while the <span data-show="alu">ALU</span> computes, the ALU idles while the result is written back.
        <strong>Pipelining</strong> cuts the datapath into five stages separated by <span data-show="FD DE EM MW">registers</span>
        (Fetch, Decode, Execute, Memory, Writeback) and starts a new instruction every cycle.</p>
        <p>Latency per instruction does not improve (it gets slightly worse). <strong>Throughput</strong> can approach one
        instruction per cycle at a clock period set by the slowest stage instead of the whole path.</p>
        <div class="try">Pulse a few times and watch the pipeline diagram (bottom left): each instruction moves one stage per cycle. These eight instructions are independent, so after four cycles of fill one retires every cycle.</div>`,
      scene: () => cpuScene({ source: INDEP, pipeline: true }),
      tries: [(st) => st.cycles >= 5],
    },
    {
      title: 'Pipeline registers',
      body: `
        <p>The four tall boxes are the pipeline registers (<span data-show="FD">IF/ID</span>, <span data-show="DE">ID/EX</span>,
        <span data-show="EM">EX/MEM</span>, <span data-show="MW">MEM/WB</span>). Each holds everything the following
        stages need about one instruction: its PC and PC+4, operands, immediate, destination register and the control signals
        that will be used later, plus a <em>valid</em> bit.</p>
        <p>Each is a wide register with an <strong>enable</strong> (de-assert to stall) and a <strong>synchronous clear</strong>
        (assert to replace the contents with a bubble: all control bits 0, so it writes nothing). Open one: it is the register
        from <a href="#/c/registers/0">chapter 9</a> with a mask in front.</p>
        <p>Note the <span data-show="rf">register file</span>: written in W, read in D. The PC and control signals of an instruction travel with it so
        that, when it writes back three cycles later, the right register gets the right value.</p>`,
      scene: () => cpuScene({ source: INDEP, pipeline: true, highlight: ['FD', 'DE', 'EM', 'MW'] }),
    },
    {
      title: 'Data hazards and forwarding',
      body: `
        <p><code>add t2, t0, t1</code> reads t1 in Decode while the instruction that writes t1 is still in Execute. Waiting
        would cost cycles. Instead the value is <strong>forwarded</strong>: the <span data-show="hz">hazard unit</span> compares
        the source registers of the instruction in E (<code>rs1E</code>, <code>rs2E</code>) with the destinations of the two
        ahead of it (<code>rdM</code>, <code>rdW</code>), and switches the
        <span data-show="fwdA fwdB">ALU input multiplexers</span> to take the result straight from
        <span data-show="EM">EX/MEM</span> or <span data-show="MW">MEM/WB</span>. The most recent writer (M) wins, and x0 is
        never forwarded.</p>
        <p>A third case: an instruction in W writes the register in the same cycle an instruction in D reads it. This design
        <span data-show="byA byB">bypasses</span> W into D.</p>
        <details class="deeper"><summary>Deeper: why a bypass, not a falling-edge write</summary>
        <p>Harris &amp; Harris write the register file on the falling clock edge, so a read in the second half of the cycle
        sees the new value. A bypass keeps every flip-flop on one edge, which keeps static timing to one
        register-to-register path per stage.</p></details>
        <div class="try">Pulse through and watch the event row of the diagram: M→E and W→E mark forwarding.</div>`,
      scene: () => cpuScene({ source: HAZARDS, pipeline: true, highlight: ['hz', 'fwdA', 'fwdB', 'byA', 'byB'] }),
      tries: [(st) => { const p = snap(st); return !!p && (p.fwdA === 2 || p.fwdB === 2); }],
    },
    {
      title: 'The load-use stall',
      body: `
        <p><code>lw t4</code> gets its data at the <em>end</em> of M, but <code>addi t5, t4, 1</code> needs it at the start of E,
        one cycle earlier. No wire can go back in time, so the <span data-show="hz">hazard unit</span> <strong>stalls</strong>:
        it freezes the <span data-show="pc">PC</span> and <span data-show="FD">IF/ID</span> for one cycle and clears
        <span data-show="DE">ID/EX</span>, inserting a bubble. Next cycle the load is in W and forwarding covers the rest.</p>
        <div class="try">Pulse until the hazard unit stalls: the diagram holds <code>addi t5</code> in D for a second cycle.</div>`,
      scene: () => cpuScene({ source: HAZARDS, pipeline: true, highlight: ['hz', 'FD', 'DE'] }),
      tries: [(st) => !!snap(st)?.stall],
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
        sequential instructions. This design <em>predicts not taken</em>: if the branch is taken, the
        <span data-show="hz">hazard unit</span> <strong>flushes</strong> <span data-show="FD DE">IF/ID and ID/EX</span> (two
        bubbles) and the <span data-show="pcmux">PC</span> jumps to the target. Jumps always pay the two cycles.</p>
        <p>Loops are full of taken branches: this one loses two cycles per iteration. Watch the CPI in the panel. Real cores
        predict branches (dynamic predictors are often more than 95% accurate) and resolve them earlier.</p>
        <div class="try">Pulse until the loop branch is taken: two instructions turn into bubbles.</div>`,
      scene: () => cpuScene({ source: src('sum'), pipeline: true, highlight: ['npc', 'hz', 'pcmux'] }),
      tries: [(st) => !!snap(st)?.flush],
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
        only ~20 NAND delays, because our memories are tiny multiplexer trees, much faster than real SRAM.</p>
        <p>Pipelining pays when stages are balanced. Real designs: precompute forwarding selects a stage early, compute branch
        conditions with a dedicated comparator, predict branches, and split the slowest stage. Here the clock must fit
        the slowest stage, and in a real chip memory access, not the ALU, dominates the single-cycle path.</p>
        <p><a href="#/c/pipepay/0">The next chapter</a> does exactly that, one measured step at a time.</p>`,
      widget: () => payWidget(),
      challenge: {
        kind: 'quiz', question: 'Which change would most directly shorten this pipeline\'s clock period?',
        options: ['A faster register file', 'Moving work out of the E stage (precomputed forwarding, a separate branch comparator, a faster adder)', 'Adding more pipeline registers to the F stage', 'A larger data memory'],
        answer: 1,
        why: ['The register file sits in D, already far shorter than E: the period would not move.', '', 'F is one of the short stages (about 20 NAND delays); splitting it shortens nothing that sets the clock.', 'A larger memory is a deeper mux tree: M gets slower, not faster.'],
        explain: 'The period is set by the slowest stage, and E is ~3× slower than the others. Only shortening E (or splitting it) moves the clock. The Kogge–Stone variant already shows the effect: 145 → 93.',
      },
    },
  ],
};
