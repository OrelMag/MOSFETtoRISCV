import type { ComponentDef } from '../sim/types';
import { addSub, bcdAdder, decoder, demux, encoder, FULL_ADDER, FULL_ADDER_HA, HALF_ADDER, busMux2, magComparator, muxTree, priorityEncoder, rca } from '../lib';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import type { Chapter } from './types';

/** NAND delays to one output port (logicDepth reports the deepest output; the subtractor's is v, not the carry). */
function portDepth(def: ComponentDef, port: string): number {
  const d = flatten(def, { mode: 'gate' });
  const driverOf = new Int32Array(d.netCount).fill(-1);
  d.leaves.forEach((l, i) => l.outputs.forEach((p) => p.forEach((n) => (driverOf[n] = i))));
  const memo = new Int32Array(d.leaves.length).fill(-1);
  const depth = (li: number): number => {
    if (memo[li] >= 0) return memo[li];
    let m = 0;
    for (const p of d.leaves[li].inputs) for (const n of p) if (driverOf[n] >= 0) m = Math.max(m, depth(driverOf[n]));
    return (memo[li] = m + (d.leaves[li].kind === 'nand' ? 1 : 0));
  };
  let max = 0;
  for (const n of d.root.ports[port]) if (driverOf[n] >= 0) max = Math.max(max, depth(driverOf[n]));
  return max;
}

const CMP32 = logicDepth(magComparator(32, false));
/** The 32-bit subtractor's carry out: a < b (unsigned) exactly when it is 0, a borrow. */
const BORROW32 = portDepth(addSub(32), 'cout');

export const chAdders: Chapter = {
  id: 'adders', num: 6, title: 'Adders', level: 'Arithmetic',
  blurb: 'From adding two bits to adding two numbers, and why carries are slow.',
  goals: [
    `build a half adder (${stats(HALF_ADDER).nands} NANDs) and a full adder (${stats(FULL_ADDER).nands} NANDs), and say which gates the ${stats(FULL_ADDER).nands}-NAND version saves`,
    'chain full adders into a ripple-carry adder and say how its delay grows with the width',
    'turn the adder into a subtractor with one XOR per bit and the carry-in',
    'compare numbers, signed and unsigned, with a comparator whose depth grows with log n',
  ],
  builds: ['gates', 'binary'],
  recap: {
    keep: [
      `Half adder: s = a XOR b, c = a AND b, ${stats(HALF_ADDER).nands} NANDs. Full adder: two half adders and an OR (${stats(FULL_ADDER_HA).nands} NANDs), or ${stats(FULL_ADDER).nands} NANDs once the cancelling inverters go, with cin → cout two NAND delays.`,
      `A ripple-carry adder chains n full adders, and the carry crosses every one. 4 bits: ${stats(rca(4)).nands} NANDs, ${logicDepth(rca(4))} delays deep; 32 bits: ${stats(rca(32)).nands} NANDs, ${logicDepth(rca(32))} deep.`,
      'Subtraction: a − b = a + ¬b + 1. An XOR on every b bit plus <code>sub</code> into the carry-in make one adder/subtractor. Signed overflow v = the carry into the top bit XOR the carry out of it.',
      `A magnitude comparator merges "greater" and "equal" fields in a tree: ${CMP32} delays at 32 bits against ${BORROW32} for the subtractor's carry out (the inverted borrow). The signed one differs only in the sign bit's cell.`,
      `BCD keeps one decimal digit per four bits: a digit sum above 9 gets 6 added and a decimal carry. ${stats(bcdAdder(1)).nands} NANDs per digit against ${stats(rca(4)).nands} for a 4-bit binary adder.`,
    ],
    practise: ['a_ha', 'a_fa', 'a_add4', 'a_add16', 'a_addsub16', 'a_slt'],
    check: [
      {
        question: 'A ripple-carry adder grows from 32 to 64 bits. What happens to its worst-case delay?',
        options: ['It roughly doubles', 'It grows by a constant', 'It stays the same', 'It roughly quadruples'],
        answer: 0,
        explain: 'The carry crosses each full adder in turn, two NAND delays per bit: delay grows linearly with the width.',
        why: ['', 'That is a tree, like the magnitude comparator or a carry-lookahead adder. Here each column waits for the carry from the one to its right.', 'The columns sit side by side, but they do not work in parallel: each needs its neighbour\'s carry first.', 'The carry crosses each full adder once: the delay grows with n, not n².'],
      },
      {
        question: 'In the adder/subtractor, why is <code>sub</code> wired to the carry-in as well as to the XORs?',
        options: ['To add the 1 in a + ¬b + 1', 'To invert a', 'To signal an overflow'],
        answer: 0,
        explain: 'The XORs give ¬b, which is −b − 1 in two\'s complement. The carry-in adds the missing 1, for free.',
        why: ['', 'Only b passes through XORs; a goes straight into the full adders.', 'Overflow has its own output, v. The carry-in completes the negation: ¬b alone is −b − 1.'],
      },
      {
        question: `Why is the 32-bit comparator ${CMP32} NAND delays deep while the subtractor's carry out (the inverted borrow) takes ${BORROW32}?`,
        options: ['It merges bit fields in a tree, so its depth grows with log n', 'It is built from faster gates', 'It computes no difference, so it has fewer gates', 'It compares only the top bits'],
        answer: 0,
        explain: 'Each combine cell decides a field from two halves: "the higher one decides, unless equal". log₂ 32 = 5 levels of cells replace a 32-stage chain.',
        why: ['', 'Every gate on this site is a NAND with one delay; only the structure differs.', 'It costs about as many NANDs as the subtractor (some 450). What changes is the shape: a tree in place of a chain.', 'The top bits decide only when they differ; when they are equal, every lower field still counts.'],
      },
    ],
  },
  steps: [
    {
      title: 'Adding two bits',
      body: `
        <p>Add two bits and the answer needs two bits: 1 + 1 = <code>10</code> in binary. The low bit is the
        <strong>sum</strong> <code>s</code>; the high bit is the <strong>carry</strong> <code>c</code>.</p>
        <ul><li><span data-show="g1 g2 g3 g4"><code>s = a XOR b</code></span></li><li><span data-show="g1 g5"><code>c = a AND b</code></span></li></ul>
        <p>This is a <strong>half adder</strong>. It is the XOR circuit from <a href="#/c/gates/4">chapter 4</a> plus one extra NAND:
        the carry reuses the XOR's first gate. That makes 5 NANDs.</p>`,
      scene: () => ({ root: HALF_ADDER, inputs: { a: 1, b: 1 } }),
    },
    {
      title: 'Adding three bits',
      body: `
        <p>To add longer numbers, every column after the first must also add the carry coming in from the
        right. A <strong>full adder</strong> adds three bits: <code>a + b + cin</code>.</p>
        <p>The textbook recipe: add <code>a + b</code> with <span data-show="ha1">one half adder</span>, add <code>cin</code> to that
        with <span data-show="ha2">a second</span>, and if either produced a carry, carry out (<span data-show="or1">an OR gate</span>).
        That makes 13 NANDs.</p>
        <div class="try">Set all three inputs to 1: the answer is 3 = <code>11</code>, so both s and cout are 1.</div>`,
      scene: () => ({ root: FULL_ADDER_HA, inputs: { a: 1, b: 1, cin: 0 } }),
      tries: [(st) => st.value('s') === 1 && st.value('cout') === 1],
    },
    {
      title: 'Optimizing: 13 NANDs → 9',
      body: `
        <p>Engineers do not stop at "it works". Look closely at the half-adder version and some gates turn out to be
        redundant. The OR gate's input inverters cancel the half adders' carry inverters, and the carry can
        <span data-show="g1 g5 g9">reuse the first NAND of each XOR</span>.</p>
        <p>The result is a <strong>9-NAND full adder</strong> with the same truth table (check the tab) for 30% fewer gates.
        This is the one we will use from now on.</p>
        <div class="note">Compare the two in the Info tab: transistor count and worst-case gate delays. Cheaper and
        faster circuits for the same function are a recurring theme of this journey.</div>`,
      scene: () => ({ root: FULL_ADDER, inputs: { a: 1, b: 0, cin: 1 } }),
      challenge: {
        kind: 'quiz', question: 'The 9-NAND full adder has a carry-out path through how many gates (from cin)?',
        options: ['1', '2', '4', '9'], answer: 1,
        why: ['cin first meets g5, whose output m2 still has to pass g9 to become cout.', '', 'That is the 13-NAND version: inside the second half adder a NAND and a NOT, then the OR\'s inverter and NAND. The 9-NAND adder drops the two inverters that cancel.', 'Nine is the gate count, not the path: most of the gates work side by side.'],
        explain: 'cin → g5 (m2) → g9 (cout): two NAND delays. That short carry path is what makes a ripple-carry adder bearable.',
      },
    },
    {
      title: 'Chaining: the ripple-carry adder',
      body: `
        <p>Line up <span data-show="fa0 fa1 fa2 fa3">four full adders</span> and connect each carry-out to the next carry-in. That gives a <strong>4-bit
        ripple-carry adder</strong>, the circuit from <a href="#/c/map/1">the map chapter</a>.</p>
        <p>The <span data-show="sa sb">splitter on the left</span> (the thin bar) breaks the bus <code>a</code> into single wires, one per full adder;
        the <span data-show="ms">merger on the right</span> bundles the sum bits back into a bus.</p>
        <div class="try">Compute 9 + 7. Watch the carries: which full adders produce one?</div>`,
      scene: () => ({ root: rca(4), inputs: { a: 9, b: 7, cin: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Find inputs where every full adder produces a carry (cout = 1 and s = 0xF).',
        check: (st) => st.value('s') === 15 && st.value('cout') === 1,
        hints: [
          'Every column must produce a carry and still leave a sum bit of 1.',
          'Work out what one full adder must add to give s = 1 and cout = 1, then ask the same of every column, the first one\'s carry-in included.',
        ],
        answer: 'a = 0xF, b = 0xF, cin = 1: 15 + 15 + 1 = 31 = 0b1_1111. Every column adds 1 + 1 + carry.',
        solve: (st) => st.setInputs({ a: 15, b: 15, cin: 1 }),
      },
    },
    {
      title: 'Watch the carry ripple',
      body: `
        <p>Gates are not instant: each NAND takes one <strong>gate delay</strong> to respond. In this scene the
        simulation runs slowly so you can see it.</p>
        <p>Here <code>a = 0xFF</code> and <code>b = 0</code>. Now toggle <span data-show="pin:cin"><code>cin</code></span> to 1. The carry has to pass through
        every full adder in turn, top to bottom, like a row of falling dominoes. Watch the status line: it reports how
        many gate delays the adder took to settle.</p>
        <p>An 8-bit ripple adder is slow; a 64-bit one has a carry chain eight times longer. Faster adders (carry-lookahead,
        Kogge–Stone) compute the carries in parallel. That is coming in <a href="#/c/fastadd/0">a later chapter</a>.</p>`,
      scene: () => ({ root: rca(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
    },
    {
      title: 'Subtraction for free',
      body: `
        <p>Two's complement makes subtraction easy: <code>a − b = a + (NOT b) + 1</code>.</p>
        <p>Put <span data-show="x0 x1 x2 x3 x4 x5 x6 x7">an XOR on every <code>b</code> input</span>: with <code>sub = 1</code> each XOR inverts its bit. Feed
        <code>sub</code> into the carry-in as well to add the 1. One circuit now adds <em>and</em> subtracts.</p>
        <p>It also reports overflow. <code>cout</code> is the unsigned flag: a carry out of an add, or no carry out of a subtract (a
        borrow). The signed result is wrong exactly when the carry into the top bit differs from the carry out of it:
        <span data-show="vx"><code>v = c7 XOR c8</code></span> here, and <code>n</code> is the top bit of s.</p>
        <div class="try">Compute 5 − 7 (a = 5, b = 7, sub = 1). Switch the radix to DEC in the top bar, then click the
        <code>s</code> label on the wire to cycle through readings: is it 254 or −2? Both.</div>`,
      scene: () => ({ root: addSub(8), inputs: { a: 5, b: 7, sub: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Use the circuit to compute 5 − 7 (the result is −2 = 0xFE).',
        check: (st) => st.getInput('sub') === 1 && st.value('s') === 0xfe,
        hints: [
          'Which input switches the circuit from adding to subtracting?',
          'Put the number you subtract from on a and the one you subtract on b: the XORs invert b for you.',
        ],
        answer: 'a = 5, b = 7, sub = 1: 5 + NOT(7) + 1 = 5 + 0xF8 + 1 = 0xFE = −2.',
        solve: (st) => st.setInputs({ a: 5, b: 7, sub: 1 }),
      },
    },
    {
      title: 'Comparing without subtracting',
      body: `
        <p>The subtractor already compares: a &lt; b (unsigned) exactly when a − b borrows. But the borrow (no carry out) comes at the end
        of the full carry chain. A dedicated <strong>magnitude comparator</strong> skips the arithmetic. <span data-show="c0 c1 c2 c3">Each bit</span> says
        <em>greater here</em> (a·¬b) and <em>equal here</em> (a XNOR b). A <span data-show="m0 m1 m2">tree of combine cells</span> then merges neighbouring fields:
        the high field decides, unless it is equal. <span data-show="lt">lt</span> is neither greater nor equal.</p>
        <p>At 32 bits that is ${CMP32} gate delays against ${BORROW32} for the subtractor's carry out, for a similar cost (${stats(magComparator(32, false)).nands} NANDs against ${stats(addSub(32)).nands}). The depth grows
        with log n instead of n.</p>
        <div class="try">Open a <code>combine</code> cell: it is the same "the higher one decides" rule as the carry-lookahead cells in
        <a href="#/c/fastadd/0">chapter 15</a>.</div>`,
      scene: () => ({ root: magComparator(4), inputs: { a: 9, b: 6 } }),
    },
    {
      title: 'Signed comparison',
      body: `
        <p>In two's complement the sign bit has weight −2ⁿ⁻¹, so the order flips <em>in that bit only</em>. A 1 there means negative,
        the smaller number. The signed comparator differs in <span data-show="c3">one cell</span>: the sign bit's "greater" is ¬a·b. Everything below the sign
        bit compares as unsigned.</p>
        <p>This is why RISC-V needs both <code>slt</code> and <code>sltu</code>, and <code>blt</code> and <code>bltu</code>: the same bits
        order differently.</p>`,
      scene: () => ({ root: magComparator(4, true), inputs: { a: 3, b: 5 } }),
      challenge: {
        kind: 'reach', goal: 'Find a and b where a is the larger unsigned number but the signed comparator says lt = 1.',
        check: (st) => st.value('lt') === 1 && st.getInput('a') > st.getInput('b'),
        hints: [
          'Signed and unsigned order disagree only when the sign bits differ.',
          'Give a the sign bit (bit 3) and leave it clear in b: unsigned, a is then at least 8.',
        ],
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
        more than 9 (a carry out, or 1010–1111) the <span data-show="u2 u3">digit adder</span> adds 6 and sends a decimal carry to the next digit. ${stats(bcdAdder(1)).nands} NANDs per digit,
        against ${stats(rca(4)).nands} for a 4-bit binary adder: the price of decimal. x86 had <code>daa</code> (decimal adjust) for exactly this until 64-bit mode dropped it; RISC-V has none.</p>
        <div class="try">In HEX mode, set a = 0x38 and b = 0x45: s = 0x83, thirty-eight plus forty-five.</div>`,
      scene: () => ({ root: bcdAdder(2), inputs: { a: 0x38, b: 0x45, cin: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Make the adder overflow into the next hundred: s = 0x00 with cout = 1.',
        check: (st) => st.value('s') === 0 && st.value('cout') === 1,
        hints: [
          's = 0x00 with a carry out means the decimal sum is exactly one hundred.',
          'In HEX mode each BCD digit reads as decimal: pick two numbers that add up to 100.',
        ],
        answer: 'Any pair that sums to exactly 100, for example a = 0x99, b = 0x01 (99 + 1), or 0x50 + 0x50.',
        solve: (st) => st.setInputs({ a: 0x99, b: 0x01, cin: 0 }),
      },
    },
  ],
};

export const chRouting: Chapter = {
  id: 'routing', num: 7, title: 'Choosing & routing', level: 'Combinational blocks',
  blurb: 'Decoders turn numbers into choices; multiplexers make the choice.',
  goals: [
    'decode an n-bit number into one of 2ⁿ one-hot lines, with and without an enable',
    'build a 2ᵏ:1 multiplexer as a tree of 2:1 muxes, and give its mux count and depth',
    'encode a one-hot input or a pattern of requests back into a number, with a valid bit',
    'say which of these blocks a memory writes through and which it reads through',
  ],
  builds: ['gates'],
  recap: {
    keep: [
      'A decoder raises exactly one of 2ⁿ outputs (one-hot): each output is an AND of true and inverted address rails. An enable is one more input on every AND.',
      'A 2ᵏ:1 multiplexer is a tree of 2ᵏ − 1 two-input muxes, k levels deep. A w-bit bus mux is w of them sharing one select. Eight 4-bit words to one: 7 bus muxes, 112 NANDs, 7 NAND delays.',
      'An encoder ORs the inputs whose index has bit j set (8 inputs: 27 NANDs). It cannot tell input 0 from no input, nor make sense of two at once.',
      `A priority encoder reports the highest request plus a valid bit v, built recursively from half-size encoders: ${logicDepth(priorityEncoder(8))} NAND delays for 8 inputs, ${logicDepth(priorityEncoder(32))} for 32.`,
      'A demultiplexer sends one word to one of 2ᵏ outputs: a decoder gating rows of ANDs. A memory writes through a decoder and reads through a mux tree.',
    ],
    practise: ['g_dec', 'g_mux8'],
    check: [
      {
        question: 'A 16:1 multiplexer is built as a tree of 2:1 muxes. How many muxes, and how many levels?',
        options: ['15 muxes, 4 levels', '16 muxes, 4 levels', '8 muxes, 4 levels', '15 muxes, 15 levels'],
        answer: 0,
        explain: 'Each level halves the candidates: 8 + 4 + 2 + 1 = 15 muxes in log₂ 16 = 4 levels.',
        why: ['', 'A tree of 2:1 muxes has one node fewer than it has leaves: 8 + 4 + 2 + 1 = 15.', 'Eight muxes are only the first level: their eight winners still need 4 + 2 + 1 more.', 'That is a chain. In a tree the muxes of one level work side by side, and each level halves the candidates.'],
      },
      {
        question: 'An 8-input priority encoder sees first r = 0 (no request), then r = 0b0000_0001. Which output tells the two apart?',
        options: ['v: 0, then 1', 'y: 0, then 1', 'None: every output is 0 both times'],
        answer: 0,
        explain: 'Request 0 has index 0, so y = 0 either way. The valid bit v says whether any request is raised.',
        why: ['', 'Request 0 has index 0: y = 0 in both cases.', 'That is the plain encoder\'s problem. The priority encoder adds v for exactly this case.'],
      },
      {
        question: 'A 3 → 8 decoder with enable has a = 5 and en = 0. Which outputs are 1?',
        options: ['None', 'y5', 'All but y5', 'y0'],
        answer: 0,
        explain: 'en is an input of every output\'s AND gate. With en = 0 no output can rise, whatever the address.',
        why: ['', 'en is the fourth input of every AND gate, y5\'s included: with en = 0 it stays 0.', 'A decoder is one-hot or all zeros; nothing in it inverts the outputs.', 'en does not change the address: it gates every output, so none rises.'],
      },
    ],
  },
  steps: [
    {
      title: 'The decoder: a number becomes one wire',
      body: `
        <p>A <strong>decoder</strong> takes an n-bit number and raises exactly one of its 2ⁿ outputs. For input 2,
        output <span data-show="g2"><code>y2</code></span> is 1 and all others are 0. This is called "one-hot".</p>
        <p>Each address bit runs down two vertical rails: itself and <span data-show="inv0 inv1">its inverse</span>.
        <span data-show="g0 g1 g2 g3">Each output's AND gate</span> taps the combination of rails that spells its own number.</p>`,
      scene: () => ({ root: decoder(2), inputs: { a: 2 } }),
    },
    {
      title: 'With an enable',
      body: `
        <p>Add one more input to every AND gate, <span data-show="pin:en"><code>en</code></span>, and the decoder only speaks when it is enabled.
        This exact circuit will select which word of a memory gets written: the address picks the row, and the
        write-enable says "now".</p>`,
      scene: () => ({ root: decoder(3, true), inputs: { a: 5, en: 1 } }),
      challenge: {
        kind: 'reach', goal: 'Light up output y6, and only y6.',
        check: (st) => st.value('y6') === 1 && [0, 1, 2, 3, 4, 5, 7].every((k) => st.value(`y${k}`) === 0),
        hints: [
          'Which number does y6 stand for, in binary?',
          'Every output\'s AND gate also reads en.',
        ],
        answer: 'a = 6 (0b110) with en = 1.',
        solve: (st) => st.setInputs({ a: 6, en: 1 }),
      },
    },
    {
      title: 'Bigger multiplexers are trees',
      body: `
        <p>A 4:1 multiplexer is three 2:1 muxes in a tree. Select bit <code>s0</code> chooses <span data-show="m0_0 m0_1">within each pair</span>;
        <code>s1</code> chooses <span data-show="m1_0">between the winners</span>.</p>
        <p>A 2ᵏ:1 mux needs 2ᵏ − 1 two-input muxes and k levels. The levels set the delay.</p>`,
      scene: () => ({ root: muxTree(2, 1), inputs: { d0: 0, d1: 1, d2: 0, d3: 1, s: 1 } }),
    },
    {
      title: 'Switching whole buses',
      body: `
        <p>To choose between two 4-bit numbers, use <span data-show="m0 m1 m2 m3">four 2:1 muxes side by side</span>, all listening to
        <span data-show="pin:s">the same select line</span>. This is a <strong>bus multiplexer</strong>: one MUX2 per bit.</p>
        <details class="deeper"><summary>Deeper: tri-state buses</summary>
        <p>Boards and early computers chose differently: every source drives the same wires through a <strong>tri-state buffer</strong>,
        which either drives its value or lets go (output Z, high impedance), and one-hot enables from a decoder let exactly one source
        speak. No mux tree, and one wire per bit however many sources.</p>
        <p>Inside chips the mux won. Two enables overlapping for a moment let two drivers fight (contention: a short from supply to ground
        through both); none enabled leaves the bus floating at an undefined level that needs a keeper; a long wire with many drivers is
        slow and hard to time; and static timing, scan test and FPGA fabrics all want every net to have exactly one driver. Tri-states
        survive at the pins (a memory chip's data bus, open-drain lines such as I²C) and in dense arrays, where SRAM cells share a bit
        line. The sandbox has the part (TRIBUF), simulated at switch level.</p></details>`,
      scene: () => ({ root: busMux2(4), inputs: { a: 0x3, b: 0xc, s: 0 } }),
    },
    {
      title: '8 words in, 1 word out',
      body: `
        <p>Combine both ideas: <span data-show="m0_0 m0_1 m0_2 m0_3 m1_0 m1_1 m2_0">a tree of bus multiplexers</span> selects one of eight 4-bit words. This is exactly the
        <strong>read port</strong> of a memory, which is where we are heading: store eight words, then use the address
        to pick the one you want.</p>`,
      scene: () => ({ root: muxTree(3, 4), inputs: { d0: 0x0, d1: 0x1, d2: 0x2, d3: 0x3, d4: 0x4, d5: 0x5, d6: 0x6, d7: 0x7, s: 3 } }),
      challenge: {
        kind: 'reach', goal: 'Make the output 0xA by changing only the inputs (not s = 3).',
        check: (st) => st.getInput('s') === 3 && st.value('y') === 0xa,
        hints: [
          'With s fixed, only one data input reaches y.',
          'Follow the select bits through the tree: s = 3 is 0b011.',
        ],
        answer: 's = 3 selects d3, so set d3 = 0xA.',
        solve: (st) => st.setInputs({ d3: 0xa }),
      },
    },
    {
      title: 'Encoders: back to a number',
      body: `
        <p>An <strong>encoder</strong> undoes a decoder: one of 2ⁿ inputs is 1, and the output says which. Output bit j is simply the
        OR of every input whose index has bit j set. Eight inputs, <span data-show="u1 u2 u3">three 4-input ORs</span>, 27 NANDs.</p>
        <p>Input 0 is not connected to anything: "input 0 is set" and "nothing is set" both give 0. With two inputs set the output is
        the OR of their indices, which is meaningless. Both problems need the next circuit.</p>`,
      scene: () => ({ root: encoder(8), inputs: { x: 0b00100000 } }),
    },
    {
      title: 'Priority: the highest request wins',
      body: `
        <p>A <strong>priority encoder</strong> accepts any pattern of requests and reports the highest one, plus <span data-show="pin:v"><code>v</code></span> (valid)
        to tell "request 0" from "no request". It is built recursively: <span data-show="lo hi">two half-size encoders</span>, and if the upper half has any
        request it wins, so its <code>v</code> becomes the top index bit and steers <span data-show="mx">a multiplexer</span> for the low bits.</p>
        <p>log₂ n − 1 levels of multiplexers: ${logicDepth(priorityEncoder(8))} gate delays for 8 inputs, ${logicDepth(priorityEncoder(32))} for 32. Interrupt controllers, arbiters, floating-point
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
        hints: [
          'The highest raised request wins, so request 5 must be raised and nothing above it.',
          'Requests below the winner do not change y, but they count towards the three.',
        ],
        answer: 'Request 5 must be the highest: any r with bit 5 set, bits 6 and 7 clear, and two more bits below, for example 0b00100011.',
        solve: (st) => st.setInputs({ r: 0b00100011 }),
      },
    },
    {
      title: 'The demultiplexer',
      body: `
        <p>The mirror image of a multiplexer: one input word, 2ᵏ outputs, and the select chooses which output gets it. The others
        are 0. Inside it is <span data-show="dec">a decoder</span> whose one-hot output gates <span data-show="g0 g1 g2 g3">a row of AND gates per output</span>. A decoder with an enable is the
        same thing for a single bit, with the enable as the data.</p>
        <p>A memory's write path is a demultiplexer: the address picks the row, and the write enable is the data.</p>`,
      scene: () => ({ root: demux(2, 4), inputs: { x: 0xa, s: 2 } }),
    },
  ],
};
