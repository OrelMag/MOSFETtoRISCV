import { describe, expect, it } from 'vitest';
import { Camera } from '../src/view/camera';

/** A host of a settable size and an svg that only records its view box: enough for Camera. */
function rig(w: number, h: number) {
  const size = { w, h };
  const host = { getBoundingClientRect: () => ({ width: size.w, height: size.h }) } as unknown as Element;
  const svg = { setAttribute: () => {} } as unknown as SVGSVGElement;
  return { cam: new Camera(svg, host), size };
}

describe('Camera on a resized host', () => {
  it('asks for a refit while the view is the fitted one', () => {
    const { cam, size } = rig(800, 600);
    cam.fit({ x: 0, y: 0, w: 80, h: 60 });
    size.h = 560;
    expect(cam.resized()).toBe(false);
  });

  it('keeps the zoom and the top-left corner once the learner has zoomed', () => {
    const { cam, size } = rig(800, 600);
    cam.fit({ x: 0, y: 0, w: 80, h: 60 });
    cam.zoom(0.5, 20, 15);
    const before = { ...cam.vb };
    // The bottom bar rewraps during a run: the canvas loses a row.
    size.h = 570;
    expect(cam.resized()).toBe(true);
    expect(cam.vb.x).toBe(before.x);
    expect(cam.vb.y).toBe(before.y);
    expect(cam.vb.w).toBeCloseTo(before.w);
    expect(cam.vb.h / 570).toBeCloseTo(before.h / 600);
    // Back to the old size: the same view as before.
    size.h = 600;
    cam.resized();
    expect(cam.vb.h).toBeCloseTo(before.h);
  });

  it('fit() makes the view follow the host again', () => {
    const { cam, size } = rig(800, 600);
    cam.zoom(0.5);
    cam.fit({ x: 0, y: 0, w: 80, h: 60 });
    size.w = 900;
    expect(cam.resized()).toBe(false);
  });
});
