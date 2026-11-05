// Extracts the published test vectors the TLS tests check against, from the standards' own text, into tests/fixtures/tls/vectors.json (--write).
//   usage: vite-node scripts/tls-vectors.ts <dir> [--write]
// <dir> holds rfc/rfc{4231,5869,7748,8446,8448}.txt (curl https://www.rfc-editor.org/rfc/rfcNNNN.txt) and nist/ with the text of
//   sha256ex  : NIST's SHA-256 examples, https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Standards-and-Guidelines/documents/examples/SHA256.pdf
//   aes197-2001: FIPS 197 (2001) appendix C, https://csrc.nist.gov/files/pubs/fips/197/final/docs/fips-197.pdf
//   aes197    : FIPS 197 (2023 update) appendix A.1 key expansion
//   gcm2      : McGrew and Viega, "The Galois/Counter Mode of Operation (GCM)" test cases, https://luca-giuzzi.unibs.it/corsi/Support/papers-cryptography/gcm-spec.pdf
// (the PDFs were turned to text by inflating their content streams; the numbers are not retyped by hand).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
if (!dir) throw new Error('usage: tls-vectors.ts <dir> [--write]');
const rd = (p: string): string => readFileSync(join(dir, p), 'latin1').replace(/\r/g, '');
const hex = (s: string): string => s.replace(/\([^)]*\)/g, '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();

// ---- RFC 4231: HMAC-SHA-256 test cases 1, 2, 3, 4, 6, 7 (5 is truncated output) ----
function hmacCases(): { n: number; key: string; data: string; mac: string }[] {
  const t = rd('rfc/rfc4231.txt');
  const out: { n: number; key: string; data: string; mac: string }[] = [];
  for (const n of [1, 2, 3, 4, 6, 7]) {
    const a = t.lastIndexOf(`4.${n + 1}.  Test Case ${n}`);
    const b = t.indexOf(`Test Case ${n + 1}\n`, a + 10);
    let sec = t.slice(a, b < 0 ? undefined : b);
    sec = sec.replace(/^Nystrom.*$/gm, '').replace(/^RFC 4231.*$/gm, '').replace(/\f/g, '');
    const field = (name: string, next: string[]): string => {
      const m = new RegExp(`${name}\\s*=?([\\s\\S]*?)(?=\\n\\s*(?:${next.join('|')})\\s*=|\\n\\s*\\n)`).exec(sec);
      if (!m) throw new Error(`RFC 4231 case ${n}: no ${name}`);
      return hex(m[1].replace(/\n\s*\n[\s\S]*$/, ''));
    };
    out.push({ n, key: field('Key', ['Data']), data: field('Data', ['HMAC-SHA-224']), mac: field('HMAC-SHA-256', ['HMAC-SHA-384']) });
  }
  return out;
}

// ---- RFC 5869 appendix A.1 - A.3 (SHA-256) ----
function hkdfCases(): { n: number; ikm: string; salt: string; info: string; l: number; prk: string; okm: string }[] {
  const t = rd('rfc/rfc5869.txt').replace(/^Krawczyk.*$/gm, '').replace(/^RFC 5869.*$/gm, '');
  return [1, 2, 3].map((n) => {
    const a = t.indexOf(`A.${n}.  Test Case ${n}`);
    const sec = t.slice(a, t.indexOf(`A.${n + 1}.  Test Case`, a));
    const f = (name: string): string => {
      // from the name's '=' to the '(N octets)' that ends the value (it can run over a page break)
      const m = new RegExp(`\\n   ${name}\\s*=\\s*([\\s\\S]*?\\(\\d+ octets\\))`).exec(sec);
      if (!m) throw new Error(`RFC 5869 case ${n}: no ${name}`);
      return hex(m[1].replace(/\(\d+ octets\)/g, '').replace(/\(0 octets\)/, '').replace(/0x/g, ''));
    };
    return { n, ikm: f('IKM'), salt: f('salt'), info: f('info'), l: Number(/L\s*=\s*(\d+)/.exec(sec)![1]), prk: f('PRK'), okm: f('OKM') };
  });
}

// ---- RFC 7748 ----
function x25519Vectors() {
  const t = rd('rfc/rfc7748.txt').replace(/^Langley.*$/gm, '').replace(/^RFC 7748.*$/gm, '');
  const s52 = t.slice(t.indexOf('5.2.  Test Vectors'), t.indexOf('   X448:\n   Input scalar'));
  const grab = (src: string, label: string, from = 0): [string, number] => {
    const i = src.indexOf(label, from);
    if (i < 0) throw new Error(`no ${label}`);
    const m = /^\s*((?:[0-9a-f]{16,}\s*\n?)+)/.exec(src.slice(i + label.length))!;
    return [hex(m[1]), i + label.length];
  };
  const pairs: { scalar: string; u: string; out: string }[] = [];
  let at = 0;
  for (let k = 0; k < 2; k++) {
    const [scalar, p1] = grab(s52, 'Input scalar:\n', at);
    const [u, p2] = grab(s52, 'Input u-coordinate:\n', p1);
    const [out, p3] = grab(s52, 'Output u-coordinate:\n', p2);
    pairs.push({ scalar, u, out });
    at = p3;
  }
  const it = t.slice(t.indexOf('The second type of test vector'), t.lastIndexOf('6.  Diffie-Hellman'));
  const [start] = grab(it, 'For X25519:\n   ');
  const oneAfter = /After one iteration:\s*\n\s*([0-9a-f]{64})/.exec(it)?.[1];
  const thousand = /After 1,000 iterations:\s*\n\s*([0-9a-f]{64})/.exec(it)?.[1];
  const million = /After 1,000,000 iterations:\s*\n\s*([0-9a-f]{64})/.exec(it)?.[1];
  const s61 = t.slice(t.lastIndexOf('6.1.  Curve25519'), t.lastIndexOf('6.2.  Curve448'));
  const [alicePriv] = grab(s61, "Alice's private key, a:\n");
  const [alicePub] = grab(s61, "Alice's public key, X25519(a, 9):\n");
  const [bobPriv] = grab(s61, "Bob's private key, b:\n");
  const [bobPub] = grab(s61, "Bob's public key, X25519(b, 9):\n");
  const [shared] = grab(s61, 'K:\n');
  return { pairs, iterated: { start, one: oneAfter, thousand, million }, dh: { alicePriv, alicePub, bobPriv, bobPub, shared } };
}

// ---- RFC 8448 section 3: every heading ("{server}  derive secret ...:") with its fields (name, octets, hex) ----
function trace8448() {
  const all = rd('rfc/rfc8448.txt').replace(/\f/g, '');
  const start = all.lastIndexOf('3.  Simple 1-RTT Handshake');
  const body = all.slice(start, all.indexOf('4.  Resumed 0-RTT Handshake', start));
  const lines = body.split('\n').filter((l) => !/^Thomson\s/.test(l) && !/^RFC 8448\s/.test(l));
  const items: { who: string; action: string; field: string; octets: number; hex: string }[] = [];
  let who = '', action = '';
  for (let i = 0; i < lines.length; i++) {
    const h = /^   \{(client|server)\}\s+(.*)$/.exec(lines[i]);
    if (h) {
      who = h[1];
      let a = h[2];
      // a heading can wrap onto the next lines until its closing colon
      while (!/:\s*$/.test(a) && !/\)\s*$/.test(a) && i + 1 < lines.length && /^      \S/.test(lines[i + 1]) && !/octets\)/.test(lines[i + 1])) a += ` ${lines[++i].trim()}`;
      action = a.replace(/:\s*$/, '');
      continue;
    }
    const f = /^      ([A-Za-z0-9 _-]+?) \((\d+) octets\):\s*(.*)$/.exec(lines[i]);
    if (!f) continue;
    let hx = f[3];
    // continuation lines, across a page break (blank lines in between; the page header and footer lines are already dropped)
    for (;;) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      if (j < lines.length && /^         [0-9a-f]{2}( [0-9a-f]{2})*\s*$/.test(lines[j])) { hx += ` ${lines[j].trim()}`; i = j; } else break;
    }
    const octets = Number(f[2]);
    const value = hx.includes('(empty)') ? '' : hx.replace(/[^0-9a-f]/g, '');
    if (value.length !== 2 * octets) throw new Error(`RFC 8448: ${action} / ${f[1]}: ${octets} octets but ${value.length / 2} read`);
    items.push({ who, action, field: f[1], octets, hex: value });
  }
  return items;
}

// ---- SHA-256 examples (NIST) ----
function shaExamples() {
  const t = readFileSync(join(dir, 'nist/sha256ex.txt'), 'latin1').replace(/\r/g, '');
  const out: { message: string; digest: string }[] = [];
  const first = t.slice(0, t.indexOf('Two Block Message Sample'));
  const second = t.slice(t.indexOf('Two Block Message Sample'), t.indexOf('Two Block Message Sample', t.indexOf('Two Block Message Sample') + 30));
  for (const sec of [first, second]) {
    const msg = /Input Message:\s*\n?\s*"([^"]*)"/.exec(sec)![1];
    const d = /Message Digest is\s*\n([\s\S]*?)\n=+/.exec(sec)![1];
    out.push({ message: msg, digest: hex(d) });
  }
  return out;
}

// ---- FIPS 197 ----
function aesExamples() {
  const t = readFileSync(join(dir, 'nist/aes197-2001.txt'), 'latin1').replace(/\r/g, '');
  const plaintext = /PLAINTEXT:\s+([0-9a-f]{32})/.exec(t)![1];
  const key = /KEY:\s+([0-9a-f]{32})[^0-9a-f]/.exec(t)![1];
  const cipher = /round\[10\]\.output\s+([0-9a-f]{32})/.exec(t)![1];
  const lastRoundKey = /round\[10\]\.k_sch\s+([0-9a-f]{32})\s*\n[^\n]*\n?[^\n]*round\[10\]\.output/.exec(t)?.[1] ?? /round\[10\]\.k_sch\s+(13111d7f[0-9a-f]{24})/.exec(t)![1];
  const a = readFileSync(join(dir, 'nist/aes197.txt'), 'latin1').replace(/\r/g, '').replace(/\s+/g, ' ');
  const w = /\b40 \w{8} \w{8} \w{8} \w{8} \w{8} \w{8} (\w{8}) 41 \w{8} \w{8} (\w{8}) 42 \w{8} \w{8} (\w{8}) 43 \w{8} \w{8} (\w{8})/.exec(a)!;
  const key2b = /Key\s*=\s*2b 7e 15 16 28 ae d2 a6 ab f7 15 88 09 cf 4f 3c/.test(a);
  if (!key2b) throw new Error('FIPS 197 A.1: key not found');
  return { c1: { plaintext, key, ciphertext: cipher, lastRoundKey }, a1: { key: '2b7e151628aed2a6abf7158809cf4f3c', lastRoundKey: w.slice(1, 5).join('') } };
}

// ---- GCM spec test cases 1 - 4 (AES-128, 96-bit IV) ----
function gcmCases() {
  const t = readFileSync(join(dir, 'nist/gcm2.txt'), 'latin1').replace(/\r/g, '');
  const out: Record<string, string>[] = [];
  for (let n = 1; n <= 4; n++) {
    const a = t.indexOf(`Test Case ${n}\n`);
    const b = t.indexOf(`Test Case ${n + 1}\n`, a);
    const toks = t.slice(a, b).split(/\s+/).filter(Boolean);
    const rec: Record<string, string> = { n: String(n) };
    for (let i = 0; i < toks.length; i++) {
      if (!['K', 'P', 'A', 'IV', 'H', 'C', 'T'].includes(toks[i])) continue;
      let v = '';
      let j = i + 1;
      while (j < toks.length && /^[0-9a-f]{8,}$/.test(toks[j])) v += toks[j++];
      if (v || rec[toks[i]] === undefined) rec[toks[i]] = rec[toks[i]] || v;
    }
    out.push(rec);
  }
  return out;
}

// ---- RFC 8446: the HelloRetryRequest random ----
function hrrRandom(): string {
  const t = rd('rfc/rfc8446.txt');
  const i = t.indexOf('CF 21 AD 74 E5 9A 61 11 BE 1D 8C 02 1E 65 B8 91');
  if (i < 0) throw new Error('HRR random not found');
  return hex(t.slice(i, i + 140).split('\n').slice(0, 2).join(' ').replace(/[^0-9A-F ]/g, ' ')).slice(0, 64);
}

const vectors = {
  sources: {
    rfc4231: 'https://www.rfc-editor.org/rfc/rfc4231.txt', rfc5869: 'https://www.rfc-editor.org/rfc/rfc5869.txt', rfc7748: 'https://www.rfc-editor.org/rfc/rfc7748.txt',
    rfc8446: 'https://www.rfc-editor.org/rfc/rfc8446.txt', rfc8448: 'https://www.rfc-editor.org/rfc/rfc8448.txt',
    fips180: 'https://csrc.nist.gov/CSRC/media/Projects/Cryptographic-Standards-and-Guidelines/documents/examples/SHA256.pdf',
    fips197: 'https://csrc.nist.gov/files/pubs/fips/197/final/docs/fips-197.pdf (2001, appendix C) and the 2023 update (appendix A.1)',
    gcm: 'McGrew and Viega, The Galois/Counter Mode of Operation (GCM), appendix B test cases 1-4',
  },
  sha256: shaExamples(),
  hmac: hmacCases(),
  hkdf: hkdfCases(),
  aes: aesExamples(),
  gcm: gcmCases(),
  x25519: x25519Vectors(),
  hrrRandom: hrrRandom(),
  rfc8448: trace8448(),
};
const text = `${JSON.stringify(vectors, null, 1)}\n`;
if (process.argv.includes('--write')) writeFileSync('tests/fixtures/tls/vectors.json', text);
else console.log(text.slice(0, 3000));
console.log('rfc8448 items', vectors.rfc8448.length, 'hmac', vectors.hmac.length, 'gcm', JSON.stringify(vectors.gcm.map((g) => Object.keys(g).join(','))));
