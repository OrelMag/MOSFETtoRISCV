// Pointer pairs that a wire reads better as (DOM-free). A drawn example (a Sheet, docFromDef's drawing) names every connection with a
// pointer at each end; where a driver and a sink are close and a clear path joins them, that pair becomes one wire (the sink's pointer
// goes; the driver's stays while other sinks still read the net by name, else it goes too). Only pointers hung on one wire to a part
// port or a pin are touched; a path must leave each port the way its port faces, pass through no part, lie along no other net's wire and
// cross at most `maxCross` of them. The nets, their ends and the simulation are unchanged.

import type { ChipDoc, DefOf, EndRef, ExitDir, WireDoc } from './model';
import { endGeom, orthogonal, polyline } from './model';
import { partBox } from './geom';
import type { Vec } from '../sim/geometry';

export interface WirePointersOptions {
  /** The longest Manhattan distance between the two ends that is still drawn as a wire (grid units). */
  maxDist?: number;
  /** Crossings of other nets a new wire may make. */
  maxCross?: number;
  /** Names to leave as pointers (clocks, long feedback). */
  keep?: (name: string) => boolean;
}

type Seg = { a: Vec; b: Vec };
type Lab = ChipDoc['labels'][number];
type Hook = { label: Lab; stub: WireDoc; end: EndRef };

const isEnd = (e: EndRef) => 'part' in e || 'pin' in e;
const DIR: Record<ExitDir, Vec> = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };

function segsOf(pl: Vec[]): Seg[] {
  const out: Seg[] = [];
  for (let i = 0; i + 1 < pl.length; i++) out.push({ a: pl[i], b: pl[i + 1] });
  return out;
}

/** Collinear overlap of length > 0 between two axis-parallel segments. */
function overlaps(s: Seg, t: Seg): boolean {
  const sh = s.a[1] === s.b[1], th = t.a[1] === t.b[1];
  if (sh !== th) return false;
  const k = sh ? 1 : 0, m = sh ? 0 : 1;
  if (s.a[k] !== t.a[k]) return false;
  return Math.min(Math.max(s.a[m], s.b[m]), Math.max(t.a[m], t.b[m])) - Math.max(Math.min(s.a[m], s.b[m]), Math.min(t.a[m], t.b[m])) > 0;
}

/** Perpendicular segments that meet (a crossing, or a touch that would read as a junction). */
function meets(s: Seg, t: Seg): boolean {
  const sh = s.a[1] === s.b[1], th = t.a[1] === t.b[1];
  if (sh === th) return false;
  const [h, v] = sh ? [s, t] : [t, s];
  const [hx0, hx1] = [Math.min(h.a[0], h.b[0]), Math.max(h.a[0], h.b[0])];
  const [vy0, vy1] = [Math.min(v.a[1], v.b[1]), Math.max(v.a[1], v.b[1])];
  return v.a[0] >= hx0 && v.a[0] <= hx1 && h.a[1] >= vy0 && h.a[1] <= vy1;
}

/** Replace close driver / sink pointer pairs by wires; returns a new document (the input is untouched) and how many wires were made. */
export function wirePointers(doc: ChipDoc, defOf: DefOf, opts: WirePointersOptions = {}): { doc: ChipDoc; wired: number } {
  const maxDist = opts.maxDist ?? 16, maxCross = opts.maxCross ?? 0;
  const byName = new Map<string, Lab[]>();
  for (const l of doc.labels) byName.set(l.name, [...(byName.get(l.name) ?? []), l]);
  const boxes = doc.parts.map((p) => partBox(defOf(p), p.at, p.flip, p.rot));
  let wires: WireDoc[] = doc.wires.map((w) => ({ ...w }));
  let labels = doc.labels.slice();
  // live segments of every wire, by wire id
  const segsById = new Map<string, Seg[]>();
  for (const w of wires) { const pl = polyline(doc, w, defOf); if (pl) segsById.set(w.id, segsOf(pl)); }
  const refd = new Set<string>();
  for (const w of wires) for (const e of [w.a, w.b]) if ('wire' in e) refd.add(e.wire);

  // an end that drives its net: an output port, or an input pin
  const drives = (e: EndRef): boolean => {
    if ('pin' in e) return doc.pins.find((p) => p.id === e.pin)?.dir === 'in';
    if ('part' in e) { const p = doc.parts.find((q) => q.id === e.part); return !!p && defOf(p)?.ports.find((q) => q.name === e.port)?.dir === 'out'; }
    return false;
  };
  const stubOf = (l: Lab) => wires.filter((w) => ('label' in w.a && w.a.label === l.id) || ('label' in w.b && w.b.label === l.id));
  const far = (w: WireDoc, l: Lab): EndRef => ('label' in w.a && w.a.label === l.id ? w.b : w.a);
  const hooks = new Map<string, Hook[]>();
  for (const [name, ls] of byName) {
    if (ls.length < 2 || opts.keep?.(name)) continue;
    const hs: Hook[] = [];
    for (const l of ls) {
      const st = stubOf(l);
      if (st.length !== 1 || refd.has(st[0].id)) continue;
      const e = far(st[0], l);
      if (isEnd(e) && endGeom(doc, e, defOf)) hs.push({ label: l, stub: st[0], end: e });
    }
    if (hs.length >= 2) hooks.set(name, hs);
  }
  type Pair = { name: string; d: Hook; k: Hook; dist: number };
  const pairs: Pair[] = [];
  for (const [name, hs] of hooks) {
    const shared = byName.get(name)!.length > 2;
    for (const d of hs) {
      if (shared && !drives(d.end)) continue;
      for (const k of hs) {
        if (k === d || (shared && drives(k.end))) continue;
        if (!shared && !drives(d.end) && drives(k.end)) continue;   // a plain pair: the driver first
        const g1 = endGeom(doc, d.end, defOf)!, g2 = endGeom(doc, k.end, defOf)!;
        const dist = Math.abs(g1.pos[0] - g2.pos[0]) + Math.abs(g1.pos[1] - g2.pos[1]);
        if (dist <= maxDist) pairs.push({ name, d, k, dist });
      }
    }
  }
  pairs.sort((x, y) => x.dist - y.dist);

  let wired = 0;
  const usedDriver = new Set<string>(), gone = new Set<string>();
  const sameNet = (id: string, name: string): boolean => {
    const w = wires.find((q) => q.id === id);
    return !!w && [w.a, w.b].some((e) => 'label' in e && labels.find((l) => l.id === e.label)?.name === name);
  };
  for (const it of pairs) {
    if (gone.has(it.k.label.id) || gone.has(it.d.label.id) || usedDriver.has(it.d.label.id)) continue;
    const g1 = endGeom(doc, it.d.end, defOf)!, g2 = endGeom(doc, it.k.end, defOf)!;
    const A = g1.pos, B = g2.pos;
    const mine = [it.d.stub.id, it.k.stub.id];
    const cands: Vec[][] = [[]];
    if (A[0] !== B[0] && A[1] !== B[1]) {
      cands.push([[B[0], A[1]]], [[A[0], B[1]]]);
      const [x0, x1] = [Math.min(A[0], B[0]) - 3, Math.max(A[0], B[0]) + 3], [y0, y1] = [Math.min(A[1], B[1]) - 3, Math.max(A[1], B[1]) + 3];
      for (let x = x0; x <= x1; x += 0.5) cands.push([[x, A[1]], [x, B[1]]]);
      for (let y = y0; y <= y1; y += 0.5) cands.push([[A[0], y], [B[0], y]]);
    } else {
      // level / plumb but perhaps blocked: try a jog around
      const sx = Math.sign(B[0] - A[0]), sy = Math.sign(B[1] - A[1]);
      for (let d = -3; d <= 3; d += 0.5) if (d) {
        if (A[1] === B[1]) cands.push([[A[0] + sx, A[1]], [A[0] + sx, A[1] + d], [B[0] - sx, A[1] + d], [B[0] - sx, B[1]]]);
        else cands.push([[A[0], A[1] + sy], [A[0] + d, A[1] + sy], [A[0] + d, B[1] - sy], [B[0], B[1] - sy]]);
      }
    }
    let best: { pts: Vec[]; cost: number; pl: Vec[] } | null = null;
    for (const pts of cands) {
      const pl = orthogonal([A, ...pts, B]);
      if (pl.length < 2) continue;
      // leaves each port the way it faces (a pin or a bare point faces nowhere)
      const lead = (g: { pos: Vec; exit: ExitDir | null }, to: Vec) => {
        if (!g.exit) return true;
        const d = DIR[g.exit];
        return Math.sign(to[0] - g.pos[0]) === d[0] && Math.sign(to[1] - g.pos[1]) === d[1];
      };
      if (!lead(g1, pl[1]) || !lead(g2, pl[pl.length - 2])) continue;
      const segs = segsOf(pl);
      let bad = false, cross = 0;
      for (const sg of segs) {
        const [x0, x1] = [Math.min(sg.a[0], sg.b[0]), Math.max(sg.a[0], sg.b[0])];
        const [y0, y1] = [Math.min(sg.a[1], sg.b[1]), Math.max(sg.a[1], sg.b[1])];
        for (const bx of boxes) if (x1 > bx.x + 0.01 && x0 < bx.x + bx.w - 0.01 && y1 > bx.y + 0.01 && y0 < bx.y + bx.h - 0.01) { bad = true; break; }
        if (bad) break;
        for (const [id, os] of segsById) {
          if (mine.includes(id) || sameNet(id, it.name)) continue;
          for (const o of os) {
            if (overlaps(sg, o)) { bad = true; break; }
            if (meets(sg, o)) cross++;
          }
          if (bad) break;
        }
        if (bad) break;
        for (const l of labels) {
          if (l.name === it.name) continue;
          // the pill: its flag runs out from `at` the way it faces, about 0.7 units a letter and 2.5 for the ends
          const w = l.name.length * 0.7 + 2.5, f = DIR[l.face ?? 'right'];
          const [lx0, lx1] = f[0] ? [Math.min(l.at[0], l.at[0] + f[0] * w), Math.max(l.at[0], l.at[0] + f[0] * w)] : [l.at[0] - 1.2, l.at[0] + 1.2];
          const [ly0, ly1] = f[1] ? [Math.min(l.at[1], l.at[1] + f[1] * w), Math.max(l.at[1], l.at[1] + f[1] * w)] : [l.at[1] - 1.2, l.at[1] + 1.2];
          if (lx1 >= x0 && lx0 <= x1 && ly1 >= y0 && ly0 <= y1) { bad = true; break; }
        }
        if (bad) break;
        for (const p of doc.pins) {
          if (p.at[0] > x0 && p.at[0] < x1 && p.at[1] === sg.a[1] && sg.a[1] === sg.b[1] && !(p.at[0] === A[0] && p.at[1] === A[1]) && !(p.at[0] === B[0] && p.at[1] === B[1])) { bad = true; break; }
        }
      }
      if (bad || cross > maxCross) continue;
      const len = segs.reduce((t, sg) => t + Math.abs(sg.b[0] - sg.a[0]) + Math.abs(sg.b[1] - sg.a[1]), 0);
      const cost = cross * 100 + (pl.length - 2) * 3 + len;
      if (!best || cost < best.cost) best = { pts, cost, pl };
    }
    if (!best) continue;
    // the sink's pointer and stub go; the driver's stays while another label of the name remains
    const dropW = new Set([it.k.stub.id]);
    gone.add(it.k.label.id);
    usedDriver.add(it.d.label.id);
    const remaining = labels.filter((l) => l.name === it.name && !gone.has(l.id));
    if (remaining.length === 1 && remaining[0].id === it.d.label.id) { dropW.add(it.d.stub.id); gone.add(it.d.label.id); }
    const stubs = [it.d.stub, it.k.stub];
    const keepHue = stubs.find((w) => w.hue !== undefined)?.hue;
    const keepName = stubs.find((w) => w.name)?.name;
    wires = wires.filter((w) => !dropW.has(w.id));
    for (const id of dropW) segsById.delete(id);
    let nid = `pw_${it.name}`;
    for (let n = 1; wires.some((w) => w.id === nid); n++) nid = `pw_${it.name}_${n}`;
    const nw: WireDoc = { id: nid, a: it.d.end, b: it.k.end, pts: best.pts, ...(keepHue !== undefined ? { hue: keepHue } : {}), ...(keepName ? { name: keepName } : {}) };
    wires.push(nw);
    segsById.set(nw.id, segsOf(best.pl));
    labels = labels.filter((l) => !gone.has(l.id));
    wired++;
  }
  return { doc: { ...doc, wires, labels }, wired };
}
