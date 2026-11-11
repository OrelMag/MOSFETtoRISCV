// The learner's arrangements know the drawing they were made on (view/layout.ts): a redraw of a level sets them
// aside for one "Bring mine back" instead of laying old moves over a new drawing; the drag slop is in screen pixels.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Netlist } from '../src/sim/types';
import {
  arranged, arrangedCount, arrangedLevels, asideOf, checkDrawing, drawingKey, dropAside, editLayout, layoutOf, pastSlop,
  reloadLayouts, resetAllLayouts, restoreAside, undoLayout, SLOP_PX, SLOP_TOUCH_PX,
} from '../src/view/layout';
import { netKey } from '../src/view/nethue';

const KV = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => KV.get(k) ?? null,
  setItem: (k: string, v: string) => void KV.set(k, v),
  removeItem: (k: string) => void KV.delete(k),
};

/** Two NANDs a → b, as an author might draw them; `dx` moves b, `rename` renames it (a redraw). */
const drawing = (dx = 0, rename = false): Netlist => {
  const b = rename ? 'g2' : 'b';
  return {
    instances: [{ name: 'a', of: 'nand', at: [0, 0] }, { name: b, of: 'nand', at: [10 + dx, 0] }],
    nets: [
      { ends: ['in0', 'a.a', 'a.b'] },
      { ends: ['a.y', `${b}.a`, `${b}.b`], tags: true, name: 'mid' },
      { ends: [`${b}.y`, 'out'] },
    ],
  } as unknown as Netlist;
};

beforeEach(() => {
  KV.clear();
  reloadLayouts();
});

describe('drawingKey', () => {
  it('is the same for the same drawing and changes when a part moves or is renamed', () => {
    expect(drawingKey(drawing())).toBe(drawingKey(drawing()));
    expect(drawingKey(drawing(1))).not.toBe(drawingKey(drawing()));
    expect(drawingKey(drawing(0, true))).not.toBe(drawingKey(drawing()));
  });
});

describe('an arrangement and a redraw', () => {
  const mid = netKey(drawing().nets[1]);

  it('is stamped with the drawing it was made on, and kept while that drawing stays', () => {
    expect(checkDrawing('lvl', drawing())).toBe(false);
    editLayout('lvl', (e) => { e.at.b = [14, 3]; e.wired.push(mid); });
    expect(layoutOf('lvl')?.fp).toBe(drawingKey(drawing()));
    // a later visit: read from storage, the same drawing
    reloadLayouts();
    expect(checkDrawing('lvl', drawing())).toBe(false);
    expect(layoutOf('lvl')?.at.b).toEqual([14, 3]);
    expect(asideOf('lvl')).toBeUndefined();
  });

  it('is set aside when the author redraws the level: moves and corners go, pointers on nets still there and colours stay', () => {
    checkDrawing('lvl', drawing());
    editLayout('lvl', (e) => {
      e.at.b = [14, 3];
      e.wired.push(mid, 'gone');
      e.via = { [mid]: { 'b.a': [[5, 5]] } };
      e.hues = { [mid]: 120 };
    });
    reloadLayouts();
    expect(checkDrawing('lvl', drawing(2))).toBe(true);
    const now = layoutOf('lvl')!;
    expect(now.at).toEqual({});
    expect(now.via).toBeUndefined();
    expect(now.wired).toEqual([mid]);
    expect(now.hues).toEqual({ [mid]: 120 });
    expect(now.fp).toBe(drawingKey(drawing(2)));
    const aside = asideOf('lvl')!;
    expect(aside.at).toEqual({ b: [14, 3] });
    expect(aside.wired).toEqual([mid, 'gone']);
    expect(aside.via).toEqual({ [mid]: { 'b.a': [[5, 5]] } });
    // checked again (another visit): nothing more is set aside, the aside survives storage
    reloadLayouts();
    expect(checkDrawing('lvl', drawing(2))).toBe(false);
    expect(asideOf('lvl')?.at).toEqual({ b: [14, 3] });
    expect(arrangedLevels()).toEqual(['lvl']);
  });

  it('comes back with Bring mine back (one undo step), or goes with Dismiss', () => {
    checkDrawing('lvl', drawing());
    editLayout('lvl', (e) => { e.at.b = [14, 3]; });
    checkDrawing('lvl', drawing(2));
    restoreAside('lvl');
    expect(layoutOf('lvl')?.at).toEqual({ b: [14, 3] });
    expect(asideOf('lvl')).toBeUndefined();
    expect(layoutOf('lvl')?.fp).toBe(drawingKey(drawing(2)));
    expect(undoLayout('lvl')).toBe(true);
    expect(layoutOf('lvl')?.at ?? {}).toEqual({});
    expect(asideOf('lvl')?.at).toEqual({ b: [14, 3] });
    dropAside('lvl');
    expect(asideOf('lvl')).toBeUndefined();
    expect(layoutOf('lvl')).toBeUndefined();
  });

  it('saved before drawings had keys, is taken as made on the drawing shown', () => {
    KV.set('mosfet2riscv:layouts:v1', JSON.stringify({ lvl: { at: { b: [14, 3] }, wired: [], tagged: [] } }));
    reloadLayouts();
    expect(checkDrawing('lvl', drawing(2))).toBe(false);
    expect(layoutOf('lvl')?.at).toEqual({ b: [14, 3] });
    expect(layoutOf('lvl')?.fp).toBe(drawingKey(drawing(2)));
  });

  it('colours alone are not an arrangement: a redraw keeps them and sets nothing aside', () => {
    checkDrawing('lvl', drawing());
    editLayout('lvl', (e) => { e.hues = { [mid]: 'auto' }; });
    expect(arranged(layoutOf('lvl'))).toBe(false);
    expect(checkDrawing('lvl', drawing(3))).toBe(false);
    expect(layoutOf('lvl')?.hues).toEqual({ [mid]: 'auto' });
    expect(arrangedLevels()).toEqual([]);
  });

  it('counts what it changed, and Reset every level puts all back (colours stay)', () => {
    checkDrawing('x', drawing());
    editLayout('x', (e) => { e.at.a = [1, 1]; e.at.b = [2, 2]; e.tagged.push('n'); e.via = { k: { e: [[1, 1]] } }; e.hues = { k: 10 }; });
    checkDrawing('y', drawing());
    editLayout('y', (e) => { e.at.a = [3, 3]; });
    expect(arrangedCount(layoutOf('x'))).toEqual({ parts: 2, wires: 1, pointers: 1 });
    expect(arrangedLevels().sort()).toEqual(['x', 'y']);
    resetAllLayouts();
    expect(arrangedLevels()).toEqual([]);
    expect(layoutOf('y')).toBeUndefined();
    expect(layoutOf('x')?.hues).toEqual({ k: 10 });
  });
});

describe('the drag slop', () => {
  const at = (x: number, y: number, pointerType = 'mouse') => ({ clientX: x, clientY: y, pointerType });
  it('is in screen pixels: a mouse moves a part past 4 px, a finger past 10', () => {
    expect(SLOP_PX).toBe(4);
    expect(SLOP_TOUCH_PX).toBe(10);
    expect(pastSlop(at(0, 0), at(2, 1))).toBe(false);
    expect(pastSlop(at(0, 0), at(3, 1))).toBe(true);
    expect(pastSlop(at(0, 0, 'touch'), at(6, 3))).toBe(false);
    expect(pastSlop(at(0, 0, 'touch'), at(6, 4))).toBe(true);
    expect(pastSlop(at(0, 0, 'pen'), at(4, 0))).toBe(true);
  });
});
