// Level 2: combinational building blocks (primer ch. 4, Appendix C).
// Generators are memoized so one parameter set always yields the same definition object.

import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOT, OR, XOR } from './gates';
import { NAND, TIE1 } from './transistors';
import { mask } from '../sim/values';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width: 1, dir, side });

function memo<A extends unknown[]>(f: (...a: A) => ComponentDef): (...a: A) => ComponentDef {
  const cache = new Map<string, ComponentDef>();
  return (...a: A) => {
    const k = JSON.stringify(a);
    let d = cache.get(k);
    if (!d) cache.set(k, (d = f(...a)));
    return d;
  };
}

// ---- adders ---------------------------------------------------------------------------

export const HALF_ADDER: ComponentDef = define({
  id: 'half_adder', name: 'Half adder', category: 'arithmetic',
  summary: 'Adds two bits: sum = a XOR b, carry = a AND b. Five NANDs (the carry reuses the XOR\'s first NAND).',
  ports: [bit('a', 'in'), bit('b', 'in', 'top'), bit('s', 'out'), bit('c', 'out', 'bottom')],
  symbol: { kind: 'box', label: 'HA' },
  spec: ([a, b]) => [a ^ b, a & b],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 11], s: [27, 7], c: [27, 15] },
    instances: [
      { name: 'g1', def: NAND, at: [6, 4] },
      { name: 'g2', def: NAND, at: [13, 1] },
      { name: 'g3', def: NAND, at: [13, 8] },
      { name: 'g4', def: NAND, at: [20, 5] },
      { name: 'g5', def: NAND, at: [20, 13] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'g2.a', 'g1.a'], trunk: 3 },
      { name: 'b', ends: ['b', 'g3.b', 'g1.b'], trunk: 4 },
      { name: 'm', ends: ['g1.y', 'g2.b', 'g3.a', 'g5.a', 'g5.b'] },
      { name: 'p', ends: ['g2.y', 'g4.a'] },
      { name: 'q', ends: ['g3.y', 'g4.b'] },
      { name: 's', ends: ['g4.y', 's'] },
      { name: 'c', ends: ['g5.y', 'c'] },
    ],
  }),
  hdl: {
    verilog: `module half_adder (input logic a, b, output logic s, c);
  logic m, p, q;
  nand2 g1 (.a(a), .b(b), .y(m));
  nand2 g2 (.a(a), .b(m), .y(p));
  nand2 g3 (.a(b), .b(m), .y(q));
  nand2 g4 (.a(p), .b(q), .y(s));
  nand2 g5 (.a(m), .b(m), .y(c));
endmodule`,
  },
});

/** The textbook construction: two half adders and an OR (13 NANDs). */
export const FULL_ADDER_HA: ComponentDef = define({
  id: 'full_adder_ha', name: 'Full adder (from half adders)', category: 'arithmetic',
  summary: 'Adds three bits. First add a + b, then add the carry-in; a carry from either half becomes the carry-out.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('cin', 'in'), bit('s', 'out'), bit('cout', 'out')],
  symbol: { kind: 'box', label: 'FA' },
  spec: ([a, b, c]) => [a ^ b ^ c, (a & b) | (c & (a ^ b))],
  netlist: () => ({
    pins: { cin: [1, 1], b: [1, 3], a: [1, 6], s: [29, 6], cout: [29, 14] },
    instances: [
      { name: 'ha1', def: HALF_ADDER, at: [5, 4] },
      { name: 'ha2', def: HALF_ADDER, at: [15, 4] },
      { name: 'or1', def: OR, at: [22, 12] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'ha1.a'] },
      { name: 'b', ends: ['b', 'ha1.b'] },
      { name: 'cin', ends: ['cin', 'ha2.b'], trunk: 13 },
      { name: 'x', ends: ['ha1.s', 'ha2.a'] },
      { name: 'c1', ends: ['ha1.c', 'or1.b'], trunk: 15 },
      { name: 'c2', ends: ['ha2.c', 'or1.a'], trunk: 13 },
      { name: 's', ends: ['ha2.s', 's'] },
      { name: 'cout', ends: ['or1.y', 'cout'] },
    ],
  }),
});

/** Nine-NAND full adder (primer hdl/gates.sv): the carry reuses the first NAND of each XOR. */
export const FULL_ADDER: ComponentDef = define({
  id: 'full_adder', name: 'Full adder', category: 'arithmetic',
  summary: 'Adds three bits in nine NANDs. Optimized from two half adders + OR (13 NANDs) by sharing gates.',
  ports: [bit('a', 'in'), bit('b', 'in'), bit('cin', 'in', 'top'), bit('s', 'out'), bit('cout', 'out', 'bottom')],
  symbol: { kind: 'box', label: 'FA' },
  spec: ([a, b, c]) => [a ^ b ^ c, (a & b) | (c & (a ^ b))],
  netlist: () => ({
    pins: { a: [1, 2], b: [1, 11], cin: [1, 15], s: [49, 11], cout: [49, 19] },
    instances: [
      { name: 'g1', def: NAND, at: [6, 4] },
      { name: 'g2', def: NAND, at: [13, 1] },
      { name: 'g3', def: NAND, at: [13, 8] },
      { name: 'g4', def: NAND, at: [20, 5] },
      { name: 'g5', def: NAND, at: [28, 8] },
      { name: 'g6', def: NAND, at: [35, 5] },
      { name: 'g7', def: NAND, at: [35, 12] },
      { name: 'g8', def: NAND, at: [42, 9] },
      { name: 'g9', def: NAND, at: [42, 17] },
    ],
    nets: [
      { name: 'a', ends: ['a', 'g2.a', 'g1.a'], trunk: 3 },
      { name: 'b', ends: ['b', 'g3.b', 'g1.b'], trunk: 4 },
      { name: 'cin', ends: ['cin', 'g5.b', 'g7.a'], trunk: 26 },
      { name: 'm1', ends: ['g1.y', 'g2.b', 'g3.a', 'g9.a'] },
      { name: 'p1', ends: ['g2.y', 'g4.a'] },
      { name: 'q1', ends: ['g3.y', 'g4.b'] },
      { name: 'x1', ends: ['g4.y', 'g5.a', 'g6.a'] },
      { name: 'm2', ends: ['g5.y', 'g6.b', 'g7.b', 'g9.b'] },
      { name: 'p2', ends: ['g6.y', 'g8.a'] },
      { name: 'q2', ends: ['g7.y', 'g8.b'] },
      { name: 's', ends: ['g8.y', 's'] },
      { name: 'cout', ends: ['g9.y', 'cout'] },
    ],
  }),
  hdl: {
    verilog: `// Nine-NAND full adder: the carry reuses the first NAND of each XOR cell.
module full_adder (input logic a, b, cin, output logic s, cout);
  logic m1, p1, q1, x1, m2, p2, q2;
  nand2 g1 (.a(a),   .b(b),   .y(m1));   // m1 = ~(a·b)
  nand2 g2 (.a(a),   .b(m1),  .y(p1));
  nand2 g3 (.a(b),   .b(m1),  .y(q1));
  nand2 g4 (.a(p1),  .b(q1),  .y(x1));   // x1 = a ^ b
  nand2 g5 (.a(x1),  .b(cin), .y(m2));   // m2 = ~(x1·cin)
  nand2 g6 (.a(x1),  .b(m2),  .y(p2));
  nand2 g7 (.a(cin), .b(m2),  .y(q2));
  nand2 g8 (.a(p2),  .b(q2),  .y(s));    // s  = x1 ^ cin
  nand2 g9 (.a(m1),  .b(m2),  .y(cout)); // cout = a·b + x1·cin
endmodule`,
  },
});

/** n-bit ripple-carry adder: a column of full adders, carry flowing top to bottom. */
export const rca = memo((n: number): ComponentDef => {
  const P = 10; // row pitch
  const X = 10, Y0 = 3;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), P), at: [4, Y0 - 3] },
    { name: 'sb', def: splitter(ones(n), P), at: [7, Y0 - 1] },
    { name: 'ms', def: merger(ones(n), P), at: [19, Y0 - 2] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] },
    { name: 'b', ends: ['b', 'sb.in'] },
    { name: 's', ends: ['ms.out', 's'] },
    { name: 'c0', ends: ['cin', 'fa0.cin'] },
  ];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `fa${i}`, def: FULL_ADDER, at: [X, Y0 + P * i] });
    nets.push({ name: `a${i}`, ends: [`sa.o${i}`, `fa${i}.a`] });
    nets.push({ name: `b${i}`, ends: [`sb.o${i}`, `fa${i}.b`] });
    nets.push({ name: `s${i}`, ends: [`fa${i}.s`, `ms.i${i}`] });
    nets.push({ name: `c${i + 1}`, ends: [`fa${i}.cout`, i < n - 1 ? `fa${i + 1}.cin` : 'cout'] });
  }
  const M = mask(n);
  return define({
    id: `rca${n}`, name: `${n}-bit ripple-carry adder`, category: 'arithmetic',
    summary: `${n} full adders in a chain. Simple and small, but the carry must ripple through every stage.`,
    ports: [
      { name: 'a', width: n, dir: 'in' }, { name: 'b', width: n, dir: 'in' }, bit('cin', 'in', 'top'),
      { name: 's', width: n, dir: 'out' }, bit('cout', 'out', 'bottom'),
    ],
    symbol: { kind: 'box', label: `ADD${n}` },
    spec: ([a, b, c]) => {
      const t = a + b + c;
      return [t % (M + 1), t > M ? 1 : 0];
    },
    netlist: () => ({
      pins: { a: [1, Y0 - 3 + 5 * n], b: [1, Y0 - 1 + 5 * n], cin: [X + 3, 0], s: [24, Y0 - 2 + 5 * n], cout: [X + 3, Y0 + P * n] },
      pinDirs: { cin: 'down', cout: 'up' },
      instances, nets,
    }),
    hdl: {
      verilog: `module rca #(parameter int N = ${n}) (input logic [N-1:0] a, b, input logic cin,
                                    output logic [N-1:0] s, output logic cout);
  logic [N:0] c;
  assign c[0] = cin;
  for (genvar i = 0; i < N; i++) begin : bit_
    full_adder fa (.a(a[i]), .b(b[i]), .cin(c[i]), .s(s[i]), .cout(c[i+1]));
  end
  assign cout = c[N];
endmodule`,
    },
  });
});

/** a ± b: invert b through XOR gates and inject the +1 as the carry-in (two's complement). */
export const addSub = memo((n: number): ComponentDef => {
  const P = 10, X = 18, Y0 = 3;
  const xorAt = (i: number): [number, number] => [11, Y0 + P * i + 3]; // below the a-line, jogs up into fa.b
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(n), P), at: [4, Y0 - 3] },
    { name: 'sb', def: splitter(ones(n), P), at: [6, Y0 - 1] },
    { name: 'ms', def: merger(ones(n), P), at: [27, Y0 - 2] },
  ];
  const subEnds = ['sub'];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] },
    { name: 'b', ends: ['b', 'sb.in'] },
    { name: 's', ends: ['ms.out', 's'] },
  ];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `x${i}`, def: XOR, at: xorAt(i) });
    instances.push({ name: `fa${i}`, def: FULL_ADDER, at: [X, Y0 + P * i] });
    nets.push({ name: `a${i}`, ends: [`sa.o${i}`, `fa${i}.a`] });
    nets.push({ name: `b${i}`, ends: [`sb.o${i}`, `x${i}.a`] });
    nets.push({ name: `bx${i}`, ends: [`x${i}.y`, `fa${i}.b`] });
    nets.push({ name: `s${i}`, ends: [`fa${i}.s`, `ms.i${i}`] });
    nets.push({ name: `c${i + 1}`, ends: [`fa${i}.cout`, i < n - 1 ? `fa${i + 1}.cin` : 'cout'] });
    subEnds.push(`x${i}.b`);
  }
  subEnds.push('fa0.cin');
  nets.push({
    name: 'sub', ends: subEnds, trunk: 9,
    via: { 'fa0.cin': [[9, 0], [X + 3, 0]] },
  });
  const M = mask(n);
  return define({
    id: `addsub${n}`, name: `${n}-bit adder / subtractor`, category: 'arithmetic',
    summary: 'sub = 0: a + b. sub = 1: a + NOT b + 1 = a − b in two\'s complement. One adder does both.',
    ports: [
      { name: 'a', width: n, dir: 'in' }, { name: 'b', width: n, dir: 'in' }, bit('sub', 'in'),
      { name: 's', width: n, dir: 'out' }, bit('cout', 'out'),
    ],
    symbol: { kind: 'box', label: `ADD/SUB${n}` },
    spec: ([a, b, sub]) => {
      const t = a + (sub ? (~b & M) >>> 0 : b) + sub;
      return [t % (M + 1), t > M ? 1 : 0];
    },
    netlist: () => ({
      pins: { a: [1, Y0 - 3 + 5 * n], b: [1, Y0 - 1 + 5 * n], sub: [1, Y0 + P * n + 2], s: [32, Y0 - 2 + 5 * n], cout: [X + 3, Y0 + P * n + 1] },
      pinDirs: { cout: 'up' },
      instances, nets,
    }),
  });
});

/** a + 1, as a chain of half adders (used by counters and the program counter). */
export const incrementer = memo((n: number): ComponentDef => {
  const P = 8, X = 10, Y0 = 4;
  const instances: InstanceDef[] = [
    { name: 'one', def: TIE1, at: [X + 2, 0] },
    { name: 'sa', def: splitter(ones(n), P), at: [5, Y0 + 2 - P / 2] },
    { name: 'my', def: merger(ones(n), P), at: [20, Y0 + 2 - P / 2] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] },
    { name: 'y', ends: ['my.out', 'y'] },
    { name: 'c0', ends: ['one.y', 'ha0.b'], via: { 'ha0.b': [[X + 5, 1], [X + 5, Y0 - 1], [X + 3, Y0 - 1]] } },
  ];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `ha${i}`, def: HALF_ADDER, at: [X, Y0 + P * i] });
    nets.push({ name: `a${i}`, ends: [`sa.o${i}`, `ha${i}.a`] });
    nets.push({ name: `y${i}`, ends: [`ha${i}.s`, `my.i${i}`] });
    nets.push({ name: `c${i + 1}`, ends: [`ha${i}.c`, i < n - 1 ? `ha${i + 1}.b` : 'cout'] });
  }
  const M = mask(n);
  return define({
    id: `inc${n}`, name: `${n}-bit incrementer`, category: 'arithmetic',
    summary: 'Adds 1. Half adders suffice because one operand is the constant 1, injected as the first carry.',
    ports: [{ name: 'a', width: n, dir: 'in' }, { name: 'y', width: n, dir: 'out' }, bit('cout', 'out')],
    symbol: { kind: 'box', label: '+1' },
    spec: ([a]) => [(a + 1) % (M + 1), a === M ? 1 : 0],
    netlist: () => ({
      pins: { a: [1, Y0 + 2 - P / 2 + (P * n) / 2], y: [25, Y0 + 2 - P / 2 + (P * n) / 2], cout: [X + 3, Y0 + P * n + 1] },
      pinDirs: { cout: 'up' },
      instances, nets,
    }),
  });
});

// ---- wide gates, decoders, multiplexers -------------------------------------------------

/** n-input AND as a balanced tree of 2-input ANDs. */
export const andN = memo((n: number): ComponentDef => {
  if (n === 2) return AND;
  const ins = Array.from({ length: n }, (_, i) => bit(`i${i}`, 'in'));
  // Build the tree level by level; each node is the name of a signal endpoint.
  const instances: InstanceDef[] = [];
  const nets: NetDef[] = [];
  let level: string[] = ins.map((p) => p.name);
  let col = 0, k = 0;
  // Leaves are pins at y = 2 + 2i.
  const ypos = new Map<string, number>(level.map((s, i) => [s, 2 + 2 * i]));
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i + 1 < level.length; i += 2) {
      const name = `g${k++}`;
      const ya = ypos.get(level[i])!, yb = ypos.get(level[i + 1])!;
      const yc = (ya + yb) / 2;
      instances.push({ name, def: AND, at: [5 + col * 8, yc - 2] });
      nets.push({ ends: [level[i], `${name}.a`] });
      nets.push({ ends: [level[i + 1], `${name}.b`] });
      next.push(`${name}.y`);
      ypos.set(`${name}.y`, yc);
    }
    if (level.length % 2) next.push(level[level.length - 1]);
    level = next;
    col++;
  }
  const outY = ypos.get(level[0])!;
  nets.push({ ends: [level[0], 'y'] });
  // Each tree edge was declared as [source, sink]; that is already driver-first.
  return define({
    id: `and${n}`, name: `${n}-input AND`, category: 'gate',
    summary: `1 only when all ${n} inputs are 1. A tree of ${n - 1} two-input ANDs.`,
    ports: [...ins, bit('y', 'out')],
    symbol: { kind: 'and' },
    spec: (v) => [v.every((x) => x === 1) ? 1 : 0],
    netlist: () => ({
      pins: { ...Object.fromEntries(ins.map((p, i) => [p.name, [1, 2 + 2 * i] as [number, number]])), y: [5 + col * 8 + 2, outY] },
      instances, nets,
    }),
  });
});

/**
 * n → 2^n decoder with optional enable: y_k = (a == k) [& en].
 * Drawn the classic way: a true and a complement rail per address bit, one AND per output.
 */
export const decoder = memo((n: number, en: boolean = false, rowPitch: number = 0): ComponentDef => {
  const N = 2 ** n;
  const g = andN(n + (en ? 1 : 0));
  const gh = symbolGeom(g).h;
  const pitch = Math.max(gh + 2, rowPitch);
  const T = (i: number) => 8 + 7 * i; // true rail x
  const C = (i: number) => T(i) + 5; // complement rail x
  const EN = T(n);
  const XG = EN + 3 + (en ? 2 : 0);
  const Y0 = 2 * n + 4;
  const instances: InstanceDef[] = [{ name: 'sa', def: splitter(ones(n)), at: [3, 0] }];
  const trueEnds: string[][] = Array.from({ length: n }, (_, i) => [`sa.o${i}`, `inv${i}.a`]);
  const compEnds: string[][] = Array.from({ length: n }, (_, i) => [`inv${i}.y`]);
  const enEnds: string[] = ['en'];
  for (let i = 0; i < n; i++) instances.push({ name: `inv${i}`, def: NOT, at: [T(i) + 1, 2 * i] });
  const gIn = g.ports.filter((p) => p.dir === 'in').map((p) => p.name);
  const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }];
  for (let k = 0; k < N; k++) {
    instances.push({ name: `g${k}`, def: g, at: [XG, Y0 + pitch * k] });
    for (let i = 0; i < n; i++) ((k >> i) & 1 ? trueEnds : compEnds)[i].push(`g${k}.${gIn[i]}`);
    if (en) enEnds.push(`g${k}.${gIn[n]}`);
    nets.push({ name: `y${k}`, ends: [`g${k}.y`, `y${k}`] });
  }
  for (let i = 0; i < n; i++) {
    nets.push({ name: `a${i}`, ends: trueEnds[i], trunk: T(i) });
    nets.push({ name: `a${i}_n`, ends: compEnds[i], trunk: C(i) });
  }
  if (en) nets.push({ name: 'en', ends: enEnds, trunk: EN });
  const outs = Array.from({ length: N }, (_, k) => bit(`y${k}`, 'out'));
  const pins: Record<string, [number, number]> = { a: [0, n] };
  if (en) pins.en = [0, Y0 - 2];
  outs.forEach((p, k) => (pins[p.name] = [XG + 7, Y0 + pitch * k + gh / 2]));
  return define({
    id: `dec${n}${en ? 'e' : ''}${rowPitch ? `_p${rowPitch}` : ''}`, name: `${n}→${N} decoder${en ? ' with enable' : ''}`, category: 'routing',
    summary: `Turns an ${n}-bit number into ${N} wires, exactly one of which is 1${en ? ' (when enabled)' : ''}. One AND per output.`,
    ports: [{ name: 'a', width: n, dir: 'in' }, ...(en ? [bit('en', 'in')] : []), ...outs],
    symbol: { kind: 'box', label: `DEC ${n}→${N}`, pitch: rowPitch || undefined },
    spec: ([a, e]) => Array.from({ length: N }, (_, k) => (a === k && (!en || e === 1) ? 1 : 0)),
    netlist: () => ({ pins, instances, nets }),
  });
});

/** W-bit 2:1 multiplexer: W MUX2 cells sharing one select. */
export const busMux2 = memo((w: number): ComponentDef => {
  if (w === 1) return MUX2;
  const P = 8, X = 12, Y0 = 3;
  const instances: InstanceDef[] = [
    { name: 'sa', def: splitter(ones(w), P), at: [4, Y0 - 2] },
    { name: 'sb', def: splitter(ones(w), P), at: [7, Y0] },
    { name: 'my', def: merger(ones(w), P), at: [20, Y0 - 1] },
  ];
  const sEnds = ['s'];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'sa.in'] },
    { name: 'b', ends: ['b', 'sb.in'] },
    { name: 'y', ends: ['my.out', 'y'] },
  ];
  for (let i = 0; i < w; i++) {
    instances.push({ name: `m${i}`, def: MUX2, at: [X, Y0 + P * i] });
    nets.push({ name: `a${i}`, ends: [`sa.o${i}`, `m${i}.a`] });
    nets.push({ name: `b${i}`, ends: [`sb.o${i}`, `m${i}.b`] });
    nets.push({ name: `y${i}`, ends: [`m${i}.y`, `my.i${i}`] });
    sEnds.push(`m${i}.s`);
  }
  nets.push({ name: 's', ends: sEnds, trunk: 10.5 });
  return define({
    id: `mux2x${w}`, name: `${w}-bit 2:1 multiplexer`, category: 'routing',
    summary: `Chooses between two ${w}-bit buses: one MUX2 per bit, all sharing the select line.`,
    ports: [{ name: 'a', width: w, dir: 'in' }, { name: 'b', width: w, dir: 'in' }, bit('s', 'in', 'bottom'), { name: 'y', width: w, dir: 'out' }],
    symbol: { kind: 'mux' },
    spec: ([a, b, s]) => [s ? b : a],
    netlist: () => ({
      pins: { a: [1, Y0 - 2 + (P * w) / 2], b: [1, Y0 + (P * w) / 2], s: [1, Y0 + P * w + 1], y: [24, Y0 - 1 + (P * w) / 2] },
      instances, nets,
    }),
  });
});

/**
 * 2^k : 1 multiplexer of W-bit words, as a binary tree of 2:1 multiplexers.
 * Select bit 0 drives the first column, bit k-1 the last.
 */
export const muxTree = memo((k: number, w: number, pitch: number = 2): ComponentDef => {
  const N = 2 ** k;
  const m2 = busMux2(w);
  const mh = symbolGeom(m2).h;
  const rowP = Math.max(mh + 2, 8);
  const instances: InstanceDef[] = [{ name: 'ss', def: splitter(ones(k)), at: [2, N * rowP + 4] }];
  const nets: NetDef[] = [{ name: 's', ends: ['s', 'ss.in'] }];
  const yIn = (j: number) => 2 + (rowP / 2) * j; // data pin y (column-0 mux inputs are rowP/2 apart)
  // Column 0 muxes take inputs 2j, 2j+1.
  let prev: { end: string; y: number }[] = Array.from({ length: N }, (_, j) => ({ end: `d${j}`, y: yIn(j) }));
  const selEnds: string[][] = Array.from({ length: k }, (_, l) => [`ss.o${l}`]);
  for (let l = 0; l < k; l++) {
    const next: { end: string; y: number }[] = [];
    const x = 8 + l * 12;
    for (let j = 0; j < prev.length / 2; j++) {
      const name = `m${l}_${j}`;
      const ya = prev[2 * j].y, yb = prev[2 * j + 1].y;
      const top = (ya + yb) / 2 - mh / 2;
      instances.push({ name, def: m2, at: [x, top] });
      nets.push({ ends: [prev[2 * j].end, `${name}.a`] });
      nets.push({ ends: [prev[2 * j + 1].end, `${name}.b`] });
      selEnds[l].push(`${name}.s`);
      next.push({ end: `${name}.y`, y: top + mh / 2 });
    }
    prev = next;
  }
  nets.push({ ends: [prev[0].end, 'y'] });
  for (let l = 0; l < k; l++) nets.push({ name: `s${l}`, ends: selEnds[l], trunk: 8 + l * 12 - 2 });
  const pins: Record<string, [number, number]> = { s: [0, N * rowP + 4 + k] , y: [8 + k * 12 + 2, prev[0].y] };
  for (let j = 0; j < N; j++) pins[`d${j}`] = [1, yIn(j)];
  return define({
    id: `mux${N}x${w}${pitch !== 2 ? `_p${pitch}` : ''}`, name: `${N}:1 multiplexer (${w}-bit)`, category: 'routing',
    summary: `Selects one of ${N} ${w}-bit inputs. A tree of ${N - 1} two-input multiplexers, ${k} levels deep.`,
    ports: [
      ...Array.from({ length: N }, (_, j): PortDef => ({ name: `d${j}`, width: w, dir: 'in' })),
      { name: 's', width: k, dir: 'in', side: 'bottom' },
      { name: 'y', width: w, dir: 'out' },
    ],
    symbol: { kind: pitch === 2 && N <= 8 ? 'mux' : 'box', label: `MUX ${N}:1`, pitch },
    spec: (v) => [v[v[N]]],
    netlist: () => ({ pins, instances, nets }),
  });
});
