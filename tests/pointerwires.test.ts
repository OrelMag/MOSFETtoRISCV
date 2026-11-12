// A Sheet's pointer pairs drawn as wires (editor/pointerwires.ts): the same nets, fewer pointers, no part crossed.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { compileChip } from '../src/editor/compile';
import { rv64Chip, rvcChip, rvvChip } from '../src/editor/exampleisa';
import { partDef } from '../src/editor/parts';
import { isError } from '../src/editor/parts';
import type { ChipDoc } from '../src/editor/model';
import { Sheet } from '../src/editor/example6502';

/** The partition of every part port / pin into nets, as sorted keys: what a wire or a pointer pair means. */
function partition(doc: ChipDoc): string[] {
  const c = compileChip(doc, (ref) => partDef(ref, () => undefined));
  expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
  const nets = new Map<number, string[]>();
  for (const [k, n] of c.netOfEnd) if (!k.startsWith('l:') && !k.startsWith('w:')) nets.set(n, [...(nets.get(n) ?? []), k]);
  return [...nets.values()].map((v) => v.sort().join(',')).sort();
}

describe('wirePointers', () => {
  it('two close pointers become one wire; the nets are the same', () => {
    const build = (wiring: false | object) => {
      const s = new Sheet();
      s.part('a', { lib: 'not' }, [4, 4]);
      s.part('b', { lib: 'not' }, [14, 6]);
      s.tap('a.y', 'x'); s.tap('b.a', 'x');
      return s.doc('t', 't', {}, wiring);
    };
    const plain = build(false), wired = build({});
    expect(plain.labels.length).toBe(2);
    expect(wired.labels.length).toBe(0);
    expect(wired.wires.length).toBe(1);
    expect(partition(wired)).toEqual(partition(plain));
  });
  it('a name with a third pointer keeps the driver pointer for it', () => {
    const s = new Sheet();
    s.part('a', { lib: 'not' }, [4, 4]);
    s.part('b', { lib: 'not' }, [14, 6]);
    s.part('c', { lib: 'not' }, [60, 30]);
    s.tap('a.y', 'x'); s.tap('b.a', 'x'); s.tap('c.a', 'x');
    const wired = s.doc('t', 't', {});
    expect(wired.labels.map((l) => l.name)).toEqual(['x', 'x']);
    expect(wired.wires.some((w) => w.id.startsWith('pw_x'))).toBe(true);
  });
  for (const [name, make] of [['rvc', rvcChip], ['rv64', rv64Chip], ['rvv', rvvChip]] as const) {
    it(`${name}: the drawing resolves`, () => {
      const doc = make('x', 'x');
      const c = compileChip(doc, (ref) => { const r = partDef(ref, () => undefined); return r; });
      expect(isError(partDef(doc.parts[0].ref, () => undefined))).toBe(false);
      expect(c.diags.filter((d) => d.level === 'error')).toEqual([]);
    });
  }
});
