// Chapter "From a table to a circuit" (id logic, after Gates from NAND): any truth table is a circuit (minterms), Boolean algebra that
// removes gates, the Karnaugh map, don't cares, products of sums and NAND–NAND, what a minimal sum does not share, the glitch of a
// two-level circuit and the consensus term that cures it, and a seven-segment digit of the reader's own. Every number is computed
// (lib/logiclab.ts, lib/sop.ts, lib/tablelogic.ts, the simulator) and pinned by tests/content-logic.test.ts.

import {
  ABCD, dipWidth, LAWS, lawRow, MUX_CONSENSUS, MUX_HAZARD, muxRun, PRIME_MINTERMS, PRIME_ONES, primesOfRows, sevenSegCost, sevenSegRows, tableOf,
} from '../lib/logiclab';
import { MUX2 } from '../lib/gates';
import { EXACT_BUDGET } from '../lib/sop';
import { stats } from '../sim/stats';
import { kmapState, kmapWidget, type KmapWidget } from '../widgets/kmap';
import { algebraWidget, GREEDY_ONES, segmentLab, SEG_BUDGET, sharingRows, sharingWidget } from '../widgets/logiclab';
import type { Chapter } from './types';
import { numOf } from './order';

// ---- the numbers the text quotes ------------------------------------------------------------------------------

const PRIME_ROWS = tableOf(ABCD, PRIME_ONES).rows[0];
const MIN = stats(PRIME_MINTERMS());
const PS = kmapState(ABCD, 'y', PRIME_ROWS, false);
const PG = kmapState(ABCD, 'y', PRIME_ROWS, true);
const PP = kmapState(ABCD, 'y', PRIME_ROWS, false, true);
const N_PRIMES = primesOfRows(PRIME_ROWS).length;
const LAW = Object.fromEntries(LAWS.map((l) => [l.id, lawRow(l)]));
const SHARE = sharingRows();

// segment e of a BCD digit: lit for 0, 2, 6 and 8
const E_ONES = [0, 2, 6, 8];
const E_ROWS = tableOf(ABCD, E_ONES).rows[0];
const E_DC_ROWS = tableOf(ABCD, E_ONES, [10, 11, 12, 13, 14, 15]).rows[0];
const E_PLAIN = kmapState(ABCD, 'e', E_ROWS, false);
const E_DC = kmapState(ABCD, 'e', E_DC_ROWS, false);

// the table where the greedy cover takes a loop more
const G_ROWS = tableOf(ABCD, GREEDY_ONES).rows[0];
const G_EXACT = kmapState(ABCD, 'y', G_ROWS, false);
const G_GREEDY = kmapState(ABCD, 'y', G_ROWS, true);

// the multiplexer with and without its consensus term
const MUX_PLAIN_NANDS = stats(MUX2).nands;
const MUX_CONS_NANDS = stats(MUX_CONSENSUS).nands;
const RUN = muxRun({ a: 1, b: 1, cons: 0 }, 1, 0);
const DIP = dipWidth(RUN);

const SEG_FILL = '------';
const SEG_DC = sevenSegCost(sevenSegRows(Array(7).fill(SEG_FILL)));
const SEG_ZERO = sevenSegCost(sevenSegRows(Array(7).fill('000000')));

/** The numbers the chapter quotes, for tests/content-logic.test.ts. */
export const LOGIC_NUMBERS = () => ({ MIN, PS, PG, PP, N_PRIMES, LAW, SHARE, E_PLAIN, E_DC, G_EXACT, G_GREEDY, MUX_PLAIN_NANDS, MUX_CONS_NANDS, RUN, DIP, SEG_DC, SEG_ZERO, SEG_BUDGET: SEG_BUDGET() });

// ---- the steps' live parts (a step's challenge reads the widget of the step shown) --------------------------------

let km3: KmapWidget | null = null, km3Start = '';
let km4: KmapWidget | null = null;
let seg8: ReturnType<typeof segmentLab> | null = null;
let prevS = 1;

export const chLogic: Chapter = {
  id: 'logic', num: numOf('logic'), title: 'From a table to a circuit', level: 'Gates',
  blurb: 'Truth table to sum of products, Boolean algebra, Karnaugh maps, don\'t cares, and the glitch that a two-level circuit can make.',
  goals: [
    'turn any truth table into a circuit, mechanically, and say why that circuit is rarely small',
    'shrink a circuit with Boolean algebra and count what each rule saves',
    'read a minimal sum off a Karnaugh map, with don\'t cares, and know when the answer is only the greedy one',
    'see a <span data-ahead="glitch">glitch (a change that does not last)</span> in a two-level circuit and remove it with the consensus term',
  ],
  builds: ['gates', 'nand'],
  recap: {
    keep: [
      `Every truth table is a sum of its minterms: one AND per 1, ORed. That circuit is always correct and rarely small: the prime detector takes ${MIN.nands} NANDs that way and ${PS.cost.nands} once minimized.`,
      'A Karnaugh map puts rows that differ in one input side by side (the edges wrap). Each loop of 1, 2, 4 or 8 cells is one product term, and the inputs that change inside the loop drop out. A don\'t care may join any loop that it makes larger.',
      'A minimal sum of products is not the cheapest circuit (shared terms, factoring), and a two-level circuit can <span data-ahead="glitch">glitch (change for a moment and change back)</span>: the consensus term a·b holds the output through the hand-over and changes no settled value.',
    ],
    practise: ['l_bool', 'd_kmap', 'g_sop', 'g_wide'],
    check: [
      {
        question: 'On a Karnaugh map, a loop of four cells has one input that is 0 in two of its cells and 1 in the other two. What does that input do to the loop\'s product term?',
        options: ['It drops out of the term', 'It appears complemented', 'It appears uncomplemented', 'It splits the term in two'],
        answer: 0,
        explain: 'Inside the loop that input takes both values and the output is 1 either way: x·y + x·¬y = x. Only the inputs that stay the same across the whole loop are left in the term.',
        why: ['', 'Complemented means "0 in every cell of the loop". This input is 0 in only two of them.', 'Uncomplemented means "1 in every cell of the loop". This input is 1 in only two of them.', 'A loop is one AND term. Two terms come from two loops.'],
      },
      {
        question: 'Segment e of a decimal digit (codes 0 to 9) is lit for 0, 2, 6 and 8, and the six unused codes (10 to 15) are marked don\'t care. How do the don\'t cares change the minimal sum?',
        options: [
          `They let the loops grow: ${E_PLAIN.cost.text} becomes ${E_DC.cost.text}`,
          'They add a term for each unused code',
          'They change nothing: a loop may only cover 1s',
          'They must all be chosen 0, or the display shows garbage',
        ],
        answer: 0,
        explain: `Each don't care joins whatever loop it makes bigger and is left out of the others. The sum drops from ${E_PLAIN.cost.literals} literals (${E_PLAIN.cost.nands} NANDs) to ${E_DC.cost.literals} (${E_DC.cost.nands}). What the display shows for 10 to 15 is whatever the chosen loops happen to give: nobody asked.`,
        why: ['', 'A don\'t care is not a 1 that must be covered. Nothing forces a term to exist for it.', 'That is the rule without don\'t cares. A don\'t care is exactly a cell a loop may cover when it helps.', 'Choosing them 0 is allowed, but it throws the freedom away. Nothing on the display is wrong: the codes never occur.'],
      },
      {
        question: 'Adding the consensus term a·b to s·b + ¬s·a changes no row of the truth table. Why add it?',
        options: [
          'It holds the output at 1 while s changes, when a = b = 1 and the two other terms hand over',
          'It makes the circuit smaller',
          'It makes the circuit faster for every input',
          'It removes the need for the inverter on s',
        ],
        answer: 0,
        explain: `The two original terms are loops on the map that touch without overlapping. When s falls, one turns off a gate delay before the other turns on, and y dips for ${DIP} delay. The third term covers the seam: it is 1 throughout. It costs gates (${MUX_PLAIN_NANDS} NANDs become ${MUX_CONS_NANDS}) and slows nothing.`,
        why: ['', `It costs gates: ${MUX_PLAIN_NANDS} NANDs become ${MUX_CONS_NANDS}.`, 'Nothing about any input\'s path gets shorter; the settled values were already right.', '¬s is still what the second term uses. The consensus term does not read s at all.'],
      },
    ],
  },
  steps: [
    {
      title: 'Any rule is a circuit: minterms',
      body: `
        <p>A truth table lists the output for every input pattern. There is a way to turn <em>any</em> table into gates with no insight at all.
        Take the prime detector of the campaign: four inputs <code>a b c d</code>, read as the number <code>8a + 4b + 2c + d</code>, and
        y = 1 for the primes 2, 3, 5, 7, 11 and 13.</p>
        <p>For each row where y = 1, build an AND that is 1 for that row and for no other: a <strong>minterm</strong>. Every input appears in it, plain if the row has a 1 there and
        complemented if it has a 0. Row 5 is <code>0101</code>, so its minterm is <code>¬a·b·¬c·d</code>. OR the six minterms and the circuit is correct by construction: for any input
        at most one minterm is 1, and it is 1 exactly when the row is one of the primes. This is the <strong>sum of minterms</strong>, the canonical <strong>sum of products</strong>.</p>
        <p>On the stage it is <span data-show="na nb nc nd">four inverters</span> for the complements, <span data-show="m2 m3 m5 m7 m11 m13">six gates, one per prime</span>
        and <span data-show="or">an output gate that collects them</span>, all in NANDs: <strong>${MIN.nands}</strong> of them, ${MIN.transistors} transistors. Correct, mechanical, and far too big.
        The rest of this chapter gets the same function out of fewer gates. The campaign's <a href="#/campaign/n/g_sop">Prime detector</a> level asks for exactly that.</p>
        <div class="try">Set the inputs to 5 (a = 0, b = 1, c = 0, d = 1) and find the one minterm gate whose output falls to 0.</div>`,
      scene: () => ({ root: PRIME_MINTERMS(), inputs: { a: 0, b: 0, c: 1, d: 0 } }),
      tries: [(st) => st.getInput('a') === 0 && st.getInput('b') === 1 && st.getInput('c') === 0 && st.getInput('d') === 1 && st.value('y') === 1],
      tour: {
        beats: [
          { title: 'A prime', set: { a: 0, b: 0, c: 1, d: 0 }, show: ['m2', 'or'], expect: { y: 1 },
            say: '<p>The input is 0010, which is 2. The gate for row 2 sees exactly its pattern, so its output (a NAND, drawn inverted) is 0, and the output gate passes that on: y = {v:y}.</p>' },
          { title: 'Not a prime', set: { b: 1, c: 0 }, show: ['m2', 'm3', 'm5', 'm7', 'or'], expect: { y: 0 },
            say: '<p>Now 0100, which is 4. No row gate matches, all six outputs stay 1, and y = {v:y}. The circuit says "yes" only for the six rows it was built for.</p>' },
          { title: 'Another prime', set: { a: 1, d: 1 }, show: ['m13', 'or'], expect: { y: 1 },
            say: '<p>1101, which is 13: the gate for <code>a·b·¬c·d</code> matches and the output gate passes it. y = {v:y}. Each prime has a gate of its own; that is what makes the circuit large.</p>' },
        ],
      },
      more: {
        derive: `<p>Why it works: the minterm for row r is 1 only on row r, because it fixes every input. A function is 1 on a set of rows, so it equals the OR of the minterms of those rows, and nothing else can be 1.
          With n inputs a row's minterm has n literals; with k ones the circuit has k such gates and one k-input OR. In NAND–NAND form each minterm is a NAND of its literals and the OR is a NAND of those,
          so the inverters between the two levels disappear (the same De Morgan step as the multiplexer of chapter ${numOf('gates')}). That is the ${MIN.nands} NANDs counted here: the complements, six NANDs of four literals (each built from smaller gates), and the output NAND of six.</p>`,
        real: `<p>A memory is this circuit written down: a ROM stores one output word per input row and a decoder picks it. A programmable logic array keeps only the AND plane and the OR plane, and the tools that fill them in minimize the sum first.
          Hardware descriptions let you write a table or a <code>case</code> statement and leave the minimizing to synthesis, which is why people rarely draw minterms by hand and often need to read them.</p>`,
        pitfall: `<p>Reading "sum of products" as "any circuit with ANDs and ORs". It is a shape: exactly two levels, products first. A circuit with an AND, then an OR, then another AND is not one, and the Karnaugh map of the next steps only describes the two-level shape.</p>`,
      },
    },
    {
      title: 'Algebra that removes gates',
      body: `
        <p>Boolean algebra is the arithmetic of 0 and 1 with · for AND, + for OR and ¬ for NOT, and its rules are ways of replacing a circuit by a smaller one that gives the same output on every row.
        The table checks each rule on every row, and counts the NANDs of both sides when every operator is the box from the previous chapter (NOT 1, AND 2, OR 3, XOR 4).</p>
        <p><strong>Absorption</strong>: a + a·b = a (${LAW.absorb.before} NANDs become ${LAW.absorb.after}): when a is 1 the OR is 1 whatever b is, so the AND is dead weight. The second form, a + ¬a·b = a + b
        (${LAW.absorb2.before} become ${LAW.absorb2.after}), says that ¬a is redundant next to an OR with a. <strong>Combining</strong>, x·y + x·¬y = x, is the rule behind the next step.
        <strong>De Morgan</strong> turns an OR of complements into one NAND (${LAW.demorgan.before} become ${LAW.demorgan.after}).</p>
        <p>The last rows are the ones to remember. <strong>Consensus</strong>: s·b + ¬s·a + a·b = s·b + ¬s·a, the third term is redundant (${LAW.consensus.before} NANDs become ${LAW.consensus.after}); step 7 returns to it, because
        removing it is not free. And a sum of products rewritten as NAND–NAND is the multiplexer of the previous chapter: ${LAW.mux.before} NANDs drawn with ANDs and an OR, ${LAW.mux.after} as NANDs.</p>
        <p>Open the consensus row and read its table: the two columns are equal. Then type your own pair under the table and see whether they agree and what each costs.</p>`,
      widget: () => algebraWidget(),
      challenge: {
        kind: 'quiz', question: 'Which term of  a·b + ¬a·c + b·c  can be dropped without changing any row of the truth table?',
        options: ['b·c, the consensus of the other two', 'a·b', '¬a·c', 'None: each one covers a row the others miss'],
        answer: 0,
        why: ['',
          'a·b covers the rows with a = 1 and b = 1. With c = 0 (a = 1, b = 1, c = 0) the other two terms are 0: ¬a·c needs a = 0 and b·c needs c = 1. Dropping it breaks that row.',
          '¬a·c covers a = 0, c = 1. With b = 0 (a = 0, b = 0, c = 1) a·b and b·c are both 0. Dropping it breaks that row.',
          'Each of a·b and ¬a·c covers a row alone, but b·c does not: it is 1 only where b = c = 1, and there either a = 1 (a·b covers it) or a = 0 (¬a·c covers it).'],
        explain: 'b·c is the consensus of a·b and ¬a·c: whichever way a points, one of the other two terms already contains b·c. The third term is 1 only where one of the first two is 1.',
      },
      more: {
        derive: `<p>Check the consensus rule by cases on a. If a = 1, the terms are b + 0 + b·c = b, and dropping b·c leaves b. If a = 0 they are 0 + c + b·c = c, and dropping it leaves c. Both sides agree on every row.
          A circuit of AND, OR and NOT is a Boolean expression, so every rule here is also a way of rewriting a netlist, and a synthesis tool applies thousands of them. The rule x + x = x removes a duplicated term,
          x + x·y = x removes a term another term already swallows, and the distributive law x·(y + z) = x·y + x·z moves between product-of-sums and sum-of-products shapes.</p>`,
        real: `<p>Nobody minimizes real designs by hand with these rules. Logic synthesis (Yosys and ABC in the open-source flow) represents the circuit as a graph of AND and inverter nodes and rewrites small neighbourhoods using equivalences like these, keeping the rewrite when the count or the depth falls.
          The rules are the same ones; the search is automated and checked by the tool's equivalence prover.</p>`,
        pitfall: `<p>Applying a rule to part of an expression that is not the pattern. a + ¬a·b = a + b is easy to misapply as "a + ¬a·b = b" or "= a·b": test it on a = 1, b = 0 (the left side is 1, so any result without a fails). When in doubt, evaluate both sides on every row: for four variables it is sixteen rows, and the widget above does exactly that.</p>`,
      },
    },
    {
      title: 'The Karnaugh map',
      body: `
        <p>Step 1 turned the prime detector into six minterms of four literals. Step 2's combining rule x·y + x·¬y = x merges two minterms that differ in one input. A <strong>Karnaugh map</strong> lays the table out so that such pairs are
        <em>neighbours</em>: the rows and the columns count in Gray order (00, 01, 11, 10), so stepping one cell changes one input, and the edges wrap around.</p>
        <p>Circle the 1s in loops of 1, 2, 4 or 8 cells, as large as possible: each loop is one AND term, and every input that changes inside the loop drops out. Here ${PS.terms.length} loops of two cells cover all six 1s:
        <code>${PS.cost.text}</code>, ${PS.cost.literals} literals. One loop, <code>${PS.texts[1]}</code>, runs off the top of the map and comes back in at the bottom.</p>
        <p>The dashed outline is the other <em>prime implicant</em>, a loop that cannot grow: there are ${N_PRIMES} in all, ${PS.terms.length} of them chosen. Choosing the fewest that cover every 1 is the hard part of two-level minimization;
        by eye it works up to four or five inputs, and the widget says whether its answer is proven minimal (<em>exact</em>) or only the greedy one. As a circuit the minimal sum costs <strong>${PS.cost.nands} NANDs</strong>, against ${PS.mintermNands} for the six minterms of step 1.</p>
        <div class="try">Click a cell to flip it between 0 and 1: the loops, the sum and the NAND count follow.</div>
        <div class="try">Turn on <em>Greedy</em>. On this table the greedy cover finds the same ${PG.terms.length} loops (step 6 has a table where it does not).</div>`,
      widget: (stage) => {
        km3 = kmapWidget({ ins: ABCD, out: 'y', rows: PRIME_ROWS, edit: '01', greedyToggle: true, circuitToggle: true, stage, title: 'Karnaugh map of the prime detector' });
        km3Start = PRIME_ROWS;
        return km3;
      },
      tries: [() => !!km3 && km3.state().rows !== km3Start, () => !!km3 && km3.state().greedy],
      challenge: {
        kind: 'quiz', question: 'Which loop of the prime detector\'s map is the one that wraps around from the top row to the bottom row?',
        options: [`${PS.texts[1]}: cells 3 (ab = 00) and 11 (ab = 10) differ only in a`, `${PS.texts[3]}: cells 3 and 7`, `${PS.texts[2]}: cells 5 and 13`, 'None: a loop cannot cross the edge of the map'],
        answer: 0,
        why: ['',
          'Cells 3 and 7 are in rows 00 and 01, which are neighbours in the middle of the map. That loop stays inside the grid.',
          'Cells 5 and 13 are in rows 01 and 11, adjacent in Gray order. No wrap.',
          'Loops do cross the edge: the map is really a torus, because the Gray sequence 00, 01, 11, 10 ends one bit away from where it starts.'],
        explain: 'The rows run 00, 01, 11, 10, and 10 differs from 00 in one bit, so the first and last row are neighbours. Cells 3 (0011) and 11 (1011) differ only in a, so b, c and d are the same and the loop\'s term is ¬b·c·d.',
      },
      more: {
        derive: `<p>Why Gray order: two cells are adjacent exactly when their codes differ in one bit, and 00, 01, 11, 10 is the order of two bits in which every step (and the wrap from last to first) flips one bit. A loop of 2ᵏ cells that fixes n − k inputs is a subcube of the input space;
          its AND term has n − k literals, and its 2ᵏ rows are all the rows where those literals hold. A bigger loop means fewer literals, which means a smaller gate.</p>
          <p>The cover itself: a loop must stay on 1s (and don't cares) or the term would be 1 where the function is 0. A prime implicant is a loop that cannot be made larger. An essential prime is the only prime that covers some 1; every minimal cover contains all the essential ones.
          Here the cells 2, 11 and 13 each have a single prime over them, which fixes three of the four loops, and the 1 at 7 can be covered by two primes of the same size (cells 3 and 7, or 5 and 7), so the cover is a tie between them: lib/sop.ts picks one and the map shows it.</p>`,
        real: `<p>For five or six inputs the map is two or four 4 × 4 grids side by side, and by seven it stops being useful to the eye. Programs use the same idea as the Quine–McCluskey algorithm: merge all pairs that differ in one bit, repeat until no merge is possible (those are the primes), then choose a cover.
          The algorithm is exact but the cover step can take exponential time, which is why tools also have a greedy mode, shown by the <em>Greedy</em> switch.</p>`,
        pitfall: `<p>Reading the map in binary order. The rows 00, 01, <em>10</em>, 11 look natural and are wrong: 01 and 10 differ in two bits, so cells that touch would not be neighbours and a loop across them would claim a term that is false in some cell. Every correct map counts 00, 01, 11, 10.
          The other usual slips are loops of 3 or 6 cells (only powers of two work) and forgetting the wrap.</p>`,
      },
    },
    {
      title: 'Don\'t cares: inputs that never happen',
      body: `
        <p>A circuit that drives a seven-segment display shows a digit from its 4-bit code. The code is a <span data-ahead="bcd">BCD digit, 0 to 9 (binary-coded decimal: one decimal digit in four bits)</span>, so the six codes 10 to 15 <em>never occur</em>. For those rows the table does not say 0 or 1; it says <strong>don't care</strong>, and the designer may
        choose whichever value makes the circuit smaller, group by group.</p>
        <p>Take segment e, lit for the digits 0, 2, 6 and 8. With rows 10 to 15 held at 0 the minimal sum is <code>${E_PLAIN.cost.text}</code>: ${E_PLAIN.cost.literals} literals, <strong>${E_PLAIN.cost.nands} NANDs</strong>.
        Let the six unused rows be don't cares and the loops can grow into them: <code>${E_DC.cost.text}</code>, ${E_DC.cost.literals} literals, <strong>${E_DC.cost.nands} NANDs</strong>. Nothing the display must show has changed.</p>
        <p>A don't care joins a loop when it makes the loop bigger and is simply left uncovered otherwise: each one is decided independently. What the circuit then does for the code 12 is whatever the chosen loops give, and the designer has promised never to look.</p>
        <div class="try">Click a cell in rows 10 to 15 until it shows a dash. Rows 0 to 9 are the font and stay fixed.</div>`,
      widget: (stage) => {
        km4 = kmapWidget({ ins: ABCD, out: 'e', rows: E_ROWS, edit: '01-', locked: (r) => r < 10, circuitToggle: true, stage, againstMinterms: false, title: 'Segment e of a BCD digit',
          rowName: (r) => (r < 10 ? `digit ${r}` : `unused code ${r}`) });
        return km4;
      },
      tries: [() => !!km4 && km4.state().dc.length > 0],
      challenge: {
        kind: 'reach', goal: 'Make rows 10 to 15 don\'t cares for segment e: the sum shrinks to two terms of two literals.',
        check: () => { const st = km4?.state(); return !!st && st.terms.length === 2 && st.cost.literals === 4; },
        hints: ['Each cell shows its row number in the corner: the six cells numbered 10 to 15 are the ones that respond. Click one to cycle 0, 1, – (don\'t care).', 'Do all six, then read the sum. Two terms of two literals each is the best this function allows.'],
        answer: `Set all six cells to – (don't care). The loops grow into them: ${E_DC.cost.text}.`,
        solve: () => km4?.set(E_DC_ROWS),
      },
      more: {
        derive: `<p>With the six rows free, the cells 0, 2, 8 and 10 form one loop of four (¬b·¬d, taking the don't care 10 as 1), and the cells 2, 6, 10 and 14 another (c·¬d, taking 10 and 14 as 1).
          Cell 10 is in both and is chosen 1, as is 14; the cells 11, 12, 13 and 15 are in no loop, so they come out 0. Segment e then lights for the codes 10 and 14 and stays dark for 11, 12, 13 and 15, a pattern nobody ever sees.</p>`,
        real: `<p>Don't cares are everywhere in control logic: an instruction that ignores a field, an output that nothing reads while a state is active, an encoding with unused codes. Synthesis tools take them from the designer's hints (<code>x</code> in Verilog's <code>case</code>, or a "don't care" input pattern).
          The campaign's control unit is full of them; its minimal terms are only that small because of them. State machines with unused state codes get the same treatment.</p>`,
        pitfall: `<p>Choosing don't cares and then reading them. If a faulty sensor or a noisy line does present code 13, the circuit does something specific and it is not defined by the spec. For anything safety-critical (or a counter that could be knocked into an unused state), the unused codes are assigned a safe next state instead, at the cost of the gates the don't cares saved.</p>`,
      },
    },
    {
      title: 'Products of sums, and NAND–NAND',
      body: `
        <p>A sum of products loops the 1s of the map. Loop the <em>0s</em> instead and each loop is a product term for ¬y, so ¬y is a sum of products, and by De Morgan y itself is a <strong>product of sums</strong>: an AND of OR factors, each factor with the loop's literals complemented.
        For the prime detector the 0s give <code>${PP.texts.join('')}</code>.</p>
        <p>In NAND gates a product of sums has no shape of its own: it is the sum of products of the 0s, then one NOT. Here that is <strong>${PP.cost.nands} NANDs</strong>, against ${PS.cost.nands} for the sum of products of the 1s: the 0s group better in this function (${PP.terms.length} loops of ${PP.cost.literals} literals in all, against ${PS.cost.literals}).
        Neither form always wins; the map shows both, and the cheaper one depends on how the 1s and 0s fall.</p>
        <p>Why does the sum of products fit NAND gates so well? Because x·y + z·w = ¬(¬(x·y)·¬(z·w)): each AND becomes a NAND and the OR becomes a NAND of those, and the inverters you would put between the levels cancel in pairs. <strong>NAND–NAND</strong> is the sum of products with nothing added; a product of sums needs the final inverter, or NOR–NOR in a technology where NOR is the cheap gate.</p>
        <p>Switch to <em>Product of sums</em> and read the factors; then open <em>Circuit</em> to see the NAND–NAND of the 0s.</p>`,
      widget: (stage) => kmapWidget({ ins: ABCD, out: 'y', rows: PRIME_ROWS, edit: '01', posToggle: true, circuitToggle: true, greedyToggle: true, stage, title: 'Both forms of the prime detector' }),
      challenge: {
        kind: 'quiz', question: 'A sum of products is built as two levels of NAND. How many inverters sit between the two levels?',
        options: ['None, because each AND is a NAND, the OR is a NAND, and the double inversions cancel', 'One per product term', 'One, after the OR', 'As many as the inputs'],
        answer: 0,
        why: ['',
          'That is the AND–OR drawing (a NAND is an AND followed by a NOT). De Morgan removes them: ¬¬ cancels.',
          'One inverter at the end is what a product of sums built from the sum of products of the 0s needs. A sum of products ends on its OR, which is the output NAND.',
          'Inputs may need their complement rails (¬a for a literal), but those sit before the first level, not between the two.'],
        explain: 'x·y + z·w = ¬(¬(x·y)·¬(z·w)): the first level is NANDs, the second is a NAND whose inputs are those outputs. The complements of the inputs, where a term needs them, are in front of the first level.',
      },
      more: {
        derive: `<p>y = ¬(¬y), and ¬y is the sum of products over the loops of 0s: ¬y = P₁ + P₂ + …. De Morgan: y = ¬P₁ · ¬P₂ · …, and each ¬Pᵢ is a sum of complemented literals. For the loop ¬b·¬c the factor is (b + c). A NAND–NAND of the same loops computes ¬y, one inverter gives y: ${PP.cost.nands} NANDs = ${PP.cost.nands - 1} + 1.</p>`,
        real: `<p>In CMOS a NOR is slower than a NAND of the same size (its PMOS transistors are in series), so libraries and synthesis favour NAND-heavy netlists, which is why NAND–NAND is the default shape here. A technology with fast NORs would build the product of sums as NOR–NOR instead.</p>`,
        pitfall: `<p>Complementing the factors wrongly. The loop of 0s ¬b·¬c is a term of ¬y; the factor of y is (b + c), not (¬b + ¬c). Check with a cell: b = 0, c = 0 is a 0 of the function, and (b + c) is 0 there, which makes the whole product 0 as it must.</p>`,
      },
    },
    {
      title: 'Minimal is not cheapest',
      body: `
        <p>A minimal sum of products is the cheapest <em>two-level</em> circuit. A circuit with more levels, or with gates shared between outputs, can do better. Three examples, each counted in NANDs:</p>
        <ul>
          <li><strong>XOR</strong>: the sum of products a·¬b + ¬a·b takes ${SHARE[0].two} NANDs. The previous chapter's XOR takes ${SHARE[0].better}, because one NAND, ¬(a·b), feeds both halves.</li>
          <li><strong>The prime detector</strong>: ${SHARE[1].two} NANDs as the minimal sum. The campaign's reference answer takes ${SHARE[1].better}: its lower half is a multiplexer you have built, and the upper half keeps only two of that multiplexer's ones. That is factoring, a three-level circuit.</li>
          <li><strong>Seven segments</strong>: each segment minimized alone, with the unused codes as don't cares, costs ${SHARE[2].two} NANDs in all. Minimized together, equal product terms are built once and used by several segments: ${SHARE[2].better}.</li>
        </ul>
        <p>Inside the two-level family there is a second catch. Finding the fewest loops is a search, and a <em>greedy</em> one (take the essential loops, then repeatedly the loop that covers the most 1s still uncovered) can pick a loop early that later turns out to be unnecessary. On the table below the exact cover takes ${G_EXACT.terms.length} loops and
        the greedy one ${G_GREEDY.terms.length}: ${G_EXACT.cost.nands} NANDs against ${G_GREEDY.cost.nands}.</p>
        <p>The map starts on the greedy cover. Switch to <em>Exact</em> and watch a loop disappear.</p>`,
      widget: (stage) => sharingWidget(stage),
      more: {
        derive: `<p>Where the greedy cover goes wrong, on this table: the loop ${G_EXACT.texts[0]} is essential (it alone covers the 1s at 8 and 12), so both covers start with it. The 1s left, at 3, 6, 7 and 11, can be covered by two loops, ${G_EXACT.texts[1]} and ${G_EXACT.texts[2]}.
          But several loops cover two of those four cells, none covers more, and greedy takes the first of the tie: ${G_GREEDY.texts.find((t) => !G_EXACT.texts.includes(t))}. That spoils the pair: the 1s at 3 and 7 are now covered, and 6 and 11 each need a loop of their own. An exact search (branch and bound over the primes, fewest terms and then fewest literals) tries the alternatives and keeps the best;
          lib/sop.ts gives up after ${EXACT_BUDGET.toLocaleString('en').replace(',', ' ')} steps and returns the greedy cover, flagging it "greedy: not proven minimal", which is what the widget prints.</p>`,
        real: `<p>Industrial minimizers (Espresso for two-level logic, ABC for multi-level netlists) use heuristics like the greedy one, with repairs: expand a loop, remove the redundant ones, reshape, repeat. They are fast on functions with thousands of inputs and rarely exact. Multi-level synthesis then factors common sub-expressions across outputs, which is where the saving in the seven-segment row comes from.</p>`,
        pitfall: `<p>Treating "minimal" as a property of the function. It is a property of the function <em>and</em> of the circuit family you allow. Two levels with no sharing is the family a Karnaugh map reads off; the cheapest circuit in all of NAND gates (the campaign's par for the prime detector) lives in a bigger family and is found by search, not by loops.</p>`,
      },
    },
    {
      title: 'A glitch in two-level logic',
      body: `
        <p>Chapter ${numOf('gates')}'s multiplexer is a two-level sum, <code>y = s·b + ¬s·a</code>. Hold <code>a = b = 1</code>: y should be 1 whatever s does. Now let s fall.
        The term <span data-show="sb">s·b</span> turns off one NAND delay after s changes, but <span data-show="nsa">¬s·a</span> turns on only after <span data-show="ns">the inverter</span> has made ¬s, one delay later still.
        For that one delay neither term is 1, and y drops to 0 and back up: a <strong>static-1 hazard</strong>. In this circuit y stays low for ${DIP} gate delay.</p>
        <p>On the map the two terms are loops that touch but do not overlap, and the dip happens in the hand-over between them. The cure is the loop that bridges them: the <strong>consensus term</strong> <code>a·b</code>, the one step 2 showed to be redundant.
        It changes no settled value, but it holds y at 1 while the other two terms hand over. It costs gates: the multiplexer grows from ${MUX_PLAIN_NANDS} to ${MUX_CONS_NANDS} NANDs (the output NAND gains a third input, which here is three 2-input NANDs).</p>
        <p>Whether a <span data-ahead="glitch">glitch (a change that does not last)</span> matters depends on what reads y. Anything that samples y only after the logic has settled never sees it. A reset line, or anything that treats its input as an edge, can: a pulse one delay wide is a pulse.
        The scene's <span data-show="ab">third term</span> is switched by the input <code>cons</code>.</p>
        <div class="try">With cons = 0, bring s down from 1 to 0 and watch y dip (the Timing panel records it).</div>
        <div class="try">Set cons = 1, raise s and bring it down again: y holds.</div>`,
      scene: () => {
        prevS = 1;
        return { root: MUX_HAZARD, inputs: { a: 1, b: 1, s: 1, cons: 0 }, animate: true, analyzer: true };
      },
      tries: [
        (st) => st.getInput('cons') === 0 && st.getInput('s') === 0 && st.getInput('a') === 1 && st.getInput('b') === 1,
        (st) => st.getInput('cons') === 1 && st.getInput('s') === 0 && st.getInput('a') === 1 && st.getInput('b') === 1,
      ],
      tour: {
        beats: [
          { title: 'Settled', set: { a: 1, b: 1, s: 1, cons: 0 }, show: ['sb', 'nsa', 'out'], expect: { y: 1 },
            say: '<p>s = 1, a = b = 1: the term <code>s·b</code> is 1 (its NAND outputs 0), <code>¬s·a</code> is 0, and y = {v:y}.</p>' },
          { title: 'Hand-over without the term', set: { s: 0 }, show: ['sb', 'ns', 'nsa', 'out'], expect: { y: 1 },
            say: '<p>s falls. After the transient y is {v:y} again, as it must be. But on the way, <code>s·b</code> went off a delay before <code>¬s·a</code> came on: step through it in slow motion, or read the Timing panel, to see y at 0 for one delay.</p>' },
          { title: 'With the consensus term', set: { s: 1, cons: 1 }, show: ['ab', 'out'], expect: { y: 1 },
            say: '<p>cons = 1 switches on <code>a·b</code>: its NAND outputs 0 whatever s does, and it keeps the output NAND at 1. Now lower s again and y never moves; the circuit has one term more, and the settled value is the same.</p>' },
        ],
      },
      challenge: {
        kind: 'reach', goal: 'Make y hold at 1 while s falls with a = b = 1: set cons = 1, then bring s down.',
        check: (st) => {
          const s = st.getInput('s'), fell = prevS === 1 && s === 0;
          prevS = s;
          // the fall seen on the stage, and the same fall replayed on a private GateSim: y never leaves 1
          return fell && st.getInput('a') === 1 && st.getInput('b') === 1 && st.getInput('cons') === 1 && dipWidth(muxRun({ a: 1, b: 1, cons: 1 }, 1, 0)) === 0;
        },
        hints: ['First watch the problem: with cons = 0, bring s down in slow motion and see y dip for one delay.', 'cons switches on the third term, a·b. Set it to 1, then return s to 1 and lower it again.'],
        answer: 'Set cons = 1 (the term a·b) with a = b = 1, raise s to 1 if it is not, and bring it down: y stays 1 throughout.',
        solve: (st) => { st.setInputs({ a: 1, b: 1, cons: 1, s: 1 }); st.setInput('s', 0); },
      },
      more: {
        derive: `<p>Timing, with one unit per NAND: at t = 0 s falls. At 1, <code>sb</code> rises (the term s·b is off) and <code>ns</code> rises. At 2, <code>nsa</code> falls (¬s·a is on). During t = 1 to 2 both term inputs of the output gate are 1, which is the gap. The output gate is three 2-input NANDs here, so y itself falls at t = ${RUN.edges[0]?.t} and rises at t = ${RUN.edges[1]?.t}: ${DIP} delay wide. With cons = 1 the third input is 0 for the whole time and y never changes.
          The rule: a two-level circuit can have a static-1 hazard whenever two adjacent 1s of the map are covered by different loops, and the cure is a loop that covers both. Static-0 hazards (a glitch up) are the dual, for a product of sums.</p>`,
        real: `<p>Synchronous design avoids the question: every flip-flop samples after the combinational logic has settled, so the glitch is invisible unless it is still moving at the clock edge (that is the setup time). It matters in asynchronous corners: a reset, a clock-gating enable, a latch enable, an input that a flip-flop treats as a clock.
          Many synthesis flows leave glitches in: removing them costs the extra term, and the tool does not know which outputs are asynchronous unless it is told. Here the extra term takes ${MUX_CONS_NANDS - MUX_PLAIN_NANDS} NANDs in this brick; in a real library it is one NAND2 and a wider output gate.</p>`,
        pitfall: `<p>Letting a minimizer remove the consensus term. A tool that minimizes logic will strip the third term as redundant, since it changes no output; the glitch then comes back. Either the design marks it as needed (keep/don't-touch attributes), or builds the term where the minimizer cannot see it. Redundancy for hazards is the one case where "redundant" logic is there on purpose.</p>`,
      },
    },
    {
      title: 'Your own: a 7-segment digit',
      body: `
        <p>The pieces so far make the display driver of a digital clock or a pocket calculator: a 4-bit <span data-ahead="bcd">BCD digit (binary-coded decimal: one decimal digit, 0 to 9, in four bits)</span> in, seven lamp lines out (<code>a</code> the top bar, <code>b</code> top right, round to <code>g</code> in the middle).
        The font is fixed for the digits 0 to 9 (6 with its top bar, 7 without the upper left, 9 with its bottom bar). The codes 10 to 15 never occur.</p>
        <p>Left alone (dark in all six unused rows) the seven segments cost <strong>${SEG_ZERO.nands} NANDs</strong> with equal terms shared between segments. Marking the unused rows as don't cares costs <strong>${SEG_DC.nands}</strong> (${SEG_DC.terms} distinct product terms, ${SEG_DC.literals} literals). Your decisions about rows 10 to 15, segment by segment, are the design.</p>
        <p>The table below is the sandbox's truth-table chip in small. To take a design further, build the same table there with <a href="#/sandbox/new/table">New chip, Truth table</a>: it draws the circuit, shares the terms and shows each output's map.</p>`,
      widget: (stage) => {
        seg8 = segmentLab(stage);
        return seg8;
      },
      challenge: {
        kind: 'reach', goal: `Get all seven segments down to ${SEG_BUDGET()} NANDs by choosing what rows 10 to 15 show: that is what don't cares reach.`,
        check: () => { const st = seg8?.state(); return !!st && st.ok; },
        hints: ['The six unused rows start dark (0), which is the most expensive choice. Each cell cycles 0, 1, – (don\'t care).', `Every unused cell can be –. The budget is exactly that design: ${SEG_BUDGET()} NANDs. Any other choice that reaches it also passes.`],
        answer: `Set all 42 cells of rows 10 to 15 to – . The seven segments then share ${SEG_DC.terms} product terms and cost ${SEG_DC.nands} NANDs, against ${SEG_ZERO.nands} with the unused codes dark.`,
        solve: () => seg8?.set(Array(7).fill(SEG_FILL)),
      },
      more: {
        derive: `<p>The seven equations (with every unused row a don't care), as the sandbox's truth-table chip draws them:</p><p>${SEG_DC.text.map((t) => `<code>${t}</code>`).join('<br>')}</p>
          <p>Several of them reuse the same few product terms, which is what the sharing saves. The four inputs are called w x y z here, w the high bit of the digit.</p>`,
        real: `<p>A real display driver is this table (or a ROM of 16 words of 7 bits) plus a current-limiting resistor per lamp; the classic 7447 and 4511 chips are exactly this decoder with extra lines for blanking and lamp test. Fonts differ: some show the 6, 7 and 9 with different bars, and the table changes with them. An LED digit needs about 10 mA a segment, which is the real cost; the gates are the cheap part.</p>`,
        pitfall: `<p>Reading the display for an unused code and trusting it. Row 10 shows whatever the chosen loops produce: a stray lamp pattern that changes if the designer changes any don't care choice. A counter that can reach code 12 (a glitch, a bad reset) shows garbage until it counts on; if that must not happen, the unused rows are assigned dark, and the circuit pays for it.</p>`,
      },
    },
  ],
};
