// Appendix D's boards (DOM-free, so tests validate them): Bit Runner as built, a grid of boards with one row of chips each
// and channels between them for the wires, every chip a 74xx part of lib/bitrunner.ts at its path, every LED a net of
// the scene's simulation. A module too big for one board goes on to the next, as on a real bench.

import { BIT_RUNNER, RB_ROLES, rbChips } from '../lib/bitrunner';
import { TTL_PART, TTL_PINS } from '../lib/ttl';
import { BB, type BbBoard, type BbChip, type BbLed, type BreadboardLayout, chipSize, ledsOf, planBoard } from '../view/bblayout';
import { pinsOf } from './saplayout';

/** A board's width and clear rows above and below its chips; the channels between boards and between columns. */
const COL_W = 50, AIR = 3, GAP = 6, GUTTER = 14;
type Spec = Omit<BbBoard, 'at' | 'size'>;

function chipsOn(module: string): BbChip[] {
  return rbChips(BIT_RUNNER).filter((c) => c.path.startsWith(`${module}.`)).map((c) => ({
    path: c.path.split('.'), part: TTL_PART[c.kind], dip: TTL_PINS[c.kind].length, role: RB_ROLES[c.path], pins: pinsOf(c.kind),
  }));
}

const led = (path: string, port: string, label: string, color: BbLed['color'] = 'red', bit?: number): BbLed =>
  ({ net: { path: path ? [path] : [], port, ...(bit === undefined ? {} : { bit }) }, label, color });

const LEFT: Spec[] = [
  {
    title: 'Sync: the beam', module: ['sync'], chips: chipsOn('sync'),
    leds: [...ledsOf(['sync'], 'h', 7, 'green', (b) => (b === 6 ? 'H6–0' : '')), ...ledsOf(['sync'], 'v', 6, 'blue', (b) => (b === 5 ? 'V5–0' : '')).map((l, i) => (i ? l : { ...l, gap: true }))],
  },
  {
    title: 'Walls: a counter that slips', module: ['walls'], chips: chipsOn('walls'),
    leds: [...ledsOf(['walls'], 'wc', 6, 'yellow', (b) => (b === 5 ? 'WC5–0' : '')), { ...led('walls', 'wv', 'WALL', 'white'), gap: true }, led('walls', 'w', 'B', 'green'), led('walls', 'f', 'F', 'blue')],
  },
  {
    title: 'Gates: where and what colour', module: ['gaps'], chips: chipsOn('gaps'),
    leds: [led('gaps', 'inGap', 'GATE', 'green'), led('gaps', 'colour', 'COL', 'yellow')],
  },
  {
    title: 'Player: you are a counter too', module: ['player'], chips: chipsOn('player'),
    switches: [{ port: 'up', label: 'UP' }, { port: 'down', label: 'DOWN' }, { port: 'flip', label: 'FLIP', gap: true }],
    leds: [led('player', 'pv', 'YOU', 'white'), led('player', 'bit', 'BIT', 'yellow')],
  },
];

const RIGHT: Spec[] = [
  {
    title: 'Rules: collision is an AND', module: ['rules'], chips: chipsOn('rules'),
    switches: [{ port: 'start', label: 'START' }],
    leds: [led('rules', 'run', 'RUN', 'green'), led('rules', 'crash', 'HIT'), led('rules', 'ghost', 'GHO', 'blue'), { ...led('rules', 'lives', 'LOST', 'red', 1), gap: true }, led('rules', 'lives', '', 'red', 0)],
  },
  {
    title: 'Score', module: ['score'], chips: chipsOn('score'),
    digits: [{ path: ['score'], port: 'tens', hex: true }, { path: ['score'], port: 'ones', hex: true }],
    leds: [led('score', 'fast', '≥ 10', 'yellow'), led('score', 'narrow3', '≥ 20', 'yellow'), led('score', 'narrow2', '≥ 40', 'yellow')],
  },
  { title: 'Digits to pixels', module: ['digits'], chips: chipsOn('digits'), leds: [led('digits', 'px', 'PX', 'white')] },
  {
    title: 'Video', module: ['video'], chips: chipsOn('video'),
    leds: [led('video', 'white', 'WHT', 'white'), led('video', 'amber', 'AMB', 'yellow'), led('video', 'cyan', 'CYN', 'blue'), { ...led('sync', 'hsync', 'HS', 'green'), gap: true }, led('sync', 'vsync', 'VS', 'green')],
  },
];

/** A module on as many boards as one row of chips a board takes; its indicators on the first. */
function split(m: Spec): Spec[] {
  const rows: BbChip[][] = [[]];
  let x = BB.side + 0.6;
  for (const chip of m.chips) {
    const w = chipSize(chip.dip).w;
    if (rows[rows.length - 1].length && x + w > COL_W - BB.side) { rows.push([]); x = BB.side + 0.6; }
    rows[rows.length - 1].push(chip);
    x += w + BB.chipGap;
  }
  return rows.map((chips, i) => (i === 0 ? { ...m, chips, air: AIR } : { title: `${m.title.split(':')[0]} (${i + 1})`, module: m.module, chips, air: AIR }));
}

/** Boards in `cols` columns of equal rows, a channel above and below each row, a gutter after each column but a lone column's last. */
function grid(list: Spec[], cols: number): BreadboardLayout {
  const gutters = Array.from({ length: Math.max(1, cols - 1) }, (_, i) => ({ x: COL_W + i * (COL_W + GUTTER), w: GUTTER }));
  const boards: BbBoard[] = [];
  let y = GAP;
  for (let i = 0; i < list.length; i += cols) {
    const row = list.slice(i, i + cols).map((b, k) => ({ ...b, at: [k * (COL_W + GUTTER), y], size: [COL_W, 0] }) as BbBoard);
    const h = Math.ceil(Math.max(...row.map((b) => planBoard(b).need.h)) * 2) / 2;
    for (const b of row) { b.size = [COL_W, h]; boards.push(b); }
    y += h + GAP;
  }
  return { boards, channels: { gutters, gap: GAP, w: cols * COL_W + Math.max(1, cols - 1) * GUTTER, h: y } };
}

/** The whole game on its boards; on a canvas too narrow for the grid, one column. */
export function runnerLayout(): BreadboardLayout {
  const list = [...LEFT, ...RIGHT].flatMap(split);
  let n = 0;
  for (const b of list) for (const chip of b.chips) chip.ref = `U${++n}`;
  const note = `${rbChips(BIT_RUNNER).length} ICs on ${list.length} boards, no CPU, no ROM`;
  return { ...grid(list, 3), note, narrow: { ...grid(list, 1), note } };
}
