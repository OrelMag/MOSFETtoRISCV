// Authored walkthroughs (walk.ts): the reference answer's parts in a teaching order, each step
// saying why the part is there. Part ids are the reference chip's own (challengeset.ts); steps
// are numbered from 1 in the prose, as the level screen shows them. Plain text, no HTML.

import type { WalkScript } from './walk';
import { WALKS1 } from './walks1';
import { WALKS2 } from './walks2';
import { WALKS3 } from './walks3';
import { WALKS4 } from './walks4';
import { WALKS5 } from './walks5';
import { WALKS6 } from './walks6';
import { WALKS7 } from './walks7';

const WALKS0: Record<string, WalkScript> = {
  g_not: [
    {
      title: 'One NAND, inputs tied',
      text: 'Place one NAND and wire a to both of its inputs. NAND(a, a) = ¬(a·a) = ¬a, since a·a = a. y is ¬a after one NAND delay. A real CMOS inverter needs 2 transistors, this one 4: libraries keep both.',
      parts: ['g'], codex: ['not', 'universality'],
      ask: {
        question: 'A NAND with both inputs on a computes:',
        options: ['¬a', 'a', '1 always', 'X: two inputs on one wire fight'],
        answer: 0,
        explain: 'NAND(a, a) = ¬(a·a) = ¬a: one NAND is an inverter, 4 transistors where a CMOS inverter needs 2.',
        why: ['', 'a·a = a, and the NAND inverts it: ¬a, not a.', 'A NAND is 1 unless both inputs are 1; with both on a, that happens whenever a = 1.', 'Inputs only read a wire, and any number can share one. Only two outputs on one net can fight.'],
      },
    },
  ],
  g_and: [
    {
      title: 'NAND of a and b',
      text: 'g1 = ¬(a·b): the AND you want, inverted. CMOS gates invert by construction, so the inversion comes first and is undone afterwards.',
      parts: ['g1'], codex: ['nand'],
    },
    {
      title: 'Invert it',
      text: 'g2 is a NOT (a NAND with both inputs on g1): y = ¬¬(a·b) = a·b. Two NANDs, depth 2. Where an AND feeds another NAND, skip g2 and let the next gate absorb the bubble.',
      parts: ['g2'], codex: ['and', 'bubble'],
      ask: {
        question: 'g1 = ¬(a·b). Which single NAND turns it into a·b?',
        options: ['NAND(g1, g1)', 'NAND(g1, a)', 'NAND(a, b) again', 'None: g1 is already a·b'],
        answer: 0,
        explain: 'A NAND with both inputs on g1 is a NOT: ¬¬(a·b) = a·b. Two NANDs, depth 2.',
        why: ['', 'NAND(a, ¬(a·b)) = ¬(a·¬b) = ¬a + b: 1 on three rows.', 'A second NAND of a and b computes the same ¬(a·b) as g1.', 'g1 is 1 on three rows; a·b is 1 on one.'],
      },
    },
  ],
  g_or: [
    {
      title: 'Invert a',
      text: 'De Morgan: a + b = ¬(¬a·¬b). The OR becomes a NAND of the inverted inputs. na = NAND(a, a) = ¬a.',
      parts: ['na'], codex: ['demorgan'],
    },
    {
      title: 'Invert b',
      text: 'nb = ¬b, the same way. The two inverters work in parallel, so they add one level of depth, not two.',
      parts: ['nb'],
    },
    {
      title: 'NAND the inverses',
      text: 'g = ¬(¬a·¬b) = a + b. Three NANDs, depth 2. A NAND is an OR with inverted inputs: whenever the inputs already arrive inverted, the OR costs one NAND.',
      parts: ['g'], codex: ['or', 'bubble'],
      ask: {
        question: 'na = ¬a and nb = ¬b. What does NAND(na, nb) compute?',
        options: ['a + b', 'a·b', '¬(a + b)', 'a ⊕ b'],
        answer: 0,
        explain: '¬(¬a·¬b) = a + b by De Morgan: a NAND is an OR with inverted inputs.',
        why: ['', 'a·b would be NAND(a, b) inverted. NAND(¬a, ¬b) is 1 whenever either input is 1.', 'That is ¬a·¬b, the AND of the inverses: a NOR. The NAND inverts it once more.', 'At a = b = 1, ¬(¬a·¬b) = 1, where XOR is 0.'],
      },
    },
  ],
  g_xor: [
    {
      title: 'The shared NAND',
      text: 'g1 = ¬(a·b). The textbook form a·¬b + ¬a·b needs two inverters and costs 5 NANDs. g1 replaces both: a·¬(a·b) = a·(¬a + ¬b) = a·¬b, because a·¬a = 0.',
      parts: ['g1'], codex: ['identities', 'demorgan'],
    },
    {
      title: 'a and not b',
      text: 'g2 = ¬(a·g1) = ¬(a·¬b). It is 0 only for a = 1, b = 0.',
      parts: ['g2'],
      ask: {
        question: 'g1 = ¬(a·b). What is ¬(a·g1)?',
        options: ['¬(a·¬b)', '¬a', '¬(a·b)', '1 always'],
        answer: 0,
        explain: 'a·¬(a·b) = a·(¬a + ¬b) = a·¬b, since a·¬a = 0: g1 stands in for the inverter on b.',
        why: ['', 'At a = b = 1, g1 = 0, so ¬(a·g1) = 1, where ¬a = 0.', 'That is g1 itself. With g1 as an input, a·g1 = a·¬b.', 'It is 0 on one row, a = 1 and b = 0, where a·g1 = 1.'],
      },
    },
    {
      title: 'b and not a',
      text: 'g3 = ¬(b·g1) = ¬(¬a·b), the mirror image: 0 only for a = 0, b = 1. g1 feeds both g2 and g3, and that sharing is the whole trick.',
      parts: ['g3'],
    },
    {
      title: 'Combine',
      text: 'g4 = NAND(g2, g3) = a·¬b + ¬a·b = a ⊕ b, a sum of products built NAND–NAND. Four NANDs, depth 3: 1 when the inputs differ.',
      parts: ['g4'], codex: ['xor', 'nandnand'],
    },
  ],
  g_mux: [
    {
      title: 'Invert the select',
      text: 'y = s·b + ¬s·a. Only s appears complemented, so one inverter is needed: ns = NAND(s, s) = ¬s. It sits on the slowest path (s → ns → g1 → g3, depth 3).',
      parts: ['ns'], codex: ['mux'],
    },
    {
      title: 'Gate a',
      text: 'g1 = ¬(a·¬s): the product term ¬s·a, inverted. It is 0 only when s = 0 and a = 1.',
      parts: ['g1'], codex: ['sop'],
    },
    {
      title: 'Gate b',
      text: 'g2 = ¬(b·s): the product term s·b, inverted. It takes s directly and needs no inverter.',
      parts: ['g2'],
    },
    {
      title: 'Combine',
      text: 'g3 = NAND(g1, g2) = ¬s·a + s·b: the OR of the two products, NAND–NAND. Four NANDs. A wide multiplexer repeats g1, g2 and g3 per bit and shares ns.',
      parts: ['g3'], codex: ['nandnand'],
      ask: {
        question: 'g1 = ¬(¬s·a) and g2 = ¬(s·b). What does NAND(g1, g2) compute?',
        options: ['¬s·a + s·b', '¬(¬s·a + s·b)', '0: the two products never overlap', 's'],
        answer: 0,
        explain: 'NAND(¬P, ¬Q) = P + Q: NAND–NAND is a sum of products, here ¬s·a + s·b. Four NANDs.',
        why: ['', 'NAND(g1, g2) = ¬g1 + ¬g2: the two inversions cancel, leaving the OR of the products.', 'They never overlap, which is why their OR is a clean selection: NAND(g1, g2) = ¬g1 + ¬g2, not their AND.', 'y follows the data, not s: with s = 0 it is a, with s = 1 it is b.'],
      },
    },
  ],
  a_ha: [
    {
      title: 'The shared NAND',
      text: 'g1 = ¬(a·b). The XOR needs it as its first NAND, and the carry a·b is its inverse: one gate serves both outputs.',
      parts: ['g1'], codex: ['halfadder'],
    },
    {
      title: 'The XOR',
      text: 'g2 = ¬(a·g1), g3 = ¬(b·g1), g4 = NAND(g2, g3) = a ⊕ b: the four-NAND XOR, built on g1. s is the column\'s sum bit, 1 when exactly one input is 1.',
      parts: ['g2', 'g3', 'g4'], codex: ['xor'],
    },
    {
      title: 'The carry',
      text: 'g5 = NAND(g1, g1) = ¬g1 = a·b. An AND from scratch would cost 2 NANDs; reusing g1 costs 1. Five NANDs in total, depth 3 on s and 2 on c.',
      parts: ['g5'], codex: ['and'],
      ask: {
        question: 'The XOR is done, built on g1 = ¬(a·b). What is the cheapest carry c = a·b?',
        options: ['NAND(g1, g1): 1 NAND', 'A new AND of a and b: 2 NANDs', 'NAND(g2, g3): 1 NAND', 'g4 inverted: 1 NAND'],
        answer: 0,
        explain: 'g1 is already ¬(a·b): one NAND as an inverter on it gives a·b. 5 NANDs in total.',
        why: ['', 'It works, but g1 already holds ¬(a·b): the AND\'s first NAND is there.', 'NAND(g2, g3) is g4, the sum a ⊕ b.', '¬(a ⊕ b) is XNOR: 1 at a = b = 0, where the carry is 0.'],
      },
    },
  ],
  a_fa: [
    {
      title: 'The shared NAND of a and b',
      text: 'g1 = ¬(a·b). It is the first NAND of the XOR a ⊕ b, and also half of the carry: cout = a·b + cin·(a ⊕ b).',
      parts: ['g1'], codex: ['majority'],
    },
    {
      title: 'First XOR',
      text: 'g2, g3 and g4 complete the four-NAND XOR on g1: g4 = a ⊕ b. This is a half adder without its carry gate.',
      parts: ['g2', 'g3', 'g4'], codex: ['xor'],
    },
    {
      title: 'The carry',
      text: 'g5 = ¬((a⊕b)·cin) is the first NAND of the second XOR. g9 = NAND(g1, g5) = a·b + (a⊕b)·cin = maj(a, b, cin), NAND–NAND with no inverters. cout is done, depth 5. Two half adders and an OR would spend 4 more NANDs on the same carry.',
      parts: ['g5', 'g9'], codex: ['nandnand'],
      ask: {
        question: 'cout = a·b + (a⊕b)·cin. g1 = ¬(a·b) is there, and the second XOR will start with g5 = ¬((a⊕b)·cin). What gives cout?',
        options: ['NAND(g1, g5): 1 NAND', 'Two ANDs and an OR: 7 NANDs', 'NAND(g4, cin)', 'AND(g1, g5)'],
        answer: 0,
        explain: 'NAND(¬P, ¬Q) = P + Q: g9 = NAND(g1, g5) = a·b + (a⊕b)·cin, one NAND on two gates the XORs need anyway.',
        why: ['', 'Right function, but g1 and g5 already hold both products inverted: NAND–NAND finishes it in one gate.', 'NAND(g4, cin) is g5 itself: one product, inverted.', 'AND(g1, g5) = ¬(a·b)·¬((a⊕b)·cin) = ¬cout: the carry inverted, for 2 NANDs.'],
      },
    },
    {
      title: 'Second XOR',
      text: 'The second XOR has the same four-NAND shape as the first. Its first NAND, ¬((a⊕b)·cin), was placed in step 3 because the carry needs it too. Add the other three: g6 = ¬(g4·g5), g7 = ¬(cin·g5), g8 = NAND(g6, g7). The sum is now complete: 1 when an odd number of inputs are 1. Nine NANDs, depth 6.',
      parts: ['g6', 'g7', 'g8'], codex: ['fulladder'],
    },
  ],
  s_sr: [
    {
      title: 'The set gate',
      text: 'g1 = NAND(s_n, q_n) drives q. Its second input will come from the other gate: a loop with no input to start it. s_n = 0 forces q = 1 whatever q_n is, because a 0 on a NAND input dominates.',
      parts: ['g1'], codex: ['feedback'],
    },
    {
      title: 'Cross-couple',
      text: 'g2 = NAND(r_n, q) drives q_n and feeds g1 back. With s_n = r_n = 1 each gate inverts the other: two stable states, one stored bit. The q and q_n wires carry power-on values (q = 0, q_n = 1); without them the loop starts at X. Releasing both inputs at once makes the two gates race.',
      parts: ['g2'], codex: ['latch'],
      ask: {
        question: 'g1 = NAND(s_n, q_n) drives q, and g2 = NAND(r_n, q) will drive q_n. With s_n = r_n = 1, how many stable states does the loop have?',
        options: ['Two: q = 0 or q = 1', 'One: q = 1', 'None: it oscillates', 'Four'],
        answer: 0,
        explain: 'With both inputs at 1 each NAND is an inverter, and two inverters in a ring agree in either state: one stored bit.',
        why: ['', 'With s_n = 1, g1 is just ¬q_n and g2 is ¬q: q = 0, q_n = 1 satisfies them as well as q = 1, q_n = 0.', 'An odd number of inversions around a loop oscillates (a ring oscillator); here there are two.', 'At rest q_n = ¬q, so only two of the four combinations are stable.'],
      },
    },
  ],
  s_dlatch: [
    {
      title: 'Gate the set',
      text: 'g1 = s_n = ¬(d·e). While e = 1 it pulls s_n low exactly when d = 1. While e = 0 it stays at 1, the SR latch\'s hold input.',
      parts: ['g1'],
    },
    {
      title: 'Gate the reset',
      text: 'g2 = r_n = ¬(s_n·e). The obvious ¬(¬d·e) needs an inverter on d, but while e = 1, s_n is already ¬d. That saves a NAND, and s_n and r_n can never both be 0, the forbidden SR input.',
      parts: ['g2'], codex: ['bubble'],
      ask: {
        question: 'g1 = s_n = ¬(d·e). r_n must be 0 exactly when e = 1 and d = 0. Which inputs does the NAND g2 take?',
        options: ['s_n and e', '¬d and e, with an inverter on d', 'd and e', 's_n and d'],
        answer: 0,
        explain: 'While e = 1, s_n = ¬d, so ¬(s_n·e) = ¬(¬d·e) with no inverter; and s_n and r_n are never both 0.',
        why: ['', 'It works, but the inverter costs a NAND: while e = 1, s_n already equals ¬d.', 'That is s_n again: r_n would fall together with it, the forbidden SR input.', 'With e = 0, s_n = 1 and r_n = ¬d: a 1 on d would reset the latch while it should hold.'],
      },
    },
    {
      title: 'The SR latch',
      text: 'Your SR latch stores the bit: s_n = 0 sets q, r_n = 0 resets it, both 1 hold. While e = 1, q follows d (transparent). While e = 0, q holds. Four NANDs, two of them in the latch.',
      parts: ['sr'], codex: ['dlatch'],
    },
  ],
};

/** Every authored walkthrough: the first levels here, acts 0–3 in walks1.ts, acts 5–7 in walks2.ts. */
export const WALKS: Record<string, WalkScript> = { ...WALKS0, ...WALKS1, ...WALKS2, ...WALKS3, ...WALKS4, ...WALKS5, ...WALKS6, ...WALKS7 };
