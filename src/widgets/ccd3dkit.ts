// The three-phase CCD on the studio renderer (DOM-free, tested): the corner of ccd3dparts.ts drawn as true shapes. The
// gates are three overlapping polysilicon strips a pixel over the oxide, the columns kept apart by p+ channel stops, the
// buried channel a slab, and under it the channel potential as a smooth surface whose wells move with the clocks; the
// charge is electrons (instanced beads, drawn by the view) filling each well. The silicon is cut open along the last
// column, so the gate, oxide, channel and well read in section. Layers: the light entering the back, and the package (the
// datasheet's ceramic DIL, 37.0 × 51.7 mm, its window and pins) with the drawn corner a speck at one corner of the image area.
//
// Sourced: the pitch, gate length (a third of it, derived), full well, CTE and responsivity are phys/imagesensor.ts's
// CCD42-40 numbers; the package, pins and image area are the datasheet's ("CCD42-40 NIMO back illuminated", e2v A1A-100011,
// "General data", p. 1): 37.0 × 51.7 mm, 24 pins at 2.54 mm, 45.72 mm across the rows, a 27.6 mm image area; the bias
// voltages on the gates' cards are its typical operating conditions (p. 7). Drawn, as the note says: the oxide and gates
// thicker, the channel deeper, a well's depth as potential (not a hole), the overlapping poly as the textbook three-phase
// structure (this part's process is not published), the package's thickness and pin length.

import type { RGB } from '../gl/instances';
import { roundedBox, surface, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Instance } from '../gl/instances';
import type { Vec3 } from '../gl/math';
import {
  CHANNEL, COLS, CROSS, DUMP_X, FD_X, FULL_WELL, GATE, OG_X, OX, PITCH, POLY, POLY_T, RD_X, RG_X, ROWS, SI_BOTTOM, SI_DEPTH, WELL_FD, WELL_HI, WELL_LO,
  gateOf, heightOf, phaseOf, type CcdRun, type Phase,
} from './ccd3dparts';

/** The datasheet's package and image area (mm), and its typical bias (V). */
export const PACKAGE = { w: 37.0, l: 51.7, pins: 24, pinPitch: 2.54, rows: 45.72, image: 27.6 } as const;
export const BIAS = { image: [0, 10], register: [1, 11], reset: [0, 12], og1: 3, od: 29, rd: 17, dd: 24, dg: [0, 12] } as const;
export const SRC = {
  part: 'phys/imagesensor.ts CCD42_40: e2v CCD42-40 datasheet (A1A-100011): 13.5 µm pixels, full well, CTE',
  pkg: 'e2v CCD42-40 NIMO BI datasheet, "General data" p. 1: ceramic DIL 37.0 × 51.7 mm, 24 pins at 2.54 mm, rows 45.72 mm apart',
  bias: 'e2v CCD42-40 datasheet p. 7, typical operating conditions',
  gate: 'derived: three equal gates a pixel (the datasheet gives the pitch, not the gate lengths)',
  poly: 'textbook three-phase structure (overlapping polysilicon levels); this part’s process is not published',
  drawn: 'drawn, not to scale (see the note)',
};

const AREA_X = COLS * PITCH, AREA_Z = ROWS * PITCH;
const H_Z: [number, number] = [-PITCH, 0], H_MID = (H_Z[0] + H_Z[1]) / 2;
const mir = (r: readonly [number, number]): [number, number] => [AREA_X - r[1], AREA_X - r[0]];
/** The cut: along the middle of the last column, removing x beyond it. */
export const CUT_X = (COLS - 0.5) * PITCH;

export type CcdLayer = 'light' | 'package';
export interface CcdLook {
  detail: 'full' | 'flat';
  run: CcdRun;
  /** 0..1 through the step being drawn, and which register it moves. */
  t: number;
  moving: Phase;
  layers: ReadonlySet<CcdLayer>;
  rgb: { si: RGB; p: RGB; n: RGB; poly: RGB; oxide: RGB; metal: RGB; well: RGB; charge: RGB; hot: RGB };
}

// ---------------------------------------------------------------- the clocks as the drawing sees them

/** The phases high in each register now: the moving register's clock, φ1 alone while a register waits. */
export function highs(run: CcdRun, moving: Phase): { v: number[]; h: number[] } {
  const ck = run.clocks();
  return { v: run.vs > 0 || moving === 'vertical' ? ck.v : [1], h: run.hs > 0 || moving === 'horizontal' ? ck.h : [1] };
}
/** The well's depth under gate g of a register (deep under a high gate), and the profile between gates, smoothed over a
 *  sixth of a gate each side of a boundary: the potential surface along a register. */
export const depthAt = (g: number, high: readonly number[]): number => (high.includes(phaseOf(g)) ? WELL_HI : WELL_LO);
export function profile(s: number, n: number, high: readonly number[]): number {
  // s in gates from the register's end (0 … n); smoothstep between the neighbouring gates' depths near a boundary
  const g = Math.min(n - 1, Math.max(0, Math.floor(s))), f = s - g, w = 1 / 6;
  const d = depthAt(g, high);
  if (f < w && g > 0) { const k = 0.5 + f / (2 * w); return lerpS(depthAt(g - 1, high), d, k); }
  if (f > 1 - w && g < n - 1) { const k = (f - (1 - w)) / (2 * w); return lerpS(d, depthAt(g + 1, high), k); }
  return d;
}
const lerpS = (a: number, b: number, k: number) => a + (b - a) * k * k * (3 - 2 * k);

// ---------------------------------------------------------------- geometry

const memo = new Map<string, Geo>();
const once = (k: string, f: () => Geo): Geo => { let g = memo.get(k); if (!g) { g = f(); memo.set(k, g); } return g; };
/** A box from its corners (µm). */
const slab = (k: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0.15) =>
  once(`${k}|${x0}|${x1}|${y0}|${y1}|${z0}|${z1}`, () => transform(roundedBox(x1 - x0, y1 - y0, z1 - z0, Math.min(r, (y1 - y0) / 3), 2), new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, 1])));

/** The potential surface of a column (along z) or of the horizontal register (along x), for the clock state `high`. */
function wellSurface(kind: 'v' | 'h', high: readonly number[], c = 0): Geo {
  return once(`well|${kind}|${c}|${high.join('')}`, () => {
    if (kind === 'v') {
      const x0 = c * PITCH + 1.4, x1 = (c + 1) * PITCH - 1.4, n = 3 * ROWS;
      return surface((u, v) => [x0 + (x1 - x0) * v, CHANNEL - profile(u * n, n, high), u * AREA_Z], n * 8, 2);
    }
    const z0 = H_Z[0] + 1.4, z1 = H_Z[1] - 1.4, n = 3 * COLS;
    return surface((u, v) => [u * AREA_X, CHANNEL - profile(u * n, n, high), z1 - (z1 - z0) * v], n * 8, 2);
  });
}

// ---------------------------------------------------------------- the electrons

/** Beads per full well (a packet of e electrons is drawn as round(e / FULL_WELL × this) beads, at least one). */
export const BEADS_FULL = 70;
export const beadsOf = (e: number): number => (e <= 0 ? 0 : Math.max(1, Math.round((e / FULL_WELL) * BEADS_FULL)));
/** A fixed scatter in the unit cube: the same bead stays in the same place as its packet glides. */
const R3 = (k: number): Vec3 => [((k * 0.618034) % 1), ((k * 0.414214 + 0.3) % 1), ((k * 0.732051 + 0.6) % 1)];
function cloud(out: Instance[], e: number, cx: number, cz: number, hx: number, hz: number, depth: number, col: RGB, seed: number): void {
  const n = beadsOf(e), h = heightOf(e, depth), y0 = CHANNEL - depth;
  for (let k = 0; k < n; k++) {
    const [a, b, c] = R3(seed * 101 + k + 1);
    out.push({ pos: [cx + (a * 2 - 1) * hx * 0.85, y0 + 0.25 + b * Math.max(0, h - 0.5), cz + (c * 2 - 1) * hz * 0.85], color: col, emissive: col });
  }
}
const vzAt = (g: number): number => (g >= 0 ? (g + 0.5) * GATE : H_MID + (g + 1) * (0.5 * GATE - H_MID));
const hxAt = (g: number): number => (g >= 0 ? (g + 0.5) * GATE : (FD_X[0] + FD_X[1]) / 2 + (g + 1) * (0.5 * GATE - (FD_X[0] + FD_X[1]) / 2));

/** Every packet as electrons where the clocks hold it, gliding the half gate of the step being drawn. */
export function electrons(run: CcdRun, t: number, moving: Phase, col: RGB): Instance[] {
  const out: Instance[] = [], back = (1 - t) * 0.5, vMove = moving === 'vertical', hMove = moving === 'horizontal';
  const colHalf = PITCH / 2 - 1.8, bucket = GATE * 0.42, regHalf = (PITCH - 2.8) / 2 - 0.4;
  for (let c = 0; c < COLS; c++) run.v[c].forEach((e, k) => {
    const g = gateOf(k, run.vs) + (vMove ? back : 0);
    if (e > 0 && g > -1) cloud(out, e, (c + 0.5) * PITCH, vzAt(g), colHalf, bucket, WELL_HI, col, c * 16 + k);
  });
  run.h.forEach((e, k) => {
    if (e <= 0) return;
    const g = gateOf(k, run.hs) + (hMove ? back : 0), z = vMove && run.vs === CROSS ? vzAt(-1 + back) : H_MID;
    cloud(out, e, hxAt(g), z, bucket, regHalf, WELL_HI, col, 200 + k);
  });
  if (run.fd > 0) cloud(out, run.fd, hMove && run.hs === CROSS ? hxAt(-1 + back) : (FD_X[0] + FD_X[1]) / 2, H_MID, (FD_X[1] - FD_X[0]) / 2 - 0.5, regHalf, WELL_FD, col, 300);
  return out;
}

// ---------------------------------------------------------------- the model

export const FRAME_GROUPS = ['cornerbox', 'columnbox', 'outbox', 'pkgbox'] as const;

export function ccdModel(look: CcdLook): Model3 {
  const { run } = look, C = look.rgb, items: Item[] = [], hi = highs(run, look.moving), rgHigh = run.resetting();
  const si = M.make({ ...M.silicon, base: C.si, label: 'p-type silicon (epitaxial, back-thinned)' });
  const oxide = M.make({ base: C.oxide, metal: 0, rough: 0.15, transmit: 0.55, label: 'silicon dioxide' });
  const chan = M.make({ base: C.n, metal: 0, rough: 0.5, transmit: 0.45, label: 'n buried channel' });
  const pStop = M.make({ base: C.p, metal: 0.1, rough: 0.5, label: 'p+ silicon (channel stop)' });
  const nPlus = M.make({ base: C.n, metal: 0.1, rough: 0.5, label: 'n+ silicon' });
  const well = M.make({ base: C.well, metal: 0, rough: 0.35, transmit: 0.35, emit: C.well, glow: 0.25, label: 'the channel potential (drawn as depth)' });
  const poly = (hot: boolean): Material => M.make({ ...M.polysilicon, base: C.poly, emit: hot ? C.hot : undefined, glow: hot ? 0.45 : 0, label: hot ? 'polysilicon gate, clocked high' : 'polysilicon gate' });
  const metal = M.make({ base: C.metal, metal: 0.9, rough: 0.3, label: 'aluminium' });

  // the silicon, cut along the last column; the buried channel and the channel stops at its top
  items.push({ geo: slab('si', RD_X[0] - 2, AREA_X - RD_X[0] + 2, SI_BOTTOM, CHANNEL, H_Z[0] - 9, AREA_Z + 2, 0.4), mat: si, name: 'p silicon, back-thinned', group: 'silicon',
    info: { dim: `${SI_DEPTH} µm drawn (the collecting depth of the deep-depleted part)`, source: 'phys/imagesensor.ts STACK_CCD42 (the chapter’s QE model); the datasheet’s text gives no thickness', note: 'light enters from below: the gates face away from it' } });
  for (let c = 0; c < COLS; c++) items.push({ geo: slab('ch', c * PITCH + 1, (c + 1) * PITCH - 1, CHANNEL, 0, 0, AREA_Z), mat: chan, name: 'buried channel (n)', group: 'channel', order: 2, info: { dim: `${PITCH - 2} µm wide`, source: SRC.drawn, note: 'the charge moves here, under the gates, clear of the oxide' } });
  items.push({ geo: slab('chh', OG_X[0], AREA_X - OG_X[0], CHANNEL, 0, H_Z[0] + 1, H_Z[1]), mat: chan, name: 'buried channel (n)', group: 'channel', order: 2 });
  for (let c = 0; c <= COLS; c++) items.push({ geo: slab('stop', c * PITCH - 1, c * PITCH + 1, CHANNEL, 0.02, 0, AREA_Z), mat: pStop, name: 'channel stop (p+)', group: 'stops', info: { dim: '2 µm wide (drawn)', source: SRC.drawn, note: 'keeps each packet in its column' } });
  items.push({ geo: slab('stoph', OG_X[0], AREA_X - OG_X[0], CHANNEL, 0.02, H_Z[0], H_Z[0] + 1), mat: pStop, name: 'channel stop (p+)', group: 'stops' });

  // the potential: a surface under each column and under the horizontal register, its wells under the high gates
  for (let c = 0; c < COLS; c++) items.push({ geo: wellSurface('v', hi.v, c), mat: well, name: 'potential well', group: 'wells', cut: 'none', shadow: false, order: 3,
    info: { source: SRC.drawn, note: `deep under a high gate (${BIAS.image[1]} V), shallow under a low one (${BIAS.image[0]} V): the charge sits where the clock lets it` } });
  items.push({ geo: wellSurface('h', hi.h), mat: well, name: 'potential well', group: 'wells', cut: 'none', shadow: false, order: 3, info: { source: SRC.drawn, note: `the register clocks swing ${BIAS.register[0]} to ${BIAS.register[1]} V` } });

  // the oxide, then the gates: three overlapping polysilicon levels, φ1 lowest
  items.push({ geo: slab('ox', 0, AREA_X, 0, OX, 0, AREA_Z + 1, 0.1), mat: oxide, name: 'gate oxide', group: 'oxide', order: 4, info: { dim: 'about 0.1 µm, drawn 8× thicker', source: SRC.drawn } });
  items.push({ geo: slab('oxh', RD_X[0], AREA_X - RD_X[0], 0, OX, H_MID, H_Z[1], 0.1), mat: oxide, name: 'gate oxide', group: 'oxide', order: 4 });
  const gate = (ph: number, hot: boolean, x0: number, x1: number, z0: number, z1: number, name: string, info: Item['info'], group = 'gates'): Item => {
    const y0 = POLY + (ph - 1) * 0.45;
    return { geo: slab(`g${ph}`, x0, x1, y0, y0 + POLY_T, z0, z1, 0.25), mat: poly(hot), name, group, explode: [0, 6 + 2 * ph, 0], info };
  };
  for (let g = 0; g < 3 * ROWS; g++) {
    const ph = phaseOf(g), hot = hi.v.includes(ph);
    items.push(gate(ph, hot, 0, AREA_X, g * GATE - 0.4, (g + 1) * GATE + 0.4, `image gate φ${ph}`, { dim: `${GATE} µm under it, overlapping its neighbours`, source: SRC.gate, note: `${hot ? 'high' : 'low'}: clocked ${BIAS.image[0]} to ${BIAS.image[1]} V (typical; ${SRC.poly})` }));
  }
  // the horizontal register's gates over its far half only (the near half left open, so its packets show)
  for (let g = 0; g < 3 * COLS; g++) {
    const ph = phaseOf(g), hot = hi.h.includes(ph);
    items.push(gate(ph, hot, g * GATE - 0.4, (g + 1) * GATE + 0.4, H_MID, H_Z[1] - 0.5, `register gate R${ph}`, { dim: `${GATE} µm`, source: SRC.gate, note: `clocked ${BIAS.register[0]} to ${BIAS.register[1]} V (typical)` }, 'hgates'));
  }

  // the two output amplifiers, A (read) at x < 0 and B (idle) at the register's other end
  for (const side of [0, 1] as const) {
    const X = (r: [number, number]): [number, number] => (side ? mir(r) : r), og = X(OG_X), fd = X(FD_X), rg = X(RG_X), rd = X(RD_X), tag = side ? ' (B, idle)' : '';
    const group = side ? 'outB' : 'outA';
    items.push({ geo: slab(`fd${side}`, fd[0], fd[1], CHANNEL, 0.04, H_Z[0] + 2, H_Z[1] - 2), mat: nPlus, name: `floating diffusion${tag}`, group, info: { source: SRC.part, note: `the packet lands here and moves its voltage: ${4.5} µV an electron` } });
    items.push({ geo: slab(`rd${side}`, rd[0], rd[1], CHANNEL, 0.04, H_Z[0] + 1, H_Z[1] - 1), mat: nPlus, name: `reset drain${tag}`, group, info: { source: SRC.bias, note: `${BIAS.rd} V: the diffusion is emptied into it` } });
    items.push({ ...gate(1, false, og[0] + (side ? 0.2 : 0), og[1] - (side ? 0 : 0.2), H_MID, H_Z[1] - 1, `output gate${tag}`, { source: SRC.bias, note: `OG1, ${BIAS.og1} V (typical)` }, group), explode: undefined });
    items.push({ ...gate(2, side === 0 && rgHigh, rg[0], rg[1], H_MID, H_Z[1] - 1, `reset gate${tag}`, { source: SRC.bias, note: `pulsed ${BIAS.reset[0]} to ${BIAS.reset[1]} V before each pixel` }, group), explode: undefined });
    const fx = (fd[0] + fd[1]) / 2, fz = H_MID, sfZ = H_Z[0] - 5, top = 7;
    items.push({ geo: once(`strap${side}`, () => tube([[fx, OX, fz], [fx, top, fz], [fx, top, sfZ], [fx, POLY + POLY_T, sfZ]], 0.5, { sides: 10 })), mat: metal, name: `metal strap to the follower${tag}`, group, info: { source: SRC.drawn } });
    const lit = side === 0 && run.fd > 0;
    items.push({ geo: slab(`sfg${side}`, fx - 2, fx + 2, POLY, POLY + POLY_T, sfZ - 2.5, sfZ + 2.5, 0.25), mat: poly(lit), name: `source follower${tag}`, group, info: { source: SRC.bias, note: `its drain at OD, ${BIAS.od} V; the output OS sits 3 to 5 V below it` } });
    for (const dx of [-4, 4]) items.push({ geo: slab(`sfd${side}${dx}`, fx + dx - 2, fx + dx + 2, CHANNEL, 0.04, sfZ - 2, sfZ + 2), mat: nPlus, name: `source follower${tag}`, group });
  }
  // the dump gate and drain below the register
  items.push({ geo: slab('dumpd', DUMP_X[0], DUMP_X[1], CHANNEL, 0.04, H_Z[0] - 7.5, H_Z[0] - 3.5), mat: nPlus, name: 'dump drain', group: 'dump', info: { source: SRC.bias, note: `DD, ${BIAS.dd} V: a whole row can be emptied into it (its place along the register is ours)` } });
  items.push({ ...gate(1, false, DUMP_X[0], DUMP_X[1], H_Z[0] - 3.5, H_Z[0] - 0.4, 'dump gate', { source: SRC.bias, note: `DG, ${BIAS.dg[0]} V, pulsed to ${BIAS.dg[1]} V to dump` }, 'dump'), explode: undefined });

  // the light, entering the back
  if (look.layers.has('light')) {
    const beam = M.beam(C.hot, 1.4, 'light entering the back');
    for (let c = 0; c < COLS; c++) for (const z of [0.25, 0.5, 0.75]) {
      const x = (c + 0.5) * PITCH, zz = AREA_Z * z;
      items.push({ geo: once('ray', () => tube([[0, -18, 0], [0, 0, 0]], 0.35, { sides: 8 })), mat: beam, at: [x, SI_BOTTOM, zz], name: 'light', group: 'light', cut: 'none', shadow: false, info: { source: 'back illumination: through the thinned silicon to the depleted region under the gates' } });
    }
  }
  // the package: the drawn corner sits at the image area's output corner, the origin
  if (look.layers.has('package')) {
    const mm = 1000, P = PACKAGE, cx = (P.image * mm) / 2, cz = (P.image * mm) / 2, top = -SI_DEPTH - 200;
    const ceramic = M.make({ ...M.ceramic, label: 'ceramic (the package)' }), gold = M.make({ ...M.gold, label: 'gold-plated pin' });
    items.push({ geo: slab('pkg', cx - (P.w * mm) / 2, cx + (P.w * mm) / 2, top - 3000, top, cz - (P.l * mm) / 2, cz + (P.l * mm) / 2, 400), mat: ceramic, name: 'ceramic package', group: 'package', cut: 'none',
      info: { dim: `${P.w} × ${P.l} mm`, source: SRC.pkg } });
    items.push({ geo: slab('die', -1200, P.image * mm + 1200, top, -SI_DEPTH, -1800, P.image * mm + 1200, 100), mat: M.make({ base: C.si, metal: 0.5, rough: 0.25, label: 'the die' }), name: 'image area', group: 'package', cut: 'none',
      info: { dim: `${P.image} × ${P.image} mm: 2048 × 2048 pixels of ${PITCH} µm`, source: SRC.pkg } });
    const pin = once('pin', () => roundedBox(500, 5000, 250, 60, 1));
    for (let r = 0; r < 2; r++) for (let k = 0; k < P.pins / 2; k++) {
      const x = cx + (k - (P.pins / 2 - 1) / 2) * P.pinPitch * mm, z = cz + (r ? 1 : -1) * (P.rows * mm) / 2;
      items.push({ geo: pin, mat: gold, at: [x, top - 3000 - 2000, z], name: 'pin', group: 'package', cut: 'none', info: { dim: `${P.pinPitch} mm apart, rows ${P.rows} mm apart`, source: SRC.pkg } });
    }
    items.push({ geo: slab('marker', -60, AREA_X + 60, 0, 2000, -60, AREA_Z + 60, 30), mat: M.beam(C.hot, 2, 'the corner drawn, here'), name: 'the corner drawn (here)', group: 'package', cut: 'none', shadow: false, info: { dim: `${(AREA_X / 1000).toFixed(2)} × ${(AREA_Z / 1000).toFixed(2)} mm: a speck at this scale`, source: 'the drawn corner, marked' } });
  }

  // the frames the views fit to (never drawn: the stage hides them)
  const ghost = M.make({ base: [0, 0, 0], metal: 0, rough: 1, label: 'frame' });
  const box = (g: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => items.push({ geo: slab(`f${g}`, x0, x1, y0, y1, z0, z1, 0), mat: ghost, group: g, cut: 'none', shadow: false });
  box('cornerbox', RD_X[0] - 2, AREA_X - RD_X[0] + 2, SI_BOTTOM, 8, H_Z[0] - 9, AREA_Z + 2);
  box('columnbox', CUT_X - PITCH, CUT_X + 2, -10, 6, 0, AREA_Z);
  box('outbox', RD_X[0] - 4, GATE * 7, -12, 9, H_Z[0] - 10, H_Z[1] + 8);
  const P = PACKAGE, mm = 1000;
  box('pkgbox', (P.image * mm) / 2 - (P.w * mm) / 2, (P.image * mm) / 2 + (P.w * mm) / 2, -12000, 2000, (P.image * mm) / 2 - (P.rows * mm) / 2 - 500, (P.image * mm) / 2 + (P.rows * mm) / 2 + 500);

  return { items, cuts: { planes: [{ n: [1, 0, 0], d: CUT_X }], open: [AREA_X - RD_X[0] + 3] }, anchors: anchors(look), beats: beats(), floor: SI_BOTTOM - 20, look: { exposure: 1.05 } };
}

function anchors(look: CcdLook): StudioAnchor[] {
  const up: Vec3 = [0, 1, 0], out: Vec3 = [1, 0.3, 0], front: Vec3 = [0, 0.3, -1], top = POLY + POLY_T + 0.9;
  if (look.layers.has('package')) return [
    { text: 'package, 37 × 51.7 mm', p: [PACKAGE.image * 500 + PACKAGE.w * 500, -SI_DEPTH - 200, PACKAGE.image * 500], side: 'r', n: out },
    { text: 'image area, 27.6 mm', p: [PACKAGE.image * 1000, -SI_DEPTH, PACKAGE.image * 500], side: 'r', n: up },
    { text: 'the corner drawn', p: [0, 2000, 0], side: 'l', n: up },
  ];
  const fdX = (FD_X[0] + FD_X[1]) / 2;
  const a: StudioAnchor[] = [
    { text: 'polysilicon gates', p: [PITCH * 0.5, top, AREA_Z * 0.6], side: 'l', n: up, on: 'gates' },
    { text: 'potential well', p: [CUT_X, CHANNEL - WELL_HI, AREA_Z * 0.45], side: 'r', n: out, on: 'wells' },
    { text: 'buried channel', p: [CUT_X, CHANNEL / 2, AREA_Z * 0.8], side: 'r', n: out, on: 'channel' },
    { text: 'p silicon', p: [CUT_X, SI_BOTTOM * 0.5, AREA_Z * 0.6], side: 'r', n: out },
    { text: 'horizontal register', p: [AREA_X * 0.6, top, H_Z[1] - 1], side: 'r', n: up, on: 'hgates' },
    { text: 'floating diffusion', p: [fdX, 0, H_Z[1] - 2], side: 'l', n: up, on: 'outA' },
    { text: 'source follower', p: [fdX, top, H_Z[0] - 5], side: 'l', n: front, on: 'outA' },
    { text: 'dump gate and drain', p: [(DUMP_X[0] + DUMP_X[1]) / 2, top, H_Z[0] - 3], side: 'r', n: front, minor: true },
  ];
  if (look.layers.has('light')) a.push({ text: 'light enters the back', p: [PITCH * 1.5, SI_BOTTOM - 9, AREA_Z * 0.5], side: 'l', n: [0, -1, 0] });
  return a;
}

export const HOME = { target: [0, 0, 0] as Vec3, yaw: 2.05, pitch: 0.62, dist: 140 };
export const KNOBS = { cut: 1, explode: 0 };
export const BEAT_LAYERS: readonly (readonly CcdLayer[])[] = [[], [], [], [], ['light'], ['package']];

function beats(): Beat[] {
  return [
    { title: 'A corner of the sensor', text: `Three columns of four pixels of the 2048 × 2048, the horizontal register along their foot and output amplifier A at its end. The silicon is cut open along the last column. Each ${PITCH} µm pixel is three polysilicon gates over a thin oxide, and the charge it collected sits as electrons in a well under one of them.`, view: HOME, frame: ['cornerbox'], cut: 1, explode: 0 },
    { title: 'Three gates a pixel', text: `The gates overlap: φ1, φ2 and φ3, each ${GATE} µm of channel under it (a third of the pitch), clocked between about ${BIAS.image[0]} and ${BIAS.image[1]} V. P+ channel stops between the columns keep each packet in its column. Pulled up here to show the oxide under them.`, view: { ...HOME, yaw: 2.3, pitch: 0.5 }, frame: ['columnbox'], cut: 1, explode: 0.6 },
    { title: 'Wells under the gates', text: 'Under a high gate the channel potential is deep, under a low one shallow: the blue surface. Step a phase and the wells move half a gate, and the electrons follow them; six steps move a packet one pixel down the column.', view: { ...HOME, yaw: 2.55, pitch: 0.28 }, frame: ['columnbox'], show: ['wells', 'channel', 'gates', 'silicon'], cut: 1, explode: 0 },
    { title: 'Out at the corner', text: 'The horizontal register carries a row to the floating diffusion beside output A. Before each packet the reset gate pulses and the diffusion’s empty level is sampled; then the packet crosses the output gate and the level is sampled again. The difference is the signal: correlated double sampling.', view: { ...HOME, yaw: 2.6, pitch: 0.7 }, frame: ['outbox'], cut: 1, explode: 0 },
    { title: 'Light from the back', text: `The chip is back-illuminated: thinned, turned over, so light enters through the bare silicon and the gates face away from it. Electrons it frees drift up to the nearest well. The silicon is drawn ${SI_DEPTH} µm deep, the collecting depth of the deep-depleted part.`, view: { ...HOME, yaw: 2.2, pitch: -0.15 }, frame: ['cornerbox'], cut: 1, explode: 0 },
    { title: 'The whole chip', text: `In its ceramic package, ${PACKAGE.w} × ${PACKAGE.l} mm with ${PACKAGE.pins} pins, the image area is ${PACKAGE.image} mm square: the corner drawn here, ${(AREA_X / 1000).toFixed(2)} mm across, is a speck at its output corner.`, view: { ...HOME, yaw: 2.4, pitch: 0.75 }, frame: ['pkgbox'], cut: 0, explode: 0 },
  ];
}
