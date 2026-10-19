// The lane core of the GPU chapters (26–27): one fetch, one decode and one control unit feeding n
// lanes, each lane a register file and an ALU of its own. Every lane runs the instruction; the
// active mask decides which lanes may write. The golden model is riscv/simt.ts.
//
//   leader       the lowest active lane: its ALU flags pick the next PC, its registers feed tmc /
//                pred and the jalr target (a branch the lanes disagree on follows it)
//   memory       one port: a load or store serves one active lane per cycle, lowest first, and
//                stalls the PC until the last one (the sequencer)
//   SIMT control the mask and the split / join stack, one entry per split: the mask before it, the
//                lanes left to run, where they resume, and whether they still have to
//
// The program ROM, immediates, control unit and next-PC logic are the single-cycle CPU's.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord, isZero, orN } from './alu';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal, muxTree } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, PLUS4_FAST, rom } from './cpu';
import { define, merger, ones, splitter } from './define';
import { fanout, koggeStone } from './fastadd';
import { AND, NOT, OR } from './gates';
import { sharedMemory } from './multicore';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });
const clkPort = bit('clk', 'in', 'bottom', true);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const log2 = (n: number) => Math.round(Math.log2(n));
const checkLanes = (n: number) => { if (n !== 2 && n !== 4 && n !== 8) throw new Error('lanes: 2, 4 or 8'); };

/** Pins of a Builder netlist: inputs down the left edge, outputs down the right (labels carry the nets). */
function edgePins(b: Builder, ins: string[], outs: string[], pitch = 2): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  ins.forEach((p, i) => (pins[p] = [0, 2 + pitch * i]));
  outs.forEach((p, i) => (pins[p] = [b.right, 2 + pitch * i]));
  return pins;
}

/** Is any bit of an n-bit bus set: split it, OR the bits. */
function anyOf(b: Builder, d: string, n: number, label?: string, name?: string): string {
  const s = b.op(splitter(ones(n)), [d]);
  return b.op1(orN(n), Array.from({ length: n }, (_, i) => `${s}.o${i}`), label, name);
}

// ---- small blocks ------------------------------------------------------------------------------

/** The lowest set bit of x, one-hot (y = x AND −x), and whether there is any. */
export function lowestOne(n: number): ComponentDef {
  return memo(`low1_${n}`, () => {
    const b = new Builder(14);
    b.pins('x');
    const sx = b.op(splitter(ones(n)), ['x']);
    const x = (i: number) => `${sx}.o${i}`;
    b.next();
    // below[i]: some bit under i is set
    const below = ['', x(0)];
    for (let i = 2; i < n; i++) below.push(b.op1(OR, [below[i - 1], x(i - 1)], undefined, `b${i}`));
    const any = b.op1(OR, [below[n - 1], x(n - 1)], 'any', 'anyg');
    b.next();
    const nb = Array.from({ length: n }, (_, i) => (i ? b.op1(NOT, [below[i]], undefined, `nb${i}`) : ''));
    b.next();
    const y = Array.from({ length: n }, (_, i) => (i ? b.op1(AND, [x(i), nb[i]], undefined, `y${i}`) : x(0)));
    b.next();
    b.wire(b.op1(merger(ones(n)), y), 'y');
    b.wire(any, 'any');
    return define({
      id: `low1_${n}`, name: `Lowest set bit (${n})`, category: 'routing',
      summary: `The lowest 1 of ${n} bits as a one-hot word: bit i survives when no bit below it is set. With "any", a fixed-priority arbiter; the lane core uses it to find the leader (lowest active lane) and the next lane to serve.`,
      ports: [bus('x', n, 'in'), bus('y', n, 'out'), bit('any', 'out')],
      symbol: { kind: 'box', label: 'LOWEST 1' },
      spec: ([x]) => [x & -x & (2 ** n - 1), x ? 1 : 0],
      netlist: () => ({ pins: edgePins(b, ['x'], ['y', 'any'], 4), instances: b.instances, nets: b.nets() }),
    });
  });
}

/** A one-hot multiplexer: y = the OR of the inputs whose select bit is 1 (one AND per bit, an OR tree). */
export function onehotMux(n: number, w: number): ComponentDef {
  return memo(`ohmux${n}x${w}`, () => {
    const b = new Builder(14);
    const ds = Array.from({ length: n }, (_, i) => `d${i}`);
    b.pins('s', ...ds);
    const ss = b.op(splitter(ones(n)), ['s']);
    b.next();
    const fans = ds.map((_, i) => (w === 1 ? `${ss}.o${i}` : b.op1(fanout(w), [`${ss}.o${i}`], undefined, `f${i}`)));
    b.next();
    let level = ds.map((d, i) => b.op1(w === 1 ? AND : bitwise('and', w), [d, fans[i]], `lane ${i}`, `g${i}`));
    let k = 0;
    while (level.length > 1) {
      b.next();
      const nx: string[] = [];
      for (let i = 0; i + 1 < level.length; i += 2) nx.push(b.op1(w === 1 ? OR : bitwise('or', w), [level[i], level[i + 1]], undefined, `o${k++}`));
      if (level.length % 2) nx.push(level[level.length - 1]);
      level = nx;
    }
    b.wire(level[0], 'y');
    return define({
      id: `ohmux${n}x${w}`, name: `One-hot ${n}:1 multiplexer (${w}-bit)`, category: 'routing',
      summary: `Picks the input whose select bit is 1 (several: their OR). No decoder: the select is already one-hot, so each input is just ANDed with its bit. ${n * w} ANDs and an OR tree ${log2(n)} deep.`,
      ports: [bus('s', n, 'in', 'bottom'), ...ds.map((d) => bus(d, w, 'in')), bus('y', w, 'out')],
      symbol: { kind: 'box', label: 'ONE-HOT MUX' },
      spec: (v) => [ds.reduce((y, _, i) => ((v[0] >> i) & 1 ? y | v[1 + i] : y), 0) >>> 0],
      netlist: () => ({ pins: edgePins(b, ['s', ...ds], ['y'], 3), instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- a lane ------------------------------------------------------------------------------------

/** One lane: a register file, the operand multiplexers, an ALU and the result multiplexer. */
export function laneUnit(n: number): ComponentDef {
  checkLanes(n);
  return memo(`lane${n}`, () => {
    const k = log2(n);
    const RF = regfile(5, 32), M2 = busMux2(32), M4 = muxTree(2, 32), ALU = alu(32, 'ks');
    const ins = ['rs1', 'rs2', 'rd', 'we', 'pc', 'imm', 'pcPlus4', 'aluSrcA', 'aluSrcB', 'aluCtl', 'resultSrc', 'isCsr', 'csrSel', 'csrS', 'tid', 'readData', 'clk'];
    const outs = ['rd1', 'rd2', 'aluY', 'flags', 'nz'];
    const b = new Builder(22, 20);
    b.pins(...ins);
    const rf = b.add(RF, 'registers', 'rf');
    for (const [p, q] of [['rs1', 'ra1'], ['rs2', 'ra2'], ['rd', 'wa'], ['we', 'we'], ['clk', 'clk']]) b.wire(p, `${rf}.${q}`);
    b.name(`${rf}.rd1`, 'rd1'); b.name(`${rf}.rd2`, 'rd2');
    b.next();
    const srcA = b.op1(M2, [`${rf}.rd1`, 'pc', 'aluSrcA'], 'SrcA', 'srcA');
    const srcB = b.op1(M2, [`${rf}.rd2`, 'imm', 'aluSrcB'], 'SrcB', 'srcB');
    const z = b.op1(isZero(32), [`${rf}.rd1`], 'rs1 = 0?', 'z');
    const lid = b.op(splitter([k, 32 - k]), ['tid'], undefined, 'lid');
    b.next();
    const a = b.add(ALU, 'ALU', 'alu');
    b.wire(srcA, `${a}.a`); b.wire(srcB, `${a}.b`); b.wire('aluCtl', `${a}.ctl`);
    b.name(`${a}.y`, 'ALUResult');
    const nz = b.op1(NOT, [z], undefined, 'nzg');
    const zhi = b.op1(constWord(32 - k, 0), [], undefined, 'zhi');
    const lane = b.op1(merger([k, 32 - k]), [`${lid}.o0`, zhi], undefined, 'lanev');
    b.next();
    const res = b.op1(M4, [`${a}.y`, 'readData', 'pcPlus4', 'imm', 'resultSrc'], 'result', 'res');
    const gnd = b.op1(constWord(32, 0), [], undefined, 'gnd');
    const csr = b.op1(M4, ['csrS', lane, 'tid', gnd, 'csrSel'], 'CSR', 'csr');
    const fl = b.op1(merger([1, 1, 1, 1]), [`${a}.zero`, `${a}.neg`, `${a}.ovf`, `${a}.carry`], undefined, 'fl');
    b.next();
    const x = b.op1(M2, [res, csr, 'isCsr'], 'result / CSR', 'xres');
    b.wire(x, `${rf}.wd`);
    b.name(x, 'Result', true);
    b.wire(`${rf}.rd1`, 'rd1'); b.wire(`${rf}.rd2`, 'rd2'); b.wire(`${a}.y`, 'aluY'); b.wire(fl, 'flags'); b.wire(nz, 'nz');
    return define({
      id: `lane${n}`, name: 'Lane', category: 'cpu',
      summary: 'One lane of the lane core: 31 registers of its own, the operand multiplexers, an ALU, and the result multiplexer (ALU, memory, PC + 4, immediate, or a CSR: lane, tid or one of the shared ones). It writes its register only when the core says so (we): the active mask, or its turn at the memory port.',
      ports: [
        bus('rs1', 5, 'in'), bus('rs2', 5, 'in'), bus('rd', 5, 'in'), bit('we', 'in'), bus('pc', 32, 'in'), bus('imm', 32, 'in'), bus('pcPlus4', 32, 'in'),
        bit('aluSrcA', 'in'), bit('aluSrcB', 'in'), bus('aluCtl', 4, 'in'), bus('resultSrc', 2, 'in'), bit('isCsr', 'in'), bus('csrSel', 2, 'in'),
        bus('csrS', 32, 'in'), bus('tid', 32, 'in'), bus('readData', 32, 'in'), clkPort,
        bus('rd1', 32, 'out'), bus('rd2', 32, 'out'), bus('aluY', 32, 'out'), bus('flags', 4, 'out'), bit('nz', 'out'),
      ],
      symbol: { kind: 'box', label: 'LANE' },
      netlist: () => ({ pins: edgePins(b, ins, outs, 3), instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- decode, SIMT control, memory sequencer ------------------------------------------------------

/** Recognises the SIMT instructions and the lane CSRs; computes the shared CSR value. */
export function simtDecode(n: number): ComponentDef {
  checkLanes(n);
  return memo(`simtdec${n}`, () => {
    const b = new Builder(16);
    const ins = ['op', 'funct3', 'rs1', 'csr', 'mask'];
    b.pins(...ins);
    const eS = b.op1(equal(7), ['op', b.op1(constWord(7, 0b0001011), [], undefined, 'kS')], 'custom-0?', 'eS');
    const eY = b.op1(equal(7), ['op', b.op1(constWord(7, 0b1110011), [], undefined, 'kY')], 'SYSTEM?', 'eY');
    const e2 = b.op1(equal(3), ['funct3', b.op1(constWord(3, 2), [], undefined, 'k2')], 'csrrs?', 'e2');
    const z1 = b.op1(isZero(5), ['rs1'], 'rs1 = 0', 'z1');
    const sc = b.op(splitter([3, 9]), ['csr'], undefined, 'sc');
    b.next();
    const fd = b.op(decoder(3, true), ['funct3', eS], 'SIMT op', 'fd');
    const eH = b.op1(equal(9), [`${sc}.o1`, b.op1(constWord(9, 0xcc0 >> 3), [], undefined, 'kH')], '0xCC0–0xCC7?', 'eH');
    const ld = b.op(decoder(3), [`${sc}.o0`], 'CSR', 'ld');
    b.next();
    // lane CSRs are 0xCC0–0xCC4: not 5, 6, 7
    const hi = b.op1(orN(3), [`${ld}.y5`, `${ld}.y6`, `${ld}.y7`], undefined, 'hi');
    const ok = b.op1(NOT, [hi], undefined, 'ok');
    const sl = b.op(splitter([1, 1, 1]), [`${sc}.o0`], undefined, 'sl');
    b.next();
    const isCsr = b.op1(andN(5), [eY, e2, z1, eH, ok], 'lane CSR read', 'isCsrG');
    const sel = b.op1(merger([1, 1]), [`${ld}.y0`, `${ld}.y3`], 'lane / tid', 'sel');
    const hiZ = b.op1(constWord(32 - n, 0), [], undefined, 'hiZ');
    const tmask = b.op1(merger([n, 32 - n]), ['mask', hiZ], 'tmask', 'tm');
    const m1 = b.op1(busMux2(32), [b.op1(constWord(32, 0), [], undefined, 'kW'), b.op1(constWord(32, n), [], undefined, 'kN'), `${sl}.o1`], 'warp / nlanes', 'm1');
    b.next();
    const m2 = b.op1(busMux2(32), [m1, tmask, `${sl}.o2`], 'tmask?', 'm2');
    const outs: [string, string][] = [['isTmc', `${fd}.y0`], ['isSplit', `${fd}.y2`], ['isJoin', `${fd}.y3`], ['isPred', `${fd}.y5`], ['isCsr', isCsr], ['csrSel', sel], ['csrS', m2]];
    for (const [p, d] of outs) b.wire(d, p);
    const pins = edgePins(b, ins, outs.map(([p]) => p), 3);
    return define({
      id: `simtdec${n}`, name: 'SIMT decoder', category: 'cpu',
      summary: 'custom-0 (0001011): funct3 picks tmc (0), split (2), join (3), pred (5); wspawn and bar do nothing with one warp. csrr rd, 0xCC0–0xCC4 reads a lane CSR: lane and tid differ per lane (csrSel), warp, nlanes and tmask are shared (csrS).',
      ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('rs1', 5, 'in'), bus('csr', 12, 'in'), bus('mask', n, 'in'),
        bit('isTmc', 'out'), bit('isSplit', 'out'), bit('isJoin', 'out'), bit('isPred', 'out'), bit('isCsr', 'out'), bus('csrSel', 2, 'out'), bus('csrS', 32, 'out')],
      symbol: { kind: 'box', label: 'SIMT DECODE' },
      spec: ([op, f3, rs1, csr, mask]) => {
        const simt = op === 0b0001011, csrOk = op === 0b1110011 && f3 === 2 && rs1 === 0 && csr >= 0xcc0 && csr <= 0xcc4;
        const lo = csr & 7;
        return [+(simt && f3 === 0), +(simt && f3 === 2), +(simt && f3 === 3), +(simt && f3 === 5), +csrOk,
          (lo === 0 ? 1 : 0) | (lo === 3 ? 2 : 0), lo & 4 ? mask : lo & 2 ? n : 0];
      },
      netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** Stack entry fields, low to high: mask, else mask, resume PC, pending, valid. */
export const stackEntryWidth = (n: number) => 2 * n + 34;

/**
 * The active mask and the split / join stack (depth entries, a shift register: the top is entry 0).
 * The mask is stored inverted, so power-on (every flip-flop 0) means every lane active.
 */
export function simtControl(n: number, depth = 4): ComponentDef {
  checkLanes(n);
  return memo(`simtctl${n}_${depth}`, () => {
    const W = stackEntryWidth(n), full = 2 ** n - 1;
    const XN = bitwise('xor', n), AN = bitwise('and', n), MN = busMux2(n), MW = busMux2(W);
    const ins = ['isTmc', 'isSplit', 'isJoin', 'isPred', 'pred', 'leadA', 'leadB', 'pcPlus4', 'clk'];
    const b = new Builder(16, 22);
    b.pins(...ins);
    // registers: the inverted mask and the stack entries (their inputs come back from the right)
    const mr = b.add(register(n), 'mask (inverted)', 'maskN');
    const es = Array.from({ length: depth }, (_, i) => b.add(register(W), `entry ${i}`, `e${i}`));
    for (const r of [mr, ...es]) b.wire('clk', `${r}.clk`);
    b.next();
    const kOnes = b.op1(constWord(n, full), [], undefined, 'kOnes');
    const mask = b.name(b.op1(XN, [`${mr}.q`, kOnes], 'mask', 'mx'), 'mask', true);
    const top = b.op(splitter([n, n, 32, 1, 1]), [`${es[0]}.q`], 'top entry', 'top');
    const ta = b.op(splitter([n, 32 - n]), ['leadA'], undefined, 'ta');
    const tb = b.op(splitter([n, 32 - n]), ['leadB'], undefined, 'tb');
    b.name(`${top}.o0`, 'topMask', true); b.name(`${top}.o1`, 'topElse', true); b.name(`${top}.o2`, 'topPC', true);
    b.name(`${top}.o3`, 'topPending', true); b.name(`${top}.o4`, 'topValid', true);
    b.next();
    const then = b.name(b.op1(AN, [mask, 'pred'], 'then', 'then'), 'then', true);
    const els = b.name(b.op1(XN, [mask, then], 'else', 'else'), 'else', true);
    const thenAny = anyOf(b, then, n, undefined, 'thenAny');
    const elseAny = anyOf(b, els, n, undefined, 'elseAny');
    const doJoin = b.name(b.op1(AND, ['isJoin', `${top}.o4`], 'join, stack not empty', 'doJoin'), 'doJoin', true);
    const npend = b.op1(NOT, [`${top}.o3`], undefined, 'npend');
    b.next();
    const pending = b.name(b.op1(AND, [thenAny, elseAny], 'both paths?', 'pend'), 'pending', true);
    const doClr = b.name(b.op1(AND, [doJoin, `${top}.o3`], 'run the else lanes', 'doClr'), 'doClr', true);
    const doPop = b.name(b.op1(AND, [doJoin, npend], 'pop', 'doPop'), 'doPop', true);
    const one = b.op1(TIE1, [], undefined, 'one');
    const zero = b.op1(TIE0, [], undefined, 'zero');
    b.next();
    // the entry a split pushes, and entry 0 with pending cleared
    const nw = b.name(b.op1(merger([n, n, 32, 1, 1]), [mask, els, 'pcPlus4', pending, one], 'pushed', 'nw'), 'pushed', true);
    const clr = b.op1(merger([n, n, 32, 1, 1]), [`${top}.o0`, `${top}.o1`, `${top}.o2`, zero, `${top}.o4`], 'top, else done', 'clr');
    const shiftEn = b.op1(OR, ['isSplit', doPop], undefined, 'shEn');
    const en0 = b.op1(OR, ['isSplit', doJoin], undefined, 'en0');
    const empty = b.op1(constWord(W, 0), [], undefined, 'empty');
    // next mask
    const splitV = b.op1(MN, [mask, then, pending], 'split', 'splitV');
    const predV = b.op1(MN, [`${tb}.o0`, then, thenAny], 'pred', 'predV');
    const joinA = b.op1(MN, [mask, `${top}.o0`, doPop], undefined, 'joinA');
    b.next();
    const joinV = b.op1(MN, [joinA, `${top}.o1`, doClr], 'join', 'joinV');
    const e0a = b.op1(MW, [clr, `${es[1]}.q`, doPop], undefined, 'e0a');
    b.next();
    const nx1 = b.op1(MN, [joinV, predV, 'isPred'], undefined, 'nx1');
    const e0d = b.op1(MW, [e0a, nw, 'isSplit'], 'entry 0', 'e0d');
    for (let i = 1; i < depth; i++) {
      const d = b.op1(MW, [i + 1 < depth ? `${es[i + 1]}.q` : empty, `${es[i - 1]}.q`, 'isSplit'], `entry ${i}`, `e${i}d`);
      b.wire(d, `${es[i]}.d`);
      b.wire(shiftEn, `${es[i]}.en`);
    }
    b.wire(e0d, `${es[0]}.d`);
    b.wire(en0, `${es[0]}.en`);
    b.next();
    const nx2 = b.op1(MN, [nx1, splitV, 'isSplit'], undefined, 'nx2');
    const anyOp = b.op1(orN(4), ['isTmc', 'isSplit', 'isJoin', 'isPred'], undefined, 'anyOp');
    b.next();
    const next = b.name(b.op1(MN, [nx2, `${ta}.o0`, 'isTmc'], 'next mask', 'nx'), 'maskNext', true);
    b.next();
    b.wire(b.op1(XN, [next, kOnes], 'invert', 'inv'), `${mr}.d`);
    b.wire(anyOp, `${mr}.en`);
    b.wire(mask, 'mask'); b.wire(doClr, 'jump'); b.wire(`${top}.o2`, 'jpc');
    const pins = edgePins(b, ins, ['mask', 'jump', 'jpc'], 3);
    return define({
      id: `simtctl${n}_${depth}`, name: 'SIMT control (mask and stack)', category: 'cpu',
      summary: `The active mask and a ${depth}-entry split / join stack. split pushes (mask, else lanes, the address after the split, pending) and runs the lanes whose rs1 ≠ 0 first; join either sends the else lanes to that address (pending cleared) or restores the mask and pops. tmc loads the mask from the leader's rs1; pred keeps the lanes whose rs1 ≠ 0, or takes the leader's rs2 when none would remain.`,
      ports: [bit('isTmc', 'in'), bit('isSplit', 'in'), bit('isJoin', 'in'), bit('isPred', 'in'), bus('pred', n, 'in'), bus('leadA', 32, 'in'), bus('leadB', 32, 'in'),
        bus('pcPlus4', 32, 'in'), clkPort, bus('mask', n, 'out'), bit('jump', 'out'), bus('jpc', 32, 'out')],
      symbol: { kind: 'box', label: 'SIMT CONTROL' },
      netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** The memory sequencer: a load or store serves one active lane per cycle, lowest first, and stalls until the last. */
export function memSequencer(n: number): ComponentDef {
  checkLanes(n);
  return memo(`memseq${n}`, () => {
    const ins = ['isMem', 'mask', 'clk'];
    const b = new Builder(14, 20);
    b.pins(...ins);
    const busy = b.add(register(1), 'busy', 'busy');
    const rem = b.add(register(n), 'lanes left', 'rem');
    const one = b.op1(TIE1, [], undefined, 'one');
    for (const r of [busy, rem]) { b.wire('clk', `${r}.clk`); b.wire(one, `${r}.en`); }
    b.next();
    const pending = b.name(b.op1(busMux2(n), ['mask', `${rem}.q`, `${busy}.q`], 'to serve', 'pend'), 'pending', true);
    b.next();
    const lo = b.op(lowestOne(n), [pending], 'this cycle', 'lo');
    b.next();
    const rest = b.op1(bitwise('xor', n), [pending, `${lo}.y`], 'after it', 'rest');
    b.next();
    const more = anyOf(b, rest, n, 'more?', 'more');
    b.next();
    const stall = b.name(b.op1(AND, ['isMem', more], 'stall', 'stl'), 'stall', true);
    b.wire(stall, `${busy}.d`);
    b.wire(rest, `${rem}.d`);
    b.wire(`${lo}.y`, 'served'); b.wire(`${lo}.any`, 'any'); b.wire(stall, 'stall');
    return define({
      id: `memseq${n}`, name: 'Memory sequencer', category: 'cpu',
      summary: `One memory port for ${n} lanes: a load or store serves the lowest active lane not yet served, one per cycle, and stalls the PC until none is left. A load with every lane active costs ${n} cycles (a coalescer, chapter 31, merges neighbouring words into one access).`,
      ports: [bit('isMem', 'in'), bus('mask', n, 'in'), clkPort, bus('served', n, 'out'), bit('any', 'out'), bit('stall', 'out')],
      symbol: { kind: 'box', label: 'MEM SEQUENCER' },
      netlist: () => ({ pins: edgePins(b, ins, ['served', 'any', 'stall'], 3), instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- the core ----------------------------------------------------------------------------------

export interface LaneCoreOptions {
  /** Data memory of 2^dmemK words (default 5). */
  dmemK?: number;
  /** Program ROM of 2^imemK words (default 6). */
  imemK?: number;
}

/** n lanes (2, 4 or 8) behind one fetch, decode and control; the golden model is SimtISS. */
export function laneCore(program: number[], n = 4, opts: LaneCoreOptions = {}): ComponentDef {
  checkLanes(n);
  const dmemK = opts.dmemK ?? 5, imemK = opts.imemK ?? 6;
  const IM = rom(program, imemK);
  return memo(`lanecore${n}_${IM.id}_d${dmemK}`, () => {
    const M2 = busMux2(32), LANE = laneUnit(n);
    const b = new Builder(14, 20);
    b.pins('clk');
    // fetch
    const pcmux = b.add(muxTree(2, 32), 'next PC', 'pcmux');
    const jm = b.add(M2, 'join jump', 'jmux');
    b.wire(`${pcmux}.y`, `${jm}.a`);
    b.next();
    const pc = b.add(register(32), 'PC', 'pc');
    b.wire(`${jm}.y`, `${pc}.d`); b.wire('clk', `${pc}.clk`);
    b.name(`${pc}.q`, 'PC', true);
    b.next();
    const im = b.op1(IM, [`${pc}.q`], 'program', 'imem');
    b.name(im, 'Instr', true);
    const p4 = b.name(b.op1(PLUS4_FAST, [`${pc}.q`], 'PC + 4', 'plus4'), 'PCPlus4', true);
    b.next();
    const si = b.op(splitter([7, 5, 3, 5, 5, 7]), [im], undefined, 'si');
    for (const [o, nm] of [['o0', 'op'], ['o1', 'rd'], ['o2', 'funct3'], ['o3', 'rs1'], ['o4', 'rs2'], ['o5', 'funct7']]) b.name(`${si}.${o}`, nm, true);
    const csrA = b.name(b.op1(merger([5, 7]), [`${si}.o4`, `${si}.o5`], 'CSR address', 'csrA'), 'csr', true);
    b.next();
    const ctl = b.op(CONTROL, [`${si}.o0`, `${si}.o2`, `${si}.o5`], 'control', 'ctl');
    const imm = b.op(IMM_GEN, [im, `${ctl}.immSrc`], 'immediate', 'imm');
    b.name(`${imm}.imm`, 'ImmExt', true);
    const sd = b.add(simtDecode(n), 'SIMT decode', 'sdec');
    for (const [p, d] of [['op', `${si}.o0`], ['funct3', `${si}.o2`], ['rs1', `${si}.o3`], ['csr', csrA]]) b.wire(d, `${sd}.${p}`);
    const rs = b.op(splitter([1, 1]), [`${ctl}.resultSrc`], undefined, 'rs');
    b.next();
    // a load or store goes through the sequencer; a CSR read writes registers too
    const nr1 = b.op1(NOT, [`${rs}.o1`], undefined, 'nr1');
    const isLoad = b.op1(AND, [`${rs}.o0`, nr1], 'load?', 'isLoad');
    const isMem = b.name(b.op1(OR, [isLoad, `${ctl}.memWrite`], 'memory?', 'isMemG'), 'isMem', true);
    const rw = b.name(b.op1(OR, [`${ctl}.regWrite`, `${sd}.isCsr`], undefined, 'rw'), 'RegWriteX', true);
    b.next();
    const ms = b.add(memSequencer(n), 'memory sequencer', 'mseq');
    b.wire(isMem, `${ms}.isMem`); b.wire('clk', `${ms}.clk`);
    b.name(`${ms}.served`, 'served', true);
    const sc = b.add(simtControl(n), 'SIMT control', 'simt');
    for (const p of ['isTmc', 'isSplit', 'isJoin', 'isPred']) b.wire(`${sd}.${p}`, `${sc}.${p}`);
    b.wire(p4, `${sc}.pcPlus4`); b.wire('clk', `${sc}.clk`);
    const mask = b.name(`${sc}.mask`, 'mask', true);
    b.wire(mask, `${ms}.mask`); b.wire(mask, `${sd}.mask`);
    b.wire(`${sc}.jump`, `${jm}.s`); b.wire(`${sc}.jpc`, `${jm}.b`);
    b.next();
    // write enables: the active lanes, or during a load the lane being served
    const wsel = b.op1(busMux2(n), [mask, `${ms}.served`, isMem], 'who writes', 'wsel');
    const wf = b.op1(fanout(n), [rw], undefined, 'wf');
    const lead = b.op(lowestOne(n), [mask], 'leader', 'lead');
    b.name(`${lead}.y`, 'leader', true);
    b.next();
    const we = b.op(splitter(ones(n)), [b.op1(bitwise('and', n), [wsel, wf], undefined, 'weg')], undefined, 'we');
    // pc enable: not stalled, and some lane still active
    const nst = b.op1(NOT, [`${ms}.stall`], undefined, 'nst');
    const en = b.op1(AND, [nst, `${lead}.any`], 'PC enable', 'pcen');
    b.wire(en, `${pc}.en`);
    b.next();
    // the lanes
    const lanes = Array.from({ length: n }, (_, i) => b.add(LANE, `lane ${i}`, `lane${i}`));
    const tids = Array.from({ length: n }, (_, i) => b.op1(constWord(32, i), [], `tid ${i}`, `tid${i}`));
    lanes.forEach((l, i) => {
      const w: [string, string][] = [
        [`${si}.o3`, 'rs1'], [`${si}.o4`, 'rs2'], [`${si}.o1`, 'rd'], [`${we}.o${i}`, 'we'], [`${pc}.q`, 'pc'], [`${imm}.imm`, 'imm'], [p4, 'pcPlus4'],
        [`${ctl}.aluSrcA`, 'aluSrcA'], [`${ctl}.aluSrcB`, 'aluSrcB'], [`${ctl}.aluCtl`, 'aluCtl'], [`${ctl}.resultSrc`, 'resultSrc'],
        [`${sd}.isCsr`, 'isCsr'], [`${sd}.csrSel`, 'csrSel'], [`${sd}.csrS`, 'csrS'], [tids[i], 'tid'], ['clk', 'clk'],
      ];
      for (const [d, p] of w) b.wire(d, `${l}.${p}`);
    });
    b.next();
    // leader's values and the served lane's address / data
    const OH = onehotMux(n, 32), OF = onehotMux(n, 4);
    const sel = (label: string, name: string, def: ComponentDef, s: string, port: string) => {
      const m = b.add(def, label, name);
      b.wire(s, `${m}.s`);
      lanes.forEach((l, i) => b.wire(`${l}.${port}`, `${m}.d${i}`));
      return `${m}.y`;
    };
    const lAlu = sel('leader ALU', 'lAlu', OH, `${lead}.y`, 'aluY');
    const lA = sel('leader rs1', 'lA', OH, `${lead}.y`, 'rd1');
    const lB = sel('leader rs2', 'lB', OH, `${lead}.y`, 'rd2');
    const lF = sel('leader flags', 'lF', OF, `${lead}.y`, 'flags');
    const mAd = sel('address', 'mAd', OH, `${ms}.served`, 'aluY');
    const mWd = sel('store data', 'mWd', OH, `${ms}.served`, 'rd2');
    const pm = b.op1(merger(ones(n)), lanes.map((l) => `${l}.nz`), 'rs1 ≠ 0', 'pm');
    b.wire(lA, `${sc}.leadA`); b.wire(lB, `${sc}.leadB`); b.wire(pm, `${sc}.pred`);
    b.next();
    // next PC from the leader
    const fs = b.op(splitter([1, 1, 1, 1]), [lF], undefined, 'fs');
    const npc = b.add(NEXT_PC, 'next PC logic', 'npc');
    for (const [p, d] of [['zero', `${fs}.o0`], ['neg', `${fs}.o1`], ['ovf', `${fs}.o2`], ['carry', `${fs}.o3`], ['funct3', `${si}.o2`], ['branch', `${ctl}.branch`], ['jump', `${ctl}.jump`], ['jalr', `${ctl}.jalr`]]) b.wire(d, `${npc}.${p}`);
    b.wire(`${npc}.pcSrc`, `${pcmux}.s`);
    const tgt = b.add(koggeStone(32), 'PC + imm', 'target');
    b.wire(`${pc}.q`, `${tgt}.a`); b.wire(`${imm}.imm`, `${tgt}.b`); b.wire(b.op1(TIE0, [], undefined, 'gndT'), `${tgt}.cin`);
    const c0 = b.add(CLEAR_BIT0, 'jalr target', 'clr0');
    b.wire(lAlu, `${c0}.in`); b.wire(b.op1(TIE0, [], undefined, 'gndJ'), `${c0}.zero`);
    for (const [d, i] of [[p4, 0], [`${tgt}.s`, 1], [`${c0}.out`, 2], [p4, 3]] as const) b.wire(d, `${pcmux}.d${i}`);
    // the memory
    const dm = b.add(sharedMemory(dmemK), 'data memory', 'dm');
    b.wire(mAd, `${dm}.addr`); b.wire(mWd, `${dm}.wd`); b.wire('clk', `${dm}.clk`);
    b.wire(b.op1(AND, [`${ctl}.memWrite`, `${ms}.any`], 'store, a lane served', 'dwe'), `${dm}.we`);
    b.name(`${dm}.rd`, 'ReadData', true);
    lanes.forEach((l) => b.wire(`${dm}.rd`, `${l}.readData`));
    b.wire(`${pc}.q`, 'pcOut'); b.wire(nst, 'retire'); b.wire(mask, 'maskOut');
    const { at, right } = laneCoreLayout(n);
    for (const i of b.instances) {
      const p = at.get(i.name);
      if (!p) throw new Error(`laneCore: no place for ${i.name}`);
      i.at = p;
    }
    const pins: Record<string, [number, number]> = { clk: [2, 50], pcOut: [right, 2], retire: [right, 5], maskOut: [right, 8] };
    const nets = laneCoreNets(b);
    return {
      id: `lanecore${n}_${IM.id}_d${dmemK}`, name: `Lane core (${n} lanes)`, category: 'cpu',
      summary: `One fetch, decode and control unit for ${n} lanes. Each lane has its own registers and ALU; the active mask says which lanes write. The leader (lowest active lane) steers branches; loads and stores take one cycle per active lane; split / join run the two sides of an if one after the other.`,
      ports: [bit('clk', 'in', 'left', true), bus('pcOut', 32, 'out'), bit('retire', 'out'), bus('maskOut', n, 'out')],
      symbol: { kind: 'box', label: `${n}-LANE CORE` },
      netlist: () => ({ pins, instances: b.instances, nets }),
    } satisfies ComponentDef;
  });
}

/**
 * The lane core drawn in two bands. Top: fetch → decode → write enables, the sequencer, SIMT
 * control and the leader → next PC. Bottom: the lanes side by side, then the leader's and the
 * memory's one-hot multiplexers, then the memory. Grid units; the lanes' inputs arrive as labels.
 */
function laneCoreLayout(n: number): { at: Map<string, [number, number]>; right: number } {
  const at = new Map<string, [number, number]>();
  const put = (name: string, x: number, y: number) => at.set(name, [x, y]);
  // fetch: the next-PC mux, the join mux, the PC and the ROM on one row, so their wires are straight
  put('pcmux', 14, 6); put('jmux', 30, 9); put('pc', 42, 10); put('imem', 60, 11); put('plus4', 60, 18);
  put('si', 82, 7); put('csrA', 94, 15);
  // decode
  put('ctl', 110, 0); put('imm', 110, 26); put('sdec', 110, 34);
  put('rs', 142, 10); put('nr1', 146, 12); put('isLoad', 152, 10); put('isMemG', 166, 11); put('rw', 162, 1);
  // sequencer, SIMT control, leader
  put('mseq', 180, 2); put('simt', 180, 18); put('lead', 180, 42);
  // write enables, PC enable
  put('wsel', 216, 2); put('wf', 216, 12); put('weg', 226, 3); put('we', 240, 2);
  put('nst', 216, 20); put('pcen', 224, 19);
  // next PC
  put('npc', 262, 2); put('target', 262, 26); put('gndT', 258, 35); put('clr0', 262, 40); put('gndJ', 270, 43);
  // the lanes, their thread ids underneath
  const lx = (i: number) => 24 + 36 * i, y0 = 60;
  for (let i = 0; i < n; i++) { put(`lane${i}`, lx(i), y0); put(`tid${i}`, lx(i) + 4, y0 + 40); }
  // the one-hot multiplexers, stacked by their height
  const oh = symbolGeom(onehotMux(n, 32)).h, of = symbolGeom(onehotMux(n, 4)).h, gap = 8;
  const mx = lx(n) + 2, wx = mx + 34, dx = wx + 30;
  put('lAlu', mx, y0); put('lA', mx, y0 + oh + gap); put('lB', mx, y0 + 2 * (oh + gap)); put('lF', mx, y0 + 3 * (oh + gap));
  put('fs', mx + 20, y0 + 3 * (oh + gap) + of / 2 - 4);
  put('mAd', wx, y0); put('mWd', wx, y0 + oh + gap); put('pm', wx + 6, y0 + 2 * (oh + gap) + 2);
  put('dwe', dx, y0 + 12); put('dm', dx + 10, y0 + 2);
  return { at, right: Math.max(dx + 34, 290) };
}

/** Pairs drawn as wires (driver > sink); every other connection is a pair of labels. */
const WIRED = new Set([
  'pcmux.y>jmux.a', 'jmux.y>pc.d', 'pc.q>imem.addr', 'imem.data>si.in', 'si.o4>csrA.i0', 'si.o5>csrA.i1',
  'ctl.resultSrc>rs.in', 'rs.o0>isLoad.a', 'rs.o1>nr1.a', 'nr1.y>isLoad.b', 'isLoad.y>isMemG.a', 'ctl.regWrite>rw.a',
  'wsel.y>weg.a', 'wf.out>weg.b', 'weg.y>we.in', 'nst.y>pcen.a', 'gndT.y>target.cin', 'gndJ.y>clr0.zero',
  'lF.y>fs.in', 'dwe.y>dm.we', 'mAd.y>dm.addr', 'mWd.y>dm.wd',
]);
/** Blocks whose outputs are named by their port (control signals); others by instance. */
const BY_PORT = new Set(['ctl', 'sdec', 'mseq', 'simt', 'npc', 'lead', 'target']);

function laneCoreNets(b: Builder): NetDef[] {
  return b.nets().map((nt) => {
    const drv = nt.ends[0];
    const [inst, port] = drv.includes('.') ? drv.split('.') : [drv, ''];
    const name = nt.name ?? (!port ? inst : BY_PORT.has(inst) ? port : /^lane\d+$/.test(inst) ? `${inst}.${port}` : inst);
    const wired = nt.ends.slice(1).filter((s) => WIRED.has(`${drv}>${s}`));
    const tags = wired.length ? nt.ends.slice(1).filter((e) => !wired.includes(e)) : true;
    return { name, ends: nt.ends, ...(tags === true || tags.length ? { tags } : {}) };
  });
}
