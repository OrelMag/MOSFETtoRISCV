// The learner's notes and bookmarks (DOM-free, tested in Node): free text on a chapter step, optionally pinned to a part
// of the circuit on its stage (the level shown, the part, the input values and cycle), and bookmarks on steps, workbench
// components and sandbox chips. Kept in a storage key of their own (injected like campaign/progress.ts; tests pass a Map),
// sanitized on load, never part of a share link. A deleted item stays as a tombstone for a while, so that merging a
// backup file (mergeNotes: union by id, the newest edit wins) does not bring it back.

import { moveStep, movedOf, STEP_MOVES } from '../chapters/stepmoves';

export const NOTES_KEY = 'mosfet2riscv:notes:v1';
const SCHEMA = 1;
const TOMB_MS = 90 * 24 * 3600 * 1000;
export const NOTE_MAX = 4000;
const MAX_ITEMS = 2000;

/** Where an item lives: a chapter step, a workbench component or a sandbox chip. */
export type Place = { kind: 'step'; chapter: string; step: number } | { kind: 'bench'; id: string } | { kind: 'chip'; id: string };

/** What a note is pinned to: the level shown (instance names from the root), the part on it, and the scene's state. */
export interface NotePin {
  path: string[];
  inst?: string;
  inputs?: Record<string, number>;
  cycle?: number;
}

export interface NoteItem {
  id: string;
  /** A note has text; a bookmark is the place alone. */
  type: 'note' | 'bookmark';
  place: Place;
  /** Words for the place when the code cannot say (a chip's name); chapters are named from the chapter list. */
  title: string;
  text: string;
  pin?: NotePin;
  /** When made, and last changed (ms since epoch). */
  at: number;
  edited: number;
  /** Deleted (the item is kept as a tombstone until it is old). */
  gone?: boolean;
}

export interface NotesState {
  /** Batches of chapters/stepmoves.ts already applied to the places. */
  moved?: number;
  schema: number;
  items: Record<string, NoteItem>;
}

export interface KV { getItem(k: string): string | null; setItem(k: string, v: string): void }

export const emptyNotes = (): NotesState => ({ schema: SCHEMA, moved: STEP_MOVES.length, items: {} });

export function placeKey(p: Place): string {
  return p.kind === 'step' ? `c:${p.chapter}:${p.step}` : p.kind === 'bench' ? `w:${p.id}` : `s:${p.id}`;
}

/** The page of a place, with the part pinned open when there is one (the stage reads the drill path from the hash). */
export function placeHref(p: Place, pin?: NotePin): string {
  const drill = pin ? (pin.path.length ? pin.path : []).map((n) => `/${encodeURIComponent(n)}`).join('') || '/~' : '';
  if (p.kind === 'step') return `#/c/${p.chapter}/${p.step}${drill}`;
  if (p.kind === 'bench') return `#/workbench/${p.id}${drill}`;
  return `#/sandbox/${p.id}`;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.length <= max ? v : null);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function sanitizePlace(v: unknown): Place | null {
  if (!isObj(v)) return null;
  if (v.kind === 'step') {
    const chapter = str(v.chapter, 80);
    return chapter && Number.isInteger(v.step) && (v.step as number) >= 0 && (v.step as number) < 1000 ? { kind: 'step', chapter, step: v.step as number } : null;
  }
  const id = str(v.id, 200);
  return id && (v.kind === 'bench' || v.kind === 'chip') ? { kind: v.kind, id } : null;
}

function sanitizePin(v: unknown): NotePin | undefined {
  if (!isObj(v) || !Array.isArray(v.path)) return undefined;
  const path = v.path.filter((x): x is string => typeof x === 'string' && x.length <= 200).slice(0, 40);
  if (path.length !== v.path.length) return undefined;
  const pin: NotePin = { path };
  const inst = str(v.inst, 200);
  if (inst) pin.inst = inst;
  if (isObj(v.inputs)) {
    const inputs: Record<string, number> = {};
    for (const [k, x] of Object.entries(v.inputs).slice(0, 64)) if (finite(x) && k.length <= 80) inputs[k] = x;
    pin.inputs = inputs;
  }
  if (finite(v.cycle) && v.cycle >= 0) pin.cycle = Math.floor(v.cycle);
  return pin;
}

function sanitizeItem(id: string, v: unknown): NoteItem | null {
  if (!isObj(v)) return null;
  const place = sanitizePlace(v.place);
  if (!place || (v.type !== 'note' && v.type !== 'bookmark') || !finite(v.at) || !finite(v.edited)) return null;
  const it: NoteItem = {
    id, type: v.type, place, title: str(v.title, 200) ?? '', text: str(v.text, NOTE_MAX) ?? '', at: v.at, edited: v.edited,
  };
  if (v.gone === true) {
    it.gone = true;
    it.text = '';
  } else {
    const pin = sanitizePin(v.pin);
    if (pin) it.pin = pin;
  }
  return it;
}

/** Untrusted JSON → a state with only well-formed items. */
export function sanitizeNotes(raw: unknown): NotesState {
  const st = emptyNotes();
  if (!isObj(raw) || !isObj(raw.items)) return st;
  const since = movedOf(raw);
  for (const [id, v] of Object.entries(raw.items).slice(0, MAX_ITEMS)) {
    const it = sanitizeItem(id.slice(0, 80), v);
    if (it?.place.kind === 'step') it.place = { kind: 'step', ...moveStep(it.place.chapter, it.place.step, since) };
    if (it) st.items[it.id] = it;
  }
  return st;
}

/** Two states made one (the backup file's merge): every id from either, the more recent edit winning; old tombstones dropped. */
export function mergeNotes(a: NotesState, b: NotesState, now = Date.now()): NotesState {
  const out = emptyNotes();
  for (const it of [...Object.values(a.items), ...Object.values(b.items)]) {
    const had = out.items[it.id];
    if (!had || it.edited > had.edited) out.items[it.id] = it;
  }
  for (const it of Object.values(out.items)) if (it.gone && now - it.edited > TOMB_MS) delete out.items[it.id];
  return out;
}

const defaultKV = (): KV | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export class NotesStore {
  private st: NotesState;
  private listeners = new Set<() => void>();
  private seq = 0;

  constructor(private kv: KV | null = defaultKV(), private clock: () => number = Date.now) {
    this.st = this.load();
  }

  private load(): NotesState {
    try {
      return sanitizeNotes(JSON.parse(this.kv?.getItem(NOTES_KEY) ?? 'null'));
    } catch {
      return emptyNotes();
    }
  }

  private save(): void {
    for (const it of Object.values(this.st.items)) if (it.gone && this.clock() - it.edited > TOMB_MS) delete this.st.items[it.id];
    try { this.kv?.setItem(NOTES_KEY, JSON.stringify(this.st)); } catch { /* not kept this time */ }
    this.listeners.forEach((f) => f());
  }

  /** Pick up what another tab (or an import) wrote. */
  reload(): void {
    this.st = this.load();
    this.listeners.forEach((f) => f());
  }

  /** Replace the state (the backup's restore), saved. */
  replace(next: NotesState): void {
    this.st = sanitizeNotes(next);
    this.save();
  }

  get state(): NotesState {
    return this.st;
  }

  onChange(f: () => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  private live(): NoteItem[] {
    return Object.values(this.st.items).filter((i) => !i.gone);
  }

  /** Every item worth listing (a note not typed yet is not), the most recently changed first. */
  list(): NoteItem[] {
    return this.live().filter((i) => i.type === 'bookmark' || i.text.trim()).sort((a, b) => b.edited - a.edited || (a.id < b.id ? -1 : 1));
  }

  /** The count shown on the top bar: notes with text plus bookmarks. */
  get count(): number {
    return this.list().length;
  }

  get(id: string): NoteItem | undefined {
    const it = this.st.items[id];
    return it && !it.gone ? it : undefined;
  }

  notesAt(p: Place): NoteItem[] {
    const k = placeKey(p);
    return this.live().filter((i) => i.type === 'note' && placeKey(i.place) === k).sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
  }

  bookmarkOf(p: Place): NoteItem | undefined {
    return this.get(`bm:${placeKey(p)}`);
  }

  isBookmarked(p: Place): boolean {
    return !!this.bookmarkOf(p);
  }

  /** Save or unsave a place; returns whether it is saved now. */
  toggleBookmark(p: Place, title: string): boolean {
    const id = `bm:${placeKey(p)}`;
    const t = this.clock();
    if (this.get(id)) {
      const old = this.st.items[id];
      this.st.items[id] = { ...old, gone: true, text: '', edited: Math.max(t, old.edited + 1) };
      this.save();
      return false;
    }
    const old = this.st.items[id];
    this.st.items[id] = { id, type: 'bookmark', place: p, title: title.slice(0, 200), text: '', at: t, edited: Math.max(t, (old?.edited ?? 0) + 1) };
    this.save();
    return true;
  }

  /** A new note (its text may fill in later through update). */
  add(p: Place, title: string, text = '', pin?: NotePin): NoteItem {
    const t = this.clock();
    const id = `n:${t.toString(36)}${(this.seq++).toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
    const it: NoteItem = { id, type: 'note', place: p, title: title.slice(0, 200), text: text.slice(0, NOTE_MAX), at: t, edited: t };
    if (pin) it.pin = pin;
    this.st.items[id] = it;
    this.save();
    return it;
  }

  update(id: string, patch: { text?: string; pin?: NotePin | null }): void {
    const it = this.get(id);
    if (!it) return;
    const next: NoteItem = { ...it, edited: Math.max(this.clock(), it.edited + 1) };
    if (patch.text !== undefined) next.text = patch.text.slice(0, NOTE_MAX);
    if (patch.pin === null) delete next.pin;
    else if (patch.pin) next.pin = patch.pin;
    this.st.items[id] = next;
    this.save();
  }

  remove(id: string): void {
    const it = this.st.items[id];
    if (!it || it.gone) return;
    this.st.items[id] = { ...it, gone: true, text: '', pin: undefined, edited: Math.max(this.clock(), it.edited + 1) };
    delete this.st.items[id].pin;
    this.save();
  }
}

let shared: NotesStore | null = null;
/** The page's store (browser storage). */
export function notes(): NotesStore {
  return shared ??= new NotesStore();
}

// ---- opening a note from the notes page ----------------------------------------------------------------

let pending: string | null = null;
/** The notes page asks the next stage that shows the note's place to restore its inputs and open it. */
export function openNoteNext(id: string | null): void {
  pending = id;
}
/** The note waiting to be opened on `place` (taken once). */
export function takeOpenNote(p: Place): NoteItem | undefined {
  const it = pending ? notes().get(pending) : undefined;
  if (!it || placeKey(it.place) !== placeKey(p)) return undefined;
  pending = null;
  return it;
}

/** A note's text to one line, for a list or a search row. */
export function snippet(text: string, n = 120): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
