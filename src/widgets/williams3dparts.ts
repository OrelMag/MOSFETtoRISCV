// The Williams-Kilburn store tube's constants and the beam's path (DOM-free, tested); williams3dkit.ts draws it. A
// cathode-ray tube used as a memory: a gun, electrostatic deflection plates (no yoke), a face with a 32 x 32 raster of spots
// (a dot = 0, a dash = 1; digit 0 on the left, as the Baby's display tube showed it), the pick-up plate in front.
// Axes: x along the tube from the gun to the screen, y up, z across the screen (pixel x grows towards -z, so the raster reads
// left to right seen from the front).
// Sources: the tube was the commercial CV1131, a 12-inch (300 mm) electrostatically deflected CRT (S. H. Lavington, Computer
// History Museum timeline, ch. 7, "type CV1131 12-inch diameter"); the University's Computer50 pages give the Baby's store "a
// standard single 6-inch-diameter CRT", so the size is one side of a conflict and the model says so. The pick-up plate was at
// first a wire mesh and later a metal plate, close to the outer face (University of Manchester, Digital60, "History of the
// Williams-Kilburn Tube"). ESTIMATED, no source found: the neck diameter, the plate and gun dimensions, the tube's length, the
// 6 mm spot pitch and the mesh pitch.

import { scale3, type Vec3 } from '../gl/math';

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

