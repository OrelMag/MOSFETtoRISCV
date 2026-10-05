import { AND, MUX2, NOR, NOT, OR, XNOR, XOR } from '../lib';
import { numberWidget } from '../widgets/numbers';
import type { Chapter } from './types';

export const chGates: Chapter = {
  id: 'gates', num: 4, title: 'Gates from NAND', level: 'Gates',
  blurb: 'NOT, AND, OR, XOR and the multiplexer, each built from NANDs.',
  steps: [
    {
      title: 'NOT: tie the inputs together',
      body: `
        <p>If both inputs of a NAND carry the same signal, NAND(a, a) = NOT(a AND a) = <strong>NOT a</strong>.
        One NAND makes an inverter.</p>
        <p>Every gate in this chapter is drawn with its usual symbol, but inside it is only NANDs.
        Double-click it to check.</p>`,
      scene: () => ({ root: NOT, inputs: { a: 0 } }),
    },
    {
      title: 'AND: undo the NOT',
      body: `
        <p>NAND is AND followed by NOT. Add another NOT and the two inversions cancel:
        <strong>AND = NAND → NOT</strong>. Two NANDs.</p>
        <p>Notice the cost: AND is <em>more</em> expensive than NAND. In CMOS the inverting gates are the cheap ones.</p>`,
      scene: () => ({ root: AND, inputs: { a: 1, b: 0 } }),
    },
    {
      title: "OR: De Morgan's trick",
      body: `
        <p>Augustus De Morgan noticed that "a or b" is the same as "not (not a and not b)". In symbols:
        a + b = ¬(¬a · ¬b).</p>
        <p>So invert both inputs and NAND them: <strong>three NANDs</strong> make an OR.</p>
        <div class="try">Set both inputs to 0 and follow the signals: both inverters output 1, and NAND(1, 1) = 0.</div>`,
      scene: () => ({ root: OR, inputs: { a: 0, b: 1 } }),
      challenge: {
        kind: 'quiz', question: 'Which expression equals NOT(a AND b)?',
        options: ['NOT a AND NOT b', 'NOT a OR NOT b', 'a OR b'], answer: 1,
        explain: "De Morgan's law: ¬(a·b) = ¬a + ¬b. \"Not both\" means \"at least one is false\". Turned around, it says a NAND is an OR with inverted inputs.",
      },
    },
    {
      title: 'NOR: a box of boxes',
      body: `
        <p>NOR is OR followed by NOT. Rather than redrawing four NANDs, we reuse the OR and NOT we just built.
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
        <code>m = NAND(a, b)</code> feeds both middle gates.</p>`,
      scene: () => ({ root: XOR, inputs: { a: 1, b: 0 } }),
      challenge: {
        kind: 'reach', goal: 'With a = 1, make the XOR output 0.',
        check: (st) => st.getInput('a') === 1 && st.value('y') === 0,
        hint: 'XOR is 0 when both inputs are equal.',
      },
    },
    {
      title: 'XNOR: are they equal?',
      body: `
        <p>XOR followed by NOT gives 1 when the inputs are equal. Chain XNORs on every bit of two numbers and AND
        the results together, and you have an equality comparator (the processor's <code>beq</code>
        instruction will need one).</p>`,
      scene: () => ({ root: XNOR, inputs: { a: 1, b: 1 } }),
    },
    {
      title: 'The multiplexer: a digital switch',
      body: `
        <p>A <strong>multiplexer</strong> (mux) picks one of two inputs: <code>y = s ? b : a</code>.
        The select line <code>s</code> decides which input gets through.</p>
        <p>It is four NANDs, and it may be the most important block in a processor: muxes choose the next
        instruction address, choose between a register and a constant, and choose what gets written back.</p>`,
      scene: () => ({ root: MUX2, inputs: { a: 1, b: 0, s: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the output follow input b, then set b = 1.',
        check: (st) => st.getInput('s') === 1 && st.getInput('b') === 1 && st.value('y') === 1,
      },
    },
  ],
};

export const chBinary: Chapter = {
  id: 'binary', num: 5, title: 'Binary numbers', level: 'Numbers',
  blurb: 'Bits as numbers: unsigned, hexadecimal and two\'s complement.',
  steps: [
    {
      title: 'Counting with two digits',
      body: `
        <p>A wire carries one bit. A group of wires, a <strong>bus</strong>, carries a number. In decimal each
        digit is worth ten times the one to its right; in <strong>binary</strong>, twice: 1, 2, 4, 8, 16…</p>
        <p>Long binary numbers are hard to read, so we write them in <strong>hexadecimal</strong>, one digit (0–9,
        A–F) for every four bits. <code>0b1010_1111</code> is <code>0xAF</code> is 175.</p>
        <div class="try">Flip bits on the left. Try making 255, then add 1.</div>`,
      widget: () => numberWidget(8, false),
    },
    {
      title: "Negative numbers: two's complement",
      body: `
        <p>Fixed-width numbers wrap around like an odometer: in 4 bits, 15 + 1 = 0. So the number just below 0
        must be 15, or <code>1111</code>. Calling that pattern <strong>−1</strong> works perfectly: −1 + 1 = 0.</p>
        <p>That is <strong>two's complement</strong>: the top bit is worth −8 instead of +8 (in 4 bits), and the
        same adder circuit adds signed and unsigned numbers. To negate a number, invert every bit and add 1.</p>
        <p>The same bits mean different numbers depending on how you read them. The hardware does not
        care; the <em>instruction</em> decides how to interpret them.</p>`,
      widget: () => numberWidget(4, true),
      challenge: {
        kind: 'quiz', question: 'In 8-bit two\'s complement, what number is 0xFF?',
        options: ['255', '−1', '−127', '−128'], answer: 1,
        explain: 'All ones is always −1: add 1 and every bit carries over, leaving 0. (Read as unsigned, the same bits are 255.)',
      },
    },
  ],
};
