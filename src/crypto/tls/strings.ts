// The fixed strings of the protocol, written into RAM at start-up (the subset has no string literals): HKDF labels (RFC 8446 section 7.1) and the
// CertificateVerify signing prefix (section 4.4.3: 64 spaces, the context string, one zero byte).

import { MEM } from './layout';

export interface Str { addr: number; len: number; bytes: number[] }

let at = MEM.strings;
const bs = (bytes: number[]): Str => { const r = { addr: at, len: bytes.length, bytes }; at += (bytes.length + 3) & ~3; return r; };
const s = (text: string): Str => bs([...text].map((c) => c.charCodeAt(0)));

export const STR = {
  derived: s('derived'),
  cHs: s('c hs traffic'),
  sHs: s('s hs traffic'),
  cAp: s('c ap traffic'),
  sAp: s('s ap traffic'),
  exp: s('exp master'),
  res: s('res master'),
  key: s('key'),
  iv: s('iv'),
  finished: s('finished'),
  /** 64 spaces, "TLS 1.3, server CertificateVerify", 0x00: 98 bytes (the last byte is written by the program, a zero). */
  /** SHA-256("HelloRetryRequest"): the fixed ServerHello.random that marks a HelloRetryRequest (RFC 8446 section 4.1.3). */
  hrr: bs([0xcf, 0x21, 0xad, 0x74, 0xe5, 0x9a, 0x61, 0x11, 0xbe, 0x1d, 0x8c, 0x02, 0x1e, 0x65, 0xb8, 0x91, 0xc2, 0xa2, 0x11, 0x16, 0x7a, 0xbb, 0x8c, 0x5e, 0x07, 0x9e, 0x09, 0xe2, 0xc8, 0xa8, 0x33, 0x9c]),
  /** DER of the rsaEncryption OID, 1.2.840.113549.1.1.1. */
  oidRsa: bs([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]),
  cvPrefix: s(`${' '.repeat(64)}TLS 1.3, server CertificateVerify`),
} as const;

/** Python arguments for a label: `address, length`. */
export const lab = (x: Str): string => `${x.addr}, ${x.len}`;
