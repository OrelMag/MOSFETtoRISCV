import { describe, expect, it } from 'vitest';
import { EDGE_BITS, FB_W, rasterize, setup, tilePixel, type Vtx } from '../src/gfx/raster';
import { EDGE_STEP, GPU30, RASTERIZER, RAST_SETUP, RAST_WALK, SCAN_OUT, VERTEX_PINS, FB_WORDS } from '../src/lib/raster';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';
import { lcg } from './util';

const tri = (r: (n: number) => number): Vtx[] => [[r(256), r(256)], [r(256), r(256)], [r(256), r(256)]];
const sx = (v: number, bits = EDGE_BITS) => (v >= 2 ** (bits - 1) ? v - 2 ** bits : v);

describe('reference rasterizer', () => {
  it('two triangles sharing an edge never draw a pixel twice, and leave no gap', () => {
    const r = lcg(7);
    for (let t = 0; t < 200; t++) {
      const q = tri(r);
      const p: Vtx = [r(256), r(256)];
      // a quad split on its diagonal q0–q2, both halves front-facing or both culled
      const a = rasterize([q[0], q[1], q[2]]), b = rasterize([q[0], q[2], p]);
      if (!a.setup.front || !b.setup.front) continue;
      const sa = new Set(a.writes.map((w) => w.y * FB_W + w.x));
      for (const w of b.writes) expect(sa.has(w.y * FB_W + w.x), `${q} ${p}`).toBe(false);
    }
  });

  it('every pixel centre strictly inside is drawn; cycles = 8 + tiles + 16 per walked tile', () => {
    const r = lcg(3);
    for (let t = 0; t < 80; t++) {
      const v = tri(r), run = rasterize(v), s = run.setup;
      if (!s.front) { expect(run.cycles).toBe(3); continue; }
      expect(run.cycles).toBe(8 + run.tiles + 16 * run.walked);
      const got = new Set(run.writes.map((w) => w.y * FB_W + w.x));
      for (let y = 0; y < FB_W; y++) for (let x = 0; x < FB_W; x++) {
        const e = [0, 1, 2].map((i) => s.A[i] * (4 * x + 2 - v[i][0]) + s.B[i] * (4 * y + 2 - v[i][1]));
        for (const k of e) expect(Math.abs(k)).toBeLessThanOrEqual(2 * 255 * 255);
        if (e.every((k) => k > 0)) expect(got.has(y * FB_W + x), `${v} (${x}, ${y})`).toBe(true);
        if (e.some((k) => k < 0)) expect(got.has(y * FB_W + x)).toBe(false);
      }
    }
  });

  it('a tile walk ends at its top-right pixel', () => {
    expect(Array.from({ length: 16 }, (_, k) => tilePixel(k))).toEqual([
      [0, 0], [0, 1], [0, 2], [0, 3], [1, 3], [1, 2], [1, 1], [1, 0], [2, 0], [2, 1], [2, 2], [2, 3], [3, 3], [3, 2], [3, 1], [3, 0]]);
  });
});

describe('gate-level rasterizer', () => {
  it('edge stepper: every command', () => {
    const sim = new BitSim(flatten(EDGE_STEP));
    const dx = -36, dy = 52, off = 300;
    const M = 2 ** EDGE_BITS, w = (v: number) => ((v % M) + M) % M;
    sim.setInput('dx', w(dx)); sim.setInput('dy', w(dy)); sim.setInput('off', w(off)); sim.setInput('e0', w(-1000));
    let e = 0, r = 0;
    const cmds = [1, 2, 2, 3, 4, 5, 4, 6, 0, 2, 6, 3];
    for (const c of cmds) {
      sim.setInput('cmd', c);
      sim.cycle();
      if (c === 1) e = r = -1000;
      else if (c === 2) e += dx;
      else if (c === 3) e += 4 * dx;
      else if (c === 4) e += dy;
      else if (c === 5) e -= dy;
      else if (c === 6) e = r = r + 4 * dy;
      sim.settle();
      expect(sx(sim.get('e', 1)[0]), `cmd ${c}`).toBe(e);
      expect(sim.get('neg', 1)[0]).toBe(e < 0 ? 1 : 0);
      expect(sim.get('tneg', 1)[0]).toBe(e + off < 0 ? 1 : 0);
    }
  });

  it('draws what the reference draws, in the same cycles (32 triangles at once)', () => {
    const r = lcg(11);
    const tris = Array.from({ length: 32 }, (_, l) => {
      if (l === 0) return [[10, 10], [200, 40], [60, 230]] as Vtx[];      // front
      if (l === 1) return [[10, 10], [60, 230], [200, 40]] as Vtx[];      // back face
      if (l === 2) return [[0, 0], [100, 100], [200, 200]] as Vtx[];      // degenerate
      if (l === 3) return [[8, 8], [24, 8], [8, 24]] as Vtx[];            // edges through pixel centres
      if (l === 4) return [[250, 1], [255, 250], [0, 255]] as Vtx[];      // to the borders
      return tri(r);
    });
    const runs = tris.map((v) => rasterize(v));
    const sim = new BitSim(flatten(RASTERIZER));
    VERTEX_PINS.forEach((p, k) => sim.setInput(p, tris.map((v) => v[k >> 1][k & 1])));
    sim.setInput('col', tris.map((_, l) => l + 1));
    const writes: string[][] = tris.map(() => []);
    const busy = new Array(32).fill(0);
    const T = Math.max(...runs.map((x) => x.cycles)) + 3;
    for (let t = 0; t < T; t++) {
      sim.setInput('go', t === 0 ? 1 : 0);
      sim.settle();
      const we = sim.get('fwe'), fa = sim.get('fa'), fd = sim.get('fd'), b = sim.get('busy');
      for (let l = 0; l < 32; l++) {
        if (t === 0) expect(b[l], 'idle at power-on').toBe(0);
        busy[l] += b[l];
        if (we[l]) {
          expect(fd[l]).toBe(l + 1);
          writes[l].push(`${t}:${fa[l] & 63},${fa[l] >> 6}`);
        }
      }
      sim.cycle();
    }
    for (let l = 0; l < 32; l++) {
      expect(writes[l], `lane ${l}: ${tris[l]}`).toEqual(runs[l].writes.map((w) => `${w.cycle}:${w.x},${w.y}`));
      expect(busy[l], `lane ${l} cycles`).toBe(runs[l].cycles);
    }
  });

  it('set-up and walk costs', () => {
    const n = (d: Parameters<typeof stats>[0]) => stats(d).nands;
    console.log(`edge stepper ${n(EDGE_STEP)}, set-up ${n(RAST_SETUP)}, walk ${n(RAST_WALK)}, rasterizer ${n(RASTERIZER)}, scan-out ${n(SCAN_OUT)}`);
    expect(n(RASTERIZER)).toBeGreaterThan(n(RAST_SETUP) + n(RAST_WALK) + 3 * n(EDGE_STEP));
  });

  it('GPU30: draw into the back frame, swap at vsync, the scan-out reads the picture', () => {
    const v: Vtx[] = [[20, 12], [230, 70], [90, 240]];
    const want = new Uint8Array(FB_W * FB_W);
    const run = rasterize(v);
    for (const w of run.writes) want[w.y * FB_W + w.x] = 0xe3;
    const sim = new BitSim(flatten(GPU30));
    VERTEX_PINS.forEach((p, k) => sim.setInput(p, v[k >> 1][k & 1]));
    sim.setInput('col', 0xe3); sim.setInput('swap', 0); sim.setInput('sync', 1);
    sim.setInput('go', 1); sim.cycle(); sim.setInput('go', 0);
    for (let t = 0; t < run.cycles; t++) sim.cycle();
    sim.settle();
    expect(sim.get('busy', 1)[0]).toBe(0);
    // the front frame is still blank; ask for the flip, then read one whole frame after the next vsync
    sim.setInput('swap', 1); sim.cycle(); sim.setInput('swap', 0);
    let guard = 0;
    for (sim.settle(); !sim.get('vsync', 1)[0]; sim.settle()) { sim.cycle(); expect(++guard).toBeLessThan(FB_WORDS + 2); }
    sim.cycle();
    const got = new Uint8Array(FB_W * FB_W);
    for (let a = 0; a < FB_WORDS; a++) {
      sim.settle();
      const q = sim.get('pixels', 1)[0];
      for (let j = 0; j < 4; j++) got[4 * a + j] = Math.floor(q / 2 ** (8 * j)) & 255;
      sim.cycle();
    }
    expect(Array.from(got)).toEqual(Array.from(want));
    expect(setup(v).front).toBe(true);
  });
});
