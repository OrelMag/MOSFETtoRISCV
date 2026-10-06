// More multipliers: the iterative shift-and-add multiplier (one adder, n cycles), a radix-4 Booth
// multiplier (half the partial products, signed), and a two-stage pipelined version of it.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { busMux2, rca } from './combinational';
import { Builder } from './builder';
import { define, merger, ones, splitter } from './define';
import { iterCtrl } from './divide';
import { fanout, koggeStone } from './fastadd';
import { XNOR, XOR } from './gates';
import { BOOTH_ENC, compressor } from './muldiv';
import { register } from './sequential';
import { NAND, TIE0 } from './transistors';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const B = (v: number) => BigInt(v);
const sx = (v: number, n: number) => (v >= 2 ** (n - 1) ? B(v) - (1n << B(n)) : B(v));
const lowBits = (v: bigint, w: number) => Number(BigInt.asUintN(w, v));

// ---- shift and add -------------------------------------------------------------------------------

/**
 * Iterative unsigned multiplier: the product register starts as {0, b}. Each step adds a to the upper
 * half if the lowest bit is 1, then shifts the whole register right by one (the adder's carry enters
 * at the top). After n steps it holds a·b. One n-bit adder, n + 2 cycles.
 */
export function seqMul(n: number): ComponentDef {
  return memo(`smul${n}`, () => {
    const REG = register(n), MX = busMux2(n), ADD = rca(n), C = iterCtrl(n), A = bitwise('and', n);
    const rg = symbolGeom(REG), mg = symbolGeom(MX), ag = symbolGeom(ADD), cg = symbolGeom(C), andg = symbolGeom(A);
    const x1 = 12, x2 = x1 + mg.w + 8, x3 = x2 + rg.w + 14, x4 = x3 + andg.w + 10, x5 = x4 + ag.w + 12;
    const yH = 4, yL = yH + rg.h + 12, yA = yL + rg.h + 12, yC = yA + rg.h + 12;
    const instances: InstanceDef[] = [
      { name: 'mh', def: MX, at: [x1, yH], label: 'load 0' },
      { name: 'rh', def: REG, at: [x2, yH], label: 'product (high)' },
      { name: 'ml', def: MX, at: [x1, yL], label: 'load b' },
      { name: 'rl', def: REG, at: [x2, yL], label: 'product (low) / multiplier' },
      { name: 'ra', def: REG, at: [x2, yA], label: 'multiplicand' },
      { name: 'z', def: constWord(n, 0), at: [2, yH - 2] },
      { name: 'sl', def: splitter([1, n - 1]), at: [x2 + rg.w + 4, yL + 2] },
      { name: 'f', def: fanout(n), at: [x3 - 6, yA + andg.ports.b.pos[1] - 1] },
      { name: 'sel', def: A, at: [x3, yA], label: 'a if bit = 1' },
      { name: 'gz', def: TIE0, at: [x4 - 4, yH - 4] },
      { name: 'add', def: ADD, at: [x4, yH] },
      { name: 'ss', def: splitter([1, n - 1]), at: [x5, yH + ag.ports.s.pos[1] - 2] },
      { name: 'nh', def: merger([n - 1, 1]), at: [x5 + 12, yH + ag.ports.s.pos[1] - 1] },
      { name: 'nl', def: merger([n - 1, 1]), at: [x5 + 12, yL + 2] },
      { name: 'mp', def: merger([n, n], 4), at: [x5 + 22, yH + 6] },
      { name: 'ctl', def: C, at: [x1, yC] },
    ];
    const nets: NetDef[] = [
      { name: 'start', ends: ['start', 'ctl.start'] },
      { name: 'clk', ends: ['clk', 'ctl.clk', 'rh.clk', 'rl.clk', 'ra.clk'], tags: ['rh.clk', 'rl.clk', 'ra.clk'] },
      { name: 'load', ends: ['ctl.load', 'mh.s', 'ml.s', 'ra.en'], tags: true },
      { name: 'step', ends: ['ctl.step', 'rh.en', 'rl.en'], tags: true },
      { name: 'zero', ends: ['z.y', 'mh.b'] },
      { name: 'b', ends: ['b', 'ml.b'] },
      { name: 'a', ends: ['a', 'ra.d'] },
      { name: 'Hd', ends: ['mh.y', 'rh.d'] }, { name: 'Ld', ends: ['ml.y', 'rl.d'] },
      { name: 'H', ends: ['rh.q', 'add.a', 'mp.i1'], tags: ['mp.i1'] },
      { name: 'L', ends: ['rl.q', 'sl.in', 'mp.i0'], tags: ['mp.i0'] },
      { name: 'bit', ends: ['sl.o0', 'f.in'], tags: true },
      { name: 'Lhigh', ends: ['sl.o1', 'nl.i0'], tags: true },
      { name: 'A', ends: ['ra.q', 'sel.a'] },
      { ends: ['f.out', 'sel.b'] },
      { name: 'addend', ends: ['sel.y', 'add.b'], tags: true },
      { ends: ['gz.y', 'add.cin'] },
      { name: 'sum', ends: ['add.s', 'ss.in'] },
      { name: 'out', ends: ['ss.o0', 'nl.i1'], tags: true },
      { name: 'sumHigh', ends: ['ss.o1', 'nh.i0'] },
      { name: 'carry', ends: ['add.cout', 'nh.i1'], tags: true },
      { name: 'Hnext', ends: ['nh.out', 'mh.a'], tags: true },
      { name: 'Lnext', ends: ['nl.out', 'ml.a'], tags: true },
      { name: 'p', ends: ['mp.out', 'p'] },
      { name: 'done', ends: ['ctl.done', 'done'] },
      { name: 'busy', ends: ['ctl.busy', 'busy'] },
    ];
    const right = x5 + 30;
    return define({
      id: `smul${n}`, name: `${n}-bit iterative multiplier`, category: 'sequential',
      summary: `Shift and add, one bit of b per clock: if the low bit of the product register is 1, add a to its upper half; shift everything right. ${n} steps on one ${n}-bit adder, ${n + 2} cycles per product.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', n, 'in'), bus('b', n, 'in'), bus('p', 2 * n, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: `MUL${n} (iterative)` },
      netlist: () => ({
        pins: {
          start: [0, yC + cg.ports.start.pos[1]], clk: [0, yC + cg.h + 4], a: [0, yA + 4], b: [0, yL + 6],
          p: [right, yH + 10], done: [right, yC + cg.ports.done.pos[1]], busy: [right, yC + cg.ports.busy.pos[1]],
        },
        instances, nets,
      }),
      hdl: {
        verilog: `module seq_mul #(parameter int N = ${n}) (input logic clk, start, input logic [N-1:0] a, b,
                 output logic [2*N-1:0] p, output logic done, busy);
  logic [N-1:0] h, l, m;
  wire [N:0] sum = h + (l[0] ? m : '0);
  assign p = {h, l};
  // iteration control as in seq_divider
  always_ff @(posedge clk)
    if (load) begin h <= '0; l <= b; m <= a; end
    else if (busy) {h, l} <= {sum, l[N-1:1]};
endmodule`,
      },
    });
  });
}

// ---- radix-4 Booth ----------------------------------------------------------------------------------

/** One bit of a Booth partial product: ((one·a_i) + (two·a_{i−1})) XOR neg (XNOR for the flipped sign bit). */
function boothBit(flip: boolean): ComponentDef {
  const id = `boothbit${flip ? 's' : ''}`;
  return memo(id, () => define({
    id, name: flip ? 'Booth sign bit (inverted)' : 'Booth partial-product bit', category: 'arithmetic',
    summary: flip
      ? 'The top bit of a partial product, inverted: with the constant row this replaces sign extension.'
      : 'Selects a_i (digit ±1), a_{i−1} (±2: a shifted left) or 0, and inverts it when the digit is negative.',
    ports: [bit('one', 'in'), bit('ai', 'in'), bit('two', 'in'), bit('aim1', 'in'), bit('neg', 'in'), bit('p', 'out')],
    symbol: { kind: 'box', label: flip ? 'BIT±' : 'BIT' },
    spec: ([one, ai, two, aim1, neg]) => [(((one & ai) | (two & aim1)) ^ neg ^ (flip ? 1 : 0))],
    netlist: () => ({
      pins: { one: [0, 2], ai: [0, 4], two: [0, 8], aim1: [0, 10], neg: [0, 14], p: [24, 7] },
      instances: [
        { name: 'x', def: NAND, at: [4, 1] }, { name: 'y', def: NAND, at: [4, 7] }, { name: 'o', def: NAND, at: [11, 4] },
        { name: 'v', def: flip ? XNOR : XOR, at: [17, 5] },
      ],
      nets: [
        { ends: ['one', 'x.a'] }, { ends: ['ai', 'x.b'] }, { ends: ['two', 'y.a'] }, { ends: ['aim1', 'y.b'] },
        { ends: ['x.y', 'o.a'] }, { ends: ['y.y', 'o.b'] }, { name: 'sel', ends: ['o.y', 'v.a'] },
        { name: 'neg', ends: ['neg', 'v.b'] }, { name: 'p', ends: ['v.y', 'p'] },
      ],
    }),
    hdl: { verilog: `assign p = ((one & ai) | (two & aim1)) ^ ${flip ? '~' : ''}neg;` },
  }));
}

/** A Booth partial-product row: n + 1 bits of ±a, ±2a or 0 (inverted when negative), sign bit flipped. */
export function boothRow(n: number): ComponentDef {
  const W = n + 1;
  return memo(`boothrow${n}`, () => {
    const P = 18, BB = boothBit(false), BS = boothBit(true), bg = symbolGeom(BB);
    // a extended to n + 1 bits (sign copied): bit i of a_ext is a[min(i, n − 1)]
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter(ones(n), P), at: [6, 2 + bg.ports.ai.pos[1] - P / 2] },
      { name: 'z', def: TIE0, at: [8, -4] },
      { name: 'mp', def: merger(ones(W), P), at: [14 + bg.w + 6, 2 + bg.ports.p.pos[1] - P / 2] },
    ];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'pp', ends: ['mp.out', 'pp'] }];
    const ctl: Record<'one' | 'two' | 'neg', string[]> = { one: ['one'], two: ['two'], neg: ['neg'] };
    const aEnds: string[][] = Array.from({ length: n }, (_, i) => [`sa.o${i}`]);
    const zEnds = ['z.y'];
    for (let i = 0; i < W; i++) {
      const nm = `b${i}`;
      instances.push({ name: nm, def: i === n ? BS : BB, at: [14, 2 + P * i], label: `bit ${i}` });
      aEnds[Math.min(i, n - 1)].push(`${nm}.ai`);
      if (i === 0) zEnds.push(`${nm}.aim1`);
      else aEnds[Math.min(i - 1, n - 1)].push(`${nm}.aim1`);
      for (const k of ['one', 'two', 'neg'] as const) ctl[k].push(`${nm}.${k}`);
      nets.push({ ends: [`${nm}.p`, `mp.i${i}`] });
    }
    aEnds.forEach((e, i) => nets.push({ name: `a${i}`, ends: e, tags: e.slice(2) }));
    nets.push({ name: '0', ends: zEnds });
    for (const k of ['one', 'two', 'neg'] as const) nets.push({ name: k, ends: ctl[k], tags: ctl[k].slice(1) });
    return define({
      id: `boothrow${n}`, name: `${n}-bit Booth partial-product row`, category: 'arithmetic',
      summary: `One radix-4 digit times a: 0, ±a or ±2a, ${W} bits wide (2a needs one more bit). Negative digits come out inverted; the missing +1 is added as a separate bit, and the inverted sign bit plus a constant row replace sign extension.`,
      ports: [bus('a', n, 'in'), bit('one', 'in'), bit('two', 'in'), bit('neg', 'in'), bus('pp', W, 'out')],
      symbol: { kind: 'box', label: 'BOOTH ROW' },
      spec: ([a, one, two, neg]) => {
        const v = (one ? BigInt.asUintN(W, sx(a, n)) : 0n) | (two ? BigInt.asUintN(W, 2n * sx(a, n)) : 0n);
        return [Number(BigInt.asUintN(W, neg ? ~v : v) ^ (1n << B(n)))];
      },
      netlist: () => ({ pins: { a: [0, 2 + bg.ports.ai.pos[1] + (P * (n - 1)) / 2], one: [0, 2 + P * W], two: [0, 4 + P * W], neg: [0, 6 + P * W], pp: [14 + bg.w + 14, 2 + bg.ports.p.pos[1] + (P * (W - 1)) / 2] }, instances, nets }),
    });
  });
}

type Word = { lo: number; w: number; drv: string };

/** Booth radix-4 partial products (n even): n/2 digits of b, one row of 0 / ±a / ±2a each, and their +1 bits. */
export function boothPP(n: number): ComponentDef {
  const m = n / 2;
  return memo(`bpp${n}`, () => {
    const b = new Builder(8, 18);
    b.pins('a', 'b');
    // digits from b: bit triples (2j+1, 2j, 2j−1), with b_{−1} = 0
    const sb = b.op(splitter(ones(n)), ['b']);
    const z = b.op1(TIE0, []);
    b.next();
    const bitOf = (i: number) => (i < 0 ? z : `${sb}.o${Math.min(i, n - 1)}`);
    const enc = Array.from({ length: m }, (_, j) => b.op(BOOTH_ENC, [bitOf(2 * j + 1), bitOf(2 * j), bitOf(2 * j - 1)], `digit ${j}`));
    for (const e of enc) for (const k of ['one', 'two', 'neg']) b.name(`${e}.${k}`, `${k}${enc.indexOf(e)}`, true);
    b.next();
    const rows = enc.map((e, j) => b.op1(boothRow(n), ['a', `${e}.one`, `${e}.two`, `${e}.neg`], `row ${j}`));
    b.next();
    rows.forEach((r, j) => b.wire(r, `pp${j}`));
    b.wire(b.op1(merger(ones(m)), enc.map((e) => `${e}.neg`), '+1 bits'), 'neg');
    const R = b.right;
    const pins: Record<string, [number, number]> = { a: [0, 6], b: [0, 2], neg: [R, 4 + 4 * m] };
    for (let j = 0; j < m; j++) pins[`pp${j}`] = [R, 2 + 4 * j];
    return define({
      id: `bpp${n}`, name: `${n}-bit Booth partial products`, category: 'arithmetic',
      summary: `${m} radix-4 digits of b (each from three overlapping bits), and for each one a row of 0, ±a or ±2a (${n + 1} bits, inverted when negative, sign bit flipped). The +1 that completes each negation comes out separately, one bit per row.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), ...Array.from({ length: m }, (_, j) => bus(`pp${j}`, n + 1, 'out')), bus('neg', m, 'out')],
      symbol: { kind: 'box', label: 'BOOTH PP' },
      netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Reduce the Booth rows, their +1 bits and the sign constant to two words with a Wallace tree of 3:2 compressors. */
export function boothReduce(n: number): ComponentDef {
  const m = n / 2, W = 2 * n;
  return memo(`bred${n}`, () => {
    const b = new Builder(16, 10);
    b.pins('neg', ...Array.from({ length: m }, (_, j) => `pp${j}`));
    const sn = b.op(splitter(ones(m)), ['neg']);
    b.next();
    const words: Word[] = [];
    let k = 0n; // sum of the sign-extension constants, mod 2^W
    for (let j = 0; j < m; j++) {
      words.push({ lo: 2 * j, w: n + 1, drv: `pp${j}` });
      words.push({ lo: 2 * j, w: 1, drv: `${sn}.o${j}` });
      k -= 1n << B(n + 2 * j);
    }
    const K = BigInt.asUintN(W, k);
    let lowest = 0;
    while (lowest < W && !((K >> B(lowest)) & 1n)) lowest++;
    if (lowest < W) words.push({ lo: lowest, w: W - lowest, drv: b.op1(constWord(W - lowest, Number(K >> B(lowest))), [], 'sign constant') });
    const count = words.length;
    let level = 0;
    let live = words;
    while (live.length > 2) {
      b.next();
      const next: Word[] = [];
      let i = 0;
      for (; i + 3 <= live.length; i += 3) {
        const [x, y, zz] = live.slice(i, i + 3);
        const r = compressor({ lo: x.lo, w: x.w }, { lo: y.lo, w: y.w }, { lo: zz.lo, w: zz.w }, W);
        const nm = b.op(r.def, [x.drv, y.drv, zz.drv], `level ${level + 1}`);
        next.push({ lo: r.s.lo, w: r.s.w, drv: `${nm}.s` });
        if (r.c) next.push({ lo: r.c.lo, w: r.c.w, drv: `${nm}.c` });
      }
      next.push(...live.slice(i));
      live = next;
      level++;
    }
    b.next();
    const pad = (wd: Word) => {
      const parts: string[] = [], widths: number[] = [];
      if (wd.lo > 0) { widths.push(wd.lo); parts.push(b.op1(constWord(wd.lo, 0), [])); }
      widths.push(wd.w); parts.push(wd.drv);
      if (wd.lo + wd.w < W) { widths.push(W - wd.lo - wd.w); parts.push(b.op1(constWord(W - wd.lo - wd.w, 0), [])); }
      return widths.length === 1 ? wd.drv : b.op1(merger(widths), parts);
    };
    const s2 = pad(live[0]), c2 = live[1] ? pad(live[1]) : b.op1(constWord(W, 0), []);
    b.next();
    b.wire(s2, 's');
    b.wire(c2, 'c');
    const R = b.right;
    const pins: Record<string, [number, number]> = { neg: [0, 4 + 4 * m], s: [R, 4], c: [R, 8] };
    for (let j = 0; j < m; j++) pins[`pp${j}`] = [0, 2 + 4 * j];
    return define({
      id: `bred${n}`, name: `${n}-bit Booth reduction tree`, category: 'arithmetic',
      summary: `${m} rows, their ${m} +1 bits and one constant (it replaces the sign extension of every row): ${count} words reduced to two by ${level} levels of 3:2 compressors, without a carry chain.`,
      ports: [...Array.from({ length: m }, (_, j) => bus(`pp${j}`, n + 1, 'in')), bus('neg', m, 'in'), bus('s', W, 'out'), bus('c', W, 'out')],
      symbol: { kind: 'box', label: 'REDUCE' },
      netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Booth partial products and their reduction: s + c = a·b (signed, mod 2^2n). */
export function boothTree(n: number): ComponentDef {
  const m = n / 2, W = 2 * n;
  return memo(`btree${n}`, () => {
    const PP = boothPP(n), RD = boothReduce(n), pg = symbolGeom(PP), rg = symbolGeom(RD);
    const xr = 10 + pg.w + 12;
    const nets: NetDef[] = [
      { name: 'a', ends: ['a', 'pp.a'] }, { name: 'b', ends: ['b', 'pp.b'] },
      { name: 'neg', ends: ['pp.neg', 'rd.neg'] },
      { name: 's', ends: ['rd.s', 's'] }, { name: 'c', ends: ['rd.c', 'c'] },
    ];
    for (let j = 0; j < m; j++) nets.push({ name: `pp${j}`, ends: [`pp.pp${j}`, `rd.pp${j}`] });
    return define({
      id: `btree${n}`, name: `${n}×${n} Booth radix-4 partial products and tree`, category: 'arithmetic',
      summary: `Booth digits and rows, then the compressor tree: two ${W}-bit words whose sum is the signed product.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('s', W, 'out'), bus('c', W, 'out')],
      symbol: { kind: 'box', label: 'BOOTH TREE' },
      netlist: () => ({
        pins: { a: [0, 2 + pg.ports.a.pos[1]], b: [0, 2 + pg.ports.b.pos[1]], s: [xr + rg.w + 8, 2 + rg.ports.s.pos[1]], c: [xr + rg.w + 8, 2 + rg.ports.c.pos[1]] },
        instances: [{ name: 'pp', def: PP, at: [10, 2], label: 'digits and rows' }, { name: 'rd', def: RD, at: [xr, 2], label: '3:2 tree' }],
        nets,
      }),
    });
  });
}

/** Signed n×n → 2n radix-4 Booth multiplier: the Booth tree and one Kogge–Stone adder. */
export function boothMul(n: number): ComponentDef {
  return memo(`bmul${n}`, () => {
    const T = boothTree(n), tg = symbolGeom(T), K = koggeStone(2 * n), kg = symbolGeom(K);
    const xk = 10 + tg.w + 12;
    return define({
      id: `bmul${n}`, name: `${n}×${n} Booth multiplier (signed)`, category: 'arithmetic',
      summary: `Radix-4 Booth recoding halves the partial products (${n / 2} rows instead of ${n}), the tree reduces them to two words, one fast adder finishes. Signed operands need no extra correction.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('p', 2 * n, 'out')],
      symbol: { kind: 'box', label: `BOOTH MUL${n}` },
      spec: 2 * n <= 52 ? ([a, b]) => [lowBits(sx(a, n) * sx(b, n), 2 * n)] : undefined,
      netlist: () => ({
        pins: { a: [0, 2 + tg.ports.a.pos[1]], b: [0, 2 + tg.ports.b.pos[1]], p: [xk + kg.w + 8, 2 + kg.ports.s.pos[1]] },
        instances: [
          { name: 'tree', def: T, at: [10, 2] },
          { name: 'z', def: TIE0, at: [xk - 4, -3] },
          { name: 'cpa', def: K, at: [xk, 2], label: 'final adder' },
        ],
        nets: [
          { name: 'a', ends: ['a', 'tree.a'] }, { name: 'b', ends: ['b', 'tree.b'] },
          { name: 'sum', ends: ['tree.s', 'cpa.a'] }, { name: 'carry', ends: ['tree.c', 'cpa.b'] },
          { ends: ['z.y', 'cpa.cin'] }, { name: 'p', ends: ['cpa.s', 'p'] },
        ],
      }),
      hdl: { verilog: `assign p = $signed(a) * $signed(b);   // radix-4 Booth digits, Wallace tree, Kogge–Stone adder` },
    });
  });
}

/**
 * The Booth multiplier cut into three pipeline stages: operand registers → digits and rows → row
 * registers → compressor tree → sum/carry registers → final adder → product register. A new product
 * can start every cycle; each one appears four clock edges after its operands.
 */
export function pipeMul(n: number): ComponentDef {
  const m = n / 2, W = 2 * n;
  return memo(`pmul${n}`, () => {
    const b = new Builder(8, 10);
    const on = b.name(b.op1(constWord(1, 1), []), 'on', true);
    for (const p of ['a', 'b', 'clk']) b.name(p, p, true);
    b.next();
    const ra = b.op1(register(n), ['a', on, 'clk'], 'stage 0: a');
    const rb = b.op1(register(n), ['b', on, 'clk'], 'stage 0: b');
    b.next();
    const pp = b.op(boothPP(n), [ra, rb], 'stage 1: digits and rows');
    b.next();
    const rows = Array.from({ length: m }, (_, j) => b.op1(register(n + 1), [`${pp}.pp${j}`, on, 'clk'], `row ${j}`));
    const rn = b.op1(register(m), [`${pp}.neg`, on, 'clk'], '+1 bits');
    b.next();
    const rd = b.op(boothReduce(n), [...rows, rn], 'stage 2: 3:2 tree');
    b.next();
    const rs = b.op1(register(W), [`${rd}.s`, on, 'clk'], 'sum');
    const rc = b.op1(register(W), [`${rd}.c`, on, 'clk'], 'carry');
    b.next();
    const sum = b.op(koggeStone(W), [rs, rc, b.op1(TIE0, [])], 'stage 3: final adder');
    b.next();
    b.wire(b.op1(register(W), [`${sum}.s`, on, 'clk'], 'product'), 'p');
    const R = b.right;
    return define({
      id: `pmul${n}`, name: `${n}×${n} pipelined Booth multiplier`, category: 'sequential',
      summary: 'Registers after the operands, after the Booth rows and after the compressor tree: the clock period is the slowest stage instead of the whole multiplier. Latency four edges, throughput one product per cycle.',
      ports: [bit('clk', 'in', 'bottom', true), bus('a', n, 'in'), bus('b', n, 'in'), bus('p', W, 'out')],
      symbol: { kind: 'box', label: `PIPE MUL${n}` },
      netlist: () => ({ pins: { a: [0, 4], b: [0, 8], clk: [0, 14], p: [R, 6] }, instances: b.instances, nets: b.nets() }),
      hdl: {
        verilog: `always_ff @(posedge clk) begin
  {ra, rb}   <= {a, b};                       // stage 0
  {pp, neg}  <= booth_pp(ra, rb);             // stage 1: digits and rows
  {rs, rc}   <= booth_reduce(pp, neg);        // stage 2: 3:2 tree
  p          <= rs + rc;                      // stage 3: one carry-propagate adder
end`,
      },
    });
  });
}

/** Spec helper for tests: the signed product mod 2^(2n). */
export const boothRef = (a: number, b: number, n: number) => lowBits(sx(a, n) * sx(b, n), 2 * n);
