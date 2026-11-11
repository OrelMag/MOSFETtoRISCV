// Chapter "Designing state machines": the method (sentence → diagram → codes → tables → logic), Moore against Mealy,
// the cost of the state codes, unused codes and reset, reading a circuit back into its diagram, a controller driving a
// datapath, inputs from outside the clock, and a machine of your own. The machines are lib/fsmbook.ts's, built the way
// the sandbox's state-machine chip builds them (editor/fsmchip.ts), so every count and every picture is computed.

import {
  candidateCircuit, CANDIDATES, codeCosts, debounceBits, ENCODING_NAMES, flipState, fsmCircuit, fsmSpecOf, fsmTableChip, gcdCircuit, gcdCosts, gcdRun, gcdSpec, kmapHtml, MEALY101, MOORE101,
  mooreMealy, RING3, ringCircuit, runFsm, runPair, TRAFFIC, upset,
} from '../lib/fsmbook';
import { BUTTON3, debouncer, debounceSamples } from '../lib/debounce';
import { equation } from '../editor/ttable';
import { nextTable, outTable } from '../editor/fsmchip';
import type { FsmDoc } from '../editor/model';
import { stats } from '../sim/stats';
import { fsmPanel } from '../widgets/fsmpanel';
import { codePanel, encodingPanel, readbackPanel } from '../widgets/fsmbook';
import type { Scene, Stage } from '../view/stage';
import type { Chapter, Step } from './types';
import { numOf } from './order';

type Encoding = FsmDoc['encoding'];
const nands = (d: Parameters<typeof stats>[0]): number => stats(d).nands;

// ---- numbers, all computed -----------------------------------------------------------------------------------------------

const COST = codeCosts();
const [BIN, GRAY, HOT] = COST.mealy;
const [MBIN, MGRAY, MHOT] = COST.moore;
const GCD = gcdRun(48, 18);
const GCD_COST = gcdCosts();
const RING_FREE = nands(ringCircuit(false)), RING_SAFE = nands(ringCircuit(true));
const eqs = (doc: FsmDoc, enc: Encoding, which: 'next' | 'out'): string[] => {
  const t = (which === 'next' ? nextTable : outTable)(doc, enc);
  return t.outs.map((_, j) => equation(t, j));
};
const ys = (def: Parameters<typeof runFsm>[0], xs: number[]) => runFsm(def, xs).join(' ');
const SEQ = [1, 0, 1, 0, 1];
const PAIR = runPair([1, 0, 1, 0, 1, 1, 0]);
const CAND = (k: string) => ys(candidateCircuit(k), SEQ);
const BOUNCE_SAMPLES = 5;
const N_DEB = debounceBits(BOUNCE_SAMPLES);

// ---- scenes -------------------------------------------------------------------------------------------------------------

const SPEC_MEALY = fsmSpecOf(MEALY101);
const SPEC_MOORE = fsmSpecOf(MOORE101);
const RIB = [{ label: 'x', path: 'x' }, { label: 'state', path: 'state' }, { label: 'y', path: 'y' }];

const detectorScene = (): Scene => ({
  root: fsmCircuit('mealy', MEALY101, 'Mealy'), inputs: { x: 1, rst: 0, clk: 0 }, autoClock: false,
  panels: [fsmPanel(SPEC_MEALY, { ribbon: RIB })],
});

const pairScene = (): Scene => ({
  root: mooreMealy(), inputs: { x: 1, rst: 0, clk: 0 }, autoClock: false,
  panels: [
    fsmPanel(SPEC_MEALY, { state: SPEC_MEALY.stateBits.map((p) => `mealy.${p}`), ribbon: [{ label: 'x', path: 'x' }, { label: 'Mealy y', path: 'ymealy' }, { label: 'Moore y', path: 'ymoore' }] }, 'Mealy: three states'),
    fsmPanel(SPEC_MOORE, { state: SPEC_MOORE.stateBits.map((p) => `moore.${p}`), ribbon: [{ label: 'state', path: 'state' }, { label: 'Moore y', path: 'ymoore' }] }, 'Moore: four states'),
  ],
});

function encScene(enc: Encoding): Scene {
  const doc = { ...MEALY101, encoding: enc };
  return {
    root: fsmCircuit('mealy', doc, 'Mealy'), inputs: { x: 0, rst: 0, clk: 0 }, autoClock: false,
    panels: [encodingPanel(MEALY101, enc, (stage: Stage, e: Encoding) => stage.load(encScene(e)))],
  };
}

const tableScene = (): Scene => ({ root: fsmTableChip('mealy', MEALY101, 'next'), inputs: { s1: 0, s0: 0, x: 0 } });

function ringScene(safe: boolean): Scene {
  const doc = safe ? { ...RING3, safe: true as const } : RING3;
  const spec = fsmSpecOf(doc);
  return {
    root: ringCircuit(safe), inputs: { go: 1, rst: 1, clk: 0 }, autoClock: false,
    panels: [codePanel(spec, { ribbon: [{ label: 'go', path: 'go' }, { label: 'state', path: 'state' }] }, safe ? 'Unused codes go to reset' : 'Unused codes left as don\'t cares')],
  };
}

const SPEC_TARGET = fsmSpecOf(MEALY101, true);
function candScene(key: string): Scene {
  return { root: candidateCircuit(key), inputs: { x: 0, rst: 0, clk: 0 }, autoClock: false, panels: [readbackPanel(SPEC_TARGET, 'Read back, over the diagram it should be')] };
}
const RIGHT = CANDIDATES.find((c) => c.right)!;

const GCD_BIND = {
  inputs: { start: 'start', st0: 'ctl.st0', st1: 'ctl.st1', rst: 'rst' },
  ribbon: [{ label: 'state', path: 'state' }, { label: 'a', path: 'r_a.q' }, { label: 'b', path: 'r_b.q' }, { label: 'done', path: 'done' }],
};
const gcdScene = (): Scene => ({
  root: gcdCircuit(), inputs: { start: 0, x: 48, y: 18, rst: 0, clk: 0 }, autoClock: false,
  panels: [fsmPanel(gcdSpec(), GCD_BIND, 'Controller')],
});

const buttonScene = (): Scene => ({ root: BUTTON3, inputs: { raw: 0, clk: 0 }, analyzer: true, autoClock: false });
/** A press that bounces for BOUNCE_SAMPLES samples, then holds. */
const BOUNCY = [1, 0, 1, 1, 0, 1, ...Array(debounceSamples(3) + 3).fill(1)];
const SMOOTH = Array(debounceSamples(3) + 3).fill(1);
function press(raws: number[]) {
  return (st: Stage) => { for (const raw of raws) { st.setInputs({ raw }); st.runCycles(1); } };
}

const trafficScene = (): Scene => ({
  root: fsmCircuit('traffic', TRAFFIC, 'Traffic'), inputs: { car: 0, rst: 0, clk: 0 }, autoClock: false,
  panels: [fsmPanel(fsmSpecOf(TRAFFIC), { ribbon: [{ label: 'car', path: 'car' }, { label: 'state', path: 'state' }] }, 'Traffic light')],
});

const nextT = nextTable(MEALY101), outT = outTable(MEALY101);
const rowsOf = (t: ReturnType<typeof nextTable>): string => t.rows[0].split('').map((_, r) => {
  const ins = t.ins.map((_, i) => (r >> (t.ins.length - 1 - i)) & 1);
  return `<tr>${ins.map((v) => `<td>${v}</td>`).join('')}${t.rows.map((row) => `<td class="${row[r] === '1' ? 'km one' : ''}">${row[r] === '-' ? '–' : row[r]}</td>`).join('')}</tr>`;
}).join('');
const tableHtml = (t: ReturnType<typeof nextTable>): string =>
  `<table class="cmp fsm-tt"><thead><tr>${t.ins.map((n) => `<th>${n}</th>`).join('')}${t.outs.map((n) => `<th>${n}</th>`).join('')}</tr></thead><tbody>${rowsOf(t)}</tbody></table>`;

const steps: Step[] = [
  // 1 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'From a sentence to a diagram',
    body: `
      <p>Every state machine starts as a sentence. Ours: <em>"raise y on the input that completes 1, 0, 1"</em>, one bit of x per clock edge. The sentence hides the real design question: what must the
      circuit remember? Not every input it has seen, which would need an unbounded memory, only how much of the pattern is still alive.</p>
      <ol>
        <li><strong>States are what you must remember.</strong> After each input, find the longest end of the input so far that is the start of 1, 0, 1. Nothing of it: <strong>S0</strong>. A 1: <strong>S1</strong>. A 1, 0: <strong>S2</strong>. Two inputs that leave you in the same state have the same future, so one state serves both.</li>
        <li><strong>One arc per input value out of each state.</strong> From S2 a 0 kills the pattern (S0); a 1 completes it, and that same 1 is also the first 1 of the next pattern, so it goes to S1, not S0. Overlaps are decided here.</li>
        <li><strong>Say where the output is 1.</strong> On the S2 → S1 arc: <code>1 / 1</code> reads "input 1, output 1". An output on an arc is a <em>Mealy</em> output; step 2 moves it into a state.</li>
        <li><strong>Number the states</strong> and write the logic (steps 3 and 4), <strong>decide what happens to codes no state has</strong> (step 5) and <strong>check the circuit against the diagram</strong> (step 6).</li>
      </ol>
      <p>The circuit is exactly that diagram built: the state lives in <span data-show="s0 s1">${BIN.dffs} flip-flops</span>, the <span data-show="next">next-state logic</span> computes the arc the next edge takes from the state and x, the
      <span data-show="out">output logic</span> raises y, and <span data-show="inv_rst g0 g1">a gate per bit</span> forces the reset state when rst = 1. All of it is ${nands(fsmCircuit('mealy', MEALY101))} NANDs, built from the diagram by the sandbox's state-machine chip
      (<a href="#/sandbox/new/fsm">open it there</a> and edit the diagram: the circuit follows).</p>
      <p>Chapter ${numOf('registers')}'s <a href="#/c/registers/10">State machines</a> step is the quick version of this; this chapter is the method, with the choices and their costs.</p>
      <div class="try">Set x = 1, Pulse; x = 0, Pulse; then set x = 1: the dashed arc is the one the next edge takes, and y rises before that edge.</div>`,
    more: {
      derive: `<p>The test for two histories being one state: is there any future input for which they give different outputs? "1" and "0, 1" are both S1, because whatever follows, the detector answers the same. "1, 0" is different:
        a 1 now raises y, after "1" it does not. A machine with one state per equivalence class is the smallest that does the job; a pattern of n bits needs n states here (S0 … S${SPEC_MEALY.states.length - 1} for 1, 0, 1).</p>
        <p>The run of 1, 0, 1, 0, 1 shows the overlap: S0 → S1 → S2 → S1 (y = 1) → S2 → S1 (y = 1). Two matches in five inputs, sharing a 1.</p>`,
      real: `<p>The same idea is how a lexer finds a keyword and how a network card finds a frame delimiter: a state per "how much of the pattern is alive", an arc per input symbol. Regular expressions are state machines; the compiler that turns one
        into a table is doing steps 1 and 2 for you.</p>`,
      pitfall: `<p>Remembering too much (a state per input history: the number doubles with every input) or too little (S1 and S2 merged: "1" and "1, 0" give different answers to a 1, so they cannot share a state). The overlap arc is the usual slip:
        S2 on a 1 going to S0 misses every second match in 1, 0, 1, 0, 1. Step 6 reads a circuit back to catch exactly that.</p>`,
    },
    scene: detectorScene,
    tries: [(st) => st.value('y') === 1],
  },
  // 2 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'Moore or Mealy: one cycle apart',
    body: `
      <p>The detector above is a <strong>Mealy</strong> machine: its output is a function of the state <em>and the input</em>. y rises as soon as x is 1 in S2, before the edge, the same cycle the last 1 arrives.</p>
      <p>A <strong>Moore</strong> machine's output is a function of the state alone. To report the pattern it needs a state that means "just saw 1, 0, 1": <strong>S3</strong>, entered on the edge that takes in the last 1, where y = 1. The detection comes
      <em>one cycle later</em>, and it costs a state (and a flip-flop's worth of code: both versions fit two flip-flops here, ${MBIN.nands} NANDs against ${BIN.nands}).</p>
      <p>Both circuits are on the stage, on one x. Feed them 1, 0, 1: Mealy's y is 1 in the cycle that ends with the third bit; Moore's is 1 in the next cycle, whatever x does then. In a run of 1, 0, 1, 0, 1, 1, 0 the Mealy y is 1 at inputs ${PAIR.map((p, i) => (p.mealy ? i + 1 : 0)).filter(Boolean).join(' and ')},
      the Moore y at ${PAIR.map((p, i) => (p.moore ? i + 1 : 0)).filter(Boolean).join(' and ')}.</p>
      <p>So the choice is timing against robustness. A Mealy output reacts the same cycle but is a combinational path from x to y: it moves whenever x moves, glitches included, and whatever reads it must sample it at the edge. A Moore output changes only just after a
      clock edge, cleanly, because it comes from flip-flops; it is late by a cycle and the diagram has more states. The sequencing logic of a processor is mostly Moore (a state asserts its control signals), protocol logic often Mealy.</p>
      <div class="try">Set x = 1, 0, 1 with a Pulse for each. Before the third Pulse the Mealy y is already 1; the Moore y waits for the edge.</div>`,
    tour: {
      label: 'Walk me through it (1, 0, 1 on both)',
      beats: [
        { title: 'Reset', reset: true, set: { rst: 1, x: 0 }, cycles: 1, show: ['mealy', 'moore'], expect: { ymealy: 0, ymoore: 0 },
          say: '<p>rst = 1 and one edge: both machines are in S0. Both outputs are {v:ymealy} and {v:ymoore}.</p>' },
        { title: 'A 1', set: { rst: 0, x: 1 }, cycles: 1, expect: { ymealy: 0, ymoore: 0 },
          say: '<p>x = 1, one edge: S1 in both.</p>' },
        { title: 'A 0', set: { x: 0 }, cycles: 1, expect: { ymealy: 0, ymoore: 0 },
          say: '<p>x = 0, one edge: S2 in both. A 1 now would complete the pattern.</p>' },
        { title: 'The last 1 arrives', set: { x: 1 }, expect: { ymealy: 1, ymoore: 0 },
          say: '<p>x = 1 <em>before</em> the edge. Mealy: y = {v:ymealy} at once, because y reads x. Moore: y = {v:ymoore}, still in S2.</p>' },
        { title: 'The edge', cycles: 1, expect: { ymealy: 0, ymoore: 1 },
          say: '<p>The edge: the Mealy machine is back in S1 and its y falls to {v:ymealy}; the Moore machine enters S3 and its y rises to {v:ymoore}. One cycle apart, the same pattern.</p>' },
      ],
    },
    more: {
      derive: `<p>Any Mealy machine becomes a Moore one by splitting each state by the output its entering arcs carry: a state entered both with y = 0 and with y = 1 becomes two states. Here S1 is entered with y = 0 only, but the arc S2 → S1 carries y = 1,
        so S1 splits into S1 (entered quietly) and S3 (entered by the matching 1). The Moore machine has up to as many states as the Mealy one has (state, output) pairs.</p>
        <table class="mini"><tr><th>input</th>${PAIR.map((p) => `<td>${p.x}</td>`).join('')}</tr><tr><th>Mealy y</th>${PAIR.map((p) => `<td>${p.mealy}</td>`).join('')}</tr><tr><th>Moore y</th>${PAIR.map((p) => `<td>${p.moore}</td>`).join('')}</tr></table>`,
      real: `<p>A Mealy output in a long chain is a timing problem: x → logic → y → more logic → a register, all in one cycle. Registering the output (a flip-flop on y) makes it a Moore-like output a cycle later, which is why many bus protocols specify
        outputs "registered".</p>`,
      pitfall: `<p>Taking the one-cycle difference as a delay in the circuit. Nothing waits: the Moore output is simply a function of a state that does not exist yet while the last input is still on the wires. The cycle is spent
        <em>entering</em> S3.</p>`,
    },
    scene: pairScene,
    challenge: {
      kind: 'quiz',
      question: 'The last 1 of 1, 0, 1 is on x for a whole cycle, then the clock edge. In which cycle does each detector\'s y show it?',
      options: [
        'Mealy in that cycle, Moore in the next one',
        'Moore in that cycle, Mealy in the next one',
        'Both in that cycle: they run on the same clock',
        'Both in the next cycle: y is always registered',
      ],
      answer: 0,
      explain: 'Mealy\'s y = x·s1 reads the input directly, so it is already 1 before the edge. Moore\'s y is the output of state S3, which the edge enters.',
      why: [
        '',
        'The other way round: the machine that needs a state for the answer is the one that is late.',
        'The same clock does not make the same timing: one output is a function of x, the other of a flip-flop that has not yet changed.',
        'Only the Moore output is registered (it comes from the state). The Mealy y is combinational from x and the state.',
      ],
    },
  },
  // 3 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'Three ways to number the states',
    body: `
      <p>The <span data-show="s0 s1">flip-flops</span> only hold numbers, so each state needs a <strong>code</strong>, and the choice changes the logic that computes the next one.</p>
      <ul>
        <li><strong>Binary</strong>: count them, 00, 01, 10. The fewest flip-flops (${BIN.dffs}).</li>
        <li><strong>Gray</strong>: 00, 01, 11, so that stepping to the next state flips one bit. That matters when something outside this clock reads the state; here it does not.</li>
        <li><strong>One-hot</strong>: a flip-flop per state, 001, 010, 100 (${HOT.dffs} flip-flops). A state is tested by reading one flip-flop, and each next-state bit is the OR of the arcs that enter its state.</li>
      </ul>
      <p>The table on the stage is the builder's own count for this machine, computed from its truth tables: binary wins at ${BIN.nands} NANDs, Gray costs ${GRAY.nands}, one-hot ${HOT.nands}. Switch the encoding: the diagram's codes and the circuit change together, and
      the circuit still reads back as the same machine. The next-state logic of the binary version is <code>${eqs(MEALY101, 'binary', 'next').join('</code>, <code>')}</code>; the one-hot version's is <code>${eqs(MEALY101, 'onehot', 'next').join('</code>, <code>')}</code>: one short term per bit.</p>
      <p>One-hot pays when a machine has many states and few arcs into each: its logic per bit stays small, while a binary code's logic grows with every state it must decode. For three states it loses, ${HOT.nands} NANDs against ${BIN.nands}; the four-state Moore detector costs
      ${MBIN.nands} / ${MGRAY.nands} / ${MHOT.nands} NANDs in binary / Gray / one-hot. The controller of <a href="#/c/multicycle/0">a processor that spends several cycles on each instruction</a> (chapter ${numOf('multicycle')}), with a dozen states each entered from one or two others, is the machine one-hot is made for.</p>
      <div class="try">Switch to One-hot, then to Gray: watch the codes under the states change, and the cost row that is highlighted.</div>`,
    more: {
      derive: `<p>Binary logic decodes: to know "am I in S2?" it ANDs both state bits (or their complements), and each next-state bit is a function of all of them. One-hot needs no decoding, so each next-state bit has only the arcs that enter that state as terms.
        Per bit, binary logic grows with the number of states and the number of arcs together; one-hot grows only with the arcs entering that one state. The flip-flops cost the other way: ${BIN.dffs} against ${HOT.dffs} here, 4 bits against 16 for sixteen states.</p>
        <table class="mini"><tr><th>code</th><th>flip-flops</th><th>logic NANDs</th><th>total</th><th>Moore total</th></tr>
        ${[BIN, GRAY, HOT].map((c, i) => `<tr><td>${ENCODING_NAMES[c.enc]}</td><td>${c.dffs}</td><td>${c.logic}</td><td>${c.nands}</td><td>${[MBIN, MGRAY, MHOT][i].nands}</td></tr>`).join('')}</table>`,
      real: `<p>FPGAs are rich in flip-flops and poor in wide logic, so synthesis tools re-encode a state machine one-hot by default. In an ASIC flow the same tool weighs flip-flop area against logic area per machine, and may keep binary. A third choice, Gray, is used when the
        state crosses into another clock (only one bit changes at a time, so a sample is always a valid state) or when frequent transitions between adjacent states should switch few wires.</p>`,
      pitfall: `<p>Choosing the code before the diagram. The code is the last decision: it changes cost, not behaviour, and a tool can try all of them. A machine hand-coded in binary in the source is also harder to change: add a state and every code and every equation moves.</p>`,
    },
    scene: () => encScene('binary'),
    challenge: {
      kind: 'quiz',
      question: 'A controller has 12 states and each is entered from at most two others. Which code gives the smallest next-state logic per flip-flop?',
      options: [
        'One-hot: each bit is an OR of at most two arc terms, whatever the number of states',
        'Binary: fewest flip-flops always means least logic',
        'Gray: one bit changes per step, so less logic',
        'They are always equal',
      ],
      answer: 0,
      explain: 'In a one-hot code a next-state bit is 1 exactly when an arc into its state is taken, so its logic is one term per entering arc, however many states there are. A binary code decodes the whole register for every arc.',
      why: [
        '',
        'Fewer flip-flops (4 against 12) is the saving of binary, but each of its 4 next-state bits is a function of all 4 bits and the inputs: more logic per bit.',
        'Gray changes one bit per step along a path of adjacent codes; it does not shrink the logic that decides which state comes next, and in a dozen-state controller adjacent codes cannot serve every arc.',
        'The costs differ, and in opposite directions: flip-flops favour binary, logic per bit favours one-hot. The table above shows both for a machine that is small.',
      ],
    },
  },
  // 4 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'From the table to the logic',
    body: `
      <p>Once the states have codes, the diagram is a <strong>table</strong>: for each state code and input, the next state. Here, with binary codes S0 = 00, S1 = 01, S2 = 10 (inputs s1 s0 x, outputs n1 n0):</p>
      ${tableHtml(nextT)}
      <p>The rows with s1 s0 = 11 hold a <strong>–</strong>: no state has that code, so what the machine does there is nobody's business, a don't care. The output table (Mealy, y = 1 on S2 with x = 1) has the same two rows free.</p>
      <p>Each output column is a function of three variables. Draw it as a <strong>Karnaugh map</strong>, the table folded so that neighbouring cells differ in one variable (rows and columns run in Gray order, 00 01 11 10), and circle rectangles of 1s whose sides are powers of two: each rectangle is one product term, with the variables that change inside it dropped. A – may be
      counted as a 1 when that makes a rectangle larger.</p>
      <div>${kmapHtml(nextT, 0)}${kmapHtml(nextT, 1)}${kmapHtml(outT, 0)}</div>
      <p>n1 has one 1 (S1 with x = 0), and the – at 11 / x = 0 beside it lets the rectangle grow to two cells: <code>${equation(nextT, 0)}</code>, the s1 dropped. n0 = 1 on every row with x = 1: <code>${equation(nextT, 1)}</code>.
      The output: <code>${equation(outT, 0)}</code>. That is all the logic: ${BIN.logic} NANDs with the reset gating, ${BIN.dffs} flip-flops on top.</p>
      <p>The don't cares are not decoration: the circuit does something at 11, and the minimized equations decide what. The next step is about it. For now, put the machine there and see.</p>
      <div class="try">The stage is the next-state logic alone. Set s1 s0 = 1 1 and x = 0: which state does the machine go to from a code it was never meant to reach?</div>`,
    more: {
      derive: `<p>Without the don't cares: n1 = ¬s1·s0·¬x needs three literals; with the – at 11 it is s0·¬x, two. The output y = s1·¬s0·x becomes s1·x. Each dropped literal is a smaller gate and a faster path. The sandbox's state-machine chip does this minimization (Quine–McCluskey, with exact search for small tables) when it
        draws the two table chips; double-click a table chip and the Karnaugh map is there.</p>`,
      real: `<p>Synthesis tools (Yosys, a vendor flow) extract the state register of a machine from the source, assign codes, build exactly these tables and minimize them with espresso-type algorithms. A designer's choice is mostly the diagram, and the don't cares: a table that declares which codes can never occur gives the minimizer the freedom
        this step used.</p>`,
      pitfall: `<p>Treating a don't care as a 0. A – is a promise that the input never occurs, not a decision about its output: the cheapest circuit behaves arbitrarily there, and a glitch or a power-up in that state shows it. Step 5 is that consequence.</p>`,
    },
    scene: tableScene,
    challenge: {
      kind: 'reach',
      goal: 'Find the next state the minimized logic picks for the unused code 11 (s1 s0 = 1 1) when x = 0: make n1 n0 = 1 0, which is S2.',
      check: (st) => st.value('s1') === 1 && st.value('s0') === 1 && st.value('x') === 0 && st.value('n1') === 1 && st.value('n0') === 0,
      hints: [
        'Set s1 and s0 to 1 and x to 0. Then read n1 and n0.',
        'The equations are n1 = s0·¬x and n0 = x. What do they say at s1 s0 x = 1 1 0?',
      ],
      answer: 's1 = 1, s0 = 1, x = 0: n1 = s0·¬x = 1 and n0 = x = 0, so the logic sends the unused code to S2 (10).',
      solve: (st) => st.setInputs({ s1: 1, s0: 1, x: 0 }),
    },
  },
  // 5 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'Reset, and the codes nobody uses',
    body: `
      <p>A state register powers up in <em>some</em> code. If the machine has fewer states than codes, some codes belong to no state, and the logic there is whatever the minimizer found cheapest. Two things must hold: the machine must be put in a known state at the start, and an unused code must lead back.</p>
      <p><strong>Reset.</strong> The builder gives every machine a synchronous <code>rst</code>: while it is 1, the next state is the reset state, whatever the arcs say (<span data-show="inv_rst g0">one gate</span> per state bit). The reset state gets the code that power-on gives where it can: all zeros in binary, but one-hot's reset state has a 1 in it, so a one-hot register powers up in 000, which is an
      <em>unused</em> code, until rst has been applied for one edge. Press Reset to A on the stage.</p>
      <p><strong>Unused codes.</strong> The sequencer on the stage steps A → B → C → A while go = 1, one lamp per state, one-hot (${3} flip-flops, ${8 - 3} unused codes). A particle strike, a glitch or a marginal supply flips one flip-flop: use the Flip buttons. With the unused codes left as don't cares (${RING_FREE} NANDs), every single-bit upset
      leaves a code the machine never leaves: ${[0, 1, 2].flatMap((s) => [0, 1, 2].map((b) => upset(false, s, b))).filter((u) => !u.valid).length} of 9 flips from the three states are permanent. Either no lamp at all (000, which maps to itself) or two lamps lit, rotating for good.
      With the option "unused codes go to reset" (the builder's <code>safe</code>, ${RING_SAFE} NANDs) the same flips are gone after one edge: every unused code has an arc, to A.</p>
      <p>The price is ${RING_SAFE - RING_FREE} NANDs more, ${Math.round(((RING_SAFE - RING_FREE) / RING_FREE) * 100)} %, because the don't cares were buying logic. Whether it is worth it depends on what the machine controls: a traffic light had better not lock up; a debug counter may.</p>
      <div class="try">Reset to A, then Flip s1 and Clock a few times with go = 1. Then use the safe version and do the same.</div>`,
    actions: [
      { label: 'Reset to A', run: (st) => { st.setInputs({ rst: 1 }); st.runCycles(1); st.setInputs({ rst: 0 }); } },
      { label: 'Flip s0', run: (st) => { if (st.sim) flipState(st.sim, 0); } },
      { label: 'Flip s1', run: (st) => { if (st.sim) flipState(st.sim, 1); } },
      { label: 'Flip s2', run: (st) => { if (st.sim) flipState(st.sim, 2); } },
      { label: 'Clock ×3', run: (st) => { st.runCycles(3); } },
      { label: 'Use the version that goes to reset', run: (st) => st.load(ringScene(true)) },
      { label: 'Use the version with don\'t cares', run: (st) => st.load(ringScene(false)) },
    ],
    more: {
      derive: `<p>With the don't cares the minimized equations are <code>${eqs(RING3, 'onehot', 'next').join('</code>, <code>')}</code>: rotate when go, hold otherwise. From 000 every term is 0, so the register stays 000. From 011 the rotate moves both 1s together: 011 → 110 → 101 → 011, three codes, forever. The safe version adds, for every code with
        not exactly one 1, a path to A: ${RING_SAFE - RING_FREE} more NANDs to detect "not one-hot" and force the reset state.</p>
        <table class="mini"><tr><th>flip in state</th><th>bit</th><th>register after the flip</th><th>after six edges, don't cares</th><th>after six edges, safe</th></tr>
        ${[0, 1, 2].flatMap((s) => [0, 1, 2].map((b) => { const u = upset(false, s, b), v = upset(true, s, b); return `<tr><td>${u.start}</td><td>${b}</td><td>${u.code.toString(2).padStart(3, '0')}</td><td>${u.after.toString(2).padStart(3, '0')}</td><td>${v.after.toString(2).padStart(3, '0')}</td></tr>`; })).join('')}</table>`,
      real: `<p>Safety-critical state machines are written "fully specified" for exactly this reason, and some tools add a reset arc to every unused code automatically (a "safe" or "recovery" option on the encoding). Radiation-hardened designs go further: triple the state register and vote.</p>`,
      pitfall: `<p>Assuming the machine "cannot get there". A power-up, a metastable input or a single upset can: and a don't care means the design says nothing about what happens. Count the codes: ${8} codes, ${3} states, ${8 - 3} places to be lost.</p>`,
    },
    scene: () => ringScene(false),
    challenge: {
      kind: 'quiz',
      question: 'The sequencer has don\'t cares in its unused codes and go = 1. An upset flips B\'s flip-flop while it is in A, leaving 011. Where does it go?',
      options: [
        'Nowhere useful: 011 rotates to 110, 101, 011 … for good, two lamps lit',
        'Back to A: the logic sees two bits and resets',
        'To B, the code with the most bits matching',
        'It stops in 011 until go falls',
      ],
      answer: 0,
      explain: 'The next-state logic is a plain rotate, so two 1s travel together and never merge. Only an arc from the unused code to a real state, which costs gates, brings it back.',
      why: [
        '',
        'That is what the safe version does, with extra gates. With don\'t cares there is no logic that looks at how many bits are set.',
        'Nothing in the circuit compares codes: each next-state bit just copies the bit before it.',
        'With go = 1 the register rotates every edge; it holds only when go = 0, and then in the same bad code.',
      ],
    },
  },
  // 6 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'Read it back: is it the machine you drew?',
    body: `
      <p>A circuit that passes the test you thought of is not yet the machine you drew. Three circuits are on offer, all built as the 101 detector; all report the plain 1, 0, 1. Which one <em>is</em> the diagram?</p>
      <p>A test cannot answer that for every sequence, but a <strong>read-back</strong> can: start the circuit from reset, apply every input combination for one cycle, and note the state it reaches and the outputs, breadth first, until no new state turns up. A state is the settled value of every net, so no flip-flop has to be named. Each state found is paired with the diagram state the same inputs reach,
      and every arc is compared: its target and its output. A wrong arc is drawn <span style="color:var(--bad,#d63b3b)">red</span> with the arc the diagram wanted dashed beside it.</p>
      <p>On 1, 0, 1, 0, 1 the right machine gives y = ${CAND('b')}; circuit A gives ${CAND('a')} (${CANDIDATES[0].fault}); circuit C gives ${CAND('c')} (${CANDIDATES[2].fault}). The read-back finds both without being given the input: the same procedure grades the campaign's state-machine level, and it is how the sandbox's builder says "reads back as drawn".</p>
      <div class="try">Load each circuit and look at the read-back panel: the number of arcs that differ, and the red ones. Then find the one that reads back clean.</div>`,
    actions: CANDIDATES.map((c) => ({ label: c.name, run: (st: Stage) => st.load(candScene(c.key)) })),
    more: {
      derive: `<p>The read-back explores a graph with at most 2^(state nets) nodes but only as many as the machine has reachable states, so it finishes: here ${SPEC_TARGET.states.length} states and ${SPEC_TARGET.states.length * 2} arcs. It checks reachability and outputs but not timing, and a state the diagram does not have shows as an extra node below it.
        A test needs the failing sequence; the read-back needs only the diagram.</p>`,
      real: `<p>Formal tools do the same on a bigger scale: equivalence checking compares the synthesized netlist with the source as machines, not as test vectors. A read-back is its small, exhaustive cousin for a machine with a handful of inputs.</p>`,
      pitfall: `<p>Reading the circuit back against a diagram that is itself wrong: the check proves the circuit is the diagram, not that the diagram solves the problem. Step 1's method is what decides the second.</p>`,
    },
    scene: () => candScene('a'),
    challenge: {
      kind: 'reach',
      goal: 'Load the circuit that reads back exactly as the diagram: every arc black, none red.',
      check: (st) => st.sim?.design.root.def === candidateCircuit(RIGHT.key),
      hints: [
        'Each button loads a circuit and reads it back over the diagram. A wrong circuit has red arcs and a count of arcs that differ.',
        'The wrong circuits differ in what happens after the pattern is complete (circuit A) and in when y rises (circuit C). Try them all.',
      ],
      answer: `${RIGHT.name}: 0 arcs differ.`,
      solve: (st) => st.load(candScene(RIGHT.key)),
    },
  },
  // 7 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'A controller and a datapath',
    body: `
      <p>A state machine alone remembers <em>where</em> it is; it cannot hold a number such as 48, let alone subtract two of them. Real control splits the work: a small <strong>controller</strong> (the state machine) decides, and a <span data-ahead="datapath"><strong>datapath</strong> (the registers, subtractor and comparator that hold and compute the data)</span> does the arithmetic. The controller reads the datapath's flags and drives its enables and selects.</p>
      <p>Euclid's GCD by subtraction is the classic: while a ≠ b, subtract the smaller from the larger. The datapath has <span data-show="r_a r_b">two registers</span>, <span data-show="op0">a subtractor</span> and <span data-show="cmp0">a comparator</span>, their selects and enables driven by
      <span data-show="ctl">the controller</span>. The controller has five states: IDLE (load a and b when start is 1), TEST (look at the comparator: a = b → DONE, a &lt; b → SUBB, else SUBA), SUBA (a := a − b), SUBB (b := b − a) and DONE (done = 1 until start falls). Each pass through TEST and a subtract state is two cycles.</p>
      <p>For gcd(48, 18) the diagram is ${GCD.cycles} edges from start to DONE: ${GCD.states.map((s, i) => `${s} (a ${GCD.a[i]}, b ${GCD.b[i]})`).join(', ')}. The reference model (editor/fsmd.ts) steps the same machine and this count is its; the gates agree with it every cycle.</p>
      <p>The controller is ${GCD_COST.controller} NANDs of the machine's ${GCD_COST.total}: the rest is the datapath's two 8-bit registers, the subtractor, comparator and the multiplexers that steer them. That is the proportion of every processor: a few hundred gates of sequencing around thousands of gates of data. This is the shape of every sequencing unit later in the book:
      chapter ${numOf('multicycle')}'s controller is this one with a dozen states, steering a far bigger data path.</p>
      <div class="try">Set start = 1 and Pulse until done lights: the diagram's current state and the registers move together, and a ends at 6.</div>`,
    more: {
      derive: `<p>Each state's action is a register transfer (a := a − b); the controller turns it into control lines: ld_a (load a), sel_a (which source: x or the subtractor), the subtractor's operand selects. Arcs may test the datapath (a &lt; b); the comparator's result is just another input to the next-state logic, the status bit st0 or st1.
        The controller's own table is therefore like step 4's, with the status bits among its inputs and the control lines among its outputs.</p>`,
      real: `<p>The split is how hardware designers think: an <em>FSMD</em>, a finite-state machine with datapath. A GCD unit in a few hundred gates, a divider (the campaign's Divider level), a cache controller with its tag RAM, a UART with its shift register: each is a small controller and a datapath that it steers.</p>`,
      pitfall: `<p>Putting the arithmetic in the states: a state per value of a is 256 states for 8 bits. The datapath holds the numbers and the controller only the phase of the algorithm: IDLE, TEST, SUB, DONE.</p>`,
    },
    scene: gcdScene,
    tries: [(st) => st.value('done') === 1],
    challenge: {
      kind: 'reach',
      goal: 'Run gcd(48, 18) to the done state with 6 in a: start = 1 and pulse until done = 1.',
      check: (st) => st.value('done') === 1 && st.value('gcd') === 6 && st.value('x') === 48 && st.value('y') === 18,
      hints: [
        'x = 48 and y = 18 are already set. Set start = 1: IDLE loads a and b on the next edge.',
        `Then Pulse. TEST and SUBA / SUBB alternate until a = b; it takes ${GCD.cycles} edges in all.`,
      ],
      answer: `x = 48, y = 18, start = 1, ${GCD.cycles} Pulses: the machine ends in DONE with a = b = 6.`,
      solve: (st) => { st.setInputs({ x: 48, y: 18, start: 1 }); st.runCycles(GCD.cycles); },
    },
  },
  // 8 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'Inputs from outside: synchronize and debounce',
    body: `
      <p>A state machine decides at every clock edge from its inputs. An input that comes from <em>outside</em> the clock, a button, a switch, another system, has two problems.</p>
      <p><strong>It can change at any moment</strong>, including inside the flip-flops' setup and hold window, where the flip-flop can go <em>metastable</em> and take an unbounded time to decide. The remedy is two flip-flops in series, a <span data-show="sync">synchronizer</span>: the first may be undecided but has a full cycle to settle before the second looks. The price is two cycles of latency. Worse, if the input fans out to several flip-flops directly, each might decide differently: one input, one synchronizer, then use its output everywhere.</p>
      <p><strong>A mechanical contact bounces</strong>: for a few milliseconds a pressed button makes and breaks several times, and a state machine sampling it each cycle will count each bounce as a press. A <span data-show="deb">debouncer</span> accepts a new level only after it has lasted: a ${3}-bit counter counts the samples that disagree with the accepted level, is cleared when
      they agree again, and flips the output when it has counted to ${debounceSamples(3) - 1}. A bounce that ends in fewer than ${debounceSamples(3)} samples never reaches the output; a settled press does, ${debounceSamples(3)} samples after the synchronizer sees it. The whole input stage is ${nands(BUTTON3)} NANDs (the debouncer ${nands(debouncer(3))}).</p>
      <p>For a real button: if it bounces for up to ${BOUNCE_SAMPLES} ms and the clock samples every millisecond, the counter must outlast ${BOUNCE_SAMPLES} samples: ${N_DEB} bits (${debounceSamples(N_DEB)} samples, ${debounceSamples(N_DEB)} ms of delay). It costs the latency of a press, a few milliseconds, which nobody feels.</p>
      <p>The debouncer is itself a small state machine steering a counter: "waiting / counting / flip" is the controller, the count the data. Everything in this chapter applies to it.</p>
      <div class="try">Press a bouncing button, then a clean one: the raw signal is the input; sync is the synchronizer's output two edges later; q changes only after the counter has counted ${debounceSamples(3)} agreeing samples.</div>`,
    actions: [
      { label: 'Press (bouncing)', run: press(BOUNCY) },
      { label: 'Press (clean)', run: press(SMOOTH) },
      { label: 'Release', run: press([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) },
    ],
    more: {
      derive: `<p>The synchronizer's reliability: the chance the first flip-flop is still undecided after a time t falls as e^(−t/τ); with a full clock period to resolve, the mean time between failures grows exponentially with the period. A debouncer's counter width follows from the longest bounce b in samples: the smallest n with 2^n > b, here ${N_DEB} for b = ${BOUNCE_SAMPLES}.</p>`,
      real: `<p>A keyboard controller scans a matrix and debounces each key for 5 to 20 ms; a rotary encoder is debounced with its own tiny state machine (the old and new two-bit states give the direction). Many chips put a Schmitt-trigger input in front of the synchronizer for slow, noisy edges.</p>`,
      pitfall: `<p>Debouncing before synchronizing, or not at all: the counter's own flip-flops then see an asynchronous input and can go metastable. Order matters: synchronize first, then count. The other slip is to debounce the <em>release</em> as well as the press: both edges bounce, which is why this debouncer's rule is symmetric.</p>`,
    },
    scene: buttonScene,
    challenge: {
      kind: 'quiz',
      question: `A button bounces for up to ${BOUNCE_SAMPLES} ms and the debouncer is clocked at 1 kHz. A new level must last 2ⁿ samples. What is the narrowest counter that ignores every bounce?`,
      options: [`${N_DEB} bits (${debounceSamples(N_DEB)} samples)`, `${N_DEB - 1} bits (${debounceSamples(N_DEB - 1)} samples)`, `${BOUNCE_SAMPLES} bits`, 'None: the synchronizer already removes bounce'],
      answer: 0,
      explain: `The bounce lasts up to ${BOUNCE_SAMPLES} samples, so the counter must need more than that: 2ⁿ > ${BOUNCE_SAMPLES} gives n = ${N_DEB}.`,
      why: [
        '',
        `${debounceSamples(N_DEB - 1)} samples is not more than ${BOUNCE_SAMPLES}: a bounce as long as the longest would be accepted as a press.`,
        'The counter counts samples, not milliseconds of bounce: n bits count 2ⁿ, so five bits would wait 32 samples.',
        'The synchronizer only protects the flip-flops from a change inside the setup window. A bounce is several real changes, each of which it passes on two cycles later.',
      ],
    },
  },
  // 9 ---------------------------------------------------------------------------------------------------------------------
  {
    title: 'Your own: a traffic light',
    body: `
      <p>The same method, on a problem you have not seen. A road crossing: the main road stays green until a car waits on the side road (<code>car</code> = 1). Then main goes yellow, the side road gets green for as long as cars keep coming, then yellow, and main is green again. Outputs, one lamp each: <code>mg my sg sy</code> (the red lamps are the absence of the others).</p>
      <p>Follow the steps. <strong>States</strong>: four things to remember, MG, MY, SG, SY, one lamp state each: a Moore machine, because lamps should not flicker with the sensor. <strong>Arcs</strong>: MG stays on car = 0, goes to MY on car = 1; MY goes to SG whatever car does; SG stays while car = 1, goes to SY on car = 0; SY goes to MG. <strong>Codes</strong>: four states are two binary
      flip-flops, ${nands(fsmCircuit('traffic', TRAFFIC))} NANDs here. <strong>Unused codes</strong>: none, all four codes are states. <strong>Read-back</strong>: the builder does it for you.</p>
      <p>The stage has that machine. Serve the side road: set car = 1 and Pulse until sg lights, then release the car and watch it return. Then <a href="#/sandbox/new/traffic">open the empty diagram in the sandbox</a> (four states with their lamps, no arcs), draw the six arcs, and compare. Then improve it: what happens when cars never stop coming on the side road? Main waits for ever. A minimum green time for the side road needs
      a counter, which is a datapath, and that makes it a machine like step 7's. A pedestrian button is one more input; an all-red cycle between yellow and green is one more state.</p>
      <div class="try">Set car = 1 and Pulse twice: MG → MY → SG. Set car = 0 and Pulse: SG → SY, then MG.</div>`,
    more: {
      derive: `<p>Counting what the machine remembers: the main/side road (2 values) and the lamp colour of the road that has the light (green, yellow): four states. A pedestrian phase adds one state per road crossing, a minimum-green timer adds a counter, and each addition is a question of the step 1 kind: what must the machine remember now?</p>`,
      real: `<p>Real controllers are Moore machines with timers (minimum green, clearance interval, all-red), conflict monitors that force flashing red on a forbidden combination of lamps (a unused-code recovery, step 5), and a datapath of timer counters. Controllers for a junction are written as state tables, exactly as here.</p>`,
      pitfall: `<p>Moving the lamps off the state: a Mealy output (a lamp that depends on car) flickers when the sensor does. For anything a person or a motor sees, the output should come from flip-flops.</p>`,
    },
    scene: trafficScene,
    challenge: {
      kind: 'reach',
      goal: 'Serve the side road: set car = 1 and clock until the side lamp is green (sg = 1).',
      check: (st) => st.value('sg') === 1,
      hints: ['Set car = 1, then Pulse. The machine leaves MG for MY on the first edge.', 'MY goes to SG on the next edge, whatever car is.'],
      answer: 'car = 1, two Pulses: MG → MY → SG, and sg = 1.',
      solve: (st) => { st.setInputs({ car: 1 }); st.runCycles(2); },
    },
  },
];

export const chFsm: Chapter = {
  id: 'fsm', num: numOf('fsm'), title: 'Designing state machines', level: 'Sequential logic',
  blurb: 'From a sentence to a state diagram, the codes you give the states and what they cost, unused states, reading a circuit back, and a controller driving a datapath.',
  goals: [
    'turn a sentence into a state diagram, and the diagram into gates',
    'choose between Moore and Mealy, and between binary, Gray and one-hot codes, by what they cost',
    'make a machine that cannot lock up, and check it by reading it back',
    'drive <span data-ahead="datapath">a datapath (the registers and arithmetic that hold and transform the data)</span> from a controller: the shape of every <span data-ahead="control">control unit (the logic that sequences a processor)</span> to come',
  ],
  builds: ['latches', 'registers'],
  recap: {
    keep: [
      `A state machine is a state register, next-state logic and output logic. Design it as a diagram (states are what must be remembered), then a table, then logic: the 101 detector is ${BIN.dffs} flip-flops and ${BIN.logic} NANDs of logic, ${BIN.nands} in all.`,
      `Moore outputs follow the state, a cycle later than Mealy's, which follow the inputs too. The code you give the states changes the logic, not the behaviour: binary ${BIN.nands}, Gray ${GRAY.nands}, one-hot ${HOT.nands} NANDs for the detector; one-hot wins for many states with few arcs each.`,
      `Reset every machine into a known state and give every unused code an arc, or an upset can lock it up (${RING_FREE} NANDs without, ${RING_SAFE} with, for a three-state sequencer). Read a circuit back into its diagram to know it is the machine you drew.`,
      `A controller decides and <span data-ahead="datapath">a datapath (registers and arithmetic)</span> computes: GCD(48, 18) in ${GCD.cycles} cycles, the controller ${GCD_COST.controller} of ${GCD_COST.total} NANDs. An input from outside the clock goes through a two-flip-flop synchronizer and, if it is a contact, a debouncer.`,
    ],
    practise: ['s_fsm', 'o_div', 'd_kmap'],
    check: [
      {
        question: 'A Moore and a Mealy machine detect the same pattern. The last bit of the pattern is on the input for one cycle. What is true of their outputs?',
        options: [
          'The Mealy output is high in that cycle, the Moore output in the following one',
          'Both are high in that cycle',
          'The Moore output is high in that cycle, the Mealy output in the following one',
          'Both are high in the following cycle',
        ],
        answer: 0,
        explain: 'The Mealy output reads the input directly. The Moore output is a function of the state, which changes at the edge that takes the last bit in.',
        why: [
          '',
          'Only a Mealy output can depend on the input in the same cycle; a Moore output waits for the state.',
          'Reversed: the Moore machine needs the edge to enter its output state.',
          'The Mealy output does not wait: it is combinational from the input and the state.',
        ],
      },
      {
        question: 'A controller has 32 states, each entered from one or two others. Which code is likely to need the least logic per flip-flop, and what does it cost elsewhere?',
        options: [
          'One-hot: a short OR per bit, at the price of 32 flip-flops instead of 5',
          'Binary: 5 flip-flops and the least logic of any code',
          'Gray: one bit per transition, with 5 flip-flops',
          'The code does not change the cost of the logic',
        ],
        answer: 0,
        explain: 'In one-hot a next-state bit is an OR of its few entering arcs; binary logic decodes five bits for every arc. The flip-flops are the cost: 32 against 5.',
        why: [
          '',
          'Binary has the fewest flip-flops, but its logic grows with the number of states, so it is not the least logic.',
          'Gray reduces the bits that change at a transition; the logic still decodes all the bits.',
          'It does: in this chapter the same machine costs from 32 to 51 NANDs, and the logic alone from 10 to 18.',
        ],
      },
      {
        question: 'Why does every unused state code need an arc, in a machine that controls something?',
        options: [
          'A power-up or an upset can put the register there; without an arc the don\'t care logic may keep it there for good',
          'The synthesizer refuses a machine with unused codes',
          'The unused codes are reached by ordinary inputs',
          'Unused codes are needed to make the outputs glitch-free',
        ],
        answer: 0,
        explain: 'Unused codes are unreachable by the arcs, but not by a particle strike or a power-up. A don\'t care is a free choice for the minimizer, which may copy a code onto itself or a cycle of unused codes.',
        why: [
          '',
          'Synthesis accepts them; it uses them as don\'t cares to shrink the logic.',
          'By definition an unused code has no arc leading into it, so no input sequence enters it.',
          'Glitch freedom comes from Moore outputs and registered outputs, not from unused codes.',
        ],
      },
    ],
  },
  steps,
};
