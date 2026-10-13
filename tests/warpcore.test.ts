import { describe, expect, it } from 'vitest';
import { SB_CHECK, accessUnit, accessesOf, hazardSpec, koggeStone, lanePortMemory, quadMemory, regfile, rom, treeMul, warpCore, warpSlot, warpDecode, warpDecodeSpec } from '../src/lib';
import { tilingRuns } from '../src/widgets/feed';
import { stats } from '../src/sim/stats';
import { assemble } from '../src/riscv/asm';
import { clockCycle } from '../src/riscv/cosim';
import { WARP_DMEM_K, WARP_PROGRAMS, WARP_SMEM_K, type WarpProgram } from '../src/riscv/warpprograms';
import { WarpISS } from '../src/riscv/warps';
import { warpTiming } from '../src/riscv/warptiming';
import { flatten, type HierNode } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';

const u = (sim: GateSim, node: HierNode, port: string) => pack(sim.getBits(node.ports[port])) >>> 0;
const child = (n: HierNode, ...path: string[]) => path.reduce((x, p) => x.children!.get(p)!, n);

export interface CosimOptions {
  /** Chapter 29's core (shared memory, bar, amoadd.w, accesses per line or bank). */
  lsu?: boolean;
  sharedLatency?: number;
  globalEvery?: number;
  maxCycles?: number;
}

/** Run the warp core against the golden model; after every instruction that completes, compare its warp. */
export function cosimWarps(p: WarpProgram, W: number, n: number, L: number, o: CosimOptions = {}) {
  const words = assemble(p.source(n)).words;
  const lsu = !!o.lsu, mul = !!p.mul;
  const design = flatten(warpCore(words, { warps: W, lanes: n, latency: L, dmemK: WARP_DMEM_K, data: p.data(), lsu, mul, smemK: WARP_SMEM_K, sharedLatency: o.sharedLatency, globalEvery: o.globalEvery }));
  const sim = new GateSim(design);
  sim.reset('zero');
  sim.setInput('clk', 0);
  sim.settle();
  const mopts = { warps: W, lanes: n, dmemWords: 2 ** WARP_DMEM_K, data: p.data(), smemWords: lsu ? 2 ** WARP_SMEM_K : 0, mul };
  const m = new WarpISS(words, mopts);
  const maxCycles = o.maxCycles ?? 4000;
  const root = design.root;
  const regs = (w: number, i: number) => {
    const rf = child(root, `lane${i}`, `rf${w}`);
    return [0, ...Array.from({ length: 31 }, (_, r) => u(sim, child(rf, `w${r + 1}`), 'q'))];
  };
  let c = 0, issued = 0;
  for (; c < maxCycles && !(m.halted && u(sim, root, 'halted') === 1); c++) {
    const retire = u(sim, root, 'retire') === 1;
    const w = u(sim, root, 'warpOut');
    if (retire) { m.step(w); issued++; }
    clockCycle(sim);
    if (!retire) continue;
    const at = `cycle ${c}, warp ${w}`;
    const slot = child(root, `warp${w}`);
    expect(u(sim, slot, 'pc'), `${at}: pc`).toBe(m.warps[w].pc);
    expect(u(sim, slot, 'mask'), `${at}: mask`).toBe(m.warps[w].mask);
    const pending = u(sim, slot, 'pending');
    for (let i = 0; i < n; i++) {
      const hw = regs(w, i), gm = [...m.warps[w].lanes[i].x];
      for (let r = 1; r < 32; r++) if (!((pending >>> r) & 1)) expect(hw[r], `${at}: lane ${i} x${r}`).toBe(gm[r]);
    }
  }
  // drained: every register of every warp, and the memory
  for (let k = 0; k < L; k++) clockCycle(sim);
  for (let w = 0; w < W; w++) for (let i = 0; i < n; i++) expect(regs(w, i), `end: warp ${w} lane ${i}`).toEqual([...m.warps[w].lanes[i].x]);
  const words_ = (node: HierNode, N: number) => Array.from({ length: N }, (_, i) => u(sim, child(node, `w${i}`), 'q'));
  expect(words_(child(root, 'mem', lsu ? 'gmem' : 'mem'), 2 ** WARP_DMEM_K)).toEqual([...m.dmem]);
  if (lsu) expect(words_(child(root, 'mem', 'smem'), 2 ** WARP_SMEM_K), 'shared memory').toEqual([...m.smem]);
  for (const [i, v] of p.expect()) expect(m.dmem[i], `word ${i}`).toBe(v >>> 0);
  expect(m.halted).toBe(true);
  // the timing model predicts the same cycles
  const t = warpTiming(words, { ...mopts, latency: L, lsu, sharedLatency: o.sharedLatency, globalEvery: o.globalEvery });
  expect([t.cycles, t.issued], 'timing model').toEqual([c, issued]);
  return { cycles: c, issued, leaves: design.leaves.length };
}

describe('warp core blocks', () => {
  it('the scoreboard check matches its spec', () => {
    const sim = simulate(SB_CHECK);
    const words = assemble('lw t0, 0(t1)\nadd a0, t0, t2\nsw a0, 4(t3)\nlui t4, 5\njal ra, 8\nbeq t0, t1, 8\naddi a1, a2, -1').words;
    for (const w of words) for (const p of [0, 1 << 5, 1 << 6, 1 << 7, 1 << 10, 1 << 28, 1 << 29, 1 << 12, 1 << 11, 0xfffffffe]) {
      expect(evalOnce(sim, [w, p])[0], `${w.toString(16)} ${p.toString(16)}`).toBe(hazardSpec(w, p));
    }
  });

  it('the warp decoder reads warp and nwarps', () => {
    const d = simulate(warpDecode(4, 4));
    for (const csr of [0xcc0, 0xcc1, 0xcc2, 0xcc3, 0xcc4, 0xcc5, 0xcc6, 0x300]) {
      for (const v of [[0b1110011, 2, 0, csr, 0b1010, 3], [0b0001011, 1, 5, csr, 15, 1], [0b0001011, 0, 0, csr, 1, 0], [0b1110011, 2, 0, csr, 3, 2]]) {
        expect(evalOnce(d, v), `${v}`).toEqual(warpDecodeSpec(4, 4, v));
      }
    }
  });
});

describe('warp core (gate level) vs the warp golden model', () => {
  const saxpy = WARP_PROGRAMS.find((p) => p.id === 'saxpy64')!, sum4 = WARP_PROGRAMS.find((p) => p.id === 'sum4')!;
  it('saxpy: 1 warp, 8-cycle loads', () => { cosimWarps(saxpy, 1, 4, 8); }, 600000);
  it('saxpy: 2 warps, 8-cycle loads', () => { cosimWarps(saxpy, 2, 4, 8); }, 600000);
  it('saxpy: 4 warps, 2 lanes, 3-cycle loads', () => { cosimWarps(saxpy, 4, 2, 3); }, 600000);
  it('sum4: 4 warps, 8-cycle loads', () => { cosimWarps(sum4, 4, 4, 8); }, 600000);
});

describe('the numbers chapter 28 quotes', () => {
  it('saxpy cycles and instructions on 1, 2 and 4 warps with 8-cycle loads; what a warp costs', () => {
    const p = WARP_PROGRAMS.find((x) => x.id === 'saxpy64')!;
    const words = assemble(p.source(4)).words;
    const run = (W: number) => warpTiming(words, { warps: W, lanes: 4, latency: 8, dmemWords: 2 ** WARP_DMEM_K, data: p.data() });
    expect([1, 2, 4].map((W) => [run(W).cycles, run(W).issued])).toEqual([[266, 154], [192, 160], [172, 172]]);
    const nands = (W: number) => stats(warpCore(words, { warps: W, lanes: 4, latency: 8, dmemK: WARP_DMEM_K, data: p.data() })).nands;
    expect(4 * stats(regfile(5, 32)).nands).toBe(92564);
    expect(nands(2) - nands(1)).toBe(110622);
    expect([stats(rom(words, 6)).nands, stats(warpSlot(4, false)).nands, stats(SB_CHECK).nands]).toEqual([8064, 6203, 736]);
  });
});

describe('chapter 29 core (gate level): access unit, shared memory, bar, amoadd.w, mul', () => {
  const P = (id: string) => WARP_PROGRAMS.find((p) => p.id === id)!;
  it('cols: coalesced, one line per load', () => { cosimWarps(P('cols'), 4, 4, 8, { lsu: true }); }, 600000);
  it('rows: a line per lane', () => { cosimWarps(P('rows'), 4, 4, 8, { lsu: true }); }, 600000);
  it('reduceSeq: bar, shared memory without conflicts', () => { cosimWarps(P('reduceSeq'), 4, 4, 8, { lsu: true }); }, 600000);
  it('reduceInt: bank conflicts; shared as slow as global', () => { cosimWarps(P('reduceInt'), 4, 4, 8, { lsu: true, sharedLatency: 8 }); }, 600000);
  it('hist: amoadd.w one lane at a time, 2 warps × 2 lanes', () => { cosimWarps(P('hist'), 2, 2, 4, { lsu: true }); }, 600000);
  it('hist: 4 warps', () => { cosimWarps(P('hist'), 4, 4, 8, { lsu: true }); }, 600000);
  it('matmul: mul in the lanes, a global line every 3 cycles', () => { cosimWarps(P('matmul'), 4, 4, 8, { lsu: true, globalEvery: 3 }); }, 600000);
  it('matmulTiled: tiles in shared memory, bar, slots taken by global requests', () => { cosimWarps(P('matmulTiled'), 4, 4, 8, { lsu: true, globalEvery: 2 }); }, 600000);
  it('saxpy: as chapter 28 (every load one line)', () => { expect(cosimWarps(P('saxpy64'), 4, 4, 8, { lsu: true }).cycles).toBe(172); }, 600000);
});

describe('the numbers chapter 29 quotes', () => {
  const P = (id: string) => WARP_PROGRAMS.find((p) => p.id === id)!;
  const run = (id: string) => {
    const p = P(id);
    const t = warpTiming(assemble(p.source(4)).words, { warps: 4, lanes: 4, latency: 8, lsu: true, mul: true, dmemWords: 2 ** WARP_DMEM_K, smemWords: 2 ** WARP_SMEM_K, data: p.data() });
    return [t.cycles, t.issued, t.globalAccesses, t.sharedAccesses, t.heldCycles];
  };
  it('cycles, instructions, accesses and cycles holding the port', () => {
    expect(run('rows')).toEqual([124, 76, 68, 0, 48]);
    expect(run('cols')).toEqual([76, 76, 20, 0, 0]);
    expect(run('reduceSeq')).toEqual([298, 292, 17, 20, 0]);
    expect(run('reduceInt')).toEqual([330, 308, 17, 38, 18]);
    expect(run('hist')).toEqual([197, 144, 80, 0, 48]);
    expect(run('matmul').slice(0, 3)).toEqual([396, 396, 144]);
    expect(run('matmulTiled').slice(0, 3)).toEqual([592, 560, 40]);
  });

  it('tiling pays from a line every three cycles', () => {
    const { plain, tiled } = tilingRuns();
    expect([plain[0].cycles, tiled[0].cycles, plain[2].cycles, tiled[2].cycles, plain[7].cycles, tiled[7].cycles]).toEqual([396, 592, 668, 622, 1348, 770]);
    expect(plain.findIndex((r, i) => tiled[i].cycles < r.cycles)).toBe(2);
  });

  it('what the memories and the new units cost', () => {
    expect([stats(lanePortMemory(7, 4)).nands, stats(quadMemory(7, false)).nands]).toEqual([183964, 77829]);
    expect([stats(quadMemory(6, true)).nands, stats(quadMemory(6, false)).nands]).toEqual([38928, 38628]);
    expect([stats(accessUnit(4)).nands, stats(treeMul(32, false, 32)).nands, stats(koggeStone(32)).nands]).toEqual([5870, 7388, 878]);
  });

  it('the quizzes: accesses the access unit takes', () => {
    expect(accessesOf(15, [24, 28, 32, 36])).toEqual([0b0011, 0b1100]);
    expect(accessesOf(15, [0x1000, 0x1008, 0x1010, 0x1018])).toEqual([0b0011, 0b1100]);
    expect(accessesOf(15, [12, 12, 28, 12], true)).toEqual([1, 2, 4, 8]);
  });
});
