// Ethernet II frames, real bytes, DOM-free: what the MAC (lib/ethernet.ts), the switch and later the NIC and the stack all
// carry. FCS from comm/crc.ts (checked against zlib there); the bytes open in Wireshark through comm/pcap.ts.
//
// Between blocks a frame is a byte stream: data[7:0], valid, last, ready. A byte moves at a rising edge where valid and
// ready are both 1; last marks the frame's final byte; the sender holds a byte until it moves. On the stream a frame
// runs from the destination address to the last payload or pad byte: the MAC adds preamble, SFD and FCS going out, and
// strips and checks them coming in.

import { crc32, fcsBytes } from './crc';

export const PREAMBLE = [0x55, 0x55, 0x55, 0x55, 0x55, 0x55, 0x55];
export const SFD = 0xd5;
export const HEADER_BYTES = 14;
export const FCS_BYTES = 4;
/** Destination to FCS: the shortest frame a receiver accepts, and the longest of plain Ethernet. */
export const MIN_FRAME = 64;
export const MAX_FRAME = 1518;
export const MIN_PAYLOAD = MIN_FRAME - HEADER_BYTES - FCS_BYTES;
export const MAX_PAYLOAD = MAX_FRAME - HEADER_BYTES - FCS_BYTES;
/** Silence between frames, in byte times. */
export const GAP_BYTES = 12;
export const BROADCAST = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
/** IEEE 802's local experimental type: what a frame of demo bytes says it is. Tagged 0x0800 without an IP header, a dissector rightly calls it malformed. */
export const ETHERTYPE_LOCAL = 0x88b5;

export type Mac = readonly number[];

export interface FrameSpec { dst: Mac; src: Mac; type: number; payload: ArrayLike<number> }

export const macText = (m: Mac): string => [...m].map((b) => b.toString(16).padStart(2, '0')).join(':');
/** A multicast address (broadcast included) has the low bit of its first byte set: that bit goes out first on the wire. */
export const isGroup = (m: Mac): boolean => (m[0] & 1) === 1;

/** Destination, source, type, payload, pad to the minimum: the frame as it moves on the stream, without FCS. */
export function frameBody(f: FrameSpec): number[] {
  if (f.payload.length > MAX_PAYLOAD) throw new Error(`payload of ${f.payload.length} bytes: at most ${MAX_PAYLOAD}`);
  const b = [...f.dst, ...f.src, (f.type >> 8) & 0xff, f.type & 0xff, ...Array.from(f.payload)];
  while (b.length < MIN_FRAME - FCS_BYTES) b.push(0);
  return b;
}

/** The whole frame, FCS included. */
export function frameBytes(f: FrameSpec): number[] {
  const b = frameBody(f);
  return [...b, ...fcsBytes(crc32(b))];
}

/** What crosses the wire: preamble, SFD, then the frame. */
export const wireBytes = (f: FrameSpec): number[] => [...PREAMBLE, SFD, ...frameBytes(f)];

export interface Parsed { dst: number[]; src: number[]; type: number; payload: number[]; fcsOk: boolean; runt: boolean; tooLong: boolean }

/** Reads a frame, FCS included, from the destination on. A payload keeps its pad: only the layer above knows its length. */
export function parseFrame(bytes: ArrayLike<number>): Parsed {
  const a = Array.from(bytes), body = a.slice(0, Math.max(0, a.length - FCS_BYTES));
  const want = fcsBytes(crc32(body));
  return {
    dst: a.slice(0, 6), src: a.slice(6, 12), type: ((a[12] ?? 0) << 8) | (a[13] ?? 0), payload: a.slice(HEADER_BYTES, Math.max(HEADER_BYTES, a.length - FCS_BYTES)),
    fcsOk: a.length >= HEADER_BYTES + FCS_BYTES && want.every((v, i) => v === a[a.length - FCS_BYTES + i]),
    runt: a.length < MIN_FRAME, tooLong: a.length > MAX_FRAME,
  };
}
