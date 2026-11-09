import { groupDigits } from '../sim/numfmt';
import { BOOTH_ENC, MDU, SRT_SELECT, arrayDiv, arrayMul, boothMul, csa, divStep, nrArrayDiv, pipeMul, popcount, rca, seqDivider, seqMul, srt4Divider, srtDivider, treeMul } from '../lib';
import { cpuState } from '../riscv/cosim';
import { flatten } from '../sim/flatten';
import { CLK_TO_Q, SETUP, analyzeTiming } from '../sim/timing';
import { netlistOf, type ComponentDef } from '../sim/types';
import { logicDepth, stats } from '../sim/stats';
import { M_PROGRAMS } from '../riscv/mprograms';
import { PIPE_M_PROGRAMS } from '../riscv/pmprograms';
import { cpuScene } from '../widgets/cpupanel';
import { PY_PROGRAMS } from '../lang/pyprograms';
import { pyScene } from '../widgets/python';
import { GCD_I, PREFIX } from './ch-pipe';
import { divComparison } from '../widgets/divide';
import { boothWidget, mulComparison } from '../widgets/muldiv';
import { mulStyles } from '../widgets/multiply';
import { kNands, sysNands } from './ch-system';
import type { Chapter } from './types';
import { numOf } from './order';

const msrc = (id: string) => M_PROGRAMS.find((p) => p.id === id)!.source;
const pct = (a: number, b: number) => Math.round((a / b - 1) * 100);
/** NANDs and NAND delays of a block, from its netlist. */
const nd = (d: Parameters<typeof stats>[0]) => stats(d).nands;
const dp = (d: Parameters<typeof logicDepth>[0]) => logicDepth(d) ?? 0;
/** The array's depth grows by this many delays per bit of width (fitted to 4 and 8 bits), and so reaches ARR32 at 32 bits. */
const ARR_SLOPE = (dp(arrayMul(8)) - dp(arrayMul(4))) / 4;
const ARR_B = ARR_SLOPE * 4 - dp(arrayMul(4));
const ARR32 = dp(arrayMul(8)) + 24 * ARR_SLOPE;
/** Rows left after each level of 3:2 compressors: 8 → 6 → 4 → 3 → 2. */
const wallace = (rows: number) => { const c = [rows]; for (let r = rows; r > 2; ) c.push((r -= Math.floor(r / 3))); return c.join(' → '); };
/** Clock period of a clocked unit by static timing, and of a combinational one between two registers. */
const period = (d: ComponentDef) => analyzeTiming(flatten(d))?.period ?? 0;
const between = (d: ComponentDef) => CLK_TO_Q + dp(d) + SETUP;
/** NANDs of the M unit's part called `name` (mul, div). */
const mduPart = (name: string) => nd(netlistOf(MDU)!.instances.find((i) => i.name === name)!.def);
const sp = groupDigits;

const fmt = groupDigits;
const pySrc = (id: string) => PY_PROGRAMS.find((p) => p.id === id)!.source;
/** chapter 15's samples compiled for RV32IM on the gate-level pipeline (tests/pypipe.test.ts checks every number against the gates). */
const M_COST = { base: 113438, withM: 145476 };
const GCD_M = { cycles: 225, instr: 77, divide: 108 };
const DIV_LINE = 9;
const SPEEDUPS = [{ id: 'gcd', x: 2409 / 225 }, { id: 'digits', x: 3922 / 422 }, { id: 'isprime', x: 12359 / 1106 }, { id: 'matmul', x: 1682 / 890 }];

export const chMulDiv: Chapter = {
  id: 'muldiv', num: numOf('muldiv'), title: 'Multiply & divide', level: 'Arithmetic',
  blurb: 'Array and Wallace-tree multipliers, Baugh–Wooley and Booth, restoring, non-restoring and SRT division, and the M extension in the single-cycle and pipelined CPUs.',
  goals: [
    'reduce a column of partial products with 3:2 carry-save rows and say why the tree\'s depth grows with log n, the array\'s with n',
    'make one multiplier serve signed and unsigned operands, and say at what width Booth recoding starts to pay',
    'compare restoring, non-restoring and SRT division by step delay and number of cycles',
    'count what a multiply and a divide cost a program on the single-cycle and pipelined CPUs',
  ],
  builds: ['adders', 'fastadd', 'pipeline', 'python', 'io'],
  recap: {
    keep: [
      `Compiled for RV32IM (chapter ${numOf('python')}'s compiler), a program with variable <code>*</code>, <code>//</code> or <code>%</code> loses its routines: gcd falls from 2409 cycles to 225 on the pipeline for 28 % more gates; a program without them gains nothing.`,
      'A partial product is <code>a AND b<sub>i</sub></code>. The array adds the rows with ripple adders: n² cells, and a depth that grows with n (70 NAND delays at 8×8, about 310 at 32×32).',
      'A row of unconnected full adders turns three words into two (x + y + z = s + 2c) in one full-adder delay. A Wallace tree of them leaves a single carry-propagate adder: a 32×32 tree multiplier is about as deep as one 32-bit ripple adder.',
      'Signed operands: Baugh–Wooley inverts the partial products that pair a sign bit with a normal bit and adds one constant. Radix-4 Booth halves the rows, but at 8 bits it is larger and deeper (1062 NANDs and 47 delays, against 972 and 40); it is smaller from 24 bits (7436 against 7706; 12 658 against 13 293 at 32), though still deeper.',
      'Division is serial: each quotient bit needs the previous remainder. Non-restoring makes every step "add ±d"; SRT keeps the remainder in carry-save form and picks each digit from its top bits (14 NAND delays at any width). Radix 4 makes two bits a step: 19 cycles of 44 delays for 32 bits, against 34 of 31.',
      'On the single-cycle CPU a divide takes 34 cycles: one in twenty instructions gives CPI 2.65. In the pipeline the multiply ends in M, so a dependent instruction stalls once, exactly as after a load.',
    ],
    practise: ['o_mulseq', 'o_mularr', 'o_mcore', 'o_div', 'o_dcore'],
    check: [
      {
        question: 'A Wallace tree reduces 8 partial-product words to 2 with 3:2 rows. How many full-adder levels does that take?',
        options: ['4', '3', '7'],
        answer: 0,
        explain: 'Each level turns every three words into two: 8 → 6 → 4 → 3 → 2. Then one fast adder adds the last two words.',
        why: ['', 'Three levels would halve the rows each time (8 → 4 → 2 → 1), as a tree of two-input adders does. A 3:2 row keeps two words for every three.', 'Seven is the array: one adder per row after the first, each waiting for the one before.'],
      },
      {
        question: 'In non-restoring division a step leaves a negative remainder. What does the next step do?',
        options: ['Adds the divisor to twice the remainder', 'Puts the old remainder back, then subtracts the divisor from twice it', 'Subtracts the divisor from twice the remainder', 'Nothing: the division ends with quotient bit 0'],
        answer: 0,
        explain: '2(r − d) + d = 2r − d: the same subtraction the restoring divider would have made after restoring. The quotient bit is still "is the new remainder ≥ 0".',
        why: ['', 'That is restoring division. Non-restoring drops the restore multiplexer by never putting the old remainder back.', 'Subtracting from a negative remainder moves it further from the range; the sign says which way to correct.', 'Every step runs. A negative remainder only changes the next operation and, after the last step, triggers one correction.'],
      },
      {
        question: 'Why can an SRT divider choose each quotient digit from only the top four bits of its remainder?',
        options: [
          'With digits −1, 0 and +1 the regions overlap: near zero either neighbouring digit keeps the remainder in range, and a later digit corrects the error',
          'The low bits of the remainder are always zero',
          'Because the divisor is normalized, the low bits of the remainder cannot change the digit',
          'It cannot: each step adds the full-width remainder first',
        ],
        answer: 0,
        explain: '+1 is correct anywhere in [0, 2d) and −1 anywhere in [−2d, 0). An estimate that is low by just under 1 still lands in a region whose digit is allowed, so no full-width carry is needed.',
        why: ['', 'The low bits carry real information. They stop mattering for the choice only because a slightly wrong digit is repaired by later ones.', 'Normalization fixes the thresholds, but with only the digits 0 and 1 the choice would still need the exact sign of the full remainder.', 'That full-width carry chain is what SRT removes: the remainder stays as a sum word and a carry word.'],
      },
      {
        question: '<code>div</code> and <code>rem</code> with rs1 = −2³¹ (0x80000000) and rs2 = −1. What does RISC-V specify?',
        options: ['Quotient 0x80000000 (−2³¹ again), remainder 0, and no trap', 'An overflow exception', 'Quotient 0x7FFFFFFF, saturated', 'Nothing: the result is implementation-defined'],
        answer: 0,
        explain: 'The true quotient +2³¹ does not fit in 32 bits, so it wraps to 0x80000000; the remainder is 0. RISC-V specifies it, as it specifies division by zero, so that division never traps (x86\'s idiv raises a divide error here). This M unit gets it for free: it divides 2³¹ by 1 unsigned, the signs agree so nothing is negated, and 2³¹ read as signed is −2³¹.',
        why: ['', 'RISC-V has no integer arithmetic exceptions at all: overflow, like division by zero, gives a specified result.', 'Saturation would need a comparator and a constant the spec never asks for; the quotient simply wraps.', 'The spec fixes the result exactly, so every core and the golden model agree.'],
      },
    ],
  },
  parts: [['Shift and add', 3], ['Carry-save and trees', 5], ['Booth and pipelining', 5], ['Dividing', 4], ['Faster dividers', 4], ['In the CPU', 5]],
  steps: [
    {
      title: 'Long multiplication is AND and add',
      body: `
        <p>RV32I, the instruction set every CPU so far runs, has no multiply or divide. <a href="#/c/python/0">Chapter 15</a>'s compiler turns <code>a * b</code>
        into <code>rt.mul</code>, a loop of shift and add over the multiplier's bits: five or six instructions a pass, up to 32 passes, up to about 200 cycles for one
        product, and a divide takes a loop of its own. The M extension adds eight instructions (<code>mul</code>, <code>mulh</code>, <code>mulhsu</code>,
        <code>mulhu</code>, <code>div</code>, <code>divu</code>, <code>rem</code>, <code>remu</code>) and leaves the work to the hardware. This chapter builds that
        hardware, first the obvious way, then faster ways, each priced in NANDs and delays, and ends by putting it in the CPUs.</p>
        <p>Binary long multiplication is simpler than the decimal kind you learned at school, because every digit of the multiplier is 0 or 1.
        Row i is either a (shifted i places) or zero, so it is <strong>a AND b<sub>i</sub></strong>: one AND gate per bit, called a <span data-show="pp0 pp1 pp2 pp3"><em>partial product</em></span>.</p>
        <p>Then add the rows. This 4×4 <strong>array multiplier</strong> <span data-show="add1 add2 add3">adds row i</span> to the running sum shifted right one place. The bit that
        falls off the bottom of each row is final: product bit i.</p>
        <p>The product of two n-bit numbers has 2n bits: (2<sup>n</sup> − 1)² = 2<sup>2n</sup> − 2<sup>n+1</sup> + 1 still fits, so nothing is ever lost. The cost is n² AND
        gates for the partial products and n − 1 adders of n bits for the sum: here ${nd(arrayMul(4))} NANDs, and ${dp(arrayMul(4))} gate delays from an input to the slowest product bit.
        Both numbers grow quickly with n, and the next steps attack them one at a time.</p>
        <div class="try">Open a row (a·b<sub>i</sub>) to see the AND gates, and an adder to see the full adders.</div>`,
      scene: () => ({ root: arrayMul(4), inputs: { a: 11, b: 13 } }),
      tour: {
        beats: [
          { title: 'Rows from the multiplier bits', show: ['pp0', 'pp1', 'pp2', 'pp3'], expect: { p: 143 },
            say: '<p>a = 1011 (11) times b = 1101 (13). Bits b0, b2 and b3 are 1, so those rows are a itself (shifted 0, 2 and 3 places); b1 is 0, so its row is all zeros. The sum is {v:p} = {b:p}.</p>' },
          { title: 'Add them as you go', show: ['add1', 'add2', 'add3'], expect: { p: 143 },
            say: '<p>Each adder takes the next row and the running sum shifted right one place. The bit that falls off the bottom is final: p0 first, then p1, and so on.</p>' },
          { title: 'One row only', set: { b: 1 }, show: ['pp0'], expect: { p: 11 },
            say: '<p>With b = 1 only row 0 is non-zero: the product is a, {v:p}. Multiplying by one is an AND gate and no addition.</p>' },
          { title: 'The largest product', set: { a: 15, b: 15 }, show: ['pp0', 'pp1', 'pp2', 'pp3'], expect: { p: 225 },
            say: '<p>15 × 15 = {v:p} = {b:p}: all four rows are a, and the result still fits in 8 bits.</p>' },
        ],
      },
      more: {
        derive: `<p>With b = Σ b<sub>i</sub>·2<sup>i</sup>, a·b = Σ (a·b<sub>i</sub>)·2<sup>i</sup>: row i is a AND b<sub>i</sub>, weighted 2<sup>i</sup>. Summing n rows with n − 1
          adders gives n² AND gates plus (n − 1)·n full adders, and a carry that can ripple along a row and then down the staircase (the path of "The array is slow").</p>`,
        pitfall: `<p>Reading p as n bits. Both operands being 4-bit does not make the product 4-bit: 15 × 15 needs all 8 output bits. A program that keeps only the low
          half (RISC-V <code>mul</code>) discards the rest on purpose; <code>mulh</code> exists to read it.</p>`,
        numbers: `<table class="mini"><tr><th>array</th><th>NANDs</th><th>delays</th></tr>
          <tr><td>4 × 4</td><td>${sp(nd(arrayMul(4)))}</td><td>${dp(arrayMul(4))}</td></tr>
          <tr><td>8 × 8</td><td>${sp(nd(arrayMul(8)))}</td><td>${dp(arrayMul(8))}</td></tr></table>`,
      },
      challenge: {
        kind: 'reach', goal: 'Make the product 0xE1 (225).',
        check: (st) => st.value('p') === 225,
        hints: [
          '225 is odd, so both operands are odd. Factor it.',
          'Both factors must fit in 4 bits, so neither may exceed 15. 225 = 9 × 25 does not qualify.',
        ],
        answer: 'a = b = 15: 15 × 15 = 225 = 0xE1. (225 is also 9 × 25, but 25 does not fit in 4 bits.)',
        solve: (st) => st.setInputs({ a: 15, b: 15 }),
      },
    },
    {
      title: 'Or reuse one adder',
      body: `
        <p>The cheapest multiplier has one adder and does the rows one per clock. A 2n-bit <span data-show="rh rl">product register</span> starts as {0, b}. Each cycle, if its
        lowest bit is 1 <span data-show="add">the adder</span> adds <span data-show="ra">a</span> to the upper half, and the whole register shifts right one place, the adder's carry entering at the top.
        The multiplier bits leave at the bottom as product bits come in. After n cycles the register holds a·b.</p>
        <p>8 bits: ${nd(seqMul(8))} NANDs and 10 cycles (load, 8 steps, done), against 1 cycle for an array of about the same size (${nd(arrayMul(8))} NANDs) at 8 bits; the array grows as n², the sequential unit as n. It is the multiply of
        microcontrollers without a hardware multiplier, done in software with the same loop.</p>
        <p>Why it works: the register holds 2n bits, and every cycle trades one multiplier bit for one product bit. The low half starts as b; shifting right moves the bit just
        used out of the way and makes room at the top for the adder's result. Nothing is stored twice, so no separate multiplier register is needed. What it costs is time: the
        clock must cover one n-bit carry-propagate addition, and the product takes n + 2 of them, so time per product is roughly n times the period of one adder.</p>
        <div class="try">start = 1 is set. Pulse the clock and watch p fill from the top as b drains out of the bottom.</div>`,
      scene: () => ({ root: seqMul(8), inputs: { a: 13, b: 11, start: 1, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Power on', reset: true, show: ['rh', 'rl'], expect: { p: 0, busy: 0, done: 0 },
            say: '<p>Nothing has happened: p = {v:p}. a = 13 (1101) is the multiplicand, b = 11 (1011) the multiplier, and start is held high.</p>' },
          { title: 'Load', cycles: 1, show: ['rh', 'rl'], expect: { p: 11, busy: 1 },
            say: '<p>The first edge loads the register with {0, b}: the upper half is zero, the lower half is b. p = {v:p}.</p>' },
          { title: 'First step', cycles: 1, show: ['add', 'ra', 'rh', 'rl'], expect: { p: 1669 },
            say: '<p>The lowest bit of the register is 1, so the adder adds a = 13 into the upper half, and everything shifts right one place. p = {v:p} = 13 · 128 + 5: a sits in the top, and the low half now holds the three bits of b still to come, with the carry entering at the top.</p>' },
          { title: 'Seven more steps', cycles: 7, show: ['rh', 'rl'], expect: { p: 143, done: 1 },
            say: '<p>Each cycle either adds a or just shifts. After the eighth step the register holds a · b = {v:p} and done = {v:done}.</p>' },
        ],
      },
      more: {
        derive: `<p>Step k (k = 0 … n − 1) adds b<sub>k</sub>·a into the upper half, which sits at weight 2<sup>n</sup> of the register, and then the register shifts right. That addend is shifted
          n − k times in all (its own step's shift and every later one), so it ends at weight 2<sup>n</sup> / 2<sup>n−k</sup> = 2<sup>k</sup>: exactly row k of the array. The bits of b that leave at the bottom
          are the same bits the steps consumed. The sum is the same as the array's; only the order of work moved from space to time.</p>`,
        pitfall: `<p>Dropping the carry out of the adder. The sum of the upper half and a can be n + 1 bits wide, and that carry is the top bit of the shifted register. Without it a product such as 255 × 255 comes out wrong although 13 × 11 does not.</p>`,
        numbers: `<table class="mini"><tr><th>8 bits</th><th>NANDs</th><th>cycles</th></tr>
          <tr><td>shift and add</td><td>${sp(nd(seqMul(8)))}</td><td>10</td></tr>
          <tr><td>array</td><td>${sp(nd(arrayMul(8)))}</td><td>1 (${dp(arrayMul(8))} delays long)</td></tr></table>`,
      },
      challenge: {
        kind: 'reach', goal: 'Clock the multiplier until done = 1, with p = 143 (13 × 11).',
        check: (st) => st.value('done') === 1 && st.value('p') === 143,
        hints: [
          'Each pulse is one cycle. The first loads {0, b}; after that each cycle consumes one bit of b.',
          'Count the bits of b, add the load cycle, and watch done on the last pulse.',
        ],
        answer: 'Nine pulses: one load, eight shift-and-add steps, then done is high for one cycle.',
        solve: (st) => { st.runCycles(9); },
      },
    },
    {
      title: 'The array is slow',
      body: `
        <p>At 8×8 the array is <span data-show="add1 add2 add3 add4 add5 add6 add7">seven ripple-carry adders</span> stacked in a staircase. The worst path ripples along a row, drops into the next, and ripples again.
        That makes ${dp(arrayMul(8))} NAND delays, against ${dp(rca(8))} for one 8-bit ripple adder. At 32×32 it is about ${ARR32}, more than twice the single-cycle CPU's entire clock period.</p>
        <p>Adding a row costs a whole adder's delay, and adding a bit to the width lengthens every adder, so a path along a row and down the staircase gains a row and a cell for each extra bit. The measured depth of 4×4 is
        ${dp(arrayMul(4))} and of 8×8 ${dp(arrayMul(8))}: ${ARR_SLOPE} more per bit of width. That is linear in n, not quadratic, because the path never visits every cell: it takes the longest
        diagonal. Area is n²; time is n.</p>
        <div class="try">Slow motion is on. Change b from 0x01 to 0xFF and watch the activity spread down the staircase.</div>`,
      scene: () => ({ root: arrayMul(8), inputs: { a: 0xff, b: 0x01 }, animate: true }),
      tour: {
        beats: [
          { title: 'b = 1: one row', expect: { p: 255 },
            say: '<p>a = 255, b = 1. Only the first partial product is non-zero, so every adder below it adds zero and the product is a: {v:p}.</p>' },
          { title: 'b = 255: every row', set: { b: 255 }, show: ['add1', 'add2', 'add3', 'add4', 'add5', 'add6', 'add7'], expect: { p: 65025 },
            say: '<p>All eight rows are now a. Each adder has a real carry to pass, and the new values travel down the staircase one adder after another before p settles at {v:p} (255², {b:p}).</p>' },
          { title: 'b = 0: it empties again', set: { b: 0 }, expect: { p: 0 },
            say: '<p>With b = 0 every partial product is 0 and so is every sum: p = {v:p}. The same wave runs the other way, again as slowly.</p>' },
        ],
      },
      more: {
        derive: `<p>The time has two parts: a carry rippling along a row, about n full-adder delays, and the staircase, one adder per row. The two measured depths, ${dp(arrayMul(4))} at n = 4 and ${dp(arrayMul(8))} at n = 8,
          fit ${ARR_SLOPE}·n − ${ARR_B} exactly; extrapolated to 32 bits that is ${ARR32}. A 32-bit ripple adder alone is ${dp(rca(32))} delays long, so the array takes about ${(ARR32 / dp(rca(32))).toFixed(1)} times one carry chain.</p>`,
        pitfall: `<p>Counting gates instead of the path. The array has about n² full adders, but only the chain along one diagonal sets the delay. Watch it in slow motion: most of the circuit has already settled when the last carries arrive.</p>`,
      },
      actions: [{ label: 'b: 0x01 ↔ 0xFF', run: (st) => st.setInputs({ b: st.getInput('b') === 1 ? 0xff : 1 }) }],
    },
    {
      title: 'Carry-save: add three, keep two',
      body: `
        <p>The trick is to stop propagating carries. A <span data-show="fa0 fa1 fa2 fa3">row of full adders</span> with nothing connected between neighbours takes <strong>three</strong>
        numbers and returns <strong>two</strong>: the <span data-show="pin:s">sum bits</span> and the <span data-show="pin:c">carry bits</span> (worth twice as much). x + y + z = s + 2c,
        exactly, in a single full-adder delay at any width. This is a <em>carry-save adder</em>, or 3:2 compressor.</p>
        <p>Only the very last addition needs a real carry-propagate adder.</p>
        <p>Why it is exact: a full adder computes x + y + z = s + 2c for one column, with s the bit that stays and c the bit that belongs one column up. Wire n of them side by side and
        feed each one's c, unadded, to the next column as part of a second word. No carry ever goes through another adder in the same level, so the delay is one full adder,
        ${dp(csa(4))} NAND delays, at 4 bits and at ${dp(csa(32))} at 32. The price is that the answer is now two words, and someone has to add them.</p>`,
      scene: () => ({ root: csa(4), inputs: { x: 5, y: 6, z: 7 } }),
      tour: {
        beats: [
          { title: 'Three in, two out', show: ['fa0', 'fa1', 'fa2', 'fa3'], expect: { s: 4, c: 7 },
            say: '<p>5 + 6 + 7 = 18. The row returns s = {v:s} and c = {v:c}, and s + 2c = {v:s} + 2 · {v:c} = 18. Nothing was added across columns: each full adder looked only at its own three bits.</p>' },
          { title: 'All ones', set: { x: 1, y: 1, z: 1 }, expect: { s: 1, c: 1 },
            say: '<p>1 + 1 + 1 = 3 = 1 + 2 · 1: only column 0 is active, with s = {v:s} and a carry of {v:c} that waits in the carry word for column 1.</p>' },
          { title: 'Full width, same delay', set: { x: 15, y: 15, z: 15 }, expect: { s: 15, c: 15 },
            say: '<p>45 = 15 + 2 · 15. Every column carries, and still nothing ripples: the delay is the same as for the single column above.</p>' },
        ],
      },
      more: {
        derive: `<p>Per column, s<sub>i</sub> = x<sub>i</sub> ⊕ y<sub>i</sub> ⊕ z<sub>i</sub> and c<sub>i</sub> = maj(x<sub>i</sub>, y<sub>i</sub>, z<sub>i</sub>), with x<sub>i</sub> + y<sub>i</sub> + z<sub>i</sub> = s<sub>i</sub> + 2c<sub>i</sub>.
          Summing over i with weights 2<sup>i</sup>: x + y + z = Σ s<sub>i</sub>2<sup>i</sup> + Σ c<sub>i</sub>2<sup>i+1</sup> = s + 2c. The compressor costs ${nd(csa(4))} NANDs at 4 bits (n full adders) and ${dp(csa(4))} delays, for any n.</p>`,
        pitfall: `<p>Adding s and c at the same weight. The carry word is worth twice its bit positions: s + c is not the sum, s + 2c is. In hardware the shift is only a wiring offset (c<sub>i</sub> feeds column i + 1), so nothing marks it on the schematic.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'x = 5, y = 6, z = 7. The CSA outputs s = 4 and c = 7. What is x + y + z?',
        options: ['11', '18', '4 + 7 = 11 with a carry lost', '25'], answer: 1,
        explain: 'c has weight 2: x + y + z = s + 2c = 4 + 14 = 18. Nothing is lost, only postponed: the carries are kept in a separate word instead of being propagated.',
        why: ['That adds s and c at equal weight. Each carry bit leaves its column for the one above, so the carry word counts twice.', '', 'Nothing is lost: every carry is in c. It has only not been added in yet.', 'That adds c on top of x + y + z. The two outputs replace the three inputs: s + 2c is the whole sum.'],
      },
    },
    {
      title: 'Counting ones',
      deep: true,
      body: `
        <p>A full adder is also a <em>counter</em>: it turns three bits of equal weight into a 2-bit count of how many are 1. That is why
        it is called a 3:2 counter as well as a 3:2 compressor. Counting all the ones in a word (<strong>population count</strong>,
        RISC-V's <code>cpop</code> in the Zbb extension) is the same problem as summing a column of partial products.</p>
        <p>This version is the plain recursive one: <span data-show="lo hi">count each half</span>, add the two counts with a small ripple adder. The count gains a
        bit per level: ${nd(popcount(8))} NANDs and ${dp(popcount(8))} gate delays for 8 bits, ${nd(popcount(32))} NANDs and ${dp(popcount(32))} delays for 32.</p>
        <p>The link to multiplication: a column of partial products of the same weight is exactly this problem, counting ones. A multiplier reduces all columns at once with full adders; this circuit
        counts one column of n bits. Doing it recursively costs a carry-propagate adder at every level, but small ones: the whole 32-bit circuit is ${dp(popcount(32))} delays, less than the carry-save version of the quiz, whose levels alone are 48. Carry-save pays when many wide words are added, not for one column.</p>
        <div class="try">Open <span data-show="add">the top adder</span>: it adds two 3-bit counts of the two nibbles.</div>`,
      scene: () => ({ root: popcount(8), inputs: { x: 0xb7 } }),
      tour: {
        beats: [
          { title: 'Two halves', show: ['lo', 'hi'], expect: { c: 6 },
            say: '<p>x = 10110111 has six ones. The low nibble 0111 has three, the high nibble 1011 three more; each half counts its own.</p>' },
          { title: 'Add the counts', show: ['add'], expect: { c: 6 },
            say: '<p>The top adder adds the two 3-bit counts: 3 + 3 = {v:c}. Four bits of output are enough because 8 ones need 1000, the largest count.</p>' },
          { title: 'All ones', set: { x: 255 }, show: ['lo', 'hi', 'add'], expect: { c: 8 },
            say: '<p>With x = 255 each half counts 4 and the sum is {v:c}: the count needs a fourth bit.</p>' },
          { title: 'None', set: { x: 0 }, expect: { c: 0 },
            say: '<p>No ones: c = {v:c}. Counting is a sum of eight one-bit numbers, which is what makes the full adder a 3:2 counter.</p>' },
        ],
      },
      more: {
        derive: `<p>Count(n) = Count(n/2) + Count(n/2), each count of width ⌈log₂(n/2 + 1)⌉ bits, plus one adder of that width. The adder widths grow by one per level, so total adder work is Σ over levels of
          (n / 2<sup>k</sup>)·(k + 1) bit-adds, which is O(n). The depth, ${dp(popcount(8))} delays at 8 bits and ${dp(popcount(32))} at 32, is the sum of the ripple delays down the levels.</p>`,
        pitfall: `<p>Sizing the output to log₂ n bits. The count of n ones is n itself, so an 8-bit input needs the value 8 (four bits), not 3. A count field one bit short wraps all-ones to 0, which only shows on the single input 255.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'The 32-bit popcount is 35 gate delays deep. A carry-save version compresses all 32 bits with full adders first. Roughly how deep would that tree be before the final adder?',
        options: ['8 full-adder levels (each keeps two rows of every three)', '32 levels, one per bit', '1 level', '5 levels exactly, like a binary tree'],
        answer: 0,
        explain: 'Each 3:2 level shrinks the number of rows by about 1.5: log₁.₅(16) ≈ 6.8. Rows come whole, so it takes 8: 32 → 22 → 15 → 10 → 7 → 5 → 4 → 3 → 2, then one fast adder. Same structure as the Wallace multiplier.',
        why: ['', 'One level per bit would be a serial chain. The full adders of one level work on disjoint bits at the same time.', 'One level only turns every three rows into two: 32 rows become 22.', 'A binary tree halves the rows each level. A 3:2 level keeps two of every three, so it needs more levels than log₂ 32.'],
      },
    },
    {
      title: 'The Wallace tree',
      body: `
        <p>Now produce <span data-show="pp0 pp1 pp2 pp3 pp4 pp5 pp6 pp7"><em>all</em> partial products</span> at once, and feed them to
        <span data-show="L0_0 L0_1 L1_0 L1_1 L2_0 L3_0">layers of compressors</span>: 8 words → 6 → 4 → 3 → 2 in four levels,
        each one full-adder delay. <span data-show="cpa">One fast adder</span> (the Kogge–Stone from <a href="#/c/fastadd/0">chapter ${numOf('fastadd')}</a>) adds the last two words.</p>
        <p>Each compressor row only builds the columns its three words actually cover: full adders where three bits meet,
        half adders where two do, plain wires elsewhere. This is the Wallace tree; Dadda's variant schedules the same cells a little more
        cleverly, using fewer half adders.</p>
        <p>The depth falls out of one rule: each level turns every three words into two, so r rows become r − ⌊r/3⌋. For 8 partial products that is ${wallace(8)}, four levels of one full adder each,
        ${dp(treeMul(8))} NAND delays for the whole 8×8 multiplier including the final adder (the array: ${dp(arrayMul(8))}). For 32 rows it is ${wallace(32)}: ${wallace(32).split('→').length - 1} levels, growing as log<sub>1.5</sub> n.</p>
        <div class="try">Open a 3:2 block to see which columns it reduces.</div>`,
      scene: () => ({ root: treeMul(8), inputs: { a: 0xb7, b: 0x5d } }),
      tour: {
        beats: [
          { title: 'Eight rows at once', show: ['pp0', 'pp1', 'pp2', 'pp3', 'pp4', 'pp5', 'pp6', 'pp7'], expect: { p: 17019 },
            say: '<p>183 × 93: the eight partial products are formed in parallel, one AND gate deep. Eight rows is the problem; the answer {v:p} is 16 bits.</p>' },
          { title: 'Level 1: 8 → 6', show: ['L0_0', 'L0_1'], expect: { p: 17019 },
            say: '<p>Two compressors take six of the eight rows and return four; the other two rows wait. Six rows remain.</p>' },
          { title: 'Level 2: 6 → 4', show: ['L1_0', 'L1_1'], expect: { p: 17019 },
            say: '<p>Two more: four rows left. Every compressor in a level works at the same time, so the level costs one full-adder delay.</p>' },
          { title: 'Levels 3 and 4: 4 → 3 → 2', show: ['L2_0', 'L3_0'], expect: { p: 17019 },
            say: '<p>One compressor gives three rows, one more gives two. Four levels in all; no carry has travelled further than one column.</p>' },
          { title: 'One real addition', show: ['cpa'], expect: { p: 17019 },
            say: '<p>The last two words go to a fast carry-propagate adder. Its sum is the product: {v:p} = {b:p}.</p>' },
        ],
      },
      more: {
        derive: `<p>With r words, a level makes ⌊r/3⌋ groups of three into two words each and passes the remaining r mod 3 words through: r → r − ⌊r/3⌋. Starting from n rows,
          the number of levels L solves roughly n·(2/3)<sup>L</sup> ≤ 2, so L ≈ log<sub>1.5</sub>(n / 2): ${wallace(8).split('→').length - 1} levels for 8 rows, ${wallace(32).split('→').length - 1} for 32, ${wallace(64).split('→').length - 1} for 64.
          Each level is one full adder, ${dp(csa(4))} NAND delays, whatever the width.</p>`,
        real: `<p>Dadda's tree schedules the same cells later and uses fewer half adders. Industrial multipliers use 4:2 compressors (two full adders, but a path of three XORs instead of four) and lay the tree out with the
          wiring in mind, because the irregular wiring between levels, not the gates, tends to dominate area.</p>`,
        pitfall: `<p>Assuming the tree is smaller than the array. The tree is somewhat larger; what shrinks is the depth. At 8 bits the tree is ${nd(treeMul(8))} NANDs against ${nd(arrayMul(8))}, but ${dp(treeMul(8))} delays against ${dp(arrayMul(8))}.</p>`,
      },
    },
    {
      title: 'Cost versus speed',
      body: `
        <p>Measured from the netlists: the tree is somewhat larger than the array (${Math.round((nd(treeMul(8)) / nd(arrayMul(8)) - 1) * 100)} % at 8 bits, ${Math.round((nd(treeMul(32)) / nd(arrayMul(32)) - 1) * 100)} % at 32), but its depth grows with log n, not n.
        A 32×32 tree multiplier is about as deep as a single 32-bit ripple adder.</p>
        <p>At 8 bits the numbers are already clear: the array is ${nd(arrayMul(8))} NANDs and ${dp(arrayMul(8))} delays, the tree ${nd(treeMul(8))} and ${dp(treeMul(8))}. A modest ${Math.round((nd(treeMul(8)) / nd(arrayMul(8)) - 1) * 100)} % more gates
        buys a ${Math.round((1 - dp(treeMul(8)) / dp(arrayMul(8))) * 100)} % shorter path, and the gap widens with every bit. The table below measures the larger sizes.</p>`,
      widget: mulComparison,
      more: {
        numbers: `<table class="mini"><tr><th>8 × 8</th><th>NANDs</th><th>delays</th></tr>
          <tr><td>array</td><td>${sp(nd(arrayMul(8)))}</td><td>${dp(arrayMul(8))}</td></tr>
          <tr><td>Wallace tree</td><td>${sp(nd(treeMul(8)))}</td><td>${dp(treeMul(8))}</td></tr>
          <tr><td>tree, signed</td><td>${sp(nd(treeMul(8, true)))}</td><td>${dp(treeMul(8, true))}</td></tr>
          <tr><td>Booth tree</td><td>${sp(nd(boothMul(8)))}</td><td>${dp(boothMul(8))}</td></tr></table>`,
        pitfall: `<p>Reading depth as speed in a real design. The tree's irregular wiring is longer than the array's neighbour-to-neighbour links, and NAND delays here do not charge for wire. The ordering holds, but the margin shrinks in layout.</p>`,
      },
    },
    {
      title: 'Signed products: Baugh–Wooley',
      body: `
        <p>Two's complement gives the top bit a <em>negative</em> weight, so partial products that pair one sign bit with a normal bit are negative.
        Baugh and Wooley's trick: <strong>invert those bits</strong> (NAND instead of AND) and <span data-show="kbw">add the constant</span> 2<sup>n</sup> + 2<sup>2n−1</sup>.
        The tree and the adder do not change, and neither does the delay.</p>
        <p>Why it works: as a signed number, a = −a<sub>n−1</sub>2<sup>n−1</sup> + Σ a<sub>i</sub>2<sup>i</sup>. A partial product pairing a<sub>n−1</sub> with b<sub>j</sub> has weight −2<sup>n−1+j</sup>, a negative.
        Replacing a negative term −x by (1 − x) − 1 = ¬x − 1 turns it into an inverted bit minus a constant, and all those constants add up to one correction word.
        The cost is a handful of NANDs for ANDs and a constant row: ${nd(treeMul(8, true))} against ${nd(treeMul(8))} NANDs here, the same ${dp(treeMul(8, true))} delays.</p>
        <div class="try">a = 0xF9 is −7 and b = 3: the product reads 0xFFEB = −21. Open the rows: <span data-show="pp7">the last one</span> is almost all NANDs.</div>`,
      scene: () => ({ root: treeMul(8, true), inputs: { a: 0xf9, b: 3 } }),
      tour: {
        beats: [
          { title: 'A negative times a positive', show: ['pp0', 'pp1'], expect: { p: 65515 },
            say: '<p>a = 0xF9 = −7, b = 3. The 16-bit product is {v:p} = {b:p}, which as a signed number is −21. The first two rows are ordinary ANDs of a with b0 and b1.</p>' },
          { title: 'The sign row', show: ['pp7', 'kbw'], expect: { p: 65515 },
            say: '<p>Row 7 pairs b7 with every bit of a, and bit 7 of a (the sign) with every bit of b: those partial products are inverted, and the constant row <code>kbw</code> corrects for all of them at once.</p>' },
          { title: 'Same size, positive', set: { a: 7 }, expect: { p: 21 },
            say: '<p>With a = +7 the product is {v:p}. The value differs only in sign, though in two\'s complement most bits change; the extra logic is the same.</p>' },
          { title: 'Two negatives', set: { a: 128, b: 128 }, expect: { p: 16384 },
            say: '<p>−128 × −128 = +16384 = {v:p}, the largest product of two 8-bit signed numbers. Both inputs are the most negative value, and the sign-bit terms of row 7 and the correction constant cancel to leave a positive result.</p>' },
        ],
      },
      more: {
        derive: `<p>For n = 8 the negative terms are −a<sub>7</sub>b<sub>j</sub>2<sup>7+j</sup> (j &lt; 7), −a<sub>i</sub>b<sub>7</sub>2<sup>7+i</sup> (i &lt; 7); the product a<sub>7</sub>b<sub>7</sub>2<sup>14</sup> is positive. Writing −t·2<sup>k</sup> = (¬t)·2<sup>k</sup> − 2<sup>k</sup>
          each exponent k = 7 … 13 occurs twice, so the corrections total 2(2<sup>14</sup> − 2<sup>7</sup>) = 2<sup>15</sup> − 2<sup>8</sup>, and adding the negative of that, mod 2<sup>16</sup>, is the constant 2<sup>8</sup> + 2<sup>15</sup>: bits 8 and 15 of the correction row.</p>`,
        pitfall: `<p>Multiplying the n-bit patterns as unsigned, without extending them. That gets the low half right and the high half wrong, which is why <code>mulh</code> (the high half) is a different instruction from <code>mul</code>.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'RISC-V has mulh (signed × signed), mulhsu (signed × unsigned) and mulhu (unsigned × unsigned). How can one signed 33×33 multiplier do all three?',
        options: [
          'It cannot: it needs three multipliers',
          'Extend each 32-bit operand to 33 bits with its sign bit if that operand is signed, or with 0 if not',
          'Negate the result afterwards',
          'Use only the low 32 bits',
        ],
        answer: 1,
        explain: 'A 33-bit two\'s complement number can hold any signed or unsigned 32-bit value. Extend with a[31] for signed and 0 for unsigned, multiply as signed, and the 64-bit product is exact. This CPU\'s MUL32 does exactly that.',
        why: ['A 33-bit signed operand covers both ranges, so the three differ only in the operand\'s extension bit.', '', 'Negating fixes a sign, not a weight: an unsigned operand with its top bit set would still be read as negative.', 'The low 32 bits are the same for all three (that is <code>mul</code>). The mulh variants ask for the high half, which is where signedness shows.'],
      },
    },
    {
      title: 'Booth recoding',
      body: `
        <p>Fewer partial products means a shallower tree. <strong>Radix-4 Booth recoding</strong> scans the multiplier two bits at a time, with one bit of overlap,
        and turns each group into a digit from {−2, −1, 0, +1, +2}. Every digit selects an easy partial product: zero, a, 2a (a shift), or their negations
        (invert, plus one carried into the tree). So there are n/2 rows instead of n.</p>
        <p>This encoder is the logic for one digit: <span data-show="x1 x2">two XORs</span>, <span data-show="z">a NAND</span>,
        <span data-show="n2">an inverter</span> and <span data-show="a2 ng">two ANDs</span>.</p>
        <p>Why the digits are right: the group (b<sub>1</sub>, b<sub>0</sub>) with the bit below it, b<sub>−1</sub>, encodes −2b<sub>1</sub> + b<sub>0</sub> + b<sub>−1</sub>. A run of ones from bit i up to bit j is worth 2<sup>j+1</sup> − 2<sup>i</sup>, so
        it recodes as a +1 just above the run and a −1 at its bottom, and the digits inside the run are 0. Long runs of ones, which are the worst case for a plain multiplier, become cheap.
        The encoder is ${nd(BOOTH_ENC)} NANDs and ${dp(BOOTH_ENC)} gate delays.</p>
        <div class="try">Try 100 (−2) and 111 (0), then back to 011 (+2).</div>`,
      scene: () => ({ root: BOOTH_ENC, inputs: { b1: 0, b0: 1, bm: 1 } }),
      tour: {
        beats: [
          { title: '011: +2', expect: { one: 0, two: 1, neg: 0 },
            say: '<p>b1 b0 bm = 011 is −0 + 1 + 1 = +2: two = {v:two}, so the row is a shifted left once, and neg = {v:neg}.</p>' },
          { title: '100: −2', set: { b1: 1, b0: 0, bm: 0 }, expect: { one: 0, two: 1, neg: 1 },
            say: '<p>100 is −2 + 0 + 0 = −2. The row is 2a again, but neg = {v:neg} inverts it, and a +1 carried into the tree completes the negation.</p>' },
          { title: '111: zero', set: { b1: 1, b0: 1, bm: 1 }, expect: { one: 0, two: 0, neg: 0 },
            say: '<p>111 is −2 + 1 + 1 = 0: inside a run of ones, nothing is added. one and two are both {v:one}, and the row is all zeros.</p>' },
          { title: '101: −1', set: { b1: 1, b0: 0, bm: 1 }, expect: { one: 1, two: 0, neg: 1 },
            say: '<p>101 is −2 + 0 + 1 = −1: one = {v:one} and neg = {v:neg}, so the row is ¬a plus the carried 1.</p>' },
        ],
      },
      more: {
        derive: `<p>For multiplier b = Σ b<sub>i</sub>2<sup>i</sup> (two's complement), b = Σ<sub>j</sub> d<sub>j</sub>4<sup>j</sup> with d<sub>j</sub> = −2b<sub>2j+1</sub> + b<sub>2j</sub> + b<sub>2j−1</sub> (b<sub>−1</sub> = 0). Each d<sub>j</sub> is in {−2, …, +2}.
          Check: bit b<sub>2j</sub> appears once, at weight 4<sup>j</sup> = 2<sup>2j</sup>. Bit b<sub>2j+1</sub> appears in group j as −2·4<sup>j</sup> and again, as the overlap bit, in group j + 1 as +4<sup>j+1</sup>: together (−1 + 2)·2<sup>2j+1</sup> = 2<sup>2j+1</sup>. So every bit has its binary weight, except the top bit, which has no group above it and keeps −2<sup>n−1</sup>: the two's complement sign.</p>`,
        pitfall: `<p>Forgetting the overlap bit. Each group reads the top bit of the group below it (b<sub>−1</sub> = 0 for the lowest). Without it, 010 and 011 would be indistinguishable (both read as the pair 01), although they are +1 and +2.</p>`,
      },
    },
    {
      title: 'Booth, worked',
      body: `<p>Every 8-bit multiplier becomes four digits. Negative numbers need no special handling: the top group's overlap and weight are what make the sign bit work, and a multiplier of −7 recodes as the digits 0, 0, −2, +1
        (−2·4 + 1 = −7).</p>
        <p>Recoding is local: each digit depends on three bits, so all four are found at once, in the encoder's ${dp(BOOTH_ENC)} NAND delays. Runs of ones in the multiplier are where it helps, since each interior group of a run
        becomes a zero row. A multiplier like 0x7F (a run of seven ones) has two non-zero digits instead of seven non-zero bits. Drag the slider and watch how often a digit is zero.</p>`,
      widget: boothWidget,
      more: {
        derive: `<p>A run of ones from bit i to bit j is worth 2<sup>j+1</sup> − 2<sup>i</sup>, one addition and one subtraction instead of j − i + 1 additions. Radix-4 Booth finds the run ends two bits at a time: a digit is
          non-zero only where a group straddles the top (+) or bottom (−) of a run, or where the pair inside a group differs.</p>`,
        pitfall: `<p>Assuming Booth needs fewer additions on every input. Its row count is fixed at n/2 whatever b is; the saving is a guaranteed halving of rows, not skipping of zero rows. A multiplier of alternating bits (0x55) recodes to all non-zero digits.</p>`,
      },
    },
    {
      title: 'A Booth multiplier',
      body: `
        <p>Now the whole circuit. <span data-show="tree.pp">Each Booth encoder</span> turns three overlapping bits of b into a digit; each row picks 0, a or 2a (a wire shift) and
        inverts it for a negative digit. The +1 that completes a negation is added as a separate bit, and instead of sign-extending every row
        across the full width, each row's sign bit is inverted and one constant row corrects for all of them. Then the same
        <span data-show="tree.rd">3:2 tree</span> and <span data-show="cpa">fast adder</span>.</p>
        <p>Measured honestly: at 8 bits the Booth version is ${sp(nd(boothMul(8)))} NANDs and ${dp(boothMul(8))} delays deep, against ${nd(treeMul(8, true))} and ${dp(treeMul(8, true))} for Baugh–Wooley. Each Booth bit
        is a select and an XOR instead of one AND, and the encoders sit in front of everything. Halving the rows pays in NANDs somewhere between 16 and 24 bits (${sp(nd(boothMul(24)))} against ${sp(nd(treeMul(24, true)))} at 24, ${sp(nd(boothMul(32)))} against ${sp(nd(treeMul(32, true)))} at 32), and more at 64, which is where real designs use it: fewer rows also means less wiring and power. It stays about 7 delays deeper at every width built here, because of the encoders in front.</p>
        <div class="try">Open a row and a <code>BIT</code> cell. Then set b = 0x80 (−128): one digit of −2, the others 0.</div>`,
      scene: () => ({ root: boothMul(8), inputs: { a: 0xf9, b: 100 } }),
      tour: {
        beats: [
          { title: 'Four rows, not eight', show: ['tree'], expect: { p: 64836 },
            say: '<p>a = −7, b = 100 = 01100100. Booth recodes b into four digits, so the tree reduces four rows plus corrections. The product is {v:p} = {b:p}, which is −700 as a signed 16-bit number.</p>' },
          { title: 'A single −2', set: { b: 128 }, show: ['tree'], expect: { p: 896 },
            say: '<p>b = 0x80 = −128. Its top group 10|0 is the digit −2 and the other three are 0: one non-zero row. −7 × −128 = {v:p}.</p>' },
          { title: 'Two negatives', set: { a: 128 }, show: ['tree', 'cpa'], expect: { p: 16384 },
            say: '<p>−128 × −128 = {v:p}: the same single −2 digit applied to a = −128, and the final adder produces +16384 with no special case for the sign.</p>' },
        ],
      },
      more: {
        derive: `<p>The row for digit d<sub>j</sub> is d<sub>j</sub>·a·4<sup>j</sup>. For d = ±1 it is ±a (select a, invert for −), for ±2 it is a shifted left one place, for 0 nothing. The negation −x = ¬x + 1 needs a +1 at the row's lowest bit,
          which is why each row brings a separate neg bit into the tree. The sign-extension trick of the quiz adds the constant that makes the inverted sign bits right.</p>`,
        pitfall: `<p>Counting only the rows. Four Booth rows need four extra neg bits, an encoder per digit and a select-plus-XOR per bit; at 8 bits that overhead outweighs the saved rows (${sp(nd(boothMul(8)))} NANDs against ${nd(treeMul(8, true))}).</p>`,
        numbers: `<table class="mini"><tr><th>signed multiplier</th><th>8 bits</th><th>32 bits</th></tr>
          <tr><td>Baugh–Wooley tree: NANDs</td><td>${sp(nd(treeMul(8, true)))}</td><td>${sp(nd(treeMul(32, true)))}</td></tr>
          <tr><td>Booth radix 4: NANDs</td><td>${sp(nd(boothMul(8)))}</td><td>${sp(nd(boothMul(32)))}</td></tr>
          <tr><td>Baugh–Wooley: delays</td><td>${dp(treeMul(8, true))}</td><td>${dp(treeMul(32, true))}</td></tr>
          <tr><td>Booth: delays</td><td>${dp(boothMul(8))}</td><td>${dp(boothMul(32))}</td></tr></table>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why invert each row\'s sign bit and add a constant, instead of sign-extending the rows?',
        options: [
          'A sign-extended row needs copies of its sign bit across the whole width, so many more adder cells; ¬s and one shared constant give the same sum',
          'Sign extension gives the wrong answer for negative digits',
          'The constant is needed for the +1 of negative digits',
          'It makes the multiplier unsigned',
        ],
        answer: 0,
        explain: 'A two\'s-complement row with sign s equals the row with ¬s in the sign position, minus 2^(sign position). Every row\'s correction is a fixed number, so they add up to one constant row computed in advance. The +1 bits of negative digits are a separate matter.',
        why: ['', 'Sign extension gives the right answer, only at a price: each row\'s sign copied up to the top of the product, through adder cells of its own.', 'The +1 that completes a negation is a separate bit per row. The constant only corrects the inverted sign bits.', 'The product is still signed: the constant row is the exact correction for the inverted sign bits.'],
      },
    },
    {
      title: 'Pipelining the multiplier',
      deep: true,
      body: `
        <p>A tree multiplier is one long combinational path. Put registers inside it, <span data-show="u4 u5 u6 u7 u8">after the Booth rows</span>
        and <span data-show="u10 u11">after the 3:2 tree</span>, and each clock
        only has to cover one stage. 16 bits: the period drops from ${between(boothMul(16))} to ${period(pipeMul(16))} NAND delays. Each product now takes four edges to come out (latency),
        but a new one can start every cycle (throughput). The price is about twice the area: ${sp(nd(pipeMul(16)))} NANDs against ${sp(nd(boothMul(16)))}, because the registers hold every row and both tree outputs.</p>
        <p><span data-show="u9">The tree</span> is the slowest stage. A deeper pipeline would cut it in the middle; real cores use 3 to 5 multiplier stages and keep the
        integer pipeline busy with other instructions meanwhile.</p>
        <div class="try">Pulse the clock with new a and b each time: p shows the product of the operands from four edges earlier.</div>`,
      scene: () => ({ root: pipeMul(8), inputs: { a: 12, b: 11, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Operands go in', reset: true, show: ['u4', 'u5'], expect: { p: 0 },
            say: '<p>a = 12, b = 11 are applied. The first stage (Booth rows) is still empty: p = {v:p}.</p>' },
          { title: 'Four edges', cycles: 4, expect: { p: 132 },
            say: '<p>After four edges the product 12 × 11 = {v:p} appears. Each edge moved the operands one stage further: rows, tree, final sum, output. The values on p in between are not products, only stages in transit.</p>' },
          { title: 'New operands, old product', set: { a: 3, b: 5 }, cycles: 3, expect: { p: 132 },
            say: '<p>3 × 5 is now in the pipeline, three stages in. p still shows the previous result, {v:p}: the new product has not come out yet.</p>' },
          { title: 'The fourth edge', cycles: 1, expect: { p: 15 },
            say: '<p>One edge later p = {v:p} = 3 × 5. Four edges of latency; a new pair could have been applied at every one of them, and each product would have come out one edge after the last.</p>' },
        ],
      },
      more: {
        derive: `<p>Throughput is one product per period, latency is stages × period. At 16 bits the pipelined unit has a period of ${period(pipeMul(16))} and a latency of 4 × ${period(pipeMul(16))} = ${4 * period(pipeMul(16))} delays, against ${between(boothMul(16))} for the
          combinational version. The pipeline wins when products stream and loses (by ${4 * period(pipeMul(16)) - between(boothMul(16))} delays each) when each product waits for the last.</p>`,
        pitfall: `<p>Reading p on the wrong edge. The output after one pulse is the product of operands applied four pulses ago, not of the current a and b; compare p with the inputs that were present four edges earlier.</p>`,
      },
    },
    {
      title: 'Four ways to multiply',
      deep: true,
      body: `
        <p>The same 16×16 product, four circuits. The table lists area, clock period, latency and the time between results; the bars compare the time per product when products stream.</p>
        <p>Read it as a trade of three quantities. The iterative unit is smallest and slowest: ${sp(nd(seqMul(16)))} NANDs and 18 cycles per product. The two trees finish in one (long) cycle. The pipelined unit keeps the Booth tree's
        throughput at a ${period(pipeMul(16))}-delay clock. Which is best depends on whether products depend on each other.</p>`,
      widget: mulStyles,
      more: {
        pitfall: `<p>Comparing periods alone. The pipeline has the shortest clock, the iterative unit one nearly as short and by far the longest time per product; its 18-cycle latency is not hidden by a short cycle. Compare latency and throughput separately, and compare area as well.</p>`,
        real: `<p>Production cores pipeline the multiplier three or four stages deep so that it issues one multiply per cycle, and place registers inside the Booth tree where a cut costs fewest flip-flops. Small cores that rarely multiply use an iterative unit or none at all.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'A loop computes 1000 independent products. Which multiplier finishes first?',
        options: ['The pipelined one', 'The combinational Booth tree', 'The iterative one', 'They all take the same time'],
        answer: 0,
        explain: 'Independent products stream through the pipeline at one per (short) cycle: about 1000 × 41 delays. The combinational Booth tree needs 1000 × 67. When each product feeds the next (a dependency chain), the pipeline\'s latency of 4 × 41 = 164 per product makes it the slowest of the three trees.',
        why: ['', 'Its period of 67 delays covers the whole tree for every product. The pipeline starts a new product every 41.', 'The iterative unit spends many cycles on each product: it is the smallest of the four, not the fastest.', 'Latency is not throughput: independent products overlap in the pipeline, one finishing every cycle.'],
      },
    },
    {
      title: 'Division: one restoring step',
      body: `
        <p>Long division in binary also has only 0 or 1 as each quotient digit: <em>does the divisor fit?</em> One step shifts the next dividend bit into
        the partial remainder (<span data-show="r2">r2 = 2r + bit</span>), <span data-show="sub">subtracts the divisor</span>, and looks at the borrow. No borrow: it fits, so keep the difference and emit
        quotient bit 1. Borrow: <span data-show="mx">restore r2</span> and emit 0.</p>
        <p>The invariant that makes it work is 0 ≤ r &lt; d before the step. Then 2r + bit &lt; 2d, so the quotient digit is 0 or 1 and one subtraction decides it: if the difference is negative, one more bit of the dividend
        has not yet made the divisor fit. The step costs ${nd(divStep(4))} NANDs and ${dp(divStep(4))} delays at 4 bits: a subtractor plus a multiplexer that keeps either the difference or r2.</p>
        <div class="try">r = 1, qin = 1 gives r2 = 3, and d = 3 fits: rout = 0, q = 1. Now set d = 4.</div>`,
      scene: () => ({ root: divStep(4), inputs: { r: 1, qin: 1, d: 3 } }),
      tour: {
        beats: [
          { title: 'It fits', show: ['sub', 'mx'], expect: { rout: 0, q: 1 },
            say: '<p>r = 1, next dividend bit 1: r2 = 2 · 1 + 1 = 3. d = 3 fits, the subtraction does not borrow, so the remainder becomes {v:rout} and the quotient bit is {v:q}.</p>' },
          { title: 'It does not fit', set: { d: 4 }, show: ['sub', 'mx'], expect: { rout: 3, q: 0 },
            say: '<p>Now d = 4. r2 = 3 is less than 4, the subtraction borrows, the multiplexer restores r2: rout = {v:rout}, q = {v:q}. The bit joins the remainder; nothing is subtracted.</p>' },
          { title: 'Shift in a zero', set: { r: 2, qin: 0, d: 3 }, show: ['r2', 'sub'], expect: { rout: 1, q: 1 },
            say: '<p>r = 2 and a dividend bit of 0 give r2 = 4. 4 − 3 = {v:rout} with no borrow, so q = {v:q}. The remainder stays below d, which is what lets the next step work.</p>' },
        ],
      },
      more: {
        derive: `<p>If 0 ≤ r &lt; d and the next bit is b, then 0 ≤ r2 = 2r + b ≤ 2d − 1. The restoring rule keeps rout = r2 − d if that is non-negative and r2 otherwise; in both cases 0 ≤ rout &lt; d, so the invariant carries to the next step.
          After n steps the dividend a = q·d + r with the n quotient bits emitted most significant first.</p>`,
        pitfall: `<p>Starting a division with r ≥ d. Then r2 can be 2d or more, one subtraction no longer settles the digit and the quotient comes out wrong. The array divider starts every division with r = 0, which is why its quotient has n bits for an n-bit dividend and a divisor of any size.</p>`,
      },
      tries: [(st) => st.getInput('d') === 4 && st.value('q') === 0],
    },
    {
      title: 'The array divider',
      body: `
        <p><span data-show="st0 st1 st2 st3">Four steps in a row</span> make a 4-bit divider, most significant quotient bit first. Unlike multiplication, nothing can be done in parallel:
        each step needs the remainder from the one before. The delay is n full subtractions: ${dp(arrayDiv(4))} NAND delays at 4 bits, and at 32 bits ${sp(dp(arrayDiv(32)))},
        hopeless in one clock cycle. The cost is also high: ${nd(arrayDiv(4))} NANDs for 4 bits, ${sp(nd(arrayDiv(32)))} for 32.</p>
        <p>Dividing by zero falls out naturally: the divisor always "fits", so the quotient is all ones and the remainder is the dividend. RISC-V
        specifies exactly these results, so division never traps.</p>`,
      scene: () => ({ root: arrayDiv(4), inputs: { a: 13, b: 3 } }),
      tour: {
        beats: [
          { title: '13 / 3', show: ['st0', 'st1', 'st2', 'st3'], expect: { q: 4, r: 1 },
            say: '<p>Four steps, one quotient bit each, from the top: 13 = 4 · 3 + 1, so q = {v:q} and r = {v:r}.</p>' },
          { title: 'Divide by 0', set: { b: 0 }, show: ['st0', 'st1', 'st2', 'st3'], expect: { q: 15, r: 13 },
            say: '<p>With b = 0, subtracting 0 never borrows, so every step "fits": q = {v:q} (all ones) and the remainder is the dividend, {v:r}. RISC-V specifies exactly this, so division never traps.</p>' },
          { title: '7 / 2', set: { a: 7, b: 2 }, expect: { q: 3, r: 1 },
            say: '<p>7 = 3 · 2 + 1: q = {v:q}, r = {v:r}.</p>' },
          { title: 'An exact quotient', set: { a: 12, b: 3 }, expect: { q: 4, r: 0 },
            say: '<p>12 / 3 = {v:q} with remainder {v:r}: the last step lands exactly on zero.</p>' },
        ],
      },
      more: {
        derive: `<p>Step i (i = n − 1 down to 0) computes r ← 2r + a<sub>i</sub>, then if r ≥ d: r ← r − d, q<sub>i</sub> = 1. By the invariant 0 ≤ r &lt; d this leaves a = q·d + r. With d = 0 the test r ≥ 0 is always true, so every q<sub>i</sub> = 1 and
          r is never reduced: it ends as the dividend, the result RISC-V requires.</p>`,
        pitfall: `<p>Expecting a quotient wider than the dividend. For b ≥ 1 the quotient fits in the dividend's width; only b = 0 gives all ones, and the signed overflow case −2<sup>31</sup> / −1 wraps (see the quiz at the end of the chapter).</p>`,
        numbers: `<table class="mini"><tr><th>array divider</th><th>NANDs</th><th>delays</th></tr>
          <tr><td>4 bits</td><td>${sp(nd(arrayDiv(4)))}</td><td>${dp(arrayDiv(4))}</td></tr>
          <tr><td>32 bits</td><td>${sp(nd(arrayDiv(32)))}</td><td>${sp(dp(arrayDiv(32)))}</td></tr></table>`,
      },
      challenge: {
        kind: 'reach', goal: 'Divide by zero: set b = 0 and read q and r.',
        check: (st) => st.getInput('b') === 0 && st.value('q') === 15,
        hints: [
          'Before you set b, predict: can subtracting 0 ever borrow?',
          'No borrow means every step "fits" and emits a 1. Set b = 0 and compare q with your prediction, and r with a.',
        ],
        answer: 'b = 0: every step "fits", so q = 1111₂ = 15 (−1 as a signed number) and r = a. These are exactly the results RISC-V requires.',
        solve: (st) => st.setInputs({ b: 0 }),
      },
    },
    {
      title: 'The iterative divider',
      body: `
        <p>So reuse <span data-show="step"><em>one</em> step</span>, once per clock. Three registers hold <span data-show="rr">the remainder</span>,
        <span data-show="rd">the divisor</span>, and <span data-show="rq">a shift register</span> that starts as the
        dividend: its top bit feeds the step, and the new quotient bit enters at the bottom. <span data-show="cnt">A counter</span> stops after n steps.
        An 8-bit division takes 10 cycles: load, 8 steps, done.</p>
        <p>The register trick is the multiplier's, mirrored. The shift register holds the dividend on the way out of the top and the quotient on the way in at the bottom, so one n-bit register serves both. The cost is
        ${nd(seqDivider(8))} NANDs at 8 bits against ${nd(arrayDiv(8))} for the array; the clock only has to cover one step, ${dp(divStep(8))} delays plus the register, and the division takes n + 2 of them.</p>
        <div class="try">start = 1 is already set. Pulse the clock and watch q fill up from the right, one bit per cycle.</div>`,
      scene: () => ({ root: seqDivider(8), inputs: { a: 200, b: 7, start: 1, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Load', reset: true, cycles: 1, show: ['rq', 'rd', 'rr'], expect: { q: 200, r: 0, busy: 1 },
            say: '<p>200 / 7. The first edge loads the dividend into the shift register ({v:q}), the divisor into its own register, and clears the remainder.</p>' },
          { title: 'First step', cycles: 1, show: ['step', 'rr', 'rq'], expect: { q: 144, r: 1 },
            say: '<p>The top bit of 200 (11001000) is 1, so the remainder becomes 1. 1 does not fit in 7: quotient bit 0. The register shifted left (q = {v:q}) and r = {v:r}.</p>' },
          { title: 'A bit per cycle', cycles: 2, show: ['step'], expect: { q: 64, r: 6 },
            say: '<p>Two more steps: the next dividend bits are 1 and 0, so r goes 1 → 3 → 6, still below 7, and the quotient bits stay 0. Here r = {v:r}. The quotient grows at the bottom of q while the dividend leaves from the top.</p>' },
          { title: 'Done', cycles: 5, show: ['cnt', 'rq', 'rr'], expect: { q: 28, r: 4, done: 1 },
            say: '<p>After eight steps the counter says stop: q = {v:q}, r = {v:r}, done = {v:done}. 200 = 28 · 7 + 4.</p>' },
        ],
      },
      more: {
        derive: `<p>Time per division at n bits is (n + 2) clock periods: 10 · ${period(seqDivider(8))} = ${10 * period(seqDivider(8))} NAND delays at 8 bits, with ${period(seqDivider(8))} the period from static timing (clk-to-q ${CLK_TO_Q}, the 8-bit step's ${dp(divStep(8))}, ${period(seqDivider(8)) - CLK_TO_Q - dp(divStep(8)) - SETUP} through the load multiplexer and the register's input, setup ${SETUP}). The array divider needs ${dp(arrayDiv(8))} for the same division in one go,
          so the sequential unit is slower and smaller: the usual trade of space for time.</p>`,
        pitfall: `<p>Reading the result at the wrong time. q and r are final only while done = 1. With start held high, as in this scene, the unit reloads on the next edge, and the result is gone one cycle after it appeared.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Clock the divider until done = 1, with q = 28 and r = 4 (200 / 7).',
        check: (st) => st.value('done') === 1 && st.value('q') === 28 && st.value('r') === 4,
        hints: [
          'The protocol is the shift-and-add multiplier\'s: a load cycle, then one cycle per bit.',
          'One quotient bit per cycle, for an 8-bit dividend; add the load and stop when done rises.',
        ],
        answer: 'Nine pulses: the first loads the operands, the next eight each make one quotient bit, and then done is high for one cycle (the tenth).',
        solve: (st) => { st.runCycles(9); },
      },
    },
    {
      title: "Don't restore: non-restoring division",
      body: `
        <p>When the trial subtraction fails, restoring division puts the old remainder back (the multiplexer) and next step tries
        2r − d again. Non-restoring division keeps the negative remainder r − d instead. Next step, 2(r − d) + d = 2r − d, which is
        exactly the subtraction the restoring divider would have done. So the rule is: if the remainder is ≥ 0, subtract d, otherwise add it.
        The quotient bit is still "is the new remainder ≥ 0".</p>
        <p>The remainder is now signed (one bit wider), <span data-show="st0 st1 st2 st3">each row</span> is a single adder/subtractor with its <code>sub</code> input driven by the
        previous sign, and a negative remainder at the very end needs one correction: add d once (the <span data-show="fix"><code>fix</code> block</span>).</p>
        <p>Measured at 4 bits, the non-restoring array is ${nd(nrArrayDiv(4))} NANDs and ${dp(nrArrayDiv(4))} delays against ${nd(arrayDiv(4))} and ${dp(arrayDiv(4))} for the restoring one: not smaller, and not faster. The removed multiplexer is paid
        back by the XOR on the divisor and the final correction. What changes is the shape: every step is the same operation with a sign.</p>
        <div class="try">Compare with the restoring array two steps back: same q and r, no multiplexers. Here (13 / 3) the last step leaves
        −2, and the correction adds 3 back to give r = 1.</div>`,
      scene: () => ({ root: nrArrayDiv(4), inputs: { a: 13, b: 3 } }),
      tour: {
        beats: [
          { title: 'Same answer, no restore', show: ['st0', 'st1', 'st2', 'st3'], expect: { q: 4, r: 1 },
            say: '<p>13 / 3 = {v:q} remainder {v:r}, as with the restoring array. A step that goes negative is not undone: the next one adds the divisor instead.</p>' },
          { title: 'The correction', show: ['st3', 'fix'], expect: { q: 4, r: 1 },
            say: '<p>The last step leaves a remainder of −2. One more addition of d = 3 brings it to 1 (the fix block).</p>' },
          { title: 'An exact quotient', set: { a: 12 }, show: ['st3', 'fix'], expect: { q: 4, r: 0 },
            say: '<p>12 / 3: the last step leaves −3, and the fix block adds 3 back: r = {v:r}. An even quotient always ends on a negative remainder.</p>' },
          { title: 'A larger remainder', set: { a: 14 }, show: ['fix'], expect: { q: 4, r: 2 },
            say: '<p>14 = 4 · 3 + 2: q = {v:q}, r = {v:r}.</p>' },
        ],
      },
      more: {
        derive: `<p>Restoring: if 2r − d &lt; 0, restore to 2r and next step form 2(2r) − d = 4r − d. Non-restoring: keep r' = 2r − d &lt; 0 and next step form 2r' + d = 4r − 2d + d = 4r − d. Same value, no restore multiplexer.
          The quotient bit stays "is the new remainder ≥ 0", read off the sign, so nothing needs converting afterwards.</p>`,
        pitfall: `<p>Forgetting the last correction. If the final remainder is negative, the remainder is off by d (the quotient is already right): add d once. This is the <code>fix</code> block, easy to miss on a schematic because it is only exercised by the inputs with a negative last remainder.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Is a non-restoring step faster than a restoring one?',
        options: [
          'Not much: the carry chain still sets the step',
          'Yes, about twice as fast, because it never restores',
          'No, it is slower because it needs an extra step',
          'Yes, because it does not need a carry chain',
        ],
        answer: 0,
        why: ['', 'The restore was only a multiplexer after the carry chain. The chain, which sets the step\'s delay, is still there.', 'There is no extra step per bit. The one correction (the fix block) comes once, after the last step.', 'Each row is still a full-width adder/subtractor with a carry chain. Removing the chain takes the carry-save remainder of SRT.'],
        explain: 'The restore multiplexer after the carry chain is gone, but the add/subtract choice puts an XOR on the divisor before it. Both steps are a full-width carry chain plus about two gates (a multiplexer after it, or an XOR before it): 27 NAND delays each at 8 bits, measured. What non-restoring buys is regularity: every step is "add ±d". That is the form that lets the next idea keep the remainder in carry-save form.',
      },
    },
    {
      title: 'SRT: a redundant quotient',
      body: `
        <p>The carry chain is the problem: each step must know the sign of a full-width sum before it can choose. SRT division
        (Sweeney, Robertson and Tocher, 1958) allows quotient digits <strong>−1, 0 and +1</strong>. The
        choice then no longer has to be exact: when the remainder is near zero, either neighbouring digit keeps it in range, and the error is
        fixed by a later digit. The second idea came later and is what makes SRT fast in hardware: since the choice only needs a rough idea of the
        remainder, keep the remainder in <strong>carry-save form</strong>,
        <span data-show="u10 u11">two words</span> whose sum is the true value. Each step is then <span data-show="u20">one row of independent full adders</span>, whatever the width.</p>
        <p>For that to work the divisor must be normalized (½ ≤ d < 1, its top bit set): <span data-show="u1">the leading zeros of b are counted and both operands
        shifted</span>. The quotient comes out as two words, <span data-show="u12 u13">the +1 digits and the −1 digits</span>, and their difference is the answer.
        <span data-show="u23">One carry-propagate addition</span> at the end resolves the remainder; if it is negative, the usual correction applies; the remainder is shifted back.</p>
        <p>The price shows in the area: ${sp(nd(srtDivider(8)))} NANDs at 8 bits against ${nd(seqDivider(8))} for the restoring divider, because of the normalizer, the two quotient registers, the carry-save remainder (two words) and the final addition.
        At 8 bits it is not worth it. The payoff is that the step delay no longer grows with the width: the digit selection is ${dp(SRT_SELECT)} delays at any width (next step), where a restoring step carries a full subtraction.</p>
        <div class="try">start = 1 is set. Pulse the clock and watch the +1 and −1 digit registers fill (open the divider), then compare q and r.</div>`,
      scene: () => ({ root: srtDivider(8), inputs: { a: 200, b: 7, start: 1, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Load and normalize', reset: true, cycles: 1, show: ['u1'], expect: { busy: 1, q: 0 },
            say: '<p>200 / 7. The load cycle also counts the leading zeros of 7 and shifts both operands up, so the divisor has its top bit set. The remainder is kept as two words, never added until the end.</p>' },
          { title: 'Digits, one a cycle', cycles: 4, show: ['u10', 'u11', 'u20'], expect: { q: 1, r: 5 },
            say: '<p>Each cycle picks a digit from the top bits and does one row of independent full adders. The quotient is held as two words (+1 digits, −1 digits), so q is still being assembled: {v:q}. The remainder estimate reads {v:r}.</p>' },
          { title: 'Resolve', cycles: 4, show: ['u23'], expect: { q: 28, r: 4, done: 1 },
            say: '<p>After the last digit one carry-propagate addition turns the carry-save remainder into r = {v:r}, and the two digit words give q = {v:q}: 200 = 28 · 7 + 4, done = {v:done}.</p>' },
        ],
      },
      more: {
        derive: `<p>With the divisor normalized to d ∈ [½, 1) and the remainder kept in [−d, d), the next remainder is w' = 2w − q·d for q ∈ {−1, 0, 1}. If 2w ≥ 0, q = 1 keeps w' = 2w − d ∈ [−d, d); if 2w &lt; −½, q = −1 gives 2w + d; in between q = 0.
          Because those intervals overlap (the digit set is redundant), a rough estimate of 2w suffices.</p>`,
        pitfall: `<p>Taking a −1 digit for an error. The digit set is redundant on purpose: a +1 can be followed by a −1 that corrects an estimate that was a step too high. The quotient is the sum of all the digits weighted by position, so it is the difference of the +1 word and the −1 word.</p>`,
        real: `<p>SRT is the digit recurrence behind many high-performance dividers; the original Pentium used a radix-4 SRT whose lookup table had five entries missing (the FDIV bug, 1994).</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Clock the SRT divider until done = 1, with q = 28 and r = 4 (200 / 7).',
        check: (st) => st.value('done') === 1 && st.value('q') === 28 && st.value('r') === 4,
        hints: [
          'Same protocol as the iterative divider, and start is already set.',
          'The load cycle also normalizes the divisor; then one digit per cycle for an 8-bit dividend, and done follows.',
        ],
        answer: 'Nine pulses, the same protocol as the restoring divider: one load (which also normalizes 7 to 0b11100000), eight digits, then done.',
        solve: (st) => { st.runCycles(9); },
      },
    },
    {
      title: 'Choosing the digit',
      body: `
        <p>The digit is chosen from the shifted remainder 2w against fixed thresholds (normalization put d in [½, 1)): +1 if 2w ≥ 0, 0 if −½ ≤ 2w < 0, −1 below.
        Only the top four bits of the sum and carry words are added, an estimate in steps of ½, so it can be low by almost a whole 1 (just under two steps: each word loses up to just under ½). That is safe:
        +1 is correct anywhere in [0, 2d), −1 anywhere in [−2d, 0), and 0 anywhere in [−d, d), which overlaps both.</p>
        <p>The circuit does not even form the 4-bit sum. It needs only <span data-show="sign">its sign</span> (<span data-show="cy">a carry into bit 3</span>, looked ahead from the bits below)
        and whether it is 1111 (−½, which picks the digit 0), which happens exactly when <span data-show="m1">every bit pair differs</span>. ${dp(SRT_SELECT)} NAND delays and ${nd(SRT_SELECT)} NANDs, at any operand width.</p>`,
      scene: () => ({ root: SRT_SELECT, inputs: { s: 0b1110, c: 0b0001 } }),
      tour: {
        beats: [
          { title: 'Estimate −1: digit 0', show: ['sign', 'cy', 'm1'], expect: { qp: 0, qn: 0 },
            say: '<p>s = 1110, c = 0001: the 4-bit sum is 1111, which is −1 in steps of ½: exactly −½, not below it, so the digit is 0: qp = {v:qp}, qn = {v:qn}.</p>' },
          { title: 'Positive: +1', set: { s: 1, c: 0 }, show: ['sign'], expect: { qp: 1, qn: 0 },
            say: '<p>s = 0001, c = 0: a non-negative estimate. qp = {v:qp}: the digit is +1.</p>' },
          { title: 'Clearly negative: −1', set: { s: 8, c: 0 }, show: ['sign', 'm1'], expect: { qp: 0, qn: 1 },
            say: '<p>s = 1000: the sum is −8 half-steps (−4), far below −½. qn = {v:qn}: the digit is −1.</p>' },
          { title: 'Carry-save form', set: { s: 7, c: 7 }, show: ['cy', 'm1'], expect: { qp: 0, qn: 1 },
            say: '<p>s = 0111 and c = 0111 add to 1110 = −2, so the digit is −1 too. The circuit never forms that sum: it reads the carry into bit 3 and compares pairs, which is why it is as fast at any width.</p>' },
        ],
      },
      more: {
        derive: `<p>Add the top four bits of s and c as a 4-bit two's complement number e, in steps of ½. The dropped low bits make e at most just under 1 below the true 2w: e ≤ 2w &lt; e + 1. If e ≥ 0 then 2w ≥ 0, and digit +1 is allowed for every 2w in [0, 2d).
          If e is −1 or lower, then 2w &lt; e + 1 ≤ 0, and −1 is allowed for every 2w in [−2d, 0). The one value left, e = −½ (1111), puts 2w in [−½, ½), where digit 0 keeps the new remainder within d because d ≥ ½.</p>`,
        pitfall: `<p>Choosing from the exact sign of s + c. That needs a full carry chain, which is the delay SRT exists to avoid. The truncated estimate is wrong by just under 1 on purpose, and the overlapping digit regions are what absorb it.</p>`,
        numbers: `<table class="mini"><tr><th>digit select</th><th>NANDs</th><th>delays</th></tr><tr><td>radix 2</td><td>${nd(SRT_SELECT)}</td><td>${dp(SRT_SELECT)}</td></tr></table>`,
      },
      challenge: {
        kind: 'reach', goal: 'Find inputs that select the digit −1 (qn = 1).',
        check: (st) => st.value('qn') === 1,
        hints: [
          'qn means the estimate of 2w is below −½: a negative 4-bit sum, except −1 (1111), which picks the digit 0.',
          'With c = 0 the 4-bit sum is s alone. Which values of s are negative in two\'s complement, and which of them is −1?',
        ],
        answer: 'Any pair whose 4-bit sum is 8 to 14 (a negative estimate other than −1), for example s = 0b1000, c = 0b0000: estimate −8 halves, digit −1.',
        solve: (st) => st.setInputs({ s: 0b1000, c: 0 }),
      },
    },
    {
      title: 'Radix 4: two bits per clock',
      body: `
        <p>With digits from −2 to +2, <span data-show="u22">each step</span> retires two quotient bits. The multiples d and 2d are wires (2d is d shifted), so the
        term row is still one AND-OR per bit. The price is selection: the redundancy is smaller (ρ = 2/3: the remainder must stay within
        ±⅔ d), so the digit depends on <span data-show="u16">the divisor</span> as well. The estimate is 8 bits of
        <span data-show="u12 u13">the remainder</span> (4 fractional) and the divisor is
        known to 3 bits after its leading one; for each of those 8 divisor intervals, 4 thresholds split the estimate into the 5 digits.</p>
        <details class="deeper"><summary>Deeper: where the thresholds come from</summary>
        <p>The thresholds here are not copied from a book. Each comes from two inequalities: the smallest estimate that picks digit k must
        still allow k, and the largest that picks k − 1 must still allow k − 1, for every divisor in the interval, with the carry-save estimate
        up to 2⁄16 low. The tests check them against every reachable remainder exactly, and the divider against every 4-bit pair. The Pentium's FDIV bug (1994) was a table of this kind with five entries wrong.</p></details>
        <p>Each comparison stays in carry-save form: one 3:2 row computes s + c − m and an 8-bit adder gives its sign. A 32-bit division takes
        19 cycles of 44 NAND delays (836) against radix 2's 34 of 31 (1054).</p>
        <p>At 8 bits the radix-4 divider is ${sp(nd(srt4Divider(8)))} NANDs against ${sp(nd(srtDivider(8)))} for radix 2: the selection tables and the extra multiples cost about ${(nd(srt4Divider(8)) / nd(srtDivider(8))).toFixed(1)} times as much hardware for half the steps.</p>
        <div class="try">start = 1 is set. Pulse the clock: the quotient fills two bits at a time.</div>`,
      scene: () => ({ root: srt4Divider(8), inputs: { a: 200, b: 7, start: 1, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'Load', reset: true, cycles: 1, show: ['u16'], expect: { busy: 1 },
            say: '<p>The load cycle normalizes the divisor and shifts the dividend down two places, so that eight bits need five radix-4 digits.</p>' },
          { title: 'Two bits a step', cycles: 2, show: ['u22'], expect: { r: 3 },
            say: '<p>Two digit steps in, nothing of the quotient is visible yet: leading digits are zero for 200 / 7 and the remainder estimate is {v:r}.</p>' },
          { title: 'Quotient appears', cycles: 1, show: ['u22', 'u12', 'u13'], expect: { q: 1, r: 5 },
            say: '<p>The first non-zero digit arrives: q = {v:q}. A radix-4 digit retires two quotient bits.</p>' },
          { title: 'Done in 7 cycles', cycles: 2, expect: { q: 28, r: 4, done: 1 },
            say: '<p>q = {v:q}, r = {v:r}, done = {v:done} after six edges. The radix-2 divider needed nine for the same division.</p>' },
        ],
      },
      more: {
        derive: `<p>Radix r = 4 allows digits −a … +a with a = 2; redundancy ρ = a / (r − 1) = 2/3. The remainder must stay in [−ρd, ρd]. Each step retires log₂ r = 2 bits, so an n-bit division takes ⌈n/2⌉ + 1 digit steps plus load and done. The selection function is a table
          indexed by a few bits of the divisor and of the remainder estimate; here the thresholds are computed, not copied.</p>`,
        pitfall: `<p>Assuming radix 4 is twice as fast. Halving the steps lengthens each step (more selection, a bigger multiple row), so the gain depends on width; at 8 bits it loses, at 32 it wins by about a fifth (next step's table).</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Clock the radix-4 divider until done = 1, with q = 28 and r = 4.',
        check: (st) => st.value('done') === 1 && st.value('q') === 28 && st.value('r') === 4,
        hints: [
          'Each step now makes two quotient bits, so count digits rather than bits.',
          'The load also shifts the dividend down two places, which costs one digit more than 8 / 2. Add the load cycle.',
        ],
        answer: 'Six pulses: one load, five radix-4 steps (the dividend is shifted down two places first, so 8 bits need 5 digits), then done: 7 cycles instead of 10.',
        solve: (st) => { st.runCycles(6); },
      },
    },
    {
      title: 'Dividers compared',
      body: `
        <p>The same protocol, four dividers. The table is computed from the circuits on this page. Total time is cycles times the step delay; area is what it costs to get there.</p>
        <p>Read it as a list of what each refinement changes: non-restoring regularizes the step, SRT radix 2 removes the carry chain from it, radix 4 halves the number of steps and pays for that in selection logic.</p>`,
      widget: divComparison,
      more: {
        pitfall: `<p>Ranking by cycles alone. A radix-4 division takes fewer cycles than a radix-2 one, but each cycle is longer; only the product, cycles times period, is the time, and it depends on the width as the quiz shows.</p>`,
        real: `<p>Cores with a fast divider use radix 4 to 16, often by chaining two or three stages inside one cycle, and some cores skip the whole recurrence for easy operands (a small dividend, or a divisor of one). Division latencies of 10 to 40 cycles are typical for 32 to 64 bits.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'Why is the radix-4 divider slower than radix 2 at 8 bits, but faster at 32?',
        options: [
          'Its step is longer (44 against 29 NAND delays); halving the steps only pays when there are many of them',
          'Radix 4 needs more cycles at 8 bits',
          'Normalization is slower for small numbers',
          'The 8-bit version uses a ripple adder',
        ],
        answer: 0,
        why: ['', 'It needs fewer: 7 against 10. Each of them is longer.', 'Both dividers normalize once, in the load cycle, whatever the operands.', 'The final addition runs once per division. The crossover comes from the step delay times the number of steps.'],
        explain: 'Both pay a load cycle and a done cycle; radix 4 also one extra digit (the dividend is shifted down two places). At 8 bits radix 4 takes 7 cycles of 44 delays against 10 of 29: 308 against 290. At 32 bits, 19 of 44 against 34 of 31: 836 against 1054. Real dividers go further: radix 8 or 16 by overlapping two or three radix-2 or radix-4 stages per cycle.',
      },
    },
    {
      title: 'The M unit',
      body: `
        <p>Here is everything together, as the CPU uses it. funct3 (the instruction's 3-bit function field) picks the operation.
        <strong>Multiplies</strong> go through <span data-show="mul">the 33×33 tree</span>
        (about 13 900 NANDs) and finish in the same cycle. <strong>Divides</strong> strip the signs (<span data-show="nga ngb">conditional negators</span>), run
        <span data-show="div">the 32-bit iterative divider</span>, and <span data-show="ngo">put the sign back</span>: the quotient is negative if the signs differ (unless b = 0), and the remainder takes the dividend's sign.
        While a divide runs, <span data-show="stall"><code>stall</code></span> holds the CPU for 33 extra cycles.</p>
        <p>The costs are very unequal: the multiplier is ${sp(mduPart('mul'))} NANDs, the divider ${sp(mduPart('div'))}, and the whole unit ${sp(nd(MDU))}; the logic around them (sign handling, the result select) is ${sp(nd(MDU) - mduPart('mul') - mduPart('div'))}. The multiplier finishes in the cycle, the divider takes 34.</p>
        <div class="try">Set funct3 = 4 (div) and pulse until stall drops: −7 / 3 = −2 (0xFFFFFFFE).</div>`,
      scene: () => ({ root: MDU, inputs: { a: 0xfffffff9, b: 3, funct3: 0, isM: 1, noTrap: 1, clk: 0 }, autoClock: false }),
      tour: {
        beats: [
          { title: 'mul: low word', show: ['mul'], expect: { y: 4294967275, stall: 0 },
            say: '<p>a = 0xFFFFFFF9 (−7), b = 3, funct3 = 0 (<code>mul</code>). y = {v:y} = 0xFFFFFFEB, the low 32 bits of −21, available in the same cycle.</p>' },
          { title: 'mulh: high word', set: { funct3: 1 }, show: ['mul'], expect: { y: 4294967295 },
            say: '<p>funct3 = 1 (<code>mulh</code>) reads the high word of the same 64-bit product: all ones, the sign extension of −21. y = {v:y}.</p>' },
          { title: 'mulhu: both unsigned', set: { funct3: 3 }, show: ['mul'], expect: { y: 2 },
            say: '<p>funct3 = 3 (<code>mulhu</code>) treats a as 4 294 967 289: times 3 the high word is {v:y}. The same tree, a different extension of the operands.</p>' },
          { title: 'div starts', set: { funct3: 4 }, cycles: 1, show: ['div', 'nga', 'ngb'], expect: { stall: 1 },
            say: '<p>funct3 = 4 (<code>div</code>): the signs are stripped (7 / 3) and the iterative divider starts. stall = {v:stall}: the CPU holds while it works.</p>' },
          { title: 'Thirty-one more edges', cycles: 31, show: ['div'], expect: { stall: 1 },
            say: '<p>Still stalled: stall = {v:stall}. The divider makes a quotient bit every cycle.</p>' },
          { title: 'Done', cycles: 1, show: ['ngo'], expect: { stall: 0, y: 4294967294 },
            say: '<p>On the 33rd edge stall drops and y = {v:y} = 0xFFFFFFFE = −2: the output negator put the sign back, since the signs of a and b differ.</p>' },
        ],
      },
      more: {
        derive: `<p>Divide through unsigned: q = |a| / |b|, r = |a| mod |b|, then q is negated if sign(a) ≠ sign(b) and r takes sign(a). That rounds the quotient towards zero, as RISC-V requires: −7 / 3 = −2 remainder −1, and −2 · 3 + (−1) = −7.
          Corner cases fall out of the same datapath: b = 0 gives q = all ones and r = a, and −2<sup>31</sup> / −1 gives −2<sup>31</sup> and 0, with no special hardware.</p>`,
        pitfall: `<p>Using the wrong operand extension for mulh variants. The same 64-bit tree serves mul, mulh, mulhsu and mulhu only because the operands are extended by sign or zero before the tree: mulh of −1 and −1 is 0 as a high word, mulhu of the same bit patterns is 0xFFFFFFFE.</p>`,
        numbers: `<table class="mini"><tr><th>part of the M unit</th><th>NANDs</th></tr><tr><td>33×33 multiplier</td><td>${sp(mduPart('mul'))}</td></tr><tr><td>32-bit divider</td><td>${sp(mduPart('div'))}</td></tr><tr><td>whole unit</td><td>${sp(nd(MDU))}</td></tr></table>`,
      },
      tries: [(st) => st.getInput('funct3') === 4 && st.value('stall') === 0 && st.value('y') === 0xfffffffe],
    },
    {
      title: 'RV32IM',
      body: `
        <p>The complete system CPU with <span data-show="md">the M unit</span> beside <span data-show="mres">the result multiplexer</span>: about ${kNands(sysNands(true).core)} NANDs
        without its program ROM, ${pct(sysNands(true).core, sysNands(false).core)} % more than the RV32I machine of <a href="#/c/io/0">chapter ${numOf('io')}</a>
        (${kNands(sysNands(false).core)}); the M unit alone is ${groupDigits(stats(MDU).nands)}. With its ${kNands(sysNands(true).rom)}-NAND program ROM:
        ${kNands(sysNands(true).all)} against ${kNands(sysNands(false).all)}. It is still checked
        against the instruction-set simulator (the reference model that runs the program one instruction at a time) on every instruction. The timing panel shows the cost in speed: <strong>one NAND delay</strong> (126 → 127).
        The critical path does not even pass through the multiplier. The tree is shallow enough to hide behind the existing
        branch-and-trap decision, which now ends through the new stall logic in the register file's write enable. Press "Highlight path" to see it.</p>
        <p>A divide holds the PC and the register write (the CPU's <code>retire</code> output goes low) for 33 cycles. An interrupt that arrives in the
        meantime waits for the divide to finish.</p>
        <p>Why the clock barely moves: the multiplier tree is deep but not deeper than the existing path from the register file through the ALU to the branch decision, and the divider is sequential, so its longest path is one step.
        Adding a whole unit costs area, not period; the unit's cost is paid in the cycles of a divide, which the golden model counts too.</p>
        <div class="try">Run the program: each digit costs a <code>remu</code> and a <code>divu</code>, 68 cycles. Also try "RV32M corner cases".</div>`,
      scene: () => cpuScene({ source: msrc('factorial'), system: true, m: true, timing: true, highlight: ['md', 'mres'] }),
      tour: {
        beats: [
          { title: 'A multiply is one cycle', reset: true, cycles: 7, show: ['md', 'mres'], expect: { pcOut: 44, retire: 1 },
            say: '<p>The program multiplies 1 × 1 in one cycle like an add, then calls <code>print</code>. pc = {v:pcOut}, and retire = {v:retire}: one instruction retires every cycle so far.</p>' },
          { title: 'The divide begins', cycles: 1, show: ['md'], expect: { pcOut: 48, retire: 0 },
            say: '<p><code>remu</code> reaches the M unit. pc stays at {v:pcOut} and retire drops to {v:retire}: the CPU holds PC and the register write while the divider runs.</p>' },
          { title: 'Thirty-two cycles of waiting', cycles: 32, show: ['md'], expect: { pcOut: 48, retire: 0 },
            say: '<p>Still the same instruction. Nothing retires, and an interrupt arriving now would have to wait.</p>' },
          { title: 'The result arrives', cycles: 1, show: ['mres'], expect: { pcOut: 48, retire: 1 },
            say: '<p>After 33 cycles of holding, retire = {v:retire}: <code>remu</code> completes and writes its result.</p>' },
          { title: 'The next divide', cycles: 1, expect: { pcOut: 52, retire: 0 },
            say: '<p>Straight away <code>divu</code> (pc = {v:pcOut}) starts another 33-cycle hold. Printing 1 takes 68 cycles for one digit.</p>' },
        ],
      },
      more: {
        derive: `<p>Each digit costs a <code>remu</code> and a <code>divu</code>: 2 × 34 = 68 cycles. A number of d digits takes 68d cycles in the loop, plus a handful of one-cycle instructions per digit. The M extension suggests keeping a divide and a remainder of the same operands adjacent, so that a core can fuse the pair into one division; that would halve the cost here, and this CPU does not.</p>`,
        pitfall: `<p>Expecting <code>retire</code> to count cycles. It is low while a divide holds the CPU and high when an instruction completes; one instruction completes per 34 cycles during division, so "cycles per instruction" for this program is far above 1.</p>`,
      },
      challenge: {
        kind: 'reach', goal: 'Run until 8! = 40320 has been printed (the loop counter s1 reaches 9).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x[9] >= 9 : false; } catch { return false; } },
        hints: [
          'This is a long run, well over a thousand cycles: pulsing by hand would take a while.',
          'The CPU panel has a button that runs the program until it halts.',
        ],
        answer: 'Press "Run to halt": about 1600 cycles for 293 instructions, CPI 5.5. The 20 digits cost 40 divides × 34 cycles, 1360 cycles of division alone. This is why compilers turn division by a constant into a multiply by its reciprocal.',
        // the panel's Run button animates without freezing the page
        solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
      },
    },
    {
      title: 'What it costs a program',
      body: `
        <p>Real processors pipeline the multiplier (3 or 4 stages, one result per cycle) and use faster dividers than this one: radix-4 SRT (as built
        above, 2 bits a cycle) or radix 16 (two radix-4 stages overlapped in one cycle), still 10 to 40 cycles for 32 or 64 bits. Division is rare
        enough that it gets a fraction of the multiplier's area: fast enough not to dominate a program, never one result per cycle.</p>
        <p>Floating-point units often divide another way: Newton–Raphson or Goldschmidt iterations on the multiplier they already have, starting from
        a small table's estimate of 1/d. Each iteration (two multiplies) doubles the number of correct bits, 8 → 16 → 32 → 64, against a fixed few
        per cycle for digit recurrence, but the result needs a final correction step to be rounded exactly.</p>
        <p>The quiz's arithmetic is the general rule for any slow instruction: CPI = (N − k + k·c) / N for k instructions of c cycles among N. One divide in twenty at 34 cycles gives (19 + 34) / 20 = ${((19 + 34) / 20).toFixed(2)}.
        What matters is the frequency of the slow instruction, not only its latency.</p>`,
      more: {
        derive: `<p>Time per instruction = CPI × period. With a fraction f of instructions taking c cycles and the rest one: CPI = 1 + f·(c − 1). For f = 1/20 and c = 34, CPI = 1 + 33/20 = ${(1 + 33 / 20).toFixed(2)}. Halving c to 17 cycles gives ${(1 + 16 / 20).toFixed(2)}: a divider twice as fast moves the whole program only by ${Math.round((1 - (1 + 16 / 20) / (1 + 33 / 20)) * 100)} %.</p>`,
        pitfall: `<p>Judging a divider by its latency alone. A program with one divide in a thousand instructions barely notices a 34-cycle one; a loop that divides every iteration is dominated by it. Profile the program before spending area.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'On this CPU, a loop body has 20 instructions, one of which is a divide (34 cycles; everything else takes 1). What is the CPI?',
        options: ['1.0', '1.65', '2.65', '34'], answer: 2,
        why: ['That ignores the divide\'s 33 extra cycles.', 'That is the divide\'s 33 extra cycles spread over 20 instructions, without the one cycle every instruction takes.', '', 'That is the divide alone. The other 19 instructions take one cycle each and pull the average down.'],
        explain: '19 instructions × 1 cycle + 1 divide × 34 cycles = 53 cycles for 20 instructions: CPI = 2.65. One instruction in twenty makes the loop 2.65× slower. That is why compilers replace division by a constant with a multiply by its reciprocal (a mulh and a shift), and why fast cores spend area on faster dividers.',
      },
    },
    {
      title: 'M in the pipeline',
      body: `
        <p>The pipelined CPU with the M extension. The <strong>multiplier is split across two stages</strong>: <span data-show="mule">E</span> extends the operands to
        34 bits (sign or zero, as funct3 says), forms the radix-4 Booth rows and reduces them with the 3:2 tree to two 64-bit words, which ride in
        <span data-show="EM">the E/M register</span>; <span data-show="mulm">M</span> adds them (a 64-bit Kogge–Stone) and picks the low or high word in place of the memory word. A multiply's result
        therefore appears where a load's does, and decode sets ResultSrc (the control field that selects the value written back) to the load path: the existing
        <span data-show="hz">hazard unit</span> gives a dependent instruction
        the one-cycle load-use stall and then forwards from W. Nothing new in the hazard unit.</p>
        <p>A <strong>divide</strong> runs on <span data-show="dive">the radix-4 SRT divider in E</span>. While it works, <code>divStall</code> (the divider's
        busy signal) holds PC, IF/ID and ID/EX, and
        sends bubbles into M; the result leaves through the ALU's place in E/M on the 19th cycle and is forwarded like any ALU result.</p>
        <p>Cost: 70 900 → 102 900 NANDs (+45 %, the 64-bit tree and adder dominate). Speed, with fast adders: 93 → 93 gate delays, because the
        branch-resolution path in E is longer than both units.</p>
        <p>The design choice to note is where the multiplier is cut. A product is ready at the end of M, like a load, so the hazard unit needs no new case. The alternative, a one-stage multiplier, would put the 64-bit tree and adder in E on top of the forwarding mux and set the clock; a deeper split would add bubbles for dependent uses.</p>
        <details class="deeper"><summary>Deeper: the balanced pipeline's clock, 59 → 79</summary>
        <p>With the balanced design (branch compare in its own unit) the period
        was 59 and becomes <strong>79</strong>: the divider's sign fix after its registers (q / r mux and a conditional negate, 70 deep)
        now sets the E/M capture, and the multiplier tree (74 into the sum register) is close behind. Real cores register the divider's result and
        cut the tree in two; here the timing panel shows the honest number.</p></details>
        <div class="try">Run "Multiply and divide hazards": 17 instructions in 98 cycles. Watch the pipeline diagram: one bubble after each
        dependent multiply, a long hold for each divide. Open <code>mule</code>, <code>mulm</code> and <code>dive</code> to see the parts above.</div>`,
      scene: () => cpuScene({ source: PIPE_M_PROGRAMS.find((p) => p.id === 'mhazards')!.source, pipeline: true, m: true, adder: 'ks', timing: true, highlight: ['mule', 'mulm', 'dive'] }),
      tour: {
        beats: [
          { title: 'A multiply passes', reset: true, cycles: 6, show: ['mule', 'mulm'], expect: { pcW: 8, validW: 1, pcF: 20 },
            say: '<p><code>mul t0, a0, a1</code> (pc 8) is in Writeback: pcW = {v:pcW}. It spent E and M computing the product, as a load spends M reading memory.</p>' },
          { title: 'One bubble', cycles: 1, show: ['hz'], expect: { validW: 0, pcF: 24 },
            say: '<p>The dependent <code>add t1, t0, a0</code> could not use the product in E: a bubble (validW = {v:validW}) passes through W. This is the load-use stall, one cycle.</p>' },
          { title: 'Then the add', cycles: 1, expect: { pcW: 12, validW: 1 },
            say: '<p>The add retires (pcW = {v:pcW}) with the product forwarded from W. One bubble is the whole price of a dependent multiply.</p>' },
          { title: 'The divide holds the front', cycles: 3, show: ['dive'], expect: { pcF: 32, validW: 1, pcW: 20 },
            say: '<p><code>mulh</code> (pc 20) retires; <code>div</code> is in E with the radix-4 SRT divider. pcF stays at {v:pcF}: IF/ID and ID/EX are held.</p>' },
          { title: 'Waiting for the divider', cycles: 1, show: ['dive'], expect: { pcF: 32, validW: 0 },
            say: '<p>Bubbles flow into M while the divider works (validW = {v:validW}); nothing new is fetched.</p>' },
          { title: 'The divide completes', cycles: 18, show: ['dive'], expect: { pcW: 24, validW: 1, pcF: 40 },
            say: '<p>The quotient leaves E on the 19th cycle of the divide and reaches W: pcW = {v:pcW}. The held instructions move on at once.</p>' },
        ],
      },
      more: {
        derive: `<p>A dependent multiply costs one cycle, like a load, because the product is complete only at the end of M while the consumer needs it at the start of E. A divide costs the whole divider time (about 19 cycles) whatever follows it, because everything behind it is held until the result leaves E. The hazard program's 17 instructions take 98 cycles: of the 81 cycles beyond one per instruction, the four divides account for most.</p>`,
        pitfall: `<p>Forwarding a multiply from M. The product is complete only after the 64-bit addition in M, at the end of the stage; the forwarding path starts from the next stage (W). Wire it from M and the clock includes the whole adder after the register.</p>`,
      },
      challenge: {
        kind: 'quiz', question: 'mul t0, a0, a1 is followed by add t1, t0, a0. How many cycles does the add wait, and why?',
        options: ['None: the product is forwarded from M', 'One: the product exists only at the end of M, like a loaded word', 'Two: the product must be written back first', '18: as long as a divide'],
        answer: 1,
        why: ['The product is complete only at the end of M, after the add needed it at the start of E.', '', 'After one stall the mul is in W and the add in E: W forwards it, with no wait for the register write.', 'The multiplier is split across E and M and never holds the pipeline. Only a divide does.'],
        explain: 'The 64-bit addition happens in M, so the product is ready at the same point as a word read from memory. Decode marks a multiply as using the load path, and the load-use logic stalls the add for one cycle; then the product is forwarded from W. Splitting the multiplier costs one bubble per dependent use and keeps the clock from growing by a whole 64-bit adder.',
      },
    },
    {
      title: 'Multiply and divide in hardware',
      body: `
        <p>Chapter ${numOf('python')}'s compiler can target this instruction set too. Compile for <em>RV32IM</em> (the switch in the Python panel, on the pipeline of chapter ${numOf('pipeline')}) and the routines disappear: <code>*</code> is one <code>mul</code>, <code>//</code> and <code>%</code>
        a <code>div</code> or <code>rem</code>. The pipeline gains this chapter's multiplier and divider: ${fmt(M_COST.withM - M_COST.base)} NANDs more
        (${fmt(M_COST.base)} → ${fmt(M_COST.withM)}, +${(100 * (M_COST.withM - M_COST.base) / M_COST.base).toFixed(1)} %, with this panel's 256-word program ROM and 64-word data memory; the same ${fmt(M_COST.withM - M_COST.base)} NANDs were +45 % on the smaller memories of the last step), counted from the two designs.</p>
        <p>Python's rounding needs care. RISC-V's <code>div</code> truncates toward zero, Python's <code>//</code> floors: for −7 and 2 they give −3 and −4. After <code>rem</code> the compiler
        tests three things, remainder ≠ 0, divisor ≠ 0 and the operands' signs differ, and only then lowers the quotient by one (or adds the divisor to a remainder). The cases it
        leaves to the hardware are exactly this subset's: <code>x // 0</code> is −1 and <code>x % 0</code> is x, as RISC-V defines them. Random programs interpreted and compiled both ways
        agree on every output, and the gate-level pipeline agrees with the golden model after every instruction.</p>
        <p>gcd: ${fmt(GCD_I.cycles)} cycles with the routines, ${fmt(GCD_M.cycles)} with RV32IM (${(GCD_I.cycles / GCD_M.cycles).toFixed(1)}×) for ${fmt(GCD_I.instr)} → ${fmt(GCD_M.instr)} instructions. The CPI goes <em>up</em>, ${(GCD_I.cycles / GCD_I.instr).toFixed(2)} → ${(GCD_M.cycles / GCD_M.instr).toFixed(2)}: each of its six <code>%</code> holds Execute for
        ${GCD_M.divide / 6 + 1} cycles (${fmt(GCD_M.divide)} extra cycles, ${Math.round(100 * GCD_M.divide / GCD_M.cycles)} % of the run), the cost of the loop moved into hardware. A program with no <code>*</code>, <code>//</code> or <code>%</code> by a variable
        gains nothing and still pays for the gates: prefix runs ${fmt(PREFIX.cycles)} cycles either way.</p>`,
      scene: () => pyScene(pySrc('gcd'), { pipeline: true, m: true }),
      more: {
        derive: `<p>The divider is the radix-4 SRT unit above: ${GCD_M.divide / 6 + 1} cycles a divide, one per Execute stay. Speed-up of RV32IM on the pipeline: ${SPEEDUPS.map((r) => `${r.id} ${r.x.toFixed(1)}×`).join(', ')};
          a multiply by a constant such as 10 or 7 was already shifts and adds, so only variable operands change.</p>`,
        pitfall: `<p>The floor fix is not free: a <code>//</code> by a variable is <code>rem</code>, three tests and the <code>div</code>, and a <code>%</code> the <code>rem</code> and its sign tests: ${DIV_LINE} instructions either way where C needs one. A language whose division truncates (C, Java, Rust) compiles to the bare pair;
          Python pays for its mathematically nicer rounding on negative operands.</p>`,
        real: `<p>Compilers for real RV32IM do the same, and hardware often fuses an adjacent <code>div</code> / <code>rem</code> on the same operands into one divide. Many small cores omit M, as the base ISA allows, and ship the routines in a library (libgcc's <code>__divsi3</code>).</p>`,
      },
      challenge: {
        kind: 'quiz',
        question: `Compiled for RV32IM, gcd's CPI rises from ${(GCD_I.cycles / GCD_I.instr).toFixed(2)} to ${(GCD_M.cycles / GCD_M.instr).toFixed(2)} yet it runs ${(GCD_I.cycles / GCD_M.cycles).toFixed(0)}× faster. How?`,
        options: ['It executes about twenty times fewer instructions; each divide is slower than an average routine instruction but replaces a whole loop of them', 'The M unit raises the clock frequency', 'The pipeline stops stalling once it has a divider', 'CPI counts only the stalls, which the divider removes'],
        answer: 0,
        explain: `Time = instructions × CPI × period. Instructions fell ${(GCD_I.instr / GCD_M.instr).toFixed(0)}×, CPI rose ${((GCD_M.cycles / GCD_M.instr) / (GCD_I.cycles / GCD_I.instr)).toFixed(1)}×, the period is the pipeline\'s either way. A divide spends its cycles in one instruction instead of spreading them over a loop that also flushes the pipeline on every taken branch.`,
        why: ['', 'The clock is set by the slowest stage; the divider is iterative precisely so that it does not lengthen it.', 'It still stalls and flushes; the divide waits are new.', 'CPI is total cycles over instructions: every bubble and every divide cycle is in it.'],
      },
    },
  ],
};
