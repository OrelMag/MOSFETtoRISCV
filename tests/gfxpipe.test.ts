// Chapter 31: the vertex kernels against plain arithmetic, the software kernels against the reference picture, and
// the whole pipeline at gate level (the cycle engine): every frame's picture, the vertex buffers, what each unit did
// in a frame, and the numbers the chapter and its cost widget quote.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { chGfxPipeline } from '../src/chapters/ch-gfx';
import { FrameRecorder, framePicture, frameOps, PIPE_COSTS } from '../src/gfx/pipeline';
import { rasterize, type Vtx } from '../src/gfx/raster';
import { CLEAR_UNIT, CMD_UNIT, cmdUnit, cuState, gpu31 } from '../src/lib/gfxpipe';
import { ramLeafState } from '../src/lib/bigmem';
import { frameBuffers, rasterizer, ROP, ROP_W, SCAN_OUT } from '../src/lib/raster';
import { warpCore } from '../src/lib/warps';
import { assemble } from '../src/riscv/asm';
import {
  GFX, type Mesh, meshById, meshData, MESHES, packVertex, SIN, SOFT_CLEAR, SOFT_DMEM_WORDS, SOFT_FB, SOFT_TRIANGLE, softData, transformed, TURN, vertexKernel,
} from '../src/riscv/gfxprograms';
import { WarpISS } from '../src/riscv/warps';
import { warpTiming } from '../src/riscv/warptiming';
import { DualSim } from '../src/sim/dualsim';
import { flatten, type HierNode } from '../src/sim/flatten';
import type { Sim } from '../src/sim/sim';
import { stats } from '../src/sim/stats';
import { type ComponentDef, netlistOf } from '../src/sim/types';
import { pack } from '../src/sim/values';
import { deadInstances } from '../src/sim/dead';
import { backwardEnds, labelOverlaps, routeNetlist, symbolOverlaps, wireOverlaps } from '../src/view/route';

const kid = (n: HierNode, ...p: string[]) => p.reduce<HierNode>((x, k) => x.children!.get(k)!, n);
const u = (s: Sim, n: HierNode, port: string) => pack(s.getBits(n.ports[port])) >>> 0;
const inst = (d: ComponentDef, n: string) => netlistOf(d)!.instances.find((i) => i.name === n)!.def;
const nands = (d: ComponentDef) => stats(d).nands;
const fmt = (n: number) => n.toLocaleString('en').replace(/,/g, ' ');

describe('vertex kernels', () => {
  it('the model: front faces the right way round, every vertex on the screen at every angle', () => {
    for (const m of MESHES) {
      expect(m.verts.length % 4).toBe(0);
      for (let f = 0; f < TURN; f++) {
        const v = transformed(m, f);
        for (const p of v) for (const c of p) expect(c).toBeGreaterThanOrEqual(0), expect(c).toBeLessThan(256);
        // a convex mesh: a face is drawn exactly when its normal points at the viewer, both its triangles or neither
        const fronts = m.tris.map((t) => rasterize(t.i.map((k) => [v[k][0], v[k][1]] as Vtx)).setup.front);
        if (m.id === 'triangle') expect(fronts).toEqual([true]);
        else {
          for (let k = 0; k < 12; k += 2) expect(fronts[k], `frame ${f} face ${k / 2}`).toBe(fronts[k + 1]);
          const faces = fronts.filter(Boolean).length / 2;
          expect(faces).toBeGreaterThanOrEqual(2);
          expect(faces).toBeLessThanOrEqual(3);
        }
      }
    }
    expect(SIN[16]).toBe(65536);
  });

  it('on the golden model, launched frame after frame: the vertex buffer, the frame counter', () => {
    for (const m of MESHES) {
      const words = assemble(vertexKernel(m)).words;
      expect(words.length).toBeLessThanOrEqual(64); // the program ROM of the core
      const iss = new WarpISS(words, { warps: 1, lanes: 4, dmemWords: 128, data: meshData(m), mul: true });
      for (let f = 0; f < 70; f++) {
        if (f) iss.launch();
        for (let k = 0; k < 500 && !iss.halted; k++) iss.step(0);
        expect(iss.halted).toBe(true);
        expect(iss.dmem[GFX.frame]).toBe(f + 1);
        const base = GFX.vbuf + 8 * (f & 1);
        expect([...iss.dmem.slice(base, base + m.verts.length)], `${m.id} frame ${f}`).toEqual(transformed(m, f).map(packVertex));
      }
    }
  });
});

describe('the same frame in software', () => {
  it('clear and triangle on four warps: the reference picture, and the cycles chapter 31 quotes', () => {
    const m = meshById('triangle'), opts = { warps: 4, lanes: 4, latency: 8, mul: true, imemWords: 256, dmemWords: SOFT_DMEM_WORDS };
    for (const f of [1, 9, 23, 40]) {
      const v = transformed(m, f), tv = m.tris[0].i.map((k) => v[k]);
      const c = warpTiming(assemble(SOFT_CLEAR).words, { ...opts, data: softData(tv, m.tris[0].col) });
      const d = warpTiming(assemble(SOFT_TRIANGLE).words, { ...opts, data: Array.from(c.model.dmem) });
      expect(Buffer.from(new Uint8Array(d.model.dmem.buffer, SOFT_FB, 4096)).equals(Buffer.from(framePicture(m, f))), `frame ${f}`).toBe(true);
      if (f === 1) expect([c.cycles, d.cycles]).toEqual([PIPE_COSTS.frames[2].clear, PIPE_COSTS.frames[2].draw]);
    }
  });
});

describe('frame recorder', () => {
  it('spans per lane, totals by phase, a frame from launch to launch', () => {
    const r = new FrameRecorder();
    const seq: [string, boolean, boolean][] = [['start', true, false], ['launch', false, false], ['clear', true, true], ['clear', false, true], ['count', false, false],
      ['tri', false, false], ['v0', false, false], ['v1', false, false], ['v2', false, false], ['go', false, false], ['draw', false, true], ['swap', false, false], ['flip', false, false], ['launch', false, false]];
    const closed = seq.map(([st, k, b], c) => r.sample(c, st as Parameters<FrameRecorder['sample']>[1], k, b));
    expect(closed.lastIndexOf(true)).toBe(13);
    expect(r.frames).toBe(1);
    expect(r.last!.cycles).toBe(12);
    expect(r.last!.totals).toEqual({ clear: 3, draw: 7, wait: 2, kernel: 1 });
    expect(r.last!.lanes.raster).toEqual([{ kind: 'clear', from: 1, to: 3 }, { kind: 'draw', from: 9, to: 10 }]);
    expect(r.last!.lanes.cmd).toEqual([{ kind: 'read', from: 3, to: 9 }, { kind: 'wait', from: 10, to: 12 }]);
  });
});

/** Run the pipeline for `frames` frames on the cycle engine; each frame's picture when the command unit swaps. */
function runPipeline(m: Mesh, frames: number, clear: 'pixel' | 'word' = 'pixel') {
  const d = flatten(gpu31(m, { clear }));
  const sim = new DualSim(d);
  sim.preferFast = true;
  sim.reset('zero');
  sim.setInput('clk', 0);
  sim.settle();
  const root = d.root, rec = new FrameRecorder(), pictures: Uint8Array[] = [], vbufs: number[][] = [], records = [];
  let last = '';
  for (let c = 0; rec.frames < frames && c < 60000; c++) {
    const st = cuState(u(sim, kid(root, 'cmd'), 'state'));
    if (st === 'count' && last !== 'count') {
      const p = rec.frames & 1;
      vbufs.push(m.verts.map((_, i) => u(sim, kid(root, 'core', 'mem', 'mem', `w${GFX.vbuf + 8 * p + i}`), 'q')));
    }
    if (st === 'swap' && last !== 'swap') {
      const front = u(sim, kid(root, 'scan'), 'front'), fb = kid(root, 'fb', `fb${front ? 0 : 1}`), pic = new Uint8Array(4096);
      for (let j = 0; j < 4; j++) { const s = ramLeafState(sim, kid(fb, `bank${j}`))!; for (let a = 0; a < 1024; a++) pic[4 * a + j] = s.mem[a]; }
      pictures.push(pic);
    }
    const cl = root.children!.get('clear');
    if (rec.sample(c, st, u(sim, kid(root, 'core'), 'halted') === 0, u(sim, kid(root, 'rast'), 'busy') === 1, !!cl && u(sim, cl, 'busy') === 1)) records.push(rec.last!);
    last = st;
    sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
  }
  return { sim, pictures, vbufs, records };
}

describe('the pipeline at gate level', () => {
  for (const m of MESHES) {
    it(`${m.id}: every frame the reference picture, the vertex buffers the kernel's, on the cycle engine`, () => {
      const { sim, pictures, vbufs, records } = runPipeline(m, 3);
      expect(sim.engine).toBe('cycle');
      expect(pictures.length).toBe(3);
      pictures.forEach((p, f) => expect(Buffer.from(p).equals(Buffer.from(framePicture(m, f))), `frame ${f}`).toBe(true));
      vbufs.forEach((v, f) => expect(v, `vertex buffer, frame ${f}`).toEqual(transformed(m, f).map(packVertex)));
      // frame 1's phases (chapter 31 and the cost widget quote them); frames end on a flip, so they are whole scan-outs
      const want = PIPE_COSTS.frames.find((x) => x.id === m.id)!;
      expect(records[1].totals).toEqual({ clear: want.clear, draw: want.draw, wait: want.wait, kernel: want.kernel });
      for (const r of records.slice(1)) expect(r.cycles % 1024).toBe(0);
      // the kernel's cycles as the warp core's timing model predicts them
      const k = warpTiming(assemble(vertexKernel(m)).words, { warps: 1, lanes: 4, latency: 8, mul: true, dmemWords: 128, data: meshData(m) });
      expect(k.cycles).toBe(want.kernel);
      // the frame's draws, as the reference lists them: a clear and every triangle
      expect(frameOps(m, 1).length).toBe(1 + m.tris.length);
    }, 120000);
  }
});

describe('step 5: the clear a word a cycle', () => {
  for (const m of MESHES) {
    it(`${m.id}: the same pictures, the clear unit's frame (four pixels and four depths a cycle)`, () => {
      const { sim, pictures, records } = runPipeline(m, 3, 'word');
      expect(sim.engine).toBe('cycle');
      pictures.forEach((p, f) => expect(Buffer.from(p).equals(Buffer.from(framePicture(m, f))), `frame ${f}`).toBe(true));
      const want = PIPE_COSTS.frames.find((x) => x.id === `${m.id}_w`)!;
      expect(records[1].totals).toEqual({ clear: want.clear, draw: want.draw, wait: want.wait, kernel: want.kernel });
      // the clear unit: started at launch, 1 024 words, then the command unit reads the count
      expect(records[1].lanes.clear).toEqual([{ kind: 'clear', from: 1, to: 1025 }]);
      expect(records[1].lanes.raster.every((sp) => sp.kind === 'draw')).toBe(true);
      expect(records.slice(1).map((r) => r.cycles)).toEqual(records.slice(1).map(() => (m.id === 'triangle' ? 3072 : 4096)));
    }, 120000);
  }

  it('chapter 30 and steps 1–4 keep their parts', () => {
    expect([ROP.id, CMD_UNIT.id, frameBuffers().id, gpu31(meshById('triangle')).id]).toEqual(['rop', 'cmd_unit', 'fb2_pixbuf_pixbuf', 'gpu31_triangle']);
    expect(gpu31(meshById('triangle'), { clear: 'word' }).id).toBe('gpu31_triangle_w');
  });
});

// The registry-wide schematic tests (route.test.ts, layout.test.ts) never build gpu31: below it, the core's 128-word
// lane memory takes the router minutes. Its own levels are checked here: the top, the core with its host port.
describe('chapter 31 schematics', () => {
  const g = gpu31(meshById('cube')), core = inst(g, 'core');
  for (const d of [g, core, inst(core, 'mem'), CMD_UNIT, gpu31(meshById('cube'), { clear: 'word' }), cmdUnit(true), CLEAR_UNIT, ROP_W]) {
    it(`${d.id}: no two nets on one line, no overlaps, every part reaches an output`, () => {
      const nl = netlistOf(d)!;
      expect(wireOverlaps(routeNetlist(d, nl).nets)).toEqual([]);
      expect(labelOverlaps(d, nl)).toEqual([]);
      expect(symbolOverlaps(nl)).toEqual([]);
      expect(backwardEnds(d, nl)).toEqual([]);
      expect(deadInstances(nl, d.ports)).toEqual([]);
    }, 60000);
  }
});

describe('chapter 31 quotes these numbers', () => {
  it('the cost of each stage', () => {
    const g = gpu31(meshById('triangle')), core = inst(g, 'core'), mem = inst(inst(core, 'mem'), 'mem');
    const got: Record<string, number> = {
      core: nands(core) - nands(mem) - nands(inst(core, 'im0')), cmd: nands(CMD_UNIT), rast: nands(rasterizer(true)),
      rop: nands(ROP) - nands(inst(ROP, 'zbuf')), fb: nands(frameBuffers()) - 2 * nands(inst(frameBuffers(), 'fb0')), scan: nands(SCAN_OUT),
    };
    expect(Object.fromEntries(PIPE_COSTS.stages.map((s) => [s.id, s.nands]))).toEqual(got);
    expect(nands(inst(core, 'lane0'))).toBe(35255);
    const soft = warpCore(assemble(SOFT_TRIANGLE).words, { warps: 4, lanes: 4, mul: true, dmemK: 11, imemK: 8 });
    const roms = netlistOf(soft)!.instances.filter((i) => /^im\d/.test(i.name)).reduce((a, i) => a + nands(i.def), 0);
    expect(nands(soft) - nands(inst(inst(soft, 'mem'), 'mem')) - roms).toBe(PIPE_COSTS.softCore);
    // step 5's parts, logic only
    const fw = frameBuffers(undefined, undefined, true);
    expect(PIPE_COSTS.word).toEqual({
      unit: nands(CLEAR_UNIT), cmd: nands(cmdUnit(true)), rop: nands(ROP_W) - [0, 1, 2, 3].reduce((a, j) => a + nands(inst(ROP_W, `zbuf${j}`)), 0),
      fb: nands(fw) - 2 * nands(inst(fw, 'fb0')),
    });
  }, 120000);

  it('the prose', () => {
    const text = chGfxPipeline.steps.map((s) => s.body).join(' ');
    const [tri, cube, soft] = PIPE_COSTS.frames;
    for (const v of [tri.clear, tri.draw, tri.wait, tri.clear + tri.draw + tri.wait, soft.clear, soft.draw, PIPE_COSTS.softCore,
      ...PIPE_COSTS.stages.filter((s) => s.id !== 'fb' && s.id !== 'rop' && s.id !== 'scan').map((s) => s.nands), 35255]) {
      expect(text, String(v)).toContain(fmt(v));
    }
    expect(text).toContain(`${tri.kernel} cycles`);
    expect(text).toContain(`${cube.kernel} cycles`);
    expect(Math.round((100 * tri.clear) / (tri.clear + tri.draw + tri.wait))).toBe(72);
    expect(flatten(gpu31(meshById('triangle'))).leaves.length).toBe(413501);
    expect(text).toContain('413 501');
  });

  it("step 5's prose", () => {
    const body = chGfxPipeline.steps.find((x) => x.title === 'A faster clear')!.body;
    const W = PIPE_COSTS.word, stage = (id: string) => PIPE_COSTS.stages.find((x) => x.id === id)!.nands;
    const [tw, cw] = ['triangle_w', 'cube_w'].map((id) => PIPE_COSTS.frames.find((x) => x.id === id)!);
    for (const v of [W.unit, W.rop, stage('rop'), W.rop - stage('rop'), W.cmd, stage('cmd'), tw.clear, tw.draw, tw.wait, tw.clear + tw.draw + tw.wait, cw.clear + cw.draw + cw.wait]) {
      expect(body, String(v)).toContain(fmt(v));
    }
    // about 580 NANDs: the unit, the banks' multiplexers, the frames' wider enables, less the command unit's colour multiplexer
    const fbBank = (wide: boolean) => nands(inst(frameBuffers(undefined, undefined, wide), 'fb0')) - 4 * nands(inst(inst(frameBuffers(undefined, undefined, wide), 'fb0'), 'bank0'));
    const extra = W.unit + (W.rop - stage('rop')) + (W.cmd - stage('cmd')) + (W.fb - stage('fb')) + 2 * (fbBank(true) - fbBank(false));
    expect(Math.round(extra / 10) * 10).toBe(580);
    expect(body).toContain('about 580 NANDs');
  });
});
