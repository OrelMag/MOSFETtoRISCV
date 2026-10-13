import { describe, expect, it } from 'vitest';
import { Camera, FOLD_BESIDE_PX, fitBox, MIN_FIT_PX, startFolded, usableWidth, type ViewBox } from '../src/view/camera';

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

/** Where `bbox` lands on a `width` × `height` px host showing `vb` (uniform scale: vb has the host's aspect). */
function onScreen(vb: ViewBox, bbox: ViewBox, width: number, height: number) {
  const s = width / vb.w;
  expect(height / vb.h).toBeCloseTo(s);
  return { left: (bbox.x - vb.x) * s, right: (bbox.x + bbox.w - vb.x) * s, top: (bbox.y - vb.y) * s, bottom: (bbox.y + bbox.h - vb.y) * s };
}

describe('fitting beside an overlay panel', () => {
  // A CPU's top level (wide) and a tall block, on chapter canvases between the side panes.
  const boxes: ViewBox[] = [{ x: -12, y: -5, w: 546, h: 270 }, { x: 0, y: 0, w: 60, h: 140 }, { x: 3, y: 4, w: 10, h: 8 }];
  const hosts: [number, number, number][] = [[540, 530, 354], [700, 680, 354], [1180, 700, 354], [540, 530, 0], [800, 600, 410]];

  it('keeps the drawing whole and clear of the panel, centred in what is left', () => {
    for (const b of boxes) for (const [w, h, inset] of hosts) {
      const p = onScreen(fitBox(b, w, h, inset), b, w, h);
      const usable = w - inset;
      expect(p.left).toBeGreaterThanOrEqual(-1e-6);
      expect(p.top).toBeGreaterThanOrEqual(-1e-6);
      expect(p.bottom).toBeLessThanOrEqual(h + 1e-6);
      expect(p.right).toBeLessThanOrEqual(usable + 1e-6);
      expect(p.left).toBeCloseTo(usable - p.right);
      // as large as fits: it touches both sides or both ends (unless it is narrower than minW)
      const fillsW = Math.abs(p.right - p.left - usable) < 1e-6, fillsH = Math.abs(p.bottom - p.top - h) < 1e-6;
      if (b.w >= 34) expect(fillsW || fillsH).toBe(true);
    }
  });

  it('fits to the whole width when the panel leaves too little to draw in (a phone)', () => {
    expect(usableWidth(390, 354)).toBe(390);
    expect(usableWidth(540, 354)).toBe(186);
    expect(usableWidth(540, 0)).toBe(540);
    expect(usableWidth(354 + MIN_FIT_PX, 354)).toBe(MIN_FIT_PX);
    const b = boxes[0];
    expect(fitBox(b, 390, 330, 354)).toEqual(fitBox(b, 390, 330, 0));
  });

  it('starts a foldable panel folded when it would leave the circuit less than FOLD_BESIDE_PX', () => {
    // 1280 px between the side panes: a 540 px canvas; 1440: 700 px; a phone: 390 px.
    expect(startFolded(540, 330)).toBe(true);
    expect(startFolded(390, 330)).toBe(true);
    expect(startFolded(700, 330)).toBe(false);
    expect(startFolded(330 + 24 + FOLD_BESIDE_PX, 330)).toBe(false);
  });

  it('Camera.fit uses the same box and counts as fitted', () => {
    const { cam } = rig(540, 530);
    cam.fit(boxes[0], 354);
    expect(cam.vb).toEqual(fitBox(boxes[0], 540, 530, 354));
    expect(cam.fitted).toBe(true);
  });
});
