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

/** Busy cycles of the set-up chain, in order: load, the two sign steps, 14 shift-and-add steps, the bias, the cull. */
const CHAIN = ['load', 'upX', 'upY', 'pairs', 'bias', 'cull'] as const;

export const RASTER16: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  const VP = ['v0x', 'v0y', 'v1x', 'v1y', 'v2x', 'v2y'];
  const ins = [...VP, 'col', 'go', 'clk', 'rst'];
  b.pins(...ins);
  const one = b.op1(constWord(1, 1), []), zero = b.op1(constWord(1, 0), []);
  const nrst = b.op1(NOT, ['rst'], 'not reset');
  const z8 = (v: string) => b.op1(merger([7, 1], 2), [v, zero]);
  const X = E3.map((i) => z8(`v${i}x`)), Y = E3.map((i) => z8(`v${i}y`));
  b.next();
  // set-up, per edge: A = y_i − y_{i+1}, B = x_{i+1} − x_i (8 bits, signed); the top-left bias
  const inv = (v: string, w: number) => b.op1(bitwise('xor', w), [v, b.op1(constWord(w, 2 ** w - 1), [])]);
  const sub8 = (x: string, y: string, label: string) => addNib(b, x, inv(y, 8), one, 2, label).s;
  const top = (v: string) => `${b.op(splitter([7, 1], 2), [v])}.o1`;
  const sx16 = (v: string) => b.op1(merger([8, 8], 2), [v, b.op1(fanout(8), [top(v)])]);
  const A = E3.map((i) => b.name(sub8(Y[i], Y[(i + 1) % 3], `A${i}`), `A${i}`, true));
  const B = E3.map((i) => b.name(sub8(X[(i + 1) % 3], X[i], `B${i}`), `B${i}`, true));
  b.next();
  const pos = (v: string) => b.op1(AND, [b.op1(NOT, [top(v)]), b.op1(NOT, [b.op1(isZero(8), [v])])]);
  const bias = E3.map((i) => {
    const flat = b.op1(AND, [b.op1(isZero(8), [A[i]]), pos(B[i])], `top edge ${i}?`);
    return b.name(b.op1(NOT, [b.op1(OR, [pos(A[i]), flat], `left or top ${i}`)], `bias ${i}`), `bias${i}`, true);
  });
  // the box in tiles: first tile (min + 1) >> 4, last max(max − 2, 0) >> 4, over the three vertices
  const firstT = (v: string) => `${b.op(splitter([4, 4], 2), [addNib(b, v, b.op1(constWord(8, 0), []), one, 2, '+1').s])}.o1`;
  const lastT = (v: string) => {
    const d = b.op(splitter([4, 3, 1], 2), [addNib(b, v, b.op1(constWord(8, 0xfe), []), zero, 2, '−2').s]);
    return b.op1(bitwise('and', 3), [`${d}.o1`, b.op1(fanout(3), [b.op1(NOT, [`${d}.o2`])])], 'clamped at 0');
  };
  const ge4 = (x: string, y: string) => addNib(b, x, inv(y, 4), one, 1, '≥?', false).cout;
  const min4 = (x: string, y: string) => b.op1(busMux2(4), [x, y, ge4(x, y)], 'min');
  const z4 = (v: string) => b.op1(merger([3, 1], 2), [v, zero]);
  const max3 = (x: string, y: string) => b.op1(busMux2(3), [y, x, ge4(z4(x), z4(y))], 'max');
  b.next();
  const tx0 = b.name(min4(min4(firstT(X[0]), firstT(X[1])), firstT(X[2])), 'tx0', true);
  const ty0 = b.name(min4(min4(firstT(Y[0]), firstT(Y[1])), firstT(Y[2])), 'ty0', true);
  const tx1 = b.name(max3(max3(lastT(X[0]), lastT(X[1])), lastT(X[2])), 'tx1', true);
  const ty1 = b.name(max3(max3(lastT(Y[0]), lastT(Y[1])), lastT(Y[2])), 'ty1', true);
  b.next();
  // the first tile's top-left pixel centre (16·t + 2) and each vertex's offset from it, 8 bits signed
  const two = b.op1(constWord(4, 2), []);
  const ox = b.op1(merger([4, 4], 2), [two, tx0], '16·tx0 + 2'), oy = b.op1(merger([4, 4], 2), [two, ty0], '16·ty0 + 2');
  const dX = E3.map((i) => b.name(sub8(ox, X[i], `Δx${i}`), `dx${i}`, true)), dY = E3.map((i) => b.name(sub8(oy, Y[i], `Δy${i}`), `dy${i}`, true));
  // the tile test's offset: 12·(A⁺ + B⁺), A⁺ = A when positive, else 0
  const plus = (v: string) => b.op1(bitwise('and', 8), [v, b.op1(fanout(8), [b.op1(NOT, [top(v)])])]);
  const off = E3.map((i) => {
    const s = addNib(b, plus(A[i]), plus(B[i]), zero, 2, `A⁺ + B⁺ ${i}`);
    const v = b.op1(merger([8, 1], 2), [s.s, s.cout]);
    const twelve = addNib(b, b.op1(merger([3, 9], 2), [b.op1(constWord(3, 0), []), v]), b.op1(merger([2, 9, 1], 2), [b.op1(constWord(2, 0), []), v, zero]), zero, 3, `×12 ${i}`).s;
    return b.op1(merger([12, 4], 2), [twelve, b.op1(constWord(4, 0), [])], `offset ${i}`);
  });
  b.next();
  // the set-up sequence: a flip-flop a step, a counter for the shift-and-add pairs
  const ch = Object.fromEntries(CHAIN.map((k) => [k, b.add(RV16_DFF, k, `s_${k}`)])) as Record<typeof CHAIN[number], string>;
  const tr = b.add(RV16_REG4, 'pair step t', 't');
  for (const r of [...Object.values(ch), tr]) b.wire('clk', `${r}.clk`);
  const q = (k: typeof CHAIN[number]) => b.name(`${ch[k]}.q`, k, true);
  const walk = b.add(TILE16, 'tile walk', 'walk');
  const busy = b.name(b.op1(OR, [b.op1(orN(4), [q('load'), q('upX'), q('upY'), q('pairs')]), b.op1(orN(3), [q('bias'), q('cull'), `${walk}.busy`])], 'busy'), 'busyAll', true);
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
  // pair j = t >> 1 uses bit 6 − j of Δ; t even: double and add A, odd: add B
  const j = b.op1(merger([1, 1, 1], 2), [`${tb}.o1`, `${tb}.o2`, `${tb}.o3`], 'j');
  const h = `${tb}.o0`, nh = b.op1(NOT, [h]);
  const ups = b.op1(OR, [q('upX'), q('upY')], 'sign steps');
  const dbl = b.op1(AND, [q('pairs'), nh], 'double');
  b.next();
  const bitOf = (d: string) => {
    const s = b.op(splitter(ones(8), 2), [d]);
    return b.op1(muxTree(3, 1), [...[6, 5, 4, 3, 2, 1, 0].map((k) => `${s}.o${k}`), zero, j], 'Δ bit 6 − j');
  };
  const signOf = (d: string) => top(d);
  const useB = b.op1(OR, [q('upY'), b.op1(AND, [q('pairs'), h])], 'B side?');
  // the cull cycle loads each E into itself, so the band start R holds the first tile's E too
  const c0 = b.op1(OR, [b.op1(orN(4), [q('load'), ups, q('bias'), dbl]), q('cull')], 'cmd bit 0');
  const c2 = b.op1(orN(3), [ups, q('bias'), dbl], 'cmd bit 2');
  const setupCmd = b.op1(merger(ones(3), 2), [c0, q('pairs'), c2], 'set-up command');
  b.next();
  const bias16 = E3.map((i) => b.op1(merger([1, 15], 2), [bias[i], b.op1(constWord(15, 0), [])]));
  const zero16 = b.op1(constWord(16, 0), []);
  const cmd = b.op1(bitwise('or', 3), [setupCmd, `${walk}.cmd`], 'cmd');
  const st = E3.map((i) => {
    const A16 = sx16(A[i]), B16 = sx16(B[i]);
    const pb = b.op1(busMux2(1), [bitOf(dX[i]), bitOf(dY[i]), h]);
    const ub = b.op1(busMux2(1), [signOf(dX[i]), signOf(dY[i]), q('upY')]);
    const bitv = b.op1(busMux2(1), [pb, ub, ups], `bit ${i}`);
    const mop = b.op1(bitwise('and', 16), [b.op1(MUX16, [A16, B16, useB]), b.op1(fanout(16), [bitv])], `A or B, or 0 (${i})`);
    const aIn = b.op1(MUX16, [shl16(b, A16, 2), mop, q('pairs')], `a ${i}`);
    const bIn = b.op1(MUX16, [b.op1(MUX16, [shl16(b, B16, 2), mop, ups]), bias16[i], q('bias')], `b ${i}`);
    const ed = b.op(EDGE16, [aIn, bIn, '', cmd, 'clk'], `edge ${i}`, `edge${i}`);
    b.wire(b.op1(MUX16, [zero16, `${ed}.e`, q('cull')], `0, or E (${i})`), `${ed}.e0`);
    return ed;
  });
  b.next();
  // the cull: E0 + E1 + E2 + the biases is twice the area, at any point
  const s1 = b.op(ADD16, [`${st[0]}.e`, `${st[1]}.e`, zero]);
  const s2 = b.op(ADD16, [`${s1}.s`, `${st[2]}.e`, zero]);
  const fa3 = b.op(FULL_ADDER, [bias[0], bias[1], bias[2]], 'biases');
  const area = b.op(ADD16, [`${s2}.s`, b.op1(merger([1, 1, 14], 2), [`${fa3}.s`, `${fa3}.cout`, b.op1(constWord(14, 0), [])]), zero], 'twice the area');
  const front = b.name(b.op1(AND, [b.op1(NOT, [top16(b, `${area}.s`)]), b.op1(NOT, [b.op1(isZero(16), [`${area}.s`])])], 'front face'), 'front', true);
  // the tile test: E + offset < 0 for some edge rejects the tile
  const tneg = E3.map((i) => top16(b, `${b.op(ADD16, [`${st[i]}.e`, off[i], zero], `tile test ${i}`)}.s`));
  const ok = b.name(b.op1(NOT, [b.op1(orN(3), tneg)], 'tile may hold pixels'), 'ok', true);
  b.next();
  const lo3 = (v: string) => `${b.op(splitter([3, 1], 2), [v])}.o0`;
  for (const [d, p] of [[lo3(tx0), 'tx0'], [tx1, 'tx1'], [lo3(ty0), 'ty0'], [ty1, 'ty1'], [b.op1(AND, [q('cull'), front], 'walk'), 'go'], [ok, 'ok'], ['clk', 'clk'], ['rst', 'rst']]) b.wire(d, `${walk}.${p}`);
  const inside = b.op1(andN(3), E3.map((i) => `${st[i]}.inside`), 'inside');
  b.next();
  b.wire(b.op1(AND, [`${walk}.pix`, inside], 'write'), 'fwe');
  b.wire(b.op1(merger([5, 5], 2), [`${walk}.x`, `${walk}.y`], '32·y + x'), 'fa');
  b.wire('col', 'fd');
  b.wire(busy, 'busy');
  const R = b.right;
  return define({
    id: 'rv16_raster', name: 'Rasterizer (RV16)', category: 'cpu',
    summary: 'A triangle in (7-bit quarter-pixel vertices, held while busy), its pixels out, one a cycle, on a 32 × 32 screen. Set-up: A, B, the top-left bias and the box by adders; each stepper computes its E at the first tile by shift-and-add (17 steps), and the sum of the three E culls back faces. Then the tile walk, with the tile test on a second adder per edge.',
    ports: [...VP.map((p) => bus(p, 7, 'in')), bus('col', 16, 'in'), bit('go', 'in'), clkIn(), bit('rst', 'in'), bus('fa', 10, 'out'), bus('fd', 16, 'out'), bit('fwe', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'RASTERIZER' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(['fa', 'fd', 'fwe', 'busy'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The sign bit of a 16-bit value. */
function top16(b: Builder, v: string): string {
  return `${b.op(splitter([15, 1], 2), [v])}.o1`;
}
