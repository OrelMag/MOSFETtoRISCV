// The drill path in the hash (ui/drillpath.ts): encode / decode, and how a move maps to history.

import { describe, expect, it } from 'vitest';
import { drillMove, drillSegs, parseDrill, TOP } from '../src/ui/drillpath';

describe('drill path in the hash', () => {
  it('writes nothing for the opening view, segments for a deeper one', () => {
    expect(drillSegs([])).toBe('');
    expect(drillSegs(['fa0'])).toBe('/fa0');
    expect(drillSegs(['fa0', 'g3'])).toBe('/fa0/g3');
    expect(drillSegs(['dp'], ['dp'])).toBe('');
    expect(drillSegs(['dp', 'alu'], ['dp'])).toBe('/dp/alu');
  });

  it('writes the top level explicitly when the opening view is deeper', () => {
    expect(drillSegs([], ['dp'])).toBe(`/${TOP}`);
    expect(parseDrill([TOP])).toEqual([]);
  });

  it('round-trips, names with odd characters included', () => {
    for (const p of [['fa0'], ['w3', 'ff0', 'ff'], ['a b', 'x/y', 'q%'], ['~x']]) {
      const segs = drillSegs(p).split('/').filter(Boolean);
      expect(parseDrill(segs)).toEqual(p);
    }
    expect(parseDrill([])).toBeUndefined();
    expect(parseDrill(['%E0%A4%A'])).toEqual(['%E0%A4%A']); // malformed escape: kept as written
  });

  it('keeps old step links: no segments, the scene opens where it always did', () => {
    const parts = '#/c/cpu/0'.replace(/^#\/?/, '').split('/').filter(Boolean);
    expect(parseDrill(parts.slice(3))).toBeUndefined();
    const deep = '#/c/cpu/0/dp/alu'.replace(/^#\/?/, '').split('/').filter(Boolean);
    expect(parseDrill(deep.slice(3))).toEqual(['dp', 'alu']);
    const wb = '#/workbench/rca4/fa0'.replace(/^#\/?/, '').split('/').filter(Boolean);
    expect(wb[1]).toBe('rca4');
    expect(parseDrill(wb.slice(2))).toEqual(['fa0']);
  });
});

describe('drill moves in history', () => {
  const R = '#/workbench/rca4', A = '#/workbench/rca4/fa0', B = '#/workbench/rca4/fa0/g3';

  it('does nothing when the hash is already there', () => {
    expect(drillMove(A, null, A)).toEqual({ kind: 'none' });
  });

  it('pushes a level opened, remembering the entries behind', () => {
    const m1 = drillMove(R, null, A);
    expect(m1).toEqual({ kind: 'push', state: { drillBehind: [R] } });
    const m2 = drillMove(A, m1.kind === 'push' ? m1.state : null, B);
    expect(m2).toEqual({ kind: 'push', state: { drillBehind: [R, A] } });
  });

  it('steps back to a level whose entry is behind (Up, a breadcrumb) instead of pushing it again', () => {
    expect(drillMove(B, { drillBehind: [R, A] }, A)).toEqual({ kind: 'back', n: 1 });
    expect(drillMove(B, { drillBehind: [R, A] }, R)).toEqual({ kind: 'back', n: 2 });
  });

  it('never grows history in a drill-in / up loop', () => {
    // simulate a history stack and its states
    const stack: { hash: string; state: unknown }[] = [{ hash: R, state: null }];
    let at = 0;
    const go = (want: string) => {
      const m = drillMove(stack[at].hash, stack[at].state, want);
      if (m.kind === 'push') {
        stack.length = at + 1;
        stack.push({ hash: want, state: m.state });
        at++;
      } else if (m.kind === 'back') at -= m.n;
      expect(stack[at].hash).toBe(want);
    };
    for (let k = 0; k < 5; k++) {
      go(A);
      go(B);
      go(R);
    }
    expect(stack.map((e) => e.hash)).toEqual([R, A, B]);
    expect(at).toBe(0);
  });

  it('pushes a level not behind, and ignores a foreign state', () => {
    expect(drillMove(A, { drillBehind: [R] }, '#/workbench/rca4/fa1')).toEqual({ kind: 'push', state: { drillBehind: [R, A] } });
    expect(drillMove(A, { other: 1 }, R)).toEqual({ kind: 'push', state: { drillBehind: [A] } });
    expect(drillMove(A, { drillBehind: [1, 2] }, R)).toEqual({ kind: 'push', state: { drillBehind: [A] } });
  });
});
