// Chapter 47's framing and forward-error-correction models: stuffing and COBS exactly, SEC-DED on bit arrays against the
// library's reference and gates, and the closed-form frame loss against runs of the real encoder and decoder.
import { describe, expect, it } from 'vitest';
import { crc32 as zcrc32 } from 'node:zlib';
import { cobsDecode, cobsEncode, cobsWorst, FLAG, frame, receive, stuff, stuffRate, unstuff } from '../src/comm/framing';
import { blockOk, codeOf, crcOnly, crossover, crossoverTime, deliveryTime, secdedCrc, secdedDecode, secdedEncode, trial } from '../src/comm/fec';
import { hammingDecodeRef, hammingEncodeRef, hammingLayout } from '../src/lib';
import { rng } from '../src/phys/line';
import { crc32 } from '../src/comm/crc';

const near = (x: number, y: number, rel: number) => expect(Math.abs(x - y) / y, `${x} vs ${y}`).toBeLessThan(rel);
const bitsOf = (r: () => number, n: number) => Array.from({ length: n }, () => (r() < 0.5 ? 1 : 0));

describe('HDLC bit stuffing', () => {
  it('round trips random bits and never lets six 1s through', () => {
    const r = rng(1);
    for (let k = 0; k < 200; k++) {
      const b = bitsOf(r, Math.floor(r() * 300));
      const s = stuff(b);
      expect(unstuff(s)).toEqual(b);
      expect(s.join('')).not.toContain('111111');
    }
  });
  it('the flag cannot occur inside stuffed data; six 1s in a row is refused', () => {
    expect(stuff([1, 1, 1, 1, 1, 1, 1, 1])).toEqual([1, 1, 1, 1, 1, 0, 1, 1, 1]);
    expect(unstuff([1, 1, 1, 1, 1, 1, 0])).toBeNull();
  });
  it('overhead: all ones 1/5, random data exactly 1/62, checked by a long random run', () => {
    expect(stuff(Array(1000).fill(1)).length).toBe(1200);
    expect(stuffRate()).toBeCloseTo(1 / 62, 12);
    const r = rng(2), n = 400000, b = bitsOf(r, n);
    near((stuff(b).length - n) / n, 1 / 62, 0.03);
  });
  it('a frame is found, checked, and a flipped bit is caught', () => {
    const payload = Array.from(Buffer.from('When bits go wrong'));
    const f = frame(payload);
    expect(f.slice(0, 8)).toEqual(FLAG);
    const [ok] = receive([...f, ...FLAG]);
    expect(ok.ok).toBe(true);
    expect(ok.payload).toEqual(payload);
    let caught = 0;
    for (let i = 8; i < f.length - 8; i++) {
      const g = f.slice();
      g[i] ^= 1;
      const out = receive([...g, ...FLAG]);
      if (!out.length || out.some((x) => !x.ok) || out.length > 1) caught++;
    }
    expect(caught).toBe(f.length - 16);
  });
  it('two frames back to back on one shared flag', () => {
    const a = Array.from(Buffer.from('one')), b = Array.from(Buffer.from('two'));
    const out = receive([...frame(a), ...frame(b)]);
    expect(out.map((x) => x.ok)).toEqual([true, true]);
    expect(out.map((x) => x.payload)).toEqual([a, b]);
  });
});

describe('COBS', () => {
  it('encodes the textbook vector and round trips, with no zero inside', () => {
    expect(cobsEncode([0x11, 0x22, 0x00, 0x33])).toEqual([3, 0x11, 0x22, 2, 0x33]);
    expect(cobsEncode([])).toEqual([1]);
    const r = rng(4);
    for (let k = 0; k < 300; k++) {
      const d = Array.from({ length: Math.floor(r() * 600) }, () => (r() < 0.3 ? 0 : 1 + Math.floor(r() * 255)));
      const e = cobsEncode(d);
      expect(e.includes(0)).toBe(false);
      expect(cobsDecode(e)).toEqual(d);
      expect(e.length - d.length).toBeLessThanOrEqual(cobsWorst(d.length));
    }
  });
  it('worst case: 254 non-zero bytes cost one byte, 255 cost two', () => {
    expect(cobsEncode(Array(254).fill(7)).length).toBe(255);
    expect(cobsEncode(Array(255).fill(7)).length).toBe(257);
  });
});

describe('SEC-DED on bit arrays', () => {
  it('equals the library reference (and so the gates) for 8 and 16 data bits', () => {
    const r = rng(5);
    for (const k of [8, 16]) for (let t = 0; t < 300; t++) {
      const d = Math.floor(r() * 2 ** k), bits = Array.from({ length: k }, (_, i) => (d >> i) & 1);
      const c = secdedEncode(bits);
      expect(c.reduce((a, b, p) => a | (b << p), 0) >>> 0).toBe(hammingEncodeRef(d, k) >>> 0);
      const flip = 1 + Math.floor(r() * (c.length - 1)), c2 = c.slice();
      c2[flip] ^= 1;
      const dec = secdedDecode(c2, k), ref = hammingDecodeRef(c2.reduce((a, b, p) => a | (b << p), 0), k);
      expect(dec.data.reduce((a, b, i) => a | (b << i), 0)).toBe(ref.d);
      expect(dec.syndrome).toBe(ref.syndrome);
    }
  });
  it('(72,64): 8 check bits, rate 8/9; corrects any single error and flags any double', () => {
    expect(hammingLayout(64).n).toBe(72);
    expect(codeOf(64)).toMatchObject({ r: 8, n: 72 });
    const r = rng(6), d = bitsOf(r, 64), c = secdedEncode(d);
    for (let i = 0; i < 72; i++) { const x = c.slice(); x[i] ^= 1; expect(secdedDecode(x, 64).data).toEqual(d); }
    for (let t = 0; t < 300; t++) {
      const i = Math.floor(r() * 72);
      let j = Math.floor(r() * 72);
      if (j === i) j = (i + 1) % 72;
      const x = c.slice();
      x[i] ^= 1; x[j] ^= 1;
      expect(secdedDecode(x, 64).double).toBe(true);
    }
  });
});

describe('CRC + retransmit against SEC-DED + CRC + retransmit', () => {
  it('closed forms: a 1500-byte frame', () => {
    const a = crcOnly(1500, 1e-5), b = secdedCrc(1500, 1e-5);
    expect(a.wire).toBe(12032);
    expect(b.wire).toBe(188 * 72);
    near(a.pFail, 1 - Math.exp(-12032e-5), 0.01);
    expect(b.pFail).toBeLessThan(a.pFail / 100);
    near(blockOk(72, 1e-3), (1 - 1e-3) ** 72 + 72e-3 * (1 - 1e-3) ** 71, 1e-12);
  });
  it('the frame loss in the formulas is what the real encoder, errors and decoder give', () => {
    for (const [secded, p, n] of [[false, 2e-5, 4000], [true, 1e-3, 1500], [true, 3e-3, 800]] as const) {
      const t = trial(secded, 200, p, n, 11), want = secded ? secdedCrc(200, p).pFail : crcOnly(200, p).pFail;
      expect(Math.abs(t.rejected / n - want), `${secded} ${p}`).toBeLessThan(4 * Math.sqrt((want * (1 - want)) / n) + 0.005);
    }
  });
  it('the crossover: goodput favours FEC above about 1e-5 for 1500-byte frames; latency crosses lower at long delay', () => {
    const c = crossover(1500)!;
    expect(c).toBeGreaterThan(5e-6);
    expect(c).toBeLessThan(2e-5);
    const rate = 63e6, near1 = crossoverTime(1500, rate, 1e-6)!, far = crossoverTime(1500, rate, 0.25)!;
    expect(far).toBeLessThan(near1);
    expect(deliveryTime(12032, 0, rate, 0.01)).toBeCloseTo(12032 / rate + 0.01, 12);
  });
  it('crc32 helper agrees with zlib (the CRC is the same one)', () => {
    expect(crc32(Buffer.from('abc'))).toBe(zcrc32(Buffer.from('abc')));
  });
});
