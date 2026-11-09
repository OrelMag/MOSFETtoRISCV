import { groupDigits } from '../sim/numfmt';
import { alu } from '../lib/alu';
import { koggeStone } from '../lib/fastadd';
import { BRANCH_CMP, BTB, SAT_COUNTER } from '../lib/pipeline';
import { regfile } from '../lib/regfile';
import { logicDepth, stats } from '../sim/stats';
import { PROGRAMS } from '../riscv/programs';
import { cpuScene } from '../widgets/cpupanel';
import { perfTable } from '../widgets/perf';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';
import { numOf } from './order';

const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;
const fmt = groupDigits;
const nands = (d: Parameters<typeof stats>[0]) => stats(d).nands;
/** What balancing adds beside the ALU: the branch comparator and jalr's own rs1 + imm adder. */
const CMP = nands(BRANCH_CMP), JADD = nands(koggeStone(32));
/** NAND delays of the comparator and of the Kogge–Stone ALU it replaces on the branch path. */
const CMP_DEPTH = logicDepth(BRANCH_CMP) ?? 0, ALU_KS_DEPTH = logicDepth(alu(32, 'ks')) ?? 0;
/** The counter's next state from its own specification (tests/library.test.ts holds it equal to the gates). */
const next = (c: number, taken: number, hit = 1) => SAT_COUNTER.spec!([c, taken, hit])[0];
/** BTB capacity in flip-flops: 16 entries of 62 bits. */
const BTB_BITS = 16 * 62;

/** Does the branch predictor (instance btb) predict taken for the instruction in F this cycle? */
function predicted(st: Stage): boolean {
  try {
    const n = st.sim?.design.root.children?.get('btb');
    return !!n && st.sim!.getBits(n.ports.predTaken)[0] === 1;
  } catch { return false; }
}

export const chPipePay: Chapter = {
  id: 'pipepay', num: numOf('pipepay'), title: 'Making the pipeline pay', level: 'Processor',
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
        <p><a href="#/c/pipeline/0">Chapter 17</a>'s pipeline did not pay. Its Execute stage keeps almost the whole single-cycle path: 145 NAND delays with ripple
        adders against at most 21 for the other stages, so at CPI 1.34 on fib an instruction takes about 194 delays, against the single-cycle CPU's 155. Kogge–Stone
        adders bring the period to 93, and E is still four times longer than its neighbours. Time per instruction is CPI × period, and this chapter works on
        both factors: first take the forwarding decision and the branch decision off E's path (a shorter period), then predict branches (fewer cycles lost to
        taken ones). Each change is measured, since a gain in one factor can cost the other.</p>
        <p>The basic <span data-show="hz">hazard unit</span> compares rs1E/rs2E (the source registers of the instruction
        in E) with rdM/rdW (the destinations of the two ahead of it) <em>during</em> the execute stage, so the comparators
        (XNOR + 5-input AND, then the priority logic) sit in front of the <span data-show="fwdA fwdB">forwarding muxes</span> on the critical path.</p>
        <p>But everything needed for that decision is known one cycle earlier. While an instruction is in D, the instruction
        that will be in M next cycle is the one now in E, and the one that will be in W is now in M. So the balanced hazard unit
        compares <strong>rs1D/rs2D with rdE/rdM</strong> and writes the 2-bit forwarding selects into
        <span data-show="DE">ID/EX</span>. In E the muxes get a ready-made select straight out of a flip-flop.</p>
        <div class="try">The timing panel (bottom left) shows the new critical path. Compare with the previous chapter's
        145 / 93: the forwarding comparators are gone from it.</div>
        <p>The cost moves rather than disappears: the comparison still happens, one stage earlier, where it is not on the path into the ALU, and the 2-bit selects are stored in ID/EX, a few more flip-flops.
        What makes the trick legal is that the destinations of the two instructions ahead are already known a cycle before they matter, because register numbers come straight from the instruction word.
        A value that is not known early, like a load's data, cannot be forwarded this way, and a load followed by its user still stalls one cycle.</p>`,
      scene: () => cpuScene({ source: src('fib'), pipeline: true, balanced: true, adder: 'ks', timing: true, highlight: ['hz', 'DE'] }),
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['hz', 'DE'], expect: { pcF: 0, validW: 0 },
            say: '<p>Fetch is at {v:pcF} and the other four stages are empty. The hazard unit has nothing to compare yet.</p>' },
          { title: 'Full pipeline', cycles: 4, show: ['hz', 'DE'], expect: { pcF: 16, pcW: 0, validW: 1 },
            say: '<p>After four edges the first instruction is in Writeback (pcW = {v:pcW}) and the loop starts at {v:pcF}: <code>sw t0, 0(t2)</code>. From here the hazard unit compares every instruction in D against the two ahead of it.</p>' },
          { title: 'A dependent branch', cycles: 7, show: ['hz', 'fwdA', 'fwdB'], expect: { pcF: 44, pcW: 28, validW: 1 },
            say: '<p>pcW = {v:pcW}: the instruction in Execute is <code>blt t2, t3, loop</code> at 36, one behind it in Memory is <code>addi t2, t2, 4</code> at 32. t2 is produced one stage ahead, so E must take it from EX/MEM. The select was computed a cycle earlier, while the branch was in D, and sits in ID/EX.</p>' },
          { title: 'The branch is taken', cycles: 1, show: ['DE'], expect: { pcF: 16, pcW: 32, validW: 1 },
            say: '<p>The comparison used the forwarded t2, found 4 &lt; 48, and redirected Fetch to {v:pcF}. The two instructions fetched after the branch, at 40 and 44, are on the wrong path.</p>' },
          { title: 'Two bubbles', cycles: 2, show: ['MW'], expect: { pcF: 24, validW: 0 },
            say: '<p>Those two wrong-path instructions were turned into bubbles, and now pass through Writeback with validW = {v:validW}: no register or memory changes. Each taken branch costs two cycles here; the predictor in this chapter\'s last steps removes them.</p>' },
        ],
      },
      more: {
        derive: `<p>In cycle <em>t</em> instruction I is in D, J in E, K in M. At <em>t</em> + 1 they are in E, M, W, so I's forwarding select for A is: from M (J's result) if rs1<sub>I</sub> = rd<sub>J</sub> and J writes a register and rd ≠ x0;
          else from W (K's result) if rs1<sub>I</sub> = rd<sub>K</sub> under the same conditions; else the register file. Two 5-bit equality comparisons per source (XNOR per bit, a 5-input AND), the more recent writer winning.
          The result is two bits per operand, registered in ID/EX. This chapter\'s period is 59 NAND delays for the balanced pipeline against 93 for the basic one, but forwarding is only one of the changes behind that: the next step supplies the other.</p>`,
        pitfall: `<p>Forwarding from an instruction that does not write a register. A store, a branch, a flushed bubble all have a rd field in their encoding or leftover bits, so the comparison must include the writer\'s RegWrite bit and
          exclude x0 (writes to it are discarded). Without that, <code>sw</code> followed by a user of whichever register its bits happen to name would forward garbage. In the hazard unit these are the AND gates around each comparator.</p>`,
        real: `<p>Forwarding networks are among the wire-heaviest structures in a core. A wide out-of-order core compares every consumer against every producer in flight, with the same idea (compare register tags one stage early),
          and the result decides which of up to a dozen result buses feeds each ALU input.</p>`,
      },
    },
    {
      title: 'A comparator for branches',
      body: `
        <p>The basic pipeline decides a branch from the <span data-show="alu">ALU</span>'s flags: the 32-bit subtraction, then the ALU's result multiplexer and
        its 32-input zero detector, then the next-PC logic. The balanced design adds a <strong><span data-show="bcmp">branch comparator</span></strong> next to the
        ALU: an equality comparator (XNOR per bit + an AND tree) and a fast subtractor for the signed/unsigned less-than flags,
        working on the forwarded operands directly. <code>jalr</code> gets its own <span data-show="jtgt">rs1 + imm adder</span> for the same reason.</p>
        <p>The comparator is ${fmt(CMP)} NANDs and the jalr adder ${fmt(JADD)}: about ${fmt(Math.round((CMP + JADD) / 100) * 100)} more NANDs to shorten
        the branch path. Area for speed, again.</p>
        <p>Why a separate comparator is faster than reusing the ALU: a branch needs one bit, the verdict, and the ALU produces a 32-bit result, a multiplexer choosing among its units and a zero detector over the result before
        that bit exists. The comparator computes the verdict directly: equality from per-bit XNORs and an AND tree, the signed and unsigned orderings from a subtractor's flags, no result mux. It is ${CMP_DEPTH} NAND delays deep against ${ALU_KS_DEPTH}
        for the Kogge–Stone ALU, and it sits right after the forwarding multiplexers.</p>`,
      scene: () => cpuScene({ source: src('gcd'), pipeline: true, balanced: true, adder: 'ks', timing: true, highlight: ['bcmp', 'jtgt'] }),
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['bcmp'], expect: { pcF: 0, validW: 0 },
            say: '<p>The program loads two numbers and calls <code>gcd</code> with <code>jal</code> at 8.</p>' },
          { title: 'The call', cycles: 4, show: ['jtgt'], expect: { pcF: 16, pcW: 0, validW: 1 },
            say: '<p>Fetch is at {v:pcF}, already past the <code>jal</code> at 8 (which is in Execute) and the instruction after it. Both are wrong-path: the jump is not known until E.</p>' },
          { title: 'Redirect', cycles: 1, show: ['bcmp'], expect: { pcF: 20 },
            say: '<p>The jump resolves: Fetch goes to {v:pcF}, the entry of <code>gcd</code>, and the two fetched instructions are flushed.</p>' },
          { title: 'The bubbles arrive', cycles: 2, show: ['MW'], expect: { pcF: 28, validW: 0 },
            say: '<p>The two flushed slots reach Writeback as bubbles (validW = {v:validW}): the price of the jump.</p>' },
          { title: 'The loop', cycles: 4, show: ['bcmp'], expect: { pcF: 20, pcW: 28, validW: 1 },
            say: '<p>gcd\'s <code>beq</code> and <code>bltu</code> are decided in the comparator and fall through; <code>sub</code> follows, then <code>j gcd</code> sends Fetch back to {v:pcF}. Each pass is four useful instructions and two bubbles: 6 cycles.</p>' },
        ],
      },
      more: {
        derive: `<p>Two paths compete for the clock. In the basic pipeline a branch goes forwarding mux → ALU subtract → flags → result mux → zero detect → next-PC → flush, all in E. With a comparator it is forwarding mux → comparator (${CMP_DEPTH}) → flush,
          the ALU\'s ${ALU_KS_DEPTH} delays replaced by the comparator\'s ${CMP_DEPTH}. Both adders are Kogge–Stone, so the rest of the ALU path (result mux, zero detector) is what the comparator removes. The cost is the comparator (${fmt(CMP)} NANDs) and, for <code>jalr</code>, an adder
          for rs1 + imm (${fmt(JADD)}) that no longer shares the ALU.</p>`,
        pitfall: `<p>Calling the old critical path "the ALU" and speeding up the ALU. After the adder swap of chapter 16 the ALU is not the only part of the branch path, and with the comparator the next critical path (see the question below) is forwarded operand →
          comparator → flush. Speed up the path the timing panel names, not the block you suspect.</p>`,
        real: `<p>Cores with a dedicated branch unit and the branch resolved in its own stage are the norm; the comparison is among the first things done in E. Compare-and-branch fusion goes further and treats the two instructions as one
          operation in the pipeline.</p>`,
      },
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
        <p>A misprediction costs the same two bubbles as an unpredicted taken branch. The machine already pays two bubbles for every taken branch, so guessing "not taken" for an entry it has never seen costs nothing extra:
        only a wrong guess flushes. Prediction loses only when it says taken for a branch that falls through, which the unpredicted pipeline would not have flushed; it mostly removes bubbles, at the price of the table and the logic that checks the guess.</p>
        <div class="try">Run the program and watch the diagram: after the first iteration the loop branch is predicted, and the flushes disappear.</div>`,
      scene: () => ({ ...cpuScene({ source: src('sum'), pipeline: true, balanced: true, predictor: true, adder: 'ks', highlight: ['btb', 'mis', 'corr'] }), autoClock: false }),
      tries: [predicted],
      tour: {
        beats: [
          { title: 'First time', reset: true, show: ['btb'], expect: { pcF: 0, validW: 0 },
            say: '<p>The loop of <code>sum</code> adds 1 to 10: three instructions, <code>add</code> at 12, <code>addi</code> at 16, <code>bne</code> at 20. The BTB is empty, so Fetch has no reason to leave PC + 4.</p>' },
          { title: 'Mispredicted', cycles: 8, show: ['mis', 'corr'], expect: { pcF: 12, pcW: 16, validW: 1 },
            say: '<p>The <code>bne</code> reached Execute with an empty BTB: predicted not taken, actually taken. The misprediction logic sends Fetch back to {v:pcF}, the correct PC, and the two instructions fetched after the branch are flushed. The BTB learns the branch.</p>' },
          { title: 'The bubble', cycles: 2, show: ['mis'], expect: { pcF: 20, validW: 0 },
            say: '<p>The flushed slots reach Writeback: validW = {v:validW}. One bubble in W is visible in the window; the price of this first misprediction.</p>' },
          { title: 'Learned', cycles: 4, show: ['btb'], expect: { pcF: 12, pcW: 20, validW: 1 },
            say: '<p>Now Fetch reads the BTB at the <code>bne</code>\'s address, finds a taken entry, and the next fetch is the target: the PC goes from 20 straight to {v:pcF} with no flush. The <code>bne</code> itself is in Writeback ({v:pcW}) and nothing was lost.</p>' },
          { title: 'Steady state', cycles: 3, show: ['btb'], expect: { pcF: 12, pcW: 20, validW: 1 },
            say: '<p>Three cycles later the same: a loop iteration is three instructions and three cycles, validW = {v:validW} throughout. Without prediction each iteration would cost five.</p>' },
        ],
      },
      more: {
        derive: `<p>Cycles per iteration of this loop: three instructions plus two bubbles for the taken branch, 3 + 2 = 5, without prediction; 3 with a correct prediction. CPI falls from 5/3 = ${(5 / 3).toFixed(2)} to 1.00 on this loop.
          The BTB holds ${fmt(BTB_BITS)} bits of state (16 entries of 62: a valid bit, a 26-bit tag, a 32-bit target, a 2-bit counter and a jump flag) in ${fmt(nands(BTB))} NANDs, and is read in Fetch with the address it must predict, in parallel with the instruction memory.</p>`,
        pitfall: `<p>Predicting a branch from its address alone and forgetting that two branches can share an entry. Entries are indexed by PC[5:2] and tagged by PC[31:6], so branches 64 bytes apart collide: the tag differs, the lookup misses, and the
          old entry is evicted when the new branch trains. A loop with a few branches fits; a long program thrashes it. On the circuit: the tag comparison and the valid bit are what separate a hit from a stale entry.</p>`,
        real: `<p>Real BTBs have hundreds to thousands of entries, are set-associative, and are read in a stage or two before the instruction is even decoded, so a core can predict a branch it has not yet seen as a branch. Direction and target
          are usually separate structures, which the counter step below goes into.</p>`,
      },
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
        <p>The next-state block is small, ${nands(SAT_COUNTER)} NANDs: the BTB keeps the two counter bits of each entry in its flip-flops and uses one such block to update the entry being trained. What the two bits buy is hysteresis: a prediction needs
        evidence before it changes, which is what branches that are mostly one way, loops above all, require.</p>`,
      scene: () => ({ root: SAT_COUNTER, inputs: { c: 2, taken: 1, hit: 1 } }),
      tour: {
        beats: [
          { title: 'Steady loop', expect: { next: 3 }, show: ['inc1', 'inc0'],
            say: '<p>The counter reads {v:c} (weakly taken) and the branch is taken: next = {v:next}, strongly taken. Taken moves the state up.</p>' },
          { title: 'Loop exit', set: { c: 3, taken: 0 }, show: ['dec1', 'dec0'], expect: { next: 2 },
            say: '<p>Strongly taken, and the loop finally exits. This is the one misprediction per loop, but the state only drops to {v:next}: still 10, still predicting taken.</p>' },
          { title: 'Next time round', set: { c: 2, taken: 1 }, show: ['inc1', 'inc0'], expect: { next: 3 },
            say: '<p>The loop starts again, the branch is taken and the counter returns to {v:next}. The single exit cost one misprediction, not two.</p>' },
          { title: 'Two misses in a row', set: { c: 2, taken: 0 }, show: ['dec1', 'dec0'], expect: { next: 1 },
            say: '<p>A second not-taken in a row takes the counter to {v:next}: now it predicts not taken. It takes two wrong guesses, not one, to change a strong prediction.</p>' },
          { title: 'A new entry', set: { c: 0, taken: 1, hit: 0 }, show: ['h1', 'h0'], expect: { next: 2 },
            say: '<p>With hit = 0 the entry is being allocated, and the old counter value is ignored: it starts weakly in the direction just seen, {v:next} for taken.</p>' },
        ],
      },
      more: {
        derive: `<p>The next-state function, computed from the counter\'s specification (hit = 1):</p>
          <table class="mini"><tr><th>state</th><th>predicts</th><th>taken →</th><th>not taken →</th></tr>${[0, 1, 2, 3].map((c) => `<tr><td>${c.toString(2).padStart(2, '0')}</td><td>${c >= 2 ? 'taken' : 'not taken'}</td><td>${next(c, 1).toString(2).padStart(2, '0')}</td><td>${next(c, 0).toString(2).padStart(2, '0')}</td></tr>`).join('')}</table>
          <p>A new entry (hit = 0) is ${next(0, 1, 0).toString(2).padStart(2, '0')} for taken and ${next(0, 0, 0).toString(2).padStart(2, '0')} for not taken, whatever the old value.</p>`,
        pitfall: `<p>Thinking more bits always predict better. A branch that alternates taken / not-taken defeats any counter: between a strong and a weak state it is wrong half the time, and between the two weak states it is wrong every time. Patterns need history, not a longer counter.</p>`,
        real: `<p>Our BTB answers two questions with one entry: <em>whether</em> the branch is taken (the counter) and <em>where</em> it goes (the target). Real cores split them. A <strong>direction predictor</strong> is a large table of 2-bit
          counters with no targets or tags; a BTB holds only targets, and a <code>jal</code> needs no direction at all. <strong>gshare</strong> indexes the counters with PC ⊕ a <em>global history</em> register, the outcomes of the last
          n branches as a shift register, so one branch gets a counter per path that led to it: correlated branches (an <code>if</code> testing what an earlier one tested) and short loops with a fixed trip count become predictable. TAGE goes further
          with several tables over geometric history lengths. Our <code>mul</code>\'s inner branch follows the multiplier\'s bits: data no history can predict. A <strong>return-address stack</strong> handles <code>ret</code>: its target depends on
          the call site, so a BTB entry holding the last return address is wrong whenever a function is called from two places. Each call (<code>jal ra</code>) pushes PC + 4, each <code>ret</code> pops: nearly perfect, for a few entries of 32 bits.</p>`,
      },
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
        as much as the register file. With its checking logic the core grows by 38 %, from 64 881 to 89 712 NANDs without the
        program ROM: a large price for a period 19 % longer and a CPI 14 % lower.</p>
        <p>The period is the more instructive cost. A predictor is not on the critical path by itself: the BTB read happens in Fetch beside the instruction memory. The path that grew is the check, in Execute, that the guess
        was right, because it needs the branch's own outcome and target. Doing the two comparisons in parallel instead of in sequence is the general method: when a decision gates a check, compute the check for each possible decision
        and select afterwards.</p>`,
      scene: () => ({ root: BTB, inputs: {} }),
      tour: {
        beats: [
          { title: 'Empty table', reset: true, set: { pcF: 0x14 }, show: ['rdF'], expect: { predTaken: 0, predTarget: 0 },
            say: '<p>Fetch asks the BTB about the address {v:pcF} (0x14, the <code>bne</code> of <code>sum</code>). Nothing has been trained: predTaken = {v:predTaken}.</p>' },
          { title: 'Training', set: { pcE: 0x14, updE: 1, takenE: 1, targetE: 0x0c }, cycles: 1, show: ['dec', 'rdE'], expect: { predTaken: 1, predTarget: 0x0c },
            say: '<p>The branch reaches Execute and is taken to 0x0C. At the edge the entry for index 5 is written with the tag, the target and a counter that starts weakly taken. Fetch now sees predTaken = {v:predTaken} and predTarget = {v:predTarget}.</p>' },
          { title: 'Strengthen', cycles: 1, show: ['ctr'], expect: { predTaken: 1, predTarget: 0x0c },
            say: '<p>Another taken outcome moves the counter to strongly taken. The prediction is the same, but now it takes two misses to change it.</p>' },
          { title: 'Loop exit', set: { takenE: 0 }, cycles: 1, show: ['ctr'], expect: { predTaken: 1, predTarget: 0x0c },
            say: '<p>The loop exits: one not-taken. The counter drops to weakly taken and the BTB still predicts taken, predTaken = {v:predTaken}.</p>' },
          { title: 'Second miss', cycles: 1, show: ['ctr'], expect: { predTaken: 0, predTarget: 0x0c },
            say: '<p>A second not-taken in a row flips the prediction: predTaken = {v:predTaken}. The target is kept in the entry; only the direction changed.</p>' },
        ],
      },
      more: {
        derive: `<p>Prediction check, serial: select the correct PC with the branch decision, then compare it with the predicted target (87 NAND delays in the first version). Parallel: compare the predicted target with PC + imm and with rs1 + imm at once,
          and let the branch decision and the jalr bit pick which comparison counts afterwards (70). The period went from 59 to 70, the 19 % in the text; the BTB itself, ${fmt(nands(BTB))} NANDs for ${fmt(BTB_BITS)} bits of entries, is
          ${(nands(BTB) / BTB_BITS).toFixed(0)} NANDs a stored bit including its read ports and decoder.</p>`,
        pitfall: `<p>Counting the predictor\'s cost as its table. The table is ${fmt(nands(BTB))} NANDs, but the core grows by 38 %: the difference is the checking logic, the extra fetch muxing and the flush paths. When a speed-up is priced, price the whole change.</p>`,
        real: `<p>Predictors are among the larger structures of a modern front end and are built as SRAM, not flip-flops. Their cost is accepted because on deep pipelines a misprediction
          costs tens of cycles, not two.</p>`,
      },
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
        per flush, would gain more from the same predictor).</p>
        <p>Read the table column by column. Period comes from static timing of the netlist, CPI from running the programs on the gates, and time per instruction is their product. A design that wins in one column and loses in another is
        the usual case; the product is what a user sees. The same exercise on a different program mix, or a different memory, can reorder the rows.</p>`,
      more: {
        derive: `<p>Time per instruction = CPI × period. Prediction: 1.30 × 70 = ${(1.3 * 70).toFixed(0)} against 1.51 × 59 = ${(1.51 * 59).toFixed(0)} for the balanced pipeline without it: the "about a draw" of the text. A change wins if CPI falls by more than the period grows: here 1 − 1.30 / 1.51 = ${Math.round(100 * (1 - 1.3 / 1.51))} % against
          70 / 59 − 1 = ${Math.round(100 * (70 / 59 - 1))} %, slightly short of it on average.</p>`,
        pitfall: `<p>Taking one program\'s result as general. Prediction wins on fib and gcd, whose loop branches it learns, and loses on mul, whose inner branch follows the multiplier\'s bits. A mix with more loops pushes the average toward prediction,
          a mix with data-dependent branches away from it.</p>`,
        real: `<p>Benchmarks in industry are suites of many programs, weighted and averaged geometrically, for exactly this reason. A change that helps one program and hurts three is not an improvement.</p>`,
      },
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
