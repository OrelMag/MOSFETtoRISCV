// Symbol geometry in grid units. Netlist authors place instances by their top-left corner;
// this module says where each port sits and which way a wire leaves it. The renderer and
// the router both use it, so hand-made layouts and drawings always agree.

import type { ComponentDef, PortDef, Side } from './types';

export type Vec = [number, number];
export type ExitDir = 'left' | 'right' | 'up' | 'down';

export interface PortGeom {
  pos: Vec;
  exit: ExitDir;
}

export interface SymbolGeom {
  w: number;
  h: number;
  ports: Record<string, PortGeom>;
}

const GATE2 = new Set(['nand', 'and', 'or', 'nor', 'xor', 'xnor']);
const cache = new WeakMap<ComponentDef, SymbolGeom>();

function sideOf(p: PortDef): Side {
  return p.side ?? (p.dir === 'out' ? 'right' : 'left');
}

function spread(n: number, length: number, pitch = 2): number[] {
  // n pins spaced `pitch` apart, centred on the edge.
  const start = (length - pitch * (n - 1)) / 2;
  return Array.from({ length: n }, (_, i) => start + pitch * i);
}

export function boxSize(def: ComponentDef): { w: number; h: number } {
  const by: Record<Side, PortDef[]> = { left: [], right: [], top: [], bottom: [] };
  for (const p of def.ports) by[sideOf(p)].push(p);
  const label = def.symbol.label ?? def.name;
  const longestPort = Math.max(0, ...by.left.map((p) => p.name.length)) + Math.max(0, ...by.right.map((p) => p.name.length));
  const w = def.symbol.w ?? Math.max(6, 2 * Math.max(by.top.length, by.bottom.length) + 2,
    Math.ceil((label.length * 0.75 + longestPort * 0.6 + 2) / 2) * 2);
  const pitch = def.symbol.pitch ?? 2;
  const h = def.symbol.h ?? Math.max(4, pitch * (Math.max(by.left.length, by.right.length) - 1) + 4);
  return { w, h };
}

export function symbolGeom(def: ComponentDef): SymbolGeom {
  let g = cache.get(def);
  if (g) return g;
  const k = def.symbol.kind;
  const ins = def.ports.filter((p) => p.dir !== 'out');
  const outs = def.ports.filter((p) => p.dir === 'out');
  const ports: Record<string, PortGeom> = {};

  if (GATE2.has(k)) {
    const h = Math.max(4, 2 * ins.length);
    g = { w: 4, h, ports };
    ins.forEach((p, i) => (ports[p.name] = { pos: [0, 1 + 2 * i + (h - 2 * ins.length) / 2], exit: 'left' }));
    ports[outs[0].name] = { pos: [4, h / 2], exit: 'right' };
  } else if (k === 'not' || k === 'buf') {
    g = { w: 3, h: 2, ports };
    ports[ins[0].name] = { pos: [0, 1], exit: 'left' };
    ports[outs[0].name] = { pos: [3, 1], exit: 'right' };
  } else if (k === 'mux') {
    const data = ins.filter((p) => sideOf(p) === 'left');
    const sel = ins.filter((p) => sideOf(p) !== 'left');
    const h = 2 * data.length + 2;
    g = { w: 4, h, ports };
    data.forEach((p, i) => (ports[p.name] = { pos: [0, 2 + 2 * i], exit: 'left' }));
    sel.forEach((p, i) => (ports[p.name] = { pos: [2 + i, h], exit: 'down' }));
    ports[outs[0].name] = { pos: [4, h / 2], exit: 'right' };
  } else if (k === 'split' || k === 'merge') {
    const many = k === 'split' ? outs : ins;
    const one = k === 'split' ? ins[0] : outs[0];
    const pitch = def.symbol.pitch ?? 2;
    const h = pitch * many.length;
    g = { w: 1, h, ports };
    many.forEach((p, i) => (ports[p.name] = { pos: [k === 'split' ? 1 : 0, pitch / 2 + pitch * i], exit: k === 'split' ? 'right' : 'left' }));
    ports[one.name] = { pos: [k === 'split' ? 0 : 1, h / 2], exit: k === 'split' ? 'left' : 'right' };
  } else if (k === 'nmos' || k === 'pmos') {
    // ports in order: gate, top terminal, bottom terminal
    const [gp, top, bot] = def.ports;
    g = { w: 3, h: 4, ports };
    ports[gp.name] = { pos: [0, 2], exit: 'left' };
    ports[top.name] = { pos: [3, 0], exit: 'up' };
    ports[bot.name] = { pos: [3, 4], exit: 'down' };
  } else if (k === 'dep') {
    // a depletion load: the channel's two ends (gate tied to the bottom one, drawn inside)
    g = { w: 3, h: 4, ports };
    ports[def.ports[0].name] = { pos: [3, 0], exit: 'up' };
    ports[def.ports[1].name] = { pos: [3, 4], exit: 'down' };
  } else if (k === 'res') {
    // vertical, like a transistor's channel: first port on top, second at the bottom
    g = { w: 2, h: 4, ports };
    ports[def.ports[0].name] = { pos: [1, 0], exit: 'up' };
    ports[def.ports[1].name] = { pos: [1, 4], exit: 'down' };
  } else if (k === 'pullup') {
    // a rail on top, the resistor below it, the node at the bottom
    g = { w: 2, h: 4, ports };
    ports[def.ports[0].name] = { pos: [1, 4], exit: 'down' };
  } else if (k === 'pulldown') {
    g = { w: 2, h: 4.5, ports };
    ports[def.ports[0].name] = { pos: [1, 0], exit: 'up' };
  } else if (k === 'cap') {
    // the node on top, the other plate on GND
    g = { w: 2, h: 3.5, ports };
    ports[def.ports[0].name] = { pos: [1, 0], exit: 'up' };
  } else if (k === 'tgate') {
    // ports in order: a (left), b (right), en (top), en_n (bottom)
    const [a, b, en, enb] = def.ports;
    g = { w: 4, h: 4, ports };
    ports[a.name] = { pos: [0, 2], exit: 'left' };
    ports[b.name] = { pos: [4, 2], exit: 'right' };
    ports[en.name] = { pos: [2, 0], exit: 'up' };
    ports[enb.name] = { pos: [2, 4], exit: 'down' };
  } else if (k === 'tribuf' || k === 'triinv') {
    // a buffer / inverter triangle with its enable on top
    const en = ins.find((p) => p.name === 'en') ?? ins[1];
    const a = ins.find((p) => p !== en)!;
    g = { w: 4, h: 4, ports };
    ports[a.name] = { pos: [0, 2], exit: 'left' };
    ports[en.name] = { pos: [2, 0], exit: 'up' };
    ports[outs[0].name] = { pos: [4, 2], exit: 'right' };
  } else if (k === 'relay') {
    // ports in order: the coil's ends a (left), b (down, usually to GND); then per pole c (up), no, nc (down): the coil
    // on the left, each pole a column to its right, the break contact (nc) left of the make contact (no) under it
    const [a, b, ...poles] = def.ports;
    const n = poles.length / 3;
    g = { w: 3 * n + 2, h: 4, ports };
    ports[a.name] = { pos: [0, 1], exit: 'left' };
    ports[b.name] = { pos: [1, 4], exit: 'down' };
    for (let i = 0; i < n; i++) {
      const x = poleX(i);
      ports[poles[3 * i].name] = { pos: [x, 0], exit: 'up' };
      ports[poles[3 * i + 1].name] = { pos: [x + 1, 4], exit: 'down' };
      ports[poles[3 * i + 2].name] = { pos: [x - 1, 4], exit: 'down' };
    }
  } else if (k === 'triode' || k === 'diode') {
    // a tube: plate (anode) on top, cathode at the bottom, a triode's grid on the left
    g = { w: 4, h: 4, ports };
    const [first, ...rest] = def.ports;
    const [p, c] = k === 'triode' ? rest : [first, rest[0]];
    if (k === 'triode') ports[first.name] = { pos: [0, 2], exit: 'left' };
    ports[p.name] = { pos: [2, 0], exit: 'up' };
    ports[c.name] = { pos: [2, 4], exit: 'down' };
  } else if (k === 'vdd') {
    g = { w: 2, h: 1, ports };
    ports[def.ports[0].name] = { pos: [1, 1], exit: 'down' };
  } else if (k === 'gnd') {
    g = { w: 2, h: 1.5, ports };
    ports[def.ports[0].name] = { pos: [1, 0], exit: 'up' };
  } else {
    const { w, h } = boxSize(def);
    g = { w, h, ports };
    const by: Record<Side, PortDef[]> = { left: [], right: [], top: [], bottom: [] };
    for (const p of def.ports) by[sideOf(p)].push(p);
    const pitch = def.symbol.pitch ?? 2;
    spread(by.left.length, h, pitch).forEach((y, i) => (ports[by.left[i].name] = { pos: [0, y], exit: 'left' }));
    spread(by.right.length, h, pitch).forEach((y, i) => (ports[by.right[i].name] = { pos: [w, y], exit: 'right' }));
    spread(by.top.length, w).forEach((x, i) => (ports[by.top[i].name] = { pos: [x, 0], exit: 'up' }));
    spread(by.bottom.length, w).forEach((x, i) => (ports[by.bottom[i].name] = { pos: [x, h], exit: 'down' }));
    for (const [name, v] of Object.entries(def.symbol.portPos ?? {})) {
      const pg = ports[name];
      if (!pg) continue;
      if (pg.exit === 'left' || pg.exit === 'right') pg.pos = [pg.pos[0], v];
      else pg.pos = [v, pg.pos[1]];
    }
  }
  cache.set(def, g);
  return g;
}

/** x of a relay symbol's pole i: its common contact on top, nc one unit left and no one unit right below it. */
export const poleX = (i: number) => 4 + 3 * i;

const MIRROR: Record<ExitDir, ExitDir> = { left: 'right', right: 'left', up: 'up', down: 'down' };
const CW: Record<ExitDir, ExitDir> = { right: 'down', down: 'left', left: 'up', up: 'right' };

/** Quarter turns clockwise (0: as drawn). An instance is mirrored first (flip), then turned. */
export type Rot = 0 | 1 | 2 | 3;

/** A symbol-local point of a w × h symbol, mirrored then turned; the result is relative to the turned box's top-left. */
export function orientPoint(p: Vec, w: number, h: number, flip: boolean | undefined, rot: Rot | undefined): Vec {
  const x = flip ? w - p[0] : p[0], y = p[1];
  switch (rot ?? 0) {
    case 1: return [h - y, x];
    case 2: return [w - x, h - y];
    case 3: return [y, w - x];
    default: return [x, y];
  }
}

export function orientExit(d: ExitDir, flip: boolean | undefined, rot: Rot | undefined): ExitDir {
  let e = flip ? MIRROR[d] : d;
  for (let i = 0; i < (rot ?? 0); i++) e = CW[e];
  return e;
}

/** Side of a box after mirroring and turning (the side a port sits on, as its exit). */
export function orientSide(s: Side, flip: boolean | undefined, rot: Rot | undefined): Side {
  const e = orientExit(s === 'top' ? 'up' : s === 'bottom' ? 'down' : s, flip, rot);
  return e === 'up' ? 'top' : e === 'down' ? 'bottom' : e;
}

const oriented = new WeakMap<ComponentDef, SymbolGeom[]>();

/** The symbol's geometry as placed: its box (w and h swap on a quarter turn) and every port, mirrored then turned. */
export function orientGeom(def: ComponentDef, flip: boolean | undefined, rot: Rot | undefined): SymbolGeom {
  const g = symbolGeom(def);
  if (!flip && !rot) return g;
  const k = (flip ? 4 : 0) + (rot ?? 0);
  let all = oriented.get(def);
  if (!all) oriented.set(def, (all = []));
  if (all[k]) return all[k];
  const ports: Record<string, PortGeom> = {};
  for (const [n, p] of Object.entries(g.ports)) ports[n] = { pos: orientPoint(p.pos, g.w, g.h, flip, rot), exit: orientExit(p.exit, flip, rot) };
  const odd = (rot ?? 0) % 2 === 1;
  return (all[k] = { w: odd ? g.h : g.w, h: odd ? g.w : g.h, ports });
}

/** Symbol kinds with a drawing of their own; every other kind is a box (symbolGeom's last case). */
const DRAWN = new Set([...GATE2, 'not', 'buf', 'mux', 'split', 'merge', 'nmos', 'pmos', 'dep', 'res', 'pullup', 'pulldown', 'cap',
  'tgate', 'tribuf', 'triinv', 'relay', 'triode', 'diode', 'vdd', 'gnd']);
export const isBoxKind = (def: ComponentDef) => !DRAWN.has(def.symbol.kind);

const boxes = new WeakMap<ComponentDef, ComponentDef[]>();

/**
 * A box mirrored and turned, as a box of its own: every port on its new side at its new place (symbol.portPos), w and
 * h swapped on a quarter turn. Drawn upright (boxText lays its names out again), so the text reads however the
 * part is turned; its symbolGeom equals orientGeom(def, flip, rot). For drawing and layout only: simulate `def`.
 */
export function orientedBox(def: ComponentDef, flip: boolean | undefined, rot: Rot | undefined): ComponentDef {
  if (!flip && !rot) return def;
  const k = (flip ? 4 : 0) + (rot ?? 0);
  let all = boxes.get(def);
  if (!all) boxes.set(def, (all = []));
  if (all[k]) return all[k];
  const g = symbolGeom(def), o = orientGeom(def, flip, rot);
  const portPos: Record<string, number> = {};
  const ports = def.ports.map((p) => {
    const q = o.ports[p.name];
    portPos[p.name] = q.exit === 'left' || q.exit === 'right' ? q.pos[1] : q.pos[0];
    return { ...p, side: orientSide(sideOf(p), flip, rot) };
  });
  // A chip's face displays stay upright, centred where their middle lands (face.ts shownBox).
  const keepOut = def.symbol.keepOut?.map((r) => {
    const [cx, cy] = orientPoint([r.x + r.w / 2, r.y + r.h / 2], g.w, g.h, flip, rot);
    return { x: cx - r.w / 2, y: cy - r.h / 2, w: r.w, h: r.h };
  });
  const odd = (rot ?? 0) % 2 === 1;
  // A quarter turn puts the side pins on top and bottom: their names run across, and a long label stands up.
  const label = def.symbol.label ?? def.name;
  const vertical = odd ? (def.symbol.verticalLabel ? false : label.length * 1.05 * 0.58 > o.w - 0.6 && o.h > o.w) : def.symbol.verticalLabel;
  return (all[k] = {
    ...def,
    ports,
    symbol: { ...def.symbol, w: o.w, h: o.h, portPos, ...(keepOut ? { keepOut } : {}), verticalLabel: vertical || undefined, ...(odd ? { turned: true } : {}) },
  });
}

const frac = (v: number) => v - Math.floor(v);

/**
 * Top-left corner for a part (mirrored, turned) centred on `c`, chosen so its ports land on integer grid points (wires
 * drawn on the grid then meet them exactly). Symbols whose ports sit on half units shift by that half (for most of
 * their ports, when they disagree).
 */
export function centredAt(def: ComponentDef, c: Vec, flip?: boolean, rot?: Rot): Vec {
  const g = orientGeom(def, flip, rot);
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

/** Absolute position and exit direction of an instance port. */
export function instPort(def: ComponentDef, at: Vec, flip: boolean | undefined, portName: string, rot?: Rot): PortGeom {
  const p = orientGeom(def, flip, rot).ports[portName];
  if (!p) throw new Error(`${def.id}: no geometry for port '${portName}'`);
  return { pos: [at[0] + p.pos[0], at[1] + p.pos[1]], exit: p.exit };
}
