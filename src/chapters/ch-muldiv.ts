import { BOOTH_ENC, MDU, arrayDiv, arrayMul, csa, divStep, seqDivider, treeMul } from '../lib';
import { cpuState } from '../riscv/cosim';
import { M_PROGRAMS } from '../riscv/mprograms';
import { cpuScene } from '../widgets/cpupanel';
import { boothWidget, mulComparison } from '../widgets/muldiv';
import type { Chapter } from './types';

const msrc = (id: string) => M_PROGRAMS.find((p) => p.id === id)!.source;

export const chMulDiv: Chapter = {
  id: 'muldiv', num: 20, title: 'Multiply & divide', level: 'Arithmetic',
  blurb: 'Array and Wallace-tree multipliers, Baugh–Wooley and Booth, restoring division, and the M extension in the CPU.',
  steps: [
    {
      title: 'Long multiplication is AND and add',
      body: `
        <p>Binary long multiplication is simpler than the decimal kind you learned at school, because every digit of the multiplier is 0 or 1.
        Row i is either a (shifted i places) or zero, so it is <strong>a AND b<sub>i</sub></strong>: one AND gate per bit, called a <em>partial product</em>.</p>
        <p>Then add the rows. This 4×4 <strong>array multiplier</strong> adds row i to the running sum shifted right one place. The bit that
        falls off the bottom of each row is final: product bit i.</p>
        <div class="try">Open a row (a·b<sub>i</sub>) to see the AND gates, and an adder to see the full adders.</div>`,
      scene: () => ({ root: arrayMul(4), inputs: { a: 11, b: 13 } }),
      challenge: {
        kind: 'reach', goal: 'Make the product 0xE1 (225).',
        check: (st) => st.value('p') === 225,
        answer: 'a = b = 15: 15 × 15 = 225 = 0xE1. (225 is also 9 × 25, but 25 does not fit in 4 bits.)',
        solve: (st) => st.setInputs({ a: 15, b: 15 }),
      },
    },
    {
      title: 'The array is slow',
      body: `
        <p>At 8×8 the array is seven ripple-carry adders stacked in a staircase. The worst path ripples along a row, drops into the next, and ripples again.
        That makes 70 NAND delays, against 16 for one 8-bit adder. At 32×32 it is about 310, more than twice this CPU's entire clock period.</p>
        <div class="try">Slow motion is on. Change b from 0x01 to 0xFF and watch the activity spread down the staircase.</div>`,
      scene: () => ({ root: arrayMul(8), inputs: { a: 0xff, b: 0x01 }, animate: true }),
      actions: [{ label: 'b: 0x01 ↔ 0xFF', run: (st) => st.setInputs({ b: st.getInput('b') === 1 ? 0xff : 1 }) }],
    },
    {
      title: 'Carry-save: add three, keep two',
      body: `
        <p>The trick is to stop propagating carries. A row of full adders with nothing connected between neighbours takes <strong>three</strong>
        numbers and returns <strong>two</strong>: the sum bits and the carry bits (worth twice as much). x + y + z = s + 2c,
        exactly, in a single full-adder delay at any width. This is a <em>carry-save adder</em>, or 3:2 compressor.</p>
        <p>Only the very last addition needs a real carry-propagate adder.</p>`,
      scene: () => ({ root: csa(4), inputs: { x: 5, y: 6, z: 7 } }),
      challenge: {
        kind: 'quiz', question: 'x = 5, y = 6, z = 7. The CSA outputs s = 4 and c = 7. What is x + y + z?',
        options: ['11', '18', '4 + 7 = 11 with a carry lost', '25'], answer: 1,
        explain: 'c has weight 2: x + y + z = s + 2c = 4 + 14 = 18. Nothing is lost, only postponed: the carries are kept in a separate word instead of being propagated.',
      },
    },
    {
      title: 'The Wallace tree',
      body: `
        <p>Now produce <em>all</em> partial products at once, and feed them to layers of compressors: 8 words → 6 → 4 → 3 → 2 in four levels,
        each one full-adder delay. One fast adder (the Kogge–Stone from chapter 15) adds the last two words.</p>
        <p>Each compressor row only builds the columns its three words actually cover: full adders where three bits meet,
        half adders where two do, plain wires elsewhere. This is the Wallace tree; Dadda's variant schedules the same cells a little more
        cleverly, using fewer half adders.</p>
        <div class="try">Open a 3:2 block to see which columns it reduces.</div>`,
      scene: () => ({ root: treeMul(8), inputs: { a: 0xb7, b: 0x5d } }),
    },
    {
      title: 'Cost versus speed',
      body: `
        <p>Measured from the netlists: the tree is about as large as the array, but its depth grows with log n, not n.
        A 32×32 tree multiplier is about as deep as a single 32-bit ripple adder.</p>`,
      widget: mulComparison,
    },
    {
      title: 'Signed products: Baugh–Wooley',
      body: `
        <p>Two's complement gives the top bit a <em>negative</em> weight, so partial products that pair one sign bit with a normal bit are negative.
        Baugh and Wooley's trick: <strong>invert those bits</strong> (NAND instead of AND) and add the constant 2<sup>n</sup> + 2<sup>2n−1</sup>.
        The tree, the adder and the cost do not change.</p>
        <div class="try">a = 0xF9 is −7 and b = 3: the product reads 0xFFEB = −21. Open the rows: the last one is almost all NANDs.</div>`,
      scene: () => ({ root: treeMul(8, true), inputs: { a: 0xf9, b: 3 } }),
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
      },
    },
    {
      title: 'Booth recoding',
      body: `
        <p>Fewer partial products means a shallower tree. <strong>Radix-4 Booth recoding</strong> scans the multiplier two bits at a time, with one bit of overlap,
        and turns each group into a digit from {−2, −1, 0, +1, +2}. Every digit selects an easy partial product: zero, a, 2a (a shift), or their negations
        (invert, plus one carried into the tree). So there are n/2 rows instead of n.</p>
        <p>This encoder is the logic for one digit: two XORs, a NAND, an inverter and two ANDs.</p>
        <div class="try">Try 011 (+2), 100 (−2) and 111 (0).</div>`,
      scene: () => ({ root: BOOTH_ENC, inputs: { b1: 0, b0: 1, bm: 1 } }),
    },
    {
      title: 'Booth, worked',
      body: '<p>Every 8-bit multiplier becomes four digits. Negative numbers need no special handling.</p>',
      widget: boothWidget,
    },
    {
      title: 'Division: one restoring step',
      body: `
        <p>Long division in binary also has only 0 or 1 as each quotient digit: <em>does the divisor fit?</em> One step shifts the next dividend bit into
        the partial remainder (r2 = 2r + bit), subtracts the divisor, and looks at the borrow. No borrow: it fits, so keep the difference and emit
        quotient bit 1. Borrow: restore r2 and emit 0.</p>
        <div class="try">r = 1, qin = 1 gives r2 = 3, and d = 3 fits: rout = 0, q = 1. Now set d = 4.</div>`,
      scene: () => ({ root: divStep(4), inputs: { r: 1, qin: 1, d: 3 } }),
    },
    {
      title: 'The array divider',
      body: `
        <p>Four steps in a row make a 4-bit divider, most significant quotient bit first. Unlike multiplication, nothing can be done in parallel:
        each step needs the remainder from the one before. The delay is n full subtractions. At 32 bits that is over 2 000 NAND delays,
        hopeless in one clock cycle.</p>
        <p>Dividing by zero falls out naturally: the divisor always "fits", so the quotient is all ones and the remainder is the dividend. RISC-V
        specifies exactly these results, so division never traps.</p>`,
      scene: () => ({ root: arrayDiv(4), inputs: { a: 13, b: 3 } }),
      challenge: {
        kind: 'reach', goal: 'Divide by zero: set b = 0 and read q and r.',
        check: (st) => st.getInput('b') === 0 && st.value('q') === 15,
        answer: 'b = 0: every step "fits", so q = 1111₂ = 15 (−1 as a signed number) and r = a. These are exactly the results RISC-V requires.',
        solve: (st) => st.setInputs({ b: 0 }),
      },
    },
    {
      title: 'The iterative divider',
      body: `
        <p>So reuse <em>one</em> step, once per clock. Three registers hold the remainder, the divisor, and a shift register that starts as the
        dividend: its top bit feeds the step, and the new quotient bit enters at the bottom. A counter stops after n steps.
        An 8-bit division takes 10 cycles: load, 8 steps, done.</p>
        <div class="try">start = 1 is already set. Pulse the clock and watch q fill up from the right, one bit per cycle.</div>`,
      scene: () => ({ root: seqDivider(8), inputs: { a: 200, b: 7, start: 1, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Clock the divider until done = 1, with q = 28 and r = 4 (200 / 7).',
        check: (st) => st.value('done') === 1 && st.value('q') === 28 && st.value('r') === 4,
        answer: 'Nine pulses: the first loads the operands, the next eight each make one quotient bit, and then done is high for one cycle (the tenth).',
        solve: (st) => { st.runCycles(9); },
      },
    },
    {
      title: 'The M unit',
      body: `
        <p>Here is everything together, as the CPU uses it. funct3 picks the operation. <strong>Multiplies</strong> go through the 33×33 tree
        (about 13 900 NANDs) and finish in the same cycle. <strong>Divides</strong> strip the signs (conditional negators), run the 32-bit
        iterative divider, and put the sign back: the quotient is negative if the signs differ (unless b = 0), and the remainder takes the dividend's sign.
        While a divide runs, <code>stall</code> holds the CPU for 33 extra cycles.</p>
        <div class="try">Set funct3 = 4 (div) and pulse until stall drops: −7 / 3 = −2 (0xFFFFFFFE).</div>`,
      scene: () => ({ root: MDU, inputs: { a: 0xfffffff9, b: 3, funct3: 0, isM: 1, noTrap: 1, clk: 0 } }),
    },
    {
      title: 'RV32IM',
      body: `
        <p>The complete system CPU with the M unit beside the result multiplexer: about 104 000 NANDs, 25 % more than without it, still checked
        against the golden model on every instruction. The timing panel shows the cost in speed: <strong>one NAND delay</strong> (126 → 127).
        The critical path does not even pass through the multiplier. The tree is shallow enough to hide behind the existing
        branch-and-trap decision, which now ends through the new stall logic in the register file's write enable. Press "Highlight path" to see it.</p>
        <p>A divide holds the PC and the register write (the CPU's <code>retire</code> output goes low) for 33 cycles. An interrupt that arrives in the
        meantime waits for the divide to finish.</p>
        <div class="try">Run the program: each digit costs a <code>remu</code> and a <code>divu</code>, 68 cycles. Also try "RV32M corner cases".</div>`,
      scene: () => cpuScene({ source: msrc('factorial'), system: true, m: true, timing: true, highlight: ['md', 'mres'] }),
      challenge: {
        kind: 'reach', goal: 'Run until 8! = 40320 has been printed (the loop counter s1 reaches 9).',
        check: (st) => { try { return st.sim ? cpuState(st.sim).x[9] >= 9 : false; } catch { return false; } },
        answer: 'Press "Run to halt": about 1 600 cycles for 293 instructions, CPI 5.5. The 20 digits cost 40 divides × 34 cycles, 1 360 cycles of division alone. This is why compilers turn division by a constant into a multiply by its reciprocal.',
        // the panel's Run button animates without freezing the page
        solve: () => { [...document.querySelectorAll<HTMLButtonElement>('.cpu-panel button')].find((b) => b.textContent === 'Run to halt')?.click(); },
      },
    },
    {
      title: 'What it costs a program',
      body: `
        <p>Real processors pipeline the multiplier (3 or 4 stages, one result per cycle) and use faster dividers: radix-4 or SRT dividers
        that make 2 or more quotient bits per cycle, still taking 10 to 40 cycles. Division is rare enough that nobody spends the area to make it fast.</p>`,
      challenge: {
        kind: 'quiz', question: 'On this CPU, a loop body has 20 instructions, one of which is a divide (34 cycles; everything else takes 1). What is the CPI?',
        options: ['1.0', '1.65', '2.65', '34'], answer: 2,
        explain: '19 instructions × 1 cycle + 1 divide × 34 cycles = 53 cycles for 20 instructions: CPI = 2.65. One instruction in twenty makes the loop 2.65× slower. That is why compilers replace division by a constant with a multiply by its reciprocal (a mulh and a shift), and why fast cores spend area on faster dividers.',
      },
    },
  ],
};
