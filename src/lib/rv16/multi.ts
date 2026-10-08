// Act 8's multicycle RV16 core and direct-mapped cache. The core runs each instruction over three
// or four short cycles under a one-hot state machine (fetch, execute, memory, write back), with
// registers that cut the single-cycle path: the instruction register and the ALU output. The cache
// sits between an address and a main memory the bench serves: eight one-word lines, write-through.

import type { ComponentDef, PortDef } from '../../sim/types';
import { alu, constWord } from '../alu';
import { Builder } from '../builder';
import { busMux2, equal, muxTree } from '../combinational';
import { define, merger, splitter } from '../define';
import { AND, NOT, OR } from '../gates';
import { ram } from '../memory';
import { DFF, register } from '../sequential';
import { TIE1 } from '../transistors';
import { BRANCH16, CORE_PORTS, CTL16, IMM16, NEXTPC16 } from './cpu';
import { RF8 } from './logic';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

/**
 * The multicycle core: F loads the instruction register, E computes into the ALU register, M (loads
 * and stores only) reads or writes memory, W writes the register file and the PC. Everything between
 * F and W is combinational from the instruction register and the (unchanged) registers.
 */
export const RV16_MULTI: ComponentDef = (() => {
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'rst', 'instr', 'drdata');
  const one = b.op1(TIE1, []);
  const sF = b.op(DFF, ['', 'clk'], 'fetch'), sE = b.op(DFF, ['', 'clk'], 'execute');
  const sM = b.op(DFF, ['', 'clk'], 'memory'), sW = b.op(DFF, ['', 'clk'], 'write back');
  const F = b.name(`${sF}.q`, 'F', true), E = b.name(`${sE}.q`, 'E', true), M = b.name(`${sM}.q`, 'M', true), W = b.name(`${sW}.q`, 'W', true);
  b.next();
  const ir = b.name(`${b.op(register(16), ['instr', F, 'clk'], 'instruction register')}.q`, 'ir', true);
  b.next();
  const f = b.op(splitter([2, 2, 3, 3, 3, 3], 4), [ir], 'fields');
  const cond = b.name(`${f}.o0`, 'cond', true), rd = b.name(`${f}.o2`, 'rd', true);
  const ctl = b.op(CTL16, [ir], 'control');
  const imm = b.op(IMM16, [ir], 'immediates');
  b.next();
  const immv = b.name(b.op1(muxTree(2, 16), [`${imm}.i`, `${imm}.sb`, `${imm}.j`, `${imm}.u`, `${ctl}.isel`], 'imm'), 'imm', true);
  const rwe = b.name(b.op1(AND, [`${ctl}.rwe`, W], 'write in W'), 'rwe', true);
  const rf = b.op(RF8, [rd, rwe, '', `${f}.o3`, `${f}.o4`, 'clk'], 'registers');
  const r1 = b.name(`${rf}.rd1`, 'r1', true), r2 = b.name(`${rf}.rd2`, 'r2', true);
  b.next();
  const bsrc = b.op1(busMux2(16), [r2, immv, `${ctl}.bimm`], 'ALU b');
  const take = b.op1(BRANCH16, [r1, r2, cond], 'branch?');
  b.next();
  const y = b.op1(alu(16), [r1, bsrc, `${ctl}.alu`], 'ALU');
  const np = b.op(NEXTPC16, ['', immv, r1, `${ctl}.br`, take, `${ctl}.jal`, `${ctl}.jalr`], 'next PC');
  b.next();
  const yq = b.name(`${b.op(register(16), [y, one, 'clk'], 'ALU register')}.q`, 'aluq', true);
  const nx = b.op1(busMux2(16), [`${np}.pc1`, `${np}.target`, `${np}.ld`], 'next');
  // Loads and stores visit M: wb = 01 or mwe.
  const wbs = b.op(splitter([1, 1], 2), [`${ctl}.wb`]);
  b.next();
  const isLoad = b.op1(AND, [`${wbs}.o0`, b.op1(NOT, [`${wbs}.o1`])], 'load?');
  const pcd = b.op1(busMux2(16), [nx, b.op1(constWord(16, 0), []), 'rst'], 'reset');
  b.next();
  const isMem = b.name(b.op1(OR, [isLoad, `${ctl}.mwe`], 'memory?'), 'mem', true);
  const pc = b.name(`${b.op(register(16), [pcd, b.op1(OR, [W, 'rst'], 'pc en'), 'clk'], 'PC')}.q`, 'pc', true);
  b.wire(pc, `${np}.pc`);
  b.next();
  const wbv = b.name(b.op1(muxTree(2, 16), [yq, 'drdata', `${np}.pc1`, immv, `${ctl}.wb`], 'result'), 'wbv', true);
  b.wire(wbv, `${rf}.wd`);
  // The state machine, one-hot: F → E → (M →) W → F; reset → F.
  const nrst = b.op1(NOT, ['rst']);
  const eNoMem = b.op1(AND, [E, b.op1(NOT, [isMem])]);
  b.next();
  b.wire(b.op1(OR, ['rst', W], '→ F'), `${sF}.d`);
  b.wire(b.op1(AND, [nrst, F], '→ E'), `${sE}.d`);
  b.wire(b.op1(AND, [nrst, b.op1(AND, [E, isMem])], '→ M'), `${sM}.d`);
  b.wire(b.op1(AND, [nrst, b.op1(OR, [M, eNoMem])], '→ W'), `${sW}.d`);
  b.wire(pc, 'pc');
  b.wire(yq, 'daddr');
  b.wire(r2, 'dwdata');
  b.wire(b.op1(AND, [`${ctl}.mwe`, M], 'store in M'), 'dwe');
  b.wire(rwe, 'rwe');
  b.wire(rd, 'rwa');
  b.wire(wbv, 'rwd');
  const R = b.right;
  return define({
    id: 'rv16_mc', name: 'RV16 multicycle core', category: 'cpu',
    summary: 'Each instruction over 3 cycles (4 for loads and stores): F loads the instruction register, E the ALU register, M reads or writes memory, W writes the register file and the PC. A one-hot state machine steps through them. Shorter clock period, more cycles.',
    ports: CORE_PORTS,
    symbol: { kind: 'box', label: 'RV16 MC' },
    netlist: () => ({
      pins: { ...pinsAt(['clk', 'rst', 'instr', 'drdata'], 0, 4), ...pinsAt(['pc', 'daddr', 'dwdata', 'dwe', 'rwe', 'rwa', 'rwd'], R, 4) },
      instances: b.instances, nets: b.nets(),
    }),
  });
})();

/** The cache's geometry: an 8-bit address, eight one-word lines, a 5-bit tag. */
export const CACHE_LINES = 8;

/**
 * A direct-mapped cache, write-through with allocate on write: index = addr[2:0], tag = addr[7:3].
 * hit = the line is valid and its tag matches. A read hit answers from the line; a read miss answers
 * with mdata (the main memory, served by the bench) and fills the line at the clock edge; a write
 * fills the line with wdata (the bench writes the memory too).
 */
export const RV16_CACHE: ComponentDef = (() => {
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'addr', 'rd', 'wr', 'wdata', 'mdata');
  const a = b.op(splitter([3, 5], 4), ['addr'], 'index, tag');
  const idx = b.name(`${a}.o0`, 'index', true), tag = b.name(`${a}.o1`, 'tag', true);
  const one = b.op1(constWord(1, 1), []);
  b.next();
  const tags = b.op(ram(3, 6), [idx, b.op1(merger([5, 1], 2), [tag, one], 'tag, valid'), '', 'clk'], 'tags');
  const data = b.op(ram(3, 16), [idx, '', '', 'clk'], 'data');
  b.next();
  const ts = b.op(splitter([5, 1], 2), [`${tags}.dout`], 'tag, valid');
  b.next();
  const eq = b.op(equal(5), [`${ts}.o0`, tag], 'tag match');
  b.next();
  const hit = b.name(b.op1(AND, [`${eq}.eq`, `${ts}.o1`], 'hit'), 'hit', true);
  b.next();
  const fill = b.op1(AND, ['rd', b.op1(NOT, [hit])], 'read miss');
  b.wire(b.op1(busMux2(16), ['mdata', `${data}.dout`, hit], 'line or memory'), 'rdata');
  b.next();
  const we = b.op1(OR, ['wr', fill], 'fill');
  b.wire(b.op1(busMux2(16), ['mdata', 'wdata', 'wr'], 'line in'), `${data}.din`);
  b.wire(we, `${tags}.we`);
  b.wire(we, `${data}.we`);
  b.wire(hit, 'hit');
  const R = b.right;
  return define({
    id: 'rv16_cache', name: 'Direct-mapped cache (8 lines)', category: 'memory',
    summary: 'index = addr[2:0] picks one of eight lines; hit = valid and tag = addr[7:3]. A read miss fills the line from main memory (mdata), a write fills it with wdata (write-through: the memory is written too, outside). 8 × (16 + 5 + 1) bits of storage.',
    ports: [{ name: 'clk', width: 1, dir: 'in', clock: true }, bus('addr', 8, 'in'), bit('rd', 'in'), bit('wr', 'in'), bus('wdata', 16, 'in'), bus('mdata', 16, 'in'), bus('rdata', 16, 'out'), bit('hit', 'out')],
    symbol: { kind: 'box', label: 'CACHE' },
    netlist: () => ({ pins: { ...pinsAt(['clk', 'addr', 'rd', 'wr', 'wdata', 'mdata'], 0, 4), rdata: [R, 4], hit: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();
