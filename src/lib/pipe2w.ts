// Phase 17b: the dual-issue in-order pipeline (pipe-2w, chapter 24). The balanced RV32IM pipeline with branch
// prediction, two lanes wide: fetch reads two words a cycle (pc, pc + 4) and decode issues them together when
// they are independent. Lane 0 carries the older instruction and has everything (data memory, multiplier,
// divider); lane 1 has an ALU, a branch comparator and the target adders.
//
//  F  pc and pc + 4 from a two-port ROM; the BTB looks up both, the return-address stack predicts returns
//     (lib/ras.ts). A slot predicted taken ends the pair: slot 1 is fetched only when slot 0 is not.
//  D  both decoded; four register reads (bypassed from both W lanes). PAIR_CHECK says whether slot 1 may go
//     with slot 0: not a load / store / multiply / divide, not a second control instruction, not after a
//     divide, not reading slot 0's result. If not, slot 0 goes alone and slot 1 moves into slot 0 (hold and
//     shift: the PC holds for that cycle). Forwarding is chosen here for E (look-ahead, as the balanced
//     pipeline), from both lanes' M and W, the younger lane first.
//  E  per lane: ALU, branch comparator, mispredict check. Lane 0 also the multiplier's first half and the
//     divider (which stalls F, D and E). A misprediction redirects fetch and flushes F / D (lane 0's also
//     kills lane 1's instruction in E: it is younger). One BTB update and one committed return-stack update.
//  M  lane 0: data memory and the multiplier's second half. W: two register-file writes (lane 1 wins).
// Up to two instructions retire a cycle: `retire` is their count, oldest first (riscv/cosim.ts retireCount),
// `pcW0` the oldest's PC.

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, PortDef } from '../sim/types';
import { alu, constWord, isZero } from './alu';
import { Builder } from './builder';
import { busMux2, equal, muxTree } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, PLUS4_FAST, dataMemory, rom } from './cpu';
import { define, merger, splitter } from './define';
import { koggeStone } from './fastadd';
import { AND, NOT, OR, XOR } from './gates';
import { BRANCH_CMP, MISPREDICT, btbOf, clearableRegister, nonZero } from './pipeline';
import { DIV_E, MUL_E, MUL_M } from './pipem';
import { ras } from './ras';
import { regfile2w } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { andN } from './combinational';
import { orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** Bits of x from lo, n wide. */
const bits = (x: number, lo: number, n: number) => Math.floor(x / 2 ** lo) % 2 ** n;
const LINK = (r: number) => r === 1 || r === 5;

// ---- fetch ---------------------------------------------------------------------------------------------------------

/** The program ROM with two read ports (the slots at pc and pc + 4): two copies of one ROM, as on a real chip a dual-ported array. */
export function rom2(words: number[], k: number): ComponentDef {
  const R = rom(words, k), rg = symbolGeom(R);
  // not registered (like rom()): a ROM made for one program is no library part
  return memo(`rom2_${R.id}`, () => ({
    id: `${R.id.replace(/^rom_/, 'rom2_')}`, name: 'Instruction memory (two read ports)', category: 'memory',
    summary: `The program ROM read twice a cycle: the word at pc and the word at pc + 4, the two slots of a fetch pair. ${2 ** k} words.`,
    ports: [bus('addr0', 32, 'in'), bus('addr1', 32, 'in'), bus('data0', 32, 'out'), bus('data1', 32, 'out')],
    symbol: { kind: 'box', label: 'INSTR MEM ×2' },
    netlist: () => ({
      pins: { addr0: [0, 2 + rg.ports.addr.pos[1]], addr1: [0, rg.h + 8 + rg.ports.addr.pos[1]], data0: [rg.w + 10, 2 + rg.ports.data.pos[1]], data1: [rg.w + 10, rg.h + 8 + rg.ports.data.pos[1]] },
      instances: [{ name: 'p0', def: R, at: [4, 2], label: 'read at pc' }, { name: 'p1', def: R, at: [4, rg.h + 8], label: 'read at pc + 4' }],
      nets: [
        { name: 'addr0', ends: ['addr0', 'p0.addr'] }, { name: 'addr1', ends: ['addr1', 'p1.addr'] },
        { name: 'data0', ends: ['p0.data', 'data0'] }, { name: 'data1', ends: ['p1.data', 'data1'] },
      ],
    }),
  }));
}

/** Calls and returns, from the instruction word alone (fetch knows them before decode). The rules of riscv/ilp.ts classify(). */
export const PREDECODE: ComponentDef = (() => {
  const b = new Builder(10, 10);
  b.pins('instr');
  const s = b.op(splitter([7, 5, 3, 5, 12]), ['instr'], undefined, 'f');
  b.next();
  const k = (v: number, w: number, nm: string) => b.op1(constWord(w, v), [], undefined, nm);
  const opJal = k(0x6f, 7, 'kJal'), opJalr = k(0x67, 7, 'kJalr'), r1 = k(1, 5, 'kRa'), r5 = k(5, 5, 'kT0'), r1b = k(1, 5, 'kRa2'), r5b = k(5, 5, 'kT02');
  b.next();
  const isJal = b.name(b.op1(equal(7), [`${s}.o0`, opJal], undefined, 'jal'), 'jal', true);
  const isJalr = b.name(b.op1(equal(7), [`${s}.o0`, opJalr], undefined, 'jalr'), 'jalr', true);
  const rdRa = b.op1(equal(5), [`${s}.o1`, r1], undefined, 'rdRa'), rdT0 = b.op1(equal(5), [`${s}.o1`, r5], undefined, 'rdT0');
  const rsRa = b.op1(equal(5), [`${s}.o3`, r1b], undefined, 'rsRa'), rsT0 = b.op1(equal(5), [`${s}.o3`, r5b], undefined, 'rsT0');
  const rd0 = b.op1(isZero(5), [`${s}.o1`], undefined, 'rd0'), imm0 = b.op1(isZero(12), [`${s}.o4`], undefined, 'imm0');
  b.next();
  const rdLink = b.op1(OR, [rdRa, rdT0], undefined, 'rdLink'), rsLink = b.op1(OR, [rsRa, rsT0], undefined, 'rsLink');
  const jump = b.op1(OR, [isJal, isJalr], undefined, 'jump');
  b.next();
  b.wire(b.op1(AND, [jump, rdLink], undefined, 'isCall'), 'call');
  b.wire(b.op1(andN(4), [isJalr, rd0, rsLink, imm0], undefined, 'isRet'), 'ret');
  const R = b.right;
  return define({
    id: 'predecode', name: 'Call / return predecode', category: 'cpu',
    summary: 'Spots calls and returns in a fetched word, before decode: a call is jal or jalr writing ra or t0 (push the return address); a return is jalr x0, 0(ra or t0) (predict it from the return stack).',
    ports: [bus('instr', 32, 'in'), bit('call', 'out'), bit('ret', 'out')],
    symbol: { kind: 'box', label: 'CALL / RET?' },
    spec: ([w]) => {
      const op = bits(w, 0, 7), rd = bits(w, 7, 5), rs1 = bits(w, 15, 5), imm = bits(w, 20, 12);
      return [(op === 0x6f || op === 0x67) && LINK(rd) ? 1 : 0, op === 0x67 && rd === 0 && LINK(rs1) && imm === 0 ? 1 : 0];
    },
    netlist: () => ({ pins: { instr: [0, 4], call: [R, 4], ret: [R, 8] }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- decode -----------------------------------------------------------------------------------------------------

/** What issuing cares about in an instruction: memory, multiply / divide, which source registers it reads. */
export const ISSUE_CLASS: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('op', 'funct3', 'funct7');
  const k = (v: number, nm: string) => b.op1(constWord(7, v), [], undefined, nm);
  const ks = [['kLd', 0x03], ['kSt', 0x23], ['kR', 0x33], ['kB', 0x63], ['kLui', 0x37], ['kAuipc', 0x17], ['kJal', 0x6f]] as const;
  const kk = Object.fromEntries(ks.map(([n, v]) => [n, k(v, n)]));
  const one = b.op1(constWord(7, 1), [], undefined, 'kM');
  const f3 = b.op(splitter([2, 1]), ['funct3'], undefined, 'f3');
  b.next();
  const is = (nm: string, kn: string) => b.name(b.op1(equal(7), ['op', kk[kn]], undefined, nm), nm, true);
  const ld = is('isLoad', 'kLd'), st = is('isStore', 'kSt'), r = is('isR', 'kR'), br = is('isBranch', 'kB'), lui = is('isLui', 'kLui'), auipc = is('isAuipc', 'kAuipc'), jal = is('isJal', 'kJal');
  const f7m = b.op1(equal(7), ['funct7', one], undefined, 'f7is1');
  const nf2 = b.op1(NOT, [`${f3}.o1`], undefined, 'nf2');
  b.next();
  const mem = b.op1(OR, [ld, st], undefined, 'mem');
  const md = b.name(b.op1(AND, [r, f7m], undefined, 'md'), 'md', true);
  const noRs1 = b.op1(orN(3), [lui, auipc, jal], undefined, 'noRs1');
  const rs2 = b.op1(orN(3), [r, br, st], undefined, 'rs2');
  b.next();
  b.wire(mem, 'mem'); b.wire(md, 'md');
  b.wire(b.op1(AND, [md, `${f3}.o1`], undefined, 'isDiv'), 'div');
  b.wire(b.op1(AND, [md, nf2], undefined, 'isMul'), 'mul');
  b.wire(b.op1(NOT, [noRs1], undefined, 'rs1'), 'u1');
  b.wire(rs2, 'u2');
  const R = b.right;
  return define({
    id: 'issueclass', name: 'Issue class', category: 'cpu',
    summary: 'What the issue logic needs to know about an instruction: does it use the data memory, the multiplier or the divider, and which source registers does it really read (rs1: all but lui, auipc and jal; rs2: register-register ops, branches and stores). A field an instruction does not read never makes it wait.',
    ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), bit('mem', 'out'), bit('md', 'out'), bit('mul', 'out'), bit('div', 'out'), bit('u1', 'out'), bit('u2', 'out')],
    symbol: { kind: 'box', label: 'CLASS' },
    spec: ([op, f3, f7]) => {
      const md = op === 0x33 && f7 === 1;
      return [op === 0x03 || op === 0x23 ? 1 : 0, md ? 1 : 0, md && f3 < 4 ? 1 : 0, md && f3 >= 4 ? 1 : 0, op === 0x37 || op === 0x17 || op === 0x6f ? 0 : 1, op === 0x33 || op === 0x63 || op === 0x23 ? 1 : 0];
    },
    netlist: () => ({ pins: { op: [0, 2], funct3: [0, 4], funct7: [0, 6], mem: [R, 2], md: [R, 4], mul: [R, 6], div: [R, 8], u1: [R, 10], u2: [R, 12] }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * May slot 1 issue with slot 0? Slot 1 must be valid; it may not use the data memory, the multiplier or the
 * divider (lane 0 has them), may not be a second control instruction (one redirect, one predictor update),
 * may not follow a divide (which holds E), and may not read slot 0's result (it is not computed yet).
 */
export const PAIR_CHECK: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('v1', 'mem1', 'md1', 'ctrl0', 'ctrl1', 'div0', 'regWrite0', 'rd0', 'rs1', 'rs2', 'u1', 'u2');
  const e1 = b.op1(equal(5), ['rs1', 'rd0'], undefined, 'eq1'), e2 = b.op1(equal(5), ['rs2', 'rd0'], undefined, 'eq2');
  const nz = b.op1(nonZero(5), ['rd0'], undefined, 'rdNz');
  const both = b.op1(AND, ['ctrl0', 'ctrl1'], undefined, 'twoCtrl');
  b.next();
  const r1 = b.op1(AND, [e1, 'u1'], undefined, 'reads1'), r2 = b.op1(AND, [e2, 'u2'], undefined, 'reads2');
  const w = b.op1(AND, ['regWrite0', nz], undefined, 'writes');
  b.next();
  const reads = b.op1(OR, [r1, r2], undefined, 'reads');
  b.next();
  const raw = b.name(b.op1(AND, [reads, w], undefined, 'raw'), 'RAW', true);
  b.next();
  const no = b.op1(orN(5), ['mem1', 'md1', both, 'div0', raw], undefined, 'conflict');
  b.next();
  const ok = b.op1(NOT, [no], undefined, 'nc');
  b.next();
  b.wire(b.op1(AND, ['v1', ok], undefined, 'pair'), 'ok');
  const R = b.right;
  const ins = ['v1', 'mem1', 'md1', 'ctrl0', 'ctrl1', 'div0', 'regWrite0', 'rd0', 'rs1', 'rs2', 'u1', 'u2'];
  return define({
    id: 'paircheck', name: 'Pair check', category: 'cpu',
    summary: 'Can the second instruction of the pair issue now, beside the first? Not if it needs what only lane 0 has (memory, multiplier, divider), not if both are control instructions, not after a divide, and not if it reads the first one\'s result (a read-after-write inside the pair).',
    ports: [bit('v1', 'in'), bit('mem1', 'in'), bit('md1', 'in'), bit('ctrl0', 'in'), bit('ctrl1', 'in'), bit('div0', 'in'), bit('regWrite0', 'in'), bus('rd0', 5, 'in'),
      bus('rs1', 5, 'in'), bus('rs2', 5, 'in'), bit('u1', 'in'), bit('u2', 'in'), bit('ok', 'out')],
    symbol: { kind: 'box', label: 'PAIR?' },
    spec: ([v1, mem1, md1, c0, c1, div0, w0, rd0, rs1, rs2, u1, u2]) => {
      const raw = w0 && rd0 !== 0 && ((u1 && rs1 === rd0) || (u2 && rs2 === rd0));
      return [v1 && !mem1 && !md1 && !(c0 && c1) && !div0 && !raw ? 1 : 0];
    },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ok: [R, 2] }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The four source operands: slot 0's rs1 / rs2 (A0, B0), slot 1's (A1, B1). */
const OPS = ['A0', 'B0', 'A1', 'B1'] as const;

/**
 * The dual-issue hazard unit (look-ahead, in D). For each source operand: forward to E from the younger
 * producer first (lane 1 in E → M1 = 4, lane 0 in E → M0 = 3, lane 1 in M → W1 = 2, lane 0 in M → W0 = 1, else
 * the register file = 0), bypass from W into the register read (W1 = 2, W0 = 1), and stall when a load (or a
 * multiply, which also finishes in M) in lane 0's E produces a register an issuing instruction reads.
 */
export const HAZARD2: ComponentDef = (() => {
  const b = new Builder(16, 18);
  const prods = ['E1', 'E0', 'M1', 'M0', 'W1', 'W0'] as const;
  b.pins(...OPS.map((o) => `r${o}`), ...OPS.map((o) => `u${o}`), ...prods.map((p) => `rd${p}`), ...prods.map((p) => `regWrite${p}`), 'loadE0');
  const m: Record<string, Record<string, string>> = {};
  for (const o of OPS) {
    m[o] = {};
    const nz = b.op1(nonZero(5), [`r${o}`], undefined, `nz${o}`);
    const live = b.name(b.op1(AND, [nz, `u${o}`], undefined, `live${o}`), `reads ${o}`, true);
    for (const p of prods) {
      const eq = b.op1(equal(5), [`r${o}`, `rd${p}`], undefined, `eq${o}${p}`);
      m[o][p] = b.name(b.op1(andN(3), [eq, `regWrite${p}`, live], undefined, `m${o}${p}`), `${o}=${p}`, true);
    }
    m[o].ld = b.op1(AND, [`eq${o}E0.eq`, live], undefined, `ld${o}`);
  }
  b.next();
  const outs: string[] = [];
  for (const o of OPS) {
    const x = m[o];
    const nE1 = b.op1(NOT, [x.E1], undefined, `nE1${o}`), nE0 = b.op1(NOT, [x.E0], undefined, `nE0${o}`), nM1 = b.op1(NOT, [x.M1], undefined, `nM1${o}`);
    const pE0 = b.op1(AND, [x.E0, nE1], undefined, `pE0${o}`);
    const pM1 = b.op1(andN(3), [x.M1, nE1, nE0], undefined, `pM1${o}`);
    const pM0 = b.op1(andN(4), [x.M0, nE1, nE0, nM1], undefined, `pM0${o}`);
    const s0 = b.op1(OR, [pM0, pE0], undefined, `s0${o}`), s1 = b.op1(OR, [pM1, pE0], undefined, `s1${o}`);
    b.wire(b.op1(merger([1, 1, 1]), [s0, s1, x.E1], undefined, `fwd${o}`), `fwd${o}`);
    const nW1 = b.op1(NOT, [x.W1], undefined, `nW1${o}`);
    const pW0 = b.op1(AND, [x.W0, nW1], undefined, `pW0${o}`);
    b.wire(b.op1(merger([1, 1]), [pW0, x.W1], undefined, `byp${o}`), `byp${o}`);
    outs.push(`fwd${o}`, `byp${o}`);
  }
  b.next();
  const uses = b.op1(orN(4), OPS.map((o) => m[o].ld), undefined, 'usesLoad');
  b.next();
  b.wire(b.op1(AND, ['loadE0', uses], undefined, 'stall'), 'lwStall');
  const R = b.right;
  const ins = [...OPS.map((o) => `r${o}`), ...OPS.map((o) => `u${o}`), ...prods.map((p) => `rd${p}`), ...prods.map((p) => `regWrite${p}`), 'loadE0'];
  type Ins = number[];
  return define({
    id: 'hazard2', name: 'Hazard unit (dual issue)', category: 'cpu',
    summary: 'Decides, while two instructions are in D, where each of their four operands will come from in E: the register file, or forwarded from either lane in M or W, the younger lane first (it wrote last). Bypasses W into the register read, and stalls the pair when lane 0\'s instruction in E is a load or multiply whose result one of them reads.',
    ports: [
      ...OPS.map((o) => bus(`r${o}`, 5, 'in')), ...OPS.map((o) => bit(`u${o}`, 'in')), ...prods.map((p) => bus(`rd${p}`, 5, 'in')), ...prods.map((p) => bit(`regWrite${p}`, 'in')), bit('loadE0', 'in'),
      ...OPS.flatMap((o) => [bus(`fwd${o}`, 3, 'out'), bus(`byp${o}`, 2, 'out')]), bit('lwStall', 'out'),
    ],
    symbol: { kind: 'box', label: 'HAZARD ×2' },
    spec: (x: Ins) => {
      const r = x.slice(0, 4), u = x.slice(4, 8), rd = x.slice(8, 14), w = x.slice(14, 20), ld = x[20];
      const out: number[] = [];
      let stall = 0;
      for (let k = 0; k < 4; k++) {
        const live = r[k] !== 0 && u[k] === 1;
        const hit = (p: number) => live && r[k] === rd[p] && w[p] === 1;
        out.push(hit(0) ? 4 : hit(1) ? 3 : hit(2) ? 2 : hit(3) ? 1 : 0, hit(4) ? 2 : hit(5) ? 1 : 0);
        if (live && r[k] === rd[1]) stall = ld;
      }
      if (stall) return [...out, 1];
      return [...out, 0];
    },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries([...outs, 'lwStall'].map((n, i) => [n, [R, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
  });
})();

// ---- pipeline registers ------------------------------------------------------------------------------------------------

type Field = [name: string, width: number];

/** A pipeline register of named fields (field + `from` in, field + `to` out), with enable and synchronous clear. */
function stageReg(name: string, from: string, to: string, fields: Field[]): ComponentDef {
  const sig = `${name}_${fields.map(([f, w]) => `${f}${w}`).join(',')}`;
  return memo(sig, () => {
    const widths = fields.map(([, w]) => w), total = widths.reduce((a, b) => a + b, 0);
    const C = clearableRegister(total), cg = symbolGeom(C), P = 3;
    return define({
      id: `pipe2_${name.replace('/', '')}_${total}`, name: `${name} pipeline register`, category: 'sequential',
      summary: `Holds everything the next stage needs (${total} bits): ${fields.map(([f]) => f).join(', ')}. en = 0 holds it, clr = 1 turns it into a bubble.`,
      ports: [...fields.map(([f, w]) => bus(f + from, w, 'in')), bit('en', 'in'), bit('clr', 'in'), bit('clk', 'in', 'bottom', true), ...fields.map(([f, w]) => bus(f + to, w, 'out'))],
      symbol: { kind: 'box', label: name, verticalLabel: true },
      netlist: () => ({
        pins: {
          ...Object.fromEntries(fields.map(([f], i) => [f + from, [0, 2 + P * i] as [number, number]])),
          ...Object.fromEntries(fields.map(([f], i) => [f + to, [24 + cg.w + 14, 2 + P * i] as [number, number]])),
          en: [0, 2 + P * fields.length + 3], clr: [0, 2 + P * fields.length + 5], clk: [0, 2 + P * fields.length + 7],
        },
        instances: [
          { name: 'bundle', def: merger(widths, P), at: [8, 2 - P / 2] },
          { name: 'r', def: C, at: [18, 2] },
          { name: 'unbundle', def: splitter(widths, P), at: [24 + cg.w + 6, 2 - P / 2] },
        ],
        nets: [
          ...fields.map(([f], i) => ({ name: f + from, ends: [f + from, `bundle.i${i}`] })),
          { name: 'd', ends: ['bundle.out', 'r.d'] },
          { name: 'en', ends: ['en', 'r.en'] }, { name: 'clr', ends: ['clr', 'r.clr'] }, { name: 'clk', ends: ['clk', 'r.clk'] },
          { name: 'q', ends: ['r.q', 'unbundle.in'] },
          ...fields.map(([f], i) => ({ name: f + to, ends: [`unbundle.o${i}`, f + to] })),
        ],
      }),
    });
  });
}

const F_FIELDS: Field[] = [['valid', 1], ['pc', 32], ['pcPlus4', 32], ['instr', 32], ['predTarget', 32], ['predTaken', 1], ['call', 1], ['ret', 1]];
const CTRL: Field[] = [['regWrite', 1], ['aluSrcA', 1], ['aluSrcB', 1], ['resultSrc', 2], ['branch', 1], ['jump', 1], ['jalr', 1], ['aluCtl', 4], ['funct3', 3]];
const D_FIELDS = (lane0: boolean): Field[] => [
  ['valid', 1], ['pc', 32], ['pcPlus4', 32], ['rd1', 32], ['rd2', 32], ['imm', 32], ['predTarget', 32], ['rd', 5], ...CTRL,
  ['fwdA', 3], ['fwdB', 3], ['predTaken', 1], ['call', 1], ['ret', 1], ...(lane0 ? [['memWrite', 1], ['mul', 1], ['div', 1]] as Field[] : []),
];
const E_FIELDS = (lane0: boolean): Field[] => [
  ['valid', 1], ['pc', 32], ['pcPlus4', 32], ['aluResult', 32], ['imm', 32], ['rd', 5], ['regWrite', 1], ['resultSrc', 2],
  ...(lane0 ? [['writeData', 32], ['memWrite', 1], ['mul', 1], ['mf', 2], ['ms', 64], ['mc', 64]] as Field[] : []),
];
const M_FIELDS = (lane0: boolean): Field[] => [
  ['valid', 1], ['pc', 32], ['pcPlus4', 32], ['aluResult', 32], ['imm', 32], ['rd', 5], ['regWrite', 1], ['resultSrc', 2], ...(lane0 ? [['readData', 32]] as Field[] : []),
];

// ---- the processor ---------------------------------------------------------------------------------------------------

export interface DualOptions {
  /** Data memory of 2^dmemK words (default 5). */
  dmemK?: number;
  /** Instruction ROM of 2^imemK words (default 6). */
  imemK?: number;
}

export function dualPipeCpu(program: number[], opts: DualOptions = {}): ComponentDef {
  const k = opts.imemK ?? 6, dk = opts.dmemK ?? 5;
  const IM = rom2(program, k);
  return memo(`pipe2w_${IM.id}_${dk}`, () => buildDual(IM, dk));
}

function buildDual(IM: ComponentDef, dmemK: number): ComponentDef {
  const b = new Builder(10, 14, 4);
  const L = [0, 1] as const;
  const s = (l: number) => (l ? '1' : '');
  /** Add an instance and wire its inputs by port name. */
  const put = (def: ComponentDef, name: string, conns: Record<string, string>, label?: string): string => {
    b.add(def, label, name);
    for (const [p, d] of Object.entries(conns)) b.wire(d, `${name}.${p}`);
    return name;
  };
  const tie0 = () => b.op1(TIE0, [], undefined, `g${b.instances.length}`);
  const M2 = busMux2(32), M4 = muxTree(2, 32), M8 = muxTree(3, 32), ADD = koggeStone(32);
  b.pins('clk');

  // ---- F: two words, two predictions -----------------------------------------------------------------------------
  put(register(32), 'pc', { d: 'pcmux.y', en: 'ctl.enPC', clk: 'clk' }, 'PC');
  b.next();
  put(PLUS4_FAST, 'plus4', { a: 'pc.q' }, 'pc + 4');
  put(PLUS4_FAST, 'plus8', { a: 'plus4.y' }, 'pc + 8');
  put(IM, 'imem', { addr0: 'pc.q', addr1: 'plus4.y' });
  put(btbOf(2), 'btb', { pcF: 'pc.q', pcF1: 'plus4.y', pcE: 'upd.pcE', updE: 'upd.upd', takenE: 'upd.taken', isJumpE: 'upd.isJump', targetE: 'upd.target', clk: 'clk' }, 'branch predictor');
  put(PREDECODE, 'pd0', { instr: 'imem.data0' }, 'slot 0');
  put(PREDECODE, 'pd1', { instr: 'imem.data1' }, 'slot 1');
  put(ras(4, 32), 'ras', { pushF: 'fctl.pushF', popF: 'fctl.popF', valF: 'fctl.valF', pushC: 'cmt.pushC', popC: 'cmt.popC', valC: 'cmt.valC', restore: 'ctl.redirect', clk: 'clk' }, 'return stack');
  b.next();
  put(FETCH_PRED, 'fctl', {
    call0: 'pd0.call', ret0: 'pd0.ret', call1: 'pd1.call', ret1: 'pd1.ret', pt0: 'btb.predTaken', pt1: 'btb.predTaken1', tgt0: 'btb.predTarget', tgt1: 'btb.predTarget1',
    top: 'ras.top', any: 'ras.any', pc4: 'plus4.y', pc8: 'plus8.y', advance: 'ctl.fetchGo',
  }, 'fetch prediction');
  b.next();
  put(M2, 'pcmux', { a: 'fctl.next', b: 'ctl.correctPC', s: 'ctl.redirect' }, 'next PC');
  // IF/ID: lane 0 takes slot 0, or (hold and shift) the waiting slot 1
  const one = b.op1(TIE1, [], undefined, 'vF');
  const shift = (f: string, w: number, a: string) => b.op1(w === 32 ? M2 : busMux2(w), [a, `FD1.${f}D`, 'ctl.shift'], undefined, `sh_${f}`);
  const fd0: Record<string, string> = {
    validF: shift('valid', 1, one), pcF: shift('pc', 32, 'pc.q'), pcPlus4F: shift('pcPlus4', 32, 'plus4.y'), instrF: shift('instr', 32, 'imem.data0'),
    predTargetF: shift('predTarget', 32, 'fctl.target0'), predTakenF: shift('predTaken', 1, 'fctl.take0'), callF: shift('call', 1, 'pd0.call'), retF: shift('ret', 1, 'pd0.ret'),
  };
  b.next();
  put(stageReg('IF/ID', 'F', 'D', F_FIELDS), 'FD', { ...fd0, en: 'ctl.enFD', clr: 'ctl.redirect', clk: 'clk' });
  put(stageReg('IF/ID 1', 'F', 'D', F_FIELDS), 'FD1', {
    validF: 'fctl.valid1', pcF: 'plus4.y', pcPlus4F: 'plus8.y', instrF: 'imem.data1', predTargetF: 'fctl.target1', predTakenF: 'fctl.take1', callF: 'pd1.call', retF: 'pd1.ret',
    en: 'ctl.enFD', clr: 'ctl.clrFD1', clk: 'clk',
  });
  b.next();

  // ---- D: decode both, read four registers, pair, hazards ---------------------------------------------------------
  for (const l of L) {
    const FD = `FD${s(l)}`;
    put(splitter([7, 5, 3, 5, 5, 7]), `si${s(l)}`, { in: `${FD}.instrD` });
    put(CONTROL, `ctl${l}`, { op: `si${s(l)}.o0`, funct3: `si${s(l)}.o2`, funct7: `si${s(l)}.o5` });
    put(IMM_GEN, `imm${s(l)}`, { instr: `${FD}.instrD`, src: `ctl${l}.immSrc` });
    put(ISSUE_CLASS, `cls${l}`, { op: `si${s(l)}.o0`, funct3: `si${s(l)}.o2`, funct7: `si${s(l)}.o5` });
    put(orN(3), `isCtl${l}`, { i0: `ctl${l}.branch`, i1: `ctl${l}.jump`, i2: `ctl${l}.jalr` });
    put(AND, `u1v${l}`, { a: `cls${l}.u1`, b: `${FD}.validD` });
    put(AND, `u2v${l}`, { a: `cls${l}.u2`, b: `${FD}.validD` });
  }
  b.next();
  put(regfile2w(5, 32), 'rf', {
    wa0: 'MW.rdW', we0: 'MW.regWriteW', wd0: 'res.y', wa1: 'MW1.rdW', we1: 'MW1.regWriteW', wd1: 'res1.y',
    ra1: 'si.o3', ra2: 'si.o4', ra3: 'si1.o3', ra4: 'si1.o4', clk: 'clk',
  });
  put(PAIR_CHECK, 'pair', {
    v1: 'FD1.validD', mem1: 'cls1.mem', md1: 'cls1.md', ctrl0: 'isCtl0.y', ctrl1: 'isCtl1.y', div0: 'cls0.div', regWrite0: 'ctl0.regWrite', rd0: 'si.o1',
    rs1: 'si1.o3', rs2: 'si1.o4', u1: 'cls1.u1', u2: 'cls1.u2',
  }, 'pair?');
  put(HAZARD2, 'hz', {
    rA0: 'si.o3', rB0: 'si.o4', rA1: 'si1.o3', rB1: 'si1.o4', uA0: 'u1v0.y', uB0: 'u2v0.y', uA1: 'u1v1.y', uB1: 'u2v1.y',
    rdE1: 'DE1.rdE', rdE0: 'DE.rdE', rdM1: 'EM1.rdM', rdM0: 'EM.rdM', rdW1: 'MW1.rdW', rdW0: 'MW.rdW',
    regWriteE1: 'DE1.regWriteE', regWriteE0: 'DE.regWriteE', regWriteM1: 'EM1.regWriteM', regWriteM0: 'EM.regWriteM', regWriteW1: 'MW1.regWriteW', regWriteW0: 'MW.regWriteW',
    loadE0: 'ldE.y',
  }, 'hazards');
  // lane 0 in E finishes in M (a load, or a multiply): resultSrc = 01
  put(splitter([1, 1]), 'rsE', { in: 'DE.resultSrcE' });
  put(NOT, 'nrs1E', { a: 'rsE.o1' });
  put(andN(3), 'ldE', { i0: 'rsE.o0', i1: 'nrs1E.y', i2: 'DE.validE' });
  // a multiply takes the load's path (resultSrc = 01); W bypass into each register read
  put(busMux2(2), 'rsm', { a: 'ctl0.resultSrc', b: 'kLd.y', s: 'cls0.mul' }, 'load path');
  put(constWord(2, 1), 'kLd', {});
  const rdOf = ['rf.rd1', 'rf.rd2', 'rf.rd3', 'rf.rd4'];
  OPS.forEach((o, i) => put(M4, `by${o}`, { d0: rdOf[i], d1: 'res.y', d2: 'res1.y', d3: 'res1.y', s: `hz.byp${o}` }, `bypass ${o}`));
  put(CONTROL_2W, 'ctl', {
    redirect0: 'mis.mispredict', redirect1: 'mis1.mispredict', lwStall: 'hz.lwStall', divStall: 'dive.stall', pairOk: 'pair.ok', v0: 'FD.validD', v1: 'FD1.validD',
    corr0: 'corr.y', corr1: 'corr1.y',
  }, 'pipeline control');
  b.next();
  for (const l of L) {
    const FD = `FD${s(l)}`, A = l ? 'A1' : 'A0', B = l ? 'B1' : 'B0', c = `ctl${l}`;
    put(stageReg(`ID/EX${l ? ' 1' : ''}`, 'D', 'E', D_FIELDS(!l)), `DE${s(l)}`, {
      validD: l ? 'v1D.y' : `${FD}.validD`, pcD: `${FD}.pcD`, pcPlus4D: `${FD}.pcPlus4D`, rd1D: `by${A}.y`, rd2D: `by${B}.y`, immD: `imm${s(l)}.imm`, predTargetD: `${FD}.predTargetD`,
      rdD: `si${s(l)}.o1`, regWriteD: `${c}.regWrite`, aluSrcAD: `${c}.aluSrcA`, aluSrcBD: `${c}.aluSrcB`, resultSrcD: l ? `${c}.resultSrc` : 'rsm.y',
      branchD: `${c}.branch`, jumpD: `${c}.jump`, jalrD: `${c}.jalr`, aluCtlD: `${c}.aluCtl`, funct3D: `si${s(l)}.o2`,
      fwdAD: `hz.fwd${A}`, fwdBD: `hz.fwd${B}`, predTakenD: `${FD}.predTakenD`, callD: `${FD}.callD`, retD: `${FD}.retD`,
      ...(l ? {} : { memWriteD: 'ctl0.memWrite', mulD: 'cls0.mul', divD: 'cls0.div' }),
      en: 'ctl.run', clr: l ? 'ctl.clrDE1' : 'ctl.clrDE', clk: 'clk',
    });
  }
  put(AND, 'v1D', { a: 'FD1.validD', b: 'pair.ok' });
  b.next();

  // ---- E: two ALUs, two branch checks; lane 0's multiplier and divider ---------------------------------------------
  for (const l of L) {
    const DE = `DE${s(l)}`, x = s(l);
    put(M8, `fwdA${x}`, { d0: `${DE}.rd1E`, d1: 'res.y', d2: 'res1.y', d3: 'fwdM.y', d4: 'fwdM1.y', d5: `${DE}.rd1E`, d6: `${DE}.rd1E`, d7: `${DE}.rd1E`, s: `${DE}.fwdAE` }, `forward A${l}`);
    put(M8, `fwdB${x}`, { d0: `${DE}.rd2E`, d1: 'res.y', d2: 'res1.y', d3: 'fwdM.y', d4: 'fwdM1.y', d5: `${DE}.rd2E`, d6: `${DE}.rd2E`, d7: `${DE}.rd2E`, s: `${DE}.fwdBE` }, `forward B${l}`);
    put(M2, `srcA${x}`, { a: `fwdA${x}.y`, b: `${DE}.pcE`, s: `${DE}.aluSrcAE` });
    put(M2, `srcB${x}`, { a: `fwdB${x}.y`, b: `${DE}.immE`, s: `${DE}.aluSrcBE` });
    put(alu(32, 'ks'), `alu${x}`, { a: `srcA${x}.y`, b: `srcB${x}.y`, ctl: `${DE}.aluCtlE` }, `ALU ${l}`);
    put(BRANCH_CMP, `bcmp${x}`, { a: `fwdA${x}.y`, b: `fwdB${x}.y`, funct3: `${DE}.funct3E`, branch: `${DE}.branchE`, jump: `${DE}.jumpE`, jalr: `${DE}.jalrE` });
    put(ADD, `target${x}`, { a: `${DE}.pcE`, b: `${DE}.immE`, cin: tie0() }, 'PC + imm');
    put(ADD, `jtgt${x}`, { a: `fwdA${x}.y`, b: `${DE}.immE`, cin: tie0() }, 'rs1 + imm');
    put(CLEAR_BIT0, `clr${x}`, { in: `jtgt${x}.s`, zero: tie0() });
    put(M4, `corr${x}`, { d0: `${DE}.pcPlus4E`, d1: `target${x}.s`, d2: `clr${x}.out`, d3: `${DE}.pcPlus4E`, s: `bcmp${x}.pcSrc` }, 'correct PC');
    put(AND, `vE${x}`, { a: `${DE}.validE`, b: 'ctl.run' });
    put(MISPREDICT, `mis${x}`, {
      branch: `${DE}.branchE`, jump: `${DE}.jumpE`, jalr: `${DE}.jalrE`, pcSrc: `bcmp${x}.pcSrc`, predTaken: `${DE}.predTakenE`, predTarget: `${DE}.predTargetE`,
      tgtB: `target${x}.s`, tgtJ: `clr${x}.out`, valid: `vE${x}.y`,
    });
  }
  // lane 0: multiply (first half) and divide
  put(MUL_E, 'mule', { a: 'fwdA.y', b: 'fwdB.y', f: 'f3E.o0' }, 'multiply (E)');
  put(splitter([2, 1]), 'f3E', { in: 'DE.funct3E' });
  put(AND, 'goDiv', { a: 'DE.divE', b: 'DE.validE' });
  put(DIV_E, 'dive', { clk: 'clk', go: 'goDiv.y', a: 'fwdA.y', b: 'fwdB.y', f: 'f3E.o0' }, 'divide');
  put(M2, 'mdE', { a: 'alu.y', b: 'dive.y', s: 'DE.divE' }, 'ALU / divide');
  // one predictor update (the lane with the control instruction; returns are left to the return stack) and one
  // committed return-stack update (a pair holds at most one control instruction)
  put(UPDATE_2W, 'upd', {
    ctl0: 'mis.isCtrl', ctl1: 'mis1.isCtrl', taken0: 'mis.taken', taken1: 'mis1.taken', pc0: 'DE.pcE', pc1: 'DE1.pcE', target0: 'corr.y', target1: 'corr1.y',
    jump0: 'DE.jumpE', jalr0: 'DE.jalrE', jump1: 'DE1.jumpE', jalr1: 'DE1.jalrE', ret0: 'DE.retE', ret1: 'DE1.retE',
  }, 'predictor update');
  put(COMMIT_RAS, 'cmt', {
    v0: 'vE.y', v1: 'vE1.y', call0: 'DE.callE', ret0: 'DE.retE', call1: 'DE1.callE', ret1: 'DE1.retE', link0: 'DE.pcPlus4E', link1: 'DE1.pcPlus4E',
  }, 'return stack update');
  b.next();
  for (const l of L) {
    const DE = `DE${s(l)}`;
    put(stageReg(`EX/MEM${l ? ' 1' : ''}`, 'E', 'M', E_FIELDS(!l)), `EM${s(l)}`, {
      validE: `${DE}.validE`, pcE: `${DE}.pcE`, pcPlus4E: `${DE}.pcPlus4E`, aluResultE: l ? 'alu1.y' : 'mdE.y', immE: `${DE}.immE`, rdE: `${DE}.rdE`,
      regWriteE: `${DE}.regWriteE`, resultSrcE: `${DE}.resultSrcE`,
      ...(l ? {} : { writeDataE: 'fwdB.y', memWriteE: 'DE.memWriteE', mulE: 'DE.mulE', mfE: 'f3E.o0', msE: 'mule.s', mcE: 'mule.c' }),
      en: one, clr: l ? 'ctl.clrEM1' : 'dive.stall', clk: 'clk',
    });
  }
  b.next();

  // ---- M: lane 0's memory and the multiplier's second half -----------------------------------------------------------
  put(dataMemory(dmemK), 'dm', { addr: 'EM.aluResultM', wd: 'EM.writeDataM', we: 'EM.memWriteM', clk: 'clk' });
  put(MUL_M, 'mulm', { s: 'EM.msM', c: 'EM.mcM', f: 'EM.mfM' }, 'multiply (M)');
  put(M2, 'rdm', { a: 'dm.rd', b: 'mulm.y', s: 'EM.mulM' }, 'memory / product');
  for (const l of L) {
    const EM = `EM${s(l)}`;
    put(M4, `fwdM${s(l)}`, { d0: `${EM}.aluResultM`, d1: `${EM}.aluResultM`, d2: `${EM}.pcPlus4M`, d3: `${EM}.immM`, s: `${EM}.resultSrcM` }, `M result ${l}`);
  }
  b.next();
  for (const l of L) {
    const EM = `EM${s(l)}`;
    put(stageReg(`MEM/WB${l ? ' 1' : ''}`, 'M', 'W', M_FIELDS(!l)), `MW${s(l)}`, {
      validM: `${EM}.validM`, pcM: `${EM}.pcM`, pcPlus4M: `${EM}.pcPlus4M`, aluResultM: `${EM}.aluResultM`, immM: `${EM}.immM`, rdM: `${EM}.rdM`,
      regWriteM: `${EM}.regWriteM`, resultSrcM: `${EM}.resultSrcM`, ...(l ? {} : { readDataM: 'rdm.y' }),
      en: one, clr: tie0(), clk: 'clk',
    });
  }
  b.next();

  // ---- W: two results, two writes; the retire count ------------------------------------------------------------------
  for (const l of L) {
    const MW = `MW${s(l)}`;
    put(M4, `res${s(l)}`, { d0: `${MW}.aluResultW`, d1: l ? `${MW}.aluResultW` : 'MW.readDataW', d2: `${MW}.pcPlus4W`, d3: `${MW}.immW`, s: `${MW}.resultSrcW` }, `result ${l}`);
  }
  put(AND, 'both', { a: 'MW.validW', b: 'MW1.validW' });
  put(XOR, 'oneW', { a: 'MW.validW', b: 'MW1.validW' });
  b.next();
  b.wire(b.op1(merger([1, 1]), ['oneW.y', 'both.y'], undefined, 'count'), 'retire');
  b.wire('pc.q', 'pcF');
  b.wire('MW.pcW', 'pcW0');
  // names for the nets the readers and the drawing refer to
  const nm: Record<string, string> = {
    'pc.q': 'PCF', 'pcmux.y': 'PCNext', 'plus4.y': 'PCF+4', 'plus8.y': 'PCF+8', 'imem.data0': 'InstrF0', 'imem.data1': 'InstrF1',
    'ctl.redirect': 'redirect', 'ctl.correctPC': 'CorrectPC', 'ctl.enPC': 'enPC', 'ctl.enFD': 'enFD', 'ctl.shift': 'shift', 'ctl.clrFD1': 'clrFD1',
    'ctl.run': 'run', 'ctl.clrDE': 'clrDE', 'ctl.clrDE1': 'clrDE1', 'ctl.clrEM1': 'clrEM1', 'ctl.fetchGo': 'fetchGo', 'pair.ok': 'pairOk', 'hz.lwStall': 'lwStall',
    'dive.stall': 'divStall', 'res.y': 'ResultW0', 'res1.y': 'ResultW1', 'fwdM.y': 'FwdM0', 'fwdM1.y': 'FwdM1', 'mis.mispredict': 'mispredict0', 'mis1.mispredict': 'mispredict1',
    'corr.y': 'CorrectPC0', 'corr1.y': 'CorrectPC1', 'fctl.next': 'PredictedPC', 'fctl.valid1': 'slot1Valid',
  };
  for (const [d, n] of Object.entries(nm)) b.name(d, n, true);
  const R = b.right, H = b.height;
  return {
    id: `pipe2w_${IM.id.replace(/^rom2_/, '')}_d${dmemK}`, name: 'Dual-issue pipelined RV32IM CPU (balanced, branch prediction, return stack)', category: 'cpu',
    summary: 'Two five-stage lanes in step: fetch reads two instructions a cycle, decode issues them together when they are independent (else the first goes alone and the second waits a cycle), forwarding comes from both lanes, and up to two instructions retire a cycle.',
    ports: [bit('clk', 'in', 'left', true), bus('pcF', 32, 'out'), bus('retire', 2, 'out'), bus('pcW0', 32, 'out')],
    symbol: { kind: 'box', label: 'RV32IM ×2 PIPE' },
    netlist: () => ({ pins: { clk: [0, H + 6], pcF: [R, H + 6], retire: [R, H + 9], pcW0: [R, H + 12] }, instances: b.instances, nets: b.nets() }),
    hdl: { verilog: '// Two lanes of the balanced pipeline (hdl/rv_pipe.sv), with a pair check in D and a 4-read 2-write register file.' },
  };
}

// ---- control blocks ---------------------------------------------------------------------------------------------------

/**
 * Fetch's prediction for the pair: a return predicted from the stack (when it is not empty), else the BTB; slot 1
 * is fetched only when slot 0 is not predicted taken. The return stack's speculative update: slot 0's call or
 * return, else slot 1's (if fetched), when the pair goes into IF/ID.
 */
export const FETCH_PRED: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('call0', 'ret0', 'call1', 'ret1', 'pt0', 'pt1', 'tgt0', 'tgt1', 'top', 'any', 'pc4', 'pc8', 'advance');
  const rp0 = b.op1(AND, ['ret0', 'any'], undefined, 'rp0'), rp1 = b.op1(AND, ['ret1', 'any'], undefined, 'rp1');
  b.next();
  const take0 = b.name(b.op1(OR, [rp0, 'pt0'], undefined, 'take0'), 'take0', true);
  const take1 = b.op1(OR, [rp1, 'pt1'], undefined, 'take1');
  const t0 = b.name(b.op1(busMux2(32), ['tgt0', 'top', rp0], undefined, 'target0'), 'target0', true);
  const t1 = b.name(b.op1(busMux2(32), ['tgt1', 'top', rp1], undefined, 'target1'), 'target1', true);
  const op0 = b.name(b.op1(OR, ['call0', 'ret0'], undefined, 'op0'), 'slot0 call/ret', true);
  b.next();
  const v1 = b.name(b.op1(NOT, [take0], undefined, 'v1'), 'slot1', true);
  const no0 = b.op1(NOT, [op0], undefined, 'no0');
  b.next();
  const t1v = b.name(b.op1(AND, [take1, v1], undefined, 'take1v'), 'take1v', true);
  const seq = b.op1(busMux2(32), ['pc8', t1, t1v], undefined, 'seq');
  const use1 = b.name(b.op1(andN(3), [no0, v1, 'advance'], undefined, 'use1'), 'use1', true);
  const use0 = b.name(b.op1(AND, [op0, 'advance'], undefined, 'use0'), 'use0', true);
  b.next();
  const next = b.op1(busMux2(32), [seq, t0, take0], undefined, 'pred');
  const pu0 = b.op1(AND, ['call0', use0], undefined, 'push0'), pu1 = b.op1(AND, ['call1', use1], undefined, 'push1');
  const po0 = b.op1(AND, ['ret0', use0], undefined, 'pop0'), po1 = b.op1(AND, ['ret1', use1], undefined, 'pop1');
  const val = b.op1(busMux2(32), ['pc8', 'pc4', 'call0'], undefined, 'link');
  b.next();
  b.wire(next, 'next'); b.wire(take0, 'take0'); b.wire(t0, 'target0'); b.wire(t1v, 'take1'); b.wire(t1, 'target1'); b.wire(v1, 'valid1');
  b.wire(b.op1(OR, [pu0, pu1], undefined, 'push'), 'pushF'); b.wire(b.op1(OR, [po0, po1], undefined, 'pop'), 'popF'); b.wire(val, 'valF');
  const R = b.right;
  const ins = ['call0', 'ret0', 'call1', 'ret1', 'pt0', 'pt1', 'tgt0', 'tgt1', 'top', 'any', 'pc4', 'pc8', 'advance'];
  const outs = ['next', 'take0', 'target0', 'take1', 'target1', 'valid1', 'pushF', 'popF', 'valF'];
  return define({
    id: 'fetchpred2', name: 'Fetch prediction (pair)', category: 'cpu',
    summary: 'Where fetch goes next, for a pair: slot 0 taken (a return from the stack, else the BTB) goes to its target and drops slot 1; else slot 1 taken goes to slot 1\'s target; else pc + 8. Also the return stack\'s speculative push or pop.',
    ports: [bit('call0', 'in'), bit('ret0', 'in'), bit('call1', 'in'), bit('ret1', 'in'), bit('pt0', 'in'), bit('pt1', 'in'), bus('tgt0', 32, 'in'), bus('tgt1', 32, 'in'),
      bus('top', 32, 'in'), bit('any', 'in'), bus('pc4', 32, 'in'), bus('pc8', 32, 'in'), bit('advance', 'in'),
      bus('next', 32, 'out'), bit('take0', 'out'), bus('target0', 32, 'out'), bit('take1', 'out'), bus('target1', 32, 'out'), bit('valid1', 'out'), bit('pushF', 'out'), bit('popF', 'out'), bus('valF', 32, 'out')],
    symbol: { kind: 'box', label: 'PREDICT ×2' },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map((n, i) => [n, [R, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The pipeline's control: redirect on a misprediction (lane 0 first), stall on a load-use or a divide, and hold
 * and shift when the pair splits. Every register's enable and clear comes from here.
 */
export const CONTROL_2W: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('redirect0', 'redirect1', 'lwStall', 'divStall', 'pairOk', 'v0', 'v1', 'corr0', 'corr1');
  const redirect = b.name(b.op1(OR, ['redirect0', 'redirect1'], undefined, 'redir'), 'redirect', true);
  const corr = b.op1(busMux2(32), ['corr1', 'corr0', 'redirect0'], undefined, 'corr');
  const run = b.name(b.op1(NOT, ['divStall'], undefined, 'run'), 'run', true);
  const nOk = b.op1(NOT, ['pairOk'], undefined, 'nOk');
  const nLw = b.op1(NOT, ['lwStall'], undefined, 'nLw');
  b.next();
  const nRedir = b.op1(NOT, [redirect], undefined, 'nRedir');
  const split = b.name(b.op1(andN(3), ['v0', 'v1', nOk], undefined, 'split'), 'split', true);
  b.next();
  const stall = b.name(b.op1(AND, ['lwStall', nRedir], undefined, 'stall'), 'stallD', true);
  b.next();
  const nStall = b.op1(NOT, [stall], undefined, 'nStall');
  b.next();
  const goD = b.name(b.op1(AND, [run, nStall], undefined, 'goD'), 'goD', true);
  const nSplit = b.op1(NOT, [split], undefined, 'nSplit');
  b.next();
  const shift = b.name(b.op1(AND, [split, goD], undefined, 'shiftGo'), 'shift', true);
  const fetch = b.op1(AND, [goD, nSplit], undefined, 'fetchGo');
  b.next();
  const enPC = b.op1(OR, [fetch, redirect], undefined, 'enPC');
  // the return stack's speculative update: a flush restores it anyway (restore wins), so no wait for the redirect
  const fetchGo = b.op1(andN(3), [run, nLw, nSplit], undefined, 'fetchAdv');
  const clrFD1 = b.op1(OR, [redirect, shift], undefined, 'clrFD1');
  const clrDE = b.op1(OR, [redirect, stall], undefined, 'clrDE');
  const clrDE1 = b.op1(orN(3), [redirect, stall, nOk], undefined, 'clrDE1');
  const clrEM1 = b.op1(OR, ['divStall', 'redirect0'], undefined, 'clrEM1');
  b.next();
  const outs: [string, string][] = [['redirect', redirect], ['correctPC', corr], ['run', run], ['enPC', enPC], ['enFD', goD], ['shift', shift], ['clrFD1', clrFD1], ['fetchGo', fetchGo], ['clrDE', clrDE], ['clrDE1', clrDE1], ['clrEM1', clrEM1]];
  for (const [p, d] of outs) b.wire(d, p);
  const R = b.right;
  const ins = ['redirect0', 'redirect1', 'lwStall', 'divStall', 'pairOk', 'v0', 'v1', 'corr0', 'corr1'];
  return define({
    id: 'ctl2w', name: 'Pipeline control (dual issue)', category: 'cpu',
    summary: 'Turns the hazards into enables and clears. A misprediction redirects fetch (lane 0 first: it is older) and flushes IF/ID and ID/EX; lane 0\'s also kills lane 1\'s instruction in E. A load-use holds the PC and IF/ID and sends bubbles into E. A divide holds F, D and E and sends bubbles into M. A pair that cannot issue together sends slot 0 alone and shifts slot 1 into its place while the PC holds.',
    ports: [bit('redirect0', 'in'), bit('redirect1', 'in'), bit('lwStall', 'in'), bit('divStall', 'in'), bit('pairOk', 'in'), bit('v0', 'in'), bit('v1', 'in'), bus('corr0', 32, 'in'), bus('corr1', 32, 'in'),
      bit('redirect', 'out'), bus('correctPC', 32, 'out'), bit('run', 'out'), bit('enPC', 'out'), bit('enFD', 'out'), bit('shift', 'out'), bit('clrFD1', 'out'), bit('fetchGo', 'out'),
      bit('clrDE', 'out'), bit('clrDE1', 'out'), bit('clrEM1', 'out')],
    symbol: { kind: 'box', label: 'CONTROL ×2' },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map(([n], i) => [n, [R, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
  });
})();

/**
 * The BTB's one update: the lane holding the control instruction (at most one per pair), never for a return.
 * Lane 1's update needs no word from lane 0's misprediction: lane 1 holds a control instruction only when lane 0
 * does not, and lane 0 then mispredicts only if it was predicted taken, which would have kept slot 1 from being
 * fetched. So the update starts at once, beside the misprediction check (it was the critical path behind it).
 */
export const UPDATE_2W: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('ctl0', 'ctl1', 'taken0', 'taken1', 'pc0', 'pc1', 'target0', 'target1', 'jump0', 'jalr0', 'jump1', 'jalr1', 'ret0', 'ret1');
  const nr0 = b.op1(NOT, ['ret0'], undefined, 'nRet0'), nr1 = b.op1(NOT, ['ret1'], undefined, 'nRet1');
  const j0 = b.op1(OR, ['jump0', 'jalr0'], undefined, 'j0'), j1 = b.op1(OR, ['jump1', 'jalr1'], undefined, 'j1');
  b.next();
  const u0 = b.op1(AND, ['ctl0', nr0], undefined, 'u0');
  const u1 = b.op1(AND, ['ctl1', nr1], undefined, 'u1');
  b.next();
  b.wire(b.op1(OR, [u0, u1], undefined, 'upd'), 'upd');
  b.wire(b.op1(busMux2(32), ['pc0', 'pc1', 'ctl1'], undefined, 'pc'), 'pcE');
  b.wire(b.op1(busMux2(32), ['target0', 'target1', 'ctl1'], undefined, 'tgt'), 'target');
  b.wire(b.op1(busMux2(1), ['taken0', 'taken1', 'ctl1'], undefined, 'tk'), 'taken');
  b.wire(b.op1(busMux2(1), [j0, j1, 'ctl1'], undefined, 'jmp'), 'isJump');
  const R = b.right;
  const ins = ['ctl0', 'ctl1', 'taken0', 'taken1', 'pc0', 'pc1', 'target0', 'target1', 'jump0', 'jalr0', 'jump1', 'jalr1', 'ret0', 'ret1'];
  const outs = ['upd', 'pcE', 'target', 'taken', 'isJump'];
  return define({
    id: 'upd2w', name: 'Predictor update (dual issue)', category: 'cpu',
    summary: 'One BTB write a cycle: from the lane with the control instruction (a pair holds at most one). Returns are not written: the return stack predicts them.',
    ports: [bit('ctl0', 'in'), bit('ctl1', 'in'), bit('taken0', 'in'), bit('taken1', 'in'), bus('pc0', 32, 'in'), bus('pc1', 32, 'in'), bus('target0', 32, 'in'), bus('target1', 32, 'in'),
      bit('jump0', 'in'), bit('jalr0', 'in'), bit('jump1', 'in'), bit('jalr1', 'in'), bit('ret0', 'in'), bit('ret1', 'in'),
      bit('upd', 'out'), bus('pcE', 32, 'out'), bus('target', 32, 'out'), bit('taken', 'out'), bit('isJump', 'out')],
    symbol: { kind: 'box', label: 'BTB UPDATE' },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), ...Object.fromEntries(outs.map((n, i) => [n, [R, 2 + 2 * i] as [number, number]])) }, instances: b.instances, nets: b.nets() }),
  });
})();

/** The committed return stack follows the calls and returns that reach E (valid; lane 1's need no check of lane 0: see UPDATE_2W). */
export const COMMIT_RAS: ComponentDef = (() => {
  const b = new Builder(16, 18);
  b.pins('v0', 'v1', 'call0', 'ret0', 'call1', 'ret1', 'link0', 'link1');
  const c0 = b.op1(AND, ['call0', 'v0'], undefined, 'c0'), c1 = b.name(b.op1(AND, ['call1', 'v1'], undefined, 'c1'), 'call1v', true);
  const r0 = b.op1(AND, ['ret0', 'v0'], undefined, 'r0'), r1 = b.op1(AND, ['ret1', 'v1'], undefined, 'r1');
  b.next();
  b.wire(b.op1(OR, [c0, c1], undefined, 'push'), 'pushC');
  b.wire(b.op1(OR, [r0, r1], undefined, 'pop'), 'popC');
  b.wire(b.op1(busMux2(32), ['link0', 'link1', c1], undefined, 'link'), 'valC');
  const R = b.right;
  const ins = ['v0', 'v1', 'call0', 'ret0', 'call1', 'ret1', 'link0', 'link1'];
  return define({
    id: 'cmtras2w', name: 'Return stack update (committed copy)', category: 'cpu',
    summary: 'The calls and returns that really ran update the committed copy of the return stack: those in E, valid (a pair holds at most one).',
    ports: [bit('v0', 'in'), bit('v1', 'in'), bit('call0', 'in'), bit('ret0', 'in'), bit('call1', 'in'), bit('ret1', 'in'), bus('link0', 32, 'in'), bus('link1', 32, 'in'),
      bit('pushC', 'out'), bit('popC', 'out'), bus('valC', 32, 'out')],
    symbol: { kind: 'box', label: 'STACK UPDATE' },
    netlist: () => ({ pins: { ...Object.fromEntries(ins.map((n, i) => [n, [0, 2 + 2 * i] as [number, number]])), pushC: [R, 2], popC: [R, 4], valC: [R, 6] }, instances: b.instances, nets: b.nets() }),
  });
})();
