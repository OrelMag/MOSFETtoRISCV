// Projects: separate sandbox workspaces, each in its own storage key, listed in an index. DOM-free
// (storage injected, like store.ts).
//
// The first project ('main') is the workspace the sandbox always had, under the key it always had
// (store.ts KEY): nothing to migrate, and the campaign keeps its level chips there whichever
// project the sandbox shows. It can be renamed, never deleted. Every other project is
// KEY:p:<id>. The index records each project's name and, at every save, its chip count and time,
// so the switcher lists them without reading every workspace. A project key the index does not
// list (an index lost or overwritten) is listed again rather than left unreachable.

import { emptyWorkspace, type Workspace } from './model';
import { KEY, MAX_PROJECT_NAME, loadWorkspace, saveWorkspace, type KV, type ListKV } from './store';

export const MAIN_PROJECT = 'main';
export const PROJECTS_KEY = `${KEY}:projects`;
const PREFIX = `${KEY}:p:`;

export interface ProjectMeta {
  id: string;
  name: string;
  /** Chips at the last save. */
  chips?: number;
  /** Last save (ms since the epoch). */
  modified?: number;
}

export interface ProjectIndex {
  /** The project the sandbox opens. */
  current: string;
  /** In the order the switcher lists them, the first project first. */
  list: ProjectMeta[];
}

/** The storage key of a project's workspace. */
export const projectKey = (id: string) => (id === MAIN_PROJECT ? KEY : `${PREFIX}${id}`);

const ID = /^[a-z0-9]{1,24}$/;
const DEFAULT_NAME = 'Main project';

function storage(): ListKV | null {
  try {
    return (globalThis as { localStorage?: ListKV }).localStorage ?? null;
  } catch {
    return null;
  }
}

const isList = (kv: KV): kv is ListKV => typeof (kv as ListKV).key === 'function' && typeof (kv as ListKV).length === 'number';

/** A project name as stored (trimmed, spaces collapsed, cut), or null when empty. */
export function cleanProjectName(name: string): string | null {
  const s = name.trim().replace(/\s+/g, ' ').slice(0, MAX_PROJECT_NAME).trim();
  return s || null;
}

/** The index, sanitized: the first project always there and first, ids unique, current a listed one. */
export function readProjects(kv: KV | null = storage()): ProjectIndex {
  const list: ProjectMeta[] = [];
  let current = MAIN_PROJECT;
  try {
    const raw = kv?.getItem(PROJECTS_KEY);
    const x = raw ? JSON.parse(raw) as { current?: unknown; list?: unknown } : null;
    for (const p of Array.isArray(x?.list) ? x.list : []) {
      if (typeof p !== 'object' || p === null) continue;
      const { id, name, chips, modified } = p as Record<string, unknown>;
      if (typeof id !== 'string' || !ID.test(id) || list.some((q) => q.id === id)) continue;
      const n = typeof name === 'string' ? cleanProjectName(name) : null;
      list.push({
        id, name: n ?? (id === MAIN_PROJECT ? DEFAULT_NAME : 'Project'),
        ...(Number.isInteger(chips) && (chips as number) >= 0 ? { chips: chips as number } : {}),
        ...(Number.isFinite(modified) ? { modified: modified as number } : {}),
      });
    }
    if (typeof x?.current === 'string') current = x.current;
  } catch {
    // an unreadable index: rebuilt from the keys below
  }
  if (kv && isList(kv)) {
    try {
      for (let i = 0; i < kv.length; i++) {
        const k = kv.key(i);
        const id = k?.startsWith(PREFIX) ? k.slice(PREFIX.length) : '';
        if (ID.test(id) && id !== MAIN_PROJECT && !list.some((p) => p.id === id)) list.push({ id, name: `Recovered project ${id}` });
      }
    } catch {
      // keys not listable: the index is all we know
    }
  }
  const main = list.find((p) => p.id === MAIN_PROJECT) ?? { id: MAIN_PROJECT, name: DEFAULT_NAME };
  const rest = list.filter((p) => p.id !== MAIN_PROJECT);
  const all = [main, ...rest];
  return { current: all.some((p) => p.id === current) ? current : MAIN_PROJECT, list: all };
}

function write(kv: KV | null, idx: ProjectIndex): boolean {
  try {
    kv?.setItem(PROJECTS_KEY, JSON.stringify(idx));
    return !!kv;
  } catch {
    return false;
  }
}

/** A name not used by another project: "CPU build", "CPU build 2", ... */
export function uniqueProjectName(idx: ProjectIndex, name: string, except?: string): string {
  const base = cleanProjectName(name) ?? 'Project';
  const taken = new Set(idx.list.filter((p) => p.id !== except).map((p) => p.name.toLocaleLowerCase()));
  let n = base;
  for (let i = 2; taken.has(n.toLocaleLowerCase()); i++) n = `${base} ${i}`;
  return n;
}

const newId = (idx: ProjectIndex) => {
  for (;;) {
    const id = (Date.now().toString(36) + Math.floor(Math.random() * 36 ** 4).toString(36)).slice(-12);
    if (!idx.list.some((p) => p.id === id)) return id;
  }
};

const meta = (ws: Workspace, now: number) => ({ chips: Object.keys(ws.chips).length, modified: now });

/** A project's name (the first project's default when it is not listed). */
export function projectNameOf(id: string, kv: KV | null = storage()): string {
  return readProjects(kv).list.find((p) => p.id === id)?.name ?? DEFAULT_NAME;
}

/** Record a save of a project (chip count, time) in the index. */
export function touchProject(id: string, ws: Workspace, kv: KV | null = storage(), now = Date.now()): void {
  const idx = readProjects(kv);
  const p = idx.list.find((q) => q.id === id);
  if (!p) return;
  Object.assign(p, meta(ws, now));
  write(kv, idx);
}

/** Make the sandbox open this project from now on. */
export function setCurrentProject(id: string, kv: KV | null = storage()): boolean {
  const idx = readProjects(kv);
  if (!idx.list.some((p) => p.id === id)) return false;
  return write(kv, { ...idx, current: id });
}

export type ProjectResult = { ok: true; id: string; name: string } | { ok: false; reason: string };

/** A new project holding `ws` (an empty one by default), listed after the others; not made current. */
export function createProject(name: string, ws: Workspace = emptyWorkspace(), kv: KV | null = storage(), now = Date.now()): ProjectResult {
  const idx = readProjects(kv);
  const id = newId(idx);
  const n = uniqueProjectName(idx, name);
  const saved = saveWorkspace(ws, kv, projectKey(id));
  if (!saved.ok) return saved;
  if (!write(kv, { ...idx, list: [...idx.list, { id, name: n, ...meta(ws, now) }] })) {
    try { kv?.removeItem(projectKey(id)); } catch { /* best effort */ }
    return { ok: false, reason: 'could not save the list of projects' };
  }
  return { ok: true, id, name: n };
}

/** A copy of a project's saved workspace under a new name ("CPU build copy"). */
export function duplicateProject(id: string, kv: KV | null = storage(), now = Date.now()): ProjectResult {
  const idx = readProjects(kv);
  const p = idx.list.find((q) => q.id === id);
  if (!p) return { ok: false, reason: 'no such project' };
  return createProject(`${p.name} copy`, loadWorkspace(kv, projectKey(id)), kv, now);
}

export function renameProject(id: string, name: string, kv: KV | null = storage()): ProjectResult {
  const idx = readProjects(kv);
  const p = idx.list.find((q) => q.id === id);
  if (!p) return { ok: false, reason: 'no such project' };
  if (!cleanProjectName(name)) return { ok: false, reason: 'a project needs a name' };
  p.name = uniqueProjectName(idx, name, id);
  return write(kv, idx) ? { ok: true, id, name: p.name } : { ok: false, reason: 'could not save the list of projects' };
}

/** Delete a project and its workspace (never the first one); the first becomes current if it was. */
export function deleteProject(id: string, kv: KV | null = storage()): ProjectResult {
  if (id === MAIN_PROJECT) return { ok: false, reason: 'the first project holds your campaign levels and cannot be deleted' };
  const idx = readProjects(kv);
  const p = idx.list.find((q) => q.id === id);
  if (!p) return { ok: false, reason: 'no such project' };
  const next: ProjectIndex = { current: idx.current === id ? MAIN_PROJECT : idx.current, list: idx.list.filter((q) => q.id !== id) };
  if (!write(kv, next)) return { ok: false, reason: 'could not save the list of projects' };
  try { kv?.removeItem(projectKey(id)); } catch { /* listed nowhere now; recovered if it stays */ }
  return { ok: true, id, name: p.name };
}
