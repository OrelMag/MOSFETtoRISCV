// PCI Express in gates, one lane at the symbol level (the chapter's link, comm/pcie.ts its golden model and its header the list of what
// is left out): a port = data link layer + flow control + a subset of the LTSSM, the two transaction-layer ends, and the link
// around them. Everything is NAND gates, the library's flip-flops and bigRam buffers in boxes of their own (lib/rtl.ts).
// The model's step() is the specification: its assignments and this file's setD lines follow each other.

import { ADV_NPH, ADV_PD, ADV_PH, BUF_BITS, CRC32_RESIDUE, DLLP_POLY, DLLP_RESIDUE, EP_MEM_BITS, K_COM, K_END, K_PAD, K_SDP, K_STP, LINE_DELAY, MAX_RX_TLP, N_FTS, REPLAY_LIMIT, REPLAY_SLOTS, TS1_ID, TS2_ID, TS_RATE, FC_PERIOD_BITS, TRAIN_TIMEOUT_BITS } from '../comm/pcie';
import { CRC32_REFLECTED } from '../comm/crc';
import type { ComponentDef, InstanceDef, NetDef, PortDef } from '../sim/types';
import { symbolGeom } from '../sim/geometry';
import { constWord } from './alu';
import { bigRamWithInit } from './bigmem';
import { crcUnit } from './crc';
import { define } from './define';
import { NOT, OR } from './gates';
import { Rtl, type Sig } from './rtl';
import { TIE0, TIE1 } from './transistors';

/** What a port shows on its status bus, in order, for the panel and the tests: name and width. */
export const PORT_STATUS: [string, number][] = [['lt', 3], ['dl', 2], ['kind', 2], ['seq', 12], ['ackd', 12], ['rseq', 12], ['replay', 1], ['rnum', 2], ['nrcv', 12], ['nak', 1], ['ack', 1], ['ph_lim', 8], ['pd_lim', 12], ['nph_lim', 8], ['ph_cc', 8], ['pd_cc', 12], ['nph_cc', 8], ['rt', 9]];
/** The status bus's bits as named values (X reads as −1). */
export function readStatus(bits: ArrayLike<number>): Record<string, number> {
  const o: Record<string, number> = {};
  let at = 0;
  for (const [n, w] of PORT_STATUS) {
    let v = 0;
    for (let i = 0; i < w; i++) { const b = bits[at + i]; if (b !== 0 && b !== 1) v = -1; else if (v >= 0) v += b * 2 ** i; }
    o[n] = v; at += w;
  }
  return o;
}

const regs = (m: Rtl, clk: Sig, name: string, n: number): Sig[] => Array.from({ length: n }, (_, i) => m.reg(clk, n === 1 ? name : `${name}${i}`));
const cbits = (m: Rtl, v: number, n: number): Sig[] => Array.from({ length: n }, (_, i) => m.const(((v / 2 ** i) & 1) as 0 | 1));
const muxN = (m: Rtl, s: Sig, a: Sig[], b: Sig[]): Sig[] => a.map((x, i) => m.mux(s, x, b[i]));
const gateN = (m: Rtl, en: Sig, a: Sig[]): Sig[] => a.map((x) => m.and(en, x));
const orBits = (m: Rtl, parts: Sig[][]): Sig[] => parts[0].map((_, i) => m.orN(parts.map((p) => p[i])));
const zext = (m: Rtl, a: Sig[], n: number): Sig[] => [...a, ...cbits(m, 0, n - a.length)];
/** cond → its value: an AND-OR, conditions mutually exclusive. */
const pick = (m: Rtl, rows: [Sig, Sig[]][]): Sig[] => orBits(m, rows.map(([c, v]) => gateN(m, c, v)));
function add(m: Rtl, a: Sig[], b: Sig[], cin: Sig = m.const(0)): Sig[] {
  let c = cin;
  return a.map((x, i) => {
    const p = m.xor(x, b[i]), s = m.xor(p, c);
    c = m.or(m.and(x, b[i]), m.and(p, c));
    return s;
  });
}
const notN = (m: Rtl, a: Sig[]): Sig[] => a.map((x) => m.not(x));
/** a − b modulo the width. */
const sub = (m: Rtl, a: Sig[], b: Sig[]): Sig[] => add(m, a, notN(m, b), m.const(1));
const dec = (m: Rtl, a: Sig[]): Sig[] => notN(m, m.inc(notN(m, a)));
function geConst(m: Rtl, bits: Sig[], c: number): Sig {
  let ge = m.const(1);
  bits.forEach((b, i) => { ge = (c >> i) & 1 ? m.and(b, ge) : m.or(b, ge); });
  return ge;
}
/** Next value of a register with a reset value. */
function setR(m: Rtl, q: Sig[], next: Sig[], reset: Sig, v = 0): void {
  q.forEach((r, i) => m.setD(r, (v / 2 ** i) & 1 ? m.or(reset, next[i]) : m.and(m.not(reset), next[i])));
}
/** index → one of constant-or-signal bytes. */
const byteAt = (m: Rtl, idx: Sig[], bytes: Sig[][]): Sig[] => pick(m, bytes.map((b, k) => [m.eqConst(idx, k), b]));

// ---- the credit gate -----------------------------------------------------------------------------------------------------
const gateCache = new Map<number, ComponentDef>();
/** The standard's test, as gates: (LIMIT − (CONSUMED + want)) mod 2^w ≤ 2^(w−1). Consumed and limit are free-running counters: the difference survives a wrap. */
export function creditGate(w: number): ComponentDef {
  let d = gateCache.get(w);
  if (d) return d;
  const m = new Rtl({ id: `pcie_credit_${w}`, name: `Credit gate, ${w}-bit counters`, category: 'gate', label: 'CREDIT?', summary: `May a TLP go? The limit the receiver advertised, minus what has been consumed plus what this TLP wants, modulo 2^${w}: at most half the counters' range means there is room. A wide subtraction and no comparison of absolute values, so that both counters may wrap.` });
  const lim = m.inputBus('limit', w), cc = m.inputBus('consumed', w), want = m.inputBus('want', 5);
  const need = add(m, cc, zext(m, want, w));
  const r = sub(m, lim, need);
  const top = r[w - 1], low = r.slice(0, w - 1);
  m.output('ok', m.or(m.not(top), m.not(m.orN(low))));
  gateCache.set(w, (d = m.build()));
  return d;
}

// ---- the port ------------------------------------------------------------------------------------------------------------
let portDef: ComponentDef | undefined;
export function pciePort(): ComponentDef {
  if (portDef) return portDef;
  const m = new Rtl({
    id: 'pcie_port', name: 'PCIe port (one lane)', category: 'sequential', label: 'PCIe port',
    summary: 'A PCI Express port at the symbol level: the link training state machine, flow control (the credit gate, InitFC, UpdateFC), and the data link layer (sequence numbers, LCRC, a replay buffer, Ack and Nak, the replay timer, REPLAY_NUM). Bytes and a K flag on the lane side, as a real MAC hands them to its PHY; a TLP byte stream and a credit check on the transaction layer\'s side.',
  });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), rxdet = m.input('rxdet');
  const rxd = m.inputBus('rxd', 8), rxk = m.input('rxk');
  const t_data = m.inputBus('t_data', 8), t_valid = m.input('t_valid'), t_last = m.input('t_last'), r_ready = m.input('r_ready');
  const c_want = m.inputBus('c_want', 5), c_np = m.input('c_np'), consume = m.input('consume');
  const rtn_ph = m.input('rtn_ph'), rtn_pd = m.inputBus('rtn_pd', 5), rtn_nph = m.input('rtn_nph');
  const reset = m.name(m.or(rst, m.not(rxdet)), 'reset');

  // ---- registers, in the boxes they live in ----------
  const LT: [string, string] = ['ltssm', 'link training'], OS: [string, string] = ['ospar', 'ordered sets in'], DC: [string, string] = ['dlc', 'FC init'], FC: [string, string] = ['fc', 'flow control'];
  const TX: [string, string] = ['tx', 'packet engine'], RT: [string, string] = ['retry', 'replay'], RX: [string, string] = ['rx', 'receiver'];
  const inS = <T>(h: [string, string], f: () => T): T => m.rootScope(h[0], h[1], f);
  const lt = inS(LT, () => regs(m, clk, 'lt', 3)), opos = inS(LT, () => regs(m, clk, 'opos', 4)), txc = inS(LT, () => regs(m, clk, 'txc', 5)), wantRec = inS(LT, () => m.reg(clk, 'want_rec')), tmo = inS(LT, () => regs(m, clk, 'tmo', TRAIN_TIMEOUT_BITS));
  const op = inS(OS, () => regs(m, clk, 'op', 4)), ok = inS(OS, () => m.reg(clk, 'os_ok')), o2 = inS(OS, () => m.reg(clk, 'is_ts2')), tsc = inS(OS, () => regs(m, clk, 'tsc', 4)), ts2c = inS(OS, () => regs(m, clk, 'tstwo', 4)), idc = inS(OS, () => regs(m, clk, 'idc', 4));
  const dl = inS(DC, () => regs(m, clk, 'dl', 2)), fit = inS(DC, () => regs(m, clk, 'fit', 2)), got = inS(DC, () => regs(m, clk, 'got', 3)), gotTwo = inS(DC, () => m.reg(clk, 'got_two'));
  const phLim = inS(FC, () => regs(m, clk, 'ph_lim', 8)), pdLim = inS(FC, () => regs(m, clk, 'pd_lim', 12)), nphLim = inS(FC, () => regs(m, clk, 'nph_lim', 8));
  const phCc = inS(FC, () => regs(m, clk, 'ph_cc', 8)), pdCc = inS(FC, () => regs(m, clk, 'pd_cc', 12)), nphCc = inS(FC, () => regs(m, clk, 'nph_cc', 8));
  const caPh = inS(FC, () => regs(m, clk, 'ca_ph', 8)), caPd = inS(FC, () => regs(m, clk, 'ca_pd', 12)), caNph = inS(FC, () => regs(m, clk, 'ca_nph', 8));
  const fcP = inS(FC, () => m.reg(clk, 'fc_p')), fcNp = inS(FC, () => m.reg(clk, 'fc_np')), fct = inS(FC, () => regs(m, clk, 'fct', FC_PERIOD_BITS));
  const kindT = inS(TX, () => m.reg(clk, 'kind_tlp')), kindD = inS(TX, () => m.reg(clk, 'kind_dllp')), pos = inS(TX, () => regs(m, clk, 'pos', 4)), live = inS(TX, () => m.reg(clk, 'live'));
  const dt = inS(TX, () => regs(m, clk, 'dt', 8)), dd = inS(TX, () => regs(m, clk, 'dd', 24));
  const nextSeq = inS(RT, () => regs(m, clk, 'next_seq', 12)), ackd = inS(RT, () => regs(m, clk, 'ackd', 12)), rseq = inS(RT, () => regs(m, clk, 'rseq', 12));
  const replay = inS(RT, () => m.reg(clk, 'replaying')), rreq = inS(RT, () => m.reg(clk, 'rreq')), rnum = inS(RT, () => regs(m, clk, 'rnum', 2)), rt = inS(RT, () => regs(m, clk, 'rt', 9));
  const wp = inS(RT, () => regs(m, clk, 'wp', BUF_BITS)), rp = inS(RT, () => regs(m, clk, 'rp', BUF_BITS));
  const start = inS(RT, () => Array.from({ length: REPLAY_SLOTS }, (_, s) => regs(m, clk, `start${s}_`, BUF_BITS)));
  const rkT = inS(RX, () => m.reg(clk, 'rk_tlp')), rkD = inS(RX, () => m.reg(clk, 'rk_dllp')), rpos = inS(RX, () => regs(m, clk, 'rpos', 3)), rs = inS(RX, () => regs(m, clk, 'rs', 12)), rn = inS(RX, () => regs(m, clk, 'rn', 7));
  const rb = inS(RX, () => [0, 1, 2, 3].map((b) => regs(m, clk, `rb${b}_`, 8)));
  const wr = inS(RX, () => regs(m, clk, 'wr', BUF_BITS)), com = inS(RX, () => regs(m, clk, 'com', BUF_BITS)), rd = inS(RX, () => regs(m, clk, 'rd', BUF_BITS));
  const nextRcv = inS(RX, () => regs(m, clk, 'next_rcv', 12)), nakSent = inS(RX, () => m.reg(clk, 'nak_sent')), nakReq = inS(RX, () => m.reg(clk, 'nak_req')), ackReq = inS(RX, () => m.reg(clk, 'ack_req')), ackPend = inS(RX, () => m.reg(clk, 'ack_pend')), ackt = inS(RX, () => regs(m, clk, 'ackt', 5));

  const rollF = m.fwd('roll_f');

  // ---- states as signals ----------
  m.within('ctl', 'what next');
  const ltIs = (v: number) => m.eqConst(lt, v);
  const l0 = m.name(ltIs(4), 'l0'), t1 = m.or(ltIs(1), ltIs(5)), t2 = m.or(ltIs(2), ltIs(6)), idleSt = m.or(ltIs(3), ltIs(7));
  const ts = m.or(t1, t2);
  const dlUp = m.name(m.andN(dl), 'dl_up');
  const kIdle = m.nor(kindT, kindD);
  const pAt = (v: number) => m.eqConst(pos, v);

  // ---- the decision: what the engine starts (the standard's priorities) ----------
  const out4 = inS(RT, () => add(m, nextSeq.slice(0, 4), notN(m, ackd.slice(0, 4))));
  const outNZ = m.name(inS(RT, () => m.orN(out4)), 'out_nz');
  const can = m.name(m.andN([kIdle, l0, m.not(wantRec)]), 'can_start');
  const dLoad = m.name(m.and(can, rreq), 'd_load');
  const ackNak = m.or(nakReq, ackReq);
  const dAck = m.name(m.andN([can, m.not(rreq), ackNak]), 'd_ack');
  const quiet = m.andN([can, m.not(rreq), m.not(ackNak)]);
  const dInit = m.name(m.and(quiet, m.xor(dl[0], dl[1])), 'd_init');
  const fcAny = m.or(fcP, fcNp);
  const dFc = m.name(m.andN([quiet, dlUp, fcAny]), 'd_fc');
  const free = m.andN([quiet, dlUp, m.not(fcAny)]);
  const dReplay = m.name(m.and(free, replay), 'd_replay');
  const dTlp = m.name(m.andN([free, m.not(replay), t_valid, m.not(out4[3])]), 'd_tlp');
  const startAny = m.name(m.orN([dAck, dInit, dFc, dReplay, dTlp]), 'start_any');

  // ---- the replay buffer ----------
  const seqNow = muxN(m, live, rseq, nextSeq);
  const at3 = m.and(kindT, pAt(3));
  const memw = m.andN([at3, live, t_valid]);
  const [rawDout] = inS(RT, () => m.part(bigRamWithInit(BUF_BITS, 9, new Uint32Array(1 << BUF_BITS)), [m.bus(muxN(m, live, rp, wp)), m.bus([...t_data, t_last]), memw, clk], 'replay buffer', 'txmem'));
  const dout = inS(RT, () => m.unbus(rawDout, 9));

  // ---- the transmitter's byte ----------
  m.within('txsym', 'symbol out');
  const qt = inS(TX, () => {
    const b = pick(m, [[pAt(1), zext(m, seqNow.slice(8), 8)], [pAt(2), seqNow.slice(0, 8)], [m.and(pAt(3), live), t_data], [m.and(pAt(3), m.not(live)), dout.slice(0, 8)]]);
    const en = m.and(kindT, m.orN([pAt(1), pAt(2), m.and(pAt(3), m.or(m.not(live), t_valid))]));
    const [, f] = m.part(crcUnit(32, CRC32_REFLECTED, 8), [m.bus(b), en, m.or(startAny, reset), clk], 'LCRC', 'lcrc');
    return { b, fcs: m.unbus(f, 32) };
  });
  const qd = inS(TX, () => {
    const b = pick(m, [[pAt(1), dt], [pAt(2), dd.slice(16, 24)], [pAt(3), dd.slice(8, 16)], [pAt(4), dd.slice(0, 8)]]);
    const en = m.and(kindD, m.orN([pAt(1), pAt(2), pAt(3), pAt(4)]));
    const [, f] = m.part(crcUnit(16, DLLP_POLY, 8), [m.bus(b), en, m.or(startAny, reset), clk], 'DLLP CRC', 'dcrc');
    return { b, fcs: m.unbus(f, 16) };
  });
  const k8 = (v: number) => cbits(m, v, 8);
  const tsByte = (p: Sig[], two: Sig): { d: Sig[]; k: Sig } => {
    const is = (v: number) => m.eqConst(p, v);
    const id = muxN(m, two, k8(TS1_ID), k8(TS2_ID));
    const hi = m.or(p[3], m.and(p[2], p[1]));
    return { d: pick(m, [[is(0), k8(K_COM)], [m.or(is(1), is(2)), k8(K_PAD)], [is(3), k8(N_FTS)], [is(4), k8(TS_RATE)], [hi, id]]), k: m.orN([is(0), is(1), is(2)]) };
  };
  const tsO = inS(LT, () => tsByte(opos, t2));
  const inTs = ts;
  const symT = pick(m, [[pAt(0), k8(K_STP)], [m.orN([pAt(1), pAt(2), pAt(3)]), qt.b], [pAt(4), qt.fcs.slice(0, 8)], [pAt(5), qt.fcs.slice(8, 16)], [pAt(6), qt.fcs.slice(16, 24)], [pAt(7), qt.fcs.slice(24, 32)], [pAt(8), k8(K_END)]]);
  const symD = pick(m, [[pAt(0), k8(K_SDP)], [m.orN([pAt(1), pAt(2), pAt(3), pAt(4)]), qd.b], [pAt(5), qd.fcs.slice(0, 8)], [pAt(6), qd.fcs.slice(8, 16)], [pAt(7), k8(K_END)]]);
  const txd = pick(m, [[inTs, tsO.d], [kindT, symT], [kindD, symD]]);
  const txk = m.orN([m.and(inTs, tsO.k), m.and(kindT, m.or(pAt(0), pAt(8))), m.and(kindD, m.or(pAt(0), pAt(7)))]);
  m.outputBus('txd', txd); m.output('txk', txk);
  m.output('t_ready', m.and(at3, live));

  // ---- the packet engine's own registers ----------
  m.within(TX[0], TX[1]);
  const lastOut = m.or(m.andN([live, t_valid, t_last]), m.and(m.not(live), dout[8]));
  const clrPos = m.or(m.and(kindT, pAt(8)), m.and(kindD, pAt(7)));
  const advPos = m.orN([m.and(kindT, m.not(pAt(3))), m.and(at3, lastOut), kindD]);
  inS(TX, () => {
    setR(m, pos, gateN(m, m.not(clrPos), muxN(m, advPos, pos, m.inc(pos))), reset);
    setR(m, [kindT], [m.or(m.or(dReplay, dTlp), m.and(kindT, m.not(clrPos)))], reset);
    setR(m, [kindD], [m.orN([dAck, dInit, dFc, m.and(kindD, m.not(clrPos))])], reset);
    setR(m, [live], [m.or(dTlp, m.and(live, m.not(dReplay)))], reset);
    const initType = [...cbits(m, 0, 4), fit[0], fit[1], m.const(1), dl[1]];
    const updType = [...cbits(m, 0, 4), m.not(fcP), ...cbits(m, 0, 2), m.const(1)];
    const ackType = [...cbits(m, 0, 4), nakReq, ...cbits(m, 0, 3)];
    const load = m.orN([dAck, dInit, dFc]);
    const dtN = pick(m, [[dAck, ackType], [dInit, initType], [dFc, updType]]);
    setR(m, dt, muxN(m, load, dt, dtN), reset);
    const word1 = [...caPd, ...cbits(m, 0, 2), ...caPh, ...cbits(m, 0, 2)];
    const word2 = [...cbits(m, 0, 14), ...caNph, ...cbits(m, 0, 2)];
    const ackWord = [...dec(m, nextRcv), ...cbits(m, 0, 12)];
    const fit0 = m.eqConst(fit, 0), fit1 = m.eqConst(fit, 1);
    const ddN = pick(m, [[dAck, ackWord], [m.and(dInit, fit0), word1], [m.and(dInit, fit1), word2], [m.and(dFc, fcP), word1], [m.and(dFc, m.not(fcP)), word2]]);
    setR(m, dd, muxN(m, load, dd, ddN), reset);
  });

  // ---- the receiver ----------
  m.within('rxdec', 'symbol in');
  const rxIs = (v: number) => m.and(rxk, m.eqConst(rxd, v));
  const isStp = rxIs(K_STP), isSdp = rxIs(K_SDP), isEnd = rxIs(K_END);
  const rIdle = m.nor(rkT, rkD);
  const rAt = (v: number) => m.eqConst(rpos, v);
  const startT = m.name(m.and(rIdle, isStp), 'rx_stp'), startD = m.name(m.and(rIdle, isSdp), 'rx_sdp');
  const rn88 = m.eqConst(rn, MAX_RX_TLP);
  const fin = m.name(m.and(rkT, m.or(rxk, rn88)), 'rx_fin');
  const rdata = m.name(m.and(rkT, m.not(m.or(rxk, rn88))), 'rx_byte');
  const writing = m.name(m.andN([rkT, rAt(2), m.not(rxk)]), 'writing');
  const we = m.and(rdata, rAt(2));
  const rq = inS(RX, () => {
    const [q] = m.part(crcUnit(32, CRC32_REFLECTED, 8), [m.bus(rxd), rdata, m.or(startT, reset), clk], 'LCRC check', 'lcrc');
    const qb = m.unbus(q, 32);
    return { good: m.eqConst(qb, CRC32_RESIDUE) };
  });
  const dGate = m.andN([rkD, m.not(rxk), m.not(m.eqConst(rpos, 6))]);
  const re = inS(RX, () => {
    const [q] = m.part(crcUnit(16, DLLP_POLY, 8), [m.bus(rxd), dGate, m.or(startD, reset), clk], 'DLLP check', 'dcrc');
    return { good: m.eqConst(m.unbus(q, 16), DLLP_RESIDUE) };
  });
  const rs12 = rs;
  const seqDiff = inS(RX, () => sub(m, nextRcv, rs12));
  const crcOk = m.name(m.andN([rq.good, isEnd, rAt(2), geConst(m, rn, 4)]), 'crc_ok');
  const seqEq = m.name(m.not(m.orN(seqDiff)), 'seq_eq');
  const commit = m.name(m.andN([fin, crcOk, seqEq]), 'commit');
  const dup = m.name(m.andN([fin, crcOk, m.not(seqEq), m.not(seqDiff[11])]), 'dup');
  const nakC = m.andN([fin, m.not(commit), m.not(dup)]);
  const setNak = m.name(m.and(nakC, m.not(nakSent)), 'set_nak');
  const wr4 = inS(RX, () => add(m, wr, notN(m, cbits(m, 3, BUF_BITS))));
  const rdNeCom = m.not(m.eq(rd, com));
  const rValid = m.name(m.and(m.not(writing), rdNeCom), 'r_valid_i');
  const [rawR] = inS(RX, () => m.part(bigRamWithInit(BUF_BITS, 8, new Uint32Array(1 << BUF_BITS)), [m.bus(muxN(m, writing, rd, wr)), m.bus(rxd), we, clk], 'receive buffer', 'rxmem'));
  m.output('r_valid', rValid); m.outputBus('r_data', inS(RX, () => m.unbus(rawR, 8)));
  const dllpEnd = m.and(rkD, rAt(6));
  const dllpGood = m.name(m.andN([dllpEnd, isEnd, re.good]), 'dllp_good');
  inS(RX, () => {
    setR(m, [rkT], [m.or(startT, m.and(rkT, m.not(fin)))], reset);
    setR(m, [rkD], [m.or(startD, m.andN([rkD, m.not(dllpEnd), m.not(rxk)]))], reset);
    const inc1 = m.or(m.and(rdata, m.not(rAt(2))), dGate);
    setR(m, rpos, gateN(m, m.not(m.or(startT, startD)), muxN(m, inc1, rpos, m.inc(rpos))), reset);
    setR(m, rn, gateN(m, m.not(startT), muxN(m, we, rn, m.inc(rn))), reset);
    const lo = m.and(rdata, rAt(1)), hi = m.and(rdata, rAt(0));
    setR(m, rs, [...muxN(m, lo, rs.slice(0, 8), rxd), ...muxN(m, hi, rs.slice(8, 12), rxd.slice(0, 4))], reset);
    rb.forEach((q, b) => setR(m, q, muxN(m, m.and(dGate, rAt(b)), q, rxd), reset));
    setR(m, com, muxN(m, commit, com, wr4), reset);
    setR(m, wr, pick(m, [[commit, wr4], [m.and(fin, m.not(commit)), com], [we, m.inc(wr)], [m.nor(fin, we), wr]]), reset);
    setR(m, rd, muxN(m, m.and(rValid, r_ready), rd, m.inc(rd)), reset);
    setR(m, nextRcv, muxN(m, commit, nextRcv, m.inc(nextRcv)), reset);
    setR(m, [nakSent], [m.and(m.not(commit), m.or(nakSent, setNak))], reset);
  });

  // ---- the DLLP just received ----------
  m.within('dllpin', 'DLLP in');
  const dty = rb[0].slice(4, 8);
  const cls = dty.slice(0, 2), notThree = m.not(m.and(cls[0], cls[1]));
  const dSeq = [...rb[3], ...rb[2].slice(0, 4)], dHdr = [...rb[2].slice(6, 8), ...rb[1].slice(0, 6)], dData = dSeq;
  const isAck = m.and(dllpGood, m.eqConst(dty, 0)), isNak = m.and(dllpGood, m.eqConst(dty, 1));
  const isFc1 = m.andN([dllpGood, m.not(dty[3]), dty[2], notThree]), isFc2 = m.andN([dllpGood, dty[3], dty[2], notThree]), isUpd = m.andN([dllpGood, dty[3], m.not(dty[2]), notThree]);

  // ---- Ack and Nak, the replay timer ----------
  m.within(RX[0], RX[1]);
  const ackHit = m.and(ackPend, m.andN(ackt));
  inS(RX, () => {
    setR(m, [ackPend], [m.or(commit, m.and(ackPend, m.not(ackHit)))], reset);
    setR(m, ackt, gateN(m, m.and(ackPend, m.not(ackHit)), m.inc(ackt)), reset);
    const tookNak = m.and(dAck, nakReq), tookAck = m.and(dAck, m.not(nakReq));
    setR(m, [nakReq], [m.or(setNak, m.and(nakReq, m.not(tookNak)))], reset);
    setR(m, [ackReq], [m.orN([dup, ackHit, m.and(ackReq, m.not(tookAck))])], reset);
  });
  inS(RT, () => {
    const inWin = m.not(sub(m, dec(m, nextSeq), dSeq)[11]);
    const valid = m.name(m.andN([m.or(isAck, isNak), inWin]), 'ack_valid');
    const dist = sub(m, dSeq, ackd);
    const progress = m.name(m.andN([valid, m.orN(dist), m.not(dist[11])]), 'progress');
    const expire = m.name(m.andN([outNZ, m.not(replay), m.eqConst(rt, REPLAY_LIMIT - 1)]), 'expire');
    const rkick = m.name(m.or(m.and(valid, isNak), expire), 'rkick');
    const roll = m.name(m.andN([rkick, m.andN(rnum), m.not(progress)]), 'roll');
    m.drive(rollF, roll);
    setR(m, ackd, muxN(m, progress, ackd, dSeq), reset, 0xfff);
    setR(m, [rreq], [m.or(rkick, m.and(rreq, m.not(dLoad)))], reset);
    const clrT = m.orN([progress, rkick, dLoad, m.not(outNZ), replay]);
    setR(m, rt, gateN(m, m.not(clrT), muxN(m, l0, rt, m.inc(rt))), reset);
    setR(m, rnum, gateN(m, m.not(progress), muxN(m, rkick, rnum, m.inc(rnum))), reset);
    const tEnd = m.and(kindT, pAt(8));
    setR(m, nextSeq, muxN(m, m.and(tEnd, live), nextSeq, m.inc(nextSeq)), reset);
    const ackdP = m.inc(ackd);
    const loadR = m.and(dLoad, outNZ);
    const rseqI = m.inc(rseq);
    const rEnd = m.and(tEnd, m.not(live));
    setR(m, rseq, pick(m, [[loadR, ackdP], [rEnd, rseqI], [m.nor(loadR, rEnd), rseq]]), reset);
    setR(m, [replay], [m.or(loadR, m.and(replay, m.not(m.and(rEnd, m.eq(rseqI, nextSeq)))))], reset);
    const tableAt = pick(m, start.map((s, k) => [m.eqConst(ackdP.slice(0, 3), k), s] as [Sig, Sig[]]));
    const memr = m.and(at3, m.not(live));
    setR(m, rp, pick(m, [[loadR, tableAt], [memr, m.inc(rp)], [m.nor(loadR, memr), rp]]), reset);
    setR(m, wp, muxN(m, memw, wp, m.inc(wp)), reset);
    start.forEach((s, k) => {
      const w = m.and(dTlp, m.eqConst(nextSeq.slice(0, 3), k));
      s.forEach((q, i) => m.setD(q, m.mux(w, q, wp[i])));
    });
  });

  // ---- FC init and flow control ----------
  m.within(DC[0], DC[1]);
  inS(DC, () => {
    const lastF = m.eqConst(fit, 2);
    setR(m, fit, gateN(m, m.not(m.and(dInit, lastF)), muxN(m, dInit, fit, m.inc(fit))), reset);
    const down = m.nor(dl[0], dl[1]), f1 = m.and(dl[0], m.not(dl[1])), f2 = m.and(dl[1], m.not(dl[0]));
    const to1 = m.and(down, l0), to2 = m.andN([dInit, lastF, f1, m.andN(got)]), to3 = m.andN([dInit, lastF, f2, gotTwo]);
    setR(m, dl, pick(m, [[to1, cbits(m, 1, 2)], [to2, cbits(m, 2, 2)], [to3, cbits(m, 3, 2)], [m.nor(m.or(to1, to2), to3), dl]]), reset);
    const init = m.or(isFc1, isFc2);
    got.forEach((q, c) => setR(m, [q], [m.or(q, m.and(init, m.eqConst(cls, c)))], reset));
    setR(m, [gotTwo], [m.orN([gotTwo, isFc2, isUpd, commit])], reset);
  });
  const fcv = inS(FC, () => {
    const fresh = (c: number) => m.andN([m.or(isFc1, isFc2), m.eqConst(cls, c), m.not(got[c])]);
    const loadP = m.or(fresh(0), m.and(isUpd, m.eqConst(cls, 0))), loadNp = m.or(fresh(1), m.and(isUpd, m.eqConst(cls, 1)));
    setR(m, phLim, muxN(m, loadP, phLim, dHdr), reset);
    setR(m, pdLim, muxN(m, loadP, pdLim, dData), reset);
    setR(m, nphLim, muxN(m, loadNp, nphLim, dHdr), reset);
    const useP = m.and(consume, m.not(c_np)), useN = m.and(consume, c_np);
    setR(m, phCc, muxN(m, useP, phCc, m.inc(phCc)), reset);
    setR(m, pdCc, muxN(m, useP, pdCc, add(m, pdCc, zext(m, c_want, 12))), reset);
    setR(m, nphCc, muxN(m, useN, nphCc, m.inc(nphCc)), reset);
    setR(m, caPh, muxN(m, rtn_ph, caPh, m.inc(caPh)), reset, ADV_PH);
    setR(m, caPd, add(m, caPd, zext(m, rtn_pd, 12)), reset, ADV_PD);
    setR(m, caNph, muxN(m, rtn_nph, caNph, m.inc(caNph)), reset, ADV_NPH);
    const tick = m.and(dlUp, m.andN(fct));
    setR(m, fct, gateN(m, dlUp, m.inc(fct)), reset);
    const pdAny = m.orN(rtn_pd);
    const clrP = m.and(dFc, fcP), clrN = m.andN([dFc, m.not(fcP)]);
    setR(m, [fcP], [m.orN([rtn_ph, pdAny, tick, m.and(fcP, m.not(clrP))])], reset);
    setR(m, [fcNp], [m.orN([rtn_nph, tick, m.and(fcNp, m.not(clrN))])], reset);
    const one = cbits(m, 1, 5);
    const gP = m.part(creditGate(8), [m.bus(phLim), m.bus(phCc), m.bus(one)], 'posted headers', 'gph')[0];
    const gD = m.part(creditGate(12), [m.bus(pdLim), m.bus(pdCc), m.bus(c_want)], 'posted data', 'gpd')[0];
    const gN = m.part(creditGate(8), [m.bus(nphLim), m.bus(nphCc), m.bus(one)], 'non-posted headers', 'gnp')[0];
    return { ok: m.and(dlUp, m.mux(c_np, m.and(gP, gD), gN)) };
  });
  m.output('c_ok', fcv.ok);

  // ---- ordered sets in, the LTSSM ----------
  m.within(LT[0], LT[1]);
  const recEntry = m.name(m.andN([l0, wantRec, kIdle]), 'rec_entry');
  const trainTo = m.name(m.andN([m.orN(lt), m.not(l0), m.andN(tmo)]), 'train_to');
  const clrCounts = m.or(recEntry, trainTo);
  const osv = inS(OS, () => {
    const isCom = rxIs(K_COM), inOs = m.orN(op);
    const p = (v: number) => m.eqConst(op, v);
    const p12 = m.or(p(1), p(2)), p35 = m.orN([p(3), p(4), p(5)]), p6 = p(6), hi = m.and(op[3], m.orN(op.slice(0, 3))); // 9..15
    const p7p8 = m.or(p(7), p(8));
    const idOne = m.eqConst(rxd, TS1_ID), idTwo = m.eqConst(rxd, TS2_ID), nk = m.not(rxk);
    const exp = m.orN([m.and(p12, rxIs(K_PAD)), m.and(p35, nk), m.andN([p6, nk, m.or(idOne, idTwo)]), m.andN([m.or(hi, p7p8), nk, m.mux(o2, idOne, idTwo)])]);
    const okN = m.and(ok, exp);
    const p15 = p(15), through = m.and(m.not(isCom), inOs);
    const goodEnd = m.name(m.andN([through, p15, okN]), 'good_end');
    const bad = m.or(m.andN([through, p15, m.not(okN)]), m.nor(isCom, inOs));
    setR(m, op, pick(m, [[isCom, cbits(m, 1, 4)], [through, gateN(m, m.not(p15), m.inc(op))]]), reset);
    setR(m, [ok], [m.mux(isCom, m.mux(through, ok, okN), m.const(1))], reset);
    setR(m, [o2], [m.mux(m.and(through, p6), o2, idTwo)], reset);
    const tsSat = tsc[3], twoSat = ts2c[3];
    const tscN = pick(m, [[m.and(goodEnd, m.not(tsSat)), m.inc(tsc)], [tsSat, tsc], [m.nor(goodEnd, m.or(bad, tsSat)), tsc]]);
    setR(m, tsc, gateN(m, m.not(clrCounts), tscN), reset);
    const goodTwo = m.and(goodEnd, o2);
    const clrTwo = m.andN([m.or(bad, goodEnd), m.not(goodTwo), m.not(twoSat)]);
    const twoN = pick(m, [[m.and(goodTwo, m.not(twoSat)), m.inc(ts2c)], [twoSat, ts2c], [m.nor(m.and(goodTwo, m.not(twoSat)), m.or(twoSat, clrTwo)), ts2c]]);
    setR(m, ts2c, gateN(m, m.not(clrCounts), twoN), reset);
    const idleSym = m.and(nk, m.not(m.orN(rxd)));
    setR(m, idc, gateN(m, idleSt, pick(m, [[idc[3], idc], [m.and(idleSym, m.not(idc[3])), m.inc(idc)]])), reset);
    return { goodEnd };
  });
  inS(LT, () => {
    const end = m.andN(opos), enough = txc[4];
    const adv1 = m.andN([t1, end, enough, tsc[3]]), adv2 = m.andN([t2, end, enough, ts2c[3]]), adv3 = m.andN([idleSt, enough, idc[3]]), l00 = ltIs(0);
    const up1 = m.and(m.orN([l00, adv1, adv2]), m.not(trainTo)), to4 = m.and(adv3, m.not(trainTo));
    const first = m.and(trainTo, m.not(lt[2])), firstRec = m.and(trainTo, lt[2]);
    const stay = m.nor(m.or(up1, to4), m.or(recEntry, trainTo));
    const nxt = pick(m, [[up1, m.inc(lt)], [to4, cbits(m, 4, 3)], [m.or(recEntry, firstRec), cbits(m, 5, 3)], [first, cbits(m, 1, 3)], [stay, lt]]);
    setR(m, lt, nxt, reset);
    const changed = m.not(m.eq(nxt, lt));
    setR(m, tmo, gateN(m, m.andN([m.not(changed), m.orN(lt), m.not(l0)]), m.inc(tmo)), reset);
    const countsTx = m.and(m.mux(ts, idleSt, end), m.not(enough));
    setR(m, txc, gateN(m, m.not(changed), muxN(m, countsTx, txc, m.inc(txc))), reset);
    setR(m, opos, gateN(m, m.and(m.not(changed), ts), m.inc(opos)), reset);
    setR(m, [wantRec], [m.and(m.not(recEntry), m.orN([wantRec, rollF, m.and(l0, osv.goodEnd)]))], reset);
  });

  // ---- what the panels and the tests read ----------
  const fields: Record<string, Sig[]> = { lt, dl, kind: [kindT, kindD], seq: nextSeq, ackd, rseq, replay: [replay], rnum, nrcv: nextRcv, nak: [nakReq], ack: [ackReq], ph_lim: phLim, pd_lim: pdLim, nph_lim: nphLim, ph_cc: phCc, pd_cc: pdCc, nph_cc: nphCc, rt };
  m.outputBus('status', PORT_STATUS.flatMap(([n]) => fields[n]));
  portDef = m.build();
  return portDef;
}

// ---- the transaction layer -----------------------------------------------------------------------------------------------
/** (len + 3) >> 2: data credits for len dwords. */
function dcred(m: Rtl, len: Sig[]): Sig[] {
  const s = add(m, [...len, m.const(0)], cbits(m, 3, 6));
  return zext(m, s.slice(2), 5);
}
let rootDef: ComponentDef | undefined;
export function pcieRootTl(): ComponentDef {
  if (rootDef) return rootDef;
  const m = new Rtl({ id: 'pcie_root_tl', name: 'PCIe requester', category: 'sequential', label: 'Requester', summary: 'The transaction layer of the root port: takes a command, waits for the credit gate, then writes a memory write or read TLP, byte by byte, into the data link layer. Completions come back with their tag.' });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), go = m.input('go'), wr = m.input('wr');
  const addr = m.inputBus('addr', 8), len = m.inputBus('len', 5), seed = m.inputBus('seed', 8);
  const t_ready = m.input('t_ready'), c_ok = m.input('c_ok'), r_valid = m.input('r_valid'), r_data = m.inputBus('r_data', 8);
  const TX: [string, string] = ['req', 'request'], RX: [string, string] = ['cpl', 'completions'];
  const inS = <T>(h: [string, string], f: () => T): T => m.scope(h[0], h[1], f);
  const tx = inS(TX, () => {
    const st = regs(m, clk, 'st', 2), i = regs(m, clk, 'i', 6), cw = m.reg(clk, 'cw'), ca = regs(m, clk, 'ca', 8), cl = regs(m, clk, 'cl', 5), cs = regs(m, clk, 'cs', 8), tag = regs(m, clk, 'tag', 5);
    const idle = m.eqConst(st, 0), wait = m.eqConst(st, 1), hdr = m.eqConst(st, 2), dat = m.eqConst(st, 3);
    const z = cbits(m, 0, 8);
    const cl8 = zext(m, cl, 8);
    const one = m.eqConst(cl, 1);
    const be = [m.const(1), m.const(1), m.const(1), m.const(1), m.not(one), m.not(one), m.not(one), m.not(one)];
    const head = [
      [...cbits(m, 0, 6), cw, m.const(0)], z, z, cl8, z, z, zext(m, tag, 8), be, z, z,
      [ca[6], ca[7], ...cbits(m, 0, 6)], [m.const(0), m.const(0), ...ca.slice(0, 6)],
    ];
    const hb = byteAt(m, i.slice(0, 4), head);
    const sb = add(m, cs, zext(m, i, 8));
    const hEnd = m.eqConst(i, 11);
    const cm1 = dec(m, cl).slice(0, 4);
    const dEnd = m.and(m.andN(i.slice(0, 2)), m.eq(i.slice(2, 6), cm1));
    const valid = m.or(hdr, dat);
    m.outputBus('t_data', pick(m, [[hdr, hb], [dat, sb]]));
    m.output('t_valid', valid);
    m.output('t_last', m.or(m.andN([hdr, m.not(cw), hEnd]), m.and(dat, dEnd)));
    m.outputBus('c_want', gateN(m, cw, dcred(m, cl)));
    m.output('c_np', m.not(cw));
    m.output('busy', m.not(idle)); m.output('wait', wait);
    const consume = m.and(wait, c_ok);
    m.output('consume', consume);
    const rstn = m.not(rst);
    const take = m.and(idle, go);
    const mv = m.and(valid, t_ready);
    const hDone = m.andN([hdr, mv, hEnd]), dDone = m.andN([dat, mv, dEnd]);
    const toIdle = m.or(m.and(hDone, m.not(cw)), dDone), toDat = m.and(hDone, cw);
    const stN = pick(m, [[take, cbits(m, 1, 2)], [consume, cbits(m, 2, 2)], [toDat, cbits(m, 3, 2)], [m.nor(m.or(take, consume), m.or(toIdle, toDat)), st]]);
    st.forEach((q, k) => m.setD(q, m.and(rstn, stN[k])));
    const iN = gateN(m, m.not(m.orN([take, consume, hDone, dDone])), muxN(m, mv, i, m.inc(i)));
    i.forEach((q, k) => m.setD(q, m.and(rstn, iN[k])));
    m.setD(cw, m.and(rstn, m.mux(take, cw, wr)));
    ca.forEach((q, k) => m.setD(q, m.and(rstn, m.mux(take, q, addr[k]))));
    cl.forEach((q, k) => m.setD(q, m.and(rstn, m.mux(take, q, len[k]))));
    cs.forEach((q, k) => m.setD(q, m.and(rstn, m.mux(take, q, seed[k]))));
    const tagN = muxN(m, toIdle, tag, m.inc(tag));
    tag.forEach((q, k) => m.setD(q, m.and(rstn, tagN[k])));
    return { rstn };
  });
  inS(RX, () => {
    const rs = m.reg(clk, 'rs'), p = regs(m, clk, 'p', 4), rlen = regs(m, clk, 'rlen', 5), rtag = regs(m, clk, 'rtag', 5), rem = regs(m, clk, 'rem', 7);
    const inH = m.and(r_valid, m.not(rs)), inD = m.and(r_valid, rs);
    const at = (v: number) => m.and(inH, m.eqConst(p, v));
    const hEnd = at(11), one = m.eqConst(rem, 1);
    const rn = tx.rstn;
    m.setD(rs, m.and(rn, m.or(hEnd, m.and(rs, m.not(m.and(inD, one))))));
    const pN = gateN(m, m.not(hEnd), muxN(m, inH, p, m.inc(p)));
    p.forEach((q, k) => m.setD(q, m.and(rn, pN[k])));
    rlen.forEach((q, k) => m.setD(q, m.and(rn, m.mux(at(3), q, r_data[k]))));
    rtag.forEach((q, k) => m.setD(q, m.and(rn, m.mux(at(10), q, r_data[k]))));
    const remN = pick(m, [[hEnd, [m.const(0), m.const(0), ...rlen]], [inD, dec(m, rem)], [m.nor(hEnd, inD), rem]]);
    rem.forEach((q, k) => m.setD(q, m.and(rn, remN[k])));
    m.output('rd_valid', inD); m.output('rd_done', m.and(inD, one)); m.outputBus('rd_data', gateN(m, inD, r_data)); m.outputBus('rtag', rtag);
  });
  rootDef = m.build();
  return rootDef;
}

let epDef: ComponentDef | undefined;
export function pcieEpTl(): ComponentDef {
  if (epDef) return epDef;
  const m = new Rtl({ id: 'pcie_ep_tl', name: 'PCIe completer', category: 'sequential', label: 'Completer', summary: 'The transaction layer of the endpoint, with a kilobyte of memory behind it: writes are stored and their credits returned; a read is answered with one completion. Completions cost no credits: an endpoint has to advertise them as infinite, so that a read it was willing to issue can always come back.' });
  const clk = m.input('clk', { clock: true }), rst = m.input('rst'), t_ready = m.input('t_ready'), r_valid = m.input('r_valid'), r_data = m.inputBus('r_data', 8);
  const rstn = m.not(rst);
  const st = regs(m, clk, 'st', 2), i = regs(m, clk, 'i', 7), hw = m.reg(clk, 'hw'), hlen = regs(m, clk, 'hlen', 5), htag = regs(m, clk, 'htag', 5), haddr = regs(m, clk, 'haddr', 8);
  const hdr = m.eqConst(st, 0), wd = m.eqConst(st, 1), chdr = m.eqConst(st, 2), cdat = m.eqConst(st, 3);
  const at = add(m, [m.const(0), m.const(0), ...haddr], zext(m, i, EP_MEM_BITS));
  const nEnd = m.eq(i, [m.const(1), m.const(1), ...dec(m, hlen)]);
  const wv = m.and(wd, r_valid);
  const [raw] = m.part(bigRamWithInit(EP_MEM_BITS, 8, new Uint32Array(1 << EP_MEM_BITS)), [m.bus(at), m.bus(r_data), wv, clk], 'memory', 'ram');
  const dout = m.unbus(raw, 8);
  const z = cbits(m, 0, 8);
  const cpl = [
    cbits(m, 0x4a, 8), z, z, zext(m, hlen, 8), cbits(m, 1, 8), z, z, [m.const(0), m.const(0), ...hlen, m.const(0)], z, z, zext(m, htag, 8),
    [m.const(0), m.const(0), ...haddr.slice(0, 5), m.const(0)],
  ];
  const cb = byteAt(m, i.slice(0, 4), cpl);
  m.outputBus('t_data', pick(m, [[chdr, cb], [cdat, dout]]));
  const lastW = m.and(wv, nEnd);
  m.output('t_valid', m.or(chdr, cdat)); m.output('t_last', m.and(cdat, nEnd));
  m.output('r_ready', m.or(hdr, wd));
  m.output('rtn_ph', lastW);
  m.outputBus('rtn_pd', gateN(m, lastW, dcred(m, hlen)));
  const hv = m.and(hdr, r_valid);
  const atH = (v: number) => m.and(hv, m.eqConst(i, v));
  const end = atH(11);
  m.output('rtn_nph', m.and(end, m.not(hw)));
  m.outputBus('ep_st', st);
  m.setD(hw, m.and(rstn, m.mux(atH(0), hw, r_data[6])));
  hlen.forEach((q, k) => m.setD(q, m.and(rstn, m.mux(atH(3), q, r_data[k]))));
  htag.forEach((q, k) => m.setD(q, m.and(rstn, m.mux(atH(6), q, r_data[k]))));
  haddr.forEach((q, k) => m.setD(q, m.and(rstn, k >= 6 ? m.mux(atH(10), q, r_data[k - 6]) : m.mux(end, q, r_data[k + 2]))));
  const cv = m.and(m.or(chdr, cdat), t_ready);
  const cEnd = m.and(chdr, m.eqConst(i, 11));
  const toW = m.and(end, hw), toC = m.and(end, m.not(hw)), toCd = m.and(cv, cEnd), toH = m.or(lastW, m.andN([cdat, t_ready, nEnd]));
  const stN = pick(m, [[toW, cbits(m, 1, 2)], [toC, cbits(m, 2, 2)], [toCd, cbits(m, 3, 2)], [m.nor(m.or(toW, toC), m.or(toCd, toH)), st]]);
  st.forEach((q, k) => m.setD(q, m.and(rstn, stN[k])));
  const adv = m.orN([hv, wv, cv]);
  const iN = gateN(m, m.not(m.orN([end, lastW, toCd, m.andN([cdat, t_ready, nEnd])])), muxN(m, adv, i, m.inc(i)));
  i.forEach((q, k) => m.setD(q, m.and(rstn, iN[k])));
  epDef = m.build();
  return epDef;
}

// ---- the link ------------------------------------------------------------------------------------------------------------
let laneDef: ComponentDef | undefined;
/** One direction of a lane: a delay in symbols and an optional flipped bit. A model of the wire and both SerDes, labelled as one. */
export function pcieLane(): ComponentDef {
  if (laneDef) return laneDef;
  const m = new Rtl({ id: 'pcie_lane', name: 'PCIe lane, one direction', category: 'sequential', label: 'Lane', columnHeight: 30, summary: `${LINE_DELAY} symbols of delay and an optional flipped bit: what stands for the scrambler, the 8b/10b encoder, the SerDes, the wire and the far side's clock recovery. A model, labelled as one; the fast serial links chapter opens all of those in gates.` });
  const clk = m.input('clk', { clock: true }), d = m.inputBus('d', 8), k = m.input('k'), flip = m.input('flip');
  let cur = [m.xor(d[0], flip), ...d.slice(1), k];
  for (let s = 0; s < LINE_DELAY; s++) cur = cur.map((x, i) => { const q = m.reg(clk, `s${s}_${i}`); m.setD(q, x); return q; });
  m.outputBus('q', cur.slice(0, 8)); m.output('qk', cur[8]);
  laneDef = m.build();
  return laneDef;
}

let linkDef: ComponentDef | undefined;
/** Root port and endpoint, a lane in each direction. Built on demand: too large to register at import. */
export function pcieLink(): ComponentDef {
  if (linkDef) return linkDef;
  const P = pciePort(), R = pcieRootTl(), E = pcieEpTl(), L = pcieLane(), Z5 = constWord(5, 0);
  const gr = symbolGeom(R), gp = symbolGeom(P), gl = symbolGeom(L), ge = symbolGeom(E);
  const xr = 18, xa = xr + gr.w + 24, xl = xa + gp.w + 24, xb = xl + gl.w + 24, xe = xb + gp.w + 24, R0 = xe + ge.w + 18, y0 = 6;
  const yl2 = y0 + gl.h + 8;
  const instances: InstanceDef[] = [
    { name: 'root', def: R, at: [xr, y0], label: 'Requester' }, { name: 'a', def: P, at: [xa, y0], label: 'Port A (root)' },
    { name: 'ab', def: L, at: [xl, y0], label: 'Lane A→B' }, { name: 'ba', def: L, at: [xl, yl2], label: 'Lane B→A' },
    { name: 'b', def: P, at: [xb, y0], label: 'Port B (endpoint)' }, { name: 'ep', def: E, at: [xe, y0], label: 'Completer' },
    { name: 'z5a', def: Z5, at: [xl, yl2 + gl.h + 6] }, { name: 'lo', def: TIE0, at: [xl + 12, yl2 + gl.h + 6] }, { name: 'hi', def: TIE1, at: [xl + 20, yl2 + gl.h + 6] },
    { name: 'tl', def: OR, at: [16, y0 + gr.h + 6], label: 'link down' }, { name: 'np', def: NOT, at: [4, y0 + gr.h + 12] },
  ];
  const tag = (name: string, ends: string[]): NetDef => ({ name, ends, tags: true });
  const nets: NetDef[] = [
    tag('clk', ['clk', 'root.clk', 'a.clk', 'ab.clk', 'ba.clk', 'b.clk', 'ep.clk']),
    tag('rst', ['rst', 'a.rst', 'b.rst', 'tl.a']), tag('plug', ['plug', 'a.rxdet', 'b.rxdet', 'np.a']), { name: 'unplugged', ends: ['np.y', 'tl.b'] },
    tag('tl_rst', ['tl.y', 'root.rst', 'ep.rst']),
    { name: 'go', ends: ['go', 'root.go'] }, { name: 'wr', ends: ['wr', 'root.wr'] }, { name: 'addr', ends: ['addr', 'root.addr'] }, { name: 'len', ends: ['len', 'root.len'] }, { name: 'seed', ends: ['seed', 'root.seed'] },
    tag('a_t_data', ['root.t_data', 'a.t_data']), tag('a_t_valid', ['root.t_valid', 'a.t_valid']), tag('a_t_last', ['root.t_last', 'a.t_last']), tag('a_c_want', ['root.c_want', 'a.c_want']), tag('a_c_np', ['root.c_np', 'a.c_np']), tag('a_consume', ['root.consume', 'a.consume']),
    tag('a_t_ready', ['a.t_ready', 'root.t_ready']), tag('a_c_ok', ['a.c_ok', 'root.c_ok']), tag('a_r_valid', ['a.r_valid', 'root.r_valid']), tag('a_r_data', ['a.r_data', 'root.r_data']),
    tag('a_txd', ['a.txd', 'ab.d', 'a_txd']), tag('a_txk', ['a.txk', 'ab.k', 'a_txk']), tag('flip_ab', ['flip_ab', 'ab.flip']),
    tag('b_rxd', ['ab.q', 'b.rxd']), tag('b_rxk', ['ab.qk', 'b.rxk']),
    tag('b_txd', ['b.txd', 'ba.d', 'b_txd']), tag('b_txk', ['b.txk', 'ba.k', 'b_txk']), tag('flip_ba', ['flip_ba', 'ba.flip']),
    tag('a_rxd', ['ba.q', 'a.rxd']), tag('a_rxk', ['ba.qk', 'a.rxk']),
    tag('b_t_data', ['ep.t_data', 'b.t_data']), tag('b_t_valid', ['ep.t_valid', 'b.t_valid']), tag('b_t_last', ['ep.t_last', 'b.t_last']), tag('b_r_ready', ['ep.r_ready', 'b.r_ready']),
    tag('b_rtn_ph', ['ep.rtn_ph', 'b.rtn_ph']), tag('b_rtn_pd', ['ep.rtn_pd', 'b.rtn_pd']), tag('b_rtn_nph', ['ep.rtn_nph', 'b.rtn_nph']),
    tag('b_t_ready', ['b.t_ready', 'ep.t_ready']), tag('b_r_valid', ['b.r_valid', 'ep.r_valid']), tag('b_r_data', ['b.r_data', 'ep.r_data']),
    tag('zero5', ['z5a.y', 'a.rtn_pd', 'b.c_want']), tag('zero', ['lo.y', 'a.rtn_ph', 'a.rtn_nph', 'b.c_np', 'b.consume']), tag('one', ['hi.y', 'a.r_ready']),
    tag('a_status', ['a.status', 'a_status']), tag('b_status', ['b.status', 'b_status']),
    tag('busy', ['root.busy', 'busy']), tag('wait', ['root.wait', 'wait']), tag('rd_valid', ['root.rd_valid', 'rd_valid']), tag('rd_done', ['root.rd_done', 'rd_done']), tag('rd_data', ['root.rd_data', 'rd_data']), tag('rtag', ['root.rtag', 'rtag']), tag('ep_st', ['ep.ep_st', 'ep_st']),
  ];
  const statusW = PORT_STATUS.reduce((w, [, n]) => w + n, 0);
  const inY = (i: number) => y0 + 2 + 3 * i, outY = (i: number) => y0 + 2 + 3 * i;
  const outs: [string, number][] = [['a_txd', 8], ['a_txk', 1], ['b_txd', 8], ['b_txk', 1], ['busy', 1], ['wait', 1], ['rd_valid', 1], ['rd_done', 1], ['rd_data', 8], ['rtag', 5], ['ep_st', 2], ['a_status', statusW], ['b_status', statusW]];
  const ins: [string, number, boolean?][] = [['rst', 1], ['plug', 1], ['go', 1], ['wr', 1], ['addr', 8], ['len', 5], ['seed', 8], ['flip_ab', 1], ['flip_ba', 1]];
  linkDef = define({
    id: 'pcie_link', name: 'PCIe link', category: 'sequential',
    summary: 'A root port and an endpoint on one lane. On the left the requester and its port; on the right the port and its completer with a kilobyte of memory; between them the two directions of the lane, each a delay and an optional flipped bit (a model, labelled as one).',
    ports: [...ins.map(([name, width]): PortDef => ({ name, width, dir: 'in' })), { name: 'clk', width: 1, dir: 'in', side: 'bottom', clock: true }, ...outs.map(([name, width]): PortDef => ({ name, width, dir: 'out' }))],
    symbol: { kind: 'box', label: 'PCIe link' },
    netlist: () => ({
      pins: { ...Object.fromEntries(ins.map(([n], i) => [n, [0, inY(i)] as [number, number]])), clk: [0, inY(ins.length) + 2] as [number, number], ...Object.fromEntries(outs.map(([n], i) => [n, [R0, outY(i)] as [number, number]])) },
      instances, nets,
    }),
  });
  return linkDef;
}
