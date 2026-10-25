// Persistence of the sandbox workspace: browser storage, JSON files, and the sanitizer that
// every way in (storage, file, share link) goes through. Nothing here touches the DOM; storage
// is injected (a Map-backed KV in the tests, localStorage in the browser).
//
// Loading never throws and never loses data silently: anything it cannot read (corrupt JSON, a
// newer schema) is copied to BACKUP_KEY before the empty workspace replaces it.

import { sanitizeIsa } from '../isa/table';
import { sanitizeRows } from '../riscv/custom';
import { sanitizeCpu } from './cpu';
import { mergeFolders, sanitizeFolders } from './folders';
import { same } from './history';
import { MAX_KEY_LENGTH } from './parts';
import { sanitizeIoRef } from './ioparts';
import { sanitizeReaderRef } from './cardparts';
import { FACE_MAX, isEmptyFace, SCALE_MAX, SCALE_MIN, SIDES } from './face';
import { PUZZLE_MAX_WIDTH } from './puzzleparts';
import {
  type FsmDoc, type TableDoc, SCHEMA, chipDeps, emptyWorkspace, isIdent, isPinValue, pinValue, uniqueName,
  type ChipDoc, type CommentDoc, type FaceDisplayDoc, type FaceDoc, type FacePinDoc, type FaceSide, type DisplayKind, type EndRef, type ExitDir, type FolderDoc, type LabelDoc, type NetHue, type PartDoc, type PartRef,
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
const DISPLAYS: DisplayKind[] = ['led', 'seg7', 'hex', 'value', 'halt', 'buzzer'];

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
  if (str(r.key)) return r.key.length >= 1 && r.key.length <= MAX_KEY_LENGTH ? { key: r.key } : null;
  if ('keyboard' in r) return r.keyboard === true ? { keyboard: true } : null;
  if ('console' in r || 'switches' in r || 'screen' in r) return sanitizeIoRef(r);
  if ('reader' in r) { const rd = sanitizeReaderRef(r.reader); return rd && { reader: rd }; }
  if ('puzzle' in r) return (r.puzzle === 'in' || r.puzzle === 'out') && int(r.width, 1) && r.width <= PUZZLE_MAX_WIDTH ? { puzzle: r.puzzle, width: r.width } : null;
  if (isObj(r.rom)) {
    const { k, w, addr, lang, src } = r.rom;
    if (!int(k) || (w !== 8 && w !== 16 && w !== 32) || (addr !== 'word' && addr !== 'rv32') || (lang !== 'asm' && lang !== 'hex' && lang !== 'rv16' && lang !== 'cpu4' && lang !== 'isa' && lang !== '6502') || !str(src)) return null;
    if (lang === 'isa') {
      const isa = sanitizeIsa(r.rom.isa);
      return isa ? { rom: { k, w, addr, lang, src, isa } } : null;
    }
    const custom = lang === 'asm' ? sanitizeRows(r.rom.custom) : [];
    return { rom: { k, w, addr, lang, src, ...(custom.length ? { custom } : {}) } };
  }
  if (isObj(r.core)) {
    const custom = sanitizeRows(r.core.custom);
    return custom.length ? { core: { custom } } : { lib: 'rv32i_core' };
  }
  if (isObj(r.ram)) {
    const { k, w, init, ports } = r.ram;
    if (!int(k) || !int(w, 1)) return null;
    const words = Array.isArray(init) && init.length <= 1 << 16 && init.every((x) => int(x)) ? (init as number[]).slice() : undefined;
    const p = int(ports, 2) && (ports as number) <= 8 /* PORT_MAX_N (lib/portmem.ts, not imported: it pulls in the warp cores) */ ? { ports: ports as number } : {};
    return { ram: words?.some((x) => x) ? { k, w, init: words, ...p } : { k, w, ...p } };
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

const GATES = ['nand', 'std', 'aoi'] as const;
/** At most 1 MB of Verilog per chip group (a whole RV32I core is ~60 kB). */
const MAX_HDL = 1 << 20;
function sanitizeHdl(x: unknown): ChipDoc['hdl'] {
  if (!isObj(x) || !str(x.module) || !x.module) return undefined;
  const s = x.src;
  const src = isObj(s) && str(s.file) && str(s.text) && s.text.length <= MAX_HDL
    ? compact({ file: s.file || 'top.v', text: s.text, top: str(s.top) && s.top ? s.top : undefined, gates: GATES.find((g) => g === s.gates) ?? 'std' })
    : undefined;
  const of = str(x.of) && isIdent(x.of) ? x.of : undefined;
  if (!src && !of) return undefined;
  return compact({ module: x.module, src, of: src ? undefined : of, stale: x.stale === true ? true as const : undefined });
}

/** A truth-table chip's table (ttable.ts): 1–8 inputs and outputs, distinct pin names, a row string per output. */
function sanitizeTable(x: unknown): ChipDoc['table'] {
  if (!isObj(x) || !Array.isArray(x.ins) || !Array.isArray(x.outs) || !Array.isArray(x.rows)) return undefined;
  const names = [...x.ins, ...x.outs];
  if (!names.every((n) => str(n) && isIdent(n) && !n.includes('.')) || new Set(names).size !== names.length) return undefined;
  const ins = x.ins as string[], outs = x.outs as string[];
  if (ins.length < 1 || ins.length > 8 || outs.length < 1 || outs.length > 16 || x.rows.length !== outs.length) return undefined;
  if (!x.rows.every((r) => str(r) && r.length === 1 << ins.length && !/[^01-]/.test(r))) return undefined;
  return compact({ ins: [...ins], outs: [...outs], rows: [...(x.rows as string[])], form: (x.form === 'andor' || x.form === 'pla' || x.form === 'rom' ? x.form : 'nand') as TableDoc['form'], of: str(x.of) && isIdent(x.of) ? x.of : undefined });
}

/** A chip's test tables (testtable.ts): a name and the source text each, at most MAX_TESTS of MAX_TEST_SRC characters. */
const MAX_TESTS = 64, MAX_TEST_SRC = 1 << 18;
function sanitizeTests(x: unknown): ChipDoc['tests'] {
  if (!Array.isArray(x)) return undefined;
  const t = x.filter((d): d is { name: string; src: string } => isObj(d) && str(d.name) && str(d.src) && d.src.length <= MAX_TEST_SRC)
    .slice(0, MAX_TESTS).map((d) => ({ name: d.name.trim() || 'test', src: d.src }));
  return t.length ? t : undefined;
}

/** A state-machine chip's machine (fsmchip.ts): names as pins, states with positions, arcs between them. */
function sanitizeFsm(x: unknown): ChipDoc['fsm'] {
  if (!isObj(x) || !Array.isArray(x.ins) || !Array.isArray(x.outs) || !Array.isArray(x.states) || !Array.isArray(x.arcs)) return undefined;
  const ins = x.ins.filter((n): n is string => str(n) && isIdent(n)), outs = x.outs.filter((n): n is string => str(n) && isIdent(n));
  if (ins.length !== x.ins.length || outs.length !== x.outs.length || ins.length > 6 || !outs.length || outs.length > 16) return undefined;
  const states: NonNullable<ChipDoc['fsm']>['states'] = [];
  for (const st of x.states) {
    if (!isObj(st) || !str(st.name) || !st.name || st.name.length > 24 || !Array.isArray(st.at) || !num(st.at[0]) || !num(st.at[1])) return undefined;
    const out = Array.isArray(st.out) ? st.out.filter((o): o is string => str(o) && outs.includes(o)) : [];
    const act = Array.isArray(st.act) ? st.act.filter((t): t is { reg: string; expr: string } => isObj(t) && str(t.reg) && isIdent(t.reg) && str(t.expr) && t.expr.length <= 60).map((t) => ({ reg: t.reg, expr: t.expr })) : [];
    states.push(compact({ name: st.name, at: [st.at[0], st.at[1]] as [number, number], out: out.length ? out : undefined, act: act.length ? act : undefined }));
  }
  if (!states.length || states.length > 16) return undefined;
  const arcs: NonNullable<ChipDoc['fsm']>['arcs'] = [];
  for (const a of x.arcs) {
    if (!isObj(a) || !int(a.from, 0) || !int(a.to, 0) || a.from >= states.length || a.to >= states.length || !isObj(a.when)) return undefined;
    const when: Record<string, 0 | 1> = {};
    for (const [k, v] of Object.entries(a.when)) if (ins.includes(k) && (v === 0 || v === 1)) when[k] = v;
    const out = Array.isArray(a.out) ? a.out.filter((o): o is string => str(o) && outs.includes(o)) : [];
    const fin = (v: unknown, lim: number) => (num(v) && Math.abs(v) <= lim ? Math.round(v) : undefined);
    const test = Array.isArray(a.test) ? a.test.filter((t): t is { expr: string; is: 0 | 1 } => isObj(t) && str(t.expr) && t.expr.length <= 60 && (t.is === 0 || t.is === 1)).map((t) => ({ expr: t.expr, is: t.is })) : [];
    arcs.push(compact({ from: a.from, to: a.to, when, out: out.length ? out : undefined, test: test.length ? test : undefined, bend: fin(a.bend, 400), loop: fin(a.loop, 360), dx: fin(a.dx, 400), dy: fin(a.dy, 400) }));
  }
  const reset = int(x.reset, 0) && x.reset < states.length ? x.reset : 0;
  const encoding: FsmDoc['encoding'] = x.encoding === 'gray' || x.encoding === 'onehot' ? x.encoding : 'binary';
  return compact({ ins, outs, states, arcs, reset, encoding, form: (x.form === 'andor' || x.form === 'pla' || x.form === 'rom' ? x.form : 'nand') as TableDoc['form'], safe: x.safe === true ? true as const : undefined,
    data: sanitizeData(x.data), of: str(x.of) && isIdent(x.of) ? x.of : undefined });
}

/** A state machine's datapath: names as pins, one width (fsmd.ts checks the rest when it builds). */
function sanitizeData(x: unknown): NonNullable<ChipDoc['fsm']>['data'] {
  if (!isObj(x) || !int(x.width, 1) || x.width > 32 || !Array.isArray(x.ins) || !Array.isArray(x.regs) || !Array.isArray(x.outs)) return undefined;
  const names = (xs: unknown[]) => xs.filter((n): n is string => str(n) && isIdent(n)).slice(0, 6);
  const outs = x.outs.filter((o): o is { name: string; src: string } => isObj(o) && str(o.name) && isIdent(o.name) && str(o.src) && isIdent(o.src)).slice(0, 6).map((o) => ({ name: o.name, src: o.src }));
  return { width: x.width, ins: names(x.ins), regs: names(x.regs), outs };
}

function sanitizePart(p: unknown): PartDoc | null {
  if (!isObj(p) || !str(p.id) || !isIdent(p.id)) return null;
  const ref = sanitizeRef(p.ref);
  const at = vec(p.at);
  if (!ref || !at) return null;
  const rot = p.rot === 1 || p.rot === 2 || p.rot === 3 ? (p.rot as 1 | 2 | 3) : undefined;
  return compact({ id: p.id, ref, at, flip: p.flip === true ? true : undefined, rot, label: str(p.label) ? p.label : undefined });
}

/** A net colour: a whole hue in [0, 360) or 'auto'. */
const netHue = (x: unknown): NetHue | undefined => (x === 'auto' ? 'auto' : num(x) ? ((Math.round(x) % 360) + 360) % 360 : undefined);

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
    straight: w.straight === true ? true : undefined,
    hue: netHue(w.hue),
  });
}

function sanitizeLabel(l: unknown): LabelDoc | null {
  const at = isObj(l) ? vec(l.at) : null;
  if (!isObj(l) || !str(l.id) || !str(l.name) || !l.name.trim() || !at) return null;
  return compact({ id: l.id, name: l.name, at, face: face(l.face), hue: netHue(l.hue) });
}

/** Comments longer than this are cut (a pasted essay would make a huge box). */
const MAX_COMMENT = 2000;

function sanitizeComment(c: unknown): CommentDoc | null {
  const at = isObj(c) ? vec(c.at) : null;
  if (!isObj(c) || !str(c.id) || !str(c.text) || !c.text.trim() || !at) return null;
  return { id: c.id, at, text: c.text.slice(0, MAX_COMMENT) };
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

/** A chip's face: sizes and offsets whole numbers in range, known sides, pins the chip has, displays by part path. */
function sanitizeFace(x: unknown, pinIds: Set<string>): FaceDoc | undefined {
  if (!isObj(x)) return undefined;
  const size = (v: unknown) => (int(v, 2) && v <= FACE_MAX ? v : undefined);
  const pins: Record<string, FacePinDoc> = {};
  if (isObj(x.pins)) {
    for (const [id, p] of Object.entries(x.pins)) {
      if (pinIds.has(id) && isObj(p) && SIDES.includes(p.side as FaceSide) && int(p.at, 1) && p.at < FACE_MAX) pins[id] = { side: p.side as FaceSide, at: p.at };
    }
  }
  const displays: FaceDisplayDoc[] = [];
  for (const d of Array.isArray(x.displays) ? x.displays : []) {
    const at = isObj(d) ? vec(d.at) : null;
    if (!isObj(d) || !at || !Array.isArray(d.path) || !d.path.length || !d.path.every((q) => str(q) && isIdent(q))) continue;
    const scale = num(d.scale) && d.scale >= SCALE_MIN && d.scale <= SCALE_MAX ? d.scale : undefined;
    displays.push(compact<FaceDisplayDoc>({ path: (d.path as string[]).slice(), at: [Math.max(0, Math.min(FACE_MAX, at[0])), Math.max(0, Math.min(FACE_MAX, at[1]))], scale }));
  }
  const f = compact<FaceDoc>({
    w: size(x.w), h: size(x.h),
    pins: Object.keys(pins).length ? pins : undefined,
    displays: displays.length ? displays : undefined,
    noLabel: x.noLabel === true ? true : undefined,
  });
  return isEmptyFace(f) ? undefined : f;
}

/** A clean ChipDoc from untrusted JSON, or null if it lacks an id. */
export function sanitizeChip(c: unknown): ChipDoc | null {
  if (!isObj(c) || !str(c.id) || !isIdent(c.id)) return null;
  const pins = list(c.pins, sanitizePin);
  const parts = list(c.parts, sanitizePart);
  const labels = list(c.labels, sanitizeLabel);
  const comments = list(c.comments, sanitizeComment);
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
    face: sanitizeFace(c.face, new Set(uniquePins.map((p) => p.id))),
    ff: sanitizeFf(c.ff),
    cpu: sanitizeCpu(c.cpu),
    hz: num(c.hz) && c.hz > 0 ? c.hz : undefined,
    hdl: sanitizeHdl(c.hdl),
    table: sanitizeTable(c.table),
    fsm: sanitizeFsm(c.fsm),
    tests: sanitizeTests(c.tests),
    pins: uniquePins, parts, wires, labels,
    comments: comments.length ? comments : undefined,
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
  const favs = Array.isArray(raw.favorites) ? [...new Set(raw.favorites.filter((f): f is string => str(f) && f.length <= 200 && f.includes('/')))] : [];
  if (favs.length) ws.favorites = favs.slice(0, MAX_FAVORITES);
  if (isObj(raw.isas)) {
    const isas = Object.fromEntries(Object.values(raw.isas).flatMap((x) => { const d = sanitizeIsa(x); return d ? [[d.id, d]] : []; }));
    if (Object.keys(isas).length) ws.isas = isas;
  }
  const folders = sanitizeFolders(raw.folders, chips);
  if (folders.length) ws.folders = folders;
  return ws;
}

/** Palette favorites kept at most (number keys reach the first nine). */
export const MAX_FAVORITES = 40;

// ---------------------------------------------------------------------------------------------
// Browser storage

/** A workspace from storage: `key` is a project's (projects.ts); KEY, the default, the first project's (the campaign keeps its levels there). */
export function loadWorkspace(kv: KV | null = defaultKV(), key = KEY): Workspace {
  if (!kv) return emptyWorkspace();
  let text: string | null = null;
  try {
    text = kv.getItem(key);
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

export function saveWorkspace(ws: Workspace, kv: KV | null = defaultKV(), key = KEY): { ok: true } | { ok: false; reason: string } {
  if (!kv) return { ok: false, reason: 'browser storage is not available' };
  try {
    kv.setItem(key, JSON.stringify(ws));
    return { ok: true };
  } catch (e) {
    const quota = e instanceof Error && /quota/i.test(`${e.name} ${e.message}`);
    return { ok: false, reason: quota ? 'browser storage is full: export your chips to a file' : `could not save: ${e instanceof Error ? e.message : String(e)}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Local data: what the site keeps in this browser, and deleting it

/** Every key the site stores starts with this (settings, campaign, sandbox). */
export const SITE_PREFIX = 'mosfet2riscv:';
/** The sandbox's own keys: the workspace, its unreadable backup, the I/O bar preference. */
export const SANDBOX_PREFIX = `${SITE_PREFIX}sandbox`;

/** A KV that can list its keys (localStorage; a Map-backed fake in the tests). */
export interface ListKV extends KV {
  readonly length: number;
  key(i: number): string | null;
}

export type DataScope = 'sandbox' | 'all';

function listKV(): ListKV | null {
  try {
    return (globalThis as { localStorage?: ListKV }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** The keys a scope covers, with their size in bytes (UTF-16, as browsers count the quota). */
export function localData(scope: DataScope, kv: ListKV | null = listKV()): { key: string; bytes: number }[] {
  if (!kv) return [];
  const prefix = scope === 'all' ? SITE_PREFIX : SANDBOX_PREFIX;
  const out: { key: string; bytes: number }[] = [];
  try {
    for (let i = 0; i < kv.length; i++) {
      const k = kv.key(i);
      if (k?.startsWith(prefix)) out.push({ key: k, bytes: 2 * (k.length + (kv.getItem(k)?.length ?? 0)) });
    }
  } catch {
    // unreadable storage: report what was listed
  }
  return out;
}

/** Remove every key of a scope; returns how many went. Keys of other sites on the origin stay. */
export function deleteLocalData(scope: DataScope, kv: ListKV | null = listKV()): number {
  const keys = localData(scope, kv).map((d) => d.key);
  for (const k of keys) {
    try { kv!.removeItem(k); } catch { /* best effort */ }
  }
  return keys.length;
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

/**
 * The chips and their dependencies as a file, with the folders they are filed in. `project` (a
 * whole project: every chip) adds its name, empty folders, palette favorites and instruction sets,
 * so "Import as a new project" gives the same project back.
 */
export function exportJson(ws: Workspace, ids: string[], project?: string): string {
  const chips = closure(ws, ids);
  const inFile = new Set(chips.map((c) => c.id));
  const folders = (ws.folders ?? []).map((f) => ({ name: f.name, chips: f.chips.filter((c) => inFile.has(c)) })).filter((f) => project !== undefined || f.chips.length);
  return JSON.stringify(compact({
    format: FORMAT, schema: SCHEMA, project, chips,
    folders: folders.length ? folders : undefined,
    favorites: project !== undefined && ws.favorites?.length ? ws.favorites : undefined,
    isas: project !== undefined && ws.isas && Object.keys(ws.isas).length ? ws.isas : undefined,
  }), null, 2);
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

/** An export file read and sanitized: its chips, folders, and what a whole project's file adds. */
export interface ExportFile {
  chips: ChipDoc[];
  folders: FolderDoc[];
  project?: string;
  favorites?: string[];
  isas?: Workspace['isas'];
}

export function readExport(text: string): ExportFile | { error: string } {
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
  // Whatever else it holds goes through the workspace sanitizer, as if it were saved.
  const ws = migrate({ schema: SCHEMA, chips: Object.fromEntries(chips.map((c) => [c.id, c])), folders: raw.folders, favorites: raw.favorites, isas: raw.isas });
  const w = 'error' in ws ? undefined : ws;
  return compact<ExportFile>({
    chips, folders: w?.folders ?? [],
    project: str(raw.project) && raw.project.trim() ? raw.project.trim().slice(0, MAX_PROJECT_NAME) : undefined,
    favorites: w?.favorites, isas: w?.isas,
  });
}

export function importJson(text: string, ws: Workspace): Imported | { error: string } {
  const f = readExport(text);
  if ('error' in f) return f;
  const r = importChips(f.chips, ws);
  return f.folders.length ? { ...r, ws: mergeFolders(r.ws, f.folders, (id) => r.renamed[id] ?? id, r.added) } : r;
}

/** A whole workspace from an export file ("Import as a new project"): its chips, folders, favorites and instruction sets. */
export function workspaceFromExport(f: ExportFile): Workspace {
  const r = importChips(f.chips, { schema: SCHEMA, chips: {}, open: [] });
  const top = r.order[r.order.length - 1];
  let ws: Workspace = { ...r.ws, open: top ? [top] : [] };
  if (f.folders.length) ws = mergeFolders(ws, f.folders, (id) => id, r.added);
  if (f.favorites?.length) ws.favorites = f.favorites;
  if (f.isas) ws.isas = f.isas;
  return ws;
}

/** Project names are cut to this length. */
export const MAX_PROJECT_NAME = 60;
