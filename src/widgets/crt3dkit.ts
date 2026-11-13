// The colour picture tube on the studio renderer (DOM-free, tested). The scan, the beam's deflection and the phosphor are
// crt3dparts.ts's (ScanRef held to lib/raster.ts SCAN_OUT, beamAt, CrtRun, GEOM, beamPath, spotOf); this file draws them
// as true shapes in millimetres. The neck is a lathed glass shell with its stem and pins; the funnel a lofted shell from
// the round neck to the rectangular face (crt3dparts.ts funnelSection), coated with aquadag; the faceplate a curved glass
// panel with the phosphor screen on its inside as a 64 × 64 data texture the view writes every frame (one texel a cell, the
// colour the scan-out sent, faded by the persistence); the shadow mask a steel sheet behind it. The gun's electrodes are
// hollow nickel cups on glass beads, the yoke a ferrite ring with four saddle coils glowing with their current, three
// magnet rings on the neck, the anode button, the getter and the implosion band. The bulb opens along its axis (the cut)
// so the gun and the beams show; the screen and the glass in front of it stay whole. The Mask view is a model of its own:
// a patch of the mask, the dots behind it and the three beams crossing in one hole, to scale.
//
// Sourced (crt3dparts.ts GEOM): the 29.1 mm neck and the 90° 14-inch class (Toshiba Colour Picture Tubes 1974: 13V, 90°,
// neck 29.1 ± 1.6 mm, 335.4 mm diagonal); the in-line gun's 5.08 mm beam spacing (US6107729, the conventional neck); the
// 0.27 mm triad pitch, within US6107729's 0.2 to 0.3 mm for circular holes, and the 0.12 mm hole within its 0.08 to 0.14 mm;
// mask steel 0.15 mm (US4707633: 0.15 to 0.2 mm preferred). Drawn: the electrodes' shapes, glass walls, the coils' turns.

import { lathe, merge, roundedBox, surface, sweep, torus, transform, tube, type Geo } from '../gl/kit/geo';
import { M, type DataTex, type Material } from '../gl/kit/materials';
import type { Beat, Item, Model3, StudioAnchor } from '../gl/kit/scene';
import type { Instance, RGB } from '../gl/instances';
import { quatAxisAngle, type Quat, type Vec3 } from '../gl/math';
import { GEOM, MASK, W, beamPath, crtAnchors, levelsOf, maskBeam, sagAt, sectionPoint, spotOf, type BeamPos, type CrtRun } from './crt3dparts';

export const SRC = {
  neck: 'Toshiba Colour Picture Tubes catalogue (1974): 14-inch 90° tubes, neck 29.1 ± 1.6 mm; US6107729 (the conventional neck)',
  gun: 'in-line gun, beams 5.08 mm apart: US6107729, the conventional 29.1 mm neck; electrode shapes drawn',
  triad: 'triad pitch 0.27 mm: within the 0.2 to 0.3 mm US6107729 gives for circular-hole masks',
  hole: 'hole 0.12 mm: within the 0.08 to 0.14 mm of US6107729 (drawn square)',
  mask: 'mask steel 0.15 mm thick: US4707633 prefers 0.15 to 0.2 mm',
  screen: 'one cell a pixel: 4.25 mm, about 16 triads (crt3dparts.ts TRIADS_PER_CELL)',
  face: 'faceplate radius 2 m: an estimate (no source found)',
  drawn: 'drawn: shape and size illustrative',
};

/** Glass walls drawn (mm): an illustration, no source found for this tube's. */
export const WALL = { neck: 2.4, funnel: 5, panel: 12 } as const;

export type CrtView = 'overview' | 'gun' | 'yoke' | 'mask';
export interface CrtRgb { r: RGB; g: RGB; b: RGB; ghost: RGB; copper: RGB; heater: RGB }
export interface CrtLook {
  detail: 'full' | 'flat';
  view: CrtView;
  /** The screen's texture (full) and, for the flat drawing, each cell's colour now. */
  tex: DataTex;
  cell: (i: number) => RGB;
  /** The beam now and its gun levels, for the flat drawing (full: the view instances it). */
  beam: BeamPos | null;
  levels: RGB;
  /** The yoke currents, quantized by the view (the coils' glow). */
  current: { h: number; v: number };
  rgb: CrtRgb;
  /** The cutaway knob (0 … 1): the glass's cut edge is drawn, lit, once the tube is fully open. */
  cut?: number;
}

const cache = new Map<string, Geo>();
const once = (key: string, make: () => Geo): Geo => { let g = cache.get(key); if (!g) { g = make(); cache.set(key, g); } return g; };
function matOf(q: Quat): Float32Array {
  const [x, y, z, w] = q;
  return new Float32Array([1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0, 2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0, 2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0, 0, 0, 0, 1]);
}
const Y_TO_X = quatAxisAngle([0, 0, 1], -Math.PI / 2);
/** A lathe about y turned onto the tube's axis, x. */
const onX = (g: Geo): Geo => transform(g, matOf(Y_TO_X));
const moved = (g: Geo, p: Vec3): Geo => transform(g, new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, p[0], p[1], p[2], 1]));
const boxAt = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, r = 0): Geo => moved(roundedBox(x1 - x0, y1 - y0, z1 - z0, r, r ? 2 : 1), [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]);
const shell = (r0: number, r1: number, a: number, b: number, seg: number) => onX(lathe([[r0, a], [r1, a], [r1, b], [r0, b], [r0, a]], { seg, crease: 60 }));

/** The rotation taking +y to the unit vector d (an instanced cylinder along a segment). */
export function quatFromY(d: Vec3): Quat {
  const l = Math.hypot(d[0], d[1], d[2]) || 1, x = d[0] / l, y = d[1] / l, z = d[2] / l;
  if (y < -0.999999) return [1, 0, 0, 0];
  // cross([0,1,0], d) = [z, 0, -x]; w = 1 + dot
  const q: Quat = [z, 0, -x, 1 + y], n = Math.hypot(...q);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

// ---------------------------------------------------------------- the screen as data

/** The screen's texels: cell i (row-major, x across) at its glow now, in the texture's columns mirrored (the surface's u runs
 *  right to left seen from the front, so its normal faces the viewer). Alpha 255. */
export function screenPixels(run: CrtRun, now: number, tau: number, out: Uint8Array): Uint8Array {
  for (let i = 0; i < W * W; i++) {
    const g = run.glow(i, now, tau), o = 4 * (Math.floor(i / W) * W + (W - 1 - (i % W)));
    if (g < 0.004) { out[o] = out[o + 1] = out[o + 2] = 0; out[o + 3] = 255; continue; }
    const c = levelsOf(run.litCol[i]);
    const k = 255 * SCREEN_GAIN * g;
    out[o] = Math.round(k * c[0]); out[o + 1] = Math.round(k * c[1]); out[o + 2] = Math.round(k * c[2]); out[o + 3] = 255;
  }
  return out;
}
/** The texels' scale: the renderer doubles an emit texture, and a full white cell should glow, not blow out. */
export const SCREEN_GAIN = 0.5;
export const newScreenTex = (): DataTex => ({ w: W, h: W, pixels: new Uint8Array(W * W * 4), rev: 0, mode: 'emit' });

// ---------------------------------------------------------------- the beams, instanced by the view

export const SEG = tube([[0, -0.5, 0], [0, 0.5, 0]], 1, { sides: 8 });
const GUN_Z = [-GEOM.GUN_PITCH, 0, GEOM.GUN_PITCH];
/** Each lit gun's beam from the gun through the yoke to its dot, as segments (radius 1.2 + 0.8 · level: drawn thicker than life, and glowing, so the path can be followed). */
export function beamSegments(b: BeamPos, levels: RGB, rgb: CrtRgb): Instance[] {
  const spot = spotOf(b.x, b.y), cols = [rgb.r, rgb.g, rgb.b], out: Instance[] = [];
  if (b.blanked) return out;
  GUN_Z.forEach((z, k) => {
    const lv = levels[k];
    if (lv <= 0.001) return;
    const p = beamPath(z, spot), r = 1.2 + 0.8 * lv;
    for (let i = 1; i < p.length; i++) {
      const a = p[i - 1], c = p[i], d: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], len = Math.hypot(...d);
      if (len < 1e-6) continue;
      out.push({ pos: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2], scale: [r, len, r], rot: quatFromY(d), color: cols[k], emissive: cols[k].map((v) => v * (0.9 + 0.8 * lv)) as RGB });
    }
  });
  return out;
}
/** While blanked: where the beam is flying back, one faint line (the grid has cut it off). */
export function ghostSegments(b: BeamPos, rgb: CrtRgb): Instance[] {
  if (!b.blanked) return [];
  const p = beamPath(0, spotOf(b.x, b.y)), out: Instance[] = [];
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], c = p[i], d: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], len = Math.hypot(...d);
    if (len > 1e-6) out.push({ pos: [(a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2], scale: [0.6, len, 0.6], rot: quatFromY(d), color: [...rgb.ghost, 0.35] as [number, number, number, number] });
  }
  return out;
}

// ---------------------------------------------------------------- the tube

const G = GEOM, GY = G.H_MM / 2 + G.MARGIN, GZ = G.W_MM / 2 + G.MARGIN;
/** The funnel's mean radius at x (the yoke's ring follows it). */
const funnelR = (x: number): number => Math.hypot(...sectionPoint(Math.max(G.JOIN_X, x), Math.PI / 4));

/** The funnel as a closed shell between two insets from its outside: the glass (0 to WALL.funnel), or the aquadag film
 *  just inside it; outside, inside and the two rims, so the cut shows the wall's edge. */
function funnelGeo(full: boolean, outIn = 0, inIn: number = WALL.funnel, x0: number = G.JOIN_X, x1: number = G.FUNNEL_X1): Geo {
  const nu = full ? 72 : 20, nv = full ? 24 : 8;
  const at = (x: number, phi: number, inset: number): Vec3 => {
    const [y, z] = sectionPoint(x, phi), r = Math.hypot(y, z) || 1, k = (r - inset) / r;
    return [x, y * k, z * k];
  };
  const X = (v: number) => x0 + (x1 - x0) * v, P = (u: number) => 2 * Math.PI * u + 1e-4;
  const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return merge([
    surface((u, v) => at(X(v), P(u), outIn), nu, nv),
    surface((u, v) => at(X(u), P(v), inIn), nv, nu),
    surface((u, v) => lerp(at(x0, P(u), inIn), at(x0, P(u), outIn), v), nu, 1),
    surface((u, v) => lerp(at(x1, P(v), inIn), at(x1, P(v), outIn), u), 1, nu),
  ], 'funnel');
}
/** The faceplate: a curved glass panel, back face on the face's sphere, WALL.panel thick. */
function faceGeo(full: boolean): Geo {
  const n = full ? 24 : 6, T = WALL.panel, back = (y: number, z: number): Vec3 => [G.D - sagAt(y, z), y, z], front = (y: number, z: number): Vec3 => [G.D + T - sagAt(y, z), y, z];
  const Z = (u: number) => -GZ + 2 * GZ * u, Y = (v: number) => -GY + 2 * GY * v;
  const mix = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1], a[2]];
  return merge([
    surface((u, v) => back(Y(v), Z(u)), n, n),
    surface((u, v) => front(Y(u), Z(v)), n, n),
    surface((u, v) => mix(back(GY, Z(u)), front(GY, Z(u)), v), n, 1),
    surface((u, v) => mix(back(-GY, Z(v)), front(-GY, Z(v)), u), 1, n),
    surface((u, v) => mix(back(Y(v), GZ), front(Y(v), GZ), u), 1, n),
    surface((u, v) => mix(back(Y(u), -GZ), front(Y(u), -GZ), v), n, 1),
  ], 'faceplate');
}
/** A saddle coil's turns round the neck and funnel (crt3dparts.ts yokeParts's path), centred on angle `centre`. */
function coilPath(centre: number, half: number, t: number, outer: number): Vec3[] {
  const al = ((half - t * 4) * Math.PI) / 180, ofs = 3 + t * 1.3 + outer * 5, xb = G.YOKE_X0 + t * 1.5, xf = G.YOKE_X1 - 6 - t * 1.5;
  const rAt = (x: number, th: number) => (x <= G.JOIN_X ? G.NECK_R + 2.5 + ofs : Math.hypot(...sectionPoint(x, th)) + ofs);
  const at = (x: number, th: number): Vec3 => { const r = rAt(x, th); return [x, r * Math.cos(th), r * Math.sin(th)]; };
  const pts: Vec3[] = [];
  for (let i = 0; i <= 6; i++) pts.push(at(xb + ((xf - xb) * i) / 6, centre - al));
  for (let i = 1; i <= 8; i++) pts.push(at(xf, centre - al + (2 * al * i) / 8));
  for (let i = 1; i <= 6; i++) pts.push(at(xf + ((xb - xf) * i) / 6, centre + al));
  for (let i = 1; i < 8; i++) pts.push(at(xb, centre + al - (2 * al * i) / 8));
  return pts;
}
const coilGeo = (centre: number, outer: number, full: boolean) => merge([0, 1, 2].map((t) => tube(coilPath(centre, 48, t, outer), 0.7, { sides: full ? 8 : 4, closed: true, bend: 1 })), 'coil');

export const CUT_OPEN = GZ + 40;
export const FRAME_GROUPS = ['tubebox', 'screenbox', 'gunbox', 'yokebox', 'maskbox'];
const ghostMat = M.make({ base: [0, 0, 0], metal: 0, rough: 1, label: 'frame' });

export function crtModel(look: CrtLook): Model3 {
  return look.view === 'mask' ? maskModel(look) : tubeModel(look);
}

function tubeModel(look: CrtLook): Model3 {
  const full = look.detail === 'full', seg = full ? 48 : 16, items: Item[] = [];
  const glass = M.make({ ...M.glass, transmit: 0.86, rough: 0.03, label: 'neck glass (leaded)' });
  const funnelGlass = M.make({ ...M.glass, transmit: 0.86, rough: 0.03, label: 'funnel glass (leaded)' });
  const nickel = M.make({ ...M.nickel, base: [0.78, 0.77, 0.73], metal: 0.55, rough: 0.3, label: 'nickel' });
  const dag = M.make({ base: '--crt-dag', metal: 0.35, rough: 0.45, label: 'aquadag (colloidal graphite) on the inside of the glass' });
  const edge = M.make({ base: [0.78, 0.88, 0.86], metal: 0, rough: 0.2, emit: [0.55, 0.7, 0.68], glow: 0.35, bloom: 0.3, label: 'the glass cut through (its edge)' });
  // the neck, its stem, the exhaust tip and the pins
  items.push({ geo: once(`neck${seg}`, () => shell(G.NECK_R - WALL.neck, G.NECK_R, G.NECK_X0 + 6, G.JOIN_X, seg)), mat: glass, name: 'neck', group: 'neck', order: 2, info: { dim: `${G.NECK_OD} mm across`, source: SRC.neck } });
  items.push({ geo: once(`stem${seg}`, () => onX(lathe([[0, G.NECK_X0], [G.NECK_R - 0.5, G.NECK_X0], [G.NECK_R - 0.5, G.NECK_X0 + 6], [0, G.NECK_X0 + 6]], { seg }))), mat: M.make({ ...M.glass, transmit: 0, base: '--crt-glass', rough: 0.2, label: 'pressed glass stem' }), name: 'stem', group: 'stem', explode: [-60, 0, 0], info: { note: `${G.PINS} pins: the model's choice (no base diagram found)` } });
  items.push({ geo: once('tip', () => onX(lathe([[0, G.NECK_X0 - 9], [1.5, G.NECK_X0 - 7], [2.2, G.NECK_X0], [0, G.NECK_X0]], { seg: 16 }))), mat: M.make({ ...M.glass, transmit: 0, base: '--crt-glass', rough: 0.2, label: 'glass' }), name: 'exhaust tip (sealed after pumping)', group: 'stem', explode: [-60, 0, 0] });
  const pins = once(`pins${G.PINS}`, () => merge(Array.from({ length: G.PINS }, (_, i) => { const th = (i / G.PINS) * 2 * Math.PI, y = 11 * Math.cos(th), z = 11 * Math.sin(th); return tube([[G.NECK_X0 + 2, y, z], [G.NECK_X0 - 18, y, z]], 0.55, { sides: 6 }); }), 'pins'));
  items.push({ geo: pins, mat: M.make({ ...M.nickel, base: '--crt-pin', label: 'pins (nickel-plated)' }), name: 'stem pins', group: 'stem', explode: [-60, 0, 0], info: { note: SRC.drawn } });
  // the funnel and the faceplate
  items.push({ geo: once(`dagneck${seg}`, () => shell(G.NECK_R - WALL.neck - 0.85, G.NECK_R - WALL.neck - 0.05, -58, G.JOIN_X, seg)), mat: dag, name: 'aquadag coating', group: 'funnel', order: 1, info: { note: 'graphite on the glass’s inside, from the gun’s springs over the whole funnel: the final anode’s conductor (drawn 0.8 mm thick so its cut edge shows)' } });
  items.push({ geo: once(`dagfun${full}`, () => funnelGeo(full, WALL.funnel + 0.05, WALL.funnel + 0.85, G.JOIN_X, G.FUNNEL_X1 - 6)), mat: dag, name: 'aquadag coating', group: 'funnel', order: 1 });
  items.push({ geo: once(`funnel${full}`, () => funnelGeo(full)), mat: funnelGlass, name: 'funnel', group: 'funnel', order: 2, info: { note: 'aquadag inside joins the final anode to the button; outside, earthed, it makes the bulb a capacitor for the high voltage', source: SRC.drawn } });
  items.push({ geo: once(`face${full}`, () => faceGeo(full)), mat: M.make({ ...M.glass, transmit: 0.86, rough: 0.03, label: 'faceplate glass (barium-strontium, lead-free)' }), name: 'faceplate', group: 'face', cut: 'none', order: 2, explode: [90, 0, 0], info: { dim: `${G.DIAG} mm diagonal, 4:3`, source: SRC.neck, note: SRC.face } });
  // the phosphor screen on its inside: the view's texture, or the flat drawing's cells
  if (full) {
    items.push({ geo: once('screen', () => surface((u, v) => { const p = spotOf((1 - u) * W, v * W); return [p[0] - 0.25, p[1], p[2]]; }, 32, 32)),
      mat: M.make({ base: '--crt-off', metal: 0, rough: 0.6, data: look.tex, label: 'phosphor screen: one cell a pixel' }), name: 'phosphor screen', group: 'face', cut: 'none', explode: [90, 0, 0], shadow: false, info: { note: SRC.screen } });
  } else {
    const mats = new Map<string, Material>(), B = 2, n = W / B, cw = (G.W_MM / n) * 0.94, ch = (G.H_MM / n) * 0.94;
    for (let cy = 0; cy < n; cy++) for (let cx = 0; cx < n; cx++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < B; dy++) for (let dx = 0; dx < B; dx++) { const c = look.cell((cy * B + dy) * W + cx * B + dx); r = Math.max(r, c[0]); g = Math.max(g, c[1]); b = Math.max(b, c[2]); }
      const q = (v: number) => Math.round(v * 6) / 6, key = `${q(r)}|${q(g)}|${q(b)}`;
      if (!mats.has(key)) mats.set(key, M.make({ base: [0.09 + 0.85 * q(r), 0.09 + 0.85 * q(g), 0.1 + 0.85 * q(b)], metal: 0, rough: 0.6, label: 'phosphor' }));
      const [xf, yc, zc] = spotOf((cx + 0.5) * B, (cy + 0.5) * B);
      items.push({ geo: once(`cell${cw.toFixed(2)}`, () => roundedBox(0.4, ch, cw, 0, 1)), mat: mats.get(key)!, at: [xf - 0.25, yc, zc], name: 'phosphor screen', group: 'face', cut: 'none' });
    }
  }
  // the shadow mask, Q behind the screen
  items.push({ geo: once(`mask${full}`, () => surface((u, v) => { const y = -G.H_MM / 2 - 6 + (G.H_MM + 12) * v, z = -G.W_MM / 2 - 6 + (G.W_MM + 12) * u; return [G.D - G.Q - sagAt(y, z), y, z]; }, full ? 24 : 6, full ? 24 : 6)),
    mat: M.make({ base: '--crt-mask', metal: 0.7, rough: 0.5, label: 'steel shadow mask (its holes: the Mask view)' }), name: 'shadow mask', group: 'mask', cut: 'open', explode: [55, 0, 0], info: { dim: `${G.Q.toFixed(1)} mm behind the screen (derived)`, source: SRC.mask } });
  // the implosion band round the panel's skirt
  const band: Vec3[] = [];
  const corner = 14, Rb = 1.5, perim = (t: number): [number, number] => {
    const hy = GY + Rb, hz = GZ + Rb, sides = [2 * (hz - corner), 2 * (hy - corner)], L = 2 * (sides[0] + sides[1]) + 2 * Math.PI * corner;
    let d = t * L;
    const segs: [number, (s: number) => [number, number]][] = [
      [sides[0] / 2, (s) => [hy, s]], [Math.PI * corner / 2, (s) => { const a = s / corner; return [hy - corner + corner * Math.cos(a), hz - corner + corner * Math.sin(a)]; }],
      [sides[1], (s) => [hy - corner - s, hz]], [Math.PI * corner / 2, (s) => { const a = Math.PI / 2 + s / corner; return [-hy + corner + corner * Math.cos(a), hz - corner + corner * Math.sin(a)]; }],
      [sides[0], (s) => [-hy, hz - corner - s]], [Math.PI * corner / 2, (s) => { const a = Math.PI + s / corner; return [-hy + corner + corner * Math.cos(a), -hz + corner + corner * Math.sin(a)]; }],
      [sides[1], (s) => [-hy + corner + s, -hz]], [Math.PI * corner / 2, (s) => { const a = 1.5 * Math.PI + s / corner; return [hy - corner + corner * Math.cos(a), -hz + corner + corner * Math.sin(a)]; }],
      [sides[0] / 2, (s) => [hy, -hz + corner + s]],
    ];
    for (const [len, f] of segs) { if (d <= len) return f(d); d -= len; }
    return [hy, 0];
  };
  for (let i = 0; i < 96; i++) { const [y, z] = perim(i / 96); band.push([G.D + 4 - sagAt(y, z), y, z]); }
  items.push({ geo: once('band', () => sweep(band, [[-0.6, -4], [0.6, -4], [0.6, 4], [-0.6, 4]], { closed: true })), mat: M.make({ ...M.steel, label: 'steel tension band' }), name: 'implosion band', group: 'face', cut: 'none', explode: [90, 0, 0], info: { note: 'a steel strap in tension round the panel: if the evacuated bulb cracks it holds the glass in', source: 'tension-band patents (US4037255, US4004092)' } });
  // the anode button on the funnel's top
  const top = sectionPoint(70, 0)[0];
  items.push({ geo: once('anode', () => merge([lathe([[0, 0], [7, 0], [7, 3], [3, 4], [0, 4]], { seg: 24 }), lathe([[0, 4], [1.8, 4], [1.8, 11], [0, 11]], { seg: 12 })], 'anode')), mat: M.make({ ...M.steel, label: 'anode button' }), at: [70, top - 1, 0], name: 'anode button', group: 'funnel', info: { note: `${G.ANODE_KV[0]} to ${G.ANODE_KV[1]} kV from the flyback transformer, to the aquadag inside` } });
  // the gun: cathodes, heaters, G1 … G6 as hollow nickel cups on two glass beads
  const cup = (x0: number, x1: number, hy = 5.5, hz = 9.5) => once(`cup${x0}|${x1}|${hy}`, () => boxAt(x0, x1, -hy, hy, -hz, hz, Math.min(1.2, (x1 - x0) / 2.5)));
  const electrode = (geo: Geo, name: string, note: string) => items.push({ geo, mat: nickel, name, group: 'gun', cut: 'open', explode: [-45, 0, 0], info: { note, source: SRC.gun } });
  electrode(cup(-144.4, -143.6), 'G1, control grid', 'held negative of each cathode: it meters the beam current, the pixel\'s colour field');
  electrode(cup(-141.4, -140.6), 'G2, screen grid', 'a few hundred volts: draws the electrons out');
  electrode(cup(-139, -117), 'G3, focus', 'with G4 and G5, a lens that brings each beam to a spot on the screen');
  electrode(cup(-115, -114), 'G4', 'part of the focus lens');
  electrode(cup(-112, -88), 'G5, focus', 'part of the focus lens');
  electrode(cup(-86, -62, 5.8, 9.8), 'G6, final anode', `at ${G.ANODE_KV[0]} to ${G.ANODE_KV[1]} kV, joined to the aquadag through springs`);
  for (const z of GUN_Z) {
    items.push({ geo: once(`cath${z}`, () => moved(onX(lathe([[0, 0], [1.7, 0], [1.7, 5], [0, 5]], { seg: 20 })), [-151, 0, z])), mat: M.make({ ...M.nickel, emit: '--crt-heater', glow: 0.7, bloom: 1.2, label: 'oxide-coated nickel cathode (dull orange at its working heat)' }), name: 'cathodes', group: 'gun', cut: 'open', explode: [-45, 0, 0], info: { note: 'red, green, blue: one gun each, in line', source: SRC.gun } });
    items.push({ geo: once(`heat${z}`, () => tube([[-154, 0, z], [-151, 0, z]], 0.7, { sides: 8 })), mat: M.make({ base: '--crt-heater', metal: 0, rough: 0.5, emit: '--crt-heater', glow: 3, bloom: 2, label: 'heater' }), name: 'heaters', group: 'gun', explode: [-45, 0, 0] });
  }
  for (const z of [-12.6, 12.6]) items.push({ geo: once(`bead${z}`, () => boxAt(-150, -64, -4, 4, z - 1.6, z + 1.6, 1)), mat: M.make({ base: [0.86, 0.89, 0.9], metal: 0, rough: 0.3, coat: 0.5, label: 'glass bead (holds the electrodes)' }), name: 'glass beads', group: 'gun', explode: [-45, 0, 0] });
  items.push({ geo: once('springs', () => merge([-5, 5].map((z) => tube([[-63, 5.8, z], [-57, 8.5, z], [-54, G.NECK_R - WALL.neck - 0.3, z]], 0.4, { sides: 6, bend: 1 })), 'springs')), mat: M.make({ ...M.steel, label: 'contact springs' }), name: 'snubber springs', group: 'gun', explode: [-45, 0, 0], info: { note: 'touch the aquadag: G6 at anode potential' } });
  items.push({ geo: once('getter', () => moved(transform(torus(3, 0.9, 20, 6), matOf(quatAxisAngle([0, 0, 1], Math.PI / 2))), [-50, -9, 0])), mat: M.make({ ...M.steel, label: 'getter ring (barium)' }), name: 'getter', group: 'gun', explode: [-45, 0, 0], info: { note: 'flashed by induction after sealing: it soaks up what gas is left' } });
  // the yoke: ferrite ring, four saddle coils (glowing with their current), the magnet rings behind it
  const prof: [number, number][] = [];
  for (let i = 0; i <= 5; i++) { const x = -2 + 20 * (i / 5); prof.push([funnelR(x) + 17, x]); }
  for (let i = 5; i >= 0; i--) { const x = -2 + 20 * (i / 5); prof.push([funnelR(x) + 11.5, x]); }
  prof.push(prof[0]);
  const yokeUp: Vec3 = [0, 55, 0];
  items.push({ geo: once(`ferrite${seg}`, () => onX(lathe(prof, { seg, crease: 50 }))), mat: M.make({ base: '--crt-ferrite', metal: 0.1, rough: 0.7, label: 'ferrite' }), name: 'ferrite core', group: 'yoke', explode: yokeUp, info: { note: SRC.drawn } });
  const glow = (c: number) => Math.min(1, Math.abs(c));
  const coilMat = (c: number) => M.make({ ...M.copper, base: '--crt-copper', metal: 0.6, rough: 0.4, emit: [1, 0.45, 0.15], glow: 0.6 * glow(c), label: 'copper winding (glowing with its current)' });
  const hm = coilMat(look.current.h), vm = coilMat(look.current.v);
  for (const c of [0, Math.PI]) items.push({ geo: once(`coilh${c}|${full}`, () => coilGeo(c, 0, full)), mat: hm, name: 'horizontal coils (sweep)', group: 'yoke', explode: yokeUp, info: { note: 'above and below the neck: their field is vertical, so they push the beam sideways' } });
  for (const c of [Math.PI / 2, -Math.PI / 2]) items.push({ geo: once(`coilv${c}|${full}`, () => coilGeo(c, 1, full)), mat: vm, name: 'vertical coils (step)', group: 'yoke', explode: yokeUp, info: { note: 'at the sides: their field is horizontal, so they step the beam down' } });
  items.push({ geo: once('rings', () => merge([-58, -52, -46].map((x) => moved(transform(torus(G.NECK_R + 1.6, 1.3, 40, 6), matOf(quatAxisAngle([0, 0, 1], Math.PI / 2))), [x, 0, 0])), 'rings')), mat: M.make({ base: '--crt-ferrite', metal: 0.2, rough: 0.6, label: 'magnetised rings' }), name: 'purity and convergence magnets', group: 'yoke', explode: [0, 45, 0], info: { note: 'pairs of magnetised rings, turned against each other to trim where the beams land' } });
  // the flat drawing's beam (the full one is instanced)
  if (!full && look.beam && !look.beam.blanked) {
    const spot = spotOf(look.beam.x, look.beam.y), cols = [look.rgb.r, look.rgb.g, look.rgb.b];
    GUN_Z.forEach((z, k) => { if (look.levels[k] > 0.001) items.push({ geo: tube(beamPath(z, spot), 2, { sides: 4 }), mat: M.make({ base: cols[k], metal: 0, rough: 0.5, label: 'beam' }), name: 'electron beams', group: 'beams', cut: 'none' }); });
  }
  // the glass's cut edge on the section (z = 0), lit, once the tube is fully open: a drawing aid, not a part
  if ((look.cut ?? 1) > 0.98) items.push({ geo: once(`edge${full}`, () => cutEdge(full ? 8 : 4)), mat: edge, name: 'glass envelope (cut)', group: 'funnel', cut: 'none', shadow: false });
  // frames
  const fb = (g: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number) => items.push({ geo: once(`f${g}`, () => boxAt(x0, x1, y0, y1, z0, z1)), mat: ghostMat, group: g, cut: 'none', shadow: false });
  fb('tubebox', G.NECK_X0 - 18, G.D + WALL.panel, -GY, GY, -GZ, GZ);
  fb('screenbox', G.D - 40, G.D + WALL.panel, -GY, GY, -GZ, GZ);
  fb('gunbox', G.NECK_X0 - 18, -50, -G.NECK_R - 2, G.NECK_R + 2, -G.NECK_R - 2, G.NECK_R + 2);
  fb('yokebox', -62, 24, -funnelR(18) - 18, funnelR(18) + 18, -funnelR(18) - 18, funnelR(18) + 18);
  return { items, cuts: { planes: [{ n: [0, 0, 1], d: 0 }], open: [CUT_OPEN] }, anchors: tubeAnchors(look.view), beats: tubeBeats(), floor: -GY - 40, look: { exposure: 1.1, keyDir: [-0.5, 0.8, -0.2] } };
}

/** The glass wall's middle along the cut plane (z = 0), above and below the axis: neck, funnel and faceplate as one line. */
function cutEdge(sides: number): Geo {
  const out: Geo[] = [];
  for (const s of [1, -1]) {
    const pts: Vec3[] = [[G.NECK_X0 + 6, s * (G.NECK_R - WALL.neck / 2), 0], [G.JOIN_X, s * (G.NECK_R - WALL.neck / 2), 0]];
    for (let i = 1; i <= 24; i++) { const x = G.JOIN_X + ((G.FUNNEL_X1 - G.JOIN_X) * i) / 24, y = Math.abs(sectionPoint(x, s > 0 ? 0 : Math.PI)[0]); pts.push([x, s * (y - WALL.funnel / 2), 0]); }
    out.push(tube(pts, 1.1, { sides, bend: 2 }));
  }
  const face: Vec3[] = [];
  for (let i = 0; i <= 24; i++) { const y = -GY + (2 * GY * i) / 24; face.push([G.D + WALL.panel / 2 - sagAt(y, 0), y, 0]); }
  out.push(tube(face, 1.1, { sides, bend: 2 }));
  return merge(out, 'cut edge');
}

function tubeAnchors(view: CrtView): StudioAnchor[] {
  const up: Vec3 = [0, 1, 0], side: Vec3 = [0, 0.3, 1], down: Vec3 = [0, -1, 0], front: Vec3 = [1, 0, 0];
  if (view === 'gun') return [
    { text: 'cathodes + heaters', p: [-150, 0, -G.GUN_PITCH], side: 'l', n: side, on: 'gun' },
    { text: 'G1 grid', p: [-144, 5.5, -6], side: 't', n: up, on: 'gun' },
    { text: 'G2 screen grid', p: [-141, -5.5, -6], side: 'b', n: down, on: 'gun' },
    { text: 'G3–G5 focus', p: [-110, 5.5, -6], side: 't', n: up, on: 'gun' },
    { text: 'G6 final anode', p: [-74, -5.8, -6], side: 'b', n: down, on: 'gun' },
    { text: 'glass bead', p: [-100, 4, -12.6], side: 'r', n: side, on: 'gun' },
    { text: `neck, ${G.NECK_OD} mm`, p: [-125, -G.NECK_R, -2], side: 'b', n: down, on: 'neck' },
  ];
  if (view === 'yoke') return [
    { text: 'sweep coils', p: [-20, G.NECK_R + 6, -3], side: 't', n: up, on: 'yoke' },
    { text: 'step coils', p: [-20, 0, -(G.NECK_R + 10)], side: 'r', n: side, on: 'yoke' },
    { text: 'ferrite core', p: [8, funnelR(8) + 17, 0], side: 't', n: up, on: 'yoke' },
    { text: 'purity magnets', p: [-52, -(G.NECK_R + 2.9), 0], side: 'b', n: down, on: 'yoke' },
    { text: 'neck / funnel join', p: [G.JOIN_X, -G.NECK_R - 2, -2], side: 'b', n: down },
  ];
  const fn = sectionPoint(90, Math.PI), sp = spotOf(W * 0.2, W * 0.85);
  return [
    { text: 'electron gun', p: [-100, -5.5, -9.5], side: 'l', n: side, on: 'gun' },
    { text: 'deflection yoke', p: [8, funnelR(8) + 17, 0], side: 't', n: up, on: 'yoke' },
    { text: 'funnel, aquadag', p: [90, fn[0], fn[1]], side: 'b', n: down, on: 'funnel' },
    { text: 'phosphor screen', p: [sp[0] + 4, sp[1], sp[2]], side: 'r', n: front, on: 'face' },
    { text: 'anode button', p: [70, sectionPoint(70, 0)[0] + 10, 0], side: 't', n: up, on: 'funnel' },
    { text: 'shadow mask', p: [G.D - G.Q - sagAt(-G.H_MM / 2 - 6, -G.W_MM / 2), -G.H_MM / 2 - 6, -G.W_MM / 2], side: 'r', n: [-1, 0, 0], on: 'mask', minor: true },
  ];
}

/** The views: 3/4 from the screen's side (the cut faces the camera), front, side, gun, yoke. Studio yaw: 0 looks from +z, π/2 from +x. */
export const VIEWS: Record<CrtView | 'three' | 'front' | 'side', { yaw: number; pitch: number; frame: string }> = {
  three: { yaw: 0.45, pitch: 0.18, frame: 'tubebox' }, overview: { yaw: 0.45, pitch: 0.18, frame: 'tubebox' },
  front: { yaw: 1.45, pitch: 0.1, frame: 'screenbox' }, side: { yaw: 0.02, pitch: 0.12, frame: 'tubebox' },
  gun: { yaw: 0.35, pitch: 0.3, frame: 'gunbox' }, yoke: { yaw: 0.5, pitch: 0.35, frame: 'yokebox' },
  mask: { yaw: -0.8, pitch: 0.45, frame: 'maskbox' },
};
export const HOME = { target: [0, 0, 0] as Vec3, yaw: VIEWS.three.yaw, pitch: VIEWS.three.pitch, dist: 700 };
export const KNOBS = { cut: 1, explode: 0 };
/** Which labels each beat of the tour shows. */
export const BEAT_VIEW: readonly CrtView[] = ['overview', 'gun', 'yoke', 'overview', 'overview'];

function tubeBeats(): Beat[] {
  const v = (k: keyof typeof VIEWS) => ({ ...HOME, yaw: VIEWS[k].yaw, pitch: VIEWS[k].pitch });
  return [
    { title: 'A colour picture tube', text: `A 14-inch, 90° tube, opened along its axis: the gun in the ${G.NECK_OD} mm neck, the yoke where the neck widens into the funnel, and the phosphor screen on the inside of the faceplate. The beam is wherever the scan-out's counter says.`, view: v('three'), frame: ['tubebox'], cut: 1, explode: 0 },
    { title: 'The gun', text: `A heater warms three cathodes, one a colour, ${G.GUN_PITCH} mm apart in a line. G1, held negative of each, meters its beam current: the pixel's colour field. G2 draws the electrons out, G3 to G5 focus them, and G6, the final anode at ${G.ANODE_KV[0]} to ${G.ANODE_KV[1]} kV, sends them on at about a third of the speed of light.`, view: v('gun'), frame: ['gunbox'], cut: 1, explode: 0 },
    { title: 'The yoke', text: 'Copper saddle coils on a ferrite ring bend the beams with a magnetic field (F = −e v × B): the coils above and below the neck sweep them sideways with a sawtooth current, the ones at the sides step them down. Each coil glows with its current here.', view: v('yoke'), frame: ['yokebox'], cut: 1, explode: 0 },
    { title: 'The screen', text: 'Every phosphor cell the beam passes lights with the byte the scan-out read, and fades. The three beams cross in a hole of the shadow mask just behind the screen, so each lands on its own colour (the Mask view).', view: v('front'), frame: ['screenbox'], cut: 1, explode: 0 },
    { title: 'Pulled apart', text: 'Faceplate and screen, mask, funnel, yoke, gun and stem. The funnel and the neck are leaded glass; the faceplate is lead-free so it does not brown under the beam.', view: v('three'), frame: ['tubebox'], cut: 1, explode: 1 },
  ];
}

// ---------------------------------------------------------------- the mask close-up

function maskModel(look: CrtLook): Model3 {
  const T = G.TRIAD, mx = G.D - G.Q, nc = MASK.COLS, nr = MASK.ROWS, h = MASK.HOLE / 2, th = MASK.THICK, items: Item[] = [];
  const cz = (i: number) => (i - (nc - 1) / 2) * T, cy = (r: number) => (r - (nr - 1) / 2) * T;
  const z0 = cz(0) - T / 2, z1 = cz(nc - 1) + T / 2, y0 = cy(0) - T / 2, y1 = cy(nr - 1) + T / 2;
  const steel = M.make({ base: '--crt-mask', metal: 0.8, rough: 0.4, label: 'mask steel, 0.15 mm' });
  const plate: Geo[] = [];
  for (let r = 0; r <= nr; r++) plate.push(boxAt(mx - th, mx, r === 0 ? y0 : cy(r - 1) + h, r === nr ? y1 : cy(r) - h, z0, z1));
  for (let r = 0; r < nr; r++) for (let i = 0; i <= nc; i++) plate.push(boxAt(mx - th, mx, cy(r) - h, cy(r) + h, i === 0 ? z0 : cz(i - 1) + h, i === nc ? z1 : cz(i) - h));
  items.push({ geo: once('maskplate', () => merge(plate, 'maskplate')), mat: steel, name: 'steel shadow mask', group: 'mask', info: { dim: `holes ${MASK.HOLE} mm, steel ${th} mm, pitch ${T} mm`, source: `${SRC.triad}; ${SRC.hole}; ${SRC.mask}` } });
  items.push({ geo: once('matrix', () => boxAt(G.D, G.D + MASK.MATRIX, y0, y1, z0, z1)), mat: M.make({ base: '--crt-aquadag', metal: 0, rough: 0.8, label: 'black matrix (graphite)' }), name: 'black matrix', group: 'screen' });
  const cols = [look.rgb.r, look.rgb.g, look.rgb.b], dot = once('dot', () => onX(lathe([[0, -0.05], [MASK.DOT_R, -0.05], [MASK.DOT_R, 0], [0, 0]], { seg: 16 })));
  const blanked = !look.beam || look.beam.blanked;
  for (let r = 0; r < nr; r++) for (let i = 0; i < nc; i++) {
    const centre = r === (nr - 1) / 2 && i === (nc - 1) / 2;
    cols.forEach((c, k) => {
      const lv = centre ? Math.max(0.25, blanked ? 0 : look.levels[k]) : 0.28, q = Math.round(lv * 4) / 4;
      items.push({ geo: dot, mat: M.make({ base: c.map((v) => v * (0.35 + 0.65 * q)) as RGB, metal: 0, rough: 0.5, emit: c, glow: centre ? q * 0.8 : 0.1, label: ['red', 'green', 'blue'][k] + ' phosphor dot' }), at: [G.D, cy(r), cz(i) - (k - 1) * (T / 3)], name: 'R · G · B dots', group: 'screen' });
    });
  }
  // the three beams, thin (the real spot is wider than the hole: most of its current stops on the mask)
  GUN_Z.forEach((zi, k) => {
    const lv = blanked ? 0 : look.levels[k];
    if (lv > 0.001) items.push({ geo: once(`mb${k}`, () => tube(maskBeam(zi), 0.012, { sides: 6 })), mat: M.make({ base: cols[k], metal: 0, rough: 0.5, emit: cols[k], glow: 0.6, label: 'beam' }), name: 'the beams cross in this hole', group: 'beams', cut: 'none', shadow: false });
  });
  items.push({ geo: once('fmask', () => boxAt(mx - MASK.LEAD * 0.4, G.D + 0.1, y0, y1, z0, z1)), mat: ghostMat, group: 'maskbox', cut: 'none', shadow: false });
  return { items, anchors: crtAnchors('mask').map((a) => (a.text.startsWith('the beams cross') ? { ...a, text: 'beams cross here' } : a)), floor: y0 - 0.5, look: { exposure: 1.05 } };
}

