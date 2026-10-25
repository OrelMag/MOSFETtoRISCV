// The warp core of chapter 31: the lane core of chapters 29–30 holding W warps at once, so that a
// load's latency is hidden by running other warps instead of waiting. The golden model is
// riscv/warps.ts (it steps the warp the scheduler issued).
//
//   warp slot     one warp's PC, active mask and split / join stack, whether it runs, and its
//                 scoreboard: a pending bit per register, set when the warp issues a load, cleared
//                 when the load comes back
//   hazard check  the warp's next instruction reads or writes a pending register: not ready
//   scheduler     the round-robin arbiter of chapter 27 over the ready warps; one issues per cycle
//   lanes         as before, with one register bank per warp (the warp number picks the bank)
//   memory        an L-cycle pipeline in front of a memory with a port per lane (chapter 32 turns
//                 that into one port and a coalescer); a returning load writes its warp's bank, so
//                 that warp sits out the cycle (one write port per bank)

import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, NetDef, PortDef } from '../sim/types';
import { alu, constWord, isZero } from './alu';
import { Builder } from './builder';
import { magComparator, popcount } from './coding';
import { busMux2, decoder, equal, incrementer, muxTree } from './combinational';
import { CLEAR_BIT0, CONTROL, IMM_GEN, NEXT_PC, PLUS4_FAST, rom } from './cpu';
import { define, merger, ones, splitter } from './define';
import { fanout, koggeStone } from './fastadd';
import { treeMul } from './muldiv';
import { AND, NOT, OR } from './gates';
import { lowestOne, onehotMux, simtControl } from './lanes';
import { arbiterN } from './mpdecode';
import { regfile } from './regfile';
import { register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { type At, Placer } from './placer';
import { accessUnit, lsuMemory } from './warpmem';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', clock?: boolean): PortDef => ({ name, width: 1, dir, ...(clock ? { clock } : {}) });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkPort = (): PortDef => ({ name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}
const log2 = (n: number) => Math.round(Math.log2(n));
/** Bits of a warp number (at least 1, so a one-warp core still has the port). */
const wbits = (W: number) => Math.max(1, log2(W));
const checkWarps = (W: number) => { if (![1, 2, 4, 8].includes(W)) throw new Error('warps: 1, 2, 4 or 8'); };

function edgePins(b: Builder, ins: string[], outs: string[], pitch = 3): Record<string, [number, number]> {
  const pins: Record<string, [number, number]> = {};
  ins.forEach((p, i) => (pins[p] = [0, 2 + pitch * i]));
  outs.forEach((p, i) => (pins[p] = [b.right, 2 + pitch * i]));
  return pins;
}

/** OR of the bits of a bus. */
function anyOf(b: Builder, d: string, n: number, label?: string, name?: string): string {
  if (n === 1) return d;
  const s = b.op(splitter(ones(n)), [d]);
  return b.op1(orN(n), Array.from({ length: n }, (_, i) => `${s}.o${i}`), label, name);
}

// ---- decode ------------------------------------------------------------------------------------

/** What the warp decoder says: [isTmc, isWspawn, isSplit, isJoin, isPred, isCsr, csrSel, csrS]. */
export function warpDecodeSpec(n: number, W: number, [op, f3, rs1, csr, mask, warp]: number[]): number[] {
  const simt = op === 0b0001011, csrOk = op === 0b1110011 && f3 === 2 && rs1 === 0 && csr >= 0xcc0 && csr <= 0xcc5;
  const lo = csr & 7;
  // csrS by the low bits: bit 2 picks tmask / nwarps (bit 0) or warp / nlanes (bit 1); lane and tid (csrSel) ignore it
  const shared = lo & 4 ? (lo & 1 ? W : mask) : lo & 2 ? n : warp;
  return [+(simt && f3 === 0), +(simt && f3 === 1), +(simt && f3 === 2), +(simt && f3 === 3), +(simt && f3 === 5), +csrOk,
    (lo === 0 ? 1 : 0) | (lo === 3 ? 2 : 0), csrOk ? shared : 0];
}

/** The SIMT decoder of the warp cores: wspawn too, and the CSRs warp (the issuing warp) and nwarps (0xCC5). */
export function warpDecode(n: number, W: number): ComponentDef {
  checkWarps(W);
  return memo(`warpdec${n}_${W}`, () => {
    const wb = wbits(W);
    const b = new Builder(16);
    const ins = ['op', 'funct3', 'rs1', 'csr', 'mask', 'warp'];
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
    // lane CSRs are 0xCC0–0xCC5: not 6, 7
    const ok = b.op1(NOT, [b.op1(OR, [`${ld}.y6`, `${ld}.y7`], undefined, 'hi')], undefined, 'ok');
    const sl = b.op(splitter([1, 1, 1]), [`${sc}.o0`], undefined, 'sl');
    const wz = b.op1(merger([wb, 32 - wb]), ['warp', b.op1(constWord(32 - wb, 0), [], undefined, 'wz0')], 'warp', 'wz');
    const tmask = b.op1(merger([n, 32 - n]), ['mask', b.op1(constWord(32 - n, 0), [], undefined, 'hiZ')], 'tmask', 'tm');
    b.next();
    const isCsr = b.op1(AND, [b.op1(AND, [b.op1(AND, [eY, e2], undefined, 'a1'), b.op1(AND, [z1, eH], undefined, 'a2')], undefined, 'a3'), ok], 'lane CSR read', 'isCsrG');
    const sel = b.op1(merger([1, 1]), [`${ld}.y0`, `${ld}.y3`], 'lane / tid', 'sel');
    // lo 1 warp, 2 nlanes (bit 1), 4 tmask, 5 nwarps (bit 0), bit 2 between the two pairs
    const m1 = b.op1(busMux2(32), [wz, b.op1(constWord(32, n), [], undefined, 'kN'), `${sl}.o1`], 'warp / nlanes', 'm1');
    const m3 = b.op1(busMux2(32), [tmask, b.op1(constWord(32, W), [], undefined, 'kW'), `${sl}.o0`], 'tmask / nwarps', 'm3');
    b.next();
    const m2 = b.op1(busMux2(32), [m1, m3, `${sl}.o2`], undefined, 'm2');
    const csrS = b.op1(bitwise('and', 32), [m2, b.op1(fanout(32), [isCsr], undefined, 'fC')], 'only for a CSR read', 'csrS');
    const outs: [string, string][] = [['isTmc', `${fd}.y0`], ['isWspawn', `${fd}.y1`], ['isSplit', `${fd}.y2`], ['isJoin', `${fd}.y3`], ['isPred', `${fd}.y5`],
      ['isCsr', isCsr], ['csrSel', sel], ['csrS', csrS]];
    for (const [p, d] of outs) b.wire(d, p);
    const pins = edgePins(b, ins, outs.map(([p]) => p));
    return define({
      id: `warpdec${n}_${W}`, name: 'SIMT decoder (warps)', category: 'cpu',
      summary: 'custom-0 (0001011): funct3 picks tmc (0), wspawn (1), split (2), join (3), pred (5). csrr rd, 0xCC0–0xCC5 reads a lane CSR: lane and tid differ per lane (csrSel); warp (the issuing warp), nlanes, tmask and nwarps are shared (csrS).',
      ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('rs1', 5, 'in'), bus('csr', 12, 'in'), bus('mask', n, 'in'), bus('warp', wb, 'in'),
        bit('isTmc', 'out'), bit('isWspawn', 'out'), bit('isSplit', 'out'), bit('isJoin', 'out'), bit('isPred', 'out'), bit('isCsr', 'out'), bus('csrSel', 2, 'out'), bus('csrS', 32, 'out')],
      symbol: { kind: 'box', label: 'WARP DECODE' },
      spec: (v) => warpDecodeSpec(n, W, v),
      netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- scoreboard and hazard -----------------------------------------------------------------------

/** Which registers an instruction reads (rs1, rs2) and writes (rd), by its opcode; amo: amoadd.w exists (it reads rs2). */
export function regUse(instr: number, amo = false): { rs1: boolean; rs2: boolean; rd: boolean } {
  const op = instr & 0x7f;
  const LUI = 0x37, AUIPC = 0x17, JAL = 0x6f, BR = 0x63, ST = 0x23, OP = 0x33, SIMT = 0x0b, AMO = 0x2f;
  return { rs1: op !== LUI && op !== AUIPC && op !== JAL, rs2: op === BR || op === ST || op === OP || op === SIMT || (amo && op === AMO), rd: op !== BR && op !== ST && op !== SIMT };
}

/** The hazard a warp's next instruction has with its scoreboard: it uses a register still pending. */
export function hazardSpec(instr: number, pending: number, amo = false): number {
  const u = regUse(instr, amo), p = (r: number) => (pending >>> r) & 1;
  return (u.rs1 && p((instr >>> 15) & 31)) || (u.rs2 && p((instr >>> 20) & 31)) || (u.rd && p((instr >>> 7) & 31)) ? 1 : 0;
}

/** The scoreboard check; amo: chapter 32's, where amoadd.w reads rs2 too. */
export function sbCheck(amo: boolean): ComponentDef {
  return memo(`warphazard${amo ? '_a' : ''}`, () => {
    const b = new Builder(16);
    b.pins('instr', 'pending');
    const f = b.op(splitter([7, 5, 3, 5, 5, 7]), ['instr'], 'fields', 'f');
    const pb = b.op(splitter(ones(32)), ['pending'], 'pending bits', 'pb');
    b.next();
    const is = (code: number, name: string) => b.op1(equal(7), [`${f}.o0`, b.op1(constWord(7, code), [], undefined, `k${name}`)], `${name}?`, `e${name}`);
    const lui = is(0x37, 'lui'), auipc = is(0x17, 'auipc'), jal = is(0x6f, 'jal'), br = is(0x63, 'branch'), st = is(0x23, 'store'), op = is(0x33, 'op'), simt = is(0x0b, 'simt');
    const r2 = [br, st, op, simt, ...(amo ? [is(0x2f, 'amo')] : [])];
    const read = (fld: string, name: string) => {
      const m = b.add(muxTree(5, 1), `pending[${name}]`, `p${name}`);
      for (let i = 0; i < 32; i++) b.wire(`${pb}.o${i}`, `${m}.d${i}`);
      b.wire(fld, `${m}.s`);
      return `${m}.y`;
    };
    const p1 = read(`${f}.o3`, 'rs1'), p2 = read(`${f}.o4`, 'rs2'), pd = read(`${f}.o1`, 'rd');
    b.next();
    const u1 = b.op1(NOT, [b.op1(orN(3), [lui, auipc, jal], undefined, 'nr1')], 'reads rs1', 'u1');
    const u2 = b.op1(orN(r2.length), r2, 'reads rs2', 'u2');
    const ud = b.op1(NOT, [b.op1(orN(3), [br, st, simt], undefined, 'nrd')], 'writes rd', 'ud');
    b.next();
    const h = b.op1(orN(3), [b.op1(AND, [u1, p1], undefined, 'h1'), b.op1(AND, [u2, p2], undefined, 'h2'), b.op1(AND, [ud, pd], undefined, 'h3')], 'hazard', 'hz');
    b.wire(h, 'hazard');
    return define({
      id: `warphazard${amo ? '_a' : ''}`, name: 'Scoreboard check', category: 'cpu',
      summary: 'Is the next instruction safe to issue? Its opcode says whether it reads rs1 and rs2 and writes rd; a 32:1 multiplexer per field reads that register\'s pending bit. Any pending register in use: the warp waits (a value still on its way from memory, or a register a load is about to overwrite).',
      ports: [bus('instr', 32, 'in'), bus('pending', 32, 'in'), bit('hazard', 'out')],
      symbol: { kind: 'box', label: 'SCOREBOARD CHECK' },
      spec: ([instr, pending]) => [hazardSpec(instr, pending, amo)],
      netlist: () => ({ pins: edgePins(b, ['instr', 'pending'], ['hazard'], 4), instances: b.instances, nets: b.nets() }),
    });
  });
}

export const SB_CHECK = sbCheck(false);

/** A pending bit per register: set rd when a load issues, clear it when the load comes back (set wins). */
export const SCOREBOARD: ComponentDef = (() => {
  const b = new Builder(16);
  b.pins('set', 'setEn', 'clr', 'clrEn', 'clk');
  const r = b.add(register(32), 'pending', 'r');
  b.wire('clk', `${r}.clk`);
  b.wire(b.op1(TIE1, [], undefined, 'one'), `${r}.en`);
  b.next();
  const ds = b.op(decoder(5, true), ['set', 'setEn'], 'set', 'ds');
  const dc = b.op(decoder(5, true), ['clr', 'clrEn'], 'clear', 'dc');
  b.next();
  const S = b.op1(merger(ones(32)), Array.from({ length: 32 }, (_, i) => `${ds}.y${i}`), undefined, 'S');
  const C = b.op1(merger(ones(32)), Array.from({ length: 32 }, (_, i) => `${dc}.y${i}`), undefined, 'C');
  b.next();
  const keep = b.op1(bitwise('and', 32), [`${r}.q`, b.op1(bitwise('xor', 32), [C, b.op1(constWord(32, 0xffffffff), [], undefined, 'k1')], 'not cleared', 'nC')], 'kept', 'keep');
  b.next();
  const d = b.op1(bitwise('or', 32), [keep, S], 'next', 'nx');
  b.wire(d, `${r}.d`);
  b.wire(`${r}.q`, 'pending');
  return define({
    id: 'warpsb', name: 'Scoreboard', category: 'cpu',
    summary: 'One pending bit per register of a warp. A load sets its rd\'s bit when it issues; the bit clears the cycle its value is written back. A load that issues while another to the same register returns keeps the bit set.',
    ports: [bus('set', 5, 'in'), bit('setEn', 'in'), bus('clr', 5, 'in'), bit('clrEn', 'in'), clkPort(), bus('pending', 32, 'out')],
    symbol: { kind: 'box', label: 'SCOREBOARD' },
    netlist: () => ({ pins: edgePins(b, ['set', 'setEn', 'clr', 'clrEn', 'clk'], ['pending'], 4), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- one warp's state ----------------------------------------------------------------------------

/**
 * One warp: its PC, the SIMT control of chapter 30 (mask and stack), whether it runs, and its
 * scoreboard. issue: the scheduler picked it (its PC, mask and stack move); spawn: wspawn starts it
 * at spawnPc with every lane active. It stops running after an instruction that jumps to itself or
 * empties its mask. first: warp 0, running from power-on (its started bit is stored inverted).
 */
export function warpSlot(n: number, first: boolean): ComponentDef {
  return memo(`warpslot${n}${first ? '_0' : ''}`, () => {
    const ins = ['issue', 'spawn', 'spawnPc', 'nextPc', 'isTmc', 'isSplit', 'isJoin', 'isPred', 'pred', 'leadA', 'leadB', 'pcPlus4', 'setRd', 'setEn', 'clrRd', 'clrEn', 'clk'];
    const b = new Builder(20, 22);
    b.pins(...ins);
    const pcr = b.add(register(32), 'PC', 'pc');
    const st = b.add(register(2), 'started, done', 'st');
    for (const r of [pcr, st]) b.wire('clk', `${r}.clk`);
    b.wire(b.op1(TIE1, [], undefined, 'one'), `${st}.en`);
    const sb = b.add(SCOREBOARD, 'scoreboard', 'sb');
    for (const p of ['setEn', 'clrEn', 'clk']) b.wire(p, `${sb}.${p}`);
    b.wire('setRd', `${sb}.set`); b.wire('clrRd', `${sb}.clr`);
    b.next();
    // the SIMT control sees only this warp's instructions; spawn loads its mask with every lane (tmc of all ones)
    const g = (p: string, nm: string) => b.op1(AND, ['issue', p], undefined, nm);
    const tmc = b.op1(OR, [g('isTmc', 'gTmc'), 'spawn'], 'tmc or spawn', 'tmc');
    const lA = b.op1(busMux2(32), ['leadA', b.op1(constWord(32, 0xffffffff), [], undefined, 'all'), 'spawn'], undefined, 'lA');
    const sc = b.add(simtControl(n), 'mask and stack', 'simt');
    for (const [p, d] of [['isTmc', tmc], ['isSplit', g('isSplit', 'gSplit')], ['isJoin', g('isJoin', 'gJoin')], ['isPred', g('isPred', 'gPred')], ['pred', 'pred'], ['leadA', lA], ['leadB', 'leadB'], ['pcPlus4', 'pcPlus4'], ['clk', 'clk']]) b.wire(d, `${sc}.${p}`);
    const ss = b.op(splitter([1, 1]), [`${st}.q`], undefined, 'ss');
    b.next();
    // next PC: the shared next-PC logic's, the join's resume address, or the spawn address
    const fin = b.op1(busMux2(32), ['nextPc', `${sc}.jpc`, `${sc}.jump`], 'join?', 'fin');
    b.next();
    b.wire(b.op1(busMux2(32), [fin, 'spawnPc', 'spawn'], 'spawn?', 'pcd'), `${pcr}.d`);
    b.wire(b.op1(OR, ['issue', 'spawn'], undefined, 'pcen'), `${pcr}.en`);
    const self = b.op1(AND, ['issue', b.op1(equal(32), [fin, `${pcr}.q`], 'jumps to itself', 'eqs')], 'finished', 'self');
    const started = first ? b.op1(NOT, [`${ss}.o0`], 'started (stored inverted)', 'stv') : `${ss}.o0`;
    b.next();
    const ns = b.op1(OR, [started, 'spawn'], undefined, 'ns');
    const nd = b.op1(AND, [b.op1(OR, [`${ss}.o1`, self], undefined, 'dd'), b.op1(NOT, ['spawn'], undefined, 'nsp')], undefined, 'nd');
    const any = anyOf(b, `${sc}.mask`, n, 'some lane active', 'any');
    b.next();
    b.wire(b.op1(merger([1, 1]), [first ? b.op1(NOT, [ns], undefined, 'nsi') : ns, nd], undefined, 'std'), `${st}.d`);
    const run = b.op1(AND, [b.op1(AND, [started, b.op1(NOT, [`${ss}.o1`], undefined, 'ndn')], undefined, 'r1'), any], 'runs', 'run');
    b.wire(`${pcr}.q`, 'pc'); b.wire(`${sc}.mask`, 'mask'); b.wire(run, 'run'); b.wire(`${sb}.pending`, 'pending');
    const pins = edgePins(b, ins, ['pc', 'mask', 'run', 'pending']);
    return define({
      id: `warpslot${n}${first ? '_0' : ''}`, name: first ? 'Warp 0' : 'Warp', category: 'cpu',
      summary: `One resident warp: its PC, its active mask and split / join stack (chapter 30), whether it runs, and its scoreboard. Only the warp the scheduler issues moves; wspawn starts the warp at spawnPc with all ${n} lanes active. It stops after an instruction that jumps to itself or turns every lane off.${first ? ' Warp 0 runs from power-on.' : ''}`,
      ports: [bit('issue', 'in'), bit('spawn', 'in'), bus('spawnPc', 32, 'in'), bus('nextPc', 32, 'in'), bit('isTmc', 'in'), bit('isSplit', 'in'), bit('isJoin', 'in'), bit('isPred', 'in'),
        bus('pred', n, 'in'), bus('leadA', 32, 'in'), bus('leadB', 32, 'in'), bus('pcPlus4', 32, 'in'), bus('setRd', 5, 'in'), bit('setEn', 'in'), bus('clrRd', 5, 'in'), bit('clrEn', 'in'), clkPort(),
        bus('pc', 32, 'out'), bus('mask', n, 'out'), bit('run', 'out'), bus('pending', 32, 'out')],
      symbol: { kind: 'box', label: first ? 'WARP 0' : 'WARP' },
      netlist: () => ({ pins, instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- a lane with a register bank per warp -------------------------------------------------------------

/**
 * One lane of the warp core: chapter 29's lane with W register files, one per warp. The issuing
 * warp's bank is read and written (we); a returning load writes its warp's bank (retEn, retWarp,
 * retRd, retData), never the same bank in the same cycle (the scheduler skips that warp).
 */
export function warpLane(n: number, W: number, mul = false): ComponentDef {
  checkWarps(W);
  const id = `warplane${n}_${W}${mul ? '_m' : ''}`;
  return memo(id, () => {
    const RF = regfile(5, 32), M2 = busMux2(32), M4 = muxTree(2, 32), ALU = alu(32, 'ks');
    const k = log2(n);
    const ins = ['rs1', 'rs2', 'rd', 'warp', 'we', 'pc', 'imm', 'pcPlus4', 'aluSrcA', 'aluSrcB', 'aluCtl', 'resultSrc', 'isCsr', 'csrSel', 'csrS', 'tid', 'retEn', 'retWarp', 'retRd', 'retData', ...(mul ? ['isMul'] : []), 'clk'];
    const outs = ['rd1', 'rd2', 'aluY', 'flags', 'nz'];
    const b = new Builder(22, 20);
    b.pins(...ins);
    const ws = b.op(splitter(ones(W)), ['warp'], undefined, 'ws');
    const rs = b.op(splitter(ones(W)), ['retWarp'], undefined, 'rs');
    b.next();
    const banks = Array.from({ length: W }, (_, w) => {
      const hit = b.op1(AND, ['retEn', `${rs}.o${w}`], undefined, `hit${w}`);
      const we = b.op1(OR, [b.op1(AND, ['we', `${ws}.o${w}`], undefined, `iw${w}`), hit], undefined, `we${w}`);
      return { hit, we };
    });
    b.next();
    const rf = banks.map(({ hit, we }, w) => {
      const r = b.add(RF, `warp ${w} registers`, `rf${w}`);
      b.wire(b.op1(busMux2(5), ['rd', 'retRd', hit], undefined, `wa${w}`), `${r}.wa`);
      for (const [p, q] of [['rs1', 'ra1'], ['rs2', 'ra2'], ['clk', 'clk']]) b.wire(p, `${r}.${q}`);
      b.wire(we, `${r}.we`);
      return r;
    });
    b.next();
    const pick = (port: string, nm: string) => {
      if (W === 1) return `${rf[0]}.${port}`;
      const m = b.add(onehotMux(W, 32), `${port} of the warp`, nm);
      b.wire('warp', `${m}.s`);
      rf.forEach((r, w) => b.wire(`${r}.${port}`, `${m}.d${w}`));
      return `${m}.y`;
    };
    const r1 = b.name(pick('rd1', 'm1'), 'rd1', true), r2 = b.name(pick('rd2', 'm2'), 'rd2', true);
    b.next();
    const srcA = b.op1(M2, [r1, 'pc', 'aluSrcA'], 'SrcA', 'srcA');
    const srcB = b.op1(M2, [r2, 'imm', 'aluSrcB'], 'SrcB', 'srcB');
    const z = b.op1(isZero(32), [r1], 'rs1 = 0?', 'z');
    const lid = b.op(splitter([k, 32 - k]), ['tid'], undefined, 'lid');
    b.next();
    const a = b.add(ALU, 'ALU', 'alu');
    b.wire(srcA, `${a}.a`); b.wire(srcB, `${a}.b`); b.wire('aluCtl', `${a}.ctl`);
    const nz = b.op1(NOT, [z], undefined, 'nzg');
    const lane = b.op1(merger([k, 32 - k]), [`${lid}.o0`, b.op1(constWord(32 - k, 0), [], undefined, 'zhi')], undefined, 'lanev');
    // mul: the low 32 bits of rs1 · rs2 (the same for signed and unsigned operands)
    const y = mul ? b.op1(M2, [`${a}.y`, b.op1(treeMul(32, false, 32), [r1, r2], 'multiplier', 'mul'), 'isMul'], 'ALU / product', 'ym') : `${a}.y`;
    b.next();
    // a load writes nothing now: its word comes back later (retData)
    const gnd = b.op1(constWord(32, 0), [], undefined, 'gnd');
    const res = b.op1(M4, [y, gnd, 'pcPlus4', 'imm', 'resultSrc'], 'result', 'res');
    const csr = b.op1(M4, ['csrS', lane, 'tid', gnd, 'csrSel'], 'CSR', 'csr');
    const fl = b.op1(merger([1, 1, 1, 1]), [`${a}.zero`, `${a}.neg`, `${a}.ovf`, `${a}.carry`], undefined, 'fl');
    b.next();
    const x = b.op1(M2, [res, csr, 'isCsr'], 'result / CSR', 'xres');
    b.next();
    banks.forEach(({ hit }, w) => b.wire(b.op1(M2, [x, 'retData', hit], undefined, `wd${w}`), `${rf[w]}.wd`));
    b.wire(r1, 'rd1'); b.wire(r2, 'rd2'); b.wire(y, 'aluY'); b.wire(fl, 'flags'); b.wire(nz, 'nz');
    return define({
      id, name: 'Lane (warps)', category: 'cpu',
      summary: `One lane of the warp core: ${W} register file${W > 1 ? 's' : ''} of 31 × 32 bits, one per warp (the issuing warp's is read and written), the operand multiplexers, an ALU${mul ? ', a multiplier (mul: the low 32 bits of a Wallace tree)' : ''} and the result multiplexer. A returning load writes its own warp's bank in the same cycle.`,
      ports: [bus('rs1', 5, 'in'), bus('rs2', 5, 'in'), bus('rd', 5, 'in'), bus('warp', W, 'in'), bit('we', 'in'), bus('pc', 32, 'in'), bus('imm', 32, 'in'), bus('pcPlus4', 32, 'in'),
        bit('aluSrcA', 'in'), bit('aluSrcB', 'in'), bus('aluCtl', 4, 'in'), bus('resultSrc', 2, 'in'), bit('isCsr', 'in'), bus('csrSel', 2, 'in'), bus('csrS', 32, 'in'), bus('tid', 32, 'in'),
        bit('retEn', 'in'), bus('retWarp', W, 'in'), bus('retRd', 5, 'in'), bus('retData', 32, 'in'), ...(mul ? [bit('isMul', 'in')] : []), clkPort(),
        bus('rd1', 32, 'out'), bus('rd2', 32, 'out'), bus('aluY', 32, 'out'), bus('flags', 4, 'out'), bit('nz', 'out')],
      symbol: { kind: 'box', label: 'LANE' },
      netlist: () => ({ pins: edgePins(b, ins, outs), instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- memory --------------------------------------------------------------------------------------

/**
 * A data memory of 2^k words with a read and a write port per lane. Reads are combinational; at the
 * clock edge every lane with we writes its word, and when several write one word the highest lane
 * wins (the golden model stores lowest lane first). xport: one more read port (xa → xq) for a reader outside
 * the core (chapter 34's command unit). w: the word width (the campaign's lane benches use 16).
 */
export function lanePortMemory(k: number, n: number, init?: ArrayLike<number>, xport = false, w = 32): ComponentDef {
  if (init && Array.from(init).some((v) => v)) return withInit(lanePortMemory(k, n, undefined, xport, w), init, w);
  const mid = `lpmem${k}_${n}${xport ? 'x' : ''}${w === 32 ? '' : `_w${w}`}`;
  return memo(mid, () => {
    const N = 2 ** k, R = register(w), M2 = busMux2(w);
    const L = Array.from({ length: n }, (_, i) => i);
    const ins = [...L.map((i) => `addr${i}`), ...L.map((i) => `wd${i}`), 'we', ...(xport ? ['xa'] : []), 'clk'];
    // Hand-placed: decoders side by side, then the words in columns of up to 32 rows (a row: the word's
    // write muxes, their OR, its register, so d and en are short wires), then the read trees side by side.
    // Everything between the blocks is a label. (Builder's columns ran 2 · 2^k long wires from a tall
    // column to a short one; rerouting them took minutes, half an hour for 128 words.)
    const b = new Builder(18, 16, 2);
    b.pins(...ins);
    const at = (nm: string, x: number, y: number) => { b.instances.find((u) => u.name === nm)!.at = [x, y]; };
    const wes = b.op(splitter(ones(n)), ['we'], undefined, 'wes');
    const D = decoder(k, true), dw = symbolGeom(D).w + 16;
    const dec = L.map((i) => {
      const d = b.op(D, [`addr${i}`, b.name(`${wes}.o${i}`, `we${i}`, true)], `lane ${i} writes`, `dec${i}`);
      at(d, 36 + i * dw, 2);
      return d;
    });
    const mw = symbolGeom(M2).w, ORn = orN(n), og = symbolGeom(ORn);
    const xOr = (n - 1) * (mw + 6) + (n > 1 ? 2 : 0), xReg = xOr + og.w + 4, pitch = og.h + 7;
    const rows = Math.min(N, 32), colW = xReg + symbolGeom(R).w + 16, x0 = 36 + n * dw;
    const regs = Array.from({ length: N }, (_, w) => {
      const x = x0 + Math.floor(w / rows) * colW, y = 2 + (w % rows) * pitch;
      // Every select is a label: dec0's (into the OR alone) would otherwise cross the whole memory.
      const sel = L.map((i) => b.name(`${dec[i]}.y${w}`, `s${w}_${i}`, true));
      let d = `wd0`;
      for (let i = 1; i < n; i++) {
        d = b.op1(M2, [d, `wd${i}`, sel[i]], undefined, `p${w}_${i}`);
        at(`p${w}_${i}`, x + (i - 1) * (mw + 6), y);
      }
      const en = b.op1(ORn, sel, undefined, `en${w}`);
      at(`en${w}`, x + xOr, y + 4);
      const r = b.add(R, `word ${w}`, `w${w}`);
      at(r, x + xReg, y + 1);
      b.wire(d, `${r}.d`); b.wire(en, `${r}.en`); b.wire('clk', `${r}.clk`);
      return b.name(`${r}.q`, `q${w}`);
    });
    const tree = muxTree(k, w), tw = symbolGeom(tree).w + 14, xTree = x0 + Math.ceil(N / rows) * colW, outs: string[] = [];
    const reader = (nm: string, label: string, s: string, y: string) => {
      const m = b.add(tree, label, nm);
      at(m, xTree + outs.length * tw, 2);
      regs.forEach((q, w) => b.wire(q, `${m}.d${w}`));
      b.wire(s, `${m}.s`);
      b.wire(b.name(`${m}.y`, y, true), y);
      outs.push(y);
    };
    L.forEach((i) => reader(`rd${i}m`, `lane ${i} reads`, `addr${i}`, `rd${i}`));
    if (xport) reader('xqm', 'the outside reader', 'xa', 'xq');
    const xOut = xTree + outs.length * tw + 4;
    return define({
      id: mid, name: `Data memory, a port per lane (${N} words${xport ? ', one more read port' : ''})`, category: 'memory',
      summary: `${N} words of ${w} bits, one read and one write port per lane: every lane reads its own word in the same cycle, and a store writes all of them at once (the highest lane wins a word several write). Real memories do not have ${n} ports; chapter 32 gives them one port and a coalescer.${xport ? ' xa / xq: a read port for a unit outside the core.' : ''}`,
      ports: [...L.map((i) => bus(`addr${i}`, k, 'in')), ...L.map((i) => bus(`wd${i}`, w, 'in')), bus('we', n, 'in'), ...(xport ? [bus('xa', k, 'in')] : []), clkPort(),
        ...outs.map((o) => bus(o, w, 'out'))],
      symbol: { kind: 'box', label: 'DATA MEM' },
      netlist: () => ({ pins: { ...edgePins(b, ins, [], 4), ...Object.fromEntries(outs.map((o, i) => [o, [xOut, 2 + 4 * i]])) }, instances: b.instances, nets: b.nets() }),
    });
  });
}

/** A memory that starts with these words: power-on hints into its words' flip-flops (as editor/memory.ts ramWithInit). */
function withInit(base: ComponentDef, init: ArrayLike<number>, w = 32): ComponentDef {
  const words = Array.from(init, (v) => v >>> 0);
  let h = 2166136261;
  for (const x of words) { h ^= x; h = Math.imul(h, 16777619) >>> 0; }
  return memo(`${base.id}_i${h.toString(16)}`, () => {
    const powerOn: Record<string, 0 | 1> = {};
    words.forEach((v, i) => {
      for (let j = 0; j < w; j++) {
        if (!((v >>> j) & 1)) continue;
        for (const l of ['master', 'slave']) {
          powerOn[`w${i}.ff${j}.ff.${l}.sr.q`] = 1;
          powerOn[`w${i}.ff${j}.ff.${l}.sr.q_n`] = 0;
        }
      }
    });
    return { ...base, id: `${base.id}_i${h.toString(16)}`, powerOn, summary: `${base.summary} Starts with the kernel's data.` };
  });
}

/** Fields of a memory request, low to high. */
const reqFields = (n: number, W: number) => [1, 1, W, 5, n, ...Array(n).fill(32), ...Array(n).fill(32)];

/**
 * The data memory behind an L-cycle pipeline: a request (a warp's load or store, every lane's address
 * and data) enters at issue and reaches the memory L − 1 cycles later, where loads read and stores
 * write; the loaded words go back to the lanes that same cycle (ret*), written at the edge. A warp's
 * own requests stay in order, so its store before a load is seen by the load. xport: the memory's extra read port
 * (xa, a word address → xq), outside the pipeline.
 */
export function memPipe(n: number, W: number, L: number, k: number, init?: ArrayLike<number>, xport = false): ComponentDef {
  checkWarps(W);
  const MEM = lanePortMemory(k, n, init, xport);
  return memo(`mempipe${n}_${W}_${L}_${MEM.id}`, () => {
    const F = reqFields(n, W), P = F.reduce((a, c) => a + c, 0);
    const lanes = Array.from({ length: n }, (_, i) => i);
    const ins = ['ld', 'st', 'warp', 'rd', 'mask', ...lanes.map((i) => `addr${i}`), ...lanes.map((i) => `wd${i}`), ...(xport ? ['xa'] : []), 'clk'];
    const b = new Builder(18, 14);
    b.pins(...ins);
    let req = b.op1(merger(F), ['ld', 'st', 'warp', 'rd', 'mask', ...lanes.map((i) => `addr${i}`), ...lanes.map((i) => `wd${i}`)], 'request', 'req');
    for (let s = 1; s < L; s++) {
      b.next();
      const r = b.add(register(P), `stage ${s}`, `s${s}`);
      b.wire(req, `${r}.d`); b.wire('clk', `${r}.clk`); b.wire(b.op1(TIE1, [], undefined, `one${s}`), `${r}.en`);
      req = `${r}.q`;
    }
    b.next();
    const f = b.op(splitter(F), [req], 'at the memory', 'f');
    const fld = (i: number) => `${f}.o${i}`;
    b.next();
    const mem = b.add(MEM, 'data memory', 'mem');
    lanes.forEach((i) => {
      const a = b.op(splitter([2, k, 30 - k]), [fld(5 + i)], undefined, `a${i}`);
      b.wire(`${a}.o1`, `${mem}.addr${i}`);
      b.wire(fld(5 + n + i), `${mem}.wd${i}`);
    });
    b.wire(b.op1(bitwise('and', n), [fld(4), b.op1(fanout(n), [fld(1)], undefined, 'fst')], 'store lanes', 'swe'), `${mem}.we`);
    b.wire('clk', `${mem}.clk`);
    if (xport) { b.wire('xa', `${mem}.xa`); b.wire(`${mem}.xq`, 'xq'); }
    b.next();
    b.wire(fld(0), 'retValid');
    b.wire(fld(2), 'retWarp');
    b.wire(fld(3), 'retRd');
    b.wire(b.op1(bitwise('and', n), [fld(4), b.op1(fanout(n), [fld(0)], undefined, 'fld')], 'load lanes', 'rmask'), 'retMask');
    lanes.forEach((i) => b.wire(`${mem}.rd${i}`, `retData${i}`));
    const outs = ['retValid', 'retWarp', 'retRd', 'retMask', ...lanes.map((i) => `retData${i}`), ...(xport ? ['xq'] : [])];
    return define({
      id: `mempipe${n}_${W}_${L}_${MEM.id}`, name: `Memory, ${L}-cycle pipeline`, category: 'memory',
      summary: `A load or store enters with its warp, destination register, active lanes, addresses and data, and travels ${L - 1} pipeline registers to the memory: a load issued in cycle t is written back at the end of cycle t + ${L - 1}, so an instruction that needs it can issue in cycle t + ${L}. One request enters per cycle; nothing waits for it.`,
      ports: [bit('ld', 'in'), bit('st', 'in'), bus('warp', W, 'in'), bus('rd', 5, 'in'), bus('mask', n, 'in'), ...lanes.map((i) => bus(`addr${i}`, 32, 'in')), ...lanes.map((i) => bus(`wd${i}`, 32, 'in')), ...(xport ? [bus('xa', k, 'in')] : []), clkPort(),
        bit('retValid', 'out'), bus('retWarp', W, 'out'), bus('retRd', 5, 'out'), bus('retMask', n, 'out'), ...lanes.map((i) => bus(`retData${i}`, 32, 'out')), ...(xport ? [bus('xq', 32, 'out')] : [])],
      symbol: { kind: 'box', label: `MEMORY (${L} CYCLES)` },
      netlist: () => ({ pins: edgePins(b, ins, outs), instances: b.instances, nets: b.nets() }),
    });
  });
}

// ---- chapter 32: amoadd.w, bar, mul -------------------------------------------------------------------

/** [isAmo, isBar, isMul, opInt] for [op, funct3, funct7]: amoadd.w only (funct5 = 0); opInt shows it to CONTROL as lw. */
export function extDecodeSpec([op, f3, f7]: number[]): number[] {
  const amo = op === 0b0101111 && f3 === 2 && f7 >> 2 === 0;
  return [+amo, +(op === 0b0001011 && f3 === 4), +(op === 0b0110011 && f7 === 1), amo ? 0b0000011 : op];
}

export const EXT_DECODE: ComponentDef = (() => {
  const b = new Builder(16);
  b.pins('op', 'funct3', 'funct7');
  const k = (v: number, w: number, nm: string) => b.op1(constWord(w, v), [], undefined, nm);
  const eA = b.op1(equal(7), ['op', k(0b0101111, 7, 'kA')], 'AMO?', 'eA');
  const eS = b.op1(equal(7), ['op', k(0b0001011, 7, 'kS')], 'custom-0?', 'eS');
  const eO = b.op1(equal(7), ['op', k(0b0110011, 7, 'kO')], 'OP?', 'eO');
  const e2 = b.op1(equal(3), ['funct3', k(2, 3, 'k2')], '.w?', 'e2');
  const e4 = b.op1(equal(3), ['funct3', k(4, 3, 'k4')], 'bar?', 'e4');
  const f5 = b.op(splitter([2, 5]), ['funct7'], undefined, 'f5');
  b.next();
  const z5 = b.op1(isZero(5), [`${f5}.o1`], 'funct5 = 0 (add)', 'z5');
  const m1 = b.op1(equal(7), ['funct7', k(1, 7, 'k1')], 'M?', 'm1');
  b.next();
  const amo = b.op1(AND, [b.op1(AND, [eA, e2], undefined, 'a1'), z5], 'amoadd.w', 'amo');
  const bar = b.op1(AND, [eS, e4], 'bar', 'bar');
  const mul = b.op1(AND, [eO, m1], 'mul', 'mul');
  b.next();
  const opInt = b.op1(busMux2(7), ['op', k(0b0000011, 7, 'kL'), amo], 'as lw', 'om');
  for (const [d, p] of [[amo, 'isAmo'], [bar, 'isBar'], [mul, 'isMul'], [opInt, 'opInt']]) b.wire(d, p);
  return define({
    id: 'warpext', name: 'amoadd.w / bar / mul decoder', category: 'cpu',
    summary: 'amoadd.w: opcode 0101111, funct3 = 2, funct5 = 0; it goes to the control unit disguised as lw (it reads memory and writes rd), its address is rs1 (the core zeroes the immediate). bar: custom-0 with funct3 = 4. mul: OP with funct7 = 1 (the lanes keep only the low product, so no other M instruction).',
    ports: [bus('op', 7, 'in'), bus('funct3', 3, 'in'), bus('funct7', 7, 'in'), bit('isAmo', 'out'), bit('isBar', 'out'), bit('isMul', 'out'), bus('opInt', 7, 'out')],
    symbol: { kind: 'box', label: 'AMO / BAR / MUL' },
    spec: extDecodeSpec,
    netlist: () => ({ pins: edgePins(b, ['op', 'funct3', 'funct7'], ['isAmo', 'isBar', 'isMul', 'opInt'], 4), instances: b.instances, nets: b.nets() }),
  });
})();

// ---- the core ------------------------------------------------------------------------------------

export interface WarpCoreOptions {
  warps?: number;
  lanes?: number;
  /** Load latency in cycles (default 8): a dependent instruction issues L cycles after its load. */
  latency?: number;
  /** Data memory of 2^dmemK words (default 6). */
  dmemK?: number;
  imemK?: number;
  /** The data memory's initial words (the kernel's input). */
  data?: ArrayLike<number>;
  /**
   * Chapter 32's memory system: one port behind an access unit (lines of global memory, banks of
   * shared memory, one lane per amoadd.w), the issue port held until a memory instruction's last
   * access; bar and amoadd.w.
   */
  lsu?: boolean;
  /** lsu: shared memory of 2^smemK words (default 6) and its latency (default 2). */
  smemK?: number;
  sharedLatency?: number;
  /** lsu: a global access at most every this many cycles (default 1). */
  globalEvery?: number;
  /** Multipliers in the lanes (mul). */
  mul?: boolean;
  /**
   * A port for a unit outside the core (chapter 34's command unit): launch (one cycle, while every warp is done)
   * starts warp 0 again at PC 0 with every lane active, as a dispatch does; xa (a word address) reads the data
   * memory on xq. Not with lsu.
   */
  host?: boolean;
}

/** W warps of n lanes behind one fetch, decode and control; the golden model is WarpISS. */
export function warpCore(program: number[], opts: WarpCoreOptions = {}): ComponentDef {
  const W = opts.warps ?? 4, n = opts.lanes ?? 4, L = opts.latency ?? 8, dk = opts.dmemK ?? 6, ik = opts.imemK ?? 6;
  const lsu = !!opts.lsu, mul = !!opts.mul, host = !!opts.host;
  checkWarps(W);
  if (host && lsu) throw new Error('host: not with lsu');
  // L = 1 would return a load in the cycle it issues: the write-back would feed the scheduler that issued it (a loop)
  if (L < 2) throw new Error('latency: at least 2');
  const IM = rom(program, ik);
  const MP = lsu
    ? lsuMemory({ lanes: n, warps: W, latency: L, sharedLatency: opts.sharedLatency ?? 2, globalEvery: opts.globalEvery ?? 1, k: dk, ks: opts.smemK ?? 6, init: opts.data })
    : memPipe(n, W, L, dk, opts.data, host);
  const id = `warpcore${W}x${n}${mul ? 'm' : ''}${host ? 'h' : ''}_${MP.id}_${IM.id}`;
  return memo(id, () => {
    const wb = wbits(W), k = log2(n);
    const Ws = Array.from({ length: W }, (_, w) => w), Ls = Array.from({ length: n }, (_, i) => i);
    const b = new Builder(14, 20);
    b.pins('clk', ...(host ? ['launch', 'xa'] : []));
    // the warps, their next instructions, and which may issue
    const slots = Ws.map((w) => b.add(warpSlot(n, w === 0), `warp ${w}`, `warp${w}`));
    for (const s of slots) b.wire('clk', `${s}.clk`);
    // lsu: the warps waiting at the barrier, the memory instruction holding the issue port (its warp, its lanes left)
    const atBar = lsu ? b.add(register(W), 'at the barrier', 'atBar') : '';
    const heldW = lsu ? b.add(register(W), 'holding the port', 'heldW') : '';
    const left = lsu ? b.add(register(n), 'lanes left', 'left') : '';
    for (const r of [atBar, heldW, left].filter(Boolean)) { b.wire('clk', `${r}.clk`); b.wire(b.op1(TIE1, [], undefined, `${r}On`), `${r}.en`); }
    b.next();
    const ims = Ws.map((w) => b.name(b.op1(IM, [`${slots[w]}.pc`], `program (warp ${w})`, `im${w}`), `instr${w}`, true));
    b.next();
    const hz = Ws.map((w) => b.op1(sbCheck(lsu), [ims[w], `${slots[w]}.pending`], `scoreboard check ${w}`, `hz${w}`));
    const mp = b.add(MP, 'data memory', 'mem');
    b.wire('clk', `${mp}.clk`);
    const rw = b.op(splitter(ones(W)), [`${mp}.retWarp`], undefined, 'rw');
    const ab = lsu ? b.op(splitter(ones(W)), [`${atBar}.q`], undefined, 'ab') : '';
    const hw = lsu ? b.op(splitter(ones(W)), [`${heldW}.q`], undefined, 'hw') : '';
    const held = lsu ? b.name(anyOf(b, `${heldW}.q`, W, 'a memory instruction holds the port', 'heldG'), 'held', true) : '';
    b.next();
    const retHit = Ws.map((w) => b.name(b.op1(AND, [`${mp}.retValid`, `${rw}.o${w}`], undefined, `rh${w}`), `ret${w}`, true));
    const ready = Ws.map((w) => {
      const busy = b.op1(lsu ? orN(3) : OR, [hz[w], retHit[w], ...(lsu ? [`${ab}.o${w}`] : [])], undefined, `bz${w}`);
      return b.name(b.op1(AND, [`${slots[w]}.run`, b.op1(NOT, [busy], undefined, `nb${w}`)], `warp ${w} ready`, `rdy${w}`), `ready${w}`, true);
    });
    b.next();
    // while a memory instruction holds the port, only its warp asks
    const req = lsu ? Ws.map((w) => b.op1(busMux2(1), [ready[w], `${hw}.o${w}`, held], undefined, `rq${w}`)) : ready;
    let grants: string[];
    if (W === 1) grants = [req[0]];
    else {
      const arb = b.add(arbiterN(W), 'scheduler', 'sched');
      req.forEach((r, w) => b.wire(r, `${arb}.r${w}`));
      b.wire('clk', `${arb}.clk`);
      grants = Ws.map((w) => `${arb}.g${w}`);
    }
    grants = grants.map((g, w) => b.name(g, `grant${w}`, true));
    const G = b.name(b.op1(merger(ones(W)), grants, 'issuing warp', 'G'), 'warp', true);
    const issue = b.name(anyOf(b, G, W, 'issue?', 'issueG'), 'issue', true);
    // the issuing warp's number in binary (tid, csrr warp)
    const idx = Array.from({ length: wb }, (_, j) => {
      const src = Ws.filter((w) => (w >> j) & 1).map((w) => grants[w]);
      return src.length === 0 ? b.op1(TIE0, [], undefined, `wi0_${j}`) : src.length === 1 ? src[0] : b.op1(orN(src.length), src, undefined, `wi${j}`);
    });
    const wid = b.name(wb === 1 ? idx[0] : b.op1(merger(ones(wb)), idx, 'warp number', 'wid'), 'warpNum', true);
    b.next();
    const sel = (def: ComponentDef, port: string, label: string, nm: string, src: (w: number) => string) => {
      if (W === 1) return src(0);
      const m = b.add(def, label, nm);
      b.wire(G, `${m}.s`);
      Ws.forEach((w) => b.wire(src(w), `${m}.d${w}`));
      return `${m}.${port}`;
    };
    const pc = b.name(sel(onehotMux(W, 32), 'y', 'its PC', 'pcSel', (w) => `${slots[w]}.pc`), 'PC', true);
    const im = b.name(sel(onehotMux(W, 32), 'y', 'its instruction', 'imSel', (w) => ims[w]), 'Instr', true);
    const mask = b.name(sel(onehotMux(W, n), 'y', 'its mask', 'maskSel', (w) => `${slots[w]}.mask`), 'mask', true);
    const p4 = b.name(b.op1(PLUS4_FAST, [pc], 'PC + 4', 'plus4'), 'PCPlus4', true);
    b.next();
    const si = b.op(splitter([7, 5, 3, 5, 5, 7]), [im], undefined, 'si');
    for (const [o, nm] of [['o0', 'op'], ['o1', 'rd'], ['o2', 'funct3'], ['o3', 'rs1'], ['o4', 'rs2'], ['o5', 'funct7']]) b.name(`${si}.${o}`, nm, true);
    const csrA = b.op1(merger([5, 7]), [`${si}.o4`, `${si}.o5`], 'CSR address', 'csrA');
    const xd = lsu || mul ? b.op(EXT_DECODE, [`${si}.o0`, `${si}.o2`, `${si}.o5`], 'amoadd.w / bar / mul', 'xdec') : '';
    b.next();
    const ctl = b.op(CONTROL, [lsu ? `${xd}.opInt` : `${si}.o0`, `${si}.o2`, `${si}.o5`], 'control', 'ctl');
    const imm0 = b.op(IMM_GEN, [im, `${ctl}.immSrc`], 'immediate', 'imm');
    const sd = b.op(warpDecode(n, W), [`${si}.o0`, `${si}.o2`, `${si}.o3`, csrA, mask, wid], 'warp decode', 'sdec');
    const rs = b.op(splitter([1, 1]), [`${ctl}.resultSrc`], undefined, 'rs');
    // amoadd.w's address is rs1: no offset
    const imm = lsu ? b.op1(bitwise('and', 32), [`${imm0}.imm`, b.op1(fanout(32), [b.op1(NOT, [`${xd}.isAmo`], undefined, 'nAmo')], undefined, 'fA')], 'no offset for amoadd.w', 'immA') : `${imm0}.imm`;
    b.next();
    const isLoad = b.name(b.op1(AND, [`${rs}.o0`, b.op1(NOT, [`${rs}.o1`], undefined, 'nr1')], 'load?', 'isLoad'), 'isLoad', true);
    const rwx = b.op1(OR, [`${ctl}.regWrite`, `${sd}.isCsr`], undefined, 'rwx');
    // written now: everything but a load (its word comes back later)
    const wNow = b.op1(AND, [b.op1(AND, [rwx, b.op1(NOT, [isLoad], undefined, 'nld')], undefined, 'wn'), issue], 'writes now', 'wNow');
    const rdNz = b.op1(NOT, [b.op1(isZero(5), [`${si}.o1`], undefined, 'rdz')], 'rd ≠ x0', 'rdNz');
    b.next();
    const ldIss = b.name(b.op1(AND, [b.op1(AND, [isLoad, issue], undefined, 'li1'), rdNz], 'a load issues', 'ldIss'), 'loadIssue', true);
    const weS = b.op(splitter(ones(n)), [b.op1(bitwise('and', n), [mask, b.op1(fanout(n), [wNow], undefined, 'fw')], 'lanes writing', 'weN')], undefined, 'weS');
    const lead = b.op(lowestOne(n), [mask], 'leader', 'lead');
    b.next();
    // the lanes
    const lanes = Ls.map((i) => b.add(warpLane(n, W, mul), `lane ${i}`, `lane${i}`));
    const rm = b.op(splitter(ones(n)), [`${mp}.retMask`], undefined, 'rm');
    lanes.forEach((l, i) => {
      const tid = b.op1(merger([k, wb, 32 - k - wb]), [b.op1(constWord(k, i), [], undefined, `ln${i}`), wid, b.op1(constWord(32 - k - wb, 0), [], undefined, `tz${i}`)], `tid ${i}`, `tid${i}`);
      const w: [string, string][] = [
        [`${si}.o3`, 'rs1'], [`${si}.o4`, 'rs2'], [`${si}.o1`, 'rd'], [G, 'warp'], [`${weS}.o${i}`, 'we'], [pc, 'pc'], [imm, 'imm'], [p4, 'pcPlus4'],
        [`${ctl}.aluSrcA`, 'aluSrcA'], [`${ctl}.aluSrcB`, 'aluSrcB'], [`${ctl}.aluCtl`, 'aluCtl'], [`${ctl}.resultSrc`, 'resultSrc'],
        [`${sd}.isCsr`, 'isCsr'], [`${sd}.csrSel`, 'csrSel'], [`${sd}.csrS`, 'csrS'], [tid, 'tid'],
        [`${rm}.o${i}`, 'retEn'], [`${mp}.retWarp`, 'retWarp'], [`${mp}.retRd`, 'retRd'], [`${mp}.retData${i}`, 'retData'], ['clk', 'clk'],
        ...(mul ? [[`${xd}.isMul`, 'isMul'] as [string, string]] : []),
      ];
      for (const [d, p] of w) b.wire(d, `${l}.${p}`);
    });
    b.next();
    // the leader's values, the split predicate
    const OH = onehotMux(n, 32), OF = onehotMux(n, 4);
    const lsel = (label: string, nm: string, def: ComponentDef, port: string) => {
      const m = b.add(def, label, nm);
      b.wire(`${lead}.y`, `${m}.s`);
      lanes.forEach((l, i) => b.wire(`${l}.${port}`, `${m}.d${i}`));
      return `${m}.y`;
    };
    const lAlu = lsel('leader ALU', 'lAlu', OH, 'aluY'), lA = lsel('leader rs1', 'lA', OH, 'rd1'), lB = lsel('leader rs2', 'lB', OH, 'rd2'), lF = lsel('leader flags', 'lF', OF, 'flags');
    const pm = b.op1(merger(ones(n)), lanes.map((l) => `${l}.nz`), 'rs1 ≠ 0', 'pm');
    // lsu: the memory instruction's accesses. The lanes left (all active ones at first) go to the access unit; an access
    // that must wait (shared: its slot is taken; global: one started too recently) serves none
    let done = '', served = '', shared = '';
    if (lsu) {
      const memop = b.name(b.op1(AND, [b.op1(OR, [isLoad, `${ctl}.memWrite`], undefined, 'mo'), issue], 'a memory instruction', 'memop'), 'memop', true);
      const todo = b.op1(busMux2(n), [mask, `${left}.q`, held], 'lanes to serve', 'todo');
      const acc = b.op(accessUnit(n), [todo, `${xd}.isAmo`, ...lanes.map((l) => `${l}.aluY`)], 'access unit', 'acc');
      b.next();
      shared = b.name(`${acc}.shared`, 'sharedAcc', true);
      const wait = b.op1(OR, [b.op1(AND, [shared, `${mp}.slotBusy`], undefined, 'wS'), b.op1(AND, [b.op1(NOT, [shared], undefined, 'nShA'), `${mp}.globalBusy`], undefined, 'wG')], 'must wait', 'wait');
      const go = b.op1(AND, [memop, b.op1(NOT, [wait], undefined, 'nWait')], 'access now', 'go');
      b.next();
      served = b.name(b.op1(bitwise('and', n), [`${acc}.serve`, b.op1(fanout(n), [go], undefined, 'fGo')], 'served', 'srv'), 'served', true);
      const rest = b.op1(bitwise('and', n), [todo, b.op1(bitwise('xor', n), [served, b.op1(constWord(n, 2 ** n - 1), [], undefined, 'allN')], undefined, 'nSrv')], 'still to serve', 'rest');
      b.next();
      done = b.name(b.op1(OR, [b.op1(NOT, [memop], undefined, 'nMo'), b.op1(isZero(n), [rest], undefined, 'restZ')], 'instruction done', 'doneG'), 'done', true);
      b.wire(rest, `${left}.d`);
      b.wire(b.op1(bitwise('and', W), [G, b.op1(fanout(W), [b.op1(AND, [memop, b.op1(NOT, [done], undefined, 'nDone')], undefined, 'hold')], undefined, 'fH')], 'held next', 'heldN'), `${heldW}.d`);
      // bar: wait until rs2 warps have arrived (this one included); the last arrival releases them all
      const barGo = b.op1(AND, [`${xd}.isBar`, issue], 'bar issues', 'barGo');
      const arrived = W === 1 ? b.op1(constWord(2, 1), [], undefined, 'arr1')
        : b.op1(incrementer(wb + 1), [b.op1(popcount(W), [`${atBar}.q`], 'waiting', 'nWait2')], 'arrived', 'arr');
      b.next();
      const more = b.op(magComparator(32), [lB, b.op1(merger([wb + 1, 31 - wb]), [arrived, b.op1(constWord(31 - wb, 0), [], undefined, 'arrZ')], undefined, 'arrW')], 'rs2 > arrived?', 'barCmp');
      const release = b.name(b.op1(AND, [barGo, b.op1(NOT, [`${more}.gt`], undefined, 'enough')], 'release', 'release'), 'release', true);
      b.next();
      const joinB = b.op1(bitwise('or', W), [`${atBar}.q`, b.op1(bitwise('and', W), [G, b.op1(fanout(W), [barGo], undefined, 'fB')], undefined, 'arrives')], undefined, 'barOr');
      b.wire(b.op1(bitwise('and', W), [joinB, b.op1(fanout(W), [b.op1(NOT, [release], undefined, 'nRel')], undefined, 'fR')], 'at the barrier next', 'barN'), `${atBar}.d`);
    }
    b.next();
    // next PC from the leader, shared by the warps (only the issuing one loads it)
    const fs = b.op(splitter([1, 1, 1, 1]), [lF], undefined, 'fs');
    const npc = b.add(NEXT_PC, 'next PC logic', 'npc');
    for (const [p, d] of [['zero', `${fs}.o0`], ['neg', `${fs}.o1`], ['ovf', `${fs}.o2`], ['carry', `${fs}.o3`], ['funct3', `${si}.o2`], ['branch', `${ctl}.branch`], ['jump', `${ctl}.jump`], ['jalr', `${ctl}.jalr`]]) b.wire(d, `${npc}.${p}`);
    const tgt = b.add(koggeStone(32), 'PC + imm', 'target');
    b.wire(pc, `${tgt}.a`); b.wire(imm, `${tgt}.b`); b.wire(b.op1(TIE0, [], undefined, 'gndT'), `${tgt}.cin`);
    const c0 = b.add(CLEAR_BIT0, 'jalr target', 'clr0');
    b.wire(lAlu, `${c0}.in`); b.wire(b.op1(TIE0, [], undefined, 'gndJ'), `${c0}.zero`);
    const pcmux = b.add(muxTree(2, 32), 'next PC', 'pcmux');
    b.wire(`${npc}.pcSrc`, `${pcmux}.s`);
    for (const [d, i] of [[p4, 0], [`${tgt}.s`, 1], [`${c0}.out`, 2], [p4, 3]] as const) b.wire(d, `${pcmux}.d${i}`);
    // wspawn starts warps 1 … rs1 − 1: warp w when rs1 > w (rs1's bits above the warp number, or its low bits above w).
    // A one-warp core has nothing to start, so it has no compare (its decoder's isWspawn goes nowhere)
    let hiNz = '', ld = '', spawnGo = '';
    if (W > 1) {
      const la = b.op(splitter([wb, 32 - wb]), [lA], undefined, 'la');
      hiNz = anyOf(b, `${la}.o1`, 32 - wb, 'rs1 ≥ 2^b', 'hiNz');
      ld = b.op(decoder(wb), [`${la}.o0`], 'rs1, low bits', 'ldec');
      spawnGo = b.op1(AND, [`${sd}.isWspawn`, issue], 'wspawn issues', 'spGo');
    }
    b.next();
    const spawn = Ws.map((w) => {
      if (w === 0) return host ? 'launch' : b.op1(TIE0, [], undefined, 'sp0');
      const above = Ws.filter((j) => j > w).map((j) => `${ld}.y${j}`);
      const gt = b.op1(above.length ? orN(above.length + 1) : OR, [hiNz, ...(above.length ? above : [b.op1(TIE0, [], undefined, `nz${w}`)])], `rs1 > ${w}`, `gt${w}`);
      return b.op1(AND, [spawnGo, gt], `spawn ${w}`, `sp${w}`);
    });
    // every warp's inputs; lsu: a warp moves on only when its instruction is done, and its scoreboard clears on a load's last access
    const rl = lsu ? `${mp}.retLast` : '';
    slots.forEach((s, w) => {
      const wires: [string, string][] = [
        [lsu ? b.op1(AND, [grants[w], done], undefined, `iss${w}`) : grants[w], 'issue'], [spawn[w], 'spawn'], [host && w === 0 ? b.op1(constWord(32, 0), [], undefined, 'pc0') : lB, 'spawnPc'], [`${pcmux}.y`, 'nextPc'], [`${sd}.isTmc`, 'isTmc'], [`${sd}.isSplit`, 'isSplit'], [`${sd}.isJoin`, 'isJoin'],
        [`${sd}.isPred`, 'isPred'], [pm, 'pred'], [lA, 'leadA'], [lB, 'leadB'], [p4, 'pcPlus4'], [`${si}.o1`, 'setRd'], [b.op1(AND, [ldIss, grants[w]], undefined, `se${w}`), 'setEn'],
        [`${mp}.retRd`, 'clrRd'], [lsu ? b.op1(AND, [retHit[w], rl], undefined, `cl${w}`) : retHit[w], 'clrEn'],
      ];
      for (const [d, p] of wires) b.wire(d, `${s}.${p}`);
    });
    // the memory request
    const st = b.op1(AND, [`${ctl}.memWrite`, issue], 'a store issues', 'stIss');
    if (lsu) {
      const amo = b.op1(AND, [`${xd}.isAmo`, issue], 'amoadd.w issues', 'amoIss');
      for (const [d, p] of [[ldIss, 'ret'], [st, 'st'], [amo, 'amo'], [shared, 'shared'], [done, 'last'], [G, 'warp'], [`${si}.o1`, 'rd'], [served, 'serve']] as const) b.wire(d, `${mp}.${p}`);
    } else {
      for (const [d, p] of [[ldIss, 'ld'], [st, 'st'], [G, 'warp'], [`${si}.o1`, 'rd'], [mask, 'mask']] as const) b.wire(d, `${mp}.${p}`);
      if (host) { b.wire('xa', `${mp}.xa`); b.wire(`${mp}.xq`, 'xq'); }
    }
    lanes.forEach((l, i) => { b.wire(`${l}.aluY`, `${mp}.addr${i}`); b.wire(`${l}.rd2`, `${mp}.wd${i}`); });
    b.next();
    const halted = b.op1(NOT, [anyOf(b, b.op1(merger(ones(W)), slots.map((s) => `${s}.run`), undefined, 'runs'), W, 'some warp runs', 'anyRun')], 'every warp done', 'haltedG');
    b.wire(pc, 'pcOut'); b.wire(lsu ? b.op1(AND, [issue, done], undefined, 'retireG') : issue, 'retire'); b.wire(wid, 'warpOut'); b.wire(mask, 'maskOut'); b.wire(halted, 'halted');
    if (lsu) { b.wire(issue, 'issued'); b.wire(served, 'served'); b.wire(shared, 'sharedOut'); b.wire(`${atBar}.q`, 'atBar'); }
    const outs: [string, number][] = [['pcOut', 32], ['retire', 1], ['warpOut', wb], ['maskOut', n], ['halted', 1], ...(lsu ? [['issued', 1], ['served', n], ['sharedOut', 1], ['atBar', W]] as [string, number][] : []),
      ...(host ? [['xq', 32]] as [string, number][] : [])];
    const { pins, nets } = warpCoreDrawing(b, { W, n, lsu, host }, outs.map(([p]) => p));
    return {
      id, name: `Warp core (${W} warp${W > 1 ? 's' : ''} × ${n} lanes)`, category: 'cpu',
      summary: `${W} warp${W > 1 ? 's' : ''} of ${n} lanes share one fetch, decode and control. Every cycle the scheduler issues one ready warp: started, not finished, and its next instruction uses no register still waiting for a load (the scoreboard). Loads take ${L} cycles; while one warp waits, the others run.${lsu ? ' A memory instruction takes one cycle per access (a line of global memory, a set of shared-memory banks, a lane of amoadd.w) and holds the issue port until its last; bar holds a warp until the others arrive.' : ''}`,
      ports: [bit('clk', 'in', true), ...(host ? [bit('launch', 'in'), bus('xa', dk, 'in')] : []), ...outs.map(([p, w]) => w === 1 ? bit(p, 'out') : bus(p, w, 'out'))],
      symbol: { kind: 'box', label: `${W}-WARP CORE` },
      netlist: () => ({ pins, instances: b.instances, nets }),
    } satisfies ComponentDef;
  });
}

// ---- the core's drawing ---------------------------------------------------------------------------

const range = (k: number) => Array.from({ length: k }, (_, i) => i);

/** Nets named after the port that drives them: control signals. */
const BY_PORT = new Set(['ctl', 'sdec', 'xdec', 'npc', 'lead', 'mem', 'acc', 'barCmp']);
/** Names for nets the core's code leaves unnamed (driver end → name). */
function netNames(W: number, n: number, lsu: boolean): Record<string, string> {
  const nm: Record<string, string> = {
    'lead.y': 'leader', 'lAlu.y': 'leadALU', 'lA.y': 'leadA', 'lB.y': 'leadB', 'lF.y': 'leadFlags', 'pm.out': 'pred', 'pcmux.y': 'nextPC', 'target.s': 'PC+imm', 'clr0.out': 'jalrPC',
    'csrA.out': 'csr', 'wNow.y': 'writeNow', 'stIss.y': 'storeIssue', 'amoIss.y': 'amoIssue', 'spGo.y': 'spawnGo', 'hiNz.y': 'rs1Hi', 'sp0.y': 'spawn0',
    'haltedG.y': 'halted', 'retireG.y': 'retired', 'atBar.q': 'atBarQ', 'heldW.q': 'heldW', 'left.q': 'left',
    'barN.y': 'atBarNext', 'heldN.y': 'heldNext', 'rest.y': 'rest', 'todo.y': 'todo', 'wait.y': 'wait', 'go.y': 'go',
    ...(lsu ? { 'imm.imm': 'imm0', 'immA.y': 'imm' } : { 'imm.imm': 'imm' }),
  };
  for (const w of range(W)) Object.assign(nm, {
    [`warp${w}.pc`]: `pc${w}`, [`warp${w}.mask`]: `mask${w}`, [`warp${w}.run`]: `run${w}`, [`warp${w}.pending`]: `pending${w}`,
    [`rw.o${w}`]: `retW${w}`, [`ab.o${w}`]: `bar${w}`, [`hw.o${w}`]: `held${w}`, [`sp${w}.y`]: `spawn${w}`,
    [`se${w}.y`]: `setEn${w}`, [`cl${w}.y`]: `clrEn${w}`, [`iss${w}.y`]: `issue${w}`,
  });
  for (const j of range(W)) nm[`ldec.y${j}`] = `rs1lo=${j}`;
  for (const i of range(n)) Object.assign(nm, { [`weS.o${i}`]: `we${i}`, [`rm.o${i}`]: `retEn${i}`, [`tid${i}.out`]: `tid${i}` });
  return nm;
}

/**
 * The warp core drawn in four bands, top to bottom as an instruction goes: the warps (a row each: its
 * slot, its next instruction from the ROM, the scoreboard check, ready), the scheduler and the issuing
 * warp's PC, instruction and mask; decode and control, wspawn; the lanes side by side, the leader's
 * values and the next PC; the memory system and the returning loads. Wires inside a block, labels
 * between blocks, as on a real schematic. Only positions and labels: instances and connections are the
 * Builder's.
 */
function warpCoreDrawing(b: Builder, { W, n, lsu, host }: { W: number; n: number; lsu: boolean; host: boolean }, outs: string[]): { pins: Record<string, At>; nets: NetDef[] } {
  const P = new Placer(b.instances), raw = b.nets();
  const Ws = range(W), Ls = range(n), wb = Math.max(1, log2(W));
  /** The unnamed splitter of anyOf() feeding this OR. */
  const feeding = (target: string) => raw.find((nt) => /^u\d+\.o0$/.test(nt.ends[0]) && nt.ends.slice(1).some((e) => e.startsWith(`${target}.`)))?.ends[0].split('.')[0] ?? '';
  const wired = new Set<string>(), labelled = new Set<string>(), trunks = new Map<string, number>();
  const wire = (d: string, s: string) => wired.add(`${d}>${s}`);

  // ---- band A: a row per warp, the scheduler, the issuing warp ----
  const RP = 40, rowY = (w: number) => 4 + RP * w, SX = 28, sw = P.w('warp0');
  const imX = SX + sw + 6, hzX = imX + P.w('im0') + 4, hzR = hzX + P.w('hz0');
  for (const w of Ws) {
    const y = rowY(w), s = `warp${w}`;
    P.row('row', `iss${w}`, 'y', 14, y + 2);
    P.row('row', `se${w}`, 'y', 14, y + 28);
    P.row('row', `cl${w}`, 'y', 14, y + 32);
    if (w === 0) P.row('row', 'pc0', 'y', 20, y + 6);
    P.put('row', s, SX, y);
    P.row('row', `im${w}`, 'addr', imX, P.pin(s, 'pc')[1]);
    P.row('row', `hz${w}`, 'instr', hzX, P.pin(s, 'pc')[1]);
    wire(`${s}.pc`, `im${w}.addr`); wire(`im${w}.data`, `hz${w}.instr`);
    P.row('row', `bz${w}`, 0, hzR + 6, P.pin(`hz${w}`, 'hazard')[1]);
    const bo = P.pin(`bz${w}`, P.out(`bz${w}`))[1];
    P.row('row', `nb${w}`, 'a', hzR + 13, bo);
    P.row('row', `rdy${w}`, 'b', hzR + 19, bo);
    P.row('row', `rq${w}`, 'a', hzR + 29, P.pin(`rdy${w}`, 'y')[1]);
  }
  const req = (w: number) => (P.has(`rq${w}`) ? `rq${w}` : `rdy${w}`);
  const rowsR = P.right(req(0));
  let schedR: number;
  if (W > 1) {
    const mid = (rowY(0) + rowY(W - 1)) / 2 + 16;
    P.put('sched', 'sched', rowsR + 10, Math.round(mid - P.h('sched') / 2));
    for (const w of Ws) { wire(`${req(w)}.y`, `sched.r${w}`); wire(`sched.g${w}`, `G.i${w}`); }
    P.row('sched', 'G', 'i0', P.right('sched') + 4, P.pin('sched', 'g0')[1]);
    const u = feeding('issueG');
    P.row('sched', u, 'in', P.right('G') + 4, P.pin('G', 'out')[1]);
    wire('G.out', `${u}.in`);
    P.row('sched', 'issueG', 'i0', P.right(u) + 3, P.pin(u, 'o0')[1]);
    const wis = range(wb).map((j) => (P.has(`wi${j}`) ? `wi${j}` : `wi0_${j}`));
    P.cols('sched', P.x('sched'), P.bottom('sched') + 8, [wis, ['wid']], 6);
    schedR = P.right('issueG');
  } else {
    P.row('sched', 'G', 'i0', rowsR + 6, P.pin(req(0), 'y')[1]);
    wire(`${req(0)}.y`, 'G.i0');
    P.put('sched', 'wi0_0', rowsR + 4, P.bottom('G') + 6);
    schedR = P.right('G');
  }
  const IX = schedR + 14;
  P.put('issue', 'pcSel', IX, 4); P.put('issue', 'imSel', IX, P.bottom('pcSel') + 4); P.put('issue', 'maskSel', IX, P.bottom('imSel') + 4);
  if (W > 1) { P.row('issue', 'plus4', 'a', IX + 20, P.pin('pcSel', 'y')[1]); wire('pcSel.y', 'plus4.a'); }
  else P.put('issue', 'plus4', IX + 4, 7);

  // ---- band B: decode and control, wspawn ----
  const YB = Math.max(rowY(W), P.extent('row', 'sched', 'issue').bottom + 12);
  const DX = 18;
  P.row('dec', 'si', 'in', DX, YB + 21);
  P.row('dec', 'csrA', 'i0', DX + 4, P.pin('si', 'o4')[1]);
  wire('si.o4', 'csrA.i0'); wire('si.o5', 'csrA.i1');
  labelled.add('csrA.out'); // down to the warp decoder: a label, not a wire around the immediate
  const CX = P.has('xdec') ? DX + 42 : DX + 16;
  P.put('dec', 'ctl', CX, YB);
  P.row('dec', 'xdec', 'opInt', DX + 14, P.pin('ctl', 'op')[1]);
  P.put('dec', 'imm', CX, YB + 26);
  P.row('dec', 'immA', 'a', CX + 26, P.pin('imm', 'imm')[1]);
  P.row('dec', 'fA', 'out', CX + 18, P.pin('immA', 'b')[1]);
  P.row('dec', 'nAmo', 'y', CX + 12, YB + 34);
  P.put('dec', 'sdec', CX, YB + 38);
  // a load, the lanes that write now, the leader
  const GX = CX + 32;
  P.row('dec', 'rs', 'in', GX, P.pin('ctl', 'resultSrc')[1]);
  wire('ctl.resultSrc', 'rs.in');
  P.row('dec', 'nr1', 'a', GX + 4, P.pin('rs', 'o1')[1]);
  P.row('dec', 'isLoad', 'a', GX + 10, P.pin('rs', 'o0')[1]);
  P.row('dec', 'rwx', 'a', GX + 10, P.pin('ctl', 'regWrite')[1]);
  P.row('dec', 'nld', 'a', GX + 18, P.pin('isLoad', 'y')[1]);
  wire('isLoad.y', 'nld.a');
  P.row('dec', 'wn', 'a', GX + 25, P.pin('rwx', 'y')[1]);
  P.row('dec', 'wNow', 'a', GX + 35, P.pin('wn', 'y')[1]);
  P.put('dec', 'rdz', GX + 4, YB + 20);
  P.row('dec', 'rdNz', 'a', GX + 14, P.pin('rdz', 'z')[1]);
  P.put('dec', 'li1', GX + 22, YB + 16);
  P.row('dec', 'ldIss', 'a', GX + 30, P.pin('li1', 'y')[1]);
  P.put('dec', 'weN', GX + 52, YB + 8);
  P.row('dec', 'fw', 'out', GX + 44, P.pin('weN', 'b')[1]);
  P.row('dec', 'weS', 'in', GX + 64, P.pin('weN', 'y')[1]);
  P.put('dec', 'lead', GX + 50, YB + 30);
  const decR = Math.max(P.right('weS') + 10, P.right('lead') + 10, P.right('sdec') + 10);
  // wspawn starts warp w when rs1 > w (warp 0: never, or the host's launch)
  const SPX = decR + 4, uHi = feeding('hiNz');
  P.put('spawn', 'ldec', SPX + 4, YB);
  P.put('spawn', uHi, SPX + 8, P.bottom('ldec') + 6);
  P.row('spawn', 'la', 'o1', SPX, P.pin(uHi, 'in')[1]);
  wire('la.o0', 'ldec.a');
  P.row('spawn', 'hiNz', 'i0', P.right(uHi) + 4, P.pin(uHi, 'o0')[1]);
  // per warp: rs1 > w (the high bits, or a low-bits value above w), and wspawn issues
  // (a one-warp core has no compare: warp 0's spawn alone)
  const G1 = P.has('ldec') ? P.right('ldec') + 20 : SPX + 10;
  P.put('spawn', 'spGo', G1, YB);
  P.put('spawn', 'sp0', G1 + 1, P.has('spGo') ? P.bottom('spGo') + 6 : YB);
  labelled.add('sp0.y');
  let gy = Math.max(P.bottom('spGo'), P.bottom('sp0')) + 6;
  for (const w of Ws.slice(1)) {
    P.put('spawn', `gt${w}`, G1, gy);
    P.row('spawn', `nz${w}`, 'y', G1 - 10, P.pin(`gt${w}`, 1)[1]);
    P.row('spawn', `sp${w}`, 'b', G1 + 16, P.pin(`gt${w}`, P.out(`gt${w}`))[1]);
    gy = Math.max(P.bottom(`gt${w}`), P.bottom(`sp${w}`)) + 6;
  }
  const uRun = feeding('anyRun');
  P.cols('out', G1 - 10, gy + 6, [['runs'], [uRun], ['anyRun'], ['haltedG', 'retireG']], 10);

  // ---- band C: the lanes, the leader, the next PC ----
  const YC = P.extent('dec', 'spawn', 'out').bottom + 12;
  const LP = 36, laneX = (i: number) => 22 + LP * i, laneH = P.h('lane0');
  for (const i of Ls) {
    const x = laneX(i), ty = YC + laneH + 6;
    P.put('lanes', `lane${i}`, x, YC);
    P.put('lanes', `tid${i}`, x - 4, ty);
    P.row('lanes', `ln${i}`, 'y', x - 14, P.pin(`tid${i}`, 'i0')[1]);
    P.row('lanes', `tz${i}`, 'y', x - 14, P.pin(`tid${i}`, 'i2')[1]);
    labelled.add(`tid${i}.out`); // a wire up to the lane's tid would cross its labels
  }
  const MX = laneX(n) - 4, NX = MX + 24;
  // the leader's flags feed the next-PC logic beside them; its ALU result (jalr) the clear-bit-0 under it
  P.put('lead', 'lF', MX, YC);
  const fOut = P.pin('lF', 'y')[1];
  P.row('lead', 'fs', 'in', NX - 6, fOut);
  P.row('lead', 'npc', 'zero', NX, P.pin('fs', 'o0')[1]);
  P.put('lead', 'lAlu', MX, Math.max(P.bottom('lF') + 6, P.bottom('npc') + 3 - P.h('lAlu') / 2));
  let my = P.bottom('lAlu') + 6;
  for (const m of ['lA', 'lB']) { P.put('lead', m, MX, my); my += P.h(m) + 6; }
  P.put('lead', 'pm', MX + 6, my);
  P.row('lead', 'clr0', 'in', NX, P.pin('lAlu', 'y')[1]);
  P.put('lead', 'gndJ', NX + 8, P.y('clr0') + 3);
  wire('gndJ.y', 'clr0.zero');
  P.put('lead', 'target', NX + 24, P.y('clr0') - 1);
  P.row('lead', 'gndT', 'y', NX + 17, P.pin('target', 'cin')[1]);
  P.put('pcmux', 'pcmux', NX + 28, P.bottom('target') + 6);

  // ---- band D: the memory system, the returning loads ----
  const YD = P.extent('lanes', 'lead', 'pcmux').bottom + 12;
  /** A register enabled for good: its tie-high left of en. */
  const tie = (grp: string, r: string) => P.row(grp, `${r}On`, 'y', P.x(r) - 10, P.pin(r, 'en')[1]);
  let mx = 30;
  if (lsu) {
    // a memory instruction's accesses: which lanes now (the access unit, unless it must wait), what is left, done, holding the port
    const a = P.cols('acc', 22, YD, [['todo', 'mo'], ['acc', 'memop'], ['nShA', 'wS', 'wG'], ['wait'], ['nWait'], ['go'], ['fGo'], ['srv']], 16);
    const uHeld = feeding('heldG');
    const d = P.cols('done', 22, a.bottom + 10, [['allN', 'nMo'], ['nSrv'], ['rest'], ['restZ'], ['doneG'], ['nDone'], ['hold'], ['fH'], ['heldN'], ['heldW'], ['hw'], [uHeld]], 12);
    P.row('done', 'heldG', 'i0', P.right(uHeld) + 3, P.pin(uHeld, 'o0')[1]);
    P.put('done', 'left', P.x('restZ'), P.bottom('restZ') + 8);
    tie('done', 'left'); tie('done', 'heldW');
    // bar: how many warps have arrived against rs2, release; the warps waiting
    const top = Math.max(d.bottom, P.bottom('left'), P.bottom('heldG')) + 10;
    const r1 = P.cols('bar', 22, top, [['nWait2', 'arr1'], ['arr', 'arrZ'], ['arrW'], ['barCmp'], ['enough'], ['release']], 12);
    const r2 = P.cols('bar', 22, r1.bottom + 10, [['barGo'], ['fB'], ['arrives', 'nRel'], ['barOr', 'fR'], ['barN'], ['atBar'], ['ab'], ['amoIss']], 12);
    tie('bar', 'atBar');
    mx = Math.max(a.right, d.right, P.right('heldG'), r1.right, r2.right) + 24;
    labelled.add('amoIss.y');
  }
  P.put('mem', 'mem', mx, YD);
  P.row('mem', 'stIss', 'y', mx - 12, P.pin('mem', 'st')[1]);
  const RX = P.right('mem') + 14;
  P.row('mem', 'rw', 'in', RX, P.pin('mem', 'retWarp')[1]);
  wire('mem.retWarp', 'rw.in');
  P.row('mem', 'rm', 'in', RX, Math.max(P.pin('mem', 'retMask')[1], P.bottom('rw') + 2 + n));
  trunks.set('mem.retMask', P.right('mem') + 9);
  Ws.forEach((w) => labelled.add(`rw.o${w}`));
  P.cols('ret', RX + 16, YD, [Ws.map((w) => `rh${w}`)], 10, 4);

  for (const i of b.instances) {
    const p = P.at.get(i.name);
    if (!p || p.some(Number.isNaN)) throw new Error(`warpCore: no place for ${i.name}`);
    i.at = p;
  }
  const right = Math.max(...b.instances.map((i) => P.right(i.name))) + 16;
  const pins: Record<string, At> = { clk: [0, 2], ...(host ? { launch: [0, 6] as At, xa: [0, 10] as At } : {}) };
  outs.forEach((p, i) => (pins[p] = [right, 2 + 3 * i]));

  // nets: a wire inside a block (one sink, to the right), or one asked for; labels otherwise
  const names = netNames(W, n, lsu), used = new Set<string>();
  for (const nt of raw) if (nt.name) used.add(nt.name);
  const instOf = (e: string) => (e.includes('.') ? e.slice(0, e.indexOf('.')) : '');
  const nets = raw.map((nt): NetDef => {
    const drv = nt.ends[0], sinks = nt.ends.slice(1), di = instOf(drv);
    let name = nt.name;
    if (!name && di) {
      const port = drv.slice(di.length + 1);
      const want = names[drv] ?? (BY_PORT.has(di) ? port : /^lane\d+$/.test(di) ? drv : P.out(di) === port ? di : drv);
      name = used.has(want) ? drv : want;
      used.add(name);
    }
    const asWire = (s: string) => {
      const si = instOf(s);
      if (!di || !si || labelled.has(drv)) return false;
      if (wired.has(`${drv}>${s}`)) return true;
      return sinks.length === 1 && P.group.get(di) === P.group.get(si) && P.x(si) >= P.right(di);
    };
    const tags = sinks.filter((s) => !asWire(s));
    const trunk = trunks.get(drv);
    return { name, ends: nt.ends, ...(tags.length === sinks.length ? { tags: true as const } : tags.length ? { tags } : {}), ...(trunk !== undefined ? { trunk } : {}) };
  });
  return { pins, nets };
}
