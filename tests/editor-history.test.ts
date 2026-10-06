// Undo / redo: steps, drags as one transaction, cancel, the cap, structural no-op detection.

import { describe, expect, it } from 'vitest';
import { History, same } from '../src/editor/history';

describe('History', () => {
  it('undoes and redoes steps; a new step drops the redo branch', () => {
    const h = new History(0);
    expect([h.canUndo, h.canRedo, h.undo(), h.redo()]).toEqual([false, false, null, null]);
    h.push(1);
    h.push(2);
    expect(h.undo()).toBe(1);
    expect(h.undo()).toBe(0);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(1);
    expect(h.canRedo).toBe(true);
    h.push(5);
    expect(h.canRedo).toBe(false);
    expect(h.current).toBe(5);
    expect(h.undo()).toBe(1);
  });

  it('records a transaction as one step', () => {
    const h = new History({ x: 0 });
    h.begin();
    for (let x = 1; x <= 10; x++) h.update({ x });
    expect(h.current).toEqual({ x: 10 });
    h.commit();
    expect(h.undo()).toEqual({ x: 0 });
    expect(h.redo()).toEqual({ x: 10 });
  });

  it('leaves no step for a transaction with no net change', () => {
    const h = new History({ x: 0 });
    h.begin();
    h.update({ x: 3 });
    h.update({ x: 0 }); // dragged back: a new object, equal content
    h.commit();
    expect(h.canUndo).toBe(false);
    h.push({ x: 0 });
    expect(h.canUndo).toBe(false);
  });

  it('cancel restores the state at begin, nested transactions included', () => {
    const h = new History('a');
    h.push('b');
    h.begin();
    h.update('c');
    h.begin();
    h.update('d');
    h.commit(); // inner: still inside the outer transaction
    expect(h.inTransaction).toBe(true);
    h.cancel();
    expect([h.current, h.inTransaction]).toEqual(['b', false]);
    expect(h.undo()).toBe('a');
  });

  it('push inside a transaction does not add a step; undo commits an open one', () => {
    const h = new History(0);
    h.begin();
    h.push(1);
    h.push(2);
    expect(h.undo()).toBe(0);
    expect(h.redo()).toBe(2);
  });

  it('keeps at most cap steps, dropping the oldest', () => {
    const h = new History(0, 3);
    for (let i = 1; i <= 10; i++) h.push(i);
    const seen: number[] = [];
    for (let s = h.undo(); s !== null; s = h.undo()) seen.push(s);
    expect(seen).toEqual([9, 8, 7]);
  });

  it('clear forgets everything', () => {
    const h = new History(0);
    h.push(1);
    h.undo();
    h.clear(7);
    expect([h.current, h.canUndo, h.canRedo]).toEqual([7, false, false]);
  });
});

describe('same', () => {
  it('compares JSON-like values, ignoring undefined keys', () => {
    expect(same({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(same({ a: 1, f: undefined }, { a: 1 })).toBe(true);
    expect(same({ a: [1] }, { a: { 0: 1 } })).toBe(false);
    expect(same([1, 2], [1, 2, 3])).toBe(false);
    expect(same(null, {})).toBe(false);
  });
});
