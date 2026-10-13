// The bench of the rasterizer level (act 9, k_raster): triangles on 32 BitSim lanes at once, each started with
// go for one cycle and held until busy falls. Every pixel write (fa = 32·y + x, fd, fwe) must be the reference's
// (gfx/raster16.ts), in the tile walk's order; how long the set-up takes is the learner's choice and is graded as
// cycles (go to busy falling, summed). A second batch follows the first without a reset. No DOM.

import type { CustomRun } from '../editor/challenges';
import type { Vtx } from '../gfx/raster';
import { rasterize16 } from '../gfx/raster16';
import { BitSim } from '../sim/bitsim';
import { flatten } from '../sim/flatten';
import { analyzeTiming } from '../sim/timing';
import type { ComponentDef } from '../sim/types';
import { rng } from './drills';

export const RASTER_PINS = ['v0x', 'v0y', 'v1x', 'v1y', 'v2x', 'v2y', 'col', 'go', 'clk', 'rst', 'fa', 'fd', 'fwe', 'busy'];

/** The bench's triangles: the shapes that break rasterizers, then random ones. 64: two batches of 32. */
export function rasterTris(): { v: Vtx[]; col: number; name: string }[] {
  const fixed: [string, Vtx[]][] = [
    ['a large triangle', [[10, 10], [120, 30], [40, 120]]],
    ['the same, wound the other way (a back face)', [[10, 10], [40, 120], [120, 30]]],
    ['a degenerate one (three points on a line)', [[0, 0], [60, 60], [120, 120]]],
    ['edges through pixel centres', [[10, 10], [26, 10], [10, 26]]],
    ['the other half of that square', [[26, 10], [26, 26], [10, 26]]],
    ['to the screen\'s corners', [[0, 0], [127, 0], [0, 127]]],
    ['the opposite corner', [[127, 1], [127, 127], [1, 127]]],
    ['a thin sliver', [[4, 8], [124, 112], [116, 124]]],
    ['a tiny one, inside one pixel', [[41, 41], [43, 41], [41, 43]]],
    ['one row of tiles', [[2, 20], [125, 22], [60, 30]]],
    ['a vertical sliver', [[64, 0], [66, 127], [62, 127]]],
    ['negative and positive slopes', [[60, 2], [126, 126], [1, 70]]],
  ];
  const r = rng(31);
  const p = (): Vtx => [Math.floor(r() * 128), Math.floor(r() * 128)];
  const out = fixed.map(([name, v], i) => ({ name, v, col: (0x1111 * (i + 1)) & 0xffff }));
  for (let i = out.length; i < 64; i++) {
    if (i % 3 === 0) {
      const a = p(), d = 4 + Math.floor(r() * 24);
      out.push({ name: `random small ${i}`, v: [a, [Math.min(127, a[0] + d), a[1]], [a[0], Math.min(127, a[1] + d)]], col: Math.floor(r() * 0x10000) });
    } else out.push({ name: `random ${i}`, v: [p(), p(), p()], col: Math.floor(r() * 0x10000) });
  }
  return out;
}

const px = (fa: number) => `(${fa & 31}, ${fa >> 5})`;
const hex = (v: number) => `0x${(v & 0xffff).toString(16).padStart(4, '0')}`;

/** Run a rasterizer chip on the bench's triangles. */
export function runRaster(def: ComponentDef, mode: 'gate' | 'switch'): CustomRun {
  if (mode === 'switch') return { failures: ['switch level: the rasterizer must simulate at gate level'], tested: 0 };
  const have = new Set(def.ports.map((p) => p.name));
  const missing = RASTER_PINS.filter((p) => !have.has(p));
  if (missing.length) return { failures: [`missing pins: ${missing.join(', ')}`], tested: 0 };
  let sim: BitSim;
  try {
    sim = new BitSim(flatten(def, { mode: 'gate' }));
  } catch (e) {
    return { failures: [`cannot simulate: ${(e as Error).message}`], tested: 0 };
  }
  const tris = rasterTris(), failures: string[] = [], failed: number[] = [];
  let cycles = 0;
  const VP = ['v0x', 'v0y', 'v1x', 'v1y', 'v2x', 'v2y'];
  sim.setInput('go', 0); sim.setInput('rst', 1); sim.cycle(); sim.setInput('rst', 0);
  for (let b0 = 0; b0 < tris.length; b0 += 32) {
    const batch = tris.slice(b0, b0 + 32), n = batch.length;
    const fill = (f: (t: (typeof batch)[number]) => number) => Array.from({ length: 32 }, (_, l) => f(batch[Math.min(l, n - 1)]));
    VP.forEach((p, k) => sim.setInput(p, fill((t) => t.v[k >> 1][k & 1])));
    sim.setInput('col', fill((t) => t.col));
    const want = batch.map((t) => rasterize16(t.v));
    const limit = Math.max(...want.map((w) => w.cycles)) * 3 + 100;
    const got: number[][] = batch.map(() => []), cols: number[][] = batch.map(() => []), end = batch.map(() => -1);
    const isX = (v: number) => Number.isNaN(v);
    let t = 0;
    sim.setInput('go', 1);
    for (; t < limit; t++) {
      sim.settle();
      const busy = sim.get('busy'), fwe = sim.get('fwe'), fa = sim.get('fa'), fd = sim.get('fd');
      for (let l = 0; l < n; l++) {
        if (end[l] >= 0) continue;
        if (t > 0 && !busy[l] && !fwe[l]) { end[l] = t; continue; }
        if (fwe[l]) { got[l].push(fa[l]); cols[l].push(fd[l]); }
        if (isX(busy[l])) end[l] = -2;
      }
      sim.cycle();
      if (t === 0) sim.setInput('go', 0);
      if (end.every((e) => e !== -1)) break;
    }
    batch.forEach((tr, l) => {
      const w = want[l], name = `triangle ${b0 + l + 1} (${tr.name}: ${tr.v.map((p) => `(${p[0]}, ${p[1]})`).join(' ')})`;
      let why = '';
      if (end[l] === -2) why = 'busy is X';
      else if (end[l] < 0) why = `busy never falls in ${limit} cycles`;
      else {
        const k = w.writes.findIndex((p, i) => got[l][i] !== 32 * p.y + p.x || cols[l][i] !== tr.col);
        if (k >= 0) {
          const g = got[l][k];
          why = g === undefined ? `only ${got[l].length} pixel writes; the next expected is ${px(32 * w.writes[k].y + w.writes[k].x)}`
            : `pixel write #${k + 1} is ${px(g)} ← ${hex(cols[l][k])}; expected ${px(32 * w.writes[k].y + w.writes[k].x)} ← ${hex(tr.col)}`;
        } else if (got[l].length > w.writes.length) why = `an extra pixel write ${px(got[l][w.writes.length])} after the ${w.writes.length} it covers`;
      }
      if (why) { failures.push(`${name}: ${why}`); failed.push(b0 + l); }
      cycles += Math.max(0, end[l]);
    });
  }
  let period: number | undefined;
  if (!failures.length) {
    try { period = analyzeTiming(flatten(def, { mode: 'gate' }))?.period ?? undefined; } catch { period = undefined; }
  }
  return { failures: failures.slice(0, 6).concat(failures.length > 6 ? [`… and ${failures.length - 6} more triangles fail`] : []), tested: tris.length, cycles, failed, ...(period ? { period } : {}) };
}
