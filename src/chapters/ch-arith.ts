import { addSub, decoder, FULL_ADDER, FULL_ADDER_HA, HALF_ADDER, busMux2, muxTree, rca } from '../lib';
import type { Chapter } from './types';

export const chAdders: Chapter = {
  id: 'adders', num: 6, title: 'Adders', level: 'Arithmetic',
  blurb: 'From adding two bits to adding two numbers, and why carries are slow.',
  steps: [
    {
      title: 'Adding two bits',
      body: `
        <p>Add two bits and the answer needs two bits: 1 + 1 = <code>10</code> in binary. The low bit is the
        <strong>sum</strong> <code>s</code>; the high bit is the <strong>carry</strong> <code>c</code>.</p>
        <ul><li><code>s = a XOR b</code></li><li><code>c = a AND b</code></li></ul>
        <p>This is a <strong>half adder</strong>. It is the XOR circuit from the last chapter plus one extra NAND:
        the carry reuses the XOR's first gate. That makes 5 NANDs.</p>`,
      scene: () => ({ root: HALF_ADDER, inputs: { a: 1, b: 1 } }),
    },
    {
      title: 'Adding three bits',
      body: `
        <p>To add longer numbers, every column after the first must also add the carry coming in from the
        right. A <strong>full adder</strong> adds three bits: <code>a + b + cin</code>.</p>
        <p>The textbook recipe: add <code>a + b</code> with one half adder, add <code>cin</code> to that with a second,
        and if either produced a carry, carry out (an OR gate). That makes 13 NANDs.</p>
        <div class="try">Set all three inputs to 1: the answer is 3 = <code>11</code>, so both s and cout are 1.</div>`,
      scene: () => ({ root: FULL_ADDER_HA, inputs: { a: 1, b: 1, cin: 0 } }),
    },
    {
      title: 'Optimizing: 13 NANDs → 9',
      body: `
        <p>Engineers do not stop at "it works". Look closely at the half-adder version and some gates turn out to be
        redundant. The OR gate's input inverters cancel the half adders' carry inverters, and the carry can
        reuse the first NAND of each XOR.</p>
        <p>The result is a <strong>9-NAND full adder</strong> with the same truth table (check the tab) for 30% fewer gates.
        This is the one we will use from now on.</p>
        <div class="note">Compare the two in the Info tab: transistor count and worst-case gate delays. Cheaper and
        faster circuits for the same function are a recurring theme of this journey.</div>`,
      scene: () => ({ root: FULL_ADDER, inputs: { a: 1, b: 0, cin: 1 } }),
      challenge: {
        kind: 'quiz', question: 'The 9-NAND full adder has a carry-out path through how many gates (from cin)?',
        options: ['1', '2', '4', '9'], answer: 1,
        explain: 'cin → g5 (m2) → g9 (cout): two NAND delays. That short carry path is what makes a ripple-carry adder bearable.',
      },
    },
    {
      title: 'Chaining: the ripple-carry adder',
      body: `
        <p>Line up four full adders and connect each carry-out to the next carry-in. That gives a <strong>4-bit
        ripple-carry adder</strong>, the circuit from the first chapter.</p>
        <p>The splitter on the left (the thin bar) breaks the bus <code>a</code> into single wires, one per full adder;
        the merger on the right bundles the sum bits back into a bus.</p>
        <div class="try">Compute 9 + 7. Watch the carries: which full adders produce one?</div>`,
      scene: () => ({ root: rca(4), inputs: { a: 9, b: 7, cin: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Find inputs where every full adder produces a carry (cout = 1 and s = 0xF).',
        check: (st) => st.value('s') === 15 && st.value('cout') === 1,
        hint: 'a = 15, b = 15, cin = 1 gives 31 = 1_1111.',
      },
    },
    {
      title: 'Watch the carry ripple',
      body: `
        <p>Gates are not instant: each NAND takes one <strong>gate delay</strong> to respond. In this scene the
        simulation runs slowly so you can see it.</p>
        <p>Here <code>a = 0xFF</code> and <code>b = 0</code>. Now toggle <code>cin</code> to 1. The carry has to pass through
        every full adder in turn, top to bottom, like a row of falling dominoes. Watch the status line: it reports how
        many gate delays the adder took to settle.</p>
        <p>An 8-bit ripple adder is slow; a 64-bit one would be eight times slower. Faster adders (carry-lookahead,
        Kogge–Stone) compute the carries in parallel. That is coming in a later chapter.</p>`,
      scene: () => ({ root: rca(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
    },
    {
      title: 'Subtraction for free',
      body: `
        <p>Two's complement makes subtraction easy: <code>a − b = a + (NOT b) + 1</code>.</p>
        <p>Put an XOR on every <code>b</code> input: with <code>sub = 1</code> each XOR inverts its bit. Feed
        <code>sub</code> into the carry-in as well to add the 1. One circuit now adds <em>and</em> subtracts.</p>
        <div class="try">Compute 5 − 7 (a = 5, b = 7, sub = 1). Switch the radix to DEC in the top bar, then click the
        <code>s</code> label on the wire to cycle through readings: is it 254 or −2? Both.</div>`,
      scene: () => ({ root: addSub(8), inputs: { a: 5, b: 7, sub: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Use the circuit to compute 5 − 7 (the result is −2 = 0xFE).',
        check: (st) => st.getInput('sub') === 1 && st.value('s') === 0xfe,
      },
    },
  ],
};

export const chRouting: Chapter = {
  id: 'routing', num: 7, title: 'Choosing & routing', level: 'Combinational blocks',
  blurb: 'Decoders turn numbers into choices; multiplexers make the choice.',
  steps: [
    {
      title: 'The decoder: a number becomes one wire',
      body: `
        <p>A <strong>decoder</strong> takes an n-bit number and raises exactly one of its 2ⁿ outputs. For input 2,
        output <code>y2</code> is 1 and all others are 0. This is called "one-hot".</p>
        <p>Each address bit runs down two vertical rails: itself and its inverse. Each output's AND gate taps the
        combination of rails that spells its own number.</p>`,
      scene: () => ({ root: decoder(2), inputs: { a: 2 } }),
    },
    {
      title: 'With an enable',
      body: `
        <p>Add one more input to every AND gate, <code>en</code>, and the decoder only speaks when it is enabled.
        This exact circuit will select which word of a memory gets written: the address picks the row, and the
        write-enable says "now".</p>`,
      scene: () => ({ root: decoder(3, true), inputs: { a: 5, en: 1 } }),
      challenge: {
        kind: 'reach', goal: 'Light up output y6, and only y6.',
        check: (st) => st.value('y6') === 1 && [0, 1, 2, 3, 4, 5, 7].every((k) => st.value(`y${k}`) === 0),
      },
    },
    {
      title: 'Bigger multiplexers are trees',
      body: `
        <p>A 4:1 multiplexer is three 2:1 muxes in a tree. Select bit <code>s0</code> chooses within each pair;
        <code>s1</code> chooses between the winners.</p>
        <p>A 2ᵏ:1 mux needs 2ᵏ − 1 two-input muxes and k levels. The levels set the delay.</p>`,
      scene: () => ({ root: muxTree(2, 1), inputs: { d0: 0, d1: 1, d2: 0, d3: 1, s: 1 } }),
    },
    {
      title: 'Switching whole buses',
      body: `
        <p>To choose between two 4-bit numbers, use four 2:1 muxes side by side, all listening to the same select
        line. This is a <strong>bus multiplexer</strong>: one MUX2 per bit.</p>`,
      scene: () => ({ root: busMux2(4), inputs: { a: 0x3, b: 0xc, s: 0 } }),
    },
    {
      title: '8 words in, 1 word out',
      body: `
        <p>Combine both ideas: a tree of bus multiplexers selects one of eight 4-bit words. This is exactly the
        <strong>read port</strong> of a memory, which is where we are heading: store eight words, then use the address
        to pick the one you want.</p>`,
      scene: () => ({ root: muxTree(3, 4), inputs: { d0: 0x0, d1: 0x1, d2: 0x2, d3: 0x3, d4: 0x4, d5: 0x5, d6: 0x6, d7: 0x7, s: 3 } }),
      challenge: {
        kind: 'reach', goal: 'Make the output 0xA by changing only the inputs (not s = 3).',
        check: (st) => st.getInput('s') === 3 && st.value('y') === 0xa,
        hint: 'The output shows whichever word the select line points at.',
      },
    },
  ],
};
