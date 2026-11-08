// A 3.5" 7200 rpm hard disk as parts and a timing model (DOM-free, tested). Units are millimetres.
//
// What is real (representative of a 3.5" desktop drive; sources in the commit message and the on-screen note):
//   platter 95 mm across, 25 mm hole, 1.27 mm thick; two platters, four heads; recording band r = 20 … 46 mm; a rotary
//   voice-coil actuator pivoting 56 mm from the spindle, head 46 mm from its pivot (zero skew near mid-band); 7200 rpm.
// The drive named is the Hitachi Deskstar 7K1000.B 500 GB (HDT721050SLA360, 2 platters). Its data sheet (HGST, 2009) gives a
//   maximum media transfer rate of 1406 Mbit/s (the Dustin-hosted copy says 1388) and, for the family, a maximum areal density
//   of 244 Gbit/in²; it does not give tracks per inch. So OUTER_SECTORS is set from the media rate (the outer track at 7200 rpm
//   must pass 1406 Mbit/s) and the track pitch is then chosen so the capacity comes to 500 GB: both are fits, not data-sheet
//   values (the result, about 116 ktpi and 119 Gbit/in² at the outer edge, is plausible for a 500 GB two-platter model
//   below the family maximum). Sectors are drawn as 4 KiB (eight real 512-byte ones), zoned density in effect.
// What the timing is: seek = a + b·√distance, fitted to a datasheet's track-to-track and average seek; rotation is exact,
//   so the rotational latency is wherever the sector happens to be when the arm arrives; transfer is the sector's arc.
// What is drawn bigger than it is: the tracks (12 rings stand for 260 000), the flying height, the platter spacing.

import type { RGB, RGBA } from '../gl/instances';
import { quatAxisAngle, type Vec3 } from '../gl/math';
import { box, cyl, rod, type Anchor, type Part } from '../gl/parts';
import { FLASH_REAL_US, FLASH_TIMES } from '../flash/model';
import { CLOCK_NS } from '../dram/timing';
import { groupNum } from '../sim/numfmt';

// ---------------------------------------------------------------- the drive

export const RPM = 7200;
/** One turn, ms: 8.33. */
export const TURN_MS = 60000 / RPM;
/** The average rotational latency: half a turn, 4.17 ms. */
export const AVG_LATENCY_MS = TURN_MS / 2;

export const PLATTER_R = 47.5, HOLE_R = 12.5, PLATTER_T = 1.27, PLATTERS = 2, HEADS = 4;
export const BAND_IN = 20, BAND_OUT = 46;
/** Track pitch, nm (fitted to 500 GB, see the header), and the cylinders it makes of the band. */
export const PITCH_NM = 219;
export const CYLINDERS = Math.round(((BAND_OUT - BAND_IN) * 1e6) / PITCH_NM);
/** Actuator: the pivot's distance from the spindle, and the pivot-to-head length. */
export const PIVOT_D = 56, ARM_L = 46;

/** Tracks drawn (outer = 0), sectors drawn per track. Each drawn wedge is 1/16 of a track. */
export const TRACKS = 12, SECTORS = 16;
export const SECTOR_BYTES = 4096;
/** Sectors on the outermost track; a track holds that many × (its radius / the outer radius). */
export const OUTER_SECTORS = 358;
/** The data sheet's maximum media transfer rate, Mbit/s (HGST data sheet, 7K1000.B), and the capacity named. */
export const DATASHEET_MEDIA_MBIT = 1406, CAPACITY_NAMED_BYTES = 500e9;
/** Recording surfaces (a head each). */
export const SURFACES = HEADS;
/** Capacity of the drawn drive: surfaces × cylinders × the average track (bytes grow linearly with radius, so the band's mean radius). */
export const CAPACITY_BYTES = SURFACES * CYLINDERS * OUTER_SECTORS * SECTOR_BYTES * ((BAND_IN + BAND_OUT) / 2 / BAND_OUT);
/** Where the heads park: the load / unload ramp at the platters' outer edge (a 2.0 mm lift tab rides it; position approximate). */
export const RAMP_R = 49.5;

/** Drawn track pitch against the real one: how much bigger the rings are than a track. */
export const TRACK_PITCH_MM = (BAND_OUT - BAND_IN) / (TRACKS - 1);
export const PITCH_EXAGGERATION = (TRACK_PITCH_MM * 1e6) / PITCH_NM;

/** Seek datasheet points (ms): track to track, and the average over random pairs. Hitachi Deskstar 7K1000.B; Maxtor D740X: 0.8 / 8.5 / 17.8. */
export const SEEK_T2T_MS = 0.8, SEEK_AVG_MS = 8.5, SEEK_FULL_DATASHEET_MS = 15.1;
/** t(d) = A + B·√d for d ≥ 1 cylinders. For a distance |u − v|·N between uniform random cylinders, E[√d] = (8/15)·√N. */
export const SEEK_B = (SEEK_AVG_MS - SEEK_T2T_MS) / ((8 / 15) * Math.sqrt(CYLINDERS) - 1);
export const SEEK_A = SEEK_T2T_MS - SEEK_B;
export const seekMs = (d: number): number => (d <= 0 ? 0 : SEEK_A + SEEK_B * Math.sqrt(d));
export const FULL_STROKE_MS = seekMs(CYLINDERS - 1);

// ---------------------------------------------------------------- the flash model's clock

/** One cycle of the flash chapter's model in real microseconds: FLASH_REAL_US.read / FLASH_TIMES.read (25 µs / 64). */
export const FLASH_CYCLE_US = FLASH_REAL_US.read / FLASH_TIMES.read;
/** Real milliseconds → that model's cycles. */
export const modelCycles = (ms: number): number => Math.round((ms * 1000) / FLASH_CYCLE_US);
/** The same time at the CPU's own clock (dram/timing.ts CLOCK_NS), unscaled. */
export const cpuCycles = (ms: number): number => Math.round((ms * 1e6) / CLOCK_NS);
/** How many times shorter the model's cycle is than the CPU clock's: the "about 100×" scale the chapter states. */
export const SCALE_VS_CPU = (FLASH_CYCLE_US * 1000) / CLOCK_NS;

// ---------------------------------------------------------------- geometry

export const frac = (x: number): number => x - Math.floor(x);
/** Radius of drawn track k (0 outer). */
export const trackRadius = (k: number): number => BAND_OUT - (k * (BAND_OUT - BAND_IN)) / (TRACKS - 1);
/** The real cylinder drawn track k stands for (evenly spaced across the band). */
export const cylinderOf = (k: number): number => Math.round((k * (CYLINDERS - 1)) / (TRACKS - 1));
/** Cylinders between two drawn tracks. */
export const distance = (a: number, b: number): number => Math.abs(cylinderOf(a) - cylinderOf(b));
/** Bytes on a track at radius r (constant linear density: proportional to r), and one drawn wedge of it. */
export const trackBytes = (r: number): number => Math.round((OUTER_SECTORS * r) / BAND_OUT) * SECTOR_BYTES;
export const wedgeBytes = (r: number): number => trackBytes(r) / SECTORS;
/** Media rate at radius r, bytes a second: a track a turn. */
export const mediaRate = (r: number): number => (trackBytes(r) / TURN_MS) * 1000;

/** Where the head is when its distance from the spindle is r: x, z, the arm's angle at the pivot, the head's angle round the spindle (turns) and its skew (rad). */
export function headAt(r: number): { x: number; z: number; alpha: number; gamma: number; skew: number } {
  const alpha = Math.acos((PIVOT_D ** 2 + ARM_L ** 2 - r ** 2) / (2 * PIVOT_D * ARM_L));
  const x = PIVOT_D - ARM_L * Math.cos(alpha), z = ARM_L * Math.sin(alpha);
  const gamma = Math.atan2(z, x) / (2 * Math.PI);
  // Skew: the angle between the head (along the arm) and the track tangent, folded to +-90 degrees. Zero when pivot-head is perpendicular to spindle-head.
  let skew = Math.atan2(Math.sin(alpha), -Math.cos(alpha)) - (Math.atan2(z, x) + Math.PI / 2);
  skew = Math.atan2(Math.sin(skew), Math.cos(skew));
  if (skew > Math.PI / 2) skew -= Math.PI; else if (skew < -Math.PI / 2) skew += Math.PI;
  return { x, z, alpha, gamma, skew };
}
/** The radius at which the skew is zero: pivot, head and spindle make a right angle at the head. */
export const ZERO_SKEW_R = Math.sqrt(PIVOT_D ** 2 - ARM_L ** 2);

// ---------------------------------------------------------------- one read, planned

export type Kind = 'read' | 'write';
export interface Plan {
  /** A read, or a rewrite of the sector in place. */
  kind: Kind;
  /** The head started on the ramp (its seek is counted from the outer track). */
  fromRamp: boolean;
  t0: number; t1: number; t2: number; t3: number;
  from: number; to: number; sector: number;
  /** Real cylinders crossed. */
  cylinders: number;
  seek: number; wait: number; transfer: number; total: number;
}

/** A read of (track, sector) requested at virtual time t0 ms with the head on track `from`. */
export function planRead(t0: number, from: number, to: number, sector: number, opts: { kind?: Kind; fromRamp?: boolean } = {}): Plan {
  const cylinders = distance(from, to), seek = seekMs(cylinders), t1 = t0 + seek;
  const gamma = headAt(trackRadius(to)).gamma;
  const wait = frac(sector / SECTORS + gamma - t1 / TURN_MS) * TURN_MS;
  const transfer = TURN_MS / SECTORS, t2 = t1 + wait, t3 = t2 + transfer;
  return { kind: opts.kind ?? 'read', fromRamp: opts.fromRamp ?? false, t0, t1, t2, t3, from, to, sector, cylinders, seek, wait, transfer, total: t3 - t0 };
}

/** The wedge of a track passing under the head on `track` at virtual time t. */
export function sectorUnder(t: number, track: number): number {
  return Math.floor(frac(t / TURN_MS - headAt(trackRadius(track)).gamma) * SECTORS + 1e-9) % SECTORS;
}

export type Phase = 'idle' | 'seek' | 'wait' | 'transfer' | 'done';
export function phaseAt(plan: Plan | null, t: number): Phase {
  if (!plan || t < plan.t0) return 'idle';
  return t < plan.t1 ? 'seek' : t < plan.t2 ? 'wait' : t < plan.t3 ? 'transfer' : 'done';
}
const smooth = (u: number) => u * u * (3 - 2 * u);
/** The head's distance from the spindle at virtual time t: the actuator eases out and in over the seek. */
export function radiusAt(plan: Plan | null, parked: number | null, t: number): number {
  if (!plan) return parked === null ? RAMP_R : trackRadius(parked);
  const r0 = plan.fromRamp ? RAMP_R : trackRadius(plan.from), r1 = trackRadius(plan.to);
  if (t <= plan.t0) return r0;
  return t >= plan.t1 ? r1 : r0 + (r1 - r0) * smooth((t - plan.t0) / plan.seek);
}
// ---------------------------------------------------------------- compare and predict

/** The rewrite's one-line contrast with flash: the disk puts the data back where it was, flash must go to a fresh page and remap. */
export function rewriteLine(p: Plan): string {
  return `Rewritten in place: seek ${fmtMs(p.seek)} + latency ${fmtMs(p.wait)} + write ${fmtMs(p.transfer)} = ${fmtMs(p.total)}. Flash cannot do this: it programs a fresh page (${FLASH_REAL_US.program} µs), updates the table and leaves the old page stale.`;
}
/** After a read: the learner's guess against the time, and what the time is made of. */
export function guessLine(guessMs: number, p: Plan): string {
  const k = p.total / guessMs, share = (100 * p.transfer) / p.total;
  return `You guessed ${fmtMs(guessMs)}; it took ${fmtMs(p.total)} (${k >= 1 ? `${k.toFixed(1)}× more` : `${(1 / k).toFixed(1)}× less`}). Moving the head and waiting for the sector were ${(100 - share).toFixed(0)} % of it; reading the bits, ${share.toFixed(1)} %.`;
}
/** Eight requests (track, sector) and where the head starts: the elevator comparison. */
export const QUEUE: readonly { track: number; sector: number }[] = [[9, 4], [2, 13], [11, 1], [0, 8], [6, 15], [3, 6], [10, 10], [5, 2]].map(([track, sector]) => ({ track, sector }));
export const QUEUE_START = 5;
export interface QueueRun { total: number; seek: number; wait: number; transfer: number }
/** The queue served in the given order from the head on QUEUE_START at drive time 0 (each read starts when the last ended). */
export function queueRun(reqs: readonly { track: number; sector: number }[]): QueueRun {
  let t = 0, at = QUEUE_START;
  const r: QueueRun = { total: 0, seek: 0, wait: 0, transfer: 0 };
  for (const q of reqs) { const p = planRead(t, at, q.track, q.sector); r.seek += p.seek; r.wait += p.wait; r.transfer += p.transfer; t = p.t3; at = q.track; }
  r.total = t;
  return r;
}
export const queueSorted = (): { track: number; sector: number }[] => [...QUEUE].sort((a, b) => a.track - b.track);
export function queueLine(): string {
  const a = queueRun(QUEUE), b = queueRun(queueSorted());
  return `8 random reads: ${fmtMs(a.total)} in arrival order (seek ${fmtMs(a.seek)}), ${fmtMs(b.total)} sorted by track (seek ${fmtMs(b.seek)}). On flash the same eight cost ${fmtMs((8 * FLASH_REAL_US.read) / 1000)} in any order.`;
}

// ---------------------------------------------------------------- what is shown

export const fmtMs = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms.toFixed(2)) + ' ms';
/** The site's digit rule (sim/numfmt.ts): grouped by U+202F only from five digits. */
const fmtN = (n: number): string => groupNum(n);
const fmtBytes = (b: number): string => (b >= 2 ** 20 ? `${(b / 2 ** 20).toFixed(2)} MiB` : `${Math.round(b / 1024)} KiB`);

/** The rows of the readout, as text: the view prints exactly these, and the tests hold them to the model above. */
export function readoutRows(plan: Plan | null, parked: number | null, sel: { track: number; sector: number }): [string, string][] {
  const r = trackRadius(sel.track), rows: [string, string][] = [], write = plan?.kind === 'write';
  const from = plan && plan.t3 > plan.t0 ? plan.from : parked ?? 0;
  const d = distance(from, sel.track);
  rows.push(['Request', `${write ? 'rewrite ' : ''}track ${sel.track}, sector ${sel.sector} (r = ${r.toFixed(1)} mm)`]);
  if (plan ? plan.fromRamp : parked === null) rows.push(['Head', 'parked on the ramp: the seek is counted from the outer track']);
  rows.push(['Seek', `${fmtN(d)} cylinders → ${fmtMs(seekMs(d))}`]);
  if (plan) {
    rows.push(['Rotational latency', `${fmtMs(plan.wait)} (average ${fmtMs(AVG_LATENCY_MS)})`]);
    rows.push(['Transfer', `${fmtMs(plan.transfer)} · ${fmtBytes(wedgeBytes(r))} at ${(mediaRate(r) / 1e6).toFixed(0)} MB/s`]);
    rows.push(['Total', fmtMs(plan.total)]);
    rows.push(['In flash-model cycles', `${fmtN(modelCycles(plan.total))} (a flash page ${write ? `program: ${FLASH_TIMES.program}` : `read: ${FLASH_TIMES.read}`})`]);
    if (write) rows.push(['Against a flash page program', `${fmtN(Math.round((plan.total * 1000) / FLASH_REAL_US.program))}× slower, and the flash one went to a fresh page`]);
    else rows.push(['Against a flash page read', `${fmtN(Math.round((plan.total * 1000) / FLASH_REAL_US.read))}× slower`]);
  } else {
    rows.push(['Rotational latency', `0 … ${fmtMs(TURN_MS)}, average ${fmtMs(AVG_LATENCY_MS)}`]);
    rows.push(['Transfer', `${fmtMs(TURN_MS / SECTORS)} · ${fmtBytes(wedgeBytes(r))} at ${(mediaRate(r) / 1e6).toFixed(0)} MB/s`]);
  }
  return rows;
}

/** The rows describing the fitted drive, constant. */
export function driveRows(): [string, string][] {
  return [
    ['Spindle', `${RPM} rpm: one turn ${fmtMs(TURN_MS)}`],
    ['Seek model', `${SEEK_A.toFixed(3)} + ${SEEK_B.toFixed(5)}·√d ms`],
    ['1 cylinder · average · full stroke', `${fmtMs(seekMs(1))} · ${fmtMs(SEEK_AVG_MS)} · ${fmtMs(FULL_STROKE_MS)}`],
    ['Capacity', `${(CAPACITY_BYTES / 1e9).toFixed(0)} GB: ${SURFACES} surfaces × ${fmtN(CYLINDERS)} cylinders (${PITCH_NM} nm apart, fitted)`],
    ['Media rate', `${(mediaRate(BAND_OUT) / 1e6).toFixed(0)} MB/s on the outer track, ${(mediaRate(BAND_IN) / 1e6).toFixed(0)} on the inner (data sheet maximum ${DATASHEET_MEDIA_MBIT} Mbit/s)`],
    ['Flash-model clock', `1 cycle = ${Math.round(FLASH_CYCLE_US * 1000)} ns (${FLASH_REAL_US.read} µs ÷ ${FLASH_TIMES.read}), ${Math.round(SCALE_VS_CPU)}× the CPU clock's ${CLOCK_NS.toFixed(2)} ns`],
  ];
}

// ---------------------------------------------------------------- the drawing

export interface DiskPose {
  /** Platter angle, turns. */
  phi: number;
  /** The head's distance from the spindle, mm. */
  r: number;
  /** The requested wedge, or none. */
  sel: { track: number; sector: number } | null;
  phase: Phase;
}

export interface DiskPalette {
  base: RGB; platter: RGB; ring: RGB; mark: RGB; hub: RGB; steel: RGB; slider: RGB; copper: RGB; magnet: RGB; yoke: RGBA; magnetTop: RGBA; target: RGB; live: RGB;
}

const glow = (c: RGB, k = 0.6): RGB => [c[0] * k, c[1] * k, c[2] * k];
export const PLATTER_Y = [8, 13] as const;
const BLADE_Y = [PLATTER_Y[0] - PLATTER_T / 2 - 1.6, (PLATTER_Y[0] + PLATTER_Y[1]) / 2, PLATTER_Y[1] + PLATTER_T / 2 + 1.6] as const;
export const SURFACE_TOP = PLATTER_Y[1] + PLATTER_T / 2;
const GAP = 0.25, SLIDER_T = 0.35;
/** A pico slider is 1.25 × 1.0 × 0.3 mm (the 30 % size class; Berkeley CML head-disk-interface reports, US 2005/0275971). Drawn at twice that length and width so the head can be seen. */
export const PICO_MM = [1.25, 1.0, 0.3] as const;
export const SLIDER_DRAWN = [PICO_MM[0] * 2, SLIDER_T, PICO_MM[1] * 2] as const;
/** The load / unload ramp's centre radius and the spindle motor's stator radius (drawn approximately). */
export const RAMP_C = 52.5, MOTOR_R = 19;

/** A box of size (len along the direction, t, w across) centred at c, turned to point at world angle θ about y. */
function slab(c: RGB | RGBA, cx: number, cy: number, cz: number, len: number, t: number, w: number, yaw: number, spec = 0): Part {
  const p = box(c, -len / 2, len / 2, -t / 2, t / 2, -w / 2, w / 2, spec);
  return { ...p, pos: [cx, cy, cz], rot: quatAxisAngle([0, 1, 0], yaw) };
}
/** The yaw that points a slab's x axis along the xz direction (dx, dz). */
const yawOf = (dx: number, dz: number): number => -Math.atan2(dz, dx);

export function diskParts(p: DiskPose, P: DiskPalette): Part[] {
  const out: Part[] = [];
  const top = SURFACE_TOP, h = headAt(p.r);
  const lit = p.phase === 'transfer';
  // Base casting, and the platter stack: hub, platters, spacers, clamp.
  out.push(box(P.base, -52, 95, -4, 0, -51, 51, 0.2));
  out.push(cyl(P.hub, 0, 0, 0, PLATTER_Y[0] - PLATTER_T / 2, 16, 0.5));
  out.push(cyl(P.hub, 0, 0, PLATTER_Y[0] + PLATTER_T / 2, PLATTER_Y[1] - PLATTER_T / 2, 15, 0.5));
  for (const y of PLATTER_Y) out.push(cyl(P.platter, 0, 0, y - PLATTER_T / 2, y + PLATTER_T / 2, PLATTER_R, 0.9));
  out.push(cyl(P.hub, 0, 0, top, top + 2.4, 13.5, 0.6), cyl(P.steel, 0, 0, top + 2.4, top + 3.1, 5, 0.8));
  // The lower platter's top and the recording band on the top platter: concentric track rings, alternating tint.
  const ringY = top + 0.02;
  for (let k = 0; k < TRACKS; k++) {
    const r = trackRadius(k) + TRACK_PITCH_MM / 2;
    out.push(cyl(k % 2 ? P.ring : P.platter, 0, 0, top, ringY + 0.012 * k, r, 0.9));
  }
  // Sector boundaries: 16 radial lines turning with the platter; boundary s is the leading edge of wedge s.
  for (let s = 0; s < SECTORS; s++) {
    const w = 2 * Math.PI * (p.phi - s / SECTORS), y = ringY + 0.012 * TRACKS + 0.03;
    const a: Vec3 = [(BAND_IN - 1.5) * Math.cos(w), y, (BAND_IN - 1.5) * Math.sin(w)], b: Vec3 = [(BAND_OUT + 1.5) * Math.cos(w), y, (BAND_OUT + 1.5) * Math.sin(w)];
    out.push(rod(P.mark, a, b, s === 0 ? 0.22 : 0.1));
  }
  // The requested wedge on its track, in three chords of the arc.
  if (p.sel) {
    const r = trackRadius(p.sel.track), lead = 2 * Math.PI * (p.phi - p.sel.sector / SECTORS), y = ringY + 0.012 * TRACKS + 0.06;
    const n = 3, step = (2 * Math.PI) / SECTORS / n;
    for (let i = 0; i < n; i++) {
      const w = lead - step * (i + 0.5);
      const c = slab(lit ? P.live : P.target, r * Math.cos(w), y, r * Math.sin(w), 2 * r * Math.sin(step / 2) + 0.05, 0.1, TRACK_PITCH_MM * 0.8, -(w + Math.PI / 2), 0.3);
      if (lit) c.emissive = glow(P.live);
      out.push(c);
    }
  }
  // The actuator: pivot body, the comb of three blades, the tail with its coil.
  const px = PIVOT_D, dirX = -Math.cos(h.alpha), dirZ = Math.sin(h.alpha); // pivot → head
  const yaw = yawOf(dirX, dirZ), tailYaw = yawOf(-dirX, -dirZ);
  out.push(cyl(P.steel, px, 0, 3, BLADE_Y[2] + 1.2, 6, 0.8), cyl(P.hub, px, 0, BLADE_Y[2] + 1.2, BLADE_Y[2] + 2, 3.4, 0.6));
  const bladeLen = ARM_L - 16;
  BLADE_Y.forEach((by) => {
    for (const [from, to, w] of [[0, 0.5, 10], [0.5, 1, 5]] as const) {
      const m = ((from + to) / 2) * bladeLen;
      out.push(slab(P.steel, px + dirX * m, by, dirZ * m, (to - from) * bladeLen + 0.02, 0.6, w, yaw, 0.8));
    }
  });
  // Four heads: slider on the surface side of each blade, a spring beam from the blade to it.
  const heads: { by: number; ys: number; below: boolean; active: boolean }[] = [
    { by: BLADE_Y[0], ys: PLATTER_Y[0] - PLATTER_T / 2, below: true, active: false },
    { by: BLADE_Y[1], ys: PLATTER_Y[0] + PLATTER_T / 2, below: false, active: false },
    { by: BLADE_Y[1], ys: PLATTER_Y[1] - PLATTER_T / 2, below: true, active: false },
    { by: BLADE_Y[2], ys: top, below: false, active: true },
  ];
  for (const hd of heads) {
    const sy = hd.below ? hd.ys - GAP - SLIDER_T / 2 : hd.ys + GAP + SLIDER_T / 2;
    const s = slab(hd.active && p.phase !== 'idle' ? (lit ? P.live : P.target) : P.slider, h.x, sy, h.z, SLIDER_DRAWN[0], SLIDER_T, SLIDER_DRAWN[2], yaw, 0.6);
    if (hd.active && lit) s.emissive = glow(P.live);
    out.push(s);
    const root: Vec3 = [px + dirX * bladeLen, hd.by, dirZ * bladeLen];
    out.push(rod(P.steel, root, [h.x - dirX * SLIDER_DRAWN[0] / 2, sy + (hd.below ? -SLIDER_T / 2 : SLIDER_T / 2), h.z - dirZ * 1.2], 0.35, 0.7));
  }
  // The tail: a frame out to the coil, the coil itself (copper), swinging between the magnets.
  const tx = -dirX, tz = -dirZ, coilAt = 27;
  out.push(slab(P.steel, px + tx * 10, 10.5, tz * 10, 12, 0.7, 9, tailYaw, 0.8));
  out.push(slab(P.copper, px + tx * coilAt, 10.5, tz * coilAt, 22, 2.4, 15, tailYaw, 0.5));
  // The preamplifier on the top blade (a chip riding the arm), and the flex cable from the pivot to the connector on the base: a
  // fixed strip here, where the real one loops round the pivot as the arm swings.
  out.push(slab(P.slider, px + dirX * 9, BLADE_Y[2] + 0.6, dirZ * 9, 4, 0.6, 3, yaw, 0.4));
  out.push(rod(P.copper, [px, BLADE_Y[2] + 0.2, 0], [px + 22, 2, 26], 0.7, 0.2), box(P.hub, px + 14, px + 30, -1, 2, 22, 30, 0.3));
  // The load / unload ramp at the platters' edge, the arm's park position: a block at the head's radius when parked.
  const rp = headAt(RAMP_C);
  out.push(slab(P.hub, rp.x, (PLATTER_Y[0] + PLATTER_Y[1]) / 2, rp.z, 3, PLATTER_Y[1] - PLATTER_Y[0] + 6, 6, yaw, 0.4));
  // The spindle motor: stator ring and windings below the lowest platter, round the hub.
  out.push(cyl(P.copper, 0, 0, 0.3, 2.2, MOTOR_R, 0.4), cyl(P.steel, 0, 0, 2.2, PLATTER_Y[0] - PLATTER_T / 2, 14.5, 0.7));
  // The voice-coil magnets (neodymium) and their steel return plates, fixed; the top ones see-through.
  out.push(box(P.yoke, 62, 94, 4.2, 5.6, -36, 0, 0.7), box(P.magnet, 63, 93, 5.6, 8.4, -35, -1, 0.3));
  out.push(box(P.magnetTop, 63, 93, 12.6, 15.4, -35, -1, 0.3), box(P.yoke, 62, 94, 15.4, 16.8, -36, 0, 0.7));
  return out;
}

export function diskAnchors(p: DiskPose): Anchor[] {
  const front: Vec3 = [0, 0.5, 1], up: Vec3 = [0, 1, 0], h = headAt(p.r), top = SURFACE_TOP;
  const dirX = -Math.cos(h.alpha), dirZ = Math.sin(h.alpha), tail = 27;
  const out: Anchor[] = [
    { text: 'spindle hub', p: [0, top + 3.1, 0], side: 'l', n: up, minor: true },
    { text: 'platters, 95 mm', p: [-34, PLATTER_Y[1], 32], side: 'r', n: front },
    { text: 'head', p: [h.x, top + 0.6, h.z], side: 'b', n: up },
    { text: 'actuator arm', p: [PIVOT_D + dirX * 24, BLADE_Y[2] + 0.4, dirZ * 24], side: 't', n: up, minor: true },
    { text: 'pivot', p: [PIVOT_D, BLADE_Y[2] + 2, 0], side: 't', n: up, minor: true },
    { text: 'voice coil', p: [PIVOT_D - dirX * tail, 10.5, -dirZ * tail], side: 'b', n: up, minor: true },
    { text: 'magnet', p: [78, 16.8, -34], side: 't', n: up, minor: true },
    { text: 'ramp (park)', p: [headAt(RAMP_C).x, PLATTER_Y[1] + 3.5, headAt(RAMP_C).z], side: 'r', n: up, minor: true },
    { text: 'preamp', p: [PIVOT_D + dirX * 9, BLADE_Y[2] + 1, dirZ * 9], side: 'r', n: up, minor: true },
    { text: 'flex cable', p: [PIVOT_D + 18, 4, 20], side: 'b', n: up, minor: true },
    { text: 'spindle motor', p: [-MOTOR_R, 1.2, 0], side: 'l', n: up, minor: true },
  ];
  return out;
}
