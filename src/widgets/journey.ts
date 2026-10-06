// The abstraction ladder: every level of the journey and what it is built from.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

export interface Rung {
  title: string;
  madeOf: string;
  ready: boolean;
}

export const LADDER: Rung[] = [
  { title: 'Multi-core chip on silicon', madeOf: 'cores, caches, interconnect, layout', ready: false },
  { title: 'Complete RV32I system', madeOf: 'CSRs, traps, interrupts, I/O', ready: true },
  { title: 'Pipelined RISC-V core', madeOf: 'pipeline registers, hazard unit, branch predictor', ready: true },
  { title: 'Single-cycle RISC-V CPU', madeOf: 'register file, ALU, control, memories', ready: true },
  { title: 'Instruction set & assembly', madeOf: 'bits with agreed meanings', ready: true },
  { title: 'ALU & register file', madeOf: 'adders, muxes, registers', ready: true },
  { title: 'Memory arrays', madeOf: 'decoders, registers, mux trees', ready: true },
  { title: 'Registers & counters', madeOf: 'flip-flops', ready: true },
  { title: 'Latches & flip-flops', madeOf: 'gates with feedback', ready: true },
  { title: 'Adders, decoders, muxes', madeOf: 'gates', ready: true },
  { title: 'Logic gates', madeOf: 'NAND', ready: true },
  { title: 'NAND gate', madeOf: '4 transistors', ready: true },
  { title: 'MOSFET', madeOf: 'doped silicon', ready: true },
];

export function ladder(): HTMLElement {
  return h('div', { class: 'ladder' }, LADDER.map((r, i) =>
    h('div', { class: `rung ${r.ready ? 'done' : 'soon'}` },
      h('span', { class: 'n' }, String(LADDER.length - 1 - i).padStart(2, '0')),
      h('span', { class: 't' }, r.title),
      h('span', { class: 'c' }, r.madeOf))));
}

export function journeyWidget(): Widget {
  return {
    el: h('div', { class: 'widget' },
      h('div', { class: 'panel' },
        h('h3', null, 'The ladder of abstraction'),
        h('p', { class: 'sub' }, 'Each level uses only the level below it. Solid rungs are ready to explore; dashed ones are being built.'),
        ladder())),
  };
}
