import type { ComponentDef } from '../sim/types';
import { AND, MUX2, NAND, NOR, NOT, OR, XNOR, XOR, equal } from '../lib';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { numberWidget } from '../widgets/numbers';
import type { Chapter } from './types';

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
        The NAND's four truth-table rows collapse to the two where its inputs agree: a = 0 gives 1, a = 1 gives 0. One NAND makes an
        inverter.</p>
        <p>Every gate in this chapter is drawn with its usual symbol, but inside it is only NANDs. Double-click it to check.
        NOT costs ${nd(NOT)} NAND, ${tr(NOT)} transistors and ${logicDepth(NOT)} gate delay.</p>
        <p>Why build everything from NAND? It is <em>universal</em>: any truth table can be made from NANDs alone, as the rest of
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
        pitfall: `<p>Forgetting the inverters: a plain NAND of a and b agrees with OR only on the two mixed rows. It gives 1 at a = b = 0 and 0 at a = b = 1, the opposite of OR, where
          NAND gives 1 and OR gives 0. Truth tables are checked on every row for exactly this reason.</p>`,
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
        (1 + 1 = 0, carry 1) and of comparison: the sum bit of a column is a XOR b, and a XOR b is 0 exactly when two bits agree.</p>
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
          a·¬b + ¬a·b, which is a ⊕ b. Sharing m saves the two inverters a direct sum of products would use: ${nd(XOR)} NANDs against 5.</p>`,
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
        the results together, and you have an equality comparator (the processor's <code>beq</code>
        instruction will need one).</p>
        <p>The price of that comparator grows with the width: for 32 bits, 32 XNORs and a tree that ANDs 32 results, ${nd(equal(32))} NANDs in all and
        ${logicDepth(equal(32))} delays deep. The tree is why equality is cheap compared with <em>magnitude</em> comparison, which needs to know which bit decides.</p>`,
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
        real: `<p>Library mux cells are not four NANDs: a transmission-gate mux is two pass gates and an inverter, about 8 transistors against ${tr(MUX2)}
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
        digit is worth ten times the one to its right; in <strong>binary</strong>, twice: 1, 2, 4, 8, 16… A digit string is read the
        same way in every base: multiply each digit by its place value and add. Base 2 is the one hardware speaks, because a wire has two states.</p>
        <p>The width of the bus sets the range: n wires carry 2ⁿ different patterns, 0 to 2ⁿ − 1 read as an unsigned number. Eight wires give
        ${2 ** 8}, sixteen ${(2 ** 16).toLocaleString('en-US')}, thirty-two ${(2 ** 32).toLocaleString('en-US')}. Every width in a processor (a register, an
        address, an ALU) is a decision about where that range ends, and what happens past it: the number wraps around.</p>
        <p>Long binary numbers are hard to read, so we write them in <strong>hexadecimal</strong>, one digit (0–9,
        A–F) for every four bits. <code>0b1010_1111</code> is <code>0xAF</code> is ${parseInt('10101111', 2)}. The grouping costs nothing in hardware:
        a hex digit is four wires read together.</p>
        <div class="try">Flip the bits. Try making 255, then add 1.</div>`,
      widget: () => numberWidget(8, false),
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
        pitfall: `<p>The most negative number has no positive partner: in 8 bits, −128 inverted and incremented is −128 again, so its absolute value stays negative. Also,
          sign-extending a number to a wider register copies the top bit, while zero-extending turns −1 (0xFF) into 255.</p>`,
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
  ],
};
