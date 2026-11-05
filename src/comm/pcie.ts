// PCI Express, one lane, at the symbol level, DOM-free: the packet formats, and the golden model lib/pcie.ts is compared with every
// output after every clock. The formats are the real ones (TLP header, sequence number and LCRC; DLLP and its CRC-16; TS1 / TS2).
// The machine is a port: the data link layer (sequence numbers, a replay buffer, Ack / Nak, the replay timer), flow control (the
// credit gate, InitFC, UpdateFC) and a subset of the LTSSM, on a byte-wide symbol interface: PIPE's shape, what a real MAC hands
// its PHY, which then scrambles and runs 8b/10b and a SerDes.
//
// Named simplifications, so that the chapter can say them:
//   no scrambling; one lane; a symbol a clock (no SKP ordered sets, nothing to compensate, one clock for both ends);
//   an idle symbol between packets; at most REPLAY_SLOTS TLPs unacknowledged (the standard allows 2048);
//   one virtual channel; posted and non-posted header and posted data credits, with completions and non-posted data infinite
//     (an endpoint must advertise infinite completion credits; non-posted data is only used by writes to config space and IO);
//   memory requests with 32-bit addresses only, whole dwords, up to MAX_DW dwords; no ECRC; no poisoned TLPs;
//   the LTSSM's Polling, Configuration and Recovery reduced to TS1, then TS2, then idle (no link or lane numbers,
//     no speed change, no low-power states; a timeout goes back to the first TS1 of the sequence, not to Detect), with TS_TX ordered sets sent where the standard asks for 1024 in Polling.Active;
//   timers in clocks, far shorter than the standard's table (its replay limit depends on the payload size and the width).

import { CRC32_REFLECTED, CRC32_RESIDUE, crc32, fcsBytes, stepBits } from './crc';

// ---- symbols -------------------------------------------------------------------------------------------------------------
export const K_COM = 0xbc, K_STP = 0xfb, K_SDP = 0x5c, K_END = 0xfd, K_EDB = 0xfe, K_PAD = 0xf7;
export const TS1_ID = 0x4a, TS2_ID = 0x45;
export interface Sym { d: number; k: number }
const KNAMES: Record<number, string> = { [K_COM]: 'COM', [K_STP]: 'STP', [K_SDP]: 'SDP', [K_END]: 'END', [K_EDB]: 'EDB', [K_PAD]: 'PAD' };
export const symName = (d: number, k: number): string => (k ? KNAMES[d] ?? `K${d.toString(16)}` : d.toString(16).padStart(2, '0'));

// ---- LCRC and the DLLP's CRC ---------------------------------------------------------------------------------------------
/** The DLLP's CRC-16, generator 0x100B, reflected. */
export const DLLP_POLY = 0xd008;
export const dllpCrc = (b: ArrayLike<number>): number => {
  let q = 0xffff;
  for (let i = 0; i < b.length; i++) q = stepBits(q, b[i], 8, DLLP_POLY, 16);
  return ~q & 0xffff;
};
/** What the register holds after a whole DLLP, its CRC included, when nothing changed. */
export const DLLP_RESIDUE = (() => {
  let q = 0xffff;
  const c = dllpCrc([0, 0, 0, 0]);
  for (const b of [0, 0, 0, 0, c & 255, c >> 8]) q = stepBits(q, b, 8, DLLP_POLY, 16);
  return q;
})();
export { CRC32_RESIDUE };

// ---- TLPs ----------------------------------------------------------------------------------------------------------------
export const MAX_DW = 16;
export type TlpKind = 'MWr' | 'MRd' | 'CplD';
export interface TlpSpec { kind: TlpKind; len: number; tag: number; requester?: number; addr?: number; completer?: number; data?: number[] }

/** Header bytes (three dwords, big-endian) then the payload. */
export function tlpBytes(t: TlpSpec): number[] {
  const len = t.len & 0x3ff, req = t.requester ?? 0;
  if (t.kind === 'CplD') {
    const bc = t.len * 4, cpl = t.completer ?? 0x0100, low = (t.addr ?? 0) & 0x7f;
    return [0x4a, 0, len >> 8, len & 255, cpl >> 8, cpl & 255, bc >> 8 & 15, bc & 255, req >> 8, req & 255, t.tag, low, ...(t.data ?? [])];
  }
  const a = t.addr ?? 0, be = t.len === 1 ? 0x0f : 0xff;
  const head = [t.kind === 'MWr' ? 0x40 : 0x00, 0, len >> 8, len & 255, req >> 8, req & 255, t.tag, be, a >>> 24, (a >>> 16) & 255, (a >>> 8) & 255, a & 0xfc];
  return t.kind === 'MWr' ? [...head, ...(t.data ?? [])] : head;
}

export interface TlpFields { kind: TlpKind | 'other'; len: number; tag: number; requester: number; addr: number; completer: number; byteCount: number; lower: number; firstBe: number; lastBe: number; data: number[] }
export function parseTlp(b: ArrayLike<number>): TlpFields {
  const a = Array.from(b), first = a[0], len = ((a[2] & 3) << 8) | a[3];
  const kind: TlpFields['kind'] = first === 0x40 ? 'MWr' : first === 0 ? 'MRd' : first === 0x4a ? 'CplD' : 'other';
  const cpl = kind === 'CplD';
  return {
    kind, len, tag: cpl ? a[10] : a[6], requester: cpl ? (a[8] << 8) | a[9] : (a[4] << 8) | a[5], addr: cpl ? 0 : ((a[8] * 2 ** 24) + (a[9] << 16) + (a[10] << 8) + (a[11] & 0xfc)),
    completer: cpl ? (a[4] << 8) | a[5] : 0, byteCount: cpl ? ((a[6] & 15) << 8) | a[7] : 0, lower: cpl ? a[11] & 0x7f : 0, firstBe: cpl ? 0 : a[7] & 15, lastBe: cpl ? 0 : a[7] >> 4, data: a.slice(12),
  };
}
/** The data link layer's wrapping: 4 reserved bits and the sequence number in front, the LCRC behind. Same register as Ethernet's FCS. */
export function dlWrap(seq: number, tlp: readonly number[]): number[] {
  const b = [(seq >> 8) & 15, seq & 255, ...tlp];
  return [...b, ...fcsBytes(crc32(b))];
}
/** The symbols of a TLP on the lane. */
export const tlpSymbols = (seq: number, tlp: readonly number[]): Sym[] => [{ d: K_STP, k: 1 }, ...dlWrap(seq, tlp).map((d) => ({ d, k: 0 })), { d: K_END, k: 1 }];

// ---- DLLPs ---------------------------------------------------------------------------------------------------------------
export const DLLP_ACK = 0x00, DLLP_NAK = 0x10, DLLP_INIT1 = 0x40, DLLP_INIT2 = 0xc0, DLLP_UPDATE = 0x80;
/** A DLLP's four bytes before its CRC. */
export const dllpBody = (type: number, word: number): number[] => [type, (word >> 16) & 255, (word >> 8) & 255, word & 255];
export const fcWord = (hdr: number, data: number): number => ((hdr & 255) << 14) | (data & 0xfff);
export function dllpSymbols(type: number, word: number): Sym[] {
  const b = dllpBody(type, word), c = dllpCrc(b);
  return [{ d: K_SDP, k: 1 }, ...[...b, c & 255, c >> 8].map((d) => ({ d, k: 0 })), { d: K_END, k: 1 }];
}
export const dllpName = (type: number): string => {
  const hi = type >> 4, cls = ['P', 'NP', 'Cpl'][hi & 3] ?? '?';
  return hi === 0 ? 'Ack' : hi === 1 ? 'Nak' : hi >= 4 && hi <= 6 ? `InitFC1-${cls}` : hi >= 0xc && hi <= 0xe ? `InitFC2-${cls}` : hi >= 8 && hi <= 0xa ? `UpdateFC-${cls}` : `DLLP ${type.toString(16)}`;
};

// ---- ordered sets --------------------------------------------------------------------------------------------------------
export const TS_LEN = 16, N_FTS = 0x10, TS_RATE = 0x02;
export function tsSymbol(pos: number, ts2: boolean): Sym {
  if (pos === 0) return { d: K_COM, k: 1 };
  if (pos <= 2) return { d: K_PAD, k: 1 };
  if (pos === 3) return { d: N_FTS, k: 0 };
  if (pos === 4) return { d: TS_RATE, k: 0 };
  if (pos === 5) return { d: 0, k: 0 };
  return { d: ts2 ? TS2_ID : TS1_ID, k: 0 };
}

// ---- flow control's test -------------------------------------------------------------------------------------------------
export const FIELD_HDR = 8, FIELD_DATA = 12;
/** The standard's gate: send if (LIMIT − (CONSUMED + want)) mod 2^w ≤ 2^(w−1). */
export const creditOk = (limit: number, consumed: number, want: number, w: number): boolean => {
  const m = 2 ** w;
  return ((limit - consumed - want) % m + m) % m <= m / 2;
};
/** Data credits are 4 dwords each. */
export const dataCredits = (dw: number): number => (dw + 3) >> 2;

// ---- the port ------------------------------------------------------------------------------------------------------------
export const LT_NAMES = ['Detect', 'Polling.Active', 'Polling.Config', 'Config.Idle', 'L0', 'Recovery.Lock', 'Recovery.Config', 'Recovery.Idle'] as const;
export const LT_DETECT = 0, LT_L0 = 4, LT_REC = 5;
export const DL_NAMES = ['DL_Down', 'FC_Init1', 'FC_Init2', 'DL_Up'] as const;
export const DL_DOWN = 0, DL_F1 = 1, DL_F2 = 2, DL_UP = 3;
export const TS_RX = 8, TRAIN_TIMEOUT_BITS = 11;
/** The port's fixed numbers. */
export const TS_TX = 16, REPLAY_SLOTS = 8, REPLAY_LIMIT = 512, ACK_LIMIT = 32, FC_PERIOD_BITS = 11, MAX_RX_TLP = 88, BUF_BITS = 10;
export const ADV_PH = 4, ADV_PD = 16, ADV_NPH = 4;

export interface PortIn {
  rst: number; rxdet: number; rxd: number; rxk: number;
  t_data: number; t_valid: number; t_last: number;
  r_ready: number;
  c_want: number; c_np: number; consume: number;
  rtn_ph: number; rtn_pd: number; rtn_nph: number;
}
export const PORT_IN0: PortIn = { rst: 0, rxdet: 1, rxd: 0, rxk: 0, t_data: 0, t_valid: 0, t_last: 0, r_ready: 0, c_want: 0, c_np: 0, consume: 0, rtn_ph: 0, rtn_pd: 0, rtn_nph: 0 };

const S12 = 0xfff, M = (1 << BUF_BITS) - 1;
const fwd = (a: number, b: number) => (a - b) & S12;

/**
 * One port. out(i) is the comb outputs before the edge; step(i) the edge. Every assignment in step has a line in lib/pcie.ts pciePort.
 * txmem is the replay buffer (9-bit words: a byte and `last`); rxmem the receive buffer.
 */
export class PciePort {
  txmem = new Uint16Array(1 << BUF_BITS); rxmem = new Uint8Array(1 << BUF_BITS);
  // LTSSM
  lt = 0; opos = 0; txc = 0; tmo = 0; op = 0; ok = 0; o2 = 0; tsc = 0; ts2c = 0; idc = 0; wantRec = 0;
  // data link control
  dl = 0; fit = 0; got = 0; got2 = 0;
  // credits
  phLim = 0; pdLim = 0; nphLim = 0; phCc = 0; pdCc = 0; nphCc = 0; caPh = ADV_PH; caPd = ADV_PD; caNph = ADV_NPH; fcP = 0; fcNp = 0; fct = 0;
  // transmitter
  kind = 0; pos = 0; live = 0; dt = 0; dd = 0; nextSeq = 0; ackd = S12; rseq = 0; replay = 0; rreq = 0; rnum = 0; rt = 0; wp = 0; rp = 0; start: number[] = Array<number>(REPLAY_SLOTS).fill(0);
  qt = 0xffffffff; qd = 0xffff;
  // receiver
  rk = 0; rpos = 0; rs = 0; rn = 0; rb = [0, 0, 0, 0]; qr = 0xffffffff; qe = 0xffff; wr = 0; com = 0; rd = 0; nextRcv = 0; nakSent = 0; nakReq = 0; ackReq = 0; ackPend = 0; ackt = 0;

  private outstanding(): number { return fwd(this.nextSeq, (this.ackd + 1) & S12) & 15; }
  /** The start decision of the packet engine, before the edge. */
  private decide(i: PortIn): 'none' | 'load' | 'ack' | 'init' | 'fc' | 'replay' | 'tlp' {
    if (this.kind !== 0 || this.lt !== LT_L0 || this.wantRec) return 'none';
    if (this.rreq) return 'load';
    if (this.nakReq || this.ackReq) return 'ack';
    if (this.dl === DL_F1 || this.dl === DL_F2) return 'init';
    if (this.dl === DL_DOWN) return 'none';
    if (this.fcP || this.fcNp) return 'fc';
    if (this.replay) return 'replay';
    if (i.t_valid && this.outstanding() < REPLAY_SLOTS) return 'tlp';
    return 'none';
  }
  /** The byte the transmitter puts on the wire inside a TLP or a DLLP, before the framing; also what the CRC takes. */
  private seqNow(): number { return this.live ? this.nextSeq : this.rseq; }
  private tlpByte(i: PortIn): number {
    const p = this.pos, s = this.seqNow();
    if (p === 1) return s >> 8;
    if (p === 2) return s & 255;
    if (p === 3) return this.live ? i.t_data : this.txmem[this.rp] & 255;
    return 0;
  }
  private dllpByte(): number {
    const p = this.pos, c = ~this.qd & 0xffff;
    if (p === 1) return this.dt;
    if (p === 2) return (this.dd >>> 16) & 255;
    if (p === 3) return (this.dd >>> 8) & 255;
    if (p === 4) return this.dd & 255;
    if (p === 5) return c & 255;
    if (p === 6) return c >> 8;
    return 0;
  }
  private writing(i: PortIn): number { return this.rk === 1 && this.rpos === 2 && !i.rxk ? 1 : 0; }

  out(i: PortIn) {
    const t1 = this.lt === 1 || this.lt === 5, t2 = this.lt === 2 || this.lt === 6;
    let txd = 0, txk = 0;
    if (t1 || t2) { const s = tsSymbol(this.opos, t2); txd = s.d; txk = s.k; }
    else if (this.lt === LT_L0) {
      if (this.kind === 1) {
        const p = this.pos, fcs = ~this.qt >>> 0;
        if (p === 0) { txd = K_STP; txk = 1; }
        else if (p <= 3) txd = this.tlpByte(i);
        else if (p <= 7) txd = (fcs >>> (8 * (p - 4))) & 255;
        else { txd = K_END; txk = 1; }
      } else if (this.kind === 2) {
        const p = this.pos;
        if (p === 0) { txd = K_SDP; txk = 1; }
        else if (p <= 6) txd = this.dllpByte();
        else { txd = K_END; txk = 1; }
      }
    }
    const t_ready = this.kind === 1 && this.pos === 3 && this.live ? 1 : 0;
    const c_ok = i.c_np ? creditOk(this.nphLim, this.nphCc, 1, FIELD_HDR) : creditOk(this.phLim, this.phCc, 1, FIELD_HDR) && creditOk(this.pdLim, this.pdCc, i.c_want, FIELD_DATA);
    const r_valid = !this.writing(i) && this.rd !== this.com ? 1 : 0;
    return {
      txd, txk, t_ready, c_ok: c_ok && this.dl === DL_UP ? 1 : 0, r_valid, r_data: this.rxmem[this.rd],
      lt: this.lt, dl: this.dl, kind: this.kind, seq: this.nextSeq, ackd: this.ackd, rseq: this.rseq, replay: this.replay, rnum: this.rnum, nrcv: this.nextRcv, nak: this.nakReq, ack: this.ackReq,
      ph_lim: this.phLim, pd_lim: this.pdLim, nph_lim: this.nphLim, ph_cc: this.phCc, pd_cc: this.pdCc, nph_cc: this.nphCc, rt: this.rt,
    };
  }

  step(i: PortIn): void {
    const o = this.out(i), rst = i.rst || !i.rxdet;
    if (rst) { const m = [this.txmem, this.rxmem] as const, st = this.start; Object.assign(this, new PciePort()); this.txmem = m[0]; this.rxmem = m[1]; this.start = st; return; }
    const dec = this.decide(i), k = i.rxk, d = i.rxd;

    // ---- the receiver's ordered-set parser ------
    const isCom = k && d === K_COM, inOs = this.op !== 0;
    let goodEnd = 0, bad = 0, op = this.op, ok = this.ok, o2 = this.o2;
    if (isCom) { op = 1; ok = 1; }
    else if (inOs) {
      const p = this.op;
      let exp: boolean, n2 = this.o2;
      if (p <= 2) exp = !!k && d === K_PAD;
      else if (p <= 5) exp = !k;
      else if (p === 6) { exp = !k && (d === TS1_ID || d === TS2_ID); n2 = d === TS2_ID ? 1 : 0; }
      else exp = !k && d === (this.o2 ? TS2_ID : TS1_ID);
      o2 = n2;
      ok = this.ok && exp ? 1 : 0;
      if (p === 15) { op = 0; goodEnd = ok; bad = ok ? 0 : 1; } else op = p + 1;
    } else bad = 1;
    const recEntry = this.lt === LT_L0 && this.wantRec && this.kind === 0;
    const trainTo = this.lt !== LT_DETECT && this.lt !== LT_L0 && this.tmo === (1 << TRAIN_TIMEOUT_BITS) - 1;
    const tsSat = this.tsc >= TS_RX, ts2Sat = this.ts2c >= TS_RX;
    let tsc = this.tsc, ts2c = this.ts2c;
    if (recEntry || trainTo) { tsc = 0; ts2c = 0; }
    else {
      if (goodEnd) { if (!tsSat) tsc++; } else if (bad && !tsSat) tsc = 0;
      if (goodEnd && o2) { if (!ts2Sat) ts2c++; } else if ((bad || goodEnd) && !ts2Sat) ts2c = 0;
    }
    const idleSt = this.lt === 3 || this.lt === 7, idSat = this.idc >= TS_RX;
    const idc = !idleSt ? 0 : !k && d === 0 ? (idSat ? this.idc : this.idc + 1) : (idSat ? this.idc : 0);

    // ---- the receiver's packets ------
    let rk = this.rk, rpos = this.rpos, rs = this.rs, rn = this.rn, qr = this.qr, qe = this.qe, wr = this.wr, com = this.com, setNak = 0, setAck = 0, nakSent = this.nakSent, nextRcv = this.nextRcv;
    const rb = [...this.rb];
    let tlpGood = 0, dllpGood = 0;
    if (rk === 0) {
      if (k && d === K_STP) { rk = 1; rpos = 0; rn = 0; qr = 0xffffffff; }
      else if (k && d === K_SDP) { rk = 2; rpos = 0; qe = 0xffff; }
    } else if (rk === 1) {
      if (k || rn === MAX_RX_TLP) {
        // the end of a TLP, good or bad; a length past any legal TLP is bad
        rk = 0;
        const crcOk = qr === CRC32_RESIDUE && k && d === K_END && rpos === 2 && rn >= 4;
        const back = wr;
        if (crcOk && rs === nextRcv) { com = (back - 4) & M; wr = com; nextRcv = (nextRcv + 1) & S12; nakSent = 0; tlpGood = 1; }
        else {
          wr = com;
          if (crcOk && fwd(nextRcv, rs) < 2048) setAck = 1;
          else if (!nakSent) { setNak = 1; nakSent = 1; }
        }
      } else {
        qr = stepBits(qr, d, 8, CRC32_REFLECTED, 32);
        if (rpos === 0) { rs = (d & 15) << 8; rpos = 1; }
        else if (rpos === 1) { rs |= d; rpos = 2; }
        else { this.rxmem[wr] = d; wr = (wr + 1) & M; rn++; }
      }
    } else {
      if (rpos < 6) {
        if (k) rk = 0;
        else { if (rpos < 4) rb[rpos] = d; qe = stepBits(qe, d, 8, DLLP_POLY, 16); rpos++; }
      } else {
        rk = 0;
        dllpGood = k && d === K_END && qe === DLLP_RESIDUE ? 1 : 0;
      }
    }
    const dty = this.rb[0] >> 4, dw = (this.rb[1] << 16) | (this.rb[2] << 8) | this.rb[3];
    const dSeq = dw & S12, dHdr = (dw >> 14) & 255, dData = dw & 0xfff, dCls = dty & 3;
    const isAck = dllpGood && dty === 0, isNak = dllpGood && dty === 1;
    const isFc1 = dllpGood && dty >= 4 && dty <= 6, isFc2 = dllpGood && dty >= 0xc && dty <= 0xe, isUpd = dllpGood && dty >= 8 && dty <= 0xa;

    // ---- Ack timer ------
    const ackHit = this.ackPend && this.ackt === ACK_LIMIT - 1;
    const ackPend = tlpGood ? 1 : ackHit ? 0 : this.ackPend, ackt = this.ackPend && !ackHit ? this.ackt + 1 : 0;

    // ---- Ack / Nak taken by the transmitter ------
    const valid = dllpGood && (isAck || isNak) && fwd((this.nextSeq - 1) & S12, dSeq) < 2048;
    const dist = fwd(dSeq, this.ackd), progress = valid && dist !== 0 && dist < 2048;
    const expire = this.outstanding() !== 0 && !this.replay && this.rt === REPLAY_LIMIT - 1;
    const nakHit = !!(valid && isNak);
    const rkick = nakHit || expire;
    const roll = rkick && this.rnum === 3 && !progress;

    // ---- the packet engine ------
    let kind = this.kind, pos = this.pos, live = this.live, dt = this.dt, dd = this.dd, nextSeq = this.nextSeq, rseq = this.rseq, replay = this.replay, wp = this.wp, rp = this.rp;
    let rreq = this.rreq, fit = this.fit, dl = this.dl, fcP = this.fcP, fcNp = this.fcNp, qt = this.qt, qd = this.qd;
    if (this.kind === 1) {
      const b = this.tlpByte(i);
      const p = this.pos;
      if (p <= 2) { if (p > 0) qt = stepBits(qt, b, 8, CRC32_REFLECTED, 32); pos = p + 1; }
      else if (p === 3) {
        if (this.live) {
          if (i.t_valid) {
            this.txmem[this.wp] = (i.t_data | (i.t_last ? 256 : 0));
            wp = (this.wp + 1) & M;
            qt = stepBits(qt, b, 8, CRC32_REFLECTED, 32);
            if (i.t_last) pos = 4;
          }
        } else {
          rp = (this.rp + 1) & M;
          qt = stepBits(qt, b, 8, CRC32_REFLECTED, 32);
          if (this.txmem[this.rp] & 256) pos = 4;
        }
      } else if (p <= 7) pos = p + 1;
      else {
        kind = 0; pos = 0;
        if (this.live) nextSeq = (this.nextSeq + 1) & S12;
        else { rseq = (this.rseq + 1) & S12; if (rseq === this.nextSeq) replay = 0; }
      }
    } else if (this.kind === 2) {
      const p = this.pos;
      if (p >= 1 && p <= 4) qd = stepBits(qd, this.dllpByte(), 8, DLLP_POLY, 16);
      if (p === 7) { kind = 0; pos = 0; } else pos = p + 1;
    }
    const startPkt = (kd: number, type = 0, word = 0) => { kind = kd; pos = 0; dt = type; dd = word; qt = 0xffffffff; qd = 0xffff; };
    if (dec === 'load') {
      rreq = 0;
      if (this.outstanding() !== 0) { rseq = (this.ackd + 1) & S12; rp = this.start[rseq & (REPLAY_SLOTS - 1)]; replay = 1; }
    } else if (dec === 'ack') {
      startPkt(2, this.nakReq ? DLLP_NAK : DLLP_ACK, (this.nextRcv - 1) & S12);
    } else if (dec === 'init') {
      const base = this.dl === DL_F1 ? DLLP_INIT1 : DLLP_INIT2;
      startPkt(2, base + 0x10 * this.fit, this.fit === 0 ? fcWord(this.caPh, this.caPd) : this.fit === 1 ? fcWord(this.caNph, 0) : 0);
      if (this.fit === 2) {
        fit = 0;
        if (this.dl === DL_F1 && this.got === 7) dl = DL_F2;
        if (this.dl === DL_F2 && this.got2) dl = DL_UP;
      } else fit = this.fit + 1;
    } else if (dec === 'fc') {
      if (this.fcP) { startPkt(2, DLLP_UPDATE, fcWord(this.caPh, this.caPd)); fcP = 0; }
      else { startPkt(2, DLLP_UPDATE + 0x10, fcWord(this.caNph, 0)); fcNp = 0; }
    } else if (dec === 'replay') { startPkt(1); live = 0; }
    else if (dec === 'tlp') {
      startPkt(1); live = 1;
      this.start[this.nextSeq & (REPLAY_SLOTS - 1)] = this.wp;
    }
    if (this.dl === DL_DOWN && this.lt === LT_L0) dl = DL_F1;
    if (rkick) rreq = 1;

    // ---- requests the packet engine took; one raised on this very edge survives ------
    const tookNak = dec === 'ack' && this.nakReq, tookAck = dec === 'ack' && !this.nakReq;
    const nakReq = setNak || (this.nakReq && !tookNak) ? 1 : 0, ackReq = setAck || ackHit || (this.ackReq && !tookAck) ? 1 : 0;

    // ---- the replay timer and REPLAY_NUM ------
    let rt = this.rt;
    if (progress || rkick || dec === 'load' || this.outstanding() === 0 || this.replay) rt = 0;
    else if (this.lt === LT_L0) rt = this.rt + 1;
    let rnum = this.rnum;
    if (progress) rnum = 0;
    else if (rkick) rnum = (this.rnum + 1) & 3;
    const ackd = progress ? dSeq : this.ackd;

    // ---- flow control ------
    if (i.consume) {
      if (i.c_np) this.nphCc = (this.nphCc + 1) & 255;
      else { this.phCc = (this.phCc + 1) & 255; this.pdCc = (this.pdCc + i.c_want) & 0xfff; }
    }
    let got = this.got, got2 = this.got2, phLim = this.phLim, pdLim = this.pdLim, nphLim = this.nphLim;
    if ((isFc1 || isFc2) && !((got >> dCls) & 1) && dCls < 3) {
      got |= 1 << dCls;
      if (dCls === 0) { phLim = dHdr; pdLim = dData; } else if (dCls === 1) nphLim = dHdr;
    }
    if (isUpd) { if (dCls === 0) { phLim = dHdr; pdLim = dData; } else if (dCls === 1) nphLim = dHdr; }
    if (isFc2 || isUpd || tlpGood) got2 = 1;
    const fcTick = this.dl === DL_UP && this.fct === (1 << FC_PERIOD_BITS) - 1;
    if (i.rtn_ph || i.rtn_pd || fcTick) fcP = 1;
    if (i.rtn_nph || fcTick) fcNp = 1;
    this.fct = this.dl === DL_UP ? (this.fct + 1) & ((1 << FC_PERIOD_BITS) - 1) : 0;
    this.caPh = (this.caPh + i.rtn_ph) & 255; this.caPd = (this.caPd + i.rtn_pd) & 0xfff; this.caNph = (this.caNph + i.rtn_nph) & 255;

    // ---- the receive buffer's reader ------
    if (o.r_valid && i.r_ready) this.rd = (this.rd + 1) & M;

    // ---- LTSSM ------
    const ts = this.lt === 1 || this.lt === 2 || this.lt === 5 || this.lt === 6;
    const end = this.opos === 15, enough = this.txc >= TS_TX;
    let lt = this.lt;
    switch (this.lt) {
      case 0: lt = 1; break;
      case 1: case 5: if (end && enough && tsSat) lt = this.lt + 1; break;
      case 2: case 6: if (end && enough && ts2Sat) lt = this.lt + 1; break;
      case 3: case 7: if (enough && idSat) lt = LT_L0; break;
      case LT_L0: if (recEntry) lt = LT_REC; break;
    }
    if (trainTo) lt = this.lt < LT_L0 ? 1 : LT_REC;
    const changed = lt !== this.lt;
    this.tmo = changed || this.lt === LT_DETECT || this.lt === LT_L0 ? 0 : (this.tmo + 1) & ((1 << TRAIN_TIMEOUT_BITS) - 1);
    this.txc = changed ? 0 : (ts ? end : idleSt) && !enough ? this.txc + 1 : this.txc;
    this.opos = changed || !ts ? 0 : (this.opos + 1) & 15;
    this.wantRec = recEntry ? 0 : this.wantRec || roll || (this.lt === LT_L0 && goodEnd) ? 1 : 0;

    // ---- commit ------
    this.lt = lt; this.op = op; this.ok = ok; this.o2 = o2; this.tsc = tsc; this.ts2c = ts2c; this.idc = idc;
    this.dl = dl; this.fit = fit; this.got = got; this.got2 = got2; this.phLim = phLim; this.pdLim = pdLim; this.nphLim = nphLim; this.fcP = fcP; this.fcNp = fcNp;
    this.kind = kind; this.pos = pos; this.live = live; this.dt = dt; this.dd = dd; this.nextSeq = nextSeq; this.ackd = ackd; this.rseq = rseq; this.replay = replay; this.rreq = rreq; this.rnum = rnum; this.rt = rt; this.wp = wp; this.rp = rp; this.qt = qt; this.qd = qd;
    this.rk = rk; this.rpos = rpos; this.rs = rs; this.rn = rn; this.rb = rb; this.qr = qr; this.qe = qe; this.wr = wr; this.com = com; this.nextRcv = nextRcv; this.nakSent = nakSent; this.nakReq = nakReq; this.ackReq = ackReq; this.ackPend = ackPend; this.ackt = ackt;
  }
}

// ---- the transaction layer's two ends ------------------------------------------------------------------------------------
const RS_HDR = 0, RS_DATA = 1;
export const R_IDLE = 0, R_WAIT = 1, R_HDR = 2, R_DATA = 3;
export interface RootIn { rst: number; go: number; wr: number; addr: number; len: number; seed: number; t_ready: number; c_ok: number; r_valid: number; r_data: number }

/** The requester: one command at a time, a memory write of counting bytes from seed, or a memory read; a tag per request. */
export class RootTl {
  st = R_IDLE; i = 0; cw = 0; ca = 0; cl = 0; cs = 0; tag = 0;
  rs = RS_HDR; p = 0; rlen = 0; rtag = 0; rem = 0;
  head(): number[] { return tlpBytes({ kind: this.cw ? 'MWr' : 'MRd', len: this.cl, tag: this.tag, addr: this.ca * 4 }); }
  out() {
    const hdr = this.st === R_HDR, dat = this.st === R_DATA, n = this.cl * 4;
    return {
      t_valid: hdr || dat ? 1 : 0, t_data: hdr ? this.head()[this.i] : dat ? (this.cs + this.i) & 255 : 0,
      t_last: (hdr && !this.cw && this.i === 11) || (dat && this.i === n - 1) ? 1 : 0,
      c_want: this.cw ? dataCredits(this.cl) : 0, c_np: this.cw ? 0 : 1, busy: this.st !== R_IDLE ? 1 : 0, wait: this.st === R_WAIT ? 1 : 0, r_ready: 1,
      rtag: this.rtag, rdata_mode: this.rs,
    };
  }
  consume(c_ok: number): number { return this.st === R_WAIT && c_ok ? 1 : 0; }
  step(i: RootIn): void {
    if (i.rst) { Object.assign(this, new RootTl()); return; }
    const o = this.out(), n = this.cl * 4;
    if (this.st === R_IDLE) { if (i.go) { this.cw = i.wr; this.ca = i.addr; this.cl = i.len; this.cs = i.seed; this.st = R_WAIT; this.i = 0; } }
    else if (this.st === R_WAIT) { if (i.c_ok) { this.st = R_HDR; this.i = 0; } }
    else if (o.t_valid && i.t_ready) {
      if (this.st === R_HDR) {
        if (this.i === 11) { if (this.cw) { this.st = R_DATA; this.i = 0; } else { this.st = R_IDLE; this.i = 0; this.tag = (this.tag + 1) & 31; } } else this.i++;
      } else if (this.i === n - 1) { this.st = R_IDLE; this.i = 0; this.tag = (this.tag + 1) & 31; } else this.i++;
    }
    if (i.r_valid) {
      if (this.rs === RS_HDR) {
        if (this.p === 3) this.rlen = i.r_data & 31;
        if (this.p === 10) this.rtag = i.r_data & 31;
        if (this.p === 11) { this.p = 0; this.rs = RS_DATA; this.rem = this.rlen * 4; } else this.p++;
      } else { this.rem = (this.rem - 1) & 127; if (this.rem === 0) this.rs = RS_HDR; }
    }
  }
}

export const E_HDR = 0, E_WDATA = 1, E_CHDR = 2, E_CDATA = 3;
export const EP_MEM_BITS = 10, COMPLETER_ID = 0x0100;
export interface EpIn { rst: number; t_ready: number; r_valid: number; r_data: number }

/** The completer: a kilobyte of memory; writes stored, reads answered with one completion. One TLP at a time: while it sends a completion it takes nothing in. */
export class EpTl {
  ram = new Uint8Array(1 << EP_MEM_BITS);
  st = E_HDR; i = 0; hw = 0; hlen = 0; htag = 0; haddr = 0;
  private at(): number { return ((this.haddr << 2) + this.i) & ((1 << EP_MEM_BITS) - 1); }
  private cpl(): number[] { return tlpBytes({ kind: 'CplD', len: this.hlen, tag: this.htag, completer: COMPLETER_ID, addr: this.haddr << 2 }); }
  out(i: EpIn) {
    const wdata = this.st === E_WDATA, n = this.hlen * 4, cdata = this.st === E_CDATA, chdr = this.st === E_CHDR;
    const lastW = wdata && i.r_valid && this.i === n - 1 ? 1 : 0, endHdr = this.st === E_HDR && i.r_valid && this.i === 11;
    return {
      r_ready: this.st === E_HDR || wdata ? 1 : 0, t_valid: chdr || cdata ? 1 : 0, t_data: chdr ? this.cpl()[this.i] : cdata ? this.ram[this.at()] : 0, t_last: cdata && this.i === n - 1 ? 1 : 0,
      rtn_ph: lastW, rtn_pd: lastW ? dataCredits(this.hlen) : 0, rtn_nph: endHdr && !this.hw ? 1 : 0, ep_st: this.st,
    };
  }
  step(i: EpIn): void {
    if (i.rst) { const r = this.ram; Object.assign(this, new EpTl()); this.ram = r; return; }
    const n = this.hlen * 4;
    if (this.st === E_HDR) {
      if (i.r_valid) {
        if (this.i === 0) this.hw = (i.r_data >> 6) & 1;
        if (this.i === 3) this.hlen = i.r_data & 31;
        if (this.i === 6) this.htag = i.r_data & 31;
        if (this.i === 10) this.haddr = (this.haddr & 63) | ((i.r_data & 3) << 6);
        if (this.i === 11) { this.haddr = (this.haddr & 0xc0) | (i.r_data >> 2); this.i = 0; this.st = this.hw ? E_WDATA : E_CHDR; } else this.i++;
      }
    } else if (this.st === E_WDATA) {
      if (i.r_valid) { this.ram[this.at()] = i.r_data; if (this.i === n - 1) { this.i = 0; this.st = E_HDR; } else this.i++; }
    } else if (i.t_ready) {
      if (this.st === E_CHDR) { if (this.i === 11) { this.i = 0; this.st = E_CDATA; } else this.i++; }
      else if (this.i === n - 1) { this.i = 0; this.st = E_HDR; } else this.i++;
    }
  }
}

// ---- the link ------------------------------------------------------------------------------------------------------------
export const LINE_DELAY = 4;
export interface LinkIn { rst: number; plug: number; go: number; wr: number; addr: number; len: number; seed: number; flip_ab: number; flip_ba: number }
export const LINK_IN0: LinkIn = { rst: 0, plug: 1, go: 0, wr: 0, addr: 0, len: 1, seed: 0, flip_ab: 0, flip_ba: 0 };

/** Both ports, both transaction layers and the two directions of a lane: a delay and a flipped bit, a model labelled as one. */
export class PcieLink {
  a = new PciePort(); b = new PciePort(); ra = new RootTl(); eb = new EpTl();
  ab: number[] = Array<number>(LINE_DELAY).fill(0); ba: number[] = Array<number>(LINE_DELAY).fill(0);
  private wires(i: LinkIn) {
    const ta = this.ra.out(), rxa = this.ba[0], rxb = this.ab[0];
    const ain: PortIn = { ...PORT_IN0, rst: i.rst, rxdet: i.plug, rxd: rxa & 255, rxk: rxa >> 8, t_data: ta.t_data, t_valid: ta.t_valid, t_last: ta.t_last, r_ready: 1, c_want: ta.c_want, c_np: ta.c_np, consume: 0 };
    const a0 = this.a.out(ain), consume = this.ra.consume(a0.c_ok);
    ain.consume = consume;
    const bPre: PortIn = { ...PORT_IN0, rst: i.rst, rxdet: i.plug, rxd: rxb & 255, rxk: rxb >> 8 };
    const b0 = this.b.out(bPre);
    const tlRst = i.rst || !i.plug ? 1 : 0;   // link down: the transaction layer's state goes with it
    const einp: EpIn = { rst: tlRst, t_ready: b0.t_ready, r_valid: b0.r_valid, r_data: b0.r_data };
    const te = this.eb.out(einp);
    const bin: PortIn = { ...bPre, t_data: te.t_data, t_valid: te.t_valid, t_last: te.t_last, r_ready: te.r_ready, rtn_ph: te.rtn_ph, rtn_pd: te.rtn_pd, rtn_nph: te.rtn_nph };
    const bo = this.b.out(bin);
    const rd_valid = a0.r_valid && this.ra.rs === RS_DATA ? 1 : 0;
    return { ain, bin, einp, a: a0, b: bo, ta, te, consume, rd_valid, rd_data: a0.r_data, rd_done: rd_valid && this.ra.rem === 1 ? 1 : 0 };
  }
  out(i: LinkIn) { return this.wires(i); }
  step(i: LinkIn): void {
    const w = this.wires(i);
    this.ab.push((w.a.txk << 8 | w.a.txd) ^ i.flip_ab); this.ab.shift();
    this.ba.push((w.b.txk << 8 | w.b.txd) ^ i.flip_ba); this.ba.shift();
    const rin: RootIn = { rst: i.rst || !i.plug ? 1 : 0, go: i.go, wr: i.wr, addr: i.addr, len: i.len, seed: i.seed, t_ready: w.a.t_ready, c_ok: w.a.c_ok, r_valid: w.a.r_valid, r_data: w.a.r_data };
    this.a.step(w.ain); this.b.step(w.bin); this.ra.step(rin); this.eb.step(w.einp);
  }
  /** Run until the link is up (a bound for a test). */
  bringUp(limit = 4000): number {
    let n = 0;
    while ((this.a.dl !== DL_UP || this.b.dl !== DL_UP) && n < limit) { this.step(LINK_IN0); n++; }
    return n;
  }
}
