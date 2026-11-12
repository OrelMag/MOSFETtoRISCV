// "A DSP core", its last step: the same 64-point FFT on the DSP core and as compiled Python on RV32IM (chapter "spectrum"'s programs,
// dsp/fftpy.ts). The DSP figures are src/bench/dspcore.json, the RV32 ones src/dsp/fftcosts.json (the gates, cycle by cycle) and the MAC
// chapter's macbench.json (the single-cycle RV32IM's period); tests/fft-software.test.ts pins what the prose says.

import { groupNum } from '../../sim/numfmt';
import { h } from '../../ui/dom';
import type { Widget } from '../../view/stage';
import { FIG, rvFigure } from '../../widgets/dspcore';
import { numOf } from '../order';
import { fftCost, lineInstrs, partInstrs } from '../spectrum/fftsw';
import type { Step } from '../types';

const n0 = (x: number) => groupNum(x);
const BUTTERFLIES = 32 * 6;

/** The comparison's numbers: clocks, periods and time in NAND delays. */
export function fftBoth() {
  const dsp = FIG.cycles.fft.cycles, dspT = dsp * FIG.period;
  const sc = fftCost('iter', 64).kernelInstrs, scT = sc * rvFigure('rv32im').period;
  const fast = fftCost('fast', 64).kernelInstrs, fastT = fast * rvFigure('rv32im').period;
  const pipe = fftCost('iter', 64).kernel;
  const products = lineInstrs('iter', 64, 'tr =', 'ti =');
  const rev = partInstrs('iter', 64, '# bit reversal', '# stages');
  return { dsp, dspT, sc, scT, fast, fastT, pipe, products, rev, perButterfly: sc / BUTTERFLIES, dspPerButterfly: dsp / BUTTERFLIES, productsPerButterfly: products / BUTTERFLIES };
}

function bothWidget(): Widget {
  const f = fftBoth();
  const rows: [string, number, number, string][] = [
    ['DSP core', f.dsp, f.dspT, `period ${FIG.period}`],
    ['RV32IM, single cycle: in place, radix 2', f.sc, f.scT, `period ${rvFigure('rv32im').period}`],
    ['RV32IM, single cycle: radix 4, tuned', f.fast, f.fastT, `period ${rvFigure('rv32im').period}`],
  ];
  const max = Math.max(...rows.map((r) => r[2]));
  return {
    el: h('div', { class: 'widget mos sr-w' }, h('div', { class: 'panel' }, h('h3', null, 'A 64-point FFT, measured'),
      h('table', { class: 'dsp-table' },
        h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'clocks'), h('th', null, 'NAND delays'), h('th', null, ''))),
        h('tbody', null, ...rows.map(([name, c, t, note]) => h('tr', null, h('th', null, name), h('td', null, n0(c)), h('td', null, n0(t), h('br'), h('span', { class: 'sub' }, note)),
          h('td', { style: 'min-width: 8em' }, h('div', { style: `height: 0.7em; border-radius: 2px; background: var(--accent); width: ${((100 * t) / max).toFixed(1)}%` })))))),
      h('p', { class: 'sub' }, `The DSP core's clocks include copying the input into bit-reversed order and sending the 128 results out; the RV32IM's are the transform's Python lines without setting up the data or printing. On the gate-level pipeline of chapter ${numOf('pipeline')} the in-place program takes ${n0(f.pipe)} clocks.`))),
  };
}

export const FFT_BOTH_STEP: Step = {
  title: 'The same FFT on both',
  get body() {
    const f = fftBoth();
    return `
      <p>The last steps of chapter ${numOf('spectrum')} wrote the FFT in Python and compiled it for RV32IM. Its in-place radix-2 version computes this core's transform word for word: the same 64 inputs, the same Q15 twiddles, a rounding at each product pair. So the two machines can be timed on the same work.</p>
      <p>On the single-cycle RV32IM of chapter ${numOf('mac')}, one instruction a clock, the transform is <strong>${n0(f.sc)} clocks</strong> against this core's <strong>${n0(f.dsp)}</strong>: ${(f.sc / f.dsp).toFixed(1)} times as many. The core's clock is longer, ${FIG.period} NAND delays against ${rvFigure('rv32im').period}, so in time the gap is ${(f.scT / f.dspT).toFixed(1)} times. The tuned radix-4 program closes part of it: ${n0(f.fast)} clocks, ${(f.fastT / f.dspT).toFixed(1)} times the core's time. (The RV32IM figure is the MAC chapter's CPU with its 32-word data memory; the FFT needs 512 words, and a larger memory only lengthens its clock.)</p>
      <p>Where the clocks go, everything counted and divided by the ${BUTTERFLIES} butterflies: ${f.perButterfly.toFixed(0)} clocks a butterfly on the RV32IM against ${f.dspPerButterfly.toFixed(1)} here, and this core's inner loop itself is 16 instructions. The RV32IM's lines computing <code>tr</code> and <code>ti</code> take ${f.productsPerButterfly.toFixed(0)} of its clocks a butterfly: the complex product and its rounding (for each of its two parts: two multiplications, an add or subtract, the rounding constant and the shift) with the loads and the address arithmetic that feed them. This core does the products in four <code>mac</code> instructions and two <code>rndc</code>, the sum kept in the accumulator. The rest is what the address generators do for free: the indices p, q and w computed in registers, and the loop counters. The input's reordering is a loop of swaps and a counter that adds 1 at its top bit and carries downwards, ${n0(f.rev)} instructions, against the core's copy loop in bit-reversed order, 4 instructions an element and no arithmetic for the address.</p>
      <p>The RV32I with the MAC instructions of chapter ${numOf('mac')} would land in between (an argument, not measured here): its <code>mac</code> takes the product pair, but every index and loop counter stays an instruction of its own. A real DSP goes further than this core: two butterflies' worth of multipliers, a pipelined clock, and a single-cycle butterfly instruction on some.</p>`;
  },
  widget: bothWidget,
  challenge: {
    kind: 'quiz', question: 'The RV32IM spends most of a butterfly\'s instructions where?',
    options: ['Index and loop arithmetic and loads, which the DSP\'s address generators and loop unit do as part of each access', 'The four multiplications', 'Rounding: it has no rounding instruction', 'Waiting for the multiplier'],
    answer: 0,
    explain: 'The products and their rounding are a minority of the butterfly. Computing p, q and the twiddle index, stepping the loops and loading are the rest, and those are what the DSP core folds into its addressing and its loop register.',
    why: ['', 'Four mul instructions out of several dozen.', 'Rounding is an add and a shift a part: a few instructions.', 'The single-cycle RV32IM multiplies in one clock.'],
  },
};
