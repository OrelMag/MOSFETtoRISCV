// Chapter "PCIe and USB" (USB half), DOM-free: USB 2.0 full speed at the level of bits and packets, and the golden models the
// gate-level device (lib/usb.ts) is compared with after every clock (tests/comm-usb*.test.ts).
//
// Link speed (roadmap Phase 21, decision 7): the gates run a bit every 4 clocks (BIT_CLOCKS), a real full-speed SIE oversamples
// 4x as well and resynchronises on every transition. At the single-cycle CPU's clock that is the 63 Mb/s of the Ethernet MAC
// (CLOCK_NS), not full speed's 12 Mb/s: say so in the prose.
//
// Named simplifications (the chapter says these out loud):
//  - one device, one control endpoint (EP0, max packet 8) and a second endpoint (EP1, interrupt IN) that always NAKs;
//  - no SOF generation or frame timer: a SOF token is checked and ignored; no suspend, no resume, no low speed, no high-speed chirp;
//  - the bus is two logic levels per wire (dp, dm): no analog levels, no pull-up detection (attach), no hubs, no split transactions;
//  - the receiver is held off while the device transmits (a real transceiver hears its own driver);
//  - bus reset is SE0 held RESET_CLOCKS (128 clocks = 32 bit times) where real hardware needs 2.5 us (30 bit times) and the host
//    holds it 10 ms; nothing in the device times a 10 ms reset;
//  - requests: GET_DESCRIPTOR (device, configuration), SET_ADDRESS, SET_CONFIGURATION, GET_STATUS(device); everything else STALLs
//    (string descriptors, other recipients, wIndex is not checked);
//  - the OUT data stage is not implemented (no request here has one); a status-stage OUT is accepted whatever its data toggle;
//  - SET_ADDRESS takes effect when the host's ACK of the status-stage zero-length packet arrives (USB 2.0 9.4.6: after the
//    status stage completes). If that ACK is lost the device stays at the old address and the host believes it is done:
//    the next transaction gets no answer and the host gives up (tests/comm-usb-enum.test.ts names this case);
//  - the vendor id is 0x1209 and the product id 0x0001, pid.codes' test id (pid.codes/1209/0001), meant for just this.

import { stepBit } from './crc';

export const BIT_CLOCKS = 4;
/** SE0 held this long is a bus reset (a real device needs 2.5 us = 30 bit times; EOP is 2 bit times). */
export const RESET_CLOCKS = 128;
/** How long our host holds SE0 for a reset (real hosts: 10 ms). */
export const RESET_HOLD = 192;
/** Both ends' clock: the single-cycle CPU's, as the Ethernet MAC (comm/mac.ts). */
export { CLOCK_NS } from '../dram/timing';

export const PID = { OUT: 0x1, IN: 0x9, SOF: 0x5, SETUP: 0xd, DATA0: 0x3, DATA1: 0xb, ACK: 0x2, NAK: 0xa, STALL: 0xe } as const;
export const PID_NAME: Record<number, string> = { 1: 'OUT', 9: 'IN', 5: 'SOF', 13: 'SETUP', 3: 'DATA0', 11: 'DATA1', 2: 'ACK', 10: 'NAK', 14: 'STALL' };
/** The PID byte on the wire: the PID in the low nibble, its complement in the high one. */
export const pidByte = (pid: number): number => ((~pid & 15) << 4) | (pid & 15);
export const pidOk = (b: number): boolean => ((b >> 4) & 15) === (~b & 15);

// ---- CRCs ----------------------------------------------------------------------------------------------------------------------

/** The reflected registers of the gates (lib/crc.ts crcUnit): init all ones, one bit a step, LSB first; check bits = ~register. */
export const CRC5_POLY = 0x14, CRC16_POLY = 0xa001;
export const crc5Step = (q: number, d: number): number => stepBit(q, d, CRC5_POLY, 5);
export const crc16Step = (q: number, d: number): number => stepBit(q, d, CRC16_POLY, 16);
export function crcRun(q: number, bits: ArrayLike<number>, step: (q: number, d: number) => number): number {
  for (let i = 0; i < bits.length; i++) q = step(q, bits[i]);
  return q;
}
/** The bits of a value, least significant first. */
export const lsbBits = (v: number, n: number): number[] => Array.from({ length: n }, (_, i) => (v >> i) & 1);
export const bytesBits = (bytes: ArrayLike<number>): number[] => Array.from(bytes).flatMap((b) => lsbBits(b, 8));

/** The check field of a token: 5 bits over the 11 bits address + endpoint (or frame number), as it sits in bits 11..15 of the field. */
export function crc5Of(v11: number): number { return ~crcRun(0x1f, lsbBits(v11, 11), crc5Step) & 0x1f; }
export const crc5Token = (addr: number, ep: number): number => crc5Of((addr & 0x7f) | ((ep & 15) << 7));
export const crc5Sof = (frame: number): number => crc5Of(frame & 0x7ff);
/** CRC-16/USB of bytes (init FFFF, reflected 8005, xorout FFFF); on the wire low byte first. */
export const crc16 = (bytes: ArrayLike<number>): number => ~crcRun(0xffff, bytesBits(bytes), crc16Step) & 0xffff;

/** What the registers hold after a packet that carries its own check bits (CRC32_RESIDUE's cousins), found by running one. */
export const CRC5_RESIDUE = crcRun(0x1f, [...lsbBits(0, 11), ...lsbBits(crc5Token(0, 0), 5)], crc5Step);
export const CRC16_RESIDUE = (() => { const d = [1, 2, 3]; const c = crc16(d); return crcRun(0xffff, bytesBits([...d, c & 255, c >> 8]), crc16Step); })();

// ---- packets -------------------------------------------------------------------------------------------------------------------

/** Wire bytes (PID byte first, no SYNC, no EOP) of a token: PID, address + endpoint + CRC5 in 16 bits, low byte first. */
export function tokenBytes(pid: number, addr: number, ep: number): number[] {
  const w = (addr & 0x7f) | ((ep & 15) << 7) | (crc5Token(addr, ep) << 11);
  return [pidByte(pid), w & 255, w >> 8];
}
export function sofBytes(frame: number): number[] {
  const w = (frame & 0x7ff) | (crc5Sof(frame) << 11);
  return [pidByte(PID.SOF), w & 255, w >> 8];
}
export function dataBytes(pid: number, payload: ArrayLike<number>): number[] {
  const c = crc16(payload);
  return [pidByte(pid), ...Array.from(payload), c & 255, c >> 8];
}
export const handshakeBytes = (pid: number): number[] => [pidByte(pid)];

export interface Parsed {
  /** The PID's low nibble, and whether its complement was right. */
  pid: number; pidOk: boolean;
  kind: 'token' | 'sof' | 'data' | 'handshake' | 'other';
  addr?: number; ep?: number; frame?: number; crc5Ok?: boolean;
  data?: number[]; crc16Ok?: boolean;
}
/** Reads wire bytes back as a packet (checks the PID and whichever CRC applies): written from the spec's fields, not from the models. */
export function parsePacket(b: ArrayLike<number>): Parsed {
  const pid = b[0] & 15, ok = pidOk(b[0]);
  const cls = pid & 3;
  if (cls === 1) {
    if (b.length !== 3) return { pid, pidOk: ok, kind: 'other' };
    const w = b[1] | (b[2] << 8), v = w & 0x7ff, c = w >> 11;
    return pid === PID.SOF
      ? { pid, pidOk: ok, kind: 'sof', frame: v, crc5Ok: c === crc5Sof(v) }
      : { pid, pidOk: ok, kind: 'token', addr: v & 0x7f, ep: v >> 7, crc5Ok: c === crc5Of(v) };
  }
  if (cls === 3) {
    if (b.length < 3) return { pid, pidOk: ok, kind: 'other' };
    const payload = Array.from(b).slice(1, b.length - 2), c = b[b.length - 2] | (b[b.length - 1] << 8);
    return { pid, pidOk: ok, kind: 'data', data: payload, crc16Ok: c === crc16(payload) };
  }
  if (cls === 2 && b.length === 1) return { pid, pidOk: ok, kind: 'handshake' };
  return { pid, pidOk: ok, kind: 'other' };
}

// ---- bits on the wire -----------------------------------------------------------------------------------------------------------

/** SYNC then the bytes, least significant bit first, a 0 stuffed after every six 1s (SYNC's closing 1 counts; a trailing run of six is followed by a 0 too). */
export function stuffedBits(wire: ArrayLike<number>): number[] {
  const raw = [...bytesBits([0x80]), ...bytesBits(wire)], out: number[] = [];
  let ones = 0;
  for (const b of raw) {
    out.push(b);
    ones = b ? ones + 1 : 0;
    if (ones === 6) { out.push(0); ones = 0; }
  }
  return out;
}
/** J = 'J', K = 'K', SE0 = '_'. NRZI from an idle J: a 0 changes the level, a 1 keeps it. */
export function nrziSymbols(bits: ArrayLike<number>, init: 'J' | 'K' = 'J'): string {
  let lv = init, s = '';
  for (let i = 0; i < bits.length; i++) { if (!bits[i]) lv = lv === 'J' ? 'K' : 'J'; s += lv; }
  return s;
}
/** The packet as symbols with its end: SE0 SE0 J. */
export const packetSymbols = (wire: ArrayLike<number>): string => `${nrziSymbols(stuffedBits(wire))}__J`;
export const SYM_LEVELS: Record<string, [number, number]> = { J: [1, 0], K: [0, 1], _: [0, 0] };
/** Symbols to clock samples (dp, dm); `widths` gives a symbol's length in clocks (default BIT_CLOCKS), to model a host whose clock is a little off. */
export function symbolClocks(syms: string, widths?: ArrayLike<number>): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < syms.length; i++) for (let c = 0, n = widths?.[i] ?? BIT_CLOCKS; c < n; c++) out.push(SYM_LEVELS[syms[i]]);
  return out;
}

// ---- an independent decoder ---------------------------------------------------------------------------------------------------

export interface Seen { /** Clock of the first K (the start of SYNC). */ start: number; /** Clock at which the SE0 began. */ end: number; wire: number[]; stuffError: boolean; syncOk: boolean; byteAligned: boolean }

/**
 * Reads the line back into packets from the length of each run of one level: a run of L clocks is round(L / 4) bits, the first
 * of them a transition (0), the rest 1s. Written from the spec and sharing nothing with the device's sampler (which counts
 * clocks from an edge), so a bug common to the device and the host models cannot hide here. The line must be J when it starts.
 */
export class UsbMonitor {
  private lv = 'J'; private run = 0; private bits: number[] = []; private t = 0; private start = -1; open = false;
  /** Every packet seen so far. */
  seen: Seen[] = [];
  /** Feed one clock of the line; returns the packet that this clock completed (SE0 seen), if any. */
  push(dp: number, dm: number): Seen | null {
    const lv = dp && !dm ? 'J' : !dp && dm ? 'K' : !dp && !dm ? '_' : 'X';
    const t = this.t++;
    let done: Seen | null = null;
    if (lv === this.lv) { this.run++; return null; }
    // a run of the old level has ended
    if (this.open && this.lv !== '_') {
      const n = Math.max(1, Math.round(this.run / BIT_CLOCKS));
      this.bits.push(0);
      for (let i = 1; i < n; i++) this.bits.push(1);
    }
    if (!this.open && this.lv === 'J' && lv === 'K') { this.open = true; this.start = t; this.bits = []; }
    else if (this.open && lv === '_') {
      done = this.finish(t);
      this.open = false;
    }
    this.lv = lv; this.run = 1;
    return done;
  }
  private finish(end: number): Seen {
    // undo stuffing: after six 1s the next bit is a stuffed 0 (a 1 there is an error)
    const out: number[] = [];
    let ones = 0, bad = false;
    for (const b of this.bits) {
      if (ones === 6) { if (b) bad = true; ones = 0; continue; }
      out.push(b);
      ones = b ? ones + 1 : 0;
    }
    const sync = out.slice(0, 8).join('') === '00000001';
    const body = out.slice(8), wire: number[] = [];
    for (let i = 0; i + 8 <= body.length; i += 8) wire.push(body.slice(i, i + 8).reduce((v, b, j) => v | (b << j), 0));
    const p = { start: this.start, end, wire, stuffError: bad, syncOk: sync, byteAligned: body.length % 8 === 0 };
    this.seen.push(p);
    return p;
  }
}

// ---- the device's descriptors ----------------------------------------------------------------------------------------------------

/** 18 bytes. Vendor 0x1209 and product 0x0001 are pid.codes' test id (it is for exactly this: hardware that has no id of its own). */
export const DEVICE_DESCRIPTOR = [18, 1, 0x00, 0x02, 0, 0, 0, 8, 0x09, 0x12, 0x01, 0x00, 0x00, 0x01, 0, 0, 0, 1];
/** 25 bytes: configuration (9) + interface (9, vendor class, one endpoint) + endpoint 1 IN, interrupt, 8 bytes, every 10 ms. */
export const CONFIG_DESCRIPTOR = [
  9, 2, 25, 0, 1, 1, 0, 0x80, 50,
  9, 4, 0, 0, 1, 0xff, 0, 0, 0,
  7, 5, 0x81, 3, 8, 0, 10,
];
/** The ROM: the device descriptor at 0, the configuration at 32 (64 bytes, address {configuration, packet, byte}). */
export const USB_ROM: number[] = (() => {
  const r = new Array<number>(64).fill(0);
  DEVICE_DESCRIPTOR.forEach((b, i) => { r[i] = b; });
  CONFIG_DESCRIPTOR.forEach((b, i) => { r[32 + i] = b; });
  return r;
})();
export const MAX_PACKET = 8;
export const REQ = { GET_STATUS: 0, SET_ADDRESS: 5, GET_DESCRIPTOR: 6, SET_CONFIGURATION: 9 } as const;
/** The 8 bytes of a standard device request. */
export const setupData = (type: number, req: number, value: number, index: number, length: number): number[] =>
  [type, req, value & 255, value >> 8, index & 255, index >> 8, length & 255, length >> 8];
export const DEV_STATE = ['Attached', 'Default', 'Address', 'Configured'] as const;

// ---- the device ------------------------------------------------------------------------------------------------------------------

export interface DevIn { rst: number; dp: number; dm: number; /** The endpoint's buffer is not ready: IN and OUT get NAK. */ nak: number }

const eqv = (a: number, b: number): number => (a === b ? 1 : 0);
/** v >= c, as the gates compute it. */
const ge = (v: number, c: number): number => (v >= c ? 1 : 0);

/**
 * The USB device, clock by clock: every register is written as the gates do (lib/usb.ts), all updated together from their old
 * values, outputs straight from registers. Receiver: the line sampled into flip-flops, a phase counter that restarts on every
 * transition (4 clocks a bit, sampled on the third), NRZI, destuffing, SYNC, PID check, bytes, CRC5 / CRC16, EOP; control endpoint:
 * the request decoded as its bytes go by, the answer chosen at EOP; transmitter: a short wait, SYNC, PID, data from the ROM,
 * CRC16, stuffing, NRZI, EOP. The comments name the USB 2.0 rule each part follows.
 */
export class UsbDevice {
  // receiver
  sdp = 1; sdm = 0; pdp = 1; pdm = 0; ph = 0; lb = 1; ones = 0; sh = 0; bc = 0; rpid = 0; rbody = 0; nb = 0; rerr = 0; pidr = 0; se0c = 0;
  tkv = 0; tk = 0; tp1 = 0; am = 0; e0 = 0; ez = 0; c5 = 0x1f; c16 = 0xffff;
  // control
  st = 0; addr = 0; armed = 0; stall = 0; rin = 0; rout = 0; gd = 0; gs = 0; sa = 0; sc = 0; pend = 0; tdev = 0; tcfg = 0; rem = 0; pktidx = 0;
  tog = 0; wack = 0; paa = 0; pac = 0; tkd = 0; tkn = 0; tks = 0;
  // transmitter
  twait = 0; tsync = 0; tpidp = 0; tdata = 0; tcrc = 0; teop = 0; tph = 0; tbc = 0; tn = 0; tones = 0; tlv = 1; tsh = 0; oe = 0; odp = 1; odm = 0;

  get busrst(): number { return (this.se0c >> 7) & 1; }
  get txIdle(): number { return this.twait | this.tsync | this.tpidp | this.tdata | this.tcrc | this.teop ? 0 : 1; }
  get rxact(): number { return this.rpid | this.rbody; }
  /** The ROM byte the transmitter would load: address {configuration, packet in the transfer, byte in the packet}; GET_STATUS reads zeros. */
  romByte(b3: number): number { return this.gs ? 0 : USB_ROM[(this.tcfg << 5) | (this.pktidx << 3) | b3]; }

  step(i: DevIn): void {
    const rst = i.rst;
    const busrst = this.busrst, cl = rst | busrst, ncl = 1 - cl;
    const sdp = this.sdp, sdm = this.sdm;
    // ---- receiver front end
    const se0 = (1 - sdp) & (1 - sdm);
    const edge = (sdp ^ this.pdp) | (sdm ^ this.pdm);
    const smp = this.ph === 2 && !edge ? 1 : 0;
    const sm = smp & (1 - this.oe); // the receiver does not listen to its own driver
    const idle = (1 - this.rpid) & (1 - this.rbody);
    const dsm = sm & (1 - se0);
    const dbit = 1 - (sdp ^ this.lb);
    const stuffnow = eqv(this.ones, 6);
    const dd = dsm & (1 - stuffnow);
    const stuffbad = dsm & stuffnow & dbit;
    const nsh = (this.sh >> 1) | (dbit << 7);
    const bcend = eqv(this.bc, 7);
    const sync = idle & dd & eqv(nsh, 0x80);
    const pidend = this.rpid & dd & bcend;
    const pidokv = eqv((nsh >> 4) & 15, ~nsh & 15);
    const byteend = this.rbody & dd & bcend;
    const eop = (this.rpid | this.rbody) & sm & se0;
    // ---- packet level: what the end of a body means
    const bodyEnd = this.rbody & sm & se0;
    const okb = bodyEnd & (1 - this.rerr) & eqv(this.bc, 0);
    const pid0 = this.pidr & 1, pid1 = (this.pidr >> 1) & 1, pk = (this.pidr >> 2) & 3;
    const istok = pid0 & (1 - pid1), isdat = pid0 & pid1, ishs = (1 - pid0) & pid1;
    const z = eqv(this.nb, 2);
    const tokok = okb & istok & z & eqv(this.c5, CRC5_RESIDUE);
    const tme = this.am & this.ez & ge(this.st, 1);
    const isof = eqv(pk, 1);
    const tokme = tokok & tme & (1 - isof);
    const datok = okb & isdat & eqv(this.c16, CRC16_RESIDUE) & this.tkv;
    const tkSetup = eqv(this.tk, 3), tkOut = eqv(this.tk, 0);
    const setupdat = datok & tkSetup & (1 - this.tp1) & eqv(this.nb, 10);
    const outdat = datok & tkOut & (1 - this.tp1) & this.armed;
    const inme = tokme & eqv(pk, 2);
    const in0 = inme & (1 - this.e0), in1 = inme & this.e0;
    const settok = tokme & eqv(pk, 3);
    const rData = in0 & this.armed & (1 - this.stall) & (1 - i.nak);
    const rNak = (in0 & this.armed & (1 - this.stall) & i.nak) | (in1 & eqv(this.st, 3)) | (outdat & z & (1 - this.stall) & i.nak);
    const rStall = (in0 & this.armed & this.stall) | (outdat & ((1 - z) | this.stall));
    const rAck = setupdat | (outdat & z & (1 - this.stall) & (1 - i.nak));
    const rAny = rData | rNak | rStall | rAck;
    const ackpkt = okb & ishs & eqv(pk, 0) & eqv(this.nb, 0);
    const commit = ackpkt & this.wack;
    // ---- the request, as its bytes go by (only in the data of a SETUP)
    const cap = this.rbody & this.tkv & tkSetup & (1 - this.tp1) & isdat;
    const capb = cap & byteend;
    // a request is valid when its pieces say so
    const vgd = this.rin & this.gd & (this.tdev | this.tcfg) & eqv(this.pend, 0);
    const vgs = this.rin & this.gs;
    const vsa = this.rout & this.sa & (1 - eqv(this.st, 3)) & (1 - ((this.pend >> 7) & 1));
    const vsc = this.rout & this.sc & ge(this.st, 2) & eqv(this.pend >> 1, 0);
    const reqok = vgd | vgs | vsa | vsc;
    const klen = vgd ? (this.tdev ? 18 : 25) : vgs ? 2 : 0;
    const minRem = klen === 0 ? 0 : this.rem >= klen ? klen : this.rem;
    // ---- receiver registers
    const n = { ...this } as UsbDevice;
    n.sdp = rst ? 1 : i.dp; n.sdm = rst ? 0 : i.dm;
    n.pdp = rst ? 1 : sdp; n.pdm = rst ? 0 : sdm;
    n.ph = edge ? 1 : (this.ph + 1) & 3;
    n.lb = rst ? 1 : smp ? (sdp | (1 - sdm)) : this.lb;
    n.rpid = ncl & (sync | (this.rpid & (1 - pidend) & (1 - eop)));
    n.rbody = ncl & (pidend | (this.rbody & (1 - eop)));
    n.ones = idle ? (sync ? 1 : 0) : dsm ? (stuffnow ? 0 : dbit ? this.ones + 1 : 0) : this.ones;
    n.bc = idle ? 0 : dd ? (this.bc + 1) & 7 : this.bc;
    // cleared at an SE0 sample: the last byte of a CRC (zeros) and the first J after EOP would make a SYNC (found by the enumeration, not by a unit test)
    n.sh = this.oe || (sm && se0) ? 0xff : dd ? nsh : this.sh;
    n.nb = !this.rbody ? 0 : byteend ? (this.nb === 15 ? 15 : this.nb + 1) : this.nb;
    n.rerr = idle ? 0 : this.rerr | stuffbad | (pidend & (1 - pidokv));
    n.pidr = pidend ? nsh & 15 : this.pidr;
    n.se0c = !se0 ? 0 : (this.se0c >> 7) & 1 ? this.se0c : this.se0c + 1;
    // check registers: crc5 over the stream of every packet, crc16 shared with the transmitter
    const en5 = this.rbody & dd;
    n.c5 = this.rpid | rst ? 0x1f : en5 ? crc5Step(this.c5, dbit) : this.c5;
    const txsel = this.tdata | this.tcrc;
    const d16 = txsel ? (this.tcrc ? this.c16 & 1 : this.tsh & 1) : dbit;
    const en16 = txsel ? this.txAdv() : this.rbody & dd;
    n.c16 = this.rpid | this.tpidp | rst ? 0xffff : en16 ? crc16Step(this.c16, d16) : this.c16;
    // token fields
    n.am = byteend && this.nb === 0 ? eqv(nsh & 0x7f, this.addr) : this.am;
    n.e0 = byteend && this.nb === 0 ? (nsh >> 7) & 1 : this.e0;
    n.ez = byteend && this.nb === 1 ? eqv(nsh & 7, 0) : this.ez;
    n.tkv = ncl & (bodyEnd ? tokme : this.tkv);
    n.tk = tokme ? pk : this.tk;
    n.tp1 = tokme ? this.e0 : this.tp1;
    // ---- control registers
    n.armed = ncl & (settok ? 0 : setupdat ? 1 : this.armed);
    n.stall = ncl & (settok ? 0 : setupdat ? 1 - reqok : this.stall);
    n.paa = ncl & (settok ? 0 : setupdat ? vsa : commit & this.paa ? 0 : this.paa);
    n.pac = ncl & (settok ? 0 : setupdat ? vsc : commit & this.pac ? 0 : this.pac);
    n.rin = capb && this.nb === 0 ? eqv(nsh, 0x80) : this.rin;
    n.rout = capb && this.nb === 0 ? eqv(nsh, 0x00) : this.rout;
    n.gd = capb && this.nb === 1 ? eqv(nsh, REQ.GET_DESCRIPTOR) : this.gd;
    n.gs = capb && this.nb === 1 ? eqv(nsh, REQ.GET_STATUS) : this.gs;
    n.sa = capb && this.nb === 1 ? eqv(nsh, REQ.SET_ADDRESS) : this.sa;
    n.sc = capb && this.nb === 1 ? eqv(nsh, REQ.SET_CONFIGURATION) : this.sc;
    n.pend = capb && this.nb === 2 ? nsh : this.pend;
    n.tdev = capb && this.nb === 3 ? eqv(nsh, 1) : this.tdev;
    n.tcfg = capb && this.nb === 3 ? eqv(nsh, 2) : this.tcfg;
    n.rem = capb && this.nb === 6 ? nsh : capb && this.nb === 7 ? (nsh !== 0 ? 255 : this.rem) : setupdat ? minRem : commit ? (this.rem >= 8 ? (((this.rem >> 3) - 1) << 3) | (this.rem & 7) : 0) : this.rem;
    n.tog = setupdat ? 1 : commit ? 1 - this.tog : this.tog;
    n.pktidx = setupdat ? 0 : commit ? (this.pktidx + 1) & 3 : this.pktidx;
    n.wack = ncl & (rData ? 1 : bodyEnd ? 0 : this.wack);
    // SET_ADDRESS / SET_CONFIGURATION take effect when the host's ACK of the status stage arrives (USB 2.0 9.4.6)
    n.addr = rst | busrst ? 0 : commit & this.paa ? this.pend & 0x7f : this.addr;
    const stNext = commit & this.paa ? ((this.pend & 0x7f) === 0 ? 1 : 2) : commit & this.pac ? (this.pend & 1 ? 3 : 2) : this.st;
    n.st = rst ? 0 : busrst ? 1 : stNext;
    n.tkd = rAny ? rData : this.tkd; n.tkn = rAny ? rNak : this.tkn; n.tks = rAny ? rStall : this.tks;
    // ---- transmitter
    const idleT = this.txIdle;
    const tbound = (1 - idleT) & eqv(this.tph, 3);
    const sending = this.tsync | this.tpidp | this.tdata | this.tcrc;
    const stuff = sending & eqv(this.tones, 6);
    const src = this.tcrc ? 1 - (this.c16 & 1) : this.tsh & 1;
    const v = stuff ? 0 : src;
    const tstep = tbound & sending;
    const adv = tstep & (1 - stuff);
    const bend = adv & eqv(this.tbc, 7);
    const tnext = this.tdata ? (this.tn + 1) & 7 : 0;
    const ge8 = ge(this.rem, 8), nz = ge(this.rem, 1);
    const lastbyte = ge8 ? eqv(this.tn & 7, 7) : eqv(tnext, this.rem & 7);
    const wend = tbound & this.twait & eqv(this.tn, 3);
    const lastcrc = this.tcrc & bend & eqv(this.tn, 1);
    const needstuff = v & eqv(this.tones, 5);
    const crcgo = lastcrc & (1 - needstuff);
    const tail = this.tcrc & tbound & eqv(this.tn, 2);
    const pidgo = this.tpidp & bend;
    const datastart = pidgo & this.tkd & nz;
    const dataend = this.tdata & bend & lastbyte;
    const eopb = this.teop & tbound;
    const eopend = eopb & eqv(this.tn, 3);
    n.twait = ncl & (rAny | (this.twait & (1 - wend)));
    n.tsync = ncl & (wend | (this.tsync & (1 - bend)));
    n.tpidp = ncl & ((this.tsync & bend) | (this.tpidp & (1 - bend)));
    n.tdata = ncl & (datastart | (this.tdata & (1 - dataend)));
    n.tcrc = ncl & ((pidgo & this.tkd & (1 - nz)) | dataend | (this.tcrc & (1 - crcgo) & (1 - tail)));
    n.teop = ncl & ((pidgo & (1 - this.tkd)) | crcgo | tail | (this.teop & (1 - eopend)));
    n.tph = idleT ? 0 : (this.tph + 1) & 3;
    n.tbc = !sending ? 0 : adv ? (this.tbc + 1) & 7 : this.tbc;
    n.tones = tstep ? (v ? this.tones + 1 : 0) : sending ? this.tones : 0;
    const pidlo = this.tkd | 2 | (this.tks << 2) | ((this.tkd ? this.tog : this.tkn | this.tks) << 3);
    const pidbyte = ((~pidlo & 15) << 4) | pidlo;
    const load = this.tsync ? pidbyte : this.romByte(tnext);
    n.tsh = this.twait ? 0x80 : bend ? load : adv ? this.tsh >> 1 : this.tsh;
    const tclr = wend | dataend | crcgo | tail | eopend;
    const tinc = (this.twait & tbound) | (this.tdata & bend) | (this.tcrc & bend) | eopb;
    n.tn = this.twait | this.tdata | this.tcrc | this.teop ? (lastcrc & needstuff ? 2 : tclr ? 0 : tinc ? this.tn + 1 : this.tn) : 0;
    const nr = v ? this.tlv : 1 - this.tlv;
    n.tlv = rst ? 1 : tstep ? nr : eopb && this.tn === 2 ? 1 : this.tlv;
    n.oe = ncl & (tstep ? 1 : eopb ? (this.tn === 3 ? 0 : 1) : this.oe);
    n.odp = rst ? 1 : tstep ? n.tlv : eopb ? (this.tn <= 1 ? 0 : 1) : this.odp;
    n.odm = rst ? 0 : tstep ? 1 - n.tlv : eopb ? 0 : this.odm;
    Object.assign(this, n);
  }

  /** The transmitter steps a data or CRC bit that enters the check register this clock (the shared unit's enable). */
  private txAdv(): number {
    const tbound = (1 - this.txIdle) & eqv(this.tph, 3);
    const sending = this.tsync | this.tpidp | this.tdata | this.tcrc;
    return tbound & sending & (1 - eqv(this.tones, 6));
  }
}

// ---- the bus and the host --------------------------------------------------------------------------------------------------------

export interface HostOut { oe: number; dp: number; dm: number }
export interface Bus { dp: number; dm: number }
/** What the bench needs of a device: the model, or the gates behind an adapter. Outputs come from flip-flops. */
export interface DeviceIO { oe: number; odp: number; odm: number; step(i: DevIn): void }

/** The line: whoever drives sets it, nobody driving is J (the pull-up on D+). Two drivers at once is a fault the bench counts. */
export function resolveBus(h: HostOut, d: { oe: number; odp: number; odm: number }): Bus & { clash: boolean } {
  if (h.oe) return { dp: h.dp, dm: h.dm, clash: !!d.oe };
  if (d.oe) return { dp: d.odp, dm: d.odm, clash: false };
  return { dp: 1, dm: 0, clash: false };
}

export interface LogEntry { clock: number; kind: 'reset' | 'setup' | 'in' | 'out' | 'error' | 'info' | 'done'; text: string }
const IDLE: HostOut = { oe: 0, dp: 1, dm: 0 };
const hexs = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(' ');

/** Symbol k spans [4k + j(k), 4(k+1) + j(k+1)): a clock a little off, jitter j in {0, 1} not accumulating, widths 3 to 5 clocks. */
export function jitterWidths(n: number, rnd: () => number): number[] {
  const j = Array.from({ length: n + 1 }, (_, k) => (k === 0 || k === n ? 0 : rnd() < 0.5 ? 0 : 1));
  return Array.from({ length: n }, (_, k) => BIT_CLOCKS + j[k + 1] - j[k]);
}

export interface HostOptions {
  /** Bit lengths vary by a clock (a host whose clock is not ours). */
  jitter?: () => number;
  /** Three errors in a row on one step and the host gives up (USB 2.0 8.4.5: a transaction is tried three times). */
  maxErrors?: number;
  /** The address SET_ADDRESS gives. */
  newAddr?: number;
  /** Clocks of idle before the first thing. */
  lead?: number;
  /** Corrupt the packet the host sends as its n-th (counting from 0): the fault sweeps. */
  corruptSend?: number;
}
export type Pump<T> = Generator<HostOut, T, Bus>;
interface Rx { seen: Seen; p: Parsed; good: boolean }

/**
 * The host: a script (a generator that yields what it drives for the next clock) that resets the bus and enumerates the device
 * as hosts do: GET_DESCRIPTOR(device, 8) at address 0, reset, SET_ADDRESS, GET_DESCRIPTOR(device, 18), GET_DESCRIPTOR(configuration, 9),
 * GET_DESCRIPTOR(configuration, 25), SET_CONFIGURATION(1). A step with no (good) answer is repeated, three failures end it; a NAK
 * is waited out and repeated; a DATA packet with the wrong toggle (our ACK was lost) is acknowledged and dropped.
 */
export class UsbHost {
  out: HostOut = IDLE;
  clock = 0;
  log: LogEntry[] = [];
  mon = new UsbMonitor();
  /** Transactions finished (a counter the scene steps by). */
  transactions = 0;
  done = false;
  failed: string | null = null;
  /** The next packet the host sends has a bit flipped (its CRC or PID check then fails). */
  corruptNext = false;
  corrupted = 0;
  /** Every packet the host sent: its PID and the enumeration step it belonged to. */
  sendLog: { pid: number; stage: string }[] = [];
  stage = '';
  /** What enumeration read. */
  dev8: number[] = []; dev18: number[] = []; cfg9: number[] = []; cfg25: number[] = [];
  addr = 0; configured = false;
  errors = 0; naks = 0;
  private gen: Pump<void>;
  constructor(public opt: HostOptions = {}, script?: (h: UsbHost) => Pump<void>) {
    this.gen = script ? script(this) : this.enumerate();
    this.out = this.gen.next().value as HostOut;
  }
  /** Feed the line as it was during the clock just finished; the host's output for the next clock follows. */
  step(bus: Bus): void {
    this.clock++;
    this.mon.push(bus.dp, bus.dm);
    if (this.done) { this.out = IDLE; return; }
    const r = this.gen.next(bus);
    if (r.done) { this.done = true; this.out = IDLE; } else this.out = r.value;
  }
  private say(kind: LogEntry['kind'], text: string): void { this.log.push({ clock: this.clock, kind, text }); }

  // ---- the line
  *quiet(n: number): Pump<void> { for (let i = 0; i < n; i++) yield IDLE; }
  *play(c: readonly [number, number][]): Pump<void> { for (const [dp, dm] of c) yield { oe: 1, dp, dm }; }
  /** A packet from its wire bytes; a pending corruption flips the low bit of the second byte (a handshake: of the PID byte). */
  *send(wire: number[]): Pump<void> {
    let w = wire;
    if (this.sendLog.length === this.opt.corruptSend) this.corruptNext = true;
    this.sendLog.push({ pid: wire[0] & 15, stage: this.stage });
    if (this.corruptNext) { w = [...wire]; w[w.length > 1 ? 1 : 0] ^= 1; this.corruptNext = false; this.corrupted++; }
    const syms = packetSymbols(w);
    yield* this.play(symbolClocks(syms, this.opt.jitter ? jitterWidths(syms.length, this.opt.jitter) : undefined));
  }
  /** Wait for a packet from the device: it must start within 80 clocks (18 bit times is the limit, USB 2.0 7.1.19.1), and it ends at its SE0. */
  *recv(): Pump<Rx | null> {
    const mark = this.mon.seen.length;
    for (let waited = 0; ; waited++) {
      if (this.mon.seen.length > mark) break;
      if (!this.mon.open && waited > 80) return null;
      if (waited > 2000) return null;
      yield IDLE;
    }
    const seen = this.mon.seen[mark], p = parsePacket(seen.wire);
    // the device's EOP is two bit times of SE0 and a J: let it finish before the host answers
    yield* this.quiet(14);
    const good = !seen.stuffError && seen.syncOk && seen.byteAligned && p.pidOk && (p.kind !== 'data' || !!p.crc16Ok);
    return { seen, p, good };
  }
  *gap(n = 12): Pump<void> { yield* this.quiet(n); }

  // ---- transactions
  private fail(text: string): void { this.failed = text; this.say('error', `gave up: ${text}`); }
  private strike(what: string, errs: { n: number }): boolean {
    errs.n++; this.errors++;
    this.say('error', `${what}: nothing usable came back, try ${errs.n + 1}`);
    if (errs.n >= (this.opt.maxErrors ?? 3)) { this.fail(`${what} failed ${errs.n} times`); return false; }
    return true;
  }
  /** SETUP token + DATA0, wanting an ACK. */
  *setupStage(addr: number, data: number[]): Pump<boolean> {
    const errs = { n: 0 };
    for (;;) {
      yield* this.send(tokenBytes(PID.SETUP, addr, 0));
      yield* this.gap();
      yield* this.send(dataBytes(PID.DATA0, data));
      const r = yield* this.recv();
      const head = `SETUP addr ${addr} ep 0 → DATA0 ${hexs(data)}`;
      if (r?.good && r.p.kind === 'handshake' && r.p.pid === PID.ACK) { this.say('setup', `${head} → ACK`); this.transactions++; yield* this.gap(); return true; }
      this.say('error', `${head} → ${r ? (r.good ? PID_NAME[r.p.pid] ?? '?' : 'garbled') : '(no answer)'}`);
      if (!this.strike('SETUP', errs)) return false;
      yield* this.gap(40);
    }
  }
  /** IN token, wanting DATA with the toggle `pid`; returns the payload ('stall' on STALL). */
  *inStage(addr: number, ep: number, pid: number): Pump<number[] | 'stall' | null> {
    const errs = { n: 0 };
    for (let naks = 0; ; ) {
      yield* this.send(tokenBytes(PID.IN, addr, ep));
      const r = yield* this.recv();
      const head = `IN addr ${addr} ep ${ep}`;
      if (r?.good && r.p.kind === 'handshake' && r.p.pid === PID.NAK) {
        this.naks++; this.say('in', `${head} → NAK`); this.transactions++;
        if (++naks > 40) { this.fail('the device kept answering NAK'); return null; }
        yield* this.gap(40); continue;
      }
      if (r?.good && r.p.kind === 'handshake' && r.p.pid === PID.STALL) { this.say('in', `${head} → STALL`); this.transactions++; yield* this.gap(); return 'stall'; }
      if (r?.good && r.p.kind === 'data') {
        const shown = r.p.data!.length ? hexs(r.p.data!) : '(empty)';
        yield* this.gap();
        yield* this.send(handshakeBytes(PID.ACK));
        if (r.p.pid === pid) { this.say('in', `${head} → DATA${pid === PID.DATA1 ? 1 : 0} ${shown} → ACK`); this.transactions++; yield* this.gap(); return r.p.data!; }
        // our ACK of the last packet was lost, so it came again: acknowledge it, throw the data away, ask for the next
        this.say('in', `${head} → DATA${r.p.pid === PID.DATA1 ? 1 : 0} ${shown} (a repeat: ACK, data dropped)`); this.transactions++;
        yield* this.gap(); continue;
      }
      this.say('error', `${head} → ${r ? (r.good ? PID_NAME[r.p.pid] ?? '?' : 'garbled') : '(no answer)'}`);
      if (!this.strike('IN', errs)) return null;
      yield* this.gap(40);
    }
  }
  /** OUT token + DATA, wanting an ACK. */
  *outStage(addr: number, pid: number, payload: number[]): Pump<'ack' | 'stall' | null> {
    const errs = { n: 0 };
    for (let naks = 0; ; ) {
      yield* this.send(tokenBytes(PID.OUT, addr, 0));
      yield* this.gap();
      yield* this.send(dataBytes(pid, payload));
      const r = yield* this.recv();
      const head = `OUT addr ${addr} ep 0 → DATA${pid === PID.DATA1 ? 1 : 0} ${payload.length ? hexs(payload) : '(empty)'}`;
      if (r?.good && r.p.kind === 'handshake') {
        if (r.p.pid === PID.ACK) { this.say('out', `${head} → ACK`); this.transactions++; yield* this.gap(); return 'ack'; }
        if (r.p.pid === PID.STALL) { this.say('out', `${head} → STALL`); this.transactions++; yield* this.gap(); return 'stall'; }
        if (r.p.pid === PID.NAK) {
          this.naks++; this.say('out', `${head} → NAK`); this.transactions++;
          if (++naks > 40) { this.fail('the device kept answering NAK'); return null; }
          yield* this.gap(40); continue;
        }
      }
      this.say('error', `${head} → ${r ? (r.good ? PID_NAME[r.p.pid] ?? '?' : 'garbled') : '(no answer)'}`);
      if (!this.strike('OUT', errs)) return null;
      yield* this.gap(40);
    }
  }
  /** A control transfer without a data stage (host to device): SETUP, then IN for a zero-length DATA1. */
  *controlNoData(addr: number, setup: number[]): Pump<boolean> {
    if (!(yield* this.setupStage(addr, setup))) return false;
    const st = yield* this.inStage(addr, 0, PID.DATA1);
    return Array.isArray(st) && st.length === 0;
  }
  /** A control read: SETUP, IN until a short packet or wLength bytes, then OUT with a zero-length DATA1. */
  *controlRead(addr: number, setup: number[]): Pump<number[] | 'stall' | null> {
    if (!(yield* this.setupStage(addr, setup))) return null;
    const want = setup[6] | (setup[7] << 8), got: number[] = [];
    let pid: number = PID.DATA1;
    while (got.length < want) {
      const d = yield* this.inStage(addr, 0, pid);
      if (d === 'stall') return 'stall';
      if (!d) return null;
      got.push(...d);
      pid = pid === PID.DATA1 ? PID.DATA0 : PID.DATA1;
      if (d.length < MAX_PACKET) break;
    }
    const st = yield* this.outStage(addr, PID.DATA1, []);
    return st === 'ack' ? got.slice(0, want) : null;
  }
  *busReset(): Pump<void> {
    this.say('reset', 'bus reset: SE0 held');
    yield* this.play(Array.from({ length: RESET_HOLD }, () => [0, 0] as [number, number]));
    yield* this.quiet(40);
    this.addr = 0;
    this.transactions++;
  }
  /** The enumeration a host performs (Windows and Linux differ in details; this is the textbook order). */
  *enumerate(): Pump<void> {
    yield* this.quiet(this.opt.lead ?? 40);
    this.stage = 'reset';
    yield* this.busReset();
    this.stage = 'device 8';
    const get = (type: number, len: number) => setupData(0x80, REQ.GET_DESCRIPTOR, type << 8, 0, len);
    const d8 = yield* this.controlRead(0, get(1, 8));
    if (!Array.isArray(d8)) { this.fail('GET_DESCRIPTOR(device, 8) at address 0'); return; }
    this.dev8 = d8;
    this.stage = 'reset again';
    yield* this.busReset();
    this.stage = 'set address';
    const a = this.opt.newAddr ?? 5;
    if (!(yield* this.controlNoData(0, setupData(0x00, REQ.SET_ADDRESS, a, 0, 0)))) { this.fail('SET_ADDRESS'); return; }
    this.addr = a;
    yield* this.quiet(40); // SET_ADDRESS recovery interval (USB 2.0 9.2.6.3: 2 ms)
    this.stage = 'device 18';
    const d18 = yield* this.controlRead(a, get(1, 18));
    if (!Array.isArray(d18)) { this.fail('GET_DESCRIPTOR(device, 18)'); return; }
    this.dev18 = d18;
    this.stage = 'configuration 9';
    const c9 = yield* this.controlRead(a, get(2, 9));
    if (!Array.isArray(c9)) { this.fail('GET_DESCRIPTOR(configuration, 9)'); return; }
    this.cfg9 = c9;
    this.stage = 'configuration 25';
    const total = c9[2] | (c9[3] << 8);
    const c25 = yield* this.controlRead(a, get(2, total));
    if (!Array.isArray(c25)) { this.fail('GET_DESCRIPTOR(configuration, total)'); return; }
    this.cfg25 = c25;
    this.stage = 'set configuration';
    if (!(yield* this.controlNoData(a, setupData(0x00, REQ.SET_CONFIGURATION, c9[5], 0, 0)))) { this.fail('SET_CONFIGURATION'); return; }
    this.configured = true;
    this.say('done', `configured: address ${a}, configuration ${c9[5]}`);
  }
}

// ---- the bench: host, bus and a device -------------------------------------------------------------------------------------------

export interface BenchOptions extends HostOptions {
  /** Clocks of reset at the start. */
  rstClocks?: number;
  /** nak(clock): the device's buffer is not ready. */
  nak?: (clock: number) => number;
  /** Absolute clocks at which one bit (4 clocks) of the line is inverted (J and K swap): noise from outside. */
  wireFlips?: readonly number[];
  script?: (h: UsbHost) => Pump<void>;
}

export class UsbBench {
  host: UsbHost;
  clock = 0;
  clashes = 0;
  /** Every clock's line state as the device saw it: [dp, dm]. */
  line: [number, number][] = [];
  constructor(public dev: DeviceIO, public opt: BenchOptions = {}) { this.host = new UsbHost(opt, opt.script); }
  /** What the device sees this clock (and a clash check), before it steps. */
  busNow(): Bus {
    const b = resolveBus(this.host.out, this.dev);
    if (b.clash) this.clashes++;
    let { dp, dm } = b;
    if (this.opt.wireFlips?.some((f) => this.clock >= f && this.clock < f + BIT_CLOCKS) && dp !== dm) { dp = 1 - dp; dm = 1 - dm; }
    return { dp, dm };
  }
  inputs(bus: Bus): DevIn { return { rst: this.clock < (this.opt.rstClocks ?? 4) ? 1 : 0, dp: bus.dp, dm: bus.dm, nak: this.opt.nak?.(this.clock) ?? 0 }; }
  /** One clock with the model's own device. */
  step(): void {
    const bus = this.busNow();
    this.line.push([bus.dp, bus.dm]);
    this.dev.step(this.inputs(bus));
    this.host.step(bus);
    this.clock++;
  }
  run(max = 200000): number {
    while (!this.host.done && this.clock < max) this.step();
    return this.clock;
  }
}
