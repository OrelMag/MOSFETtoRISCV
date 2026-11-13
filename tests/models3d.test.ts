// The 3D models' parts: the kit's geometry, and each model's drawing held to the model behind it.
import { describe, expect, it } from 'vitest';
import type { RGB } from '../src/gl/instances';
import { quatRotate, type Vec3 } from '../src/gl/math';
import { flatView, rod } from '../src/gl/parts';
import { OrbitCamera } from '../src/gl/camera';

const GREY: RGB = [0.5, 0.5, 0.5];

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

  it('the flat view looks from where the camera’s eye is, with the same right hand', () => {
    for (const yaw of [0, 0.7, Math.PI / 2, -2.1]) for (const pitch of [0, 0.4]) {
      const cam = new OrbitCamera({ target: [0, 0, 0], yaw, pitch, dist: 10 }), eye = cam.eye(), pr = flatView(yaw, pitch);
      // the eye's own direction is the nearest a point can be; a point to the camera's right has X > 0
      expect(pr(eye)[2]).toBeCloseTo(10, 6);
      const right: Vec3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
      expect(pr(right)[0]).toBeCloseTo(1, 6);
      expect(pr([0, 1, 0])[1]).toBeCloseTo(Math.cos(pitch), 6);
    }
  });

});
