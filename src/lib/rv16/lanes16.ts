// The campaign's act 9 blocks (roadmap Phase 15): four RV16 lanes behind one fetch, decode and
// control. Each block uses only the parts the finale unlocks, so each is a level's reference:
//
//   LANES16   four ALUs with their operand muxes, sharing the control signals and the immediate
//   VRF16     four register files sharing the register numbers, one write enable per lane
//   MASK16    the active mask (all lanes at reset), the leader (lowest active lane) and the
//             per-lane write enables
//   STACK16   the split / join reconvergence stack (riscv/rv16/simt16.ts says what it does)
//   LANEDEC16 the SIMT instructions and csrr rd, tid
//   rv16Lanes the SIMD core (tmc, tid, branches by the leader) and the SIMT core (split / join too)
//
// Each lane has a memory port of its own (the bench serves four); the coalescer comes later.

import type { ComponentDef, PortDef } from '../../sim/types';
import { constWord } from '../alu';
import { Builder } from '../builder';
import { busMux2 } from '../combinational';
import { define, merger, ones, splitter } from '../define';
import { AND, NOT, OR } from '../gates';
import { bitwise, orN } from '../wide';
import { BRANCH16, CTL16, IMM16, NEXTPC16 } from './cpu';
import { choose4, DEC3, MUX16, RF8, RV16_ALU16, RV16_DFFE, RV16_DREG16, RV16_MUX4, RV16_REG16, RV16_REG4 } from './logic';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkIn = (): PortDef => ({ name: 'clk', width: 1, dir: 'in', clock: true });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

/** Lanes of the campaign's lane cores. */
export const NL = 4;
const L = [0, 1, 2, 3];
const each = (p: string) => L.map((i) => `${p}${i}`);

/** Any bit of a bus set: split it, OR the bits. */
function anyOf(b: Builder, d: string, n: number, label?: string): string {
  const s = b.op(splitter(ones(n), 1), [d]);
  return b.op1(orN(n), Array.from({ length: n }, (_, i) => `${s}.o${i}`), label);
}

// ---- four lanes ----------------------------------------------------------------------------------

/** Four ALUs and their operand muxes; nz says which lanes' rs1 is not zero (split's predicate). */
export const LANES16: ComponentDef = (() => {
  const b = new Builder(16, 14, 6);
  b.pins(...each('a'), ...each('b'), 'imm', 'bimm', 'alu');
  const src = L.map((i) => b.op1(MUX16, [`b${i}`, 'imm', 'bimm'], `operand b ${i}`));
  b.next();
  const ys = L.map((i) => `${b.op(RV16_ALU16, [`a${i}`, src[i], 'alu'], `ALU ${i}`)}.y`);
  b.next();
  const nz = L.map((i) => anyOf(b, `a${i}`, 16, `a${i} ≠ 0`));
  b.next();
  b.wire(b.op1(merger(ones(NL), 2), nz, 'nz'), 'nz');
  ys.forEach((y, i) => b.wire(y, `y${i}`));
  const R = b.right;
  const aluF = RV16_ALU16.spec!;
  return define({
    id: 'rv16_lanes4', name: 'Four lanes (RV16)', category: 'cpu',
    summary: 'Four 16-bit ALUs, each with its operand-b multiplexer (its own rs2, or the shared immediate), all driven by the same control signals: one instruction, four results. nz has a bit per lane: its rs1 is not zero (what split tests).',
    ports: [...each('a').map((p) => bus(p, 16, 'in')), ...each('b').map((p) => bus(p, 16, 'in')), bus('imm', 16, 'in'), bit('bimm', 'in'), bus('alu', 4, 'in'),
      ...each('y').map((p) => bus(p, 16, 'out')), bus('nz', NL, 'out')],
    symbol: { kind: 'box', label: '4 LANES' },
    spec: (v) => {
      const [imm, bimm, op] = v.slice(8);
      const ys = L.map((i) => aluF([v[i], bimm ? imm : v[4 + i], op])[0]);
      return [...ys, L.reduce((m, i) => (v[i] ? m | (1 << i) : m), 0)];
    },
    netlist: () => ({ pins: { ...pinsAt([...each('a'), ...each('b'), 'imm', 'bimm', 'alu'], 0, 3), ...pinsAt([...each('y'), 'nz'], R, 4) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- lane register file ----------------------------------------------------------------------------

/** Four register files: the same register numbers, one write enable per lane. */
export const VRF16: ComponentDef = (() => {
  const b = new Builder(8, 14, 6);
  b.pins('wa', 'we', ...each('wd'), 'ra1', 'ra2', 'clk');
  const we = b.op(splitter(ones(NL), 2), ['we'], 'per lane');
  b.next();
  const rf = L.map((i) => b.op(RF8, ['wa', `${we}.o${i}`, `wd${i}`, 'ra1', 'ra2', 'clk'], `lane ${i} registers`));
  rf.forEach((r, i) => { b.wire(`${r}.rd1`, `a${i}`); b.wire(`${r}.rd2`, `b${i}`); });
  const R = b.right;
  return define({
    id: 'rv16_vrf4', name: 'Lane register file (4 × 8 × 16)', category: 'memory',
    summary: 'Four register files sharing the register numbers: every lane reads its own rs1 and rs2 (a, b) and writes its own result (wd) to rd, when its bit of we is 1. x0 is 0 in every lane. Most of a lane core\'s area: storage does not get shared.',
    ports: [bus('wa', 3, 'in'), bus('we', NL, 'in'), ...each('wd').map((p) => bus(p, 16, 'in')), bus('ra1', 3, 'in'), bus('ra2', 3, 'in'), clkIn(),
      ...each('a').map((p) => bus(p, 16, 'out')), ...each('b').map((p) => bus(p, 16, 'out'))],
    symbol: { kind: 'box', label: 'LANE REGS' },
    netlist: () => ({ pins: { ...pinsAt(['wa', 'we', ...each('wd'), 'ra1', 'ra2', 'clk'], 0, 3), ...pinsAt([...each('a'), ...each('b')], R, 4) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- active mask -----------------------------------------------------------------------------------

/** The mask's leader: the index of the lowest set bit (3 when none), and whether there is one. */
export function leaderOf(m: number): { lead: number; any: number } {
  for (const i of L) if ((m >> i) & 1) return { lead: i, any: 1 };
  return { lead: 3, any: 0 };
}

/**
 * The active mask: a 4-bit register, every lane on after reset, loaded from d when ld. The leader is
 * the lowest active lane (its operands steer branches); we / dwe are rwe / mwe for the active lanes.
 */
export const MASK16: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('rst', 'ld', 'd', 'rwe', 'mwe', 'clk');
  const rst4 = b.op1(merger(ones(NL), 2), L.map(() => 'rst'), 'rst ×4');
  const en = b.op1(OR, ['ld', 'rst'], 'load or reset');
  b.next();
  const d = b.op1(bitwise('or', NL), ['d', rst4], 'all on at reset');
  b.next();
  const mask = b.name(`${b.op(RV16_REG4, [d, en, 'clk'], 'mask')}.q`, 'mask', true);
  b.next();
  const m = b.op(splitter(ones(NL), 2), [mask]);
  const mb = (i: number) => `${m}.o${i}`;
  b.next();
  const n0 = b.op1(NOT, [mb(0)]), n1 = b.op1(NOT, [mb(1)]), n2 = b.op1(NOT, [mb(2)]);
  const any = b.op1(orN(NL), L.map(mb), 'any');
  b.next();
  // lead = 0 if m0, 1 if m1, 2 if m2, 3 otherwise: bit 1 = no lane below 2; bit 0 = ¬m0 · (m1 + ¬m2)
  const hi = b.op1(AND, [n0, n1], 'lead bit 1');
  const lo = b.op1(AND, [n0, b.op1(OR, [mb(1), n2])], 'lead bit 0');
  const rwe4 = b.op1(merger(ones(NL), 2), L.map(() => 'rwe'), 'rwe ×4');
  const mwe4 = b.op1(merger(ones(NL), 2), L.map(() => 'mwe'), 'mwe ×4');
  b.next();
  b.wire(b.op1(merger([1, 1], 2), [lo, hi], 'leader'), 'lead');
  b.wire(any, 'any');
  b.wire(b.op1(bitwise('and', NL), [rwe4, mask], 'we'), 'we');
  b.wire(b.op1(bitwise('and', NL), [mwe4, mask], 'dwe'), 'dwe');
  b.wire(mask, 'mask');
  const R = b.right;
  return define({
    id: 'rv16_mask4', name: 'Active mask (4 lanes)', category: 'cpu',
    summary: 'Which lanes run: a 4-bit register, all ones after reset, loaded from d when ld (tmc, split, join). lead is the lowest active lane\'s number (its registers decide branches), any says some lane is active; we and dwe let only the active lanes write a register or memory.',
    ports: [bit('rst', 'in'), bit('ld', 'in'), bus('d', NL, 'in'), bit('rwe', 'in'), bit('mwe', 'in'), clkIn(),
      bus('mask', NL, 'out'), bus('lead', 2, 'out'), bit('any', 'out'), bus('we', NL, 'out'), bus('dwe', NL, 'out')],
    symbol: { kind: 'box', label: 'MASK' },
    netlist: () => ({ pins: { ...pinsAt(['rst', 'ld', 'd', 'rwe', 'mwe', 'clk'], 0), ...pinsAt(['mask', 'lead', 'any', 'we', 'dwe'], R) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- SIMT decode -----------------------------------------------------------------------------------

/** What the lane decoder says about a word: [split, join, tmc, tid]. */
export function laneDecode(w: number): number[] {
  const op = w & 15, f3 = (w >> 13) & 7, csr = (w >> 10) & 7;
  const sys = op === 0;
  return [+(sys && f3 === 4), +(sys && f3 === 5), +(sys && f3 === 6), +(sys && f3 >= 1 && f3 <= 3 && csr === 7)];
}

/** The SIMT instructions (SYSTEM funct3 4–6; bar does nothing with one warp) and csr* on CSR 7 (tid). */
export const LANEDEC16: ComponentDef = (() => {
  const b = new Builder(8, 12, 4);
  b.pins('instr');
  const f = b.op(splitter([4, 3, 3, 3, 3], 2), ['instr'], 'fields');
  b.next();
  const nz = anyOf(b, `${f}.o0`, 4, 'op ≠ 0');
  const c = b.op(splitter(ones(3), 2), [`${f}.o3`]);
  b.next();
  const sys = b.op1(NOT, [nz], 'SYSTEM?');
  b.next();
  const fd = b.op(splitter(ones(8), 2), [b.op1(DEC3, [`${f}.o4`, sys], 'funct3')]);
  const c7 = b.op1(AND, [b.op1(AND, [`${c}.o0`, `${c}.o1`]), `${c}.o2`], 'CSR 7?');
  b.next();
  const csrOp = b.op1(OR, [b.op1(OR, [`${fd}.o1`, `${fd}.o2`]), `${fd}.o3`], 'csr*');
  b.next();
  b.wire(`${fd}.o4`, 'split');
  b.wire(`${fd}.o5`, 'join');
  b.wire(`${fd}.o6`, 'tmc');
  b.wire(b.op1(AND, [csrOp, c7], 'tid'), 'tid');
  const R = b.right;
  return define({
    id: 'rv16_lanedec', name: 'Lane decoder (RV16)', category: 'cpu',
    summary: 'The lane core\'s extra instructions, all in the SYSTEM opcode: funct3 4 split, 5 join, 6 tmc (7, bar, waits for other warps: with one warp it does nothing), and any CSR instruction on CSR 7, which reads tid (the lane\'s thread number) instead of a register.',
    ports: [bus('instr', 16, 'in'), bit('split', 'out'), bit('join', 'out'), bit('tmc', 'out'), bit('tid', 'out')],
    symbol: { kind: 'box', label: 'LANE DECODE' },
    spec: ([w]) => laneDecode(w),
    netlist: () => ({ pins: { instr: [0, 8], ...pinsAt(['split', 'join', 'tmc', 'tid'], R) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- reconvergence stack -----------------------------------------------------------------------------

/** Stack entries (nested splits). */
export const STACK_DEPTH = 4;

/** Fields of an entry, low to high: mask, else lanes, resume PC, pending, valid. */
const ENTRY = [NL, NL, 16, 1, 1];
const EW = ENTRY.reduce((a, c) => a + c, 0);

/**
 * The split / join stack, a shift register of STACK_DEPTH entries (the top is entry 0). split pushes
 * (mask, the lanes with p = 0, pc1, both sides non-empty?) and runs the p = 1 lanes first; join either
 * sends the else lanes to the saved address (jump) or restores the mask and pops. ld / nmask: the
 * mask's next value. rst empties it.
 */
export const STACK16: ComponentDef = (() => {
  const b = new Builder(16, 12, 4);
  b.pins('rst', 'split', 'join', 'mask', 'p', 'pc1', 'clk');
  // the entries: registers whose inputs come back from the right
  const regs = L.map((k) => {
    const r = { m: b.add(RV16_REG4, `${k}: mask`), e: b.add(RV16_REG4, `${k}: else`), pc: b.add(RV16_REG16, `${k}: resume pc`), pend: b.add(RV16_DFFE, `${k}: pending`), valid: b.add(RV16_DFFE, `${k}: valid`) };
    for (const x of Object.values(r)) b.wire('clk', `${x}.clk`);
    b.next();
    return r;
  });
  const q = regs.map((r, k) => b.name(b.op1(merger(ENTRY, 2), [`${r.m}.q`, `${r.e}.q`, `${r.pc}.q`, `${r.pend}.q`, `${r.valid}.q`], `entry ${k}`), `entry${k}`, true));
  b.next();
  const top = b.op(splitter(ENTRY, 2), [q[0]], 'top');
  const tm = `${top}.o0`, te = `${top}.o1`, tpc = `${top}.o2`, tpend = `${top}.o3`, tvalid = `${top}.o4`;
  const then = b.name(b.op1(bitwise('and', NL), ['mask', 'p'], 'then'), 'then', true);
  b.next();
  const els = b.name(b.op1(bitwise('xor', NL), ['mask', then], 'else'), 'else', true);
  const thenAny = anyOf(b, then, NL, 'then ≠ 0');
  const doJoin = b.name(b.op1(AND, ['join', tvalid], 'join, not empty'), 'doJoin', true);
  const npend = b.op1(NOT, [tpend]);
  b.next();
  const elseAny = anyOf(b, els, NL, 'else ≠ 0');
  const doClr = b.name(b.op1(AND, [doJoin, tpend], 'run the else lanes'), 'doClr', true);
  const doPop = b.name(b.op1(AND, [doJoin, npend], 'pop'), 'doPop', true);
  b.next();
  const pending = b.name(b.op1(AND, [thenAny, elseAny], 'both sides?'), 'pending', true);
  const one = b.op1(constWord(1, 1), []);
  const zero = b.op1(constWord(1, 0), []);
  b.next();
  const pushed = b.op1(merger(ENTRY, 2), ['mask', els, 'pc1', pending, one], 'pushed');
  const cleared = b.op1(merger(ENTRY, 2), [tm, te, tpc, zero, tvalid], 'top, else run');
  const shift = b.op1(OR, ['split', doPop]);
  b.next();
  const en0 = b.op1(OR, [b.op1(OR, ['split', doJoin]), 'rst'], 'entry 0 loads');
  const enK = b.op1(OR, [shift, 'rst'], 'entries shift');
  const nrst = b.op1(NOT, ['rst']);
  const MW = busMux2(EW);
  const e0a = b.op1(MW, [cleared, q[1], doPop], 'join');
  b.next();
  const d = L.map((k) => (k === 0 ? b.op1(MW, [e0a, pushed, 'split'], 'entry 0') : b.op1(MW, [k + 1 < STACK_DEPTH ? q[k + 1] : b.op1(constWord(EW, 0), []), q[k - 1], 'split'], `entry ${k}`)));
  b.next();
  regs.forEach((r, k) => {
    const s = b.op(splitter(ENTRY, 2), [d[k]]);
    b.wire(`${s}.o0`, `${r.m}.d`); b.wire(`${s}.o1`, `${r.e}.d`); b.wire(`${s}.o2`, `${r.pc}.d`); b.wire(`${s}.o3`, `${r.pend}.d`);
    b.wire(b.op1(AND, [`${s}.o4`, nrst], k ? undefined : 'valid, unless reset'), `${r.valid}.d`);
    for (const x of Object.values(r)) b.wire(k ? enK : en0, `${x}.en`);
  });
  b.next();
  // the mask's next value: split → the then lanes (or all, if one side is empty); join → else lanes or the saved mask
  const splitV = b.op1(busMux2(NL), ['mask', then, pending], 'split');
  const joinV = b.op1(busMux2(NL), [tm, te, doClr], 'join');
  b.next();
  b.wire(b.op1(busMux2(NL), [joinV, splitV, 'split'], 'next mask'), 'nmask');
  b.wire(b.op1(OR, ['split', doJoin], 'mask changes'), 'ld');
  b.wire(doClr, 'jump');
  b.wire(tpc, 'jpc');
  const R = b.right;
  return define({
    id: 'rv16_stack4', name: 'Reconvergence stack (RV16)', category: 'cpu',
    summary: `The split / join stack: ${STACK_DEPTH} entries of mask, else lanes, resume PC, pending and valid, shifted down by a push and up by a pop. split pushes and runs the lanes whose rs1 ≠ 0 (p) first; the first join sends the others to the instruction after the split (jump to jpc), the second restores the mask and pops. A split the lanes agree on parks nobody.`,
    ports: [bit('rst', 'in'), bit('split', 'in'), bit('join', 'in'), bus('mask', NL, 'in'), bus('p', NL, 'in'), bus('pc1', 16, 'in'), clkIn(),
      bit('ld', 'out'), bus('nmask', NL, 'out'), bit('jump', 'out'), bus('jpc', 16, 'out')],
    symbol: { kind: 'box', label: 'SPLIT / JOIN STACK' },
    netlist: () => ({ pins: { ...pinsAt(['rst', 'split', 'join', 'mask', 'p', 'pc1', 'clk'], 0), ...pinsAt(['ld', 'nmask', 'jump', 'jpc'], R) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** A reference model of the stack, cycle by cycle (the level's sequence check). */
export class StackModel {
  entries: { m: number; e: number; pc: number; pend: number }[] = [];
  out(i: { split: number; join: number; mask: number; p: number }): { ld: number; nmask: number; jump: number; jpc: number } {
    const t = this.entries[0];
    const then = i.mask & i.p, els = i.mask & ~then & 15, pending = then && els ? 1 : 0;
    const doJoin = i.join && t ? 1 : 0, doClr = doJoin && t!.pend ? 1 : 0;
    const nmask = i.split ? (pending ? then : i.mask) : doClr ? t!.e : t ? t.m : 0;
    return { ld: i.split || doJoin ? 1 : 0, nmask: i.split || doJoin ? nmask : -1, jump: doClr, jpc: t ? t.pc : -1 };
  }
  edge(i: { rst: number; split: number; join: number; mask: number; p: number; pc1: number }): void {
    if (i.rst) { this.entries = []; return; }
    const t = this.entries[0];
    const then = i.mask & i.p, els = i.mask & ~then & 15;
    if (i.split) {
      this.entries.unshift({ m: i.mask, e: els, pc: i.pc1, pend: then && els ? 1 : 0 });
      if (this.entries.length > STACK_DEPTH) this.entries.pop();
    } else if (i.join && t) {
      if (t.pend) t.pend = 0;
      else this.entries.shift();
    }
  }
}

// ---- the cores -------------------------------------------------------------------------------------

/** The pins of the lane core levels: one instruction stream, a memory port and a register write port per lane. */
export const LANE_PORTS: PortDef[] = [
  clkIn(), bit('rst', 'in'), bus('instr', 16, 'in'), ...each('drdata').map((p) => bus(p, 16, 'in')),
  bus('pc', 16, 'out'), ...each('daddr').map((p) => bus(p, 16, 'out')), ...each('dwdata').map((p) => bus(p, 16, 'out')), bus('dwe', NL, 'out'),
  bus('rwe', NL, 'out'), bus('rwa', 3, 'out'), ...each('rwd').map((p) => bus(p, 16, 'out')),
];

const lanes = new Map<string, ComponentDef>();

/**
 * The 4-lane RV16 core: the single-cycle core's fetch, control, immediates and next-PC logic, the lanes,
 * their register file and the mask. The leader's rs1 and rs2 decide branches and jalr, and give tmc its
 * mask. simt: split / join with the reconvergence stack (else they do nothing).
 */
export function rv16Lanes(simt: boolean): ComponentDef {
  const key = simt ? 'simt' : 'simd';
  let dd = lanes.get(key);
  if (dd) return dd;
  const b = new Builder(10, 16, 6);
  b.pins('clk', 'rst', 'instr', ...each('drdata'));
  const f = b.op(splitter([2, 2, 3, 3, 3, 3], 4), ['instr'], 'fields');
  const cond = b.name(`${f}.o0`, 'cond', true), rd = b.name(`${f}.o2`, 'rd', true);
  const rs1 = b.name(`${f}.o3`, 'rs1f', true), rs2 = b.name(`${f}.o4`, 'rs2f', true);
  b.next();
  const ctl = b.op(CTL16, ['instr'], 'control');
  const imm = b.op(IMM16, ['instr'], 'immediates');
  const ld = b.op(LANEDEC16, ['instr'], 'lane decode');
  b.next();
  const immv = b.name(choose4(b, [`${imm}.i`, `${imm}.sb`, `${imm}.j`, `${imm}.u`], `${ctl}.isel`, 'imm').y, 'imm', true);
  const rwe = b.name(b.op1(OR, [`${ctl}.rwe`, `${ld}.tid`], 'writes a register'), 'rwe', true);
  const mask = b.add(MASK16, 'active mask');
  for (const [p, v] of [['rst', 'rst'], ['rwe', rwe], ['mwe', `${ctl}.mwe`], ['clk', 'clk']]) b.wire(v, `${mask}.${p}`);
  const maskv = b.name(`${mask}.mask`, 'mask', true);
  b.next();
  const vrf = b.add(VRF16, 'lane registers');
  for (const [p, v] of [['wa', rd], ['we', `${mask}.we`], ['ra1', rs1], ['ra2', rs2], ['clk', 'clk']]) b.wire(v, `${vrf}.${p}`);
  const a = L.map((i) => b.name(`${vrf}.a${i}`, `r1_${i}`, true)), r2 = L.map((i) => b.name(`${vrf}.b${i}`, `r2_${i}`, true));
  b.next();
  const ln = b.op(LANES16, [...a, ...r2, immv, `${ctl}.bimm`, `${ctl}.alu`], 'lanes');
  const la = b.name(b.op1(RV16_MUX4, [...a, `${mask}.lead`], 'leader rs1'), 'leadA', true);
  const lb = b.op1(RV16_MUX4, [...r2, `${mask}.lead`], 'leader rs2');
  b.next();
  const take = b.op1(BRANCH16, [la, lb, cond], 'branch?');
  const tm = b.op(splitter([NL, 16 - NL], 2), [la], 'tmc mask');
  b.next();
  const np = b.op(NEXTPC16, ['', immv, la, `${ctl}.br`, take, `${ctl}.jal`, `${ctl}.jalr`], 'next PC');
  const pc1 = b.name(`${np}.pc1`, 'pc1', true);
  let jump = '', jpc = '';
  if (simt) {
    const st = b.op(STACK16, ['rst', `${ld}.split`, `${ld}.join`, maskv, `${ln}.nz`, pc1, 'clk'], 'split / join stack');
    jump = `${st}.jump`; jpc = `${st}.jpc`;
    b.next();
    b.wire(b.op1(OR, [`${ld}.tmc`, `${st}.ld`], 'mask loads'), `${mask}.ld`);
    b.wire(b.op1(busMux2(NL), [`${st}.nmask`, `${tm}.o0`, `${ld}.tmc`], 'next mask'), `${mask}.d`);
  } else {
    b.wire(`${ld}.tmc`, `${mask}.ld`);
    b.wire(`${tm}.o0`, `${mask}.d`);
  }
  b.next();
  // results: ALU or memory per lane; pc + 1 or the immediate shared; tid per lane
  const ws = b.op(splitter([1, 1], 2), [`${ctl}.wb`], 'wb');
  const shared = b.op1(MUX16, [pc1, immv, `${ws}.o0`], 'pc + 1 / imm');
  b.next();
  const own = L.map((i) => b.op1(MUX16, [`${ln}.y${i}`, `drdata${i}`, `${ws}.o0`], `ALU / memory ${i}`));
  b.next();
  const res = L.map((i) => b.op1(MUX16, [own[i], shared, `${ws}.o1`], `result ${i}`));
  b.next();
  const wd = L.map((i) => b.name(b.op1(MUX16, [res[i], b.op1(constWord(16, i), [], `tid ${i}`), `${ld}.tid`], `or tid ${i}`), `wd${i}`, true));
  wd.forEach((w, i) => { b.wire(w, `${vrf}.wd${i}`); b.wire(w, `rwd${i}`); });
  b.next();
  // the PC: pc + 1, the branch / jump target, the join's resume address; 0 at reset
  let nx = b.op1(MUX16, [pc1, `${np}.target`, `${np}.ld`], 'load?');
  if (simt) {
    b.next();
    nx = b.op1(MUX16, [nx, jpc, jump], 'join jump?');
  }
  b.next();
  const m2 = b.op1(MUX16, [nx, b.op1(constWord(16, 0), []), 'rst'], 'reset?');
  b.next();
  const pcq = b.name(b.op1(RV16_DREG16, [m2, 'clk'], 'PC'), 'pc', true);
  b.wire(pcq, `${np}.pc`);
  b.wire(pcq, 'pc');
  L.forEach((i) => { b.wire(`${ln}.y${i}`, `daddr${i}`); b.wire(r2[i], `dwdata${i}`); });
  b.wire(`${mask}.dwe`, 'dwe');
  b.wire(`${mask}.we`, 'rwe');
  b.wire(rd, 'rwa');
  const R = b.right;
  dd = define({
    id: simt ? 'rv16_simt' : 'rv16_simd', name: simt ? 'RV16 SIMT core (4 lanes)' : 'RV16 SIMD core (4 lanes)', category: 'cpu',
    summary: 'One PC, one control unit and one immediate generator; four lanes, each with its own registers, ALU and memory port. The active mask decides which lanes write; the leader (lowest active lane) decides branches and jalr and gives tmc its new mask; csrr rd, tid gives each lane its number.'
      + (simt ? ' split / join run the two sides of an if one after the other, on the reconvergence stack.' : ' Branches the lanes disagree on follow the leader.'),
    ports: LANE_PORTS,
    symbol: { kind: 'box', label: simt ? 'RV16 SIMT' : 'RV16 SIMD' },
    netlist: () => ({
      pins: { ...pinsAt(['clk', 'rst', 'instr', ...each('drdata')], 0, 4), ...pinsAt(['pc', ...each('daddr'), ...each('dwdata'), 'dwe', 'rwe', 'rwa', ...each('rwd')], R, 4) },
      instances: b.instances, nets: b.nets(),
    }),
  });
  lanes.set(key, dd);
  return dd;
}

// Built at load, so that a chip placing one by library id resolves after a reload.
export const RV16_SIMD = rv16Lanes(false);
export const RV16_SIMT = rv16Lanes(true);
