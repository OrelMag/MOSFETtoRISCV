// Chapter 48's Ethernet MAC, DOM-free: the golden model of each block, clock by clock. lib/ethernet.ts builds the same
// machines in gates and tests/comm-mac.test.ts compares every output after every clock. A block here is written as the
// gates are: registers updated together from their old values, pulses that last one clock, no hidden state.
//
// Link speed (roadmap Phase 21, decision 7): a bit is 4 clocks, so a byte is 32 and, at the single-cycle CPU's 3.95 ns
// clock, the line carries 63 Mb/s. Frame fields, FCS and gaps are IEEE 802.3's (comm/ethframe.ts); the half-duplex
// constants below are 802.3 clause 4.2.3.2 (slotTime 512 bit times, interFrameGap 96, attemptLimit 16, backoffLimit 10,
// jamSize 32).

import { CRC32_RESIDUE, stepBits } from './crc';
import { FCS_BYTES, MAX_FRAME, MIN_FRAME } from './ethframe';

export const BIT_CLOCKS = 4;
export const BYTE_CLOCKS = 8 * BIT_CLOCKS;
/** The clock of the single-cycle CPU (CLOCK_NS in dram/timing.ts), and what the link rate follows from. */
export const CLOCK_NS = 3.95;
export const SLOT_BITS = 512;
export const SLOT_CLOCKS = SLOT_BITS * BIT_CLOCKS;
export const GAP_BITS = 96;
export const GAP_CLOCKS = GAP_BITS * BIT_CLOCKS;
export const JAM_BYTES = 4;
export const ATTEMPT_LIMIT = 16;
export const BACKOFF_LIMIT = 10;
export const PREAMBLE_BYTES = 8;
export const SRC_BITS = 11;
export const RX_BITS = 11;
export const LFSR_BITS = 10;
export const JAM_BYTE = 0xaa;
/** Bit rate of the link in Mb/s: one bit every BIT_CLOCKS clocks. */
export const LINK_MBPS = 1000 / (CLOCK_NS * BIT_CLOCKS);
export const clocksToUs = (c: number): number => (c * CLOCK_NS) / 1000;

// ---- shared helpers ----------------------------------------------------------------------------------------------------

/** The XNOR LFSR of the backoff: x^10 + x^7 + 1, period 1023 (all ones is its locked state, so seeds must not be 1023). */
export const lfsrNext = (q: number): number => ((q << 1) & 0x3ff) | ((~((q >> 9) ^ (q >> 6))) & 1);
/** The backoff draw after the n-th collision: the low min(n, 10) bits of the LFSR. */
export const backoffMask = (collisions: number): number => (1 << Math.min(collisions, BACKOFF_LIMIT)) - 1;

// ---- the transmitter ---------------------------------------------------------------------------------------------------

export interface TxIn { rst: number; data: number; valid: number; last: number; crs: number; col: number; seed: number }

/**
 * Preamble and SFD, the stream's bytes, zero pad up to the 60 before the FCS, the FCS, with carrier sense, deferral, collision
 * handling and backoff. Serial out, least significant bit first, one bit per BIT_CLOCKS clocks. `ready` (a function of the
 * state alone) is 1 in the clock in which the next stream byte is taken, if `valid` is 1 then; a byte not valid then ends the
 * frame (an underrun is a short frame, padded and checked like any other).
 */
export class MacTx {
  pre = 0; dat = 0; fcs = 0; jam = 0; back = 0;
  ph = 0; bit = 0; sh = 0; pc = 0; nb = 0; eof = 0; fc = 0; att = 0; bo = 0; slot = 0; gap = 0; lfsr = 0;
  q = 0xffffffff;
  restart = 0; drop = 0; sent = 0;

  get act(): number { return this.pre | this.dat | this.fcs | this.jam; }
  get txen(): number { return this.act; }
  get txd(): number { return this.act ? this.sh & 1 : 0; }
  get boundary(): boolean { return this.act === 1 && this.ph === 3 && this.bit === 7; }
  get ready(): number { return this.boundary && ((this.pre && this.pc === 7) || (this.dat && !this.eof)) ? 1 : 0; }
  /** 0 idle, 1 preamble, 2 data, 3 FCS, 4 jam, 5 backoff. */
  get state(): number { return this.pre ? 1 : this.dat ? 2 : this.fcs ? 3 : this.jam ? 4 : this.back ? 5 : 0; }

  step(i: TxIn): void {
    if (i.rst) {
      this.pre = this.dat = this.fcs = this.jam = this.back = 0;
      this.ph = this.bit = this.sh = this.pc = this.nb = this.eof = this.fc = this.att = this.bo = this.slot = this.gap = 0;
      this.lfsr = i.seed & 0x3ff; this.restart = this.drop = this.sent = 0;
      return;
    }
    const act = this.act === 1, idle = !act && !this.back;
    const tick = act && this.ph === 3, bb = tick && this.bit === 7;
    const pc7 = this.pc === 7, pc6 = this.pc === 6, pc3 = this.pc === 3, nb60 = this.nb === 60, att15 = this.att === 15;
    const gapok = this.gap >= GAP_CLOCKS;
    const start = idle && !!i.valid && gapok && !i.crs;
    const colhit = !!i.col && (this.pre === 1 || this.dat === 1 || this.fcs === 1);
    const preEnd = this.pre === 1 && bb && pc7;
    const datEnd = this.dat === 1 && bb && this.eof === 1 && nb60;
    const fcsEnd = this.fcs === 1 && bb && this.fc === 3;
    const jamEnd = this.jam === 1 && bb && pc3;
    const loadData = bb && ((this.pre === 1 && pc7) || (this.dat === 1 && !(this.eof === 1 && nb60)));
    const dbyte = i.valid ? i.data & 0xff : 0, dd = this.eof ? 0 : dbyte;
    const fidx = this.fcs ? (this.fc + 1) & 3 : 0, fbyte = ((~this.q >>> 0) >>> (8 * fidx)) & 0xff;

    // the byte the shift register takes at a byte boundary
    let load = 0;
    if (this.pre) load = pc7 ? dbyte : pc6 ? 0xd5 : 0x55;
    else if (this.dat) load = this.eof && nb60 ? fbyte : dd;
    else if (this.fcs) load = fbyte;
    else if (this.jam) load = pc3 ? 0 : JAM_BYTE;

    const n_sh = colhit ? JAM_BYTE : start ? 0x55 : tick && !bb ? this.sh >> 1 : bb ? load : this.sh;
    const n_pre = start || (this.pre === 1 && !preEnd && !colhit) ? 1 : 0;
    const n_dat = (preEnd && !colhit) || (this.dat === 1 && !datEnd && !colhit) ? 1 : 0;
    const n_fcs = (datEnd && !colhit) || (this.fcs === 1 && !fcsEnd && !colhit) ? 1 : 0;
    const n_jam = colhit || (this.jam === 1 && !jamEnd) ? 1 : 0;
    const n_back = (jamEnd && !att15) || (this.back === 1 && this.bo !== 0) ? 1 : 0;
    const n_ph = colhit || start ? 0 : act ? (this.ph + 1) & 3 : 0;
    const n_bit = colhit || start ? 0 : tick ? (this.bit + 1) & 7 : this.bit;
    const n_pc = colhit || start ? 0 : bb ? (preEnd || jamEnd || this.dat || this.fcs ? 0 : (this.pc + 1) & 7) : this.pc;
    const n_nb = start ? 0 : loadData ? (nb60 ? 60 : this.nb + 1) : this.nb;
    const n_eof = start ? 0 : bb && ((this.pre === 1 && pc7) || (this.dat === 1 && !this.eof)) ? (i.valid && !i.last ? 0 : 1) : this.eof;
    const n_fc = start || datEnd ? 0 : this.fcs && bb ? (this.fc + 1) & 3 : this.fc;
    const n_att = fcsEnd || (jamEnd && att15) ? 0 : jamEnd ? this.att + 1 : this.att;
    const n_bo = jamEnd && !att15 ? this.lfsr & backoffMask(this.att + 1) : this.back && this.bo !== 0 && this.slot === 2047 ? this.bo - 1 : this.bo;
    const n_slot = this.back && this.bo !== 0 ? (this.slot + 1) & 2047 : this.slot;
    const n_gap = i.crs || act ? 0 : gapok ? this.gap : this.gap + 1;
    const n_lfsr = lfsrNext(this.lfsr);
    const n_q = start ? 0xffffffff : loadData ? stepBits(this.q, dd, 8) : this.q;
    this.restart = jamEnd && !att15 ? 1 : 0;
    this.drop = jamEnd && att15 ? 1 : 0;
    this.sent = fcsEnd ? 1 : 0;
    this.sh = n_sh;
    this.pre = n_pre;
    this.dat = n_dat;
    this.fcs = n_fcs;
    this.jam = n_jam;
    this.back = n_back;
    this.ph = n_ph;
    this.bit = n_bit;
    this.pc = n_pc;
    this.nb = n_nb;
    this.eof = n_eof;
    this.fc = n_fc;
    this.att = n_att;
    this.bo = n_bo;
    this.slot = n_slot;
    this.gap = n_gap;
    this.lfsr = n_lfsr;
    this.q = n_q;
  }
}

// ---- the receiver ------------------------------------------------------------------------------------------------------

export interface RxIn { rst: number; rxd: number; crs: number; ready: number; promisc: number; addr: readonly number[] }

/** why[] bits at `last`. */
export const WHY_FCS = 1, WHY_RUNT = 2, WHY_LONG = 4, WHY_ADDR = 8, WHY_LOST = 16;
export const WHY_NAMES = ['FCS', 'runt', 'too long', 'not for me', 'overrun'];

/**
 * Bits in, bytes out. The wire's carrier (`crs`) frames the reception; the receiver aligns its 4-clock bit to the preamble's
 * edges, takes the third clock of each bit, shifts until the last eight bits are the SFD, then counts bytes. The stream
 * leaves four bytes late (the FCS is stripped without knowing where the frame ends), one more while the last data byte
 * waits for the carrier to fall: a byte comes out when the next one completes, and the final one with `last` and the verdict.
 */
export class MacRx {
  hunt = 0; body = 0; rq = 0; ph = 0; bit = 0; sh = 0; rn = 0; match = 0; grp = 0; lost = 0; long = 0; q = 0xffffffff;
  d = [0, 0, 0, 0, 0];
  valid = 0; data = 0; last = 0; err = 0; why = 0; drop = 0;

  get state(): number { return this.body ? 2 : this.hunt ? 1 : 0; }

  step(i: RxIn): void {
    if (i.rst) {
      this.hunt = this.body = this.rq = this.ph = this.bit = this.sh = this.rn = this.match = this.grp = this.lost = this.long = 0;
      this.valid = this.last = this.err = this.why = this.drop = 0;
      return;
    }
    const idle = !this.hunt && !this.body, cr = !!i.crs;
    const edge = i.rxd !== this.rq;
    const pheff = !this.body && (edge || idle) ? 0 : this.ph;
    const smp = !idle && cr && pheff === 2;
    const fall = !idle && !cr;
    this.valid = 0; this.last = 0; this.err = 0; this.why = 0; this.drop = 0;
    this.rq = i.rxd;
    if (idle) {
      if (cr) { this.hunt = 1; this.ph = 1; this.bit = 0; } else this.ph = 0;
      return;
    }
    if (fall) {
      if (this.body) {
        if (this.rn >= 5) {
          const why = (this.q !== CRC32_RESIDUE ? WHY_FCS : 0) | (this.rn < MIN_FRAME ? WHY_RUNT : 0) | (this.long ? WHY_LONG : 0)
            | (i.promisc || this.grp || this.match ? 0 : WHY_ADDR) | (this.lost || !i.ready ? WHY_LOST : 0);
          this.valid = 1; this.data = this.d[4]; this.last = 1; this.why = why; this.err = why ? 1 : 0;
        } else this.drop = 1;
      }
      this.hunt = this.body = 0; this.ph = 0;
      return;
    }
    this.ph = (pheff + 1) & 3;
    if (!smp) return;
    const nsh = (i.rxd << 7) | (this.sh >> 1);
    this.sh = nsh;
    if (this.hunt) {
      if (nsh === 0xd5) { this.hunt = 0; this.body = 1; this.bit = 0; this.rn = 0; this.match = 1; this.grp = 0; this.lost = 0; this.long = 0; this.q = 0xffffffff; }
      return;
    }
    const complete = this.bit === 7;
    this.bit = (this.bit + 1) & 7;
    if (!complete) return;
    if (this.rn >= 5 && !this.long) {
      this.valid = 1; this.data = this.d[4];
      if (!i.ready) this.lost = 1;
    }
    this.d = [nsh, this.d[0], this.d[1], this.d[2], this.d[3]];
    this.q = stepBits(this.q, nsh, 8);
    if (this.rn < 6) {
      this.match = this.match && nsh === i.addr[this.rn] ? 1 : 0;
      if (this.rn === 0) this.grp = nsh & 1;
    }
    if (this.rn >= MAX_FRAME) this.long = 1;
    if (this.rn < 2047) this.rn++;
  }
}

// ---- the shared wire ---------------------------------------------------------------------------------------------------

/** Clocks between two stations: the distance along the cable, at least one. */
export const wireDelay = (x: readonly number[], i: number, j: number): number => Math.max(1, Math.abs(x[i] - x[j]));

/**
 * Stations at positions x (in clocks of propagation) along one cable. What station i hears is the OR of the other stations'
 * signals, each delayed by the distance: `crs[i]` is 1 while any other is sending (txen), `rxd[i]` the OR of what they send.
 * Two senders at once superpose into garbage, which the receiver's FCS rejects; the sender hears the other one only after
 * the delay, which is how it knows (collision = I am sending and I hear someone). `clash` is the cable's own view: two
 * drivers on at the same instant, undelayed. A station's own signal is not here: it is at its own end of the wire at once.
 */
/** The history a wire keeps: per station, the last samples of (txen << 1 | txd), newest first. */
export const wireHistory = (x: readonly number[]): number[][] => {
  const L = Math.max(1, ...x.flatMap((_, i) => x.map((__, j) => (i === j ? 0 : wireDelay(x, i, j)))));
  return x.map(() => new Array<number>(L).fill(0));
};
/** Sample the drivers at a rising edge into the history. */
export function wirePush(hist: number[][], txd: readonly number[], txen: readonly number[]): void {
  for (let j = 0; j < hist.length; j++) { hist[j].pop(); hist[j].unshift((txen[j] << 1) | (txd[j] & 1)); }
}
/** What every station hears given the history (rxd, crs) and the cable's own two-drivers flag. */
export function wireOutputs(x: readonly number[], hist: readonly number[][]): { rxd: number[]; crs: number[]; clash: number } {
  const n = x.length, rxd: number[] = [], crs: number[] = [];
  let on = 0;
  for (let j = 0; j < n; j++) on += hist[j][0] >> 1;
  for (let i = 0; i < n; i++) {
    let c = 0, d = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const v = hist[j][wireDelay(x, i, j) - 1];
      c |= v >> 1; d |= v & (v >> 1);
    }
    crs.push(c); rxd.push(d);
  }
  return { rxd, crs, clash: on >= 2 ? 1 : 0 };
}

export class SharedWire {
  hist: number[][];
  rxd: number[]; crs: number[]; clash = 0;
  constructor(public x: readonly number[]) {
    this.hist = wireHistory(x);
    this.rxd = x.map(() => 0); this.crs = x.map(() => 0);
  }
  /** Sample the drivers at a rising edge (txd, txen: one entry per station). */
  step(txd: readonly number[], txen: readonly number[]): void {
    wirePush(this.hist, txd, txen);
    const o = wireOutputs(this.x, this.hist);
    this.rxd = o.rxd; this.crs = o.crs; this.clash = o.clash;
  }
}

// ---- a station and a segment -------------------------------------------------------------------------------------------

export interface StationIn { rst: number; go: number; len: number; we?: number; wa?: number; wd?: number }

/**
 * ETH_STATION in software: a frame source (a byte buffer and a read pointer) feeding a MacTx, a MacRx behind the address
 * filter feeding a receive buffer that keeps a frame only if the FCS says it is good. The receive path uses the second of the
 * two ways to treat a frame already partly delivered: the consumer buffers it and learns the verdict at `last`, then
 * commits it (the commit pointer moves) or rewinds the write pointer.
 */
export class Station {
  tx: MacTx; rx = new MacRx();
  txmem = new Uint8Array(1 << SRC_BITS); rxmem = new Uint8Array(1 << RX_BITS);
  busy = 0; tail = 0; len = 0; rp = 0;
  wp = 0; cp = 0; ngood = 0; nbad = 0; ncol = 0;
  /** What the wire gave this clock; set by Segment. */
  rxdO = 0; crsO = 0;
  constructor(public addr: readonly number[], public seed: number, public promisc = 0) { this.tx = new MacTx(); }
  get valid(): number { return this.busy && !this.tail ? 1 : 0; }
  get data(): number { return this.txmem[this.rp]; }
  get lastByte(): number { return ((this.rp + 1) & ((1 << SRC_BITS) - 1)) === this.len ? 1 : 0; }
  get crs(): number { return this.tx.txen | this.crsO; }
  get col(): number { return this.tx.txen & this.crsO; }
  /** Load a frame (destination to pad, no FCS) into the buffer at 0. */
  load(bytes: ArrayLike<number>): void { for (let i = 0; i < bytes.length; i++) this.txmem[i] = bytes[i]; }

  step(i: StationIn): void {
    const tx = this.tx, rx = this.rx;
    const take = tx.ready && this.valid;
    const txIn: TxIn = { rst: i.rst, data: this.data, valid: this.valid, last: this.lastByte, crs: this.crs, col: this.col, seed: this.seed };
    const rxIn: RxIn = { rst: i.rst, rxd: this.rxdO, crs: this.crsO & ~tx.txen & 1, ready: 1, promisc: this.promisc, addr: this.addr };
    // sources and buffers use this clock's registered pulses
    const restart = tx.restart, drop = tx.drop, sent = tx.sent, lastTaken = take && this.lastByte;
    const ov = rx.valid, ol = rx.last, oerr = rx.err, od = rx.data;
    const rwp = this.wp;
    tx.step(txIn);
    rx.step(rxIn);
    if (i.we) this.txmem[(i.wa ?? 0) & 0x7ff] = (i.wd ?? 0) & 0xff;
    if (i.rst) { this.busy = this.tail = this.len = this.rp = this.wp = this.cp = this.ngood = this.nbad = this.ncol = 0; return; }
    if (i.go && !this.busy) { this.busy = 1; this.len = i.len & 0x7ff; this.rp = 0; this.tail = 0; }
    else {
      if (restart) { this.rp = 0; this.tail = 0; }
      else if (take) { if (lastTaken) this.tail = 1; this.rp = (this.rp + 1) & 0x7ff; }
      if (sent || drop) this.busy = 0;
    }
    if (restart || drop) this.ncol = (this.ncol + 1) & 0xff;
    if (ov) {
      this.rxmem[rwp] = od;
      if (!ol) this.wp = (rwp + 1) & 0x7ff;
      else if (oerr) { this.wp = this.cp; this.nbad = (this.nbad + 1) & 0xff; }
      else { this.wp = (rwp + 1) & 0x7ff; this.cp = this.wp; this.ngood = (this.ngood + 1) & 0xff; }
    }
  }
  /** The frame bytes committed between two commit pointers. */
  frameAt(from: number, to: number): number[] {
    const out: number[] = [];
    for (let a = from; a !== to; a = (a + 1) & 0x7ff) out.push(this.rxmem[a]);
    return out;
  }
}

/** Stations on one cable. step() = one clock for everything; the wire's outputs are those after the last edge. */
export class Segment {
  wire: SharedWire;
  t = 0;
  constructor(public st: Station[], x: readonly number[]) {
    this.wire = new SharedWire(x);
    this.feed();
  }
  private feed(): void { this.st.forEach((s, i) => { s.rxdO = this.wire.rxd[i]; s.crsO = this.wire.crs[i]; }); }
  step(inp: StationIn[]): void {
    const txd = this.st.map((s) => s.tx.txd), txen = this.st.map((s) => s.tx.txen);
    this.st.forEach((s, i) => s.step(inp[i]));
    this.wire.step(txd, txen);
    this.feed();
    this.t++;
  }
}

// ---- timing arithmetic for the chapter ---------------------------------------------------------------------------------

/** Bit times a frame of `bytes` (destination to FCS) occupies on the wire, preamble and SFD included. */
export const frameBitTimes = (bytes: number): number => 8 * (PREAMBLE_BYTES + bytes);
/** Bit times a frame and the gap after it take: the most frames a second a link can carry. */
export const frameSlotBitTimes = (bytes: number): number => frameBitTimes(bytes) + GAP_BITS;
/** Frames a second at a bit rate (Mb/s) for frames of `bytes`. */
export const framesPerSecond = (mbps: number, bytes: number): number => (mbps * 1e6) / frameSlotBitTimes(bytes);
/** Useful payload bits over all bits in the slot (preamble, header, FCS and gap are overhead). */
export const payloadEfficiency = (payload: number): number => (8 * payload) / frameSlotBitTimes(Math.max(MIN_FRAME, payload + 18));

/** A signal at speed `v` (fraction of c) crosses `metres` in this many bit times at `mbps`. */
export const propagationBitTimes = (metres: number, v: number, mbps: number): number => (metres / (v * 299792458)) * mbps * 1e6;
/**
 * The longest one-way distance a collision can still be detected over for frames of `bits` (bit times) at `mbps`: the sender
 * must still be sending when the news of a collision at the far end comes back, which takes the round trip 2d/v.
 */
export const maxCableMetres = (bits: number, v: number, mbps: number): number => ((bits / (mbps * 1e6)) * v * 299792458) / 2;

/**
 * A pcap record for a frame the receive buffer kept: bytes from the destination to the pad (no FCS, as captures have it),
 * stamped with the time its first byte reached the receiver: the commit comes at the last bit, so back up by the frame's
 * wire time (preamble, SFD, bytes, FCS) at 32 clocks a byte.
 */
export function captureRecord(commitClock: number, bytes: number[]): { us: number; bytes: number[] } {
  const wireClocks = (PREAMBLE_BYTES + bytes.length + FCS_BYTES) * BYTE_CLOCKS;
  return { us: clocksToUs(Math.max(0, commitClock - wireClocks)), bytes };
}

export { FCS_BYTES };
