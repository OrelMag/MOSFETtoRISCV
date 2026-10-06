// Faster adders: generate/propagate, carry-lookahead and the Kogge–Stone parallel-prefix
// adder (primer §4.4, §4.6). Carries are computed in O(log n) gate delays instead of O(n).

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
 * Kogge–Stone parallel-prefix adder: log2(n) levels; level j combines every group with the
 * group 2^j below it. Outputs the sum, the carry out and the signed-overflow flag.
 */
export function koggeStone(n: number): ComponentDef {
  return memo(`ks${n}`, () => {
    const k = Math.ceil(Math.log2(n)); // any width: the prefix levels must span n
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
    for (let j = 0; j < k; j++) {
      const d = 2 ** j;
      const lanes = Math.min(2 * d, n);
      const colX = right + 2 + lanes + 1.5;
      const snapG = curG.slice(), snapP = curP.slice();
      for (let i = d; i < n; i++) {
        const r = i - d;
        const gray = i < 2 * d;
        const nm = `L${j}_${i}`;
        instances.push({ name: nm, def: gray ? GRAY_CELL : BLACK_CELL, at: [colX, rowY(i)] });
        addSink(curG[i], `${nm}.g`);
        addSink(curP[i]!, `${nm}.p`);
        const lx = colX - 1.5 - (r % lanes);
        addSink(snapG[r], `${nm}.gl`, [[lx, rowY(r) + 1], [lx, rowY(i) + 3]]);
        if (!gray) addSink(snapP[r]!, `${nm}.pl`, [[lx - 0.5, rowY(r) + 2], [lx - 0.5, rowY(i) + 4]]);
        curG[i] = `${nm}.go`;
        curP[i] = gray ? null : `${nm}.po`;
      }
      right = colX + 4;
    }
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
      id: `ks${n}`, name: `${n}-bit Kogge–Stone adder`, category: 'arithmetic',
      summary: `Parallel prefix: ${k} levels of prefix cells compute every carry in O(log n) gate delays, at the price of n·log n cells.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bit('cin', 'in'), bus('s', n, 'out'), bit('cout', 'out'), bit('v', 'out')],
      symbol: { kind: 'box', label: `KS${n}` },
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
      hdl: {
        verilog: `// Kogge–Stone: prefix levels d = 1, 2, 4, …; (G,P)[i] ∘= (G,P)[i-d]
module ks #(parameter int N = ${n}) (input logic [N-1:0] a, b, input logic cin,
                                    output logic [N-1:0] s, output logic cout, v);
  logic [N-1:0] g[0:$clog2(N)], p[0:$clog2(N)];
  assign g[0] = (a & b) | {{(N-1){1'b0}}, (a[0] ^ b[0]) & cin};  // fold cin into bit 0
  assign p[0] = a ^ b;
  for (genvar l = 0; l < $clog2(N); l++)
    for (genvar i = 0; i < N; i++)
      if (i >= 2**l) begin
        assign g[l+1][i] = g[l][i] | (p[l][i] & g[l][i-2**l]);
        assign p[l+1][i] = p[l][i] & p[l][i-2**l];
      end else begin
        assign g[l+1][i] = g[l][i];  assign p[l+1][i] = p[l][i];
      end
  wire [N:0] c = {g[$clog2(N)], cin};
  assign s = p[0] ^ c[N-1:0];
  assign cout = c[N];  assign v = c[N] ^ c[N-1];
endmodule`,
      },
    });
  });
}

/** Fan one wire out to w bits (pure wiring). */
export function fanout(w: number): ComponentDef {
  return memo(`fan${w}`, () => define({
    id: `fan${w}`, name: `Wiring: 1→${w} fan-out`, category: 'plumbing',
    summary: 'One wire driving w bit positions.',
    ports: [bit('in', 'in'), bus('out', w, 'out')],
    symbol: { kind: 'box', label: '⋔', w: 4, h: 2 }, prim: 'alias',
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
