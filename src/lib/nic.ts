// Chapter 50's network interface card in gates: a bus slave with eight registers, a bus master that moves frames between two
// rings of descriptors in RAM and the Ethernet MAC of chapter 48 (lib/ethernet.ts macTx, macRx), and an interrupt. Everything is
// NAND gates and the library's flip-flops in boxes of their own (lib/rtl.ts); comm/nic.ts is the golden model the tests compare it
// with after every clock, and says what the descriptors, the registers and the engines do.
//
// Boxes: regs (the registers and the slave's handshake), dma (the master: one transaction at a time, receive before transmit), rx
// (descriptor fetch, a word packer, commit or forget; the MAC receiver inside) and tx (descriptor fetch, word fetch as the MAC asks for
// bytes, write-back; the MAC transmitter inside).

import type { ComponentDef } from '../sim/types';
import { macRx, macTx } from './ethernet';
import { Rtl, type Sig } from './rtl';

let cached: ComponentDef | undefined;

const regsN = (m: Rtl, clk: Sig, name: string, n: number): Sig[] => Array.from({ length: n }, (_, i) => m.reg(clk, `${name}${i}`));
/** s ? b : a, bitwise. */
const mux = (m: Rtl, s: Sig, a: Sig[], b: Sig[]): Sig[] => a.map((x, i) => m.mux(s, x, b[i]));
/** A register that loads d when en is 1. */
const loadReg = (m: Rtl, clk: Sig, name: string, en: Sig, d: Sig[]): Sig[] => {
  const q = regsN(m, clk, name, d.length);
  q.forEach((x, i) => m.setD(x, m.mux(en, x, d[i])));
  return q;
};

export function nic(): ComponentDef {
  if (cached) return cached;
  const m = new Rtl({
    id: 'nic', name: 'Network interface card', category: 'memory', label: 'NIC', columnHeight: 64,
    summary: 'A bus slave with eight registers (control, status, interrupt enable, the two ring bases, the MAC address, a transmit doorbell) and a bus master that walks two rings of descriptors in RAM: it reads a frame out of its buffer for the MAC transmitter, and writes a received frame into a buffer before the MAC has judged its FCS, committing the descriptor only if the frame was good. Full duplex, 16-bit addresses.',
    notes: 'regs: the registers and the bus slave. dma: the master, one transaction at a time. rx: the descriptor and the packing of bytes into words. tx: the descriptor, the words, the write-back. The two MACs are the ones of chapter 48.',
  });
  const clk = m.input('clk', { clock: true });
  const awvalid = m.input('awvalid'), awaddr = m.inputBus('awaddr', 32), wvalid = m.input('wvalid'), wdata = m.inputBus('wdata', 32);
  const wstrb = m.inputBus('wstrb', 4);
  const bready = m.input('bready'), arvalid = m.input('arvalid'), araddr = m.inputBus('araddr', 32), rready = m.input('rready');
  const mAwready = m.input('m_awready'), mWready = m.input('m_wready'), mBvalid = m.input('m_bvalid'), mArready = m.input('m_arready'), mRvalid = m.input('m_rvalid');
  const mRdata = m.inputBus('m_rdata', 32);
  const rxd = m.input('rxd'), crs = m.input('crs');

  // signals the blocks hand each other before they are built
  const doneRx = m.fwd('done_rx'), doneTx = m.fwd('done_tx');
  const rdq = Array.from({ length: 32 }, (_, i) => m.fwd(`rdq${i}`));
  const evRx = m.fwd('ev_rx'), evTx = m.fwd('ev_tx'), evMiss = m.fwd('ev_miss'), evBad = m.fwd('ev_bad');
  const rxhead = Array.from({ length: 3 }, (_, i) => m.fwd(`rxhead_f${i}`)), txhead = Array.from({ length: 3 }, (_, i) => m.fwd(`txhead_f${i}`));
  const actF = m.fwd('act_f'), txbusy = m.fwd('txbusy');
  const kickW = m.fwd('kick_w');

  // ---- registers and the bus slave --------------------------------------------------------------------------------------
  const R = m.scope('regs', 'registers, bus slave', () => {
    const bq = m.reg(clk, 'bq'), rq = m.reg(clk, 'rq');
    const sidle = m.name(m.nor(bq, rq), 'sidle');
    const wrHs = m.name(m.andN([awvalid, wvalid, sidle]), 'wr_hs'), rdHs = m.name(m.and(arvalid, sidle), 'rd_hs');
    m.setD(bq, m.or(wrHs, m.and(bq, m.not(bready))));
    m.setD(rq, m.or(rdHs, m.and(rq, m.not(rready))));
    const widx = awaddr.slice(2, 5), ridx = araddr.slice(2, 5);
    // a write with no byte strobe set changes nothing (the registers are words: any byte lane counts)
    const wen = m.name(m.and(wrHs, m.orN(wstrb)), 'wr_en');
    const w = Array.from({ length: 8 }, (_, k) => m.name(m.and(wen, m.eqConst(widx, k)), `w${k}`));
    const reg1 = (name: string, en: Sig, d: Sig): Sig => { const q = m.reg(clk, name); m.setD(q, m.mux(en, q, d)); return q; };
    const en = reg1('en', w[0], wdata[0]), promisc = reg1('promisc', w[0], wdata[1]);
    const ie = [reg1('ie0', w[2], wdata[0]), reg1('ie1', w[2], wdata[1])];
    const rxbase = loadReg(m, clk, 'rxbase', w[3], wdata.slice(6, 16));
    const txbase = loadReg(m, clk, 'txbase', w[4], wdata.slice(6, 16));
    const macl = loadReg(m, clk, 'macl', w[5], wdata);
    const mach = loadReg(m, clk, 'mach', w[6], wdata.slice(0, 16));
    const status = [['s_rx', evRx, 0], ['s_tx', evTx, 1], ['s_miss', evMiss, 2], ['s_bad', evBad, 3]].map(([nm, ev, bit]) => {
      const q = m.reg(clk, nm as string);
      m.setD(q, m.or(ev as Sig, m.and(q, m.not(m.and(w[1], wdata[bit as number])))));
      return q;
    });
    m.drive(kickW, w[7]);
    // reads: the word answered one clock after the address
    const z = m.const(0);
    const word = (bits: Sig[]): Sig[] => Array.from({ length: 32 }, (_, i) => bits[i] ?? z);
    const words = [
      word([en, promisc]), word(status), word(ie), word([...Array(6).fill(z), ...rxbase]), word([...Array(6).fill(z), ...txbase]), macl, word(mach),
      word([...rxhead, ...txhead, txbusy, actF]),
    ];
    const pick = words[0].map((_, i) => {
      const l1 = [0, 2, 4, 6].map((k) => m.mux(ridx[0], words[k][i], words[k + 1][i]));
      const l2 = [m.mux(ridx[1], l1[0], l1[1]), m.mux(ridx[1], l1[2], l1[3])];
      return m.mux(ridx[2], l2[0], l2[1]);
    });
    const rdr = loadReg(m, clk, 'rdr', rdHs, pick);
    const irq = m.name(m.or(m.and(status[0], ie[0]), m.and(status[1], ie[1])), 'irq_o');
    return { en, promisc, rxbase, txbase, macl, mach, sidle, bq, rq, rdr, irq };
  });
  m.output('awready', R.sidle); m.output('wready', R.sidle); m.output('arready', R.sidle);
  m.output('bvalid', R.bq); m.output('rvalid', R.rq); m.outputBus('rdata', R.rdr);
  m.output('irq', R.irq);
  const en = R.en;

  // ---- the receive engine ------------------------------------------------------------------------------------------------
  const RX = m.scope('rx', 'receive: descriptor, packing, commit', () => {
    const rstn = en;
    const [dB, v, l, e] = m.part(macRx(), [clk, m.not(en), rxd, crs, m.const(1), R.promisc, m.bus([...R.macl, ...R.mach])], 'MAC RX', 'macrx');
    const d = m.unbus(dB, 8);
    const act = m.reg(clk, 'act'), skip = m.reg(clk, 'skip'), have = m.reg(clk, 'have'), fa = m.reg(clk, 'f_d1'), fb = m.reg(clk, 'f_d0');
    const wv = m.reg(clk, 'wv'), plast = m.reg(clk, 'plast'), fin = m.reg(clk, 'fin'), cm = m.reg(clk, 'cm');
    const cnt = regsN(m, clk, 'cnt', 11), acc = regsN(m, clk, 'acc', 32), wdat = regsN(m, clk, 'wdat', 32), wstr = regsN(m, clk, 'wstr', 4), wp = regsN(m, clk, 'wp', 16);
    const head = regsN(m, clk, 'head', 3);
    head.forEach((q, i) => m.drive(rxhead[i], q));
    m.drive(actF, act);

    const pos3 = m.and(cnt[0], cnt[1]);
    const first = m.name(m.and(v, m.not(act)), 'first');
    const need = m.name(m.andN([v, m.or(pos3, l), m.not(m.and(l, e))]), 'need');
    const canjob = m.name(m.andN([need, have, m.not(skip), m.not(wv)]), 'canjob');
    const defer = m.name(m.andN([need, l, have, m.not(skip), wv]), 'defer');
    const lastDrop = m.name(m.and(v, m.and(l, m.orN([e, skip, m.not(have)]))), 'last_drop');
    const commitDone = m.name(m.and(doneRx, cm), 'commit_done'), wDone = m.name(m.and(doneRx, wv), 'w_done');
    const canjob2 = m.name(m.and(plast, wDone), 'canjob2');
    // the byte joins the word being packed
    const sel = [0, 1, 2, 3].map((k) => m.eqConst(cnt.slice(0, 2), k));
    const accNew = acc.map((q, i) => m.mux(sel[i >> 3], q, d[i & 7]));
    acc.forEach((q, i) => m.setD(q, m.mux(v, q, accNew[i])));
    wdat.forEach((q, i) => m.setD(q, m.mux(canjob, m.mux(canjob2, q, acc[i]), accNew[i])));
    // strobes: the whole word, or bytes 0..pos for the last word
    const nl = m.not(l);
    const strobe = [m.const(1), m.or(nl, m.or(cnt[0], cnt[1])), m.or(nl, cnt[1]), m.or(nl, pos3)];
    // the deferred last job: the strobes from the length, 1 → 0001, 2 → 0011, 3 → 0111, 0 → 1111
    const c0 = cnt[0], c1 = cnt[1];
    const strobe2 = [m.const(1), m.or(c1, m.not(c0)), m.xnor(c0, c1), m.nor(c0, c1)];
    wstr.forEach((q, i) => m.setD(q, m.mux(canjob, m.mux(canjob2, q, strobe2[i]), strobe[i])));
    m.setD(act, m.and(rstn, m.or(first, m.and(act, m.nor(lastDrop, commitDone)))));
    m.setD(skip, m.andN([rstn, m.not(first), m.orN([m.andN([doneRx, fa, m.not(rdq[31])]), m.andN([need, m.not(canjob), m.not(defer)]), skip])]));
    m.setD(have, m.andN([rstn, m.not(first), m.or(m.and(doneRx, fb), have)]));
    m.setD(fa, m.and(rstn, m.or(first, m.and(fa, m.not(doneRx)))));
    m.setD(fb, m.andN([rstn, m.not(first), m.or(m.andN([doneRx, fa, rdq[31]]), m.and(fb, m.not(doneRx)))]));
    m.setD(wv, m.and(rstn, m.orN([canjob, canjob2, m.and(wv, m.not(wDone))])));
    m.setD(plast, m.and(rstn, m.or(defer, m.and(plast, m.not(canjob2)))));
    m.setD(fin, m.and(rstn, m.mux(canjob, m.or(fin, canjob2), l)));
    m.setD(cm, m.and(rstn, m.or(m.and(wDone, fin), m.and(cm, m.not(commitDone)))));
    const ci = m.inc(cnt);
    cnt.forEach((q, i) => m.setD(q, m.andN([rstn, m.nor(lastDrop, commitDone), m.mux(v, q, ci[i])])));
    const wpHi = m.inc(wp.slice(2));
    wp.forEach((q, i) => m.setD(q, m.mux(m.and(doneRx, fb), i < 2 ? q : m.mux(wDone, q, wpHi[i - 2]), rdq[i])));
    const hi = m.inc(head);
    head.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(commitDone, q, hi[i]))));
    m.drive(evRx, commitDone);
    m.drive(evMiss, m.and(lastDrop, m.not(e)));
    m.drive(evBad, m.andN([v, l, e]));
    const rxreq = m.name(m.orN([fa, fb, wv, cm]), 'rxreq');
    return { rxreq, fa, fb, wv, wp, head, cnt, wdat, wstr };
  });

  // ---- the transmit engine -------------------------------------------------------------------------------------------------
  const TX = m.scope('tx', 'transmit: descriptor, words, write-back', () => {
    const rstn = en;
    const s1 = m.reg(clk, 's_d1'), s2 = m.reg(clk, 's_d0'), s3 = m.reg(clk, 's_word'), s4 = m.reg(clk, 's_send'), s5 = m.reg(clk, 's_wait'), s6 = m.reg(clk, 's_wb');
    const kick = m.reg(clk, 'kick'), tdrop = m.reg(clk, 'tdrop');
    const tlen = regsN(m, clk, 'tlen', 11), ti = regsN(m, clk, 'ti', 11), tw = regsN(m, clk, 'tw', 32), tbuf = regsN(m, clk, 'tbuf', 16), head = regsN(m, clk, 'head', 3);
    head.forEach((q, i) => m.drive(txhead[i], q));
    const idle = m.name(m.nor(m.orN([s1, s2, s3]), m.orN([s4, s5, s6])), 'tx_idle');
    m.drive(txbusy, m.not(idle));
    const ti3 = m.and(ti[0], ti[1]);
    const tiInc = m.inc(ti);
    const lastO = m.name(m.eq(tiInc, tlen), 'last_o');
    const byte = Array.from({ length: 8 }, (_, j) => m.mux(ti[1], m.mux(ti[0], tw[j], tw[8 + j]), m.mux(ti[0], tw[16 + j], tw[24 + j])));
    const zero = m.const(0);
    const [ready, txd, txen, , drop, sent] = m.part(macTx(), [clk, m.not(en), m.bus(byte), s4, lastO, zero, zero, m.bus([...R.macl.slice(0, 9), zero])], 'MAC TX', 'mactx');
    const taken = m.name(m.and(s4, ready), 'taken');
    const sod = m.name(m.or(sent, drop), 'sent_or_drop');
    const lenNZ = m.orN(rdq.slice(0, 11));
    const d1 = m.and(s1, doneTx), s2d = m.and(s2, doneTx), s3d = m.and(s3, doneTx), s6d = m.and(s6, doneTx);
    const ownOk = m.and(d1, rdq[31]);
    m.setD(s1, m.and(rstn, m.orN([m.and(idle, kick), m.and(s1, m.not(doneTx)), s6d])));
    m.setD(s2, m.and(rstn, m.or(m.and(ownOk, lenNZ), m.and(s2, m.not(doneTx)))));
    m.setD(s3, m.and(rstn, m.orN([s2d, m.and(s3, m.not(doneTx)), m.andN([s4, taken, m.not(lastO), ti3])])));
    m.setD(s4, m.and(rstn, m.or(s3d, m.and(s4, m.not(m.and(taken, m.or(lastO, ti3)))))));
    m.setD(s5, m.and(rstn, m.or(m.andN([s4, taken, lastO]), m.and(s5, m.not(sod)))));
    m.setD(s6, m.and(rstn, m.orN([m.and(ownOk, m.not(lenNZ)), m.and(s5, sod), m.and(s6, m.not(doneTx))])));
    tlen.forEach((q, i) => m.setD(q, m.mux(d1, q, rdq[i])));
    ti.forEach((q, i) => m.setD(q, m.and(m.not(s2d), m.mux(taken, q, tiInc[i]))));
    const tbufHi = m.inc(tbuf.slice(2));
    tbuf.forEach((q, i) => m.setD(q, m.mux(s2d, i < 2 ? q : m.mux(s3d, q, tbufHi[i - 2]), rdq[i])));
    tw.forEach((q, i) => m.setD(q, m.mux(s3d, q, rdq[i])));
    m.setD(tdrop, m.mux(m.and(s5, sod), tdrop, drop));
    const hi = m.inc(head);
    head.forEach((q, i) => m.setD(q, m.and(rstn, m.mux(s6d, q, hi[i]))));
    m.setD(kick, m.and(rstn, m.or(kickW, m.and(kick, m.not(idle)))));
    m.drive(evTx, s6d);
    m.output('txd', txd); m.output('txen', txen);
    return { txreq: m.name(m.orN([s1, s2, s3, s6]), 'txreq'), s2, s3, s6, tbuf, tdrop, tlen, head };
  });

  // ---- the bus master -------------------------------------------------------------------------------------------------------
  const D = m.scope('dma', 'bus master', () => {
    const rstn = en;
    const ar = m.reg(clk, 'ar'), rd = m.reg(clk, 'rd'), aw = m.reg(clk, 'aw'), bw = m.reg(clk, 'bw'), who = m.reg(clk, 'who'), doneq = m.reg(clk, 'doneq');
    const addrq = regsN(m, clk, 'addr', 16), datq = regsN(m, clk, 'data', 32), strq = regsN(m, clk, 'strb', 4), rdR = regsN(m, clk, 'rdata', 32);
    const midle = m.nor(m.or(ar, rd), m.or(aw, bw));
    const start = m.name(m.andN([midle, m.not(doneq), m.or(RX.rxreq, TX.txreq)]), 'start');
    const selRx = RX.rxreq;
    // the receive engine's request
    const z = m.const(0), one = m.const(1);
    const wvSel = m.and(RX.wv, m.nor(RX.fa, RX.fb));
    const rdesc = [z, z, m.not(RX.fb), ...RX.head, ...R.rxbase];
    const rxAddr = rdesc.map((x, i) => m.mux(wvSel, x, RX.wp[i]));
    const rxData = Array.from({ length: 32 }, (_, i) => (i < 11 ? m.mux(wvSel, RX.cnt[i], RX.wdat[i]) : m.and(wvSel, RX.wdat[i])));
    const rxStr = RX.wstr.map((q) => m.or(m.not(wvSel), q));
    const rxWe = m.nor(RX.fa, RX.fb);
    // the transmit engine's
    const tdescA = [z, z, m.not(TX.s2), ...TX.head, ...R.txbase];
    const txAddr = tdescA.map((x, i) => m.mux(TX.s3, x, TX.tbuf[i]));
    const txData = Array.from({ length: 32 }, (_, i) => (i < 11 ? TX.tlen[i] : i === 30 ? TX.tdrop : z));
    const rqAddr = mux(m, selRx, txAddr, rxAddr), rqData = mux(m, selRx, txData, rxData), rqStr = rxStr.map((x) => m.mux(selRx, one, x));
    const rqWe = m.mux(selRx, TX.s6, rxWe);
    const fire = m.and(aw, m.and(mAwready, mWready));
    m.setD(ar, m.and(rstn, m.or(m.and(start, m.not(rqWe)), m.and(ar, m.not(mArready)))));
    m.setD(rd, m.and(rstn, m.or(m.and(ar, mArready), m.and(rd, m.not(mRvalid)))));
    m.setD(aw, m.and(rstn, m.or(m.and(start, rqWe), m.and(aw, m.not(m.and(mAwready, mWready))))));
    m.setD(bw, m.and(rstn, m.or(fire, m.and(bw, m.not(mBvalid)))));
    m.setD(who, m.mux(start, who, selRx));
    addrq.forEach((q, i) => m.setD(q, m.mux(start, q, rqAddr[i])));
    datq.forEach((q, i) => m.setD(q, m.mux(start, q, rqData[i])));
    strq.forEach((q, i) => m.setD(q, m.mux(start, q, rqStr[i])));
    const rdGot = m.and(rd, mRvalid);
    m.setD(doneq, m.and(rstn, m.or(rdGot, m.and(bw, mBvalid))));
    rdR.forEach((q, i) => { m.setD(q, m.mux(rdGot, q, mRdata[i])); m.drive(rdq[i], q); });
    m.drive(doneRx, m.and(doneq, who));
    m.drive(doneTx, m.and(doneq, m.not(who)));
    return { ar, aw, addrq, datq, strq, one, z };
  });
  m.output('m_awvalid', D.aw); m.outputBus('m_awaddr', [...D.addrq, ...Array(16).fill(D.z)]); m.output('m_wvalid', D.aw);
  m.outputBus('m_wdata', D.datq); m.outputBus('m_wstrb', D.strq); m.output('m_bready', D.one);
  m.output('m_arvalid', D.ar); m.outputBus('m_araddr', [...D.addrq, ...Array(16).fill(D.z)]); m.output('m_rready', D.one);
  cached = m.build();
  return cached;
}
