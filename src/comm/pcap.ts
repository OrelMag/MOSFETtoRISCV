// The classic libpcap file format, DOM-free: what "Save capture" writes and Wireshark or tcpdump opens. Little-endian,
// microsecond timestamps, link type 1 (Ethernet). A capture normally has no FCS, so `frames` are given without one
// (comm/ethframe.ts frameBody).

export const PCAP_MAGIC = 0xa1b2c3d4;
export const LINKTYPE_ETHERNET = 1;
const SNAPLEN = 65535;

export interface Captured { /** Time of the frame's first byte, in microseconds from the start of the capture. */ us: number; bytes: ArrayLike<number> }

export function pcapFile(frames: readonly Captured[]): Uint8Array {
  const size = 24 + frames.reduce((n, f) => n + 16 + f.bytes.length, 0);
  const out = new Uint8Array(size), v = new DataView(out.buffer);
  v.setUint32(0, PCAP_MAGIC, true);
  v.setUint16(4, 2, true);
  v.setUint16(6, 4, true);
  // thiszone and sigfigs stay 0
  v.setUint32(16, SNAPLEN, true);
  v.setUint32(20, LINKTYPE_ETHERNET, true);
  let at = 24;
  for (const f of frames) {
    const us = Math.max(0, Math.round(f.us));
    v.setUint32(at, Math.floor(us / 1e6), true);
    v.setUint32(at + 4, us % 1e6, true);
    v.setUint32(at + 8, f.bytes.length, true);
    v.setUint32(at + 12, f.bytes.length, true);
    out.set(Array.from(f.bytes), at + 16);
    at += 16 + f.bytes.length;
  }
  return out;
}

/** Reads back what pcapFile wrote (tests, and a check that a capture is well formed). */
export function readPcap(file: Uint8Array): Captured[] {
  const v = new DataView(file.buffer, file.byteOffset, file.byteLength);
  if (v.getUint32(0, true) !== PCAP_MAGIC) throw new Error('not a little-endian microsecond pcap file');
  const frames: Captured[] = [];
  for (let at = 24; at + 16 <= file.length;) {
    const n = v.getUint32(at + 8, true);
    frames.push({ us: v.getUint32(at, true) * 1e6 + v.getUint32(at + 4, true), bytes: file.slice(at + 16, at + 16 + n) });
    at += 16 + n;
  }
  return frames;
}
