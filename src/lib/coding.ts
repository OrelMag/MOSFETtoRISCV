// Comparison and coding blocks: magnitude comparator, priority encoder, encoder, demultiplexer,
// population count, absolute value, parity and a Hamming SEC-DED code.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { Builder } from './builder';
import { HALF_ADDER, busMux2, decoder, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { fanout } from './fastadd';
import { AND, NOR, NOT, OR, XNOR, XOR } from './gates';
import { condNegate } from './muldiv';
import { TIE0 } from './transistors';
import { bitwise, orN, xorN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const log2 = (n: number) => Math.round(Math.log2(n));
const popc = (v: number) => { let c = 0; for (; v; v &= v - 1) c++; return c; };
const sx = (v: number, n: number) => (v >= 2 ** (n - 1) ? v - 2 ** n : v);

// ---- magnitude comparator ---------------------------------------------------------------------

/** One bit: gt = a·¬b, eq = a XNOR b. For the sign bit of a signed compare the roles swap: gt = ¬a·b. */
function cmpBit(signed: boolean): ComponentDef {
  return memo(`cmpbit${signed ? 's' : ''}`, () => define({
    id: `cmpbit${signed ? 's' : ''}`, name: signed ? 'Sign-bit compare' : 'One-bit compare', category: 'routing',
    summary: signed
      ? 'For the sign bit the order flips: a negative number (sign 1) is the smaller one, so gt = ¬a·b. eq is unchanged.'
      : 'gt = a·¬b (this bit alone says a > b), eq = a XNOR b.',
    ports: [bit('a', 'in'), bit('b', 'in'), bit('gt', 'out'), bit('eq', 'out')],
    symbol: { kind: 'box', label: signed ? 'CMP±' : 'CMP' },
    spec: ([a, b]) => [signed ? (!a && b ? 1 : 0) : (a && !b ? 1 : 0), a === b ? 1 : 0],
    netlist: () => ({
      pins: { a: [0, 2], b: [0, 10], gt: [20, 3], eq: [20, 9] },
      instances: [
        { name: 'inv', def: NOT, at: [5, signed ? 1 : 3] },
        { name: 'g', def: AND, at: [12, 1] },
        { name: 'e', def: XNOR, at: [12, 7] },
      ],
      nets: signed
        ? [
          { name: 'a', ends: ['a', 'inv.a', 'e.a'], trunk: 3 },
          { name: 'b', ends: ['b', 'g.b', 'e.b'], trunk: 9 },
          { name: '¬a', ends: ['inv.y', 'g.a'] },
          { name: 'gt', ends: ['g.y', 'gt'] }, { name: 'eq', ends: ['e.y', 'eq'] },
        ]
        : [
          { name: 'a', ends: ['a', 'g.a', 'e.a'], trunk: 3 },
          { name: 'b', ends: ['b', 'inv.a', 'e.b'], trunk: 4 },
          { name: '¬b', ends: ['inv.y', 'g.b'] },
          { name: 'gt', ends: ['g.y', 'gt'] }, { name: 'eq', ends: ['e.y', 'eq'] },
        ],
    }),
    hdl: { verilog: signed ? 'assign gt = ~a & b;\nassign eq = ~(a ^ b);' : 'assign gt = a & ~b;\nassign eq = ~(a ^ b);' },
  }));
}

/** Combine a high and a low field: the high field decides unless it is equal. */
export const CMP_MERGE: ComponentDef = define({
  id: 'cmpmerge', name: 'Compare: combine two fields', category: 'routing',
  summary: 'Two adjacent fields, high (h) and low (l): a > b if the high field says so, or the high field is equal and the low field says so. Equal only if both are equal.',
  ports: [bit('gh', 'in'), bit('eh', 'in'), bit('gl', 'in'), bit('el', 'in'), bit('g', 'out'), bit('e', 'out')],
  symbol: { kind: 'box', label: 'combine' },
  spec: ([gh, eh, gl, el]) => [gh || (eh && gl) ? 1 : 0, eh && el ? 1 : 0],
  netlist: () => ({
    pins: { gh: [0, 1], eh: [0, 7], gl: [0, 9], el: [0, 14], g: [22, 2], e: [22, 13] },
    instances: [
      { name: 't', def: AND, at: [6, 6] },
      { name: 'g', def: OR, at: [15, 0] },
      { name: 'e', def: AND, at: [15, 11] },
    ],
    nets: [
      { name: 'gh', ends: ['gh', 'g.a'] },
      { name: 'eh', ends: ['eh', 't.a', 'e.a'], trunk: 3 },
      { name: 'gl', ends: ['gl', 't.b'] },
      { name: 'el', ends: ['el', 'e.b'] },
      { name: 'eh·gl', ends: ['t.y', 'g.b'] },
      { name: 'g', ends: ['g.y', 'g'] }, { name: 'e', ends: ['e.y', 'e'] },
    ],
  }),
  hdl: { verilog: 'assign g = gh | (eh & gl);\nassign e = eh & el;' },
});

/**
 * n-bit magnitude comparator without a subtractor: per-bit (gt, eq) pairs merged by a balanced
 * tree, most significant field first. log2(n) merge levels, no carry chain.
 */
export function magComparator(n: number, signed = false): ComponentDef {
  const id = `cmp${n}${signed ? 's' : ''}`;
  return memo(id, () => {
    const BIT = cmpBit(false), MG = symbolGeom(CMP_MERGE), BG = symbolGeom(BIT);
    const P = Math.max(BG.h + 2, 8);
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter(ones(n), P), at: [4, 2 + BG.ports.a.pos[1] - P / 2] },
      { name: 'sb', def: splitter(ones(n), P), at: [7, 2 + BG.ports.b.pos[1] - P / 2] },
    ];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'b', ends: ['b', 'sb.in'] }];
    type Node = { g: string; e: string; y: number };
    let level: Node[] = [];
    for (let i = 0; i < n; i++) {
      const def = signed && i === n - 1 ? cmpBit(true) : BIT;
      instances.push({ name: `c${i}`, def, at: [12, 2 + P * i], label: `bit ${i}` });
      nets.push({ ends: [`sa.o${i}`, `c${i}.a`] }, { ends: [`sb.o${i}`, `c${i}.b`] });
      level.push({ g: `c${i}.gt`, e: `c${i}.eq`, y: 2 + P * i + BG.h / 2 });
    }
    let x = 12 + BG.w + 10, k = 0;
    while (level.length > 1) {
      const next: Node[] = [];
      for (let j = 0; j + 1 < level.length; j += 2) {
        const lo = level[j], hi = level[j + 1], nm = `m${k++}`;
        const y = Math.round((lo.y + hi.y) / 2 - MG.h / 2);
        instances.push({ name: nm, def: CMP_MERGE, at: [x, y] });
        nets.push({ ends: [hi.g, `${nm}.gh`] }, { ends: [hi.e, `${nm}.eh`] }, { ends: [lo.g, `${nm}.gl`] }, { ends: [lo.e, `${nm}.el`] });
        next.push({ g: `${nm}.g`, e: `${nm}.e`, y: y + MG.h / 2 });
      }
      if (level.length % 2) next.push(level[level.length - 1]);
      level = next;
      x += MG.w + 10;
    }
    const top = level[0];
    const yl = Math.round(top.y) + 4;
    instances.push({ name: 'lt', def: NOR, at: [x, yl] });
    nets.push(
      { name: 'gt', ends: [top.g, 'lt.a', 'gt'] },
      { name: 'eq', ends: [top.e, 'lt.b', 'eq'] },
      { name: 'lt', ends: ['lt.y', 'lt'] },
    );
    const xr = x + 10;
    return define({
      id, name: `${n}-bit ${signed ? 'signed' : 'unsigned'} magnitude comparator`, category: 'routing',
      summary: `Each bit says "greater here" and "equal here"; a tree of ${n - 1} combine cells (${Math.ceil(Math.log2(n))} levels) lets the most significant difference win. lt = neither greater nor equal.${signed ? ' Signed: the sign bit compares the other way round.' : ''}`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bit('lt', 'out'), bit('eq', 'out'), bit('gt', 'out')],
      symbol: { kind: 'box', label: signed ? 'CMP±' : 'CMP' },
      spec: ([a, b]) => {
        const [x, y] = signed ? [sx(a, n), sx(b, n)] : [a, b];
        return [x < y ? 1 : 0, x === y ? 1 : 0, x > y ? 1 : 0];
      },
      netlist: () => ({
        pins: { a: [0, 4 + (P * (n - 1)) / 2], b: [0, 6 + (P * (n - 1)) / 2], gt: [xr, yl - 2], eq: [xr, yl + 6], lt: [xr, yl + 2] },
        instances, nets,
      }),
      hdl: {
        verilog: `module mag_cmp #(parameter int N = ${n}) (input logic [N-1:0] a, b, output logic lt, eq, gt);
  assign gt = ${signed ? '$signed(a) > $signed(b)' : 'a > b'};
  assign eq = a == b;
  assign lt = ~(gt | eq);
endmodule`,
      },
    });
  });
}

// ---- priority encoder, encoder, demultiplexer -------------------------------------------------

/**
 * n requests (n a power of two) → the index of the highest one, and valid. Built recursively:
 * two half-size encoders; the upper half wins whenever it has any request.
 */
export function priorityEncoder(n: number): ComponentDef {
  const k = log2(n);
  return memo(`prienc${n}`, () => {
    if (n === 2) {
      return define({
        id: 'prienc2', name: '2-input priority encoder', category: 'routing',
        summary: 'y = 1 if request 1 is set (it has priority), valid if either is set.',
        ports: [bus('r', 2, 'in'), bus('y', 1, 'out'), bit('v', 'out')],
        symbol: { kind: 'box', label: 'PRI' },
        spec: ([r]) => [r & 2 ? 1 : 0, r ? 1 : 0],
        netlist: () => ({
          pins: { r: [0, 4], y: [16, 1], v: [16, 6] },
          instances: [{ name: 'sr', def: splitter([1, 1], 4), at: [3, 2] }, { name: 'any', def: OR, at: [9, 4] }],
          nets: [
            { name: 'r', ends: ['r', 'sr.in'] },
            { name: 'r0', ends: ['sr.o0', 'any.a'] },
            { name: 'r1', ends: ['sr.o1', 'any.b', 'y'], trunk: 7 },
            { name: 'v', ends: ['any.y', 'v'] },
          ],
        }),
      });
    }
    const H = priorityEncoder(n / 2), hg = symbolGeom(H), MX = busMux2(k - 1), mg = symbolGeom(MX);
    const yHi = 2, yLo = 2 + hg.h + 6;
    const xh = 10, xm = xh + hg.w + 10;
    const yM = yLo + hg.ports.y.pos[1] - mg.ports.a.pos[1];
    const yAny = Math.max(yLo + hg.h + 2, yM + mg.h + 6); // below the mux's select tag
    const instances: InstanceDef[] = [
      { name: 'sr', def: splitter([n / 2, n / 2], hg.h + 6), at: [4, yHi + hg.ports.r.pos[1] - (hg.h + 6) / 2] },
      { name: 'lo', def: H, at: [xh, yHi], label: `requests 0..${n / 2 - 1}` },
      { name: 'hi', def: H, at: [xh, yLo], label: `requests ${n / 2}..${n - 1}` },
      { name: 'mx', def: MX, at: [xm, yM], label: 'upper wins?' },
      { name: 'any', def: OR, at: [xm, yAny] },
      { name: 'my', def: merger([k - 1, 1], 4), at: [xm + mg.w + 6, yM + mg.ports.y.pos[1] - 2] },
    ];
    const nets: NetDef[] = [
      { name: 'r', ends: ['r', 'sr.in'] },
      { name: 'rlo', ends: ['sr.o0', 'lo.r'] },
      { name: 'rhi', ends: ['sr.o1', 'hi.r'] },
      { name: 'ylo', ends: ['lo.y', 'mx.a'] },
      { name: 'yhi', ends: ['hi.y', 'mx.b'] },
      { name: 'vlo', ends: ['lo.v', 'any.a'], tags: true },
      { name: 'vhi', ends: ['hi.v', 'mx.s', 'any.b', 'my.i1'], tags: ['mx.s', 'my.i1'] },
      { name: 'low', ends: ['mx.y', 'my.i0'] },
      { name: 'y', ends: ['my.out', 'y'] },
      { name: 'v', ends: ['any.y', 'v'] },
    ];
    const xr = xm + mg.w + 14;
    return define({
      id: `prienc${n}`, name: `${n}-input priority encoder`, category: 'routing',
      summary: `y = index of the highest request, valid = any request. Two ${n / 2}-input encoders: if the upper half has a request it wins (index top bit 1, low bits from the upper encoder), otherwise the lower half answers. ${k - 1} levels of multiplexers.`,
      ports: [bus('r', n, 'in'), bus('y', k, 'out'), bit('v', 'out')],
      symbol: { kind: 'box', label: 'PRI' },
      spec: ([r]) => [r ? 31 - Math.clz32(r) : 0, r ? 1 : 0],
      netlist: () => ({ pins: { r: [0, (yHi + yLo + hg.h) / 2], y: [xr, yM + mg.ports.y.pos[1]], v: [xr, yAny + 2] }, instances, nets }),
      hdl: {
        verilog: `module prio_enc #(parameter int N = ${n}) (input logic [N-1:0] r, output logic [$clog2(N)-1:0] y, output logic v);
  always_comb begin
    y = '0;
    for (int i = 0; i < N; i++) if (r[i]) y = i;   // the last (highest) match wins
  end
  assign v = |r;
endmodule`,
      },
    });
  });
}

/** OR of a list of drivers: a wire, a gate, or a tree. */
function orOf(b: Builder, drivers: string[], label?: string): string {
  if (drivers.length === 1) return drivers[0];
  return b.op1(drivers.length === 2 ? OR : orN(drivers.length), drivers, label);
}
function xorOf(b: Builder, drivers: string[], label?: string): string {
  if (drivers.length === 1) return drivers[0];
  return b.op1(drivers.length === 2 ? XOR : xorN(drivers.length), drivers, label);
}

/** One-hot → binary: output bit j is the OR of every input whose index has bit j set. */
export function encoder(n: number): ComponentDef {
  const k = log2(n);
  return memo(`enc${n}`, () => {
    const b = new Builder(8);
    const s = b.op(splitter(ones(n)), ['x']);
    b.next();
    const ys: string[] = [];
    for (let j = 0; j < k; j++) ys.push(orOf(b, Array.from({ length: n }, (_, i) => i).filter((i) => (i >> j) & 1).map((i) => `${s}.o${i}`), `bit ${j}`));
    b.next();
    b.wire(b.op1(merger(ones(k), 6), ys), 'y');
    return define({
      id: `enc${n}`, name: `${n}→${k} encoder`, category: 'routing',
      summary: `The inverse of a decoder: exactly one of ${n} inputs is 1, and y says which. Output bit j ORs the ${n / 2} inputs whose index has bit j set. Input 0 is not connected at all: "none" and "input 0" look the same, which is why real designs add a valid bit (see the priority encoder).`,
      ports: [bus('x', n, 'in'), bus('y', k, 'out')],
      symbol: { kind: 'box', label: 'ENC' },
      spec: ([x]) => { let y = 0; for (let i = 0; i < n; i++) if ((x >> i) & 1) y |= i; return [y]; },
      netlist: () => ({ pins: { x: [0, n + 2], y: [b.right, 2 + 3 * k] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `always_comb begin
  y = '0;
  for (int i = 0; i < ${n}; i++) if (x[i]) y |= i;
end`,
      },
    });
  });
}

/** 1 → 2^k demultiplexer for w-bit words: a decoder gates the input onto one output. */
export function demux(k: number, w: number): ComponentDef {
  const N = 2 ** k;
  return memo(`demux${N}x${w}`, () => {
    const G = w === 1 ? AND : bitwise('and', w), gg = symbolGeom(G);
    const P = Math.max(gg.h + 4, 6);
    const D = decoder(k, false, P), dg = symbolGeom(D); // output pitch = row pitch: straight select wires
    const yd = 2 + gg.ports.b.pos[1] - dg.ports.y0.pos[1];
    const xg = dg.w + 22;
    const instances: InstanceDef[] = [{ name: 'dec', def: D, at: [8, yd] }];
    const nets: NetDef[] = [{ name: 's', ends: ['s', 'dec.a'] }];
    const xEnds = ['x'];
    for (let i = 0; i < N; i++) {
      const y = 2 + P * i;
      instances.push({ name: `g${i}`, def: G, at: [xg, y] });
      if (w === 1) {
        nets.push({ name: `sel${i}`, ends: [`dec.y${i}`, `g${i}.b`] });
        xEnds.push(`g${i}.a`);
      } else {
        instances.push({ name: `f${i}`, def: fanout(w), at: [xg - 7, y + gg.ports.b.pos[1] - 1] });
        nets.push({ name: `sel${i}`, ends: [`dec.y${i}`, `f${i}.in`] }, { ends: [`f${i}.out`, `g${i}.b`] });
        xEnds.push(`g${i}.a`);
      }
      nets.push({ name: `y${i}`, ends: [`g${i}.y`, `y${i}`] });
    }
    nets.push({ name: 'x', ends: xEnds, tags: xEnds.slice(1) });
    const xr = xg + gg.w + 6;
    const pins: Record<string, [number, number]> = { x: [0, 2 + P * N], s: [0, yd + dg.ports.a.pos[1]] };
    for (let i = 0; i < N; i++) pins[`y${i}`] = [xr, 2 + P * i + gg.ports.y.pos[1]];
    return define({
      id: `demux${N}x${w}`, name: `1→${N} demultiplexer${w > 1 ? ` (${w}-bit)` : ''}`, category: 'routing',
      summary: `Sends x to output s and 0 to the others: a ${k}→${N} decoder enables one ${w > 1 ? 'row of AND gates' : 'AND gate'}. A decoder with an enable input is the 1-bit case (x = enable).`,
      ports: [bus('x', w, 'in'), bus('s', k, 'in'), ...Array.from({ length: N }, (_, i) => bus(`y${i}`, w, 'out'))],
      symbol: { kind: 'box', label: 'DEMUX' },
      spec: ([x, s]) => Array.from({ length: N }, (_, i) => (i === s ? x : 0)),
      netlist: () => ({ pins, instances, nets }),
      hdl: { verilog: `always_comb begin\n  for (int i = 0; i < ${N}; i++) y[i] = '0;\n  y[s] = x;\nend` },
    });
  });
}

// ---- counting and signs ---------------------------------------------------------------------------

/** Number of 1 bits in x (n a power of two): two half-size counters and an adder, recursively. */
export function popcount(n: number): ComponentDef {
  const k = log2(n);
  return memo(`popcnt${n}`, () => {
    if (n === 2) {
      return define({
        id: 'popcnt2', name: '2-bit population count', category: 'arithmetic',
        summary: 'Counting the ones in two bits is adding them: a half adder.',
        ports: [bus('x', 2, 'in'), bus('c', 2, 'out')],
        symbol: { kind: 'box', label: 'POP' },
        spec: ([x]) => [popc(x)],
        netlist: () => ({
          pins: { x: [0, 4], c: [22, 4] },
          instances: [
            { name: 'sx', def: splitter([1, 1]), at: [3, 3] },
            { name: 'ha', def: HALF_ADDER, at: [8, 2] },
            { name: 'mc', def: merger([1, 1]), at: [18, 3] },
          ],
          nets: [
            { name: 'x', ends: ['x', 'sx.in'] },
            { ends: ['sx.o0', 'ha.a'] }, { ends: ['sx.o1', 'ha.b'] },
            { name: 'ones', ends: ['ha.s', 'mc.i0'] }, { name: 'twos', ends: ['ha.c', 'mc.i1'] },
            { name: 'c', ends: ['mc.out', 'c'] },
          ],
        }),
      });
    }
    const H = popcount(n / 2), hg = symbolGeom(H), A = rca(k), ag = symbolGeom(A);
    const yLo = 2, yHi = yLo + hg.h + 6, xa = 10 + hg.w + 10;
    const ya = Math.round((yLo + hg.ports.c.pos[1] + yHi + hg.ports.c.pos[1]) / 2 - ag.ports.a.pos[1] - 1);
    const instances: InstanceDef[] = [
      { name: 'sx', def: splitter([n / 2, n / 2], hg.h + 6), at: [4, yLo + hg.ports.x.pos[1] - (hg.h + 6) / 2] },
      { name: 'lo', def: H, at: [10, yLo], label: `bits 0..${n / 2 - 1}` },
      { name: 'hi', def: H, at: [10, yHi], label: `bits ${n / 2}..${n - 1}` },
      { name: 'z', def: TIE0, at: [xa - 4, ya - 4] },
      { name: 'add', def: A, at: [xa, ya] },
      { name: 'mc', def: merger([k, 1], 4), at: [xa + ag.w + 6, ya + ag.ports.s.pos[1] - 2] },
    ];
    const nets: NetDef[] = [
      { name: 'x', ends: ['x', 'sx.in'] },
      { ends: ['sx.o0', 'lo.x'] }, { ends: ['sx.o1', 'hi.x'] },
      { name: 'clo', ends: ['lo.c', 'add.a'] }, { name: 'chi', ends: ['hi.c', 'add.b'] },
      { ends: ['z.y', 'add.cin'] },
      { name: 'sum', ends: ['add.s', 'mc.i0'] }, { name: 'carry', ends: ['add.cout', 'mc.i1'] },
      { name: 'c', ends: ['mc.out', 'c'] },
    ];
    return define({
      id: `popcnt${n}`, name: `${n}-bit population count`, category: 'arithmetic',
      summary: `How many of the ${n} bits are 1: count each half, add the two ${k}-bit counts. Each level of the tree adds one bit of width; ${k} levels in all.`,
      ports: [bus('x', n, 'in'), bus('c', k + 1, 'out')],
      symbol: { kind: 'box', label: 'POP' },
      spec: ([x]) => [popc(x)],
      netlist: () => ({ pins: { x: [0, (yLo + yHi + hg.h) / 2], c: [xa + ag.w + 12, ya + ag.ports.s.pos[1]] }, instances, nets }),
      hdl: { verilog: `always_comb begin\n  c = '0;\n  for (int i = 0; i < ${n}; i++) c += x[i];\nend` },
    });
  });
}

/** |x| in two's complement: negate when the sign bit is set (|−2^(n−1)| does not fit and stays). */
export function absValue(n: number): ComponentDef {
  return memo(`abs${n}`, () => {
    const CN = condNegate(n), cg = symbolGeom(CN);
    return define({
      id: `abs${n}`, name: `${n}-bit absolute value`, category: 'arithmetic',
      summary: `The sign bit drives a conditional negator. One value has no positive twin: |−${2 ** (n - 1)}| comes out as −${2 ** (n - 1)} again (the overflow every two's-complement abs has).`,
      ports: [bus('x', n, 'in'), bus('y', n, 'out')],
      symbol: { kind: 'box', label: '|x|' },
      spec: ([x]) => [x >= 2 ** (n - 1) ? (2 ** n - x) % 2 ** n : x],
      netlist: () => ({
        pins: { x: [0, 2 + cg.ports.x.pos[1]], y: [16 + cg.w + 6, 2 + cg.ports.y.pos[1]] },
        instances: [
          { name: 'sx', def: splitter([n - 1, 1], 4), at: [5, 2 + cg.ports.x.pos[1] + 2] },
          { name: 'neg', def: CN, at: [16, 2], label: 'negate if < 0' },
        ],
        nets: [
          { name: 'x', ends: ['x', 'sx.in', 'neg.x'], trunk: 3 },
          { name: 'sign', ends: ['sx.o1', 'neg.neg'] },
          { name: 'y', ends: ['neg.y', 'y'] },
        ],
      }),
      hdl: { verilog: 'assign y = x[N-1] ? -x : x;' },
    });
  });
}

/** Even parity bit of an n-bit word: an XOR tree. */
export function parity(n: number): ComponentDef {
  return memo(`parity${n}`, () => {
    const T = xorN(n), tg = symbolGeom(T);
    return define({
      id: `parity${n}`, name: `${n}-bit parity`, category: 'gate',
      summary: `p = 1 when x has an odd number of ones, so x plus p always has an even number. ${n - 1} XOR gates, ${Math.ceil(Math.log2(n))} levels. Any single flipped bit changes p: the cheapest error detection there is (but it cannot say which bit, and two flips cancel).`,
      ports: [bus('x', n, 'in'), bit('p', 'out')],
      symbol: { kind: 'box', label: 'PAR' },
      spec: ([x]) => [popc(x) & 1],
      netlist: () => ({
        pins: { x: [0, 1 + n], p: [8 + tg.w + 6, 1 + tg.h / 2] },
        instances: [{ name: 'sx', def: splitter(ones(n)), at: [4, 1] }, { name: 't', def: T, at: [8, 1] }],
        nets: [
          { name: 'x', ends: ['x', 'sx.in'] },
          ...Array.from({ length: n }, (_, i): NetDef => ({ ends: [`sx.o${i}`, `t.i${i}`] })),
          { name: 'p', ends: ['t.y', 'p'] },
        ],
      }),
      hdl: { verilog: 'assign p = ^x;' },
    });
  });
}

// ---- Hamming SEC-DED ---------------------------------------------------------------------------------

/** Code layout for k data bits: r check bits at positions 1, 2, 4, …; position 0 holds the overall parity. */
export function hammingLayout(k: number): { r: number; n: number; dataPos: number[] } {
  let r = 1;
  while (2 ** r < k + r + 1) r++;
  const dataPos: number[] = [];
  for (let p = 1; dataPos.length < k; p++) if (p & (p - 1)) dataPos.push(p);
  return { r, n: k + r + 1, dataPos };
}

export function hammingEncodeRef(d: number, k: number): number {
  const { r, dataPos } = hammingLayout(k);
  let c = 0;
  dataPos.forEach((p, i) => { if ((d >> i) & 1) c |= 2 ** p; });
  for (let j = 0; j < r; j++) {
    let par = 0;
    dataPos.forEach((p, i) => { if ((p >> j) & 1) par ^= (d >> i) & 1; });
    if (par) c |= 2 ** (2 ** j);
  }
  if (popc(c) & 1) c |= 1;
  return c;
}

export function hammingDecodeRef(c: number, k: number): { d: number; syndrome: number; single: number; double: number } {
  const { r, n, dataPos } = hammingLayout(k);
  let s = 0, all = 0;
  for (let p = 0; p < n; p++) if ((c >> p) & 1) { all ^= 1; s ^= p; }
  s &= 2 ** r - 1;
  const fixed = all ? c ^ (2 ** s) : c;
  let d = 0;
  dataPos.forEach((p, i) => { if ((fixed >> p) & 1) d |= 2 ** i; });
  return { d, syndrome: s, single: all, double: !all && s ? 1 : 0 };
}

/** SEC-DED encoder: k data bits → k + r + 1 code bits. */
export function hammingEnc(k: number): ComponentDef {
  const { r, n, dataPos } = hammingLayout(k);
  return memo(`hamenc${k}`, () => {
    const b = new Builder(8);
    const sd = b.op(splitter(ones(k)), ['d']);
    b.next();
    const at = new Map<number, string>();
    dataPos.forEach((p, i) => at.set(p, `${sd}.o${i}`));
    for (let j = 0; j < r; j++) {
      const ins = dataPos.map((p, i) => ((p >> j) & 1 ? `${sd}.o${i}` : '')).filter(Boolean);
      at.set(2 ** j, b.name(xorOf(b, ins, `check ${2 ** j}`), `c${2 ** j}`));
    }
    // Overall parity = XOR of every other code bit. Each data bit also appears in popcount(position)
    // check bits, so it reduces to the data bits whose position has an even number of ones.
    at.set(0, b.name(xorOf(b, dataPos.map((p, i) => (popc(p) % 2 === 0 ? `${sd}.o${i}` : '')).filter(Boolean), 'overall'), 'c0'));
    b.next();
    b.wire(b.op1(merger(ones(n)), Array.from({ length: n }, (_, p) => at.get(p)!)), 'c');
    return define({
      id: `hamenc${k}`, name: `Hamming SEC-DED encoder (${k} data bits)`, category: 'gate',
      summary: `${k} data bits → ${n} code bits. Check bit 2^j sits at position 2^j and makes the XOR of every position with bit j set even; bit 0 makes the whole word even. ${r + 1} XOR trees, ${r + 1} extra bits (${Math.round(100 * (r + 1) / k)} % overhead).`,
      ports: [bus('d', k, 'in'), bus('c', n, 'out')],
      symbol: { kind: 'box', label: 'ECC enc' },
      spec: ([d]) => [hammingEncodeRef(d, k)],
      netlist: () => ({ pins: { d: [0, 2 + k], c: [b.right, 2 + n] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** SEC-DED decoder: corrects any single flipped bit, flags (but cannot correct) any two. */
export function hammingDec(k: number): ComponentDef {
  const { r, n, dataPos } = hammingLayout(k);
  return memo(`hamdec${k}`, () => {
    const b = new Builder(8);
    const sc = b.op(splitter(ones(n)), ['c']);
    b.next();
    const cb = (p: number) => `${sc}.o${p}`;
    const syn: string[] = [];
    for (let j = 0; j < r; j++) {
      const ins: string[] = [];
      for (let p = 1; p < n; p++) if ((p >> j) & 1) ins.push(cb(p));
      syn.push(b.name(xorOf(b, ins, `s${j}`), `s${j}`));
    }
    const all = b.name(xorOf(b, Array.from({ length: n }, (_, p) => cb(p)), 'overall'), 'odd');
    b.next();
    const sv = b.op1(merger(ones(r)), syn);
    b.name(sv, 'syndrome');
    b.next();
    const dec = b.op(decoder(r), [sv], 'which bit');
    const nz = b.name(orOf(b, syn, 'any'), 'nz');
    b.next();
    const nall = b.op1(NOT, [all]);
    const dbl = b.op1(AND, [nall, nz], 'double');
    const fixes = dataPos.map((p) => b.op1(AND, [`${dec}.y${p}`, all]));
    b.next();
    const ds = dataPos.map((p, i) => b.op1(XOR, [cb(p), fixes[i]], `d${i}`));
    b.next();
    b.wire(b.op1(merger(ones(k)), ds), 'd');
    b.wire(sv, 'syndrome');
    b.wire(all, 'single');
    b.wire(dbl, 'double');
    const R = b.right;
    return define({
      id: `hamdec${k}`, name: `Hamming SEC-DED decoder (${k} data bits)`, category: 'gate',
      summary: `Recompute the ${r} checks: the syndrome is the position of a single flipped bit (0 = none, or bit 0). The overall parity tells one error (odd: flip the bit the syndrome names) from two (even, syndrome ≠ 0: report, cannot fix).`,
      ports: [bus('c', n, 'in'), bus('d', k, 'out'), bus('syndrome', r, 'out'), bit('single', 'out'), bit('double', 'out')],
      symbol: { kind: 'box', label: 'ECC dec' },
      spec: ([c]) => { const o = hammingDecodeRef(c, k); return [o.d, o.syndrome, o.single, o.double]; },
      netlist: () => ({ pins: { c: [0, 2 + n], d: [R, 4], syndrome: [R, 10], single: [R, 14], double: [R, 18] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Encode, let some bits flip (flip = 1 inverts that code bit), decode: a SEC-DED round trip. */
export function eccChannel(k: number): ComponentDef {
  const { n } = hammingLayout(k);
  return memo(`ecc${k}`, () => {
    const E = hammingEnc(k), X = bitwise('xor', n), D = hammingDec(k);
    const eg = symbolGeom(E), xg = symbolGeom(X), dg = symbolGeom(D);
    const xe = 8, xx = xe + eg.w + 10, xd = xx + xg.w + 10, xr = xd + dg.w + 8;
    const yx = 2 + eg.ports.c.pos[1] - xg.ports.a.pos[1];
    const yd = yx + xg.ports.y.pos[1] - dg.ports.c.pos[1];
    return define({
      id: `ecc${k}`, name: `SEC-DED round trip (${k} data bits)`, category: 'gate',
      summary: 'A memory word on its way from the encoder (on write) to the decoder (on read). flip models bits upset in between, by a particle strike or a weak DRAM cell.',
      ports: [bus('d', k, 'in'), bus('flip', n, 'in'), bus('stored', n, 'out'), bus('dout', k, 'out'), bit('single', 'out'), bit('double', 'out')],
      symbol: { kind: 'box', label: 'ECC' },
      spec: ([d, flip]) => {
        const c = hammingEncodeRef(d, k) ^ flip, o = hammingDecodeRef(c, k);
        return [c, o.d, o.single, o.double];
      },
      netlist: () => ({
        pins: {
          d: [0, 2 + eg.ports.d.pos[1]], flip: [0, yx + xg.ports.b.pos[1] + 8],
          stored: [xr, yd - 4], dout: [xr, yd + dg.ports.d.pos[1]], single: [xr, yd + dg.ports.single.pos[1]], double: [xr, yd + dg.ports.double.pos[1]],
        },
        instances: [
          { name: 'enc', def: E, at: [xe, 2], label: 'on write' },
          { name: 'upset', def: X, at: [xx, yx], label: 'bit flips' },
          { name: 'dec', def: D, at: [xd, yd], label: 'on read' },
        ],
        nets: [
          { name: 'd', ends: ['d', 'enc.d'] },
          { name: 'code', ends: ['enc.c', 'upset.a'] },
          { name: 'flip', ends: ['flip', 'upset.b'] },
          { name: 'stored', ends: ['upset.y', 'dec.c', 'stored'], tags: ['stored'] },
          { name: 'dout', ends: ['dec.d', 'dout'] },
          { name: 'single', ends: ['dec.single', 'single'] },
          { name: 'double', ends: ['dec.double', 'double'] },
        ],
      }),
    });
  });
}
