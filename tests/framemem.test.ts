// The frame-memory view's readers (widgets/framemem.ts): the frames and the depth buffer read from the memory leaves
// of the gate-level GPU are the reference model's, and the write port the view watches marks exactly the pixels drawn.
import { describe, expect, it } from 'vitest';
import '../src/lib';
import { type DrawOp, FB_W, RefFrame, zAt, zStore } from '../src/gfx/raster';
import { GPU30Z, VERTEX_PINS } from '../src/lib/raster';
import { DualSim } from '../src/sim/dualsim';
import { flatten, type HierNode } from '../src/sim/flatten';
import { depthOf, frameOf } from '../src/widgets/framemem';

const kid = (n: HierNode, ...p: string[]) => p.reduce<HierNode>((x, k) => x.children!.get(k)!, n);

describe('frame memory', () => {
  it('frames and depth buffer read from GPU30Z\'s leaves equal the reference; the write port marks the drawn pixels', () => {
    const ops: DrawOp[] = [
      { clr: true, v: [[0, 0], [0, 0], [0, 0]], col: 0x25 },
      { v: [[20, 20], [240, 60], [40, 230]], z: [20, 20, 220], col: 0xe0, zt: true },
      { v: [[230, 20], [200, 240], [10, 120]], z: [220, 60, 30], col: 0x1c, zt: true },
    ];
    const design = flatten(GPU30Z), root = design.root, fb = kid(root, 'fb');
    const sim = new DualSim(design);
    sim.preferFast = true;
    sim.reset('zero');
    for (const p of ['go', 'swap', 'clk', 'clr', 'zt']) sim.setInput(p, 0);
    sim.setInput('sync', 1);
    sim.settle();
    const front = sim.getBits(kid(root, 'scan').ports.front)[0] === 1 ? 1 : 0, back = 1 - front;
    const written = new Uint8Array(FB_W * FB_W), drawn = new Uint8Array(FB_W * FB_W);
    const ref = new RefFrame();
    for (const op of ops) {
      ref.draw(op);
      VERTEX_PINS.forEach((p, k) => sim.setInput(p, op.v[k >> 1][k & 1]));
      ['z0', 'z1', 'z2'].forEach((p, k) => sim.setInput(p, op.z?.[k] ?? 0));
      sim.setInput('col', op.col); sim.setInput('a', 7); sim.setInput('zt', op.zt ? 1 : 0); sim.setInput('clr', op.clr ? 1 : 0);
      sim.setInput('go', 1); sim.settle();
      let first = true;
      do {
        // what the view's edge hook reads: the framebuffer's write port, before the edge
        if (sim.getBits(fb.ports.we)[0] === 1) {
          const a = sim.getBits(fb.ports.wa).reduce((v: number, b, i) => v + (b === 1 ? 2 ** i : 0), 0);
          written[a] = 1;
          if (!op.clr) drawn[a] = 1;
        }
        sim.setInput('clk', 1); sim.settle(); sim.setInput('clk', 0); sim.settle();
        if (first) { sim.setInput('go', 0); sim.settle(); first = false; }
      } while (sim.getBits(root.ports.busy)[0] === 1);
    }
    expect(frameOf(sim, back)).toEqual(ref.fb);
    expect(frameOf(sim, front)!.every((v) => v === 0)).toBe(true);
    expect(depthOf(sim)).toEqual(ref.zb);
    // the clear writes every pixel; the triangles' writes are the pixels whose depth they set
    expect(written.every((v) => v === 1)).toBe(true);
    let n = 0;
    for (let i = 0; i < drawn.length; i++) if (drawn[i]) { n++; expect(ref.zb[i]).not.toBe(0xffff); }
    expect(n).toBe([...ref.zb].filter((z) => z !== 0xffff).length);
    // spot check: a pixel inside the red triangle near its top vertex has red's depth there
    const red = ops[1];
    expect(ref.zb[6 * FB_W + 6]).toBe(zStore(zAt(red.v, red.z!, 6, 6)));
  }, 60_000);
});
