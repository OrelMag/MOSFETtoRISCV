import { describe, expect, it } from 'vitest';
import { EXAMPLES, addExample } from '../src/editor/examples';
import { folderOf } from '../src/editor/folders';
import { emptyWorkspace } from '../src/editor/model';

describe('examples file their sub-chips', () => {
  const ex = EXAMPLES.find((e) => e.subchips && Object.keys(e.subchips).length > 1)!;
  it('puts the sub-chips in a folder named after the example, the chip itself loose', () => {
    const before = Object.keys(emptyWorkspace().chips), { ws, id } = addExample(emptyWorkspace(), ex);
    const name = ws.folders![0].name;
    expect(name.length).toBeLessThanOrEqual(40);
    const subs = Object.keys(ws.chips).filter((c) => c !== id && !before.includes(c));
    expect(subs.length).toBe(Object.keys(ex.subchips!).length);
    for (const s of subs) expect(folderOf(ws, s)).toBe(name);
    expect(folderOf(ws, id)).toBeUndefined();
    expect(ws.folders!.length).toBe(1);
  });
  it('a second copy gets a folder of its own', () => {
    const a = addExample(emptyWorkspace(), ex), b = addExample(a.ws, ex);
    expect(b.ws.folders!.length).toBe(2);
  });
  it('an example without sub-chips makes no folder', () => {
    const plain = EXAMPLES.find((e) => !e.subchips)!;
    expect(addExample(emptyWorkspace(), plain).ws.folders).toBeUndefined();
  });
});
