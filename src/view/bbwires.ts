// The jumpers on the boards (DOM-free, so tests hold them to the netlist): every chip pin, LED and switch on one flat net
// joined by a tree of wires, shortest first and on its own board before it crosses to another; tied-off pins and the
// supply pins to the nearest rail. Nothing is authored: a wire exists because a net does. A net on a bus strip is left
// to the strip's ribbon, and a net whose other end is logic no chip stands for has no partner to reach. On a layout with
// channels (a grid of boards), a net that leaves its board runs like a real harness: from one pin on each board straight
// out to the channel beside it, along that to a trunk of its own in a gutter, never over another board's chips.

import { findNode, type HierNode } from '../sim/flatten';
import { BB, type BbBoard, type BreadboardLayout, netIdOf, planBoard } from './bblayout';

export interface BbWireEnd {
  x: number;
  y: number;
  /** Which way it leaves: up (−1) from a chip's top pin, down (1) from a bottom pin or an indicator. */
  side: -1 | 1;
  board: BbBoard;
  /** An LED or a switch: joined to a harness only where its board has no chip pin on the net. */
  indicator?: boolean;
}

export interface BbWire {
  from: BbWireEnd;
  to: BbWireEnd;
  /** The flat net; -1 for a supply pin. */
  net: number;
  /** 'pos' / 'neg': to a rail (a supply pin or a tied input); a straight stub. */
  rail?: 'pos' | 'neg';
  /** A harness between boards: its path, and the one pin it joins on each board. */
  d?: string;
  joins?: BbWireEnd[];
}

/** Flat nets tied to a constant: tie cells anywhere below the root. */
function tiedNets(root: HierNode): Map<number, 'pos' | 'neg'> {
  const out = new Map<number, 'pos' | 'neg'>();
  const walk = (n: HierNode) => {
    if (n.def.id === 'tie0' || n.def.id === 'tie1') out.set(n.ports.y[0], n.def.id === 'tie1' ? 'pos' : 'neg');
    n.children?.forEach(walk);
  };
  walk(root);
  return out;
}

/** The rail of this kind nearest an end on its board, as an end of its own. */
function railEnd(e: BbWireEnd, kind: 'pos' | 'neg'): BbWireEnd {
  const H = e.board.size[1], top = e.board.at[1] + (kind === 'pos' ? 0.7 : 1.3), bottom = e.board.at[1] + H - (kind === 'pos' ? 0.7 : 1.3);
  return { x: e.x, y: Math.abs(e.y - top) < Math.abs(e.y - bottom) ? top : bottom, side: 1, board: e.board };
}

export function planWires(layout: BreadboardLayout, root: HierNode): BbWire[] {
  const tied = tiedNets(root);
  const strips = new Set<number>();
  for (const b of layout.buses ?? []) for (const net of findNode(root, b.path)?.ports[b.port] ?? []) strips.add(net);
  const ends = new Map<number, BbWireEnd[]>();
  const wires: BbWire[] = [];
  const at = (net: number, e: BbWireEnd) => {
    if (net < 0 || strips.has(net)) return;
    const k = tied.get(net);
    if (k) wires.push({ from: e, to: railEnd(e, k), net, rail: k });
    else ends.set(net, [...(ends.get(net) ?? []), e]);
  };
  for (const b of layout.boards) {
    const plan = planBoard(b), [ox, oy] = b.at;
    b.chips.forEach((c, i) => {
      const node = c.path && findNode(root, c.path), r = plan.chips[i], n = c.dip / 2;
      if (!node) return;
      for (const [k, pin] of Object.entries(c.pins ?? {})) {
        const num = Number(k), bottom = num <= n, col = bottom ? num - 1 : c.dip - num;
        const e: BbWireEnd = { x: ox + r.x + col + 0.5, y: oy + r.y + (bottom ? r.h + 0.5 : -0.5), side: bottom ? 1 : -1, board: b };
        if (pin === 'VCC' || pin === 'GND') wires.push({ from: e, to: railEnd(e, pin === 'VCC' ? 'pos' : 'neg'), net: -1, rail: pin === 'VCC' ? 'pos' : 'neg' });
        else if (pin !== 'NC') at(node.ports[pin.port]?.[pin.bit ?? 0] ?? -1, e);
      }
    });
    (b.leds ?? []).forEach((l, i) => { const r = plan.leds[i]; at(netIdOf(root, l.net), { x: ox + r.x + BB.led / 2, y: oy + r.y, side: -1, board: b, indicator: true }); });
    (b.beside ?? []).forEach((l, i) => { const r = plan.beside[i]; at(netIdOf(root, l.net), { x: ox + r.x + BB.led / 2, y: oy + r.y, side: -1, board: b, indicator: true }); });
    (b.switches ?? []).forEach((w, i) => { const r = plan.switches[i]; at(root.ports[w.port]?.[w.bit ?? 0] ?? -1, { x: ox + r.x + r.w / 2, y: oy + r.y, side: -1, board: b, indicator: true }); });
  }
  const ch = layout.channels;
  const harnesses: { net: number; ports: BbWireEnd[] }[] = [];
  // a tree per net (Prim): the nearest end next, and one on another board only when its own has none left
  for (const [net, whole] of ends) {
    // with channels: a tree per board here, and the boards joined by a harness below
    const groups = ch ? [...new Set(whole.map((e) => e.board))].map((b) => whole.filter((e) => e.board === b)) : [whole];
    if (ch && groups.length > 1) harnesses.push({ net, ports: groups.map((g) => g.find((e) => !e.indicator) ?? g[0]) });
    for (const list of groups) {
    const inTree = [list[0]], rest = list.slice(1);
    while (rest.length) {
      let best = 0, from = inTree[0], cost = Infinity;
      rest.forEach((e, i) => {
        for (const t of inTree) {
          const d = Math.abs(e.x - t.x) + Math.abs(e.y - t.y) + (e.board === t.board ? 0 : 1000);
          if (d < cost) { cost = d; best = i; from = t; }
        }
      });
      const e = rest.splice(best, 1)[0];
      if (e.x !== from.x || e.y !== from.y) wires.push({ from, to: e, net });
      inTree.push(e);
    }
    }
  }
  if (ch) wires.push(...routeHarnesses(harnesses, ch));
  return wires;
}

/** The lowest track free over a span: spans on one track never overlap, so a channel holds as few tracks as it can. */
function tracksFor<T extends { lo: number; hi: number; track?: number }>(spans: T[]): number {
  const ends: number[] = [];
  for (const s of [...spans].sort((a, b) => a.lo - b.lo)) {
    let k = ends.findIndex((e) => e + 0.6 < s.lo);
    if (k < 0) k = ends.push(0) - 1;
    ends[k] = s.hi;
    s.track = k;
  }
  return ends.length;
}

function routeHarnesses(list: { net: number; ports: BbWireEnd[] }[], ch: NonNullable<BreadboardLayout['channels']>): BbWire[] {
  type Stub = { lo: number; hi: number; track?: number; port: BbWireEnd; gap: number };
  type Trunk = { lo: number; hi: number; track?: number; gutter: number; stubs: Stub[]; net: number; ports: BbWireEnd[] };
  const gapOf = (e: BbWireEnd) => (e.side < 0 ? e.board.at[1] - ch.gap : e.board.at[1] + e.board.size[1]);
  const mid = (i: number) => ch.gutters[i].x + ch.gutters[i].w / 2;
  const trunks: Trunk[] = list.map(({ net, ports }) => {
    const mean = ports.reduce((a, e) => a + e.x, 0) / ports.length;
    const gutter = ch.gutters.reduce((best, _, i) => (Math.abs(mid(i) - mean) < Math.abs(mid(best) - mean) ? i : best), 0);
    const stubs = ports.map((port) => {
      const gap = gapOf(port), x = mid(gutter);
      return { lo: Math.min(port.x, x), hi: Math.max(port.x, x), port, gap };
    });
    const ys = stubs.map((s) => s.gap + ch.gap / 2);
    return { lo: Math.min(...ys), hi: Math.max(...ys), gutter, stubs, net, ports };
  });
  // tracks: within each gutter for the trunks, within each channel for the stubs; then the wires, spread to fill their room
  const pitchOf = (n: number, w: number) => Math.min(0.6, w / (n + 1));
  const start = (n: number, w: number, p: number) => (w - p * (n - 1)) / 2;
  const trunkX = new Map<Trunk, number>();
  ch.gutters.forEach((g, i) => {
    const here = trunks.filter((t) => t.gutter === i), n = tracksFor(here), p = pitchOf(n, g.w), s = start(n, g.w, p);
    for (const t of here) trunkX.set(t, g.x + s + t.track! * p);
  });
  const stubY = new Map<Stub, number>();
  for (const gap of new Set(trunks.flatMap((t) => t.stubs.map((s) => s.gap)))) {
    const here = trunks.flatMap((t) => t.stubs.filter((s) => s.gap === gap));
    const n = tracksFor(here), p = pitchOf(n, ch.gap), s = start(n, ch.gap, p);
    for (const st of here) stubY.set(st, gap + s + st.track! * p);
  }
  return trunks.map((t) => {
    const x = trunkX.get(t)!;
    const ys = t.stubs.map((s) => stubY.get(s)!);
    const d = t.stubs.map((s) => `M${s.port.x} ${s.port.y}V${stubY.get(s)}H${x}`).join('') + `M${x} ${Math.min(...ys)}V${Math.max(...ys)}`;
    return { from: t.ports[0], to: t.ports[1], net: t.net, d, joins: t.ports };
  });
}

/** A jumper's path: leaving each end straight, sagging with its length; a stub to a rail is a straight line. */
export function wirePath(w: BbWire): string {
  if (w.d) return w.d;
  const { from: a, to: b } = w;
  if (w.rail) return `M${a.x} ${a.y}L${b.x} ${b.y}`;
  const k = Math.min(3, 0.7 + (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * 0.1);
  return `M${a.x} ${a.y}C${a.x} ${a.y + a.side * k} ${b.x} ${b.y + b.side * k} ${b.x} ${b.y}`;
}

/** A wire's colour as built, 0–5: the net's, so a net keeps its colour along its tree. */
export const wireHue = (net: number): number => ((net * 2654435761) >>> 0) % 6;
