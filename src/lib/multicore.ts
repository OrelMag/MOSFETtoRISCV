// Level 11: a dual-core processor. Two copies of one core (the same ComponentDef, instantiated
// twice: hierarchy is reuse) run the same program; csrr mhartid tells them apart. They share one
// data memory through a round-robin arbiter, so every memory access is serialized: sequential
// consistency for free, and atomic read-modify-write operations are simply single accesses.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { busMux2 } from './combinational';
import { dataMemory, singleCycleCpu } from './cpu';
import { OR } from './gates';
import { ARBITER2 } from './mpdecode';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, clock, side: clock ? 'left' : undefined });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

const cache = new Map<string, ComponentDef>();

export function dualCore(program: number[], dmemK = 5, imemPort = false, imemK = 6): ComponentDef {
  const CORE = singleCycleCpu(imemPort ? [] : program, { shared: true, adder: 'ks', dmemK, imemPort, imemK });
  const key = imemPort ? 'mosfet_riscv_dualcore' : `${CORE.id}_x2${dmemK === 5 ? '' : `_d${dmemK}`}`;
  let d = cache.get(key);
  if (d) return d;
  const cg = symbolGeom(CORE), DM = dataMemory(dmemK), dg = symbolGeom(DM), M2 = busMux2(32);
  const xC = 20, xA = xC + cg.w + 24, xM = xA + 30, xD = xM + 14;
  const y0 = 4, y1 = y0 + cg.h + 16;
  d = {
    id: key, name: 'Dual-core RV32I (shared memory)', category: 'cpu',
    summary: 'Two identical cores, one data memory. The arbiter grants the memory port to one core per cycle; the other stalls. Each core reads its hart id (0 or 1) with csrr mhartid; amoswap.w and amoadd.w read and write memory in one indivisible access.',
    ports: [bit('clk', 'in', true), ...(imemPort ? [bus('instr0', 32, 'in'), bus('instr1', 32, 'in')] : []), bus('pc0', 32, 'out'), bus('pc1', 32, 'out'), bit('retire0', 'out'), bit('retire1', 'out'), bit('grant0', 'out'), bit('grant1', 'out')],
    symbol: { kind: 'box', label: '2 × RV32I' },
    netlist: () => ({
      pins: { clk: [0, y1 - 6], instr0: [0, y0 + 10], instr1: [0, y1 + 10], pc0: [xD + dg.w + 12, y0 + 4], pc1: [xD + dg.w + 12, y0 + 8], retire0: [xD + dg.w + 12, y0 + 12], retire1: [xD + dg.w + 12, y0 + 16], grant0: [xD + dg.w + 12, y0 + 20], grant1: [xD + dg.w + 12, y0 + 24] },
      instances: [
        { name: 'h0', def: constWord(32, 0), at: [4, y0 + 4], label: 'hart 0' },
        { name: 'h1', def: constWord(32, 1), at: [4, y1 + 4], label: 'hart 1' },
        { name: 'core0', def: CORE, at: [xC, y0], label: 'core 0' },
        { name: 'core1', def: CORE, at: [xC, y1], label: 'core 1' },
        { name: 'arb', def: ARBITER2, at: [xA, y0 + cg.h / 2 + 4], label: 'arbiter' },
        { name: 'am', def: M2, at: [xM, y0 + cg.h / 2 - 12], label: 'address' },
        { name: 'wm', def: M2, at: [xM, y0 + cg.h / 2 + 12], label: 'write data' },
        { name: 'we', def: OR, at: [xM, y0 + cg.h / 2 + 34] },
        { name: 'dm', def: DM, at: [xD, y0 + cg.h / 2 - 8], label: 'shared memory' },
      ],
      nets: [
        { name: 'clk', ends: ['clk', 'core0.clk', 'core1.clk', 'arb.clk', 'dm.clk'], tags: true },
        { name: 'hart0', ends: ['h0.y', 'core0.hartid'] }, { name: 'hart1', ends: ['h1.y', 'core1.hartid'] },
        { name: 'req0', ends: ['core0.memReq', 'arb.r0'], tags: true }, { name: 'req1', ends: ['core1.memReq', 'arb.r1'], tags: true },
        { name: 'grant0', ends: ['arb.g0', 'core0.grant', 'grant0'], tags: true }, { name: 'grant1', ends: ['arb.g1', 'core1.grant', 'am.s', 'wm.s', 'grant1'], tags: true },
        { name: 'addr0', ends: ['core0.memAddr', 'am.a'], tags: true }, { name: 'addr1', ends: ['core1.memAddr', 'am.b'], tags: true },
        { name: 'wdata0', ends: ['core0.memWData', 'wm.a'], tags: true }, { name: 'wdata1', ends: ['core1.memWData', 'wm.b'], tags: true },
        { name: 'we0', ends: ['core0.memWE', 'we.a'], tags: true }, { name: 'we1', ends: ['core1.memWE', 'we.b'], tags: true },
        { name: 'addr', ends: ['am.y', 'dm.addr'] }, { name: 'wdata', ends: ['wm.y', 'dm.wd'] }, { name: 'we', ends: ['we.y', 'dm.we'] },
        { name: 'rdata', ends: ['dm.rd', 'core0.memRData', 'core1.memRData'], tags: true },
        { name: 'pc0', ends: ['core0.pcOut', 'pc0'], tags: true }, { name: 'pc1', ends: ['core1.pcOut', 'pc1'], tags: true },
        { name: 'retire0', ends: ['core0.retire', 'retire0'], tags: true }, { name: 'retire1', ends: ['core1.retire', 'retire1'], tags: true },
        ...(imemPort ? [{ name: 'instr0', ends: ['instr0', 'core0.instr'], tags: true as const }, { name: 'instr1', ends: ['instr1', 'core1.instr'], tags: true as const }] : []),
      ],
    }),
  };
  cache.set(key, d);
  return d;
}
