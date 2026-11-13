// The Vectors chapter's vector unit in gates (docs/PLAN-RVV.md, "Gates"): the RVV 1.0 subset of riscv/rvv.ts with
// IssOptions.v.gates (SEW 32 only, no vmul, unit-stride 32-bit loads and stores), VLEN 128 on four lanes.
//
// A lane holds a 32-bit slice of all 32 vector registers (lane i: bytes 4i … 4i+3 of each, element i of a register at
// e32), its own ALU, compares and result multiplexer: that is how Ara and Hwacha cut theirs. An instruction on a group
// of L registers (LMUL) takes L beats, one register of the group a beat, the four lanes side by side; the scalar core
// waits (retire low, the PC held) until the last beat. A mask compare and vredsum add a first beat that reads the old
// mask word or vs1[0] into the accumulator, and write lane 0's word of vd on the last.
//
// Tail and masked-off elements are left undisturbed: a lane does not write them (a write enable per element), so the
// mask needs no third read port: V0_SHADOW keeps a copy of v0's lane-0 word (the mask bits of elements 0 … 31: at e32
// and VLEN 128, VLMAX is 32 at most), written whenever lane 0 writes v0.
//
// The data memory (vecMemory) is four word-interleaved banks: a beat's four elements are four consecutive words, so
// they fall in four different banks whatever the base, the lanes rotated by the base's word offset.
//
// Anything outside the subset, and every illegal instruction, does nothing for one cycle, as the golden model does in
// user mode (riscv/rvv.ts execV with gates: e8 / e16 set vill; vmul, strided and narrow accesses are illegal).

import type { ComponentDef, PortDef } from '../sim/types';
import { VILL, vlmaxOf, vtypeOf } from '../riscv/rvv';
import { alu, aluSpec, constWord, isZero } from './alu';
import { Builder } from './builder';
import { laid, type LayeredOptions } from './layered';
import { andN, busMux2, decoder, equal, incrementer, muxTree, rca } from './combinational';
import { magComparator } from './coding';
import { define, merger, ones, splitter } from './define';
import { fanout } from './fastadd';
import { AND, MUX2, NOT, OR, XNOR, XOR } from './gates';
import { ram } from './memory';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';
import { numOf } from '../chapters/order';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });
const clkPort = bit('clk', 'in', 'bottom', true);
const K = (w: number, v: number) => constWord(w, v >>> 0);

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** The lanes and VLEN of the gate-level unit (the only shape built). */
export const VEC_LANES = 4, VEC_VLEN = 128;

/** Small helpers over a Builder: n-input gates as one part, constants, a bus's bits. */
function kit(b: Builder) {
  const and = (...xs: string[]) => (xs.length === 1 ? xs[0] : b.op1(xs.length === 2 ? AND : andN(xs.length), xs));
  const or = (...xs: string[]) => (xs.length === 1 ? xs[0] : b.op1(xs.length === 2 ? OR : orN(xs.length), xs));
  const not = (x: string) => b.op1(NOT, [x]);
  const k = (w: number, v: number) => (w === 1 ? b.op1(v ? TIE1 : TIE0, []) : b.op1(K(w, v), []));
  const bits = (x: string, n: number) => { const s = b.op(splitter(ones(n)), [x]); return Array.from({ length: n }, (_, i) => `${s}.o${i}`); };
  const fan = (x: string, n: number) => b.op1(fanout(n), [x]);
  return { and, or, not, k, bits, fan };
}

/** Pins down the left edge and up the right, 4 units apart, for a Builder block. */
function edgePins(b: Builder, ins: string[], outs: string[]): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  ins.forEach((p, i) => (pins[p] = [0, 2 + 4 * i]));
  outs.forEach((p, i) => (pins[p] = [b.right, 2 + 4 * i]));
  return pins;
}

/** A block of a larger unit, laid out by layered.ts (aspect near the canvas's): what a reader opens one at a time. */
function vecBlock(id: string, name: string, label: string, summary: string, ports: PortDef[], build: (b: Builder) => void, opts: LayeredOptions = {}): ComponentDef {
  const b = new Builder();
  b.pins(...ports.filter((p) => p.dir === 'in').map((p) => p.name));
  build(b);
  return define({ id, name, category: 'cpu', summary, ports, symbol: { kind: 'box', label: label.toUpperCase() }, netlist: laid(b, { aspect: 1.6, room: true, keepOrder: true, ...opts }) });
}

/** Is register r misaligned for a group of 2^lmul registers (r mod L ≠ 0)? */
export const VGROUP: ComponentDef = (() => {
  const b = new Builder();
  const { and, or } = kit(b);
  const [r0, r1, r2] = kit(b).bits('r', 5);
  const [l0, l1] = kit(b).bits('lmul', 2);
  b.next();
  const g2 = or(l0, l1), g8 = and(l0, l1);
  b.next();
  b.wire(or(and(r0, g2), and(r1, l1), and(r2, g8)), 'mis');
  return define({
    id: 'vgroup', name: 'Group alignment', category: 'cpu',
    summary: 'A register group of L = 2^lmul registers must start on a multiple of L: v8 can head a group of 8, v4 one of 4 but not of 8. mis = 1 when r mod L ≠ 0, which makes the instruction illegal.',
    ports: [bus('r', 5, 'in'), bus('lmul', 2, 'in'), bit('mis', 'out')],
    symbol: { kind: 'box', label: 'r mod L ≠ 0' },
    spec: ([r, lmul]) => [r % (1 << Math.min(lmul, 3)) ? 1 : 0],
    netlist: () => ({ pins: edgePins(b, ['r', 'lmul'], ['mis']), instances: b.instances, nets: b.nets() }),
  });
})();

/** Is vd inside the group that starts at r but not its first register (a mask result may only sit on the first)? */
export const VINSIDE: ComponentDef = (() => {
  const b = new Builder();
  const { and, or, not } = kit(b);
  const d = kit(b).bits('vd', 5), r = kit(b).bits('r', 5);
  const [l0, l1] = kit(b).bits('lmul', 2);
  b.next();
  const g2 = or(l0, l1), g8 = and(l0, l1);
  const same = d.map((x, i) => b.op1(XNOR, [x, r[i]]));
  b.next();
  const hi = and(same[4], same[3], or(same[2], g8), or(same[1], l1), or(same[0], g2));
  const low = or(and(d[0], g2), and(d[1], l1), and(d[2], g8));
  b.next();
  b.wire(and(hi, low), 'inside');
  void not;
  return define({
    id: 'vinside', name: 'Inside a group', category: 'cpu',
    summary: 'A compare writes one mask register, which may overlap a source group only on the group\'s first register. inside = 1 when vd lies in the group of L = 2^lmul registers starting at r but is not r itself: the instruction is then illegal.',
    ports: [bus('vd', 5, 'in'), bus('r', 5, 'in'), bus('lmul', 2, 'in'), bit('inside', 'out')],
    symbol: { kind: 'box', label: 'vd in (r, r+L)' },
    // r is taken as aligned (a misaligned source group makes the instruction illegal on its own): vd in r's aligned group, not its first
    spec: ([vd, r, lmul]) => { const L = 1 << lmul; return [(vd & ~(L - 1)) === (r & ~(L - 1)) && vd % L !== 0 ? 1 : 0]; },
    netlist: () => ({ pins: edgePins(b, ['vd', 'r', 'lmul'], ['inside']), instances: b.instances, nets: b.nets() }),
  });
})();

const DEC_OUTS = ['set', 'elem', 'mask', 'red', 'mvxs', 'mvsx', 'load', 'store', 'csr', 'multi', 'pre', 'vv', 'isX', 'imm', 'swap', 'aluCtl', 'mergeLike', 'minS', 'isMax', 'cmpSel', 'resSel', 'masked'] as const;

/**
 * What a word asks of the vector unit, and whether it is legal now (vtype valid, groups aligned, no masked write to
 * v0, a mask result not inside a source group). The class outputs (elem … csr) are 1 only for a legal instruction of
 * the subset; the operation outputs say how the lanes compute.
 */
export const VEC_DECODE: ComponentDef = (() => {
  // Three blocks a reader opens one at a time: the fields (what the word's bits say, the immediate, vset and csrr), the forms
  // (which instruction of the subset, and how the lanes compute it) and the legality (vtype, groups, v0) with the classes it
  // lets through. Each gate is the one the flat drawing had, moved into the block that uses it (tests/vector.test.ts pins them).
  const FIELDS = vecBlock('vdec_fields', 'Vector decoder: fields', 'fields', 'The word cut into its fields: the opcode compared with OP-V, LOAD-FP, STORE-FP and SYSTEM, registers x0 or not, csrr of the vector CSRs; a compare is funct6 = 011xxx, and funct6\'s low bits pick the compare and min / max.', [
    bus('instr', 32, 'in'),
    bit('isV', 'out'), bit('isLd', 'out'), bit('isSt', 'out'), bus('f3', 3, 'out'), bus('f6', 6, 'out'), bus('vd', 5, 'out'), bus('rs1', 5, 'out'), bus('vs2', 5, 'out'),
    bit('vmb', 'out'), bit('masked', 'out'), bit('rs1z', 'out'), bit('vs2z', 'out'), bit('vdz', 'out'), bit('vidSrc', 'out'), bit('isCmp', 'out'),
    bit('csr', 'out'), bit('minS', 'out'), bit('isMax', 'out'), bus('cmpSel', 3, 'out'),
  ], (b) => {
    const { and, or, not, k, bits } = kit(b);
    const fs = b.op(splitter([7, 5, 3, 5, 5, 1, 6]), ['instr'], 'fields');
    const op = `${fs}.o0`, vd = `${fs}.o1`, f3 = `${fs}.o2`, rs1 = `${fs}.o3`, vs2 = `${fs}.o4`, vmb = `${fs}.o5`, f6 = `${fs}.o6`;
    b.next();
    const eqK = (x: string, w: number, v: number, label?: string) => b.op1(equal(w), [x, k(w, v)], label);
    const isSys = eqK(op, 7, 0x73, 'SYSTEM?');
    const f6b = bits(f6, 6), f3b = bits(f3, 3);
    const csrA = b.op1(merger([5, 1, 6]), [vs2, vmb, f6], 'csr address');
    b.next();
    const csrHit = or(...[0x008, 0x009, 0x00a, 0x00f, 0xc20, 0xc21, 0xc22].map((a) => eqK(csrA, 12, a)));
    b.next();
    b.wire(and(isSys, or(f3b[0], f3b[1]), csrHit), 'csr');
    b.wire(eqK(op, 7, 0x57, 'OP-V?'), 'isV');
    b.wire(eqK(op, 7, 0x07, 'vector load?'), 'isLd');
    b.wire(eqK(op, 7, 0x27, 'vector store?'), 'isSt');
    b.wire(f3, 'f3'); b.wire(f6, 'f6');
    b.wire(vd, 'vd'); b.wire(rs1, 'rs1'); b.wire(vs2, 'vs2'); b.wire(vmb, 'vmb'); b.wire(not(vmb), 'masked');
    b.wire(b.op1(isZero(5), [rs1]), 'rs1z'); b.wire(b.op1(isZero(5), [vs2]), 'vs2z'); b.wire(b.op1(isZero(5), [vd]), 'vdz');
    b.wire(eqK(rs1, 5, 0x11, 'vid?'), 'vidSrc');
    b.wire(and(not(f6b[5]), f6b[4], f6b[3]), 'isCmp');
    b.wire(f6b[0], 'minS');
    b.wire(f6b[1], 'isMax');
    b.wire(b.op1(merger([1, 1, 1]), [f6b[0], f6b[1], f6b[2]]), 'cmpSel');
  });

  const FORMS = vecBlock('vdec_forms', 'Vector decoder: forms', 'forms', 'funct3 and funct6 decoded one-hot: which instruction of the subset the word is (vset*, an OPI operation in a form it has, vmerge / vmv.v, vredsum, vmv.x.s, vmv.s.x, vid, a unit-stride access) before any legality check, and how the lanes compute it: operand B, the 5-bit immediate signed or not, vrsub\'s swap, the ALU operation, the result.', [
    bit('isV', 'in'), bit('isLd', 'in'), bit('isSt', 'in'), bus('f3', 3, 'in'), bus('f6', 6, 'in'), bus('rs1', 5, 'in'), bit('vmb', 'in'), bit('masked', 'in'), bit('rs1z', 'in'), bit('vs2z', 'in'), bit('vidSrc', 'in'), bit('isCmp', 'in'),
    bit('set', 'out'), bit('opi', 'out'), bit('merge', 'out'), bit('red', 'out'), bit('mvxs', 'out'), bit('vid', 'out'), bit('mvsx', 'out'), bit('mem', 'out'),
    bit('vv', 'out'), bit('isX', 'out'), bus('imm', 32, 'out'), bit('swap', 'out'), bus('aluCtl', 4, 'out'), bit('mergeLike', 'out'), bus('resSel', 2, 'out'),
  ], (b) => {
    const { and, or, not, k, bits } = kit(b);
    const f3d = b.op(decoder(3), ['f3'], 'funct3');
    const f6d = b.op(decoder(6), ['f6'], 'funct6');
    const f6b = bits('f6', 6);
    const imm = b.op1(busMux2(32), [b.op1(merger([5, 27]), ['rs1', b.op1(fanout(27), [bits('rs1', 5)[4]])], 'simm5'), b.op1(merger([5, 27]), ['rs1', k(27, 0)], 'uimm5'), ''], 'immediate');
    const D = (i: number) => `${f6d}.y${i}`, F = (i: number) => `${f3d}.y${i}`;
    const vv = F(0), vi = F(3), vx = F(4), mvv = F(2), mvx = F(6);
    b.next();
    b.wire(or(D(0x25), D(0x28), D(0x29)), `${imm.slice(0, imm.indexOf('.'))}.s`);
    // vsetvli (bit 31 = 0), vsetivli (31:30 = 11), vsetvl (31:25 = 1000000); other words of the group are not vsets
    b.wire(b.op1(andN(3), ['isV', F(7), or(not(f6b[5]), f6b[4], and(D(0x20), 'masked'))], 'vset?', 'vset'), 'set');
    const opiF3 = and('isV', or(vv, vi, vx));
    const allF = or(...[0x00, 0x09, 0x0a, 0x0b, 0x18, 0x19, 0x1c, 0x1d, 0x25, 0x28, 0x29].map(D));
    const vvx = or(...[0x02, 0x04, 0x05, 0x06, 0x07, 0x1a, 0x1b].map(D));
    const vxi = or(...[0x03, 0x1e, 0x1f].map(D));
    b.next();
    const formOk = or(allF, and(vvx, or(vv, vx)), and(vxi, or(vx, vi)));
    b.wire(and(opiF3, formOk), 'opi');
    b.wire(and(opiF3, D(0x17), or('masked', 'vs2z')), 'merge');
    b.wire(and('isV', mvv, D(0x00)), 'red');
    b.wire(and('isV', mvv, D(0x10), 'rs1z', 'vmb'), 'mvxs');
    b.wire(and('isV', mvv, D(0x14), 'vidSrc', 'vs2z'), 'vid');
    b.wire(and('isV', mvx, D(0x10), 'vs2z', 'vmb'), 'mvsx');
    b.wire(and(or('isLd', 'isSt'), F(6), D(0x00), 'vs2z'), 'mem');
    const mergeLike = or(and(opiF3, D(0x17)), and(mvx, D(0x10)));
    const picked = or(and(opiF3, or(D(4), D(5), D(6), D(7))), mergeLike);
    const vidOp = and(mvv, D(0x14));
    b.next();
    b.wire(vv, 'vv');
    b.wire(or(vx, mvx), 'isX');
    b.wire(imm, 'imm');
    b.wire(D(0x03), 'swap');
    const sub = or(D(0x02), D(0x03), D(0x04), D(0x05), D(0x06), D(0x07), 'isCmp');
    b.wire(b.op1(merger([1, 1, 1, 1]), [or(D(0x09), D(0x25), D(0x28), D(0x29)), or(D(0x09), D(0x0a)), or(D(0x09), D(0x0a), D(0x0b), D(0x28), D(0x29)), or(sub, D(0x29))], 'ALU control'), 'aluCtl');
    b.wire(mergeLike, 'mergeLike');
    b.wire(b.op1(merger([1, 1]), [or(picked, 'isLd'), or(vidOp, 'isLd')], 'result select'), 'resSel');
  }, { wires: { 'vset.y': true } });

  const LEGAL = vecBlock('vdec_legal', 'Vector decoder: legality', 'legality', 'Is the instruction legal now: vtype valid (ok), its register groups aligned to LMUL, no masked write to v0, a mask result not inside a source group. Only then do the class outputs (elem … store) go to 1; anything else does nothing for a cycle.', [
    bus('vd', 5, 'in'), bus('rs1', 5, 'in'), bus('vs2', 5, 'in'), bus('lmul', 2, 'in'), bit('ok', 'in'), bit('masked', 'in'), bit('vdz', 'in'), bit('vv', 'in'), bit('isCmp', 'in'), bit('isLd', 'in'), bit('isSt', 'in'),
    bit('opi', 'in'), bit('merge', 'in'), bit('red', 'in'), bit('mvxs', 'in'), bit('vid', 'in'), bit('mvsx', 'in'), bit('mem', 'in'),
    bit('elem', 'out'), bit('mask', 'out'), bit('redOut', 'out'), bit('mvxsOut', 'out'), bit('mvsxOut', 'out'), bit('load', 'out'), bit('store', 'out'), bit('multi', 'out'), bit('pre', 'out'),
  ], (b) => {
    const { and, or, not } = kit(b);
    const misVd = b.op1(VGROUP, ['vd', 'lmul']), misVs2 = b.op1(VGROUP, ['vs2', 'lmul']), misVs1 = b.op1(VGROUP, ['rs1', 'lmul']);
    const insVs2 = b.op1(VINSIDE, ['vd', 'vs2', 'lmul']), insVs1 = b.op1(VINSIDE, ['vd', 'rs1', 'lmul']);
    b.next();
    const mvd0 = and('masked', 'vdz');
    const srcOk = and('ok', not(misVs2), not(and('vv', misVs1)));
    const opiOk = and(srcOk, b.op1(MUX2, [and(not(misVd), not(mvd0)), not(or(insVs2, and('vv', insVs1))), 'isCmp'], 'mask result?'));
    const mergeOk = and('ok', not(misVd), not(and('vv', misVs1)), not(and('masked', or(misVs2, 'vdz'))));
    const vidOk = and('ok', not(misVd), not(mvd0));
    const memOk = and('ok', not(misVd), not(and('isLd', mvd0)));
    b.next();
    const load = and('mem', 'isLd', memOk), store = and('mem', 'isSt', memOk);
    const maskL = and('opi', 'isCmp', opiOk), redL = and('red', 'ok', not(misVs2));
    const elem = or(and('opi', not('isCmp'), opiOk), and('merge', mergeOk), and('vid', vidOk), load);
    b.next();
    b.wire(elem, 'elem');
    b.wire(maskL, 'mask');
    b.wire(redL, 'redOut');
    b.wire(and('mvxs', 'ok'), 'mvxsOut');
    b.wire(and('mvsx', 'ok'), 'mvsxOut');
    b.wire(load, 'load');
    b.wire(store, 'store');
    b.wire(or(elem, maskL, redL, store), 'multi');
    b.wire(or(maskL, redL), 'pre');
  }, { wires: { lmul: true } });

  // the top level: the decoder's block diagram
  const b = new Builder();
  b.pins('instr', 'ok', 'lmul');
  b.op(FIELDS, ['instr'], 'fields', 'fld');
  b.next();
  b.op(FORMS, ['fld.isV', 'fld.isLd', 'fld.isSt', 'fld.f3', 'fld.f6', 'fld.rs1', 'fld.vmb', 'fld.masked', 'fld.rs1z', 'fld.vs2z', 'fld.vidSrc', 'fld.isCmp'], 'forms', 'form');
  b.next();
  b.op(LEGAL, ['fld.vd', 'fld.rs1', 'fld.vs2', 'lmul', 'ok', 'fld.masked', 'fld.vdz', 'form.vv', 'fld.isCmp', 'fld.isLd', 'fld.isSt',
    'form.opi', 'form.merge', 'form.red', 'form.mvxs', 'form.vid', 'form.mvsx', 'form.mem'], 'legality', 'legal');
  b.next();
  const from: Record<(typeof DEC_OUTS)[number], string> = {
    set: 'form.set', elem: 'legal.elem', mask: 'legal.mask', red: 'legal.redOut', mvxs: 'legal.mvxsOut', mvsx: 'legal.mvsxOut', load: 'legal.load', store: 'legal.store',
    csr: 'fld.csr', multi: 'legal.multi', pre: 'legal.pre', vv: 'form.vv', isX: 'form.isX', imm: 'form.imm', swap: 'form.swap', aluCtl: 'form.aluCtl',
    mergeLike: 'form.mergeLike', minS: 'fld.minS', isMax: 'fld.isMax', cmpSel: 'fld.cmpSel', resSel: 'form.resSel', masked: 'fld.masked',
  };
  for (const o of DEC_OUTS) b.wire(from[o], o);
  const ports: PortDef[] = [bus('instr', 32, 'in'), bit('ok', 'in'), bus('lmul', 2, 'in'),
    bit('set', 'out'), bit('elem', 'out'), bit('mask', 'out'), bit('red', 'out'), bit('mvxs', 'out'), bit('mvsx', 'out'), bit('load', 'out'), bit('store', 'out'), bit('csr', 'out'),
    bit('multi', 'out'), bit('pre', 'out'), bit('vv', 'out'), bit('isX', 'out'), bus('imm', 32, 'out'), bit('swap', 'out'), bus('aluCtl', 4, 'out'), bit('mergeLike', 'out'),
    bit('minS', 'out'), bit('isMax', 'out'), bus('cmpSel', 3, 'out'), bus('resSel', 2, 'out'), bit('masked', 'out')];
  return define({
    id: 'vdec', name: 'Vector decoder', category: 'cpu',
    summary: 'Recognises the vector instructions the unit runs (vset*, the integer OPI group, vmerge / vmv.v, vredsum, vmv.x.s / vmv.s.x, vid, vle32 / vse32, csrr of the vector CSRs) and checks them against vtype: a valid vtype (ok), register groups aligned to LMUL, no masked write to v0, a mask result not inside a source group. elem … csr are 1 only for a legal instruction; anything else does nothing for a cycle. The other outputs steer the lanes: the operand (vv, a scalar, an immediate), the ALU operation, the compare, the result.',
    ports,
    symbol: { kind: 'box', label: 'V DECODE' },
    netlist: laid(b, { room: true }),
  });
})();

/**
 * The golden model's vset* on a word, for VSET_VL's spec: new vl, vtype's low byte as the hardware keeps it, legal. The form
 * is read from bits 31:30 alone (VEC_DECODE only lets a word through that is a vset: vsetvl's bits 29:25 are 0).
 */
export function vsetRef(w: number, x1: number, x2: number, vl: number): [number, number, number] {
  w >>>= 0;
  const setR = w >>> 30 === 2, setI = w >>> 30 === 3;
  const zimm = setR ? x2 >>> 0 : setI ? (w >>> 20) & 0x3ff : (w >>> 20) & 0x7ff;
  const t = vtypeOf(zimm, VEC_VLEN / 8);
  const legal = !!t && t.sew === 32;
  if (!legal) return [0, zimm & 0xff, 0];
  const vlmax = vlmaxOf(t, VEC_VLEN / 8), rs1 = (w >>> 15) & 31, rd = (w >>> 7) & 31;
  const avl = setI ? rs1 : rs1 ? x1 >>> 0 : rd ? vlmax : vl;
  return [Math.min(avl, vlmax), zimm & 0xff, 1];
}

/**
 * vsetvli / vsetivli / vsetvl: the new vtype (from the immediate or x[rs2]) is legal only at e32, m1 … m8, with no
 * reserved bit set; VLMAX = 4·LMUL; vl = min(AVL, VLMAX), AVL from x[rs1], the 5-bit immediate, VLMAX (rs1 = x0,
 * rd ≠ x0) or the old vl (both x0). An illegal vtype gives vl = 0 (and vill).
 */
export const VSET_VL: ComponentDef = (() => {
  const b = new Builder();
  const { and, or, not, k, bits } = kit(b);
  const ws = b.op(splitter([7, 5, 3, 5, 8, 2, 1, 1]), ['instr'], 'fields');
  const rd = `${ws}.o1`, rs1 = `${ws}.o3`, z8 = `${ws}.o4`, z98 = `${ws}.o5`, b30 = `${ws}.o6`, b31 = `${ws}.o7`;
  const x2s = b.op(splitter([8, 24]), ['x2']);
  const x1s = b.op(splitter([6, 26]), ['x1']);
  b.next();
  const setI = and(b30, b31, ), setR = and(b31, not(b30));
  const hiI = and(b.op1(isZero(2), [z98]), or(setI, not(b30)));
  const low8 = b.op1(busMux2(8), [z8, `${x2s}.o0`, setR], 'vtype');
  const hiZ = b.op1(MUX2, [hiI, b.op1(isZero(24), [`${x2s}.o1`]), setR], 'reserved bits 0?');
  const rs1z = b.op1(isZero(5), [rs1]), rdz = b.op1(isZero(5), [rd]);
  const big = b.op1(orN(26), [`${x1s}.o1`].flatMap((x) => bits(x, 26)), 'AVL ≥ 64?');
  b.next();
  const v = bits(low8, 8);
  const legal = b.name(and(hiZ, not(v[5]), v[4], not(v[3]), not(v[2])), 'legal');
  const ld = b.op(decoder(2), [b.op1(merger([1, 1]), [v[0], v[1]])], 'LMUL');
  const vlmax = b.name(b.op1(merger([1, 1, 1, 1, 1, 1]), [k(1, 0), k(1, 0), `${ld}.y0`, `${ld}.y1`, `${ld}.y2`, `${ld}.y3`], 'VLMAX = 4·LMUL'), 'vlmax');
  b.next();
  const uimm6 = b.op1(merger([5, 1]), [rs1, k(1, 0)]);
  const avlR = b.op1(muxTree(2, 6), ['vl', vlmax, `${x1s}.o0`, `${x1s}.o0`, b.op1(merger([1, 1]), [not(rdz), not(rs1z)])], 'AVL');
  const avl = b.op1(busMux2(6), [avlR, uimm6, setI]);
  const bigAvl = and(not(setI), not(rs1z), big);
  b.next();
  const lt = `${b.op(magComparator(6), [avl, vlmax], 'AVL < VLMAX?')}.lt`;
  b.next();
  const vlMin = b.op1(busMux2(6), [vlmax, avl, and(lt, not(bigAvl))], 'min(AVL, VLMAX)');
  b.next();
  b.wire(b.op1(bitwise('and', 6), [vlMin, b.op1(fanout(6), [legal])]), 'vlNew');
  b.wire(low8, 'vt');
  b.wire(legal, 'legal');
  return define({
    id: 'vsetvl', name: 'vset: vl and vtype', category: 'cpu',
    summary: 'The arithmetic of vsetvli / vsetivli / vsetvl. The new vtype comes from the instruction\'s immediate or x[rs2]; this unit takes only e32 at m1, m2, m4 or m8 with no reserved bit set (anything else sets vill and vl = 0). VLMAX = LMUL · VLEN / SEW = 4·LMUL; vl = min(AVL, VLMAX), where AVL is x[rs1], the 5-bit immediate, VLMAX itself (rs1 = x0, rd ≠ x0) or the old vl (rs1 = rd = x0).',
    ports: [bus('instr', 32, 'in'), bus('x1', 32, 'in'), bus('x2', 32, 'in'), bus('vl', 6, 'in'), bus('vlNew', 6, 'out'), bus('vt', 8, 'out'), bit('legal', 'out')],
    symbol: { kind: 'box', label: 'vset' },
    spec: ([w, x1, x2, vl]) => vsetRef(w, x1, x2, vl),
    netlist: () => ({ pins: edgePins(b, ['instr', 'x1', 'x2', 'vl'], ['vlNew', 'vt', 'legal']), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * vl, vtype and the scalar side: vset* writes vl / vtype (registers) and rd = the new vl; vmv.x.s writes rd = vs2[0];
 * csrr reads vl, vtype (vill reads 0x80000000), vlenb (16) or vstart / vxsat / vxrm / vcsr (0).
 */
export const VEC_CFG: ComponentDef = (() => {
  const b = new Builder();
  const { and, or, k } = kit(b);
  const vs = b.op(VSET_VL, ['instr', 'x1', 'x2', 'vlReg.q'], 'vset', 'vs');
  const cs = b.op(splitter([20, 12]), ['instr']);
  b.next();
  b.wire(`${vs}.vlNew`, 'vlReg.d');
  b.wire(`${vs}.vt`, 'vtReg.d');
  b.wire(`${vs}.legal`, 'okReg.d');
  for (const r of ['vlReg', 'vtReg', 'okReg']) { b.wire('set', `${r}.en`); b.wire('clk', `${r}.clk`); }
  b.add(register(6), 'vl', 'vlReg');
  b.add(register(8), 'vtype', 'vtReg');
  b.add(register(1), 'vtype valid', 'okReg');
  const isVl = b.op1(equal(12), [`${cs}.o1`, k(12, 0xc20)], 'vl?'), isVt = b.op1(equal(12), [`${cs}.o1`, k(12, 0xc21)], 'vtype?'), isLen = b.op1(equal(12), [`${cs}.o1`, k(12, 0xc22)], 'vlenb?');
  b.next();
  const vlW = b.op1(merger([6, 26]), ['vlReg.q', k(26, 0)]);
  const vtW = b.op1(busMux2(32), [k(32, VILL), b.op1(merger([8, 24]), ['vtReg.q', k(24, 0)]), 'okReg.q'], 'vtype CSR');
  const csrV = b.op1(muxTree(2, 32), [k(32, 0), vlW, vtW, k(32, VEC_VLEN / 8), b.op1(merger([1, 1]), [or(isVl, isLen), or(isVt, isLen)])], 'CSR value');
  const newW = b.op1(merger([6, 26]), [`${vs}.vlNew`, k(26, 0)]);
  b.next();
  b.wire(b.op1(muxTree(2, 32), [csrV, newW, 'rdA0', 'rdA0', b.op1(merger([1, 1]), ['set', 'mvxs'])], 'x[rd]'), 'xData');
  b.wire(or('set', 'mvxs', 'csr'), 'xWe');
  b.wire('vlReg.q', 'vl');
  b.wire(b.op1(splitter([2, 6]), ['vtReg.q']), 'lmul');
  b.wire('okReg.q', 'ok');
  void and;
  return define({
    id: 'vcfg', name: 'vl / vtype', category: 'cpu',
    summary: 'The vector state the scalar core sees: vl and vtype, written by vset* (rd gets the new vl), read by csrr (vtype with vill reads 0x80000000, vlenb is 16, vstart / vxsat / vxrm / vcsr read 0), and the path of vmv.x.s from lane 0 to x[rd]. Power-on leaves vtype invalid (vill), as the golden model does.',
    ports: [clkPort, bus('instr', 32, 'in'), bus('x1', 32, 'in'), bus('x2', 32, 'in'), bus('rdA0', 32, 'in'), bit('set', 'in'), bit('mvxs', 'in'), bit('csr', 'in'),
      bus('vl', 6, 'out'), bus('lmul', 2, 'out'), bit('ok', 'out'), bit('xWe', 'out'), bus('xData', 32, 'out')],
    symbol: { kind: 'box', label: 'vl / vtype' },
    netlist: () => ({ pins: edgePins(b, ['instr', 'x1', 'x2', 'rdA0', 'set', 'mvxs', 'csr', 'clk'], ['vl', 'lmul', 'ok', 'xWe', 'xData']), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The beats: a counter of cycles since the instruction began (cleared on the last), the register of the group this beat
 * reads and writes (vs2 | b, vs1 | b, vd | b: the groups are aligned), each lane's element 4b + i, whether it is inside
 * vl and active under the mask, and each lane's write enable. A mask compare and vredsum spend a first beat reading
 * the old mask word or vs1[0] (port B: vd or vs1) and write vd's lane-0 word on the last.
 */
export const VEC_SEQ: ComponentDef = (() => {
  // Three blocks: the beat counter (which register of the group, the first beat a mask compare or vredsum adds, the last),
  // the register addresses of this beat, and the lanes (each one's element, inside vl, active under v0, its write enable).
  const COUNT = vecBlock('vseq_count', 'Beat sequencer: counter', 'beat counter', 'Counts the cycles since the instruction began and clears on the last. The beat is the register of the group this cycle (one less after a first beat of a mask compare or vredsum); last = 1 when it is the group\'s last register, or at once for an instruction that is not multi-beat.', [
    bit('pre', 'in'), bus('lmul', 2, 'in'), bit('multi', 'in'), clkPort,
    bus('beat', 3, 'out'), bit('preBeat', 'out'), bit('atEnd', 'out'), bit('last', 'out'),
  ], (b) => {
    const { and, or, not, k, bits, fan } = kit(b);
    const cs = b.op(splitter([3, 1]), ['cnt.q']);
    const [l0, l1] = bits('lmul', 2);
    const cntZ = b.op1(isZero(4), ['cnt.q']);
    b.next();
    const preBeat = and('pre', cntZ);
    const dec = b.op1(rca(3), [`${cs}.o0`, k(3, 7), k(1, 0)], 'beat − 1');
    const lm1 = b.op1(merger([1, 1, 1]), [or(l0, l1), l1, and(l0, l1)], 'L − 1');
    b.next();
    const bOff = b.op1(busMux2(3), [`${cs}.o0`, dec, 'pre']);
    b.next();
    const beat = b.op1(bitwise('and', 3), [bOff, fan(not(preBeat), 3)], 'beat', 'bt');
    b.next();
    const atEnd = b.op1(equal(3), [beat, lm1], 'last of the group?', 'end');
    b.next();
    const last = or(not('multi'), and(not(preBeat), atEnd));
    b.wire(b.op1(busMux2(4), [b.op1(incrementer(4), ['cnt.q']), k(4, 0), last], 'next count'), 'cnt.d');
    b.wire(k(1, 1), 'cnt.en');
    b.wire('clk', 'cnt.clk');
    b.add(register(4), 'beat counter', 'cnt');
    b.wire(beat, 'beat'); b.wire(preBeat, 'preBeat'); b.wire(atEnd, 'atEnd'); b.wire(last, 'last');
  }, { aspect: 0, wires: { 'bt.y': true, 'end.eq': true } }); // small: one band

  const REGS = vecBlock('vseq_regs', 'Beat sequencer: registers', 'registers', 'The registers this beat reads and writes: vs2 | b (vs3 for a store) on port A, vs1 | b (vd for the old mask word on a first beat) on port B, vd | b to write (a mask compare and vredsum write vd itself). The groups are aligned, so | b is an OR into the low bits.', [
    bus('instr', 32, 'in'), bus('beat', 3, 'in'), bit('store', 'in'), bit('mask', 'in'), bit('red', 'in'), bit('preBeat', 'in'),
    bus('raA', 5, 'out'), bus('raB', 5, 'out'), bus('wa', 5, 'out'),
  ], (b) => {
    const { and, or, not, fan } = kit(b);
    const fs = b.op(splitter([7, 5, 3, 5, 5, 7]), ['instr'], 'fields');
    const vd = `${fs}.o1`, vs1 = `${fs}.o3`, vs2 = `${fs}.o4`;
    b.next();
    const orLow = (base: string) => { const s = b.op(splitter([3, 2]), [base]); return b.op1(merger([3, 2]), [b.op1(bitwise('or', 3), [`${s}.o0`, 'beat']), `${s}.o1`]); };
    b.wire(orLow(b.op1(busMux2(5), [vs2, vd, 'store'], 'vs2 / vs3')), 'raA');
    b.wire(orLow(b.op1(busMux2(5), [vs1, vd, and('mask', 'preBeat')], 'vs1 / old mask')), 'raB');
    const wd = b.op(splitter([3, 2]), [vd]);
    b.wire(b.op1(merger([3, 2]), [b.op1(bitwise('or', 3), [`${wd}.o0`, b.op1(bitwise('and', 3), ['beat', fan(not(or('mask', 'red')), 3)])]), `${wd}.o1`]), 'wa');
  });

  const LANES = vecBlock('vseq_lanes', 'Beat sequencer: lanes', 'lanes', 'Each lane\'s element 4b + i this beat, whether it is inside vl and active under v0, and its write enable: an element inside vl and active (vmerge: every element inside vl). Lane 0 also writes vmv.s.x\'s word and, on the last beat, a mask compare\'s or vredsum\'s result.', [
    bus('beat', 3, 'in'), bit('preBeat', 'in'), bit('atEnd', 'in'), bus('vl', 6, 'in'), bus('v0', 32, 'in'), bit('masked', 'in'),
    bit('elem', 'in'), bit('mergeLike', 'in'), bit('mvsx', 'in'), bit('mask', 'in'), bit('red', 'in'),
    bus('we', 4, 'out'), bus('act', 4, 'out'), bus('take', 4, 'out'), bus('e0', 5, 'out'), bus('e1', 5, 'out'), bus('e2', 5, 'out'), bus('e3', 5, 'out'), bit('accW', 'out'),
  ], (b) => {
    const { and, or, not, k, bits } = kit(b);
    const vlNZ = not(b.op1(isZero(6), ['vl']));
    const v0b = bits('v0', 32);
    b.next();
    const we: string[] = [], act: string[] = [], take: string[] = [];
    for (let i = 0; i < VEC_LANES; i++) {
      const e = b.op1(merger([2, 3]), [k(2, i), 'beat'], `element ${i}`);
      b.wire(e, `e${i}`);
      const lt = `${b.op(magComparator(6), [b.op1(merger([5, 1]), [e, k(1, 0)]), 'vl'], `e${i} < vl?`)}.lt`;
      const m = b.op1(muxTree(3, 1), [...Array.from({ length: 8 }, (_, j) => v0b[4 * j + i]), 'beat'], `v0[e${i}]`);
      const active = or(not('masked'), m);
      take.push(active);
      act.push(and(active, lt, not('preBeat')));
      const ew = and('elem', lt, or('mergeLike', active));
      we.push(i ? ew : or(ew, and('mvsx', lt), and('mask', not('preBeat'), 'atEnd'), and('red', not('preBeat'), 'atEnd', vlNZ)));
    }
    b.next();
    b.wire(b.op1(merger(ones(4)), we, 'write'), 'we');
    b.wire(b.op1(merger(ones(4)), act, 'active, in vl'), 'act');
    b.wire(b.op1(merger(ones(4)), take), 'take');
    b.wire(or('mask', 'red'), 'accW');
  });

  // the top level: the sequencer's block diagram
  const ins = ['instr', 'multi', 'pre', 'lmul', 'elem', 'mask', 'red', 'mvsx', 'store', 'masked', 'mergeLike', 'vl', 'v0', 'clk'];
  const b = new Builder();
  b.pins(...ins);
  b.op(COUNT, ['pre', 'lmul', 'multi', 'clk'], 'beat counter', 'count');
  b.next();
  b.op(REGS, ['instr', 'count.beat', 'store', 'mask', 'red', 'count.preBeat'], 'registers', 'regs');
  b.op(LANES, ['count.beat', 'count.preBeat', 'count.atEnd', 'vl', 'v0', 'masked', 'elem', 'mergeLike', 'mvsx', 'mask', 'red'], 'lanes', 'lanes');
  b.next();
  for (const o of ['raA', 'raB', 'wa']) b.wire(`regs.${o}`, o);
  for (const o of ['we', 'act', 'take', 'e0', 'e1', 'e2', 'e3', 'accW']) b.wire(`lanes.${o}`, o);
  for (const o of ['beat', 'preBeat', 'last']) b.wire(`count.${o}`, o);
  return define({
    id: 'vseq', name: 'Beat sequencer', category: 'cpu',
    summary: 'Runs an instruction over its register group: one beat per register (L = LMUL beats), the four lanes on elements 4b … 4b + 3. A lane writes only an element inside vl and active under v0 (vmerge writes every element inside vl, picking by v0), which keeps tail and masked-off elements undisturbed. A mask compare and vredsum add a first beat that reads the old mask word or vs1[0]; their result goes to lane 0 on the last beat. last = 1 lets the scalar core retire the instruction; a scalar instruction is always last.',
    ports: [clkPort, bus('instr', 32, 'in'), bit('multi', 'in'), bit('pre', 'in'), bus('lmul', 2, 'in'), bit('elem', 'in'), bit('mask', 'in'), bit('red', 'in'), bit('mvsx', 'in'), bit('store', 'in'), bit('masked', 'in'), bit('mergeLike', 'in'), bus('vl', 6, 'in'), bus('v0', 32, 'in'),
      bus('raA', 5, 'out'), bus('raB', 5, 'out'), bus('wa', 5, 'out'), bus('we', 4, 'out'), bus('act', 4, 'out'), bus('take', 4, 'out'), bus('e0', 5, 'out'), bus('e1', 5, 'out'), bus('e2', 5, 'out'), bus('e3', 5, 'out'),
      bus('beat', 3, 'out'), bit('preBeat', 'out'), bit('last', 'out'), bit('accW', 'out')],
    symbol: { kind: 'box', label: 'BEATS' },
    netlist: laid(b, { room: true }),
  });
})();

/** VEC_ALU's behaviour, for its spec and the tests. */
export function vecAluRef(v: number[]): [number, number] {
  const [rdA, rdB, scalar, vv, swap, aluCtl, mergeLike, take, minS, isMax, cmpSel, resSel, idx, memRd] = v;
  const opB = vv ? rdB : scalar, a = swap ? opB : rdA, bb = swap ? rdA : opB;
  const [y, zero, neg, ovf, carry] = aluSpec(32)([a, bb, aluCtl]);
  const lt = neg ^ ovf, ltu = carry ? 0 : 1, eq = zero, le = lt | eq, leu = ltu | eq;
  const mm = (minS ? lt : ltu) === isMax ? 1 : 0;
  const picked = (mergeLike ? take : mm) ? opB : rdA;
  const cmp = [eq, 1 - eq, ltu, lt, leu, le, 1 - leu, 1 - le][cmpSel];
  return [[y, picked, idx, memRd][resSel] >>> 0, cmp];
}

/**
 * A lane's arithmetic: operand B is vs1's element, x[rs1] or the immediate; vrsub swaps the ALU's operands; the ALU
 * subtracts for every compare and min / max (eq from zero, lt from neg ⊕ ovf, ltu from the borrow); min / max pick
 * vs2's element or operand B, as vmerge does by the mask bit (take). The result: the ALU, the pick, the element index
 * (vid) or the word from memory (vle32).
 */
export const VEC_ALU: ComponentDef = (() => {
  const b = new Builder();
  const { or, not } = kit(b);
  const opB = b.name(b.op1(busMux2(32), ['scalar', 'rdB', 'vv'], 'operand B'), 'opB');
  b.next();
  const a = b.op1(busMux2(32), ['rdA', opB, 'swap'], 'a (vrsub: B)');
  const bb = b.op1(busMux2(32), [opB, 'rdA', 'swap'], 'b (vrsub: A)');
  b.next();
  const al = b.op(alu(32), [a, bb, 'aluCtl'], 'ALU');
  b.next();
  const lt = b.op1(XOR, [`${al}.neg`, `${al}.ovf`], 'lt'), ltu = b.op1(NOT, [`${al}.carry`], 'ltu'), eq = `${al}.zero`;
  b.next();
  const le = or(lt, eq), leu = or(ltu, eq);
  const ltSel = b.op1(MUX2, [ltu, lt, 'minS']);
  b.next();
  const pick = b.op1(MUX2, [b.op1(XNOR, ['isMax', ltSel], 'min / max'), 'take', 'mergeLike']);
  const cmp = b.op1(muxTree(3, 1), [eq, not(eq), ltu, lt, leu, le, not(leu), not(le), 'cmpSel'], 'compare');
  b.next();
  const picked = b.op1(busMux2(32), ['rdA', opB, pick], 'pick');
  const idx = b.op1(merger([5, 27]), ['idx', b.op1(K(27, 0), [])]);
  b.next();
  b.wire(b.op1(muxTree(2, 32), [`${al}.y`, picked, idx, 'memRd', 'resSel'], 'result'), 'res');
  b.wire(cmp, 'cmp');
  return define({
    id: 'valu', name: 'Lane ALU', category: 'cpu',
    summary: 'One lane\'s arithmetic for one element: the 32-bit ALU of chapter ' + numOf('alu') + ' with operand B from the other register, x[rs1] or the immediate, the operands swapped for vrsub, the flags of a subtraction turned into the eight compares (eq, ne, ltu, lt, leu, le, gtu, gt) and into min / max, a pick between vs2\'s element and operand B (min / max, or vmerge by the mask bit), and the result: ALU, pick, element index (vid) or the loaded word.',
    ports: [bus('rdA', 32, 'in'), bus('rdB', 32, 'in'), bus('scalar', 32, 'in'), bit('vv', 'in'), bit('swap', 'in'), bus('aluCtl', 4, 'in'), bit('mergeLike', 'in'), bit('take', 'in'), bit('minS', 'in'), bit('isMax', 'in'), bus('cmpSel', 3, 'in'), bus('resSel', 2, 'in'), bus('idx', 5, 'in'), bus('memRd', 32, 'in'),
      bus('res', 32, 'out'), bit('cmp', 'out')],
    symbol: { kind: 'box', label: 'LANE ALU' },
    spec: (v) => vecAluRef(v),
    netlist: () => ({ pins: edgePins(b, ['rdA', 'rdB', 'scalar', 'vv', 'swap', 'aluCtl', 'mergeLike', 'take', 'minS', 'isMax', 'cmpSel', 'resSel', 'idx', 'memRd'], ['res', 'cmp']), instances: b.instances, nets: b.nets() }),
  });
})();

/** One lane: a 32-bit slice of the 32 vector registers (two read ports, one write port) and its ALU. */
export const VEC_LANE: ComponentDef = (() => {
  const b = new Builder();
  const rf = b.op(regfile(5, 32, false), ['wa', 'raA', 'raB', '', 'we', 'clk'], 'registers (32-bit slice)', 'vrf');
  b.next();
  const al = b.op(VEC_ALU, [`${rf}.rd1`, `${rf}.rd2`, 'scalar', 'vv', 'swap', 'aluCtl', 'mergeLike', 'take', 'minS', 'isMax', 'cmpSel', 'resSel', 'idx', 'memRd'], 'lane ALU', 'alu');
  b.next();
  const wd = b.op1(busMux2(32), [`${al}.res`, 'ovrD', 'ovr'], 'result / accumulator');
  b.wire(wd, `${rf}.wd`);
  b.next();
  b.wire(wd, 'wd');
  b.wire(`${rf}.rd1`, 'rdA');
  b.wire(`${rf}.rd2`, 'rdB');
  b.wire(`${al}.cmp`, 'cmp');
  return define({
    id: 'vlane', name: 'Vector lane', category: 'cpu',
    summary: 'A slice of the vector register file, 32 bits of each of the 32 registers (lane i holds element i of a register at e32, bytes 4i … 4i + 3), with two read ports (vs2 or the store data on A, vs1 on B) and one write port, and the lane\'s ALU. Four lanes side by side make the 128-bit registers; nothing crosses between them but the reduction and the mask.',
    ports: [clkPort, bus('raA', 5, 'in'), bus('raB', 5, 'in'), bus('wa', 5, 'in'), bit('we', 'in'), bus('scalar', 32, 'in'), bit('vv', 'in'), bit('swap', 'in'), bus('aluCtl', 4, 'in'), bit('mergeLike', 'in'), bit('take', 'in'), bit('minS', 'in'), bit('isMax', 'in'), bus('cmpSel', 3, 'in'), bus('resSel', 2, 'in'), bus('idx', 5, 'in'), bus('memRd', 32, 'in'), bit('ovr', 'in'), bus('ovrD', 32, 'in'),
      bus('rdA', 32, 'out'), bus('rdB', 32, 'out'), bit('cmp', 'out'), bus('wd', 32, 'out')],
    symbol: { kind: 'box', label: 'LANE' },
    netlist: () => ({ pins: edgePins(b, ['raA', 'raB', 'wa', 'we', 'scalar', 'vv', 'swap', 'aluCtl', 'mergeLike', 'take', 'minS', 'isMax', 'cmpSel', 'resSel', 'idx', 'memRd', 'ovr', 'ovrD', 'clk'], ['rdA', 'rdB', 'cmp', 'wd']), instances: b.instances, nets: b.nets() }),
  });
})();

/** A nibble of the mask being built: on its beat, each active lane's compare bit replaces the old bit. */
export const MASK_NIBBLE: ComponentDef = (() => {
  const b = new Builder();
  const mixed = b.op1(bitwise('or', 4), [b.op1(bitwise('and', 4), ['acc', 'keep']), 'set']);
  b.next();
  b.wire(b.op1(busMux2(4), ['acc', mixed, 'sel']), 'y');
  return define({
    id: 'vmasknib', name: 'Mask nibble', category: 'cpu',
    summary: 'Four mask bits, one per lane: on this nibble\'s beat (sel) each bit becomes the lane\'s compare result where the lane is active (set), and stays where it is not (keep); otherwise all four stay.',
    ports: [bus('acc', 4, 'in'), bus('keep', 4, 'in'), bus('set', 4, 'in'), bit('sel', 'in'), bus('y', 4, 'out')],
    symbol: { kind: 'box', label: 'mask bits' },
    spec: ([acc, keep, set, sel]) => [sel ? ((acc & keep) | set) & 15 : acc],
    netlist: () => ({ pins: edgePins(b, ['acc', 'keep', 'set', 'sel'], ['y']), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * Lane 0's accumulator, for the two instructions whose result crosses lanes: vredsum (vs1[0] in the first beat, then
 * the active elements of each beat added by an adder tree) and the mask compares (the old mask word, then four bits
 * a beat). Lane 0 writes accNext on the last beat.
 */
export const VEC_ACC: ComponentDef = (() => {
  const b = new Builder();
  const { fan } = kit(b);
  const actB = kit(b).bits('act', 4);
  b.next();
  const part = [0, 1, 2, 3].map((i) => b.op1(bitwise('and', 32), [`rdA${i}`, fan(actB[i], 32)], `lane ${i} if active`));
  const beatD = b.op(decoder(3), ['beat'], 'beat');
  const keep = b.op1(bitwise('xor', 4), ['act', b.op1(K(4, 15), [])], 'inactive lanes');
  const set = b.op1(bitwise('and', 4), ['cmp', 'act'], 'new bits');
  b.next();
  const s01 = b.op1(rca(32), [part[0], part[1], b.op1(TIE0, [])]), s23 = b.op1(rca(32), [part[2], part[3], b.op1(TIE0, [])]);
  const accN = b.op(splitter(Array(8).fill(4)), ['acc.q']);
  const nib = Array.from({ length: 8 }, (_, g) => b.op1(MASK_NIBBLE, [`${accN}.o${g}`, keep, set, `${beatD}.y${g}`], `bits ${4 * g}–${4 * g + 3}`));
  b.next();
  const s = b.op1(rca(32), [s01, s23, b.op1(TIE0, [])]);
  const maskW = b.op1(merger(Array(8).fill(4)), nib, 'mask word');
  b.next();
  const sum = b.op1(rca(32), ['acc.q', s, b.op1(TIE0, [])], 'acc + Σ');
  b.next();
  const next = b.op1(busMux2(32), [b.op1(busMux2(32), [maskW, sum, 'red'], 'sum / mask'), 'rdB0', 'preBeat'], 'next');
  b.wire(next, 'acc.d');
  b.wire(b.op1(TIE1, []), 'acc.en');
  b.wire('clk', 'acc.clk');
  b.add(register(32), 'accumulator', 'acc');
  b.next();
  b.wire(next, 'accNext');
  return define({
    id: 'vacc', name: 'Reduction / mask accumulator', category: 'cpu',
    summary: 'Where the lanes meet. vredsum.vs: the first beat loads vs1[0], each later beat adds the active elements of the four lanes (an adder tree), and lane 0 writes the sum to vd[0] on the last. A mask compare: the first beat loads vd\'s old mask word, each later beat replaces the four bits of its elements where the lane is active and inside vl, and lane 0 writes the word back on the last, so tail and masked-off bits stay as they were.',
    ports: [clkPort, bit('preBeat', 'in'), bit('red', 'in'), bus('beat', 3, 'in'), bus('cmp', 4, 'in'), bus('act', 4, 'in'), bus('rdA0', 32, 'in'), bus('rdA1', 32, 'in'), bus('rdA2', 32, 'in'), bus('rdA3', 32, 'in'), bus('rdB0', 32, 'in'), bus('accNext', 32, 'out')],
    symbol: { kind: 'box', label: 'Σ / MASK' },
    netlist: () => ({ pins: edgePins(b, ['preBeat', 'red', 'beat', 'cmp', 'act', 'rdA0', 'rdA1', 'rdA2', 'rdA3', 'rdB0', 'clk'], ['accNext']), instances: b.instances, nets: b.nets() }),
  });
})();

/** A copy of v0's lane-0 word (the mask bits of elements 0 … 31), written whenever lane 0 writes v0. */
export const V0_SHADOW: ComponentDef = (() => {
  const b = new Builder();
  b.wire(b.op1(AND, ['we', b.op1(isZero(5), ['wa'], 'v0?')]), 'v0.en');
  b.wire('d', 'v0.d');
  b.wire('clk', 'v0.clk');
  b.next();
  b.add(register(32), 'v0 (mask)', 'v0');
  b.next();
  b.wire('v0.q', 'q');
  return define({
    id: 'v0shadow', name: 'v0 shadow', category: 'cpu',
    summary: 'The mask register v0, copied: every write of lane 0 to v0 also lands here, so the 32 mask bits are always at hand without a third read port on each lane (which would cost about 16 000 NANDs over four lanes). At e32 and VLEN 128 a group holds 32 elements at most, so v0\'s lane-0 word is the whole mask.',
    ports: [clkPort, bus('d', 32, 'in'), bit('we', 'in'), bus('wa', 5, 'in'), bus('q', 32, 'out')],
    symbol: { kind: 'box', label: 'v0' },
    netlist: () => ({ pins: edgePins(b, ['d', 'we', 'wa', 'clk'], ['q']), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The vector unit beside the single-cycle core: decoder, vl / vtype, the beat sequencer, four lanes, the accumulator
 * and the v0 shadow. It reads the instruction and x[rs1] / x[rs2] from the core, gives back x[rd] for vset* /
 * vmv.x.s / csrr and `retire` (low while it runs), and drives the vector side of vecMemory.
 */
export const VECTOR_UNIT: ComponentDef = (() => {
  const b = new Builder(10, 16, 6);
  const dec = b.op(VEC_DECODE, ['instr', 'cfg.ok', 'cfg.lmul'], 'decode', 'dec');
  const cfg = b.op(VEC_CFG, ['clk', 'instr', 'xa', 'xb', 'lane0.rdA', `${dec}.set`, `${dec}.mvxs`, `${dec}.csr`], 'vl / vtype', 'cfg');
  const scalar = b.name(b.op1(busMux2(32), [`${dec}.imm`, 'xa', `${dec}.isX`], 'imm / x[rs1]'), 'scalar', true);
  b.next();
  const seq = b.op(VEC_SEQ, ['clk', 'instr', `${dec}.multi`, `${dec}.pre`, `${cfg}.lmul`, `${dec}.elem`, `${dec}.mask`, `${dec}.red`, `${dec}.mvsx`, `${dec}.store`, `${dec}.masked`, `${dec}.mergeLike`, `${cfg}.vl`, 'v0.q'], 'beats', 'seq');
  const rd = b.op(splitter([32, 32, 32, 32]), ['vRd'], 'from memory');
  const we = kit(b).bits(`${seq}.we`, 4), take = kit(b).bits(`${seq}.take`, 4);
  b.next();
  const zero32 = b.op1(K(32, 0), []), lo = b.op1(TIE0, []);
  for (let i = 0; i < VEC_LANES; i++) {
    b.op(VEC_LANE, ['clk', `${seq}.raA`, `${seq}.raB`, `${seq}.wa`, we[i], scalar, `${dec}.vv`, `${dec}.swap`, `${dec}.aluCtl`, `${dec}.mergeLike`, take[i], `${dec}.minS`, `${dec}.isMax`, `${dec}.cmpSel`, `${dec}.resSel`, `${seq}.e${i}`, `${rd}.o${i}`,
      i ? lo : `${seq}.accW`, i ? zero32 : 'acc.accNext'], `lane ${i}`, `lane${i}`);
  }
  b.next();
  b.op(VEC_ACC, ['clk', `${seq}.preBeat`, `${dec}.red`, `${seq}.beat`, b.op1(merger(ones(4)), ['lane0.cmp', 'lane1.cmp', 'lane2.cmp', 'lane3.cmp']), `${seq}.act`, 'lane0.rdA', 'lane1.rdA', 'lane2.rdA', 'lane3.rdA', 'lane0.rdB'], 'reduction / mask', 'acc');
  b.op(V0_SHADOW, ['clk', 'lane0.wd', we[0], `${seq}.wa`], 'v0 shadow', 'v0');
  b.next();
  b.wire(`${cfg}.xWe`, 'xWe');
  b.wire(`${cfg}.xData`, 'xData');
  b.wire(`${seq}.last`, 'retire');
  b.wire(b.op1(OR, [`${dec}.load`, `${dec}.store`], 'memory?'), 'vAct');
  b.wire(`${seq}.beat`, 'vBeat');
  b.wire(b.op1(bitwise('and', 4), [`${seq}.act`, b.op1(fanout(4), [`${dec}.store`])], 'store lanes'), 'vWe');
  b.wire(b.op1(merger([32, 32, 32, 32]), ['lane0.rdA', 'lane1.rdA', 'lane2.rdA', 'lane3.rdA'], 'store data'), 'vWd');
  return define({
    id: 'vunit', name: 'Vector unit (4 lanes, VLEN 128)', category: 'cpu',
    summary: 'The RVV subset in gates: vset*, integer arithmetic, logic, shifts, min / max, compares into a mask, vmerge / vmv, vredsum, vid, vmv.x.s / vmv.s.x and unit-stride vle32 / vse32, masked or not, at e32 and LMUL 1, 2, 4 or 8. Four lanes do four elements a beat; a group of L registers takes L beats (plus one for a compare or a reduction), and the scalar core waits meanwhile. e8 / e16 (vill), vmul and strided or narrow accesses are left to the golden model: here they do nothing.',
    ports: [clkPort, bus('instr', 32, 'in'), bus('xa', 32, 'in'), bus('xb', 32, 'in'), bus('vRd', 128, 'in', 'bottom'),
      bit('vAct', 'out'), bus('vBeat', 3, 'out'), bus('vWe', 4, 'out'), bus('vWd', 128, 'out'), bit('retire', 'out'), bit('xWe', 'out'), bus('xData', 32, 'out')],
    symbol: { kind: 'box', label: 'VECTOR UNIT' },
    netlist: () => ({ pins: edgePins(b, ['instr', 'xa', 'xb', 'vRd', 'clk'], ['vAct', 'vBeat', 'vWe', 'vWd', 'retire', 'xWe', 'xData']), instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The data memory of the vector CPU: 2^k words in four word-interleaved banks (word w in bank w mod 4, row w / 4).
 * The scalar port (addr, wd, we, rd) reads and writes one word as dataMemory does. The vector port reads or writes
 * four consecutive words a beat from vBase + 16·vBeat: lane i's word lands in bank (s + i) mod 4, s = vBase[3:2],
 * one row further on where it wraps, so any word-aligned base takes one beat per four elements.
 */
export function vecMemory(k: number): ComponentDef {
  if (k < 5) throw new Error('vecMemory: at least 2^5 words');
  return memo(`vmem${k}`, () => {
    const b = new Builder(10, 14, 5);
    const { and, or, k: kk } = kit(b);
    const R = k - 2;
    const as = b.op(splitter([2, 2, R, 30 - k]), ['addr'], 'scalar address');
    const vs = b.op(splitter([2, 2, R, 30 - k]), ['vBase'], 'vector base');
    const vWd = b.op(splitter([32, 32, 32, 32]), ['vWd']);
    const vWe = kit(b).bits('vWe', 4);
    b.next();
    const beatR = R === 3 ? 'vBeat' : b.op1(merger([3, R - 3]), ['vBeat', kk(R - 3, 0)]);
    const rowV = b.op1(rca(R), [`${vs}.o2`, beatR, kk(1, 0)], 'row + beat');
    const [s0, s1] = kit(b).bits(`${vs}.o1`, 2);
    b.next();
    const rowV1 = b.op1(incrementer(R), [rowV], 'next row');
    const wrap = [or(s0, s1), s1, and(s0, s1)];
    b.next();
    const dout: string[] = [];
    for (let j = 0; j < 4; j++) {
      const rv = j === 3 ? rowV : b.op1(busMux2(R), [rowV, rowV1, wrap[j]], `bank ${j}: wrapped?`);
      const addr = b.op1(busMux2(R), [`${as}.o2`, rv, 'vAct'], `bank ${j} row`);
      const lane = (s: number) => (j - s + 4) & 3;
      const din = b.op1(busMux2(32), ['wd', b.op1(muxTree(2, 32), [...[0, 1, 2, 3].map((s) => `${vWd}.o${lane(s)}`), `${vs}.o1`], `lane → bank ${j}`), 'vAct']);
      const sw = and('we', b.op1(equal(2), [`${as}.o1`, kk(2, j)]));
      const we = b.op1(MUX2, [sw, b.op1(muxTree(2, 1), [...[0, 1, 2, 3].map((s) => vWe[lane(s)]), `${vs}.o1`]), 'vAct'], `bank ${j} write`);
      b.wire(addr, `wb${j}.addr`);
      b.wire(din, `wb${j}.din`);
      b.wire(we, `wb${j}.we`);
      b.wire('clk', `wb${j}.clk`);
      dout.push(`wb${j}.dout`);
    }
    b.next();
    for (let j = 0; j < 4; j++) b.add(ram(R, 32), `bank ${j}`, `wb${j}`);
    b.next();
    b.wire(b.op1(muxTree(2, 32), [...dout, `${as}.o1`], 'scalar read'), 'rd');
    const vr = [0, 1, 2, 3].map((i) => b.op1(muxTree(2, 32), [...[0, 1, 2, 3].map((s) => dout[(s + i) & 3]), `${vs}.o1`], `bank → lane ${i}`));
    b.next();
    b.wire(b.op1(merger([32, 32, 32, 32]), vr), 'vRd');
    return define({
      id: `vmem${k}`, name: 'Data memory (four banks)', category: 'memory',
      summary: `${2 ** k} words (${4 * 2 ** k} bytes) in four word-interleaved banks of ${2 ** R}: word w is in bank w mod 4. The scalar port reads and writes one word, as the single-cycle CPU's memory does; the vector port moves four consecutive words a beat, one per bank, so vle32 / vse32 take one beat per register whatever the base's alignment (the lanes rotated by its word offset).`,
      ports: [bus('addr', 32, 'in'), bus('wd', 32, 'in'), bit('we', 'in'), clkPort, bus('vBase', 32, 'in'), bit('vAct', 'in'), bus('vBeat', 3, 'in'), bus('vWe', 4, 'in'), bus('vWd', 128, 'in'),
        bus('rd', 32, 'out'), bus('vRd', 128, 'out', 'bottom')],
      symbol: { kind: 'box', label: 'DATA MEM ×4' },
      netlist: () => ({ pins: edgePins(b, ['addr', 'wd', 'we', 'vBase', 'vAct', 'vBeat', 'vWe', 'vWd', 'clk'], ['rd', 'vRd']), instances: b.instances, nets: b.nets() }),
    });
  });
}
