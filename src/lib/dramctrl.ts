// Chapter memctrl's DRAM controller at gate level, and the DRAM device behind it. The controller is
// dram/controller.ts's CtrlModel in gates, cycle for cycle (tests/dramctrl.test.ts runs both side by
// side): seven state flip-flops (IDLE is none of them set, so power-on needs no reset), one wait
// counter loaded by every command, an open-row table (a valid bit and a row register per bank), the
// latched request, and a refresh counter. The device is DeviceModel as a behavioural leaf: the data,
// and every timing rule, checked.

import { type CtrlModel, Cmd, DeviceModel, deviceIn, type DramConfig, fieldWidths, MAX_POSTPONE } from '../dram/controller';
import { TIMING } from '../dram/timing';
import type { ComponentDef, PortDef } from '../sim/types';
import { constWord, isZero } from './alu';
import { laid, type LayeredOptions } from './layered';
import { Builder } from './builder';
import { andN, busMux2, decoder, equal, incrementer, muxTree } from './combinational';
import { parity } from './coding';
import { define, merger, ones, splitter } from './define';
import { AND, MUX2, NOT, OR, XNOR, XOR } from './gates';
import { DFF, register } from './sequential';
import { TIE0, TIE1 } from './transistors';
import { bitwise, orN } from './wide';

const bit = (name: string, dir: 'in' | 'out', side?: PortDef['side'], clock?: boolean): PortDef => ({ name, width: 1, dir, side, clock });
const bus = (name: string, width: number, dir: 'in' | 'out', side?: PortDef['side']): PortDef => ({ name, width, dir, side });

const cache = new Map<string, ComponentDef>();
function memo(key: string, f: () => ComponentDef): ComponentDef {
  let d = cache.get(key);
  if (!d) cache.set(key, (d = f()));
  return d;
}

/** A memo key for a configuration: geometry, policy, hash, and the timing when it is not the standard one. */
export const cfgKey = (c: DramConfig) => {
  const t = c.t, std = !t || (Object.keys(TIMING) as (keyof typeof TIMING)[]).every((k) => t[k] === TIMING[k]);
  return `${c.k}_${c.banks}_${c.rowWords}_${c.policy === 'open' ? 'o' : 'c'}${c.hash ? 'h' : ''}${std ? '' : `_t${Object.values(t!).join('.')}`}`;
};
const bitsFor = (v: number) => Math.max(1, Math.ceil(Math.log2(v + 1)));

/** Small helpers over a Builder: gates of any arity, buses of any width (1 included). */
function kit(b: Builder) {
  const and = (...xs: string[]) => (xs.length === 1 ? xs[0] : xs.length === 2 ? b.op1(AND, xs) : b.op1(andN(xs.length), xs));
  const or = (...xs: string[]) => (xs.length === 1 ? xs[0] : xs.length === 2 ? b.op1(OR, xs) : b.op1(orN(xs.length), xs));
  const not = (x: string) => b.op1(NOT, [x]);
  const mux = (w: number, a: string, c: string, s: string, label?: string) => b.op1(w === 1 ? MUX2 : busMux2(w), [a, c, s], label);
  const eq = (w: number, a: string, c: string, label?: string) => b.op1(w === 1 ? XNOR : equal(w), [a, c], label);
  const split = (x: string, ws: number[]): string[] => {
    if (ws.length === 1) return [x];
    const s = b.op(splitter(ws), [x]);
    return ws.map((_, i) => `${s}.o${i}`);
  };
  const merge = (xs: string[], ws: number[]): string => (xs.length === 1 ? xs[0] : b.op1(merger(ws), xs));
  const konst = (w: number, v: number) => b.op1(constWord(w, v), []);
  return { and, or, not, mux, eq, split, merge, konst };
}

/**
 * The controller for a DramConfig (2 or more banks): request in (req held until done, wr, the line
 * address la), commands out (cmd, ba, ra, ca), and the burst's handshake to the cache: word, dv (a
 * read word is on the device's rd), wv (the device takes the cache's word now), done. hit / miss /
 * conflict pulse in the cycle a request starts.
 */
export function dramCtrl(c: DramConfig): ComponentDef {
  const id = `dramctrl${cfgKey(c)}`;
  return memo(id, () => {
    const t = c.t ?? TIMING, { cb, bb, rb } = fieldWidths(c), B = c.banks, la = c.k - 2;
    if (bb < 1) throw new Error('dramCtrl: at least 2 banks');
    const cw = bitsFor(Math.max(t.tRFC, t.tCAS + 3)), rw = bitsFor(t.tREFI);
    const key = cfgKey(c);
    // Six blocks a reader opens one at a time (the chapter names them): the request, the state machine, the commands, the
    // wait counter, the refresh counter and the open-row table. Each gate is the one the flat drawing had, moved into the
    // block that owns it, so the NANDs, the depth and the behaviour are the same (tests/dramctrl.test.ts pins them).
    const block = (name: string, label: string, summary: string, ports: PortDef[], build: (b: Builder, g: ReturnType<typeof kit>) => Record<string, boolean> | void, wires?: Record<string, boolean>, opts: LayeredOptions = {}) =>
      memo(`dramctrl_${name}${key}`, () => {
        const b = new Builder(18, 14);
        b.pins(...ports.filter((p) => p.dir === 'in').map((p) => p.name));
        const own = build(b, kit(b)) ?? {};
        return define({ id: `dramctrl_${name}${key}`, name: `DRAM controller: ${label}`, category: 'memory', summary, ports, symbol: { kind: 'box', label: label.toUpperCase() }, netlist: laid(b, { aspect: 1.6, room: true, keepOrder: true, ...opts, wires: { ...wires, ...own } }) });
      });

    // the request: its fields as the device sees them (with the XOR hash, the row's parity flips the bank), latched when it is
    // accepted (later commands use it: the cache may move on); while idle the new request's fields go out, else the latched ones
    const REQ = block('req', 'request', 'The request\'s fields (column, bank, row), latched when it is accepted; while idle the new request\'s go out, else the latched one\'s.', [
      bit('wr', 'in'), bus('la', la, 'in'), bit('en', 'in'), bit('idle', 'in'), bit('clk', 'in', 'bottom', true),
      bus('lbank', bb, 'out'), bus('lrow', rb, 'out'), bit('cwr', 'out'), bus('cbank', bb, 'out'), bus('crow', rb, 'out'), bit('isWr', 'out'),
      bus('ba', bb, 'out'), bus('ra', rb, 'out'), bus('ca', cb, 'out'),
    ], (b, g) => {
      const [lcol, lbank0, lrow] = g.split('la', [cb, bb, rb]);
      let lbank = lbank0;
      if (c.hash) {
        const p = rb === 1 ? lrow : b.op1(parity(rb), [lrow], 'row parity');
        const bs = g.split(lbank0, bb === 1 ? [1] : [1, bb - 1]);
        const x = b.op1(XOR, [bs[0], p], 'bank hash');
        lbank = bb === 1 ? x : g.merge([x, bs[1]], [1, bb - 1]);
      }
      b.name(lcol, 'col'); b.name(lbank, 'bank'); b.name(lrow, 'row');
      b.next();
      const cur = b.op(register(1 + cb + bb + rb), [g.merge(['wr', lcol, lbank, lrow], [1, cb, bb, rb]), 'en', 'clk'], 'request', 'cur');
      const [cwr, ccol, cbank, crow] = g.split(`${cur}.q`, [1, cb, bb, rb]);
      b.next();
      b.wire(g.mux(1, cwr, 'wr', 'idle'), 'isWr');
      b.wire(g.mux(bb, cbank, lbank, 'idle', 'ba'), 'ba');
      b.wire(g.mux(rb, crow, lrow, 'idle', 'ra'), 'ra');
      b.wire(g.mux(cb, ccol, lcol, 'idle', 'ca'), 'ca');
      b.wire(lbank, 'lbank'); b.wire(lrow, 'lrow'); b.wire(cwr, 'cwr'); b.wire(cbank, 'cbank'); b.wire(crow, 'crow');
      // the address's fields run as wires to the latch and the muxes beside them
      return Object.fromEntries([lcol, lbank, lrow].map((x) => [x, true]));
    });

    // the state machine: seven flip-flops, IDLE when none is set
    const NAMES = ['WPRE', 'WACT', 'BURST', 'CLOSE', 'WCLOSE', 'WREF1', 'WREF2'];
    // drawn next state first: the register and what reads it moved past the next-state gates, its outputs fed back
    const SHIFT = 5;
    const FSM = block('fsm', 'state machine', 'Seven state flip-flops, one set at a time (IDLE when none is): waiting after PRE, after ACT, the burst, closing (closed page), waiting after PREA and after REF.', [
      bit('conflict', 'in'), bit('cACT', 'in'), bit('cRW', 'in'), bit('done', 'in'), bit('cPREA', 'in'), bit('cREF', 'in'), bit('z', 'in'), bit('clk', 'in', 'bottom', true),
      bit('idle', 'out'), bit('WPRE', 'out'), bit('WACT', 'out'), bit('BURST', 'out'), bit('CLOSE', 'out'), bit('WREF1', 'out'),
    ], (b, g) => {
      const st = b.op(register(7), ['', b.op1(TIE1, [], undefined, 'one'), 'clk'], 'state', 'st');
      const sqS = b.op(splitter(ones(7)), [`${st}.q`], undefined, 'sq'), sq = NAMES.map((_, i) => `${sqS}.o${i}`);
      const S: Record<string, string> = {};
      NAMES.forEach((n, i) => (S[n] = b.name(sq[i], n, true)));
      b.wire(b.name(b.op1(NOT, [b.op1(orN(7), sq, undefined, 'anyst')], 'IDLE = none', 'idleN'), 'IDLE', true), 'idle');
      b.next();
      const stay = (n: string) => g.and(S[n], g.not('z'));
      const nx: Record<string, string> = {
        WPRE: g.or('conflict', stay('WPRE')),
        WACT: g.or('cACT', stay('WACT')),
        BURST: g.or('cRW', stay('BURST')),
        CLOSE: c.policy === 'closed' ? 'done' : b.op1(TIE0, []),
        WCLOSE: g.or(S.CLOSE, stay('WCLOSE')),
        WREF1: g.or('cPREA', stay('WREF1')),
        WREF2: g.or('cREF', stay('WREF2')),
      };
      b.wire(g.merge(NAMES.map((n) => nx[n]), ones(7)), `${st}.d`);
      for (const n of ['WPRE', 'WACT', 'BURST', 'CLOSE', 'WREF1']) b.wire(S[n], n);
    }, undefined, { column: { one: SHIFT, st: SHIFT, sq: SHIFT, anyst: SHIFT + 1, idleN: SHIFT + 1 } });

    // the commands, from the state and the request: accept, the row lookup's verdict, the command, the burst's handshake
    const CMD = block('cmd', 'commands', 'The command this cycle (PREA, REF, ACT, PRE, RD, WR) from the state and the request; hit / miss / conflict when a request is accepted; the burst\'s word count and data valid.', [
      bit('req', 'in'), bit('idle', 'in'), bit('refPend', 'in'), bit('open', 'in'), bit('same', 'in'), bit('anyOpen', 'in'),
      bit('WPRE', 'in'), bit('WACT', 'in'), bit('BURST', 'in'), bit('CLOSE', 'in'), bit('WREF1', 'in'), bit('z', 'in'), bit('isWr', 'in'), bit('cwr', 'in'), bus('count', cw, 'in'),
      bit('accept', 'out'), bit('hit', 'out'), bit('miss', 'out'), bit('conflict', 'out'), bit('cPREA', 'out'), bit('cREF', 'out'), bit('cRW', 'out'), bit('cACT', 'out'), bit('cPRE', 'out'),
      bus('cmd', 3, 'out'), bus('word', 2, 'out'), bit('dv', 'out'), bit('wv', 'out'), bit('done', 'out'),
    ], (b, g) => {
      const accept = b.name(g.and('idle', g.not('refPend'), 'req'), 'accept', true);
      const hit = b.name(g.and(accept, 'open', 'same'), 'hit', true);
      const conflict = b.name(g.and(accept, 'open', g.not('same')), 'conflict', true);
      const miss = b.name(g.and(accept, g.not('open')), 'miss', true);
      const cPREA = b.name(g.and('idle', 'refPend', 'anyOpen'), 'PREA', true);
      const cREF = b.name(g.or(g.and('idle', 'refPend', g.not('anyOpen')), g.and('WREF1', 'z')), 'REF', true);
      const cRW = b.name(g.or(hit, g.and('WACT', 'z')), 'RW', true);
      const cACT = b.name(g.or(miss, g.and('WPRE', 'z')), 'ACT', true);
      const cPRE = b.name(g.or(conflict, 'CLOSE'), 'PRE', true);
      const cRD = g.and(cRW, g.not('isWr')), cWR = g.and(cRW, 'isWr');
      b.next();
      b.wire(g.merge([g.or(cACT, cWR, cPREA), g.or(cRD, cWR, cREF), g.or(cPRE, cPREA, cREF)], [1, 1, 1]), 'cmd');
      // the burst: data in the last four counts, word = 3 − count
      const high = g.split('count', [2, cw - 2]);
      const inData = b.name(g.and('BURST', b.op1(isZero(cw - 2), [high[1]])), 'data', true);
      const lo = g.split(high[0], [1, 1]);
      b.wire(g.merge([g.not(lo[0]), g.not(lo[1])], [1, 1]), 'word');
      b.wire(g.and(inData, g.not('cwr')), 'dv');
      b.wire(g.and(inData, 'cwr'), 'wv');
      b.wire(b.name(g.and('BURST', 'z'), 'done', true), 'done');
      for (const [s, o] of [[accept, 'accept'], [hit, 'hit'], [miss, 'miss'], [conflict, 'conflict'], [cPREA, 'cPREA'], [cREF, 'cREF'], [cRW, 'cRW'], [cACT, 'cACT'], [cPRE, 'cPRE']]) b.wire(s, o);
    });

    // the wait counter: every command loads its wait, else down to 0
    const WAIT = block('wait', 'wait counter', 'The cycles left before the next command may go: every command loads its timing (tRP, tRFC, tCAS, tRCD), else it counts down to 0.', [
      bit('cPREA', 'in'), bit('cREF', 'in'), bit('cRW', 'in'), bit('cACT', 'in'), bit('cPRE', 'in'), bit('conflict', 'in'), bit('CLOSE', 'in'), bit('clk', 'in', 'bottom', true),
      bus('count', cw, 'out'), bit('z', 'out'),
    ], (b, g) => {
      const cnt = b.op(register(cw), ['', b.op1(TIE1, [], undefined, 'one'), 'clk'], 'wait counter', 'cnt');
      const cq = b.name(`${cnt}.q`, 'count', true);
      const z = b.name(b.op1(isZero(cw), [cq], '= 0'), 'z', true);
      b.next();
      const loads: [string, number][] = [['cPREA', t.tRP - 1], ['cREF', t.tRFC - 2], ['cRW', t.tCAS + 2], ['cACT', t.tRCD - 1], ['conflict', t.tRP - 1], ['CLOSE', t.tRP - 2]];
      const L = g.merge(Array.from({ length: cw }, (_, j) => {
        const on = loads.filter(([, v]) => (v >> j) & 1).map(([s]) => s);
        return on.length ? g.or(...on) : b.op1(TIE0, []);
      }), ones(cw));
      const load = b.name(g.or('cPREA', 'cREF', 'cRW', 'cACT', 'cPRE'), 'load', true);
      const allOnes = g.konst(cw, 2 ** cw - 1);
      const dec = b.op1(bitwise('xor', cw), [b.op1(incrementer(cw), [b.op1(bitwise('xor', cw), [cq, allOnes])]), allOnes], '− 1');
      const nz = g.not(z);
      const held = b.op1(bitwise('and', cw), [dec, g.merge(Array.from({ length: cw }, () => nz), ones(cw))]);
      b.wire(g.mux(cw, held, L, load, 'next count'), `${cnt}.d`);
      b.wire(cq, 'count'); b.wire(z, 'z');
      return { cPREA: true };
    });

    // refresh: every tREFI cycles a refresh is due, and stays due until REF goes out
    const REF = block('refresh', 'refresh counter', `Counts to tREFI (${t.tREFI} cycles) and sets "refresh due", which REF clears.`, [
      bit('cREF', 'in'), bit('clk', 'in', 'bottom', true), bit('refPend', 'out'),
    ], (b, g) => {
      const refCnt = b.op(register(rw), ['', b.op1(TIE1, [], undefined, 'one'), 'clk'], 'refresh counter', 'rc');
      const pend = b.op(DFF, ['', 'clk'], 'refresh pending', 'pend');
      const refPend = b.name(`${pend}.q`, 'refPend', true);
      b.next();
      const wrap = b.name(g.eq(rw, `${refCnt}.q`, g.konst(rw, t.tREFI - 1), 'tREFI − 1'), 'refDue', true);
      const rinc = b.op1(incrementer(rw), [`${refCnt}.q`]);
      b.wire(b.op1(bitwise('and', rw), [rinc, g.merge(Array.from({ length: rw }, () => g.not(wrap)), ones(rw))]), `${refCnt}.d`);
      b.wire(g.or(g.and(refPend, g.not('cREF')), wrap), `${pend}.d`);
      b.wire(refPend, 'refPend');
    }, { 'rc.q': true });

    // the open-row table: per bank a valid bit and the open row, following ACT / PRE / PREA on the selected bank
    const ROWS = block('rows', 'open-row table', 'Per bank whether a row is open and which: looked up for the new request (open, same row), set by ACT, cleared by PRE and PREA.', [
      bus('lbank', bb, 'in'), bus('lrow', rb, 'in'), bus('cbank', bb, 'in'), bus('crow', rb, 'in'), bit('idle', 'in'), bit('cACT', 'in'), bit('cPRE', 'in'), bit('cPREA', 'in'), bit('clk', 'in', 'bottom', true),
      bit('open', 'out'), bit('same', 'out'), bit('anyOpen', 'out'),
    ], (b, g) => {
      const valid: string[] = [], rows: string[] = [];
      for (let k = 0; k < B; k++) {
        valid.push(b.name(`${b.op(DFF, ['', 'clk'], `bank ${k} open`, `v${k}`)}.q`, `open${k}`, true));
        rows.push(`${b.op(register(rb), ['', '', 'clk'], `bank ${k} row`, `r${k}`)}.q`);
      }
      b.next();
      const vSel = bb === 1 ? g.mux(1, valid[0], valid[1], 'lbank') : b.op1(muxTree(bb, 1), [...valid, 'lbank']);
      const rSel = bb === 1 ? g.mux(rb, rows[0], rows[1], 'lbank', 'open row') : b.op1(muxTree(bb, rb), [...rows, 'lbank'], 'open row');
      b.wire(g.eq(rb, rSel, 'lrow', 'same row'), 'same');
      b.wire(b.name(g.or(...valid), 'anyOpen', true), 'anyOpen');
      b.wire(vSel, 'open');
      b.next();
      const ba = g.mux(bb, 'cbank', 'lbank', 'idle');
      const dsel = b.op(decoder(bb, false), [ba]);
      for (let k = 0; k < B; k++) {
        const selK = `${dsel}.y${k}`;
        const set = g.and('cACT', selK), clr = g.or(g.and('cPRE', selK), 'cPREA');
        b.wire(g.and(g.or(valid[k], set), g.not(clr)), `v${k}.d`);
        b.wire(g.mux(rb, 'crow', 'lrow', 'idle'), `r${k}.d`);
        b.wire(set, `r${k}.en`);
      }
    });

    // the top level: the controller's block diagram
    const b = new Builder(18, 14);
    b.pins('req', 'wr', 'la', 'clk');
    b.op(REQ, ['wr', 'la', 'cmd.accept', 'fsm.idle', 'clk'], 'request', 'rq');
    b.op(ROWS, ['rq.lbank', 'rq.lrow', 'rq.cbank', 'rq.crow', 'fsm.idle', 'cmd.cACT', 'cmd.cPRE', 'cmd.cPREA', 'clk'], 'open-row table', 'rows');
    b.next();
    b.op(CMD, ['req', 'fsm.idle', 'refresh.refPend', 'rows.open', 'rows.same', 'rows.anyOpen', 'fsm.WPRE', 'fsm.WACT', 'fsm.BURST', 'fsm.CLOSE', 'fsm.WREF1', 'wait.z', 'rq.isWr', 'rq.cwr', 'wait.count'], 'commands', 'cmd');
    b.next();
    b.op(FSM, ['cmd.conflict', 'cmd.cACT', 'cmd.cRW', 'cmd.done', 'cmd.cPREA', 'cmd.cREF', 'wait.z', 'clk'], 'state machine', 'fsm');
    b.op(WAIT, ['cmd.cPREA', 'cmd.cREF', 'cmd.cRW', 'cmd.cACT', 'cmd.cPRE', 'cmd.conflict', 'fsm.CLOSE', 'clk'], 'wait counter', 'wait');
    b.op(REF, ['cmd.cREF', 'clk'], 'refresh counter', 'refresh');
    for (const o of ['cmd', 'word', 'dv', 'wv', 'done', 'hit', 'miss', 'conflict']) b.wire(`cmd.${o}`, o);
    for (const o of ['ba', 'ra', 'ca']) b.wire(`rq.${o}`, o);

    return define({
      id, name: `DRAM controller (${B} banks, ${c.rowWords}-word rows, ${c.policy} page${c.hash ? ', XOR hash' : ''})`, category: 'memory',
      summary: `One 4-word line request at a time. A row hit issues RD / WR at once (${t.tCAS + 4} cycles), a closed bank ACT first (${t.tRCD + t.tCAS + 4}), another open row PRE, ACT (${t.tRP + t.tRCD + t.tCAS + 4}). Every ${t.tREFI} cycles a refresh goes first: precharge all, REF, ${t.tRFC} cycles busy.${c.policy === 'closed' ? ' Closed page: the row is precharged after every access.' : ''}`,
      ports: [bit('req', 'in'), bit('wr', 'in'), bus('la', la, 'in'), bit('clk', 'in', 'bottom', true),
        bus('cmd', 3, 'out'), bus('ba', bb, 'out'), bus('ra', rb, 'out'), bus('ca', cb, 'out'), bus('word', 2, 'out'),
        bit('dv', 'out'), bit('wv', 'out'), bit('done', 'out'), bit('hit', 'out'), bit('miss', 'out'), bit('conflict', 'out')],
      symbol: { kind: 'box', label: 'DRAM CTRL' },
      // a block diagram: request → open-row table → commands → the counters and the state machine, which loop back as labels
      netlist: laid(b, { room: true }),
    });
  });
}

/** The device's state in a simulation: the reference model itself, plus the inputs sampled before the edge. */
interface DevState { dev: DeviceModel; clk: number; pend: { cmd: number; ba: number; ra: number; ca: number; wd: number; dm: number } }

/**
 * A DRAM device for a DramConfig: commands and write data in, read data out (rd, rv: valid; err: a
 * timing rule was broken, sticky). Simulated as DeviceModel (a behavioural leaf whose outputs change
 * only at the clock: no path from an input to an output). With `mask` it has DDR's data mask (dm, a
 * bit per byte of the word written this cycle: chapter bus's bus writes single bytes without a read).
 */
export function dramDevice(c: DramConfig, init?: ArrayLike<number>, mask = false): ComponentDef {
  const key = `dramdev${mask ? 'm' : ''}${cfgKey(c)}`;
  const make = (): ComponentDef => {
    const { cb, bb, rb } = fieldWidths(c);
    const t = c.t ?? TIMING;
    return {
      id: key, name: `DRAM device (${2 ** c.k} words, ${c.banks} banks of ${2 ** rb} rows × ${c.rowWords} words)`, category: 'memory',
      summary: `${mask ? 'With a data mask (dm: a bit per byte of the word written). ' : ''}Banks of rows with a row buffer each. Commands: ACT opens a row (tRCD ${t.tRCD} before a column command), RD / WR move a 4-word burst ${t.tCAS} cycles later, PRE closes a row (tRAS ${t.tRAS} after its ACT, tRP ${t.tRP} before the next ACT), REF every ${t.tREFI} cycles (at most ${MAX_POSTPONE} late) keeps the device busy ${t.tRFC} cycles. A command that breaks a rule sets err, and its data reads X.`,
      ports: [bus('cmd', 3, 'in'), bus('ba', bb, 'in'), bus('ra', rb, 'in'), bus('ca', cb, 'in'), bus('wd', 32, 'in'), ...(mask ? [bus('dm', 4, 'in')] : []), bit('clk', 'in', 'bottom', true),
        bus('rd', 32, 'out'), bit('rv', 'out'), bit('err', 'out')],
      symbol: { kind: 'box', label: 'DRAM' },
      behavior: {
        delay: 4,
        seq: { clk: 'clk', comb: [] },
        init: () => ({ dev: new DeviceModel(c, init), clk: 0, pend: { cmd: 0, ba: 0, ra: 0, ca: 0, wd: 0, dm: 15 } } satisfies DevState),
        eval: (ins, st) => {
          const s = st as DevState;
          const [cmd, ba, ra, ca, wd] = ins, dm = mask ? ins[5] : 15, clk = ins[mask ? 6 : 5];
          const k = clk < 0 ? 2 : clk;
          // an unknown mask writes unknown bytes: as an unknown word
          if (k !== 1) s.pend = { cmd: cmd < 0 ? Cmd.NOP : cmd, ba: Math.max(0, ba), ra: Math.max(0, ra), ca: Math.max(0, ca), wd: dm < 0 ? -1 : wd, dm: dm < 0 ? 15 : dm };
          const p = s.clk;
          s.clk = k;
          if (p === 0 && k === 1) s.dev.edge(s.pend);
          const o = s.dev.out;
          return [o.rd, o.rv ? 1 : 0, o.err ? 1 : 0];
        },
        carry: (prev) => prev,
      },
      hdl: { verilog: '// a DRAM device model: see dram/controller.ts DeviceModel (not synthesizable)' },
    };
  };
  if (init) return make();
  return memo(key, make);
}

/** The device's model inside a simulation (for readers: the CPU panel's memory, tests). */
export const deviceOf = deviceIn;

export type { CtrlModel };

/**
 * Controller and device on one board (chapter memctrl's scenes): a request in (req held until done, wr,
 * la), the burst's words out (rd while dv). Written words are recognizable: {seed, line, word}.
 */
export function dramSystem(c: DramConfig): ComponentDef {
  const id = `dramsys${cfgKey(c)}`;
  return memo(id, () => {
    const { cb, bb, rb } = fieldWidths(c), la = c.k - 2;
    const b = new Builder(10, 16);
    b.pins('req', 'wr', 'la', 'seed', 'clk');
    const ctrl = b.op(dramCtrl(c), ['req', 'wr', 'la', 'clk'], 'controller', 'ctrl');
    b.next();
    const pad = 32 - 8 - 2 - la;
    const wd = b.op1(merger([2, la, pad, 8]), [`${ctrl}.word`, 'la', b.op1(constWord(pad, 0), []), 'seed'], 'write data');
    b.next();
    const dev = b.op(dramDevice(c), [`${ctrl}.cmd`, `${ctrl}.ba`, `${ctrl}.ra`, `${ctrl}.ca`, wd, 'clk'], 'DRAM device', 'dev');
    b.next();
    for (const p of ['cmd', 'dv', 'wv', 'word', 'done', 'hit', 'miss', 'conflict']) b.wire(`${ctrl}.${p}`, p);
    b.wire(`${dev}.rd`, 'rd');
    b.wire(`${dev}.err`, 'err');
    const R = b.right;
    void cb; void bb; void rb;
    const outs = ['rd', 'dv', 'wv', 'word', 'done', 'cmd', 'hit', 'miss', 'conflict', 'err'];
    return define({
      id, name: `DRAM controller and device (${c.banks} banks, ${c.policy} page)`, category: 'memory',
      summary: 'The controller of this chapter driving a DRAM device: raise req with a line address (and wr), clock until done; a read\'s words come out on rd while dv is 1. A write stores {seed, line, word} in each word.',
      ports: [bit('req', 'in'), bit('wr', 'in'), bus('la', la, 'in'), bus('seed', 8, 'in'), bit('clk', 'in', 'bottom', true),
        bus('rd', 32, 'out'), bit('dv', 'out'), bit('wv', 'out'), bus('word', 2, 'out'), bit('done', 'out'), bus('cmd', 3, 'out'), bit('hit', 'out'), bit('miss', 'out'), bit('conflict', 'out'), bit('err', 'out')],
      symbol: { kind: 'box', label: 'DRAM SYSTEM' },
      netlist: () => ({
        pins: { req: [0, 4], wr: [0, 8], la: [0, 12], seed: [0, 16], clk: [0, 22], ...Object.fromEntries(outs.map((o, i) => [o, [R, 4 + 3 * i] as [number, number]])) },
        instances: b.instances, nets: b.nets(),
      }),
    });
  });
}
