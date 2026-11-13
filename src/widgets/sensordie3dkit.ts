// A whole image sensor die on the studio renderer (DOM-free, tested): sensordie3dgeom.ts's timing in true shapes. The
// IMX183's array to scale in cells of CELL × CELL pixels, each cell a block whose colour is what it holds now (reset,
// gathering light, read); the row decoder and drivers on its left, a comparator and a counter per drawn column below, the
// shared ramp, the readout bus and the output block, bond pads round the die. The cells, drivers, comparators and
// optical-black strips are each one mesh with a colour per vertex, rewritten as the frame is captured (so the SVG
// fallback shows them too); the counters' heights and the lens's image are instances.
//
// 1 unit = 0.1 mm (sensordie3dgeom.ts MM).

import { merge, plane, refresh, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { OrbitView } from '../gl/camera';
import type { Instance, RGB } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import { IMX183, exposureWindow } from '../phys/imagesensor';
import {
  ADC_Z0, ADC_Z1, AH, AW, CELL, CH, COLS, CW, DEC_X0, DEC_X1, IMG_Y, OB_W, ROWS, T_ROW, Y0,
  cellLight, cellPx, cellRow, cellXZ, covered, dieState, pointers, rowZ, type DiePose,
} from './sensordie3dgeom';

type Detail = 'full' | 'flat';
/** Resolves a colour token to sRGB (the stage's rgb()). */
export type Rgb = (token: `--${string}`) => RGB;

const SRC = {
  imx: `Sony ${IMX183.part}: ${IMX183.cols} × ${IMX183.rows} pixels of ${IMX183.pitch} µm, the array to scale`,
  drawn: 'the periphery is drawn, not measured',
};

// ---------------------------------------------------------------- the die's outline

export const DIE = { x0: DEC_X0 - 6, x1: AW / 2 + 26, z0: -AH / 2 - 10, z1: ADC_Z1 + 8 };
const OUT = { x0: AW / 2 + 6, x1: AW / 2 + 22, z0: ADC_Z0 - 6, z1: ADC_Z1 + 4 };

const at3 = (g: Geo, x: number, y: number, z: number): Geo => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = x; m[13] = y; m[14] = z; return transform(g, m); };
/** Boxes are sharp while the flat (SVG) drawing's geometry is built: 12 triangles a box, not 108 (geos() sets it). */
let sharp = false;
/** A box between two corners, as a geometry in place. */
const B = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.15): Geo =>
  at3(roundedBox(x1 - x0, y1 - y0, z1 - z0, sharp ? 0 : Math.min(r, (x1 - x0) / 3, (y1 - y0) / 3, (z1 - z0) / 3), 1), (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
/** Boxes merged into one mesh with a colour slot per box (each box's vertices one run). */
function painted(boxes: Geo[], name: string): { geo: Geo; per: number } {
  const g = merge(boxes, name), per = boxes[0].positions.length / 3;
  (g as { colors?: Float32Array }).colors = new Float32Array(g.positions.length).fill(1);
  return { geo: g, per };
}
/** Set box k's colour in a painted mesh. */
function paint(m: { geo: Geo; per: number }, k: number, c: RGB): void {
  const cs = m.geo.colors!;
  for (let v = k * m.per; v < (k + 1) * m.per; v++) { cs[3 * v] = c[0]; cs[3 * v + 1] = c[1]; cs[3 * v + 2] = c[2]; }
}

interface Geos {
  die: Geo; pads: Geo; decoder: Geo; dac: Geo; housings: Geo; bus: Geo; out: Geo; obTop: Geo; bar: Geo; flash: Geo; marker: Geo; ramp: Geo;
  cells: { geo: Geo; per: number }; drivers: { geo: Geo; per: number }; cmps: { geo: Geo; per: number }; obLeft: { geo: Geo; per: number };
}
const memo = new Map<Detail, Geos>();
function geos(d: Detail): Geos {
  const hit = memo.get(d);
  if (hit) return hit;
  sharp = d === 'flat';
  const pads: Geo[] = [];
  for (let x = DIE.x0 + 4; x < DIE.x1 - 2; x += 6) for (const z of [DIE.z0 + 2, DIE.z1 - 2]) pads.push(B(x - 1.6, x + 1.6, 0, 0.4, z - 1.6, z + 1.6, 0.3));
  for (let z = DIE.z0 + 8; z < DIE.z1 - 6; z += 6) for (const x of [DIE.x0 + 2, DIE.x1 - 2]) pads.push(B(x - 1.6, x + 1.6, 0, 0.4, z - 1.6, z + 1.6, 0.3));
  const cells: Geo[] = [], drivers: Geo[] = [], obLeft: Geo[] = [], cmps: Geo[] = [], housings: Geo[] = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const [x, z] = cellXZ(c, r); cells.push(B(x - CW * 0.46, x + CW * 0.46, 0, Y0, z - CH * 0.46, z + CH * 0.46, 0.04)); }
  for (let r = 0; r < ROWS; r++) {
    const [, z] = cellXZ(0, r);
    drivers.push(B(DEC_X1 - 8, DEC_X1, 0, Y0, z - CH * 0.42, z + CH * 0.42, 0.05));
    obLeft.push(B(-AW / 2 - OB_W, -AW / 2 - 0.3, 0, Y0 + 0.2, z - CH * 0.46, z + CH * 0.46, 0.05));
  }
  for (let c = 0; c < COLS; c++) {
    const [x] = cellXZ(c, 0);
    cmps.push(B(x - CW * 0.4, x + CW * 0.4, 0, Y0, ADC_Z0, ADC_Z0 + 4, 0.05));
    housings.push(B(x - CW * 0.4, x + CW * 0.4, 0, Y0 * 0.6, ADC_Z0 + 5, ADC_Z1, 0.05));
  }
  const g: Geos = {
    die: B(DIE.x0, DIE.x1, -1.5, 0, DIE.z0, DIE.z1, 0.4),
    pads: merge(pads, 'bond pads'),
    decoder: B(DEC_X0, DEC_X1 - 9, 0, Y0 + 0.6, -AH / 2, AH / 2),
    dac: B(DEC_X0, DEC_X1, 0, Y0 + 0.6, ADC_Z0, ADC_Z1),
    housings: merge(housings, 'counters'),
    bus: tube([[-AW / 2, Y0, ADC_Z1 + 2], [AW / 2 + 6, Y0, ADC_Z1 + 2]], 0.5, { sides: 8 }),
    out: B(OUT.x0, OUT.x1, 0, Y0 + 1, OUT.z0, OUT.z1),
    obTop: B(-AW / 2 - OB_W, AW / 2, 0, Y0 + 0.2, -AH / 2 - OB_W, -AH / 2 - 0.3, 0.05),
    bar: roundedBox(AW + OB_W + 2, 0.8, 1, 0.2, 1),
    flash: roundedBox(AW, 0.3, AH, 0.1, 1),
    marker: roundedBox(CW * 0.9, 1.2, 2, 0.1, 1),
    ramp: tube([[DEC_X1, 0, ADC_Z0 + 2], [AW / 2, 0, ADC_Z0 + 2]], 0.35, { sides: 8 }),
    cells: painted(cells, 'pixel array'), drivers: painted(drivers, 'row drivers'), cmps: painted(cmps, 'comparators'), obLeft: painted(obLeft, 'optical black'),
  };
  memo.set(d, g);
  sharp = false;
  return g;
}

const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** Rewrite the painted meshes' colours for this moment (and tell the renderer: refresh bumps their revision). */
function repaint(G: Geos, q: DiePose, rgb: Rgb): void {
  const st = dieState(q), P = {
    dark: rgb('--sd-dark'), lit: rgb('--sd-lit'), idle: rgb('--sd-idle'), expose: rgb('--sd-expose'), read: rgb('--m3-charge'),
    logic: rgb('--m3-si'), metal: rgb('--m3-metal'),
  };
  for (let r = 0; r < ROWS; r++) {
    const started = q.now >= exposureWindow(cellRow(r), q.texp, q.shutter, T_ROW)[0], read = st.done[r] || st.reading === r;
    for (let c = 0; c < COLS; c++) {
      const col = read ? mix(P.dark, P.lit, cellLight(q.scene, c, r, q.shutter, q.texp)) : started ? mix(P.idle, P.expose, cellLight(q.scene, c, r, q.shutter, q.texp, q.now)) : P.idle;
      paint(G.cells, r * COLS + c, col);
    }
    paint(G.drivers, r, st.reading === r ? P.read : st.exposing[r] ? P.expose : P.logic);
    paint(G.obLeft, r, st.reading === r ? mix(P.metal, P.read, 0.5) : P.metal);
  }
  const ramp = st.reading !== null ? st.ramp : 0;
  for (let c = 0; c < COLS; c++) {
    const v = st.reading !== null ? cellLight(q.scene, c, st.reading, q.shutter, q.texp) : 0;
    paint(G.cmps, c, st.reading !== null && ramp >= v ? P.read : P.logic);
  }
  for (const m of [G.cells, G.drivers, G.obLeft, G.cmps]) refresh(m.geo, m.geo);
}

/** The column counters' bars (height = count) and the lens's image over the array, as instances. */
export function dieInstances(q: DiePose): { counters: Instance[]; image: Instance[] } {
  const st = dieState(q), counters: Instance[] = [], image: Instance[] = [];
  if (st.reading !== null) for (let c = 0; c < COLS; c++) {
    const v = cellLight(q.scene, c, st.reading, q.shutter, q.texp), count = Math.min(st.ramp, v);
    if (count <= 0) continue;
    const [x] = cellXZ(c, 0), hh = 8 * count;
    counters.push({ pos: [x, Y0 * 0.6 + hh / 2, (ADC_Z0 + 6 + ADC_Z1 - 1) / 2], scale: [CW * 0.6, hh, ADC_Z1 - 1 - ADC_Z0 - 6], color: [1, 1, 1] });
  }
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const [px, py] = cellPx(c, r);
    if (!covered(q.scene, px, py, q.now)) continue;
    const [x, z] = cellXZ(c, r);
    image.push({ pos: [x, IMG_Y + 0.15, z], scale: [CW, 0.3, CH], color: [1, 1, 1] });
  }
  return { counters, image };
}

// ---------------------------------------------------------------- the model

const white = (label: string, rough = 0.5) => M.make({ base: [1, 1, 1], metal: 0, rough, label });
const dieMat = M.make({ base: '--sd-die', metal: 0.3, rough: 0.35, label: 'silicon die' });
const logicMat = M.make({ base: '--m3-si', metal: 0.2, rough: 0.4, label: 'logic (drawn)' });
const glowOf = (token: `--${string}`, label: string, k = 0.9) => M.glow(M.make({ base: token, metal: 0, rough: 0.3, label }), token, k);

export const DIE_HOME: OrbitView = { target: [-4, 0, 6], yaw: 0.22, pitch: 0.92, dist: 210 };

/** The SVG fallback colours a mesh by its material only: there the cells are flat tiles in BUCKETS colour steps, one item a step. */
const BUCKETS = 8;
function flatCells(G: Geos): Item[] {
  const cs = G.cells.geo.colors!, per = G.cells.per, groups = new Map<string, { c: RGB; tiles: Geo[] }>(), tile = plane(CW * 0.92, CH * 0.92);
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) {
    const v = (r * COLS + c) * per * 3, col: RGB = [cs[v], cs[v + 1], cs[v + 2]].map((x) => Math.round(x * (BUCKETS - 1)) / (BUCKETS - 1)) as RGB, key = col.join();
    const [x, z] = cellXZ(c, r), g = groups.get(key) ?? { c: col, tiles: [] };
    g.tiles.push(at3(tile, x, Y0, z)); groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ geo: merge(g.tiles, 'pixel array'), mat: M.make({ base: g.c, metal: 0, rough: 0.5, label: 'pixel cells' }), name: 'pixel array', group: 'array' }));
}

export function dieModel(q: DiePose, rgb: Rgb, detail: Detail = 'full'): Model3 {
  const G = geos(detail), st = dieState(q), pt = pointers(q.shutter, q.texp, q.now);
  repaint(G, q, rgb);
  const reading = st.reading !== null, shifting = st.shift !== null, readTop = st.reading === 0;
  const items: Item[] = [
    { geo: G.die, mat: dieMat, name: 'die', group: 'die', info: { source: SRC.drawn, note: 'the silicon the array and its periphery are built in' } },
    { geo: G.pads, mat: M.gold, name: 'bond pads', group: 'die', info: { note: 'where the bond wires land: supplies, clocks, the data out' } },
    { geo: G.cells.geo, mat: white('pixel cells'), name: 'pixel array', group: 'array', info: { dim: `${(AW / 10).toFixed(1)} × ${(AH / 10).toFixed(1)} mm, a cell = ${CELL} × ${CELL} pixels`, source: SRC.imx, note: 'each cell shows its middle pixel: grey reset, violet gathering light, then the value read' } },
    { geo: G.obLeft.geo, mat: white('optical black', 0.35), name: 'optical black', group: 'array', info: { note: 'pixels under metal: they see no light, so their reading is the dark level each row has subtracted (drawn far wider than their few dozen columns)' } },
    { geo: G.obTop, mat: readTop ? glowOf('--m3-charge', 'optical black, read', 0.3) : M.make({ base: '--m3-metal', metal: 0, rough: 0.35, label: 'optical black' }), name: 'optical black', group: 'array' },
    { geo: G.decoder, mat: logicMat, name: 'row decoder and drivers', group: 'rows', info: { source: SRC.drawn, note: 'picks a row; its drivers reset it, transfer its charge and connect it to the column lines' } },
    { geo: G.drivers.geo, mat: white('row drivers', 0.4), name: 'row decoder and drivers', group: 'rows' },
    { geo: G.cmps.geo, mat: white('comparators', 0.4), name: 'column ADCs', group: 'adc', info: { source: SRC.drawn, note: `a single-slope ADC per column (one drawn for every ${CELL}): the comparator flips when the shared ramp passes the pixel's level` } },
    { geo: G.housings, mat: logicMat, name: 'column ADCs', group: 'adc' },
    { geo: G.dac, mat: logicMat, name: 'ramp', group: 'adc', info: { note: 'the ramp generator (a DAC), shared by every column\'s comparator' } },
    { geo: G.ramp, mat: reading ? glowOf('--m3-charge', 'the ramp, rising', 0.6) : M.make({ base: '--m3-metal', metal: 0.8, rough: 0.3, label: 'ramp line' }), at: [0, Y0 + 0.4 + 6 * (reading ? st.ramp : 0), 0], name: 'ramp', group: 'adc' },
    { geo: G.bus, mat: M.aluminium, name: 'readout to the output', group: 'out' },
    { geo: G.out, mat: shifting ? glowOf('--m3-charge', 'output, shifting', 0.3) : logicMat, name: 'readout to the output', group: 'out', info: { note: 'the counters are shifted out one after another, to the serial output' } },
  ];
  if (shifting) {
    const c = Math.min(COLS - 1, Math.floor(st.shift! * COLS)), [x] = cellXZ(c, 0);
    items.push({ geo: G.marker, mat: glowOf('--m3-charge', 'a counter on the bus'), at: [x, Y0 + 0.4, ADC_Z1 + 2], name: 'readout to the output', group: 'out' });
  }
  if (pt.reset !== null) items.push({ geo: G.bar, mat: glowOf('--sd-reset', 'reset pointer'), at: [(-AW / 2 - OB_W + AW / 2 + 2) / 2, Y0 + 0.7, rowZ(pt.reset)], name: 'reset pointer', group: 'pointers', info: { note: 'rolling: each row starts its exposure as the reset passes' } });
  if (pt.read !== null) items.push({ geo: G.bar, mat: glowOf('--m3-charge', 'read pointer'), at: [(-AW / 2 - OB_W + AW / 2 + 2) / 2, Y0 + 0.7, rowZ(pt.read)], name: 'read pointer', group: 'pointers', info: { note: 'one exposure behind the reset: the row it passes is read out' } });
  if (q.shutter === 'global' && q.now < 4 * T_ROW * CELL) items.push({ geo: G.flash, mat: glowOf('--sd-reset', 'every row reset at once', 0.6), at: [0, Y0 + 0.45, 0], name: 'global reset', group: 'pointers' });
  const shown = detail === 'flat' ? [...items.filter((i) => i.geo !== G.cells.geo), ...flatCells(G)] : items;
  // layers on a die: the SVG fallback draws item by item, back to front, or the die's long triangles cut through the array
  return { items: shown, anchors: anchors(q), beats: beats(q), floor: -1.5, flatOrder: 'items' };
}

const up: Vec3 = [0, 1, 0], front: Vec3 = [0, 0.4, 1];
function anchors(q: DiePose): StudioAnchor[] {
  const pt = pointers(q.shutter, q.texp, q.now), a: StudioAnchor[] = [
    { text: 'pixel array', p: [AW / 2, Y0, -AH / 2], side: 'r', n: up },
    { text: 'row drivers', p: [DEC_X0, Y0, -AH / 2 + 8], side: 'l', n: up },
    { text: 'column ADCs', p: [0, Y0, ADC_Z1], side: 'b', n: front },
    { text: 'ramp', p: [DEC_X0, Y0, (ADC_Z0 + ADC_Z1) / 2], side: 'l', n: front, minor: true },
    { text: 'readout to the output', p: [OUT.x1, Y0 + 1, ADC_Z1], side: 'r', n: front, minor: true },
    { text: 'optical black', p: [-AW / 2 - OB_W, Y0, -AH / 2 - OB_W], side: 't', n: up, minor: true },
  ];
  if (pt.reset !== null) a.push({ text: 'reset pointer', p: [AW / 2 + 2, Y0 + 1, rowZ(pt.reset)], side: 'r', n: up, gutter: 'r' });
  if (pt.read !== null) a.push({ text: 'read pointer', p: [AW / 2 + 2, Y0 + 1, rowZ(pt.read)], side: 'r', n: up, gutter: 'r' });
  return a;
}

function beats(q: DiePose): Beat[] {
  return [
    { title: 'The whole sensor', text: `The ${IMX183.part}'s array to scale, ${(AW / 10).toFixed(1)} × ${(AH / 10).toFixed(1)} mm, with what surrounds it: the row decoder on the left, a column ADC per column below, the readout to the output, bond pads round the edge.`, view: DIE_HOME, frame: [], cut: 0, explode: 0 },
    { title: 'Rows, one after another', text: q.shutter === 'rolling' ? 'A rolling shutter: the reset pointer starts each row\'s exposure, the read pointer follows one exposure behind. Between them, the band of rows gathering light; each row sees the scene at its own moment.' : 'A global shutter: every row is reset at once and exposed together; then the rows are read out one after another, as with a rolling shutter.', view: { target: [0, 0, -6], yaw: 0.1, pitch: 1.2, dist: 170 }, frame: ['array'], cut: 0, explode: 0 },
    { title: 'A row converted at once', text: 'The row being read drives every column line. One ramp is shared; each column\'s comparator flips when the ramp passes its pixel\'s level, and its counter stops there: a brighter pixel, a later flip, a larger count.', view: { target: [0, 2, ADC_Z0 + 6], yaw: 0.15, pitch: 0.55, dist: 110 }, frame: ['adc'], cut: 0, explode: 0 },
    { title: 'Shifted out', text: 'The counters are shifted out along the bus to the output, one after another, while the next row converts.', view: { target: [AW / 2, 2, ADC_Z1], yaw: 0.6, pitch: 0.6, dist: 90 }, frame: ['out'], cut: 0, explode: 0 },
  ];
}
