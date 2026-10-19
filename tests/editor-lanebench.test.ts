// The lane cores' sandbox bench (campaign/bench.ts addLaneBench, editor/lanemon.ts): a test program of an
// act 9 core level as a computer chip around the learner's core (a data memory with a port per lane, a
// cycle-late read for the warp cores, the screen memory and screen for k_frame), with the lane golden model
// checking every thread's writes as the level's bench does.

import { describe, expect, it } from 'vitest';
import { tick } from './yieldtick';
import { addLaneBench, failingTest } from '../src/campaign/bench';
import { coreSpecOf } from '../src/campaign/corecheck';
import { levelChallenge } from '../src/campaign/levels';
import { nodeById } from '../src/campaign/nodes';
import { detectLanes16, LaneMonitor } from '../src/editor/lanemon';
import { detectRv16 } from '../src/editor/cpu16';
import { UserLibrary } from '../src/editor/library';
import { emptyWorkspace } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { ioState } from '../src/editor/ioparts';
import '../src/lib';

describe('debug a lane core test in the sandbox', { timeout: 300000 }, () => {
  function bench(level: string, coreFrom: string, test: string | ((f: string[]) => string)) {
    const ch = levelChallenge(nodeById(level)!)!;
    const spec = coreSpecOf(ch.check)!;
    const coreDoc = levelChallenge(nodeById(coreFrom)!)!.answer().at(-1)!;
    let ws = { ...emptyWorkspace(), chips: { [coreDoc.id]: coreDoc } };
    const core = new UserLibrary(ws).compiled(coreDoc.id)!.def;
    const name = typeof test === 'string' ? test : test(ch.check.kind === 'custom' ? ch.check.run(core, 'gate').failures : []);
    const t = spec.tests().find((x) => x.name === name) ?? failingTest(spec, name)!;
    expect(t, name).toBeTruthy();
    const r = addLaneBench(ws, core, coreDoc.id, t, spec);
    if ('error' in r) return { error: r.error };
    ws = r.ws;
    const doc = ws.chips[r.id];
    expect(ws.open.at(-1)).toBe(r.id);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(new UserLibrary(ws).compiled(r.id)!, doc.pins);
    const m = new LaneMonitor(es, () => doc, () => ws.chips);
    m.runToHalt(Infinity, 6000);
    return { m, es, doc, ws };
  }

  it('the SIMT core runs a program with loads and stores per lane to its end, every lane checked', () => {
    const r = bench('k_simt', 'k_simt', 'memory per lane');
    if ('error' in r) throw new Error(r.error);
    const { m, doc, ws } = r;
    expect(detectRv16(doc, ws.chips)).toBeNull();
    expect(detectLanes16(doc, ws.chips)).toMatchObject({ core: 'core', lanes: 4, warps: 1, raster: false, ram: { id: 'dmem', k: 10 } });
    expect(m.mismatch).toBeNull();
    expect(m.halted).toBe(true);
    expect(m.done).toBe(true);
    expect(m.retired).toBeGreaterThan(8);
    const r2 = bench('k_simt', 'k_simt', 'split: nested');
    if ('error' in r2) throw new Error(r2.error);
    expect(r2.m.mismatch).toBeNull();
    expect(r2.m.done).toBe(true);
  });

  it('the SIMD core on a split test: the bench stops at the first wrong write, with the lane', () => {
    const r = bench('k_simt', 'k_simd', (f) => f[0]);
    if ('error' in r) throw new Error(r.error);
    expect(r.m.mismatch).not.toBeNull();
    expect(r.m.mismatch!.detail).toMatch(/lane \d/);
  });

  it('two warps: loads come back a cycle late on the load port, bar, every thread checked', () => {
    for (const name of ['two warps: loads', 'two warps: bar waits']) {
      const r = bench('k_warps', 'k_warps', name);
      if ('error' in r) throw new Error(r.error);
      expect(detectLanes16(r.doc, r.ws.chips)).toMatchObject({ warps: 2, raster: false });
      expect(r.m.mismatch, name).toBeNull();
      expect(r.m.done, name).toBe(true);
    }
  });

  it('k_frame: the rasterizer draws on the screen, the lanes read the screen memory back', () => {
    for (const name of ['two triangles on one edge, read back', 'clear, bar, draw']) {
      const r = bench('k_frame', 'k_frame', name);
      if ('error' in r) throw new Error(r.error);
      expect(detectLanes16(r.doc, r.ws.chips)).toMatchObject({ warps: 2, raster: true });
      expect(r.m.mismatch, name).toBeNull();
      expect(r.m.done, name).toBe(true);
      expect(r.m.pixels).toBeGreaterThan(100);
      // the screen took every pixel the rasterizer wrote
      const scr = ioState(r.es.sim!, r.es.sim!.design.root.children!.get('screen')!) as { writes: number };
      expect(scr.writes).toBe(r.m.pixels);
    }
  });

  it('a core without the rasterizer pins cannot sit on k_frame’s bench', () => {
    const r = bench('k_frame', 'k_warps', 'a triangle');
    expect('error' in r && r.error).toMatch(/fa, fd, fwe/);
  });
  // a macrotask after each program: the whole loop holds its worker for a minute and more (tests/yieldtick.ts)
  it('every program of every lane level runs to its end on the reference core, no mismatch', async () => {
    const bad: string[] = [];
    for (const lv of ['k_simd', 'k_simt', 'k_warps', 'k_frame']) {
      const ch = levelChallenge(nodeById(lv)!)!;
      const spec = coreSpecOf(ch.check)!;
      const coreDoc = ch.answer().at(-1)!;
      const ws0 = { ...emptyWorkspace(), chips: { [coreDoc.id]: coreDoc } };
      const core = new UserLibrary(ws0).compiled(coreDoc.id)!.def;
      for (const t of spec.tests()) {
        const r = addLaneBench(ws0, core, coreDoc.id, t, spec);
        if ('error' in r) { bad.push(`${lv} ${t.name}: ${r.error}`); continue; }
        const doc = r.ws.chips[r.id];
        const es = new EditorSim({ debounceMs: 0 });
        es.update(new UserLibrary(r.ws).compiled(r.id)!, doc.pins);
        const m = new LaneMonitor(es, () => doc, () => r.ws.chips);
        m.runToHalt(Infinity, 20000);
        if (m.mismatch || !m.done) bad.push(`${lv} ${t.name}: ${m.mismatch?.detail ?? `not done after ${es.cycles} cycles`}`);
        await tick();
      }
    }
    expect(bad).toEqual([]);
  });
});
