// The zoom lens's geometry (view/lensplan.ts, docs/transparent/DESIGN.md items 1, 3, 4).
import { describe, expect, it } from 'vitest';
import { closesAt, freeStage, growPlan, LENS_CLOSE_PX, LENS_H, LENS_OPEN_PX, LENS_W, MIN_BLOCK_PX, openPlan, opensAt, rimJogs, type Rect } from '../src/view/lensplan';

const meets = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, b: Rect) => a.x >= b.x - 1e-6 && a.y >= b.y - 1e-6 && a.x + a.w <= b.x + b.w + 1e-6 && a.y + a.h <= b.y + b.h + 1e-6;

describe('thresholds', () => {
  it('opens at 96 px on the shorter side, closes under 72', () => {
    expect(LENS_OPEN_PX).toBe(96);
    expect(LENS_CLOSE_PX).toBe(72);
    expect(opensAt({ x: 0, y: 0, w: 300, h: 95 })).toBe(false);
    expect(opensAt({ x: 0, y: 0, w: 96, h: 300 })).toBe(true);
    const free = { x: 0, y: 0, w: 1200, h: 760 };
    expect(closesAt({ x: 100, y: 100, w: 80, h: 73 }, free)).toBe(false);
    expect(closesAt({ x: 100, y: 100, w: 80, h: 71 }, free)).toBe(true);
  });

  it('a wobble between the two thresholds neither opens nor closes it again', () => {
    const free = { x: 0, y: 0, w: 1200, h: 760 };
    let open = false, flips = 0;
    for (const h of [90, 97, 92, 85, 99, 80, 74, 95, 73, 98]) {
      const box = { x: 400, y: 300, w: h * 1.5, h };
      const next: boolean = open ? !closesAt(box, free) : opensAt(box);
      if (next !== open) flips++;
      open = next;
    }
    expect(flips).toBe(1);
  });

  it('closes when the box is panned more than half out of the free stage', () => {
    const free = { x: 0, y: 0, w: 800, h: 600 };
    expect(closesAt({ x: 740, y: 100, w: 100, h: 100 }, free)).toBe(false);
    expect(closesAt({ x: 760, y: 100, w: 100, h: 100 }, free)).toBe(true);
  });
});

describe('placement', () => {
  const canvas = { w: 1200, h: 760 };
  const insides = [{ w: 60, h: 40 }, { w: 30, h: 90 }, { w: 120, h: 20 }, { w: 8, h: 8 }];
  const coverSets: Rect[][] = [
    [],
    [{ x: 860, y: 0, w: 340, h: 760 }], // a right-docked panel
    [{ x: 0, y: 560, w: 420, h: 200 }], // a bottom-left panel
    [{ x: 12, y: 10, w: 90, h: 22 }, { x: 860, y: 0, w: 340, h: 760 }, { x: 300, y: 600, w: 300, h: 140 }], // badge, panel, a note
  ];
  for (const covers of coverSets) for (const ext of insides) {
    it(`stays in the free stage and the cap (${covers.length} covers, ${ext.w}×${ext.h})`, () => {
      const free = freeStage(canvas, covers, ext);
      for (const box of [{ x: 20, y: 20, w: 120, h: 100 }, { x: 500, y: 300, w: 140, h: 110 }, { x: 1000, y: 650, w: 150, h: 100 }]) {
        const p = openPlan(box, ext, 4, free);
        if (!p) continue;
        expect(inside(p.rect, free)).toBe(true);
        for (const c of covers) expect(meets(p.rect, c)).toBe(false);
        expect(p.rect.w).toBeLessThanOrEqual(free.w * LENS_W + 1e-6);
        expect(p.rect.h).toBeLessThanOrEqual(free.h * LENS_H + 1e-6);
        expect(4 * p.scale).toBeGreaterThanOrEqual(MIN_BLOCK_PX);
      }
    });
  }

  it('refuses an inside whose blocks would be under 10 px at the cap', () => {
    const free = { x: 0, y: 0, w: 1200, h: 760 };
    // 1 000 units wide: 0.7 px a unit at the cap, a 4-unit gate under 3 px
    expect(openPlan({ x: 500, y: 300, w: 150, h: 120 }, { w: 1000, h: 400 }, 4, free)).toBeNull();
    expect(openPlan({ x: 500, y: 300, w: 150, h: 120 }, { w: 60, h: 40 }, 4, free)).not.toBeNull();
  });

  it('grows with the zoom and hands off once it would not fit', () => {
    const free = { x: 0, y: 0, w: 1200, h: 760 };
    const box = { x: 500, y: 300, w: 150, h: 120 }, ext = { w: 60, h: 40 };
    const plan = openPlan(box, ext, 4, free)!;
    const g = growPlan({ plan, boxH: box.h }, { ...box, h: box.h * 1.2 }, ext, free);
    expect(g.plan.scale).toBeCloseTo(plan.scale * 1.2);
    expect(g.handoff).toBe(false);
    expect(growPlan({ plan, boxH: box.h }, { ...box, h: box.h * 3 }, ext, free).handoff).toBe(true);
  });
});

describe('rim connectors', () => {
  const lens = { x: 300, y: 100, w: 500, h: 400 };
  const pts = (d: string) => { const n = d.match(/-?\d+(\.\d+)?/g)!.map(Number); return n; };
  it('start where the outer wire crosses the rim and end on the inner pin', () => {
    const ports = [
      { name: 'a', side: 'left' as const, outer: { x: 300, y: 260, edge: 'left' as const }, pin: [340, 140] as [number, number] },
      { name: 'ctl', side: 'left' as const, outer: { x: 420, y: 500, edge: 'bottom' as const }, pin: [338, 470] as [number, number] },
      { name: 'y', side: 'right' as const, outer: { x: 800, y: 213, edge: 'right' as const }, pin: [770, 310] as [number, number] },
      { name: 'v', side: 'right' as const, outer: { x: 300, y: 300, edge: 'left' as const }, pin: [770, 330] as [number, number] },
      { name: 'q', side: 'left' as const, outer: null, pin: [330, 200] as [number, number] },
    ];
    const jogs = rimJogs(lens, ports);
    expect(jogs.length).toBe(5);
    for (const p of ports) {
      const j = jogs.find((x) => x.name === p.name)!;
      const n = pts(j.d);
      if (p.outer) expect([n[0], n[1]]).toEqual([p.outer.x, p.outer.y]);
      expect(n[n.length - 1]).toBe(p.pin[0]); // …H pinX, on the pin's row
      expect(j.pin).toEqual(p.pin);
      // the run along the rim is outside the lens
      const lane = Number(/H(-?[\d.]+)V(-?[\d.]+)H(-?[\d.]+)$/.exec(j.d)?.[1] ?? NaN);
      if (p.outer) expect(lane < lens.x || lane > lens.x + lens.w).toBe(true);
    }
  });

  it('vertical runs on one side take different lanes; names never closer than a line', () => {
    const ports = Array.from({ length: 6 }, (_, i) => ({ name: `p${i}`, side: 'left' as const, outer: { x: 300, y: 200 + i * 10, edge: 'left' as const }, pin: [320, 120 + i * 4] as [number, number] }));
    const jogs = rimJogs(lens, ports);
    const lanes = jogs.map((j) => Number(/H(-?[\d.]+)V/.exec(j.d)![1]));
    expect(new Set(lanes).size).toBe(lanes.length);
    const ys = jogs.map((j) => j.label[1]).sort((a, b) => a - b);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(12);
  });
});
