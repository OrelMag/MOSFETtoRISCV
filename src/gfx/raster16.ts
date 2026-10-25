// The campaign's rasterizer (act 9: k_edge, k_tile, k_raster, k_frame), as plain arithmetic: chapter 33's edge
// functions, top-left rule and tile walk (gfx/raster.ts) at RV16 sizes. Vertices are 7-bit quarter pixels on a
// 32 × 32 screen, so every E fits 16 bits (|E| ≤ 2·127² = 32 258), and the tiles are 0 … 7 each way. The set-up has
// no multiplier: each stepper's own adder computes its E at the first tile by shift-and-add (18 cycles), then one
// cycle culls back faces from the sum of the three E (twice the area), and the walk starts. No DOM.

import { CMD, rasterize, setup, tilePixel, type Vtx } from './raster';

export const SCREEN16 = 32;
/** The screen in the RV16 data memory: pixel (x, y) is the word FB16 + 32·y + x, RGB565. */
export const FB16 = 0xf000;
/** The rasterizer's registers (lane 0's stores): v0x, v0y, v1x, v1y, v2x, v2y at RAST16 … RAST16 + 5; the colour at RAST16 + 6 starts it. */
export const RAST16 = 0xfff0;
/** Busy cycles of the set-up: load, 17 shift-and-add steps, the cull. The first TEST is in the next cycle. */
export const SETUP16 = 19;

/** Stepper commands: chapter 33's, and double (E ← 2E + a) for the set-up's shift-and-add. */
export const CMD16 = { ...CMD, double: 7 } as const;

const w16 = (v: number) => ((v % 0x10000) + 0x10000) % 0x10000;
const s16 = (v: number) => { const x = w16(v); return x >= 0x8000 ? x - 0x10000 : x; };

/** The edge stepper (k_edge): E and the band start R, 16 bits, one command a cycle. */
export class Edge16 {
  e = 0;
  r = 0;
  /** inside: E ≥ 0. */
  get inside(): number { return this.e >= 0 ? 1 : 0; }
  step(cmd: number, a: number, b: number, e0: number): void {
    const A = s16(a), B = s16(b);
    switch (cmd) {
      case CMD16.load: this.e = this.r = s16(e0); break;
      case CMD16.right: this.e = s16(this.e + A); break;
      case CMD16.skip: this.e = s16(this.e + 4 * A); break;
      case CMD16.down: this.e = s16(this.e + B); break;
      case CMD16.up: this.e = s16(this.e - B); break;
      case CMD16.band: this.e = this.r = s16(this.r + 4 * B); break;
      case CMD16.double: this.e = s16(2 * this.e + A); break;
      default: break;
    }
  }
}

export interface TileOut { x: number; y: number; cmd: number; test: number; pix: number; busy: number }

/**
 * The tile walk (k_tile): bands of 4 × 4 tiles over tx0 … tx1, ty0 … ty1 (held while busy). go while idle: the next
 * cycle is the first tile's TEST at its top-left pixel. TEST: ok → its 16 pixels follow, column by column (down,
 * up, down, up), ending at the top-right pixel; not ok → skip (+4a) to the next tile, or band to the next band's
 * first. After the last pixel: right to the next tile, or band. The last tile done, it goes idle.
 */
export class Walk16 {
  busy = 0;
  tx = 0;
  ty = 0;
  /** 0: TEST; 1 … 16: pixel k − 1. */
  ph = 0;
  out(box: { tx0: number; tx1: number; ty0: number; ty1: number }, ok: number): TileOut {
    if (!this.busy) return { x: 0, y: 0, cmd: CMD16.hold, test: 0, pix: 0, busy: 0 };
    const test = this.ph === 0 ? 1 : 0, k = this.ph - 1;
    const [c, r] = test ? [0, 0] : tilePixel(k);
    const next = () => (this.tx < box.tx1 ? CMD16.right : this.ty < box.ty1 ? CMD16.band : CMD16.hold);
    let cmd: number;
    if (test) cmd = ok ? CMD16.hold : this.tx < box.tx1 ? CMD16.skip : this.ty < box.ty1 ? CMD16.band : CMD16.hold;
    else if (k === 15) cmd = next();
    else if ((k & 3) === 3) cmd = CMD16.right;
    else cmd = c & 1 ? CMD16.up : CMD16.down;
    return { x: 4 * this.tx + c, y: 4 * this.ty + r, cmd, test, pix: test ? 0 : 1, busy: 1 };
  }
  /** The clock edge. */
  edge(box: { tx0: number; tx1: number; ty0: number; ty1: number }, go: number, ok: number, rst: number): void {
    if (rst) { this.busy = 0; return; }
    if (!this.busy) {
      if (go) { this.busy = 1; this.tx = box.tx0; this.ty = box.ty0; this.ph = 0; }
      return;
    }
    const tileDone = (this.ph === 0 && !ok) || this.ph === 16;
    if (!tileDone) { this.ph++; return; }
    this.ph = 0;
    if (this.tx < box.tx1) this.tx++;
    else if (this.ty < box.ty1) { this.tx = box.tx0; this.ty++; }
    else this.busy = 0;
  }
}

export interface Write16 { cycle: number; x: number; y: number }
export interface Raster16Run { writes: Write16[]; cycles: number; front: boolean }

/** A triangle on the campaign's rasterizer: its pixel writes (cycle counted from the cycle that saw go) and busy cycles. */
export function rasterize16(v: Vtx[]): Raster16Run {
  if (v.some(([x, y]) => x < 0 || x > 127 || y < 0 || y > 127)) throw new Error('vertices are 7-bit quarter pixels');
  const r = rasterize(v);
  if (!r.setup.front) return { writes: [], cycles: SETUP16, front: false };
  // chapter 33's walk starts at cycle 9; here after the 19 set-up cycles
  const d = SETUP16 + 1 - 9;
  return { writes: r.writes.map((w) => ({ cycle: w.cycle + d, x: w.x, y: w.y })), cycles: r.cycles + d, front: true };
}

/** The set-up's values for the hardware: per edge A, B, the bias, the tile test's offset; the box in tiles. */
export function setup16(v: Vtx[]) {
  return setup(v);
}

/** Draw a triangle into a 32 × 32 RGB565 frame (index 32·y + x). */
export function draw16(fb: Uint16Array, v: Vtx[], col: number): Raster16Run {
  const r = rasterize16(v);
  for (const w of r.writes) fb[SCREEN16 * w.y + w.x] = col & 0xffff;
  return r;
}

/** RGB565 → CSS rgb components. */
export function rgb565(c: number): [number, number, number] {
  return [Math.round(((c >> 11) & 31) * 255 / 31), Math.round(((c >> 5) & 63) * 255 / 63), Math.round((c & 31) * 255 / 31)];
}

export { w16, s16 };
