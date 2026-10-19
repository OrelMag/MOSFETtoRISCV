// Check yourself questions for codex entries (see codexcheck.ts), group 1. No DOM.

import type { Quiz } from '../chapters/types';

export const CHECK1: Record<string, Quiz[]> = {
  // ---- laws
  universality: [
    {
      question: 'You have only 2-input NOR gates. Which circuit computes a·b?',
      options: ['NOR(NOR(a, b), NOR(a, b))', 'NOR(NOR(a, a), NOR(b, b))', 'None: NOR, like OR, cannot make an AND'],
      answer: 1,
      explain: 'NOR(a, a) = ¬a, and NOR(¬a, ¬b) = ¬(¬a + ¬b) = a·b by De Morgan: 3 NORs, the dual of OR from 3 NANDs.',
      why: ['NOR(x, x) inverts x, so this is ¬NOR(a, b) = a + b: an OR, not an AND.', '', 'NOR contains an inversion, which is what OR lacks: it is complete by the same argument as NAND, through duality.'],
    },
    {
      question: 'Why can no circuit of AND and OR gates, even with the constants 0 and 1 available, compute ¬a?',
      options: ['It can, with enough levels: two levels are just too few', 'Without a constant 1 there is nothing to invert against', 'Both gates are monotone: raising an input never lowers an output, and ¬a falls when a rises'],
      answer: 2,
      explain: 'A composition of monotone functions is monotone, and ¬a is not, so no depth helps. One inverting gate (NAND, NOR) is what completes the set.',
      why: ['Depth does not matter: any composition of monotone gates is still monotone.', 'The constants were given, and AND(a, 1) and OR(a, 0) are still just a: a constant cannot add an inversion.', ''],
    },
  ],
  duality: [
    {
      question: '<code>a + ¬a·b = a + b</code> is an identity. Which is its dual?',
      options: ['a·¬a + b = a·b', '¬a·(¬a + ¬b) = ¬a·¬b', 'a·(¬a + b) = a·b', '¬(a + ¬a·b) = ¬(a + b)'],
      answer: 2,
      explain: 'Swap + with · (keeping the grouping) and 0 with 1; literals stay as they are. a·(¬a + b) = a·¬a + a·b = a·b, so the dual holds too.',
      why: ['The dual keeps the structure: ¬a·b was a group, so ¬a + b must stay one. a·¬a + b is just b.', 'That also complements the literals: the dual leaves a and ¬a as they are.', '', 'That is the complement of both sides, true but a different identity; the dual inverts no literal and no side.'],
    },
    {
      question: 'A CMOS gate\'s pull-down is (NMOS a ∥ NMOS b) in series with NMOS c. What is its pull-up, and what does the gate compute?',
      options: ['(PMOS a ∥ PMOS b) in series with PMOS c; y = ¬((a + b)·c)', 'PMOS a in series with PMOS b, that pair in parallel with PMOS c; y = ¬((a + b)·c)', 'PMOS a in series with PMOS b, that pair in parallel with PMOS c; y = (a + b)·c'],
      answer: 1,
      explain: 'The pull-up is the dual of the pull-down (series ↔ parallel) and conducts exactly when the pull-down does not; the pull-down conducts on (a + b)·c, pulling y to 0. One stage, 6 transistors.',
      why: ['A copy of the pull-down conducts on (¬a + ¬b)·¬c, which is not the complement: for a = b = 0, c = 1 neither network conducts and y floats.', '', 'The pull-down pulls y to 0 when (a + b)·c, so the gate inverts: a single CMOS stage is always inverting.'],
    },
  ],
  identities: [
    {
      question: 'Simplify <code>f = a·¬b + ¬a·¬b + ¬a·b</code>.',
      options: ['¬b', '¬a·¬b', 'It is already minimal: three terms', '¬a + ¬b: one NAND'],
      answer: 3,
      explain: 'Complement on the first two gives ¬b, on the last two ¬a, and both may use ¬a·¬b: f = ¬a + ¬b = ¬(a·b). It is 0 only on a = b = 1.',
      why: ['Merging the first two terms gives ¬b, but ¬a·b (a = 0, b = 1) is still 1 and is now uncovered.', 'That applies De Morgan wrongly: ¬a·¬b is 1 on one row, f on three.', 'Terms differing in one variable merge, and a term may be used in two merges (idempotence): here both pairs do.', ''],
    },
    {
      question: 'Which term of <code>x·¬y + y·z + x·z</code> can be removed without changing the function?',
      options: ['x·¬y', 'x·z', 'y·z', 'None of them'],
      answer: 1,
      explain: 'x·z is the consensus of x·¬y and y·z: whenever x = z = 1, either y = 0 (x·¬y) or y = 1 (y·z) already covers it.',
      why: ['x = 1, y = 0, z = 0 makes only x·¬y true: removing it loses that row.', '', 'x = 0, y = 1, z = 1 makes only y·z true: removing it loses that row.', 'The consensus term x·z is redundant in the truth table (though keeping it can stop a glitch).'],
    },
  ],
  demorgan: [
    {
      question: 'Push the inversion all the way in: <code>¬(a + b·¬c)</code> = ?',
      options: ['¬a + ¬b·c', '¬a·¬b·c', '¬a·(¬b + c)', 'a·(b + ¬c)'],
      answer: 2,
      explain: 'Outer: ¬(a + X) = ¬a·¬X. Inner: ¬(b·¬c) = ¬b + c. Every literal complemented, every operator swapped.',
      why: ['The literals were complemented but the operators kept: the + and the · must swap too.', 'The outer + became ·, but the inner · must become + as well: ¬(b·¬c) is ¬b + c.', '', 'Swapping the operators without complementing the literals gives the dual, not the complement.'],
    },
    {
      question: 'Drawn as an OR gate, a NAND gate has bubbles where?',
      options: ['On both inputs: NAND(a, b) = ¬a + ¬b', 'On the output: an OR followed by an inverter', 'On one input only'],
      answer: 0,
      explain: '¬(a·b) = ¬a + ¬b: the same physical gate is an AND with an inverted output or an OR with inverted inputs, which is what bubble pushing exploits.',
      why: ['', 'An OR with an inverted output is a NOR: ¬(a + b) = ¬a·¬b.', 'One inverted input gives ¬a + b, an implication, not a NAND.'],
    },
  ],
  cpi: [
    {
      question: 'Two hypothetical designs run the same program. A: CPI 1.0, period 100 delays. B: CPI 1.3, period 60 delays. Which is faster?',
      options: ['A: its CPI is lower', 'B: 78 delays per instruction against 100', 'B, by 40 %: its period is 40 % shorter', 'They tie'],
      answer: 1,
      explain: 'Time per instruction is CPI × period: 1.3 × 60 = 78 against 1.0 × 100 = 100, so B takes 22 % less time.',
      why: ['A lower CPI loses if its period is longer by more: only the product counts.', '', 'That ignores B\'s 30 % more cycles per instruction.', 'The products differ: 78 against 100.'],
    },
    {
      question: 'A multiply instruction cuts a program\'s instruction count by 30 % but lengthens the clock period by 10 %; CPI is unchanged. The new run time is?',
      options: ['0.80 of the old: 30 % − 10 %', '1.1 of the old: the clock is slower', '0.70 of the old: with CPI unchanged the period does not matter', '0.77 of the old: 23 % less'],
      answer: 3,
      explain: 'The factors multiply: 0.7 × 1.0 × 1.1 = 0.77.',
      why: ['The factors multiply, they do not add: 0.7 × 1.1 = 0.77.', 'Every instruction gets 10 % slower, but there are 30 % fewer of them.', 'Time is count × CPI × period: the period is a factor whatever CPI does.', ''],
    },
  ],
  edgefn: [
    {
      question: 'An edge runs from (8, 8) to (40, 24) in quarter pixels. At one pixel\'s centre its E (before the top-left bias) is 64. What is E at the centre of the pixel to its right?',
      options: ['192', '48', '0'],
      answer: 2,
      explain: 'A = y<sub>i</sub> − y<sub>i+1</sub> = 8 − 24 = −16, and one pixel is 4 quarter pixels: E changes by 4A = −64, so 64 − 64 = 0, on the edge.',
      why: ['That adds 4B = 128, the step for one pixel down, not right.', 'That adds A, a step of one quarter pixel; a whole pixel is 4A.', ''],
    },
    {
      question: 'For every pixel inside a triangle\'s outline, all three edge functions come out negative. What does that mean?',
      options: ['The vertices are wound the other way: the triangle shows its back, and a renderer drawing only front faces skips it', 'The triangle has zero area', 'Those pixels are outside the triangle', 'The top-left bias has the wrong sign'],
      answer: 0,
      explain: 'Reversing the winding negates every A and B, so all three E flip sign together; ≥ 0 on all three is the front-face test.',
      why: ['', 'With zero area the three E (before the bias) sum to 0 everywhere, so they cannot all be negative.', 'A pixel outside a front-facing triangle has at least one negative E but not all three: all three negative needs the reversed winding.', 'The bias is −1 on some edges: it settles pixels exactly on an edge, never whole triangles.'],
    },
  ],
  // ---- tools
  truthtable: [
    {
      question: 'A block takes an 8-bit a, an 8-bit b and a 3-bit operation select. How many rows has its truth table, and how does the campaign\'s Check test it?',
      options: ['2^19 = 524 288, every one: Check is always exhaustive', '2^19 = 524 288: beyond 16 input bits, so directed cases plus 4 096 random vectors', '2^8 + 2^8 + 2^3 = 520: each input is tested separately'],
      answer: 1,
      explain: '8 + 8 + 3 = 19 input bits give 2<sup>19</sup> rows. Check runs every row up to 16 input bits; beyond that, directed cases and random vectors.',
      why: ['Exhaustive checking stops at 16 input bits (65 536 rows).', '', 'Rows are combinations of all inputs together: the counts multiply, they do not add.'],
    },
    {
      question: 'Why can a truth table not specify a counter?',
      options: ['Its table would have too many rows', 'It has more outputs than inputs', 'It has state: the same inputs give different outputs on different cycles, so it needs a sequence'],
      answer: 2,
      explain: 'A truth table maps inputs to outputs. A counter\'s output depends on its history, so its specification is a sequence (or a state table with the state as an input).',
      why: ['A 4-bit counter with an enable has few inputs; the problem is not size but that the output is not a function of the inputs.', 'Many combinational blocks (a decoder) have more outputs than inputs and still have a truth table.', ''],
    },
  ],
  sop: [
    {
      question: 'f(a, b, c) is 1 on rows 000, 001, 101 and 111. Its minimum sum of products is?',
      options: ['¬a·¬b + ¬b·c + a·c', '¬a·¬b·¬c + ¬a·¬b·c + a·¬b·c + a·b·c', '¬a·¬b + a·c', '¬b + c'],
      answer: 2,
      explain: '000 + 001 merge to ¬a·¬b, 101 + 111 to a·c, and together they cover all four 1s. ¬b·c (001 + 101) is a prime implicant too, but redundant.',
      why: ['All three are prime implicants, but ¬b·c covers only 1s the other two already cover: the minimum cover drops it.', 'That is the canonical form: correct, but nothing has been merged.', '', 'That covers 100 (¬b = 1) and 011 (c = 1), where f is 0: merged too far.'],
    },
    {
      question: 'A 4-input function is 1 on 14 rows and 0 on 2. Which form starts smaller?',
      options: ['The product of sums: one maxterm per 0 row, two in all', 'The sum of products: it is always the smaller form', 'Neither: SoP and PoS are duals, so they are the same size'],
      answer: 0,
      explain: 'The canonical SoP has one term per 1 row (14), the canonical PoS one per 0 row (2). Minimization shrinks both, but the PoS starts with far less.',
      why: ['', 'SoP grows with the 1s; with few 0s the PoS is the natural form.', 'Duality pairs identities, not the sizes of one function\'s two forms: 14 minterms against 2 maxterms.'],
    },
  ],
  kmap: [
    {
      question: 'On a 4-variable K-map (rows a b, columns c d, both in Gray order) the only 1s are the four corner cells. The minimum expression is?',
      options: ['Four separate minterms: corners are not adjacent', '¬b·¬d', '¬a·¬b·¬d + a·¬b·¬d'],
      answer: 1,
      explain: 'The map wraps both ways, so the four corners form one 2 × 2 rectangle: b = 0 and d = 0 throughout, a and c change.',
      why: ['Left and right columns are neighbours, and so are top and bottom rows: the corners touch through both wraps.', '', 'That uses only the column wrap: the two pairs are themselves neighbours through the row wrap and merge into ¬b·¬d.'],
    },
    {
      question: 'What goes wrong if the columns of a K-map are labelled 00, 01, 10, 11?',
      options: ['Nothing: any order works as long as all cells are there', 'Only the wrap-around between the first and last columns breaks', 'Cells 01 and 10 sit side by side but differ in two variables, so a rectangle across them is no product term'],
      answer: 2,
      explain: 'Gray order (00, 01, 11, 10) is what makes touching cells differ in one variable; binary order breaks that in the middle and at the wrap.',
      why: ['Adjacency is the whole method: in binary order some neighbours differ in two variables and the rectangles lie.', 'The middle pair 01 | 10 breaks too, not only the wrap 11 | 00.', ''],
    },
  ],
  qm: [
    {
      question: 'In Quine–McCluskey, which pair of implicants merges?',
      options: ['1-01 and -101, into --01', '1-00 and 0-11, into --0-', '1-01 and 0-01, into --01'],
      answer: 2,
      explain: 'Two implicants merge when their dashes sit in the same positions and they differ in exactly one other bit.',
      why: ['Their dashes are in different positions: they differ in two places.', 'They differ in three bits; only a one-bit difference merges.', ''],
    },
    {
      question: 'Run Quine–McCluskey on f(a, b, c) with minterms 0, 1, 2, 3 and 7. The result?',
      options: ['¬a·¬b + ¬a·b + b·c', '¬a + b·c', '¬a + c'],
      answer: 1,
      explain: 'Round 1: 00-, 0-0, 0-1, 01-, -11. Round 2: 00- with 01- (and 0-0 with 0-1) gives 0--. -11 merges with nothing. Primes ¬a and b·c, both essential.',
      why: ['That stops after the first round: 00- and 01- still merge, into 0-- = ¬a.', '', 'c would cover 5 = 101, which is not a minterm: 7 merges only with 3.'],
    },
  ],
  cla: [
    {
      question: 'a = 1011, b = 0101, c<sub>0</sub> = 0. What are g, p and c<sub>4</sub>?',
      options: ['g = 0001, p = 1111, c4 = 1', 'g = 0001, p = 1110, c4 = 1', 'g = 0001, p = 1110, c4 = 0'],
      answer: 1,
      explain: 'g = a·b = 0001, p = a ⊕ b = 1110. Bit 0 generates and bits 1–3 propagate it: c<sub>4</sub> = p<sub>3</sub>p<sub>2</sub>p<sub>1</sub>g<sub>0</sub> = 1 (11 + 5 = 16, sum 0000).',
      why: ['That is p = a + b. OR works in the carry recurrence, but the sum is p ⊕ c, and with this p it comes out 0001, wrong.', '', 'c<sub>4</sub> does not need g<sub>3</sub>: the term p<sub>3</sub>p<sub>2</sub>p<sub>1</sub>g<sub>0</sub> carries bit 0\'s carry through.'],
    },
    {
      question: 'The site\'s flat 4-bit lookahead adder is 106 NANDs and 15 delays; the ripple adder is 36 and 12. Why does lookahead lose here?',
      options: ['From 2-input NANDs every wide AND and OR of the expansion becomes a tree, so the "two levels" are neither cheap nor shallow', 'Lookahead is slower in principle; only ripple scales well', 'Its propagate uses XOR, which is slow; p = a + b would fix it'],
      answer: 0,
      explain: 'c<sub>4</sub> needs 5-input ANDs and a 5-input OR, which 2-input NANDs build as trees. Lookahead pays once the expansion is organized as a tree over spans: the prefix adders.',
      why: ['', 'Lookahead organized as a prefix tree is log<sub>2</sub> n deep against ripple\'s n; it is the flat expansion that does not pay at 4 bits.', 'OR would serve the carry terms, but the sum still needs a ⊕ b, and the wide gates are where the depth comes from.'],
    },
  ],
  prefix: [
    {
      question: 'The upper span propagates (G = 0, P = 1), the lower one generates (G = 1, P = 0). What is the combined span?',
      options: ['(1, 1)', '(0, 1): the upper span decides', '(G, P) = (1, 0): it generates'],
      answer: 2,
      explain: '(g<sub>hi</sub> + p<sub>hi</sub>·g<sub>lo</sub>, p<sub>hi</sub>·p<sub>lo</sub>) = (0 + 1·1, 1·0) = (1, 0): the lower part makes a carry and the upper part passes it on.',
      why: ['P of the combined span is p<sub>hi</sub>·p<sub>lo</sub>: the lower part does not propagate, so neither does the whole.', 'The upper span passes on whatever the lower one generates: G = g<sub>hi</sub> + p<sub>hi</sub>·g<sub>lo</sub> = 1.', ''],
    },
    {
      question: 'Why does the cell for a span that reaches bit 0 compute only G, not P?',
      options: ['P is always 0 for such a span', 'G[i:0] already is the carry into bit i + 1 and nothing lies below bit 0, so P is never used: a gray cell (3 NANDs) instead of a black one (5)', 'Bit 0 has no propagate signal'],
      answer: 1,
      explain: 'Once a span reaches bit 0 (with the carry-in folded into g<sub>0</sub>), its G is final; any later cell it feeds also reaches bit 0 and needs only G from it.',
      why: ['P[i:0] is 1 whenever every bit propagates (0111 + 1000): it is unused, not zero.', '', 'Bit 0 has p<sub>0</sub> = a<sub>0</sub> ⊕ b<sub>0</sub> like every bit; it is simply not needed for a span with nothing below it.'],
    },
  ],
  fsm: [
    {
      question: 'A controller has 9 states. How many flip-flops do binary and one-hot encodings need?',
      options: ['Binary 3, one-hot 9', 'Binary 4, one-hot 9', 'Binary 4, one-hot 4'],
      answer: 1,
      explain: 'Binary needs ⌈log<sub>2</sub> 9⌉ = 4 (3 bits give only 8 codes); one-hot uses one flip-flop per state.',
      why: ['log<sub>2</sub> 9 ≈ 3.17 must round up: 3 flip-flops have 8 codes for 9 states.', '', 'One-hot means exactly one bit set per state, so it needs as many bits as states.'],
    },
    {
      question: 'The 1-0-1 detector\'s output is y = x·s1, where x is the input. What does that make it, and what follows?',
      options: ['Moore: it depends on a state bit', 'A design error: outputs may depend only on the state', 'Mealy: y rises in the same cycle the final 1 arrives, and follows (and glitches with) x'],
      answer: 2,
      explain: 'An output that reads the inputs directly is Mealy: one cycle earlier and with fewer states than a Moore machine, but not stable for the whole cycle.',
      why: ['Moore outputs depend on the state alone; reading x as well makes it Mealy.', 'Mealy machines are legitimate; the caution is only not to feed their outputs to logic that needs them stable all cycle.', ''],
    },
  ],
  assembly: [
    {
      question: 'How does the RV16 assembler expand <code>li a1, 300</code>? (lui\'s operand counts units of 64; addi\'s immediate is −32…31.)',
      options: ['lui a1, 4 (256), then addi a1, a1, 44', 'lui a1, 5 (320), then addi a1, a1, −20', 'addi a1, x0, 300: one instruction', 'lui a1, 300'],
      answer: 1,
      explain: '300 = 256 + 44, but 44 does not fit a sign-extended 6-bit immediate (bit 5 is set), so the high part rounds up: 320 − 20.',
      why: ['44 is outside −32…31: addi sign-extends its 6 bits, so the low part must be negative and the high part rounded up.', '', '300 does not fit 6 bits: li is one word only for −32…31 or values whose low 6 bits are zero.', 'lui sets only the upper 10 bits (its operand is 0…1023, worth × 64), and 300 has low bits set.'],
    },
    {
      question: '<code>beq a0, a1, done</code> sits at address 12 and <code>done</code> is at address 7. What offset does the assembler encode?',
      options: ['−6', '7', '−5'],
      answer: 2,
      explain: 'RV16 offsets are relative to the branch itself: target − pc = 7 − 12 = −5, which fits the 6-bit range −32…31.',
      why: ['That measures from the next instruction (pc + 1); RV16 adds the offset to the branch\'s own address.', 'Branches encode a displacement, not the absolute address.', ''],
    },
  ],
  shiftadd: [
    {
      question: '15 × 15 on the 4-bit sequential multiplier. After step 1 the register is 0111 1111. What happens in step 2?',
      options: ['The carry is dropped: 0011 0111', 'The register needs a fifth upper bit, or the product is wrong', '0111 + 1111 = 1 0110: the carry enters at the top as the register shifts, giving 1011 0111'],
      answer: 2,
      explain: 'The low bit is 1, so a = 1111 is added to the upper half; the 5-bit sum shifts right with its carry entering the top. Two more steps give 1110 0001 = 225.',
      why: ['Dropping the adder\'s carry loses a bit of weight 2<sup>4</sup> in the upper half: the product comes out wrong.', 'No extra bit is needed: the carry is used at once, when the register shifts right.', ''],
    },
    {
      question: 'Why does the sequential multiplier save area only at larger widths?',
      options: ['At 8 bits it is no smaller than the array (633 against 632 NANDs) and takes 8 steps; at 16 it is 1 169 against 2 672', 'It is always smaller, just slower', 'Its adder grows with the square of the width'],
      answer: 0,
      explain: 'The array grows with n<sup>2</sup>, the sequential unit with n (an adder, a 2n-bit register, control), so the register and control overhead pays off only once n is large.',
      why: ['', 'At 8 bits the two are the same size: the register and control cost as much as the array\'s extra rows.', 'The adder is n bits wide; it is the array multiplier that grows with n<sup>2</sup>.'],
    },
  ],
  bpred: [
    {
      question: 'A loop of 5 iterations is run over and over: its closing branch is taken 4 times, then falls through. With a warm 2-bit counter and the RV16 pipeline (2 cycles per redirect), what does each run cost?',
      options: ['2 mispredictions, 4 cycles', '1 misprediction, 2 cycles', '4 mispredictions, 8 cycles'],
      answer: 1,
      explain: 'The exit moves the counter from strongly to weakly taken, so it still predicts taken when the loop is entered again: only the exit mispredicts.',
      why: ['That is 1-bit history: the exit flips it to not taken, and the first iteration of the next run mispredicts too.', '', 'That is predict-not-taken: every taken branch is a miss.'],
    },
    {
      question: 'Why does predicting "taken" need a branch target buffer to pay off?',
      options: ['The BTB holds the direction; the counters alone cannot predict', 'It does not: a 2-bit counter alone redirects fetch in F', 'Without it the target is known only after decode, so even a correct taken guess loses a cycle'],
      answer: 2,
      explain: 'Fetch needs the next PC in the same cycle; the BTB, indexed by the PC, supplies the target before the branch is even decoded.',
      why: ['The counters hold the direction; the BTB stores the target.', 'A counter says "taken" but not where to: the target comes from decoding the instruction, a cycle later.', ''],
    },
  ],
  division: [
    {
      question: 'Restoring division of 11 by 3 on 4 bits (dividend 1011). Quotient and remainder?',
      options: ['q = 0011, r = 2', 'q = 0100, r = 1', 'q = 0011, r = 5'],
      answer: 0,
      explain: 'r = 1, 2 (q bits 0, 0), then 5 − 3 = 2 (1), then 5 − 3 = 2 (1): q = 0011 = 3, r = 2, and 3 · 3 + 2 = 11.',
      why: ['', 'That feeds the dividend from its low bit (the bits 1, 1, 0, 1): long division consumes it from the top.', '5 is 2r + bit in the last step before the subtraction; the remainder is what is kept after it.'],
    },
    {
      question: 'RV16 executes <code>divu</code> with 100 in rs1 and 0 in rs2. What happens?',
      options: ['An illegal-instruction trap', 'rd = 0xFFFF (all ones); remu would give 100', 'rd = 0'],
      answer: 1,
      explain: 'Like RISC-V, RV16 does not trap on division by zero: the quotient is all ones and the remainder is the dividend, and the divider must produce exactly that.',
      why: ['RISC-V defines division by zero instead of trapping; software checks for it if it cares.', '', 'The restoring algorithm with divisor 0 never borrows, so every quotient bit is 1: all ones, as specified.'],
    },
  ],
  microcode: [
    {
      question: 'A controller has 24 states and 18 control signals. Microcoded like chapter 23\'s (control bits, a next-address field, 2 sequencing bits), how wide is a microword?',
      options: ['20 bits: 18 + 2, the micro-PC simply counts', '44 bits: 18 + a 24-bit one-hot next state + 2', '25 bits: 18 + 5 + 2'],
      answer: 2,
      explain: 'The next-address field must name any of 24 words: ⌈log<sub>2</sub> 24⌉ = 5 bits. Chapter 23\'s 13 states take 4 by the same rule.',
      why: ['This design stores the next address in the word; a counting micro-PC is another design, and it still needs a jump field for branches.', 'A ROM address is binary: one-hot would waste 19 bits of every word.', ''],
    },
    {
      question: 'In the multicycle microcode, how does a load get from Decode to MemAdr?',
      options: ['Decode\'s sequencing field says dispatch: the opcode indexes the dispatch ROM, which selects MemAdr', 'Decode\'s next-address field holds MemAdr', 'The micro-PC increments from Decode to the next word'],
      answer: 0,
      explain: 'Decode is shared by every instruction, so its successor depends on the opcode: a dispatch through a second ROM. After that, each word names its successor.',
      why: ['', 'Then every instruction would go to MemAdr after Decode: a fixed field cannot depend on the opcode.', 'The words follow by their next-address fields; and after Decode the path depends on the opcode, which a counter cannot see.'],
    },
  ],
  // ---- tricks
  bubble: [
    {
      question: 'Bubble-push <code>y = a·b + c·d</code>, built as two ANDs and an OR (7 NANDs). What is left?',
      options: ['NAND(NAND(a, b), NAND(c, d)) plus an inverter: it computes ¬y', 'NAND(NAND(a, b), NAND(c, d)): 3 NANDs', 'NOR(NAND(a, b), NAND(c, d))'],
      answer: 1,
      explain: 'Each AND\'s output bubble meets one of the OR\'s input bubbles and they cancel: the OR becomes a NAND of the two NANDs.',
      why: ['NAND(¬(a·b), ¬(c·d)) = a·b + c·d already: the bubbles cancelled in pairs, none is left over.', '', 'A NOR of the two NANDs is ¬(¬(a·b) + ¬(c·d)) = a·b·c·d: the bubbles moved without flipping OR into AND.'],
    },
    {
      question: 'You push a bubble backward onto a wire that also feeds two other gates. What follows?',
      options: ['Nothing: a bubble only affects the gate it was pushed into', 'The two extra readers cancel it', 'Those two gates now receive the inverted value, so each needs a compensating bubble (an inverter) unless it can absorb it'],
      answer: 2,
      explain: 'A bubble on a net inverts the signal for every reader. Pushing through a fan-out point only pays when the other readers can take the inversion too.',
      why: ['The bubble moved onto the wire, and every gate on that net reads the wire.', 'Bubbles cancel in pairs on one path; the other readers each see one inversion.', ''],
    },
  ],
  nandnand: [
    {
      question: 'Which circuit computes <code>f = a + ¬b·c</code>?',
      options: ['NAND(a, NAND(¬b, c))', 'OR(¬a, NAND(¬b, c))', 'NAND(¬a, NAND(¬b, c))'],
      answer: 2,
      explain: 'Each product term becomes a NAND; a single-literal term a enters the final NAND as ¬a. NAND(¬a, ¬(¬b·c)) = a + ¬b·c: 4 NANDs with the two inverters.',
      why: ['The single-literal term needs its inverter: NAND(a, …) gives ¬a + ¬b·c.', 'The second level must be a NAND: an OR of the inverted terms computes a different function.', ''],
    },
    {
      question: 'XOR from its minimized SoP, ¬a·b + a·¬b, as NAND–NAND is 5 NANDs; the library\'s XOR is 4. Why does NAND–NAND not find the 4?',
      options: ['The SoP was not minimal', 'NAND–NAND only turns a given SoP into gates; the 4-NAND XOR shares NAND(a, b) between both terms, a multi-level form no SoP describes', 'Bubble pushing was left unfinished: an inverter remains'],
      answer: 1,
      explain: 'Two-level logic fixes the structure; sharing a subexpression across terms (n = NAND(a, b) feeding both) takes three levels and no literal inverters.',
      why: ['Neither term can merge or drop a literal: that SoP is minimal.', '', 'The two inverters are for the complemented literals ¬a and ¬b, which a two-level form cannot avoid.'],
    },
  ],
  dontcare: [
    {
      question: 'f(a, b, c) is 1 on rows 001 and 011, a don\'t-care on 101 and 111, and 0 elsewhere. The minimum expression?',
      options: ['¬a·c', 'c', '¬a·c + a·c'],
      answer: 1,
      explain: 'Taking both don\'t-cares as 1 makes the group 001, 011, 101, 111: the whole c = 1 half, one literal.',
      why: ['Correct, but it treats the don\'t-cares as 0 and keeps a literal it did not need.', '', 'Don\'t-cares need no cover of their own; here they simply join the group, which becomes c.'],
    },
    {
      question: 'For an RV16 <code>beq</code>, which control signal must be exact rather than a don\'t-care?',
      options: ['The ALU operand select (bimm)', 'The result select', 'The register write enable: it must be 0'],
      answer: 2,
      explain: 'A wrong write enable changes state (it writes whatever register the bits in the rd position name). Signals whose values nobody observes may be anything.',
      why: ['A branch\'s comparator reads rs2 directly, so the ALU\'s second operand is unobserved.', 'Nothing is written, so the choice of result is unobserved.', ''],
    },
  ],
  subtract: [
    {
      question: '3 − 9 at 8 bits through a + ¬b + 1. What are the sum and the carry out?',
      options: ['0xF9 (−7), carry out 0', '0xFA (−6), carry out 1', '0xFA (−6), carry out 0: a borrow, 3 < 9 unsigned'],
      answer: 2,
      explain: '0x03 + 0xF6 + 1 = 0xFA, below 0x100, so no carry out; carry 0 after a + ¬b + 1 means a borrow.',
      why: ['That is a + ¬b without the carry in: a − b − 1, the ones\' complement difference.', '3 + 246 + 1 = 250 does not reach 256: there is no carry out.', ''],
    },
    {
      question: '0x70 − 0x90 at 8 bits (112 − (−112) as signed). How is the overflow seen?',
      options: ['Carry out 0, so no overflow', 'Carry into the top bit 1, carry out 0: 1 ⊕ 0 = 1, overflow', 'Carry out 0 means a borrow, so the signed result overflowed'],
      answer: 1,
      explain: '0x70 + 0x6F + 1 = 0xE0: negative, though the true answer is 224. The carry into bit 7 is 1 and out of it 0; their XOR flags signed overflow.',
      why: ['The carry out answers the unsigned question, not the signed one.', '', 'Borrow and signed overflow are different events: 3 − 9 borrows without overflowing.'],
    },
  ],
  flags: [
    {
      question: 'a = 0x7FFF, b = 0xFFFF at 16 bits. From a + ¬b + 1, what are sltu and slt?',
      options: ['sltu = 1, slt = 1', 'sltu = 1, slt = 0', 'sltu = 0, slt = 0'],
      answer: 1,
      explain: 'a + ¬b + 1 = 0x8000, carry out 0: unsigned 32 767 < 65 535. N = 1, V = 1 (positive − negative gave negative): N ⊕ V = 0, and 32 767 is not < −1.',
      why: ['That reads the sign bit alone; the subtraction overflowed, which flipped N.', '', 'Carry out 0 means a borrow, so a < b unsigned: the unsigned test is inverted here.'],
    },
    {
      question: 'How does RV16\'s less-than unit decide signed a < b without N or V?',
      options: ['It reads the sign of a − b', 'It computes V from the carries into and out of the top bit, then N ⊕ V', 'When the signs differ, a < b exactly when a is negative; when they agree the difference cannot overflow, so the unsigned carry answers'],
      answer: 2,
      explain: 'Overflow is only possible with differing signs, and then the answer is a\'s sign; otherwise the carry of a + ¬b + 1 is right for both interpretations.',
      why: ['The sign of the result is wrong whenever the subtraction overflows (0x8000 against 0x0001).', 'That is the textbook N ⊕ V; RV16\'s unit reads only the carry and the two sign bits.', ''],
    },
  ],
  clockgating: [
    {
      question: 'A register is clocked by clk·en, with en from logic clocked by the same rising edge. When does it see a false edge?',
      options: ['When en rises while clk is still high after the edge: the gated clock rises mid-cycle', 'When en falls while clk is low', 'Never, as long as en settles within the period'],
      answer: 0,
      explain: 'en changes during clk\'s high phase, exactly when the AND passes it through; a 0 → 1 change there is a new rising edge on a value that has not settled.',
      why: ['', 'With clk low the AND\'s output is 0 whatever en does.', 'Settling within the period is not enough: en changes right after the edge, while clk is high.'],
    },
    {
      question: 'An integrated clock-gating cell puts a latch on en before the AND. When is the latch transparent?',
      options: ['While clk is high, so the AND sees en as early as possible', 'While clk is low, so en is frozen while clk is high', 'No latch is needed: clk + ¬en with an OR is glitch-free'],
      answer: 1,
      explain: 'The latch passes en while clk is low (the AND output is 0 anyway) and holds it during the high phase, so the gated clock cannot start or stop mid-pulse.',
      why: ['Transparent during the high phase, it passes the very changes that cause the glitch.', '', 'clk + ¬en is glitch-free only if en settles within clk\'s high phase: its logic gets half a cycle instead of the latch\'s whole one, and the gated clock is still a gate late (skew).'],
    },
  ],
  forwarding: [
    {
      question: '<code>add a0, a1, a2</code>; <code>add a0, a0, t0</code>; <code>sub t1, a0, a1</code>. When sub is in E, where does its a0 come from?',
      options: ['From M/W: the first add', 'From E/M: the second add, the newer value', 'From the register file'],
      answer: 1,
      explain: 'Both instructions ahead write a0; M holds the most recent one, so M has priority over W.',
      why: ['W matches too, but holds the older a0; giving W priority reads a stale value.', '', 'sub read its registers in D, before either add had written a0.'],
    },
    {
      question: 'The instruction in M is a store whose bits in the rd position happen to equal the number of a0, which the instruction in E reads. What does forwarding do?',
      options: ['Forwards the store\'s ALU result, its address', 'Stalls one cycle', 'Nothing: a store writes no register, and the match is gated by the write enable'],
      answer: 2,
      explain: 'A store\'s (or branch\'s) rd field holds immediate bits. Every match is ANDed with that instruction\'s register-write enable (and rd ≠ 0).',
      why: ['A register number match alone would forward the address to a reader of a0: a wrong value.', 'There is no dependence at all: a0 in the register file is correct.', ''],
    },
  ],
  fpcompare: [
    {
      question: 'binary16 a = 0xB800, b = 0xBA00. Is a < b (flt)?',
      options: ['Yes: as 16-bit signed integers 0xB800 < 0xBA00', 'Yes: as unsigned integers 0xB800 < 0xBA00', 'No: magnitudes order 0x3800 < 0x3A00, and with both negative the order flips'],
      answer: 2,
      explain: 'a = −0.5 and b = −0.75. |a| < |b|, both negative, so b < a. Integer comparison would claim the reverse.',
      why: ['Floats are sign–magnitude: two\'s-complement comparison orders the negatives backwards (−18 432 < −17 920 says −0.5 < −0.75).', 'Unsigned comparison works for magnitudes only; with the sign bits set it must be reversed.', ''],
    },
    {
      question: 'a = 0x7E00 (a quiet NaN), b = 0x7C00 (+∞). What does <code>flt b, a</code> give?',
      options: ['0, and NV is raised: flt signals on any NaN', '1: 0x7E00 is above 0x7C00 as an integer', '0, NV clear: a quiet NaN raises nothing'],
      answer: 0,
      explain: 'NaN is unordered: every comparison with it is false. flt and fle raise invalid for any NaN; only feq is quiet on a quiet NaN.',
      why: ['', 'NaN must not pass through the integer comparison: its bit pattern sorts above +∞ but it is not a number.', 'That rule is feq\'s; flt and fle signal NV on quiet NaNs too.'],
    },
  ],
  signedmul: [
    {
      question: 'a = 0xFFFE (−2), b = 5. The unsigned product is 0x0004_FFF6. What is mulh?',
      options: ['0x0004: the unsigned high half', '0xFFFF: 0x0004 − b', '0x0006: 0x0004 − a'],
      answer: 1,
      explain: 'a is negative, so the unsigned multiplier saw a + 2<sup>16</sup> and added b·2<sup>16</sup>: subtract b from the high half. −10 = 0xFFFF_FFF6.',
      why: ['The unsigned high half includes the extra b·2<sup>16</sup> from reading −2 as 65 534.', '', 'A negative a makes you subtract b, not a (a is subtracted when b is negative).'],
    },
    {
      question: 'mulhsu with rs1 = 3 and rs2 = 0xFFFF. The unsigned product is 0x0002_FFFD. The result?',
      options: ['0xFFFF: minus a, because rs2\'s top bit is set', '0x0003: minus b, as if rs1 were negative', '0x0002: rs1 is not negative and rs2 is unsigned, so nothing is subtracted'],
      answer: 2,
      explain: 'mulhsu treats rs1 as signed and rs2 as unsigned. Only a negative rs1 subtracts b; 3 × 65 535 = 196 605, high half 2.',
      why: ['rs2 is unsigned in mulhsu: its top bit is worth +2<sup>15</sup>, so no correction for it.', 'b is subtracted only when rs1 is negative, and 3 is not.', ''],
    },
  ],
  reduction: [
    {
      question: 'Eight lanes each hold a partial sum. Combined pairwise, how many rounds, and how many lanes work in each?',
      options: ['7 rounds: lane 0 adds each partial in turn', '3 rounds, all 8 lanes busy in each', '3 rounds: 4, 2, then 1 lane'],
      answer: 2,
      explain: 'Each round halves the partials: log<sub>2</sub> 8 = 3, with half the remaining lanes adding a partner\'s value and the rest masked off.',
      why: ['Serial combining takes lanes − 1 rounds; pairing takes log<sub>2</sub> lanes.', 'Only half of the remaining lanes have a partner to add; the others are masked off, which is the tail\'s cost.', ''],
    },
    {
      question: 'On four lanes, summing 16 words reaches 87 % lane utilization and 64 words 95 %. Why does more data help?',
      options: ['The combine tail has a fixed length (the same 9 instructions), so a longer first phase dilutes its idle lanes', 'More words switch on more lanes', 'The tail gets shorter with more data'],
      answer: 0,
      explain: 'The first phase keeps every lane busy and grows with the data; the log<sub>2</sub>(lanes) tail does not, so its idle lane-steps become a smaller share.',
      why: ['', 'The lane count is fixed at four; only each lane\'s share grows.', 'The tail depends on the number of lanes, not on the data: it stays the same length.'],
    },
  ],
  privatization: [
    {
      question: 'Three active lanes of a warp run the same <code>lw</code> / <code>addi</code> (+1) / <code>sw</code> together on one shared counter that holds 5. What does it hold afterwards?',
      options: ['8: each lane adds 1', '6: all three read 5 and store 6', '7: the lanes\' stores are applied one after another'],
      answer: 1,
      explain: 'The read-modify-write happens in lock-step: all three lanes load 5 in the same cycle, compute 6 and store 6. Two counts are lost.',
      why: ['That needs each increment to see the previous one; in one instruction they all read the same old value.', '', 'Applying the stores in turn still stores the same 6 three times.'],
    },
    {
      question: 'With private counters per thread, why must the threads meet at a barrier before adding the copies up?',
      options: ['To clear the counters', 'Because a lane cannot load another thread\'s copy at all', 'A thread adding up a bin must not read the copies until every thread has finished counting into its own'],
      answer: 2,
      explain: 'The combine reads every thread\'s copy of a bin; without the barrier a thread still counting could update its copy after it has been summed.',
      why: ['Clearing, where needed, comes before counting (with its own barrier); this barrier separates counting from combining.', 'Memory is shared: any lane can load any word. Only the timing needs enforcing.', ''],
    },
  ],
  tilewalk: [
    {
      question: 'At a 4 × 4 tile\'s top-left pixel an edge has E = −300, with A = −20 and B = 30 (quarter-pixel units). Is the tile rejected?',
      options: ['Yes: E is negative at the top-left pixel', 'Yes: at the best corner E = −300 + 12·(−20 + 30) = −180', 'No: at the best corner E = −300 + 12·(0 + 30) = 60 ≥ 0'],
      answer: 2,
      explain: 'The best corner adds 12·A⁺ in x and 12·B⁺ in y (3 pixels × 4 quarter pixels): A is negative, so x stays left; B is positive, so the corner is at the bottom.',
      why: ['Testing the top-left only rejects tiles that still hold pixels inside: this edge grows downward.', 'A⁺ is A only when positive: moving right would lower E, so the best corner stays in the left column.', ''],
    },
    {
      question: 'Why does the walk run a serpentine inside a tile (down a column, up the next) instead of rows left to right?',
      options: ['A serpentine visits fewer pixels', 'Every step is then one pixel (±4B, or 4A to the next column): a row-by-row path would need a jump back of −3·4A, a step the stepper does not have', 'Rows would work as well: the stepper can add any multiple of A'],
      answer: 1,
      explain: 'The stepper adds a few constant steps per cycle; the serpentine needs only those, and it ends next to the next tile\'s top-left pixel.',
      why: ['All 16 pixels of an accepted tile are visited either way.', '', 'The stepper has fixed steps; −12A would need another adder input or extra cycles.'],
    },
  ],
  horner: [
    {
      question: 'Horner\'s rule with a = 7 and a 4-bit two\'s complement b = 1101. What is the result?',
      options: ['91: every bit adds a', '−21: the top bit\'s step subtracts a', '−35: 1101 read as sign and magnitude'],
      answer: 1,
      explain: 'acc = −7 (the top bit weighs −8), then −14 + 7 = −7, then −14, then −28 + 7 = −21 = 7 · (−3).',
      why: ['That reads b as unsigned 13: in two\'s complement the top bit weighs −2<sup>n−1</sup>.', '', 'Two\'s complement is not sign–magnitude: 1101 is −3, not −5.'],
    },
    {
      question: 'The set-up interleaves A·Δx and B·Δy on one stepper, bit by bit. How many doublings does each bit take?',
      options: ['One: both products share it', 'Two: double before the A step and again before the B step', 'None: the operands shift instead'],
      answer: 0,
      explain: 'Bit k of Δx and bit k of Δy have the same weight, so one doubling followed by two conditional adds keeps both products in step.',
      why: ['', 'Doubling between the two adds would give B\'s bit twice the weight of A\'s.', 'With a fixed operand the accumulator doubles; shifting the operands instead is the LSB-first form and needs another register.'],
    },
  ],
  minsky: [
    {
      question: 'From (x, y) = (800, 100), one Minsky step with ε = 1/8 as an arithmetic shift by 3 gives?',
      options: ['(788, 200)', '(812, 201)', '(788, 198)'],
      answer: 2,
      explain: 'x ← 800 − (100 >> 3) = 788, then y ← 100 + (788 >> 3) = 100 + 98 = 198, with the new x.',
      why: ['That updates y from the old x (800 >> 3 = 100): the naive rotation, which spirals outward.', 'x ← x − ε·y: adding there turns the rotation into a map that grows both coordinates.', ''],
    },
    {
      question: 'Why does the naive update (y from the old x) spiral outward?',
      options: ['Only rounding errors; in exact arithmetic it is a circle', 'Its matrix has determinant 1 + ε² > 1: every step enlarges the orbit', 'ε is too large; with ε = 1/8 it would be exact'],
      answer: 1,
      explain: '[[1, −ε], [ε, 1]] scales areas by 1 + ε². Using the new x gives [[1, −ε], [ε, 1 − ε²]], determinant exactly 1: a closed ellipse.',
      why: ['The growth is in the exact map itself: the matrix has determinant 1 + ε², whatever the precision.', '', 'Any ε > 0 gives determinant above 1; ε = 1/8 just makes it a shift.'],
    },
  ],
  pagepolicy: [
    {
      question: 'Requests arrive far apart, each to a different row of the same bank. With tRP = tRCD = tCAS = 4 cycles, what does each access cost?',
      options: ['Open page 4: tCAS alone', 'Closed page 8, open page 12', 'Both 8: tRCD + tCAS'],
      answer: 1,
      explain: 'Open page left the previous row open, so every access is a conflict: tRP + tRCD + tCAS = 12. Closed page finds the bank precharged: tRCD + tCAS = 8.',
      why: ['tCAS alone is a row hit; every access here goes to another row.', '', 'Open page must close the old row first: it pays tRP on top.'],
    },
    {
      question: 'Closed page, ACT at cycle 0 (tRCD 4, tCAS 4, tRAS 9). When may the controller precharge?',
      options: ['Cycle 5, right after the RD', 'Cycle 13: tRAS counted from the RD', 'Cycle 9: tRAS runs from the ACT'],
      answer: 2,
      explain: 'The row must be restored before it closes: PRE no earlier than tRAS after the ACT, even if the data is already out.',
      why: ['Closed page precharges as soon as the rules allow, and tRAS does not allow it yet: the cells are still being restored.', 'tRAS counts from the ACT, not from the last read.', ''],
    },
  ],
  contactcarry: [
    {
      question: 'How many relays and relay steps does a 16-bit adder with the two-line carry take?',
      options: ['32 relays, one relay step', '32 relays, 16 relay steps', '16 relays, one relay step'],
      answer: 0,
      explain: '2 relays per bit (5 and 4 poles). All coils operate at once and the carry passes through the contacts within the same step.',
      why: ['', 'The carry does not wait for any coil: it travels through contacts already set by the operands.', 'One bit takes two relays: relay A for a, relay B for b.'],
    },
    {
      question: 'In one bit, a = 1 and b = 0. What do the carry lines do?',
      options: ['c out goes to the supply: a = 1 generates', 'c out opens and ¬c out goes to the supply: a 0', 'The carry in passes straight through to the carry out, on both lines'],
      answer: 2,
      explain: 'With a ≠ b the bit propagates: c in reaches c out and ¬c in reaches ¬c out through the contacts. Only a = b sets a constant carry.',
      why: ['Generating needs a = b = 1; with one operand 1 the bit only propagates.', 'Killing the carry needs a = b = 0.', ''],
    },
  ],
};
