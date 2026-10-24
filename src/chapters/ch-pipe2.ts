import { BRANCH_CMP, BTB, SAT_COUNTER, koggeStone, regfile } from '../lib';
import { stats } from '../sim/stats';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { perfTable } from '../widgets/perf';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;
const fmt = (n: number) => n.toLocaleString('en-US').replace(/,/g, ' ');
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
/** What balancing adds beside the ALU: the branch comparator and jalr's own rs1 + imm adder. */
const CMP = nands(BRANCH_CMP), JADD = nands(koggeStone(32));

/** Does the branch predictor (instance btb) predict taken for the instruction in F this cycle? */
function predicted(st: Stage): boolean {
  try {
    const n = st.sim?.design.root.children?.get('btb');
    return !!n && st.sim!.getBits(n.ports.predTaken)[0] === 1;
  } catch { return false; }
}

export const chPipePay: Chapter = {
  id: 'pipepay', num: 18, title: 'Making the pipeline pay', level: 'Processor',
  blurb: 'Balance the stages, then predict branches: measured, step by step.',
  goals: [
    'move the forwarding decision one stage earlier and say what it takes off the critical path',
    'say what a dedicated branch comparator costs and what it saves',
    'trace a 2-bit saturating counter through a loop and count its mispredictions',
    'choose between a shorter period and a lower CPI from measured time per instruction',
  ],
  builds: ['pipeline', 'fastadd'],
  recap: {
    keep: [
      'Look-ahead forwarding compares rs1D / rs2D with rdE / rdM one cycle early and stores the 2-bit selects in ID/EX: in E the muxes get them straight from a flip-flop.',
      'A branch comparator (equality + a fast subtractor) and a separate rs1 + imm adder take branches off the ALU\'s path. With Kogge–Stone adders the balanced pipeline runs at 59 NAND delays, against 93 for the basic one.',
      'The BTB: 16 entries indexed by PC[5:2] and tagged by PC[31:6], each a target and a 2-bit counter. Fetch follows a predicted-taken entry; only a misprediction flushes.',
      'A 2-bit counter in a strong state (00 or 11) needs two wrong guesses in a row to change its prediction, so a loop branch sitting at 11 mispredicts once per loop, not twice.',
      `Checking the prediction against both candidate targets in parallel holds the period at 70 instead of 87. The BTB costs ${fmt(nands(BTB))} NANDs, about a register file: the core grows by 38 %.`,
      'Measured on fib, gcd and mul: period +19 % (59 → 70), CPI −14 % (1.51 → 1.30), about a draw on average (89 against 91 NAND delays per instruction). Prediction wins on fib and gcd and loses on mul. Time per instruction = CPI × period decides what pays.',
      'A BTB predicts both where and whether. Real cores split them: a large direction predictor (gshare: counters indexed by PC ⊕ recent outcomes; TAGE), a BTB for targets, and a return-address stack for <code>ret</code>.',
    ],
    practise: ['o_bpred'],
    check: [
      {
        question: 'Look-ahead forwarding compares the sources of the instruction in D with rdE and rdM. Why those two?',
        options: ['Next cycle, when it reaches E, those instructions will be in M and W', 'They are the registers it will write', 'They are the only ones the register file cannot read', 'Comparing in D needs fewer bits'],
        answer: 0,
        explain: 'Forwarding in E takes values from M and W. One cycle earlier, those instructions are in E and M, so their destinations are already known.',
        why: ['', 'rdE and rdM belong to the instructions ahead of it; its own destination is rdD.', 'The register file can read any register; the problem is that those two have not written theirs yet.', 'Register numbers are 5 bits in every stage. The gain is time: the comparison leaves E\'s critical path.'],
      },
      {
        question: 'A loop branch is taken 9 times, then falls through, and the loop runs again. With a <em>1-bit</em> predictor, how many mispredictions per pass, after the first pass?',
        options: ['2', '1', '0', '10'],
        answer: 0,
        explain: 'The exit mispredicts (predicted taken) and flips the bit to not-taken, so the first branch of the next pass mispredicts too.',
        why: ['', 'That is the 2-bit counter: one not-taken exit does not change its prediction.', 'The exit is always mispredicted: the predictor has just seen nine takens.', 'A 1-bit predictor is right whenever the outcome repeats, which is 8 times out of 10.'],
      },
      {
        question: 'The predictor lengthens the balanced pipeline\'s period from 59 to 70 NAND delays. When does it still pay?',
        options: ['When the CPI saved on flushes outweighs a period 19% longer', 'Never: a longer period is always slower', 'Always: the period does not matter', 'Only on programs without loops'],
        answer: 0,
        explain: 'Time per instruction = CPI × period. In a loop the flushes saved can outweigh the longer period; straight-line code pays it for nothing. Here it is about a draw: CPI 1.51 → 1.30 (−14 %) against the period\'s +19 %; fib and gcd gain, mul (a six-pass loop whose inner branch follows the multiplier\'s bits) loses.',
        why: ['', 'A lower CPI can more than make up for a longer period: the product is what counts.', 'Every cycle pays the longer period, flush or not. On code with few taken branches the predictor saves little.', 'Loops are where prediction helps most: their branch is taken almost every iteration.'],
      },
    ],
  },
  steps: [
    {
      title: 'Look-ahead forwarding',
      body: `
        <p>The basic <span data-show="hz">hazard unit</span> compares rs1E/rs2E (the source registers of the instruction
        in E) with rdM/rdW (the destinations of the two ahead of it) <em>during</em> the execute stage, so the comparators
        (XNOR + 5-input AND, then the priority logic) sit in front of the <span data-show="fwdA fwdB">forwarding muxes</span> on the critical path.</p>
        <p>But everything needed for that decision is known one cycle earlier. While an instruction is in D, the instruction
        that will be in M next cycle is the one now in E, and the one that will be in W is now in M. So the balanced hazard unit
        compares <strong>rs1D/rs2D with rdE/rdM</strong> and writes the 2-bit forwarding selects into
        <span data-show="DE">ID/EX</span>. In E the muxes get a ready-made select straight out of a flip-flop.</p>
        <div class="try">The timing panel (bottom left) shows the new critical path. Compare with the previous chapter's
        145 / 93: the forwarding comparators are gone from it.</div>`,
      scene: () => cpuScene({ source: src('fib'), pipeline: true, balanced: true, adder: 'ks', timing: true, highlight: ['hz', 'DE'] }),
    },
    {
      title: 'A comparator for branches',
      body: `
        <p>The basic pipeline decides a branch from the <span data-show="alu">ALU</span>'s flags: the 32-bit subtraction, then the ALU's result multiplexer and
        its 32-input zero detector, then the next-PC logic. The balanced design adds a <strong><span data-show="bcmp">branch comparator</span></strong> next to the
        ALU: an equality comparator (XNOR per bit + an AND tree) and a fast subtractor for the signed/unsigned less-than flags,
        working on the forwarded operands directly. <code>jalr</code> gets its own <span data-show="jtgt">rs1 + imm adder</span> for the same reason.</p>
        <p>The comparator is ${fmt(CMP)} NANDs and the jalr adder ${fmt(JADD)}: about ${fmt(Math.round((CMP + JADD) / 100) * 100)} more NANDs to shorten
        the branch path. Area for speed, again.</p>`,
      scene: () => cpuScene({ source: src('gcd'), pipeline: true, balanced: true, adder: 'ks', timing: true, highlight: ['bcmp', 'jtgt'] }),
      challenge: {
        kind: 'quiz', question: 'With the ripple-carry ALU, the balanced pipeline\'s critical path is EX/MEM → forwarding → ALU → EX/MEM. What does that tell you?',
        options: ['The branch logic is still the bottleneck', 'The stages are now limited by the ALU itself: a faster adder is the next step', 'Forwarding should be removed'], answer: 1,
        why: ['Branches now resolve in their own comparator, off this path: the path named runs from forwarding into the ALU and back.', '', 'Forwarding is one mux in front of the ALU; without it every dependent pair of instructions would stall.'],
        explain: 'Once forwarding and branches are off the path, the E stage is "just" the ALU (plus one forwarding mux). With the Kogge–Stone ALU the period drops to 59 NAND delays, and the critical path moves again: forwarded operand → branch comparator → flush of ID/EX. The ALU path into EX/MEM is now 51, the M and W stages at most 21.',
      },
    },
    {
      title: 'Predicting branches',
      body: `
        <p>Balancing shortens the clock but not the CPI: every taken branch still costs two bubbles. A <strong><span data-show="btb">branch target buffer</span></strong>
        in Fetch remembers, per branch address, where it went and how it tends to behave. Our BTB has 16 entries, indexed by PC[5:2]
        and tagged by PC[31:6], each with the target and a <strong>2-bit saturating counter</strong>.</p>
        <p>If Fetch hits a predicted-taken entry it fetches the target next instead of PC+4. Execute
        <span data-show="mis">verifies the prediction</span>; only a <em>misprediction</em> flushes, and redirects to the
        <span data-show="corr">correct PC</span>. Open the BTB: it is the register file's construction
        (decoder, registers, bundled bus, two read ports) holding 62-bit entries: ${fmt(nands(BTB))} NANDs, about as many as the ${fmt(nands(regfile(5, 32)))} of the register file.</p>
        <div class="try">Run the program and watch the diagram: after the first iteration the loop branch is predicted, and the flushes disappear.</div>`,
      scene: () => ({ ...cpuScene({ source: src('sum'), pipeline: true, balanced: true, predictor: true, adder: 'ks', highlight: ['btb', 'mis', 'corr'] }), autoClock: false }),
      tries: [predicted],
    },
    {
      title: 'A 2-bit counter',
      body: `
        <p>Why two bits? With one bit (last outcome), a loop branch mispredicts twice per loop: once at the exit and once on re-entry.
        A 2-bit counter in a strong state (00 or 11) needs two wrong guesses in a row to change its prediction; from a weak state
        (01, 10) one is enough. A loop branch sits at 11, so its single exit moves it to 10, still predicting taken: one
        misprediction per loop.</p>
        <p>States 00 and 01 predict not-taken, 10 and 11 taken. Taken <span data-show="inc1 inc0">moves up</span>,
        not-taken <span data-show="dec1 dec0">moves down</span>, saturating at the ends (<span data-show="m1 m0">taken picks
        which</span>); a newly allocated entry <span data-show="h1 h0">starts weakly</span> in the direction just seen. The truth table is computed from the circuit.</p>
        <details class="deeper"><summary>Deeper: beyond the BTB</summary>
        <p>Our BTB answers two questions with one entry: <em>whether</em> the branch is taken (the counter) and <em>where</em>
        it goes (the target). Real cores split them. A <strong>direction predictor</strong> is a large table of 2-bit
        counters with no targets or tags; a BTB holds only targets, and a <code>jal</code> needs no direction at all.</p>
        <p><strong>gshare</strong> indexes the counters with PC ⊕ a <em>global history</em> register, the outcomes of the last
        n branches as a shift register, so one branch gets a counter per path that led to it: correlated branches (an
        <code>if</code> testing what an earlier one tested) and short loops with a fixed trip count become predictable.
        TAGE goes further with several tables over geometric history lengths. Our <code>mul</code>'s inner branch follows the
        multiplier's bits: data no history can predict.</p>
        <p>A <strong>return-address stack</strong> handles <code>ret</code>: its target depends on the call site, so a BTB
        entry holding the last return address is wrong whenever a function is called from two places. Each call
        (<code>jal ra</code>) pushes PC + 4, each <code>ret</code> pops: nearly perfect, for a few entries of 32 bits.</p></details>`,
      scene: () => ({ root: SAT_COUNTER, inputs: { c: 2, taken: 1, hit: 1 } }),
    },
    {
      title: 'The price of prediction',
      body: `
        <p>Prediction adds logic to the execute stage: the outcome must be compared with the prediction (direction and target) before
        the pipeline knows whether to flush. The first version compared the predicted target with the <em>selected</em> correct PC,
        which waits for the branch decision, and the period went from 59 to 87 NAND delays.</p>
        <p>The fix is a classic: compare the predicted target against <strong>both</strong> candidate targets in parallel (PC + imm,
        rs1 + imm) and pick the right comparison with the jalr bit. The decision and the check then overlap: 70 NAND delays.</p>
        <p>And area: this BTB is ${fmt(nands(BTB))} NANDs (16 entries × 62 bits of flip-flops, a decoder and two read ports),
        as much as the register file. With its checking logic the core grows by 38 %, from 64 881 to 89 712 NANDs without the
        program ROM: a large price for a period 19 % longer and a CPI 14 % lower.</p>`,
      scene: () => ({ root: BTB, inputs: {} }),
    },
    {
      title: 'Measured, all together',
      body: `
        <p>Every row is the same instruction set running the same programs, checked against the instruction-set simulator. Time per instruction is
        the only number that matters to the user; period and CPI are how you get there.</p>
        <p>Balancing turns the pipeline from slower than the single-cycle machine into faster. Prediction is a closer call:
        the period grows 19 % (59 → 70) and the CPI falls 14 % (1.51 → 1.30 on average), so time per instruction is about a
        draw (89 against 91). Per program it wins on fib and gcd, whose loop branches it learns, and loses on mul, a loop of
        six passes whose inner <code>beqz</code> follows the multiplier's bits. Which wins depends on the program's branches,
        which is why real designs measure on benchmarks rather than argue from diagrams (a deeper pipeline, with more cycles
        per flush, would gain more from the same predictor).</p>`,
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
