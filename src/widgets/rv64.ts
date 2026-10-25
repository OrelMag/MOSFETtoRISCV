// Chapter 25's explorers for RV64: what each building block costs at 32 and at 64 bits.

import { h } from '../ui/dom';
import type { Widget } from '../view/stage';
import '../styles/rvc.css';

export type Growth = 'linear' | 'log' | 'square' | 'time';

export interface WidthRow {
  id: string;
  name: string;
  /** The generator, as the library names it. */
  part: string;
  growth: Growth;
  nands: [number, number];
  /** Logic depth in NAND delays; for an iterative unit, cycles per operation. null: sequential (no depth). */
  depth: [number, number] | null;
  why: string;
}

/**
 * The library's generators at n = 32 and n = 64, measured (tests/rv64.test.ts recomputes every number):
 * NANDs from stats(), depth from logicDepth() (unit delays); the divider's cycles are n + 2.
 */
export const WIDTH_COSTS: WidthRow[] = [
  { id: 'reg', name: 'Register (the PC)', part: 'register(n)', growth: 'linear', nands: [480, 960], depth: null,
    why: 'One flip-flop per bit and nothing between the bits: twice the bits, twice the gates, and no slower.' },
  { id: 'rf', name: 'Register file, 32 registers', part: 'regfile(5, n)', growth: 'linear', nands: [23141, 45957], depth: null,
    why: 'The largest block of the core. Every register doubles, and so do the two read multiplexers; the write decoder stays.' },
  { id: 'mux', name: '2:1 multiplexer', part: 'busMux2(n)', growth: 'linear', nands: [128, 256], depth: [3, 3],
    why: 'A copy of the same 3-deep selector per bit: area doubles, delay does not move.' },
  { id: 'rca', name: 'Ripple-carry adder', part: 'rca(n)', growth: 'linear', nands: [288, 576], depth: [68, 132],
    why: 'The carry crosses every bit in turn, so the delay doubles with the area: why no 64-bit core uses one.' },
  { id: 'ks', name: 'Kogge–Stone adder', part: 'koggeStone(n)', growth: 'log', nands: [878, 2062], depth: [18, 20],
    why: 'log₂ n levels of prefix cells: 64 bits add one level (two NAND delays) and a little more than twice the cells.' },
  { id: 'sh', name: 'Barrel shifter', part: 'shifter(n)', growth: 'log', nands: [901, 2053], depth: [16, 18],
    why: 'One row of multiplexers per bit of the shift amount: a sixth row for shifts up to 63, each row twice as wide.' },
  { id: 'zero', name: 'Zero test', part: 'isZero(n)', growth: 'log', nands: [94, 190], depth: [11, 13],
    why: 'An OR tree: one more level for twice the inputs.' },
  { id: 'alu', name: 'ALU (Kogge–Stone)', part: 'alu(n, \'ks\')', growth: 'log', nands: [3196, 6940], depth: [46, 50],
    why: 'Adder, shifter and the bitwise rows together: a little over twice the area, four NAND delays slower.' },
  { id: 'mul', name: 'Tree multiplier', part: 'treeMul(n, true)', growth: 'square', nands: [13293, 50313], depth: [68, 81],
    why: 'n × n partial-product bits: four times the AND gates and adders. Wallace\'s tree keeps the depth growing by a log.' },
  { id: 'div', name: 'Iterative divider', part: 'seqDivider(n)', growth: 'time', nands: [3002, 6162], depth: [34, 66],
    why: 'One restoring step reused once per quotient bit: the area doubles, and so does the time, 66 cycles instead of 34.' },
];

const GROWTH: Record<Growth, { label: string; note: string }> = {
  linear: { label: '×2', note: 'once per bit' },
  log: { label: '×2, +1 level', note: 'a tree over the bits' },
  square: { label: '×4', note: 'every bit with every bit' },
  time: { label: '×2, twice the cycles', note: 'one bit per cycle' },
};

const fmt = (n: number) => n.toLocaleString('en-US');

export function widthCostWidget(): Widget {
  let sel = 'rf';
  const rows = h('div', { class: 'w64-rows', role: 'list' });
  const note = h('div', { class: 'w64-note', 'aria-live': 'polite' });
  const render = () => {
    rows.replaceChildren(...WIDTH_COSTS.map((r) => {
      const [a, b] = r.nands;
      const bar = (v: number, cls: string, label: string) => h('div', { class: 'rvc-bar-row' },
        h('span', { class: 'rvc-bar-k' }, label),
        h('span', { class: 'rvc-bar-track' }, h('span', { class: `rvc-bar ${cls}`, style: `width:${(100 * v) / b}%` })),
        h('span', { class: 'rvc-bar-v' }, fmt(v)));
      const d = r.depth;
      const dtext = !d ? '—' : r.growth === 'time' ? `${d[0]} → ${d[1]} cycles` : `${d[0]} → ${d[1]}`;
      return h('button', {
        class: `w64-row${sel === r.id ? ' on' : ''}`, role: 'listitem', 'aria-pressed': String(sel === r.id),
        onclick: () => { sel = r.id; render(); },
      },
        h('div', { class: 'w64-head' }, h('b', null, r.name), h('code', null, r.part), h('span', { class: `w64-g g-${r.growth}` }, GROWTH[r.growth].label)),
        h('div', { class: 'rvc-bars' }, bar(a, 'b32', '32'), bar(b, 'b16', '64')),
        h('div', { class: 'w64-depth' }, h('span', { class: 'k' }, r.growth === 'time' ? 'time' : 'depth'), dtext));
    }));
    const r = WIDTH_COSTS.find((x) => x.id === sel)!;
    note.replaceChildren(h('b', null, `${r.name}: ×${(r.nands[1] / r.nands[0]).toFixed(2)} NANDs. `), r.why, h('span', { class: 'sub' }, ` (${GROWTH[r.growth].note})`));
  };
  render();
  return {
    el: h('div', { class: 'widget' }, h('div', { class: 'panel w64' },
      h('h3', null, 'The same generators at 32 and 64 bits'),
      h('p', { class: 'sub' }, 'NANDs and depth (NAND delays) as the library measures them. Each pair of bars is scaled to its own 64-bit block. Pick a block to see why it grows as it does.'),
      h('div', { class: 'w64-legend' }, h('span', null, h('i', { class: 'rvc-bar b32' }), '32 bits'), h('span', null, h('i', { class: 'rvc-bar b16' }), '64 bits')),
      rows, note)),
  };
}
