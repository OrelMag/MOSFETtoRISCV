// The rasterizer's reference model (chapter 30): what the gate-level block in lib/raster.ts computes, cycle by
// cycle, in plain arithmetic. DOM-free; the tests run the hardware against it.
//
// Coordinates are in quarter pixels (8 bits: 0 … 255 on a 64 × 64 screen); pixel (x, y)'s centre is at
// (4x + 2, 4y + 2). Edge i runs from vertex i to vertex i + 1, anchored at vertex i:
//   E_i(p) = A_i·(p.x − v_i.x) + B_i·(p.y − v_i.y),  A_i = v_i.y − v_{i+1}.y,  B_i = v_{i+1}.x − v_i.x.
// The three add up to twice the signed area everywhere. A front face (area > 0: clockwise on a screen whose y
// grows downward) has every E ≥ 0 inside; a back face or a degenerate triangle is culled. Top-left rule: an
// edge that is neither left (A > 0) nor top (A = 0, B > 0) loses 1 (bias), so a pixel centre exactly on an edge
// shared by two triangles is drawn by one of them only. Worst case |E| = 2·255·255 + 1 = 130 051: 18 bits.
//
// Timing (one state per clock cycle): idle → set-up S1 … S8 (one product each on a shared multiplier: the
// area, then each edge's value at the first tile's top-left pixel) → the tile walk. Tiles are 4 × 4 pixels,
// walked in bands of four rows; a band's tiles left to right. TEST (one cycle at a tile's top-left pixel): if
// some edge is negative at the tile's best corner the tile is skipped (+4·dx, or the next band), else its 16
// pixels follow, one a cycle, column by column (down, up, down, up), ending at the top-right pixel, one step
// from the next tile. A pixel is written when all three edges are ≥ 0.

export const FB_W = 64;
/** Edge values: 18-bit two's complement. */
export const EDGE_BITS = 18;
const MOD = 2 ** EDGE_BITS;

export type Vtx = [number, number];

/** Stepper commands (the walk's cmd bus). */
export const CMD = { hold: 0, load: 1, right: 2, skip: 3, down: 4, up: 5, band: 6 } as const;

/** Two's complement wrap to `bits` bits (as the hardware's registers hold it). */
export const wrap = (v: number, bits = EDGE_BITS) => {
  const m = 2 ** bits, r = ((v % m) + m) % m;
  return r >= m / 2 ? r - m : r;
};

export interface Setup {
  A: number[];
  B: number[];
  /** 1 for an edge that is neither left nor top. */
  bias: number[];
  /** Twice the signed area, in quarter pixels squared. */
  area2: number;
  front: boolean;
  /** Tile bounds (tiles of 4 × 4 pixels), inclusive. */
  tx0: number;
  tx1: number;
  ty0: number;
  ty1: number;
  /** The first tile's top-left pixel centre, quarter pixels. */
  ox: number;
  oy: number;
  /** Per edge: E at (ox, oy) with the bias, per-pixel steps 4A and 4B, and the tile test's offset. */
  e0: number[];
  dx: number[];
  dy: number[];
  off: number[];
}

const pos = (v: number) => Math.max(0, v);

export function setup(v: Vtx[]): Setup {
  const A = [0, 1, 2].map((i) => v[i][1] - v[(i + 1) % 3][1]);
  const B = [0, 1, 2].map((i) => v[(i + 1) % 3][0] - v[i][0]);
  const bias = A.map((a, i) => (a > 0 || (a === 0 && B[i] > 0) ? 0 : 1));
  const area2 = A[0] * (v[2][0] - v[0][0]) + B[0] * (v[2][1] - v[0][1]);
  const xs = v.map((p) => p[0]), ys = v.map((p) => p[1]);
  // First pixel column whose centre is ≥ min x: ⌈(min − 2) / 4⌉ = (min + 1) >> 2; its tile: (min + 1) >> 4.
  // Last: ⌊(max − 2) / 4⌋, its tile (max − 2) >> 4 (0 when max < 2: a tile walked for nothing).
  const tx0 = (Math.min(...xs) + 1) >> 4, tx1 = Math.max(Math.max(...xs) - 2, 0) >> 4;
  const ty0 = (Math.min(...ys) + 1) >> 4, ty1 = Math.max(Math.max(...ys) - 2, 0) >> 4;
  const ox = 16 * tx0 + 2, oy = 16 * ty0 + 2;
  const e0 = [0, 1, 2].map((i) => A[i] * (ox - v[i][0]) + B[i] * (oy - v[i][1]) - bias[i]);
  return {
    A, B, bias, area2, front: area2 > 0, tx0, tx1, ty0, ty1, ox, oy, e0,
    dx: A.map((a) => 4 * a), dy: B.map((b) => 4 * b), off: A.map((a, i) => 12 * pos(a) + 12 * pos(B[i])),
  };
}

export interface PixelWrite {
  /** Cycle of the write, counted from the cycle that saw go (0). */
  cycle: number;
  x: number;
  y: number;
}

export interface RasterRun {
  setup: Setup;
  /** Cycles with busy = 1 (the cycle that sees go is not one: busy rises after it). */
  cycles: number;
  writes: PixelWrite[];
  tiles: number;
  /** Tiles that passed the test (walked). */
  walked: number;
}

/** The pixels a triangle covers, in the order the hardware writes them, and its cycle count (depth: the rasterizer
 * with the depth set-up, whose walk starts later). */
export function rasterize(v: Vtx[], depth = false): RasterRun {
  const s = setup(v);
  const writes: PixelWrite[] = [];
  // go is seen in cycle 0; S1 … S8 are cycles 1 … 8; a back face stops after S3.
  if (!s.front) return { setup: s, cycles: 3, writes, tiles: 0, walked: 0 };
  let cycle = depth ? Z_WALK_START : 9, tiles = 0, walked = 0;
  const E = (i: number, x: number, y: number) => s.A[i] * (4 * x + 2 - v[i][0]) + s.B[i] * (4 * y + 2 - v[i][1]) - s.bias[i];
  for (let ty = s.ty0; ty <= s.ty1; ty++) {
    for (let tx = s.tx0; tx <= s.tx1; tx++) {
      tiles++;
      const ok = [0, 1, 2].every((i) => E(i, 4 * tx, 4 * ty) + s.off[i] >= 0);
      cycle++;
      if (!ok) continue;
      walked++;
      for (let k = 0; k < 16; k++) {
        const c = k >> 2, j = k & 3, r = c & 1 ? 3 - j : j;
        const x = 4 * tx + c, y = 4 * ty + r;
        if ([0, 1, 2].every((i) => E(i, x, y) >= 0)) writes.push({ cycle, x, y });
        cycle++;
      }
    }
  }
  return { setup: s, cycles: cycle - 1, writes, tiles, walked };
}

/** The pixel walk order inside a tile: pixel k (0 … 15) → its column and row. */
export function tilePixel(k: number): [number, number] {
  const c = k >> 2, j = k & 3;
  return [c, c & 1 ? 3 - j : j];
}

/** Draw into a 64 × 64 byte framebuffer (index y·64 + x). */
export function drawInto(fb: Uint8Array, v: Vtx[], col: number): RasterRun {
  const r = rasterize(v);
  for (const w of r.writes) fb[w.y * FB_W + w.x] = col & 255;
  return r;
}

export { MOD as EDGE_MOD };

// ---- depth and blending (chapter 30, steps 4–5) ---------------------------------------------------------
//
// z is given per vertex (8 bits, 0 near … 255 far) and is linear across the triangle, a plane like the edges:
//   z(p) = z0 + Zx·(p.x − x0) + Zy·(p.y − y0)   (per quarter pixel, Z_FRAC fraction bits)
//   Zx = (A0·(z2 − z0) + A2·(z1 − z0)) / area2,  Zy = (B0·(z2 − z0) + B2·(z1 − z0)) / area2
// (the barycentric weights E1, E2, E0 / area2 of v0, v1, v2, differentiated). Set-up computes both slopes with a
// divider (quotient truncated toward zero), and z at the first tile by shift-and-add; the walk steps it like an
// edge. All of it is 32-bit two's complement, wrapping: the value at a pixel inside the triangle is right even
// when a thin triangle's slope is huge. The depth buffer keeps z >> 4 as 16 bits (8.8), clamped to 0 … 0xFFFF.
// A pixel passes the depth test when its z is less than the buffer's (nearer); clear writes 0xFFFF.

export const Z_FRAC = 12;
const wrap32 = (v: number) => wrap(v, 32);

export interface ZPlane { nx: number; ny: number; zx: number; zy: number; zOrg: number }

export function zPlane(v: Vtx[], z: number[]): ZPlane {
  const s = setup(v);
  const d1 = z[1] - z[0], d2 = z[2] - z[0];
  const nx = s.A[0] * d2 + s.A[2] * d1, ny = s.B[0] * d2 + s.B[2] * d1;
  const div = (n: number) => wrap32(Math.sign(n) * Math.floor((Math.abs(n) * 2 ** Z_FRAC) / s.area2));
  const zx = div(nx), zy = div(ny);
  // z at the first tile's top-left pixel centre: products in 32 bits, wrapping
  const mul = (a: number, b: number) => wrap32(Number((BigInt(a) * BigInt(b)) % 2n ** 32n));
  const zOrg = wrap32(z[0] * 2 ** Z_FRAC + mul(zx, s.ox - v[0][0]) + mul(zy, s.oy - v[0][1]));
  return { nx, ny, zx, zy, zOrg };
}

/** z at pixel (x, y), 32-bit, as the stepper holds it. */
export function zAt(v: Vtx[], z: number[], x: number, y: number): number {
  const s = setup(v), p = zPlane(v, z);
  const mul = (a: number, b: number) => wrap32(Number((BigInt(a) * BigInt(b)) % 2n ** 32n));
  return wrap32(p.zOrg + mul(p.zx, 4 * x + 2 - s.ox) + mul(p.zy, 4 * y + 2 - s.oy));
}

/** The depth buffer's 16-bit form of a 32-bit z: z >> 4, 0 when negative, 0xFFFF when too large. */
export function zStore(z32: number): number {
  if (z32 < 0) return 0;
  const q = Math.floor(z32 / 16);
  return q > 0xffff ? 0xffff : q;
}

/** With the depth set-up (about 80 cycles: four products, two 30-bit divisions, ten shift-and-add steps), the walk's
 * first TEST is in this cycle, counted from go, instead of 9. */
export const Z_WALK_START = 85;

/** Clear (go with clr): every tile of the screen, every pixel, in the walk's order; its cycle count. */
export const CLEAR_CYCLES = Z_WALK_START - 1 + (FB_W / 4) ** 2 * 17;

/** Alpha blending in RGB332, alpha a in eighths minus one (7: opaque): each channel (s·(a + 1) + d·(7 − a)) >> 3. */
export function blend332(s: number, d: number, a: number): number {
  const ch = (sh: number, w: number) => {
    const m = (1 << w) - 1, sc = (s >> sh) & m, dc = (d >> sh) & m;
    return (((sc * (a + 1) + dc * (7 - a)) >> 3) & m) << sh;
  };
  return ch(5, 3) | ch(2, 3) | ch(0, 2);
}

export interface DrawOp {
  v: Vtx[];
  col: number;
  z?: number[];
  /** Alpha, 0 … 7 (7: opaque). */
  a?: number;
  /** Depth test on. */
  zt?: boolean;
  /** Clear: every pixel ← col, depth ← 0xFFFF. */
  clr?: boolean;
}

/** The reference framebuffer and depth buffer, drawn into as the hardware does. */
export class RefFrame {
  fb = new Uint8Array(FB_W * FB_W);
  zb = new Uint16Array(FB_W * FB_W).fill(0xffff);
  draw(op: DrawOp): void {
    if (op.clr) {
      this.fb.fill(op.col & 255);
      this.zb.fill(0xffff);
      return;
    }
    const z = op.z ?? [0, 0, 0], a = op.a ?? 7;
    for (const w of rasterize(op.v).writes) {
      const i = w.y * FB_W + w.x, zs = zStore(zAt(op.v, z, w.x, w.y));
      if (op.zt && !(zs < this.zb[i])) continue;
      this.fb[i] = blend332(op.col, this.fb[i], a);
      if (op.zt) this.zb[i] = zs;
    }
  }
}
