// Act 9's graphics levels (roadmap Phase 15, 4c): chapter 30's rasterizer at RV16 sizes, each block built only
// from parts its level unlocks, so each is that level's reference. The reference model is gfx/raster16.ts.
//
//   EDGE16    one edge function: E and the band start R (16 bits), one adder / subtractor; a command a cycle:
//             hold, load (E, R ← e0), right (+a), skip (+4a), down (+b), up (−b), band (E, R ← R + 4b), and
//             double (E ← 2E + a, the set-up's shift-and-add). inside = E ≥ 0.
//   TILE16    the tile walk over a box of 4 × 4-pixel tiles: a TEST cycle at each tile's top-left pixel, then
//             its 16 pixels in a column serpentine; it issues the steppers' commands.
//   RASTER16  set-up (A, B, the top-left bias, the box in tiles, the tile test's offsets; each E at the first
//             tile by shift-and-add on its own stepper, 17 steps; the cull from the sum of the three E), three
//             steppers, the walk, the tile test; a pixel write per covered pixel.

import { CMD16 } from '../../gfx/raster16';
import type { ComponentDef, PortDef } from '../../sim/types';
import { constWord, isZero } from '../alu';
import { Builder } from '../builder';
import { addSub, andN, busMux2, equal, FULL_ADDER, muxTree, rca } from '../combinational';
import { define, merger, ones, splitter } from '../define';
import { fanout } from '../fastadd';
import { AND, NOT, OR } from '../gates';
import { bitwise, orN } from '../wide';
import { ADD16, DEC3, MUX16, RV16_DFF, RV16_REG16, RV16_REG4 } from './logic';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkIn = (): PortDef => ({ name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const E3 = [0, 1, 2];

/** a << k on 16 bits (wiring). */
function shl16(b: Builder, a: string, k: number): string {
  return b.op1(merger([k, 16 - k], 2), [b.op1(constWord(k, 0), []), `${b.op(splitter([16 - k, k], 2), [a])}.o0`], `×${2 ** k}`);
}

// ---- the edge stepper ------------------------------------------------------------------------------------

export const EDGE16: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins('a', 'b', 'e0', 'cmd', 'clk');
  const dec = b.op(DEC3, ['cmd', b.op1(constWord(1, 1), [])], 'command');
  const y = b.op(splitter(ones(8), 2), [`${dec}.y`]);
  const c = (k: keyof typeof CMD16) => b.name(`${y}.o${CMD16[k]}`, k, true);
  const er = b.add(RV16_REG16, 'E', 'E');
  const rr = b.add(RV16_REG16, 'band start R', 'R');
  for (const r of [er, rr]) b.wire('clk', `${r}.clk`);
  const e = b.name(`${er}.q`, 'e', true);
  b.next();
  // the base: E, R for band, 2E for double; the operand: a, 4a, b or 4b
  const base = b.op1(MUX16, [b.op1(MUX16, [e, `${rr}.q`, c('band')], 'E or R'), shl16(b, e, 1), c('double')], 'base');
  const opA = b.op1(MUX16, ['a', shl16(b, 'a', 2), c('skip')], 'a or 4a');
  const opB = b.op1(MUX16, ['b', shl16(b, 'b', 2), c('band')], 'b or 4b');
  const useB = b.op1(orN(3), [c('down'), c('up'), c('band')], 'b side?');
  b.next();
  const op = b.op1(MUX16, [opA, opB, useB], 'operand');
  b.next();
  const sum = b.op(addSub(16), [base, op, c('up')], 'E ± operand');
  b.next();
  const d = b.op1(MUX16, [`${sum}.s`, 'e0', c('load')], 'or e0');
  b.wire(d, `${er}.d`); b.wire(d, `${rr}.d`);
  b.wire(b.op1(NOT, [c('hold')], 'moves'), `${er}.en`);
  b.wire(b.op1(OR, [c('load'), c('band')], 'R moves'), `${rr}.en`);
  b.wire(e, 'e');
  b.wire(b.op1(NOT, [`${b.op(splitter([15, 1], 2), [e])}.o1`], 'E ≥ 0'), 'inside');
  const R = b.right;
  return define({
    id: 'rv16_edge', name: 'Edge stepper (RV16)', category: 'arithmetic',
    summary: 'One edge function E, stepped with one adder: cmd 0 hold, 1 load (E, R ← e0), 2 right (E + a), 3 skip a tile (E + 4a), 4 down (E + b), 5 up (E − b), 6 next band (E, R ← R + 4b, R the band\'s start), 7 double (E ← 2E + a, for the set-up\'s shift-and-add). inside = E ≥ 0: the sign bit, inverted.',
    ports: [bus('a', 16, 'in'), bus('b', 16, 'in'), bus('e0', 16, 'in'), bus('cmd', 3, 'in'), clkIn(), bus('e', 16, 'out'), bit('inside', 'out')],
    symbol: { kind: 'box', label: 'EDGE' },
    netlist: () => ({ pins: { ...pinsAt(['a', 'b', 'e0', 'cmd'], 0, 6), clk: [0, 28], ...pinsAt(['e', 'inside'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the tile walk ---------------------------------------------------------------------------------------

export const TILE16: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  const ins = ['tx0', 'tx1', 'ty0', 'ty1', 'go', 'ok', 'clk', 'rst'];
  b.pins(...ins);
  const busy = b.add(RV16_DFF, 'busy', 'busyF');
  const tf = b.add(RV16_DFF, 'TEST next', 'testF');
  const kr = b.add(RV16_REG4, 'pixel k', 'k');
  const txr = b.add(RV16_REG4, 'tile x', 'tx');
  const tyr = b.add(RV16_REG4, 'tile y', 'ty');
  for (const r of [busy, tf, kr, txr, tyr]) b.wire('clk', `${r}.clk`);
  const bz = b.name(`${busy}.q`, 'busy', true);
  const tx = b.name(`${b.op(splitter([3, 1], 2), [`${txr}.q`])}.o0`, 'tx', true);
  const ty = b.name(`${b.op(splitter([3, 1], 2), [`${tyr}.q`])}.o0`, 'ty', true);
  const kb = b.op(splitter(ones(4), 2), [`${kr}.q`], 'k bits');
  const nrst = b.op1(NOT, ['rst'], 'not reset');
  b.next();
  const test = b.name(b.op1(AND, [bz, `${tf}.q`], 'TEST'), 'test', true);
  const pix = b.name(b.op1(AND, [bz, b.op1(NOT, [`${tf}.q`])], 'a pixel'), 'pix', true);
  const lastX = b.op1(equal(3), [tx, 'tx1'], 'last column of tiles');
  const lastY = b.op1(equal(3), [ty, 'ty1'], 'last band');
  const k15 = b.op1(andN(4), ones(4).map((_, i) => `${kb}.o${i}`), 'k = 15');
  const k3 = b.op1(AND, [`${kb}.o0`, `${kb}.o1`], 'column end');
  b.next();
  const nX = b.op1(NOT, [lastX]), nY = b.op1(NOT, [lastY]);
  const fail = b.op1(AND, [test, b.op1(NOT, ['ok'])], 'tile rejected');
  const tileDone = b.name(b.op1(OR, [fail, b.op1(AND, [pix, k15])], 'tile done'), 'tileDone', true);
  b.next();
  const nextX = b.op1(AND, [tileDone, nX], 'next tile');
  const nextB = b.op1(AND, [tileDone, b.op1(AND, [lastX, nY])], 'next band');
  const finish = b.op1(AND, [tileDone, b.op1(AND, [lastX, lastY])], 'last tile done');
  const start = b.op1(AND, ['go', b.op1(NOT, [bz])], 'start');
  b.next();
  // the steppers' command: TEST rejected → skip or band; a pixel → down / up along its column, right at its
  // end; the last pixel → right to the next tile, or band
  const inPix = b.op1(AND, [pix, b.op1(NOT, [k15])], 'within the tile');
  const right = b.op1(OR, [b.op1(AND, [inPix, k3], 'next column'), b.op1(AND, [b.op1(AND, [pix, k15]), nX], 'next tile')], 'right');
  const vert = b.op1(AND, [inPix, b.op1(NOT, [k3])], 'along the column');
  const down = b.op1(AND, [vert, b.op1(NOT, [`${kb}.o2`])], 'down'), up = b.op1(AND, [vert, `${kb}.o2`], 'up');
  const skip = b.op1(AND, [fail, nX], 'skip');
  b.next();
  // one-hot → code: right 2, skip 3, down 4, up 5, band 6
  const c0 = b.op1(OR, [skip, up], 'cmd bit 0');
  const c1 = b.op1(orN(3), [right, skip, nextB], 'cmd bit 1');
  const c2 = b.op1(orN(3), [down, up, nextB], 'cmd bit 2');
  b.wire(b.op1(merger(ones(3), 2), [c0, c1, c2], 'cmd'), 'cmd');
  // next state
  b.wire(b.op1(AND, [b.op1(OR, [start, b.op1(AND, [bz, b.op1(NOT, [finish])])]), nrst], 'busy next'), `${busy}.d`);
  b.wire(b.op1(OR, [start, tileDone], 'TEST next'), `${tf}.d`);
  const kInc = b.op1(rca(4), [`${kr}.q`, b.op1(constWord(4, 0), []), b.op1(constWord(1, 1), [])], 'k + 1');
  b.wire(b.op1(busMux2(4), [kInc, b.op1(constWord(4, 0), []), b.op1(OR, [tileDone, start])], 'k next'), `${kr}.d`);
  b.wire(b.op1(OR, [pix, start]), `${kr}.en`);
  const z1 = b.op1(constWord(1, 0), []);
  const ext = (v: string) => b.op1(merger([3, 1], 2), [v, z1]);
  const txInc = b.op1(rca(4), [`${txr}.q`, b.op1(constWord(4, 0), []), b.op1(constWord(1, 1), [])], 'tx + 1');
  b.wire(b.op1(busMux2(4), [txInc, ext('tx0'), b.op1(OR, [start, nextB])], 'tx next'), `${txr}.d`);
  b.wire(b.op1(orN(3), [start, nextX, nextB]), `${txr}.en`);
  const tyInc = b.op1(rca(4), [`${tyr}.q`, b.op1(constWord(4, 0), []), b.op1(constWord(1, 1), [])], 'ty + 1');
  b.wire(b.op1(busMux2(4), [tyInc, ext('ty0'), start], 'ty next'), `${tyr}.d`);
  b.wire(b.op1(OR, [start, nextB]), `${tyr}.en`);
  b.next();
  // the pixel: tile · 4 + (column, row); a row runs up in odd columns
  const row = b.op1(bitwise('xor', 2), [b.op1(merger([1, 1], 2), [`${kb}.o0`, `${kb}.o1`]), b.op1(merger([1, 1], 2), [`${kb}.o2`, `${kb}.o2`])], 'row');
  const col = b.op1(merger([1, 1], 2), [`${kb}.o2`, `${kb}.o3`], 'column');
  b.wire(b.op1(merger([2, 3], 2), [col, tx], 'x'), 'x');
  b.wire(b.op1(merger([2, 3], 2), [row, ty], 'y'), 'y');
  b.wire(test, 'test'); b.wire(pix, 'pix'); b.wire(bz, 'busy');
  const R = b.right;
  return define({
    id: 'rv16_tile', name: 'Tile walk (RV16)', category: 'cpu',
    summary: 'Walks the box tx0 … tx1, ty0 … ty1 of 4 × 4-pixel tiles in bands: go while idle starts it at the first tile. Each tile has a TEST cycle at its top-left pixel: ok → its 16 pixels follow, column by column (down, up, down, up), ending at its top-right pixel; not ok → skip to the next tile (+4a) or the next band. cmd steers the edge steppers; pix marks the pixels of an accepted tile, (x, y) where the walk is.',
    ports: [bus('tx0', 3, 'in'), bus('tx1', 3, 'in'), bus('ty0', 3, 'in'), bus('ty1', 3, 'in'), bit('go', 'in'), bit('ok', 'in'), clkIn(), bit('rst', 'in'),
      bus('x', 5, 'out'), bus('y', 5, 'out'), bus('cmd', 3, 'out'), bit('test', 'out'), bit('pix', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'TILE WALK' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 4), ...pinsAt(['x', 'y', 'cmd', 'test', 'pix', 'busy'], R, 5) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the rasterizer --------------------------------------------------------------------------------------

/** x + y + cin on 4·nib bits, from 4-bit ripple adders; the sum (unless only the carry is wanted) and the last carry. */
function addNib(b: Builder, x: string, y: string, cin: string, nib: number, label: string, sum = true): { s: string; cout: string } {
  const W = Array<number>(nib).fill(4);
  const sx = b.op(splitter(W, 2), [x]), sy = b.op(splitter(W, 2), [y]);
  let c = cin;
  const s: string[] = [];
  for (let i = 0; i < nib; i++) {
    const u = b.op(rca(4), [`${sx}.o${i}`, `${sy}.o${i}`, c], `${label}, bits ${4 * i + 3}…${4 * i}`);
    s.push(`${u}.s`);
    c = `${u}.cout`;
  }
  return { s: sum ? b.op1(merger(W, 2), s, label) : '', cout: c };
}

/** The sign bit of a 16-bit value. */
function top16(b: Builder, v: string): string {
  return `${b.op(splitter([15, 1], 2), [v])}.o1`;
}

const VP = ['v0x', 'v0y', 'v1x', 'v1y', 'v2x', 'v2y'];

/** a − b on 8 bits: a + NOT b + 1 on two 4-bit adders. */
export const RSUB8: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('a', 'b');
  const inv = b.op1(bitwise('xor', 8), ['b', b.op1(constWord(8, 0xff), [])], 'NOT b');
  b.next();
  b.wire(addNib(b, 'a', inv, b.op1(constWord(1, 1), []), 2, 'a + NOT b + 1').s, 'd');
  const R = b.right;
  return define({
    id: 'rv16_sub8', name: '8-bit subtractor (RV16)', category: 'arithmetic',
    summary: 'd = a − b in two\'s complement: a + NOT b + 1, two 4-bit ripple adders with a carry in of 1.',
    ports: [bus('a', 8, 'in'), bus('b', 8, 'in'), bus('d', 8, 'out')],
    symbol: { kind: 'box', label: 'a − b' },
    spec: ([a, c]) => [(a - c) & 0xff],
    netlist: () => ({ pins: { a: [0, 4], b: [0, 10], d: [R, 7] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The box along one axis, in tiles: first = the smallest (p + 1) >> 4, last = the largest max(p − 2, 0) >> 4. */
export const RTILES: ComponentDef = (() => {
  const b = new Builder(18, 12, 4);
  b.pins('p0', 'p1', 'p2');
  const one = b.op1(constWord(1, 1), []), zero = b.op1(constWord(1, 0), []);
  const z8 = (v: string) => b.op1(merger([7, 1], 2), [v, zero]);
  const first = (v: string) => `${b.op(splitter([4, 4], 2), [addNib(b, z8(v), b.op1(constWord(8, 0), []), one, 2, '+1').s])}.o1`;
  const last = (v: string) => {
    const d = b.op(splitter([4, 3, 1], 2), [addNib(b, z8(v), b.op1(constWord(8, 0xfe), []), zero, 2, '−2').s]);
    return b.op1(bitwise('and', 3), [`${d}.o1`, b.op1(fanout(3), [b.op1(NOT, [`${d}.o2`])])], 'clamped at 0');
  };
  const inv4 = (v: string) => b.op1(bitwise('xor', 4), [v, b.op1(constWord(4, 15), [])]);
  const ge4 = (x: string, y: string) => addNib(b, x, inv4(y), one, 1, '≥?', false).cout;
  const min4 = (x: string, y: string) => b.op1(busMux2(4), [x, y, ge4(x, y)], 'min');
  const z4 = (v: string) => b.op1(merger([3, 1], 2), [v, zero]);
  const max3 = (x: string, y: string) => b.op1(busMux2(3), [y, x, ge4(z4(x), z4(y))], 'max');
  const f = ['p0', 'p1', 'p2'].map(first), l = ['p0', 'p1', 'p2'].map(last);
  b.next();
  b.wire(min4(min4(f[0], f[1]), f[2]), 'first');
  b.wire(max3(max3(l[0], l[1]), l[2]), 'last');
  const R = b.right;
  return define({
    id: 'rv16_rtiles', name: 'Tile range (RV16)', category: 'arithmetic',
    summary: 'Along one axis, from three 7-bit coordinates in quarter pixels: first, the smallest (p + 1) >> 4 (the tile of the first pixel centre at or after the smallest p, 4 bits: 8 only when all three are 127), and last, the largest max(p − 2, 0) >> 4. A comparison is the carry of a + NOT b + 1.',
    ports: [bus('p0', 7, 'in'), bus('p1', 7, 'in'), bus('p2', 7, 'in'), bus('first', 4, 'out'), bus('last', 3, 'out')],
    symbol: { kind: 'box', label: 'TILES' },
    spec: ([p0, p1, p2]) => [Math.min((p0 + 1) >> 4, (p1 + 1) >> 4, (p2 + 1) >> 4), Math.max(Math.max(p0 - 2, 0) >> 4, Math.max(p1 - 2, 0) >> 4, Math.max(p2 - 2, 0) >> 4)],
    netlist: () => ({ pins: { p0: [0, 4], p1: [0, 10], p2: [0, 16], first: [R, 6], last: [R, 14] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The tile test's offset: 12·(A⁺ + B⁺), A⁺ = A when positive, else 0. */
export const ROFF: ComponentDef = (() => {
  const b = new Builder(8, 10, 4);
  b.pins('a', 'b');
  const zero = b.op1(constWord(1, 0), []);
  const top = (v: string) => `${b.op(splitter([7, 1], 2), [v])}.o1`;
  const plus = (v: string) => b.op1(bitwise('and', 8), [v, b.op1(fanout(8), [b.op1(NOT, [top(v)])])], `${v}⁺`);
  const s = addNib(b, plus('a'), plus('b'), zero, 2, 'A⁺ + B⁺');
  b.next();
  const v = b.op1(merger([8, 1], 2), [s.s, s.cout]);
  const twelve = addNib(b, b.op1(merger([3, 9], 2), [b.op1(constWord(3, 0), []), v], '×8'), b.op1(merger([2, 9, 1], 2), [b.op1(constWord(2, 0), []), v, zero], '×4'), zero, 3, '×12').s;
  b.next();
  b.wire(b.op1(merger([12, 4], 2), [twelve, b.op1(constWord(4, 0), [])]), 'off');
  const R = b.right;
  const pos = (x: number) => (x & 0x80 ? 0 : x);
  return define({
    id: 'rv16_roff', name: 'Tile test offset (RV16)', category: 'arithmetic',
    summary: '12·(A⁺ + B⁺), A⁺ = A when positive, else 0: how much larger E is at a tile\'s best corner than at its top-left pixel (three pixels right where A > 0, three down where B > 0). ×12 = ×8 + ×4, wired shifts and one adder.',
    ports: [bus('a', 8, 'in'), bus('b', 8, 'in'), bus('off', 16, 'out')],
    symbol: { kind: 'box', label: '12·(A⁺ + B⁺)' },
    spec: ([a, c]) => [12 * (pos(a) + pos(c))],
    netlist: () => ({ pins: { a: [0, 4], b: [0, 10], off: [R, 7] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Set-up, all combinational, from the vertices: per edge A = y_i − y_{i+1}, B = x_{i+1} − x_i (8 bits signed), the
 * top-left bias, the offsets Δx = ox − x_i, Δy = oy − y_i from the first tile's top-left pixel centre (ox, oy) =
 * (16·tx0 + 2, 16·ty0 + 2), the tile test's offset 12·(A⁺ + B⁺); the box in tiles. Adders only.
 */
export const RSETUP16: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins(...VP);
  const zero = b.op1(constWord(1, 0), []);
  const z8 = (v: string) => b.op1(merger([7, 1], 2), [v, zero]);
  const X = E3.map((i) => z8(`v${i}x`)), Y = E3.map((i) => z8(`v${i}y`));
  const tx = b.op(RTILES, ['v0x', 'v1x', 'v2x'], 'tiles across', 'tilesX');
  const ty = b.op(RTILES, ['v0y', 'v1y', 'v2y'], 'tiles down', 'tilesY');
  b.next();
  const A = E3.map((i) => b.name(b.op1(RSUB8, [Y[i], Y[(i + 1) % 3]], `A${i}`), `A${i}`, true));
  const B = E3.map((i) => b.name(b.op1(RSUB8, [X[(i + 1) % 3], X[i]], `B${i}`), `B${i}`, true));
  const two = b.op1(constWord(4, 2), []);
  const ox = b.op1(merger([4, 4], 2), [two, `${tx}.first`], '16·tx0 + 2'), oy = b.op1(merger([4, 4], 2), [two, `${ty}.first`], '16·ty0 + 2');
  b.next();
  const dX = E3.map((i) => b.op1(RSUB8, [ox, X[i]], `Δx${i}`)), dY = E3.map((i) => b.op1(RSUB8, [oy, Y[i]], `Δy${i}`));
  const off = E3.map((i) => b.op1(ROFF, [A[i], B[i]], `offset ${i}`));
  b.next();
  const top = (v: string) => `${b.op(splitter([7, 1], 2), [v])}.o1`;
  const pos = (v: string) => b.op1(AND, [b.op1(NOT, [top(v)]), b.op1(NOT, [b.op1(isZero(8), [v])])]);
  const bias = E3.map((i) => {
    const flat = b.op1(AND, [b.op1(isZero(8), [A[i]]), pos(B[i])], `top edge ${i}?`);
    return b.op1(NOT, [b.op1(OR, [pos(A[i]), flat], `left or top ${i}`)], `bias ${i}`);
  });
  b.next();
  const lo3 = (v: string) => `${b.op(splitter([3, 1], 2), [v])}.o0`;
  E3.forEach((i) => {
    b.wire(A[i], `a${i}`); b.wire(B[i], `b${i}`); b.wire(bias[i], `bias${i}`);
    b.wire(dX[i], `dx${i}`); b.wire(dY[i], `dy${i}`); b.wire(off[i], `off${i}`);
  });
  b.wire(lo3(`${tx}.first`), 'tx0'); b.wire(`${tx}.last`, 'tx1'); b.wire(lo3(`${ty}.first`), 'ty0'); b.wire(`${ty}.last`, 'ty1');
  const outs = [...E3.flatMap((i) => [`a${i}`, `b${i}`, `bias${i}`, `dx${i}`, `dy${i}`, `off${i}`]), 'tx0', 'tx1', 'ty0', 'ty1'];
  const R = b.right;
  return define({
    id: 'rv16_rsetup', name: 'Triangle set-up (RV16)', category: 'arithmetic',
    summary: 'From the three vertices (7-bit quarter pixels): per edge A and B (8 bits signed), the top-left bias, the offsets Δx, Δy from the first tile\'s top-left pixel centre, and the tile test\'s offset 12·(A⁺ + B⁺); the box in tiles. Subtractors and adders only.',
    ports: [...VP.map((p) => bus(p, 7, 'in')), ...E3.flatMap((i) => [bus(`a${i}`, 8, 'out'), bus(`b${i}`, 8, 'out'), bit(`bias${i}`, 'out'), bus(`dx${i}`, 8, 'out'), bus(`dy${i}`, 8, 'out'), bus(`off${i}`, 16, 'out')]),
      bus('tx0', 3, 'out'), bus('tx1', 3, 'out'), bus('ty0', 3, 'out'), bus('ty1', 3, 'out')],
    symbol: { kind: 'box', label: 'SET-UP' },
    netlist: () => ({ pins: { ...pinsAt(VP, 0, 8), ...pinsAt(outs, R, 4) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The set-up's steps, a flip-flop each, in order: load, the two sign steps, 14 shift-and-add steps, the bias, the cull. */
const CHAIN = ['load', 'upX', 'upY', 'pairs', 'bias', 'cull'] as const;

/**
 * The set-up's sequence: go while idle (walk included) starts load → upX → upY → 7 pairs in 14 steps (t = 0 … 13; j = t >> 1
 * picks bit 6 − j of Δ, h = t mod 2: double and add A, or add B) → bias → cull. cmd: the steppers' command for
 * the step (load 1, up 5, double 7, right 2; cull loads E into itself, so R starts at the first tile too).
 */
export const RSEQ16: ComponentDef = (() => {
  const b = new Builder(18, 12, 4);
  const ins = ['go', 'walking', 'clk', 'rst'];
  b.pins(...ins);
  const one = b.op1(constWord(1, 1), []);
  const nrst = b.op1(NOT, ['rst'], 'not reset');
  const ch = Object.fromEntries(CHAIN.map((k) => [k, b.add(RV16_DFF, k, `s_${k}`)])) as Record<typeof CHAIN[number], string>;
  const tr = b.add(RV16_REG4, 'pair step t', 't');
  for (const r of [...Object.values(ch), tr]) b.wire('clk', `${r}.clk`);
  const q = (k: typeof CHAIN[number]) => b.name(`${ch[k]}.q`, k, true);
  const busy = b.name(b.op1(OR, [b.op1(orN(4), [q('load'), q('upX'), q('upY'), q('pairs')]), b.op1(orN(3), [q('bias'), q('cull'), 'walking'])], 'busy'), 'busyAll', true);
  const start = b.op1(andN(3), ['go', b.op1(NOT, [busy]), nrst], 'start');
  const tb = b.op(splitter(ones(4), 2), [`${tr}.q`], 't bits');
  const t13 = b.op1(equal(4), [`${tr}.q`, b.op1(constWord(4, 13), [])], 'last pair');
  b.next();
  const gate = (v: string) => b.op1(AND, [v, nrst]);
  b.wire(start, `${ch.load}.d`);
  b.wire(gate(q('load')), `${ch.upX}.d`);
  b.wire(gate(q('upX')), `${ch.upY}.d`);
  b.wire(gate(b.op1(OR, [q('upY'), b.op1(AND, [q('pairs'), b.op1(NOT, [t13])])])), `${ch.pairs}.d`);
  b.wire(gate(b.op1(AND, [q('pairs'), t13])), `${ch.bias}.d`);
  b.wire(gate(q('bias')), `${ch.cull}.d`);
  b.wire(b.op1(busMux2(4), [b.op1(constWord(4, 0), []), addNib(b, `${tr}.q`, b.op1(constWord(4, 0), []), one, 1, 't + 1').s, q('pairs')], 't next'), `${tr}.d`);
  b.wire(one, `${tr}.en`);
  const h = `${tb}.o0`;
  const ups = b.op1(OR, [q('upX'), q('upY')], 'sign steps');
  const dbl = b.op1(AND, [q('pairs'), b.op1(NOT, [h])], 'double');
  b.next();
  const c0 = b.op1(OR, [b.op1(orN(4), [q('load'), ups, q('bias'), dbl]), q('cull')], 'cmd bit 0');
  const c2 = b.op1(orN(3), [ups, q('bias'), dbl], 'cmd bit 2');
  b.wire(b.op1(merger(ones(3), 2), [c0, q('pairs'), c2], 'cmd'), 'cmd');
  b.wire(b.op1(merger([1, 1, 1], 2), [`${tb}.o1`, `${tb}.o2`, `${tb}.o3`], 'j = t >> 1'), 'j');
  b.wire(h, 'h');
  for (const k of CHAIN) if (k !== 'load') b.wire(q(k), k);
  b.wire(busy, 'busy');
  const outs = ['cmd', 'j', 'h', 'upX', 'upY', 'pairs', 'bias', 'cull', 'busy'];
  const R = b.right;
  return define({
    id: 'rv16_rseq', name: 'Set-up sequencer (RV16)', category: 'sequential',
    summary: 'A flip-flop per set-up step: go while idle starts load, then the two sign steps (Δx₇, Δy₇ weigh −128), 7 shift-and-add pairs in 14 steps counted by t (j = t >> 1 picks the bit, h = t mod 2 the operand, A or B), the bias, the cull. cmd is the steppers\' command for the step; busy covers the set-up and the walk.',
    ports: [bit('go', 'in'), bit('walking', 'in'), clkIn(), bit('rst', 'in'), bus('cmd', 3, 'out'), bus('j', 3, 'out'), bit('h', 'out'),
      ...CHAIN.filter((k) => k !== 'load').map((k) => bit(k, 'out')), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'SET-UP STEPS' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(outs, R, 4) }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * One stepper's operands: during the walk a = 4A, b = 4B (a pixel); during the set-up the shift-and-add's: the
 * sign steps subtract A·Δx₇ and B·Δy₇ (b), the pairs add A or B when bit 6 − j of Δx or Δy is set (a), the bias
 * step subtracts the bias (b). e0 is 0, or E itself in the cull step.
 */
export const ROPER16: ComponentDef = (() => {
  const b = new Builder(18, 12, 4);
  const ins = ['a', 'b', 'dx', 'dy', 'bias', 'j', 'h', 'upX', 'upY', 'pairs', 'biasStep', 'cull', 'e'];
  b.pins(...ins);
  const zero = b.op1(constWord(1, 0), []);
  const top = (v: string) => `${b.op(splitter([7, 1], 2), [v])}.o1`;
  const sx16 = (v: string) => b.op1(merger([8, 8], 2), [v, b.op1(fanout(8), [top(v)])], 'sign-extended');
  const A16 = sx16('a'), B16 = sx16('b');
  const bitOf = (d: string) => {
    const s = b.op(splitter(ones(8), 2), [d]);
    return b.op1(muxTree(3, 1), [...[6, 5, 4, 3, 2, 1, 0].map((k) => `${s}.o${k}`), zero, 'j'], 'bit 6 − j');
  };
  b.next();
  const ups = b.op1(OR, ['upX', 'upY'], 'sign steps');
  const useB = b.op1(OR, ['upY', b.op1(AND, ['pairs', 'h'])], 'B side?');
  const pb = b.op1(busMux2(1), [bitOf('dx'), bitOf('dy'), 'h']);
  const ub = b.op1(busMux2(1), [top('dx'), top('dy'), 'upY']);
  const bitv = b.op1(busMux2(1), [pb, ub, ups], 'the bit');
  b.next();
  const mop = b.op1(bitwise('and', 16), [b.op1(MUX16, [A16, B16, useB]), b.op1(fanout(16), [bitv])], 'A or B, or 0');
  b.next();
  b.wire(b.op1(MUX16, [shl16(b, A16, 2), mop, 'pairs'], 'a'), 'ao');
  const bias16 = b.op1(merger([1, 15], 2), ['bias', b.op1(constWord(15, 0), [])]);
  b.wire(b.op1(MUX16, [b.op1(MUX16, [shl16(b, B16, 2), mop, ups]), bias16, 'biasStep'], 'b'), 'bo');
  b.wire(b.op1(MUX16, [b.op1(constWord(16, 0), []), 'e', 'cull'], '0, or E'), 'e0');
  const R = b.right;
  return define({
    id: 'rv16_roper', name: 'Stepper operands (RV16)', category: 'routing',
    summary: 'Feeds one edge stepper: 4A and 4B while the walk runs; during the set-up the shift-and-add\'s operand, A or B when the chosen bit of Δx or Δy is set, else 0 (the sign steps subtract it, the pairs add it), then the bias; e0 is 0 at the start, the stepper\'s own E in the cull step.',
    ports: [bus('a', 8, 'in'), bus('b', 8, 'in'), bus('dx', 8, 'in'), bus('dy', 8, 'in'), bit('bias', 'in'), bus('j', 3, 'in'), bit('h', 'in'), bit('upX', 'in'), bit('upY', 'in'),
      bit('pairs', 'in'), bit('biasStep', 'in'), bit('cull', 'in'), bus('e', 16, 'in'), bus('ao', 16, 'out'), bus('bo', 16, 'out'), bus('e0', 16, 'out')],
    symbol: { kind: 'box', label: 'OPERANDS' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 4), ...pinsAt(['ao', 'bo', 'e0'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The cull (twice the area = E0 + E1 + E2 + the biases, > 0 for a front face) and the tile test (E + offset ≥ 0 for every edge). */
export const RTEST16: ComponentDef = (() => {
  const b = new Builder(18, 12, 4);
  const ins = [...E3.map((i) => `e${i}`), ...E3.map((i) => `off${i}`), ...E3.map((i) => `bias${i}`)];
  b.pins(...ins);
  const zero = b.op1(constWord(1, 0), []);
  const s1 = b.op(ADD16, ['e0', 'e1', zero]);
  const fa3 = b.op(FULL_ADDER, ['bias0', 'bias1', 'bias2'], 'biases');
  b.next();
  const s2 = b.op(ADD16, [`${s1}.s`, 'e2', zero]);
  b.next();
  const area = b.op(ADD16, [`${s2}.s`, b.op1(merger([1, 1, 14], 2), [`${fa3}.s`, `${fa3}.cout`, b.op1(constWord(14, 0), [])]), zero], 'twice the area');
  const tneg = E3.map((i) => top16(b, `${b.op(ADD16, [`e${i}`, `off${i}`, zero], `tile test ${i}`)}.s`));
  b.next();
  b.wire(b.op1(AND, [b.op1(NOT, [top16(b, `${area}.s`)]), b.op1(NOT, [b.op1(isZero(16), [`${area}.s`])])], 'front face'), 'front');
  b.wire(b.op1(NOT, [b.op1(orN(3), tneg)], 'tile may hold pixels'), 'ok');
  const R = b.right;
  return define({
    id: 'rv16_rtest', name: 'Cull and tile test (RV16)', category: 'arithmetic',
    summary: 'front: E0 + E1 + E2 plus the three biases (twice the signed area, the same at every point) is > 0. ok: E + 12·(A⁺ + B⁺), each edge at the tile\'s best corner, is ≥ 0 for all three: the tile may hold pixels.',
    ports: [...E3.map((i) => bus(`e${i}`, 16, 'in')), ...E3.map((i) => bus(`off${i}`, 16, 'in')), ...E3.map((i) => bit(`bias${i}`, 'in')), bit('front', 'out'), bit('ok', 'out')],
    symbol: { kind: 'box', label: 'CULL · TILE TEST' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(['front', 'ok'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
})();

export const RASTER16: ComponentDef = (() => {
  const b = new Builder(10, 14, 4);
  const ins = [...VP, 'col', 'go', 'clk', 'rst'];
  b.pins(...ins);
  const su = b.op(RSETUP16, VP, 'set-up', 'setup');
  const seq = b.add(RSEQ16, 'set-up steps', 'seq');
  for (const p of ['go', 'clk', 'rst']) b.wire(p, `${seq}.${p}`);
  b.next();
  const st = E3.map((i) => {
    const op = b.add(ROPER16, `operands ${i}`, `op${i}`);
    for (const [d, p] of [[`${su}.a${i}`, 'a'], [`${su}.b${i}`, 'b'], [`${su}.dx${i}`, 'dx'], [`${su}.dy${i}`, 'dy'], [`${su}.bias${i}`, 'bias'],
      [`${seq}.j`, 'j'], [`${seq}.h`, 'h'], [`${seq}.upX`, 'upX'], [`${seq}.upY`, 'upY'], [`${seq}.pairs`, 'pairs'], [`${seq}.bias`, 'biasStep'], [`${seq}.cull`, 'cull']]) b.wire(d, `${op}.${p}`);
    return op;
  });
  b.next();
  const walk = b.add(TILE16, 'tile walk', 'walk');
  const cmd = b.op1(bitwise('or', 3), [`${seq}.cmd`, `${walk}.cmd`], 'cmd');
  const ed = E3.map((i) => {
    const e = b.op(EDGE16, [`${st[i]}.ao`, `${st[i]}.bo`, `${st[i]}.e0`, cmd, 'clk'], `edge ${i}`, `edge${i}`);
    b.wire(`${e}.e`, `${st[i]}.e`);
    return e;
  });
  b.next();
  const t = b.op(RTEST16, [...ed.map((e) => `${e}.e`), ...E3.map((i) => `${su}.off${i}`), ...E3.map((i) => `${su}.bias${i}`)], 'cull, tile test', 'test');
  b.next();
  for (const [d, p] of [[`${su}.tx0`, 'tx0'], [`${su}.tx1`, 'tx1'], [`${su}.ty0`, 'ty0'], [`${su}.ty1`, 'ty1'], [b.op1(AND, [`${seq}.cull`, `${t}.front`], 'walk'), 'go'], [`${t}.ok`, 'ok'], ['clk', 'clk'], ['rst', 'rst']]) b.wire(d, `${walk}.${p}`);
  b.wire(`${walk}.busy`, `${seq}.walking`);
  const inside = b.op1(andN(3), ed.map((e) => `${e}.inside`), 'inside');
  b.next();
  b.wire(b.op1(AND, [`${walk}.pix`, inside], 'write'), 'fwe');
  b.wire(b.op1(merger([5, 5], 2), [`${walk}.x`, `${walk}.y`], '32·y + x'), 'fa');
  b.wire('col', 'fd');
  b.wire(`${seq}.busy`, 'busy');
  const R = b.right;
  return define({
    id: 'rv16_raster', name: 'Rasterizer (RV16)', category: 'cpu',
    summary: 'A triangle in (7-bit quarter-pixel vertices, held while busy), its pixels out, one a cycle, on a 32 × 32 screen. Set-up: A, B, the top-left bias and the box by adders; each stepper computes its E at the first tile by shift-and-add (17 steps), and the sum of the three E culls back faces. Then the tile walk, with the tile test on a second adder per edge.',
    ports: [...VP.map((p) => bus(p, 7, 'in')), bus('col', 16, 'in'), bit('go', 'in'), clkIn(), bit('rst', 'in'), bus('fa', 10, 'out'), bus('fd', 16, 'out'), bit('fwe', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'RASTERIZER' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(['fa', 'fd', 'fwe', 'busy'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
})();
