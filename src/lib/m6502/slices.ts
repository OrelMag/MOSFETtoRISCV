// Bit-sliced placement for the 6502's register-like blocks (BlockSpec.place 'slices', the eyes pass's C5). A register is N
// identical rows: each bit's gate, pass transistor and storage cell sit level on one row, left to right in the order the signal
// goes, bit 0 on top; a bus that enters or leaves bit by bit is a splitter / merger whose pitch is the row pitch, so every bit
// line is a straight wire; a control line that feeds one column of every row is one vertical trunk beside it. What does not
// fit (a second bus on the same side, a gate shared by every row, the rails) stands below the rows with its nets as labels.
// Layout only: instance names, nets and their ends are the block's own.

import { orientGeom, type Rot } from '../../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../../sim/types';
import { merger, splitter } from '../define';
import type { BlockSpec } from './ckt';

interface Placed { name: string; def: ComponentDef; label?: string }

/** Width of a label as the router draws it, plus its stub (ckt.ts tagLen). */
const tagW = (name: string) => 1.4 + name.length * 0.48 + 0.9;
const ones = (w: number) => Array(w).fill(1);
const inst = (e: string): string | null => (e.includes('.') ? e.slice(0, e.indexOf('.')) : null);
const portOf = (e: string): string => e.slice(e.indexOf('.') + 1);
const VGAP = 3;

interface Bar { port: PortDef; name: string; side: 'left' | 'right'; bit: string[]; sinkPort: string[] }

export function layoutSlices(spec: BlockSpec, placed0: Placed[], nets: NetDef[], sliceOf: Map<string, number>,
  bitName: (port: string, i: number) => string): { pins: Record<string, [number, number]>; instances: InstanceDef[]; nets: NetDef[] } {
  const placed = placed0.map((p) => ({ ...p }));
  const byName = new Map(placed.map((p) => [p.name, p]));
  const idx = new Map(placed.map((p, i) => [p.name, i]));
  const rot = new Map<string, 1 | 2 | 3>(), flip = new Map<string, boolean>();
  const geo = (n: string) => orientGeom(byName.get(n)!.def, flip.get(n), rot.get(n));
  const exits = (n: string) => new Set(Object.values(geo(n).ports).map((p) => p.exit));
  const portY = (n: string, p: string) => geo(n).ports[p].pos[1];
  // a pass transistor reads left to right: drain on the left, source on the right, the gate on a side
  for (const p of placed) {
    if (!p.name.startsWith('pass') || !sliceOf.has(p.name)) continue;
    for (const r of [0, 3, 1, 2] as Rot[]) {
      const g = orientGeom(p.def, false, r || undefined);
      if (g.ports.d?.exit === 'left' && g.ports.s?.exit === 'right') { if (r) rot.set(p.name, r as 1 | 2 | 3); break; }
    }
  }
  const sliceIds = [...new Set(sliceOf.values())].sort((a, b) => a - b);
  const members = new Map<number, string[]>(sliceIds.map((s) => [s, placed.filter((p) => sliceOf.get(p.name) === s).map((p) => p.name)]));

  // columns inside a slice: longest path over the signal edges (driver first; an edge runs forward in insertion order, which cuts loops)
  type Edge = { from: string; fp: string; tp: string };
  const preds = new Map<string, Edge[]>(placed.map((p) => [p.name, []]));
  for (const n of nets) {
    const bySlice = new Map<number, string[]>();
    for (const e of n.ends) { const i = inst(e); const s = i === null ? undefined : sliceOf.get(i); if (s !== undefined) { if (!bySlice.has(s)) bySlice.set(s, []); bySlice.get(s)!.push(e); } }
    for (const es of bySlice.values()) {
      const d = es[0];
      if (d !== n.ends[0]) continue;
      for (const e of es.slice(1)) if (inst(e) !== inst(d) && idx.get(inst(d)!)! < idx.get(inst(e)!)!) preds.get(inst(e)!)!.push({ from: inst(d)!, fp: portOf(d), tp: portOf(e) });
    }
  }
  const depth = new Map<string, number>();
  for (const p of placed) if (sliceOf.has(p.name)) depth.set(p.name, Math.max(-1, ...preds.get(p.name)!.map((e) => depth.get(e.from)!)) + 1);
  const D = Math.max(0, ...[...depth.values()]) + 1;

  // rows inside a slice: each part level with the part feeding it, stacked when two share a column
  const local = new Map<string, number>();
  for (const s of sliceIds) {
    const ms = members.get(s)!;
    for (let c = 0; c < D; c++) {
      let free = 0, prev: string | null = null;
      for (const n of ms) {
        if (depth.get(n) !== c) continue;
        const ps = preds.get(n)!;
        const aim = ps.length ? Math.round(ps.reduce((a, e) => a + local.get(e.from)! + portY(e.from, e.fp) - portY(n, e.tp), 0) / ps.length) : free;
        const top = Math.max(aim, prev ? free + (exits(n).has('up') ? 3 : 0) : 0);
        local.set(n, top);
        free = top + geo(n).h + VGAP + (exits(n).has('down') ? 3 : 0);
        prev = n;
      }
    }
    const lo = Math.min(0, ...ms.map((n) => local.get(n)!));
    if (lo < 0) for (const n of ms) local.set(n, local.get(n)! - lo);
  }

  // buses that run bit by bit: bit k's net touches only slice k, on one side, so a bar of pitch P is level with the rows
  const nameOfNet = new Map(nets.map((n) => [n.name, n]));
  const bars: Bar[] = [];
  const taken = new Set<string>();
  for (const p of spec.ports) {
    const bn = `${p.name}_bits`;
    if (p.width === 1 || !byName.has(bn) || p.width !== sliceIds.length) continue;
    const bit: string[] = [], sinkPort: string[] = [];
    let side: string | null = null, ok = true;
    for (let k = 0; k < p.width && ok; k++) {
      const n = nameOfNet.get(bitName(p.name, k));
      const others = (n?.ends ?? []).filter((e) => inst(e) !== bn);
      if (!n || !others.length || others.some((e) => inst(e) === null || sliceOf.get(inst(e)!) !== sliceIds[k])) { ok = false; break; }
      bit.push(n.ends.find((e) => inst(e) === bn)!);
      sinkPort.push(others[0]);
      const ex = geo(inst(others[0])!).ports[portOf(others[0])].exit;
      const sd = ex === 'left' ? 'left' : ex === 'right' ? 'right' : null;
      if (k === 0) side = sd; else if (sd !== side) ok = false;
    }
    if (!ok || !side || taken.has(side)) continue;
    taken.add(side);
    bars.push({ port: p, name: bn, side: side as 'left' | 'right', bit, sinkPort });
  }
  const leftBar = bars.find((b) => b.side === 'left'), rightBar = bars.find((b) => b.side === 'right');
  // slices shifted so the first bar's port is level across them (an AOI is taller than a NAND, its input sits lower)
  const lead = leftBar ?? rightBar;
  const anchor = (b: Bar, k: number) => local.get(inst(b.sinkPort[k])!)! + portY(inst(b.sinkPort[k])!, portOf(b.sinkPort[k]));
  const shift = new Map<number, number>();
  if (lead) {
    const K = Math.max(...sliceIds.map((_, k) => anchor(lead, k)));
    sliceIds.forEach((s, k) => shift.set(s, K - anchor(lead, k)));
  }
  const height = (s: number) => Math.max(...members.get(s)!.map((n) => local.get(n)! + (shift.get(s) ?? 0) + geo(n).h));
  const P = Math.max(...sliceIds.map(height)) + VGAP;
  // the bars as parts of pitch P (names and ports as before)
  for (const b of bars) {
    const dirIn = b.port.dir === 'in';
    const def = dirIn ? splitter(ones(b.port.width), P) : merger(ones(b.port.width), P);
    byName.get(b.name)!.def = def;
    placed.find((p) => p.name === b.name)!.def = def;
    const exit = orientGeom(def, false, undefined).ports[dirIn ? 'o0' : 'i0'].exit;
    if (exit !== (b.side === 'left' ? 'right' : 'left')) flip.set(b.name, true);
  }
  const isBar = (n: string) => bars.some((b) => b.name === n);
  // fallback bars (a second bus on the side, or a bus that is not bit by bit): flipped so their pin side is free
  for (const p of spec.ports) {
    const bn = `${p.name}_bits`;
    if (byName.has(bn) && !isBar(bn) && p.dir !== 'out' && p.dir !== 'in') flip.set(bn, true);
  }

  const ctl = spec.ports.filter((p) => p.width === 1 && p.dir !== 'out');
  const outs1 = spec.ports.filter((p) => p.width === 1 && p.dir === 'out');
  const base = Math.max(6, 2 * ctl.length + 4, 2 * outs1.length + 4);
  // what is left of the parts stands below the rows, or above them (spec.top: a PLA's input bars)
  const rightSided = (n: string) => spec.ports.some((q) => `${q.name}_bits` === n && q.dir === 'out');
  const leftExtras = placed.filter((p) => !sliceOf.has(p.name) && !isBar(p.name) && !rightSided(p.name));
  const exGap = spec.top ? 3 : 8;
  const bandBase = spec.top ? base + leftExtras.reduce((a, p) => a + geo(p.name).h + exGap, 0) + 4 : base;
  // rows of their own height when no bus is held to the row pitch
  const cum: number[] = [];
  { let y = bandBase; for (const s of sliceIds) { cum.push(y); y += height(s) + VGAP + 2; } cum.push(y); }
  const sliceTop = (s: number) => (bars.length ? bandBase + sliceIds.indexOf(s) * P : cum[sliceIds.indexOf(s)]);
  const bandEnd = bars.length ? bandBase + sliceIds.length * P : cum[sliceIds.length];

  // control lines that feed one column of every row: a trunk beside the column
  const colOf = (n: string) => depth.get(n)! + 1;
  const trunkNets = new Map<string, number>(); // net name → column
  for (const n of nets) {
    const d0 = n.ends[0], sinks = n.ends.slice(1);
    const pinDrv = inst(d0) === null && ctl.some((p) => p.name === d0);
    const barDrv = inst(d0) !== null && !sliceOf.has(inst(d0)!) && spec.ports.some((p) => `${p.name}_bits` === inst(d0)) && !isBar(inst(d0)!);
    if (!(pinDrv || barDrv) || n.ends.filter((e) => inst(e) === null).length !== (pinDrv ? 1 : 0) || sinks.length < 3) continue;
    if (!sinks.every((e) => sliceOf.has(inst(e)!) && geo(inst(e)!).ports[portOf(e)].exit !== 'right')) continue;
    const cols = new Set(sinks.map((e) => colOf(inst(e)!)));
    if (cols.size !== 1 || new Set(sinks.map((e) => sliceOf.get(inst(e)!))).size < 2) continue;
    trunkNets.set(n.name!, [...cols][0]);
  }

  const lay = (leftRoom: number[], rightRoom: number[]) => {
    const colW = new Array<number>(D + 2).fill(0);
    if (leftBar) colW[0] = geo(leftBar.name).w;
    if (rightBar) colW[D + 1] = geo(rightBar.name).w;
    for (const [n, d] of depth) colW[d + 1] = Math.max(colW[d + 1], geo(n).w);
    const trunksInto = (c: number) => [...trunkNets.values()].filter((x) => x === c).length;
    const xs = [8];
    for (let c = 0; c <= D; c++) xs.push(xs[c] + colW[c] + Math.max(spec.gap ?? 5, Math.ceil(rightRoom[c] + leftRoom[c + 1] + 1) + (trunksInto(c + 1) ? trunksInto(c + 1) + 2 : 0)));
    const at = new Map<string, [number, number]>();
    for (const s of sliceIds) for (const n of members.get(s)!) at.set(n, [xs[colOf(n)], sliceTop(s) + (shift.get(s) ?? 0) + local.get(n)!]);
    const xRight = xs[D + 1] + colW[D + 1] + 6;
    const pins: Record<string, [number, number]> = {};
    // bars level with the rows
    for (const b of bars) {
      const g = geo(b.name), k0 = geo(inst(b.sinkPort[0])!);
      void k0;
      const bitP = g.ports[portOf(b.bit[0])].pos[1];
      const sinkY = at.get(inst(b.sinkPort[0])!)![1] + portY(inst(b.sinkPort[0])!, portOf(b.sinkPort[0]));
      at.set(b.name, [b.side === 'left' ? xs[0] : xs[D + 1], sinkY - bitP]);
      const main = g.ports[b.port.dir === 'in' ? 'in' : 'out'];
      pins[b.port.name] = [b.side === 'left' ? 0 : xRight, at.get(b.name)![1] + main.pos[1]];
    }
    // what is left stands below the rows
    let yl = spec.top ? base : bandEnd + 3, yr = spec.top ? base : bandEnd + 3;
    for (const p of placed) {
      if (at.has(p.name) || sliceOf.has(p.name)) continue;
      const g = geo(p.name);
      const right = rightSided(p.name);
      if (right) { at.set(p.name, [xs[D + 1], yr]); yr += g.h + exGap; } else { at.set(p.name, [xs[0], yl]); yl += g.h + exGap; }
      const q = spec.ports.find((r) => `${r.name}_bits` === p.name);
      if (q) {
        const main = g.ports[q.dir === 'in' ? 'in' : 'out'];
        pins[q.name] = [right ? xRight : 0, at.get(p.name)![1] + main.pos[1]];
      }
    }
    // an output pin on a net with nothing else: level with its driver, pushed down where two meet
    const levelOuts: string[] = [];
    for (const p of outs1) {
      const n = nets.find((x) => x.ends.includes(p.name));
      if (n && n.ends.length === 2 && inst(n.ends[0]) !== null && sliceOf.has(inst(n.ends[0])!)) {
        const q = geo(inst(n.ends[0])!).ports[portOf(n.ends[0])].pos[1] + at.get(inst(n.ends[0])!)![1];
        pins[p.name] = [xRight, q]; levelOuts.push(p.name);
      }
    }
    levelOuts.sort((a, b) => pins[a][1] - pins[b][1]);
    levelOuts.forEach((p, i) => { if (i && pins[p][1] < pins[levelOuts[i - 1]][1] + 2) pins[p][1] = pins[levelOuts[i - 1]][1] + 2; });
    let i1 = 0, o1 = 0;
    for (const p of spec.ports) {
      if (pins[p.name]) continue;
      if (p.dir === 'out') pins[p.name] = [xRight, 2 + 2 * o1++]; else pins[p.name] = [0, 2 + 2 * i1++];
    }
    const endPos = (e: string): [number, number] => {
      const n = inst(e);
      if (!n) return pins[e];
      const p = geo(n).ports[portOf(e)].pos;
      return [at.get(n)![0] + p[0], at.get(n)![1] + p[1]];
    };
    // wires where one reads well: a pin straight into its bar, a short forward net; trunks for shared controls; labels otherwise
    const kind = new Map<NetDef, 'wire' | 'tag' | 'trunk'>();
    // trunks of a column left to right in the order their drivers stand bottom to top, so no run crosses another's trunk
    const trunkIdx = new Map<string, number>();
    for (const col of new Set(trunkNets.values())) {
      nets.filter((n) => trunkNets.get(n.name!) === col).sort((a, b) => endPos(b.ends[0])[1] - endPos(a.ends[0])[1]).forEach((n, j) => trunkIdx.set(n.name!, j));
    }
    const out: NetDef[] = nets.map((n) => {
      let k: 'wire' | 'tag' | 'trunk' = 'tag';
      const pinEnds = n.ends.filter((e) => inst(e) === null);
      if (trunkNets.has(n.name!)) k = 'trunk';
      else if (pinEnds.length) {
        const o = n.ends.filter((e) => inst(e) !== null);
        if (outs1.some((q) => q.name === pinEnds[0]) && n.ends.length === 2 && inst(n.ends[0]) !== null && sliceOf.has(inst(n.ends[0])!)) k = 'wire';
        else if (n.ends.length === 2 && o.length === 1 && o[0].endsWith(spec.ports.find((q) => q.name === pinEnds[0])?.dir === 'in' ? '.in' : '.out') && spec.ports.some((q) => `${q.name}_bits` === inst(o[0]))) k = 'wire';
      } else if (n.ends.length <= 5 && n.ends.every((e) => sliceOf.has(inst(e)!) || isBar(inst(e)!)) && (spec.across !== false || new Set(n.ends.map((e) => sliceOf.get(inst(e)!)).filter((x) => x !== undefined)).size <= 1) && !/^(rails?|vdd|gnd)$/i.test(n.name ?? '')) {
        const d = endPos(n.ends[0]);
        if (n.ends.slice(1).every((e) => { const q = endPos(e); return q[0] >= d[0] - 2 && Math.abs(q[0] - d[0]) + Math.abs(q[1] - d[1]) <= 45; })) k = 'wire';
      }
      kind.set(n, k);
      if (k === 'tag') return { ...n, tags: true as const };
      const w = { ...n }; delete w.tags;
      if (k === 'wire') return w;
      const col = trunkNets.get(n.name!)!;
      const j = trunkIdx.get(n.name!)!;
      return { ...w, trunk: xs[col] - Math.ceil(leftRoom[col]) - 1.5 - (trunksInto(col) - 1 - j) };
    });
    const instances: InstanceDef[] = placed.map((p) => ({ name: p.name, def: p.def, at: at.get(p.name), label: p.label, flip: flip.get(p.name), rot: rot.get(p.name) }));
    return { pins, instances, nets: out, kind };
  };
  // the labels' room, from which nets came out as labels
  let res = lay(new Array(D + 2).fill(0), new Array(D + 2).fill(0));
  for (let pass = 0; pass < 3; pass++) {
    const left = new Array<number>(D + 2).fill(0), right = new Array<number>(D + 2).fill(0);
    for (const n of res.nets) {
      if (n.tags !== true) continue;
      for (const e of n.ends) {
        const i = inst(e); if (!i || !at0(i)) continue;
        const ex = geo(i).ports[portOf(e)].exit;
        const c = sliceOf.has(i) ? colOf(i) : isBar(i) ? (bars.find((b) => b.name === i)!.side === 'left' ? 0 : D + 1) : -1;
        if (c < 0) continue;
        const w = tagW(n.name ?? '');
        if (ex === 'right') right[c] = Math.max(right[c], w); else if (ex === 'left') left[c] = Math.max(left[c], w);
      }
    }
    const next = lay(left, right);
    const same = JSON.stringify(next.nets.map((n) => !!n.tags)) === JSON.stringify(res.nets.map((n) => !!n.tags));
    res = next;
    if (same && pass) break;
  }
  function at0(i: string): boolean { return byName.has(i); }
  return { pins: res.pins, instances: res.instances, nets: res.nets };
}
