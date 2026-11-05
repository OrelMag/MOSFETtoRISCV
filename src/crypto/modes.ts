// A block cipher is not yet a way to encrypt a message (DOM-free): ECB, CTR and GCM over crypto/aes.ts, and the bitmaps that show what
// each leaves in the open. tests/crypto-modes.test.ts holds CTR and GCM to node:crypto and to the NIST GCM spec's test cases.

import { encryptBlock, type Bytes } from './aes';

/** Each block on its own: equal blocks in, equal blocks out, which is the flaw. */
export function ecbEncrypt(data: Bytes, key: Bytes): Bytes {
  const out: Bytes = [];
  for (let i = 0; i < data.length; i += 16) {
    const b = data.slice(i, i + 16);
    while (b.length < 16) b.push(0);
    out.push(...encryptBlock(b, key));
  }
  return out;
}

const inc32 = (c: Bytes): Bytes => {
  const o = [...c];
  for (let i = 15; i >= 12; i--) { o[i] = (o[i] + 1) & 0xff; if (o[i]) break; }
  return o;
};

/** XOR with the cipher of a counter: no block ever enters the cipher twice, while the counter does not repeat. */
export function ctrCrypt(data: Bytes, key: Bytes, counter0: Bytes): Bytes {
  const out: Bytes = [];
  let c = counter0, ks: Bytes = [];
  data.forEach((b, i) => {
    if (i % 16 === 0) { ks = encryptBlock(c, key); c = inc32(c); }
    out.push(b ^ ks[i % 16]);
  });
  return out;
}

/** A 96-bit nonce's first counter block. */
const j0 = (iv: Bytes): Bytes => [...iv, 0, 0, 0, 1];

/** Multiply in GF(2^128) with GCM's bit order: bit 0 is the top bit of byte 0, and the field is x^128 + x^7 + x^2 + x + 1. */
function gfMul(x: Bytes, h: Bytes): Bytes {
  const z = new Array<number>(16).fill(0), v = [...h];
  for (let i = 0; i < 128; i++) {
    if (x[i >> 3] & (0x80 >> (i & 7))) for (let k = 0; k < 16; k++) z[k] ^= v[k];
    const lsb = v[15] & 1;
    for (let k = 15; k > 0; k--) v[k] = (v[k] >>> 1) | ((v[k - 1] & 1) << 7);
    v[0] >>>= 1;
    if (lsb) v[0] ^= 0xe1;
  }
  return z;
}

function ghash(h: Bytes, aad: Bytes, c: Bytes): Bytes {
  let y = new Array<number>(16).fill(0);
  const absorb = (d: Bytes) => {
    for (let i = 0; i < d.length; i += 16) {
      for (let k = 0; k < 16 && i + k < d.length; k++) y[k] ^= d[i + k];
      y = gfMul(y, h);
    }
  };
  absorb(aad);
  absorb(c);
  const bits = (n: number): Bytes => { const b = new Array<number>(8).fill(0); let v = n * 8; for (let i = 7; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); } return b; };
  absorb([...bits(aad.length), ...bits(c.length)]);
  return y;
}

export interface Sealed { ciphertext: Bytes; tag: Bytes }

/** AES-128-GCM with a 96-bit nonce: CTR for secrecy, a keyed polynomial over the ciphertext for integrity. */
export function gcmSeal(plain: Bytes, key: Bytes, iv: Bytes, aad: Bytes = []): Sealed {
  const h = encryptBlock(new Array<number>(16).fill(0), key), c0 = j0(iv), ciphertext = ctrCrypt(plain, key, inc32(c0));
  const s = ghash(h, aad, ciphertext), e = encryptBlock(c0, key);
  return { ciphertext, tag: s.map((b, i) => b ^ e[i]) };
}

/** The plaintext, or null when the tag does not match: a changed bit anywhere is refused, not decrypted. */
export function gcmOpen(s: Sealed, key: Bytes, iv: Bytes, aad: Bytes = []): Bytes | null {
  const h = encryptBlock(new Array<number>(16).fill(0), key), c0 = j0(iv), t = ghash(h, aad, s.ciphertext), e = encryptBlock(c0, key);
  let bad = 0;
  t.forEach((b, i) => { bad |= b ^ e[i] ^ s.tag[i]; });
  return bad ? null : ctrCrypt(s.ciphertext, key, inc32(c0));
}

export const bitsDiffer = (a: readonly number[], b: readonly number[]): number => {
  let n = 0;
  a.forEach((x, i) => { for (let v = x ^ b[i]; v; v &= v - 1) n++; });
  return n;
};

// ---------------------------------------------------------------- the pictures

export const PIC = 96;

/** Two flat pictures with large areas of one value: what a cipher must hide. One byte a pixel, 16 pixels a block. */
export function picture(which: 0 | 1): Bytes {
  const px: Bytes = [];
  for (let y = 0; y < PIC; y++) for (let x = 0; x < PIC; x++) {
    const dx = x - 48, dy = y - 48, r = Math.hypot(dx, dy);
    let v: boolean;
    if (which === 0) v = (r < 40 && r > 26) || (Math.abs(dx) < 6 && r < 40) || (Math.abs(dy) < 6 && r < 40); // a wheel
    else v = (Math.abs(dx - dy) < 7 || Math.abs(dx + dy) < 7) && r < 44; // a cross
    px.push(v ? 255 : 0);
  }
  return px;
}
