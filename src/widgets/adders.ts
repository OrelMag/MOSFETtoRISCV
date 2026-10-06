// Chapter 15 widget: four adders, measured two ways (static depth and simulated delay).

import { carrySelect, carrySkip, koggeStone, rca } from '../lib';
import { outputSettle } from '../sim/settle';
import { logicDepth, stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

/** Transitions that exercise long carries (0 → full propagate with carry-in, …) plus random ones. */
export function carryVectors(n: number, count = 300): number[][] {
  const M = 2 ** n - 1;
  let s = 3;
  const r = (k: number) => Math.floor(((s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32) * k);
  const v: number[][] = [[0, 0, 0], [M, 0, 1], [0, 0, 0], [M, 1, 0], [1, M, 0], [0, M, 1], [M, 0, 0], [M, 0, 1]];
  for (let i = 0; i < count; i++) v.push([r(M + 1), r(M + 1), r(2)]);
  return v;
}

export function adderVariants(): Widget {
  const kinds = [
    { name: 'ripple carry', make: rca, cls: 'r' },
    { name: 'carry-skip (4-bit blocks)', make: (n: number) => carrySkip(n), cls: 'r' },
    { name: 'carry-select (4-bit blocks)', make: (n: number) => carrySelect(n), cls: 'k' },
    { name: 'Kogge–Stone', make: koggeStone, cls: 'k' },
  ];
  const rows: HTMLElement[] = [];
  let maxD = 1;
  const data = [16, 32].flatMap((n) => kinds.map((k) => {
    const d = k.make(n), depth = logicDepth(d) ?? 0, dyn = outputSettle(d, carryVectors(n)).worst;
    maxD = Math.max(maxD, depth);
    return { n, k, nands: stats(d).nands, depth, dyn };
  }));
  data.forEach((d, i) => rows.push(h('tr', null,
    h('td', null, i % kinds.length === 0 ? `${d.n} bits` : ''),
    h('td', null, d.k.name),
    h('td', { class: 'num' }, String(d.nands)),
    h('td', { class: 'num' }, String(d.depth)),
    h('td', { class: 'num' }, String(d.dyn)),
    h('td', { class: 'barcell' },
      h('span', { class: 'cbar r', style: `width:${(d.depth / maxD) * 100}%;opacity:.35;display:block` }),
      h('span', { class: `cbar ${d.k.cls}`, style: `width:${(d.dyn / maxD) * 100}%;display:block;margin-top:2px` })))));
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Four adders, measured two ways'),
      h('p', { class: 'sub' }, 'Static depth: the longest path in the netlist, any input to any output. Measured: the simulator applies 300 input changes (random, plus long-carry patterns) and records when the outputs last change, in NAND delays. A sample can miss the true worst case, so the measured column is a lower bound.'),
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, h('th', null, 'width'), h('th', null, 'adder'), h('th', null, 'NANDs'), h('th', null, 'static'), h('th', null, 'measured'), h('th', null, ''))),
        h('tbody', null, rows)),
      h('p', { class: 'sub', style: 'margin-top:12px' },
        'Carry-skip is the outlier: static analysis calls it slower than ripple carry, because the ripple path through every block is still in the netlist. That path is false: whenever a block would ripple all the way through, its multiplexer has already chosen the skip. Static timing tools must be told about false paths, or they overestimate. Carry-select is honest in both columns.'))),
  };
}
