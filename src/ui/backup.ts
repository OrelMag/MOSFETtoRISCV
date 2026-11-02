// One backup file for everything the site keeps in this browser (DOM-free; storage injected, like store.ts).
//
// The file holds the raw text of every `mosfet2riscv:` key: the chapters' progress and settings, the campaign, the
// puzzles, every sandbox project with its chips, and the small preferences. Importing never replaces: it is a merge
// computed on a staged copy of the storage, by the same rules the single-purpose imports use (campaign: furthest
// status and best result; chips: importChips, which never touches an existing chip; puzzles: the better record), and
// returns only the keys that changed. Nothing in the file is dropped silently: what cannot be read or is not ours is
// listed in `notes`.

import { mergeCampaign, sanitizeCampaign, CAMPAIGN_KEY, CAMPAIGN_FORMAT } from '../campaign/progress';
import { mergeFolders } from '../editor/folders';
import type { Workspace } from '../editor/model';
import { adoptProject, projectKey, readProjects, MAIN_PROJECT, PROJECTS_KEY } from '../editor/projects';
import { BACKUP_KEY, FORMAT as SANDBOX_FORMAT, KEY as SANDBOX_KEY, MAX_FAVORITES, SITE_PREFIX, importChips, loadWorkspace, localData, saveWorkspace, type ListKV } from '../editor/store';
import { mergeNotes, NOTES_KEY, sanitizeNotes } from './notes';
import { mergeReview, REVIEW_KEY, sanitizeReview } from './review';
import { LEARN_KEY, mergeLearn, sanitizeLearn } from '../learn/store';
import { betterRecord, PUZZLES_KEY, type PuzzleRecord } from '../puzzles/grade';

export const BACKUP_FORMAT = 'mosfet2riscv-backup';
export const BACKUP_SCHEMA = 1;
/** The ui settings key (settings.ts KEY): preferences and the chapters' progress in one object. */
export const SETTINGS_KEY = 'mosfet2riscv:v1';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A Map-backed store with the localStorage surface (tests, and the staged copy a merge works on). */
export class MapKV implements ListKV {
  readonly map: Map<string, string>;
  constructor(entries: Iterable<[string, string]> = []) { this.map = new Map(entries); }
  get length(): number { return this.map.size; }
  key(i: number): string | null { return [...this.map.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.map.get(k) ?? null; }
  setItem(k: string, v: string): void { this.map.set(k, v); }
  removeItem(k: string): void { this.map.delete(k); }
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  schema: number;
  /** The site version that wrote it (informational). */
  site?: string;
  created?: string;
  keys: Record<string, string>;
}

/** The backup of everything the site owns in `kv` (the unreadable-workspace copy stays out: it is not progress). */
export function makeBackup(kv: ListKV, site?: string, now = new Date()): string {
  const keys: Record<string, string> = {};
  for (const { key } of localData('all', kv)) {
    if (key === BACKUP_KEY) continue;
    const v = kv.getItem(key);
    if (v !== null) keys[key] = v;
  }
  const file: BackupFile = { format: BACKUP_FORMAT, schema: BACKUP_SCHEMA, ...(site ? { site } : {}), created: now.toISOString(), keys };
  return JSON.stringify(file, null, 1);
}

/** A backup file read: or why it is not one (pointing at the right import for the site's other export files). */
export function readBackup(text: string): { file: BackupFile; dropped: string[] } | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'This is not a JSON file.' };
  }
  if (!isObj(raw)) return { error: 'This is not a backup file.' };
  if (raw.format === CAMPAIGN_FORMAT) return { error: 'This is a campaign export. Import it from the campaign page (its Import button), which also brings the level chips.' };
  if (raw.format === SANDBOX_FORMAT) return { error: 'This is a sandbox chip export. Import it in the sandbox (File ▸ Import).' };
  if (raw.format !== BACKUP_FORMAT) return { error: 'This is not a MOSFET → RISC-V backup file.' };
  if (typeof raw.schema !== 'number' || !Number.isInteger(raw.schema) || raw.schema < 1) return { error: 'The backup has no version.' };
  if (raw.schema > BACKUP_SCHEMA) return { error: 'This backup was written by a newer version of the site. Reload the page to get the latest, then try again.' };
  if (!isObj(raw.keys)) return { error: 'The backup holds no data.' };
  const keys: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw.keys)) {
    // Only our own keys come in: a file must never write to anything else on this origin.
    if (!k.startsWith(SITE_PREFIX) || typeof v !== 'string' || k === BACKUP_KEY) dropped.push(k);
    else keys[k] = v;
  }
  return { file: { format: BACKUP_FORMAT, schema: raw.schema, ...(typeof raw.site === 'string' ? { site: raw.site.slice(0, 40) } : {}), ...(typeof raw.created === 'string' ? { created: raw.created.slice(0, 40) } : {}), keys }, dropped };
}

// ---- what a set of keys holds ------------------------------------------------------------------

export interface Summary {
  /** Chapter steps seen, in how many chapters. */
  steps: number;
  chapters: number;
  /** Checks and challenges solved in the chapters. */
  checks: number;
  campaignSolved: number;
  campaignStarted: number;
  puzzles: number;
  /** Notes and bookmarks (ui/notes.ts), questions in the review queue (ui/review.ts), chapters tested out in My path (learn/store.ts). */
  notes: number;
  bookmarks: number;
  reviewed: number;
  testedOut: number;
  projects: number;
  chips: number;
  /** Other keys: layouts, panel widths, hints seen, and the like. */
  other: number;
}

const parse = (s: string | null | undefined): unknown => {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
};

/** What `kv` holds, counted. */
export function summarize(kv: ListKV): Summary {
  const out: Summary = { steps: 0, chapters: 0, checks: 0, campaignSolved: 0, campaignStarted: 0, puzzles: 0, notes: 0, bookmarks: 0, reviewed: 0, testedOut: 0, projects: 0, chips: 0, other: 0 };
  const st = parse(kv.getItem(SETTINGS_KEY));
  if (isObj(st)) {
    if (isObj(st.visited)) for (const v of Object.values(st.visited)) if (Array.isArray(v) && v.length) { out.chapters++; out.steps += v.length; }
    if (isObj(st.solved)) out.checks = Object.values(st.solved).filter(Boolean).length;
  }
  const camp = sanitizeCampaign(parse(kv.getItem(CAMPAIGN_KEY)));
  for (const n of Object.values(camp.nodes)) {
    if (n.status === 'solved') out.campaignSolved++;
    else if (n.status === 'started') out.campaignStarted++;
  }
  const pz = parse(kv.getItem(PUZZLES_KEY));
  if (isObj(pz)) out.puzzles = Object.keys(pz).length;
  for (const it of Object.values(sanitizeNotes(parse(kv.getItem(NOTES_KEY))).items)) if (!it.gone) out[it.type === 'bookmark' ? 'bookmarks' : 'notes']++;
  out.reviewed = Object.keys(sanitizeReview(parse(kv.getItem(REVIEW_KEY))).memos).length;
  out.testedOut = Object.keys(sanitizeLearn(parse(kv.getItem(LEARN_KEY))).tested).length;
  const idx = readProjects(kv);
  out.projects = idx.list.filter((p) => p.id === MAIN_PROJECT ? !!kv.getItem(SANDBOX_KEY) : !!kv.getItem(projectKey(p.id))).length;
  for (const p of idx.list) {
    // A throwaway copy: loadWorkspace keeps an unreadable text under BACKUP_KEY, which must not reach the real storage.
    const probe = new MapKV();
    const text = kv.getItem(projectKey(p.id));
    if (text !== null) probe.setItem(projectKey(p.id), text);
    out.chips += Object.keys(loadWorkspace(probe, projectKey(p.id)).chips).length;
  }
  for (const { key } of localData('all', kv)) if (!OWNED.has(key) && !key.startsWith(`${SANDBOX_KEY}:p:`) && key !== BACKUP_KEY) out.other++;
  return out;
}

const OWNED = new Set([SETTINGS_KEY, CAMPAIGN_KEY, PUZZLES_KEY, PROJECTS_KEY, SANDBOX_KEY, NOTES_KEY, REVIEW_KEY, LEARN_KEY]);

/** The summary as lines of prose (the import dialog, the export confirmation). */
export function describe(s: Summary): string[] {
  const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
  const out: string[] = [];
  out.push(s.steps ? `Chapters: ${n(s.steps, 'step')} seen in ${n(s.chapters, 'chapter')}, ${n(s.checks, 'check')} solved` : 'Chapters: no progress');
  out.push(s.campaignSolved || s.campaignStarted ? `Campaign: ${n(s.campaignSolved, 'level')} solved, ${s.campaignStarted} started` : 'Campaign: no progress');
  out.push(s.puzzles ? `Puzzles: ${n(s.puzzles, 'puzzle')} solved` : 'Puzzles: none solved');
  out.push(`Sandbox: ${n(s.projects, 'project')}, ${n(s.chips, 'chip')}`);
  if (s.notes || s.bookmarks) out.push(`Notes: ${n(s.notes, 'note')}, ${n(s.bookmarks, 'bookmark')}`);
  if (s.reviewed) out.push(`Review queue: ${n(s.reviewed, 'question')} scheduled`);
  if (s.testedOut) out.push(`My path: ${n(s.testedOut, 'chapter')} tested out`);
  if (s.other) out.push(`${n(s.other, 'small preference')} (layouts, panel sizes, hints seen)`);
  return out;
}

// ---- merging -----------------------------------------------------------------------------------

export interface MergeResult {
  /** The keys to write, new text each (only those that changed). */
  writes: Record<string, string>;
  /** Things in the file that were not merged, and why (never empty when something was left out). */
  notes: string[];
  before: Summary;
  after: Summary;
}

const sortedUnion = (a: unknown, b: unknown): number[] => {
  const ok = (x: unknown): number[] => (Array.isArray(x) ? x.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < 10_000) : []);
  return [...new Set([...ok(a), ...ok(b)])].sort((x, y) => x - y);
};

/** The settings key: the learner's preferences stay as they are; visited steps join, solved checks join, the file only fills what is empty. */
export function mergeSettings(local: unknown, incoming: unknown): Record<string, unknown> {
  const a = isObj(local) ? local : {};
  const b = isObj(incoming) ? incoming : {};
  const out: Record<string, unknown> = { ...b, ...a };
  const visited: Record<string, number[]> = {};
  const av = isObj(a.visited) ? a.visited : {}, bv = isObj(b.visited) ? b.visited : {};
  for (const id of new Set([...Object.keys(av), ...Object.keys(bv)])) visited[id] = sortedUnion(av[id], bv[id]);
  out.visited = visited;
  const solved: Record<string, boolean> = {};
  for (const m of [b.solved, a.solved]) if (isObj(m)) for (const [k, v] of Object.entries(m)) if (v) solved[k] = true;
  out.solved = solved;
  out.openActs = { ...(isObj(b.openActs) ? b.openActs : {}), ...(isObj(a.openActs) ? a.openActs : {}) };
  if (isObj(a.last)) out.last = a.last;
  else if (isObj(b.last)) out.last = b.last;
  return out;
}

/** Puzzle records: the better of the two per puzzle (grade.ts betterRecord, the rule solving uses). */
export function mergePuzzles(local: unknown, incoming: unknown): Record<string, PuzzleRecord> {
  const out: Record<string, PuzzleRecord> = {};
  const ok = (r: unknown): r is PuzzleRecord => isObj(r) && (r.stars === 1 || r.stars === 2 || r.stars === 3) && isObj(r.best)
    && typeof r.best.cycles === 'number' && typeof r.best.nands === 'number';
  for (const [id, r] of Object.entries(isObj(local) ? local : {})) if (ok(r)) out[id] = r;
  for (const [id, r] of Object.entries(isObj(incoming) ? incoming : {})) if (ok(r) && betterRecord(r, out[id])) out[id] = r;
  return out;
}

/** A file's workspace merged into ours: chips never overwrite (importChips), folders for the chips that came in, favorites and instruction sets added. */
export function mergeWorkspace(local: Workspace, incoming: Workspace): Workspace {
  const r = importChips(Object.values(incoming.chips), local);
  let ws = r.ws;
  if (incoming.folders?.length) ws = mergeFolders(ws, incoming.folders, (id) => r.renamed[id] ?? id, r.added);
  const fav = [...new Set([...(ws.favorites ?? []), ...(incoming.favorites ?? [])])].slice(0, MAX_FAVORITES);
  if (fav.length && fav.length !== (ws.favorites ?? []).length) ws = { ...ws, favorites: fav };
  if (incoming.isas) {
    const isas = { ...incoming.isas, ...(ws.isas ?? {}) };
    if (Object.keys(isas).length !== Object.keys(ws.isas ?? {}).length) ws = { ...ws, isas };
  }
  return ws;
}

/**
 * Merge a backup into the storage `kv` without touching it: the changed keys are returned. Run it on the same
 * storage twice and the second result is empty (every step is idempotent).
 */
export function mergeBackup(file: BackupFile, kv: ListKV): MergeResult {
  const stage = new MapKV(localData('all', kv).map(({ key }) => [key, kv.getItem(key) ?? ''] as [string, string]));
  const theirs = new MapKV(Object.entries(file.keys));
  const notes: string[] = [];
  const before = summarize(stage);
  const put = (k: string, v: unknown) => stage.setItem(k, JSON.stringify(v));
  const unreadable = (k: string, what: string) => notes.push(`${what} in the file could not be read and was left out (${k}).`);

  // chapters
  if (theirs.getItem(SETTINGS_KEY) !== null) {
    const inc = parse(theirs.getItem(SETTINGS_KEY));
    if (!isObj(inc)) unreadable(SETTINGS_KEY, 'The settings and chapter progress');
    else if (stage.getItem(SETTINGS_KEY) === null) stage.setItem(SETTINGS_KEY, theirs.getItem(SETTINGS_KEY)!);
    else put(SETTINGS_KEY, mergeSettings(parse(stage.getItem(SETTINGS_KEY)), inc));
  }
  // campaign
  if (theirs.getItem(CAMPAIGN_KEY) !== null) {
    if (!isObj(parse(theirs.getItem(CAMPAIGN_KEY)))) unreadable(CAMPAIGN_KEY, 'The campaign progress');
    else put(CAMPAIGN_KEY, mergeCampaign(sanitizeCampaign(parse(stage.getItem(CAMPAIGN_KEY))), sanitizeCampaign(parse(theirs.getItem(CAMPAIGN_KEY)))));
  }
  // puzzles
  if (theirs.getItem(PUZZLES_KEY) !== null) {
    if (!isObj(parse(theirs.getItem(PUZZLES_KEY)))) unreadable(PUZZLES_KEY, 'The puzzle progress');
    else put(PUZZLES_KEY, mergePuzzles(parse(stage.getItem(PUZZLES_KEY)), parse(theirs.getItem(PUZZLES_KEY))));
  }
  // notes and bookmarks: union by id, the newest edit wins; the review history: the later answer per question
  if (theirs.getItem(NOTES_KEY) !== null) {
    if (!isObj(parse(theirs.getItem(NOTES_KEY)))) unreadable(NOTES_KEY, 'The notes and bookmarks');
    else put(NOTES_KEY, mergeNotes(sanitizeNotes(parse(stage.getItem(NOTES_KEY))), sanitizeNotes(parse(theirs.getItem(NOTES_KEY)))));
  }
  if (theirs.getItem(REVIEW_KEY) !== null) {
    if (!isObj(parse(theirs.getItem(REVIEW_KEY)))) unreadable(REVIEW_KEY, 'The review history');
    else put(REVIEW_KEY, mergeReview(sanitizeReview(parse(stage.getItem(REVIEW_KEY))), sanitizeReview(parse(theirs.getItem(REVIEW_KEY)))));
  }
  // My path: every test-out, the later start and placement
  if (theirs.getItem(LEARN_KEY) !== null) {
    if (!isObj(parse(theirs.getItem(LEARN_KEY)))) unreadable(LEARN_KEY, 'My path');
    else put(LEARN_KEY, mergeLearn(sanitizeLearn(parse(stage.getItem(LEARN_KEY))), sanitizeLearn(parse(theirs.getItem(LEARN_KEY)))));
  }
  // sandbox projects: the first one (it holds the campaign's level chips) merges chip by chip; the others by id
  const workspaceOf = (store: MapKV, key: string): Workspace | null => {
    const text = store.getItem(key);
    if (text === null) return null;
    const probe = new MapKV([[key, text]]);
    const ws = loadWorkspace(probe, key);
    return probe.getItem(BACKUP_KEY) !== null ? null : ws;
  };
  const mergeInto = (key: string, name: string): void => {
    const inc = workspaceOf(theirs, key);
    if (theirs.getItem(key) !== null && !inc) { notes.push(`The sandbox workspace "${name}" in the file could not be read and was left out.`); return; }
    if (!inc) return;
    const mine = workspaceOf(stage, key);
    // Nothing here yet (a fresh browser): the file's workspace as it is, not merged into a starter chip.
    if (!mine) { saveWorkspace(inc, stage, key); return; }
    const ws = mergeWorkspace(mine, inc);
    if (JSON.stringify(ws) !== JSON.stringify(mine)) saveWorkspace(ws, stage, key);
  };
  mergeInto(SANDBOX_KEY, 'the first project');
  const incoming = readProjects(theirs);
  for (const p of incoming.list) {
    if (p.id === MAIN_PROJECT) continue;
    const key = projectKey(p.id);
    if (theirs.getItem(key) === null) continue;
    if (readProjects(stage).list.some((q) => q.id === p.id)) mergeInto(key, p.name);
    else {
      const inc = workspaceOf(theirs, key);
      if (!inc) notes.push(`The project "${p.name}" in the file could not be read and was left out.`);
      else if (!adoptProject(p, inc, stage)) notes.push(`The project "${p.name}" could not be added.`);
    }
  }
  // everything else: taken where the learner has nothing; where both differ, theirs on this device stays
  let kept = 0;
  for (const [k, v] of theirs.map) {
    if (OWNED.has(k) || k.startsWith(`${SANDBOX_KEY}:p:`)) continue;
    const mine = stage.getItem(k);
    if (mine === null) stage.setItem(k, v);
    else if (mine !== v) kept++;
  }
  if (kept) notes.push(`${kept} small preference${kept === 1 ? '' : 's'} (layouts, panel sizes) differ; yours on this device were kept.`);

  const writes: Record<string, string> = {};
  for (const [k, v] of stage.map) if (kv.getItem(k) !== v && k !== BACKUP_KEY) writes[k] = v;
  return { writes, notes, before, after: summarize(stage) };
}

/** Write a merge's keys; returns the first failure (a full storage), after which nothing more is written. */
export function applyMerge(r: MergeResult, kv: ListKV): { ok: true } | { ok: false; reason: string } {
  const done: [string, string | null][] = [];
  try {
    for (const [k, v] of Object.entries(r.writes)) {
      done.push([k, kv.getItem(k)]);
      kv.setItem(k, v);
    }
    return { ok: true };
  } catch (e) {
    // put back what was written: half a merge is worse than none
    for (const [k, old] of done.reverse()) {
      try { if (old === null) kv.removeItem(k); else kv.setItem(k, old); } catch { /* best effort */ }
    }
    return { ok: false, reason: e instanceof Error && /quota/i.test(`${e.name} ${e.message}`) ? 'The browser storage is full. Export your sandbox chips and free some space.' : 'The browser would not store the merged data.' };
  }
}

/** A file name for today's backup. */
export const backupName = (now = new Date()): string => `mosfet-riscv-backup-${now.toISOString().slice(0, 10)}.json`;
