import { describe, expect, it } from 'vitest';
import { boxesSvg, disjoint, paintOrder, projector, type Box3 } from '../src/widgets/cell3d';

const B = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, cls = 'b'): Box3 => ({ x0, x1, y0, y1, z0, z1, cls });

describe('3D cell view', () => {
  it('looking straight down with no yaw is the 2D layout', () => {
    const p = projector({ yaw: 0, pitch: 90 });
    const [x, y] = p.at(3, 7, 5);
    expect(x).toBeCloseTo(3);
    expect(y).toBeCloseTo(7);
  });

  it('draws a box above another after it, whatever the order given', () => {
    const lo = B(0, 4, 0, 4, 0, 1), hi = B(1, 3, 1, 3, 2, 3);
    for (const yaw of [-150, -30, 0, 60, 170]) {
      expect(paintOrder([hi, lo], { yaw, pitch: 40 })).toEqual([1, 0]);
      expect(paintOrder([lo, hi], { yaw, pitch: 40 })).toEqual([0, 1]);
    }
  });

  it('draws the nearer of two side-by-side boxes last, from either side', () => {
    const left = B(0, 2, 0, 2, 0, 3), right = B(2, 4, 0, 2, 0, 3);
    // Yaw 60: the eye is on the +x side, so the right-hand box is in front; yaw -60: the left one.
    expect(paintOrder([left, right], { yaw: 60, pitch: 30 })).toEqual([0, 1]);
    expect(paintOrder([left, right], { yaw: -60, pitch: 30 })).toEqual([1, 0]);
  });

  it('every box gets its top and two side faces', () => {
    const s = boxesSvg([B(0, 1, 0, 1, 0, 1, 'L-metal v1'), B(2, 3, 0, 1, 0, 1)], { yaw: -30, pitch: 45 });
    expect(s.match(/<polygon/g)).toHaveLength(6);
    expect(s).toContain('class="L-metal v1"');
  });

  it('turns overlapping rectangles into disjoint ones covering the same area', () => {
    // A rail with two straps leaving it (the NAND2 VDD shape) and an L.
    for (const rs of [[[0, 0, 24, 4], [3, 0, 3, 14], [18, 0, 3, 14]], [[10.5, 10, 3, 15], [10.5, 22, 10, 3], [17.5, 22, 3, 12]]] as [number, number, number, number][][]) {
      const d = disjoint(rs);
      const inside = (q: [number, number, number, number][], x: number, y: number) => q.some(([a, b, w, h]) => a < x && x < a + w && b < y && y < b + h);
      for (let x = 0.25; x < 25; x += 0.5) for (let y = 0.25; y < 40; y += 0.5) {
        expect(inside(d, x, y)).toBe(inside(rs, x, y));
        expect(d.filter((r) => inside([r], x, y)).length).toBeLessThanOrEqual(1);
      }
    }
    expect(disjoint([[0, 0, 24, 4], [3, 0, 3, 14]])).toHaveLength(2);
  });
});
