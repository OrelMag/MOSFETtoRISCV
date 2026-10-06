// Chapter 20 widget: restoring, non-restoring and SRT dividers, measured from their netlists.

import { nrDivStep, nrSeqDivider, seqDivider, srt4Divider, srt4Step, srtDivider, srtStep, divStep } from '../lib';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const period = (d: ComponentDef) => analyzeTiming(flatten(d))?.period ?? 0;

export function divComparison(): Widget {
  const widths = [8, 16, 32];
  const kinds = [
    { name: 'restoring', unit: seqDivider, step: (n: number) => divStep(n), cycles: (n: number) => n + 2, cls: 'r' },
    { name: 'non-restoring', unit: nrSeqDivider, step: (n: number) => nrDivStep(n), cycles: (n: number) => n + 2, cls: 'r' },
    { name: 'SRT radix 2', unit: srtDivider, step: srtStep, cycles: (n: number) => n + 2, cls: 'k' },
    { name: 'SRT radix 4', unit: srt4Divider, step: srt4Step, cycles: (n: number) => n / 2 + 3, cls: 'k' },
  ];
  const data = widths.flatMap((n) => kinds.map((k) => {
    const u = k.unit(n), p = period(u);
    return { n, k, nands: stats(u).nands, depth: logicDepth(k.step(n)) ?? 0, period: p, cycles: k.cycles(n), time: p * k.cycles(n) };
  }));
  const maxT = Math.max(...data.map((d) => d.time));
  const rows = data.map((d, i) => h('tr', { class: i % kinds.length === 0 ? 'grp' : '' },
    h('td', null, i % kinds.length === 0 ? `${d.n} bits` : ''),
    h('td', null, d.k.name),
    h('td', { class: 'num' }, String(d.nands)),
    h('td', { class: 'num' }, String(d.depth)),
    h('td', { class: 'num' }, String(d.period)),
    h('td', { class: 'num' }, String(d.cycles)),
    h('td', { class: 'num' }, String(d.time)),
    h('td', { class: 'barcell' }, h('span', { class: `cbar ${d.k.cls}`, style: `width:${(d.time / maxT) * 100}%` }))));
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'Iterative dividers, measured'),
      h('p', { class: 'sub' }, 'Each unit as built here: NAND count of the whole divider, depth of one step, clock period from static timing (clock-to-q + logic + setup, in NAND delays), and the time for one division. From 16 bits up the restoring and non-restoring steps use a Kogge–Stone adder.'),
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null,
          h('th', null, 'width'), h('th', null, 'divider'), h('th', null, 'NANDs'), h('th', null, 'step depth'),
          h('th', null, 'period'), h('th', null, 'cycles'), h('th', null, 'time'), h('th', null, ''))),
        h('tbody', null, rows)),
      h('p', { class: 'sub', style: 'margin-top:12px' },
        'The SRT steps have the same depth at every width: no carry crosses them. Radix 4 makes each step longer (four comparisons on the estimate instead of one test) and halves the steps; it pays from 16 bits up. The radix-2 period is set by the digit selection, a few gates on four bits, plus one full adder. At 32 bits the load cycle, which normalizes b through a 64-bit shifter, becomes the longest path; real dividers give normalization a cycle of its own. The price is area: two remainder words, the normalizer, and a carry-propagate adder to finish.'))),
  };
}
