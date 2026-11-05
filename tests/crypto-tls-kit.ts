// Shared by the TLS tests: the published vectors (tests/fixtures/tls/vectors.json, extracted from the standards by scripts/tls-vectors.ts), byte helpers,
// and one TlsMachine per test file driven through the command mailbox.

import { readFileSync } from 'node:fs';
import { fullBuild } from '../src/crypto/tls/build';
import { MEM } from '../src/crypto/tls/layout';
import { TlsMachine } from '../src/crypto/tls/machine';

export interface Vectors {
  sources: Record<string, string>;
  sha256: { message: string; digest: string }[];
  hmac: { n: number; key: string; data: string; mac: string }[];
  hkdf: { n: number; ikm: string; salt: string; info: string; l: number; prk: string; okm: string }[];
  aes: { c1: { plaintext: string; key: string; ciphertext: string; lastRoundKey: string }; a1: { key: string; lastRoundKey: string } };
  gcm: { n: string; K: string; P: string; A?: string; IV: string; H: string; C: string; T: string }[];
  x25519: {
    pairs: { scalar: string; u: string; out: string }[];
    iterated: { start: string; one: string; thousand: string; million: string };
    dh: { alicePriv: string; alicePub: string; bobPriv: string; bobPub: string; shared: string };
  };
  hrrRandom: string;
  rfc8448: { who: string; action: string; field: string; octets: number; hex: string }[];
}

export const V: Vectors = JSON.parse(readFileSync(new URL('./fixtures/tls/vectors.json', import.meta.url), 'utf8'));
export const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g) ?? [], (h) => parseInt(h, 16));
export const tohex = (b: ArrayLike<number>): string => Array.from(b as ArrayLike<number> & Iterable<number>, (x) => x.toString(16).padStart(2, '0')).join('');
export const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** The n-th (from 0) RFC 8448 trace item with this action prefix and field name. */
export function trace(action: string | RegExp, field: string, nth = 0): Uint8Array {
  const m = V.rfc8448.filter((i) => i.field === field && (typeof action === 'string' ? i.action === action || `${i.who} ${i.action}` === action : action.test(`${i.who} ${i.action}`)));
  if (!m[nth]) throw new Error(`RFC 8448: no ${String(action)} / ${field} #${nth}`);
  return unhex(m[nth].hex);
}

let mach: TlsMachine | null = null;
/** A machine at its first idle, with the program of fullBuild(). */
export function machine(): TlsMachine {
  if (mach) return mach;
  const m = new TlsMachine(fullBuild().compiled.words);
  for (;;) {
    const r = m.runToRequest(5_000_000);
    if (r.kind === 'idle') break;
    if (r.kind !== 'budget') throw new Error(`start-up asked for ${r.kind}`);
  }
  return (mach = m);
}

/** Scratch layout for the helpers below: inputs at P + 0.., outputs after them. */
export const P = MEM.scratch;
export const BIG = MEM.app;

/** Put byte arrays one after another (4-aligned) from `at`; their addresses. */
export function place(m: TlsMachine, at: number, ...parts: Uint8Array[]): number[] {
  const out: number[] = [];
  for (const p of parts) { m.put(at, p); out.push(at); at += (p.length + 3) & ~3; at += 4; }
  return out;
}
