// A 3.5" 7200 rpm hard disk as parts and a timing model (DOM-free, tested). Units are millimetres.
//
// What is real (representative of a 3.5" desktop drive; sources in the commit message and the on-screen note):
//   platter 95 mm across, 25 mm hole; two platters, four heads; recording band r = 20 … 46 mm; a rotary voice-coil actuator
//   pivoting 56 mm from the spindle, head 46 mm from its pivot (zero skew near mid-band); 7200 rpm. The platter's 1.27 mm
//   thickness is illustrative (no source found for a drive of this era).
// The drive named is the Hitachi Deskstar 7K1000.B 500 GB (HDT721050SLA360). Its data sheet (HGST DSDS721008EN-01, read at
//   https://cdn.inet.se/pdf/4303432_0.pdf) gives a maximum media transfer rate of 1388 Mbit/s and, for the family, a maximum
//   areal density of 270 Gbit/in²; it gives no tracks per inch and no platter count (two for 500 GB is our assumption: the
//   1 TB model has three). So OUTER_SECTORS is set from the media rate (the outer track at 7200 rpm must pass 1388 Mbit/s) and
//   the track pitch is then chosen so the capacity comes to 500 GB: both are fits, not data-sheet values (the result, about
//   118 ktpi and 120 Gbit/in² at the outer edge, is plausible for a 500 GB two-platter model below the family maximum).
//   Sectors are drawn as 4 KiB (eight real 512-byte ones), zoned density in effect.
// What the timing is: seek = a + b·√distance, fitted to a track-to-track and an average seek; rotation is exact,
//   so the rotational latency is wherever the sector happens to be when the arm arrives; transfer is the sector's arc.
// What is drawn bigger than it is: the tracks (12 rings stand for CYLINDERS), the flying height, the platter spacing.

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
export const PITCH_NM = 216;
export const CYLINDERS = Math.round(((BAND_OUT - BAND_IN) * 1e6) / PITCH_NM);
/** Actuator: the pivot's distance from the spindle, and the pivot-to-head length. */
export const PIVOT_D = 56, ARM_L = 46;

/** Tracks drawn (outer = 0), sectors drawn per track. Each drawn wedge is 1/16 of a track. */
export const TRACKS = 12, SECTORS = 16;
export const SECTOR_BYTES = 4096;
/** Sectors on the outermost track; a track holds that many × (its radius / the outer radius). */
export const OUTER_SECTORS = 353;
/** The data sheet's maximum media transfer rate, Mbit/s (HGST DSDS721008EN-01, 7K1000.B), and the capacity named. */
export const DATASHEET_MEDIA_MBIT = 1388, CAPACITY_NAMED_BYTES = 500e9;
/** Recording surfaces (a head each). */
export const SURFACES = HEADS;
/** Capacity of the drawn drive: surfaces × cylinders × the average track (bytes grow linearly with radius, so the band's mean radius). */
export const CAPACITY_BYTES = SURFACES * CYLINDERS * OUTER_SECTORS * SECTOR_BYTES * ((BAND_IN + BAND_OUT) / 2 / BAND_OUT);
/** Where the heads park: the load / unload ramp at the platters' outer edge (a 2.0 mm lift tab rides it; position approximate). */
export const RAMP_R = 49.5;

/** Drawn track pitch against the real one: how much bigger the rings are than a track. */
export const TRACK_PITCH_MM = (BAND_OUT - BAND_IN) / (TRACKS - 1);
export const PITCH_EXAGGERATION = (TRACK_PITCH_MM * 1e6) / PITCH_NM;

/** Seek points (ms): track to track, and the average over random pairs. The 7K1000.B data sheet has no seek table: 8.5 ms average is
 *  the Deskstar E7K1000 sheet's (its enterprise sibling), 0.8 ms track-to-track a retro-hardware listing's; 15.1 ms full stroke is unsourced. */
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
/** Time (ms) one 4 KiB block (eight 512-byte sectors) takes to pass under the head at radius r: what a read transfers. The 16 drawn
 *  wedges are only places round the track; a real track there holds about 180 to 360 such blocks. */
export const blockMs = (r: number): number => (SECTOR_BYTES / mediaRate(r)) * 1000;

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
  const transfer = blockMs(trackRadius(to)), t2 = t1 + wait, t3 = t2 + transfer;
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

export const fmtMs = (ms: number): string => (ms >= 100 ? ms.toFixed(0) : ms >= 10 ? ms.toFixed(1) : ms >= 0.1 ? ms.toFixed(2) : ms.toFixed(3)) + ' ms';
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
    rows.push(['Transfer', `${fmtMs(plan.transfer)} · one 4 KiB block at ${(mediaRate(r) / 1e6).toFixed(0)} MB/s`]);
    rows.push(['Total', fmtMs(plan.total)]);
    rows.push(['In flash-model cycles', `${fmtN(modelCycles(plan.total))} (a flash page ${write ? `program: ${FLASH_TIMES.program}` : `read: ${FLASH_TIMES.read}`})`]);
    if (write) rows.push(['Against a flash page program', `${fmtN(Math.round((plan.total * 1000) / FLASH_REAL_US.program))}× slower, and the flash one went to a fresh page`]);
    else rows.push(['Against a flash page read', `${fmtN(Math.round((plan.total * 1000) / FLASH_REAL_US.read))}× slower`]);
  } else {
    rows.push(['Rotational latency', `0 … ${fmtMs(TURN_MS)}, average ${fmtMs(AVG_LATENCY_MS)}`]);
    rows.push(['Transfer', `${fmtMs(blockMs(r))} · one 4 KiB block at ${(mediaRate(r) / 1e6).toFixed(0)} MB/s`]);
    rows.push(['This track', `${fmtBytes(trackBytes(r))}: the drawn wedge is a place on it, ${fmtBytes(wedgeBytes(r))} of real sectors`]);
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

// ---------------------------------------------------------------- the drawing's dimensions (disk3dkit.ts draws it)

/** The two platters' mid-planes, mm above the casting's floor. */
export const PLATTER_Y = [8, 13] as const;
export const SURFACE_TOP = PLATTER_Y[1] + PLATTER_T / 2;
const SLIDER_T = 0.35;
/** A pico slider is 1.25 × 1.0 × 0.3 mm (the 30 % size class; Berkeley CML head-disk-interface reports, US 2005/0275971). Drawn at twice that length and width so the head can be seen. */
export const PICO_MM = [1.25, 1.0, 0.3] as const;
export const SLIDER_DRAWN = [PICO_MM[0] * 2, SLIDER_T, PICO_MM[1] * 2] as const;
