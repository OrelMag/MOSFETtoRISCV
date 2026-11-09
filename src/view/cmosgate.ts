// Working gates (settings.workingGates, with cartoon parts): a library gate drawn as what makes it work, inside its own
// outline. NOT, NAND and NOR as their static CMOS stages (PMOS from VDD, NMOS to ground), AND and OR as that stage plus
// an inverter, XOR and XNOR as their four NANDs (twelve transistors would not fit). DOM-free: the layout is a list of
// primitives in a reference frame per kind (2-input gates 4 × 4, the inverter 3.2 × 4), mapped onto the real body by
// `place`; `solve` gives each inner net its level from the gate's input bits. view/cmosdraw.ts draws and paints them;
// tests/cmosgate.test.ts checks every primitive lies inside the body and every solve against the gate's function.

import type { Vec } from '../sim/geometry';
import { B0, B1, type Bit } from '../sim/types';

/** The gates drawn this way, by library id (relay and NMOS NANDs share the symbol, not the circuit). */
export const CMOS_GATES = new Set(['not', 'nand', 'nor', 'and', 'or', 'xor', 'xnor']);
export type CmosKind = 'not' | 'nand' | 'nor' | 'and' | 'or' | 'xor' | 'xnor';

/** A net's level: from VDD, from ground, reached by neither (holds its charge), or unknown (an X input). */
export type Level = 'hi' | 'lo' | 'float' | 'x';

export type Prim =
  | { t: 'wire'; net: string; d: string; pts: Vec[]; segs: Vec[][] }
  | { t: 'dot'; net: string; at: Vec }
  | { t: 'rail'; kind: 'hi' | 'lo'; x1: number; x2: number; y: number }
  /** A MOSFET: channel vertical at x from y1 to y2, gate plate on `side` (-1 left, 1 right); lit by `net` when on. */
  | { t: 'fet'; dev: string; x: number; y1: number; y2: number; p: boolean; side: -1 | 1; net: string }
  /** A small NAND (XOR's bricks): top-left (x, y), height s; its output net colours the bubble. */
  | { t: 'mini'; x: number; y: number; s: number; out: string };

export interface CmosLayout {
  kind: CmosKind;
  /** Reference frame: body width (to the bubble) and height. */
  bw: number;
  h: number;
  prims: Prim[];
  /** The output wire, from the last stage to the body's right edge (its last x is replaced by the real edge). */
  out: Vec[];
  outNet: string;
}

const HOP = 0.09;
const p2 = (v: number) => +v.toFixed(3);
/** The back curve of the OR family at height y (0 for the others), in a 4-high body. */
export function backX(kind: string, y: number, h = 4): number {
  if (!kind.includes('or')) return 0;
  const t = y / h;
  return (kind.startsWith('x') ? 0.45 : 0) + 0.55 * 2 * t * (1 - t);
}

/** Builds one layout: wires keep their bound points (hops included) for the bounds test. */
class Sheet {
  prims: Prim[] = [];
  wire(net: string, segs: Vec[][], hops: { at: Vec; vertical: boolean }[] = []): void {
    let d = '';
    const pts: Vec[] = [];
    for (const s of segs) {
      d += `M${p2(s[0][0])},${p2(s[0][1])}`;
      for (let i = 1; i < s.length; i++) {
        const [x0, y0] = s[i - 1], [x, y] = s[i];
        // hops on this segment, in travel order
        const on = hops.filter((h) => (x0 === x && h.vertical && h.at[0] === x && between(h.at[1], y0, y)) || (y0 === y && !h.vertical && h.at[1] === y && between(h.at[0], x0, x)))
          .sort((a, b) => Math.abs(a.at[0] - x0) + Math.abs(a.at[1] - y0) - Math.abs(b.at[0] - x0) - Math.abs(b.at[1] - y0));
        for (const h of on) {
          if (x0 === x) {
            const dir = Math.sign(y - y0);
            d += ` V${p2(h.at[1] - dir * HOP)} A${HOP},${HOP} 0 0 ${dir < 0 ? 1 : 0} ${p2(x)},${p2(h.at[1] + dir * HOP)}`;
            pts.push([x + HOP, h.at[1]]);
          } else {
            const dir = Math.sign(x - x0);
            d += ` H${p2(h.at[0] - dir * HOP)} A${HOP},${HOP} 0 0 ${dir > 0 ? 1 : 0} ${p2(h.at[0] + dir * HOP)},${p2(y)}`;
            pts.push([h.at[0], y - HOP]);
          }
        }
        d += x0 === x ? ` V${p2(y)}` : y0 === y ? ` H${p2(x)}` : ` L${p2(x)},${p2(y)}`;
      }
      pts.push(...s);
      d += ' ';
    }
    this.prims.push({ t: 'wire', net, d: d.trim(), pts, segs });
  }
  dot(net: string, x: number, y: number): void { this.prims.push({ t: 'dot', net, at: [x, y] }); }
  rail(kind: 'hi' | 'lo', x1: number, x2: number, y: number): void { this.prims.push({ t: 'rail', kind, x1, x2, y }); }
  fet(dev: string, x: number, y1: number, y2: number, p: boolean, side: -1 | 1, net: string): void { this.prims.push({ t: 'fet', dev, x, y1, y2, p, side, net }); }
}
const between = (v: number, a: number, b: number) => v > Math.min(a, b) && v < Math.max(a, b);

// ---- stages (positions from the approved mockup, docs in the commit) ----

/** NAND at x0, inputs arriving at (xin, 1) and (xin, 3) on nets ia / ib. Output tap returned. */
function nand(sh: Sheet, st: string, x0: number, xin: number, ia: string, ib: string): Vec {
  const Pa = x0 + 1.05, Pb = x0 + 2.05, ba = x0 + 0.4, bb = x0 + 0.62, bx = x0 + 1.6;
  sh.rail('hi', Pa - 0.3, Pb + 0.25, 0.4); sh.rail('lo', Pb - 0.25, Pb + 0.25, 3.5);
  sh.wire('vdd', [[[Pa, 0.4], [Pa, 0.65]], [[Pb, 0.4], [Pb, 0.65]]]);
  sh.wire(st + '.out', [[[Pa, 1.35], [Pa, 1.55], [Pb, 1.55], [Pb, 1.35]], [[Pb, 1.55], [Pb, 1.95]], [[Pb, 1.75], [Pb + 0.4, 1.75]]]);
  sh.wire(st + '.mid', [[[Pb, 2.45], [Pb, 2.75]]]);
  sh.wire('gnd', [[[Pb, 3.25], [Pb, 3.5]]]);
  // a: straight to Pa's gate, and down to Na's
  sh.wire(ia, [[[xin, 1], [Pa - 0.25, 1]], [[ba, 1], [ba, 2.2], [Pb - 0.25, 2.2]]]); sh.dot(ia, ba, 1);
  // b: straight to Nb's gate, and up (two hops) between the PMOS to Pb's
  sh.wire(ib, [[[xin, 3], [Pb - 0.25, 3]], [[bb, 3], [bb, 1.75], [bx, 1.75], [bx, 1], [Pb - 0.25, 1]]],
    [{ at: [bb, 2.2], vertical: true }, { at: [bx, 1.55], vertical: true }]);
  sh.dot(ib, bb, 3);
  sh.fet(st + '.Pa', Pa, 0.65, 1.35, true, -1, st + '.out');
  sh.fet(st + '.Pb', Pb, 0.65, 1.35, true, -1, st + '.out');
  sh.fet(st + '.Na', Pb, 1.95, 2.45, false, -1, st + '.mid');
  sh.fet(st + '.Nb', Pb, 2.75, 3.25, false, -1, st + '.mid');
  return [Pb + 0.4, 1.75];
}
/** NOR at x0 (column c = x0 + 1.4). Output tap at (c + 0.5, 2). */
function nor(sh: Sheet, st: string, x0: number, xin: number, ia: string, ib: string): Vec {
  const c = x0 + 1.4, L = c - 0.5, R = c + 0.5, ba = x0 + 0.5, bv = c + 0.25;
  sh.rail('hi', c - 0.2, c + 0.2, 0.58); sh.rail('lo', L - 0.15, R + 0.1, 3.15);
  sh.wire('vdd', [[[c, 0.58], [c, 0.7]]]);
  sh.wire(st + '.mid', [[[c, 1.3], [c, 1.45]]]);
  sh.wire(st + '.out', [[[c, 1.95], [c, 2]], [[L, 2.2], [L, 2], [R, 2], [R, 2.2]]]);
  sh.wire('gnd', [[[L, 2.8], [L, 3.15]], [[R, 2.8], [R, 3.15]]]);
  sh.wire(ia, [[[xin, 1], [c - 0.25, 1]], [[ba, 1], [ba, 2.5], [L - 0.25, 2.5]]]); sh.dot(ia, ba, 1);
  // b: along the bottom (hop over Na's ground lead), up between the NMOS (hop over the output bus) to Pb's gate on the right
  sh.wire(ib, [[[xin, 3], [bv, 3], [bv, 1.7]]], [{ at: [L, 3], vertical: false }, { at: [bv, 2], vertical: true }]);
  sh.dot(ib, bv, 2.5);
  sh.fet(st + '.Pa', c, 0.7, 1.3, true, -1, st + '.mid');
  sh.fet(st + '.Pb', c, 1.45, 1.95, true, 1, st + '.out');
  sh.fet(st + '.Na', L, 2.2, 2.8, false, -1, st + '.out');
  sh.fet(st + '.Nb', R, 2.2, 2.8, false, -1, st + '.out');
  return [R, 2];
}
/** Inverter at column c, input arriving at (xin, yin) on net ia. Output tap (c, 2). */
function inv(sh: Sheet, st: string, c: number, xin: number, yin: number, ia: string, yT: number, yB: number, half = 0.25): Vec {
  const q1 = yT + 0.18, q2 = 1.62, n1 = 2.38, n2 = yB - 0.18, pm = (q1 + q2) / 2, nm = (n1 + n2) / 2, bus = c - 0.42;
  sh.rail('hi', c - half, c + half, yT); sh.rail('lo', c - half, c + half, yB);
  sh.wire('vdd', [[[c, yT], [c, q1]]]); sh.wire('gnd', [[[c, n2], [c, yB]]]);
  sh.wire(st + '.out', [[[c, q2], [c, n1]]]);
  sh.wire(ia, [[[xin, yin], [bus, yin]], [[bus, pm], [bus, nm]], [[bus, pm], [c - 0.25, pm]], [[bus, nm], [c - 0.25, nm]]]); sh.dot(ia, bus, yin);
  sh.fet(st + '.P', c, q1, q2, true, -1, st + '.out');
  sh.fet(st + '.N', c, n1, n2, false, -1, st + '.out');
  return [c, 2];
}
/** XOR's four NANDs (n1 = a NAND b, n2 = a NAND n1, n3 = b NAND n1, y = n2 NAND n3), mini bricks of height s. */
function xorBricks(sh: Sheet, kind: string, bw: number, s: number): Vec {
  const W = 0.95 * s, O = W + 0.22 * s; // body width, output pin offset (past the bubble)
  const x1 = backX(kind, 2) + 0.17, m1x = x1 + 0.15, bus = m1x + O + 0.1, m2x = bus + 0.12, n2x = m2x + O + 0.08, m4x = n2x + 0.1;
  const c2 = 1.05, c3 = 2.95;
  const pin = (x: number, cy: number) => ({ a: [x, cy - 0.23 * s] as Vec, b: [x, cy + 0.23 * s] as Vec, o: [x + O, cy] as Vec });
  const m1 = pin(m1x, 2), m2 = pin(m2x, c2), m3 = pin(m2x, c3), m4 = pin(m4x, 2);
  const xa = backX(kind, 1), xb = backX(kind, 3);
  sh.wire('a', [[[xa, 1], [x1, 1], [x1, m1.a[1]], m1.a], [[x1, 1], [m2x - 0.12, 1], [m2x - 0.12, m2.a[1]], m2.a]]); sh.dot('a', x1, 1);
  sh.wire('b', [[[xb, 3], [x1, 3], [x1, m1.b[1]], m1.b], [[x1, 3], [m2x - 0.12, 3], [m2x - 0.12, m3.b[1]], m3.b]]); sh.dot('b', x1, 3);
  sh.wire('n1', [[m1.o, [bus, 2]], [[bus, m2.b[1]], [bus, m3.a[1]]], [[bus, m2.b[1]], m2.b], [[bus, m3.a[1]], m3.a]]); sh.dot('n1', bus, 2);
  sh.wire('n2', [[m2.o, [n2x, c2], [n2x, m4.a[1]], m4.a]]);
  sh.wire('n3', [[m3.o, [n2x, c3], [n2x, m4.b[1]], m4.b]]);
  for (const [x, cy, out] of [[m1x, 2, 'n1'], [m2x, c2, 'n2'], [m2x, c3, 'n3'], [m4x, 2, 'x']] as const)
    sh.prims.push({ t: 'mini', x, y: cy - s / 2, s, out });
  void bw;
  return m4.o;
}

const memo = new Map<CmosKind, CmosLayout>();
/** The layout of a kind in its reference frame. */
export function cmosLayout(kind: CmosKind): CmosLayout {
  let l = memo.get(kind);
  if (l) return l;
  const sh = new Sheet();
  let tap: Vec, outNet: string, bw = 4;
  if (kind === 'not') { bw = 3.2; tap = inv(sh, 's1', 1.05, 0, 2, 'a', 0.95, 3.05); outNet = 's1.out'; }
  else if (kind === 'nand') { bw = 3.4; tap = nand(sh, 's1', 0, 0, 'a', 'b'); outNet = 's1.out'; }
  else if (kind === 'nor') { bw = 3.4; tap = nor(sh, 's1', 0, backX(kind, 1), 'a', 'b'); outNet = 's1.out'; }
  else if (kind === 'and') {
    const t1 = nand(sh, 's1', -0.15, 0, 'a', 'b');
    tap = inv(sh, 's2', 3.0, t1[0], t1[1], 's1.out', 0.62, 3.38); outNet = 's2.out';
  } else if (kind === 'or') {
    const t1 = nor(sh, 's1', 0, backX(kind, 1), 'a', 'b');
    tap = inv(sh, 's2', 2.45, t1[0], t1[1], 's1.out', 0.95, 2.9, 0.17); outNet = 's2.out';
  } else { bw = kind === 'xor' ? 4 : 3.4; tap = xorBricks(sh, kind, bw, kind === 'xor' ? 0.62 : 0.48); outNet = 'x'; }
  const out: Vec[] = tap[1] === 2 ? [tap, [bw, 2]] : [tap, [tap[0], 2], [bw, 2]];
  l = { kind, bw, h: 4, prims: sh.prims, out, outNet };
  memo.set(kind, l);
  return l;
}

/** The map from the reference frame onto a real body (width bw to the bubble, height h). */
export interface Placement { sx: number; sy: number; oy: number }
export function place(l: CmosLayout, bw: number, h: number): Placement {
  if (l.kind === 'not') { const s = Math.min(bw / l.bw, h / l.h); return { sx: s, sy: s, oy: (h - s * l.h) / 2 }; }
  // two-input gates keep their input rows (y = 1, 3 on a 4-high body): only the width may shrink
  return { sx: Math.min(1, bw / l.bw), sy: 1, oy: 0 };
}

// ---- solving ----

interface Dev { id: string; p: boolean; gate: string; d: string; s: string }
const NAND_DEVS = (st: string, a: string, b: string): Dev[] => [
  { id: st + '.Pa', p: true, gate: a, d: st + '.out', s: 'vdd' }, { id: st + '.Pb', p: true, gate: b, d: st + '.out', s: 'vdd' },
  { id: st + '.Na', p: false, gate: a, d: st + '.out', s: st + '.mid' }, { id: st + '.Nb', p: false, gate: b, d: st + '.mid', s: 'gnd' }];
const NOR_DEVS = (st: string, a: string, b: string): Dev[] => [
  { id: st + '.Pa', p: true, gate: a, d: st + '.mid', s: 'vdd' }, { id: st + '.Pb', p: true, gate: b, d: st + '.out', s: st + '.mid' },
  { id: st + '.Na', p: false, gate: a, d: st + '.out', s: 'gnd' }, { id: st + '.Nb', p: false, gate: b, d: st + '.out', s: 'gnd' }];
const INV_DEVS = (st: string, a: string): Dev[] => [
  { id: st + '.P', p: true, gate: a, d: st + '.out', s: 'vdd' }, { id: st + '.N', p: false, gate: a, d: st + '.out', s: 'gnd' }];

export interface CmosState {
  /** Every inner net's level (vdd / gnd included). */
  nets: Record<string, Level>;
  /** Devices: 1 conducting, 0 off, 2 unknown. */
  on: Record<string, 0 | 1 | 2>;
}
const lv = (b: Bit): Level => (b === B1 ? 'hi' : b === B0 ? 'lo' : 'x');

/** Solve one stage's devices given its gate nets' levels (switch level, no time: a static CMOS stage). */
function solveStage(devs: Dev[], nets: Record<string, Level>, on: Record<string, 0 | 1 | 2>): void {
  for (const d of devs) {
    const g = nets[d.gate];
    on[d.id] = g === 'x' || g === 'float' ? 2 : (g === 'hi') !== d.p ? 1 : 0;
  }
  const reach = (from: string, sure: boolean) => {
    const seen = new Set([from]), q = [from];
    while (q.length) {
      const n = q.shift()!;
      for (const d of devs) {
        if (!(on[d.id] === 1 || (!sure && on[d.id] === 2))) continue;
        for (const [x, y] of [[d.d, d.s], [d.s, d.d]]) if (x === n && !seen.has(y) && y !== 'vdd' && y !== 'gnd') { seen.add(y); q.push(y); }
      }
    }
    return seen;
  };
  const up = reach('vdd', true), dn = reach('gnd', true), upMay = reach('vdd', false), dnMay = reach('gnd', false);
  for (const d of devs) for (const n of [d.d, d.s]) {
    if (n === 'vdd' || n === 'gnd') continue;
    nets[n] = up.has(n) && dn.has(n) ? 'x' : up.has(n) && !dnMay.has(n) ? 'hi' : dn.has(n) && !upMay.has(n) ? 'lo' : upMay.has(n) || dnMay.has(n) ? 'x' : 'float';
  }
}

/** The inner state of a gate for input bits (in port order: a, b). */
export function cmosSolve(kind: CmosKind, ins: Bit[]): CmosState {
  const nets: Record<string, Level> = { vdd: 'hi', gnd: 'lo', a: lv(ins[0] ?? B0), b: lv(ins[1] ?? B0) };
  const on: Record<string, 0 | 1 | 2> = {};
  if (kind === 'not') solveStage(INV_DEVS('s1', 'a'), nets, on);
  else if (kind === 'nand') solveStage(NAND_DEVS('s1', 'a', 'b'), nets, on);
  else if (kind === 'nor') solveStage(NOR_DEVS('s1', 'a', 'b'), nets, on);
  else if (kind === 'and' || kind === 'or') {
    solveStage((kind === 'and' ? NAND_DEVS : NOR_DEVS)('s1', 'a', 'b'), nets, on);
    solveStage(INV_DEVS('s2', 's1.out'), nets, on);
  } else {
    const nandL = (x: Level, y: Level): Level => (x === 'lo' || y === 'lo' ? 'hi' : x === 'hi' && y === 'hi' ? 'lo' : 'x');
    nets.n1 = nandL(nets.a, nets.b); nets.n2 = nandL(nets.a, nets.n1); nets.n3 = nandL(nets.b, nets.n1); nets.x = nandL(nets.n2, nets.n3);
  }
  return { nets, on };
}
/** The level on the gate's output pin (after the bubble for XNOR, whose bricks compute XOR). */
export function cmosOutput(kind: CmosKind, st: CmosState): Level {
  const l = st.nets[cmosLayout(kind).outNet];
  return kind === 'xnor' ? (l === 'hi' ? 'lo' : l === 'lo' ? 'hi' : l) : l;
}
