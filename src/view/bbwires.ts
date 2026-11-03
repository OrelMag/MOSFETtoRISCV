// The jumpers on the boards (DOM-free, so tests hold them to the netlist): every chip pin, LED and switch on one flat net
// joined by a tree of wires, shortest first and on its own board before it crosses to another; tied-off pins and the
// supply pins to the nearest rail. Nothing is authored: a wire exists because a net does. A net on a bus strip is left
// to the strip's ribbon, and a net whose other end is logic no chip stands for has no partner to reach.

import { findNode, type HierNode } from '../sim/flatten';
import { BB, type BbBoard, type BreadboardLayout, netIdOf, planBoard } from './bblayout';

export interface BbWireEnd {
  x: number;
  y: number;
  /** Which way it leaves: up (−1) from a chip's top pin, down (1) from a bottom pin or an indicator. */
  side: -1 | 1;
  board: BbBoard;
}

export interface BbWire {
  from: BbWireEnd;
  to: BbWireEnd;
  /** The flat net; -1 for a supply pin. */
  net: number;
  /** 'pos' / 'neg': to a rail (a supply pin or a tied input); a straight stub. */
  rail?: 'pos' | 'neg';
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
    (b.leds ?? []).forEach((l, i) => { const r = plan.leds[i]; at(netIdOf(root, l.net), { x: ox + r.x + BB.led / 2, y: oy + r.y, side: -1, board: b }); });
    (b.beside ?? []).forEach((l, i) => { const r = plan.beside[i]; at(netIdOf(root, l.net), { x: ox + r.x + BB.led / 2, y: oy + r.y, side: -1, board: b }); });
    (b.switches ?? []).forEach((w, i) => { const r = plan.switches[i]; at(root.ports[w.port]?.[w.bit ?? 0] ?? -1, { x: ox + r.x + r.w / 2, y: oy + r.y, side: -1, board: b }); });
  }
  // a tree per net (Prim): the nearest end next, and one on another board only when its own has none left
  for (const [net, list] of ends) {
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
  return wires;
}

/** A jumper's path: leaving each end straight, sagging with its length; a stub to a rail is a straight line. */
export function wirePath(w: BbWire): string {
  const { from: a, to: b } = w;
  if (w.rail) return `M${a.x} ${a.y}L${b.x} ${b.y}`;
  const k = Math.min(3, 0.7 + (Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * 0.1);
  return `M${a.x} ${a.y}C${a.x} ${a.y + a.side * k} ${b.x} ${b.y + b.side * k} ${b.x} ${b.y}`;
}

/** A wire's colour as built, 0–5: the net's, so a net keeps its colour along its tree. */
export const wireHue = (net: number): number => ((net * 2654435761) >>> 0) % 6;
