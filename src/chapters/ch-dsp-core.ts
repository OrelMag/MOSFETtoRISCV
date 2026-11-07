// A DSP core (level Signal processing): what does a processor look like when the loop is the point? Our own 16-bit core with 24-bit instructions, built in gates
// (lib/dsp24*.ts), compared with its golden model (dsp/iss24.ts) after every clock (tests/dsp-core-lockstep.test.ts), against the MAC chapter's RV32 machines.
// Every figure is measured: src/bench/dspcore.json (scripts/dsp/dspcore-bench.ts) and src/dsp/macbench.json.

import { INSTRS24 } from '../dsp/isa24';
import { aguWidget, benchWidget, dspApi, dspPerProduct, dspScene, FIG, fftWidget, instrTable, loopWidget, rvFigure, rvPerProduct, rvWithoutDm } from '../widgets/dspcore';
import { numOf } from './order';
import type { Chapter } from './types';
import { groupNum } from '../sim/numfmt';

const n0 = (x: number) => groupNum(x);
const f2 = (x: number) => x.toFixed(2);

export const chDspCore: Chapter = {
  id: 'dspcore', num: numOf('dspcore'), title: 'A DSP core', level: 'Signal processing',
  blurb: 'What does a processor look like when the loop is the point? A small core of our own in gates: two memories read in one clock, address generators that step as they are read, a loop with no branch, and the MAC. Its filters, an FFT, and a measured comparison with the RV32 machines.',
  goals: [
    'say what a load-store machine spends on each tap, and what a DSP core takes out of the loop',
    'read an address generator: post-increment, a circular window, bit-reversed order, and what each costs in gates',
    'follow a hardware loop: start, end and count, and why it adds no instruction',
    'compare the core with the RV32 machines per product, in clocks and in time, and say what a real DSP pipelines that this one does not',
  ],
  builds: ['mac', 'cpu', 'fixed', 'firdesign'],
  recap: {
    keep: [
      'A tap on a load-store machine is a load for each operand, two pointer steps, the multiply-accumulate and a branch. The DSP core folds the pointer steps into the access and the branch into a loop register, so the loop body is the multiply-accumulate alone.',
      'Two memories with two address buses let one instruction read a sample and a coefficient in the same clock. One memory would need two clocks, and a cache cannot give back what two ports give.',
      'An address generator is a few registers and an adder beside the memory. Circular mode compares the next address with the end of the window, so a delay line needs no shifting. Bit-reversed mode adds in reverse, so an FFT\'s shuffle needs no loop of its own.',
      'The hardware loop holds a start, an end and a count. At the end address the PC goes back to the start without a fetch or a branch. It nests no deeper than one level, because each deeper level needs three more registers and a stack.',
      'The measured clocks a product are 1.05 to 1.52 on this core, not 1: the loop\'s set-up, the rounding and the output each cost a clock per output. And the core is slower to clock than the RV32, because a clock covers the ROM, the decode, the address, the memory, the multiplier and the adder in one go. A real DSP pipelines that path, and pays in branch and load delay slots.',
    ],
    check: [
      {
        question: 'A 64-tap filter inner loop runs on the DSP core. What is in the loop?',
        options: ['One mac instruction', 'Two loads, two pointer steps, a mac and a branch', 'A mac and a branch on the count', 'A mac and a pointer step'],
        answer: 0,
        explain: 'The pointers step as the mac reads them, and the loop unit sends the PC back with no branch. The loop is one instruction long, so a tap costs one clock.',
        why: ['', 'That is the RV32 with a MAC unit. It is where the six clocks a tap came from.', 'There is no branch: the loop unit holds the count.', 'The step is part of the access: the mode in the operand does it.'],
      },
      {
        question: 'Why does a circular window make a delay line cheaper?',
        options: ['The newest sample overwrites the oldest and nothing moves', 'It needs no memory', 'It lets the multiplier run faster', 'It makes the address a constant'],
        answer: 0,
        explain: 'Shifting a delay line would cost N moves a sample. With a circular window the pointer wraps at the end, and only one word is written per sample.',
        why: ['', 'The samples still have to be kept somewhere.', 'The multiplier does not see the window.', 'The address changes at every access: it steps and wraps.'],
      },
      {
        question: 'The FFT reads its input in bit-reversed order. What does the address generator do about it?',
        options: ['It adds the modifier with the carry running the other way', 'It reads the memory backwards', 'It stores the table of orders in the ROM', 'It runs the FFT in the opposite direction'],
        answer: 0,
        explain: 'Reverse the bits of the address, add the reversed modifier, reverse back. With the modifier 32 that counts 0, 32, 16, 48, … for 64 points, using an adder and wiring.',
        why: ['', 'Backwards would be descending addresses, not a bit-reversed pattern.', 'A table of 64 orders would cost a ROM; this costs wires.', 'The direction of the transform is unrelated to the order the inputs are read in.'],
      },
    ],
    practise: [],
  },
  steps: [
    {
      title: 'What a loop costs',
      get body() {
        const a = rvPerProduct('rv32im', 'fir64'), b = rvPerProduct('mac', 'fir64'), c = rvPerProduct('mac2u', 'fir64');
        return `
        <p><a href="#/c/mac/1">Chapter ${numOf('mac')}</a> measured the RV32 filtering. With a multiplier the loop is ${f2(a)} clocks a product. With a MAC instruction it is ${f2(b)}, because two loads, two pointer steps and a branch still surround every product. Even packing two samples in a word, the best case there, leaves ${f2(c)} clocks.</p>
        <p>That overhead is what a DSP core removes. The product is already one instruction. What is left is <strong>fetching two operands</strong>, <strong>moving two pointers</strong> and <strong>counting</strong>. Do them as part of the multiply-accumulate and there is nothing else in the loop: one clock a tap is possible. The rest of this chapter builds the three pieces and measures what they cost.</p>
        <p>The bar chart below shows the inner loop for a filter of any length. The DSP core's bar is a sample's N + 7 clocks spread over its N taps: the loop's N, and seven more for the load, the store, the loop set-up, the round, the output, the count and the branch. The RV32 bars are the MAC chapter's 64-tap measurements, with the packed layout for the last of them.</p>
        <div class="try">Slide the taps from 2 up to 128. How many taps does it take for the loop's set-up to stop mattering?</div>`;
      },
      widget: loopWidget,
      challenge: {
        kind: 'quiz', question: 'A load-store machine with a MAC unit still needs about six clocks a tap. Where do they go?',
        options: ['Loads, pointer steps and the branch', 'The multiplier itself', 'The 40-bit accumulator', 'The rounding'],
        answer: 0,
        explain: 'The multiply-accumulate is one clock. The other five are the instructions that bring its operands and close the loop.',
        why: ['', 'It is one instruction, and one clock.', 'The accumulator adds in the same clock as the multiply.', 'Rounding happens once per output, not per tap.'],
      },
    },
    {
      title: 'Two memories, two buses',
      get body() {
        return `
        <p>The core is single-cycle, like <a href="#/c/cpu/1">chapter ${numOf('cpu')}</a>'s CPU, with 16-bit data and 24-bit instructions. The picture reads left to right: the sequencer and program memory fetch, the decoder turns the word into controls, an <strong>address generator</strong> for each memory feeds <strong>X</strong> (samples) and <strong>Y</strong> (coefficients), both read in the same clock, and the <a href="#/c/mac/1">MAC of chapter ${numOf('mac')}</a> multiplies them. Registers and a 16-bit ALU sit beside it for everything else.</p>
        <p>The MAC is that chapter's block <em>unchanged</em>, behind a small adapter that places a 16-bit word in its low half and clamps its 32-bit read to 16 bits. The price of reusing it unchanged is its second multiplier, which this core never uses: ${n0(FIG.nands.secondMultiplier)} of the unit's ${n0(FIG.nands.macUnit)} NANDs. The whole core without memories is <strong>${n0(FIG.nands.core)} NANDs</strong>, with a clock of ${FIG.period} NAND delays. The decoder is only ${n0(FIG.nands.decode)}, the registers ${n0(FIG.nands.regs)} and the ALU ${n0(FIG.nands.alu)}.</p>
        <p>Run the dot product. The panel steps a golden model beside the gates and compares every register after every clock.</p>
        <div class="try">Press Run to halt. The panel should say "matches golden model" after ${FIG.cycles.dot.cycles} clocks, and the accumulator holds the 128-element dot product.</div>`;
      },
      scene: dspScene('dot'),
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run the dot product to its halt with the gates agreeing with the model at every clock.',
        check: (st) => { const a = dspApi.get(st); return !!a && a.halted() && a.agrees(); },
        hints: ['The Run to halt button is at the top of the panel.'],
        answer: `The program is a clear, a loop of 128 mac instructions, two reads of the accumulator and a halt: ${FIG.cycles.dot.cycles} clocks.`,
        solve: (st) => { dspApi.get(st)?.run(); },
      },
      tries: [(st) => { const a = dspApi.get(st); return !!a && a.halted() && a.agrees(); }],
    },
    {
      title: 'Address generators',
      get body() {
        return `
        <p>An <strong>address generator</strong> is four 8-bit pointers, a window (base and length) and a modifier, with an adder beside them. The instruction names a pointer and a mode: <code>x(p0)+</code> reads at p0, then adds 1 to it in the same clock. The modes are plus 1, minus 1, plus or minus the modifier, circular in either direction, and bit-reversed. Each generator costs ${n0(FIG.nands.agu)} NANDs, of which the step logic alone is ${n0(FIG.nands.aguStep)}.</p>
        <p><strong>Circular:</strong> a filter keeps its last N samples. Shifting them costs N moves a sample. In a circular window, the next address is compared with the window's end, and when they are equal it is replaced by the base. The new sample overwrites the oldest, and nothing else moves.</p>
        <p><strong>Bit-reversed:</strong> an FFT wants its input in the order whose index bits are reversed. Reverse the pointer's bits, add the reversed modifier, reverse back; the reversals are wiring, so the cost is one 8-bit adder.</p>
        <div class="try">Pick the circular mode with base 4 and length 6, then bit-reversed with m = 32. Watch where the run goes.</div>`;
      },
      widget: aguWidget,
      challenge: {
        kind: 'quiz', question: 'A circular window with base 4 and length 6, pointer at 9, mode +c. Where does it go?',
        options: ['4', '10', '3', '0'],
        answer: 0,
        explain: 'The window is 4 to 9. The next address, 10, equals base + length, so the pointer wraps to the base.',
        why: ['', '10 is the end of the window, not inside it.', 'The base is 4. 3 is below the window.', 'Only a pointer at 255 wraps to 0.'],
      },
    },
    {
      title: 'A loop with no branch',
      get body() {
        return `
        <p>The <strong>loop unit</strong> is a start register, an end register, a count and an active flag, and ${n0(FIG.nands.loop)} NANDs. The <code>loop 16, tap</code> instruction loads them: the start is the next instruction, the end is the label, the count is 16. When the PC reaches the end address of an active loop, the next PC is the start, unless the count is 1; then the loop is over and the PC goes on. There is no branch instruction in the loop and no fetch to make the jump. A one-instruction loop is one clock an iteration.</p>
        <p>The loop goes back ahead of any jump at its last instruction, and a halt inside changes nothing. It is one level deep. A second level would need another start, end and count, and a way to restore the first. The benchmarks that need an outer loop, such as one pass per output sample, use a branch for it, and pay for it once per output.</p>
        <p>The scene opens the unit in the sequencer. Run the FIR 16 for a few clocks and watch the count go down at the end address.</p>
        <div class="try">Step with the clock until the count is below 16.</div>`;
      },
      scene: dspScene('fir16', ['seq', 'loop']),
      lit: '',
      challenge: {
        kind: 'quiz', question: 'What does the loop unit do when the PC reaches the end address and the count is 1?',
        options: ['The loop ends and the PC goes on', 'It goes back once more', 'It halts the core', 'It reloads the count'],
        answer: 0,
        explain: 'The count is the number of passes still to make, this one included. At 1 this was the last, so the active flag clears.',
        why: ['', 'The count was 16 for 16 passes. At 1 the 16th pass is the one ending.', 'Halting is a separate instruction.', 'Only a new loop instruction loads it.'],
      },
    },
    {
      title: `${INSTRS24.length} instructions`,
      get body() {
        return `
        <p>The instruction word is 24 bits: 5 for the operation, then fields placed where the decoder wants them. A multiply-accumulate names an X operand and a Y operand, each a pointer and a mode: <code>mac x(p0)+c, y(p4)+c</code>. The core's instruction set is ours, not any real DSP's. It has ${INSTRS24.length} instructions, and the decoder behind them is only ${n0(FIG.nands.decode)} NANDs.</p>
        <p>It would not fit the Custom ISA tables of the sandbox, which name an operand and a bit pattern: here an operand is a pointer and a mode in one token, and <code>mov</code> splits its register numbers across two fields. So the core has an assembler of its own, which the sandbox's ROM editor knows.</p>
        <p>The fields, most significant bit first:</p>
        <div class="dsp-scroll"><table class="dsp-table"><thead><tr><th>form</th><th>23–19</th><th>18–16</th><th>15–13</th><th>12–10</th><th>9–8</th><th>7–5</th><th>4–3</th><th>2</th><th>1–0</th></tr></thead><tbody>
        <tr><td><code>add</code> and the ALU</td><td>op</td><td>rd</td><td>ra</td><td>rb</td><td colspan="5">0</td></tr>
        <tr><td><code>mac</code></td><td>op</td><td colspan="2">0</td><td>X mode</td><td>X ptr</td><td>Y mode</td><td>Y ptr</td><td colspan="2">0</td></tr>
        <tr><td><code>ld</code>, <code>st</code></td><td>op</td><td>rd</td><td>ra (st)</td><td>mode</td><td>ptr</td><td colspan="2">0</td><td>X / Y</td><td>0</td></tr>
        <tr><td><code>ldi</code></td><td>op</td><td>dst low</td><td colspan="7">dst high in 15–14, the 14-bit constant in 13–0</td></tr>
        <tr><td><code>loop</code></td><td>op</td><td colspan="8">bit 18: a register (in 15–13) or a constant count in 17–8; the end address in 7–0</td></tr>
        </tbody></table></div>
        ${instrTable()}
        <p>The accumulator is read by <code>rnd</code>, which shifts, rounds half up once and clamps to 16 bits, and by <code>rndc</code>, which also clears it in the same clock: the next output's first <code>mac</code> then needs no <code>clr</code>.</p>`;
      },
      challenge: {
        kind: 'quiz', question: 'Why is there a rndc instruction beside rnd?',
        options: ['It clears the accumulator in the same clock, saving a clock an output', 'It rounds differently', 'It reads the accumulator twice', 'It is needed for negative numbers'],
        answer: 0,
        explain: 'The MAC unit reads its accumulator and clears it at the same edge, so an output costs no separate clear.',
        why: ['', 'Both round half up, once.', 'There is one read.', 'Sign makes no difference to either.'],
      },
    },
    {
      title: 'A filter, a tap a clock',
      get body() {
        const f = FIG.cycles.fir16, g = FIG.cycles.fir64;
        return `
        <p>A streaming FIR: the delay line is a circular window of X, the newest sample overwrites the oldest, the taps wait in Y in reverse, and the inner loop is one instruction, <code>mac x(p0)+c, y(p4)+c</code>, N times. Around it are a load and a store for the new sample, the round and clear, an output and the count: <strong>N + 7 clocks</strong> a sample.</p>
        <p>That is ${f2(dspPerProduct('fir16'))} clocks a tap for 16 taps (${f.cycles} clocks for ${f.outs} samples), and ${f2(dspPerProduct('fir64'))} for 64 taps (${n0(g.cycles)} clocks). It approaches 1 as the filter lengthens, and not before. The overhead is real, and the comparison with the RV32 machines in the last step includes it.</p>
        <div class="try">Press Run to halt. ${f.outs} output words come out, and the model agrees with the gates all the way.</div>`;
      },
      scene: dspScene('fir16'),
      lit: '',
      challenge: {
        kind: 'reach', goal: 'Run the 16-tap filter to its halt, with the model agreeing at every clock.',
        check: (st) => { const a = dspApi.get(st); return !!a && a.halted() && a.agrees() && a.outs().length === FIG.cycles.fir16.outs; },
        hints: ['Run to halt is at the top of the panel.'],
        answer: `${FIG.cycles.fir16.cycles} clocks, ${FIG.cycles.fir16.outs} outputs.`,
        solve: (st) => { dspApi.get(st)?.run(); },
      },
      tries: [(st) => { const a = dspApi.get(st); return !!a && a.halted() && a.agrees(); }],
    },
    {
      title: 'The FFT',
      get body() {
        return `
        <p>A 64-point FFT touches both ideas. The input is copied into bit-reversed order by the address generator, one loop of 64 iterations. Then six stages of butterflies, each a loop of <code>mac</code> pairs that use the twiddle table in Y, with the modifier set to the stage's stride.</p>
        <p>The whole transform takes <strong>${n0(FIG.cycles.fft.cycles)} clocks</strong>: ${FIG.cycles.fft.macs} multiply-accumulates, and the rest is loads, stores and adds. A butterfly is 16 clocks here, because the core has one memory write port and one ALU. Real DSPs do a butterfly in a handful of clocks. The result below is the model's, which the gates equal, and the tones sit where they were put.</p>
        ${''}`;
      },
      widget: fftWidget,
      challenge: {
        kind: 'quiz', question: 'Which two ideas of the address generator does the FFT use?',
        options: ['Bit-reversed order, and a modifier for the twiddle stride', 'A circular window and a hardware loop only', 'Two memories and nothing else', 'Post-decrement and saturation'],
        answer: 0,
        explain: 'Bit-reversed addressing does the copy, and the modifier steps the twiddle pointers by the stage\'s stride. The loop unit runs the butterflies.',
        why: ['', 'The loop is used, but the window is not.', 'Both memories are used, but so are the generators\' modes.', 'Saturation is the ALU\'s, and the FFT uses none.'],
      },
    },
    {
      title: 'Against the RV32 machines',
      get body() {
        const dsp = rvFigure('rv32im');
        return `
        <p>Per product, so the machines' different block lengths do not matter. The DSP core is the winner in clocks everywhere, but its clock is longer: ${FIG.period} NAND delays against ${rvFigure('mac').period} for the MAC cores (${f2(FIG.period / rvFigure('mac').period)} times) and ${dsp.period} for the RV32IM, which has faster adders, since one clock reaches from the ROM through decode, the pointer, the memory, the multiplier and the accumulator. Time per product is the product of the two, and that is what the table gives.</p>
        <p>The FFT has no RV32 figure to compare with, since the MAC chapter did not run one. The core is ${n0(FIG.nands.core)} NANDs without memories. The RV32IM is ${n0(dsp.nands)} with its 32-word data memory and 32 × 32 registers, and ${n0(rvWithoutDm('rv32im'))} without the data memory, so the core is about ${f2(rvWithoutDm('rv32im') / FIG.nands.core)} times smaller than it, and ${f2(rvWithoutDm('mac') / FIG.nands.core)} times smaller than the MAC core (${n0(rvWithoutDm('mac'))}). Nearly half of that is the MAC (${n0(FIG.nands.mac)} NANDs), with its idle second multiplier, which is the price of reusing the block unchanged.</p>
        <p><strong>What a real DSP does.</strong> It pipelines this path: fetch, decode, address, memory, multiply, accumulate in stages, each short, so the clock is several times faster. The costs are visible in the programmer's model: the instruction after a branch still runs (a delay slot), a loaded value is not there for the next instruction, and the loop must be set up some instructions before it starts. This core pays none of those, and pays for it in the length of its clock.</p>`;
      },
      widget: benchWidget,
      challenge: {
        kind: 'quiz', question: 'The DSP core needs about 1.1 clocks a product and the RV32I with the packed MAC 2.0 on the 64-tap filter. Is it twice as fast?',
        options: ['No: its clock is longer, so compare time, not clocks', 'Yes, by exactly the ratio of clocks', 'No: it is slower', 'It depends only on the NANDs'],
        answer: 0,
        explain: 'Time is clocks times the period. A longer period eats part of the gain. The table shows the time in NAND delays.',
        why: ['', 'Only if the clocks had the same period.', 'It is still faster per product; the gain is just smaller.', 'NANDs measure area, not time.'],
      },
    },
  ],
};
