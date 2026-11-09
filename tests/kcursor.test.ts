import { describe, expect, it } from 'vitest';
import { type CursorItem, firstItem, nextInDir, readingOrder } from '../src/view/kcursor';
import { KEYS, matches } from '../src/ui/keys';
import '../src/view/stagekeys';

const part = (name: string, x: number, y: number): CursorItem => ({ kind: 'inst', name, x, y, w: 4, h: 4 });
const pin = (name: string, dir: 'in' | 'out', x: number, y: number): CursorItem => ({ kind: 'pin', name, dir, x, y, w: 2, h: 2 });

// a half adder's drawing: two inputs on the left, XOR above AND, two outputs on the right
const A = pin('a', 'in', 0, 2), B = pin('b', 'in', 0, 8), X = part('x', 8, 0), N = part('n', 8, 7), S = pin('s', 'out', 20, 1), C = pin('c', 'out', 20, 8);
const ITEMS = [X, N, S, C, A, B];

describe('the stage part cursor', () => {
  it('starts on the first input, Home and End go to the first input and output', () => {
    expect(firstItem(ITEMS)).toBe(A);
    expect(firstItem(ITEMS, 'out')).toBe(S);
    expect(readingOrder(ITEMS).map((i) => i.name)).toEqual(['x', 's', 'a', 'b', 'n', 'c']); // rows of 2 units: a sits a row below x and s
  });

  it('moves to the nearest item that way, a sideways step costing double', () => {
    expect(nextInDir(ITEMS, A, 'right')).toBe(X);
    expect(nextInDir(ITEMS, B, 'right')).toBe(N);
    expect(nextInDir(ITEMS, X, 'down')).toBe(N);
    expect(nextInDir(ITEMS, N, 'up')).toBe(X);
    expect(nextInDir(ITEMS, X, 'right')).toBe(S);
    expect(nextInDir(ITEMS, N, 'right')).toBe(C);
    expect(nextInDir(ITEMS, A, 'down')).toBe(B);
  });

  it('stays put when nothing lies that way', () => {
    expect(nextInDir(ITEMS, A, 'left')).toBeNull();
    expect(nextInDir(ITEMS, S, 'right')).toBeNull();
    expect(nextInDir([A], A, 'down')).toBeNull();
  });

  it('lists its keys in the stage group without clashing with a stage or anywhere key', () => {
    const mine = KEYS.filter((k) => k.id.startsWith('cursor.'));
    expect(mine.length).toBe(11);
    expect(mine.every((k) => k.group === 'stage')).toBe(true);
    const ev = (key: string, code: string, shiftKey = false) => ({ key, code, shiftKey, ctrlKey: false, metaKey: false, altKey: false });
    for (const [key, code, shift, id] of [['.', 'Period', false, 'cursor.pulse'], ['>', 'Period', true, 'cursor.step'], [',', 'Comma', false, 'cursor.back'],
      ['=', 'Equal', false, 'cursor.zoomin'], ['+', 'Equal', true, 'cursor.zoomin'], ['-', 'Minus', false, 'cursor.zoomout'], ['0', 'Digit0', false, 'cursor.fit']] as const) {
      const hit = KEYS.filter((k) => (k.group === 'stage' || k.group === 'anywhere' || k.group === 'chapter') && matches(ev(key, code, shift), k.id)).map((k) => k.id);
      expect(hit, key).toEqual([id]);
    }
  });
});
