import { describe, expect, it } from 'vitest';
import { anchorPoint, flySpot, isMenuKey, menuSpot, pickRows, typeAhead } from '../src/ui/menu';

describe('the menu shell', () => {
  it('knows the menu key and Shift+F10, and only those', () => {
    expect(isMenuKey({ key: 'ContextMenu' })).toBe(true);
    expect(isMenuKey({ key: 'F10', shiftKey: true })).toBe(true);
    expect(isMenuKey({ key: 'F10' })).toBe(false);
    expect(isMenuKey({ key: 'm' })).toBe(false);
  });

  it('opens at the point, up or left of it near an edge, never off screen', () => {
    expect(menuSpot(100, 100, 200, 300, 1000, 800)).toEqual({ left: 100, top: 100 });
    expect(menuSpot(900, 100, 200, 300, 1000, 800)).toEqual({ left: 700, top: 100 });
    expect(menuSpot(100, 700, 200, 300, 1000, 800)).toEqual({ left: 100, top: 400 });
    // taller and wider than the room on either side: pinned to the margin
    expect(menuSpot(50, 50, 500, 900, 400, 600)).toEqual({ left: 8, top: 8 });
  });

  it('opens a group beside the menu, on the other side when there is no room', () => {
    expect(flySpot({ left: 100, right: 300 }, 200, 250, 100, 1000, 800)).toEqual({ left: 297, top: 194 });
    expect(flySpot({ left: 700, right: 900 }, 200, 250, 100, 1000, 800)).toEqual({ left: 453, top: 194 });
    // a low row: the group moves up to stay on screen
    expect(flySpot({ left: 100, right: 300 }, 780, 250, 100, 1000, 800).top).toBe(692);
  });

  it('anchors a menu opened by key on its target, kept within the view', () => {
    const view = { left: 100, top: 50, width: 800, height: 600 };
    expect(anchorPoint({ left: 200, top: 100, width: 40, height: 10 }, view)).toEqual({ x: 240, y: 110 });
    expect(anchorPoint({ left: 200, top: 100, width: 400, height: 200 }, view)).toEqual({ x: 270, y: 124 });
    // scrolled out of the view: at its edge, not out there
    expect(anchorPoint({ left: 2000, top: -500, width: 40, height: 10 }, view)).toEqual({ x: 884, y: 66 });
    expect(anchorPoint(null, view)).toEqual({ x: 116, y: 66 });
  });

  it('jumps by first letter, on from the row it is on, wrapping', () => {
    const rows = ['Flip', 'Rotate', 'Rename', 'Delete'];
    expect(typeAhead(rows, 0, 'r')).toBe(1);
    expect(typeAhead(rows, 1, 'R')).toBe(2);
    expect(typeAhead(rows, 2, 'r')).toBe(1);
    expect(typeAhead(rows, -1, 'f')).toBe(0);
    expect(typeAhead(rows, 0, 'z')).toBe(-1);
    expect(typeAhead([], 0, 'a')).toBe(-1);
  });

  it('filters the picker by name or kind, names that start with it first', () => {
    const e = (label: string, note?: string) => ({ label, ...(note ? { note } : {}), run() {} });
    const all = [e('byA', 'MUX2'), e('alu', 'ALU'), e('a', 'wire'), e('result', 'wire')];
    expect(pickRows(all, '').rows.map((x) => x.label)).toEqual(['byA', 'alu', 'a', 'result']);
    expect(pickRows(all, 'a').rows.map((x) => x.label).slice(0, 2)).toEqual(['alu', 'a']);
    expect(pickRows(all, 'WIRE').rows.map((x) => x.label)).toEqual(['a', 'result']);
    expect(pickRows(all, 'zz').rows).toEqual([]);
    const many = Array.from({ length: 250 }, (_, i) => e(`n${i}`));
    expect(pickRows(many, '').more).toBe(50);
    expect(pickRows(many, '').rows.length).toBe(200);
  });
});
