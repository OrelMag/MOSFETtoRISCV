// The zoom lens on a touch screen (docs/transparent/DESIGN.md item 6, phase 2d): the setting works there and starts off,
// the phone's cap (16 px gutters, the whole free width), and a lens that only a zoom hands off.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { freeStage, growPlan, LENS_H, openPlan, PHONE_EDGE_PX, PHONE_LENS_W, RIM_PX, type Rect } from '../src/view/lensplan';
import { settings } from '../src/ui/settings';

const coarse = (on: boolean) => vi.stubGlobal('matchMedia', (q: string) => ({ matches: on && q.includes('coarse'), media: q, addEventListener() {}, removeEventListener() {} }));

describe('the setting on a touch screen', () => {
  afterEach(() => {
    settings.set('zoomOpen', null);
    vi.unstubAllGlobals();
  });
  it('starts off (null) on a coarse pointer, as with a mouse in this phase', () => {
    coarse(true);
    settings.set('zoomOpen', null);
    expect(settings.zoomOpen).toBe(false);
  });
  it('a stored on works on a coarse pointer, and off stays off', () => {
    coarse(true);
    settings.set('zoomOpen', true);
    expect(settings.zoomOpen).toBe(true);
    settings.set('zoomOpen', false);
    expect(settings.zoomOpen).toBe(false);
  });
});

describe("a phone's lens", () => {
  // 390 px phones: the canvas under the stage bar, the challenge note at its top
  const canvases = [{ w: 390, h: 317 }, { w: 360, h: 261 }];
  const note: Rect = { x: 48, y: 12, w: 330, h: 38 };
  for (const canvas of canvases) {
    it(`stays within 16 px gutters and below the note, at the whole free width (${canvas.w} px)`, () => {
      for (const ext of [{ w: 40, h: 30 }, { w: 30, h: 45 }, { w: 80, h: 20 }]) {
        const free = freeStage(canvas, [note], ext, undefined, PHONE_EDGE_PX);
        expect(free.x).toBeGreaterThanOrEqual(PHONE_EDGE_PX);
        expect(free.x + free.w).toBeLessThanOrEqual(canvas.w - PHONE_EDGE_PX);
        expect(free.y + free.h).toBeLessThanOrEqual(canvas.h - PHONE_EDGE_PX);
        expect(free.y).toBeGreaterThanOrEqual(note.y + note.h);
        const p = openPlan({ x: 120, y: 120, w: 120, h: 110 }, ext, 4, free, PHONE_LENS_W);
        expect(p).not.toBeNull();
        const r = p!.rect;
        expect(r.x).toBeGreaterThanOrEqual(free.x - 1e-6);
        expect(r.x + r.w).toBeLessThanOrEqual(free.x + free.w + 1e-6);
        expect(r.y).toBeGreaterThanOrEqual(free.y - 1e-6);
        expect(r.y + r.h).toBeLessThanOrEqual(free.y + free.h + 1e-6);
        expect(r.h).toBeLessThanOrEqual(free.h * LENS_H + 1e-6);
        // the cap is the whole width or 85 % of the height, whichever binds: wider than the desktop's 60 %
        expect(r.w > free.w * 0.6 + 1 || r.h >= free.h * LENS_H - 1).toBe(true);
      }
    });
  }

  it('the ALU inside (112 × 156 units, 6-unit blocks) is refused at 390 px: its blocks would be under 10 px', () => {
    const free = freeStage({ w: 390, h: 317 }, [note], { w: 112, h: 156 }, undefined, PHONE_EDGE_PX);
    expect(openPlan({ x: 100, y: 80, w: 185, h: 160 }, { w: 112, h: 156 }, 6, free, PHONE_LENS_W)).toBeNull();
  });

  it('only a zoom hands off: a free stage that shrinks under an unzoomed lens shrinks it to fit', () => {
    const free = { x: 16, y: 62, w: 358, h: 239 };
    const box = { x: 100, y: 100, w: 120, h: 110 }, ext = { w: 60, h: 20 };
    const plan = openPlan(box, ext, 2, free, PHONE_LENS_W)!;
    expect(plan.rect.w).toBeCloseTo(free.w);
    // the stage bar rewraps: the free stage loses height and width, the box is unchanged
    const less = { x: 16, y: 100, w: 300, h: 150 };
    const g = growPlan({ plan, boxH: box.h }, box, ext, less);
    expect(g.handoff).toBe(false);
    expect(g.plan.rect.w).toBeLessThanOrEqual(less.w + 1e-6);
    expect(g.plan.rect.h).toBeLessThanOrEqual(less.h + 1e-6);
    // the same box zoomed: now it hands off
    expect(growPlan({ plan, boxH: box.h }, { ...box, h: box.h * 1.1 }, ext, free).handoff).toBe(true);
    // and the slack: rounding at the whole width does not hand off an unzoomed lens
    expect(growPlan({ plan, boxH: box.h }, box, ext, { ...free, w: free.w - 0.3 }).handoff).toBe(false);
    expect(plan.rect.w - 2 * RIM_PX).toBeGreaterThan(0);
  });
});
