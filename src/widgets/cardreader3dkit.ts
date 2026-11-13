// The card reader on the studio renderer (DOM-free, tested: tests/cardreader3dkit.test.ts). The reader is still the chapter's
// leaf stepped edge by edge (cardreader3dparts.ts ReaderRun, readerLayout): what is drawn is that leaf's state. New here: the
// card is a solid with its holes cut through it (a hole is a hole, not a dark box), the rolls are turned, a brush is a bent
// strip of phosphor bronze that drops through a hole to the contact roll, and a cut across one column shows it doing so.
// The cards on the bed are moved each frame (Moves), the brushes, cells, beams and panel lamps are instanced each frame, so
// the model itself is rebuilt only when a card arrives, leaves or is turned.
//
// 1 unit = 2.5 mm, x along the card's path (hopper → stacker), y up, z across the path.

import { lathe, merge, roundedBox, sweep, transform, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Instance, RGB } from '../gl/instances';
import type { Mat4, Vec3 } from '../gl/math';
import { COLUMNS } from '../cards/card';
import type { ReaderMode } from '../cards/reader';
import {
  BED, CARD_L, CARD_S, CARD_T, CARD_T_REAL, COL_P, CORNER, HOLE_C, HOLE_R, MACHINES, ROWS, ROW_P, SEPARATION, STATION2_X, STATION_X,
  colOff, cornerSigns, lampX, LAMP_Y, readerAnchors, rowOff, type Orient, type ReaderLayout, type ReaderRun,
} from './cardreader3dparts';

/** The figures and where they come from (the test holds the drawing to them). */
export const SRC = {
  card: 'IBM card: 7⅜ × 3¼ in, 0.007 in thick, columns 0.087 in apart, rows ¼ in, holes 0.055 × 0.125 in, corner cut ¼ in (ANSI X3.21 / ISO 1681)',
  speeds: 'IBM 711: 150 cards a minute (250 on the 7090); IBM 2501: 600 or 1000 (Wikipedia, "IBM 711", "IBM 2501")',
  twice: 'the IBM 1402 read every card at two brush stations and compared them; the 2501 read every column twice (Wikipedia, "IBM 2501"); no source gives the 711 a second station',
  drawn: 'drawn: no source found for its size or shape',
} as const;

export interface ReaderRgb { live: RGB; brass: RGB; cellOff: RGB; lampOff: RGB; alarm: RGB; beam: RGB }

export interface ReaderLook {
  detail: 'full' | 'flat';
  run: ReaderRun;
  /** Where the cards are now (readerLayout at the frame's u). */
  L: ReaderLayout;
  next: 0 | 1;
  rgb: ReaderRgb;
}

// ---------------------------------------------------------------- small helpers

const cache = new Map<string, Geo>();
const once = (key: string, make: () => Geo): Geo => { let g = cache.get(key); if (!g) { g = make(); cache.set(key, g); } return g; };
const T = (x: number, y = 0, z = 0): Mat4 => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
export const moveX = (x: number): Mat4 => T(x);
/** A lathe's axis (y) laid along z: a roll across the path. */
const ON_Z: Mat4 = new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]);
const onZ = (g: Geo, x: number, y: number): Geo => transform(transform(g, ON_Z), T(x, y, 0));
const boxAt = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r ? 2 : 1), T((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2));
/** A solid cylinder of radius r from -h to h along its axis (y). */
const rodGeo = (r: number, h: number, seg = 24) => lathe([[0, -h], [r, -h], [r, h], [0, h]], { seg, crease: 50 });

// ---------------------------------------------------------------- the card, its holes cut through it

type P2 = [number, number];
/** Clip a convex polygon (x, z) to the half-plane a·x + b·z ≤ c (Sutherland–Hodgman). */
function clip(poly: P2[], a: number, b: number, c: number): P2[] {
  const out: P2[] = [], f = (p: P2) => a * p[0] + b * p[1] - c;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], fp = f(p), fq = f(q);
    if (fp <= 0) out.push(p);
    if ((fp < 0 && fq > 0) || (fp > 0 && fq < 0)) { const t = fp / (fp - fq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
  }
  return out;
}

/** The holes of a card lying at the origin, as rectangles (x0, x1, z0, z1): word mode crosswise, column mode lengthwise. */
export function holeRects(mode: ReaderMode, cols: readonly number[]): [number, number, number, number][] {
  const m = MACHINES[mode], wide = mode === 'word', hx = (wide ? HOLE_R : HOLE_C) / 2, hz = (wide ? HOLE_C : HOLE_R) / 2, out: [number, number, number, number][] = [];
  for (let c = 0; c < COLUMNS; c++) for (let r = 0; r < ROWS; r++) if ((cols[c] >> r) & 1) { const [x, z] = m.hole(0, c, r); out.push([x - hx, x + hx, z - hz, z + hz]); }
  return out;
}

/**
 * A card centred on the origin, `t` thick (y 0 … t), with its corner cut and every hole cut right through: the top and the
 * bottom as a grid split at every hole's edges (a hole's cell left out, the cut corner clipped), and walls round the outline
 * and inside each hole. A hole is open: the brush below the card can be seen through it.
 */
export function cardGeo(mode: ReaderMode, cols: readonly number[], o: Orient, t = CARD_T): Geo {
  const m = MACHINES[mode], a = m.along / 2, c = m.across / 2, [sx, sz] = cornerSigns(mode, o), holes = holeRects(mode, cols);
  const xs = new Set<number>([-a, a]), zs = new Set<number>([-c, c]);
  // every row's and column's hole edges, punched or not, so the grid is the same for any card
  const all = holeRects(mode, Array.from({ length: COLUMNS }, () => 0xfff));
  for (const [x0, x1, z0, z1] of all) { xs.add(x0); xs.add(x1); zs.add(z0); zs.add(z1); }
  const X = [...xs].sort((p, q) => p - q), Z = [...zs].sort((p, q) => p - q);
  const isHole = (x: number, z: number) => holes.some(([x0, x1, z0, z1]) => x > x0 && x < x1 && z > z0 && z < z1);
  const P: number[] = [], N: number[] = [], I: number[] = [];
  const v = (p: Vec3, n: Vec3) => { P.push(p[0], p[1], p[2]); N.push(n[0], n[1], n[2]); return P.length / 3 - 1; };
  const lim = a + c - CORNER; // keep sx·x + sz·z ≤ lim: the corner's triangle is gone
  for (let i = 0; i + 1 < X.length; i++) for (let j = 0; j + 1 < Z.length; j++) {
    const x0 = X[i], x1 = X[i + 1], z0 = Z[j], z1 = Z[j + 1];
    if (isHole((x0 + x1) / 2, (z0 + z1) / 2)) continue;
    const poly = clip([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], sx, sz, lim);
    if (poly.length < 3) continue;
    for (const [y, ny] of [[t, 1], [0, -1]] as const) {
      const k = poly.map(([x, z]) => v([x, y, z], [0, ny, 0]));
      // the polygon runs x then z counter-clockwise seen from -y; from +y it is clockwise: wind each face outward
      for (let q = 1; q + 1 < k.length; q++) ny > 0 ? I.push(k[0], k[q + 1], k[q]) : I.push(k[0], k[q], k[q + 1]);
    }
  }
  // a wall from p to q (x, z) facing n
  const wall = (p: P2, q: P2, n: Vec3) => {
    const A = v([p[0], 0, p[1]], n), B = v([q[0], 0, q[1]], n), C = v([q[0], t, q[1]], n), D = v([p[0], t, p[1]], n);
    const e1 = [q[0] - p[0], 0, q[1] - p[1]], e2 = [0, t, 0], g = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    if (g[0] * n[0] + g[1] * n[1] + g[2] * n[2] >= 0) I.push(A, B, C, A, C, D); else I.push(A, C, B, A, D, C);
  };
  const outline = clip([[-a, -c], [a, -c], [a, c], [-a, c]], sx, sz, lim);
  for (let k = 0; k < outline.length; k++) {
    const p = outline[k], q = outline[(k + 1) % outline.length], d = [q[0] - p[0], q[1] - p[1]], l = Math.hypot(d[0], d[1]) || 1;
    // counter-clockwise in (x, z) seen from -y … outward is (dz, -dx) or its opposite: pick the one pointing away from the centre
    let n: Vec3 = [d[1] / l, 0, -d[0] / l];
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    if (n[0] * mid[0] + n[2] * mid[1] < 0) n = [-n[0], 0, -n[2]];
    wall(p, q, n);
  }
  for (const [x0, x1, z0, z1] of holes) {
    wall([x0, z0], [x1, z0], [0, 0, 1]); wall([x1, z1], [x0, z1], [0, 0, -1]);
    wall([x0, z1], [x0, z0], [1, 0, 0]); wall([x1, z0], [x1, z1], [-1, 0, 0]);
  }
  const positions = new Float32Array(P), min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < positions.length; k += 3) for (let q = 0; q < 3; q++) { min[q] = Math.min(min[q], positions[k + q]); max[q] = Math.max(max[q], positions[k + q]); }
  return { name: 'card', positions, normals: new Float32Array(N), indices: new Uint32Array(I), min, max };
}

/** A blank slab with the corner cut (the cards in the hopper and stacker: their holes are face down, out of sight). */
function slabGeo(mode: ReaderMode, o: Orient, t: number): Geo {
  return cardGeo(mode, [], o, t);
}
/** A stack: one slab per card, at its own corner. */
function stackGeo(mode: ReaderMode, orient: readonly Orient[], from: number, n: number, y0: number, full = true): Geo {
  // the flat drawing sorts faces by their middles: one block the stack's height, at the top card's corner, reads cleaner
  if (!full) return transform(slabGeo(mode, orient[from + n - 1], STACK_P * (n - 1) + CARD_T * 0.8), T(0, y0, 0));
  const parts: Geo[] = [];
  for (let i = 0; i < n; i++) parts.push(transform(once(`slab${mode}${orient[from + i].rows}${orient[from + i].cols}`, () => slabGeo(mode, orient[from + i], CARD_T * 0.8)), T(0, y0 + STACK_P * i, 0)));
  return merge(parts, 'stack');
}
export const STACK_P = 0.7, STACK_MAX = 24;

// ---------------------------------------------------------------- the moving parts' shapes (unit meshes for instances)

/** A brush: a strip of fine phosphor-bronze wires clamped in the holder and sloping down to its tip at y = 0, 1 unit tall
 *  (scaled to its drop): the tip ahead of the clamp, so a card coming along slides under it. */
export const BRUSH = sweep([[-1.6, 1, 0], [-1.2, 0.72, 0], [-0.4, 0.25, 0], [0.15, 0, 0]], [[-0.07, -0.3], [0.07, -0.3], [0.07, 0.3], [-0.07, 0.3]]);
/** A photocell (column mode): a flat disc facing up. */
export const CELL = rodGeo(0.85, 0.35, 16);
/** A light beam (column mode), a rod 1 long. */
export const BEAM = rodGeo(0.3, 0.5, 10);
/** A panel lamp: a domed lens facing the bed (+z). */
export const LAMP = transform(lathe([[0, 0], [0.95, 0], [0.95, 0.35], [0.75, 0.75], [0, 0.95]], { seg: 20, crease: 40 }), new Float32Array([1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1]));

const BRUSH_TOP = BED + 7;
/** The brushes now: one a column at each station (the second only where it finds a hole, the rest held up on the holder),
 *  a lit one dropped through its hole to the roll. `upTo`: brushes on the far side of the cut only (z ≤ upTo). */
export function brushes(look: Pick<ReaderLook, 'L' | 'rgb'>, upTo = Infinity): Instance[] {
  const { L, rgb } = look, lit = new Set(L.lit), lit2 = new Set(L.lit2), a = MACHINES.word.along / 2, out: Instance[] = [];
  const covers = (sx: number) => L.moving.some((q) => Math.abs(sx - q.cx) <= a);
  for (const [sx, l] of [[STATION_X, lit], [STATION2_X, lit2]] as const) {
    const card = covers(sx);
    for (let col = 0; col < COLUMNS; col++) {
      const z = colOff(col);
      if (z > upTo) continue;
      const on = l.has(col), bottom = on ? BED - 0.2 : card ? BED + CARD_T : BED + 0.05;
      out.push({ pos: [sx, bottom + (BRUSH_TOP - bottom) / 2, z], scale: [1, BRUSH_TOP - bottom, 1], color: on ? rgb.live : rgb.brass, emissive: on ? rgb.live.map((v) => v * 0.7) as RGB : undefined });
    }
  }
  return out;
}
/** Column mode: twelve cells under each station, lit where light comes through a hole, and the beam that reaches them. */
export function cells(look: Pick<ReaderLook, 'L' | 'rgb'>, upTo = Infinity): { cells: Instance[]; beams: Instance[] } {
  const { L, rgb } = look, cellsOut: Instance[] = [], beams: Instance[] = [];
  for (const [sx, l] of [[STATION_X, new Set(L.lit)], [STATION2_X, new Set(L.lit2)]] as const) for (let r = 0; r < ROWS; r++) {
    const z = rowOff(r);
    if (z > upTo) continue;
    const on = l.has(r);
    cellsOut.push({ pos: [sx, BED - 1.9, z], color: on ? rgb.live : rgb.cellOff, emissive: on ? rgb.live.map((v) => v * 0.8) as RGB : undefined });
    if (on) beams.push({ pos: [sx, (LAMP_LO + BED - 1.5) / 2, z], scale: [1, LAMP_LO - (BED - 1.5), 1], color: rgb.beam, emissive: rgb.beam.map((v) => v * 0.9) as RGB });
  }
  return { cells: cellsOut, beams };
}
const LAMP_LO = BED + 12.4;
/** The computer's panel lamps: a data bit each, then ready, empty, next, and the two check lights. */
export function panelLamps(run: ReaderRun, next: 0 | 1, rgb: ReaderRgb): Instance[] {
  const bits = run.mode === 'word' ? 32 : ROWS, z = MACHINES[run.mode].panelZ + 0.1, data = run.out[0], out: Instance[] = [];
  const lamp = (x: number, on: boolean, alarm = false) => out.push({ pos: [x, LAMP_Y, z], color: on ? (alarm ? rgb.alarm : rgb.live) : rgb.lampOff, emissive: on ? (alarm ? rgb.alarm : rgb.live).map((v) => v * 0.8) as RGB : undefined });
  for (let k = 0; k < bits; k++) lamp(lampX(k, bits), ((data >>> (bits - 1 - k)) & 1) === 1);
  [run.out[1], run.out[2], next].forEach((v, i) => lamp(lampX(bits + 1 + i, bits) + 2, v === 1));
  [run.cmpErrs, run.seqErrs].forEach((v, i) => lamp(lampX(bits + 4 + i, bits) + 2, v > 0, true));
  return out;
}

// ---------------------------------------------------------------- the cut, the views

/** The cut: a plane across the path (normal +z) through one column (word: the column whose brush is cut along; column mode:
 *  row 9's cell). `col` for word mode; the stage moves it in from the open position. */
export const CUT_COL_DEFAULT = 20;
export const cutZ = (mode: ReaderMode, col: number): number => (mode === 'word' ? colOff(col) + 0.001 : rowOff(ROWS - 1) + 0.001);
export const cutOpen = (mode: ReaderMode): number => MACHINES[mode].across / 2 + 12;
/** The plane's z at the cutaway knob k (0: nothing cut). */
export const cutAt = (mode: ReaderMode, col: number, k: number): number => (k <= 0 ? Infinity : cutOpen(mode) + (cutZ(mode, col) - cutOpen(mode)) * k);

/** The column the cut goes through: the first one of columns 1–32 with a hole in row 9 on the card at the first station
 *  (so the cut catches a brush through its hole), else CUT_COL_DEFAULT. */
export function cutColumn(run: ReaderRun, L: ReaderLayout): number {
  const q = L.moving.find((c) => Math.abs(c.cx - MACHINES.word.station(0)) < ROW_P);
  if (!q || run.mode !== 'word') return CUT_COL_DEFAULT;
  const cols = run.cols(q.k, true);
  for (let c = 31; c >= 0; c--) if ((cols[c] >> (ROWS - 1)) & 1) return c;
  return CUT_COL_DEFAULT;
}

export const HOME: Record<ReaderMode, { yaw: number; pitch: number }> = { word: { yaw: 0.3, pitch: 0.5 }, column: { yaw: 0.55, pitch: 0.55 } };
export const FRAME_GROUPS = ['homebox', 'hopperbox', 'stationbox', 'cutbox', 'checkbox'];

// ---------------------------------------------------------------- the model

export function readerModel(look: ReaderLook, cutCol = CUT_COL_DEFAULT): Model3 {
  const { run, L } = look, mode = run.mode, m = MACHINES[mode], a = m.along / 2, c = m.across / 2, full = look.detail === 'full';
  const items: Item[] = [], x0 = m.hopper - a - 8, x1 = m.stacker + a + 8;
  const frameMat = M.make({ base: '--cr-frame', metal: 0.15, rough: 0.42, coat: 0.5, label: 'cast frame, machine-grey enamel' });
  const bedMat = M.make({ base: '--cr-bed', metal: 0.2, rough: 0.35, coat: 0.3, label: 'card bed (polished steel plate, painted round its edges)' });
  const cardMat = M.make({ base: '--cr-card', metal: 0, rough: 0.85, label: 'card stock (manila)' });
  const brass = M.make({ ...M.brass, base: '--cr-brass', label: 'phosphor bronze' });
  const steel = M.make({ ...M.steel, label: 'steel' });
  const rubber = M.make({ ...M.rubber, base: '--cr-rubber', label: 'rubber tyre' });
  const panelMat = M.make({ base: '--cr-panel', metal: 0.2, rough: 0.5, label: 'the computer’s panel' });
  const ghost = M.make({ base: [0, 0, 0], metal: 0, rough: 1, label: 'frame' });
  const it = (geo: Geo, mat: Material, name: string, group: string, extra: Partial<Item> = {}) => items.push({ geo, mat, name, group, ...extra });
  const key = `${mode}`;

  // the bed: plates between the stations' slots, two side rails the card's edges ride on, the frame's cheeks below
  const slot = 3.5;
  for (const [xa, xb] of [[x0, STATION_X - slot], [STATION_X + slot, STATION2_X - slot], [STATION2_X + slot, x1]]) it(once(`bed${key}${xa}`, () => boxAt(xa, xb, BED - 3, BED, -c - 6, c + 6, 0.4)), bedMat, 'card bed', 'bed', { info: { note: SRC.drawn } });
  it(once(`rails${key}`, () => merge([-1, 1].map((s) => boxAt(x0, x1, BED, BED + 1.5, s * (c + 4) - 1, s * (c + 4) + 1, 0.3)), 'rails')), frameMat, 'side guides', 'bed', { info: { note: 'the card runs between them, its edges guided' } });
  it(once(`cheeks${key}`, () => merge([-1, 1].map((s) => boxAt(x0, x1, BED - 12, BED - 3, s * (c + 6) - 1.5, s * (c + 6) + 1.5, 0.6)), 'cheeks')), frameMat, 'frame', 'bed');

  // the hopper: four posts, the stack (face down, 9 edge first), its weight, the throat plate; the picker knife below
  const hop = Math.min(L.hopper, STACK_MAX), first = run.cards - L.hopper;
  it(once(`posts${key}`, () => merge([[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sz]) => boxAt(m.hopper + sx * (a + 1.2) - 0.8, m.hopper + sx * (a + 1.2) + 0.8, BED, BED + 26, sz * (c + 1.2) - 0.8, sz * (c + 1.2) + 0.8, 0.3)), 'posts')), frameMat, 'hopper', 'hopper', { info: { note: `the deck goes in face down, 9 edge first; ${SRC.drawn}` } });
  it(once(`throat${key}`, () => boxAt(m.hopper + a, m.hopper + a + 0.6, BED + CARD_T + 0.3, BED + 26, -c - 1, c + 1, 0.2)), frameMat, 'throat', 'hopper', { info: { note: 'a slit one card high under this plate lets only the bottom card out (drawn wider: the cards are drawn thicker)' } });
  if (hop > 0) {
    const sig = run.orient.slice(first, first + hop).map((o) => `${+o.rows}${+o.cols}`).join('');
    it(once(`hop${key}${sig}${full}`, () => transform(stackGeo(mode, run.orient, first, hop, BED, full), T(m.hopper))), cardMat, 'cards in the hopper', 'hopper', { info: { dim: `${L.hopper} card${L.hopper === 1 ? '' : 's'}`, note: 'each drawn 7 times too thick' } });
  }
  const wy = BED + STACK_P * hop + 0.6;
  it(boxAt(m.hopper - 4, m.hopper + 4, wy, wy + 3, -c * 0.4, c * 0.4, 0.5), steel, 'hopper weight', 'hopper');
  // the knife: a blade as thick as one card, pushing the bottom card's trailing edge (moved by the view: group 'knife')
  it(once(`knife${key}`, () => merge([boxAt(m.hopper - a - 2.6, m.hopper - a - 1.4, BED - 0.2, BED + CARD_T * 0.9, -c + 2, c - 2, 0.2), boxAt(m.hopper - a - 7.4, m.hopper - a - 2.6, BED - 2, BED - 0.2, -c + 6, c - 6, 0.3)], 'knife')), steel, 'picker knife', 'knife', { info: { note: 'slides the bottom card out through the throat, once a card' } });

  // feed rolls in pairs: a turned steel roll above, a rubber-tyred one below on a steel shaft
  const rollLen = c + 3;
  for (const x of m.rolls) {
    it(once(`rollU${key}${x}`, () => onZ(rodGeo(2, rollLen, 32), x, BED + CARD_T + 2)), steel, 'feed rolls', 'rolls', { info: { note: 'pairs that pinch the card and carry it on' } });
    it(once(`rollL${key}${x}`, () => onZ(lathe([[0.6, -rollLen], [1.8, -rollLen], [1.8, rollLen], [0.6, rollLen], [0.6, -rollLen]], { seg: 32, crease: 50 }), x, BED - 1.8)), rubber, 'feed rolls', 'rolls');
    it(once(`shaft${key}${x}`, () => onZ(rodGeo(0.6, rollLen + 3, 12), x, BED - 1.8)), steel, 'feed rolls', 'rolls');
  }

  // the stations
  if (mode === 'word') {
    for (const [sx, nm] of [[STATION_X, 'first'], [STATION2_X, 'second']] as const) {
      it(once(`croll${sx}`, () => onZ(rodGeo(2, c + 3, 40), sx, BED - 2.2)), brass, `${nm} contact roll`, nm === 'first' ? 'station' : 'station2', { info: { note: 'a brush that finds a hole touches it and closes its column’s circuit' } });
      it(once(`holder${sx}`, () => merge([boxAt(sx - 2.6, sx + 0.4, BRUSH_TOP, BRUSH_TOP + 3, -c - 4, c + 4, 0.4), boxAt(sx - 2, sx, BED, BRUSH_TOP + 3, -c - 6, -c - 4, 0.3), boxAt(sx - 2, sx, BED, BRUSH_TOP + 3, c + 4, c + 6, 0.3)], 'holder')), frameMat, `${nm} brush holder`, nm === 'first' ? 'station' : 'station2', { info: { note: `${COLUMNS} brushes, one a column; ${SRC.drawn}` } });
    }
  } else {
    for (const [sx, nm] of [[STATION_X, 'first'], [STATION2_X, 'second']] as const) {
      const g = nm === 'first' ? 'station' : 'station2';
      it(once(`housing${sx}`, () => merge([boxAt(sx - 3, sx + 3, BED + 14, BED + 18, -c - 2, c + 2, 0.5), boxAt(sx - 1, sx + 1, BED, BED + 18, -c - 5, -c - 2, 0.3)], 'housing')), frameMat, `${nm} lamp housing`, g, { info: { note: SRC.drawn } });
      it(once(`bulb${sx}`, () => onZ(rodGeo(0.9, c - 1, 24), sx, BED + 13.2)), M.make({ ...M.glass, label: 'lamp (a line filament in a glass tube)' }), `${nm} lamp`, g, { order: 2 });
      it(once(`fil${sx}`, () => onZ(rodGeo(0.15, c - 1.5, 8), sx, BED + 13.2)), M.make({ base: '--cr-beam', metal: 0, rough: 0.5, emit: '--cr-beam', glow: 1.4, bloom: 1.2, label: 'filament' }), `${nm} lamp`, g);
      it(once(`cellbar${sx}`, () => boxAt(sx - 2.5, sx + 2.5, BED - 3.6, BED - 2.3, -c - 1, c + 1, 0.3)), frameMat, `${nm} photocells`, g, { info: { note: 'twelve cells, one a row, under a slit: light reaches one only through a hole' } });
    }
  }

  // the stacker: a back plate and the cards read, face down as they came
  it(once(`stackerplate${key}`, () => boxAt(m.stacker + a + 1, m.stacker + a + 3, BED, BED + 22, -c - 1, c + 1, 0.4)), frameMat, 'stacker', 'stacker', { info: { note: SRC.drawn } });
  const stk = Math.min(L.stacker, STACK_MAX);
  if (stk > 0) {
    const sig = run.orient.slice(0, stk).map((o) => `${+o.rows}${+o.cols}`).join('');
    it(once(`stk${key}${sig}${full}`, () => transform(stackGeo(mode, run.orient, 0, stk, BED + 0.1, full), T(m.stacker))), cardMat, 'cards read', 'stacker', { info: { dim: `${L.stacker} card${L.stacker === 1 ? '' : 's'}` } });
  }

  // the cards on the bed, holes cut through: at the origin, moved along the bed by the view ('mv0', 'mv1')
  L.moving.forEach((q, i) => {
    const g = once(`card${key}${q.k}${+run.orient[q.k].rows}${+run.orient[q.k].cols}${run.dirty}`, () => cardGeo(mode, run.cols(q.k), run.orient[q.k]));
    it(g, cardMat, `card ${q.k + 1}`, `mv${i}`, { at: full ? [0, BED, 0] : [q.cx, BED, 0], info: { dim: '7⅜ × 3¼ in, columns 0.087 in, rows ¼ in, holes 0.055 × 0.125 in', source: SRC.card, note: `drawn ${Math.round(CARD_T / CARD_T_REAL)} times too thick (0.18 mm for a real card)` } });
  });

  // the computer's panel behind the bed, and the cable from the station
  const bits = mode === 'word' ? 32 : ROWS, z = m.panelZ;
  it(once(`panel${key}`, () => merge([boxAt(lampX(0, bits) - 5, lampX(bits + 5, bits) + 3, LAMP_Y - 6, LAMP_Y + 6, z - 2, z, 0.5), boxAt(-4, 4, BED - 4, LAMP_Y - 6, z - 2, z - 0.5, 0.3)], 'panel')), panelMat, 'the computer’s panel', 'panel', { info: { note: 'a lamp per data bit, then ready, empty, next and the two check lights' } });
  it(once(`cable${key}`, () => sweep(cablePath(mode), circleSec(0.8, 8))), M.make({ base: [0.12, 0.12, 0.13], metal: 0, rough: 0.7, label: 'cable to the computer' }), 'cable to the computer', 'panel');

  // the flat drawing has no instances: the moving parts as parts
  if (!full) flatMovers(items, look, frameMat);

  // frames
  const fb = (g: string, ax: number, bx: number, ay: number, by: number, az: number, bz: number) => items.push({ geo: once(`f${g}${key}`, () => boxAt(ax, bx, ay, by, az, bz)), mat: ghost, group: g, cut: 'none', shadow: false });
  fb('homebox', x0, x1, BED - 12, BED + 26, -c - 6, c + 6);
  fb('hopperbox', m.hopper - a - 9, m.rolls[0] + 4, BED - 4, BED + 26, -c - 2, c + 2);
  fb('stationbox', STATION_X - 10, STATION2_X + 6, BED - 5, BED + (mode === 'word' ? 11 : 19), -4, c + 6);
  fb('cutbox', STATION_X - 7, STATION_X + 5, BED - 5, BED + (mode === 'word' ? 11 : 19), cutZ(mode, cutCol) - 10, cutZ(mode, cutCol) + 1);
  fb('checkbox', STATION_X - 6, STATION2_X + 6, BED - 4, LAMP_Y + 6, z - 2, c + 6);

  return {
    items,
    cuts: { planes: [{ n: [0, 0, 1], d: cutZ(mode, cutCol) }], open: [cutOpen(mode)] },
    anchors: anchorsOf(run, L),
    beats: beatsOf(mode),
    floor: BED - 12,
    look: { exposure: 1.05 },
    // the flat drawing: whole parts back to front (a long bed plate sorted by its faces' middles would be painted over the cards)
    flatOrder: 'items',
  };
}

const circleSec = (r: number, n: number): [number, number][] => Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)]);
function cablePath(mode: ReaderMode): Vec3[] {
  const m = MACHINES[mode], c = m.across / 2, top = mode === 'word' ? BRUSH_TOP + 3 : BED + 18;
  return [[STATION_X - 1, top, -c - 3], [STATION_X - 1, top + 5, -c - 8], [STATION_X, LAMP_Y - 12, m.panelZ + 3], [STATION_X, LAMP_Y - 6, m.panelZ - 1]];
}

/** The flat drawing's brushes, cells, beams and lamps (fewer: what reads at that size). */
function flatMovers(items: Item[], look: ReaderLook, frameMat: Material): void {
  const { run, rgb } = look, lit = M.make({ base: rgb.live, metal: 0, rough: 0.5, emit: rgb.live, glow: 0.6, label: 'lit' });
  const off = M.make({ base: rgb.brass, metal: 0.6, rough: 0.4, label: 'brush' });
  if (run.mode === 'word') {
    for (const b of brushes(look)) {
      const on = b.emissive !== undefined, h = b.scale![1];
      items.push({ geo: once(`fb${h.toFixed(2)}`, () => boxAt(-0.25, 0.25, -h / 2, h / 2, -0.32, 0.32)), mat: on ? lit : off, at: b.pos, name: 'brushes', group: 'brushes' });
    }
  } else {
    const { cells: cs, beams } = cells(look);
    for (const cl of cs) items.push({ geo: once('fcell', () => boxAt(-0.85, 0.85, -0.35, 0.35, -0.85, 0.85)), mat: cl.emissive ? lit : frameMat, at: cl.pos, name: 'photocells', group: 'cells' });
    for (const b of beams) items.push({ geo: once(`fbeam${b.scale![1].toFixed(2)}`, () => boxAt(-0.3, 0.3, -b.scale![1] / 2, b.scale![1] / 2, -0.3, 0.3)), mat: lit, at: b.pos, name: 'light through a hole', group: 'cells' });
  }
  for (const l of panelLamps(run, look.next, rgb)) items.push({ geo: once('flamp', () => boxAt(-0.95, 0.95, -0.95, 0.95, 0, 0.6)), mat: l.emissive ? lit : off, at: l.pos, name: 'panel lamps', group: 'panel' });
}

function anchorsOf(run: ReaderRun, L: ReaderLayout): StudioAnchor[] {
  const on: Record<string, string> = { hopper: 'hopper', 'picker knife': 'knife', 'feed rolls': 'rolls', stacker: 'stacker' };
  return readerAnchors(run, L).map((a) => ({ ...a, on: on[a.text] ?? (a.text.startsWith('data') || a.text.startsWith('ready') ? 'panel' : a.text.includes('second') ? 'station2' : 'station') }));
}

function beatsOf(mode: ReaderMode): Beat[] {
  const h = HOME[mode];
  const v = (yaw: number, pitch: number) => ({ target: [0, 0, 0] as Vec3, yaw, pitch, dist: 300 });
  const word = mode === 'word';
  return [
    { title: word ? 'A reader that reads row by row' : 'A reader that reads column by column', text: word
      ? 'As on an IBM 711: the deck in the hopper face down, 9 edge first; a picker knife slides out the bottom card, feed rolls carry it under a brush for every column, on under a second set, and into the stacker. The lamps behind are the wires to the computer.'
      : 'As on an IBM 2501: the card runs lengthwise, column 1 first, under a lamp, with twelve photocells below it, one a row; each take moves it on a column. A second lamp and set of cells read it again further along.', view: v(h.yaw, h.pitch), frame: ['homebox'], cut: 0 },
    { title: 'One card at a time', text: 'The knife is as thick as one card: it pushes the bottom card’s trailing edge through the throat, a slit one card high, and the feed rolls take it from there. The cards are drawn seven times too thick so a stack can be seen; the throat is drawn wider to match.', view: v(-0.35, 0.45), frame: ['hopperbox'], cut: 0 },
    { title: word ? 'A brush over every column' : 'A lamp and twelve cells', text: word
      ? `${COLUMNS} brushes stand in a row across the card, one over each column, ${(COL_P * 2.5).toFixed(2)} mm apart, the card’s 0.087 inch column pitch. Paper lifts a brush; a hole lets it drop onto the contact roll, and that column’s wire carries a 1. Row 9 passes first: row 9 of columns 1–32 is the word.`
      : `The lamp shines across the card through one column; under it twelve photocells, ${(ROW_P * 2.5).toFixed(2)} mm apart, the card’s ¼ inch row pitch. A cell that sees light through a hole gives a 1: the twelve make the column.`, view: v(0.55, 0.55), frame: ['stationbox'], cut: 0 },
    { title: 'Through a hole', text: word
      ? 'Cut across one column at the first station, through its brush: where the card has a hole the brush has dropped through it and touches the roll; where it has paper the brush rests on top. The circuit is the hole.'
      : 'Cut along row 9: the lamp, the card, row 9’s cell below. Light reaches the cell only where row 9 is punched.', view: v(0.05, 0.25), frame: ['cutbox'], cut: 1 },
    { title: 'Read twice, and checked', text: `The second station reads every card again and the two readings are compared, as the IBM 1402 did with two brush stations and the 2501 by reading every column twice (no source gives the 711 one: here it is the model’s); the loader also checks the sequence number in columns 73–80. Either fault lights a check lamp on the panel and stops the reader. Try “Dirty first station” or turn a card in the hopper.`, view: v(0.4, 0.6), frame: ['checkbox'], cut: 0 },
  ];
}

export const SIZES = { CARD_L, CARD_S, COL_P, ROW_P, HOLE_C, HOLE_R, SEPARATION } as const;
