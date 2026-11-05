// Lettering as geometry (DOM-free): the renderer has no textures, and engraved letters must turn with the part they are
// on. A glyph is polylines on a grid 4 wide, 6 high, drawn as thin boxes; a real part's letters survive the flat fallback.

import type { RGB } from '../gl/instances';
import { cross3, norm3, type Quat, type Vec3 } from '../gl/math';
import type { Part } from '../gl/parts';

type Line = number[]; // x, y, x, y …

const O: Line = [1, 0, 0, 1, 0, 5, 1, 6, 3, 6, 4, 5, 4, 1, 3, 0, 1, 0];
const P: Line = [0, 0, 0, 6, 3, 6, 4, 5, 4, 4, 3, 3, 0, 3];

export const GLYPHS: Record<string, Line[]> = {
  A: [[0, 0, 2, 6, 4, 0], [0.8, 2.2, 3.2, 2.2]],
  B: [[0, 0, 0, 6, 2.8, 6, 3.8, 5, 3.8, 4, 2.8, 3, 0, 3], [2.8, 3, 4, 2, 4, 1, 3, 0, 0, 0]],
  C: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1]],
  D: [[0, 0, 0, 6, 2.5, 6, 4, 4.5, 4, 1.5, 2.5, 0, 0, 0]],
  E: [[4, 6, 0, 6, 0, 0, 4, 0], [0, 3, 3, 3]],
  F: [[4, 6, 0, 6, 0, 0], [0, 3, 3, 3]],
  G: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 1, 1, 0, 3, 0, 4, 1, 4, 3, 2.2, 3]],
  H: [[0, 0, 0, 6], [4, 0, 4, 6], [0, 3, 4, 3]],
  I: [[2, 0, 2, 6]],
  J: [[3.5, 6, 3.5, 1, 2.5, 0, 1, 0, 0, 1]],
  K: [[0, 0, 0, 6], [4, 6, 0, 2.5], [1.3, 3.6, 4, 0]],
  L: [[0, 6, 0, 0, 4, 0]],
  M: [[0, 0, 0, 6, 2, 2.5, 4, 6, 4, 0]],
  N: [[0, 0, 0, 6, 4, 0, 4, 6]],
  O: [O],
  P: [P],
  Q: [O, [2.5, 1.5, 4.2, -0.3]],
  R: [P, [2, 3, 4, 0]],
  S: [[4, 5, 3, 6, 1, 6, 0, 5, 0, 4, 1, 3, 3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  T: [[0, 6, 4, 6], [2, 6, 2, 0]],
  U: [[0, 6, 0, 1, 1, 0, 3, 0, 4, 1, 4, 6]],
  V: [[0, 6, 2, 0, 4, 6]],
  W: [[0, 6, 1, 0, 2, 4, 3, 0, 4, 6]],
  X: [[0, 0, 4, 6], [0, 6, 4, 0]],
  Y: [[0, 6, 2, 3, 4, 6], [2, 3, 2, 0]],
  Z: [[0, 6, 4, 6, 0, 0, 4, 0]],
  0: [O],
  1: [[1, 4.8, 2.4, 6, 2.4, 0]],
  2: [[0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 0, 0, 4, 0]],
  3: [[0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1.6, 3], [3, 3, 4, 2, 4, 1, 3, 0, 1, 0, 0, 1]],
  4: [[3, 0, 3, 6, 0, 2, 4, 2]],
  5: [[4, 6, 0.5, 6, 0, 3.4, 3, 3.6, 4, 2.6, 4, 1, 3, 0, 1, 0, 0, 1]],
  6: [[3.6, 6, 1.5, 6, 0, 4, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2.4, 3, 3.4, 1, 3.4, 0, 2.4]],
  7: [[0, 6, 4, 6, 1.5, 0]],
  8: [[1, 3, 0, 4, 0, 5, 1, 6, 3, 6, 4, 5, 4, 4, 3, 3, 1, 3, 0, 2, 0, 1, 1, 0, 3, 0, 4, 1, 4, 2, 3, 3]],
  9: [[0.4, 0, 2.5, 0, 4, 2, 4, 5, 3, 6, 1, 6, 0, 5, 0, 3.6, 1, 2.6, 3, 2.6, 4, 3.6]],
  '/': [[0.5, 0, 3.5, 6]],
  '.': [[1.7, 0, 2.3, 0]],
  '-': [[0.8, 3, 3.2, 3]],
  β: [[0, -1.5, 0, 5, 1, 6, 3, 6, 3.8, 5, 3.8, 4.2, 2.8, 3.2, 1.4, 3.2], [2.8, 3.2, 4, 2.2, 4, 1, 3, 0, 1, 0, 0, 1]],
  γ: [[0, 4.5, 1, 4.5, 2, 0, 2, -1.5], [2, 0, 3.6, 4.5]],
};

/** A rotation taking the box's x, y, z axes to the given right-handed orthonormal directions. */
export function quatFromAxes(x: Vec3, y: Vec3, z: Vec3): Quat {
  const m00 = x[0], m10 = x[1], m20 = x[2], m01 = y[0], m11 = y[1], m21 = y[2], m02 = z[0], m12 = z[1], m22 = z[2], t = m00 + m11 + m22;
  let q: Quat;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4]; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s]; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s]; }
  return q;
}

export interface TextOptions {
  /** Height of a capital, in world units. */
  size: number;
  color: RGB;
  emissive?: RGB;
  /** Stroke width; default a sixth of the height. */
  weight?: number;
  /** 'c': centred on `at`; 'l': `at` is the left end. */
  align?: 'c' | 'l';
}

export const textWidth = (text: string, size: number): number => (text.length * 5.4 - 1.4) * (size / 6);

/** Letters as parts on a plane through `at`: `right` and `up` lie in it, the strokes stand slightly proud of it. */
export function strokeText(out: Part[], text: string, at: Vec3, right: Vec3, up: Vec3, o: TextOptions): void {
  const k = o.size / 6, w = o.weight ?? o.size / 6, r = norm3(right), u = norm3(up), n = cross3(r, u);
  const x0 = o.align === 'l' ? 0 : -textWidth(text, o.size) / 2, y0 = -o.size / 2;
  const pt = (x: number, y: number): Vec3 => [at[0] + r[0] * x + u[0] * y, at[1] + r[1] * x + u[1] * y, at[2] + r[2] * x + u[2] * y];
  [...text].forEach((ch, i) => {
    const g = GLYPHS[ch];
    if (!g) return;
    const cx = x0 + i * 5.4 * k;
    for (const line of g) for (let j = 0; j + 3 < line.length; j += 2) {
      const ax = cx + line[j] * k, ay = y0 + line[j + 1] * k, bx = cx + line[j + 2] * k, by = y0 + line[j + 3] * k;
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1e-3, c = dx / len, s = dy / len;
      const along: Vec3 = [r[0] * c + u[0] * s, r[1] * c + u[1] * s, r[2] * c + u[2] * s], across = cross3(n, along);
      const m = pt((ax + bx) / 2, (ay + by) / 2);
      out.push({
        kind: 'box', pos: [m[0] + n[0] * 0.03, m[1] + n[1] * 0.03, m[2] + n[2] * 0.03], scale: [len + w, w, 0.08],
        rot: quatFromAxes(along, across, n), color: o.color, emissive: o.emissive,
      });
    }
  });
}
