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

const MIRROR: Record<ExitDir, ExitDir> = { left: 'right', right: 'left', up: 'up', down: 'down' };

/** Absolute position and exit direction of an instance port. */
export function instPort(def: ComponentDef, at: Vec, flip: boolean | undefined, portName: string): PortGeom {
  const g = symbolGeom(def);
  const p = g.ports[portName];
  if (!p) throw new Error(`${def.id}: no geometry for port '${portName}'`);
  const x = flip ? g.w - p.pos[0] : p.pos[0];
  return { pos: [at[0] + x, at[1] + p.pos[1]], exit: flip ? MIRROR[p.exit] : p.exit };
}
