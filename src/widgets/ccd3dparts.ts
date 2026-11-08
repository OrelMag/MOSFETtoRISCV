// A three-phase CCD as parts (DOM-free, tested). Two things live here:
//  1. CcdRun: the charge in the registers, bucket by bucket, clocked as phys/imagesensor.ts clocks a three-phase register
//     (clockHigh: one gate high, then two overlapping; a packet moves half a gate a step, a pixel in six). A bucket is
//     the packet one potential well carries. Each pixel moved leaves (1 − CTE) of it behind, which joins the bucket after
//     it (the deferred-charge model behind ccdRetained: after n pixel transfers a packet keeps CTE^n of itself; the
//     datasheet's CTE is per pixel, a three-gate triplet). Charge is conserved: what leaves the horizontal register lands
//     on the floating diffusion, is read, and is reset away into the reset drain.
//  2. The drawing: a C × R corner of the CCD42-40, its horizontal register and its output amplifier, in µm across
//     (x, z) with the layer thicknesses in y exaggerated, and the potential under each gate drawn as a well's depth.
// World axes: x along the horizontal register (charge moves to −x, into the output), z along the columns (charge moves
// to −z, into the horizontal register), y up out of the silicon.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { CCD42_40, clockHigh, packetGate, stepsPerPixel } from '../phys/imagesensor';

// ---------------------------------------------------------------- the sensor's numbers

/** Pixel pitch (µm), full well (e⁻), output responsivity (µV/e⁻): the CCD42-40's. */
export const PITCH = CCD42_40.pitch, FULL_WELL = CCD42_40.fullWell, CG_UV = CCD42_40.cg;
/** Three gates per pixel, a third of the pitch each (derived: the datasheet gives the pitch, not the gate lengths). */
export const PHASES = CCD42_40.phases, GATE = CCD42_40.gateLength;
/** Clock steps per pixel moved (six: three single-gate, three overlapping). */
export const STEPS = stepsPerPixel(PHASES);
/** The step at which a register's front packet has crossed out of it (under the next register's well, or the diffusion). */
export const CROSS = 4;
/** The corner drawn: columns × rows. */
export const COLS = 3, ROWS = 4;

/** The phase (1..3) of gate g along a register (g = 0 is the gate nearest the register's end). A packet rests under
 *  φ1 while the sensor integrates; the clock raises φ2 then φ3 toward the end, so charge moves φ1 → φ2 → φ3 → φ1. */
export const phaseOf = (g: number): 1 | 2 | 3 => (1 + (((1 - g) % 3) + 3) % 3) as 1 | 2 | 3;
/** The phases high at step s of a register's pixel transfer (imagesensor.ts clockHigh). */
export const highAt = (s: number): number[] => clockHigh(PHASES, s);
/** Where bucket k sits at step s, in gates (half gates while two are high). */
export const gateOf = (k: number, s: number): number => 3 * k + 1 - packetGate(PHASES, s);

/** One pixel transfer on a chain of buckets, front (0) first: each keeps cte of itself and takes on what the one ahead
 *  left behind. Returns the new chain and what the last one left behind (it trails off the end). */
export function transfer(q: readonly number[], cte: number): { q: number[]; tail: number } {
  const out = q.map((v, k) => cte * v + (k > 0 ? (1 - cte) * q[k - 1] : 0));
  return { q: out, tail: (1 - cte) * (q[q.length - 1] ?? 0) };
}

/** A test image: a bright spot, a mid grey and a dark floor, as a fraction of full well per (row, column). Row 0 is
 *  the row nearest the horizontal register. */
export function scene(r: number, c: number): number {
  if (r === 2 && c === 1) return 0.9;
  if (r === 0 && c === 2) return 0.45;
  if (r === 3 && c === 0) return 0.25;
  return 0.03;
}

export type Phase = 'idle' | 'vertical' | 'horizontal';
export interface Cte { v: number; h: number }
/** The datasheet's: parallel (down the columns) and serial (along the horizontal register). */
export const CTE_DATASHEET: Cte = { v: CCD42_40.cteParallel, h: CCD42_40.cteSerial };

/** The registers' charge (e⁻) and where the clocks are. */
export class CcdRun {
  /** v[c][k]: column c's bucket k (k = 0 nearest the horizontal register). */
  v: number[][] = Array.from({ length: COLS }, () => new Array<number>(ROWS).fill(0));
  /** What trails behind each column's last bucket (it becomes the new last bucket when the rows move on). */
  vTail: number[] = new Array<number>(COLS).fill(0);
  /** h[k]: the horizontal register's bucket k (k = 0 nearest the output). */
  h: number[] = new Array<number>(COLS).fill(0);
  hTail = 0;
  /** Steps of the current pixel transfer (0..5) in each register. */
  vs = 0; hs = 0;
  /** Charge on the floating diffusion (e⁻), and every sample read: e⁻ and the output's swing in µV. */
  fd = 0;
  samples: { e: number; uv: number; row: number; col: number }[] = [];
  /** Rows moved into the horizontal register so far, and pixels of the current row read. */
  rowsOut = 0; pxOut = 0;
  /** The exposure the charge came from (what Expose was given), for comparing the samples with what was collected. */
  level = 0;
  /** Charge reset off the floating diffusion into the reset drain, all told (for conservation). */
  drained = 0;
  cte: Cte;
  constructor(cte: Cte = CTE_DATASHEET) { this.cte = { ...cte }; }

  /** Total charge anywhere: registers, tails, diffusion, drained. */
  total(): number {
    const s = (a: readonly number[]) => a.reduce((t, x) => t + x, 0);
    return this.v.reduce((t, col) => t + s(col), 0) + s(this.vTail) + s(this.h) + this.hTail + this.fd + this.drained;
  }

  /** Integrate: every pixel collects `level` × scene × full well under its φ1 gate (clipped at full well; the
   *  real chip blooms beyond it, not drawn). Clears the registers and the samples first. */
  expose(level: number): void {
    this.level = level;
    this.v = Array.from({ length: COLS }, (_, c) => Array.from({ length: ROWS }, (_, r) => Math.min(FULL_WELL, Math.round(level * scene(r, c) * FULL_WELL))));
    this.vTail.fill(0); this.h.fill(0); this.hTail = 0; this.vs = 0; this.hs = 0; this.fd = 0; this.samples = []; this.rowsOut = 0; this.pxOut = 0; this.drained = 0;
  }

  /** What the next step moves: the horizontal register while it holds a row not yet read, else the columns a step. */
  next(): Phase {
    if (this.hs !== 0 || (this.rowsOut > 0 && this.pxOut < COLS)) return 'horizontal';
    return this.rowsOut < ROWS || this.vs !== 0 ? 'vertical' : 'idle';
  }
  done(): boolean { return this.next() === 'idle'; }

  /** One clock step. */
  step(): Phase {
    const what = this.next();
    if (what === 'vertical') this.stepV();
    else if (what === 'horizontal') this.stepH();
    return what;
  }

  private stepV(): void {
    this.vs++;
    if (this.vs === CROSS) {
      // A pixel moved: the trail it leaves, then the front buckets cross into the horizontal register (under its φ1).
      for (let c = 0; c < COLS; c++) {
        const t = transfer(this.v[c], this.cte.v);
        this.v[c] = t.q;
        this.vTail[c] += t.tail; // the empty bucket behind the last keeps all that trails into it
        this.h[c] += this.v[c][0];
        this.v[c][0] = 0;
      }
    } else if (this.vs === STEPS) {
      for (let c = 0; c < COLS; c++) { this.v[c] = [...this.v[c].slice(1), this.vTail[c]]; this.vTail[c] = 0; }
      this.vs = 0;
      this.rowsOut++;
      this.pxOut = 0;
    }
  }

  private stepH(): void {
    this.hs++;
    if (this.hs === CROSS) {
      const t = transfer(this.h, this.cte.h);
      this.h = t.q;
      this.hTail += t.tail;
      // The front bucket crosses the output gate: the diffusion was reset (its last charge drained), then takes it.
      this.drained += this.fd;
      this.fd = this.h[0];
      this.h[0] = 0;
      this.samples.push({ e: this.fd, uv: this.fd * CG_UV, row: this.rowsOut - 1, col: this.pxOut });
    } else if (this.hs === STEPS) {
      // A row's trail stays in the register and is read with the next row's first pixel.
      this.h = [...this.h.slice(1), this.hTail];
      this.hTail = 0;
      this.hs = 0;
      this.pxOut++;
    }
  }

  /** The phases high in each register now (φ1 alone while it waits). */
  clocks(): { v: number[]; h: number[] } { return { v: highAt(this.vs), h: highAt(this.hs) }; }
}

// ---------------------------------------------------------------- the drawing

/** Drawn layer tops (y, µm): the oxide ~8 × its real ~0.1 µm, each poly level ~3 × its ~0.4 µm; the silicon about to scale. */
export const SI_BOTTOM = -14, CHANNEL = -2.5, OX = 0.8, POLY = 1.1, POLY_T = 1.2;
/** A well's depth under a high gate and under a low one (drawn, not to any scale: it stands for the channel potential). */
export const WELL_HI = 4.5, WELL_LO = 1, WELL_FD = 5.5, WELL_T = 0.3;
/** Where the output stage sits along x (µm, the register ends at x = 0). */
export const OG_X: [number, number] = [-GATE, 0], FD_X: [number, number] = [-GATE - 4, -GATE], RG_X: [number, number] = [-GATE - 8.5, -GATE - 4], RD_X: [number, number] = [-GATE - 14, -GATE - 8.5];
const H_Z: [number, number] = [-PITCH, 0];
const AREA_X = COLS * PITCH, AREA_Z = ROWS * PITCH, CUT_X = (COLS - 1) * PITCH;

export interface CcdPalette { si: RGBA; p: RGB; n: RGB; chan: RGBA; poly: RGB; oxide: RGBA; metal: RGB; well: RGBA; charge: RGB; hot: RGB }

export interface CcdPose {
  run: CcdRun;
  /** 0..1 through the step being drawn: packets glide between gates. */
  t: number;
  /** Which register the gliding step moves (the step just taken). */
  moving: Phase;
}

const glow = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
/** A packet's drawn radius: its volume follows its charge (radius ∝ cube root), full well = R_FULL units. */
export const R_FULL = 3;
export const radiusOf = (e: number): number => R_FULL * Math.cbrt(Math.max(0, e) / FULL_WELL);

/** A packet as a soft cloud: three cylinders crossed into a rough ball. */
function cloud(P: CcdPalette, c: Vec3, r: number, out: Part[]): void {
  if (r < 0.12) return;
  const col = P.charge, e = glow(P.charge, 1.1);
  out.push({ ...cyl(col, c[0], c[2], c[1] - r * 0.75, c[1] + r * 0.75, r), emissive: e });
  out.push({ ...rod(col, [c[0] - r * 0.8, c[1], c[2]], [c[0] + r * 0.8, c[1], c[2]], r * 0.8), emissive: e });
  out.push({ ...rod(col, [c[0], c[1], c[2] - r * 0.8], [c[0], c[1], c[2] + r * 0.8], r * 0.8), emissive: e });
}

/** z of the centre of vertical gate g (g = −1: the horizontal register). */
const vz = (g: number): number => (g < 0 ? (H_Z[0] + H_Z[1]) / 2 : (g + 0.5) * GATE);
/** x of the centre of horizontal gate g (g = −1: the floating diffusion). */
const hx = (g: number): number => (g < 0 ? (FD_X[0] + FD_X[1]) / 2 : (g + 0.5) * GATE);
const colX = (c: number): number => (c + 0.5) * PITCH;

/** Depth of the well under a gate of phase ph while the phases `high` are raised. */
const wellDepth = (ph: number, high: readonly number[]): number => (high.includes(ph) ? WELL_HI : WELL_LO);
/** z of a fractional vertical gate position (below 0: on the way into the horizontal register, reached at −1). */
const vzAt = (g: number): number => (g >= 0 ? (g + 0.5) * GATE : vz(-1) + (g + 1) * (vz(0) - vz(-1)));
const hxAt = (g: number): number => (g >= 0 ? (g + 0.5) * GATE : hx(-1) + (g + 1) * (hx(0) - hx(-1)));

export function ccdParts(pose: CcdPose, P: CcdPalette): Part[] {
  const out: Part[] = [], run = pose.run, ck = run.clocks();
  // While a register waits its gates rest with φ1 high (the packets under it); the moving one shows its clock.
  const vHigh = run.vs > 0 || pose.moving === 'vertical' ? ck.v : [1];
  const hHigh = run.hs > 0 || pose.moving === 'horizontal' ? ck.h : [1];

  // Substrate (p, clear so the wells and packets show through it) and the n buried channel along every register.
  out.push(box(P.si, RD_X[0] - 2, AREA_X + 2, SI_BOTTOM, CHANNEL, H_Z[0] - 8, AREA_Z + 2));
  for (let c = 0; c < COLS; c++) out.push(box(P.chan, c * PITCH + 1, (c + 1) * PITCH - 1, CHANNEL, 0, 0, AREA_Z));
  out.push(box(P.chan, OG_X[0], AREA_X, CHANNEL, 0, H_Z[0] + 1, H_Z[1]));
  // Channel stops: p+ strips between the columns (and round the area) that keep the packets in their column.
  for (let c = 0; c <= COLS; c++) out.push(box(P.p, c * PITCH - 1, c * PITCH + 1, CHANNEL, 0.02, 0, AREA_Z));
  out.push(box(P.p, OG_X[0], AREA_X + 1, CHANNEL, 0.02, H_Z[0], H_Z[0] + 1));
  // Output: floating diffusion and reset drain (n+), the output and reset gates.
  out.push(box(P.n, FD_X[0], FD_X[1], CHANNEL, 0.04, H_Z[0] + 2, H_Z[1] - 2));
  out.push(box(P.n, RD_X[0], RD_X[1], CHANNEL, 0.04, H_Z[0] + 1, H_Z[1] - 1));

  // Wells: the channel potential under each gate, drawn as a floor at a depth below the channel (deep under a high
  // gate), with thin walls where neighbouring floors differ: a stepped potential profile for each register.
  const wall: RGBA = [P.well[0], P.well[1], P.well[2], 0.22];
  // A barrier's floor is faint, a well's strong: the eye goes to where the charge can sit.
  const shallow: RGBA = [P.well[0], P.well[1], P.well[2], 0.3];
  const floor = (d: number, x0: number, x1: number, z0: number, z1: number) => out.push(box(d > WELL_LO ? P.well : shallow, x0, x1, CHANNEL - d - WELL_T, CHANNEL - d, z0, z1));
  for (let c = 0; c < COLS; c++) {
    const x0 = c * PITCH + 1.4, x1 = (c + 1) * PITCH - 1.4;
    for (let g = 0; g < 3 * ROWS; g++) {
      const d = wellDepth(phaseOf(g), vHigh), dn = g + 1 < 3 * ROWS ? wellDepth(phaseOf(g + 1), vHigh) : WELL_LO;
      floor(d, x0, x1, g * GATE, (g + 1) * GATE);
      if (d !== dn) out.push(box(wall, x0, x1, CHANNEL - Math.max(d, dn) - WELL_T, CHANNEL - Math.min(d, dn), (g + 1) * GATE - WELL_T / 2, (g + 1) * GATE + WELL_T / 2));
    }
  }
  const z0 = H_Z[0] + 1.4, z1 = H_Z[1] - 1.4;
  for (let g = 0; g < 3 * COLS; g++) {
    const d = wellDepth(phaseOf(g), hHigh), dn = g + 1 < 3 * COLS ? wellDepth(phaseOf(g + 1), hHigh) : WELL_LO;
    floor(d, g * GATE, (g + 1) * GATE, z0, z1);
    if (d !== dn) out.push(box(wall, (g + 1) * GATE - WELL_T / 2, (g + 1) * GATE + WELL_T / 2, CHANNEL - Math.max(d, dn) - WELL_T, CHANNEL - Math.min(d, dn), z0, z1));
  }
  floor(WELL_LO, OG_X[0], OG_X[1], z0, z1);
  floor(WELL_FD, FD_X[0], FD_X[1], z0, z1);

  // Oxide, then three overlapping poly levels: φ1 lowest, φ3 highest (a triple-poly process). Cut away over the last column
  // and over the near half of the horizontal register, so the wells and packets under them show.
  const hMid = (H_Z[0] + H_Z[1]) / 2;
  out.push(box(P.oxide, 0, CUT_X, 0, OX, 0, AREA_Z + 1));
  out.push(box(P.oxide, RD_X[0], AREA_X + 1, 0, OX, hMid, H_Z[1]));
  const gateBox = (ph: number, hot: boolean, x0: number, x1: number, z0: number, z1: number): Part => {
    const y0 = POLY + (ph - 1) * 0.45;
    return { ...box(P.poly, x0, x1, y0, y0 + POLY_T, z0, z1, 0.25), emissive: hot ? glow(P.hot, 0.45) : undefined };
  };
  for (let g = 0; g < 3 * ROWS; g++) {
    const ph = phaseOf(g);
    out.push(gateBox(ph, vHigh.includes(ph), 0, CUT_X, g * GATE - 0.4, (g + 1) * GATE + 0.4));
  }
  for (let g = 0; g < 3 * COLS; g++) {
    const ph = phaseOf(g);
    out.push(gateBox(ph, hHigh.includes(ph), g * GATE - 0.4, (g + 1) * GATE + 0.4, hMid, H_Z[1] - 0.5));
  }
  out.push(gateBox(1, false, OG_X[0], OG_X[1] - 0.2, hMid, H_Z[1] - 1));
  out.push(gateBox(2, false, RG_X[0], RG_X[1], hMid, H_Z[1] - 1));

  // The output amplifier: a metal strap from the diffusion to a source follower's gate beside the register.
  const fdC: Vec3 = [(FD_X[0] + FD_X[1]) / 2, 0, (H_Z[0] + H_Z[1]) / 2], sfZ = H_Z[0] - 5;
  out.push(rod(P.metal, [fdC[0], OX, fdC[2]], [fdC[0], 7, fdC[2]], 0.6, 0.5));
  out.push(rod(P.metal, [fdC[0], 7, fdC[2]], [fdC[0], 7, sfZ], 0.6, 0.5));
  out.push(rod(P.metal, [fdC[0], 7, sfZ], [fdC[0], POLY + POLY_T, sfZ], 0.6, 0.5));
  out.push(box(P.n, fdC[0] - 6, fdC[0] - 2, CHANNEL, 0.04, sfZ - 2, sfZ + 2));
  out.push(box(P.n, fdC[0] + 2, fdC[0] + 6, CHANNEL, 0.04, sfZ - 2, sfZ + 2));
  out.push({ ...box(P.poly, fdC[0] - 2, fdC[0] + 2, POLY, POLY + POLY_T, sfZ - 2.5, sfZ + 2.5, 0.25), emissive: run.fd > 0 ? glow(P.hot, 0.25 + 0.5 * Math.min(1, run.fd / FULL_WELL)) : undefined });
  for (const x of [fdC[0] - 4, fdC[0] + 4]) out.push(rod(P.metal, [x, 0, sfZ], [x, 5, sfZ], 0.5, 0.5));
  out.push(box(P.metal, fdC[0] + 2.5, fdC[0] + 5.5, 5, 5.8, sfZ - 1.5, sfZ + 1.5, 0.5));
  out.push(box(P.metal, fdC[0] - 5.5, fdC[0] - 2.5, 5, 5.8, sfZ - 1.5, sfZ + 1.5, 0.5));

  // Packets: each bucket at its gate, gliding the half gate from where the last step left it.
  const y = (d: number, r: number) => CHANNEL - d + r;
  const vMove = pose.moving === 'vertical', hMove = pose.moving === 'horizontal', back = (1 - pose.t) * 0.5;
  for (let c = 0; c < COLS; c++) {
    run.v[c].forEach((e, k) => {
      const g = gateOf(k, run.vs) + (vMove ? back : 0);
      if (e > 0 && g > -1) { const r = radiusOf(e); cloud(P, [colX(c), y(WELL_HI, r), vzAt(g)], r, out); }
    });
  }
  run.h.forEach((e, k) => {
    if (e <= 0) return;
    const g = gateOf(k, run.hs) + (hMove ? back : 0), r = radiusOf(e);
    // A bucket that has just dropped in from its column finishes its glide down out of the column.
    const z = vMove && run.vs === CROSS ? vzAt(-1 + back) : vz(-1);
    cloud(P, [hxAt(g), y(WELL_HI, r), z], r, out);
  });
  if (run.fd > 0) {
    const r = radiusOf(run.fd), x = hMove && run.hs === CROSS ? hxAt(-1 + back) : hx(-1);
    cloud(P, [x, y(WELL_FD, r), vz(-1)], r, out);
  }
  return out;
}

export function ccdAnchors(): Anchor[] {
  const front: Vec3 = [0, 0.2, -1], up: Vec3 = [0, 1, 0], top = POLY + POLY_T;
  const fdX = (FD_X[0] + FD_X[1]) / 2, hz = (H_Z[0] + H_Z[1]) / 2;
  return [
    { text: 'φ1', p: [CUT_X, POLY + POLY_T, vz(1 + 3 * (ROWS - 1))], side: 'r', n: up },
    { text: 'φ2', p: [CUT_X, POLY + 0.45 + POLY_T, vz(3 * (ROWS - 1))], side: 'r', n: up, minor: true },
    { text: 'φ3', p: [CUT_X, POLY + 0.9 + POLY_T, vz(2 + 3 * (ROWS - 1))], side: 'r', n: up, minor: true },
    { text: 'a column, gates cut away', p: [colX(COLS - 1), 0, AREA_Z - 2], side: 't', n: up },
    { text: 'horizontal register', p: [AREA_X * 0.75, top + 0.9, H_Z[1] - 0.5], side: 'r', n: up },
    { text: 'polysilicon gates', p: [PITCH, top + 0.9, AREA_Z * 0.5], side: 't', n: up },
    { text: 'channel stop (p+)', p: [AREA_X, 0, AREA_Z * 0.8], side: 'r', n: [1, 0.3, 0], minor: true },
    { text: 'floating diffusion', p: [fdX, 0, H_Z[1] - 2], side: 't', n: up },
    { text: 'reset gate', p: [(RG_X[0] + RG_X[1]) / 2, POLY + 0.45 + POLY_T, hz], side: 't', n: up, minor: true },
    { text: 'reset drain', p: [(RD_X[0] + RD_X[1]) / 2, 0, H_Z[0] + 1], side: 'l', n: front, minor: true },
    { text: 'source follower', p: [fdX, top, H_Z[0] - 5], side: 'l', n: front },
    { text: 'potential well', p: [colX(COLS - 1) + 4, CHANNEL - WELL_HI, vz(7)], side: 'r', n: [1, 0.3, 0] },
    { text: 'p substrate', p: [AREA_X + 2, SI_BOTTOM + 2, AREA_Z * 0.6], side: 'r', n: [1, 0, 0] },
  ];
}
