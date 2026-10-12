// A packaged chip's face (Digital Logic Sim's "customize"): the box size, every pin on any side at
// any offset, and the displays inside the chip drawn on its box, live. The chip document keeps only
// what the learner set (model.ts FaceDoc); resolveFace fills in the rest (automatic size and pins,
// as compile.ts always placed them) and grows the box to fit, so a face can never hide a pin. The
// compiled def carries the result as ordinary symbol geometry (PortDef.side, symbol.w / h / portPos,
// keepOut for the label), so drawing, routing and hit testing need nothing new; the displays ride
// along in a WeakMap (faceOf). Nothing here touches the DOM (the tests run in Node).

import type { HierNode } from '../sim/flatten';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { consoleLayout, ioInfo, screenLayout } from './ioparts';
import type { DisplayKind, FaceDisplayDoc, FaceDoc, FacePinDoc, FaceSide, PartDoc, PinDoc, Vec } from './model';
import { displayOf } from './parts';

/** Largest box side (grid units). */
export const FACE_MAX = 240;
export const SCALE_MIN = 0.25;
export const SCALE_MAX = 4;
export const SIDES: FaceSide[] = ['left', 'top', 'right', 'bottom'];

export type FaceKind = Exclude<DisplayKind, 'halt'> | 'console' | 'screen' | 'switches';

/** Something a face can show: a display or I/O part of the chip, or one a placed chip shows on its own face. */
export interface FaceItem {
  /** Part ids from this chip down to the display. */
  path: string[];
  def: ComponentDef;
  kind: FaceKind;
  width: number;
  /**
   * A simple display's input: its net's index in the netlist of the chip holding it (the chip at
   * path minus the last id; -1: not connected). Unused by I/O parts, which keep state in their leaf.
   */
  net: number;
  /** The area of the part shown on a face (its local units, unflipped): the whole box, or a console's or screen's picture. */
  crop: { x: number; y: number; w: number; h: number };
}

/** A face item placed: top-left of its crop on the box and its scale. */
export interface FaceShown extends FaceItem { x: number; y: number; scale: number }

export interface ChipFace { displays: FaceShown[] }

const faces = new WeakMap<ComponentDef, ChipFace>();
/** The displays a compiled chip shows on its box (null: none). */
export const faceOf = (d: ComponentDef | undefined): ChipFace | null => (d && faces.get(d)) ?? null;
export const setFaceOf = (d: ComponentDef, f: ChipFace): void => void faces.set(d, f);

export const pathKey = (path: readonly string[]): string => path.join('.');

const KIND_TITLE: Record<FaceKind, (w: number) => string> = {
  led: (w) => (w > 1 ? `LED bank (${w})` : 'LED'), seg7: () => '7-segment', hex: () => 'Hex digit', value: () => 'Value', buzzer: () => 'Buzzer',
  console: () => 'Console', screen: () => 'Screen', switches: (w) => (w > 1 ? `Switches (${w})` : 'Switch'),
};
/** "7-segment" for an item, for lists. */
export const itemTitle = (it: FaceItem): string => KIND_TITLE[it.kind](it.width);

/**
 * What the chip's face may show, in part order: its own displays (not the halt part, which shows
 * nothing) and I/O parts, then whatever each placed chip shows on its face. `netOf(id)`: the net
 * index on display part `id`'s input in this chip.
 */
export function faceItems(parts: Iterable<{ doc: PartDoc; def: ComponentDef }>, netOf: (id: string) => number): FaceItem[] {
  const out: FaceItem[] = [];
  for (const { doc: p, def } of parts) {
    const g = symbolGeom(def);
    const whole = { x: 0, y: 0, w: g.w, h: g.h };
    const d = displayOf(def);
    if (d && d.kind !== 'halt') {
      out.push({ path: [p.id], def, kind: d.kind, width: d.width, net: netOf(p.id), crop: whole });
      continue;
    }
    const io = ioInfo(def);
    if (io) {
      const crop = io.kind === 'console' ? consoleLayout(def, false).face : io.kind === 'screen' ? screenLayout(def, false).face : whole;
      out.push({ path: [p.id], def, kind: io.kind, width: io.kind === 'switches' ? io.width : 0, net: -1, crop: { ...crop } });
      continue;
    }
    for (const s of faceOf(def)?.displays ?? []) {
      out.push({ path: [p.id, ...s.path], def: s.def, kind: s.kind, width: s.width, net: s.net, crop: s.crop });
    }
  }
  return out;
}

/** Where each pin sits on the box: by pin id. */
export type PinPlaces = Map<string, FacePinDoc>;

export interface ResolvedFace {
  w: number;
  h: number;
  pins: PinPlaces;
  displays: FaceShown[];
  /** Displays the document names that the chip no longer has (left off the box). */
  missing: string[];
  label: boolean;
}

const defaultSide = (p: Pick<PinDoc, 'dir'>): FaceSide => (p.dir === 'out' ? 'right' : 'left');
const along = (s: FaceSide) => s === 'left' || s === 'right';

/** The box compile.ts draws without a face: inputs and inouts on the left, outputs on the right, sized to fit. */
export function autoFace(pins: readonly Pick<PinDoc, 'id' | 'name' | 'dir' | 'width'>[], label: string): { w: number; h: number; pins: PinPlaces } {
  const ports: PortDef[] = pins.map((p) => ({ name: p.name, width: p.width, dir: p.dir }));
  const g = symbolGeom({ id: '', name: label, category: 'custom', ports, symbol: { kind: 'box', label } });
  const places: PinPlaces = new Map();
  for (const p of pins) {
    const pg = g.ports[p.name];
    const side = defaultSide(p);
    if (pg) places.set(p.id, { side, at: along(side) ? pg.pos[1] : pg.pos[0] });
  }
  return { w: g.w, h: g.h, pins: places };
}

const okPlace = (x: unknown): x is FacePinDoc =>
  typeof x === 'object' && x !== null && SIDES.includes((x as FacePinDoc).side) && Number.isInteger((x as FacePinDoc).at) && (x as FacePinDoc).at >= 1;

const clampScale = (s: number | undefined) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, s ?? 1));

/**
 * The face as drawn. `pins` in port order (compile.ts: inputs, inouts, outputs). Pins the face
 * places keep their spot (a second pin on a taken spot moves on); the others go to their default
 * side, 2 units past the last pin there. The box is the face's size (else the automatic one),
 * grown to hold every pin (none on a corner) and every display.
 */
export function resolveFace(face: FaceDoc | undefined, pins: readonly Pick<PinDoc, 'id' | 'name' | 'dir' | 'width'>[], label: string, items: readonly FaceItem[]): ResolvedFace {
  const auto = autoFace(pins, label);
  const placed: PinPlaces = new Map();
  const taken = new Set<string>();
  const key = (p: FacePinDoc) => `${p.side}:${p.at}`;
  if (face?.pins && Object.keys(face.pins).length) {
    const rest: typeof pins[number][] = [];
    for (const p of pins) {
      const f = face.pins[p.id];
      if (okPlace(f) && !taken.has(key(f))) {
        placed.set(p.id, { side: f.side, at: f.at });
        taken.add(key(f));
      } else rest.push(p);
    }
    for (const p of rest) {
      const side = defaultSide(p);
      const used = [...placed.values()].filter((q) => q.side === side).map((q) => q.at);
      let at = used.length ? Math.max(...used) + 2 : 2;
      while (taken.has(`${side}:${at}`)) at++;
      placed.set(p.id, { side, at });
      taken.add(`${side}:${at}`);
    }
  } else for (const [id, p] of auto.pins) placed.set(id, p);

  const byKey = new Map(items.map((it) => [pathKey(it.path), it]));
  const displays: FaceShown[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const d of face?.displays ?? []) {
    const k = pathKey(d.path);
    if (seen.has(k)) continue;
    seen.add(k);
    const it = byKey.get(k);
    if (!it) { missing.push(k); continue; }
    displays.push({ ...it, x: Math.max(0, d.at[0]), y: Math.max(0, d.at[1]), scale: clampScale(d.scale) });
  }

  let w = face?.w ?? auto.w, h = face?.h ?? auto.h;
  for (const p of placed.values()) {
    if (along(p.side)) h = Math.max(h, p.at + 1);
    else w = Math.max(w, p.at + 1);
  }
  for (const d of displays) {
    w = Math.max(w, d.x + d.crop.w * d.scale);
    h = Math.max(h, d.y + d.crop.h * d.scale);
  }
  w = Math.min(FACE_MAX, Math.max(2, Math.ceil(w)));
  h = Math.min(FACE_MAX, Math.max(2, Math.ceil(h)));
  return { w, h, pins: placed, displays, missing, label: !face?.noLabel };
}

/**
 * `def` (a compiled chip, ports in compile order) with its face: ports on their sides at their
 * offsets, the box size, the label (`name`, else the def's) clear of the displays or left off.
 * Any face `def` had is replaced.
 */
export function applyFace(def: ComponentDef, pins: readonly Pick<PinDoc, 'id' | 'name'>[], r: ResolvedFace, name = def.name): ComponentDef {
  const byName = new Map(pins.map((p) => [p.name, p]));
  const portPos: Record<string, number> = {};
  const ports = def.ports.map((p) => {
    const pin = byName.get(p.name);
    const at = pin && r.pins.get(pin.id);
    if (!at) return p;
    portPos[p.name] = at.at;
    return { ...p, side: at.side };
  });
  const keepOut = r.displays.map((d) => ({ x: d.x, y: d.y, w: d.crop.w * d.scale, h: d.crop.h * d.scale }));
  const { keepOut: _k, portPos: _p, ...sym } = def.symbol;
  return {
    ...def, ports,
    symbol: { ...sym, w: r.w, h: r.h, portPos, label: r.label ? name : '', ...(keepOut.length ? { keepOut } : {}) },
  };
}

// ---- edits (the face editor) -------------------------------------------------------------------

/** A face with every pin and the size written out (what the editor edits). */
export function explicitFace(face: FaceDoc | undefined, r: ResolvedFace): FaceDoc {
  return { ...face, w: r.w, h: r.h, pins: Object.fromEntries([...r.pins].map(([id, p]) => [id, { ...p }])) };
}

/** Is the face only what the automatic one would draw (nothing worth saving)? */
export const isEmptyFace = (f: FaceDoc | undefined): boolean =>
  !f || (f.w === undefined && f.h === undefined && !f.pins && !f.displays?.length && !f.noLabel);

/**
 * Pin `id` dropped on `side` at `at` (a grid point, 1 … length − 1): a pin already there takes the
 * dropped pin's old spot (a swap), so no two pins ever share one.
 */
export function movePin(face: FaceDoc, r: ResolvedFace, id: string, side: FaceSide, at: number): FaceDoc {
  const f = explicitFace(face, r);
  const pins = f.pins!;
  const old = pins[id];
  if (!old) return face;
  const len = along(side) ? f.h! : f.w!;
  at = Math.max(1, Math.min(len - 1, Math.round(at)));
  const other = Object.entries(pins).find(([q, p]) => q !== id && p.side === side && p.at === at);
  if (other) pins[other[0]] = { ...old };
  pins[id] = { side, at };
  return f;
}

/**
 * Pin `id` moved to `side`: the free spot nearest its middle, even offsets first (port names
 * need 2 units); a full side grows by 2 for it.
 */
export function pinToSide(face: FaceDoc | undefined, r: ResolvedFace, id: string, side: FaceSide): FaceDoc {
  const f = explicitFace(face, r);
  const pins = f.pins!;
  if (!pins[id]) return f;
  const len = along(side) ? f.h! : f.w!;
  const used = new Set(Object.entries(pins).filter(([q, p]) => q !== id && p.side === side).map(([, p]) => p.at));
  const mid = 2 * Math.round(len / 4);
  const free = Array.from({ length: Math.max(0, len - 1) }, (_, i) => i + 1).filter((at) => !used.has(at))
    .sort((a, b) => (a % 2) - (b % 2) || Math.abs(a - mid) - Math.abs(b - mid));
  if (free.length) pins[id] = { side, at: free[0] };
  else {
    pins[id] = { side, at: len + 1 };
    if (along(side)) f.h = len + 2;
    else f.w = len + 2;
  }
  return f;
}

/** The smallest box the pins and displays allow (the label is not a constraint: it hides when it does not fit). */
export function minSize(r: ResolvedFace): { w: number; h: number } {
  let w = 2, h = 2;
  for (const p of r.pins.values()) {
    if (along(p.side)) h = Math.max(h, p.at + 1);
    else w = Math.max(w, p.at + 1);
  }
  for (const d of r.displays) {
    w = Math.max(w, Math.ceil(d.x + d.crop.w * d.scale));
    h = Math.max(h, Math.ceil(d.y + d.crop.h * d.scale));
  }
  return { w, h };
}

/** The box resized (never below what it holds). */
export function resizeFace(face: FaceDoc, r: ResolvedFace, w: number, h: number): FaceDoc {
  const m = minSize(r);
  return { ...explicitFace(face, r), w: Math.min(FACE_MAX, Math.max(m.w, Math.round(w))), h: Math.min(FACE_MAX, Math.max(m.h, Math.round(h))) };
}

/** Automatic pins and size again (displays and the label setting stay). */
export function autoLayout(face: FaceDoc | undefined): FaceDoc | undefined {
  if (!face) return undefined;
  const { w: _w, h: _h, pins: _p, ...rest } = face;
  return isEmptyFace(rest) ? undefined : rest;
}

/**
 * Show or hide an item. A new display goes below what the box holds (the box grows), at its
 * natural size, or smaller to fit a box wider than 16 units.
 */
export function toggleDisplay(face: FaceDoc | undefined, r: ResolvedFace, it: FaceItem, on: boolean): FaceDoc | undefined {
  const k = pathKey(it.path);
  const list = (face?.displays ?? []).filter((d) => pathKey(d.path) !== k);
  if (on) {
    const bottom = Math.max(1, ...r.displays.map((d) => d.y + d.crop.h * d.scale));
    const scale = it.crop.w > 16 ? Math.max(SCALE_MIN, Math.round((16 / it.crop.w) * 20) / 20) : 1;
    const x = Math.max(1, Math.round(((r.w - it.crop.w * scale) / 2) * 2) / 2);
    list.push({ path: [...it.path], at: [x, r.displays.length ? Math.ceil(bottom + 0.5) : 1], ...(scale !== 1 ? { scale } : {}) });
  }
  const next: FaceDoc = { ...face, displays: list };
  if (!list.length) delete next.displays;
  return isEmptyFace(next) ? undefined : next;
}

/** Display `path` moved to `at` (snapped to half units) and / or scaled. */
export function placeDisplay(face: FaceDoc, path: readonly string[], at: Vec, scale?: number): FaceDoc {
  const k = pathKey(path);
  const snap = (v: number) => Math.max(0, Math.round(v * 2) / 2);
  return {
    ...face,
    displays: (face.displays ?? []).map((d): FaceDisplayDoc => {
      if (pathKey(d.path) !== k) return d;
      const s = scale === undefined ? d.scale : Math.round(clampScale(scale) * 20) / 20;
      return { path: d.path, at: [snap(at[0]), snap(at[1])], ...(s !== undefined && s !== 1 ? { scale: s } : {}) };
    }),
  };
}

/** The face without entries for pins the chip no longer has (the store's sanitizer). */
export function pruneFace(face: FaceDoc, pinIds: ReadonlySet<string>): FaceDoc | undefined {
  const f: FaceDoc = { ...face };
  if (f.pins) {
    f.pins = Object.fromEntries(Object.entries(f.pins).filter(([id]) => pinIds.has(id)));
    if (!Object.keys(f.pins).length) delete f.pins;
  }
  return isEmptyFace(f) ? undefined : f;
}

// ---- a placed chip ----------------------------------------------------------------------------

/** Where a shown display sits on a placed box `w` wide (mirrored with the part, its picture not). */
export function shownBox(d: FaceShown, w: number, flip: boolean): { x: number; y: number; w: number; h: number } {
  const dw = d.crop.w * d.scale, dh = d.crop.h * d.scale;
  return { x: flip ? w - d.x - dw : d.x, y: d.y, w: dw, h: dh };
}

/** The display under a point of a placed chip (part-local units), and the point in the display part's own units. */
export function faceHit(def: ComponentDef, flip: boolean, x: number, y: number): { d: FaceShown; lx: number; ly: number } | null {
  const f = faceOf(def);
  if (!f) return null;
  const w = symbolGeom(def).w;
  for (let i = f.displays.length - 1; i >= 0; i--) {
    const d = f.displays[i], b = shownBox(d, w, flip);
    if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return { d, lx: d.crop.x + (x - b.x) / d.scale, ly: d.crop.y + (y - b.y) / d.scale };
  }
  return null;
}

/** The hierarchy node at `path` below `node` (null when a level is not expanded in this simulation). */
export function nodeAt(node: HierNode | null | undefined, path: readonly string[]): HierNode | null {
  for (const id of path) node = node?.children?.get(id);
  return node ?? null;
}

/** The flat nets of a shown simple display's input below `chip` (its placed chip's node), or null. */
export function shownNets(chip: HierNode | null | undefined, d: FaceItem): number[] | null {
  return d.net < 0 ? null : nodeAt(chip, d.path.slice(0, -1))?.nets?.[d.net] ?? null;
}
