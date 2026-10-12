// Level 11: a dual-core processor. Two copies of one core (the same ComponentDef, instantiated
// twice: hierarchy is reuse) run the same program; csrr mhartid tells them apart. They share one
// data memory through a round-robin arbiter, so every memory access is serialized: sequential
// consistency for free, and atomic read-modify-write operations are simply single accesses.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, orN } from './alu';
import { bigRam, kWords } from './bigmem';
import { encoder } from './coding';
import { busMux2, muxTree } from './combinational';
import { dataMemory, singleCycleCpu } from './cpu';
import { define, merger, splitter } from './define';
import { OR } from './gates';
import { ARBITER2, arbiterN } from './mpdecode';

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

/**
 * The shared data memory: dataMemory(k) up to 64 words, else a 2^k-word large RAM (k ≤ 16, one
 * behavioural leaf at run time over its banks of banks) behind the same ports.
 */
export function sharedMemory(k: number): ComponentDef {
  if (k <= 6) return dataMemory(k);
  const key = `bigdmem${k}`;
  let d = cache.get(key);
  if (d) return d;
  const R = bigRam(k, 32), rg = symbolGeom(R);
  d = define({
    id: key, name: 'Data memory', category: 'memory',
    summary: `${kWords(2 ** k)} words (${kWords(4 * 2 ** k)} bytes): a large RAM of banks of banks, down to 64-word banks of flip-flops; address bits [${k + 1}:2] select the word.`,
    ports: [bus('addr', 32, 'in'), bus('wd', 32, 'in'), bit('we', 'in'), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, bus('rd', 32, 'out')],
    symbol: { kind: 'box', label: 'DATA MEM' },
    netlist: () => ({
      pins: { addr: [0, 3], wd: [0, 3 + rg.ports.din.pos[1]], we: [0, 3 + rg.ports.we.pos[1]], clk: [0, 3 + rg.h + 3], rd: [14 + rg.w + 5, 3 + rg.ports.dout.pos[1]] },
      instances: [
        { name: 'sa', def: splitter([2, k, 30 - k]), at: [4, 3 + rg.ports.addr.pos[1] - 3] },
        { name: 'ram', def: R, at: [14, 3] },
      ],
      nets: [
        { name: 'addr', ends: ['addr', 'sa.in'] },
        { name: 'index', ends: ['sa.o1', 'ram.addr'] },
        { name: 'wd', ends: ['wd', 'ram.din'] },
        { name: 'we', ends: ['we', 'ram.we'] },
        { name: 'clk', ends: ['clk', 'ram.clk'] },
        { name: 'rd', ends: ['ram.dout', 'rd'] },
      ],
    }),
  });
  cache.set(key, d);
  return d;
}

/**
 * n cores (n = 2, 4 or 8) of the dual-core's kind on one shared memory of 2^dmemK words: the
 * n-way round-robin arbiter grants the port, an encoder turns its one-hot grant into the select
 * of the address and write-data multiplexers. The golden model is MultiISS(program, n, …), which
 * arbitrates the same way. (dualCore stays as drawn in the chapter, with ARBITER2.)
 */
export function multiCore(program: number[], n = 4, opts: { dmemK?: number; imemK?: number } = {}): ComponentDef {
  if (n !== 2 && n !== 4 && n !== 8) throw new Error('multiCore: 2, 4 or 8 cores');
  const dmemK = opts.dmemK ?? 5, imemK = opts.imemK ?? 6;
  if (!Number.isInteger(dmemK) || dmemK < 2 || dmemK > 16) throw new Error('multiCore: dmemK must be 2–16');
  // dmemK does not reach a shared core (its memory is outside): one core definition for every size
  const CORE = singleCycleCpu(program, { shared: true, adder: 'ks', imemK });
  const key = `mc${n}_${CORE.id}_d${dmemK}`;
  let d = cache.get(key);
  if (d) return d;
  const k = Math.round(Math.log2(n)), I = Array.from({ length: n }, (_, i) => i);
  const cg = symbolGeom(CORE), A = arbiterN(n), ag = symbolGeom(A), ENC = encoder(n), eg = symbolGeom(ENC);
  const GM = merger(I.map(() => 1)), gmg = symbolGeom(GM);
  const MX = muxTree(k, 32), mg = symbolGeom(MX), WE = orN(n), wg = symbolGeom(WE), DM = sharedMemory(dmemK), dg = symbolGeom(DM);
  const xC = 20, y0 = 4, yCore = (i: number) => y0 + i * (cg.h + 16);
  const mid = (yCore(n - 1) + cg.h + y0) / 2;
  const xA = xC + cg.w + 24, yA = mid - ag.h / 2, yG = yA + ag.h + 8;
  const xM = xA + Math.max(ag.w, gmg.w + 8 + eg.w) + 16;
  const yAm = mid - mg.h - 6, yWm = mid + 6, yWe = yWm + mg.h + 8;
  const xD = xM + Math.max(mg.w, wg.w) + 16, xP = xD + dg.w + 12;
  const out = (j: number): [number, number] => [xP, y0 + 4 + 4 * j];
  const pins: Record<string, [number, number]> = { clk: [0, mid] };
  I.forEach((i) => { pins[`pc${i}`] = out(i); pins[`retire${i}`] = out(n + i); pins[`grant${i}`] = out(2 * n + i); });
  const t = true as const;
  d = {
    id: key, name: `${n}-core RV32I (shared memory)`, category: 'cpu',
    summary: `${n} identical cores, one data memory of ${kWords(2 ** dmemK)} words. A round-robin arbiter grants the memory port to one core per cycle; the others stall. Each core reads its hart id (0 … ${n - 1}) with csrr mhartid; amoswap.w and amoadd.w are single, indivisible accesses.`,
    ports: [bit('clk', 'in', true), ...I.map((i) => bus(`pc${i}`, 32, 'out')), ...I.map((i) => bit(`retire${i}`, 'out')), ...I.map((i) => bit(`grant${i}`, 'out'))],
    symbol: { kind: 'box', label: `${n} × RV32I` },
    netlist: () => ({
      pins,
      instances: [
        ...I.flatMap((i) => [
          { name: `h${i}`, def: constWord(32, i), at: [4, yCore(i) + 4] as [number, number], label: `hart ${i}` },
          { name: `core${i}`, def: CORE, at: [xC, yCore(i)] as [number, number], label: `core ${i}` },
        ]),
        { name: 'arb', def: A, at: [xA, yA], label: 'arbiter' },
        { name: 'gm', def: GM, at: [xA, yG] },
        { name: 'enc', def: ENC, at: [xA + gmg.w + 8, yG], label: 'who has the port' },
        { name: 'am', def: MX, at: [xM, yAm], label: 'address' },
        { name: 'wm', def: MX, at: [xM, yWm], label: 'write data' },
        { name: 'we', def: WE, at: [xM, yWe] },
        { name: 'dm', def: DM, at: [xD, mid - dg.h / 2], label: 'shared memory' },
      ],
      nets: [
        { name: 'clk', ends: ['clk', ...I.map((i) => `core${i}.clk`), 'arb.clk', 'dm.clk'], tags: t },
        ...I.flatMap((i) => [
          { name: `hart${i}`, ends: [`h${i}.y`, `core${i}.hartid`] },
          { name: `req${i}`, ends: [`core${i}.memReq`, `arb.r${i}`], tags: t },
          { name: `grant${i}`, ends: [`arb.g${i}`, `core${i}.grant`, `gm.i${i}`, `grant${i}`], tags: t },
          { name: `addr${i}`, ends: [`core${i}.memAddr`, `am.d${i}`], tags: t },
          { name: `wdata${i}`, ends: [`core${i}.memWData`, `wm.d${i}`], tags: t },
          { name: `we${i}`, ends: [`core${i}.memWE`, `we.i${i}`], tags: t },
          { name: `pc${i}`, ends: [`core${i}.pcOut`, `pc${i}`], tags: t },
          { name: `retire${i}`, ends: [`core${i}.retire`, `retire${i}`], tags: t },
        ]),
        { name: 'grants', ends: ['gm.out', 'enc.x'] },
        { name: 'sel', ends: ['enc.y', 'am.s', 'wm.s'], tags: t },
        { name: 'addr', ends: ['am.y', 'dm.addr'] }, { name: 'wdata', ends: ['wm.y', 'dm.wd'] }, { name: 'we', ends: ['we.y', 'dm.we'] },
        { name: 'rdata', ends: ['dm.rd', ...I.map((i) => `core${i}.memRData`)], tags: t },
      ],
    }),
  };
  cache.set(key, d);
  return d;
}
