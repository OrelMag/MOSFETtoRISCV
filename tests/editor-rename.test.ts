import { describe, expect, it } from 'vitest';
import { namePart } from '../src/editor/ops';
import { partDef } from '../src/editor/parts';
import type { DefOf } from '../src/editor/model';
import { halfAdder } from './editorkit';

const defOf: DefOf = (p) => {
  const r = partDef(p.ref, () => undefined);
  return 'error' in r ? undefined : r;
};

describe('renaming a part where its name is drawn', () => {
  it('a valid free name renames the instance, and its wires follow', () => {
    const r = namePart(halfAdder(), 'x', 'sum_gate', defOf);
    expect(r.reason).toBeUndefined();
    expect(r.id).toBe('sum_gate');
    expect(r.doc.parts.map((p) => p.id)).toEqual(['sum_gate', 'n']);
    expect(r.doc.wires.filter((w) => [w.a, w.b].some((e) => 'part' in e && e.part === 'sum_gate'))).toHaveLength(3);
  });

  it('anything else becomes a caption; a caption is edited, and cleared by blank or the instance name', () => {
    const doc = halfAdder();
    const spaced = namePart(doc, 'x', 'sum gate', defOf);
    expect(spaced.id).toBe('x');
    expect(spaced.doc.parts[0].label).toBe('sum gate');
    expect(namePart(doc, 'x', 'n', defOf).doc.parts[0]).toMatchObject({ id: 'x', label: 'n' }); // taken: a caption
    expect(namePart(doc, 'x', 's', defOf).doc.parts[0]).toMatchObject({ id: 'x', label: 's' }); // a pin's name
    const again = namePart(spaced.doc, 'x', 'adder', defOf);
    expect(again.doc.parts[0]).toMatchObject({ id: 'x', label: 'adder' });
    expect(namePart(spaced.doc, 'x', '', defOf).doc.parts[0].label).toBeUndefined();
    expect(namePart(spaced.doc, 'x', 'x', defOf).doc.parts[0].label).toBeUndefined();
    expect(namePart(spaced.doc, 'x', 'sum gate', defOf).doc).toBe(spaced.doc);
    expect(namePart(doc, 'x', '  ', defOf).doc).toBe(doc);
  });
});
