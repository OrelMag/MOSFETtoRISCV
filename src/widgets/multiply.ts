// Chapter 20 widget: five ways to multiply, measured (area, clock period, latency, throughput).

import { boothMul, pipeMul, seqMul, treeMul } from '../lib';
import { flatten } from '../sim/flatten';
import { logicDepth, stats } from '../sim/stats';
import { CLK_TO_Q, SETUP, analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

const period = (d: ComponentDef) => analyzeTiming(flatten(d))?.period ?? 0;
/** A combinational unit between registers: clock-to-q + its depth + setup. */
const between = (d: ComponentDef) => CLK_TO_Q + (logicDepth(d) ?? 0) + SETUP;

export function mulStyles(): Widget {
  const n = 16;
  const rows = [
    { name: 'iterative (shift and add)', def: seqMul(n), per: period(seqMul(n)), latency: n + 2, every: n + 2 },
    { name: 'Wallace tree, Baugh–Wooley', def: treeMul(n, true), per: between(treeMul(n, true)), latency: 1, every: 1 },
    { name: 'Wallace tree, Booth radix 4', def: boothMul(n), per: between(boothMul(n)), latency: 1, every: 1 },
    { name: 'Booth, 3-stage pipeline', def: pipeMul(n), per: period(pipeMul(n)), latency: 4, every: 1 },
  ].map((r) => ({ ...r, nands: stats(r.def).nands }));
  const maxT = Math.max(...rows.map((r) => r.per * r.every));
  const tr = rows.map((r) => h('tr', null,
    h('td', null, r.name),
    h('td', { class: 'num' }, String(r.nands)),
    h('td', { class: 'num' }, String(r.per)),
    h('td', { class: 'num' }, String(r.latency * r.per)),
    h('td', { class: 'num' }, String(r.every * r.per)),
    h('td', { class: 'barcell' }, h('span', { class: `cbar ${r.every > 1 ? 'r' : 'k'}`, style: `width:${(r.every * r.per / maxT) * 100}%` }))));
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, `${n}×${n} multipliers: area, latency, throughput`),
      h('p', { class: 'sub' }, `Measured from the netlists. Combinational multipliers are counted between registers (clock-to-q ${CLK_TO_Q} + depth + setup ${SETUP}); the others by static timing. Times are in NAND delays.`),
      h('table', { class: 'cmp' },
        h('thead', null, h('tr', null,
          h('th', null, 'multiplier'), h('th', null, 'NANDs'), h('th', null, 'period'), h('th', null, 'latency'), h('th', null, 'one product every'), h('th', null, ''))),
        h('tbody', null, tr)),
      h('p', { class: 'sub', style: 'margin-top:12px' },
        'The iterative multiplier is a third of the area and an order of magnitude slower. The pipeline keeps the tree\'s throughput at a shorter clock, paying in registers and latency: worth it when products stream (a dot product, a filter), not when each result is needed at once.'))),
  };
}
