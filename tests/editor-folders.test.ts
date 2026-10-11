// Folders of My chips (editor/folders.ts) and projects (editor/projects.ts): the pure operations,
// the palette's grouping, files that carry folders, and separate workspaces in storage.

import { describe, expect, it } from 'vitest';
import { deleteChip, duplicateChip } from '../src/editor/files';
import {
  addFolder, cleanFolderName, fileCopy, folderGroups, folderOf, mergeFolders, moveToFolder, newFolderName, pruneFolders, removeFolder,
  renameFolder, sanitizeFolders,
} from '../src/editor/folders';
import { removeChip } from '../src/editor/library';
import { emptyChip, emptyWorkspace, type ChipDoc, type Workspace } from '../src/editor/model';
import { paletteGroups, type PaletteCtx } from '../src/editor/palette';
import {
  MAIN_PROJECT, PROJECTS_KEY, createProject, deleteProject, duplicateProject, projectKey, projectNameOf, readProjects, renameProject,
  setCurrentProject, touchProject,
} from '../src/editor/projects';
import { remixIntoStorage } from '../src/editor/remix';
import {
  KEY, deleteLocalData, exportJson, importJson, loadWorkspace, migrate, readExport, saveWorkspace, workspaceFromExport, type ListKV,
} from '../src/editor/store';
import { resolveComponent } from '../src/lib/resolve';

class MapKV implements ListKV {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
}

const chip = (id: string, uses: string[] = []): ChipDoc => ({
  ...emptyChip(id, id.slice(2)),
  pins: [{ id: 'p1', name: 'a', dir: 'in', width: 1, at: [0, 0] }],
  parts: uses.map((u, i) => ({ id: `x${i}`, ref: { chip: u }, at: [10, 4 * i] })),
});
const ws = (...chips: ChipDoc[]): Workspace => ({ schema: 1, chips: Object.fromEntries(chips.map((c) => [c.id, c])), open: [chips[0].id] });
const ok = <T extends object>(r: T | { error: string }): T => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('folders', () => {
  it('files chips in one folder at a time, in order, and takes them out', () => {
    let w = ws(chip('u_main'), chip('u_ha'), chip('u_fa'), chip('u_dff'));
    w = moveToFolder(w, 'u_ha', 'Arithmetic');
    w = moveToFolder(w, 'u_fa', 'arithmetic'); // the same folder, whatever the case
    w = moveToFolder(w, 'u_dff', 'Storage');
    expect(w.folders).toEqual([{ name: 'Arithmetic', chips: ['u_ha', 'u_fa'] }, { name: 'Storage', chips: ['u_dff'] }]);
    w = moveToFolder(w, 'u_fa', 'Arithmetic', 'u_ha');
    expect(w.folders![0].chips).toEqual(['u_fa', 'u_ha']);
    w = moveToFolder(w, 'u_ha', 'Storage');
    expect(folderOf(w, 'u_ha')).toBe('Storage');
    expect(w.folders![0].chips).toEqual(['u_fa']);
    const same = moveToFolder(w, 'u_ha', 'Storage');
    expect(same).toBe(w); // nothing to undo
    w = moveToFolder(w, 'u_ha', null);
    expect(folderOf(w, 'u_ha')).toBeUndefined();
    expect(moveToFolder(w, 'u_nope', 'Storage')).toBe(w);
  });

  it('names: trimmed, unique case-insensitively, at most 40 characters', () => {
    expect(cleanFolderName('  CPU   parts ')).toBe('CPU parts');
    expect(cleanFolderName('   ')).toBeNull();
    expect(cleanFolderName('x'.repeat(41))).toBeNull();
    let w = ok(addFolder(ws(chip('u_a')), 'Adders')).ws;
    expect(addFolder(w, 'adders')).toEqual({ error: 'there is already a folder Adders' });
    expect(newFolderName(w, 'Adders')).toBe('Adders 2');
    w = ok(addFolder(w, 'Muxes')).ws;
    expect(renameFolder(w, 'Muxes', 'ADDERS')).toEqual({ error: 'there is already a folder Adders' });
    expect(ok(renameFolder(w, 'Adders', 'ADDERS')).name).toBe('ADDERS'); // its own name in another case
    w = ok(renameFolder(w, 'Muxes', 'Selectors')).ws;
    expect(w.folders!.map((f) => f.name)).toEqual(['Adders', 'Selectors']);
  });

  it('removing a folder leaves its chips, unfiled; the last folder drops the field', () => {
    let w = moveToFolder(ws(chip('u_a'), chip('u_b')), 'u_b', 'F');
    w = removeFolder(w, 'f');
    expect(w.folders).toBeUndefined();
    expect(Object.keys(w.chips)).toEqual(['u_a', 'u_b']);
  });

  it('groups chips by folder (empty folders too), unfiled last in workspace order', () => {
    let w = ws(chip('u_main'), chip('u_a'), chip('u_b'), chip('u_c'));
    w = ok(addFolder(w, 'Empty')).ws;
    w = moveToFolder(w, 'u_c', 'Full');
    w = moveToFolder(w, 'u_a', 'Full');
    expect(folderGroups(w).map((g) => [g.name, g.chips.map((c) => c.id)])).toEqual([['Empty', []], ['Full', ['u_c', 'u_a']], [null, ['u_main', 'u_b']]]);
    expect(folderGroups(w, (c) => c.id !== 'u_a')[1].chips.map((c) => c.id)).toEqual(['u_c']);
  });

  it('a duplicate lands after its original; a deleted chip leaves its folder', () => {
    let w = moveToFolder(moveToFolder(ws(chip('u_main'), chip('u_a'), chip('u_b')), 'u_a', 'F'), 'u_b', 'F');
    const d = duplicateChip(w, 'u_a')!;
    expect(d.ws.folders![0].chips).toEqual(['u_a', d.id, 'u_b']);
    w = ok(deleteChip(d.ws, 'u_a') as { ws: Workspace }).ws;
    expect(w.folders![0].chips).toEqual([d.id, 'u_b']);
    w = ok(removeChip(w, 'u_b') as { ws: Workspace }).ws;
    expect(w.folders![0].chips).toEqual([d.id]);
    expect(fileCopy(ws(chip('u_x')), 'u_x', 'u_y').folders).toBeUndefined();
  });

  it('pruning and the sanitizer drop unknown chips, repeats and bad names', () => {
    const w = { ...ws(chip('u_a'), chip('u_b')), folders: [{ name: 'F', chips: ['u_a', 'u_gone', 'u_a'] }, { name: 'G', chips: ['u_a', 'u_b'] }] };
    expect(pruneFolders(w).folders).toEqual([{ name: 'F', chips: ['u_a'] }, { name: 'G', chips: ['u_b'] }]);
    expect(sanitizeFolders([{ name: ' F ', chips: ['u_a', 7] }, { name: 'f', chips: ['u_b'] }, { name: '', chips: [] }, 'x', { name: 'G' }], w.chips))
      .toEqual([{ name: 'F', chips: ['u_a'] }, { name: 'G', chips: [] }]);
    const back = migrate(JSON.parse(JSON.stringify({ ...w, folders: [{ name: 'F', chips: ['u_b', 'u_zz'] }] }))) as Workspace;
    expect(back.folders).toEqual([{ name: 'F', chips: ['u_b'] }]);
    expect((migrate(ws(chip('u_a'))) as Workspace).folders).toBeUndefined();
  });

  it('the palette lists My chips by folder, empty folders included, without the open chip', () => {
    let w = ws(chip('u_main'), chip('u_a'), chip('u_b'));
    w = ok(addFolder(w, 'Empty')).ws;
    w = moveToFolder(w, 'u_b', 'Mine');
    const g = paletteGroups().find((x) => x.id === 'mine')!;
    const ctx: PaletteCtx = { ws: w, chipId: 'u_main', canPlace: () => true };
    expect(g.items(ctx).map((it) => [it.id, it.section])).toEqual([['u_b', 'Mine'], ['u_a', undefined]]);
    expect(g.folders!(ctx)).toEqual(['Empty', 'Mine']);
  });
});

describe('files carry folders', () => {
  const base = () => moveToFolder(moveToFolder(ok(addFolder(ws(chip('u_main', ['u_fa']), chip('u_fa', ['u_ha']), chip('u_ha')), 'Empty')).ws, 'u_ha', 'Adders'), 'u_fa', 'Adders');

  it('an export names the folders of the chips in it; a whole project adds the rest', () => {
    const one = JSON.parse(exportJson(base(), ['u_fa']));
    expect(one.folders).toEqual([{ name: 'Adders', chips: ['u_ha', 'u_fa'] }]);
    expect(one).not.toHaveProperty('project');
    const all = JSON.parse(exportJson({ ...base(), favorites: ['lib/nand'] }, ['u_main', 'u_fa', 'u_ha'], 'CPU build'));
    expect(all).toMatchObject({ project: 'CPU build', favorites: ['lib/nand'], folders: [{ name: 'Empty', chips: [] }, { name: 'Adders', chips: ['u_ha', 'u_fa'] }] });
  });

  it('an import files the chips it adds; chips already there keep their own folder', () => {
    const text = exportJson(base(), ['u_fa']);
    let into = moveToFolder(ws(chip('u_main'), chip('u_ha')), 'u_ha', 'Mine');
    const r = ok(importJson(text, into));
    expect(r.added).toEqual(['u_fa']); // u_ha is identical: skipped
    into = r.ws;
    expect(folderOf(into, 'u_fa')).toBe('Adders');
    expect(folderOf(into, 'u_ha')).toBe('Mine');
    // A renamed chip is filed under its new id.
    const other = { ...chip('u_fa'), notes: 'different' };
    const r2 = ok(importJson(text, ws(chip('u_main'), other)));
    expect(r2.renamed).toEqual({ u_fa: 'u_fa_2' });
    expect(folderOf(r2.ws, 'u_fa_2')).toBe('Adders');
    expect(folderOf(r2.ws, 'u_fa')).toBeUndefined();
    expect(mergeFolders(into, [], (id) => id, [])).toBe(into);
  });

  it('a project file read back as a new workspace: same chips, folders, favorites, top chip open', () => {
    const src = { ...base(), favorites: ['mine/u_fa'] };
    const f = readExport(exportJson(src, Object.keys(src.chips), 'CPU build'));
    if ('error' in f) throw new Error(f.error);
    expect(f.project).toBe('CPU build');
    const w = workspaceFromExport(f);
    expect(Object.keys(w.chips).sort()).toEqual(['u_fa', 'u_ha', 'u_main']);
    expect(w.folders).toEqual(src.folders);
    expect(w.favorites).toEqual(['mine/u_fa']);
    expect(w.open).toEqual(['u_main']);
  });
});

describe('projects', () => {
  it('starts with the first project on the old key, whatever the index says', () => {
    const kv = new MapKV();
    expect(readProjects(kv)).toEqual({ current: MAIN_PROJECT, list: [{ id: MAIN_PROJECT, name: 'My chips' }] });
    expect(projectKey(MAIN_PROJECT)).toBe(KEY);
    kv.setItem(PROJECTS_KEY, '{not json');
    expect(readProjects(kv).list.map((p) => p.id)).toEqual([MAIN_PROJECT]);
    kv.setItem(PROJECTS_KEY, JSON.stringify({ current: 'gone', list: [{ id: 'abc', name: 'Other' }, { id: 'BAD id' }] }));
    expect(readProjects(kv)).toEqual({ current: MAIN_PROJECT, list: [{ id: MAIN_PROJECT, name: 'My chips' }, { id: 'abc', name: 'Other' }] });
  });

  it('creates, renames, duplicates and deletes projects, each in its own key', () => {
    const kv = new MapKV();
    saveWorkspace(ws(chip('u_main'), chip('u_old')), kv);
    const a = createProject('CPU build', undefined, kv, 1000);
    if (!a.ok) throw new Error(a.reason);
    expect(loadWorkspace(kv, projectKey(a.id))).toEqual(emptyWorkspace());
    expect(Object.keys(loadWorkspace(kv).chips)).toEqual(['u_main', 'u_old']); // the first project is untouched
    expect(createProject('cpu build', undefined, kv)).toMatchObject({ ok: true, name: 'cpu build 2' });
    expect(renameProject(a.id, '  Traffic   lights ', kv)).toMatchObject({ ok: true, name: 'Traffic lights' });
    expect(renameProject(a.id, '   ', kv)).toEqual({ ok: false, reason: 'a project needs a name' });
    expect(projectNameOf(a.id, kv)).toBe('Traffic lights');

    saveWorkspace(ws(chip('u_x')), kv, projectKey(a.id));
    const d = duplicateProject(a.id, kv);
    if (!d.ok) throw new Error(d.reason);
    expect(d.name).toBe('Traffic lights copy');
    expect(Object.keys(loadWorkspace(kv, projectKey(d.id)).chips)).toEqual(['u_x']);

    expect(setCurrentProject(d.id, kv)).toBe(true);
    expect(setCurrentProject('nope', kv)).toBe(false);
    expect(deleteProject(d.id, kv)).toMatchObject({ ok: true });
    expect(kv.getItem(projectKey(d.id))).toBeNull();
    expect(readProjects(kv).current).toBe(MAIN_PROJECT);
    expect(deleteProject(MAIN_PROJECT, kv)).toMatchObject({ ok: false });
  });

  it('records chip counts and save times; lists a project key the index lost', () => {
    const kv = new MapKV();
    const a = createProject('A', ws(chip('u_a'), chip('u_b')), kv, 5);
    if (!a.ok) throw new Error(a.reason);
    expect(readProjects(kv).list[1]).toEqual({ id: a.id, name: 'A', chips: 2, modified: 5 });
    touchProject(a.id, ws(chip('u_a')), kv, 9);
    expect(readProjects(kv).list[1]).toMatchObject({ chips: 1, modified: 9 });
    kv.removeItem(PROJECTS_KEY);
    expect(readProjects(kv).list).toEqual([{ id: MAIN_PROJECT, name: 'My chips' }, { id: a.id, name: `Recovered project ${a.id}` }]);
  });

  it('deleting the sandbox data takes every project and the index', () => {
    const kv = new MapKV();
    saveWorkspace(ws(chip('u_a')), kv);
    createProject('B', undefined, kv);
    kv.setItem('mosfet2riscv:v1', '{}');
    deleteLocalData('sandbox', kv);
    expect([...kv.m.keys()]).toEqual(['mosfet2riscv:v1']);
  });

  it('"Open in Sandbox" from a chapter adds the chip to the current project', () => {
    const kv = new MapKV();
    saveWorkspace(ws(chip('u_main')), kv);
    const b = createProject('B', undefined, kv);
    if (!b.ok) throw new Error(b.reason);
    setCurrentProject(b.id, kv);
    const r = remixIntoStorage(resolveComponent('half_adder')!, kv);
    if ('error' in r) throw new Error(r.error);
    expect(loadWorkspace(kv, projectKey(b.id)).chips[r.id]).toBeDefined();
    expect(loadWorkspace(kv).chips[r.id]).toBeUndefined();
  });
});
