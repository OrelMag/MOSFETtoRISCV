// Folders of "My chips" (Workspace.folders): one level, a chip in at most one, the rest unfiled.
// Only a way to find chips: ids, documents, links and Verilog never see them. Pure functions; the
// palette, the chip manager and the chip's properties call them through Editor.editWs (one undo
// step each).

import type { ChipDoc, FolderDoc, Workspace } from './model';

export const MAX_FOLDER_NAME = 40;
export const MAX_FOLDERS = 100;

/** A folder name as stored (trimmed, inner runs of spaces collapsed), or null when empty or too long. */
export function cleanFolderName(name: string): string | null {
  const s = name.trim().replace(/\s+/g, ' ');
  return s && s.length <= MAX_FOLDER_NAME ? s : null;
}

const key = (name: string) => name.toLocaleLowerCase();

/** The folder with this name (case-insensitive). */
export function findFolder(ws: Workspace, name: string): FolderDoc | undefined {
  const k = key(name);
  return ws.folders?.find((f) => key(f.name) === k);
}

/** The folder a chip is filed in. */
export function folderOf(ws: Workspace, chipId: string): string | undefined {
  return ws.folders?.find((f) => f.chips.includes(chipId))?.name;
}

const withFolders = (ws: Workspace, folders: FolderDoc[]): Workspace => {
  const next: Workspace = { ...ws, folders };
  if (!folders.length) delete next.folders;
  return next;
};

/** "New folder", "New folder 2", ...: the first name not taken. */
export function newFolderName(ws: Workspace, base = 'New folder'): string {
  let name = base;
  for (let i = 2; findFolder(ws, name); i++) name = `${base} ${i}`;
  return name;
}

/** Why a name cannot be a folder's (empty, too long, taken by another folder), or null. */
export function folderNameProblem(ws: Workspace, name: string, except?: string): string | null {
  const n = cleanFolderName(name);
  if (!n) return name.trim() ? `at most ${MAX_FOLDER_NAME} characters` : 'a folder needs a name';
  const f = findFolder(ws, n);
  if (f && (except === undefined || key(f.name) !== key(except))) return `there is already a folder ${f.name}`;
  if (!f && except === undefined && (ws.folders?.length ?? 0) >= MAX_FOLDERS) return `at most ${MAX_FOLDERS} folders`;
  return null;
}

/** A new empty folder at the end. */
export function addFolder(ws: Workspace, name: string): { ws: Workspace; name: string } | { error: string } {
  const problem = folderNameProblem(ws, name);
  if (problem) return { error: problem };
  const n = cleanFolderName(name)!;
  return { ws: withFolders(ws, [...(ws.folders ?? []), { name: n, chips: [] }]), name: n };
}

export function renameFolder(ws: Workspace, from: string, to: string): { ws: Workspace; name: string } | { error: string } {
  const f = findFolder(ws, from);
  if (!f) return { error: `no folder ${from}` };
  const problem = folderNameProblem(ws, to, f.name);
  if (problem) return { error: problem };
  const n = cleanFolderName(to)!;
  return { ws: withFolders(ws, ws.folders!.map((g) => (g === f ? { ...g, name: n } : g))), name: n };
}

/** Remove a folder; its chips stay, unfiled. */
export function removeFolder(ws: Workspace, name: string): Workspace {
  const f = findFolder(ws, name);
  return f ? withFolders(ws, ws.folders!.filter((g) => g !== f)) : ws;
}

/**
 * File a chip in a folder (made at the end if it does not exist), at the end of it or before
 * `before`; null takes it out of every folder. The same folder again moves nothing.
 */
export function moveToFolder(ws: Workspace, chipId: string, name: string | null, before?: string): Workspace {
  if (!ws.chips[chipId]) return ws;
  const target = name === null ? null : cleanFolderName(name);
  if (name !== null && !target) return ws;
  const cur = folderOf(ws, chipId);
  if (target && cur && key(cur) === key(target) && before === undefined) return ws;
  if (target === null && cur === undefined) return ws;
  let folders = (ws.folders ?? []).map((f) => (f.chips.includes(chipId) ? { ...f, chips: f.chips.filter((c) => c !== chipId) } : f));
  if (target) {
    if (!folders.some((f) => key(f.name) === key(target))) folders = [...folders, { name: target, chips: [] }];
    folders = folders.map((f) => {
      if (key(f.name) !== key(target)) return f;
      const chips = f.chips.slice();
      const at = before === undefined ? -1 : chips.indexOf(before);
      chips.splice(at < 0 ? chips.length : at, 0, chipId);
      return { ...f, chips };
    });
  }
  return withFolders(ws, folders);
}

/** A copy of `src` (duplicateChip) filed right after it. */
export function fileCopy(ws: Workspace, src: string, copy: string): Workspace {
  const f = ws.folders?.find((g) => g.chips.includes(src));
  if (!f) return ws;
  return withFolders(ws, ws.folders!.map((g) => (g === f ? { ...g, chips: g.chips.flatMap((c) => (c === src ? [c, copy] : c === copy ? [] : [c])) } : g)));
}

/** Folders without chips the workspace no longer has (a deleted chip), each chip in one folder only. */
export function pruneFolders(ws: Workspace): Workspace {
  if (!ws.folders) return ws;
  const seen = new Set<string>();
  let changed = false;
  const folders = ws.folders.map((f) => {
    const chips = f.chips.filter((c) => ws.chips[c] && !seen.has(c) && (seen.add(c), true));
    if (chips.length !== f.chips.length) changed = true;
    return chips.length === f.chips.length ? f : { ...f, chips };
  });
  return changed ? withFolders(ws, folders) : ws;
}

/** The chips by folder, in order (empty folders too), then the unfiled ones (name null) in workspace order. */
export function folderGroups(ws: Workspace, keep: (c: ChipDoc) => boolean = () => true): { name: string | null; chips: ChipDoc[] }[] {
  const filed = new Set<string>();
  const out: { name: string | null; chips: ChipDoc[] }[] = [];
  for (const f of ws.folders ?? []) {
    const chips = f.chips.flatMap((id) => (ws.chips[id] && !filed.has(id) && (filed.add(id), true) && keep(ws.chips[id]) ? [ws.chips[id]] : []));
    out.push({ name: f.name, chips });
  }
  out.push({ name: null, chips: Object.values(ws.chips).filter((c) => !filed.has(c.id) && keep(c)) });
  return out;
}

/**
 * Folders read from a file, merged into a workspace after an import: each chip the import added
 * (under the id it ended up as) goes into the folder of the same name, made if missing. Chips that
 * were already there keep their own filing.
 */
export function mergeFolders(ws: Workspace, incoming: FolderDoc[], idOf: (id: string) => string, added: readonly string[]): Workspace {
  const fresh = new Set(added);
  let out = ws;
  for (const f of incoming) {
    const ids = f.chips.map(idOf).filter((id) => fresh.has(id));
    if (!ids.length && f.chips.length) continue;
    if (!ids.length) {
      if (!findFolder(out, f.name)) { const r = addFolder(out, f.name); if ('ws' in r) out = r.ws; }
      continue;
    }
    for (const id of ids) out = moveToFolder(out, id, findFolder(out, f.name)?.name ?? f.name);
  }
  return out;
}

/** Folders as stored: clean unique names, ids of chips the workspace has, each chip once. */
export function sanitizeFolders(x: unknown, chips: Record<string, unknown>): FolderDoc[] {
  const out: FolderDoc[] = [];
  const names = new Set<string>();
  const seen = new Set<string>();
  for (const f of Array.isArray(x) ? x : []) {
    if (typeof f !== 'object' || f === null || out.length >= MAX_FOLDERS) continue;
    const { name, chips: ids } = f as { name?: unknown; chips?: unknown };
    const n = typeof name === 'string' ? cleanFolderName(name) : null;
    if (!n || names.has(key(n))) continue;
    names.add(key(n));
    const list = (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string' && id in chips && !seen.has(id));
    list.forEach((id) => seen.add(id));
    out.push({ name: n, chips: list });
  }
  return out;
}
