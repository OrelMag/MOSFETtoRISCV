import { FULL_ADDER } from '../lib/combinational';
import { BIST_PATTERNS, bistSignature } from '../lib/bist';
import { CONSENSUS, SCAN_DFF, scanCounter } from '../lib/dft';
import { DFF } from '../lib/sequential';
import { MUX2 } from '../lib/gates';
import { allVectors, detect, detectable, exactCover, faultModel, greedyCover, type FaultModel } from '../sim/faultsim';
import { MARCH_C_MINUS, ZEROS_ONES, marchCoverage, marchOps, marchText } from '../sim/march';
import { groupDigits } from '../sim/numfmt';
import { stats } from '../sim/stats';
import { cpuScene } from '../widgets/cpupanel';
import { atpgScene, bistScene, faultMatrixWidget, faultyAdderScene, testCostWidget } from '../widgets/dft';
import { coverageWidget, foundWidget, fuzzWidget, riscvTestsWidget, verifyMap } from '../widgets/verify';
import { FOUND, LAYERS } from '../verify/data';
import { FWD_FAULT, LOCKSTEP_SOURCE, withFault } from '../verify/planted';
import type { Chapter } from './types';
import { numOf } from './order';

const n0 = (n: number) => groupDigits(n);
const fm = faultModel(FULL_ADDER) as FaultModel;
const FA_FAULTS = fm.faults.length, FA_SITES = fm.sites.length;
const faDet = detect(fm, allVectors(fm));
/** The full adder's test sets: greedy and the smallest complete one (tests/verify-chapter.test.ts pins them). */
export const FA_GREEDY = greedyCover(faDet, FA_FAULTS).length, FA_SMALLEST = (exactCover(faDet, FA_FAULTS) ?? []).length;
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six'];
const word = (n: number) => WORDS[n] ?? String(n);
const cap = (t: string) => t[0].toUpperCase() + t.slice(1);
/** Who found the table's bugs, from FOUND: riscv-tests, random programs, Spike; and how many sat in the golden model. */
const foundBy = (re: RegExp) => FOUND.filter((x) => re.test(x.foundBy)).length;
export const FOUND_BY = { tests: foundBy(/^rv32|riscv-tests/), random: foundBy(/^random/), spike: foundBy(/^Spike/) };
const BY_TESTS = FOUND_BY.tests, BY_RANDOM = FOUND_BY.random, BY_SPIKE = FOUND_BY.spike;
const IN_MODEL = FOUND.filter((x) => /Golden model/.test(x.where)).length;
const cons = faultModel(CONSENSUS) as FaultModel;
const CONS_UNTESTABLE = cons.faults.length - detectable(detect(cons, allVectors(cons)), cons.faults.length).length;
const SDFF = stats(SCAN_DFF).nands, DFFN = stats(DFF).nands, MUXN = stats(MUX2).nands;
const MARCH = marchCoverage(MARCH_C_MINUS, 8), NAIVE = marchCoverage(ZEROS_ONES, 8);
const sumOf = (r: typeof MARCH) => Object.values(r).reduce((s, x) => s + x.found, 0);
const totalOf = (r: typeof MARCH) => Object.values(r).reduce((s, x) => s + x.total, 0);
const GOOD_SIG = bistSignature(4, BIST_PATTERNS);

/**
 * Measured on the gates, too slow to measure when the chapter loads; tests/verify-chapter.test.ts measures each again.
 * The pipelined CPU (pipelinedCpu): NANDs and flip-flops. The 4-bit ripple adder's stuck-at faults: count, the coverage of
 * 1, 2, 4, 8 and 16 random vectors (seed 7), the greedy and smallest complete test sets. The random-program run of the FP
 * pipeline with its old bug planted back: the failing seeds among the first 64, seed 3 shrunk. The rv32ui tests with
 * alu.slt stuck at 0. Coverage of the "Primer" sample and of 32 random programs. The self-test's escapes.
 */
export const VERIFY_FACTS = {
  pipeNands: 68_957, pipeFlipFlops: 2_676,
  rcaFaults: 90, rcaVectors: 512, rcaRandom: [40, 60, 76, 88, 90], rcaGreedy: 4, rcaSmallest: 3,
  fuzzFails64: [3, 15, 42], shrinkFrom: 111, shrinkTo: 4,
  rvTests: 32, sltFails: ['slt', 'slti'], sltCase: 4,
  primerInstrs: 13, primerEvents: 7, randomInstrs: 31, events: 7, rv32iWord: 31,
  bistEscapes: 1,
} as const;
const F = VERIFY_FACTS;

// autoClock off: the learner's Run produces the mismatch the step talks about, not a clock that ran before they arrived
const lockstepScene = () => ({ ...cpuScene({ source: LOCKSTEP_SOURCE, pipeline: true, wrap: (d) => withFault(d, FWD_FAULT), highlight: ['hz', 'fwdA'] }), autoClock: false });

export const chVerify: Chapter = {
  id: 'verify', num: numOf('verify'), title: 'How do you know it works?', level: 'Verification and test',
  blurb: 'Two questions every chip must answer: is the design right (the golden model in lock step, the official riscv-tests, random programs, coverage, a second oracle), and was this chip made right (stuck-at faults, fault coverage, test generation, scan chains, self-test).',
  goals: [
    'hold a CPU to a golden model instruction by instruction, and read the first mismatch as the place to look',
    'say what each kind of check proves and what it cannot: directed and self-checking tests, random programs, coverage, a second model',
    'model a manufacturing defect as a stuck-at fault, measure the fault coverage of a test set and find a small one that catches every fault',
    'make flip-flops testable with a scan chain, and let a block test itself with an LFSR and a signature register',
  ],
  builds: ['pipeline', 'traps', 'cache', 'float', 'registers', 'silicon'],
  recap: {
    keep: [
      'Verification asks whether the design is right; test asks whether one manufactured chip is the design. Each needs an oracle: something other than the circuit that says what the answer should be.',
      'Lock step compares the gates with the golden model at every retirement, so the first mismatch names the instruction. The riscv-tests check one instruction at a time against values someone else chose; random programs find interactions nobody wrote; coverage says what was never exercised; a second, independent model (Spike) checks the first.',
      `A defect is modelled as a stuck-at fault: one net reads 0 or 1 whatever drives it. The full adder has ${FA_FAULTS}; ${word(FA_SMALLEST)} well-chosen vectors catch them all, where random vectors leave a long tail. A fault no vector can show sits on redundant logic.`,
      `Scan puts a multiplexer in front of every flip-flop (${SDFF} NANDs against ${DFFN}), so a tester shifts a state in, clocks once and shifts the answer out: sequential logic is tested like combinational logic. BIST puts the pattern generator (an LFSR) and the answer compressor (a MISR) on the chip.`,
    ],
    practise: ['t_tests', 't_scan'],
    check: [
      {
        question: 'A pipelined CPU and its golden model agree on every final register after a random program. What has that shown?',
        options: ['That the CPU and the model agree on this program; both could share the same misreading of the specification', 'That the CPU implements RISC-V correctly', 'That every hazard combination has been exercised'],
        answer: 0,
        explain: 'An oracle written by the same people can be wrong the same way. That is why the official tests and an independent model (Spike) check the golden model too.',
        why: ['', 'Only as correctly as the model: a shared misreading passes every comparison.', 'Coverage says what happened; one program reaches a small part of the combinations.'],
      },
      {
        question: 'A test set reaches 100 % stuck-at fault coverage. What does it not catch?',
        options: ['Defects that are not stuck-at faults: a gate that is too slow, a short between two nets', 'Any defect at all', 'Nothing: 100 % means every defect'],
        answer: 0,
        explain: 'Coverage is measured against a model. A slow gate (a transition fault), a bridge between nets or a defect that only shows at speed needs other tests.',
        why: ['', 'It catches every defect that behaves like a stuck-at, which is most of them.', 'The percentage is of the modelled faults, not of every possible defect.'],
      },
      {
        question: 'Why does a scan chain make a sequential circuit easy to test?',
        options: ['The tester sets every flip-flop directly and reads every one back, so only the logic between them is left to test', 'It removes the flip-flops during test', 'It runs the circuit faster'],
        answer: 0,
        explain: 'With se = 1 the flip-flops form a shift register from scan-in to scan-out: any state can be loaded in n clocks and any state read out. What remains is combinational, and ATPG handles that.',
        why: ['', 'They stay: they become a shift register while se = 1.', 'Scan shifts are usually slower than the functional clock.'],
      },
    ],
  },
  steps: [
    {
      title: 'Two questions',
      body: `
        <p>Every circuit in this book is simulated, and every CPU runs programs. But how do you <em>know</em> one is right? There are two questions, asked by different people at different times.</p>
        <p><strong>Is the design right?</strong> That is <em>verification</em>, done before anything is made. Its tool is an <strong>oracle</strong>: something other than the circuit that says what the answer should be. Here the main oracle is the <strong>golden model</strong> (the instruction-set simulator every CPU panel runs beside the gates), and the official tests, and a second simulator written by others check that model in turn.</p>
        <p><strong>Was this chip made right?</strong> That is <em>test</em>, done on every die that comes off the wafer of chapter ${numOf('silicon')}. The design is known to be right; the question is whether a speck of dust shorted two wires on this one. The oracle is the design itself, and the hard part is reaching every gate from the few pins a tester touches.</p>
        <p>The table is every check this site's CPUs go through, ${LAYERS.length} rungs. Read the last two columns: each rung finds what the one before it cannot, and none of them alone is enough.</p>`,
      widget: () => verifyMap(),
      more: {
        real: `<p>A modern processor team spends more engineers on verification than on design. Simulation is joined by formal methods (proving a property for every input, not testing some), emulation on FPGAs (the design running a million times faster than a simulator, fast enough to boot an operating system before tape-out) and post-silicon validation on the first chips.</p>`,
        pitfall: `<p>Mixing the two questions up. A chip that fails a manufacturing test was made wrong; a design bug is on every chip, passes every manufacturing test (the tester compares with the design, bug included) and is found by verification or, too late, by customers.</p>`,
      },
    },
    {
      title: 'The golden model in lock step',
      body: `
        <p>The <span data-show="hz">hazard unit</span> of this pipeline has one planted defect: the high bit of <code>forwardA</code> is stuck at 0, so <span data-show="fwdA">forward A</span> never takes the result waiting in M. The drawing is the healthy CPU; the simulation has the defect.</p>
        <p>The CPU panel runs the golden model beside the gates. Each time an instruction retires, the model executes the same instruction and compares the PC and every register, and after a store the memory word. The program is four instructions: <code>add x6, x5, x5</code> needs x5 from the instruction just ahead of it, which is in M when the add is in E.</p>
        <div class="try">Press Run. The panel stops at the first mismatch: after <code>add t1, t0, t0</code> the gates hold 7, the model 14. Forward B still works, so the sum is the stale 0 from the register file plus the forwarded 7.</div>
        <p>Comparing only the final state would report "x7 is wrong" with no hint where. Comparing at every retirement names the instruction, the cycle and the register: the search starts in the right place, and Why? on <code>fwdA</code>'s select does the rest.</p>`,
      scene: lockstepScene,
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['pc', 'imem'], expect: { pcF: 0 },
            say: '<p>The first instruction, <code>addi x5, x0, 7</code>, is fetched. Nothing is wrong yet: the fault only matters when forward A should take a value from M.</p>' },
          { title: 'The add in E', cycles: 3, show: ['hz', 'fwdA', 'DE', 'EM'], expect: { pcF: 12 },
            say: '<p>The add is in E and the addi in M with x5 = 7. The hazard unit asks forward A for M (10), but its high bit is stuck at 0: forward A takes the register file\'s stale 0. Forward B takes 7.</p>' },
          { title: 'The mismatch', cycles: 2, show: ['MW', 'rf'], expect: { pcW: 4, validW: 1 },
            say: '<p>The add reaches W. When it retires the model executes it too, and the two disagree on t1: 7 against 14. The panel names that instruction.</p>' },
        ],
      },
      more: {
        derive: `<p>Why at every retirement and not every cycle: a pipeline holds five instructions at once, and only a retired one has changed the architectural state the model knows about. A CPU that retires several a cycle (the dual-issue and out-of-order cores) reports how many, and the model steps that many times before the comparison.</p>`,
        pitfall: `<p>Comparing at the end only, or only the registers. A store to the wrong address leaves the registers right; a wrong value later overwritten leaves the final state right. Compare everything the instruction changes, as soon as it retires.</p>`,
      },
    },
    {
      title: 'Who checks the checker? riscv-tests',
      body: `
        <p>The golden model and the CPUs were written by the same author. A misreading of the specification shared by both passes every lock-step comparison. The cure is an oracle from someone else: the <strong>riscv-tests</strong>, assembly programs written by the RISC-V community, one per instruction.</p>
        <p>Each test is <em>self-checking</em>: a series of cases, each computing a result and comparing it with the value the specification gives. On the first difference it writes <code>(case &lt;&lt; 1) | 1</code> to a word called <code>tohost</code>; after the last case it writes 1. Nothing else is needed to judge it, so the same image checks the golden model and every CPU.</p>
        <p>The panel runs the ${F.rvTests} tests a word-access RV32I CPU can run on the gate-level pipeline, 32 at once (one per lane of the bit-parallel simulator). Then pick the CPU with <code>alu.slt</code> stuck at 0: only ${F.sltFails.join(' and ')} fail, both at case ${F.sltCase}, the first case whose answer is 1.</p>`,
      widget: () => riscvTestsWidget(),
      more: {
        real: `<p>Here they found two bugs in the golden model itself: the shift-immediate instructions accepted a bit that RV32 must reject, and three mandatory read-only CSRs were missing (both are in the table of "A second oracle"). Commercial teams buy or write compliance suites in the thousands; the RISC-V architecture tests are the official ones.</p>`,
        pitfall: `<p>Reading "all tests pass" as "correct". A self-checking test checks one instruction with values someone chose. It says nothing about two instructions meeting in a pipeline, which is where most of a pipeline's bugs live.</p>`,
      },
    },
    {
      title: 'Random programs',
      body: `
        <p>A pipeline's bugs live where instructions meet: a forward from M while a load stalls, a taken branch while an FP divide holds D. Nobody writes a test for every pair. A <strong>random program</strong> generator draws programs nobody wrote, weighted towards those meetings: sources taken from the last few destinations, branches right after loads, edge values like 0, −1 and the most negative number. Each runs on the golden model to its halt and on the gates, and the final state is compared.</p>
        <p>This site found one this way in the six-stage FP pipeline: a taken branch in E while D waited on an FP interlock lost its target, because the stall held the PC the branch had to load. The fix made the PC's enable "not stalled, or taken". Here it is planted back: that OR gate's taken input reads 0, exactly the old circuit.</p>
        <div class="try">Run a few batches. Of the first 64 seeds, ${F.fuzzFails64.length} fail (${F.fuzzFails64.join(', ')}). Click one: replayed alone in lock step, the CPU retires an instruction the model never reaches. Control flow went astray.</div>
        <p>The rate is the lesson: here about one program in twenty meets the bug (the table's run, on other seeds, met it in 5 of 256), and each draws only a few dozen instructions. Run enough of them and rare meetings become certain. CI runs 32 seeds per CPU on every change and a new range every night.</p>`,
      widget: () => fuzzWidget(),
      more: {
        derive: `<p>If each program meets a bug with probability p, n programs miss it with probability (1 − p)<sup>n</sup>. At p = ${F.fuzzFails64.length}/64 that is ${((1 - F.fuzzFails64.length / 64) ** 32 * 100).toFixed(0)} % for one batch of 32, and ${((1 - F.fuzzFails64.length / 64) ** 256 * 100).toFixed(4)} % for 256.</p>`,
        pitfall: `<p>Random programs inherit the golden model's mistakes: they compare against it. They find the CPU's bugs, not the model's. And a generator that never draws an instruction never tests it: the next step but one measures that.</p>`,
      },
    },
    {
      title: 'Make it small',
      body: `
        <p>A failing random program is ${F.shrinkFrom} instructions of noise around a handful that matter. <strong>Delta debugging</strong> finds the handful: delete half the instructions and keep the deletion if the program still fails, then quarters, and so on down to single instructions, until nothing more can go.</p>
        <p>Each candidate must still assemble, still halt on the golden model and still fail on the gates. The panel runs 32 candidates at once, one per lane. Seed 3 shrinks from ${F.shrinkFrom} instructions to ${F.shrinkTo}: an FP convert, a taken branch, an FP square root that waits on it, one more instruction. That is the bug's recipe, readable at a glance.</p>
        <p>The small program becomes the regression test that comes first in every fix: it fails before the fix and passes after, and stays in the test suite so the bug cannot quietly come back.</p>`,
      widget: () => fuzzWidget({ shrinkSeed: 3 }),
      more: {
        real: `<p>Andreas Zeller's ddmin (1999) is the algorithm; property-based testing libraries call it shrinking and do it by default. Compilers are tested the same way: random programs (Csmith) find a crash, and a reducer (C-Reduce) cuts the program to a few lines before anyone reads it.</p>`,
      },
    },
    {
      title: 'Coverage: what did the tests reach?',
      body: `
        <p>A passing test suite says nothing about what it never touched. <strong>Coverage</strong> counts what was exercised: here, which RV32I instructions the golden model executed, and which pipeline events the gates' own hazard unit produced (each forwarding path, the write-back bypass, the load-use stall, the flush after a taken branch).</p>
        <p>Pick the sample programs one by one. The "Primer" program produces all ${F.primerEvents} events but uses only ${F.primerInstrs} of the ${F.rv32iWord} instructions; most samples reach far less. 32 random programs reach all ${F.randomInstrs} instructions and every event, hundreds of times.</p>
        <p>Coverage finds gaps; it cannot prove there are none. Every forwarding path firing is not every pair of hazards meeting: the planted bug of "Random programs" needs a taken branch <em>while</em> an FP interlock stalls D, a combination an event count does not see.</p>`,
      widget: () => coverageWidget(),
      more: {
        pitfall: `<p>Treating 100 % as done. Coverage counts what happened, not what mattered. The bug of "Random programs" was found after every instruction and every event was already covered.</p>`,
        real: `<p>Industrial verification writes coverage points for the combinations that matter (cross coverage: this hazard in this stage while that one holds) and drives random tests at the ones still missing. Reaching every point is the sign-off criterion for a block.</p>`,
      },
    },
    {
      title: 'A second oracle',
      body: `
        <p>Every check so far trusts the golden model. Who checks it? <strong>Spike</strong>, the RISC-V reference simulator, written by others. CI runs random programs on both and compares them commit by commit: every instruction's PC, register write and memory access. A difference is a bug in one of the two.</p>
        <p>That is how the last bug in the table was found. Spike's <code>mret</code> writes the CSR <code>mstatush</code>; our model did not have it, so reading it trapped as illegal. The CPU agreed with our model, so no lock-step comparison could ever have seen it.</p>
        <p>The table is everything the checks of this chapter found in this site's code, ${FOUND.length} bugs, and which check found each. ${cap(word(IN_MODEL))} sat in the golden model, which every other check trusts. riscv-tests found ${word(BY_TESTS)}, random programs ${word(BY_RANDOM)} and Spike ${word(BY_SPIKE)}: each of the other two found a bug that every riscv-test had passed.</p>
        <p>The last rung is the Verilog export: Yosys synthesizes the exported CPUs and every output of the resulting netlist is compared with this site's simulation, every cycle, before each deploy.</p>`,
      widget: () => foundWidget(),
      more: {
        pitfall: `<p>Two models agreeing is evidence, not proof: they might share a misreading of an ambiguous sentence in the specification. The official tests and a formal model of the ISA (the RISC-V Sail model) are further oracles; each one added makes a shared mistake less likely.</p>`,
      },
    },
    {
      title: 'A chip comes back from the fab',
      body: `
        <p>Now the second question. The design is right; this die came off a wafer where a particle may have landed. Chapter ${numOf('silicon')} priced that: at 0.1 defects per cm², a 100 mm² die is bad one time in ten. Each die must be tested before it is packaged and sold, and the tester only touches its pins.</p>
        <p>Defects are opens, shorts and bad transistors, too many kinds to test one by one. The <strong>stuck-at fault model</strong> stands for most of them: one net reads 0, or 1, whatever drives it. A short to ground is a stuck-at-0; a gate whose pull-down never conducts is a stuck-at-1 on its output. The full adder has ${FA_SITES} nets (its 3 inputs and its 9 NANDs' outputs), so ${FA_FAULTS} stuck-at faults.</p>
        <div class="try">Plant a fault from the panel and watch the truth table: the rows in red are the input vectors that show this defect at s or cout. A tester applies vectors and compares the outputs; any red row rejects the die.</div>
        <p>The wire of a stuck net still shows what its gate drives (the gate is fine; its output is shorted downstream), while every gate reading it sees the stuck value.</p>`,
      scene: faultyAdderScene,
      more: {
        real: `<p>Real test also uses other models: transition faults (a gate too slow, caught only at speed: launch a change, capture one clock later), bridging faults between neighbouring wires, and IDDQ testing (a CMOS chip at rest draws almost no current; a short makes it draw milliamperes).</p>`,
        pitfall: `<p>Testing the function instead of the structure. "The adder adds 2 + 3 correctly" checks one vector. Whether it catches a defect depends on whether that vector sensitizes the defective net to an output, which is what the next step counts.</p>`,
      },
    },
    {
      title: 'Fault coverage',
      body: `
        <p>A vector <em>detects</em> a fault when the faulty circuit's outputs differ from the good one's on it. <strong>Fault coverage</strong> is the share of modelled faults a test set detects. The matrix runs all ${FA_FAULTS} faults against all 8 vectors: a <em>fault simulator</em>, here bit-parallel, 32 vectors per pass.</p>
        <div class="try">Click vectors into a test set and reach ${FA_FAULTS} / ${FA_FAULTS} with as few as you can. Greedy (always the vector that catches the most faults not yet caught) needs ${word(FA_GREEDY)}; ${word(FA_SMALLEST)} are enough.</div>
        <p>The 4-bit ripple adder has 9 inputs, so ${n0(F.rcaVectors)} vectors, and ${F.rcaFaults} faults. Random vectors catch ${F.rcaRandom.join(', ')} of them after 1, 2, 4, 8 and 16 vectors: fast at first, then a long tail, because the last faults are each shown by few vectors. Chosen well, ${F.rcaSmallest} vectors of the ${n0(F.rcaVectors)} catch all ${F.rcaFaults}.</p>
        <p>On a real chip with millions of faults the tail is what costs: random patterns reach most of the coverage cheaply, and deterministic vectors aimed at the remaining faults reach the rest.</p>`,
      widget: () => faultMatrixWidget(),
      more: {
        derive: `<p>Why three vectors are enough for the full adder and greedy takes four: greedy grabs the vector catching the most faults first, which overlaps the others' catches. The smallest set is a set-cover problem, NP-hard in general; the widget solves it exactly by branch and bound, which is cheap for 8 vectors and takes most of a second for the adder's ${n0(F.rcaVectors)}.</p>`,
        numbers: `<p>Fault collapsing: faults that every vector detects together are equivalent, and a tool keeps one of each class. The stem faults here (each net's whole fan-out stuck) leave out branch faults (one reader's copy of a net), which a full checkpoint list adds.</p>`,
      },
    },
    {
      title: 'ATPG in miniature',
      body: `
        <p>How do you find a vector for one particular fault without trying them all? <strong>Automatic test pattern generation</strong> reasons backwards from the fault, in three moves:</p>
        <p><strong>Activate</strong>: drive the faulty net to the opposite of its stuck value, so the good circuit and the faulty one differ there. <strong>Propagate</strong>: carry the difference to an output through gates whose other inputs let a change pass, which for a NAND means 1. <strong>Justify</strong>: trace each requirement back through the gates to an input (a NAND's 0 needs every input at 1, its 1 needs any input at 0), and set it. If an assignment makes a requirement impossible, back up and try the other value.</p>
        <div class="try">Step through the search for g5 stuck at 0, then pick other faults. The panel sets the inputs on the circuit as the search does and lights the gate it is working on.</div>
        <p>The consensus circuit shows the other answer: y = a·b + ¬a·c with the term b·c built as well. That term never decides y, so its NAND stuck at 1 changes nothing any vector can see. The search tries every choice and proves it: ${CONS_UNTESTABLE} untestable fault. An untestable fault sits on <em>redundant</em> logic, logic the circuit did not need.</p>`,
      scene: atpgScene,
      more: {
        real: `<p>This is PODEM (Goel, 1981): search only over input assignments, simulate forward after each one. Production ATPG adds fault simulation (each new vector is checked against every remaining fault, dropping all it happens to catch), compaction of vectors, and SAT solvers for the hard faults; a large SoC needs tens of thousands of patterns for 99 % coverage.</p>`,
        pitfall: `<p>Reading "untestable" as "harmless". It means the fault cannot change the outputs; the redundant gate still costs area and power, and a second fault can make the first one visible. Synthesis removes redundancy where it can.</p>`,
      },
    },
    {
      title: 'Scan chains',
      body: `
        <p>A fault inside a counter is hard to reach: to put the counter in state 6 the tester must count to it, and a fault's effect shows at the outputs only cycles later. A CPU has thousands of flip-flops; testing through its pins alone is hopeless.</p>
        <p>A <strong>scan flip-flop</strong> puts a 2:1 multiplexer in front of the D input: ${MUXN} NANDs, so ${SDFF} instead of the D flip-flop's ${DFFN}. With scan enable <code>se</code> = 0 it is the ordinary flip-flop. With se = 1 it takes <code>si</code> instead, and the flip-flops of the chip, chained q to si, form one long shift register from a scan-in pin to a scan-out pin.</p>
        <p>A test is then three moves: <strong>shift</strong> a state in (one clock per flip-flop), <strong>capture</strong> one normal clock with se = 0, and <strong>shift</strong> the answer out while the next state shifts in. Every flip-flop is now an input and an output the tester controls, and only the logic between flip-flops is left to test, with the combinational methods of the last two steps.</p>
        <div class="try">Load 0110 into the <span data-show="reg">register</span> through si (four clocks with se = 1, q3's bit first), capture once with se = 0 so the <span data-show="inc">incrementer</span> makes it 0111, then shift the answer out at so.</div>`,
      scene: () => ({ root: scanCounter(4), inputs: { si: 0, se: 1, clk: 0 }, autoClock: false }),
      tour: {
        label: 'Shift, capture, shift',
        beats: [
          { title: 'Clear', reset: true, set: { se: 1, si: 0 }, cycles: 4, show: ['reg'], expect: { q: 0 },
            say: '<p>With se = 1 the register is a shift register: four clocks of si = 0 clear it, whatever it held.</p>' },
          { title: 'Shift in 0110', set: { si: 0 }, cycles: 1, show: ['reg'], expect: { q: 0 },
            say: '<p>The first bit in ends up in q3, so the state goes in most significant bit first: 0 …</p>' },
          { set: { si: 1 }, cycles: 1, expect: { q: 1 }, say: '<p>… 1 …</p>' },
          { set: { si: 1 }, cycles: 1, expect: { q: 3 }, say: '<p>… 1 …</p>' },
          { set: { si: 0 }, cycles: 1, expect: { q: 6 }, say: '<p>… 0: the register holds 6 (0110), set from one pin in four clocks.</p>' },
          { title: 'Capture', set: { se: 0 }, cycles: 1, show: ['inc', 'reg'], expect: { q: 7 },
            say: '<p>One clock with se = 0: the counter does its job once and the incrementer\'s answer, 7, is captured.</p>' },
          { title: 'Shift out', set: { se: 1, si: 0 }, cycles: 1, show: ['reg'], expect: { q: 14, so: 1 },
            say: '<p>Back to se = 1: q3 was the first bit out at so (0); the next ones are 1, 1, 1. A tester compares them with 0111, and shifts the next test state in at the same time.</p>' },
        ],
      },
      challenge: {
        kind: 'reach', goal: 'Put the counter in state 9 using only si and se (and the clock).',
        check: (s) => s.value('q') === 9,
        hints: ['With se = 1 every clock shifts si into bit 0 and moves every bit up.', 'Nine is 1001: shift in 1, 0, 0, 1, most significant bit first.'],
        answer: 'Set se = 1, then clock four times with si = 1, 0, 0, 1. Bit 0 takes si at each edge and every bit moves up one, so the first bit shifted in ends in bit 3.',
        solve: (s) => { for (const b of [1, 0, 0, 1]) { s.setInputs({ se: 1, si: b }); s.pulse(); } },
      },
      more: {
        derive: `<p>Test time: with one chain of n flip-flops, each pattern costs n shift clocks and one capture, and the shift-out of one pattern overlaps the shift-in of the next. p patterns take p·(n + 1) + n clocks. Split the flip-flops into k chains (2k pins) and every pattern shifts k times faster.</p>`,
        pitfall: `<p>Forgetting that scan is a second clocking mode. The scan path between two flip-flops is just a wire, so it is short: a hold-time problem if the clock reaches the next flip-flop late. Scan insertion orders the chain by placement and adds delay where needed.</p>`,
      },
    },
    {
      title: 'The chip tests itself',
      body: `
        <p>A tester is expensive, and its pins are slow next to the chip's own clock. <strong>Built-in self-test</strong> puts the tester on the die. An LFSR (the linear-feedback shift register of chapter ${numOf('registers')}) generates a new pseudo-random pattern every clock, and a <strong>multiple-input signature register</strong> (MISR) folds every answer into one word: an LFSR with the answer XORed into its state each clock. At the end, one comparison with the good signature passes or fails the block.</p>
        <p>Here a 9-bit LFSR drives the 4-bit adder's 9 inputs and a 5-bit MISR folds its sums. After ${BIST_PATTERNS} clocks the good signature is ${GOOD_SIG}. The ${BIST_PATTERNS} patterns cover all ${F.rcaFaults} stuck-at faults, but ${F.bistEscapes} of them still escapes: its wrong sums happen to fold into the same signature. A 5-bit signature has 32 values, so roughly one wrong stream in 32 aliases; real MISRs are 32 bits or more.</p>
        <div class="try">Press Self-test on the good die, then plant faults. One of them is marked "escapes": the adder is wrong, the signature is right.</div>
        <p>Memories get their own self-test, because their faults are about cells and their neighbours. <strong>March C−</strong>, ${marchText(MARCH_C_MINUS)}, takes ${marchOps(MARCH_C_MINUS, 8)} operations on an 8-word memory and finds all ${sumOf(MARCH)} single faults of four kinds (stuck cells, transitions, coupling between cells, decoder faults). Writing and reading back all zeros and then all ones finds ${sumOf(NAIVE)} of the ${totalOf(NAIVE)}: no decoder fault at all, and ${NAIVE.coupling.found} of ${NAIVE.coupling.total} couplings.</p>`,
      scene: bistScene,
      more: {
        real: `<p>Every large memory on a modern chip has a BIST controller running a March test, and most have spare rows and columns: a failing row is mapped out by fuses at test time, which is how a 100-billion-transistor chip yields at all. Logic BIST is used where the chip must test itself in the field: a car's controllers run it at every start.</p>`,
      },
    },
    {
      title: 'What a CPU costs to test',
      body: `
        <p>Put it together on the pipelined CPU of chapter ${numOf('pipeline')}: ${n0(F.pipeFlipFlops)} flip-flops (the register file and the data memory are flip-flops here), ${n0(F.pipeNands)} NANDs. Full scan gives each flip-flop a multiplexer: ${n0(F.pipeFlipFlops * MUXN)} NANDs more, ${((100 * F.pipeFlipFlops * MUXN) / F.pipeNands).toFixed(1)} % of the CPU.</p>
        <p>Then time. On one chain, every pattern shifts ${n0(F.pipeFlipFlops)} clocks. Split into chains and the time falls in proportion, at two pins a chain. Move the sliders: a few thousand patterns on eight chains at 50 MHz take milliseconds per die, and the tester's time is paid for every die, good or bad.</p>
        <p>That is why test is part of the design (<em>design for test</em>): scan, BIST and spare memory rows are decided with the rest of the chip, and the cost of testing is weighed against the cost of shipping a bad chip, which is far higher once it is in a product. Later chapters build vector units, GPUs, memories and networks; every one of them is tested this way.</p>`,
      widget: () => testCostWidget(),
      more: {
        real: `<p>Real chips do not scan their large memories (BIST does) and compress scan data: a decompressor on the chip expands a few tester channels into hundreds of internal chains, and a compactor folds the answers back. JTAG (IEEE 1149.1, 1990) gives every chip a standard four-wire test port, used to test the board's wiring between chips and, today, to debug the software on them.</p>`,
        pitfall: `<p>Calling 99 % stuck-at coverage enough. At a million faults, 1 % is ten thousand untested places; and a die can pass every stuck-at test and still fail at speed. Production test adds transition-fault patterns, run at the functional clock.</p>`,
      },
    },
  ],
};
