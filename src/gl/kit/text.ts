// Lettering on a surface as geometry: the stroke font's glyphs (widgets/strokefont.ts, the one the Enigma's rings
// already use) swept as round strokes and laid onto any surface through a mapping (x along the text, y up it, both in
// world units → a point and its outward normal). Letters are real geometry, so they turn, catch the light and cut with
// the part they are printed on, and survive the flat fallback; no textures, no font file.

import { GLYPHS, textWidth } from '../../widgets/strokefont';
import { add3, scale3, type Vec3 } from '../math';
import { merge, tube, type Geo } from './geo';

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

/** `text` of capital height `size`, centred at (cx, cy) of the surface, strokes of width `weight` standing `lift` proud
 *  of it. One merged geometry (one draw). Characters the font lacks are skipped. */
export function strokeGeo(text: string, s: Surface, cx: number, cy: number, size: number, weight = size / 7, lift = weight / 2): Geo {
  const k = size / 6, x0 = cx - textWidth(text, size) / 2, y0 = cy - size / 2, parts: Geo[] = [];
  [...text].forEach((ch, i) => {
    for (const line of GLYPHS[ch] ?? []) {
      // each segment subdivided so a stroke follows a curved surface
      const pts: Vec3[] = [];
      for (let j = 0; j + 1 < line.length; j += 2) {
        const x = x0 + i * 5.4 * k + line[j] * k, y = y0 + line[j + 1] * k;
        if (j > 0) {
          const px = x0 + i * 5.4 * k + line[j - 2] * k, py = y0 + line[j - 1] * k;
          for (let q = 1; q < 4; q++) { const f = q / 4, a = s.at(px + (x - px) * f, py + (y - py) * f); pts.push(add3(a.p, scale3(a.n, lift))); }
        }
        const a = s.at(x, y);
        pts.push(add3(a.p, scale3(a.n, lift)));
      }
      if (pts.length > 1) parts.push(tube(pts, weight / 2, { sides: 4 }));
    }
  });
  return merge(parts, `text:${text}`);
}
