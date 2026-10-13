// Our MOS 6502 at transistor level (Appendix A): the design of src/m6502/rtl.ts in NMOS
// depletion-load logic, two-phase clocked. Blocks, each built from the cells of cells.ts / nmos.ts:
//
//   CLOCK   φ0 → non-overlapping φ1 / φ2 (the gap is a delay chain longer than any control path)
//   DECODE  the PLA (src/m6502/pla.ts): a NOR per row over IR / T literals, a NOR per signal
//   CONTROL the PLA's outputs qualified by φ1 (bus transfers) or latched in φ1 (held through φ2)
//   TIMING  the T-state ring, the end of an instruction, the branch's state
//   INTR    RES / IRQ / NMI: sampling, polling, the interrupt sequence, its vector
//   IR, REG A / X / Y / S, ALU, PC, ADDR, DATA, FLAGS, BUSES: the datapath
//
// Rules the blocks keep (they are what lets dynamic logic work, on the die and in NmosSim): a
// storage node is loaded in one phase and refreshed in the other; whatever φ2 needs from the PLA
// is latched in φ1 (the T state and IR change during φ2); state that lives across cycles is a
// master–slave pair whose next value is computed in φ1.

import { plaRows } from '../../m6502/pla';
import { SIGNALS, type Sig } from '../../m6502/ucode';
import { symbolGeom } from '../../sim/geometry';
import type { ComponentDef, PortDef } from '../../sim/types';
import { define } from '../define';
import { Logic } from './logic';

const bit = (name: string, dir: PortDef['dir'] = 'in'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width = 8, dir: PortDef['dir'] = 'inout'): PortDef => ({ name, width, dir });
const R8 = [0, 1, 2, 3, 4, 5, 6, 7];

/** Signals qualified by φ1 (bus transfers and loads). */
export const PHI1: Sig[] = ['PCL_ADL', 'PCH_ADH', 'ADL_ABL', 'ADH_ABH', 'ADL_PCL', 'ADH_PCH', 'DL_DB', 'DL_ADL', 'DL_ADH',
  'A_DB', 'A_SB', 'X_SB', 'Y_SB', 'S_SB', 'S_ADL', 'SB_A', 'SB_X', 'SB_Y', 'SB_S', 'P_DB', 'PCL_DB', 'PCH_DB',
  'ADD_SB', 'ADD_ADL', 'ZERO_ADH', 'VEC_LO', 'SB_DB', 'SB_ADH', 'DB_DOR', 'SB_AI', 'ZERO_AI', 'DB_BI', 'NDB_BI', 'ADL_BI'];
/** Signals latched in φ1 and held through φ2 (the ALU's function, the memory cycle, the PC step). */
export const HELD: Sig[] = ['DL_HOLD', 'OP_AND', 'OP_OR', 'OP_EOR', 'OP_SR', 'CIN_1', 'CIN_C', 'CIN_ACR', 'DEC_ADC', 'DEC_SBC'];
/** Signals used as levels in φ1 by next-state logic (flags, sequencing, interrupts). */
export const RAW: Sig[] = ['DB_P', 'DB_NZ', 'DB_N', 'DB_V', 'C0', 'C1', 'I0', 'I1', 'D0', 'D1', 'V0', 'ALU_C', 'ALU_V', 'ALU_NZ', 'ALU_Z',
  'END', 'END_INT', 'END_NOCROSS', 'END_NOTTAKEN', 'END_NOCROSS_BR', 'BR_T1', 'BR_FIX', 'VEC_SEL', 'ADL_PCL', 'ADH_PCH'];

/** The extra inputs of the PLA's output NORs: what random logic adds to a signal. */
const EXTRA: Partial<Record<Sig, string[]>> = {
  ADD_SB: ['wa', 'wx', 'wy', 'brx'], SB_A: ['wa'], SB_X: ['wx'], SB_Y: ['wy'],
  ADD_ADL: ['brs'], PCH_ADH: ['brnx'], PCL_ADL: ['brns'], SB_ADH: ['brx'],
  SB_AI: ['bfn'], ZERO_AI: ['bfp'], CIN_1: ['bfp'],
};
const EXTRA_NETS = [...new Set(Object.values(EXTRA).flat())];

const busPorts = (...names: string[]) => names.map((n) => bus(n));
const n = (s: Sig) => `n_${s}`;
const c = (s: Sig) => `c_${s}`;
const h = (s: Sig) => `h_${s}`;
const r = (s: Sig) => `r_${s}`;

// ---- CLOCK -----------------------------------------------------------------------------------------

export function clockBlock(): ComponentDef {
  const L = new Logic();
  const nphi0 = L.inv('phi0');
  // each raw phase waits for the other's buffered line, delayed: the non-overlap gap
  const delay = (x: string, k: number) => { let y = x; for (let i = 0; i < k; i++) y = L.inv(y); return y; };
  const a = L.net('a'), b = L.net('b');
  L.nor(['phi0', delay('p2', 6)], a);
  L.nor([nphi0, delay('p1', 6)], b);
  L.inv(a, 'np1'); L.inv('np1', 'p1');
  L.inv(b, 'np2'); L.inv('np2', 'p2');
  return L.build({
    id: 'm65_clock', name: '6502 clock generator',
    summary: 'φ0 in, two non-overlapping phases out: φ1 while φ0 = 0, φ2 while φ0 = 1, each starting only after the other has been low for six gate delays.',
    ports: [bit('phi0'), bit('p1', 'out'), bit('p2', 'out'), bit('np1', 'out'), bit('np2', 'out')],
    symbol: { kind: 'box', label: 'CLOCK' }, rows: 6,
  });
}

// ---- DECODE (the PLA) ------------------------------------------------------------------------------

export function decodeBlock(): ComponentDef {
  const L = new Logic();
  const rows = plaRows();
  const rowsOf = new Map<number, string[]>(SIGNALS.map((_, i) => [i, []]));
  rows.forEach((row, k) => {
    const ins: string[] = [`nt[${row.t - 1}]`];
    for (let i = 0; i < 8; i++) {
      if ((row.cube.mask >> i) & 1) continue;
      ins.push((row.cube.val >> i) & 1 ? `nir[${i}]` : `ir[${i}]`);
    }
    const out = `row${k}`;
    L.nor(ins, out);
    for (const s of row.outs) rowsOf.get(s)!.push(out);
  });
  SIGNALS.forEach((s, i) => {
    const ins = [...rowsOf.get(i)!, ...(EXTRA[s] ?? [])];
    if (ins.length) L.nor(ins, n(s));
    else L.pullup('VDD', n(s)); // never asserted: tied off
  });
  return L.build({
    id: 'm65_decode', name: '6502 decode PLA',
    summary: `${rows.length} product terms of IR and the T state (each a NOR of complemented literals), ORed per control signal (a NOR of its rows): the control table of src/m6502/ucode.ts, minimized with the undocumented opcodes as don't-cares.`,
    ports: [bus('ir', 8, 'in'), bus('nir', 8, 'in'), bus('nt', 7, 'in'), ...EXTRA_NETS.map((x) => bit(x)), ...SIGNALS.map((s) => bit(n(s), 'out'))],
    symbol: { kind: 'box', label: 'DECODE PLA' }, rows: 24,
  });
}

// ---- CONTROL ---------------------------------------------------------------------------------------

export function controlBlock(): ComponentDef {
  const L = new Logic();
  for (const s of PHI1) L.nor([n(s), 'np1'], c(s));
  for (const s of HELD) L.dlat(n(s), 'p1', h(s));
  for (const s of RAW) L.inv(n(s), r(s));
  // the PC's other source while it is not loaded from the buses
  L.nor([r('ADL_PCL'), 'np1'], 'hold_pcl');
  L.nor([r('ADH_PCH'), 'np1'], 'hold_pch');
  // ADH constants: bits 1–7 low for $00 and $01, bit 0 for $00 only; the vector's byte on ADL
  L.aoi([[n('ZERO_ADH'), n('ONE_ADH')], ['np1']], 'c_ZO_ADH');
  L.aoi([[n('VEC_LO'), n('VEC_HI')], ['np1']], 'c_VEC');
  // an interrupt sequence does not step the PC in its first two cycles; a reset never writes
  const t12 = L.nand(['nt[0]', 'nt[1]']);
  const supp = L.and(['intg', t12]);
  L.dlat(L.inv(L.nor([n('PC_INC'), supp])), 'p1', h('PC_INC'));
  const wr = L.dlat(L.nand([L.inv(n('WRITE')), 'nresetting', 'nreslow']), 'p1', h('WRITE'));
  L.inv(h('WRITE'), 'rw');
  void wr;
  // ALU results written a cycle later: master in φ1, slave in φ2, read in the next φ1
  for (const [s, w] of [['W_A', 'wa'], ['W_X', 'wx'], ['W_Y', 'wy']] as const) {
    const m = L.dlat(n(s), 'p1');
    L.dlat(m.nq, 'p2', L.net(), w);
  }
  // the fetch cycle, held through φ2 (T changes in φ2): IR load, SYNC. A pass transistor only ever
  // takes a driven node (T1 from its latch's inverter), never a stored charge it would share
  const t1 = L.dlat('t1', 'p1', 'nt1h');
  L.nor([t1.nq, 'np2'], 'irld');
  L.nor([t1.nq, 'resetting'], 'sync');
  return L.build({
    id: 'm65_control', name: '6502 control lines',
    summary: 'The PLA\'s outputs made into control lines: qualified by φ1 for bus transfers, latched in φ1 for what must hold through φ2, delayed a cycle for ALU results.',
    ports: [...SIGNALS.map((s) => bit(n(s))), bit('p1'), bit('p2'), bit('np1'), bit('np2'), bus('nt', 7, 'in'), bit('t1'), bit('intg'), bit('nresetting'), bit('resetting'), bit('nreslow'),
      ...PHI1.map((s) => bit(c(s), 'out')), ...HELD.map((s) => bit(h(s), 'out')), ...RAW.map((s) => bit(r(s), 'out')),
      bit('hold_pcl', 'out'), bit('hold_pch', 'out'), bit('c_ZO_ADH', 'out'), bit('c_VEC', 'out'), bit(h('PC_INC'), 'out'), bit(h('WRITE'), 'out'),
      bit('rw', 'out'), bit('wa', 'out'), bit('wx', 'out'), bit('wy', 'out'), bit('irld', 'out'), bit('sync', 'out')],
    symbol: { kind: 'box', label: 'CONTROL' }, rows: 20,
  });
}

// ---- TIMING ----------------------------------------------------------------------------------------

export function timingBlock(): ComponentDef {
  const L = new Logic();
  const [END, END_INT, NOCROSS, NOTTAKEN, NOCROSS_BR] = ['END', 'END_INT', 'END_NOCROSS', 'END_NOTTAKEN', 'END_NOCROSS_BR'].map((s) => r(s as Sig));
  // branch condition: the flag picked by IR7:6, compared with IR5
  const nf = L.aoi([['nir[7]', 'nir[6]', 'fn'], ['nir[7]', 'ir[6]', 'fv'], ['ir[7]', 'nir[6]', 'fc'], ['ir[7]', 'ir[6]', 'fz']]);
  const f = L.inv(nf);
  const taken = L.aoi([[f, 'nir[5]'], [nf, 'ir[5]']]);
  const ntaken = L.inv(taken);
  // a taken branch crosses a page when PCL + offset's carry differs from the offset's sign (DB7)
  const ndb7 = L.inv('db[7]'), ncarry = L.inv('carry');
  const ncross = L.aoi([['carry', ndb7], [ncarry, 'db[7]']]);
  const cross = L.inv(ncross);
  const nacr = L.inv('acr');
  const nend = L.aoi([[END], [END_INT], [NOCROSS, nacr], [NOTTAKEN, ntaken], [NOCROSS_BR, ncross]], 'nendany');
  L.inv(nend, 'endany');
  // the T ring: one-hot, T1 after the last cycle (or while RES is low)
  const next1 = L.inv(L.nor(['endany', 'reslow']));
  const t = L.ms(next1, 'p1', 'p2', 't1', 'nt[0]');
  void t;
  for (let k = 2; k <= 7; k++) L.ms(L.nor([`nt[${k - 2}]`, 'endany', 'reslow']), 'p1', 'p2', `t${k}`, `nt[${k - 1}]`);
  // the branch's state for the next fetch: within the page, crossed (and the offset's sign)
  const enBr = L.or([NOTTAKEN, NOCROSS_BR]);
  const nenBr = L.inv(enBr);
  const brCross = L.ms(L.inv(L.aoi([[NOCROSS_BR, cross], [nenBr, 'brcross']])), 'p1', 'p2', 'brcross', 'nbrcross');
  const brSame = L.ms(L.inv(L.aoi([[NOCROSS_BR, ncross], [nenBr, 'brsame']])), 'p1', 'p2', 'brsame', 'nbrsame');
  const nNB = L.inv(NOCROSS_BR);
  const brNeg = L.ms(L.inv(L.aoi([[NOCROSS_BR, 'db[7]'], [nNB, 'brneg']])), 'p1', 'p2', 'brneg', 'nbrneg');
  void brCross; void brSame; void brNeg;
  // what the branch adds to the PLA's outputs
  const nbr = L.inv(r('BR_T1'));
  L.nor([nbr, 'nbrcross'], 'brx');
  L.nor([nbr, 'nbrsame'], 'brs');
  L.nor([nbr, 'brcross'], 'brnx');
  L.nor([nbr, 'brsame'], 'brns');
  const nfix = L.inv(r('BR_FIX'));
  L.nor([nfix, 'nbrneg'], 'bfn');
  L.nor([nfix, 'brneg'], 'bfp');
  return L.build({
    id: 'm65_timing', name: '6502 timing',
    summary: 'The T-state ring (T1 … T7, one-hot, master–slave), the end of an instruction (with the page-crossing and branch conditions), and the branch\'s state for the next fetch.',
    ports: [...[END, END_INT, NOCROSS, NOTTAKEN, NOCROSS_BR, r('BR_T1'), r('BR_FIX')].map((x) => bit(x)), bus('ir', 8, 'in'), bus('nir', 8, 'in'),
      bit('fn'), bit('fv'), bit('fc'), bit('fz'), bus('db', 8, 'in'), bit('carry'), bit('acr'), bit('reslow'), bit('p1'), bit('p2'),
      bus('nt', 7, 'out'), bit('t1', 'out'), bit('endany', 'out'), bit('nendany', 'out'),
      ...['brx', 'brs', 'brnx', 'brns', 'bfn', 'bfp'].map((x) => bit(x, 'out'))],
    symbol: { kind: 'box', label: 'TIMING' }, rows: 14,
  });
}

// ---- INTR ------------------------------------------------------------------------------------------

export function intrBlock(): ComponentDef {
  const L = new Logic();
  L.inv('resb', 'reslow');
  L.inv('reslow', 'nreslow');
  const irq = L.inv('irqb'), nmi = L.inv('nmib');
  // the lines as they were at the end of the last φ2 (and, for NMI, of the φ2 before)
  const irqSig = L.dlat(irq, 'p2').s;
  const cur = L.dlat(nmi, 'p2');
  const a = L.dlat(cur.nq, 'p1');
  const b = L.dlat(a.nq, 'p2');
  const edge = L.and([cur.s, b.nq]);
  const nsig = L.or([edge, 'nmisig']);
  // NMI's latch: set by the edge, cleared by the vector pick (unless resetting) or RES
  const clr = L.or([L.and(['r_VEC_SEL', 'nresetting']), 'reslow']);
  L.ms(L.nor([L.inv(nsig), clr]), 'p1', 'p2', 'nmisig');
  // polling: in the cycles that may be an instruction's last
  const poll = L.or(['r_END', 'r_END_NOCROSS', 'r_END_NOTTAKEN', 'r_BR_FIX']);
  const npoll = L.inv(poll);
  const pendNew = L.or([nsig, L.and([irqSig, 'ni'])]);
  const pnow = L.or([L.and([poll, pendNew]), L.and([npoll, 'pending'])]);
  const start = L.and(['endany', pnow]);
  L.ms(L.or([L.and([pendNew, poll, 'nendany', 'nreslow']), L.and([npoll, 'nendany', 'nreslow', 'pending'])]), 'p1', 'p2', 'pending');
  const nEndInt = L.inv('r_END_INT');
  L.ms(L.or(['reslow', start, L.and(['intg', nEndInt])]), 'p1', 'p2', 'intg', 'nintg');
  L.ms(L.or(['reslow', L.and(['resetting', nEndInt])]), 'p1', 'p2', 'resetting', 'nresetting');
  // the vector: $FFFC while resetting, else $FFFA if an NMI was pending at the P push, else $FFFE
  const ld = L.or(['r_VEC_SEL', 'reslow']);
  const nld = L.inv(ld);
  L.ms(L.or([L.and(['r_VEC_SEL', nsig, 'nresetting', 'nreslow']), L.and([nld, 'vfa'])]), 'p1', 'p2', 'vfa');
  return L.build({
    id: 'm65_intr', name: '6502 interrupt logic',
    summary: 'RES, IRQ and NMI: the lines sampled each φ2, NMI\'s edge latched, polling in an instruction\'s last cycle, the interrupt sequence (intg) and its vector.',
    ports: [bit('resb'), bit('irqb'), bit('nmib'), bit('p1'), bit('p2'), bit('r_END'), bit('r_END_NOCROSS'), bit('r_END_NOTTAKEN'), bit('r_BR_FIX'),
      bit('r_END_INT'), bit('r_VEC_SEL'), bit('endany'), bit('nendany'), bit('ni'),
      bit('reslow', 'out'), bit('nreslow', 'out'), bit('intg', 'out'), bit('nintg', 'out'), bit('resetting', 'out'), bit('nresetting', 'out'), bit('vfa', 'out')],
    symbol: { kind: 'box', label: 'INTERRUPTS' }, rows: 12,
  });
}

// ---- IR --------------------------------------------------------------------------------------------

export function irBlock(): ComponentDef {
  const L = new Logic();
  for (const i of R8) {
    // a reset holds a NOP ($EA) while RES is low; an interrupt sequence loads BRK ($00)
    const nin = (0xea >> i) & 1 ? L.aoi([[`din[${i}]`, 'nintg'], ['reslow']]) : L.nand([`din[${i}]`, 'nintg']);
    L.pass('irld', nin, `q${i}`);
    L.cell(`q${i}`, 'p1', `ir[${i}]`, `nir[${i}]`);
  }
  return L.build({
    id: 'm65_ir', name: '6502 instruction register',
    summary: 'The opcode, loaded at the end of the fetch cycle (φ2 of T1), stored inverted and refreshed in φ1. A reset forces NOP, an interrupt BRK.',
    ports: [bus('din', 8, 'in'), bit('irld'), bit('nintg'), bit('reslow'), bit('p1'), bus('ir', 8, 'out'), bus('nir', 8, 'out')],
    symbol: { kind: 'box', label: 'IR' }, rows: 8,
  });
}

// ---- registers -------------------------------------------------------------------------------------

/** One bit of a register: a storage node refreshed in φ2, loaded from SB in φ1, driving buses. */
function regBit(drives: string[]): ComponentDef {
  const L = new Logic();
  L.pass('ld', 'sb', 'q');
  const { nq } = L.cell('q', 'p2', 'nq', 'v');
  for (const b of drives) L.drive(`rd_${b}`, nq, b);
  return L.build({
    id: `m65_regbit_${drives.join('_')}`, name: `6502 register bit (${drives.join(', ')})`,
    summary: `A stored bit: loaded from SB through a pass transistor in φ1, refreshed from its own double inversion in φ2, driving ${drives.join(' and ')} through two series pull-downs each.`,
    ports: [bit('ld'), ...drives.map((b) => bit(`rd_${b}`)), bit('p2'), bit('sb', 'inout'), ...drives.filter((b) => b !== 'sb').map((b) => bit(b, 'inout')), bit('v', 'out')],
    symbol: { kind: 'box', label: 'BIT' }, rows: 3,
  });
}

export function regBlock(name: string, drives: string[]): ComponentDef {
  const L = new Logic();
  const cell = regBit(drives);
  for (const i of R8) {
    L.add(`b${i}`, cell, { ld: 'ld', p2: 'p2', sb: `sb[${i}]`, v: `v[${i}]`,
      ...Object.fromEntries(drives.map((b) => [`rd_${b}`, `rd_${b}`])), ...Object.fromEntries(drives.filter((b) => b !== 'sb').map((b) => [b, `${b}[${i}]`])) });
  }
  return L.build({
    id: `m65_reg_${name.toLowerCase()}`, name: `6502 register ${name}`,
    summary: `${name}: eight register bits sharing a load line (from SB) and ${drives.length} drive line${drives.length > 1 ? 's' : ''}.`,
    ports: [bit('ld'), ...drives.map((b) => bit(`rd_${b}`)), bit('p2'), ...[...new Set(['sb', ...drives])].map((b) => bus(b)), bus('v', 8, 'out')],
    symbol: { kind: 'box', label: name }, rows: 4,
  });
}

// ---- ALU -------------------------------------------------------------------------------------------

export function aluBlock(): ComponentDef {
  const L = new Logic();
  // carry in and decimal mode, computed in φ1 and held through φ2 with the function (the flags change in φ2)
  const ncin = L.aoi([['h_CIN_1'], ['h_CIN_C', 'fc'], ['h_CIN_ACR', 'acr']]);
  const cinL = L.dlat(ncin, 'p1');
  const cin = cinL.nq, ncinH = cinL.s;
  const dadc = L.dlat(L.nand(['h_DEC_ADC', 'fd']), 'p1').nq;
  const dsbc = L.dlat(L.nand(['h_DEC_SBC', 'fd']), 'p1').nq;
  const sum = L.nor(['h_OP_AND', 'h_OP_OR', 'h_OP_EOR', 'h_OP_SR']);
  const a: string[] = [], na: string[] = [], b: string[] = [], nb: string[] = [], p: string[] = [], np: string[] = [], s: string[] = [], ns: string[] = [];
  for (const i of R8) {
    // input latches: AI from SB or 0, BI from DB, NOT DB or ADL (φ1), held through φ2
    a[i] = `ai${i}`; b[i] = `bi${i}`;
    L.pass('c_SB_AI', `sb[${i}]`, a[i]);
    L.pulldown('c_ZERO_AI', a[i]);
    L.pass('c_DB_BI', `db[${i}]`, b[i]);
    L.pass('c_NDB_BI', L.inv(`db[${i}]`), b[i]);
    L.pass('c_ADL_BI', `adl[${i}]`, b[i]);
    L.cap([a[i], b[i]]);
    na[i] = L.inv(a[i]); nb[i] = L.inv(b[i]);
    p[i] = L.xor(a[i], na[i], b[i], nb[i]);
    np[i] = L.inv(p[i]);
  }
  // the adder: a majority gate per bit for the carry; decimal ADC carries into bit 4 (and out) at ≥ 10
  let cy = cin, ncy = ncinH;
  let c4bin = '', c8 = '';
  for (const i of R8) {
    s[i] = L.xor(p[i], np[i], cy, ncy);
    if (i === 7) ns[i] = L.inv(s[i]);
    const nNext = L.aoi([[a[i], b[i]], [a[i], cy], [b[i], cy]]);
    let next = L.inv(nNext), nNextC = nNext;
    if (i === 3) {
      c4bin = next;
      const n4 = L.aoi([[next], [dadc, s[3], s[2]], [dadc, s[3], s[1]]]);
      next = L.inv(n4); nNextC = n4;
    }
    if (i === 7) c8 = next;
    cy = next; ncy = nNextC;
  }
  const nc8d = L.aoi([[c8], [dadc, s[7], s[6]], [dadc, s[7], s[5]]]);
  const c8d = L.inv(nc8d);
  const nsr = L.inv('h_OP_SR');
  L.inv(L.aoi([['h_OP_SR', a[0]], [nsr, c8d]]), 'carry');
  const out: string[] = [];
  for (const i of R8) {
    const up = i < 7 ? a[i + 1] : cin;
    out[i] = L.inv(L.aoi([[sum, s[i]], ['h_OP_AND', a[i], b[i]], ['h_OP_OR', a[i]], ['h_OP_OR', b[i]], ['h_OP_EOR', p[i]], ['h_OP_SR', up]]), i === 7 ? 'out7' : undefined);
  }
  L.nor(out, 'zout');
  const xs = L.xor(s[7], ns[7], a[7], na[7]);
  L.nor([p[7], L.inv(xs)], 'vout');
  // φ2: ADD, the carry (ACR) and the decimal corrections ADD carries to SB
  const add: string[] = [], nadd: string[] = [];
  for (const i of R8) {
    add[i] = `add${i}`;
    L.pass('p2', out[i], add[i]);
    L.cap([add[i]]);
    nadd[i] = L.inv(add[i]);
    L.drive('c_ADD_ADL', nadd[i], `adl[${i}]`);
  }
  L.pass('p2', 'carry', 'acr');
  L.cap(['acr']);
  const corr = (x: string, net: string) => { L.pass('p2', x, net); L.cap([net]); return net; };
  const daaLo = corr(L.and([dadc, L.inv(L.aoi([[c4bin], [dadc, s[3], s[2]], [dadc, s[3], s[1]]]))]), 'daalo');
  const daaHi = corr(L.and([dadc, c8d]), 'daahi');
  const dsaLo = corr(L.and([dsbc, L.inv(c4bin)]), 'dsalo');
  const dsaHi = corr(L.and([dsbc, L.inv(c8)]), 'dsahi');
  // the corrector: +6 (decimal ADC) or +10 (= −6, decimal SBC) per nibble, on the way to SB
  const nibble = (x: number, aa: string, ss: string) => {
    const k1 = L.or([aa, ss]), nk1 = L.inv(k1), nk2 = L.inv(aa), nk3 = L.inv(ss);
    const y1 = L.xor(add[x + 1], nadd[x + 1], k1, nk1);
    const nc2 = L.nand([add[x + 1], k1]), c2 = L.inv(nc2);
    const u = L.xor(add[x + 2], nadd[x + 2], aa, nk2), nu = L.inv(u);
    const y2 = L.xor(u, nu, c2, nc2);
    const nc3 = L.aoi([[add[x + 2], aa], [add[x + 2], c2], [aa, c2]]), c3 = L.inv(nc3);
    const w = L.xor(add[x + 3], nadd[x + 3], ss, nk3), nw = L.inv(w);
    const y3 = L.xor(w, nw, c3, nc3);
    L.drive('c_ADD_SB', nadd[x], `sb[${x}]`);
    L.drive('c_ADD_SB', L.inv(y1), `sb[${x + 1}]`);
    L.drive('c_ADD_SB', L.inv(y2), `sb[${x + 2}]`);
    L.drive('c_ADD_SB', L.inv(y3), `sb[${x + 3}]`);
  };
  nibble(0, daaLo, dsaLo);
  nibble(4, daaHi, dsaHi);
  return L.build({
    id: 'm65_alu', name: '6502 ALU',
    summary: 'Input latches AI (SB or 0) and BI (DB, NOT DB or ADL), an 8-bit ripple adder with decimal carries at ≥ 10, AND / OR / EOR / shift right, the output latch ADD (φ2) driving ADL directly and SB through the decimal corrector.',
    ports: [...['c_SB_AI', 'c_ZERO_AI', 'c_DB_BI', 'c_NDB_BI', 'c_ADL_BI', 'c_ADD_SB', 'c_ADD_ADL', 'h_OP_AND', 'h_OP_OR', 'h_OP_EOR', 'h_OP_SR',
      'h_CIN_1', 'h_CIN_C', 'h_CIN_ACR', 'h_DEC_ADC', 'h_DEC_SBC', 'fc', 'fd', 'p1', 'p2'].map((x) => bit(x)),
    ...busPorts('sb', 'db', 'adl'), bit('carry', 'out'), bit('acr', 'out'), bit('out7', 'out'), bit('zout', 'out'), bit('vout', 'out')],
    symbol: { kind: 'box', label: 'ALU' }, rows: 30,
  });
}

// ---- PC --------------------------------------------------------------------------------------------

export function pcBlock(): ComponentDef {
  const L = new Logic();
  let cy = 'h_PC_INC';
  for (let i = 0; i < 16; i++) {
    const lo = i < 8, j = i & 7, busName = lo ? 'adl' : 'adh';
    // PC select (φ1): the address bus when jumping, else the PC itself; held through φ2
    const pcs = `pcs${i}`, pc = `pc${i}`;
    L.pass(lo ? 'c_ADL_PCL' : 'c_ADH_PCH', `${busName}[${j}]`, pcs);
    L.pass(lo ? 'hold_pcl' : 'hold_pch', `pcr${i}`, pcs);
    L.cap([pcs, pc]);
    const npcs = L.inv(pcs);
    // the incrementer: half adders in a ripple
    const ncy = L.inv(cy);
    const sum = L.xor(pcs, npcs, cy, ncy);
    if (i < 15) cy = L.inv(L.nand([pcs, cy]));
    // the PC (φ2)
    L.pass('p2', sum, pc);
    const npc = L.inv(pc);
    L.inv(npc, `pcr${i}`);
    L.drive(lo ? 'c_PCL_ADL' : 'c_PCH_ADH', npc, `${busName}[${j}]`);
    L.drive(lo ? 'c_PCL_DB' : 'c_PCH_DB', npc, `db[${j}]`);
  }
  return L.build({
    id: 'm65_pc', name: '6502 program counter',
    summary: 'PC select (from ADL / ADH in φ1 on a jump, else the PC), a 16-bit incrementer, the PC loaded in φ2; it drives ADL / ADH (an address) and DB (a push).',
    ports: [...['c_ADL_PCL', 'c_ADH_PCH', 'hold_pcl', 'hold_pch', 'h_PC_INC', 'c_PCL_ADL', 'c_PCH_ADH', 'c_PCL_DB', 'c_PCH_DB', 'p2'].map((x) => bit(x)),
      ...busPorts('adl', 'adh', 'db')],
    symbol: { kind: 'box', label: 'PC' }, rows: 24,
  });
}

// ---- ADDR, DATA ------------------------------------------------------------------------------------

export function addrBlock(): ComponentDef {
  const L = new Logic();
  for (let i = 0; i < 16; i++) {
    const lo = i < 8, j = i & 7;
    L.pass(lo ? 'c_ADL_ABL' : 'c_ADH_ABH', `${lo ? 'adl' : 'adh'}[${j}]`, `q${i}`);
    L.cell(`q${i}`, 'p2', L.net(), `a[${i}]`);
  }
  return L.build({
    id: 'm65_addr', name: '6502 address register',
    summary: 'ABL / ABH: loaded from ADL / ADH in φ1, refreshed in φ2, driving the address pins A0 … A15 for the whole cycle.',
    ports: [bit('c_ADL_ABL'), bit('c_ADH_ABH'), bit('p2'), ...busPorts('adl', 'adh'), bus('a', 16, 'out')],
    symbol: { kind: 'box', label: 'ABH / ABL' }, rows: 16,
  });
}

export function dataBlock(): ComponentDef {
  const L = new Logic();
  // DL loads the pins in φ2 of a read cycle (unless held), refreshed in φ1
  const dlq = L.nor(['np2', 'h_WRITE', 'h_DL_HOLD']);
  const nwq = L.nand(['p2', 'h_WRITE']);
  for (const i of R8) {
    const din = L.inv(L.inv(`d[${i}]`), `din[${i}]`);
    L.pass(dlq, din, `dl${i}`);
    const { nq } = L.cell(`dl${i}`, 'p1');
    L.drive('c_DL_DB', nq, `db[${i}]`);
    L.drive('c_DL_ADL', nq, `adl[${i}]`);
    L.drive('c_DL_ADH', nq, `adh[${i}]`);
    // DOR: loaded from DB in φ1, driven onto the pins in φ2 of a write
    L.pass('c_DB_DOR', `db[${i}]`, `dor${i}`);
    L.cap([`dor${i}`]);
    const ndor = L.inv(`dor${i}`);
    L.pullup(L.nor([ndor, nwq]), `d[${i}]`);
    L.pulldown(L.nor([`dor${i}`, nwq]), `d[${i}]`);
  }
  return L.build({
    id: 'm65_data', name: '6502 data latches',
    summary: 'DL (the byte read, latched in φ2 and driven onto DB, ADL or ADH) and DOR (the byte to write, from DB in φ1, onto the pins in φ2 of a write cycle, push–pull).',
    ports: [bit('c_DL_DB'), bit('c_DL_ADL'), bit('c_DL_ADH'), bit('c_DB_DOR'), bit('h_WRITE'), bit('h_DL_HOLD'), bit('p1'), bit('p2'), bit('np2'),
      ...busPorts('db', 'adl', 'adh', 'd'), bus('din', 8, 'out')],
    symbol: { kind: 'box', label: 'DL / DOR' }, rows: 16,
  });
}

// ---- FLAGS -----------------------------------------------------------------------------------------

export function flagsBlock(): ComponentDef {
  const L = new Logic();
  const R = (s: Sig) => r(s);
  const dbz = 'dbz';
  const flag = (name: string, terms: string[][], loads: string[]) => {
    const keep = L.nor(loads);
    const next = L.inv(L.aoi([...terms, [keep, `f${name}`]]));
    const { nq } = L.ms(next, 'p1', 'p2', `f${name}`, `nf${name}`);
    return nq;
  };
  const nN = flag('n', [[R('DB_NZ'), 'db[7]'], [R('DB_N'), 'db[7]'], [R('DB_P'), 'db[7]'], [R('ALU_NZ'), 'out7']], [R('DB_NZ'), R('DB_N'), R('DB_P'), R('ALU_NZ')]);
  const nV = flag('v', [[R('DB_V'), 'db[6]'], [R('DB_P'), 'db[6]'], [R('ALU_V'), 'vout']], [R('DB_V'), R('DB_P'), R('V0'), R('ALU_V')]);
  const nD = flag('d', [[R('DB_P'), 'db[3]'], [R('D1')]], [R('DB_P'), R('D0'), R('D1')]);
  const nI = flag('i', [[R('DB_P'), 'db[2]'], [R('I1')]], [R('DB_P'), R('I0'), R('I1')]);
  const nZ = flag('z', [[R('DB_NZ'), dbz], [R('DB_P'), 'db[1]'], [R('ALU_NZ'), 'zout'], [R('ALU_Z'), 'zout']], [R('DB_NZ'), R('DB_P'), R('ALU_NZ'), R('ALU_Z')]);
  const nC = flag('c', [[R('DB_P'), 'db[0]'], [R('C1')], [R('ALU_C'), 'carry']], [R('DB_P'), R('C0'), R('C1'), R('ALU_C')]);
  // P onto DB (a push): bit 4 (B) is 0 in an interrupt sequence, bit 5 always 1
  for (const [k, nf] of [[0, nC], [1, nZ], [2, nI], [3, nD], [6, nV], [7, nN]] as const) L.drive('c_P_DB', nf, `db[${k}]`);
  L.drive('c_P_DB', 'intg', 'db[4]');
  L.inv('fi', 'ni');
  const flags = ['n', 'v', 'd', 'i', 'z', 'c'];
  return L.build({
    id: 'm65_flags', name: '6502 status register',
    summary: 'N V D I Z C, each a master–slave pair whose next value is chosen in φ1: from DB (a load, PLP / RTI), from the ALU, set or cleared, else kept. P is pushed onto DB with B = 0 in an interrupt.',
    ports: [...RAW.slice(0, 15).map((s) => bit(r(s))), bit('c_P_DB'), bit('intg'), bit('out7'), bit('zout'), bit('vout'), bit('carry'), bit('dbz'), bit('p1'), bit('p2'),
      bus('db'), ...flags.map((f) => bit(`f${f}`, 'out')), bit('ni', 'out')],
    symbol: { kind: 'box', label: 'P' }, rows: 16,
  });
}

// ---- BUSES -----------------------------------------------------------------------------------------

export function busesBlock(): ComponentDef {
  const L = new Logic();
  for (const b of ['db', 'sb', 'adl', 'adh']) for (const i of R8) {
    L.pullup('p2', `${b}[${i}]`);
    L.cap([`${b}[${i}]`], 20);
  }
  for (const i of R8) {
    L.pass('c_SB_DB', `sb[${i}]`, `db[${i}]`);
    L.pass('c_SB_ADH', `sb[${i}]`, `adh[${i}]`);
    L.pulldown(i ? 'c_ZO_ADH' : 'c_ZERO_ADH', `adh[${i}]`);
  }
  // vectors on ADL: $FA / $FC / $FE (+1 for the high byte): bit 0 low for the low byte, bit 1 for RESET, bit 2 for NMI
  // DB = 0? (for N Z after a load: Z), read where the bus lives
  L.nor(R8.map((i) => `db[${i}]`), 'dbz');
  L.pulldown('c_VEC_LO', 'adl[0]');
  L.drive('c_VEC', 'resetting', 'adl[1]');
  L.drive('c_VEC', 'vfa', 'adl[2]');
  return L.build({
    id: 'm65_buses', name: '6502 internal buses',
    summary: 'DB, SB, ADL and ADH, each bit precharged to 1 in φ2 so that sources in φ1 only pull bits low; the pass transistors joining SB to DB and to ADH; the constants $00 / $01 on ADH and the interrupt vectors on ADL.',
    ports: [bit('p2'), bit('c_SB_DB'), bit('c_SB_ADH'), bit('c_ZERO_ADH'), bit('c_ZO_ADH'), bit('c_VEC_LO'), bit('c_VEC'), bit('resetting'), bit('vfa'),
      ...busPorts('db', 'sb', 'adl', 'adh'), bit('dbz', 'out')],
    symbol: { kind: 'box', label: 'BUSES' }, rows: 24,
  });
}

// ---- the chip --------------------------------------------------------------------------------------

/** Control lines, from the control unit to the datapath (one bus outside, named lines inside). */
export const CTL_LINES = [...PHI1.map(c), ...HELD.map(h), 'h_PC_INC', 'h_WRITE', ...RAW.slice(0, 15).map(r),
  'hold_pcl', 'hold_pch', 'c_ZO_ADH', 'c_VEC', 'p1', 'p2', 'np2', 'intg', 'resetting', 'vfa'];
/** Status, from the datapath to the control unit: the flags a branch or an interrupt reads, the ALU's carries. */
export const STATUS = ['fn', 'fv', 'fc', 'fz', 'ni', 'carry', 'acr'];

/** The two units' width, and where their buses leave the control unit's bottom and enter the datapath's top. */
const UNIT_W = 30;
const BUS_X: Record<string, number> = { ctl: 6, st: 12, db: 18, din: 24 };

const wire = (L: Logic, name: string, def: ComponentDef, map: Record<string, string> = {}) =>
  L.add(name, def, Object.fromEntries(def.ports.map((p) => [p.name, map[p.name] ?? p.name])));

/** The control unit: clock, IR, timing, decode PLA, interrupts, control lines. */
export function controlUnit(): ComponentDef {
  const L = new Logic();
  wire(L, 'clock', clockBlock());
  wire(L, 'ir', irBlock());
  wire(L, 'timing', timingBlock());
  wire(L, 'decode', decodeBlock());
  wire(L, 'intr', intrBlock());
  wire(L, 'control', controlBlock());
  return L.build({
    id: 'm65_ctrl', name: '6502 control unit',
    summary: 'Clock, instruction register, T-state timing, the decode PLA, interrupts, and the control lines they drive into the datapath.',
    ports: [bit('phi0'), bit('resb'), bit('irqb'), bit('nmib'), { ...bus('st', STATUS.length, 'in'), side: 'bottom' }, { ...bus('db', 8, 'in'), side: 'bottom' },
      { ...bus('din', 8, 'in'), side: 'bottom' }, { ...bus('ctl', CTL_LINES.length, 'out'), side: 'bottom' },
      bit('rw', 'out'), bit('sync', 'out'), bit('p1', 'out'), bit('p2', 'out')],
    bits: { st: STATUS, ctl: CTL_LINES },
    symbol: { kind: 'box', label: 'CONTROL UNIT', w: UNIT_W, h: 12, portPos: BUS_X }, rows: 3,
  });
}

/** The datapath: registers, ALU, PC, address and data latches, flags, the four buses. */
export function datapath(): ComponentDef {
  const L = new Logic();
  wire(L, 'rega', regBlock('A', ['sb', 'db']), { ld: 'c_SB_A', rd_sb: 'c_A_SB', rd_db: 'c_A_DB', v: 'va' });
  wire(L, 'regx', regBlock('X', ['sb']), { ld: 'c_SB_X', rd_sb: 'c_X_SB', v: 'vx' });
  wire(L, 'regy', regBlock('Y', ['sb']), { ld: 'c_SB_Y', rd_sb: 'c_Y_SB', v: 'vy' });
  wire(L, 'regs', regBlock('S', ['sb', 'adl']), { ld: 'c_SB_S', rd_sb: 'c_S_SB', rd_adl: 'c_S_ADL', v: 'vs' });
  wire(L, 'alu', aluBlock());
  wire(L, 'flags', flagsBlock());
  wire(L, 'pc', pcBlock());
  wire(L, 'addr', addrBlock());
  wire(L, 'data', dataBlock());
  wire(L, 'buses', busesBlock());
  return L.build({
    id: 'm65_dp', name: '6502 datapath',
    summary: 'A, X, Y, S, the ALU, the status register, the PC, the address register and the data latches, on four precharged buses: DB, SB, ADL, ADH.',
    ports: [{ ...bus('ctl', CTL_LINES.length, 'in'), side: 'top' }, bus('d'), bus('a', 16, 'out'), { ...bus('st', STATUS.length, 'out'), side: 'top' },
      { ...bus('db', 8, 'out'), side: 'top' }, { ...bus('din', 8, 'out'), side: 'top' }],
    bits: { st: STATUS, ctl: CTL_LINES },
    symbol: { kind: 'box', label: 'DATAPATH', w: UNIT_W, h: 8, portPos: BUS_X }, rows: 4,
  });
}

let chip: ComponentDef | undefined;

/**
 * Our 6502 at transistor level, drawn as the die is laid out: the control unit above, the datapath
 * below, the control lines going down between them and the status coming back up.
 */
export function m6502(): ComponentDef {
  if (chip) return chip;
  const ctrl = controlUnit(), dp = datapath();
  const X = 20, YC = 4, YD = 26;
  const pc = (port: string) => symbolGeom(ctrl).ports[port].pos, pd = (port: string) => symbolGeom(dp).ports[port].pos;
  const left = (y: number): [number, number] => [X - 12, y], right = (y: number): [number, number] => [X + UNIT_W + 12, y];
  chip = define({
    id: 'm6502', name: 'MOS 6502 (our transistor-level design)', category: 'cpu',
    summary: 'The 6502 at transistor level: NMOS depletion-load gates, a two-phase clock, precharged buses, a decode PLA. Every block opens down to its transistors.',
    ports: [bit('phi0'), bit('resb'), bit('irqb'), bit('nmib'), bus('d'), bus('a', 16, 'out'), bit('rw', 'out'), bit('sync', 'out'), bit('p1', 'out'), bit('p2', 'out')],
    symbol: { kind: 'box', label: '6502' },
    netlist: () => ({
      level: 'switch',
      pins: {
        ...Object.fromEntries(['phi0', 'resb', 'irqb', 'nmib'].map((p) => [p, left(YC + pc(p)[1])])),
        ...Object.fromEntries(['rw', 'sync', 'p1', 'p2'].map((p) => [p, right(YC + pc(p)[1])])),
        d: left(YD + pd('d')[1]), a: right(YD + pd('a')[1]),
      },
      instances: [{ name: 'ctrl', def: ctrl, at: [X, YC] }, { name: 'dp', def: dp, at: [X, YD] }],
      nets: [
        ...['phi0', 'resb', 'irqb', 'nmib', 'rw', 'sync', 'p1', 'p2'].map((p) => ({ name: p, ends: [p, `ctrl.${p}`] })),
        { name: 'ctl', ends: ['ctrl.ctl', 'dp.ctl'] },
        ...['st', 'db', 'din'].map((b) => ({ name: b, ends: [`dp.${b}`, `ctrl.${b}`] })),
        { name: 'd', ends: ['d', 'dp.d'] }, { name: 'a', ends: ['dp.a', 'a'] },
      ],
    }),
  });
  return chip;
}
