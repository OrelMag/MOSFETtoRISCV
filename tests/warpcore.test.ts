import { describe, expect, it } from 'vitest';
import { SB_CHECK, hazardSpec, warpCore, warpDecode, warpDecodeSpec } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { clockCycle } from '../src/riscv/cosim';
import { WARP_DMEM_K, WARP_PROGRAMS, type WarpProgram } from '../src/riscv/warpprograms';
import { WarpISS } from '../src/riscv/warps';
import { warpTiming } from '../src/riscv/warptiming';
import { flatten, type HierNode } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import { evalOnce, simulate } from '../src/sim/harness';
import { pack } from '../src/sim/values';

const u = (sim: GateSim, node: HierNode, port: string) => pack(sim.getBits(node.ports[port])) >>> 0;
const child = (n: HierNode, ...path: string[]) => path.reduce((x, p) => x.children!.get(p)!, n);

/** Run the warp core against the golden model; after every issue compare the issuing warp. */
export function cosimWarps(p: WarpProgram, W: number, n: number, L: number, maxCycles = 4000) {
  const words = assemble(p.source(n)).words;
  const design = flatten(warpCore(words, { warps: W, lanes: n, latency: L, dmemK: WARP_DMEM_K, data: p.data() }));
  const sim = new GateSim(design);
  sim.reset('zero');
  sim.setInput('clk', 0);
  sim.settle();
  const m = new WarpISS(words, { warps: W, lanes: n, dmemWords: 2 ** WARP_DMEM_K, data: p.data() });
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
  const mem = child(root, 'mem', 'mem');
  expect(Array.from({ length: 2 ** WARP_DMEM_K }, (_, i) => u(sim, child(mem, `w${i}`), 'q'))).toEqual([...m.dmem]);
  for (const [i, v] of p.expect()) expect(m.dmem[i], `word ${i}`).toBe(v >>> 0);
  expect(m.halted).toBe(true);
  // the timing model predicts the same cycles
  const t = warpTiming(words, { warps: W, lanes: n, latency: L, dmemWords: 2 ** WARP_DMEM_K, data: p.data() });
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
