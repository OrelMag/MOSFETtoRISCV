// The sandbox's document model: plain JSON that the user edits, saves and shares. A circuit
// is a chip (as in Digital Logic Sim): its pins become the ports of the ComponentDef that
// compile.ts builds from it, so a packaged chip simulates, opens, counts and exports like any
// library part. Nothing here touches the DOM (the tests run in Node).
//
// Coordinates are grid units (1 unit = 10 px), the same as netlist layouts. Wires store only
// their interior corners: the ends follow the pins they attach to, so moving a part never
// detaches a wire. Corners are meant to be orthogonal; `polyline` repairs a diagonal step
// (left by a move) with an L, horizontal first.

import { instPort, type ExitDir, type Vec } from '../sim/geometry';
import type { ComponentDef } from '../sim/types';

export type { Vec, ExitDir };

export const SCHEMA = 1;

export interface Workspace {
  schema: typeof SCHEMA;
  chips: Record<string, ChipDoc>;
  /** Tab stack of open chips (ids), last = active. */
  open: string[];
  /** Palette limited to transistors, NAND, IO, wiring and user chips. */
  purist?: boolean;
}

export interface ChipDoc {
  /** 'u_<slug>': stable across renames, a valid Verilog identifier, unique in the workspace. */
  id: string;
  name: string;
  /** Box tint (0–359), shown when the chip is placed. */
  hue?: number;
  notes?: string;
  /**
   * "This chip is a flip-flop": pin names of d, q, clk (and en). Compiled into ComponentDef.ff
   * once a short clocked test confirms it (static timing then stops at it; synthesis export
   * writes it as a process).
   */
  ff?: { d: string; q: string; clk: string; en?: string };
  pins: PinDoc[];
  parts: PartDoc[];
  wires: WireDoc[];
  labels: LabelDoc[];
}

/**
 * One of the chip's own pins. Inputs become `in` ports, outputs `out` ports, bidirectional pins
 * `inout` ports (switch level only: a transistor terminal brought out, like an SRAM cell's bit
 * lines; any number of transistors, and the chip's parent, may drive the net).
 */
export interface PinDoc {
  id: string;
  /** Port name: unique within the chip, identifier characters only, no '.'. */
  name: string;
  dir: 'in' | 'out' | 'inout';
  width: number;
  /** Connection point (where wires attach). */
  at: Vec;
  /** Direction a wire leaves the pin (inputs and inouts default 'right', outputs 'left'). */
  face?: ExitDir;
  /** Inputs only: how the user drives it. 'clock' marks the port `clock: true`. */
  kind?: 'toggle' | 'button' | 'clock';
  /** Inputs only: the value it is set to (kept across reloads). */
  value?: number;
}

export interface PartDoc {
  /** Instance name: unique within the chip, identifier characters only, no '.'. */
  id: string;
  ref: PartRef;
  /** Top-left of the symbol. */
  at: Vec;
  flip?: boolean;
  /** Caption (defaults to the id). */
  label?: string;
}

export type DisplayKind = 'led' | 'seg7' | 'hex' | 'value';

export type PartRef =
  /** Any library component, by id (registry, family key or generator pattern). */
  | { lib: string }
  /** A user chip of this workspace. */
  | { chip: string }
  | { split: number[]; pitch?: number }
  | { merge: number[]; pitch?: number }
  | { const: { width: number; value: number } }
  /** Pure view: zero-cost sink that shows the value of the net on its input `a`. */
  | { display: DisplayKind; width?: number }
  /** Read-only memory: 2^k words of w bits. 'rv32' addresses bytes like a PC (addr = 4·word). */
  | { rom: { k: number; w: 8 | 16 | 32; addr: 'word' | 'rv32'; lang: 'asm' | 'hex'; src: string } }
  /** Read-write memory: 2^k words of w bits; `init`: the words it holds at power-on ('to 0' mode). */
  | { ram: { k: number; w: number; init?: number[] } };

/** Where a wire ends. A branch ends on another wire at a point of its polyline. */
export type EndRef =
  | { part: string; port: string }
  | { pin: string }
  | { label: string }
  | { wire: string; at: Vec };

export interface WireDoc {
  id: string;
  a: EndRef;
  b: EndRef;
  /** Interior corners, from a to b. */
  pts: Vec[];
  /** Optional net name (shown in the inside view, used by `init`). */
  name?: string;
  /** Switch level: the net keeps its charge when undriven (DRAM node, bit line). */
  cap?: boolean;
  /** Power-on value of the net in 'zero' reset mode (a latch's stored bit). */
  init?: 0 | 1;
}

/**
 * A pointer (net label): every label with the same name is the same net, with no wire between
 * them, like the tags on the site's large schematics. `at` is where wires attach; the flag
 * points away from it in direction `face`.
 */
export interface LabelDoc {
  id: string;
  name: string;
  at: Vec;
  face?: ExitDir;
}

// ---------------------------------------------------------------------------------------------
// Helpers shared by compile, ops and the view.

export const emptyChip = (id: string, name: string): ChipDoc => ({ id, name, pins: [], parts: [], wires: [], labels: [] });

export const emptyWorkspace = (): Workspace => {
  const c = emptyChip('u_main', 'Main');
  return { schema: SCHEMA, chips: { [c.id]: c }, open: [c.id] };
};

/** An identifier-safe slug: letters, digits and '_', not starting with a digit. */
export function slug(name: string): string {
  const s = name.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return !s ? 'chip' : /^\d/.test(s) ? `_${s}` : s;
}

/** prefix, prefix_2, prefix_3, ... : the first not in `taken`. */
export function uniqueName(prefix: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  if (!t.has(prefix)) return prefix;
  for (let i = 2; ; i++) if (!t.has(`${prefix}_${i}`)) return `${prefix}_${i}`;
}

/** Next free id with a short prefix: g1, g2, ... */
export function nextId(prefix: string, taken: Iterable<string>): string {
  const t = new Set(taken);
  for (let i = 1; ; i++) if (!t.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

export const isIdent = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);

/** Stable string key of an endpoint (union-find, maps). */
export function endKey(e: EndRef): string {
  if ('part' in e) return `p:${e.part}.${e.port}`;
  if ('pin' in e) return `pin:${e.pin}`;
  if ('label' in e) return `lbl:${e.label}`;
  return `w:${e.wire}@${e.at[0]},${e.at[1]}`;
}

/** Inputs and inouts sit on the left of a chip's box (geometry.ts), so their pins face right. */
export const defaultFace = (p: PinDoc): ExitDir => p.face ?? (p.dir === 'out' ? 'left' : 'right');

/** Resolves a part to its definition (compile supplies it; undefined = unresolved part). */
export type DefOf = (part: PartDoc) => ComponentDef | undefined;

/** Position and exit direction of an endpoint, or null if it does not resolve. */
export function endGeom(doc: ChipDoc, e: EndRef, defOf: DefOf): { pos: Vec; exit: ExitDir | null } | null {
  if ('part' in e) {
    const p = doc.parts.find((q) => q.id === e.part);
    const d = p && defOf(p);
    if (!p || !d || !d.ports.some((q) => q.name === e.port)) return null;
    return instPort(d, p.at, p.flip, e.port);
  }
  if ('pin' in e) {
    const p = doc.pins.find((q) => q.id === e.pin);
    return p ? { pos: p.at, exit: defaultFace(p) } : null;
  }
  if ('label' in e) {
    const l = doc.labels.find((q) => q.id === e.label);
    // A wire enters a label opposite to where its flag points.
    return l ? { pos: l.at, exit: OPP[l.face ?? 'right'] } : null;
  }
  return { pos: e.at, exit: null };
}

const OPP: Record<ExitDir, ExitDir> = { left: 'right', right: 'left', up: 'down', down: 'up' };

/**
 * The full drawn polyline of a wire: a's position, the corners, b's position. A diagonal step
 * gets an L corner (leaving the previous point horizontally), duplicates and collinear middle
 * points are dropped. Null when an end does not resolve.
 */
export function polyline(doc: ChipDoc, w: WireDoc, defOf: DefOf): Vec[] | null {
  const a = endGeom(doc, w.a, defOf);
  const b = endGeom(doc, w.b, defOf);
  if (!a || !b) return null;
  return orthogonal([a.pos, ...w.pts, b.pos]);
}

export function orthogonal(pts: Vec[]): Vec[] {
  const out: Vec[] = [];
  const push = (p: Vec) => {
    const l = out[out.length - 1];
    if (!l || l[0] !== p[0] || l[1] !== p[1]) out.push([p[0], p[1]]);
  };
  for (const p of pts) {
    const l = out[out.length - 1];
    if (l && l[0] !== p[0] && l[1] !== p[1]) push([p[0], l[1]]);
    push(p);
  }
  for (let i = out.length - 2; i >= 1; i--) {
    const [a, b, c] = [out[i - 1], out[i], out[i + 1]];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) out.splice(i, 1);
  }
  return out;
}

/** True if p lies on the polyline (orthogonal segments). */
export function onPolyline(pts: Vec[], p: Vec): boolean {
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    if (a[0] === b[0] && p[0] === a[0] && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1])) return true;
    if (a[1] === b[1] && p[1] === a[1] && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])) return true;
  }
  return false;
}

/** Chips this chip places directly. */
export function chipDeps(doc: ChipDoc): string[] {
  return [...new Set(doc.parts.flatMap((p) => ('chip' in p.ref ? [p.ref.chip] : [])))];
}
