// Chapters 19–20 and graphics: blocks that stand beside the system CPU rather than inside it (systemCpu, TRAP_UNIT and
// CSR_UNIT are untouched): the vectored trap target, a latched interrupt controller, and the bilinear texture filter.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord } from './alu';
import { Builder } from './builder';
import { addSub, decoder, rca } from './combinational';
import { priorityEncoder } from './coding';
import { define, merger, ones, splitter } from './define';
import { AND, NOT, OR } from './gates';
import { arrayMul } from './muldiv';
import { DFF } from './sequential';
import { TIE0, TIE1 } from './transistors';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, ...(clock ? { clock } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });

/** The PC a trap loads (RISC-V mtvec): direct mode sends everything to BASE; vectored mode (MODE = 1) sends interrupt
 *  n to BASE + 4n. BASE is aligned to 64 bytes in vectored mode (16 standard causes), so the offset is ORed in. */
export function vectorTargetOf(mtvec: number, cause: number): number {
  const base = (mtvec & ~3) >>> 0;
  return (mtvec & 1) && cause >>> 31 ? (base | ((cause & 15) << 2)) >>> 0 : base;
}

export const VECTOR_TARGET: ComponentDef = (() => {
  const b = new Builder(8, 10);
  b.pins('mtvec', 'cause');
  const sm = b.op(splitter([1, 1, 1, 1, 1, 1, 26]), ['mtvec']); // MODE, reserved, BASE[5:2], BASE[31:6]
  const sc = b.op(splitter([1, 1, 1, 1, 27, 1]), ['cause']); // code[3:0], (unused), interrupt flag
  b.next();
  const vec = b.name(b.op1(AND, [`${sm}.o0`, `${sc}.o5`], 'vectored interrupt', 'vec'), 'vec', true);
  b.next();
  const offs = [0, 1, 2, 3].map((i) => b.op1(AND, [vec, `${sc}.o${i}`], `4n, bit ${i + 2}`, `off${i}`));
  b.next();
  const tgt = [0, 1, 2, 3].map((i) => b.op1(OR, [`${sm}.o${i + 2}`, offs[i]], `BASE | 4n, bit ${i + 2}`, `or${i}`));
  b.next();
  const z = b.op1(TIE0, []);
  b.wire(b.op1(merger([1, 1, 1, 1, 1, 1, 26]), [z, z, ...tgt, `${sm}.o6`], 'target'), 'target');
  const R = b.right;
  return define({
    id: 'vector_target', name: 'Vectored trap target', category: 'routing',
    summary: 'mtvec and mcause in, the PC out: BASE in direct mode, BASE + 4n for interrupt n in vectored mode (MODE = 1 and mcause bit 31). Four ANDs and four ORs, because BASE is aligned to 64 bytes.',
    ports: [bus('mtvec', 32, 'in'), bus('cause', 32, 'in'), bus('target', 32, 'out')],
    symbol: { kind: 'box', label: 'VECTOR' },
    spec: ([m, c]) => [vectorTargetOf(m, c)],
    netlist: () => ({ pins: { ...inPins(b, ['mtvec', 'cause']), target: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Pending bits, the enable mask and the claim handshake of an interrupt controller: model of INTC(n), the
 *  gates' reference. A source seen high at a rising edge sets its bit; the claim clears the highest enabled one. */
export class IntcModel {
  pend = 0;
  constructor(readonly n = 4) {}
  /** The enabled pending requests. */
  req(en: number): number { return this.pend & en; }
  /** The id the controller offers (highest index wins) and whether any request stands. */
  top(en: number): { v: number; id: number } {
    const r = this.req(en);
    return { v: r ? 1 : 0, id: r ? 31 - Math.clz32(r) : 0 };
  }
  /** One rising edge with the inputs of that cycle. */
  edge(src: number, en: number, claim: number): void {
    const { v, id } = this.top(en);
    const clr = claim && v ? 1 << id : 0;
    this.pend = (src | (this.pend & ~clr)) & ((1 << this.n) - 1);
  }
}

/** A latched interrupt controller (the idea of RISC-V's PLIC, 4 sources): a pending flip-flop per source sets on a
 *  request seen at a rising edge and holds it until claimed; enable mask; the highest enabled pending index is
 *  offered (irq, id); claim clears it. A request lost with a bare interrupt line waits here. */
export function intc(n = 4): ComponentDef {
  const k = Math.round(Math.log2(n));
  const b = new Builder(8, 10);
  b.pins('src', 'en', 'claim');
  const ss = b.op(splitter(ones(n)), ['src']);
  const se = b.op(splitter(ones(n)), ['en']);
  b.next();
  const ands = Array.from({ length: n }, (_, i) => b.op(AND, ['', `${se}.o${i}`], `pending ∧ enable ${i}`, `req${i}`));
  b.next();
  const mr = b.op1(merger(ones(n)), ands.map((a) => `${a}.y`), 'requests');
  b.next();
  const pe = b.op(priorityEncoder(n), [mr], 'highest', 'pri');
  const id = b.name(`${pe}.y`, 'id', true), v = b.name(`${pe}.v`, 'irq', true);
  b.next();
  const go = b.op1(AND, ['claim', v], 'claim ∧ request', 'go');
  b.next();
  const dec = b.op(decoder(k, true), [id, go], 'claimed source', 'dec');
  b.next();
  const nots = Array.from({ length: n }, (_, i) => b.op1(NOT, [`${dec}.y${i}`], `keep ${i}`, `nk${i}`));
  const holds = Array.from({ length: n }, (_, i) => b.op1(AND, ['', nots[i]], `hold ${i}`, `hold${i}`));
  b.next();
  const nexts = Array.from({ length: n }, (_, i) => b.op1(OR, [`${ss}.o${i}`, holds[i]], `set ∨ hold ${i}`, `set${i}`));
  b.next();
  const ffs = nexts.map((d, i) => b.op(DFF, [d, 'clk'], `pending ${i}`, `pend${i}`));
  ffs.forEach((f, i) => { b.wire(`${f}.q`, `${ands[i]}.a`); b.wire(`${f}.q`, holds[i].replace(/\.y$/, '.a')); });
  b.next();
  b.wire(b.op1(merger(ones(n)), ffs.map((f) => `${f}.q`), 'pending'), 'pend');
  b.wire(v, 'irq');
  b.wire(id, 'id');
  const R = b.right;
  return define({
    id: `intc${n}`, name: `${n}-source interrupt controller`, category: 'sequential',
    summary: `A pending flip-flop per source sets when its request is seen at a rising edge and holds until claimed; irq and id offer the highest enabled pending source; claim clears it. A pulse that a bare interrupt line would lose waits here.`,
    ports: [bus('src', n, 'in'), bus('en', n, 'in'), bit('claim', 'in'), bit('clk', 'in', 'bottom', true), bit('irq', 'out'), bus('id', k, 'out'), bus('pend', n, 'out')],
    symbol: { kind: 'box', label: 'INTC' },
    netlist: () => ({ pins: { ...inPins(b, ['src', 'en', 'claim']), clk: [4, 24], irq: [R, 4], id: [R, 8], pend: [R, 12] }, instances: b.instances, nets: b.nets() }),
  });
}
export const INTC4: ComponentDef = intc(4);

/** One linear interpolation of two bytes by a 4-bit fraction: (a·(16 − f) + b·f) >> 4, truncating. */
export const lerpRef = (a: number, bb: number, f: number): number => (a * (16 - f) + bb * f) >> 4;

export const LERP8: ComponentDef = (() => {
  const b = new Builder(8, 10);
  b.pins('a', 'b', 'f');
  const f8 = b.op1(merger([4, 4]), ['f', b.op1(constWord(4, 0), [])], 'f as a byte');
  const w0 = b.name(b.op1(addSub(8), [b.op1(constWord(8, 16), []), f8, b.op1(TIE1, [])], '16 − f'), '16−f');
  b.next();
  const pa = b.op1(arrayMul(8), ['a', w0], 'a · (16 − f)');
  const pb = b.op1(arrayMul(8), ['b', f8], 'b · f');
  b.next();
  const sum = b.op(rca(16), [pa, pb, b.op1(TIE0, [])], 'sum, 16 · result');
  const sp = b.op(splitter([4, 8, 4]), [`${sum}.s`]);
  b.wire(`${sp}.o1`, 'y');
  const R = b.right;
  return define({
    id: 'lerp8', name: 'Byte interpolation', category: 'arithmetic',
    summary: 'y = (a·(16 − f) + b·f) >> 4: two 8 × 8 multiplies (the weights are 16 − f and f), one adder, and the low four bits dropped.',
    ports: [bus('a', 8, 'in'), bus('b', 8, 'in'), bus('f', 4, 'in'), bus('y', 8, 'out')],
    symbol: { kind: 'box', label: 'LERP' },
    spec: ([a, c, f]) => [lerpRef(a, c, f)],
    netlist: () => ({ pins: { ...inPins(b, ['a', 'b', 'f']), y: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Bilinear filtering of a 2 × 2 texel neighbourhood: lerp along x in both rows, then along y; each stage truncates. */
export const bilinearRef = (t00: number, t01: number, t10: number, t11: number, fx: number, fy: number): number =>
  lerpRef(lerpRef(t00, t01, fx), lerpRef(t10, t11, fx), fy);

export const BILINEAR8: ComponentDef = (() => {
  const b = new Builder(8, 10);
  b.pins('t00', 't01', 't10', 't11', 'fx', 'fy');
  const top = b.op1(LERP8, ['t00', 't01', 'fx'], 'row 0 along x');
  const bot = b.op1(LERP8, ['t10', 't11', 'fx'], 'row 1 along x');
  b.next();
  b.wire(b.op1(LERP8, [top, bot, 'fy'], 'along y'), 'y');
  const R = b.right;
  return define({
    id: 'bilinear8', name: 'Bilinear filter', category: 'arithmetic',
    summary: 'Four texels and two 4-bit fractions in, one filtered byte out: three LERP units, two along x in parallel and one along y.',
    ports: [bus('t00', 8, 'in'), bus('t01', 8, 'in'), bus('t10', 8, 'in'), bus('t11', 8, 'in'), bus('fx', 4, 'in'), bus('fy', 4, 'in'), bus('y', 8, 'out')],
    symbol: { kind: 'box', label: 'BILINEAR' },
    spec: ([a, c, d, e, fx, fy]) => [bilinearRef(a, c, d, e, fx, fy)],
    netlist: () => ({ pins: { ...inPins(b, ['t00', 't01', 't10', 't11', 'fx', 'fy']), y: [R, 10] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** Input pins level with the first port each feeds (so the labels clear the others), kept 3 units apart. */
function inPins(b: Builder, names: string[]): Record<string, [number, number]> {
  const nets = b.nets();
  const want = names.map((n) => {
    const sink = nets.find((x) => x.ends[0] === n)!.ends[1];
    const [inst, port] = sink.split('.');
    const i = b.instances.find((x) => x.name === inst)!;
    return { n, y: i.at![1] + symbolGeom(i.def).ports[port].pos[1] };
  }).sort((p, q) => p.y - q.y);
  const out: Record<string, [number, number]> = {};
  let last = -99;
  for (const w of want) { const y = Math.max(w.y, last + 3); out[w.n] = [0, y]; last = y; }
  return out;
}
