// Chapter 11: how long each operation takes on the 32-bit ALU, sensitized (opdelay.ts) rather than counted: the control
// input is fixed, the operands change, and the delay is the last change on the result. Ripple adder against Kogge-Stone.

import { alu } from '../lib';
import { portSettle } from '../sim/opdelay';
import { logicDepth } from '../sim/stats';
import { h } from '../ui/dom';
import type { Widget } from '../view/stage';

export const ALU_OPS: [string, number][] = [['add', 0], ['sub', 8], ['sll', 1], ['slt', 2], ['sltu', 3], ['xor', 4], ['srl', 5], ['sra', 13], ['or', 6], ['and', 7]];

/** Transitions tried per operation: carry chains both ways, full-width shifts, alternating bits. */
const pairs: [number, number][] = [[0xffffffff, 1], [0, 1], [0x80000000, 31], [0xffffffff, 0xffffffff], [0x12345678, 0x9abcdef0], [0xffffffff, 0], [0x7fffffff, 1],
  [0, 0xffffffff], [0xaaaaaaaa, 0x55555555], [1, 31], [0xffffffff, 16]];

export interface OpDelays { ops: Record<string, number>; flags: number; depth: number }
const cache = new Map<string, OpDelays>();
/** Worst measured delay of y per operation, of the flags, and the static depth, for the ripple ('rca') or Kogge-Stone ('ks') ALU. */
export function opDelays(kind: 'rca' | 'ks'): OpDelays {
  let r = cache.get(kind);
  if (!r) {
    const A = alu(32, kind);
    const ops: Record<string, number> = {};
    for (const [name, c] of ALU_OPS) ops[name] = portSettle(A, [[0, 0, c], ...pairs.flatMap(([a, b]): number[][] => [[a, b, c], [0, 0, c]])], ['y']);
    const flags = portSettle(A, [[0, 0, 8], ...pairs.flatMap(([a, b]): number[][] => [[a, b, 8], [0, 0, 8]])], ['zero', 'neg', 'ovf', 'carry']);
    cache.set(kind, (r = { ops, flags, depth: logicDepth(A) ?? 0 }));
  }
  return r;
}

export function opDelayWidget(): Widget {
  const R = opDelays('rca'), K = opDelays('ks');
  const max = Math.max(R.depth, ...Object.values(R.ops));
  const bar = (n: number, cls: string, label: string) => h('span', { class: `ff-seg ${cls}`, style: `width:${(100 * n) / max}%`, title: label });
  const rows = ALU_OPS.map(([name]) => h('tr', null, h('th', { scope: 'row' }, name),
    h('td', { class: 'ff-bar' }, bar(R.ops[name], 'add', `ripple ALU: ${R.ops[name]} delays`), h('br'), bar(K.ops[name], 'tree', `Kogge–Stone ALU: ${K.ops[name]} delays`)),
    h('td', null, String(R.ops[name])), h('td', null, String(K.ops[name]))));
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel' },
      h('h3', null, 'What each operation waits for'),
      h('p', { class: 'sub' }, `The 32-bit ALU computes every operation at once and a multiplexer picks one, so its static depth (${R.depth} delays, ${K.depth} with a Kogge–Stone adder) is the slowest unit's. Held at one control code, only the paths that code sensitizes can carry the last change: delays on the result y, worst over ${pairs.length * 2} operand transitions (carry chains, full-width shifts, alternating bits). A lower bound, from those vectors.`),
      h('p', { class: 'ff-key' }, h('span', null, h('span', { class: 'ff-seg add' }), 'ripple adder'), h('span', null, h('span', { class: 'ff-seg tree' }), 'Kogge–Stone adder')),
      h('div', { class: 'ff-scroll', tabindex: '0', role: 'region', 'aria-label': 'table: scrolls sideways on a narrow screen' },
        h('table', { class: 'ff-table ff-costs' }, h('thead', null, h('tr', null, ...['operation', 'delay', 'ripple', 'Kogge–Stone'].map((t) => h('th', { scope: 'col' }, t)))), h('tbody', null, ...rows,
          h('tr', { class: 'ff-last' }, h('th', { scope: 'row' }, 'flags'), h('td', { class: 'ff-bar' }, bar(R.flags, 'add', `ripple ALU: ${R.flags} delays`), h('br'), bar(K.flags, 'tree', `Kogge–Stone ALU: ${K.flags} delays`)), h('td', null, String(R.flags)), h('td', null, String(K.flags)))))),
      h('p', { class: 'sub' }, 'Delays in NAND delays. The flags row is zero / neg / ovf / carry of a subtraction: they come straight from the adder and the zero detector, not through the result multiplexer.'))),
  };
}
