// IPv4 as real bytes (RFC 791), DOM-free: what a router reads and rewrites. The checksum is the one's-complement sum of RFC 1071;
// the rewrite a router makes is RFC 1624's incremental update, which the tests hold equal to a full recomputation.

/** An IP address is one 32-bit number, as the stack keeps it. */
export const ipOf = (text: string): number => {
  const p = text.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) throw new Error(`not an address: ${text}`);
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
};
export const ipText = (ip: number): string => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');

export const IP_HEADER = 20;
export const PROTO_ICMP = 1, PROTO_TCP = 6, PROTO_UDP = 17;

/** One's-complement sum of big-endian 16-bit words, folded to 16 bits (RFC 1071). */
export function onesSum(bytes: ArrayLike<number>, start = 0): number {
  let sum = start;
  for (let i = 0; i < bytes.length; i += 2) sum += (bytes[i] << 8) | (i + 1 < bytes.length ? bytes[i + 1] : 0);
  while (sum > 0xffff) sum = (sum & 0xffff) + Math.floor(sum / 65536);
  return sum;
}
export const checksum = (bytes: ArrayLike<number>, start = 0): number => ~onesSum(bytes, start) & 0xffff;

export interface IpSpec { src: number; dst: number; ttl: number; proto: number; id?: number; payload: ArrayLike<number> }

/** Header and payload; no options, not fragmented, the DF bit set as a modern host sends. */
export function ipPacket(p: IpSpec): number[] {
  const len = IP_HEADER + p.payload.length, id = p.id ?? 0;
  const h = [0x45, 0, len >> 8, len & 255, id >> 8, id & 255, 0x40, 0, p.ttl, p.proto, 0, 0,
    p.src >>> 24, (p.src >>> 16) & 255, (p.src >>> 8) & 255, p.src & 255, p.dst >>> 24, (p.dst >>> 16) & 255, (p.dst >>> 8) & 255, p.dst & 255];
  const c = checksum(h);
  h[10] = c >> 8; h[11] = c & 255;
  return [...h, ...Array.from(p.payload)];
}

export interface IpFields { version: number; ihl: number; len: number; id: number; ttl: number; proto: number; check: number; src: number; dst: number; checkOk: boolean }

export function parseIp(b: ArrayLike<number>): IpFields {
  const a = Array.from(b).slice(0, IP_HEADER), w = (i: number) => (a[i] << 8) | a[i + 1], u = (i: number) => ((a[i] << 24) | (a[i + 1] << 16) | (a[i + 2] << 8) | a[i + 3]) >>> 0;
  return { version: a[0] >> 4, ihl: a[0] & 15, len: w(2), id: w(4), ttl: a[8], proto: a[9], check: w(10), src: u(12), dst: u(16), checkOk: onesSum(a) === 0xffff };
}

/**
 * RFC 1624 equation 3: HC' = ~(~HC + ~m + m'), one's complement. Decrementing the TTL lowers the word {TTL, protocol} by 0x0100,
 * so ~m + m' is the constant 0xFEFF, which is what the gates add.
 */
export const TTL_DELTA = 0xfeff;
export function ttlChecksum(hc: number): number {
  let s = (~hc & 0xffff) + TTL_DELTA;
  s = (s & 0xffff) + (s >> 16);
  return ~s & 0xffff;
}
