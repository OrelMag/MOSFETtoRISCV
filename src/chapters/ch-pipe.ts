import { pipelinedCpu, singleCycleCpu } from '../lib';
import { assemble } from '../riscv/asm';
import { clockCycle, retiring } from '../riscv/cosim';
import { ISS } from '../riscv/iss';
import { PROGRAMS } from '../riscv/programs';
import { flatten } from '../sim/flatten';
import { GateSim } from '../sim/gatesim';
import { analyzeTiming } from '../sim/timing';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
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
  steps: [
    {
      title: 'Overlap the work',
      body: `
        <p>The single-cycle CPU uses each block for a fraction of the cycle: the instruction memory is idle while the ALU
        computes, the ALU idles while the result is written back. <strong>Pipelining</strong> cuts the datapath into five
        stages separated by registers, Fetch, Decode, Execute, Memory, Writeback, and starts a new instruction every cycle.</p>
        <p>Latency per instruction does not improve (it gets slightly worse). <strong>Throughput</strong> can approach one
        instruction per cycle at a clock period set by the slowest stage instead of the whole path.</p>
        <div class="try">Pulse a few times and watch the pipeline diagram (bottom left): each instruction moves one stage per cycle. These eight instructions are independent, so after four cycles of fill one retires every cycle.</div>`,
      scene: () => cpuScene({ source: INDEP, pipeline: true }),
    },
    {
      title: 'Pipeline registers',
      body: `
        <p>The four tall boxes are the pipeline registers (IF/ID, ID/EX, EX/MEM, MEM/WB). Each holds everything the following
        stages need about one instruction: its PC and PC+4, operands, immediate, destination register and the control signals
        that will be used later, plus a <em>valid</em> bit.</p>
        <p>Each is a wide register with an <strong>enable</strong> (de-assert to stall) and a <strong>synchronous clear</strong>
        (assert to replace the contents with a bubble: all control bits 0, so it writes nothing). Open one: it is the register
        from Chapter 9 with a mask in front.</p>
        <p>Note the register file: written in W, read in D. The PC and control signals of an instruction travel with it so
        that, when it writes back three cycles later, the right register gets the right value.</p>`,
      scene: () => cpuScene({ source: INDEP, pipeline: true, highlight: ['FD', 'DE', 'EM', 'MW'] }),
    },
    {
      title: 'Data hazards and forwarding',
      body: `
        <p><code>add t2, t0, t1</code> reads t1 in D while the instruction that writes t1 is still in E. Waiting would cost
        cycles; instead the value is <strong>forwarded</strong>: the hazard unit compares rs1E/rs2E with rdM and rdW and
        switches the ALU input multiplexers to take the result straight from the M or W stage. The most recent writer (M) wins,
        and x0 is never forwarded.</p>
        <p>A third case: an instruction in W writes the register in the same cycle an instruction in D reads it. This design
        <strong>bypasses</strong> W into D (the primer instead writes the register file on the falling clock edge; a bypass keeps
        every flip-flop on one edge, which keeps the timing analysis honest).</p>
        <div class="try">Pulse through and watch the event row of the diagram: M→E and W→E mark forwarding.</div>`,
      scene: () => cpuScene({ source: HAZARDS, pipeline: true, highlight: ['hz', 'fwdA', 'fwdB', 'byA', 'byB'] }),
    },
    {
      title: 'The load-use stall',
      body: `
        <p><code>lw t4</code> gets its data at the <em>end</em> of M, but <code>addi t5, t4, 1</code> needs it at the start of E,
        one cycle earlier. No wire can go back in time, so the hazard unit <strong>stalls</strong>: it freezes PC and IF/ID
        for one cycle and clears ID/EX, inserting a bubble. Next cycle the load is in W and forwarding covers the rest.</p>`,
      scene: () => cpuScene({ source: HAZARDS, pipeline: true, highlight: ['hz', 'FD', 'DE'] }),
      challenge: {
        kind: 'quiz', question: 'Why can forwarding not remove the load-use bubble?',
        options: ['The data memory is too slow for forwarding wires', 'The loaded value does not exist yet when the dependent instruction needs it at the start of E', 'Loads cannot write registers in the same cycle'], answer: 1,
        explain: 'The value appears at the end of the load\'s M stage, which is the same cycle the next instruction would execute. Compilers schedule an independent instruction into that slot to hide the bubble.',
      },
    },
    {
      title: 'Control hazards',
      body: `
        <p>A branch is resolved in E, by which time the pipeline has already fetched the next two sequential instructions.
        This design <em>predicts not taken</em>: if the branch is taken, the hazard unit <strong>flushes</strong> IF/ID and
        ID/EX (two bubbles) and the PC jumps to the target. Jumps always pay the two cycles.</p>
        <p>Loops are full of taken branches: this one loses two cycles per iteration. Watch the CPI in the panel. Real cores
        predict branches (dynamic predictors are often more than 95% accurate) and resolve them earlier.</p>`,
      scene: () => cpuScene({ source: src('sum'), pipeline: true, highlight: ['npc', 'hz', 'pcmux'] }),
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
        <p>The next chapter does exactly that, one measured step at a time.</p>`,
      widget: () => payWidget(),
      challenge: {
        kind: 'quiz', question: 'Which change would most directly shorten this pipeline\'s clock period?',
        options: ['A faster register file', 'Moving work out of the E stage (precomputed forwarding, a separate branch comparator, a faster adder)', 'Adding more pipeline registers to the F stage', 'A larger data memory'],
        answer: 1,
        explain: 'The period is set by the slowest stage, and E is ~3× slower than the others. Only shortening E (or splitting it) moves the clock. The Kogge–Stone variant already shows the effect: 145 → 93.',
      },
    },
  ],
};
