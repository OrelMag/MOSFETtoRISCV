// comm/linecode.ts: Manchester, 8b/10b against the published codes and its defining properties over all 256 data bytes and the
// 12 control codes at both disparities, and the self-synchronizing scrambler.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  byteOf, codeText, COMMAS, decode8b10b, Descrambler, disparityOf, encode8b10b, encodeStream, isKCode, K_CODES, manchester, maxRun, MAX_RUN_8B10B,
  nameOf, POLY_64B66B, POLY_7, Scrambler, transitionDensity, unManchester, type Rd,
} from '../src/comm/linecode';
import { prbs } from '../src/phys/line';
import { lcg } from './util';

const bitsOfCodes = (codes: number[]) => codes.flatMap((c) => Array.from({ length: 10 }, (_, i) => (c >> (9 - i)) & 1));

describe('Manchester', () => {
  it('a 1 is low then high, a 0 high then low; every bit has a mid-bit transition; runs are at most 2', () => {
    expect(manchester([1, 0, 1, 1, 0])).toEqual([0, 1, 1, 0, 0, 1, 0, 1, 1, 0]);
    const bits = Array.from(prbs(9, 400));
    const h = manchester(bits);
    expect(maxRun(h)).toBeLessThanOrEqual(2);
    expect(unManchester(h)).toEqual({ bits, errors: 0 });
    expect(transitionDensity(h)).toBeGreaterThan(0.5);
  });
  it('a bit whose halves agree is an error', () => {
    expect(unManchester([0, 1, 1, 1, 1, 0]).errors).toBe(1);
  });
});

describe('8b/10b: published codes (Widmer and Franaszek; IEEE 802.3 Clause 36)', () => {
  // [name, RD- code (6b 4b), RD+ code]
  const known: [string, string, string][] = [
    ['K28.5', '001111 1010', '110000 0101'], ['K28.1', '001111 1001', '110000 0110'], ['K28.7', '001111 1000', '110000 0111'],
    ['K28.0', '001111 0100', '110000 1011'], ['K23.7', '111010 1000', '000101 0111'], ['K27.7', '110110 1000', '001001 0111'],
    ['K29.7', '101110 1000', '010001 0111'], ['K30.7', '011110 1000', '100001 0111'],
    ['D0.0', '100111 0100', '011000 1011'], ['D21.5', '101010 1010', '101010 1010'], ['D10.2', '010101 0101', '010101 0101'],
    ['D3.1', '110001 1001', '110001 1001'], ['D30.3', '011110 0011', '100001 1100'], ['D31.7', '101011 0001', '010100 1110'],
    ['D17.7', '100011 0111', '100011 0001'], ['D11.7', '110100 1110', '110100 1000'], ['D5.6', '101001 0110', '101001 0110'],
  ];
  for (const [name, neg, pos] of known) {
    it(`${name}: RD- ${neg}, RD+ ${pos}`, () => {
      const { v, k } = byteOf(name);
      expect(codeText(encode8b10b(v, k, 0).code)).toBe(neg);
      expect(codeText(encode8b10b(v, k, 1).code)).toBe(pos);
    });
  }
  it('the control codes are the twelve of the standard', () => {
    expect(K_CODES.map((v) => nameOf(v, true))).toEqual(['K28.0', 'K28.1', 'K28.2', 'K28.3', 'K28.4', 'K28.5', 'K28.6', 'K28.7', 'K23.7', 'K27.7', 'K29.7', 'K30.7']);
    expect(() => encode8b10b(0x00, true, 0)).toThrow();
  });
});

describe('8b/10b: every code at both disparities', () => {
  const all: { v: number; k: boolean }[] = [];
  for (let v = 0; v < 256; v++) all.push({ v, k: false });
  for (const v of K_CODES) all.push({ v, k: true });
  it('has 268 symbols, and no two of them share a code', () => {
    expect(all.length).toBe(268);
    const seen = new Map<number, string>();
    for (const rd of [0, 1] as Rd[]) for (const s of all) {
      const c = encode8b10b(s.v, s.k, rd).code, who = nameOf(s.v, s.k);
      if (seen.has(c)) expect(seen.get(c)).toBe(who);
      seen.set(c, who);
    }
  });
  it('encode is balanced: disparity 0 or +-2, the sign the one the running disparity needs, the disparity ends where the code says', () => {
    for (const rd of [0, 1] as Rd[]) for (const s of all) {
      const e = encode8b10b(s.v, s.k, rd), d = disparityOf(e.code, 10);
      expect([0, 2, -2]).toContain(d);
      if (d === 2) expect(rd).toBe(0);
      if (d === -2) expect(rd).toBe(1);
      expect(e.rd).toBe(d === 0 ? rd : (rd ^ 1));
      expect([0, 2, -2]).toContain(disparityOf(e.six, 6));
      expect([0, 2, -2]).toContain(disparityOf(e.four, 4));
    }
  });
  it('decode inverts encode, with no error at the right disparity', () => {
    for (const rd of [0, 1] as Rd[]) for (const s of all) {
      const e = encode8b10b(s.v, s.k, rd), d = decode8b10b(e.code, rd);
      expect(d).toEqual({ v: s.v, k: s.k, rd: e.rd, err: null });
    }
  });
  it('a code sent at the wrong disparity decodes to its byte with a disparity error, and a non-code is a code error', () => {
    let wrong = 0;
    for (const s of all) {
      const c = encode8b10b(s.v, s.k, 0).code, e = decode8b10b(c, 1);
      if (c !== encode8b10b(s.v, s.k, 1).code) { wrong++; expect(e.err).toBe('disparity'); expect(e.v).toBe(s.v); }
    }
    expect(wrong).toBeGreaterThan(100);
    expect(decode8b10b(0b0000000000, 0).err).toBe('code');
    expect(decode8b10b(0b1111111111, 1).err).toBe('code');
    const valid = new Set<number>();
    for (const rd of [0, 1] as Rd[]) for (const s of all) valid.add(encode8b10b(s.v, s.k, rd).code);
    expect(1024 - valid.size).toBeGreaterThan(0);
    for (let c = 0; c < 1024; c++) if (!valid.has(c)) expect(decode8b10b(c, 0).err).toBe('code');
  });
  it('no code, alone or after any other, makes a run longer than 5, and 5 occurs', () => {
    let worst = 0;
    for (const rd of [0, 1] as Rd[]) for (const a of all) {
      const ea = encode8b10b(a.v, a.k, rd);
      worst = Math.max(worst, maxRun(bitsOfCodes([ea.code])));
      for (const b of all) {
        const eb = encode8b10b(b.v, b.k, ea.rd);
        const r = maxRun(bitsOfCodes([ea.code, eb.code]));
        worst = Math.max(worst, r);
        if (r > MAX_RUN_8B10B) throw new Error(`${nameOf(a.v, a.k)} then ${nameOf(b.v, b.k)} at ${rd}: run ${r}`);
      }
    }
    expect(worst).toBe(5);
  });
  it('the comma 0011111 / 1100000 occurs in a legal stream only at the start of K28.1, K28.5 and K28.7 (K28.7 before a D whose 6b starts 00 makes a false one a code later: the standard says not to send it before those)', () => {
    const commaAt = (bits: number[]) => {
      const s = bits.join(''), out: number[] = [];
      for (let i = 0; i + 7 <= s.length; i++) if (COMMAS.includes(s.slice(i, i + 7))) out.push(i);
      return out;
    };
    const rng = lcg(5);
    for (let trial = 0; trial < 300; trial++) {
      const bytes = Array.from({ length: 40 }, () => (rng(7) === 0 ? { v: K_CODES[rng(12)], k: true } : { v: rng(256), k: false }));
      for (let i = 0; i < bytes.length; i++) if (bytes[i].k && bytes[i].v === 28 + 7 * 32) bytes[i] = { v: 28 + 1 * 32, k: true };
      const { codes, bits } = encodeStream(bytes, rng(2) as Rd);
      const hits = commaAt(bits);
      const starts = bytes.flatMap((b, i) => (b.k && [28 + 32, 28 + 5 * 32, 28 + 7 * 32].includes(b.v) ? [i * 10] : []));
      expect(hits).toEqual(starts);
      expect(codes.length).toBe(40);
    }
  });
  it('a long random stream stays balanced: the running digital sum is -1 or +1 at every code boundary', () => {
    const rng = lcg(11);
    const { codes } = encodeStream(Array.from({ length: 5000 }, () => ({ v: rng(256) })));
    let sum = -1;
    for (const c of codes) { sum += disparityOf(c, 10); expect([-1, 1]).toContain(sum); }
  });
  it('K28.7 on its own carries the comma too', () => {
    expect(codeText(encode8b10b(28 + 7 * 32, true, 0).code).replace(' ', '').startsWith('0011111')).toBe(true);
  });
  it('isKCode', () => { expect(isKCode(0xBC)).toBe(true); expect(isKCode(0x00)).toBe(false); });
});

describe('scrambler', () => {
  it('descrambling undoes scrambling from the same state, for both polynomials', () => {
    for (const poly of [POLY_7, POLY_64B66B]) {
      const data = Array.from(prbs(15, 3000));
      const tx = new Scrambler(poly, 0x5a5a5a), rx = new Descrambler(poly, 0x5a5a5a);
      expect(rx.run(tx.run(data))).toEqual(data);
    }
  });
  it('self-synchronizing: a descrambler started in the wrong state is right after max(a, b) bits', () => {
    for (const poly of [POLY_7, POLY_64B66B]) {
      const n = Math.max(...poly), data = Array.from(prbs(15, 1000));
      const line = new Scrambler(poly, 12345).run(data), got = new Descrambler(poly, 0x1ffffff).run(line);
      expect(got.slice(n)).toEqual(data.slice(n));
      expect(got.slice(0, n)).not.toEqual(data.slice(0, n));
    }
  });
  it('one wrong bit on the line is three wrong bits out (one for each term of the polynomial), at delays 0, a and b', () => {
    for (const poly of [POLY_7, POLY_64B66B]) {
      const data = Array.from(prbs(15, 600)), line = new Scrambler(poly, 1).run(data);
      line[200] ^= 1;
      const got = new Descrambler(poly, 1).run(line), bad = got.map((b, i) => (b !== data[i] ? i : -1)).filter((i) => i >= 0);
      expect(bad).toEqual([200, 200 + poly[0], 200 + poly[1]]);
    }
  });
  it('a long run of zeros from an empty register stays zero (why 64b/66b adds a header), and from any other state it does not', () => {
    const zeros = Array(300).fill(0);
    expect(new Scrambler(POLY_64B66B, 0).run(zeros)).toEqual(zeros);
    const out = new Scrambler(POLY_64B66B, 0x15555555555555).run(zeros);
    expect(maxRun(out)).toBeLessThan(40);
    expect(transitionDensity(out.slice(120))).toBeGreaterThan(0.4);
  });
});

describe('8b/10b: the whole published table', () => {
  // tests/fixtures/8b10b-ug196.txt is Xilinx's table as printed, extracted from the PDF, never from our encoder.
  const rows = readFileSync(new URL('./fixtures/8b10b-ug196.txt', import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith('#'))
    .map((l) => /^(\S+) ([01]{3}) ([01]{5}) (\S+ \S+) (\S+ \S+)$/.exec(l)!);
  it('lists all 268 symbols, each with the byte its name says', () => {
    expect(rows.length).toBe(268);
    expect(new Set(rows.map((r) => r[1])).size).toBe(268);
    for (const r of rows) expect(byteOf(r[1]).v).toBe(parseInt(r[2] + r[3], 2));
  });
  it('every code at both disparities equals the table', () => {
    for (const r of rows) {
      const { v, k } = byteOf(r[1]);
      expect(codeText(encode8b10b(v, k, 0).code), `${r[1]} at RD-`).toBe(r[4]);
      expect(codeText(encode8b10b(v, k, 1).code), `${r[1]} at RD+`).toBe(r[5]);
    }
  });
});
