// Appendix D's boards (DOM-free, so tests validate them): Bit Runner as built, two columns of boards, every chip a 74xx
// part of lib/bitrunner.ts at its path, every LED a net of the scene's simulation.

import { BIT_RUNNER, RB_ROLES, rbChips } from '../lib/bitrunner';
import { TTL_PART, TTL_PINS } from '../lib/ttl';
import { type BbBoard, type BbChip, type BbLed, type BreadboardLayout, ledsOf, planBoard } from '../view/bblayout';
import { pinsOf } from './saplayout';

const COL_W = 56, GAP = 1.6;
type Spec = Omit<BbBoard, 'at' | 'size'>;

function chipsOn(module: string): BbChip[] {
  return rbChips(BIT_RUNNER).filter((c) => c.path.startsWith(`${module}.`)).map((c) => ({
    path: c.path.split('.'), part: TTL_PART[c.kind], dip: TTL_PINS[c.kind].length, role: RB_ROLES[c.path], pins: pinsOf(c.kind),
  }));
}

function sized(b: Spec, at: [number, number]): BbBoard {
  const board = { ...b, at, size: [COL_W, 0] } as BbBoard;
  board.size = [COL_W, Math.ceil(planBoard(board).need.h * 2) / 2];
  return board;
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
    leds: [...ledsOf(['walls'], 'wc', 6, 'yellow', (b) => (b === 5 ? 'COUNT' : '')), { ...led('walls', 'wv', 'WALL', 'white'), gap: true }, led('walls', 'w', 'B', 'green'), led('walls', 'f', 'F', 'blue')],
  },
  {
    title: 'Gates: where and what colour', module: ['gaps'], chips: chipsOn('gaps'),
    leds: [led('gaps', 'inGap', 'IN GATE', 'green'), led('gaps', 'colour', 'COLOUR', 'yellow')],
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
    leds: [led('rules', 'run', 'RUN', 'green'), led('rules', 'crash', 'CRASH'), led('rules', 'ghost', 'GHOST', 'blue'), { ...led('rules', 'lives', 'LOST', 'red', 1), gap: true }, led('rules', 'lives', '', 'red', 0)],
  },
  {
    title: 'Score', module: ['score'], chips: chipsOn('score'),
    digits: [{ path: ['score'], port: 'tens', hex: true }, { path: ['score'], port: 'ones', hex: true }],
    leds: [led('score', 'fast', '≥ 10', 'yellow'), led('score', 'narrow3', '≥ 20', 'yellow'), led('score', 'narrow2', '≥ 40', 'yellow')],
  },
  { title: 'Digits to pixels', module: ['digits'], chips: chipsOn('digits'), leds: [led('digits', 'px', 'PIXEL', 'white')] },
  {
    title: 'Video', module: ['video'], chips: chipsOn('video'),
    leds: [led('video', 'white', 'WHITE', 'white'), led('video', 'amber', 'AMBER', 'yellow'), led('video', 'cyan', 'CYAN', 'blue'), { ...led('sync', 'hsync', 'HSYNC', 'green'), gap: true }, led('sync', 'vsync', 'VSYNC', 'green')],
  },
];

const number = (boards: BbBoard[]) => { let n = 0; for (const b of boards) for (const c of b.chips) c.ref = `U${++n}`; };

function stack(into: BbBoard[], list: Spec[], x: number, y = 0): number {
  for (const b of list) {
    const s = sized(b, [x, y]);
    into.push(s);
    y = Math.round((y + s.size[1] + GAP) * 10) / 10;
  }
  return y;
}

/** The whole game on its boards; below a narrow canvas's width, one column. */
export function runnerLayout(): BreadboardLayout {
  const boards: BbBoard[] = [], column: BbBoard[] = [];
  stack(boards, LEFT, 0);
  stack(boards, RIGHT, COL_W + 2);
  number(boards);
  stack(column, RIGHT, 0, stack(column, LEFT, 0));
  const note = `${rbChips(BIT_RUNNER).length} ICs, no CPU, no ROM`;
  return { note, boards, narrow: { note, boards: column } };
}
