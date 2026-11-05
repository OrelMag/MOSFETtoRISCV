// The fixed strings of the protocol, written into RAM at start-up (the subset has no string literals): HKDF labels (RFC 8446 section 7.1) and the
// CertificateVerify signing prefix (section 4.4.3: 64 spaces, the context string, one zero byte).

import { MEM } from './layout';

export interface Str { addr: number; len: number; text: string }

let at = MEM.strings;
const s = (text: string): Str => { const r = { addr: at, len: text.length, text }; at += (text.length + 3) & ~3; return r; };

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
  cvPrefix: s(`${' '.repeat(64)}TLS 1.3, server CertificateVerify`),
} as const;

/** Python arguments for a label: `address, length`. */
export const lab = (x: Str): string => `${x.addr}, ${x.len}`;
