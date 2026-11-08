// The CRT raster scan as parts (DOM-free, tested). Three things live here:
//  1. ScanRef: lib/raster.ts SCAN_OUT as five lines of arithmetic (tests/crt3d.test.ts holds it to the gates, every cycle).
//  2. The display timeline: Timing (the scan-out's own, or VGA's 640 x 480 @ 60 proportions scaled to 64 x 64) and
//     beamAt(), the beam's deflection at any instant; CrtRun, which clocks ScanRef on the cycles the beam is active and
//     lights the phosphor cell of each pixel the scan-out sends.
//  3. The tube: real-sized geometry in millimetres (neck 29.1 mm, 90 degrees, 4:3, yoke at the neck/funnel join) and the
//     parts of it, with the three beams bent from the gun through the yoke to the spot beamAt() says.
// World axes: x along the tube from the gun to the screen, y up, z across the screen (pixel x grows towards -z, so the
// picture reads left to right seen from the front).

import type { RGB } from '../gl/instances';
import { add3, cross3, dot3, len3, norm3, scale3, sub3, type Quat, type Vec3 } from '../gl/math';
import { box, rod, wire, type Anchor, type Part } from '../gl/parts';
import { rgb332 } from '../gfx/raster';

// ---------------------------------------------------------------- the scan-out, as arithmetic

export const W = 64, WORDS = 1024, ROW_WORDS = 16;

/** lib/raster.ts SCAN_OUT: a word-address counter, a pending flip, the front frame. out() is what the pins show before
 *  the next rising edge; step() is that edge. */
export class ScanRef {
  addr = 0; pend = 0; front = 0;
  out(): { ra: number; vsync: number; front: number } { return { ra: this.addr, vsync: this.addr === WORDS - 1 ? 1 : 0, front: this.front }; }
  step(swap: number, sync: number): void {
    const vs = this.addr === WORDS - 1 ? 1 : 0, flip = this.pend & (vs | (sync ? 0 : 1));
    this.pend = (this.pend | swap) & (flip ^ 1);
    this.front ^= flip;
    this.addr = (this.addr + 1) % WORDS;
  }
}

// ---------------------------------------------------------------- the display timeline

/** Pixel-clock counts of one line (pixels) and one frame (lines). A scan-out cycle is four pixel ticks (a word). */
export interface Timing { id: 'scanout' | 'vga'; hAct: number; hFp: number; hSync: number; hBp: number; vAct: number; vFp: number; vSync: number; vBp: number }
export const hTotal = (t: Timing) => t.hAct + t.hFp + t.hSync + t.hBp;
export const vTotal = (t: Timing) => t.vAct + t.vFp + t.vSync + t.vBp;
export const frameTicks = (t: Timing) => hTotal(t) * vTotal(t);

/** Our scan-out: a word a cycle, the cycle after word 1023 is word 0. No time is spent anywhere but on pixels. */
export const SCANOUT: Timing = { id: 'scanout', hAct: W, hFp: 0, hSync: 0, hBp: 0, vAct: W, vFp: 0, vSync: 0, vBp: 0 };
/** VGA 640 x 480 @ 59.94 Hz as published: 25.175 MHz, 800 x 525 (UW CSE467 / Columbia 4840 / Altium timing tables). */
export const VGA_FULL: Timing = { id: 'vga', hAct: 640, hFp: 16, hSync: 96, hBp: 48, vAct: 480, vFp: 10, vSync: 2, vBp: 33 };
export const VGA_PIXEL_CLOCK = 25.175e6;
/** The same proportions on our 64 x 64: 160/640 of blanking a line is 16 pixels (four words), 45/480 of a frame is
 *  6 lines; the porches and the sync pulse rounded to whole pixels / lines (a sync pulse is at least one line). */
export const VGA_SCALED: Timing = { id: 'vga', hAct: W, hFp: 2, hSync: 10, hBp: 4, vAct: W, vFp: 1, vSync: 1, vBp: 4 };
export const timingOf = (blanking: boolean): Timing => (blanking ? VGA_SCALED : SCANOUT);

export interface BeamPos {
  /** Deflection in pixel units: x in 0..64 across, y in 0..64 down (continuous: the pixel under the beam is floor of both). */
  x: number; y: number;
  blanked: boolean;
  phase: 'active' | 'hretrace' | 'vretrace';
  line: number; px: number;
  hsync: boolean; vsync: boolean;
  /** The scan-out word the beam is on (-1 while blanked) and the pixel index 0..4095 under it. */
  addr: number; pixel: number;
}

/**
 * Where the beam is at pixel tick `t` (fractional ticks: the sweep is continuous). Active: x = pixel position, y rises
 * by one line pitch per line (the vertical current is a ramp, so each line slopes by one pitch: floor(y) is the line).
 * Horizontal blanking: x returns linearly over the blanking (the real flyback is a half sine inside it). Vertical
 * blanking: y returns linearly over the blank lines while x keeps sweeping, all blanked.
 */
export function beamAt(tm: Timing, t: number): BeamPos {
  const HT = hTotal(tm), FT = frameTicks(tm), f = ((t % FT) + FT) % FT, line = Math.floor(f / HT), pxf = f - line * HT, px = Math.floor(pxf);
  const hAct = pxf < tm.hAct, vAct = line < tm.vAct;
  const x = hAct ? pxf : tm.hAct * (1 - (pxf - tm.hAct) / (HT - tm.hAct));
  const T0 = tm.vAct * HT;
  const y = vAct ? f / HT : tm.vAct * (1 - (f - T0) / (FT - T0));
  const active = hAct && vAct;
  const hs0 = tm.hAct + tm.hFp, vs0 = tm.vAct + tm.vFp;
  return {
    x, y, blanked: !active, phase: active ? 'active' : !vAct ? 'vretrace' : 'hretrace', line, px,
    hsync: px >= hs0 && px < hs0 + tm.hSync, vsync: line >= vs0 && line < vs0 + tm.vSync,
    addr: active ? line * ROW_WORDS + (px >> 2) : -1, pixel: active ? line * W + px : -1,
  };
}

/** Normalised yoke currents (-1..1, centre 0) for a beam position: the deflection is proportional to the current. */
export const yokeCurrent = (b: Pick<BeamPos, 'x' | 'y'>): { h: number; v: number } => ({ h: (b.x - W / 2) / (W / 2), v: (b.y - W / 2) / (W / 2) });

export const levelsOf = (v: number): RGB => { const [r, g, b] = rgb332(v); return [r / 255, g / 255, b / 255]; };

/** Persistence: a P22 phosphor fades in about a millisecond (an order of magnitude; sources vary), here as a share of a frame. */
export const REAL_FRAME_MS = 1000 / 59.94;
export const decayTicks = (tm: Timing, ms: number, scale = 1): number => ((ms * scale) / REAL_FRAME_MS) * frameTicks(tm);

export interface WordEvent { tick: number; ra: number; vsync: number; front: number; pixels: number[] }

/** The scan-out clocked on the cycles the beam is active, lighting a cell for each pixel it sends. */
export class CrtRun {
  tick = 0;
  scan = new ScanRef();
  swapReq = false; sync = 1;
  /** Tick each cell was last struck (-Infinity: never) and the RGB332 value it was struck with. */
  litAt = new Float64Array(W * W).fill(-Infinity);
  litCol = new Uint8Array(W * W);
  /** Scan-out edges clocked, and blanked display cycles on which the clock was held. */
  edges = 0; held = 0; frames = 0;
  lastWord: WordEvent | null = null;
  onWord?: (e: WordEvent) => void;
  constructor(public tm: Timing, public pics: readonly [Uint8Array, Uint8Array]) {}

  /** Process pixel ticks up to (not including) `to`. */
  advance(to: number): void {
    while (this.tick < to) {
      const tk = this.tick, b = beamAt(this.tm, tk), sub = tk & 3;
      if (!b.blanked) {
        const o = this.scan.out();
        if (sub === 0) {
          this.lastWord = { tick: tk, ra: o.ra, vsync: o.vsync, front: o.front, pixels: [0, 1, 2, 3].map((j) => this.pics[o.front][4 * o.ra + j]) };
          this.onWord?.(this.lastWord);
        }
        const p = 4 * o.ra + sub;
        this.litAt[p] = tk; this.litCol[p] = this.pics[o.front][p];
        if (sub === 3) {
          this.scan.step(this.swapReq ? 1 : 0, this.sync);
          this.swapReq = false; this.edges++;
          if (o.vsync) this.frames++;
        }
      } else if (sub === 0) this.held++;
      this.tick++;
    }
  }
  /** Cell i's glow at `now`: full when struck, fading exponentially with time constant tau. */
  glow(i: number, now: number, tau: number): number {
    const dt = now - this.litAt[i];
    return dt < 0 || dt === Infinity ? 0 : Math.exp(-dt / tau);
  }
  /** Back to power-on: nothing lit, the counter at word 0. */
  reset(): void {
    this.tick = 0; this.scan = new ScanRef(); this.swapReq = false;
    this.litAt.fill(-Infinity); this.litCol.fill(0);
    this.edges = 0; this.held = 0; this.frames = 0; this.lastWord = null;
  }
}

// ---------------------------------------------------------------- the tube

const rad = (d: number) => (d * Math.PI) / 180;
export const GEOM = (() => {
  const DIAG = 340, W_MM = DIAG * 0.8, H_MM = DIAG * 0.6; // 4:3 (a 14-inch-class tube: 13.4 in)
  const DEFLECT = 90; // full angle, to the corners
  const D = DIAG / 2 / Math.tan(rad(DEFLECT / 2)); // deflection centre to the screen
  return {
    DIAG, W_MM, H_MM, DEFLECT, D,
    NECK_OD: 29.1, NECK_R: 29.1 / 2,
    NECK_X0: -166, JOIN_X: -10,
    YOKE_X0: -40, YOKE_X1: 20,
    GUN_PITCH: 5.5, GUN_EXIT: -62,
    FUNNEL_X1: D - 6,
    /** The glass beyond the picture area, all round. */
    MARGIN: 16,
    ANODE_KV: [24, 32] as const,
    PINS: 10,
  };
})();

/** Where the spot is on the faceplate for a deflection (pixel units): [x, y, z] in mm. */
export const spotOf = (x: number, y: number): Vec3 => [GEOM.D, (0.5 - y / W) * GEOM.H_MM, (0.5 - x / W) * GEOM.W_MM];
/** The centre of cell i. */
export const cellCentre = (i: number): Vec3 => spotOf((i % W) + 0.5, Math.floor(i / W) + 0.5);

/** The funnel's cross-section at x: a superellipse from the round neck to the rectangular face. [half height, half width, exponent]. */
export function funnelSection(x: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (x - GEOM.JOIN_X) / (GEOM.FUNNEL_X1 - GEOM.JOIN_X)));
  const r0 = GEOM.NECK_R + 2;
  const g = t ** 0.7; // opens quickly behind the yoke, as a funnel does, to clear the 90 degree cone
  return [r0 + (GEOM.H_MM / 2 + GEOM.MARGIN - r0) * g, r0 + (GEOM.W_MM / 2 + GEOM.MARGIN - r0) * g, 2 + 6 * t * t];
}
/** A point (y, z) of the section at angle phi. */
export function sectionPoint(x: number, phi: number): [number, number] {
  const [a, b, n] = funnelSection(x), c = Math.cos(phi), s = Math.sin(phi);
  return [a * Math.sign(c) * Math.abs(c) ** (2 / n), b * Math.sign(s) * Math.abs(s) ** (2 / n)];
}
/** Is (y, z) inside the funnel's section at x? */
export function insideFunnel(x: number, y: number, z: number): boolean {
  if (x <= GEOM.JOIN_X) return Math.hypot(y, z) <= GEOM.NECK_R + 2;
  const [a, b, n] = funnelSection(x);
  return Math.abs(y / a) ** n + Math.abs(z / b) ** n <= 1;
}

/** One beam's path from the gun: straight in the neck, bent through the yoke's field (a quadratic curve whose tangents meet at
 *  the deflection centre), then straight from the yoke's front to the spot. zi: the beam's offset in the in-line gun. */
export function beamPath(zi: number, spot: Vec3): Vec3[] {
  const C: Vec3 = [0, 0, 0], d = sub3(spot, C), Q = scale3(d, GEOM.YOKE_X1 / d[0]);
  const P0: Vec3 = [GEOM.YOKE_X0 + 10, 0, 0];
  const pts: Vec3[] = [[GEOM.GUN_EXIT, 0, zi], [GEOM.GUN_EXIT + 20, 0, zi * 0.3], P0];
  const N = 8;
  for (let i = 1; i <= N; i++) {
    const u = i / N, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    pts.push([a * P0[0] + b * C[0] + c * Q[0], a * P0[1] + b * C[1] + c * Q[1], a * P0[2] + b * C[2] + c * Q[2]]);
  }
  pts.push(spot);
  return pts;
}

export interface CrtPalette {
  glass: RGB; aquadag: RGB; copper: RGB; ferrite: RGB; metal: RGB; pin: RGB; cellOff: RGB; mask: RGB; heater: RGB; ghost: RGB; bezel: RGB;
}
export interface CrtPose {
  /** The beam now (null: not drawn). */
  beam: BeamPos | null;
  /** The levels the three guns are driven at (0..1) while the beam is on. */
  levels: RGB;
  /** Cell i's colour as the eye sees it (already faded). */
  cell: (i: number) => RGB;
  /** Normalised yoke currents. */
  current: { h: number; v: number };
  /** The flat fallback: 32 x 32 cells. */
  bin?: 1 | 2;
}

/** The unit quaternion turning the box axes (x, y, z) to the orthonormal basis columns (ex, ey, ez). */
function quatOfBasis(ex: Vec3, ey: Vec3, ez: Vec3): Quat {
  const m00 = ex[0], m10 = ex[1], m20 = ex[2], m01 = ey[0], m11 = ey[1], m21 = ey[2], m02 = ez[0], m12 = ez[1], m22 = ez[2];
  const tr = m00 + m11 + m22;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; return [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; return [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; return [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
}

type RGBA4 = [number, number, number, number];
/** A thin panel between four points (a skin of the funnel), as one box. */
function panel(c: RGBA4, a: Vec3, b: Vec3, c2: Vec3, d: Vec3, th: number): Part {
  const mid = scale3(add3(add3(a, b), add3(c2, d)), 0.25);
  const e = sub3(scale3(add3(b, c2), 0.5), scale3(add3(a, d), 0.5)); // across, from the a-d side to the b-c side
  const s = sub3(scale3(add3(d, c2), 0.5), scale3(add3(a, b), 0.5)); // along the slice
  const ex = norm3(e), ez = norm3(sub3(s, scale3(ex, dot3(s, ex)))), ey = cross3(ez, ex);
  return { kind: 'box', pos: mid, scale: [len3(e), th, len3(s)], rot: quatOfBasis(ex, ey, ez), color: c, spec: 0.15 };
}

const FUNNEL_SLICES = 9, FUNNEL_SIDES = 28;
const lit = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const alpha = (c: RGB, a: number): RGBA4 => [c[0], c[1], c[2], a];

/** The structure that never moves (the tube glass, gun, yoke, mask); only the yoke's glow follows the pose. */
export function staticParts(P: CrtPalette, current: { h: number; v: number } = { h: 0, v: 0 }): Part[] {
  const out: Part[] = [], G = GEOM;
  // Neck glass and stem
  out.push(rod(alpha(P.glass, 0.16), [G.NECK_X0 + 8, 0, 0], [G.JOIN_X, 0, 0], G.NECK_R));
  out.push(rod(P.glass, [G.NECK_X0, 0, 0], [G.NECK_X0 + 6, 0, 0], G.NECK_R - 1, 0.2));
  for (let i = 0; i < G.PINS; i++) {
    const th = (i / G.PINS) * 2 * Math.PI, y = 11 * Math.cos(th), z = 11 * Math.sin(th);
    out.push(rod(P.pin, [G.NECK_X0 + 2, y, z], [G.NECK_X0 - 18, y, z], 0.55, 0.4));
  }
  // The in-line gun: three cathodes with heaters, G1, G2, the focus electrodes G3-G5, the final anode G6.
  const s = G.GUN_PITCH, zs = [-s, 0, s];
  const plate = (x0: number, x1: number, hz = 9.5, hy = 5.5, th = 0.7) => [box(P.metal, x0, x1, hy - th, hy, -hz, hz, 0.4), box(P.metal, x0, x1, -hy, -hy + th, -hz, hz, 0.4)];
  const apertured = (x: number, th: number, r = 1.1) => { // an end plate with three holes (the gaps between its pieces)
    const edges = [-9.5, ...zs.flatMap((z) => [z - r, z + r]), 9.5];
    const pcs: Part[] = [];
    for (let k = 0; k < edges.length; k += 2) pcs.push(box(P.metal, x - th / 2, x + th / 2, -5.5, 5.5, edges[k], edges[k + 1], 0.4));
    return pcs;
  };
  for (const z of zs) out.push(rod(P.metal, [-151, 0, z], [-146, 0, z], 1.7, 0.4), { ...rod(P.heater, [-153, 0, z], [-151, 0, z], 0.7), emissive: lit(P.heater, 0.7) });
  out.push(...apertured(-144, 0.8), ...apertured(-141, 0.8));                          // G1, G2
  out.push(...plate(-139, -117), ...apertured(-117, 0.8), ...plate(-115, -114));         // G3 (focus), G4
  out.push(...plate(-112, -88), ...plate(-86, -62, 9.8, 5.8), ...apertured(-86, 0.8)); // G5, G6 (final anode, the main lens)
  for (const x of [-144, -141, -117, -112, -86]) out.push(rod(P.metal, [x, 5.5, -9.5], [x, 11.4, -9.5], 0.35, 0.3)); // support rods to the glass beads
  // Funnel skin: aquadag (translucent so the beam shows), the first slice bare glass under the yoke.
  const xs = Array.from({ length: FUNNEL_SLICES + 1 }, (_, i) => G.JOIN_X + ((G.FUNNEL_X1 - G.JOIN_X) * i) / FUNNEL_SLICES);
  const ring = (x: number) => Array.from({ length: FUNNEL_SIDES + 1 }, (_, i): Vec3 => { const [y, z] = sectionPoint(x, (i / FUNNEL_SIDES) * 2 * Math.PI + 0.0001); return [x, y, z]; });
  const rings = xs.map(ring);
  for (let k = 0; k < FUNNEL_SLICES; k++) {
    for (let i = 0; i < FUNNEL_SIDES; i++) out.push(panel(k === 0 ? alpha(P.glass, 0.22) : alpha(P.aquadag, 0.5), rings[k][i], rings[k][i + 1], rings[k + 1][i + 1], rings[k + 1][i], 1.6));
  }
  // Anode button on the top of the funnel
  const ab = sectionPoint(70, 0);
  out.push(rod(P.pin, [70, ab[0], ab[1]], [70, ab[0] + 14, ab[1]], 7, 0.3), rod(P.metal, [70, ab[0] + 14, ab[1]], [70, ab[0] + 22, ab[1]], 1.8, 0.5));
  // Faceplate glass, its bezel, the shadow mask behind it
  const hw = G.W_MM / 2, hh = G.H_MM / 2, M = G.MARGIN;
  out.push(box(alpha(P.glass, 0.14), G.D + 1, G.D + 13, -hh - M, hh + M, -hw - M, hw + M));
  out.push(box(P.bezel, G.D - 2, G.D + 14, hh + M, hh + M + 4, -hw - M - 4, hw + M + 4), box(P.bezel, G.D - 2, G.D + 14, -hh - M - 4, -hh - M, -hw - M - 4, hw + M + 4),
    box(P.bezel, G.D - 2, G.D + 14, -hh - M, hh + M, hw + M, hw + M + 4), box(P.bezel, G.D - 2, G.D + 14, -hh - M, hh + M, -hw - M - 4, -hw - M));
  out.push(box(alpha(P.mask, 0.3), G.D - 14.4, G.D - 14, -hh - 3, hh + 3, -hw - 3, hw + 3, 0.2));
  out.push(...yokeParts(P, current));
  return out;
}

/** The deflection yoke: a ferrite ring, the horizontal coils above and below the neck (their field is vertical, so they
 *  deflect sideways) and the vertical coils at its sides, saddle-shaped, copper. The glow follows |current|. */
export function yokeParts(P: CrtPalette, cur: { h: number; v: number }): Part[] {
  const G = GEOM, out: Part[] = [], SEG = 18;
  for (let i = 0; i < SEG; i++) {
    const th = ((i + 0.5) / SEG) * 2 * Math.PI, x0 = -2, x1 = G.YOKE_X1 - 2, xm = (x0 + x1) / 2;
    const [y, z] = sectionPoint(xm, th), r = Math.hypot(y, z) + 12;
    const ex: Vec3 = [1, 0, 0], ez: Vec3 = [0, -Math.sin(th), Math.cos(th)], ey = cross3(ez, ex);
    out.push({ kind: 'box', pos: [xm, r * Math.cos(th), r * Math.sin(th)], scale: [x1 - x0, 7, ((2 * Math.PI * r) / SEG) * 0.92], rot: quatOfBasis(ex, ey, ez), color: P.ferrite, spec: 0.1 });
  }
  const coil = (centre: number, half: number, turns: number, outer: number): Part[] => {
    const cp: Part[] = [];
    for (let t = 0; t < turns; t++) {
      const al = rad(half - t * 4), ofs = 3 + t * 1.3 + outer * 5, xb = G.YOKE_X0 + t * 1.5, xf = G.YOKE_X1 - 6 - t * 1.5;
      const rAt = (x: number, th: number) => (x <= G.JOIN_X ? G.NECK_R + 2.5 + ofs : Math.hypot(...sectionPoint(x, th)) + ofs);
      const at = (x: number, th: number): Vec3 => { const r = rAt(x, th); return [x, r * Math.cos(th), r * Math.sin(th)]; };
      const pts: Vec3[] = [];
      for (let i = 0; i <= 6; i++) pts.push(at(xb + ((xf - xb) * i) / 6, centre - al));
      for (let i = 1; i <= 8; i++) pts.push(at(xf, centre - al + (2 * al * i) / 8));
      for (let i = 1; i <= 6; i++) pts.push(at(xf + ((xb - xf) * i) / 6, centre + al));
      for (let i = 1; i <= 8; i++) pts.push(at(xb, centre + al - (2 * al * i) / 8));
      cp.push(...wire(P.copper, pts, 0.7, 0.3));
    }
    return cp;
  };
  const glow = (c: number): RGB => lit([1, 0.45, 0.15], 0.6 * Math.min(1, Math.abs(c)));
  for (const c of [0, Math.PI]) for (const p of coil(c, 48, 3, 0)) out.push({ ...p, emissive: glow(cur.h) });
  for (const c of [Math.PI / 2, -Math.PI / 2]) for (const p of coil(c, 48, 3, 1)) out.push({ ...p, emissive: glow(cur.v) });
  return out;
}

/** The phosphor cells and the beams for one pose. */
export function poseParts(P: CrtPalette, pose: CrtPose): Part[] {
  const G = GEOM, out: Part[] = [], B = pose.bin ?? 1, n = W / B, cw = (G.W_MM / n) * 0.94, ch = (G.H_MM / n) * 0.94;
  for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < B; dy++) for (let dx = 0; dx < B; dx++) { const c = pose.cell((cy * B + dy) * W + cx * B + dx); r = Math.max(r, c[0]); g = Math.max(g, c[1]); b = Math.max(b, c[2]); }
    const zc = (0.5 - (cx + 0.5) / n) * G.W_MM, yc = (0.5 - (cy + 0.5) / n) * G.H_MM;
    const col: RGB = [P.cellOff[0] + (1 - P.cellOff[0]) * r * 0.9, P.cellOff[1] + (1 - P.cellOff[1]) * g * 0.9, P.cellOff[2] + (1 - P.cellOff[2]) * b * 0.9];
    out.push({ ...box(col, G.D - 0.6, G.D, yc - ch / 2, yc + ch / 2, zc - cw / 2, zc + cw / 2), emissive: [r * 0.55, g * 0.55, b * 0.55] });
  }
  const bm = pose.beam;
  if (bm) {
    const spot = spotOf(bm.x, bm.y);
    if (bm.blanked) out.push(...wire([P.ghost[0], P.ghost[1], P.ghost[2], 0.35] as RGBA4, beamPath(0, spot), 0.8));
    else {
      const cols: RGB[] = [[1, 0.15, 0.12], [0.2, 1, 0.25], [0.25, 0.4, 1]]; // R, G, B guns, in order along z
      [-G.GUN_PITCH, 0, G.GUN_PITCH].forEach((z, k) => {
        const lv = pose.levels[k];
        if (lv <= 0.001) return;
        for (const p of wire([cols[k][0], cols[k][1], cols[k][2], 0.9] as RGBA4, beamPath(z, spot), 0.9 + 0.9 * lv)) out.push({ ...p, emissive: lit(cols[k], 0.4 + 0.5 * lv) });
      });
    }
  }
  return out;
}

export type CrtDetail = 'overview' | 'gun' | 'yoke';

/** Labels for what the camera is on: a few for the whole tube, the electrodes up close at the gun, the coils at the yoke. */
export function crtAnchors(detail: CrtDetail = 'overview'): Anchor[] {
  const G = GEOM, right: Vec3 = [0, 0, 1], up: Vec3 = [0, 1, 0], front: Vec3 = [1, 0, 0], down: Vec3 = [0, -1, 0];
  if (detail === 'gun') {
    return [
      { text: 'cathodes + heaters', p: [-150, 0, -5.5], side: 'l', n: right },
      { text: 'G1 grid', p: [-144, 5.5, 9.5], side: 't', n: right },
      { text: 'G2 screen grid', p: [-141, -5.5, 9.5], side: 'b', n: right },
      { text: 'G3–G5 focus', p: [-100, 5.5, -9.5], side: 't', n: right },
      { text: 'G6 final anode', p: [-74, -5.8, 9.8], side: 'b', n: right },
      { text: 'neck, 29.1 mm', p: [-125, -G.NECK_R, 0], side: 'b', n: down },
      { text: 'stem, 10 pins', p: [G.NECK_X0 - 10, 11, 0], side: 'l', n: up },
    ];
  }
  if (detail === 'yoke') {
    const fe = sectionPoint(9, 0);
    return [
      { text: 'horizontal coils (sweep)', p: [-20, G.NECK_R + 8, 0], side: 't', n: up },
      { text: 'vertical coils (step)', p: [-20, 0, G.NECK_R + 14], side: 'r', n: right },
      { text: 'ferrite core', p: [9, fe[0] + 15.5, 0], side: 't', n: up },
      { text: 'neck / funnel join', p: [G.JOIN_X, -G.NECK_R - 2, 0], side: 'b', n: down },
      { text: 'aquadag funnel', p: [60, sectionPoint(60, Math.PI)[0], sectionPoint(60, Math.PI)[1]], side: 'b', n: down },
    ];
  }
  const fn = sectionPoint(90, Math.PI), an = sectionPoint(70, 0);
  return [
    { text: 'electron gun', p: [-100, -5.5, 9.5], side: 'b', n: right },
    { text: 'deflection yoke', p: [0, 42, 0], side: 't', n: up },
    { text: 'funnel, aquadag', p: [90, fn[0], fn[1]], side: 'b', n: right },
    { text: 'phosphor screen', p: [G.D, -G.H_MM / 2, 0], side: 'b', n: front },
    { text: 'anode button', p: [70, an[0] + 22, 0], side: 't', n: up },
    { text: 'shadow mask', p: [G.D - 14, G.H_MM / 2, G.W_MM / 2], side: 'r', n: front, minor: true },
  ];
}
