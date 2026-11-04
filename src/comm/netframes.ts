// Frames as the chapter draws them: ARP (RFC 826), IPv4 (RFC 791) carrying ICMP echo (RFC 792) or UDP (RFC 768), with the Internet checksum
// (RFC 1071), each as bytes with the fields they are made of, and a small dissector for what a capture shows. DOM-free. This is a second,
// independent implementation of what the Python stack in comm/stack/ builds on the CPU: tests/comm-netframes.test.ts makes the compiled
// stack and this module agree byte for byte.

import { BROADCAST, ETHERTYPE_ARP, ETHERTYPE_IPV4, frameBody, type Mac } from './ethframe';

export const ip4 = (a: number, b: number, c: number, d: number): number => ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
export const ipText = (n: number): string => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
export const macText = (m: ArrayLike<number>): string => Array.from(m, (b) => b.toString(16).padStart(2, '0')).join(':');
const be16 = (v: number) => [(v >> 8) & 255, v & 255];
const be32 = (v: number) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];

/** RFC 1071: the 16-bit ones' complement sum of the words of `bytes` (an odd last byte padded with a zero) and `start`, carries folded back in. */
export function onesSum(bytes: ArrayLike<number>, start = 0): number {
  let s = start;
  for (let i = 0; i < bytes.length; i += 2) s += (bytes[i] << 8) | (i + 1 < bytes.length ? bytes[i + 1] : 0);
  while (s > 0xffff) s = (s & 0xffff) + (s >>> 16);
  return s;
}
/** The checksum to store: the complement of the sum. */
export const checksum = (bytes: ArrayLike<number>, start = 0): number => ~onesSum(bytes, start) & 0xffff;

export type Layer = 'eth' | 'arp' | 'ip' | 'icmp' | 'udp' | 'tcp' | 'data' | 'pad' | 'fcs';
export interface Field { layer: Layer; name: string; bytes: number[]; /** How to read it. */ value: string }
export interface Built { bytes: number[]; fields: Field[] }

const ethFields = (dst: Mac, src: Mac, type: number): Field[] => [
  { layer: 'eth', name: 'destination', bytes: [...dst], value: macText(dst) + (dst.every((b) => b === 255) ? ' (broadcast)' : '') },
  { layer: 'eth', name: 'source', bytes: [...src], value: macText(src) },
  { layer: 'eth', name: 'EtherType', bytes: be16(type), value: type === ETHERTYPE_ARP ? '0x0806 ARP' : type === ETHERTYPE_IPV4 ? '0x0800 IPv4' : `0x${type.toString(16)}` },
];
const flat = (f: Field[]) => f.flatMap((x) => x.bytes);

export interface ArpSpec { op: 1 | 2; sha: Mac; spa: number; tha: Mac; tpa: number }
/** An ARP packet in an Ethernet frame (42 bytes before padding). A request goes to the broadcast address, a reply to the asker. */
export function arpFrame(a: ArpSpec): Built {
  const dst = a.op === 1 ? BROADCAST : a.tha;
  const fields: Field[] = [
    ...ethFields(dst, a.sha, ETHERTYPE_ARP),
    { layer: 'arp', name: 'hardware type', bytes: be16(1), value: '1 Ethernet' },
    { layer: 'arp', name: 'protocol type', bytes: be16(0x0800), value: '0x0800 IPv4' },
    { layer: 'arp', name: 'address lengths', bytes: [6, 4], value: '6, 4' },
    { layer: 'arp', name: 'operation', bytes: be16(a.op), value: a.op === 1 ? '1 request' : '2 reply' },
    { layer: 'arp', name: 'sender MAC', bytes: [...a.sha], value: macText(a.sha) },
    { layer: 'arp', name: 'sender IP', bytes: be32(a.spa), value: ipText(a.spa) },
    { layer: 'arp', name: 'target MAC', bytes: [...a.tha], value: a.op === 1 ? '00:00:00:00:00:00 (unknown)' : macText(a.tha) },
    { layer: 'arp', name: 'target IP', bytes: be32(a.tpa), value: ipText(a.tpa) },
  ];
  return { bytes: flat(fields), fields };
}

export interface IpSpec { src: number; dst: number; proto: number; id: number; ttl?: number; srcMac: Mac; dstMac: Mac }
/** Ethernet and IPv4 headers around `transport` (no options, DF set, no fragmentation). */
function ipFrame(h: IpSpec, transport: Field[]): Built {
  const tlen = transport.reduce((n, f) => n + f.bytes.length, 0);
  const head = [0x45, 0, ...be16(20 + tlen), ...be16(h.id), 0x40, 0, h.ttl ?? 64, h.proto, 0, 0, ...be32(h.src), ...be32(h.dst)];
  const ck = checksum(head);
  head[10] = ck >> 8; head[11] = ck & 255;
  const ipf: Field[] = [
    { layer: 'ip', name: 'version, header length', bytes: [0x45], value: 'IPv4, 5 words' },
    { layer: 'ip', name: 'type of service', bytes: [0], value: '0' },
    { layer: 'ip', name: 'total length', bytes: be16(20 + tlen), value: `${20 + tlen}` },
    { layer: 'ip', name: 'identification', bytes: be16(h.id), value: `${h.id}` },
    { layer: 'ip', name: 'flags, fragment offset', bytes: [0x40, 0], value: "don't fragment, offset 0" },
    { layer: 'ip', name: 'time to live', bytes: [h.ttl ?? 64], value: `${h.ttl ?? 64}` },
    { layer: 'ip', name: 'protocol', bytes: [h.proto], value: h.proto === 1 ? '1 ICMP' : h.proto === 17 ? '17 UDP' : h.proto === 6 ? '6 TCP' : `${h.proto}` },
    { layer: 'ip', name: 'header checksum', bytes: be16(ck), value: `0x${ck.toString(16).padStart(4, '0')}` },
    { layer: 'ip', name: 'source address', bytes: be32(h.src), value: ipText(h.src) },
    { layer: 'ip', name: 'destination address', bytes: be32(h.dst), value: ipText(h.dst) },
  ];
  const fields = [...ethFields(h.dstMac, h.srcMac, ETHERTYPE_IPV4), ...ipf, ...transport];
  return { bytes: flat(fields), fields };
}

export interface EchoSpec extends Omit<IpSpec, 'proto'> { reply?: boolean; ident: number; seq: number; data: number[] }
export function icmpEchoFrame(e: EchoSpec): Built {
  const body = [e.reply ? 0 : 8, 0, 0, 0, ...be16(e.ident), ...be16(e.seq), ...e.data];
  const ck = checksum(body);
  const t: Field[] = [
    { layer: 'icmp', name: 'type', bytes: [body[0]], value: e.reply ? '0 echo reply' : '8 echo request' },
    { layer: 'icmp', name: 'code', bytes: [0], value: '0' },
    { layer: 'icmp', name: 'checksum', bytes: be16(ck), value: `0x${ck.toString(16).padStart(4, '0')}` },
    { layer: 'icmp', name: 'identifier', bytes: be16(e.ident), value: `0x${e.ident.toString(16)}` },
    { layer: 'icmp', name: 'sequence', bytes: be16(e.seq), value: `${e.seq}` },
    { layer: 'data', name: 'data', bytes: e.data, value: `${e.data.length} bytes` },
  ];
  return ipFrame({ ...e, proto: 1 }, t);
}

export interface UdpSpec extends Omit<IpSpec, 'proto'> { sport: number; dport: number; data: number[] }
/** UDP over IPv4: the checksum covers the pseudo-header (addresses, protocol, length) and the datagram; a computed 0 is sent as 0xffff. */
export function udpFrame(u: UdpSpec): Built {
  const len = 8 + u.data.length;
  const pseudo = onesSum([...be32(u.src), ...be32(u.dst), 0, 17, ...be16(len)]);
  let ck = checksum([...be16(u.sport), ...be16(u.dport), ...be16(len), 0, 0, ...u.data], pseudo);
  if (ck === 0) ck = 0xffff;
  const t: Field[] = [
    { layer: 'udp', name: 'source port', bytes: be16(u.sport), value: `${u.sport}` },
    { layer: 'udp', name: 'destination port', bytes: be16(u.dport), value: `${u.dport}` },
    { layer: 'udp', name: 'length', bytes: be16(len), value: `${len}` },
    { layer: 'udp', name: 'checksum', bytes: be16(ck), value: `0x${ck.toString(16).padStart(4, '0')}` },
    { layer: 'data', name: 'data', bytes: u.data, value: `${u.data.length} bytes` },
  ];
  return ipFrame({ ...u, proto: 17 }, t);
}

export interface TcpSpec extends Omit<IpSpec, 'proto'> { sport: number; dport: number; seq: number; ack: number; flags: number; wnd: number; mss?: number; data: number[] }
const TCP_FLAG_NAMES: [number, string][] = [[2, 'SYN'], [16, 'ACK'], [1, 'FIN'], [4, 'RST'], [8, 'PSH']];
export const tcpFlagText = (f: number): string => TCP_FLAG_NAMES.filter(([m]) => f & m).map(([, n]) => n).join(', ') || 'none';
/** TCP over IPv4 (RFC 9293): the checksum covers the same kind of pseudo-header as UDP's, with protocol 6, and the length is not in the segment. */
export function tcpFrame(u: TcpSpec): Built {
  const opt = u.mss === undefined ? [] : [2, 4, ...be16(u.mss)], hl = 20 + opt.length, len = hl + u.data.length;
  const pseudo = onesSum([...be32(u.src), ...be32(u.dst), 0, 6, ...be16(len)]);
  const ck = checksum([...be16(u.sport), ...be16(u.dport), ...be32(u.seq), ...be32(u.ack), (hl / 4) << 4, u.flags, ...be16(u.wnd), 0, 0, 0, 0, ...opt, ...u.data], pseudo);
  const t: Field[] = [
    { layer: 'tcp', name: 'source port', bytes: be16(u.sport), value: `${u.sport}` },
    { layer: 'tcp', name: 'destination port', bytes: be16(u.dport), value: `${u.dport}` },
    { layer: 'tcp', name: 'sequence number', bytes: be32(u.seq), value: `${u.seq >>> 0}` },
    { layer: 'tcp', name: 'acknowledgment number', bytes: be32(u.ack), value: `${u.ack >>> 0}` },
    { layer: 'tcp', name: 'header length', bytes: [(hl / 4) << 4], value: `${hl / 4} words` },
    { layer: 'tcp', name: 'flags', bytes: [u.flags], value: tcpFlagText(u.flags) },
    { layer: 'tcp', name: 'window', bytes: be16(u.wnd), value: `${u.wnd} bytes` },
    { layer: 'tcp', name: 'checksum', bytes: be16(ck), value: `0x${ck.toString(16).padStart(4, '0')}` },
    { layer: 'tcp', name: 'urgent pointer', bytes: [0, 0], value: '0' },
    ...(opt.length ? [{ layer: 'tcp' as const, name: 'option: maximum segment size', bytes: opt, value: `${u.mss} bytes` }] : []),
    { layer: 'data', name: 'data', bytes: u.data, value: `${u.data.length} bytes` },
  ];
  return ipFrame({ ...u, proto: 6 }, t);
}

/** What goes on the wire after the frame: padding to 60 bytes (the MAC adds it) and the 4-byte FCS. */
export const onWire = (f: Built): number[] => frameBody({ dst: f.bytes.slice(0, 6), src: f.bytes.slice(6, 12), type: (f.bytes[12] << 8) | f.bytes[13], payload: f.bytes.slice(14) });

/** One line for a captured frame (destination to the last data byte, without FCS). */
export function dissect(b: ArrayLike<number>): string {
  const a = Array.from(b);
  if (a.length < 14) return `runt frame, ${a.length} bytes`;
  const type = (a[12] << 8) | a[13];
  if (type === ETHERTYPE_ARP && a.length >= 42) {
    const op = (a[20] << 8) | a[21], spa = ip4(a[28], a[29], a[30], a[31]), tpa = ip4(a[38], a[39], a[40], a[41]);
    return op === 1 ? `ARP who has ${ipText(tpa)}? tell ${ipText(spa)}` : `ARP ${ipText(spa)} is at ${macText(a.slice(22, 28))}`;
  }
  if (type === ETHERTYPE_IPV4 && a.length >= 34) {
    const src = ipText(ip4(a[26], a[27], a[28], a[29])), dst = ipText(ip4(a[30], a[31], a[32], a[33])), hl = (a[14] & 15) * 4, proto = a[23], t = 14 + hl;
    if (proto === 1 && a.length >= t + 8) return `ICMP ${a[t] === 8 ? 'echo request' : a[t] === 0 ? 'echo reply' : `type ${a[t]}`} ${src} > ${dst} id 0x${((a[t + 4] << 8) | a[t + 5]).toString(16)} seq ${(a[t + 6] << 8) | a[t + 7]}`;
    if (proto === 17 && a.length >= t + 8) return `UDP ${src}:${(a[t] << 8) | a[t + 1]} > ${dst}:${(a[t + 2] << 8) | a[t + 3]} length ${((a[t + 4] << 8) | a[t + 5]) - 8}`;
    if (proto === 6 && a.length >= t + 20) { const w = (o: number) => ip4(a[o], a[o + 1], a[o + 2], a[o + 3]); const n = ((a[16] << 8) | a[17]) - (t - 14) - (a[t + 12] >> 4) * 4; return `TCP ${src}:${(a[t] << 8) | a[t + 1]} > ${dst}:${(a[t + 2] << 8) | a[t + 3]} [${tcpFlagText(a[t + 13])}] seq ${w(t + 4)} ack ${w(t + 8)} win ${(a[t + 14] << 8) | a[t + 15]} len ${n}`; }
    return `IPv4 protocol ${proto} ${src} > ${dst}`;
  }
  return `EtherType 0x${type.toString(16)}, ${a.length} bytes`;
}
