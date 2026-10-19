import { describe, expect, it } from 'vitest';
import { Camera, COVER_GAP, FOLD_BESIDE_PX, fitBox, freeArea, freeRect, MIN_FIT_H, MIN_FIT_PX, type Rect, roomBeside, startFolded, TOUCH_PX, touchZoom, underCover, type ViewBox } from '../src/view/camera';

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
    const strip = (w: number, inset: number) => freeRect(w, 330, [{ x: w - inset, y: 0, w: inset, h: 330 }], 546, 270, 0).w;
    expect(strip(390, 354)).toBe(390);
    expect(strip(540, 354)).toBe(186);
    expect(strip(354 + MIN_FIT_PX, 354)).toBe(MIN_FIT_PX);
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

describe('fitting around the stage panels', () => {
  // The single-cycle CPU's top level: wide and short. A 1440 px window between the side panes: a 700 × 640 canvas.
  const cpu: ViewBox = { x: -12, y: -5, w: 546, h: 180 };
  const W = 700, H = 640;
  /** The CPU panel (right-docked, 330 px wide, 12 px from the top and the right edge), `h` px tall. */
  const panel = (h: number): Rect => ({ x: W - 342, y: 12, w: 330, h });
  /** The pipeline diagram docked bottom-left. */
  const diagram: Rect = { x: 12, y: H - 182, w: 334, h: 170 };

  function clear(vb: ViewBox, b: ViewBox, cover: Rect[]) {
    const p = onScreen(vb, b, W, H);
    expect(p.left).toBeGreaterThanOrEqual(-1e-6);
    expect(p.top).toBeGreaterThanOrEqual(-1e-6);
    expect(p.right).toBeLessThanOrEqual(W + 1e-6);
    expect(p.bottom).toBeLessThanOrEqual(H + 1e-6);
    for (const c of cover) {
      const apart = p.right <= c.x - COVER_GAP + 1e-6 || p.left >= c.x + c.w + COVER_GAP - 1e-6
        || p.bottom <= c.y - COVER_GAP + 1e-6 || p.top >= c.y + c.h + COVER_GAP - 1e-6;
      expect(apart).toBe(true);
    }
    return p;
  }

  it('beside a full-height panel: the strip left of it, as with a right inset', () => {
    const cover = [panel(H - 24)];
    expect(fitBox(cpu, W, H, cover)).toEqual(fitBox(cpu, W, H, 342 + COVER_GAP));
    const p = clear(fitBox(cpu, W, H, cover), cpu, cover);
    expect(p.right - p.left).toBeCloseTo(W - 342 - COVER_GAP);
  });

  it('under a short panel: a wide circuit takes the full width below it, larger than beside it', () => {
    const cover = [panel(380)];
    const p = clear(fitBox(cpu, W, H, cover), cpu, cover);
    expect(p.top).toBeGreaterThanOrEqual(12 + 380 + COVER_GAP - 1e-6);
    expect(p.right - p.left).toBeGreaterThan(W - 342 - COVER_GAP);
    // A tall block still goes beside it: that shows it larger.
    const tall: ViewBox = { x: 0, y: 0, w: 60, h: 140 };
    const q = clear(fitBox(tall, W, H, cover), tall, cover);
    expect(q.right).toBeLessThanOrEqual(W - 342 - COVER_GAP + 1e-6);
    expect(q.bottom - q.top).toBeCloseTo(H);
  });

  it('clear of the bottom-left dock and a folded panel too', () => {
    for (const cover of [[panel(H - 24), diagram], [panel(38)], [panel(38), diagram], [panel(380), diagram]]) {
      for (const b of [cpu, { x: 0, y: 0, w: 60, h: 140 }, { x: 3, y: 4, w: 10, h: 8 }]) clear(fitBox(b, W, H, cover), b, cover);
    }
  });

  it('the free rectangle is the largest for the drawing, and the whole host when nothing useful is left', () => {
    expect(freeRect(W, H, [], 10, 10)).toEqual({ x: 0, y: 0, w: W, h: H });
    // a phone with the panel open: it covers nearly everything
    expect(freeRect(390, 500, [{ x: 12, y: 12, w: 366, h: 476 }], 546, 180)).toEqual({ x: 0, y: 0, w: 390, h: 500 });
    const r = freeRect(W, H, [panel(380)], 546, 180);
    expect(r).toEqual({ x: 0, y: 12 + 380 + COVER_GAP, w: W, h: H - 404 });
  });

  it('a panel growing over the fitted circuit asks for a refit; one that shrank or grew into empty space does not', () => {
    const vb = fitBox(cpu, W, H, [panel(380)]);
    expect(underCover(vb, cpu, W, H, [panel(380)])).toBe(false);
    expect(underCover(vb, cpu, W, H, [panel(300)])).toBe(false);
    expect(underCover(vb, cpu, W, H, [panel(H - 24)])).toBe(true);
    const beside = fitBox(cpu, W, H, [panel(H - 24)]);
    expect(underCover(beside, cpu, W, H, [panel(380)])).toBe(false);
  });
});

describe('the touch hint line on a phone', () => {
  // #/workbench/rca4: four full adders stacked (tall), the one-line hint pill 12 px from the left, right and bottom.
  const rca4: ViewBox = { x: -5, y: -6.9, w: 25, h: 56 };
  const pill = (W: number, H: number): Rect => ({ x: 12, y: H - 10 - 27, w: W - 24, h: 27 });

  it('a 390 × 844 phone: the circuit is fitted above the pill, clear of it', () => {
    const W = 390, H = 373; // the canvas between the stage bar and the controls
    expect(roomBeside(rca4, W, H, [pill(W, H)])).toBe(true);
    const p = onScreen(fitBox(rca4, W, H, [pill(W, H)]), rca4, W, H);
    expect(p.top).toBeGreaterThanOrEqual(-1e-6);
    expect(p.bottom).toBeLessThanOrEqual(pill(W, H).y - COVER_GAP + 1e-6);
  });

  it('a short canvas (a 320 × 568 phone): too little above the pill, so the fit would take the whole canvas under it', () => {
    const W = 320, H = 116;
    expect(pill(W, H).y - COVER_GAP).toBeLessThan(MIN_FIT_H);
    expect(freeArea(W, H, [pill(W, H)], rca4.w, rca4.h)).toBeNull();
    expect(freeRect(W, H, [pill(W, H)], rca4.w, rca4.h)).toEqual({ x: 0, y: 0, w: W, h: H });
    // the stage then hides the pill (Stage.placeHint)
    expect(roomBeside(rca4, W, H, [pill(W, H)])).toBe(false);
    expect(roomBeside(rca4, W, H, [])).toBe(true);
  });

  it('room is judged on the drawing widened to the minimum fit width, and an unsized host always has room', () => {
    const tiny: ViewBox = { x: 0, y: 0, w: 1, h: 1 };
    expect(roomBeside(tiny, 0, 0, [pill(390, 373)])).toBe(true);
    expect(roomBeside(tiny, 390, 373, [pill(390, 373)])).toBe(true);
    expect(freeArea(390, 373, [], 10, 10)).toEqual({ x: 0, y: 0, w: 390, h: 373 });
  });
});

describe('the sandbox on a touch screen', () => {
  const W = 390, H = 560;
  it('a small circuit fitted on a phone is zoomed in to TOUCH_PX around its centre, which stays put', () => {
    const bbox: ViewBox = { x: 0, y: 0, w: 36, h: 12 }; // 10.8 px per unit: a 4-unit NAND 43 px wide
    const vb = fitBox(bbox, W, H, 0, 24);
    const z = touchZoom(vb, W, [18, 6]);
    expect(W / z.w).toBeCloseTo(TOUCH_PX);
    expect(z.w / z.h).toBeCloseTo(vb.w / vb.h);
    // the centre is at the same screen point before and after
    const at = (v: ViewBox) => [(18 - v.x) * W / v.w, (6 - v.y) * W / v.w];
    expect(at(z)[0]).toBeCloseTo(at(vb)[0]);
    expect(at(z)[1]).toBeCloseTo(at(vb)[1]);
  });

  it('a circuit that already fits large enough, or a large one (Fit shows all of it), is left alone', () => {
    const small = fitBox({ x: 0, y: 0, w: 20, h: 10 }, W, H, 0, 24);
    expect(touchZoom(small, W, [10, 5])).toBe(small);
    const cpu = fitBox({ x: 0, y: 0, w: 120, h: 90 }, W, H, 0, 24);
    expect(touchZoom(cpu, W, [60, 45])).toBe(cpu);
  });
});
