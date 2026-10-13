// Chapter 30: a triangle rasterizer at gate level, behind it a double-buffered framebuffer and the scan-out
// that sends it to the screen. The reference model is gfx/raster.ts (same arithmetic, same cycle order).
//
//   EDGE_STEP   one edge function E, stepped with an adder: +dx (a pixel right), ±dy (a pixel down / up),
//               +4dx (skip a tile), the next band (E, R ← R + 4dy from the band's start R); its tile test
//               E + off < 0 (the tile's best corner) on a second adder.
//   RAST_SETUP  per edge A, B, the top-left bias, dx = 4A, dy = 4B, the tile offset; the bounding box in
//               tiles; one signed multiplier and an accumulator compute the area and each edge's value at
//               the first tile, one product per cycle.
//   RAST_WALK   the control: idle → eight set-up cycles → TEST / 16 pixels per tile, bands of 4 × 4 tiles.
//   RASTERIZER  the three, with the vertex and colour latches: a triangle in, pixel writes out.
//   PIXEL_BUF   one 64 × 64 byte frame: four byte banks (pixel x mod 4), a word = four neighbours.
//   FRAMEBUF    two of them: the front one is read by the scan-out, the back one written by the rasterizer.
//   SCAN_OUT    a word address counting through the frame, vsync on the last word, the front-buffer flip
//               (at vsync when sync = 1, at once otherwise: tearing).

import type { ComponentDef, PortDef } from '../sim/types';
import { CMD, EDGE_BITS, FB_W, Z_FRAC } from '../gfx/raster';
import { constWord, isZero } from './alu';
import { bigRam, bigRamWithInit } from './bigmem';
import { Builder } from './builder';
import { addSub, andN, busMux2, decoder, equal, incrementer, muxTree, rca } from './combinational';
import { absValue, magComparator } from './coding';
import { define, merger, ones, splitter } from './define';
import { fanout } from './fastadd';
import { orN } from './wide';
import { AND, NOT, OR, XOR } from './gates';
import { boothMul } from './multiply';
import { arrayMul, condNegate } from './muldiv';
import { nrSeqDivider } from './divide';
import { DFF, DFFE, register } from './sequential';
import { TIE0 } from './transistors';

const N = EDGE_BITS;
/** Vertex coordinates: quarter pixels, 0 … 255. */
const CB = 8;
/** Differences of coordinates and multiplier operands: 10-bit signed. */
const DB = 10;
const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));
const E3 = [0, 1, 2];
export const VERTEX_PINS = ['v0x', 'v0y', 'v1x', 'v1y', 'v2x', 'v2y'];

/** The top bit of a w-bit driver. */
function topBit(b: Builder, drv: string, w: number, label?: string): string {
  return `${b.op(splitter([w - 1, 1]), [drv], label)}.o1`;
}

// ---- edge stepper --------------------------------------------------------------------------------------

/**
 * One edge function, stepped by the walk. cmd: 0 hold, 1 load (E, R ← e0), 2 right (E += dx), 3 skip (E += 4dx),
 * 4 down (E += dy), 5 up (E −= dy), 6 band (E, R ← R + 4dy). neg: E < 0 (the pixel is outside this edge);
 * tneg: E + off < 0 (no pixel of the tile whose top-left pixel E is at can be inside).
 */
const stepCache = new Map<string, ComponentDef>();

/** An n-bit stepper; tile = false drops the tile test (off, tneg): the depth stepper. */
export function edgeStep(n: number, tile = true): ComponentDef {
  const key = `${n}${tile ? '' : 'z'}`;
  const hit = stepCache.get(key);
  if (hit) return hit;
  const N = n;
  const b = new Builder(12, 12, 4);
  b.pins('dx', 'dy', ...(tile ? ['off'] : []), 'e0', 'cmd', 'clk');
  const cs = b.op(splitter(ones(3)), ['cmd'], 'cmd');
  const [c0, c1, c2] = [0, 1, 2].map((i) => `${cs}.o${i}`);
  const z2 = b.op1(constWord(2, 0), []);
  const dxs = b.op(splitter([N - 2, 2]), ['dx']);
  const dys = b.op(splitter([N - 2, 2]), ['dy']);
  b.next();
  const n0 = b.op1(NOT, [c0]), n1 = b.op1(NOT, [c1]), n2 = b.op1(NOT, [c2]);
  const dx4 = b.op1(merger([2, N - 2]), [z2, `${dxs}.o0`], '4·dx');
  const dy4 = b.op1(merger([2, N - 2]), [z2, `${dys}.o0`], '4·dy');
  b.next();
  const load = b.name(b.op1(AND, [b.op1(AND, [n2, n1]), c0], 'load'), 'load', true);
  const band = b.name(b.op1(AND, [b.op1(AND, [c2, c1]), n0], 'band'), 'band', true);
  const up = b.name(b.op1(AND, [b.op1(AND, [c2, n1]), c0], 'up: subtract'), 'up', true);
  const four = b.op1(AND, [c1, b.op1(XOR, [c0, c2])], 'skip or band: ×4');
  const enE = b.op1(OR, [b.op1(OR, [c0, c1]), c2], 'cmd ≠ hold');
  const enR = b.op1(OR, [load, band], 'load or band');
  b.next();
  const sel = b.op1(merger([1, 1]), [c2, four], 'step select');
  const y = b.op1(muxTree(2, N), ['dx', 'dy', dx4, dy4, sel], 'dx, dy, 4dx, 4dy');
  b.next();
  // E and R are wired below (feedback): the operand is R for band, E otherwise
  const x = b.op1(busMux2(N), ['', '', band], 'E or band start');
  b.next();
  const sum = b.op(addSub(N), [x, y, up], 'E ± step');
  b.next();
  const d = b.name(b.op1(busMux2(N), [`${sum}.s`, 'e0', load], 'load e0'), 'next', true);
  b.next();
  const eR = b.op(register(N), [d, enE, 'clk'], 'E', 'E');
  const rR = b.op(register(N), [d, enR, 'clk'], 'band start R', 'R');
  b.name(`${eR}.q`, 'E', true);
  b.name(`${rR}.q`, 'R', true);
  b.wire(`${eR}.q`, `${x.split('.')[0]}.a`);
  b.wire(`${rR}.q`, `${x.split('.')[0]}.b`);
  b.next();
  const t = tile ? b.op(rca(N), [`${eR}.q`, 'off', b.op1(TIE0, [])], 'E + off: best corner') : '';
  const neg = topBit(b, `${eR}.q`, N, 'sign of E');
  b.next();
  b.wire(`${eR}.q`, 'e');
  b.wire(neg, 'neg');
  if (tile) b.wire(topBit(b, `${t}.s`, N, 'sign of E + off'), 'tneg');
  const R = b.right;
  const def = define({
    id: tile ? (n === EDGE_BITS ? 'edge_step' : `edge_step${n}`) : `z_step${n}`, name: tile ? 'Edge stepper' : 'Depth stepper', category: 'arithmetic',
    summary: tile
      ? `One edge function E = A·x + B·y + C (${N}-bit), never multiplied: moving one pixel adds dx = 4A (right) or dy = 4B (down; up subtracts it), `
        + 'skipping a 4-pixel tile adds 4dx (a wired shift), and the next band of tiles starts from R, the band\'s first tile, plus 4dy. '
        + 'neg: E < 0, the pixel is outside this edge. tneg: E + off < 0, so the whole tile is outside (off moves E to the tile\'s best corner).'
      : `The edge stepper without the tile test, ${N} bits wide: z is a plane too, stepped by its slopes along the same walk.`,
    ports: [bus('dx', N, 'in'), bus('dy', N, 'in'), ...(tile ? [bus('off', N, 'in')] : []), bus('e0', N, 'in'), bus('cmd', 3, 'in'), bit('clk', 'in', 'bottom', true),
      bus('e', N, 'out'), bit('neg', 'out'), ...(tile ? [bit('tneg', 'out')] : [])],
    symbol: { kind: 'box', label: tile ? 'EDGE STEPPER' : 'DEPTH STEPPER' },
    netlist: () => ({ pins: { ...pinsAt(['dx', 'dy', ...(tile ? ['off'] : []), 'e0', 'cmd', 'clk'], 0, 6), ...pinsAt(['e', 'neg', ...(tile ? ['tneg'] : [])], R, 6) }, instances: b.instances, nets: b.nets() }),
    hdl: {
      verilog: `wire [${N - 1}:0] step = cmd == 3'd3 ? dx << 2 : cmd == 3'd6 ? dy << 2 : cmd[2] ? dy : dx;
wire [${N - 1}:0] next = cmd == 3'd1 ? e0 : (cmd == 3'd6 ? r : e) + (cmd == 3'd5 ? -step : step);
always_ff @(posedge clk) begin
  if (cmd != 3'd0) e <= next;
  if (cmd == 3'd1 || cmd == 3'd6) r <= next;
end
assign neg = e[${N - 1}];${tile ? `
assign tneg = (e + off) >> ${N - 1};` : ''}`,
    },
  });
  stepCache.set(key, def);
  return def;
}

export const EDGE_STEP = edgeStep(EDGE_BITS);

// ---- small parts ---------------------------------------------------------------------------------------

/** a AND NOT s on 8 bits (the positive part of a value whose sign is s). */
const POS8: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a', 's');
  const ns = b.op1(NOT, ['s']);
  const f = b.op1(fanout(CB), [ns]);
  b.next();
  const sp = b.op(splitter(ones(CB)), ['a']), sf = b.op(splitter(ones(CB)), [f]);
  b.next();
  const bits = Array.from({ length: CB }, (_, i) => b.op1(AND, [`${sp}.o${i}`, `${sf}.o${i}`]));
  b.next();
  b.wire(b.op1(merger(ones(CB)), bits), 'y');
  const R = b.right;
  return define({
    id: 'pos8', name: 'Positive part (8-bit)', category: 'arithmetic',
    summary: 'y = a when the sign s is 0, else 0: eight ANDs with NOT s.',
    ports: [bus('a', CB, 'in'), bit('s', 'in'), bus('y', CB, 'out')],
    symbol: { kind: 'box', label: 'a⁺' },
    spec: ([a, s]) => [s ? 0 : a],
    netlist: () => ({ pins: { a: [0, 4], s: [0, 8], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

const AND4W: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a', 'b');
  const sa = b.op(splitter(ones(4)), ['a']), sb = b.op(splitter(ones(4)), ['b']);
  b.next();
  const bits = [0, 1, 2, 3].map((i) => b.op1(AND, [`${sa}.o${i}`, `${sb}.o${i}`]));
  b.next();
  b.wire(b.op1(merger(ones(4)), bits), 'y');
  const R = b.right;
  return define({
    id: 'and4w', name: '4-bit AND', category: 'gate',
    summary: 'Four ANDs, bit by bit.',
    ports: [bus('a', 4, 'in'), bus('b', 4, 'in'), bus('y', 4, 'out')],
    symbol: { kind: 'box', label: 'AND' },
    spec: ([a, c]) => [a & c],
    netlist: () => ({ pins: { a: [0, 4], b: [0, 8], y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- set-up -------------------------------------------------------------------------------------------

/** Zero-extend an 8-bit coordinate to a 10-bit signed operand. */
function z10(b: Builder, drv: string, z: string): string {
  return b.op1(merger([CB, DB - CB]), [drv, z]);
}

/** min and max of two unsigned bytes (one comparator; only the multiplexers asked for). */
function minMax(b: Builder, a: string, c: string, label: string, want: 'min' | 'max' | 'both' = 'both'): [string, string] {
  const lt = `${b.op(magComparator(CB), [a, c], label)}.lt`;
  const mn = want !== 'max' ? b.op1(busMux2(CB), [c, a, lt], `min ${label}`) : '';
  const mx = want !== 'min' ? b.op1(busMux2(CB), [a, c, lt], `max ${label}`) : '';
  return [mn, mx];
}

/**
 * Set-up of one triangle. Combinational: A_i = v_i.y − v_{i+1}.y, B_i = v_{i+1}.x − v_i.x, the top-left bias, the
 * steps dx = 4A, dy = 4B and the tile offset 12·(A⁺ + B⁺) per edge; the bounding box in tiles. Sequential, phase
 * s = 1 … 8 (from the walk): one product a cycle on a 10 × 10 Booth multiplier, s odd: acc ← A·Δx (− bias),
 * s even: sum = acc + B·Δy. S1–S2: twice the area (edge 0 at vertex 2), kept for the cull; S3–S8: each edge at
 * the first tile's top-left pixel, out on e0 in S4, S6, S8.
 */
export const RAST_SETUP: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins(...VERTEX_PINS, 's', 'clk');
  const z2 = b.op1(constWord(DB - CB, 0), []);
  const ss = b.op(splitter([3, 1]), ['s'], 'phase');
  const s3 = `${ss}.o0`;
  const sb = b.op(splitter(ones(3)), [s3], 'phase bits');
  const V = VERTEX_PINS.map((p) => z10(b, p, z2));   // v0x v0y v1x v1y v2x v2y, 10-bit
  b.next();
  // A_i = v_i.y − v_{i+1}.y, B_i = v_{i+1}.x − v_i.x
  const one = b.op1(constWord(1, 1), []);
  const A = E3.map((i) => b.name(`${b.op(addSub(DB), [V[2 * i + 1], V[2 * ((i + 1) % 3) + 1], one], `A${i}`)}.s`, `A${i}`, true));
  const B = E3.map((i) => b.name(`${b.op(addSub(DB), [V[2 * ((i + 1) % 3)], V[2 * i], one], `B${i}`)}.s`, `B${i}`, true));
  b.next();
  // top-left: A > 0 (a left edge) or A = 0 and B > 0 (a top edge); bias = 1 otherwise
  const sgn = (w: string, l: string) => topBit(b, w, DB, l);
  const sA = E3.map((i) => sgn(A[i], `sign A${i}`)), sB = E3.map((i) => sgn(B[i], `sign B${i}`));
  const zA = E3.map((i) => b.op1(isZero(DB), [A[i]], `A${i} = 0`)), zB = E3.map((i) => b.op1(isZero(DB), [B[i]], `B${i} = 0`));
  b.next();
  const pos = (s: string, z: string, l: string) => b.op1(AND, [b.op1(NOT, [s]), b.op1(NOT, [z])], l);
  const bias = E3.map((i) => {
    const left = pos(sA[i], zA[i], `A${i} > 0`), top = b.op1(AND, [zA[i], pos(sB[i], zB[i], `B${i} > 0`)], `edge ${i} top`);
    return b.name(b.op1(NOT, [b.op1(OR, [left, top])], `bias ${i}`), `bias${i}`, true);
  });
  b.next();
  // steps (sign-extended, ×4) and the tile offset 12·(A⁺ + B⁺) (A⁺: A when A > 0, else 0)
  const ext = (w: string, s: string, l: string) => b.op1(merger([2, DB, N - DB - 2]), [b.op1(constWord(2, 0), []), w, b.op1(fanout(N - DB - 2), [s])], l);
  const dx = E3.map((i) => ext(A[i], sA[i], `dx${i} = 4·A${i}`));
  const dy = E3.map((i) => ext(B[i], sB[i], `dy${i} = 4·B${i}`));
  const plus = (w: string, s: string, l: string) => b.op1(POS8, [b.op(splitter([CB, DB - CB]), [w]) + '.o0', s], l);
  const off = E3.map((i) => {
    const sum = b.op(rca(CB), [plus(A[i], sA[i], `A${i}⁺`), plus(B[i], sB[i], `B${i}⁺`), b.op1(TIE0, [])], `A${i}⁺ + B${i}⁺`);
    const s9 = b.op1(merger([CB, 1]), [`${sum}.s`, `${sum}.cout`]);
    const x8 = b.op1(merger([3, 9]), [b.op1(constWord(3, 0), []), s9], '×8');
    const x4 = b.op1(merger([2, 9, 1]), [b.op1(constWord(2, 0), []), s9, b.op1(TIE0, [])], '×4');
    const p12 = b.op(rca(12), [x8, x4, b.op1(TIE0, [])], `off${i} = 12·(A⁺ + B⁺)`);
    return b.op1(merger([12, 1, N - 13]), [`${p12}.s`, `${p12}.cout`, b.op1(constWord(N - 13, 0), [])], `off${i}`);
  });
  b.next();
  // bounding box in tiles: min x → (min + 1) >> 4; max x → (max − 2) >> 4, 0 when max < 2
  const box = (c: string[], axis: string): [string, string] => {
    const [m01, M01] = minMax(b, c[0], c[1], `${axis}0 ${axis}1`);
    const [mn] = minMax(b, m01, c[2], `min ${axis}`, 'min');
    const [, mx] = minMax(b, M01, c[2], `max ${axis}`, 'max');
    const inc = b.op(incrementer(CB), [mn], `min ${axis} + 1`);
    const t0 = `${b.op(splitter([4, 4]), [`${inc}.y`])}.o1`;
    const dec = b.op(rca(CB), [mx, b.op1(constWord(CB, 0xfe), []), b.op1(TIE0, [])], `max ${axis} − 2`);
    const hi = `${b.op(splitter([4, 4]), [`${dec}.s`])}.o1`;
    const t1 = b.op1(AND4W, [hi, b.op1(fanout(4), [`${dec}.cout`])], `${axis === 'x' ? 'tx1' : 'ty1'}: 0 if max < 2`);
    return [t0, t1];
  };
  const [tx0, tx1] = box(['v0x', 'v1x', 'v2x'], 'x');
  const [ty0, ty1] = box(['v0y', 'v1y', 'v2y'], 'y');
  b.next();
  // the first tile's top-left pixel centre: (16·tx0 + 2, 16·ty0 + 2)
  const c2 = b.op1(constWord(4, 2), []);
  const ox = z10(b, b.op1(merger([4, 4]), [c2, tx0], 'ox'), z2), oy = z10(b, b.op1(merger([4, 4]), [c2, ty0], 'oy'), z2);
  // operands by phase (s mod 8): 1 A0·(v2x − v0x), 2 B0·(v2y − v0y), 3/4 edge 0 at the origin, 5/6 edge 1, 7/0 edge 2
  const mA = b.op1(muxTree(3, DB), [B[2], A[0], B[0], A[0], B[0], A[1], B[1], A[2], s3], 'A or B of the edge');
  const mP = b.op1(muxTree(3, DB), [oy, V[4], V[5], ox, oy, ox, oy, ox, s3], 'point');
  const mV = b.op1(muxTree(3, DB), [V[5], V[0], V[1], V[0], V[1], V[2], V[3], V[4], s3], 'its vertex');
  b.next();
  const dlt = b.op(addSub(DB), [mP, mV, one], 'Δ = point − vertex');
  b.next();
  const prod = b.op1(boothMul(DB), [mA, `${dlt}.s`], 'product');
  const p18 = `${b.op(splitter([N, 2 * DB - N]), [prod])}.o0`;
  // second operand: s odd → −bias of the edge (s = 1: 0), s even → acc
  const bsel = b.op1(muxTree(2, 1), [b.op1(TIE0, []), bias[0], bias[1], bias[2], b.op1(merger([1, 1]), [`${sb}.o1`, `${sb}.o2`])], 'bias of the edge');
  b.next();
  const acc = b.op(register(N), ['', '', 'clk'], 'acc', 'acc');
  const y2 = b.op1(busMux2(N), [`${acc}.q`, b.op1(fanout(N), [bsel]), `${sb}.o0`], 'acc, or −bias');
  b.next();
  const sum = b.op(rca(N), [p18, y2, b.op1(TIE0, [])], 'product + acc');
  b.name(`${sum}.s`, 'sum', true);
  b.wire(`${sum}.s`, `${acc}.d`);
  b.next();
  // twice the area, written in S2 (s = 2: 0010)
  const dec = b.op(decoder(4), ['s'], 'phase');
  const area = b.op(register(N), [`${sum}.s`, `${dec}.y2`, 'clk'], '2 × area', 'area');
  // acc moves in S1 … S7 only: S8 may last (the depth set-up waits) and edge 2's value must stay put; idle and during
  // the walk nothing downstream switches
  b.wire(b.op1(orN(7), [1, 2, 3, 4, 5, 6, 7].map((i) => `${dec}.y${i}`), 'S1 … S7'), `${acc}.en`);
  b.next();
  const sAr = topBit(b, `${area}.q`, N, 'sign of area');
  const front = b.op1(AND, [b.op1(NOT, [sAr]), b.op1(NOT, [b.op1(isZero(N), [`${area}.q`], 'area = 0')])], 'area > 0: front face');
  b.next();
  for (const i of E3) { b.wire(dx[i], `dx${i}`); b.wire(dy[i], `dy${i}`); b.wire(off[i], `off${i}`); }
  b.wire(`${sum}.s`, 'e0');
  b.wire(front, 'front');
  b.wire(`${area}.q`, 'area');
  b.wire(tx0, 'tx0'); b.wire(tx1, 'tx1'); b.wire(ty0, 'ty0'); b.wire(ty1, 'ty1');
  const R = b.right;
  const outs = [...E3.flatMap((i) => [`dx${i}`, `dy${i}`, `off${i}`]), 'e0', 'front', 'area', 'tx0', 'tx1', 'ty0', 'ty1'];
  return define({
    id: 'rast_setup', name: 'Triangle set-up', category: 'arithmetic',
    summary: 'Everything the walk needs, from the three vertices: per edge A and B (subtractors), the top-left bias, the steps 4A and 4B (wiring), '
      + 'the tile test\'s offset 12·(A⁺ + B⁺); the bounding box in tiles (comparators). One 10 × 10 Booth multiplier and an accumulator then make a product a cycle '
      + 'for eight cycles: twice the area (its sign culls back faces) and each edge\'s value at the first tile\'s top-left pixel.',
    ports: [...VERTEX_PINS.map((p) => bus(p, CB, 'in')), bus('s', 4, 'in'), bit('clk', 'in', 'bottom', true),
      ...E3.flatMap((i) => [bus(`dx${i}`, N, 'out'), bus(`dy${i}`, N, 'out'), bus(`off${i}`, N, 'out')]), bus('e0', N, 'out'), bit('front', 'out'), bus('area', N, 'out'),
      bus('tx0', 4, 'out'), bus('tx1', 4, 'out'), bus('ty0', 4, 'out'), bus('ty1', 4, 'out')],
    symbol: { kind: 'box', label: 'SET-UP' },
    netlist: () => ({ pins: { ...pinsAt([...VERTEX_PINS, 's', 'clk'], 0, 6), ...pinsAt(outs, R, 4) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- walk control -------------------------------------------------------------------------------------

/**
 * The rasterizer's control. Phase s (4-bit register): 0 idle; go → 1 … 8 set-up (3 stops a back face); 9 TEST at a
 * tile's top-left pixel; 10 its 16 pixels (k counts them). Tiles tx, ty run over the box, bands left to right.
 * Commands: set-up loads stepper i in phase 4 + 2i (ld<i>); in TEST, a tile that fails skips (+4dx) or starts the
 * next band; in a tile, down / up along a column, right at its end; the last pixel steps to the next tile.
 */
export const RAST_WALK: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('go', 'front', 'ok', 'ready', 'tx0', 'tx1', 'ty0', 'ty1', 'clk');
  const sR = b.op(register(4), ['', '', 'clk'], 'phase s', 'phase');
  const kR = b.op(register(4), ['', b.op1(constWord(1, 1), []), 'clk'], 'pixel k', 'kreg');
  const txR = b.op(register(4), ['', '', 'clk'], 'tile x', 'txreg');
  const tyR = b.op(register(4), ['', '', 'clk'], 'tile y', 'tyreg');
  const s = b.name(`${sR}.q`, 's', true), k = b.name(`${kR}.q`, 'k', true), tx = b.name(`${txR}.q`, 'tx', true), ty = b.name(`${tyR}.q`, 'ty', true);
  b.next();
  const d = b.op(decoder(4), [s], 'phase');
  const ph = (i: number) => `${d}.y${i}`;
  const ks = b.op(splitter(ones(4)), [k], 'k bits');
  const kb = (i: number) => `${ks}.o${i}`;
  const lastTile = b.name(b.op1(equal(4), [tx, 'tx1'], 'last tile in band'), 'lastTile', true);
  const lastBand = b.name(b.op1(equal(4), [ty, 'ty1'], 'last band'), 'lastBand', true);
  b.next();
  const k15 = b.op1(andN(4), [kb(0), kb(1), kb(2), kb(3)], 'k = 15');
  const j3 = b.op1(AND, [kb(0), kb(1)], 'column end');
  const endAll = b.name(b.op1(AND, [lastTile, lastBand], 'last tile'), 'endAll', true);
  const nok = b.op1(NOT, ['ok']);
  b.next();
  const fail = b.op1(AND, [ph(9), nok], 'tile skipped');
  const tileEnd = b.name(b.op1(OR, [fail, b.op1(AND, [ph(10), k15], 'tile done')], 'next tile'), 'tileEnd', true);
  const idle = b.op1(AND, [ph(0), b.op1(NOT, ['go'])], 'idle, no go');
  const cull = b.op1(AND, [ph(3), b.op1(NOT, ['front'])], 'back face');
  b.next();
  const stop = b.op1(OR, [b.op1(OR, [idle, cull]), b.op1(AND, [tileEnd, endAll])], 'to idle');
  const toTest = b.op1(AND, [tileEnd, b.op1(NOT, [endAll])], 'to TEST');
  const inc = b.op(incrementer(4), [s], 's + 1');
  b.next();
  const n1 = b.op1(busMux2(4), [`${inc}.y`, b.op1(constWord(4, 9), []), toTest], 'TEST');
  const n2 = b.op1(busMux2(4), [n1, b.op1(constWord(4, 0), []), stop], 'idle');
  const hold = b.op1(OR, [b.op1(AND, [ph(10), b.op1(NOT, [k15])], 'inside a tile'), b.op1(AND, [ph(8), b.op1(NOT, ['ready'])], 'set-up not done')], 'stay');
  b.wire(n2, `${sR}.d`);
  b.wire(b.op1(NOT, [hold]), `${sR}.en`);
  // k: counts in phase 10, 0 otherwise
  const ki = b.op(incrementer(4), [k], 'k + 1');
  b.next();
  b.wire(b.op1(AND4W, [`${ki}.y`, b.op1(fanout(4), [ph(10)])], 'k + 1 in a tile'), `${kR}.d`);
  // tiles: S8 loads the first; a tile's end moves right, or back to tx0 and down a band
  const txi = b.op(incrementer(4), [tx], 'tx + 1'), tyi = b.op(incrementer(4), [ty], 'ty + 1');
  b.next();
  b.wire(b.op1(busMux2(4), [`${txi}.y`, 'tx0', b.op1(OR, [ph(8), lastTile])], 'tx0 at S8 or a band\'s end'), `${txR}.d`);
  b.wire(b.op1(OR, [ph(8), tileEnd]), `${txR}.en`);
  b.wire(b.op1(busMux2(4), [`${tyi}.y`, 'ty0', ph(8)], 'ty0 at S8'), `${tyR}.d`);
  b.wire(b.op1(OR, [ph(8), b.op1(AND, [tileEnd, lastTile])]), `${tyR}.en`);
  // the walk's command: adv = band (6) at a band's last tile, nothing at the very last, else skip (3) / right (2)
  const c = (v: number) => b.op1(constWord(3, v), []);
  const step = b.op1(busMux2(3), [c(CMD.right), c(CMD.skip), ph(9)], 'skip in TEST');
  const advB = b.op1(busMux2(3), [c(CMD.band), c(CMD.hold), lastBand], 'band, or done');
  b.next();
  const adv = b.op1(busMux2(3), [step, advB, lastTile], 'to the next tile');
  const col = b.op1(busMux2(3), [c(CMD.down), c(CMD.up), kb(2)], 'down / up');
  b.next();
  const end = b.op1(busMux2(3), [c(CMD.right), adv, k15], 'column end');
  const tc = b.op1(busMux2(3), [adv, c(CMD.hold), 'ok'], 'TEST');
  b.next();
  const pc = b.op1(busMux2(3), [col, end, j3], 'pixel');
  b.next();
  const w1 = b.op1(busMux2(3), [c(CMD.hold), tc, ph(9)]);
  b.next();
  const walk = b.name(b.op1(busMux2(3), [w1, pc, ph(10)], 'walk command'), 'walk', true);
  b.next();
  for (const i of E3) b.wire(b.op1(busMux2(3), [walk, c(CMD.load), ph(4 + 2 * i)], `cmd ${i}`), `cmd${i}`);
  // pixel: x = 4·tx + column, y = 4·ty + row (row = j, or 3 − j in odd columns)
  const jx = b.op1(merger([1, 1]), [b.op1(XOR, [kb(0), kb(2)]), b.op1(XOR, [kb(1), kb(2)])], 'row in tile');
  b.wire(b.op1(merger([2, 4]), [`${b.op(splitter([2, 2]), [k])}.o1`, tx], 'x'), 'x');
  b.wire(b.op1(merger([2, 4]), [jx, ty], 'y'), 'y');
  b.wire(ph(10), 'pix');
  b.wire(b.op1(NOT, [ph(0)], 'busy'), 'busy');
  b.wire(s, 's');
  const R = b.right;
  return define({
    id: 'rast_walk', name: 'Tile walk', category: 'sequential',
    summary: 'The rasterizer\'s state machine: eight set-up cycles (a back face stops after the third), then the bounding box in 4 × 4-pixel tiles, '
      + 'bands of tiles left to right. Each tile: one TEST cycle (does any edge rule it out?), then its 16 pixels, column by column (down, up, down, up), '
      + 'ending at its top-right pixel, one step from the next tile. It sends the three edge steppers one command a cycle.',
    ports: [bit('go', 'in'), bit('front', 'in'), bit('ok', 'in'), bit('ready', 'in'), bus('tx0', 4, 'in'), bus('tx1', 4, 'in'), bus('ty0', 4, 'in'), bus('ty1', 4, 'in'),
      bit('clk', 'in', 'bottom', true), bus('s', 4, 'out'), bus('cmd0', 3, 'out'), bus('cmd1', 3, 'out'), bus('cmd2', 3, 'out'),
      bus('x', 6, 'out'), bus('y', 6, 'out'), bit('pix', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'TILE WALK' },
    netlist: () => ({ pins: { ...pinsAt(['go', 'front', 'ok', 'ready', 'tx0', 'tx1', 'ty0', 'ty1', 'clk'], 0, 6), ...pinsAt(['s', 'cmd0', 'cmd1', 'cmd2', 'x', 'y', 'pix', 'busy'], R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- depth set-up ---------------------------------------------------------------------------------------

/** z: 32-bit two's complement with Z_FRAC fraction bits; quotients of the divider: 30 bits. */
const ZW = 32, QW = 30;

/**
 * The depth plane's set-up, started in the rasterizer's set-up phase 3 (when twice the area is known). States:
 * MUL (4 cycles on its own Booth multiplier: Nx = A0·Δz2 + A2·Δz1, Ny = B0·Δz2 + B2·Δz1), DIVX and DIVY (one
 * iterative divider: Zx = ±(|Nx|·2^12 / area), truncated, likewise Zy), SUM (Zx + Zy), HORN (ten cycles of
 * shift-and-add over the bits of the first tile's offset from vertex 0: acc = Zx·Δx + Zy·Δy), FINAL (+ z0·2^12),
 * READY. Everything wraps at 32 bits: only z at pixels inside the triangle has to come out right.
 */
export const Z_SETUP: ComponentDef = (() => {
  const b = new Builder(14, 12, 4);
  b.pins('start', 'v0x', 'v0y', 'z0', 'z1', 'z2', 'a0', 'a2', 'b0', 'b2', 'area', 'tx0', 'ty0', 'clk');
  const stR = b.op(register(3), ['', '', 'clk'], 'state', 'state');
  const kR = b.op(register(4), ['', '', 'clk'], 'cycle in state', 'kreg');
  const st = b.name(`${stR}.q`, 'st', true), k = b.name(`${kR}.q`, 'k', true);
  const z2b = b.op1(constWord(DB - CB, 0), []), one = b.op1(constWord(1, 1), []);
  b.next();
  const p = b.op(decoder(3), [st], 'state');
  const ph = (i: number) => `${p}.y${i}`;
  const kd = b.op(decoder(4), [k], 'k');
  const kk = (i: number) => `${kd}.y${i}`;
  const ks = b.op(splitter(ones(4)), [k]);
  // Δz1 = z1 − z0, Δz2 = z2 − z0; Δx, Δy: the first tile's top-left pixel centre minus vertex 0
  const z0e = z10(b, 'z0', z2b);
  const dz1 = b.op(addSub(DB), [z10(b, 'z1', z2b), z0e, one], 'Δz1');
  const dz2 = b.op(addSub(DB), [z10(b, 'z2', z2b), z0e, one], 'Δz2');
  const c2 = b.op1(constWord(4, 2), []);
  const dX = b.op(addSub(DB), [z10(b, b.op1(merger([4, 4]), [c2, 'tx0']), z2b), z10(b, 'v0x', z2b), one], 'Δx = ox − x0');
  const dY = b.op(addSub(DB), [z10(b, b.op1(merger([4, 4]), [c2, 'ty0']), z2b), z10(b, 'v0y', z2b), one], 'Δy = oy − y0');
  b.next();
  // the state machine: every transition is to the next state; k counts cycles within a state
  const div = b.op(nrSeqDivider(QW), ['clk', '', '', ''], 'divider', 'div');
  const done = `${div}.done`;
  const adv = b.op1(orN(6), [b.op1(AND, [ph(1), kk(3)]), b.op1(AND, [ph(2), done]), b.op1(AND, [ph(3), done]), ph(4), b.op1(AND, [ph(5), kk(9)]), ph(6)], 'next state');
  const change = b.op1(OR, ['start', adv], 'state changes');
  b.wire(change, `${stR}.en`);
  const sinc = b.op(incrementer(3), [st]);
  b.wire(b.op1(busMux2(3), [`${sinc}.y`, b.op1(constWord(3, 1), []), 'start'], 'start: MUL'), `${stR}.d`);
  const kinc = b.op(incrementer(4), [k]);
  b.wire(b.op1(AND4W, [`${kinc}.y`, b.op1(fanout(4), [b.op1(NOT, [change])])], 'k + 1, or 0'), `${kR}.d`);
  // idle and ready, k stands still: nothing downstream of it switches between triangles
  b.wire(b.op1(OR, [change, b.op1(NOT, [b.op1(OR, [ph(0), ph(7)])])], 'counting'), `${kR}.en`);
  b.next();
  // products: (A0, Δz2), (A2, Δz1), (B0, Δz2), (B2, Δz1)
  const mX = b.op1(muxTree(2, DB), ['a0', 'a2', 'b0', 'b2', b.op1(merger([1, 1]), [`${ks}.o0`, `${ks}.o1`])], 'A or B');
  const mY = b.op1(busMux2(DB), [`${dz2}.s`, `${dz1}.s`, `${ks}.o0`], 'Δz');
  b.next();
  const prod = b.op1(boothMul(DB), [mX, mY], 'product');
  const ps = b.op(splitter([2 * DB - 1, 1]), [prod]);
  const p32 = b.op1(merger([2 * DB - 1, ZW - 2 * DB + 1]), [`${ps}.o0`, b.op1(fanout(ZW - 2 * DB + 1), [`${ps}.o1`])], 'product, 32-bit');
  b.next();
  // the registers: acc, Nx, Ny (18-bit), Zx, Zy, S
  const acc = b.op(register(ZW), ['', b.op1(orN(3), [ph(1), ph(5), ph(6)]), 'clk'], 'acc', 'acc');
  const nx = b.op(register(N), ['', b.op1(AND, [ph(1), kk(1)]), 'clk'], 'Nx', 'nx');
  const ny = b.op(register(N), ['', b.op1(AND, [ph(1), kk(3)]), 'clk'], 'Ny', 'ny');
  const zx = b.op(register(ZW), ['', b.op1(AND, [ph(2), done]), 'clk'], 'Zx', 'zx');
  const zy = b.op(register(ZW), ['', b.op1(AND, [ph(3), done]), 'clk'], 'Zy', 'zy');
  const sR = b.op(register(ZW), ['', ph(4), 'clk'], 'Zx + Zy', 'sxy');
  b.name(`${acc}.q`, 'acc', true); b.name(`${zx}.q`, 'Zx', true); b.name(`${zy}.q`, 'Zy', true);
  b.next();
  // the divider: |N|·2^12 / area, N = Nx in DIVX, Ny in DIVY; started in each one's first cycle
  const nSel = b.op1(busMux2(N), [`${nx}.q`, `${ny}.q`, ph(3)], 'Nx or Ny');
  const nSign = topBit(b, nSel, N, 'its sign');
  const mag = b.op1(absValue(N), [nSel], '|N|');
  b.wire(b.op1(merger([Z_FRAC, N]), [b.op1(constWord(Z_FRAC, 0), []), mag], '|N|·2^12'), `${div}.a`);
  b.wire(b.op1(merger([N, QW - N]), ['area', b.op1(constWord(QW - N, 0), [])], 'area'), `${div}.b`);
  b.wire(b.op1(AND, [b.op1(OR, [ph(2), ph(3)]), kk(0)], 'start a division'), `${div}.start`);
  const q = b.op1(condNegate(ZW), [b.op1(merger([QW, ZW - QW]), [`${div}.q`, b.op1(constWord(ZW - QW, 0), [])]), nSign], 'signed quotient');
  b.wire(q, `${zx}.d`); b.wire(q, `${zy}.d`);
  b.next();
  // Horner: bit j = 9 − k of Δx and Δy picks 0, Zx, Zy or Zx + Zy
  const bitOf = (w: string, l: string) => {
    const sp = b.op(splitter(ones(DB)), [w]);
    const z = b.op1(TIE0, []);
    return b.op1(muxTree(4, 1), [...Array.from({ length: 16 }, (_, i) => (i < DB ? `${sp}.o${DB - 1 - i}` : z)), k], l);
  };
  const bx = bitOf(`${dX}.s`, 'bit of Δx'), by = bitOf(`${dY}.s`, 'bit of Δy');
  const op = b.op1(muxTree(2, ZW), [b.op1(constWord(ZW, 0), []), `${zx}.q`, `${zy}.q`, `${sR}.q`, b.op1(merger([1, 1]), [bx, by])], 'Horner operand');
  b.next();
  // the adder's operands by state: MUL (k odd ? acc : 0) + P; SUM Zx + Zy; HORN (k = 0 ? 0 : 2·acc) ± op; FINAL acc + z0·2^12
  const acc2 = b.op1(merger([1, ZW - 1]), [b.op1(TIE0, []), `${b.op(splitter([ZW - 1, 1]), [`${acc}.q`])}.o0`], '2·acc');
  const horn = b.op1(AND, [ph(5), b.op1(NOT, [kk(0)])], 'Horner, not first');
  // first operand select: 0: 0, 1: acc, 2: Zx, 3: 2·acc
  const x0 = b.op1(orN(3), [b.op1(AND, [ph(1), `${ks}.o0`]), ph(6), horn], 'acc or 2·acc');
  const x1 = b.op1(OR, [ph(4), horn], 'Zx or 2·acc');
  const xop = b.op1(muxTree(2, ZW), [b.op1(constWord(ZW, 0), []), `${acc}.q`, `${zx}.q`, acc2, b.op1(merger([1, 1]), [x0, x1])], 'first operand');
  const zs = b.op1(merger([Z_FRAC, CB, ZW - Z_FRAC - CB]), [b.op1(constWord(Z_FRAC, 0), []), 'z0', b.op1(constWord(ZW - Z_FRAC - CB, 0), [])], 'z0·2^12');
  // second operand select: 0: P (MUL), 1: Zy (SUM), 2: op (HORN), 3: z0·2^12 (FINAL)
  const ysel = b.op1(merger([1, 1]), [b.op1(OR, [ph(4), ph(6)]), b.op1(OR, [ph(5), ph(6)])]);
  const yop = b.op1(muxTree(2, ZW), [p32, `${zy}.q`, op, zs, ysel], 'second operand');
  b.next();
  const sum = b.op(addSub(ZW), [xop, yop, b.op1(AND, [ph(5), kk(0)], 'sign bit: subtract')], 'the adder');
  b.name(`${sum}.s`, 'sum', true);
  for (const r of [acc, sR]) b.wire(`${sum}.s`, `${r}.d`);
  const s18 = `${b.op(splitter([N, ZW - N]), [`${sum}.s`])}.o0`;
  b.wire(s18, `${nx}.d`); b.wire(s18, `${ny}.d`);
  b.next();
  const x4 = (r: string, l: string) => b.op1(merger([2, ZW - 2]), [b.op1(constWord(2, 0), []), `${b.op(splitter([ZW - 2, 2]), [r])}.o0`], l);
  b.wire(x4(`${zx}.q`, '4·Zx'), 'zdx');
  b.wire(x4(`${zy}.q`, '4·Zy'), 'zdy');
  b.wire(`${acc}.q`, 'ze0');
  b.wire(ph(7), 'ready');
  const R = b.right;
  const ins = ['start', 'v0x', 'v0y', 'z0', 'z1', 'z2', 'a0', 'a2', 'b0', 'b2', 'area', 'tx0', 'ty0', 'clk'];
  return define({
    id: 'z_setup', name: 'Depth set-up', category: 'arithmetic',
    summary: 'The slopes of z across the triangle and its value at the first tile: four products (its own Booth multiplier), two divisions by twice the area '
      + `(one ${QW}-bit iterative divider, quotients truncated), and ten cycles of shift-and-add. About 80 cycles a triangle; the walk waits for ready.`,
    ports: [bit('start', 'in'), bus('v0x', CB, 'in'), bus('v0y', CB, 'in'), bus('z0', CB, 'in'), bus('z1', CB, 'in'), bus('z2', CB, 'in'),
      bus('a0', DB, 'in'), bus('a2', DB, 'in'), bus('b0', DB, 'in'), bus('b2', DB, 'in'), bus('area', N, 'in'), bus('tx0', 4, 'in'), bus('ty0', 4, 'in'),
      bit('clk', 'in', 'bottom', true), bus('zdx', ZW, 'out'), bus('zdy', ZW, 'out'), bus('ze0', ZW, 'out'), bit('ready', 'out')],
    symbol: { kind: 'box', label: 'DEPTH SET-UP' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(['zdx', 'zdy', 'ze0', 'ready'], R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** z (32-bit) → the depth buffer's 16 bits: z >> 4, 0 when negative, 0xFFFF past 2^20. */
export const Z_CLAMP: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins('z');
  const sp = b.op(splitter([4, 16, 11, 1]), ['z'], 'z');
  b.next();
  const hs = b.op(splitter(ones(11)), [`${sp}.o2`]);
  const ovf = b.op1(orN(11), Array.from({ length: 11 }, (_, i) => `${hs}.o${i}`), 'z ≥ 2^20');
  b.next();
  const hi = b.op1(busMux2(16), [`${sp}.o1`, b.op1(constWord(16, 0xffff), []), ovf], 'too far: 0xFFFF');
  b.next();
  b.wire(b.op1(busMux2(16), [hi, b.op1(constWord(16, 0), []), `${sp}.o3`], 'negative: 0'), 'zs');
  const R = b.right;
  return define({
    id: 'z_clamp', name: 'Depth clamp', category: 'arithmetic',
    summary: 'The depth buffer keeps 16 bits of z: bits 19…4 (8.8), 0 when z is negative, 0xFFFF when it does not fit.',
    ports: [bus('z', ZW, 'in'), bus('zs', 16, 'out')],
    symbol: { kind: 'box', label: 'CLAMP' },
    spec: ([z]) => [z >= 2 ** 31 ? 0 : z >= 2 ** 20 ? 0xffff : Math.floor(z / 16)],
    netlist: () => ({ pins: { z: [0, 4], zs: [R, 4] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the rasterizer ----------------------------------------------------------------------------------

const rastCache = new Map<boolean, ComponentDef>();

/**
 * A triangle in (three vertices in quarter pixels, a colour, go for one cycle while idle), pixel writes out:
 * fa = y·64 + x, fd = the colour, fwe for each covered pixel. busy from the cycle after go until the last tile.
 * depth: z per vertex in, z per pixel out (fz, the depth buffer's 16 bits), and clr: go with clr = 1 walks every
 * tile of the screen and writes every pixel (fclr: the ROP clears).
 */
export function rasterizer(depth = false): ComponentDef {
  const hit = rastCache.get(depth);
  if (hit) return hit;
  const b = new Builder(14, 14, 4);
  const zp = depth ? ['z0', 'z1', 'z2'] : [];
  b.pins(...VERTEX_PINS, ...zp, 'col', ...(depth ? ['clr'] : []), 'go', 'clk');
  // the triangle is latched while idle (the cycle that sees go latches it)
  const lat = [...VERTEX_PINS, 'col', ...zp].map((p) => b.op(register(CB), [p, '', 'clk'], p === 'col' ? 'colour' : p, `r_${p}`));
  const clr = depth ? b.op(DFFE, ['clr', '', 'clk'], 'clear', 'r_clr') : '';
  b.next();
  const setup = b.op(RAST_SETUP, [...lat.slice(0, 6).map((r) => `${r}.q`), '', 'clk'], 'set-up', 'setup');
  b.next();
  const walk = b.op(RAST_WALK, ['go', '', '', depth ? '' : b.op1(constWord(1, 1), []), '', '', '', '', 'clk'], 'tile walk', 'walk');
  b.name(`${walk}.s`, 'phase', true);
  b.wire(`${walk}.s`, `${setup}.s`);
  const idle = b.op1(NOT, [`${walk}.busy`], 'idle');
  for (const r of lat) b.wire(idle, `${r}.en`);
  if (depth) b.wire(idle, `${clr}.en`);
  // clear: the whole screen (tiles 0 … 15), every tile and pixel accepted, never culled
  const cq = depth ? `${clr}.q` : '';
  const bound = (port: string, v: number) => (depth ? b.op1(busMux2(4), [`${setup}.${port}`, b.op1(constWord(4, v), []), cq]) : `${setup}.${port}`);
  b.wire(bound('tx0', 0), `${walk}.tx0`); b.wire(bound('tx1', 15), `${walk}.tx1`);
  b.wire(bound('ty0', 0), `${walk}.ty0`); b.wire(bound('ty1', 15), `${walk}.ty1`);
  b.wire(depth ? b.op1(OR, [`${setup}.front`, cq]) : `${setup}.front`, `${walk}.front`);
  b.next();
  const st = E3.map((i) => b.op(EDGE_STEP, [`${setup}.dx${i}`, `${setup}.dy${i}`, `${setup}.off${i}`, `${setup}.e0`, `${walk}.cmd${i}`, 'clk'], `edge ${i}`, `edge${i}`));
  let fz = '';
  if (depth) {
    // A0, A2, B0, B2 are the steps' bits 11…2
    const ab = (port: string) => `${b.op(splitter([2, DB, N - DB - 2]), [`${setup}.${port}`])}.o1`;
    const ss = b.op(splitter(ones(4)), [`${walk}.s`]);
    const sb = (i: number) => `${ss}.o${i}`;
    const ph3 = b.op1(andN(4), [sb(0), sb(1), b.op1(NOT, [sb(2)]), b.op1(NOT, [sb(3)])], 'phase 3');
    const ph8 = b.op1(andN(4), [b.op1(NOT, [sb(0)]), b.op1(NOT, [sb(1)]), b.op1(NOT, [sb(2)]), sb(3)], 'phase 8');
    const zs = b.op(Z_SETUP, [ph3, `${lat[0]}.q`, `${lat[1]}.q`, `${lat[7]}.q`, `${lat[8]}.q`, `${lat[9]}.q`, ab('dx0'), ab('dx2'), ab('dy0'), ab('dy2'),
      `${setup}.area`, `${setup}.tx0`, `${setup}.ty0`, 'clk'], 'depth set-up', 'zsetup');
    b.wire(`${zs}.ready`, `${walk}.ready`);
    b.next();
    const zcmd = b.op1(busMux2(3), [`${walk}.cmd0`, b.op1(constWord(3, CMD.load), []), b.op1(AND, [ph8, `${zs}.ready`])], 'load z when set-up is done');
    const zst = b.op(edgeStep(ZW, false), [`${zs}.zdx`, `${zs}.zdy`, `${zs}.ze0`, zcmd, 'clk'], 'depth', 'zstep');
    fz = b.op1(Z_CLAMP, [`${zst}.e`], 'depth buffer form');
  }
  b.next();
  const inside0 = b.op1(NOT, [b.op1(OR, [b.op1(OR, [`${st[0]}.neg`, `${st[1]}.neg`]), `${st[2]}.neg`])], 'inside: no edge negative');
  const ok0 = b.op1(NOT, [b.op1(OR, [b.op1(OR, [`${st[0]}.tneg`, `${st[1]}.tneg`]), `${st[2]}.tneg`])], 'tile may hold pixels');
  const inside = depth ? b.op1(OR, [inside0, cq]) : inside0;
  b.wire(depth ? b.op1(OR, [ok0, cq]) : ok0, `${walk}.ok`);
  b.next();
  b.wire(b.op1(AND, [`${walk}.pix`, inside], 'write'), 'fwe');
  b.wire(b.op1(merger([6, 6]), [`${walk}.x`, `${walk}.y`], 'y·64 + x'), 'fa');
  b.wire(`${lat[6]}.q`, 'fd');
  if (depth) { b.wire(fz, 'fz'); b.wire(cq, 'fclr'); }
  b.wire(`${walk}.busy`, 'busy');
  const R = b.right;
  const ins = [...VERTEX_PINS, ...zp, 'col', ...(depth ? ['clr'] : []), 'go', 'clk'], outs = ['fa', 'fd', ...(depth ? ['fz', 'fclr'] : []), 'fwe', 'busy'];
  const d = define({
    id: depth ? 'rasterizer_z' : 'rasterizer', name: depth ? 'Rasterizer with depth' : 'Rasterizer', category: 'cpu',
    summary: 'Three vertices in, the covered pixels out, one a cycle. Set-up finds each edge function (eight cycles on one multiplier), '
      + 'the tile walk visits the bounding box in 4 × 4 tiles and skips those an edge rules out, and three edge steppers keep E current with adders only. '
      + 'A pixel is written when all three edges are ≥ 0 (with the top-left rule, a pixel on a shared edge goes to one triangle).'
      + (depth ? ' With depth: z per vertex, its plane set up with a divider and stepped like an edge; z out with every pixel. go with clr walks the whole screen.' : ''),
    ports: [...VERTEX_PINS.map((p) => bus(p, CB, 'in')), ...zp.map((p) => bus(p, CB, 'in')), bus('col', CB, 'in'), ...(depth ? [bit('clr', 'in')] : []), bit('go', 'in'), bit('clk', 'in', 'bottom', true),
      bus('fa', 12, 'out'), bus('fd', CB, 'out'), ...(depth ? [bus('fz', 16, 'out'), bit('fclr', 'out')] : []), bit('fwe', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: depth ? 'RASTERIZER + Z' : 'RASTERIZER' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(outs, R, 6) }, instances: b.instances, nets: b.nets() }),
  });
  rastCache.set(depth, d);
  return d;
}

export const RASTERIZER = rasterizer(false);

// ---- blend and depth test -------------------------------------------------------------------------------

const NOT3: ComponentDef = (() => {
  const b = new Builder(8, 10, 2);
  b.pins('a');
  const sp = b.op(splitter(ones(3)), ['a']);
  b.next();
  const n = [0, 1, 2].map((i) => b.op1(NOT, [`${sp}.o${i}`]));
  b.next();
  b.wire(b.op1(merger(ones(3)), n), 'y');
  const R = b.right;
  return define({
    id: 'not3', name: '3-bit NOT', category: 'gate', summary: 'Three inverters: 7 − a for a 3-bit a.',
    ports: [bus('a', 3, 'in'), bus('y', 3, 'out')], symbol: { kind: 'box', label: 'NOT' },
    spec: ([a]) => [7 - a],
    netlist: () => ({ pins: { a: [0, 4], y: [R, 4] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Alpha blending of a source and a destination RGB332 pixel, alpha in eighths (a + 1, a = 7: the source). */
export const BLEND332: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins('s', 'd', 'a');
  const ss = b.op(splitter([2, 3, 3]), ['s'], 'source'), ds = b.op(splitter([2, 3, 3]), ['d'], 'destination');
  const inc = b.op(incrementer(3), ['a'], 'a + 1');
  const a1 = b.op1(merger([3, 1]), [`${inc}.y`, `${inc}.cout`]);
  const na = b.op1(merger([3, 1]), [b.op1(NOT3, ['a'], '7 − a'), b.op1(TIE0, [])]);
  b.next();
  // one channel of `bits` bits: (s·(a + 1) + d·(7 − a)) >> 3
  const channel = (sc: string, dc: string, l: string, bits: number) => {
    const z = (x: string) => (bits === 4 ? x : b.op1(merger([bits, 4 - bits]), [x, b.op1(constWord(4 - bits, 0), [])]));
    const ps = b.op1(arrayMul(4), [z(sc), a1], `${l}: s·(a + 1)`);
    const pd = b.op1(arrayMul(4), [z(dc), na], `${l}: d·(7 − a)`);
    const sum = b.op(rca(8), [ps, pd, b.op1(TIE0, [])], `${l}: sum`);
    return `${b.op(splitter([3, bits, 8 - 3 - bits]), [`${sum}.s`])}.o1`;
  };
  const ch = [0, 1, 2].map((i) => channel(`${ss}.o${i}`, `${ds}.o${i}`, ['blue', 'green', 'red'][i], i === 0 ? 2 : 3));
  b.next();
  b.wire(b.op1(merger([2, 3, 3]), ch, 'mixed'), 'y');
  const R = b.right;
  return define({
    id: 'blend332', name: 'Alpha blend (RGB332)', category: 'arithmetic',
    summary: 'Each channel becomes (s·(a + 1) + d·(7 − a)) / 8: the source weighs a + 1 eighths, the destination the rest. Six 4 × 4 array multipliers and three adders; the division by 8 is wiring.',
    ports: [bus('s', 8, 'in'), bus('d', 8, 'in'), bus('a', 3, 'in'), bus('y', 8, 'out')],
    symbol: { kind: 'box', label: 'BLEND' },
    spec: ([s, d, a]) => {
      const c = (sh: number, w: number) => { const m = (1 << w) - 1; return ((((s >> sh) & m) * (a + 1) + ((d >> sh) & m) * (7 - a)) >> 3) << sh; };
      return [c(5, 3) | c(2, 3) | c(0, 2)];
    },
    netlist: () => ({ pins: { ...pinsAt(['s', 'd', 'a'], 0, 6), y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The render output unit between the rasterizer and the framebuffer: the depth test against its own 64 × 64 × 16-bit
 * depth buffer (zt: on), alpha blending with the pixel already there (a: 7 is opaque), and clearing (fclr: colour and
 * depth 0xFFFF everywhere). Reads and writes in the same cycle: the buffers read combinationally, write at the edge.
 */
export const ROP: ComponentDef = (() => {
  const b = new Builder(12, 12, 4);
  b.pins('fa', 'fd', 'fz', 'fclr', 'fwe', 'zt', 'a', 'wq', 'clk');
  const far = new Uint32Array(FB_W * FB_W).fill(0xffff);
  const zb = b.op(bigRamWithInit(12, 16, far), ['fa', '', '', 'clk'], 'depth buffer', 'zbuf');
  b.next();
  const nearer = `${b.op(magComparator(16), ['fz', `${zb}.dout`], 'nearer?')}.lt`;
  const pass = b.op1(OR, [b.op1(OR, ['fclr', b.op1(NOT, ['zt'])]), nearer], 'passes');
  const we = b.name(b.op1(AND, ['fwe', pass], 'write'), 'we', true);
  b.wire(b.op1(AND, [we, b.op1(OR, ['zt', 'fclr'])], 'write depth'), `${zb}.we`);
  b.wire(b.op1(busMux2(16), ['fz', b.op1(constWord(16, 0xffff), []), 'fclr'], 'clear: far'), `${zb}.din`);
  const mix = b.op1(BLEND332, ['fd', 'wq', 'a'], 'blend');
  b.next();
  b.wire(b.op1(busMux2(8), [mix, 'fd', 'fclr'], 'clear: the colour'), 'wd');
  b.wire('fa', 'wa');
  b.wire(we, 'we');
  const R = b.right;
  return define({
    id: 'rop', name: 'Depth test and blend', category: 'memory',
    summary: 'Between the rasterizer and the framebuffer: a pixel is written only if it is nearer than what the depth buffer holds there (when the test is on), '
      + 'and its colour is mixed with the pixel already in the frame by alpha. Clear writes the colour and the farthest depth everywhere.',
    ports: [bus('fa', 12, 'in'), bus('fd', 8, 'in'), bus('fz', 16, 'in'), bit('fclr', 'in'), bit('fwe', 'in'), bit('zt', 'in'), bus('a', 3, 'in'), bus('wq', 8, 'in'),
      bit('clk', 'in', 'bottom', true), bus('wa', 12, 'out'), bus('wd', 8, 'out'), bit('we', 'out')],
    symbol: { kind: 'box', label: 'DEPTH · BLEND' },
    netlist: () => ({ pins: { ...pinsAt(['fa', 'fd', 'fz', 'fclr', 'fwe', 'zt', 'a', 'wq', 'clk'], 0, 6), ...pinsAt(['wa', 'wd', 'we'], R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- framebuffer and scan-out ------------------------------------------------------------------------

/** Words of one frame: four pixels each. */
export const FB_WORDS = (FB_W * FB_W) / 4;
const WK = Math.log2(FB_WORDS);

const bufCache = new Map<string, ComponentDef>();

/**
 * One 64 × 64 frame of RGB332 bytes: four byte banks (pixel x mod 4), so a word address reads four neighbours at
 * once (q, pixel 4a in its low byte) while a write goes to one bank (lane = x mod 4). q8: the byte at a, lane.
 * `init`: the frame's pixels at power-on (index y·64 + x).
 */
export function pixelBuffer(init?: ArrayLike<number>): ComponentDef {
  const key = init ? hashBytes(init) : '';
  const hit = bufCache.get(key);
  if (hit) return hit;
  const banks = [0, 1, 2, 3].map((j) => {
    if (!init) return bigRam(WK, 8);
    const words = new Uint32Array(FB_WORDS);
    for (let a = 0; a < FB_WORDS; a++) words[a] = init[4 * a + j] & 255;
    return bigRamWithInit(WK, 8, words);
  });
  const b = new Builder(12, 12, 4);
  b.pins('a', 'lane', 'd', 'we', 'clk');
  const dec = b.op(decoder(2, true), ['lane', 'we'], 'which bank');
  b.next();
  const qs = banks.map((B, j) => b.op(B, ['a', 'd', `${dec}.y${j}`, 'clk'], `bank ${j}: x mod 4 = ${j}`, `bank${j}`));
  b.next();
  b.wire(b.op1(merger([8, 8, 8, 8]), qs.map((q) => `${q}.dout`), 'four pixels'), 'q');
  b.wire(b.op1(muxTree(2, 8), [...qs.map((q) => `${q}.dout`), 'lane'], 'this pixel'), 'q8');
  const R = b.right;
  const d = define({
    id: init ? `pixbuf_${hashBytes(init)}` : 'pixbuf', name: init ? 'Frame (with a picture)' : 'Frame', category: 'memory',
    summary: `${FB_W} × ${FB_W} pixels of one byte (RGB332), in four banks of ${FB_WORDS} bytes: bank j holds the pixels whose x mod 4 = j, `
      + 'so one word address reads four neighbouring pixels (the scan-out\'s word) and a write enables one bank (the rasterizer\'s pixel).',
    ports: [bus('a', WK, 'in'), bus('lane', 2, 'in'), bus('d', 8, 'in'), bit('we', 'in'), bit('clk', 'in', 'bottom', true), bus('q', 32, 'out'), bus('q8', 8, 'out')],
    symbol: { kind: 'box', label: 'FRAME 64×64' },
    netlist: () => ({ pins: { ...pinsAt(['a', 'lane', 'd', 'we', 'clk'], 0, 6), ...pinsAt(['q', 'q8'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
  bufCache.set(key, d);
  return d;
}

function hashBytes(v: ArrayLike<number>): string {
  let h = 2166136261;
  for (let i = 0; i < v.length; i++) { h ^= v[i] & 255; h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

const fbCache = new Map<string, ComponentDef>();

/**
 * Two frames. front = 0: frame 0 is read by the scan-out (ra: a word), frame 1 written by the rasterizer (wa: a
 * pixel); front = 1 the other way round. rq: the four front pixels at ra; wq: the back frame's pixel at wa.
 */
export function frameBuffers(init0?: ArrayLike<number>, init1?: ArrayLike<number>): ComponentDef {
  const F0 = pixelBuffer(init0), F1 = pixelBuffer(init1);
  const key = `${F0.id}/${F1.id}`;
  const hit = fbCache.get(key);
  if (hit) return hit;
  const b = new Builder(12, 12, 4);
  b.pins('ra', 'wa', 'wd', 'we', 'front', 'clk');
  const ws = b.op(splitter([2, WK]), ['wa'], 'pixel → word, lane');
  const nf = b.op1(NOT, ['front'], 'back is frame 0');
  b.next();
  const we0 = b.op1(AND, ['we', 'front'], 'write frame 0'), we1 = b.op1(AND, ['we', nf], 'write frame 1');
  const a0 = b.op1(busMux2(WK), [`${ws}.o1`, 'ra', nf], 'frame 0: front → scan-out');
  const a1 = b.op1(busMux2(WK), [`${ws}.o1`, 'ra', 'front'], 'frame 1: front → scan-out');
  b.next();
  const f0 = b.op(F0, [a0, `${ws}.o0`, 'wd', we0, 'clk'], 'frame 0', 'fb0');
  const f1 = b.op(F1, [a1, `${ws}.o0`, 'wd', we1, 'clk'], 'frame 1', 'fb1');
  b.next();
  b.wire(b.op1(busMux2(32), [`${f0}.q`, `${f1}.q`, 'front'], 'front frame'), 'rq');
  b.wire(b.op1(busMux2(8), [`${f1}.q8`, `${f0}.q8`, 'front'], 'back frame'), 'wq');
  const R = b.right;
  const d = define({
    id: `fb2_${F0.id}_${F1.id}`, name: 'Double framebuffer', category: 'memory',
    summary: 'Two frames: the front one is read by the scan-out while the rasterizer draws into the back one, so the screen never shows a half-drawn picture. '
      + 'Flipping front swaps which frame each side\'s address reaches (two address multiplexers), nothing is copied.',
    ports: [bus('ra', WK, 'in'), bus('wa', 12, 'in'), bus('wd', 8, 'in'), bit('we', 'in'), bit('front', 'in'), bit('clk', 'in', 'bottom', true),
      bus('rq', 32, 'out'), bus('wq', 8, 'out')],
    symbol: { kind: 'box', label: 'FRAMEBUFFER ×2' },
    netlist: () => ({ pins: { ...pinsAt(['ra', 'wa', 'wd', 'we', 'front', 'clk'], 0, 6), ...pinsAt(['rq', 'wq'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
  fbCache.set(key, d);
  return d;
}

/**
 * The display side: a word address counting through the frame, one word (four pixels) a cycle, vsync on the last.
 * swap asks for a flip (held in `pending`); with sync = 1 the front frame flips at vsync, with sync = 0 at once.
 */
export const SCAN_OUT: ComponentDef = (() => {
  const b = new Builder(12, 12, 4);
  b.pins('swap', 'sync', 'clk');
  const one = b.op1(constWord(1, 1), []);
  const cnt = b.op(register(WK), ['', one, 'clk'], 'word address', 'addr');
  const pend = b.op(DFF, ['', 'clk'], 'flip pending', 'pending');
  const fr = b.op(DFF, ['', 'clk'], 'front frame', 'front');
  b.next();
  const inc = b.op(incrementer(WK), [`${cnt}.q`], 'next word');
  const cs = b.op(splitter(ones(WK)), [`${cnt}.q`]);
  const vs = b.name(b.op1(andN(WK), Array.from({ length: WK }, (_, i) => `${cs}.o${i}`), 'last word'), 'vsync', true);
  b.wire(`${inc}.y`, `${cnt}.d`);
  b.next();
  const flip = b.name(b.op1(AND, [`${pend}.q`, b.op1(OR, [vs, b.op1(NOT, ['sync'])], 'vsync, or no sync')], 'flip'), 'flip', true);
  b.next();
  b.wire(b.op1(AND, [b.op1(OR, [`${pend}.q`, 'swap'], 'asked'), b.op1(NOT, [flip])], 'still pending'), `${pend}.d`);
  b.wire(b.op1(XOR, [`${fr}.q`, flip], 'front ⊕ flip'), `${fr}.d`);
  b.wire(`${cnt}.q`, 'ra');
  b.wire(vs, 'vsync');
  b.wire(`${fr}.q`, 'front');
  const R = b.right;
  return define({
    id: 'scan_out', name: 'Scan-out', category: 'sequential',
    summary: `The display controller: a ${WK}-bit counter walks the front frame a word (four pixels) a cycle, ${FB_WORDS} cycles a frame; vsync marks the last word. `
      + 'swap asks for the other frame: with sync it flips at vsync, between two frames; without, at once, so one picture on the screen can be half old, half new (tearing).',
    ports: [bit('swap', 'in'), bit('sync', 'in'), bit('clk', 'in', 'bottom', true), bus('ra', WK, 'out'), bit('vsync', 'out'), bit('front', 'out')],
    symbol: { kind: 'box', label: 'SCAN-OUT' },
    netlist: () => ({ pins: { ...pinsAt(['swap', 'sync', 'clk'], 0, 6), ...pinsAt(['ra', 'vsync', 'front'], R, 6) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the chapter's tops -------------------------------------------------------------------------------

const topCache = new Map<string, ComponentDef>();

/** Framebuffers and scan-out only (chapter 30, step 1): two pictures in memory, flipped on request. */
export function displayTop(init0: ArrayLike<number>, init1: ArrayLike<number>): ComponentDef {
  const FB = frameBuffers(init0, init1);
  const key = `disp_${FB.id}`;
  const hit = topCache.get(key);
  if (hit) return hit;
  const b = new Builder(10, 14, 4);
  b.pins('swap', 'sync', 'clk');
  const sc = b.op(SCAN_OUT, ['swap', 'sync', 'clk'], 'scan-out', 'scan');
  const z = b.op1(constWord(12, 0), []), z8 = b.op1(constWord(8, 0), []);
  b.next();
  const fb = b.op(FB, [`${sc}.ra`, z, z8, b.op1(TIE0, []), `${sc}.front`, 'clk'], 'framebuffer', 'fb');
  b.next();
  b.wire(`${fb}.rq`, 'pixels');
  b.wire(`${sc}.vsync`, 'vsync');
  const R = b.right;
  const d: ComponentDef = {
    id: key, name: 'Framebuffer and scan-out', category: 'cpu',
    summary: 'Two frames in memory and the scan-out reading the front one, four pixels a cycle, to the screen.',
    ports: [bit('swap', 'in'), bit('sync', 'in'), bit('clk', 'in', 'bottom', true), bus('pixels', 32, 'out'), bit('vsync', 'out')],
    symbol: { kind: 'box', label: 'DISPLAY' },
    netlist: () => ({ pins: { ...pinsAt(['swap', 'sync', 'clk'], 0, 6), ...pinsAt(['pixels', 'vsync'], R, 8) }, instances: b.instances, nets: b.nets() }),
  };
  topCache.set(key, d);
  return d;
}

/** The rasterizer drawing into the back frame while the scan-out shows the front one (chapter 30, steps 2–3). */
export const GPU30: ComponentDef = (() => {
  const b = new Builder(10, 14, 4);
  b.pins(...VERTEX_PINS, 'col', 'go', 'swap', 'sync', 'clk');
  const r = b.op(RASTERIZER, [...VERTEX_PINS, 'col', 'go', 'clk'], 'rasterizer', 'rast');
  const sc = b.op(SCAN_OUT, ['swap', 'sync', 'clk'], 'scan-out', 'scan');
  b.next();
  const fb = b.op(frameBuffers(), [`${sc}.ra`, `${r}.fa`, `${r}.fd`, `${r}.fwe`, `${sc}.front`, 'clk'], 'framebuffer', 'fb');
  b.next();
  b.wire(`${fb}.rq`, 'pixels');
  b.wire(`${sc}.vsync`, 'vsync');
  b.wire(`${r}.busy`, 'busy');
  const R = b.right;
  return define({
    id: 'gpu30', name: 'Rasterizer, framebuffer, scan-out', category: 'cpu',
    summary: 'A triangle drawn into the back frame by the rasterizer, one pixel a cycle, while the scan-out sends the front frame to the screen; swap shows the new picture at the next vsync.',
    ports: [...VERTEX_PINS.map((p) => bus(p, CB, 'in')), bus('col', CB, 'in'), bit('go', 'in'), bit('swap', 'in'), bit('sync', 'in'), bit('clk', 'in', 'bottom', true),
      bus('pixels', 32, 'out'), bit('vsync', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'GPU' },
    netlist: () => ({ pins: { ...pinsAt([...VERTEX_PINS, 'col', 'go', 'swap', 'sync', 'clk'], 0, 6), ...pinsAt(['pixels', 'vsync', 'busy'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Chapter 30, steps 4–5: the rasterizer with depth, the depth test and blending, the double framebuffer, the scan-out. */
export const GPU30Z: ComponentDef = (() => {
  const RZ = rasterizer(true);
  const b = new Builder(10, 14, 4);
  const ins = [...VERTEX_PINS, 'z0', 'z1', 'z2', 'col', 'a', 'zt', 'clr', 'go', 'swap', 'sync', 'clk'];
  b.pins(...ins);
  const r = b.op(RZ, [...VERTEX_PINS, 'z0', 'z1', 'z2', 'col', 'clr', 'go', 'clk'], 'rasterizer', 'rast');
  const sc = b.op(SCAN_OUT, ['swap', 'sync', 'clk'], 'scan-out', 'scan');
  b.next();
  const rop = b.op(ROP, [`${r}.fa`, `${r}.fd`, `${r}.fz`, `${r}.fclr`, `${r}.fwe`, 'zt', 'a', '', 'clk'], 'depth test, blend', 'rop');
  b.next();
  const fb = b.op(frameBuffers(), [`${sc}.ra`, `${rop}.wa`, `${rop}.wd`, `${rop}.we`, `${sc}.front`, 'clk'], 'framebuffer', 'fb');
  b.wire(`${fb}.wq`, `${rop}.wq`);
  b.next();
  b.wire(`${fb}.rq`, 'pixels');
  b.wire(`${sc}.vsync`, 'vsync');
  b.wire(`${r}.busy`, 'busy');
  const R = b.right;
  return define({
    id: 'gpu30z', name: 'Rasterizer, depth, blend, framebuffer', category: 'cpu',
    summary: 'The rasterizer with depth, the depth test and blending between it and the back frame, the scan-out sending the front frame to the screen.',
    ports: [...VERTEX_PINS.map((p) => bus(p, CB, 'in')), bus('z0', CB, 'in'), bus('z1', CB, 'in'), bus('z2', CB, 'in'), bus('col', CB, 'in'), bus('a', 3, 'in'),
      bit('zt', 'in'), bit('clr', 'in'), bit('go', 'in'), bit('swap', 'in'), bit('sync', 'in'), bit('clk', 'in', 'bottom', true),
      bus('pixels', 32, 'out'), bit('vsync', 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'GPU' },
    netlist: () => ({ pins: { ...pinsAt(ins, 0, 6), ...pinsAt(['pixels', 'vsync', 'busy'], R, 8) }, instances: b.instances, nets: b.nets() }),
  });
})();
