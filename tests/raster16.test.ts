// Act 9's graphics levels (4c): the campaign's edge stepper, tile walk and rasterizer at gate level against
// gfx/raster16.ts, cycle for cycle, on 32 BitSim lanes at once.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CMD16, Edge16, rasterize16, s16, SETUP16, Walk16 } from '../src/gfx/raster16';
import { setup, type Vtx } from '../src/gfx/raster';
import { EDGE16, RASTER16, TILE16 } from '../src/lib/rv16/raster16';
import { BitSim } from '../src/sim/bitsim';
import { flatten } from '../src/sim/flatten';
import { stats } from '../src/sim/stats';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}
const L32 = Array.from({ length: 32 }, (_, i) => i);
const VP = ['v0x', 'v0y', 'v1x', 'v1y', 'v2x', 'v2y'];

describe('campaign edge stepper', () => {
  it('every command, 32 random streams against the model', () => {
    const r = lcg(5);
    const sim = new BitSim(flatten(EDGE16));
    const m = L32.map(() => new Edge16());
    const word = () => Math.floor(r() * 0x10000);
    const a = L32.map(() => word() & 0x3ff ^ (r() < 0.5 ? 0xfc00 : 0)), b = L32.map(() => word() & 0x3ff ^ (r() < 0.5 ? 0xfc00 : 0));
    sim.setInput('a', a); sim.setInput('b', b);
    for (let t = 0; t < 300; t++) {
      const cmd = L32.map(() => (t === 0 ? CMD16.load : Math.floor(r() * 8)));
      const e0 = L32.map(() => word());
      sim.setInput('cmd', cmd); sim.setInput('e0', e0);
      sim.cycle();
      L32.forEach((l) => m[l].step(cmd[l], a[l], b[l], e0[l]));
      sim.settle();
      const e = sim.get('e'), ins = sim.get('inside');
      for (const l of L32) {
        expect(s16(e[l]), `lane ${l} cycle ${t} cmd ${cmd[l]}`).toBe(m[l].e);
        expect(ins[l]).toBe(m[l].inside);
      }
    }
  });
});

describe('campaign tile walk', () => {
  it('boxes and tile verdicts: every output, every cycle, against the model', () => {
    const r = lcg(6);
    const sim = new BitSim(flatten(TILE16));
    const m = L32.map(() => new Walk16());
    let box = L32.map(() => ({ tx0: 0, tx1: 0, ty0: 0, ty1: 0 }));
    sim.setInput('rst', 0);
    for (let t = 0; t < 1500; t++) {
      // a new box for a lane that is idle; go now and then
      box = box.map((bx, l) => {
        if (m[l].busy) return bx;
        const x0 = Math.floor(r() * 8), y0 = Math.floor(r() * 8);
        return { tx0: x0, tx1: Math.min(7, x0 + Math.floor(r() * 3)), ty0: y0, ty1: Math.min(7, y0 + Math.floor(r() * 3)) };
      });
      const go = L32.map(() => (r() < 0.3 ? 1 : 0)), ok = L32.map(() => (r() < 0.6 ? 1 : 0));
      for (const p of ['tx0', 'tx1', 'ty0', 'ty1'] as const) sim.setInput(p, box.map((bx) => bx[p]));
      sim.setInput('go', go); sim.setInput('ok', ok);
      sim.settle();
      const got = Object.fromEntries(['x', 'y', 'cmd', 'test', 'pix', 'busy'].map((p) => [p, sim.get(p)]));
      for (const l of L32) {
        const o = m[l].out(box[l], ok[l]);
        expect([got.busy[l], got.test[l], got.pix[l], got.cmd[l]], `lane ${l} cycle ${t}`).toEqual([o.busy, o.test, o.pix, o.cmd]);
        if (o.busy) expect([got.x[l], got.y[l]], `lane ${l} cycle ${t}`).toEqual([o.x, o.y]);
      }
      sim.cycle();
      L32.forEach((l) => m[l].edge(box[l], go[l], ok[l], 0));
    }
  });
});

/** 7-bit triangles: random ones, and the cases the draw rarely makes. */
function triangles(seed: number, n: number): Vtx[][] {
  const r = lcg(seed);
  const p = (): Vtx => [Math.floor(r() * 128), Math.floor(r() * 128)];
  const fixed: Vtx[][] = [
    [[10, 10], [120, 30], [40, 120]], [[10, 10], [40, 120], [120, 30]], [[0, 0], [60, 60], [120, 120]],
    [[8, 8], [24, 8], [8, 24]], [[127, 0], [127, 127], [0, 127]], [[0, 0], [127, 1], [1, 127]], [[127, 127], [127, 127], [127, 127]],
    [[2, 2], [3, 2], [2, 3]], [[0, 0], [127, 0], [0, 127]], [[60, 1], [126, 126], [1, 70]],
  ];
  return Array.from({ length: n }, (_, i) => fixed[i] ?? (r() < 0.3 ? (() => { const a = p(); return [a, [Math.min(127, a[0] + Math.floor(r() * 20)), a[1]], [a[0], Math.min(127, a[1] + Math.floor(r() * 20))]] as Vtx[]; })() : [p(), p(), p()]));
}

describe('campaign rasterizer', () => {
  for (const seed of [1, 2, 3]) {
    it(`draws what the reference draws, in the same cycles (32 triangles at once, seed ${seed})`, () => {
      const tris = triangles(seed * 100, 32);
      const runs = tris.map((v) => rasterize16(v));
      const sim = new BitSim(flatten(RASTER16));
      VP.forEach((p, k) => sim.setInput(p, tris.map((v) => v[k >> 1][k & 1])));
      sim.setInput('col', L32.map((l) => 0x1000 + l));
      sim.setInput('rst', 0);
      const writes: string[][] = tris.map(() => []), busy = new Array(32).fill(0);
      const T = Math.max(...runs.map((x) => x.cycles)) + 3;
      for (let t = 0; t < T; t++) {
        sim.setInput('go', t === 0 ? 1 : 0);
        sim.settle();
        const we = sim.get('fwe'), fa = sim.get('fa'), fd = sim.get('fd'), b = sim.get('busy');
        for (const l of L32) {
          busy[l] += b[l];
          if (we[l]) { expect(fd[l]).toBe(0x1000 + l); writes[l].push(`${t}:${fa[l] & 31},${fa[l] >> 5}`); }
        }
        sim.cycle();
      }
      for (const l of L32) {
        expect(writes[l], `lane ${l}: ${JSON.stringify(tris[l])}`).toEqual(runs[l].writes.map((w) => `${w.cycle}:${w.x},${w.y}`));
        expect(busy[l], `lane ${l} cycles`).toBe(runs[l].cycles);
      }
    });
  }

  it('a second triangle after the first; reset stops it', () => {
    const tris = triangles(9, 32), next = triangles(10, 32);
    const sim = new BitSim(flatten(RASTER16));
    const set = (vs: Vtx[][]) => VP.forEach((p, k) => sim.setInput(p, vs.map((v) => v[k >> 1][k & 1])));
    set(tris);
    sim.setInput('col', 7); sim.setInput('rst', 0);
    sim.setInput('go', 1); sim.cycle(); sim.setInput('go', 0);
    for (let t = 0; t < 3000; t++) sim.cycle();
    sim.settle();
    expect(sim.get('busy').every((x) => x === 0)).toBe(true);
    set(next);
    sim.setInput('go', 1); sim.settle(); sim.cycle(); sim.setInput('go', 0);
    const runs = next.map((v) => rasterize16(v));
    let n = new Array(32).fill(0);
    for (let t = 1; t < 3000; t++) { sim.settle(); const we = sim.get('fwe'); for (const l of L32) n[l] += we[l]; sim.cycle(); }
    expect(n).toEqual(runs.map((x) => x.writes.length));
    sim.setInput('go', 1); sim.cycle(); sim.setInput('go', 0); sim.cycle();
    sim.setInput('rst', 1); sim.cycle(); sim.setInput('rst', 0); sim.settle();
    n = sim.get('busy');
    expect(n.every((x) => x === 0)).toBe(true);
  });

  it('16-bit edges suffice; costs', () => {
    let worst = 0;
    for (const v of triangles(77, 3000)) {
      const s = setup(v);
      for (let i = 0; i < 3; i++) worst = Math.max(worst, Math.abs(s.e0[i]), Math.abs(s.e0[i] + s.off[i]));
    }
    expect(worst).toBeLessThan(0x8000);
    expect(SETUP16).toBe(19);
    console.log('edge', stats(EDGE16).nands, 'tile', stats(TILE16).nands, 'raster', stats(RASTER16).nands);
  });
});
