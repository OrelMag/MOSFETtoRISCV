// The pipelined RV32IC core (pipelinedCpu({ c }); the sandbox's rv32ic_pipe_core): F fetches the 32 bits at any even address and
// expands a 16-bit instruction before it enters D, the PC goes up by 2 after one, and PC + 2 travels on as the link value. Checked:
// the part resolves with the plain pipelined core's pins (and `illegal`), detection and lint treat it as a C core, and programs with
// compressed instructions (a taken compressed branch, a load-use on c.lw, c.jal's link, a 32-bit instruction straddling two words,
// random programs with .option rvc) run in lock step with ISS({ c }): the retiring PC and every register after each retirement,
// the data memory at the end. tests/verify-pipe-c.test.ts runs riscv-tests and fuzzing on the CPU with the program inside.

import { describe, expect, it } from 'vitest';
import '../src/lib';
import { CpuMonitor } from '../src/editor/cpu';
import { Sheet } from '../src/editor/example6502';
import { C_RAM_K, RVC_SOURCE, RVC_TEXT } from '../src/editor/exampleisa';
import { consoleText, type ConsoleState, ioNodes, ioState } from '../src/editor/ioparts';
import { UserLibrary } from '../src/editor/library';
import { isaMismatch } from '../src/editor/lint';
import { emptyWorkspace, type PartRef, portCoreOf, portCoreRef } from '../src/editor/model';
import { EditorSim } from '../src/editor/runtime';
import { dataMemory } from '../src/lib/cpu';
import { pipelinedCpu } from '../src/lib/pipeline';
import { resolveComponent } from '../src/lib/resolve';
import { cWindowRom } from '../src/lib/rvc';
import { assemble } from '../src/riscv/asm';
import { clockCycle, cpuState, dmemWords, retireCount, retirePc } from '../src/riscv/cosim';
import { ISS } from '../src/riscv/iss';
import { randomProgram32 } from '../src/riscv/randprog32';
import { flatten } from '../src/sim/flatten';
import { GateSim } from '../src/sim/gatesim';
import type { ComponentDef } from '../src/sim/types';
import { breathe } from './setup';

const bit = (name: string, dir: 'in' | 'out') => ({ name, width: 1, dir });

describe('rv32ic_pipe_core: the library part', () => {
  it('resolves by id with the plain pipelined core\'s pins and an illegal output', () => {
    const d = resolveComponent('rv32ic_pipe_core')!;
    expect(d.id).toBe('rv32ic_pipe_core');
    for (const p of resolveComponent('rv32i_pipe_core')!.ports) expect(d.ports.find((q) => q.name === p.name && q.dir === p.dir), p.name).toBeDefined();
    expect(d.ports.find((p) => p.name === 'illegal')?.dir).toBe('out');
    expect(resolveComponent('rv32imc_pipe_core')!.id).toBe('rv32imc_pipe_core');
    expect(resolveComponent('rv32ic_pipe_dc_core')!.id).toBe('rv32ic_pipe_dc_core');
  });

  it('reads and writes its ref: C kept through a variant change, never with custom rows', () => {
    expect(portCoreOf({ lib: 'rv32ic_pipe_core' })).toMatchObject({ pipe: true, m: false, c: true, dcache: false });
    expect(portCoreOf({ lib: 'rv32ic_pipe_dc_core' })).toMatchObject({ pipe: true, m: false, c: true, dcache: true });
    // M and the data cache never together (pipelinedCpu refuses the pair): neither id is a part
    expect(portCoreOf({ lib: 'rv32imc_pipe_dc_core' })).toBeNull();
    expect(resolveComponent('rv32imc_pipe_dc_core')).toBeUndefined();
    expect(resolveComponent('rv32im_pipe_dc_core')).toBeUndefined();
    expect(portCoreOf({ lib: 'rv32i_pipe_core' })).toMatchObject({ c: false });
    expect(portCoreRef({ pipe: true, m: true, c: true, custom: [] })).toEqual({ lib: 'rv32imc_pipe_core' });
    expect(portCoreRef({ pipe: false, c: true, custom: [] })).toEqual({ lib: 'rv32i_core' }); // the single-cycle C core is rv32ic_core, not a port-core variant
  });

  it('lint: a plain ROM beside it is a mismatch, a C ROM is not', () => {
    const rom = (extra: object): PartRef => ({ rom: { k: 5, w: 32, addr: 'rv32', lang: 'asm', src: 'nop', ...extra } } as PartRef);
    const doc = (r: PartRef) => ({ id: 'u', name: 'u', pins: [], labels: [], wires: [],
      parts: [{ id: 'imem', ref: r, at: [0, 0] as [number, number] }, { id: 'cpu', ref: { lib: 'rv32ic_pipe_core' } as PartRef, at: [10, 0] as [number, number] }] });
    expect(isaMismatch(doc(rom({ c: true })))).toEqual([]);
    expect(isaMismatch(doc(rom({})))[0].msg).toMatch(/plain ROM/);
  });
});

describe('rv32ic_pipe_core with a window ROM and a data memory on its ports', () => {
  type Variant = { m?: boolean; dcache?: boolean };
  const harness = (words: number[], imemK: number, dmemK: number, v: Variant = {}): ComponentDef => ({
    id: `t_pipe_c_${words.length}_${dmemK}${v.m ? '_m' : ''}${v.dcache ? '_dc' : ''}`, name: 'harness', category: 'custom', symbol: { kind: 'box' },
    ports: [bit('clk', 'in')],
    netlist: () => ({
      instances: [{ name: 'core', def: pipelinedCpu([], { adder: 'ks', ports: true, c: true, ...(v.m ? { m: true } : {}), ...(v.dcache ? { dcache: 'wt' as const } : {}) }) }, { name: 'imem', def: cWindowRom(words, imemK) }, { name: 'dm', def: dataMemory(dmemK) }],
      nets: [
        { ends: ['clk', 'core.clk', 'dm.clk'] }, { ends: ['core.pcOut', 'imem.addr'] }, { ends: ['imem.data', 'core.instr'] },
        { ends: ['core.memAddr', 'dm.addr'] }, { ends: ['core.memWData', 'dm.wd'] }, { ends: ['core.memWE', 'dm.we'] }, { ends: ['dm.rd', 'core.memRData'] },
      ],
    }),
  });

  async function lockStep(src: string, dmemK = 5, cap = 4000, v: Variant = {}) {
    const asm = assemble(src);
    expect(asm.errors).toEqual([]);
    const imemK = Math.max(6, Math.ceil(Math.log2(asm.words.length)));
    const sim = new GateSim(flatten(harness(asm.words, imemK, dmemK, v)));
    sim.setInput('clk', 0);
    sim.settle();
    const core = sim.design.root.children!.get('core')!;
    const iss = new ISS(asm.words, { c: true, ...(v.m ? { m: true } : {}), dmemWords: 2 ** dmemK, imemWords: 2 ** imemK });
    let cyc = 0, half = 0;
    for (; cyc < cap && !iss.halted; cyc++) {
      const ret = retireCount(sim, core);
      if (ret) {
        expect(retirePc(sim, core), `cycle ${cyc}: retiring pc`).toBe(iss.pc);
        if (iss.pc % 4 === 2) half++;
      }
      clockCycle(sim);
      if (!ret) continue;
      iss.step();
      expect(cpuState(sim, core).x, `cycle ${cyc} after ${iss.steps} instructions`).toEqual([...iss.x].map((v) => v >>> 0));
      if (cyc % 64 === 0) await breathe();
    }
    expect(iss.halted).toBe(true);
    for (let k = 0; k < 12; k++) clockCycle(sim);
    expect(dmemWords(sim, sim.design.root.children!.get('dm')!)).toEqual([...iss.dmem].map((v) => v >>> 0));
    return { asm, cycles: cyc, retired: iss.steps, half };
  }

  const DIRECTED = `
        .option rvc
        li   a0, 5              # c.li
        li   a1, 0
        li   s0, 0
loop:   add  a1, a1, a0         # c.add
        addi a0, a0, -1         # c.addi
        bnez a0, loop           # c.bnez, taken four times: a flush behind each
        sw   a1, 4(s0)          # c.sw
        lw   a2, 4(s0)          # c.lw ...
        add  a3, a2, a2         # ... used at once: the load-use stall
        jal  ra, f              # c.jal: the link is PC + 2
        .option norvc
        addi a4, ra, 0          # a 32-bit instruction after a 16-bit one: it straddles two words
        .option rvc
        mv   a5, a4             # c.mv
        sw   a5, 8(s0)
        sw   a3, 12(s0)
h:      j    h
f:      addi a3, a3, 1
        ret                     # c.jr ra
`;

  it('compressed branches, a load-use, c.jal / c.jr and a straddling 32-bit instruction, in lock step', async () => {
    const r = await lockStep(DIRECTED);
    expect(r.asm.lines.filter((l) => l.size === 2).length).toBeGreaterThan(10);
    expect(r.asm.lines.some((l) => l.size !== 2 && l.addr % 4 === 2)).toBe(true); // the straddling one
    expect(r.half).toBeGreaterThan(5); // instructions retired at halfword addresses
    expect(r.cycles).toBeGreaterThan(r.retired + 4); // the stall and the flushes cost cycles
  }, 120_000);

  it.each([1, 2, 3, 4].map((s) => [s] as const))('random program %i with .option rvc ends in the golden model\'s state', async (seed) => {
    await lockStep(randomProgram32(seed + 40, { n: 50, c: true }));
  }, 120_000);

  // the variants the sandbox's Variant select offers with C: a divide stalls F / D / E, a multiply is a load to the hazard unit,
  // and a data-cache miss freezes every stage, each with 2-byte PC steps
  it('rv32imc_pipe_core: the directed program and random RV32IMC programs in lock step', async () => {
    await lockStep(DIRECTED, 5, 4000, { m: true });
    for (const seed of [1, 2]) await lockStep(randomProgram32(seed + 60, { n: 50, c: true, m: true }), 5, 4000, { m: true });
  }, 240_000);

  it('rv32ic_pipe_dc_core: the directed program and random programs in lock step through the data cache', async () => {
    const r = await lockStep(DIRECTED, 5, 4000, { dcache: true });
    expect(r.half).toBeGreaterThan(5);
    for (const seed of [1, 2]) await lockStep(randomProgram32(seed + 80, { n: 50, c: true }), 5, 4000, { dcache: true });
  }, 240_000);
});

describe('in the sandbox: the C computer on the pipelined core', () => {
  // Examples ▸ RV32C with rv32ic_pipe_core in place of rv32ic_core (no halt detector: the pipelined core has no instrOut)
  function pipeRvcChip(id: string): ReturnType<Sheet['doc']> {
    const s = new Sheet();
    s.pin('clk', 'in', [2, 2], 1, { kind: 'clock' });
    s.tap('pin:clk', 'clk');
    s.part('imem', { rom: { k: 6, w: 32, addr: 'rv32', lang: 'asm', src: RVC_SOURCE, c: true } }, [6, 5], { label: 'program (C)' });
    s.tap('imem.addr', 'pc'); s.tap('imem.data', 'window');
    s.part('cpu', { lib: 'rv32ic_pipe_core' }, [30, 6], { label: 'RV32IC pipelined core' });
    s.tap('cpu.clk', 'clk'); s.tap('cpu.instr', 'window'); s.tap('cpu.memRData', 'rdata'); s.tap('cpu.pcOut', 'pc');
    s.tap('cpu.memAddr', 'addr'); s.tap('cpu.memWData', 'wdata'); s.tap('cpu.memWE', 'we');
    s.part('as', { split: [2, C_RAM_K, 31 - 2 - C_RAM_K, 1] }, [60, 4]);
    s.tap('as.in', 'addr'); s.tap('as.o1', 'aw'); s.tap('as.o3', 'a31');
    s.part('bs', { split: [8, 24] }, [60, 14]);
    s.tap('bs.in', 'wdata'); s.tap('bs.o0', 'byte');
    s.part('n31', { lib: 'not' }, [72, 4]);
    s.part('ramst', { lib: 'and' }, [78, 4]);
    s.tap('n31.a', 'a31'); s.wire('n31.y', 'ramst.a'); s.tap('ramst.b', 'we'); s.tap('ramst.y', 'ramWe');
    s.part('cwe', { lib: 'and' }, [78, 12]);
    s.tap('cwe.a', 'a31'); s.tap('cwe.b', 'we'); s.tap('cwe.y', 'conWe');
    s.part('ram', { ram: { k: C_RAM_K, w: 32 } }, [92, 2]);
    s.tap('ram.addr', 'aw'); s.tap('ram.din', 'wdata'); s.tap('ram.we', 'ramWe'); s.tap('ram.clk', 'clk'); s.tap('ram.dout', 'rdata');
    s.part('con', { console: { cols: 32, rows: 8 } }, [92, 16]);
    s.tap('con.data', 'byte'); s.tap('con.we', 'conWe'); s.tap('con.clk', 'clk');
    return s.doc(id, 'pipelined RV32C', {});
  }

  it('the CPU drawer finds a C pipeline and runs it in lock step with ISS({ c }) to the console text', async () => {
    const ws = emptyWorkspace();
    ws.chips.u_pc = pipeRvcChip('u_pc');
    const lib = new UserLibrary(ws);
    const c = lib.compiled('u_pc')!;
    expect(c.diags).toEqual([]);
    const es = new EditorSim({ debounceMs: 0 });
    es.update(c, ws.chips.u_pc.pins);
    const mon = new CpuMonitor(es, () => ws.chips.u_pc);
    expect(mon.desc?.iss.c).toBe(true);
    expect(mon.desc?.pipeline).toBe(true);
    expect(mon.problem).toBe(null);
    while (es.cycles < 900) { es.runCycles(300, () => false, 1e9); await breathe(); }
    expect(mon.mismatch).toBeNull();
    expect(mon.retired).toBeGreaterThan(30);
    const node = ioNodes(es.sim!.design.root).find((x) => x.info.kind === 'console')!.node;
    expect(consoleText(ioState(es.sim!, node) as ConsoleState)).toBe(RVC_TEXT);
  }, 120_000);
});
