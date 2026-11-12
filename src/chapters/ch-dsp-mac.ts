// A MAC on the RV32 (level Signal processing): what is one instruction worth? A multiply-accumulate unit of our own in gates (lib/macunit.ts, 40-bit accumulator, shift / round / clamp read),
// four instructions on custom-2, the golden model and the single-cycle core in lock step (tests/dsp-mac-*.test.ts), and four filter kernels measured on gates on five machines
// (dsp/macbench.json). Every figure on the page is read from the gates or the measured file; a figure the text had expected and the gates did not give is said so.

import { ACC_BITS, accHex, FULL_SCALE, fitsBeforeWrap, MAC_F3, macProduct, raccOf, signedBits } from '../dsp/mac';
import { macPlan } from '../dsp/macbench';
import { macRead } from '../lib/macunit';
import { MAC_INSTRS } from '../riscv/isa';
import { stats } from '../sim/stats';
import { cpuState } from '../riscv/cosim';
import { cpuScene } from '../widgets/cpupanel';
import {
  alignWidget, barsWidget, benchFig, f1, f2, filterSource, FILTER_SUM, FILTER_Y, macApi, macDelta, machineCost, perProduct, readWidget, tableWidget, timePerProduct, unitNands, unitScene,
} from '../widgets/dspmac';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const n0 = (x: number) => groupNum(Math.round(x));
const F3 = (n: string) => MAC_INSTRS.find((i) => i.name === n)!.funct3!.toString(2).padStart(3, '0');
// headroom, from the model: full-scale instructions that fit (the next one wraps), and the bits a 64-tap sum of full-scale products needs
const MAC_FIT = Number(fitsBeforeWrap(macProduct(MAC_F3.mac, FULL_SCALE, FULL_SCALE)));
const MAC2_FIT = Number(fitsBeforeWrap(macProduct(MAC_F3.mac2, FULL_SCALE, FULL_SCALE)));
const TAP64_BITS = signedBits(64n * macProduct(MAC_F3.mac, FULL_SCALE, FULL_SCALE));

export const chMac: Chapter = {
  id: 'mac', num: numOf('mac'), title: 'A MAC on the RV32', level: 'Signal processing',
  blurb: 'What is one instruction worth? A multiply-accumulate unit in gates, four instructions on custom-2 and a 40-bit accumulator, then four filters measured on five machines: software multiply, RV32IM, mac, mac2 and mac2 unrolled.',
  goals: [
    'say what a filter spends its time on, and measure what a software multiply costs it on the RV32I',
    'read the MAC unit in gates: two 16 × 16 trees, a pair adder, a 40-bit accumulator and a read that shifts, rounds once and clamps once',
    'encode mac, mac2, clracc and racc on custom-2, and say what happens past 40 bits',
    'explain from measurements why mac barely helps, what mac2 changes, and what unrolling and the packed layout cost',
  ],
  builds: ['fixed', 'firdesign', 'muldiv', 'cpu', 'widths'],
  recap: {
    keep: [
      'A filter is multiply-accumulate and little else. On a core with no multiplier the multiply is a loop of shifts and adds, and it is the whole cost.',
      `The accumulator is wide so that sums do not round on the way: ${ACC_BITS} bits hold ${MAC_FIT} products of two 16-bit words (the largest is (−32768)² = 2^30) and the next one wraps, or ${MAC2_FIT} mac2 steps (up to 2^31 each). The shift, the one rounding and the one clamp happen once, when racc reads it.`,
      'Four instructions share one opcode, custom-2, told apart by funct3. Anything else on custom-2 does nothing, on the model and in the gates, so the learner\'s own instructions keep custom-1 and custom-3.',
      'mac alone saves a multiply, not the loads: two lw and two pointer steps still surround every product. mac2 does two products from the same two loads, and the packed layout is what pays for it.',
      'The numbers here were measured on gates, with each result checked against the exact answer. Where a count worked out on paper before the run was wrong, the page says so.',
    ],
    check: [
      {
        question: 'Why does racc take its shift from a register and round only once, at the end?',
        options: ['Any Q format works, and rounding each product would add noise to every tap', 'The accumulator has no room for a binary point', 'A shifter is cheaper than an adder', 'The clamp needs the shift to be 15'],
        answer: 0,
        explain: 'The accumulator holds products exactly. Dropping bits product by product would add a rounding error 64 times; dropping them once adds one. The register shift lets the same instruction serve Q15 data and Q13 coefficients alike.',
        why: ['', 'It has no binary point at all: it is a plain integer, and the shift is what places the point.', 'The 41-bit shifter is about a tenth of the unit. Cheapness is not why.', 'The clamp is to 32 bits whatever the shift is.'],
      },
      {
        question: 'A 64-tap FIR runs on mac with one sample per word. What stays in every tap\'s loop?',
        options: ['Two loads, two pointer steps and a branch', 'Only the mac', 'A shift and a round', 'A call to a multiply routine'],
        answer: 0,
        explain: 'mac replaces the multiply and the add. The operands still have to come from memory, and the loop still has to count. That is why a product costs about 6 clocks and not 1.',
        why: ['', 'It would be one clock a tap without the loads. The loads are most of the cost.', 'Those happen once per output, in racc.', 'That is what the instruction removed.'],
      },
      {
        question: 'Why does the mac2 FIR need two copies of the coefficients?',
        options: ['An even and an odd output pair the samples with the taps differently', 'The two multipliers need separate memories', 'Negative taps need their own copy', 'Packing loses the low taps'],
        answer: 0,
        explain: 'A data word holds samples 2w and 2w + 1. For an even output the taps against them start on an even index, for an odd output one lower. Two packed copies of the taps let the samples stay where they are.',
        why: ['', 'Both multipliers read the same two registers; the memory has one port.', 'A sign is just a bit of the 16-bit tap.', 'Nothing is lost: the odd copy has one half-empty word at each end.'],
      },
    ],
  },
  steps: [
    {
      title: 'What a multiply costs a filter',
      get body() {
        const a = perProduct('rv32i', 'fir64'), b = perProduct('rv32im', 'fir64'), c = benchFig('rv32i', 'fir64');
        return `
        <p>A FIR filter is a loop: fetch a sample and a tap, multiply, add to a sum. <a href="#/c/firdesign/6">The FIR chapter</a> did it with one multiplier and a counter. A processor does it with instructions, and the RV32I of <a href="#/c/cpu/1">chapter ${numOf('cpu')}</a> has no multiply instruction. The multiply is a routine: fifteen steps of "if the low bit of the tap is 1, add the sample; shift both", and a last step for the tap's sign.</p>
        <p>We ran it. On the single-cycle core in gates, the 64-tap filter's inner loop needs <strong>${f1(a)} clocks a product</strong>: ${n0(c.kernel)} clocks for ${c.products} products, the data setup taken out. A count on paper, fifteen steps of five instructions, gives about 75. The steps are six or seven, because the add is skipped only for the zero bits of a tap, and the arithmetic shifts, the counter and the branch are always there.</p>
        <p>With the M extension the same product is one <code>mul</code> and the loop is ${f1(b)} clocks a product, ${f1(a / b)} times faster. That core is the single-cycle RV32IM of <a href="#/c/widths/5">chapter ${numOf('widths')}</a> (its 32-bit build of the one drawing for both widths), since chapter ${numOf('cpu')}'s has no M option; it costs ${n0(machineCost('rv32im').nands)} NANDs against ${n0(machineCost('rv32i').nands)}, and its period is ${machineCost('rv32im').period} NAND delays against ${machineCost('rv32i').period}: larger, yet faster, because chapter ${numOf('widths')}'s core adds with Kogge–Stone adders where chapter ${numOf('cpu')}'s ripples.</p>
        <p>Both use the same exact data, and every output word is checked against integers computed independently with scipy. The taps sum to 1.0 in magnitude and the samples are 16-bit, so even a 32-bit sum cannot overflow: the machines must agree to the last bit, and they do.</p>
        <div class="try">Pick the 64-tap filter and then the dot product. The ratio between the two machines hardly moves: the multiply is the cost, whatever the kernel.</div>`;
      },
      widget: barsWidget(['rv32i', 'rv32im'], 'fir64'),
      challenge: {
        kind: 'quiz', question: 'Change the kernel from a 64-tap filter to a dot product, and the software multiply clocks a product hardly change. What does that show?',
        options: ['The multiply routine, not the loop around it, sets the cost', 'The loads dominate', 'The branch predictor decides', 'The adder is the slow part'],
        answer: 0,
        explain: 'Software multiplication is a loop of about fifteen passes per product. The loop around it is a few instructions. Change the kernel and the cost per product barely changes.',
        why: ['', 'Two loads are two clocks of about a hundred.', 'The core has no predictor; a branch costs a clock like any instruction.', 'An add per set bit is a small part of each pass.'],
      },
    },
    {
      title: 'The MAC unit, in gates',
      get body() {
        const d = macDelta();
        return `
        <p>The cure is hardware for the one operation the loop is made of. The unit below is ours, built only from earlier chapters' parts: two signed 16 × 16 <a href="#/c/muldiv/5">tree multipliers</a> (the low halves of the two operands, and the high halves), an adder for the pair of products, a 40-bit adder and register for the accumulator, and a read path at the right. ${n0(unitNands())} NANDs in all.</p>
        <p><strong>mac</strong> adds the product of the low halves to the accumulator. <strong>mac2</strong> adds both products, low × low and high × high. <strong>clracc</strong> empties it. In all three the register file's two read ports are the unit's inputs, and nothing is written back. The fourth instruction, <strong>racc</strong>, is how the accumulator leaves: shift, round, clamp, into a register. The next steps open it.</p>
        <p>Placed in the single-cycle core at the foot of the ALU's column, below the branch-target adder and to the right of the control unit, with the result mux gaining a fifth input, it adds <strong>${n0(d.nands)} NANDs</strong> to the core (both with the same memories, no program ROM) and ${d.period} NAND delay${d.period === 1 ? '' : 's'} to the clock period. The critical path is the multiplier and two adders in series; it is a little longer than the ALU's, and so it sets the period.</p>
        <div class="try">Pick mac2, leave the operands, and press Issue × 64. Then try 64 more: the accumulator wraps, and the gates and the model agree on the wrapped value.</div>`;
      },
      scene: unitScene,
      lit: '',
      tries: [(st) => (macApi.get(st)?.issued() ?? 0) >= 64],
      challenge: {
        kind: 'reach', goal: 'Make the accumulator wrap past 40 bits, with every clock agreeing with the model.',
        check: (st) => { const a = macApi.get(st); return !!a && a.agrees() && a.wrapped(); },
        hints: ['Each mac2 adds the product of two pairs of 16-bit words. Large operands add about 2^31.', 'Set all four sliders to an extreme, then press Issue × 64 a few times.'],
        answer: 'Set rs1 and rs2 both halves to −32768: every mac2 adds 2^31. After 256 of them the sum reaches 2^39, one past the largest the 40-bit register holds, and wraps to −2^39.',
        solve: (st) => { macApi.get(st)?.fullScale(); },
      },
    },
    {
      title: 'Four instructions on custom-2',
      get body() {
        const rows = MAC_INSTRS.map((i) => `<tr><td><code>${i.name === 'clracc' ? 'clracc' : i.name === 'racc' ? 'racc rd, rs1' : `${i.name} rs1, rs2`}</code></td><td>${F3(i.name)}</td><td>${{ mac: 'acc ← acc + sext16(rs1[15:0]) × sext16(rs2[15:0])', mac2: 'acc ← acc + lo × lo + hi × hi', clracc: 'acc ← 0', racc: 'rd ← clamp32(round(acc ≫ rs1[5:0]))' }[i.name]}</td></tr>`).join('');
        return `
        <p>RISC-V leaves four major opcodes for the designer, custom-0 to custom-3. <a href="#/c/simt/1">The GPU chapters</a>' lane cores decode their own instructions on custom-0, and the learner's own instructions (the sandbox's Custom instructions, introduced in <a href="#/c/cpu">chapter ${numOf('cpu')}</a>) take custom-1 and custom-3. The MAC takes <strong>custom-2</strong>, opcode 0x5B, as R-type with funct7 = 0, and funct3 tells the four apart:</p>
        <table class="dm-enc"><thead><tr><th>Assembly</th><th>funct3</th><th>Does</th></tr></thead><tbody>${rows}</tbody></table>
        <p>What the decoder does with everything else on custom-2 is part of the definition: a word with funct7 ≠ 0, or with funct3 above 3, is not a MAC instruction and <em>does nothing</em>, in the golden model and in the gates. The control unit pays about a dozen gates to check that, and a random-program test puts such words among real instructions.</p>
        <p>The control unit gains one opcode class, <code>macEn</code> (the accumulator may change at the next edge; racc never changes it) and a third bit on the result select: racc writes a register and takes the mux's fifth input. The circuit below is the core with its MAC; double-click the MAC to open it. A learner's own row on custom-2 is refused on this core, with the reason.</p>
        <p>The program on the panel's right ends with the four. Step it, and watch <code>acc</code> at the top of the register list, compared with the golden model like any register.</p>`;
      },
      scene: () => cpuScene({ source: filterSource(), mac: true, highlight: ['macu', 'ctl', 'res'], imemK: 6, dmemK: 5 }),
      lit: '',
      challenge: {
        kind: 'quiz', question: 'A word on custom-2 has funct7 = 1 and funct3 = 000. What does the core do?',
        options: ['Nothing: it is not a MAC instruction', 'A mac, ignoring funct7', 'It traps as illegal', 'A racc'],
        answer: 0,
        explain: 'The control unit sees the MAC class and then checks funct7 = 0 and funct3 < 4. Without both, macEn stays low and nothing is written. The model does exactly the same, so a mismatch cannot hide there.',
        why: ['', 'Ignoring funct7 would leave no room to add instructions later without a clash.', 'The single-cycle core has no trap logic; the system core does, and would take its illegal-instruction trap.', 'racc is funct3 = 011.'],
      },
    },
    {
      title: 'The accumulator and its read',
      get body() {
        return `
        <p>Two 16-bit words give a 32-bit product, and a filter adds up to 64 of them. So the accumulator has to be wider than a word. It is <strong>${ACC_BITS} bits</strong>: eight more than a product, enough for ${MAC_FIT} mac products of full-scale operands (each at most 2^30) or ${MAC2_FIT} mac2 steps (at most 2^31 each); the next one wraps. A 64-tap Q1.15 filter adds at most 64 × 2^30 = 2^36, which needs ${TAP64_BITS} of the ${ACC_BITS} bits, with ${ACC_BITS - TAP64_BITS} to spare: the largest sum is an eighth of the accumulator's range, 2^39. Past that it wraps as two's complement, with no flag and no clamp: a guard that saturated would need a comparator on every add, and the filter never wants one.</p>
        <p>The read happens once, when the sum is finished. <code>racc rd, rs1</code> takes the shift from the low six bits of <code>rs1</code>, shifts the accumulator right (arithmetic), adds the first bit that fell off (rounding half up, as <a href="#/c/fixed/4">chapter ${numOf('fixed')}</a> defined it), and clamps to 32 bits. The clamp is once, and at 32 bits, not 16: the word the next instruction uses as a 16-bit operand must still fit 16 bits, and that is the program's job.</p>
        <p>In gates the trick is a 41-bit shifter fed with the accumulator and one zero below it: the bit that falls out first is the rounding bit, and the rest goes to a rounder of half adders and the clamp. About ${n0(stats(macRead()).nands)} NANDs; the six stages of the shifter are most of it.</p>
        <div class="try">Take the magnitude to 38 bits at shift 15 and then lower the shift to 0: the clamp acts when the rounded value passes 32 bits. Then set the shift to 39, where only the sign and the rounding bit are left (−1 or 1 at the extremes), and to 40 or more, where the result is always 0.</div>`;
      },
      widget: readWidget,
      challenge: {
        kind: 'quiz', question: 'An accumulator holds exactly −5 and racc shifts by 1. What is the result?',
        options: ['−2', '−3', '−2.5, kept as a fraction', '−5'],
        answer: 0,
        explain: `−5 / 2 = −2.5. The first bit dropped is 1, so it is added back: floor(−2.5) = −3, plus 1 is −2. Ties round toward +∞, which is "half up", and the model's raccOf says ${raccOf(-5n, 1).y}.`,
        why: ['', 'That would be truncation of −2.5 toward −∞. Rounding adds the dropped bit back.', 'The result is an integer register.', 'That is the shift 0 result.'],
      },
    },
    {
      title: 'A filter on the CPU panel',
      get body() {
        return `
        <p>Now run one. The program below is an 8-tap filter, one output: samples and taps packed two to a 32-bit word, four <code>lw</code> pairs and four <code>mac2</code>, then <code>racc</code> at shift 15. The first lines write the data, which the core has no other way to get at: its memory starts empty.</p>
        <p>The panel at the right is the golden model beside the gates. It compares the pc, every register and the accumulator after each instruction; "✓ matches golden model" is that comparison. The answer is ${FILTER_Y}, computed here as an exact sum and rounded once.</p>
        <p>Run to halt, then look at <code>a0</code>. The whole inner part took eight loads (four pairs) and four mac2, plus the setup around them.</p>
        <div class="try">Press Run to halt. The accumulator at the top of the register list ends at 0x${accHex(FILTER_SUM)}, the exact sum of the eight products, and a0 holds ${FILTER_Y}.</div>`;
      },
      scene: () => cpuScene({ source: filterSource(), mac: true, highlight: ['macu'], imemK: 6, dmemK: 5 }),
      lit: '',
      tries: [(st) => !!st.sim && st.cycles > 0 && cpuState(st.sim).acc === FILTER_SUM && (cpuState(st.sim).x[10] | 0) === FILTER_Y],
      challenge: {
        kind: 'reach', goal: `Run the filter to its end, with a0 = ${FILTER_Y}.`,
        check: (st) => !!st.sim && st.cycles > 0 && (cpuState(st.sim).x[10] | 0) === FILTER_Y,
        hints: ['The panel has a Run to halt button.'],
        answer: `The eight products add up exactly in the accumulator; racc at shift 15 rounds the sum once. The result is ${FILTER_Y}.`,
        solve: (st) => { st.runCycles(200); },
      },
    },
    {
      title: 'Why mac alone barely helps',
      get body() {
        const m = perProduct('mac', 'fir64'), im = perProduct('rv32im', 'fir64'), m2 = perProduct('mac2', 'fir64');
        return `
        <p>Look at the loop for the 64-tap filter on <code>mac</code>: <code>lw lw mac addi addi bne</code>. It is six instructions a tap. Take out the multiply, as the M extension and mac both do, and what remains is two loads that bring in the operands, two pointer steps and the branch that counts. On RV32IM the loop is seven, <code>lw lw mul add addi addi bne</code>; mac folds the add into the multiply and keeps the other five.</p>
        <p>Measured: <strong>${f1(m)}</strong> clocks a product on mac, against ${f1(im)} with a plain <code>mul</code> on RV32IM and ${f1(perProduct('rv32i', 'fir64'))} in software. In time the order turns over: RV32IM's clock is shorter, so a product takes ${n0(timePerProduct('mac', 'fir64'))} NAND delays on mac against ${n0(timePerProduct('rv32im', 'fir64'))} with mul. Either way the MAC has not bought what it was meant to, one clock a tap; the loads are what costs now. Samples are 16 bits, and a load brings in 32. The core has word loads only, so a mac loop uses half of each load.</p>
        <p>This is the same lesson as <a href="#/c/cache/6">the cache chapters</a>: once the arithmetic is cheap, the memory system sets the speed. A DSP's answer is two memories read together; ours, in the next chapter's core, will do exactly that. Here the answer is smaller: use both halves of the word. That is <code>mac2</code>, at <strong>${f1(m2)}</strong> clocks a product, nearly twice as fast again, from the same two loads.</p>
        <div class="try">Compare the four machines on the 64-tap filter, where mac2 is the shortest bar. Then switch to the biquad: mac2's bar is now longer than mac's.</div>`;
      },
      widget: barsWidget(['rv32i', 'rv32im', 'mac', 'mac2'], 'fir64'),
      challenge: {
        kind: 'quiz', question: 'On the 64-tap filter, mac takes about as many clocks a product as RV32IM\'s mul. Why?',
        options: ['Both loops are two loads, two pointer steps, a branch and one arithmetic instruction', 'mac is a slow instruction', 'RV32IM has a faster multiplier', 'The accumulator is too narrow'],
        answer: 0,
        explain: 'Everything but the arithmetic is the same, and the arithmetic is one instruction either way. mac saves only the separate add that mul needs.',
        why: ['', 'It is one clock, like any instruction on a single-cycle core.', 'The multiplier is not the difference: both are one instruction.', 'The width of the accumulator has nothing to do with the number of clocks.'],
      },
    },
    {
      title: 'Pairs, unrolling, and the alignment trap',
      get body() {
        const u = perProduct('mac2u', 'fir64'), p = perProduct('mac2', 'fir64');
        return `
        <p>mac2 wants a word with two samples and a word with two taps. A sample array is written once, packed, and then slides: output n uses samples n to n + T − 1. Pair the samples as they sit, and a data word holds x[2w] and x[2w + 1]. The taps that meet them are different for an even and an odd output: for n even, the tap against x[2w] is at index 2w − n, even; for n odd it is odd. The pairs of taps in a word are therefore different, and the program must hold <strong>two packed copies</strong> of the coefficients, one for the even outputs and one for the odd, instead of re-packing the samples every output. The odd copy has one more word, with an empty half at each end. That is counted in the figures here.</p>
        <p>With that, the inner loop is <code>lw lw mac2 addi addi bne</code>: six clocks for two taps, ${f2(p)} a product with the outer loop. <strong>Unrolling</strong> four words a pass drops the pointer steps and the branch to once per four: fifteen clocks for eight taps, ${f2(u)} a product measured, against ${f2(macPlan('fir64', 'mac2').inner!.instructions / macPlan('fir64', 'mac2').inner!.per)} for the plain loop's six clocks for two taps.</p>
        <p>Short recursive filters do not pack well, though. A biquad's state is a few samples that change every output: re-packing them costs more than the multiply it saves. On the 4-section cascade mac2 is measured at ${f2(perProduct('mac2', 'biquad'))} clocks a product, <em>slower</em> than mac at ${f2(perProduct('mac', 'biquad'))}.</p>
        <div class="try">Slide the output index. Even outputs line a tap pair up with each word; odd ones leave half a word empty at each end.</div>`;
      },
      widget: alignWidget,
      challenge: {
        kind: 'quiz', question: 'Why is mac2 slower than mac on the biquad cascade?',
        options: ['Its state changes every sample, and packing the pairs again costs more instructions than it saves', 'mac2 is a slower instruction', 'The cascade has too few multiplies', 'It overflows the accumulator'],
        answer: 0,
        explain: 'The two delayed samples and the two delayed outputs shift on every output. Packing them back into pairs takes four instructions each, where mac simply moves registers. A long fixed array amortizes the packing; this does not.',
        why: ['', 'It is a single clock, the same as mac.', 'It has five a sample, which is plenty; the problem is the state, not the count.', '40 bits hold far more than five 16-bit products.'],
      },
    },
    {
      title: 'The measured table',
      get body() {
        const best = (b: 'fir16' | 'fir64' | 'biquad' | 'dot') => (['rv32i', 'rv32im', 'mac', 'mac2', 'mac2u'] as const).reduce((x, y) => (timePerProduct(y, b) < timePerProduct(x, b) ? y : x));
        const t = timePerProduct('rv32i', 'fir64') / timePerProduct('mac2u', 'fir64');
        return `
        <p>Everything above in one place. Each row is a machine with its own period, so the last column multiplies clocks by the period static timing gives each core: NAND delays a product. All figures are measured: the cycles on gates (one build, thirty-two programs side by side; the software-multiply machine's three long kernels are re-counted on the golden model in the test that pins them, which the gates equalled clock for clock), the NANDs from the netlists and the period from static timing.</p>
        <p>On the 64-tap filter, mac2 unrolled takes ${n0(timePerProduct('mac2u', 'fir64'))} NAND delays a product against ${n0(timePerProduct('rv32i', 'fir64'))} for software multiplication: <strong>${f1(t)} times</strong>, for ${n0(macDelta().nands)} more NANDs on a core of ${n0(machineCost('rv32i').nands)}. Against RV32IM the gain is ${f1(timePerProduct('rv32im', 'fir64') / timePerProduct('mac2u', 'fir64'))} times, on a core whose adders are different, so that comparison carries its basis with it.</p>
        <p>The quickest machine per kernel is ${(['fir16', 'fir64', 'biquad', 'dot'] as const).map((b) => `${{ fir16: '16-tap', fir64: '64-tap', biquad: 'biquad', dot: 'dot product' }[b]}: ${{ rv32i: 'RV32I', rv32im: 'RV32IM', mac: 'mac', mac2: 'mac2', mac2u: 'mac2 unrolled' }[best(b)]}`).join(', ')}.</p>
        <p>None of this is a DSP yet. The multiplier and the memory are still shared with everything else the core does, and every sample still goes through the register file. Next, a core designed around the loop.</p>`;
      },
      widget: tableWidget,
      challenge: {
        kind: 'quiz', question: 'What would make the table wrong for your own filter?',
        options: ['Data that overflows 16 bits, or taps that do not sum to about 1', 'More than 64 taps', 'Samples that are negative', 'A different clock rate'],
        answer: 0,
        explain: 'mac reads only the low 16 bits of each operand, and racc clamps to 32. A 16-bit state that leaves 16 bits is silently wrong, and a sum that needs more than 40 bits wraps. These kernels were chosen with headroom and the headroom is part of the result.',
        why: ['', `The accumulator holds ${MAC_FIT} full-scale products; more taps at smaller amplitude go on working.`, 'Sign extension is built in: operands are signed 16-bit words.', 'The table counts clocks and NAND delays, not seconds.'],
      },
    },
  ],
};

