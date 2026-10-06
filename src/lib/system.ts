// Level 9: the complete machine — all of RV32I, Zicsr, machine-mode traps and interrupts, and
// memory-mapped I/O — built on the single-cycle datapath.
//   I/O map (address bit 31 = 1): 0x8000_0000 console · 0x04 LEDs · 0x08 switches · 0x10 mtime · 0x14 mtimecmp

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord } from './alu';
import { busMux2, decoder, incrementer, muxTree } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, PLUS4, PLUS4_FAST, rom } from './cpu';
import { define, merger, splitter } from './define';
import { addSubFast, fanout, koggeStone } from './fastadd';
import { AND, NOT, OR } from './gates';
import { LOAD_EXTRACT, STORE_ALIGN, bankedMemory } from './lsu';
import { equal, nonZero } from './pipeline';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { andN, rca } from './combinational';
import { bitwise, orN } from './wide';
import { CSRS } from '../riscv/isa';
import { MDU } from './muldiv';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/**
 * Place instances in columns (top to bottom), returning positioned InstanceDefs. A symbol with a
 * bottom port (mux select, clock) gets 4 units below it, so the net label hanging from that port
 * clears the next symbol and the name drawn above it.
 */
function columns(cols: [string, ComponentDef, string?][][], x0: number, y0: number, gapX = 10, gapY = 3): InstanceDef[] {
  const out: InstanceDef[] = [];
  let x = x0;
  for (const col of cols) {
    let y = y0, w = 0;
    for (const [name, def, label] of col) {
      const g = symbolGeom(def);
      out.push({ name, def, at: [x, y], label });
      y += g.h + (Object.values(g.ports).some((p) => p.exit === 'down') ? Math.max(gapY, 4) : gapY);
      w = Math.max(w, g.w);
    }
    x += w + gapX;
  }
  return out;
}

/** Compare a bus with a constant: a comparator and a constant word. */
function isConst(name: string, w: number, v: number, input: string, nets: NetDef[], insts: [string, ComponentDef, string?][]): string {
  insts.push([`k_${name}`, constWord(w, v)], [`is_${name}`, equal(w)]);
  nets.push({ ends: [`k_${name}.y`, `is_${name}.b`] });
  nets.push({ ends: [input, `is_${name}.a`], tags: true });
  return `is_${name}.eq`;
}

// ---- illegal-instruction and system decoding --------------------------------------------------------

export function sysDecode(m = false): ComponentDef {
  return memo(`sysdec${m ? '_m' : ''}`, () => {
  const ins: [string, ComponentDef, string?][] = [];
  const nets: NetDef[] = [];
  const C = (name: string, w: number, v: number, input: string) => isConst(name, w, v, input, nets, ins);
  // opcode classes (op[6:2]) and op[1:0] == 11
  const cls: Record<string, number> = { R: 0b01100, I: 0b00100, LOAD: 0b00000, STORE: 0b01000, BRANCH: 0b11000, JAL: 0b11011, JALR: 0b11001, LUI: 0b01101, AUIPC: 0b00101, SYS: 0b11100, FENCE: 0b00011 };
  const opc: Record<string, string> = {};
  for (const [n, v] of Object.entries(cls)) opc[n] = C(`op_${n}`, 7, (v << 2) | 3, 'op');
  const f3: string[] = [];
  ins.push(['f3dec', decoder(3)]);
  nets.push({ ends: ['funct3', 'f3dec.a'], tags: ['f3dec.a'] });
  for (let i = 0; i < 8; i++) f3.push(`f3dec.y${i}`);
  const f7zero = C('f7z', 7, 0, 'funct7');
  const f7alt = C('f7a', 7, 0x20, 'funct7');
  const imm0 = C('ecall', 12, 0, 'imm12'), imm1 = C('ebreak', 12, 1, 'imm12'), immMret = C('mret', 12, 0x302, 'imm12'), immWfi = C('wfi', 12, 0x105, 'imm12');
  // gates
  const g = (name: string, def: ComponentDef, ...inputs: string[]) => {
    ins.push([name, def]);
    const pins = def.ports.filter((p) => p.dir === 'in').map((p) => p.name);
    inputs.forEach((src, i) => nets.push({ ends: [src, `${name}.${pins[i]}`], tags: true }));
    return `${name}.${def.ports.find((p) => p.dir === 'out')!.name}`;
  };
  const or = (name: string, ...xs: string[]) => g(name, xs.length === 2 ? OR : orN(xs.length), ...xs);
  const and = (name: string, ...xs: string[]) => g(name, xs.length === 2 ? AND : andN(xs.length), ...xs);
  // R: funct7 0, or 0x20 with funct3 0/5
  const f3_0or5 = or('f3_05', f3[0], f3[5]);
  const f7one = m ? C('f7m', 7, 1, 'funct7') : '';
  const okR = and('okR', opc.R, or('r7', f7zero, and('r7a', f7alt, f3_0or5), ...(m ? [f7one] : [])));
  // I: shifts need funct7 0 (slli, srli) or 0x20 (srai)
  const notShift = g('nsh', NOT, or('sh', f3[1], f3[5]));
  const okI = and('okI', opc.I, or('i7', notShift, and('isl', f3[1], f7zero), and('isr', f3[5], or('i7s', f7zero, f7alt))));
  const okLoad = and('okL', opc.LOAD, or('lf3', f3[0], f3[1], f3[2], f3[4], f3[5]));
  const okStore = and('okS', opc.STORE, or('sf3', f3[0], f3[1], f3[2]));
  const okBranch = and('okB', opc.BRANCH, g('nb', NOT, or('bf3', f3[2], f3[3])));
  const okJalr = and('okJR', opc.JALR, f3[0]);
  const okFence = and('okF', opc.FENCE, f3[0]);
  const sysPriv = and('priv', opc.SYS, f3[0]);
  const ecall = and('isEcall', sysPriv, imm0), ebreak = and('isEbreak', sysPriv, imm1), mret = and('isMret', sysPriv, immMret), wfi = and('isWfi', sysPriv, immWfi);
  const csrOp = and('isCsr', opc.SYS, g('ncsr', NOT, or('notcsr', f3[0], f3[4])));
  const okSys = or('okSys', ecall, ebreak, mret, wfi, and('okCsr', csrOp, 'csrKnown'));
  const legal = or('legal', okR, okI, okLoad, okStore, okBranch, opc.JAL, okJalr, opc.LUI, opc.AUIPC, okFence, okSys);
  const illegal = g('ill', NOT, legal);
  // csr writes unless csrrs/c (and immediate forms) with a zero source field
  const rs1nz = g('rsnz', nonZero(5), 'rs1');
  const isRw = or('isRw', f3[1], f3[5]);
  const csrWrites = and('csrW', csrOp, or('wr', isRw, rs1nz));
  nets.push(
    { name: 'illegal', ends: [illegal, 'illegal'], tags: true },
    { name: 'ecall', ends: [ecall, 'ecall'], tags: true },
    { name: 'ebreak', ends: [ebreak, 'ebreak'], tags: true },
    { name: 'mret', ends: [mret, 'mret'], tags: true },
    { name: 'csrOp', ends: [csrOp, 'csrOp'], tags: true },
    { name: 'csrWrite', ends: [csrWrites, 'csrWrite'], tags: true },
  );
  if (m) nets.push({ name: 'isM', ends: [and('isMul', opc.R, f7one), 'isM'], tags: true });
  // merge nets that share a driver (inputs used several times)
  const merged = mergeByDriver(nets);
  const pins: Record<string, [number, number]> = { op: [0, 2], funct3: [0, 6], funct7: [0, 10], imm12: [0, 14], rs1: [0, 18], csrKnown: [0, 22] };
  const instances = columns(chunk(ins, 14), 12, 0, 12, 2);
  // room for the last column's output labels and the output pins' labels side by side
  const right = Math.max(...instances.map((i) => i.at![0] + symbolGeom(i.def).w)) + 14;
  ['illegal', 'ecall', 'ebreak', 'mret', 'csrOp', 'csrWrite', ...(m ? ['isM'] : [])].forEach((n, i) => (pins[n] = [right, 2 + 4 * i]));
  return define({
    id: `sysdec${m ? '_m' : ''}`, name: 'System & illegal-instruction decoder', category: 'cpu',
    summary: `Recognises ecall, ebreak, mret, wfi and the CSR instructions, and flags anything that is not a valid RV32I${m ? 'M' : ''} / Zicsr encoding as an illegal instruction (which traps).${m ? ' Also spots the M-extension instructions (OP with funct7 = 1).' : ''}`,
    ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), bus('imm12', 12, 'in'), bus('rs1', 5, 'in'), bit('csrKnown', 'in'),
      bit('illegal', 'out'), bit('ecall', 'out'), bit('ebreak', 'out'), bit('mret', 'out'), bit('csrOp', 'out'), bit('csrWrite', 'out'), ...(m ? [bit('isM', 'out')] : [])],
    symbol: { kind: 'box', label: 'SYSTEM DECODE' },
    netlist: () => ({ pins, instances, nets: merged }),
  });
  });
}
export const SYS_DECODE = sysDecode();

function chunk<T>(xs: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

/** Nets with the same driver become one net (sinks concatenated). */
function mergeByDriver(nets: NetDef[]): NetDef[] {
  const by = new Map<string, NetDef>();
  const out: NetDef[] = [];
  for (const n of nets) {
    const prev = by.get(n.ends[0]);
    if (prev) {
      prev.ends.push(...n.ends.slice(1));
      if (n.name && !prev.name) prev.name = n.name;
      if (prev.tags !== true) prev.tags = n.tags === true ? true : [...(prev.tags ?? []), ...(n.tags ?? [])];
      continue;
    }
    const c = { ...n, ends: [...n.ends] };
    by.set(n.ends[0], c);
    out.push(c);
  }
  return out;
}

// ---- CSR unit ------------------------------------------------------------------------------------------------

const CSR_ORDER: [string, number][] = [
  ['mstatus', CSRS.mstatus], ['misa', CSRS.misa], ['mie', CSRS.mie], ['mtvec', CSRS.mtvec], ['mscratch', CSRS.mscratch], ['mepc', CSRS.mepc],
  ['mcause', CSRS.mcause], ['mtval', CSRS.mtval], ['mip', CSRS.mip], ['mcycle', CSRS.mcycle], ['cycle', CSRS.cycle], ['mhartid', CSRS.mhartid],
];

export function csrUnit(m = false): ComponentDef {
  return memo(`csrunit${m ? '_m' : ''}`, () => {
  const ins: [string, ComponentDef, string?][] = [];
  const nets: NetDef[] = [];
  const net = (name: string | undefined, drv: string, ...sinks: string[]) => nets.push({ name, ends: [drv, ...sinks], tags: true });
  // address decode
  const sel: Record<string, string> = {};
  for (const [n, a] of CSR_ORDER) sel[n] = isConst(n, 12, a, 'addr', nets, ins);
  ins.push(['known', orN(CSR_ORDER.length)]);
  CSR_ORDER.forEach(([n], i) => net(undefined, sel[n], `known.i${i}`));
  // one-hot → index for the read multiplexer
  ins.push(['enc0', orN(6)], ['enc1', orN(6)], ['enc2', orN(5)], ['enc3', orN(4)], ['idx', merger([1, 1, 1, 1])]);
  const encIns: string[][] = [[], [], [], []];
  CSR_ORDER.forEach(([n], i) => { for (let b = 0; b < 4; b++) if (i & (1 << b)) encIns[b].push(sel[n]); });
  encIns.forEach((list, b) => list.forEach((s, j) => net(undefined, s, `enc${b}.i${j}`)));
  for (let b = 0; b < 4; b++) net(`idx${b}`, `enc${b}.y`, `idx.i${b}`);
  // registers
  const R1 = register(1), R2 = register(2), R30 = register(30), R32 = register(32);
  ins.push(['rMIE', R1, 'MIE'], ['rMPIE', R1, 'MPIE'], ['rMIEN', R2, 'mie'], ['rTvec', R30, 'mtvec'], ['rScratch', R32, 'mscratch'],
    ['rEpc', R30, 'mepc'], ['rCause', R32, 'mcause'], ['rTval', R32, 'mtval']);
  // read values
  const gnd = 'gnd.y', vdd = 'vdd.y';
  ins.push(['gnd', TIE0], ['vdd', TIE1]);
  // mstatus: bit 3 MIE, bit 7 MPIE, bits 12:11 MPP = 11
  ins.push(['vStatus', merger([3, 1, 3, 1, 3, 2, 19])], ['z3', constWord(3, 0)], ['z19', constWord(19, 0)], ['mpp', constWord(2, 3)]);
  net(undefined, 'z3.y', 'vStatus.i0', 'vStatus.i2', 'vStatus.i4');
  net('MIE', 'rMIE.q', 'vStatus.i1');
  net('MPIE', 'rMPIE.q', 'vStatus.i3');
  net(undefined, 'mpp.y', 'vStatus.i5');
  net(undefined, 'z19.y', 'vStatus.i6');
  // mie / mip: bit 7 (timer), bit 11 (external)
  ins.push(['sMie', splitter([1, 1])], ['vMie', merger([7, 1, 3, 1, 20])], ['vMip', merger([7, 1, 3, 1, 20])], ['z7', constWord(7, 0)], ['z20', constWord(20, 0)]);
  net('mieBits', 'rMIEN.q', 'sMie.in');
  net('MTIE', 'sMie.o0', 'vMie.i1');
  net('MEIE', 'sMie.o1', 'vMie.i3');
  net(undefined, 'z7.y', 'vMie.i0', 'vMip.i0');
  net(undefined, 'z3.y', 'vMie.i2', 'vMip.i2');
  net(undefined, 'z20.y', 'vMie.i4', 'vMip.i4');
  net('mtip', 'mtip', 'vMip.i1');
  net('meip', 'meip', 'vMip.i3');
  ins.push(['vTvec', merger([2, 30])], ['vEpc', merger([2, 30])], ['z2', constWord(2, 0)]);
  net(undefined, 'z2.y', 'vTvec.i0', 'vEpc.i0');
  net('mtvecHi', 'rTvec.q', 'vTvec.i1');
  net('mepcHi', 'rEpc.q', 'vEpc.i1');
  ins.push(['misa', constWord(32, m ? 0x40001100 : 0x40000100)], ['zero32', constWord(32, 0)]);
  const RM = muxTree(4, 32);
  ins.push(['rsel', RM]);
  const vals = ['vStatus.out', 'misa.y', 'vMie.out', 'vTvec.out', 'rScratch.q', 'vEpc.out', 'rCause.q', 'rTval.q', 'vMip.out', 'mtime', 'mtime', 'zero32.y'];
  const valNames = ['mstatus', 'misa', 'mie', 'mtvec', 'mscratch', 'mepc', 'mcause', 'mtval', 'mip', 'mtime', 'mtime', 'zero'];
  vals.forEach((v, i) => net(valNames[i], v, `rsel.d${i}`));
  for (let i = vals.length; i < 16; i++) net(undefined, 'zero32.y', `rsel.d${i}`);
  net('index', 'idx.out', 'rsel.s');
  net('old', 'rsel.y', 'rdata', 'orOld.a', 'andOld.a');
  // new value: rw src / rs old|src / rc old&~src
  ins.push(['zimm', merger([5, 27])], ['z27', constWord(27, 0)], ['srcSel', busMux2(32)], ['orOld', bitwise('or', 32)], ['nsrc', bitwise('xor', 32)], ['ones', constWord(32, 0xffffffff)], ['andOld', bitwise('and', 32)], ['opSel', muxTree(2, 32)], ['sf3', splitter([2, 1])]);
  net('zimm5', 'zimm5', 'zimm.i0');
  net(undefined, 'z27.y', 'zimm.i1');
  net('zimm', 'zimm.out', 'srcSel.b');
  net('rs1v', 'rs1v', 'srcSel.a');
  net('funct3', 'funct3', 'sf3.in');
  net('immForm', 'sf3.o1', 'srcSel.s');
  net('op', 'sf3.o0', 'opSel.s');
  net('src', 'srcSel.y', 'orOld.b', 'nsrc.a', 'opSel.d1', 'opSel.d0');
  net(undefined, 'ones.y', 'nsrc.b');
  net('¬src', 'nsrc.y', 'andOld.b');
  net('setBits', 'orOld.y', 'opSel.d2');
  net('clearBits', 'andOld.y', 'opSel.d3');
  ins.push(['nv', splitter([3, 1, 3, 1, 3, 1, 20])]);
  net('new', 'opSel.y', 'nv.in', 'rScratch.d', 'dCause.a', 'dTval.a');
  // write enables
  const w = (n: string) => { ins.push([`w_${n}`, AND]); net(undefined, 'csrWrite', `w_${n}.a`); net(undefined, sel[n], `w_${n}.b`); return `w_${n}.y`; };
  const wStatus = w('mstatus'), wMie = w('mie'), wTvec = w('mtvec'), wScratch = w('mscratch'), wEpc = w('mepc'), wCause = w('mcause'), wTval = w('mtval');
  // MIE: trap → 0, mret → MPIE, write → new[3]
  ins.push(['mMIE', muxTree(2, 1)], ['mMPIE', muxTree(2, 1)], ['tm', merger([1, 1])], ['enS', orN(3)]);
  net('trap', 'trap', 'tm.i1', 'enS.i0', 'enE.a', 'enC.a', 'enT.a');
  net('mretQ', 'mret', 'tm.i0', 'enS.i1');
  net(undefined, wStatus, 'enS.i2');
  net('statusSel', 'tm.out', 'mMIE.s', 'mMPIE.s');
  net('new[3]', 'nv.o1', 'mMIE.d0');
  net(undefined, 'rMPIE.q', 'mMIE.d1');
  net(undefined, gnd, 'mMIE.d2', 'mMIE.d3');
  net('new[7]', 'nv.o3', 'mMPIE.d0');
  net(undefined, vdd, 'mMPIE.d1');
  net(undefined, 'rMIE.q', 'mMPIE.d2', 'mMPIE.d3');
  net('enStatus', 'enS.y', 'rMIE.en', 'rMPIE.en');
  net('nextMIE', 'mMIE.y', 'rMIE.d');
  net('nextMPIE', 'mMPIE.y', 'rMPIE.d');
  // mie bits
  ins.push(['mieNew', merger([1, 1])]);
  net('new[11]', 'nv.o5', 'mieNew.i1');
  nets.push({ ends: ['nv.o3', 'mieNew.i0'], tags: true });
  net(undefined, 'mieNew.out', 'rMIEN.d');
  net(undefined, wMie, 'rMIEN.en');
  // mtvec, mscratch
  ins.push(['tvHi', splitter([2, 30])]);
  nets.push({ ends: ['opSel.y', 'tvHi.in'], tags: true });
  net('new[31:2]', 'tvHi.o1', 'rTvec.d', 'dEpc.a');
  net(undefined, wTvec, 'rTvec.en');
  net(undefined, wScratch, 'rScratch.en');
  // mepc / mcause / mtval: trap overrides a CSR write
  ins.push(['dEpc', busMux2(30)], ['tpc', splitter([2, 30])], ['dCause', busMux2(32)], ['dTval', busMux2(32)], ['enE', OR], ['enC', OR], ['enT', OR]);
  net('trapPC', 'trapPC', 'tpc.in');
  net(undefined, 'tpc.o1', 'dEpc.b');
  net('trapSel', 'trap', 'dEpc.s', 'dCause.s', 'dTval.s');
  net(undefined, 'dEpc.y', 'rEpc.d');
  net(undefined, wEpc, 'enE.b');
  net(undefined, 'enE.y', 'rEpc.en');
  net('trapCause', 'trapCause', 'dCause.b');
  net(undefined, 'dCause.y', 'rCause.d');
  net(undefined, wCause, 'enC.b');
  net(undefined, 'enC.y', 'rCause.en');
  net('trapVal', 'trapVal', 'dTval.b');
  net(undefined, 'dTval.y', 'rTval.d');
  net(undefined, wTval, 'enT.b');
  net(undefined, 'enT.y', 'rTval.en');
  // clock
  net('clk', 'clk', 'rMIE.clk', 'rMPIE.clk', 'rMIEN.clk', 'rTvec.clk', 'rScratch.clk', 'rEpc.clk', 'rCause.clk', 'rTval.clk');
  // outputs and interrupt gating: take = MIE & (MEIE&meip | MTIE&mtip); cause external over timer
  ins.push(['ei', AND], ['ti', AND], ['any', OR], ['take', AND], ['icause', busMux2(32)], ['kT', constWord(32, 0x80000007)], ['kE', constWord(32, 0x8000000b)]);
  net(undefined, 'sMie.o1', 'ei.a');
  net(undefined, 'meip', 'ei.b');
  net(undefined, 'sMie.o0', 'ti.a');
  net(undefined, 'mtip', 'ti.b');
  net('extIrq', 'ei.y', 'any.a', 'icause.s');
  net('timerIrq', 'ti.y', 'any.b');
  net(undefined, 'any.y', 'take.a');
  net(undefined, 'rMIE.q', 'take.b');
  net('irqTake', 'take.y', 'irqTake');
  net(undefined, 'kT.y', 'icause.a');
  net(undefined, 'kE.y', 'icause.b');
  net('irqCause', 'icause.y', 'irqCause');
  net('known', 'known.y', 'known');
  net('mtvec', 'vTvec.out', 'mtvecOut');
  net('mepc', 'vEpc.out', 'mepcOut');
  const merged = mergeByDriver(nets);
  // 14 between columns: an output label pointing right and an input label pointing left share the gap
  const instances = columns(chunk(ins, 12), 14, 0, 14, 2);
  const right = Math.max(...instances.map((i) => i.at![0] + symbolGeom(i.def).w)) + 11;
  const inNames = ['addr', 'funct3', 'rs1v', 'zimm5', 'csrWrite', 'trap', 'trapCause', 'trapPC', 'trapVal', 'mret', 'mtime', 'mtip', 'meip', 'clk'];
  const outNames = ['rdata', 'known', 'mtvecOut', 'mepcOut', 'irqTake', 'irqCause'];
  const pins: Record<string, [number, number]> = {};
  inNames.forEach((n, i) => (pins[n] = [0, 2 + 3 * i]));
  outNames.forEach((n, i) => (pins[n] = [right, 2 + 4 * i]));
  return define({
    id: `csrunit${m ? '_m' : ''}`, name: 'CSR unit', category: 'cpu',
    summary: 'The machine-mode control and status registers: address decode, a read multiplexer, read-modify-write for csrrw/csrrs/csrrc, and the hardware updates on a trap (mepc, mcause, mtval, MIE→MPIE) or an mret. Also decides whether an interrupt is taken.',
    ports: [
      bus('addr', 12, 'in'), bus('funct3', 3, 'in'), bus('rs1v', 32, 'in'), bus('zimm5', 5, 'in'), bit('csrWrite', 'in'),
      bit('trap', 'in'), bus('trapCause', 32, 'in'), bus('trapPC', 32, 'in'), bus('trapVal', 32, 'in'), bit('mret', 'in'),
      bus('mtime', 32, 'in'), bit('mtip', 'in'), bit('meip', 'in'), bit('clk', 'in', 'bottom', true),
      bus('rdata', 32, 'out'), bit('known', 'out'), bus('mtvecOut', 32, 'out'), bus('mepcOut', 32, 'out'), bit('irqTake', 'out'), bus('irqCause', 32, 'out'),
    ],
    symbol: { kind: 'box', label: 'CSRs' },
    netlist: () => ({ pins, instances, nets: merged }),
  });
  });
}
export const CSR_UNIT = csrUnit();

// ---- trap selection --------------------------------------------------------------------------------------------

export const TRAP_UNIT: ComponentDef = (() => {
  const instances: InstanceDef[] = [];
  const nets: NetDef[] = [];
  const net = (name: string | undefined, drv: string, ...s: string[]) => nets.push({ name, ends: [drv, ...s], tags: true });
  // priority chain, lowest first: storeMis (6, addr), loadMis (4, addr), fetchMis (0, target), ecall (11), ebreak (3), illegal (2), interrupt
  const chain: [string, number | null, string][] = [['storeMis', 6, 'addr'], ['loadMis', 4, 'addr'], ['fetchMis', 0, 'target'], ['ecall', 11, 'z'], ['ebreak', 3, 'z'], ['illegal', 2, 'z'], ['irq', null, 'z']];
  // One column per stage: the cause mux on top, the value mux below, each stage a row lower so
  // the chain wires (y of one stage → a of the next) run straight; the cause constant sits left.
  const X = (i: number) => 20 + 14 * i, CY = (i: number) => 8 + i, VY = (i: number) => 22 + i;
  const M2 = busMux2(32);
  instances.push({ name: 'z', def: constWord(32, 0), at: [12, 2] });
  let c = 'z.y', v = 'z.y';
  chain.forEach(([src, cause, val], i) => {
    instances.push({ name: `c${i}`, def: M2, at: [X(i), CY(i)] }, { name: `v${i}`, def: M2, at: [X(i), VY(i)] });
    // the constant zero feeding stage 0 is labelled (it also feeds later value inputs); the chain is drawn
    const t = i === 0 ? { tags: true as const } : {};
    nets.push({ ends: [c, `c${i}.a`], ...t }, { ends: [v, `v${i}.a`], ...t });
    if (cause === null) net('irqCause', 'irqCause', `c${i}.b`);
    else {
      instances.push({ name: `k${i}`, def: constWord(32, cause), at: [X(i) - 8, CY(i) + 4] });
      nets.push({ ends: [`k${i}.y`, `c${i}.b`] });
    }
    net(val === 'z' ? 'zero' : val, val === 'z' ? 'z.y' : val, `v${i}.b`);
    net(src, src, `c${i}.s`, `v${i}.s`, `any.i${i}`);
    c = `c${i}.y`;
    v = `v${i}.y`;
  });
  const last = chain.length - 1;
  instances.push({ name: 'any', def: orN(chain.length), at: [X(last), VY(last) + 12] });
  nets.push({ name: 'cause', ends: [c, 'cause'] }, { name: 'tval', ends: [v, 'tval'] }, { name: 'trap', ends: ['any.y', 'trap'] });
  const merged = mergeByDriver(nets);
  const right = X(last) + 12;
  const pins: Record<string, [number, number]> = {};
  ['irq', 'irqCause', 'illegal', 'ebreak', 'ecall', 'fetchMis', 'loadMis', 'storeMis', 'addr', 'target'].forEach((n, i) => (pins[n] = [0, 2 + 3 * i]));
  // outputs level with their drivers
  const yOf = (inst: string, port: string) => instances.find((i) => i.name === inst)!.at![1] + symbolGeom(instances.find((i) => i.name === inst)!.def).ports[port].pos[1];
  pins.cause = [right, yOf(`c${last}`, 'y')];
  pins.tval = [right, yOf(`v${last}`, 'y')];
  pins.trap = [right, yOf('any', 'y')];
  return define({
    id: 'trapunit', name: 'Trap unit', category: 'cpu',
    summary: 'Any interrupt or exception becomes a trap. A priority chain of multiplexers picks the cause (interrupts first, then illegal instruction, ebreak, ecall, misaligned fetch / load / store) and the value for mtval (the faulting address or target).',
    ports: [
      bit('irq', 'in'), bus('irqCause', 32, 'in'), bit('illegal', 'in'), bit('ebreak', 'in'), bit('ecall', 'in'),
      bit('fetchMis', 'in'), bit('loadMis', 'in'), bit('storeMis', 'in'), bus('addr', 32, 'in'), bus('target', 32, 'in'),
      bit('trap', 'out'), bus('cause', 32, 'out'), bus('tval', 32, 'out'),
    ],
    symbol: { kind: 'box', label: 'TRAP' },
    netlist: () => ({ pins, instances, nets: merged }),
  });
})();

// ---- memory-mapped I/O ---------------------------------------------------------------------------------------------

export const IO_UNIT: ComponentDef = (() => {
  const ins: [string, ComponentDef, string?][] = [];
  const nets: NetDef[] = [];
  const net = (name: string | undefined, drv: string, ...s: string[]) => nets.push({ name, ends: [drv, ...s], tags: true });
  ins.push(['sa', splitter([2, 3, 27])], ['dec', decoder(3, true)]);
  net('addr', 'addr', 'sa.in');
  net('reg', 'sa.o1', 'dec.a', 'rsel.s');
  net('we', 'we', 'dec.en');
  // console: valid when written this cycle
  net('consoleValid', 'dec.y0', 'consoleValid');
  ins.push(['sw', splitter([8, 24])]);
  net('wdata', 'wdata', 'sw.in', 'rCmp.d');
  net('wbyte', 'sw.o0', 'consoleData', 'rLed.d');
  ins.push(['rLed', register(8), 'LEDs']);
  net('weLed', 'dec.y1', 'rLed.en');
  net('leds', 'rLed.q', 'leds', 'zLed.i0');
  // timer
  ins.push(['mtime', incrementerCounter32(), 'mtime'], ['rCmp', register(32), 'mtimecmp'], ['cmp', addSubFast(32)], ['one', TIE1]);
  net('weCmp', 'dec.y5', 'rCmp.en');
  net('mtime', 'mtime.q', 'mtimeOut', 'cmp.a', 'rsel.d4');
  net('mtimecmp', 'rCmp.q', 'cmp.b', 'rsel.d5');
  net(undefined, 'one.y', 'cmp.sub');
  net('mtip', 'cmp.cout', 'mtip');
  // read multiplexer
  ins.push(['zLed', merger([8, 24])], ['zSw', merger([8, 24])], ['z24', constWord(24, 0)], ['z32', constWord(32, 0)], ['rsel', muxTree(3, 32)]);
  net(undefined, 'z24.y', 'zLed.i1', 'zSw.i1');
  net('switches', 'switches', 'zSw.i0');
  net(undefined, 'zLed.out', 'rsel.d1');
  net(undefined, 'zSw.out', 'rsel.d2');
  net(undefined, 'z32.y', 'rsel.d0', 'rsel.d3', 'rsel.d6', 'rsel.d7');
  nets.push({ name: 'rdata', ends: ['rsel.y', 'rdata'] });
  net('clk', 'clk', 'rLed.clk', 'rCmp.clk', 'mtime.clk');
  const merged = mergeByDriver(nets);
  const instances = columns(chunk(ins, 6), 14, 0, 12, 3);
  const right = Math.max(...instances.map((i) => i.at![0] + symbolGeom(i.def).w)) + 8;
  const pins: Record<string, [number, number]> = { addr: [0, 2], wdata: [0, 6], we: [0, 10], switches: [0, 14], clk: [0, 18] };
  // rdata straight out of the read multiplexer; the other outputs below its select label
  const rs = instances.find((i) => i.name === 'rsel')!, rg = symbolGeom(rs.def);
  pins.rdata = [right, rs.at![1] + rg.ports.y.pos[1]];
  ['consoleData', 'consoleValid', 'leds', 'mtimeOut', 'mtip'].forEach((n, i) => (pins[n] = [right, rs.at![1] + rg.h + 4 + 4 * i]));
  return define({
    id: 'iounit', name: 'I/O devices', category: 'cpu',
    summary: 'Memory-mapped devices: a console (store a byte to 0x8000_0000), LEDs (0x04), switches (0x08), a free-running cycle counter mtime (0x10) and its compare register mtimecmp (0x14). The timer interrupt is pending while mtime ≥ mtimecmp.',
    ports: [bus('addr', 32, 'in'), bus('wdata', 32, 'in'), bit('we', 'in'), bus('switches', 8, 'in'), bit('clk', 'in', 'bottom', true),
      bus('rdata', 32, 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), bus('mtimeOut', 32, 'out'), bit('mtip', 'out')],
    symbol: { kind: 'box', label: 'I/O' },
    netlist: () => ({ pins, instances, nets: merged }),
  });
})();

/** A free-running 32-bit counter (register + incrementer), always enabled. */
function incrementerCounter32(): ComponentDef {
  return memo('ctr32', () => {
    const R = register(32), I = incrementer(32);
    return define({
      id: 'freectr32', name: '32-bit cycle counter', category: 'sequential',
      summary: 'Counts clock cycles: a register whose input is its own value plus one.',
      ports: [bit('clk', 'in', 'bottom', true), bus('q', 32, 'out')],
      symbol: { kind: 'box', label: 'COUNT' },
      netlist: () => ({
        pins: { clk: [0, 20], q: [40, 4] },
        instances: [{ name: 'r', def: R, at: [8, 2] }, { name: 'inc', def: I, at: [8, 14], flip: true }, { name: 'en', def: TIE1, at: [2, 5] }],
        nets: [
          { name: 'q', ends: ['r.q', 'q', 'inc.a'], tags: ['inc.a'] },
          { name: 'next', ends: ['inc.y', 'r.d'], tags: true },
          { name: 'en', ends: ['en.y', 'r.en'] },
          { name: 'clk', ends: ['clk', 'r.clk'], tags: ['r.clk'] },
        ],
      }),
    });
  });
}

// ---- the complete processor -------------------------------------------------------------------------------------------

export interface SystemCpuOptions {
  adder?: 'rca' | 'ks';
  /** Add the M extension: a multiply/divide unit (divides stall the CPU). */
  m?: boolean;
}

export function systemCpu(program: number[], opts: SystemCpuOptions = {}): ComponentDef {
  const IM = rom(program, 7);
  const adder = opts.adder ?? 'ks';
  return memo(`sys_${IM.id}_${adder}${opts.m ? '_m' : ''}`, () => buildSystem(IM, adder, !!opts.m));
}

function buildSystem(IM: ComponentDef, adder: 'rca' | 'ks', m: boolean): ComponentDef {
  const SYSD = sysDecode(m), CSRU = csrUnit(m);
  const PC = register(32), RF = regfile(5, 32), ALU = alu(32, adder), DM = bankedMemory(5);
  const M2 = busMux2(32), M4 = muxTree(2, 32), M8 = muxTree(3, 32), ADD = adder === 'ks' ? koggeStone(32) : rca(32);
  const P4 = adder === 'ks' ? PLUS4_FAST : PLUS4;
  const SI = splitter([7, 5, 3, 5, 5, 7]), IMM12 = splitter([20, 12]);
  const g = (d: ComponentDef) => symbolGeom(d);
  const at = new Map<string, [number, number]>();
  const defs = new Map<string, ComponentDef>();
  const place = (name: string, def: ComponentDef, xy: [number, number]) => { at.set(name, xy); defs.set(name, def); };
  const P = (inst: string, port: string): [number, number] => {
    const a = at.get(inst)!, p = g(defs.get(inst)!).ports[port].pos;
    return [a[0] + p[0], a[1] + p[1]];
  };
  const alignY = (inst: string, def: ComponentDef, x: number, port: string, y: number) => place(inst, def, [x, y - g(def).ports[port].pos[1]]);

  const Y = 36;
  alignY('pcmux', M4, 4, 'y', Y);
  alignY('trapmux', M4, 12, 'd0', Y);
  alignY('pc', PC, 22, 'd', P('trapmux', 'y')[1]);
  place('one', TIE1, [17, P('pc', 'en')[1] - 1]);
  alignY('imem', IM, 36, 'addr', P('pc', 'q')[1]);
  alignY('si', SI, 56, 'in', P('imem', 'data')[1]);
  alignY('rf', RF, 70, 'wa', P('si', 'o1')[1]);
  alignY('imm', IMM_GEN, 70, 'instr', Y + 22);
  const rfR = at.get('rf')![0] + g(RF).w;
  alignY('srcA', M2, rfR + 8, 'a', P('rf', 'rd1')[1]);
  alignY('srcB', M2, rfR + 8, 'a', P('rf', 'rd2')[1] + 9);
  alignY('alu', ALU, rfR + 18, 'a', P('srcA', 'y')[1]);
  const aluR = at.get('alu')![0] + g(ALU).w;
  alignY('st', STORE_ALIGN, aluR + 12, 'wd', Y + 18);
  alignY('dm', DM, aluR + 30, 'addr', P('alu', 'y')[1]);
  alignY('io', IO_UNIT, aluR + 30, 'addr', Y + 70);
  alignY('ldsel', M2, aluR + 30 + g(DM).w + 8, 'a', P('dm', 'rdata')[1]);
  alignY('ld', LOAD_EXTRACT, P('ldsel', 'y')[0] + 6, 'rdata', P('ldsel', 'y')[1]);
  alignY('res', M8, P('ld', 'value')[0] + 8, 'd1', P('ld', 'value')[1]);
  place('plus4', P4, [36, Y - 10]);
  alignY('target', ADD, rfR + 18, 'a', Y + 26);
  place('gndT', TIE0, [P('target', 'cin')[0] - 7, P('target', 'cin')[1] - 3]);
  alignY('clr0', CLEAR_BIT0, aluR + 12, 'in', Y + 40);
  place('gndJ', TIE0, [P('clr0', 'zero')[0] - 6, P('clr0', 'zero')[1] + 1]);
  place('ctl', CONTROL, [26, 0]);
  place('npc', NEXT_PC, [96, 0]);
  // system blocks along the bottom
  const yS = Y + 60;
  place('imm12', IMM12, [52, yS - 6]);
  place('sys', SYSD, [4, yS + 4]);
  place('csr', CSRU, [4 + g(SYSD).w + 10, yS + 4]);
  place('trap', TRAP_UNIT, [4 + g(SYSD).w + 10 + g(CSRU).w + 10, yS + 4]);
  // glue logic
  const glue: [string, ComponentDef][] = [
    ['ntrap', NOT], ['rw', OR], ['rwq', AND], ['isIO', splitter([31, 1])], ['nio', NOT], ['memWq', andN(3)], ['ioWq', andN(3)],
    ['mretq', AND], ['tsel', merger([1, 1])], ['rsrc', merger([2, 1])], ['addr2', splitter([2, 30])], ['size', splitter([2, 1])],
    ['ldMis', AND], ['stMis', AND], ['isLoad', AND], ['nres1', NOT], ['taken', OR], ['tgt1', splitter([1, 1, 30])], ['fMis', AND],
    ['psplit', splitter([1, 1])], ['rssplit', splitter([1, 1])], ['z32', constWord(32, 0)],
  ];
  let gy = yS - 30;
  for (const [n, d] of glue) {
    place(n, d, [aluR - 10, gy]);
    gy += g(d).h + 2;
  }
  void gy;

  const labels: Record<string, string> = { pcmux: 'next PC', trapmux: 'trap / mret', pc: 'PC', srcA: 'SrcA', srcB: 'SrcB', res: 'result', target: 'PC + imm', ldsel: 'mem / I/O', sys: 'system decode', csr: 'CSRs', trap: 'trap unit', io: 'I/O' };
  const instances: InstanceDef[] = [...at.keys()].map((name) => ({ name, def: defs.get(name)!, at: at.get(name), label: labels[name] }));
  const pcq = P('pc', 'q');
  const aluY = P('alu', 'y');
  const bottom = yS + Math.max(g(CSRU).h, g(SYSD).h) + 12;
  const nets: NetDef[] = [
    { name: 'PCNormal', ends: ['pcmux.y', 'trapmux.d0', 'tgt1.in', 'trap.target'], tags: ['tgt1.in', 'trap.target'] },
    { name: 'PCNext', ends: ['trapmux.y', 'pc.d'] },
    { name: 'en', ends: ['one.y', 'pc.en'] },
    { name: 'PC', ends: ['pc.q', 'imem.addr', 'plus4.a', 'srcA.b', 'target.a', 'csr.trapPC', 'pcOut'], trunk: pcq[0] + 3, tags: ['srcA.b', 'target.a', 'csr.trapPC', 'pcOut'] },
    { name: 'PCPlus4', ends: ['plus4.y', 'pcmux.d0', 'pcmux.d3', 'res.d2'], tags: true },
    { name: 'PCTarget', ends: ['target.s', 'pcmux.d1'], tags: true },
    { name: 'JalrTarget', ends: ['clr0.out', 'pcmux.d2'], tags: true },
    { name: 'PCSrc', ends: ['npc.pcSrc', 'pcmux.s', 'psplit.in'], tags: true },
    { name: 'pcSrc0', ends: ['psplit.o0', 'taken.a'], tags: true },
    { name: 'pcSrc1', ends: ['psplit.o1', 'taken.b'], tags: true },
    { name: 'Instr', ends: ['imem.data', 'si.in', 'imm.instr', 'imm12.in'], trunk: 52, tags: ['imm12.in'] },
    { name: 'op', ends: ['si.o0', 'ctl.op', 'sys.op'], tags: true },
    { name: 'rd', ends: ['si.o1', 'rf.wa'] },
    { name: 'funct3', ends: ['si.o2', 'ctl.funct3', 'npc.funct3', 'sys.funct3', 'csr.funct3', 'size.in', 'ld.funct3'], tags: true },
    { name: 'rs1', ends: ['si.o3', 'rf.ra1', 'sys.rs1', 'csr.zimm5'], trunk: 65, tags: ['sys.rs1', 'csr.zimm5'] },
    { name: 'rs2', ends: ['si.o4', 'rf.ra2'], trunk: 66.5 },
    { name: 'funct7', ends: ['si.o5', 'ctl.funct7', 'sys.funct7'], tags: true },
    { name: 'imm12', ends: ['imm12.o1', 'sys.imm12', 'csr.addr'], tags: true },
    { name: 'ImmExt', ends: ['imm.imm', 'srcB.b', 'target.b', 'res.d3'], trunk: P('imm', 'imm')[0] + 3, tags: ['res.d3'] },
    { name: 'rd1', ends: ['rf.rd1', 'srcA.a', 'csr.rs1v'], tags: ['csr.rs1v'] },
    { name: 'WriteData', ends: ['rf.rd2', 'srcB.a', 'st.wd'], trunk: rfR + 2.5, tags: ['st.wd'] },
    { name: 'SrcA', ends: ['srcA.y', 'alu.a'] },
    { name: 'SrcB', ends: ['srcB.y', 'alu.b'] },
    { name: 'ALUResult', ends: ['alu.y', 'dm.addr', 'res.d0', 'clr0.in', 'io.addr', 'addr2.in', 'isIO.in', 'trap.addr'], trunk: aluY[0] + 4, tags: ['res.d0', 'io.addr', 'addr2.in', 'isIO.in', 'trap.addr'] },
    { name: 'addr[1:0]', ends: ['addr2.o0', 'st.addr', 'ld.addr'], tags: true },
    { name: 'size', ends: ['size.o0', 'st.size'], tags: true },
    { name: 'StoreData', ends: ['st.wdata', 'dm.wdata', 'io.wdata'], tags: true },
    { name: 'ByteEn', ends: ['st.be', 'dm.be'], tags: true },
    { name: 'misaligned', ends: ['st.misaligned', 'ldMis.b', 'stMis.b'], tags: true },
    { name: 'MemRead', ends: ['dm.rdata', 'ldsel.a'] },
    { name: 'IORead', ends: ['io.rdata', 'ldsel.b'], tags: true },
    { name: 'isIO', ends: ['isIO.o1', 'ldsel.s', 'nio.a', 'ioWq.i2'], tags: true },
    { name: 'LoadWord', ends: ['ldsel.y', 'ld.rdata'] },
    { name: 'LoadValue', ends: ['ld.value', 'res.d1'] },
    { name: 'CSRRead', ends: ['csr.rdata', 'res.d4'], tags: true },
    { name: 'gndJ', ends: ['gndJ.y', 'clr0.zero'], via: { 'clr0.zero': [[P('clr0', 'zero')[0], P('gndJ', 'y')[1]]] } },
    { name: 'zero32', ends: ['z32.y', 'res.d5', 'res.d6', 'res.d7'], tags: true },
    { name: 'Result', ends: ['res.y', 'rf.wd'], tags: true },
    { name: 'gndT', ends: ['gndT.y', 'target.cin'], via: { 'target.cin': [[P('target', 'cin')[0], P('gndT', 'y')[1]]] } },
    { name: 'clk', ends: ['clk', 'pc.clk', 'rf.clk', 'dm.clk', 'io.clk', 'csr.clk'], tags: ['pc.clk', 'rf.clk', 'dm.clk', 'io.clk', 'csr.clk'] },
    // control
    { name: 'RegWriteCtl', ends: ['ctl.regWrite', 'rw.a'], tags: true },
    { name: 'csrOp', ends: ['sys.csrOp', 'rw.b', 'rsrc.i1'], tags: true },
    { name: 'RegWrite', ends: ['rwq.y', 'rf.we'], tags: true },
    { name: 'NoTrap', ends: ['ntrap.y', 'rwq.b', 'memWq.i1', 'ioWq.i1', 'mretq.b'], tags: true },
    { name: 'rwAny', ends: ['rw.y', 'rwq.a'], tags: true },
    { name: 'ImmSrc', ends: ['ctl.immSrc', 'imm.src'], tags: true },
    { name: 'ALUSrcA', ends: ['ctl.aluSrcA', 'srcA.s'], tags: true },
    { name: 'ALUSrcB', ends: ['ctl.aluSrcB', 'srcB.s'], tags: true },
    { name: 'MemWriteCtl', ends: ['ctl.memWrite', 'memWq.i0', 'ioWq.i0', 'stMis.a'], tags: true },
    { name: 'notIO', ends: ['nio.y', 'memWq.i2'], tags: true },
    { name: 'MemWrite', ends: ['memWq.y', 'dm.we'], tags: true },
    { name: 'IOWrite', ends: ['ioWq.y', 'io.we'], tags: true },
    { name: 'ResultSrc2', ends: ['ctl.resultSrc', 'rsrc.i0', 'rssplit.in'], tags: true },
    { name: 'resSrc0', ends: ['rssplit.o0', 'isLoad.a'], tags: true },
    { name: 'resSrc1', ends: ['rssplit.o1', 'nres1.a'], tags: true },
    { name: 'ResultSrc', ends: ['rsrc.out', 'res.s'], tags: true },
    { name: 'Branch', ends: ['ctl.branch', 'npc.branch'], tags: true },
    { name: 'Jump', ends: ['ctl.jump', 'npc.jump'], tags: true },
    { name: 'Jalr', ends: ['ctl.jalr', 'npc.jalr'], tags: true },
    { name: 'ALUControl', ends: ['ctl.aluCtl', 'alu.ctl'], tags: true },
    { name: 'Zero', ends: ['alu.zero', 'npc.zero'], tags: true },
    { name: 'Neg', ends: ['alu.neg', 'npc.neg'], tags: true },
    { name: 'Ovf', ends: ['alu.ovf', 'npc.ovf'], tags: true },
    { name: 'Carry', ends: ['alu.carry', 'npc.carry'], tags: true },
    // exceptions
    { name: 'isLoad', ends: ['isLoad.y', 'ldMis.a'], tags: true },
    { name: '¬resSrc1', ends: ['nres1.y', 'isLoad.b'], tags: true },
    { name: 'loadMis', ends: ['ldMis.y', 'trap.loadMis'], tags: true },
    { name: 'storeMis', ends: ['stMis.y', 'trap.storeMis'], tags: true },
    { name: 'tookBranch', ends: ['taken.y', 'fMis.a'], tags: true },
    { name: 'target[1]', ends: ['tgt1.o1', 'fMis.b'], tags: true },
    { name: 'fetchMis', ends: ['fMis.y', 'trap.fetchMis'], tags: true },
    { name: 'PCTargetChk', ends: ['pcmux.y'] },
    { name: 'illegal', ends: ['sys.illegal', 'trap.illegal'], tags: true },
    { name: 'ecall', ends: ['sys.ecall', 'trap.ecall'], tags: true },
    { name: 'ebreak', ends: ['sys.ebreak', 'trap.ebreak'], tags: true },
    { name: 'mretRaw', ends: ['sys.mret', 'mretq.a'], tags: true },
    { name: 'mret', ends: ['mretq.y', 'csr.mret', 'tsel.i0'], tags: true },
    { name: 'csrWriteRaw', ends: ['sys.csrWrite'] },
    { name: 'csrKnown', ends: ['csr.known', 'sys.csrKnown'], tags: true },
    { name: 'irqTake', ends: ['csr.irqTake', 'trap.irq'], tags: true },
    { name: 'irqCause', ends: ['csr.irqCause', 'trap.irqCause'], tags: true },
    { name: 'Trap', ends: ['trap.trap', 'ntrap.a', 'csr.trap', 'tsel.i1'], tags: true },
    { name: 'TrapCause', ends: ['trap.cause', 'csr.trapCause'], tags: true },
    { name: 'TrapVal', ends: ['trap.tval', 'csr.trapVal'], tags: true },
    { name: 'TrapSel', ends: ['tsel.out', 'trapmux.s'], tags: true },
    { name: 'mepc', ends: ['csr.mepcOut', 'trapmux.d1'], tags: true },
    { name: 'mtvec', ends: ['csr.mtvecOut', 'trapmux.d2', 'trapmux.d3'], tags: true },
    { name: 'mtime', ends: ['io.mtimeOut', 'csr.mtime'], tags: true },
    { name: 'mtip', ends: ['io.mtip', 'csr.mtip'], tags: true },
    { name: 'irq', ends: ['irq', 'csr.meip'], tags: ['csr.meip'] },
    { name: 'switches', ends: ['switches', 'io.switches'], tags: ['io.switches'] },
    { name: 'consoleData', ends: ['io.consoleData', 'consoleData'], tags: true },
    { name: 'consoleValid', ends: ['io.consoleValid', 'consoleValid'], tags: true },
    { name: 'leds', ends: ['io.leds', 'leds'], tags: true },
  ];
  // CSR writes happen only if the instruction does not trap
  nets.splice(nets.findIndex((n) => n.name === 'csrWriteRaw'), 1);
  instances.push({ name: 'csrWq', def: AND, at: [aluR - 20, yS - 30] });
  defs.set('csrWq', AND);
  nets.push({ name: 'csrWriteRaw', ends: ['sys.csrWrite', 'csrWq.a'], tags: true });
  nets.find((n) => n.name === 'NoTrap')!.ends.push('csrWq.b');
  nets.push({ name: 'csrWrite', ends: ['csrWq.y', 'csr.csrWrite'], tags: true });
  // the fetch-misaligned target bit comes from the normal next PC
  nets.splice(nets.findIndex((n) => n.name === 'PCTargetChk'), 1);
  void bottom;
  void fanout;
  const pins: Record<string, [number, number]> = { clk: [0, yS - 10], switches: [0, yS - 6], irq: [0, yS - 2], pcOut: [P('res', 'y')[0] + 20, yS - 10], consoleData: [P('res', 'y')[0] + 20, yS - 6], consoleValid: [P('res', 'y')[0] + 20, yS - 2], leds: [P('res', 'y')[0] + 20, yS + 2] };
  if (m) {
    // ---- M extension: the multiply/divide unit, a result multiplexer, and the stall it causes
    const xM = P('res', 'y')[0] + 8, yM = yS + Math.max(g(CSRU).h, g(SYSD).h) + 16;
    const add = (name: string, def: ComponentDef, xy: [number, number], label?: string) => { instances.push({ name, def, at: xy, label }); defs.set(name, def); at.set(name, xy); };
    add('md', MDU, [4 + g(SYSD).w + 10, yM], 'M unit');
    add('mres', M2, [xM, P('res', 'y')[1] - g(M2).ports.a.pos[1]], 'ALU / M');
    add('nstall', NOT, [17, P('pc', 'en')[1] - 1]);
    add('rwm', AND, [aluR - 20, yS - 24]);
    add('nbusy', NOT, [aluR - 20, yS - 18]);
    add('irqg', AND, [aluR - 20, yS - 14]);
    instances.splice(instances.findIndex((i) => i.name === 'one'), 1);
    const net = (name: string) => nets.find((n) => n.name === name)!;
    nets.splice(nets.indexOf(net('en')), 1);
    net('Result').ends = ['res.y', 'mres.a'];
    net('RegWrite').ends = ['rwq.y', 'rwm.a'];
    net('irqTake').ends = ['csr.irqTake', 'irqg.a'];
    net('rd1').ends.push('md.a');
    net('WriteData').ends.push('md.b');
    net('funct3').ends.push('md.funct3');
    net('NoTrap').ends.push('md.noTrap');
    net('clk').ends.push('md.clk');
    (net('clk').tags as string[]).push('md.clk');
    nets.push(
      { name: 'isM', ends: ['sys.isM', 'md.isM', 'mres.s'], tags: true },
      { name: 'MResult', ends: ['md.y', 'mres.b'], tags: true },
      { name: 'WriteBack', ends: ['mres.y', 'rf.wd'], tags: true },
      { name: 'stall', ends: ['md.stall', 'nstall.a'], tags: true },
      { name: 'retire', ends: ['nstall.y', 'pc.en', 'rwm.b', 'retire'], tags: ['rwm.b', 'retire'] },
      { name: 'RegWriteQ', ends: ['rwm.y', 'rf.we'], tags: true },
      { name: 'divBusy', ends: ['md.busy', 'nbusy.a'], tags: true },
      { name: '¬divBusy', ends: ['nbusy.y', 'irqg.b'], tags: true },
      { name: 'irqTakeQ', ends: ['irqg.y', 'trap.irq'], tags: true },
    );
    pins.retire = [P('res', 'y')[0] + 20, yS + 6];
  }
  return {
    id: `sys_${IM.id}${adder === 'ks' ? '' : '_rca'}${m ? '_m' : ''}`, name: `RV32I${m ? 'M' : ''} system (single-cycle, Zicsr, traps, I/O)`, category: 'cpu',
    summary: `The complete processor: every RV32I instruction including byte and halfword memory access, the Zicsr instructions, machine-mode exceptions and interrupts, and memory-mapped I/O (console, LEDs, switches, timer).${m ? ' Plus the M extension: one-cycle multiplies and 34-cycle divides that stall the processor (retire = 0 while they run).' : ''}`,
    ports: [bit('clk', 'in', 'left', true), bus('switches', 8, 'in'), bit('irq', 'in'), bus('pcOut', 32, 'out'), bus('consoleData', 8, 'out'), bit('consoleValid', 'out'), bus('leds', 8, 'out'), ...(m ? [bit('retire', 'out')] : [])],
    symbol: { kind: 'box', label: m ? 'RV32IM SYSTEM' : 'RV32I SYSTEM' },
    netlist: () => ({ pins, instances, nets }),
  };
}
