// What an audit of chapters 45-46 found the prose or a widget getting wrong, pinned to the models so it cannot drift back.

import { describe, expect, it } from 'vitest';
import { snrNeeded, ratioToDb } from '../src/comm/limits';
import { byteOf, Descrambler, encode8b10b, POLY_64B66B, POLY_7, Scrambler, type Rd } from '../src/comm/linecode';
import { PCB_LOSS } from '../src/widgets/serial';
import { lcg } from './util';

describe('chapter 46', () => {
  it('doubling the rate divides a trace\'s reach by 1.4 to 2, never more', () => {
    for (const f of [0.1, 1, 5, 28, 100, 1000]) {
      const ratio = PCB_LOSS(f) / PCB_LOSS(2 * f);
      expect(ratio).toBeGreaterThanOrEqual(0.5);
      expect(ratio).toBeLessThanOrEqual(Math.SQRT1_2 + 1e-9);
    }
  });

  it('a flipped line bit makes exactly three wrong bits against the clean line, wherever it falls', () => {
    for (const [taps, far] of [[POLY_64B66B, 58], [POLY_7, 7]] as const) {
      const r = lcg(4), data = Array.from({ length: 300 }, () => r(2)), seed = 0x55;
      const line = new Scrambler(taps, seed).run(data);
      for (const at of [0, 1, 5, 30, 60, 100]) {
        const wire = line.slice();
        wire[at] ^= 1;
        const back = new Descrambler(taps, seed ^ 0x2a).run(wire), clean = new Descrambler(taps, seed ^ 0x2a).run(line);
        const wrong = back.flatMap((b, i) => (b !== clean[i] ? [i - at] : []));
        expect(wrong).toHaveLength(3);
        expect(wrong[0]).toBe(0);
        expect(wrong[2]).toBe(far);
      }
    }
  });

  it('K28.7 repeated holds a false comma: the sparsest code breaks alignment before clock recovery', () => {
    const { v, k } = byteOf('K28.7');
    let rd: Rd = 0, bits = '';
    for (let n = 0; n < 4; n++) {
      const e = encode8b10b(v, k, rd);
      bits += e.code.toString(2).padStart(10, '0');
      rd = e.rd;
    }
    // commas at the code boundary are at multiples of 10; look for one that is not
    const off = [...bits.matchAll(/(?=(0011111|1100000))/g)].map((m) => m.index).filter((i) => i % 10 !== 0);
    expect(off.length).toBeGreaterThan(0);
  });

  it('the alternate 7 exists to avoid five ones: D17.7 at RD− would end 11 + 111 with the primary', () => {
    const { v, k } = byteOf('D17.7');
    const e = encode8b10b(v, k, 0).code.toString(2).padStart(10, '0');
    expect(e).toBe('1000110111');
    expect('100011' + '1110').toContain('11111');
    expect(e).not.toContain('11111');
  });
});

describe('chapter 45', () => {
  it('16-QAM to 256-QAM is about 12 dB, the 16-fold step in points', () => {
    const qamGap = 10 * Math.log10((256 - 1) / (16 - 1));
    expect(qamGap).toBeCloseTo(12.3, 1);
    expect(10 * Math.log10(16)).toBeCloseTo(12.04, 2);
    expect(ratioToDb(snrNeeded(1))).toBeCloseTo(0, 6);
  });
});
