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
export interface Timing {
  id: 'scanout' | 'vga' | 'ntsc'; hAct: number; hFp: number; hSync: number; hBp: number; vAct: number; vFp: number; vSync: number; vBp: number;
  /** 2: interlaced. The v* counts are then those of one field (vAct: the lines drawn in it), and a frame is two fields. */
  fields?: 1 | 2;
}
export const hTotal = (t: Timing) => t.hAct + t.hFp + t.hSync + t.hBp;
/** Lines of one field (the whole frame when progressive). */
export const vTotal = (t: Timing) => t.vAct + t.vFp + t.vSync + t.vBp;
export const fieldTicks = (t: Timing) => hTotal(t) * vTotal(t);
export const frameTicks = (t: Timing) => fieldTicks(t) * (t.fields ?? 1);

/** Our scan-out: a word a cycle, the cycle after word 1023 is word 0. No time is spent anywhere but on pixels. */
export const SCANOUT: Timing = { id: 'scanout', hAct: W, hFp: 0, hSync: 0, hBp: 0, vAct: W, vFp: 0, vSync: 0, vBp: 0 };
/** VGA 640 x 480 @ 59.94 Hz as published: 25.175 MHz, 800 x 525 (UW CSE467 / Columbia 4840 / Altium timing tables). */
export const VGA_FULL: Timing = { id: 'vga', hAct: 640, hFp: 16, hSync: 96, hBp: 48, vAct: 480, vFp: 10, vSync: 2, vBp: 33 };
export const VGA_PIXEL_CLOCK = 25.175e6;
/** The same proportions on our 64 x 64: 160/640 of blanking a line is 16 pixels (four words), 45/480 of a frame is
 *  6 lines; the porches and the sync pulse rounded to whole pixels / lines (a sync pulse is at least one line). */
export const VGA_SCALED: Timing = { id: 'vga', hAct: W, hFp: 2, hSync: 10, hBp: 4, vAct: W, vFp: 1, vSync: 1, vBp: 4 };
export const timingOf = (blanking: boolean): Timing => (blanking ? VGA_SCALED : SCANOUT);

/** 525-line broadcast video (NTSC, "system M"): the line frequency is 4.5 MHz / 286 = 15 734.264 Hz (ITU-R BT.470-6 table: 15 734.264 Hz
 *  +-0.0003 %; SMPTE ST 170M), 525 lines a frame in two interlaced fields of 262.5 (59.94 fields, 29.97 frames a second). ITU-R BT.601
 *  samples the same line at 13.5 MHz: 858 samples a line (13.5 MHz / 858 = the same 15 734.27 Hz), 720 of them picture, 240 picture lines a field. */
export const NTSC = {
  LINE_HZ: 4.5e6 / 286, LINES: 525, LINES_FIELD: 262.5, CLOCK_601: 13.5e6, SAMPLES_LINE: 858, SAMPLES_ACTIVE: 720, ACTIVE_FIELD: 240,
  lineUs: () => 1e6 / NTSC.LINE_HZ, fieldHz: () => (2 * NTSC.LINE_HZ) / NTSC.LINES, frameMs: () => (1e3 * NTSC.LINES) / NTSC.LINE_HZ,
};
/** NTSC on our 64 x 64: the same shares. Per line 64 of 64 / (720 / 858) = 76.3 clocks -> 76 (1 front porch, 6 sync: 4.7 us of 63.6 us is
 *  5.6 pixels, 5 back porch); per field 240 of 262.5 lines is 32 of 35.0 (a field's 262.5 x 64 / 480 is exactly 35), so the frame is 70
 *  lines. The porches and the sync pulse are rounded to whole pixels / lines (estimates), a word stays four pixels. */
export const NTSC_SCALED: Timing = { id: 'ntsc', hAct: W, hFp: 1, hSync: 6, hBp: 5, vAct: 32, vFp: 0, vSync: 1, vBp: 2, fields: 2 };
export const timingFor = (mode: 'a' | 'b' | 'c'): Timing => (mode === 'c' ? NTSC_SCALED : mode === 'b' ? VGA_SCALED : SCANOUT);

/** The frame-buffer word the scan-out counter's value means. Progressive: itself. Interlaced: the counter runs a field's 32 lines
 *  after another (bit 9 = field, 8..4 = line in the field, 3..0 = word), the memory wants row = 2 * line + field: the field bit
 *  moves from the top of the address to the row's bottom bit (a six-wire permutation). */
export const memWord = (ra: number, tm: Timing): number => ((tm.fields ?? 1) > 1 ? ((((ra >> 4) & 31) * 2 + (ra >> 9)) << 4) | (ra & 15) : ra);

export interface BeamPos {
  /** Deflection in pixel units: x in 0..64 across, y in 0..64 down (continuous: the pixel under the beam is floor of both). */
  x: number; y: number;
  blanked: boolean;
  phase: 'active' | 'hretrace' | 'vretrace';
  /** The line within the field (the row when progressive), the picture row it is drawing and the field (0: odd lines, 1: even). */
  line: number; row: number; field: number; px: number;
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
  const HT = hTotal(tm), FT = frameTicks(tm), f = ((t % FT) + FT) % FT, nf = tm.fields ?? 1, FF = fieldTicks(tm);
  const field = nf > 1 ? Math.floor(f / FF) : 0, ff = f - field * FF, line = Math.floor(ff / HT), pxf = ff - line * HT, px = Math.floor(pxf);
  const hAct = pxf < tm.hAct, vAct = line < tm.vAct;
  const x = hAct ? pxf : tm.hAct * (1 - (pxf - tm.hAct) / (HT - tm.hAct));
  const T0 = tm.vAct * HT, yOf = (fl: number, fd: number) => nf * fl + fd; // interlaced: row = 2 * line + field, a line slopes by one row
  let y: number;
  if (vAct) y = yOf(line, field) + pxf / HT; // active line: the ramp inside the row it draws
  else {
    const yEnd = yOf(tm.vAct - 1, field) + 1, yNext = nf > 1 ? 1 - field : 0; // back to the top, or to the other field's first row
    y = yEnd + (yNext - yEnd) * ((ff - T0) / (FF - T0));
  }
  const active = hAct && vAct, row = yOf(line, field);
  const hs0 = tm.hAct + tm.hFp, vs0 = tm.vAct + tm.vFp;
  return {
    x, y, blanked: !active, phase: active ? 'active' : !vAct ? 'vretrace' : 'hretrace', line, row, field, px,
    hsync: px >= hs0 && px < hs0 + tm.hSync, vsync: line >= vs0 && line < vs0 + tm.vSync,
    // the scan-out counter's value: a frame's words in order (an interlaced frame: field 0's, then field 1's)
    addr: active ? field * ROW_WORDS * tm.vAct + line * ROW_WORDS + (px >> 2) : -1, pixel: active ? row * W + px : -1,
  };
}

/** Normalised yoke currents (-1..1, centre 0) for a beam position: the deflection is proportional to the current. */
export const yokeCurrent = (b: Pick<BeamPos, 'x' | 'y'>): { h: number; v: number } => ({ h: (b.x - W / 2) / (W / 2), v: (b.y - W / 2) / (W / 2) });

export const levelsOf = (v: number): RGB => { const [r, g, b] = rgb332(v); return [r / 255, g / 255, b / 255]; };

/** Persistence: a P22 phosphor fades in about a millisecond (an order of magnitude; sources vary), here as a share of a frame. */
export const REAL_FRAME_MS = 1000 / 59.94;
/** A field (a frame when progressive) lasts REAL_FRAME_MS: 59.94 Hz, VGA's frame rate and NTSC's field rate. */
export const decayTicks = (tm: Timing, ms: number, scale = 1): number => ((ms * scale) / REAL_FRAME_MS) * fieldTicks(tm);

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
          this.lastWord = { tick: tk, ra: o.ra, vsync: o.vsync, front: o.front, pixels: [0, 1, 2, 3].map((j) => this.pics[o.front][4 * memWord(o.ra, this.tm) + j]) };
          this.onWord?.(this.lastWord);
        }
        const p = 4 * memWord(o.ra, this.tm) + sub;
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
  const GUN_PITCH = 5.5, TRIAD = 0.27;
  // The mask-to-screen gap q follows from the geometry: the beams cross at the mask hole at an angle GUN_PITCH / (D - q) to each other
  // (they left the gun GUN_PITCH apart), and the neighbouring dots of a triad are TRIAD / 3 apart, so q * GUN_PITCH / (D - q) = TRIAD / 3.
  // Estimated: no primary source gives q for this tube (real tubes' effective beam spacing at the yoke is smaller, their gap larger).
  const Q = (TRIAD * D) / (3 * GUN_PITCH + TRIAD);
  return {
    DIAG, W_MM, H_MM, DEFLECT, D,
    NECK_OD: 29.1, NECK_R: 29.1 / 2,
    NECK_X0: -166, JOIN_X: -10,
    YOKE_X0: -40, YOKE_X1: 20,
    GUN_PITCH, GUN_EXIT: -62,
    /** The funnel meets the glass at the rim, which the curved face has pulled back (about 14 mm at the corners of the glass). */
    FUNNEL_X1: D - 16,
    /** Triad pitch: 0.27 mm, the circular-hole mask example of US6107729. */
    TRIAD, Q,
    /** The faceplate's radius of curvature: an ESTIMATE (large radii, order 1-2 m, are what 14-inch faces had; no primary source found). */
    FACE_R: 2000,
    /** The glass beyond the picture area, all round. */
    MARGIN: 16,
    ANODE_KV: [24, 32] as const,
    /** About ten: the stem's pin count is the model's choice (no source found). */
    PINS: 10,
  };
})();

/** How far back from the axis plane the curved face sits at (y, z) (a sphere of radius FACE_R, sag r^2 / 2R). */
export const sagAt = (y: number, z: number): number => (y * y + z * z) / (2 * GEOM.FACE_R);
/** Where the spot is on the faceplate for a deflection (pixel units): [x, y, z] in mm. The ray from the deflection centre meets the
 *  curved face a little before D: x = D - r^2 / 2R with r = r0 x / D (r0: where it would land on the flat plane). */
export const spotOf = (x: number, y: number): Vec3 => {
  const y0 = (0.5 - y / W) * GEOM.H_MM, z0 = (0.5 - x / W) * GEOM.W_MM, D = GEOM.D, a = (y0 * y0 + z0 * z0) / (2 * GEOM.FACE_R * D * D);
  const xf = a < 1e-15 ? D : (-1 + Math.sqrt(1 + 4 * a * D)) / (2 * a);
  return [xf, (y0 * xf) / D, (z0 * xf) / D];
};
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

/** One beam's path from the gun to its phosphor dot. The three beams of the in-line gun leave GUN_PITCH apart (zi = -pitch, 0, +pitch: R, G, B)
 *  and keep that offset through the yoke (a quadratic bend about their own deflection centres), then each is steered to the hole of the
 *  shadow mask in front of `spot` (the triad's centre): all three CROSS in that hole, GEOM.Q ahead of the face, and go on to three
 *  dots TRIAD / 3 apart, swapped end for end (the beam from -z lands on +z). The path's last point is the dot. */
export function beamPath(zi: number, spot: Vec3): Vec3[] {
  const G = GEOM, C: Vec3 = [0, 0, zi], d = sub3(spot, [0, 0, 0]), Qp = add3(scale3(d, G.YOKE_X1 / d[0]), [0, 0, zi]);
  const hole = scale3(d, (spot[0] - G.Q) / d[0]); // the crossing: on the axis of the undeflected-plus-centre ray, at the mask
  const dot: Vec3 = [spot[0], spot[1], spot[2] - (zi / G.GUN_PITCH) * (G.TRIAD / 3)];
  const P0: Vec3 = [G.YOKE_X0 + 10, 0, zi];
  const pts: Vec3[] = [[G.GUN_EXIT, 0, zi], [G.GUN_EXIT + 20, 0, zi], P0];
  const N = 8;
  for (let i = 1; i <= N; i++) {
    const u = i / N, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    pts.push([a * P0[0] + b * C[0] + c * Qp[0], a * P0[1] + b * C[1] + c * Qp[1], a * P0[2] + b * C[2] + c * Qp[2]]);
  }
  pts.push(hole, dot);
  return pts;
}
/** The z of a path (monotonic in x) at x. */
export function pathAt(path: Vec3[], x: number): Vec3 {
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    if (x >= a[0] && x <= b[0] && b[0] > a[0]) { const t = (x - a[0]) / (b[0] - a[0]); return [x, a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])]; }
  }
  return path[path.length - 1];
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
  // Faceplate glass on a curved face (FACE_R: estimated), in 8 x 8 steps; the shadow mask GEOM.Q behind it, on the same sphere;
  // the bezel round it and the implosion band (a steel strap round the panel's rim, which holds the evacuated glass together if it cracks).
  const hw = G.W_MM / 2, hh = G.H_MM / 2, M = G.MARGIN, NG = 8;
  const gy = hh + M, gz = hw + M;
  for (let i = 0; i < NG; i++) for (let k = 0; k < NG; k++) {
    const y0 = -gy + (2 * gy * i) / NG, y1 = y0 + (2 * gy) / NG, z0 = -gz + (2 * gz * k) / NG, z1 = z0 + (2 * gz) / NG, xi = G.D - sagAt((y0 + y1) / 2, (z0 + z1) / 2);
    if (i === 0 && k === 0) out.push(box(alpha(P.glass, 0.14), G.D + 1, G.D + 13, -gy, gy, -gz, gz)); // one clean pane (stacked stepped panes drew a grid)
    out.push(box(alpha(P.mask, 0.12), xi - G.Q - 0.2, xi - G.Q, y0, y1, z0, z1, 0.2));
  }
  out.push(...rim(P.bezel, 0, 4, -2, 14), ...rim(P.metal, 4, 6.5, -12, 2, 0.5));
  out.push(...magnetRings(P));
  out.push(...yokeParts(P, current));
  return out;
}

/** A frame of boxes round the faceplate's glass edge, `inner` to `outer` mm beyond it, each piece at the face's local depth
 *  (x from `x0` to `x1` mm either side of the glass's inner surface there). */
function rim(c: RGB, inner: number, outer: number, x0: number, x1: number, spec = 0): Part[] {
  const G = GEOM, gy = G.H_MM / 2 + G.MARGIN, gz = G.W_MM / 2 + G.MARGIN, out: Part[] = [], NZ = 6, NY = 4;
  const at = (y: number, z: number) => G.D - sagAt(y, z);
  for (const sy of [1, -1]) for (let k = 0; k < NZ; k++) {
    const z0 = -gz - outer + ((2 * (gz + outer)) * k) / NZ, z1 = z0 + (2 * (gz + outer)) / NZ, xi = at(sy * (gy + inner), (z0 + z1) / 2);
    out.push(box(c, xi + x0, xi + x1, sy > 0 ? gy + inner : -gy - outer, sy > 0 ? gy + outer : -gy - inner, z0, z1, spec));
  }
  for (const sz of [1, -1]) for (let k = 0; k < NY; k++) {
    const y0 = -gy + ((2 * gy) * k) / NY, y1 = y0 + (2 * gy) / NY, xi = at((y0 + y1) / 2, sz * (gz + inner));
    out.push(box(c, xi + x0, xi + x1, y0, y1, sz > 0 ? gz + inner : -gz - outer, sz > 0 ? gz + outer : -gz - inner, spec));
  }
  return out;
}

/** Purity and convergence magnets: thin rings clipped round the neck behind the yoke (the real ones are pairs of magnetised rings turned
 *  against each other to trim the beams' landing). Three rings of twelve segments. */
export function magnetRings(P: CrtPalette): Part[] {
  const out: Part[] = [], R = GEOM.NECK_R + 1.6, N = 12;
  for (const x of [-58, -52, -46]) {
    const pts: Vec3[] = Array.from({ length: N + 1 }, (_, i): Vec3 => [x, R * Math.cos((i / N) * 2 * Math.PI), R * Math.sin((i / N) * 2 * Math.PI)]);
    out.push(...wire(P.ferrite, pts, 1.3, 0.2));
  }
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
    const [xf, yc, zc] = spotOf((cx + 0.5) * B, (cy + 0.5) * B), k = xf / G.D;
    const col: RGB = [P.cellOff[0] + (1 - P.cellOff[0]) * r * 0.9, P.cellOff[1] + (1 - P.cellOff[1]) * g * 0.9, P.cellOff[2] + (1 - P.cellOff[2]) * b * 0.9];
    out.push({ ...box(col, xf - 0.6, xf, yc - (ch * k) / 2, yc + (ch * k) / 2, zc - (cw * k) / 2, zc + (cw * k) / 2), emissive: [r * 0.55, g * 0.55, b * 0.55] });
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

// ---------------------------------------------------------------- the mask close-up

/** The close-up's figures, in mm. Triad pitch GEOM.TRIAD (US6107729's example); the rest are ESTIMATES: hole 0.12 mm drawn square (real holes are
 *  round, about 40-50 % of the pitch), mask steel 0.15 mm thick (order 0.1-0.25 mm), row pitch = the triad pitch, dot diameter 0.07 mm. */
export const MASK = { COLS: 7, ROWS: 5, HOLE: 0.12, THICK: 0.15, DOT_R: 0.035, LEAD: 5, MATRIX: 0.06 } as const;
/** Triads across one of our cells: its width (340 mm x 0.8 / 64 = 4.25 mm) over the triad pitch. */
export const TRIADS_PER_CELL = GEOM.W_MM / W / GEOM.TRIAD;

/** The three beams' lines through the close-up's centre hole (the screen's centre: z = 0 is the hole's axis): the lead-in, the crossing, the dot. */
export function maskBeam(zi: number): Vec3[] {
  const G = GEOM, mx = G.D - G.Q, L = mx, m: Vec3 = [mx, 0, 0];
  return [[mx - MASK.LEAD, 0, (zi * MASK.LEAD) / L], m, [G.D, 0, -(zi / G.GUN_PITCH) * (G.TRIAD / 3)]];
}

/** A patch of the shadow mask with the beams of one triad through its centre hole, drawn to scale (the camera sits a few millimetres away).
 *  Dots: R at +z, G, B at -z (the beams cross in the hole); dim ones for every other hole, glowing for the centre triad. */
export function maskParts(P: CrtPalette, levels: RGB, blanked: boolean): Part[] {
  const G = GEOM, T = G.TRIAD, mx = G.D - G.Q, out: Part[] = [], nc = MASK.COLS, nr = MASK.ROWS, h = MASK.HOLE / 2, th = MASK.THICK;
  const cz = (i: number) => (i - (nc - 1) / 2) * T, cy = (r: number) => (r - (nr - 1) / 2) * T;
  const z0 = cz(0) - T / 2, z1 = cz(nc - 1) + T / 2, y0 = cy(0) - T / 2, y1 = cy(nr - 1) + T / 2, mc = P.mask;
  // the plate: strips between the rows, and in each row the bars between the holes
  for (let r = 0; r <= nr; r++) {
    const a = r === 0 ? y0 : cy(r - 1) + h, b = r === nr ? y1 : cy(r) - h;
    out.push(box(mc, mx - th, mx, a, b, z0, z1, 0.3));
  }
  for (let r = 0; r < nr; r++) for (let i = 0; i <= nc; i++) {
    const a = i === 0 ? z0 : cz(i - 1) + h, b = i === nc ? z1 : cz(i) - h;
    out.push(box(mc, mx - th, mx, cy(r) - h, cy(r) + h, a, b, 0.3));
  }
  // the screen: the black matrix, then a red, green and blue dot behind every hole
  out.push(box(P.aquadag, G.D, G.D + MASK.MATRIX, y0, y1, z0, z1));
  const cols: RGB[] = [[1, 0.15, 0.12], [0.2, 1, 0.25], [0.25, 0.4, 1]];
  for (let r = 0; r < nr; r++) for (let i = 0; i < nc; i++) {
    const centre = r === (nr - 1) / 2 && i === (nc - 1) / 2;
    cols.forEach((c, k) => {
      const dz = cz(i) - (k - 1) * (T / 3), dim = centre ? Math.max(0.25, blanked ? 0 : levels[k]) : 0.28;
      out.push({ ...rod(lit(c, 0.35 + 0.65 * dim), [G.D, cy(r), dz], [G.D - 0.05, cy(r), dz], MASK.DOT_R), emissive: lit(c, centre ? dim * 0.8 : 0.1) });
    });
  }
  // the three beams, thin: the real spot is wider than the hole and most of its current stops on the mask
  [-G.GUN_PITCH, 0, G.GUN_PITCH].forEach((zi, k) => {
    const lv = blanked ? 0 : levels[k];
    if (lv <= 0.001) return;
    for (const p of wire([cols[k][0], cols[k][1], cols[k][2], 0.95] as RGBA4, maskBeam(zi), 0.012)) out.push({ ...p, emissive: lit(cols[k], 0.5 + 0.4 * lv) });
  });
  return out;
}

export type CrtDetail = 'overview' | 'gun' | 'yoke' | 'mask';

/** Labels for what the camera is on: a few for the whole tube, the electrodes up close at the gun, the coils at the yoke. */
export function crtAnchors(detail: CrtDetail = 'overview', narrow = false): Anchor[] {
  const all = anchorsAll(detail), main = all.filter((a) => !a.minor);
  // a phone's stage has room for three labels (the tube's: gun, yoke, screen)
  return narrow ? (detail === 'overview' ? main.filter((a) => /gun|yoke|screen/.test(a.text)) : main.slice(0, 3)) : all;
}
function anchorsAll(detail: CrtDetail): Anchor[] {
  const G = GEOM, right: Vec3 = [0, 0, 1], up: Vec3 = [0, 1, 0], front: Vec3 = [1, 0, 0], down: Vec3 = [0, -1, 0];
  if (detail === 'mask') {
    const mx = G.D - G.Q, T = G.TRIAD;
    return [
      { text: 'steel mask, one hole', p: [mx - MASK.THICK, MASK.HOLE, -T], side: 't', n: up },
      { text: 'beams cross in the hole', p: [mx - 2, 0, 0.06], side: 'l', n: right },
      { text: 'R · G · B dots', p: [G.D - 0.05, -T * 1.2, 0], side: 'b', n: [-1, 0, 0] },
      { text: 'black matrix', p: [G.D, T * 2.2, -T * 2.2], side: 'r', n: [-1, 0, 0], minor: true },
    ];
  }
  if (detail === 'gun') {
    return [
      { text: 'cathodes + heaters', p: [-150, 0, -5.5], side: 'l', n: right },
      { text: 'G1 grid', p: [-144, 5.5, 9.5], side: 't', n: right },
      { text: 'G2 screen grid', p: [-141, -5.5, 9.5], side: 'b', n: right },
      { text: 'G3–G5 focus', p: [-100, 5.5, -9.5], side: 't', n: right },
      { text: 'G6 final anode', p: [-74, -5.8, 9.8], side: 'b', n: right },
      { text: 'neck, 29.1 mm', p: [-125, -G.NECK_R, 0], side: 'b', n: down },
      { text: 'stem, about 10 pins', p: [G.NECK_X0 - 10, 11, 0], side: 'l', n: up },
    ];
  }
  if (detail === 'yoke') {
    const fe = sectionPoint(9, 0);
    return [
      { text: 'horizontal coils (sweep)', p: [-20, G.NECK_R + 8, 0], side: 't', n: up },
      { text: 'vertical coils (step)', p: [-20, 0, G.NECK_R + 14], side: 'r', n: right },
      { text: 'ferrite core', p: [9, fe[0] + 15.5, 0], side: 't', n: up },
      { text: 'purity + convergence magnets', p: [-52, G.NECK_R + 1.6, 0], side: 't', n: up },
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
    { text: 'shadow mask', p: [G.D - sagAt(G.H_MM / 2, G.W_MM / 2) - G.Q, G.H_MM / 2, G.W_MM / 2], side: 'r', n: front, minor: true },
    { text: 'implosion band', p: [G.D - sagAt(G.H_MM / 2 + G.MARGIN, 0) - 5, G.H_MM / 2 + G.MARGIN + 6.5, 0], side: 't', n: up, minor: true },
  ];
}
