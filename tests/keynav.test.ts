import { describe, expect, it } from 'vitest';
import { cycle, endName, hitName, ownPorts, stepCursor, targetsOf } from '../src/editor/keynav';
import type { ChipDoc } from '../src/editor/model';
import { partDef } from '../src/editor/parts';
import { halfAdder } from './editorkit';

const defOf = (p: ChipDoc['parts'][number]) => {
  const d = partDef(p.ref, () => undefined);
  return 'error' in d ? undefined : d;
};

describe('keyboard cursor (keynav)', () => {
  it('steps one grid unit, five with Shift', () => {
    expect(stepCursor([3, 4], 'ArrowRight', false)).toEqual([4, 4]);
    expect(stepCursor([3, 4], 'ArrowUp', true)).toEqual([3, -1]);
    expect(stepCursor([3, 4], 'ArrowLeft', true)).toEqual([-2, 4]);
    expect(stepCursor([3, 4], 'ArrowDown', false)).toEqual([3, 5]);
  });

  it('lists every attach point left to right, then top to bottom', () => {
    const t = targetsOf(halfAdder(), defOf);
    expect(t.length).toBe(4 + 3 + 3); // 4 pins, XOR and AND three ports each
    for (let i = 1; i < t.length; i++) expect(t[i - 1].pos[0] < t[i].pos[0] || (t[i - 1].pos[0] === t[i].pos[0] && t[i - 1].pos[1] <= t[i].pos[1])).toBe(true);
  });

  it('cycles through them, wrapping both ways, and skips an end', () => {
    const doc = halfAdder();
    const t = targetsOf(doc, defOf);
    expect(cycle(t, null, 1)!.pos).toEqual(t[0].pos);
    expect(cycle(t, null, -1)!.pos).toEqual(t[t.length - 1].pos);
    expect(cycle(t, t[0].pos, 1)!.pos).toEqual(t[1].pos);
    expect(cycle(t, t[0].pos, -1)!.pos).toEqual(t[t.length - 1].pos);
    expect(cycle(t, t[t.length - 1].pos, 1)!.pos).toEqual(t[0].pos);
    // from empty space: the next one in reading order
    const mid = cycle(t, [t[2].pos[0], t[2].pos[1] - 0.5], 1)!;
    expect(mid.pos[0] > t[2].pos[0] - 1e-9).toBe(true);
    expect(cycle(t, t[1].pos, 1, t[2].end)!.pos).toEqual(t[3].pos);
    expect(cycle([], null, 1)).toBeNull();
  });

  it('knows the pins of the one selected object', () => {
    const doc = halfAdder();
    const own = ownPorts(doc, defOf, { parts: ['x'] });
    expect(own.map((a) => ('part' in a.end ? a.end.port : ''))).toEqual(expect.arrayContaining(['a', 'b', 'y']));
    expect(own.length).toBe(3);
    expect(ownPorts(doc, defOf, { pins: [doc.pins[0].id] }).length).toBe(1);
    expect(ownPorts(doc, defOf, { parts: ['x', 'n'] })).toEqual([]);
    expect(ownPorts(doc, defOf, {})).toEqual([]);
  });

  it('says where the cursor is in words', () => {
    const doc = halfAdder();
    expect(endName(doc, defOf, { part: 'x', port: 'y' })).toBe('x pin y (output)');
    expect(endName(doc, defOf, { part: 'x', port: 'a' })).toBe('x pin a (input)');
    expect(endName(doc, defOf, { pin: doc.pins[0].id })).toBe('input pin a');
    expect(hitName(doc, defOf, { k: 'part', id: 'n' })).toMatch(/^n \(/);
    expect(hitName(doc, defOf, { k: 'none' })).toBeNull();
  });
});
