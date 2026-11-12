// Lettering on a surface as geometry: the stroke font's glyphs (widgets/strokefont.ts, the one the Enigma's rings
// already use) laid onto any surface through a mapping (x along the text, y up it, both in world units → a point and
// its outward normal). Two looks: round strokes standing proud (engraved or raised lettering: a dial, a cast plate)
// or flat ink in the surface (a print on glass, a label: `flat`). Letters are real geometry, so they turn, catch the
// light and cut with the part they are printed on, and survive the flat fallback; no textures, no font file.

import { GLYPHS, textWidth } from '../../widgets/strokefont';
import { add3, scale3, type Vec3 } from '../math';
import { merge, ribbon, tube, type Geo } from './geo';

export interface Surface {
  /** The point at text coordinates (x along, y up), and the outward normal there. */
  at(x: number, y: number): { p: Vec3; n: Vec3 };
}

/** A cylinder about y of radius r: x runs round it (left to right seen from outside) from angle a0, y is height. */
export const onCylinder = (r: number, a0: number): Surface => ({
  at(x, y) { const a = a0 + x / r, n: Vec3 = [Math.sin(a), 0, Math.cos(a)]; return { p: [n[0] * r, y, n[2] * r], n }; },
});

/** A plane through `o` with right and up axes (unit) and normal n. */
export const onPlane = (o: Vec3, right: Vec3, up: Vec3, n: Vec3): Surface => ({
  at(x, y) { return { p: add3(o, add3(scale3(right, x), scale3(up, y))), n }; },
});

export interface StrokeOptions {
  /** Flat ink lying in the surface (mitred ribbons with the surface's normals) instead of round strokes. */
  flat?: boolean;
}

/** The glyphs' polylines in text coordinates, each segment subdivided so a stroke follows a curved surface. */
function strokes(text: string, cx: number, cy: number, size: number): [number, number][][] {
  const k = size / 6, x0 = cx - textWidth(text, size) / 2, y0 = cy - size / 2, out: [number, number][][] = [];
  [...text].forEach((ch, i) => {
    for (const line of GLYPHS[ch] ?? []) {
      const pts: [number, number][] = [];
      for (let j = 0; j + 1 < line.length; j += 2) {
        const x = x0 + i * 5.4 * k + line[j] * k, y = y0 + line[j + 1] * k;
        if (j > 0) {
          const [px, py] = pts[pts.length - 1];
          for (let q = 1; q < 4; q++) pts.push([px + ((x - px) * q) / 4, py + ((y - py) * q) / 4]);
        }
        pts.push([x, y]);
      }
      if (pts.length > 1) out.push(pts);
    }
  });
  return out;
}

/** A polyline in text coordinates as a flat mitred strip of width w, mapped onto the surface `lift` proud of it. */
function flatStroke(pts: readonly [number, number][], w: number, s: Surface, lift: number): Geo {
  const L: Vec3[] = [], R: Vec3[] = [], N: Vec3[] = [], n = pts.length;
  const dir = (a: [number, number], b: [number, number]): [number, number] => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
  for (let i = 0; i < n; i++) {
    const d0 = dir(pts[Math.max(0, i - 1)], pts[Math.max(1, i)]), d1 = dir(pts[Math.min(n - 2, i)], pts[Math.min(n - 1, i + 1)]);
    let tx = d0[0] + d1[0], ty = d0[1] + d1[1];
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    // the miter: the perpendicular of the mean direction, lengthened by 1 / cos of the half angle (capped at a spike)
    const c = Math.max(0.35, tx * d1[0] + ty * d1[1]), half = w / 2 / c;
    // square ends: the first and last points pushed out by half the width along the stroke
    const ext = i === 0 ? -w / 2 : i === n - 1 ? w / 2 : 0;
    const [x, y] = [pts[i][0] + tx * ext, pts[i][1] + ty * ext];
    const a = s.at(x - ty * half, y + tx * half), b = s.at(x + ty * half, y - tx * half), m = s.at(x, y);
    L.push(add3(a.p, scale3(a.n, lift))); R.push(add3(b.p, scale3(b.n, lift))); N.push(m.n);
  }
  return ribbon(L, R, N, 'ink');
}

/** `text` of capital height `size`, centred at (cx, cy) of the surface, strokes of width `weight` standing `lift` proud
 *  of it. One merged geometry (one draw). Characters the font lacks are skipped. */
export function strokeGeo(text: string, s: Surface, cx: number, cy: number, size: number, weight = size / 7, lift = weight / 2, o: StrokeOptions = {}): Geo {
  const parts = strokes(text, cx, cy, size).map((pts) => (o.flat
    ? flatStroke(pts, weight, s, lift)
    : tube(pts.map(([x, y]) => { const a = s.at(x, y); return add3(a.p, scale3(a.n, lift)); }), weight / 2, { sides: 4 })));
  return merge(parts, `text:${text}`);
}
