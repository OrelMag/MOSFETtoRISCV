// Editor geometry that needs no DOM: snapping, hit testing, the pointer flag, which wires touch
// (junction dots) and the wire being drawn. tools.ts and view.ts share it; tests run it in Node.
//
// Everything is in grid units. Hit tolerances come in from the caller, already converted from
// screen pixels, so a click is as forgiving at any zoom.

import { type ExitDir, symbolGeom, type Vec } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';
import { type Rect, textWidth } from '../view/route';
import {
  type ChipDoc, type DefOf, defaultFace, endGeom, endKey, type EndRef, type LabelDoc, onPolyline, orthogonal,
  type PinDoc, polyline, type WireDoc,
} from './model';
import { nearestOn } from './ops';

export const DIR: Record<ExitDir, Vec> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
const horiz = (d: ExitDir) => d === 'left' || d === 'right';

export const snapPt = (p: Vec): Vec => [Math.round(p[0]), Math.round(p[1])];
const frac = (v: number) => v - Math.floor(v);

/**
 * Top-left corner for a part centred under `c`, chosen so its ports land on integer grid points
 * (wires drawn on the grid then meet them exactly). Symbols whose ports sit on half units shift
 * by that half (for most of their ports, when they disagree).
 */
export function partAnchor(def: ComponentDef, c: Vec): Vec {
  const g = symbolGeom(def);
  // The fractional offset most ports share (a pitch-1 splitter's taps sit on half units).
  const count = new Map<string, number>();
  let fx = 0, fy = 0, best = 0;
  for (const { pos } of Object.values(g.ports)) {
    const k = `${frac(pos[0])},${frac(pos[1])}`;
    const n = (count.get(k) ?? 0) + 1;
    count.set(k, n);
    if (n > best) [best, fx, fy] = [n, frac(pos[0]), frac(pos[1])];
  }
  return [Math.round(c[0] - g.w / 2 + fx) - fx, Math.round(c[1] - g.h / 2 + fy) - fy];
}

export function partBox(def: ComponentDef | undefined, at: Vec): Rect {
  if (!def) return { x: at[0], y: at[1], w: 6, h: 4 };
  const g = symbolGeom(def);
  return { x: at[0], y: at[1], w: g.w, h: g.h };
}

const inRect = (r: Rect, p: Vec, m = 0) => p[0] >= r.x - m && p[0] <= r.x + r.w + m && p[1] >= r.y - m && p[1] <= r.y + r.h + m;

// ---- pins and pointers ----------------------------------------------------------------------

/** Centre of a chip pin's knob (drawPinGlyph puts it 0.9 behind the connection point). */
export function pinKnob(p: PinDoc): Vec {
  const d = DIR[defaultFace(p)];
  return [p.at[0] - d[0] * 0.9, p.at[1] - d[1] * 0.9];
}

/** The part of a pin that selects, drags and toggles it: the knob, or the value box of a bus. */
export function pinBody(p: PinDoc): Rect {
  const [cx, cy] = pinKnob(p);
  const f = defaultFace(p);
  if (p.width === 1 || !horiz(f)) return { x: cx - 1, y: cy - 1, w: 2, h: 2 };
  const len = Math.max(3, textWidth('0x'.padEnd(2 + Math.ceil(p.width / 4), '0'), 1.05));
  return f === 'right' ? { x: cx - len + 0.6, y: cy - 0.9, w: len, h: 1.8 } : { x: cx - 0.6, y: cy - 0.9, w: len, h: 1.8 };
}

export const TAG_H = 1.35;
const STUB = 1;

/**
 * A pointer: a short stub from where wires attach (`at`) to a flag with the name, pointing away
 * in the direction it faces. `outline` is the flag polygon: flat on the stub side, pointed at
 * the far end.
 */
export function pointerGeom(l: Pick<LabelDoc, 'at' | 'face' | 'name'>): { tip: Vec; rect: Rect; outline: Vec[]; text: Vec } {
  const face = l.face ?? 'right';
  const d = DIR[face];
  const tip: Vec = [l.at[0] + d[0] * STUB, l.at[1] + d[1] * STUB];
  const w = textWidth(l.name, 0.8) + 0.6, h = TAG_H, pt = 0.55;
  let rect: Rect, outline: Vec[];
  if (horiz(face)) {
    const s = d[0];
    const x0 = tip[0], x1 = tip[0] + s * w, xp = x1 + s * pt, y0 = tip[1] - h / 2, y1 = tip[1] + h / 2;
    outline = [[x0, y0], [x1, y0], [xp, tip[1]], [x1, y1], [x0, y1]];
    rect = { x: Math.min(x0, xp), y: y0, w: w + pt, h };
  } else {
    const s = d[1];
    const y0 = tip[1], y1 = tip[1] + s * h, yp = y1 + s * pt, x0 = tip[0] - w / 2, x1 = tip[0] + w / 2;
    outline = [[x0, y0], [x0, y1], [tip[0], yp], [x1, y1], [x1, y0]];
    rect = { x: x0, y: Math.min(y0, yp), w, h: h + pt };
  }
  const text: Vec = horiz(face) ? [tip[0] + d[0] * w / 2, tip[1] + 0.3] : [tip[0], tip[1] + d[1] * h / 2 + 0.3];
  return { tip, rect, outline, text };
}

/** The pointer after this one with the same name (document order, wrapping), or null. */
export function nextSameName(doc: ChipDoc, id: string): LabelDoc | null {
  const l = doc.labels.find((q) => q.id === id);
  if (!l) return null;
  const same = doc.labels.filter((q) => q.name === l.name);
  if (same.length < 2) return null;
  return same[(same.indexOf(l) + 1) % same.length];
}

// ---- hit testing ----------------------------------------------------------------------------

export type Hit =
  /** Somewhere a wire can start or end: a part port, a chip pin's connection point, a pointer. */
  | { k: 'port'; end: EndRef; pos: Vec }
  | { k: 'part'; id: string }
  | { k: 'pin'; id: string }
  | { k: 'label'; id: string }
  /** On a wire; `at` is the nearest point of it. */
  | { k: 'wire'; id: string; at: Vec }
  | { k: 'none' };

const dist = (a: Vec, b: Vec) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** Every place a wire can attach, with its position. */
export function attachPoints(doc: ChipDoc, defOf: DefOf): { end: EndRef; pos: Vec; exit: ExitDir | null }[] {
  const out: { end: EndRef; pos: Vec; exit: ExitDir | null }[] = [];
  for (const p of doc.parts) {
    const d = defOf(p);
    if (!d) continue;
    for (const q of d.ports) {
      const e: EndRef = { part: p.id, port: q.name };
      const g = endGeom(doc, e, defOf);
      if (g) out.push({ end: e, pos: g.pos, exit: g.exit });
    }
  }
  for (const p of doc.pins) out.push({ end: { pin: p.id }, pos: p.at, exit: defaultFace(p) });
  for (const l of doc.labels) out.push({ end: { label: l.id }, pos: l.at, exit: endGeom(doc, { label: l.id }, defOf)!.exit });
  return out;
}

/** Distance from p to an orthogonal polyline. */
export function distToPolyline(poly: Vec[], p: Vec): number {
  return dist(nearestOn(poly, p), p);
}

/**
 * What is under p. Ports win within `tol` (so a wire can start on a pin that sits on a part's
 * edge), then pins, pointers and parts (the last drawn on top), then wires.
 */
export function hitTest(doc: ChipDoc, defOf: DefOf, p: Vec, tol: number, polys?: Map<string, Vec[]>): Hit {
  let best: Hit = { k: 'none' }, bd = tol;
  for (const a of attachPoints(doc, defOf)) {
    const d = dist(a.pos, p);
    if (d <= bd) { bd = d; best = { k: 'port', end: a.end, pos: a.pos }; }
  }
  if (best.k !== 'none') return best;
  for (let i = doc.pins.length - 1; i >= 0; i--) if (inRect(pinBody(doc.pins[i]), p)) return { k: 'pin', id: doc.pins[i].id };
  for (let i = doc.labels.length - 1; i >= 0; i--) if (inRect(pointerGeom(doc.labels[i]).rect, p, 0.1)) return { k: 'label', id: doc.labels[i].id };
  for (let i = doc.parts.length - 1; i >= 0; i--) {
    const q = doc.parts[i];
    if (inRect(partBox(defOf(q), q.at), p, 0.2)) return { k: 'part', id: q.id };
  }
  return hitWire(doc, defOf, p, tol, polys) ?? { k: 'none' };
}

export function hitWire(doc: ChipDoc, defOf: DefOf, p: Vec, tol: number, polys?: Map<string, Vec[]>): Extract<Hit, { k: 'wire' }> | null {
  let best: Extract<Hit, { k: 'wire' }> | null = null, bd = tol;
  for (let i = doc.wires.length - 1; i >= 0; i--) {
    const w = doc.wires[i];
    const poly = polys?.get(w.id) ?? polyline(doc, w, defOf);
    if (!poly || poly.length < 2) continue;
    const q = nearestOn(poly, p);
    const d = dist(q, p);
    if (d < bd) { bd = d; best = { k: 'wire', id: w.id, at: q }; }
  }
  return best;
}

/** Where a branch starts on a wire: the grid point nearest p that lies on it, else the nearest point. */
export function branchPoint(poly: Vec[], p: Vec): Vec {
  const g = snapPt(p);
  const q = nearestOn(poly, g);
  return onPolyline(poly, g) ? g : q;
}

/** A part output or a chip input: two of these on one wire are always a short at gate level. */
export function drives(doc: ChipDoc, e: EndRef, defOf: DefOf): boolean {
  if ('part' in e) {
    const p = doc.parts.find((q) => q.id === e.part);
    const d = p && defOf(p);
    return d?.ports.find((q) => q.name === e.port)?.dir === 'out';
  }
  if ('pin' in e) return doc.pins.find((q) => q.id === e.pin)?.dir === 'in';
  return false;
}

// ---- which wires touch (junction dots) ------------------------------------------------------

/** Wires joined at a shared end (a port, pin or pointer) or by a branch, as groups of ids. */
export function wireGroups(wires: WireDoc[]): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  const union = (a: string, b: string) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };
  for (const w of wires) {
    find(`w:${w.id}`);
    for (const e of [w.a, w.b]) union(`w:${w.id}`, 'wire' in e ? `w:${e.wire}` : endKey(e));
  }
  const groups = new Map<string, string[]>();
  for (const w of wires) {
    const r = find(`w:${w.id}`);
    const g = groups.get(r);
    if (g) g.push(w.id);
    else groups.set(r, [w.id]);
  }
  return [...groups.values()];
}

// ---- the wire being drawn -------------------------------------------------------------------

/** The corner of an L from a to b: horizontal leg first unless vFirst. None when they line up. */
export function elbow(a: Vec, b: Vec, vFirst: boolean): Vec[] {
  if (a[0] === b[0] || a[1] === b[1]) return [];
  return [vFirst ? [a[0], b[1]] : [b[0], a[1]]];
}

/**
 * A wire being drawn free-hand (Digital Logic Sim style): it starts on an attach point, every
 * click on empty canvas fixes the L to the cursor, Space flips the L, Backspace takes the last
 * corner back. The L leaves the previous leg at a right angle unless flipped; when it arrives
 * on a port it enters along the port's axis.
 */
export class WireDraft {
  /** Fixed points after the start (each click adds the L's corner and the click point). */
  pts: Vec[] = [];
  private flipped = false;
  /** Lengths of pts before each click, for Backspace. */
  private marks: number[] = [];

  constructor(readonly from: EndRef, readonly start: Vec, readonly startExit: ExitDir | null) {}

  get last(): Vec {
    return this.pts.length ? this.pts[this.pts.length - 1] : this.start;
  }

  /** Orientation of the last fixed leg ('h' / 'v'), or the start port's axis. */
  private lastLeg(): 'h' | 'v' | null {
    const all = [this.start, ...this.pts];
    for (let i = all.length - 1; i >= 1; i--) {
      const [a, b] = [all[i - 1], all[i]];
      if (a[1] === b[1] && a[0] !== b[0]) return 'h';
      if (a[0] === b[0] && a[1] !== b[1]) return 'v';
    }
    return this.startExit ? (horiz(this.startExit) ? 'v' : 'h') : null; // the start's axis is "the leg before"
  }

  /** Vertical leg first? Default: turn at a right angle to the previous leg; into a port along its axis. */
  vFirst(target?: ExitDir | null): boolean {
    let v: boolean;
    if (target && !this.flipped) v = horiz(target); // arrive horizontally on a left/right port
    else {
      const leg = this.lastLeg();
      v = leg === 'h';
      if (this.flipped) v = !v;
    }
    return v;
  }

  flip(): void {
    this.flipped = !this.flipped;
  }

  /** The whole path from the start to `to` (a snapped cursor or a port). */
  preview(to: Vec, target?: ExitDir | null): Vec[] {
    return orthogonal([this.start, ...this.pts, ...elbow(this.last, to, this.vFirst(target)), to]);
  }

  /** Fix the L to `p` (a click on empty canvas). */
  addCorner(p: Vec): void {
    const l = this.last;
    if (l[0] === p[0] && l[1] === p[1]) return;
    this.marks.push(this.pts.length);
    this.pts.push(...elbow(l, p, this.vFirst()), [p[0], p[1]]);
    this.flipped = false;
  }

  /** Take the last click back; false when there is nothing left to take back. */
  undo(): boolean {
    const m = this.marks.pop();
    if (m === undefined) return false;
    this.pts.length = m;
    this.flipped = false;
    return true;
  }

  /** Interior corners of the finished wire ending at `to`. */
  corners(to: Vec, target?: ExitDir | null): Vec[] {
    const p = this.preview(to, target);
    return p.slice(1, -1);
  }
}
