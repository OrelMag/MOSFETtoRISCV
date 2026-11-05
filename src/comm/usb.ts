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
  private lv = 'J'; private run = 0; private bits: number[] = []; private t = 0; private start = -1; private open = false;
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
