// The TLS primitives compiled from the Python subset and run on the golden model (FastISS, RV32IM), against the published vectors (FIPS 180-4, FIPS 197,
// the GCM spec, RFC 4231, RFC 5869, RFC 7748, RFC 8448; scripts/tls-vectors.ts extracted them from the standards' text) and, on seeded random inputs, node:crypto.
// The plain ISS must agree with FastISS on a short run (same results, same instruction count).

import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, constants, sign, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fullBuild, globalAddr } from '../src/crypto/tls/build';
import { STR } from '../src/crypto/tls/strings';
import { CMD, MEM } from '../src/crypto/tls/layout';
import { SHA256_K } from '../src/crypto/tls/sha';
import { ISS } from '../src/riscv/iss';
import { ascii, BIG, machine, place, tohex, trace, unhex, V } from './crypto-tls-kit';
import { lcg } from './util';
import { tick } from './yieldtick';

const rnd = (seed: number) => { const r = lcg(seed); return (n: number) => Uint8Array.from({ length: n }, () => r(256)); };

function sha(msg: Uint8Array): string {
  const m = machine();
  const [p, o] = place(m, BIG, msg, new Uint8Array(32));
  m.call(CMD.sha256, [p, msg.length, o]);
  return tohex(m.bytes(o, 32));
}
function hmac(key: Uint8Array, msg: Uint8Array): string {
  const m = machine();
  const [k, d, o] = place(m, BIG, key, msg, new Uint8Array(32));
  m.call(CMD.hmac, [k, key.length, d, msg.length, o]);
  return tohex(m.bytes(o, 32));
}

describe('the program', () => {
  it('the HelloRetryRequest random in the program is the one RFC 8446 section 4.1.3 prints', () => {
    expect(tohex(STR.hrr.bytes)).toBe(V.hrrRandom);
    expect(V.hrrRandom).toBe(createHash('sha256').update('HelloRetryRequest').digest('hex'));
  });
  it('the RV32I build holds no M-extension instruction, the RV32IM build does', () => {
    const isM = (w: number) => (w & 0x7f) === 0x33 && (w >>> 25) === 1;
    expect(fullBuild(false).compiled.words.filter((w) => isM(w >>> 0))).toHaveLength(0);
    expect(fullBuild(true).compiled.words.filter((w) => isM(w >>> 0)).length).toBeGreaterThan(10);
  });
});

describe('SHA-256 (FIPS 180-4)', () => {
  it('the round constants are the first 32 bits of the fractional parts of the cube roots of the first 64 primes (section 4.2.2)', () => {
    const primes: number[] = [];
    for (let n = 2; primes.length < 64; n++) if (primes.every((p) => n % p)) primes.push(n);
    const icbrt = (x: bigint): bigint => { let lo = 0n, hi = 1n << 100n; while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid ** 3n <= x) lo = mid; else hi = mid - 1n; } return lo; };
    const K = primes.map((p) => Number(icbrt(BigInt(p) << 96n) & 0xffffffffn));
    expect(SHA256_K.map((k) => k >>> 0)).toEqual(K);
  });
  it("NIST's examples: abc, and the two-block message", () => {
    for (const e of V.sha256) expect(sha(ascii(e.message))).toBe(e.digest);
  });
  it('empty, block-boundary and long messages equal node:crypto', async () => {
    const r = rnd(1);
    for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 4097]) {
      const msg = r(n);
      expect(sha(msg), `n = ${n}`).toBe(createHash('sha256').update(msg).digest('hex'));
      await tick();
    }
  });
});

describe('HMAC-SHA-256 (RFC 4231)', () => {
  it('test cases 1, 2, 3, 4, 6 and 7 (keys of 4 to 131 bytes; 5 is a truncated output)', () => {
    for (const c of V.hmac) expect(hmac(unhex(c.key), unhex(c.data)), `case ${c.n}`).toBe(c.mac);
  });
  it('random keys around the block size equal node:crypto', () => {
    const r = rnd(2);
    for (const [kn, mn] of [[0, 0], [1, 1], [32, 100], [63, 5], [64, 64], [65, 3], [100, 200], [200, 0]]) {
      const k = r(kn), d = r(mn);
      expect(hmac(k, d), `${kn}/${mn}`).toBe(createHmac('sha256', k).update(d).digest('hex'));
    }
  });
});

describe('HKDF (RFC 5869) and HKDF-Expand-Label (RFC 8446 7.1)', () => {
  it('appendix A.1 - A.3: PRK and OKM', () => {
    const m = machine();
    for (const c of V.hkdf) {
      const [s, i, info, prk, okm] = place(m, BIG, unhex(c.salt), unhex(c.ikm), unhex(c.info), new Uint8Array(32), new Uint8Array(c.l + 32));
      m.call(CMD.hkdfExtract, [s, c.salt.length / 2, i, c.ikm.length / 2, prk]);
      expect(tohex(m.bytes(prk, 32)), `PRK ${c.n}`).toBe(c.prk);
      m.call(CMD.hkdfExpand, [prk, info, c.info.length / 2, okm, c.l]);
      expect(tohex(m.bytes(okm, c.l)), `OKM ${c.n}`).toBe(c.okm);
    }
  });
  it("RFC 8448's HKDF-Expand with the trace's own info and PRK, and Expand-Label rebuilt from its label and context", () => {
    const m = machine();
    // each trace step that lists PRK, info and expanded in a row
    const steps = V.rfc8448.map((it, k) => ({ it, k })).filter(({ it }) => it.field.endsWith('info'));
    expect(steps.length).toBeGreaterThanOrEqual(20);
    let labels = 0;
    for (const { it, k } of steps) {
      const prk = V.rfc8448.slice(Math.max(0, k - 4), k).find((x) => x.field === 'PRK' && x.action === it.action && x.who === it.who);
      const exp = V.rfc8448.slice(k + 1, k + 3).find((x) => x.field === `${it.field.slice(0, -4)}expanded` && x.action === it.action && x.who === it.who);
      if (!prk || !exp) continue;
      const info = unhex(it.hex);
      const [a, b, o] = place(m, BIG, unhex(prk.hex), info, new Uint8Array(64));
      m.call(CMD.hkdfExpand, [a, b, info.length, o, exp.octets]);
      expect(tohex(m.bytes(o, exp.octets)), `${it.who} ${it.action}`).toBe(exp.hex);
      // info = uint16 length | uint8 6 + label length | "tls13 " label | uint8 context length | context
      const L = (info[0] << 8) | info[1], ll = info[2] - 6, label = info.subarray(9, 9 + ll), cl = info[9 + ll], ctx = info.subarray(10 + ll, 10 + ll + cl);
      expect(String.fromCharCode(...info.subarray(3, 9))).toBe('tls13 ');
      const [sp, lp, cp, op] = place(m, BIG, unhex(prk.hex), label, ctx, new Uint8Array(64));
      m.call(CMD.hkdfLabel, [sp, lp, ll, cp, cl, op, L]);
      expect(tohex(m.bytes(op, L)), `label ${String.fromCharCode(...label)}`).toBe(exp.hex);
      labels++;
    }
    expect(labels).toBeGreaterThan(15);
  });
  it('extract and expand equal node:crypto on random inputs', () => {
    const m = machine();
    const r = rnd(3);
    for (const [sn, inn, infn, L] of [[0, 22, 0, 32], [13, 22, 10, 42], [32, 32, 17, 16], [64, 100, 50, 100]]) {
      const salt = r(sn), ikm = r(inn), info = r(infn);
      const [s, i, f, prk, okm] = place(m, BIG, salt, ikm, info, new Uint8Array(32), new Uint8Array(L + 32));
      m.call(CMD.hkdfExtract, [s, sn, i, inn, prk]);
      m.call(CMD.hkdfExpand, [prk, f, infn, okm, L]);
      expect(tohex(m.bytes(okm, L))).toBe(tohex(new Uint8Array(hkdfSync('sha256', ikm, salt, info, L))));
    }
  });
});

describe('AES-128 (FIPS 197)', () => {
  const enc = (key: Uint8Array, pt: Uint8Array) => {
    const m = machine();
    const [k, p, o] = place(m, BIG, key, pt, new Uint8Array(16));
    m.call(CMD.aesEncrypt, [k, p, o]);
    return { ct: tohex(m.bytes(o, 16)), roundKeys: m.bytes(MEM.gcmCtxScratch, 176) };
  };
  it('appendix C.1: the example vector, and its last round key', () => {
    const e = enc(unhex(V.aes.c1.key), unhex(V.aes.c1.plaintext));
    expect(e.ct).toBe(V.aes.c1.ciphertext);
    expect(tohex(e.roundKeys.subarray(160))).toBe(V.aes.c1.lastRoundKey);
  });
  it('appendix A.1: the key expansion of 2b7e1516...: the last four words', () => {
    const e = enc(unhex(V.aes.a1.key), new Uint8Array(16));
    expect(tohex(e.roundKeys.subarray(160))).toBe(V.aes.a1.lastRoundKey);
  });
  it('random blocks equal node:crypto', () => {
    const r = rnd(4);
    for (let t = 0; t < 8; t++) {
      const key = r(16), pt = r(16);
      const c = createCipheriv('aes-128-ecb', key, null).setAutoPadding(false);
      expect(enc(key, pt).ct).toBe(tohex(Buffer.concat([c.update(pt), c.final()])));
    }
  });
});

describe('AES-128-GCM (SP 800-38D)', () => {
  const seal = (key: Uint8Array, iv: Uint8Array, aad: Uint8Array, pt: Uint8Array) => {
    const m = machine();
    const [k, i, a, p, o] = place(m, BIG, key, iv, aad, pt, new Uint8Array(pt.length + 16));
    m.call(CMD.gcmSeal, [k, i, a, aad.length, p, pt.length, o]);
    return { out: m.bytes(o, pt.length + 16), h: m.bytes(MEM.gcmCtxScratch + 176, 16) };
  };
  const open = (key: Uint8Array, iv: Uint8Array, aad: Uint8Array, ct: Uint8Array) => {
    const m = machine();
    const [k, i, a, c, o] = place(m, BIG, key, iv, aad, ct, new Uint8Array(ct.length));
    const ok = m.call(CMD.gcmOpen, [k, i, a, aad.length, c, ct.length - 16, o]);
    return { ok, pt: m.bytes(o, ct.length - 16) };
  };
  it("McGrew and Viega's test cases 1 - 4 (the hash subkey, ciphertext and tag), and opening them", () => {
    expect(V.gcm).toHaveLength(4);
    for (const c of V.gcm) {
      const s = seal(unhex(c.K), unhex(c.IV), unhex(c.A ?? ''), unhex(c.P));
      expect(tohex(s.h), `H ${c.n}`).toBe(c.H);
      expect(tohex(s.out), `case ${c.n}`).toBe(c.C + c.T);
      const o = open(unhex(c.K), unhex(c.IV), unhex(c.A ?? ''), s.out);
      expect(o.ok).toBe(1);
      expect(tohex(o.pt)).toBe(c.P);
    }
  });
  it('random keys, lengths and AAD equal node:crypto', async () => {
    const r = rnd(5);
    for (const [n, an] of [[0, 0], [0, 13], [1, 5], [15, 0], [16, 5], [17, 17], [50, 13], [64, 0], [100, 20], [333, 31]]) {
      const key = r(16), iv = r(12), aad = r(an), pt = r(n);
      const c = createCipheriv('aes-128-gcm', key, iv);
      c.setAAD(aad);
      const want = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
      const s = seal(key, iv, aad, pt);
      expect(tohex(s.out), `${n}/${an}`).toBe(tohex(want));
      await tick();
    }
  });
  it('a flipped bit anywhere (ciphertext, tag, AAD, IV, key) fails the tag and releases no plaintext', () => {
    const r = rnd(6);
    const key = r(16), iv = r(12), aad = r(13), pt = r(40);
    const good = seal(key, iv, aad, pt).out;
    expect(open(key, iv, aad, good).ok).toBe(1);
    const bad = (f: (k: Uint8Array, v: Uint8Array, a: Uint8Array, c: Uint8Array) => void) => {
      const [k, v, a, c] = [key.slice(), iv.slice(), aad.slice(), good.slice()];
      f(k, v, a, c);
      const m = machine();
      m.put(BIG + 4096, new Uint8Array(64)); // the output buffer, to see that nothing is written
      const [kk, vv, aa, cc] = place(m, BIG, k, v, a, c);
      const ok = m.call(CMD.gcmOpen, [kk, vv, aa, a.length, cc, c.length - 16, BIG + 4096]);
      return { ok, out: tohex(m.bytes(BIG + 4096, 40)) };
    };
    for (const f of [(_k: Uint8Array, _v: Uint8Array, _a: Uint8Array, c: Uint8Array) => { c[0] ^= 1; }, (_k: Uint8Array, _v: Uint8Array, _a: Uint8Array, c: Uint8Array) => { c[39] ^= 0x80; },
      (_k: Uint8Array, _v: Uint8Array, _a: Uint8Array, c: Uint8Array) => { c[40] ^= 1; }, (_k: Uint8Array, _v: Uint8Array, _a: Uint8Array, c: Uint8Array) => { c[55] ^= 1; },
      (_k: Uint8Array, _v: Uint8Array, a: Uint8Array) => { a[4] ^= 1; }, (_k: Uint8Array, v: Uint8Array) => { v[11] ^= 1; }, (k: Uint8Array) => { k[0] ^= 1; }]) {
      const b = bad(f);
      expect(b.ok).toBe(0);
      expect(b.out).toBe('00'.repeat(40));
    }
    // node agrees that the unmodified one is valid
    const d = createDecipheriv('aes-128-gcm', key, iv);
    d.setAAD(aad); d.setAuthTag(Buffer.from(good.subarray(40)));
    expect(tohex(Buffer.concat([d.update(good.subarray(0, 40)), d.final()]))).toBe(tohex(pt));
  });
});

describe('X25519 (RFC 7748)', () => {
  const x = (k: Uint8Array, u: Uint8Array): string => {
    const m = machine();
    const [kp, up, o] = place(m, BIG, k, u, new Uint8Array(32));
    m.call(CMD.x25519, [o, kp, up]);
    return tohex(m.bytes(o, 32));
  };
  it('5.2: the two test vectors', () => {
    for (const p of V.x25519.pairs) expect(x(unhex(p.scalar), unhex(p.u))).toBe(p.out);
  });
  it('5.2: one iteration of k, u = X25519(k, u), k (the 1,000 and 1,000,000 iteration results cost 3.5e10 and 3.5e13 cycles here: not run)', () => {
    const it = V.x25519.iterated;
    expect(x(unhex(it.start), unhex(it.start))).toBe(it.one);
  });
  it('6.1: Alice and Bob derive the public keys and the same shared secret', () => {
    const d = V.x25519.dh, base = unhex(`09${'00'.repeat(31)}`);
    expect(x(unhex(d.alicePriv), base)).toBe(d.alicePub);
    expect(x(unhex(d.bobPriv), base)).toBe(d.bobPub);
    expect(x(unhex(d.alicePriv), unhex(d.bobPub))).toBe(d.shared);
    expect(x(unhex(d.bobPriv), unhex(d.alicePub))).toBe(d.shared);
  });
  it('a small-order point gives the all-zero output the client refuses (section 6)', () => {
    expect(x(unhex(V.x25519.dh.alicePriv), new Uint8Array(32))).toBe('00'.repeat(32));
  });
  it('random scalars and points equal node:crypto', () => {
    const r = rnd(7);
    for (let t = 0; t < 3; t++) {
      const k = r(32), u = r(32);
      const priv = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), k]), format: 'der', type: 'pkcs8' });
      const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), u]), format: 'der', type: 'spki' });
      expect(x(k, u)).toBe(tohex(diffieHellman({ privateKey: priv, publicKey: pub })));
    }
  });
});

describe('RSASSA-PSS-SHA-256 verification and the certificate reader', () => {
  const verify = (n: Uint8Array, sig: Uint8Array, msg: Uint8Array): number => {
    const m = machine();
    const [np, sp, mp] = place(m, BIG, n, sig, msg);
    return m.call(CMD.rsaPss, [np, n.length, sp, sig.length, mp, msg.length]);
  };
  it.each([1024, 2048])('a %i-bit signature from node:crypto verifies; a changed message, signature or length does not', async (bits) => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
    const r = rnd(8 + bits);
    const msg = r(130);
    const sig = new Uint8Array(sign('sha256', msg, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }));
    const n = new Uint8Array(Buffer.from(publicKey.export({ format: 'jwk' }).n as string, 'base64url'));
    expect(verify(n, sig, msg)).toBe(1);
    await tick();
    const m2 = msg.slice(); m2[129] ^= 1;
    expect(verify(n, sig, m2)).toBe(0);
    const s2 = sig.slice(); s2[sig.length - 1] ^= 1;
    expect(verify(n, s2, msg)).toBe(0);
    const s3 = sig.slice(); s3[0] ^= 0x80;
    expect(verify(n, s3, msg)).toBe(0);
    expect(verify(n, sig.subarray(1), msg)).toBe(0);
    // a signature with the wrong salt length is refused (TLS 1.3 requires the digest length)
    const odd = new Uint8Array(sign('sha256', msg, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 }));
    expect(verify(n, odd, msg)).toBe(0);
    // a PKCS#1 v1.5 signature is not a PSS signature
    const v15 = new Uint8Array(sign('sha256', msg, { key: privateKey, padding: constants.RSA_PKCS1_PADDING }));
    expect(verify(n, v15, msg)).toBe(0);
    await tick();
  });
  it("RFC 8448's own CertificateVerify (rsa_pss_rsae_sha256, a 1024-bit key) verifies over the transcript hash of the trace's messages, and not over another", () => {
    const msg = (a: string, f: string) => trace(a, f);
    const cert = msg('construct a Certificate handshake message', 'Certificate');
    const der = cert.subarray(11, 11 + ((cert[8] << 16) | (cert[9] << 8) | cert[10]));
    const n = new Uint8Array(Buffer.from(new X509Certificate(Buffer.from(der)).publicKey.export({ format: 'jwk' }).n as string, 'base64url'));
    const th = createHash('sha256').update(Buffer.concat([msg('construct a ClientHello handshake message', 'ClientHello'), msg('construct a ServerHello handshake message', 'ServerHello'), msg('construct an EncryptedExtensions handshake message', 'EncryptedExtensions'), cert])).digest();
    const content = new Uint8Array(130); content.fill(0x20, 0, 64); content.set(ascii('TLS 1.3, server CertificateVerify'), 64); content.set(th, 98);
    const cv = msg('construct a CertificateVerify handshake message', 'CertificateVerify'); // 0f 000084 0804 0080 <128-byte signature>
    expect(cv[4] << 8 | cv[5]).toBe(0x0804);
    const sig = cv.subarray(8);
    expect(sig).toHaveLength(128);
    expect(verify(n, sig, content)).toBe(1);
    content[130 - 1] ^= 1;
    expect(verify(n, sig, content)).toBe(0);
  });
  it('the X.509 reader finds the modulus and exponent of RFC 8448 and of the interop fixture, and the SPKI hash a pin compares', () => {
    const m = machine();
    const cert = trace('construct a Certificate handshake message', 'Certificate');
    // body: context(1) list_len(3) cert_len(3) cert...
    const der = cert.subarray(4 + 1 + 3 + 3, 4 + 1 + 3 + 3 + ((cert[8] << 16) | (cert[9] << 8) | cert[10]));
    const [dp] = place(m, BIG, der);
    expect(m.call(CMD.x509, [dp, der.length])).toBe(0);
    const x509 = new X509Certificate(Buffer.from(der));
    const jwk = x509.publicKey.export({ format: 'jwk' });
    // the modulus was copied to MEM.certN
    const n = new Uint8Array(Buffer.from(jwk.n as string, 'base64url'));
    expect(tohex(m.bytes(MEM.certN, n.length))).toBe(tohex(n));
    const pem = readFileSync(new URL('./fixtures/tls/test-server-cert.pem', import.meta.url));
    const fx = new X509Certificate(pem);
    const [fp] = place(m, BIG, new Uint8Array(fx.raw));
    expect(m.call(CMD.x509, [fp, fx.raw.length])).toBe(0);
    const fn = new Uint8Array(Buffer.from(fx.publicKey.export({ format: 'jwk' }).n as string, 'base64url'));
    expect(tohex(m.bytes(MEM.certN, fn.length))).toBe(tohex(fn));
    // the SPKI that a pin hashes: the bytes the reader located are the certificate's SubjectPublicKeyInfo
    const b = fullBuild();
    const at = m.word(globalAddr(b, 'x_spki')), ln = m.word(globalAddr(b, 'x_spkilen'));
    expect(ln).toBeGreaterThan(200);
    expect(tohex(m.bytes(at, ln))).toBe(tohex(new Uint8Array(fx.publicKey.export({ type: 'spki', format: 'der' }))));
    expect(sha(m.bytes(at, ln))).toBe(createHash('sha256').update(fx.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'));
    // garbage and truncations are refused
    for (const cut of [10, 100, fx.raw.length - 1]) {
      const [tp] = place(m, BIG, new Uint8Array(fx.raw).subarray(0, cut));
      expect(m.call(CMD.x509, [tp, cut])).toBe(1);
    }
  });
});

describe('the plain ISS agrees with FastISS', () => {
  it('SHA-256 and an AES block, each run from reset, give the same bytes', () => {
    const words = fullBuild().compiled.words;
    const imem = 2 ** Math.ceil(Math.log2(words.length + 1));
    const fast = machine();
    const msg = ascii('abc'), key = unhex(V.aes.c1.key), pt = unhex(V.aes.c1.plaintext);
    // the mailbox is read in a loop, so a command written before the first step is the first one run (a fresh ISS each time: a command cannot be slipped in between steps)
    const onIss = (cmd: number, args: number[], inputs: [number, Uint8Array][], out: number, n: number): string => {
      const iss = new ISS(words, { system: true, m: true, dmemWords: 1 << 17, imemWords: imem });
      const d8 = new Uint8Array(iss.dmem.buffer);
      for (const [a, b] of inputs) d8.set(b, a);
      args.forEach((v, i) => { iss.dmem[(MEM.cmd + 4 + 4 * i) >>> 2] = v; });
      iss.dmem[MEM.cmd >>> 2] = cmd;
      for (let s = 0; s < 3000 && iss.dmem[MEM.cmd >>> 2] !== 0; s++) for (let k = 0; k < 1000; k++) iss.step();
      expect(iss.dmem[MEM.cmd >>> 2]).toBe(0);
      return tohex(d8.slice(out, out + n));
    };
    fast.put(BIG, msg); fast.put(BIG + 64, key); fast.put(BIG + 96, pt);
    fast.call(CMD.sha256, [BIG, 3, BIG + 256]);
    fast.call(CMD.aesEncrypt, [BIG + 64, BIG + 96, BIG + 128]);
    const digest = onIss(CMD.sha256, [BIG, 3, BIG + 256], [[BIG, msg]], BIG + 256, 32);
    const block = onIss(CMD.aesEncrypt, [BIG + 64, BIG + 96, BIG + 128], [[BIG + 64, key], [BIG + 96, pt]], BIG + 128, 16);
    expect(digest).toBe(tohex(fast.bytes(BIG + 256, 32)));
    expect(digest).toBe(V.sha256[0].digest);
    expect(block).toBe(tohex(fast.bytes(BIG + 128, 16)));
    expect(block).toBe(V.aes.c1.ciphertext);
  }, 120_000);
});
