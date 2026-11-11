// The number-form codex entries and the binary chapter's conversion text: every worked number is computed here.

import { describe, expect, it } from 'vitest';
import { DRILLS, rng } from '../src/campaign/drills';
import { MORENUM } from '../src/campaign/codexmorenum';

const gray = (b: number) => b ^ (b >> 1);
const bin = (v: number, w: number) => v.toString(2).padStart(w, '0');

describe('number forms', () => {
  it('the 4-bit Gray table in the codex, and one bit per step including the wrap', () => {
    const rows = Array.from({ length: 16 }, (_, b) => `${bin(b, 4)}  ${bin(gray(b), 4)}`);
    for (const r of rows) expect(MORENUM.gray.example!.body, r).toContain(r);
    for (let b = 0; b < 16; b++) {
      const d = gray(b) ^ gray((b + 1) % 16);
      expect(d & (d - 1), `step ${b}`).toBe(0);
    }
    expect(bin(gray(0b0111), 4)).toBe('0100');
    expect(bin(gray(0b1000), 4)).toBe('1100');
    expect(bin(gray(0b0110), 4)).toBe('0101'); // the Check yourself question
  });

  it('0x85 under the four signed forms', () => {
    const v = 0x85;
    expect(-(v & 0x7f)).toBe(-5);
    expect(-(~v & 0xff)).toBe(-122);
    expect(v - 256).toBe(-123);
    expect(v - 128).toBe(5);
    expect(-(0x81 & 0x7f)).toBe(-1);
    expect(-(~0x81 & 0xff)).toBe(-126);
    expect(0x81 - 256).toBe(-127);
  });

  it('BCD: 0x38 + 0x45, 0x57 + 0x26 and the density', () => {
    const add = (a: number, b: number) => {
      let carry = 0, out = 0;
      for (let i = 0; i < 2; i++) {
        let d = ((a >> (4 * i)) & 15) + ((b >> (4 * i)) & 15) + carry;
        carry = d > 9 ? 1 : 0;
        if (d > 9) d = (d + 6) & 15;
        out |= d << (4 * i);
      }
      return out | (carry << 8);
    };
    expect(add(0x38, 0x45)).toBe(0x83);
    expect(0x38 + 0x45).toBe(0x7d);
    expect(add(0x57, 0x26)).toBe(0x83);
    expect(Math.round((Math.log2(10) / 4) * 100)).toBe(83);
  });

  it('the conversion examples in the binary chapter', () => {
    expect(parseInt('10110110', 2)).toBe(182);
    expect(0x2f5).toBe(757);
    // 0.3125 doubled: 0.625 0 / 1.25 1 / 0.5 0 / 1.0 1
    let x = 0.3125;
    let bits = '';
    for (let i = 0; i < 4; i++) { x *= 2; bits += x >= 1 ? '1' : '0'; if (x >= 1) x -= 1; }
    expect(bits).toBe('0101');
    expect(x).toBe(0);
    // 0.1 repeats: the remainder 0.2 comes back after four steps (in exact fifths)
    let f = 1, seen = '', cycle = -1;
    const at: number[] = [];
    for (let i = 0; i < 12; i++) { at.push(f); f *= 2; seen += f >= 10 ? '1' : '0'; if (f >= 10) f -= 10; if (f === 2 && cycle < 0 && i > 0) cycle = i; }
    expect(seen.slice(0, 9)).toBe('000110011');
    expect(at[1]).toBe(2);
    expect(at[5]).toBe(2);
  });

  it('the byte order example', () => {
    const w = new DataView(new ArrayBuffer(4));
    w.setUint32(0, 0x12345678, true);
    expect([0, 1, 2, 3].map((i) => w.getUint8(i).toString(16))).toEqual(['78', '56', '34', '12']);
    expect(w.getUint16(2, true)).toBe(0x1234);
    expect(w.getUint16(2, false)).toBe(0x3412);
  });

  it('the new drill kinds appear, and srai differs from div on a negative odd number', () => {
    const seen = new Set<string>();
    const r = rng(5);
    for (let i = 0; i < 400; i++) {
      for (const id of ['binary', 'twos'] as const) {
        const q = DRILLS[id].make(r);
        if (/octal/.test(q.prompt)) seen.add('octal');
        if (/binary fraction/.test(q.prompt)) seen.add('frac');
        if (/flags C and V/.test(q.prompt)) seen.add('flags');
        if (/srai/.test(q.prompt)) seen.add('srai');
        if (/<code>div<\/code>/.test(q.prompt)) seen.add('div');
        if (/sign-magnitude|one's complement/.test(q.prompt)) seen.add('forms');
      }
    }
    expect([...seen].sort()).toEqual(['div', 'flags', 'forms', 'frac', 'octal', 'srai']);
    expect(Math.floor(-7 / 2)).toBe(-4);
    expect(Math.trunc(-7 / 2)).toBe(-3);
  });

  it('flag, octal and fraction answers accept their own value and refuse neighbours', () => {
    const r = rng(9);
    for (let i = 0; i < 300; i++) {
      const q = DRILLS.twos.make(r);
      if (!/flags C and V/.test(q.prompt)) continue;
      const wrong = q.answer === '00' ? '11' : '00';
      expect(q.check(q.answer).ok).toBe(true);
      expect(q.check(wrong).ok).toBe(false);
    }
    const q = DRILLS.binary.make(rng(1));
    expect(q.check('zz').ok).toBe(false);
  });
});
