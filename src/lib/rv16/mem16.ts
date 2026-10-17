// Act 10's build levels (roadmap Phase 16e): memory hardware at RV16 sizes, each block built only from parts its
// level unlocks, so each is that level's reference. The devices themselves (the cell array, the DRAM chip) sit on
// the level's bench (campaign/memcheck.ts), which knows their rules and names a broken one.
//
//   DRAM_COL2  m_sense: a DRAM column of two cells at switch level: precharge to VDD/2 through one transistor,
//              the equalizer doubling as the reference line's precharge, the sense amplifier, the write driver.
//   BANK16     m_bank: open page around a 16 × 16 cell array, RAS-only refresh (a row pointer and a timer).
//   CTRL16     m_ctrl: open page over a two-bank DRAM chip: tRCD / tRAS / tRP from two since-counters, tCAS by a
//              shift register, auto refresh (PREA, REF, tRFC).
//   BUS16      m_bus: two masters, three slaves, valid / ready, round robin held through a transfer.
//   DMA16      m_dma: a bus master copying len words, configured by register writes, irq when done.
//   FLASH_STORE16  m_flash: a log over a 4 × 4-page flash chip, a mapping table, the owner in the spare area, GC.
// bankOf / ctrlOf / busOf / dmaOf / flashOf also build them with a fault, for the tests that prove the benches catch it.

import type { ComponentDef, PortDef } from '../../sim/types';
import { WRITE_DRIVER } from '../arrays';
import { Builder } from '../builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree } from '../combinational';
import { define, merger, ones, splitter } from '../define';
import { BITLINE_CAP, DRAM_BIT, DRAM_SA, VHALF } from '../dram';
import { fanout } from '../fastadd';
import { AND, NOT, OR, XOR } from '../gates';
import { NAND, NMOS } from '../transistors';
import { constWord } from '../alu';
import { bitwise, orN } from '../wide';
import { INC16, MUX16, RV16_DFF, RV16_DFFE, RV16_REG16, RV16_REG4 } from './logic';

const bit = (name: string, dir: 'in' | 'out'): PortDef => ({ name, width: 1, dir });
const bus = (name: string, width: number, dir: 'in' | 'out'): PortDef => ({ name, width, dir });
const clkIn = (): PortDef => ({ name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true });
const pinsAt = (names: string[], x: number, step = 4, y0 = 4): Record<string, [number, number]> => Object.fromEntries(names.map((n, i) => [n, [x, y0 + step * i]]));

// ---- m_sense: a DRAM column ------------------------------------------------------------------------------

export const DRAM_COL2: ComponentDef = define({
  id: 'rv16_dramcol', name: 'DRAM column (2 cells)', category: 'memory',
  summary: 'Two 1T1C cells on a bit line, a reference line of the same capacitance, both precharged to VDD/2 (one transistor to the rail, the equalizer to the other line), the sense amplifier and the write driver. q is the bit line: valid once the amplifier has driven it to a rail.',
  ports: [bit('pre', 'in'), bit('wl0', 'in'), bit('wl1', 'in'), bit('sae', 'in'), bit('we', 'in'), bit('d', 'in'), bit('q', 'out')],
  symbol: { kind: 'box', label: 'COLUMN' },
  netlist: () => ({
    level: 'switch',
    pins: { pre: [0, 4], wl0: [0, 13], wl1: [0, 19], sae: [0, 34], we: [0, 42], d: [0, 44], q: [46, 22] },
    instances: [
      { name: 'vh', def: VHALF, at: [18, 0] },
      { name: 'pa', def: NMOS, at: [16, 2], label: 'precharge' },
      { name: 'eq', def: NMOS, at: [26, 6], label: 'equalize' },
      { name: 'c0', def: DRAM_BIT, at: [22, 12], label: 'row 0' },
      { name: 'c1', def: DRAM_BIT, at: [22, 18], label: 'row 1' },
      { name: 'cb', def: BITLINE_CAP, at: [10, 26], label: 'bit line' },
      { name: 'cr', def: BITLINE_CAP, at: [36, 26], label: 'reference' },
      { name: 'sa', def: DRAM_SA, at: [18, 32] },
      { name: 'wd', def: WRITE_DRIVER, at: [16, 40] },
    ],
    nets: [
      { ends: ['vh.p', 'pa.d'] },
      { name: 'pre', ends: ['pre', 'pa.g', 'eq.g'] },
      { name: 'wl0', ends: ['wl0', 'c0.wl'] },
      { name: 'wl1', ends: ['wl1', 'c1.wl'] },
      { name: 'sae', ends: ['sae', 'sa.en'] },
      { name: 'we', ends: ['we', 'wd.we'] },
      { name: 'd', ends: ['d', 'wd.d'] },
      { name: 'bl', ends: ['pa.s', 'eq.d', 'c0.bl', 'c1.bl', 'cb.a', 'sa.bl', 'wd.bl', 'q'], trunk: 20 },
      { name: 'bl̄', ends: ['eq.s', 'cr.a', 'sa.blb', 'wd.blb'], trunk: 33 },
    ],
  }),
});

// ---- m_bank: a bank with refresh ---------------------------------------------------------------------------

const memo = new Map<string, ComponentDef>();
const once = (key: string, make: () => ComponentDef): ComponentDef => { let d = memo.get(key); if (!d) memo.set(key, (d = make())); return d; };

/**
 * Open page around the bench's 16 × 16 cell array: the open row (a flag and a row register), a refresh pointer and
 * a refresh timer. The timer counts the cycles since the last refresh, saturating at 15: from 8 on, a cycle with no
 * request refreshes; at 15 a refresh goes first. A refresh opens the pointer's row (after closing the open one)
 * and leaves it open, so it costs an ACT, or a PRE and an ACT; every row is then opened at least every 16 · 16 cycles.
 * With the fault 'norefresh' (tests: the bench must catch it) nothing is ever refreshed.
 */
export const bankOf = (fault?: 'norefresh'): ComponentDef => once(`bank${fault ?? ''}`, () => {
  const b = new Builder(10, 12, 4);
  b.pins('addr', 'wd', 're', 'we', 'clk', 'rst', 'aq');
  const a = b.op(splitter([4, 4], 2), ['addr'], 'col | row');
  const row = `${a}.o1`;
  const req = b.op1(OR, ['re', 'we'], 'request');
  const nrst = b.op1(NOT, ['rst']);
  b.next();
  // state
  const open = b.add(RV16_DFF, 'row open', 'open');
  const orow = b.add(RV16_REG4, 'open row', 'orow');
  const rcnt = b.add(RV16_REG4, 'refresh row', 'rcnt');
  const timer = b.add(RV16_REG4, 'since refresh', 'timer');
  for (const r of [open, orow, rcnt, timer]) b.wire('clk', `${r}.clk`);
  b.next();
  const t = b.op(splitter([1, 1, 1, 1], 2), [`${timer}.q`], 'timer bits');
  const due = b.op1(andN(4), [`${t}.o0`, `${t}.o1`, `${t}.o2`, `${t}.o3`], 'due (15)');
  const hit = b.op1(AND, [`${open}.q`, b.op1(equal(4), [`${orow}.q`, row], 'same row?')], 'hit');
  const nopen = b.op1(NOT, [`${open}.q`]);
  b.next();
  const refresh = fault ? b.op1(constWord(1, 0), [], 'never')
    : b.op1(OR, [due, b.op1(AND, [`${t}.o3`, b.op1(NOT, [req])], 'idle, ≥ 8')], 'refresh');
  const nref = b.op1(NOT, [refresh]);
  b.next();
  const act = b.op1(AND, [nopen, b.op1(OR, [refresh, req])], 'ACT');
  const pre = b.op1(AND, [`${open}.q`, b.op1(OR, [refresh, b.op1(AND, [req, b.op1(NOT, [hit])])])], 'PRE');
  const rw = b.op1(andN(3), [req, hit, nref], 'RW');
  b.wire(b.op1(AND, [req, b.op1(NAND, [hit, nref])], 'busy'), 'busy');
  const ra = b.op1(busMux2(4), [row, `${rcnt}.q`, refresh], 'row or refresh');
  const refact = b.op1(AND, [act, refresh], 'refresh ACT');
  b.next();
  b.wire(b.op1(merger([1, 1], 2), [b.op1(OR, [act, rw]), b.op1(OR, [pre, rw])], 'cmd'), 'cmd');
  b.wire(ra, 'ra');
  // next state
  const clear = b.op1(OR, ['rst', refact], 'restart');
  b.wire(b.op1(AND, [nrst, b.op1(OR, [act, b.op1(AND, [`${open}.q`, b.op1(NOT, [pre])])])], 'open next'), `${open}.d`);
  b.wire(ra, `${orow}.d`); b.wire(act, `${orow}.en`);
  b.wire(b.op1(incrementer(4), [`${rcnt}.q`], 'next row'), `${rcnt}.d`); b.wire(refact, `${rcnt}.en`);
  b.wire(b.op1(bitwise('and', 4), [b.op1(incrementer(4), [`${timer}.q`], '+1'), b.op1(fanout(4), [b.op1(NOT, [clear])])], '0 on restart'), `${timer}.d`);
  b.wire(b.op1(OR, [clear, b.op1(NOT, [due])], 'count'), `${timer}.en`);
  b.wire(`${a}.o0`, 'ca'); b.wire('we', 'aw'); b.wire('wd', 'ad'); b.wire('aq', 'rd');
  const R = b.right;
  return define({
    id: `rv16_bank${fault ? `_${fault}` : ''}`, name: 'DRAM bank with refresh (RV16)', category: 'memory',
    summary: 'Requests in (a word address: row and column), array commands out: a row hit reads or writes at once; a miss closes the open row and opens the new one. A refresh timer and pointer open every row in turn: early when the port is idle, first when it is due.',
    ports: [bus('addr', 8, 'in'), bus('wd', 16, 'in'), bit('re', 'in'), bit('we', 'in'), clkIn(), bit('rst', 'in'), bus('aq', 16, 'in'),
      bus('rd', 16, 'out'), bit('busy', 'out'), bus('cmd', 2, 'out'), bus('ra', 4, 'out'), bus('ca', 4, 'out'), bit('aw', 'out'), bus('ad', 16, 'out')],
    symbol: { kind: 'box', label: 'BANK' },
    netlist: () => ({
      pins: { ...pinsAt(['addr', 'wd', 're', 'we', 'clk', 'rst', 'aq'], 0), ...pinsAt(['rd', 'busy', 'cmd', 'ra', 'ca', 'aw', 'ad'], R) },
      instances: b.instances, nets: b.nets(),
    }),
  });
});
export const BANK16 = bankOf();

// ---- m_ctrl: a row-buffer controller ------------------------------------------------------------------------

/** A 4-bit counter of the cycles since a clear, stopping at 15 (its incrementer's carry says 15); cleared later. */
function sinceCounter(b: Builder, label: string): { q: string; clear: (c: string) => void } {
  const r = b.add(RV16_REG4, label);
  b.wire('clk', `${r}.clk`);
  return {
    q: `${r}.q`,
    clear: (c) => {
      const inc = b.op(incrementer(4), [`${r}.q`], '+1');
      b.wire(b.op1(bitwise('and', 4), [`${inc}.y`, b.op1(fanout(4), [b.op1(NOT, [c])])], '0 on clear'), `${r}.d`);
      b.wire(b.op1(OR, [c, b.op1(NOT, [`${inc}.cout`])], 'count'), `${r}.en`);
    },
  };
}

/** A 6-bit register with enable (a 4-bit register and two enable flip-flops); loaded later. */
function reg6(b: Builder, label: string): { q: string; load: (d: string, en: string) => void } {
  const lo = b.add(RV16_REG4, label), h0 = b.add(RV16_DFFE), h1 = b.add(RV16_DFFE);
  for (const r of [lo, h0, h1]) b.wire('clk', `${r}.clk`);
  return {
    q: b.op1(merger([4, 1, 1], 2), [`${lo}.q`, `${h0}.q`, `${h1}.q`]),
    load: (d, en) => {
      const s = b.op(splitter([4, 1, 1], 2), [d]);
      ([[lo, 'o0'], [h0, 'o1'], [h1, 'o2']] as const).forEach(([r, o]) => { b.wire(`${s}.${o}`, `${r}.d`); b.wire(en, `${r}.en`); });
    },
  };
}

/**
 * Open page over two banks, one request at a time. Per bank an open flag and the open row; two counters of the
 * cycles since the last ACT and since the last PRE (of any bank: conservative, and enough with one request at a
 * time) say when tRCD, tRAS and tRP have passed; a 4-stage shift register follows a read to its data (tCAS = 4).
 * A refresh counter makes a refresh pending 128 cycles after the last: it goes before the next command (PREA,
 * REF), and a flag stretches the wait after REF to tRFC = 12. Faults for the tests: 'norefresh' never refreshes,
 * 'notrcd' reads and writes as soon as the row is open.
 */
export const ctrlOf = (fault?: 'norefresh' | 'notrcd'): ComponentDef => once(`ctrl${fault ?? ''}`, () => {
  const b = new Builder(10, 12, 4);
  b.pins('req', 'addr', 'wd', 'we', 'clk', 'rst', 'dq');
  const a = b.op(splitter([4, 1, 6], 2), ['addr'], 'col | bank | row');
  const ba = `${a}.o1`, row = `${a}.o2`;
  const nrst = b.op1(NOT, ['rst']);
  const nb = b.op1(NOT, [ba]);
  b.next();
  // state
  const open0 = b.add(RV16_DFF, 'bank 0 open', 'open0'), open1 = b.add(RV16_DFF, 'bank 1 open', 'open1');
  const lastRef = b.add(RV16_DFF, 'after REF', 'lastref');
  const sh = [0, 1, 2, 3].map((i) => b.add(RV16_DFF, i ? undefined : 'read in flight', `rd${i}`));
  for (const r of [open0, open1, lastRef, ...sh]) b.wire('clk', `${r}.clk`);
  const row0 = reg6(b, 'bank 0 row'), row1 = reg6(b, 'bank 1 row');
  b.next();
  const cntA = sinceCounter(b, 'since ACT'), cntP = sinceCounter(b, 'since PRE / REF');
  const lo = b.add(RV16_REG4, 'since REF', 'reflo'), hi = b.add(RV16_REG4, undefined, 'refhi');
  b.wire('clk', `${lo}.clk`); b.wire('clk', `${hi}.clk`);
  b.next();
  // when may each command go?
  const pend = fault === 'norefresh' ? b.op1(constWord(1, 0), [], 'never') : `${b.op(splitter([3, 1], 2), [`${hi}.q`], 'pending from 128')}.o1`;
  const ca4 = b.op(splitter([1, 1, 1, 1], 2), [cntA.q]), cp4 = b.op(splitter([1, 1, 1, 1], 2), [cntP.q]);
  const [a0, a1, a2, a3] = [0, 1, 2, 3].map((i) => `${ca4}.o${i}`), [p2, p3] = [`${cp4}.o2`, `${cp4}.o3`];
  const tRCD = fault === 'notrcd' ? b.op1(constWord(1, 1), [], 'at once') : b.op1(OR, [a2, a3], '≥ 4: tRCD');
  const tRAS = b.op1(AND, [a3, b.op1(orN(3), [a0, a1, a2])], '≥ 9: tRAS');
  const tRP = b.op1(busMux2(1), [b.op1(OR, [p2, p3]), b.op1(AND, [p2, p3]), `${lastRef}.q`], '≥ 4, or 12 after REF');
  const openB = b.op1(busMux2(1), [`${open0}.q`, `${open1}.q`, ba], 'bank open?');
  const hit = b.op1(AND, [openB, b.op1(equal(6), [b.op1(busMux2(6), [row0.q, row1.q, ba]), row], 'its row?')], 'hit');
  const anyOpen = b.op1(OR, [`${open0}.q`, `${open1}.q`]);
  const waiting = b.op1(orN(4), sh.map((r) => `${r}.q`), 'waiting for data');
  b.next();
  const free = b.op1(NOT, [waiting]);
  const goRef = b.op1(AND, [free, pend], 'refresh first');
  const goReq = b.op1(andN(3), [free, b.op1(NOT, [pend]), 'req'], 'request');
  b.next();
  const doPrea = b.op1(andN(3), [goRef, anyOpen, tRAS], 'PREA');
  const doRef = b.op1(andN(3), [goRef, b.op1(NOT, [anyOpen]), tRP], 'REF');
  const rw = b.op1(andN(3), [goReq, hit, tRCD], 'RD / WR');
  const doRd = b.op1(AND, [rw, b.op1(NOT, ['we'])], 'RD'), doWr = b.op1(AND, [rw, 'we'], 'WR');
  const doPre = b.op1(andN(4), [goReq, openB, b.op1(NOT, [hit]), tRAS], 'PRE');
  const doAct = b.op1(andN(3), [goReq, b.op1(NOT, [openB]), tRP], 'ACT');
  b.next();
  // commands and the request side
  b.wire(b.op1(merger([1, 1, 1], 2), [b.op1(orN(3), [doAct, doWr, doPrea]), b.op1(orN(3), [doRd, doWr, doRef]), b.op1(orN(3), [doPre, doPrea, doRef])], 'cmd'), 'cmd');
  b.wire(b.op1(OR, [`${sh[3]}.q`, doWr], 'ready'), 'ready');
  b.wire(`${a}.o0`, 'ca'); b.wire(ba, 'ba'); b.wire(row, 'ra'); b.wire('wd', 'dd'); b.wire('dq', 'rd');
  // next state
  const act0 = b.op1(AND, [doAct, nb]), act1 = b.op1(AND, [doAct, ba]);
  row0.load(row, act0); row1.load(row, act1);
  const pres = b.op1(OR, [doPre, doPrea]);
  cntA.clear(b.op1(OR, [doAct, 'rst']));
  cntP.clear(b.op1(orN(3), [pres, doRef, 'rst']));
  const clrR = b.op1(OR, [doRef, 'rst']), nclrR = b.op1(fanout(4), [b.op1(NOT, [clrR])]);
  const ilo = b.op(incrementer(4), [`${lo}.q`]), ihi = b.op(incrementer(4), [`${hi}.q`]);
  b.wire(b.op1(bitwise('and', 4), [`${ilo}.y`, nclrR]), `${lo}.d`); b.wire(b.op1(constWord(1, 1), []), `${lo}.en`);
  b.wire(b.op1(bitwise('and', 4), [`${ihi}.y`, nclrR]), `${hi}.d`); b.wire(b.op1(OR, [clrR, `${ilo}.cout`]), `${hi}.en`);
  const keep = (o: string, close: string) => b.op1(AND, [`${o}.q`, b.op1(NOT, [close])]);
  const pre0 = b.op1(OR, [doPrea, b.op1(AND, [doPre, nb])]), pre1 = b.op1(OR, [doPrea, b.op1(AND, [doPre, ba])]);
  b.wire(b.op1(AND, [nrst, b.op1(OR, [act0, keep(open0, pre0)])]), `${open0}.d`);
  b.wire(b.op1(AND, [nrst, b.op1(OR, [act1, keep(open1, pre1)])]), `${open1}.d`);
  b.wire(b.op1(AND, [nrst, b.op1(OR, [doRef, keep(lastRef, pres)])]), `${lastRef}.d`);
  sh.forEach((r, i) => b.wire(b.op1(AND, [nrst, i ? `${sh[i - 1]}.q` : doRd]), `${r}.d`));
  const R = b.right;
  return define({
    id: `rv16_dramctrl${fault ? `_${fault}` : ''}`, name: 'DRAM controller (RV16)', category: 'memory',
    summary: 'One request at a time (a word address: row, bank, column) in, DRAM commands out, open page: a row hit is a RD or WR as soon as tRCD allows; a miss precharges (after tRAS) and activates (after tRP). A read is ready tCAS = 4 cycles after its RD, a write with its WR. A refresh is pending 128 cycles after the last one and goes first: PREA, REF, then tRFC = 12 cycles of nothing.',
    ports: [bit('req', 'in'), bus('addr', 11, 'in'), bus('wd', 16, 'in'), bit('we', 'in'), clkIn(), bit('rst', 'in'), bus('dq', 16, 'in'),
      bit('ready', 'out'), bus('rd', 16, 'out'), bus('cmd', 3, 'out'), bit('ba', 'out'), bus('ra', 6, 'out'), bus('ca', 4, 'out'), bus('dd', 16, 'out')],
    symbol: { kind: 'box', label: 'DRAM CTRL' },
    netlist: () => ({
      pins: { ...pinsAt(['req', 'addr', 'wd', 'we', 'clk', 'rst', 'dq'], 0), ...pinsAt(['ready', 'rd', 'cmd', 'ba', 'ra', 'ca', 'dd'], R) },
      instances: b.instances, nets: b.nets(),
    }),
  });
});
export const CTRL16 = ctrlOf();

// ---- m_bus: two masters, one bus ---------------------------------------------------------------------------

/** The address map of m_bus: slave 0 below 0x8000, slave 1 from 0x8000, slave 2 from 0xC000. */
export const busSlaveOf = (a: number): number => ((a >> 15) & 1 ? 1 + ((a >> 14) & 1) : 0);

/**
 * Two masters, three slaves, one transfer at a time. The grant: the only master asking; with both asking, the one
 * not served last; and a transfer in progress keeps its master (lock, own) until the slave is ready, so a waiting
 * slave never sees its request change. The granted master's address, data and write go to every slave; the address's
 * top bits pick whose valid rises and whose ready and data come back. With fault 'nolock' a master asking second can
 * take the bus from a transfer still waiting (the bench must catch it).
 */
export const busOf = (fault?: 'nolock'): ComponentDef => once(`bus${fault ?? ''}`, () => {
  const b = new Builder(10, 12, 4);
  b.pins('mv0', 'ma0', 'md0', 'mw0', 'mv1', 'ma1', 'md1', 'mw1', 'sr0', 'sq0', 'sr1', 'sq1', 'sr2', 'sq2', 'clk', 'rst');
  const last = b.add(RV16_DFF, 'served last', 'last'), lock = b.add(RV16_DFF, 'in progress', 'lock'), own = b.add(RV16_DFF, 'owner', 'own');
  for (const r of [last, lock, own]) b.wire('clk', `${r}.clk`);
  b.next();
  const pick = b.op1(busMux2(1), ['mv1', b.op1(NOT, [`${last}.q`]), b.op1(AND, ['mv0', 'mv1'], 'both ask')], 'round robin');
  const g = fault ? pick : b.op1(busMux2(1), [pick, `${own}.q`, `${lock}.q`], 'grant');
  b.next();
  const vg = b.op1(busMux2(1), ['mv0', 'mv1', g], 'valid');
  const a = b.op1(MUX16, ['ma0', 'ma1', g], 'address');
  b.wire(b.op1(MUX16, ['md0', 'md1', g], 'data'), 'sd');
  b.wire(b.op1(busMux2(1), ['mw0', 'mw1', g], 'write'), 'sw');
  b.wire(a, 'sa');
  b.next();
  const top = b.op(splitter([14, 1, 1], 2), [a], 'a15 a14');
  const a14 = `${top}.o1`, a15 = `${top}.o2`;
  b.wire(b.op1(AND, [vg, b.op1(NOT, [a15])]), 'sv0');
  b.wire(b.op1(andN(3), [vg, a15, b.op1(NOT, [a14])]), 'sv1');
  b.wire(b.op1(andN(3), [vg, a15, a14]), 'sv2');
  const ready = b.op1(busMux2(1), ['sr0', b.op1(busMux2(1), ['sr1', 'sr2', a14]), a15], 'its ready');
  const mq = b.op1(MUX16, ['sq0', b.op1(MUX16, ['sq1', 'sq2', a14]), a15], 'its data');
  b.wire(mq, 'mq0'); b.wire(mq, 'mq1');
  b.next();
  const done = b.op1(AND, [vg, ready], 'done');
  b.wire(b.op1(AND, [done, b.op1(NOT, [g])]), 'mr0');
  b.wire(b.op1(AND, [done, g]), 'mr1');
  b.wire(b.op1(OR, ['rst', b.op1(busMux2(1), [`${last}.q`, g, done])], 'm0 first'), `${last}.d`);
  b.wire(b.op1(andN(3), [b.op1(NOT, ['rst']), vg, b.op1(NOT, [done])], 'waiting'), `${lock}.d`);
  b.wire(g, `${own}.d`);
  const R = b.right;
  const m = (i: number): PortDef[] => [bit(`mv${i}`, 'in'), bus(`ma${i}`, 16, 'in'), bus(`md${i}`, 16, 'in'), bit(`mw${i}`, 'in')];
  const s = (j: number): PortDef[] => [bit(`sr${j}`, 'in'), bus(`sq${j}`, 16, 'in')];
  const ins = [...m(0), ...m(1), ...s(0), ...s(1), ...s(2), clkIn(), bit('rst', 'in')];
  const outs = [bit('mr0', 'out'), bus('mq0', 16, 'out'), bit('mr1', 'out'), bus('mq1', 16, 'out'), bit('sv0', 'out'), bit('sv1', 'out'), bit('sv2', 'out'),
    bus('sa', 16, 'out'), bus('sd', 16, 'out'), bit('sw', 'out')];
  return define({
    id: `rv16_bus${fault ? `_${fault}` : ''}`, name: 'Two-master bus (RV16)', category: 'routing',
    summary: 'valid / ready on both sides: a round-robin grant held until the transfer completes, the address decoded to three slaves (0 below 0x8000, 1 from 0x8000, 2 from 0xC000), the granted master\'s address, data and write to all of them, the chosen slave\'s ready and data back.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'BUS' },
    netlist: () => ({ pins: { ...pinsAt(ins.map((p) => p.name), 0, 3), ...pinsAt(outs.map((p) => p.name), R, 3) }, instances: b.instances, nets: b.nets() }),
  });
});
export const BUS16 = busOf();

// ---- m_dma: a DMA engine -----------------------------------------------------------------------------------

/** NOT of a 16-bit word: sixteen inverters between a splitter and a merger. */
function not16(b: Builder, x: string, label: string): string {
  const s = b.op(splitter(ones(16), 1), [x]);
  return b.op1(merger(ones(16), 1), ones(16).map((_, i) => b.op1(NOT, [`${s}.o${i}`])), label);
}

/**
 * A bus master that copies len words from src to dst. Configuration writes: 0 src, 1 dst, 2 len (and start), 3 clear
 * irq. The count register holds NOT(words left) and counts up: its incrementer's carry (all ones) says every word
 * is done, len = 0 included; that ends the copy and raises irq. Each word is a read (its word latched when ready),
 * then a write; a request is held until ready. With fault 'nohold' the address moves on before the write is ready.
 */
export const dmaOf = (fault?: 'nohold'): ComponentDef => once(`dma${fault ?? ''}`, () => {
  const b = new Builder(10, 12, 4);
  b.pins('cw', 'ca', 'cd', 'clk', 'rst', 'mr', 'mq');
  const dec = b.op(decoder(2, false), ['ca'], 'register');
  const we = [0, 1, 2, 3].map((i) => b.op1(AND, ['cw', `${dec}.y${i}`]));
  const start = we[2];
  const nlen = not16(b, 'cd', 'NOT len');
  const nrst = b.op1(NOT, ['rst']);
  b.next();
  // state
  const src = b.add(RV16_REG16, 'src', 'src'), dst = b.add(RV16_REG16, 'dst', 'dst'), cnt = b.add(RV16_REG16, 'NOT left', 'cnt');
  const data = b.add(RV16_REG16, 'word', 'data');
  const run = b.add(RV16_DFF, 'running', 'run'), phase = b.add(RV16_DFF, 'write phase', 'phase'), irq = b.add(RV16_DFF, 'irq', 'irqff');
  for (const r of [src, dst, cnt, data, run, phase, irq]) b.wire('clk', `${r}.clk`);
  b.next();
  const left = b.op(INC16, [`${cnt}.q`], 'count');
  const fin = b.op1(AND, [`${run}.q`, `${left}.cout`], 'all done');
  const mv = b.op1(AND, [`${run}.q`, b.op1(NOT, [`${left}.cout`])], 'valid');
  const step = b.op1(AND, [mv, 'mr'], 'ready');
  const rstep = b.op1(AND, [step, b.op1(NOT, [`${phase}.q`])], 'read done'), wstep = b.op1(AND, [step, `${phase}.q`], 'write done');
  b.wire(mv, 'mv'); b.wire(`${phase}.q`, 'mw'); b.wire(`${data}.q`, 'md'); b.wire(`${run}.q`, 'busy'); b.wire(`${irq}.q`, 'irq');
  b.wire(b.op1(MUX16, [`${src}.q`, `${dst}.q`, fault ? b.op1(XOR, [`${phase}.q`, 'mr']) : `${phase}.q`], 'address'), 'ma');
  b.next();
  // next state
  const load = (r: string, w: string, label: string) => {
    b.wire(b.op1(MUX16, [b.op1(INC16, [`${r}.q`], '+1'), 'cd', w], label), `${r}.d`);
    b.wire(b.op1(OR, [w, wstep]), `${r}.en`);
  };
  load(src, we[0], 'src'); load(dst, we[1], 'dst');
  b.wire(b.op1(MUX16, [`${left}.y`, nlen, start], 'NOT left'), `${cnt}.d`); b.wire(b.op1(OR, [start, wstep]), `${cnt}.en`);
  b.wire('mq', `${data}.d`); b.wire(rstep, `${data}.en`);
  const nstart = b.op1(NOT, [start]);
  b.wire(b.op1(AND, [nrst, b.op1(OR, [start, b.op1(AND, [`${run}.q`, b.op1(NOT, [fin])])])], 'run next'), `${run}.d`);
  b.wire(b.op1(andN(3), [nrst, nstart, b.op1(XOR, [`${phase}.q`, step])], 'phase next'), `${phase}.d`);
  b.wire(b.op1(andN(4), [nrst, nstart, b.op1(NOT, [we[3]]), b.op1(OR, [`${irq}.q`, fin])], 'irq next'), `${irq}.d`);
  const R = b.right;
  const ins: PortDef[] = [bit('cw', 'in'), bus('ca', 2, 'in'), bus('cd', 16, 'in'), clkIn(), bit('rst', 'in'), bit('mr', 'in'), bus('mq', 16, 'in')];
  const outs: PortDef[] = [bit('mv', 'out'), bus('ma', 16, 'out'), bus('md', 16, 'out'), bit('mw', 'out'), bit('irq', 'out'), bit('busy', 'out')];
  return define({
    id: `rv16_dma${fault ? `_${fault}` : ''}`, name: 'DMA engine (RV16)', category: 'memory',
    summary: 'A bus master copying len words from src to dst, a read and a write per word, each held until ready; configured by writes to its registers (0 src, 1 dst, 2 len and start, 3 clear irq); irq when the last word is written.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'DMA' },
    netlist: () => ({ pins: { ...pinsAt(ins.map((p) => p.name), 0), ...pinsAt(outs.map((p) => p.name), R) }, instances: b.instances, nets: b.nets() }),
  });
});
export const DMA16 = dmaOf();

// ---- m_flash: a page store over flash ----------------------------------------------------------------------

/**
 * Eight logical pages over a flash chip of 4 blocks × 4 one-word pages, written as a log. A mapping table (8 × 4
 * bits) says where each logical page lives; a write programs the next free page at the head, with the logical page
 * number in the page's spare area (its tag), and points the table at it. When the head enters a new block, the block
 * after it is collected: each of its pages is read, and copied to the head if the table still points at it (its
 * tag says whose it was); then the block is erased, and is the spare when the head gets there. The table and the head
 * move when a program is issued, while the tag is still on fq. With fault 'nogc' it never collects (the chip must
 * then refuse a program into a page that holds data).
 */
export const flashOf = (fault?: 'nogc'): ComponentDef => once(`flash${fault ?? ''}`, () => {
  const b = new Builder(10, 12, 4);
  b.pins('lpage', 'wd', 'we', 're', 'clk', 'rst', 'fbusy', 'fq', 'fqt');
  const nrst = b.op1(NOT, ['rst']);
  const free = b.op1(NOT, ['fbusy'], 'chip free');
  const tq = b.op(splitter([3, 1], 2), ['fqt'], 'tag | erased');
  b.next();
  // state: one flip-flop per waiting state (none set: idle), the pending collection, head, victim block and page
  const st = ['rw', 'pw', 'gr', 'grw', 'gpw', 'ge', 'gew'].map((s) => b.add(RV16_DFF, s.toUpperCase(), `s_${s}`));
  const gcp = b.add(RV16_DFF, 'collect next', 'gcp');
  const hp = b.add(RV16_REG4, 'head', 'hp');
  const gi = [0, 1].map((i) => b.add(RV16_DFFE, i ? undefined : 'victim page', `gi${i}`));
  const vb = [0, 1].map((i) => b.add(RV16_DFFE, i ? undefined : 'victim block', `vb${i}`));
  for (const r of [...st, gcp, hp, ...gi, ...vb]) b.wire('clk', `${r}.clk`);
  const map = Array.from({ length: 8 }, (_, i) => b.add(RV16_REG4, i ? undefined : 'mapping table', `l2p${i}`));
  for (const r of map) b.wire('clk', `${r}.clk`);
  const [rw, pw, gr, grw, gpw, ge, gew] = st.map((r) => `${r}.q`);
  b.next();
  const idle = b.op1(NOT, [b.op1(OR, [b.op1(orN(4), [rw, pw, gr, grw]), b.op1(orN(3), [gpw, ge, gew])])], 'idle');
  const idx = b.op1(busMux2(3), ['lpage', `${tq}.o0`, grw], 'whose page');
  const entry = b.op1(muxTree(3, 4), [...map.map((r) => `${r}.q`), idx], 'where it lives');
  const vpage = b.op1(merger([1, 1, 2], 2), [`${gi[0]}.q`, `${gi[1]}.q`, b.op1(merger([1, 1], 2), [`${vb[0]}.q`, `${vb[1]}.q`])], 'victim page');
  const live = b.op1(AND, [b.op1(NOT, [`${tq}.o1`]), b.op1(equal(4), [entry, vpage], 'still mapped?')], 'live');
  b.next();
  const goGC = fault ? b.op1(constWord(1, 0), [], 'never') : b.op1(AND, [idle, `${gcp}.q`], 'collect');
  const ask = b.op1(AND, [idle, b.op1(NOT, [goGC])]);
  const goRd = b.op1(AND, [ask, 're'], 'read');
  const goWr = b.op1(andN(3), [ask, 'we', b.op1(NOT, ['re'])], 'write');
  const grFree = b.op1(AND, [grw, free]);
  const gcProg = b.op1(AND, [grFree, live], 'copy');
  const prog = b.op1(OR, [goWr, gcProg], 'PROG');
  const read = b.op1(OR, [goRd, gr], 'READ');
  const pageDone = b.op1(OR, [b.op1(AND, [grFree, b.op1(NOT, [live])]), b.op1(AND, [gpw, free])], 'page done');
  const last = b.op1(AND, [`${gi[0]}.q`, `${gi[1]}.q`], 'last page');
  b.next();
  // the chip
  b.wire(b.op1(merger([1, 1], 2), [b.op1(OR, [read, ge]), b.op1(OR, [prog, ge])], 'fcmd'), 'fcmd');
  b.wire(b.op1(busMux2(4), [b.op1(busMux2(4), [vpage, entry, goRd]), `${hp}.q`, prog], 'page'), 'fa');
  b.wire(b.op1(MUX16, ['wd', 'fq', grw], 'word'), 'fd');
  b.wire(idx, 'ft');
  b.wire(b.op1(AND, [b.op1(OR, [rw, pw]), free], 'ready'), 'ready');
  b.wire('fq', 'rd');
  // next state
  const hold = (s: string, enter: string) => b.op1(AND, [nrst, b.op1(OR, [enter, b.op1(AND, [s, 'fbusy'])])]);
  b.wire(hold(rw, goRd), `${st[0]}.d`);
  b.wire(hold(pw, goWr), `${st[1]}.d`);
  b.wire(b.op1(AND, [nrst, b.op1(OR, [goGC, b.op1(AND, [pageDone, b.op1(NOT, [last])])])]), `${st[2]}.d`);
  b.wire(hold(grw, gr), `${st[3]}.d`);
  b.wire(hold(gpw, gcProg), `${st[4]}.d`);
  b.wire(b.op1(andN(3), [nrst, pageDone, last]), `${st[5]}.d`);
  b.wire(hold(gew, ge), `${st[6]}.d`);
  const hinc = b.op(incrementer(4), [`${hp}.q`], '+1');
  const hb = b.op(splitter([1, 1, 2], 2), [`${hp}.q`]);
  b.wire(b.op1(bitwise('and', 4), [`${hinc}.y`, b.op1(fanout(4), [nrst])], '0 on reset'), `${hp}.d`);
  b.wire(b.op1(OR, [prog, 'rst']), `${hp}.en`);
  const wrap = b.op1(andN(3), [prog, `${hb}.o0`, `${hb}.o1`], 'block full');
  b.wire(b.op1(andN(3), [nrst, b.op1(NOT, [goGC]), b.op1(OR, [`${gcp}.q`, wrap])], 'collect next'), `${gcp}.d`);
  // victim page: 0 when a collection starts, + 1 after each page; victim block: the one after the head's
  const ngc = b.op1(NOT, [goGC]), gEn = b.op1(OR, [goGC, pageDone]);
  b.wire(b.op1(AND, [ngc, b.op1(NOT, [`${gi[0]}.q`])]), `${gi[0]}.d`);
  b.wire(b.op1(AND, [ngc, b.op1(XOR, [`${gi[0]}.q`, `${gi[1]}.q`])]), `${gi[1]}.d`);
  for (const r of gi) b.wire(gEn, `${r}.en`);
  const hbs = b.op(splitter([1, 1], 2), [`${hb}.o2`]);
  b.wire(b.op1(NOT, [`${hbs}.o0`]), `${vb[0]}.d`);
  b.wire(b.op1(XOR, [`${hbs}.o0`, `${hbs}.o1`]), `${vb[1]}.d`);
  for (const r of vb) b.wire(goGC, `${r}.en`);
  // the table: entry idx ← head when a program is issued
  const sel = b.op(decoder(3, true), [idx, prog], 'which entry');
  map.forEach((r, i) => { b.wire(`${hp}.q`, `${r}.d`); b.wire(`${sel}.y${i}`, `${r}.en`); });
  const R = b.right;
  const ins: PortDef[] = [bus('lpage', 3, 'in'), bus('wd', 16, 'in'), bit('we', 'in'), bit('re', 'in'), clkIn(), bit('rst', 'in'), bit('fbusy', 'in'), bus('fq', 16, 'in'), bus('fqt', 4, 'in')];
  const outs: PortDef[] = [bit('ready', 'out'), bus('rd', 16, 'out'), bus('fcmd', 2, 'out'), bus('fa', 4, 'out'), bus('fd', 16, 'out'), bus('ft', 3, 'out')];
  return define({
    id: `rv16_flashstore${fault ? `_${fault}` : ''}`, name: 'Flash page store (RV16)', category: 'memory',
    summary: 'Eight logical pages over 16 flash pages, written as a log: a mapping table, a head that programs the next erased page (the logical page number in its spare area), and a collector that copies the live pages of the block after the head and erases it.',
    ports: [...ins, ...outs], symbol: { kind: 'box', label: 'FLASH STORE' },
    netlist: () => ({ pins: { ...pinsAt(ins.map((p) => p.name), 0), ...pinsAt(outs.map((p) => p.name), R) }, instances: b.instances, nets: b.nets() }),
  });
});
export const FLASH_STORE16 = flashOf();
