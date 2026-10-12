import { addSub, bcdAdder, decoder, demux, encoder, FULL_ADDER, FULL_ADDER_HA, HALF_ADDER, busMux2, magComparator, muxTree, priorityEncoder, rca } from '../lib';
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
        answer: 'a = 0xF, b = 0xF, cin = 1: 15 + 15 + 1 = 31 = 0b1_1111. Every column adds 1 + 1 + carry.',
        solve: (st) => st.setInputs({ a: 15, b: 15, cin: 1 }),
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
        answer: 'a = 5, b = 7, sub = 1: 5 + NOT(7) + 1 = 5 + 0xF8 + 1 = 0xFE = −2.',
        solve: (st) => st.setInputs({ a: 5, b: 7, sub: 1 }),
      },
    },
    {
      title: 'Comparing without subtracting',
      body: `
        <p>The subtractor already compares: a &lt; b exactly when a − b borrows. But the borrow is the slowest signal it has, at the
        end of the full carry chain. A dedicated <strong>magnitude comparator</strong> skips the arithmetic. Each bit says
        <em>greater here</em> (a·¬b) and <em>equal here</em> (a XNOR b). A tree of combine cells then merges neighbouring fields:
        the high field decides, unless it is equal. lt is neither greater nor equal.</p>
        <p>At 32 bits that is 27 gate delays against 73 for the subtractor's borrow, for about the same 450 NANDs. The depth grows
        with log n instead of n.</p>
        <div class="try">Open a <code>combine</code> cell: it is the same "the higher one decides" rule as the carry-lookahead cells in
        chapter 15.</div>`,
      scene: () => ({ root: magComparator(4), inputs: { a: 9, b: 6 } }),
    },
    {
      title: 'Signed comparison',
      body: `
        <p>In two's complement the sign bit has weight −2ⁿ⁻¹, so the order flips <em>in that bit only</em>. A 1 there means negative,
        the smaller number. The signed comparator differs in one cell: the sign bit's "greater" is ¬a·b. Everything below the sign
        bit compares as unsigned.</p>
        <p>This is why RISC-V needs both <code>slt</code> and <code>sltu</code>, and <code>blt</code> and <code>bltu</code>: the same bits
        order differently.</p>`,
      scene: () => ({ root: magComparator(4, true), inputs: { a: 3, b: 5 } }),
      challenge: {
        kind: 'reach', goal: 'Find a and b where a is the larger unsigned number but the signed comparator says lt = 1.',
        check: (st) => st.value('lt') === 1 && st.getInput('a') > st.getInput('b'),
        answer: "Any a with the sign bit set and b without it: a = 8 is −8 in 4-bit two's complement, b = 1. Unsigned 8 > 1, signed −8 < 1.",
        solve: (st) => st.setInputs({ a: 8, b: 1 }),
      },
    },
    {
      title: 'Decimal: the BCD adder',
      body: `
        <p>Calculators, clocks and money keep numbers in decimal: four bits per digit, values 0–9, the codes 1010–1111 unused. This is
        <strong>binary-coded decimal</strong>. Read a BCD number in hex and it looks decimal: 0x38 is thirty-eight.</p>
        <p>Adding two digits in binary is right up to 9. Above that the sum must skip the six unused codes, so whenever the binary sum is
        more than 9 (a carry out, or 1010–1111) the digit adder adds 6 and sends a decimal carry to the next digit. 80 NANDs per digit,
        against 36 for a 4-bit binary adder: the price of decimal. x86 kept <code>daa</code> (decimal adjust) for exactly this; RISC-V has none.</p>
        <div class="try">In HEX mode, set a = 0x38 and b = 0x45: s = 0x83, thirty-eight plus forty-five.</div>`,
      scene: () => ({ root: bcdAdder(2), inputs: { a: 0x38, b: 0x45, cin: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the adder overflow into the next hundred: s = 0x00 with cout = 1.',
        check: (st) => st.value('s') === 0 && st.value('cout') === 1,
        answer: 'Any pair that sums to exactly 100, for example a = 0x99, b = 0x01 (99 + 1), or 0x50 + 0x50.',
        solve: (st) => st.setInputs({ a: 0x99, b: 0x01, cin: 0 }),
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
        answer: 'a = 6 (0b110) with en = 1.',
        solve: (st) => st.setInputs({ a: 6, en: 1 }),
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
        answer: 's = 3 selects d3, so set d3 = 0xA.',
        solve: (st) => st.setInputs({ d3: 0xa }),
      },
    },
    {
      title: 'Encoders: back to a number',
      body: `
        <p>An <strong>encoder</strong> undoes a decoder: one of 2ⁿ inputs is 1, and the output says which. Output bit j is simply the
        OR of every input whose index has bit j set. Eight inputs, three 4-input ORs, 27 NANDs.</p>
        <p>Input 0 is not connected to anything: "input 0 is set" and "nothing is set" both give 0. With two inputs set the output is
        the OR of their indices, which is meaningless. Both problems need the next circuit.</p>`,
      scene: () => ({ root: encoder(8), inputs: { x: 0b00100000 } }),
    },
    {
      title: 'Priority: the highest request wins',
      body: `
        <p>A <strong>priority encoder</strong> accepts any pattern of requests and reports the highest one, plus <code>v</code> (valid)
        to tell "request 0" from "no request". It is built recursively: two half-size encoders, and if the upper half has any
        request it wins, so its <code>v</code> becomes the top index bit and steers a multiplexer for the low bits.</p>
        <p>log₂ n levels of multiplexers: 7 gate delays for 8 inputs, 11 for 32. Interrupt controllers, arbiters, floating-point
        normalization (find the leading 1) and content-addressable memories all rely on one.</p>`,
      scene: () => ({ root: priorityEncoder(8), inputs: { r: 0b00010110 } }),
      challenge: {
        kind: 'reach', goal: 'Raise at least three requests so that the output is y = 5.',
        check: (st) => {
          const r = st.getInput('r');
          let c = 0;
          for (let i = 0; i < 8; i++) c += (r >> i) & 1;
          return c >= 3 && st.value('y') === 5 && st.value('v') === 1;
        },
        answer: 'Request 5 must be the highest: any r with bit 5 set, bits 6 and 7 clear, and two more bits below, for example 0b00100011.',
        solve: (st) => st.setInputs({ r: 0b00100011 }),
      },
    },
    {
      title: 'The demultiplexer',
      body: `
        <p>The mirror image of a multiplexer: one input word, 2ᵏ outputs, and the select chooses which output gets it. The others
        are 0. Inside it is a decoder whose one-hot output gates a row of AND gates per output. A decoder with an enable is the
        same thing for a single bit, with the enable as the data.</p>
        <p>A memory's write path is a demultiplexer: the address picks the row, and the write enable is the data.</p>`,
      scene: () => ({ root: demux(2, 4), inputs: { x: 0xa, s: 2 } }),
    },
  ],
};
