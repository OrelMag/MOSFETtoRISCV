// The abstraction ladder: every level of the journey, what it is built from, and the chapter that builds it.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

export interface Rung {
  title: string;
  madeOf: string;
  /** The chapter that builds this level (its id and number). */
  chapter: string;
  num: number;
}

export const LADDER: Rung[] = [
  { title: 'Memory in depth', madeOf: 'capacitors, sense amplifiers, row buffers', chapter: 'dram', num: 33 },
  { title: 'A GPU', madeOf: 'lanes, warps, a rasterizer, frame buffers', chapter: 'lanes', num: 27 },
  { title: 'A chip on a wafer', madeOf: 'standard cells, placement, routing, masks', chapter: 'silicon', num: 26 },
  { title: 'Multi-core processor', madeOf: 'cores, arbiter, atomics, coherence', chapter: 'multicore', num: 25 },
  { title: 'Floating point & caches', madeOf: 'FPU, SRAM, tag arrays, a slow memory', chapter: 'cache', num: 21 },
  { title: 'Complete RV32IM system', madeOf: 'CSRs, traps, interrupts, I/O, multiply / divide', chapter: 'io', num: 18 },
  { title: 'Pipelined RISC-V core', madeOf: 'pipeline registers, hazard unit, branch predictor', chapter: 'pipeline', num: 16 },
  { title: 'Single-cycle RISC-V CPU', madeOf: 'register file, ALU, control, memories', chapter: 'cpu', num: 14 },
  { title: 'Instruction set & assembly', madeOf: 'bits with agreed meanings', chapter: 'isa', num: 13 },
  { title: 'ALU & register file', madeOf: 'adders, muxes, registers', chapter: 'alu', num: 11 },
  { title: 'Memory arrays', madeOf: 'decoders, registers, mux trees', chapter: 'memory', num: 10 },
  { title: 'Registers & counters', madeOf: 'flip-flops', chapter: 'registers', num: 9 },
  { title: 'Latches & flip-flops', madeOf: 'gates with feedback', chapter: 'latches', num: 8 },
  { title: 'Adders, decoders, muxes', madeOf: 'gates', chapter: 'adders', num: 6 },
  { title: 'Logic gates', madeOf: 'NAND', chapter: 'gates', num: 4 },
  { title: 'NAND gate', madeOf: '4 transistors', chapter: 'nand', num: 3 },
  { title: 'MOSFET', madeOf: 'doped silicon', chapter: 'mosfet', num: 1 },
];

export function ladder(): HTMLElement {
  return h('nav', { class: 'ladder', 'aria-label': 'The journey, level by level' }, LADDER.map((r) =>
    h('a', { class: 'rung', href: `#/c/${r.chapter}/0`, title: `Chapter ${r.num}` },
      h('span', { class: 'n' }, String(r.num).padStart(2, '0')),
      h('span', { class: 't' }, r.title),
      h('span', { class: 'c' }, r.madeOf))));
}

export function journeyWidget(): Widget {
  return {
    el: h('div', { class: 'widget' },
      h('div', { class: 'panel' },
        h('h3', null, 'The ladder of abstraction'),
        h('p', { class: 'sub' }, 'Each level uses only the level below it. A rung opens the chapter that builds it.'),
        ladder())),
  };
}
