import { describe, expect, it } from 'vitest';
import { laneCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu, warpCore } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { disasm } from '../src/riscv/isa';
import { SIMT_PROGRAMS } from '../src/riscv/simtprograms';
import { WARP_DMEM_K, WARP_PROGRAMS, WARP_SMEM_K } from '../src/riscv/warpprograms';
import { netlistOf } from '../src/sim/types';
import { instrUse, laneUse, oooUse, STAGE_UNITS } from '../src/widgets/insthw';
import { oooCpu } from '../src/lib/ooocore';

// The program-listing highlight names top-level instances: keep the tables in step with the CPUs.
const names = (d: ReturnType<typeof singleCycleCpu>) => new Set(netlistOf(d)!.instances.map((i) => i.name));
const prog = assemble('addi t0, zero, 1\nadd t1, t0, t0\nlw t2, 0(zero)\nsw t2, 4(zero)\nbeq t0, t1, 0\njal ra, 4\njalr zero, 0(ra)\nlui a0, 1\nauipc a1, 0').words;

describe('instruction → hardware map', () => {
  it('the out-of-order core: every unit named exists, on either port', () => {
    const have = names(oooCpu(prog));
    const ops = [...prog, ...assemble('mul t0, t1, t2\ndiv t0, t1, t2').words];
    for (const w of ops) for (const port of [-1, 0, 1]) {
      const units = oooUse(w, port).units;
      expect(units.filter((u) => !have.has(u)), `${disasm(w, 0)} on port ${port}`).toEqual([]);
      expect(units).toContain('rob');
    }
  });

  it('every pipeline stage unit exists in the pipelined CPU', () => {
    // the M units exist only in the RV32IM variant
    const have = new Set([...names(pipelinedCpu(prog, {})), ...names(pipelinedCpu(prog, { adder: 'ks', m: true }))]);
    for (const [stage, units] of Object.entries(STAGE_UNITS)) {
      const missing = units.filter((u) => !have.has(u) && !['btb', 'fsel', 'corr', 'mis', 'mspc', 'vF', 'bcmp', 'jtgt', 'clr0E'].includes(u));
      expect(missing, stage).toEqual([]);
    }
  });

  it('each instruction class lights up real units on every CPU', () => {
    for (const cpu of [singleCycleCpu(prog), systemCpu(prog), multicycleCpu(prog, {}), pipelinedCpu(prog, {})]) {
      const have = names(cpu);
      for (const w of prog) {
        const hit = instrUse(w).units.filter((u) => have.has(u));
        expect(hit.length, `${cpu.id} ${w.toString(16)}`).toBeGreaterThan(3);
        expect(hit).toContain('pc');
      }
    }
    expect(instrUse(prog[2]).units).toContain('dm');
    expect(instrUse(prog[1]).units).not.toContain('dm');
  });
});

describe('instruction → hardware map, lane and warp cores', () => {
  const missing = (units: string[], have: Set<string>) => units.filter((u) => !have.has(u));

  it('every lane kernel instruction names lane-core instances only', () => {
    for (const p of SIMT_PROGRAMS) {
      const words = assemble(p.source).words;
      const have = names(laneCore(words, 4));
      for (const w of words) {
        expect(missing(laneUse(w, { n: 4 }).units, have), `${p.id}: ${disasm(w, 0)}`).toEqual([]);
        expect(missing(laneUse(w, { n: 4 }, { lanes: [1, 3] }).units, have), `${p.id}: ${disasm(w, 0)}, lanes 1 3`).toEqual([]);
      }
    }
    const lw = laneUse(assemble('lw t0, 0(t1)').words[0], { n: 4 }, { lanes: [2] }).units;
    expect(lw).toEqual(expect.arrayContaining(['mseq', 'mAd', 'dm', 'lane2']));
    expect(lw).not.toContain('lane0');
    expect(laneUse(assemble('split t0').words[0], { n: 4 }).units).toEqual(expect.arrayContaining(['simt', 'pm', 'lead']));
  });

  it('every warp kernel instruction names warp-core instances only, for every warp count', () => {
    for (const p of WARP_PROGRAMS) {
      const words = assemble(p.source(4)).words;
      for (const W of p.threads ? [p.threads / 4] : [1, 2, 4]) {
        const core = { n: 4, W, lsu: !!p.lsu, mul: !!p.mul };
        const have = names(warpCore(words, { warps: W, lanes: 4, latency: 8, dmemK: WARP_DMEM_K, data: p.data(), lsu: core.lsu, mul: core.mul, smemK: WARP_SMEM_K }));
        for (const w of words) for (let k = 0; k < W; k++) {
          expect(missing(laneUse(w, core, { warp: k }).units, have), `${p.id} × ${W}: ${disasm(w, 0)} on warp ${k}`).toEqual([]);
        }
      }
    }
    const core = { n: 4, W: 4, lsu: true, mul: true };
    expect(laneUse(assemble('lw t0, 0(t1)').words[0], core, { warp: 2 }).units).toEqual(expect.arrayContaining(['sched', 'warp2', 'hz2', 'se2', 'acc', 'mem']));
    expect(laneUse(assemble('bar t0, t1').words[0], core, { warp: 1 }).units).toEqual(expect.arrayContaining(['atBar', 'barCmp', 'warp1']));
  });
});
