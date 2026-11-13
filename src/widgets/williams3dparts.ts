// The Williams-Kilburn storage tube as parts (DOM-free, tested). A cathode-ray tube used as a memory: a gun, electrostatic
// deflection plates (no yoke), a faceplate with a 32 x 32 raster of spots (a dot = 0, a dash = 1; digit 0 on the left, as the Baby's
// display tube showed it), and in front of the screen the pick-up plate, a wire mesh whose lead goes to an amplifier box.
// Same world axes as widgets/crt3dparts.ts: x along the tube from the gun to the screen, y up, z across the screen (pixel x grows
// towards -z, so the raster reads left to right seen from the front).
// Sources: the tube was the commercial CV1131, a 12-inch (300 mm) electrostatically deflected CRT (S. H. Lavington, Computer
// History Museum timeline, ch. 7, "type CV1131 12-inch diameter"); the University's Computer50 pages give the Baby's store "a
// standard single 6-inch-diameter CRT", so the size is one side of a conflict and the label says so;
// the pick-up plate was at first a wire mesh and later a metal plate, close to the outer face (University of Manchester, Digital60,
// "History of the Williams-Kilburn Tube"). That plate covered the face: "The plate obscures the front of the tube, so the
// stored pattern cannot be viewed directly" (Digital60), and the operators read the store on a separate display tube that
// copied it (Computer50). The model draws the pattern on the store tube's face anyway, so it can be seen, and says so. ESTIMATED, no source found: the neck diameter, the plate and gun dimensions, the
// tube's length, the 6 mm spot pitch, the phosphor colour, the mesh pitch and the amplifier box. Palette tokens are the CRT model's.

import type { RGB } from '../gl/instances';
import { add3, scale3, type Vec3 } from '../gl/math';
import { box, rod, wire, type Anchor, type Part } from '../gl/parts';
import type { CrtPalette } from './crt3dparts';

/** Digits along a line and lines of the store: the Baby's tube held 32 words of 32 digits (SSEM: 1 024 bits). */
export const DIGITS = 32, LINES = 32;

export const WGEOM = (() => {
  const FACE_D = 300; // the CV1131's diameter (Lavington)
  const PITCH = 6; // estimated: spots 6 mm apart, a 192 mm square raster inside the 300 mm face
  const RASTER = PITCH * DIGITS;
  return {
    FACE_D, FACE_R: FACE_D / 2, PITCH, RASTER,
    /** Inner face of the screen (x), the deflection centre at x = 0. */
    FACE_X: 330,
    NECK_R: 18, NECK_X0: -170, JOIN_X: 40,
    GUN_X0: -160, GUN_EXIT: -62,
    /** Electrostatic plates: Y pair (deflect up/down) first, X pair (sideways) after it; half gap and length. */
    PLATE_GAP: 6, Y_PLATES: [-52, -22] as const, X_PLATES: [-16, 14] as const,
    /** The pick-up plate: a mesh this far in front of the glass, covering the raster plus a margin. */
    MESH_GAP: 4, MESH_MARGIN: 8, MESH_PITCH: 8,
    /** Glass thickness of the faceplate. */
    GLASS: 8,
    /** Spot sizes (mm): a dot, and a dash (twice as long, along the line). */
    DOT: 1.8, DASH: 4.6,
  };
})();

const W = WGEOM;
/** A spot's deflection in pixel units (0..32): its centre in mm on the face plane [y, z]; digit 0 is on the left (z positive from the front). */
export const spotYZ = (line: number, digit: number): [number, number] => [(0.5 - (line + 0.5) / LINES) * W.RASTER, (0.5 - (digit + 0.5) / DIGITS) * W.RASTER];
/** The centre of the spot of store line `line`, digit `digit`, on the phosphor (x = the face). */
export const spotCentre = (line: number, digit: number): Vec3 => { const [y, z] = spotYZ(line, digit); return [W.FACE_X, y, z]; };
/** The index of a cell: line-major, digit 0 first in its line. */
export const cellOf = (line: number, digit: number) => line * DIGITS + digit;

/** Plate voltages (normalised, +-1 at the raster's edges) that put the beam on a spot: y deflection up/down, x sideways. */
export function deflectionOf(line: number, digit: number): { vy: number; vx: number } {
  const [y, z] = spotYZ(line, digit);
  return { vy: y / (W.RASTER / 2), vx: -z / (W.RASTER / 2) };
}

/** The beam from the gun to the spot: straight on the axis through the plates, bent in them about the deflection centre, then straight. */
export function beamPath(spot: Vec3): Vec3[] {
  const d = spot, Q = scale3(d, 30 / d[0]); // the ray from the deflection centre, 30 mm past it, out of the plates
  const P0: Vec3 = [W.Y_PLATES[0], 0, 0], C: Vec3 = [0, 0, 0];
  const pts: Vec3[] = [[W.GUN_X0 + 30, 0, 0], [W.GUN_EXIT, 0, 0], P0];
  const N = 8;
  for (let i = 1; i <= N; i++) {
    const u = i / N, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u;
    pts.push([a * P0[0] + b * C[0] + c * Q[0], a * P0[1] + b * C[1] + c * Q[1], a * P0[2] + b * C[2] + c * Q[2]]);
  }
  pts.push(spot);
  return pts;
}

/** The funnel's radius at x: the round neck, then a smooth opening to the face (a cone with a rounded start). */
export function funnelRadius(x: number): number {
  if (x <= W.JOIN_X) return W.NECK_R + 1;
  const t = Math.min(1, (x - W.JOIN_X) / (W.FACE_X - 12 - W.JOIN_X));
  return W.NECK_R + 1 + (W.FACE_R + 6 - W.NECK_R - 1) * (1 - (1 - t) ** 1.6);
}

export interface WilliamsPose {
  /** The spot under the beam (store line, digit), null: the beam is off. */
  beam: { line: number; digit: number } | null;
  /** Cell i holds 1 (a dash), 0 (a dot) or -1 (unknown: drawn faint, a dot). */
  bit: (i: number) => number;
  /** How bright cell i glows now, 0..1 (the beam writes it bright, then it fades). */
  glow: (i: number) => number;
  /** The pick-up plate's signal (the amplifier's input), -1..1. */
  plate: number;
}

const PHOSPHOR: RGB = [0.45, 1, 0.55]; // ESTIMATE: a green phosphor
const lit = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const alpha = (c: RGB, a: number): [number, number, number, number] => [c[0], c[1], c[2], a];

/** The structure that does not move: neck and funnel glass, gun, plates (tinted by their voltages), faceplate. The pick-up mesh and its lead are in poseParts (they glow with the signal). */
export function staticParts(P: CrtPalette, vx = 0, vy = 0): Part[] {
  const out: Part[] = [];
  // neck glass and stem, funnel as translucent rings and meridians
  out.push(rod(alpha(P.glass, 0.16), [W.NECK_X0, 0, 0], [W.JOIN_X, 0, 0], W.NECK_R));
  for (let i = 0; i < 8; i++) {
    const th = (i / 8) * 2 * Math.PI, y = 10 * Math.cos(th), z = 10 * Math.sin(th);
    out.push(rod(P.pin, [W.NECK_X0 + 2, y, z], [W.NECK_X0 - 16, y, z], 0.55, 0.4));
  }
  const NS = 10, NM = 24, xs = Array.from({ length: NS + 1 }, (_, i) => W.JOIN_X + ((W.FACE_X - 12 - W.JOIN_X) * i) / NS);
  const ring = (x: number): Vec3[] => Array.from({ length: NM + 1 }, (_, i): Vec3 => { const a = (i / NM) * 2 * Math.PI, r = funnelRadius(x); return [x, r * Math.cos(a), r * Math.sin(a)]; });
  const rings = xs.map(ring);
  for (const r of rings) out.push(...wire(alpha(P.aquadag, 0.5), r, 0.9));
  for (let i = 0; i < NM; i += 2) out.push(...wire(alpha(P.aquadag, 0.35), rings.map((r) => r[i]), 0.7));
  // gun: cathode and heater, grid, anode
  out.push({ ...rod(P.heater, [W.GUN_X0 - 4, 0, 0], [W.GUN_X0, 0, 0], 1.6), emissive: lit(P.heater, 0.7) }, rod(P.metal, [W.GUN_X0, 0, 0], [W.GUN_X0 + 10, 0, 0], 3.2, 0.4));
  out.push(rod(P.metal, [W.GUN_X0 + 12, 0, 0], [W.GUN_X0 + 14, 0, 0], 6, 0.4), rod(P.metal, [W.GUN_X0 + 30, 0, 0], [W.GUN_EXIT, 0, 0], 7.5, 0.4));
  // plates: Y pair above and below the axis, X pair to the sides, each tinted by its voltage (warm +, cool -)
  const tint = (v: number): RGB => (v >= 0 ? lit([1, 0.45, 0.15], 0.6 * Math.min(1, v)) : lit([0.2, 0.5, 1], 0.6 * Math.min(1, -v)));
  const [y0, y1] = W.Y_PLATES, [x0, x1] = W.X_PLATES, g = W.PLATE_GAP;
  out.push({ ...box(P.metal, y0, y1, g, g + 1, -9, 9, 0.4), emissive: tint(vy) }, { ...box(P.metal, y0, y1, -g - 1, -g, -9, 9, 0.4), emissive: tint(-vy) });
  out.push({ ...box(P.metal, x0, x1, -9, 9, g, g + 1, 0.4), emissive: tint(vx) }, { ...box(P.metal, x0, x1, -9, 9, -g - 1, -g, 0.4), emissive: tint(-vx) });
  // faceplate: a disc of glass, the phosphor on its inner side, the bezel ring
  const fx = W.FACE_X;
  out.push(rod(alpha(P.glass, 0.18), [fx, 0, 0], [fx + W.GLASS, 0, 0], W.FACE_R + 6));
  out.push(rod(alpha(P.mask, 0.1), [fx - 0.4, 0, 0], [fx, 0, 0], W.FACE_R));
  const rim: Vec3[] = Array.from({ length: 49 }, (_, i): Vec3 => { const a = (i / 48) * 2 * Math.PI; return [fx + W.GLASS / 2, (W.FACE_R + 8) * Math.cos(a), (W.FACE_R + 8) * Math.sin(a)]; });
  out.push(...wire(P.bezel, rim, 3.5), ...wire(P.metal, rim.map((p): Vec3 => [p[0] + 3, p[1] * 1.0, p[2] * 1.0]), 1.2, 0.5));
  return out;
}

/** The pick-up plate: a mesh of fine wires in front of the glass, over the raster and a margin. */
export function meshParts(P: CrtPalette, signal: number): Part[] {
  const out: Part[] = [], x = W.FACE_X + W.GLASS + W.MESH_GAP, h = W.RASTER / 2 + W.MESH_MARGIN, n = Math.round((2 * h) / W.MESH_PITCH);
  const em: RGB = lit([1, 0.8, 0.3], 0.5 * Math.min(1, Math.abs(signal)));
  for (let i = 0; i <= n; i++) {
    const t = -h + (2 * h * i) / n;
    out.push({ ...rod(P.copper, [x, t, -h], [x, t, h], 0.35, 0.4), emissive: em }, { ...rod(P.copper, [x, -h, t], [x, h, t], 0.35, 0.4), emissive: em });
  }
  return out;
}

/** The amplifier box beside the tube and the lead to it from the mesh's corner. */
export const AMP = { at: [W.FACE_X + W.GLASS + 40, -(W.RASTER / 2 + W.MESH_MARGIN) - 70, W.RASTER / 2 + W.MESH_MARGIN + 30] as Vec3, size: [40, 26, 56] as Vec3 };
export function leadParts(P: CrtPalette, signal: number): Part[] {
  const x = W.FACE_X + W.GLASS + W.MESH_GAP, h = W.RASTER / 2 + W.MESH_MARGIN, c: Vec3 = [x, -h, h], a = AMP.at;
  const pts: Vec3[] = [c, [x + 12, -h - 14, h + 8], [x + 30, -h - 40, h + 20], add3(a, [0, AMP.size[1] / 2, 0])];
  const em: RGB = lit([1, 0.8, 0.3], 0.6 * Math.min(1, Math.abs(signal)));
  return [
    ...wire(P.copper, pts, 0.9, 0.3),
    { ...box(P.metal, a[0] - AMP.size[0] / 2, a[0] + AMP.size[0] / 2, a[1] - AMP.size[1] / 2, a[1] + AMP.size[1] / 2, a[2] - AMP.size[2] / 2, a[2] + AMP.size[2] / 2, 0.3), emissive: em },
  ];
}

/** The spots (a dot or a dash each, bright as they glow) and the beam for one pose. */
export function poseParts(P: CrtPalette, pose: WilliamsPose): Part[] {
  const out: Part[] = [];
  for (let line = 0; line < LINES; line++) for (let digit = 0; digit < DIGITS; digit++) {
    const i = cellOf(line, digit), b = pose.bit(i), g = pose.glow(i), [y, z] = spotYZ(line, digit);
    const len = b === 1 ? W.DASH : W.DOT, k = b < 0 ? 0.25 : 1;
    const base = P.cellOff, col: RGB = [base[0] + (PHOSPHOR[0] - base[0]) * g * k, base[1] + (PHOSPHOR[1] - base[1]) * g * k, base[2] + (PHOSPHOR[2] - base[2]) * g * k];
    const part = box(col, W.FACE_X - 0.8, W.FACE_X + 0.1, y - W.DOT / 2, y + W.DOT / 2, z - len / 2, z + len / 2);
    out.push(g > 0.01 ? { ...part, emissive: lit(PHOSPHOR, 0.7 * g * k) } : part);
  }
  if (pose.beam) for (const p of wire([PHOSPHOR[0], PHOSPHOR[1], PHOSPHOR[2], 0.9], beamPath(spotCentre(pose.beam.line, pose.beam.digit)), 0.7)) out.push({ ...p, emissive: lit(PHOSPHOR, 0.8) });
  out.push(...meshParts(P, pose.plate), ...leadParts(P, pose.plate));
  return out;
}

export type WilliamsDetail = 'overview' | 'face' | 'plates';

/** Labels for what the camera is on. */
export function williamsAnchors(detail: WilliamsDetail = 'overview', narrow = false): Anchor[] {
  const fx = W.FACE_X, mx = fx + W.GLASS + W.MESH_GAP, h = W.RASTER / 2;
  const up: Vec3 = [0, 1, 0], front: Vec3 = [1, 0, 0], right: Vec3 = [0, 0, 1];
  const all: Anchor[] = detail === 'face' ? [
    { text: 'digit 0 (left)', p: [fx + 1, h + 2, spotYZ(0, 0)[1]], side: 't', n: front },
    { text: 'digit 31', p: [fx + 1, h + 2, spotYZ(0, DIGITS - 1)[1]], side: 't', n: front },
    { text: 'a dash: 1', p: [fx + 1, spotYZ(0, 0)[0], spotYZ(0, 0)[1]], side: 'l', n: front, minor: true },
    { text: 'a dot: 0', p: [fx + 1, spotYZ(1, 1)[0], spotYZ(1, 1)[1]], side: 'r', n: front, minor: true },
    { text: 'pick-up plate (wire mesh)', p: [mx, -h - W.MESH_MARGIN, 0], side: 'b', n: front },
  ] : [
    { text: 'electron gun', p: [W.GUN_X0 + 20, 7, 0], side: 't', n: up },
    { text: 'Y plates', p: [(W.Y_PLATES[0] + W.Y_PLATES[1]) / 2, W.PLATE_GAP + 1, 0], side: 't', n: up },
    { text: 'X plates', p: [(W.X_PLATES[0] + W.X_PLATES[1]) / 2, 0, -W.PLATE_GAP - 1], side: 'l', n: right },
    { text: 'screen: 32 × 32 spots', p: [fx + W.GLASS, -h - 12, -h + 10], side: 'b', n: front },
    { text: 'pick-up plate', p: [mx, h + W.MESH_MARGIN, 0], side: 't', n: front },
    { text: 'amplifier', p: [AMP.at[0], AMP.at[1] - AMP.size[1] / 2, AMP.at[2]], side: 'b', n: up },
    { text: 'CV1131: 12 or 6 inch? sources differ', p: [fx + W.GLASS / 2, W.FACE_R + 8, 0], side: 't', n: up, minor: true },
  ];
  return narrow ? all.filter((a) => !a.minor).slice(0, 3) : all;
}
