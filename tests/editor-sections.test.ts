import { describe, expect, it } from 'vitest';
import { hitTest, sectionCornerAt } from '../src/editor/geom';
import { History } from '../src/editor/history';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, polyline, sectionTitleBox } from '../src/editor/model';
import {
  addSection, boxSelect, copySel, deleteSel, groupInSection, moveSel, pasteClip, resizeSection, sectionContents, selectAll, setSection, withContents,
} from '../src/editor/ops';
import { partDef } from '../src/editor/parts';
import { decodeShare, encodeShare } from '../src/editor/share';
import { loadWorkspace, saveWorkspace, sanitizeChip, type KV } from '../src/editor/store';
import { halfAdder, workspace } from './editorkit';

const libDef = (p: ChipDoc['parts'][number]) => {
  const d = partDef(p.ref, () => undefined);
  return 'error' in d ? undefined : d;
};

/** The half adder (pins x 0…20, parts at y 1…11) inside a section around all of it. */
const framed = (): { doc: ChipDoc; id: string } => {
  const r = addSection(halfAdder(), [-6, -3], [32, 18], '  half   adder ');
  if (r.id === undefined) throw new Error(r.reason);
  return { doc: r.doc, id: r.id };
};

describe('canvas sections', () => {
  it('are added, edited, resized and clamped', () => {
    const { doc, id } = framed();
    expect(doc.sections).toEqual([{ id: 'sec1', at: [-6, -3], size: [32, 18], title: 'half adder' }]);
    expect(addSection(doc, [0.4, 0.6], [1, 2.6]).doc.sections![1]).toMatchObject({ id: 'sec2', at: [0, 1], size: [4, 4] });
    expect(setSection(doc, id, { title: 'half adder' }).doc).toBe(doc);
    expect(setSection(doc, id, { hue: 200 }).doc.sections![0].hue).toBe(200);
    expect(setSection(setSection(doc, id, { hue: 200 }).doc, id, { hue: undefined }).doc.sections![0]).not.toHaveProperty('hue');
    expect(setSection(doc, 'nope', { title: 'x' }).reason).toBeTruthy();
    // a corner dragged past the opposite one: the frame flips round it
    expect(resizeSection(doc, id, [26, 15], [10, 2]).doc.sections![0]).toMatchObject({ at: [10, 2], size: [16, 13] });
  });

  it('carry what lies fully inside them, in one undo step, and wires follow', () => {
    const { doc, id } = framed();
    const inside = sectionContents(doc, id, libDef);
    expect(inside.parts?.sort()).toEqual(['n', 'x']);
    expect(inside.pins).toHaveLength(4);
    expect(inside.wires).toHaveLength(6);
    expect(inside.sections ?? []).toEqual([]);
    const sel = withContents(doc, { sections: [id] }, libDef);
    // a drag: begin, several moves from the same base, commit
    const h = new History<ChipDoc>(doc);
    h.begin();
    for (const d of [[1, 0], [3, 1], [5, 2]] as const) h.update(moveSel(doc, sel, [d[0], d[1]], libDef));
    h.commit();
    const moved = h.current;
    expect(moved.sections![0].at).toEqual([-1, -1]);
    expect(moved.parts.map((p) => p.at)).toEqual(doc.parts.map((p) => [p.at[0] + 5, p.at[1] + 2]));
    for (const w of moved.wires) {
      const a = polyline(doc, doc.wires.find((q) => q.id === w.id)!, libDef)!, b = polyline(moved, w, libDef)!;
      expect(b).toEqual(a.map(([x, y]) => [x + 5, y + 2]));
    }
    expect(h.undo()).toBe(doc);
    expect(h.canUndo).toBe(false);
    // a part only half inside stays behind
    const small = resizeSection(doc, id, [-6, -3], [14, 5]).doc;
    expect(sectionContents(small, id, libDef).parts).toEqual(['x']);
  });

  it('a nested section moves with its parent; moving the frame alone touches no wire', () => {
    const { doc, id } = framed();
    const inner = addSection(doc, [6, 0], [8, 6], 'xor');
    const sel = withContents(inner.doc, { sections: [id] }, libDef);
    expect(sel.sections?.sort()).toEqual([id, inner.id!].sort());
    const alone = moveSel(doc, { sections: [id] }, [2, 2], libDef);
    expect(alone.wires).toBe(doc.wires);
    expect(alone.parts).toBe(doc.parts);
  });

  it('delete removes the frame only', () => {
    const { doc, id } = framed();
    const gone = deleteSel(doc, { sections: [id] });
    expect(gone.sections).toEqual([]);
    expect(gone.parts).toBe(doc.parts);
    expect(gone.wires).toBe(doc.wires);
    expect(deleteSel(doc, { parts: ['x'] }).sections).toBe(doc.sections);
  });

  it('group in a section fits the selection with a margin', () => {
    const doc = halfAdder();
    const r = groupInSection(doc, { parts: ['x', 'n'] }, libDef, 'gates');
    if (r.id === undefined) throw new Error(r.reason);
    const s = r.doc.sections![0];
    expect(s.title).toBe('gates');
    expect(sectionContents(r.doc, r.id, libDef).parts?.sort()).toEqual(['n', 'x']);
    // the margin: two units at the sides, one more above for the title
    expect(s.at).toEqual([6, -2]);
    expect(groupInSection(doc, {}, libDef).reason).toBeTruthy();
    // with pins, room for their names beside them
    const all = groupInSection(doc, selectAll(doc), libDef).doc.sections![0];
    expect(all.at[0]).toBeLessThanOrEqual(-6);
  });

  it('copy, paste, select all and the rubber band', () => {
    const { doc, id } = framed();
    const clip = copySel(doc, { sections: [id] });
    expect(clip.sections).toHaveLength(1);
    const r = pasteClip(doc, clip, [0, 30]);
    expect(r.doc.sections!.map((s) => [s.id, s.at])).toEqual([['sec1', [-6, -3]], ['sec2', [-6, 27]]]);
    expect(r.sel.sections).toEqual(['sec2']);
    expect(selectAll(doc).sections).toEqual([id]);
    expect(boxSelect(doc, [[-7, -4], [27, 16]], libDef).sections).toEqual([id]);
    expect(boxSelect(doc, [[-5, -4], [27, 16]], libDef).sections).toBeUndefined();
  });

  it('are hit on their border and title only, under everything else', () => {
    const { doc, id } = framed();
    const t = sectionTitleBox(doc.sections![0]);
    expect(hitTest(doc, libDef, [t.x + 1, t.y + 0.5], 0.4)).toEqual({ k: 'section', id, on: 'title' });
    expect(hitTest(doc, libDef, [-6, 8], 0.4)).toEqual({ k: 'section', id, on: 'border' });
    expect(hitTest(doc, libDef, [26.3, 8], 0.4)).toEqual({ k: 'section', id, on: 'border' });
    expect(hitTest(doc, libDef, [10, 15], 0.4)).toEqual({ k: 'section', id, on: 'border' });
    // inside: the canvas's (a box or a pan), and a part inside still wins
    expect(hitTest(doc, libDef, [14, 13], 0.4)).toEqual({ k: 'none' });
    expect(hitTest(doc, libDef, [10, 2], 0.4).k).toBe('part');
    // a border running under a part: the part
    const under = addSection(halfAdder(), [9, -5], [20, 20]).doc;
    expect(hitTest(under, libDef, [9, 2], 0.4).k).toBe('part');
    // corner handles, only of the sections asked about
    expect(sectionCornerAt(doc, [id], [26.2, 15.1], 0.4)).toEqual({ id, corner: 2 });
    expect(sectionCornerAt(doc, [], [26, 15], 0.4)).toBeNull();
    expect(sectionCornerAt(doc, [id], [10, 5], 0.4)).toBeNull();
  });

  it('are saved, shared and sanitized', async () => {
    const { doc } = framed();
    const hued = setSection(doc, doc.sections![0].id, { hue: 120 }).doc;
    const m = new Map<string, string>();
    const kv: KV = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    saveWorkspace(workspace(hued), kv);
    expect(loadWorkspace(kv).chips.u_ha.sections).toEqual(hued.sections);
    const back = await decodeShare(await encodeShare([hued]));
    expect('error' in back ? back : back[0].sections).toEqual(hued.sections);
    const dirty = sanitizeChip({ ...doc, sections: [
      { id: 'a', at: [0, 0] },
      { id: 'b', at: [1, 2], size: [0.2, 9e9], title: 'x'.repeat(500), hue: -30 },
      { id: 'c', at: [1, 2], size: [8, 6], title: 7 },
      { id: 'c', at: [3, 4], size: [8, 6], title: 'dup' },
    ] });
    expect(dirty?.sections).toEqual([
      { id: 'b', at: [1, 2], size: [4, 4000], title: 'x'.repeat(120), hue: 330 },
      { id: 'c', at: [1, 2], size: [8, 6], title: '' },
    ]);
    expect(sanitizeChip({ ...doc, sections: [] })?.sections).toBeUndefined();
  });

  it('never reach the compiler: adding, moving or renaming one recompiles nothing', () => {
    const doc = halfAdder();
    const lib = new UserLibrary(workspace(doc));
    const before = lib.compiled('u_ha');
    const { doc: framedDoc, id } = framed();
    lib.update(workspace(framedDoc));
    expect(lib.compiled('u_ha')).toBe(before);
    lib.update(workspace(setSection(moveSel(framedDoc, { sections: [id] }, [3, 3], libDef), id, { title: 'renamed', hue: 40 }).doc));
    expect(lib.compiled('u_ha')).toBe(before);
  });
});
