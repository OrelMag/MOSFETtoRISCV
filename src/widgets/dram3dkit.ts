// The DRAM array on the studio renderer (DOM-free). An abstraction kept on purpose: every charge stands on the plate as a
// solid whose HEIGHT is the simulator's level (a fraction of VDD) and whose footprint AREA is proportional to its
// capacitance, so its volume is its charge (dram3dparts.ts holds the dimensions). The charge is drawn as a liquid, glossy
// and a little translucent, in a well: a cell is a round well, a bit line a long trough behind its column of cells, the
// reference line beside it. Open a row and a cell's charge pours into its bit line until both stand level; the sense
// amplifier at the head of the pair then drives the two to opposite rails and the cell refills.
//
// Nothing moves per frame: a protocol step (a button) changes the levels and the model is rebuilt from the bench's snapshot.

import { lathe, merge, roundedBox, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Mat4, Vec3 } from '../gl/math';
import { CELL_C } from '../lib/dram';
import type { DramSnap } from './dram3dbench';
import { BL_X, BLB_X, HMAX, LINE_Z0, PAD, R_CELL, W_LINE, X_OF, Z_OF, lineLength } from './dram3dparts';

const mat = (o: Material): Material => M.make(o);
/** The charge: a glossy liquid you can half see into. */
const liquid = (tok: string, label: string): Material => mat({ base: tok as Material['base'], metal: 0, rough: 0.08, coat: 1, transmit: 0.35, tint: tok as Material['base'], label });
export const MATS = {
  plate: mat({ base: '--m3-dram-plate', metal: 0.2, rough: 0.55, label: 'the plate (drawn)' }),
  well: mat({ base: '--m3-dram-line', metal: 0.5, rough: 0.35, label: 'the well a charge stands in (drawn)' }),
  wire: mat({ base: '--m3-dram-line', metal: 0.8, rough: 0.3, label: 'metal line' }),
  wl: mat({ base: '--m3-dram-line', metal: 0.8, rough: 0.3, label: 'word line (polysilicon on a chip)' }),
  wlUp: mat({ base: '--m3-dram-wl', metal: 0.2, rough: 0.35, emit: '--m3-dram-wl', glow: 0.6, label: 'word line, raised: above VDD + VT' }),
  fet: mat({ base: '--m3-dram-fet', metal: 0.2, rough: 0.45, label: 'access transistor' }),
  fetOn: mat({ base: '--m3-dram-wl', metal: 0.2, rough: 0.4, emit: '--m3-dram-wl', glow: 0.4, label: 'access transistor, conducting' }),
  amp: mat({ base: '--m3-dram-fet', metal: 0.3, rough: 0.45, label: 'sense amplifier' }),
  ampOn: mat({ base: '--m3-dram-amp', metal: 0.2, rough: 0.4, emit: '--m3-dram-amp', glow: 0.8, bloom: 1.2, label: 'sense amplifier, driving' }),
  charge: liquid('--m3-dram-charge', 'charge in a cell'),
  open: liquid('--m3-dram-open', 'charge in a cell of the open row'),
  bl: liquid('--m3-dram-bl', 'charge on the bit line'),
  blb: liquid('--m3-dram-blb', 'charge on the reference line'),
  unknown: mat({ base: '--m3-dram-x', metal: 0, rough: 0.6, transmit: 0.6, tint: '--m3-dram-x', label: 'unknown: the simulator cannot say' }),
  half: mat({ base: '--m3-dram-half', metal: 0, rough: 0.1, transmit: 0.78, tint: '--m3-dram-half', label: 'VDD/2: where both lines are precharged' }),
};

const tr = (p: Vec3): Mat4 => { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; m[12] = p[0]; m[13] = p[1]; m[14] = p[2]; return m; };
const bx = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo =>
  transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r > 0 ? 2 : 0), tr([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]));
/** A column of radius r from y0 to y1 at (x, z), its top edge eased. */
const column = (x: number, z: number, y0: number, y1: number, r: number, seg: number): Geo => {
  const e = Math.min(0.25, (y1 - y0) / 3);
  return transform(lathe([[0, y0], [r, y0], [r, y1 - e], [r - e, y1], [0, y1]], { seg, crease: 40 }), tr([x, 0, z]));
};

/** The well under a cell (a shallow ring) and under a line (a raised rim round its trough). */
const WELL = 0.5;
const ring = (r0: number, r1: number, y0: number, y1: number, seg: number): Geo => lathe([[r0, y0], [r1, y0], [r1, y1], [r0, y1], [r0, y0]], { seg, crease: 40 });
const cellWell = (x: number, z: number, seg: number): Geo => transform(merge([lathe([[0, 0], [R_CELL + 0.45, 0], [R_CELL + 0.45, PAD], [0, PAD]], { seg, crease: 40 }), ring(R_CELL + 0.2, R_CELL + 0.45, PAD, PAD + WELL, seg)], 'well'), tr([x, 0, z]));
const troughWell = (x: number, z0: number, len: number): Geo => {
  const z1 = z0 - len, w = W_LINE / 2, t = 0.3;
  return merge([bx(x - w - t, x + w + t, 0, PAD, z1 - t, z0 + t), bx(x - w - t, x - w, PAD, PAD + WELL, z1 - t, z0 + t), bx(x + w, x + w + t, PAD, PAD + WELL, z1 - t, z0 + t),
    bx(x - w, x + w, PAD, PAD + WELL, z1 - t, z1), bx(x - w, x + w, PAD, PAD + WELL, z0, z0 + t)], 'trough');
};

/** The charge drawn: a level (fraction of VDD) as a height over the well's floor; unknown as a half-height grey. */
const height = (lv: number): number => (Number.isFinite(lv) ? lv * HMAX : HMAX * 0.5);
const EPS = 0.02;

export function dramModel(s: DramSnap, detail: 'full' | 'flat' = 'full'): Model3 {
  const items: Item[] = [], seg = detail === 'flat' ? 16 : 40, L = lineLength(s.ratio);
  const rows = s.cell.length, cols = s.bl.length, x0 = X_OF(0) - 7, x1 = X_OF(cols - 1) + 10, zf = Z_OF(0) + 7, zb = LINE_Z0 - L - 4;
  items.push({ geo: bx(x0, x1, -1.2, 0, zb, zf, 0.4), mat: MATS.plate, name: 'plate', group: 'plate', cut: 'none',
    info: { note: 'what every charge stands on: height is voltage, footprint is capacitance, so volume is charge' } });
  // word lines, one a row; the open row's raised and lit
  for (let r = 0; r < rows; r++) {
    const z = Z_OF(r) + 4.4, up = r === s.open;
    items.push({ geo: tube([[x0 + 1, 0.3, z], [x1 - 1, 0.3, z]], up ? 0.55 : 0.35, { sides: 10 }), mat: up ? MATS.wlUp : MATS.wl, name: 'word line', group: 'wordlines',
      info: { note: up ? `row ${r}: raised, so every access transistor on it conducts` : `row ${r}: down, its cells sealed` } });
  }
  for (let c = 0; c < cols; c++) {
    // the bit line's wire from its cells back to the amplifier
    items.push({ geo: tube([[BL_X(c), 0.3, zf - 1], [BL_X(c), 0.3, LINE_Z0 + 2.5]], 0.35, { sides: 8 }), mat: MATS.wire, name: 'bit line', group: 'lines', info: { note: `column ${c}: every cell of the column hangs on it` } });
    items.push({ geo: bx(BL_X(c) - 1.6, BLB_X(c) + 1.6, 0, s.sensed ? 1.6 : 1.0, LINE_Z0 + 0.6, LINE_Z0 + 3.4, 0.4), mat: s.sensed ? MATS.ampOn : MATS.amp, name: 'sense amplifier', group: 'amps',
      info: { note: s.sensed ? 'latched: driving the higher line to VDD and the lower to 0, which refills the cell' : 'waits for its enable; then compares its two lines' } });
    for (const [x, lv, which] of [[BL_X(c), s.bl[c], 'bl'], [BLB_X(c), s.blb[c], 'blb']] as const) {
      items.push({ geo: troughWell(x, LINE_Z0, L), mat: MATS.well, name: which === 'bl' ? 'bit line' : 'reference bit line', group: 'lines',
        info: { dim: `${s.ratio}× a cell: ${s.ratio * CELL_C} fF`, note: which === 'bl' ? 'a long line: its capacitance is many cells’ worth' : 'no cells on it: the amplifier’s other input, at VDD/2 until it senses' } });
      const hgt = height(lv);
      if (hgt > EPS) items.push({ geo: bx(x - W_LINE / 2, x + W_LINE / 2, PAD, PAD + hgt, LINE_Z0 - L, LINE_Z0, 0.15), mat: Number.isFinite(lv) ? (which === 'bl' ? MATS.bl : MATS.blb) : MATS.unknown,
        name: which === 'bl' ? 'charge on the bit line' : 'charge on the reference line', group: 'lines', order: 2, shadow: false,
        info: { dim: Number.isFinite(lv) ? `${(lv * 100).toFixed(1)} % of VDD` : 'unknown', note: `column ${c}` } });
    }
  }
  // cells: a well, its charge, the access transistor joining it to the bit line
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = X_OF(c), z = Z_OF(r), lv = s.cell[r][c], open = r === s.open, hgt = height(lv);
    items.push({ geo: cellWell(x, z, seg), mat: MATS.well, name: 'cell', group: 'cells', info: { dim: `${CELL_C} fF`, note: `row ${r}, column ${c}` } });
    if (hgt > EPS) items.push({ geo: column(x, z, PAD, PAD + hgt, R_CELL, seg), mat: Number.isFinite(lv) ? (open ? MATS.open : MATS.charge) : MATS.unknown, name: 'charge in a cell', group: 'cells', order: 2, shadow: false,
      info: { dim: Number.isFinite(lv) ? `${(lv * 100).toFixed(1)} % of VDD` : 'unknown', note: `row ${r}, column ${c}${open ? ': shared with its bit line' : ''}` } });
    items.push({ geo: bx(x + 2.2, x + 3.9, 0, open ? 1.4 : 0.9, z - 0.7, z + 0.7, 0.3), mat: open ? MATS.fetOn : MATS.fet, name: 'access transistor', group: 'fets',
      info: { note: open ? 'its gate is the raised word line: it conducts, joining the cell to the bit line' : 'off: the cell is sealed, leaking slowly' } });
  }
  // VDD/2, what both lines are precharged to: a glass sheet at half height over the lines
  items.push({ geo: bx(BL_X(0) - 2.5, BLB_X(cols - 1) + 2.5, PAD + HMAX / 2 - 0.06, PAD + HMAX / 2 + 0.06, LINE_Z0 - L, LINE_Z0), mat: MATS.half, name: 'VDD/2', group: 'half', order: 3, shadow: false, cut: 'none',
    info: { note: 'the precharge level: a cell’s 1 or 0 moves its bit line a little above or below it' } });

  const up: Vec3 = [0, 1, 0], left: Vec3 = [-1, 0.2, 0.4], r = s.open >= 0 ? s.open : 0, cl = cols - 1;
  const anchors: StudioAnchor[] = [
    { text: s.open >= 0 ? `word line ${r}: raised` : `word line ${r}`, p: [x0 + 1, 0.3, Z_OF(r) + 4.4], side: 'l', n: left, on: 'wordlines' },
    { text: `bit line, ${s.ratio}× a cell`, p: [BL_X(1), PAD + HMAX * 0.62, LINE_Z0 - L * 0.5], side: 't', n: up, on: 'lines' },
    { text: s.sensed ? 'amplifiers: driving' : 'sense amplifiers', p: [BLB_X(cl) + 1.6, 1.2, LINE_Z0 + 2], side: 'r', n: up, on: 'amps' },
    { text: 'cell, 25 fF', p: [X_OF(cl) + R_CELL, PAD + WELL, Z_OF(rows - 1)], side: 'r', n: up, on: 'cells' },
    { text: 'reference bit line', p: [BLB_X(cl), PAD + HMAX * 0.55, LINE_Z0 - L * 0.7], side: 'r', n: up, on: 'lines', minor: true },
    { text: 'access transistor', p: [X_OF(cl) + 3.9, 1.2, Z_OF(0)], side: 'r', n: up, on: 'fets', minor: true },
    { text: 'VDD/2', p: [BL_X(0) - 2.5, PAD + HMAX / 2, LINE_Z0 - L * 0.3], side: 'l', n: left, on: 'half', minor: true },
  ];
  const v = (yaw: number, pitch: number) => ({ yaw, pitch, target: [6, 2, (zf + zb) / 2] as Vec3, dist: 120 });
  const beats: Beat[] = [
    { title: 'A cell is a column of charge', text: `Each well is a ${CELL_C} fF capacitor, and the liquid in it is its charge: as high as its voltage, as wide as its capacitance. A 1 is a full column, a 0 an empty well.`, view: v(-0.5, 0.75), frame: ['cells'], show: ['cells', 'plate'] },
    { title: 'The word line opens a row', text: 'Raising a row’s word line turns on the access transistor beside every cell of that row, joining each cell to its column’s bit line. Every other row stays sealed.', view: v(-0.35, 0.6), frame: ['cells', 'wordlines'], show: ['wordlines', 'fets', 'cells'] },
    { title: 'A bit line is a long trough', text: `A bit line runs past every cell of its column, so its capacitance is many cells’ worth: here ${s.ratio}× a cell, its trough ${s.ratio}× a well’s area. A cell’s charge poured into it moves its level only a little.`, view: v(2.6, 0.55), frame: ['lines'], show: ['lines'] },
    { title: 'Above or below VDD/2', text: 'Both lines start at VDD/2, the glass sheet. Sharing a 1 lifts the bit line a little above it, a 0 drops it a little below; the reference line, with no cells, stays at VDD/2.', view: v(2.95, 0.25), frame: ['lines', 'half'], show: ['lines', 'half'] },
    { title: 'The amplifier decides', text: 'Enabled, each sense amplifier compares its two lines and drives the higher to VDD and the lower to 0. The open row’s cells, still connected, refill to a full 1 or an empty 0: a read destroys and restores.', view: v(2.45, 0.65), frame: ['amps', 'lines'], show: ['amps', 'lines', 'cells'] },
  ];
  return { items: mergeAlike(items), anchors, beats, floor: -1.25, look: { exposure: 0.95 } };
}

/** Parts alike (same name, group and material) drawn as one item, so the array is a few dozen draws, not ninety; the
 *  charges stay one item each (each is its own level). A merged part keeps a note only if every copy had the same one. */
function mergeAlike(items: Item[]): Item[] {
  const out: Item[] = [], by = new Map<string, Item[]>(), key = new Map<Material, number>();
  for (const it of items) {
    if (it.name?.startsWith('charge')) { out.push(it); continue; }
    if (!key.has(it.mat)) key.set(it.mat, key.size);
    const kk = `${it.name}|${it.group}|${key.get(it.mat)}`, list = by.get(kk);
    if (list) list.push(it); else { const l = [it]; by.set(kk, l); out.push(it); }
  }
  return out.map((it) => {
    if (it.name?.startsWith('charge')) return it;
    const list = by.get(`${it.name}|${it.group}|${key.get(it.mat)}`)!;
    if (list.length === 1) return it;
    const same = list.every((x) => x.info?.note === it.info?.note);
    return { ...it, geo: merge(list.map((x) => x.geo), it.name), info: { ...it.info, note: same ? it.info?.note : undefined } };
  });
}

export const DRAM_HOME = { yaw: 2.55, pitch: 0.62, target: [6, 2, -20] as Vec3, dist: 120 };
/** The canvas's shape: the bit lines grow with the ratio, the canvas should not jump. */
export const DRAM_ASPECT = 1.45;
/** The drawn levels of a snapshot, for tests: every charge solid's height over the well floor, by where it stands. */
export function levelsDrawn(m: Model3): { x: number; z: number; level: number }[] {
  return m.items.filter((i) => i.name?.startsWith('charge')).map((i) => ({ x: (i.geo.min[0] + i.geo.max[0]) / 2, z: (i.geo.min[2] + i.geo.max[2]) / 2, level: (i.geo.max[1] - PAD) / HMAX }));
}
