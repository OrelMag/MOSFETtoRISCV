// A whole image sensor die, as parts (DOM-free, tested): the pixel array, the row decoder and drivers beside it, a
// single-slope ADC per column below it (a shared ramp, a comparator and a counter each) and the readout to the output.
// The sensor is the chapter's IMX183 (phys/imagesensor.ts): its array is drawn to scale (5544 × 3694 pixels of 2.4 µm,
// 13.3 × 8.9 mm), in cells of CELL × CELL pixels; the periphery is drawn, not measured.
//
// A lens forms an image of a moving object (a bar crossing, or a propeller turning) on the array. Each cell's value is
// that image integrated over the cell's own exposure window (imagesensor.ts exposureWindow): a rolling shutter starts
// every row a row time after the last, a global one exposes every row together and then reads them out row by row. So
// the rolling shutter's skew is not drawn: it comes out of the timing, as on the chip.

import type { RGB, RGBA } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { box, rod, type Anchor, type Part } from '../gl/parts';
import { IMX183, exposureWindow, rowTime } from '../phys/imagesensor';

export type Shutter = 'rolling' | 'global';
export type SceneKind = 'bar' | 'prop';

/** Pixels a drawn cell stands for: 5544 = 66 × 84 columns, 3694 ≈ 44 × 84 rows (the last cell row 82). */
export const CELL = 84;
export const COLS = Math.ceil(IMX183.cols / CELL), ROWS = Math.ceil(IMX183.rows / CELL);
/** One frame (s): the IMX183 at 21.98 frame/s; a row time (s), derived from it (blanking ignored). */
export const FRAME = 1 / IMX183.fps, T_ROW = rowTime(IMX183);

export interface Scene {
  kind: SceneKind;
  /** Bar: speed in pixels/s (positive to the right), width in pixels. */
  v: number; width: number;
  /** Propeller: turns a second, blades, radius in pixels. */
  rps: number; blades: number; radius: number;
}
export const defaultScene = (kind: SceneKind): Scene => ({
  kind, v: IMX183.cols / 0.1, width: 360, rps: 25, blades: 3, radius: 0.46 * IMX183.rows,
});

/** Is the object's image over pixel (x, y) (pixel coordinates, column, row) at time t (s)? */
export function covered(s: Scene, x: number, y: number, t: number): boolean {
  const W = IMX183.cols, H = IMX183.rows;
  if (s.kind === 'bar') {
    // A tenth of the way across at t = 0, wrapping round once it leaves.
    const span = W + s.width, x0 = ((((0.1 * W + s.width + s.v * t) % span) + span) % span) - s.width;
    return x >= x0 && x < x0 + s.width;
  }
  const dx = x - W / 2, dy = y - H / 2, r = Math.hypot(dx, dy);
  if (r > s.radius) return false;
  if (r < 0.05 * H) return true; // the hub
  // A blade is a strip of constant width (16 % of the radius), turning about the hub.
  const a = Math.atan2(dy, dx) - 2 * Math.PI * s.rps * t, half = (0.08 * s.radius) / r;
  for (let k = 0; k < s.blades; k++) {
    const d = Math.abs(Math.atan2(Math.sin(a - (2 * Math.PI * k) / s.blades), Math.cos(a - (2 * Math.PI * k) / s.blades)));
    if (d < Math.asin(Math.min(1, half))) return true;
  }
  return false;
}

/** A cell's centre in pixel coordinates. */
export const cellPx = (c: number, r: number): [number, number] => [Math.min(IMX183.cols, (c + 0.5) * CELL), Math.min(IMX183.rows - 1, (r + 0.5) * CELL)];
/** The sensor row a cell row's exposure and readout follow (its middle row). */
export const cellRow = (r: number): number => Math.min(IMX183.rows - 1, Math.round((r + 0.5) * CELL));

/** When cell row r is read out: the end of its exposure window (rolling), or after the common exposure (global). */
export function readTime(r: number, shutter: Shutter, texp: number): number {
  const row = cellRow(r);
  return shutter === 'rolling' ? exposureWindow(row, texp, 'rolling', T_ROW)[1] : texp + row * T_ROW;
}
/** The time the last cell row is read: the end of the frame's capture. */
export const captureEnd = (shutter: Shutter, texp: number): number => readTime(ROWS - 1, shutter, texp);

const SAMPLES = 16;
/**
 * Light a cell gathered by time `now` (0 dark … 1 the full exposure of the bright background), the object dark: the
 * share of samples in its exposure window, up to now, where the object's image is not over its centre.
 */
export function cellValue(s: Scene, c: number, r: number, shutter: Shutter, texp: number, now = Infinity): number {
  const [a, b] = exposureWindow(cellRow(r), texp, shutter, T_ROW), [x, y] = cellPx(c, r), end = Math.min(b, now);
  if (end <= a) return 0;
  let lit = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const t = a + ((i + 0.5) * (b - a)) / SAMPLES;
    if (t <= end && !covered(s, x, y, t)) lit++;
  }
  return lit / SAMPLES;
}

/** The whole captured frame, rows of cells. */
export const captureFrame = (s: Scene, shutter: Shutter, texp: number): number[][] =>
  Array.from({ length: ROWS }, (_, r) => Array.from({ length: COLS }, (_, c) => cellValue(s, c, r, shutter, texp)));

// ---------------------------------------------------------------- where everything is

/** Drawing units: 1 = 0.1 mm. The array is to scale. */
export const MM = 10;
export const AW = (IMX183.cols * IMX183.pitch * 1e-3) * MM, AH = (IMX183.rows * IMX183.pitch * 1e-3) * MM;
export const CW = AW / (IMX183.cols / CELL), CH = AH / (IMX183.rows / CELL);
/** Cell (c, r)'s centre in the drawing: columns along x, rows along z (row 0 at the far edge). */
export const cellXZ = (c: number, r: number): [number, number] => [-AW / 2 + (c + 0.5) * CW, -AH / 2 + (r + 0.5) * CH];
const Y0 = 1.2; // the array's top over the die
const DEC_X0 = -AW / 2 - 18, DEC_X1 = -AW / 2 - 3, ADC_Z0 = AH / 2 + 3, ADC_Z1 = AH / 2 + 19;
const IMG_Y = 9; // the image plane drawn above the array

export interface DiePalette { die: RGB; pad: RGB; logic: RGB; dark: RGB; lit: RGB; idle: RGB; expose: RGB; read: RGB; img: RGBA; metal: RGB }

export interface DiePose {
  scene: Scene; shutter: Shutter; texp: number;
  /** Sensor time (s) since the first row's reset. */
  now: number;
}

/** Which cell rows are exposing at `now`, which one is being read (null: none), and where the ramp is (0–1). */
export function dieState(q: DiePose): { exposing: boolean[]; reading: number | null; ramp: number; done: boolean[] } {
  const exposing: boolean[] = [], done: boolean[] = [];
  let reading: number | null = null, ramp = 0;
  for (let r = 0; r < ROWS; r++) {
    const [a, b] = exposureWindow(cellRow(r), q.texp, q.shutter, T_ROW), rd = readTime(r, q.shutter, q.texp);
    exposing.push(q.now >= a && q.now < b);
    done.push(q.now >= rd + T_ROW * CELL);
    // A drawn row is read over the CELL sensor rows it stands for; the ramp is shown once a drawn row.
    if (q.now >= rd && q.now < rd + T_ROW * CELL) { reading = r; ramp = (q.now - rd) / (T_ROW * CELL); }
  }
  return { exposing, reading, ramp, done };
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function dieParts(q: DiePose, P: DiePalette): Part[] {
  const out: Part[] = [], st = dieState(q);
  // The die: substrate, bond pads round the edge.
  const X0 = DEC_X0 - 6, X1 = AW / 2 + 26, Z0 = -AH / 2 - 10, Z1 = ADC_Z1 + 8;
  out.push(box(P.die, X0, X1, -1.5, 0, Z0, Z1));
  for (let x = X0 + 4; x < X1 - 2; x += 6) for (const z of [Z0 + 2, Z1 - 2]) out.push(box(P.pad, x - 1.6, x + 1.6, 0, 0.4, z - 1.6, z + 1.6, 0.6));
  for (let z = Z0 + 8; z < Z1 - 6; z += 6) for (const x of [X0 + 2, X1 - 2]) out.push(box(P.pad, x - 1.6, x + 1.6, 0, 0.4, z - 1.6, z + 1.6, 0.6));
  // The pixel array: a cell's colour is what it holds now (read: its value; exposing: charging; else reset).
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const [x, z] = cellXZ(c, r);
    let col: RGB;
    if (st.done[r] || (st.reading !== null && r === st.reading)) col = mix(P.dark, P.lit, cellValue(q.scene, c, r, q.shutter, q.texp));
    else if (q.now >= exposureWindow(cellRow(r), q.texp, q.shutter, T_ROW)[0]) col = mix(P.idle, P.expose, cellValue(q.scene, c, r, q.shutter, q.texp, q.now));
    else col = P.idle;
    out.push(box(col, x - CW * 0.46, x + CW * 0.46, 0, Y0, z - CH * 0.46, z + CH * 0.46));
  }
  // Row decoder and drivers: a driver a cell row; the rows exposing tinted, the row being read lit.
  for (let r = 0; r < ROWS; r++) {
    const [, z] = cellXZ(0, r), on = st.reading === r, exp = st.exposing[r];
    const d = box(on ? P.read : exp ? P.expose : P.logic, DEC_X1 - 8, DEC_X1, 0, Y0, z - CH * 0.42, z + CH * 0.42);
    if (on) d.emissive = mix([0, 0, 0], P.read, 0.6);
    out.push(d);
  }
  out.push(box(P.logic, DEC_X0, DEC_X1 - 9, 0, Y0 + 0.6, -AH / 2, AH / 2)); // the decoder
  // Column ADCs: a comparator and a counter per drawn column; the counter's height is its count, which stops when the
  // ramp passes the column's level (a brighter pixel, a later flip, a larger count).
  const rampDone = st.reading !== null ? st.ramp : 0;
  for (let c = 0; c < COLS; c++) {
    const [x] = cellXZ(c, 0), v = st.reading !== null ? cellValue(q.scene, c, st.reading, q.shutter, q.texp) : 0;
    const flipped = st.reading !== null && rampDone >= v, count = st.reading === null ? 0 : Math.min(rampDone, v);
    const cmp = box(flipped ? P.read : P.logic, x - CW * 0.4, x + CW * 0.4, 0, Y0, ADC_Z0, ADC_Z0 + 4);
    if (flipped) cmp.emissive = mix([0, 0, 0], P.read, 0.4);
    out.push(cmp, box(P.logic, x - CW * 0.4, x + CW * 0.4, 0, Y0 * 0.6, ADC_Z0 + 5, ADC_Z1));
    if (count > 0) out.push(box(P.read, x - CW * 0.3, x + CW * 0.3, Y0 * 0.6, Y0 * 0.6 + 8 * count, ADC_Z0 + 6, ADC_Z1 - 1));
  }
  // The ramp generator (a DAC) and the ramp wire to every comparator, raised to the ramp's level.
  out.push(box(P.logic, DEC_X0, DEC_X1, 0, Y0 + 0.6, ADC_Z0, ADC_Z1));
  const ry = Y0 + 0.4 + 6 * rampDone;
  out.push(rod(st.reading !== null ? P.read : P.metal, [DEC_X1, ry, ADC_Z0 + 2], [AW / 2, ry, ADC_Z0 + 2], 0.35));
  // The readout: the counters shifted out along a bus to the output block.
  out.push(rod(P.metal, [-AW / 2, Y0, ADC_Z1 + 2], [AW / 2 + 6, Y0, ADC_Z1 + 2], 0.5));
  out.push(box(P.logic, AW / 2 + 6, AW / 2 + 22, 0, Y0 + 1, ADC_Z0 - 6, ADC_Z1 + 4));
  // The image the lens forms, drawn on a plane above the array: where the object is now.
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const [px, py] = cellPx(c, r);
    if (!covered(q.scene, px, py, q.now)) continue;
    const [x, z] = cellXZ(c, r);
    out.push(box(P.img, x - CW / 2, x + CW / 2, IMG_Y, IMG_Y + 0.3, z - CH / 2, z + CH / 2));
  }
  return out;
}

export function dieAnchors(q: DiePose): Anchor[] {
  const st = dieState(q), up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.4, 1];
  const a: Anchor[] = [
    { text: `pixel array, ${IMX183.cols} × ${IMX183.rows}`, p: [AW / 2, Y0, -AH / 2], side: 'r', n: up },
    { text: 'row decoder and drivers', p: [DEC_X0, Y0, -AH / 2 + 8], side: 'l', n: up },
    { text: 'column ADCs: comparator and counter', p: [0, Y0, ADC_Z1], side: 'b', n: front },
    { text: 'ramp', p: [DEC_X0, Y0, (ADC_Z0 + ADC_Z1) / 2], side: 'l', n: front, minor: true },
    { text: 'readout to the output', p: [AW / 2 + 22, Y0 + 1, ADC_Z1], side: 'r', n: front, minor: true },
    { text: 'the image the lens forms', p: [-AW / 2, IMG_Y, -AH / 2], side: 't', n: up, minor: true },
  ];
  if (st.reading !== null) a.push({ text: 'row being read', p: [DEC_X1 - 8, Y0, cellXZ(0, st.reading)[1]], side: 'l', n: up, minor: true });
  return a;
}

/** A time to three significant figures, trailing zeros dropped: 45.5 ms, 12.3 µs, 500 µs, 1 ms. */
export function fmtTime(s: number): string {
  const [v, u] = s >= 1 ? [s, 's'] : s >= 1e-3 ? [s * 1e3, 'ms'] : [s * 1e6, 'µs'];
  return `${Number(v.toPrecision(3))} ${u}`;
}
