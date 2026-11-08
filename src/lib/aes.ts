// AES-128 in gates. Every box opens down to NANDs. The S-box is not a ROM: it is the field inverse of GF(2^8) computed in a tower of
// fields (crypto/tower.ts: GF(4) → GF(16) → GF(256), Karatsuba products, the inverse by the norm), between two XOR networks that
// change basis (the second one carries the affine step; the constant 0x63 is a few inverters). ShiftRows is wiring and costs nothing.
// The iterative core runs one round a clock beside the key schedule's step, as the standard's figure does.
// crypto/aes.ts is the golden model; tests/crypto-aes.test.ts checks every S-box input, each part, and the core every clock.
// 128-bit ports cannot carry a `spec` (spec values are JS numbers): the wide parts are checked bit by bit against the model instead.

import { xorPlan, type XorPlan } from '../comm/crc';
import { mul16, mul4, SBOX_IN, SBOX_OUT, N4, LAMBDA, inv4, inv16, inv256, matrixOf } from '../crypto/tower';
import { mixColumns, SBOX, xtime } from '../crypto/aes';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { busMux2, incrementer } from './combinational';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR, XOR } from './gates';
import { DFF, register } from './sequential';
import { clearableRegister } from './pipeline';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clk = (): PortDef => bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** The plan's XOR gates over `srcs`, one column per level; returns each output's driver. */
function xorColumns(b: Builder, plan: XorPlan, srcs: string[]): string[] {
  const inputs = srcs.length, level = new Array<number>(inputs).fill(0), gate: string[] = [];
  plan.pairs.forEach(([x, y], k) => { level[inputs + k] = Math.max(level[x], level[y]) + 1; });
  const drv = (id: number) => (id < inputs ? srcs[id] : gate[id - inputs]);
  for (let lv = 1; lv <= plan.depth; lv++) {
    b.next();
    plan.pairs.forEach(([x, y], k) => { if (level[inputs + k] === lv) gate[k] = b.op1(XOR, [drv(x), drv(y)]); });
  }
  b.next();
  return plan.out.map((o) => drv(o));
}

const outOf = (sp: string, n: number) => Array.from({ length: n }, (_, i) => `${sp}.o${i}`);

/** y = M·a over GF(2) (row masks), then XOR the constant `konst` (a NOT on each bit it sets): an XOR network with shared pairs. */
export function linear(id: string, name: string, summary: string, rows: bigint[], nin: number, konst = 0, label = 'LIN', rowsAt?: Record<string, number>): ComponentDef {
  return memo(id, () => {
    const nout = rows.length, b = new Builder(8, 10, 2);
    b.pins('a');
    const sp = b.op(splitter(ones(nin)), ['a']);
    const outs = xorColumns(b, xorPlan(rows, nin, true), outOf(sp, nin));
    for (let i = 0; i < nout; i++) if ((konst >> i) & 1) outs[i] = b.op1(NOT, [outs[i]]);
    b.next();
    b.wire(b.op1(merger(ones(nout)), outs), 'y');
    // gates re-seated within their columns (y of each instance): a drawing aid found by scripts/ (fewest crossings), nothing else changes
    if (rowsAt) for (const i of b.instances) if (i.name in rowsAt) i.at = [i.at![0], rowsAt[i.name]];
    return define({
      id, name, category: 'arithmetic', summary,
      ports: [bus('a', nin, 'in'), bus('y', nout, 'out')], symbol: { kind: 'box', label },
      netlist: () => ({ pins: { a: [0, 12], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Parity of (a & mask) for masks and values up to 32 bits (JS bit operators would go negative). */
const lin = (rows: bigint[], a: number, konst = 0): number => {
  let y = 0;
  rows.forEach((r, i) => { let m = r & BigInt(a), p = 0n; for (; m; m &= m - 1n) p ^= 1n; if (p) y += 2 ** i; });
  return konst ? Number(BigInt(y) ^ BigInt(konst)) : y;
};
/** A linear part with its spec computed from the rows. */
function linearPart(id: string, name: string, summary: string, rows: bigint[], nin: number, konst = 0, label = 'LIN', rowsAt?: Record<string, number>): ComponentDef {
  const d = linear(id, name, summary, rows, nin, konst, label, rowsAt);
  d.spec = ([a]) => [lin(rows, a, konst)];
  return d;
}

// ---- GF(4), GF(16): the tower's lower floors ----------------------------------------------------------------------------


/** GF(4) product with three ANDs (Karatsuba): hi = (a1 + a0)(b1 + b0) + a0·b0, lo = a1·b1 + a0·b0. */
export function gf4Mul(): ComponentDef {
  return memo('aes_gf4mul', () => {
    const b = new Builder(8, 10, 2);
    b.pins('a', 'b');
    const sa = b.op(splitter(ones(2)), ['a']), sb = b.op(splitter(ones(2)), ['b']);
    b.next();
    const m11 = b.op1(AND, [`${sa}.o1`, `${sb}.o1`]), m00 = b.op1(AND, [`${sa}.o0`, `${sb}.o0`]);
    const xa = b.op1(XOR, [`${sa}.o1`, `${sa}.o0`]), xb = b.op1(XOR, [`${sb}.o1`, `${sb}.o0`]);
    b.next();
    const p = b.op1(AND, [xa, xb]);
    b.next();
    const hi = b.op1(XOR, [p, m00]), lo = b.op1(XOR, [m11, m00]);
    b.next();
    b.wire(b.op1(merger(ones(2)), [lo, hi]), 'y');
    return define({
      id: 'aes_gf4mul', name: 'GF(4) multiplier', category: 'arithmetic',
      summary: 'Multiplies two elements of GF(4) = GF(2)[y]/(y² + y + 1), each hi·y + lo. Karatsuba: three ANDs and four XORs instead of four ANDs and three XORs, the trade that pays at every floor of the tower.',
      ports: [bus('a', 2, 'in'), bus('b', 2, 'in'), bus('y', 2, 'out')], symbol: { kind: 'box', label: 'GF4×' },
      spec: ([x, y]) => [mul4(x, y)],
      netlist: () => ({ pins: { a: [0, 6], b: [0, 18], y: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

const L4 = (id: string, name: string, f: (x: number) => number, summary: string) => linearPart(id, name, summary, matrixOf(f, 2, 2), 2, 0, id.slice(4).toUpperCase());
/** x ↦ N·x in GF(4): a wire swap and at most one XOR. */
export const gf4ScaleN = (): ComponentDef => L4('aes_gf4n', 'GF(4) × N', (x) => mul4(N4, x), `Multiplication by the constant N = ${N4} in GF(4): linear over GF(2), so a handful of XORs.`);
/** x ↦ x² = x⁻¹ in GF(4) (x³ = 1; 0 stays 0). */
export const gf4Inv = (): ComponentDef => L4('aes_gf4inv', 'GF(4) inverse', inv4, 'In GF(4) the inverse is the square (x³ = 1), and squaring is linear: hi stays, lo becomes lo + hi. One XOR.');

/** GF(16) product from three GF(4) products (Karatsuba again), z² = z + N. */
export function gf16Mul(): ComponentDef {
  return memo('aes_gf16mul', () => {
    const X2 = bitwise('xor', 2), b = new Builder(8, 10, 2);
    b.pins('a', 'b');
    const sa = b.op(splitter([2, 2]), ['a']), sb = b.op(splitter([2, 2]), ['b']);
    b.next();
    const xa = b.op1(X2, [`${sa}.o1`, `${sa}.o0`]), xb = b.op1(X2, [`${sb}.o1`, `${sb}.o0`]);
    const m11 = b.op1(gf4Mul(), [`${sa}.o1`, `${sb}.o1`]), m00 = b.op1(gf4Mul(), [`${sa}.o0`, `${sb}.o0`]);
    b.next();
    const p = b.op1(gf4Mul(), [xa, xb]);
    const nm = b.op1(gf4ScaleN(), [m11]);
    b.next();
    const hi = b.op1(X2, [p, m00]), lo = b.op1(X2, [nm, m00]);
    b.next();
    b.wire(b.op1(merger([2, 2]), [lo, hi]), 'y');
    return define({
      id: 'aes_gf16mul', name: 'GF(16) multiplier', category: 'arithmetic',
      summary: `Multiplies two elements of GF(16) = GF(4)[z]/(z² + z + ${N4}), each hi·z + lo with hi, lo in GF(4): three GF(4) products by Karatsuba, one scaling by N, four 2-bit XORs.`,
      ports: [bus('a', 4, 'in'), bus('b', 4, 'in'), bus('y', 4, 'out')], symbol: { kind: 'box', label: 'GF16×' },
      spec: ([x, y]) => [mul16(x, y)],
      netlist: () => ({ pins: { a: [0, 6], b: [0, 18], y: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The first term of GF(16)'s norm: a0² + N·a1², linear in the four bits. */
function gf16NormLin(): ComponentDef {
  return linearPart('aes_gf16norm', 'GF(16) norm, linear part', 'a0² + N·a1² for a = a1·z + a0: squaring and scaling are linear in GF(2^k), so these four input bits reach two outputs through XORs only.',
    matrixOf((a) => mul4(a & 3, a & 3) ^ mul4(N4, mul4(a >> 2, a >> 2)), 4, 2), 4, 0, 'NORM');
}

/** GF(16) inverse: the norm d in GF(4), its inverse e (a square), then (a1·e)·z + (a0 + a1)·e. */
export function gf16Inv(): ComponentDef {
  return memo('aes_gf16inv', () => {
    const X2 = bitwise('xor', 2), b = new Builder(8, 10, 2);
    b.pins('a');
    const sa = b.op(splitter([2, 2]), ['a']);
    b.next();
    const lin2 = b.op1(gf16NormLin(), ['a']), prod = b.op1(gf4Mul(), [`${sa}.o0`, `${sa}.o1`]), s = b.op1(X2, [`${sa}.o0`, `${sa}.o1`]);
    b.next();
    const d = b.op1(X2, [lin2, prod]);
    b.next();
    const e = b.op1(gf4Inv(), [d]);
    b.next();
    const hi = b.op1(gf4Mul(), [`${sa}.o1`, e]), lo = b.op1(gf4Mul(), [s, e]);
    b.next();
    b.wire(b.op1(merger([2, 2]), [lo, hi]), 'y');
    return define({
      id: 'aes_gf16inv', name: 'GF(16) inverse', category: 'arithmetic',
      summary: 'a⁻¹ in GF(16) by the norm: d = a0² + a0·a1 + N·a1² lives in GF(4), where its inverse is a square; then (a1·d⁻¹)·z + (a0 + a1)·d⁻¹. Three GF(4) products. 0 maps to 0.',
      ports: [bus('a', 4, 'in'), bus('y', 4, 'out')], symbol: { kind: 'box', label: 'GF16⁻¹' },
      spec: ([a]) => [inv16(a)],
      netlist: () => ({ pins: { a: [0, 6], y: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The same step one floor up: GF(256) inverse from three GF(16) products and one GF(16) inverse. */
export function gf256Inv(): ComponentDef {
  return memo('aes_gf256inv', () => {
    const X4 = bitwise('xor', 4), b = new Builder(8, 10, 2);
    b.pins('a');
    const sa = b.op(splitter([4, 4]), ['a']);
    b.next();
    const norm = linearPart('aes_gf256norm', 'GF(256) norm, linear part', 'a0² + λ·a1² for a = a1·w + a0 with a0, a1 in GF(16): linear over GF(2), 8 bits in, 4 out.',
      matrixOf((a) => mul16(a & 15, a & 15) ^ mul16(LAMBDA, mul16(a >> 4, a >> 4)), 8, 4), 8, 0, 'NORM');
    const lin4 = b.op1(norm, ['a']), prod = b.op1(gf16Mul(), [`${sa}.o0`, `${sa}.o1`]), s = b.op1(X4, [`${sa}.o0`, `${sa}.o1`]);
    b.next();
    const d = b.op1(X4, [lin4, prod]);
    b.next();
    const e = b.op1(gf16Inv(), [d]);
    b.next();
    const hi = b.op1(gf16Mul(), [`${sa}.o1`, e]), lo = b.op1(gf16Mul(), [s, e]);
    b.next();
    b.wire(b.op1(merger([4, 4]), [lo, hi]), 'y');
    return define({
      id: 'aes_gf256inv', name: 'GF(256) inverse (tower)', category: 'arithmetic',
      summary: `Inverse in GF(256) = GF(16)[w]/(w² + w + ${LAMBDA}) by the norm, as one floor down: d = a0² + a0·a1 + λ·a1² in GF(16), its inverse, then two products. Three GF(16) multipliers and one GF(16) inverse. 0 maps to 0.`,
      ports: [bus('a', 8, 'in'), bus('y', 8, 'out')], symbol: { kind: 'box', label: 'GF256⁻¹' },
      spec: ([a]) => [inv256(a)],
      netlist: () => ({ pins: { a: [0, 6], y: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

const SBOX_IN_AT = { u1: 14, u2: 26, u3: 8, u4: 2, u5: 38, u6: 20, u7: 32, u8: 20, u9: 2, u10: 8, u11: 14 };
const SBOX_OUT_AT = { u2: 14, u3: 26, u5: 8, u6: 14, u7: 2, u8: 8, u10: 14, u11: 2, u12: 20, u13: 8, u15: 6, u16: 14, u18: 2 };

/** The S-box: basis change into the tower, inverse, basis change back with the affine map folded in, then XOR 0x63. */
export function aesSbox(): ComponentDef {
  return memo('aes_sbox', () => {
    const inM = linearPart('aes_sbox_in', 'S-box: into the tower', 'The change of basis from AES\'s polynomial basis to the tower\'s: an 8×8 matrix over GF(2), an XOR network.', SBOX_IN, 8, 0, 'x→T', SBOX_IN_AT);
    const outM = linearPart('aes_sbox_out', 'S-box: out of the tower, affine', 'The change of basis back, multiplied by the S-box\'s affine matrix, then XOR 0x63 (inverters on the bits it sets): one 8×8 matrix and a constant.', SBOX_OUT, 8, 0x63, 'T→S', SBOX_OUT_AT);
    const b = new Builder(8, 10, 2);
    b.pins('x');
    const t = b.op1(inM, ['x']);
    b.next();
    const i = b.op1(gf256Inv(), [t]);
    b.next();
    b.wire(b.op1(outM, [i]), 'y');
    return define({
      id: 'aes_sbox', name: 'AES S-box', category: 'arithmetic',
      summary: 'SubBytes\' byte function: the inverse in GF(2^8) followed by an affine map. Built as gates, not a table: change basis into a tower of fields, invert there with a few small products, change back. No ROM, no 254 multiplications.',
      ports: [bus('x', 8, 'in'), bus('y', 8, 'out')], symbol: { kind: 'box', label: 'S-BOX' },
      spec: ([x]) => [SBOX[x]],
      netlist: () => ({ pins: { x: [0, 6], y: [b.right, 10] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- MixColumns, ShiftRows, AddRoundKey ---------------------------------------------------------------------------------

/** y = 2·a in GF(2^8): shift left, and when the top bit fell off, XOR 0x1B. */
export const xtimeGate = (): ComponentDef => linearPart('aes_xtime', 'xtime (× 2 in GF(2^8))', 'Multiplies a byte by x modulo x⁸ + x⁴ + x³ + x + 1: a shift, and the bit that falls off the top is XORed into bits 0, 1, 3 and 4. Three XORs.',
  matrixOf(xtime, 8, 8), 8, 0, '×2');

/** One column of MixColumns: out_i = a_i + t + xtime(a_i + a_(i+1)) with t = a0 + a1 + a2 + a3, which is 2·a_i + 3·a_(i+1) + a_(i+2) + a_(i+3). */
export function mixColumn(): ComponentDef {
  return memo('aes_mixcol', () => {
    const X8 = bitwise('xor', 8), b = new Builder(8, 10, 2);
    b.pins('a');
    const sp = b.op(splitter([8, 8, 8, 8]), ['a']);
    const a = (i: number) => `${sp}.o${i}`;
    b.next();
    const p = [0, 1, 2, 3].map((i) => b.op1(X8, [a(i), a((i + 1) % 4)]));
    b.next();
    const t = b.op1(X8, [p[0], p[2]]);
    const xt = p.map((x) => b.op1(xtimeGate(), [x]));
    b.next();
    const at = [0, 1, 2, 3].map((i) => b.op1(X8, [a(i), t]));
    b.next();
    const o = [0, 1, 2, 3].map((i) => b.op1(X8, [at[i], xt[i]]));
    b.next();
    b.wire(b.op1(merger([8, 8, 8, 8]), o), 'y');
    return define({
      id: 'aes_mixcol', name: 'MixColumns (one column)', category: 'arithmetic',
      summary: 'Multiplies a column by the circulant matrix [2 3 1 1] in GF(2^8). Written as out_i = a_i + t + xtime(a_i + a_(i+1)), t the XOR of the four bytes: 13 byte-wide XORs and 4 xtimes, no multiplier.',
      ports: [bus('a', 32, 'in'), bus('y', 32, 'out')], symbol: { kind: 'box', label: 'MIX COL' },
      spec: ([x]) => {
        const s = [x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255];
        const m = mixColumns([...s, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        return [(m[0] | (m[1] << 8) | (m[2] << 16) | (m[3] << 24)) >>> 0];
      },
      netlist: () => ({ pins: { a: [0, 12], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** ShiftRows: row r rotates left by r bytes. Pure wiring. */
export function shiftRowsWire(): ComponentDef {
  return memo('aes_shiftrows', () => define({
    id: 'aes_shiftrows', name: 'ShiftRows', category: 'plumbing',
    summary: 'Row r of the state rotates left by r bytes: byte (r, c) takes byte (r, c + r). Wiring only, zero gates, zero delay.',
    ports: [bus('in', 128, 'in'), bus('out', 128, 'out')], symbol: { kind: 'box', label: 'SHIFT ROWS', w: 8, h: 4 }, prim: 'alias',
    alias: Array.from({ length: 128 }, (_, n): [string, number, string, number] => {
      const i = n >> 3, src = 4 * (((i >> 2) + (i & 3)) & 3) + (i & 3);
      return ['in', 8 * src + (n & 7), 'out', n];
    }),
  }));
}

/** n bytes XOR n bytes (n = 16: AddRoundKey). */
export function xorBytes(n: number): ComponentDef {
  return memo(`aes_xorb${n}`, () => {
    const X8 = bitwise('xor', 8), b = new Builder(8, 10, 2);
    b.maxH = 300;
    b.pins('a', 'b');
    const sa = b.op(splitter(new Array<number>(n).fill(8)), ['a']), sb = b.op(splitter(new Array<number>(n).fill(8)), ['b']);
    b.next();
    const o = Array.from({ length: n }, (_, i) => b.op1(X8, [`${sa}.o${i}`, `${sb}.o${i}`]));
    b.next();
    b.wire(b.op1(merger(new Array<number>(n).fill(8)), o), 'y');
    return define({
      id: `aes_xorb${n}`, name: n === 16 ? 'AddRoundKey' : `${n}-byte XOR`, category: 'gate',
      summary: n === 16 ? 'The state XORed with the round key, byte by byte: 128 XOR gates.' : `${n} bytes XORed with ${n} bytes: ${8 * n} XOR gates.`,
      ports: [bus('a', 8 * n, 'in'), bus('b', 8 * n, 'in'), bus('y', 8 * n, 'out')], symbol: { kind: 'box', label: n === 16 ? 'ADD KEY' : `XOR${8 * n}` },
      ...(8 * n <= 48 ? { spec: ([x, y]: number[]) => [Number(BigInt(x) ^ BigInt(y))] } : {}),
      netlist: () => ({ pins: { a: [0, 12], b: [0, 24], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** n bytes, two buses, one select: y = s ? b : a. */
export function byteMux(n: number): ComponentDef {
  return memo(`aes_muxb${n}`, () => {
    const M = busMux2(8), b = new Builder(8, 10, 10);
    b.maxH = 300;
    b.pins('a', 'b', 's');
    const w = new Array<number>(n).fill(8);
    const sa = b.op(splitter(w), ['a']), sb = b.op(splitter(w), ['b']);
    b.next();
    const o = Array.from({ length: n }, (_, i) => { const m = b.op(M, [`${sa}.o${i}`, `${sb}.o${i}`, 's']); return `${m}.y`; });
    b.next();
    b.wire(b.op1(merger(w), o), 'y');
    return define({
      id: `aes_muxb${n}`, name: `${8 * n}-bit 2:1 multiplexer`, category: 'routing',
      summary: `Chooses between two ${8 * n}-bit buses, byte lane by byte lane, with one shared select.`,
      ports: [bus('a', 8 * n, 'in'), bus('b', 8 * n, 'in'), bit('s', 'in', 'bottom'), bus('y', 8 * n, 'out')], symbol: { kind: 'mux' },
      netlist: () => ({ pins: { a: [0, 12], b: [0, 24], s: [0, 36], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** SubBytes: sixteen S-boxes side by side. */
export function subBytes(): ComponentDef {
  return memo('aes_subbytes', () => {
    const S = aesSbox(), b = new Builder(8, 10, 2);
    b.maxH = 200;
    b.pins('a');
    const w = new Array<number>(16).fill(8);
    const sp = b.op(splitter(w), ['a']);
    b.next();
    const o = Array.from({ length: 16 }, (_, i) => b.op1(S, [`${sp}.o${i}`]));
    b.next();
    b.wire(b.op1(merger(w), o), 'y');
    return define({
      id: 'aes_subbytes', name: 'SubBytes', category: 'arithmetic',
      summary: 'The S-box applied to each of the 16 state bytes, in parallel. The round\'s only nonlinear step, and most of its gates.',
      ports: [bus('a', 128, 'in'), bus('y', 128, 'out')], symbol: { kind: 'box', label: 'SUB BYTES' },
      netlist: () => ({ pins: { a: [0, 12], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** One round: SubBytes, ShiftRows, MixColumns (bypassed when `last`), AddRoundKey with the round key already derived. */
export function aesRound(): ComponentDef {
  return memo('aes_round', () => {
    const b = new Builder(8, 14, 6);
    b.pins('s', 'k', 'last');
    const sub = b.op1(subBytes(), ['s'], 'SubBytes');
    b.next();
    const sh = b.op1(shiftRowsWire(), [sub], 'ShiftRows');
    b.next();
    const cols = b.op(splitter([32, 32, 32, 32]), [sh]);
    b.next();
    const mix = [0, 1, 2, 3].map((c) => b.op1(mixColumn(), [`${cols}.o${c}`], `MixColumns ${c}`));
    b.next();
    const mixed = b.op1(merger([32, 32, 32, 32]), mix);
    b.next();
    const pick = b.op1(byteMux(16), [mixed, sh, 'last'], 'last round: no MixColumns');
    b.next();
    b.wire(b.op1(xorBytes(16), [pick, 'k'], 'AddRoundKey'), 'y');
    return define({
      id: 'aes_round', name: 'AES round', category: 'arithmetic',
      summary: 'SubBytes, ShiftRows, MixColumns, AddRoundKey on a 128-bit state. The last round (last = 1) skips MixColumns. The round key comes in already derived: the key schedule has its own step.',
      ports: [bus('s', 128, 'in'), bus('k', 128, 'in'), bit('last', 'in', 'bottom'), bus('y', 128, 'out')], symbol: { kind: 'box', label: 'AES ROUND' },
      netlist: () => ({ pins: { s: [0, 12], k: [0, 24], last: [0, 36], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The key schedule's step for AES-128: w0' = w0 + SubWord(RotWord(w3)) + rcon, w1' = w1 + w0', w2' = w2 + w1', w3' = w3 + w2'. */
export function keyStep(): ComponentDef {
  return memo('aes_keystep', () => {
    const S = aesSbox(), X4 = xorBytes(4), X8 = bitwise('xor', 8), b = new Builder(8, 14, 4);
    b.pins('k', 'rcon');
    const w = b.op(splitter([32, 32, 32, 32]), ['k']), by = b.op(splitter(new Array<number>(16).fill(8)), ['k']);
    b.next();
    // RotWord(w3) = bytes 13, 14, 15, 12
    const sb = [13, 14, 15, 12].map((i) => b.op1(S, [`${by}.o${i}`], 'S-box'));
    b.next();
    const t0 = b.op1(X8, [sb[0], 'rcon'], '+ rcon');
    b.next();
    const t = b.op1(merger([8, 8, 8, 8]), [t0, sb[1], sb[2], sb[3]]);
    b.next();
    const n0 = b.op1(X4, [`${w}.o0`, t]);
    b.next();
    const n1 = b.op1(X4, [`${w}.o1`, n0]);
    b.next();
    const n2 = b.op1(X4, [`${w}.o2`, n1]);
    b.next();
    const n3 = b.op1(X4, [`${w}.o3`, n2]);
    b.next();
    b.wire(b.op1(merger([32, 32, 32, 32]), [n0, n1, n2, n3]), 'y');
    return define({
      id: 'aes_keystep', name: 'AES-128 key schedule step', category: 'arithmetic',
      summary: 'The next round key from this one and the round constant: the last word rotated a byte and pushed through four S-boxes, XORed with the constant and into the first word, then a chain of XORs down the other three. One step per round.',
      ports: [bus('k', 128, 'in'), bus('rcon', 8, 'in'), bus('y', 128, 'out')], symbol: { kind: 'box', label: 'KEY STEP' },
      netlist: () => ({ pins: { k: [0, 12], rcon: [0, 24], y: [b.right, 12] }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/**
 * The iterative encryptor. start = 1 at a rising edge loads the block XOR the key (the initial AddRoundKey); each of the
 * next ten edges is one round (11 clocks in all). done goes high with the ciphertext on `out` and stays until the next start.
 * The key is read at start only: the core keeps the round key in a register of its own and steps it with the key schedule.
 * rst clears busy and done (the data registers need no reset: start loads them).
 */
export function aesCore(): ComponentDef {
  return memo('aes_core', () => {
    const b = new Builder(26, 16, 6);
    b.pins('clk', 'rst', 'start', 'key', 'in');
    const ark0 = b.op1(xorBytes(16), ['in', 'key'], 'initial AddRoundKey', 'ark0');
    b.next();
    // control: busy while rounds run, last in round 10 (the counter holds the rounds done so far: 9 = 1001, the only value with bits 3 and 0 set that it reaches)
    const cs = b.op(splitter(ones(4)), ['CNT.q'], '', 'cs');
    const last = b.op1(AND, [`${cs}.o3`, `${cs}.o0`], 'round 10', 'last');
    const run = b.op1(OR, ['start', 'busy.q'], 'start | busy', 'run');
    const nlast = b.op1(NOT, [last]), keep = b.op1(AND, ['busy.q', nlast]), finish = b.op1(AND, ['busy.q', last]);
    const nrst = b.op1(NOT, ['rst']), nstart = b.op1(NOT, ['start']);
    const busyD = b.op1(AND, [b.op1(OR, ['start', keep]), nrst], 'busy next');
    const doneD = b.op1(AND, [b.op1(AND, [b.op1(OR, ['done.q', finish]), nstart]), nrst], 'done next');
    b.next();
    b.add(register(128), 'state', 'S');
    b.add(register(128), 'round key', 'K');
    b.add(register(8), 'round constant', 'RC');
    b.add(clearableRegister(4), 'rounds done', 'CNT');
    b.add(DFF, 'busy', 'busy');
    b.add(DFF, 'done', 'done');
    b.next();
    const ks = b.op(keyStep(), ['K.q', 'RC.q'], 'key schedule', 'ks');
    const rd = b.op(aesRound(), ['S.q', `${ks}.y`, last], 'round', 'rd');
    const xt = b.op(xtimeGate(), ['RC.q'], 'rcon × 2', 'xt');
    const inc = b.op(incrementer(4), ['CNT.q'], '+ 1', 'inc');
    const one = b.op(constWord(8, 1), [], '', 'one');
    b.next();
    const sm = b.op(byteMux(16), [`${rd}.y`, ark0, 'start'], 'start: load', 'sm');
    const km = b.op(byteMux(16), [`${ks}.y`, 'key', 'start'], 'start: load', 'km');
    const rm = b.op(busMux2(8), [`${xt}.y`, `${one}.y`, 'start'], 'start: rcon = 1', 'rm');
    for (const [r, d] of [['S', sm], ['K', km], ['RC', rm]] as const) b.wire(`${d}.y`, `${r}.d`);
    for (const r of ['S', 'K', 'RC']) { b.wire(run, `${r}.en`); b.wire('clk', `${r}.clk`); }
    b.wire(`${inc}.y`, 'CNT.d'); b.wire('busy.q', 'CNT.en'); b.wire('start', 'CNT.clr'); b.wire('clk', 'CNT.clk');
    b.wire(busyD, 'busy.d'); b.wire('clk', 'busy.clk'); b.wire(doneD, 'done.d'); b.wire('clk', 'done.clk');
    b.wire('S.q', 'out'); b.wire('done.q', 'done');
    b.name('S.q', 'state_q'); b.name('done.q', 'done_q'); b.name('busy.q', 'busy_q');
    return define({
      id: 'aes_core', name: 'AES-128 encryption core', category: 'sequential',
      summary: 'One AES round a clock: a 128-bit state register, a round-key register stepped by the key schedule, a round-constant register that doubles each round, a 4-bit round counter. 11 clocks from start to done: one to load block ⊕ key, ten rounds.',
      ports: [clk(), bit('rst', 'in'), bit('start', 'in'), bus('key', 128, 'in'), bus('in', 128, 'in'), bus('out', 128, 'out'), bit('done', 'out')],
      symbol: { kind: 'box', label: 'AES-128' },
      netlist: () => ({ pins: { clk: [0, 6], rst: [0, 18], start: [0, 30], key: [0, 42], in: [0, 54], out: [b.right, 12], done: [b.right, 30] }, instances: b.instances, nets: b.nets() }),
    });
  });
}
