// Chapter 25, part 2: one single-cycle core at either register width, so RV32IM and RV64IM can be compared from
// the same drawing. At 64 bits everything that holds or computes a register value doubles (PC, register file,
// ALU, adders, the M unit, the data path to memory), the immediate generator stays 32 bits wide (its result
// sign-extended by wiring: free), and two blocks are new: the W unit, which keeps RV32's 32-bit arithmetic
// (addw, sllw, divw, …: operands cut to 32 bits and extended in front, the result sign-extended behind), and the
// load / store unit's fourth size (ld, sd) and lwu. The ROM still holds 32-bit instruction words.
//
// User level only, like riscv/iss64.ts: no CSRs or traps; fence / ecall / ebreak do nothing. Like the other
// single-cycle cores, encodings outside the ISA are not decoded (a word the golden model ignores may still
// write a register here); every test program sticks to real instructions.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord, isZero } from './alu';
import { CONTROL, IMM_GEN, NEXT_PC, PLUS4_FAST, CLEAR_BIT0, rom } from './cpu';
import { andN, busMux2, muxTree } from './combinational';
import { define, merger, splitter } from './define';
import { fanout, koggeStone } from './fastadd';
import { AND, MUX2, NOT, OR } from './gates';
import { extWire, laneMemory, loadExtract, storeAlign } from './lsu';
import { mUnit } from './muldiv';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';

export type Xlen = 32 | 64;

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

// ---- small wide parts ------------------------------------------------------------------------------------------

/** PC + 4 at xlen bits (Kogge–Stone): 32 → PLUS4_FAST. */
export function plus4(xlen: Xlen): ComponentDef {
  if (xlen === 32) return PLUS4_FAST;
  return memo('plus4ks64', () => {
    const K = koggeStone(64), kg = symbolGeom(K);
    return define({
      id: 'plus4ks64', name: 'PC + 4 (64-bit, fast)', category: 'arithmetic',
      summary: 'PC + 4 on a 64-bit PC: a 64-bit Kogge–Stone adder with one input tied to 4. The PC is as wide as a register, because jalr, auipc and the return address all treat it as one.',
      ports: [bus('a', 64, 'in'), bus('y', 64, 'out')],
      symbol: { kind: 'box', label: '+4' },
      netlist: () => ({
        pins: { a: [0, 2 + kg.ports.a.pos[1]], y: [16 + kg.w + 6, 2 + kg.ports.s.pos[1]] },
        instances: [
          { name: 'four', def: constWord(64, 4), at: [4, 2 + kg.ports.b.pos[1] + 3] },
          { name: 'gnd', def: TIE0, at: [8, -3] },
          { name: 'add', def: K, at: [16, 2] },
        ],
        nets: [
          { name: 'a', ends: ['a', 'add.a'] },
          { name: 'four', ends: ['four.y', 'add.b'] },
          { name: 'gnd', ends: ['gnd.y', 'add.cin'] },
          { name: 'y', ends: ['add.s', 'y'] },
        ],
      }),
    });
  });
}

/** jalr's "clear bit 0" at xlen bits (wiring): 32 → CLEAR_BIT0. */
export function clearBit0(xlen: Xlen): ComponentDef {
  if (xlen === 32) return CLEAR_BIT0;
  return memo('clr0_64', () => define({
    id: 'clr0_64', name: 'Clear bit 0 (64-bit wiring)', category: 'plumbing',
    summary: 'jalr target = (rs1 + imm) with bit 0 cleared: wire bit 0 to ground.',
    ports: [bus('in', 64, 'in'), bit('zero', 'in', 'bottom'), bus('out', 64, 'out')],
    symbol: { kind: 'box', label: 'bit0 := 0', w: 6, h: 2 }, prim: 'alias',
    alias: Array.from({ length: 64 }, (_, i): [string, number, string, number] => (i === 0 ? ['zero', 0, 'out', 0] : ['in', i, 'out', i])),
  }));
}

// ---- the W unit -------------------------------------------------------------------------------------------------

/**
 * RV64's 32-bit operations (addw, subw, sllw, srlw, sraw, their immediate forms, mulw, divw, divuw, remw, remuw) on
 * the 64-bit ALU and M unit: when w = 1 the operands are cut to their low 32 bits and extended again (zero for
 * srlw and the unsigned divides, sign for sraw and the signed ones: funct7[5] picks for the ALU, funct3[0] for the
 * M unit), a shift amount's bit 5 is cleared (a W shift moves by 0–31), and the result's low 32 bits are
 * sign-extended. Two multiplexers in front, one behind, and wiring.
 */
export function wordUnit(xlen: 64 = 64): ComponentDef {
  return memo(`wunit${xlen}`, () => {
    const W = xlen, H = W / 2;
    const M2 = busMux2(W);
    const SA = splitter([H - 1, 1, H]), MA = merger([H - 1, 1, H]);
    const SB = splitter([5, 1, H - 7, 1, H]), MB = merger([5, 1, H - 7, 1, H]);
    const SR = splitter([H, H]), SX = extWire(H, W, true), F = fanout(H);
    const instances: InstanceDef[] = [
      { name: 'sa', def: SA, at: [6, 2] },
      { name: 'ga', def: AND, at: [14, 6] },
      { name: 'fa', def: F, at: [22, 7] },
      { name: 'ma', def: MA, at: [30, 2] },
      { name: 'xa', def: M2, at: [40, 1], label: 'A' },
      { name: 'sb', def: SB, at: [6, 18] },
      { name: 'g5', def: AND, at: [14, 28] },
      { name: 'gb', def: AND, at: [14, 34] },
      { name: 'fb', def: F, at: [22, 35] },
      { name: 'mb', def: MB, at: [30, 18] },
      { name: 'xb', def: M2, at: [40, 21], label: 'B' },
      { name: 'sr', def: SR, at: [6, 46] },
      { name: 'sx', def: SX, at: [14, 46] },
      { name: 'xr', def: M2, at: [40, 45], label: 'result' },
      { name: 'sf3', def: splitter([1, 2]), at: [4, 60] },
      { name: 'sf7', def: splitter([5, 1, 1]), at: [4, 68] },
      { name: 'nf0', def: NOT, at: [12, 62] },
      { name: 'sxm', def: MUX2, at: [20, 62], label: 'signed?' },
      { name: 'k5', def: OR, at: [28, 70], label: 'keep b5' },
    ];
    const nets: NetDef[] = [
      { name: 'a', ends: ['a', 'sa.in', 'xa.a'], tags: ['xa.a'] },
      { name: 'aLo', ends: ['sa.o0', 'ma.i0'] },
      { name: `a${H - 1}`, ends: ['sa.o1', 'ga.a', 'ma.i1'], tags: ['ma.i1'] },
      { name: 'fillA', ends: ['ga.y', 'fa.in'] },
      { name: 'fillsA', ends: ['fa.out', 'ma.i2'] },
      { name: 'a32', ends: ['ma.out', 'xa.b'] },
      { name: 'aw', ends: ['xa.y', 'aw'] },
      { name: 'b', ends: ['b', 'sb.in', 'xb.a'], tags: ['xb.a'] },
      { name: 'b[4:0]', ends: ['sb.o0', 'mb.i0'] },
      { name: 'b5', ends: ['sb.o1', 'g5.a'], tags: true },
      { name: `b[${H - 2}:6]`, ends: ['sb.o2', 'mb.i2'] },
      { name: `b${H - 1}`, ends: ['sb.o3', 'gb.a', 'mb.i3'], tags: true },
      { name: 'b5q', ends: ['g5.y', 'mb.i1'], tags: true },
      { name: 'fillB', ends: ['gb.y', 'fb.in'] },
      { name: 'fillsB', ends: ['fb.out', 'mb.i4'] },
      { name: 'b32', ends: ['mb.out', 'xb.b'] },
      { name: 'bw', ends: ['xb.y', 'bw'] },
      { name: 'r', ends: ['r', 'sr.in', 'xr.a'], tags: ['xr.a'] },
      { name: 'rLo', ends: ['sr.o0', 'sx.in'] },
      { name: 'rSext', ends: ['sx.out', 'xr.b'] },
      { name: 'rw', ends: ['xr.y', 'rw'] },
      { name: 'w', ends: ['w', 'xa.s', 'xb.s', 'xr.s'], tags: ['xa.s', 'xb.s', 'xr.s'] },
      { name: 'isM', ends: ['isM', 'sxm.s', 'k5.a'], tags: ['k5.a'] },
      { name: 'keep5', ends: ['k5.y', 'g5.b'], tags: true },
      { name: 'funct3', ends: ['funct3', 'sf3.in'] },
      { name: 'f0', ends: ['sf3.o0', 'nf0.a'] },
      { name: '¬f0', ends: ['nf0.y', 'sxm.b', 'k5.b'], tags: ['k5.b'] },
      { name: 'funct7', ends: ['funct7', 'sf7.in'] },
      { name: 'f7b5', ends: ['sf7.o1', 'sxm.a'], tags: true },
      { name: 'sx', ends: ['sxm.y', 'ga.b', 'gb.b'], tags: true },
    ];
    return define({
      id: `wunit${W}`, name: 'W unit (32-bit operations on RV64)', category: 'cpu',
      summary: 'RV64 kept RV32\'s 32-bit arithmetic: for addw, subw, sllw, srlw, sraw, their immediate forms and mulw / divw / divuw / remw / remuw, the operands are cut to 32 bits and zero- or sign-extended (a multiplexer in front), a shift moves by 0–31, and the result\'s low 32 bits are sign-extended (a multiplexer and wiring behind). The 64-bit ALU and M unit do the work.',
      ports: [bus('a', W, 'in'), bus('b', W, 'in'), bus('r', W, 'in'), bit('w', 'in'), bit('isM', 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'),
        bus('aw', W, 'out'), bus('bw', W, 'out'), bus('rw', W, 'out')],
      symbol: { kind: 'box', label: 'W UNIT' },
      netlist: () => ({
        pins: { a: [0, 5], b: [0, 23], r: [0, 48], w: [0, 54], isM: [0, 57], funct3: [0, 61], funct7: [0, 70], aw: [54, 4], bw: [54, 24], rw: [54, 48] },
        instances, nets,
      }),
      hdl: {
        verilog: `// w: an OP-32 / OP-IMM-32 instruction; sx: extend the operands with their sign
wire sx = isM ? ~funct3[0] : funct7[5];
assign aw = w ? {{32{sx & a[31]}}, a[31:0]} : a;
assign bw = w ? {{32{sx & b[31]}}, b[31:6], b[5] & (isM | ~funct3[0]), b[4:0]} : b;   // a W shift (funct3 x01) moves by b[4:0]
assign rw = w ? {{32{r[31]}}, r[31:0]} : r;`,
      },
    });
  });
}

// ---- decode beyond the RV32I control unit ----------------------------------------------------------------------

/**
 * The few opcode bits the control unit does not see: at 64 bits, OP-32 and OP-IMM-32 (opcode bit 3 set on OP / OP-IMM)
 * are shown to it as OP / OP-IMM (w = 1 for the W unit), and with M, OP / OP-32 with funct7 = 1 is a multiply or divide.
 */
export function xDecode(xlen: Xlen, m: boolean): ComponentDef {
  return memo(`xdec${xlen}${m ? 'm' : ''}`, () => {
    const wide = xlen === 64;
    const xG = 32; // gate column: clear of the splitter's and the inverters' labels
    const instances: InstanceDef[] = [
      { name: 'so', def: splitter([2, 1, 1, 1, 1, 1]), at: [4, 2] },
      { name: 'n2', def: NOT, at: [12, 18] },
      { name: 'n6', def: NOT, at: [12, 24] },
    ];
    const nets: NetDef[] = [{ name: 'op', ends: ['op', 'so.in'] }];
    const right = 70;
    const pins: Record<string, [number, number]> = { op: [0, 8] };
    const ports: PortDef[] = [bus('op', 7, 'in')];
    const outs: PortDef[] = [];
    const b6 = ['so.o5', 'n6.a'], b2 = ['so.o1', 'n2.a'], b3 = ['so.o2'], b4 = ['so.o3'], b5 = ['so.o4'], n6 = ['n6.y'], n2 = ['n2.y'];
    if (wide) {
      instances.push(
        { name: 'isW', def: andN(4), at: [xG, 2] },
        { name: 'nw', def: NOT, at: [36, 21] },
        { name: 'b3q', def: AND, at: [50, 19] },
        { name: 'mo', def: merger([2, 1, 1, 1, 1, 1]), at: [62, 2] },
      );
      n6.push('isW.i0'); b4.push('isW.i1'); b3.push('isW.i2', 'b3q.a'); n2.push('isW.i3');
      nets.push(
        { name: 'op[1:0]', ends: ['so.o0', 'mo.i0'], tags: true },
        { name: 'isW', ends: ['isW.y', 'nw.a', 'isW'], tags: ['isW'] },
        { name: '¬isW', ends: ['nw.y', 'b3q.b'] },
        { name: 'op3q', ends: ['b3q.y', 'mo.i2'], tags: true },
        { name: 'opInt', ends: ['mo.out', 'opInt'] },
      );
      b2.push('mo.i1'); b4.push('mo.i3'); b5.push('mo.i4'); b6.push('mo.i5');
      pins.opInt = [right, 8];
      pins.isW = [right, 14];
      outs.push(bus('opInt', 7, 'out'), bit('isW', 'out'));
    }
    if (m) {
      // OP (and OP-32 at 64 bits: opcode bit 3 not looked at) with funct7 = 0000001
      const yM = 32;
      instances.push(
        { name: 'isOP', def: andN(wide ? 4 : 5), at: [xG, yM] },
        { name: 'sf', def: splitter([1, 6]), at: [4, yM + 12] },
        { name: 'z6', def: isZero(6), at: [20, yM + 14] },
        { name: 'f7one', def: AND, at: [xG + 6, yM + 14] },
        { name: 'isM', def: AND, at: [50, yM + 4] },
      );
      if (!wide) instances.push({ name: 'n3', def: NOT, at: [12, 30] });
      const gi = (i: number) => `isOP.i${i}`;
      n6.push(gi(0)); b5.push(gi(1)); b4.push(gi(2));
      if (wide) n2.push(gi(3));
      else { b3.push('n3.a'); nets.push({ name: '¬op3', ends: ['n3.y', gi(3)], tags: true }); n2.push(gi(4)); }
      nets.push(
        { name: 'funct7', ends: ['funct7', 'sf.in'] },
        { name: 'f7[0]', ends: ['sf.o0', 'f7one.a'], tags: true },
        { name: 'f7[6:1]', ends: ['sf.o1', 'z6.a'] },
        { name: 'f7hi0', ends: ['z6.z', 'f7one.b'] },
        { name: 'isOP', ends: ['isOP.y', 'isM.a'] },
        { name: 'f7one', ends: ['f7one.y', 'isM.b'] },
        { name: 'isM', ends: ['isM.y', 'isM'] },
      );
      pins.funct7 = [0, yM + 14];
      pins.isM = [right, yM + 6];
      ports.push(bus('funct7', 7, 'in'));
      outs.push(bit('isM', 'out'));
    }
    nets.push(
      { name: 'op6', ends: b6, tags: true }, { name: 'op2', ends: b2, tags: true }, { name: 'op5', ends: b5, tags: true },
      { name: 'op4', ends: b4, tags: true }, { name: '¬op6', ends: n6, tags: true }, { name: '¬op2', ends: n2, tags: true },
    );
    if (b3.length > 1) nets.push({ name: 'op3', ends: b3, tags: true });
    return define({
      id: `xdec${xlen}${m ? 'm' : ''}`, name: wide ? (m ? 'RV64 W / M decoder' : 'RV64 W decoder') : 'M decoder', category: 'cpu',
      summary: [wide ? 'OP-32 and OP-IMM-32 are OP and OP-IMM with opcode bit 3 set: clear that bit for the control unit, which then treats addw like add, and raise w for the W unit.' : '',
        m ? `A multiply or divide is OP${wide ? ' or OP-32' : ''} with funct7 = 0000001.` : ''].filter(Boolean).join(' '),
      ports: [...ports, ...outs],
      symbol: { kind: 'box', label: wide ? 'RV64 DEC' : 'M DEC' },
      netlist: () => ({ pins, instances, nets }),
    });
  });
}

// ---- the core ---------------------------------------------------------------------------------------------------

export interface XlenCpuOptions {
  xlen: Xlen;
  /** The M extension: the M unit beside the ALU; divides stall the core (retire = 0) for xlen + 2 cycles. */
  m?: boolean;
  /** Instruction ROM of 2^imemK 32-bit words (default 6). */
  imemK?: number;
  /** Data memory of 2^dmemK words of xlen bits (default 5). */
  dmemK?: number;
}

/**
 * The single-cycle core at 32 or 64 bits (RV32I(M) / RV64I(M), user level), drawn the same way at both widths.
 * Ports: clk; pcOut (xlen), instrOut (32), aluOut (xlen); retire with m. Instances: pc, imem, rf, dm (xlen / 8 byte
 * banks b0…), alu, ctl, npc, st / ld (store alignment, load extraction), wu (the W unit, 64 only), md (M unit),
 * xd (the extra decoder).
 */
export function xlenCpu(program: number[], opts: XlenCpuOptions): ComponentDef {
  const xlen = opts.xlen, m = !!opts.m, imemK = opts.imemK ?? 6, dmemK = opts.dmemK ?? 5;
  const IM = rom(program, imemK);
  return memo(`xcpu${xlen}${m ? 'm' : ''}_${IM.id}_${imemK}_${dmemK}`, () => buildXlen(IM, xlen, m, dmemK));
}

function buildXlen(IM: ComponentDef, X: Xlen, m: boolean, dmemK: number): ComponentDef {
  const wide = X === 64;
  const PC = register(X), RF = regfile(5, X), ALU = alu(X, 'ks'), DM = laneMemory(dmemK, X), ST = storeAlign(X), LD = loadExtract(X);
  const M2 = busMux2(X), M4 = muxTree(2, X), ADD = koggeStone(X), SI = splitter([7, 5, 3, 5, 5, 7]);
  const P4 = plus4(X), CLR = clearBit0(X), WU = wide ? wordUnit(64) : null, MD = m ? mUnit(X) : null, XD = wide || m ? xDecode(X, m) : null;
  const lb = wide ? 3 : 2; // byte-offset bits
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const defs = new Map<string, ComponentDef>();
  const place = (name: string, def: ComponentDef, xy: [number, number]) => { at.set(name, xy); defs.set(name, def); };
  const P = (inst: string, port: string): [number, number] => {
    const a = at.get(inst)!, p = g(defs.get(inst)!).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  };
  const alignY = (inst: string, def: ComponentDef, x: number, port: string, y: number) => place(inst, def, [x, y - g(def).ports[port].pos[1]]);

  const Y = 40; // main datapath row
  alignY('pcmux', M4, 2, 'y', Y);
  alignY('pc', PC, 12, 'd', Y);
  if (!m) place('one', TIE1, [8, P('pc', 'en')[1] - 1]);
  const pcY = P('pc', 'q')[1];
  // the ROM sees the PC's low 32 bits (its index is pc[imemK + 1:2])
  if (wide) place('pclo', splitter([32, 32]), [27, pcY - 2]);
  alignY('imem', IM, 34, 'addr', wide ? P('pclo', 'o0')[1] : pcY);
  const instrY = P('imem', 'data')[1];
  alignY('si', SI, 54, 'in', instrY);
  alignY('rf', RF, 72, 'wa', P('si', 'o1')[1]);
  alignY('imm', IMM_GEN, 68, 'instr', Y + 20);
  if (wide) alignY('sxi', extWire(32, 64, true), P('imm', 'imm')[0] + 6, 'in', P('imm', 'imm')[1]);
  const rfR = at.get('rf')![0] + g(RF).w;
  alignY('srcA', M2, rfR + 8, 'a', P('rf', 'rd1')[1]);
  alignY('srcB', M2, rfR + 8, 'a', P('rf', 'rd2')[1] + 9);
  if (WU) alignY('wu', WU, rfR + 26, 'a', P('srcA', 'y')[1]);
  const aluX = WU ? at.get('wu')![0] + g(WU).w + 12 : rfR + 18;
  alignY('alu', ALU, aluX, 'a', WU ? P('wu', 'aw')[1] : P('srcA', 'y')[1]);
  const aluR = aluX + g(ALU).w;
  alignY('st', ST, aluR + 12, 'wd', Y + 20);
  const dmX = aluR + 34;
  alignY('dm', DM, dmX, 'addr', P('alu', 'y')[1]);
  alignY('ld', LD, dmX + g(DM).w + 12, 'rdata', P('dm', 'rdata')[1]);
  alignY('res', M4, P('ld', 'value')[0] + 12, 'd1', P('ld', 'value')[1]);
  place('plus4', P4, [34, Y - 12]);
  alignY('target', ADD, rfR + 18, 'a', Y + 30);
  place('gndT', TIE0, [P('target', 'cin')[0] - 7, P('target', 'cin')[1] - 5]);
  alignY('clr0', CLR, aluR + 12, 'in', Y + 44);
  place('gndJ', TIE0, [P('clr0', 'zero')[0] - 6, P('clr0', 'zero')[1] + 1]);
  place('ctl', CONTROL, [12, 0]);
  place('npc', NEXT_PC, [72, 0]);
  if (XD) place('xd', XD, [6, Y + 64]);
  place('adr', splitter([lb, X - lb]), [dmX, Y + 30]);
  place('fs', splitter([2, 1]), [dmX, Y + 36]);
  const bottom = Y + 56;
  if (MD) {
    place('md', MD, [aluX - 4, bottom + 8]);
    alignY('mres', M2, aluR + 4, 'a', P('alu', 'y')[1] - 14);
    place('yes', TIE1, [aluX - 14, bottom + 24]);
    place('nstall', NOT, [aluX + g(MD).w + 4, P('md', 'stall')[1] - 1]);
    place('rwg', AND, [60, bottom - 8]);
  }
  if (wide && !m) place('gndM', TIE0, [P('wu', 'rw')[0] + 4, P('wu', 'rw')[1] + 10]);

  const labels: Record<string, string> = { pcmux: 'next PC', pc: 'PC', srcA: 'SrcA', srcB: 'SrcB', res: 'result', target: 'PC + imm', wu: 'W unit', md: 'M unit', mres: 'ALU / M', st: 'store', ld: 'load' };
  const instances: InstanceDef[] = [...at.keys()].map((name) => ({ name, def: defs.get(name)!, at: at.get(name), label: labels[name] }));

  const pcq = P('pc', 'q');
  const immOut = wide ? P('sxi', 'out') : P('imm', 'imm');
  const clkVia: Record<string, [number, number][]> = {};
  for (const u of ['pc', 'rf']) clkVia[`${u}.clk`] = [[P(u, 'clk')[0], bottom]];
  const nets: NetDef[] = [
    // fetch
    { name: 'PCNext', ends: ['pcmux.y', 'pc.d'] },
    ...(m ? [] : [{ name: 'en', ends: ['one.y', 'pc.en'] }]),
    { name: 'PC', ends: ['pc.q', wide ? 'pclo.in' : 'imem.addr', 'plus4.a', 'srcA.b', 'target.a', 'pcOut'], trunk: pcq[0] + 3, tags: ['srcA.b', 'target.a', 'pcOut'] },
    ...(wide ? [{ name: 'PC[31:0]', ends: ['pclo.o0', 'imem.addr'] }] : []),
    { name: 'PCPlus4', ends: ['plus4.y', 'pcmux.d0', 'pcmux.d3', 'res.d2'], tags: true },
    { name: 'PCTarget', ends: ['target.s', 'pcmux.d1'], tags: true },
    { name: 'JalrTarget', ends: ['clr0.out', 'pcmux.d2'], tags: true },
    { name: 'PCSrc', ends: ['npc.pcSrc', 'pcmux.s'], tags: true },
    // decode
    { name: 'Instr', ends: ['imem.data', 'si.in', 'imm.instr', 'instrOut'], trunk: 52, tags: ['instrOut'] },
    { name: 'op', ends: ['si.o0', wide ? 'xd.op' : 'ctl.op', ...(m && !wide ? ['xd.op'] : [])], tags: true },
    ...(wide ? [{ name: 'opInt', ends: ['xd.opInt', 'ctl.op'], tags: true as const }, { name: 'isW', ends: ['xd.isW', 'wu.w'], tags: true as const }] : []),
    { name: 'rd', ends: ['si.o1', 'rf.wa'] },
    { name: 'funct3', ends: ['si.o2', 'ctl.funct3', 'npc.funct3', 'ld.funct3', 'fs.in', ...(WU ? ['wu.funct3'] : []), ...(MD ? ['md.funct3'] : [])], tags: true },
    { name: 'rs1', ends: ['si.o3', 'rf.ra1'], trunk: 64 },
    { name: 'rs2', ends: ['si.o4', 'rf.ra2'], trunk: 65.5 },
    { name: 'funct7', ends: ['si.o5', 'ctl.funct7', ...(WU ? ['wu.funct7'] : []), ...(m ? ['xd.funct7'] : [])], tags: true },
    ...(wide
      ? [{ name: 'Imm32', ends: ['imm.imm', 'sxi.in'] }, { name: 'ImmExt', ends: ['sxi.out', 'srcB.b', 'target.b', 'res.d3'], trunk: immOut[0] + 3, tags: ['res.d3'] }]
      : [{ name: 'ImmExt', ends: ['imm.imm', 'srcB.b', 'target.b', 'res.d3'], trunk: immOut[0] + 3, tags: ['res.d3'] }]),
    // execute
    { name: 'rd1', ends: ['rf.rd1', 'srcA.a'] },
    { name: 'WriteData', ends: ['rf.rd2', 'srcB.a', 'st.wd'], trunk: rfR + 2.5, tags: ['st.wd'] },
    { name: 'SrcA', ends: ['srcA.y', WU ? 'wu.a' : 'alu.a', ...(MD && !WU ? ['md.a'] : [])], tags: MD && !WU ? ['md.a'] : undefined },
    { name: 'SrcB', ends: ['srcB.y', WU ? 'wu.b' : 'alu.b', ...(MD && !WU ? ['md.b'] : [])], tags: MD && !WU ? ['md.b'] : undefined },
    ...(WU ? [
      { name: 'OpA', ends: ['wu.aw', 'alu.a', ...(MD ? ['md.a'] : [])], tags: MD ? ['md.a'] : undefined },
      { name: 'OpB', ends: ['wu.bw', 'alu.b', ...(MD ? ['md.b'] : [])], tags: MD ? ['md.b'] : undefined },
      { name: 'WResult', ends: ['wu.rw', 'res.d0'], tags: true as const },
    ] : []),
    {
      name: 'ALUResult', ends: ['alu.y', 'dm.addr', 'clr0.in', 'adr.in', 'aluOut', ...(MD ? ['mres.a'] : WU ? ['wu.r'] : ['res.d0'])],
      tags: ['clr0.in', 'adr.in', 'aluOut', ...(MD ? [] : WU ? ['wu.r'] : ['res.d0'])],
    },
    ...(MD ? [
      { name: 'MResult', ends: ['md.y', 'mres.b'], tags: true as const },
      { name: 'ExecResult', ends: ['mres.y', WU ? 'wu.r' : 'res.d0'], tags: true as const },
    ] : []),
    { name: `addr[${lb - 1}:0]`, ends: ['adr.o0', 'st.addr', 'ld.addr'], tags: true },
    { name: 'size', ends: ['fs.o0', 'st.size'], tags: true },
    { name: 'StoreData', ends: ['st.wdata', 'dm.wdata'], tags: true },
    { name: 'ByteEn', ends: ['st.be', 'dm.be'], tags: true },
    { name: 'ReadData', ends: ['dm.rdata', 'ld.rdata'] },
    { name: 'LoadValue', ends: ['ld.value', 'res.d1'] },
    { name: 'Result', ends: ['res.y', 'rf.wd'], tags: true },
    { name: 'gndT', ends: ['gndT.y', 'target.cin'], via: { 'target.cin': [[P('target', 'cin')[0], P('gndT', 'y')[1]]] } },
    { name: 'gndJ', ends: ['gndJ.y', 'clr0.zero'], via: { 'clr0.zero': [[P('clr0', 'zero')[0], P('gndJ', 'y')[1]]] } },
    { name: 'clk', ends: ['clk', 'pc.clk', 'rf.clk', 'dm.clk', ...(MD ? ['md.clk'] : [])], via: clkVia, tags: ['dm.clk', ...(MD ? ['md.clk'] : [])] },
    // control, as net labels
    { name: 'RegWrite', ends: ['ctl.regWrite', m ? 'rwg.a' : 'rf.we'], tags: true },
    { name: 'ImmSrc', ends: ['ctl.immSrc', 'imm.src'], tags: true },
    { name: 'ALUSrcA', ends: ['ctl.aluSrcA', 'srcA.s'], tags: true },
    { name: 'ALUSrcB', ends: ['ctl.aluSrcB', 'srcB.s'], tags: true },
    { name: 'MemWrite', ends: ['ctl.memWrite', 'dm.we'], tags: true },
    { name: 'ResultSrc', ends: ['ctl.resultSrc', 'res.s'], tags: true },
    { name: 'Branch', ends: ['ctl.branch', 'npc.branch'], tags: true },
    { name: 'Jump', ends: ['ctl.jump', 'npc.jump'], tags: true },
    { name: 'Jalr', ends: ['ctl.jalr', 'npc.jalr'], tags: true },
    { name: 'ALUControl', ends: ['ctl.aluCtl', 'alu.ctl'], tags: true },
    { name: 'Zero', ends: ['alu.zero', 'npc.zero'], tags: true },
    { name: 'Neg', ends: ['alu.neg', 'npc.neg'], tags: true },
    { name: 'Ovf', ends: ['alu.ovf', 'npc.ovf'], tags: true },
    { name: 'Carry', ends: ['alu.carry', 'npc.carry'], tags: true },
    ...(MD ? [
      { name: 'isM', ends: ['xd.isM', 'md.isM', 'mres.s', ...(WU ? ['wu.isM'] : [])], tags: true as const },
      { name: 'noTrap', ends: ['yes.y', 'md.noTrap'], tags: true as const },
      { name: 'stall', ends: ['md.stall', 'nstall.a'] },
      { name: 'retire', ends: ['nstall.y', 'pc.en', 'rwg.b', 'retire'], tags: ['pc.en', 'rwg.b', 'retire'] },
      { name: 'RegWriteQ', ends: ['rwg.y', 'rf.we'], tags: true as const },
    ] : []),
    ...(wide && !m ? [{ name: 'gndM', ends: ['gndM.y', 'wu.isM'], tags: true as const }] : []),
  ];
  const resY = P('res', 'y');
  const ox = resY[0] + 22;
  const pins: Record<string, [number, number]> = { clk: [0, bottom], pcOut: [ox, bottom - 8], instrOut: [ox, bottom - 5], aluOut: [ox, bottom - 2], ...(m ? { retire: [ox, bottom + 1] } : {}) };
  const isa = `RV${X}I${m ? 'M' : ''}`;
  return {
    id: `x${X}${m ? 'm' : ''}_${IM.id.replace(/^rom_/, '')}${dmemK !== 5 ? `_d${dmemK}` : ''}`, name: `Single-cycle ${isa} CPU`, category: 'cpu',
    summary: wide
      ? `The single-cycle core at 64 bits: a 64-bit PC, 32 registers of 64 bits, a 64-bit ALU${m ? ' and M unit' : ''}, and a data memory of doublewords in eight byte banks (ld / sd beside lb … sw, and lwu). The immediate generator stays 32 bits wide; its result is sign-extended by wiring, at no cost. The W unit keeps RV32's 32-bit arithmetic (addw, sllw${m ? ', mulw, divw' : ''}, …).${m ? ' Divides take 66 cycles on the iterative divider (retire = 0 meanwhile).' : ''}`
      : `The single-cycle core at 32 bits, drawn as its 64-bit twin: RV32I${m ? 'M' : ''} with byte and halfword loads and stores on four byte banks.${m ? ' Divides take 34 cycles on the iterative divider (retire = 0 meanwhile).' : ''}`,
    ports: [bit('clk', 'in', 'left', true), bus('pcOut', X, 'out'), bus('instrOut', 32, 'out'), bus('aluOut', X, 'out'), ...(m ? [bit('retire', 'out')] : [])],
    symbol: { kind: 'box', label: isa },
    netlist: () => ({ pins, instances, nets }),
  };
}

/** The variants the chapter shows (and the schematic tests check). */
export function xlenTops(program: number[]): ComponentDef[] {
  return [xlenCpu(program, { xlen: 32, m: true }), xlenCpu(program, { xlen: 64, m: true }), xlenCpu(program, { xlen: 64 })];
}

