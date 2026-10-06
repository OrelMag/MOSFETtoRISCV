import { BTB, SAT_COUNTER } from '../lib';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { perfTable } from '../widgets/perf';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;

export const chPipePay: Chapter = {
  id: 'pipepay', num: 17, title: 'Making the pipeline pay', level: 'Processor',
  blurb: 'Balance the stages, then predict branches: measured, step by step.',
  steps: [
    {
      title: 'Look-ahead forwarding',
      body: `
        <p>The basic hazard unit compares rs1E/rs2E with rdM/rdW <em>during</em> the execute stage, so the comparators
        (XNOR + 5-input AND, then the priority logic) sit in front of the forwarding muxes on the critical path.</p>
        <p>But everything needed for that decision is known one cycle earlier. While an instruction is in D, the instruction
        that will be in M next cycle is the one now in E, and the one that will be in W is now in M. So the balanced hazard unit
        compares <strong>rs1D/rs2D with rdE/rdM</strong> and writes the 2-bit forwarding selects into ID/EX. In E the muxes
        get a ready-made select straight out of a flip-flop.</p>
        <div class="try">The timing panel (bottom left) shows the new critical path. Compare with the previous chapter's
        145 / 93: the forwarding comparators are gone from it.</div>`,
      scene: () => cpuScene({ source: src('fib'), pipeline: true, balanced: true, adder: 'ks', timing: true, highlight: ['hz', 'DE'] }),
    },
    {
      title: 'A comparator for branches',
      body: `
        <p>The basic pipeline decides a branch from the ALU's flags: the 32-bit subtraction, then the ALU's result multiplexer and
        its 32-input zero detector, then the next-PC logic. The balanced design adds a <strong>branch comparator</strong> next to the
        ALU: an equality comparator (XNOR per bit + an AND tree) and a fast subtractor for the signed/unsigned less-than flags,
        working on the forwarded operands directly. <code>jalr</code> gets its own rs1 + imm adder for the same reason.</p>
        <p>That is ~1 300 more NANDs to shorten the branch path. Area for speed, again.</p>`,
      scene: () => cpuScene({ source: src('gcd'), pipeline: true, balanced: true, adder: 'ks', timing: true, highlight: ['bcmp', 'jtgt'] }),
      challenge: {
        kind: 'quiz', question: 'With the ripple-carry ALU, the balanced pipeline\'s critical path is EX/MEM → forwarding → ALU → EX/MEM. What does that tell you?',
        options: ['The branch logic is still the bottleneck', 'The stages are now limited by the ALU itself: a faster adder is the next step', 'Forwarding should be removed'], answer: 1,
        explain: 'Once forwarding and branches are off the path, the E stage is "just" the ALU (plus one forwarding mux). With the Kogge–Stone ALU the period drops to ~59 NAND delays, close to the other stages.',
      },
    },
    {
      title: 'Predicting branches',
      body: `
        <p>Balancing shortens the clock but not the CPI: every taken branch still costs two bubbles. A <strong>branch target buffer</strong>
        in Fetch remembers, per branch address, where it went and how it tends to behave. Our BTB has 16 entries, indexed by PC[5:2]
        and tagged by PC[31:6], each with the target and a <strong>2-bit saturating counter</strong>.</p>
        <p>If Fetch hits a predicted-taken entry it fetches the target next instead of PC+4. Execute verifies the prediction; only a
        <em>misprediction</em> flushes, and redirects to the correct PC. Open the BTB: it is the register file's construction
        (decoder, registers, bundled bus, two read ports) holding 62-bit entries.</p>
        <div class="try">Run the program and watch the diagram: after the first iteration the loop branch is predicted, and the flushes disappear.</div>`,
      scene: () => cpuScene({ source: src('sum'), pipeline: true, balanced: true, predictor: true, adder: 'ks', highlight: ['btb', 'mis', 'corr'] }),
    },
    {
      title: 'Two bits of history',
      body: `
        <p>Why two bits? With one bit (last outcome), a loop branch mispredicts twice per loop: once at the exit and once on re-entry.
        The 2-bit counter needs two wrong guesses in a row to change its mind, so a loop that exits once mispredicts once.</p>
        <p>States 00 and 01 predict not-taken, 10 and 11 taken. Taken moves up, not-taken moves down, saturating at the ends;
        a newly allocated entry starts weakly in the direction just seen. The truth table is computed from the circuit.</p>`,
      scene: () => ({ root: SAT_COUNTER, inputs: { c: 2, taken: 1, hit: 1 } }),
    },
    {
      title: 'The price of prediction',
      body: `
        <p>Prediction adds logic to the execute stage: the outcome must be compared with the prediction (direction and target) before
        the pipeline knows whether to flush. The first version compared the predicted target with the <em>selected</em> correct PC,
        which waits for the branch decision, and the period went from 59 to 87 NAND delays.</p>
        <p>The fix is a classic: compare the predicted target against <strong>both</strong> candidate targets in parallel (PC + imm,
        rs1 + imm) and pick the right comparison with the jalr bit. The decision and the check then overlap: 70 NAND delays.</p>`,
      scene: () => ({ root: BTB, inputs: {} }),
    },
    {
      title: 'Measured, all together',
      body: `
        <p>Every row is the same instruction set running the same programs, checked against the golden model. Time per instruction is
        the only number that matters to the user; period and CPI are how you get there.</p>
        <p>Balancing turns the pipeline from slower than the single-cycle machine into faster. Prediction trades a slightly longer
        period for a much lower CPI. Which wins depends on the program's branches, which is why real designs measure on
        benchmarks rather than argue from diagrams.</p>`,
      widget: () => perfTable('Single-cycle vs pipelined, measured', [
        { name: 'Single-cycle, ripple', pipeline: false, adder: 'rca' },
        { name: 'Single-cycle, Kogge–Stone', pipeline: false, adder: 'ks' },
        { name: 'Pipeline, basic, Kogge–Stone', pipeline: true, adder: 'ks' },
        { name: 'Pipeline, balanced, ripple', pipeline: true, adder: 'rca', balanced: true },
        { name: 'Pipeline, balanced, Kogge–Stone', pipeline: true, adder: 'ks', balanced: true },
        { name: 'Pipeline, balanced + BTB, Kogge–Stone', pipeline: true, adder: 'ks', balanced: true, predictor: true },
      ], ['fib', 'gcd', 'mul'], 'The basic and balanced pipelines have the same CPI (same hazards); only the period differs.'),
    },
  ],
};
