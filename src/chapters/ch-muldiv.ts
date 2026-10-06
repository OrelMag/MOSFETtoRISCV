import { BOOTH_ENC, MDU, SRT_SELECT, arrayDiv, arrayMul, boothMul, csa, divStep, nrArrayDiv, pipeMul, popcount, seqDivider, seqMul, srt4Divider, srtDivider, treeMul } from '../lib';
import { cpuState } from '../riscv/cosim';
import { M_PROGRAMS } from '../riscv/mprograms';
import { PIPE_M_PROGRAMS } from '../riscv/pmprograms';
import { cpuScene } from '../widgets/cpupanel';
import { divComparison } from '../widgets/divide';
import { boothWidget, mulComparison } from '../widgets/muldiv';
import { mulStyles } from '../widgets/multiply';
import type { Chapter } from './types';

const msrc = (id: string) => M_PROGRAMS.find((p) => p.id === id)!.source;

export const chMulDiv: Chapter = {
  id: 'muldiv', num: 20, title: 'Multiply & divide', level: 'Arithmetic',
  blurb: 'Array and Wallace-tree multipliers, Baugh–Wooley and Booth, restoring, non-restoring and SRT division, and the M extension in the single-cycle and pipelined CPUs.',
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
      title: 'Or reuse one adder',
      body: `
        <p>The cheapest multiplier has one adder and does the rows one per clock. A 2n-bit product register starts as {0, b}. Each cycle, if its
        lowest bit is 1 the adder adds a to the upper half, and the whole register shifts right one place, the adder's carry entering at the top.
        The multiplier bits leave at the bottom as product bits come in. After n cycles the register holds a·b.</p>
        <p>8 bits: 633 NANDs and 10 cycles (load, 8 steps, done), against 1 cycle for an array several times larger. It is the multiply of
        microcontrollers without a hardware multiplier, done in software with the same loop.</p>
        <div class="try">start = 1 is set. Pulse the clock and watch p fill from the top as b drains out of the bottom.</div>`,
      scene: () => ({ root: seqMul(8), inputs: { a: 13, b: 11, start: 1, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Clock the multiplier until done = 1, with p = 143 (13 × 11).',
        check: (st) => st.value('done') === 1 && st.value('p') === 143,
        answer: 'Nine pulses: one load, eight shift-and-add steps, then done is high for one cycle.',
        solve: (st) => { st.runCycles(9); },
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
      title: 'Counting ones',
      body: `
        <p>A full adder is also a <em>counter</em>: it turns three bits of equal weight into a 2-bit count of how many are 1. That is why
        it is called a 3:2 counter as well as a 3:2 compressor. Counting all the ones in a word (<strong>population count</strong>,
        RISC-V's <code>cpop</code> in the Zbb extension) is the same problem as summing a column of partial products.</p>
        <p>This version is the plain recursive one: count each half, add the two counts with a small ripple adder. The count gains a
        bit per level: 83 NANDs and 19 gate delays for 8 bits, 449 NANDs and 35 delays for 32.</p>
        <div class="try">Open the top adder: it adds two 3-bit counts of the two nibbles.</div>`,
      scene: () => ({ root: popcount(8), inputs: { x: 0xb7 } }),
      challenge: {
        kind: 'quiz', question: 'The 32-bit popcount is 35 gate delays deep. A carry-save version compresses all 32 bits with full adders first. Roughly how deep would that tree be before the final adder?',
        options: ['About 8 full-adder levels (log base 3/2 of 32)', '32 levels, one per bit', '1 level', '5 levels exactly, like a binary tree'],
        answer: 0,
        explain: 'Each 3:2 level shrinks the number of rows by a factor of 1.5. Going from 32 one-bit rows to 2 rows takes about log₁.₅(16) ≈ 7 levels, then one fast adder. Same structure as the Wallace multiplier.',
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
      title: 'A Booth multiplier',
      body: `
        <p>Now the whole circuit. Each Booth encoder turns three overlapping bits of b into a digit; each row picks 0, a or 2a (a wire shift) and
        inverts it for a negative digit. The +1 that completes a negation is added as a separate bit, and instead of sign-extending every row
        across the full width, each row's sign bit is inverted and one constant row corrects for all of them. Then the same 3:2 tree and fast adder.</p>
        <p>Measured honestly: at 8 bits the Booth version is 1 062 NANDs and 47 delays deep, against 972 and 40 for Baugh–Wooley. Each Booth bit
        is a select and an XOR instead of one AND, and the encoders sit in front of everything. Halving the rows only pays at 32 bits
        (12 658 NANDs against 13 293), and more at 64, which is where real designs use it: fewer rows also means less wiring and power.</p>
        <div class="try">Open a row and a <code>BIT</code> cell. Then set b = 0x80 (−128): one digit of −2, the others 0.</div>`,
      scene: () => ({ root: boothMul(8), inputs: { a: 0xf9, b: 100 } }),
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
      },
    },
    {
      title: 'Pipelining the multiplier',
      body: `
        <p>A tree multiplier is one long combinational path. Put registers inside it, after the Booth rows and after the 3:2 tree, and each clock
        only has to cover one stage. 16 bits: the period drops from 67 to 41 NAND delays. Each product now takes four edges to come out (latency),
        but a new one can start every cycle (throughput). The price is about twice the area: the registers hold every row and both tree outputs.</p>
        <p>The tree is the slowest stage. A deeper pipeline would cut it in the middle; real cores use 3 to 5 multiplier stages and keep the
        integer pipeline busy with other instructions meanwhile.</p>
        <div class="try">Pulse the clock with new a and b each time: p shows the product of the operands from four edges earlier.</div>`,
      scene: () => ({ root: pipeMul(8), inputs: { a: 12, b: 11, clk: 0 } }),
    },
    {
      title: 'Four ways to multiply',
      body: '<p>The same 16×16 product, four circuits.</p>',
      widget: mulStyles,
      challenge: {
        kind: 'quiz', question: 'A loop computes 1 000 independent products. Which multiplier finishes first?',
        options: ['The pipelined one', 'The combinational Booth tree', 'The iterative one', 'They all take the same time'],
        answer: 0,
        explain: 'Independent products stream through the pipeline at one per (short) cycle: about 1 000 × 41 delays. The combinational Booth tree needs 1 000 × 67. When each product feeds the next (a dependency chain), the pipeline\'s latency of 4 × 41 = 164 per product makes it the slowest of the three trees.',
      },
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
      title: "Don't restore: non-restoring division",
      body: `
        <p>When the trial subtraction fails, restoring division puts the old remainder back (the multiplexer) and next step tries
        2r − d again. Non-restoring division keeps the negative remainder r − d instead. Next step, 2(r − d) + d = 2r − d, which is
        exactly the subtraction the restoring divider would have done. So the rule is: if the remainder is ≥ 0, subtract d, otherwise add it.
        The quotient bit is still "is the new remainder ≥ 0".</p>
        <p>The remainder is now signed (one bit wider), each row is a single adder/subtractor with its <code>sub</code> input driven by the
        previous sign, and a negative remainder at the very end needs one correction: add d once (the <code>fix</code> block).</p>
        <div class="try">Compare with the restoring array two steps back: same q and r, no multiplexers. Here (13 / 3) the last step leaves
        −2, and the correction adds 3 back to give r = 1.</div>`,
      scene: () => ({ root: nrArrayDiv(4), inputs: { a: 13, b: 3 } }),
      challenge: {
        kind: 'quiz', question: 'Is a non-restoring step faster than a restoring one?',
        options: [
          'Not much: the restore multiplexer is gone, but the add/subtract choice puts an XOR on the divisor in the same place',
          'Yes, about twice as fast, because it never restores',
          'No, it is slower because it needs an extra step',
          'Yes, because it does not need a carry chain',
        ],
        answer: 0,
        explain: 'Both steps are a full-width carry chain plus about two gates (a multiplexer after it, or an XOR before it): 27 NAND delays each at 8 bits, measured. What non-restoring buys is regularity: every step is "add ±d". That is the form that lets the next idea keep the remainder in carry-save form.',
      },
    },
    {
      title: 'SRT: a redundant quotient',
      body: `
        <p>The carry chain is the problem: each step must know the sign of a full-width sum before it can choose. SRT division
        (Sweeney, Robertson and Tocher, 1958) removes it with two ideas. First, allow quotient digits <strong>−1, 0 and +1</strong>. The
        choice then no longer has to be exact: when the remainder is near zero, either neighbouring digit keeps it in range, and the error is
        fixed by a later digit. Second, since the choice only needs a rough idea of the remainder, keep the remainder in <strong>carry-save form</strong>,
        two words whose sum is the true value. Each step is then one row of independent full adders, whatever the width.</p>
        <p>For that to work the divisor must be normalized (½ ≤ d < 1, its top bit set): the leading zeros of b are counted and both operands
        shifted. The quotient comes out as two words, the +1 digits and the −1 digits, and their difference is the answer. One carry-propagate
        addition at the end resolves the remainder; if it is negative, the usual correction applies; the remainder is shifted back.</p>
        <div class="try">start = 1 is set. Pulse the clock and watch the +1 and −1 digit registers fill (open the divider), then compare q and r.</div>`,
      scene: () => ({ root: srtDivider(8), inputs: { a: 200, b: 7, start: 1, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Clock the SRT divider until done = 1, with q = 28 and r = 4 (200 / 7).',
        check: (st) => st.value('done') === 1 && st.value('q') === 28 && st.value('r') === 4,
        answer: 'Nine pulses, the same protocol as the restoring divider: one load (which also normalizes 7 to 0b11100000), eight digits, then done.',
        solve: (st) => { st.runCycles(9); },
      },
    },
    {
      title: 'Choosing the digit',
      body: `
        <p>The digit is chosen from the shifted remainder 2w, in units of half the divisor: +1 if 2w ≥ 0, 0 if −½ ≤ 2w < 0, −1 below.
        Only the top four bits of the sum and carry words are added, so the estimate can be low by up to one unit. That is safe:
        +1 is correct anywhere in [0, 2d), and −1 anywhere in [−2d, 0); the regions overlap around zero and the 0 digit covers the gap.</p>
        <p>The circuit does not even form the 4-bit sum. It needs only its sign (a carry into bit 3, looked ahead from the bits below)
        and whether it is −1, which happens exactly when every bit pair differs. 14 NAND delays, at any operand width.</p>`,
      scene: () => ({ root: SRT_SELECT, inputs: { s: 0b1110, c: 0b0001 } }),
      challenge: {
        kind: 'reach', goal: 'Find inputs that select the digit −1 (qn = 1).',
        check: (st) => st.value('qn') === 1,
        answer: 'Any pair whose 4-bit sum is 8 to 14 (a negative estimate other than −1), for example s = 0b1000, c = 0b0000: estimate −8 halves, digit −1.',
        solve: (st) => st.setInputs({ s: 0b1000, c: 0 }),
      },
    },
    {
      title: 'Radix 4: two bits per clock',
      body: `
        <p>With digits from −2 to +2, each step retires two quotient bits. The multiples d and 2d are wires (2d is d shifted), so the
        term row is still one AND-OR per bit. The price is selection: the redundancy is smaller (ρ = 2/3: the remainder must stay within
        ±⅔ d), so the digit depends on the divisor as well. The estimate is 8 bits of the remainder (4 fractional) and the divisor is
        known to 3 bits after its leading one; for each of those 8 divisor intervals, 4 thresholds split the estimate into the 5 digits.</p>
        <p>The thresholds here are not copied from a book. Each comes from two inequalities: the smallest estimate that picks digit k must
        still allow k, and the largest that picks k − 1 must still allow k − 1, for every divisor in the interval, with the carry-save estimate
        up to 2⁄16 low. The tests check them against every reachable remainder exactly, and the divider against every 4-bit pair. A table
        built the same way, with five entries missing, was the Pentium's FDIV bug (1994).</p>
        <p>Each comparison stays in carry-save form: one 3:2 row computes s + c − m and an 8-bit adder gives its sign. A 32-bit division takes
        19 cycles of 44 NAND delays (836) against radix 2's 34 of 31 (1 054).</p>
        <div class="try">start = 1 is set. Pulse the clock: the quotient fills two bits at a time.</div>`,
      scene: () => ({ root: srt4Divider(8), inputs: { a: 200, b: 7, start: 1, clk: 0 } }),
      challenge: {
        kind: 'reach', goal: 'Clock the radix-4 divider until done = 1, with q = 28 and r = 4.',
        check: (st) => st.value('done') === 1 && st.value('q') === 28 && st.value('r') === 4,
        answer: 'Six pulses: one load, five radix-4 steps (the dividend is shifted down two places first, so 8 bits need 5 digits), then done: 7 cycles instead of 10.',
        solve: (st) => { st.runCycles(6); },
      },
    },
    {
      title: 'Dividers compared',
      body: `
        <p>The same protocol, four steps. The table is computed from the circuits on this page.</p>`,
      widget: divComparison,
      challenge: {
        kind: 'quiz', question: 'Why is the radix-4 divider slower than radix 2 at 8 bits, but faster at 32?',
        options: [
          'Its step is longer (44 against 29 NAND delays); halving the steps only pays when there are many of them',
          'Radix 4 needs more cycles at 8 bits',
          'Normalization is slower for small numbers',
          'The 8-bit version uses a ripple adder',
        ],
        answer: 0,
        explain: 'Both have a fixed overhead of load, done and one extra digit. At 8 bits radix 4 saves 3 cycles of 44 against 10 of 29: 308 against 290. At 32 bits it saves 15 cycles: 836 against 1 054. Real dividers go further: radix 8 or 16 by overlapping two or three radix-2 or radix-4 stages per cycle.',
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
    {
      title: 'M in the pipeline',
      body: `
        <p>The pipelined CPU with the M extension. The <strong>multiplier is split across two stages</strong>: E extends the operands to
        34 bits (sign or zero, as funct3 says), forms the radix-4 Booth rows and reduces them with the 3:2 tree to two 64-bit words, which ride in
        the E/M register; M adds them (a 64-bit Kogge–Stone) and picks the low or high word in place of the memory word. A multiply's result
        therefore appears where a load's does, and decode sets ResultSrc to the load path: the existing hazard unit gives a dependent instruction
        the one-cycle load-use stall and then forwards from W. Nothing new in the hazard unit.</p>
        <p>A <strong>divide</strong> runs on the radix-4 SRT divider in E. While it works, <code>divStall</code> holds PC, IF/ID and ID/EX, and
        sends bubbles into M; the result leaves through the ALU's place in E/M on the 19th cycle and is forwarded like any ALU result.</p>
        <p>Cost: 70 900 → 102 900 NANDs (+45 %, the 64-bit tree and adder dominate). Speed, with fast adders: 93 → 93 gate delays, because the
        branch-resolution path in E is longer than both units. With the balanced design (branch compare in its own unit) the period
        was 59 and becomes <strong>79</strong>: the divider's sign fix after its registers (q / r mux and a conditional negate, 70 deep)
        now sets the E/M capture, and the multiplier tree (74 into the sum register) is close behind. Real cores register the divider's result and
        cut the tree in two; here the timing panel shows the honest number.</p>
        <div class="try">Run "Multiply and divide hazards": 17 instructions in 98 cycles. Watch the pipeline diagram: one bubble after each
        dependent multiply, a long hold for each divide. Open <code>mule</code>, <code>mulm</code> and <code>dive</code> to see the parts above.</div>`,
      scene: () => cpuScene({ source: PIPE_M_PROGRAMS.find((p) => p.id === 'mhazards')!.source, pipeline: true, m: true, adder: 'ks', timing: true, highlight: ['mule', 'mulm', 'dive'] }),
      challenge: {
        kind: 'quiz', question: 'mul t0, a0, a1 is followed by add t1, t0, a0. How many cycles does the add wait, and why?',
        options: ['None: the product is forwarded from M', 'One: the product exists only at the end of M, like a loaded word', 'Two: the product must be written back first', '18: as long as a divide'],
        answer: 1,
        explain: 'The 64-bit addition happens in M, so the product is ready at the same point as a word read from memory. Decode marks a multiply as using the load path, and the load-use logic stalls the add for one cycle; then the product is forwarded from W. Splitting the multiplier costs one bubble per dependent use and keeps the clock from growing by a whole 64-bit adder.',
      },
    },
  ],
};
