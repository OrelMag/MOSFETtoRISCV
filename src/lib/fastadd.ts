// Faster adders: generate/propagate, carry-lookahead and the parallel-prefix adders (primer §4.4,
// §4.6): Kogge–Stone, Brent–Kung and Sklansky, one drawing for all three. Carries are computed in
// O(log n) gate delays instead of O(n).

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { mask } from '../sim/values';
import { andN } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, XOR } from './gates';
import { bitwise, orN } from './wide';
import { NAND } from './transistors';


const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** g = a·b (this bit generates a carry), p = a ⊕ b (it propagates one). Five NANDs, shared like the half adder. */
export const GP_CELL: ComponentDef = define({
  id: 'gp', name: 'Generate / propagate', category: 'arithmetic',
  summary: 'g = a AND b: this column creates a carry by itself. p = a XOR b: it passes an incoming carry on. The half adder, renamed.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('g', 'out'), bit('p', 'out')],
  symbol: { kind: 'box', label: 'gp', w: 4, h: 3, portPos: { a: 1, b: 2, g: 1, p: 2 } },
  spec: ([a, b]) => [a & b, a ^ b],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 11], p: [27, 7], g: [27, 15] },
    instances: [
      { name: 'g1', def: NAND, at: [6, 4] }, { name: 'g2', def: NAND, at: [13, 1] }, { name: 'g3', def: NAND, at: [13, 8] },
      { name: 'g4', def: NAND, at: [20, 5] }, { name: 'g5', def: NAND, at: [20, 13] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'g2.a', 'g1.a'], trunk: 3 }, { name: 'b', ends: ['b', 'g3.b', 'g1.b'], trunk: 4 },
      { name: 'm', ends: ['g1.y', 'g2.b', 'g3.a', 'g5.a', 'g5.b'] },
      { ends: ['g2.y', 'g4.a'] }, { ends: ['g3.y', 'g4.b'] },
      { name: 'p', ends: ['g4.y', 'p'] }, { name: 'g', ends: ['g5.y', 'g'] },
    ],
  }),
});

/** Gray cell: G = g + p·gl. Three NANDs, two levels deep. */
export const GRAY_CELL: ComponentDef = define({
  id: 'graycell', name: 'Gray prefix cell', category: 'arithmetic',
  summary: 'Combines a group (g, p) with the group below it (gl): G = g + p·gl. Used where the result already reaches bit 0, so its propagate is never needed.',
  ports: [bit('g', 'in'), bit('p', 'in'), bit('gl', 'in'), bit('go', 'out')],
  symbol: { kind: 'box', label: '◐', w: 4, h: 4, portPos: { g: 1, p: 2, gl: 3, go: 1 } },
  spec: ([g, p, gl]) => [g | (p & gl)],
  netlist: () => ({
    pins: { g: [1, 2], p: [1, 6], gl: [1, 8], go: [19, 5] },
    instances: [{ name: 'ng', def: NAND, at: [5, 0] }, { name: 'n1', def: NAND, at: [5, 5] }, { name: 'og', def: NAND, at: [12, 3] }],
    nets: [
      { name: 'g', ends: ['g', 'ng.a', 'ng.b'] }, { name: 'p', ends: ['p', 'n1.a'] }, { name: 'gl', ends: ['gl', 'n1.b'] },
      { name: 'g_n', ends: ['ng.y', 'og.a'] }, { name: 'pgl_n', ends: ['n1.y', 'og.b'] }, { name: 'go', ends: ['og.y', 'go'] },
    ],
  }),
  hdl: { verilog: 'assign go = g | (p & gl);   // = ~(~g & ~(p & gl)): three NANDs' },
});

/** Black cell: G = g + p·gl, P = p·pl. Five NANDs. */
export const BLACK_CELL: ComponentDef = define({
  id: 'blackcell', name: 'Black prefix cell', category: 'arithmetic',
  summary: 'Combines group (g, p) with the group below it (gl, pl) into one bigger group: G = g + p·gl, P = p·pl. The operator is associative, which is what lets a prefix network compute all carries in parallel.',
  ports: [bit('g', 'in'), bit('p', 'in'), bit('gl', 'in'), bit('pl', 'in'), bit('go', 'out'), bit('po', 'out')],
  symbol: { kind: 'box', label: '●', w: 4, h: 5, portPos: { g: 1, p: 2, gl: 3, pl: 4, go: 1, po: 2 } },
  spec: ([g, p, gl, pl]) => [g | (p & gl), p & pl],
  netlist: () => ({
    pins: { g: [1, 2], p: [1, 6], gl: [1, 8], pl: [1, 13], go: [19, 5], po: [19, 12] },
    instances: [
      { name: 'ng', def: NAND, at: [5, 0] }, { name: 'n1', def: NAND, at: [5, 5] }, { name: 'og', def: NAND, at: [12, 3] },
      { name: 'pg', def: AND, at: [12, 10] },
    ],
    nets: [
      { name: 'g', ends: ['g', 'ng.a', 'ng.b'] }, { name: 'p', ends: ['p', 'n1.a', 'pg.a'], trunk: 3 }, { name: 'gl', ends: ['gl', 'n1.b'] },
      { name: 'pl', ends: ['pl', 'pg.b'] }, { name: 'g_n', ends: ['ng.y', 'og.a'] }, { name: 'pgl_n', ends: ['n1.y', 'og.b'] },
      { name: 'go', ends: ['og.y', 'go'] }, { name: 'po', ends: ['pg.y', 'po'] },
    ],
  }),
  hdl: { verilog: 'assign go = g | (p & gl);\nassign po = p & pl;' },
});

/**
 * 4-bit carry-lookahead adder: every carry is a two-level AND-OR of g, p and cin,
 * c_k = g_{k-1} + p_{k-1}·g_{k-2} + … + p_{k-1}…p_0·cin.
 */
export const CLA4: ComponentDef = (() => {
  const R = 4; // rail spacing
  const rails = ['c0', 'g0', 'p0', 'g1', 'p1', 'g2', 'p2', 'g3', 'p3'];
  const railX = (name: string) => 22 + 2 * rails.indexOf(name);
  const XA = 22 + 2 * rails.length + 3; // AND column
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(4), R * 2), at: [3, 0] },
    { name: 'sb', def: splitter(ones(4), R * 2), at: [6, 1] },
  ];
  const railEnds = new Map<string, string[]>(rails.map((r) => [r, []]));
  railEnds.get('c0')!.push('cin');
  const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] }];
  for (let i = 0; i < 4; i++) {
    instances.push({ name: `gp${i}`, def: GP_CELL, at: [11, 2 * R * i + 3] });
    nets.push({ ends: [`sa.o${i}`, `gp${i}.a`] }, { ends: [`sb.o${i}`, `gp${i}.b`] });
    railEnds.get(`g${i}`)!.unshift(`gp${i}.g`);
    railEnds.get(`p${i}`)!.unshift(`gp${i}.p`);
  }
  let y = 2;
  const XO = XA + 9, XS = XO + 10;
  const sumEnds: string[] = [];
  for (let k = 1; k <= 4; k++) {
    const terms: string[] = [];
    const ors = orN(k + 1);
    const orIns = ors.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    const yTop = y;
    for (let j = 0; j < k; j++) {
      // term j: p_{k-1} … p_j · (j == 0 ? c0 : g_{j-1})
      const lits = [...Array.from({ length: k - j }, (_, m) => `p${k - 1 - m}`), j === 0 ? 'c0' : `g${j - 1}`];
      const g = lits.length === 2 ? AND : andN(lits.length);
      const gIns = g.ports.filter((p) => p.dir === 'in').map((p) => p.name);
      const nm = `t${k}_${j}`;
      instances.push({ name: nm, def: g, at: [XA, y] });
      lits.forEach((l, m) => railEnds.get(l)!.push(`${nm}.${gIns[m]}`));
      terms.push(`${nm}.y`);
      y += symbolGeom(g).h + 1;
    }
    const og = symbolGeom(ors);
    const oy = Math.max(yTop, (yTop + y) / 2 - og.h / 2);
    instances.push({ name: `c${k}`, def: ors, at: [XO, oy] });
    terms.forEach((t, m) => nets.push({ ends: [t, `c${k}.${orIns[m]}`] }));
    railEnds.get(`g${k - 1}`)!.push(`c${k}.${orIns[k]}`);
    if (k < 4) {
      instances.push({ name: `x${k}`, def: XOR, at: [XS, oy + og.h / 2 - 1] });
      nets.push({ name: `c${k}`, ends: [`c${k}.y`, `x${k}.b`] });
      railEnds.get(`p${k}`)!.push(`x${k}.a`);
      sumEnds.push(`x${k}.y`);
    } else nets.push({ name: 'c4', ends: ['c4.y', 'cout'] });
    y += 3;
  }
  instances.push({ name: 'x0', def: XOR, at: [XS, -6] });
  railEnds.get('p0')!.push('x0.a');
  railEnds.get('c0')!.push('x0.b');
  instances.push({ name: 'ms', def: merger(ones(4)), at: [XS + 8, 6] });
  nets.push({ name: 's0', ends: ['x0.y', 'ms.i0'] });
  sumEnds.forEach((e, i) => nets.push({ name: `s${i + 1}`, ends: [e, `ms.i${i + 1}`] }));
  nets.push({ name: 's', ends: ['ms.out', 's'] });
  for (const [r, ends] of railEnds) nets.push({ name: r, ends, trunk: railX(r) });
  return define({
    id: 'cla4', name: '4-bit carry-lookahead adder', category: 'arithmetic',
    summary: 'All four carries computed at once from g, p and cin by two-level AND-OR logic. Constant depth, but the gates get wide fast: c_k needs a (k+1)-input OR.',
    ports: [bus('a', 4, 'in'), bus('b', 4, 'in'), bit('cin', 'in'), bus('s', 4, 'out'), bit('cout', 'out')],
    symbol: { kind: 'box', label: 'CLA4' },
    spec: ([a, b, c]) => { const t = a + b + c; return [t % 16, t > 15 ? 1 : 0]; },
    netlist: () => ({ pins: { a: [0, 16], b: [0, 17 + 1], cin: [0, -4], s: [XS + 13, 10], cout: [XS + 13, y] }, instances, nets }),
    hdl: {
      verilog: `module cla4 (input logic [3:0] a, b, input logic cin, output logic [3:0] s, output logic cout);
  logic [3:0] g, p;  logic [4:1] c;
  assign g = a & b;  assign p = a ^ b;
  assign c[1] = g[0] | (p[0] & cin);
  assign c[2] = g[1] | (p[1] & g[0]) | (p[1] & p[0] & cin);
  assign c[3] = g[2] | (p[2] & g[1]) | (p[2] & p[1] & g[0]) | (p[2] & p[1] & p[0] & cin);
  assign c[4] = g[3] | (p[3] & g[2]) | (p[3] & p[2] & g[1]) | (p[3] & p[2] & p[1] & g[0])
                     | (p[3] & p[2] & p[1] & p[0] & cin);
  assign s = p ^ {c[3:1], cin};  assign cout = c[4];
endmodule`,
    },
  });
})();

/**
 * A parallel-prefix network, level by level: a cell [i, r] makes the group ending at bit i absorb
 * the group ending at bit r just below it, (G, P)[i] ∘= (G, P)[r]. Cells read the previous level's
 * values. Bit 0 already holds cin (folded in first), so a group that reaches bit 0 is final.
 */
export type PrefixLevels = [number, number][][];

const prefixSpan = (n: number) => Math.ceil(Math.log2(n)); // any width: the levels must span n
const pow2 = (n: number) => (n & (n - 1)) === 0;

/** Kogge–Stone: level j merges every group with the group 2^j below it. */
export function ksLevels(n: number): PrefixLevels {
  return Array.from({ length: prefixSpan(n) }, (_, j) => {
    const d = 2 ** j, cells: [number, number][] = [];
    for (let i = d; i < n; i++) cells.push([i, i - d]);
    return cells;
  });
}

/**
 * Brent–Kung: up-sweep j = 0 … k−1 at bits i ≡ −1 (mod 2^(j+1)), then down-sweep j = k−2 … 0 at
 * i ≡ 2^j − 1 (mod 2^(j+1)), i ≥ 3·2^j − 1; both take the group 2^j below.
 */
export function bkLevels(n: number): PrefixLevels {
  const k = prefixSpan(n), out: PrefixLevels = [];
  const level = (d: number, first: number) => {
    const cells: [number, number][] = [];
    for (let i = first; i < n; i += 2 * d) cells.push([i, i - d]);
    out.push(cells);
  };
  for (let j = 0; j < k; j++) level(2 ** j, 2 ** (j + 1) - 1);
  for (let j = k - 2; j >= 0; j--) level(2 ** j, 3 * 2 ** j - 1);
  return out.filter((l) => l.length); // short of a power of two, the top of the up-sweep is empty
}

/** Sklansky: at level j every bit with bit j of its index set takes the prefix ending just below its 2^j-aligned block. */
export function skLevels(n: number): PrefixLevels {
  return Array.from({ length: prefixSpan(n) }, (_, j) => {
    const cells: [number, number][] = [];
    for (let i = 0; i < n; i++) if ((i >> j) & 1) cells.push([i, ((i >> j) << j) - 1]);
    return cells;
  });
}

export interface PrefixInfo {
  levels: number; cells: number; gray: number; black: number;
  /** The most prefix-cell inputs one G output (gp, the cin fold or a cell) drives within one level, and over all levels. */
  perLevel: number; total: number;
}

/** Counts a prefix network, and checks that every cell meets the group below it and that every carry gets finished. */
export function prefixInfo(n: number, levels: PrefixLevels): PrefixInfo {
  const lo = Array.from({ length: n }, (_, i) => i); // lowest bit of the group ending at i
  const drv = Array.from({ length: n }, (_, i) => i); // which output carries row i's G now
  let next = n, gray = 0, black = 0, perLevel = 0;
  const total = new Map<number, number>();
  for (const cells of levels) {
    const lo0 = lo.slice(), drv0 = drv.slice(), here = new Map<number, number>();
    for (const [i, r] of cells) {
      if (!(r >= 0 && r < i) || lo0[i] !== r + 1) throw new Error(`prefix cell [${i}, ${r}] does not meet the group below it`);
      for (const s of [drv0[i], drv0[r]]) {
        here.set(s, (here.get(s) ?? 0) + 1);
        total.set(s, (total.get(s) ?? 0) + 1);
      }
      if (lo0[r] === 0) gray++; else black++;
      lo[i] = lo0[r];
      drv[i] = next++;
    }
    for (const c of here.values()) perLevel = Math.max(perLevel, c);
  }
  if (lo.some((l) => l !== 0)) throw new Error('prefix network leaves a carry unfinished');
  return { levels: levels.length, cells: gray + black, gray, black, perLevel, total: Math.max(0, ...total.values()) };
}

interface PrefixAdderSpec {
  id: string; name: string; label: string; summary: string; verilog: string;
  /** A level's lanes left of its column and the lane of the diagonal from row r (default: first fit). */
  lanes?: (level: number) => { count: number; of: (r: number) => number };
}

/**
 * The adder around a prefix network: gp cells, cin folded into bit 0, one column per level, the sum
 * XORs, cout and the signed-overflow flag v = c_n ⊕ c_{n−1}. Rows per bit; each level's diagonals
 * run down lanes left of its column.
 */
function prefixAdder(n: number, levels: PrefixLevels, o: PrefixAdderSpec): ComponentDef {
  prefixInfo(n, levels);
  const R = 7;
  const rowY = (i: number) => 2 + R * i;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), R), at: [3, rowY(0) + 1 - R / 2] },
    { name: 'sb', def: splitter(ones(n), R), at: [6, rowY(0) + 2 - R / 2] },
  ];
  const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] }];
  // Sinks collected per driver end; vias per sink.
  const sinks = new Map<string, string[]>();
  const vias = new Map<string, Record<string, [number, number][]>>();
  const names = new Map<string, string>();
  const addSink = (drv: string, sink: string, via?: [number, number][]) => {
    if (!sinks.has(drv)) sinks.set(drv, []);
    sinks.get(drv)!.push(sink);
    if (via) {
      if (!vias.has(drv)) vias.set(drv, {});
      vias.get(drv)![sink] = via;
    }
  };
  const curG: string[] = [], curP: (string | null)[] = [];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `gp${i}`, def: GP_CELL, at: [10, rowY(i)] });
    nets.push({ ends: [`sa.o${i}`, `gp${i}.a`] }, { ends: [`sb.o${i}`, `gp${i}.b`] });
    curG[i] = `gp${i}.g`;
    curP[i] = `gp${i}.p`;
    names.set(curG[i], `g${i}`);
    names.set(`gp${i}.p`, `p${i}`);
  }
  // Fold the carry-in into bit 0: G0 = g0 + p0·cin.
  const foldX = 18;
  instances.push({ name: 'cin0', def: GRAY_CELL, at: [foldX, rowY(0)] });
  addSink(curG[0], 'cin0.g');
  addSink(`gp0.p`, 'cin0.p');
  addSink('cin', 'cin0.gl', [[foldX - 2, -2], [foldX - 2, rowY(0) + 3]]);
  curG[0] = 'cin0.go';
  curP[0] = null;
  let right = foldX + 4;
  levels.forEach((cells, j) => {
    // One lane (G, and P half a unit left) per group read across rows. A lane is reused once the
    // diagonal in it has ended strictly above the next one's row (a row can end one and start another).
    const reach = new Map<number, number>();
    for (const [i, r] of cells) reach.set(r, Math.max(reach.get(r) ?? r, i));
    const laneOf = new Map<number, number>(), ends: number[] = [];
    for (const r of [...reach.keys()].sort((a, b) => a - b)) {
      let l = ends.findIndex((e) => e < r);
      if (l < 0) l = ends.push(0) - 1;
      ends[l] = reach.get(r)!;
      laneOf.set(r, l);
    }
    const fixed = o.lanes?.(j), lanes = fixed ? fixed.count : ends.length;
    const colX = right + 2 + lanes + 1.5;
    const snapG = curG.slice(), snapP = curP.slice();
    for (const [i, r] of cells) {
      const gray = snapP[r] === null;
      const nm = `L${j}_${i}`;
      instances.push({ name: nm, def: gray ? GRAY_CELL : BLACK_CELL, at: [colX, rowY(i)] });
      addSink(snapG[i], `${nm}.g`);
      addSink(snapP[i]!, `${nm}.p`);
      const lx = colX - 1.5 - (fixed ? fixed.of(r) : laneOf.get(r)!);
      addSink(snapG[r], `${nm}.gl`, [[lx, rowY(r) + 1], [lx, rowY(i) + 3]]);
      if (!gray) addSink(snapP[r]!, `${nm}.pl`, [[lx - 0.5, rowY(r) + 2], [lx - 0.5, rowY(i) + 4]]);
      curG[i] = `${nm}.go`;
      curP[i] = gray ? null : `${nm}.po`;
    }
    right = colX + 4;
  });
  // Sum: s_i = p_i ⊕ c_i with c_0 = cin, c_i = G[i-1:0].
  const XS = right + 6;
  for (let i = 0; i < n; i++) {
    instances.push({ name: `x${i}`, def: XOR, at: [XS, rowY(i) + 2] });
    addSink(`gp${i}.p`, `x${i}.a`, [[15, rowY(i) + 2], [15, rowY(i) + 6], [XS - 1, rowY(i) + 6], [XS - 1, rowY(i) + 3]]);
    // Each carry drops more than a row, so neighbouring bits alternate columns.
    const xb = XS - 2.5 - (i % 2) * 0.5;
    if (i === 0) addSink('cin', 'x0.b', [[xb, -2], [xb, rowY(0) + 5]]);
    else addSink(curG[i - 1], `x${i}.b`, [[xb, rowY(i - 1) + 1], [xb, rowY(i) + 5]]);
    nets.push({ name: `s${i}`, ends: [`x${i}.y`, `ms.i${i}`] });
  }
  instances.push({ name: 'ms', def: merger(ones(n), R), at: [XS + 7, rowY(0) + 4 - R / 2] });
  nets.push({ name: 's', ends: ['ms.out', 's'] });
  // Carry out and overflow (c_n ⊕ c_{n-1}).
  const yb = rowY(n - 1) + 9;
  instances.push({ name: 'vx', def: XOR, at: [XS, yb] });
  addSink(curG[n - 1], 'cout');
  addSink(curG[n - 1], 'vx.b', [[XS - 4, rowY(n - 1) + 1], [XS - 4, yb + 3]]);
  if (n >= 2) addSink(curG[n - 2], 'vx.a', [[XS - 3.5, rowY(n - 2) + 1], [XS - 3.5, yb + 1]]);
  names.set(curG[n - 1], 'cout');
  nets.push({ name: 'v', ends: ['vx.y', 'v'] });
  for (const [drv, ss] of sinks) nets.push({ name: names.get(drv) ?? (drv === 'cin' ? 'cin' : undefined), ends: [drv, ...ss], via: vias.get(drv) });
  const M = mask(n), H = 2 ** (n - 1);
  return define({
    id: o.id, name: o.name, category: 'arithmetic', summary: o.summary,
    ports: [bus('a', n, 'in'), bus('b', n, 'in'), bit('cin', 'in'), bus('s', n, 'out'), bit('cout', 'out'), bit('v', 'out')],
    symbol: { kind: 'box', label: o.label },
    spec: ([a, b, c]) => {
      const t = a + b + c, s = t % (M + 1);
      return [s, t > M ? 1 : 0, (a >= H) === (b >= H) && (s >= H) !== (a >= H) ? 1 : 0];
    },
    netlist: () => ({
      pins: {
        a: [0, rowY(0) + 1 - R / 2 + (R * n) / 2], b: [0, rowY(0) + 2 - R / 2 + (R * n) / 2 + 1.5], cin: [0, -2],
        s: [XS + 12, rowY(0) + 4 - R / 2 + (R * n) / 2], cout: [XS + 12, rowY(n - 1) + 1], v: [XS + 12, yb + 2],
      },
      pinDirs: {},
      instances, nets,
    }),
    hdl: { verilog: o.verilog },
  });
}

/** "5 levels (log2 n), 129 prefix cells (…): 31 gray, 98 black, plus one folding cin into bit 0" */
const prefixCounts = (f: PrefixInfo, levels: string | false, cells: string | false) =>
  `${f.levels} levels${levels ? ` (${levels})` : ''}, ${f.cells} prefix cells${cells ? ` (${cells})` : ''}: ${f.gray} gray, ${f.black} black, plus one folding cin into bit 0`;

/** "A G output drives at most 2 cell inputs per level, 4 over all levels" */
const fanText = (f: PrefixInfo) => `A G output drives at most ${f.perLevel} cell input${f.perLevel === 1 ? "" : "s"} per level, ${f.total} over all levels`;

// The ports, cin fold and sum logic every prefix adder's Verilog shares.
const prefixHead = (mod: string, n: number) => `module ${mod} #(parameter int N = ${n}) (input logic [N-1:0] a, b, input logic cin,
                                    output logic [N-1:0] s, output logic cout, v);`;
const PREFIX_FOLD = `  assign g[0] = (a & b) | {{(N-1){1'b0}}, (a[0] ^ b[0]) & cin};  // fold cin into bit 0
  assign p[0] = a ^ b;`;
const prefixSum = (last: string) => `  wire [N:0] c = {g[${last}], cin};
  assign s = p[0] ^ c[N-1:0];
  assign cout = c[N];  assign v = c[N] ^ c[N-1];
endmodule`;

/**
 * Kogge–Stone parallel-prefix adder: log2(n) levels; level j combines every group with the
 * group 2^j below it. Outputs the sum, the carry out and the signed-overflow flag.
 */
export function koggeStone(n: number): ComponentDef {
  return memo(`ks${n}`, () => {
    const lv = ksLevels(n), f = prefixInfo(n, lv), p2 = pow2(n);
    return prefixAdder(n, lv, {
      id: `ks${n}`, name: `${n}-bit Kogge–Stone adder`, label: `KS${n}`,
      lanes: (j) => { const count = Math.min(2 * 2 ** j, n); return { count, of: (r) => r % count }; },
      summary: `Parallel prefix, Kogge–Stone: level j merges every group with the one 2^j below it. ${prefixCounts(f, p2 && 'log2 n', p2 && 'n·log2 n − n + 1')}. ${fanText(f)} (a finished prefix feeds one cell per later level). The fewest levels at the lowest fan-out, paid for in cells and long wires.`,
      verilog: `// Kogge–Stone: prefix levels d = 1, 2, 4, …; (G,P)[i] ∘= (G,P)[i-d]
${prefixHead('ks', n)}
  logic [N-1:0] g[0:$clog2(N)], p[0:$clog2(N)];
${PREFIX_FOLD}
  for (genvar l = 0; l < $clog2(N); l++)
    for (genvar i = 0; i < N; i++)
      if (i >= 2**l) begin
        assign g[l+1][i] = g[l][i] | (p[l][i] & g[l][i-2**l]);
        assign p[l+1][i] = p[l][i] & p[l][i-2**l];
      end else begin
        assign g[l+1][i] = g[l][i];  assign p[l+1][i] = p[l][i];
      end
${prefixSum('$clog2(N)')}`,
    });
  });
}

/**
 * Brent–Kung parallel-prefix adder: a binary tree up (groups of 2, 4, … n) and back down; 2·log2(n) − 1
 * levels, about 2n cells, one diagonal per output per level.
 */
export function brentKung(n: number): ComponentDef {
  return memo(`bk${n}`, () => {
    const lv = bkLevels(n), f = prefixInfo(n, lv), p2 = pow2(n);
    return prefixAdder(n, lv, {
      id: `bk${n}`, name: `${n}-bit Brent–Kung adder`, label: `BK${n}`,
      summary: `Parallel prefix, Brent–Kung: an up-sweep (level j: bits i ≡ −1 mod 2^(j+1) take the group 2^j below) builds the prefixes at 2^m − 1, a down-sweep fills in the rest. ${prefixCounts(f, p2 && '2·log2 n − 1', p2 && '2n − 2 − log2 n')}. ${fanText(f)} (a finished prefix reused by the down-sweep). The fewest cells and short wires, for nearly twice Kogge–Stone's levels.`,
      verilog: `// Brent–Kung: up-sweep d = 1, 2, …, N/2 at i ≡ 2d−1 (mod 2d), then down-sweep d = N/4, …, 1
// at i ≡ 3d−1 (mod 2d), i ≥ 3d−1; each (G,P)[i] ∘= (G,P)[i-d]
${prefixHead('bk', n)}
  localparam int K = $clog2(N), L = 2*K - 1;
  logic [N-1:0] g[0:L], p[0:L];
${PREFIX_FOLD}
  for (genvar l = 0; l < L; l++) begin : level
    localparam int D = l < K ? 2**l : 2**(L-1-l);
    for (genvar i = 0; i < N; i++)
      if (l < K ? (i+1) % (2*D) == 0 : (i+1) % (2*D) == D && i >= 3*D-1) begin
        assign g[l+1][i] = g[l][i] | (p[l][i] & g[l][i-D]);
        assign p[l+1][i] = p[l][i] & p[l][i-D];
      end else begin
        assign g[l+1][i] = g[l][i];  assign p[l+1][i] = p[l][i];
      end
  end
${prefixSum('L')}`,
    });
  });
}

/**
 * Sklansky (divide-and-conquer) parallel-prefix adder: log2(n) levels, (n/2)·log2(n) cells; on
 * level j one output drives the 2^j bits of the block above it.
 */
export function sklansky(n: number): ComponentDef {
  return memo(`sk${n}`, () => {
    const lv = skLevels(n), f = prefixInfo(n, lv), p2 = pow2(n);
    return prefixAdder(n, lv, {
      id: `sk${n}`, name: `${n}-bit Sklansky adder`, label: `SK${n}`,
      summary: `Parallel prefix, Sklansky (divide and conquer): on level j every bit i with bit j set takes the prefix ending at ((i >> j) << j) − 1, just below its 2^j-aligned block. ${prefixCounts(f, p2 && 'log2 n, as Kogge–Stone', p2 && '(n/2)·log2 n')}. ${fanText(f)}: one output feeds the whole upper half on the last level. Unit delay hides that load; real gates and wires do not.`,
      verilog: `// Sklansky: on level l every i with bit l set takes the prefix below its 2^l block,
// (G,P)[i] ∘= (G,P)[(i >> l << l) - 1]: one output fans out to 2^l cells
${prefixHead('sk', n)}
  logic [N-1:0] g[0:$clog2(N)], p[0:$clog2(N)];
${PREFIX_FOLD}
  for (genvar l = 0; l < $clog2(N); l++)
    for (genvar i = 0; i < N; i++)
      if ((i >> l) & 1) begin
        localparam int R = ((i >> l) << l) - 1;
        assign g[l+1][i] = g[l][i] | (p[l][i] & g[l][R]);
        assign p[l+1][i] = p[l][i] & p[l][R];
      end else begin
        assign g[l+1][i] = g[l][i];  assign p[l+1][i] = p[l][i];
      end
${prefixSum('$clog2(N)')}`,
    });
  });
}

/** Fan one wire out to w bits (pure wiring). */
export function fanout(w: number): ComponentDef {
  return memo(`fan${w}`, () => define({
    id: `fan${w}`, name: `Wiring: 1→${w} fan-out`, category: 'plumbing',
    summary: 'One wire driving w bit positions.',
    ports: [bit('in', 'in'), bus('out', w, 'out')],
    symbol: { kind: 'box', label: `1→${w}`, w: 4, h: 2 }, prim: 'alias',
    alias: Array.from({ length: w }, (_, i): [string, number, string, number] => ['in', 0, 'out', i]),
  }));
}

/** Drop-in replacement for addSub(n) built on the Kogge–Stone adder. */
export function addSubFast(n: number): ComponentDef {
  return memo(`addsubks${n}`, () => {
    const KS = koggeStone(n), X = bitwiseXor(n), F = fanout(n);
    const kg = symbolGeom(KS), xg = symbolGeom(X);
    const M = mask(n), H = 2 ** (n - 1);
    const ksAt: [number, number] = [24, 2];
    return define({
      id: `addsubks${n}`, name: `${n}-bit fast adder / subtractor`, category: 'arithmetic',
      summary: 'The adder / subtractor with a Kogge–Stone adder inside: same ports and flags, logarithmic carry chain.',
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bit('sub', 'in'), bus('s', n, 'out'), bit('cout', 'out'), bit('v', 'out'), bit('n', 'out')],
      symbol: { kind: 'box', label: `ADD/SUB${n}` },
      spec: ([a, b, sub]) => {
        const bb = sub ? (~b & M) >>> 0 : b;
        const t = a + bb + sub, s = t % (M + 1);
        return [s, t > M ? 1 : 0, (a >= H) === (bb >= H) && (s >= H) !== (a >= H) ? 1 : 0, s >= H ? 1 : 0];
      },
      netlist: () => ({
        pins: {
          a: [0, ksAt[1] + kg.ports.a.pos[1]], b: [0, ksAt[1] + kg.ports.b.pos[1] + 6], sub: [0, ksAt[1] + kg.ports.b.pos[1] + 10],
          s: [ksAt[0] + kg.w + 12, ksAt[1] + kg.ports.s.pos[1]], cout: [ksAt[0] + kg.w + 12, ksAt[1] + kg.ports.cout.pos[1]],
          v: [ksAt[0] + kg.w + 12, ksAt[1] + kg.ports.v.pos[1]], n: [ksAt[0] + kg.w + 12, ksAt[1] + kg.ports.s.pos[1] + 3],
        },
        instances: [
          { name: 'fan', def: F, at: [6, ksAt[1] + kg.ports.b.pos[1] + 9] },
          { name: 'inv', def: X, at: [13, ksAt[1] + kg.ports.b.pos[1] + 6 - xg.ports.a.pos[1]] },
          { name: 'add', def: KS, at: ksAt },
          { name: 'msb', def: splitter([n - 1, 1]), at: [ksAt[0] + kg.w + 4, ksAt[1] + kg.ports.s.pos[1] - 1] },
        ],
        nets: [
          { name: 'a', ends: ['a', 'add.a'] },
          { name: 'b', ends: ['b', 'inv.a'] },
          { name: 'sub', ends: ['sub', 'fan.in', 'add.cin'], via: { 'add.cin': [[3, ksAt[1] + kg.ports.b.pos[1] + 10], [3, ksAt[1] + kg.ports.cin.pos[1]]] } },
          { name: 'subs', ends: ['fan.out', 'inv.b'] },
          { name: 'bx', ends: ['inv.y', 'add.b'] },
          { name: 's', ends: ['add.s', 's', 'msb.in'] },
          { name: 'n', ends: ['msb.o1', 'n'] },
          { name: 'cout', ends: ['add.cout', 'cout'] },
          { name: 'v', ends: ['add.v', 'v'] },
        ],
      }),
    });
  });
}

function bitwiseXor(n: number): ComponentDef {
  return bitwise('xor', n);
}
