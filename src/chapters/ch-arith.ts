import type { ComponentDef } from '../sim/types';
import { bcdAdder } from '../lib/adders';
import { demux, encoder, magComparator, priorityEncoder } from '../lib/coding';
import { addSub, decoder, FULL_ADDER, FULL_ADDER_HA, HALF_ADDER, busMux2, muxTree, rca } from '../lib/combinational';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { AND, MUX2 } from '../lib/gates';
import type { Chapter } from './types';
import { delayPanel } from '../widgets/delaypanel';
import { FINE, rippleVectors } from '../widgets/finedelay';
import { numOf } from './order';
import { adderProofWidget, CATCH, cornerVectors, exhaustiveCount, yearsAt } from '../widgets/adderproof';
import { groupDigits } from '../sim/numfmt';

const RG = { ...FINE.ripple, n: rippleVectors().length - 1 };
const f2 = (x: number) => x.toFixed(2);

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

/** NAND delays on the longest path from one input port to one output port (the carry's own path: cin → cout). */
function pathDepth(def: ComponentDef, from: string, to: string): number {
  const d = flatten(def, { mode: 'gate' });
  const driverOf = new Int32Array(d.netCount).fill(-1);
  d.leaves.forEach((l, i) => l.outputs.forEach((p) => p.forEach((n) => (driverOf[n] = i))));
  const src = new Set(d.root.ports[from]);
  const memo = new Map<number, number>();
  const depth = (net: number): number => {
    if (src.has(net)) return 0;
    const li = driverOf[net];
    if (li < 0) return -Infinity;
    let m = memo.get(li);
    if (m === undefined) {
      m = -Infinity;
      for (const p of d.leaves[li].inputs) for (const n of p) m = Math.max(m, depth(n));
      m += d.leaves[li].kind === 'nand' ? 1 : 0;
      memo.set(li, m);
    }
    return m;
  };
  return Math.max(...d.root.ports[to].map(depth));
}

const CMP32 = logicDepth(magComparator(32, false));
/** The 32-bit subtractor's carry out: a < b (unsigned) exactly when it is 0, a borrow. */
const BORROW32 = portDepth(addSub(32), 'cout');

export const chAdders: Chapter = {
  id: 'adders', num: numOf('adders'), title: 'Adders', level: 'Arithmetic',
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
        why: ['', 'That is a tree, like the magnitude comparator, or the fast adders of chapter 16. Here each column waits for the carry from the one to its right.', 'The columns sit side by side, but they do not work in parallel: each needs its neighbour\'s carry first.', 'The carry crosses each full adder once: the delay grows with n, not n².'],
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
        <strong>sum</strong> <code>s</code>; the high bit is the <strong>carry</strong> <code>c</code>. Write out the four rows and
        the two outputs are gates you already have:</p>
        <ul><li><span data-show="g1 g2 g3 g4"><code>s = a XOR b</code></span>: the sum bit is 1 when exactly one input is 1;</li>
        <li><span data-show="g1 g5"><code>c = a AND b</code></span>: there is a carry only when both are 1.</li></ul>
        <p>This is a <strong>half adder</strong>. It is the XOR circuit from <a href="#/c/gates/4">chapter 4</a> plus one extra NAND.
        The XOR's first gate, <span data-show="g1"><code>g1</code></span>, already computes NAND(a, b); the carry is its inverse, so a single
        NAND wired as an inverter, <span data-show="g5"><code>g5</code></span>, gives a AND b. Sharing that gate is the whole design:
        ${stats(HALF_ADDER).nands} NANDs, ${stats(HALF_ADDER).transistors} transistors, ${logicDepth(HALF_ADDER)} gate delays deep.</p>
        <p>Why "half"? It has no input for a carry coming from the column to its right, so it can only add the lowest column of a
        number. The next step adds that missing input.</p>`,
      scene: () => ({ root: HALF_ADDER, inputs: { a: 1, b: 1 } }),
      tour: {
        beats: [
          { title: 'Nothing to add', set: { a: 0, b: 0 }, show: ['g1', 'g2', 'g3', 'g4', 'g5'], expect: { s: 0, c: 0 },
            say: '<p>a = b = 0: s = {v:s}, c = {v:c}. g1 sees two 0s and gives 1, and every gate after it settles to 0 on the outputs.</p>' },
          { title: 'One input', set: { a: 1, b: 0 }, show: ['g1', 'g2', 'g3', 'g4'], expect: { s: 1, c: 0 },
            say: '<p>a = 1, b = 0: exactly one input is 1, so the XOR (g1 to g4) gives s = {v:s}. g1 still sees a 0, so it stays 1 and the carry stays {v:c}.</p>' },
          { title: 'Both: the carry', set: { a: 1, b: 1 }, show: ['g1', 'g5'], expect: { s: 0, c: 1 },
            say: '<p>a = b = 1: 1 + 1 = 10. g1 = NAND(1, 1) = 0, which the XOR turns into s = {v:s}, and g5 inverts it into c = {v:c}.</p><p>g1 serves both outputs: that shared gate is why the half adder costs 5 NANDs and not 4 + 2.</p>' },
        ],
      },
      more: {
        derive: `<p>From the truth table: s is 1 on rows 01 and 10, so s = a·¬b + ¬a·b = a ⊕ b; c is 1 only on row 11, so c = a·b.</p>
          <p>The NAND XOR: m = ¬(a·b); p = ¬(a·m); q = ¬(b·m); s = ¬(p·q). Since c = a·b = ¬m, the carry needs only an inverter on m,
          one NAND with its inputs tied together. Total: 4 + 1 = ${stats(HALF_ADDER).nands} NANDs.</p>`,
        real: `<p>Standard-cell libraries do not build XOR from four NANDs. They have an XOR cell (often 8 to 12 transistors,
          sometimes a transmission-gate design with 6), and a half-adder cell in about 14. Our ${stats(HALF_ADDER).transistors}-transistor
          version is the price of building everything from one brick.</p>`,
        pitfall: `<p>Chaining half adders does not make a multi-bit adder: column 1 has three bits to add (a₁, b₁ and the carry
          from column 0), and a half adder has only two inputs. Dropping the carry gives the right answer only when no column carries.</p>`,
      },
    },
    {
      title: 'Adding three bits',
      body: `
        <p>To add longer numbers, every column after the first must also add the carry coming in from the
        right. A <strong>full adder</strong> adds three bits: <code>a + b + cin</code>, a value from 0 to 3, so its result still fits in
        two bits: <code>s</code> and <code>cout</code>.</p>
        <p>The textbook recipe: add <code>a + b</code> with <span data-show="ha1">one half adder</span>, add <code>cin</code> to that partial sum
        with <span data-show="ha2">a second</span>, and if either produced a carry, carry out (<span data-show="or1">an OR gate</span>).
        The two half adders can never both carry: if the first carries, its sum bit is 0, and 0 + cin cannot carry again. So the OR
        could just as well be an XOR; OR is cheaper.</p>
        <p>Cost: two half adders and an OR, ${stats(FULL_ADDER_HA).nands} NANDs, ${pathDepth(FULL_ADDER_HA, 'a', 's')} gate delays from a or b to the
        sum, ${pathDepth(FULL_ADDER_HA, 'a', 'cout')} to the carry out, and ${pathDepth(FULL_ADDER_HA, 'cin', 'cout')} from cin to cout. That last number matters most: in a long adder the carry
        crosses one full adder per bit.</p>
        <div class="try">Set all three inputs to 1: the answer is 3 = <code>11</code>, so both s and cout are 1.</div>`,
      scene: () => ({ root: FULL_ADDER_HA, inputs: { a: 1, b: 1, cin: 0 } }),
      tries: [(st) => st.value('s') === 1 && st.value('cout') === 1],
      tour: {
        label: 'Walk me through it (and spot the waste)',
        beats: [
          { title: 'First half adder', set: { a: 1, b: 1, cin: 1 }, show: ['ha1'], expect: { s: 1, cout: 1 },
            say: '<p>a + b + cin = 1 + 1 + 1 = 3. ha1 adds a + b = 2: its sum bit x is 0 and it carries.</p>' },
          { title: 'Second half adder', show: ['ha2'],
            say: '<p>ha2 adds x + cin = 0 + 1: s = {v:s}, and no second carry. The two half adders never both carry: after a carry, x is 0.</p>' },
          { title: 'Either carry', show: ['or1'],
            say: '<p>or1 passes on whichever carry came: cout = {v:cout}. Result: cout s = 11, which is 3.</p>' },
          { title: 'Spot the waste: the carry', at: ['ha1'], show: ['g1', 'g5'], ghost: ['g5'],
            say: '<p>Inside ha1, g1 computes NAND(a, b) and g5 inverts it to make the carry a AND b.</p>' },
          { title: '… and the OR', at: ['or1'], show: ['g1', 'g2', 'g3'], ghost: ['g1', 'g2'],
            say: '<p>Inside the OR, the first thing g1 and g2 do is invert both carries again (De Morgan: a + b = NAND(¬a, ¬b)). An inverter followed by an inverter does nothing.</p>' },
          { title: 'Four gates for nothing', at: [], show: ['ha1', 'ha2', 'or1'],
            say: `<p>Each half adder's carry inverter cancels one of the OR's input inverters: 4 of the ${stats(FULL_ADDER_HA).nands} NANDs can go, and the carry path loses 2 of its ${pathDepth(FULL_ADDER_HA, 'cin', 'cout')} delays. The next step builds that adder.</p>` },
        ],
      },
      more: {
        derive: `<p>s = a ⊕ b ⊕ cin (odd parity of the three bits). cout is the majority: at least two of the three are 1,
          cout = a·b + cin·(a ⊕ b). The two terms are exactly the two half adders' carries: <em>generate</em> (a·b: this column carries
          whatever comes in) and <em>propagate</em> (a ⊕ b: this column passes the incoming carry on). The fast adders of a later chapter are built
          from these two words.</p>`,
        real: `<p>A CMOS full-adder cell is usually the 28-transistor "mirror adder", which computes ¬cout directly from a, b, cin in one complex
          gate and then the sum from ¬cout, against ${stats(FULL_ADDER).transistors} transistors in our 9-NAND version. Fast adders skip full
          adders altogether and work with generate and propagate signals.</p>`,
        pitfall: `<p>Taking cout = a·b (the first half adder's carry) misses the rows where the carry comes from cin: 0 + 1 + 1 and
          1 + 0 + 1 also carry. Every full adder needs both terms.</p>`,
      },
    },
    {
      title: 'Optimizing: 13 NANDs → 9',
      body: `
        <p>Engineers do not stop at "it works". The last walkthrough found four inverters that undo each other: each half adder ends its
        carry with a NOT, and the OR gate begins by inverting both inputs. Delete both pairs and the OR collapses into a single NAND,
        <span data-show="g9"><code>g9</code></span>, fed straight from the first NAND of each XOR: <span data-show="g1"><code>g1</code></span> = NAND(a, b) and
        <span data-show="g5"><code>g5</code></span> = NAND(x, cin).</p>
        <p>The result is a <strong>9-NAND full adder</strong> with the same truth table (check the tab): ${stats(FULL_ADDER).nands} NANDs instead of
        ${stats(FULL_ADDER_HA).nands}, and the carry from cin crosses ${pathDepth(FULL_ADDER, 'cin', 'cout')} gates instead of
        ${pathDepth(FULL_ADDER_HA, 'cin', 'cout')}. Cheaper <em>and</em> faster, which is rare. This is the full adder every later circuit uses.</p>
        <p>Read the carry as the derivation says: cout = ¬(¬(a·b) · ¬(x·cin)) = a·b + x·cin, generate or propagate.</p>
        <div class="note">Compare the two in the Info tab: transistor count and worst-case gate delays. Cheaper and
        faster circuits for the same function are a recurring theme of this journey.</div>`,
      scene: () => ({ root: FULL_ADDER, inputs: { a: 1, b: 0, cin: 1 } }),
      tour: {
        beats: [
          { title: 'The first XOR', set: { a: 1, b: 0, cin: 1 }, show: ['g1', 'g2', 'g3', 'g4'], expect: { s: 0, cout: 1 },
            say: '<p>g1 to g4 are the XOR of a and b: x = 1 ⊕ 0 = 1. Its first gate g1 = NAND(a, b) = 1 is also half of the carry.</p>' },
          { title: 'The second XOR', show: ['g5', 'g6', 'g7', 'g8'],
            say: '<p>g5 to g8 XOR x with cin: s = 1 ⊕ 1 = {v:s}. Its first gate g5 = NAND(x, cin) = 0: x and cin are both 1.</p>' },
          { title: 'One NAND for the carry', show: ['g9'],
            say: '<p>g9 = NAND(g1, g5) = NAND(1, 0) = {v:cout}. The carry came through the propagate path: a ⊕ b = 1 let cin through.</p>' },
          { title: 'Generate', set: { a: 1, b: 1, cin: 0 }, show: ['g1', 'g9'], expect: { s: 0, cout: 1 },
            say: '<p>a = b = 1: g1 = 0 forces cout = {v:cout} whatever cin is. This column generates a carry.</p>' },
          { title: 'Neither', set: { a: 0, b: 0, cin: 1 }, show: ['g1', 'g5', 'g9'], expect: { s: 1, cout: 0 },
            say: '<p>a = b = 0: x = 0 blocks cin at g5 and g1 = 1, so g9 sees two 1s: cout = {v:cout}, s = {v:s}. This column kills the carry.</p>' },
        ],
      },
      more: {
        derive: `<p>Starting from the 13-NAND version: cout = OR(c₁, c₂) with c₁ = ¬m₁ and c₂ = ¬m₂ (each half adder's carry is its first NAND, inverted).
          OR(c₁, c₂) = NAND(¬c₁, ¬c₂) = NAND(¬¬m₁, ¬¬m₂) = NAND(m₁, m₂). Two inverters per input cancel, 4 NANDs go, and what is left is g9.</p>`,
        real: `<p>Logic synthesis does this rewrite automatically ("double inversion removal" and gate merging, the same pass as
          <code>sim/techmap.ts</code> here). Hand-optimized cells go further: the mirror adder shares transistors between sum and carry.</p>`,
        pitfall: `<p>Fewer gates does not always mean faster: a shared gate drives more inputs, and with load-dependent delay (the Load setting in the
          Timing panel) a gate with fan-out 3, like g1 and g5 here, is slower than one with fan-out 1. Unit delay hides this; check both.</p>`,
        numbers: `<table class="mini"><tr><th></th><th>NANDs</th><th>transistors</th><th>deepest path</th><th>cin → cout</th></tr>
          <tr><td>half adders + OR</td><td>${stats(FULL_ADDER_HA).nands}</td><td>${stats(FULL_ADDER_HA).transistors}</td><td>${logicDepth(FULL_ADDER_HA)}</td><td>${pathDepth(FULL_ADDER_HA, 'cin', 'cout')}</td></tr>
          <tr><td>9-NAND</td><td>${stats(FULL_ADDER).nands}</td><td>${stats(FULL_ADDER).transistors}</td><td>${logicDepth(FULL_ADDER)}</td><td>${pathDepth(FULL_ADDER, 'cin', 'cout')}</td></tr></table>`,
      },
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
        ripple-carry adder</strong>, the circuit from <a href="#/c/map/1">the map chapter</a>. It is exactly the column addition you learned
        at school, in base 2: each column adds its two digits and the carry from the right, writes one digit and carries one to the left.
        The ledger below writes the same sum by hand, from the live inputs.</p>
        <p>The <span data-show="sa sb">splitter on the left</span> (the thin bar) breaks the bus <code>a</code> into single wires, one per full adder;
        the <span data-show="ms">merger on the right</span> bundles the sum bits back into a bus. Splitters and mergers are only wiring: they cost
        nothing and add no delay.</p>
        <p>Cost: n full adders, ${stats(rca(4)).nands} NANDs for 4 bits, and the carry crosses every one of them. That is fine at 4 bits and
        the central problem at 64 (see Numbers below).</p>
        <div class="try">Compute 9 + 7. Watch the carries: which full adders produce one?</div>`,
      scene: () => ({ root: rca(4), inputs: { a: 9, b: 7, cin: 0 } }),
      ledger: { kind: 'add', a: 'a', b: 'b', cin: 'cin', sum: 's', cout: 'cout', width: 4, col: (i) => [`fa${i}`] },
      tour: {
        beats: [
          { title: 'Column 0', set: { a: 9, b: 7, cin: 0 }, show: ['fa0'], expect: { s: 0, cout: 1 },
            say: '<p>9 = 1001, 7 = 0111. fa0 adds the low bits: 1 + 1 + 0 = 10, so s₀ = 0 and it carries into fa1.</p>' },
          { title: 'Column 1', show: ['fa1'],
            say: '<p>fa1: 0 + 1 + the carry 1 = 10. Another 0, another carry. One input bit alone would not have carried: the carry is doing the work.</p>' },
          { title: 'Column 2', show: ['fa2'],
            say: '<p>fa2: 0 + 1 + 1 = 10, the same again.</p>' },
          { title: 'Column 3', show: ['fa3'],
            say: '<p>fa3: 1 + 0 + 1 = 10. s = {b:s} with cout = {v:cout}: the answer is 1 0000 = 16. Every column carried, one after the other: the carry rippled through all four.</p>' },
        ],
      },
      more: {
        derive: `<p>Column i computes sᵢ = aᵢ ⊕ bᵢ ⊕ cᵢ and cᵢ₊₁ = aᵢbᵢ + cᵢ(aᵢ ⊕ bᵢ), with c₀ = cin. Unrolled, c₄ depends on every input bit:
          c₄ = g₃ + p₃g₂ + p₃p₂g₁ + p₃p₂p₁g₀ + p₃p₂p₁p₀c₀. The ripple adder evaluates this one parenthesis at a time; carry-lookahead adders
          evaluate it as a tree.</p>`,
        real: `<p>Real CPUs use ripple carry only for small or slow adders (a loop counter, a low-power microcontroller). The 32- and 64-bit adders in
          an ALU are parallel-prefix adders (Kogge–Stone, Brent–Kung, Han–Carlson), built in <a href="#/c/fastadd/0">a later chapter</a>.</p>`,
        pitfall: `<p>The columns sit side by side, but they do not work in parallel: column 3's answer is only right once column 2's carry has arrived.
          Reading the sum early gives a wrong number, the reason a clocked circuit waits for its slowest path.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>NANDs</th><th>gate delays</th></tr>
          ${[4, 8, 16, 32, 64].map((n) => `<tr><td>${n}</td><td>${stats(rca(n)).nands}</td><td>${logicDepth(rca(n))}</td></tr>`).join('')}</table>
          <p>Both columns grow linearly: double the width, double the cost and the delay.</p>`,
      },
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
        <p>Here <code>a = 0xFF</code> and <code>b = 0</code>: every column propagates (aᵢ ⊕ bᵢ = 1) and none generates. Now toggle
        <span data-show="pin:cin"><code>cin</code></span> to 1. The carry has to pass through every full adder in turn, like a row of falling
        dominoes, and each sum bit flips from 1 to 0 as the carry passes it. Watch the status line: it reports how many gate delays the
        adder took to settle.</p>
        <p>The carry crosses all eight columns: ${pathDepth(rca(8), 'cin', 's')} gate delays on the status line here, 2 per column for seven columns, then the last sum's XOR. The longest path through the adder, from column 0's a or b, is ${logicDepth(rca(8))}: with a = 0xFF and cin = 0, change b from 0x01 to 0x00. Most inputs settle sooner, because a carry chain
        stops at the first column that generates or kills. But whatever uses the sum must wait for the worst case, so the worst case sets the speed.
        A 64-bit ripple adder needs ${logicDepth(rca(64))}. Faster adders compute the carries in parallel: that is
        <a href="#/c/fastadd/0">a later chapter</a>.</p>`,
      scene: () => ({ root: rca(8), inputs: { a: 0xff, b: 0, cin: 0 }, animate: true, panels: [delayPanel({ glitches: true })] }),
      actions: [{ label: 'Toggle cin', run: (st) => st.toggleInput('cin') }],
      ledger: { kind: 'add', a: 'a', b: 'b', cin: 'cin', sum: 's', cout: 'cout', width: 8, col: (i) => [`fa${i}`] },
      tour: {
        beats: [
          { title: 'Every column propagates', set: { a: 0xff, b: 0, cin: 0 }, show: ['fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7'], expect: { s: 255, cout: 0 },
            say: '<p>a = 1111 1111, b = 0: every column has exactly one 1, so each sum bit is 1 and each column would pass a carry straight on. Nothing generates one yet.</p>' },
          { title: 'Add one', set: { cin: 1 }, show: ['fa0', 'fa1', 'fa2', 'fa3', 'fa4', 'fa5', 'fa6', 'fa7'], expect: { s: 0, cout: 1 },
            say: `<p>cin = 1: 255 + 1 = 256. The carry enters fa0 and walks up through every full adder, 2 gate delays each; each sum bit drops to 0 as it passes. s = {v:s}, cout = {v:cout}. ${pathDepth(rca(8), 'cin', 's')} delays here.</p>` },
          { title: 'And back', set: { cin: 0 }, show: ['fa0', 'fa7'], expect: { s: 255, cout: 0 },
            say: '<p>cin back to 0: the carries unwind the same way, column by column. The status line counts the delays again.</p>' },
        ],
      },
      more: {
        real: `<p>The 4004 and the 6502 used ripple-style carries in their 4- and 8-bit ALUs. Manchester carry chains (a pass-transistor chain, precharged)
          made ripple carry fast enough for 16 to 32 bits in the 1970s and 80s. Above that, carry-lookahead took over.</p>`,
        pitfall: `<p>Average-case delay is not the clock period. Random inputs give short carry chains (about log₂ n on average), but a single
          worst-case pair of inputs that ripples through every column would be read wrong, so the clock must allow for it.</p>`,
        numbers: `<p>Longest path = 2 gate delays per bit plus 4: ${[8, 16, 32, 64].map((n) => `${n} bits: ${logicDepth(rca(n))}`).join(', ')}.</p>
          <p>A sum bit can change more than once before it settles: it flips when the column's own inputs arrive, then again when the carry reaches it. Those extra flips are <strong>glitches</strong>, and each one charges and discharges a wire for nothing. The <strong>Gate delays</strong> box counts them for the last change; <strong>Load</strong> there times every NAND by how many inputs it drives instead of one delay each, so paths that tie under unit delays no longer do. Over ${RG.n} random additions in a row this adder makes ${f2(RG.unit.toggles)} toggles per addition with unit delays, ${f2(RG.unit.glitches)} of them glitches, and ${f2(RG.load.toggles)} under load, ${f2(RG.load.glitches)} glitches: more glitches, not new ones. The energy they move, at ½ C V² a toggle with the capacitances of the power chapter, goes from ${f2(RG.unit.energy)} to ${f2(RG.load.energy)} fJ an addition, while the settled toggles (${f2(RG.unit.settled)}) and their energy (${f2(RG.unit.settledEnergy)} fJ) are the same under both: the delays change how the nets get there, never where they end.</p>`,
      },
    },
    {
      title: 'Subtraction for free',
      body: `
        <p>Two's complement makes subtraction easy: <code>a − b = a + (NOT b) + 1</code>. NOT b is −b − 1 (b + NOT b is all ones, which is −1),
        so adding it and then one more gives a − b.</p>
        <p>Put <span data-show="x0 x1 x2 x3 x4 x5 x6 x7">an XOR on every <code>b</code> input</span>: with <code>sub = 1</code> each XOR inverts its bit, with
        <code>sub = 0</code> it passes the bit unchanged (x ⊕ 0 = x, x ⊕ 1 = ¬x). Feed <code>sub</code> into the carry-in as well to add the 1.
        One circuit now adds <em>and</em> subtracts, for ${stats(addSub(8)).nands - stats(rca(8)).nands} NANDs more than the plain adder
        (eight XORs, and one more for the overflow flag below; ${stats(addSub(8)).nands} in all at 8 bits).</p>
        <p>It also reports overflow. <code>cout</code> is the unsigned flag: a carry out of an add, or no carry out of a subtract (a
        borrow). The signed result is wrong exactly when the carry into the top bit differs from the carry out of it:
        <span data-show="vx"><code>v = c7 XOR c8</code></span> here, and <code>n</code> is the top bit of s.</p>
        <div class="try">Compute 5 − 7 (a = 5, b = 7, sub = 1). Switch the radix to DEC in the top bar, then click the
        <code>s</code> label on the wire to cycle through readings: is it 254 or −2? Both.</div>`,
      scene: () => ({ root: addSub(8), inputs: { a: 5, b: 7, sub: 0 } }),
      ledger: { kind: 'add', a: 'a', b: 'b', sub: 'sub', sum: 's', cout: 'cout', width: 8, col: (i) => [`x${i}`, `fa${i}`] },
      tour: {
        beats: [
          { title: 'Adding', set: { a: 5, b: 7, sub: 0 }, show: ['x0', 'x1', 'x2'], expect: { s: 12 },
            say: '<p>sub = 0: every XOR passes its b bit unchanged and the carry-in is 0. 5 + 7 = {v:s}.</p>' },
          { title: 'Invert b', set: { sub: 1 }, show: ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'], expect: { s: 254 },
            say: '<p>sub = 1: every XOR inverts its bit. The adders now see ¬7 = 1111 1000 = 248, which is −8 in two\'s complement.</p>' },
          { title: '… plus one', show: ['fa0'],
            say: '<p>The same sub wire is fa0\'s carry-in: 5 + 248 + 1 = {v:s} = 1111 1110. Read as signed, that is −2: 5 − 7.</p>' },
          { title: 'Borrow, not overflow', show: ['vx', 'fa7'], expect: { cout: 0, v: 0 },
            say: '<p>cout = {v:cout}: no carry out of a subtraction means a borrow, so 5 &lt; 7 unsigned. v = {v:v}: −2 fits in 8 signed bits, no overflow.</p>' },
          { title: 'Signed overflow', set: { a: 100, b: 156 }, show: ['vx', 'fa7'], expect: { s: 200, v: 1 },
            say: '<p>b = 156 is −100 signed. 100 − (−100) = 200, which does not fit in −128…127: s = {v:s} reads as −56, and v = {v:v} says so. The carry into bit 7 was 1, the carry out 0: they differ.</p>' },
        ],
      },
      more: {
        derive: `<p>Signed overflow happens when two operands of the same sign give a result of the other sign. In the top column, with operand bits aₙ₋₁ and
          b'ₙ₋₁: if both are 0, the sum bit is the carry in cₙ₋₁ and there is no carry out, so the sign went wrong exactly when cₙ₋₁ = 1 ≠ cₙ = 0;
          if both are 1, cₙ = 1 and the sign is wrong when cₙ₋₁ = 0; if they differ, cₙ₋₁ = cₙ and overflow is impossible. In every case
          v = cₙ₋₁ ⊕ cₙ.</p>`,
        real: `<p>Flags differ between ISAs. x86 sets CF on a borrow (CF = 1 when a &lt; b); ARM sets C to the adder's carry out, so after SUBS C = 1 means
          no borrow, the same as this circuit's cout. RISC-V has no flags at all: <code>sltu</code> and <code>bltu</code> compute the comparison when it
          is needed.</p>`,
        pitfall: `<p>cout and v answer different questions. cout = 1 after an add means the unsigned result wrapped; v = 1 means the signed one did.
          127 + 1 sets v but not cout; 255 + 1 sets cout but not v.</p>`,
      },
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
        the high field decides, unless it is equal, in which case the low field decides. <span data-show="lt">lt</span> is neither greater nor equal.</p>
        <p>That is how you compare two numbers by eye: start at the most significant digit and stop at the first one that differs. The tree does
        all those "first difference" questions at once, in pairs, then pairs of pairs.</p>
        <p>At 32 bits that is ${CMP32} gate delays against ${BORROW32} for the subtractor's carry out, for a similar cost (${stats(magComparator(32, false)).nands} NANDs against ${stats(addSub(32)).nands}). The depth grows
        with log n instead of n.</p>
        <div class="try">Open a <code>combine</code> cell: it is the same "the higher one decides" rule as the carry cells of the fast adders in
        <a href="#/c/fastadd/0">chapter 16</a>.</div>`,
      scene: () => ({ root: magComparator(4), inputs: { a: 9, b: 6 } }),
      tour: {
        beats: [
          { title: 'Bit by bit', set: { a: 9, b: 6 }, show: ['c0', 'c1', 'c2', 'c3'], expect: { gt: 1, lt: 0, eq: 0 },
            say: '<p>9 = 1001, 6 = 0110. Every bit differs: c0 and c3 say "greater here" (a has the 1), c1 and c2 say "less here". Which one counts?</p>' },
          { title: 'The high half decides', show: ['m1', 'm2'],
            say: '<p>m1 merges bits 3 and 2: bit 3 differs, so it decides, greater. m2 merges the halves: the high half is not equal, so the low half (whatever it says) is ignored. gt = {v:gt}.</p>' },
          { title: 'Equal all the way', set: { a: 6, b: 6 }, show: ['m0', 'm1', 'm2', 'lt'], expect: { eq: 1, gt: 0, lt: 0 },
            say: '<p>a = b: every field is equal, so every merge passes "equal" up: eq = {v:eq}, and lt, the NOR of gt and eq, is {v:lt}.</p>' },
        ],
      },
      more: {
        derive: `<p>Each combine cell takes a high field (g_h, e_h) and a low field (g_l, e_l): g = g_h + e_h·g_l, e = e_h·e_l. The rule is
          associative, so any tree shape gives the same answer and a balanced one has ⌈log₂ n⌉ levels: ${Math.ceil(Math.log2(32))} for 32 bits, on top of the
          per-bit cells.</p>`,
        real: `<p>Branch units often have their own comparator for <code>blt</code> / <code>bge</code> rather than waiting for the ALU's subtractor, for
          exactly this reason. An equality test alone is even cheaper: XOR every bit pair and OR the results, which is how <code>beq</code> is usually done.</p>`,
        pitfall: `<p>The low field must not be ignored when the high field is equal: comparing 0x12 with 0x15 is decided entirely by the low digit.</p>`,
      },
    },
    {
      title: 'Signed comparison',
      body: `
        <p>In two's complement the sign bit has weight −2ⁿ⁻¹, so the order flips <em>in that bit only</em>. A 1 there means negative,
        the smaller number. The signed comparator differs in <span data-show="c3">one cell</span>: the sign bit's "greater" is ¬a·b. Everything below the sign
        bit compares as unsigned, because below the sign bit the weights are the same positive powers of two in both readings.</p>
        <p>This is why RISC-V needs both <code>slt</code> and <code>sltu</code>, and <code>blt</code> and <code>bltu</code>: the same bits
        order differently. 1000 is 8 unsigned and −8 signed; 0001 is 1 either way.</p>`,
      scene: () => ({ root: magComparator(4, true), inputs: { a: 3, b: 5 } }),
      tour: {
        beats: [
          { title: 'Same sign', set: { a: 3, b: 5 }, show: ['c3'], expect: { lt: 1 },
            say: '<p>3 and 5 are both positive: the sign bits are equal and the lower bits decide, as unsigned. lt = {v:lt}.</p>' },
          { title: 'Different signs', set: { a: 8, b: 1 }, show: ['c3'], expect: { lt: 1 },
            say: '<p>a = 1000, b = 0001. Unsigned, a is 8 and larger; signed, a is −8. The sign cell says "greater here" for the one with the 0, so lt = {v:lt}: −8 &lt; 1.</p>' },
        ],
      },
      more: {
        derive: `<p>Flip the sign bit of both numbers (XOR with 100…0) and signed order becomes unsigned order: −8…7 maps onto 0…15 keeping the order
          (this is "offset binary"). Inverting the sign bits is exactly the same as swapping a and b in the sign cell, which is what ¬a·b does.</p>`,
        real: `<p>Hardware that has only an unsigned comparator does the same trick: flip both sign bits on the way in. Floating-point numbers can be
          compared with an integer comparator the same way, after a sign-dependent flip of the whole word.</p>`,
        pitfall: `<p>A loop like <code>for (unsigned i = n; i &gt;= 0; i--)</code> never ends: unsigned i is never below 0, and 0 − 1 wraps to the largest
          value. Choosing <code>bltu</code> where <code>blt</code> was meant gives the same bug in assembly.</p>`,
      },
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
        <strong>binary-coded decimal</strong>. Read a BCD number in hex and it looks decimal: 0x38 is thirty-eight. Decimal storage avoids a
        conversion every time a number is printed, and a cent stays exactly a cent (0.1 has no exact binary fraction).</p>
        <p>Adding two digits in binary is right up to 9. Above that the sum must skip the six unused codes, so whenever the binary sum is
        more than 9 (a carry out, or 1010–1111) the <span data-show="u2 u3">digit adder</span> adds 6 and sends a decimal carry to the next digit. ${stats(bcdAdder(1)).nands} NANDs per digit,
        against ${stats(rca(4)).nands} for a 4-bit binary adder: the price of decimal. x86 had <code>daa</code> (decimal adjust) for exactly this until 64-bit mode dropped it; RISC-V has none.</p>
        <div class="try">In HEX mode, set a = 0x38 and b = 0x45: s = 0x83, thirty-eight plus forty-five.</div>`,
      scene: () => ({ root: bcdAdder(2), inputs: { a: 0x38, b: 0x45, cin: 0 } }),
      more: {
        derive: `<p>The correction is needed when the 4-bit sum z is 10–15 or the adder carried (16–19). 10–15 are the codes with z₃ = 1 and z₂ or z₁ set,
          so fix = cout + z₃·(z₂ + z₁): the OR, AND and OR in the digit. Adding 6 = 0110 skips the six unused codes: 8 + 5 = 13 = 1101, + 0110 = 1 0011,
          digit 3 with a decimal carry.</p>`,
        real: `<p>IBM mainframes still add packed decimal in hardware (the <code>AP</code> instruction), and POWER and z/Architecture processors have
          decimal floating point, because banking rules require decimal rounding.</p>`,
        pitfall: `<p>Checking only "sum &gt; 9" on the 4-bit result misses 9 + 9 = 18: the binary sum is 1 0010, whose low 4 bits (2) look fine.
          The binary carry out must also trigger the correction.</p>`,
      },
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
    {
      title: 'How do you know an adder is right?',
      body: `
        <p>Every adder in this chapter was checked before it was drawn into the text, and the question is how. The direct answer is to try every input. An <em>n</em>-bit adder has two operands and a carry-in, 2<sup>2<em>n</em>+1</sup> cases: <strong>${groupDigits(exhaustiveCount(4))}</strong> at 4 bits, ${groupDigits(exhaustiveCount(8))} at 8, ${groupDigits(exhaustiveCount(16))} at 16. At 32 bits it is 2<sup>65</sup>, about ${(exhaustiveCount(32) / 1e18).toFixed(1)} × 10<sup>19</sup>. A machine that checked a billion cases a second would need ${groupDigits(Math.round(yearsAt(32)))} years. An exhaustive check is a proof, and it is out of reach one width above the toy.</p>
        <p>What replaces it is a handful of kinds of vector, each aimed at something that goes wrong:</p>
        <ul>
        <li><strong>Corner cases</strong>, chosen because they are where carries behave unusually: all zeros, all ones, the sign bit alone, one below it, the two alternating patterns <code>0101…</code> and <code>1010…</code>, in every pairing with both carry-ins (${cornerVectors(32).length} vectors at 32 bits). Two of them are the cases of the earlier steps: a carry that ripples through <em>every</em> column (<code>0101…</code> + <code>1010…</code> + 1, one in ${groupDigits(2 ** 33)} random vectors would have it) and a signed overflow (<code>0111…</code> + 1).</li>
        <li><strong>Random vectors</strong>, which need no idea of where the bugs are and catch anything that goes wrong often enough.</li>
        <li><strong>A reference</strong> to compare with: the language's own <code>+</code>, wrapped to <em>n</em> bits, two lines of code that are plain to read. The circuit is run on the vector and its sum and carry-out are compared with the reference's, every time, so that nobody has to work out an expected answer by hand.</li>
        </ul>
        <p>The reference is the idea the site calls a <span data-ahead="golden">golden model (a simple program that defines what a design must do, run beside it and compared after every step)</span>; <a href="#/c/verify/0">chapter ${numOf('verify')}</a> returns to it, and to how much of a design a test set has really exercised. A passing test shows no bug in the vectors it tried, which is all it shows.</p>
        <div class="try">Plant a fault: choose "carry into the top column stuck at 0" on the 32-bit adder. The corner cases catch it at their ${CATCH.corner}th vector and the random run at its ${CATCH.random}th; with the fault in column 2 the first random vector is enough. Then run the 8-bit adder on every case.</div>`,
      widget: adderProofWidget,
      challenge: {
        kind: 'quiz',
        question: 'A 32-bit adder passes a million random vectors against the reference. What follows?',
        options: [
          'Nothing about the vectors it did not try: a fault that shows only on a rare pattern, such as a carry through every column, would be missed',
          'It is correct: a million is far more than the adder has gates',
          'It is correct for all inputs, since 32-bit adders are all built the same way',
          'It is wrong, since a million of 2<sup>65</sup> is too small a sample to mean anything',
        ],
        answer: 0,
        explain: `A million is ${(1e6 / exhaustiveCount(32)).toExponential(0).replace('e-', ' × 10^−')} of the 2^65 cases. A common fault shows at once, and a stuck carry usually does, but a fault that needs one particular pattern can sit unseen. That is why random vectors are paired with corner cases chosen for the patterns that matter, and why what a check covers is measured later in the journey.`,
        why: ['', 'Gates and cases are different counts: a gate can behave wrongly only for a few of its 2^65 context patterns.', 'The same recipe can be drawn wrongly in one place, which is what a planted fault is.', 'A sample can show a bug and does not have to be large for that; it cannot show the absence of one.'],
      },
      more: {
        derive: `<p>A ripple-carry adder is <em>n</em> copies of one full adder, so its behaviour follows from the cell's 8 cases and from how the carries are joined. Checking all 8 cases of the cell is a proof about the cell; the joints are not covered by it. A carry stuck between two columns breaks neither cell, which is why the interesting faults are on the wires between them and why the corner cases are chosen to push a carry through every one.</p>`,
        real: `<p>Production designs mix the kinds: formal tools prove the small blocks for every input, random and directed tests with a reference model run the large ones, and the corners are written by hand from the specification. A processor's floating-point divider famously shipped with a few missing table entries that random testing had not reached.</p>`,
      },
    },
  ],
};

export const chRouting: Chapter = {
  id: 'routing', num: numOf('routing'), title: 'Choosing & routing', level: 'Combinational blocks',
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
        <p>A computer is full of choices made by a number: which of 32 registers to write, which word of memory to read, which of several results to keep.
        Two blocks make every one of them. A <em>decoder</em> turns a number into one raised wire among 2ⁿ, a choice to act on (write this row); a
        <em>multiplexer</em> uses a number to pass one of 2ⁿ inputs to its output, a choice to read (this word). <a href="#/c/gates/6">Chapter 4</a> built the 2:1
        multiplexer; this chapter widens both and prices them, and every memory after it is built on the pair.</p>
        <p>A <strong>decoder</strong> takes an n-bit number and raises exactly one of its 2ⁿ outputs. For input 2,
        output <span data-show="g2"><code>y2</code></span> is 1 and all others are 0. This is called "one-hot".</p>
        <p>Each address bit runs down two vertical rails: itself and <span data-show="inv0 inv1">its inverse</span>.
        <span data-show="g0 g1 g2 g3">Each output's AND gate</span> taps the combination of rails that spells its own number: for output 2 = 0b10, the true rail of a₁ and the inverted rail of a₀.
        A gate that spells a number can fire for no other, so exactly one output is high.
        Each gate reaches one rail of every bit, so its input wires cross the rails in between: a wider decoder's drawing is a mesh of
        crossings however the rails are ordered, and the hops you see are the circuit's shape, not a poor layout.</p>
        <p>Cost: 2ⁿ AND gates of n inputs, plus n inverters. For n = 2 that is ${stats(decoder(2)).nands} NANDs (two inverters and four 2-input ANDs) and ${logicDepth(decoder(2))} gate delays; the
        table below shows how the cost grows.</p>`,
      tour: {
        beats: [
          { title: 'Address 0', set: { a: 0 }, show: ['inv0', 'inv1', 'g0'], expect: { y0: 1, y1: 0, y2: 0, y3: 0 },
            say: '<p>a = 0b{b:a}: both inverted rails are 1, and only g0 taps two inverted rails. y0 = {v:y0}, the rest 0.</p>' },
          { title: 'Address 1', set: { a: 1 }, show: ['inv1', 'g1'], expect: { y0: 0, y1: 1, y2: 0, y3: 0 },
            say: '<p>a = 0b{b:a}: g1 taps the true rail of a₀ and the inverted rail of a₁. y1 = {v:y1}; g0 lost its inverted a₀.</p>' },
          { title: 'Address 2', set: { a: 2 }, show: ['inv0', 'g2'], expect: { y0: 0, y1: 0, y2: 1, y3: 0 },
            say: '<p>a = 0b{b:a}: g2 now spells the number. y2 = {v:y2}.</p>' },
          { title: 'Address 3', set: { a: 3 }, show: ['g3'], expect: { y0: 0, y1: 0, y2: 0, y3: 1 },
            say: '<p>a = 0b{b:a}: both true rails, only g3. y3 = {v:y3}. Each address lit exactly one wire, which is the definition of one-hot.</p>' },
        ],
      },
      more: {
        derive: `<p>Output k is the minterm yₖ = ∏ᵢ (aᵢ if bit i of k is 1, else ¬aᵢ). Different k differ in at least one bit, so a minterm of one is 0 whenever another is 1: the outputs are mutually exclusive, and since
          every address matches exactly one k, exactly one output is 1. Cost: n inverters plus 2ⁿ ANDs of n inputs.</p>`,
        real: `<p>A memory with 2¹⁶ words does not have 65 536 AND gates of 16 inputs: wide ANDs are slow and the rails are long. Row decoders split the address in two or three groups, decode each (predecoding), and AND
          the group outputs, so each final gate has 2 or 3 inputs. The result is the same one-hot, in far less delay.</p>`,
        pitfall: `<p>Reading y as a number. The decoder's output is one-hot: y = 0b0100 is "2", not 4, and the outputs are only meaningful as a set of wires. If two outputs are ever high together, an address bit is
          stuck or an AND input is missing; on the circuit, every gate must read all n rails.</p>`,
        numbers: `<table class="mini"><tr><th>address bits</th><th>outputs</th><th>NANDs</th><th>delays</th></tr>
          ${[2, 3, 4, 5].map((n) => `<tr><td>${n}</td><td>${2 ** n}</td><td>${stats(decoder(n)).nands}</td><td>${logicDepth(decoder(n))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: decoder(2), inputs: { a: 2 } }),
    },
    {
      title: 'With an enable',
      body: `
        <p>Add one more input to every AND gate, <span data-show="pin:en"><code>en</code></span>, and the decoder only speaks when it is enabled.
        This exact circuit will select which word of a memory gets written: the address picks the row, and the
        write-enable says "now".</p>
        <p>With en = 0 every AND has a 0 input, so all outputs are 0, whatever the address: a decoder with enable is a decoder that can say "none". It costs ${stats(decoder(3, true)).nands} NANDs for 3 address bits,
        against ${stats(decoder(3)).nands} without: each of the 8 gates grows from 3 to 4 inputs. The enable is the data of the 1-bit demultiplexer of the end of this chapter.</p>`,
      tour: {
        beats: [
          { title: 'Enabled', set: { a: 5, en: 1 }, show: ['g5'], expect: { y5: 1, y6: 0 },
            say: '<p>a = {v:a}, en = 1: g5 sees the true rails of a₂ and a₀, the inverted rail of a₁, and en. y5 = {v:y5}.</p>' },
          { title: 'Disabled', set: { en: 0 }, show: ['g5'], expect: { y5: 0, y6: 0 },
            say: '<p>en = 0, same address: g5 has a 0 input, so y5 = {v:y5}. Every other output is 0 too: none of the eight wires is raised.</p>' },
          { title: 'Another address', set: { a: 6, en: 1 }, show: ['g6'], expect: { y5: 0, y6: 1 },
            say: '<p>a = {v:a}, en = 1: y6 = {v:y6}, and y5 has dropped.</p>' },
        ],
      },
      more: {
        derive: `<p>With enable, yₖ = en · ∏ᵢ (aᵢ or ¬aᵢ). Equivalently the n-bit decoder with enable is an (n + 1)-input AND per output, and the (n + 1)-bit decoder is two n-bit decoders sharing the low bits, one enabled by the top bit and one by
          its inverse: a way to build large decoders from small ones.</p>`,
        real: `<p>A memory's word-line decoder is a decoder with enable in the write path: write-enable gates the row lines so that nothing is written when we = 0. The same structure serves chip-select decoding, where the enable
          is the bus's valid signal and the outputs choose a peripheral.</p>`,
        pitfall: `<p>Enabling with a signal that changes while the address does. If en and a settle at different times, a brief extra output can rise (a glitch on an unrelated row). Writes are safe because the flip-flops only sample at the clock edge,
          but a decoder driving something asynchronous needs its enable and address to change in a defined order.</p>`,
        numbers: `<table class="mini"><tr><th>3 → 8 decoder</th><th>NANDs</th><th>delays</th></tr>
          <tr><td>without enable</td><td>${stats(decoder(3)).nands}</td><td>${logicDepth(decoder(3))}</td></tr>
          <tr><td>with enable</td><td>${stats(decoder(3, true)).nands}</td><td>${logicDepth(decoder(3, true))}</td></tr></table>`,
      },
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
        <p>A 2ᵏ:1 mux needs 2ᵏ − 1 two-input muxes and k levels. The levels set the delay.</p>
        <p>The tree shape is the same halving as binary search: each level discards half the candidates, using one more select bit. For 4 inputs that is ${stats(muxTree(2, 1)).nands} NANDs (three 2:1 muxes at ${stats(MUX2).nands} each) and
        ${pathDepth(muxTree(2, 1), 'd0', 'y')} gate delays from the data inputs to y (${logicDepth(muxTree(2, 1))} from the select); a flat alternative, a decoder gating each input into one big OR, has the same function and a different cost and delay, which the layers below compare.</p>`,
      tour: {
        beats: [
          { title: 's = 0: the first of the first pair', set: { s: 0 }, show: ['m0_0', 'm1_0'], expect: { y: 0 },
            say: '<p>s = 0b{b:s}: m0_0 passes d0 (s0 = 0) and m1_0 passes m0_0 (s1 = 0). y = {v:y} = d0.</p>' },
          { title: 's = 1: the second', set: { s: 1 }, show: ['m0_0', 'm1_0'], expect: { y: 1 },
            say: '<p>s0 = 1: m0_0 now passes d1. y = {v:y} = d1. Only the first level moved; the second level still reads the first pair.</p>' },
          { title: 's = 2: the other pair', set: { s: 2 }, show: ['m0_1', 'm1_0'], expect: { y: 0 },
            say: '<p>s1 = 1 makes m1_0 pass m0_1, the second pair\'s winner, and s0 = 0 makes m0_1 pass d2. y = {v:y} = d2.</p>' },
          { title: 's = 3', set: { s: 3 }, show: ['m0_1', 'm1_0'], expect: { y: 1 },
            say: '<p>s = 0b{b:s}: m0_1 passes d3. y = {v:y}. Two select bits reached four inputs through three muxes, two on any path.</p>' },
          { title: 'The data matters only when selected', set: { d3: 0 }, show: ['m0_1'], expect: { y: 0 },
            say: '<p>Change d3 to 0 with s = 3: y = {v:y}, it follows. Change any other data input and y would not move: the unselected paths are cut at some mux.</p>' },
        ],
      },
      more: {
        derive: `<p>A 2ᵏ:1 tree has 2ᵏ⁻¹ + … + 2 + 1 = 2ᵏ − 1 muxes, level j (from the leaves) having 2ᵏ⁻ʲ of them and selected by bit j − 1. Each mux is ${stats(MUX2).nands} NANDs, so a bit costs ${stats(MUX2).nands}·(2ᵏ − 1); the depth is the
          mux depth per level times k, less what the shared select inversion saves.</p>`,
        real: `<p>Large muxes in silicon are rarely trees of 2:1 cells. A one-hot AND-OR form (a decoder gating each input, then an OR tree) has a shorter select path, and a transmission-gate tree is the densest. Synthesis picks by timing: the
          register file read in a CPU is exactly this choice.</p>`,
        pitfall: `<p>Wiring the select bits in the wrong order. The least significant bit selects at the first level (nearest the data), the most significant at the last; swapping them reads input 1 as input 2. On the circuit: s0 should feed the
          muxes closest to the d inputs.</p>`,
        numbers: `<table class="mini"><tr><th>inputs</th><th>2:1 muxes</th><th>NANDs (1 bit)</th><th>delays</th></tr>
          ${[1, 2, 3, 4, 5].map((k) => `<tr><td>${2 ** k}</td><td>${2 ** k - 1}</td><td>${stats(muxTree(k, 1)).nands}</td><td>${logicDepth(muxTree(k, 1))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: muxTree(2, 1), inputs: { d0: 0, d1: 1, d2: 0, d3: 1, s: 1 } }),
    },
    {
      title: 'Switching whole buses',
      body: `
        <p>To choose between two 4-bit numbers, use <span data-show="m0 m1 m2 m3">four 2:1 muxes side by side</span>, all listening to
        <span data-show="pin:s">the same select line</span>. This is a <strong>bus multiplexer</strong>: one MUX2 per bit.</p>
        <p>Cost and delay scale differently. The NANDs grow linearly with the width (${stats(busMux2(4)).nands} for 4 bits, ${stats(busMux2(32)).nands} for 32), but the delay does not: all bits are muxed in parallel, ${logicDepth(busMux2(4))} gate delays at any width. What does grow is the load on
        s, which drives every bit's multiplexer: with unit delays this is invisible, but a real select line for a 64-bit bus needs a buffer tree.</p>`,
      tour: {
        beats: [
          { title: 's = 0: a', set: { s: 0, a: 3, b: 12 }, show: ['m0', 'm1', 'm2', 'm3'], expect: { y: 3 },
            say: '<p>s = 0: all four muxes pass their a bit. y = {b:y} = a, the word 0b{b:a}.</p>' },
          { title: 's = 1: b', set: { s: 1 }, show: ['m0', 'm1', 'm2', 'm3'], expect: { y: 12 },
            say: '<p>One wire changes and the whole word switches to b = 0b{b:b}: y = {b:y}. The width does not matter to s.</p>' },
          { title: 'The other word is ignored', set: { a: 9 }, show: ['m0', 'm1'], expect: { y: 12 },
            say: '<p>a changes to {v:a} while s = 1: y = {v:y} does not move.</p>' },
          { title: 'Back to a', set: { s: 0 }, show: ['m0', 'm1', 'm2', 'm3'], expect: { y: 9 },
            say: '<p>s = 0: y = {b:y}, the new a. Choosing between words is as cheap as choosing between bits, times the width.</p>' },
        ],
      },
      more: {
        derive: `<p>y[i] = s ? b[i] : a[i] for every i, with one s. Cost ${stats(MUX2).nands}·w NANDs; depth that of one MUX2, ${logicDepth(MUX2)}, independent of w; select fan-out w multiplexers (3 gate inputs each: the select and its inverter).</p>`,
        real: `<p>Boards and early computers chose differently: every source drives the same wires through a <strong>tri-state buffer</strong>,
          which either drives its value or lets go (output Z, high impedance), and one-hot enables from a decoder let exactly one source
          speak. No mux tree, and one wire per bit however many sources.</p>
          <p>Inside chips the mux won. Two enables overlapping for a moment let two drivers fight (contention: a short from supply to ground
          through both); none enabled leaves the bus floating at an undefined level that needs a keeper; a long wire with many drivers is
          slow and hard to time; and static timing, scan test and FPGA fabrics all want every net to have exactly one driver. Tri-states
          survive at the pins (a memory chip's data bus, open-drain lines such as I²C) and in dense arrays, where SRAM cells share a bit
          line. The sandbox has the part (TRIBUF), simulated at switch level.</p>`,
        pitfall: `<p>Giving the bits different selects by accident. A bus multiplexer whose bit 3 has a stale select produces a word that is half a and half b, a pattern that matches neither input. On the stage all four muxes should share the
          one select net; a bus that mixes words is the symptom of a missing connection.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>NANDs</th><th>delays</th></tr>
          ${[4, 8, 16, 32, 64].map((w) => `<tr><td>${w}</td><td>${stats(busMux2(w)).nands}</td><td>${logicDepth(busMux2(w))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: busMux2(4), inputs: { a: 0x3, b: 0xc, s: 0 } }),
    },
    {
      title: '8 words in, 1 word out',
      body: `
        <p>Combine both ideas: <span data-show="m0_0 m0_1 m0_2 m0_3 m1_0 m1_1 m2_0">a tree of bus multiplexers</span> selects one of eight 4-bit words. This is exactly the
        <strong>read port</strong> of a memory, which is where we are heading: store eight words, then use the address
        to pick the one you want.</p>
        <p>The cost follows from the tree: 7 bus multiplexers of 4 bits, ${stats(muxTree(3, 4)).nands} NANDs, ${pathDepth(muxTree(3, 4), 'd0', 'y')} gate delays from data to y (${logicDepth(muxTree(3, 4))} from the select). The three select bits fan out to different numbers of muxes: s0 to the four
        first-level ones, s2 to the single last one. Doubling the words adds a level (and so the delay), and doubles the number of muxes at the first level.</p>`,
      tour: {
        beats: [
          { title: 'Select 3', set: { s: 3 }, show: ['m0_1', 'm1_0', 'm2_0'], expect: { y: 3 },
            say: '<p>s = 0b{b:s}. s0 = 1 makes m0_1 pass d3 (the second of its pair), s1 = 1 makes m1_0 pass m0_1, s2 = 0 makes m2_0 pass m1_0. y = {v:y}.</p>' },
          { title: 'Select 6', set: { s: 6 }, show: ['m0_3', 'm1_1', 'm2_0'], expect: { y: 6 },
            say: '<p>s = 0b{b:s}: m0_3 passes d6, m1_1 passes m0_3, and m2_0 passes m1_1 because s2 = 1. A different path, the same three levels. y = {v:y}.</p>' },
          { title: 'Select 7', set: { s: 7 }, show: ['m0_3', 'm1_1', 'm2_0'], expect: { y: 7 },
            say: '<p>All select bits 1: the rightmost leaf. y = {v:y}.</p>' },
          { title: 'Change the data', set: { s: 5, d5: 10 }, show: ['m0_2', 'm1_1', 'm2_0'], expect: { y: 10 },
            say: '<p>d5 is now 0xA and s = 5: y = {v:y}. Writing a memory word and reading it back is this circuit with the data coming from stored bits.</p>' },
        ],
      },
      more: {
        derive: `<p>A 2ᵏ-word, w-bit read port costs w·${stats(MUX2).nands}·(2ᵏ − 1) NANDs: here 4·${stats(MUX2).nands}·7 = ${4 * stats(MUX2).nands * 7}. The delay is k multiplexer levels. The same tree shape appears in every read port, from a register file to a cache to a lookup table.</p>`,
        real: `<p>In a CPU's register file the read mux is on the critical path of every instruction: operands must arrive within the first half of the cycle. 32:1 muxes are split into 4:1 or 8:1 stages with one-hot selects
          (a decoder drives AND-OR gates) because that makes the select-to-data delay shorter than a tree of 2:1 cells.</p>`,
        pitfall: `<p>Forgetting that the select path is the slow one. The data inputs pass through one multiplexer per level, but s0 fans out to the whole first level and each select goes through an inverter first. In a deep tree the select
          arrives late; the data should not be assumed to be the critical input.</p>`,
        numbers: `<table class="mini"><tr><th>words (4 bits)</th><th>bus muxes</th><th>NANDs</th><th>delays</th></tr>
          ${[1, 2, 3, 4, 5].map((k) => `<tr><td>${2 ** k}</td><td>${2 ** k - 1}</td><td>${stats(muxTree(k, 4)).nands}</td><td>${logicDepth(muxTree(k, 4))}</td></tr>`).join('')}</table>`,
      },
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
        OR of every input whose index has bit j set. Eight inputs, <span data-show="u1 u2 u3">three 4-input ORs</span>, ${stats(encoder(8)).nands} NANDs.</p>
        <p>Input 0 is not connected to anything: "input 0 is set" and "nothing is set" both give 0. With two inputs set the output is
        the OR of their indices, which is meaningless. Both problems need the next circuit.</p>
        <p>It is cheap, as the arithmetic suggests: no multiplexers and no select logic, ${stats(encoder(8)).nands / 3} NANDs per output bit, ${logicDepth(encoder(8))} gate delays deep. Its weakness is the assumption: it works only when exactly one input is high,
        and nothing in the circuit checks that.</p>`,
      tour: {
        beats: [
          { title: 'One input: bit 5', set: { x: 0b00100000 }, show: ['u1', 'u3'], expect: { y: 5 },
            say: '<p>x₅ = 1. Index 5 = 0b101 has bits 2 and 0 set, so the ORs of those two output bits fire. y = {b:y} = {v:y}.</p>' },
          { title: 'One input: bit 2', set: { x: 0b00000100 }, show: ['u2'], expect: { y: 2 },
            say: '<p>x₂ = 1: only output bit 1 collects it. y = {b:y}.</p>' },
          { title: 'Input 0', set: { x: 0b00000001 }, expect: { y: 0 },
            say: '<p>x₀ = 1: index 0 has no bits set, so no OR sees it. y = {v:y}.</p>' },
          { title: 'Nothing at all', set: { x: 0 }, expect: { y: 0 },
            say: '<p>x = 0: y = {v:y} again. The encoder cannot tell input 0 from no input.</p>' },
          { title: 'Two inputs: nonsense', set: { x: 0b00011000 }, show: ['u1', 'u2', 'u3'], expect: { y: 7 },
            say: '<p>x₃ and x₄ together: the ORs of both indices (0b011 and 0b100) fire. y = {b:y} = {v:y}, neither of the two. The output is the OR of the indices.</p>' },
        ],
      },
      more: {
        derive: `<p>y₀ = x₁ + x₃ + x₅ + x₇, y₁ = x₂ + x₃ + x₆ + x₇, y₂ = x₄ + x₅ + x₆ + x₇: each output bit ORs the four inputs whose index has that bit set. x₀ appears in none. Each 4-input OR is ${stats(encoder(8)).nands / 3} NANDs here.</p>`,
        real: `<p>A pure encoder appears where the hardware guarantees one request at a time: a keypad scanned row by row, a one-hot FSM turned into a state number, the output of a decoder in a test circuit. Anything that
          can see two requests needs the priority version.</p>`,
        pitfall: `<p>Treating the output as safe for any input. Two inputs set at once produce the OR of their indices (the tour: 3 and 4 give 7), and no output signals the problem. The first symptom of a non-one-hot input is an answer that
          belongs to neither request.</p>`,
        numbers: `<table class="mini"><tr><th>inputs</th><th>NANDs</th><th>delays</th></tr>
          ${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${stats(encoder(n)).nands}</td><td>${logicDepth(encoder(n))}</td></tr>`).join('')}</table>`,
      },
      scene: () => ({ root: encoder(8), inputs: { x: 0b00100000 } }),
    },
    {
      title: 'Priority: the highest request wins',
      body: `
        <p>A <strong>priority encoder</strong> accepts any pattern of requests and reports the highest one, plus <span data-show="pin:v"><code>v</code></span> (valid)
        to tell "request 0" from "no request". It is built recursively: <span data-show="lo hi">two half-size encoders</span>, and if the upper half has any
        request it wins, so its <code>v</code> becomes the top index bit and steers <span data-show="mx">a multiplexer</span> for the low bits.</p>
        <p>log₂ n − 1 levels of multiplexers: ${logicDepth(priorityEncoder(8))} gate delays for 8 inputs, ${logicDepth(priorityEncoder(32))} for 32. Arbiters (who is served first), floating-point
        normalization (find the leading 1) and content-addressable memories (looked up by value, not by address) all rely on one.</p>
        <p>The recursion is the design: an n-input encoder is two (n/2)-input encoders and a 2:1 choice. The cost is ${stats(priorityEncoder(8)).nands} NANDs for 8 inputs and ${stats(priorityEncoder(32)).nands} for 32, a bit more than linear, and the delay grows by a multiplexer for every doubling.
        Unlike the plain encoder, any request pattern is legal; an unrealistic one just has the same answer as its highest bit.</p>`,
      tour: {
        beats: [
          { title: 'No request', set: { r: 0 }, show: ['any'], expect: { y: 0, v: 0 },
            say: '<p>r = 0: y = {v:y}, and v = {v:v} says that this 0 means nothing.</p>' },
          { title: 'Request 0 only', set: { r: 1 }, show: ['lo'], expect: { y: 0, v: 1 },
            say: '<p>r = 0b{b:r}: y = {v:y} again, but v = {v:v}: now the 0 is the number of a real request.</p>' },
          { title: 'Several requests', set: { r: 0b00010110 }, show: ['lo', 'hi', 'mx'], expect: { y: 4, v: 1 },
            say: '<p>r = 0b{b:r}: requests 1, 2 and 4. The upper half (4 to 7) has one, so it wins and steers the multiplexer: y = {v:y}.</p>' },
          { title: 'A higher one arrives', set: { r: 0b11010110 }, show: ['hi', 'mx'], expect: { y: 7, v: 1 },
            say: '<p>r = 0b{b:r}: requests 6 and 7 arrive. Within the upper half the recursion picks again: y = {v:y}. The lower requests are still there, but they are ignored.</p>' },
          { title: 'Only low requests', set: { r: 0b00000110 }, show: ['lo', 'hi', 'mx'], expect: { y: 2, v: 1 },
            say: '<p>r = 0b{b:r}: the upper half is empty, so its v is 0 and the multiplexer passes the lower half\'s answer: y = {v:y}.</p>' },
        ],
      },
      more: {
        derive: `<p>For n = 2m inputs: let (yₕ, vₕ) and (yₗ, vₗ) be the answers of the two halves. Then v = vₕ + vₗ, y = (vₕ, vₕ ? yₕ : yₗ): the top index bit is vₕ and the rest are chosen by it. The delay obeys D(n) = D(n/2) + one multiplexer,
          so D(n) grows with log₂ n, not with n.</p>`,
        real: `<p>Interrupt controllers use priority encoders to pick the most urgent request; bus arbiters use them (or the round-robin version of a later chapter); floating-point units find the leading one to normalize a result; and many ISAs have
          an instruction for it (count leading zeros, <code>clz</code>; in RISC-V the Zbb extension).</p>`,
        pitfall: `<p>Assuming the highest <em>index</em> is the highest <em>priority</em>. The convention here (the highest index wins) is one of two; many controllers give priority to the lowest. Swapping them reverses the request numbering,
          and a wrong convention reaches the wrong handler. On the circuit it is the multiplexer that decides, and it favours the upper half.</p>`,
        numbers: `<table class="mini"><tr><th>inputs</th><th>NANDs</th><th>delays</th></tr>
          ${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${stats(priorityEncoder(n)).nands}</td><td>${logicDepth(priorityEncoder(n))}</td></tr>`).join('')}</table>`,
      },
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
        <p>A memory's write path is a demultiplexer: the address picks the row, and the write enable is the data.</p>
        <p>This 4-bit, four-output demultiplexer costs ${stats(demux(2, 4)).nands} NANDs: the decoder's ${stats(decoder(2)).nands} plus ${4 * 4} two-input ANDs (${4 * 4 * stats(AND).nands} NANDs) gating each bit of the word into each output. The word fans out to all four rows,
        and the decoder's lines each drive a whole row of ANDs.</p>`,
      tour: {
        beats: [
          { title: 'Select 2', set: { x: 0xa, s: 2 }, show: ['dec', 'g2'], expect: { y0: 0, y1: 0, y2: 10, y3: 0 },
            say: '<p>x = {v:x}, s = {v:s}: the decoder raises line 2, and the row of ANDs g2 passes the word. y2 = {v:y2}; the other outputs are 0.</p>' },
          { title: 'Select 0', set: { s: 0 }, show: ['dec', 'g0'], expect: { y0: 10, y1: 0, y2: 0, y3: 0 },
            say: '<p>s = 0: the same word now goes to y0 = {v:y0}, and y2 has dropped to {v:y2}. A demultiplexer routes, it does not copy.</p>' },
          { title: 'New data, select 3', set: { x: 5, s: 3 }, show: ['dec', 'g3'], expect: { y0: 0, y3: 5 },
            say: '<p>x = {v:x}, s = {v:s}: y3 = {v:y3}.</p>' },
          { title: 'The word is zero', set: { x: 0 }, show: ['g3'], expect: { y3: 0 },
            say: '<p>x = 0: every output is 0, selected or not. A 0 on a selected output and a 0 on a deselected one look the same: the demultiplexer cannot say which row it is serving, only the select can.</p>' },
        ],
      },
      more: {
        derive: `<p>y_k[i] = (s = k) · x[i]. With one-bit data this is the decoder with enable (the enable is x). For w bits, w ANDs per output, so the AND array has 2ᵏ·w gates; the decoder is shared. Cost ${stats(decoder(2)).nands} + 2ᵏ·w·${stats(AND).nands}
          = ${stats(demux(2, 4)).nands} at k = 2, w = 4.</p>`,
        real: `<p>Demultiplexers distribute a result to one of several destinations: a write-back bus into a register file, a network switch's port selector, a DMA engine addressing a peripheral. Parallel-to-serial and serial-to-parallel
          conversions (the shift register) are time-domain versions of the same idea.</p>`,
        pitfall: `<p>Assuming deselected outputs are "disconnected". They are driven to 0, so two demultiplexers feeding one wire fight whenever one drives a 1 against the other's 0, selected or not: combine them with an OR, not a shared wire, or use tri-state outputs where the sharing is a bus.</p>`,
      },
      scene: () => ({ root: demux(2, 4), inputs: { x: 0xa, s: 2 } }),
    },
  ],
};
