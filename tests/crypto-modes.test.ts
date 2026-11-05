// The modes against outside references: node:crypto, and test cases from the NIST GCM specification. And what each leaves showing.
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptBlock, fromHex, hex } from '../src/crypto/aes';
import { bitsDiffer, ctrCrypt, ecbEncrypt, gcmOpen, gcmSeal, PIC, picture } from '../src/crypto/modes';

function rng(seed: number) { let x = seed >>> 0; return (n: number) => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return (x >>> 8) % n; }; }
const bytes = (r: (n: number) => number, n: number) => Array.from({ length: n }, () => r(256));

describe('against node:crypto', () => {
  it('CTR, on random messages', () => {
    const r = rng(5);
    for (let t = 0; t < 40; t++) {
      const key = bytes(r, 16), iv = bytes(r, 16), msg = bytes(r, r(100));
      iv[12] = iv[13] = iv[14] = 0; // no carry out of the low 32 bits, which ours stops at and Node's does not
      const c = createCipheriv('aes-128-ctr', Buffer.from(key), Buffer.from(iv));
      expect(hex(ctrCrypt(msg, key, iv))).toBe(Buffer.concat([c.update(Buffer.from(msg)), c.final()]).toString('hex'));
    }
  });
  it('GCM, with and without additional data, both ways', () => {
    const r = rng(6);
    for (let t = 0; t < 40; t++) {
      const key = bytes(r, 16), iv = bytes(r, 12), msg = bytes(r, r(90)), aad = bytes(r, r(40));
      const c = createCipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(iv));
      c.setAAD(Buffer.from(aad));
      const ct = Buffer.concat([c.update(Buffer.from(msg)), c.final()]), s = gcmSeal(msg, key, iv, aad);
      expect(hex(s.ciphertext)).toBe(ct.toString('hex'));
      expect(hex(s.tag)).toBe(c.getAuthTag().toString('hex'));
      const d = createDecipheriv('aes-128-gcm', Buffer.from(key), Buffer.from(iv));
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(Buffer.from(s.tag));
      expect(hex(Array.from(Buffer.concat([d.update(Buffer.from(s.ciphertext)), d.final()])))).toBe(hex(msg));
      expect(gcmOpen(s, key, iv, aad)).toEqual(msg);
    }
  });
});

describe('the GCM specification', () => {
  // McGrew and Viega, The Galois/Counter Mode of Operation, Appendix B, test cases 1 and 2.
  const zero = new Array<number>(16).fill(0), iv = new Array<number>(12).fill(0);
  it('test case 1: nothing at all', () => {
    expect(hex(gcmSeal([], zero, iv).tag)).toBe('58e2fccefa7e3061367f1d57a4e7455a');
  });
  it('test case 2: one block of zeros', () => {
    const s = gcmSeal(zero, zero, iv);
    expect(hex(s.ciphertext)).toBe('0388dace60b6a392f328c2b971b2fe78');
    expect(hex(s.tag)).toBe('ab6e47d42cec13bdf53a67b21257bddf');
  });
});

describe('refusal', () => {
  it('any flipped bit of ciphertext, tag or associated data is refused', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c'), iv = fromHex('000102030405060708090a0b'), msg = [...Buffer.from('PAY ALICE 100 EUR')], aad = [1, 2, 3];
    const s = gcmSeal(msg, key, iv, aad);
    for (let i = 0; i < msg.length; i++) for (let b = 0; b < 8; b += 3) {
      const c = [...s.ciphertext];
      c[i] ^= 1 << b;
      expect(gcmOpen({ ciphertext: c, tag: s.tag }, key, iv, aad)).toBeNull();
    }
    const t = [...s.tag]; t[0] ^= 1;
    expect(gcmOpen({ ciphertext: s.ciphertext, tag: t }, key, iv, aad)).toBeNull();
    expect(gcmOpen(s, key, iv, [1, 2, 4])).toBeNull();
  });
  it('plain CTR does not refuse: a chosen change goes straight through', () => {
    const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c'), n = new Array<number>(16).fill(7), msg = [...Buffer.from('PAY ALICE 100 EUR')];
    const c = ctrCrypt(msg, key, n), at = msg.indexOf('1'.charCodeAt(0));
    c[at] ^= '1'.charCodeAt(0) ^ '9'.charCodeAt(0);
    expect(Buffer.from(ctrCrypt(c, key, n)).toString()).toBe('PAY ALICE 900 EUR');
  });
});

describe('what shows through', () => {
  const key = fromHex('2b7e151628aed2a6abf7158809cf4f3c'), n = fromHex('f0f1f2f3f4f5f6f7f8f9fafb00000001');
  const distinct = (d: number[]) => { const s = new Set<string>(); for (let i = 0; i + 16 <= d.length; i += 16) s.add(hex(d.slice(i, i + 16))); return s.size; };
  it('ECB keeps every repeat of a block; CTR keeps none', () => {
    const pic = picture(0), total = PIC * PIC / 16;
    expect(pic).toHaveLength(PIC * PIC);
    expect(distinct(ecbEncrypt(pic, key))).toBe(distinct(pic));
    expect(distinct(pic)).toBeLessThan(total / 2);
    expect(distinct(ctrCrypt(pic, key, n))).toBe(total);
  });
  it('a counter used twice leaks the XOR of the two plaintexts, with no key', () => {
    const a = picture(0), b = picture(1), x = ctrCrypt(a, key, n), y = ctrCrypt(b, key, n);
    x.forEach((v, i) => expect(v ^ y[i]).toBe(a[i] ^ b[i]));
  });
  it('bits differ counts bits', () => {
    expect(bitsDiffer([0xff, 0], [0, 0])).toBe(8);
    expect(bitsDiffer(encryptBlock(new Array(16).fill(0), key), encryptBlock(new Array(16).fill(0), key))).toBe(0);
  });
});
