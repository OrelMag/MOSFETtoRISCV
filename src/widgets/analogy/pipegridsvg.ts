// The stage × cycle grid of the pipeline figures, in the cells of widgets/pipegrid.ts: a row per stage (F D E M W), a
// column per cycle, one coloured cell per instruction, a dashed empty one for a bubble.

import { s } from '../../ui/dom';
import { PIPE_STAGES, type Cell, type Handoff } from './pipe';

export const GRID_W = 360, GRID_L = 22, GRID_TOP = 24, GRID_ROW = 28;
export const gridHeight = (): number => GRID_TOP + PIPE_STAGES.length * GRID_ROW + 6;

export interface GridSpec {
  cells: Cell[];
  label: (instr: number) => string;
  bubbles?: { stage: number; cycle: number }[];
  hands?: Handoff[];
  /** Columns drawn (fixed per figure so the layout does not jump between modes). */
  cols: number;
  /** Cycles revealed so far (a column past it is empty). */
  shown: number;
}

const HUES = [0, 1, 2, 4, 3];

export function gridKids(g: GridSpec): SVGElement[] {
  const cw = (GRID_W - GRID_L - 4) / g.cols;
  const x = (c: number) => GRID_L + c * cw;
  const y = (st: number) => GRID_TOP + st * GRID_ROW;
  const kids: SVGElement[] = [];
  for (let c = 0; c < g.cols; c++) kids.push(s('text', { x: x(c) + cw / 2, y: 14, 'text-anchor': 'middle', class: 'af-t af-m' }, String(c + 1)));
  PIPE_STAGES.forEach((n, st) => kids.push(s('text', { x: 2, y: y(st) + GRID_ROW / 2 + 5, class: 'af-t af-m' }, n)));
  for (let st = 0; st < PIPE_STAGES.length; st++)
    kids.push(s('line', { x1: GRID_L, x2: GRID_W - 4, y1: y(st) + GRID_ROW - 1, y2: y(st) + GRID_ROW - 1, class: 'af-grid' }));
  for (const b of g.bubbles ?? []) if (b.cycle < g.shown)
    kids.push(s('rect', { x: x(b.cycle) + 1.5, y: y(b.stage) + 3, width: cw - 3, height: GRID_ROW - 7, rx: 3, class: 'af-bubble' }));
  for (const c of g.cells) {
    if (c.cycle >= g.shown) continue;
    const cls = c.ghost ? 'af-cell af-ghost' : `af-cell af-i${HUES[c.instr % HUES.length]}${c.held ? ' af-held' : ''}`;
    kids.push(s('g', null,
      s('rect', { x: x(c.cycle) + 1.5, y: y(c.stage) + 3, width: cw - 3, height: GRID_ROW - 7, rx: 3, class: cls }),
      s('text', { x: x(c.cycle) + cw / 2, y: y(c.stage) + GRID_ROW / 2 + 3, 'text-anchor': 'middle', class: `af-t ${c.ghost ? 'af-m' : c.held ? 'af-hold' : 'af-on'}` }, g.label(c.instr))));
  }
  // the extra hand: an arrow in a column from the stage that holds the result to the stage that needs it
  for (const h of g.hands ?? []) {
    if (h.to.cycle >= g.shown) continue;
    // always upward: M → E, or W → D
    const cx = x(h.to.cycle) + cw - 6, y1 = y(h.from.stage) + 6, y2 = y(h.to.stage) + GRID_ROW - 7;
    kids.push(s('path', { d: `M${cx} ${y1} L${cx} ${y2}`, class: 'af-hand' }),
      s('path', { d: `M${cx - 4} ${y2 + 6} L${cx} ${y2} L${cx + 4} ${y2 + 6}`, class: 'af-hand' }));
  }
  return kids;
}
