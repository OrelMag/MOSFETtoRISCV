// Chapter 10 widget: what register-file ports cost, measured.

import { regfileMP } from '../lib';
import { stats } from '../sim/stats';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

export function portCost(): Widget {
  const combos: [number, 1 | 2][] = [[2, 1], [4, 1], [2, 2], [4, 2], [6, 2]];
  const data = combos.map(([r, w]) => ({ r, w, nands: stats(regfileMP(3, 8, r, w)).nands }));
  const base = data[0].nands, max = Math.max(...data.map((d) => d.nands));
  const rows = data.map((d) => h('tr', null,
    h('td', null, `${d.r} read, ${d.w} write`),
    h('td', { class: 'num' }, String(d.nands)),
    h('td', { class: 'num' }, `×${(d.nands / base).toFixed(2)}`),
    h('td', { class: 'barcell' }, h('span', { class: 'cbar k', style: `width:${(d.nands / max) * 100}%` }))));
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Register file ports, measured (8 × 8 bits)'),
      h('p', { class: 'sub' }, 'NAND count of the same eight registers with more ports. Each read port adds a multiplexer tree over every word; each write port adds a decoder and a multiplexer in front of every register.'),
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null, h('th', null, 'ports'), h('th', null, 'NANDs'), h('th', null, 'vs 2R1W'), h('th', null, ''))),
        h('tbody', null, rows)),
      h('p', { class: 'sub', style: 'margin-top:12px' },
        'In gates the growth looks gentle because the flip-flops dominate. In an SRAM array it is worse: every port adds a word line across each cell and a bit line (or two) down it, so the cell grows in both directions and its area rises roughly with the square of the port count. That is why wide superscalar cores split their register file, or duplicate it.'))),
  };
}
