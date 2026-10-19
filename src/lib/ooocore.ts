// Phase 17c-2: the out-of-order core (chapter 24's `ooo`), built from lib/ooo.ts's units. P6 style: values wait in
// the reorder buffer, the rename table maps a register to the ROB entry of its youngest in-flight writer. 2-wide:
// fetch, dispatch, two issue ports with a result bus each, commit two a cycle. It reproduces riscv/ooomodel.ts's
// OOO_CORE cycle for cycle (the plan's "core's cycle, stage by stage"); tests/ooocore.test.ts holds it to that.

import type { ComponentDef, PortDef } from '../sim/types';
import { alu, constWord } from './alu';
import { Builder } from './builder';
import { addSub, andN, busMux2, decoder, equal, muxTree, rca } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, PLUS4_FAST } from './cpu';
import { define, merger, splitter } from './define';
import { koggeStone } from './fastadd';
import { AND, NOT, OR, XOR } from './gates';
import { BRANCH_CMP, nonZero } from './pipeline';
import { PREDECODE, rom2 } from './pipe2w';
import { btbCommit, dataMemory2, issueQueue, RAT, reorderBuffer, STORE_QUEUE } from './ooo';
import { ras2 } from './ras';
import { regfile2w } from './regfile';
import { divE, MUL_E, MUL_M } from './pipem';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

/** Pins at the left (inputs) and right (outputs), 2 apart, for a Builder part. */
function pinsOf(ins: string[], outs: string[], R: number): Record<string, [number, number]> {
  return { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map((n, i) => [n, [R, 2 + 2 * i] as [number, number]])) };
}

// ---- decode, dispatch, port binding, commit -----------------------------------------------------------------------

/**
 * What the core needs to know about an instruction, by riscv/ilp.ts's classify(): its class, which source registers
 * it reads, whether it writes rd. A word the model does not know is an ALU instruction with no sources and no
 * destination, so a wrong path through data or padding waits on nothing the model would not.
 */
export const OOO_CLASS: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('op', 'funct3', 'funct7');
  const ops: [string, number][] = [['R', 0x33], ['I', 0x13], ['LD', 0x03], ['ST', 0x23], ['BR', 0x63], ['JAL', 0x6f], ['JALR', 0x67], ['LUI', 0x37], ['AUIPC', 0x17]];
  const is = Object.fromEntries(ops.map(([n, v]) => [n, b.name(b.op1(equal(7), ['op', b.op1(constWord(7, v), [], undefined, `k${n}`)], undefined, `is${n}`), n, true)]));
  const f7 = b.op1(equal(7), ['funct7', b.op1(constWord(7, 1), [], undefined, 'kM')], undefined, 'f7is1');
  const f3 = b.op(splitter([2, 1]), ['funct3'], undefined, 'f3');
  b.next();
  const md = b.op1(AND, [is.R, f7], undefined, 'md');
  b.next();
  const div = b.op1(AND, [md, `${f3}.o1`], undefined, 'isDiv'), mul = b.op1(AND, [md, b.op1(NOT, [`${f3}.o1`], undefined, 'nf2')], undefined, 'isMul');
  const u1 = b.op1(orN(6), [is.R, is.I, is.LD, is.ST, is.BR, is.JALR], undefined, 'rs1');
  const u2 = b.op1(orN(3), [is.R, is.ST, is.BR], undefined, 'rs2');
  const wrd = b.op1(orN(7), [is.R, is.I, is.LD, is.JAL, is.JALR, is.LUI, is.AUIPC], undefined, 'writes');
  const noIq = b.op1(OR, [is.JAL, is.LUI], undefined, 'noIq');
  b.next();
  const fixed = b.op1(orN(4), [is.LD, is.ST, mul, div], undefined, 'fixed');
  const lat2 = b.op1(OR, [is.LD, mul], undefined, 'lat2');
  const p1only = b.op1(OR, [mul, div], undefined, 'p1only');
  const need = b.op1(NOT, [noIq], undefined, 'needIq');
  b.next();
  const both = b.op1(AND, [need, b.op1(NOT, [fixed], undefined, 'nFixed')], undefined, 'both');
  b.next();
  const outs: [string, string][] = [['load', is.LD], ['store', is.ST], ['mul', mul], ['div', div], ['branch', is.BR], ['jal', is.JAL], ['jalr', is.JALR], ['lui', is.LUI],
    ['u1', u1], ['u2', u2], ['wrd', wrd], ['needIq', need], ['both', both], ['p1only', p1only], ['lat2', lat2]];
  for (const [p, d] of outs) b.wire(d, p);
  const R = b.right;
  return define({
    id: 'oooclass', name: 'Instruction class (out of order)', category: 'cpu',
    summary: 'The class the out-of-order core schedules by: which ports may run it (loads and stores port 0, multiply and divide port 1, the rest either), its latency, whether it needs an issue-queue entry (not jal or lui: decode knows their value), which source registers it reads, whether it writes rd. A word the core does not know is an ALU instruction with no sources and no destination.',
    ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), ...outs.map(([n]) => bit(n, 'out'))],
    symbol: { kind: 'box', label: 'CLASS' },
    spec: ([op, f3, f7]) => {
      const md = op === 0x33 && f7 === 1, mul = md && f3 < 4 ? 1 : 0, div = md && f3 >= 4 ? 1 : 0;
      const ld = op === 0x03 ? 1 : 0, st = op === 0x23 ? 1 : 0, jal = op === 0x6f ? 1 : 0, lui = op === 0x37 ? 1 : 0;
      const need = jal || lui ? 0 : 1;
      return [ld, st, mul, div, op === 0x63 ? 1 : 0, jal, op === 0x67 ? 1 : 0, lui,
        [0x33, 0x13, 0x03, 0x23, 0x63, 0x67].includes(op) ? 1 : 0, [0x33, 0x23, 0x63].includes(op) ? 1 : 0, [0x33, 0x13, 0x03, 0x6f, 0x67, 0x37, 0x17].includes(op) ? 1 : 0,
        need, need && !(ld || st || mul || div) ? 1 : 0, mul || div ? 1 : 0, ld || mul ? 1 : 0];
    },
    netlist: () => ({ pins: pinsOf(['op', 'funct3', 'funct7'], outs.map(([n]) => n), R), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Does the pair dispatch? In order: slot 0 when the ROB, and if it needs them the issue queue and the store queue,
 * have room; slot 1 only after slot 0, with room for both.
 */
export const DISPATCH_CTL: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const ins = ['v0', 'v1', 'need0', 'need1', 'st0', 'st1', 'rob1', 'rob2', 'iq1', 'iq2', 'sq1', 'sq2'];
  b.pins(...ins);
  // room for a slot's need, alone or with the other slot's
  const room = (a: string, c: string, one: string, two: string, nm: string) => {
    const both = b.op1(AND, [a, c], undefined, `${nm}2`), any = b.op1(OR, [a, c], undefined, `${nm}1`);
    return b.op1(AND, [b.op1(OR, [b.op1(NOT, [both], undefined, `n${nm}2`), two], undefined, `${nm}ok2`), b.op1(OR, [b.op1(NOT, [any], undefined, `n${nm}1`), one], undefined, `${nm}ok1`)], undefined, `${nm}ok`);
  };
  const ok0 = b.op1(andN(4), ['v0', 'rob1', b.op1(OR, [b.op1(NOT, ['need0'], undefined, 'nn0'), 'iq1'], undefined, 'iqok0'), b.op1(OR, [b.op1(NOT, ['st0'], undefined, 'ns0'), 'sq1'], undefined, 'sqok0')], undefined, 'd0');
  const iqOk = room('need0', 'need1', 'iq1', 'iq2', 'iq'), sqOk = room('st0', 'st1', 'sq1', 'sq2', 'sq');
  b.next();
  b.wire(ok0, 'd0');
  b.wire(b.op1(andN(5), [ok0, 'v1', 'rob2', iqOk, sqOk], undefined, 'd1'), 'd1');
  const R = b.right;
  return define({
    id: 'dispctl', name: 'Dispatch control', category: 'cpu',
    summary: 'Dispatch goes in program order and stops at the first instruction that does not fit: slot 0 needs a reorder-buffer entry, an issue-queue entry unless decode already knows its value (jal, lui), a store-queue entry if it is a store; slot 1 the same on top of slot 0\'s. Room freed this cycle is used from the next.',
    ports: [...ins.map((n) => bit(n, 'in')), bit('d0', 'out'), bit('d1', 'out')],
    symbol: { kind: 'box', label: 'DISPATCH?' },
    spec: ([v0, v1, n0, n1, s0, s1, r1, r2, i1, i2, q1, q2]) => {
      const d0 = v0 && r1 && (!n0 || i1) && (!s0 || q1);
      const iq = n0 && n1 ? i2 : n0 || n1 ? i1 : 1, sq = s0 && s1 ? q2 : s0 || s1 ? q1 : 1;
      return [d0 ? 1 : 0, d0 && v1 && r2 && iq && sq ? 1 : 0];
    },
    netlist: () => ({ pins: pinsOf(ins, ['d0', 'd1'], R), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Which port each dispatched instruction is bound to: its class's only port, else the port with fewer instructions
 * waiting after this cycle's picks (port 0 on a tie); slot 1 counts slot 0's choice. The counts come before the picks
 * (cnt0 / cnt1, early) and the picks (go0 / go1) late, after select: so every comparison binding may need, of
 * D = cnt0 − cnt1 against −2 … 2, is made early, and the late signals only choose among them.
 */
export const BIND: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const ins = ['cnt0', 'cnt1', 'go0', 'go1', 'need0', 'both0', 'p1only0', 'both1', 'p1only1'];
  b.pins(...ins);
  const one = b.op1(TIE1, [], undefined, 'one');
  const z1 = (nm: string) => b.op1(constWord(1, 0), [], undefined, nm);
  const c0 = b.op1(merger([4, 1]), ['cnt0', z1('za')], undefined, 'c05'), c1 = b.op1(merger([4, 1]), ['cnt1', z1('zb')], undefined, 'c15');
  const sel = b.name(b.op1(merger([1, 1]), ['go0', 'go1'], undefined, 'picks'), 'picks', true);
  b.next();
  const D = b.name(b.op1(addSub(5), [c0, c1, one], undefined, 'D'), 'cnt0 − cnt1', true);
  b.next();
  // gt[k]: D > k, i.e. D − (k + 1) not negative (five bits: no overflow for D in −8 … 8)
  const gt: Record<number, string> = {};
  for (const k of [-2, -1, 0, 1, 2]) {
    const s = b.op(addSub(5), [D, b.op1(constWord(5, (k + 1) & 31), [], undefined, `k${k + 2}`), one], undefined, `d${k + 2}`);
    gt[k] = b.name(b.op1(NOT, [`${s}.n`], undefined, `gt${k + 2}`), `D > ${k}`, true);
  }
  b.next();
  // by the picks (go0, go1): D > go0 − go1 + adj
  const by = (adj: number, nm: string) => b.op1(muxTree(2, 1), [gt[adj], gt[1 + adj], gt[-1 + adj], gt[adj], sel], undefined, nm);
  const lt0 = by(0, 'lt0'), lm = by(-1, 'ltm'), lp = by(1, 'ltp');
  b.next();
  const port0 = b.name(b.op1(OR, ['p1only0', b.op1(AND, ['both0', lt0], undefined, 'pick0')], undefined, 'port0'), 'port0', true);
  b.next();
  // slot 1 counts slot 0's entry on the port it took: +1 on port 1, −1 (one more on port 0)
  const with0 = b.op1(busMux2(1), [lm, lp, port0], undefined, 'with0');
  b.next();
  const lt1 = b.op1(busMux2(1), [lt0, with0, 'need0'], undefined, 'lt1');
  b.next();
  b.wire(port0, 'port0');
  b.wire(b.op1(OR, ['p1only1', b.op1(AND, ['both1', lt1], undefined, 'pick1')], undefined, 'port1'), 'port1');
  const R = b.right;
  return define({
    id: 'bind', name: 'Port binding', category: 'cpu',
    summary: 'Binds each dispatched instruction to an issue port: multiply and divide to port 1, loads and stores to port 0, anything both ports run to the one with fewer instructions waiting once this cycle\'s picks have left (port 0 on a tie). The second instruction of a pair counts the first one\'s choice. Every comparison it may need is made before the picks are known.',
    ports: [bus('cnt0', 4, 'in'), bus('cnt1', 4, 'in'), bit('go0', 'in'), bit('go1', 'in'), bit('need0', 'in'), bit('both0', 'in'), bit('p1only0', 'in'), bit('both1', 'in'), bit('p1only1', 'in'),
      bit('port0', 'out'), bit('port1', 'out')],
    symbol: { kind: 'box', label: 'BIND' },
    spec: ([cnt0, cnt1, go0, go1, need0, both0, p10, both1, p11]) => {
      const c0 = cnt0 - go0, c1 = cnt1 - go1;
      const p0 = p10 ? 1 : both0 && c1 < c0 ? 1 : 0;
      const n0 = c0 + (need0 && !p0 ? 1 : 0), n1 = c1 + (need0 && p0 ? 1 : 0);
      return [p0, p11 ? 1 : both1 && n1 < n0 ? 1 : 0];
    },
    netlist: () => ({ pins: pinsOf(ins, ['port0', 'port1'], R), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Commit: the head retires when done (since an earlier cycle); the next with it when done too, unless both are
 * stores (one memory write a cycle) or the head mispredicted or halts. A committing misprediction flushes the rest;
 * the commit of a jump to itself halts.
 */
export const COMMIT_CTL: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const ins = ['h0v', 'h0d', 'h0st', 'h0mis', 'h0halt', 'h1v', 'h1d', 'h1st', 'h1mis', 'h1halt'];
  b.pins(...ins);
  const c0 = b.name(b.op1(AND, ['h0v', 'h0d'], undefined, 'c0'), 'c0', true);
  const twoSt = b.op1(AND, ['h0st', 'h1st'], undefined, 'twoSt');
  const stop = b.op1(orN(3), [twoSt, 'h0mis', 'h0halt'], undefined, 'stop');
  b.next();
  const c1 = b.name(b.op1(andN(4), [c0, 'h1v', 'h1d', b.op1(NOT, [stop], undefined, 'go')], undefined, 'c1'), 'c1', true);
  b.next();
  const f0 = b.op1(AND, [c0, 'h0mis'], undefined, 'f0'), f1 = b.op1(AND, [c1, 'h1mis'], undefined, 'f1');
  const x0 = b.op1(AND, [c0, 'h0halt'], undefined, 'x0'), x1 = b.op1(AND, [c1, 'h1halt'], undefined, 'x1');
  b.next();
  b.wire(c0, 'c0'); b.wire(c1, 'c1');
  b.wire(b.op1(OR, [f0, f1], undefined, 'flush'), 'flush');
  b.wire(f1, 'from1');
  b.wire(b.op1(OR, [x0, x1], undefined, 'halt'), 'halt');
  const R = b.right;
  return define({
    id: 'commitctl', name: 'Commit control', category: 'cpu',
    summary: 'Up to two instructions leave the reorder buffer a cycle, in order: each must be done since an earlier cycle; the second waits if both are stores (one memory write a cycle) or the first mispredicted (everything after it is flushed) or halts.',
    ports: [...ins.map((n) => bit(n, 'in')), bit('c0', 'out'), bit('c1', 'out'), bit('flush', 'out'), bit('from1', 'out'), bit('halt', 'out')],
    symbol: { kind: 'box', label: 'COMMIT?' },
    spec: ([h0v, h0d, h0st, h0mis, h0halt, h1v, h1d, h1st, h1mis, h1halt]) => {
      const c0 = h0v && h0d ? 1 : 0, c1 = c0 && h1v && h1d && !(h0st && h1st) && !h0mis && !h0halt ? 1 : 0;
      return [c0, c1, (c0 && h0mis) || (c1 && h1mis) ? 1 : 0, c1 && h1mis ? 1 : 0, (c0 && h0halt) || (c1 && h1halt) ? 1 : 0];
    },
    netlist: () => ({ pins: pinsOf(ins, ['c0', 'c1', 'flush', 'from1', 'halt'], R), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- execute -----------------------------------------------------------------------------------------------------------

/**
 * One port's execute stage: the ALU (rs1 or pc, rs2 or imm), the branch decision, the actual next PC (pc + 4, the
 * branch target, or the jalr target) and whether fetch guessed it (mis), the value written (the ALU's, or pc + 4 for
 * jalr), and the address of a load or store (the ALU's sum).
 */
export const EXEC: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const ins = ['opA', 'opB', 'pc', 'imm', 'pnext', 'aluCtl', 'aluSrcA', 'aluSrcB', 'resultSrc', 'funct3', 'branch', 'jalr'];
  b.pins(...ins);
  const zero = b.op1(TIE0, [], undefined, 'zero');
  const srcA = b.op1(busMux2(32), ['opA', 'pc', 'aluSrcA'], undefined, 'srcA'), srcB = b.op1(busMux2(32), ['opB', 'imm', 'aluSrcB'], undefined, 'srcB');
  const pc4 = b.name(b.op1(PLUS4_FAST, ['pc'], undefined, 'pc4'), 'pc + 4', true);
  b.next();
  const y = b.name(b.op1(alu(32, 'ks'), [srcA, srcB, 'aluCtl'], 'ALU', 'alu'), 'ALU', true);
  const tgt = b.op1(koggeStone(32), ['pc', 'imm', zero], 'pc + imm', 'target');
  const jt = b.op1(CLEAR_BIT0, [b.op1(koggeStone(32), ['opA', 'imm', zero], 'rs1 + imm', 'jsum'), zero], undefined, 'jtgt');
  const dec = b.op1(BRANCH_CMP, ['opA', 'opB', 'funct3', 'branch', zero, 'jalr'], 'branch', 'bcmp');
  b.next();
  const next = b.name(b.op1(muxTree(2, 32), [pc4, tgt, jt, pc4, dec], 'next PC', 'next'), 'next', true);
  const rs = b.op(splitter([1, 1]), ['resultSrc'], undefined, 'rs');
  b.next();
  b.wire(b.op1(busMux2(32), [y, pc4, `${rs}.o1`], undefined, 'value'), 'value');
  b.wire(next, 'next');
  b.wire(b.op1(NOT, [b.op1(equal(32), [next, 'pnext'], undefined, 'guessed')], undefined, 'mis'), 'mis');
  b.wire(y, 'addr');
  const R = b.right;
  const W: Record<string, number> = { opA: 32, opB: 32, pc: 32, imm: 32, pnext: 32, aluCtl: 4, resultSrc: 2, funct3: 3 };
  return define({
    id: 'oooexec', name: 'Execute (one port)', category: 'cpu',
    summary: 'An issue port\'s execute stage: the ALU, the branch decision and the real next PC, compared with what fetch predicted (a mismatch is a misprediction, found here and acted on at commit), the value to write and a load or store\'s address.',
    ports: [...ins.map((n) => (W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), bus('value', 32, 'out'), bus('next', 32, 'out'), bit('mis', 'out'), bus('addr', 32, 'out')],
    symbol: { kind: 'box', label: 'EXECUTE' },
    netlist: () => ({ pins: pinsOf(ins, ['value', 'next', 'mis', 'addr'], R), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The divider beside port 1: start (the divide in E1) loads the operands and funct3, the tag and what commit needs
 * (next, mis); the radix-4 divider runs; its result goes on port 1's bus in the cycle it is done if that bus is free,
 * else waits in a register until it is. busy: a divide in flight (the issue queue holds the next one back), out: the
 * result on the bus now.
 */
export const DIV_UNIT: ComponentDef = (() => {
  const b = new Builder(16, 20);
  const ins = ['start', 'a', 'b', 'f', 'tag', 'info', 'busFree', 'flush', 'clk'];
  b.pins(...ins);
  const one = b.op1(TIE1, [], undefined, 'one');
  const nFlush = b.op1(NOT, ['flush'], undefined, 'nFlush');
  b.op(register(2 + 4 + 33), [b.op1(merger([2, 4, 33]), ['f', 'tag', 'info'], undefined, 'in'), 'start', 'clk'], 'divide', 'held');
  const hs = b.op(splitter([2, 4, 33]), ['held.q'], undefined, 'hs');
  b.next();
  const go = b.name(b.op1(OR, ['start', 'run.q'], undefined, 'go'), 'go', true);
  const f = b.op1(busMux2(2), [`${hs}.o0`, 'f', 'start'], undefined, 'fNow');
  b.next();
  // a flush aborts the divide in flight (the model frees the divider at once)
  b.op(divE(true), ['clk', go, 'a', 'b', f, 'flush'], 'radix-4 SRT', 'dv');
  b.next();
  const done = b.name(b.op1(AND, [go, b.op1(NOT, ['dv.stall'], undefined, 'nst')], undefined, 'done'), 'done', true);
  const ready = b.op1(OR, [done, 'wait.q'], undefined, 'ready');
  b.next();
  const grab = b.name(b.op1(AND, [ready, 'busFree'], undefined, 'grab'), 'grab', true);
  const nGrab = b.op1(NOT, ['busFree'], undefined, 'nFree');
  b.next();
  // running until done; waiting with the result until the bus is free; a flush cancels either
  b.op(register(1), [b.op1(andN(3), [go, b.op1(NOT, [done], undefined, 'nDone'), nFlush], undefined, 'runN'), one, 'clk'], 'running', 'run');
  b.op(register(1), [b.op1(AND, [b.op1(AND, [ready, nGrab], undefined, 'stay'), nFlush], undefined, 'waitN'), one, 'clk'], 'result waiting', 'wait');
  b.op(register(32), ['dv.y', done, 'clk'], 'result', 'res');
  b.next();
  b.wire(b.op1(busMux2(32), ['dv.y', 'res.q', 'wait.q'], undefined, 'y'), 'y');
  b.wire(grab, 'out');
  b.wire(`${hs}.o1`, 'tagQ');
  b.wire(`${hs}.o2`, 'infoQ');
  b.wire(b.op1(orN(3), ['start', 'run.q', 'wait.q'], undefined, 'busyN'), 'busy');
  const R = b.right;
  const W: Record<string, number> = { a: 32, b: 32, f: 2, tag: 4, info: 33 };
  return define({
    id: 'divunit', name: 'Divider (out of order)', category: 'cpu',
    summary: 'The divide beside port 1: it takes the operands from the execute stage and runs 19 cycles on its own, so port 1 goes on issuing other instructions meanwhile. Done, its result goes on port 1\'s result bus if no other instruction claimed that cycle, else it waits. One divide at a time.',
    ports: [...ins.map((n) => (n === 'clk' ? bit('clk', 'in', 'bottom', true) : W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))),
      bus('y', 32, 'out'), bit('out', 'out'), bus('tagQ', 4, 'out'), bus('infoQ', 33, 'out'), bit('busy', 'out')],
    symbol: { kind: 'box', label: 'DIVIDE' },
    netlist: () => ({ pins: pinsOf(ins, ['y', 'out', 'tagQ', 'infoQ', 'busy'], R), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * A source operand at dispatch: not used (ready), the register file's value (no instruction in flight writes it),
 * a reorder-buffer entry's value (done), a result bus's value (its producer finishes now), or a tag to wait for.
 * self: the first instruction of the pair writes it (its ROB entry is being allocated: never read it); then ready
 * only when decode knows that value (jal, lui).
 */
export const OPERAND: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const ins = ['used', 'mapped', 'tag', 'robDone', 'robVal', 'rfVal', 'bv0', 'bt0', 'bx0', 'bv1', 'bt1', 'bx1', 'self', 'selfKnown', 'selfVal', 'selfTag'];
  b.pins(...ins);
  const h0 = b.op1(AND, ['bv0', b.op1(equal(4), ['bt0', 'tag'], undefined, 'e0')], undefined, 'h0');
  const h1 = b.op1(AND, ['bv1', b.op1(equal(4), ['bt1', 'tag'], undefined, 'e1')], undefined, 'h1');
  b.next();
  const rdyM = b.op1(orN(3), ['robDone', h0, h1], undefined, 'rdyM');
  const valM = b.op1(busMux2(32), [b.op1(busMux2(32), ['bx1', 'bx0', h0], undefined, 'onBus'), 'robVal', 'robDone'], undefined, 'valM');
  b.next();
  const rdyR = b.op1(OR, [b.op1(NOT, ['mapped'], undefined, 'nm'), rdyM], undefined, 'rdyR');
  const valR = b.op1(busMux2(32), ['rfVal', valM, 'mapped'], undefined, 'valR');
  b.next();
  const rdyS = b.op1(busMux2(1), [rdyR, 'selfKnown', 'self'], undefined, 'rdyS');
  b.next();
  b.wire(b.op1(OR, [b.op1(NOT, ['used'], undefined, 'nu'), rdyS], undefined, 'rdy'), 'rdy');
  b.wire(b.op1(busMux2(32), [valR, 'selfVal', 'self'], undefined, 'val'), 'val');
  b.wire(b.op1(busMux2(4), ['tag', 'selfTag', 'self'], undefined, 'tagO'), 'tagO');
  const R = b.right;
  const W: Record<string, number> = { tag: 4, robVal: 32, rfVal: 32, bt0: 4, bx0: 32, bt1: 4, bx1: 32, selfVal: 32, selfTag: 4 };
  return define({
    id: 'operand', name: 'Operand at dispatch', category: 'cpu',
    summary: 'Where a source operand comes from as an instruction enters the issue queue: the register file (nothing in flight writes it), the reorder buffer (its producer is done), a result bus (its producer finishes now), or nowhere yet: then it waits for its producer\'s tag. The second instruction of a pair reading the first one\'s result waits for it, unless decode already knows it (jal, lui).',
    ports: [...ins.map((n) => (W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), bit('rdy', 'out'), bus('val', 32, 'out'), bus('tagO', 4, 'out')],
    symbol: { kind: 'box', label: 'OPERAND' },
    netlist: () => ({ pins: pinsOf(ins, ['rdy', 'val', 'tagO'], R), instances: b.instances, nets: b.nets() }),
  });
})();

/** jal and lui are done at decode: jal's value pc + 4 and next pc + imm, lui's value imm and next pc + 4; mis if fetch guessed otherwise. */
export const KNOWN: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('pc', 'imm', 'pnext', 'jal');
  const zero = b.op1(TIE0, [], undefined, 'zero');
  const pc4 = b.name(b.op1(PLUS4_FAST, ['pc'], undefined, 'pc4'), 'pc + 4', true);
  const tgt = b.op1(koggeStone(32), ['pc', 'imm', zero], 'pc + imm', 'tgt');
  b.next();
  const next = b.name(b.op1(busMux2(32), [pc4, tgt, 'jal'], undefined, 'next'), 'next', true);
  b.next();
  b.wire(b.op1(busMux2(32), ['imm', pc4, 'jal'], undefined, 'value'), 'value');
  b.wire(next, 'next');
  b.wire(b.op1(NOT, [b.op1(equal(32), [next, 'pnext'], undefined, 'guessed')], undefined, 'mis'), 'mis');
  const R = b.right;
  return define({
    id: 'known', name: 'Known at decode (jal, lui)', category: 'cpu',
    summary: 'jal and lui need no execution: decode knows jal\'s value (pc + 4) and target (pc + imm), lui\'s value (imm). Their reorder-buffer entry is done at once; a misprediction (fetch did not go to the target) is known too.',
    ports: [bus('pc', 32, 'in'), bus('imm', 32, 'in'), bus('pnext', 32, 'in'), bit('jal', 'in'), bus('value', 32, 'out'), bus('next', 32, 'out'), bit('mis', 'out')],
    symbol: { kind: 'box', label: 'KNOWN' },
    netlist: () => ({ pins: pinsOf(['pc', 'imm', 'pnext', 'jal'], ['value', 'next', 'mis'], R), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Fetch's prediction for a pair, the model's: a return goes to the return stack's top (when not empty), else a BTB
 * hit predicted taken to its target, else pc + 4. Slot 1 is fetched only when slot 0 goes on to pc + 4, and is
 * predicted with the return stack as slot 0's call or return leaves it (top1 / any1). The stack's operations: each
 * fetched call pushes, each return pops.
 */
export const FETCH_OOO: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const ins = ['call0', 'ret0', 'call1', 'ret1', 'pt0', 'tgt0', 'pt1', 'tgt1', 'top0', 'any0', 'top1', 'any1', 'pc4', 'pc8', 'go'];
  b.pins(...ins);
  const r0 = b.op1(AND, ['ret0', 'any0'], undefined, 'r0'), r1 = b.op1(AND, ['ret1', 'any1'], undefined, 'r1');
  b.next();
  const t0 = b.op1(busMux2(32), ['tgt0', 'top0', r0], undefined, 't0'), t1 = b.op1(busMux2(32), ['tgt1', 'top1', r1], undefined, 't1');
  const k0 = b.op1(OR, [r0, 'pt0'], undefined, 'take0'), k1 = b.op1(OR, [r1, 'pt1'], undefined, 'take1');
  b.next();
  const p0 = b.name(b.op1(busMux2(32), ['pc4', t0, k0], undefined, 'pnext0'), 'pnext0', true);
  const p1 = b.name(b.op1(busMux2(32), ['pc8', t1, k1], undefined, 'pnext1'), 'pnext1', true);
  b.next();
  const v1 = b.name(b.op1(equal(32), [p0, 'pc4'], undefined, 'v1'), 'slot 1', true);
  const g1 = b.op1(AND, ['go', v1], undefined, 'go1');
  b.next();
  b.wire(p0, 'pnext0'); b.wire(p1, 'pnext1'); b.wire(v1, 'v1');
  b.wire(b.op1(busMux2(32), [p0, p1, v1], undefined, 'next'), 'next');
  b.wire(b.op1(AND, ['go', 'call0'], undefined, 'push0'), 'push0'); b.wire(b.op1(AND, ['go', 'ret0'], undefined, 'pop0'), 'pop0');
  b.wire(b.op1(AND, [g1, 'call1'], undefined, 'push1'), 'push1'); b.wire(b.op1(AND, [g1, 'ret1'], undefined, 'pop1'), 'pop1');
  const R = b.right;
  const W: Record<string, number> = { tgt0: 32, tgt1: 32, top0: 32, top1: 32, pc4: 32, pc8: 32 };
  const outs: [string, number][] = [['pnext0', 32], ['pnext1', 32], ['v1', 1], ['next', 32], ['push0', 1], ['pop0', 1], ['push1', 1], ['pop1', 1]];
  return define({
    id: 'fetchooo', name: 'Fetch prediction (out of order)', category: 'cpu',
    summary: 'Where each fetched instruction is predicted to go: a return to the return stack\'s top, a branch or jump the BTB knows to its target, else on. The second slot is fetched only if the first goes on, and sees the stack as the first left it.',
    ports: [...ins.map((n) => (W[n] ? bus(n, W[n], 'in') : bit(n, 'in'))), ...outs.map(([n, w]) => (w > 1 ? bus(n, w, 'out') : bit(n, 'out')))],
    symbol: { kind: 'box', label: 'PREDICT' },
    netlist: () => ({ pins: pinsOf(ins, outs.map(([n]) => n), R), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the core ---------------------------------------------------------------------------------------------------------

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** The issue queue's payload: what execute needs beyond the operands. */
const PAY: [string, number][] = [['tag', 4], ['pc', 32], ['imm', 32], ['pnext', 32], ['aluCtl', 4], ['aluSrcA', 1], ['aluSrcB', 1], ['resultSrc', 2], ['funct3', 3],
  ['branch', 1], ['jalr', 1], ['store', 1], ['sqIdx', 2], ['ltail', 3]];
const PW = PAY.reduce((a, [, w]) => a + w, 0);
const pi = (n: string) => PAY.findIndex(([f]) => f === n);
/** A reorder-buffer entry: what dispatch writes (D), and the result (V). */
const ROB_D: [string, number][] = [['rd', 5], ['pc', 32], ['store', 1], ['branch', 1], ['jal', 1], ['jalr', 1], ['call', 1], ['ret', 1]];
const ROB_V: [string, number][] = [['value', 32], ['next', 32], ['mis', 1]];
const di = (n: string) => ROB_D.findIndex(([f]) => f === n), vi = (n: string) => ROB_V.findIndex(([f]) => f === n);
/** A fetch-register slot. */
const FD: [string, number][] = [['valid', 1], ['pc', 32], ['word', 32], ['pnext', 32]];

export interface OooOptions {
  /** Instruction ROM of 2^imemK words (default 6). */
  imemK?: number;
  /** Data memory of 2^dmemK words (default 5). */
  dmemK?: number;
}

/** Chapter 24's out-of-order core (`ooo`): RV32IM, word loads and stores, as the pipelines. */
export function oooCpu(program: number[], opts: OooOptions = {}): ComponentDef {
  const IM = rom2(program, opts.imemK ?? 6), dk = opts.dmemK ?? 5;
  return memo(`ooo_${IM.id}_${dk}`, () => buildOoo(IM, dk));
}

function buildOoo(IM: ComponentDef, dmemK: number): ComponentDef {
  const b = new Builder(10, 16, 4);
  const put = (def: ComponentDef, name: string, conns: Record<string, string>, label?: string): string => {
    b.add(def, label, name);
    for (const [p, d] of Object.entries(conns)) b.wire(d, `${name}.${p}`);
    return name;
  };
  const one = b.op1(TIE1, [], undefined, 'one'), zero = b.op1(TIE0, [], undefined, 'zero');
  const z = (w: number, nm: string) => b.op1(constWord(w, 0), [], undefined, nm);
  const and = (a: string, c: string, nm: string) => b.op1(AND, [a, c], undefined, nm);
  const not = (a: string, nm: string) => b.op1(NOT, [a], undefined, nm);
  const S = [0, 1] as const;
  b.pins('clk');

  // ---- F: two words from the fetch PC, predicted; into the fetch register when it empties ------------------------------
  put(register(32), 'pc', { d: 'fpcN.y', en: one, clk: 'clk' }, 'fetch PC');
  put(PLUS4_FAST, 'plus4', { a: 'pc.q' }, 'pc + 4');
  put(PLUS4_FAST, 'plus8', { a: 'plus4.y' }, 'pc + 8');
  put(IM, 'imem', { addr0: 'pc.q', addr1: 'plus4.y' });
  put(PREDECODE, 'pd0', { instr: 'imem.data0' }, 'slot 0');
  put(PREDECODE, 'pd1', { instr: 'imem.data1' }, 'slot 1');
  put(btbCommit(), 'btb', {
    pcF0: 'pc.q', pcF1: 'plus4.y', pcC0: 'hd0.o1', v0: 'tr0.y', branch0: `hd0.o${di('branch')}`, jump0: 'jj0.y', taken0: 'tk0.y', next0: `hv0.o${vi('next')}`,
    pcC1: 'hd1.o1', v1: 'tr1.y', branch1: `hd1.o${di('branch')}`, jump1: 'jj1.y', taken1: 'tk1.y', next1: `hv1.o${vi('next')}`, clk: 'clk',
  }, 'branch predictor');
  put(ras2(4, 32), 'ras', {
    push0: 'fp.push0', pop0: 'fp.pop0', v0: 'plus4.y', push1: 'fp.push1', pop1: 'fp.pop1', v1: 'plus8.y',
    pushC0: 'rcp0.y', popC0: 'rcq0.y', vC0: 'link0.y', pushC1: 'rcp1.y', popC1: 'rcq1.y', vC1: 'link1.y', restore: 'cm.flush', clk: 'clk',
  }, 'return stack');
  put(FETCH_OOO, 'fp', {
    call0: 'pd0.call', ret0: 'pd0.ret', call1: 'pd1.call', ret1: 'pd1.ret', pt0: 'btb.pt0', tgt0: 'btb.tgt0', pt1: 'btb.pt1', tgt1: 'btb.tgt1',
    top0: 'ras.top0', any0: 'ras.any0', top1: 'ras.top1', any1: 'ras.any1', pc4: 'plus4.y', pc8: 'plus8.y', go: 'fgo.y',
  }, 'prediction');
  b.next();
  // the fetch register: refilled when this cycle's dispatch empties it; else slot 1 moves up when slot 0 alone went
  const fdW = FD.reduce((a, [, w]) => a + w, 0);
  const F0 = b.op1(merger(FD.map(([, w]) => w)), [one, 'pc.q', 'imem.data0', 'fp.pnext0'], undefined, 'F0');
  const F1 = b.op1(merger(FD.map(([, w]) => w)), ['fp.v1', 'plus4.y', 'imem.data1', 'fp.pnext1'], undefined, 'F1');
  const empty = z(fdW, 'fdEmpty');
  const shift = and('fd1s.o0', not('dc.d1', 'nd1'), 'shift');
  const kept0 = b.op1(busMux2(fdW), ['fd0.q', b.op1(busMux2(fdW), [empty, 'fd1.q', shift], undefined, 'moved'), 'dc.d0'], undefined, 'kept0');
  const kept1 = b.op1(busMux2(fdW), ['fd1.q', empty, 'dc.d0'], undefined, 'kept1');
  // empty after dispatch: no slot 0, or slot 0 went and slot 1 with it (or there was none)
  const after = b.op1(OR, [not('fd0s.o0', 'nv0'), and('dc.d0', b.op1(OR, [not('fd1s.o0', 'nv1'), 'dc.d1'], undefined, 'rest'), 'went')], undefined, 'fgo');
  b.next();
  const n0 = b.op1(busMux2(fdW), [kept0, F0, after], undefined, 'n0'), n1 = b.op1(busMux2(fdW), [kept1, F1, after], undefined, 'n1');
  b.next();
  put(register(fdW), 'fd0', { d: b.op1(busMux2(fdW), [n0, empty, 'cm.flush'], undefined, 'fl0'), en: one, clk: 'clk' }, 'fetched, slot 0');
  put(register(fdW), 'fd1', { d: b.op1(busMux2(fdW), [n1, empty, 'cm.flush'], undefined, 'fl1'), en: one, clk: 'clk' }, 'fetched, slot 1');
  b.op1(busMux2(32), [b.op1(busMux2(32), ['pc.q', 'fp.next', after], undefined, 'fpcF'), 'redir.y', 'cm.flush'], undefined, 'fpcN');
  b.next();

  // ---- D: decode both, rename, read operands, dispatch into the ROB, the issue queue and the store queue -------------
  for (const s of S) {
    put(splitter(FD.map(([, w]) => w)), `fd${s}s`, { in: `fd${s}.q` });
    put(splitter([7, 5, 3, 5, 5, 7]), `si${s}`, { in: `fd${s}s.o2` });
    put(CONTROL, `ctl${s}`, { op: `si${s}.o0`, funct3: `si${s}.o2`, funct7: `si${s}.o5` }, `decode ${s}`);
    put(IMM_GEN, `imm${s}`, { instr: `fd${s}s.o2`, src: `ctl${s}.immSrc` });
    put(OOO_CLASS, `cls${s}`, { op: `si${s}.o0`, funct3: `si${s}.o2`, funct7: `si${s}.o5` });
    put(PREDECODE, `dpd${s}`, { instr: `fd${s}s.o2` });
    put(KNOWN, `kn${s}`, { pc: `fd${s}s.o1`, imm: `imm${s}.imm`, pnext: `fd${s}s.o3`, jal: `cls${s}.jal` });
  }
  b.next();
  put(DISPATCH_CTL, 'dc', {
    v0: 'fd0s.o0', v1: 'fd1s.o0', need0: 'cls0.needIq', need1: 'cls1.needIq', st0: 'cls0.store', st1: 'cls1.store',
    rob1: 'rob.free1', rob2: 'rob.free2', iq1: 'iq.free1', iq2: 'iq.free2', sq1: 'sq.free1', sq2: 'sq.free2',
  }, 'dispatch?');
  put(BIND, 'bind', { cnt0: 'iq.cnt0', cnt1: 'iq.cnt1', go0: 'iq.go0', go1: 'iq.go1', need0: 'cls0.needIq', both0: 'cls0.both', p1only0: 'cls0.p1only', both1: 'cls1.both', p1only1: 'cls1.p1only' }, 'port binding');
  const wr = S.map((s) => and(`dc.d${s}`, `cls${s}.wrd`, `wr${s}`));
  put(RAT, 'rat', {
    rs1_0: 'si0.o3', rs2_0: 'si0.o4', rs1_1: 'si1.o3', rs2_1: 'si1.o4', rd0: 'si0.o1', we0: wr[0], tag0: 'rob.tailTag', rd1: 'si1.o1', we1: wr[1], tag1: 'rob.tail1Tag',
    crd0: 'hd0.o0', cv0: 'cm.c0', ctag0: 'rob.headTag', crd1: 'hd1.o0', cv1: 'cm.c1', ctag1: 'rob.head1Tag', flush: 'cm.flush', clk: 'clk',
  }, 'rename');
  put(regfile2w(5, 32), 'rf', {
    wa0: 'hd0.o0', we0: 'cm.c0', wd0: `hv0.o${vi('value')}`, wa1: 'hd1.o0', we1: 'cm.c1', wd1: `hv1.o${vi('value')}`,
    ra1: 'si0.o3', ra2: 'si0.o4', ra3: 'si1.o3', ra4: 'si1.o4', clk: 'clk',
  });
  b.next();
  // the four sources: A0 B0 (slot 0), A1 B1 (slot 1: slot 0's destination first)
  const srcs = [['A0', 0, 'si0.o3', 'cls0.u1', 'a0'], ['B0', 0, 'si0.o4', 'cls0.u2', 'b0'], ['A1', 1, 'si1.o3', 'cls1.u1', 'a1'], ['B1', 1, 'si1.o4', 'cls1.u2', 'b1']] as const;
  const known0 = b.op1(OR, ['cls0.jal', 'cls0.lui'], undefined, 'known0');
  srcs.forEach(([nm, s, rs, used, r], k) => {
    const self = s ? and(wr[0], and(b.op1(equal(5), [rs, 'si0.o1'], undefined, `same${nm}`), b.op1(nonZero(5), [rs], undefined, `nz${nm}`), `self${nm}0`), `self${nm}`) : zero;
    put(OPERAND, `op${nm}`, {
      used, mapped: `rat.${r}v`, tag: `rat.${r}t`, robDone: `rob.rdone${k}`, robVal: `rob.rval${k}`, rfVal: `rf.rd${k + 1}`,
      bv0: 'bus0v.y', bt0: 'bus0t.y', bx0: 'bus0x.o0', bv1: 'bus1v.y', bt1: 'bus1t.y', bx1: 'bus1x.o0',
      self, selfKnown: known0, selfVal: 'kn0.value', selfTag: 'rob.tailTag',
    }, `operand ${nm}`);
  });
  b.next();
  // the load's store mask: stores not yet executed (and slot 0's, if it is a store dispatched beside it)
  const st0d = and('dc.d0', 'cls0.store', 'st0d');
  const fan4 = (x: string, nm: string) => b.op1(merger([1, 1, 1, 1]), [x, x, x, x], undefined, nm);
  put(decoder(2, true, 4), 'st0bit', { a: 'sq.idx0', en: st0d });
  const st0m = b.op1(merger([1, 1, 1, 1]), ['st0bit.y0', 'st0bit.y1', 'st0bit.y2', 'st0bit.y3'], undefined, 'st0m');
  const mask0 = b.op1(bitwise('and', 4), ['sq.pend', fan4('cls0.load', 'ld0f')], undefined, 'mask0');
  const mask1 = b.op1(bitwise('and', 4), [b.op1(bitwise('or', 4), ['sq.pend', st0m], undefined, 'pend1'), fan4('cls1.load', 'ld1f')], undefined, 'mask1');
  const ltail1 = b.op1(rca(3), ['sq.tail', b.op1(merger([1, 2]), [st0d, z(2, 'z2')], undefined, 'st0n'), zero], undefined, 'ltail1');
  const tags = ['rob.tailTag', 'rob.tail1Tag'], ltails = ['sq.tail', ltail1], sqIdx = ['sq.idx0', 'sq.idx1'], masks = [mask0, mask1];
  const pays = S.map((s) => b.op1(merger(PAY.map(([, w]) => w)), [tags[s], `fd${s}s.o1`, `imm${s}.imm`, `fd${s}s.o3`, `ctl${s}.aluCtl`, `ctl${s}.aluSrcA`, `ctl${s}.aluSrcB`,
    `ctl${s}.resultSrc`, `si${s}.o2`, `cls${s}.branch`, `cls${s}.jalr`, `cls${s}.store`, sqIdx[s], ltails[s]], undefined, `pay${s}`));
  b.next();
  const slot = (s: 0 | 1) => {
    const [A, B] = s ? ['A1', 'B1'] : ['A0', 'B0'];
    return {
      [`s${s}_port`]: `bind.port${s}`, [`s${s}_load`]: `cls${s}.load`, [`s${s}_div`]: `cls${s}.div`, [`s${s}_lat2`]: `cls${s}.lat2`,
      [`s${s}_tagA`]: `op${A}.tagO`, [`s${s}_rdyA`]: `op${A}.rdy`, [`s${s}_valA`]: `op${A}.val`, [`s${s}_tagB`]: `op${B}.tagO`, [`s${s}_rdyB`]: `op${B}.rdy`, [`s${s}_valB`]: `op${B}.val`,
      [`s${s}_smask`]: masks[s], [`s${s}_pay`]: pays[s],
    };
  };
  put(issueQueue(PW), 'iq', {
    alloc0: and('dc.d0', 'cls0.needIq', 'al0'), alloc1: and('dc.d1', 'cls1.needIq', 'al1'), ...slot(0), ...slot(1),
    bv0: 'bus0v.y', bt0: 'bus0t.y', bx0: 'bus0x.o0', bv1: 'bus1v.y', bt1: 'bus1t.y', bx1: 'bus1x.o0', sdone: 'sq.done',
    busNext0: 'r2_0.q', busNext1: 'r2_1.q', divFree: b.op1(OR, [not('div.busy', 'nDivBusy'), 'div.out'], undefined, 'divFree'), flush: 'cm.flush', clk: 'clk',
  }, 'issue queue');
  // the reorder buffer: rd only if the instruction writes one; jal / lui done at once
  const robD = S.map((s) => b.op1(merger(ROB_D.map(([, w]) => w)), [b.op1(busMux2(5), [z(5, `zrd${s}`), `si${s}.o1`, `cls${s}.wrd`], undefined, `rd${s}`), `fd${s}s.o1`,
    `cls${s}.store`, `cls${s}.branch`, `cls${s}.jal`, `cls${s}.jalr`, `dpd${s}.call`, `dpd${s}.ret`], undefined, `robD${s}`));
  const robV = S.map((s) => b.op1(merger(ROB_V.map(([, w]) => w)), [`kn${s}.value`, `kn${s}.next`, `kn${s}.mis`], undefined, `robV${s}`));
  put(reorderBuffer(43, 65), 'rob', {
    a0: 'dc.d0', a1: 'dc.d1', dd0: robD[0], dd1: robD[1], dn0: known0, dn1: b.op1(OR, ['cls1.jal', 'cls1.lui'], undefined, 'known1'), dv0: robV[0], dv1: robV[1],
    bw0: 'bus0v.y', btag0: 'bus0t.y', bv0: 'bus0V.y', bw1: 'bus1v.y', btag1: 'bus1t.y', bv1: 'bus1V.y', ce0: 'cm.c0', ce1: 'cm.c1', flush: 'cm.flush',
    rtag0: 'rat.a0t', rtag1: 'rat.b0t', rtag2: 'rat.a1t', rtag3: 'rat.b1t', clk: 'clk',
  }, 'reorder buffer');
  put(STORE_QUEUE, 'sq', {
    al0: st0d, al1: and('dc.d1', 'cls1.store', 'st1d'), sw: and('e1s0.o0', `pp0.o${pi('store')}`, 'sw'), sidx: `pp0.o${pi('sqIdx')}`, saddr: 'ex0.addr', sdata: 'e1s0.o5',
    cs: 'cs.y', flush: 'cm.flush', ltail: `pp0.o${pi('ltail')}`, laddr: 'ex0.addr', clk: 'clk',
  }, 'store queue');
  put(dataMemory2(dmemK), 'dm', { raddr: 'ex0.addr', waddr: 'sq.memAddr', wd: 'sq.memData', we: 'sq.memWe', clk: 'clk' });
  b.next();

  // ---- issue and execute: E1 (picked last cycle), E2 (2-cycle instructions), the divider; a result bus per port ---------
  const E1F = [1, 1, 1, 1, 32, 32, PW]; // valid, load, div, lat2, opA, opB, payload
  for (const p of S) {
    put(register(1), `r2_${p}`, { d: and(and(`iq.go${p}`, `iq.lat2${p}`, `l2p${p}`), 'nFlush.y', `r2n${p}`), en: one, clk: 'clk' }, `bus ${p} next cycle`);
    put(register(E1F.reduce((a, w) => a + w, 0)), `e1_${p}`, {
      d: b.op1(merger(E1F), [and(`iq.go${p}`, 'nFlush.y', `v1n${p}`), `iq.load${p}`, `iq.div${p}`, `iq.lat2${p}`, `iq.opA${p}`, `iq.opB${p}`, `iq.pay${p}`], undefined, `e1in${p}`),
      en: one, clk: 'clk',
    }, `issued, port ${p}`);
    put(splitter(E1F), `e1s${p}`, { in: `e1_${p}.q` });
    put(splitter(PAY.map(([, w]) => w)), `pp${p}`, { in: `e1s${p}.o6` });
    put(EXEC, `ex${p}`, {
      opA: `e1s${p}.o4`, opB: `e1s${p}.o5`, pc: `pp${p}.o${pi('pc')}`, imm: `pp${p}.o${pi('imm')}`, pnext: `pp${p}.o${pi('pnext')}`, aluCtl: `pp${p}.o${pi('aluCtl')}`,
      aluSrcA: `pp${p}.o${pi('aluSrcA')}`, aluSrcB: `pp${p}.o${pi('aluSrcB')}`, resultSrc: `pp${p}.o${pi('resultSrc')}`, funct3: `pp${p}.o${pi('funct3')}`,
      branch: `pp${p}.o${pi('branch')}`, jalr: `pp${p}.o${pi('jalr')}`,
    }, `execute, port ${p}`);
    // a 1-cycle instruction's result is on the bus now
    b.op1(andN(3), [`e1s${p}.o0`, not(`e1s${p}.o3`, `nl2${p}`), not(`e1s${p}.o2`, `ndv${p}`)], undefined, `now${p}`);
  }
  not('cm.flush', 'nFlush');
  put(splitter([2, 1]), 'f3p1', { in: `pp1.o${pi('funct3')}` });
  // port 0, 2 cycles: a load (memory, or the youngest older store to the word)
  const ldv = b.op1(busMux2(32), ['dm.rd', 'sq.fwdData', 'sq.fwdHit'], undefined, 'ldv');
  const E2_0 = [1, 4, 32, 32, 1];
  put(register(70), 'e2_0', {
    d: b.op1(merger(E2_0), [and(and('e1s0.o0', 'e1s0.o3', 'ld2'), 'nFlush.y', 'v2n0'), `pp0.o${pi('tag')}`, ldv, 'ex0.next', 'ex0.mis'], undefined, 'e2in0'), en: one, clk: 'clk',
  }, 'loaded');
  put(splitter(E2_0), 'e2s0', { in: 'e2_0.q' });
  // port 1, 2 cycles: a multiply (the Booth tree, then the final add)
  put(MUL_E, 'mule', { a: 'e1s1.o4', b: 'e1s1.o5', f: 'f3p1.o0' }, 'multiply (E1)');
  const E2_1 = [1, 4, 64, 64, 2, 32, 1];
  put(register(168), 'e2_1', {
    d: b.op1(merger(E2_1), [and(and('e1s1.o0', 'e1s1.o3', 'mu2'), 'nFlush.y', 'v2n1'), `pp1.o${pi('tag')}`, 'mule.s', 'mule.c', 'f3p1.o0', 'ex1.next', 'ex1.mis'], undefined, 'e2in1'), en: one, clk: 'clk',
  }, 'multiplying');
  put(splitter(E2_1), 'e2s1', { in: 'e2_1.q' });
  put(MUL_M, 'mulm', { s: 'e2s1.o2', c: 'e2s1.o3', f: 'e2s1.o4' }, 'multiply (E2)');
  // port 1: the divider, which takes the bus when it is done and no other result claimed it
  put(DIV_UNIT, 'div', {
    start: and('e1s1.o0', 'e1s1.o2', 'dstart'), a: 'e1s1.o4', b: 'e1s1.o5', f: 'f3p1.o0', tag: `pp1.o${pi('tag')}`,
    info: b.op1(merger([32, 1]), ['ex1.next', 'ex1.mis'], undefined, 'dinfo'), busFree: b.op1(NOT, [b.op1(OR, ['now1.y', 'e2s1.o0'], undefined, 'taken1')], undefined, 'free1'), flush: 'cm.flush', clk: 'clk',
  }, 'divide');
  b.next();
  // the result buses: tag and {value, next, mis}
  for (const p of S) {
    const v1 = b.op1(merger(ROB_V.map(([, w]) => w)), [`ex${p}.value`, `ex${p}.next`, `ex${p}.mis`], undefined, `v1_${p}`);
    const v2 = b.op1(merger(ROB_V.map(([, w]) => w)), [p ? 'mulm.y' : 'e2s0.o2', `e2s${p}.o${p ? 5 : 3}`, `e2s${p}.o${p ? 6 : 4}`], undefined, `v2_${p}`);
    const vd = p ? b.op1(merger([32, 33]), ['div.y', 'div.infoQ'], undefined, 'vd') : v2;
    const t2 = p ? b.op1(busMux2(4), ['div.tagQ', 'e2s1.o1', 'e2s1.o0'], undefined, 't2d') : 'e2s0.o1';
    const V2 = p ? b.op1(busMux2(65), [vd, v2, 'e2s1.o0'], undefined, 'V2d') : v2;
    b.op1(busMux2(4), [t2, `pp${p}.o${pi('tag')}`, `now${p}.y`], `bus ${p}`, `bus${p}t`);
    b.op1(busMux2(65), [V2, v1, `now${p}.y`], undefined, `bus${p}V`);
    b.op1(orN(3), [`now${p}.y`, `e2s${p}.o0`, p ? 'div.out' : zero], undefined, `bus${p}v`);
    put(splitter([32, 33]), `bus${p}x`, { in: `bus${p}V.y` });
  }
  b.next();

  // ---- commit: up to two from the head; the register file, the store queue's drain, the predictor, the return stack -----
  for (const s of S) {
    put(splitter(ROB_D.map(([, w]) => w)), `hd${s}`, { in: `rob.h${s}d` });
    put(splitter(ROB_V.map(([, w]) => w)), `hv${s}`, { in: `rob.h${s}v` });
    b.op1(equal(32), [`hv${s}.o${vi('next')}`, `hd${s}.o${di('pc')}`], undefined, `halt${s}`);
    b.op1(PLUS4_FAST, [`hd${s}.o${di('pc')}`], undefined, `link${s}`);
  }
  put(COMMIT_CTL, 'cm', {
    h0v: 'rob.h0valid', h0d: 'rob.h0done', h0st: `hd0.o${di('store')}`, h0mis: `hv0.o${vi('mis')}`, h0halt: 'halt0.eq',
    h1v: 'rob.h1valid', h1d: 'rob.h1done', h1st: `hd1.o${di('store')}`, h1mis: `hv1.o${vi('mis')}`, h1halt: 'halt1.eq',
  }, 'commit');
  b.next();
  for (const s of S) {
    const c = `cm.c${s}`, ctrl = b.op1(orN(3), [`hd${s}.o${di('branch')}`, `hd${s}.o${di('jal')}`, `hd${s}.o${di('jalr')}`], undefined, `ctrl${s}`);
    b.op1(andN(3), [c, ctrl, not(`hd${s}.o${di('ret')}`, `nret${s}`)], undefined, `tr${s}`);
    b.op1(OR, [`hd${s}.o${di('jal')}`, `hd${s}.o${di('jalr')}`], undefined, `jj${s}`);
    b.op1(NOT, [b.op1(equal(32), [`hv${s}.o${vi('next')}`, `link${s}.y`], undefined, `seq${s}`)], undefined, `tk${s}`);
    and(c, `hd${s}.o${di('call')}`, `rcp${s}`);
    and(c, `hd${s}.o${di('ret')}`, `rcq${s}`);
  }
  b.op1(OR, [and('cm.c0', `hd0.o${di('store')}`, 'cs0'), and('cm.c1', `hd1.o${di('store')}`, 'cs1')], undefined, 'cs');
  b.op1(busMux2(32), [`hv0.o${vi('next')}`, `hv1.o${vi('next')}`, 'cm.from1'], undefined, 'redir');
  b.next();
  b.wire(b.op1(merger([1, 1]), [b.op1(XOR, ['cm.c0', 'cm.c1'], undefined, 'one1'), and('cm.c0', 'cm.c1', 'two')], undefined, 'count'), 'retire');
  b.wire(`hd0.o${di('pc')}`, 'pcW0');
  // the oldest instruction not committed (the fetch PC when none is in flight): where the program is
  b.wire(b.op1(busMux2(32), ['pc.q', `hd0.o${di('pc')}`, 'rob.h0valid'], undefined, 'now'), 'pcF');
  b.wire('cm.halt', 'halted');
  const names: Record<string, string> = {
    'pc.q': 'fetchPC', 'cm.flush': 'flush', 'cm.c0': 'commit0', 'cm.c1': 'commit1', 'redir.y': 'redirect', 'dc.d0': 'dispatch0', 'dc.d1': 'dispatch1',
    'bus0v.y': 'bus0', 'bus1v.y': 'bus1', 'bus0t.y': 'tag0', 'bus1t.y': 'tag1', 'fgo.y': 'fetch', 'iq.go0': 'issue0', 'iq.go1': 'issue1',
  };
  for (const [d, n] of Object.entries(names)) b.name(d, n, true);
  const R = b.right, H = b.height;
  return {
    id: `ooo_${IM.id.replace(/^rom2_/, '')}_d${dmemK}`, name: 'Out-of-order RV32IM CPU (2-wide, ROB 16, issue queue 8)', category: 'cpu',
    summary: 'Fetches and dispatches two instructions a cycle in order, renames their registers to reorder-buffer entries, issues them out of order to two ports as their operands arrive on the result buses, and commits them in order, two a cycle: the register file and memory only ever see results in program order. A misprediction is found at execute and recovered from at commit.',
    ports: [bit('clk', 'in', 'left', true), bus('pcF', 32, 'out'), bus('retire', 2, 'out'), bus('pcW0', 32, 'out'), bit('halted', 'out')],
    symbol: { kind: 'box', label: 'RV32IM OUT OF ORDER' },
    netlist: () => ({ pins: { clk: [0, H + 6], pcF: [R, H + 6], retire: [R, H + 9], pcW0: [R, H + 12], halted: [R, H + 15] }, instances: b.instances, nets: b.nets() }),
    hdl: { verilog: '// P6-style 2-wide out-of-order RV32IM core: rename (RAT → ROB tags), issue queue with wakeup and oldest-first select, ROB, store queue.' },
  };
}
