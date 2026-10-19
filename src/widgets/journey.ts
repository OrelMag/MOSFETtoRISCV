// The abstraction ladder: every level of the journey, what it is built from, and the chapter that builds it.

import { h } from '../ui/dom';
import { settings } from '../ui/settings';
import type { Widget } from '../view/stage';

export interface Rung {
  title: string;
  madeOf: string;
  /** The chapter that builds this level (its id and number). */
  chapter: string;
  num: number;
}

export const LADDER: Rung[] = [
  { title: 'Memory in depth', madeOf: 'capacitors, sense amplifiers, row buffers', chapter: 'dram', num: 34 },
  { title: 'A GPU', madeOf: 'lanes, warps, a rasterizer, frame buffers', chapter: 'lanes', num: 28 },
  { title: 'A chip on a wafer', madeOf: 'standard cells, placement, routing, masks', chapter: 'silicon', num: 27 },
  { title: 'Multi-core processor', madeOf: 'cores, arbiter, atomics, coherence', chapter: 'multicore', num: 26 },
  { title: 'Out-of-order core', madeOf: 'renaming, issue queues, a reorder buffer, speculation', chapter: 'ooo', num: 25 },
  { title: 'Floating point & caches', madeOf: 'FPU, SRAM, tag arrays, a slow memory', chapter: 'cache', num: 22 },
  { title: 'Complete RV32IM system', madeOf: 'CSRs, traps, interrupts, I/O, multiply / divide', chapter: 'io', num: 19 },
  { title: 'Pipelined RISC-V core', madeOf: 'pipeline registers, hazard unit, branch predictor', chapter: 'pipeline', num: 17 },
  { title: 'A Python program', madeOf: 'RV32I instructions, registers, a stack', chapter: 'python', num: 15 },
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

/**
 * The rung a ladder opens at: the highest one whose chapter the visitor has opened, else the bottom
 * one (the MOSFET, where the journey starts). Its index in LADDER.
 */
export function ladderFocus(visited: (chapter: string) => boolean): number {
  const i = LADDER.findIndex((r) => visited(r.chapter));
  return i < 0 ? LADDER.length - 1 : i;
}

/**
 * The ladder, top rung first (it is built upward), in a box of its own that opens scrolled to the
 * visitor's rung: the bottom one, marked "Start here", until the first chapter is opened.
 */
export function ladder(): HTMLElement {
  const seen = (id: string) => settings.visited(id).length > 0;
  const fresh = !seen(LADDER[LADDER.length - 1].chapter);
  const focus = ladderFocus(seen);
  const rungs = LADDER.map((r, i) => {
    const start = fresh && i === LADDER.length - 1;
    return h('a', { class: `rung${start ? ' start' : ''}`, href: `#/c/${r.chapter}/0`, title: `Chapter ${r.num}` },
      h('span', { class: 'n' }, String(r.num).padStart(2, '0')),
      h('span', { class: 't' }, r.title),
      start ? h('span', { class: 'start-tag' }, 'Start here') : null,
      h('span', { class: 'c' }, r.madeOf));
  });
  const box = h('nav', { class: 'ladder', 'aria-label': 'The journey, level by level' }, rungs);
  // Fades at the edges that have more rungs past them.
  const edges = () => {
    box.classList.toggle('more-up', box.scrollTop > 2);
    box.classList.toggle('more-down', box.scrollTop + box.clientHeight < box.scrollHeight - 2);
  };
  box.addEventListener('scroll', edges, { passive: true });
  // The focus rung at the box's bottom once it has a size (it is built before the page is attached), and again
  // while sizes settle (web fonts, a phone's wrapped rungs), until the visitor scrolls it.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => {
      if (!box.clientHeight) return;
      const r = rungs[focus];
      box.scrollTop = focus === LADDER.length - 1 ? box.scrollHeight : r.offsetTop + r.offsetHeight + 24 - box.clientHeight;
      edges();
    });
    ro.observe(box);
    rungs.forEach((r) => ro.observe(r));
    for (const ev of ['wheel', 'touchstart', 'pointerdown', 'keydown']) box.addEventListener(ev, () => ro.disconnect(), { once: true, passive: true });
  }
  return box;
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
