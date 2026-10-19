import { describe, expect, it } from 'vitest';
import { chFeed, chLanes, chSimt, chWarps } from '../src/chapters/ch-gpu';
import { assemble } from '../src/riscv/asm';
import { clockCycle } from '../src/riscv/cosim';
import { SimtISS } from '../src/riscv/simt';
import { SIMT_PROGRAMS } from '../src/riscv/simtprograms';
import { WARP_DMEM_K, WARP_PROGRAMS, WARP_SMEM_K } from '../src/riscv/warpprograms';
import { WarpISS } from '../src/riscv/warps';
import { DualSim } from '../src/sim/dualsim';
import { flatten, type HierNode } from '../src/sim/flatten';
import { pack } from '../src/sim/values';
import type { Scene } from '../src/view/stage';
import { laneCoreScene } from '../src/widgets/lanes';
import { warpCoreScene } from '../src/widgets/warps';

// Chapters 27–30 run their lane and warp cores on the cycle engine (Scene.engine 'cycle'): every scene the
// chapters and the panels' switchers load builds on it, stays on it, and matches the golden model in
// lock-step the way the Warp panels check it.

const u = (sim: DualSim, node: HierNode, port: string) => pack(sim.getBits(node.ports[port])) >>> 0;
const child = (n: HierNode, ...path: string[]) => path.reduce((x, p) => x.children!.get(p)!, n);
const regs = (sim: DualSim, rf: HierNode) => [0, ...Array.from({ length: 31 }, (_, r) => u(sim, child(rf, `w${r + 1}`), 'q'))];

/** The scene as the stage builds it (stage.ts load), powered on, settled, the cycle engine built. */
function load(scene: Scene) {
  expect(scene.engine).toBe('cycle');
  const design = flatten(scene.root, { mode: 'gate', expand: (d, n) => n.parent === null || !d.preferBehavior });
  const sim = new DualSim(design);
  sim.preferFast = true;
  for (const [k, v] of Object.entries(scene.inputs ?? {})) sim.setInput(k, v);
  sim.reset('zero');
  sim.settle();
  sim.prepare();
  expect(sim.whyNot, 'the cycle engine takes it').toBe('');
  expect(sim.engine).toBe('cycle');
  return { sim, root: design.root };
}

describe('chapters 27–30 on the cycle engine', () => {
  it('every lane and warp core scene of the chapters asks for it (GateSim on request)', () => {
    const scenes = [chLanes, chSimt, chWarps, chFeed].flatMap((c) => c.steps.filter((s) => s.scene).map((s) => s.scene!()));
    expect(scenes.length).toBeGreaterThan(10);
    for (const s of scenes) expect(s.engine, s.root.id).toBe('cycle');
    expect(laneCoreScene('saxpy', { engine: 'gate' }).engine).toBeUndefined();
    expect(warpCoreScene('saxpy64', { engine: 'gate' }).engine).toBeUndefined();
  });

  for (const p of SIMT_PROGRAMS) {
    it(`lane core, ${p.id}: lock-step with the SIMT golden model`, () => {
      const { sim, root } = load(laneCoreScene(p.id));
      const m = new SimtISS(assemble(p.source).words, { lanes: 4 });
      let c = 0, gate = 0;
      for (; c < 3000 && !m.halted; c++) {
        const retire = u(sim, root, 'retire') === 1;
        if (retire) m.step();
        clockCycle(sim);
        if (sim.engine !== 'cycle') gate++;
        expect([u(sim, root, 'pcOut'), u(sim, root, 'maskOut')], `cycle ${c}: pc, mask`).toEqual([m.pc, m.mask]);
        if (retire) for (let i = 0; i < 4; i++) expect(regs(sim, child(root, `lane${i}`, 'rf')), `cycle ${c}: lane ${i}`).toEqual([...m.lanes[i].x]);
      }
      expect(m.halted).toBe(true);
      expect(gate, 'cycles off the cycle engine').toBe(0);
    }, 120000);
  }

  // the chapters' kernels at their scenes' warp counts, and the ones the kernel switchers offer
  const warpRuns: [string, number][] = [['saxpy64', 1], ['saxpy64', 4], ['rows', 4], ['cols', 4], ['reduceSeq', 4], ['reduceInt', 4], ['hist', 4]];
  for (const [id, W] of warpRuns) {
    it(`warp core, ${id} on ${W} warp${W > 1 ? 's' : ''}: lock-step with the warp golden model`, () => {
      const p = WARP_PROGRAMS.find((x) => x.id === id)!;
      const { sim, root } = load(warpCoreScene(id, { warps: W }));
      const lsu = !!p.lsu;
      const m = new WarpISS(assemble(p.source(4)).words, { warps: W, lanes: 4, dmemWords: 2 ** WARP_DMEM_K, data: p.data(), smemWords: lsu ? 2 ** WARP_SMEM_K : 0, mul: p.mul });
      let c = 0, gate = 0;
      for (; c < 4000 && !(m.halted && u(sim, root, 'halted') === 1); c++) {
        const retire = u(sim, root, 'retire') === 1, w = u(sim, root, 'warpOut');
        if (retire) m.step(w);
        clockCycle(sim);
        if (sim.engine !== 'cycle') gate++;
        if (!retire) continue;
        const slot = child(root, `warp${w}`), pend = u(sim, slot, 'pending');
        expect([u(sim, slot, 'pc'), u(sim, slot, 'mask')], `cycle ${c}, warp ${w}: pc, mask`).toEqual([m.warps[w].pc, m.warps[w].mask]);
        for (let i = 0; i < 4; i++) {
          const hw = regs(sim, child(root, `lane${i}`, `rf${w}`));
          for (let r = 1; r < 32; r++) if (!((pend >>> r) & 1)) expect(hw[r], `cycle ${c}, warp ${w}, lane ${i}: x${r}`).toBe(m.warps[w].lanes[i].x[r]);
        }
      }
      expect(m.halted).toBe(true);
      expect(gate, 'cycles off the cycle engine').toBe(0);
      for (const [i, v] of p.expect()) expect(m.dmem[i], `word ${i}`).toBe(v >>> 0);
    }, 300000);
  }
});
