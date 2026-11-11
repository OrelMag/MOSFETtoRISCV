import { describe, expect, it } from 'vitest';
import { laneCore, multicycleCpu, pipelinedCpu, singleCycleCpu, systemCpu, warpCore } from '../src/lib';
import { assemble } from '../src/riscv/asm';
import { disasm } from '../src/riscv/isa';
import { SIMT_PROGRAMS } from '../src/riscv/simtprograms';
import { WARP_DMEM_K, WARP_PROGRAMS, WARP_SMEM_K } from '../src/riscv/warpprograms';
import { netlistOf } from '../src/sim/types';
import { innerUse, instrUse, laneUse, litOf, namesIn, oooUse, STAGE_UNITS, stageUse } from '../src/widgets/insthw';
import { oooCpu } from '../src/lib/ooocore';
import { CUSTOM_PRESETS } from '../src/riscv/custom';

// The program-listing highlight names top-level instances: keep the tables in step with the CPUs.
const names = (d: ReturnType<typeof singleCycleCpu>) => new Set(netlistOf(d)!.instances.map((i) => i.name));
const prog = assemble('addi t0, zero, 1\nadd t1, t0, t0\nlw t2, 0(zero)\nsw t2, 4(zero)\nbeq t0, t1, 0\njal ra, 4\njalr zero, 0(ra)\nlui a0, 1\nauipc a1, 0').words;

describe('instruction → hardware map', () => {
  it('a custom row lights what its signals use, and every unit exists on both CPUs', () => {
    const rows = [CUSTOM_PRESETS[0], CUSTOM_PRESETS[2], CUSTOM_PRESETS[3]];
    const w = assemble('lwx a0, a1, a2\nsubi a0, a1, 3\nswx a0, a1, a2', rows).words;
    const have = new Set([...names(singleCycleCpu(w, { custom: rows })), ...names(pipelinedCpu(w, { custom: rows }))]);
    const [lwx, subi, swx] = w.map((x) => instrUse(x, rows).units);
    expect(lwx).toEqual(expect.arrayContaining(['rf', 'alu', 'dm', 'res']));
    expect(subi).not.toContain('dm');
    expect(subi).toEqual(expect.arrayContaining(['imm', 'alu', 'res']));
    expect(swx).toEqual(expect.arrayContaining(['dm', 'st']));
    expect(swx).not.toContain('res');
    const fetch = new Set(instrUse(0).units); // the fetch names cover the multicycle CPU too
    for (const u of [lwx, subi, swx]) expect(u.filter((n) => !have.has(n) && !fetch.has(n) && !['ld', 'ldsel', 'st'].includes(n))).toEqual([]);
    expect(instrUse(w[0]).units).not.toContain('dm'); // without the rows the word is unknown
  });

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

describe('instruction → the parts inside the boxes (the zoom lens, track 2c)', () => {
  // every RV32I instruction, each class and each ALU / branch operation, with registers read and written
  const ALL = assemble([
    'add x5, x6, x7', 'sub x5, x6, x7', 'sll x5, x6, x7', 'slt x5, x6, x7', 'sltu x5, x6, x7', 'xor x5, x6, x7', 'srl x5, x6, x7', 'sra x5, x6, x7', 'or x5, x6, x7', 'and x5, x6, x7',
    'addi x8, x9, 3', 'slti x8, x9, 3', 'sltiu x8, x9, 3', 'xori x8, x9, 3', 'ori x8, x9, 3', 'andi x8, x9, 3', 'slli x8, x9, 3', 'srli x8, x9, 3', 'srai x8, x9, 3',
    'lw x10, 4(x11)', 'lb x10, 4(x11)', 'lhu x10, 4(x11)', 'sw x12, 8(x13)', 'sb x12, 8(x13)',
    'beq x1, x2, 0', 'bne x1, x2, 0', 'blt x1, x2, 0', 'bge x1, x2, 0', 'bltu x1, x2, 0', 'bgeu x1, x2, 0',
    'jal x1, 4', 'jalr x0, 0(x1)', 'lui x14, 1', 'auipc x15, 0', 'addi x0, x0, 0',
  ].join('\n')).words;
  const top = (n: string) => n.slice(0, n.indexOf('.'));

  it('names a part inside every class, and each one exists where its box does, on the single-cycle and the pipelined CPU', () => {
    for (const cpu of [singleCycleCpu(prog), pipelinedCpu(prog, {})]) {
      const have = names(cpu);
      for (const w of ALL) {
        const inner = innerUse(w);
        expect(inner.length, disasm(w, 0)).toBeGreaterThan(2);
        const here = inner.filter((n) => have.has(top(n)));
        expect(namesIn(cpu, here), `${cpu.id}: ${disasm(w, 0)}`).toEqual(here);
        // the boxes they sit in are lit too
        for (const n of here) expect(instrUse(w).units, disasm(w, 0)).toContain(top(n));
      }
    }
  });

  it('on the other variants a name either exists or is one the lens drops (it lights only parts its box has)', () => {
    const variants = [systemCpu(prog), multicycleCpu(prog, {}), pipelinedCpu(prog, { adder: 'ks', m: true })];
    for (const cpu of variants) {
      const have = names(cpu);
      const miss = new Set<string>();
      for (const w of ALL) {
        const here = innerUse(w).filter((n) => have.has(top(n)));
        const ok = new Set(namesIn(cpu, here));
        here.filter((n) => !ok.has(n)).forEach((n) => miss.add(n));
      }
      // the system CPU's data memory is the MMIO unit, no `ram` inside: its loads and stores glow the rim
      expect([...miss], cpu.id).toEqual(cpu === variants[0] ? ['dm.ram'] : []);
    }
  });

  it('picks the ALU part, the branch condition, the immediate box and the registers by the instruction', () => {
    const at = (src: string) => innerUse(assemble(src).words[0]);
    expect(at('add x5, x6, x7')).toEqual(expect.arrayContaining(['alu.add', 'alu.mux', 'rf.rp1', 'rf.w6', 'rf.rp2', 'rf.w7', 'rf.dec', 'rf.w5', 'ctl.aludec']));
    expect(at('xor x5, x6, x7')).toContain('alu.xor');
    expect(at('xor x5, x6, x7')).not.toContain('alu.add');
    expect(at('sra x5, x6, x7')).toEqual(expect.arrayContaining(['alu.shift', 'alu.sb']));
    expect(at('sltu x5, x6, x7')).toEqual(expect.arrayContaining(['alu.add', 'alu.sltu', 'alu.zsltu']));
    expect(at('lw x10, 4(x11)')).toEqual(expect.arrayContaining(['imm.i', 'alu.add', 'dm.ram', 'rf.w10', 'rf.w11']));
    expect(at('sw x12, 8(x13)')).toEqual(expect.arrayContaining(['imm.s', 'dm.ram', 'rf.rp2', 'rf.w12']));
    expect(at('sw x12, 8(x13)')).not.toContain('rf.dec');
    expect(at('beq x1, x2, 0')).toEqual(expect.arrayContaining(['imm.b', 'alu.zero', 'npc.cond', 'npc.take']));
    expect(at('bne x1, x2, 0')).toContain('npc.nz');
    expect(at('bge x1, x2, 0')).toEqual(expect.arrayContaining(['npc.lt', 'npc.ge']));
    expect(at('bltu x1, x2, 0')).toContain('npc.nc');
    expect(at('jal x1, 4')).toEqual(expect.arrayContaining(['imm.j', 'npc.src0', 'rf.w1']));
    expect(at('lui x14, 1')).toEqual(expect.arrayContaining(['imm.u', 'rf.w14']));
    expect(at('lui x14, 1').some((n) => n.startsWith('alu.'))).toBe(false);
    expect(at('addi x0, x0, 0')).toContain('rf.x0');
    expect(at('addi x0, x0, 0')).not.toContain('rf.dec');
    // M, custom, vector and unknown words name nothing inside: the lens lights the rim alone
    expect(innerUse(assemble('mul x5, x6, x7').words[0])).toEqual([]);
    expect(innerUse(0)).toEqual([]);
  });

  it('a click lights the boxes and the parts; the pipeline lights what each stage does', () => {
    const use = instrUse(assemble('add x5, x6, x7').words[0]);
    expect(litOf(use)).toEqual(expect.arrayContaining(['alu', 'alu.add', 'rf', 'rf.w5']));
    const d = stageUse('D', use), e = stageUse('E', use), w = stageUse('W', use);
    expect(d).toEqual(expect.arrayContaining(['rf.rp1', 'rf.w6', 'rf.rp2', 'rf.w7']));
    expect(d).not.toContain('rf.w5');
    expect(d).not.toContain('alu.add');
    expect(e).toContain('alu.add');
    expect(w).toEqual(expect.arrayContaining(['rf.dec', 'rf.w5']));
    expect(w).not.toContain('rf.w6');
    // a register read and written lights in both
    const same = instrUse(assemble('addi x5, x5, 1').words[0]);
    expect(stageUse('D', same)).toContain('rf.w5');
    expect(stageUse('W', same)).toContain('rf.w5');
  });
});
