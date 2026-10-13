// Chapter 30's drawing pad: the tessellator (gfx/tessellate.ts) and a drawing on the gate-level GPU.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { chPixels } from '../src/chapters/ch-gfx';
import { blend332, CLEAR_CYCLES, FB_W, rasterize, type Vtx, Z_WALK_START } from '../src/gfx/raster';
import {
  cross, type Drawing, drawingCost, drawingOps, drawingPicture, polyArea2, polygonTriangles, SAMPLE_DRAWINGS, shapeTriangles, strokeTriangles,
} from '../src/gfx/tessellate';
import { ramLeafState } from '../src/lib/bigmem';
import { FB_WORDS, GPU30Z, VERTEX_PINS } from '../src/lib/raster';
import { DualSim } from '../src/sim/dualsim';
import { flatten, type HierNode } from '../src/sim/flatten';

/** Seeded LCG. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

const area = (ts: Vtx[][]) => ts.reduce((a, t) => a + cross(t[0], t[1], t[2]), 0);
const onScreen = (ts: Vtx[][]) => ts.every((t) => t.every(([x, y]) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x <= 255 && y >= 0 && y <= 255));

describe('tessellation', () => {
  it('a simple polygon (random, star-shaped, either winding): n − 2 front faces covering exactly its area', () => {
    const r = rng(7);
    for (let k = 0; k < 300; k++) {
      const n = 3 + Math.floor(r() * 14), cx = 60 + r() * 136, cy = 60 + r() * 136;
      // one corner per sector, so no gap between neighbours reaches half a turn: star-shaped about the centre, simple
      const angles = Array.from({ length: n }, (_, i) => ((i + 0.8 * r()) * 2 * Math.PI) / n);
      let p: Vtx[] = angles.map((a) => { const rad = 8 + r() * 50; return [Math.round(cx + rad * Math.cos(a)), Math.round(cy + rad * Math.sin(a))]; });
      if (r() < 0.5) p = p.reverse();
      const ts = polygonTriangles(p);
      expect(ts.every((t) => cross(t[0], t[1], t[2]) > 0)).toBe(true);
      expect(area(ts)).toBe(Math.abs(polyArea2(p)));
      expect(ts.length).toBeLessThanOrEqual(n - 2);
    }
  });

  it('a concave L: four triangles, nothing drawn in the notch', () => {
    const L: Vtx[] = [[20, 20], [60, 20], [60, 100], [140, 100], [140, 140], [20, 140]];
    const ts = polygonTriangles(L);
    expect(ts).toHaveLength(4);
    expect(area(ts)).toBe(Math.abs(polyArea2(L)));
    const px = new Set(ts.flatMap((t) => rasterize(t).writes.map((w) => `${w.x},${w.y}`)));
    expect(px.has('25,10')).toBe(false); // (100, 40) quarter pixels: in the notch
    expect(px.has('10,10')).toBe(true);
  });

  it('a self-crossing outline still gives front faces only', () => {
    const ts = polygonTriangles([[20, 20], [200, 200], [200, 20], [20, 200]]);
    expect(ts.length).toBeGreaterThan(0);
    expect(ts.every((t) => cross(t[0], t[1], t[2]) > 0)).toBe(true);
  });

  it('brush strokes: front faces on the screen, two a segment, a dot is a square', () => {
    const r = rng(11);
    for (let k = 0; k < 200; k++) {
      const pts: Vtx[] = [];
      let x = r() * 255, y = r() * 255;
      for (let i = 0, n = 1 + Math.floor(r() * 30); i < n; i++) {
        x = Math.max(0, Math.min(255, x + (r() - 0.5) * 40)); y = Math.max(0, Math.min(255, y + (r() - 0.5) * 40));
        pts.push([Math.round(x), Math.round(y)]);
      }
      const ts = strokeTriangles(pts, 1 + Math.floor(r() * 5));
      expect(onScreen(ts)).toBe(true);
      expect(ts.every((t) => cross(t[0], t[1], t[2]) > 0)).toBe(true);
    }
    expect(strokeTriangles([[100, 100]], 2)).toHaveLength(2);
    // a straight stroke 2 px wide, 20 px long: square caps (half the width each end) make it 22 × 2 px
    const line = strokeTriangles([[40, 100], [120, 100]], 2);
    expect(line).toHaveLength(2);
    expect(area(line)).toBe(2 * 88 * 8);
  });

  it('a clicked triangle is turned to face the viewer, unless the winding is kept', () => {
    const ccw: Vtx[] = [[20, 12], [90, 240], [230, 70]];
    expect(cross(...(ccw as [Vtx, Vtx, Vtx]))).toBeLessThan(0);
    const s = { tool: 'tri' as const, pts: ccw, col: 0xe0, a: 7 };
    expect(rasterize(shapeTriangles(s)[0]).setup.front).toBe(true);
    const d: Drawing = { bg: 0, shapes: [s], keepWinding: true };
    expect(drawingCost(d).culled).toBe(1);
    expect(drawingPicture(d).every((c) => c === 0)).toBe(true);
  });

  it('every shape a depth plane nearer than the last: a translucent stroke crossing itself is blended once', () => {
    const loop: Vtx[] = [[40, 40], [200, 200], [200, 40], [40, 200], [40, 40]];
    const d: Drawing = { bg: 0x03, shapes: [{ tool: 'brush', pts: loop, col: 0xfc, a: 3, w: 4 }, { tool: 'poly', pts: [[0, 0], [60, 0], [60, 60]], col: 0xe0, a: 3 }] };
    const ops = drawingOps(d);
    expect(ops[0]).toMatchObject({ clr: true, col: 0x03 });
    const zs = ops.slice(1).map((o) => o.z![0]);
    expect(zs.every((z, i) => i === 0 || z <= zs[i - 1])).toBe(true);
    const pic = drawingPicture({ ...d, shapes: [d.shapes[0]] });
    const once = blend332(0xfc, 0x03, 3);
    expect(new Set(pic)).toEqual(new Set([0x03, once]));
    // the stroke's triangles do overlap: without the depth test some pixel would be blended twice
    const n = new Map<number, number>();
    for (const op of ops.slice(1).filter((o) => o.col === 0xfc)) for (const w of rasterize(op.v).writes) n.set(w.y * FB_W + w.x, (n.get(w.y * FB_W + w.x) ?? 0) + 1);
    expect(Math.max(...n.values())).toBeGreaterThan(1);
    // the later shape blends over the stroke where they meet
    expect(drawingPicture(d).includes(blend332(0xe0, once, 3))).toBe(true);
  });

  it('chapter 30 quotes the house\'s numbers', () => {
    const d = SAMPLE_DRAWINGS[0].d, c = drawingCost(d);
    expect([d.shapes.length, c.triangles, c.culled, c.pixels, c.clear, c.draw, c.setup]).toEqual([7, 25, 0, 2136, CLEAR_CYCLES + 1, 6453, 2125]);
    expect(Z_WALK_START).toBe(85);
    const body = chPixels.steps.find((s) => s.title === 'Your own picture')!.body.replace(/\s+/g, ' ');
    for (const q of ['7 shapes, 25 triangles and 2 136 pixel writes', '6 453 cycles after the 4 437-cycle clear', 'spends 85 cycles', '2 125 of the 6 453'])
      expect(body).toContain(q);
    expect(CLEAR_CYCLES + 1).toBe(4437);
  });
});

describe('a drawing on the gate-level GPU', () => {
  it('the house on GPU30Z (cycle engine, fed as the screen panel feeds it): the reference picture, in the predicted cycles', () => {
    const d = SAMPLE_DRAWINGS[0].d, ops = drawingOps(d), c = drawingCost(d);
    const design = flatten(GPU30Z), root = design.root;
    const sim = new DualSim(design);
    sim.preferFast = true;
    sim.reset('zero');
    for (const p of ['go', 'swap', 'clk', 'clr', 'zt']) sim.setInput(p, 0);
    sim.setInput('sync', 1);
    sim.settle();
    const busy = () => sim.getBits(root.ports.busy)[0] === 1;
    const queue = [...ops];
    let cycles = 0, go = false;
    while (queue.length || go || busy()) {
      if (go) { sim.setInput('go', 0); sim.settle(); go = false; }
      if (!busy() && queue.length) {
        const op = queue.shift()!;
        VERTEX_PINS.forEach((p, k) => sim.setInput(p, op.v[k >> 1][k & 1]));
        ['z0', 'z1', 'z2'].forEach((p, k) => sim.setInput(p, op.z?.[k] ?? 0));
        sim.setInput('col', op.col); sim.setInput('a', op.a ?? 7); sim.setInput('zt', op.zt ? 1 : 0); sim.setInput('clr', op.clr ? 1 : 0);
        sim.setInput('go', 1); sim.settle(); go = true;
      }
      if (!go && !busy()) break;
      sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
      cycles++;
      expect(cycles).toBeLessThan(c.clear + c.draw + 10);
    }
    expect(cycles).toBe(c.clear + c.draw);
    // the back frame, from the memory leaves
    const kid = (n: HierNode, ...p: string[]) => p.reduce<HierNode>((x, k) => x.children!.get(k)!, n);
    const front = sim.getBits(kid(root, 'scan').ports.front)[0], fb = kid(root, 'fb', `fb${front ? 0 : 1}`);
    const got = new Uint8Array(FB_W * FB_W);
    for (let j = 0; j < 4; j++) { const st = ramLeafState(sim, kid(fb, `bank${j}`))!; for (let a = 0; a < FB_WORDS; a++) got[4 * a + j] = st.mem[a]; }
    const want = drawingPicture(d);
    let diff = 0;
    for (let i = 0; i < want.length; i++) if (got[i] !== want[i]) diff++;
    expect(diff).toBe(0);
    expect(new Set(want).size).toBeGreaterThanOrEqual(6);
  }, 120_000);
});
