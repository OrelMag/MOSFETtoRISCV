// Editing operations on a chip document. Every operation is a pure function: it returns a new
// document that shares every object it did not change (so History can keep hundreds of steps
// cheaply and the view can skip unchanged objects by identity), and returns its input itself
// when nothing changes. Refusals come back as a `reason` with the document unchanged.
//
// Wires store only their interior corners, so anything that moves an endpoint (a move, a flip,
// a new ref) refits the attached wires: corners slide so every segment stays horizontal or
// vertical, and branch points ride along on the wire they sit on.

import { symbolGeom } from '../sim/geometry';
import {
  chipDeps, endGeom, endKey, isIdent, nextId, onPolyline, orthogonal, polyline, uniqueName,
  type ChipDoc, type DefOf, type EndRef, type ExitDir, type LabelDoc, type PartDoc, type PartRef,
  type PinDoc, type Vec, type WireDoc, type Workspace,
} from './model';

export type Sel = { parts?: string[]; pins?: string[]; wires?: string[]; labels?: string[] };

/** What copySel puts on the clipboard: plain objects, ids still those of the source chip. */
export interface Clip {
  parts: PartDoc[];
  pins: PinDoc[];
  labels: LabelDoc[];
  wires: WireDoc[];
}

export type Added = { doc: ChipDoc; id: string; reason?: undefined } | { doc: ChipDoc; id?: undefined; reason: string };
export type Edited = { doc: ChipDoc; reason?: string };

const noDefs: DefOf = () => undefined;
const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1]];
const eqv = (a: Vec, b: Vec) => a[0] === b[0] && a[1] === b[1];
const ZERO: Vec = [0, 0];
const eqPts = (a: Vec[], b: Vec[]) => a.length === b.length && a.every((p, i) => eqv(p, b[i]));

/** Instance-name prefix per kind of part: g1 (library), u1 (user chip), s1/m1, k1, d1, rom1, ram1. */
export function idPrefix(ref: PartRef): string {
  if ('lib' in ref) return 'g';
  if ('chip' in ref) return 'u';
  if ('split' in ref) return 's';
  if ('merge' in ref) return 'm';
  if ('const' in ref) return 'k';
  if ('display' in ref) return 'd';
  return 'rom' in ref ? 'rom' : 'ram';
}

/** True if placing `chip` inside `host` would make a chip contain itself (directly or not). */
export function wouldCycle(ws: Workspace, host: string, chip: string): boolean {
  const seen = new Set<string>();
  const stack = [chip];
  while (stack.length) {
    const c = stack.pop()!;
    if (c === host) return true;
    if (seen.has(c)) continue;
    seen.add(c);
    const d = ws.chips[c];
    if (d) stack.push(...chipDeps(d));
  }
  return false;
}

// Part ids and pin names share the chip's scope in generated Verilog, so new ones avoid both.
const partNames = (doc: ChipDoc) => [...doc.parts.map((p) => p.id), ...doc.pins.map((p) => p.name)];

function exists(doc: ChipDoc, e: EndRef): boolean {
  if ('part' in e) return doc.parts.some((p) => p.id === e.part);
  if ('pin' in e) return doc.pins.some((p) => p.id === e.pin);
  if ('label' in e) return doc.labels.some((l) => l.id === e.label);
  return doc.wires.some((w) => w.id === e.wire);
}

const posOf = (doc: ChipDoc, e: EndRef, defOf: DefOf): Vec | null => endGeom(doc, e, defOf)?.pos ?? null;

/** Corners between two (possibly unknown) end positions, normalized; null if the wire has no length. */
function fit(pa: Vec | null, pts: Vec[], pb: Vec | null): Vec[] | null {
  const full = orthogonal([...(pa ? [pa] : []), ...pts, ...(pb ? [pb] : [])]);
  if (pa && pb && full.length < 2) return null;
  return full.slice(pa ? 1 : 0, pb ? full.length - 1 : full.length);
}

/** Copies `patch` onto `o`; a key set to undefined in the patch is removed. */
function patched<T extends object>(o: T, patch: Partial<NoInfer<T>>): T {
  const r = { ...o, ...patch } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete r[k];
  return r as T;
}

// ---------------------------------------------------------------------------------------------
// Adding

export function addPart(doc: ChipDoc, ref: PartRef, at: Vec, id?: string): Added {
  if ('chip' in ref && ref.chip === doc.id) return { doc, reason: 'a chip cannot contain itself' };
  const taken = partNames(doc);
  if (id !== undefined && !isIdent(id)) return { doc, reason: `'${id}' is not a valid name` };
  if (id !== undefined && taken.includes(id)) return { doc, reason: `'${id}' is already used` };
  const pid = id ?? nextId(idPrefix(ref), taken);
  return { doc: { ...doc, parts: [...doc.parts, { id: pid, ref, at: [at[0], at[1]] }] }, id: pid };
}

export function addPin(doc: ChipDoc, dir: PinDoc['dir'], width: number, at: Vec, name?: string): Added {
  if (!Number.isInteger(width) || width < 1) return { doc, reason: 'width must be a positive integer' };
  const names = doc.pins.map((p) => p.name);
  if (name !== undefined && !isIdent(name)) return { doc, reason: `'${name}' is not a valid pin name` };
  if (name !== undefined && names.includes(name)) return { doc, reason: `a pin is already called '${name}'` };
  const id = nextId('pin', doc.pins.map((p) => p.id));
  const pin: PinDoc = { id, name: name ?? nextId(dir === 'inout' ? 'io' : dir, [...names, ...doc.parts.map((p) => p.id)]), dir, width, at: [at[0], at[1]] };
  return { doc: { ...doc, pins: [...doc.pins, pin] }, id };
}

export function addLabel(doc: ChipDoc, name: string, at: Vec, face?: ExitDir): Added {
  if (!name.trim()) return { doc, reason: 'a pointer needs a name' };
  const id = nextId('l', doc.labels.map((l) => l.id));
  const l: LabelDoc = { id, name: name.trim(), at: [at[0], at[1]], ...(face ? { face } : {}) };
  return { doc: { ...doc, labels: [...doc.labels, l] }, id };
}

/** Why a wire between a and b cannot exist, or null. defOf (optional) also checks ports and branch points. */
function wireProblem(doc: ChipDoc, a: EndRef, b: EndRef, defOf: DefOf | undefined, self?: string): string | null {
  if (endKey(a) === endKey(b)) return 'both ends are the same point';
  for (const e of [a, b]) {
    if ('wire' in e && e.wire === self) return 'a wire cannot branch from itself';
    if (!exists(doc, e)) return `${endKey(e)} does not exist`;
    if (!defOf) continue;
    if ('part' in e && !endGeom(doc, e, defOf)) return `${e.part} has no port '${e.port}'`;
    if ('wire' in e) {
      const host = doc.wires.find((w) => w.id === e.wire)!;
      const poly = polyline(doc, host, defOf);
      if (poly && !onPolyline(poly, e.at)) return `(${e.at}) is not on wire ${e.wire}`;
    }
  }
  return null;
}

/**
 * A new wire from a to b through corners `pts`. Corners are normalized (diagonal steps get an L,
 * duplicates and collinear corners go); with defOf, against the ends' actual positions.
 */
export function addWire(doc: ChipDoc, a: EndRef, b: EndRef, pts: Vec[], defOf?: DefOf): Added {
  const why = wireProblem(doc, a, b, defOf);
  if (why) return { doc, reason: why };
  const d = defOf ?? noDefs;
  const corners = fit(posOf(doc, a, d), pts, posOf(doc, b, d));
  if (!corners) return { doc, reason: 'the wire has no length' };
  const id = nextId('w', doc.wires.map((w) => w.id));
  return { doc: { ...doc, wires: [...doc.wires, { id, a, b, pts: corners }] }, id };
}

// ---------------------------------------------------------------------------------------------
// Refitting wires after their ends moved

type Orient = 'h' | 'v' | null;
const orient = (a: Vec, b: Vec): Orient => (a[1] === b[1] && a[0] !== b[0] ? 'h' : a[0] === b[0] && a[1] !== b[1] ? 'v' : null);

/** Orientation of the segment end → c; when it has no length, perpendicular to c → next. */
function segOrient(e: Vec, c: Vec, next: Vec | null | undefined): Orient {
  const o = orient(e, c);
  if (o || !eqv(e, c) || !next) return o;
  const q = orient(c, next);
  return q === 'h' ? 'v' : q === 'v' ? 'h' : null;
}

/**
 * Slides the corner next to each moved end so its segment keeps its orientation (a horizontal
 * first segment follows the end up or down). A straight wire whose ends no longer line up gets
 * a Z, bending halfway. `oa`/`ob` are the old end positions already shifted by the corners'
 * translation; anything still diagonal is left to orthogonal()'s L repair.
 */
function fixEnds(pts: Vec[], oa: Vec | null, na: Vec | null, ob: Vec | null, nb: Vec | null, fa: boolean, fb: boolean): Vec[] {
  const p = pts.map((q): Vec => [q[0], q[1]]);
  if (!p.length) {
    if (oa && ob && na && nb && (fa || fb) && na[0] !== nb[0] && na[1] !== nb[1]) {
      const o = orient(oa, ob);
      if (o === 'h') { const mx = Math.round((na[0] + nb[0]) / 2); return [[mx, na[1]], [mx, nb[1]]]; }
      if (o === 'v') { const my = Math.round((na[1] + nb[1]) / 2); return [[na[0], my], [nb[0], my]]; }
    }
    return p;
  }
  const n = p.length;
  // Both orientations are read before either end touches a corner they may share.
  const of = fa && oa && na ? segOrient(oa, p[0], n > 1 ? p[1] : ob) : null;
  const ol = fb && ob && nb ? segOrient(ob, p[n - 1], n > 1 ? p[n - 2] : oa) : null;
  if (of === 'h') p[0][1] = na![1];
  else if (of === 'v') p[0][0] = na![0];
  if (ol === 'h') p[n - 1][1] = nb![1];
  else if (ol === 'v') p[n - 1][0] = nb![0];
  return p;
}

/** Nearest point of an orthogonal polyline to p. */
export function nearestOn(poly: Vec[], p: Vec): Vec {
  if (poly.length === 1) return [poly[0][0], poly[0][1]];
  let best: Vec = [poly[0][0], poly[0][1]];
  let bd = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const [a, b] = [poly[i - 1], poly[i]];
    const q: Vec = [clamp(p[0], a[0], b[0]), clamp(p[1], a[1], b[1])];
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bd) [bd, best] = [d, q];
  }
  return best;
}

const clamp = (v: number, a: number, b: number) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));

/**
 * Where a branch point goes when its host wire changes shape: it stays on the same segment
 * (moving with it, and along it if both of its ends moved alike) when the segments still
 * correspond, and otherwise drops to the nearest point of the new polyline.
 */
function mapBranch(at: Vec, op: Vec[] | null, np: Vec[] | null): Vec {
  if (!op || !np || eqPts(op, np)) return at;
  if (op.length === np.length) {
    for (let i = 1; i < op.length; i++) {
      const [p, q, p2, q2] = [op[i - 1], op[i], np[i - 1], np[i]];
      if (!onPolyline([p, q], at)) continue;
      const o = orient(p, q);
      if (o !== orient(p2, q2) || !o) break;
      const k = o === 'h' ? 0 : 1;
      const dk = p2[k] - p[k] === q2[k] - q[k] ? p2[k] - p[k] : 0;
      const r: Vec = [0, 0];
      r[k] = clamp(at[k] + dk, p2[k], q2[k]);
      r[1 - k] = p2[1 - k];
      return r;
    }
  }
  return nearestOn(np, at);
}

/**
 * Recomputes the wires of `next` (parts / pins / labels / some wires changed from `old`).
 * `rigid` wires translate all their corners by the given vector (a selected wire being dragged);
 * a wire whose two ends moved alike translates too. Hosts are refit before their branches.
 */
function refit(old: ChipDoc, next: ChipDoc, defOf: DefOf, rigid: Map<string, Vec> = new Map()): ChipDoc {
  const oldW = new Map(old.wires.map((w) => [w.id, w]));
  const cur = new Map(next.wires.map((w) => [w.id, w]));
  const out = new Map<string, WireDoc>();
  const busy = new Set<string>();
  const oldPolys = new Map<string, Vec[] | null>();
  const newPolys = new Map<string, Vec[] | null>();

  const oldPoly = (id: string) => {
    if (!oldPolys.has(id)) { const w = oldW.get(id); oldPolys.set(id, w ? polyline(old, w, defOf) : null); }
    return oldPolys.get(id)!;
  };
  const newPoly = (id: string) => {
    if (!newPolys.has(id)) {
      const w = visit(id);
      if (busy.has(id)) return w ? polyline(next, w, defOf) : null; // a branch cycle: no memo yet
      newPolys.set(id, w ? polyline(next, w, defOf) : null);
    }
    return newPolys.get(id)!;
  };
  const moveEnd = (e: EndRef): EndRef => {
    if (!('wire' in e)) return e;
    const at = mapBranch(e.at, oldPoly(e.wire), newPoly(e.wire));
    return eqv(at, e.at) ? e : { wire: e.wire, at };
  };

  // A wire whose ends all sit on objects that did not change (and branch off wires that did not
  // move) keeps its shape: no geometry to recompute. Most wires of a big chip, during a drag.
  const objs = (d: ChipDoc) => new Map<string, object>([
    ...d.parts.map((p) => [`p:${p.id}`, p] as const), ...d.pins.map((p) => [`pin:${p.id}`, p] as const), ...d.labels.map((l) => [`l:${l.id}`, l] as const),
  ]);
  const [oldObj, newObj] = [objs(old), objs(next)];
  const stableMemo = new Map<string, boolean>();
  const stableEnd = (e: EndRef): boolean => {
    if ('wire' in e) return stableWire(e.wire);
    const k = 'part' in e ? `p:${e.part}` : 'pin' in e ? `pin:${e.pin}` : `l:${e.label}`;
    return oldObj.get(k) === newObj.get(k);
  };
  function stableWire(id: string): boolean {
    const m = stableMemo.get(id);
    if (m !== undefined) return m;
    stableMemo.set(id, false); // a branch cycle is not stable
    const w = cur.get(id);
    const r = !!w && w === oldW.get(id) && !rigid.has(id) && stableEnd(w.a) && stableEnd(w.b);
    stableMemo.set(id, r);
    return r;
  }

  function refitWire(w: WireDoc): WireDoc {
    if (stableWire(w.id)) return w;
    const o = oldW.get(w.id) ?? w;
    const a = moveEnd(w.a);
    const b = moveEnd(w.b);
    const [oa, ob] = [posOf(old, o.a, defOf), posOf(old, o.b, defOf)];
    const [na, nb] = [posOf(next, a, defOf), posOf(next, b, defOf)];
    const da = oa && na ? sub(na, oa) : ZERO;
    const db = ob && nb ? sub(nb, ob) : ZERO;
    const t = rigid.get(w.id) ?? (eqv(da, db) ? da : ZERO);
    if (w === o && a === w.a && b === w.b && eqv(da, ZERO) && eqv(db, ZERO) && eqv(t, ZERO)) return w;
    const shifted = w.pts.map((p) => add(p, t));
    const fixed = fixEnds(shifted, oa && add(oa, t), na, ob && add(ob, t), nb, !eqv(da, t), !eqv(db, t));
    const pts = fit(na, fixed, nb) ?? [];
    if (a === w.a && b === w.b && eqPts(pts, w.pts)) return w;
    return { ...w, a, b, pts };
  }

  function visit(id: string): WireDoc | undefined {
    const done = out.get(id);
    if (done) return done;
    const w = cur.get(id);
    if (!w || busy.has(id)) return w;
    busy.add(id);
    const r = refitWire(w);
    busy.delete(id);
    out.set(id, r);
    return r;
  }

  const wires = next.wires.map((w) => visit(w.id)!);
  return wires.every((w, i) => w === next.wires[i]) ? next : { ...next, wires };
}

// ---------------------------------------------------------------------------------------------
// Moving, deleting, editing

function moveAll<T extends { id: string; at: Vec }>(xs: T[], ids: string[] | undefined, d: Vec): T[] {
  if (!ids?.length) return xs;
  const s = new Set(ids);
  let any = false;
  const r = xs.map((x) => (s.has(x.id) ? ((any = true), { ...x, at: add(x.at, d) }) : x));
  return any ? r : xs;
}

/**
 * Moves the selected parts, pins and labels by d, and the selected wires' corners with them.
 * Attached wires stay orthogonal (see refit); branch points follow their wire.
 */
export function moveSel(doc: ChipDoc, sel: Sel, d: Vec, defOf: DefOf): ChipDoc {
  if (eqv(d, ZERO)) return doc;
  const parts = moveAll(doc.parts, sel.parts, d);
  const pins = moveAll(doc.pins, sel.pins, d);
  const labels = moveAll(doc.labels, sel.labels, d);
  const rigid = new Map((sel.wires ?? []).filter((id) => doc.wires.some((w) => w.id === id)).map((id): [string, Vec] => [id, d]));
  if (parts === doc.parts && pins === doc.pins && labels === doc.labels && !rigid.size) return doc;
  return refit(doc, { ...doc, parts, pins, labels }, defOf, rigid);
}

/** Wires ending on a deleted object go, and so do wires branched from deleted wires (transitively). */
export function deleteSel(doc: ChipDoc, sel: Sel): ChipDoc {
  const parts = new Set(sel.parts), pins = new Set(sel.pins), labels = new Set(sel.labels), wires = new Set(sel.wires);
  const dead = (e: EndRef) =>
    'part' in e ? parts.has(e.part) : 'pin' in e ? pins.has(e.pin) : 'label' in e ? labels.has(e.label) : wires.has(e.wire);
  for (let grew = true; grew;) {
    grew = false;
    for (const w of doc.wires) if (!wires.has(w.id) && (dead(w.a) || dead(w.b))) { wires.add(w.id); grew = true; }
  }
  const keep = <T extends { id: string }>(xs: T[], s: Set<string | undefined>) => (xs.some((x) => s.has(x.id)) ? xs.filter((x) => !s.has(x.id)) : xs);
  const r = { ...doc, parts: keep(doc.parts, parts), pins: keep(doc.pins, pins), labels: keep(doc.labels, labels), wires: keep(doc.wires, wires) };
  return r.parts === doc.parts && r.pins === doc.pins && r.labels === doc.labels && r.wires === doc.wires ? doc : r;
}

/** Mirrors parts left-right. With defOf, attached wires are refit to the mirrored ports. */
export function flipParts(doc: ChipDoc, ids: string[], defOf?: DefOf): ChipDoc {
  const s = new Set(ids);
  if (!doc.parts.some((p) => s.has(p.id))) return doc;
  const parts = doc.parts.map((p) => (s.has(p.id) ? patched(p, { flip: p.flip ? undefined : true }) : p));
  const next = { ...doc, parts };
  return defOf ? refit(doc, next, defOf) : next;
}

function rewriteEnds(doc: ChipDoc, f: (e: EndRef) => EndRef): WireDoc[] {
  let any = false;
  const wires = doc.wires.map((w) => {
    const [a, b] = [f(w.a), f(w.b)];
    if (a === w.a && b === w.b) return w;
    any = true;
    return { ...w, a, b };
  });
  return any ? wires : doc.wires;
}

/**
 * Edits a part. Renaming it (`id`) rewrites the wires that end on it. With defOf, wires follow a
 * change of position, flip or ref. Wires to ports the new ref lacks are kept (compile reports
 * them), so changing a parameter back restores the circuit.
 */
export function setPart(doc: ChipDoc, id: string, patch: Partial<PartDoc>, defOf?: DefOf): Edited {
  const i = doc.parts.findIndex((p) => p.id === id);
  if (i < 0) return { doc, reason: `no part '${id}'` };
  if (patch.ref && 'chip' in patch.ref && patch.ref.chip === doc.id) return { doc, reason: 'a chip cannot contain itself' };
  const nid = patch.id ?? id;
  if (nid !== id) {
    if (!isIdent(nid)) return { doc, reason: `'${nid}' is not a valid name` };
    if (partNames(doc).includes(nid)) return { doc, reason: `'${nid}' is already used` };
  }
  const parts = doc.parts.slice();
  parts[i] = patched(doc.parts[i], patch);
  let next: ChipDoc = { ...doc, parts };
  if (nid !== id) next = { ...next, wires: rewriteEnds(next, (e) => ('part' in e && e.part === id ? { part: nid, port: e.port } : e)) };
  if (!defOf) return { doc: next };
  // refit matches old and new parts by id, so it sees a renamed part under its old name
  const old = nid === id ? doc : { ...doc, parts: doc.parts.map((p) => (p.id === id ? { ...p, id: nid } : p)), wires: next.wires };
  return { doc: refit(old, next, defOf) };
}

export const setRef = (doc: ChipDoc, partId: string, ref: PartRef, defOf?: DefOf): Edited => setPart(doc, partId, { ref }, defOf);

export function setPin(doc: ChipDoc, id: string, patch: Partial<Omit<PinDoc, 'id'>>, defOf?: DefOf): Edited {
  const i = doc.pins.findIndex((p) => p.id === id);
  if (i < 0) return { doc, reason: `no pin '${id}'` };
  const { name, width } = patch;
  if (name !== undefined && name !== doc.pins[i].name) {
    if (!isIdent(name)) return { doc, reason: `'${name}' is not a valid pin name` };
    if (doc.pins.some((p) => p.name === name)) return { doc, reason: `a pin is already called '${name}'` };
  }
  if (width !== undefined && (!Number.isInteger(width) || width < 1)) return { doc, reason: 'width must be a positive integer' };
  const pins = doc.pins.slice();
  pins[i] = patched(doc.pins[i], patch);
  const next = { ...doc, pins };
  // The flip-flop marking names pins: it follows a rename.
  const old = doc.pins[i].name;
  if (doc.ff && name !== undefined && name !== old && Object.values(doc.ff).includes(old)) {
    next.ff = Object.fromEntries(Object.entries(doc.ff).map(([k, v]) => [k, v === old ? name : v])) as typeof doc.ff;
  }
  return { doc: refit(doc, next, defOf ?? noDefs) };
}

export function setLabel(doc: ChipDoc, id: string, patch: Partial<Omit<LabelDoc, 'id'>>, defOf?: DefOf): Edited {
  const i = doc.labels.findIndex((l) => l.id === id);
  if (i < 0) return { doc, reason: `no pointer '${id}'` };
  if (patch.name !== undefined && !patch.name.trim()) return { doc, reason: 'a pointer needs a name' };
  const labels = doc.labels.slice();
  labels[i] = patched(doc.labels[i], patch.name === undefined ? patch : { ...patch, name: patch.name.trim() });
  return { doc: refit(doc, { ...doc, labels }, defOf ?? noDefs) };
}

/** Edits a wire (ends, corners, name, cap, init). Branches on it follow a change of shape. */
export function setWire(doc: ChipDoc, id: string, patch: Partial<Omit<WireDoc, 'id'>>, defOf?: DefOf): Edited {
  const i = doc.wires.findIndex((w) => w.id === id);
  if (i < 0) return { doc, reason: `no wire '${id}'` };
  const w = patched(doc.wires[i], patch);
  if (patch.a || patch.b) {
    const why = wireProblem(doc, w.a, w.b, defOf, id);
    if (why) return { doc, reason: why };
  }
  const d = defOf ?? noDefs;
  const pts = fit(posOf(doc, w.a, d), w.pts, posOf(doc, w.b, d));
  if (!pts) return { doc, reason: 'the wire has no length' };
  const wires = doc.wires.slice();
  wires[i] = { ...w, pts };
  return { doc: refit(doc, { ...doc, wires }, d) };
}

// ---------------------------------------------------------------------------------------------
// Clipboard and selection

/** The selected parts / pins / labels and every wire with both ends among them (branch chains included). */
export function copySel(doc: ChipDoc, sel: Sel): Clip {
  const ps = new Set(sel.parts), pins = new Set(sel.pins), ls = new Set(sel.labels), ws = new Set<string>();
  const inside = (e: EndRef) =>
    'part' in e ? ps.has(e.part) : 'pin' in e ? pins.has(e.pin) : 'label' in e ? ls.has(e.label) : ws.has(e.wire);
  for (let grew = true; grew;) {
    grew = false;
    for (const w of doc.wires) if (!ws.has(w.id) && inside(w.a) && inside(w.b)) { ws.add(w.id); grew = true; }
  }
  return {
    parts: doc.parts.filter((p) => ps.has(p.id)),
    pins: doc.pins.filter((p) => pins.has(p.id)),
    labels: doc.labels.filter((l) => ls.has(l.id)),
    wires: doc.wires.filter((w) => ws.has(w.id)),
  };
}

/** g12 → the first free g<n>; a custom name gets a _2 suffix. */
function freshLike(id: string, taken: Set<string>): string {
  const m = id.match(/^(.*?)\d+$/);
  return m && m[1] && isIdent(m[1]) ? nextId(m[1], taken) : uniqueName(id, taken);
}

/**
 * Pastes a clip shifted by `offset`, with fresh ids (and pin names) and every internal reference
 * remapped. Pointer names are kept: a pasted pointer joins the net of the same name. Parts that
 * would place this chip inside itself are dropped with their wires.
 */
export function pasteClip(doc: ChipDoc, clip: Clip, offset: Vec): { doc: ChipDoc; sel: Sel } {
  const partIds = new Set(partNames(doc));
  const pinIds = new Set(doc.pins.map((p) => p.id)), pinNames = new Set(doc.pins.map((p) => p.name));
  const labelIds = new Set(doc.labels.map((l) => l.id)), wireIds = new Set(doc.wires.map((w) => w.id));
  const pm = new Map<string, string>(), pinm = new Map<string, string>(), lm = new Map<string, string>(), wm = new Map<string, string>();
  const take = (s: Set<string>, id: string) => (s.add(id), id);

  const parts = clip.parts.filter((p) => !('chip' in p.ref && p.ref.chip === doc.id)).map((p) => {
    const id = take(partIds, freshLike(p.id, partIds));
    pm.set(p.id, id);
    return { ...p, id, at: add(p.at, offset) };
  });
  const pins = clip.pins.map((p) => {
    const id = take(pinIds, nextId('pin', pinIds));
    pinm.set(p.id, id);
    const m = p.name.match(/^(in|out)\d+$/);
    const name = take(pinNames, m ? nextId(m[1], pinNames) : uniqueName(p.name, pinNames));
    return { ...p, id, name, at: add(p.at, offset) };
  });
  const labels = clip.labels.map((l) => {
    const id = take(labelIds, nextId('l', labelIds));
    lm.set(l.id, id);
    return { ...l, id, at: add(l.at, offset) };
  });
  // Ids first, so a branch may refer to a wire that comes later in the clip.
  const pasted = clip.wires.filter((w) => {
    const ok = (e: EndRef) => !('part' in e) || pm.has(e.part);
    return ok(w.a) && ok(w.b);
  });
  for (let grew = true; grew;) { // drop branches of dropped wires
    grew = false;
    const ids = new Set(pasted.map((w) => w.id));
    for (let i = pasted.length - 1; i >= 0; i--) {
      const w = pasted[i];
      if ([w.a, w.b].some((e) => 'wire' in e && !ids.has(e.wire))) { pasted.splice(i, 1); grew = true; }
    }
  }
  for (const w of pasted) wm.set(w.id, take(wireIds, nextId('w', wireIds)));
  const end = (e: EndRef): EndRef | null => {
    if ('part' in e) return pm.has(e.part) ? { part: pm.get(e.part)!, port: e.port } : null;
    if ('pin' in e) return pinm.has(e.pin) ? { pin: pinm.get(e.pin)! } : null;
    if ('label' in e) return lm.has(e.label) ? { label: lm.get(e.label)! } : null;
    return wm.has(e.wire) ? { wire: wm.get(e.wire)!, at: add(e.at, offset) } : null;
  };
  const wires: WireDoc[] = [];
  for (const w of pasted) {
    const [a, b] = [end(w.a), end(w.b)];
    if (a && b) wires.push({ ...w, id: wm.get(w.id)!, a, b, pts: w.pts.map((p) => add(p, offset)) });
  }
  return {
    doc: { ...doc, parts: [...doc.parts, ...parts], pins: [...doc.pins, ...pins], labels: [...doc.labels, ...labels], wires: [...doc.wires, ...wires] },
    sel: { parts: parts.map((p) => p.id), pins: pins.map((p) => p.id), labels: labels.map((l) => l.id), wires: wires.map((w) => w.id) },
  };
}

export const duplicate = (doc: ChipDoc, sel: Sel, offset: Vec): { doc: ChipDoc; sel: Sel } => pasteClip(doc, copySel(doc, sel), offset);

export function selectAll(doc: ChipDoc): Sel {
  return { parts: doc.parts.map((p) => p.id), pins: doc.pins.map((p) => p.id), wires: doc.wires.map((w) => w.id), labels: doc.labels.map((l) => l.id) };
}

/**
 * Everything fully inside the rectangle spanned by two corners (any order): parts by their
 * symbol's box (just the anchor when the part does not resolve), pins and pointers by their
 * point, wires by their whole polyline.
 */
export function boxSelect(doc: ChipDoc, rect: [Vec, Vec], defOf: DefOf): Sel {
  const [x0, x1] = [Math.min(rect[0][0], rect[1][0]), Math.max(rect[0][0], rect[1][0])];
  const [y0, y1] = [Math.min(rect[0][1], rect[1][1]), Math.max(rect[0][1], rect[1][1])];
  const inn = (p: Vec) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const parts = doc.parts.filter((p) => {
    const d = defOf(p);
    if (!d) return inn(p.at);
    const g = symbolGeom(d);
    return inn(p.at) && inn(add(p.at, [g.w, g.h]));
  });
  const wires = doc.wires.filter((w) => {
    const poly = polyline(doc, w, defOf);
    return poly ? poly.every(inn) : false;
  });
  return {
    parts: parts.map((p) => p.id),
    pins: doc.pins.filter((p) => inn(p.at)).map((p) => p.id),
    wires: wires.map((w) => w.id),
    labels: doc.labels.filter((l) => inn(l.at)).map((l) => l.id),
  };
}
