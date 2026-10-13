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

/** The pixels a triangle covers, in the order the hardware writes them, and its cycle count. */
export function rasterize(v: Vtx[]): RasterRun {
  const s = setup(v);
  const writes: PixelWrite[] = [];
  // go is seen in cycle 0; S1 … S8 are cycles 1 … 8; a back face stops after S3.
  if (!s.front) return { setup: s, cycles: 3, writes, tiles: 0, walked: 0 };
  let cycle = 9, tiles = 0, walked = 0;
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
