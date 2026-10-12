import { describe, expect, it } from 'vitest';
import { hitTest } from '../src/editor/geom';
import { UserLibrary } from '../src/editor/library';
import { type ChipDoc, commentBox } from '../src/editor/model';
import { addComment, boxSelect, copySel, deleteSel, moveSel, pasteClip, selectAll, setComment } from '../src/editor/ops';
import { partDef } from '../src/editor/parts';
import { decodeShare, encodeShare } from '../src/editor/share';
import { loadWorkspace, saveWorkspace, sanitizeChip, type KV } from '../src/editor/store';
import { halfAdder, workspace } from './editorkit';

const libDef = (p: ChipDoc['parts'][number]) => {
  const d = partDef(p.ref, () => undefined);
  return 'error' in d ? undefined : d;
};

const withNote = (text = 'sum = a xor b', at: [number, number] = [2, 14]): { doc: ChipDoc; id: string } => {
  const r = addComment(halfAdder(), text, at);
  if (r.id === undefined) throw new Error(r.reason);
  return { doc: r.doc, id: r.id };
};

describe('canvas comments', () => {
  it('are added, edited and refused when blank', () => {
    const { doc, id } = withNote('  carry = a and b\nsecond line ');
    expect(doc.comments).toEqual([{ id: 'note1', at: [2, 14], text: 'carry = a and b\nsecond line' }]);
    expect(addComment(doc, '   ', [0, 0]).reason).toBeTruthy();
    expect(setComment(doc, id, { text: ' ' }).reason).toBeTruthy();
    expect(setComment(doc, id, { text: 'carry = a and b\nsecond line' }).doc).toBe(doc);
    expect(setComment(doc, id, { text: 'x' }).doc.comments![0].text).toBe('x');
    expect(commentBox(doc.comments![0]).lines).toHaveLength(2);
  });

  it('move, delete, copy and paste with the selection', () => {
    const { doc, id } = withNote();
    const moved = moveSel(doc, { comments: [id] }, [3, 1], libDef);
    expect(moved.comments![0].at).toEqual([5, 15]);
    expect(moved.wires).toBe(doc.wires); // nothing to refit
    expect(moveSel(doc, { parts: ['x'] }, [1, 0], libDef).comments).toBe(doc.comments);
    expect(deleteSel(doc, { comments: [id] }).comments).toEqual([]);
    expect(deleteSel(doc, { parts: ['x'] }).comments).toBe(doc.comments);
    const clip = copySel(doc, { parts: ['x'], comments: [id] });
    expect(clip.comments).toHaveLength(1);
    const r = pasteClip(doc, clip, [0, 20]);
    expect(r.doc.comments!.map((c) => [c.id, c.at])).toEqual([['note1', [2, 14]], ['note2', [2, 34]]]);
    expect(r.sel.comments).toEqual(['note2']);
    expect(selectAll(doc).comments).toEqual([id]);
  });

  it('are selected by a rubber band around their whole box, and hit under everything', () => {
    const { doc, id } = withNote('note', [30, 20]);
    const b = commentBox(doc.comments![0]);
    expect(boxSelect(doc, [[29, 19], [31 + b.w, 21 + b.h]], libDef).comments).toEqual([id]);
    expect(boxSelect(doc, [[29, 19], [31, 21]], libDef).comments).toBeUndefined();
    expect(hitTest(doc, libDef, [31, 21], 0.4)).toEqual({ k: 'comment', id });
    // Under a part, the part wins.
    const under = addComment(halfAdder(), 'under the xor', [8, 1]).doc;
    expect(hitTest(under, libDef, [10, 2], 0.4).k).toBe('part');
  });

  it('are saved, shared and sanitized', async () => {
    const { doc } = withNote('line 1\nline 2');
    const m = new Map<string, string>();
    const kv: KV = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
    saveWorkspace(workspace(doc), kv);
    expect(loadWorkspace(kv).chips.u_ha.comments).toEqual(doc.comments);
    const back = await decodeShare(await encodeShare([doc]));
    expect('error' in back ? back : back[0].comments).toEqual(doc.comments);
    const dirty = sanitizeChip({ ...doc, comments: [{ id: 'a', at: [0, 0], text: '  ' }, { id: 'b', at: [1], text: 'x' }, { id: 'c', at: [1, 2], text: 'ok' }, { id: 'c', at: [3, 4], text: 'dup' }] });
    expect(dirty?.comments).toEqual([{ id: 'c', at: [1, 2], text: 'ok' }]);
    expect(sanitizeChip({ ...doc, comments: [] })?.comments).toBeUndefined();
  });

  it('never reach the compiler: writing one recompiles nothing', () => {
    const doc = halfAdder();
    const lib = new UserLibrary(workspace(doc));
    const before = lib.compiled('u_ha');
    const { doc: noted, id } = withNote();
    lib.update(workspace(noted));
    expect(lib.compiled('u_ha')).toBe(before);
    lib.update(workspace(setComment(noted, id, { text: 'edited' }).doc));
    expect(lib.compiled('u_ha')).toBe(before);
  });
});
