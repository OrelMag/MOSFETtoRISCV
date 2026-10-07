// Persistence of the sandbox workspace: browser storage, JSON files, and the sanitizer that
// every way in (storage, file, share link) goes through. Nothing here touches the DOM; storage
// is injected (a Map-backed KV in the tests, localStorage in the browser).
//
// Loading never throws and never loses data silently: anything it cannot read (corrupt JSON, a
// newer schema) is copied to BACKUP_KEY before the empty workspace replaces it.

import { sanitizeCpu } from './cpu';
import { same } from './history';
import {
  SCHEMA, chipDeps, emptyWorkspace, isIdent, isPinValue, pinValue, uniqueName,
  type ChipDoc, type DisplayKind, type EndRef, type ExitDir, type LabelDoc, type PartDoc, type PartRef,
  type PinDoc, type PinValue, type Vec, type WireDoc, type Workspace,
} from './model';

export interface KV {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export const KEY = 'mosfet2riscv:sandbox:v1';
export const BACKUP_KEY = `${KEY}:unreadable`;
export const FORMAT = 'mosfet2riscv-sandbox';

/** localStorage when it exists and is reachable (it throws in some private modes). */
function defaultKV(): KV | null {
  try {
    return (globalThis as { localStorage?: KV }).localStorage ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Sanitizer: rebuilds documents field by field from untrusted JSON. An object missing a
// required field is dropped (and wires that end on dropped objects with it), never a crash.

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const int = (x: unknown, min = 0): x is number => Number.isInteger(x) && (x as number) >= min;
const str = (x: unknown): x is string => typeof x === 'string';
const vec = (x: unknown): Vec | null => (Array.isArray(x) && x.length === 2 && num(x[0]) && num(x[1]) ? [x[0], x[1]] : null);
const DIRS: ExitDir[] = ['left', 'right', 'up', 'down'];
const face = (x: unknown): ExitDir | undefined => (DIRS.includes(x as ExitDir) ? (x as ExitDir) : undefined);
const DISPLAYS: DisplayKind[] = ['led', 'seg7', 'hex', 'value', 'halt'];

/** Copies only the keys whose value is not undefined (so optional fields stay absent). */
function compact<T extends object>(o: T): T {
  for (const k of Object.keys(o)) if ((o as Obj)[k] === undefined) delete (o as Obj)[k];
  return o;
}

function sanitizeRef(r: unknown): PartRef | null {
  if (!isObj(r)) return null;
  const bits = (x: unknown) => (Array.isArray(x) && x.length > 0 && x.every((n) => int(n, 1)) ? (x as number[]).slice() : null);
  const pitch = num(r.pitch) && r.pitch > 0 ? r.pitch : undefined;
  if (str(r.lib)) return { lib: r.lib };
  if (str(r.chip)) return { chip: r.chip };
  if ('split' in r) { const s = bits(r.split); return s && compact({ split: s, pitch }); }
  if ('merge' in r) { const s = bits(r.merge); return s && compact({ merge: s, pitch }); }
  if (isObj(r.const)) {
    const { width, value } = r.const;
    return int(width, 1) && int(value) ? { const: { width, value } } : null;
  }
  if (DISPLAYS.includes(r.display as DisplayKind)) return compact({ display: r.display as DisplayKind, width: int(r.width, 1) ? r.width : undefined });
  if (isObj(r.rom)) {
    const { k, w, addr, lang, src } = r.rom;
    if (!int(k) || (w !== 8 && w !== 16 && w !== 32) || (addr !== 'word' && addr !== 'rv32') || (lang !== 'asm' && lang !== 'hex') || !str(src)) return null;
    return { rom: { k, w, addr, lang, src } };
  }
  if (isObj(r.ram)) {
    const { k, w, init } = r.ram;
    if (!int(k) || !int(w, 1)) return null;
    const words = Array.isArray(init) && init.length <= 1 << 16 && init.every((x) => int(x)) ? (init as number[]).slice() : undefined;
    return { ram: words?.some((x) => x) ? { k, w, init: words } : { k, w } };
  }
  return null;
}

function sanitizeEnd(e: unknown): EndRef | null {
  if (!isObj(e)) return null;
  if (str(e.part) && str(e.port)) return { part: e.part, port: e.port };
  if (str(e.pin)) return { pin: e.pin };
  if (str(e.label)) return { label: e.label };
  const at = vec(e.at);
  return str(e.wire) && at ? { wire: e.wire, at } : null;
}

function sanitizePin(p: unknown): PinDoc | null {
  if (!isObj(p) || !str(p.id) || !str(p.name) || !isIdent(p.name) || (p.dir !== 'in' && p.dir !== 'out' && p.dir !== 'inout') || !int(p.width, 1)) return null;
  const at = vec(p.at);
  if (!at) return null;
  const kind = p.kind === 'toggle' || p.kind === 'button' || p.kind === 'clock' ? p.kind : undefined;
  return compact<PinDoc>({ id: p.id, name: p.name, dir: p.dir, width: p.width, at, face: face(p.face), kind, value: pinValueOf(p.value) });
}

/**
 * A stored pin value in its one spelling: integers (older documents may hold one past 2^53,
 * which BigInt takes exactly as written) and 0x hex text (wide pins).
 */
const pinValueOf = (x: unknown): PinValue | undefined =>
  int(x) || (typeof x === 'string' && isPinValue(x)) ? pinValue(BigInt(x)) : undefined;

function sanitizeFf(f: unknown): ChipDoc['ff'] {
  if (!isObj(f) || !str(f.d) || !str(f.q) || !str(f.clk) || (f.en !== undefined && !str(f.en))) return undefined;
  return compact({ d: f.d, q: f.q, clk: f.clk, en: f.en });
}

function sanitizePart(p: unknown): PartDoc | null {
  if (!isObj(p) || !str(p.id) || !isIdent(p.id)) return null;
  const ref = sanitizeRef(p.ref);
  const at = vec(p.at);
  if (!ref || !at) return null;
  return compact({ id: p.id, ref, at, flip: p.flip === true ? true : undefined, label: str(p.label) ? p.label : undefined });
}

function sanitizeWire(w: unknown): WireDoc | null {
  if (!isObj(w) || !str(w.id)) return null;
  const [a, b] = [sanitizeEnd(w.a), sanitizeEnd(w.b)];
  const pts = Array.isArray(w.pts) ? w.pts.map(vec) : null;
  if (!a || !b || !pts || pts.some((p) => !p)) return null;
  return compact<WireDoc>({
    id: w.id, a, b, pts: pts as Vec[],
    name: str(w.name) ? w.name : undefined,
    cap: w.cap === true ? true : undefined,
    init: w.init === 0 ? 0 : w.init === 1 ? 1 : undefined,
  });
}

function sanitizeLabel(l: unknown): LabelDoc | null {
  const at = isObj(l) ? vec(l.at) : null;
  if (!isObj(l) || !str(l.id) || !str(l.name) || !l.name.trim() || !at) return null;
  return compact({ id: l.id, name: l.name, at, face: face(l.face) });
}

function list<T extends { id: string }>(x: unknown, f: (v: unknown) => T | null): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const v of Array.isArray(x) ? x : []) {
    const r = f(v);
    if (r && !seen.has(r.id)) { seen.add(r.id); out.push(r); }
  }
  return out;
}

/** A clean ChipDoc from untrusted JSON, or null if it lacks an id. */
export function sanitizeChip(c: unknown): ChipDoc | null {
  if (!isObj(c) || !str(c.id) || !isIdent(c.id)) return null;
  const pins = list(c.pins, sanitizePin);
  const parts = list(c.parts, sanitizePart);
  const labels = list(c.labels, sanitizeLabel);
  let wires = list(c.wires, sanitizeWire);
  // Pin names must be unique too (they become port names): later duplicates go.
  const names = new Set<string>();
  const uniquePins = pins.filter((p) => !names.has(p.name) && !!names.add(p.name));
  const ok = new Set([...parts.map((p) => `p:${p.id}`), ...uniquePins.map((p) => `pin:${p.id}`), ...labels.map((l) => `l:${l.id}`)]);
  for (let shrank = true; shrank;) {
    const ws = new Set(wires.map((w) => w.id));
    const live = (e: EndRef) => ('part' in e ? ok.has(`p:${e.part}`) : 'pin' in e ? ok.has(`pin:${e.pin}`) : 'label' in e ? ok.has(`l:${e.label}`) : ws.has(e.wire));
    const kept = wires.filter((w) => live(w.a) && live(w.b));
    shrank = kept.length < wires.length;
    wires = kept;
  }
  return compact<ChipDoc>({
    id: c.id,
    name: str(c.name) && c.name.trim() ? c.name : c.id,
    hue: num(c.hue) ? ((Math.round(c.hue) % 360) + 360) % 360 : undefined,
    notes: str(c.notes) ? c.notes : undefined,
    ff: sanitizeFf(c.ff),
    cpu: sanitizeCpu(c.cpu),
    pins: uniquePins, parts, wires, labels,
  });
}

/**
 * A Workspace from parsed JSON of any schema this build knows (only 1 so far), sanitized.
 * A newer schema is refused rather than half-read.
 */
export function migrate(raw: unknown): Workspace | { error: string } {
  if (!isObj(raw)) return { error: 'not a sandbox workspace' };
  if (!int(raw.schema, 1)) return { error: 'missing schema version' };
  if (raw.schema > SCHEMA) return { error: `saved by a newer version of the site (schema ${raw.schema}; this one reads ${SCHEMA})` };
  // Older schemas would be upgraded here, one step at a time.
  const chips: Record<string, ChipDoc> = {};
  for (const v of isObj(raw.chips) ? Object.values(raw.chips) : Array.isArray(raw.chips) ? raw.chips : []) {
    const c = sanitizeChip(v);
    if (c && !chips[c.id]) chips[c.id] = c;
  }
  if (!Object.keys(chips).length) return emptyWorkspace();
  const open = [...new Set(Array.isArray(raw.open) ? raw.open.filter((id): id is string => str(id) && !!chips[id]) : [])];
  const ws: Workspace = { schema: SCHEMA, chips, open: open.length ? open : [Object.keys(chips)[0]] };
  if (typeof raw.purist === 'boolean') ws.purist = raw.purist;
  return ws;
}

// ---------------------------------------------------------------------------------------------
// Browser storage

export function loadWorkspace(kv: KV | null = defaultKV()): Workspace {
  if (!kv) return emptyWorkspace();
  let text: string | null = null;
  try {
    text = kv.getItem(KEY);
    if (text === null) return emptyWorkspace();
    const r = migrate(JSON.parse(text));
    if (!('error' in r)) return r;
  } catch {
    // corrupt JSON or unreadable storage: fall through
  }
  try {
    if (text !== null) kv.setItem(BACKUP_KEY, text);
  } catch {
    // nothing more we can do
  }
  return emptyWorkspace();
}

export function saveWorkspace(ws: Workspace, kv: KV | null = defaultKV()): { ok: true } | { ok: false; reason: string } {
  if (!kv) return { ok: false, reason: 'browser storage is not available' };
  try {
    kv.setItem(KEY, JSON.stringify(ws));
    return { ok: true };
  } catch (e) {
    const quota = e instanceof Error && /quota/i.test(`${e.name} ${e.message}`);
    return { ok: false, reason: quota ? 'browser storage is full: export your chips to a file' : `could not save: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Files

/** The chips and every chip they place, transitively; dependencies before the chips using them. */
export function closure(ws: Workspace, ids: string[]): ChipDoc[] {
  const out: ChipDoc[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    const c = ws.chips[id];
    if (!c || seen.has(id)) return;
    seen.add(id);
    for (const d of chipDeps(c)) visit(d);
    out.push(c);
  };
  for (const id of ids) visit(id);
  return out;
}

export function exportJson(ws: Workspace, ids: string[]): string {
  return JSON.stringify({ format: FORMAT, schema: SCHEMA, chips: closure(ws, ids) }, null, 2);
}

/** `order`: the id every incoming chip ended up as (added or already there), dependencies first. */
export type Imported = { ws: Workspace; added: string[]; renamed: Record<string, string>; skipped: string[]; order: string[] };

/** Rewrites the chip refs of a chip's parts (only copying parts that change). */
function renameRefs(c: ChipDoc, renamed: Record<string, string>): ChipDoc {
  if (!c.parts.some((p) => 'chip' in p.ref && renamed[p.ref.chip])) return c;
  return { ...c, parts: c.parts.map((p) => ('chip' in p.ref && renamed[p.ref.chip] ? { ...p, ref: { chip: renamed[p.ref.chip] } } : p)) };
}

/** Incoming chips in dependency order (deps first), file order otherwise. */
function depOrder(chips: ChipDoc[]): ChipDoc[] {
  const by = new Map(chips.map((c) => [c.id, c]));
  return closure({ schema: SCHEMA, chips: Object.fromEntries(by), open: [] }, [...by.keys()]);
}

/**
 * Adds the chips of an exported file (or a decoded share link) to the workspace. A chip whose id
 * exists with the same content is skipped; with different content it comes in under a new id
 * (u_x_2) and the imported chips that place it are rewritten. Existing chips are never touched.
 * A renamed chip whose name is also taken gets a numbered name ("Adder 2"), so the two can be
 * told apart in tabs and the palette. A chip that an earlier import of the same file already
 * renamed (u_x_2, same content but for the name) is recognized and skipped, so opening a link
 * twice does not pile up copies.
 */
export function importChips(chips: ChipDoc[], ws: Workspace): Imported {
  const incoming = depOrder(chips);
  const taken = new Set([...Object.keys(ws.chips), ...incoming.map((c) => c.id)]);
  const all = { ...ws.chips };
  const added: string[] = [], skipped: string[] = [], order: string[] = [];
  const renamed: Record<string, string> = {};
  /** Every incoming id → the id it ends up as (refs of later chips are rewritten through it). */
  const ids: Record<string, string> = {};
  const earlier = (c: ChipDoc) => Object.keys(ws.chips).find((k) => k.startsWith(`${c.id}_`) && /^\d+$/.test(k.slice(c.id.length + 1))
    && same(ws.chips[k], { ...c, id: k, name: ws.chips[k].name }));
  const names = new Set(Object.values(ws.chips).map((c) => c.name));
  for (const c0 of incoming) {
    const c = renameRefs(c0, ids);
    const have = ws.chips[c.id];
    const prev = have && !same(have, c) ? earlier(c) : undefined;
    if (have && (prev || same(have, c))) {
      const id = prev ?? c.id;
      if (prev) ids[c.id] = prev;
      skipped.push(id);
      order.push(id);
      continue;
    }
    let id = c.id;
    if (have) {
      id = uniqueName(c.id, taken);
      taken.add(id);
      renamed[c.id] = ids[c.id] = id;
    }
    let name = c.name;
    if (have && names.has(name)) for (let i = 2; names.has(name); i++) name = `${c.name} ${i}`;
    names.add(name);
    all[id] = id === c.id ? c : { ...c, id, name };
    added.push(id);
    order.push(id);
  }
  return { ws: added.length ? { ...ws, chips: all } : ws, added, renamed, skipped, order };
}

export function importJson(text: string, ws: Workspace): Imported | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: 'not a JSON file' };
  }
  if (!isObj(raw) || raw.format !== FORMAT) return { error: 'not a sandbox export' };
  if (!int(raw.schema, 1)) return { error: 'missing schema version' };
  if (raw.schema > SCHEMA) return { error: `exported by a newer version of the site (schema ${raw.schema})` };
  if (!Array.isArray(raw.chips)) return { error: 'the file holds no chips' };
  const chips = raw.chips.map(sanitizeChip).filter((c): c is ChipDoc => !!c);
  if (!chips.length) return { error: 'the file holds no readable chips' };
  return importChips(chips, ws);
}
