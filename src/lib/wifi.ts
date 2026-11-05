// Wi-Fi's MAC timing in gates: one station's DCF at 1 clock = 1 µs (comm/wifi.ts is its golden model, step() its specification), and a small cell of stations for the chapter's scene. The air between
// them is a model, driven from outside: carrier sense and what was received are inputs.

import { ACK_US, DIFS_US, KIND_ACK, KIND_CTS, KIND_DATA, KIND_RTS, LFSR_BITS, RESP_TIMEOUT, RETRY_LIMIT, RTS_US, SIFS_US, SLOT_US, W_BO, W_DIFS, W_DSIFS, W_IDLE, W_RESP, W_RSIFS, W_RTS, W_TX, W_WAIT, W_WCTS } from '../comm/wifi';
import { symbolGeom } from '../sim/geometry';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { define } from './define';
import { Rtl, type Sig } from './rtl';

const regs = (m: Rtl, clk: Sig, name: string, n: number): Sig[] => Array.from({ length: n }, (_, i) => m.reg(clk, `${name}${i}`));
const cbits = (m: Rtl, v: number, n: number): Sig[] => Array.from({ length: n }, (_, i) => m.const(((v >> i) & 1) as 0 | 1));
const gateN = (m: Rtl, en: Sig, a: Sig[]): Sig[] => a.map((x) => m.and(en, x));
const pick = (m: Rtl, rows: [Sig, Sig[]][]): Sig[] => rows[0][1].map((_, i) => m.orN(rows.map(([c, v]) => m.and(c, v[i]))));
const notN = (m: Rtl, a: Sig[]): Sig[] => a.map((x) => m.not(x));
const dec = (m: Rtl, a: Sig[]): Sig[] => notN(m, m.inc(notN(m, a)));
function gtBits(m: Rtl, a: Sig[], b: Sig[]): Sig {
  let gt = m.const(0);
  a.forEach((x, i) => { gt = m.or(m.and(x, m.not(b[i])), m.and(m.xnor(x, b[i]), gt)); });
  return gt;
}

let staDef: ComponentDef | undefined;
export function dcfStation(): ComponentDef {
  if (staDef) return staDef;
  const m = new Rtl({
    id: 'wifi_dcf', name: 'Wi-Fi station (DCF)', category: 'sequential', label: 'DCF',
    summary: '802.11\'s distributed coordination function at 1 clock = 1 µs: wait DIFS on a quiet medium, count a random backoff down in slots, send, wait for an ACK; on a timeout double the contention window and try again. Answers data with an ACK after SIFS. Carrier sense, the NAV and optional RTS / CTS. What is on the air is an input: the air is a model.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), seed = m.inputBus('seed', LFSR_BITS), pending = m.input('pending'), len = m.inputBus('len', 11), useRts = m.input('use_rts');
  const busy = m.input('busy'), rxData = m.input('rx_data'), rxAck = m.input('rx_ack'), rxRts = m.input('rx_rts'), rxCts = m.input('rx_cts'), navLoad = m.input('nav_load'), navVal = m.inputBus('nav_val', 11);
  const rstn = m.not(rst);
  const inS = <T>(n: string, l: string, f: () => T): T => m.rootScope(n, l, f);
  const st = inS('fsm', 'state', () => regs(m, clk, 'st', 4)), cnt = inS('tm', 'timer', () => regs(m, clk, 'cnt', 11));
  const bo = inS('bk', 'backoff', () => regs(m, clk, 'bo', 10)), cw = inS('bk', 'backoff', () => regs(m, clk, 'cw', 10)), retry = inS('bk', 'backoff', () => regs(m, clk, 'retry', 3)), lfsr = inS('bk', 'backoff', () => regs(m, clk, 'lfsr', LFSR_BITS));
  const nav = inS('nv', 'NAV', () => regs(m, clk, 'nav', 11)), drawn = inS('fsm', 'state', () => m.reg(clk, 'drawn')), respCts = inS('fsm', 'state', () => m.reg(clk, 'resp_cts'));

  m.within('fsm', 'state');
  const is = (v: number) => m.eqConst(st, v);
  const sIdle = is(W_IDLE), sDifs = is(W_DIFS), sBo = is(W_BO), sTx = is(W_TX), sWait = is(W_WAIT), sRs = is(W_RSIFS), sResp = is(W_RESP), sRts = is(W_RTS), sWc = is(W_WCTS), sDs = is(W_DSIFS);
  const at = (v: number) => m.eqConst(cnt, v);
  const navNz = m.orN(nav), vb = m.name(m.or(busy, navNz), 'vbusy');
  const hit = m.name(m.or(rxData, rxRts), 'rx_for_me');
  const open = m.orN([sIdle, sDifs, sBo]), toSifs = m.name(m.and(open, hit), 'to_sifs');
  const nHit = m.not(hit);
  const wantTimeout = at(RESP_TIMEOUT - 1);
  const waitFail = m.andN([sWait, m.not(rxAck), wantTimeout]), ctsFail = m.andN([sWc, m.not(rxCts), wantTimeout]);
  const fail = m.name(m.or(waitFail, ctsFail), 'fail');
  const last = m.eqConst(retry, RETRY_LIMIT - 1);
  const drop = m.name(m.and(fail, last), 'drop_i'), retryOn = m.name(m.and(fail, m.not(last)), 'retry_on');
  const done = m.name(m.and(sWait, rxAck), 'done_i');
  const draw = m.name(m.andN([sIdle, nHit, pending]), 'draw');
  const difsEnd = m.andN([sDifs, nHit, m.not(vb), at(DIFS_US - 1)]);
  const boBusy = m.andN([sBo, nHit, vb]), boZero = m.not(m.orN(bo)), boGo = m.andN([sBo, nHit, m.not(vb), boZero]);
  const slotEnd = m.andN([sBo, nHit, m.not(vb), m.not(boZero), at(SLOT_US - 1)]);
  const rtsEnd = m.and(sRts, at(RTS_US - 1)), ctsOk = m.and(sWc, rxCts), dsEnd = m.and(sDs, at(SIFS_US - 2));
  const lenEq = m.eq(m.inc(cnt), len), txEnd = m.and(sTx, lenEq), rsEnd = m.and(sRs, at(SIFS_US - 2)), respEnd = m.and(sResp, at(ACK_US - 1));
  const toIdle = m.orN([done, drop, m.and(respEnd, m.not(drawn))]);
  const toDifs = m.orN([draw, boBusy, retryOn, m.and(respEnd, drawn)]);
  const toBo = difsEnd;
  const toTx = m.or(m.and(boGo, m.not(useRts)), dsEnd), toRts = m.and(boGo, useRts);
  const toWait = txEnd, toWc = rtsEnd, toDs = ctsOk, toRs = toSifs, toResp = rsEnd;
  const any = m.orN([toIdle, toDifs, toBo, toTx, toRts, toWait, toWc, toDs, toRs, toResp]);
  const k = (v: number) => cbits(m, v, 4);
  const stN = pick(m, [[toDifs, k(W_DIFS)], [toBo, k(W_BO)], [toTx, k(W_TX)], [toRts, k(W_RTS)], [toWait, k(W_WAIT)], [toWc, k(W_WCTS)], [toDs, k(W_DSIFS)], [toRs, k(W_RSIFS)], [toResp, k(W_RESP)], [m.not(any), st]]);
  st.forEach((q, i) => m.setD(q, m.and(rstn, stN[i])));
  m.setD(drawn, m.and(rstn, m.or(draw, m.and(drawn, m.not(m.or(done, drop))))));
  m.setD(respCts, m.and(rstn, m.mux(toSifs, respCts, m.and(m.not(rxData), rxRts))));

  m.within('tm', 'timer');
  const zero = m.orN([sIdle, toSifs, m.andN([sDifs, vb]), difsEnd, boBusy, boGo, slotEnd, rtsEnd, ctsOk, m.and(sWc, wantTimeout), dsEnd, txEnd, done, m.and(sWait, wantTimeout), rsEnd, respEnd]);
  const cntN = gateN(m, m.not(zero), m.inc(cnt));
  cnt.forEach((q, i) => m.setD(q, m.and(rstn, cntN[i])));

  m.within('bk', 'backoff');
  const cwShift = [m.const(1), ...cw.slice(0, 9)];
  const cwN = pick(m, [[m.or(done, drop), cbits(m, 15, 10)], [retryOn, cwShift], [m.nor(m.or(done, drop), retryOn), cw]]);
  cw.forEach((q, i) => m.setD(q, i < 4 ? m.or(rst, cwN[i]) : m.and(rstn, cwN[i])));
  const rnd = lfsr.map((x, i) => m.and(x, cw[i]));
  const rndN = lfsr.map((x, i) => m.and(x, cwShift[i]));
  const boN = pick(m, [[draw, rnd], [retryOn, rndN], [slotEnd, dec(m, bo)], [m.nor(m.or(draw, retryOn), slotEnd), bo]]);
  bo.forEach((q, i) => m.setD(q, m.and(rstn, boN[i])));
  const rtN = pick(m, [[retryOn, m.inc(retry)], [m.not(m.orN([done, drop, retryOn])), retry]]);
  retry.forEach((q, i) => m.setD(q, m.and(rstn, rtN[i])));
  const feedback = m.xor(lfsr[9], lfsr[6]);
  const lN = [feedback, ...lfsr.slice(0, 9)];
  const seedZero = m.not(m.orN(seed));
  lfsr.forEach((q, i) => m.setD(q, m.mux(rst, lN[i], i === 0 ? m.or(seed[0], seedZero) : seed[i])));

  m.within('nv', 'NAV');
  const navD = gateN(m, navNz, dec(m, nav));
  const take = m.and(navLoad, gtBits(m, navVal, navD));
  nav.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(take, navD[i], navVal[i]))));

  m.within('out', 'outputs');
  const txD = sTx;
  m.output('tx', m.orN([txD, sResp, sRts]));
  const kind = pick(m, [[sTx, cbits(m, KIND_DATA, 3)], [sRts, cbits(m, KIND_RTS, 3)], [m.and(sResp, respCts), cbits(m, KIND_CTS, 3)], [m.and(sResp, m.not(respCts)), cbits(m, KIND_ACK, 3)]]);
  m.outputBus('kind', kind);
  m.output('done', done); m.output('drop', drop);
  m.outputBus('st', st); m.outputBus('bo', bo); m.outputBus('cw', cw); m.outputBus('retry', retry); m.outputBus('nav', nav); m.outputBus('cnt', cnt);
  staDef = m.build();
  return staDef;
}

const cells = new Map<number, ComponentDef>();
/** n stations side by side. Their air is outside: every input and output goes straight to the pins with the station's number on it. Built on demand. */
export function wifiCell(n: number): ComponentDef {
  const hit = cells.get(n);
  if (hit) return hit;
  const S = dcfStation(), g = symbolGeom(S);
  const instances: InstanceDef[] = [], nets: NetDef[] = [], ports: PortDef[] = [], pins: Record<string, [number, number]> = {};
  const gap = 10, w = g.w + 2 * gap;
  let iy = 2, oy = 2;
  const portIn = (name: string, width: number) => { ports.push({ name, width, dir: 'in' }); pins[name] = [0, iy]; iy += 2; };
  const portOut = (name: string, width: number) => { ports.push({ name, width, dir: 'out' }); pins[name] = [8 + n * w + 14, oy]; oy += 2; };
  portIn('rst', 1); portIn('len', 11); portIn('use_rts', 1);
  ports.push({ name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true });
  const inputs: [string, number][] = [['seed', LFSR_BITS], ['pending', 1], ['busy', 1], ['rx_data', 1], ['rx_ack', 1], ['rx_rts', 1], ['rx_cts', 1], ['nav_load', 1], ['nav_val', 11]];
  const outs: [string, number][] = [['tx', 1], ['kind', 3], ['done', 1], ['drop', 1], ['st', 4], ['bo', 10], ['cw', 10], ['retry', 3], ['nav', 11], ['cnt', 11]];
  for (let i = 0; i < n; i++) {
    instances.push({ name: `s${i}`, def: S, at: [8 + i * w + gap, 4], label: `Station ${i}` });
    for (const [p, wd] of inputs) { portIn(`${p}${i}`, wd); nets.push({ name: `${p}${i}`, ends: [`${p}${i}`, `s${i}.${p}`], tags: true }); }
    for (const [p, wd] of outs) { portOut(`${p}${i}`, wd); nets.push({ name: `${p}${i}`, ends: [`s${i}.${p}`, `${p}${i}`], tags: true }); }
  }
  pins.clk = [0, iy + 2];
  nets.push({ name: 'clk', ends: ['clk', ...instances.map((x) => `${x.name}.clk`)], tags: true }, { name: 'rst', ends: ['rst', ...instances.map((x) => `${x.name}.rst`)], tags: true }, { name: 'len', ends: ['len', ...instances.map((x) => `${x.name}.len`)], tags: true }, { name: 'use_rts', ends: ['use_rts', ...instances.map((x) => `${x.name}.use_rts`)], tags: true });
  const d = define({
    id: `wifi_cell${n}`, name: `A cell of ${n} stations`, category: 'sequential',
    summary: `${n} stations, each its own DCF. The air between them is outside this box: a model of who hears whom, which drives their carrier sense and reports what arrived whole.`,
    ports, symbol: { kind: 'box', label: 'Cell' },
    netlist: () => ({ pins, instances, nets }),
  });
  cells.set(n, d);
  return d;
}
