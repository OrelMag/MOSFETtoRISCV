// Authored walkthroughs (walk.ts): the reference answer's parts in a teaching order, each step
// saying why the part is there. Part ids are the reference chip's own (challengeset.ts); steps
// are numbered from 1 in the prose, as the level screen shows them. Plain text, no HTML.

import type { WalkScript } from './walk';

export const WALKS: Record<string, WalkScript> = {
  g_not: [
    {
      title: 'One NAND, inputs tied',
      text: 'Place one NAND and wire a to both of its inputs. NAND(a, a) = ¬(a·a) = ¬a, since a·a = a. y is ¬a after one NAND delay. A real CMOS inverter needs 2 transistors, this one 4: libraries keep both.',
      parts: ['g'], codex: ['not', 'universality'],
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
    },
    {
      title: 'The SR latch',
      text: 'Your SR latch stores the bit: s_n = 0 sets q, r_n = 0 resets it, both 1 hold. While e = 1, q follows d (transparent). While e = 0, q holds. Four NANDs, two of them in the latch.',
      parts: ['sr'], codex: ['dlatch'],
    },
  ],
};
