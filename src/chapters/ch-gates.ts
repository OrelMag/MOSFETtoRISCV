import { groupDigits } from '../sim/numfmt';
import type { ComponentDef } from '../sim/types';
import { equal } from '../lib/combinational';
import { AND, MUX2, NOR, NOT, OR, XNOR, XOR } from '../lib/gates';
import { EXTEND4_8, NEGATE4, SHIFTS8 } from '../lib/numbers';
import { NAND } from '../lib/transistors';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { numberWidget } from '../widgets/numbers';
import { encodingsWidget, fixedWidget, overflowWidget } from '../widgets/numsys';
import type { Chapter } from './types';
import { numOf } from './order';

const nd = (d: ComponentDef): number => stats(d).nands;
const tr = (d: ComponentDef): number => stats(d).transistors;

/** NAND delays on the longest path from one input port to one output port. */
export function pathDepth(def: ComponentDef, from: string, to: string): number {
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

export const chGates: Chapter = {
  id: 'gates', num: numOf('gates'), title: 'Gates from NAND', level: 'Gates',
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
        options: ['4', '2', '3', '1'],
        answer: 0,
        explain: '4: an OR is two inverters and a NAND (3); inverting its output costs one more NAND used as NOT.',
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
        The NAND's four truth-table rows collapse to the two where its inputs agree: a = 0 gives 1, a = 1 gives 0. One NAND makes an
        inverter.</p>
        <p>Every gate in this chapter is drawn with its usual symbol, but inside it is only NANDs. Double-click it to check.
        NOT costs ${nd(NOT)} NAND, ${tr(NOT)} transistors and ${logicDepth(NOT)} gate delay.</p>
        <p>Why build everything from NAND? It is <em>universal</em>: any <span data-ahead="truthtable">truth table (a function's output listed for every input combination)</span> can be made from NANDs alone, as the rest of
        the chapter shows gate by gate. And in CMOS it is among the cheapest gates there is (4 transistors for two inputs), so a library with
        one brick loses little and gains a lot: one cell to design, test and count.</p>`,
      scene: () => ({ root: NOT, inputs: { a: 0 } }),
      more: {
        derive: `<p>NAND(a, b) = ¬(a·b). Tie b to a: ¬(a·a), and a·a = a (idempotence), so y = ¬a. The other way to make a NOT is to tie
          b to a constant 1: ¬(a·1) = ¬a. Both work; tying the inputs together needs no constant source.</p>`,
        real: `<p>A CMOS inverter is one PMOS and one NMOS: 2 transistors. Tying the inputs of a ${tr(NAND)}-transistor NAND wastes two of them:
          the ${tr(NOT)} transistors counted here are the price of having a single brick. Standard-cell libraries have a real inverter cell,
          and an inverter is also the unit in which gate delay is quoted (the FO4 delay: an inverter driving four copies of itself).</p>`,
        pitfall: `<p>Tied inputs mean the driver sees two gate loads, not one: a signal that feeds a NOT built this way loads its source twice
          as heavily as a single-input inverter would. Unit delay hides it; the Load setting in the Timing panel does not.</p>`,
      },
    },
    {
      title: 'AND: undo the NOT',
      body: `
        <p><span data-show="g1">NAND</span> is AND followed by NOT. Add <span data-show="g2">another NOT</span> and the two inversions cancel:
        <strong>AND = NAND → NOT</strong>. Two NANDs, ${tr(AND)} transistors, ${logicDepth(AND)} gate delays.</p>
        <p>Notice the cost: AND is <em>more</em> expensive than NAND, ${nd(AND)} against ${nd(NAND)}. It is not an accident of this site. A CMOS gate is
        one stage of pull-up and pull-down transistors, and one stage always inverts: a rising input can only pull the output down. A
        non-inverting gate needs two stages, so in CMOS the inverting gates are the cheap and fast ones, and designers think in NANDs
        and NORs, not ANDs and ORs.</p>`,
      scene: () => ({ root: AND, inputs: { a: 1, b: 0 } }),
      tour: {
        beats: [
          { title: 'Both high', set: { a: 1, b: 1 }, show: ['g1', 'g2'], expect: { y: 1 },
            say: '<p>a = b = 1: g1 = NAND(1, 1) = 0, and g2 inverts it: y = {v:y}. The NAND says "not both"; the second gate turns that into "both".</p>' },
          { title: 'One low', set: { a: 1, b: 0 }, show: ['g1', 'g2'], expect: { y: 0 },
            say: '<p>b = 0: g1 = NAND(1, 0) = 1, g2 inverts it: y = {v:y}. One 0 on an input is enough.</p>' },
          { title: 'Without the second gate', show: ['g1'], ghost: ['g2'], expect: { y: 0 },
            say: '<p>Take g2 away (dashed) and the output would be g1 itself: 1 here, the NAND, where AND gives {v:y}. The second NAND is the whole difference between them.</p>' },
        ],
      },
      more: {
        derive: `<p>AND(a, b) = a·b = ¬¬(a·b) = ¬NAND(a, b) = NAND(g, g) with g = NAND(a, b). Count: 1 + 1 = ${nd(AND)} NANDs, and the output is
          ${logicDepth(AND)} delays from either input.</p>`,
        real: `<p>A real AND cell is a NAND followed by an inverter in one footprint: 6 transistors, against ${tr(AND)} here. Libraries still
          offer it because it saves a wire and a placement, but a synthesis tool will choose NAND-based structures wherever the logic allows.</p>`,
        pitfall: `<p>Counting gates in "ANDs and ORs" overstates the work. An AND-OR circuit (two levels) turns into NAND-NAND by De Morgan, and every
          inverter at the junction between the levels disappears: x·y + z·w = NAND(NAND(x, y), NAND(z, w)).</p>`,
      },
    },
    {
      title: "OR: De Morgan's trick",
      body: `
        <p>Augustus De Morgan noticed that "a or b" is the same as "not (not a and not b)". In symbols:
        a + b = ¬(¬a · ¬b). It follows from his law for NAND: ¬(x·y) = ¬x + ¬y, "not both" means "at least one is false", applied to x = ¬a, y = ¬b.</p>
        <p>So <span data-show="g1 g2">invert both inputs</span> and <span data-show="g3">NAND them</span>: <strong>${nd(OR)} NANDs</strong> make an OR,
        ${logicDepth(OR)} delays deep (the two inverters work side by side). It costs more than the NAND it is made around, for the same reason as AND: the
        inversions have to be put back by hand.</p>
        <div class="try">Set both inputs to 0 and follow the signals: both inverters output 1, and NAND(1, 1) = 0.</div>`,
      scene: () => ({ root: OR, inputs: { a: 0, b: 1 } }),
      tries: [(st) => st.getInput('a') === 0 && st.getInput('b') === 0 && st.value('y') === 0],
      tour: {
        beats: [
          { title: 'Both low', set: { a: 0, b: 0 }, show: ['g1', 'g2', 'g3'], expect: { y: 0 },
            say: '<p>a = b = 0: both inverters give 1, and g3 = NAND(1, 1) = 0. y = {v:y}: no input is high.</p>' },
          { title: 'One high', set: { a: 1 }, show: ['g1', 'g3'], expect: { y: 1 },
            say: '<p>a = 1: g1 inverts it to 0, and a NAND with a 0 input is always 1. y = {v:y}. The other input, still 0, makes no difference.</p>' },
          { title: 'Both high', set: { b: 1 }, show: ['g1', 'g2', 'g3'], expect: { y: 1 },
            say: '<p>a = b = 1: both inverters give 0 and g3 = NAND(0, 0) = 1: y = {v:y}. This row separates OR from XOR, which gives 0 here.</p>' },
        ],
      },
      more: {
        derive: `<p>Truth table of ¬(¬a·¬b): the inner AND is 1 only for a = b = 0, so the NAND is 0 only there, which is the OR. In general De Morgan swaps AND and OR when
          every input and the output are inverted: a + b = ¬(¬a·¬b) and a·b = ¬(¬a + ¬b). Any gate network can be "pushed" this way, bubbles
          moving from outputs to inputs.</p>`,
        real: `<p>In CMOS an OR is a NOR followed by an inverter (6 transistors, against ${tr(OR)} here). The NOR is the slower of the two inverting gates: its
          PMOS transistors sit in series, and a PMOS conducts less current than an NMOS of the same size. That is one more reason libraries are
          NAND-heavy.</p>`,
        pitfall: `<p>Forgetting the inverters: a plain NAND of a and b agrees with OR only on the two mixed rows. It gives 1 at a = b = 0 and 0 at a = b = 1, the opposite of OR on both
          rows. Truth tables are checked on every row for exactly this reason.</p>`,
      },
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
        <p>Reuse is how hardware (and software) scales. Once a block works, we stop thinking about its inside. The bill is still there,
        though: the Info tab flattens every box, and the NOR comes to ${nd(NOR)} NANDs (${nd(OR)} + ${nd(NOT)}), ${tr(NOR)} transistors, ${logicDepth(NOR)} delays deep. Hierarchy
        organizes the design; it does not hide the cost.</p>`,
      scene: () => ({ root: NOR, inputs: { a: 0, b: 0 } }),
      more: {
        derive: `<p>Two routes to the same ${nd(NOR)} NANDs. By composition: NOR = NOT(OR) = ${nd(OR)} + ${nd(NOT)}. By De Morgan: ¬(a + b) = ¬a·¬b, two inverters and an AND
          (${nd(NOT)} + ${nd(NOT)} + ${nd(AND)}). The Boolean function is the same, so the counts agree here, but that is a coincidence of this brick, not a law.</p>`,
        real: `<p>A CMOS NOR is a single stage of 4 transistors, like the NAND, with the PMOS pair in series and the NMOS pair in parallel. Its drawback is the
          series PMOS: for equal speed it needs wider transistors than a NAND, so designers prefer NAND-heavy netlists, and a NOR with many inputs is rare.</p>`,
        pitfall: `<p>Reading the box count as the gate count: the stage shows two boxes, or, not. Hierarchy shows how the design is organized, and
          cost sits in the leaves. Compare the Info tab of the NOR with the sum of the boxes you see on the stage.</p>`,
      },
    },
    {
      title: 'XOR: are they different?',
      body: `
        <p><strong>Exclusive OR</strong> outputs 1 when its inputs differ. It is the heart of binary addition
        (1 + 1 = 0, carry 1) and of comparison: the sum bit of a column is a XOR b XOR the carry in, and a XOR b is 0 exactly when two bits agree.</p>
        <p>The classic circuit uses ${nd(XOR)} NANDs and shares the first one cleverly:
        <span data-show="g1"><code>m = NAND(a, b)</code></span> feeds <span data-show="g2 g3">both middle gates</span>, which each mix m with one input;
        <span data-show="g4">the last NAND</span> combines them. The longest path (through m) is ${logicDepth(XOR)} delays; a direct
        path from an input to the output (through g2 or g3 only) is ${pathDepth(XOR, 'a', 'y') - 1} delays deep, one fewer. The tour checks all four rows.</p>`,
      scene: () => ({ root: XOR, inputs: { a: 1, b: 0 } }),
      tour: {
        beats: [
          { title: 'Equal: 0 and 0', set: { a: 0, b: 0 }, show: ['g1', 'g2', 'g3', 'g4'], expect: { y: 0 },
            say: '<p>a = b = 0: m = NAND(0, 0) = 1, and each middle gate sees a 0 on one input, so both give 1. g4 = NAND(1, 1) = 0: y = {v:y}.</p>' },
          { title: 'Different: 1 and 0', set: { a: 1 }, show: ['g1', 'g2', 'g3', 'g4'], expect: { y: 1 },
            say: '<p>a = 1, b = 0: m is still 1. g2 = NAND(a, m) = NAND(1, 1) = 0, g3 = NAND(0, 1) = 1. g4 = NAND(0, 1) = 1: y = {v:y}. Exactly one middle gate pulled down.</p>' },
          { title: 'Different: 0 and 1', set: { a: 0, b: 1 }, show: ['g2', 'g3', 'g4'], expect: { y: 1 },
            say: '<p>Mirror image: now g3 gives 0 and g2 gives 1; g4 still sees one 0 and y = {v:y}.</p>' },
          { title: 'Equal: 1 and 1', set: { a: 1, b: 1 }, show: ['g1', 'g2', 'g3'], expect: { y: 0 },
            say: '<p>a = b = 1: m = 0 forces both middle gates to 1 whatever their other input is, and g4 = NAND(1, 1) = 0: y = {v:y}. The shared gate is what cancels this row.</p>' },
        ],
      },
      more: {
        derive: `<p>With m = ¬(ab): g2 = ¬(a·m) = ¬(a·(¬a + ¬b)) = ¬(a·¬b), because a·¬a = 0. In the same way g3 = ¬(b·¬a). Then y = ¬(g2·g3) = ¬g2 + ¬g3 =
          a·¬b + ¬a·b, which is a ⊕ b. The shared m does the work of the two inverters a direct sum of products would use: ${nd(XOR)} NANDs against 5.</p>`,
        real: `<p>Standard-cell XORs are not made of four NANDs: they are 10 to 12 transistors in static CMOS, or 6 with transmission gates. XOR is an expensive gate in
          every technology, which is why adders (one XOR per bit for the sum) and parity trees are costly, and why designers avoid XOR where a simpler gate will do.</p>`,
        pitfall: `<p>Reading XOR as "or": the OR gate of the previous steps gives 1 at a = b = 1, XOR gives 0. For more than two inputs the XOR
          chain computes <em>parity</em> (1 for an odd number of ones), not "exactly one".</p>`,
      },
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
        <p><span data-show="x1">XOR</span> followed by <span data-show="not1">NOT</span> gives 1 when the inputs are equal: ${nd(XNOR)} NANDs, ${logicDepth(XNOR)} delays deep.
        Put an XNOR on every bit pair of two numbers and AND
        the results together, and you have an <span data-ahead="comparator">equality comparator (a circuit whose output is 1 when two words are equal)</span> (the processor's <code>beq</code>
        instruction will need one).</p>
        <p>The price of that comparator grows with the width: for 32 bits, 32 XNORs and a tree that ANDs 32 results, ${nd(equal(32))} NANDs in all and
        ${logicDepth(equal(32))} delays deep. Equality is cheap compared with <em>magnitude</em> comparison: each bit pair is judged on its own and the verdicts are ANDed, whereas "greater than" needs a rule that the highest differing bit decides.</p>`,
      scene: () => ({ root: XNOR, inputs: { a: 1, b: 1 } }),
      more: {
        derive: `<p>a XNOR b = ¬(a ⊕ b) = a·b + ¬a·¬b: both 1 or both 0. A word compare is x = y exactly when every bit pair agrees:
          eq = XNOR(x₀, y₀) · XNOR(x₁, y₁) · … · XNOR(xₙ₋₁, yₙ₋₁).</p>`,
        real: `<p>Hardware equality compares also appear in the places that most need them: the cache tag compare, forwarding logic in a pipeline
          (does this source register match that destination?), and the content-addressable memories of a later chapter.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>NANDs</th><th>delays</th></tr>
          ${[8, 16, 32, 64].map((n) => `<tr><td>${n}</td><td>${nd(equal(n))}</td><td>${logicDepth(equal(n))}</td></tr>`).join('')}</table>
          <p>Cost grows linearly with the width and depth with its logarithm.</p>`,
      },
    },
    {
      title: 'The multiplexer: a digital switch',
      body: `
        <p>A <strong>multiplexer</strong> (mux) picks one of two inputs: <code>y = s ? b : a</code>.
        The <span data-show="pin:s">select line <code>s</code></span> decides which input gets through.</p>
        <p>It is <span data-show="g1 g2 g3 g4">${nd(MUX2)} NANDs</span>: <code>g1</code> inverts s, <code>g2</code> lets a through while s = 0, <code>g3</code> lets b through while s = 1, and
        <code>g4</code> merges the two (the one that is not blocked decides). The data inputs reach y in ${pathDepth(MUX2, 'a', 'y')} delays; the select takes
        ${pathDepth(MUX2, 's', 'y')}, one more, because of its inverter. A mux may be the most important block in a processor: muxes choose the next
        instruction address, choose between a register and a constant, and choose what gets written back.</p>`,
      scene: () => ({ root: MUX2, inputs: { a: 1, b: 0, s: 0 } }),
      tour: {
        beats: [
          { title: 's = 0: a passes', set: { a: 1, b: 0, s: 0 }, show: ['g1', 'g2', 'g3', 'g4'], expect: { y: 1 },
            say: '<p>s = 0: g1 = 1 opens g2, which gives NAND(a, 1) = ¬a = 0. g3 = NAND(b, 0) = 1 is blocked. g4 = NAND(0, 1) = 1: y = {v:y}, a.</p>' },
          { title: 's = 1: b passes', set: { s: 1 }, show: ['g1', 'g2', 'g3', 'g4'], expect: { y: 0 },
            say: '<p>s = 1: g1 = 0 blocks g2 (its output is 1 whatever a is), g3 = NAND(b, 1) = ¬b = 1. g4 = NAND(1, 1) = 0: y = {v:y}, b.</p>' },
          { title: 'The other input is ignored', set: { a: 0 }, show: ['g2'], expect: { y: 0 },
            say: '<p>Change a while s = 1: g2 stays 1, so nothing moves. y = {v:y}. The select decides which input exists as far as the output is concerned.</p>' },
          { title: 'Change b', set: { b: 1 }, show: ['g3', 'g4'], expect: { y: 1 },
            say: '<p>b = 1: g3 = NAND(1, 1) = 0 and g4 = NAND(1, 0) = 1. y = {v:y} follows b.</p>' },
        ],
      },
      more: {
        derive: `<p>Every truth table has a circuit, found mechanically. Take each row whose output is 1 and write its inputs as an AND
          (a <em>minterm</em>: ¬s·a·¬b for s a b = 010); OR the minterms. That <strong>sum of products</strong> is two levels of logic, AND
          then OR, and De Morgan turns it into two levels of NAND: x·y + z·w = ¬(¬(x·y)·¬(z·w)), an OR of ANDs is a NAND of NANDs.
          The multiplexer is exactly this: y = ¬s·a + s·b = NAND(NAND(¬s, a), NAND(s, b)), plus one NAND for ¬s, which is
          <span data-show="g1 g2 g3 g4">the four gates on the stage</span>.</p>
          <p>The raw minterms are rarely the cheapest sum: its table has four (s a b = 010, 011, 101, 111), merged in pairs into
          two, since x·b + x·¬b = x. A <strong>Karnaugh map</strong> lays the table out on a grid in Gray-code order, so rows that
          differ in one input sit side by side (edges wrapping); circling the largest power-of-two blocks of 1s, don't-cares
          included where they help, reads off a minimal sum of products by eye, up to four or five inputs. Past that, programs
          do it: Quine–McCluskey (exact, run for <a href="#/c/memory/5">chapter 10's PLA</a>) and the heuristics inside synthesis
          tools. Nor is a minimal sum the cheapest circuit: the XOR above shares m and takes ${nd(XOR)} NANDs, against 5 for its sum of products a·¬b + ¬a·b (two inverters, three NANDs).</p>`,
        real: `<p>Library mux cells are not four NANDs: a transmission-gate mux is two pass gates and an inverter, 6 transistors (8 with an output buffer), against ${tr(MUX2)}
          here. Wide muxes (8:1, 16:1) are built as trees of these or as one-hot AND-OR structures, and the choice of structure decides the delay of the register-file read
          and of a CPU's operand select.</p>`,
        pitfall: `<p>A mux can glitch while s changes even when a and b are equal. With a = b = 1, s falling from 1 to 0 turns g3 off one delay before g2, which waits
          for the inverted select: for one gate delay both are 1, and y dips to 0 and back. The settled output never changes, but anything sampling at the wrong moment, or a
          clock fed from it, sees a runt pulse. Watch it in the Timing panel.</p>`,
      },
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
  id: 'binary', num: numOf('binary'), title: 'Binary numbers', level: 'Numbers',
  blurb: 'Bits as numbers: unsigned, hex, two\'s complement, overflow, extension, shifts and fixed point.',
  goals: [
    'convert between binary, hexadecimal and decimal, and read one bit pattern as unsigned or two\'s complement',
    'say why two\'s complement won (one zero, the plain adder) and tell the two overflows apart with C and V',
    'negate, extend and shift a number, and price each in gates: most of them are only wires',
    'read fixed-point fractions and say why 0.1 has no exact binary form',
  ],
  builds: ['gates'],
  recap: {
    keep: [
      'An n-bit bus carries an unsigned number from 0 to 2ⁿ − 1, bit i worth 2ⁱ. One hex digit stands for four bits: <code>0b1010_1111</code> = <code>0xAF</code> = 175.',
      'Fixed-width arithmetic wraps around like an odometer: in 4 bits, 15 + 1 = 0.',
      'Two\'s complement gives the top bit a negative weight (−8 in 4 bits, −128 in 8). All ones is −1.',
      'To negate, invert every bit and add 1. The same adder adds signed and unsigned numbers.',
      'Signed overflow: the true result leaves −2ⁿ⁻¹…2ⁿ⁻¹ − 1 (8 bits: 0x7F + 1 = 0x80 = −128). Operands of opposite sign never overflow.',
      'C (carry out) flags an unsigned wrap, V (carry into the top column ⊕ carry out) a signed one. Sign-magnitude, one\'s complement and bias all need more than the plain adder.',
      'Negation is XORs under an OR chain; sign extension copies the top bit, zero extension adds 0s; a constant shift is splitter-to-merger wiring. sra rounds toward −∞.',
      'Fixed point Qm.f is an integer meaning x / 2ᶠ: same adder, fixed step. 0.1 repeats for ever in binary.',
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
        digit is worth ten times the one to its right; in <strong>binary</strong>, twice: 1, 2, 4, 8, 16… A digit string is read the
        same way in every base: multiply each digit by its place value and add. Base 2 is the one hardware speaks, because a wire has two states.</p>
        <p>The width of the bus sets the range: n wires carry 2ⁿ different patterns, 0 to 2ⁿ − 1 read as an unsigned number. Eight wires give
        ${2 ** 8}, sixteen ${groupDigits(2 ** 16)}, thirty-two ${groupDigits(2 ** 32)}. Every width in a processor (a register, an
        address, an arithmetic unit) is a decision about where that range ends, and what happens past it: the number wraps around.</p>
        <p>Long binary numbers are hard to read, so we write them in <strong>hexadecimal</strong>, one digit (0–9,
        A–F) for every four bits. <code>0b1010_1111</code> is <code>0xAF</code> is ${parseInt('10101111', 2)}. The grouping costs nothing in hardware:
        a hex digit is four wires read together.</p>
        <div class="try">Flip the bits. Try making 255, then add 1.</div>`,
      widget: () => numberWidget(8, false, { halve: true }),
      challenge: {
        kind: 'quiz', question: 'How many bits does a counter need to count from 0 to 1000?',
        options: ['10', '9', '1000', '4'], answer: 0,
        why: ['', '9 bits give 2⁹ = 512 patterns, 0 to 511: not enough.', 'One wire per value is a one-hot code. Binary needs only log₂ of the count.', 'Four decimal digits are not four bits: each bit only doubles the range.'],
        explain: '0 to 1000 is 1001 values. 2¹⁰ = 1024 ≥ 1001 > 512 = 2⁹, so 10 bits.',
      },
      more: {
        derive: `<p>A bit string bₙ₋₁…b₁b₀ is worth Σ bᵢ·2ⁱ. For 0b1010_1111: 128 + 32 + 8 + 4 + 2 + 1 = ${128 + 32 + 8 + 4 + 2 + 1}. To convert the other way, divide by 2 and
          keep the remainders (least significant bit first), or subtract the largest power of two that fits at each step. Hex needs no arithmetic at all: 16 = 2⁴, so each hex digit
          is exactly one group of four bits.</p>`,
        real: `<p>Hardware numbers have fixed widths: RISC-V registers are 32 or 64 bits, bytes are 8, and addresses and instruction fields have widths of their own. Hex is
          how register dumps, memory addresses and machine code are written everywhere, which is why this site writes constants as 0x…</p>`,
        pitfall: `<p>Grouping from the wrong end. A 10-bit pattern splits into groups of four from the <em>right</em>, padding the left with zeros: 11_0110_1101 is 0x${parseInt('1101101101', 2).toString(16).toUpperCase()}. Grouping from the left (1101, 1011, 01) gives nonsense.
          And 0x10 is sixteen, not ten: a hex digit's weight is a power of 16.</p>`,
        numbers: `<table class="mini"><tr><th>binary</th><th>hex</th><th>decimal</th></tr>
          ${Array.from({ length: 16 }, (_, i) => `<tr><td>${i.toString(2).padStart(4, '0')}</td><td>${i.toString(16).toUpperCase()}</td><td>${i}</td></tr>`).join('')}</table>`,
      },
    },
    {
      title: "Negative numbers: two's complement",
      body: `
        <p>Fixed-width numbers wrap around like an odometer: in 4 bits, 15 + 1 = 0. So the number just below 0
        must be 15, or <code>1111</code>. Calling that pattern <strong>−1</strong> works perfectly: −1 + 1 = 0.</p>
        <p>That is <strong>two's complement</strong>: the top bit is worth −8 instead of +8 (in 4 bits), and the
        same adder circuit adds signed and unsigned numbers, because both readings are the same arithmetic modulo 2ⁿ. To negate a number, invert every bit and add 1.
        The range is lopsided: n bits hold −2ⁿ⁻¹ to 2ⁿ⁻¹ − 1, so 8 bits hold ${-(2 ** 7)} to ${2 ** 7 - 1}, one more negative number than positive.</p>
        <p>Signed results can overflow too: in 8 bits 0x7F + 1 = 0x80, which reads 127 + 1 = −128. The true
        sum has left −128…127; adding two numbers of opposite sign never overflows.</p>
        <p>The same bits mean different numbers depending on how you read them. The hardware does not
        care; the <em>instruction</em> decides how to interpret them.</p>`,
      widget: () => numberWidget(4, true),
      more: {
        derive: `<p>Negation: x + ¬x = 2ⁿ − 1 (all ones: each position has exactly one 1), so x + ¬x + 1 = 2ⁿ, which is 0 in n bits. Hence −x = ¬x + 1. The top bit weighs −2ⁿ⁻¹ because a pattern with
          it set must lie that far below the positives: 1000 (−8) + 0111 (7) = −1 = 1111. Addition needs no sign logic since a − b and a + (2ⁿ − b) are equal mod 2ⁿ.</p>`,
        real: `<p>Every mainstream ISA uses two's complement. RISC-V has one <code>add</code> for both readings; the instructions that differ are the ones whose result depends on the interpretation:
          comparisons (<code>slt</code> against <code>sltu</code>), right shifts (arithmetic against logical), and widening loads (<code>lb</code> sign-extends, <code>lbu</code> does not). Overflow raises
          nothing: software checks if it must.</p>`,
        pitfall: `<p>The most negative number has no positive partner: in 8 bits, −128 inverted and incremented is −128 again, so its absolute value stays negative. Widening
          a signed number needs the right fill, too: see the step on extension below.</p>`,
        numbers: `<table class="mini"><tr><th>bits</th><th>unsigned</th><th>signed</th></tr>
          ${Array.from({ length: 16 }, (_, i) => `<tr><td>${i.toString(2).padStart(4, '0')}</td><td>${i}</td><td>${i >= 8 ? i - 16 : i}</td></tr>`).join('')}</table>`,
      },
      challenge: {
        kind: 'quiz', question: 'In 8-bit two\'s complement, what number is 0xFF?',
        options: ['255', '−1', '−127', '−128'], answer: 1,
        why: ['That is the unsigned reading of the same bits. In two\'s complement the top bit weighs −128.', '', 'That is 0xFF read as sign and magnitude. Two\'s complement gives the top bit weight −128: −128 + 127 = −1.', 'That is 0x80, the top bit alone. 0xFF adds +127 from the seven bits below it.'],
        explain: 'All ones is always −1: add 1 and every bit carries over, leaving 0. (Read as unsigned, the same bits are 255.)',
      },
    },
    {
      title: 'Why two\'s complement: four ways to sign a number',
      body: `
        <p>Two's complement is not the only way to give bits a sign. Three others were built into real machines.
        <strong>Sign-magnitude</strong>: the top bit is the sign and the rest the size, the way we write −5. <strong>One's complement</strong>:
        a negative number is its positive with every bit inverted. <strong>Bias</strong>: store x + 8 and read the unsigned value minus 8.</p>
        <p>Each costs something two's complement does not. Sign-magnitude and one's complement have two zeros, so a test for 0 must
        accept two patterns, and one pattern is wasted. Worse, a plain adder gets them wrong. Sign-magnitude needs a compare-and-subtract
        unit when the signs differ. One's complement must add the carry out back in at the bottom (an <em>end-around carry</em>, a second
        trip along the carry chain). Bias must subtract 8 after every addition. Two's complement uses the unsigned adder unchanged: it is
        arithmetic modulo 2ⁿ, with each value's representative picked from −2ⁿ⁻¹ … 2ⁿ⁻¹ − 1.</p>
        <p>The others survive where their strengths matter. Floating point (<a href="#/c/float/0">chapter 24</a>) keeps its significand
        in sign-magnitude, which multiplies easily, and its exponent biased, so that exponents compare like unsigned integers. The Internet
        checksum is a one's-complement sum.</p>`,
      widget: () => encodingsWidget(),
      more: {
        derive: `<p>In one's complement −x = (2ⁿ − 1) − x, so its arithmetic is modulo 2ⁿ − 1. A carry out is worth 2ⁿ ≡ 1, which is why it
          must be added back in at bit 0. In two's complement −x = 2ⁿ − x, the arithmetic is modulo 2ⁿ, and a carry out is worth 2ⁿ ≡ 0: it
          can simply be dropped.</p>`,
        real: `<p>The IBM 704 and 7090 used sign-magnitude integers; the UNIVAC 1100 series and the CDC 6600 used one's complement, and
          their programs had to allow for a −0. Every mainstream processor designed since the 1970s uses two's
          complement, and C made it mandatory in C23.</p>`,
        pitfall: `<p>Reading a bias-encoded field as two's complement. A float32 exponent field of 127 means 2⁰, not 2¹²⁷, and the
          sign bit of a float is not the sign bit of an integer: −0.0 and +0.0 differ in their bits.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'In 4-bit one\'s complement, what number is <code>1111</code>?',
        options: ['−0', '−1', '15', '−7'], answer: 0,
        why: ['', 'That is the two\'s-complement reading. One\'s complement negates by inverting only: 1111 is the inverse of 0000.', 'That is the unsigned reading of the same bits.', 'That is 1111 in sign-magnitude (sign 1, size 111).'],
        explain: 'Inverting every bit of 0000 gives 1111, so 1111 is −0: the second zero that one\'s complement wastes.',
      },
    },
    {
      title: 'Overflow: two flags from one addition',
      body: `
        <p>One addition, two readings, two ways to go wrong. Read unsigned, the sum is wrong exactly when it does not fit in n bits,
        that is when the carry out of the top column is 1. That bit is the <strong>carry flag</strong>, C. Read signed, the sum is wrong when two
        numbers of the same sign give a result of the other sign: two positives "add up" to a negative, or two negatives to a positive.
        That is the <strong>overflow flag</strong>, V. Numbers of opposite sign never overflow, since their sum lies between them.</p>
        <p>V has a one-gate form: <strong>V = carry into the top column ⊕ carry out of it</strong>. With both operands positive the top column
        adds 0 + 0 + c, carries nothing out, and the sum's sign is c: overflow is c = 1 against a carry out of 0. With both negative it adds
        1 + 1 + c, always carries out, and the sign is c again: overflow is c = 0 against 1. With opposite signs it adds 1 + 0 + c, which
        carries out exactly when c = 1, so the two carries always agree.</p>
        <p>So the flags are cheap: C is a wire and V one XOR. The adders of <a href="#/c/adders/5">chapter 6</a> bring both out, and
        comparisons are built on them: a &lt; b unsigned is "a − b borrows", and signed it is the sign of a − b, corrected by V.</p>`,
      widget: () => overflowWidget(),
      more: {
        derive: `<p>The signed sum is wrong exactly when the true result needs n + 1 bits. Extending both operands by one copy of their
          sign bits makes the true sum fit; the extra column adds aₙ₋₁ + bₙ₋₁ + cₙ. The n-bit result is right when that column's sum bit
          equals bit n − 1 of the result, and the four cases above reduce this to V = cₙ₋₁ ⊕ cₙ (cᵢ: the carry into column i).</p>`,
        real: `<p>x86 calls them CF and OF, ARM C and V, both kept in a flags register, set by every x86 add and by ARM's ADDS. RISC-V has no flags at all:
          <code>sltu</code> after an add finds the carry (the sum is below an operand), and a signed overflow check takes two
          <code>slt</code>s and a branch. That leaves one less register to rename in an out-of-order core.</p>`,
        pitfall: `<p>The carry after a subtraction. x86 sets CF on a borrow; ARM sets C to <em>not</em> borrow, because it subtracts by adding
          ¬b + 1 and keeps the adder's carry out. The same "carry set" test means opposite things on the two machines.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'An 8-bit adder adds <code>0x80 + 0x80</code>. Which flags does it set?',
        options: ['C and V', 'C only', 'V only', 'Neither'], answer: 0,
        why: ['', 'Signed, this is −128 + −128 = −256, which does not fit either: two negatives gave 0, which is not negative.', 'Unsigned, 128 + 128 = 256 needs a ninth bit: the carry out is 1.', 'The 8-bit result is 0x00, right in neither reading.'],
        explain: 'Unsigned 128 + 128 = 256 wraps to 0: C = 1. Signed −128 + −128 = −256 wraps to 0: V = 1 (no carry into the top column, one out of it).',
      },
    },
    {
      title: 'Negation in gates',
      body: `
        <p>¬x + 1 looks like it needs an adder, but the +1 only travels through the low end. The trailing 0s of x are 1s in ¬x: the +1
        carries through them and leaves 0s. It stops at the first 0 of ¬x, which is x's lowest 1, and sets it. Everything above is still
        inverted. So <strong>−x keeps x up to and including its lowest 1 and inverts every bit above it</strong>: −0110 (6) = 1010 (−6).</p>
        <p>In gates: bit i is inverted exactly when some bit below it is 1. An XOR is a controlled inverter (a ⊕ 1 = ¬a, a ⊕ 0 = a), and
        "some bit below is 1" is an OR of all of them, built as a chain: <span data-show="or1 or2">or1 and or2</span> pass "a 1 so far"
        down the staircase, and <span data-show="x1 x2 x3">x1, x2, x3</span> invert where it says so. Bit 0 is never inverted; it goes
        straight across to the <span data-show="my">merger</span>.</p>
        <p>Cost: n − 1 XORs and n − 2 ORs, ${nd(NEGATE4)} NANDs at 4 bits, ${logicDepth(NEGATE4)} NAND delays from a[0] to y[3]. The chain grows
        with the width like the carry of the next chapter's adders. That is no accident: it is <span data-ahead="incrementer">an incrementer (a chain that adds 1; chapter 9 builds one for its counters)</span>, with the inversion folded in.</p>
        <div class="try">Set a = 5 (0101). y should read 11 = 1011, which is −5.</div>`,
      scene: () => ({ root: NEGATE4, inputs: { a: 3 } }),
      tries: [(st) => st.getInput('a') === 5 && st.value('y') === 11],
      more: {
        derive: `<p>Write x = p·1·0ᵏ: some high bits p, its lowest 1, then k zeros. Then ¬x = ¬p·0·1ᵏ, and adding 1 carries through the k ones:
          ¬x + 1 = ¬p·1·0ᵏ. The low k + 1 bits match x, the bits of p are inverted. For x = 0 there is no lowest 1: nothing is inverted and −0 = 0.</p>`,
        real: `<p>Processors do not keep a negator: <code>neg</code> in RISC-V is the pseudo-instruction <code>sub rd, x0, rs</code>, and the
          adder's subtract path does the inverting and the +1 (next chapter). A stand-alone negator appears where an adder would be wasted,
          such as the sign fix after a divider or an absolute-value unit.</p>`,
        pitfall: `<p>The most negative number has no positive twin. Its lowest 1 is the top bit, so nothing is inverted and −(−8) = −8 in 4 bits
          (−2³¹ in 32). <code>Math.abs(Integer.MIN_VALUE)</code> is negative in Java; <code>abs(INT_MIN)</code> in C is undefined, and usually comes out negative.</p>`,
        numbers: `<table class="mini"><tr><th>bits</th><th>XOR</th><th>OR</th><th>NANDs</th></tr>
          ${[4, 8, 16, 32].map((n) => `<tr><td>${n}</td><td>${n - 1}</td><td>${n - 2}</td><td>${(n - 1) * nd(XOR) + (n - 2) * nd(OR)}</td></tr>`).join('')}</table>`,
      },
      challenge: {
        kind: 'reach', goal: 'Find the one non-zero input whose negation is itself.',
        check: (st) => st.getInput('a') === 8 && st.value('y') === 8,
        hints: ['Which 4-bit number has no positive partner in the range −8…7?', 'Its lowest 1 is the top bit: what is above it to invert?'],
        answer: 'a = 1000 (−8). Its lowest 1 is the top bit, so nothing is inverted and y = 1000. +8 does not fit in 4 bits.',
        solve: (st) => st.setInputs({ a: 8 }),
      },
    },
    {
      title: 'Wider words: sign and zero extension',
      body: `
        <p>A 4-bit value moved into an 8-bit register needs four new top bits. Unsigned, they are 0: <strong>zero extension</strong>.
        Signed, they must be copies of the sign bit: <strong>sign extension</strong>. 1011 is −5 in 4 bits and 1111_1011 is −5 in 8, while
        0000_1011 would be 11. The sign bit weighed −8; spread over five copies it weighs −128 + 64 + 32 + 16 + 8 = −8 again.</p>
        <p>Both are wiring. In the <span data-show="ms">sign</span> half the top wire fans out to four more merger inputs; in the
        <span data-show="mz">zero</span> half those inputs go to a <span data-show="gnd">tie to GND</span>. No gates, no delay.
        Narrowing is cheaper still: drop the top wires. Read as signed, the value survives only if every dropped bit equals the new top bit; read as unsigned, only if every dropped bit is 0.</p>
        <p>Which one is right is not in the bits: the instruction says. RISC-V's <code>lb</code> sign-extends a loaded byte and <code>lbu</code>
        zero-extends it (<a href="#/c/io/0">chapter 19</a>), and every 12-bit <span data-ahead="immediates">immediate (a constant stored inside the instruction word)</span> is sign-extended to 32 bits
        (<a href="#/c/isa/0">chapter 13</a>).</p>
        <div class="try">Set a = 1011. s reads 0xFB (−5 signed), z reads 0x0B (11).</div>`,
      scene: () => ({ root: EXTEND4_8, inputs: { a: 6 } }),
      tries: [(st) => st.getInput('a') === 11],
      more: {
        derive: `<p>An m-bit value is x = −2ᵐ⁻¹·b + r, with b the sign bit and r the rest. Sign-extended to n bits it is
          −2ⁿ⁻¹·b + (2ⁿ⁻¹ − 2ᵐ⁻¹)·b + r: the new copies add 2ᵐ⁻¹ + … + 2ⁿ⁻², which is 2ⁿ⁻¹ − 2ᵐ⁻¹. The two b terms collapse to
          −2ᵐ⁻¹·b: the same x.</p>`,
        real: `<p>RV64 keeps 32-bit results sign-extended in its 64-bit registers (<code>addw</code>, <code>lw</code>), so a 32-bit
          comparison works on the full register; <code>lwu</code> exists for when that is wrong. x86 names the two
          <code>movsx</code> and <code>movzx</code>.</p>`,
        pitfall: `<p>Mixing the readings. A byte 0xFF loaded with <code>lb</code> becomes −1 (0xFFFF_FFFF), with <code>lbu</code> 255. In C
          whether plain <code>char</code> is signed depends on the platform (it is unsigned on RISC-V Linux), so the same source can extend
          either way.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Make s read −1 (0xFF) while z reads 15 (0x0F).',
        check: (st) => st.getInput('a') === 15 && st.value('s') === 255 && st.value('z') === 15,
        hints: ['Which 4-bit pattern is −1?'],
        answer: 'a = 1111: −1 in 4 bits. Sign extension copies the 1 into all four new bits (0xFF, still −1); zero extension gives 0x0F = 15.',
        solve: (st) => st.setInputs({ a: 15 }),
      },
    },
    {
      title: 'Shifts by a constant are wiring',
      body: `
        <p>Moving every bit one place up multiplies by 2; one place down divides by 2. A shift by a fixed amount moves wires, not
        values: in each block here a <span data-show="s_sll s_srl s_sra">splitter</span> and a merger sit one row apart and every wire
        runs straight across.</p>
        <p>Left, <span data-show="sll">sll</span>: a 0 enters at the bottom and the top bit falls off. Right comes in two kinds.
        <span data-show="srl">Logical</span> brings in a 0 at the top, right for unsigned numbers. <span data-show="sra">Arithmetic</span>
        brings in a copy of the sign bit, so a negative number stays negative: −8 ≫ 1 = −4.</p>
        <p>The arithmetic shift rounds <em>down</em>, toward −∞: −7 ≫ 1 = −4, while −7 / 2 in C, or RISC-V's <code>div</code>, gives −3.
        The bit shifted out is the remainder, and a set one pulls a negative result down. A compiler dividing a signed number by a
        power of two adds a correction first.</p>
        <p>Cost: no gates for a fixed shift. A shift by an amount held in a register needs muxes: <span data-ahead="shifter">the barrel shifter (log₂ n stages of multiplexers, each shifting by a power
        of two or passing the word on)</span> of <a href="#/c/alu/1">chapter 11</a>.</p>
        <div class="try">Set a = 0xF9 (−7): sll = 0xF2 (−14), srl = 0x7C (124), sra = 0xFC (−4).</div>`,
      scene: () => ({ root: SHIFTS8, inputs: { a: 0x2C } }),
      tries: [(st) => st.getInput('a') === 0xF9],
      more: {
        derive: `<p>Shifting right by k drops the low k bits, the remainder of a division by 2ᵏ, and keeps the quotient rounded down:
          a ≫ k = ⌊a / 2ᵏ⌋. That holds for srl on the unsigned reading and for sra on the signed one. Division in C and RISC-V rounds
          toward 0 instead, so for negative a they differ by one whenever a bit shifted out was 1.</p>`,
        real: `<p>RISC-V has <code>slli</code>, <code>srli</code> and <code>srai</code> with the amount in the instruction, and <code>sll</code>,
          <code>srl</code>, <code>sra</code> with it in a register. One bit of the encoding (bit 30) tells the two right shifts apart.
          Java spells them <code>&gt;&gt;&gt;</code> and <code>&gt;&gt;</code>.</p>`,
        pitfall: `<p>Shifting by the full width or more. In C it is undefined; RISC-V uses only the low 5 bits of the amount (6 on RV64), so
          <code>x &lt;&lt; 32</code> on RV32 leaves x unchanged rather than giving 0.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Make sra read −1 (0xFF) from an input that is not −1.',
        check: (st) => st.getInput('a') !== 0xFF && st.value('sra') === 0xFF,
        hints: ['sra halves and rounds down. Which number halves to exactly −1?'],
        answer: 'a = 0xFE (−2): −2 ≫ 1 = −1. (−1 ≫ 1 is −1 too: rounding down, −0.5 becomes −1, never 0.)',
        solve: (st) => st.setInputs({ a: 0xFE }),
      },
    },
    {
      title: 'Fractions: fixed point',
      body: `
        <p>A binary point can sit anywhere: the bits to its right weigh ½, ¼, ⅛ … The hardware does not change. A number with f
        fraction bits is an integer that means x / 2ᶠ. Addition is the same adder, since the points line up. A product has 2f fraction bits,
        so it is shifted right by f, a constant shift as in the step before. This is <strong>fixed point</strong>, written Qm.f: m integer
        bits, f fraction bits (unsigned here; a signed Qm.f spends one of the m on the sign, so signed Q4.4 runs from −8 to 7.9375).</p>
        <p>The price is a fixed step and a fixed range. Q4.4 counts in sixteenths up to 15.9375, and every value in between rounds to the
        nearest step. Some decimal fractions never fit exactly. 0.1 is 1/10, and 10 has a factor of 5 that no power of two contains, so its
        binary expansion repeats for ever, as 1/3 does in decimal. More bits shrink the error but never remove it.</p>
        <p>DSPs, audio codecs and texture coordinates carry fractions this way, and the vertex kernel of <a href="#/c/graphics/0">chapter 34</a>
        rotates in 16.16 fixed point. When a range must stretch from tiny to huge the point has to move with the number: that is floating
        point, <a href="#/c/float/0">chapter 24</a>.</p>`,
      widget: () => fixedWidget(),
      more: {
        derive: `<p>Qa.f × Qb.f: (x / 2ᶠ)(y / 2ᶠ) = xy / 2²ᶠ, so the integer product has 2f fraction bits and a shift right by f brings it back
          to f. Signed fixed point is two's complement with the same rule: −0.5 in Q4.4 is −8 / 16 = 1111_1000.</p>`,
        real: `<p>Many DSPs work in Q1.15 or Q1.31, with a multiplier that shifts the product by one place for free and saturating
          adders that stick at the largest value instead of wrapping. GPUs snap vertex positions to a fixed-point grid (typically 8 fraction
          bits of a pixel) before rasterizing, so edge tests are exact.</p>`,
        pitfall: `<p>Rounding by truncation. Shifting right drops the low bits, which rounds toward −∞ (the sra of the step before), so
          errors pile up on one side over a long sum. Adding half a step, 2ᶠ⁻¹, before the shift rounds to nearest.</p>`,
        numbers: `<table class="mini"><tr><th>format</th><th>step</th><th>range (unsigned)</th></tr>
          ${[[8, 0], [4, 4], [1, 7], [16, 16]].map(([m, f]) => `<tr><td>Q${m}.${f}</td><td>${f ? `1/${2 ** f}` : '1'}</td><td>0 … ${(2 ** (m + f) - 1) / 2 ** f}</td></tr>`).join('')}</table>`,
      },
      challenge: {
        kind: 'quiz', question: 'In Q4.4, what value is <code>0001_1000</code>?',
        options: ['1.5', '24', '1.8', '0.15'], answer: 0,
        why: ['', 'That is the integer reading, without the point: 24 / 16 = 1.5.', 'The fraction bits are binary: 1000 after the point is ½, not 8 tenths.', 'That moves a decimal point, not a binary one.'],
        explain: 'Integer part 0001 = 1, fraction .1000 = ½: 1.5, which is 24 / 2⁴.',
      },
    },
  ],
};
