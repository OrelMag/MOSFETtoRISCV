// Chapter 50's network interface card, DOM-free: the golden model lib/nic.ts (the gates) is compared with every output after every
// clock, and bus/model.ts's NicDevice steps it beside the instruction-set simulator.
//
// What it is: a bus slave with eight registers, a bus master that moves frames between two rings of descriptors in RAM and the MAC
// (comm/mac.ts, chapter 48), and an interrupt line. Full duplex only (col is tied low: no restart, no backoff).
//
// A descriptor is two words. Word 0 is the buffer's address (low 16 bits), word 1 has OWN in bit 31 (1: the NIC holds it) and in the
// low 11 bits the length. The software hands a descriptor over by setting OWN; the NIC hands it back by clearing it, so the
// software never reads a half-written frame: the NIC writes the data first and the descriptor's word 1 last.
//
//   transmit  A write to KICK makes the NIC read the descriptor at TXBASE + 8·head. OWN set: read word 0, read the buffer a word at
//             a time as the MAC asks for bytes, and when the frame is out (MAC `sent` or `drop`) write word 1 back with OWN = 0
//             (bit 30 set when the frame was dropped), advance head, set STATUS.TXI, and look at the next descriptor.
//   receive   The first byte of a frame makes the NIC read the descriptor at RXBASE + 8·head (word 1, then word 0). OWN clear: the
//             frame is dropped (STATUS.MISS). Bytes are packed into words and written as they arrive, before the FCS verdict. At the last
//             byte a bad frame (the MAC's err: FCS, runt, too long, not for me) is simply forgotten: the descriptor is untouched, head
//             does not move, the next frame overwrites the buffer (STATUS.BAD). A good frame ends with word 1 written (OWN = 0, length),
//             head advanced, STATUS.RXI set. That is "write, then commit or rewind" at the level of a descriptor.
//
// Ring bases are 64-byte aligned (their low 6 bits read as 0), addresses are 16 bits (the RAM sits at 0), and the rings hold 8
// descriptors. A buffer holds one frame of up to 1514 bytes (the buffers of comm/stack/layout.ts are 1536).
// Each engine's request waits for the bus: the master serves one request at a time, receive first (a wire cannot be stopped).

import { MacRx, MacTx, type RxIn, type TxIn } from './mac';

/** Register offsets from the NIC's base address. */
export const NIC_REG = { CTRL: 0x00, STATUS: 0x04, IE: 0x08, RXBASE: 0x0c, TXBASE: 0x10, MACL: 0x14, MACH: 0x18, KICK: 0x1c } as const;
/** CTRL bits. */
export const CTRL_EN = 1, CTRL_PROMISC = 2;
/** STATUS bits (write 1 to clear). */
export const ST_RXI = 1, ST_TXI = 2, ST_MISS = 4, ST_BAD = 8;
export const DESCRIPTORS = 8;
export const DESC_BYTES = 8;
export const OWN = 0x80000000;
/** Bit 30 of a transmit descriptor written back: the MAC gave the frame up. */
export const TX_DROPPED = 0x40000000;
export const LEN_MASK = 0x7ff;

export interface NicIn {
  // the slave side: what the interconnect drives
  awvalid: number; awaddr: number; wvalid: number; wdata: number; wstrb: number; bready: number; arvalid: number; araddr: number; rready: number;
  // the master side: what comes back
  m_awready: number; m_wready: number; m_bvalid: number; m_arready: number; m_rvalid: number; m_rdata: number;
  // the line
  rxd: number; crs: number;
}
export const idleIn = (): NicIn => ({ awvalid: 0, awaddr: 0, wvalid: 0, wdata: 0, wstrb: 0, bready: 1, arvalid: 0, araddr: 0, rready: 1, m_awready: 0, m_wready: 0, m_bvalid: 0, m_arready: 0, m_rvalid: 0, m_rdata: 0, rxd: 0, crs: 0 });

export interface NicOut {
  awready: number; wready: number; bvalid: number; arready: number; rvalid: number; rdata: number;
  m_awvalid: number; m_awaddr: number; m_wvalid: number; m_wdata: number; m_wstrb: number; m_bready: number; m_arvalid: number; m_araddr: number; m_rready: number;
  txd: number; txen: number; irq: number;
}

const u32 = (x: number) => x >>> 0;
const thermo = (pos: number) => (1 << (pos + 1)) - 1;

export class NicCore {
  // registers
  en = 0; promisc = 0; ie = 0; rxbase = 0; txbase = 0; macl = 0; mach = 0;
  sRx = 0; sTx = 0; sMiss = 0; sBad = 0;
  // slave handshake
  bq = 0; rq = 0; rdr = 0;
  // master: one-hot state, the latched request, the answer
  ar = 0; rd = 0; aw = 0; bw = 0; who = 0; addrq = 0; datq = 0; strq = 0; doneq = 0; rdq = 0;
  // receive engine
  act = 0; skip = 0; have = 0; f = 0; wv = 0; plast = 0; fin = 0; cm = 0; cnt = 0; acc = 0; wdat = 0; wstr = 0; wp = 0; rxhead = 0;
  // transmit engine
  kick = 0; ts = 0; tlen = 0; ti = 0; tw = 0; tbuf = 0; tdrop = 0; txhead = 0;
  readonly tx = new MacTx();
  readonly rx = new MacRx();

  get macBytes(): number[] {
    return [this.macl & 255, (this.macl >>> 8) & 255, (this.macl >>> 16) & 255, (this.macl >>> 24) & 255, this.mach & 255, (this.mach >>> 8) & 255];
  }

  private readReg(idx: number): number {
    switch (idx) {
      case 0: return (this.promisc << 1) | this.en;
      case 1: return this.sRx | (this.sTx << 1) | (this.sMiss << 2) | (this.sBad << 3);
      case 2: return this.ie;
      case 3: return this.rxbase;
      case 4: return this.txbase;
      case 5: return u32(this.macl);
      case 6: return this.mach;
      default: return this.rxhead | (this.txhead << 3) | ((this.ts ? 1 : 0) << 6) | (this.act << 7);
    }
  }

  /** The descriptor an engine looks at: the ring's base (64-aligned) with the head as the index. */
  private get rdesc(): number { return this.rxbase | (this.rxhead << 3); }
  private get tdesc(): number { return this.txbase | (this.txhead << 3); }

  /** True while the master has no transaction under way. */
  get masterIdle(): boolean { return !(this.ar || this.rd || this.aw || this.bw); }
  private get rxreq(): boolean { return this.f !== 0 || this.wv === 1 || this.cm === 1; }
  private get txreq(): boolean { return this.ts === 1 || this.ts === 2 || this.ts === 3 || this.ts === 6; }
  /** A request is waiting for the master. */
  get wants(): boolean { return this.rxreq || this.txreq; }

  get txValid(): number { return this.ts === 4 ? 1 : 0; }
  get txByte(): number { return (this.tw >>> (8 * (this.ti & 3))) & 255; }
  get txLast(): number { return ((this.ti + 1) & LEN_MASK) === this.tlen ? 1 : 0; }
  get irq(): number { return (this.sRx & (this.ie & 1)) | (this.sTx & ((this.ie >> 1) & 1)); }

  out(): NicOut {
    const idle = !(this.bq || this.rq) ? 1 : 0;
    return {
      awready: idle, wready: idle, bvalid: this.bq, arready: idle, rvalid: this.rq, rdata: u32(this.rdr),
      m_awvalid: this.aw, m_awaddr: this.addrq, m_wvalid: this.aw, m_wdata: u32(this.datq), m_wstrb: this.strq, m_bready: 1, m_arvalid: this.ar, m_araddr: this.addrq, m_rready: 1,
      txd: this.tx.txd, txen: this.tx.txen, irq: this.irq,
    };
  }

  step(i: NicIn): void {
    const en = this.en === 1;
    // ---- the slave side
    const idle = !(this.bq || this.rq);
    const wrHs = !!(i.awvalid && i.wvalid && idle), rdHs = !!(i.arvalid && idle);
    const widx = (i.awaddr >>> 2) & 7, ridx = (i.araddr >>> 2) & 7;
    const wd = u32(i.wdata);
    const w = (k: number) => wrHs && i.wstrb !== 0 && widx === k;
    // ---- master
    const doneRx = this.doneq === 1 && this.who === 1, doneTx = this.doneq === 1 && this.who === 0;
    const start = this.masterIdle && !this.doneq && this.wants;
    const selRx = this.rxreq;
    // the request each engine would make now (a read carries the same data and strobes the gates' multiplexers pick)
    const wvSel = this.f === 0 && this.wv === 1;
    const rxWe = this.f === 0 ? 1 : 0;
    const rxAddr = wvSel ? this.wp : this.rdesc | (this.f === 2 ? 0 : 4);
    const rxData = wvSel ? this.wdat : this.cnt, rxStr = wvSel ? this.wstr : 15;
    const txWe = this.ts === 6 ? 1 : 0;
    const txAddr = this.ts === 3 ? this.tbuf : this.tdesc | (this.ts === 2 ? 0 : 4);
    const txData = u32((this.tdrop << 30) | this.tlen), txStr = 15;
    const rqWe = selRx ? rxWe : txWe, rqAddr = selRx ? rxAddr : txAddr, rqData = selRx ? rxData : txData, rqStr = selRx ? rxStr : txStr;

    // ---- receive engine (the MAC's registered outputs of the last clock)
    const v = this.rx.valid === 1, d = this.rx.data, l = this.rx.last === 1, e = this.rx.err === 1;
    const pos = this.cnt & 3;
    const first = v && !this.act;
    const need = v && (pos === 3 || l) && !(l && e);
    const canjob = need && this.have === 1 && !this.skip && !this.wv;
    // the last byte may arrive while the word before it is still being written: its job waits for the bus
    const defer = need && l && this.have === 1 && !this.skip && this.wv === 1;
    const lastDrop = v && l && (e || this.skip === 1 || !this.have);
    const canjob2 = this.plast === 1 && doneRx && this.wv === 1;
    const accNew = u32((this.acc & ~(255 << (8 * pos))) | (d << (8 * pos)));
    const commitDone = doneRx && this.cm === 1;
    const wDone = doneRx && this.wv === 1;
    // ---- transmit engine
    const taken = this.ts === 4 && this.tx.ready === 1;
    const lastO = this.txLast === 1;

    // ---- next state (all from the old values)
    const n = {
      en: w(0) ? wd & 1 : this.en, promisc: w(0) ? (wd >> 1) & 1 : this.promisc,
      ie: w(2) ? wd & 3 : this.ie, rxbase: w(3) ? wd & 0xffc0 : this.rxbase, txbase: w(4) ? wd & 0xffc0 : this.txbase,
      macl: w(5) ? wd : this.macl, mach: w(6) ? wd & 0xffff : this.mach,
      sRx: (commitDone ? 1 : 0) | (this.sRx & ~(w(1) && wd & 1 ? 1 : 0)),
      sTx: (doneTx && this.ts === 6 ? 1 : 0) | (this.sTx & ~(w(1) && wd & 2 ? 1 : 0)),
      sMiss: (lastDrop && !e ? 1 : 0) | (this.sMiss & ~(w(1) && wd & 4 ? 1 : 0)),
      sBad: (v && l && e ? 1 : 0) | (this.sBad & ~(w(1) && wd & 8 ? 1 : 0)),
      bq: wrHs || (this.bq && !i.bready) ? 1 : 0,
      rq: rdHs || (this.rq && !i.rready) ? 1 : 0,
      rdr: rdHs ? this.readReg(ridx) : this.rdr,
    };
    const nm = {
      ar: start && !rqWe ? 1 : this.ar && !i.m_arready ? 1 : 0,
      rd: this.ar && i.m_arready ? 1 : this.rd && !i.m_rvalid ? 1 : 0,
      aw: start && rqWe ? 1 : this.aw && !(i.m_awready && i.m_wready) ? 1 : 0,
      bw: this.aw && i.m_awready && i.m_wready ? 1 : this.bw && !i.m_bvalid ? 1 : 0,
      who: start ? (selRx ? 1 : 0) : this.who,
      addrq: start ? rqAddr : this.addrq, datq: start ? rqData : this.datq, strq: start ? rqStr : this.strq,
      doneq: (this.rd && i.m_rvalid) || (this.bw && i.m_bvalid) ? 1 : 0,
      rdq: this.rd && i.m_rvalid ? u32(i.m_rdata) : this.rdq,
    };
    const rxn = {
      act: first ? 1 : lastDrop || commitDone ? 0 : this.act,
      skip: first ? 0 : doneRx && this.f === 1 && !(this.rdq >>> 31) ? 1 : need && !canjob && !defer ? 1 : this.skip,
      have: first ? 0 : doneRx && this.f === 2 ? 1 : this.have,
      f: first ? 1 : doneRx && this.f === 1 ? (this.rdq >>> 31 ? 2 : 0) : doneRx && this.f === 2 ? 0 : this.f,
      wv: canjob || canjob2 ? 1 : wDone ? 0 : this.wv,
      plast: defer ? 1 : canjob2 ? 0 : this.plast,
      fin: canjob ? (l ? 1 : 0) : canjob2 ? 1 : this.fin,
      cm: wDone && this.fin ? 1 : commitDone ? 0 : this.cm,
      cnt: lastDrop || commitDone ? 0 : v ? (this.cnt + 1) & LEN_MASK : this.cnt,
      acc: v ? accNew : this.acc,
      wdat: canjob ? accNew : canjob2 ? this.acc : this.wdat,
      wstr: canjob ? (l ? thermo(pos) : 15) : canjob2 ? thermo((this.cnt - 1) & 3) : this.wstr,
      wp: doneRx && this.f === 2 ? this.rdq & 0xffff : wDone ? (this.wp + 4) & 0xffff : this.wp,
      rxhead: commitDone ? (this.rxhead + 1) & 7 : this.rxhead,
    };
    let ts = this.ts;
    const txn = { tlen: this.tlen, ti: this.ti, tw: this.tw, tbuf: this.tbuf, tdrop: this.tdrop, txhead: this.txhead, kick: this.kick };
    if (w(7)) txn.kick = 1;
    switch (this.ts) {
      case 0: if (this.kick) { ts = 1; if (!w(7)) txn.kick = 0; } break;
      case 1: if (doneTx) { const len = this.rdq & LEN_MASK; ts = !(this.rdq >>> 31) ? 0 : len === 0 ? 6 : 2; txn.tlen = len; } break;
      case 2: if (doneTx) { txn.tbuf = this.rdq & 0xffff; txn.ti = 0; ts = 3; } break;
      case 3: if (doneTx) { txn.tw = this.rdq; txn.tbuf = (this.tbuf + 4) & 0xffff; ts = 4; } break;
      case 4: if (taken) { txn.ti = (this.ti + 1) & LEN_MASK; ts = lastO ? 5 : (this.ti & 3) === 3 ? 3 : 4; } break;
      case 5: if (this.tx.sent || this.tx.drop) { ts = 6; txn.tdrop = this.tx.drop; } break;
      case 6: if (doneTx) { ts = 1; txn.txhead = (this.txhead + 1) & 7; } break;
    }

    // ---- the MAC inputs come from the old state; their outputs are next clock's
    const txIn: TxIn = { rst: en ? 0 : 1, data: this.txByte, valid: this.txValid, last: this.txLast, crs: 0, col: 0, seed: this.macl & 0x1ff };
    const rxIn: RxIn = { rst: en ? 0 : 1, rxd: i.rxd, crs: i.crs, ready: 1, promisc: this.promisc, addr: this.macBytes };
    this.tx.step(txIn);
    this.rx.step(rxIn);

    Object.assign(this, n, nm, rxn, txn, { ts });
    // everything the enable bit governs returns to zero while it is 0 (the registers, the latched request and the buffers keep their values)
    if (!en) Object.assign(this, { ar: 0, rd: 0, aw: 0, bw: 0, doneq: 0, act: 0, skip: 0, have: 0, f: 0, wv: 0, fin: 0, cm: 0, cnt: 0, rxhead: 0, ts: 0, kick: 0, txhead: 0, plast: 0 });
  }
}
