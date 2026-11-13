// The 3D models' parts: the kit's geometry, and each model's drawing held to the model behind it.
import { describe, expect, it } from 'vitest';
import type { RGB, RGBA } from '../src/gl/instances';
import { quatRotate, type Vec3 } from '../src/gl/math';
import { box, cyl, flatFaces, rod } from '../src/gl/parts';

const GREY: RGB = [0.5, 0.5, 0.5], CLEAR: RGBA = [0.5, 0.5, 0.5, 0.4];

describe('the kit', () => {
  it('a rod runs between its ends, whichever way it points', () => {
    const ends: [Vec3, Vec3][] = [[[0, 0, 0], [3, 4, 0]], [[1, 2, 3], [1, 7, 3]], [[1, 7, 3], [1, 2, 3]], [[0, 0, 0], [0, 0, -5]], [[-1, -1, -1], [2, 3, 5]]];
    for (const [a, b] of ends) {
      const p = rod(GREY, a, b, 0.5), half = quatRotate(p.rot!, [0, p.scale![1] / 2, 0]);
      for (let k = 0; k < 3; k++) {
        expect(p.pos[k] + half[k]).toBeCloseTo(b[k], 6);
        expect(p.pos[k] - half[k]).toBeCloseTo(a[k], 6);
      }
    }
  });

  it('the flat view shows three faces of a box, nearest last, and half a cylinder', () => {
    expect(flatFaces([box(GREY, 0, 1, 0, 1, 0, 1)], -0.5, 0.5)).toHaveLength(3);
    const near = box(GREY, 0, 1, 0, 1, 10, 11), far = box(GREY, 0, 1, 0, 1, -11, -10), faces = flatFaces([near, far], 0, 0.5);
    expect(faces[0].depth).toBeLessThan(faces[faces.length - 1].depth);
    const n = flatFaces([cyl(GREY, 0, 0, 0, 1, 1)], 0.3, 0.5).length;
    expect(n).toBeGreaterThanOrEqual(6);
    expect(n).toBeLessThanOrEqual(8);
  });

  it('keeps a part’s alpha in the flat view', () => {
    expect(flatFaces([box(CLEAR, 0, 1, 0, 1, 0, 1)], 0.2, 0.5)[0].color[3]).toBeCloseTo(0.4);
  });
});
