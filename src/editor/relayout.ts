// Lay out a chip again by logic depth: an imported drawing (a .dig or .circ file keeps its author's sheet, stretched to our
// boxes) replaced by the placement the Verilog import uses (placedepth.ts), then drawn by docFromDef. Only the geometry
// changes: every part keeps its id, reference and caption, every pin its id, name, kind and value, the connectivity is the
// same (the tests compare connKey). The chip's tests, face, processor and flip-flop marks name pins and parts, not places,
// so they stay; comments are stacked under the new drawing; sections (frames around places) go. DOM-free.

import { compileChip } from './compile';
import { docFromDef } from './fromdef';
import { partBox } from './geom';
import { type ChipDoc, type DefOf, type PartRef, polyline } from './model';
import type { PartResult } from './parts';
import { type Inst, type NetB, placeByDepth } from './placedepth';
import { parseEnd, type ComponentDef, netlistOf } from '../sim/types';
import type { Vec } from '../sim/geometry';

/** Why a chip cannot be laid out again (or null: it can). */
export function relayoutRefusal(doc: ChipDoc, generated: boolean): string | null {
  if (generated) return 'Its drawing is generated (Verilog, a truth table or a state machine): it is laid out when it is made.';
  if (!doc.parts.length) return 'It has no parts to place.';
  if (doc.pins.some((p) => p.dir === 'inout')) return 'It has a bidirectional pin: placing by logic depth needs one driver per net.';
  if (doc.faults?.some((f) => !('pin' in f.target))) return 'It has faults placed on wires: remove them first, the wires are drawn anew.';
  // the processor settings may name a wire by id (cpu.ts NetRef); every wire is new
  if (JSON.stringify(doc.cpu ?? {}).includes('"wire":')) return 'Its processor settings name a wire: set them by pin, pointer or part instead.';
  return null;
}

/** Rounds of crossing reduction (placedepth.ts): measured on the importers' fixtures (tests/relayout.test.ts). */
export const SWEEPS = 4;

export type RelayoutResult = { doc: ChipDoc; dropped: string[] } | { error: string };

/** The chip drawn again by logic depth: a new document (the old one untouched). */
export function relayoutChip(doc: ChipDoc, defOfRef: (ref: PartRef) => PartResult, generated = false): RelayoutResult {
  const no = relayoutRefusal(doc, generated);
  if (no) return { error: no };
  const built = compileChip(doc, defOfRef);
  const err = built.diags.find((d) => d.level === 'error');
  if (err) return { error: `It does not compile: ${err.msg}` };
  if (built.mode !== 'gate') return { error: 'It works at switch level (transistors, shared lines): there is no logic depth to place by.' };
  const def = built.def;
  const nl = netlistOf(def);
  if (!nl) return { error: 'It has no netlist.' };

  const partOf = new Map(doc.parts.map((p) => [p.id, p]));
  const insts: Inst[] = nl.instances.map((i) => {
    const p = partOf.get(i.name)!;
    return { name: i.name, def: i.def, ref: p.ref, ...(p.label ? { label: p.label } : {}), col: 0, y: 0 };
  });
  const byName = new Map(insts.map((i) => [i.name, i]));
  const portOf = (end: string) => {
    const { inst, port } = parseEnd(end);
    return inst === null ? def.ports.find((p) => p.name === port)! : byName.get(inst)!.def.ports.find((p) => p.name === port)!;
  };
  // A driver: a part's output or the chip's input. One per net, or the placement has nothing to go by.
  const isDrv = (end: string) => (parseEnd(end).inst === null ? portOf(end).dir === 'in' : portOf(end).dir === 'out');
  const list: NetB[] = [];
  for (const n of nl.nets) {
    const drv = n.ends.filter(isDrv);
    if (drv.length > 1) return { error: `Net ${n.name ?? n.ends.join(' ')} has ${drv.length} drivers: placing by logic depth needs one.` };
    const d = drv[0] ?? n.ends[0]; // nothing drives it: a pointer from any end
    const sinks = n.ends.filter((e) => e !== d);
    if (sinks.length) list.push({ drv: d, sinks, ...(n.name ? { name: n.name } : {}) });
  }
  // Splitters fed straight from an input pin and mergers feeding only output pins keep to the edges, as the import's do.
  const pinEnd = (e: string) => parseEnd(e).inst === null;
  for (const i of insts) {
    if (i.def.prim !== 'alias') continue;
    const touching = list.filter((n) => n.drv!.startsWith(`${i.name}.`) || n.sinks.some((s) => s.startsWith(`${i.name}.`)));
    const ins = touching.filter((n) => n.sinks.some((s) => s.startsWith(`${i.name}.`)));
    const outs = touching.filter((n) => n.drv!.startsWith(`${i.name}.`));
    if ('split' in i.ref && ins.length === 1 && pinEnd(ins[0].drv!) && ins[0].sinks.length === 1) i.fixed = 'in';
    else if ('merge' in i.ref && outs.length === 1 && outs[0].sinks.every(pinEnd)) i.fixed = 'out';
  }

  const placed = placeByDepth(insts, byName, list, def.ports, { sweeps: SWEEPS });
  const drawn: ComponentDef = { ...def, netlist: () => placed };
  const refs = new Map<ComponentDef, PartRef>();
  for (const i of insts) if (!refs.has(i.def)) refs.set(i.def, i.ref);
  const fresh = docFromDef(drawn, { id: doc.id, name: doc.name, refOf: (d) => refs.get(d) });
  if ('error' in fresh) return { error: fresh.error };

  // Graft the geometry onto the old document: its pins' and parts' identities stay.
  const pinId = new Map(doc.pins.map((p) => [p.name, p.id]));
  const pinAt = new Map(fresh.pins.map((p) => [p.id, p]));
  const pins = doc.pins.map((p) => {
    const n = pinAt.get(p.name)!;
    const { face: _f, ...rest } = p;
    return { ...rest, at: n.at, ...(n.face ? { face: n.face } : {}) };
  });
  const parts = fresh.parts.map((n) => {
    const old = partOf.get(n.id)!;
    const { flip: _f, rot: _r, ...rest } = old;
    return { ...rest, at: n.at, ...(n.flip ? { flip: true } : {}), ...(n.rot ? { rot: n.rot } : {}) };
  });
  const end = <E extends ChipDoc['wires'][number]['a']>(e: E): E => ('pin' in e ? { ...e, pin: pinId.get(e.pin) ?? e.pin } : e);
  const wires = fresh.wires.map((w) => ({ ...w, a: end(w.a), b: end(w.b) }));
  const out: ChipDoc = { ...doc, pins, parts, wires, labels: fresh.labels };
  const dropped: string[] = [];
  delete out.sections;
  if (doc.sections?.length) dropped.push(`${doc.sections.length} section${doc.sections.length > 1 ? 's' : ''} (frames around places that moved)`);
  if (doc.comments?.length) {
    // stacked under the drawing, in their old order top to bottom
    const defOf: DefOf = (p) => { const d = defOfRef(p.ref); return "error" in d ? undefined : d; };
    const bottom = Math.max(0, ...out.pins.map((p) => p.at[1] + 2), ...out.parts.map((p) => { const b = partBox(defOf(p), p.at, p.flip, p.rot); return b.y + b.h; }));
    let y = Math.ceil(bottom) + 3;
    out.comments = [...doc.comments].sort((a, b) => a.at[1] - b.at[1] || a.at[0] - b.at[0]).map((c) => {
      const at: Vec = [0, y];
      y += c.text.split('\n').length * 1.5 + 2;
      return { ...c, at };
    });
  }
  return { doc: out, dropped };
}

/** How a drawing reads: wires of different nets crossing, wire segments through a part they do not end on, total wire length. */
export interface LayoutMetrics { crossings: number; throughParts: number; pointers: number; length: number; width: number; height: number }

/** Measured on the document as drawn (hand-drawn or laid out alike): polylines from model.ts, part boxes from geom.ts. */
export function layoutMetrics(doc: ChipDoc, defOf: DefOf, netOfWire: ReadonlyMap<string, number>): LayoutMetrics {
  type Seg = { a: Vec; b: Vec; net: number; parts: Set<string> };
  const segs: Seg[] = [];
  let length = 0;
  for (const w of doc.wires) {
    const pl = polyline(doc, w, defOf);
    if (!pl) continue;
    const parts = new Set<string>();
    for (const e of [w.a, w.b]) if ('part' in e) parts.add(e.part);
    const net = netOfWire.get(w.id) ?? -1;
    for (let i = 1; i < pl.length; i++) {
      segs.push({ a: pl[i - 1], b: pl[i], net, parts });
      length += Math.hypot(pl[i][0] - pl[i - 1][0], pl[i][1] - pl[i - 1][1]);
    }
  }
  // proper crossings: the two segments' interiors meet at one point
  const cross = (o: Vec, p: Vec, q: Vec) => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
    const s = segs[i], t = segs[j];
    if (s.net < 0 || t.net < 0 || s.net === t.net) continue; // a wire not on a net (broken) counts nothing
    const d1 = cross(t.a, t.b, s.a), d2 = cross(t.a, t.b, s.b), d3 = cross(s.a, s.b, t.a), d4 = cross(s.a, s.b, t.b);
    if (((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))) crossings++;
  }
  // a segment through a part's body (shrunk by half a unit: ports sit on the edge) it does not end on
  let throughParts = 0;
  const boxes = doc.parts.map((p) => ({ id: p.id, b: partBox(defOf(p), p.at, p.flip, p.rot) }));
  for (const s of segs) for (const { id, b } of boxes) {
    if (s.parts.has(id)) continue;
    if (clipsBox(s.a, s.b, b.x + 0.5, b.y + 0.5, b.x + b.w - 0.5, b.y + b.h - 0.5)) { throughParts++; break; }
  }
  const xs = [...doc.pins.map((p) => p.at[0]), ...boxes.flatMap(({ b }) => [b.x, b.x + b.w])];
  const ys = [...doc.pins.map((p) => p.at[1]), ...boxes.flatMap(({ b }) => [b.y, b.y + b.h])];
  return { crossings, throughParts, pointers: doc.labels.length, length: Math.round(length), width: Math.round(Math.max(...xs) - Math.min(...xs)), height: Math.round(Math.max(...ys) - Math.min(...ys)) };
}

/** Does segment a–b pass through the open rectangle (x0, y0)–(x1, y1)? Liang–Barsky. */
function clipsBox(a: Vec, b: Vec, x0: number, y0: number, x1: number, y1: number): boolean {
  if (x1 <= x0 || y1 <= y0) return false;
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]] as const) {
    if (p === 0) { if (q <= 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t1 - t0 > 1e-9;
}
