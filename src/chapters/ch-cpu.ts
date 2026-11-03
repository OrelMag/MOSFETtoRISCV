import { groupDigits } from '../sim/numfmt';
import { alu, addSub, bitwise, regfile, shifter } from '../lib';
import { cpuState } from '../riscv/cosim';
import { PROGRAMS } from '../riscv/programs';
import { logicDepth, stats } from '../sim/stats';
import { netlistOf } from '../sim/types';
import { pack } from '../sim/values';
import { cpuScene } from '../widgets/cpupanel';
import { memGridPanel } from '../widgets/memgrid';
import { OWN_COST, ownInstrScene, ownInstrSolved, solveOwnInstr } from '../widgets/owninstr';
import { assemblerWorkspace, fetchLoop, instructionExplorer } from '../widgets/riscv';
import type { Stage } from '../view/stage';
import type { Chapter } from './types';
import { aluSteps, BRANCH_WRONG, CTL_PARTS } from './alu/steps';
import { RF_NUMBERS, rfSteps } from './rf/steps';

const { control: CONTROL_NANDS, and5: AND5_NANDS, lwx: LWX_NANDS } = OWN_COST;
const src = (id: string) => PROGRAMS.find((p) => p.id === id)!.source;
const fmt = groupDigits;

/** The 32 × 32 register file's NANDs by part: registers w1…w31, read ports rp1 / rp2, the rest (decoder). */
const RF_COST = (() => {
  const rf = regfile(5, 32);
  let regs = 0, ports = 0, rest = 0;
  for (const i of netlistOf(rf)!.instances) {
    const n = stats(i.def).nands;
    if (/^w\d+$/.test(i.name)) regs += n;
    else if (/^rp\d$/.test(i.name)) ports += n;
    else rest += n;
  }
  return { regs, port: ports / 2, dec: rest, total: stats(rf).nands, perBit: regs / (31 * 32) };
})();

/** Bitwise operations at 32 bits: NANDs a bit and depth, read from the circuit. */
const BW = Object.fromEntries((['and', 'or', 'xor'] as const).map((op) => [op, { per: stats(bitwise(op, 32)).nands / 32, depth: logicDepth(bitwise(op, 32)) ?? 0 }]));
/** The 32-bit ALU and its two big parts. */
const A32 = { nands: stats(alu(32)).nands, depth: logicDepth(alu(32)) ?? 0, add: stats(addSub(32)).nands, addDepth: logicDepth(addSub(32)) ?? 0, sh: stats(shifter(32)).nands, shDepth: logicDepth(shifter(32)) ?? 0 };

function reg(st: Stage, i: number): number {
  const n = st.rootCtx?.node.children?.get(`w${i}`);
  return n ? pack(st.rootCtx!.sim.getBits(n.ports.q)) : -1;
}

export const chAlu: Chapter = {
  id: 'alu', num: 11, title: 'The ALU', level: 'Computing',
  blurb: 'Every RV32I integer operation in one block, selected by the instruction\'s own bits.',
  goals: [
    'say why bitwise operations cost n gates and constant depth at any width',
    'build a barrel shifter from log₂ n mux stages, with one right-shifter serving all three shifts',
    'read signed and unsigned less-than from one subtraction (N ⊕ V, ¬C)',
    'say where the ALU control comes from: {funct7[5], funct3} for an R-type, a few gates for <span data-ahead="immediates">immediates (constants stored inside the instruction word)</span>, addresses and branches',
    'read all six branch conditions off one subtraction, and say which operations of the ALU wait for the carry chain and which do not',
  ],
  builds: ['adders', 'routing'],
  recap: {
    keep: [
      'Bitwise AND / OR / XOR: n independent gates, 2–3 NAND delays at any width. <code>not</code> is <code>xori rd, rs, -1</code>.',
      'Barrel shifter: log₂ n stages of 2:1 muxes, stage j shifting by 2<sup>j</sup> (the shift itself is wiring). Left = reverse, shift right, reverse back; an arithmetic shift fills with <code>arith ∧ a[n−1]</code>. 32 bits: 901 NANDs, 16 delays deep.',
      'No comparator: a − b gives Z (equal), N ⊕ V (signed less-than: N alone lies on overflow) and ¬C (unsigned less-than: no carry out of a + ¬b + 1).',
      'Every unit computes every cycle and an 8:1 mux on ctl[2:0] picks the result; ctl[3] selects SUB over ADD and SRA over SRL; SLT and SLTU force subtraction.',
      'The codes match R-type encodings: there <code>ctl = {funct7[5], funct3}</code>, plain wiring. Elsewhere a few gates decide: OP-IMM passes bit 30 (imm[10]) only for <code>srai</code>, loads / stores / <code>jalr</code> / <code>auipc</code> force ADD, branches force SUB.',
      `Branches: beq Z, bne ¬Z, blt N ⊕ V, bge ¬(N ⊕ V), bltu ¬C, bgeu C, from the same subtraction (${BRANCH_WRONG.nAlone.toLocaleString('en')} of 65 536 8-bit pairs would be wrong on N alone). The ALU control: ctl[2:0] = aluOp ? funct3 : 0, ctl[3] = aluOp · f7[5] · (R ∨ funct3 = 101) ∨ BRANCH (${CTL_PARTS} NANDs).`,
      'Held at one control code the result settles in 8 delays for and / or, 20 for a shift, 73 for add and 81 for slt (ripple adder, measured: tests/deepseq.test.ts); with a log-depth adder add is 23 and the shifter is unchanged.',
      'At 32 bits: 2610 NANDs, 98 NAND delays deep. The ripple adder sets the depth, the shifter and the result mux take most of the area.',
    ],
    practise: ['a_addsub16', 'a_slt', 'a_shift16', 'a_alu16'],
    check: [
      {
        question: '8-bit a = 0x7F (127), b = 0x80 (−128). The ALU computes a − b = 0xFF. Is a &lt; b, signed?',
        options: ['No: N ⊕ V = 0, because the subtraction overflowed', 'Yes: N = 1', 'Yes: there is no carry out', 'The flags cannot tell; a comparator is needed'],
        answer: 0,
        explain: '127 − (−128) = 255 does not fit in 8 signed bits. The result 0xFF reads as −1 (N = 1), but V = 1, so N ⊕ V = 0: a ≥ b, which is right.',
        why: ['', 'N alone is the sign of a wrapped result. Here the subtraction overflowed, so the sign bit lies.', 'No carry out answers the unsigned question: 0x7F &lt; 0x80 unsigned is true, but the signed answer is the opposite.', 'The adder\'s flags hold both answers. That is why the ALU contains no comparator.'],
      },
      {
        question: 'How many mux stages does the shift itself need in a 64-bit barrel shifter?',
        options: ['6', '64', '32', '5'],
        answer: 0,
        explain: 'The shift amount has log₂ 64 = 6 bits; stage j shifts by 2<sup>j</sup> or passes through. 6 rows of 64 MUX2, plus the reversal rows for left shifts.',
        why: ['', 'That is one stage per possible shift amount. Decomposing the amount in binary needs one stage per bit of it.', 'Stage count follows the bits of the shift amount, not half the width.', 'Five stages reach shifts up to 31: enough for RV32, not for 64-bit words.'],
      },
      {
        question: '<code>srl</code> and <code>sra</code> share funct3 = 101. What tells the ALU which one to do?',
        options: ['funct7[5] (instruction bit 30), passed on as ctl[3]', 'The opcode', 'A decoder reading all seven funct7 bits', 'The sign of rs2'],
        answer: 0,
        explain: 'For an R-type ctl = {funct7[5], funct3}: 0101 is SRL, 1101 SRA, and the same bit picks SUB (1000) over ADD (0000). For OP-IMM a few gates pass bit 30 only when funct3 = 101 (srli / srai): in addi or andi that bit is imm[10], and <code>addi a0, a0, -1</code> would otherwise subtract.',
        why: ['', 'Both are R-type (or both OP-IMM, the forms that carry a constant): the opcode says where the operand comes from, not which shift.', 'Only bit 5 of funct7 differs between them: one gate passes it on, no wider decoder.', 'rs2 gives the shift amount. The fill bit comes from a, and only when ctl says arithmetic.'],
      },
    ],
  },
  steps: [
    {
      title: 'Bitwise operations are free parallelism',
      body: `
        <p>Most RISC-V instructions do one thing to two 32-bit words: add or subtract them, AND, OR or XOR them, shift one by the other, or compare them.
        That is ten operations (add, sub, sll, slt, sltu, xor, srl, sra, or, and), and the <strong>ALU</strong> (arithmetic logic unit) is one block that does all ten,
        picking the one an instruction asks for with a 4-bit control code. An instruction is a 32-bit word (<a href="#/c/isa/0">chapter 13</a> lays out its formats);
        in the register-to-register ones, called R-type, two small fields of that word, funct3 (3 bits) and one bit of funct7, name the operation, and the ALU's
        code is chosen to be exactly those four bits. Most operations also come in an <span data-ahead="immediates">immediate form, whose second operand is a constant written into the instruction word</span>
        (<code>addi</code>, <code>andi</code>, <code>slli</code> …).</p>
        <p>The units are built from parts you have: chapter 6's adder for add, sub and the comparisons, chapter 7's multiplexers for the shifter and for picking
        the result. First the cheapest of them.</p>
        <p>AND, OR and XOR on words are just <span data-show="g0 g1 g2 g3 g4 g5 g6 g7">n independent gates</span>: no carries, no interaction between bit positions,
        depth 2–3 NANDs regardless of width. They cost O(n) area and O(1) delay.</p>
        <p>In RISC-V they implement masking (<code>andi</code>), setting bits (<code>ori</code>), toggling and comparing
        (<code>xor</code>), and <code>not</code> as <code>xori rd, rs, -1</code>.</p>
        <p>The reason is structural: output bit <em>i</em> is a function of a<sub>i</sub> and b<sub>i</sub> alone, so no signal
        crosses from one bit position to another. Widening the word adds copies of the same cell and no delay. At 32 bits an
        AND costs ${BW.and.per} NANDs a bit (a NAND and an inverter), an OR ${BW.or.per} (an inverter on each input, then a NAND) and an XOR
        ${BW.xor.per}, at depths ${BW.and.depth}, ${BW.or.depth} and ${BW.xor.depth}. It is the cheapest block in the ALU, and the one
        whose 32-bit cost is exactly 32 times the 1-bit cost.</p>`,
      scene: () => ({ root: bitwise('xor', 8), inputs: { a: 0b1100_1010, b: 0b1010_0110 } }),
      tour: {
        beats: [
          { title: 'Where they differ', show: ['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7'], expect: { y: 0x6c },
            say: '<p>0xCA ⊕ 0xA6 = <code>{b:y}</code>: a 1 in every position where the inputs differ. Each of the eight gates saw only its own two input bits.</p>' },
          { title: 'Flip everything', set: { b: 0xff }, expect: { y: 0x35 },
            say: '<p>With b all ones every gate inverts its a bit: y = ¬a = <code>{b:y}</code>. That is RISC-V\'s <code>not</code>: <code>xori rd, rs, -1</code>, with -1 written as 32 ones.</p>' },
          { title: 'Leave alone', set: { b: 0 }, expect: { y: 0xca },
            say: '<p>With b = 0 each bit passes through unchanged: y = a. In general b is a mask of the bits to toggle.</p>' },
        ],
      },
      more: {
        derive: `<p>Cost at 32 bits, from the circuit: AND ${BW.and.per * 32} NANDs, OR ${BW.or.per * 32}, XOR ${BW.xor.per * 32}; a 32-bit ALU's bitwise unit is the three together, ${(BW.and.per + BW.or.per + BW.xor.per) * 32}
          NANDs, against ${fmt(A32.nands)} for the whole ALU. Depth does not depend on the width: a 64-bit unit is the same ${BW.xor.depth} delays deep and twice the area.</p>`,
        pitfall: `<p>The logical immediates are sign-extended like every I-type immediate. <code>andi a0, a0, 0x7F0</code> masks with 0x000007F0, but 0x800 does not
          fit in 12 signed bits (it would read as -2048), and writing <code>andi a0, a0, -16</code> masks with 0xFFFFFFF0. A mask wider than 11 bits needs <code>lui</code> first.</p>`,
        real: `<p>In a datapath the logic unit is laid out as a bit-slice: 32 or 64 identical cells in a column of wires, so the regularity that makes it cheap
          here also makes it easy to lay out. SIMD units reuse the same idea: a 256-bit AND is just more slices.</p>`,
      },
    },
    {
      title: 'The barrel shifter',
      body: `
        <p>Shifting by a variable amount <em>s</em> in one cycle: decompose <em>s</em> in binary and build log₂(n)
        <span data-show="m0 m1 m2">stages</span>, stage <em>j</em> shifting by 2<sup>j</sup> or passing through. The
        "shift by 2<sup>j</sup>" itself is <span data-show="w0 w1 w2">pure wiring</span>; each stage is a row of 2:1 muxes.
        A 32-bit shifter is 5 stages, 160 MUX2.</p>
        <p>Two tricks keep it to one right-shifter: a left shift is a right shift of the
        <span data-show="rin mr rout mo">bit-reversed word, reversed back</span>, and an arithmetic right shift fills the
        vacated bits with the sign bit instead of 0 (<span data-show="f1 f2"><code>fill = arith ∧ a[n−1]</code></span>).</p>
        <p>Why log₂ n stages and not n: a shift by <em>s</em> is the composition of shifts by 2<sup>j</sup> for each set bit
        <em>j</em> of <em>s</em>, and shifts commute, so the stages can be chained in any order and each is either the identity or
        one fixed permutation of the wires. A shifter that moved one bit per stage would be 31 stages deep. The whole 32-bit unit,
        both reversal rows and the fill logic included, is ${fmt(A32.sh)} NANDs and ${A32.shDepth} delays: about a third of the ALU's area and a sixth of its
        depth.</p>
        <div class="try">Set a = 0x96, sh = 3 and toggle <code>left</code> and <code>arith</code>. Open a stage to see the wiring box and the muxes.</div>`,
      scene: () => ({ root: shifter(8), inputs: { a: 0x96, sh: 3, left: 0, arith: 1 } }),
      tour: {
        beats: [
          { title: 'Arithmetic right', show: ['m0', 'm1', 'm2'], expect: { y: 0xf2 },
            say: '<p>sh = 3 = 2 + 1: the by-1 and by-2 stages are on, the by-4 stage passes through. 0x96 shifted right by 3 with the sign copied in is <code>{b:y}</code>.</p>' },
          { title: 'Logical right', set: { arith: 0 }, show: ['f1', 'f2'], expect: { y: 0x12 },
            say: '<p>With arith = 0 the fill bit is 0 instead of a[7]: y = <code>{b:y}</code>. Only the fill logic changed; the muxes did the same work.</p>' },
          { title: 'Left, by reversal', set: { left: 1 }, show: ['rin', 'mr', 'rout', 'mo'], expect: { y: 0xb0 },
            say: '<p>left = 1 reverses the input, shifts right, and reverses back: y = <code>{b:y}</code>, which is 0x96 &lt;&lt; 3 kept to 8 bits. The reversals are wires and a row of muxes, not a second shifter.</p>' },
          { title: 'Shift by zero', set: { sh: 0 }, show: ['m0', 'm1', 'm2'], expect: { y: 0x96 },
            say: '<p>sh = 0 turns every stage off: y = a = <code>{b:y}</code> in either direction.</p>' },
        ],
      },
      more: {
        derive: `<p>Stage <em>j</em> is a row of n 2:1 muxes whose second input is the word moved by 2<sup>j</sup> with the fill bit shifted in. For sh = 3 the data takes the shifted input at
          stages 0 and 1 and the straight one at stage 2: 0x96 → by 1 → by 2 → 0x12 (logical). The fill for an arithmetic shift is arith ∧ a[n−1], computed once and used by every stage,
          so a negative number gets ones, not zeros, in all the vacated places. Mux count: n·log₂ n, plus two rows of n for the reversal.</p>`,
        numbers: `<table class="mini"><tr><th>width</th><th>stages</th><th>NANDs</th><th>depth</th></tr>${[8, 16, 32, 64].map((n) => `<tr><td>${n}</td><td>${Math.log2(n)}</td><td>${fmt(stats(shifter(n)).nands)}</td><td>${logicDepth(shifter(n))}</td></tr>`).join('')}</table>
          <p>Depth grows by two with each doubling of the width (one more mux stage); area a little more than doubles each time.</p>`,
        pitfall: `<p>The shift amount is only the low log₂ n bits of rs2: in RV32I <code>sll</code> by 32 is a shift by 0, not zero. A compiler that wants "shift out everything" must test
          the amount first. The ALU shifter does not saturate, which is also why <code>sra</code> by a large amount never needs a special case.</p>`,
        real: `<p>Cores use this structure, often with a funnel shifter (a 2n-bit input, n bits out) that serves rotates and both directions in the same
          log-depth rows. In a fast core the shifter is its own unit beside the adder and its result is picked by the output mux, exactly as the next steps show.</p>`,
      },
      tries: [(st) => st.getInput('left') === 1 || st.getInput('arith') === 0],
    },
    {
      title: 'Comparison is subtraction',
      body: `
        <p>The ALU never contains a comparator. To evaluate a &lt; b it computes a − b
        (<span data-show="x0 x1 x2 x3 x4 x5 x6 x7">b inverted</span>, carry-in 1, through the
        <span data-show="fa0 fa1 fa2 fa3 fa4 fa5 fa6 fa7">full adders</span>) and reads flags from the adder:</p>
        <ul><li><strong>Z</strong>: result is zero ⇒ a = b (beq/bne)</li>
        <li><strong><span data-show="pin:n">N</span> ⊕ <span data-show="vx">V</span></strong>: the true sign of a − b ⇒ a &lt; b signed (slt, blt). N alone is wrong when the subtraction overflows.</li>
        <li><strong>¬<span data-show="pin:cout">C</span></strong>: no carry out of a + ¬b + 1 ⇒ a &lt; b unsigned (sltu, bltu)</li></ul>
        <p>Why this is nearly free: the flags are by-products of the subtraction the ALU does anyway. N is the top sum bit (a wire), C
        the adder's carry out (a wire), V one XOR of the carries into and out of the top bit, and Z a 32-input NOR over the result.
        Signed and unsigned order differ only in how they read the same 32 bits, so the same subtraction answers both and the
        instruction picks the flag combination: <code>blt</code> N ⊕ V, <code>bltu</code> ¬C. The cost of a comparison is
        the adder's, ${A32.add} NANDs and ${A32.addDepth} delays for a 32-bit ripple adder-subtractor, and nothing more.</p>
        <div class="try">Try a = 0x80 (−128), b = 0x01, sub = 1: the result 0x7F looks positive (N = 0) but V = 1, so N ⊕ V = 1: −128 &lt; 1. Correct.</div>`,
      scene: () => ({ root: addSub(8), inputs: { a: 0x80, b: 0x01, sub: 1 } }),
      tour: {
        beats: [
          { title: 'Overflow', show: ['x0', 'x1', 'x2', 'x3', 'x4', 'x5', 'x6', 'x7'], expect: { s: 0x7f, cout: 1, v: 1, n: 0 },
            say: '<p>0x80 − 1: b is inverted and the carry-in is 1. The result is {v:s} (<code>{b:s}</code>), which reads as positive: N = {v:n}. But −128 − 1 does not fit in 8 bits: V = {v:v}, and N ⊕ V = 1 says a &lt; b, correctly.</p>' },
          { title: 'Plain negative', set: { a: 5, b: 9 }, expect: { s: 0xfc, cout: 0, v: 0, n: 1 },
            say: '<p>5 − 9 = −4 = 0xFC. No overflow, so N = {v:n} is honest: signed a &lt; b. No carry out ({v:cout}): 5 + ¬9 + 1 fell short of 2⁸, so unsigned a &lt; b too.</p>' },
          { title: 'Signed and unsigned disagree', set: { a: 0xff, b: 1 }, expect: { s: 0xfe, cout: 1, v: 0, n: 1 },
            say: '<p>0xFF is −1 signed and 255 unsigned. The difference is {v:s}; N ⊕ V = 1 (−1 &lt; 1) but the carry out is {v:cout} (255 ≥ 1). One subtraction, two answers: <code>slt</code> reads N ⊕ V, <code>sltu</code> reads ¬C.</p>' },
          { title: 'The same adder adds', set: { sub: 0 }, expect: { s: 0, cout: 1, v: 0, n: 0 },
            say: '<p>With sub = 0, b is not inverted and the carry-in is 0: 0xFF + 1 = 0 with a carry out. The carry out that meant "no borrow" in a subtraction means "wrapped" here.</p>' },
        ],
      },
      more: {
        derive: `<p>With b inverted and carry-in 1 the adder computes a + (2ⁿ − 1 − b) + 1 = a − b + 2ⁿ. That reaches 2ⁿ, a carry out, exactly when a ≥ b: so C = 1 means a ≥ b unsigned and ¬C means
          a &lt; b. For the signed case the true difference lies in −2ⁿ + 1 … 2ⁿ − 1, and the n-bit result wraps when the operands have different signs and the result's sign differs from a's. That is V. When V = 0 the sign
          bit N is the sign of a − b; when V = 1 it is inverted; so the sign of the true difference is N ⊕ V.</p>`,
        pitfall: `<p>Reading N alone for a signed compare works until the operands are far apart: 0x7F − 0x80 and 0x80 − 0x01 both overflow. A comparison that "works on small numbers" and fails on
          values near ±2<sup>31</sup> is this bug. On the circuit: set a = 0x80, b = 1 and watch n and v disagree.</p>`,
        real: `<p>Cores with a flags register (x86, ARM) keep N, Z, C, V from every arithmetic instruction and branch on them later. RISC-V has no flags register: the branch itself performs the
          comparison, which avoids a hidden state that every instruction must update and every pipeline must track.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'For unsigned a < b, the ALU computes a + NOT b + 1 and looks at…',
        options: ['the sign bit of the result', 'carry out = 0', 'overflow = 1', 'zero = 0'], answer: 1,
        why: ['The sign bit answers a signed question, and even then only when the subtraction does not overflow.', '', 'Overflow is a signed notion: it flags a result that does not fit in two\'s complement.', 'zero = 0 only says a ≠ b; it cannot tell which one is smaller.'],
        explain: 'a + (2ⁿ − 1 − b) + 1 = a − b + 2ⁿ. That reaches 2ⁿ (carry out = 1) exactly when a ≥ b. No carry means a < b. That is why bltu/sltu use ¬C.',
      },
    },
    {
      title: 'The complete ALU',
      body: `
        <p>All units (<span data-show="add">adder</span>, <span data-show="shift">shifter</span>,
        <span data-show="slt sltu">set-less-than</span>, <span data-show="xor or and">bitwise</span>) compute in parallel on
        every cycle; an <span data-show="mux">8:1 multiplexer</span> driven by ctl[2:0] picks the result.
        ctl[3] selects SUB over ADD and SRA over SRL; SLT and SLTU also force subtraction.</p>
        <p>The codes are chosen to match R-type encodings: for <code>add</code> … <code>and</code>,
        <code>ctl = {funct7[5], funct3}</code>, plain wiring. Other instructions need a few gates in
        <a href="#/c/cpu/0">chapter 14</a>'s control logic. OP-IMM has no funct7: bit 30 is imm[10], so it passes as ctl[3]
        only for the shifts (funct3 = 101: <code>srai</code>); else <code>addi a0, a0, -1</code> would subtract. Loads, stores,
        <code>jalr</code> and <code>auipc</code> force ADD (an address; their funct3 is a width or nothing), branches force SUB
        and read the flags. With op = R ∨ OP-IMM: ctl[2:0] = op ∧ funct3, ctl[3] = op ∧ funct7[5] ∧ (R ∨ funct3 = 101) ∨ branch.</p>
        <p>Note the cost structure in the Info tab: the shifter and mux trees dominate area; the ripple adder dominates delay.
        That is why <a href="#/c/fastadd/0">a later chapter</a> replaces it with a parallel-prefix adder.</p>
        <p>At 32 bits the ALU is ${fmt(A32.nands)} NANDs and ${A32.depth} delays deep. The adder-subtractor alone is ${A32.add} NANDs but ${A32.addDepth} of those delays, the shifter
        ${fmt(A32.sh)} NANDs but only ${A32.shDepth}: the units run in parallel, so the slowest sets the depth, and the multiplexer that picks among them is paid on every
        operation. Computing everything and selecting wastes energy but not time, and a mux is cheaper than steering the operands.</p>
        <div class="note">ctl: 0000 ADD · 1000 SUB · 0001 SLL · 0010 SLT · 0011 SLTU · 0100 XOR · 0101 SRL · 1101 SRA · 0110 OR · 0111 AND</div>`,
      scene: () => ({ root: alu(8), inputs: { a: 0x80, b: 3, ctl: 0b0101 } }),
      tour: {
        beats: [
          { title: 'Logical right', show: ['shift', 'mux'], expect: { y: 0x10 },
            say: '<p>ctl = 0101 is SRL: 0x80 &gt;&gt; 3 = {v:y}. Every unit computed something; the multiplexer passed the shifter\'s result.</p>' },
          { title: 'Arithmetic right', set: { ctl: 0b1101 }, show: ['shift', 'mux'], expect: { y: 0xf0 },
            say: '<p>ctl[3] = 1 selects SRA: the sign bit is copied into the vacated positions, so y = <code>{b:y}</code>. Same shifter, one more bit of control.</p>' },
          { title: 'Subtract', set: { ctl: 0b1000 }, show: ['add', 'mux'], expect: { y: 0x7d, neg: 0 },
            say: '<p>ctl = 1000 is SUB: 0x80 − 3 = {v:y}. The adder-subtractor is the unit now selected; neg = {v:neg}, because the wrapped result is positive.</p>' },
          { title: 'Set less than', set: { ctl: 0b0010 }, show: ['slt', 'sltu', 'mux'], expect: { y: 1 },
            say: '<p>SLT: −128 &lt; 3 signed, so y = {v:y}. The result is one bit wide; the mux pads it with zeros.</p>' },
          { title: '...and unsigned', set: { ctl: 0b0011 }, show: ['slt', 'sltu', 'mux'], expect: { y: 0 },
            say: '<p>SLTU on the same operands: 128 &lt; 3 is false, so y = {v:y}. The two differ only in which flag is read.</p>' },
        ],
      },
      more: {
        derive: `<p>The path through the ALU is the longest unit plus what follows it: the adder-subtractor's ${A32.addDepth} delays, then the flag logic that SLT and SLTU need and the 8:1 select,
          ${A32.depth} in all. The remaining ${A32.depth - A32.addDepth} delays are that tail, the shifter's ${A32.shDepth} and the logic unit's ${BW.xor.depth} are far behind. That is why replacing the ripple adder
          is the next chapter's first move.</p>`,
        pitfall: `<p>Decoding ctl from funct3 alone is the classic bug: <code>add</code> and <code>sub</code> share funct3 = 000 and differ only in funct7[5]; <code>srl</code> and
          <code>sra</code> likewise. In the OP-IMM form the same bit is part of the immediate, so passing it blindly turns <code>addi a0, a0, -1</code> into a subtraction. Try ctl = 1000 and 0000 above.</p>`,
        real: `<p>Wide cores replicate this: several ALUs, a separate shifter and a multiplier with its own pipeline, selected per issue slot. The flags are still the adder's; real designs
          also speed up the "zero" result for branches by computing equality directly instead of waiting for the subtraction.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Make the ALU compute 0x80 shifted right arithmetically by 3 (result 0xF0).',
        check: (st) => st.getInput('ctl') === 0b1101 && st.getInput('a') === 0x80 && st.getInput('b') === 3 && st.value('y') === 0xf0,
        hints: [
          'The note under the text lists every control code. Which operation fills the vacated bits from the sign?',
          'ctl[3] = 1 turns a logical right shift (0101) into an arithmetic one; b is the shift amount.',
        ],
        answer: 'a = 0x80, b = 3, ctl = 0b1101 (SRA). The sign bit (1) is copied into the three vacated positions: 1111_0000.',
        solve: (st) => st.setInputs({ a: 0x80, b: 3, ctl: 0b1101 }),
      },
    },
    ...aluSteps,
  ],
};

export const chRegfile: Chapter = {
  id: 'regfile', num: 12, title: 'The register file', level: 'Computing',
  blurb: '32 registers, two read ports, one write port, and x0 wired to zero.',
  goals: [
    'say why an R-type instruction needs two read ports and one write port, and what each port costs',
    'explain how a constant x0 gives li, nop, j, beqz, neg and ret for free',
    'price the 32 × 32 register file in NANDs against the rest of the CPU',
    'give a read of the register being written the new value, say what a file of latches saves and what it risks, and say who wins when two write ports name one register',
  ],
  builds: ['registers', 'memory'],
  recap: {
    keep: [
      'Two asynchronous read ports and one synchronous write port: two operands in, one result out, every cycle.',
      'Structure: a write decoder, one register with enable per word, every word bundled onto one bus, and a mux tree per read port.',
      'x0 has no flip-flops: its slot is a constant 0 and writes to it go nowhere. <code>li</code> (addi rd, x0, imm), <code>nop</code>, <code>j</code> (jal x0), <code>beqz</code>, <code>neg</code> (sub rd, x0, rs) and <code>ret</code> (jalr x0, 0(ra)) are pseudo-instructions built on it; <code>mv</code> is addi rd, rs, 0 and needs none.',
      `RISC-V: 31 × 32 flip-flops, a 5→32 decoder, two 32:1 trees of 32-bit words: ${fmt(RF_COST.total)} NANDs, nearly half of the whole CPU of chapter 14 (about 48 000 without its program ROM).`,
      `A bypass (a comparator and a word mux per read port, ${RF_NUMBERS().by - RF_NUMBERS().rf} NANDs for two) returns the incoming write data for a same-cycle read, never for x0. A latch file stores a bit in ${RF_NUMBERS().latch} NANDs against ${RF_NUMBERS().dff}: ${fmt(RF_NUMBERS().lf)} instead of ${fmt(RF_NUMBERS().rf)}, but its data path is transparent for the whole high phase. With two write ports the younger instruction (port 1) wins a shared register.`,
      `Here every read port is a whole mux tree: a third would add ${fmt(RF_COST.port)} NANDs. A custom memory cell adds a port for about two transistors per bit.`,
    ],
    practise: ['m_rf'],
    check: [
      {
        question: 'Why does the register file have two read ports?',
        options: ['An R-type instruction reads rs1 and rs2 in the same cycle', 'One port reads while the other writes', 'One of them serves x0', 'To read 64-bit values'],
        answer: 0,
        explain: '<code>add rd, rs1, rs2</code> needs both operands at once in a machine that finishes one instruction per cycle. One port would take two cycles; one result per instruction needs only one write port.',
        why: ['', 'Writes have their own synchronous port; both read ports only read.', 'x0 needs no port: it is a constant on the bundled bus, selected like any other word.', 'RISC-V registers are 32 bits, and each port returns one register.'],
      },
      {
        question: '<code>addi x0, x5, 1</code> executes. What happens?',
        options: ['Nothing visible: the write to x0 goes nowhere', 'x0 holds x5 + 1 until the next write', 'The processor stops with an error', 'x5 is incremented'],
        answer: 0,
        explain: 'x0 has no storage, so the result is lost and x0 still reads 0. <code>addi x0, x0, 0</code> is the canonical <code>nop</code>.',
        why: ['', 'There is nothing to hold the value: x0\'s slot on the read bus is wired to 0.', 'Writing x0 is legal; RISC-V relies on it for nop and for discarding results (j is jal x0).', 'rd is x0; rs1 = x5 is only read.'],
      },
      {
        question: 'A third read port on this 32 × 32 register file adds about…',
        options: ['4000 NANDs: one more 32:1 tree of 32-bit words', 'two transistors per bit', 'nothing: the bundled bus already reaches every register', 'a second set of 31 registers'],
        answer: 0,
        explain: '31 MUX2 per bit × 32 bits × 4 NANDs = 3968 NANDs. Port count is a first-order cost, which is why wide superscalar cores fight over register-file ports.',
        why: ['', 'That is the price with custom multi-ported memory cells, not with a mux tree built from NANDs.', 'The bus brings every word to the port, but each port still needs its own selector to pick one.', 'Ports share the storage; only the selection logic is duplicated.'],
      },
    ],
  },
  steps: [
    {
      title: 'A memory with two read ports',
      body: `
        <p><a href="#/c/registers/0">Chapter 9</a> kept one word in a register; <a href="#/c/memory/0">chapter 10</a> kept many behind an address. A processor needs
        something in between: a few dozen words that every instruction can name directly, two of them read and one written in the same cycle. RISC-V has 32,
        x0 to x31, and an instruction names them by number: <code>add x5, x6, x7</code> reads x6 and x7 and writes their sum to x5 (<a href="#/c/isa/0">chapter 13</a>
        shows the three 5-bit register numbers in the instruction word). The block that holds them is the <strong>register file</strong>: a small memory with more than one port.</p>
        <p>Such an instruction needs two operands and produces one result per cycle, so the register file has
        <strong>two asynchronous <span data-show="rp1 rp2">read ports</span></strong> and <strong>one synchronous write
        port</strong> (<span data-show="dec">a decoder</span> enabling one register). Structurally it is the
        memory array from <a href="#/c/memory/0">chapter 10</a> with a second mux tree.</p>
        <p>All register outputs are bundled into <span data-show="bundle">one wide bus</span> feeding both read ports; that is the usual way to draw
        "every word reaches every port". Register <span data-show="x0">x0</span> does not exist: its slot is a constant 0, and writes to it go nowhere.
        That gives <code>li</code>, <code>nop</code>, <code>j</code>, <code>beqz</code>, <code>neg</code> and <code>ret</code> for free as pseudo-instructions, each an ordinary instruction with x0 as a source or destination.</p>
        <p>A machine that finishes one instruction per cycle does both reads and the write in one clock. Reads are combinational: the address goes into a mux tree and the word comes out after its delay, with no clock involved.
        A write must change state, so it happens only at the rising edge and only where the decoder and <code>we</code> enable one register. Reading a register while writing it gives the old
        value until the edge, which is what such a machine wants: the instruction reads its operands first and the result lands at the end of the cycle.</p>
        <div class="try">Write a value: set wa, wd, we = 1, Pulse. Then point ra1 / ra2 at it.</div>`,
      scene: () => ({ root: regfile(3, 8), inputs: { wa: 5, wd: 0x42, we: 1, clk: 0, ra1: 5, ra2: 0 }, panels: [memGridPanel] }),
      tour: {
        beats: [
          { title: 'Before the write', reset: true, show: ['dec', 'rp1'], expect: { rd1: 0, rd2: 0 },
            say: '<p>Register 5 holds nothing yet, and port 1 is already pointed at it (ra1 = 5): rd1 = {v:rd1}. wa = 5, wd = 0x42 and we = 1 are set up, but nothing is stored until a clock edge.</p>' },
          { title: 'The edge', cycles: 1, show: ['dec', 'rp1'], expect: { rd1: 0x42 },
            say: '<p>One rising edge: the decoder enabled register 5 only, and it captured wd. Read port 1 shows {v:rd1} straight away: the read path has no clock.</p>' },
          { title: 'Second port', set: { ra2: 5 }, show: ['rp2'], expect: { rd1: 0x42, rd2: 0x42 },
            say: '<p>Point port 2 at the same register: rd2 = {v:rd2}. The two ports are independent mux trees over the same storage, so any two registers, or the same one twice, can be read in one cycle.</p>' },
          { title: 'Write disabled', set: { we: 0, wd: 0x99 }, cycles: 1, expect: { rd1: 0x42 },
            say: '<p>With we = 0 the edge changes nothing: the decoder enables no register, so wd = 0x99 is ignored and rd1 stays {v:rd1}.</p>' },
          { title: 'Register zero', set: { we: 1, wa: 0, wd: 0x77, ra2: 0 }, cycles: 1, show: ['x0'], expect: { rd2: 0 },
            say: '<p>Writing x0 goes nowhere: it has no flip-flops, and its slot on the read bus is a constant. Port 2, pointed at register 0, still reads {v:rd2}.</p>' },
        ],
      },
      more: {
        derive: `<p>One register of 8 bits is 8 enable flip-flops. The write decoder turns a 3-bit address into one of 8 enables, the bundle puts all 8 words side by side on one bus, and each read port is an 8:1 mux
          per bit, three stages of 2:1 muxes. Scaled to 32 registers of 32 bits the structure is the same and the next step prices it: the storage grows with the number of registers, the ports with
          registers × width × ports.</p>`,
        pitfall: `<p>An instruction that reads a register another instruction is writing in the same cycle sees the old value. That is correct here and a bug in a pipeline, where the writer is three stages
          past the reader: the pipelined chapter adds a bypass for exactly this case. If a value "does not arrive" in the register file, check whether the write has happened at an edge yet.</p>`,
        real: `<p>Real register files are SRAM-like arrays with the read ports built in, usually written in the first half of the cycle and read in the second so that a write and a read of the same register
          in one cycle can see each other. The mux-tree form here is correct but about as expensive as storage gets.</p>`,
      },
      tries: [(st) => st.getInput('ra2') !== 0 && st.value('rd2') > 0],
      challenge: {
        kind: 'reach', goal: 'Store 0x42 in register 5 and read it on read port 2 (rd2 = 0x42).',
        check: (st) => reg(st, 5) === 0x42 && st.getInput('ra2') === 5 && st.value('rd2') === 0x42,
        hints: [
          'A write needs an address, data and the enable, and happens only at a rising clock edge.',
          'A read port needs no clock: it shows whichever register its address selects, at once.',
        ],
        answer: 'wa = 5, wd = 0x42, we = 1, Pulse; then ra2 = 5.',
        solve: (st) => { st.setInputs({ wa: 5, wd: 0x42, we: 1 }); st.pulse(); st.setInputs({ ra2: 5 }); },
      },
    },
    {
      title: 'The real thing: 32 × 32',
      body: `
        <p>RISC-V's register file: <span data-show="w1 w2 w3 w31">31 × 32 flip-flops</span> with enable, a
        <span data-show="dec">5→32 write decoder</span> and two <span data-show="rp1 rp2">32:1 multiplexer trees</span> of
        32-bit words. At this site's construction that is ${fmt(RF_COST.regs)} NANDs of registers (${RF_COST.perBit} per bit: a flip-flop with enable), ${fmt(RF_COST.port)} per read port and ${fmt(RF_COST.dec)} for the decoder: ${fmt(RF_COST.total)} NANDs, nearly half of the whole CPU.</p>
        <p>Real designs use custom multi-ported memory cells: an extra read port costs two transistors per bit, not a whole
        mux tree. Register-file port count is a first-order cost in superscalar cores for exactly this reason.</p>
        <p>The split is worth reading: ${Math.round((100 * RF_COST.regs) / RF_COST.total)} % of the NANDs are the storage itself, ${Math.round((200 * RF_COST.port) / RF_COST.total)} % the two read ports and the decoder under
        ${Math.round((100 * RF_COST.dec) / RF_COST.total)} %. The registers are the part you cannot avoid; the ports are the part that grows with ambition. Doubling the issue width of a core roughly
        doubles the ports and, because each port also fans out to more storage, grows the file much faster than the instruction count it serves.</p>
        <div class="try">Set wa = 10, wd = 0xCAFE, we = 1 and Pulse, then open <code>rp1</code>: each output bit comes from a tree of 31 2:1 muxes, five levels deep.</div>`,
      scene: () => ({ root: regfile(5, 32), inputs: { wa: 10, wd: 0xcafe, we: 1, clk: 0, ra1: 10, ra2: 0 } }),
      more: {
        derive: `<p>Storage: 31 registers × 32 bits × ${RF_COST.perBit} NANDs (a flip-flop with enable) = ${fmt(RF_COST.regs)}. One read port: 31 MUX2 per bit × 32 bits at ${RF_COST.port / (31 * 32)} NANDs = ${fmt(RF_COST.port)}.
          Two ports: ${fmt(2 * RF_COST.port)}. The decoder and the bundling add ${fmt(RF_COST.dec)}. Total ${fmt(RF_COST.total)}.</p>
          <p>A third read port adds ${fmt(RF_COST.port)} more, about ${Math.round((100 * RF_COST.port) / RF_COST.total)} % on top, and no storage. In the single-cycle CPU a third port would serve nothing; in a core that issues
          several instructions per cycle every one of them wants two.</p>`,
        numbers: `<table class="mini"><tr><th>part</th><th>NANDs</th><th>share</th></tr>
          <tr><td>31 registers</td><td>${fmt(RF_COST.regs)}</td><td>${Math.round((100 * RF_COST.regs) / RF_COST.total)} %</td></tr>
          <tr><td>2 read ports</td><td>${fmt(2 * RF_COST.port)}</td><td>${Math.round((200 * RF_COST.port) / RF_COST.total)} %</td></tr>
          <tr><td>decoder, bundle</td><td>${fmt(RF_COST.dec)}</td><td>${Math.round((100 * RF_COST.dec) / RF_COST.total)} %</td></tr></table>`,
        real: `<p>A 6-transistor memory cell stores a bit in six transistors against this design's ${RF_COST.perBit * 4} a bit (${RF_COST.perBit} NANDs of four transistors each). A register-file cell with two read ports and one write port is
          about ten, because each read port adds two transistors (a pass gate and its enable) instead of a whole tree. That is the saving the paragraph above describes: ports in custom cells are cheap, and ports
          in gates are not.</p>`,
        pitfall: `<p>Do not read the register file's NAND count as the cost of "32 registers" in general: it is the cost of this construction. Changing from 2 to 3 read ports or from 32 to 16 registers moves the
          total by tens of percent, and a custom array changes the whole shape of the answer.</p>`,
      },
    },
    ...rfSteps,
  ],
};

export const chIsa: Chapter = {
  id: 'isa', num: 13, title: 'Instructions & assembly', level: 'ISA',
  blurb: 'RV32I encodings, an in-browser assembler, and an instruction-set simulator to run programs on.',
  goals: [
    'follow a program through fetch, decode and execute, one instruction at a time, and say where PC goes next',
    'name the six RV32I formats and say why rs1, rs2 and rd never move',
    'rebuild an immediate from instruction bits (wires, sign copies and ground) and explain why branch offsets count halfwords',
    'assemble a program in two passes and run it on an instruction-set simulator',
  ],
  builds: ['binary', 'alu', 'regfile'],
  recap: {
    keep: [
      'A program is words in memory. The processor repeats one loop: fetch the word at PC, decode its fields, execute (registers in, a register or memory out), then PC ← PC + 4 unless a branch or jump wrote PC. The ISA is the contract saying what each word means.',
      'Every instruction is 32 bits; the opcode (bits 6:0) picks one of six formats: R, I, S, B, U, J.',
      'rs1 (19:15), rs2 (24:20) and rd (11:7) never move, so register reads start in parallel with decoding.',
      'Immediates pay for it: S splits its immediate around rs2, B and J scramble theirs so the sign is always bit 31. Each immediate bit is a wire, a copy of bit 31, or 0: no gates.',
      'Branch and jump offsets count 2-byte units (bit 0 is not stored), so the 16-bit C extension needs no new format.',
      'The assembler works in two passes: labels first (<code>li</code> may grow to <code>lui</code> + <code>addi</code>), then encoding. The instruction-set simulator, written from the specification, is the reference every gate-level CPU is checked against.',
      'Offsets count from the branch or jump\'s own PC. Every I-type immediate is sign-extended, andi / ori / xori / sltiu included. <code>la</code> and <code>call</code> are <code>auipc</code> + addi / jalr: PC-relative, ±2 GiB, with the upper part rounded by + 0x800 like <code>li</code>.',
    ],
    practise: ['i_enc', 'p_add', 'p_loop', 'p_call'],
    check: [
      {
        question: 'In <code>sw a1, 8(a0)</code>, what occupies bits 11:7, where an R-type keeps rd?',
        options: ['imm[4:0]', 'rs2', 'rd', 'funct3'],
        answer: 0,
        explain: 'S format: imm[11:5] in bits 31:25, imm[4:0] in 11:7. Splitting the immediate keeps rs1 and rs2 where every other format has them.',
        why: ['', 'rs2 stays at 24:20 in every format that has one: that is the point of the layout.', 'A store writes no register, so S has no rd; its slot carries the low immediate bits.', 'funct3 stays at 14:12 in every format that has one.'],
      },
      {
        question: 'How does <code>jal ra, 2048</code> store its offset?',
        options: ['As imm[20:1], scrambled: bit 11 of the offset lands in instruction bit 20', 'As 2048 in bits 31:20, like an I-type immediate', 'As 512 words', 'It cannot: jal reaches only ±2 KiB'],
        answer: 0,
        explain: 'J stores imm[20|10:1|11|19:12] in bits 31:12; bit 0 is always 0 and not stored. 2048 sets only imm[11], which sits in instruction bit 20. Range: ±1 MiB.',
        why: ['', 'An I-type immediate is 12 bits signed (−2048 … 2047): 2048 would not even fit, and J has 20 bits to spend.', 'Offsets count halfwords, not words, so that 2-byte compressed instructions can be targets.', 'That is the range of a 12-bit immediate. J\'s 20 bits of halfwords reach ±1 MiB.'],
      },
      {
        question: '<code>li a0, 0x12345</code> assembles to how many words?',
        options: ['Two: lui, then addi', 'One: li is an instruction', 'One addi, since the value is positive', 'Three'],
        answer: 0,
        explain: '<code>lui a0, 0x12</code> sets the upper 20 bits, <code>addi a0, a0, 0x345</code> adds the low 12. addi sign-extends, so when bit 11 of the constant is set lui takes one more: <code>li a0, 0x12845</code> is <code>lui a0, 0x13</code>; <code>addi a0, a0, -1979</code> (0x13000 − 0x7BB). Pass 1 must know the size to place every label after it.',
        why: ['', 'li is a pseudo-instruction: RV32I has no li opcode.', 'addi\'s immediate is 12 bits signed (−2048 … 2047); 0x12345 = 74 565 does not fit.', 'lui supplies 20 bits and addi 12: two instructions cover any 32-bit constant.'],
      },
    ],
  },
  steps: [
    {
      title: 'A program is words in memory',
      body: `
        <p>Every circuit so far computes one fixed thing. A processor computes whatever its <strong>program</strong> says, and a program
        is only numbers: 32-bit words in a memory, one per <strong>instruction</strong>. Each word is a small order: add two registers,
        load a word, jump if equal.</p>
        <p>The state a program can see is three things: the <strong>program counter</strong> (PC, the byte address of the next
        instruction), 32 <strong>registers</strong> x0–x31 of 32 bits (chapter 12's register file; x0 always reads 0), and memory.
        The processor runs one loop forever:</p>
        <ol>
          <li><strong>Fetch</strong>: read the word at PC.</li>
          <li><strong>Decode</strong>: split it into fields: the operation, the registers it names, a constant.</li>
          <li><strong>Execute</strong>: read the source registers, compute (chapter 11's ALU), write the result to a register or to memory.</li>
          <li><strong>Next</strong>: PC ← PC + 4, unless the instruction is a branch or a jump, which writes PC itself.</li>
        </ol>
        <p>The last rule is where loops and decisions come from: a branch compares two registers and, if the condition holds, sends PC
        back (or forward) to another instruction. RV32I's 40-odd instructions fall into three kinds: <strong>compute</strong>
        (<code>add</code>, <code>addi</code>, <code>slt</code>: registers in, a register out), <strong>memory</strong> (<code>lw</code>,
        <code>sw</code>: the only ones that touch memory, which makes RISC-V a <em>load–store</em> architecture) and <strong>control</strong>
        (<code>beq</code>, <code>jal</code>: they change PC).</p>
        <p>The <strong>instruction set</strong> (ISA) is the contract between the two sides: which word means what. Software is written
        against it, and any hardware that honours it runs that software. Chapter 14 builds one in gates that does the whole loop in a
        single clock cycle. The rest of this chapter is the contract itself: how an instruction is packed into 32 bits, and how text
        becomes those words.</p>
        <p>Reading the listing: <code>add a1, a1, a0</code> is a1 ← a1 + a0. Registers go by their ABI names, which say how compiled code
        uses them: <code>zero</code> = x0, <code>a0</code> = x10, <code>a1</code> = x11. <code>bnez a0, loop</code> is <code>bne a0, zero, loop</code>:
        branch while a0 ≠ 0.</p>
        <div class="try">Step through the program: it adds 3 + 2 + 1 into a1 and stores the sum at address 0. Watch PC jump back from
        0x10 to 0x08 twice, then fall through.</div>`,
      widget: () => fetchLoop(FETCH_LOOP, [10, 11]),
      more: {
        numbers: `<p>32 registers take 5 bits to name, so an instruction naming three of them spends 15 of its 32 bits on that. 16
          registers would free 3 bits for constants; 64 would cost 3 more and a bigger, slower register file. A register read is one
          multiplexer tree inside the processor; a memory access in a real machine is anywhere from a few cycles (a cache) to a hundred or
          more (DRAM, chapter 35), which is why compute instructions only ever see registers.</p>`,
        pitfall: `<p>PC counts bytes, not instructions: the next instruction is at PC + 4, and the instruction at index n is at 4n. And
          x0 is not a register you can use: writing it is allowed and discarded, which is what makes <code>addi zero, zero, 0</code> a
          no-op and <code>add a0, a1, zero</code> a move.</p>`,
        real: `<p>Here instructions and data sit in separate memories (chapter 14's CPU has an instruction ROM and a data memory), as in a
          Harvard machine. A PC or a phone keeps both in one memory, as von Neumann's design did, with separate caches in front (chapter 22).
          One memory is what lets a program be loaded as data and then run: chapter 38's computer boots by copying a program from flash into
          RAM and jumping to it.</p>`,
      },
    },
    {
      title: 'Six formats, fixed register fields',
      reading: {
        source: 'RISC-V Unprivileged ISA (current AsciiDoc, riscv-isa-manual)', section: 'RV32I, Base Instruction Formats',
        quote: [
          'All are a fixed 32 bits in length. The base ISA has IALIGN=32, meaning that instructions must be aligned on a four-byte boundary in memory.',
          'The RISC-V ISA keeps the source (rs1 and rs2) and destination (rd) registers at the same position in all formats to simplify decoding.'],
        note: 'The step counts six formats; the manual counts four core ones (R, I, S, U) and treats B and J as the S and U formats with their immediate bits rearranged (Immediate Encoding Variants). The count differs, the bits are the same.',
        quizzes: [
          { question: 'The manual calls R, I, S and U the core formats and B and J variants of S and U. What makes a variant?', options: ['A different opcode width', 'Only how the immediate bits are arranged in the word', 'A different position of rs1 and rs2', 'A different instruction length'], answer: 1,
          why: ['Every format has the opcode in bits 6:0.', '', 'rs1 and rs2 never move: that is the rule quoted above.', 'All are 32 bits in RV32I.'],
          explain: 'B has S\'s fields with the immediate scrambled so its bits sit where S puts them; J does the same for U. The decoder and the register file see the same fields either way.' },
          { question: 'Why does the manual keep rs1, rs2 and rd in the same bit positions in every format?', options: ['So the assembler is simpler', 'So register reads can start before the format is known', 'To save opcode space', 'So immediates can be longer'], answer: 1,
          why: ['The assembler is not the cost the design avoids; the decode path is.', '', 'The opcode is a separate field; register fields do not use it.', 'Fixed register fields take bits away from the immediate, not give them.'],
          explain: 'The register file\'s read addresses are wires straight from the word, so the read runs in parallel with decoding.' },
          { question: 'Which instruction bits hold rd in an R-type, I-type, U-type and J-type word?', options: ['Bits 11:7 in all four', 'Bits 24:20 in R and I, 11:7 in U and J', 'Bits 19:15 in all four', 'It depends on funct3'], answer: 0,
          why: ['', 'Bits 24:20 are rs2 (R) or the immediate (I).', 'Bits 19:15 are rs1.', 'funct3 selects an operation, never where a register field sits.'],
          explain: 'rd is bits 11:7 wherever it exists. S and B have no rd, and use those five bits for immediate bits instead.' },
        ],
      },
      body: `
        <p>Every RV32I instruction is 32 bits. The opcode (bits 6:0) selects one of six formats. The design rule that shapes
        everything: <strong>rs1, rs2 and rd are always in the same bit positions</strong>, so register-file reads start in
        parallel with decoding.</p>
        <p>Immediates pay for that. The S format splits its immediate around rs2; B and J scramble theirs so that the sign
        is always bit 31 and most immediate bits sit in the same place across formats. The immediate generator then needs
        fewer multiplexer inputs per bit.</p>
        <p>Under the word, the immediate is rebuilt bit by bit the way the hardware does it: each result bit is a wire
        from one instruction bit, a copy of bit 31 (dashed), or ground. No gates.</p>
        <p>The six formats: <strong>R</strong> (three registers: <code>add</code>), <strong>I</strong> (a register and a 12-bit immediate: <code>addi</code>, loads,
        <code>jalr</code>), <strong>S</strong> (two registers and a split immediate: stores), <strong>B</strong> (the same for branches, offset in halfwords),
        <strong>U</strong> (a 20-bit upper immediate: <code>lui</code>, <code>auipc</code>) and <strong>J</strong> (<code>jal</code>, a 20-bit offset). Four are the
        same few fields in different proportions. What the encoding does not spend is bits on decoding: with the sign always at bit 31, sign extension is one fan-out wire
        and does not wait for the format to be known, and funct3 and funct7 stay put so the ALU control can start from them before the opcode has been decoded.</p>
        <p>The cost shows up here and nowhere else. A B-type immediate takes bits from four places of the word, and the immediate generator is, per output bit, a selection among the formats driven by
        the opcode, plus wiring. A simpler layout would have made the assembler easier to write and the hardware slower.</p>
        <div class="try">Pick <code>beq</code> and drag its offset: bit 12 of the offset lands in instruction bit 31, bit 11 in bit 7.
        Then flip bit 30 of an <code>add</code>, or any bit of the opcode, and see what the decoder makes of it.</div>`,
      widget: () => instructionExplorer(),
      more: {
        derive: `<p>Encode <code>beq x1, x2, +16</code>: the offset 16 = 0b1_0000 has only imm[4] set. In a B-type word imm[4:1] sits in instruction bits 11:8, imm[4] on top, so bit 11 of the word is 1 beside the
          fixed fields. Decoding reverses it: imm[12] = inst[31], imm[11] = inst[7], imm[10:5] = inst[30:25], imm[4:1] = inst[11:8], imm[0] = 0. Four slices of the word, one constant, and the sign taken from bit 31.</p>`,
        pitfall: `<p>Forgetting that the offset counts from the branch itself and is stored without bit 0: a hand-encoded <code>beq</code> with the offset in bytes shifted left one place lands twice as far as intended.
          The explorer shows the same bits two ways; check that the decoded offset and the one you meant agree.</p>`,
        real: `<p>RISC-V chose this layout after the MIPS and Alpha experience: the immediate generator is a small part of the decode path. The compressed (C) extension reuses the fields for 16-bit forms, so
          the same decoder sees both. ARM's A32 spends its bits differently, on conditional execution of every instruction, and its decode is correspondingly heavier.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why is the branch offset stored in units of 2 bytes, not 4, even though RV32I instructions are 4 bytes?',
        options: ['To reach farther', 'To support the 16-bit compressed (C) extension without a new encoding', 'Because bit 0 is used for the condition'], answer: 1,
        why: ['Halfword units do reach farther than byte units, but word units would reach farther still: range is not why it stops at 2.', '', 'The condition is in funct3. Bit 0 of the offset is simply not stored, since it is always 0.'],
        explain: 'With the C extension instructions can sit on 2-byte boundaries. Encoding offsets in halfwords keeps one branch format for both.',
      },
    },
    {
      title: 'The assembler',
      body: `
        <p>The assembler turns text into those words in two passes: pass 1 assigns addresses to labels (pseudo-instructions
        like <code>li</code> may expand to two words, <code>lui</code> + <code>addi</code>), pass 2 encodes.</p>
        <p>Why two passes: a branch to a label further down cannot be encoded until the label's address is known, and an address depends on how many words
        every earlier line expands to. Pass 1 only counts and records labels; pass 2, with every address fixed, encodes. A pseudo-instruction whose size depends on its operand
        (<code>li</code> with a constant that does not fit 12 bits) is why pass 1 must know the size before it knows the encoding.</p>
        <p>The result runs immediately on an <strong>instruction-set simulator</strong>, written directly from the
        specification. The gate-level CPU in the next chapter is checked against it after every clock cycle: the simulator is
        the definition of what the hardware must do, and a disagreement on any register after any instruction is a hardware bug.</p>
        <div class="try">Edit the program: errors show up with their line numbers, and the machine code updates as you type.</div>`,
      widget: () => assemblerWorkspace(src('sum')),
      more: {
        derive: `<p><strong>lui + addi rounds.</strong> addi adds a signed 12-bit value, so the upper part is (v + 0x800) &gt;&gt; 12: <code>li a0, 0x12845</code> becomes <code>lui a0, 0x13</code>;
          <code>addi a0, a0, -1979</code> (0x13000 − 0x7BB = 0x12845). <strong>auipc for addresses.</strong> <code>la a0, sym</code> is <code>auipc a0, hi</code>; <code>addi a0, a0, lo</code> and
          <code>call f</code> is <code>auipc ra, hi</code>; <code>jalr ra, lo(ra)</code>, both from the distance to the symbol, rounded the same way: position-independent code with ±2 GiB reach,
          where <code>jal</code> reaches ±1 MiB.</p>`,
        pitfall: `<p><strong>PC-relative to the instruction itself.</strong> A branch or <code>jal</code> at address A jumps to A + offset, not A + 4 + offset (MIPS counts from the next instruction, ARM32 from the one after that):
          <code>beq</code> at 0x100 with offset 16 lands on 0x110. <strong>Every I-type immediate is sign-extended</strong>, logical ones too: <code>andi a0, a0, -16</code> masks with 0xFFFF_FFF0,
          <code>xori rd, rs, -1</code> is <code>not</code>, <code>sltiu rd, rs, -1</code> compares (unsigned) with 0xFFFF_FFFF, and a mask such as 0x800 does not fit at all (−2048 … 2047).
          Assemble these in the editor above and read the words back.</p>`,
        real: `<p>Production assemblers also relax branches (a short form when the target is near, a long form otherwise), emit relocations for the linker to patch, and handle sections and
          alignment. This one resolves everything in two passes because a program here is one file; the principle, count then encode, is the same.</p>`,
      },
    },
  ],
};

export const FETCH_LOOP = `# sum = 3 + 2 + 1, stored at address 0
        li   a0, 3          # n = 3
        li   a1, 0          # sum = 0
loop:   add  a1, a1, a0     # sum += n
        addi a0, a0, -1     # n -= 1
        bnez a0, loop       # again while n != 0
        sw   a1, 0(zero)    # mem[0] = sum
halt:   j    halt`;

const RTYPE = `# R-type and I-type: rd = rs1 op rs2 / imm
        li   a0, 7
        li   a1, 5
        add  a2, a0, a1     # 12
        sub  a3, a0, a1     # 2
        and  a4, a0, a1     # 5
        slli a5, a0, 3      # 56
        slt  a6, a1, a0     # 1
halt:   j    halt`;

const MEMOPS = `# loads and stores
        li   t0, 42
        sw   t0, 8(zero)    # mem[8] = 42
        lw   t1, 8(zero)    # t1 = mem[8]
        addi t1, t1, 1
        sw   t1, 12(zero)
halt:   j    halt`;

export const chSingleCycle: Chapter = {
  id: 'cpu', num: 14, title: 'A single-cycle CPU', level: 'Processor',
  blurb: 'Every block from the previous chapters, wired into a complete RV32I processor.',
  goals: [
    'trace one instruction through fetch, decode, execute, memory and write-back on the gate-level datapath',
    'set the control signals for add, addi, lw, sw, beq and jal',
    'say why every instruction of a single-cycle CPU gets the time of the slowest',
    'run a real program on the gates and check it against the instruction-set simulator',
  ],
  builds: ['alu', 'regfile', 'isa'],
  recap: {
    keep: [
      'One instruction per clock: PC → instruction memory → decode and register read → ALU → data memory → result mux → register file, written at the next rising edge.',
      'Control comes from the opcode: RegWrite, ALUSrcB, ResultSrc, MemWrite, ImmSrc, and ALUControl: {funct7[5], funct3} for an R-type; funct3 for OP-IMM, with bit 30 only for <code>srai</code>; ADD for loads, stores, <code>jalr</code> and <code>auipc</code>; SUB for branches.',
      'Branches subtract in the ALU and read its flags (beq Z, bne ¬Z, blt N⊕V, bge ¬(N⊕V), bltu ¬C, bgeu C); a separate adder computes PC + imm<sub>B</sub>.',
      '<code>jal</code> writes PC + 4 and jumps to PC + imm<sub>J</sub>; <code>jalr</code> jumps to rs1 + imm with bit 0 cleared by wiring.',
      'About 48 000 NANDs without the program ROM, 155 NAND delays per cycle with ripple adders, and the clock must fit the slowest instruction.',
    ],
    practise: ['c_imm', 'c_ctl', 'c_br', 'c_npc', 'c_core1', 'c_core2', 'c_core3'],
    check: [
      {
        question: 'For <code>sw t0, 8(a0)</code>, which control settings are right?',
        options: ['MemWrite = 1, ALUSrcB = immediate, RegWrite = 0', 'MemWrite = 1, RegWrite = 1, ResultSrc = memory', 'RegWrite = 1, ALUSrcB = rs2', 'MemWrite = 0, ResultSrc = ALU'],
        answer: 0,
        explain: 'The ALU adds rs1 and imm<sub>S</sub> for the address, rs2 is the data, and nothing is written back.',
        why: ['', 'A store writes no register: RegWrite = 1 would overwrite whichever register the immediate bits in 11:7 happen to name.', 'That is add: an R-type whose result is written back.', 'MemWrite = 0 makes it no store at all.'],
      },
      {
        question: '<code>jal ra, f</code>: which value does the result mux send to the register file?',
        options: ['PC + 4', 'PC + imm<sub>J</sub>', 'The ALU result', 'The immediate'],
        answer: 0,
        explain: 'ra gets the return address from the +4 adder; the target PC + imm<sub>J</sub> goes to the PC.',
        why: ['', 'That is the jump target: it goes to the PC, not to ra.', 'The return address comes from the +4 adder; nothing the ALU computes is written back.', 'The result mux passes the immediate for lui, not for jal.'],
      },
      {
        question: 'A program of mostly <code>addi</code> runs on the single-cycle CPU. Why is each instruction no faster than a load?',
        options: ['The clock period is fixed by the longest path any instruction can take', 'addi uses the data memory too', 'The register-file write takes the whole cycle', 'It is faster: each instruction takes its own time'],
        answer: 0,
        explain: 'One instruction per cycle at one period: the cycle must fit the slowest instruction, and addi wastes the slack. Designs that split an instruction over several cycles, or overlap instructions, exist to recover it.',
        why: ['', 'addi never touches the data memory; its path ends at the result mux.', 'The write happens at the clock edge; it is not what makes the cycle long.', 'A synchronous design has one clock period for every instruction.'],
      },
    ],
  },
  steps: [
    {
      title: 'The datapath',
      body: `
        <p>This is a complete RV32I processor, simulated at gate level: about 48 000 NANDs without its program ROM
        (the Info tab's total counts the ROM too, which grows with the program). Each <strong>Pulse</strong> executes one instruction:</p>
        <ul><li><strong>Fetch</strong>: <span data-show="pc">PC</span> addresses the <span data-show="imem">instruction memory</span>; +4 computes the next sequential address.</li>
        <li><strong>Decode</strong>: the splitter fans the instruction fields out; the <span data-show="rf">register file</span> reads rs1/rs2 while the
        <span data-show="ctl">control unit</span> and <span data-show="imm">immediate generator</span> work on the opcode.</li>
        <li><strong>Execute</strong>: SrcA/SrcB muxes feed the <span data-show="alu">ALU</span>.</li>
        <li><strong>Memory / write-back</strong>: the <span data-show="dm">data memory</span> is addressed by the ALU result; the result mux picks ALU,
        memory, PC+4 or immediate, and it is written to rd on the next rising edge.</li></ul>
        <p>Control signals are drawn as <em>net labels</em> (tags). Hover one to highlight every place that net goes.
        The panel shows the program, registers and memory, and checks every cycle against the instruction-set simulator.</p>
        <p>Click a program line: its <strong>fields</strong> appear in the panel and the wires that carry them take the
        same colours (opcode to the control unit, rd to the write address, and so on). Point at a field to follow only
        its wires; open <code>imm</code> or <code>ctl</code> and the colours follow you inside.</p>
        <p>Two registers carry state across a cycle: the PC and the register file (and the data memory on a store). Everything else is combinational, a function of those,
        so one instruction is one pass of signals through a few thousand gates, and the clock only has to wait until they settle. That is the whole design:
        the next chapters change how long the wait is and how many instructions share it, not what the instruction does.</p>
        <p>Program order is the PC's job: it normally steps by 4, and a branch or jump replaces the +4 with a target. Instruction memory is a ROM read by the PC with no clock,
        so the instruction is already on the wires when the cycle begins, and the edge at its end commits the PC, the register write and any store together.</p>`,
      scene: () => cpuScene({ source: src('sum') }),
      tour: {
        beats: [
          { title: 'Fetch', reset: true, show: ['pc', 'imem'], expect: { pcOut: 0, aluOut: 0 },
            say: '<p>Power on: the PC is {v:pcOut}, and the ROM, which has no clock, is already showing the word at that address on <code>instrOut</code> ({b:instrOut}). The first instruction is <code>li a0, 0</code>.</p>' },
          { title: 'Execute', cycles: 1, show: ['rf', 'imm', 'alu'], expect: { pcOut: 4, aluOut: 1 },
            say: '<p>One rising edge: the PC took PC + 4 = {v:pcOut} and a0 was written. The new instruction is <code>li t0, 1</code>, really <code>addi t0, zero, 1</code>: the register file reads x0, the immediate generator builds 1, and the ALU adds them: {v:aluOut}.</p>' },
          { title: 'A register operation', cycles: 2, show: ['rf', 'alu', 'res'], expect: { pcOut: 12, aluOut: 1 },
            say: '<p>At {v:pcOut} is the first instruction of the loop, <code>add a0, a0, t0</code>: both operands now come from the register file, a0 = 0 and t0 = 1, and the ALU gives {v:aluOut}. The result mux sends it back to the register file, to be written at the next edge.</p>' },
          { title: 'A branch decides', cycles: 2, show: ['alu', 'npc'], expect: { pcOut: 20 },
            say: '<p>At {v:pcOut}, <code>bne t0, t1, loop</code>: the ALU subtracts t0 − t1 = 2 − 11 = −9 (0xFFFFFFF7), which is not zero, so the next-PC logic will not use PC + 4.</p>' },
          { title: 'The PC jumps back', cycles: 1, show: ['target', 'pcmux'], expect: { pcOut: 12 },
            say: '<p>The PC is {v:pcOut} again, not 24: the select chose the branch-target adder (PC + imm<sub>B</sub>) over PC + 4. The loop runs nine more times, one cycle per instruction.</p>' },
        ],
      },
      more: {
        derive: `<p>A cycle's length is the longest path from a state element to a state element. For this machine that is PC → instruction memory → decode and immediate → ALU → next-PC select → PC,
          or the same through the data memory for a load: about 155 NAND delays with ripple adders. Cycles for a program = instructions executed, since each takes exactly one, so the program's time
          is instructions × 155 delays whatever mix it has. The pipeline of chapter 17 attacks both factors.</p>`,
        pitfall: `<p>Judging the machine by the program text: a loop is one block of code and many cycles. The Pulse counter and the PC tell the truth. Count cycles as instructions executed, and a
          taken branch as one cycle, not two: the single-cycle machine pays nothing extra for a taken branch; a pipeline does.</p>`,
        real: `<p>Almost no shipping core is single-cycle: even small microcontroller cores split the datapath over two or three stages, and this design is where they start. The panel's Slow button
          plays an edge one gate delay at a time at the gate level: the new PC leaves its register, the instruction is fetched and decoded, and the result
          waits at the register file's inputs. That longest ripple sets the clock period.</p>`,
      },
    },
    {
      title: 'ALU instructions',
      body: `
        <p>For <code>add</code>: RegWrite = 1 (write rd), ALUSrcB = 0 (the <span data-show="srcB">second ALU operand</span>
        is rs2; the <span data-show="srcA">first</span> is rs1), ResultSrc = ALU (the <span data-show="res">result mux</span>
        writes back the ALU's output), ALUControl = {funct7[5], funct3} (the <span data-show="alu">ALU</span>'s operation).
        For <code>addi</code>: ALUSrcB = 1 with ImmSrc = I (the <span data-show="imm">immediate generator</span> builds an
        I-type immediate), and ALUControl = {0, funct3}: bit 30 is imm[10] here, so <code>addi a0, a0, -1</code> must not
        become a subtraction. Only <code>srai</code> (funct3 = 101) passes it on. Loads, stores, <code>jalr</code> and
        <code>auipc</code> get ADD, branches SUB, whatever their funct3: a few gates in the
        <span data-show="ctl">control unit</span>.</p>
        <p>The point of the control unit is how little it does for these instructions: it reads the opcode and funct bits and asserts a handful of one-bit signals, each of which
        steers one multiplexer or enables one write. The same datapath serves <code>add</code> and <code>addi</code>, differing only in whether the second operand mux takes rs2 or the
        immediate. Nothing is decoded twice, and nothing is chosen by a sequence of steps: the signals are a lookup on the instruction bits.</p>
        <div class="try">Pulse through the program and watch the highlighted path: <span data-show="rf">register file</span> → ALU → result mux → back into the register file.</div>`,
      scene: () => cpuScene({ source: RTYPE, highlight: ['rf', 'srcA', 'srcB', 'alu', 'res', 'imm'] }),
      tour: {
        beats: [
          { title: 'Constants into registers', reset: true, show: ['imm', 'srcB', 'alu'], expect: { pcOut: 0, aluOut: 7 },
            say: '<p><code>li a0, 7</code> is <code>addi a0, zero, 7</code>: ALUSrcB selects the immediate, the ALU adds it to x0\'s 0 and gets {v:aluOut}. The same happens for <code>li a1, 5</code> next.</p>' },
          { title: 'add: two registers', cycles: 2, show: ['rf', 'srcA', 'srcB', 'alu'], expect: { pcOut: 8, aluOut: 12 },
            say: '<p><code>add a2, a0, a1</code>: ALUSrcB now selects rs2. 7 + 5 = {v:aluOut}. ALUControl is {funct7[5], funct3} = 0000.</p>' },
          { title: 'sub: one bit different', cycles: 1, show: ['alu', 'ctl'], expect: { pcOut: 12, aluOut: 2 },
            say: '<p><code>sub a3, a0, a1</code> differs from <code>add</code> in instruction bit 30 alone, which is ALUControl[3]: the ALU subtracts and gets {v:aluOut}.</p>' },
          { title: 'A shift by immediate', cycles: 2, show: ['imm', 'alu'], expect: { pcOut: 20, aluOut: 56 },
            say: '<p><code>slli a5, a0, 3</code> at {v:pcOut}: the shift amount rides in the immediate field, the ALU\'s shifter moves 7 left three places and gets {v:aluOut}.</p>' },
          { title: 'Compare', cycles: 1, show: ['alu'], expect: { pcOut: 24, aluOut: 1 },
            say: '<p><code>slt a6, a1, a0</code>: 5 &lt; 7, so the ALU result is {v:aluOut}. The comparison is the subtraction\'s flag, not a comparator.</p>' },
        ],
      },
      more: {
        derive: `<p>Signals for the instructions here, from the opcode: add / sub / and / slt (R-type): RegWrite 1, ALUSrcB 0, ResultSrc ALU, MemWrite 0, ALUControl {funct7[5], funct3}.
          addi / slli (OP-IMM): ALUSrcB 1, ImmSrc I, ALUControl {0, funct3} except <code>srai</code>. The two rows differ in two signals, which is why the control unit is mostly an OR of a few opcode
          decodes. Each signal is a function of the opcode's seven bits (and, for the ALU, funct3 and bit 30), so each is a small block of gates one level deep after the decoder.</p>`,
        pitfall: `<p>Reading bit 30 as "subtract" everywhere: in an I-type word it is immediate bit 10, so <code>addi a0, a0, -1</code> has bit 30 set and must still add. The control passes bit 30 on
          only for R-type and for <code>srai</code>, and for loads, stores, <code>jalr</code> and <code>auipc</code> it forces ADD whatever the instruction bits are.</p>`,
        real: `<p>Hardwired decode like this is how every RISC core works. Microcoded machines (the 6502, early x86) look instructions up in a ROM and take several cycles; the multicycle chapter compares
          the two on this instruction set.</p>`,
      },
      tries: [(st) => { try { return st.sim ? cpuState(st.sim).x[16] === 1 : false; } catch { return false; } }],
    },
    {
      title: 'Loads and stores',
      reading: {
        source: 'RISC-V Unprivileged ISA (current AsciiDoc, riscv-isa-manual)', section: 'RV32I, Immediate Encoding Variants',
        quote: [
          'The only difference between the S and B formats is that the 12-bit immediate field is used to encode branch offsets in multiples of 2 in the B format. Instead of shifting all bits in the instruction-encoded immediate left by one in hardware as is conventionally done, the middle bits (imm[10:1]) and sign bit stay in fixed positions, while the lowest bit in S format (inst[7]) encodes a high-order bit in B format.',
          'Sign extension is one of the most critical operations on immediates (particularly for XLEN>32), and in RISC-V the sign bit for all immediates is always held in bit 31 of the instruction to allow sign extension to proceed in parallel with instruction decoding.'],
        note: 'This is the immediate generator you can open in the datapath: each output bit is a wire from one instruction bit, a copy of bit 31, or ground, and a multiplexer on the format picks among them.',
        quizzes: [
          { question: 'The I-type immediate field of a load holds 0xFFC. What 32-bit value does the immediate generator produce?', options: ['0x00000FFC', '0xFFFFFFFC', '0xFFFFF000', '0x7FFFFFFC'], answer: 1,
          why: ['That is zero extension; the field\'s top bit is 1, so the value is negative.', '', 'That would shift the field up instead of extending it.', 'Bit 31 of the result is a copy of the sign, so it is 1.'],
          explain: '0xFFC is 12 bits with the sign set: −4. Bits 31:11 of the result are copies of instruction bit 31, so the load reads from rs1 − 4.' },
          { question: 'Why can the generator copy bit 31 into the upper result bits before the format is decoded?', options: ['Because bit 31 is always zero', 'Because every format with an immediate holds its sign in bit 31', 'Because the ALU fixes the sign afterwards', 'It cannot; it waits for the opcode'], answer: 1,
          why: ['Bit 31 is the sign, and negative offsets exist.', '', 'The ALU adds the immediate it is given.', 'The fan-out wire needs no decoder, which is the point of the layout.'],
          explain: 'The sign is in the same place in I, S, B, U and J, so sign extension is one fan-out of one wire, in parallel with decode. Only the lower bits need the format.' },
          { question: 'Instruction bit 7 holds imm[0] of a store. What does the same bit hold in a branch?', options: ['imm[0] again', 'imm[11]', 'rd[0]', 'Nothing'], answer: 1,
          why: ['A branch offset is a multiple of 2, so its bit 0 is not stored at all.', '', 'Branches have no rd.', 'The bit is used: it takes the place the missing bit 0 frees.'],
          explain: 'Because B offsets are multiples of 2, the bit that held imm[0] in S is reused for imm[11]; the middle bits and the sign stay put, so most wires are shared between the two formats.' },
        ],
      },
      body: `
        <p><code>sw</code>: the <span data-show="alu">ALU</span> computes rs1 + imm<sub>S</sub>, MemWrite = 1 (the
        <span data-show="dm">data memory</span> writes), data = rs2. Nothing is written back.
        <code>lw</code>: same address computation, ResultSrc = memory (the <span data-show="res">result mux</span> passes the loaded word). On paper that is the longest path:
        clock → PC → instruction memory → register file → ALU (32-bit ripple add) → data-memory read mux → result mux → register
        file input. <a href="#/c/fastadd/0">Chapter 16</a> measures this machine and finds a surprise.</p>
        <p>Both use the ALU as an address adder, and that reuse is why the immediate formats differ: I-type for the load (rs1 + imm<sub>I</sub>), S-type for the store
        (rs1 + imm<sub>S</sub>), with the same rs1 and the same ALU operation. A store has no destination register, so the 5 bits that would hold rd carry the low immediate bits
        and RegWrite stays 0. The data memory reads asynchronously like the instruction memory, so a load's data is on the result mux within the cycle; a store changes memory only at the edge.</p>
        <div class="try">Pulse to the <code>lw</code> and compare the status bar's "settled in N delays" with an <code>addi</code>.</div>`,
      scene: () => cpuScene({ source: MEMOPS, highlight: ['alu', 'dm', 'res'] }),
      tour: {
        beats: [
          { title: 'A value to store', reset: true, show: ['alu', 'imm'], expect: { pcOut: 0, aluOut: 42 },
            say: '<p><code>li t0, 42</code>: the ALU puts {v:aluOut} on its output and the result mux sends it to t0.</p>' },
          { title: 'sw: the address', cycles: 1, show: ['alu', 'dm'], expect: { pcOut: 4, aluOut: 8 },
            say: '<p><code>sw t0, 8(zero)</code>: the ALU adds rs1 (x0 = 0) and imm<sub>S</sub> (8) and gets the address {v:aluOut}. rs2 = t0 goes to the data memory as the data, MemWrite = 1, and the write happens at the edge.</p>' },
          { title: 'lw: the same address', cycles: 1, show: ['alu', 'dm', 'res'], expect: { pcOut: 8, aluOut: 8 },
            say: '<p><code>lw t1, 8(zero)</code> computes the same address, {v:aluOut}. ResultSrc selects the memory\'s output, not the ALU\'s: t1 gets 42 at the next edge.</p>' },
          { title: 'Used immediately', cycles: 1, show: ['rf', 'alu'], expect: { pcOut: 12, aluOut: 43 },
            say: '<p><code>addi t1, t1, 1</code> reads t1 = 42 and the ALU gives {v:aluOut}. There is no wait after a load in this machine: the loaded value was written at the previous edge.</p>' },
          { title: 'Another word', cycles: 1, show: ['alu', 'dm'], expect: { pcOut: 16, aluOut: 12 },
            say: '<p><code>sw t1, 12(zero)</code> stores 43 at address {v:aluOut}. The memory holds 42 at 8 and 43 at 12.</p>' },
        ],
      },
      more: {
        derive: `<p>The load's path is the longest of the simple instructions: clock → PC → instruction memory → decode and immediate → ALU add → data-memory address decode and read mux → result mux → register file input.
          Every stage is a series term, so lw costs the sum, and add costs the sum without the memory term. The clock must fit lw, so add idles for the length of the data-memory read.</p>`,
        pitfall: `<p>An offset is signed and in bytes. <code>lw t1, 8(zero)</code> addresses byte 8, which is word 2 of the memory; the panel shows words, and the first time the address looks "off by four" it
          is this. A store\'s immediate is split in the word (imm[11:5] at the top, imm[4:0] where rd would be), so reading it off the hex by eye mis-reads it.</p>`,
        real: `<p>On a real machine this step is where most of the time goes: a load goes to a cache whose hit takes several cycles and a miss takes hundreds. The "memory in one cycle" abstraction is only true
          because this design\'s memories are logic; the memory chapters replace it with a hierarchy.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'With realistic memories (SRAM slower than the logic around it), which instruction class sets the clock period of a single-cycle CPU?',
        options: ['R-type (two register reads)', 'lw (ALU, then memory, then write-back)', 'beq (subtract and compare)', 'jal (no register read)'], answer: 1,
        why: ['Both register reads happen in parallel, and an R-type skips the data memory entirely.', '', 'With a realistic memory, a branch ends at the next-PC logic and never waits for a data-memory read. (This site\'s memories are fast mux trees, so chapter 16\'s static timing finds a branch path on top: a surprise only cheap memory allows.)', 'jal reads no register, and its path through an adder to the result mux is shorter still.'],
        explain: 'Every cycle must be long enough for the slowest instruction, and lw chains the ALU and the memory read. The other instructions waste the slack. That is the motivation for splitting an instruction over several cycles and for overlapping instructions.',
      },
    },
    {
      title: 'Branches and jumps',
      reading: {
        source: 'RISC-V Unprivileged ISA (current AsciiDoc, riscv-isa-manual)', section: 'RV32I, Control Transfer Instructions (Unconditional Jumps; Conditional Branches)',
        quote: [
          'The JAL (jump and link) instruction uses the J-type format, where the J-immediate encodes a signed offset in multiples of 2 bytes. The offset is sign-extended and added to the address of the jump instruction to form the jump target address. Jumps can therefore target a ±1 MiB range.',
          'All branch instructions use the B-type instruction format. The 12-bit B-immediate encodes signed offsets in multiples-of-two bytes. The offset is sign-extended and added to the address of the branch instruction to give the target address. The conditional branch range is ±4 KiB.'],
        note: 'The dedicated target adder in the datapath is exactly this sentence: PC plus the sign-extended immediate, computed beside the ALU, so that when the flags arrive only a multiplexer is left.',
        quizzes: [
          { question: 'A beq at address 0x20 has the offset −8. Where does it go when taken?', options: ['0x18', '0x1C', '0x14', '0x24'], answer: 0,
          why: ['', 'That adds the offset to PC + 4. The manual says the address of the branch itself.', 'That subtracts the offset twice.', 'That is the fall-through, PC + 4.'],
          explain: 'Target = PC of the branch + offset = 0x20 − 8 = 0x18. The target adder takes the branch\'s own PC, not the incremented one.' },
          { question: 'How far can a conditional branch reach, and why?', options: ['±2 KiB: 12 bits of byte offset', '±4 KiB: 12 bits in units of 2 bytes', '±1 MiB: 20 bits', '±8 KiB: 13 bits in units of 2'], answer: 1,
          why: ['That would be a 12-bit offset in bytes; the stored bits are halfword units.', '', 'That is jal, which has a 20-bit immediate.', 'The immediate has 12 stored bits plus the implicit zero: 13 bits of byte offset in total.'],
          explain: '12 stored bits × 2 bytes = a 13-bit signed byte offset: −4096 … +4094.' },
          { question: 'What would jal reach if its 20 stored bits were a byte offset instead of units of 2?', options: ['±512 KiB', '±1 MiB', '±2 MiB', '±64 KiB'], answer: 0,
          why: ['', 'That is the real range, with units of 2 bytes.', 'That needs 22 bits of byte offset.', 'That is far too small for 20 bits.'],
          explain: '20 signed bits of bytes are ±512 KiB; the unstored bit 0 doubles it to ±1 MiB. The same trick gives a branch 4 KiB.' },
        ],
      },
      body: `
        <p>Branches use the ALU to subtract (ALUControl = SUB) and the <span data-show="npc">next-PC logic</span> reads the flags: beq Z, bne ¬Z,
        blt N⊕V, bge ¬(N⊕V), bltu ¬C, bgeu C. If taken, PCSrc (the <span data-show="pcmux">next-PC select</span>) picks
        PC + imm<sub>B</sub> from a <span data-show="target">dedicated adder</span>.</p>
        <p><code>jal</code> writes PC+4 to rd and jumps to PC + imm<sub>J</sub>; <code>jalr</code> jumps to (rs1 + imm) with bit 0 cleared:
        a <span data-show="clr0">wiring box</span> that ties bit 0 to ground. This program calls a function with <code>jal</code> and returns with <code>ret</code>
        (= <code>jalr zero, 0(ra)</code>).</p>
        <p>The branch decision is the longest chain in the machine: the flags depend on the whole subtraction, and only then can the next-PC logic pick between PC + 4 and the target. That is why the
        target has its own adder, computed in parallel with the ALU\'s subtraction instead of after it: when the flags arrive, both candidate PCs are ready and only a multiplexer is left.</p>`,
      scene: () => cpuScene({ source: src('gcd'), highlight: ['npc', 'target', 'pcmux', 'clr0'] }),
      tour: {
        beats: [
          { title: 'Arguments', reset: true, show: ['alu'], expect: { pcOut: 0, aluOut: 1071 },
            say: '<p>Two <code>li</code> set up a0 = 1071 and a1 = 462, the numbers whose gcd we want.</p>' },
          { title: 'jal: call', cycles: 2, show: ['target', 'pcmux'], expect: { pcOut: 8 },
            say: '<p><code>jal ra, gcd</code> at {v:pcOut}: the result mux sends PC + 4 = 12 to ra, and the next PC is PC + imm<sub>J</sub>, the address of <code>gcd</code>.</p>' },
          { title: 'Inside the function', cycles: 1, show: ['pc'], expect: { pcOut: 20 },
            say: '<p>The PC is {v:pcOut}: execution continues at <code>gcd</code>, and ra remembers where to come back to.</p>' },
          { title: 'Not equal, not less', cycles: 1, show: ['alu', 'npc'], expect: { pcOut: 24, aluOut: 609 },
            say: '<p><code>beq a0, a1, done</code> subtracted 1071 − 462 = 609 and found it non-zero, so it fell through to PC + 4. At {v:pcOut}, <code>bltu</code> subtracts again: {v:aluOut}, and the unsigned compare says a0 is not smaller.</p>' },
          { title: 'Loop by jumping back', cycles: 3, show: ['target', 'pcmux'], expect: { pcOut: 20, aluOut: 147 },
            say: '<p><code>sub a0, a0, a1</code> made a0 = 609 and <code>j gcd</code> jumped back to {v:pcOut}. The comparison now gives 609 − 462 = {v:aluOut}. The loop continues until a0 = a1 = 21.</p>' },
        ],
      },
      more: {
        derive: `<p>Taken or not: PCSrc = Branch ∧ cond ∨ Jump, where cond is selected by funct3 from Z, N⊕V, ¬C and their complements. With cond ready, the next PC is a 2:1 mux between PC + 4 and PC + imm<sub>B</sub>
          (jal uses imm<sub>J</sub>, jalr the ALU\'s rs1 + imm). Path length: the subtraction, then the flag, then the select; the target adder runs beside the ALU, so it adds nothing to the path.</p>`,
        pitfall: `<p>Reading <code>ret</code> as a special instruction. It is <code>jalr zero, 0(ra)</code>: rd = x0 (the link is discarded), target = ra + 0 with bit 0 cleared. If a function never
          saves ra and calls another, its own <code>ret</code> returns to the wrong place: look at ra after the second <code>jal</code>.</p>`,
        real: `<p>This is the part pipelines spend the most hardware on. A taken branch redirects the PC late in the cycle, and in a pipeline that is several instructions already fetched: predictors, target buffers and
          return stacks (chapters 17 and 18) all exist to avoid waiting for this decision.</p>`,
      },
    },
    {
      title: 'Run real programs',
      body: `
        <p>Pick a program in the panel, or write your own with <strong>Edit</strong>. <strong>Run to halt</strong> clocks the
        gate-level machine as fast as your browser allows, about 200 cycles per second for ~200 000 transistors.</p>
        <p>Supported: all of RV32I except byte/halfword loads and stores, <code>fence</code>, <code>ecall</code>, <code>ebreak</code>.
        A jump to itself is treated as halt.</p>
        <p>What this checks is the point of the exercise. After every clock cycle the panel compares all 32 registers, the PC and the memory with the instruction-set simulator, which was written
        from the specification and shares no code with the gates. A program that halts with the right answer has had every one of its instructions compared, not only its result.
        Anything the hardware gets wrong in a way the program exercises shows up at the first cycle where they differ.</p>`,
      scene: () => cpuScene({ source: src('fib'), editable: true }),
      tour: {
        beats: [
          { title: 'Setup', reset: true, show: ['pc', 'rf'], expect: { pcOut: 0 },
            say: '<p>Fibonacci starts by loading four registers: fib(n−2) = 0, fib(n−1) = 1, an address, and the limit 48 (12 words of 4 bytes).</p>' },
          { title: 'First store', cycles: 4, show: ['dm', 'alu'], expect: { pcOut: 16, aluOut: 0 },
            say: '<p>After four <code>li</code> the loop starts at {v:pcOut}: <code>sw t0, 0(t2)</code> will store fib(0) at address {v:aluOut}.</p>' },
          { title: 'One iteration', cycles: 5, show: ['alu', 'npc'], expect: { pcOut: 36, aluOut: 0xffffffd4 },
            say: '<p>Five instructions later the loop ends in <code>blt t2, t3</code> at {v:pcOut}: t2 is 4, t3 is 48, and the ALU\'s 4 − 48 = −44 is negative, so the branch is taken.</p>' },
          { title: 'Again', cycles: 1, show: ['pc'], expect: { pcOut: 16 },
            say: '<p>The PC is {v:pcOut} again and the second word is about to be stored. Eleven more passes fill the memory view with the first twelve Fibonacci numbers.</p>' },
        ],
      },
      more: {
        derive: `<p>Cycle count of the program: four setup instructions, 6 per iteration × 12 iterations, one final jump to itself: 4 + 72 + 1 = 77 instructions, and 77 cycles, since each takes one. The
          challenge says "about 75" for that reason. At roughly 200 cycles per second in the browser, the run takes under half a second; at the 155-delay period and the illustrative 25 ps a delay of chapter 16, a cycle is about
          4 ns and the whole run about 0.3 µs.</p>`,
        pitfall: `<p>A program that "works" on the simulator and not on the gates, or the reverse, almost always uses an instruction the hardware leaves out: byte and halfword accesses, <code>fence</code>,
          <code>ecall</code>. The panel stops at the first mismatch and names the register: start there, not at the end of the run.</p>`,
        real: `<p>Hardware designers verify this way: a golden model, random and directed programs, and a comparison after every retirement. The same method scales to full cores: this site\'s CPUs are also run through the official riscv-tests suite, and the golden model itself is
          checked against Spike, the RISC-V reference simulator.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Run the Fibonacci program until it halts (fib[11] = 89 in memory).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).dmem[11] === 89 : false; } catch { return false; } },
        hints: [
          'The program halts on a jump to itself; until then the clock has to keep running.',
          'The panel can clock the machine for you. Watch the memory view: each Fibonacci number is stored as it is computed.',
        ],
        answer: 'Press "Run to halt" in the panel (or Pulse about 75 times). The 12th word, at address 0x2C, becomes 89.',
        solve: (st) => { st.runCycles(200, () => { try { return st.sim ? cpuState(st.sim).dmem[11] === 89 : false; } catch { return false; } }); },
      },
    },
    {
      title: 'Your own instruction',
      body: `
        <p>The control unit is a lookup table from opcode to nine signals, so a new instruction is a new row of it. RISC-V reserves four major opcodes for this
        (<code>custom-0…3</code>; the first is used later by the GPU chapters, so a free choice here is one of the other three). The row is the whole definition: <code>regWrite</code>, ALU A (rs1 or PC) and B (rs2 or imm), the
        ALU operation, <code>memWrite</code>, the result mux (ALU, memory, PC + 4, imm) and the next-PC choice. The data path does not change: fetch, register read, ALU, memory and
        write-back are already there, and the row only picks which of them the instruction uses.</p>
        <p>Cost, from the circuit: the control unit is ${CONTROL_NANDS} NANDs. A new instruction class adds one 5-input AND on the opcode rails (${AND5_NANDS} NANDs) and one more OR input on every signal
        its row asserts: <code>lwx</code> asserts <code>regWrite</code> and <code>resSrc0</code>, so ${LWX_NANDS - CONTROL_NANDS} NANDs in all, ${((LWX_NANDS - CONTROL_NANDS) / 48000 * 100).toFixed(2)} % of the core. The decoder here matches
        opcode[6:2] only, so funct3 and funct7 are free for the instruction's own use and one opcode holds one instruction; a decoder that also matches funct3 shares an opcode among eight, for
        a few ANDs more per instruction.</p>
        <p>What it buys: the loop on the left sums eight words. Without the instruction each element takes <code>add t4, a0, t0</code> and <code>lw t2, 0(t4)</code>; with <code>lwx</code> it is one instruction,
        4 cycles an iteration instead of 5. The draft row below only adds and writes nothing. The panel is the row editor of the sandbox's <em>Custom instructions…</em> dialog: set the signals, build the CPU and run.
        The golden model executes the same row, so lock step with it will agree with a wrong definition as well; the program's answer is what says it is the one you meant.</p>`,
      scene: () => ownInstrScene(),
      lit: 'The control unit (ctl) grows by the new class; the data path stays as it was.',
      more: {
        derive: `<p>The class AND is 5-input: opcode[6:2] = 01010 for custom-1, ${AND5_NANDS} NANDs, and its output is ORed into each signal the row asserts. For <code>lwx</code>: <code>regWrite</code> (7 → 8 inputs) and
          <code>resSrc0</code> (2 → 3). The ALU needs no row of its own: ALU control is funct3-driven only for rows that ask for it (<code>alu = funct3</code>), and an adder is the default.</p>`,
        pitfall: `<p><strong>Right gates, wrong meaning.</strong> The golden model reads the same row, so a row that loads nothing passes the CPU panel's lock step: gates and model agree on a bad definition. Hardware verification
          has the same gap, which is why it checks a design against a specification written separately (the instruction-set manual), not against itself. Here the specification is the program's expected sum.</p>`,
        real: `<p>Indexed addressing is the commonest request of this kind: RISC-V's base ISA has only <code>rs1 + imm</code>, and the T-Head and Zba extensions add scaled-index forms. Extensions get past
          the three-line row by decoding funct7 as well and by widening the ALU's operations (clz, rotates, bit-field extract). Each choice is the one made here: a row, a few NANDs, and a toolchain that must learn the mnemonic.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Define lwx so that the program sums the array: mem[0] = 80 after it halts.',
        check: ownInstrSolved,
        hints: [
          'The program needs rd ← mem[rs1 + rs2]: two of the signals are wrong in the draft.',
          'The instruction must write rd, and what it writes comes from memory, not from the ALU. The ALU already adds rs1 and rs2: the address.',
          'Set write rd = yes and result = memory, press Build the CPU, then Run to halt in the CPU panel.',
        ],
        answer: 'Set <code>write rd</code> to yes and <code>result</code> to memory (ALU A = rs1, ALU B = rs2 and ALU op = add stay): rd ← mem[rs1 + rs2]. Build the CPU, run to halt: the sum, 3 + 5 + … + 17 = 80, ends in mem[0]. The control unit grows by 14 NANDs.',
        solve: solveOwnInstr,
      },
    },
  ],
};
