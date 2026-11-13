// A whole image sensor die: the timing and the layout (DOM-free, tested; drawn by sensordie3dkit.ts): the pixel array, the row decoder and drivers beside it, a
// single-slope ADC per column below it (a shared ramp, a comparator and a counter each) and the readout to the output.
// The sensor is the chapter's IMX183 (phys/imagesensor.ts): its array is drawn to scale (5544 × 3694 pixels of 2.4 µm,
// 13.3 × 8.9 mm), in cells of CELL × CELL pixels; the periphery is drawn, not measured.
//
// A lens forms an image of a moving object (a bar crossing, or a propeller turning) on the array. Each cell's value is
// that image integrated over the cell's own exposure window (imagesensor.ts exposureWindow): a rolling shutter starts
// every row a row time after the last, a global one exposes every row together and then reads them out row by row. So
// the rolling shutter's skew is not drawn: it comes out of the timing, as on the chip.

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
  // 3 rev/s, as the chapter's 2D shutter widget: the blades turn 49° while the frame is read, so the bend shows without the
  // aliasing a faster propeller gives (25 rev/s is 1.14 turns a frame: the blades seem to jump).
  kind, v: IMX183.cols / 0.1, width: 360, rps: 3, blades: 3, radius: 0.46 * IMX183.rows,
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

/**
 * Every cell's SAMPLES, taken once per scene, shutter and exposure: bit i of `lit` is set where sample i sees the background,
 * and the sample times depend only on the cell's row. A slow-motion tick then counts the bits whose time has come instead of
 * redoing 46 000 image tests (dieParts ran at 13 frames/s on a throttled phone), with the same numbers as cellValue.
 */
interface Samples { key: string; lit: Uint16Array; t: Float64Array }
let samples: Samples | null = null;
function samplesOf(s: Scene, shutter: Shutter, texp: number): Samples {
  const key = `${s.kind} ${s.v} ${s.width} ${s.rps} ${s.blades} ${s.radius} ${shutter} ${texp}`;
  if (samples?.key === key) return samples;
  const lit = new Uint16Array(ROWS * COLS), t = new Float64Array(ROWS * SAMPLES);
  for (let r = 0; r < ROWS; r++) {
    const [a, b] = exposureWindow(cellRow(r), texp, shutter, T_ROW);
    for (let i = 0; i < SAMPLES; i++) t[r * SAMPLES + i] = a + ((i + 0.5) * (b - a)) / SAMPLES;
    for (let c = 0; c < COLS; c++) {
      const [x, y] = cellPx(c, r);
      let m = 0;
      for (let i = 0; i < SAMPLES; i++) if (!covered(s, x, y, t[r * SAMPLES + i])) m |= 1 << i;
      lit[r * COLS + c] = m;
    }
  }
  return (samples = { key, lit, t });
}
/** cellValue(s, c, r, shutter, texp, now), read from the cached samples. */
export function cellLight(s: Scene, c: number, r: number, shutter: Shutter, texp: number, now = Infinity): number {
  const S = samplesOf(s, shutter, texp), m = S.lit[r * COLS + c];
  let n = 0;
  // a sample counts once its time has come: the times rise with i and all lie inside the window, so t <= min(b, now) is t <= now
  for (let i = 0; i < SAMPLES && S.t[r * SAMPLES + i] <= now; i++) n += (m >> i) & 1;
  return n / SAMPLES;
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
export const Y0 = 1.2; // the array's top over the die
export const DEC_X0 = -AW / 2 - 18, DEC_X1 = -AW / 2 - 3, ADC_Z0 = AH / 2 + 3, ADC_Z1 = AH / 2 + 19;
export const IMG_Y = 9; // the image plane drawn above the array

/** Optical black: a strip of pixels under metal along the array's top and left edges (drawn wider than it is), read with
 *  the active rows: they see no light, so what they read is the dark level to subtract. */
export const OB_W = 3;
/** Where the shutter's pointers are now, in sensor rows (fractional; null: off the array). Rolling: the reset pointer
 *  starts each row's exposure, the read pointer follows one exposure behind. Global: every row is reset at once at 0. */
export function pointers(shutter: Shutter, texp: number, now: number): { reset: number | null; read: number | null } {
  const on = (r: number) => (r >= 0 && r < IMX183.rows ? r : null);
  return { reset: shutter === 'rolling' ? on(now / T_ROW) : null, read: on((now - texp) / T_ROW) };
}
/** A sensor row's z in the drawing. */
export const rowZ = (row: number): number => -AH / 2 + (row / IMX183.rows) * AH;
/** Of a drawn row's read time, the share the ramp takes; the counters are then shifted out to the output. */
export const RAMP_SHARE = 0.7;

export interface DiePose {
  scene: Scene; shutter: Shutter; texp: number;
  /** Sensor time (s) since the first row's reset. */
  now: number;
}

/** Which cell rows are exposing at `now`, which one is being read (null: none), and where the ramp is (0–1). */
export function dieState(q: DiePose): { exposing: boolean[]; reading: number | null; ramp: number; shift: number | null; done: boolean[] } {
  const exposing: boolean[] = [], done: boolean[] = [];
  let reading: number | null = null, ramp = 0;
  for (let r = 0; r < ROWS; r++) {
    const [a, b] = exposureWindow(cellRow(r), q.texp, q.shutter, T_ROW), rd = readTime(r, q.shutter, q.texp);
    exposing.push(q.now >= a && q.now < b);
    done.push(q.now >= rd + T_ROW * CELL);
    // A drawn row is read over the CELL sensor rows it stands for; the ramp is shown once a drawn row.
    if (q.now >= rd && q.now < rd + T_ROW * CELL) { reading = r; ramp = (q.now - rd) / (T_ROW * CELL); }
  }
  // The ramp over its share of the row's time, then the counters shifted out (shift: 0–1 along the bus, null while ramping).
  const shift = reading !== null && ramp >= RAMP_SHARE ? (ramp - RAMP_SHARE) / (1 - RAMP_SHARE) : null;
  return { exposing, reading, ramp: Math.min(1, ramp / RAMP_SHARE), shift, done };
}

/** A time to three significant figures, trailing zeros dropped: 45.5 ms, 12.3 µs, 500 µs, 1 ms. */
export function fmtTime(s: number): string {
  const [v, u] = s >= 1 ? [s, 's'] : s >= 1e-3 ? [s * 1e3, 'ms'] : [s * 1e6, 'µs'];
  return `${Number(v.toPrecision(3))} ${u}`;
}
