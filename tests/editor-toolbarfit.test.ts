import { describe, expect, it } from 'vitest';
import { SHED_ORDER, shedActions } from '../src/editor/toolbarfit';

// The sandbox's toolbar as it is drawn (ids in bar order, widths in px at 13 px type, measured at 1440 px).
const BAR = [
  ['file', 58], ['undo', 28], ['redo', 28], ['zout', 28], ['zin', 28], ['fit', 28], ['type', 66], ['iobar', 56],
  ['examples', 96], ['package', 88], ['probe', 70], ['timing', 76], ['cpu', 56], ['screens', 84], ['challenges', 106],
  ['puzzles', 82], ['inspect', 28], ['help', 28],
].map(([id, w]) => ({ id: id as string, w: w as number }));
const GAP = 2, MORE = 70;
const width = (items: { w: number }[]) => items.reduce((s, it) => s + it.w, 0) + GAP * Math.max(0, items.length - 1);

describe('toolbar overflow (More menu)', () => {
  it('keeps every action when they fit', () => {
    expect(shedActions(BAR, width(BAR), MORE, GAP).size).toBe(0);
    expect(shedActions(BAR, 5000, MORE, GAP).size).toBe(0);
  });

  it('what stays, and the More button, fit in the room, for any room', () => {
    for (let room = MORE; room <= width(BAR) + 50; room += 7) {
      const shed = shedActions(BAR, room, MORE, GAP);
      const kept = BAR.filter((it) => !shed.has(it.id));
      const w = width(kept) + (shed.size ? GAP * (kept.length ? 1 : 0) + MORE : 0);
      expect(w, `room ${room}`).toBeLessThanOrEqual(room + 0.5);
      // no more than needed: putting back the last one shed would not fit
      if (shed.size) {
        const back = [...shed].sort((a, b) => SHED_ORDER.indexOf(b) - SHED_ORDER.indexOf(a))[0];
        const again = BAR.filter((it) => !shed.has(it.id) || it.id === back);
        const fits = shed.size === 1 ? width(again) <= room + 0.5 : width(again) + GAP + MORE <= room + 0.5;
        expect(fits, `room ${room}: ${back} could have stayed`).toBe(false);
      }
    }
  });

  it('sheds the least used first: help, Type and Screens before Undo and File', () => {
    const shed = shedActions(BAR, width(BAR) - 100, MORE, GAP);
    expect([...shed]).toEqual(['help', 'type', 'screens']);
    const tight = shedActions(BAR, 360, MORE, GAP);
    for (const id of ['file', 'undo', 'redo', 'fit']) expect(tight.has(id), id).toBe(false);
    expect(tight.has('package')).toBe(true);
  });

  it('Package stays until Tests, CPU and the Play menu have gone', () => {
    const bar = [...BAR.filter((it) => !['probe', 'timing', 'challenges', 'puzzles'].includes(it.id)), { id: 'timingmenu', w: 90 }, { id: 'play', w: 70 }, { id: 'tests', w: 70 }];
    for (let room = MORE; room <= width(bar); room += 5) {
      const shed = shedActions(bar, room, MORE, GAP);
      if (shed.has('package')) for (const id of ['tests', 'cpu', 'play']) expect(shed.has(id), `room ${room}: ${id}`).toBe(true);
    }
  });

  it('a plugin action no one ranked goes first, the rightmost of them first', () => {
    const bar = [...BAR.slice(0, 3), { id: 'x1', w: 40 }, { id: 'x2', w: 40 }];
    expect([...shedActions(bar, width(bar) - 1, MORE, GAP)]).toEqual(['x2', 'x1']);
  });

  it('everything goes when even one action and More do not fit', () => {
    expect(shedActions(BAR, MORE, MORE, GAP).size).toBe(BAR.length);
  });
});
