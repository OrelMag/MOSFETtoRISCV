// The campaign's act 6 blocks: the pipeline register (hold for a stall, clear for a bubble), the
// forwarding unit, the load-use hazard unit, and the five-stage RV16 pipeline built from them and
// from the single-cycle core's blocks. Options add forwarding, the load-use stall and the branch
// flush one at a time, as the levels do.

import type { ComponentDef, PortDef } from '../../sim/types';
import { alu, constWord, isZero } from '../alu';
import { Builder } from '../builder';
import { busMux2, equal, incrementer, muxTree } from '../combinational';
import { define, merger, splitter } from '../define';
import { orN } from '../wide';
import { AND, NOT, OR, XOR } from '../gates';
import { register } from '../sequential';
import { TIE0, TIE1 } from '../transistors';
import { CAUSE } from '../../riscv/rv16/isa16';
import { BRANCH16, CTL16, IMM16, NEXTPC16 } from './cpu';
import { ADD16, RF8 } from './logic';
import { CSR16F, ILL16, SYSDEC16 } from './system';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

/** Pipeline register: q ← clr ? 0 : en ? d : q at the rising edge. */
export const PREG16: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins('d', 'en', 'clr', 'clk');
  const zero = b.op1(constWord(16, 0), []);
  b.next();
  const m = b.op1(busMux2(16), ['d', zero, 'clr'], 'bubble?');
  const e = b.op1(OR, ['en', 'clr'], 'load');
  b.next();
  b.wire(`${b.op(register(16), [m, e, 'clk'], 'register')}.q`, 'q');
  const R = b.right;
  return define({
    id: 'rv16_preg', name: 'Pipeline register (16-bit)', category: 'sequential',
    summary: 'q ← clr ? 0 : en ? d : q. en = 0 holds the stage (a stall); clr = 1 turns it into a bubble (a flush): all-zero control bits do nothing.',
    ports: [bus('d', 16, 'in'), bit('en', 'in'), bit('clr', 'in'), bit('clk', 'in'), bus('q', 16, 'out')],
    symbol: { kind: 'box', label: 'PIPE REG' },
    netlist: () => ({ pins: { ...pinsAt(['d', 'en', 'clr', 'clk'], 0), q: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Forwarding select for one operand: 1 = from M, 2 = from W, 0 = the register file's value. */
export function fwdSel(rs: number, rdM: number, rweM: number, rdW: number, rweW: number): number {
  if (rweM && rdM && rdM === rs) return 1;
  if (rweW && rdW && rdW === rs) return 2;
  return 0;
}

/** Forwarding unit: for each of E's sources, the newest stage writing it. */
export const FWD16: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins('rs1', 'rs2', 'rdM', 'rweM', 'rdW', 'rweW');
  const eq3 = equal(3), z3 = isZero(3);
  const nzM = b.op1(NOT, [`${b.op(z3, ['rdM'], 'rdM = 0?')}.z`]);
  const nzW = b.op1(NOT, [`${b.op(z3, ['rdW'], 'rdW = 0?')}.z`]);
  b.next();
  const vM = b.name(b.op1(AND, ['rweM', nzM], 'M writes'), 'vM', true);
  const vW = b.name(b.op1(AND, ['rweW', nzW], 'W writes'), 'vW', true);
  const sel = (rs: string, out: string) => {
    const m = b.op1(eq3, [rs, 'rdM'], `${rs} = rdM`), w = b.op1(eq3, [rs, 'rdW'], `${rs} = rdW`);
    b.next();
    const fm = b.op1(AND, [m, vM], `${out}: from M`);
    const fw0 = b.op1(AND, [w, vW]);
    b.next();
    const nfm = b.op1(NOT, [fm]);
    b.next();
    const fw = b.op1(AND, [fw0, nfm], `${out}: from W`);
    b.next();
    b.wire(b.op1(merger([1, 1], 2), [fm, fw], out), out);
  };
  b.next();
  sel('rs1', 'fa');
  b.next();
  sel('rs2', 'fb');
  const R = b.right;
  return define({
    id: 'rv16_fwd', name: 'Forwarding unit (RV16)', category: 'cpu',
    summary: 'fa / fb = 1 when the instruction in M writes the source register (not x0), else 2 when the one in W does, else 0: the newest value wins.',
    ports: [bus('rs1', 3, 'in'), bus('rs2', 3, 'in'), bus('rdM', 3, 'in'), bit('rweM', 'in'), bus('rdW', 3, 'in'), bit('rweW', 'in'), bus('fa', 2, 'out'), bus('fb', 2, 'out')],
    symbol: { kind: 'box', label: 'FORWARD' },
    spec: ([rs1, rs2, rdM, rweM, rdW, rweW]) => [fwdSel(rs1, rdM, rweM, rdW, rweW), fwdSel(rs2, rdM, rweM, rdW, rweW)],
    netlist: () => ({ pins: { ...pinsAt(['rs1', 'rs2', 'rdM', 'rweM', 'rdW', 'rweW'], 0), fa: [R, 6], fb: [R, 12] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Load-use: the instruction in D reads the register a load in E is about to fetch. */
export const HAZ16: ComponentDef = (() => {
  const b = new Builder(10, 12, 4);
  b.pins('rs1', 'rs2', 'rdE', 'loadE');
  const eq3 = equal(3);
  const nz = b.op1(NOT, [`${b.op(isZero(3), ['rdE'], 'rdE = 0?')}.z`]);
  const e1 = b.op1(eq3, ['rs1', 'rdE'], 'rs1 = rdE'), e2 = b.op1(eq3, ['rs2', 'rdE'], 'rs2 = rdE');
  b.next();
  const any = b.op1(OR, [e1, e2]);
  const v = b.op1(AND, ['loadE', nz], 'a real load');
  b.next();
  b.wire(b.op1(AND, [any, v], 'stall'), 'stall');
  const R = b.right;
  return define({
    id: 'rv16_haz', name: 'Hazard unit (RV16)', category: 'cpu',
    summary: 'stall = a load in E writes a register (not x0) that the instruction in D reads: its value exists only after M, too late to forward. Conservative: rs2 counts even when unused.',
    ports: [bus('rs1', 3, 'in'), bus('rs2', 3, 'in'), bus('rdE', 3, 'in'), bit('loadE', 'in'), bit('stall', 'out')],
    symbol: { kind: 'box', label: 'HAZARD' },
    spec: ([rs1, rs2, rdE, loadE]) => [loadE && rdE && (rdE === rs1 || rdE === rs2) ? 1 : 0],
    netlist: () => ({ pins: { ...pinsAt(['rs1', 'rs2', 'rdE', 'loadE'], 0), stall: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

export interface Rv16PipeOptions {
  /** Forwarding from M and W into E. */
  fwd: boolean;
  /** The load-use stall. */
  stall: boolean;
  /** Branches and jumps redirect the PC and flush the two wrong-path instructions. */
  flush: boolean;
  /** CSRs, precise traps and the external interrupt, taken in E (needs flush). */
  sys?: boolean;
  /**
   * Static branch prediction in F (needs flush, not sys): jal and backward branches are taken at
   * once (target = pc + imm, computed in F); E redirects only when the guess was wrong.
   */
  predict?: boolean;
}

const pipes = new Map<string, ComponentDef>();

/**
 * The five-stage RV16 pipeline (F D E M W), with the core levels' pins. The register file is
 * written at the falling edge, so an instruction three behind its producer reads the new value;
 * forwarding covers distances 1 and 2; a load followed by a user stalls one cycle; a branch or jump
 * resolves in E, redirecting the PC and flushing F/D and D/E.
 */
export function rv16Pipe(o: Rv16PipeOptions): ComponentDef {
  const key = `${+o.fwd}${+o.stall}${+o.flush}${o.sys ? 's' : ''}${o.predict ? 'p' : ''}`;
  let d = pipes.get(key);
  if (d) return d;
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'rst', 'instr', 'drdata', ...(o.sys ? ['irq'] : []));
  const inst = (end: string) => end.split('.')[0];
  const one = b.op1(TIE1, []), zero1 = b.op1(TIE0, []);
  const zero16 = b.name(b.op1(constWord(16, 0), []), 'z16', true);
  const nclk = b.name(b.op1(NOT, ['clk'], 'falling edge'), 'nclk', true);
  b.next();
  const P = (dd: string, en: string, clr: string, label: string) => `${b.op(PREG16, [dd, en, clr, 'clk'], label)}.q`;

  // ---- F: the PC (hold on a stall, jump on a redirect, 0 on reset) ----
  const pcInc = b.op(incrementer(16), [''], 'pc + 1');
  let seq = `${pcInc}.y`, predF = zero1, tgtF = '';
  if (o.predict) {
    // Predict in F, from the fetched word: jal, or a branch whose offset is negative (a loop).
    const op = b.op(splitter([1, 1, 1, 1, 11, 1], 2), ['instr'], 'op, sign (F)');
    const immF = b.op(IMM16, ['instr'], 'immediates (F)');
    b.next();
    const isBr = b.op1(AND, [`${op}.o3`, b.op1(NOT, [`${op}.o2`])], 'branch?');
    const isJal = b.op1(AND, [b.op1(AND, [`${op}.o3`, `${op}.o2`]), b.op1(NOT, [b.op1(OR, [`${op}.o1`, `${op}.o0`])])], 'jal?');
    b.next();
    predF = b.name(b.op1(OR, [b.op1(AND, [isBr, `${op}.o5`], 'backward'), isJal], 'predict taken'), 'predF', true);
    tgtF = b.op(ADD16, ['', b.op1(busMux2(16), [`${immF}.sb`, `${immF}.j`, isJal]), zero1], 'pc + imm (F)');
    b.next();
    seq = b.op1(busMux2(16), [seq, `${tgtF}.s`, predF], 'predicted');
  }
  b.next();
  const hold = o.stall ? b.op1(busMux2(16), [seq, '', ''], 'stall: hold') : seq;
  const jump = o.flush ? b.op1(busMux2(16), [hold, '', ''], 'redirect') : hold;
  const pcNext = b.op1(busMux2(16), [jump, zero16, 'rst'], 'reset');
  b.next();
  const pcq = b.name(`${b.op(register(16), [pcNext, one, 'clk'], 'PC')}.q`, 'pcF', true);
  b.wire(pcq, `${pcInc}.a`);
  if (tgtF) b.wire(pcq, `${tgtF}.a`);
  if (o.stall) b.wire(pcq, `${inst(hold)}.b`);
  b.wire(pcq, 'pc');
  b.next();

  // ---- F/D ----
  const nstall = o.stall ? b.op1(NOT, [''], 'not stalled') : one;
  const fdClr = o.flush ? b.op1(OR, ['rst', ''], 'flush F/D') : 'rst';
  const instrD = b.name(P('instr', nstall, fdClr, 'F/D instr'), 'instrD', true);
  const pcD = b.name(P(pcq, nstall, fdClr, 'F/D pc'), 'pcD', true);
  // A valid bit: 0 in a bubble (whose all-zero word would otherwise be an illegal instruction).
  const validD = o.sys ? `${b.op(splitter([1, 15], 2), [P(b.op1(constWord(16, 1), []), nstall, fdClr, 'F/D valid')])}.o0` : zero1;
  const predD = o.predict ? `${b.op(splitter([1, 15], 2), [P(b.op1(merger([1, 15], 2), [predF, b.op1(constWord(15, 0), [])]), nstall, fdClr, 'F/D predicted')])}.o0` : zero1;
  b.next();

  // ---- D: decode, read registers ----
  const f = b.op(splitter([2, 2, 3, 3, 3, 3], 4), [instrD], 'fields');
  const rdD = b.name(`${f}.o2`, 'rdD', true), rs1D = b.name(`${f}.o3`, 'rs1D', true), rs2D = b.name(`${f}.o4`, 'rs2D', true);
  const ctl = b.op(CTL16, [instrD], 'control');
  const imm = b.op(IMM16, [instrD], 'immediates');
  b.next();
  const immD = b.op1(muxTree(2, 16), [`${imm}.i`, `${imm}.sb`, `${imm}.j`, `${imm}.u`, `${ctl}.isel`], 'imm');
  const rf = b.op(RF8, ['', '', '', rs1D, rs2D, nclk], 'registers (written at the falling edge)');
  // Control word: rwe bimm alu[4] mwe wb[2] br jal jalr cond[2] valid + 1 spare = 16 bits.
  const cw = b.op1(merger([1, 1, 4, 1, 2, 1, 1, 1, 2, 1, 1], 2), [`${ctl}.rwe`, `${ctl}.bimm`, `${ctl}.alu`, `${ctl}.mwe`, `${ctl}.wb`, `${ctl}.br`, `${ctl}.jal`, `${ctl}.jalr`, `${f}.o0`, validD, predD], 'control word');
  const rw = b.op1(merger([3, 3, 3, 7], 2), [rdD, rs1D, rs2D, b.op1(constWord(7, 0), [])], 'register numbers');
  b.next();

  // ---- D/E ----
  const deClr = o.stall || o.flush ? b.op1(orN(3), ['rst', o.stall ? '' : zero1, o.flush ? '' : zero1], 'bubble into E') : 'rst';
  const r1E = b.name(P(`${rf}.rd1`, one, deClr, 'D/E rs1 value'), 'r1E', true);
  const r2E = b.name(P(`${rf}.rd2`, one, deClr, 'D/E rs2 value'), 'r2E', true);
  const immE = b.name(P(immD, one, deClr, 'D/E imm'), 'immE', true);
  const pcE = b.name(P(pcD, one, deClr, 'D/E pc'), 'pcE', true);
  const cwE = P(cw, one, deClr, 'D/E control');
  const rwE = P(rw, one, deClr, 'D/E registers');
  const instrE = o.sys ? b.name(P(instrD, one, deClr, 'D/E instr'), 'instrE', true) : '';
  b.next();

  // ---- E: forward, compute, resolve branches ----
  const ce = b.op(splitter([1, 1, 4, 1, 2, 1, 1, 1, 2, 1, 1], 2), [cwE], 'control (E)');
  const re = b.op(splitter([3, 3, 3, 7], 2), [rwE], 'registers (E)');
  let rweE = `${ce}.o0`, mweE = `${ce}.o3`;
  const validE = `${ce}.o9`;
  const bimmE = `${ce}.o1`, aluE = `${ce}.o2`, wbE = `${ce}.o4`, brE = `${ce}.o5`, jalE = `${ce}.o6`, jalrE = `${ce}.o7`, condE = `${ce}.o8`;
  const rdE = b.name(`${re}.o0`, 'rdE', true);
  b.next();
  let a = r1E, bReg = r2E, fw = '', ma = '', mb = '';
  if (o.fwd) {
    fw = b.op(FWD16, [`${re}.o1`, `${re}.o2`, '', '', '', ''], 'forwarding');
    b.next();
    a = b.op1(muxTree(2, 16), [r1E, '', '', zero16, `${fw}.fa`], 'a');
    bReg = b.op1(muxTree(2, 16), [r2E, '', '', zero16, `${fw}.fb`], 'rs2 value');
    ma = inst(a);
    mb = inst(bReg);
    b.next();
  }
  const aE = b.name(a, 'aE', true), bE = b.name(bReg, 'bE', true);
  const bsrc = b.op1(busMux2(16), [bE, immE, bimmE], 'ALU b');
  b.next();
  let yE = b.name(`${b.op(alu(16), [aE, bsrc, aluE], 'ALU')}.y`, 'yE', true);
  const take = b.op1(BRANCH16, [aE, bE, condE], 'branch?');
  b.next();
  const np = b.op(NEXTPC16, [pcE, immE, aE, brE, take, jalE, jalrE], 'next PC');
  let redirect = b.name(`${np}.ld`, 'redirect', true), target = `${np}.target`;
  if (o.predict) {
    // Wrong guess: taken but not predicted (go to the target), or predicted but not taken (go back to pc + 1).
    const predE = `${ce}.o10`;
    redirect = b.name(b.op1(XOR, [`${np}.ld`, predE], 'mispredicted'), 'redirect2', true);
    target = b.op1(busMux2(16), [`${np}.target`, `${np}.pc1`, predE], 'target or pc + 1');
    b.next();
  }
  if (o.sys) {
    // ---- traps, taken in E: the instruction in E does not run, older ones complete (precise) ----
    const ill = b.op1(ILL16, [instrE], 'illegal?');
    const sd = b.op(SYSDEC16, [instrE, aE, ''], 'system decode');
    const csr = b.op(CSR16F, [`${re}.o2`, `${sd}.wdata`, '', '', '', pcE, '', 'irq', 'clk'], 'CSRs');
    b.wire(`${csr}.rdata`, `${sd}.old`);
    b.next();
    const exc = b.op1(AND, [b.op1(orN(3), [ill, `${sd}.ecall`, `${sd}.ebreak`]), validE], 'exception');
    const intr = b.op1(AND, [`${csr}.intr`, validE], 'interrupt');
    const mret = b.op1(AND, [`${sd}.mret`, validE], 'mret');
    b.wire(b.op1(AND, [`${sd}.csrwe`, validE]), `${csr}.we`);
    b.wire(mret, `${csr}.mret`);
    b.next();
    const trap = b.name(b.op1(OR, [exc, intr], 'trap'), 'trap', true);
    const c1 = b.op1(busMux2(16), [b.op1(constWord(16, CAUSE.breakpoint), []), b.op1(constWord(16, CAUSE.ecall), []), `${sd}.ecall`]);
    b.next();
    const c2 = b.op1(busMux2(16), [c1, b.op1(constWord(16, CAUSE.illegal), []), ill]);
    const ntrap = b.op1(NOT, [trap]);
    b.next();
    b.wire(b.op1(busMux2(16), [c2, b.op1(constWord(16, CAUSE.external), []), intr], 'cause'), `${csr}.cause`);
    b.wire(trap, `${csr}.trap`);
    rweE = b.op1(AND, [b.op1(OR, [rweE, `${sd}.csr`]), ntrap], 'rwe (E)');
    mweE = b.op1(AND, [mweE, ntrap], 'mwe (E)');
    yE = b.name(b.op1(busMux2(16), [yE, `${csr}.rdata`, `${sd}.csr`], 'or a CSR'), 'yE2', true);
    const t1 = b.op1(busMux2(16), [`${np}.target`, `${csr}.mepc`, mret]);
    const ldN = b.op1(AND, [`${np}.ld`, ntrap]);
    b.next();
    target = b.op1(busMux2(16), [t1, `${csr}.mtvec`, trap], 'target');
    redirect = b.name(b.op1(orN(3), [ldN, trap, mret], 'redirect'), 'redirect2', true);
    b.next();
  }
  // A load in E (rwe and wb = 01), for the hazard unit.
  const wbs = b.op(splitter([1, 1], 2), [wbE]);
  const nwb1 = b.op1(NOT, [`${wbs}.o1`]);
  b.next();
  const ld0 = b.op1(AND, [`${wbs}.o0`, nwb1]);
  b.next();
  const loadE = b.name(b.op1(AND, [ld0, rweE], 'load in E'), 'loadE', true);
  // To M: rwe mwe wb[2] rd[3] + 9 spare.
  const cm = b.op1(merger([1, 1, 2, 3, 9], 2), [rweE, mweE, wbE, rdE, b.op1(constWord(9, 0), [])], 'control (to M)');
  b.next();

  // ---- E/M ----
  const yM = b.name(P(yE, one, 'rst', 'E/M ALU'), 'yM', true);
  const sdM = P(bE, one, 'rst', 'E/M store data');
  const pc1M = P(`${np}.pc1`, one, 'rst', 'E/M pc + 1');
  const immM = P(immE, one, 'rst', 'E/M imm');
  const cmM = P(cm, one, 'rst', 'E/M control');
  b.next();

  // ---- M: memory ----
  const cmS = b.op(splitter([1, 1, 2, 3, 9], 2), [cmM], 'control (M)');
  const rweM = b.name(`${cmS}.o0`, 'rweM', true), rdM = b.name(`${cmS}.o3`, 'rdM', true);
  // M's result for forwarding (a load's value is not ready: the hazard unit keeps its users away).
  const resM = b.name(b.op1(muxTree(2, 16), [yM, yM, pc1M, immM, `${cmS}.o2`], 'result (M)'), 'resM', true);
  const valM = b.op1(muxTree(2, 16), [yM, 'drdata', pc1M, immM, `${cmS}.o2`], 'value (M)');
  const cw2 = b.op1(merger([1, 3, 12], 2), [rweM, rdM, b.op1(constWord(12, 0), [])], 'control (to W)');
  b.wire(yM, 'daddr');
  b.wire(sdM, 'dwdata');
  b.wire(`${cmS}.o1`, 'dwe');
  b.next();

  // ---- M/W, W: write back (at the falling edge) ----
  const valW = b.name(P(valM, one, 'rst', 'M/W value'), 'valW', true);
  const cwW = P(cw2, one, 'rst', 'M/W control');
  b.next();
  const ws = b.op(splitter([1, 3, 12], 2), [cwW], 'control (W)');
  const rweW = b.name(`${ws}.o0`, 'rweW', true), rdW = b.name(`${ws}.o1`, 'rdW', true);
  b.wire(rdW, `${rf}.wa`);
  b.wire(rweW, `${rf}.we`);
  b.wire(valW, `${rf}.wd`);
  b.wire(rweW, 'rwe');
  b.wire(rdW, 'rwa');
  b.wire(valW, 'rwd');

  // ---- the backward wires: forwarding, stall, redirect ----
  if (o.fwd) {
    b.wire(rdM, `${fw}.rdM`);
    b.wire(rweM, `${fw}.rweM`);
    b.wire(rdW, `${fw}.rdW`);
    b.wire(rweW, `${fw}.rweW`);
    b.wire(resM, `${ma}.d1`);
    b.wire(valW, `${ma}.d2`);
    b.wire(resM, `${mb}.d1`);
    b.wire(valW, `${mb}.d2`);
  }
  if (o.stall) {
    b.next();
    const stall = b.name(b.op1(HAZ16, [rs1D, rs2D, rdE, loadE], 'hazard'), 'stall', true);
    b.wire(stall, `${inst(hold)}.s`);
    b.wire(stall, `${inst(nstall)}.a`);
    b.wire(stall, `${inst(deClr)}.i1`);
  }
  if (o.flush) {
    b.wire(target, `${inst(jump)}.b`);
    b.wire(redirect, `${inst(jump)}.s`);
    b.wire(redirect, `${inst(fdClr)}.b`);
    b.wire(redirect, `${inst(deClr)}.i2`);
  } else void redirect;
  const R = b.right;
  const name = o.predict ? 'RV16 pipeline with branch prediction' : o.sys ? 'RV16 pipeline with traps and interrupts' : o.flush ? 'RV16 pipeline' : o.stall ? 'RV16 pipeline (no branches)' : o.fwd ? 'RV16 pipeline (forwarding only)' : 'RV16 pipeline (no hazard handling)';
  d = define({
    id: `rv16_pipe_${key}`, name, category: 'cpu',
    summary: 'Five stages, F D E M W, with pipeline registers between them; the register file is written at the falling edge. '
      + (o.predict ? 'jal and backward branches are predicted taken in F (target = pc + imm there); E redirects only on a wrong guess. ' : '')
      + (o.fwd ? 'Forwarding from M and W into E. ' : '') + (o.stall ? 'A load followed by a user stalls one cycle. ' : '') + (o.flush ? 'Branches and jumps resolve in E and flush two instructions. ' : '') + (o.sys ? 'Traps and the external interrupt are taken in E: precise, with a valid bit so bubbles never trap.' : ''),
    ports: [bit('clk', 'in'), bit('rst', 'in'), bus('instr', 16, 'in'), bus('drdata', 16, 'in'), ...(o.sys ? [bit('irq', 'in')] : []),
      bus('pc', 16, 'out'), bus('daddr', 16, 'out'), bus('dwdata', 16, 'out'), bit('dwe', 'out'), bit('rwe', 'out'), bus('rwa', 3, 'out'), bus('rwd', 16, 'out')],
    symbol: { kind: 'box', label: 'RV16 PIPE' },
    netlist: () => ({
      pins: { ...pinsAt(['clk', 'rst', 'instr', 'drdata', ...(o.sys ? ['irq'] : [])], 0, 4), ...pinsAt(['pc', 'daddr', 'dwdata', 'dwe', 'rwe', 'rwa', 'rwd'], R, 4) },
      instances: b.instances, nets: b.nets(),
    }),
  });
  pipes.set(key, d);
  return d;
}

// Built at load (resolvable by id after a reload).
export const RV16_PIPE = rv16Pipe({ fwd: true, stall: true, flush: true });
export const RV16_PIPE_SYS = rv16Pipe({ fwd: true, stall: true, flush: true, sys: true });
export const RV16_PIPE_PRED = rv16Pipe({ fwd: true, stall: true, flush: true, predict: true });
