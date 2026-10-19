import { AND, MUX2, NOR, NOT, OR, XNOR, XOR } from '../lib';
import { numberWidget } from '../widgets/numbers';
import type { Chapter } from './types';

export const chGates: Chapter = {
  id: 'gates', num: 4, title: 'Gates from NAND', level: 'Gates',
  blurb: 'NOT, AND, OR, XOR and the multiplexer, each built from NANDs.',
  goals: [
    'build NOT, AND, OR, NOR, XOR, XNOR and the 2:1 multiplexer from NANDs alone, and give each one\'s NAND count',
    'rewrite an OR as a NAND of inverted inputs with De Morgan\'s law',
    'count the NAND delays on the slowest path through a gate',
    'use a multiplexer as a switch, and name the gate it becomes when one data input is a constant',
  ],
  builds: ['nand'],
  recap: {
    keep: [
      'NAND counts: NOT 1, AND 2, OR 3, NOR 4, XOR 4, XNOR 5, 2:1 multiplexer 4. Each is a box you can open down to NANDs, then transistors.',
      'De Morgan: ¬(a·b) = ¬a + ¬b and ¬(a + b) = ¬a·¬b. An OR is a NAND with inverted inputs.',
      'Inverting gates are the cheap ones: AND (2 NANDs) costs more than NAND (1).',
      'XOR is 1 when its inputs differ: the sum bit of binary addition. XNORs on every bit pair, ANDed together, test two words for equality.',
      'The multiplexer <code>y = s ? b : a</code> is the processor\'s switch: next instruction address, register or constant, what gets written back.',
    ],
    practise: ['l_bool', 'g_not', 'g_and', 'g_or', 'g_xor', 'g_mux'],
    check: [
      {
        question: 'Built from this chapter\'s boxes, how many NANDs does NOT(a OR b) take?',
        options: ['4: an OR (3) then a NOT (1)', '2', '3', '1'],
        answer: 0,
        explain: 'OR is two inverters and a NAND (3); inverting its output costs one more NAND used as NOT.',
        why: ['', 'That is AND: one NAND, then one NAND as an inverter.', 'That is OR alone: its output still has to be inverted.', 'One NAND gives NOT(a AND b), not NOT(a OR b).'],
      },
      {
        question: 'A 2:1 multiplexer has its data input a tied to 0. As a function of s and b, what does it compute?',
        options: ['s AND b', 's OR b', 's XOR b', 'NOT b'],
        answer: 0,
        explain: 'y = s ? b : 0. With s = 0 the output is 0; with s = 1 it is b. That is s·b.',
        why: ['', 'With s = 0 the mux passes a, which is 0 whatever b is: OR would give b there.', 'With s = 1 the mux passes b unchanged; XOR would invert it.', 'A multiplexer only chooses between its inputs: nothing in it inverts the data.'],
      },
      {
        question: 'In the four-NAND XOR, how many NAND delays lie on the slowest path from a to y?',
        options: ['1', '2', '3', '4'],
        answer: 2,
        explain: 'a → m = NAND(a, b) → a middle gate → the output NAND: three delays. The direct path a → middle gate → output is only two.',
        why: ['One delay reaches only the first NANDs; y is at least one gate further.', 'That is the direct path a → middle gate → output. The path through the shared NAND m is one longer.', '', 'XOR has four NANDs, but they are not in one chain: the two middle gates work side by side.'],
      },
    ],
  },
  steps: [
    {
      title: 'NOT: tie the inputs together',
      body: `
        <p>If both inputs of a <span data-show="g1">NAND</span> carry the same signal, NAND(a, a) = NOT(a AND a) = <strong>NOT a</strong>.
        One NAND makes an inverter.</p>
        <p>Every gate in this chapter is drawn with its usual symbol, but inside it is only NANDs.
        Double-click it to check.</p>`,
      scene: () => ({ root: NOT, inputs: { a: 0 } }),
    },
    {
      title: 'AND: undo the NOT',
      body: `
        <p><span data-show="g1">NAND</span> is AND followed by NOT. Add <span data-show="g2">another NOT</span> and the two inversions cancel:
        <strong>AND = NAND → NOT</strong>. Two NANDs.</p>
        <p>Notice the cost: AND is <em>more</em> expensive than NAND. In CMOS the inverting gates are the cheap ones.</p>`,
      scene: () => ({ root: AND, inputs: { a: 1, b: 0 } }),
    },
    {
      title: "OR: De Morgan's trick",
      body: `
        <p>Augustus De Morgan noticed that "a or b" is the same as "not (not a and not b)". In symbols:
        a + b = ¬(¬a · ¬b).</p>
        <p>So <span data-show="g1 g2">invert both inputs</span> and <span data-show="g3">NAND them</span>: <strong>three NANDs</strong> make an OR.</p>
        <div class="try">Set both inputs to 0 and follow the signals: both inverters output 1, and NAND(1, 1) = 0.</div>`,
      scene: () => ({ root: OR, inputs: { a: 0, b: 1 } }),
      tries: [(st) => st.getInput('a') === 0 && st.getInput('b') === 0 && st.value('y') === 0],
      challenge: {
        kind: 'quiz', question: 'Which expression equals NOT(a AND b)?',
        options: ['NOT a AND NOT b', 'NOT a OR NOT b', 'a OR b'], answer: 1,
        why: ['That is NOT(a OR b), the other half of De Morgan\'s law: inverting the inputs swaps AND for OR, it does not keep it.', '', 'That drops the inversions: a OR b is 1 for a = b = 1, where NOT(a AND b) is 0.'],
        explain: "De Morgan's law: ¬(a·b) = ¬a + ¬b. \"Not both\" means \"at least one is false\". Turned around, it says a NAND is an OR with inverted inputs.",
      },
    },
    {
      title: 'NOR: a box of boxes',
      body: `
        <p>NOR is OR followed by NOT. Rather than redrawing four NANDs, we reuse the <span data-show="or1">OR</span> and
        <span data-show="not1">NOT</span> we just built.
        This is a <strong>box of boxes</strong>: open the OR, then open one of its NANDs, then a transistor.
        That is three levels down.</p>
        <p>Reuse is how hardware (and software) scales. Once a block works, we stop thinking about its inside.</p>`,
      scene: () => ({ root: NOR, inputs: { a: 0, b: 0 } }),
    },
    {
      title: 'XOR: are they different?',
      body: `
        <p><strong>Exclusive OR</strong> outputs 1 when its inputs differ. It is the heart of binary addition
        (1 + 1 = 0, carry 1) and of comparison.</p>
        <p>The classic circuit uses four NANDs and shares the first one cleverly:
        <span data-show="g1"><code>m = NAND(a, b)</code></span> feeds <span data-show="g2 g3">both middle gates</span>.</p>`,
      scene: () => ({ root: XOR, inputs: { a: 1, b: 0 } }),
      challenge: {
        kind: 'reach', goal: 'With a = 1, make the XOR output 0.',
        check: (st) => st.getInput('a') === 1 && st.value('y') === 0,
        hints: [
          'XOR asks whether its inputs differ. When is the answer "no"?',
          'Watch m = NAND(a, b): it is 0 in only one input combination, and then both middle gates output 1.',
        ],
        answer: 'Set b = 1. XOR is 0 when both inputs are equal.',
        solve: (st) => st.setInputs({ a: 1, b: 1 }),
      },
    },
    {
      title: 'XNOR: are they equal?',
      body: `
        <p><span data-show="x1">XOR</span> followed by <span data-show="not1">NOT</span> gives 1 when the inputs are equal.
        Put an XNOR on every bit pair of two numbers and AND
        the results together, and you have an equality comparator (the processor's <code>beq</code>
        instruction will need one).</p>`,
      scene: () => ({ root: XNOR, inputs: { a: 1, b: 1 } }),
    },
    {
      title: 'The multiplexer: a digital switch',
      body: `
        <p>A <strong>multiplexer</strong> (mux) picks one of two inputs: <code>y = s ? b : a</code>.
        The <span data-show="pin:s">select line <code>s</code></span> decides which input gets through.</p>
        <p>It is <span data-show="g1 g2 g3 g4">four NANDs</span>, and it may be the most important block in a processor: muxes choose the next
        instruction address, choose between a register and a constant, and choose what gets written back.</p>
        <details class="deeper"><summary>Deeper: any truth table in NANDs</summary>
        <p>Every truth table has a circuit, found mechanically. Take each row whose output is 1 and write its inputs as an AND
        (a <em>minterm</em>: ¬s·a·¬b for s a b = 010); OR the minterms. That <strong>sum of products</strong> is two levels of logic, AND
        then OR, and De Morgan turns it into two levels of NAND: x·y + z·w = ¬(¬(x·y)·¬(z·w)), an OR of ANDs is a NAND of NANDs.
        The multiplexer is exactly this: y = ¬s·a + s·b = NAND(NAND(¬s, a), NAND(s, b)), plus one NAND for ¬s, which is
        <span data-show="g1 g2 g3 g4">the four gates on the stage</span>.</p>
        <p>The raw minterms are rarely the cheapest sum: its table has four (s a b = 010, 011, 101, 111), merged in pairs into
        two, since x·b + x·¬b = x. A <strong>Karnaugh map</strong> lays the table out on a grid in Gray-code order, so rows that
        differ in one input sit side by side (edges wrapping); circling the largest power-of-two blocks of 1s, don't-cares
        included where they help, reads off a minimal sum of products by eye, up to four or five inputs. Past that, programs
        do it: Quine–McCluskey (exact, run for <a href="#/c/memory/5">chapter 10's PLA</a>) and the heuristics inside synthesis
        tools. Nor is a minimal sum the cheapest circuit: the XOR above shares m and takes 4 NANDs, against 5 for its sum of products a·¬b + ¬a·b (two inverters, three NANDs).</p></details>`,
      scene: () => ({ root: MUX2, inputs: { a: 1, b: 0, s: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the output follow input b, then set b = 1.',
        check: (st) => st.getInput('s') === 1 && st.getInput('b') === 1 && st.value('y') === 1,
        hints: [
          'The select line s chooses which data input reaches y.',
          'Read the formula y = s ? b : a: which value of s picks b?',
        ],
        answer: 's = 1 selects input b; then b = 1 drives y = 1.',
        solve: (st) => st.setInputs({ s: 1, b: 1 }),
      },
    },
  ],
};

export const chBinary: Chapter = {
  id: 'binary', num: 5, title: 'Binary numbers', level: 'Numbers',
  blurb: 'Bits as numbers: unsigned, hexadecimal and two\'s complement.',
  goals: [
    'convert between binary, hexadecimal and decimal, one hex digit per four bits',
    'read one bit pattern both as an unsigned and as a two\'s-complement number',
    'negate a two\'s-complement number by inverting every bit and adding 1',
    'say why one adder serves signed and unsigned numbers alike',
  ],
  builds: ['gates'],
  recap: {
    keep: [
      'An n-bit bus carries an unsigned number from 0 to 2ⁿ − 1, bit i worth 2ⁱ. One hex digit stands for four bits: <code>0b1010_1111</code> = <code>0xAF</code> = 175.',
      'Fixed-width arithmetic wraps around like an odometer: in 4 bits, 15 + 1 = 0.',
      'Two\'s complement gives the top bit a negative weight (−8 in 4 bits, −128 in 8). All ones is −1.',
      'To negate, invert every bit and add 1. The same adder adds signed and unsigned numbers.',
      'Signed overflow: the true result leaves −2ⁿ⁻¹…2ⁿ⁻¹ − 1 (8 bits: 0x7F + 1 = 0x80 = −128). Operands of opposite sign never overflow.',
      'Bits carry no type: the instruction decides how to read them.',
    ],
    practise: ['n_bin', 'n_twos'],
    check: [
      {
        question: 'Write <code>0b0110_1101</code> in hexadecimal.',
        options: ['<code>0x6D</code>', '<code>0xD6</code>', '<code>0x613</code>', '<code>0x109</code>'],
        answer: 0,
        explain: '0110 = 6 and 1101 = 13 = D, high group first: 0x6D (109 in decimal).',
        why: ['', 'That reads the groups in the wrong order: the left four bits are the high digit.', 'Each hex digit covers four bits and runs 0–F: 1101 is the single digit D, not 13.', '109 is the value in decimal, written with a hex prefix.'],
      },
      {
        question: 'What is −5 in 8-bit two\'s complement?',
        options: ['<code>0xFB</code>', '<code>0xFA</code>', '<code>0x85</code>', '<code>0x05</code>'],
        answer: 0,
        explain: '5 = 0000_0101. Invert: 1111_1010. Add 1: 1111_1011 = 0xFB. Check: 0xFB + 5 = 0x100, which wraps to 0.',
        why: ['', 'That is the inverted bits without the +1 (one\'s complement): 0xFA + 5 = 0xFF, not 0.', 'That is sign and magnitude: the top bit set on top of 5. Two\'s complement does not keep the magnitude bits.', '0x05 is +5: its top bit is 0.'],
      },
      {
        question: 'An 8-bit adder adds <code>0xFF</code> and <code>0x02</code> and drops the carry out. What is the result?',
        options: ['0x01: 1 read unsigned, and 1 read signed', '0x01: 1 unsigned, but a signed overflow', '0x101: 257 unsigned'],
        answer: 0,
        explain: 'Unsigned, 255 + 2 = 257 wraps to 1. Signed, the same bits are −1 + 2 = 1. One addition, two correct readings.',
        why: ['', 'Signed, this is −1 + 2 = 1, well inside −128…127: no overflow. It is the unsigned sum that wrapped.', 'An 8-bit result has no ninth bit: the carry out leaves, and 255 + 2 wraps to 1.'],
      },
    ],
  },
  steps: [
    {
      title: 'Counting with two digits',
      body: `
        <p>A wire carries one bit. A group of wires, a <strong>bus</strong>, carries a number. In decimal each
        digit is worth ten times the one to its right; in <strong>binary</strong>, twice: 1, 2, 4, 8, 16…</p>
        <p>Long binary numbers are hard to read, so we write them in <strong>hexadecimal</strong>, one digit (0–9,
        A–F) for every four bits. <code>0b1010_1111</code> is <code>0xAF</code> is 175.</p>
        <div class="try">Flip the bits. Try making 255, then add 1.</div>`,
      widget: () => numberWidget(8, false),
    },
    {
      title: "Negative numbers: two's complement",
      body: `
        <p>Fixed-width numbers wrap around like an odometer: in 4 bits, 15 + 1 = 0. So the number just below 0
        must be 15, or <code>1111</code>. Calling that pattern <strong>−1</strong> works perfectly: −1 + 1 = 0.</p>
        <p>That is <strong>two's complement</strong>: the top bit is worth −8 instead of +8 (in 4 bits), and the
        same adder circuit adds signed and unsigned numbers. To negate a number, invert every bit and add 1.</p>
        <p>Signed results can overflow too: in 8 bits 0x7F + 1 = 0x80, which reads 127 + 1 = −128. The true
        sum has left −128…127; adding two numbers of opposite sign never overflows.</p>
        <p>The same bits mean different numbers depending on how you read them. The hardware does not
        care; the <em>instruction</em> decides how to interpret them.</p>`,
      widget: () => numberWidget(4, true),
      challenge: {
        kind: 'quiz', question: 'In 8-bit two\'s complement, what number is 0xFF?',
        options: ['255', '−1', '−127', '−128'], answer: 1,
        why: ['That is the unsigned reading of the same bits. In two\'s complement the top bit weighs −128.', '', 'That is 0xFF read as sign and magnitude. Two\'s complement gives the top bit weight −128: −128 + 127 = −1.', 'That is 0x80, the top bit alone. 0xFF adds +127 from the seven bits below it.'],
        explain: 'All ones is always −1: add 1 and every bit carries over, leaving 0. (Read as unsigned, the same bits are 255.)',
      },
    },
  ],
};
