// Level 10: multiplication and division (the M extension).
//   ppRow → array multiplier (a staircase of adders) → carry-save compressors → Wallace tree + fast adder
//   → Baugh–Wooley signed products · divStep → array divider → iterative divider → the M unit in the CPU.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { mask } from '../sim/values';
import { constWord, isZero } from './alu';
import { FULL_ADDER, HALF_ADDER, addSub, andN, busMux2, incrementer, rca } from './combinational';
import { define, merger, ones, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR, XOR } from './gates';
import { DFF, register } from './sequential';
import { NAND, TIE0, TIE1 } from './transistors';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

const big = (v: number) => BigInt(Math.round(v));
const lowBits = (v: bigint, w: number) => Number(BigInt.asUintN(w, v));

// ---- partial products ------------------------------------------------------------------------

/** 'and': a·b. Baugh–Wooley rows invert the bits that pair a sign bit with a magnitude bit. */
export type PPMode = 'and' | 'bwTop' | 'bwLast';

/** One partial-product row: a AND b, bit by bit (n AND gates; Baugh–Wooley swaps some for plain NANDs). */
export function ppRow(n: number, mode: PPMode = 'and'): ComponentDef {
  return memo(`pp${n}_${mode}`, () => {
    const P = 6, X = 9, Y0 = 2;
    const gg = symbolGeom(AND);
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter(ones(n), P), at: [3, Y0 + gg.ports.a.pos[1] - P / 2] },
      { name: 'mp', def: merger(ones(n), P), at: [X + 8, Y0 + gg.ports.y.pos[1] - P / 2] },
    ];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }, { name: 'pp', ends: ['mp.out', 'pp'] }];
    const bEnds = ['b'];
    const inv = (i: number) => (mode === 'bwTop' ? i === n - 1 : mode === 'bwLast' ? i < n - 1 : false);
    for (let i = 0; i < n; i++) {
      instances.push({ name: `g${i}`, def: inv(i) ? NAND : AND, at: [X, Y0 + P * i] });
      nets.push({ name: `a${i}`, ends: [`sa.o${i}`, `g${i}.a`] }, { name: `p${i}`, ends: [`g${i}.y`, `mp.i${i}`] });
      bEnds.push(`g${i}.b`);
    }
    nets.push({ name: 'b', ends: bEnds, trunk: 6.5 });
    const flip = mode === 'bwTop' ? 2 ** (n - 1) : mode === 'bwLast' ? 2 ** (n - 1) - 1 : 0;
    const mid = (P * n) / 2;
    return define({
      id: `pp${n}${mode === 'and' ? '' : `_${mode}`}`,
      name: mode === 'and' ? `${n}-bit partial product` : `${n}-bit Baugh–Wooley partial product`,
      category: 'arithmetic',
      summary: mode === 'and'
        ? 'Multiplying by a single bit is AND: the row is a when b = 1 and 0 when b = 0. One AND gate per bit.'
        : mode === 'bwTop'
          ? 'Baugh–Wooley row: the bit that pairs a\'s sign bit with b_i is inverted (a NAND instead of an AND).'
          : 'Baugh–Wooley last row (b\'s sign bit): every bit except the sign×sign one is inverted.',
      ports: [bus('a', n, 'in'), bit('b', 'in'), bus('pp', n, 'out')],
      symbol: { kind: 'box', label: mode === 'and' ? 'a·bᵢ' : 'a·bᵢ (BW)' },
      spec: ([a, b]) => [((b ? a : 0) ^ flip) >>> 0],
      netlist: () => ({
        pins: { a: [1, Y0 + gg.ports.a.pos[1] - P / 2 + mid], b: [1, Y0 + P * n + 1], pp: [X + 13, Y0 + gg.ports.y.pos[1] - P / 2 + mid] },
        instances, nets,
      }),
      hdl: {
        verilog: mode === 'and'
          ? `assign pp = a & {${n}{b}};   // ${n} AND gates`
          : `assign pp = (a & {${n}{b}}) ^ ${n}'h${flip.toString(16)};   // inverted bits are NANDs`,
      },
    });
  });
}

// ---- array multiplier ---------------------------------------------------------------------------

/**
 * Unsigned n×n array multiplier: long multiplication in hardware. Row i adds partial product
 * a·b_i to the running sum shifted right by one; the bit that falls off the bottom is product bit i.
 */
export function arrayMul(n: number): ComponentDef {
  return memo(`amul${n}`, () => {
    const PP = ppRow(n), ADD = rca(n);
    const pg = symbolGeom(PP), ag = symbolGeom(ADD);
    const SPL = splitter([1, n - 1]), MRG = merger([n - 1, 1]);
    const instances: InstanceDef[] = [];
    const nets: NetDef[] = [];
    const rowH = Math.max(pg.h, ag.h) + 6, dx = 6;
    const aEnds = ['a'];
    instances.push({ name: 'sb', def: splitter(ones(n), rowH), at: [2, 2 + pg.ports.b.pos[1] - rowH / 2] });
    nets.push({ name: 'b', ends: ['b', 'sb.in'] });
    const prodBits: string[] = [];
    let prev = ''; // driver of W_{i-1}
    for (let i = 0; i < n; i++) {
      const y = 2 + rowH * i, x = 10 + dx * i;
      instances.push({ name: `pp${i}`, def: PP, at: [x, y], label: `a·b${i}` });
      aEnds.push(`pp${i}.a`);
      nets.push({ name: `b${i}`, ends: [`sb.o${i}`, `pp${i}.b`] });
      if (i === 0) {
        instances.push({ name: 'sp0', def: SPL, at: [x + pg.w + 3, y + pg.ports.pp.pos[1] - 2], label: undefined });
        nets.push({ name: 'pp0', ends: ['pp0.pp', 'sp0.in'] });
        instances.push({ name: 'w0', def: MRG, at: [x + pg.w + 7, y + pg.ports.pp.pos[1] - 1] });
        instances.push({ name: 'z0', def: TIE0, at: [x + pg.w + 4, y + pg.ports.pp.pos[1] + 2] });
        nets.push({ name: 'u0', ends: ['sp0.o1', 'w0.i0'] }, { ends: ['z0.y', 'w0.i1'] });
        prodBits.push('sp0.o0');
        prev = 'w0.out';
        continue;
      }
      const ax = x + pg.w + 6;
      instances.push({ name: `add${i}`, def: ADD, at: [ax, y], label: `row ${i}` });
      instances.push({ name: `gc${i}`, def: TIE0, at: [ax + ag.ports.cin.pos[0] - 1, y - 4] });
      nets.push(
        { name: i === 1 ? 'W0' : `W${i - 1}`, ends: [prev, `add${i}.a`] },
        { name: `pp${i}`, ends: [`pp${i}.pp`, `add${i}.b`] },
        { ends: [`gc${i}.y`, `add${i}.cin`] },
      );
      instances.push({ name: `sp${i}`, def: SPL, at: [ax + ag.w + 3, y + ag.ports.s.pos[1] - 2] });
      instances.push({ name: `w${i}`, def: MRG, at: [ax + ag.w + 7, y + ag.ports.s.pos[1] - 1] });
      nets.push(
        { name: `S${i}`, ends: [`add${i}.s`, `sp${i}.in`] },
        { name: `u${i}`, ends: [`sp${i}.o1`, `w${i}.i0`] },
        { name: `c${i}`, ends: [`add${i}.cout`, `w${i}.i1`] },
      );
      prodBits.push(`sp${i}.o0`);
      prev = `w${i}.out`;
    }
    nets.push({ name: 'a', ends: aEnds, trunk: 7 });
    const right = 10 + dx * (n - 1) + pg.w + 6 + ag.w + 16;
    const PM = merger([...ones(n), n]);
    instances.push({ name: 'mp', def: PM, at: [right, 2] });
    prodBits.forEach((d, i) => nets.push({ name: `p${i}`, ends: [d, `mp.i${i}`], tags: true }));
    nets.push({ name: `W${n - 1}`, ends: [prev, `mp.i${n}`], tags: true }, { name: 'p', ends: ['mp.out', 'p'] });
    return define({
      id: `amul${n}`, name: `${n}×${n} array multiplier`, category: 'arithmetic',
      summary: `Long multiplication in silicon: ${n} rows of AND gates make the partial products and ${n - 1} ripple-carry adders sum them, one row at a time. Simple, regular, and slow: the carries ripple across each row and down the array.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('p', 2 * n, 'out')],
      symbol: { kind: 'box', label: `MUL${n} (array)` },
      spec: 2 * n <= 52 ? ([a, b]) => [a * b] : undefined,
      netlist: () => ({ pins: { a: [0, 4], b: [0, 2 + rowH * n / 2], p: [right + 6, 2 + symbolGeom(PM).h / 2] }, instances, nets }),
      hdl: {
        verilog: `module array_mul #(parameter int N = ${n}) (input logic [N-1:0] a, b, output logic [2*N-1:0] p);
  logic [N-1:0] w [N];          // running sum, shifted right one place per row
  logic [N-1:0] s;  logic c;
  assign w[0] = {1'b0, (a & {N{b[0]}}) >> 1};
  assign p[0] = a[0] & b[0];
  for (genvar i = 1; i < N; i++) begin : row
    logic [N-1:0] s;  logic c;
    rca #(N) add (.a(w[i-1]), .b(a & {N{b[i]}}), .cin(1'b0), .s(s), .cout(c));
    assign p[i] = s[0];
    assign w[i] = {c, s[N-1:1]};
  end
  assign p[2*N-1:N] = w[N-1];
endmodule`,
      },
    });
  });
}

// ---- carry-save compressors -----------------------------------------------------------------------

/** A word inside a multiplier: w bits whose least-significant bit has weight 2^lo. */
export interface Word { lo: number; w: number }

/**
 * 3:2 compressor row: adds three words column by column with no carry chain. Each column with three
 * bits uses a full adder, two bits a half adder, one bit a plain wire. Output: a sum word and a carry
 * word (one place to the left). x + y + z = s + c, in one full-adder delay whatever the width.
 */
export function compressor(x: Word, y: Word, z: Word, maxW = Infinity): { def: ComponentDef; s: Word; c: Word | null } {
  const ins = [x, y, z];
  const L = Math.min(x.lo, y.lo, z.lo);
  const H = Math.min(maxW, Math.max(x.lo + x.w, y.lo + y.w, z.lo + z.w));
  const has = (r: Word, col: number) => col >= r.lo && col < r.lo + r.w;
  const present = (col: number) => [0, 1, 2].filter((k) => has(ins[k], col));
  const carryCols: number[] = [];
  for (let col = L; col < H; col++) if (present(col).length >= 2 && col + 1 < maxW) carryCols.push(col);
  const s: Word = { lo: L, w: H - L };
  const c: Word | null = carryCols.length ? { lo: carryCols[0] + 1, w: carryCols[carryCols.length - 1] - carryCols[0] + 1 } : null;
  const standard = x.lo === 0 && y.lo === 0 && z.lo === 0 && x.w === y.w && y.w === z.w && maxW === Infinity;
  const key = standard ? `csa${x.w}` : `cmp_${ins.map((r) => `${r.lo}.${r.w}`).join('_')}${maxW === Infinity ? '' : `_m${maxW}`}`;
  const def = memo(key, () => {
    const P = 10, X = 12, Y0 = 3;
    const fg = symbolGeom(FULL_ADDER), hg = symbolGeom(HALF_ADDER);
    const names = ['x', 'y', 'z'];
    const instances: InstanceDef[] = [];
    const nets: NetDef[] = [];
    names.forEach((nm, k) => {
      const r = ins[k];
      instances.push({ name: `s${nm}`, def: splitter(ones(r.w), P), at: [3 + 2 * k, Y0 + P * (r.lo - L) + 2 + 2 * k - P / 2] });
      nets.push({ name: nm, ends: [nm, `s${nm}.in`] });
    });
    const sumAt = X + fg.w + 4, carAt = X + fg.w + 8;
    instances.push({ name: 'ms', def: merger(ones(s.w), P), at: [sumAt, Y0 + fg.ports.s.pos[1] - P / 2] });
    if (c) instances.push({ name: 'mc', def: merger(ones(c.w), P), at: [carAt, Y0 + P * (c.lo - 1 - L) + fg.ports.cout.pos[1] - P / 2] });
    nets.push({ name: 's', ends: ['ms.out', 's'] });
    if (c) nets.push({ name: 'c', ends: ['mc.out', 'c'] });
    let ties = 0;
    const tie = (sink: string, row: number) => {
      instances.push({ name: `t${ties}`, def: TIE0, at: [X - 4, Y0 + P * row + 6] });
      nets.push({ ends: [`t${ties++}.y`, sink] });
    };
    for (let col = L; col < H; col++) {
      const row = col - L;
      const src = present(col).map((k) => `s${names[k]}.o${col - ins[k].lo}`);
      const cIdx = c ? col + 1 - c.lo : -1;
      const wantsCarry = c !== null && cIdx >= 0 && cIdx < c.w;
      if (src.length === 3) {
        instances.push({ name: `fa${col}`, def: FULL_ADDER, at: [X, Y0 + P * row] });
        nets.push({ ends: [src[0], `fa${col}.a`] }, { ends: [src[1], `fa${col}.b`] }, { ends: [src[2], `fa${col}.cin`] });
        nets.push({ name: `s${col}`, ends: [`fa${col}.s`, `ms.i${row}`] });
        if (wantsCarry) nets.push({ name: `c${col + 1}`, ends: [`fa${col}.cout`, `mc.i${cIdx}`] });
      } else if (src.length === 2) {
        instances.push({ name: `ha${col}`, def: HALF_ADDER, at: [X + (fg.w - hg.w) / 2, Y0 + P * row] });
        nets.push({ ends: [src[0], `ha${col}.a`] }, { ends: [src[1], `ha${col}.b`] });
        nets.push({ name: `s${col}`, ends: [`ha${col}.s`, `ms.i${row}`] });
        if (wantsCarry) nets.push({ name: `c${col + 1}`, ends: [`ha${col}.c`, `mc.i${cIdx}`] });
      } else {
        if (src.length === 1) nets.push({ name: `s${col}`, ends: [src[0], `ms.i${row}`] });
        else tie(`ms.i${row}`, row);
        if (wantsCarry) tie(`mc.i${cIdx}`, row);
      }
    }
    const fas = carryCols.filter((col) => present(col).length === 3).length;
    const spec = s.w <= 52 && (!c || c.w <= 52)
      ? ([a, b, d]: number[]) => {
        const X3 = (big(a) << BigInt(x.lo)) as bigint, Y3 = big(b) << BigInt(y.lo), Z3 = big(d) << BigInt(z.lo);
        const sum = (X3 ^ Y3 ^ Z3) >> BigInt(L);
        const out = [lowBits(sum, s.w)];
        if (c) out.push(lowBits(((X3 & Y3) | (X3 & Z3) | (Y3 & Z3)) << 1n >> BigInt(c.lo), c.w));
        return out;
      }
      : undefined;
    return define({
      id: key, name: standard ? `${x.w}-bit carry-save adder` : '3:2 compressor row', category: 'arithmetic',
      summary: standard
        ? `${x.w} full adders side by side, none connected to its neighbour: three numbers in, two out (sum and carry), x + y + z = s + 2c. The delay is one full adder at any width.`
        : `Columns ${L}–${H - 1} of a multiplier: ${fas} full adders, ${carryCols.length - fas} half adders, the rest wires. Three words in, two out, no carry chain.`,
      ports: [bus('x', x.w, 'in'), bus('y', y.w, 'in'), bus('z', z.w, 'in'), bus('s', s.w, 'out'), ...(c ? [bus('c', c.w, 'out')] : [])],
      symbol: { kind: 'box', label: '3:2' },
      spec,
      netlist: () => {
        const sy = Y0 + fg.ports.s.pos[1] + (P * s.w) / 2 - P / 2;
        const pins: Record<string, [number, number]> = { x: [0, Y0 + 2], y: [0, Y0 + 4], z: [0, Y0 + 6], s: [carAt + 6, sy] };
        if (c) {
          // The c pin sits a step below mc's output, unless s is already there.
          const cOut = Y0 + P * (c.lo - 1 - L) + fg.ports.cout.pos[1] + (P * c.w) / 2 - P / 2;
          pins.c = [carAt + 6, cOut + 2 === sy ? cOut : cOut + 2];
        }
        return { pins, instances, nets };
      },
      hdl: {
        verilog: `// carry-save: every column independent
assign s = x ^ y ^ z;
assign c = (x & y) | (x & z) | (y & z);   // weight 2: shifted one place left`,
      },
    });
  });
  return { def, s, c };
}

/** The classic n-bit carry-save adder (three n-bit inputs, sum and carry out). */
export const csa = (n: number) => compressor({ lo: 0, w: n }, { lo: 0, w: n }, { lo: 0, w: n }).def;

// ---- Wallace-tree multiplier -----------------------------------------------------------------------

export interface TreeMulInfo { levels: number; compressors: number }
const treeInfo = new Map<string, TreeMulInfo>();
export const treeMulInfo = (d: ComponentDef) => treeInfo.get(d.id);

/**
 * n×n tree multiplier: all partial products at once, a Wallace tree of 3:2 compressors squeezes them to
 * two words in O(log n) full-adder delays, and one fast (Kogge–Stone) adder produces the product.
 * signed: Baugh–Wooley two's complement (invert the mixed sign rows, add 2^n + 2^(2n-1)).
 * outW: product bits kept (default 2n; the CPU keeps 64 of a 33×33 product).
 */
export function treeMul(n: number, signed = false, outW = 2 * n): ComponentDef {
  const id = `wmul${n}${signed ? 's' : ''}${outW !== 2 * n ? `_${outW}` : ''}`;
  return memo(id, () => {
    const instances: InstanceDef[] = [];
    const nets: NetDef[] = [];
    const ends = new Map<string, NetDef>();
    const connect = (drv: string, sink: string, name?: string) => {
      let e = ends.get(drv);
      if (!e) ends.set(drv, (e = { name, ends: [drv] }));
      e.ends.push(sink);
    };
    type Live = Word & { drv: string; y: number };
    let words: Live[] = [];
    // column 0: partial products
    const PPH = symbolGeom(ppRow(n)).h + 2;
    instances.push({ name: 'sb', def: splitter(ones(n), PPH), at: [4, 2] });
    nets.push({ name: 'b', ends: ['b', 'sb.in'] });
    const aEnds = ['a'];
    for (let i = 0; i < n; i++) {
      const mode: PPMode = !signed ? 'and' : i === n - 1 ? 'bwLast' : 'bwTop';
      const y = 2 + PPH * i;
      instances.push({ name: `pp${i}`, def: ppRow(n, mode), at: [10, y], label: `a·b${i}` });
      aEnds.push(`pp${i}.a`);
      nets.push({ name: `b${i}`, ends: [`sb.o${i}`, `pp${i}.b`] });
      words.push({ lo: i, w: n, drv: `pp${i}.pp`, y });
    }
    nets.push({ name: 'a', ends: aEnds, trunk: 8 });
    if (signed) {
      // correction constant 2^n + 2^(2n-1), clipped to the kept width
      const top = 2 * n - 1 < outW;
      const K = constWord(top ? n : 1, top ? 1 + 2 ** (n - 1) : 1);
      const y = 2 + PPH * n;
      instances.push({ name: 'kbw', def: K, at: [14, y], label: 'Baugh–Wooley +1s' });
      words.push({ lo: n, w: top ? n : 1, drv: 'kbw.y', y });
    }
    let x = 10 + symbolGeom(ppRow(n)).w + 10;
    let level = 0, count = 0;
    words.sort((p, q) => p.lo - q.lo);
    while (words.length > 2) {
      const next: Live[] = [];
      let yNext = 0, colW = 0;
      for (let k = 0; k + 2 < words.length; k += 3) {
        const [p, q, r] = words.slice(k, k + 3);
        const cm = compressor(p, q, r, outW);
        const nm = `L${level}_${k / 3}`;
        const g = symbolGeom(cm.def);
        const y = Math.max(yNext, Math.round((p.y + q.y + r.y) / 3));
        instances.push({ name: nm, def: cm.def, at: [x, y], label: '3:2' });
        connect(p.drv, `${nm}.x`);
        connect(q.drv, `${nm}.y`);
        connect(r.drv, `${nm}.z`);
        next.push({ ...cm.s, drv: `${nm}.s`, y });
        if (cm.c) next.push({ ...cm.c, drv: `${nm}.c`, y: y + 2 });
        yNext = y + g.h + 3;
        colW = Math.max(colW, g.w);
        count++;
      }
      for (let k = words.length - (words.length % 3); k < words.length; k++) next.push(words[k]);
      words = next.sort((p, q) => p.lo - q.lo || p.w - q.w);
      x += colW + 12;
      level++;
    }
    treeInfo.set(id, { levels: level, compressors: count });
    // final carry-propagate adder over the two remaining words, zero-padded to outW
    const ADD = outW >= 4 ? koggeStone(outW) : rca(outW);
    const yA = Math.round((words[0].y + (words[1]?.y ?? words[0].y)) / 2);
    const pad = (wd: Live, k: number) => {
      const hi = Math.min(outW, wd.lo + wd.w);
      const parts: number[] = [];
      if (wd.lo > 0) parts.push(wd.lo);
      parts.push(hi - wd.lo);
      if (hi < outW) parts.push(outW - hi);
      let src = wd.drv;
      if (wd.lo + wd.w > outW) {
        instances.push({ name: `clip${k}`, def: splitter([outW - wd.lo, wd.lo + wd.w - outW]), at: [x, yA + 12 * k] });
        connect(wd.drv, `clip${k}.in`);
        src = `clip${k}.o0`;
      }
      if (parts.length === 1) return src;
      const M = merger(parts);
      instances.push({ name: `pad${k}`, def: M, at: [x + 4, yA + 12 * k] });
      let idx = 0;
      if (wd.lo > 0) {
        instances.push({ name: `zl${k}`, def: constWord(wd.lo, 0), at: [x - 10, yA + 12 * k - 4] });
        nets.push({ ends: [`zl${k}.y`, `pad${k}.i0`] });
        idx++;
      }
      connect(src, `pad${k}.i${idx++}`);
      if (hi < outW) {
        instances.push({ name: `zh${k}`, def: constWord(outW - hi, 0), at: [x - 10, yA + 12 * k + 6] });
        nets.push({ ends: [`zh${k}.y`, `pad${k}.i${idx}`] });
      }
      return `pad${k}.out`;
    };
    const sa = pad(words[0], 0);
    const sbw = words[1] ? pad(words[1], 1) : null;
    x += 10;
    instances.push({ name: 'cpa', def: ADD, at: [x, yA], label: 'final adder' });
    instances.push({ name: 'gnd', def: TIE0, at: [x - 4, yA - 4] });
    nets.push({ name: 'sum', ends: [sa, 'cpa.a'], tags: true });
    if (sbw) nets.push({ name: 'carry', ends: [sbw, 'cpa.b'], tags: true });
    else {
      instances.push({ name: 'z0', def: constWord(outW, 0), at: [x - 10, yA + 20] });
      nets.push({ ends: ['z0.y', 'cpa.b'] });
    }
    nets.push({ ends: ['gnd.y', 'cpa.cin'] });
    const ag = symbolGeom(ADD);
    nets.push({ name: 'p', ends: ['cpa.s', 'p'] });
    for (const [, e] of ends) nets.push(e);
    const M = 2n ** BigInt(outW);
    const sx = (v: number) => (signed && v >= 2 ** (n - 1) ? big(v) - 2n ** BigInt(n) : big(v));
    return define({
      id, name: `${n}×${n} ${signed ? 'signed ' : ''}Wallace-tree multiplier`, category: 'arithmetic',
      summary: `${n} partial products${signed ? ' (Baugh–Wooley signed)' : ''} reduced by ${count} carry-save compressor rows in ${level} levels (each level: one full-adder delay), then one ${ADD.name} produces the ${outW}-bit product.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('p', outW, 'out')],
      symbol: { kind: 'box', label: `MUL${n} (tree)` },
      spec: outW <= 52 ? ([a, b]) => [Number(((sx(a) * sx(b)) % M + M) % M)] : undefined,
      netlist: () => ({ pins: { a: [0, 4], b: [0, 2 + (PPH * n) / 2], p: [x + ag.w + 8, yA + ag.ports.s.pos[1]] }, instances, nets }),
      hdl: {
        verilog: `// Wallace tree: ${level} levels of 3:2 compressors, then one carry-propagate adder
module tree_mul #(parameter int N = ${n}) (input logic ${signed ? 'signed ' : ''}[N-1:0] a, b, output logic [${outW - 1}:0] p);
  assign p = a * b;   // synthesis builds exactly this structure (often with Booth recoding first)
endmodule`,
      },
    });
  });
}

/** The CPU's multiplier: 32×32 → 64 bits, signed or unsigned per operand (mul, mulh, mulhsu, mulhu). */
export const MUL32: ComponentDef = (() => {
  const T = treeMul(33, true, 64);
  const tg = symbolGeom(T);
  const S = splitter([31, 1]), E = merger([32, 1]), O = splitter([32, 32]);
  return define({
    id: 'mul32', name: '32×32 multiplier (signed / unsigned)', category: 'arithmetic',
    summary: 'Each operand is extended to 33 bits: with its sign bit if that operand is signed, with 0 if not. Then one 33×33 signed tree multiplier serves all four instructions: the low 32 bits for mul, the high 32 for mulh / mulhsu / mulhu.',
    ports: [bus('a', 32, 'in'), bus('b', 32, 'in'), bit('sa', 'in'), bit('sb', 'in'), bus('lo', 32, 'out'), bus('hi', 32, 'out')],
    symbol: { kind: 'box', label: 'MUL32' },
    spec: ([a, b, sa, sb]) => {
      const A = sa && a >= 2 ** 31 ? big(a) - 2n ** 32n : big(a), B = sb && b >= 2 ** 31 ? big(b) - 2n ** 32n : big(b);
      const p = BigInt.asUintN(64, A * B);
      return [lowBits(p, 32), lowBits(p >> 32n, 32)];
    },
    netlist: () => ({
      pins: { a: [0, 4], b: [0, 22], sa: [0, 10], sb: [0, 28], lo: [44 + tg.w, 14], hi: [44 + tg.w, 18] },
      instances: [
        { name: 'spa', def: S, at: [4, 2] }, { name: 'spb', def: S, at: [4, 20] },
        { name: 'xa', def: AND, at: [10, 8] }, { name: 'xb', def: AND, at: [10, 26] },
        { name: 'ea', def: E, at: [18, 3] }, { name: 'eb', def: E, at: [18, 21] },
        { name: 'm', def: T, at: [24, 2] },
        { name: 'sp', def: O, at: [30 + tg.w, 14] },
      ],
      nets: [
        { name: 'a', ends: ['a', 'spa.in', 'ea.i0'] }, { name: 'b', ends: ['b', 'spb.in', 'eb.i0'] },
        { name: 'a31', ends: ['spa.o1', 'xa.a'] }, { name: 'b31', ends: ['spb.o1', 'xb.a'] },
        { name: 'sa', ends: ['sa', 'xa.b'] }, { name: 'sb', ends: ['sb', 'xb.b'] },
        { name: 'a32', ends: ['xa.y', 'ea.i1'] }, { name: 'b32', ends: ['xb.y', 'eb.i1'] },
        { name: 'A', ends: ['ea.out', 'm.a'] }, { name: 'B', ends: ['eb.out', 'm.b'] },
        { name: 'P', ends: ['m.p', 'sp.in'] },
        { name: 'lo', ends: ['sp.o0', 'lo'] }, { name: 'hi', ends: ['sp.o1', 'hi'] },
      ],
    }),
    hdl: {
      verilog: `wire signed [32:0] A = {sa & a[31], a}, B = {sb & b[31], b};
wire signed [65:0] P = A * B;
assign lo = P[31:0];  assign hi = P[63:32];`,
    },
  });
})();

// ---- Booth recoding ---------------------------------------------------------------------------------

/**
 * Radix-4 Booth encoder: looks at three bits of the multiplier (b[2i+1], b[2i], b[2i-1]) and picks the
 * partial product: 0, ±a or ±2a. Half as many rows as plain AND partial products.
 */
export const BOOTH_ENC: ComponentDef = define({
  id: 'booth_enc', name: 'Radix-4 Booth encoder', category: 'arithmetic',
  summary: 'Three overlapping multiplier bits select one partial product from {0, ±a, ±2a}: one = b0 XOR bm, two = (b1 AND NOT b0 AND NOT bm) OR (NOT b1 AND b0 AND bm), neg = b1 AND NOT (b0 AND bm).',
  ports: [bit('b1', 'in'), bit('b0', 'in'), bit('bm', 'in'), bit('one', 'out'), bit('two', 'out'), bit('neg', 'out')],
  symbol: { kind: 'box', label: 'BOOTH' },
  spec: ([b1, b0, bm]) => {
    const d = -2 * b1 + b0 + bm;
    return [Math.abs(d) === 1 ? 1 : 0, Math.abs(d) === 2 ? 1 : 0, d < 0 ? 1 : 0];
  },
  netlist: () => ({
    pins: { b1: [0, 2], b0: [0, 8], bm: [0, 14], one: [40, 6], two: [40, 14], neg: [40, 20] },
    instances: [
      { name: 'x1', def: XOR, at: [10, 6] },
      { name: 'x2', def: XOR, at: [10, 12] },
      { name: 'n2', def: NOT, at: [22, 9] },
      { name: 'a2', def: AND, at: [30, 12] },
      { name: 'z', def: NAND, at: [18, 18] },
      { name: 'ng', def: AND, at: [30, 18] },
    ],
    nets: [
      { name: 'b1', ends: ['b1', 'x2.a', 'ng.a'], trunk: 4 },
      { name: 'b0', ends: ['b0', 'x1.a', 'x2.b', 'z.a'], trunk: 6 },
      { name: 'bm', ends: ['bm', 'x1.b', 'z.b'], trunk: 8 },
      { name: 'one', ends: ['x1.y', 'one', 'n2.a'] },
      { name: 'b1^b0', ends: ['x2.y', 'a2.a'] },
      { name: '¬one', ends: ['n2.y', 'a2.b'] },
      { name: 'two', ends: ['a2.y', 'two'] },
      { name: '¬(b0·bm)', ends: ['z.y', 'ng.b'] },
      { name: 'neg', ends: ['ng.y', 'neg'] },
    ],
  }),
  hdl: {
    verilog: `assign one = b0 ^ bm;                      // digit ±1
assign two = (b1 ^ b0) & ~(b0 ^ bm);        // digit ±2: 100 or 011
assign neg = b1 & ~(b0 & bm);               // 100, 101, 110: negative (111 is 0)`,
  },
});

// ---- division -----------------------------------------------------------------------------------------

/**
 * One step of restoring division: shift the next dividend bit into the partial remainder, try to
 * subtract the divisor, and keep the difference only if it did not go negative. The quotient bit is
 * "it fitted".
 */
export function divStep(n: number, fast = n >= 16): ComponentDef {
  return memo(`divstep${n}${fast ? 'f' : ''}`, () => {
    const SUB = fast ? addSubFast(n) : addSub(n), MX = busMux2(n);
    const sg = symbolGeom(SUB), mg = symbolGeom(MX);
    const xs = 24, xm = xs + sg.w + 12;
    return define({
      id: `divstep${n}${fast ? 'f' : ''}`, name: `${n}-bit restoring division step`, category: 'arithmetic',
      summary: 'r2 = (r << 1) | next dividend bit; try r2 − d. If it does not borrow (or r2 overflowed n bits) the divisor fits: keep the difference and emit quotient bit 1. Otherwise restore r2 and emit 0.',
      ports: [bus('r', n, 'in'), bit('qin', 'in'), bus('d', n, 'in'), bus('rout', n, 'out'), bit('q', 'out')],
      symbol: { kind: 'box', label: 'DIV STEP' },
      spec: ([r, qin, d]) => {
        const full = r * 2 + qin;
        return full >= d ? [(full - d) % 2 ** n, 1] : [full, 0];
      },
      netlist: () => ({
        pins: { r: [0, 4], qin: [0, 10], d: [0, 4 + sg.ports.b.pos[1]], rout: [xm + mg.w + 8, 4 + mg.ports.y.pos[1]], q: [xm + mg.w + 8, 4 + mg.h + 8] },
        instances: [
          { name: 'sr', def: splitter([n - 1, 1]), at: [4, 3] },
          { name: 'r2', def: merger([1, n - 1]), at: [13, 5] },
          { name: 'one', def: TIE1, at: [xs - 6, 4 + sg.ports.sub.pos[1] - 1] },
          { name: 'sub', def: SUB, at: [xs, 4], label: 'r2 − d' },
          { name: 'ge', def: OR, at: [xs + sg.w + 4, 4 + mg.h + 6] },
          { name: 'mx', def: MX, at: [xm, 4], label: 'keep?' },
        ],
        nets: [
          { name: 'r', ends: ['r', 'sr.in'] },
          { name: 'rlow', ends: ['sr.o0', 'r2.i1'] },
          { name: 'rtop', ends: ['sr.o1', 'ge.a'], tags: true },
          { name: 'qin', ends: ['qin', 'r2.i0'] },
          { name: 'r2', ends: ['r2.out', 'sub.a', 'mx.a'] },
          { name: 'd', ends: ['d', 'sub.b'] },
          { ends: ['one.y', 'sub.sub'] },
          { name: 'noBorrow', ends: ['sub.cout', 'ge.b'], tags: true },
          { name: 'diff', ends: ['sub.s', 'mx.b'] },
          { name: 'fits', ends: ['ge.y', 'mx.s', 'q'], tags: ['mx.s'] },
          { name: 'rout', ends: ['mx.y', 'rout'] },
        ],
      }),
      hdl: {
        verilog: `wire [N:0]   r2   = {r, qin};
wire [N:0]   diff = r2 - {1'b0, d};
assign q    = ~diff[N];                  // no borrow: the divisor fits
assign rout = q ? diff[N-1:0] : r2[N-1:0];`,
      },
    });
  });
}

/** Combinational n-bit unsigned divider: n restoring steps in a row, one per quotient bit. */
export function arrayDiv(n: number): ComponentDef {
  return memo(`adiv${n}`, () => {
    const ST = divStep(n, false);
    const g = symbolGeom(ST);
    const rowH = g.h + 6, dx = g.w + 6;
    const instances: InstanceDef[] = [
      { name: 'sa', def: splitter(ones(n), 2), at: [2, 2] },
      { name: 'z', def: constWord(n, 0), at: [4, 2 * n + 4] },
    ];
    const nets: NetDef[] = [{ name: 'a', ends: ['a', 'sa.in'] }];
    const dEnds = ['b'];
    let prev = 'z.y';
    const qBits: string[] = [];
    for (let i = 0; i < n; i++) {
      instances.push({ name: `st${i}`, def: ST, at: [14 + dx * i, 2 + rowH * i], label: `bit ${n - 1 - i}` });
      nets.push({ name: i === 0 ? 'zero' : `r${i - 1}`, ends: [prev, `st${i}.r`] });
      nets.push({ name: `a${n - 1 - i}`, ends: [`sa.o${n - 1 - i}`, `st${i}.qin`] });
      dEnds.push(`st${i}.d`);
      qBits[n - 1 - i] = `st${i}.q`;
      prev = `st${i}.rout`;
    }
    nets.push({ name: 'd', ends: dEnds, tags: dEnds.slice(1) });
    const right = 14 + dx * n + 6;
    instances.push({ name: 'mq', def: merger(ones(n)), at: [right, 2] });
    qBits.forEach((d, i) => nets.push({ name: `q${i}`, ends: [d, `mq.i${i}`], tags: true }));
    nets.push({ name: 'q', ends: ['mq.out', 'q'] }, { name: 'r', ends: [prev, 'r'] });
    const M = mask(n);
    return define({
      id: `adiv${n}`, name: `${n}-bit array divider`, category: 'arithmetic',
      summary: `Long division in silicon: ${n} restoring steps, each a subtractor and a multiplexer, produce one quotient bit each, most significant first. Each step must wait for the previous remainder, so the delay is n full subtractions.`,
      ports: [bus('a', n, 'in'), bus('b', n, 'in'), bus('q', n, 'out'), bus('r', n, 'out')],
      symbol: { kind: 'box', label: `DIV${n}` },
      spec: ([a, b]) => (b === 0 ? [M, a] : [Math.floor(a / b), a % b]),
      netlist: () => ({ pins: { a: [0, n + 2], b: [0, 2 * n + 10], q: [right + 6, n + 2], r: [right + 6, 2 + rowH * n] }, instances, nets }),
      hdl: {
        verilog: `// restoring division, unrolled: one step per quotient bit
always_comb begin
  r = '0;
  for (int i = N-1; i >= 0; i--) begin
    {c, t} = {r, a[i]} - {1'b0, b};
    q[i] = ~c;
    r = q[i] ? t : {r[N-2:0], a[i]};
  end
end`,
      },
    });
  });
}

/**
 * Iterative unsigned divider: the same restoring step reused once per clock. start (while idle)
 * loads the operands; n steps later done = 1 for one cycle with q and r valid. n + 2 cycles in all.
 */
export function seqDivider(n: number): ComponentDef {
  return memo(`sdiv${n}`, () => {
    const k = Math.round(Math.log2(n)), cw = k + 1;
    const REG = register(n), CNT = register(cw), ST = divStep(n), MX = busMux2(n), MC = busMux2(cw), INC = incrementer(cw);
    const rg = symbolGeom(REG), sg = symbolGeom(ST), mg = symbolGeom(MX);
    const x1 = 12, x2 = x1 + mg.w + 8, x3 = x2 + rg.w + 12, x4 = x3 + sg.w + 14;
    const yR = 4, yQ = yR + rg.h + 10, yD = yQ + rg.h + 10, yC = yD + rg.h + 10, yCtl = yC + symbolGeom(CNT).h + 10;
    const instances: InstanceDef[] = [
      { name: 'mr', def: MX, at: [x1, yR], label: 'load 0' },
      { name: 'rr', def: REG, at: [x2, yR], label: 'remainder' },
      { name: 'mq', def: MX, at: [x1, yQ], label: 'load a' },
      { name: 'rq', def: REG, at: [x2, yQ], label: 'quotient / dividend' },
      { name: 'rd', def: REG, at: [x2, yD], label: 'divisor' },
      { name: 'mcnt', def: MC, at: [x1, yC] },
      { name: 'cnt', def: CNT, at: [x2, yC], label: 'step count' },
      { name: 'inc', def: INC, at: [x3, yC] },
      { name: 'step', def: ST, at: [x3, yR] },
      { name: 'sq', def: splitter([n - 1, 1]), at: [x3 - 4, yQ + 2] },
      { name: 'nq', def: merger([1, n - 1]), at: [x4, yQ + 2] },
      { name: 'z', def: constWord(n, 0), at: [2, yR - 2] },
      { name: 'zc', def: constWord(cw, 0), at: [2, yC - 2] },
      { name: 'sc', def: splitter([k, 1]), at: [x2 + rg.w + 4, yC + 6] },
      { name: 'run', def: DFF, at: [x3 + 16, yCtl], label: 'busy' },
      { name: 'nbusy', def: NOT, at: [2, yCtl] },
      { name: 'load', def: AND, at: [6, yCtl + 4] },
      { name: 'en', def: OR, at: [x1 + 6, yCtl + 6] },
      { name: 'dn', def: AND, at: [x3, yCtl + 8] },
      { name: 'ndn', def: NOT, at: [x3, yCtl + 14] },
      { name: 'keep', def: AND, at: [x3 + 5, yCtl + 12] },
      { name: 'nrun', def: OR, at: [x3 + 5, yCtl] },
    ];
    const nets: NetDef[] = [
      { name: 'start', ends: ['start', 'load.a'] },
      { name: '¬busy', ends: ['nbusy.y', 'load.b'], tags: true },
      { name: 'load', ends: ['load.y', 'mr.s', 'mq.s', 'mcnt.s', 'rd.en', 'en.a', 'nrun.a'], tags: ['mr.s', 'mq.s', 'mcnt.s', 'rd.en', 'nrun.a'] },
      { name: 'busy', ends: ['run.q', 'nbusy.a', 'en.b', 'dn.a', 'keep.a', 'busy'], tags: true },
      { name: 'step', ends: ['en.y', 'rr.en', 'rq.en', 'cnt.en'], tags: true },
      { name: 'zero', ends: ['z.y', 'mr.b'] },
      { name: 'R', ends: ['rr.q', 'step.r', 'r'], tags: ['r'] },
      { name: 'rNext', ends: ['step.rout', 'mr.a'], tags: true },
      { name: 'Rd', ends: ['mr.y', 'rr.d'] },
      { name: 'Q', ends: ['rq.q', 'sq.in', 'q'], tags: ['q'] },
      { name: 'qTop', ends: ['sq.o1', 'step.qin'], tags: true },
      { name: 'qLow', ends: ['sq.o0', 'nq.i1'] },
      { name: 'qBit', ends: ['step.q', 'nq.i0'], tags: true },
      { name: 'qNext', ends: ['nq.out', 'mq.a'], tags: true },
      { name: 'a', ends: ['a', 'mq.b'] },
      { name: 'Qd', ends: ['mq.y', 'rq.d'] },
      { name: 'b', ends: ['b', 'rd.d'] },
      { name: 'D', ends: ['rd.q', 'step.d'], tags: true },
      { name: 'count', ends: ['cnt.q', 'inc.a', 'sc.in'], tags: ['inc.a'] },
      { name: 'count+1', ends: ['inc.y', 'mcnt.a'], tags: true },
      { name: 'zc', ends: ['zc.y', 'mcnt.b'] },
      { name: 'cntD', ends: ['mcnt.y', 'cnt.d'] },
      { name: `count[${k}]`, ends: ['sc.o1', 'dn.b'], tags: true },
      { name: 'done', ends: ['dn.y', 'ndn.a', 'done'], tags: true },
      { name: '¬done', ends: ['ndn.y', 'keep.b'] },
      { name: 'stay', ends: ['keep.y', 'nrun.b'], tags: true },
      { name: 'busyNext', ends: ['nrun.y', 'run.d'] },
      { name: 'clk', ends: ['clk', 'rr.clk', 'rq.clk', 'rd.clk', 'cnt.clk', 'run.clk'], tags: ['rr.clk', 'rq.clk', 'rd.clk', 'cnt.clk', 'run.clk'] },
    ];
    const right = x4 + 12;
    return define({
      id: `sdiv${n}`, name: `${n}-bit iterative divider`, category: 'sequential',
      summary: `One restoring step reused every clock: start loads the dividend into the quotient register (its bits shift out the top into the remainder as quotient bits shift in at the bottom); after ${n} steps done rises for one cycle. ${n + 2} cycles per division, a fraction of the array divider's area.`,
      ports: [bit('clk', 'in', 'bottom', true), bit('start', 'in'), bus('a', n, 'in'), bus('b', n, 'in'), bus('q', n, 'out'), bus('r', n, 'out'), bit('done', 'out'), bit('busy', 'out')],
      symbol: { kind: 'box', label: `DIV${n} (iterative)` },
      netlist: () => ({
        pins: { start: [0, yCtl + 5], a: [0, yQ + 4], b: [0, yD + 4], clk: [0, yCtl + 16], q: [right, yQ + 4], r: [right, yR + 4], done: [right, yCtl + 9], busy: [right, yCtl + 1] },
        instances, nets,
      }),
      hdl: {
        verilog: `module seq_divider #(parameter int N = ${n}) (input logic clk, start, input logic [N-1:0] a, b,
                       output logic [N-1:0] q, r, output logic done, busy);
  logic [N-1:0] d;  logic [$clog2(N):0] count;
  wire load = start & ~busy;
  assign done = busy & count[$clog2(N)];
  wire [N:0] r2 = {r, q[N-1]}, diff = r2 - {1'b0, d};
  always_ff @(posedge clk) begin
    if (load) begin r <= '0; q <= a; d <= b; count <= '0; end
    else if (busy) begin
      r <= diff[N] ? r2[N-1:0] : diff[N-1:0];
      q <= {q[N-2:0], ~diff[N]};
      count <= count + 1;
    end
    busy <= load | (busy & ~done);
  end
endmodule`,
      },
    });
  });
}

/** y = neg ? −x : x, as (x XOR neg…neg) + neg: a row of XORs and a fast adder. */
export function condNegate(n: number): ComponentDef {
  return memo(`cneg${n}`, () => {
    const X = bitwise('xor', n), F = fanout(n), K = koggeStone(n), Z = constWord(n, 0);
    const xg = symbolGeom(X), kg = symbolGeom(K);
    const xk = 20 + xg.w + 10;
    return define({
      id: `cneg${n}`, name: `${n}-bit conditional negate`, category: 'arithmetic',
      summary: 'Two\'s complement negation is "invert every bit, add one". XOR with neg inverts when neg = 1, and neg itself is the +1 (the adder\'s carry-in).',
      ports: [bus('x', n, 'in'), bit('neg', 'in'), bus('y', n, 'out')],
      symbol: { kind: 'box', label: '±' },
      spec: ([x, neg]) => [neg ? (2 ** n - x) % 2 ** n : x],
      netlist: () => ({
        pins: { x: [0, 4], neg: [0, xg.h + 8], y: [xk + kg.w + 8, 2 + kg.ports.s.pos[1]] },
        instances: [
          { name: 'f', def: F, at: [10, xg.h + 6] },
          { name: 'x', def: X, at: [20, 2] },
          { name: 'z', def: Z, at: [xk - 14, 2 + kg.ports.b.pos[1] - 1] },
          { name: 'k', def: K, at: [xk, 2] },
        ],
        nets: [
          { name: 'x', ends: ['x', 'x.a'] },
          { name: 'neg', ends: ['neg', 'f.in', 'k.cin'] },
          { name: 'mask', ends: ['f.out', 'x.b'] },
          { name: 'inv', ends: ['x.y', 'k.a'] },
          { ends: ['z.y', 'k.b'] },
          { name: 'y', ends: ['k.s', 'y'] },
        ],
      }),
    });
  });
}

// ---- the M unit ---------------------------------------------------------------------------------------

/**
 * The CPU's multiply/divide unit. Multiplies finish in the same cycle (a tree multiplier); divides run
 * on the iterative divider and stall the processor until done. Signs are stripped before dividing and
 * restored afterwards, with RISC-V's rules for division by zero (quotient −1, remainder = dividend)
 * and overflow (−2³¹ / −1 = −2³¹, remainder 0) falling out of the hardware for free.
 */
export const MDU: ComponentDef = (() => {
  const W = 32;
  const M2 = busMux2(W), CN = condNegate(W), DV = seqDivider(W);
  const mg = symbolGeom(MUL32), dg = symbolGeom(DV), cg = symbolGeom(CN), xg = symbolGeom(M2);
  const xA = 14, xB = xA + Math.max(mg.w, cg.w) + 16, xC = xB + dg.w + 16, xD = xC + xg.w + 10, xE = xD + cg.w + 12, xF = xE + xg.w + 10;
  const yM = 2, yN = yM + mg.h + 10, yN2 = yN + cg.h + 6, yG = yN2 + cg.h + 10;
  const instances: InstanceDef[] = [
    { name: 'f3', def: splitter([1, 1, 1]), at: [2, yG] },
    { name: 'sa', def: splitter([31, 1]), at: [6, yN - 4] },
    { name: 'sb', def: splitter([31, 1]), at: [6, yN2 - 4] },
    { name: 'mul', def: MUL32, at: [xA, yM], label: 'multiplier' },
    { name: 'mhi', def: M2, at: [xB, yM + 4], label: 'lo / hi' },
    { name: 'nga', def: CN, at: [xA, yN], label: '|a|' },
    { name: 'ngb', def: CN, at: [xA, yN2], label: '|b|' },
    { name: 'div', def: DV, at: [xB, yN], label: 'divider' },
    { name: 'qr', def: M2, at: [xC, yN + 2], label: 'q / r' },
    { name: 'ngo', def: CN, at: [xD, yN], label: 'sign fix' },
    { name: 'out', def: M2, at: [xE, yM + 6], label: 'mul / div' },
    { name: 'bz', def: isZero(W), at: [xC, yG + 12], label: 'b = 0?' },
    // control
    { name: 'msa', def: XOR, at: [xA - 6, yG] }, { name: 'n1', def: NOT, at: [xA - 6, yG + 6] }, { name: 'msb', def: AND, at: [xA + 2, yG + 6] },
    { name: 'mh', def: OR, at: [xA + 10, yG] },
    { name: 'dsg', def: NOT, at: [xA - 6, yG + 12] }, { name: 'na', def: AND, at: [xA, yG + 12] }, { name: 'nb', def: AND, at: [xA, yG + 18] },
    // isDiv.y → start.a, b = 0 → nbz, sx → qneg → oneg and ndone → stall.i2 share rows: short straight wires
    { name: 'isDiv', def: AND, at: [xA + 8, yG + 24] }, { name: 'start', def: AND, at: [xA + 20, yG + 25] },
    { name: 'sx', def: XOR, at: [xC, yG] }, { name: 'nbz', def: NOT, at: [xC + 9, yG + 13] }, { name: 'qneg', def: AND, at: [xC + 10, yG + 1] },
    { name: 'oneg', def: MUX2, at: [xD + 6, yG + 1], label: 'negate?' },
    { name: 'ndone', def: NOT, at: [xB + 8, yG + 28] }, { name: 'stall', def: andN(3), at: [xB + 16, yG + 24] },
  ];
  const nets: NetDef[] = [
    { name: 'a', ends: ['a', 'mul.a', 'nga.x', 'sa.in'] },
    { name: 'b', ends: ['b', 'mul.b', 'ngb.x', 'sb.in', 'bz.a'], tags: ['bz.a'] },
    { name: 'funct3', ends: ['funct3', 'f3.in'] },
    { name: 'f0', ends: ['f3.o0', 'msa.a', 'msb.b', 'mh.a', 'dsg.a'], tags: ['msb.b', 'mh.a', 'dsg.a'] },
    { name: 'f1', ends: ['f3.o1', 'msa.b', 'n1.a', 'mh.b', 'qr.s', 'oneg.s'], tags: ['n1.a', 'mh.b', 'qr.s', 'oneg.s'] },
    { name: 'f2', ends: ['f3.o2', 'isDiv.b', 'out.s'], tags: true },
    { name: '¬f1', ends: ['n1.y', 'msb.a'] },
    { name: 'signedA', ends: ['msa.y', 'mul.sa'], tags: true },
    { name: 'signedB', ends: ['msb.y', 'mul.sb'], tags: true },
    { name: 'high', ends: ['mh.y', 'mhi.s'], tags: true },
    { name: 'lo', ends: ['mul.lo', 'mhi.a'] }, { name: 'hi', ends: ['mul.hi', 'mhi.b'] },
    { name: 'mulOut', ends: ['mhi.y', 'out.a'] },
    { name: 'divSigned', ends: ['dsg.y', 'na.a', 'nb.a'], tags: ['nb.a'] },
    { name: 'a31', ends: ['sa.o1', 'na.b'], tags: true }, { name: 'b31', ends: ['sb.o1', 'nb.b'], tags: true },
    { name: 'negA', ends: ['na.y', 'nga.neg', 'sx.a', 'oneg.b'], tags: true },
    { name: 'negB', ends: ['nb.y', 'ngb.neg', 'sx.b'], tags: true },
    { name: '|a|', ends: ['nga.y', 'div.a'] }, { name: '|b|', ends: ['ngb.y', 'div.b'] },
    { name: 'isM', ends: ['isM', 'isDiv.a'] },
    { name: 'isDiv', ends: ['isDiv.y', 'start.a', 'stall.i0'], tags: ['stall.i0'] },
    { name: 'noTrap', ends: ['noTrap', 'start.b', 'stall.i1'], tags: ['start.b', 'stall.i1'] },
    { name: 'start', ends: ['start.y', 'div.start'], tags: true },
    { name: 'clk', ends: ['clk', 'div.clk'] },
    { name: 'q', ends: ['div.q', 'qr.a'] }, { name: 'r', ends: ['div.r', 'qr.b'] },
    { name: 'signs differ', ends: ['sx.y', 'qneg.a'] },
    { name: 'b≠0', ends: ['nbz.y', 'qneg.b'], tags: true },
    { name: 'b=0', ends: ['bz.z', 'nbz.a'] },
    { name: 'negQ', ends: ['qneg.y', 'oneg.a'] },
    { name: 'negOut', ends: ['oneg.y', 'ngo.neg'], tags: true },
    { name: 'qrSel', ends: ['qr.y', 'ngo.x'] },
    { name: 'divOut', ends: ['ngo.y', 'out.b'] },
    { name: 'y', ends: ['out.y', 'y'] },
    { name: 'done', ends: ['div.done', 'ndone.a'], tags: true },
    { name: '¬done', ends: ['ndone.y', 'stall.i2'] },
    { name: 'stall', ends: ['stall.y', 'stall'], tags: true },
    { name: 'busy', ends: ['div.busy', 'busy'], tags: true },
  ];
  return define({
    id: 'mdu', name: 'Multiply / divide unit (RV32M)', category: 'cpu',
    summary: 'mul, mulh, mulhsu, mulhu in one cycle on a 33×33 tree multiplier; div, divu, rem, remu on a 32-step iterative divider that stalls the CPU (34 cycles). Signed division divides magnitudes and fixes the sign afterwards.',
    ports: [bit('clk', 'in', 'bottom', true), bus('a', W, 'in'), bus('b', W, 'in'), bus('funct3', 3, 'in'), bit('isM', 'in'), bit('noTrap', 'in'),
      bus('y', W, 'out'), bit('stall', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'M UNIT' },
    netlist: () => ({
      pins: { a: [0, yM + 2], b: [0, yM + 8], funct3: [0, yG + 2], isM: [0, yG + 25], noTrap: [0, yG + 30], clk: [0, yG + 34], y: [xF + 4, yM + 10], stall: [xF + 4, yG + 26], busy: [xF + 4, yG + 30] },
      instances, nets,
    }),
    hdl: {
      verilog: `// RV32M: funct3 = mul 0, mulh 1, mulhsu 2, mulhu 3, div 4, divu 5, rem 6, remu 7
wire signA = funct3[0] ^ funct3[1], signB = funct3 == 3'd1;
wire [31:0] lo, hi;   mul32 mul (.a, .b, .sa(signA), .sb(signB), .lo, .hi);
wire divSigned = ~funct3[0];
wire negA = divSigned & a[31], negB = divSigned & b[31];
wire isDiv = isM & funct3[2];
seq_divider #(32) div (.clk, .start(isDiv & noTrap), .a(negA ? -a : a), .b(negB ? -b : b), .q, .r, .done, .busy);
wire negOut = funct3[1] ? negA : (negA ^ negB) & (b != 0);
wire [31:0] qr = funct3[1] ? r : q;
assign y = funct3[2] ? (negOut ? -qr : qr) : (funct3 != 0 ? hi : lo);
assign stall = isDiv & noTrap & ~done;`,
    },
  });
})();
